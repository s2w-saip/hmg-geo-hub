import "server-only";
import { ANALYSIS_GAP_MAX } from "./analysis-gap";
import { completionRatioFromUnits, slotIsIncomplete } from "./cycle-completion";
import { dropFleetLosers } from "@/lib/summary/fleet-visible";
import { isoDaySlice, kstDay } from "@/lib/period/day-arith";
import {
  pickWebsiteCycles,
  pickGlobalCycle,
  pickCyclesInRange,
  type SummaryCyclePick,
  type CycleRangeRow,
} from "@/lib/db/repositories/summary-cycles";


// ════════════════════════════════════════════════════════════════════════════
// 회차 집합 판정 — **단일 진입점** (PR② T9 · 플랜 §6-3)
// ════════════════════════════════════════════════════════════════════════════
//
// ── 계약 (T4 리더 코어가 소비한다) ─────────────────────────────────────────
//
//   resolveCycleSet(req: CycleSetRequest): Promise<CycleSetResult>
//
//     req  = { surface: "global"|"website", mode: "snapshot"|"period",
//              projectIds: string[], dateFrom?, dateTo? }
//     out  = { ok: true,  set: CycleSet }
//          | { ok: false, reason: CycleSetFallbackReason }
//
//   CycleSet = {
//     surface, mode,
//     cycles:            SummaryCyclePick[]  // (cycle_id, generation_id) 쌍이 얼려 있다
//     cycleKey:          string              // 캐시 키 조각(정렬·안정)
//     projectIds:        string[]            // 회차가 있는 프로젝트 = 이번 집합의 모수
//     missingProjectIds: string[]            // 회차가 없어 **제외된** 프로젝트(메우지 않는다)
//     weeks:             string[]            // distinct cycle_week — 파티션 프루닝용(정렬)
//     anchorCount:       number              // distinct UTC anchor 일 = "회차 수"(E1 관측값)
//   }
//
//   리더가 지켜야 할 것 셋:
//     ① 회차 술어는 **항상 (cycle_id, generation_id) 쌍**으로 건다. `summary_cycles` 를
//        다시 조인하지 마라 — generation 이 읽기 시점에 재해석되면 게이트가 판정한
//        회차와 조회가 읽는 회차가 갈라진다(`summary-website-aggregates.ts::cycleScope`).
//     ② `weeks` 는 파티션 키다. `dateArray()`(스칼라 펼침 `ARRAY[$1,$2]::date[]`)로만
//        바인딩한다 — `sql.param(배열)::date[]` 는 drizzle-orm/postgres-js 가 date/
//        timestamp/numeric 직렬화기를 항등함수로 덮어써 실 DB 에서 죽는다.
//        uuid[]·text[]·int[] 는 `sql.param` 배열이 안전하다.
//     ③ 모수는 `set.projectIds` 다. `missingProjectIds` 를 미러 값으로 메우지 마라
//        (제품 결정 2026-09-06 — 케이던스가 멈춘 사이트의 7월 값이 섞였던 회귀).
//
// ── 두 모드 ────────────────────────────────────────────────────────────────
//
//   snapshot — 화면이 **회차 1개**를 본다. 오늘의 전 화면이 이 모드다.
//              선택 로직은 종전 그대로(`pickGlobalCycle` / `pickWebsiteCycles`)이고,
//              기간이 걸려 있으면 그 기간이 회차 하나로 떨어지는지까지 본다.
//   period   — 화면이 **회차 집합**을 본다(누적 S2/S5 · 추이). 집계층이 회차 집합을
//              읽으므로 스냅샷도 원소 1개짜리 집합으로 환원되지만(플랜 §3-3 규칙 1),
//              **판정은 다르다** — 아래 폴백 사유가 period 에만 붙는다.
//
// ── 폴백 사유 (플랜 §6-3, D-2 확정 반영) ───────────────────────────────────
//
//   플랜 §6-3 은 사유 3종을 (a) `too-many-cycles`(회차 수 > N=6) (b) 비-published 혼입
//   (c) 주당 프로젝트 회차 1개 위반 으로 적었다. **(a) 는 구현하지 않는다** —
//   제품 확정 D-2 (2) "E1 회차 수 상한 없음(느린 것 감수)". 상한 대신 회차 수를
//   관측 헤더에 노출한다(`hit … cycles:<n>`, `summaryRouteHeaderValue`).
//   그 자리를 (a′) `cycle-set-unavailable` 이 대신한다 — **판정 불가 = 폴백**(fail-closed).
//
//     cycle-set-unavailable    판정 자체가 불가(표 없음·DB 오류·프로브 실패)
//     unpublished-cycle-in-range  범위 안에 노출 불가 회차가 섞였다 → 합계에 구멍
//     duplicate-cycle-in-week     웹사이트: 같은 (project, cycle_week) 에 회차 둘 이상
//     missing-cycles-in-range     범위 안에 노출 가능 회차가 0개
//
//   ⚠️ **`status='open'` 은 구멍이 아니다.** 열린 회차는 "아직 안 채워진 최신 회차"이지
//      "빠진 과거 회차" 가 아니다 — D-1(2)(제품 책임자 2026-09-10)가 이미 "열린 회차 동안에는
//      직전 published 회차를 그대로 낸다" 로 정했고, 그것을 폴백 사유로 삼으면 종전
//      `newer-runs` 와 똑같이 **상시 폴백**이 된다(루트 미귀속 run 상시 6,600+ 로 글로벌
//      대시보드가 항상 미러로 떨어졌던 2026-09-09 회귀). 관측은 `open-cycle` 꼬리표가 한다.
//
//   "노출 가능(published)" 의 코드상 정의는 `status` 문자열이 아니라
//   **`view_anchor_at IS NOT NULL AND view_anchor_at <= now()
//     AND active_generation_id IS NOT NULL`** 이다 — 종전 두 픽이 쓰는 술어와 같은 것을
//   쓴다(원장 상태와 조회 가능성이 갈리면 조회 가능성이 이긴다). 그래서 `stale`(뒤늦은
//   run 이 붙은 published)은 집합에 남는다.
//
//   가운데 항이 **V-2 뷰 앵커 게이트**다(제품 확정 2026-09-10). `view_anchor_at` 은 고객이
//   기대하는 **값이 보이는 날짜**이므로, 그날 전의 회차는 published 여도 서빙하지 않는다 —
//   스냅샷은 `pickGlobalCycle`/`pickWebsiteCycles` 가 **직전 published 회차**를 그대로 내고
//   (D-1(2) 와 같은 경로), 기간은 그 회차가 `renderable=false` 로 와서 §6-3 (b) 판정에 걸린다
//   (`status='open'` 이 아니면 구멍 → 폴백). 술어 정본은 `summary-cycles.ts::cycleViewableSql`
//   한 곳이고, 값을 찍는 곳은 스왑 tx 한 곳이다(V-1, `generate/swap.ts::publishCycleSql`).
//
// ── 이 파일이 하지 않는 것 ─────────────────────────────────────────────────
//   킬스위치·화면 allowlist·미지원 축 판정은 `gate.ts` 소관이다. 여기는 "어느 회차를
//   읽는가" 하나만 판정한다. 그래서 T4 리더가 게이트를 거치지 않고도(스크립트·패리티
//   하네스) 같은 회차 집합을 재현할 수 있다.

export type CycleSetSurface = "global" | "website";
export type CycleSetMode = "snapshot" | "period";

export type CycleSetFallbackReason =
  // 스냅샷 — 종전 문자열 그대로(헤더 어휘 호환).
  | "missing-cycle"
  | "missing-cycles"
  | "range-outside-cycle"
  | "range-multi-cycle"
  // 기간(신규, §6-3).
  | "cycle-set-unavailable"
  | "unpublished-cycle-in-range"
  | "duplicate-cycle-in-week"
  | "missing-cycles-in-range";

export interface CycleSet {
  surface: CycleSetSurface;
  mode: CycleSetMode;
  /** 고른 회차들. 조회는 항상 `(cycleId, generationId)` 쌍으로. */
  cycles: SummaryCyclePick[];
  /** 캐시 키 조각 — 정렬된 `cycleId:generationId` 목록. */
  cycleKey: string;
  /** 회차가 있는 프로젝트 = 이번 집합의 모수. */
  projectIds: string[];
  /** 회차가 없어 제외된 프로젝트(폴백으로 메우지 않는다). */
  missingProjectIds: string[];
  /** distinct `cycle_week`(UTC 월요일) — 세부층 파티션 프루닝용. */
  weeks: string[];
  /**
   * 창에서 **뺀** 미발행 확정 회차 수(F1) — 관측용. `hit` 인데 점이 기대보다 적으면
   * 이 수가 이유다. 판정에는 쓰이지 않는다.
   */
  skippedCount?: number;
  /**
   * **인용 계열에서만 빼야 할** 회차 id (0071 `hidden_scope='citations'`).
   *
   * 이 회차는 집합에 **남는다**: 언급 계열 값은 정상이기 때문이다(아래 ② 블록).
   * 그런데 인용은 깨져 있으므로, 인용·도메인 계열 집계가 이 회차를 합치면 고객이
   * "값이 틀렸다" 고 찍은 그 수치가 카드에 그대로 실린다. 미러 정본이 계열을 가르는
   * 것과 같은 규칙을 집계층에도 싣는다
   * (`scope-aggregates.ts::hiddenClause` 의 `family === "mention"` 분기).
   *
   * 소비 규약(리더가 지킨다):
   *   · 인용 계열 측정과 **그 분모**는 이 목록을 뺀 회차만 본다.
   *   · 언급 계열 측정과 그 분모는 집합 전체를 본다.
   * 정렬·중복 제거된 목록이고, **빌 때는 필드 자체를 싣지 않는다**: 캐시 키가
   * `JSON.stringify(set)` 이라, 없는 값을 `[]` 로 실으면 종전 셀이 통째로 갈린다.
   */
  citationExcludedCycleIds?: string[];
  /**
   * **인용 계열이 읽을 회차 목록**(2026-09-20 독립 검증 N3). 자리마다 계열별 대표가
   * 갈렸을 때만 실린다 — 언급 대표가 `citations` 숨김이라 인용이 그 자리에서 죽는
   * 경우다. `set.cycles` 의 부분집합이 아닐 수 있다(인용 대표가 언급 대표와 다른 회차).
   *
   * 소비는 `citationCyclesOf` 한 곳이고, 거기서 도메인 문장의 회차 스코프가 된다.
   * 비면 필드를 **싣지 않는다**(캐시 키 불변 — 이 파일의 관례).
   */
  citationCycles?: SummaryCyclePick[];
  /**
   * distinct UTC anchor **일** 수 = 관측용 "회차 수"(E1).
   * 웹사이트 함대 한 회차가 이틀에 걸쳐 측정되면 2로 세어질 수 있다 — 정확한 주 수는
   * `weeks.length` 다. 헤더가 노출하는 것은 이 값이다(D-2 (2)).
   */
  anchorCount: number;
}

export type CycleSetResult =
  | { ok: true; set: CycleSet }
  | { ok: false; reason: CycleSetFallbackReason };

export interface CycleSetRequest {
  surface: CycleSetSurface;
  mode: CycleSetMode;
  /** global = 루트 프로젝트 1개, website = 함대 프로젝트 집합. */
  projectIds: string[];
  /**
   * 일(YYYY-MM-DD). snapshot 은 "회차 하나로 떨어지는가" 판정에, period 는 범위에 쓴다.
   * 축에 따라 무엇의 일자인가가 다르다 — 종전 축은 앵커의 **UTC** 일자,
   * 앵커 축은 회차의 **귀속 날짜**(KST `round_date`).
   */
  dateFrom?: string | null;
  dateTo?: string | null;
  /**
   * 앵커 축(0077)으로 판정하는가. 기본 `false` = 종전(SQL·판정 모두 바이트 동일).
   * 판정은 `lib/period/anchor-axis-flag.ts::answerAnchorEnabled()` 하나이고, 호출부
   * (`gate.ts`)가 `ensureAnchorAxis()` 로 확정한 값을 내려보낸다.
   */
  anchorAxis?: boolean;
  /**
   * 추이 격자(`X.trendGrid`)로 읽는가 — 회차에 **완결성**(`completionRatio`)을 싣는다.
   * 기본 `false` = 종전(픽의 필드 구성이 바이트 동일 → 캐시 키 불변).
   * 판정 정본은 `lib/period/trend-grid-flag.ts::ensureTrendGrid()` 하나다.
   */
  trendGrid?: boolean;
}

const fail = (reason: CycleSetFallbackReason): CycleSetResult => ({ ok: false, reason });

// 앞 10자 = 그 날(파싱 아님) — 정본 `lib/period/day-arith.ts::isoDaySlice`.
const utcDay = (iso: string): string => isoDaySlice(iso);

// ── 앵커 축(0077) — 회차를 어느 날짜로 셀 것인가 ────────────────────────────
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §3 · 매핑 정본은
// `summary-cycles.ts` 의 `cycleRoundDate`(표 `scope_cycle_rounds`).
//
// 종전 축은 회차 앵커 시각의 **UTC 일자**로 센다. 앵커 축은 회차의 **귀속 날짜**
// (`round_date`, KST. 글로벌 = 월요일, 웹사이트 = 금요일)로 센다 — 달력에서 고른
// 날짜와 사실표가 고른 회차가 같은 값을 보게 하는 것이 이 전환의 목적이다.
//
// ⚠️ `roundDate` 가 안 실렸으면 **종전 축으로 접는다**. 반대로 접을 수단이 없다
//    (귀속 날짜를 여기서 재계산할 수 없다 — 매핑 표가 정본이다).
//
// ⚠️ `weeks`(파티션 프루닝 키)는 **건드리지 않는다.** 그것은 세부층 물리 파티션
//    (`cycle_week`)이지 화면 축이 아니다. 여기서 바꾸면 조회가 빈 파티션을 읽는다.

type CycleDayRow = { cycleAnchorAt: string; roundDate?: string | null };

/** 이 회차의 날짜 키. 앵커 축이고 `round_date` 가 실렸을 때만 귀속 날짜다. */
export function cycleDayOf(c: CycleDayRow, anchorAxis = false): string {
  return anchorAxis && c.roundDate ? c.roundDate : utcDay(c.cycleAnchorAt);
}

/** 앵커 시각의 **KST 일자** — `summary-cycles.ts::cycleRoundDate` 의 COALESCE 폴백과 같은 식. */
function anchorKstDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? kstDay(ms) : null;
}

/**
 * 회차 집합의 **측정 기준일(asOf)** — 집계층(원장) 경로의 단일 정본.
 *
 * 종전에는 네 자리(`summary-global-aggregates` 2곳 · `summary-website-aggregates`
 * 2곳)가 각각 `max(cycleAnchorAt)` → ISO 를 손으로 적고 있었고, 그래서 미러 경로가
 * 앵커 축으로 옮겨간 뒤 같은 필드(`StandardAggregates.asOf`)에 **두 형식·두 시계**가
 * 섞였다. 이 함수 하나로 모은다.
 *
 * ── 축 판정과 폴백 ─────────────────────────────────────────────────────────
 * 축은 인자로 받지 않는다 — `roundDate` 가 실려 있으면 그것이 곧 앵커 축이다
 * (`restrictToFleetVisible` 과 같은 관례).
 *   · **하나라도** `roundDate` 가 있으면 앵커 축 → `YYYY-MM-DD` 의 **사전식** 최대.
 *     ISO 8601 날짜는 사전식 = 시간순이라 `Date.parse` 를 거칠 이유가 없고, 거치면
 *     UTC 자정이 붙어 다시 ISO 로 돌아간다.
 *   · 그 집합 안에서 `roundDate` 가 **없는 회차**는 앵커 시각의 KST 일자로 참여한다.
 *     SQL(`cycleRoundDate` 의 `COALESCE(m.round_date, 앵커 KST 일자)`)이 내는 값과
 *     같아서, 섞인 입력에서도 형식이 하나로 유지되고 회차가 조용히 빠지지 않는다.
 *     (축이 켜지면 SQL 이 이미 COALESCE 로 채우므로 실제로는 안 생기는 조합이다 —
 *      정의를 비워 두면 섞인 입력에서 ISO 와 날짜가 비교되는 것이 문제라 못 박는다.)
 *   · `roundDate` 가 **하나도 없으면** 종전 그대로 앵커 시각 최대의 ISO. 축 off 에서
 *     값이 바뀌지 않는다.
 *
 * 종전 네 자리 중 셋은 `Math.max(...map(Date.parse))` 였고 하나(`asOfOf`)만 문자열
 * 최대 후 파싱이었다. 여기서는 **수치 최대**로 통일한다 — 파싱 불가 값이 섞이면
 * `Math.max` 가 NaN 으로 전파돼 `null` 이 되는 쪽이 보수적이고, 정상 입력(DB 가 낸
 * ISO)에서는 두 방식의 결과가 같다.
 */
export function cycleSetAsOf(cycles: readonly CycleDayRow[]): string | null {
  if (cycles.length === 0) return null;
  if (cycles.some((c) => Boolean(c.roundDate))) {
    const days = cycles
      .map((c) => c.roundDate || anchorKstDay(c.cycleAnchorAt))
      .filter((d): d is string => Boolean(d));
    if (days.length === 0) return null;
    return days.reduce((a, b) => (a > b ? a : b));
  }
  const ms = Math.max(...cycles.map((c) => Date.parse(c.cycleAnchorAt)));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

const cycleKeyOf = (cycles: SummaryCyclePick[]): string =>
  cycles
    .map((c) => `${c.cycleId}:${c.generationId}`)
    .sort()
    .join(",");

/**
 * 기간이 "회차 하나" 로 떨어지는가(§6-1 규칙 2, **스냅샷 표면 전용**).
 * - 기간 미지정 → 최신 회차 1개(집합) = OK.
 * - 기간 지정 → 회차 anchor 가 전부 그 기간 안이고, 서로 다른 anchor 날짜가 1개.
 *
 * period 모드는 이 판정을 **하지 않는다** — 회차가 여럿인 것이 그 모드의 정의다.
 *
 * 앵커 축에서는 "정확히 하나" 를 **귀속 날짜**(`round_date`)로 센다. 한 `round_date` 에
 * 회차가 둘 합쳐진 자리(`basis='merged'`)는 **한 회차**다 — 고객이 달력에서 고른 것이
 * 그 날짜 하나이기 때문이고, 그것을 둘로 세면 스냅샷 화면이 이유 없이 폴백한다.
 */
export function dateRangeReason(
  filters: { dateFrom?: string | null; dateTo?: string | null },
  cycles: SummaryCyclePick[],
  opts: { anchorAxis?: boolean } = {},
): CycleSetFallbackReason | null {
  if (!filters.dateFrom && !filters.dateTo) return null;
  const days = new Set(cycles.map((c) => cycleDayOf(c, opts.anchorAxis)));
  for (const day of days) {
    if (filters.dateFrom && day < filters.dateFrom) return "range-outside-cycle";
    if (filters.dateTo && day > filters.dateTo) return "range-outside-cycle";
  }
  return days.size === 1 ? null : "range-multi-cycle";
}

/** 회차 목록 → 집합(파생값 계산). 판정이 끝난 뒤에만 부른다. */
function toSet(
  surface: CycleSetSurface,
  mode: CycleSetMode,
  cycles: SummaryCyclePick[],
  missingProjectIds: string[],
  anchorAxis = false,
): CycleSet {
  return {
    surface,
    mode,
    cycles,
    cycleKey: cycleKeyOf(cycles),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds,
    // ⚠️ 파티션 키는 축과 무관하게 `cycle_week` 다(머리 주석의 두 번째 ⚠️).
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    // 앵커 축에서는 **귀속 날짜** 단위 — 합쳐진 자리는 한 회차로 센다.
    anchorCount: new Set(cycles.map((c) => cycleDayOf(c, anchorAxis))).size,
  };
}

/**
 * 범위 조회 결과 → 집합 또는 폴백 사유. **순수 함수**(테스트가 여기부터 본다).
 *
 * 판정 순서는 플랜 §6-3 의 (b) → (c) 순이고, 빈 집합이 맨 뒤다:
 *   ① 구멍(비-published 혼입) — 합계가 조용히 틀린다. 가장 위험하므로 먼저 잡는다.
 *   ② 주 중복(웹사이트 §6-1 규칙 1) — 같은 사이트가 한 주에 두 번 세어진다.
 *   ③ 빈 집합 — 읽을 것이 없다.
 * 순서가 겹칠 때 어느 쪽이 이기는지는 **로그 문자열만** 바꾼다(셋 다 폴백).
 */
/**
 * 범위 조회 결과의 **분류**: 판정과 관측이 같은 술어를 쓰게 하는 단일 정의.
 *
 * `judgeCycleRange` 가 이것을 쓰고, 진단 하네스(`scripts/summary/probe-period-gate.ts`)도
 * 이것을 쓴다. 종전에 하네스가 술어를 손으로 베껴 두 벌이 갈렸다(2026-09-18 F5:
 * 하네스의 `skipped` 에 `hidden` 이 빠져 있어 숨긴 회차를 **구멍으로** 셌다.
 * 판정은 폴백이 아닌데 하네스는 "구멍 1" 을 찍는 상태였다).
 */
export interface CycleRangeBreakdown {
  /** 구멍 계산에서 **면제**되는 회차(숨김 + 생성기 미선택). 범위 무관. */
  exempt: CycleRangeRow[];
  /** 진짜 구멍: 하나라도 있으면 폴백이다. */
  holes: CycleRangeRow[];
  /** 집합에 들어가는 회차(숨김 중 `citations` 스코프는 남는다). */
  usable: CycleRangeRow[];
}

export function classifyCycleRange(rows: CycleRangeRow[]): CycleRangeBreakdown {
  const exempt = rows.filter((r) => r.hidden || isGeneratorSkipped(r));
  const exemptIds = new Set(exempt.map((r) => r.cycleId));
  const holes = rows.filter(
    (r) =>
      !r.renderable &&
      r.status !== "open" &&
      r.status !== "generating" &&
      !r.pending &&
      !exemptIds.has(r.cycleId),
  );
  const blocked = (r: CycleRangeRow): boolean => r.hidden && r.hiddenScope !== "citations";
  const usable = rows.filter((r) => r.renderable && r.generationId && !blocked(r));
  return { exempt, holes, usable };
}

export function judgeCycleRange(
  surface: CycleSetSurface,
  requestedProjectIds: string[],
  rows: CycleRangeRow[],
  // 앵커 축(0077) — 파생값(`anchorCount`)의 날짜 단위만 바뀐다. **판정(구멍·주 중복·빈
  // 집합)은 그대로**다: 구멍은 생성 상태의 명제이고, 주 중복은 세부층 파티션(`cycle_week`)
  // 의 제약이라 둘 다 화면 축과 무관하다.
  //
  // 추이 격자(`trendGrid`)도 **판정을 바꾸지 않는다** — 픽에 완결성을 한 칸 더 실을
  // 뿐이고, 그 값으로 자리를 거르는 것은 추이 경로 한 곳이다
  // (`restrictToCompleteCycles`, `restrictToFleetVisible` 과 같은 자리·같은 이유).
  opts: { anchorAxis?: boolean; trendGrid?: boolean } = {},
): CycleSetResult {
  // ① 구멍 — **구멍이 아닌 것 다섯 가지를 먼저 뺀다**(F1 넷 + 0070 숨김).
  //
  //   · `open`      아직 안 닫힌 최신 회차. "빠진 과거 회차" 가 아니다.
  //   · `pending`   V-2 금족 — 생성·published 는 끝났고 노출일만 안 됐다.
  //   · `generating` 지금 재생성 중. 스왑 전까지 `active_generation_id` 가 잠시 비어
  //                 보일 수 있는데(F4), 그 순간을 구멍으로 세면 재생성 때마다 전 화면이
  //                 플랩한다. 곧 돌아올 회차이므로 `open` 과 같은 취급이다.
  //   · **skipped** `closed` 인데 분석 갭이 `ANALYSIS_GAP_MAX` 를 넘어 생성기가
  //                 `--pending` 에서 **영원히 안 뽑는** 회차. scope 분석 백필이 오기
  //                 전에는 미발행이 확정돼 있다 — 이것을 구멍으로 세면 기간 조회가
  //                 그 회차 때문에 **영구히** 폴백한다(2026-09-11 실측: 91일 창 안
  //                 글로벌 5회차 7/07·7/11·7/19·7/24·8/25). 창에서 **빼고** 나머지로
  //                 시계열을 낸다 — 그 앵커는 점이 없다(제품 책임자 (3)의 귀결).
  //
  // ⚠️ `analysisGapRatio` 가 `null` 이면 갭을 **모르는** 것이므로 skipped 로 보지 않는다.
  //    모르면 보수적으로 구멍이다(fail-closed) — 폴백은 느릴 뿐이고 잘못 읽는 것은 틀린다.
  //   · **hidden** 원장 숨김(0070). `renderable` 은 **true 일 수 있다** — 생성도 발행도
  //                 끝난 정상 회차인데 사람이 "이 회차는 값이 틀렸다" 고 찍은 것이다.
  //                 그래서 위 넷과 달리 `!renderable` 조건 밖에서 따로 뺀다.
  //                 구멍으로 세면 숨기는 순간 그 창이 통째로 미러로 떨어져 **숨김이
  //                 되살리려던 골짜기를 그대로 되살린다**(목적과 정반대).
  //
  // ⚠️ **면제(exempt)와 배제(blocked)는 다른 명제다**(D2 A1, 2026-09-11). 종전에는
  //    `hidden` 하나가 둘 다를 뜻했는데, 0071 `hidden_scope='citations'` 회차는
  //    **면제이면서 배제가 아니다** — 언급 4 KPI 는 실값을 실어야 하고 인용만 갭이다.
  //    그래서 아래를 둘로 가른다. 면제는 **범위 무관**(citations 회차가 미생성 상태로
  //    창에 들어와도 폴백을 만들면 안 된다), 배제는 `all` 일 때만.
  const { exempt, holes, usable } = classifyCycleRange(rows);
  if (holes.length > 0) return fail("unpublished-cycle-in-range");

  // 숨긴 회차는 `renderable` 이어도 집합에 넣지 않는다 — 넣으면 합계에 그 회차가 든다.
  // **단 `hidden_scope='citations'` 는 예외**다: 그 회차의 언급 계열은 정상이므로 집합에
  // 넣고, 인용 계열만 `trend-gaps.ts::withTrendGapBuckets` 의 회차 축 마킹이 갭으로 덮는다.
  //
  // 판정을 `=== "all"` 이 아니라 `!== "citations"` 로 쓰는 이유(스펙 권장안과 다른 점):
  // `CycleRangeRow` 를 만드는 자리 중 `**/*.test.ts`·`scripts/**` 는 tsconfig `exclude`
  // 라 **컴파일 에러가 안 난다** — 거기서 `hiddenScope` 가 빠지면 런타임에 `undefined` 가
  // 온다. `=== "all"` 이면 그때 숨긴 회차가 **조용히 집합에 들어간다**(위험한 방향).
  // `!== "citations"` 는 모르는 값을 전부 배제로 접어 0071 이전 동작으로 폴백한다.
  // ② 주 중복 — 웹사이트 전용(§6-1 규칙 1 은 함대 규칙이다). 글로벌은 한 주에
  //    anchor 가 둘이어도 서로 다른 측정 회차이므로 **합산(누적)이 정당하다.**
  //    ⚠️ 합산이 정당한 것과 **점을 둘 찍는 것**은 다른 명제다 — 추이는 회차마다 점을
  //       찍으므로 결손·부분 회차가 단독 점이 된다(2026-09-18 제품 결정). 그쪽은
  //       `restrictToFleetVisible` 이 추이 경로에서만 거른다. 여기는 그대로 둔다.
  if (surface === "website") {
    const seen = new Set<string>();
    for (const r of usable) {
      const k = `${r.projectId}|${r.cycleWeek}`;
      if (seen.has(k)) return fail("duplicate-cycle-in-week");
      seen.add(k);
    }
  }

  // ③ 빈 집합.
  if (usable.length === 0) return fail("missing-cycles-in-range");

  const cycles: SummaryCyclePick[] = usable.map((r) => ({
    cycleId: r.cycleId,
    generationId: r.generationId as string,
    projectId: r.projectId,
    cycleAnchorAt: r.cycleAnchorAt,
    cycleWeek: r.cycleWeek,
    // 판정에는 안 쓴다 — 싣고만 간다. 쓰는 곳은 추이 경로 하나뿐(`restrictToFleetVisible`).
    fleetVisible: r.fleetVisible,
    // 앵커 축의 날짜 키. 안 실렸으면 필드를 만들지 않는다(캐시 키가 이유 없이 갈린다).
    ...(r.roundDate ? { roundDate: r.roundDate } : {}),
    // 완결성도 같은 규칙이다 — 격자가 꺼져 있으면 **필드 자체가 없다**. 값은 원장
    // 카운터에서 되계산한다(정의 동치의 근거는 `cycle-completion.ts` 머리 주석).
    ...(opts.trendGrid
      ? { completionRatio: completionRatioFromUnits(r.expectedUnits, r.completedUnits) }
      : {}),
  }));
  const covered = new Set(cycles.map((c) => c.projectId));
  const missing = [...new Set(requestedProjectIds)].filter((id) => !covered.has(id));
  // 관측값은 **창에서 실제로 빠진 수**다. `citations` 회차는 면제이면서 집합에 들었으므로
  // 여기서 빼지 않으면 "cycles:13 / skipped:5" 처럼 같은 회차가 두 번 세어진다.
  const usableIds = new Set(usable.map((r) => r.cycleId));
  const skippedCount = exempt.filter((r) => !usableIds.has(r.cycleId)).length;
  // 인용만 깨진 회차(0071). 집합에는 남지만 인용 계열 합산에서는 빠진다
  // (`CycleSet.citationExcludedCycleIds` 머리 주석의 소비 규약).
  const citationExcluded = [
    ...new Set(usable.filter(citationOnlyHidden).map((r) => r.cycleId)),
  ].sort();
  return {
    ok: true,
    set: {
      ...toSet(surface, "period", cycles, missing, opts.anchorAxis),
      skippedCount,
      // 빈 배열을 싣지 않는다: 캐시 키가 이유 없이 갈린다.
      ...(citationExcluded.length ? { citationExcludedCycleIds: citationExcluded } : {}),
    },
  };
}

// ── 추이 전용: 한 주 두 회차 중 **대표만** (2026-09-18, 제품 확정) ──────────
//
// 글로벌 원장에는 같은 `cycle_week` 에 회차가 둘인 주가 있다. 재측정·앵커 보정으로
// 열린 두 번째 회차는 **모수가 훨씬 작다**(프로덕션 실측 2026-09-18, surface='global'
// · published · active generation · 노출 중):
//
//   주 2026-08-03 : 08-04 3,505유닛(대표) / 08-09   634유닛  ← 노출률 79.6 vs 78.1
//   주 2026-08-10 : 08-11 5,893유닛(대표) / 08-12 2,440유닛  ← 85.9 vs 82.6
//   주 2026-08-17 : 08-18 9,068유닛(대표) / 08-19   906유닛  ← 76.1 vs **87.0**
//
// 마지막 줄이 이 결정의 이유다 — 906유닛(KR 편중)짜리 결손 회차가 "2026-08-19 87.0%"
// 라는 **단독 점**으로 화면에 서서, 같은 주를 미러 주 격자로 접는 Mention 탭 추이와
// 갈렸다. 합산(누적)이 정당하다고 해서 **점을 둘 찍는 것**까지 정당한 것은 아니다.
//
// 대표 판정은 새로 만들지 않는다 — 관제 5단계(`summary-cycles.ts::cycleFleetSql`)가
// 이미 `(표면, 프로젝트, 주)` 마다 `fleet_visible` 을 하나만 참으로 두고 매 실행
// 재계산한다. 읽기는 그 값을 **소비만** 한다(판정 두 벌 금지).
//
// ⚠️ 거는 자리가 술어(`pickCyclesInRange` 의 `WHERE`)가 아니라 **집합 사후 필터**인 것이
//    핵심이다. 술어로 올리면 같은 조회를 쓰는 누적(S2/S5 계열)·구멍 판정까지 바뀐다 —
//    누적은 한 주 두 회차를 더하는 것이 맞고, 구멍 판정은 패자 회차까지 봐야 정확하다.
//
// 규칙 본체(대표가 있으면 패자를 빼고, 없으면 통째로 남긴다)는 `lib/summary/fleet-visible.ts`
// 한 곳이다 — 스냅샷 픽·회차 사슬 감시가 **같은 함수**를 쓴다(규칙 두 벌 금지).

/** 그룹 = 관제 5단계의 파티션에서 표면을 뺀 것(`(프로젝트, 주)`). */
export const fleetGroupOf = (c: SummaryCyclePick): string => `${c.projectId}|${c.cycleWeek}`;

/**
 * 집합을 다시 셀 때 **함께 날라야 하는 계열 필드**를 한 곳에서 만든다.
 *
 * ── 왜 헬퍼인가 (2026-09-20 독립 검증 차단 1) ──────────────────────────────
 *
 * `restrictToFleetVisible` 이 이 두 필드를 떨어뜨리고 있었다. 그리고 그 함수는
 * `restrictToTrendSlotSet` 의 **맨 앞**이라, 창 안 어느 주에든 함대 패자가 하나라도
 * 있으면 뒤따르는 `restrictToSlotRepresentative` 가 보는 인용 숨김 목록이 **빈 집합**이
 * 됐다. 실행으로 반증된 증상: 같은 08-24 자리인데 **카드 창(자리 하나)은 정상 회차를,
 * 추이 창(13주)은 인용 숨김 회차를** 대표로 골랐다 — 창 폭이 대표를 바꾼 것이다.
 *
 * 세 restrict* 가 각자 스프레드를 적으면 또 하나가 빠진다. 그래서 "집합을 다시 세우는
 * 자리" 전부가 이 함수를 지나가게 한다.
 *
 * 규칙은 기존 두 함수가 쓰던 것과 같다: **살아남은 회차로 좁히고, 비면 필드를 안 싣는다**
 * (빈 배열도 캐시 키를 바꾼다 — 이 파일의 관례).
 */
function carriedFamilyFields(
  set: CycleSet,
  keptIds: Set<string>,
  /** 인용 대표 목록을 좁히는 술어. 생략하면 목록을 **그대로** 나른다. */
  keepCitation?: (c: SummaryCyclePick) => boolean,
): Pick<CycleSet, "skippedCount" | "citationExcludedCycleIds" | "citationCycles"> {
  const excluded = (set.citationExcludedCycleIds ?? []).filter((id) => keptIds.has(id));
  const citation = set.citationCycles
    ? keepCitation
      ? set.citationCycles.filter(keepCitation)
      : set.citationCycles
    : undefined;
  return {
    ...(set.skippedCount === undefined ? {} : { skippedCount: set.skippedCount }),
    ...(excluded.length ? { citationExcludedCycleIds: excluded } : {}),
    ...(citation?.length ? { citationCycles: citation } : {}),
  };
}

/**
 * 추이 점이 될 회차만 남긴다 — 같은 `(프로젝트, 주)` 에 대표가 있으면 패자를 뺀다.
 * **순수 함수**이고, 부르는 곳은 자리 규칙 한 벌(`restrictToTrendSlotSet`)이다.
 * 남기기·모르는 값의 방향은 `dropFleetLosers` 머리 주석이 정본이다.
 *
 * 파생값(`cycleKey`·`weeks`·`anchorCount`·`projectIds`)은 **거른 뒤 집합**으로 다시
 * 계산한다 — 캐시 키·회차 하한(`G_TREND_MIN_CYCLES`)·접기 존재 검사가 전부 이 값을
 * 보기 때문에, 하나라도 옛 집합 기준이면 "읽는 회차와 판정한 회차" 가 갈린다.
 * 뺀 것이 없으면 **입력 객체를 그대로** 돌려준다(캐시 키가 이유 없이 바뀌지 않게).
 *
 * ⚠️ 계열 필드(`citationExcludedCycleIds`·`citationCycles`)도 **함께 나른다**
 * (`carriedFamilyFields` 머리 주석 — 떨어뜨리면 창 폭이 자리 대표를 바꾼다).
 */
export function restrictToFleetVisible(set: CycleSet): CycleSet {
  const kept = dropFleetLosers(set.cycles, fleetGroupOf, (c) => c.fleetVisible);
  if (kept.length === set.cycles.length) return set;
  // 축은 인자로 받지 않는다 — 회차에 `roundDate` 가 실려 있으면 그것이 곧 앵커 축이다
  // (실리는 경로가 축이 켜진 조회뿐이다). 그래야 재계산된 `anchorCount` 가 원래 집합과
  // 같은 단위를 유지한다.
  const anchorAxis = kept.some((c) => Boolean(c.roundDate));
  const keptIds = new Set(kept.map((c) => c.cycleId));
  return {
    ...toSet(set.surface, set.mode, [...kept], set.missingProjectIds, anchorAxis),
    // 인용 대표도 **함대 패자면 같이 뺀다** — 그 회차는 화면에 설 수 없는 회차다.
    ...carriedFamilyFields(set, keptIds, (c) => c.fleetVisible !== false),
  };
}

// ── 추이 전용: 완결성이 낮은 **자리**를 값에서 빼고 갭으로 (설계 §4-A) ──────
//
// 게이트(`in_full_cycle`)를 추이에서 빼면 부분 측정된 회차의 값이 실값처럼 나간다.
// 설계 D2 = A 의 뒷문장이 그 자리를 **갭**으로 내라고 정한다. 여기가 ① "값을 뺀다"
// 이고, ② "자리를 남긴다" 는 `trend-gaps.ts::insertCompletionGapBuckets` 다 — 숨김
// 회차(0070)가 이미 쓰는 두 단계와 **같은 구조**다(`trend-gaps.ts` 머리 주석).
//
// ⚠️ 거는 자리가 술어가 아니라 **집합 사후 필터**인 것은 `restrictToFleetVisible` 과
//    같은 이유다: 술어로 올리면 같은 조회를 쓰는 누적(S2/S5)·구멍 판정까지 바뀐다.

/** 자리 키 → 그 자리 회차들. 앵커 축 여부는 `roundDate` 유무가 말한다(이 파일의 관례). */
function slotsOf(cycles: readonly SummaryCyclePick[]): Map<string, SummaryCyclePick[]> {
  const anchorAxis = cycles.some((c) => Boolean(c.roundDate));
  const out = new Map<string, SummaryCyclePick[]>();
  for (const c of cycles) {
    const k = cycleDayOf(c, anchorAxis);
    const list = out.get(k) ?? [];
    list.push(c);
    out.set(k, list);
  }
  return out;
}

/**
 * 자리 **그룹** — 대표를 고르는 단위. 글로벌은 프로젝트가 하나라 자리(날짜)가 곧 그룹이고,
 * 함대(website)는 **(프로젝트, 자리)** 가 그룹이다.
 *
 * ⚠️ 함대에서 날짜만으로 묶으면 그 자리의 **사이트 수십 개가 회차 하나로 접힌다** —
 *    값이 틀리는 방향이라 `perProject` 없이는 함대에 걸면 안 된다. 그래서 기본값은
 *    날짜 하나이고(= 글로벌 종전 동작, 바이트 동일), 함대 호출부만 명시한다.
 *
 * 관측용 자리 키(`mergedSlots`·`familySplitSlots`)는 **언제나 날짜**다 — 그것이 화면의
 * x 축 키이기 때문이다.
 */
function slotGroupsOf(
  cycles: readonly SummaryCyclePick[],
  perProject: boolean,
): Map<string, { day: string; cycles: SummaryCyclePick[] }> {
  if (!perProject) {
    const out = new Map<string, { day: string; cycles: SummaryCyclePick[] }>();
    for (const [day, list] of slotsOf(cycles)) out.set(day, { day, cycles: list });
    return out;
  }
  const anchorAxis = cycles.some((c) => Boolean(c.roundDate));
  const out = new Map<string, { day: string; cycles: SummaryCyclePick[] }>();
  for (const c of cycles) {
    const day = cycleDayOf(c, anchorAxis);
    // `\u0000` 는 프로젝트 id·날짜 어디에도 안 나오는 구분자다.
    const k = `${c.projectId}\u0000${day}`;
    const g = out.get(k) ?? { day, cycles: [] };
    g.cycles.push(c);
    out.set(k, g);
  }
  return out;
}

/**
 * 완결성이 임계 미만인 **자리**의 회차를 통째로 뺀다.
 *
 * 반환의 `gapDays` 는 뺀 자리의 키(= 추이 버킷 키)다 — 호출부가 그 자리에 갭 슬롯을
 * 끼운다. **한 회차만 빼고 자리를 남기는 일은 없다**: 자리가 판정 단위이기 때문이고,
 * 그래야 남은 값이 "그 자리의 일부" 가 되는 일이 없다.
 *
 * 격자가 꺼져 있으면(= 어느 픽에도 `completionRatio` 필드가 없으면) **입력 객체를
 * 그대로** 돌려준다. 파생값 재계산도 없으므로 캐시 키가 한 글자도 안 바뀐다.
 */
export function restrictToCompleteCycles(
  set: CycleSet,
): { set: CycleSet; gapDays: string[] } {
  if (!set.cycles.some((c) => c.completionRatio !== undefined)) return { set, gapDays: [] };
  const slots = slotsOf(set.cycles);
  const gapDays: string[] = [];
  for (const [day, cycles] of slots) {
    if (slotIsIncomplete(cycles.map((c) => c.completionRatio))) gapDays.push(day);
  }
  if (gapDays.length === 0) return { set, gapDays: [] };
  const drop = new Set(gapDays);
  const anchorAxis = set.cycles.some((c) => Boolean(c.roundDate));
  const kept = set.cycles.filter((c) => !drop.has(cycleDayOf(c, anchorAxis)));
  const keptIds = new Set(kept.map((c) => c.cycleId));
  // 인용 제외 목록도 함께 좁힌다 — 뺀 회차의 id 가 남아 있으면 리더의 FILTER 가
  // 없는 회차를 빼려 하고, 그 조각이 문장 텍스트에 그대로 실린다. 비면 **필드를
  // 싣지 않는다**(빈 배열도 캐시 키를 바꾼다 — `judgeCycleRange` 와 같은 규칙).
  // ⚠️ **계열별 대표 목록도 함께 나른다**(2026-09-20 독립 검증 M1). 안 나르면 창에
  //    완결성 갭이 **하나라도** 있는 순간 `citationCycles` 가 소멸해 N3 수리가 통째로
  //    사라진다(로그는 `family-split:` 이라 말하는데 `citationCyclesOf` 는 `[]` 를 낸다
  //    = 그 자리 인용 회차 0). 파이프라인이 대표 → 완결성 순서라 이 함수가 뒤에 온다.
  //
  //    **규칙: 완결성으로 빠지는 자리는 인용 대표도 같이 뺀다.** 그 자리는 화면에서
  //    갭이고(값 없음), 계열만 값을 내면 "언급은 음영인데 인용만 점이 있는" 자리가 된다.
  //    자리 판정이 계열보다 위라는 것이 `insertCompletionGapBuckets` 의 전제이기도 하다.
  //    필드 조립은 `carriedFamilyFields` 한 곳이다(세 restrict* 가 같은 규칙을 쓴다).
  return {
    // 파생값(`cycleKey`·`weeks`·`anchorCount`·`projectIds`)은 거른 뒤 집합으로 다시
    // 계산한다 — 캐시 키·회차 하한·접힘 존재 검사가 전부 이 값을 본다
    // (`restrictToFleetVisible` 과 같은 이유).
    set: {
      ...toSet(set.surface, set.mode, kept, set.missingProjectIds, anchorAxis),
      ...carriedFamilyFields(set, keptIds, (c) => !drop.has(cycleDayOf(c, anchorAxis))),
    },
    gapDays: gapDays.sort(),
  };
}

// ── 추이 전용: 한 자리에 회차가 둘이면 **대표 하나만** (설계 §6 D4, 리더 단 판본) ──
//
// 설계 D4 = A 의 정본은 "생성기가 자리 단위로 접는다"(PR③)이고, 그것이 오기 전까지
// 리더가 자리마다 회차를 **하나만** 고른다. 왜 지금 고르는가:
//
//   · 사실표 경로는 `toSeries` 의 `byDay` 가 자리 단위로 **합산**한다. 그래서 08-24
//     자리(앵커 08-18 정상 + 앵커 08-25 인용 숨김)에서 분모가 18,662 로 부푼다.
//   · 미러 경로는 자리 단위 `DISTINCT ON` 으로 **대표 1건**이라 9,652 다.
//   · 계약 §3 의 "회차 간 합산" 은 **기간 안에 자리가 여럿일 때**의 규칙이고, 한 자리
//     안의 규칙은 앵커 스펙 §9.2("정규 요일 한 자리 = 한 회차")다. 즉 **미러가 맞고
//     사실표가 이중 계상**이다(설계 §6 의 판정).
//
// 대표는 **늦은 앵커**다. 같은 자리에 합쳐지는 회차는 앞 회차의 재측정·보정이므로
// 뒤가 더 최신 상태를 말한다(앵커 스펙 §10.1 "합친 자리 노출일은 늦은 쪽을 따른다"와
// 같은 방향). 앵커가 같으면 `cycleId` 사전식 최대 — 값이 아니라 **결정성**을 위한 것이다.
//
// ⚠️ 이것은 **손실이 있는 규칙**이다(설계 §6 옵션 B의 단점): 대표 회차에 없는 셀은
//    빠진다. 무손실 판본은 생성기 fold 스코프 변경(PR③)이고, 그때 이 함수는 no-op 이
//    된다(자리마다 회차가 하나가 되므로). 그 전까지는 **두 화면이 같은 값**을 내는 쪽이
//    한쪽만 부푼 값을 내는 것보다 낫다.
//
// 격자가 꺼져 있으면(= 어느 픽에도 `completionRatio` 가 없으면) **입력 객체 그대로**다
// (`restrictToCompleteCycles` 와 같은 off 신호 — 캐시 키가 한 글자도 안 바뀐다).

/** 늦은 앵커 우선, 동률은 `cycleId` 사전식 최대. */
function laterPick(a: SummaryCyclePick, b: SummaryCyclePick): SummaryCyclePick {
  if (a.cycleAnchorAt !== b.cycleAnchorAt) return a.cycleAnchorAt > b.cycleAnchorAt ? a : b;
  return a.cycleId > b.cycleId ? a : b;
}

/**
 * 대표 후보를 **단계로 좁힌다**. 각 단계는 "후보가 남으면 그 안에서, 하나도 안 남으면
 * 이전 집합 그대로" 다 — 어느 단계도 자리를 비우지 않는다.
 */
function narrow(
  cycles: readonly SummaryCyclePick[],
  keep: (c: SummaryCyclePick) => boolean,
): readonly SummaryCyclePick[] {
  const kept = cycles.filter(keep);
  return kept.length ? kept : cycles;
}

/**
 * 자리마다 대표 회차 하나만 남긴다. 합친 자리의 키 목록을 함께 돌려준다(관측용).
 *
 * ── **숨김은 계열 안에서만 본다** (2026-09-20 독립 검증 차단 2 수리) ────────
 *
 * 경위가 두 겹이다.
 *
 * 초판은 늦은 앵커만 봤다. 08-24 자리가 그 규칙에서 깨졌다: 앵커 08-18(정상,
 * completed 9,068)과 앵커 08-25(`hidden_reason='collection_error'` ·
 * `hidden_scope='citations'`, completed 9,652) 중 **늦은 쪽인 숨김 회차**가 대표가 됐고,
 * 그러면 그 자리의 인용 계열이 통째로 죽었다. 그래서 "숨김이 아닌 회차가 대표" 를
 * 언급 사다리에 넣었다.
 *
 * **그 수리는 과했다.** `citationExcludedCycleIds` 는 **인용 계열 전용** 명제인데
 * (`judgeCycleRange` 의 `citationOnlyHidden` — `hidden_scope='citations'` 는 언급 값이
 * 정상인 회차다), 그것을 언급 대표의 키로 쓰면 목록을 싣는 것만으로 `set.cycles` 가
 * 바뀐다. 그 집합은 노출률·점유율·우호도·우선 노출도가 **전부** 쓰므로, 인용 하나를
 * 고치려다 언급 4 KPI 의 회차가 조용히 움직인다(검증자가 실행으로 반증:
 * 목록 없음 → 대표 `hid`, 목록 있음 → 대표 `ok`).
 *
 * 그리고 그 수리는 이제 **필요하지도 않다** — N3 가 인용 계열에 **자기 대표**
 * (`citationCycles`)를 준 뒤로, 언급 대표가 인용 숨김이어도 인용 계열은 옆의 멀쩡한
 * 회차를 고른다. 그래서 언급 사다리에서 숨김 키를 뺀다.
 *
 * 규칙(방침, 제품 책임자 2026-09-20): **`hidden_scope='citations'` 회차는 인용 계열에서만
 * 숨김이다.** 자리 대표는 계열마다 따로 선다 —
 *   · 언급 계열 = ⓪ 함대 노출 → ① 완결성 → ② 늦은 앵커 → ③ cycleId (숨김 무시)
 *   · 인용 계열 = 그 계열의 숨김을 먼저 빼고 같은 사다리(아래 N3 블록)
 * 8/24 자리(1045851c 숨김·앵커 08-25 / 2a4f2bb1 정상·앵커 08-18, 둘 다 fleet true)에서
 * 언급 대표는 **1045851c**(늦은 앵커), 인용 대표는 **2a4f2bb1** 이 된다.
 *
 * ⚠️ `hidden_scope='all'` 회차는 애초에 집합에 없다(`judgeCycleRange` 의 `blocked`).
 *    그래서 여기서 볼 숨김은 `citations` 하나뿐이다.
 *
 * ── **완결성이 숨김보다 먼저다** (2026-09-20 독립 검증 B2-c 수리) ───────────
 *
 * 검증이 실행으로 반증한 상태: 자리에 완주 회차(1.0)와 부분 회차(0.5)가 있을 때
 * `restrictToCompleteCycles` 는 **최대값**으로 판정해 갭이 아니라고 하고
 * (`cycle-completion.ts::slotIsIncomplete`), 대표는 늦은 앵커라 **0.5 회차**가 뽑혔다.
 * 즉 50%만 측정된 회차의 값이 실값으로 나간다 — `TREND_COMPLETION_MIN` 이 존재하는
 * 이유가 정확히 그 상태다.
 *
 * 그 전제를 깬 것은 이 함수다: 완결성 판정의 근거 주석이 "자리의 값은 합" 이었는데
 * 자리 값이 대표 하나가 됐다. 그래서 **완결성을 대표 선택의 첫 키**로 올린다. 그러면
 * 두 판정이 같은 회차를 본다:
 *   · 자리에 임계 통과 회차가 하나라도 있으면 → 대표도 통과 → 갭 아님(종전과 같은 결론)
 *   · 하나도 없으면 → 대표도 미달 → 그 자리는 갭(종전과 같은 결론)
 * 즉 **갭 판정 결과는 안 바뀌고**, 값만 통과한 회차에서 나온다.
 *
 * ⚠️ 검증자 제안은 "숨김 아님 → 완결성" 순서였다. **뒤집어 채택한다.** 둘이 충돌하는
 *    경우(비숨김이 미달 · 숨김이 통과)에 어느 쪽 손실이 큰가로 갈랐다:
 *      · 비숨김(미달)을 고르면 → 부분 측정값이 실값으로 나가거나, 완결성 판정이
 *        그 자리를 갭으로 지운다. **옆에 멀쩡한 값이 있는데** 지우는 것이다.
 *      · 숨김(통과)을 고르면 → 값은 맞고, 인용 계열만 그 자리에서 갭이 된다.
 *        그 사실은 갭 마커로 화면에 정직하게 표현된다.
 *    "틀린 값·없는 값" 보다 "맞는 값 + 계열 하나의 갭" 이 낫다. 실측상 이 충돌은
 *    오늘 발현하지 않는다(8.24 두 회차 완결성 0.9997·1.0 으로 둘 다 통과).
 *
 * ⚠️ 완결성을 **모르는**(`undefined`) 회차는 임계 통과로 본다 — `slotIsIncomplete` 의
 *    "모르면 갭이 아니다" 와 같은 방향이다(고객이 보던 과거를 지우지 않는다).
 */
export function restrictToSlotRepresentative(
  set: CycleSet,
  /**
   * `perProject` — 대표를 **(프로젝트, 자리)** 마다 고른다(함대 표면). 기본값 `false` 는
   * 자리(날짜) 하나가 그룹이라 글로벌에서 종전과 바이트 동일이다. `slotGroupsOf` 의 ⚠️ 참고.
   */
  opts: { perProject?: boolean } = {},
): { set: CycleSet; mergedSlots: string[]; familySplitSlots: string[] } {
  if (!set.cycles.some((c) => c.completionRatio !== undefined)) {
    return { set, mergedSlots: [], familySplitSlots: [] };
  }
  const hidden = new Set(set.citationExcludedCycleIds ?? []);
  const slots = slotGroupsOf(set.cycles, opts.perProject === true);
  const mergedSlots: string[] = [];
  const familySplitSlots: string[] = [];
  const kept: SummaryCyclePick[] = [];
  const citationKept: SummaryCyclePick[] = [];
  let split = false;
  for (const { day, cycles } of slots.values()) {
    if (cycles.length > 1 && !mergedSlots.includes(day)) mergedSlots.push(day);
    // 언급 사다리: ⓪ 함대 노출(`fleet_visible`) → ① 완결성 임계 통과 → ② 늦은 앵커
    //              → ③ cycleId. **인용 전용 숨김은 보지 않는다**(머리 주석의 차단 2).
    //
    // ── ⓪ 가 **맨 앞**인 이유 (2026-09-20, 카드 정합 수리) ────────────────────
    //
    // "함대 노출이 꺼진 회차는 글로벌 화면 값에 들어가면 안 된다"(제품 책임자 방침)는 순위가
    // 아니라 **절대 조건**이다. 종전에는 그 조건을 `restrictToFleetVisible` 하나가
    // 지켰는데, 그것은 **같은 (프로젝트, 주) 그룹에 대표가 창 안에 있을 때만** 작동한다
    // (`dropFleetLosers` 의 "패자만 있는 그룹은 남긴다" — 의도된 보수성).
    //
    // 기간이 좁으면 그 전제가 깨진다. 메인 실측 `time=2026-08-17..2026-08-17`:
    // 자리 08-17 에 걸리는 회차는 `608a1e7b`(주 08-10, fleet true)와
    // `a6902908`(주 08-17, fleet **false**) 둘인데, 후자의 그룹 대표 `2a4f2bb1` 는
    // 귀속 날짜가 08-24 라 **창 밖**이다 → 패자가 살아남고, ③ 늦은 앵커 규칙에서
    // 08-19 > 08-11 이라 **노출 꺼진 회차가 대표가 된다**. 추이는 창이 13주라 같은
    // 자리에서 `608a1e7b` 를 고르므로 두 화면이 갈린다.
    //
    // ⚠️ 자리의 회차가 **전부** 꺼져 있으면 `narrow` 가 그대로 남긴다 — `dropFleetLosers`
    //    의 보수성과 같은 방향이다(주 하나를 통째로 지우지 않는다).
    const visible = narrow(cycles, (c) => c.fleetVisible !== false);
    const complete = narrow(visible, (c) => !slotIsIncomplete([c.completionRatio]));
    const mention = complete.reduce(laterPick);
    kept.push(mention);
    // ── 인용 계열의 **자기 대표**(2026-09-20 독립 검증 N3) ──────────────────
    //
    // 언급 대표가 `citations` 숨김이면 인용 계열은 그 자리에서 회차가 0 이 된다 —
    // 옆에 인용이 멀쩡한 회차가 있어도 그렇다("완결성 먼저" 순서의 대가).
    // 그래서 인용 계열이 **자기 기준으로** 다시 고른다: 그 계열에서 숨김이 아닌 회차
    // 중 완결성 통과 → 늦은 앵커. 후보가 없으면(전부 숨김) 그 자리는 인용 갭이다.
    // ⓪(함대 노출)은 계열과 무관한 절대 조건이라 인용 대표에도 **먼저** 건다.
    const citVisible = cycles.filter((c) => !hidden.has(c.cycleId));
    const citation = citVisible.length
      ? narrow(
          narrow(citVisible, (c) => c.fleetVisible !== false),
          (c) => !slotIsIncomplete([c.completionRatio]),
        ).reduce(laterPick)
      : null;
    if (citation) citationKept.push(citation);
    if (citation?.cycleId !== mention.cycleId) {
      split = true;
      if (!familySplitSlots.includes(day)) familySplitSlots.push(day);
    }
  }
  if (mergedSlots.length === 0 && !split) return { set, mergedSlots: [], familySplitSlots: [] };
  const keptIds = new Set(kept.map((c) => c.cycleId));
  const anchorAxis = kept.some((c) => Boolean(c.roundDate));
  return {
    set: {
      // 파생값 재계산은 `restrictToCompleteCycles` 와 같은 이유다(캐시 키·회차 하한·
      // 접힘 존재 검사가 전부 이 값을 본다).
      ...toSet(set.surface, set.mode, kept, set.missingProjectIds, anchorAxis),
      // 계열 필드는 한 곳에서 만든다(`carriedFamilyFields`). 인용 대표 목록은 **계열이
      // 갈린 자리가 있을 때만** 새로 싣는다 — 없으면 캐시 키가 한 글자도 안 바뀐다.
      ...carriedFamilyFields(set, keptIds),
      ...(split ? { citationCycles: citationKept } : {}),
    },
    mergedSlots: mergedSlots.sort(),
    familySplitSlots: familySplitSlots.sort(),
  };
}

// ── 자리 규칙 **한 벌** — 추이와 카드가 같은 함수를 쓴다 (2026-09-20) ────────
//
// 종전에는 이 세 단계가 `server.ts::viaGlobalSeries` 안에만 인라인으로 있었다. 그래서
// **카드(`viaGlobalS1`)는 한 자리에 걸린 회차를 전부 합산**했고, 같은 화면의 추이는
// 대표 하나만 읽었다. 메인 실측(2026-09-20, 글로벌 `time=2026-08-17..2026-08-17`):
//
//   round_date 2026-08-17 자리의 회차 둘
//     608a1e7b  fleet_visible=true   cit(격자) 18,284 / cit(+in_full_cycle) 3,602
//     a6902908  fleet_visible=false  cit(격자) 14,637 / cit(+in_full_cycle) 14,107
//   카드 분모 = 3,602 + 14,107 = **17,709** (두 회차 합) → 인용 점유율 14.0%
//   같은 자리의 상세(미러, 대표 1회차) = 6.5%
//
// 즉 **함대 노출이 꺼진 회차가 카드 값에 들어가 있었다.** 규칙을 여기 한 곳에 두고
// 두 게이트가 같은 함수를 부르면 그 상태가 구조적으로 안 생긴다.
//
// ⚠️ 순서가 계약이다: 함대 대표 → 자리 대표 → 완결성. 근거는 각 함수의 머리 주석이고,
//    특히 자리 대표가 완결성보다 **먼저**여야 하는 이유는 `restrictToSlotRepresentative`
//    의 "완결성이 숨김보다 먼저다" 블록(2026-09-20 독립 검증 B2-c).

export interface TrendSlotRestriction {
  /** 세 단계를 통과한 집합. 거를 것이 없으면 **입력 객체 그대로**다(캐시 키 불변). */
  set: CycleSet;
  /** 완결성 미달로 값에서 뺀 자리 키 — 호출부가 그 자리에 갭 슬롯을 끼운다. */
  gapDays: string[];
  /** 회차가 둘 이상이었던 자리(관측). */
  mergedSlots: string[];
  /** 언급·인용 대표가 갈린 자리(관측). */
  familySplitSlots: string[];
  /** 함대 대표 거르기로 뺀 회차 수(관측). */
  fleetHidden: number;
  /** 자리 대표까지만 거친 시점의 회차 수 — `slot-merged:` 로그가 쓰는 값(관측). */
  repAnchorCount: number;
}

/**
 * 추이 자리 규칙 **단일 진입점**. 격자(`X.trendGrid`)가 꺼져 있으면 뒤 두 단계가
 * 입력 객체를 그대로 돌려주므로, 호출부는 그 판정(`trendGridApplied`)으로 자기 경로를
 * 게이트한다 — 첫 단계(함대 대표)만은 격자와 무관하게 동작하기 때문이다.
 */
export function restrictToTrendSlotSet(set: CycleSet): TrendSlotRestriction {
  const fleetSet: CycleSet = restrictToFleetVisible(set);
  const { set: repSet, mergedSlots, familySplitSlots } =
    restrictToSlotRepresentative(fleetSet);
  const { set: complete, gapDays } = restrictToCompleteCycles(repSet);
  return {
    set: complete,
    gapDays,
    mergedSlots,
    familySplitSlots,
    fleetHidden: set.cycles.length - fleetSet.cycles.length,
    repAnchorCount: repSet.anchorCount,
  };
}

/**
 * 이 집합이 **격자 판본으로 판정됐는가**. 신호는 완결성이 실렸는지 하나다
 * (`judgeCycleRange` 가 `opts.trendGrid` 일 때만 싣는다 = 이 파일의 관례).
 *
 * 카드 경로가 이 술어로 자기 거르기를 게이트한다 — 격자 키가 꺼져 있으면 카드의
 * 회차 집합·캐시 키·SQL 이 한 글자도 안 바뀐다.
 */
export function trendGridApplied(set: CycleSet): boolean {
  return set.cycles.some((c) => c.completionRatio !== undefined);
}

/**
 * 인용 계열만 갭인 회차인가: `blocked` 의 **여집합 중 숨김인 것**이다.
 *
 * `blocked`(집합에서 배제)와 나란히 둔다: 판정이 갈라지면 "집합에는 들었는데 인용에서
 * 빠지지 않은" 회차가 생기고, 그것이 정확히 이 수리가 없앤 결함이다.
 */
function citationOnlyHidden(r: CycleRangeRow): boolean {
  return r.hidden && r.hiddenScope === "citations";
}

/**
 * 인용 계열이 읽어도 되는 회차만: 리더가 부르는 단일 진입점.
 * 목록이 비어 있으면 **같은 배열을 그대로** 돌려준다(호출부가 동일성으로 무변경을 판정한다).
 */
export function citationCyclesOf(set: CycleSet): SummaryCyclePick[] {
  // 계열별 대표가 갈린 자리가 있으면 인용 계열은 **자기 목록**을 읽는다(N3).
  // 그 목록은 `set.cycles` 밖 회차를 담을 수 있다 — 도메인 문장은 자기 쌍 IN 을
  // 이 목록으로 만들므로(`citationScopeOf` → `cycleScope`) 멤버십이 필요 없다.
  if (set.citationCycles) return set.citationCycles;
  const excluded = set.citationExcludedCycleIds;
  if (!excluded?.length) return set.cycles;
  const drop = new Set(excluded);
  return set.cycles.filter((c) => !drop.has(c.cycleId));
}

/**
 * 생성기가 **영원히 안 뽑는** 회차인가 — 그러면 구멍이 아니라 미발행 확정이다.
 *
 * ── 정의: `--pending` 술어의 **정확한 3값 논리 여집합** ────────────────────
 *
 *   생성기(`scripts/summary/generate-cycle.ts --pending` · `generate/cycle.ts:288`):
 *     `status='closed' AND active_generation_id IS NULL AND analysis_gap_ratio <= $gapMax`
 *   읽기(여기):
 *     `status='closed' AND NOT (analysis_gap_ratio <= ANALYSIS_GAP_MAX)`
 *       = 갭 > 임계  **또는**  갭이 `NULL`
 *
 * SQL 의 `NULL <= 0.05` 는 참이 아니라 **UNKNOWN** 이고 `WHERE` 는 UNKNOWN 을 버린다 —
 * 즉 갭이 `NULL` 인 회차는 생성기가 **영원히 안 뽑는다**. 두 술어를 같은 상수·같은
 * 비교식으로 못 박아 "생성기가 못 뽑는 것" 과 "읽기가 구멍으로 안 세는 것" 을 한 명제로
 * 유지한다(`analysis-gap.ts` 가 상수 정본, `cycle-set.test.ts` 가 여집합 동치를 고정).
 *
 * ── 갭 `NULL` 의 방향을 뒤집은 이유 (2026-09-11) ───────────────────────────
 *
 * 초판은 "갭을 모르면 보수적으로 구멍"(fail-closed)이었다. 검증자도 그 자세를 정당하다고
 * 봤다. 그런데 **결과가 영구 미러**였다: 웹 창 안에 `closed` ∧ 갭 `NULL` ∧
 * `expected_units IS NULL` ∧ `completed_units IS NULL` 인 회차가 **36건**(앵커 7/20 1 ·
 * 8/17 1 · 8/18 10 · 8/19 24, run 1~8개씩·generation 없음) 실측됐다 — 관제가 카운터를
 * 한 번도 계산하지 않은 회차이고, 갭이 `NULL` 이라 생성기가 못 뽑으니 백필로도 안 풀린다.
 * 그 한 건만 있어도 웹 추이는 **영원히** 점화되지 않는다.
 *
 * 종전의 `completed_units = 0` 특례로는 못 잡았다(그 36건은 `0` 이 아니라 **`NULL`**).
 * 특례를 넓히는 대신 **여집합 하나로 통일**해 흡수한다 — 특례는 다음 형태의 유령을
 * 또 놓친다. 대가는 "갭을 아직 못 잰 회차"도 창에서 빠지는 것인데, 그 회차는 어차피
 * 생성기가 안 뽑아 데이터가 없으므로 창에 넣어 봐야 폴백밖에 못 만든다.
 */
export function isGeneratorSkipped(r: CycleRangeRow): boolean {
  if (r.renderable || r.status !== "closed") return false;
  // `NOT (gap <= MAX)` 을 JS 3VL 로 옮긴 것 — `null` 은 비교가 UNKNOWN 이라 NOT 도 참이다.
  return !generatorPicksGap(r.analysisGapRatio);
}

/**
 * `--pending` 술어의 갭 조각 — `analysis_gap_ratio <= $gapMax` 를 **SQL 과 같은 3VL** 로.
 * `null`(= SQL `NULL`)은 UNKNOWN → `WHERE` 가 버리므로 `false` 다.
 * 여집합 동치 테스트가 이 함수와 `isGeneratorSkipped` 를 나란히 놓고 본다.
 */
export function generatorPicksGap(gap: number | null): boolean {
  return gap != null && gap <= ANALYSIS_GAP_MAX;
}

/**
 * 회차 집합 판정 — 화면·리더가 부르는 단일 진입점.
 *
 * 실패 자세는 언제나 **폴백**이다(fail-closed). 회차를 모르면 사실표를 읽을 수 없고,
 * 잘못 읽는 것보다 느리게 읽는 것이 싸다(손실 비대칭).
 */
export async function resolveCycleSet(req: CycleSetRequest): Promise<CycleSetResult> {
  const emptyReason: CycleSetFallbackReason =
    req.surface === "global" ? "missing-cycle" : "missing-cycles";
  if (req.projectIds.length === 0) return fail(emptyReason);

  const anchorAxis = req.anchorAxis === true;

  if (req.mode === "period") {
    const rows = await pickCyclesInRange({
      surface: req.surface,
      projectIds: req.projectIds,
      dateFrom: req.dateFrom ?? null,
      dateTo: req.dateTo ?? null,
      // 꺼져 있으면 **인자 자체를 싣지 않는다** — 호출 모양까지 종전과 같아야
      // "끄면 바이트 동일"이 관측 가능한 성질로 남는다(호출 단언 테스트가 그것을 고정한다).
      ...(anchorAxis ? { anchorAxis: true } : {}),
    });
    // 조회 실패·표 없음 = 판정 불가 → 폴백(§6-3 (a′)).
    if (rows === null) return fail("cycle-set-unavailable");
    return judgeCycleRange(req.surface, req.projectIds, rows, {
      anchorAxis,
      // 꺼져 있으면 키 자체를 안 만든다 — `judgeCycleRange` 의 옵션 판정이
      // `opts.trendGrid` 진리값 하나뿐이라 동작은 같지만, 호출 모양을 축과 맞춘다.
      ...(req.trendGrid === true ? { trendGrid: true } : {}),
    });
  }

  // ── snapshot — 종전 선택 로직 그대로 ─────────────────────────────────────
  if (req.surface === "global") {
    const cycle = await pickGlobalCycle(
      req.projectIds[0] as string,
      ...(anchorAxis ? ([{ anchorAxis: true }] as const) : ([] as const)),
    );
    if (!cycle) return fail("missing-cycle");
    const range = dateRangeReason(req, [cycle], { anchorAxis });
    if (range) return fail(range);
    return { ok: true, set: toSet("global", "snapshot", [cycle], [], anchorAxis) };
  }

  const picked = await pickWebsiteCycles(
    req.projectIds,
    ...(anchorAxis ? ([{ anchorAxis: true }] as const) : ([] as const)),
  );
  if (!picked) return fail("missing-cycles");
  const range = dateRangeReason(req, picked.cycles, { anchorAxis });
  if (range) return fail(range);
  return {
    ok: true,
    set: toSet("website", "snapshot", picked.cycles, picked.missingProjectIds, anchorAxis),
  };
}
