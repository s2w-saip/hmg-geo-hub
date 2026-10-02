import "server-only";
import { hasPeriod as periodPresent } from "@/lib/period/period-mode";
import { summaryScreenAllowed, type SummaryScreenKey } from "./screens";

// ════════════════════════════════════════════════════════════════════════════
// 기간 누적을 집계층이 서빙하는가: 화면 키 `S1.periodRoute` + **프리뷰 전용** env
// ════════════════════════════════════════════════════════════════════════════
//
// 기본은 off 다(`SUMMARY_SCREEN_OPT_IN`: `screens all` 로도 안 켜진다).
//
// ── 왜 옵트인인가 ──────────────────────────────────────────────────────────
//
// 이 판정이 켜지면 기간이 걸린 카드 계열이 미러 누적 대신 **집계층 회차 집합 SUM** 을
// 읽는다. 성능 수정처럼 보이지만 **고객이 보는 숫자가 바뀐다**: 두 경로는 창·모수가
// 다르다(회차 선택·미발행/숨김 회차·유닛 게이트·자사 인용 판정). `S4.subkpi` 가 같은
// 이유로 옵트인이고, 그 키의 실측 표가 `screens.ts` 예외 블록에 있다.
//
// ── 한 표면에 스위치가 **하나**인 이유 ──────────────────────────────────────
//
// 한 화면의 카드 ①~⑤ · 국가별 GEO · 경쟁사 행은 **같은 집계층 read 한 벌**에서 나온다
// (`summaryGlobalS1FromTrend` 의 문장 3개). 따로 켜면 같은 카드 안에서 모수가 갈린다.
// 그래서 표면당 판정도 하나다.
//
// 표면끼리는 **따로** 켠다(`S1.periodRoute` / `S4.periodRoute`). 함대는 창 안 회차가
// 수백 개라 폴백 사유(구멍·주 중복)가 글로벌과 독립적으로 발생하고, 한 키로 묶으면
// 웹사이트가 폴백하는 날 글로벌까지 되돌려야 한다.
//
// ── **카드 계열만** 탄다 (2026-09-18 F2) ───────────────────────────────────
//
// 게이트 함수(`viaTrend`)는 카드 말고도 인용·언급 계열이 함께 부른다. 화면 키를 안 보고
// 게이트 단위로 판정하면 `S4.periodRoute` 하나가 S5 언급·S6 인용까지 함께 기간 모드로
// 옮긴다: 그 둘은 파급이 가장 커서 **별도 승인 대상**이라고 스펙이 못 박은 지면이다.
// 그래서 판정 입력은 게이트가 아니라 **화면 키**이고, 매핑에 없는 화면은 언제나 false 다.
// 새 지면을 태우려면 아래 표에 한 줄을 더하는 것이 유일한 경로다(= 승인 흔적이 코드에 남는다).
//
// ── 왜 env 오버라이드가 필요한가 ───────────────────────────────────────────
//
// 화면 키는 `summary_settings` 한 행에서 오는데, **프리뷰와 프로덕션이 같은 DB 를
// 읽는지 미확인**이다. 같다면 프리뷰에서 보려고 키를 켜는 순간 프로덕션에도 켜진다.
// 그래서 프리뷰에서만 작동하는 두 번째 경로를 둔다.
//
// ── 프로덕션에서 실수로 켜지지 않게 하는 방법 ───────────────────────────────
//
// 값(`PERIOD_ROUTE_FORCE`)만 보지 않는다: **환경**을 먼저 본다. Vercel 이 주입하는
// `VERCEL_ENV` 가 `preview` 이거나 로컬 개발(`NODE_ENV=development`)일 때만 env 를
// 읽는다. 프로덕션 환경에 이 변수가 실수로 설정돼도 판정은 바뀌지 않는다.
// (GGMD-107 `period-compare-flag.ts` 와 **같은 계약**이다.)
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다: 이 값은 서버에서만 읽힌다.
// ⚠️ env 강제는 **화면 키 두 개를 함께** 켠다(`S1.periodRoute`·`S4.periodRoute`).
//    다만 아래 `PERIOD_ROUTE_BY_SCREEN` 매핑 밖의 화면은 env 로도 안 켜진다:
//    env 는 "스위치를 켜는" 경로이지 "지면을 넓히는" 경로가 아니다. 표면별로 나눠
//    켜고 싶으면 env 대신 `read_screens` 쪽(화면 키)을 쓴다.

/** 기간 경로 전환을 켜고 끄는 화면 키. 지면이 늘면 여기에 더한다. */
export type PeriodRouteScreenKey = "S1.periodRoute" | "S4.periodRoute";

/**
 * **어느 화면이 어느 키로 기간 모드를 타는가**: 이 표에 없는 화면은 타지 않는다.
 *
 * 오늘 실린 것은 카드 계열뿐이다:
 *   · `S1.dashboard` 글로벌 카드 ①~⑤ · 국가별 GEO · 경쟁사 행(한 read 를 나눠 쓴다)
 *   · `S4.dashboard` 웹사이트 카드 ①~⑤ · GEO 경쟁
 *   · `S4.subkpi`    웹사이트 카드의 엔진 일관성 배지: **같은 카드 안**이라 ①~⑤ 와
 *                    모수가 갈리면 안 된다. 그래서 카드와 같은 키를 쓴다.
 * 빠진 것(의도):
 *   · `S5.mention`·`S6.citation`·`S2.mention`·`S3.citation`: 상시 `cumulative` 라
 *     전환의 파급이 가장 크고, 스펙이 **별도 워크유닛·별도 승인**으로 갈라 놓았다.
 */
const PERIOD_ROUTE_BY_SCREEN: Partial<Record<SummaryScreenKey, PeriodRouteScreenKey>> = {
  "S1.dashboard": "S1.periodRoute",
  "S4.dashboard": "S4.periodRoute",
  "S4.subkpi": "S4.periodRoute",
};

/** 이 화면이 기간 모드를 탈 수 있는가: 탈 수 있으면 그 스위치 키. 순수 함수. */
export function periodRouteScreenKeyFor(
  screen: SummaryScreenKey,
): PeriodRouteScreenKey | null {
  return PERIOD_ROUTE_BY_SCREEN[screen] ?? null;
}

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export function periodRouteOverrideAllowedHere(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function periodRouteForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return periodRouteOverrideAllowedHere(env) && env.PERIOD_ROUTE_FORCE === "1";
}

/**
 * 이 요청이 **기간을 건 것인가**: 모드 선택 규칙의 단일 정의(설계 §6-1).
 *
 * ⚠️ 규칙은 `dateFrom || dateTo` 하나다. 기간 없는 요청을 `mode: "period"` 로 보내면
 *    `resolveCycleSet` 의 period 갈래가 `pickCyclesInRange` 를 **무경계**로 돌려 전 이력
 *    회차를 집합에 넣는다(`gate.ts` 가 그 조합을 폴백으로 거부하는 이유).
 */
export function hasPeriod(filters: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): boolean {
  // 원자 정본 = `lib/period/period-mode.ts::hasPeriod`(같은 식이 네 곳에 있었다).
  return periodPresent(filters);
}

/**
 * 이 요청에서 기간 누적을 집계층이 서빙하는가.
 *
 * ⚠️ **순서가 계약이다**: 기간이 안 걸린 요청은 어떤 스위치로도 기간 모드가 되지
 *    않는다(첫 줄). 그래서 키·env 가 켜져 있어도 기본 화면(기간 없음)은 종전 경로
 *    그대로이고, 회귀 0 의 근거가 이 한 줄이다.
 */
export async function periodRouteEnabled(
  screen: PeriodRouteScreenKey,
  filters: { dateFrom?: string | null; dateTo?: string | null },
): Promise<boolean> {
  if (!hasPeriod(filters)) return false;
  if (periodRouteForced()) return true;
  return summaryScreenAllowed(screen);
}

/**
 * 게이트가 부르는 진입점: **화면 키로** 판정한다.
 *
 * 게이트 하나를 여러 화면이 공유하므로(`viaTrend` 는 카드·언급·인용이 함께 부른다),
 * 게이트 단위로 판정하면 승인받지 않은 지면까지 함께 움직인다(F2). 표에 없는 화면은
 * 스위치가 켜져 있어도 false 다.
 */
export async function periodRouteEnabledForScreen(
  screen: SummaryScreenKey,
  filters: { dateFrom?: string | null; dateTo?: string | null },
): Promise<boolean> {
  const key = periodRouteScreenKeyFor(screen);
  return key === null ? false : periodRouteEnabled(key, filters);
}
