import { revalidateTag } from "next/cache";
import { requireCronSecret } from "@/lib/cron-auth";
import { MIRROR_AGGREGATE_TAG, SUMMARY_TAG } from "@/lib/scope/server";

// 사실표 generation 스왑 뒤 화면 캐시를 즉시 무효화하는 **내부** 라우트(설계 v4.1 §7-2).
//
// 왜 필요한가: 생성 러너는 앱 밖(전용 EC2)에서 돌아 Next 의 Data Cache 를 건드릴 수 없다.
// 무효화가 없으면 새 회차가 published 로 넘어가도 최대 TTL(2시간)까지 옛 회차가 서빙된다 —
// 롤백 1단(read-switch off)에도 같은 잔존이 생긴다.
//
// 가드는 다른 크론 라우트와 같은 `CRON_SECRET`(`lib/cron-auth.ts`, fail-closed:
// 미설정 503 · 불일치 401). `/api/*` 는 middleware 의 Supabase 인증 게이트 밖이므로
// 이 헤더 검사가 유일한 문턱이다. 요청 본문은 읽지 않는다 — 무효화 대상은 고정 태그 2개다.
//
// GET 은 405 다. 무효화는 부수효과가 있는 동작이라 링크 한 번·프리페치 한 번으로
// 일어나면 안 된다.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  revalidateTag(MIRROR_AGGREGATE_TAG);
  revalidateTag(SUMMARY_TAG);
  return Response.json({ ok: true, at: new Date().toISOString() });
}

export async function GET(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
}
