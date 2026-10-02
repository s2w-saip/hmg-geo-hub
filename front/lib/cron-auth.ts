// Cron 라우트 공통 가드 — fail-closed.
//
// Vercel Cron 은 `Authorization: Bearer ${CRON_SECRET}` 을 붙여 호출한다. 종전에는
// `if (secret && …)` 로 secret 이 비어 있으면 검사를 건너뛰어, 환경변수 하나가 빠지면
// 미러 동기화·GA4 사전집계를 외부에서 누구나 트리거할 수 있었다. 이제 secret 이
// 없으면 503 으로 닫는다 — 로컬 디버그는 .env.local 에 CRON_SECRET 을 넣고 헤더를
// 붙여 호출한다.
export function requireCronSecret(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return new Response("cron secret not configured", { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}
