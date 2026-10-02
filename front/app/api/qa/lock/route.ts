import { NextResponse, type NextRequest } from "next/server";
import { guard, readJson, str } from "@/lib/qa/route-helpers";
import { qaApiSource } from "@/lib/qa/auth";
import { qaApiRoutes } from "@/lib/hgh/adapters/qa";
import {
  acquireLock,
  heartbeatLock,
  releaseLock,
  touchReviewSession,
} from "@/lib/db/repositories/qa-review";

// 동시 검수 방지. 상세 진입 시 POST 로 획득, 30초마다 PATCH heartbeat,
// 이탈 시 DELETE (또는 sendBeacon 이 POST + ?release=1).
//
// 락을 못 잡아도 상세는 **읽기 전용으로 열린다** — 남의 작업을 못 보게 막는 것은
// 과잉이고, 검수자가 "저건 뭐지" 하고 확인하는 것을 방해한다(설계 §6.3).
//
// HGH_SOURCE_G7=api 면 /v1/qa/answers/{id}/lock 으로 중계한다(409 lock_held → 현행 본문 {ok:false, heldBy}).
// sendBeacon 의 POST ?release=1 도 같은 출처라 계속 받아 DELETE 로 바꿔 보낸다.

export async function POST(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.lockPost(req);
  const g = await guard();
  if (!g.ok) return g.response;

  const body = await readJson(req);
  const jobId = str(body.jobId);
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  // navigator.sendBeacon 은 POST 만 보낸다 — 언로드 시 해제를 이 경로로 받는다.
  if (req.nextUrl.searchParams.get("release") === "1") {
    await releaseLock(jobId, g.reviewer.sessionId);
    return NextResponse.json({ ok: true });
  }

  const result = await acquireLock(jobId, g.reviewer.sessionId, g.reviewer.name);
  // 세션 활동 갱신은 부수적 — 실패해도 락 응답을 막지 않는다.
  void touchReviewSession(g.reviewer.sessionId).catch(() => {});

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        heldBy: {
          reviewerName: result.heldBy.reviewerName,
          acquiredAt: result.heldBy.acquiredAt,
        },
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, lock: result.lock });
}

export async function PATCH(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.lockPatch(req);
  const g = await guard();
  if (!g.ok) return g.response;
  const jobId = str((await readJson(req)).jobId);
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  return NextResponse.json({ held: await heartbeatLock(jobId, g.reviewer.sessionId) });
}

export async function DELETE(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.lockDelete(req);
  const g = await guard();
  if (!g.ok) return g.response;
  const jobId = str((await readJson(req)).jobId);
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  await releaseLock(jobId, g.reviewer.sessionId);
  return NextResponse.json({ ok: true });
}
