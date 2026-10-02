import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { dayAfterSql, dayOfSql, dayStartSql } from "@/lib/period/sql-day";
import { cycleRoundDateSql, cycleRoundJoinSql } from "@/lib/period/anchor-axis";
import {
  answerCycleAnchorsAvailable,
  hiddenCycleColumnsAvailable,
  hiddenCycleScopeAvailable,
} from "@/lib/db/column-availability";
import { toAnchorSurface } from "@/lib/db/repositories/scope-answer-anchors";
import {
  regularRoundDateOf,
  weekMondayOf,
  type RegularRoundSurface,
} from "@/lib/kpi/period-compare-week";
import { budgetedMirrorDb, type AnswerSetBudget } from "@/lib/db/repositories/scope-aggregates";
import { cycleViewableSql } from "@/lib/db/repositories/summary-cycles";
import { trendWhere, type TrendReadScope } from "@/lib/db/repositories/summary-trend-aggregates";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import { mirrorHeavyBudget } from "@/lib/scope/kpi-tab-budget";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import {
  addDays,
  assertDay,
  type CompareFamily,
  type CompareLedger,
  type ComparePeriod,
  type CompareMeasure,
  type CompareMetricKey,
  type Day,
} from "@/lib/kpi/period-compare";

// ════════════════════════════════════════════════════════════════════════════
// 기간 비교 Δ — **구간 집계 읽기**. 문장 **2개**.
// ════════════════════════════════════════════════════════════════════════════
//
// 산식은 `lib/kpi/period-compare.ts`(순수)가 소유한다. 이 파일은 그 모듈이 먹을 입력을
// 읽어 온다. 계약은 design §15(인터페이스 고정)다.
//
//   ① **회차 원장 + 집합 해소**(`compareCycleRowsSql`) — `summary_cycles` 한 스캔.
//      구간 전체를 덮는 **하나의 날짜 범위**(`min(lo) ~ max(hi)`)를 읽고, 구간 배정은
//      JS 가 한다. 원장이 표면당 20~900행이라 집계를 SQL 로 내릴 이유가 없다.
//      같은 행이 ②가 읽을 **회차 집합**(cycle_id, generation_id)도 만든다.
//   ② **구간 합계**(`compareTotalsSql`) — `summary_trend_own` 을 **앵커 일**로 묶어 SUM.
//      게이트·필터 술어는 `trendWhere` 를 **그대로 재사용**한다(사본 금지).
//
// ── 왜 창을 넓혀도 문장이 안 느는가 ────────────────────────────────────────
//
// 회차 축 사실표는 이미 회차별 분자·분모를 갖고 있다. 두 창을 위해 집계를 두 번 돌리는
// 대신 **회차 집합을 N일에서 2N일로 넓혀 한 번 읽고 JS 에서 가른다**. 달력 월(Q2b)도
// `windows` 에 원소를 하나 더(`before`) 넣는 것으로 끝난다 — 문장 수는 그대로 2개다.
// EXPLAIN ANALYZE 실측은 tasks 2.5 표 참조.
//
// ── 왜 `pickCyclesInRange`·`resolveCycleSet` 을 재사용하지 않는가 ──────────
//
// `resolveCycleSet` 은 창 안에 미발행 회차가 있으면 **폴백**을 낸다
// (`judgeCycleRange` 의 `unpublished-cycle-in-range`). 기간 비교는 정확히 그 구멍을
// **세는** 것이 일이므로(누락 비중), 구멍이 있다고 폴백하면 기능이 성립하지 않는다.
// MoM 리더(`summary-mom-aggregates.ts`)가 같은 이유로 자기 원장 스캔을 갖는다.
//
// ── 원장의 집계 범위 = 값의 **구조 게이트** 범위 ───────────────────────────
//
// "발행됐는가" 만 보면 캡션의 회차 수와 값의 모수가 갈린다: 웹사이트에는 발행됐지만
// 집계층에서 한 행도 안 보이는 회차가 있다(그 회차 행이 전부 `report_fs = 0` = 유닛
// 미부여라 유닛 게이트가 지운다). 그래서 원장도 값과 **같은 구조 게이트**로 좁힌다
// (`inScopeProbe`).
//
// ⚠️ 프로브는 **발행 회차에만** 건다. 미발행 회차는 generation 이 없어 집계층에 행이
//    있을 수 없으므로, 프로브를 걸면 전부 범위 밖으로 사라져 **누락 비중이 항상 0** 이
//    된다. 모르면 누락으로 센다(fail-closed = 억제되는 쪽).
//
// ── 바인드 규율 ────────────────────────────────────────────────────────────
//
// 숫자 바인드는 **`CASE` 안에 넣지 않는다**(2026-09-16 42883: `CASE` 안 숫자 바인드가
// text 로 추론돼 인용 화면이 전면 실패했다). 날짜 경계는 `${day}::date` 로 **명시 캐스트**
// 하고, 배열은 `uuid[]`·`text[]`·`int[]` 만 `sql.param` 으로 넘긴다 — `date[]`·
// `timestamptz[]` 는 drizzle 직렬화기 함정이 있어 배열로 넘기지 않는다.

const num = (v: unknown): number => Number(v ?? 0);

const uuidArray = (vals: readonly string[]): SQL => sql`${sql.param([...vals])}::uuid[]`;
const textArray = (vals: readonly string[]): SQL => sql`${sql.param([...vals])}::text[]`;

// 일자 경계 조각은 `lib/period/sql-day.ts` 가 정본이다 — 종전 인라인과 **글자가 같고**
// (`lib/period/sql-day.test.ts` 가 텍스트로 고정), 타임존은 호출부가 지금 쓰는 값을
// 그대로 넘긴다(기본 `ANCHOR_DAY_TZ` = UTC). 축 전환 때 이 세 줄이 아니라 그 모듈을 고친다.

/** UTC 일 → 그 날 00:00Z. `pickCyclesInRange` 와 **같은 형태**여야 창이 갈리지 않는다. */
const dayStart = (day: Day): SQL => dayStartSql(day);

/** UTC 일 → 그 **다음** 날 00:00Z(반개구간 상한). */
const dayAfter = (day: Day): SQL => dayAfterSql(day);

/** 앵커 → UTC 일. ①②가 **같은 식**을 써야 두 입력이 같은 구간으로 묶인다. */
const anchorDayExpr = (col: SQL): SQL => dayOfSql(col);

/**
 * 앵커 축의 타임존 — `scope_answer_cycle_anchors` 의 `round_date`·`anchor_week`·
 * `anchor_month` 는 전부 **KST 로 잘린 값**이다(스펙 §9 R1 "DB 저장은 UTC, 날짜 키는 KST").
 *
 * `ANCHOR_DAY_TZ`(= 오늘 `UTC`)를 쓰지 않는 이유: 그 상수는 **종전 축**의 타임존이고,
 * 축 전환(READERS)이 끝나야 KST 가 된다. 앵커 축 전용 조각이 그 상수를 따라가면
 * 전환 전에는 UTC 로 잘려 `round_date` 와 하루 갈린다(조용히 틀리는 방향).
 */
const ANCHOR_AXIS_TZ = "Asia/Seoul" as const;

/**
 * 앵커 축에서 원장 스캔을 넓히는 여유(일).
 *
 * 앵커 축의 구간 술어는 `round_date` 인데 원장은 `cycle_anchor_at` 으로만 좁힐 수 있다.
 * 정규 요일 귀속(스펙 §9.2)은 회차를 **같은 주 안**에서 옮기는 것이 기본이고, 자리가
 * 차서 옆 주로 밀리는 경우까지 보면 최대 이동폭이 한 주를 넘을 수 있다. 그래서 양쪽에
 * 2주씩 더 읽고, 구간 배정은 `round_date` 로 한다 — 창 밖으로 떨어지는 회차는
 * `windowOf` 가 이미 버린다. 원장은 표면당 수백 행이라 이 여유가 사실상 공짜다.
 */
const ANCHOR_AXIS_MARGIN_DAYS = 14;

// ── 스코프 ──────────────────────────────────────────────────────────────────

/** 리더가 읽을 구간 하나 — `{key, lo, hi}`. 창 비교는 2원소, 달력 월은 3원소. */
export interface ComparePeriodWindow {
  key: string;
  lo: Day;
  hi: Day;
}

/**
 * 읽기 스코프(design §15 계약).
 *
 * `unitFlags`·`excludedUnits` 는 사용자 필터가 아니라 **구조 게이트**다(웹사이트 유닛
 * 멤버십). 그래서 원장 쪽 범위 판정에도 같은 값이 들어간다.
 */
export interface ComparePeriodsScope {
  surface: "global" | "website";
  /** 모수 — 표면의 프로젝트 id(필터가 아니라 범위다). */
  projectIds: string[];
  filters: StandardFilters;
  /** `planTrendRead` 가 정한 `own_variant`. */
  ownVariant: string;
  ownedBasePrefixes?: string[];
  unitFlags?: boolean;
  excludedUnits?: number[];
  /**
   * 지표 계열 — **기본값 없음**(`excludeHiddenCycleRuns` 와 같은 규율).
   * `citation` 이면 `hidden_scope='citations'` 회차를 분자·분모에서 함께 뺀다.
   * `mention` 이면 **남긴다** — 그 회차의 언급 값은 정상이다(design §6-3).
   */
  family: CompareFamily;
  windows: readonly ComparePeriodWindow[];
}

export interface ComparePeriodsOptions {
  /** `null` 이면 예산(문장 타임아웃·데드라인)을 끈다. 기본은 `summaryRead` 프로파일. */
  budget?: AnswerSetBudget | null;
  /**
   * **회차 집합의 시간축을 앵커 테이블에서 읽는다**(옵트인, 기본 `false`).
   *
   * `false`(기본) — 종전 그대로: 회차의 구간 배정 키는 `cycle_anchor_at` 의 일자다.
   * 두 문장의 **SQL 텍스트가 바이트 단위로 같고**, 추가 문장도 없다.
   *
   * `true` — 회차의 귀속 날짜를 `scope_answer_cycle_anchors.round_date`(KST)에서 읽고,
   * 구간 배정·회차 수·측정 기준일이 전부 그 값을 본다. 문장이 하나 는다(§ ③).
   * 테이블이 없는 배포에서는 프로브(`answerCycleAnchorsAvailable`)가 `false` 라
   * **켜져 있어도 종전 경로**로 간다(계약 §4 capability).
   */
  anchorAxis?: boolean;
}

function budgetedDb(opts?: ComparePeriodsOptions) {
  const budget =
    opts?.budget === null ? undefined : (opts?.budget ?? mirrorHeavyBudget("summaryRead"));
  return budgetedMirrorDb(getDb(), budget);
}

// ── 공통 술어 ───────────────────────────────────────────────────────────────

/**
 * "발행됐다" 의 정의 — **원장 `status` 문자열이 아니라 조회 가능성**이다.
 * `CycleRangeRow.renderable` 과 같은 술어이고, `E` 해소와도 같은 술어다(design §1-2:
 * 미러 시간 규칙을 쓰면 웹사이트에서 3일 갈린다).
 */
const publishedExpr = (alias = "c"): SQL =>
  sql`(${cycleViewableSql(alias)} AND ${sql.raw(alias)}.active_generation_id IS NOT NULL)`;

type HiddenColumnState = { hidden: boolean; scope: boolean };

/** 숨김 컬럼 유무는 **한 번만** 묻고, 술어는 별칭별로 만든다. */
async function hiddenColumnState(): Promise<HiddenColumnState> {
  const hidden = await hiddenCycleColumnsAvailable();
  return { hidden, scope: hidden ? await hiddenCycleScopeAvailable() : false };
}

/**
 * 원장에 남길 회차와, 인용 계열에서 뺄 회차.
 *
 * ⚠️ `hidden_scope='citations'` 는 **원장에서 빼지 않는다** — 그 회차는 발행됐고 언급
 *    계열이 정상이라 ②의 합계에 실제로 들어가 있다. 0071 미적용 배포에서는 범위 컬럼이
 *    없어 **전부 제외**로 폴백한다(종전 동작).
 */
function hiddenGatesFor(st: HiddenColumnState, alias: string): { notHidden: SQL; citationHidden: SQL } {
  if (!st.hidden) return { notHidden: sql`true`, citationHidden: sql`false` };
  const a = sql.raw(alias);
  return st.scope
    ? {
        notHidden: sql`(${a}.hidden_reason IS NULL OR ${a}.hidden_scope = 'citations')`,
        citationHidden: sql`(${a}.hidden_reason IS NOT NULL AND ${a}.hidden_scope = 'citations')`,
      }
    : { notHidden: sql`${a}.hidden_reason IS NULL`, citationHidden: sql`false` };
}

/**
 * **원장 대상 회차의 정의** — 날짜·프로젝트 범위를 뺀 나머지 전부. 본문과 `F` 프로브가
 * **이 한 벌을 공유한다**. 복제하면 갈린다(MoM 2026-09-17 G2 실증: 프로브가 느슨해
 * 원장에 없는 회차가 "이력 있음" 으로 세어졌다).
 */
function ledgerScopeConds(
  q: { surface: "global" | "website" },
  st: HiddenColumnState,
  alias: string,
): SQL[] {
  const a = sql.raw(alias);
  const conds: SQL[] = [
    sql`${a}.surface = ${q.surface}`,
    sql`${a}.status <> 'open' AND ${a}.status <> 'generating'`,
    sql`NOT (${a}.view_anchor_at IS NOT NULL AND ${a}.view_anchor_at > now())`,
    hiddenGatesFor(st, alias).notHidden,
  ];
  // 함대 가시성은 웹사이트 표면의 회차 정의에 들어 있다(`pickCyclesInRange` 와 같은 자세).
  if (q.surface === "website") conds.push(sql`${a}.fleet_visible`);
  return conds;
}

/**
 * **구조 게이트 프로브** — 이 회차가 값(②)에 한 행이라도 기여할 수 있는가.
 *
 * `trendWhere` 중 **사용자 필터가 아닌 것만** 복제한다. 사용자 축(country·engine·lang·
 * brand·funnel·depth1·presence)은 **절대 넣지 않는다** — 넣으면 누락 비중이 화면마다
 * 갈린다. `own_variant` 도 넣지 않는다: 어느 변형이든 행이 있으면 그 회차는 범위 안이다.
 */
function inScopeProbe(
  q: { surface: "global" | "website"; unitFlags?: boolean; excludedUnits?: number[] },
  cycleAlias = "c",
  ownAlias = "o",
): SQL {
  const o = sql.raw(ownAlias);
  const c = sql.raw(cycleAlias);
  // ⚠️ `surface` 를 **걸지 않는다.** 회차 하나는 표면 하나에 속하므로(2026-09-18 실측:
  //    `summary_trend_own` 729 회차 전부 `count(DISTINCT surface) = 1`) `(cycle_id,
  //    generation_id)` 가 이미 표면을 고정한다. 그런데 술어로 남기면 플래너가 웹사이트
  //    함대에서 `summary_trend_own_read(surface)` 비트맵(루프당 10,092행)을 gen 비트맵과
  //    AND 해 **33배** 느려진다: 프로브 실측 **223.7 ms / 34,310 buffers** →
  //    빼면 Index Only Scan **6.7 ms / 2,786 buffers**. (같은 술어가 MoM
  //    `summary-mom-aggregates.ts::inScopeProbe` 에도 있다 — 후속으로 같이 뺄 것.)
  const conds: SQL[] = [
    sql`${o}.cycle_id = ${c}.cycle_id`,
    sql`${o}.generation_id = ${c}.active_generation_id`,
    sql`${o}.run_status IN ('completed', 'partial_failed')`,
  ];
  if (q.surface === "global") {
    conds.push(sql`${o}.in_root_catalog = 1`, sql`${o}.in_tagged_region = 1`, sql`${o}.in_full_cycle = 1`);
    if (HIDDEN_STANDARD_REGIONS.length) {
      conds.push(sql`${o}.country <> ALL(${textArray(HIDDEN_STANDARD_REGIONS)})`);
    }
  } else if (q.unitFlags) {
    conds.push(sql`${o}.report_fs <> 0`);
    if (q.excludedUnits?.length) {
      conds.push(sql`${o}.report_fs <> ALL(${sql.param([...q.excludedUnits])}::int[])`);
    }
  }
  return sql`EXISTS (SELECT 1 FROM summary_trend_own ${o} WHERE ${sql.join(conds, sql` AND `)})`;
}

// ── `E` 해소 ────────────────────────────────────────────────────────────────

/**
 * 끝점 `E` = 그 표면의 **최신 노출 회차 앵커일**(UTC 일). 해소 불가면 `null`.
 *
 * 술어는 **원장 술어 하나뿐**이다(design §1-2). 미러 시간 규칙
 * (`COALESCE(view_anchor_at, cycle_anchor_at + 표면지연) > now()`)은 **미발행 회차까지
 * 노출**해서, 그 날짜를 `E` 로 잡으면 현재 창 끝에 화면에 값이 없는 꼬리가 생긴다 —
 * 2026-09-17 실측으로 웹사이트에서 **3일**(09-11 vs 09-14) 갈린다.
 *
 * `null` 인 경우(원장 미적용·DB 오류·그 표면에 노출 회차 0): 호출부는 **오늘 기준
 * 트레일링으로 폴백**한다 = 종전 동작. surface='project' 는 노출 가능 회차가 0건이라
 * (2026-09-18 실측: 147행 중 0) 구조적으로 여기로 떨어진다.
 */
export interface WindowEndInfo {
  /** `E` — 함대/루트의 **최대** 최신 앵커일. 회차가 없으면 `null`. */
  end: string | null;
  /** 이 범위에서 발행 회차를 가진 프로젝트 수. */
  fleet: number;
  /**
   * 그 프로젝트들의 **최신 앵커일이 몇 가지인가**. `1` 이면 함대가 한 회차일을 공유한다.
   *
   * Q4 결정("함대 회차일 하나 = 최대 앵커")의 전제가 깨지는 구간을 드러내는 값이다 —
   * `> 1` 이면 호출부가 로그 한 줄을 남겨 "조용히 큰 값을 골랐다" 를 보이게 한다.
   * 실측(2026-09-18): 최근 4회차는 함대 전체가 같은 앵커일을 공유하지만 7월분은 갈린다.
   */
  distinctAnchors: number;
}

/**
 * `E` + **함대 앵커 분포**. 문장 1개(원장 집계).
 *
 * `resolveWindowEnd` 는 이 함수의 `end` 만 꺼내는 얇은 래퍼다 — 두 벌의 술어를 만들지 않는다.
 */
export async function resolveWindowEndInfo(
  surface: "global" | "website",
  projectIds: string[],
): Promise<WindowEndInfo> {
  const none: WindowEndInfo = { end: null, fleet: 0, distinctAnchors: 0 };
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return none;
  try {
    const conds: SQL[] = [
      sql`c.surface = ${surface}`,
      sql`c.project_id = ANY(${uuidArray(ids)})`,
      publishedExpr(),
    ];
    if (surface === "website") conds.push(sql`c.fleet_visible`);
    const rows = (await getDb().execute(sql`
      SELECT to_char(max(l.d), 'YYYY-MM-DD') AS end_day,
             count(*)::int                   AS fleet,
             count(DISTINCT l.d)::int        AS distinct_anchors
      FROM (
        SELECT c.project_id, max(${anchorDayExpr(sql`c.cycle_anchor_at`)}) AS d
        FROM summary_cycles c
        WHERE ${sql.join(conds, sql` AND `)}
        GROUP BY c.project_id
      ) l
    `)) as unknown as Array<{
      end_day: string | null;
      fleet: string | number;
      distinct_anchors: string | number;
    }>;
    const r = rows[0];
    if (!r) return none;
    return {
      end: r.end_day ?? null,
      fleet: num(r.fleet),
      distinctAnchors: num(r.distinct_anchors),
    };
  } catch {
    // 표 없음·마이그레이션 선후 배포 — 폴백(fail-closed: 종전 동작).
    return none;
  }
}

export async function resolveWindowEnd(
  surface: "global" | "website",
  projectIds: string[],
): Promise<string | null> {
  return (await resolveWindowEndInfo(surface, projectIds)).end;
}

// ── ① 회차 원장 ─────────────────────────────────────────────────────────────

export interface CompareCycleRow {
  cycleId: string;
  generationId: string | null;
  projectId: string;
  /** UTC 일. 구간 배정은 이 값으로 한다. */
  day: Day;
  cycleAnchorAt: string;
  cycleWeek: string;
  expectedUnits: number;
  published: boolean;
  /** `hidden_scope='citations'` — 인용 계열에서만 빼는 회차. */
  citationHidden: boolean;
  /**
   * 앵커 시각의 **KST 일자**. 앵커 축에서만 채운다(종전 경로는 `undefined`).
   * 앵커 테이블에 행이 없는 회차(= 완료 답변 0건인 미발행 회차)의 귀속 날짜를
   * 정규 요일로 되돌리는 폴백 입력이다.
   */
  kstDay?: Day;
}

interface CompareCycleQuery {
  surface: "global" | "website";
  projectIds: string[];
  /** 포함 경계, UTC 일. 전 구간을 덮는 **하나의** 범위다. */
  from: Day;
  to: Day;
  unitFlags?: boolean;
  excludedUnits?: number[];
  /** 앵커 축(§ ③). `true` 면 `F` 를 KST 로 자르고 KST 일자 컬럼을 하나 더 싣는다. */
  anchorAxis?: boolean;
}

/**
 * 원장 본문 + **전 이력 첫 발행 앵커 `F`**(스칼라 서브쿼리).
 *
 * `F` 를 같은 문장에 싣는 이유: `start_window`·`start_month` 판정이 그 값 하나로
 * 끝나는데(design §5-2·§7), 따로 읽으면 문장이 하나 는다. 원장은 표면당 수백 행이라
 * 범위 없는 스캔이 사실상 공짜다.
 *
 * ⚠️ `F` 는 **구간 안의 첫 회차가 아니다.** 구간 안으로 재면 회차가 드문 구간이 전부
 *    시작 구간으로 오분류된다(웹사이트 7일 직전 창의 창 내 첫 발행 `09-04` 는
 *    `grace(7)=2` 를 넘지만 전 이력 첫 발행은 `2026-07-02` 다).
 */
function compareCycleRowsSql(q: CompareCycleQuery, st: HiddenColumnState): SQL {
  const pub = publishedExpr();
  const scoped = ledgerScopeConds(q, st, "c");
  const idsSql = uuidArray([...new Set(q.projectIds)]);
  const conds: SQL[] = [
    ...scoped,
    sql`c.project_id = ANY(${idsSql})`,
    sql`c.cycle_anchor_at >= ${dayStart(q.from)}`,
    sql`c.cycle_anchor_at < ${dayAfter(q.to)}`,
    // 값이 볼 수 없는 회차는 원장에서도 뺀다. **발행 회차에만** 건다(머리 주석 ⚠️).
    sql`(NOT ${pub} OR ${inScopeProbe(q)})`,
  ];
  const firstConds: SQL[] = [
    ...ledgerScopeConds(q, st, "c1"),
    sql`c1.project_id = ANY(${idsSql})`,
    publishedExpr("c1"),
    inScopeProbe(q, "c1", "o1"),
  ];
  // 앵커 축에서는 `F` 도 **같은 타임존**이어야 한다. `prevLo` 가 `round_date`(KST) 공간의
  // 날짜인데 `F` 만 UTC 일자면 `judgeStartWindow` 가 경계에서 하루씩 어긋난다.
  const firstAnchor = sql`(
      SELECT to_char(min(${
        q.anchorAxis
          ? dayOfSql(sql`c1.cycle_anchor_at`, ANCHOR_AXIS_TZ)
          : anchorDayExpr(sql`c1.cycle_anchor_at`)
      }), 'YYYY-MM-DD')
      FROM summary_cycles c1 WHERE ${sql.join(firstConds, sql` AND `)}
    )`;
  // ── `F` 의 **귀속 날짜** — 공식이 아니라 저장된 배정을 쓴다 (검증 D5) ───────
  //
  // 종전에는 호출부가 위 값(앵커의 KST 일자)을 `regularRoundDateOf`("같은 주의 정규
  // 요일") 공식으로 스냅했다. 그런데 §9.2 의 실제 배정에는 **옆 주로 미는** 분기가 있다
  // (`basis` 가 `next_empty`·`nearest`·`merged`). 그 회차에서 공식은 저장값과 최대 한 주
  // 어긋나고, `judgeStartWindow` 의 `F > prevLo + grace` 경계에서 "측정 시작 달 제외"
  // 판정이 뒤집힐 수 있다.
  //
  // ⚠️ **매핑 표를 원장 앵커로 찾지 않는다**(2026-09-20 실측 빈틈). 매핑 표의
  //    `anchor_date` 는 앵커 표가 실제로 쓴 앵커(0053 registry 보정 반영)라 원장
  //    `cycle_anchor_at` 의 KST 일자와 다를 수 있고, 그러면 조인이 빗나가 `F` 가
  //    조용히 NULL 이 된다(= 호출부가 공식으로 폴백 → §9.2 의 옆 주 분기를 놓친다).
  //    조각 정본은 DATA 헬퍼 `lib/period/anchor-axis.ts::cycleRoundJoinSql` 한 곳이고,
  //    `summary-cycles.ts::cycleRoundDate` 와 **같은 키**(cycle_id)를 쓴다.
  //
  // 앵커 행이 없는 회차(배정 전·표면 밖)는 **NULL** 로 두고 호출부가 공식으로 폴백한다.
  // 여기서 `COALESCE` 로 메우면 "배정이 있었는지"를 JS 가 구분할 수 없다.
  //
  // ⚠️ **그 회차의** `round_date` 다 — `min(round_date)` 가 아니다(검증 N8). 두 가지가
  //    달랐다:
  //      · `INNER JOIN` + `min()` 이면 **매핑이 없는 회차가 집합에서 빠진다.** 가장 이른
  //        회차만 매핑이 없고 뒤 회차에 매핑이 있으면 `F` 가 늦어지고, `judgeStartWindow`
  //        (`F > prevLo + grace`)가 **과억제**로 기운다.
  //      · §9.2 배정에는 앞 자리로 미는 분기가 있어 **뒤 회차가 더 이른 `round_date`** 를
  //        가질 수 있다. 그때 `min()` 은 `F` 를 앞당겨 **과소억제**가 된다.
  //    그래서 앵커가 가장 이른 회차 **한 행**을 고르고(`ORDER BY … LIMIT 1`) 그 행의
  //    `round_date` 를 읽는다. 조인은 `LEFT` 라 그 회차에 매핑이 없을 때만 NULL 이다.
  //    정렬 두 번째 키(`project_id`)는 같은 시각 회차가 여럿일 때의 결정성 확보용이다.
  const firstRoundCol = q.anchorAxis
    ? sql`, (
      SELECT to_char(${cycleRoundDateSql("m1")}, 'YYYY-MM-DD')
        FROM summary_cycles c1${cycleRoundJoinSql(
          sql.raw("c1.cycle_id"),
          "m1",
          sql`ca.project_id = ANY(${idsSql})`,
        )}
       WHERE ${sql.join(firstConds, sql` AND `)}
       ORDER BY c1.cycle_anchor_at, c1.project_id
       LIMIT 1
    ) AS first_published_round`
    : sql``;
  // 앵커 축 전용 컬럼. 종전 경로에서는 **한 글자도 나가지 않는다**(빈 조각).
  const kstDayCol = q.anchorAxis
    ? sql`, to_char(${dayOfSql(sql`c.cycle_anchor_at`, ANCHOR_AXIS_TZ)}, 'YYYY-MM-DD') AS kst_day`
    : sql``;
  return sql`
    SELECT c.cycle_id::text                     AS cycle_id,
           c.active_generation_id::text         AS generation_id,
           c.project_id::text                   AS project_id,
           c.cycle_anchor_at                    AS cycle_anchor_at,
           to_char(${anchorDayExpr(sql`c.cycle_anchor_at`)}, 'YYYY-MM-DD') AS day,
           to_char(c.cycle_week, 'YYYY-MM-DD')  AS cycle_week,
           COALESCE(c.expected_units, 0)::int   AS expected_units,
           ${pub}                               AS published,
           ${hiddenGatesFor(st, "c").citationHidden} AS citation_hidden,
           ${firstAnchor}                       AS first_published_anchor${firstRoundCol}${kstDayCol}
    FROM summary_cycles c
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY c.cycle_anchor_at, c.project_id
  `;
}

interface CycleReadResult {
  rows: CompareCycleRow[];
  firstPublishedAnchor: Day | null;
  /** 축 on 에서 매핑 표가 준 `F` 의 귀속 날짜. 매핑이 없으면 `null`(호출부가 폴백). */
  firstPublishedRound: Day | null;
}

async function readCompareCycles(
  q: CompareCycleQuery,
  st: HiddenColumnState,
  opts?: ComparePeriodsOptions,
): Promise<CycleReadResult> {
  const rows = (await budgetedDb(opts).execute(compareCycleRowsSql(q, st))) as unknown as Array<{
    cycle_id: string;
    generation_id: string | null;
    project_id: string;
    cycle_anchor_at: Date | string;
    day: string;
    cycle_week: string;
    expected_units: string | number;
    published: boolean | null;
    citation_hidden: boolean | null;
    first_published_anchor: string | null;
    first_published_round?: string | null;
    kst_day?: string | null;
  }>;
  return {
    firstPublishedAnchor: rows[0]?.first_published_anchor ?? null,
    firstPublishedRound: rows[0]?.first_published_round ?? null,
    rows: rows.map((r) => ({
      cycleId: r.cycle_id,
      generationId: r.generation_id,
      projectId: r.project_id,
      day: r.day,
      cycleAnchorAt: new Date(r.cycle_anchor_at).toISOString(),
      cycleWeek: r.cycle_week,
      expectedUnits: num(r.expected_units),
      published: r.published === true,
      citationHidden: r.citation_hidden === true,
      ...(typeof r.kst_day === "string" ? { kstDay: r.kst_day as Day } : {}),
    })),
  };
}

// ── ③ 회차 → 귀속 날짜 (앵커 축 전용) ──────────────────────────────────────

/**
 * 회차 하나의 **귀속 날짜**(스펙 §9.2). 앵커 축에서만 읽는다.
 *
 * `anchorWeek`·`anchorMonth` 는 `round_date` 에서 파생되는 값이지만 **저장값을 읽는다** —
 * 계약 §2 가 그 셋을 테이블의 키로 못박았고, 파생을 여기서 다시 계산하면 배정 규칙이
 * 두 벌이 된다. 대신 파생과 어긋나면 로그를 남긴다(아래 `warnAxisDrift`).
 */
interface RoundDateRow {
  cycleId: string;
  roundDate: Day;
  /** 같은 회차 안에서 `round_date` 가 갈리는지 보는 값(정상이면 `roundDate` 와 같다). */
  roundDateMax: Day;
  anchorWeek: Day;
  anchorMonth: Day;
}

/**
 * 회차 → 귀속 날짜 대응표. **문장 1개**, `GROUP BY cycle_id` 하나.
 *
 * ── 왜 게이트를 하나도 걸지 않는가 ────────────────────────────────────────
 * 이 문장은 **날짜 대응표**이지 값의 필터가 아니다. 노출·숨김 게이트는 원장(①)이 이미
 * 걸었고(그 결과가 `published`), 인용 계열 규약은 ②가 건다. 여기서 또 걸면 같은 게이트가
 * 세 벌이 되고, 특히 노출 게이트를 걸면 **미발행 회차의 귀속 날짜가 사라져** 누락 비중이
 * 구조적으로 0 이 된다(머리 주석 ⚠️ 와 같은 함정).
 *
 * `is_default_engine` 도 걸지 않는다 — 옵트인 엔진 답변만 가진 회차라도 그 회차의
 * **귀속 날짜**는 같은 값이다. 엔진 범위는 값(②)의 축이지 날짜 축이 아니다.
 *
 * ── 왜 `count(DISTINCT)` 가 아니라 `min`/`max` 인가 ───────────────────────
 * 한 회차의 `round_date` 는 하나여야 한다(스펙 §9.2 "한 자리 = 한 회차"). 그것을
 * 확인하는 데 DISTINCT 집계(정렬을 부른다)를 쓸 이유가 없다 — `min <> max` 면 갈린 것이다.
 */
function compareRoundDatesSql(q: {
  surface: "global" | "website";
  projectIds: string[];
  from: Day;
  to: Day;
}): SQL {
  // 표면 어휘가 두 테이블에서 다르다(원장 `global` ↔ 앵커 `standard`). 리터럴을 쓰지
  // 않고 정본 맵을 경유한다 — 어긋나면 에러 없이 **0행**이 된다.
  const surface = toAnchorSurface(q.surface);
  return sql`
    SELECT ca.cycle_id::text                            AS cycle_id,
           to_char(min(ca.round_date), 'YYYY-MM-DD')    AS round_date,
           to_char(max(ca.round_date), 'YYYY-MM-DD')    AS round_date_max,
           to_char(min(ca.anchor_week), 'YYYY-MM-DD')   AS anchor_week,
           to_char(min(ca.anchor_month), 'YYYY-MM-DD')  AS anchor_month
      FROM scope_answer_cycle_anchors ca
     WHERE ca.surface = ${surface}
       AND ca.project_id = ANY(${uuidArray([...new Set(q.projectIds)])})
       AND ca.round_date >= ${q.from}::date
       AND ca.round_date <= ${q.to}::date
       AND ca.cycle_id IS NOT NULL
     GROUP BY 1
  `;
}

async function readRoundDates(
  q: { surface: "global" | "website"; projectIds: string[]; from: Day; to: Day },
  opts?: ComparePeriodsOptions,
): Promise<Map<string, RoundDateRow>> {
  const rows = (await budgetedDb(opts).execute(compareRoundDatesSql(q))) as unknown as Array<{
    cycle_id: string;
    round_date: string | null;
    round_date_max: string | null;
    anchor_week: string | null;
    anchor_month: string | null;
  }>;
  const out = new Map<string, RoundDateRow>();
  for (const r of rows) {
    if (!r.round_date) continue;
    out.set(r.cycle_id, {
      cycleId: r.cycle_id,
      roundDate: r.round_date as Day,
      roundDateMax: (r.round_date_max ?? r.round_date) as Day,
      anchorWeek: (r.anchor_week ?? r.round_date) as Day,
      anchorMonth: (r.anchor_month ?? r.round_date) as Day,
    });
  }
  return out;
}

/**
 * 저장된 주·월 키가 `round_date` 에서 파생한 값과 어긋나면 **로그 한 줄**.
 *
 * 값을 고치지 않는다 — 저장값이 정본이다(계약 §2). 어긋남은 배정 백필의 결함이지
 * 리더가 덮을 것이 아니고, 조용히 덮으면 축이 두 벌이 된다. 정상 구간에서는 한 줄도
 * 남지 않는 것이 이 술어의 요점이다(`distinctAnchors > 1` 로그와 같은 자세).
 */
function warnAxisDrift(surface: "global" | "website", map: Map<string, RoundDateRow>): void {
  let split = 0;
  let weekDrift = 0;
  let monthDrift = 0;
  for (const r of map.values()) {
    if (r.roundDateMax !== r.roundDate) split += 1;
    if (r.anchorWeek !== weekMondayOf(r.roundDate)) weekDrift += 1;
    if (r.anchorMonth.slice(0, 7) !== r.roundDate.slice(0, 7)) monthDrift += 1;
  }
  if (split === 0 && weekDrift === 0 && monthDrift === 0) return;
  console.info(
    `x-hmg-period-compare(${surface}): anchor-axis-drift cycles=${map.size} ` +
      `split=${split} week=${weekDrift} month=${monthDrift}`,
  );
}

/**
 * 인용 계열에서만 숨김 회차를 뺀다 — 언급 계열은 그 회차의 값이 **정상**이다(design §6-3).
 *
 * 실측 반례(글로벌 14일 창): `08-25` 를 언급 계열에서까지 빼면 직전 창이
 * `72.8604 % → 77.0382 %` 가 되어 Δ 가 `−1.55 → −5.73 %p` 로 **4.18 %p** 틀어진다.
 * 그래서 이 분기를 **순수 함수로 떼어** DB 없이 단언한다.
 */
export function citationHiddenIdsFor(
  family: CompareFamily,
  hiddenCycleIds: readonly string[],
): string[] {
  return family === "citation" ? [...new Set(hiddenCycleIds)] : [];
}

/** 회차 행(발행분) → `trendWhere` 가 쓸 회차 집합. 빈 집합이면 `null`. */
export function buildCompareCycleSet(
  surface: "global" | "website",
  rows: readonly CompareCycleRow[],
): CycleSet | null {
  const cycles = rows
    .filter((r) => r.published && r.generationId)
    .map((r) => ({
      cycleId: r.cycleId,
      generationId: r.generationId as string,
      projectId: r.projectId,
      cycleAnchorAt: r.cycleAnchorAt,
      cycleWeek: r.cycleWeek,
    }));
  if (cycles.length === 0) return null;
  return {
    surface,
    mode: "period",
    cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

// ── ② 앵커 일별 합계 ────────────────────────────────────────────────────────

/**
 * `summary_trend_own` 을 **앵커 일**로 묶어 SUM — 문장 1개.
 *
 * 구간(`prev`/`cur`/`before`)으로 바로 묶지 않고 앵커 일로 묶는 이유는 **바인드 규율**이다:
 * 구간 배정을 SQL 로 내리면 `CASE` 안에 날짜 바인드가 들어가는데, 그 자리가 2026-09-16
 * 42883 사고의 자리다. 앵커 일은 그룹 키가 수십 개뿐이라 JS 배정이 공짜이고, 구간이
 * 2개든 3개든(달력 월) **같은 문장**이 나간다.
 *
 * 그룹 키에 `cycle_id` 를 **함께** 둔다. `count(DISTINCT cycle_id)` 를 쓰면 플래너가
 * GroupAggregate + 정렬로 가는데(글로벌 60일 실측: 19,578행 quicksort 2,298 kB),
 * 회차를 키로 세우면 **HashAggregate** 로 떨어지고 출력은 회차 수(글로벌 10 · 웹사이트
 * 함대 ~480)뿐이다. "구간의 회차 수" 는 JS 가 행 수로 센다 — 한 회차는 앵커가 정확히
 * 하나이므로 구간 안에서 합해도 distinct 회차 수와 같다.
 *
 * `citationHiddenCycleIds` 는 **인용 계열 읽기에서만** 비지 않는다(design §6-3).
 * 목록이 비면 술어가 `TRUE` 라 종전과 바이트 동일이다.
 */
function compareTotalsSql(scope: TrendReadScope, citationHiddenCycleIds: readonly string[]): SQL {
  const ok: SQL = citationHiddenCycleIds.length
    ? sql`cycle_id <> ALL(${uuidArray(citationHiddenCycleIds)})`
    : sql`TRUE`;
  return sql`
    SELECT to_char(${anchorDayExpr(sql`cycle_anchor_at`)}, 'YYYY-MM-DD') AS day,
           cycle_id::text                               AS cycle_id,
           count(*)::bigint                             AS key_rows,
           COALESCE(sum(monitored), 0)::bigint          AS monitored,
           COALESCE(sum(tracked_answers), 0)::bigint    AS tracked_answers,
           COALESCE(sum(own_mentions), 0)::bigint       AS own_mentions,
           COALESCE(sum(comp_mentions), 0)::bigint      AS comp_mentions,
           COALESCE(sum(own_positive), 0)::bigint       AS own_positive,
           COALESCE(sum(own_signals), 0)::bigint        AS own_signals,
           COALESCE(sum(rank_sum), 0)::double precision AS rank_sum,
           COALESCE(sum(ranked_answers), 0)::bigint     AS ranked_answers,
           COALESCE(sum(all_citations), 0)::bigint      AS all_citations
    FROM summary_trend_own
    WHERE ${trendWhere(scope)} AND own_variant = ${scope.ownVariant} AND ${ok}
    GROUP BY 1, 2
  `;
}

/** ②의 출력 한 줄 = **회차 하나**(앵커 일 + cycle_id). 누산기로도 같은 모양을 쓴다. */
interface TotalsRow {
  day: string;
  /**
   * 회차 id. **앵커 축에서만** 읽는다(구간 배정 키가 `day` 가 아니라 그 회차의
   * `round_date` 라서). 누산기에는 없다 — 그래서 선택 필드다.
   */
  cycleId?: string;
  keyRows: number;
  /** 회차 수. 행 하나가 곧 회차 하나라 원본 행에서는 항상 1 이고, 누산하면 구간 회차 수다. */
  dataCycles: number;
  monitored: number;
  trackedAnswers: number;
  ownMentions: number;
  compMentions: number;
  ownPositive: number;
  ownSignals: number;
  rankSum: number;
  rankedAnswers: number;
  allCitations: number;
}

const ZERO_TOTALS = (day: string): TotalsRow => ({
  day,
  keyRows: 0,
  dataCycles: 0,
  monitored: 0,
  trackedAnswers: 0,
  ownMentions: 0,
  compMentions: 0,
  ownPositive: 0,
  ownSignals: 0,
  rankSum: 0,
  rankedAnswers: 0,
  allCitations: 0,
});

function addTotals(acc: TotalsRow, r: TotalsRow): TotalsRow {
  return {
    day: acc.day,
    keyRows: acc.keyRows + r.keyRows,
    dataCycles: acc.dataCycles + r.dataCycles,
    monitored: acc.monitored + r.monitored,
    trackedAnswers: acc.trackedAnswers + r.trackedAnswers,
    ownMentions: acc.ownMentions + r.ownMentions,
    compMentions: acc.compMentions + r.compMentions,
    ownPositive: acc.ownPositive + r.ownPositive,
    ownSignals: acc.ownSignals + r.ownSignals,
    rankSum: acc.rankSum + r.rankSum,
    rankedAnswers: acc.rankedAnswers + r.rankedAnswers,
    allCitations: acc.allCitations + r.allCitations,
  };
}

/**
 * 합계 → 지표 분자·분모. **분모를 회차 수로 바꾸는 뮤턴트가 여기서 죽어야 한다**:
 * 건수형의 분모는 `monitored`(수집 답변)이지 `dataCycles` 가 아니다.
 *
 * 계열 밖 지표는 **싣지 않는다** — 인용 계열 읽기는 숨김 회차를 뺀 모수를 쓰므로 그
 * 모수로 만든 언급 지표를 같이 내보내면 화면이 두 벌의 ①을 갖게 된다.
 */
function measuresOf(
  t: TotalsRow,
  family: CompareFamily,
): Partial<Record<CompareMetricKey, CompareMeasure>> {
  if (family === "citation") {
    return { citationsPerAnswer: { numerator: t.allCitations, denominator: t.monitored } };
  }
  return {
    visibility: { numerator: t.trackedAnswers, denominator: t.monitored },
    share: { numerator: t.ownMentions, denominator: t.compMentions },
    favorability: { numerator: t.ownPositive, denominator: t.ownSignals },
    position: { numerator: t.rankSum, denominator: t.rankedAnswers },
    mentionsPerAnswer: { numerator: t.ownMentions, denominator: t.monitored },
  };
}

// ── 구간 배정 (순수) ────────────────────────────────────────────────────────

/** 구간 하나의 누산기. `citationHidden` 은 ②가 쓸 숨김 회차 목록이다. */
interface LedgerAcc {
  ledger: CompareLedger;
  citationHidden: string[];
}

/**
 * 회차 행 → 구간별 원장 요약. **순수 함수**(DB 없이 단언한다).
 *
 * 축이 갈리는 자리가 여기 하나다:
 *
 * | | 종전 축 | 앵커 축(`countRounds`) |
 * | --- | --- | --- |
 * | 배정 키 | `cycle_anchor_at` 의 일자 | 그 회차의 `round_date` |
 * | 회차 **수** | 원장 행 수 | **자리(`round_date`) 수** |
 * | 계획 단위 | Σ `expected_units` | 같다(합쳐진 회차도 **둘 다** 더한다) |
 * | 누락 단위 | Σ 미발행 `expected_units` | 같다 |
 *
 * 회차 수만 자리 단위인 이유: 스펙 §9.2 가 "둘 다 차 있으면 가까운 회차에 합침 ·
 * 한 자리 = 한 회차" 라 원장 회차 둘이 한 자리로 들어올 수 있다. 고객이 캡션에서 읽는
 * "회차" 는 자리이므로 자리를 센다. 반대로 계획·누락 **단위**는 합산이 맞다 — 한쪽만
 * 발행된 자리에서 다른 쪽 계획량은 실제로 안 들어온 수집량이고, 그것을 0 으로 접으면
 * 누락 비중이 과소평가된다(억제가 덜 걸리는 방향).
 */
function assignLedgers(args: {
  windows: readonly ComparePeriodWindow[];
  rows: readonly CompareCycleRow[];
  /** 회차 id → 배정 날짜. 없는 회차는 그 행의 `day` 로 떨어진다. */
  roundByCycle: ReadonlyMap<string, Day>;
  firstPublishedAnchor: Day | null;
  countRounds: boolean;
}): Map<string, LedgerAcc> {
  const byKey = new Map<string, LedgerAcc>();
  const rounds = new Map<string, Set<string>>();
  for (const w of args.windows) {
    byKey.set(w.key, {
      ledger: {
        plannedUnits: 0,
        missingUnits: 0,
        publishedCycles: 0,
        dataCycles: 0,
        firstPublishedAnchor: args.firstPublishedAnchor,
      },
      citationHidden: [],
    });
    rounds.set(w.key, new Set<string>());
  }
  const windowOf = (day: Day): ComparePeriodWindow | undefined =>
    args.windows.find((w) => day >= w.lo && day <= w.hi);

  for (const r of args.rows) {
    const day = args.roundByCycle.get(r.cycleId) ?? r.day;
    // 구간 사이의 빈틈(달력 월 3원소가 연속이 아닐 때) · 앵커 축 여유분 바깥.
    const w = windowOf(day);
    if (!w) continue;
    const acc = byKey.get(w.key)!;
    acc.ledger.plannedUnits += r.expectedUnits;
    if (r.published) {
      const seen = rounds.get(w.key)!;
      seen.add(day);
      acc.ledger.publishedCycles = args.countRounds ? seen.size : acc.ledger.publishedCycles + 1;
      if (r.citationHidden) acc.citationHidden.push(r.cycleId);
    } else {
      acc.ledger.missingUnits += r.expectedUnits;
    }
  }
  // 계획 단위를 하나도 모르는 구간(원장에 회차가 없거나 `expected_units` 가 전부 NULL)은
  // "누락 0%" 가 아니라 **판정 불가**다(`CompareLedger.plannedKnown` 주석). 값은 종전과
  // 같고(임계에 닿지 않는 0), 달라지는 것은 그 0 을 임계와 견주지 **않는다**는 점이다.
  for (const acc of byKey.values()) acc.ledger.plannedKnown = acc.ledger.plannedUnits > 0;
  return byKey;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

/**
 * 구간별 합계 + 원장 요약 — 문장 **2개**(원장 ① · 사실표 ②).
 *
 * `null` = **집계층을 탈 수 없다**(문장 실패·표 없음) → 호출부가 `unsupported` 로 닫는다.
 * 구간에 회차가 하나도 없는 것은 `null` 이 **아니다** — 그것은 `no_prev`/`no_data` 라는
 * 다른 명제이고, 원장만으로 판정된다(②를 부르지 않고 0 으로 채운 배열을 돌려준다).
 *
 * ⚠️ **반환은 배열이다(Map 이 아니다).** 이 값은 게이트웨이에서 `unstable_cache` 셀의
 * 반환값이 되고, Next Data Cache 는 그것을 **직렬화**한다. `Map` 은 그 왕복에서
 * `{}` 로 죽어(키가 사라진다) **캐시 HIT 부터** 소비부의 `.get()` 이 터진다 — MISS 인
 * 첫 요청만 정상이라 개발 중에는 안 보이고, 두 번째 요청부터 세그먼트 전체가
 * errorBoundary 로 내려앉는다(2026-09-19 프리뷰 실측: 같은 URL 1회 정상 · 2·3회 0카드).
 * 원소가 `key` 를 들고 있으므로 호출부가 캐시 **경계 밖에서** Map 으로 만든다.
 */
export async function readComparePeriods(
  scope: ComparePeriodsScope,
  opts?: ComparePeriodsOptions,
): Promise<ComparePeriod[] | null> {
  if (scope.windows.length === 0) return [];
  for (const w of scope.windows) {
    assertDay(w.lo, `window.lo(${w.key})`);
    assertDay(w.hi, `window.hi(${w.key})`);
    if (w.lo > w.hi) throw new Error(`window must be ascending: ${w.key}`);
  }
  const ids = [...new Set(scope.projectIds)];
  if (ids.length === 0) return null;
  const loMin = scope.windows.reduce((a, w) => (w.lo < a ? w.lo : a), scope.windows[0]!.lo);
  const hiMax = scope.windows.reduce((a, w) => (w.hi > a ? w.hi : a), scope.windows[0]!.hi);

  // 앵커 축은 **옵트인 × capability** 다. 테이블이 없는 배포에서는 켜져 있어도 종전
  // 경로로 간다 — 프로브를 여기서(범위를 넓히기 **전에**) 읽어야 두 경로가 같은
  // 날짜 범위를 쓴다(계약 §4).
  const anchorAxis = opts?.anchorAxis === true && (await answerCycleAnchorsAvailable());
  const from = anchorAxis ? addDays(loMin, -ANCHOR_AXIS_MARGIN_DAYS) : loMin;
  const to = anchorAxis ? addDays(hiMax, ANCHOR_AXIS_MARGIN_DAYS) : hiMax;

  let cycles: CycleReadResult;
  try {
    cycles = await readCompareCycles(
      {
        surface: scope.surface,
        projectIds: ids,
        from,
        to,
        unitFlags: scope.unitFlags,
        excludedUnits: scope.excludedUnits,
        ...(anchorAxis ? { anchorAxis: true } : {}),
      },
      await hiddenColumnState(),
      opts,
    );
  } catch {
    return null; // 원장 미적용·DB 오류 — 폴백(종전 Δ)
  }

  // ── 축 해소: 회차 하나가 어느 날짜에 귀속되는가 ──────────────────────────
  //
  // 종전 축 = `cycle_anchor_at` 의 일자(`r.day`). 앵커 축 = 그 회차의 `round_date`.
  // 회차 id 로 한 번 풀어 두고 ①②가 **같은 표**를 본다 — 두 입력이 다른 키로 묶이면
  // 캡션의 회차 수와 값의 모수가 갈린다.
  let roundOf: ((r: { cycleId: string; day: Day; kstDay?: Day }) => Day) | null = null;
  let firstPublishedAnchor = cycles.firstPublishedAnchor;
  if (anchorAxis) {
    let axis: Map<string, RoundDateRow>;
    try {
      axis = await readRoundDates({ surface: scope.surface, projectIds: ids, from, to }, opts);
    } catch {
      return null; // 앵커 테이블 읽기 실패 — 축을 섞지 않고 폴백한다(종전 Δ)
    }
    warnAxisDrift(scope.surface, axis);
    // 표면 어휘가 정규 요일 표(`REGULAR_ROUND_DOW`)와 같다 — 캐스트가 필요 없는 것이
    // 정상이고, 필요해지면 그쪽 표가 갈린 것이다.
    const fallbackSurface: RegularRoundSurface = scope.surface;
    roundOf = (r) =>
      axis.get(r.cycleId)?.roundDate ?? regularRoundDateOf(fallbackSurface, r.kstDay ?? r.day);
    // `F` 의 귀속은 **저장된 배정이 이긴다**(D5). 매핑 표에 없을 때만 공식으로 폴백한다 —
    // 공식("같은 주의 정규 요일")은 옆 주로 밀린 배정(`next_empty`·`nearest`·`merged`)을
    // 재현하지 못해 조항 ⑤ 판정이 경계에서 뒤집힐 수 있다.
    firstPublishedAnchor =
      cycles.firstPublishedRound ??
      (cycles.firstPublishedAnchor
        ? regularRoundDateOf(fallbackSurface, cycles.firstPublishedAnchor)
        : null);
  }
  const dayOfCycle = (r: { cycleId: string; day: Day; kstDay?: Day }): Day =>
    roundOf ? roundOf(r) : r.day;
  /** 회차 id → 귀속 날짜. ②가 ①과 **같은 표**를 보게 하는 단 하나의 경로다. */
  const roundByCycle = new Map<string, Day>(
    cycles.rows.map((r) => [r.cycleId, dayOfCycle(r)] as const),
  );

  const byKey = assignLedgers({
    windows: scope.windows,
    rows: cycles.rows,
    roundByCycle,
    firstPublishedAnchor,
    countRounds: roundOf !== null,
  });

  // 구간 순서는 `scope.windows` 그대로다 — 호출부가 키로 찾으므로 순서에 의미는 없지만,
  // 같은 입력이면 같은 바이트가 나와야 캐시 키·스냅샷이 흔들리지 않는다.
  const periods: ComparePeriod[] = [];
  const fill = (totals: readonly TotalsRow[]) => {
    for (const w of scope.windows) {
      const acc = byKey.get(w.key)!;
      let sum = ZERO_TOTALS(w.key);
      const dataRounds = new Set<string>();
      for (const row of totals) {
        // 앵커 축에서는 사실표 행의 `day`(= `cycle_anchor_at` 일자)가 아니라 그 회차의
        // 귀속 날짜로 배정한다. 표에 없는 회차(원장에 없는 회차)는 종전대로 `day`.
        const day = (row.cycleId ? roundByCycle.get(row.cycleId) : undefined) ?? row.day;
        if (day >= w.lo && day <= w.hi) {
          sum = addTotals(sum, row);
          dataRounds.add(day);
        }
      }
      // 데이터 회차 수도 같은 단위로 센다(위 `publishedCycles` 주석과 같은 이유).
      acc.ledger.dataCycles = roundOf ? dataRounds.size : sum.dataCycles;
      periods.push({
        key: w.key,
        lo: w.lo,
        hi: w.hi,
        measures: measuresOf(sum, scope.family),
        ledger: acc.ledger,
      });
    }
  };

  const set = buildCompareCycleSet(scope.surface, cycles.rows);
  if (!set) {
    fill([]);
    return periods;
  }

  const citationHiddenCycleIds = citationHiddenIdsFor(
    scope.family,
    scope.windows.flatMap((w) => byKey.get(w.key)!.citationHidden),
  );

  const trendScope: TrendReadScope = {
    set,
    filters: scope.filters,
    ownVariant: scope.ownVariant,
    ownedBasePrefixes: scope.ownedBasePrefixes ?? [],
    unitFlags: scope.unitFlags,
    excludedUnits: scope.excludedUnits,
  };
  try {
    const rows = (await budgetedDb(opts).execute(
      compareTotalsSql(trendScope, citationHiddenCycleIds),
    )) as unknown as Array<Record<string, unknown>>;
    const totals: TotalsRow[] = [];
    for (const r of rows) {
      totals.push({
        day: String(r.day),
        // 앵커 축의 배정 키. 종전 경로는 읽고도 쓰지 않는다(SQL 은 이미 이 컬럼을
        // 그룹 키로 내고 있었다 — 문장·바이트가 바뀌지 않는다).
        cycleId: typeof r.cycle_id === "string" ? r.cycle_id : undefined,
        keyRows: num(r.key_rows),
        // 행 하나 = 회차 하나(그룹 키가 `(day, cycle_id)`) — 구간 합이 곧 회차 수다.
        dataCycles: 1,
        monitored: num(r.monitored),
        trackedAnswers: num(r.tracked_answers),
        ownMentions: num(r.own_mentions),
        compMentions: num(r.comp_mentions),
        ownPositive: num(r.own_positive),
        ownSignals: num(r.own_signals),
        rankSum: num(r.rank_sum),
        rankedAnswers: num(r.ranked_answers),
        allCitations: num(r.all_citations),
      });
    }
    fill(totals);
    return periods;
  } catch {
    return null; // 사실표 미적용·문장 실패 — 폴백
  }
}

/** 테스트가 컴파일된 SQL 형태·매핑을 고정할 수 있게 내부 조각을 노출한다. */
export const __testables = {
  assignLedgers,
  compareCycleRowsSql,
  compareRoundDatesSql,
  compareTotalsSql,
  inScopeProbe,
  publishedExpr,
  ledgerScopeConds,
  hiddenGatesFor,
  measuresOf,
  anchorDayExpr,
  dayStart,
  dayAfter,
};
