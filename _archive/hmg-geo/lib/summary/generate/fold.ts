/**
 * 생성기 코어 — 세부층 → **집계층(키 그레인) 접기 4문장**.
 *
 * 정본: 플랜 §5-1(어디에 붙나) · §3-2(`summary_trend_own` = KPI 엔진 확장 7컬럼) ·
 * §3-4(화면 값 판정표) · §7-2(가산성 단언).
 * 스키마 정본은 `lib/db/migrations/0059_summary_tables.sql`(4표) +
 * `0065_summary_aggregate_layer.sql`(own 확장 7컬럼·조회 인덱스).
 *
 * 규율 셋:
 *  1. **멱등** — 표마다 `DELETE … WHERE cycle_id = $c` 를 INSERT 앞에 둔다. 집계층은
 *     파티션이 아니라서 세부층처럼 파티션 DROP 으로 지워지지 않는다(§5-1). 이 한 문장이
 *     "같은 generation 재실행(PK 충돌 방지)" 과 "옛 generation 정리"(§5-1 두 번째 DELETE)를
 *     **함께** 해치운다 — 이 tx 가 커밋되면 그 회차의 활성 generation 은 정확히 지금 것이고,
 *     집계층에 다른 generation 행이 남아 있을 이유가 없다. 선두 인덱스는 0065 의
 *     `summary_trend_*_gen (cycle_id, generation_id)`.
 *  2. **스왑과 같은 tx** — `swap.ts::swapGeneration` 이 drift 검사 → retire → **접기** →
 *     activate → publish 를 한 tx 로 돌린다. 접기가 실패하면 집계층 행이 하나도 남지 않는다
 *     (T2 수용 기준 ⑤). 대가는 `FOR SHARE` 보유 시간이 접기 소요만큼 길어지는 것이다.
 *  3. **테넌트 무지** — 이 파일은 HMG 상수를 모른다. 당사 엔티티 id·⑤ 판정 base·폴백
 *     도메인 정규식은 전부 `variants` 인자로 들어온다(`lib/summary/tenant/hmg.ts` 가 유일한 통로).
 *     `own_variant` 목록을 **유도**하는 것은 T3 몫이고, 이 파일은 받은 목록을 쓴다.
 *
 * ⚠️ 산식은 재발명하지 않았다 — 오늘 화면이 쓰는 사실표 리더
 * (`lib/db/repositories/summary-global-aggregates.ts`)의 정의를 그대로 접었다.
 * 특히 ④(우선노출도)는 "job 별 min(first_rank)" 이 **아니라** 답변 안에서 표시명 그룹을
 * 세운 `rank()` 서수다(SGA:205-225, PR #223). 플랜 §3-4 5 의 서술과 다르며 **코드가 이긴다** —
 * 그래서 `summary_trend_brands.rank_sum`(브랜드별 first_rank 합)과
 * `summary_trend_own.rank_sum`(job 별 당사 최선 **서수** 합)은 **정의가 다르다**.
 * `fold.test.ts` 가 그 차이를 형태로 고정한다.
 *
 * 0069(PR④-b)부터 브랜드 표에 **세 번째 양**이 하나 더 있다: `comp_rank_sum` /
 * `comp_ranked_answers` = 그 브랜드의 **답변 안 경쟁 순위** 합·개수. 이것이
 * `summary_trend_own.rank_sum` 과 **같은 축**이고(규칙 정본 = `COMP_RANK_GATE` ·
 * `COMP_RANK_TP` · `compRankOver`, 두 접기가 공유), `rank_sum` 은 GEO 위젯이 쓰는
 * 본문 서수로 남는다. 세 컬럼의 대응은 이렇다:
 *   `trend_own.rank_sum`   ─┐ 같은 축(답변 안 경쟁 순위)
 *   `trend_brands.comp_rank_sum` ─┘
 *   `trend_brands.rank_sum`   … 본문 텍스트 내 서수(`first_rank`) 합 — **다른 양**
 */
import { sql, type SQL } from "drizzle-orm";
import type { GeneratorRuntime } from "./context";
import { AGG_TABLES, AGG_TIMING_KEYS, type GenerationKeys, type SummarySurface } from "./types";

/** 기본 변형 키 — "명부 전체". 테넌트 브랜드명이 아니므로 코어 상수다(플랜 §3-2 실측 R2). */
export const OWN_VARIANT_ALL = "ALL";

/**
 * ⑤ 분자 판정 스코프 — `$sel`(선택 base 목록)과 `$fbRe`(base 정규화 불가 행의 도메인 폴백).
 *
 * `ownedBasePrefixesForScope` 가 (브랜드, 국가, 언어)의 함수라서(플랜 §3-2), 변형이 브랜드를
 * 정하고 키의 `country`·`lang` 이 나머지를 정한다. `country`/`lang` 이 `''` 면 **와일드카드**이고,
 * 여러 행이 맞으면 **더 구체적인 행**(국가·언어를 명시한 행)이 이긴다.
 */
export type OwnCitationScope = {
  /** ISO alpha-2. `''` = 모든 국가. */
  country: string;
  /** 본문 언어 코드(표면별 표기 그대로: 글로벌 대문자·웹사이트 소문자). `''` = 모든 언어. */
  lang: string;
  /** `$sel` — 세부층 `matched_base` 와 같은 정규형으로 접은 base 목록. */
  bases: string[];
  /** `$fbRe` — `domain ~* pat`. 폴백을 안 쓰면 null. */
  fallbackPattern: string | null;
};

/**
 * `own_variant` 하나 — T3 가 명부 스냅샷에서 유도해 넘긴다(이 파일은 만들지 않는다).
 * 지금은 표면 어댑터가 `ALL` 1개를 만들어 넘긴다.
 */
export type OwnVariant = {
  /** `summary_trend_own.own_variant` 에 그대로 들어가는 키. */
  key: string;
  /** `$own` — 당사 롤업 엔티티 id(리더의 `trackedEntityIdsFor` 와 같은 집합). */
  entityIds: string[];
  /** 최소 1행. 비우면 ⑤ 분자가 조용히 0 이 된다(0065 `DEFAULT 0` 마스킹) → 거부한다. */
  citationScopes: OwnCitationScope[];
};

export type FoldArgs = {
  keys: GenerationKeys;
  surface: SummarySurface;
  /** `summary_cycles.cycle_anchor_at` — 집계층 조회의 회차 집합 축. */
  cycleAnchorAt: string;
  variants: OwnVariant[];
  /**
   * ⑤ 분자(`own_citations`)의 **출처**. 표면마다 오늘 화면의 정본이 다르다 —
   * 2026-09-10 실 DB 대조(회차 `a3204f07`): 두 경로가 **83 vs 102, ⑤ 18.04% vs 22.17%** 로 갈렸다.
   *
   *  · `"scope"` — `citationScopes`(=`$sel` + 서픽스 폴백)로 판정한다. **글로벌의 유일한 선택지**다:
   *    글로벌 세부층은 `unit_owned_citations` 가 전 행 NULL 이다(0060 은 웹사이트 전용 —
   *    `surface-global.ts` 머리 주석 · `verify-global-0831.ts:410` 이 0 을 단언).
   *  · `"unit_column"` — 세부층에 굳힌 `summary_domain_citations.unit_owned_citations` 합.
   *    **웹사이트의 정본**이다: 오늘 화면(`summary-website-aggregates.ts::ownedCitationsSum`,
   *    `unitFlags` 경로)이 그 컬럼을 그대로 더한다. 값이 보고서 **유닛의 자기 base** 기준이라
   *    (`surface-website.ts` 의 `unitOwnedSql(ub.base, unb, units)`), 선언 base 전량으로 판정하면
   *    같은 함대의 **다른 사이트 인용이 그 유닛 성과로 샌다**(실측: Kia/NO 유닛에
   *    kia.com/dk·kia.ca/en·worldwide.kia.com/en 등 19 인용이 얹혔다 — 2026-09-01 −12.83%p 와 같은 종류).
   *    이 경로에서는 스코프 판정을 하지 않으므로 `own_fallback_citations` 는 0 이고,
   *    변형(브랜드)과도 무관하다 — 오늘 리더도 브랜드로 좁히지 않는다.
   */
  ownCitationsFrom: "scope" | "unit_column";
};

/** 표 하나분 접기 = DELETE + INSERT. `key` 는 `summary_generations.timings` 키. */
export type FoldBatch = { table: string; key: string; statements: SQL[] };

/** 접기가 도는 tx 의 문장 상한. 스왑 tx 안이라 기본값(DB 설정)에 맡기지 않는다. */
export const FOLD_STATEMENT_TIMEOUT = "10min";

/**
 * 접기 tx 의 `SET LOCAL work_mem`.
 *
 * 기본값(16MB)에서는 `summary_trend_own` 의 최종 집계가 정렬로 잡혀 스필한다 —
 * 2026-09-10 실측(글로벌 `74eca7fb`/gen `be960a1a`·변형 4): 16MB **35,696 ms** ·
 * 64MB 33,321 · 128MB 30,955 · **256MB 13,835**(여기서만 HashAggregate 가 메모리 안에 든다).
 * 4문장 합은 40,189 → 18,658 ms.
 *
 * `LOCAL` 이라 이 tx 에서만 걸리고 커밋에 풀린다. 러너 커넥션이 둘뿐이고
 * (`DB_POOL_MAX=2`) shared_buffers 가 4GB 라 정렬 노드 × 256MB 는 안전 범위다.
 * 덤이 본질에 가깝다: 그 시간만큼 스왑 tx 의 `FOR SHARE` 보유가 줄어 미러
 * `replaceRun` 대기가 짧아진다(접기가 스왑과 한 tx 인 대가 — `swap.ts::FoldPlan` 주석).
 */
export const FOLD_WORK_MEM = "256MB";

// ── 컬럼 목록 ────────────────────────────────────────────────────────────────

/** 집계층 3표(brands·domains·own)의 공통 차원 — depth2/depth3 는 **없다**(0059 PK). */
const AGG_DIMS = [
  "project_id",
  "country",
  "lang",
  "engine",
  "catalog_brands",
  "funnel_catalog",
  "funnel_scope",
  "brand_presence_resolved",
  // 0066 — 0061 의 any-match 정본. 스칼라 `brand_presence_resolved` 와 당분간 공존한다.
  "presence_set",
  "list_type",
  "depth1",
  "in_root_catalog",
  "in_tagged_region",
  "in_full_cycle",
  "run_status",
] as const;

/** `summary_trend_answers` 만 depth2/depth3 까지 키에 갖는다(0059 PK). */
const ANS_DIMS = [
  ...AGG_DIMS.slice(0, AGG_DIMS.indexOf("depth1") + 1),
  "depth2",
  "depth3",
  ...AGG_DIMS.slice(AGG_DIMS.indexOf("depth1") + 1),
] as const;

/** 4표가 공유하는 머리 컬럼. `project_id` 는 차원 쪽에 있다(세부층 행에서 그대로 온다). */
const HEAD_COLS = "cycle_id, generation_id, cycle_anchor_at, cycle_week, surface";

const join = (cols: readonly string[], prefix = "") =>
  cols.map((c) => (prefix ? `${prefix}.${c}` : c)).join(", ");

const raw = (s: string) => sql.raw(s);

/**
 * ⚠️ **세부층은 NULL 을 허용하고 집계층은 아니다.** 0059 의 집계층 4표는 이 차원들을
 * `NOT NULL DEFAULT ''`(배열은 `'{}'`)로 선언하는데, 세부층(`summary_answers` 등)은 카탈로그가
 * 비어 있으면 NULL 을 그대로 담는다. 2026-09-10 라이브 실측(글로벌 8/31 회차):
 * `brand_presence_resolved` 8,088행 · `depth2` 1,644행 · `lang` 16행 · `funnel_catalog`·
 * `list_type`·`depth1`·`depth3` 각 12행이 NULL. 웹사이트 회차는 답변 66행 **전부**가
 * funnel·list_type·depth 계열 NULL 이다.
 *
 * 그대로 접으면 INSERT 가 not-null 위반으로 죽는다. SELECT 만 도는 드라이런으로는 **안 보인다** —
 * 그래서 규칙을 코드에 박고 이유를 여기 적는다. `''` 는 집계층에서 "값 없음" 의 정본 표기이고,
 * 조회 필터(`depth1 = ANY($…)`)는 NULL 이든 `''` 든 어차피 안 맞으므로 의미가 보존된다.
 *
 * GROUP BY 도 **같은 식**을 써야 한다 — PostgreSQL 은 `GROUP BY depth1` 을 출력 별칭이 아니라
 * 입력 컬럼으로 먼저 해석하므로, NULL 그룹과 `''` 그룹이 따로 생겨 `''` 두 줄이 되고 PK 가 깨진다.
 */
const NULLABLE_TEXT_DIMS = new Set([
  "lang",
  "funnel_catalog",
  "funnel_scope",
  "brand_presence_resolved",
  "list_type",
  "depth1",
  "depth2",
  "depth3",
]);
const ARRAY_DIMS = new Set(["catalog_brands", "presence_set"]);

const dimRef = (c: string, prefix: string) => (prefix ? `${prefix}.${c}` : c);
/** 집계층이 NOT NULL 인 차원을 DEFAULT 값으로 접는 식(별칭 없음 — GROUP BY 용). */
function dimGroupExpr(c: string, prefix = ""): string {
  const ref = dimRef(c, prefix);
  if (NULLABLE_TEXT_DIMS.has(c)) return `COALESCE(${ref}, '')`;
  if (ARRAY_DIMS.has(c)) return `COALESCE(${ref}, '{}')`;
  return ref;
}
/** 같은 식 + 별칭(SELECT 용). 별칭이 있어야 아래 CTE·UNION 이 이름으로 이어진다. */
function dimSelectExpr(c: string, prefix = ""): string {
  const e = dimGroupExpr(c, prefix);
  return e === c ? c : `${e} AS ${c}`;
}
const dimSelect = (cols: readonly string[], prefix = "") =>
  cols.map((c) => dimSelectExpr(c, prefix)).join(", ");
const dimGroup = (cols: readonly string[], prefix = "") =>
  cols.map((c) => dimGroupExpr(c, prefix)).join(", ");

/**
 * `report_fs`(0066) — 집계층 4표의 키지만 **세부층에는 `summary_answers` 에만 있다**
 * (2026-09-10 실측: `summary_brand_mentions`·`summary_domain_citations` 에 없다).
 * 그래서 브랜드·도메인 갈래는 `summary_answers` 를 job 으로 조인해 끌어온다 —
 * `reportRef` 가 그 출처 별칭이다(`""` = 답변 표 자신, `"ra."` = 조인해 온 표).
 *
 * 접힘 규약은 `COALESCE(report_fs, 0)`(0066 머리 주석): 세부층은 integer NULL 이고
 * 실값이 1부터라 0 을 "미부여" sentinel 로 쓸 수 있다(글로벌은 전량 NULL→0).
 * GROUP BY 도 같은 식을 써야 NULL 그룹과 0 그룹이 갈리지 않는다.
 */
const reportFsSelect = (reportRef: string) => `COALESCE(${reportRef}report_fs, 0) AS report_fs`;
const reportFsGroup = (reportRef: string) => `COALESCE(${reportRef}report_fs, 0)`;

/** 키 = 차원 + `report_fs`. INSERT 컬럼 목록과 하위 CTE 참조가 쓰는 이름 목록. */
const AGG_KEYS: readonly string[] = [...AGG_DIMS, "report_fs"];
const ANS_KEYS: readonly string[] = [...ANS_DIMS, "report_fs"];

const keySelect = (cols: readonly string[], prefix: string, reportRef: string) =>
  `${dimSelect(cols, prefix)}, ${reportFsSelect(reportRef)}`;
const keyGroup = (cols: readonly string[], prefix: string, reportRef: string) =>
  `${dimGroup(cols, prefix)}, ${reportFsGroup(reportRef)}`;

/**
 * `summary_answers` 를 job 으로 붙이는 조각 — `report_fs` 하나 때문이다.
 *
 * ⚠️ 이 조인은 2026-09-10 수리로 없앤 그 조인과 **성질이 다르다**. 그때 문제였던 것은
 * "CTE 로 만든 대형 집계를 job 으로 조인" 이라, 통계가 없어 rows=1 로 추정되면 그 집계를
 * 바깥 행마다 다시 도는 플랜이 나왔다. 이쪽은 **기본 표 + 유니크 인덱스**
 * (`summary_answers_<주>_pkey (cycle_week, cycle_id, generation_id, job_id)`, 실측)라
 * 플래너가 뭘 고르든 바닥이 있다: 통계가 맞으면 해시 조인, 틀리면 인덱스 nested loop.
 * `--plan --gen=<미통계 uuid>` 로 그 형태를 고정 확인한다.
 */
function reportFsJoin(keys: GenerationKeys, base: string, alias = "ra"): SQL {
  return sql`JOIN summary_answers ${raw(alias)}
      ON ${raw(alias)}.cycle_week = ${keys.cycleWeek}::date
     AND ${raw(alias)}.cycle_id = ${keys.cycleId}::uuid
     AND ${raw(alias)}.generation_id = ${keys.generationId}::uuid
     AND ${raw(alias)}.job_id = ${raw(base)}.job_id`;
}

/** 드라이런(`scripts/summary/fold-dryrun.ts`)이 같은 정규화를 쓰도록 내보낸다. */
export const AGG_KEY_NAMES: readonly string[] = AGG_KEYS;
export const aggKeySelect = (prefix = "", reportRef = "") => keySelect(AGG_DIMS, prefix, reportRef);
export const aggKeyGroup = (prefix = "", reportRef = "") => keyGroup(AGG_DIMS, prefix, reportRef);

/** 세부층 술어 — `cycle_week` 를 함께 걸어 주 파티션을 프루닝한다. */
function detailScope(keys: GenerationKeys): SQL {
  return sql`cycle_week = ${keys.cycleWeek}::date AND cycle_id = ${keys.cycleId}::uuid AND generation_id = ${keys.generationId}::uuid`;
}

/** 같은 술어의 별칭판 — `report_fs` 조인이 들어와 컬럼이 모호해진 문장이 쓴다. */
function detailScope2(keys: GenerationKeys, alias: string): SQL {
  const a = raw(`${alias}.`);
  return sql`${a}cycle_week = ${keys.cycleWeek}::date AND ${a}cycle_id = ${keys.cycleId}::uuid AND ${a}generation_id = ${keys.generationId}::uuid`;
}

/**
 * 머리 값 5개. **별칭을 붙인다** — INSERT 는 위치로 매핑하니 필요 없지만, 드라이런
 * (`scripts/summary/fold-dryrun.ts`)이 이 SELECT 를 서브쿼리로 감싸 이름으로 집계한다.
 * 이름 없는 리터럴 5개가 `?column?` 로 겹치는 것을 피한다.
 */
function headValues(a: FoldArgs): SQL {
  return sql`${a.keys.cycleId}::uuid AS cycle_id, ${a.keys.generationId}::uuid AS generation_id,
             ${a.cycleAnchorAt}::timestamptz AS cycle_anchor_at, ${a.keys.cycleWeek}::date AS cycle_week,
             ${a.surface} AS surface`;
}

/**
 * 멱등·정리 겸용 DELETE (규율 1). `cycle_week` 를 안 거는 이유: 집계층은 파티션이 아니고
 * 0065 의 정리 인덱스가 `(cycle_id, generation_id)` 라 선두 컬럼만으로 충분하다.
 */
function purgeSql(table: string, keys: GenerationKeys): SQL {
  return sql`DELETE FROM ${raw(table)} WHERE cycle_id = ${keys.cycleId}::uuid`;
}

// ── ① summary_trend_answers ─────────────────────────────────────────────────

const ANSWERS_MEASURES = ["monitored", "all_mentions", "all_citations", "has_any_brand"];

export function foldTrendAnswersSelect(a: FoldArgs): SQL {
  return sql`
    SELECT ${headValues(a)}, ${raw(keySelect(ANS_DIMS, "", ""))},
           COALESCE(sum(monitored), 0)::int AS monitored,
           COALESCE(sum(all_mentions), 0)::int AS all_mentions,
           COALESCE(sum(all_citations), 0)::int AS all_citations,
           COALESCE(sum(has_any_brand), 0)::int AS has_any_brand
    FROM summary_answers
    WHERE ${detailScope(a.keys)}
    GROUP BY ${raw(keyGroup(ANS_DIMS, "", ""))}
  `;
}

// ── ② summary_trend_brands ──────────────────────────────────────────────────

/**
 * **④ 축의 단일 정본** — "답변 안 경쟁 순위"(competitive rank). `own`(카드 ④)과
 * `brands`(카드 하단 경쟁사 행)가 **같은 규칙을 같은 문자열로** 쓴다.
 *
 * 규칙 셋(미러 `scope-aggregates.ts:3362-3371` 의 `pos`→`rk` 와 동치):
 *   ⓐ 모집단 — `is_competitor = 1`(비경쟁 노이즈 제외를 통과한 행) **그리고** `first_rank`
 *      가 있는 행만. 미러의 `excludeNonCompetitorBaresSql` + `WHERE avg_position IS NOT NULL`.
 *   ⓑ 그레인 — **표시명(`brand_name`)** 으로 접고 그 job 의 최선 서수를 대표값으로 쓴다
 *      (`min(first_rank)`). `brand_id` 로 접으면 같은 표시명이 여러 줄로 서서 순위가
 *      밀린다(SGA:205-225, PR #223). 미러의 `pos AS (… min(avg_position) … GROUP BY name, job)`.
 *   ⓒ 순위 — 답변(job) 안에서 `rank()`. **동률은 같은 순위를 받고 다음 순위를 건너뛴다**
 *      (PG `rank()` 의 정의 — `dense_rank()` 가 아니다). 미러도 `rank()` 라 두 층이 같다.
 *      ⚠️ `dense_rank()` 로 바꾸면 동률이 있는 답변에서만 값이 갈려 **평균이 조용히 낮아진다**.
 *
 * `own` 은 여기에 `own_variant` 를 파티션에 더하고(변형마다 당사 집합이 다르다) 그 job 의
 * 당사 최선 순위 하나만 남기며(`min(rk)`), `brands` 는 파티션이 job 뿐이고 **모든 표시명**의
 * 순위를 각자 합한다. 규칙 ⓐ~ⓒ 는 글자 그대로 공유한다 — 한쪽만 바뀌면 축이 다시 갈린다.
 */
const COMP_RANK_GATE = "m.is_competitor = 1 AND m.first_rank IS NOT NULL";
/** ⓑ — 표시명 그룹의 대표 서수. */
const COMP_RANK_TP = "min(m.first_rank) AS tp";
/** ⓒ — 답변 안 순위. `extraPartition` 은 `own` 의 `, own_variant` 뿐이다. */
const compRankOver = (extraPartition: string) =>
  `rank() OVER (PARTITION BY job_id${extraPartition} ORDER BY tp) AS rk`;

/**
 * 브랜드 표 측정값의 **정본 순서**. 두 갈래(`pm`·`pr`)가 같은 순서·같은 타입으로 내야
 * `UNION ALL` 이 성립한다. 손으로 자리를 세지 않으려고 이름으로 채운다(`own` 과 같은 자세).
 */
const BRAND_MEASURE_COLS = [
  "is_competitor", "mentions", "answers", "rank_sum", "ranked_answers", "top3_answers",
  "positive", "neutral", "negative", "mixed",
  "type_mention", "type_recommendation", "type_comparison", "type_definition", "type_final_choice",
  // 0069 — 답변 안 경쟁 순위(④ 축). `rank_sum` 과 **다른 양**이다(위 COMP_RANK_GATE 주석).
  "comp_rank_sum", "comp_ranked_answers",
] as const;

/**
 * 안 채운 칸의 중립값. `UNION ALL` 은 **타입까지** 맞아야 하므로 갈래별로 고르지 않고 여기서 고정한다.
 *
 * ⚠️ `rank_sum` 만 `NULL` 이다 — 0059 에서 이 컬럼만 nullable 이고, 종전 접기가
 * `sum(...) FILTER (...)` 로 **순위 없는 브랜드에 NULL 을 넣었다**. 여기에 `0` 을 쓰면
 * 바깥 `sum()` 이 NULL 을 무시해 그 브랜드의 `rank_sum` 이 NULL → 0 으로 **조용히 바뀐다**
 * (리더가 `ranked_answers > 0` 로 나누므로 화면 값은 안 변하지만, 감사에서 "순위가 없었다"와
 * "순위 합이 0이다"가 구분되지 않는다). 새 컬럼 둘은 `NOT NULL DEFAULT 0`(0069)이라 0 이 정본이다.
 */
const BRAND_MEASURE_ZERO: Record<(typeof BRAND_MEASURE_COLS)[number], string> = {
  is_competitor: "0::int",
  mentions: "0::bigint",
  answers: "0::bigint",
  rank_sum: "NULL::real",
  ranked_answers: "0::bigint",
  top3_answers: "0::bigint",
  positive: "0::bigint",
  neutral: "0::bigint",
  negative: "0::bigint",
  mixed: "0::bigint",
  type_mention: "0::bigint",
  type_recommendation: "0::bigint",
  type_comparison: "0::bigint",
  type_definition: "0::bigint",
  type_final_choice: "0::bigint",
  comp_rank_sum: "0::real",
  comp_ranked_answers: "0::bigint",
};

function brandMeasures(
  filled: Partial<Record<(typeof BRAND_MEASURE_COLS)[number], string>>,
): string {
  for (const k of Object.keys(filled)) {
    if (!(BRAND_MEASURE_COLS as readonly string[]).includes(k)) {
      throw new Error(`fold: 알 수 없는 브랜드 측정값 ${k}`);
    }
  }
  return BRAND_MEASURE_COLS.map((c) => `${filled[c] ?? BRAND_MEASURE_ZERO[c]} AS ${c}`).join(", ");
}

/**
 * 세부층 PK 가 `(job, brand_id, brand_name)` 이라 `first_rank` 는 **이미 그 job·그 브랜드의
 * 최소값**이다(생성기 `load.ts::insertBrandMentionsSql` 의 `bg.min(avg_position)`).
 * 그래서 여기서 다시 MIN 을 취하지 않는다 — 브랜드별 합이 맞다.
 *
 * ⚠️ `is_competitor` 는 **GROUP BY 에 넣지 않는다 — 집계로 접는다**(2026-09-10 개정).
 *
 * 원래는 GROUP BY 에 넣고 "갈리면 시끄럽게 실패" 를 골랐고, 그 근거는 당시 활성 회차
 * (8/31·9/04)에서 mixed_groups=0 이라는 실측이었다. **과거 회차 백필이 그 전제를 깼다** —
 * 23505 로 첫 글로벌 6월 회차에서 죽었고, 전 회차 100개 전수 재측정 결과:
 *
 *   글로벌 `47f21102…` 15그룹 · `6d3be50f…` 8 · `fc5f2073…` 8 · `ab542053…` 4  (합 35)
 *   웹사이트 95회차 · 현행 글로벌 8/31 : **0**
 *
 * 즉 같은 `brand_id` 가 한 키 그룹 안에서 `is_competitor` 0/1 을 모두 갖는 과거 데이터가
 * 실재한다(예: `Smart` · DE · gemini · evaluation · partial_failed). 판별자가 PK 에 없는
 * 이상 "실패" 는 선택지가 아니다 — 백필 전체가 멈춘다.
 *
 * collapse 가 실제로 바꾸는 것(정확히):
 *   ⓐ **행별 `is_competitor` 라벨** — `max()` 로 하나가 된다.
 *   ⓑ **그 두 행의 측정값이 합산된다** — GROUP BY 에서 빼면 행이 합쳐지므로 `mentions`
 *      (예: 30 + 92)·`answers`·`positive`/`neutral`/`negative`/`mixed`·`type_*`·
 *      `rank_sum`/`ranked_answers`/`top3_answers` 가 전부 한 행에 더해진다.
 *      ⓐ 만 바뀐다고 적었던 것은 **틀렸다** — 합산이 본질이다.
 *   ⓒ **KPI 분모는 영향받지 않는다.** ②의 `comp_mentions`·`own_mentions` 는 `ob`·`bn`
 *      갈래가 세부층에서 직접 `FILTER (WHERE m.is_competitor = 1)` 로 낸다 — 이 표를 안 본다.
 *      즉 ⓑ 의 합산은 **브랜드 순위표 안에서만** 보인다.
 *
 * `max()` 인 근거(= "한 번이라도 경쟁사면 경쟁사"):
 *   · `min()` 이면 그 브랜드가 순위표의 경쟁사 집합에서 통째로 빠진다 — ⓑ 로 합쳐진
 *     측정값까지 함께 사라져 값이 조용히 준다.
 *   · `max()` 는 그 브랜드를 남기고 비경쟁 언급 몇 건을 함께 센다. 규모는 35그룹/4회차,
 *     실측 최대 사례가 브랜드 "Smart" 오탐 **92 mentions / 975,711** 이라 후자가 훨씬 작다.
 *   · 세부층 쪽 정본도 같은 모노이드다(`bool_or(pass)::int`) — 두 층이 같은 방향으로 접는다.
 *
 * 재발 방지: `fold.test.ts` 가 **GROUP BY 항이 PK 의 부분집합인지** 표마다 검사하고,
 * `fold-dryrun.ts` 가 실데이터로 "접기 결과 PK 중복 0" 을 단언한다.
 *
 * ── 0069: `comp_rank_sum`·`comp_ranked_answers` (PR④-b) ─────────────────────
 *
 * **왜** — 카드 ④(당사 우선노출도)는 `trend_own.rank_sum` = 답변 안 경쟁 순위인데, 그 바로
 * 아래 경쟁사 행이 `trend_brands.rank_sum` = 본문 **텍스트 내 서수**(`first_rank`)를 쓰면
 * 같은 카드에서 축이 갈린다(같은 회차 `74eca7fb` 실측: Hyundai 경쟁 **3.3469** vs 서수
 * **16.4041** · Tesla 3.9765/18.9899 — 7개 전체 정본표는 마이그레이션
 * `0069_summary_trend_brands_comp_rank.sql` 헤더에 있다. 여기 복사하지 마라).
 * 그래서 **경쟁 순위를 집계층에 굳혀** 두 값이 같은 축이 되게 한다.
 * `rank_sum` 은 **지우지 않는다** — GEO 위젯(`toGeoKpi` 의 `posSum`/`posCnt`)이 그 정의를 쓴다.
 *
 * **구조** — `UNION ALL` 두 갈래다(`own` 과 같은 이유: 교차 테이블 조인을 만들지 않는다).
 *   · `pm` — 브랜드 그레인 측정값. 종전 문장 그대로다(스캔 1회).
 *   · `bp`→`rk`→`pr` — 경쟁 순위. `bp` 가 **(job, 표시명)** 으로 접고 `rk` 가 답변 안 순위를
 *     매긴다(위 `COMP_RANK_*` 규칙 = `own` 과 같은 것).
 *
 * ⚠️ **왜 대표 `brand_id` 하나에 몰아주나** — 순위의 그레인은 **표시명**인데 이 표의 키는
 * `(brand_id, brand_name)` 이다. 한 표시명에 `brand_id` 가 둘 이상인 경우가 실재하고
 * (2026-09-10 글로벌 `74eca7fb`: 표시명 1,103개 중 10개), 그 둘에 순위를 각각 얹으면
 * **리더가 표시명으로 롤업할 때 같은 답변이 두 번 세어진다**(= 미러와 불일치). 그래서
 * `pr` 은 그 키 그룹·그 표시명의 **`min(brand_id)` 한 행에만** 합을 싣는다.
 *   · 리더(`summary-trend-aggregates.ts::trendBrandsSql`)의 GROUPING SET 은 **전부
 *     `brand_name` 을 포함**하므로(`(brand_name)`·`(country, brand_name)`·엔진·회차 축) 롤업
 *     결과는 미러와 정확히 같다. `brand_id` 단독으로 이 두 컬럼을 읽는 소비자는 **없다**.
 *   · 대표 행은 반드시 `pm` 에도 있다(같은 세부층 행에서 나왔다) — 새 PK 행이 생기지 않는다.
 *   · ⚠️ **`::text` 를 거쳐 고른다** — PostgreSQL 17 에는 `min(uuid)` 집계가 **없다**
 *     (2026-09-10 실측 `pg_proc`: min 의 인자 타입 22종에 uuid 없음. uuid min/max 는 PG 18
 *     부터다). 캐스트 없이 쓰면 42883 `function min(uuid) does not exist` 로 접기가 죽는다.
 *     uuid 의 텍스트 표현은 정규형(소문자 hex + 하이픈)이라 텍스트 순서가 uuid 순서와 같고,
 *     어차피 필요한 것은 **결정적인 대표 하나**뿐이다.
 *   · 대표 행의 `is_competitor` 는 반드시 1 이다(`bp` 게이트를 통과한 행이 있으므로
 *     `max()` 가 1) — 리더의 `WHERE is_competitor = 1` 에 걸려 사라지지 않는다.
 *
 * ⚠️ 세부층은 **안 건드린다**. 경쟁 순위는 `summary_brand_mentions` 안에서 job 창 함수로
 *    전부 계산되므로(위 `bp`) 세부층에 새 컬럼이 필요 없다.
 */
const BRANDS_MEASURES = ["brand_id", "brand_name", ...BRAND_MEASURE_COLS];

export function foldTrendBrandsSelect(a: FoldArgs): SQL {
  const keysSelM = raw(keySelect(AGG_DIMS, "m", "ra."));
  const keysGrpM = raw(keyGroup(AGG_DIMS, "m", "ra."));
  const rjM = reportFsJoin(a.keys, "m");
  const scopeM = detailScope2(a.keys, "m");
  const D = raw(join(AGG_KEYS));
  return sql`
    WITH
    -- (A) 브랜드 그레인 측정값 — 0069 이전의 문장 그대로.
    pm AS (
      SELECT ${keysSelM}, m.brand_id, m.brand_name,
             ${raw(
               brandMeasures({
                 is_competitor: "max(m.is_competitor)::int",
                 mentions: "COALESCE(sum(m.mentions), 0)::bigint",
                 answers: "count(DISTINCT m.job_id)::bigint",
                 rank_sum: "(sum(m.first_rank) FILTER (WHERE m.first_rank IS NOT NULL))::real",
                 ranked_answers: "count(*) FILTER (WHERE m.first_rank IS NOT NULL)::bigint",
                 top3_answers: "count(*) FILTER (WHERE m.first_rank <= 3)::bigint",
                 positive: "COALESCE(sum(m.positive), 0)::bigint",
                 neutral: "COALESCE(sum(m.neutral), 0)::bigint",
                 negative: "COALESCE(sum(m.negative), 0)::bigint",
                 mixed: "COALESCE(sum(m.mixed), 0)::bigint",
                 type_mention: "COALESCE(sum(m.type_mention), 0)::bigint",
                 type_recommendation: "COALESCE(sum(m.type_recommendation), 0)::bigint",
                 type_comparison: "COALESCE(sum(m.type_comparison), 0)::bigint",
                 type_definition: "COALESCE(sum(m.type_definition), 0)::bigint",
                 type_final_choice: "COALESCE(sum(m.type_final_choice), 0)::bigint",
               }),
             )}
      FROM summary_brand_mentions m
      ${rjM}
      WHERE ${scopeM}
      GROUP BY ${keysGrpM}, m.brand_id, m.brand_name
    ),

    -- (B) 답변 안 경쟁 순위 — own 의 bp/rk 와 **같은 규칙**(COMP_RANK_* 주석).
    bp AS (
      SELECT ${keysSelM}, m.job_id, m.brand_name,
             ${raw(COMP_RANK_TP)}, min(m.brand_id::text) AS rep_brand_id
      FROM summary_brand_mentions m
      ${rjM}
      WHERE ${scopeM} AND ${raw(COMP_RANK_GATE)}
      GROUP BY ${keysGrpM}, m.job_id, m.brand_name
    ),
    rk AS (
      SELECT ${D}, brand_name, rep_brand_id, ${raw(compRankOver(""))}
      FROM bp
    ),
    pr AS (
      SELECT ${D}, min(rep_brand_id)::uuid AS brand_id, brand_name,
             ${raw(
               brandMeasures({
                 comp_rank_sum: "sum(rk)::real",
                 comp_ranked_answers: "count(*)::bigint",
               }),
             )}
      FROM rk GROUP BY ${D}, brand_name
    ),

    parts AS (SELECT * FROM pm UNION ALL SELECT * FROM pr)
    SELECT ${headValues(a)}, ${D}, brand_id, brand_name,
           max(is_competitor)::int AS is_competitor,
           COALESCE(sum(mentions), 0)::int AS mentions,
           COALESCE(sum(answers), 0)::int AS answers,
           sum(rank_sum)::real AS rank_sum,
           COALESCE(sum(ranked_answers), 0)::int AS ranked_answers,
           COALESCE(sum(top3_answers), 0)::int AS top3_answers,
           COALESCE(sum(positive), 0)::int AS positive,
           COALESCE(sum(neutral), 0)::int AS neutral,
           COALESCE(sum(negative), 0)::int AS negative,
           COALESCE(sum(mixed), 0)::int AS mixed,
           COALESCE(sum(type_mention), 0)::int AS type_mention,
           COALESCE(sum(type_recommendation), 0)::int AS type_recommendation,
           COALESCE(sum(type_comparison), 0)::int AS type_comparison,
           COALESCE(sum(type_definition), 0)::int AS type_definition,
           COALESCE(sum(type_final_choice), 0)::int AS type_final_choice,
           COALESCE(sum(comp_rank_sum), 0)::real AS comp_rank_sum,
           COALESCE(sum(comp_ranked_answers), 0)::int AS comp_ranked_answers
    FROM parts
    GROUP BY ${D}, brand_id, brand_name
  `;
}

// ── ③ summary_trend_domains ─────────────────────────────────────────────────

/**
 * `domain` 은 0059 PK 에 없다. 출처 도넛이 `GROUP BY domain` 이라(§3-4 9) 값은 남겨야
 * 하지만, **GROUP BY 에 넣으면 brands 와 같은 23505 폭탄**이 된다(같은 `group_key` 에
 * 도메인이 둘 이상이면 PK 가 겹친다). 그래서 `min()` 으로 접는다.
 *
 * 실측(2026-09-10, **전 회차 100개 전수**): 그런 그룹은 **0건**이다 — 지금은 어느 값을
 * 골라도 같다. 그럼에도 방어를 넣는 이유는 brands 가 정확히 이 형태로 터졌기 때문이다.
 * "지금 0건" 은 과거 데이터에 대한 보장이 아니었다.
 * `min()` 은 세부층 생성기(`load.ts::insertDomainCitationsSql` 의 `min(c2.domain)`)와 같은
 * 선택이라 두 층이 같은 대표값을 고른다.
 */
const DOMAINS_MEASURES = [
  "group_key", "domain", "matched_base", "base_norm_null", "citations", "citing_answers",
  // 0066 블록 ①-b — 웹사이트 ⑤ 분자·인용표 is_ours 의 정본. 글로벌 세부층은 전 행 NULL 이라
  // 전부 0 이 된다. 음수가 없어(T1 실측) 리더의 `sum(x) > 0` 이 오늘의 `bool_or(x > 0)` 과 같다.
  "unit_owned_citations",
];

export function foldTrendDomainsSelect(a: FoldArgs): SQL {
  return sql`
    SELECT ${headValues(a)}, ${raw(keySelect(AGG_DIMS, "c", "ra."))},
           c.group_key, min(c.domain) AS domain,
           COALESCE(c.matched_base, '') AS matched_base, c.base_norm_null,
           COALESCE(sum(c.citations), 0)::int AS citations,
           count(DISTINCT c.job_id)::int AS citing_answers,
           COALESCE(sum(c.unit_owned_citations), 0)::int AS unit_owned_citations
    FROM summary_domain_citations c
    ${reportFsJoin(a.keys, "c")}
    WHERE ${detailScope2(a.keys, "c")}
    GROUP BY ${raw(keyGroup(AGG_DIMS, "c", "ra."))},
             c.group_key, COALESCE(c.matched_base, ''), c.base_norm_null
  `;
}

// ── ④ summary_trend_own (KPI 엔진) ──────────────────────────────────────────

const uuidArrayParam = (ids: string[]): SQL => sql`${sql.param(ids)}::uuid[]`;
const textArrayParam = (vals: string[]): SQL => sql`${sql.param(vals)}::text[]`;

/** `v(own_variant, ids)` — 변형 목록. */
function variantValues(variants: OwnVariant[]): SQL {
  return sql.join(
    variants.map((v) => sql`(${v.key}::text, ${uuidArrayParam(v.entityIds)})`),
    sql`, `,
  );
}

/** `vs(own_variant, country, lang, bases, pat)` — ⑤ 판정 스코프. */
function scopeValues(variants: OwnVariant[]): SQL {
  const rows: SQL[] = [];
  for (const v of variants) {
    for (const s of v.citationScopes) {
      rows.push(
        sql`(${v.key}::text, ${s.country}::text, ${s.lang}::text, ${textArrayParam(s.bases)}, ${s.fallbackPattern}::text)`,
      );
    }
  }
  return sql.join(rows, sql`, `);
}

/**
 * `summary_trend_own` 접기.
 *
 * 구조(§5-1: "job 단위 서브쿼리가 한 겹 필요하다"):
 *   · `a`  — 답변 그레인(모수·전체 인용). 키 그룹이 job 을 **분할**하므로 여기서 나온
 *            모든 합은 그룹 간 가산이다(§3-4 전제).
 *   · `ob` — job×변형 당사 언급. **비경쟁 게이트 없음**(리더 ①·③ 모집단, SGA:236-239·286-290).
 *   · `cm` — job 별 경쟁 브랜드 총언급(② 분모). `is_competitor = 1` 만(SGA:406-411).
 *   · `rj` — job×변형 당사 최선 **서수**. `bp`(표시명 접기) → `rank()` → `min`.
 *            규칙 정본은 `COMP_RANK_GATE`/`COMP_RANK_TP`/`compRankOver`(② 브랜드 접기 위)이고
 *            `brands` 의 `comp_rank_sum` 과 **글자 그대로 같은 것**을 쓴다 — 한쪽만 바꾸면
 *            카드 ④와 그 아래 경쟁사 행의 축이 다시 갈린다(0069 가 고친 그 결함).
 *            표시명으로 접는 이유는 SGA:205-225 주석 참고(id 로 접으면 top3 경계가 밀린다).
 *   · `oc` — job×변형 ⑤ 분자. **표면마다 출처가 다르다**(`FoldArgs.ownCitationsFrom`):
 *            `"scope"`(글로벌)는 `vsel` 이 (변형, country, lang) → ($sel, $fbRe) 를 **한 행으로**
 *            확정하고(가장 구체적인 스코프가 이긴다 — LATERAL 이 행마다 도는 것을 막으려고
 *            데이터에 실제로 있는 (country, lang) 조합에 대해서만 미리 푼다),
 *            `"unit_column"`(웹사이트)은 세부층에 굳힌 `unit_owned_citations` 를 그냥 더한다.
 *   · `tile` — ② 타일 분자. **유일하게 job 으로 분해되지 않는 값**이라(표시명 그룹의
 *            `bool_or` 를 키 그룹 안에서 확정해야 한다, §3-4 3) 별도 그레인이다.
 *            그래서 마지막 합이 `LEFT JOIN`(차원 14개 조인)이 아니라 **UNION ALL + GROUP BY** 다.
 */
const OWN_MEASURES = [
  "own_variant",
  // 0059
  "monitored", "tracked_answers", "multi_answers", "top1_answers", "top3_answers",
  "rank_sum", "ranked_answers", "own_mentions", "own_positive", "own_signals", "prompts_tracked",
  // 0065 확장 7컬럼 — 하나라도 빠지면 `DEFAULT 0` 이 조용히 메운다(fold.test.ts 가 감시).
  "comp_mentions", "all_citations", "own_citations", "own_fallback_citations",
  "tile_own_mentions", "citing_answers", "prompts_measured",
  // 0067 — Sub-KPI negativeMentions. own_signals 의 부분합이라 같은 `pb` 갈래에서 낸다.
  "own_negative",
];

/** 19 측정값의 정본 순서 — 다섯 갈래가 **같은 순서·같은 타입**으로 내야 UNION ALL 이 성립한다. */
const OWN_MEASURE_COLS = [
  "monitored", "tracked_answers", "multi_answers", "top1_answers", "top3_answers",
  "rank_sum", "ranked_answers", "own_mentions", "own_positive", "own_signals", "prompts_tracked",
  "comp_mentions", "all_citations", "own_citations", "own_fallback_citations",
  "tile_own_mentions", "citing_answers", "prompts_measured",
  "own_negative",
] as const;

/**
 * 한 갈래의 측정값 19칸(0067 에서 `own_negative` 추가). 채우지 않은 칸은 `0::bigint` 다 — 바깥 GROUP BY 가 합할 때
 * 서로의 값을 건드리지 않는다. 손으로 자리를 세지 않으려고 **이름으로** 채운다
 * (2026-09-10: 손으로 세다 한 칸 밀린 적이 있다).
 */
function ownMeasures(filled: Partial<Record<(typeof OWN_MEASURE_COLS)[number], string>>): string {
  for (const k of Object.keys(filled)) {
    if (!(OWN_MEASURE_COLS as readonly string[]).includes(k)) throw new Error(`fold: 알 수 없는 측정값 ${k}`);
  }
  return OWN_MEASURE_COLS.map((c) => `${filled[c] ?? "0::bigint"} AS ${c}`).join(", ");
}

/**
 * `summary_trend_own` 접기 — **교차 테이블 조인 0개**.
 *
 * ⚠️ 왜 조인을 없앴나 (2026-09-10 프로덕션 실패의 근본 원인):
 * 접기는 스왑 tx 안에서 도는데, 그 시점의 세부층 행은 **방금 들어간 새 `generation_id`** 다.
 * `pg_statistic`(과 0062 확장통계 MCV)에 그 값이 없어 플래너가 `WHERE cycle_id=… AND
 * generation_id=<new>` 를 **rows=1** 로 추정한다. 실측(EXPLAIN, 통계에 없는 uuid):
 * answers/brands/domains 는 3,902·22,911·9,610 → **1**, own 은 562 → **2**.
 * 앞 3문장은 조인이 없어 추정이 틀려도 해시집계 한 번이면 끝나지만, 종전 own 은 CTE 5개를
 * job_id 로 조인해서 **모든 조인이 Nested Loop 로 뒤집혔다**(Hash Join 1 → 0, Nested Loop
 * 6 → 11). 38,748 답변행마다 229,323행 집계를 다시 도는 플랜이라 3.2 s 짜리가 **>600 s**
 * (statement timeout)로 죽었다. 웹사이트 회차(66셀)는 규모가 작아 통과했다 — 그래서
 * 드라이런에서도 안 보였다.
 *
 * 고친 방식: 필요한 값을 **표별로 따로** (차원, 변형) 그레인까지 접고 `UNION ALL` 로 합한다.
 * 남는 조인은 `CROSS JOIN v`(변형 ≤4행)와 `LEFT JOIN LATERAL vs`(스코프, 변형당 보통 1행)
 * 뿐이라 통계가 어떻든 비용이 **행수에 선형**이다. 다섯 갈래가 각각 한 번씩 스캔한다:
 *   · `pa`  답변 표 → 모수·전체 인용·인용 있는 답변·측정 프롬프트
 *   · `pb`  브랜드 표(당사 행) → 노출·복수언급·②분자·③·추적 프롬프트
 *   · `pc`  브랜드 표(경쟁 통과 행, 표시명 그레인) → ②분모·타일 분자
 *   · `pd`  브랜드 표(순위) → ④ 서수 합·top1/top3
 *   · `pe`  도메인 표 → ⑤ 분자 두 갈래
 *
 * 산식 정본은 리더 `summary-global-aggregates.ts` 다. 특히 top1/top3/ranked 를 `pd` 한
 * 갈래로 낼 수 있는 근거: 순위 행(`rj`)이 존재하려면 그 job 에 `is_competitor=1` 인 당사
 * 브랜드 행이 있어야 하므로 **순위가 있는 job 은 반드시 tracked 다**(리더의
 * `o.job_id IS NOT NULL AND COALESCE(o.tp,100) <= N` 과 같은 집합). 실측으로도
 * `tracked_answers = ranked_answers = 25,210`(글로벌 8/31)로 일치했다.
 */
export function foldTrendOwnSelect(args: FoldArgs): SQL {
  const scope = detailScope(args.keys);
  // 답변 표 갈래는 `report_fs` 를 자기가 갖고 있고, 브랜드·도메인 갈래는 조인해 온다(0066).
  const keysSelA = raw(keySelect(AGG_DIMS, "", ""));
  const keysGrpA = raw(keyGroup(AGG_DIMS, "", ""));
  const keysSelM = raw(keySelect(AGG_DIMS, "m", "ra."));
  const keysGrpM = raw(keyGroup(AGG_DIMS, "m", "ra."));
  const keysSelC = raw(keySelect(AGG_DIMS, "c", "ra."));
  const keysGrpC = raw(keyGroup(AGG_DIMS, "c", "ra."));
  const rjM = reportFsJoin(args.keys, "m");
  const rjC = reportFsJoin(args.keys, "c");
  const scopeM = detailScope2(args.keys, "m");
  const scopeC = detailScope2(args.keys, "c");
  const D = raw(join(AGG_KEYS));
  // ⑤ 분자의 출처(T3). `unit_column` 이면 스코프 판정을 아예 하지 않으므로 `vs` VALUES 를
  // 만들지 않는다 — 안 쓰는데 계산만 하는 CTE 를 남기지 않는다(변형 4개면 840행짜리다).
  const byUnitColumn = args.ownCitationsFrom === "unit_column";
  const scopeCte = byUnitColumn
    ? sql``
    : sql`
    vs(own_variant, country, lang, bases, pat) AS (VALUES ${scopeValues(args.variants)}),`;
  return sql`
    WITH v(own_variant, ids) AS (VALUES ${variantValues(args.variants)}),${scopeCte}

    -- (A) 답변 표 — 키 그룹이 job 을 분할하므로 여기 합은 전부 그룹 간 가산이다(§3-4 전제).
    pa AS (
      SELECT ${keysSelA}, v.own_variant,
             ${raw(
               ownMeasures({
                 monitored: "COALESCE(sum(monitored), 0)::bigint",
                 all_citations: "COALESCE(sum(all_citations), 0)::bigint",
                 citing_answers: "count(*) FILTER (WHERE all_citations > 0)::bigint",
                 prompts_measured: "count(DISTINCT prompt_id)::bigint",
               }),
             )}
      FROM summary_answers CROSS JOIN v
      WHERE ${scope}
      GROUP BY ${keysGrpA}, v.own_variant
    ),

    -- (B) 당사 브랜드 행 — **비경쟁 게이트 없음**(리더 ①·③ 모집단, SGA:236-239·286-290).
    ob AS (
      SELECT ${keysSelM}, v.own_variant, m.job_id, m.prompt_id,
             sum(m.mentions)::bigint AS mc,
             COALESCE(sum(m.mentions) FILTER (WHERE m.is_competitor = 1), 0)::bigint AS mc_comp,
             COALESCE(sum(m.positive), 0)::bigint AS pos,
             COALESCE(sum(m.negative), 0)::bigint AS neg,
             COALESCE(sum(m.positive) + sum(m.neutral) + sum(m.negative) + sum(m.mixed), 0)::bigint AS sig
      FROM summary_brand_mentions m CROSS JOIN v ${rjM}
      WHERE ${scopeM} AND m.brand_id = ANY(v.ids)
      GROUP BY ${keysGrpM}, v.own_variant, m.job_id, m.prompt_id
    ),
    pb AS (
      SELECT ${D}, own_variant,
             ${raw(
               ownMeasures({
                 tracked_answers: "count(*)::bigint",
                 multi_answers: "count(*) FILTER (WHERE mc >= 2)::bigint",
                 own_mentions: "COALESCE(sum(mc_comp), 0)::bigint",
                 own_positive: "COALESCE(sum(pos), 0)::bigint",
                 own_negative: "COALESCE(sum(neg), 0)::bigint",
                 own_signals: "COALESCE(sum(sig), 0)::bigint",
                 prompts_tracked: "count(DISTINCT prompt_id)::bigint",
               }),
             )}
      FROM ob GROUP BY ${D}, own_variant
    ),

    -- (C) ② 분모와 타일 분자 — 표시명 그룹의 bool_or 를 **키 그룹 안에서** 확정한다(§3-4 3).
    bn AS (
      SELECT ${keysSelM}, v.own_variant, m.brand_name,
             COALESCE(sum(m.mentions), 0)::bigint AS mn,
             bool_or(m.brand_id = ANY(v.ids)) AS is_own
      FROM summary_brand_mentions m CROSS JOIN v ${rjM}
      WHERE ${scopeM} AND m.is_competitor = 1
      GROUP BY ${keysGrpM}, v.own_variant, m.brand_name
    ),
    pc AS (
      SELECT ${D}, own_variant,
             ${raw(
               ownMeasures({
                 comp_mentions: "COALESCE(sum(mn), 0)::bigint",
                 tile_own_mentions: "COALESCE(sum(mn) FILTER (WHERE is_own), 0)::bigint",
               }),
             )}
      FROM bn GROUP BY ${D}, own_variant
    ),

    -- (D) ④ 우선노출도 — 표시명으로 접고 답변 안에서 rank(). id 로 접으면 top3 경계가
    --     밀린다(SGA:205-225, PR #223). 규칙 정본 = COMP_RANK_* (brands 와 공유, 0069).
    bp AS (
      SELECT ${keysSelM}, v.own_variant, m.job_id, m.brand_name,
             ${raw(COMP_RANK_TP)},
             bool_or(m.brand_id = ANY(v.ids)) AS is_own
      FROM summary_brand_mentions m CROSS JOIN v ${rjM}
      WHERE ${scopeM} AND ${raw(COMP_RANK_GATE)}
      GROUP BY ${keysGrpM}, v.own_variant, m.job_id, m.brand_name
    ),
    rk AS (
      SELECT ${D}, own_variant, job_id, is_own,
             ${raw(compRankOver(", own_variant"))}
      FROM bp
    ),
    rj AS (
      SELECT ${D}, own_variant, job_id, min(rk)::int AS tp
      FROM rk WHERE is_own GROUP BY ${D}, own_variant, job_id
    ),
    pd AS (
      SELECT ${D}, own_variant,
             ${raw(
               ownMeasures({
                 top1_answers: "count(*) FILTER (WHERE tp <= 1)::bigint",
                 top3_answers: "count(*) FILTER (WHERE tp <= 3)::bigint",
                 rank_sum: "COALESCE(sum(tp), 0)::bigint",
                 ranked_answers: "count(*)::bigint",
               }),
             )}
      FROM rj GROUP BY ${D}, own_variant
    ),

    -- (E) ⑤ 분자 — **표면마다 출처가 다르다**(T3 FoldArgs.ownCitationsFrom).
    --     scope(글로벌): (변형, country, lang) → ($sel, $fbRe) 를 LATERAL 로 한 행 확정.
    --       WARN: lang 은 세부층에서 NULL 일 수 있다(글로벌 8/31 실측 31행). 안 접으면 스코프가
    --       안 잡혀 그 행의 인용이 조용히 빠진다(드라이런에서 own_citations 가 1 모자랐다).
    --     unit_column(웹사이트): 세부층에 굳힌 unit_owned_citations 를 그냥 더한다.
    --       유닛 자기 base 기준이라 변형(브랜드)과 무관하고 폴백도 없다 — 오늘 화면과 같다.
    ${
      byUnitColumn
        ? sql`
    pe AS (
      SELECT ${keysSelC}, v.own_variant,
             ${raw(
               ownMeasures({
                 own_citations: "COALESCE(sum(c.unit_owned_citations), 0)::bigint",
               }),
             )}
      FROM summary_domain_citations c CROSS JOIN v ${rjC}
      WHERE ${scopeC}
      GROUP BY ${keysGrpC}, v.own_variant
    ),`
        : sql`
    pe AS (
      SELECT ${keysSelC}, v.own_variant,
             ${raw(
               ownMeasures({
                 own_citations:
                   "COALESCE(sum(c.citations) FILTER (WHERE c.matched_base <> '' AND c.matched_base = ANY(sc.bases)), 0)::bigint",
                 own_fallback_citations:
                   "COALESCE(sum(c.citations) FILTER (WHERE c.base_norm_null = 1 AND sc.pat IS NOT NULL AND c.domain ~* sc.pat), 0)::bigint",
               }),
             )}
      FROM summary_domain_citations c CROSS JOIN v ${rjC}
      LEFT JOIN LATERAL (
        SELECT x.bases, x.pat FROM vs x
        WHERE x.own_variant = v.own_variant
          AND (x.country = '' OR x.country = c.country)
          AND (x.lang = '' OR x.lang = COALESCE(c.lang, ''))
        ORDER BY (x.country <> '')::int + (x.lang <> '')::int DESC, x.country DESC, x.lang DESC
        LIMIT 1
      ) sc ON true
      WHERE ${scopeC}
      GROUP BY ${keysGrpC}, v.own_variant
    ),`
    }

    parts AS (
      SELECT * FROM pa UNION ALL SELECT * FROM pb UNION ALL SELECT * FROM pc
      UNION ALL SELECT * FROM pd UNION ALL SELECT * FROM pe
    )
    SELECT ${headValues(args)}, ${D}, own_variant,
           sum(monitored)::int AS monitored,
           sum(tracked_answers)::int AS tracked_answers,
           sum(multi_answers)::int AS multi_answers,
           sum(top1_answers)::int AS top1_answers,
           sum(top3_answers)::int AS top3_answers,
           sum(rank_sum)::real AS rank_sum,
           sum(ranked_answers)::int AS ranked_answers,
           sum(own_mentions)::int AS own_mentions,
           sum(own_positive)::int AS own_positive,
           sum(own_signals)::int AS own_signals,
           sum(prompts_tracked)::int AS prompts_tracked,
           sum(comp_mentions)::int AS comp_mentions,
           sum(all_citations)::int AS all_citations,
           sum(own_citations)::int AS own_citations,
           sum(own_fallback_citations)::int AS own_fallback_citations,
           sum(tile_own_mentions)::int AS tile_own_mentions,
           sum(citing_answers)::int AS citing_answers,
           sum(prompts_measured)::int AS prompts_measured,
           sum(own_negative)::int AS own_negative
    FROM parts
    GROUP BY ${D}, own_variant
  `;
}

/**
 * **접기만** 도는 tx (백필 전용, PR② T2 라운드4).
 *
 * 정규 경로는 접기를 스왑 tx 안에 넣는다(`swap.ts::swapGeneration`) — 스왑이 접히면 집계층
 * 행도 함께 사라져야 하기 때문이다. 그런데 **이미 활성인 generation** 의 세부층을 다시 접는
 * 백필에는 스왑할 것이 없다: `summary_generations.status`·`summary_cycles.active_generation_id`·
 * `view_anchor_at`·`generator_version` 은 **하나도 건드리지 않는다**. 그래서 스왑 문장을 하나도
 * 내지 않는 이 경로를 따로 둔다(문장이 안 나가는 것을 `generate-cycle.test.ts` 가 단언한다).
 *
 * 원자성은 그대로다 — 표별 `DELETE … WHERE cycle_id` → INSERT 가 **한 tx** 안에서 돌아,
 * 도중에 실패하면 그 회차의 집계층은 손대기 전 상태로 롤백된다. 멱등도 그대로다
 * (DELETE 가 그 회차 행 전부를 먼저 지운다).
 */
export async function applyFoldTx(
  rt: Pick<GeneratorRuntime, "db" | "time">,
  batches: FoldBatch[],
  opts?: { statementTimeout?: string; workMem?: string },
): Promise<void> {
  await rt.db.transaction(async (tx) => {
    if (opts?.statementTimeout) {
      await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${opts.statementTimeout}'`)}`);
    }
    if (opts?.workMem) {
      await tx.execute(sql`SET LOCAL work_mem = ${sql.raw(`'${opts.workMem}'`)}`);
    }
    for (const batch of batches) {
      await rt.time(batch.key, async () => {
        for (const stmt of batch.statements) await tx.execute(stmt);
      });
    }
  });
}

// ── 접기 전 통계 갱신 ────────────────────────────────────────────────────────

/** 접기가 읽는 세부층 3표(파티션 부모). `summary_target_hits`·`prompt_dim` 은 안 읽는다. */
const FOLD_SOURCES = [
  "summary_answers",
  "summary_brand_mentions",
  "summary_domain_citations",
] as const;

/**
 * 접기 직전에 **그 주 파티션 3개만** ANALYZE 한다 — 플래너에게 새 `generation_id` 를 알린다.
 *
 * 배경(2026-09-10 프로덕션 실패): 접기는 방금 적재한 새 generation 을 읽는데 그 값이
 * `pg_statistic` 에 없어 `rows=1` 로 추정된다(실측: 3,902/22,911/9,610 → 1/1/1).
 * `foldTrendOwnSelect` 는 조인을 없애 그 추정이 틀려도 선형이지만, 추정이 맞으면 정렬
 * 그룹집계 대신 해시집계가 잡혀 **글로벌 own 7.5 s → 3.2 s** 다. 그래서 보험으로 건다.
 *
 * 규율 셋:
 *  · **스왑 tx 밖**에서 부른다 — 세부층은 이미 앞 단계에서 커밋됐으므로 tx 안일 필요가 없고,
 *    ANALYZE 의 `SHARE UPDATE EXCLUSIVE` 를 스왑 내내 들고 있을 이유가 없다.
 *  · **파티션 한정** — 0062 의 `summary_ensure_cycle_gen_stats()` 는 summary_* 60표에
 *    ANALYZE 를 돌린다(0064 머리 주석). 여기서 낼 비용이 아니다.
 *  · **실패해도 생성을 죽이지 않는다** — 통계는 최적화지 정합성이 아니다. 대신 크게 남긴다.
 */
export async function analyzeFoldSources(
  rt: Pick<GeneratorRuntime, "rows" | "exec" | "log">,
  keys: GenerationKeys,
): Promise<void> {
  const suffix = keys.cycleWeek.slice(0, 10).replace(/-/g, "");
  const names = FOLD_SOURCES.map((t) => `${t}_${suffix}`);
  try {
    const found = await rt.rows<{ rel: string | null }>(sql`
      SELECT to_regclass(x.n)::text AS rel
      FROM unnest(${sql.param(names)}::text[]) AS x(n)
    `);
    const rels = found.map((r) => r.rel).filter((r): r is string => Boolean(r));
    if (rels.length === 0) {
      rt.log(`  ↳ 접기 전 ANALYZE 건너뜀 — 주 파티션(${suffix})이 없다`);
      return;
    }
    for (const rel of rels) await rt.exec(sql`ANALYZE ${sql.raw(rel)}`);
    rt.log(`  ↳ 접기 전 ANALYZE ${rels.length}개 (${rels.join(", ")})`);
  } catch (e) {
    // 죽이지 않는다. 대신 조용히 넘어가지도 않는다 — 접기가 느려지면 여기가 첫 용의자다.
    rt.log(`  ⚠️ 접기 전 ANALYZE 실패(무시하고 진행) — 접기 플랜이 나빠질 수 있다: ${String(e).slice(0, 200)}`);
  }
}

// ── 조립 ────────────────────────────────────────────────────────────────────

/** 변형 인자 검증 — 조용한 0(0065 `DEFAULT 0` 마스킹)을 만들 수 있는 입력을 전부 거부한다. */
export function assertVariants(variants: OwnVariant[]): void {
  if (variants.length === 0) throw new Error("fold: own_variant 가 비었다 — 최소 1개(ALL) 필요");
  const seen = new Set<string>();
  for (const v of variants) {
    if (!v.key) throw new Error("fold: own_variant.key 가 비었다");
    if (seen.has(v.key)) throw new Error(`fold: own_variant 중복 — ${v.key}`);
    seen.add(v.key);
    if (v.entityIds.length === 0) {
      throw new Error(`fold: own_variant ${v.key} 의 entityIds 가 비었다 — 당사 지표가 전부 0 이 된다`);
    }
    if (v.citationScopes.length === 0) {
      throw new Error(`fold: own_variant ${v.key} 의 citationScopes 가 비었다 — ⑤ 분자가 조용히 0 이 된다`);
    }
  }
}

/** 표 하나분 접기 SELECT — INSERT 대상 컬럼과 **같은 순서**의 출력이다. */
export type FoldSelect = { table: string; key: string; columns: string[]; select: SQL };

/**
 * 접기 4문장의 SELECT 부분. INSERT 와 분리해 두는 이유는 **드라이런**이다 —
 * `scripts/summary/fold-dryrun.ts` 가 이 SELECT 를 그대로 감싸 세부층과 대조한다.
 * 재구현한 SQL 로 대조하면 "둘 다 같은 실수를 했다" 를 못 잡는다.
 */
export function foldSelects(a: FoldArgs): FoldSelect[] {
  assertVariants(a.variants);
  const head = HEAD_COLS.split(",").map((c) => c.trim());
  const aggKeys = [...AGG_KEYS];
  return [
    {
      table: "summary_trend_answers",
      key: AGG_TIMING_KEYS[0],
      columns: [...head, ...ANS_KEYS, ...ANSWERS_MEASURES],
      select: foldTrendAnswersSelect(a),
    },
    {
      table: "summary_trend_brands",
      key: AGG_TIMING_KEYS[1],
      columns: [...head, ...aggKeys, ...BRANDS_MEASURES],
      select: foldTrendBrandsSelect(a),
    },
    {
      table: "summary_trend_domains",
      key: AGG_TIMING_KEYS[2],
      columns: [...head, ...aggKeys, ...DOMAINS_MEASURES],
      select: foldTrendDomainsSelect(a),
    },
    {
      table: "summary_trend_own",
      key: AGG_TIMING_KEYS[3],
      columns: [...head, ...aggKeys, ...OWN_MEASURES],
      select: foldTrendOwnSelect(a),
    },
  ];
}

/**
 * 접기 4문장(표당 DELETE + INSERT). 순서는 `AGG_TABLES` 정본 순서 그대로다 —
 * `timings` 키·`row_counts` 와 같은 순서를 유지해 로그를 대조하기 쉽게 둔다.
 */
export function foldBatches(a: FoldArgs): FoldBatch[] {
  const selects = foldSelects(a);
  if (selects.map((s) => s.table).join(",") !== AGG_TABLES.join(",")) {
    throw new Error("fold: 표 순서가 AGG_TABLES 와 어긋났다");
  }
  return selects.map((s) => ({
    table: s.table,
    key: s.key,
    statements: [
      purgeSql(s.table, a.keys),
      sql`INSERT INTO ${raw(s.table)} (${raw(s.columns.join(", "))}) ${s.select}`,
    ],
  }));
}
