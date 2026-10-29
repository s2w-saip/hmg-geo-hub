import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/qa/route-helpers";
import { getListDeltas } from "@/lib/db/repositories/qa-review";

// 목록 화면의 10초 폴링. 락과 검수 상태만 돌려준다 — 페이지 전체를 다시 렌더하면
// 스크롤 위치와 필터 조작이 튄다. WebSocket 을 쓰지 않는 이유는 동시 검수자가
// 10명 내외라 폴링으로 충분하기 때문이다(설계 §6.4).

const MAX_IDS = 200;

export async function GET(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;

  const raw = req.nextUrl.searchParams.get("jobIds") ?? "";
  const jobIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);

  return NextResponse.json(await getListDeltas(jobIds));
}
