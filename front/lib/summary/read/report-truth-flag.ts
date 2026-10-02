import "server-only";
import { summaryScreenAllowed } from "./screens";

// ════════════════════════════════════════════════════════════════════════════
// 발행값 읽기(`X.reportTruth`)의 on/off — 화면 키 + **프리뷰 전용** env
// ════════════════════════════════════════════════════════════════════════════
//
// 기본은 off 다(`SUMMARY_SCREEN_OPT_IN` — `screens all` 로도 안 켜진다). 이 키는
// **고객이 보는 숫자를 바꾼다**: 9/11 회차 무필터 타겟 URL 인용률이 라이브 5,739/9,982
// (57.5%)에서 발행값 5,611/9,586(58.5%)으로 간다. 모수도 바뀐다 — 라이브는 대시보드에
// 있는 전 사이트, 발행값은 리포트의 벤치 모수 104개다.
//
// 접두사가 `S*` 가 아니라 `X*` 인 이유: 이 판정은 화면 하나가 아니라 "발행 회차를 어떻게
// 읽는가" 라는 교차 관심사다(`X.answerAnchor`·`X.trendGrid` 와 같은 층).
//
// ── 왜 env 오버라이드가 필요한가 ───────────────────────────────────────────
// 화면 키는 `summary_settings` 한 행에서 오는데 프리뷰와 프로덕션이 같은 DB 를 읽는지
// 미확인이다. 같다면 프리뷰에서 보려고 키를 켜는 순간 프로덕션에도 켜진다. 그래서
// 프리뷰에서만 작동하는 두 번째 경로를 둔다 — 기존 `*_FORCE` 4종과 같은 계약이다.
//
// 값(`REPORT_TRUTH_FORCE`)만 보지 않는다. **환경을 먼저 본다**: `VERCEL_ENV` 가
// `preview` 이거나 로컬 개발일 때만 env 를 읽는다. 프로덕션에 이 변수가 실수로
// 설정돼도 판정은 바뀌지 않는다.
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 서버에서만 읽힌다.
//
// ── 롤백 레버가 둘이다 ─────────────────────────────────────────────────────
// ① 이 키를 내린다(즉시, 배포 불필요) ② 발행물 행을 `status='rolled_back'` 으로
// 내린다(그 회차만). 둘 다 라이브 폴백으로 돌아가고 값이 지워지지는 않는다.

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export function reportTruthOverrideAllowedHere(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function reportTruthForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return reportTruthOverrideAllowedHere(env) && env.REPORT_TRUTH_FORCE === "1";
}

/**
 * 이 요청에서 발행 회차를 발행값으로 읽는가.
 *
 * ⚠️ **순서가 계약이다** — env 를 먼저 본다. 꺼져 있을 때 `summaryScreenAllowed` 가
 *    도는 것은 공짜다(설정 읽기는 요청당 1회 30초 메모라 같은 렌더의 다른 게이트와
 *    셀을 공유한다). off 에서 DB 왕복이 늘지 않는 근거가 이것이다.
 */
export async function reportTruthEnabled(): Promise<boolean> {
  if (reportTruthForced()) return true;
  return summaryScreenAllowed("X.reportTruth");
}
