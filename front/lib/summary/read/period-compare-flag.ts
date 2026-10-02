import "server-only";
import { summaryScreenAllowed } from "./screens";

// ════════════════════════════════════════════════════════════════════════════
// 기간 비교 Δ(GGMD-107)의 on/off — 화면 키 `S1.periodCompare` + **프리뷰 전용** env
// ════════════════════════════════════════════════════════════════════════════
//
// 기본은 off 다(`SUMMARY_SCREEN_OPT_IN` — `screens all` 로도 안 켜진다).
//
// ── 스위치가 **하나**인 이유 (스펙 "롤아웃은 단일 스위치") ──────────────────
//
// 이 판정 하나가 두 가지를 함께 켠다:
//   ① 기간 프리셋의 **끝점** `E`(= 최신 노출 회차 앵커일) — 값의 창
//   ② **창 대 창** Δ 산식 — 증감의 창
// 둘을 독립적으로 켜면 같은 화면에서 값의 창과 Δ 의 현재 창이 갈린다(design §1-3 B안:
// 카드에 76.27% 를 찍고 그 옆에 "74.57 → 64.78" 을 쓰는 상태). 그래서 판정 함수도 하나다.
//
// ── 왜 env 오버라이드가 필요한가 ───────────────────────────────────────────
//
// 화면 키는 `summary_settings` 한 행에서 오는데, **프리뷰와 프로덕션이 같은 DB 를
// 읽는지 미확인**이다(design §11-2·§16). 같다면 프리뷰에서 보려고 키를 켜는 순간
// 프로덕션에도 켜진다. 그래서 프리뷰에서만 작동하는 두 번째 경로를 둔다.
//
// ── 프로덕션에서 실수로 켜지지 않게 하는 방법 ───────────────────────────────
//
// 값(`PERIOD_COMPARE_FORCE`)만 보지 않는다 — **환경**을 먼저 본다. Vercel 이 주입하는
// `VERCEL_ENV` 가 `preview` 이거나 로컬 개발(`NODE_ENV=development`)일 때만 env 를
// 읽는다. 프로덕션 환경에 이 변수가 실수로 설정돼도 판정은 바뀌지 않는다.
// (다른 옵트인 화면 키 게이트와 같은 계약.)
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 이 값은 서버에서만 읽힌다.

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export function periodCompareOverrideAllowedHere(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function periodCompareForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return periodCompareOverrideAllowedHere(env) && env.PERIOD_COMPARE_FORCE === "1";
}

/**
 * 이 요청에서 기간 비교 Δ(와 앵커 끝점)를 쓰는가.
 *
 * ⚠️ **순서가 계약이다** — env 를 먼저 본다. 꺼져 있을 때 `summaryScreenAllowed` 가
 *    도는 것 자체는 공짜다(원문 읽기는 30초 메모라 같은 렌더의 다른 게이트와 셀을
 *    공유한다 — off 에서 **DB 왕복이 늘지 않는** 근거가 이것이다).
 */
export async function periodCompareEnabled(): Promise<boolean> {
  if (periodCompareForced()) return true;
  return summaryScreenAllowed("S1.periodCompare");
}
