import "server-only";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { hasPeriod, isCumulativePeriod } from "@/lib/period/period-mode";
import { ensureAnchorAxis } from "@/lib/period/anchor-axis-state";
import { ensureTrendGrid } from "@/lib/period/trend-grid-flag";
import {
  readEnabled,
  summaryLedgerAvailable,
} from "@/lib/db/repositories/summary-settings";
import { summaryScreenAllowed, type SummaryScreenKey } from "./screens";
import { hasOpenCycle } from "@/lib/db/repositories/summary-cycles";
import {
  resolveCycleSet,
  dateRangeReason,
  type CycleSet,
  type CycleSetMode,
} from "./cycle-set";

// 회차 집합 판정은 `cycle-set.ts` 가 쥔다(PR② T9). 여기서 재수출하는 것은
// 종전 호출부·테스트가 이 경로로 부르고 있어서다 — 정의는 한 곳뿐이다.
export { dateRangeReason };
export type { CycleSet, CycleSetMode };

// 사실표 조회 게이트 — 설계 v4.1 §8-3.
//
// 판정 단위는 **요청**(리포지터리 함수 호출 1개)이지 화면이 아니다. 한 화면에서
// 카드는 사실표, 추이·Δ 는 미러인 혼합을 허용한다 — 카드 값이 종전 스냅샷 값과
// 같다는 패리티가 전제(§9-1).
//
// 기본값은 언제나 폴백이다. 판정에 필요한 것이 하나라도 확인되지 않으면
// (스위치 off · 화면 미허용 · 원장 미적용 · 회차 없음 · 기간이 회차 하나로 안
// 떨어짐) 종전 SQL 로 간다. 손실이 비대칭이기 때문 — 폴백은 느릴 뿐이고, 잘못된
// hit 는 틀린 숫자다.
//
// 판정 순서(사유가 겹칠 때 먼저 이기는 것):
//   no-projects/no-root → unsupported-filter:* → disabled → ledger-unavailable
//   → 【회차 집합 판정 = cycle-set.ts】 → **screen-not-allowed**
//
// 회차 집합 판정이 내는 사유(모드별):
//   snapshot : missing-cycle(s) → range-outside-cycle / range-multi-cycle
//   period   : cycle-set-unavailable → unpublished-cycle-in-range
//              → duplicate-cycle-in-week → missing-cycles-in-range   (§6-3)
// period 사유 3종의 의미·`open` 이 구멍이 아닌 이유는 `cycle-set.ts` 머리 주석.
// 플랜 §6-3 의 `too-many-cycles`(회차 수 > N)는 **구현하지 않는다** — 제품 확정
// D-2 (2) "상한 없음". 대신 회차 수가 헤더에 `cycles:<n>` 으로 나간다.
//
// ⚠️ `screen-not-allowed` 가 **맨 뒤**인 것은 의도다(2026-09-10, PR① R2). 종전엔
//   `disabled` 바로 다음이었는데, 그러려면 화면 키가 판정 함수 안에 있어야 하고
//   그래서 server.ts 의 게이트 캐시 키에도 화면이 들어갔다 — 한 렌더가 같은 필터로
//   S1/S2/S3(웹 S4/S5/S6) 세 화면 키를 부르므로 **같은 판정이 3번**, DB 왕복이
//   4번 더 돌았다. 화면 검사를 판정 **뒤**로 빼면(`applyScreenGate`) 원장·회차
//   프로브를 화면들이 공유한다. 대신 화면이 꺼져 있고 원장도 없을 때의 사유가
//   `screen-not-allowed` → `ledger-unavailable` 로 바뀐다. 둘 다 폴백이라 값은
//   같고, 바뀌는 것은 로그 문자열뿐이다.

export type SummaryReadRoute =
  | (CycleSet & {
      path: "summary";
      /**
       * 이 회차 **밖**에 더 최신 run 이 있는가 — **관측 전용**(D-1(2), 제품 책임자 2026-09-10).
       *
       * 경로는 어느 쪽이든 hit 이다: 사실표는 **직전 published 회차**를 그대로 낸다.
       * 이 값이 하는 일은 `x-hmg-summary` 에 `open-cycle` 을 붙이는 것뿐이고,
       * 화면에는 아무것도 나가지 않는다(진척 배지는 2026-09-10 제거). 프로브가
       * 실패해도 `false` 일 뿐 **폴백하지 않는다** — 종전 `open-cycle-unavailable`
       * 사유는 폐기됐다.
       *
       * 종전엔 이 상황이 통째로 `fallback:newer-runs` 였다. 루트에 미귀속 run 이
       * 상시 6,600개 이상이라 글로벌 대시보드가 **항상** 폴백했고, 그래서 사실표
       * 경로가 사실상 죽어 있었다(2026-09-09 실측).
       */
      openRuns: boolean;
    })
  | { path: "mirror"; reason: string };

/**
 * 응답 헤더/로그용 값 — `x-hmg-summary: hit | hit partial:<n>/<m> | fallback:<reason>`.
 * `partial` 은 선택 m 개 중 n 개 프로젝트만 이번 회차에 데이터가 있다는 뜻이다
 * (나머지는 제외 — 미러 값으로 메우지 않는다).
 *
 * `open-cycle` 꼬리표는 **관측**이다 — "이 회차 밖에 더 최신 run 이 있다". 값에는
 * 영향이 없다(사실표는 직전 published 회차 그대로). 숫자를 붙이지 않는 이유는
 * summary-cycles.ts 의 `hasOpenCycle` 머리 주석 참고(배지 제거, 제품 책임자 2026-09-10).
 *
 * `cycles:<n>` 은 **기간 모드에서만** 붙는다 — 이번 요청이 회차 몇 개를 합산하는가.
 * 제품 확정 D-2 (2)로 회차 수 **상한을 두지 않기로** 했으므로(느린 것을 감수), 상한
 * 대신 이 수를 관측에 노출한다: 기간 표면이 느릴 때 "회차를 몇 개 읽고 있었나" 가
 * 로그에 남아야 E1(플랜 §3-5) 이 사후에 진단 가능하다. 스냅샷 모드에는 붙이지
 * 않는다 — 항상 1회차이고, 붙이면 프로덕션 헤더 문자열이 이유 없이 바뀐다.
 *
 * 전체 형태: `hit[ partial:<n>/<m>][ cycles:<k>][ skipped:<s>][ open-cycle]`.
 */
export function summaryRouteHeaderValue(route: SummaryReadRoute): string {
  if (route.path === "mirror") return `fallback:${route.reason}`;
  const covered = route.projectIds.length;
  const total = covered + route.missingProjectIds.length;
  let out = covered === total ? "hit" : `hit partial:${covered}/${total}`;
  if (route.mode === "period") {
    out += ` cycles:${route.anchorCount}`;
    // 창에서 뺀 미발행 확정 회차(F1). `hit` 인데 점이 기대보다 적은 이유가 이 수다 —
    // 안 붙이면 "왜 7/07 점이 없나" 를 로그만 보고는 알 수 없다.
    if (route.skippedCount) out += ` skipped:${route.skippedCount}`;
  }
  if (route.openRuns) out += " open-cycle";
  return out;
}

/** 캐시 키에 넣는 경로 태그(§8-4) — 사실표 결과와 미러 결과가 한 셀을 공유하면 안 된다. */
export function summaryCacheTag(route: SummaryReadRoute): string {
  return route.path === "summary" ? `summary:${route.cycleKey}` : "mirror";
}

const mirror = (reason: string): SummaryReadRoute => ({ path: "mirror", reason });

/**
 * 기간 모드인데 **범위가 없으면 판정 불가**(폴백): `resolveCycleSet` **앞**에 선다.
 *
 * 왜 여기서 막나: `resolveCycleSet` 의 period 갈래는 `pickCyclesInRange` 를 무경계로
 * 돌린다(`dateFrom: null, dateTo: null`). 그러면 전 이력 회차가 집합에 들어가고,
 * 세부층은 13주 파티션만 보존하므로 그 밖 회차는 조용히 0 이 된다: 폴백보다 나쁜
 * "틀린 숫자" 다. 모드 선택 규칙은 `dateFrom || dateTo` 하나이므로(설계 §6-1),
 * 그 규칙을 어긴 호출은 **DB 를 치기 전에** 거절한다.
 *
 * 오늘 기간 모드를 부르는 호출부는 셋 다 바닥(13주·창 기본값)을 먼저 얹는다
 * (`globalSeriesFilters`·`trendPeriodFilters`·카드 계열의 `hasPeriod` 선검사):
 * 그래서 이 가드는 현행 판정을 **한 건도 바꾸지 않는다**. 다음 호출부를 막는 것이 목적이다.
 */
function periodBoundsReason(
  mode: CycleSetMode,
  filters: { dateFrom?: string | null; dateTo?: string | null },
): string | null {
  if (mode !== "period") return null;
  return filters.dateFrom || filters.dateTo ? null : "period-without-range";
}

/**
 * 판정 옵션 — 기본값은 종전 동작(스냅샷)이다. 인자를 안 주면 이 파일이 PR② 이전과
 * 바이트 단위로 같은 판정을 낸다(수용 기준 ④).
 *
 * `mode: "period"` 는 **회차 집합**을 읽는 표면(누적 S2/S5 · 추이)이 쓴다. 리더가
 * 자기 의미론을 알고 넘기는 것이지 필터에서 추론하지 않는다 — `cumulative` 는
 * 화면의 축 선택이고, "회차 집합을 합산한다" 는 리더의 구현 선택이라 둘이 1:1이
 * 아니다(추이 차트는 `cumulative` 없이도 회차 집합을 읽는다).
 */
export interface SummaryRouteOptions {
  mode?: CycleSetMode;
  /**
   * 기간 **없는** `cumulative` 요청을 스냅샷과 동치로 볼 것인가(기본 `false` = 종전).
   *
   * 미러 산식 정본(`cumulativeMode`, `scope-aggregates.ts`)이 그 요청을 이미 **스냅샷**
   * 으로 판정하므로 의미론이 같다: `mirrorCumulative` 가 그 명제의 단일 정의다.
   * 그래도 기본값이 `false` 인 것은 **켜는 순간 고객이 보는 숫자가 바뀌기 때문**이다
   * (인용·언급 화면이 상시 `cumulative: true` 라 오늘 항상 미러다). 켜는 것은 화면 키
   * 옵트인의 몫이고, 이 인자는 그 결정을 판정 함수까지 전달하는 통로일 뿐이다.
   */
  cumulativeSnapshotOk?: boolean;
}

/**
 * **미러가 실제로 누적이 되는 조건**: `cumulativeMode`(미러 산식 정본)와 같은 명제다.
 *
 * `filters.cumulative` 는 화면의 축 선택이지 "누적을 읽는다" 가 아니다: 기간이 없으면
 * 미러도 최신 스냅샷 하나를 낸다. 이 술어를 **한 곳에서만** 정의하는 이유는 종전에 두
 * 벌로 갈라져 2026-09-04~09-16 이노션 신고를 만든 전례가 있어서다(`cumulativeMode`
 * 머리 주석). 판정을 바꿀 일이 생기면 여기와 `cumulativeMode` 를 함께 고친다.
 */
export function mirrorCumulative(filters: {
  cumulative?: boolean;
  dateFrom?: string | null;
  dateTo?: string | null;
}): boolean {
  // 판정 정본 = `lib/period/period-mode.ts::resolvePeriodMode`. 이 표면은 추이가 아니므로
  // `allRuns` 를 넘기지 않는다 — 종전 식(allRuns 항 없음)과 같은 진리표다.
  return isCumulativePeriod(filters);
}

/**
 * 두 표면이 공유하는 미지원 축 — 순수 함수(테스트가 여기부터 본다).
 *
 * - `cumulative` = 누적 표면(S2/S5). **스냅샷 모드에서만** 미지원 축이다 — 1차
 *   롤아웃의 사실표는 단일 회차 스냅샷만 서빙한다(§8-2). 기간 모드(`period`)는
 *   그 누적을 회차 집합 SUM 으로 내는 것이 목적이므로 여기서 막으면 안 된다
 *   (T8 이 켤 경로). 모드 인자가 없으면 종전대로 스냅샷이다.
 *   `cumulativeSnapshotOk` 를 켜면 **기간이 없는** `cumulative` 만 통과한다:
 *   그때는 미러도 스냅샷이기 때문이다(`mirrorCumulative`). 기간이 걸린 `cumulative`
 *   요청은 그 옵션과 무관하게 스냅샷 모드에서 여전히 폴백이다(읽어야 할 회차가 여럿).
 * - 출처 카테고리는 집계 시점에 파생되는 값이라(override 즉시 반영, P6 예외 ①)
 *   사실표 행에 없다 — 이 축이 걸리면 종전 경로가 판정한다.
 * - 커스텀 필드는 사실표에 굳히지 않았다(§3-3 dim 의 `custom_tags` 는 감사용).
 */
function commonUnsupportedReason(
  filters: StandardFilters,
  mode: CycleSetMode,
  cumulativeSnapshotOk = false,
): string | null {
  if (mode === "snapshot" && filters.cumulative === true) {
    // 옵션이 꺼져 있으면 종전과 **바이트 동일**: `cumulative` 면 무조건 폴백.
    if (!cumulativeSnapshotOk || mirrorCumulative(filters)) return "cumulative";
  }
  if (filters.sourceCategory?.length) return "unsupported-filter:source-category";
  const custom = filters.customFieldFilters;
  if (custom && Object.values(custom).some((v) => v.length > 0)) {
    return "unsupported-filter:custom-field";
  }
  return null;
}

/**
 * 웹사이트(S4) 미지원 축.
 *
 * `region` 은 표준 표면의 축(scope_answers.region)이라 웹사이트 사실표의
 * `country`(website_sites.country_code verbatim)와 의미가 다르다 — 섞지 않는다.
 */
export function unsupportedWebsiteFilterReason(
  filters: StandardFilters,
  mode: CycleSetMode = "snapshot",
  cumulativeSnapshotOk = false,
): string | null {
  const common = commonUnsupportedReason(filters, mode, cumulativeSnapshotOk);
  if (common) return common;
  if (filters.region?.length) return "unsupported-filter:region";
  return null;
}

/**
 * 글로벌(S1) 미지원 축.
 *
 * 웹사이트와 정확히 반대다: `region`(= 사실표 `country`, ISO)은 **지원 축**이고,
 * 표준 화면이 노출하지 않는 `websiteCountry`(가상 코드 포함)가 오면 폴백한다 —
 * 표준 사실표의 `country` 는 `worldwide`·`middleeast` 같은 사이트 가상 코드를
 * 담지 않으므로 그 축으로 좁히면 조용히 공집합이 된다.
 */
export function unsupportedGlobalFilterReason(
  filters: StandardFilters,
  mode: CycleSetMode = "snapshot",
  cumulativeSnapshotOk = false,
): string | null {
  const common = commonUnsupportedReason(filters, mode, cumulativeSnapshotOk);
  if (common) return common;
  if (filters.websiteCountry?.length) return "unsupported-filter:website-country";
  return null;
}

// ── 화면 단위 스위치(A5)는 **판정 뒤 후처리**다 ─────────────────────────────
//
// 판정(`resolve*Base`)은 화면을 모른다 — 그래서 server.ts 의 React cache 키가
// `{r,f}`/`{p,f}` 로 화면과 무관해지고, 한 렌더의 여러 화면이 같은 셀을 공유한다
// (머리 주석의 ⚠️ 참고). 화면 검사는 그 위에 얹는다: **hit 을 폴백으로 낮출 뿐**
// 폴백 사유를 바꾸지 않는다.
/**
 * 이 화면이 사실표를 써도 되는가(A5). 아니면 hit 을 `screen-not-allowed` 로 낮춘다.
 * 이미 폴백인 경로는 그대로 — 사유는 판정이 낸 것이 이긴다.
 */
export async function applyScreenGate(
  route: SummaryReadRoute,
  screen: SummaryScreenKey,
): Promise<SummaryReadRoute> {
  if (route.path !== "summary") return route;
  return (await summaryScreenAllowed(screen)) ? route : mirror("screen-not-allowed");
}

/**
 * **카드 정렬 게이트** — 한 화면 안에서 카드와 같은 지표를 그리는 추이가 카드의 원천을
 * 따라가게 하는 우회로(2026-09-29 제품 책임자 A안, `fetchStandardKpiBrandTrend` 한 곳).
 *
 * `screen` 이 막혔을 때(`screen-not-allowed`) **그 카드의 화면 키**(`align.screen`)가 열려
 * 있으면 판정 결과(hit)를 그대로 쓴다. 규칙 셋:
 *   · `screen` 이 이미 허용이면 종전과 같다 — 우회가 일어나지 않는다(`aligned: false`).
 *   · 판정 자체가 폴백이면(원장·회차·필터 사유) 그대로 폴백이다 — 우회는 **화면 검사만**
 *     건너뛴다. 사유를 바꾸지 않는 `applyScreenGate` 의 자세 그대로다.
 *   · `align` 이 없으면 `applyScreenGate` 와 **같은 결과**다(호출부 무변경 보장).
 *
 * 화면 키를 바꿔 끼우지 않는다 — 호출부 로그는 원래 `screen` 이름으로 찍고, 우회는
 * `aligned` 로 따로 알린다(로그가 실제 경로를 정직하게 말해야 한다).
 */
export interface ScreenGateAlign {
  /** 따라갈 카드의 화면 키. 이것이 허용일 때만 우회한다. */
  screen: SummaryScreenKey;
  /** 로그 꼬리표(`opt-in-bypass:<reason>`). */
  reason: string;
}

export async function applyScreenGateAligned(
  route: SummaryReadRoute,
  screen: SummaryScreenKey,
  align: ScreenGateAlign | null,
): Promise<{ route: SummaryReadRoute; aligned: boolean }> {
  const gated = await applyScreenGate(route, screen);
  if (!align || gated.path === "summary" || route.path !== "summary") {
    return { route: gated, aligned: false };
  }
  // 여기 = 판정은 hit 인데 `screen` 검사만 막았다. 카드 키가 열려 있으면 카드와 같은 원천.
  return (await summaryScreenAllowed(align.screen))
    ? { route, aligned: true }
    : { route: gated, aligned: false };
}

/**
 * 웹사이트 대시보드(S4) 요청의 읽기 경로 판정 — **화면 무관**(캐시되는 부분).
 *
 * 반드시 **캐시 바깥**에서 돌아야 한다(§8-4): 경로 자체가 캐시 키에 들어가므로,
 * 캐시 안에서 판정하면 스위치를 내려도 hit 결과가 TTL 동안 서빙된다.
 * (여기서 말하는 캐시는 조회 결과 캐시 `mirrorCache` 다. 판정 자체를 요청 안에서
 *  React cache 로 접는 것은 별개고, 그 키가 화면을 안 담는 것이 이 분리의 목적이다.)
 */
export async function resolveWebsiteSummaryRouteBase(
  projectIds: string[],
  filters: StandardFilters,
  opts: SummaryRouteOptions = {},
): Promise<SummaryReadRoute> {
  const mode = opts.mode ?? "snapshot";
  if (projectIds.length === 0) return mirror("no-projects");
  const bounds = periodBoundsReason(mode, filters);
  if (bounds) return mirror(bounds);
  const unsupported = unsupportedWebsiteFilterReason(filters, mode, opts.cumulativeSnapshotOk);
  if (unsupported) return mirror(unsupported);
  // ── 설정 두 건 + 앵커 축 판정을 **한 배치로** 발행한다 ─────────────────────
  //
  // 앵커 축(0077)은 **기간 유무와 무관하게** 확정한다. 종전에는 `hasPeriod` 일 때만
  // 확정했는데, 그 조건부가 기본 화면(기간 미지정)에서 회차에 `round_date` 를 안
  // 싣게 만들었고 그 결과 집계층 `asOf` 만 종전 축(run 앵커 UTC)에 남았다
  // (검증 B2: 미러·JS 는 `2026-09-14`, 집계층은 `2026-09-13T15:30:00.000Z`).
  // 같은 화면에서 기간과 기준일이 다른 시계를 보는 것이 이 전환이 없애려던 결함이다.
  //
  // 직렬 await 3연발이 아니라 `Promise.all` 인 이유: 게이트 앞단은 접힘 프로브와
  // 집계층 read 의 **동시 발행**(PR④ A1)이 서 있는 자리라, 여기에 왕복을 하나
  // 직렬로 더하면 그 이득을 깎는다. 판정 순서(disabled → ledger)는 아래에서 그대로다.
  // `ensureAnchorAxis` 는 절대 throw 하지 않고, 스위치가 꺼져 있으면 DB 를 아예
  // 건드리지 않는다(`anchor-axis-flag.ts` 의 순서 계약).
  //
  // 확정은 요청당 한 번이다 — 한 요청 안에서 회차 집합 판정과 집계 술어가 같은 축이어야
  // 한다(`anchor-axis-state.ts` 머리 주석의 계약 ①). 꺼져 있으면(기본) 아래 판정·SQL 이
  // 종전과 바이트 동일하다.
  // 추이 격자(`X.trendGrid`)는 **기간 모드에서만** 묻는다 — 완결성은 추이 자리 판정의
  // 입력이고(설계 §4-A), 스냅샷 픽에 실으면 카드 셀의 캐시 키만 이유 없이 갈린다.
  //
  // ⚠️ 2026-09-20 병합으로 판정 **순서가 스위치 먼저**가 됐다(`trend-grid-flag.ts`).
  //    그래도 이 자리의 왕복은 안 는다: 스위치가 보는 `summary_settings` 원문은 바로
  //    위 `readEnabled()` 와 **같은 30초 메모**라 문장이 하나뿐이다. 늘어나는 것은 축이
  //    꺼진 배포에서 그 메모를 한 번 더 읽는 것뿐이고, 그것은 DB 왕복이 아니다.
  const [enabled, ledger, anchorAxis, trendGrid] = await Promise.all([
    readEnabled(),
    summaryLedgerAvailable(),
    ensureAnchorAxis(),
    mode === "period" ? ensureTrendGrid() : Promise.resolve(false),
  ]);
  if (!enabled) return mirror("disabled");
  if (!ledger) return mirror("ledger-unavailable");

  // 회차가 **0개**일 때만 폴백이다(제품 결정 2026-09-06). 일부 프로젝트에 이번 회차가
  // 없는 것은 정상 — 그 프로젝트는 모수에서 빠진다("이번 회차 데이터 없음"). 종전
  // 미러 경로는 창이 없어 그 자리를 7월 stale 값으로 메우고 있었다.
  // 회차 집합 판정(스냅샷·기간, 폴백 사유 포함)은 `cycle-set.ts` 가 쥔다(§6-3).
  const set = await resolveCycleSet({
    surface: "website",
    mode,
    projectIds,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    anchorAxis,
    // 꺼져 있으면 **인자 자체를 싣지 않는다**(축과 같은 규율 — 호출 모양까지 종전과 같다).
    ...(trendGrid ? { trendGrid: true } : {}),
  });
  if (!set.ok) return mirror(set.reason);

  // 열린 회차 관측도 **회차가 있는 프로젝트**에 대해서만 — 제외된 프로젝트의 옛 run 이
  // 섞이면 관측이 무의미해진다. 실패해도 false 일 뿐 판정은 바뀌지 않는다.
  const openRuns = await hasOpenCycle(set.set.projectIds);
  return { path: "summary", ...set.set, openRuns };
}

/**
 * 글로벌 대시보드(S1) 요청의 읽기 경로 판정 — 설계 v4.1 §6-5·§8-3. **화면 무관**.
 *
 * 웹사이트(S4)와 같은 순서·같은 기본값(항상 폴백)이고, 다른 것은 셋뿐이다:
 *   ① 회차 선택이 함대가 아니라 **루트 프로젝트의 최신 회차 1개**(`pickGlobalCycle`)
 *   ② 미지원 축이 `region` 이 아니라 `websiteCountry`
 *   ③ "일부만 회차 있음"(partial)이 없다 — 프로젝트가 하나라 hit 아니면 폴백이다
 *
 * 열린 회차(회차에 귀속되지 않은 뒤늦은 run)는 **폴백 사유가 아니다**(D-1(2),
 * 제품 책임자 2026-09-10). 직전 published 회차를 그대로 내고, 관측 불리언만 실어 보낸다.
 */
export async function resolveGlobalSummaryRouteBase(
  rootProjectId: string | null | undefined,
  filters: StandardFilters,
  opts: SummaryRouteOptions = {},
): Promise<SummaryReadRoute> {
  const mode = opts.mode ?? "snapshot";
  if (!rootProjectId) return mirror("no-root");
  const bounds = periodBoundsReason(mode, filters);
  if (bounds) return mirror(bounds);
  const unsupported = unsupportedGlobalFilterReason(filters, mode, opts.cumulativeSnapshotOk);
  if (unsupported) return mirror(unsupported);
  // 웹사이트 표면과 같은 자리·같은 배치(위 주석 참조) — 축은 기간과 무관하게 확정하고,
  // 추이 격자는 기간 모드에서만 묻는다(웹사이트 분기의 같은 주석).
  const [enabled, ledger, anchorAxis, trendGrid] = await Promise.all([
    readEnabled(),
    summaryLedgerAvailable(),
    ensureAnchorAxis(),
    mode === "period" ? ensureTrendGrid() : Promise.resolve(false),
  ]);
  if (!enabled) return mirror("disabled");
  if (!ledger) return mirror("ledger-unavailable");

  const set = await resolveCycleSet({
    surface: "global",
    mode,
    projectIds: [rootProjectId],
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    anchorAxis,
    ...(trendGrid ? { trendGrid: true } : {}),
  });
  if (!set.ok) return mirror(set.reason);

  const openRuns = await hasOpenCycle(set.set.projectIds);
  return { path: "summary", ...set.set, openRuns };
}

// ── 합성(판정 + 화면) ───────────────────────────────────────────────────────
// server.ts 는 이 둘을 **따로** 쓴다: base 는 `{r,f}`/`{p,f}` 키로 캐시하고,
// 화면 검사는 그 밖에서 건다. 아래 합성은 그 정의를 한 곳에 못 박는 것이고,
// 테스트·스크립트처럼 캐시가 필요 없는 호출부가 쓴다.

/** 웹사이트(S4/S5/S6) — 화면까지 반영한 최종 판정. */
export async function resolveWebsiteSummaryRoute(
  projectIds: string[],
  filters: StandardFilters,
  screen: SummaryScreenKey,
  opts: SummaryRouteOptions = {},
): Promise<SummaryReadRoute> {
  return applyScreenGate(
    await resolveWebsiteSummaryRouteBase(projectIds, filters, opts),
    screen,
  );
}

/** 글로벌(S1/S2/S3) — 화면까지 반영한 최종 판정. */
export async function resolveGlobalSummaryRoute(
  rootProjectId: string | null | undefined,
  filters: StandardFilters,
  screen: SummaryScreenKey,
  opts: SummaryRouteOptions = {},
): Promise<SummaryReadRoute> {
  return applyScreenGate(
    await resolveGlobalSummaryRouteBase(rootProjectId, filters, opts),
    screen,
  );
}
