import { NextResponse, type NextRequest } from "next/server";
import { guard, readJson, str } from "@/lib/qa/route-helpers";
import {
  QA_SECTION_KEYS,
  acquireLock,
  upsertReview,
  type QaSectionFlags,
  type QaSectionKey,
} from "@/lib/db/repositories/qa-review";

// 블록별 판정 저장. status 는 서버가 파생한다 — 하나라도 'issue' 면 'issue'.

function readSectionFlags(raw: unknown): QaSectionFlags {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: QaSectionFlags = {};
  for (const k of QA_SECTION_KEYS) {
    const v = src[k];
    if (v === "ok" || v === "issue") out[k as QaSectionKey] = v;
  }
  return out;
}

export async function PUT(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;

  const body = await readJson(req);
  const jobId = str(body.jobId);
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  // 저장 직전에 락 소유를 다시 확인한다. 상세를 열어둔 채 3분 넘게 자리를 비우면
  // TTL 이 만료돼 다른 검수자가 가져갔을 수 있고, 그 상태로 덮어쓰면 남의 작업이
  // 조용히 사라진다.
  const lock = await acquireLock(jobId, g.reviewer.sessionId, g.reviewer.name);
  if (!lock.ok) {
    return NextResponse.json(
      { error: "lock-lost", heldBy: { reviewerName: lock.heldBy.reviewerName } },
      { status: 409 },
    );
  }

  const { status } = await upsertReview({
    jobId,
    sectionFlags: readSectionFlags(body.sectionFlags),
    reviewerName: g.reviewer.name,
    sessionId: g.reviewer.sessionId,
  });
  return NextResponse.json({ status, reviewerName: g.reviewer.name });
}
