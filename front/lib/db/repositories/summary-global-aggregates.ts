import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  getStandardRootId,
  type CompetitorBrandValue,
  type StandardFilters,
  type StandardAggregates,
} from "@/lib/scope/result-adapter";
import { trackedEntityIdsFor } from "@/lib/scope/hmg-brands";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import {
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
  registrableDomainOfHost,
} from "@/lib/geo-catalog/owned";
import type { SummaryCyclePick } from "@/lib/db/repositories/summary-cycles";
import {
  presenceSetColumnAvailable,
  summaryPresencePredicate,
} from "@/lib/summary/read/presence";
import type {
  StandardSubKpis,
  PromptTopicSlice,
  SourceDomainSlice,
  GeoBrandMention,
  GeoKpiResult,
} from "@/lib/db/repositories/scope-aggregates";
// 세부층 폴백에도 미러와 **같은 규약**의 예산을 건다(PR③ R2) — 문장마다 자기 트랜잭션 +
// `SET LOCAL statement_timeout`. 예산을 안 넘기면 원본 db 를 그대로 돌려주므로 무비용이다.
import { budgetedMirrorDb, type AnswerSetBudget } from "@/lib/db/repositories/scope-aggregates";
import {
  readTrendAggregates,
  type TrendAggregates,
  type TrendAxes,
  type TrendLimits,
  type TrendOwnRow,
  type TrendReadScope,
  type TrendStatementKey,
} from "@/lib/db/repositories/summary-trend-aggregates";
import {
  summaryCitationsFromTrend,
  sourceCompositionFrom,
  type CitationTrendRead,
} from "@/lib/db/repositories/summary-citation-read";
import { cycleSetAsOf, type CycleSet } from "@/lib/summary/read/cycle-set";
import { loadCitationOverrides } from "@/lib/citation-categorizer/overrides-loader";
import type { CitationOverrideMap } from "@/lib/citation-categorizer";
import { officialHmgCitationsOf } from "@/lib/kpi/official-hmg-citations";

// 글로벌 대시보드(S1)의 사실표 조회 — 설계 v4.1 §6-2(글로벌 열)·§6-4·§6-5.
//
// 웹사이트판(summary-website-aggregates.ts)의 글로벌 대응이다. 반환 타입은 미러
// 경로(aggregateStandardFromMirror · aggregateSubKpisFromMirror ·
// aggregatePromptTopicFromMirror · aggregateSourceCompositionFromMirror ·
// aggregateGeoCompetitionFromMirror)와 **동일**하다 — 화면(app/[locale]/(dash)/
// dashboard)은 어느 경로로 왔는지 모른다. 그것이 폴백을 언제든 켤 수 있게 하는
// 유일한 조건이다.
//
// 웹사이트 열과 갈리는 지점(§6-2)만 적어 둔다:
//   · `in_root_catalog = 1`  — 705 루트 카탈로그 게이트 (`SA:905`, `SA:2912`)
//   · `in_tagged_region = 1` — 지역태그 제외 + 한국어 비-KR 제외 (`SA:676-721`)
//   · `in_full_cycle = 1`    — full-cycle 프롬프트 게이트 (§3-7, `SA:642-782`)
//   · 숨김 국가 제외          — `HIDDEN_STANDARD_REGIONS` (`SA:897-903`)
//   · 국가 = `country`(= scope_answers.region, ISO) — 웹사이트의 verbatim 가상
//     코드가 아니다. RHQ→ISO 환원은 이미 상류(readStandardFilters →
//     effectiveScopeCountries)에서 끝나 `filters.region` 으로 온다.
//   · 언어 = **대문자**(scope_prompts.lang 원천). 웹사이트는 소문자.
//   · 브랜드 = `catalog_brands && $brands` (오늘의 `prompts.brand` 세미조인
//     any-match 재현). 비admin 의 `∪ {'HMG'}` 락은 상류에서 이미 붙었다
//     (`components/dash/standard-filters.ts:59-63`) — 여기서 더하지 않는다.
//     더하면 admin 이 브랜드를 고른 화면의 모수가 오늘과 달라진다.
//   · ⑥(타겟 URL 인용률)은 글로벌에 없다 — `summary_target_hits` 는 웹사이트 전용.
//
// 판정은 여기서 하지 않는다(그것이 사실표의 요점): 굳혀진 행을 고르고, 작은 집합
// 비교($own·$sel)와 나눗셈만 한다.

const num = (v: unknown): number => Number(v ?? 0);
const round1 = (v: unknown): number => Math.round(Number(v) * 10) / 10;

export interface SummaryGlobalScope {
  /** 회차 1개 — 글로벌은 항상 단일 회차다(§6-1 규칙 1). */
  cycle: SummaryCyclePick;
  /** scope 루트 프로젝트 id (`scope_runs.project_id`). */
  rootProjectId: string;
  filters: StandardFilters;
  /** `$sel` 원본 — 게이트웨이의 `ownedBasePrefixesForScope(축E, 국가, 언어)` 결과. */
  ownedBasePrefixes: string[];
}

// ── 작은 집합들 ──────────────────────────────────────────────────────────────

/** `$own` — 당사 엔티티 id. 미러 경로의 `trackedRollupIn`(SA:109-114)과 같은 입력. */
function ownIds(f: StandardFilters): string[] {
  return trackedEntityIdsFor(f.contextBrand ?? f.brand, f.ownEntities);
}

/**
 * `$sel` — 사실표 `matched_base` 와 같은 정규형으로 접은 선택 base 목록.
 * 생성기가 base universe(글로벌 = `GEO_OWNED_BASE_PREFIXES`)를 같은
 * `ownedBasePrefixFromUrl` 로 접어 최장 일치 base 를 저장한다는 계약이다.
 */
function selectedBases(prefixes: string[]): string[] {
  return [...new Set(prefixes.map(ownedBasePrefixFromUrl).filter(Boolean))] as string[];
}

// `$fbRe` — base 정규화가 불가능했던 행(base_norm_null=1)의 도메인 서픽스 폴백.
// 규칙 정본은 scope-aggregates.ts 의 ownedDomainPatternFor/ownedFallbackDomains
// (SA:305-318). 그쪽은 export 되지 않아 **사본이 셋**이다: SA · 웹사이트 사실표
// (summary-website-aggregates.ts) · 여기. 규칙을 바꾸면 셋을 함께 고쳐야 하고,
// summary-global-aggregates.sql.test.ts 가 라벨 경계 앵커 형태를 고정한다.
function ownedFallbackDomains(basePrefixes: string[]): string[] {
  const out = new Set<string>();
  for (const p of basePrefixes) {
    const norm = normalizeOwnedBaseUrl(p);
    if (!norm) continue;
    const d = registrableDomainOfHost(norm.split("/")[0] ?? "");
    if (d) out.add(d);
  }
  return [...out];
}
function ownedDomainPatternFor(domains: string[]): string | null {
  if (domains.length === 0) return null;
  return `(^|\\.)(${domains.map((d) => d.replace(/\./g, "\\.")).join("|")})$`;
}

// ── 술어 ────────────────────────────────────────────────────────────────────

const textArray = (vals: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::text[]`;
const uuidArray = (vals: string[]): SQL =>
  sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::uuid[]`;

/**
 * 회차 술어 — 항상 `(cycle_id, generation_id)` **쌍**으로. 주 파티션 프루닝용
 * `cycle_week` 를 동반한다(웹사이트판과 같은 자세, 다만 글로벌은 회차가 1개라
 * ANY 가 아니라 등호).
 */
function cycleScope(c: SummaryCyclePick): SQL {
  return sql`cycle_week = ${c.cycleWeek}::date AND cycle_id = ${c.cycleId}::uuid AND generation_id = ${c.generationId}::uuid`;
}

/**
 * 답변 모수 술어(§6-2 글로벌 열). 이 표만 전 축을 갖는다 — 나머지 사실표는
 * 여기서 나온 job 집합을 조인한다(오늘의 `_answer_set` 과 같은 역할).
 */
function answerWhere(scope: SummaryGlobalScope): SQL {
  const f = scope.filters;
  const conds: SQL[] = [
    cycleScope(scope.cycle),
    // 루트 스코프 — 사실표는 표면을 섞어 담으므로(회차로 이미 갈리지만) 오늘의
    // `rootScope`(SA:917-919)와 같은 술어를 명시한다.
    sql`project_id = ${scope.rootProjectId}::uuid`,
    // run 상태 게이트는 조회 시(§6-2) — 생성기는 상태 무관으로 굳힌다.
    sql`run_status IN ('completed', 'partial_failed')`,
    // 글로벌 전용 3게이트. 굳혀진 값이라 조회는 등호 하나다.
    sql`in_root_catalog = 1`,
    sql`in_tagged_region = 1`,
    sql`in_full_cycle = 1`,
  ];
  // 숨김 국가(신규 편입 부분 데이터) — 루트 표면 한정(SA:936-940).
  if (HIDDEN_STANDARD_REGIONS.length) {
    conds.push(sql`country <> ALL(${textArray(HIDDEN_STANDARD_REGIONS)})`);
  }
  // 국가 = scope_answers.region(ISO). 권역(RHQ)→ISO 환원은 상류에서 끝났다.
  if (f.region?.length) conds.push(sql`country = ANY(${textArray(f.region)})`);
  // 언어 = scope_prompts.lang(대문자). 웹사이트는 소문자 — 표면별 원천 고정.
  if (f.lang?.length)
    conds.push(sql`lang = ANY(${textArray(f.lang.map((v) => v.toUpperCase()))})`);
  if (f.engine?.length) conds.push(sql`engine = ANY(${textArray(f.engine)})`);
  // funnel 원천은 대시보드(S1) = funnel_catalog (인용 화면만 COALESCE, §6-2).
  if (f.funnelStage?.length) conds.push(sql`funnel_catalog = ANY(${textArray(f.funnelStage)})`);
  if (f.listType?.length) conds.push(sql`list_type = ANY(${textArray(f.listType)})`);
  if (f.depth1?.length) conds.push(sql`depth1 = ANY(${textArray(f.depth1)})`);
  if (f.depth2?.length) conds.push(sql`depth2 = ANY(${textArray(f.depth2)})`);
  if (f.depth3?.length) conds.push(sql`depth3 = ANY(${textArray(f.depth3)})`);
  // brandPresence: 하나만 고르면 그 값으로, 둘 다(또는 0개)면 무필터 — S1 규칙.
  // 값은 **유도 집합**(presence_set, 0061)과의 교집합이다 — 미러의 any-match 세미조인과
  // 동치. 규칙 정본은 lib/summary/read/presence.ts(웹사이트 열과 공유).
  if (f.brandPresence?.length) {
    const pred = summaryPresencePredicate(f.brandPresence);
    if (pred) conds.push(pred);
  }
  // 브랜드 축 = 카탈로그 중복 행의 brand 집합과 any-match(오늘의 세미조인 재현,
  // 실측 A: 루트 카탈로그 중복 237 프롬프트 중 231건이 brand 가 다르다).
  if (f.brand?.length) conds.push(sql`catalog_brands && ${textArray(f.brand)}`);
  return sql.join(conds, sql` AND `);
}

/**
 * 브랜드·도메인 표의 공통 술어 — **답변 모수 술어를 그 표에 직접 건다**(T10 · PR③).
 *
 * 종전에는 `job_id IN (SELECT job_id FROM summary_answers WHERE …)` 세미조인이었다.
 * 그럴 이유가 없다: 세부층 3표는 **공통 차원 19열을 같은 한 행(`d`)에서 받아 적는다**
 * (생성기 `lib/summary/generate/types.ts::COL_COMMON`/`D_COMMON` — `insertAnswersSql` ·
 * `insertBrandMentionsSql` · `insertDomainCitationsSql` 이 전부 `FROM d` 다). 즉
 * `answerWhere` 가 보는 컬럼은 브랜드·도메인 표에도 **같은 이름·같은 값**으로 있다.
 *
 * 근거(2026-09-10 라이브 전수, 읽기 전용): 활성 generation 96개의 세부층 전 행
 * (brand_mentions 315,174 · domain_citations 150,729)에 대해 `summary_answers` 와의
 * 공통 19열 대조 — **고아 0 · 불일치 0**.
 * 같은 판단이 이미 `summary-citation-read.ts` 에 있다(그쪽 머리 주석의 10,537 그룹 대조).
 *
 * 효과: 세부층 폴백 경로(admin 임의 브랜드 조합 · `depth2`/`depth3`)의 **모든 문장에서
 * 조인이 사라진다**. 종전 계획은 job 32,946개를 `summary_brand_mentions_…_job_id_idx`
 * 로 하나씩 되짚는 Nested Loop 였다(실측 288,835 shared buffer · 759 ms/문장).
 *
 * ⚠️ 이 등가성은 "세 표가 같은 `d` 에서 나온다"에 걸려 있다. 생성기가 표마다 차원을
 * 따로 계산하도록 바뀌면 이 함수부터 되돌려야 한다 —
 * `summary-global-aggregates.sql.test.ts` 의 형태 테스트가 `answerWhere` 술어 컬럼이
 * `COL_COMMON` 안에 있음을 고정한다.
 */
function factScope(scope: SummaryGlobalScope): SQL {
  return answerWhere(scope);
}

/** ⑤ owned 판정 — `matched_base` 최장 일치 + base 정규화 불가 행의 도메인 폴백(§6-4). */
function ownedCitationExpr(ownedBasePrefixes: string[]): SQL {
  const sel = selectedBases(ownedBasePrefixes);
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(ownedBasePrefixes));
  const byBase = sel.length
    ? sql`(matched_base <> '' AND matched_base = ANY(${textArray(sel)}))`
    : sql`false`;
  const byDomain = pattern
    ? sql`(base_norm_null = 1 AND domain ~* ${pattern})`
    : sql`false`;
  return sql`(${byBase} OR ${byDomain})`;
}

const ownArray = (f: StandardFilters): SQL => {
  const ids = ownIds(f);
  return ids.length ? uuidArray(ids) : sql`ARRAY[]::uuid[]`;
};

// ── ①~⑤ + 지역 롤업 (StandardAggregates 동형) ───────────────────────────────

// ④ 브랜드 내 순위 — 사실표 쌍둥이 (2026-09-06, PR #223 이식). 미러 경로
// scope-aggregates.ts::ownBrandRankPerJobSql 머리 주석이 배경(코어 Automotive 카탈로그
// 팽창으로 `first_rank`(=min avg_position) 의 서수가 밀린 것) 정본. 사실표는 답변별
// 브랜드 행을 전부 갖고 있으므로 읽기 시점에 같은 순위를 만든다: (job, brand_id) 별
// min(first_rank) 을 접고 답변 안에서 rank(). 모집단은 `is_competitor = 1`(비경쟁 노이즈
// 제외 통과 행 — 자사 포함, 생성기 global-0831.ts 참조). 웹사이트판
// summary-website-aggregates.ts::ownBrandRankByJobSql 과 같은 형태여야 두 표면이 갈리지 않는다.
// 반환: (job_id, tp) — 자사 브랜드 중 최선 순위. 자사 무순위 답변은 행 없음.
  // ⚠️ 접기 키는 brand_id 가 아니라 **brand_name(표시명)** 이다 — 미러
  // ownBrandRankPerJobSql 의 `_br_pos` 가 `(name, job_id)` 로 접기 때문(같은 표시명으로
  // 병합되는 서로 다른 rollup id 가 있다: Toyota 2 id 등). id 로 접으면 그 답변의 순위가
  // 1씩 밀려 top3 경계가 흔들린다(2026-09-06 실측: 글로벌 chatgpt top3 9,388 vs 9,396).
//
// ── PR④ 후보 (T10 이후 남은 최대 항목, 아직 손대지 않았다) ──────────────────
// 조인 제거 뒤 세부층 폴백 경로의 잔여 시간 ≈1.6 s 중 **62%** 가 이 헬퍼다
// (④순위 문장 420 ms + Sub-KPI 문장 577 ms, T11 검증 실측). 마이그레이션 없이 쓸 수
// 있는 레버가 둘 있다:
//   (1) **rank CTE 를 1회만 계산해 공유한다.** 지금은 ④(posRows)와 Sub-KPI(ownByJob)가
//       같은 `ownBrandRankByJobSql(F, own)` 을 **각자** 돌린다 — 같은 회차·같은 술어인데
//       두 번 판다. 한 문장으로 합치거나 임시 결과를 재사용하면 절반이 바로 빠진다.
//   (2) **`rank() OVER (PARTITION BY job_id ORDER BY tp)` 를 job 단위 집계로 재작성한다.**
//       필요한 값은 "자사 브랜드의 최선 순위"(= `min(rk) WHERE is_own`) 하나뿐이라
//       전 브랜드에 서수를 매길 이유가 없다. 윈도우 함수는 `_bp` 전량 정렬을 강제하지만,
//       job 단위 집계(자사 최소 tp 보다 작은 tp 를 가진 브랜드 수 + 1)는 해시 집계로 접힌다.
// 둘 다 **값 동치를 먼저 패리티 격자로 증명한 뒤**에만 넣을 것 — 이 헬퍼는 top1/top3
// 경계를 정하므로 1 밀리는 순간 고객 지표가 바뀐다(위 2026-09-06 실측이 그 전례다).
function ownBrandRankByJobSql(F: SQL, own: SQL): SQL {
  return sql`
    WITH _bp AS (
      SELECT job_id, brand_name, min(first_rank) AS tp,
             bool_or(brand_id = ANY(${own})) AS is_own
      FROM summary_brand_mentions
      WHERE ${F} AND is_competitor = 1 AND first_rank IS NOT NULL
      GROUP BY 1, 2
    ),
    _rk AS (
      SELECT job_id, is_own, rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM _bp
    )
    SELECT job_id, min(rk)::int AS tp FROM _rk WHERE is_own GROUP BY job_id`;
}

export async function summaryGlobalAggregates(
  scope: SummaryGlobalScope,
  budget?: AnswerSetBudget,
  /**
   * 글로벌 ⑤ 분자용 공식(HMG) group_key 목록(제품 책임자 2026-09-29) — 집계층 코어와 **같은 목록**
   * (`TrendReadScope.officialGroupKeys` 주석). 주면 `citations.officialHmgCitations` 를 싣는다.
   */
  officialGroupKeys?: readonly string[],
): Promise<StandardAggregates | null> {
  await presenceSetColumnAvailable();
  const db = budgetedMirrorDb(getDb(), budget);
  const W = answerWhere(scope);
  const F = factScope(scope);
  const own = ownArray(scope.filters);
  const ownedExpr = ownedCitationExpr(scope.ownedBasePrefixes);

  // ① 분모 + 지역(국가) 롤업 — 답변 표 단독.
  const ansRows = (await db.execute(sql`
    SELECT COALESCE(country, 'UNKNOWN') AS region,
      COALESCE(sum(monitored), 0)::int AS answers
    FROM summary_answers WHERE ${W}
    GROUP BY 1 ORDER BY 1
  `)) as unknown as Array<{ region: string; answers: number }>;

  // ① 분자(국가별) + ③ 우호도(총계) — **한 문장·조인 없음**(T10/E4).
  // ① 분자는 답변 표가 아니라 브랜드 표의 job 단위 재집계다(설계 B3: 당사 분자는
  // 굳히지 않는다). 종전에는 `a LEFT JOIN o` 였는데, `o ⊆ a` 가 술어로 이미 보장되므로
  // (factScope 주석) 국가 축은 브랜드 표에서 바로 세면 된다 — 같은 `d` 행에서 온
  // 같은 `country` 다. ③ 은 같은 행 집합(`F ∧ $own`)의 총합이라 GROUPING SETS 의
  // 총계 행(country IS NULL)으로 같은 스캔에서 나온다(문장 수 불변).
  const ownRows = (await db.execute(sql`
    SELECT COALESCE(country, 'UNKNOWN') AS region,
      (grouping(country) = 1) AS is_total,
      count(DISTINCT job_id)::int AS tracked,
      COALESCE(sum(positive), 0)::int AS p,
      COALESCE(sum(neutral), 0)::int AS ne,
      COALESCE(sum(negative), 0)::int AS ng,
      COALESCE(sum(mixed), 0)::int AS mx
    FROM summary_brand_mentions WHERE ${F} AND brand_id = ANY(${own})
    GROUP BY GROUPING SETS ((country), ())
  `)) as unknown as Array<{
    region: string; is_total: boolean; tracked: number;
    p: number; ne: number; ng: number; mx: number;
  }>;
  const trackedByRegion = new Map<string, number>();
  let ownTotal: (typeof ownRows)[number] | undefined;
  for (const r of ownRows) {
    if (r.is_total === true) ownTotal = r;
    else trackedByRegion.set(r.region, num(r.tracked));
  }

  let totalAnswers = 0;
  let trackedAnswerCount = 0;
  const regions = ansRows.map((r) => {
    const tracked = trackedByRegion.get(r.region) ?? 0;
    totalAnswers += num(r.answers);
    trackedAnswerCount += tracked;
    return {
      region: r.region,
      answerCount: num(r.answers),
      trackedAnswerCount: tracked,
    };
  });
  // 표가 비어 있으면(생성 전) 미러 경로와 같은 형태로 null — 화면은 "측정 대기".
  if (totalAnswers === 0) return null;

  // ② 타일: 표시명 그룹으로 접고 그 그룹이 당사인지를 bool_or 로 (SA:1195-1207 재현).
  // 2단 집계다 — `count(DISTINCT job_id)`(단일 단계)는 `(brand_name, job_id)` 153,473행
  // 전량을 14 MB 정렬로 밀어 넣고 **병렬화되지 않는다**. (brand_name, job_id) 로 먼저
  // 접으면 Partial HashAggregate 로 병렬 처리된다(실측 492 → 259 ms, 글로벌 admin
  // Hyundai+Kia). 값은 동치다: 바깥 `count(*)` = 안쪽 그룹 수 = job distinct,
  // `sum(sum(mentions))` = 총합, `bool_or(bool_or(...))` = 그 표시명 그룹이 당사인가.
  //
  // ⚠️ 정렬 키는 `mentions DESC, name` 이다 — `mentions` 만으로는 **동점 브랜드의 순서가
  // 계획에 따라 달라진다**(T11 검증 F1: 1,029개 중 803개가 위치 이동. 단일 단계는
  // GroupAggregate 라 brand_name 순으로 들어오고, 2단은 HashAggregate 라 해시 순서다).
  // 오늘 화면 소비자는 최댓값 1건 또는 `localeCompare` 재정렬이라 영향이 없었지만,
  // "값은 같은데 순서가 흔들리는" 상태를 남겨 두면 다음 소비자가 그것을 밟는다.
  // 결정적 타이브레이크를 박아 계획 선택과 무관하게 같은 순서가 나오게 한다(값 무영향).
  const brandRows = (await db.execute(sql`
    SELECT name, sum(mentions)::int AS mentions, count(*)::int AS answers,
      bool_or(is_tracked) AS is_tracked
    FROM (
      SELECT brand_name AS name, job_id,
        sum(mentions)::int AS mentions,
        bool_or(brand_id = ANY(${own})) AS is_tracked
      FROM summary_brand_mentions
      WHERE ${F} AND is_competitor = 1
      GROUP BY 1, 2
    ) t
    GROUP BY 1 ORDER BY mentions DESC, name
  `)) as unknown as Array<{
    name: string;
    mentions: number;
    answers: number;
    is_tracked: boolean;
  }>;
  const brands = brandRows.map((b) => ({
    name: b.name,
    mentionCount: num(b.mentions),
    answerCount: num(b.answers),
    isTracked: b.is_tracked === true,
  }));
  const totalMentions = brands.reduce((s, b) => s + b.mentionCount, 0);

  // ③ 우호도 — 언급 단위 신호 합(비경쟁 게이트 없음: 당사 행만 본다, SA:1265-1276).
  // 값은 위 `ownRows` 의 총계 행에서 온다 — 같은 술어·같은 스캔(문장 하나 절약).
  const positiveMentions = num(ownTotal?.p);
  const sampledMentions =
    positiveMentions + num(ownTotal?.ne) + num(ownTotal?.ng) + num(ownTotal?.mx);

  // ④ 우선노출도 — 답변별 자사 브랜드 내 순위의 평균(순위 미진입 답변 제외).
  // 미러 경로 ownBrandRankPerJobSql 과 같은 단위(2026-09-06, PR #223).
  const posRows = (await db.execute(sql`
    SELECT round(avg(tp)::numeric, 1) AS avg_position, count(*)::int AS sampled
    FROM (${ownBrandRankByJobSql(F, own)}) t
  `)) as unknown as Array<{ avg_position: string | null; sampled: number }>;

  // ⑤ 인용 — 분모는 domain NULL 행 포함(L1 낮).
  // 공식(HMG) 분자 — 분류는 JS 가 끝낸 목록을 받기만 한다(SQL 에 분류 어휘 없음).
  const officialCol = officialGroupKeys
    ? sql`,
      COALESCE(sum(citations) FILTER (WHERE group_key = ANY(${sql.param([...officialGroupKeys])}::text[])), 0)::int AS official`
    : sql``;
  const citAgg = (await db.execute(sql`
    SELECT COALESCE(sum(citations), 0)::int AS total,
      COALESCE(sum(citations) FILTER (WHERE ${ownedExpr}), 0)::int AS owned,
      count(DISTINCT job_id) FILTER (WHERE citations > 0)::int AS with_cit${officialCol}
    FROM summary_domain_citations WHERE ${F}
  `)) as unknown as Array<{ total: number; owned: number; with_cit: number; official?: number }>;

  const domRows = (await db.execute(sql`
    SELECT domain AS host,
      count(DISTINCT job_id)::int AS citing_answers,
      COALESCE(sum(citations), 0)::int AS citations,
      COALESCE(sum(citations) FILTER (WHERE ${ownedExpr}), 0)::int AS owned_citations,
      bool_or(${ownedExpr}) AS is_ours
    FROM summary_domain_citations
    WHERE ${F} AND domain IS NOT NULL
    GROUP BY domain ORDER BY citing_answers DESC
  `)) as unknown as Array<{
    host: string;
    citing_answers: number;
    citations: number;
    owned_citations: number;
    is_ours: boolean;
  }>;

  // 측정 기준일 = 회차 기준. 산출 정본은 `cycle-set.ts::cycleSetAsOf` 하나다 —
  // 앵커 축이면 귀속 날짜(`round_date`, KST `YYYY-MM-DD`)라 미러 경로의
  // `to_char(max(ca.round_date), 'YYYY-MM-DD')` 와 **문자열까지 같고**, 축이 꺼져
  // 있으면 종전 그대로 앵커 시각의 ISO 다.
  const asOf = cycleSetAsOf([scope.cycle]);

  return {
    rootProjectId: getStandardRootId() ?? "",
    asOf,
    totalAnswers,
    totalMentions,
    trackedAnswerCount,
    brands,
    regions,
    citations: {
      sampledAnswers: totalAnswers,
      answersWithCitation: num(citAgg[0]?.with_cit),
      totalCitations: num(citAgg[0]?.total),
      ownedCitations: num(citAgg[0]?.owned),
      ...(officialGroupKeys ? { officialHmgCitations: num(citAgg[0]?.official) } : {}),
      domains: domRows.map((d) => ({
        host: d.host,
        citingAnswers: num(d.citing_answers),
        citationCount: num(d.citations),
        ownedCitationCount: num(d.owned_citations),
        isOurs: d.is_ours === true,
      })),
    },
    position: {
      avgPosition: posRows[0]?.avg_position != null ? Number(posRows[0].avg_position) : null,
      sampledAnswers: num(posRows[0]?.sampled),
    },
    sentiment: {
      positiveRate:
        sampledMentions > 0 ? round1((100 * positiveMentions) / sampledMentions) : null,
      positiveMentions,
      sampledMentions,
    },
  };
}

// ── Sub KPI (엔진 일관성) ────────────────────────────────────────────────────

export async function summaryGlobalSubKpis(
  scope: SummaryGlobalScope,
): Promise<StandardSubKpis> {
  await presenceSetColumnAvailable();
  const db = getDb();
  const W = answerWhere(scope);
  const F = factScope(scope);
  const own = ownArray(scope.filters);
  const ownedExpr = ownedCitationExpr(scope.ownedBasePrefixes);

  // 당사 언급의 job 단위 재집계 — 분자 계열(Q1)과 #9(미언급 프롬프트)가 공유한다.
  // Sub-KPI 는 ④ 와 같은 순위 정의를 써야 타일·배지가 갈리지 않는다(PR #223 계약).
  // mc(당사 언급 수)는 종전대로 자사 행 합, tp 는 브랜드 내 rank().
  //
  // engine·prompt_id 를 키에 함께 실어 둔다(T10/E4). 둘 다 job 에 함수 종속이라
  // **그룹 수가 늘지 않고**, 대신 분자를 답변 표와 조인하지 않고 엔진별로 접을 수 있다.
  const ownByJob = sql`
    SELECT b.job_id, b.engine, b.prompt_id, b.mc, r.tp
    FROM (
      SELECT job_id, engine, prompt_id, sum(mentions)::int AS mc
      FROM summary_brand_mentions
      WHERE ${F} AND brand_id = ANY(${own})
      GROUP BY job_id, engine, prompt_id
    ) b
    LEFT JOIN (${ownBrandRankByJobSql(F, own)}) r ON r.job_id = b.job_id`;

  // 분모(엔진별 모수) — 답변 표 단독. 총계 행(GROUPING SETS `()`)이 #9 의 측정 프롬프트 수다.
  const ansDen = (await db.execute(sql`
    SELECT engine AS target, (grouping(engine) = 1) AS is_total,
      COALESCE(sum(monitored), 0)::int AS answers,
      count(DISTINCT prompt_id)::int AS prompts
    FROM summary_answers WHERE ${W}
    GROUP BY GROUPING SETS ((engine), ())
  `)) as unknown as Array<{
    target: string; is_total: boolean; answers: number; prompts: number;
  }>;

  // 분자(엔진별 당사 계열) — 브랜드 표 단독, **조인 없음**(T10/E4).
  // 종전 `a LEFT JOIN o` 의 FILTER 는 전부 "o 에 있는 행"만 세던 것이라(`o ⊆ a`)
  // o 안에서 그대로 센다. 총계 행이 #9 의 "당사가 언급된 프롬프트 수"다.
  const ansNum = (await db.execute(sql`
    SELECT engine AS target, (grouping(engine) = 1) AS is_total,
      count(*)::int AS tracked,
      count(*) FILTER (WHERE mc >= 2)::int AS multi,
      count(*) FILTER (WHERE COALESCE(tp, 100) <= 1)::int AS top1,
      count(*) FILTER (WHERE COALESCE(tp, 100) <= 3)::int AS top3,
      round(avg(tp)::numeric, 1) AS avg_position,
      count(DISTINCT prompt_id)::int AS prompts
    FROM (${ownByJob}) o
    GROUP BY GROUPING SETS ((engine), ())
  `)) as unknown as Array<{
    target: string; is_total: boolean; tracked: number; multi: number;
    top1: number; top3: number; avg_position: string | null; prompts: number;
  }>;

  const men = (await db.execute(sql`
    SELECT engine AS target,
      COALESCE(sum(mentions), 0)::int AS total,
      COALESCE(sum(mentions) FILTER (WHERE brand_id = ANY(${own})), 0)::int AS tracked
    FROM summary_brand_mentions WHERE ${F} AND is_competitor = 1
    GROUP BY engine
  `)) as unknown as Array<{ target: string; total: number; tracked: number }>;

  const sent = (await db.execute(sql`
    SELECT engine AS target,
      COALESCE(sum(positive), 0)::int AS p,
      COALESCE(sum(neutral), 0)::int AS ne,
      COALESCE(sum(negative), 0)::int AS ng,
      COALESCE(sum(mixed), 0)::int AS mx
    FROM summary_brand_mentions WHERE ${F} AND brand_id = ANY(${own})
    GROUP BY engine
  `)) as unknown as Array<{ target: string; p: number; ne: number; ng: number; mx: number }>;

  const cit = (await db.execute(sql`
    SELECT engine AS target,
      COALESCE(sum(citations), 0)::int AS total,
      COALESCE(sum(citations) FILTER (WHERE ${ownedExpr}), 0)::int AS owned
    FROM summary_domain_citations WHERE ${F}
    GROUP BY engine
  `)) as unknown as Array<{ target: string; total: number; owned: number }>;

  // #9(미언급 프롬프트)는 위 두 문장의 총계 행에서 뺄셈으로 나온다 — 종전의
  // `a LEFT JOIN o … bool_or` 문장이 통째로 사라진다. 등가인 이유: `o ⊆ a` 이므로
  // "당사가 한 번이라도 언급된 프롬프트" = o 의 distinct prompt_id 다.
  const menBy = new Map(men.map((r) => [r.target, r]));
  const sentBy = new Map(sent.map((r) => [r.target, r]));
  const citBy = new Map(cit.map((r) => [r.target, r]));
  const numBy = new Map(ansNum.filter((r) => r.is_total !== true).map((r) => [r.target, r]));
  const numTotal = ansNum.find((r) => r.is_total === true);
  const prompts = num(ansDen.find((r) => r.is_total === true)?.prompts);

  return {
    rows: ansDen.filter((r) => r.is_total !== true).map((a) => {
      const m = menBy.get(a.target);
      const s = sentBy.get(a.target);
      const c = citBy.get(a.target);
      const o = numBy.get(a.target);
      return {
        engine: a.target,
        answers: num(a.answers),
        tracked: num(o?.tracked),
        multi: num(o?.multi),
        top1: num(o?.top1),
        top3: num(o?.top3),
        avgPosition: o?.avg_position != null ? Number(o.avg_position) : null,
        totalMentions: num(m?.total),
        trackedMentions: num(m?.tracked),
        sentMentions: num(s?.p) + num(s?.ne) + num(s?.ng) + num(s?.mx),
        positiveMentions: num(s?.p),
        negativeMentions: num(s?.ng),
        citTotal: num(c?.total),
        citOwned: num(c?.owned),
      };
    }),
    promptsWithoutBrand: prompts > 0 ? prompts - num(numTotal?.prompts) : null,
    measuredPrompts: prompts > 0 ? prompts : null,
  };
}

// ── 퍼널(주제) 도넛 ─────────────────────────────────────────────────────────
// 미러 경로(SA:1645-1668)는 프롬프트별 카탈로그 funnel_stage 를 LIMIT 1 로 하나
// 집는다 — 사실표에서는 그 값이 `funnel_catalog` 로 이미 굳어 있다(§3-6).

export async function summaryGlobalPromptTopics(
  scope: SummaryGlobalScope,
): Promise<PromptTopicSlice[]> {
  await presenceSetColumnAvailable();
  const rows = (await getDb().execute(sql`
    SELECT funnel_catalog AS topic, count(DISTINCT prompt_id)::int AS prompts
    FROM summary_answers WHERE ${answerWhere(scope)}
    GROUP BY 1 ORDER BY prompts DESC
  `)) as unknown as Array<{ topic: string | null; prompts: number }>;
  return rows.map((r) => ({ topic: r.topic ?? null, prompts: num(r.prompts) }));
}

// ── 출처 도넛 ────────────────────────────────────────────────────────────────
// isOurs 는 도메인 단위 판정(경로 수준 좁히기는 도메인 그룹핑으로 표현 불가) —
// 미러 경로(SA:3623-3625)와 같은 서픽스 정규식을 쓴다. ⑤ 분자와 달리
// `matched_base` 를 보지 않는 것이 오늘의 동작이다.

export async function summaryGlobalSourceComposition(
  scope: SummaryGlobalScope,
  budget?: AnswerSetBudget,
): Promise<SourceDomainSlice[]> {
  await presenceSetColumnAvailable();
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(scope.ownedBasePrefixes));
  const isOurs = pattern ? sql`bool_or(domain ~* ${pattern})` : sql`false`;
  const rows = (await budgetedMirrorDb(getDb(), budget).execute(sql`
    SELECT domain AS domain, COALESCE(sum(citations), 0)::int AS citations,
      ${isOurs} AS is_ours
    FROM summary_domain_citations
    WHERE ${factScope(scope)} AND domain IS NOT NULL
    GROUP BY domain ORDER BY citations DESC
  `)) as unknown as Array<{ domain: string; citations: number; is_ours: boolean }>;
  const total = rows.reduce((s, r) => s + num(r.citations), 0);
  return rows.map((r) => ({
    domain: r.domain,
    citations: num(r.citations),
    share: total > 0 ? round1((100 * num(r.citations)) / total) : 0,
    isOurs: r.is_ours === true,
  }));
}

// ── GEO 경쟁 (국가 × 브랜드) ─────────────────────────────────────────────────
// 글로벌의 국가 축은 `country`(= scope_answers.region, ISO) — 미러 경로
// (SA:3676-3690)의 `a.region` 과 같은 값이다.

export async function summaryGlobalGeoCompetition(
  scope: SummaryGlobalScope,
): Promise<GeoBrandMention[]> {
  await presenceSetColumnAvailable();
  const own = ownArray(scope.filters);
  const rows = (await getDb().execute(sql`
    SELECT country AS code, brand_name AS brand,
      COALESCE(sum(mentions), 0)::int AS mentions,
      bool_or(brand_id = ANY(${own})) AS is_tracked
    FROM summary_brand_mentions
    WHERE ${factScope(scope)} AND is_competitor = 1 AND country IS NOT NULL
    GROUP BY 1, 2
  `)) as unknown as Array<{
    code: string; brand: string; mentions: number; is_tracked: boolean;
  }>;
  return rows.map((r) => ({
    code: r.code,
    brand: r.brand,
    mentions: num(r.mentions),
    isTracked: r.is_tracked === true,
  }));
}

// 테스트가 컴파일된 SQL 형태를 고정할 수 있게 술어 빌더를 노출한다(런타임 호출부는 이 파일 내부뿐).
export const __testables = {
  answerWhere,
  factScope,
  ownedCitationExpr,
  cycleScope,
};

// ════════════════════════════════════════════════════════════════════════════
// 집계층 경로 — S1 대시보드 (PR② T6 · 라운드 2)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: 플랜 `internal-kb/hmg-geo-perf-pr2-aggregate-layer-plan-2026-09-10.md`
//   §3-3(조회 규칙 3 = 같은 표 두 번 스캔 금지) · §3-4(화면 값 판정표) · §6-2(전환 순서 2) ·
//   §9 T6. SQL 은 **한 줄도 여기서 쓰지 않는다** — T4 리더 코어
//   (`summary-trend-aggregates.ts::readTrendAggregates`)가 만든 문장을 그대로 쓴다.
//
// ── 위쪽 세부층 리더와의 관계 ───────────────────────────────────────────────
//
// 위 함수들(`summaryGlobalAggregates` 등)은 **세부층(셀 그레인)** 을 읽고
// `job_id IN (SELECT … FROM summary_answers)` 세미조인을 건다. 아래 함수는 같은 값을
// **집계층(키 그레인)** 에서 낸다 — 조인 0, `count(DISTINCT …)` 는 생성 시각에 int 로
// 굳어 있다. 세부층 리더는 지우지 않는다: (a) 패리티 하네스(`scripts/summary/parity-trend.ts`
// ·`parity-global-s1.ts`)의 기대값이고 (b) 프롬프트 수 계열(§3-4 16·17)은 여전히 세부층이 낸다.
//
// ── 라운드 2에서 바뀐 것: **카드와 GEO 가 한 read 를 나눠 쓴다** ────────────
//
// 라운드 1은 카드가 `own+brands+domains` 3문장, GEO 가 `own+brands` 2문장을 따로 냈다.
// `summary_trend_brands` 를 **두 번 스캔**한 셈이고(실측 250.8 + 234.6 ms), 페이지 DB 합이
// 735.8 ms 였다. T4 라운드 3의 `only` 선택자와 `axes.domainCountry` 가 그 중복을 없앤다:
//
//   · GEO 의 `(country, brand_name)` 은 **이미** 브랜드 문장의 grouping set 이다.
//   · GEO 의 국가별 인용 분모·분자는 `axes.domainCountry` 로 도메인 문장에 `(country)`
//     grouping set 을 더해 얻는다 — 국가 45행이라 사실상 공짜다(T4 실측).
//
// → **한 렌더 = 3문장**이고 두 위젯(① KPI 카드 · ④ GEO)이 그 결과를 나눠 쓴다.
//   요청 안에서 두 번 부르지 않도록 접는 것은 호출부 몫이다
//   (`lib/scope/server.ts::requestS1` — React cache 로 문자열 키에 접는다).
//
// ⚠️ 대가 하나를 명시한다: 국가 축을 **절단하지 않으므로**(`geoBrandPerCountry: null`)
//    GEO 를 안 그리는 역할(country·vendor 등 `showsGeoMap=false`)도 국가×브랜드 행을
//    페이로드로 받는다. 절단하면 `marketStats` 의 분모(그 시장 전 브랜드 언급 합)가
//    이름 없는 잔여 행으로 접혀 SoV 가 틀리므로, 값 정확성을 택했다.
//
// ── ⑤ 분자의 소스 (라운드 2에서 바뀜) ──────────────────────────────────────
//
// 라운드 1의 GEO 는 국가별 ⑤ 를 `trend_own.own_citations`(생성 시각에 (변형,country,lang)
// 로 굳힌 값)에서 냈다. 라운드 2는 카드와 **같은 소스**를 쓴다 — `trend_domains` 의
// `(country)` 축에 `ownedCitationExpr($sel)` FILTER 를 건 값. 그래야 "국가별 ⑤ 를 합치면
// 카드의 ⑤ 가 된다" 가 성립한다(라운드 1에서는 갈렸다: 무필터 9,888 vs 카드 정본 기준).
// `own_citations` 는 그대로 감사값으로 남는다(플랜 §10 T3 정정).
//
// ── 빈 집계층 = 폴백 (플랜 §5-2) ───────────────────────────────────────────
//
// 행 0개는 "측정 대기" 가 아니라 **접기가 안 돌았다**는 뜻이다. 0 으로 그리면 고객이
// "성과가 0" 으로 읽는다. 판정은 **이중**이다(아래 `summaryGlobalS1FromTrend` 주석).

/**
 * 집계층 읽기 결과 — `empty` 는 **폴백 신호**다(값 0 이 아니다).
 * `empty: false` 면 `value` 는 항상 있다.
 */
export type SummaryTrendRead<T> = { empty: true } | { empty: false; value: T };

const EMPTY_READ = { empty: true } as const;

/**
 * S1 한 렌더가 집계층에 내는 문장 — **3개**. 카드와 GEO 가 이 결과를 나눠 쓴다.
 *
 * `answers`(=`summary_trend_answers`)는 없다: 모수·지역 롤업이 `trend_own` 의
 * `()`·`(country)` 그룹핑 셋에서 나오고, 퍼널·주제 도넛은 프롬프트 그레인이라
 * 세부층(`summaryGlobalPromptTopics`)이 낸다.
 */
export const S1_STATEMENT_KEYS: readonly TrendStatementKey[] = ["own", "brands", "domains"];

/**
 * S1 read 의 선택 축 — 도메인 표에 `(country)` 를 더한다(GEO 의 ⑤ 분모·분자).
 * `domainCountryGroup`(국가×카테고리)은 **켜지 않는다** — T4 실측 172→361 ms·
 * 출력 10,616→40,436행이고 S1 에 그 지면이 없다.
 */
export const S1_TREND_AXES: TrendAxes = { domainCountry: true };

/**
 * S1 read 의 절단. 국가 축은 자르지 않는다(위 ⚠️). 브랜드 축 top-200 은 유지 —
 * 카드가 쓰는 것은 당사 합계와 상위 외부 브랜드 하나뿐이고, 총언급은 잔여 행이 보존한다.
 */
export const S1_TREND_LIMITS: TrendLimits = { geoBrandPerCountry: null };

/** 한 read 가 내는 세 위젯분. `geo === null` = GEO 축이 안 섬 → **GEO 만** 미러 폴백. */
export interface SummaryGlobalS1 {
  aggregates: StandardAggregates;
  geo: GeoKpiResult | null;
  /**
   * 카드 하단 **경쟁사 행**의 미니값(PR④ B1). `toStandardAggregates` 가 버리던 브랜드 축
   * 필드(`rank_sum`·`ranked_answers`·감정 4계열)를 같은 행에서 그대로 뽑는다 —
   * **추가 문장 0**(`S1_STATEMENT_KEYS` 의 `brands` 문장이 이미 이 행을 싣고 온다).
   */
  competitors: CompetitorBrandValue[];
}

/** 집계층의 빈 차원은 `''` 다(fold.ts) — 오늘 리더의 `COALESCE(country,'UNKNOWN')` 에 맞춘다. */
const regionLabel = (bucket: string | null): string => (bucket ? bucket : "UNKNOWN");

/**
 * 회차 집합의 최신 기준일 — 오늘 리더의 `scope.cycle`(단일 회차)과 **같은 규칙**.
 * 산출은 `cycle-set.ts::cycleSetAsOf` 한 곳이다(앵커 축이면 귀속 날짜, 아니면 ISO).
 */
function asOfOf(set: CycleSet): string | null {
  return cycleSetAsOf(set.cycles);
}

/**
 * 글로벌 ⑤ 분자 — `domains` 문장의 `group` 축(group_key 단위, **절단 없음**)을 JS 분류기로
 * 합산한다(제품 책임자 2026-09-29: 공식(HMG) = 출처 카테고리 차트와 같은 분류).
 *
 * 이 축이 절단 없이 온다는 것이 전제다(`S1_TREND_LIMITS` 가 `group` 을 안 건드린다 =
 * 리더 기본값 `null`). 잘린 잔여 행(`isRest`)은 이름이 없어 분류할 수 없으므로, 잔여가
 * 보이면 **던진다** — 조용히 과소 집계하는 것보다 폴백(세부층/미러)이 낫다.
 */
function officialHmgFromGroupAxis(
  domains: TrendAggregates["domains"],
  overrides: CitationOverrideMap,
): number {
  const groups = domains.filter((r) => r.axis === "group");
  if (groups.some((r) => r.isRest)) {
    throw new Error("summary S1: group axis truncated — official(HMG) numerator needs every group_key");
  }
  return officialHmgCitationsOf(
    groups.map((r) => ({ key: r.groupKey, citations: r.citations })),
    overrides,
  );
}

/** 카드 매핑 — 오늘의 `summaryGlobalAggregates` 와 **같은 반환 타입**. 순수 함수. */
function toStandardAggregates(
  agg: TrendAggregates,
  set: CycleSet,
  ownTotal: TrendOwnRow,
  /**
   * 글로벌 ⑤ 분자(공식(HMG) 카테고리)를 싣는다. 생략하면 필드가 없다 — 테스트·종전 호출부가
   * 종전 정의(`ownedCitations`)로 읽힌다(`citationShareNumerator`). 런타임 호출부
   * (`summaryGlobalS1FromTrend`)는 항상 넘긴다.
   */
  overrides?: CitationOverrideMap,
): StandardAggregates {
  const regions = agg.own
    .filter((r) => r.axis === "country")
    .map((r) => ({
      region: regionLabel(r.bucket),
      answerCount: r.monitored,
      trackedAnswerCount: r.trackedAnswers,
    }))
    .sort((a, b) => a.region.localeCompare(b.region));

  // ② 타일 — 브랜드 축만. **`country === null` 로 가르지 마라**(리더 라운드 3):
  //    `axes.engineBrand` 를 켜면 엔진 행도 country 가 null 이다. 축 판별은 `axis` 로만.
  //    잔여 행(`isRest`)은 목록에서 빼고 분모(총언급)에는 더한다.
  const brandRows = agg.brands.filter((r) => r.axis === "brand");
  const totalMentions = brandRows.reduce((s, r) => s + r.mentions, 0);
  const brands = brandRows
    .filter((r) => !r.isRest && r.brandName !== null)
    .map((r) => ({
      name: r.brandName as string,
      mentionCount: r.mentions,
      answerCount: r.answers,
      isTracked: r.isTracked,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount);

  const domTotal = agg.domains.find((r) => r.axis === "total");
  const domains = agg.domains
    .filter((r) => r.axis === "domain" && !r.isRest && r.domain !== null)
    .map((r) => ({
      host: r.domain as string,
      citingAnswers: r.citingAnswers,
      citationCount: r.citations,
      ownedCitationCount: r.ownedCitations,
      isOurs: r.isOurs,
    }))
    .sort((a, b) => b.citingAnswers - a.citingAnswers);

  return {
    rootProjectId: getStandardRootId() ?? "",
    asOf: asOfOf(set),
    totalAnswers: ownTotal.monitored,
    totalMentions,
    trackedAnswerCount: ownTotal.trackedAnswers,
    brands,
    regions,
    citations: {
      // ⚠️ 분모는 `monitored` 가 아니라 **인용 계열 모수**다(0071 `hidden_scope='citations'`
      //    회차를 분자에서 뺐으므로 분모에서도 빼야 비율이 정합한다). 뺄 회차가 없으면
      //    두 값이 같다: `TrendOwnRow.citMonitored` 머리 주석.
      // `?? monitored` 는 방어다: 이 리포의 tsconfig 가 `**/*.test.ts` 를 exclude 해서
      // 행 리터럴을 만드는 테스트·스크립트가 새 열을 빠뜨려도 **컴파일 에러가 안 난다**.
      // 그때 분모가 `undefined` 로 새면 비율이 통째로 죽으므로 모수로 접는다.
      sampledAnswers: ownTotal.citMonitored ?? ownTotal.monitored,
      // `trend_own.citing_answers` = 인용이 1건 이상인 답변 수(fold: `summary_answers`
      // 의 `all_citations > 0`). 오늘 리더의 domain 표 distinct 와 같은 모집단이다.
      answersWithCitation: ownTotal.citingAnswers,
      totalCitations: domTotal?.citations ?? 0,
      ownedCitations: domTotal?.ownedCitations ?? 0,
      ...(overrides ? { officialHmgCitations: officialHmgFromGroupAxis(agg.domains, overrides) } : {}),
      domains,
    },
    position: {
      // ④ 는 job 별 당사 최선 **서수** 평균 = Σ서수 / 순위 있는 답변 수(§3-4 5).
      avgPosition:
        ownTotal.rankedAnswers > 0 ? round1(ownTotal.rankSum / ownTotal.rankedAnswers) : null,
      sampledAnswers: ownTotal.rankedAnswers,
    },
    sentiment: {
      positiveRate:
        ownTotal.ownSignals > 0
          ? round1((100 * ownTotal.ownPositive) / ownTotal.ownSignals)
          : null,
      positiveMentions: ownTotal.ownPositive,
      sampledMentions: ownTotal.ownSignals,
    },
  };
}

/**
 * 경쟁사 행 매핑(카드 하단 미니값) — **미러 산식을 그대로 옮긴 것**. 순수 함수.
 *
 * 대응은 1:1 이다(미러 `aggregateMentionsFromMirror` `scope-aggregates.ts:3465-3489`):
 *
 *   | 필드 | 미러 | 집계층(여기) |
 *   | --- | --- | --- |
 *   | `mentions`    | `sum(mention_count)` | `trend_brands.mentions` |
 *   | `share`       | `pctOf(mentions, Σ brandRows.mentions)` | 같은 식. 분모는 **잔여 행 포함** 브랜드 축 합 |
 *   | `mentionRate` | `pctOf(answers, totalAnswers)` | `pctOf(brand.answers, ownTotal.monitored)` |
 *   | `avgPosition` | `pos_sum / pos_cnt` — `(name, job)` min 위의 `rank()` 평균 | `compRankSum / compRankedAnswers` — **같은 규칙**(0069) |
 *   | `sentiment`   | `sum(s_pos/s_neu/s_neg/s_mix)` | `positive/neutral/negative/mixed` |
 *
 * ✅ **다섯 열 전부 산식이 같다**(2026-09-10, PR④-b). 남는 차이는 **창·모수**뿐이다
 *    (미러 = 전 이력 · 집계층 = 회차 스냅샷).
 *
 *    초판(B1)은 `avgPosition` 에 `rankSum / rankedAnswers` = 본문 **텍스트 내 서수**를 썼고,
 *    그것만 축이 달랐다 — 같은 회차 `74eca7fb` 실측으로 Hyundai 경쟁 **3.3469** vs 서수
 *    **16.4041** · Tesla 3.9765/18.9899 (7개 전체 정본표 = 마이그레이션
 *    `0069_summary_trend_brands_comp_rank.sql` 헤더. 여기 복사하지 마라 — F4).
 *    카드 ④ 자신이 경쟁 순위 축(2.6)이라 **같은 카드 안에서 2.6 옆에 19+**
 *    가 서는 형태였다. 0069 가 접기에 `comp_rank_sum`/`comp_ranked_answers` 를 굳혀
 *    (`fold.ts` 의 `COMP_RANK_GATE`/`COMP_RANK_TP`/`compRankOver` — `trend_own` 과 **공유**)
 *    축을 하나로 맞췄다. `rankSum` 은 GEO 위젯(`toGeoKpi` 의 `posSum`)이 계속 쓴다.
 *
 * ⚠️ 0069 **미적용**(또는 적용 후 refold 전) DB 에서는 `compRankedAnswers` 가 0 이라
 *    `avgPosition` 이 `null` 이다 — 틀린 숫자가 아니라 빈칸으로 나온다. 마이그레이션
 *    헤더의 refold 두 줄이 그 해소 절차다.
 *
 * ⚠️ 분모 두 개를 헷갈리지 말 것:
 *    · `share` 분모 = 브랜드 축 언급 합(잔여 포함) — `toStandardAggregates` 의
 *      `totalMentions` 와 **같은 값**이라 카드 ② 와 경쟁사 점유율이 같은 분모를 쓴다.
 *    · `mentionRate` 분모 = `trend_own.monitored`(모수). 브랜드 축을 가로질러 SUM 하면
 *      이중 계상이다(`TrendBrandRow.answers` 주석 §7-2 2).
 */
function toCompetitorBrands(agg: TrendAggregates, ownTotal: TrendOwnRow): CompetitorBrandValue[] {
  const brandRows = agg.brands.filter((r) => r.axis === "brand");
  const totalMentions = brandRows.reduce((s, r) => s + r.mentions, 0);
  // 미러 `pctOf` 와 **바이트 동일**: 소수 첫째 자리 반올림, 분모 0 이면 0(null 아님).
  const pctOf = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return brandRows
    .filter((r) => !r.isRest && r.brandName !== null)
    .map((r) => ({
      brand: r.brandName as string,
      mentions: r.mentions,
      share: pctOf(r.mentions, totalMentions),
      mentionRate: pctOf(r.answers, ownTotal.monitored),
      // ④ 축(답변 안 경쟁 순위) — 카드 ④(`ownTotal.rankSum / rankedAnswers`)와 같은 규칙.
      // `rankSum`(본문 서수)을 쓰면 안 된다(위 대조표 · 0069).
      avgPosition:
        r.compRankedAnswers > 0 ? round1(r.compRankSum / r.compRankedAnswers) : null,
      isTracked: r.isTracked,
      sentiment: {
        positive: r.positive,
        neutral: r.neutral,
        negative: r.negative,
        mixed: r.mixed,
      },
    }))
    // 미러는 `ORDER BY mentions DESC` 로 온다. 소비자(`competitorMinis`)가 다시 정렬하지만
    // 동률의 순서까지 결정적이어야 패리티 대조가 성립한다.
    .sort((a, b) => b.mentions - a.mentions || a.brand.localeCompare(b.brand));
}

/**
 * GEO 매핑(Overview 국가별 KPI 5종) — **R5 배선 누락의 수리**. 순수 함수.
 *
 * 오늘 화면은 `fetchStandardGeoKpi` → `aggregateGeoKpiFromMirror`(미러 3문장, 프로덕션
 * EXPLAIN 콜드 2.14 s)를 쓴다. 사실표 쌍둥이 `summaryGlobalGeoCompetition` 은 언급 수만
 * 내서 KPI 5종에 못 붙었다(국가별 모수·인용이 없다). 집계층은 셋을 전부 갖고 있고,
 * 라운드 2부터는 **카드와 같은 3문장**에서 나온다(추가 문장 0).
 *
 * 값의 출처:
 *   · `codes[].answers`/`ownAnswers` → `trend_own` `(country)` 축
 *   · `codes[].citTotal`/`citOwned`  → `trend_domains` `(country)` 축(`axes.domainCountry`)
 *   · `brands[]`                     → `trend_brands` `(country, brand_name)` 축
 *
 * ⚠️ 미러와 **모수 정의가 다르다**: 미러 GEO 는 `count(*)`(답변 수), 집계층은
 *    `sum(monitored)`. 카드(①~⑤)가 쓰는 정의는 후자이므로, 이 전환으로 GEO 가 카드와
 *    같은 모수를 쓰게 된다(2026-09-10 실측 무필터 38,745 → 37,570).
 */
function toGeoKpi(agg: TrendAggregates): GeoKpiResult | null {
  const citBy = new Map(
    agg.domains
      .filter((r) => r.axis === "country" && r.country)
      .map((r) => [r.country as string, r]),
  );
  const codes = agg.own
    .filter((r) => r.axis === "country" && r.bucket)
    .map((r) => {
      const c = citBy.get(r.bucket as string);
      return {
        code: r.bucket as string,
        answers: r.monitored,
        ownAnswers: r.trackedAnswers,
        citTotal: c?.citations ?? 0,
        citOwned: c?.ownedCitations ?? 0,
        // 글로벌 ⑤ 분자 — S1 read 에 공식(HMG) 키 목록이 실렸을 때만(국가 축 행의 같은 열).
        ...(typeof c?.officialCitations === "number" ? { citOfficialHmg: c.officialCitations } : {}),
      };
    });

  const brands = agg.brands
    .filter((r) => r.axis === "country" && !r.isRest && r.brandName !== null && r.country)
    .map((r) => ({
      code: r.country as string,
      brand: r.brandName as string,
      mentions: r.mentions,
      isTracked: r.isTracked,
      answers: r.answers,
      // GEO 의 posSum/posCnt = `first_rank` 합·개수(브랜드별 정의). `trend_own.rank_sum`
      // (job 별 당사 최선 서수)과 **다른 축**이다 — 섞지 말 것(fold.ts 머리 주석).
      posSum: r.rankSum,
      posCnt: r.rankedAnswers,
      sentPositive: r.positive,
      sentTotal: r.positive + r.neutral + r.negative + r.mixed,
    }));

  // 축 둘 중 하나라도 안 서면 분자·분모가 짝이 안 맞아 KPI 5종이 조용히 0 이 된다.
  // 그때는 **GEO 만** 미러로 돌린다(카드는 이미 유효하다).
  if (codes.length === 0 || brands.length === 0) return null;
  return { brands, codes };
}

/**
 * S1 한 렌더분 — 카드 + GEO 를 **문장 3개**로 낸다.
 *
 * ── 빈 판정이 **이중**인 이유 ───────────────────────────────────────────────
 *
 * ① `agg.empty`(리더 라운드 3) — 네 문장이 함께 내는 `key_rows` 로 "그 회차에 집계층 행이
 *    있는가" 를 센다. 라운드 2까지는 "행 0개" 로 판정해 **절대 발화하지 않았다**
 *    (`GROUPING SETS ((), …)` 가 입력 0행에도 합계 행 1개를 낸다). 지금은 발화한다.
 * ② `monitored === 0` — ①이 못 잡는 것을 잡는다: 집계층에 행은 있는데 **이 필터·이 변형에
 *    해당하는 모수가 0** 인 경우다(`own_variant` 오타·필터 공집합). ①의 `keyRows` 는
 *    `own` 문장이 읽은 행 수라 변형이 어긋나면 0이 되지만, `brands` 는 변형으로 안
 *    걸러지므로 행이 남아 `empty=false` 가 될 수 있다.
 *    둘 다 처방이 같다(종전 경로로 돌아간다) — 그래서 구분하지 않고 함께 폴백한다.
 *    필터가 정말 공집합이면 미러도 빈 값을 내므로 화면 문구는 종전과 같다.
 */
export async function summaryGlobalS1FromTrend(
  scope: TrendReadScope,
): Promise<SummaryTrendRead<SummaryGlobalS1>> {
  const [agg, overrides] = await Promise.all([
    readTrendAggregates(scope, { only: S1_STATEMENT_KEYS }),
    // 카테고리 차트(인용 탭)와 **같은 맵** — 오버라이드도 같은 로더에서 온다.
    loadCitationOverrides(),
  ]);
  if (agg.empty) return EMPTY_READ;
  const ownTotal = agg.own.find((r) => r.axis === "total");
  if (!ownTotal || ownTotal.monitored === 0) return EMPTY_READ;
  return {
    empty: false,
    value: {
      aggregates: toStandardAggregates(agg, scope.set, ownTotal, overrides),
      geo: toGeoKpi(agg),
      competitors: toCompetitorBrands(agg, ownTotal),
    },
  };
}

/** 테스트가 매핑 규칙을 고정할 수 있게 노출한다(런타임 호출부는 이 파일 내부뿐). */
export const __trendTestables = {
  regionLabel,
  asOfOf,
  toStandardAggregates,
  toGeoKpi,
  toCompetitorBrands,
};

// ════════════════════════════════════════════════════════════════════════════
// 집계층 경로 — S3 인용 화면 + 출처 도넛 (PR② T7)
// ════════════════════════════════════════════════════════════════════════════
//
// 조립은 표면 공통 리더(`summary-citation-read.ts`)가 한다 — 이 파일이 주는 것은
// **글로벌 열의 술어 두 벌**뿐이다:
//   · 집계층 술어 = `TrendReadScope`(호출부가 만든다)
//   · 세부층 술어 = `answerWhere` — `summary_answers` 와 `summary_domain_citations`
//     **양쪽에 그대로** 걸린다. 두 표가 같은 축 컬럼을 denormalize 해서 갖고 있기
//     때문이고(0059 + 0063), 그래서 2단 조회가 오늘의 `factScope` 세미조인
//     (`job_id IN (SELECT … FROM summary_answers)`)을 쓰지 않는다.
//     2026-09-10 라이브 대조(회차 `74eca7fb`): 직접 술어 10,537 그룹 · 세미조인
//     10,537 그룹 · **불일치 0**, 355.92 ms → top-80 한정 182.38 ms.
//
// ⚠️ 이 경로는 `CitationsLive` 의 **롤업만** 낸다(드릴다운 `urls`·`promptList`·
//    `promptSplit` 과 주 단위 `trend`/`categoryTrend` 는 사실표 밖 = PR③).
//    그래서 호출부가 **소비자 단위**로 게이트한다 — `lib/scope/server.ts` 참조.

/**
 * `TrendReadScope`(회차 집합) → 세부층 술어용 단일 회차 스코프.
 * 글로벌은 스냅샷에서 회차가 1개다(§6-1 규칙 1) — 2개 이상이면 세부층 술어가
 * 표현할 수 없으므로 `null` 을 내고 호출부가 폴백한다(조용히 한 회차만 세지 않는다).
 */
function detailScopeOf(scope: TrendReadScope): SummaryGlobalScope | null {
  const cycles = scope.set.cycles;
  const rootId = scope.set.projectIds[0];
  if (cycles.length !== 1 || !cycles[0] || !rootId) return null;
  return {
    cycle: cycles[0] as SummaryCyclePick,
    rootProjectId: rootId,
    filters: scope.filters,
    ownedBasePrefixes: scope.ownedBasePrefixes,
  };
}

/**
 * S3 read 의 절단 — 카테고리 축(`group_key`)은 **자르지 않는다**. 카테고리 매핑이
 * 조회 시각 파생(`COALESCE(override, rule)`)이라 SQL 에서 접으면 꼬리의 카테고리가
 * 통째로 사라진다(T4 `TrendLimits.group` 주석). 도메인 축은 이 화면이 안 쓰므로
 * 기본 절단(80) 그대로 둔다.
 */
export const S3_CITATION_LIMITS: TrendLimits = { group: null };

/** 출처 도넛은 오늘 리더가 도메인 전량을 돌려준다 — 절단하면 도넛의 꼬리가 바뀐다. */
export const S3_SOURCE_LIMITS: TrendLimits = { domain: null, group: null };

export async function summaryGlobalCitationsFromTrend(
  scope: TrendReadScope,
): Promise<CitationTrendRead> {
  const detail = detailScopeOf(scope);
  if (!detail) return { empty: true };
  await presenceSetColumnAvailable();
  const where = answerWhere(detail);
  return summaryCitationsFromTrend({
    trend: { ...scope, limits: { ...S3_CITATION_LIMITS, ...(scope.limits ?? {}) } },
    detailWhere: where,
    answerWhere: where,
  });
}

/**
 * 출처 도넛(SLIM) — 집계층 `domain` 축, 문장 **1개**.
 * 오늘 경로(`summaryGlobalSourceComposition`, 세부층 + job 세미조인)의 쌍둥이다.
 */
export async function summaryGlobalSourceCompositionFromTrend(
  scope: TrendReadScope,
): Promise<SummaryTrendRead<SourceDomainSlice[]>> {
  const agg = await readTrendAggregates(
    { ...scope, limits: { ...S3_SOURCE_LIMITS, ...(scope.limits ?? {}) } },
    { only: ["domains"] },
  );
  if (agg.empty) return EMPTY_READ;
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(scope.ownedBasePrefixes));
  return { empty: false, value: sourceCompositionFrom(agg.domains, pattern) };
}
