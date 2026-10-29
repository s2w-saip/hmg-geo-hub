import "server-only";
import { ANALYSIS_GAP_MAX } from "./analysis-gap";
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
//        (운영 결정 2026-09-06 — 케이던스가 멈춘 사이트의 7월 값이 섞였던 회귀).
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
//   운영 확정 D-2 (2) "E1 회차 수 상한 없음(느린 것 감수)". 상한 대신 회차 수를
//   관측 헤더에 노출한다(`hit … cycles:<n>`, `summaryRouteHeaderValue`).
//   그 자리를 (a′) `cycle-set-unavailable` 이 대신한다 — **판정 불가 = 폴백**(fail-closed).
//
//     cycle-set-unavailable    판정 자체가 불가(표 없음·DB 오류·프로브 실패)
//     unpublished-cycle-in-range  범위 안에 노출 불가 회차가 섞였다 → 합계에 구멍
//     duplicate-cycle-in-week     웹사이트: 같은 (project, cycle_week) 에 회차 둘 이상
//     missing-cycles-in-range     범위 안에 노출 가능 회차가 0개
//
//   ⚠️ **`status='open'` 은 구멍이 아니다.** 열린 회차는 "아직 안 채워진 최신 회차"이지
//      "빠진 과거 회차" 가 아니다 — D-1(2)(운영 2026-09-10)가 이미 "열린 회차 동안에는
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
//   가운데 항이 **V-2 뷰 앵커 게이트**다(운영 확정 2026-09-10). `view_anchor_at` 은 고객이
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
  /** UTC 일(YYYY-MM-DD). snapshot 은 "회차 하나로 떨어지는가" 판정에, period 는 범위에 쓴다. */
  dateFrom?: string | null;
  dateTo?: string | null;
}

const fail = (reason: CycleSetFallbackReason): CycleSetResult => ({ ok: false, reason });

const utcDay = (iso: string): string => iso.slice(0, 10);

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
 */
export function dateRangeReason(
  filters: { dateFrom?: string | null; dateTo?: string | null },
  cycles: SummaryCyclePick[],
): CycleSetFallbackReason | null {
  if (!filters.dateFrom && !filters.dateTo) return null;
  const days = new Set(cycles.map((c) => utcDay(c.cycleAnchorAt)));
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
): CycleSet {
  return {
    surface,
    mode,
    cycles,
    cycleKey: cycleKeyOf(cycles),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds,
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => utcDay(c.cycleAnchorAt))).size,
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
export function judgeCycleRange(
  surface: CycleSetSurface,
  requestedProjectIds: string[],
  rows: CycleRangeRow[],
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
  //                 시계열을 낸다 — 그 앵커는 점이 없다(운영 (3)의 귀결).
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
  const exempt = rows.filter((r) => r.hidden || isGeneratorSkipped(r));
  const skippedIds = new Set(exempt.map((r) => r.cycleId));
  const holes = rows.filter(
    (r) =>
      !r.renderable &&
      r.status !== "open" &&
      r.status !== "generating" &&
      !r.pending &&
      !skippedIds.has(r.cycleId),
  );
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
  const blocked = (r: CycleRangeRow): boolean => r.hidden && r.hiddenScope !== "citations";
  const usable = rows.filter((r) => r.renderable && r.generationId && !blocked(r));

  // ② 주 중복 — 웹사이트 전용(§6-1 규칙 1 은 함대 규칙이다). 글로벌은 한 주에
  //    anchor 가 둘이어도 서로 다른 측정 회차이므로 합산이 정당하다.
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
  }));
  const covered = new Set(cycles.map((c) => c.projectId));
  const missing = [...new Set(requestedProjectIds)].filter((id) => !covered.has(id));
  // 관측값은 **창에서 실제로 빠진 수**다. `citations` 회차는 면제이면서 집합에 들었으므로
  // 여기서 빼지 않으면 "cycles:13 / skipped:5" 처럼 같은 회차가 두 번 세어진다.
  const usableIds = new Set(usable.map((r) => r.cycleId));
  const skippedCount = exempt.filter((r) => !usableIds.has(r.cycleId)).length;
  return {
    ok: true,
    set: { ...toSet(surface, "period", cycles, missing), skippedCount },
  };
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

  if (req.mode === "period") {
    const rows = await pickCyclesInRange({
      surface: req.surface,
      projectIds: req.projectIds,
      dateFrom: req.dateFrom ?? null,
      dateTo: req.dateTo ?? null,
    });
    // 조회 실패·표 없음 = 판정 불가 → 폴백(§6-3 (a′)).
    if (rows === null) return fail("cycle-set-unavailable");
    return judgeCycleRange(req.surface, req.projectIds, rows);
  }

  // ── snapshot — 종전 선택 로직 그대로 ─────────────────────────────────────
  if (req.surface === "global") {
    const cycle = await pickGlobalCycle(req.projectIds[0] as string);
    if (!cycle) return fail("missing-cycle");
    const range = dateRangeReason(req, [cycle]);
    if (range) return fail(range);
    return { ok: true, set: toSet("global", "snapshot", [cycle], []) };
  }

  const picked = await pickWebsiteCycles(req.projectIds);
  if (!picked) return fail("missing-cycles");
  const range = dateRangeReason(req, picked.cycles);
  if (range) return fail(range);
  return {
    ok: true,
    set: toSet("website", "snapshot", picked.cycles, picked.missingProjectIds),
  };
}
