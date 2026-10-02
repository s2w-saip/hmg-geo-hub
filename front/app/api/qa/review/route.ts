import { NextResponse, type NextRequest } from "next/server";
import { guard, readJson, readSectionFlags, str } from "@/lib/qa/route-helpers";
import { qaApiSource } from "@/lib/qa/auth";
import { acquireLock, upsertReview } from "@/lib/db/repositories/qa-review";
import { qaApiRoutes } from "@/lib/hgh/adapters/qa";

// 블록별 판정 저장. status 는 서버가 파생한다 — 하나라도 'issue' 면 'issue'.
// 판정 본문 검증(readSectionFlags)은 두 원천 공통이라 lib/qa/route-helpers.ts 로 옮겼다(동작 동일).
// HGH_SOURCE_G7=api 면 PUT /v1/qa/answers/{id}/review 로 중계한다(락 재확인은 백엔드,
// 409 lock_lost → 현행 본문 {error:"lock-lost", heldBy}).

export async function PUT(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.reviewPut(req);
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
