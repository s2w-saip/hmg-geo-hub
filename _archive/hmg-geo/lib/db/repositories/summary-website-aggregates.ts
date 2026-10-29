import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  getStandardRootId,
  type StandardFilters,
  type StandardAggregates,
} from "@/lib/scope/result-adapter";
import { trackedEntityIdsFor } from "@/lib/scope/hmg-brands";
import { summaryCountryGeoPred, websiteSiteGeoPred } from "@/lib/db/repositories/website-geo-pred";
import {
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
  registrableDomainOfHost,
} from "@/lib/geo-catalog/owned";
import type { WebsiteCyclePick } from "@/lib/db/repositories/summary-cycles";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import {
  summaryCitationsFromTrend,
  type CitationTrendRead,
} from "@/lib/db/repositories/summary-citation-read";
// 타입만 가져온다(런타임 순환 없음) — 집계층 read 의 폴백 신호 계약은 표면 공통이다.
import type { SummaryTrendRead } from "@/lib/db/repositories/summary-global-aggregates";
import {
  planTrendRead,
  readTrendAggregates,
  type TrendAggregates,
  type TrendAxes,
  type TrendBrandRow,
  type TrendLimits,
  type TrendReadScope,
  type TrendStatementKey,
} from "@/lib/db/repositories/summary-trend-aggregates";
import {
  presenceSetColumnAvailable,
  summaryPresencePredicate,
} from "@/lib/summary/read/presence";
import type {
  StandardSubKpis,
  PromptTopicSlice,
  SourceDomainSlice,
  GeoBrandMention,
  CitationAccuracyResult,
  CitationAccuracyTrendBucket,
  StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
// 세부층 폴백에도 미러와 **같은 규약**의 예산을 건다(PR③ R2) — 문장마다 자기 트랜잭션 +
// `SET LOCAL statement_timeout`. 예산을 안 넘기면 원본 db 를 그대로 돌려주므로 무비용이다.
import { budgetedMirrorDb, type AnswerSetBudget } from "@/lib/db/repositories/scope-aggregates";

// 웹사이트 대시보드(S4)의 사실표 조회 — 설계 v4.1 §6-2(웹사이트 열)·§6-4.
//
// 반환 타입은 미러 경로와 **동일**하다. 화면(app/[locale]/(dash)/website)은 어느
// 경로로 왔는지 모른다 — 그것이 폴백을 언제든 켤 수 있게 하는 유일한 조건이다.
//
// 판정은 여기서 하지 않는다(그것이 사실표의 요점): 굳혀진 행을 고르고, 작은 집합
// 비교($own·$sel·$tk)와 나눗셈만 한다. 필터 술어는 §6-2 웹사이트 열 그대로 —
// in_tagged_region·in_root_catalog·in_full_cycle·숨김 국가는 **적용하지 않는다**.

const num = (v: unknown): number => Number(v ?? 0);
const round1 = (v: unknown): number => Math.round(Number(v) * 10) / 10;

export interface SummaryWebsiteScope {
  cycles: WebsiteCyclePick[];
  projectIds: string[];
  filters: StandardFilters;
  /** 웹사이트 선언 base(website_prompts.owned_base_url) 또는 카탈로그 폴백 — 게이트웨이가 넘긴 것. */
  ownedBasePrefixes: string[];
  /**
   * 0060 유닛 고유 플래그를 쓸 수 있는가(`summaryUnitFlagsAvailable()` 결과).
   *
   * true 면 ⑤·⑥·"자사 인용 답변" 이 **보고서 v2.4 와 같은 판정**을 쓴다 — 유닛
   * (brand×country×lang×fs)마다 그 유닛의 타겟 URL 에서 도출한 base 하나로 자사를
   * 가르는 규칙(정본: `scripts/reports/extract-citation-data.mts` 의 `BASE` +
   * `bn = BASE OR bn LIKE BASE/%`). 화면과 발행 리포트가 같은 수를 내야 한다.
   *
   * false 면 종전 경로($sel/matched_base 최장 일치 + 도메인 서픽스 폴백) — 0060 이
   * 아직 안 붙은 DB 에서도 코드가 살아남아야 한다(머지 = 무인 배포).
   */
  unitFlags: boolean;
  /** 보고서 제외 유닛(file_seq) — unitFlags 일 때만 적용. 없으면 []. */
  excludedUnits?: number[];
  /**
   * T9 게이트가 판정한 회차 집합(`lib/summary/read/cycle-set.ts`). 집계층 리더가
   * 요구하는 형태 그대로다 — server.ts 가 `SummaryReadRoute`(= `CycleSet` + path)를
   * 벗겨 넘긴다.
   *
   * 생략하면 `cycles` 에서 **스냅샷 집합을 파생**한다(스크립트·테스트 호환). 파생은
   * 값 계산뿐이고 판정은 하지 않는다 — 판정은 게이트 한 곳(§6-3)에만 있다.
   */
  set?: CycleSet;
}

// ── 작은 집합들 ──────────────────────────────────────────────────────────────

/** `$own` — 당사 엔티티 id. 오늘의 판정과 같은 함수·같은 입력(SA 의 trackedRollupIn). */
function ownIds(f: StandardFilters): string[] {
  return trackedEntityIdsFor(f.contextBrand ?? f.brand, f.ownEntities);
}

/**
 * `$sel` — 사실표 `matched_base` 와 같은 정규형으로 접은 선택 base 목록.
 * 생성기가 base_universe 를 같은 `ownedBasePrefixFromUrl` 로 접어 저장한다는 계약.
 */
function selectedBases(prefixes: string[]): string[] {
  return [...new Set(prefixes.map(ownedBasePrefixFromUrl).filter(Boolean))] as string[];
}

// `$fbPattern` — base 정규화가 불가능했던 행(base_norm_null=1)의 도메인 서픽스 폴백.
// scope-aggregates.ts 의 ownedDomainPatternFor/ownedFallbackDomains(SA:305-318)와
// **같은 규칙**이어야 한다(그쪽은 export 되지 않아 여기 복제한다 — 규칙을 바꾸면
// 두 곳을 함께 고쳐야 하고, summary-website-aggregates.sql.test.ts 가 형태를 고정한다).
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

const textArray = (vals: string[]): SQL =>
  sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::text[]`;
// uuid/date 목록은 **값 하나짜리 바인드 1개**(배열)로 넘긴다 — 종전 `ARRAY[$1,$2,…]`
// 펼침은 웹사이트 함대(95 프로젝트)에서 문장당 수백 개의 바인드를 만들었고, 그것이
// pg_stat_statements 에 `$773` 짜리 문장으로 남아 계획 재사용을 막았다(PR① B4-a).
// 배열은 반드시 `sql.param` 으로 — 템플릿에 JS 배열을 직접 넣으면 record 로 바인딩돼
// "cannot cast type record to …"(실 DB 실측 2026-09-06, 아래 excludedUnits 주석과 동일 함정).
const uuidArray = (vals: string[]): SQL => sql`${sql.param(vals)}::uuid[]`;
// ⚠️ `sql.param(배열)::date[]` 는 실DB 에서 죽는다 — drizzle-orm/postgres-js/driver.js:15-22 가
// OID 1082·1083·1114·1182·1184·1185·1115·1231(date/time/timestamp[tz]/numeric 과 그 배열)의
// postgres.js 직렬화기를 **항등함수로 덮어써** 배열이 그대로 문자열 직렬화기로 들어간다
// (`ERR_INVALID_ARG_TYPE … Received an instance of Array`; 2026-09-10 실DB 실측 —
// raw postgres.js 는 정상, uuid[]·text[]·int[] 는 안전, date[]·timestamptz[]·numeric[] 실패).
// `::text[]::date[]` 로 우회하면 바인딩은 되지만 **파티션 프루닝이 사라진다**(8/8 파티션 스캔,
// 실행 +16~45%·planning 3.5→8.5 ms 실측) — `cycle_week` 는 파티션 키다.
// 주는 항상 1~2개(함대 주)라 pgss `$773` 의 원인이 아니었다 → **스칼라 펼침 원형**을 쓴다:
// `ARRAY[$1, $2]::date[]` 는 프루닝 1파티션 유지·바인드 ≤ 2. 단위 테스트는 컴파일 텍스트만
// 보므로 이 유형은 실DB int 테스트(`summary-website-aggregates.int.test.ts`)가 유일한 그물이다.
const dateArray = (vals: string[]): SQL =>
  vals.length
    ? sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::date[]`
    : sql`ARRAY[]::date[]`;

/**
 * 회차 술어 — 항상 `(cycle_id, generation_id)` **쌍**으로. 주 파티션 프루닝용 cycle_week 동반.
 *
 * 쌍 목록은 인라인 튜플 나열이 아니라 **두 배열의 `unnest` 조인**이다(바인드 2개).
 * 쌍 의미론은 그대로 — 게이트가 고른 (cycle, active generation) 조합만 통과한다.
 * `summary_cycles` 를 다시 조인하지 않는 이유: 그러면 generation 이 **읽기 시점에
 * 다시 해석**되어, 게이트가 판정한 회차와 조회가 읽는 회차가 갈라질 수 있다.
 * 여기서는 게이트가 고른 값을 얼린 채로 넘기는 종전 계약을 유지한다.
 */
function cycleScope(cycles: WebsiteCyclePick[]): SQL {
  const weeks = [...new Set(cycles.map((c) => c.cycleWeek))];
  const cycleIds = cycles.map((c) => c.cycleId);
  const generationIds = cycles.map((c) => c.generationId);
  return sql`cycle_week = ANY(${dateArray(weeks)}) AND (cycle_id, generation_id) IN (
    SELECT p.c, p.g FROM unnest(${uuidArray(cycleIds)}, ${uuidArray(generationIds)}) AS p(c, g)
  )`;
}

/**
 * 답변 모수 술어의 **공유 축** — 세부층 3표(`summary_answers` · `_brand_mentions` ·
 * `_domain_citations`)가 전부 같은 이름·같은 값으로 갖고 있는 축만 모은다.
 * 생성기가 공통 차원 19열을 같은 한 행(`d`)에서 세 표에 함께 적기 때문이다
 * (`lib/summary/generate/types.ts::COL_COMMON`/`D_COMMON`). 그래서 이 술어는
 * **어느 사실표에도 그대로 걸 수 있다** — 세부층 폴백이 조인을 안 쓰는 근거다(T10).
 *
 * 유닛 게이트(`report_fs`)는 여기 없다 — 그 컬럼은 `summary_answers` 에만 있다(0066 실측).
 */
function sharedWhere(scope: SummaryWebsiteScope): SQL[] {
  const f = scope.filters;
  const conds: SQL[] = [
    cycleScope(scope.cycles),
    sql`project_id = ANY(${uuidArray(scope.projectIds)})`,
    // run 상태 게이트는 조회 시(§6-2) — 생성기는 상태 무관으로 굳힌다.
    sql`run_status IN ('completed', 'partial_failed')`,
  ];
  // 국가 = website_sites.country_code **verbatim**(worldwide·middleeast 등 가상 코드
  // 그대로, RHQ→ISO 환원 없음). 표준 표면의 geography 축과 다르다.
  // 가상 브랜드 코드(HYUNDAI-N)는 그 브랜드 사이트의 project_id 로 푼다(website-geo-pred).
  if (f.websiteCountry?.length) conds.push(summaryCountryGeoPred(f.websiteCountry));
  // 언어 = website_prompts.lang_code(소문자). 표준은 대문자 — 표면별 원천 고정.
  if (f.lang?.length)
    conds.push(sql`lang = ANY(${textArray(f.lang.map((v) => v.toLowerCase()))})`);
  if (f.engine?.length) conds.push(sql`engine = ANY(${textArray(f.engine)})`);
  // funnel 원천은 대시보드(S4) = funnel_catalog (인용 화면만 COALESCE, §6-2).
  if (f.funnelStage?.length) conds.push(sql`funnel_catalog = ANY(${textArray(f.funnelStage)})`);
  if (f.listType?.length) conds.push(sql`list_type = ANY(${textArray(f.listType)})`);
  if (f.depth1?.length) conds.push(sql`depth1 = ANY(${textArray(f.depth1)})`);
  if (f.depth2?.length) conds.push(sql`depth2 = ANY(${textArray(f.depth2)})`);
  if (f.depth3?.length) conds.push(sql`depth3 = ANY(${textArray(f.depth3)})`);
  // brandPresence: 하나만 고르면 그 값으로, 둘 다(또는 0개)면 무필터 — S4 규칙.
  // 글로벌 열과 같은 술어를 쓴다(lib/summary/read/presence.ts) — 유도 집합 교집합.
  // 웹사이트 표면에서 값이 바뀌지는 않는다: website_prompts 12,685건 중 루트 카탈로그
  // (`prompts`)에 매칭되는 것이 **0건**이라(2026-09-06 실측) 이 축은 종전에도
  // `brand_presence_resolved IS NULL` 로 0행이었고, presence_set 도 `'{}'` 라 0행이다.
  if (f.brandPresence?.length) {
    const pred = summaryPresencePredicate(f.brandPresence);
    if (pred) conds.push(pred);
  }
  // 브랜드 축은 withWebsite 가 이미 project id 로 흡수했다(catalog_brands 미적용).
  return conds;
}

/**
 * 유닛 게이트 — **`summary_answers` 에만 있는 축**(0060 `report_fs`).
 *
 * 유닛 밖 프롬프트는 웹사이트 화면 모수에서 뺀다(보고서와 동일). 유닛 = 리포트
 * spec 행이고, 거기 안 잡히는 프롬프트(예: Kia/GR 의 kia.com/eu 타겟)는 자사 base 가
 * 그 유닛 것이 아니라 owned 판정이 성립하지 않는다 — 분모에 남기면 ⑤·⑥ 이 보고서와
 * 어긋난다. 0060 이전에는 이 게이트가 없다(= 종전 모수).
 * 보고서가 제외한 유닛(`summary_settings.website_excluded_fs` — 예: Kia CN·UA·KZ)도 뺀다.
 */
function unitWhere(scope: SummaryWebsiteScope): SQL[] {
  if (!scope.unitFlags) return [];
  const conds: SQL[] = [sql`report_fs IS NOT NULL`];
  if (scope.excludedUnits?.length) {
    // 배열은 sql.param 으로 넘긴다 — 템플릿에 JS 배열을 직접 넣으면 record 로 바인딩돼
    // "cannot cast type record to integer[]"(실 DB 실측 2026-09-06). 단위 테스트는 컴파일 텍스트만 봐서 못 잡았다.
    conds.push(sql`report_fs <> ALL(${sql.param(scope.excludedUnits)}::int[])`);
  }
  return conds;
}

/** 답변 모수 술어(§6-2 웹사이트 열) = 공유 축 + 유닛 게이트. `summary_answers` 전용. */
function answerWhere(scope: SummaryWebsiteScope): SQL {
  return sql.join([...sharedWhere(scope), ...unitWhere(scope)], sql` AND `);
}

/** 세 사실표의 공통 술어 = 회차 + 답변 모수 job 집합. */
function factScope(scope: SummaryWebsiteScope): SQL {
  return sql`${cycleScope(scope.cycles)} AND job_id IN (
    SELECT job_id FROM summary_answers WHERE ${answerWhere(scope)}
  )`;
}

/**
 * 세부층 폴백 전용 술어 — **공유 축은 사실표에 직접** 걸고, `summary_answers` 에만
 * 있는 유닛 게이트만 좁은 세미조인으로 남긴다(T10 · PR③).
 *
 * 종전 `factScope` 는 전 축을 세미조인 안에 넣어, 사실표 쪽은 회차만으로 열어 두고
 * job 을 하나씩 되짚었다(글로벌 실측: 32,946 job Nested Loop · 288,835 shared buffer ·
 * 759 ms/문장). 공유 축이 사실표에도 **같은 값으로** 있으므로(위 `sharedWhere` 주석)
 * 바깥에서 먼저 좁히는 편이 항상 낫다.
 *
 * 근거(2026-09-10 라이브 전수, 읽기 전용): 활성 generation 96개의 세부층 전 행
 * (brand_mentions 315,174 · domain_citations 150,729)에 대해 `summary_answers` 와의
 * 공통 19열 대조 — **고아 0 · 불일치 0**.
 *
 * 유닛 게이트가 없으면(0060 이전 DB) 세미조인 자체가 사라진다. 있을 때 안쪽 술어를
 * 축까지 전부 복제하지 않는 이유는 바인드 수다 — 바깥이 이미 공유 축을 거르므로
 * 교집합은 같고(`answerWhere` 와 동치), 안쪽은 회차·프로젝트·유닛만으로 충분하다.
 */
function detailFactScope(scope: SummaryWebsiteScope): SQL {
  const shared = sql.join(sharedWhere(scope), sql` AND `);
  const unit = unitWhere(scope);
  if (!unit.length) return shared;
  return sql`${shared} AND job_id IN (
    SELECT job_id FROM summary_answers
    WHERE ${cycleScope(scope.cycles)}
      AND project_id = ANY(${uuidArray(scope.projectIds)})
      AND ${sql.join(unit, sql` AND `)}
  )`;
}

/** ⑤ owned 판정(종전 경로) — `matched_base` 최장 일치 + base 정규화 불가 행의 도메인 폴백. */
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

/**
 * ⑤ 분자 — 도메인 표의 자사 인용 수.
 * 유닛 플래그가 있으면 생성기가 굳힌 유닛 고유 카운트를 **그대로 더한다**(판정 없음).
 */
function ownedCitationsSum(scope: SummaryWebsiteScope): SQL {
  return scope.unitFlags
    ? sql`COALESCE(sum(unit_owned_citations), 0)::int`
    : sql`COALESCE(sum(citations) FILTER (WHERE ${ownedCitationExpr(scope.ownedBasePrefixes)}), 0)::int`;
}

/** 인용 표(citations.domains)의 `isOurs` — ⑤ 분자와 **같은 판정**이어야 대조가 된다. */
function ownedDomainAgg(scope: SummaryWebsiteScope): SQL {
  return scope.unitFlags
    ? sql`bool_or(unit_owned_citations > 0)`
    : sql`bool_or(${ownedCitationExpr(scope.ownedBasePrefixes)})`;
}

const ownArray = (f: StandardFilters): SQL => {
  const ids = ownIds(f);
  return ids.length ? uuidArray(ids) : sql`ARRAY[]::uuid[]`;
};

// ④ 브랜드 내 순위 — 사실표 쌍둥이 (2026-09-06). 미러 경로
// scope-aggregates.ts::ownBrandRankPerJobSql 머리 주석이 배경(코어 카탈로그 팽창으로
// `first_rank`(=min avg_position) 의 서수가 밀린 것) 정본. 사실표는 답변별 브랜드 행을
// 전부 갖고 있으므로 읽기 시점에 같은 순위를 만든다: (job, brand_id) 별 min(first_rank)
// 을 접고 답변 안에서 rank(). 모집단은 `is_competitor = 1`(= 비경쟁 노이즈 제외를
// 통과한 행 — 자사 포함, 생성기 website-0904.ts `isCompetitor` 참조).
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

// ════════════════════════════════════════════════════════════════════════════
// 집계층(summary_trend_*) 경로 — S4 대시보드 (PR② T5)
// ════════════════════════════════════════════════════════════════════════════
//
// 카드 ①~⑤·지역 롤업·브랜드 타일·출처 도넛·GEO 는 **세부층을 읽지 않는다.**
// 세부층 리더는 `summary_answers` 와 `job_id` 세미조인을 했고, 그 조인 하나가
// 라이브에서 3,543 ms 였다(2026-09-10 실측 `scripts/summary/repro-website-timing.ts`).
// 집계층은 키 그룹이 필터 축을 전부 들고 있어 그 조인이 없다.
//
// 이 파일에 남는 세부층 문장은 **둘뿐**이고 둘 다 플랜이 명시한 예외다:
//   · `summaryWebsitePromptTopics` — 프롬프트 distinct(§3-4 17). prompt 는 키 그룹을
//     가로지르므로 집계층 SUM 이 이중 계상이다.
//   · `summaryWebsiteCitationAccuracy`(⑥) — 조회 시각 `$tk` 의존(§3-4 7, E3).
//   (`summaryWebsiteSubKpis` 는 아직 세부층이다 — 아래 머리 주석 참조.)
//
// ── 판정은 여기서 하지 않는다 ───────────────────────────────────────────────
//
// "집계층을 읽어도 되는가"(축·변형)는 `planTrendRead`, "그 회차가 접혀 있는가" 는
// `websiteTrendFoldPresent`, "어느 회차인가" 는 T9 게이트다. 이 파일은 게이트를 통과한
// 요청만 받는다 — 통과하지 않은 요청이 들어오면 **조용히 0 을 그리지 않고 throw** 한다.

/** 절단 없음 — 오늘 리더가 브랜드·도메인을 전량 돌려주므로 페이로드 동치를 유지한다. */
const WEBSITE_TREND_LIMITS: TrendLimits = {
  domain: null,
  group: null,
  brand: null,
  geoBrandPerCountry: null,
};

/**
 * `set` 이 없을 때의 스냅샷 집합 파생 — 스크립트·테스트 호환용. **판정 없음**(값 계산만).
 * 모수는 T9 계약 ③ 그대로 "회차가 있는 프로젝트"다(`scope.projectIds` 가 아니라 cycles).
 */
function snapshotSetOf(scope: SummaryWebsiteScope): CycleSet {
  const cycles = scope.cycles;
  return {
    surface: "website",
    mode: "snapshot",
    cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

function trendScopeOf(scope: SummaryWebsiteScope, axes?: TrendAxes): TrendReadScope {
  const plan = planTrendRead({
    surface: "website",
    filters: scope.filters,
    unitFlags: scope.unitFlags,
  });
  // 게이트(server.ts::viaTrend)가 먼저 같은 판정을 하므로 라이브에서는 도달 불가다.
  // 도달했다면 배선이 끊긴 것이고, 그때 0 을 그리는 것보다 죽는 편이 싸다.
  if (!plan.ok) {
    throw new Error(`summary-website: 집계층 밖 요청(${plan.reason}) — 게이트가 폴백했어야 한다`);
  }
  return {
    set: scope.set ?? snapshotSetOf(scope),
    filters: scope.filters,
    ownVariant: plan.ownVariant,
    ownedBasePrefixes: scope.ownedBasePrefixes,
    unitFlags: scope.unitFlags,
    excludedUnits: scope.excludedUnits,
    limits: WEBSITE_TREND_LIMITS,
    axes,
  };
}

const EMPTY_TREND: TrendAggregates = {
  own: [], answers: [], brands: [], domains: [], empty: true,
};

/**
 * 집계층 읽기 — **위젯이 쓰는 표만** 발행한다(라운드 3 `only`).
 *
 * 라운드 1은 위젯 3개가 각자 4문장을 내 렌더당 **12문장**이었다(전환 전 8). 표를 골라
 * 5문장으로, GEO 를 카드 read 에 합쳐 **4문장**으로 줄인다 — `trend_brands` 의
 * GROUPING SETS 가 브랜드 축과 국가 축을 **한 스캔에서** 내므로 GEO 가 따로 읽을 이유가 없다.
 *
 * 회차가 0개면 문장을 아예 안 낸다(빈 anchor 범위 = `cycleScope` 의 reduce 불가).
 */
// ── 집계층 read 의 폴백 신호(`empty`)를 **밖으로 낸다** (PR③ R3, 2026-09-10) ──
//
// 글로벌 게이트(`viaGlobalS1`·`viaGlobalTrend`)는 리더의 `empty` 를 보고 세부층으로
// 돌린다. 웹사이트 게이트(`viaTrend`)에는 그 분기가 **없었다** — 리더가 `empty` 를
// 안쪽에서 버리고 값만 냈기 때문이다. 그래서 모수가 안 접힌 슬라이스가 화면에 0 으로
// 그려질 수 있었다(T11 기준 6 재검 R3). 두 표면의 게이트가 같은 모양이어야 한다.
//
// 그래서 `viaTrend` 가 `onSummary` 로 부르는 세 리더는 `SummaryTrendRead<T>` 를 낸다.
// 나머지(`…Detail`·`promptTopics`·`citationAccuracy` 등)는 종전대로 값만 낸다 —
// 세부층은 폴백 목적지 자체라 더 갈 곳이 없고, `viaSummary` 경로는 집계층이 아니다.
async function readWebsiteTrend(
  scope: SummaryWebsiteScope,
  only: readonly TrendStatementKey[],
  axes?: TrendAxes,
): Promise<TrendAggregates> {
  const t = trendScopeOf(scope, axes);
  if (t.set.cycles.length === 0) return EMPTY_TREND;
  return readTrendAggregates(t, { only });
}

/** `axis === "brand"` 만이 타일·순위표 행이다 — `country === null` 로 가르면 엔진 행이 섞인다. */
const isBrandAxis = (r: TrendBrandRow) => r.axis === "brand";

// 접힘 프로브는 `lib/summary/read/fold-presence.ts` 로 올라갔다(표면 무관, T11 기준 6
// 수리에서 글로벌도 같은 판정이 필요해졌다). 여기서 재수출하지 않는다 — 호출부는
// server.ts 한 곳뿐이고, 그쪽이 새 모듈을 직접 쓴다.


// ── 대시보드 read 하나 = 카드 ①~⑤ + 도넛 + GEO ──────────────────────────────

/**
 * S4 카드와 GEO 는 **한 read 를 나눠 쓴다**(라운드 3).
 *
 * `trend_brands` 의 GROUPING SETS 는 `((brand_name), (country, brand_name))` 이라
 * 브랜드 축(타일·순위표)과 국가 축(GEO)이 **한 스캔**에서 함께 나온다. 라운드 1은
 * 두 위젯이 각자 리더를 불러 그 표를 두 번 스캔했고, `only` 가 없어 안 쓰는
 * `trend_answers` 까지 각각 발행해 렌더당 12문장이 됐다. 지금은 **3문장**이다.
 *
 * 출처 도넛은 여기 합치지 않는다 — 값은 이 read 의 `domains` 로 충분하지만, 한 캐시
 * 셀에 담으면 페이로드가 커진다(2026-09-10 함대 실측: 카드 664 KB + GEO 288 KB +
 * 출처 405 KB = 1,358 KB, Next Data Cache 셀 상한 2 MB 에 근접). 카드+GEO 952 KB /
 * 출처 405 KB 로 갈라 두면 여유가 남고 문장은 3 + 1 = 4 로 끝난다.
 */
export interface SummaryWebsiteDashboard {
  aggregates: StandardAggregates | null;
  geo: GeoBrandMention[];
}

export async function summaryWebsiteDashboard(
  scope: SummaryWebsiteScope,
): Promise<SummaryTrendRead<SummaryWebsiteDashboard>> {
  const t = await readWebsiteTrend(scope, ["own", "brands", "domains"]);
  if (t.empty) return { empty: true };
  return { empty: false, value: { aggregates: aggregatesFrom(scope, t), geo: geoFrom(t) } };
}

// ── ①~⑤ + 도넛 (StandardAggregates 동형) ─────────────────────────────────────

/**
 * 카드 ①~⑤ + 지역 롤업 + 브랜드 타일 + 인용 도메인 표.
 *
 * 이 함수 자신의 `db.execute` 는 **0** 이고, 리더가 내는 문장은 `only` 로 **3개**다
 * (`own`·`brands`·`domains`). `trend_answers` 는 안 쓴다 — 모수를 `trend_own.monitored`
 * 에서 받기 때문.
 *
 * 값 출처(§3-4):
 *   ① `own.trackedAnswers / own.monitored`      ② 브랜드 타일 합(= `own.compMentions`)
 *   ③ `own.ownPositive / own.ownSignals`         ④ `own.rankSum / own.rankedAnswers`(서수)
 *   ⑤ 분모 `domains(total).citations` · 분자 `domains(total).ownedCitations`
 *      (웹사이트는 굳힌 `unit_owned_citations` 기반 — 리더 `ownedCitationsAgg`)
 *
 * ⚠️ `citations.domains[].citingAnswers` 는 집계층에서 **정확한 distinct 가 아니라
 *    상한**이다(리더 `TrendDomainRow.citingAnswers` 주석: 이 회차 실측 150 vs 130).
 *    접기 키가 `(group_key, domain, matched_base, base_norm_null)` 이라 한 답변이 같은
 *    도메인을 서로 다른 base 로 인용하면 두 번 세어진다. 웹사이트 S4 화면은 이 필드를
 *    읽지 않는다(`getLiveWebsiteDashboard` 는 kpis 만 쓴다). 정확한 수가 필요한 인용
 *    화면(T7)은 §3-4 19 의 2단 조회로 간다.
 *    답변 단위 합계인 `answersWithCitation` 은 **`own.citingAnswers`** 를 쓴다 — own 키는
 *    답변 속성만으로 구성돼 job 을 분할하므로 그룹 간 SUM 이 정확하다.
 */
export async function summaryWebsiteAggregates(
  scope: SummaryWebsiteScope,
): Promise<StandardAggregates | null> {
  return aggregatesFrom(scope, await readWebsiteTrend(scope, ["own", "brands", "domains"]));
}

function aggregatesFrom(
  scope: SummaryWebsiteScope,
  t: TrendAggregates,
): StandardAggregates | null {
  const own = t.own.find((r) => r.axis === "total");
  const totalAnswers = num(own?.monitored);
  // 표가 비어 있으면(생성 전) 미러 경로와 같은 형태로 null — 화면은 "측정 대기".
  if (totalAnswers === 0) return null;

  const regions = t.own
    .filter((r) => r.axis === "country")
    .map((r) => ({
      // 세부층 NULL 차원은 집계층에서 '' 다(fold.ts) — 오늘 리더의 COALESCE(country,'UNKNOWN').
      region: r.bucket ? r.bucket : "UNKNOWN",
      answerCount: r.monitored,
      trackedAnswerCount: r.trackedAnswers,
    }))
    .sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));

  // ② 타일 — 표시명 그룹. 절단이 꺼져 있으므로 `isRest` 행은 없지만, 켜지더라도
  // 분모(총언급)는 보존되도록 rest 를 합계에만 더한다.
  const tileRows = t.brands.filter(isBrandAxis);
  const brands = tileRows
    .filter((r) => !r.isRest && r.brandName !== null)
    .map((r) => ({
      name: r.brandName as string,
      mentionCount: r.mentions,
      answerCount: r.answers,
      isTracked: r.isTracked,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount);
  const totalMentions = tileRows.reduce((s, r) => s + r.mentions, 0);

  const domTotal = t.domains.find((r) => r.axis === "total");
  const domRows = t.domains
    .filter((r) => r.axis === "domain" && !r.isRest && r.domain !== null)
    .sort((a, b) => b.citingAnswers - a.citingAnswers);

  const rankedAnswers = num(own?.rankedAnswers);
  const positiveMentions = num(own?.ownPositive);
  const sampledMentions = num(own?.ownSignals);

  // 측정 기준일 = 회차 anchor(P3). 함대는 회차 집합이라 최대값.
  const cycles = (scope.set ?? snapshotSetOf(scope)).cycles;
  const asOfMs = Math.max(...cycles.map((c) => Date.parse(c.cycleAnchorAt)));

  return {
    rootProjectId: getStandardRootId() ?? "",
    asOf: Number.isFinite(asOfMs) && asOfMs > 0 ? new Date(asOfMs).toISOString() : null,
    totalAnswers,
    totalMentions,
    trackedAnswerCount: num(own?.trackedAnswers),
    brands,
    regions,
    citations: {
      sampledAnswers: totalAnswers,
      answersWithCitation: num(own?.citingAnswers),
      totalCitations: num(domTotal?.citations),
      ownedCitations: num(domTotal?.ownedCitations),
      domains: domRows.map((d) => ({
        host: d.domain as string,
        citingAnswers: d.citingAnswers,
        citationCount: d.citations,
        ownedCitationCount: d.ownedCitations,
        isOurs: d.isOurs,
      })),
    },
    position: {
      avgPosition: rankedAnswers > 0 ? round1(num(own?.rankSum) / rankedAnswers) : null,
      sampledAnswers: rankedAnswers,
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

/**
 * 엔진별 ①~⑤ 분해행 + 프롬프트 수 계열.
 *
 * 집계층 **2문장**(`own` 의 engine 축 + `brands` 의 engine 축) + 세부층 **2문장**
 * (프롬프트 그레인). 라운드 1까지는 세부층 5문장이었고 함대 EXPLAIN 합 703 ms 였다.
 *
 * ── `negativeMentions` 만 브랜드 표에서 오는 이유 ───────────────────────────
 * `summary_trend_own` 에는 `own_positive`·`own_signals` 만 있고 **`own_negative` 가
 * 없다**(0059). 신호 합에서 NE/NG/MX 를 분해할 방법이 없으므로, T4 라운드 3의
 * `axes.engineBrand`(= `trend_brands` 에 `(engine, brand_name)` 그룹핑 셋 추가)로
 * **당사 브랜드 행의 `negative` 를 엔진별로 합한다**. 문장은 늘지 않는다(같은 스캔).
 *
 * ── 프롬프트 수는 왜 세부층인가 ─────────────────────────────────────────────
 * prompt 는 `(engine, country)` 키 그룹을 **가로지르므로** 집계층의
 * `prompts_measured`·`prompts_tracked` 를 그룹 간 SUM 하면 이중 계상이다(§3-4 16).
 * 종전 한 문장(답변 × 당사언급 조인 + prompt 별 `bool_or`)을 **두 문장으로 갈랐다**:
 *   ① 측정 프롬프트 = `count(DISTINCT prompt_id)` — 답변 표만, **조인 없음**
 *   ② 당사 언급 프롬프트 = 당사 brand_id 로 좁힌 언급 표의 distinct prompt
 * `미언급 = ① − ②` 이고 종전 `bool_or` 판정과 동치다. ②는 `summary_brand_mentions`
 * 에 `report_fs` 가 없어 유닛 게이트를 걸려면 job 집합 세미조인이 남는다 —
 * 다만 당사 3사로 먼저 좁혀 종전 ①쪽 조인(함대 314 ms)보다 훨씬 싸다.
 */
export async function summaryWebsiteSubKpis(
  scope: SummaryWebsiteScope,
): Promise<SummaryTrendRead<StandardSubKpis>> {
  await presenceSetColumnAvailable();
  const db = getDb();
  const W = answerWhere(scope);
  const F = factScope(scope);
  const own = ownArray(scope.filters);

  const [t, promptRows, mentionedRows] = await Promise.all([
    readWebsiteTrend(scope, ["own", "brands"], { engineBrand: true }),
    db.execute(sql`
      SELECT count(DISTINCT prompt_id)::int AS prompts FROM summary_answers WHERE ${W}
    `) as unknown as Promise<Array<{ prompts: number }>>,
    db.execute(sql`
      SELECT count(DISTINCT prompt_id)::int AS prompts
      FROM summary_brand_mentions WHERE ${F} AND brand_id = ANY(${own})
    `) as unknown as Promise<Array<{ prompts: number }>>,
  ]);

  // 엔진별 당사 부정 언급 — 브랜드 표 engine 축의 `isTracked` 행 합.
  const negByEngine = new Map<string, number>();
  for (const b of t.brands) {
    if (b.axis !== "engine" || !b.isTracked || b.engine === null) continue;
    negByEngine.set(b.engine, (negByEngine.get(b.engine) ?? 0) + b.negative);
  }

  const rows = t.own
    .filter((r) => r.axis === "engine" && r.bucket !== null)
    .map((r) => {
      const engine = r.bucket as string;
      return {
        engine,
        answers: r.monitored,
        tracked: r.trackedAnswers,
        multi: r.multiAnswers,
        top1: r.top1Answers,
        top3: r.top3Answers,
        avgPosition: r.rankedAnswers > 0 ? round1(r.rankSum / r.rankedAnswers) : null,
        totalMentions: r.compMentions,
        trackedMentions: r.ownMentions,
        sentMentions: r.ownSignals,
        positiveMentions: r.ownPositive,
        negativeMentions: negByEngine.get(engine) ?? 0,
        citTotal: r.allCitations,
        // 웹사이트(`unit_column` 접기)에서 `own_citations = sum(unit_owned_citations)`,
        // `own_fallback_citations = 0` 이다(fold.ts). 둘을 더하는 것은 글로벌과 같은
        // 식을 쓰기 위한 것이고 웹사이트에서는 앞항만 값이 있다.
        citOwned: r.ownCitations + r.ownFallbackCitations,
      };
    });

  if (t.empty) return { empty: true };
  const prompts = num(promptRows[0]?.prompts);
  return {
    empty: false,
    value: {
      rows,
      promptsWithoutBrand: prompts > 0 ? prompts - num(mentionedRows[0]?.prompts) : null,
      measuredPrompts: prompts > 0 ? prompts : null,
    },
  };
}

// ── 퍼널 도넛 ────────────────────────────────────────────────────────────────

export async function summaryWebsitePromptTopics(
  scope: SummaryWebsiteScope,
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

/**
 * 출처 도넛 — 집계층 `domains` 축. `only:["domains"]` 라 문장 **1개**, 이 함수의 `db.execute` 는 0.
 *
 * `isOurs` 는 ⑤ 분자와 **판정이 다르다**(오늘도 그렇다): ⑤ 는 유닛 고유 base
 * (`unit_owned_citations`), 여기는 **도메인 서픽스 정규식**이다 — 도메인 그룹핑에서는
 * 경로 수준 좁히기를 표현할 수 없기 때문(미러 SA:3555-3560 과 같은 규칙). 그래서
 * 리더가 실어 보내는 `isOurs`(= 유닛 판정)를 쓰지 않고, 같은 정규식을 **도메인 문자열에
 * 그대로** 적용한다. 서픽스 앵커(`(^|\.)…$`)는 POSIX `~*` 와 JS `RegExp` 의 의미가 같다.
 */
export async function summaryWebsiteSourceComposition(
  scope: SummaryWebsiteScope,
): Promise<SummaryTrendRead<SourceDomainSlice[]>> {
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(scope.ownedBasePrefixes));
  const re = pattern ? new RegExp(pattern, "i") : null;
  const t = await readWebsiteTrend(scope, ["domains"]);
  // `only:["domains"]` 라 모수 표가 없다 — R1 이후 이 read 의 `empty` 는 사실상 발화하지
  // 않고(접힘 판정은 셀 밖 프로브가 전담), 신호를 그대로 흘려 형태만 맞춘다.
  if (t.empty) return { empty: true };
  const rows = t.domains
    .filter((r) => r.axis === "domain" && !r.isRest && r.domain !== null)
    .sort((a, b) => b.citations - a.citations);
  const total = rows.reduce((s2, r) => s2 + r.citations, 0);
  return {
    empty: false,
    value: rows.map((r) => {
      const domain = r.domain as string;
      return {
        domain,
        citations: r.citations,
        share: total > 0 ? round1((100 * r.citations) / total) : 0,
        isOurs: re ? re.test(domain) : false,
      };
    }),
  };
}

// ── GEO 경쟁 (국가 × 브랜드) ─────────────────────────────────────────────────

/**
 * 집계층 `brands` 의 **country 축**(GROUPING SETS 의 `(country, brand_name)`).
 * 모집단은 리더가 `is_competitor = 1` 로 이미 좁혔다 — 오늘 리더와 같은 게이트다.
 *
 * `country = ''` 는 세부층 NULL 이 접힌 것이라 뺀다(오늘 리더의 `country IS NOT NULL`).
 *
 * ⚠️ 축 판별은 **`axis === "country"`** 로만 한다. `country === null` 로 가르던 라운드 1
 *    판정은 `axes.engineBrand` 를 켜면 깨진다 — 엔진 행도 `country` 가 null 이다.
 *    Sub-KPI 가 그 축을 켜므로 실제로 밟히는 함정이다(T4 라운드 3 계약).
 *
 * S4 렌더에서는 `summaryWebsiteDashboard` 가 카드와 **같은 read** 를 나눠 준다 —
 * 이 함수는 GEO 만 단독으로 필요한 호출부(스크립트·테스트)를 위해 남는다.
 */
export async function summaryWebsiteGeoCompetition(
  scope: SummaryWebsiteScope,
): Promise<GeoBrandMention[]> {
  return geoFrom(await readWebsiteTrend(scope, ["brands"]));
}

function geoFrom(t: TrendAggregates): GeoBrandMention[] {
  return t.brands
    .filter((r) => r.axis === "country" && r.country !== "" && !r.isRest && r.brandName !== null)
    .map((r) => ({
      code: r.country as string,
      brand: r.brandName as string,
      mentions: r.mentions,
      isTracked: r.isTracked,
    }));
}


// ════════════════════════════════════════════════════════════════════════════
// 세부층 사실표 리더 (PR② 이전 경로) — **집계층 거부 축의 폴백 목적지**
// ════════════════════════════════════════════════════════════════════════════
//
// PR② 는 카드·도넛·GEO 를 집계층으로 옮기면서 폴백 목적지도 **미러**로 바꿨다.
// 그런데 같은 화면의 형제 위젯(주제 도넛 `summaryWebsitePromptTopics`·⑥)은 세부층에
// 남아 있어서, 집계층이 거부하는 축(`?depth2=`·admin 브랜드 다중 선택)에서 **한 화면에
// 미러와 사실표가 섞였다** — 회차 창이 다르니 모수·언급이 어긋난다(T11 기준 6).
//
// 그래서 아래 넷을 **PR② 이전 그대로** 되살린다. `planTrendRead` 거부·접힘 미실행·
// 리더 `empty` 는 이쪽으로 가고, 미러는 게이트(회차·화면 allowlist·`cumulative`)가
// summary 경로 자체를 거부할 때만 쓴다(`server.ts::viaTrend`).
//
// 이 넷은 집계층 판정(`trendScopeOf`)을 **거치지 않는다** — 거부된 축이 들어오는 것이
// 존재 이유이기 때문이다.

export async function summaryWebsiteAggregatesDetail(
  scope: SummaryWebsiteScope,
  budget?: AnswerSetBudget,
): Promise<StandardAggregates | null> {
  await presenceSetColumnAvailable();
  const db = budgetedMirrorDb(getDb(), budget);
  const W = answerWhere(scope);
  const F = detailFactScope(scope);
  const own = ownArray(scope.filters);
  const ownedSum = ownedCitationsSum(scope);
  const ownedAgg = ownedDomainAgg(scope);

  // ① 분모 + 지역(=웹사이트 국가) 롤업 — 답변 표 단독.
  const ansRows = (await db.execute(sql`
    SELECT COALESCE(country, 'UNKNOWN') AS region,
      COALESCE(sum(monitored), 0)::int AS answers
    FROM summary_answers WHERE ${W}
    GROUP BY 1 ORDER BY 1
  `)) as unknown as Array<{ region: string; answers: number }>;

  // ① 분자(국가별) + ③ 우호도(총계) — **한 문장·조인 없음**(T10/E4, 글로벌 열과 같은 자세).
  // ① 분자는 답변 표가 아니라 브랜드 표의 job 단위 재집계다(설계 B3: 당사 분자는
  // 굳히지 않는다). ③ 은 같은 행 집합(`F ∧ $own`)의 총합이라 GROUPING SETS 의 총계 행에서
  // 같은 스캔으로 나온다 — 문장 수는 종전과 같다.
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

  // ③ 우호도 — 언급 단위 신호 합(비경쟁 게이트 없음: 당사 행만 본다).
  // 값은 위 `ownRows` 의 총계 행에서 온다 — 같은 술어·같은 스캔(문장 하나 절약).
  const positiveMentions = num(ownTotal?.p);
  const sampledMentions =
    positiveMentions + num(ownTotal?.ne) + num(ownTotal?.ng) + num(ownTotal?.mx);

  // ④ 우선노출도 — 답변별 자사 브랜드 내 순위의 평균(순위 미진입 답변 제외).
  // 미러 경로 ownBrandRankPerJobSql 과 같은 단위(2026-09-06).
  const posRows = (await db.execute(sql`
    SELECT round(avg(tp)::numeric, 1) AS avg_position, count(*)::int AS sampled
    FROM (${ownBrandRankByJobSql(F, own)}) t
  `)) as unknown as Array<{ avg_position: string | null; sampled: number }>;

  // ⑤ 인용 — 분모는 domain NULL 행 포함.
  const citAgg = (await db.execute(sql`
    SELECT COALESCE(sum(citations), 0)::int AS total,
      ${ownedSum} AS owned,
      count(DISTINCT job_id) FILTER (WHERE citations > 0)::int AS with_cit
    FROM summary_domain_citations WHERE ${F}
  `)) as unknown as Array<{ total: number; owned: number; with_cit: number }>;

  const domRows = (await db.execute(sql`
    SELECT domain AS host,
      count(DISTINCT job_id)::int AS citing_answers,
      COALESCE(sum(citations), 0)::int AS citations,
      ${ownedSum} AS owned_citations,
      ${ownedAgg} AS is_ours
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

  // 측정 기준일 = 회차 anchor(P3). 미러 경로의 `COALESCE(r.cycle_anchor_at, a.measured_at)`
  // 와 같은 값을 원장에서 직접 읽는다 — 함대는 회차 집합이라 최대값.
  const asOfMs = Math.max(...scope.cycles.map((c) => Date.parse(c.cycleAnchorAt)));

  return {
    rootProjectId: getStandardRootId() ?? "",
    asOf: Number.isFinite(asOfMs) && asOfMs > 0 ? new Date(asOfMs).toISOString() : null,
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


export async function summaryWebsiteSubKpisDetail(
  scope: SummaryWebsiteScope,
  budget?: AnswerSetBudget,
): Promise<StandardSubKpis> {
  await presenceSetColumnAvailable();
  const db = budgetedMirrorDb(getDb(), budget);
  const W = answerWhere(scope);
  const F = detailFactScope(scope);
  const own = ownArray(scope.filters);
  const ownedSum = ownedCitationsSum(scope);

  // 당사 언급의 job 단위 재집계 — 분자 계열과 #9(미언급 프롬프트)가 공유한다.
  // tp = 브랜드 내 순위(④ 카드와 동일 단위).
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

  // 분자(엔진별 당사 계열) — 브랜드 표 단독, **답변 표와의 조인 없음**(T10/E4).
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
      ${ownedSum} AS owned
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

// ── 출처 도넛 ────────────────────────────────────────────────────────────────
// isOurs 는 도메인 단위 판정(경로 수준 좁히기는 도메인 그룹핑으로 표현 불가) —
// 미러 경로(SA:3555-3560)와 같은 서픽스 정규식을 쓴다.

export async function summaryWebsiteSourceCompositionDetail(
  scope: SummaryWebsiteScope,
  budget?: AnswerSetBudget,
): Promise<SourceDomainSlice[]> {
  await presenceSetColumnAvailable();
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(scope.ownedBasePrefixes));
  const isOurs = pattern ? sql`bool_or(domain ~* ${pattern})` : sql`false`;
  const rows = (await budgetedMirrorDb(getDb(), budget).execute(sql`
    SELECT domain AS domain, COALESCE(sum(citations), 0)::int AS citations,
      ${isOurs} AS is_ours
    FROM summary_domain_citations
    WHERE ${detailFactScope(scope)} AND domain IS NOT NULL
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

export async function summaryWebsiteGeoCompetitionDetail(
  scope: SummaryWebsiteScope,
  budget?: AnswerSetBudget,
): Promise<GeoBrandMention[]> {
  await presenceSetColumnAvailable();
  const own = ownArray(scope.filters);
  const rows = (await budgetedMirrorDb(getDb(), budget).execute(sql`
    SELECT country AS code, brand_name AS brand,
      COALESCE(sum(mentions), 0)::int AS mentions,
      bool_or(brand_id = ANY(${own})) AS is_tracked
    FROM summary_brand_mentions
    WHERE ${detailFactScope(scope)} AND is_competitor = 1 AND country IS NOT NULL
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


// ── ⑥ 타겟 URL 인용률 ───────────────────────────────────────────────────────
// 분모는 monitored 가 아니라 **자사 인용 답변**이다(SA:4641-4653 재현).
// `$tk` = 선택 프로젝트 × lang × country 의 'project_id|lang|country' 집합 —
// 오늘 websiteTargetSetSelect 가 타겟 셋을 화면 축으로 좁히는 것과 같은 좁히기다.

async function websiteTargetKeys(scope: SummaryWebsiteScope): Promise<string[]> {
  const f = scope.filters;
  const conds: SQL[] = [
    sql`ws.scope_project_id::text = ANY(${textArray(scope.projectIds)})`,
    sql`coalesce(wp.target_url, '') <> ''`,
  ];
  if (f.lang?.length)
    conds.push(sql`wp.lang_code = ANY(${textArray(f.lang.map((v) => v.toLowerCase()))})`);
  if (f.websiteCountry?.length) conds.push(websiteSiteGeoPred(f.websiteCountry));
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT ws.scope_project_id::text || '|' || wp.lang_code || '|' || ws.country_code AS k
    FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ${sql.join(conds, sql` AND `)}
  `)) as unknown as Array<{ k: string | null }>;
  return rows.map((r) => r.k).filter((k): k is string => !!k);
}

export async function summaryWebsiteCitationAccuracy(
  scope: SummaryWebsiteScope,
): Promise<CitationAccuracyResult> {
  await presenceSetColumnAvailable();
  // 유닛 플래그가 있으면 답변 표의 굳힌 플래그만 더한다 — `summary_target_hits` 를
  // 쓰지 않는다. 분모("자사 인용 답변" 요약 카드) = SUM(unit_owned),
  // 분자 = SUM(unit_owned AND unit_target). 보고서 v2.4 와 같은 유닛 base·타겟 판정이다.
  // `::int = 1` 로 비교하는 이유: 플래그 컬럼이 int 든 boolean 이든 같은 SQL 이 돈다.
  if (scope.unitFlags) {
    const rows = (await getDb().execute(sql`
      SELECT COALESCE(sum((unit_owned::int = 1)::int), 0)::int AS owned_answers,
             COALESCE(sum((unit_owned::int = 1 AND unit_target::int = 1)::int), 0)::int AS target_answers
      FROM summary_answers WHERE ${answerWhere(scope)}
    `)) as unknown as Array<{ owned_answers: number; target_answers: number }>;
    const o = num(rows[0]?.owned_answers);
    const t = num(rows[0]?.target_answers);
    return { ownedAnswers: o, targetAnswers: t, rate: o > 0 ? round1((100 * t) / o) : null };
  }
  const keys = await websiteTargetKeys(scope);
  const sel = selectedBases(scope.ownedBasePrefixes);
  const ownedExpr = sel.length
    ? sql`(matched_base_tracked <> '' AND matched_base_tracked = ANY(${textArray(sel)}))`
    : sql`false`;
  const targetExpr = keys.length
    ? sql`(target_keys && ${textArray(keys)})`
    : sql`false`;
  const rows = (await getDb().execute(sql`
    WITH t AS (
      SELECT job_id, bool_or(${ownedExpr}) AS owned, bool_or(${targetExpr}) AS target
      FROM summary_target_hits WHERE ${factScope(scope)}
      GROUP BY job_id
    )
    SELECT count(*) FILTER (WHERE owned)::int AS owned_answers,
           count(*) FILTER (WHERE owned AND target)::int AS target_answers
    FROM t
  `)) as unknown as Array<{ owned_answers: number; target_answers: number }>;
  const owned = num(rows[0]?.owned_answers);
  const target = num(rows[0]?.target_answers);
  // 분모 0 → rate null (미러 경로와 같은 형태: "측정 대기" ≠ 0%).
  return {
    ownedAnswers: owned,
    targetAnswers: target,
    rate: owned > 0 ? round1((100 * target) / owned) : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 회차 버킷 추이 2종 — S4 대시보드 (PR③)
// ════════════════════════════════════════════════════════════════════════════
//
// ── x축이 바뀐다: 측정일 주 버킷 → **회차 버킷** ────────────────────────────
//
// 미러 추이(`aggregateStandardTrendFromMirror`)는 `date_trunc('week', measured_at)`
// 로 접는다. 여기는 **회차**로 접고, 웹사이트 함대 회차의 키는 `cycle_week` 다.
//   · 회차가 없는 주는 **점이 없다**(미러는 주 격자를 채웠다 — 호출부 `fillGaps`).
//   · 한 프로젝트가 한 주에 회차를 둘 가지면 점이 갈리는 것이 아니라 **게이트가 폴백한다**
//     (`cycle-set.ts::judgeCycleRange` 의 `duplicate-cycle-in-week`) — 그 창은 점 0 이다.
//   · Δ 칩(`applyTrendDeltas`)이 "마지막 두 점" 이므로 자동으로 **직전 회차 대비**가 된다.
// PR② T5 가 미뤄 뒀던 D-4(1)이 이것이고, 여기서 해제한다.
//
// ── ⚠️ 버킷 키는 `cycle_anchor_at` 이 아니라 **`cycle_week`** 다 ────────────
//
// 집계층 `own` 의 회차 축은 `cycle_anchor_at`(timestamptz)으로 그룹핑한다. 그것을 그대로
// x 로 쓰면 **함대 한 회차가 여러 점으로 갈린다** — 웹사이트 회차는 프로젝트마다 자기
// anchor 를 갖고(`generate/cycle.ts` 의 `groupBy = website ? "cycle_week" : "cycle_anchor_at"`),
// 그 값이 정규화돼 있다는 보장이 없다. 2026-09-10 실측: published 8/31주 95회차는 운영자
// 정규화로 전부 `2026-09-04T00:00Z` 였지만, **open 9/07주 66회차는 프로젝트별 run
// 타임스탬프 66개가 전부 distinct**(03:10~04:00Z)다. UTC 자정을 걸치기라도 하면 한 회차가
// **함대 부분집합 두 점**으로 갈리고(예: p1 23:30Z · p2 00:30Z → 점 2개, 각각 절반 모수),
// 회차 수 하한(`server.ts::TREND_MIN_CYCLES`)까지 통과해 버린다.
// 함대 회차의 유일성 정본이 `(project_id, cycle_week)`(위 `judgeCycleRange`)이므로
// **집계 키도 `cycle_week`** 여야 한다. `CycleSet.anchorCount` 주석도 같은 말을 한다
// ("정확한 주 수는 `weeks.length`").
//
// ── 그러면 x 라벨은? **그 주 함대 앵커의 대표일** ───────────────────────────
//
// 주 월요일(`cycle_week` 그대로)을 쓰면 고객이 보던 "측정일" 과 어긋난다(8/31주의 측정은
// 9/04 에 일어났다). 그래서 버킷 키는 주이되, 표시일(`bucketStart`)은 **그 주 함대의
// `min(cycle_anchor_at)` 의 UTC 일**로 둔다 — 8/31주 → `2026-09-04`, 9/07주 → `2026-09-10`.
// 대표일은 리더가 돌려준 행이 아니라 **회차 집합에서** 뽑는다: ①(집계층)과 ⑥(세부층)이
// 서로 다른 표를 읽으므로, 각자 자기 행에서 뽑으면 같은 주의 키가 갈릴 수 있다.
//
// ── 문장 ① 추이 = `own` **1문장** ──────────────────────────────────────────
//
// `axes.cycle` 이 `summary_trend_own` 에 `(cycle_anchor_at)` 그룹핑 셋을 세운다 —
// 회차가 N개여도 문장은 1개다(회차마다 발행하면 N×4). 미러 경로는 답변셋 TEMP 투영 +
// 5문장(답변·언급·감정·순위·인용)이었고 라이브 실측 **27.8~28.6 s** 였다.
//
// 값 출처(§3-4, 카드와 같은 컬럼):
//   ① `monitored` / `trackedAnswers`      ② `compMentions` / `tileOwnMentions`
//   ③ `ownSignals` / `ownPositive`         ④ `rankSum` / `rankedAnswers`(서수)
//   ⑤ `allCitations` / `ownCitations`
//
// ⚠️ ⑤ 분자를 **`own.ownCitations`** 에서 받는 것이 웹사이트에서 정당한 이유:
//    접기(`fold.ts` (E) `ownCitationsFrom`)가 웹사이트 표면에서는 `unit_column` —
//    즉 `sum(summary_domain_citations.unit_owned_citations)` 를 그대로 굳힌다. 카드
//    경로(`ownedCitationsAgg`)가 도메인 표에서 더하는 **바로 그 값**이고, 스코프 판정이
//    끼지 않아 국가·언어 필터와도 무관하다. 글로벌 표면이라면 이 컬럼을 쓰면 안 된다
//    (`own_citations` 가 (변형, country, lang) 한 행으로 확정돼 갈린다 — T4 머리 주석).
//    도메인 표에는 회차 축이 없으므로(`axes.cycle` 은 own·answers 만) 이 등가성이
//    "문장 1개" 를 가능하게 한다. 등가는 라이브 패리티가 확인한다
//    (`scripts/summary/parity-website-trend.ts`).
//
// ── 없는 것: `measuredDays`·`firstAt`·`lastAt` ─────────────────────────────
//
// 집계층에도 `summary_answers` 에도 `measured_at` 이 없다(그 컬럼은 `summary_cycle_jobs`
// 에만 있다). 회차 버킷에서 그 셋의 의미는 **회차 앵커**로 수렴하므로 집합에서 뽑아 넣는다:
// `firstAt` = 그 주 함대의 min anchor, `lastAt` = max anchor, `measuredDays = 1`(= 회차 1개).
// 화면 영향은 x축 라벨뿐이다 — `trendBucketLabel` 이 주 단위에서 `firstAt` 을 쓰는데,
// 그 값이 이제 "그 주 첫 측정일" 이 아니라 **회차 대표일**이다(인용·표준 분석 화면이
// 2026-09-05 에 옮겨 간 `cycle_anchor_at` 기준과 같은 축). `measuredDays` 는 차트가
// 읽기만 하고 그리지 않는다(2026-09-10 실측: `live-trend-chart.tsx` 에서 Row 에만 실린다).

/**
 * 회차 축 — `own` 에 `(cycle_anchor_at)` 를 세운다. 문장 수는 늘지 않는다.
 * 리더가 내주는 축은 anchor 뿐이라 **주로 접는 것은 이 파일의 몫**이다(머리 주석 ⚠️).
 */
export const WEBSITE_TREND_AXES: TrendAxes = { cycle: true };
/** 추이는 `own` 한 표만 읽는다 — 브랜드·도메인·답변 표에는 회차 축이 없다. */
export const WEBSITE_TREND_STATEMENTS: readonly TrendStatementKey[] = ["own"];

export async function summaryWebsiteTrend(
  scope: SummaryWebsiteScope,
): Promise<StandardTrendBucket[]> {
  await presenceSetColumnAvailable();
  const t = await readWebsiteTrend(scope, WEBSITE_TREND_STATEMENTS, WEBSITE_TREND_AXES);
  return websiteTrendBucketsFrom(t, scope.set ?? snapshotSetOf(scope));
}

// ── 회차 주 색인 — ①·⑥ 이 **같은 버킷 키**를 쓰게 하는 유일한 정본 ──────────
//
// 두 추이는 서로 다른 표를 읽는다(① 집계층 `own` / ⑥ 세부층). 각자 자기 행에서 대표일을
// 뽑으면, 어느 한쪽에만 행이 있는 회차에서 같은 주의 `bucketStart` 가 갈려 ⑥ 병합이
// 조용히 실패한다. 그래서 키·대표일은 **회차 집합에서만** 파생한다.

interface CycleWeekRepr {
  /** 그 주 함대의 min anchor(ISO) — 대표 앵커. */
  anchorMin: string;
  /** 그 주 함대의 max anchor(ISO). 자정을 걸치면 `anchorMin` 과 날짜가 다를 수 있다. */
  anchorMax: string;
  /** x 표시일 = `anchorMin` 의 UTC 일. */
  day: string;
}

interface CycleWeekIndex {
  /** `cycle_week` → 대표. */
  repr: Map<string, CycleWeekRepr>;
  /** `cycle_id` → `cycle_week` (⑥ 세부층 행이 쓰는 키). */
  weekOfCycle: Map<string, string>;
  /** anchor ISO → `cycle_week` (① 집계층 행이 쓰는 키). */
  weekOfAnchor: Map<string, string>;
}

/** anchor → 그 주 UTC 월요일. 집합에 없는 anchor 가 들어왔을 때의 폴백(정상 경로 아님). */
function utcMondayOf(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function cycleWeekIndexOf(set: CycleSet): CycleWeekIndex {
  const repr = new Map<string, CycleWeekRepr>();
  const weekOfCycle = new Map<string, string>();
  const weekOfAnchor = new Map<string, string>();
  for (const c of set.cycles) {
    const anchor = new Date(c.cycleAnchorAt).toISOString();
    const week = String(c.cycleWeek).slice(0, 10);
    weekOfCycle.set(c.cycleId, week);
    weekOfAnchor.set(anchor, week);
    const cur = repr.get(week);
    if (!cur) repr.set(week, { anchorMin: anchor, anchorMax: anchor, day: anchor.slice(0, 10) });
    else {
      if (anchor < cur.anchorMin) { cur.anchorMin = anchor; cur.day = anchor.slice(0, 10); }
      if (anchor > cur.anchorMax) cur.anchorMax = anchor;
    }
  }
  return { repr, weekOfCycle, weekOfAnchor };
}

/** 집합에 없는 주(폴백 경로)의 대표 — 표시일은 주 월요일밖에 알 수 없다. */
const reprOf = (idx: CycleWeekIndex, week: string): CycleWeekRepr =>
  idx.repr.get(week) ?? { anchorMin: `${week}T00:00:00.000Z`, anchorMax: `${week}T00:00:00.000Z`, day: week };

/**
 * `own` 의 회차 축 행 → 화면 버킷. **`cycle_week` 로 접는다**(머리 주석 ⚠️).
 *
 * 리더의 그룹핑 축은 `cycle_anchor_at` 이라 함대 한 회차가 프로젝트별 anchor 만큼 행으로
 * 갈려 나온다(2026-09-10 실측: open 9/07주 66회차 = distinct anchor 66개). 그것을 주로 접지
 * 않으면 한 회차가 여러 점이 되고, 자정을 걸치면 **각 점이 함대 부분집합**이 된다.
 * 주 → 대표 앵커·표시일 매핑은 `set` 에서만 파생한다 — ⑥ 과 같은 키를 쓰기 위해서다.
 *
 * ⚠️ `TrendOwnRow.cycleAnchorAt` 은 타입상 `string` 이지만 postgres-js 는 timestamptz 를
 *    `Date` 로 돌려준다(이 축의 **첫 소비자**라 여태 드러날 자리가 없었다). `new Date(...)`
 *    로 통과시켜 둘 다 받는다 — 문자열이든 Date 든 같은 ISO 로 수렴한다.
 */
export function websiteTrendBucketsFrom(
  t: TrendAggregates,
  set: CycleSet,
): StandardTrendBucket[] {
  const idx = cycleWeekIndexOf(set);
  type Acc = {
    monitored: number; trackedAnswers: number;
    compMentions: number; tileOwnMentions: number;
    ownSignals: number; ownPositive: number;
    rankSum: number; rankedAnswers: number;
    allCitations: number; ownCitations: number;
  };
  const byWeek = new Map<string, Acc>();
  for (const r of t.own) {
    if (r.axis !== "cycle" || !r.cycleAnchorAt || r.keyRows === 0) continue;
    const anchor = new Date(r.cycleAnchorAt).toISOString();
    const week = idx.weekOfAnchor.get(anchor) ?? utcMondayOf(anchor);
    const a = byWeek.get(week) ?? {
      monitored: 0, trackedAnswers: 0, compMentions: 0, tileOwnMentions: 0,
      ownSignals: 0, ownPositive: 0, rankSum: 0, rankedAnswers: 0,
      allCitations: 0, ownCitations: 0,
    };
    a.monitored += r.monitored;
    a.trackedAnswers += r.trackedAnswers;
    a.compMentions += r.compMentions;
    a.tileOwnMentions += r.tileOwnMentions;
    a.ownSignals += r.ownSignals;
    a.ownPositive += r.ownPositive;
    a.rankSum += r.rankSum;
    a.rankedAnswers += r.rankedAnswers;
    a.allCitations += r.allCitations;
    a.ownCitations += r.ownCitations;
    byWeek.set(week, a);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, a]) => {
      const rep = reprOf(idx, week);
      return {
        bucketStart: rep.day,
        cycleAnchorAt: rep.anchorMin,
        answers: a.monitored,
        trackedAnswers: a.trackedAnswers,
        totalMentions: a.compMentions,
        trackedMentions: a.tileOwnMentions,
        sentMentions: a.ownSignals,
        positiveMentions: a.ownPositive,
        avgPosition: a.rankedAnswers > 0 ? round1(a.rankSum / a.rankedAnswers) : null,
        totalCitations: a.allCitations,
        ownedCitations: a.ownCitations,
        measuredDays: 1,
        firstAt: rep.anchorMin,
        lastAt: rep.anchorMax,
      };
    });
}

/**
 * ⑥ 타겟 인용률 추이 — **집계층 밖**이다(플랜 §3-4 7 · E3).
 *
 * 집계층 4표에는 타겟 판정이 없다. 그래서 이 하나만 **세부층**을 읽되, 회차 술어를
 * 그대로 얹고 `cycle_id` 로 그룹핑해 **1문장**으로 시계열을 낸다.
 *
 * ⚠️ 플랜은 `summary_target_hits` 전용이라고 적지만, **오늘의 카드(⑥)는 유닛 플래그가
 *    있을 때 `summary_answers` 의 굳힌 플래그를 쓴다**(`summaryWebsiteCitationAccuracy`
 *    첫 분기, 라이브 `unitFlags = true`). 추이가 카드와 다른 원천을 쓰면 같은 화면의
 *    마지막 점과 카드가 갈리므로, 여기서는 **카드와 같은 분기**를 그대로 따른다 —
 *    유닛 경로면 `summary_answers`(job 조인 없음), 아니면 `summary_target_hits`
 *    (카드와 같은 `factScope`). 판정 규칙을 한 곳에서 바꾸면 둘이 함께 움직인다.
 *
 * 버킷 키는 `cycle_id` → **`cycle_week`**(집합에서 푼다). 세부층에도 `cycle_week` 는 있지만
 * `cycle_anchor_at` 이 없어 대표일을 SQL 로 만들 수 없고, 회차 집합은 이미 손에 있으므로
 * 조인을 만들지 않는다. ① 과 **같은 색인**(`cycleWeekIndexOf`)을 쓰므로 `bucketStart` 가
 * 반드시 일치한다 — 호출부의 병합(`rateByBucket`)이 그 일치에 걸려 있다.
 *
 * ⚠️ **소요는 회차 수에 선형이다.** 2026-09-10 재실측(1회차·함대 95, EXPLAIN Execution):
 *    유닛 경로 **38~94 ms** · `summary_target_hits` 경로 **176 ms**. 13회차면 각각
 *    **0.5~1.2 s · ~2.3 s** 로 외삽된다 — 창을 13주보다 넓히려면 이 선형성을 먼저 깨야 한다
 *    (① 집계층은 회차 축이 한 스캔이라 같은 문제가 없다: 1.2~15 ms).
 */
export async function summaryWebsiteCitationAccuracyTrend(
  scope: SummaryWebsiteScope,
): Promise<CitationAccuracyTrendBucket[]> {
  await presenceSetColumnAvailable();
  const set = scope.set ?? snapshotSetOf(scope);
  if (set.cycles.length === 0) return [];
  const rows = scope.unitFlags
    ? ((await getDb().execute(sql`
        SELECT cycle_id::text AS cycle_id,
               COALESCE(sum((unit_owned::int = 1)::int), 0)::int AS owned_answers,
               COALESCE(sum((unit_owned::int = 1 AND unit_target::int = 1)::int), 0)::int AS target_answers
        FROM summary_answers WHERE ${answerWhere(scope)}
        GROUP BY cycle_id
      `)) as unknown as CycleAccuracyRow[])
    : await websiteAccuracyTrendFromTargetHits(scope);
  return foldAccuracyByWeek(rows, set);
}

type CycleAccuracyRow = {
  cycle_id: string;
  owned_answers: number;
  target_answers: number;
};

async function websiteAccuracyTrendFromTargetHits(
  scope: SummaryWebsiteScope,
): Promise<CycleAccuracyRow[]> {
  const keys = await websiteTargetKeys(scope);
  const sel = selectedBases(scope.ownedBasePrefixes);
  const ownedExpr = sel.length
    ? sql`(matched_base_tracked <> '' AND matched_base_tracked = ANY(${textArray(sel)}))`
    : sql`false`;
  const targetExpr = keys.length ? sql`(target_keys && ${textArray(keys)})` : sql`false`;
  return (await getDb().execute(sql`
    WITH t AS (
      SELECT cycle_id, job_id,
             bool_or(${ownedExpr}) AS owned, bool_or(${targetExpr}) AS target
      FROM summary_target_hits WHERE ${factScope(scope)}
      GROUP BY cycle_id, job_id
    )
    SELECT cycle_id::text AS cycle_id,
           count(*) FILTER (WHERE owned)::int AS owned_answers,
           count(*) FILTER (WHERE owned AND target)::int AS target_answers
    FROM t GROUP BY cycle_id
  `)) as unknown as CycleAccuracyRow[];
}

/**
 * `cycle_id` 행 → **`cycle_week` 버킷**. ① 과 같은 색인을 쓰므로 `bucketStart` 가 반드시 같다.
 * 분모 0 → rate null(미러와 같은 형태: "측정 대기" ≠ 0%).
 */
function foldAccuracyByWeek(
  rows: CycleAccuracyRow[],
  set: CycleSet,
): CitationAccuracyTrendBucket[] {
  const idx = cycleWeekIndexOf(set);
  const byWeek = new Map<string, { owned: number; target: number }>();
  for (const r of rows) {
    const week = idx.weekOfCycle.get(r.cycle_id);
    // 집합 밖 회차는 술어가 이미 걸렀다 — 여기 오면 배선이 끊긴 것이라 조용히 버린다.
    if (!week) continue;
    const a = byWeek.get(week) ?? { owned: 0, target: 0 };
    a.owned += num(r.owned_answers);
    a.target += num(r.target_answers);
    byWeek.set(week, a);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, a]) => {
      const rep = reprOf(idx, week);
      return {
        bucketStart: rep.day,
        ownedAnswers: a.owned,
        targetAnswers: a.target,
        rate: a.owned > 0 ? round1((100 * a.target) / a.owned) : null,
        measuredDays: 1,
        firstAt: rep.anchorMin,
        lastAt: rep.anchorMax,
      };
    });
}

// 테스트가 컴파일된 SQL 형태를 고정할 수 있게 술어 빌더를 노출한다(런타임 호출부는 이 파일 내부뿐).
export const __testables = {
  answerWhere,
  factScope,
  detailFactScope,
  sharedWhere,
  unitWhere,
  ownedCitationExpr,
  ownedCitationsSum,
  ownedDomainAgg,
  cycleScope,
};

// ════════════════════════════════════════════════════════════════════════════
// 집계층 경로 — S6 인용 화면 (PR② T7)
// ════════════════════════════════════════════════════════════════════════════
//
// 조립은 표면 공통 리더(`summary-citation-read.ts`)가 한다. 글로벌 열과 갈리는 것은
// **세부층 술어 하나**다:
//
//   글로벌 = `answerWhere` 를 `summary_domain_citations` 에 **그대로** 건다(두 표가
//            같은 축 컬럼을 갖고 있다 — 라이브 대조 불일치 0).
//   웹사이트 = **`factScope`(job 세미조인)** 를 쓴다. 모수 게이트가 `report_fs` 인데
//            그 컬럼이 `summary_answers` 에만 있고(0060) 인용 표에는 없기 때문이다.
//            직접 술어로 바꾸려면 `(project_id, country, lang)` → `report_fs` 함수
//            종속(플랜 §9 T15)을 세부층에 굳혀야 한다 — 이 라운드의 범위가 아니다.
//            2단 조회는 `group_key = ANY($top)` 로 행을 먼저 좁히므로 세미조인이
//            남아도 오늘의 전량 스캔과 비용이 다르다(explain-s6 참조).
//
// ⚠️ 롤업만 낸다 — 드릴다운·주 단위 추이는 사실표 밖(PR③). `summary-citation-read.ts`
//    머리 주석이 정본이고, 호출부가 소비자 단위로 게이트한다.

/** S6 절단 — 카테고리 축은 자르지 않는다(글로벌 열과 같은 이유). */
const WEBSITE_CITATION_LIMITS: TrendLimits = { ...WEBSITE_TREND_LIMITS, group: null };

export async function summaryWebsiteCitationsFromTrend(
  scope: SummaryWebsiteScope,
): Promise<CitationTrendRead> {
  await presenceSetColumnAvailable();
  const t = trendScopeOf(scope);
  if (t.set.cycles.length === 0) return { empty: true };
  return summaryCitationsFromTrend({
    trend: { ...t, limits: WEBSITE_CITATION_LIMITS },
    detailWhere: factScope(scope),
    answerWhere: answerWhere(scope),
  });
}
