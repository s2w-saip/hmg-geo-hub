// 미러 집계 캐시 무효화 **안내 문구** (hmg-geo PR #297 검증 G1·D4·C2 반영, 2026-09-27).
//
// 앱 밖에서 도는 운영 스크립트는 `revalidateTag` 를 직접 부를 수 없다. 그래서 값을 바꾼
// 뒤에는 이미 있는 무효화 경로(`generate-cycle.ts --revalidate-only` → 내부 라우트
// `/api/internal/summary/published` → 미러·사실표 태그 둘 다 무효화)를 사람이 한 번 태운다.
//
// 왜 필요한가: 회차 지문(`lib/period/cycle-fingerprint.ts`)은 **회차 수준 게이트 입력**만
// 본다. 이 스크립트들이 바꾸는 것(state 행 없는 회차의 귀속 날짜, 이미 노출 중인 회차의
// 답변 행, 숨김을 이전 값으로 되돌림)은 지문이 못 보거나 옛 지문으로 되돌아가므로,
// 무효화하지 않으면 셀 TTL(최대 2시간) 동안 옛 값이 남을 수 있다.
//
// 자동 호출로 붙이지 않은 이유: 무효화에는 `HMG_INTERNAL_BASE_URL`·`CRON_SECRET`(프리뷰면
// 우회 토큰까지)이 필요하고, 이 스크립트들은 DB 자격증명만 받는다. 비밀값 요구를 늘리지
// 않으려고 **명령을 출력**하는 데서 멈춘다.

export const MIRROR_CACHE_REVALIDATE_COMMAND = "npm run summary:generate -- --revalidate-only";

/** 쓰기가 끝난 뒤 출력할 안내(여러 줄). `what` = 이 스크립트가 바꾼 것. */
export function mirrorCacheRevalidateNotice(what: string): string {
  return [
    "",
    `다음(캐시) — ${what} 은(는) 미러 집계 캐시(TTL 최대 2시간)가 회차 지문으로 못 보는 변경이다.`,
    "  화면에 바로 반영하려면 무효화를 한 번 태운다(env HMG_INTERNAL_BASE_URL·CRON_SECRET,",
    "  프리뷰면 HMG_INTERNAL_BYPASS_SECRET):",
    `    ${MIRROR_CACHE_REVALIDATE_COMMAND}`,
    "",
  ].join("\n");
}
