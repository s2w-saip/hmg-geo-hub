import "server-only";
// 예산 상수는 `@/lib/scope/kpi-tab-budget` 이 정본이다. 반대 방향은 **타입 전용**
// import 라(`SubKpiPart`) 런타임 순환이 생기지 않는다.
import { mirrorHeavyBudget } from "@/lib/scope/kpi-tab-budget";
import { RANK_TABLE_TOP_BRANDS, rankFirstPositionRows } from "@/lib/kpi/first-position-rank";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { stableKey } from "@/lib/request-dedupe";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";
import { targetMatchSql } from "@/lib/scope/url-match-sql";
import {
  websiteOwnedUnitCte, websiteUnitOwnedClause, websiteUnitOwnedTargetClause,
  type WebsiteOwnedUnit,
} from "@/lib/scope/website-owned-unit";
import { websiteOwnedUnitKnownEnabled, ensureWebsiteOwnedUnit } from "@/lib/scope/website-owned-unit-state";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { TrendGridSlotView } from "@/lib/period/trend-grid-axis";
import { summaryLedgerAvailable } from "@/lib/db/repositories/summary-settings";
// 노출 지연은 **코어 표면 상수** 한 벌만 쓴다 — `lib/summary/generate/types.ts` 가 정의,
// `swap.ts`(쓰기 V-1)는 재수출. `swap.ts` 를 직접 import 하면 런타임 순환이 된다.
import { VIEW_ANCHOR_DELAY } from "@/lib/summary/generate/types";
import {
  columnKnownAvailable as sharedColumnKnownAvailable,
  citationNormColumnsAvailable,
  ensureColumnAvailability,
  hiddenCycleColumnsAvailable,
  hiddenCycleScopeAvailable,
  mentionOccurrencesAvailable,
  answerStancesAvailable,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import {
  scopeAnswers,
  scopeMentions,
  scopeCitations,
  scopePrompts,
  scopeMentionOccurrences,
  scopeAnswerStances,
  prompts,
  type ScopeMentionOccurrenceRow,
  type ScopeAnswerStanceRow,
} from "@/lib/db/schema";
import { buildSentimentSpans, type OccurrenceInput, type SentimentSpan } from "@/lib/answer-sentiment/spans";
import {
  verifyStanceEvidence,
  type StanceEvidenceMatch,
} from "@/lib/answer-sentiment/stance-evidence";
import {
  getStandardRootId,
  aggregateMentionsFrom,
  aggregateBrandCitationsFrom,
  buildWeeklyTrend,
  buildMentionTrend,
  weeklyTopNUnion,
  providerLabel,
  engineCategorySlices,
  type StandardFilters,
  type StandardAggregates,
  type MentionsLive,
  type MentionsBrandLive,
  type CitationsLive,
  type CitationsPromptSplit,
  type CitationDomainLive,
  type CitationPromptLive,
  type CitationCategorySlice,
  type MentionAnswerLive,
  type MentionsPromptLive,
  type PromptMap,
  type AnchoredJob,
} from "@/lib/scope/result-adapter";
import {
  categorizeDomain,
  resolveCitationCategory,
  type CitationOverrideMap,
} from "@/lib/citation-categorizer";
import { OFFICIAL_HMG_CATEGORY } from "@/lib/citation-categorizer/taxonomy";
import { citationGroupKeySql } from "./citation-group-key";
import {
  anchorCellSnapshotKeys,
  cellSnapshotKeys,
  type CellAliasPrefix,
  type CellSnapshotKeys,
} from "@/lib/period/cell-snapshot";
import { isCumulativePeriod } from "@/lib/period/period-mode";
import {
  anchorRoundAxis,
  answerMeasuredAxis,
  periodBounds,
  periodBoundsClause,
  periodBoundsPredicate,
  runAnchorAxis,
  runStartedAxis,
} from "@/lib/period/period-bounds";
import {
  ANCHOR_ALIAS,
  ANCHOR_LATEST_ALIAS,
  ANCHOR_TABLE,
  anchorDefaultEngineScope,
  anchorJobIdIn,
  anchorJoinSql,
  anchorLatestRoundClause,
  anchorMeasuredOrigSql,
  anchorRunIdIn,
  anchorRoundDateSql,
  anchorViewAnchorDateSql,
  anchorWeekSql,
  anchorDefaultEngineSql,
} from "@/lib/period/anchor-axis";
import {
  anchorAxisKnownEnabled,
  anchorLedgerServableKnownSql,
  anchorNotHiddenKnownSql,
  ensureAnchorAxis,
} from "@/lib/period/anchor-axis-state";
import {
  ensureTrendGrid,
  preCatalogCycleIdsKnown,
  trendGridKnownEnabled,
} from "@/lib/period/trend-grid-flag";
import {
  anchorNotHiddenSql,
  anchorViewableSql,
  type AnchorHiddenFamily,
} from "./scope-answer-anchors";
import {
  periodBucketSql,
  sessionTzBucketSql,
  type SessionTzBucketUnit,
} from "@/lib/period/sql-day";
import { addressableRootProjectId, rootRunScopeSql } from "@/lib/surface/run-surface";
import { loadCitationOverrides } from "@/lib/citation-categorizer/overrides-loader";
import { displayCitationUrl } from "@/lib/url-display";
import type {
  QueryRunView,
  ResolvedMention,
  ScopeCitation,
  MentionSentimentBreakdown,
  MentionTypeBreakdown,
} from "@/lib/scope/types";
import { geoEntryForUrl } from "@/lib/geo-catalog";
import {
  GEO_OWNED_BASE_PREFIXES,
  GEO_OWNED_DOMAINS,
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
  registrableDomainOfHost, SHARED_GLOBAL_HOSTS } from "@/lib/geo-catalog/owned";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import { REGION_TAGGING_CUTOFF_ISO } from "@/lib/scope/region-tagging";
import { websiteSiteGeoPred } from "@/lib/db/repositories/website-geo-pred";
import {
  bulkMirrorRunVisibleSql,
  bulkMirrorRunVisibleSqlKnown,
} from "@/lib/db/repositories/scope-mirror-progress-read";
import { effectiveScopeCountries } from "@/lib/rhq";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import {
  trackedEntityIdsFor,
  rollupCanonicalPairs,
  hmgBrandPrefixEntries,
  hmgRollupIdByNamePrefix,
  resolveHmgBrandName,
  HMG_BRAND_ENTITY_IDS,
} from "@/lib/scope/hmg-brands";
import {
  BRAND_DISPLAY_ALIAS_ENTRIES,
  canonicalBrandDisplayName,
} from "@/lib/scope/brand-display-aliases";
import {
  NON_COMPETITOR_BRANDS,
  BARE_ONLY_NON_COMPETITOR_PATTERNS,
} from "@/lib/scope/non-competitor-brands";
import { JS_TRIM_CHARS, POSIX_LEADING_TRIM } from "@/lib/scope/text-trim";

// HMG KPI aggregation computed in SQL over the scope_* mirror (lib/scope/mirror).
// This replaces result-adapter's in-memory rollup: a GROUP BY over indexed mirror
// tables scales to 10k+ answers and — because the mirror holds EVERY answer (all
// engines, not the workspace-wide capped /results) — Gemini's citation/position
// KPIs come through. Same output shapes as result-adapter so views are unchanged.
//
// HMG-specific (intentionally not in scope, a general engine): the tracked-brand
// set and the owned-base-url attribution rules live here.
// 진단 전용(brandSample — 표기 불일치 감시). KPI 판정에는 더 이상 쓰지 않는다.
const TRACKED = sql`('Hyundai', 'Kia', 'Genesis')`;
// 당사 판정 단일 헬퍼 (2026-07-02 축D/E 구현, lib/scope/hmg-brands가 정본):
//  - entity_id 기반: scope_mentions.brand_rollup_entity_id 는 Brand 행이면 자기
//    자신, Product(모델) 행이면 소속 브랜드 — IN 절 하나로 브랜드+모델을 함께
//    판정한다(모델 포함, 자사·경쟁 대칭). 표기 변형("현대" 등)에도 안전.
//  - 축E 스코프: 활성 brand 필터(계정 락 포함) ∩ 3사, kia-hq → Kia만.
//    admin/무필터 → 3사 전체.
//  - 단위 통일 규칙 (2026-07-03): contextBrand(프로젝트 = project.brand, 게이트웨이
//    주입)가 있으면 그것이 단위 컨텍스트 — Kia 프로젝트의 당사 = Kia.
// 노출률·점유율·순위·우호도가 전부 이 하나를 참조한다.
function trackedRollupIn(f: StandardFilters): SQL {
  return sql`(${sql.join(
    trackedEntityIdsFor(f.contextBrand ?? f.brand, f.ownEntities).map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
// 브랜드 rollup id → 대표 표기(Brand 행의 brand). 랭킹/추이 시리즈 이름 해석용.
// ORDER BY: 종전에는 정렬이 없어 한 entity 가 복수 표기를 가지면 대표 표기가
// 플랜에 따라 임의로 뽑혔다(KR 화면에 아랍어 라벨이 뜰 수 있는 경로, 2026-08-06
// 고객 피드백). 라틴 표기 우선 + 사전순으로 결정적으로 고정한다 — 아래
// `DISTINCT ON … ORDER BY` 는 **그 결정론 규칙의 정본**이라 문자 그대로 유지한다.
//
// ── 성능: loose index scan (skip scan) ──────────────────────────────────────
// 이 상수는 이 파일에서 12곳으로 전개된다 — SQL 11곳(`WITH names AS` 6 ·
// ACR_NAME_JOIN 이 4번 인라인 · 모델 parent 조인 1) + JS 진입점
// readBrandNameMap 1. 종전 형태
//   SELECT DISTINCT ON (entity_id) … FROM scope_mentions WHERE entity_type='Brand'
// 는 결과가 1,218행인데도 **803,045행 전부를 훑어야** 했다(프로덕션 실측:
// 733~736ms · shared buffers 58,836 · Heap Fetches 76,075). DISTINCT ON 은
// 그룹의 첫 행만 필요한데 플래너에 skip-scan 이 없어 전 구간을 읽는다.
//
// 재귀 CTE 로 "다음 (entity_id, brand) 쌍" 을 인덱스로 한 번에 점프해 **서로 다른
// 쌍의 수(1,219)만큼만** 인덱스를 탐색한다 — 같은 1,218행에 14.8ms · buffers
// 4,800 · Heap Fetches 433 (49.7배, 프로덕션 실측 2026-08-28).
// 동치성: 결과 md5 동일 · EXCEPT 양방향 0 (전수 대조).
//
// ⚠️ **인덱스 의존성 (제거 금지)**: `scope_mentions_rollup_names_idx`
//    = (entity_type, entity_id, brand) WHERE brand IS NOT NULL
//    — migration `0045_perf_indexes_2026_08_26.sql`.
//    이 인덱스가 사라지면 재귀 반복마다 seq scan 이 되어 1,219 × 전체 스캔으로
//    파국이 된다(종전 형태보다 압도적으로 느려진다). 인덱스를 지우려면 이 상수를
//    먼저 종전 DISTINCT ON 형태로 되돌려야 한다.
// ⚠️ 재귀 CTE 의 행수 추정은 실제 크기와 무관하게 rows=101 로 고정된다(실제 1,218).
//    2026-08-28 전수 EXPLAIN 에서 11개 콜사이트 모두 이 추정 덕에 names 를 **해시
//    빌드 쪽**에 놓았고(Hash Left Join, loops=1) 그게 실제 크기에서도 옳은 선택이라
//    회귀는 없었다 — 오히려 종전 Merge Right Join 이 강제하던 803k행 스캔 + mention
//    쪽 정렬이 사라졌다. 다만 **그 선택이 추정에 기대고 있다**: names 가 자릿수
//    단위로 커져도 추정은 101 근처에 머무르므로 플래너가 알아서 바로잡지 못한다.
//    새 콜사이트를 추가하거나 Brand 표기 수가 크게 늘면 EXPLAIN 으로
//    (a) 조인 순서 (b) names 가 Nested Loop 의 inner 로 내려가 재스캔되지 않는지를
//    확인할 것.
export const ROLLUP_NAMES = sql`(
  WITH RECURSIVE _rn_pairs AS (
    (SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
      ORDER BY m.entity_id, m.brand LIMIT 1)
    UNION ALL
    SELECT nx.entity_id, nx.brand FROM _rn_pairs p
    CROSS JOIN LATERAL (
      SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
        AND (m.entity_id, m.brand) > (p.entity_id, p.brand)
      ORDER BY m.entity_id, m.brand LIMIT 1
    ) nx
  )
  SELECT DISTINCT ON (entity_id) entity_id, brand
  FROM _rn_pairs ORDER BY entity_id, (brand ~ '^[A-Za-z]') DESC, brand
)`;
// 표기 변형 rollup 정규화(2026-08-05): scope 가 자국어 표기('기아'·'هيونداي' 등)에
// 별도 entity_id 를 부여해 정본 3사와 랭킹 행이 갈라진다. 미러는 보존하고 집계
// 시점에만 알리아스 id → 정본 id 로 접는다(비경쟁 제외와 같은 read-time 원칙) —
// names 조인·GROUP BY 가 이 표현식을 쓰면 '기아' 행이 'Kia' 행에 합산된다.
// 페어 정본은 lib/scope/hmg-brands.ts::rollupCanonicalPairs (레지스트리 파생,
// 시드 폴백). GROUP BY 병행 select 는 파라미터 번호가 갈려 식 동일성이 깨지므로
// is_tracked 는 bool_or() 집계로 감싼다(그룹 내 상수라 값은 동일).
// export 이유: 정합 가드가 **컴파일된 SQL**(drizzle 이 실제로 발행하는 문자열·
// 바인드 파라미터)을 단언한다 — 소스 grep 가드가 포맷 변경에 뚫렸던 전례 때문에.
// 소비처는 이 파일과 *.parity(.int).test.ts 뿐이다.
export function canonRollupSql(f: StandardFilters, alias = "m"): SQL {
  const rid = sql`${sql.raw(alias)}.brand_rollup_entity_id`;
  const nameCol = sql`${sql.raw(alias)}.brand`;
  const pairs = rollupCanonicalPairs(f.ownEntities);
  const byId = pairs.length
    ? sql`(CASE ${rid} ${sql.join(
        pairs.map(([aliasId, canon]) => sql`WHEN ${aliasId} THEN ${canon}`),
        sql` `,
      )} ELSE ${rid} END)`
    : rid;
  // 표기 접두 교정 (2026-08-28) — scope rollup 이 틀린 브랜드를 가리키거나(예:
  // `Genesis G70 3.3T`→Dodge) 당사 파생 표기를 별도 rollup 으로 떼어 놓는(예:
  // `Kia Charge`) 두 결함을 하나의 규칙으로 잡는다. 근거·전수 수치는
  // lib/scope/hmg-brands.ts::HMG_BRAND_NAME_PREFIXES 주석.
  // anchored + 뒤에 영숫자가 오지 않을 것 → 'Genesisian' 같은 부분일치 배제.
  // ⚠️ id CASE 보다 **먼저** 평가한다: 표기가 당사면 그 rollup 이 무엇이든 당사다.
  // 선행 공백 허용: JS 쌍둥이(hmgBrandByNamePrefix)가 판정 전에 `.trim()` 하므로
  // 같은 집합을 패턴 앞에 붙인다. btrim 대신 정규식 클래스를 쓰는 이유(실측 비용)
  // 는 lib/scope/text-trim.ts::POSIX_LEADING_TRIM 주석.
  // ⚠️ **이 규칙의 정합 검증 슬라이스를 손으로 고르지 마라** (2026-08-29).
  // #113 은 AE/Genesis 슬라이스 하나로 4개 표면 정합을 검증했는데, 그 슬라이스는
  // 이 접두 CASE 를 **한 번도 실행시키지 않았다**(규칙 on/off 둘 다 총계 2,046 ·
  // Genesis 182 — 완전 동일). 검증이 공허하게 통과한 것이다.
  // 규율: 값을 비교하기 전에 **"규칙이 이 슬라이스에서 발화했는가"를 먼저 단언**
  // 하고, 슬라이스는 측정으로 고른다. 정본 가드 2종:
  //   · scope-aggregates.prefix-rule-parity.test.ts      (DB 불필요 — 배선 전수)
  //   · scope-aggregates.prefix-rule-slice.int.test.ts   (DATABASE_URL — 실데이터 발화)
  const prefixCases = hmgBrandPrefixEntries().map(([, entityId, prefixes]) => {
    const pattern =
      `^${POSIX_LEADING_TRIM}(${prefixes.map(escapeRegexLiteral).join("|")})([^[:alnum:]]|$)`;
    return sql`WHEN ${nameCol} ~* ${pattern} THEN ${entityId}`;
  });
  // ⚠️ NULL 보존 (2026-08-29 회귀 수리 — 이 가드를 빼지 말 것).
  // 접두 CASE 를 id CASE 앞에 놓으면서 `brand_rollup_entity_id IS NULL` 인 행도
  // 표기만으로 당사 rollup 을 얻게 됐다. 그런데 브랜드 롤업 표들은 전부
  // `WHERE m.brand_rollup_entity_id IS NOT NULL` 가드를 유지하고 ③ 우호도만
  // 그 가드가 없어서, **어느 브랜드 표에도 나타나지 않는 언급이 우호도 분모에만**
  // 들어갔다(프로덕션 실측 2026-08-29: 527행 · 956 언급 · 956 감정신호).
  //
  // 그 527행은 전부 entity_type ∈ {ProductCategory, Feature} 다("Kia EV series"
  // 273 · "현대 N" 271 · "Hyundai Creta N Line" 237 · "기아 커넥트" 62 …).
  // 미러 전수에서 Brand·Product 행은 rollup NULL 이 **0건**이고 Feature·
  // ProductCategory 는 344,263행 중 344,233 이 NULL 이다 — 즉 `IS NOT NULL` 은
  // 사실상 "entity_type ∈ {Brand, Product}" 필터이고, 그것이 브랜드 비교 KPI 의
  // 모집단 정의(자사·경쟁 대칭)다. 경쟁사의 Feature·ProductCategory 언급은 어느
  // 표에도 안 들어가므로, 당사 것만 넣으면 비대칭이 된다.
  //
  // 그래서 canonRollupSql 을 **NULL 보존 함수**로 만든다:
  //   canonRollupSql(x) IS NULL  ⟺  x.brand_rollup_entity_id IS NULL
  // 이러면 `IN (…)` 이 NULL(=거짓)로 떨어져 14개 호출부 전부가 자동으로 같은
  // 답을 낸다 — 술어 하나만 고치면 raw `canonRollupSql(...) IN ...` 형태의
  // 호출부(브랜드표·ACR)가 새는 것을 막을 수 없기 때문이다.
  // 반대 방향(표들의 IS NOT NULL 가드 제거)은 기각: NULL rollup 343,736행이
  // 표기 그대로 "브랜드"가 되어 랭킹에 **가짜 브랜드 3,935개 · 528,120 언급**
  // (분모 +12.5%)이 유입된다(실측).
  return sql`(CASE WHEN ${rid} IS NULL THEN ${rid} ${sql.join(prefixCases, sql` `)} ELSE ${byId} END)`;
}

// 정규식 메타문자 이스케이프 — 접두 표기는 코드 상수지만(사용자 입력 아님)
// 'Pro Cee\'d' 처럼 메타문자를 가진 표기가 나중에 추가돼도 안전하게.
function escapeRegexLiteral(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── 당사(tracked) 판정 술어 — 단일 정본 ──────────────────────────────────────
// 2026-08-28 정합 수정. 종전에는 화면마다 두 갈래가 섞여 있었다:
//   · 랭킹·점유율   → canonRollupSql(...) IN trackedRollupIn(...)   (알리아스 접힘)
//   · 노출률·우호도·순위·Sub KPI → m.brand_rollup_entity_id IN ...   (raw, 안 접힘)
// 같은 답변이 한 화면에선 '당사 언급', 다른 화면에선 '미언급'이 될 수 있는 구조였다.
// 이제 전 호출부가 이 하나를 쓴다.
export function trackedRollupPredicate(f: StandardFilters, alias = "m"): SQL {
  return sql`${canonRollupSql(f, alias)} IN ${trackedRollupIn(f)}`;
}
// 표시명 병합(2026-08-06): 경쟁사는 정본 entity_id 를 코드에 둘 수 없어(워크스페이스
// 데이터 종속 UUID) "표기명"을 정본 표기로 번역하고 이름으로 GROUP BY 한다 —
// '폭스바겐'→'Volkswagen' 같은 자국어 표기와, 같은 이름이 여러 entity_id 로 갈라진
// 중복(Toyota 2개 id 등)이 함께 접힌다. 사전 정본은 lib/scope/brand-display-aliases.
// GROUP BY 는 식 동일성(파라미터 번호) 함정을 피해 ordinal(1)로 참조한다.
export function canonBrandNameSql(expr: SQL): SQL {
  if (!BRAND_DISPLAY_ALIAS_ENTRIES.length) return expr;
  return sql`(CASE ${expr} ${sql.join(
    BRAND_DISPLAY_ALIAS_ENTRIES.map(([alias, canon]) => sql`WHEN ${alias} THEN ${canon}`),
    sql` `,
  )} ELSE ${expr} END)`;
}
// 비경쟁 제외 목록의 **키** — 정본 표기로 접은 뒤 트림·소문자. 목록이 소문자
// 리터럴이라 판정 전에 반드시 이 형태로 정규화해야 한다.
function bareBrandNameSql(expr: SQL): SQL {
  return sql`lower(btrim(${canonBrandNameSql(expr)}, ${JS_TRIM_CHARS}))`;
}

// ── names 쪽 사전 계산 (2026-09-01 성능) ────────────────────────────────────
// 언급 집계는 전부 `COALESCE(n.brand, m.brand)` 를 canonBrandNameSql(38-branch
// CASE)로 접은 뒤 표시명·제외판정 키로 쓴다. 그 식이 **언급 행마다** 돌았다.
//
// 그런데 `canonBrandNameSql`·`lower`·`btrim` 은 전부 strict(NULL→NULL)이고
// canonBrandNameSql 은 NULL 보존(`CASE expr WHEN … ELSE expr END`, 입력 NULL 이면
// 어떤 WHEN 도 안 맞아 ELSE=NULL)이다. strict f 에 대해
//     f(COALESCE(a, b)) ≡ COALESCE(f(a), f(b))
// 이므로 n 쪽 값을 **names 안에서 미리 계산**해 두고, COALESCE 의 단축평가로
// n 이 맞은 행에서는 m 쪽 식을 아예 평가하지 않게 만들 수 있다.
//
// names 는 1,508행이고 언급의 **99.53%** 가 names 에 적중한다(프로덕션 실측
// 2026-09-01: 853,822행 중 849,778 적중 · 폴백 4,044 · 양쪽 NULL 0). 즉 38-branch
// CASE 의 평가 횟수가 853,822×2 → 1,508+4,044 로 떨어진다.
// 실측 효과는 aggregateStandardTrendFromMirror ② 주석의 전후표 참조.
const ROLLUP_NAMES_BARE = sql`(
  SELECT r.entity_id, r.brand,
         ${canonBrandNameSql(sql`r.brand`)} AS cname,
         ${bareBrandNameSql(sql`r.brand`)} AS bare
  FROM ${ROLLUP_NAMES} r
)`;
// 위 CTE 를 `names` 로 붙인 쿼리에서 쓰는 두 식. alias 는 언급 테이블 별칭.
// `COALESCE(n.cname, canon(x.brand))` ≡ `canon(COALESCE(n.brand, x.brand))`,
// `COALESCE(n.bare,  bare(x.brand))`  ≡ `bare(COALESCE(n.brand, x.brand))`.
function rollupDisplayName(alias: string): SQL {
  return sql`COALESCE(n.cname, ${canonBrandNameSql(sql`${sql.raw(alias)}.brand`)})`;
}
function rollupBareName(alias: string): SQL {
  return sql`COALESCE(n.bare, ${bareBrandNameSql(sql`${sql.raw(alias)}.brand`)})`;
}
// 경쟁 브랜드 랭킹/GEO 경쟁에서 제외할 비경쟁 브랜드(Apple/Google/Samsung 등,
// lib/scope/non-competitor-brands.ts) — 미러 데이터는 그대로 두고 집계 시점에만
// 걸러 정책 변경 시 되돌리기 쉽게 유지(2026-07-06). `brandCol`은 두 쿼리 모두
// 동일한 COALESCE(n.brand, m.brand) 표현식.
//
// 2026-08-29: `ownCol`(그 언급 자신의 표기 = m.brand) 추가. 제외는 **rollup 표기**로
// 판정하므로 이름 하나가 하위 Product 언급까지 함께 지운다 — smart/cruise/
// international 처럼 이름이 진짜 자동차·모빌리티 브랜드와 겹치는 셋에서 그 대가가
// 실제 손실이었다(Smart Fortwo 161 언급이 통째로 소실). bare 표기만 제외하고
// 이름을 확장한 하위 제품은 살린다 — 근거·전수 수치는 non-competitor-brands.ts 의
// BARE_ONLY_NON_COMPETITORS 주석, JS 쌍둥이는 isNonCompetitorMention().
// ownCol 을 안 넘기면 종전 동작 그대로(= bare 판정만).
// 트림 정합(2026-08-29): JS 쌍둥이(isNonCompetitorMention)는 rollup 표기·자기 표기를
// 둘 다 `.trim()` 한 뒤 판정한다. SQL 도 같은 집합으로 맞추되 형태가 둘로 갈린다 —
//  · `NOT IN` 은 **동등 비교**라 정규식으로 못 바꾼다 → btrim(브랜드표 쿼리에서
//    +79ms/134k행, 프로덕션 EXPLAIN 실측). 정합값으로 지불한다.
//  · 되살리기 분기는 이미 정규식이므로 패턴 앞의 선행 트림 클래스가 흡수한다
//    (BARE_ONLY_NON_COMPETITOR_PATTERNS — 추가 비용 없음).
//
// ── 성능: `bare` 를 27번이 아니라 2번만 평가한다 (2026-09-01) ────────────────
// 종전 형태는 `bare NOT IN (…) OR (bare = 'smart' AND …) OR (bare = 'cruise' …)`
// 로, **`bare` 표현식이 1 + 27 = 28번** 텍스트로 전개됐다. `bare` 는 싼 식이
// 아니다 — `lower(btrim(canonBrandNameSql(COALESCE(n.brand, m.brand)), …))` 이고
// canonBrandNameSql 은 38-branch CASE 다. 즉 행마다 CASE 38분기 × 28 = 1,064회
// 문자열 비교 + btrim/lower 28회.
//
// 프로덕션 실측(2026-09-01, 추이 ② 버킷별 언급 쿼리 · admin 무필터 · 84일):
//   scope_mentions 2.08M 행에 이 필터가 걸려 **Hash Left Join 노드 단독 25,298 ms**
//   (전체 27,699 ms 중). `shared hit` 전량(디스크 IO 0) — 순수 CPU 였다.
//
// 단순 CASE(`CASE expr WHEN … END`)는 테스트 식을 **한 번만** 평가한다(PG 의
// CaseTestExpr). 그래서 되살리기 분기 27개를 WHEN 으로 접으면 `bare` 평가가
// 1(CASE 테스트) + 1(ELSE 의 NOT IN) = **2회**로 떨어진다.
//
// 동치성 — `BARE_ONLY ⊆ NON_COMPETITOR_BRANDS` 이고 이름이 유일하면 두 형태는
// 같은 진리표를 갖는다:
//   · bare ∉ L        → 구: TRUE.        신: 어떤 WHEN 도 안 맞음 → ELSE `NOT IN` → TRUE
//   · bare ∈ L \ R    → 구: FALSE|FALSE. 신: ELSE → FALSE
//   · bare = r ∈ R    → 구: FALSE OR (own ~* p_r).  신: WHEN r → (own ~* p_r)
//   · bare IS NULL    → 구: NULL.        신: WHEN 은 NULL=… 이라 안 맞음 → ELSE NULL
// 이 형태는 오히려 **JS 쌍둥이(isNonCompetitorMention)의 제어 흐름과 1:1** 이다
// (그쪽도 `has(bare)` → `BARE_ONLY_JS_PATTERNS.get(bare)` 순서로 분기한다).
// 전제 두 개는 가정이 아니라 가드로 박아 둔다 — 아래 assert + 파리티 테스트
// (scope-aggregates.non-competitor-parity.test.ts).
export function excludeNonCompetitorBrandsSql(brandCol: SQL, ownCol?: SQL): SQL {
  return excludeNonCompetitorBaresSql(
    sql`lower(btrim(${brandCol}, ${JS_TRIM_CHARS}))`,
    ownCol,
  );
}
// 같은 술어를 **이미 정규화된 키**(lower+btrim+정본표기)로 받는 형태. 호출부가
// names 쪽 사전 계산값(rollupBareName)을 넘길 수 있게 갈라 둔 것뿐이고, 판정
// 로직은 위 함수와 하나다.
export function excludeNonCompetitorBaresSql(bare: SQL, ownCol?: SQL): SQL {
  const list = sql.join(
    [...NON_COMPETITOR_BRANDS].map((b) => sql`${b}`),
    sql`, `,
  );
  const base = sql`${bare} NOT IN (${list})`;
  if (!ownCol || BARE_ONLY_NON_COMPETITOR_PATTERNS.length === 0) return base;
  assertBareOnlySubsumed();
  // 패턴은 소문자 리터럴 + 빌드타임 이스케이프 → `~*`(대소문자 무시)로 비교한다.
  const revive = sql.join(
    BARE_ONLY_NON_COMPETITOR_PATTERNS.map(
      ([name, pattern]) => sql`WHEN ${name} THEN (${ownCol} ~* ${pattern})`,
    ),
    sql` `,
  );
  return sql`(CASE ${bare} ${revive} ELSE ${base} END)`;
}
// 위 CASE 형태의 동치성 전제. 깨지면 되살리기 이름 하나가 "제외 목록에 없는데
// 패턴이 안 맞으면 제외" 로 뒤집혀 **조용히** 언급이 사라진다 — 그래서 던진다.
let bareOnlyChecked = false;
function assertBareOnlySubsumed(): void {
  if (bareOnlyChecked) return;
  const names = BARE_ONLY_NON_COMPETITOR_PATTERNS.map(([n]) => n);
  const missing = names.filter((n) => !NON_COMPETITOR_BRANDS.has(n));
  if (missing.length) {
    throw new Error(
      `BARE_ONLY_NON_COMPETITOR_PATTERNS must be a subset of NON_COMPETITOR_BRANDS; missing: ${missing.join(", ")}`,
    );
  }
  if (new Set(names).size !== names.length) {
    throw new Error("BARE_ONLY_NON_COMPETITOR_PATTERNS names must be unique");
  }
  bareOnlyChecked = true;
}
// ── ④ 우선노출도 — 브랜드 내 순위 (2026-09-06 읽기 시점 재계산) ─────────────
// 종전 ④ 는 미러 `avg_position` 을 그대로 평균했다. 그 값은 scope 코어가 분석 시
// 저장한 `COALESCE(rank, mention_position)` 이고, `mention_position` 은 **카탈로그에
// 매치된 전 엔티티(브랜드·제품·Feature·카테고리)의 텍스트 순 서수**다. 2026-08-19~25
// 코어 Automotive 카탈로그가 자동 시드로 2배 팽창(신규 엔티티 2,943개 — `Modern`·
// `Across`·`Vehicle`·`price` 같은 일반어 오탐 다수)하면서 같은 프롬프트·같은 답변
// 길이인데 서수가 12→24 로 밀렸고(루트 8/18 12.0 → 8/25 22.3), 이후 회차도 카탈로그가
// 그대로라 눈금이 돌아오지 않는다. 노이즈 행을 읽기 시점에 빼도(NON_COMPETITOR) 자사
// 행에 이미 박힌 서수는 안 바뀐다.
//
// 처방: 같은 답변의 브랜드 행 전부(언급 탭 mm 과 동일 모집단 — rollup 보유 + 비경쟁
// 제외)를 (정본 브랜드명, 답변) 단위로 min(avg_position) 으로 접은 뒤, 답변 안에서
// `rank()` 를 매긴다 = "자사보다 앞선 비노이즈 브랜드 수 + 1". Feature·카테고리는
// rollup 이 없어 자동 배제되고, 노이즈 브랜드는 기존 목록이 걸러낸다. 미러 시뮬레이션
// (2026-09-06): 루트 8/11 2.18 · 8/18 2.27 · 8/25 2.40 · 8/31 2.25, website 1.13.
// 정본: internal-kb/hmg-geo-position-kpi-brand-rank-stopgap-plan-2026-09-06.md
//
// 이 조각은 `_answer_set`(withAnswerSet 임시 테이블) 위에서만 동작한다. 소비처 4곳
// (④ 타일 · Sub-KPI top1/top3 · 추이 ④ · 언급 탭 브랜드 순위)이 **같은 문장**을 써야
// 화면 간 정합(2026-08-28 결정: 타일 = 언급 탭 자사 행)이 유지된다.
// 반환: (job_id, rk) — rk = 자사(tracked) 브랜드 중 최선 순위. 자사 브랜드가 순위에
// 없는 답변은 행이 없다(종전 ④ 의 "미랭크 제외" 규칙 그대로).
export function ownBrandRankPerJobSql(f: StandardFilters): SQL {
  // 성능(2026-09-06 EXPLAIN ANALYZE, 프로덕션 미러 8/31 회차 = 답변 56k·언급행 340k):
  // 행당 식 비용이 지배한다 — rollup 정규화 CASE(정규식 3분기)·표기 CASE(~40분기)·
  // 비경쟁 제외(NOT IN + 되살리기 정규식 ~12분기). 전부 한 문장에 인라인하면 9.7s.
  //   ① rollup 정규화는 행당 1회만(_br_src) — names 조인 키와 tracked 판정이 같은 값을 쓴다.
  //   ② 표기 CASE 도 행당 1회(_br_raw, MATERIALIZED).
  //   ③ 비경쟁 제외는 행이 아니라 **DISTINCT (표기, 원문) 쌍**(_br_keep) 위에서만 평가.
  return sql`(
    WITH names AS ${ROLLUP_NAMES},
    _br_src AS MATERIALIZED (
      SELECT ${canonRollupSql(f)} AS rid, COALESCE(m.brand, '') AS brand, m.job_id, m.avg_position
      FROM scope_mentions m
      JOIN _answer_set a ON a.job_id = m.job_id
      WHERE m.brand_rollup_entity_id IS NOT NULL
        AND m.avg_position IS NOT NULL
    ),
    _br_raw AS MATERIALIZED (
      SELECT ${canonBrandNameSql(sql`COALESCE(n.brand, s.brand)`)} AS name, s.brand, s.job_id, s.avg_position,
        (s.rid IN ${trackedRollupIn(f)}) AS is_trk
      FROM _br_src s
      LEFT JOIN names n ON n.entity_id = s.rid
      WHERE COALESCE(n.brand, s.brand) <> ''
    ),
    _br_pairs AS MATERIALIZED (
      SELECT DISTINCT name, brand FROM _br_raw
    ),
    _br_keep AS (
      SELECT x.name, x.brand FROM _br_pairs x
      WHERE ${excludeNonCompetitorBrandsSql(sql`x.name`, sql`x.brand`)}
    ),
    _br_mm AS (
      SELECT r.name, r.job_id, r.avg_position, r.is_trk
      FROM _br_raw r JOIN _br_keep k ON k.name = r.name AND k.brand = r.brand
    ),
    _br_pos AS (
      SELECT name, job_id, min(avg_position) AS tp, bool_or(is_trk) AS is_trk
      FROM _br_mm GROUP BY 1, 2
    ),
    _br_rk AS (
      SELECT job_id, is_trk,
        rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk
      FROM _br_pos
    )
    SELECT job_id, min(rk)::int AS rk FROM _br_rk WHERE is_trk GROUP BY job_id
  )`;
}
// Domain-level owned-citation detection (KPI ⑥ 인용 정확도의 글로벌 fallback
// 전용). Anchored at label boundary so hyundai.com.mx matches but
// nothyundai.com does not. The base-URL path `ownedBasePrefixClause` is more
// precise and is used in the snapshot aggregate; this simpler regex check is
// kept for the accuracy paths where a project prefix isn't configured.
// 공식(당사) 인용 판정 경로는 전사 상수 대신 아래 ownedDomainPatternFor /
// ownedFallbackDomains(콜사이트가 전달한 베이스 목록에서 파생)를 쓴다.
function ownedDomainPatternFor(domains: string[]): string | null {
  if (domains.length === 0) return null;
  return `(^|\\.)(${domains.map((d) => d.replace(/\./g, "\\.")).join("|")})$`;
}
const OWNED = sql`${ownedDomainPatternFor(GEO_OWNED_DOMAINS)}`;

// owned base prefix 목록 → registrable 도메인 집합. 인용 상세 경로의 (a) URL
// 정규화 후보 좁히기, (b) url 없는 행의 도메인 서픽스 폴백이 이 집합을 쓴다 —
// 전달된 베이스와 판정 대상 도메인이 항상 같은 스코프를 가리키게 한다(전사
// 카탈로그 상수로 폴백하면 축E/프로젝트 좁히기가 도메인 폴백에서 샌다).
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

// URL 매칭 정규화는 server-only 가 아닌 lib/scope/url-match 로 분리(verify
// 스크립트와 공유). 호출부 하위호환을 위해 re-export.
export { normalizeUrlForMatch };

const round1 = (v: unknown): number => Math.round(Number(v) * 10) / 10;
const num = (v: unknown): number => Number(v ?? 0);

// KPI ⑤ base-url normalization: query/fragment are ignored so a cited localized
// page still rolls up to its canonical site base.
// 2026-08-27: regex 6회 → 앵커드 regex 2회 + 비정규식(btrim/split_part/rtrim)으로
// 축소 — 인용 집계의 최대 병목이 "행(또는 distinct url)당 regex 6회"였고, 특히
// 양끝 공백 트림의 글로벌 regex('^\s+|\s+$','g')가 최고가였다. 산출 등가는 실 DB
// 전 corpus 789,351개 distinct url 에서 신구 불일치 0건으로 실증(IS DISTINCT FROM
// 비교). 단계 대응: btrim=양끝 공백(\s) 제거, regex ^https?://·^www. 제거(앵커드
// 라 저가), split_part '?'/'#'=쿼리·프래그먼트 제거, rtrim '/'=말미 슬래시 제거.
// CASE/LIKE 로 regex 를 완전히 없애는 형태는 인라인 시 하위식이 3중 반복 평가돼
// (Postgres 는 스칼라 CSE 를 안 한다) 오히려 느리다 — 단일 평가 사슬을 유지할 것.
// export 이유: migration 0052 의 SQL 정본 citation_url_base_norm() 이 이 식과
// 문자적으로 같아야 하고, 그 일치를 scope-aggregates.citation-norm-columns.test.ts
// 가 컴파일 결과 대조로 강제한다(정의가 세 벌로 갈라지는 것을 막는 유일한 장치).
export function citationBaseNormSql(col: SQL): SQL {
  return sql`rtrim(split_part(split_part(regexp_replace(regexp_replace(lower(btrim(${col}, E' \t\n\r\f\v')), '^https?://', ''), '^www\\.', ''), '?', 1), '#', 1), '/')`;
}

// KPI ⑥ tracked-URL normalization: query is preserved by policy; fragment is
// ignored because it is client-side only.
// lib/scope/url-match.ts::normalizeUrlForMatch 의 SQL 쌍둥이. 단계·순서가 1:1로
// 대응해야 한다 — scripts/scope/verify-url-match.ts 가 둘의 일치를 강제한다.
// 트래킹 파라미터 3패스 제거의 근거는 JS 쪽 주석 참조.
const TRACKING_PARAM_SQL =
  "(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)";

// export 이유: *.int.test.ts 가 "타겟 URL 인용률"의 flat(사이트 전체 타겟 집합)
// 대조 쿼리에서 이 정규화의 twin(fragment·tracking-param 제거)을 손으로 다시
// 구현하다가 `#...` 텍스트 프래그먼트 제거를 빠뜨려 매칭을 과소 계산한 전례
// (2026-08-30) — 재구현 대신 이 함수를 그대로 재사용해 정규화 로직을 단일
// 정본으로 유지한다.
export function citationTrackedNormSql(col: SQL): SQL {
  const base = sql`regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace(${col}, '^\\s+|\\s+$', '', 'g')), '^https?://', ''), '^www\\.', ''), '#.*$', '')`;
  const noMid = sql`regexp_replace(${base}, ${`&${TRACKING_PARAM_SQL}=[^&]*`}, '', 'g')`;
  const noHead = sql`regexp_replace(${noMid}, ${`\\?${TRACKING_PARAM_SQL}=[^&]*&`}, '?')`;
  const noOnly = sql`regexp_replace(${noHead}, ${`\\?${TRACKING_PARAM_SQL}=[^&]*$`}, '')`;
  return sql`regexp_replace(${noOnly}, '/+$', '')`;
}

// ── 타겟 URL 일치 판정 ──────────────────────────────────────────────────────
// 정의는 `lib/scope/url-match-sql.ts` 가 정본이다 — 이 파일은 `server-only` 라
// 패리티 검증 스크립트(tsx)가 import 할 수 없어서 떼어냈다(검증자 F-2). 여기서는
// 재수출만 한다: 호출부·형태 테스트가 종전 경로를 그대로 쓴다.
export { targetMatchSql };

// ── 정규화 컬럼(migration 0052) 소비 ────────────────────────────────────────
// 정규화를 **조회 시점**이 아니라 **동기화 시점**에 하도록 옮긴 뒤의 읽기 규약.
// 세 상태를 전부 정확하게 통과해야 한다:
//   ① 컬럼 없음(배포가 db:apply 보다 앞선 창) → 종전 식 그대로. 변화 없음.
//   ② 컬럼 있음·미충전(백필 전) → coalesce 가 SQL 함수로 폴백. 값은 동일하고,
//      비용도 종전과 같다(아래 "왜 DISTINCT 구조를 유지하는가").
//   ③ 컬럼 있음·충전 완료 → 컬럼 읽기. regexp_replace 사슬이 사라진다.
//
// 폴백을 인라인 TS 식이 아니라 SQL 함수(citation_url_norm/…_base_norm)로 두는
// 이유: 컬럼과 함수는 같은 마이그레이션에서 함께 생기므로 ②에서 반드시 존재하고,
// 저장된 값과 폴백 값이 **정의상** 같아진다(정의 두 벌 금지).
//
// ⚠️ 왜 DISTINCT/GROUP BY 구조를 그대로 두는가 — ②가 실재하는 창이기 때문이다.
// 머지는 무인 배포이고 db:apply 는 제품 책임자가 손으로 돌린다. 적용 직후~백필 완료
// 사이에는 컬럼이 전부 NULL 이다. 이때 구조를 "행마다 컬럼 읽기"로 접으면
// 폴백이 **행당** 평가되어 #178 이 고친 바로 그 상태(전 행 regex)로 되돌아간다.
// distinct 당 1회를 유지하면 어떤 상태에서도 종전보다 나빠지지 않는다.
// 구조 자체를 접는 것(un/ub CTE 제거)은 백필 완료를 실측한 뒤의 후속이다.
type CitationNormKind = "tracked" | "base";

/** 인용 URL 정규화 값 — 컬럼이 있으면 컬럼, NULL 이면 SQL 함수 폴백. */
export function citationNormExpr(kind: CitationNormKind, urlExpr: SQL, colExpr: SQL): SQL {
  if (!citationNormColumnsAvailable()) {
    return kind === "tracked" ? citationTrackedNormSql(urlExpr) : citationBaseNormSql(urlExpr);
  }
  const fn =
    kind === "tracked"
      ? sql`citation_url_norm(${urlExpr})`
      : sql`citation_url_base_norm(${urlExpr})`;
  return sql`coalesce(${colExpr}, ${fn})`;
}

/** `c2` 류 CTE 에 정규화 컬럼을 함께 싣는다(투영뿐 — 컬럼이 없으면 아무 것도 안 낸다). */
function citationNormProjection(col: SQL, alias: string): SQL {
  return citationNormColumnsAvailable() ? sql`, ${col} AS ${sql.raw(alias)}` : sql``;
}

// KPI⑤ 인용 계열 3곳(코어 ⑤ · 엔진별 Q4 · 버킷별 추이)이 공유하는 형태 —
// DISTINCT url 당 owned 판정 1회. 컬럼이 있으면 GROUP BY + max() 로 접는데,
// **백필 진행 중에는 같은 url 이 (NULL, 값) 두 형태로 존재할 수 있어** DISTINCT
// 를 쓰면 키당 2행이 되고 되붙이기 LEFT JOIN 이 count(*) 를 부풀린다. max() 는
// 그 둘을 한 행으로 접고(NULL 은 무시되므로 채워진 값이 이긴다) 조인 다중도를
// 종전과 같은 1:1로 고정한다.
//
// export 이유: 이 형태를 쓰는 3곳은 전부 aggregateStandardFromMirror 안쪽이라
// 형태 테스트에서 단독으로 부를 수 없다 — 1:1 보장이 깨지면 count(*) 가 조용히
// 부풀므로 그 성질만 직접 고정한다(scope-aggregates.citation-norm-shape.test.ts).
export function citationOwnedByUrlSelect(citSet: SQL, ownedClause: SQL): SQL {
  return sql`(
    SELECT url, ${ownedClause} AS owned
    FROM ${citationDistinctUrlBase(citSet)} x
  )`;
}

/** DISTINCT url 당 base 정규화 1회 — 위 함수와 **같은 조각**(텍스트 동일). */
function citationDistinctUrlBase(citSet: SQL): SQL {
  return citationNormColumnsAvailable()
    ? sql`(SELECT url, coalesce(bk, citation_url_base_norm(url)) AS base
        FROM (SELECT url, max(bk) AS bk FROM ${citSet} GROUP BY url) d)`
    : sql`(SELECT url, ${citationBaseNormSql(sql`url`)} AS base
        FROM (SELECT DISTINCT url FROM ${citSet}) d)`;
}

/**
 * 유닛 판정(키 on)용 짝 — **정규화만** DISTINCT url 당 1회 하고 판정은 하지 않는다.
 *
 * 유닛 판정은 "그 프롬프트가 속한 유닛" 에 달려 있어 url 당 1회로 접을 수 없다. 그래서
 * 비싼 부분(정규화 사슬)만 여기서 접고, 값싼 문자열 비교인 판정은 인용 **행**에서 한다
 * — `aggregateWebsiteTargetHitRate` 의 `ub`/`pm` 분업과 같은 형태다.
 *
 * `base`(쿼리 제거)와 `cnorm`(tracked, 쿼리 보존)을 **둘 다** 낸다: 리포트 정본의 자사
 * 판정이 base 항은 base NORM, 타겟 항은 tracked NORM 이기 때문이다
 * (`websiteUnitOwnedTargetClause` 머리 주석). 정규화 사슬은 여전히 DISTINCT url 당
 * 각 1회다 — 행당이 아니다.
 */
export function citationBaseByUrlSelect(citSet: SQL): SQL {
  const inner = citationNormColumnsAvailable()
    ? sql`(SELECT url, coalesce(bk, citation_url_base_norm(url)) AS base,
        coalesce(nk, citation_url_norm(url)) AS cnorm
        FROM (SELECT url, max(bk) AS bk, max(nk) AS nk FROM ${citSet} GROUP BY url) d)`
    : sql`(SELECT url, ${citationBaseNormSql(sql`url`)} AS base,
        ${citationTrackedNormSql(sql`url`)} AS cnorm
        FROM (SELECT DISTINCT url FROM ${citSet}) d)`;
  return sql`(
    SELECT url, base, cnorm
    FROM ${inner} x
  )`;
}

// `siblingUniverse` — '가장 긴 접두가 이긴다'를 판정할 때 형제를 찾을 모집단.
// 미지정이면 카탈로그 전체(종전 동작). **선언 base(website_prompts.owned_base_url)를
// 쓸 때는 반드시 그 사이트의 선언 목록을 넘겨야 한다** — 카탈로그에서 찾으면 같은
// 사이트의 하위 경로를 남의 자산으로 오인해 제외한다(2026-09-01 실측: 선언 base
// `kia.com/my` 에 카탈로그의 `kia.com/my/en` 이 형제로 걸려 ⑤ 12.24 → 11.87,
// Genesis/SA 세 유닛도 `…/ar` 이 걸려 같은 방향으로 어긋났다).
// export 이유: 보고서 정본(엑셀 v2.5) 대조용 사실표 생성기가 **같은 술어**를 써야 한다.
// 규칙을 옮겨 적으면 .html 동치·쿼리 제거 base 비교가 빠져 자사 인용이 조용히 적게 잡힌다
// (2026-09-06 실측 11 job·13건). 생성기: scripts/summary/website-0904.ts::unitOwnedSql.
export function ownedBasePrefixClause(
  cnorm: SQL,
  basePrefixes: string[],
  siblingUniverse?: string[],
): SQL {
  // 베이스는 사이트 루트 prefix 로 접는다(홈 문서 URL 절단 — geo-catalog
  // ownedBasePrefixFromUrl 주석 참조). 홈 문서 인용 자체는 세 번째 분기
  // (= prefix||'.html')가 잡는다 — JS 쌍둥이 matchesOwnedBasePrefix 와 동일.
  const prefixes = [...new Set(basePrefixes.map(ownedBasePrefixFromUrl).filter(Boolean))];
  if (prefixes.length === 0) return sql`false`;
  // 프리픽스당 OR 3개를 늘어놓으면 admin(3사 통합, 170개)에서 510개 OR 노드가
  // 인용 행마다 순차 평가된다 — 배열 연산 3개(= ANY / LIKE ANY / = ANY)로 접어
  // 행당 평가를 벡터화한다(2026-08-27 콜드 로드 수정). LIKE 패턴의 %/_ 미이스케이프는
  // 종전 `LIKE p || '/%'` 와 동일한 의미(변경 없음).
  const arr = (items: string[]) =>
    sql`ARRAY[${sql.join(items.map((v) => sql`${v}`), sql`, `)}]::text[]`;
  // 호스트 사전필터: LIKE ANY(프리픽스 N개)는 비매치 행이 N개 패턴을 전부
  // 순회한다(admin 170개 × 인용 distinct url 수십만 = 수천만 LIKE 평가). 인용
  // 대부분은 당사 호스트가 아니므로, 정규화 base 의 호스트부(split_part '/')를
  // 해시 = ANY 로 먼저 거르고 통과분(수 %)에만 프리픽스 매칭을 돌린다. 프리픽스
  // 호스트부가 같으면 판정 결과는 동일 — 의미 불변.
  const hosts = [...new Set(prefixes.map((p) => (p as string).split("/")[0]))];
  const matches = (ps: string[]) =>
    sql`(${cnorm} = ANY(${arr(ps)}) OR ${cnorm} LIKE ANY(${arr(ps.map((p) => `${p}/%`))}) OR ${cnorm} = ANY(${arr(ps.map((p) => `${p}.html`))}))`;
  // 긴 접두 우선(2026-09-01). 카탈로그에는 같은 호스트를 언어로 가른 베이스가 있고
  // (hyundaicanada.com = EN, hyundaicanada.com/fr = FR), 짧은 쪽이 루트라 접두 OR 만
  // 쓰면 EN 베이스가 FR 페이지를 삼킨다. JS 쌍둥이 ownedBaseEntryForUrl 은 이미
  // '가장 긴 접두가 이긴다'로 가르므로(GEO_OWNED_BASES_DESC), SQL 도 같게 만든다:
  // 선택된 베이스 아래에 **선택되지 않은 더 긴 베이스**가 있으면 그쪽이 정본이라 제외.
  // 실측(2026-09-01): 언어를 가른 12개 사이트 24개 유닛 중 23개가 서로를 자사로 세고
  // 있었다 — Kia USA ES 47.1% · Genesis Canada FR 28.1% · Kia Canada FR 25.0%.
  const selected = new Set(prefixes as string[]);
  const universe = siblingUniverse
    ? [...new Set(siblingUniverse.map(ownedBasePrefixFromUrl).filter(Boolean))] as string[]
    : GEO_OWNED_BASE_PREFIXES;
  const longerSiblings = universe.filter(
    (q) =>
      !selected.has(q) &&
      (prefixes as string[]).some((p) => q.length > p.length && q.startsWith(`${p}/`)),
  );
  const inScope = longerSiblings.length
    ? sql`(${matches(prefixes as string[])} AND NOT ${matches(longerSiblings)})`
    : matches(prefixes as string[]);
  // 사이트 루트 홈 = 자사 (2026-09-06, JS 쌍둥이 isSiteRootHome 주석 참조). 공유 글로벌 호스트
  // (hyundai.com·kia.com·genesis.com)는 제외. 쿼리(`?…`)·끝 슬래시를 뗀 값이 호스트와 같으면 홈 —
  // base 정규화(`base`)에선 쿼리가 이미 없어 no-op 이고, tracked 정규화(`n`, ⑥ 경로)에서 실제로 뗀다.
  const homeHosts = hosts.filter((h) => !SHARED_GLOBAL_HOSTS.has(h));
  const rootHome = homeHosts.length
    ? sql` OR rtrim(split_part(${cnorm}, '?', 1), '/') = ANY(${arr(homeHosts)})`
    : sql``;
  return sql`(split_part(${cnorm}, '/', 1) = ANY(${arr(hosts)}) AND (${inScope}${rootHome}))`;
}

// WHERE over scope_answers (alias `a`) honoring the three scope-backed filters.
// Multi-select: each axis narrows via an IN-list (OR within axis, AND across).
// `projectCtx` scopes runs to one or more projects:
//   string   → single project, latest completed run (LIMIT 1)
//   string[] → multi-project (website: one per brand×country), latest run per
//              project via DISTINCT ON so each market's freshest snapshot counts
//   omitted  → standard/root view: all completed runs from the most recent batch
//              day (the root project fires parallel sub-runs, LIMIT 1 misses them)
// Never sourced from client input — the gateway always injects server-resolved IDs.
// `allRuns` skips the run-window restriction (trend/time-series reads).
// Shared "latest known answer per (prompt, engine, region)" selector — the
// core de-dup rule behind every snapshot read. `projectScope` is an aliased
// (r.*) predicate so callers can restrict to one project, many, or none
// (root, unrestricted). `boundClause` is a ready-to-splice ` AND …` fragment
// (or empty) — see dateBoundClause / the root 7-day default below.
//
// region is part of the key (not just prompt+engine): the root project's
// prompts are measured across several regions per engine (2026-07-07 found
// up to 6 — AE/BR/DE/EG/KR/US — for the same prompt+chatgpt), so keying only
// on (prompt, target) would silently collapse 5 of those 6 rows into 1 and
// under-report every multi-region prompt. Per-project (website) callers are
// single-country already, so adding region here is a no-op for them.
//
// ── 측정이 끊긴 셀 제외 (2026-09-06) ─────────────────────────────────────────
// "셀별 최신 1건"은 그 셀이 **언제** 마지막으로 측정됐는지를 보지 않았다. 프로젝트가
// 지역·엔진 구성을 바꾸면(측정 중단) 옛 셀의 마지막 답변이 영구히 스냅샷에 남아
// 현재 셀과 합산된다. 실측(Kia·worldwide·en): US 는 7/17 이 마지막인데 KR(9/4)과
// 섞여 카드 34.6%(1,133/3,278) — 같은 화면의 주간 추이 마지막 버킷은 KR 만 보므로
// 36.3%(464/1,277). 카드 분모의 61%(2,001)가 7주 묵은 답변이었다.
//
// 창의 기준점은 now() 가 아니라 **그 프로젝트의 최신 측정 시각**이다. 표준(루트)
// 처럼 now()-7d 로 자르면 웹사이트 프로젝트 123개 중 29개(최근 7일 측정 없음)가
// 빈 화면이 된다(2026-09-06 실측). 프로젝트가 통째로 쉬면 마지막 회차가 그대로
// 남고, 일부 셀만 끊기면 그 셀만 빠진다(영향: 15개 프로젝트·2,936셀/28,108).
// 기준점은 프로젝트별(pm.project_id)이다 — 웹사이트 다중 프로젝트 컨텍스트(브랜드
// 전체)에서 각 사이트가 자기 회차로 판정되게. 명시 기간 필터가 있으면 그 범위
// 안의 최신 측정이 기준점이 된다(기간말 시점 스냅샷 의미 유지).
export const SNAPSHOT_CELL_STALE_DAYS = 7;
const SNAPSHOT_CELL_STALE_SQL = sql.raw(`interval '${SNAPSHOT_CELL_STALE_DAYS} days'`);

function latestAnswerIds(projectScope: SQL, boundClause: SQL): SQL {
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. `DISTINCT ON` 과 `ORDER BY` 선두가
  // 같은 식이어야 한다는 Postgres 제약 때문에 두 자리에 **같은 조각**을 넣는다.
  const k = cellSnapshotKeys({ alias: "a." });
  return sql`(
    SELECT DISTINCT ON (${k.all}) a.job_id
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    JOIN (
      SELECT r.project_id, max(a.measured_at) - ${SNAPSHOT_CELL_STALE_SQL} AS floor_at
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      WHERE ${projectScope}
        AND r.status IN ('completed', 'partial_failed')
        AND a.status = 'completed'${boundClause}
      GROUP BY r.project_id
    ) pm ON pm.project_id = r.project_id
    WHERE ${projectScope}
      AND r.status IN ('completed', 'partial_failed')
      AND a.status = 'completed'${boundClause}
      AND a.measured_at >= pm.floor_at
    ORDER BY ${k.all}, ${k.tieBreak}
  )`;
}

// Bare boolean predicate (no leading ` AND`) from explicit filter dates, or
// `true` (unbounded) when neither is set — usable both in a WHERE clause and
// inside a FILTER (WHERE …) aggregate modifier.
// 표준(글로벌) **옵션**의 측정 창 — 데이터 경로(snapshotAnswerIds 의 루트 분기)와
// 같은 규칙이어야 "옵션에 있으면 데이터가 있다"가 성립한다 (2026-09-04).
//
// 종전 옵션 함수들은 창을 안 걸어 **이력에 한 번이라도 측정된** 국가·언어를 전부
// 냈다. 그래서 측정이 멈춘 시장이 드롭다운에 남고, 고르면 빈 화면이 됐다 —
// 실측: 이집트(EG)가 8/25 이후 측정 0인데 국가 목록에 계속 노출(45개국 중 1개).
// 창을 걸면 44개국이 되고 EG 는 다시 측정되는 순간 자동으로 돌아온다(상수 관리 불필요).
//
// 규칙은 데이터 경로와 1:1: 명시 기간 필터가 있으면 그 범위, 없으면 최근 7일
// (둘 다 run 의 started_at 기준).
export function optionWindowPredicate(range?: { dateFrom?: string; dateTo?: string }): SQL {
  if (range?.dateFrom || range?.dateTo) {
    return dateBoundPredicate({ dateFrom: range.dateFrom, dateTo: range.dateTo });
  }
  return sql`r.started_at >= now() - interval '7 days'`;
}

// ── 기간 축 = **회차 앵커** (2026-09-16 제품 책임자 재확인) ─────────────────────────
//
// "측정이 아니라 앵커 기준으로 보여야 한다." 확정 기획 문구도 "기간에 걸치는
// **회차 앵커**"이고, 사실표(summary) 경로는 이미 그렇게 동작한다
// (`summary-cycles.ts::pickCyclesInRange` 가 `c.cycle_anchor_at` 으로 회차 집합을
// 고른다). 미러 경로를 거기에 맞춘다.
//
// 축이 다르면 결과가 다르다 — 라이브 실측(미러, 90일 완료 답변 477,770건):
// `date(measured_at) ≠ date(cycle_anchor_at)` 이 **128,945건(27.0%)**. 회차의 꼬리
// 측정이 다음 날로 넘어가는 이월이 상시 현상이기 때문이다.
//
// 폴백: `cycle_anchor_at` 이 NULL 인 run 은 종전 축을 쓴다. 라이브 실측 **37/27,273
// run(0.14%)** — scope measurements API 가 앵커를 안 싣던 시기의 잔여분이다(0058).
//
// **마이그레이션은 필요 없다.** 앵커는 run 단위 속성이라 `scope_answers` 에 컬럼을
// 더하지 않고도 run 준-조인(semi-join)으로 판정된다 — 아래 두 함수는 이미 걸려
// 있던 run 스코프 술어에 앵커 경계를 **접어 넣어** semi-join 수를 늘리지 않는다.
// 경계 술어·축의 정본은 `lib/period/period-bounds.ts` 다 — 같은 두 줄이 이 파일과
// website-sites.ts 에 여섯 벌 있었고, 벌마다 거는 **축**이 달랐다. 여기 축은 run
// (앵커 우선, 시작 폴백)이고, 전환 때 이 인자 하나가 `anchor_date` 로 바뀐다.
function dateBoundPredicate(f: StandardFilters): SQL {
  return periodBoundsPredicate(f, runStartedAxis());
}

// ` AND COALESCE(r.cycle_anchor_at, r.started_at) >= …` / `< …` fragment from
// explicit filter dates, or empty (unbounded) when neither is set. Shared by
// every latestAnswerIds call. `r` 는 두 호출부(latestAnswerIds ·
// rootFullCycleAnswerIds)가 이미 조인해 둔 scope_runs 별칭이라 추가 스캔이 없다.
//
// **술어 본문은 `dateBoundPredicate` 한 곳에만 있다** — 이 함수는 그것을 ` AND ` 접두
// 조각으로 감싸는 표기 변환일 뿐이다. 종전에는 같은 세 줄이 두 벌로 복사돼 있어
// 기간 축을 옮길 때 한쪽만 고칠 여지가 있었다(2026-09-19 정리). 출력 SQL 은 바이트
// 동일하다: 기간이 있으면 ` AND ` + 같은 술어, 없으면 빈 조각.
function dateBoundClause(f: StandardFilters): SQL {
  return periodBoundsClause(f, runStartedAxis());
}

// 누적(기간=회차 합) 모드의 run 창 — run 스코프 술어(`runScope`, 예:
// `project_id = …`)에 앵커 경계를 접어 넣는다. 기간이 없으면 종전과 **바이트
// 동일**한 단일 semi-join 이다.
//   · 앵커 있는 run : 앵커가 기간 안
//   · 앵커 NULL run : 종전 축(`measuredCol`)이 기간 안  ← 0.14% 폴백
// `runIdCol`/`measuredCol` 은 호출부 표기(별칭 `a.` 또는 bare, ACR 은 `x.`).
function cumulativeRunWindow(
  f: StandardFilters,
  runIdCol: SQL,
  measuredCol: SQL,
  runScope: SQL,
): SQL {
  const inRuns = (extra: SQL) =>
    sql`${runIdCol} IN (SELECT run_id FROM scope_runs WHERE ${runScope} AND ${extra})`;
  // 두 축 모두 정본 빌더로 — run 서브쿼리 안은 별칭이 없어 bare `cycle_anchor_at` 이다.
  const anchor = periodBounds(f, runAnchorAxis());
  const measured = periodBounds(f, answerMeasuredAxis(measuredCol));
  if (!anchor.length) {
    return sql`${runIdCol} IN (SELECT run_id FROM scope_runs WHERE ${runScope})`;
  }
  return sql`(${inRuns(sql`cycle_anchor_at IS NOT NULL AND ${sql.join(anchor, sql` AND `)}`)} OR (${inRuns(sql`cycle_anchor_at IS NULL`)} AND ${sql.join(measured, sql` AND `)}))`;
}

// 표준 뷰 = 큐레이트된 root 카탈로그(705)로 게이트 (2026-07-08 확정 — "standard
// 이하 모든 뷰가 그 안에서 놀아야"). scope 루트가 카탈로그보다 많은 프롬프트를
// 재고 있어(측정 913 vs 카탈로그 705), 브랜드 무필터(admin) 표준 뷰에 카탈로그
// 밖 프롬프트가 '미분류'로 새어들어왔다(21~23%). 브랜드 락 계정은 브랜드→카탈로그
// 조인이 우연히 이 게이트 역할을 해 0%였지만 admin엔 없었음. 여기서 명시적으로
// prompt_id를 root 카탈로그의 scope_prompt_id 집합으로 제한해 모든 표준 뷰를
// 705로 통일한다. `a.` 는 answerWhere(별칭 있음), 없으면 bare-column(mirror path).
function rootCatalogGate(col: SQL): SQL {
  return sql`${col} IN (SELECT scope_prompt_id FROM prompts WHERE project_id = ${STANDARD_ROOT_PROJECT_ID} AND scope_prompt_id IS NOT NULL)`;
}

// 표면(surface) — 필터 축의 판정 테이블을 가르는 유일한 기준.
// "project" = 호출부가 scope project id 를 들고 온 경로(웹사이트 4화면 + 프로젝트
// 화면), "standard" = 루트 카탈로그 표면(글로벌 대시보드·언급·인용). 세 호출부가
// 이미 `hasProjectCtx` / `projectIds.length` 로 같은 판정을 하고 있으므로 새 신호를
// 만들지 않고 그것을 그대로 넘긴다.
type FilterSurface = "standard" | "project";

// 언어 축(lang) 술어 — **표면마다 판정 컬럼이 다르다** (2026-09-03).
//
//   website/project : website_prompts.lang_code (소문자 BCP-47, 사이트 언어)
//   standard(root)  : scope_prompts.lang        (대문자 ISO 639-1 시트 코드)
//
// 종전에는 표면 구분 없이 website 술어만 붙였다. "표준 경로는 lang 을 보내지
// 않는다"는 전제 위에서였는데, 표준 대시보드는 `onlyGroups` 를 넘기지 않아 language
// 축이 실제로 노출돼 있었고(정적 폴백 en/ko/fr), 고르는 순간 루트 카탈로그 프롬프트가
// website_prompts 서브쿼리에 하나도 안 걸려(운영 DB 겹침 0건) 답변셋이 공집합 →
// 화면 전체가 "데이터 없음"이 됐다. 전제가 거짓이었으므로 축을 표면별로 라우팅한다.
// 근거·실측: internal-kb/hmg-geo-filter-region-country-language-audit-2026-09-03.md §2-A
//
// 케이싱 규약: URL 파라미터·드롭다운 옵션·`filters.lang` 은 **소문자 BCP-47** 하나로
// 통일한다(readStandardFilters 가 소문자화). 저장값이 대문자인 scope_prompts.lang 은
// 이 술어에서 `upper()` 로 맞춘다 — website 쪽은 저장값도 소문자라 종전 술어 그대로다
// (운영 DB 실측 2026-09-03: scope_prompts.lang 29종 전부 대문자, website_prompts.
// lang_code 39종 전부 소문자 — 섞인 값 0).
function langAxisPred(langs: string[], col: SQL, surface: FilterSurface): SQL {
  if (surface === "project") {
    const list = sql.join(langs.map((v) => sql`${v}`), sql`, `);
    return sql`${col} IN (SELECT scope_prompt_id::uuid FROM website_prompts WHERE lang_code IN (${list}) AND scope_prompt_id IS NOT NULL)`;
  }
  const list = sql.join(langs.map((v) => sql`${v.toUpperCase()}`), sql`, `);
  return sql`${col} IN (SELECT prompt_id FROM scope_prompts WHERE lang IS NOT NULL AND upper(lang) IN (${list}))`;
}

// 프롬프트 속성 축(lang·websiteCountry) 술어 — 정본 한 곳.
//
// `col` 로 프롬프트 id 컬럼 표기를 받는다: 별칭 있는 경로는 `a.prompt_id`,
// 미러 bare 경로는 `prompt_id`. 세 호출부(answerWhere · detailAnswerWhere ·
// snapshotRunFilter)가 전부 여기서 파생된다 — 2026-08-25 고객 검수에서 언급
// 드릴다운(JS 경로)만 이 축을 빠뜨려 현대/인도 필터에 중국어·체코어 프롬프트가
// 노출된 사고가 났다. 축을 늘리거나 규칙을 바꿀 땐 반드시 이 함수만 고칠 것.
// websiteCountry 는 website_sites 로만 판정되는 website 전용 축이라 표면 분기가
// 없다(표준 표면은 이 축을 노출하지 않고 URL 로도 받지 않는다 — 표준 화면의 국가는
// scope_answers.region 을 보는 geography 축이다).
function promptAxisPreds(f: StandardFilters, col: SQL, surface: FilterSurface): SQL[] {
  const preds: SQL[] = [];
  if (f.lang?.length) preds.push(langAxisPred(f.lang, col, surface));
  if (f.websiteCountry?.length) {
    preds.push(
      sql`${col} IN (SELECT wp.scope_prompt_id::uuid FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id WHERE ${websiteSiteGeoPred(f.websiteCountry)} AND wp.scope_prompt_id IS NOT NULL)`,
    );
  }
  return preds;
}

// brandPresence 필터 술어 — prompts.brand_presence(migration 0032, 3사 엑셀
// `brand 유무` 정본)를 우선하고, 값이 없는 카탈로그만 기존 brand 태그 규칙으로
// 폴백한다. lib/scope/brand-presence.ts::brandPresenceOf의 SQL 쌍둥이이므로 둘을
// 같이 고쳐야 한다. branded/unbranded를 둘 다 혹은 아무것도 안 고르면 null(무필터).
// resolved 식은 상세 경로(detailAnswerWhere)의 "둘 다 선택" 규칙도 공유한다.
// 2026-09-06: 사실표 생성기(scripts/summary/*)가 이 규칙을 **그대로** 굳혀야 해서
// 컬럼 참조를 인자로 받는 `brandPresenceResolvedSqlFor` 를 export 로 뽑았다(무인자
// 내부 함수는 그것에 위임한다 — 정의가 한 벌이라 드리프트가 구조적으로 불가능하다).
// 옮겨 적은 사본이 생기면 정확히 이 축이 갈린다: 생성기가 원값만 굳혀 미러와
// 답변 12,776 vs 20,712 로 벌어진 전례가 있다(scripts/summary/global-predicates.ts).
export function brandPresenceResolvedSqlFor(brandCol: SQL, presenceCol: SQL): SQL {
  return sql`COALESCE(${presenceCol}, CASE WHEN ${brandCol} = ${UMBRELLA_BRAND} THEN 'unbranded' WHEN ${brandCol} IS NOT NULL THEN 'branded' END)`;
}
function brandPresenceResolvedSql(): SQL {
  return brandPresenceResolvedSqlFor(sql`brand`, sql`brand_presence`);
}
function brandPresencePredicate(selected: string[]): SQL | null {
  const wantBranded = selected.includes("branded");
  const wantUnbranded = selected.includes("unbranded");
  if (wantBranded === wantUnbranded) return null;
  return sql`${brandPresenceResolvedSql()} = ${wantUnbranded ? "unbranded" : "branded"}`;
}

// 2026-07-07 피드백: "이번 주기의 답변 합" — 프롬프트마다 자기 몫의 셀(엔진×지역
// 조합 — 신규 지역 확장 여부에 따라 프롬프트마다 6개일 수도 12개일 수도 있음, 고정
// 상수 아님)이 창 안에서 전부 갱신됐을 때만 그 프롬프트를 포함한다. 창이 열려 있는
// 동안 리프레시가 "진행 중"인 프롬프트(예: 12셀 중 8셀만 새로 채워짐)를 그대로
// 보여주면 나머지 4셀은 이전 주기 값이라 한 프롬프트 안에서 신구 주기가 섞인다 —
// "누적 합이 아니라 이번 주기만" 요구를 어기는 지점. window_cells(FILTER로 창 안만
// 집계) < expected_cells(전체 이력 기준, 그 프롬프트가 실제로 가진 셀 수)면 그
// 프롬프트는 통째로 제외한다(부분 리프레시를 섞어 보여주지 않음 — 다음 창에서
// 마저 채워지면 그때 온전히 포함됨).
// ── 루트(표준·글로벌) 표면의 **지역 스코핑 제외 술어** — 축과 무관하게 공유 ────────
//
// 종전에는 이 셋이 `rootFullCycleAnswerIds` 안에만 있었다. 앵커 축이 full-cycle
// 게이트를 대체하면서 그 함수를 통째로 우회했고, 그 바람에 **게이트가 아니라 지역
// 스코핑인 두 술어까지 함께 사라졌다**(검증 B1). 축이 대체하는 것은 "반쪽 주기 혼입을
// 막는 게이트" 하나뿐이다 — 아래 술어들은 회차를 어떻게 세든 항상 걸려야 한다.
//
// 세 조각을 **AND 접두 포함 형태**로 낸다(`AND …`). 호출부가 `WHERE` 뒤에 그대로 이어
// 붙이는 자리에서 쓰이기 때문이고, 종전 `rootFullCycleAnswerIds` 의 텍스트를 한 글자도
// 바꾸지 않기 위한 형태이기도 하다. 값이 없으면 빈 조각이다.

/** 숨김 지역 제외 — expected/window 양쪽에서 대칭으로 빠져야 한다(머리 주석). */
function rootHiddenRegionsExclusion(): SQL {
  // 숨김 지역은 셀 계산(expected/window)과 선별 양쪽에서 제외한다 — expected에만
  // 남으면 신규 지역 측정이 멈춘 뒤 창이 지나가는 순간 full-cycle 게이트가 전
  // 프롬프트를 떨어뜨린다(expected 18 > window 12 → 표준 화면 전체 공백).
  return HIDDEN_STANDARD_REGIONS.length
    ? sql`AND a.region NOT IN (${sql.join(HIDDEN_STANDARD_REGIONS.map((r) => sql`${r}`), sql`, `)})`
    : sql``;
}

/** 한국어 프롬프트의 비-KR 셀 제외(2026-08-20 사고 대응). */
function rootKoreanNonKrExclusion(): SQL {
  // 2026-08-19 시장 태깅(scope #474)으로 한국어 프롬프트는 KR 단일 시장으로
  // 좁혀졌다. expected_cells는 이력 무제한 union이라 좁혀지기 전 넓은 셀 수
  // (최대 20)가 영구히 남고, window_cells(이제 최대 2)는 그걸 절대 못 따라잡아
  // Hyundai 한국어 프롬프트 208/208이 전량 게이트 탈락하는 사고가 났다(2026-08-20
  // HMG "글로벌 > Hyundai - 아시아 태평양 필터 시 데이터 없음" 리포트로 발견,
  // DB 실측으로 208/208 확인). 위 hiddenRegions와 대칭으로, 한국어 프롬프트의
  // 비-KR 셀을 expected/window 양쪽 계산과 최종 선별에서 제외한다 — 판별 규칙은
  // scope 시장 태깅 백필과 동일(text ~ '[가-힣]', region-scoping-plan §5-3).
  // hmg-geo가 아직 prompts.regions를 미러링하지 않아(H1~H6 잔여) 언어 휴리스틱을
  // 대체 신호로 쓴다 — regions 미러링이 들어오면 이 술어를 그걸로 교체할 것.
  // 2026-08-27 성능 수정 2단.
  //   ① 상관 EXISTS → **비상관 서브리스트**. 플래너가 hashed SubPlan(1회 평가)로
  //      접는다. 종전에는 스캔 행마다 SubPlan 을 돌아 표준 루트 스냅샷 1회에
  //      정규식 평가가 92,651회(2패스)였다 — 프로덕션 실측 708/695/809ms →
  //      450/434/433ms, SubPlan buffers 277,983 소멸. **이 이득은 컬럼 없이도 난다.**
  //   ② 판별을 저장 컬럼 scope_prompts.is_korean 으로 승격(migration 0046,
  //      GENERATED ALWAYS STORED — 드리프트 불가능). 남은 정규식 CPU(스캔당
  //      16,110행)를 마저 없앤다.
  // 판정 불변: prompt_id 는 nullable 이고 EXISTS 는 NULL 일 때 false 이므로
  // `IS NOT NULL` 을 명시해 IN 의 NULL 전파(→ 행 탈락)와 갈라지지 않게 한다.
  //
  // ⚠️ 컬럼 부재 내성: 이 리포는 머지 = 무인 프로덕션 배포이고 migrate 단계가
  // 없다(`build` = `next build`). 0046 이 아직 안 붙은 DB 에 코드가 먼저 가면
  // `sp.is_korean` 이 42703 으로 죽어 표준(글로벌) 계열 전 화면이 장애가 된다.
  // 그래서 컬럼 존재 여부가 **확인된 경우에만** 컬럼을 쓰고, 미확인·부재면 종전
  // 인라인 정규식으로 낸다 — ①의 이득은 유지된 채 장애만 막는다. 판정은
  // 백그라운드 프로브라 요청을 블로킹하지 않는다(첫 요청들은 정규식 경로).
  const bare = rootKoreanNonKrPred();
  return sql`AND ${bare}`;
}

/**
 * 위 술어의 **접두사 없는** 판본 — `AND ` 로 시작하지 않는다(PR④).
 *
 * 왜 둘인가: 종전 소비자(`rootFullCycleAnswerIds`·`snapshotAnswerIds`)는 `WHERE` 뒤에
 * 조각을 **그대로 이어 붙이는** 자리라 `AND ` 접두가 필요하고, 추이 정렬(PR④)은
 * `conds: SQL[]` 배열에 넣어 `sql.join(conds, ' AND ')` 로 합치는 자리라 접두가 있으면
 * `AND AND` 가 된다. **정의는 여기 하나뿐**이고 위 함수는 이 값을 감싸기만 한다 —
 * 컴파일 텍스트는 종전과 바이트 동일하다(중첩 SQL 은 인라인 전개된다).
 */
function rootKoreanNonKrPred(): SQL {
  // ── 2026-09-28 태그 우선 (제품 결정) ──────────────────────────────────────
  // 이 술어는 한국어 프롬프트의 비-KR 셀을 **태그와 무관하게 영구히** 뺐다. 그래서 기아 KO
  // 프롬프트에 US 를 태깅해도(2026-09-28 scope) 그 US 셀이 화면에 영영 안 나온다.
  // 이제 한국어 비-KR 셀은 아래 둘 중 하나일 때만 뺀다:
  //   ① 그 프롬프트에 regions 태그가 없다 — 태그가 없으면 언어 휴리스틱이 유일한 신호다.
  //   ② 태깅 도입(scope #474, `REGION_TAGGING_CUTOFF_ISO`) 이전 측정이다 — 기아 KO 197개는
  //      7/2~8/12 US 답변 2,847건이 있다. 이걸 되살리면 8/19~9/27 창에서 US 셀이 기대치로
  //      돌아와 기아 KO 208개가 과거 창에서 통째로 탈락한다.
  // 그 밖(태그 있음 + 태깅 이후)은 아래 rootRegionTagExclusion·rootRegionTagPred 가 태그로 판정한다.
  // `measured_at IS NULL` 은 ②로 친다(종전처럼 제외 — 시각을 모르는 행을 되살리지 않는다).
  // regions 컬럼이 확인되지 않은 DB 에서는 태그를 알 수 없으므로 ①(전부 태그 없음)과 같다 =
  // 종전 술어 그대로다(컬럼 부재 내성 유지).
  // 비상관 유지: 새 서브쿼리도 `a.*` 를 참조하지 않는다 → hashed SubPlan 1회 평가.
  const koreanFlagPredicate = isKoreanColumnKnownAvailable()
    ? sql`sp.is_korean`
    : sql`sp.text ~ '[가-힣]'`;
  const koreanUntaggedOrPreTagging = columnKnownAvailable("regions")
    ? sql`
    AND (
      a.measured_at IS NULL
      OR a.measured_at < ${sql.raw(`'${REGION_TAGGING_CUTOFF_ISO}'::timestamptz`)}
      OR a.prompt_id NOT IN (
        SELECT sp.prompt_id FROM scope_prompts sp
        WHERE sp.prompt_id IS NOT NULL
          AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
      )
    )`
    : sql``;
  return sql`NOT (
    a.region <> 'KR'
    AND a.prompt_id IS NOT NULL
    AND a.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE ${koreanFlagPredicate})${koreanUntaggedOrPreTagging}
  )`;
}

/** 프롬프트가 태깅한 시장 밖 셀 제외(H3). `regions` 컬럼이 없으면 빈 조각. */
function rootRegionTagExclusion(): SQL {
  // ── H3: 언어 휴리스틱 → **프롬프트가 실제로 태깅한 시장**(scope_prompts.regions) ──
  // 위 한국어 술어는 "한국어 프롬프트는 KR 전용"이라는 **대용물**이었다(2026-08-20
  // 사고 대응). 이제 미러가 `regions` 를 실어오므로 정본 신호로 바꾼다 — 태깅된
  // 시장 밖에서 측정된 셀을 expected/window 양쪽에서 동일하게 제외한다.
  //
  // ⚠️ **구 술어를 지우지 않고 AND 로 겹쳐 둔다.** 실측(2026-08-30, 프로덕션 미러)에서
  // 신 술어가 구 술어를 **완전히 포섭**했다 — 구만 제외 `now_only = 0`, 겹침 28,371,
  // 신만 제외 `next_only = 1,216`. 즉 데이터가 충전된 상태에서 둘을 겹쳐도 결과는
  // 신 술어 단독과 **같다**(포섭의 정의). 겹쳐 두는 값은 **미충전 상태의 안전망**이다:
  // `regions` 가 아직 안 채워진 DB(신규 환경·롤백·미러 지연)에서 신 술어만 남기면
  // 아무것도 제외되지 않아 2026-08-20 사고(한국어 프롬프트의 비-KR 셀 유입)가
  // 그대로 재발한다. 구 술어는 컬럼·데이터 없이도 동작한다.
  // 제거 조건: 미러 `regions` 충전이 상시 보장되고(H1 싱크가 정착) `now_only = 0`
  // 이 회귀 테스트로 고정된 뒤. 그 전까지 이건 부채가 아니라 이중화다.
  // (2026-09-28 부터 구 술어는 "태그 없음 또는 태깅 이전"으로 좁혀졌다 — 위 태그 우선 주석.
  //  태그 있는 한국어 프롬프트의 태깅 이후 셀은 이제 이 신 술어만 판정한다.)
  //
  // 비상관 유지: 두 서브쿼리 모두 `a.*` 를 참조하지 않아 플래너가 hashed SubPlan
  // (1회 평가)으로 접는다 — 2026-08-27 성능 수정 ①의 이득을 깨지 않는다. 상관
  // `EXISTS (… AND a.region = ANY(sp.regions))` 로 쓰면 스캔 행마다 재평가된다.
  //
  // NULL 전파: `NOT IN` 은 서브쿼리에 NULL 이 하나라도 있으면 전체가 NULL(→ 행 탈락)
  // 이 된다. `sp.prompt_id IS NOT NULL` 을 명시해 그 경로를 닫는다.
  //
  // 태그 없음(NULL/빈 배열) = **전체**(상속)이므로 제외하지 않는다 — 플랜 §3-2.
  const bare = rootRegionTagPred();
  return bare ? sql`AND ${bare}` : sql``;
}

/**
 * 위 술어의 **접두사 없는** 판본(PR④ — `rootKoreanNonKrPred` 와 같은 이유).
 * `regions` 컬럼이 없으면 `null` — 호출부가 항을 통째로 생략한다.
 */
function rootRegionTagPred(): SQL | null {
  return columnKnownAvailable("regions")
    ? sql`(
    a.prompt_id IS NULL
    OR a.prompt_id NOT IN (
      SELECT sp.prompt_id FROM scope_prompts sp
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
    OR (a.prompt_id, a.region) IN (
      SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
  )`
    : null;
}

/**
 * 루트 표면의 지역 스코핑 제외 술어 — 앵커 축의 회차 선택 서브쿼리가 쓴다.
 *
 * `hiddenRegions` 는 **호출부마다 다르다**. 축 off 에서 그 술어는
 * `rootFullCycleAnswerIds` **안**에 있었으므로, 그 함수를 우회하는 자리는 각자
 * 종전에 어디서 숨김 지역을 받고 있었는지에 맞춰야 한다:
 *   · `answerWhere` 루트 분기 → 바깥 술어로 이미 건다(`HIDDEN_STANDARD_REGIONS`) → false
 *   · `snapshotAnswerIds` 루트(= JS 경로의 모집단) → 바깥에 없다 → **true**
 * 잘못 고르면 한쪽은 술어가 두 벌이 되고 다른 쪽은 숨김 지역이 되살아난다.
 *
 * 빈 조각(`regions` 컬럼 부재·숨김 지역 목록 없음)은 배열에서 뺀다 — 텍스트에
 * 빈 자리를 남기지 않는다.
 */
function rootRegionScopingPreds(opts: { hiddenRegions?: boolean } = {}): SQL[] {
  const preds: SQL[] = [];
  if (opts.hiddenRegions && HIDDEN_STANDARD_REGIONS.length) {
    preds.push(rootHiddenRegionsExclusion());
  }
  preds.push(rootKoreanNonKrExclusion());
  if (columnKnownAvailable("regions")) preds.push(rootRegionTagExclusion());
  return preds;
}

// ════════════════════════════════════════════════════════════════════════════
// PR④ — 미러 **추이**를 사실표와 같은 정의의 렌더러로 (설계 §9-2 ④, `X.trendGrid`)
// ════════════════════════════════════════════════════════════════════════════
//
// ── 왜 필요한가: 추이 분기만 지역 스코핑이 빠져 있다 ────────────────────────
//
// `answerWhere` 루트 분기는 넷 중 하나를 탄다.
//
//   | 분기 | 지역 스코핑 2종 | full-cycle | 함대 게이트 |
//   | --- | --- | --- | --- |
//   | 축 on + 스냅샷 → `snapshotAnswerIds`      | **있음**(`rootRegionScopingPreds`) | 없음 | 있음 |
//   | 축 on + 기간   → `anchorPeriod`           | **없었다** | 없음 | 있음(`anchorPeriodPreds`) |
//   | 추이(`allRuns`)                            | **없었다** | 없음 | **없었다** |
//   | 축 off + 스냅샷 → `rootFullCycleAnswerIds`| **있음** | 있음 | 없음 |
//
// 이 파일 SA:972-978 이 그 상태를 이미 결함으로 못 박아 두었다(검증 B1):
//   "축이 대체하는 것은 반쪽 주기 혼입을 막는 게이트 하나뿐이다 —
//    아래 술어들은 **회차를 어떻게 세든 항상 걸려야 한다**"
// 추이도 "회차를 세는 한 방식" 이므로 같은 명제 아래 있다.
//
// ── 실측이 그 크기를 말한다 (2026-09-20 미러 읽기 전용) ─────────────────────
//
// 자리별 분모, 함대 대표 회차 기준(`verify/out/G1c-fact-gate-decomposition.csv`):
//
//   | 자리 | 게이트 0 | +카탈로그 | +지역 | +full-cycle | 미러(오늘) |
//   | --- | --- | --- | --- | --- | --- |
//   | 08-03 | 8,386 | 6,331 | **2,640** | 2,602 | 8,386 |
//   | 08-10 | 3,505 | 2,816 | **1,259** |   742 | 5,467 |
//   | 08-17 | 5,893 | 4,233 | **1,539** |   332 | 6,706 |
//   | 08-31 | 37,582 | 37,570 | **37,570** | 37,570 | 37,582 |
//
// 지역 스코핑이 자르는 것의 대부분은 **2026-08-20 사고 데이터**(한국어 프롬프트의
// 비-KR 측정)다: 08-03 3,516 · 08-17 2,645 셀. 시장 태그 단독(`tag_bad`)은 175·49 뿐이다
// (`G1c` 의 `3-tag-split`). 즉 추이에 이 술어가 없다는 것은 **그 사고 데이터를 과거
// 점의 모수에 그대로 싣고 있었다**는 뜻이다. 08-31 이후 자리에서 차이가 0 인 이유는
// 시장 태깅(scope #474, 2026-08-19 배포) 이후 측정 자체가 태그 안에서만 일어나서다.
//
// ── 무엇을 **걸지 않는가** ──────────────────────────────────────────────────
//
//   · `in_full_cycle` — 추이에는 걸지 않는다(D2 = A). 사실표 리더도 안 건다.
//   · **기본 엔진 범위**(`is_default_engine`) — 사실표가 안 걸기 때문에 걸지 않는다.
//     생성기의 회차 잡 집합(`surface-global.ts` 의 `summary_cycle_jobs`)은 엔진을
//     가리지 않는다. 루트 표면에서는 어차피 무해하다: 회차마다 앵커 잡 전수와
//     기본 엔진 잡 수가 **같다**(W0 `03` CSV: 860=860 · 37,582=37,582 · 56,466=56,466).
//     기간 술어(`anchorPeriodPreds`)가 거는 것은 그대로 둔다 — 그쪽은 계약 §3 이다.
//   · **카탈로그 게이트는 이미 양쪽에 있다**(아래 함수 주석의 대조표).

/**
 * 추이 읽기에서 사실표와 모수를 맞추는 술어들. **루트 표면 전용**이고,
 * `X.trendGrid` 가 꺼져 있으면 **빈 배열**이다(호출부가 아무것도 얹지 않는다 = 바이트 동일).
 *
 * ── 카탈로그 게이트 대조 (코드로 확인, 2026-09-20) ─────────────────────────
 *
 *   사실표  `scripts/summary/surface-global.ts::CAT_CTE`
 *           `FROM prompts p WHERE p.project_id = <ROOT> AND p.scope_prompt_id IS NOT NULL`
 *           → `in_root_catalog = CASE WHEN cat.pid IS NOT NULL THEN 1 ELSE 0 END`
 *   미러    이 파일의 `catalogPreds`/`catalogPromptPreds`
 *           `a.prompt_id IN (SELECT scope_prompt_id FROM prompts
 *                            WHERE project_id = <ROOT> AND scope_prompt_id IS NOT NULL)`
 *
 * **같은 집합이다** — `status`·`deleted_at`·`enabled` 어느 것도 양쪽 다 보지 않는다.
 * 그래서 이 함수는 카탈로그 게이트를 **더하지 않는다**(두 벌이 되면 텍스트만 는다).
 *
 * @param jobIdCol  함대 게이트 semi-join 을 걸 `job_id` 컬럼(별칭 포함).
 * @param needsFleetGate `anchorPeriodPreds` 가 이미 함대 게이트를 걸었으면 `false`
 *        (기간이 걸린 축 on 경로) — 같은 술어를 두 번 싣지 않는다.
 */
function trendAlignedRootPreds(
  jobIdCol: SQL,
  needsFleetGate: boolean,
  /** 안쪽 `round_date` 바닥 — `trendRoundFloorSql` 이 만든 값만 넘긴다. */
  roundFloor: SQL | null = null,
  /**
   * 바깥 문장이 **이미 `ca` 와 dim 파생표(`d`)를 조인했는가**. 참이면 semi-join 을
   * 만들지 않고 술어만 낸다(조인 하나, 스캔 하나 — `trendDimJoinSql` 머리 주석).
   * ⚠️ 참으로 넘기면서 `trendDimJoinSql()` 을 FROM 에 안 붙이면 `d` 가 42P01 로 죽는다.
   *    둘이 함께 가는 것은 배선 가드가 고정한다.
   */
  trendJoined = false,
): SQL[] {
  if (!trendGridKnownEnabled()) return [];
  if (trendJoined && anchorAxisKnownEnabled()) {
    const joined: SQL[] = [trendDimJoinedPred()];
    // 함대 게이트도 **조인 판본**이다 — semi-join 을 쓰면 앵커 표를 한 번 더 찌르고
    // `summary_cycles` 를 행마다 조회한다(`trendServableJoinSql` 머리 주석의 실측).
    if (needsFleetGate) joined.push(trendServableJoinedPred());
    return joined;
  }
  // 지역·한국어·카탈로그 판정은 **회차의 dim 스냅샷**에서 읽는다(아래 함수의 머리 주석).
  // 앵커 표가 없으면 셀의 회차를 알 수 없으므로 현재값 술어로 간다 — 다만 이 키는
  // 축(=앵커 표)이 켜져 있어야만 참이라 실제로는 도달하지 않는다.
  const scoped = trendDimScopedJobIds(jobIdCol, roundFloor);
  const preds: SQL[] = scoped ? [scoped] : dimlessRootScopingPreds();
  // 함대 패자 회차 제외 — 사실표 추이 경로의 `restrictToFleetVisible` 과 같은 규칙이다
  // (원장 `fleet_visible` + 발행 + 노출일). 정의는 `scope-answer-anchors.ts` 한 곳이고
  // 여기서는 그 조각을 **소비만** 한다.
  if (needsFleetGate) {
    const fleet = anchorJobIdIn(jobIdCol, [anchorLedgerServableKnownSql("ca")]);
    if (fleet) preds.push(fleet);
  }
  return preds;
}

/**
 * 이 읽기에서 **dim 스냅샷 경로**가 서는가. 서면 루트 카탈로그 게이트를 바깥에
 * 또 걸지 않는다 — dim 판정이 `in_root_catalog` 를 이미 들고 있고, 바깥 현재값
 * 게이트를 남기면 교집합이 되어 "카탈로그에서 빠진 프롬프트" 가 다시 소급 제외된다
 * (이번에 없앤 드리프트와 **같은 형태**다).
 */
function trendDimPathActive(allRuns: boolean, cumulative: boolean): boolean {
  return (
    allRuns === true &&
    cumulative !== true &&
    trendGridKnownEnabled() &&
    anchorAxisKnownEnabled()
  );
}

/** dim 을 못 쓸 때의 현재값 술어 묶음(축 off 폴백). */
function dimlessRootScopingPreds(): SQL[] {
  const preds: SQL[] = [rootKoreanNonKrPred()];
  const tag = rootRegionTagPred();
  if (tag) preds.push(tag);
  return preds;
}

/** 루트 카탈로그 게이트의 **현재값** 판본 — `catalogPreds` 가 내는 것과 같은 집합. */
function rootCatalogNowPred(col: SQL): SQL {
  return sql`${col} IN (
    SELECT scope_prompt_id FROM prompts
     WHERE project_id = ${STANDARD_ROOT_PROJECT_ID} AND scope_prompt_id IS NOT NULL
  )`;
}

// ════════════════════════════════════════════════════════════════════════════
// 회차의 **dim 스냅샷**으로 판정한다 (PR④ 후속, 2026-09-20 메인 결정)
// ════════════════════════════════════════════════════════════════════════════
//
// ── 무엇이 어긋났나 (미러 실측 G2c) ────────────────────────────────────────
//
// PR④ 로 술어를 맞췄는데도 08-03 에서 미러 2,464 대 사실표 2,640(**176셀**),
// 08-17 에서 1,359 대 1,539(**180셀**)이 남았다. 셀 단위 대조 결과는 한 범주로
// 수렴했다: `fact-only:tag-now-excluded` 176(EG × chatgpt 88 · gemini 88) ·
// 08-17 은 180(EG 90+90) · **그 외 범주 전부 0**. 카탈로그·한국어·셀 부재는 0 이다.
//
// 원인은 술어가 아니라 **시점**이다:
//   · 사실표 — 접기 SQL 의 `d` CTE 가 `inTaggedRegionExpr` 를 **그때의 `scope_prompts`**
//     에 평가하고(`surface-global.ts:199`), 같은 실행에서 읽은 값을
//     `summary_prompt_dim.regions`·`is_korean` 으로 굳힌다(`:542`).
//   · 미러 — 같은 술어를 **지금의** `scope_prompts` 에 평가한다.
// 이 자리들의 회차는 전부 2026-09-10 생성이고 관측은 09-20 이다. 그 10일 사이에 EG
// 시장 태그가 붙어, **지금 기준으로는 태그 밖**인 셀이 미러에서만 빠졌다.
//
// ── 그래서 미러가 사실표를 따라간다 (설계 §3 D1 = A) ───────────────────────
//
// 정본은 집계 사실표이고 미러는 "같은 정의의 느린 렌더러" 다. 과거 회차의 값은
// **그 회차를 생성한 시점의 정의**로 굳어 있어야 한다(설계 §5 D3 = B, 마감 후 동결).
// refold 로 과거를 현재 정의에 맞추는 반대 방향은 그 결정과 충돌하므로 채택하지 않는다.
//
// ── 조인 형태: 사전 집계 + 해시 조인, 상관 서브쿼리 금지 ───────────────────
//
// 회차별 LATERAL 이나 `EXISTS (… WHERE pd.prompt_id = a.prompt_id)` 로 쓰면 스캔 행마다
// 재평가돼 statement_timeout 전례를 되밟는다(2026-08-27 성능 수정의 근거와 같다).
// 그래서 **비상관 semi-join 하나**로 낸다: 안쪽에서 앵커 표로 셀의 회차를 얻고,
// 그 회차의 **활성 세대** dim 행을 `LEFT JOIN` 한 뒤 `CASE` 로 두 경로를 가른다.
//   · dim 행이 있으면  → 스냅샷 판정(카탈로그·한국어·시장 태그)
//   · 없으면           → 현재값 판정(종전 술어 그대로)
// 한 식 안에서 갈리므로 스캔은 한 번이고, 플래너는 hash join 을 고른다(확인은 G2d).
//
// `pd.cycle_week` 를 조인 키에 넣는 것은 **파티션 프루닝** 때문이다
// (`summary_prompt_dim` 은 `PARTITION BY RANGE (cycle_week)`).
//
// ── 관찰 지점 ───────────────────────────────────────────────────────────────
// 어느 경로를 탔는지는 `trendDimSnapshotAuditSql()` 이 센다(읽기 전용, 아래).
// 수용 SQL 쪽 관찰은 `verify/G2a-denominator-ladder.sql` 의 `m_dim` 열이다.

/**
 * 추이 모수의 지역·한국어·카탈로그 판정을 **회차 dim 스냅샷**으로 바꾸는 semi-join.
 *
 * 축(앵커 표)이 꺼져 있으면 `null` — 셀의 회차를 얻을 길이 없다. 이 키(`X.trendGrid`)는
 * 축이 켜져 있어야만 참이므로 실제로는 `null` 이 안 나온다.
 *
 * ⚠️ 안쪽 스캔의 범위는 **루트 표면 전체**다(날짜 바닥을 안 건다). 날짜로 좁히면
 *    바깥 창이 그보다 넓은 호출부에서 셀이 조용히 빠진다 — 좁히는 방향의 오류가
 *    "값이 사라지는" 쪽이라 더 나쁘다. 비용은 G2d EXPLAIN 으로 잰다.
 */
/**
 * dim 스냅샷 **파생표 조인 조각** — `FROM scope_answers a JOIN … ca` 뒤에 그대로 붙인다.
 *
 * ── 왜 조인인가 (2026-09-20 4차, 미러 EXPLAIN) ─────────────────────────────
 *
 * 3차(사전 집계 CTE + semi-join)로 dim 쪽은 해결됐다: 13자리 창 4,324 → 2,947ms ·
 * shared hit 2,277,858 → 884,293 · `dim_small` 193,960행 CTE Scan loops=1 · Hash Left
 * Join Batches 1 · 22MB(디스크 유출 없음). **남은 약 2.1초는 semi-join 자신이었다** —
 * `a.job_id IN (SELECT a2.job_id FROM scope_answers a2 JOIN scope_answer_cycle_anchors ca2 …)`
 * 가 바깥이 이미 한 조인(`a` × `ca`)을 **한 번 더** 하고, 그 안쪽이 Nested Loop 으로
 * 풀려 인덱스 조회 20만 회(추정 rows=80 대 실제 209,480)가 됐다.
 *
 * 바깥 문장이 이미 `ca` 를 조인하는 경로에서는 그 중복이 통째로 필요 없다. dim 을
 * **바깥 FROM 에 직접** 걸고 술어는 WHERE 에 둔다 — 조인 하나, 스캔 하나.
 *
 * 꺼져 있으면 **빈 조각**이라 문장이 종전과 바이트 동일하다.
 * CTE 대신 파생표인 이유: 이 조각은 `FROM` 절 한가운데 붙으므로 `WITH` 를 쓸 자리가
 * 없다. 인덱스 없는 서브쿼리라 중첩 루프가 구조적으로 비싼 성질은 CTE 와 같다.
 */
export interface TrendMirrorJoins {
  /** `FROM scope_answers a … ca` 뒤에 붙이는 조각. 꺼져 있으면 **빈 조각**이다. */
  join: SQL;
  /**
   * 이 문장이 `d`·`sv` 를 **실제로 방출했는가**. 술어 쪽(`caJoined`·`svJoined`)에
   * 그대로 넘긴다 — 두 불리언이 어긋나면 `42P01 missing FROM-clause entry` 다.
   */
  joined: boolean;
}

/**
 * 추이 문장이 붙이는 조인 **한 벌**과 그 사실을 함께 낸다.
 *
 * ⚠️ 이 객체가 있는 이유가 **5f5b84e 의 차단 결함**이다. 종전에는 조인 조각(격자·축
 *    가드 있음)과 술어(가드 **없음**)가 따로 놀아서, `caJoined = anchorAxisKnownEnabled()`
 *    만 보고 조인을 안 붙이는 호출부 둘(`readCitationDomainDayCounts` ·
 *    `aggregateWebsiteCitationAccuracyTrend`)이 `sv` 를 참조해 죽었다. 격자가 꺼져
 *    있어도 **축만 켜지면** 발현하므로 통합 프리뷰(축 on)의 인용 화면이 즉시 장애였다.
 *    이제 호출부는 이 한 객체에서 둘을 함께 받는다.
 */
export function trendMirrorJoins(): TrendMirrorJoins {
  const joined = trendGridKnownEnabled() && anchorAxisKnownEnabled();
  return { joined, join: joined ? trendDimJoinSql() : sql`` };
}

export function trendDimJoinSql(alias = "d"): SQL {
  if (!trendGridKnownEnabled() || !anchorAxisKnownEnabled()) return sql``;
  const a = sql.raw(alias);
  const ca = sql.raw(ANCHOR_ALIAS);
  const rootProjectId = addressableRootProjectId();
  const cycleScope = rootProjectId ? sql` AND sc.project_id = ${rootProjectId}` : sql``;
  return sql` LEFT JOIN (
    SELECT pd.cycle_id, pd.prompt_id, pd.in_root_catalog, pd.is_korean, pd.regions
      FROM summary_cycles sc
      JOIN summary_prompt_dim pd
        ON pd.cycle_week = sc.cycle_week AND pd.cycle_id = sc.cycle_id
       AND pd.generation_id = sc.active_generation_id
     WHERE sc.surface = 'global' AND sc.active_generation_id IS NOT NULL${cycleScope}
  ) ${a} ON ${a}.cycle_id = ${ca}.cycle_id AND ${a}.prompt_id = a.prompt_id${trendServableJoinSql()}`;
}

/**
 * **함대 게이트의 조인 판본** — 서빙 가능한 회차만 담은 소형 파생표 `sv`.
 *
 * ── 왜 (2026-09-20 5차, 미러 EXPLAIN) ──────────────────────────────────────
 *
 * 4차에서 dim 을 조인으로 옮겼는데도 순증이 +1.39초였다(A 674ms 대 B 2,065ms).
 * 분해해 보니 주범은 dim 이 아니라 **함대 게이트가 만드는 두 번째 앵커 조인**이었다:
 *   `a.job_id IN (SELECT ca.job_id FROM scope_answer_cycle_anchors ca
 *                  WHERE ca.surface='project' OR EXISTS (SELECT 1 FROM summary_cycles sc …))`
 * 바깥이 이미 `ca` 를 조인(loops=249,101)하는데 이 조각이 앵커 표를 `ca_1` 로 한 번 더
 * 찌르고(loops=187,233), 그 안의 상관 `EXISTS` 가 `summary_cycles` 를 행마다 조회한다
 * (`sc_1` loops=187,233). 최상위 Nested Loop 이 1,984ms 까지 끌고 간 몫이 약 1.06초다.
 *
 * 그래서 바깥 `ca.cycle_id` 를 재사용하고, 회차는 **소형 파생표에 등치 조인**한다.
 *
 * ── 의미 동치 ──────────────────────────────────────────────────────────────
 *
 * 원본: `ca.surface='project' OR EXISTS (… sc.cycle_id = ca.cycle_id AND <조건 셋>)`
 * 새것: `ca.surface='project' OR sv.cycle_id IS NOT NULL`  (sv = 그 조건 셋을 만족하는 회차)
 *   · `cycle_id` 가 PK 라 LEFT JOIN 이 행을 늘리지 않는다 → `IS NOT NULL` 은 `EXISTS` 와 같다.
 *   · `ca.cycle_id IS NULL`(원장에 귀속된 적 없는 앵커)은 양쪽 다 거짓이다.
 * ⚠️ `sv` 에 **표면·프로젝트 조건을 넣지 않는다** — 원본 `EXISTS` 도 안 넣는다.
 *    넣으면 동치가 "cycle_id 는 PK 이므로 표면이 하나뿐" 이라는 **추가 논증**에 기대게 된다.
 *    `summary_cycles` 는 수천 행이라 전량 해시해도 공짜다.
 */
function trendServableJoinSql(alias = "sv"): SQL {
  const sv = sql.raw(alias);
  return sql` LEFT JOIN (
    SELECT sc2.cycle_id
      FROM summary_cycles sc2
     WHERE sc2.fleet_visible
       AND sc2.view_anchor_at IS NOT NULL AND sc2.view_anchor_at <= now()
       AND sc2.active_generation_id IS NOT NULL
  ) ${sv} ON ${sv}.cycle_id = ${sql.raw(ANCHOR_ALIAS)}.cycle_id`;
}

/** 위 파생표를 쓰는 **술어**. 조인이 붙은 문장에서만 쓴다(없으면 42P01). */
function trendServableJoinedPred(alias = "sv"): SQL {
  return sql`(${sql.raw(ANCHOR_ALIAS)}.surface = 'project' OR ${sql.raw(alias)}.cycle_id IS NOT NULL)`;
}

/**
 * **카탈로그 도입 전 회차 탈출구** — 사실표 `trendWhere` 와 **같은 목록**을 읽는다
 * (`summary-pre-catalog-cycles.ts`). 그 회차는 카탈로그·지역 판정을 통째로 건너뛴다 =
 * 그 회차가 측정한 프롬프트 전체가 모수다.
 *
 * 목록이 비면 **입력 술어를 그대로** 돌려준다 — 텍스트가 종전과 바이트 동일이다.
 *
 * @param cycleCol 자리의 회차 id 컬럼(`ca.cycle_id` 또는 안쪽 `ca2.cycle_id`).
 */
function withPreCatalogEscape(cycleCol: SQL, gated: SQL): SQL {
  const pre = preCatalogCycleIdsKnown();
  if (!pre.length) return gated;
  return sql`(${cycleCol} = ANY(${sql.param([...pre])}::uuid[]) OR ${gated})`;
}

/** 바깥에 `ca`·`d` 가 이미 조인된 경로의 **WHERE 술어**(semi-join 없음). */
function trendDimJoinedPred(): SQL {
  const korNow = sql`NOT (
        a.region <> 'KR'
        AND a.prompt_id IS NOT NULL
        AND a.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE ${
          isKoreanColumnKnownAvailable() ? sql`sp.is_korean` : sql`sp.text ~ '[가-힣]'`
        })
      )`;
  const tagNow = columnKnownAvailable("regions")
    ? sql` AND (
        a.prompt_id IS NULL
        OR a.prompt_id NOT IN (
          SELECT sp.prompt_id FROM scope_prompts sp
           WHERE sp.prompt_id IS NOT NULL
             AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
        )
        OR (a.prompt_id, a.region) IN (
          SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
           WHERE sp.prompt_id IS NOT NULL
             AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
        )
      )`
    : sql``;
  return withPreCatalogEscape(
    sql`${sql.raw(ANCHOR_ALIAS)}.cycle_id`,
    sql`CASE WHEN d.prompt_id IS NOT NULL THEN (
        d.in_root_catalog = 1
        AND NOT (a.region <> 'KR' AND d.is_korean = 1)
        AND (d.regions IS NULL OR cardinality(d.regions) = 0
             OR a.region = ANY(d.regions))
      ) ELSE (
        ${rootCatalogNowPred(sql`a.prompt_id`)}
        AND ${korNow}${tagNow}
      ) END`,
  );
}

function trendDimScopedJobIds(jobIdCol: SQL, roundFloor: SQL | null): SQL | null {
  if (!anchorAxisKnownEnabled()) return null;
  const rootProjectId = addressableRootProjectId();
  const anchorScope = rootProjectId ? sql` AND ca2.project_id = ${rootProjectId}` : sql``;
  const cycleScope = rootProjectId ? sql` AND sc.project_id = ${rootProjectId}` : sql``;
  const floor = roundFloor ? sql` AND ca2.round_date >= ${roundFloor}` : sql``;
  // 현재값 경로(= dim 행이 없을 때) — 종전 술어를 **별칭만 바꿔** 그대로 쓴다.
  const korNow = sql`NOT (
        a2.region <> 'KR'
        AND a2.prompt_id IS NOT NULL
        AND a2.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE ${
          isKoreanColumnKnownAvailable() ? sql`sp.is_korean` : sql`sp.text ~ '[가-힣]'`
        })
      )`;
  const tagNow = columnKnownAvailable("regions")
    ? sql` AND (
        a2.prompt_id IS NULL
        OR a2.prompt_id NOT IN (
          SELECT sp.prompt_id FROM scope_prompts sp
           WHERE sp.prompt_id IS NOT NULL
             AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
        )
        OR (a2.prompt_id, a2.region) IN (
          SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
           WHERE sp.prompt_id IS NOT NULL
             AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
        )
      )`
    : sql``;
  return sql`${jobIdCol} IN (
    WITH dim_small AS MATERIALIZED (
      SELECT pd.cycle_id, pd.prompt_id, pd.in_root_catalog, pd.is_korean, pd.regions
        FROM summary_cycles sc
        JOIN summary_prompt_dim pd
          ON pd.cycle_week = sc.cycle_week AND pd.cycle_id = sc.cycle_id
         AND pd.generation_id = sc.active_generation_id
       WHERE sc.surface = 'global' AND sc.active_generation_id IS NOT NULL${cycleScope}
    )
    SELECT a2.job_id
      FROM scope_answers a2
      JOIN scope_answer_cycle_anchors ca2 ON ca2.job_id = a2.job_id
      LEFT JOIN dim_small d ON d.cycle_id = ca2.cycle_id AND d.prompt_id = a2.prompt_id
     WHERE ca2.surface = 'standard'${anchorScope}${floor}
       AND ${withPreCatalogEscape(
         sql`ca2.cycle_id`,
         sql`CASE WHEN d.prompt_id IS NOT NULL THEN (
             d.in_root_catalog = 1
             AND NOT (a2.region <> 'KR' AND d.is_korean = 1)
             AND (d.regions IS NULL OR cardinality(d.regions) = 0
                  OR a2.region = ANY(d.regions))
           ) ELSE (
             ${rootCatalogNowPred(sql`a2.prompt_id`)}
             AND ${korNow}${tagNow}
           ) END`,
       )}
  )`;
}

/**
 * 추이 창 바닥을 **안쪽에도** 넘길 수 있으면 넘긴다(성능). 규칙 하나: **바깥이 거는
 * `round_date` 바닥과 같은 것만** 넘긴다. 다른 값을 넘기면 안쪽이 바깥보다 좁아져
 * 셀이 조용히 빠지고, 그 방향의 오류가 이 트랙이 계속 고쳐 온 바로 그것이다.
 *
 *   · `f.dateFrom` — 앵커 축의 기간은 `ca.round_date >= dateFrom` 이다(`anchorPeriodPreds`).
 *   · `trendRoundFloor` — 호출부가 `trendWindowFloor()`(= `round_date >= 오늘 − 120`)를
 *     **자기 문장에 반드시 얹는** 경우에만 참으로 넘긴다(`aggregateStandardTrendFromMirror`).
 *   · 둘 다 없으면 `null` = 전체 이력(종전). 창을 모르는 호출부는 좁히지 않는다.
 *
 * ⚠️ `measured_at` 창(`kpiTabTrendWhere` 의 `now − N days`)은 **못 쓴다** — `round_date` 와
 *    축이 다르다(회차 꼬리 측정이 며칠 이월된다). 축이 다른 값을 바닥으로 쓰면 경계
 *    회차가 통째로 빠진다.
 */
function trendRoundFloorSql(
  f: StandardFilters,
  opts: { trendRoundFloor?: boolean },
): SQL | null {
  if (f.dateFrom) return sql`${f.dateFrom}::date`;
  if (opts.trendRoundFloor === true) {
    // 바깥 `trendWindowFloor` 과 **같은 일수**여야 한다 — 안쪽이 더 좁으면 dim 판정이
    // 없는 셀이 생겨 그 자리가 통째로 폴백 경로로 떨어진다(격자 on 이면 180).
    return sql`hmg_anchor_today() - ${sql.raw(String(trendFloorDays()))}`;
  }
  return null;
}

/**
 * **관찰 지점** — 추이 모수가 dim 스냅샷 경로를 탔는가, 현재값 폴백을 탔는가.
 *
 * 읽기 전용 단일 문장이고, 자리(`round_date`)별로 셋을 센다:
 *   · `dim_path`      회차의 활성 세대 dim 행으로 판정한 셀
 *   · `fallback_path` dim 행이 없어 현재값으로 판정한 셀(0 이어야 정상이다 —
 *     함대 게이트가 이미 "활성 세대 있음" 을 요구하므로 dim 이 있어야 한다)
 *   · `drift_cells`   두 판정이 **갈린** 셀 = 이 수리가 되살린 몫(08-03 176 · 08-17 180)
 *
 * 운영·하네스가 정기로 돌려 `fallback_path` 가 늘면 생성이 빠진 회차가 있다는 신호다.
 */
export function trendDimSnapshotAuditSql(rootProjectId: string, fromRoundDate: string): SQL {
  return sql`
    SELECT ca.round_date,
           count(*)::bigint AS cells,
           count(*) FILTER (WHERE pd.prompt_id IS NOT NULL)::bigint AS dim_path,
           count(*) FILTER (WHERE pd.prompt_id IS NULL)::bigint     AS fallback_path,
           count(*) FILTER (
             WHERE pd.prompt_id IS NOT NULL
               AND (pd.regions IS NULL OR cardinality(pd.regions) = 0
                    OR a.region = ANY(pd.regions))
               AND a.prompt_id IN (
                 SELECT sp.prompt_id FROM scope_prompts sp
                  WHERE sp.prompt_id IS NOT NULL
                    AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
               )
               AND (a.prompt_id, a.region) NOT IN (
                 SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
                  WHERE sp.prompt_id IS NOT NULL
                    AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
               )
           )::bigint AS drift_cells
      FROM scope_answers a
      JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
      LEFT JOIN summary_cycles sc2 ON sc2.cycle_id = ca.cycle_id
      LEFT JOIN summary_prompt_dim pd
        ON pd.cycle_week = sc2.cycle_week AND pd.cycle_id = sc2.cycle_id
       AND pd.generation_id = sc2.active_generation_id AND pd.prompt_id = a.prompt_id
     WHERE a.status = 'completed'
       AND ca.surface = 'standard'
       AND ca.project_id = ${rootProjectId}
       AND ca.round_date >= ${fromRoundDate}::date
     GROUP BY ca.round_date
     ORDER BY ca.round_date
  `;
}

function rootFullCycleAnswerIds(rootScopeR: SQL, windowPredicate: SQL): SQL {
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. 여기 별칭은 `_fc_base b` 다.
  const fcKeys = cellSnapshotKeys({ alias: "b." });
  const hiddenRegions = rootHiddenRegionsExclusion();
  const koreanNonKrExclusion = rootKoreanNonKrExclusion();
  const regionTagExclusion = rootRegionTagExclusion();
  // ── 단일 스캔 형태 (2026-09-01 성능 수정) ──────────────────────────────────
  // 종전에는 이 서브쿼리가 `scope_answers` 를 **두 번** 훑었다: cell_counts(전 이력
  // 셀 수)에서 한 번, 창 안 DISTINCT ON 에서 또 한 번. 같은 술어를 두 벌 박아
  // 두었기 때문인데, 두 스캔이 필요로 하는 컬럼은 완전히 같다.
  //
  // 왜 그 스캔이 비싼가 — `scope_answers` 는 **1,010 MB · 66,244 페이지**다
  // (`answer_text` 평균 2,063 B × 361,497 행). 집계는 answer_text 를 한 번도
  // 읽지 않는데도 heap 스캔이라 통째로 끌고 온다. 프로덕션 실측(2026-09-01,
  // admin 무필터 표준 스냅샷): Parallel Seq Scan 이 508,128 행 × 2회.
  //
  // 공통 스캔을 CTE `_fc_base` 하나로 접고, 게이트와 창 선별이 **같은 CTE** 를
  // 읽는다. 셀 판정은 `count(DISTINCT (target, region))` 대신 (prompt, target,
  // region) HashAggregate 로 접어 135,684 행 정렬도 없앴다.
  //   동치: expected = |{(t,r)}|, window = |{(t,r) : 창 안 행이 하나라도 있음}|
  //         = count(*) FILTER (WHERE bool_or(in_window)) — 정의 그대로다.
  //   ※ `count(DISTINCT ROW(t,r))` 는 t·r 이 **둘 다** NULL 인 행만 건너뛰는데,
  //     미러에 target/region/prompt_id NULL 은 0 행이다(2026-09-01 전수 확인).
  //
  // 프로덕션 실측 (EXPLAIN ANALYZE, BUFFERS · admin 무필터 · 교차 4회씩 중앙값):
  //   종전  1,047.2 ms · shared hit 296,679   (편차 285 ms)
  //   현재    643.5 ms · shared hit 225,564   (편차 7.6 ms) → 1.63배, 분산도 감소
  // 같은 창 경계에서 두 형태의 산출 행수는 전 회차 동일(37,856)했다.
  // 동치성 전수 대조 — 기본 7일 창: md5 5a0aa7e7365729e29001b20ad585188c 양쪽
  // 동일 · EXCEPT 양방향 0 (n=37,868). 명시 기간(2026-08-01~08-20): md5
  // daf3cc31e4d737ce3ef662018af6afa1 양쪽 동일 · EXCEPT 양방향 0 (n=13,096).
  //
  // ⚠️ **대칭성이 이제 구조적으로 보장된다.** 2026-08-20 사고의 기전은 제외 술어가
  // expected 에만 걸리고 window 에는 안 걸려 `expected > window` 로 전 프롬프트가
  // 탈락한 것이었다. 종전 형태는 술어를 두 벌 적어야 해서 한쪽을 빠뜨릴 수 있었고,
  // 그래서 테스트가 "술어가 정확히 2번 나온다"로 그것을 지켰다. 지금은 술어가
  // `_fc_base` 에 **한 번만** 있고 양쪽이 그 CTE 를 읽으므로 비대칭이 애초에
  // 표현 불가능하다 — 테스트도 그 계약("한 번만 · 공유 CTE 안에")으로 옮겼다
  // (scope-aggregates.region-tag-predicate.test.ts).
  //
  // ⚠️ `_fc_base` 는 두 번 참조되므로 Postgres 가 **materialize** 한다(실측 temp
  // 1,109 블록 ≈ 8.9 MB, work_mem 16 MB). 참조를 하나로 줄이면 인라인되어 다시
  // 두 번 스캔하게 되니, 이 구조를 고칠 때 EXPLAIN 으로 스캔 횟수를 먼저 볼 것.
  return sql`(
    WITH _fc_base AS (
      SELECT a.job_id, a.prompt_id, a.target, a.region, a.measured_at,
        (${windowPredicate}) AS in_window
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      WHERE ${rootScopeR} AND r.status IN ('completed', 'partial_failed') AND a.status = 'completed'
        ${hiddenRegions}
        ${koreanNonKrExclusion}
        ${regionTagExclusion}
    ),
    _fc_cells AS (
      SELECT prompt_id, target, region, bool_or(in_window) AS w,
        min(measured_at) AS first_at,
        max(measured_at) FILTER (WHERE in_window) AS w_last
      FROM _fc_base GROUP BY 1, 2, 3
    ),
    -- ── 기대 셀을 "이번 창에 실제로 돈 셀"로 한정 (2026-09-04, #188) ──────────
    -- expected 는 원래 이력 무제한이었다. 그래서 한 시장의 측정이 멈추면 그 셀이
    -- 기대치에 영구히 남고 window 가 절대 따라잡지 못해, 그 시장을 커버하는
    -- 프롬프트가 **다른 시장에서까지 통째로** 탈락했다(2026-09-04 EG 실증:
    -- 마지막 측정 8/25 인 EG 셀 2개 때문에 AE Hyundai 프롬프트 208개가 fail).
    -- 고침: 창 안에 한 건도 측정되지 않은 (엔진, 국가) 셀은 기대치에서 뺀다.
    -- 그 시장은 돌았는데 이 프롬프트만 빠진 경우는 셀이 active 에 남아 여전히 탈락한다.
    -- main 의 원안(#188)은 이 목록을 scope_answers 재스캔으로 얻었지만, 같은
    -- 술어의 창 안 행은 이미 _fc_base.in_window 에 있으므로 셀 집계에서 파생한다
    -- (스캔 1회 유지 — 아래 단일 스캔 주석의 전제).
    _fc_active AS (
      SELECT DISTINCT target, region FROM _fc_cells WHERE w
    ),
    -- ── 창 끝 이후에 처음 생긴 셀은 기대치에서 뺀다 (2026-09-28) ──────────────
    -- expected 는 이력 무제한이라 **미래**도 본다. 프롬프트에 시장이 나중에 추가되면
    -- (2026-09-28 scope 가 743개 프롬프트에 IN·AU·GB·MY·SA·TH·ID 등을 태깅) 그 새 셀이
    -- 과거 창의 기대치에 들어가, 과거 창을 조회할 때 그 프롬프트가 "셀 부족"으로 탈락한다.
    -- 위 _fc_active 한정(#188)은 그 시장이 **다른 프롬프트로** 창 안에서 측정됐으면 못 막는다
    -- (IN·AU·GB 등은 다른 프롬프트로 매 회차 돈다).
    -- 고침: 셀의 최초 completed 측정 시각(first_at)이 창 안 마지막 측정(w_last 의 최대)보다
    -- 뒤면 그 셀은 "이 창 시점에 아직 없던 셀"이므로 기대치에서 뺀다.
    --   · 창 판정 술어(windowPredicate)는 불투명하므로 창 무관 정의를 쓴다 — 창 끝 = 창 안
    --     행의 measured_at 최대. 창 경계를 SQL 로 다시 해석하지 않는다.
    --   · 대칭: 창 안 셀(w)은 first_at <= 자기 w_last <= 창 끝 이라 절대 빠지지 않는다.
    --     즉 이 절은 **창 밖 셀만** 뺀다 — window 쪽 집계는 불변이다.
    --   · 창 끝은 _fc_cells 에서 파생한다(_fc_base 를 다시 읽지 않는다 — materialize 된
    --     CTE 의 세 번째 참조를 만들지 않기 위해). 스캔 1회 구조는 그대로다.
    --   · NULL 은 종전대로 둔다: 창 안 셀(w)은 무조건 유지, measured_at 이 전부 NULL 인
    --     셀(first_at NULL)도 유지, 창 끝을 모르면(w_last 전부 NULL) 아무것도 빼지 않는다.
    -- 프로덕션 미러 실측(2026-09-28, 읽기 전용): 루트 회차 5개 + 기본 7일 창 전부에서 종전
    -- 게이트 통과 프롬프트 중 탈락 0. 노출 게이트를 끈 9/13·9/20 창에서는 종전 게이트가
    -- 9/27 회차에 새로 생긴 셀 때문에 기아 EN 2개를 떨어뜨렸고(11,408) 이 절이 되살렸다.
    -- EXPLAIN (ANALYZE, BUFFERS) 기본 7일 창 교차 4회 중앙값 596.6 → 626.0 ms(+4.9%, ID 해제로
    -- 늘어난 행 포함) · scope_answers 스캔 1회 · _fc_base 참조 2회 그대로.
    _fc_gate AS (
      SELECT prompt_id FROM _fc_cells c
      WHERE (c.target, c.region) IN (SELECT target, region FROM _fc_active)
        AND (c.w OR c.first_at IS NULL
          OR c.first_at <= (SELECT COALESCE(max(w_last), 'infinity'::timestamptz) FROM _fc_cells))
      GROUP BY prompt_id
      HAVING count(*) FILTER (WHERE w) >= count(*)
    )
    SELECT DISTINCT ON (${fcKeys.all}) b.job_id
    FROM _fc_base b
    JOIN _fc_gate g ON g.prompt_id = b.prompt_id
    WHERE b.in_window
    ORDER BY ${fcKeys.all}, ${fcKeys.tieBreak}
  )`;
}

// Per-project (one or many — website's brand×country projects): the latest
// completed answer per (prompt, engine, region), regardless of which run/day
// it landed in. scope_runs trickle in continuously (small runs every ~10min)
// and can span multiple calendar days before every prompt succeeds once:
// 2026-07-06 found a project whose "latest day" snapshot showed 34 prompts
// while the PRIOR day had already completed all 100 — the day-boundary rule
// discarded a fuller, more-recent-per-prompt pass just because a new (still
// in-progress) day had started. Used by both answerWhere's per-project branch
// and projectRunFilter so the rule lives in exactly one place.
// ── 프로젝트 id 목록 = 바인드 1개 (2026-09-09, PR① B4-b) ────────────────────
// 인라인 `IN ($1,$2,…)` 는 id 개수(웹사이트 함대 93~126)만큼 **문장 텍스트를 바꾼다**
// — 같은 집계가 요청마다 다른 SQL 로 보여 계획이 재사용되지 않고, pg_stat_statements
// 에도 서로 다른 문장으로 흩어진다. 그리고 그 인라인이 집계 함수마다 반복됐다.
//
// `IN (…)` → `= ANY(…)` 는 의미론이 같다: 목록에 NULL 이 없고 부정형(NOT IN)이
// 아니므로 좌변 NULL 전파도 동일하다. 빈 목록은 종전엔 `IN ()` = 문법 오류라
// 콜사이트가 전부 선행 가드를 두고 있고, 배열형은 그 자리에서 false 다(더 안전).
// 형태·의미론 고정: `scope-aggregates.project-id-binds.test.ts`.
//
// 선례는 같은 파일 `snapshotAnswerWhere` 의 `string_to_array($1, ',')::uuid[]`
// (아래 :1319-1331 주석의 EXPLAIN — 43.5ms vs 991ms). 그쪽이 CSV 인 이유는 3만
// 건이라 배열 리터럴 파싱까지 아끼려던 것이고, 여기는 100건 규모라 배열 파라미터
// 그대로 쓴다(값은 `sql.param` 으로만 — 템플릿에 JS 배열을 직접 넣으면 record 로
// 바인딩돼 캐스트가 죽는다).
const uuidAnyParam = (ids: string[]): SQL => sql`ANY(${sql.param(ids)}::uuid[])`;
const textAnyParam = (vals: string[]): SQL => sql`ANY(${sql.param(vals)}::text[])`;

function perProjectLatestAnswerIds(projectIds: string[], f: StandardFilters): SQL {
  return latestAnswerIds(sql`r.project_id = ${uuidAnyParam(projectIds)}`, dateBoundClause(f));
}

/**
 * **앵커 축의 스냅샷 선택** — 회차(`ca.round_date`)마다 셀당 대표 1건 (계약 §3).
 *
 * 종전 `latestAnswerIds` 와의 차이 셋:
 *   ① dedup 키에 **회차**가 들어간다. 종전은 창 전체에서 셀당 1건이라 기간에 회차가
 *      여럿이면 앞 회차가 통째로 소멸했다(2026-09-17 언급 추이에서 실증된 형태).
 *   ② 대표는 `ca.measured_at_orig` 최신이다. 접힌 `a.measured_at` 으로 정렬하면
 *      날짜부가 앵커로 덮여 있어 시:분만 비교한다(스펙 §2-16).
 *   ③ **stale floor 가 없다.** 그 창(프로젝트 최신 측정 − 7일)은 "측정이 끊긴 셀이
 *      영구히 남는" 문제의 대용물이었는데, 앵커 축에서는 고른 회차에 없는 셀은
 *      애초에 행이 없으므로 대용물이 필요 없다.
 *
 * 기간 술어(`anchorPeriodClause`)는 이 서브쿼리 **안**에도 들어간다 — 밖에만 걸면
 * dedup 이 기간 밖 회차까지 보고 대표를 고른 뒤 그 대표가 기간 밖이라 탈락해
 * **셀이 통째로 사라진다**.
 *
 * `anchorScope` 는 **기간이 없을 때** 최신 회차를 고르는 범위다(앵커 테이블 기준의
 * 상수 술어 — 아래 `anchorSnapshotPreds` 참조).
 */
function anchorRoundCellAnswerIdsSubquery(
  projectScopeR: SQL,
  f: StandardFilters,
  anchorScope: SQL[],
  /**
   * 루트(표준) 표면의 **지역 스코핑 제외 술어**(`rootRegionScopingPreds`). 축이
   * 대체하는 것은 full-cycle 게이트뿐이라 이 둘은 여기로 그대로 따라와야 한다
   * (검증 B1: 빠지면 한국어 프롬프트의 비-KR 셀과 태그 밖 시장이 모수에 복귀한다).
   * 프로젝트·웹사이트 표면에는 이 개념이 없으므로 생략한다.
   */
  rootScoping: SQL[] = [],
  /** 숨김 게이트의 지표 계열(검증 D·후속). 기본은 `DEFAULT_HIDDEN_FAMILY`. */
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL {
  const k = anchorCellSnapshotKeys({ alias: "a." });
  // `ca` 가 이미 조인돼 있으므로 semi-join 으로 감싸지 않고 술어를 직접 얹는다.
  const preds =
    anchorPeriodPreds(f, family) ?? anchorSnapshotPreds(f, anchorScope, family);
  const bound = preds?.length ? sql` AND ${sql.join(preds, sql` AND `)}` : sql``;
  // 조각들이 이미 `AND ` 로 시작한다(`rootRegionScopingPreds` 머리 주석).
  const scoping = rootScoping.length
    ? sql` ${sql.join(rootScoping, sql` `)}`
    : sql``;
  return sql`(
    SELECT DISTINCT ON (${k.all}) a.job_id
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id${anchorJoinSql(sql.raw("a.job_id"))}
    WHERE ${projectScopeR}
      AND r.status IN ('completed', 'partial_failed')
      AND a.status = 'completed'${scoping}${bound}
    ORDER BY ${k.all}, ${k.tieBreak}
  )`;
}

/** 위 서브쿼리를 `<job 컬럼> IN (…)` 으로 감싼 것. bare 경로는 `prefix` 를 준다. */
function anchorRoundCellAnswerIds(
  projectScopeR: SQL,
  f: StandardFilters,
  anchorScope: SQL[],
  jobIdCol: SQL = sql.raw("a.job_id"),
  rootScoping: SQL[] = [],
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL {
  return sql`${jobIdCol} IN ${anchorRoundCellAnswerIdsSubquery(projectScopeR, f, anchorScope, rootScoping, family)}`;
}

// ── 기간 의미론 판정 — **단일 정본** (2026-09-16 제품 확정) ──────────────────
//
//   · 필터 없음(기본) = 최신 1회차 스냅샷
//   · 기간 설정        = 그 기간에 걸치는 회차 전부 누적
//
// `answerWhere` 와 `detailAnswerWhere` 가 이 한 함수를 공유한다. 두 벌로 갈라
// 두면 또 어긋난다 — 실제로 2026-09-04~09-16 동안 갈라져 있었고(`answerWhere` 만
// `cumulative` 를 읽고 상세 술어는 안 읽음), 그것이 이노션 2026-09-15 신고
// ("기간을 걸어도 genesisnewseurope.com 인용이 안 뜬다")의 원인이었다.
//
// 세 조건의 근거:
//  ① `f.cumulative === true` — 화면이 누적 표면임을 스스로 선언한 것(답변분석).
//  ② `allRuns !== true` — 추이 읽기는 자기 창(TREND_WINDOW_DAYS 120일 /
//     kpiTabTrendWhere 의 now−N일)을 갖는다. 여기서 누적으로 취급하면 주별
//     그래프가 접힌다(2026-09-04 실증: "주별 상위 10"이 통째로 사라짐).
//  ③ **기간이 실제로 걸렸을 때만** — #225 가 웹사이트 대시보드에 세운 형태와
//     같다(`website/page.tsx:111` = `cumulative: Boolean(dateFrom || dateTo)`).
//     답변분석 페이지들은 2026-09-04 판이라 기간 유무와 무관하게 `cumulative:
//     true` 를 상시로 넘기므로 술어에서 가른다(페이지 12곳 무수정).
//
// ③ 이 없으면 기본 화면이 `now() − 7일` 창이 되어 **최근 7일 측정이 없는
// 프로젝트가 통째로 빈 화면**이 된다 — 라이브 실측(2026-09-15 16:30 UTC =
// 09-16 01:30 KST): 루트 제외 scope 프로젝트 186개 중 **51개**(27.4%)가 해당
// (Hyundai IONIQ 마지막 측정 34일 전 · 인용 5,654 → 0). 스냅샷의 `floor_at` 이
// `now()` 가 아니라 **그 프로젝트의 최신 측정**을 기준점으로 삼는 이유와 같다
// (latestAnswerIds 머리 주석, 2026-09-06: "now()-7d 로 자르면 웹사이트 프로젝트
// 123개 중 29개가 빈 화면"). 종전의 누적 기본창(`CUMULATIVE_DEFAULT_WINDOW`,
// 2026-09-04)은 그 교훈 **이전**에 들어온 것이라 이 커밋에서 함께 제거했다 —
// 누적 모드에는 항상 명시 기간이 있으므로 도달 불가능한 분기가 됐다.
// 판정 자체는 `lib/period/period-mode.ts::resolvePeriodMode` 가 정본이다(같은 명제가
// gate.ts·period-route-flag.ts·website 페이지에도 있었다). 이 함수는 그 리졸버를
// 미러 술어가 쓰는 boolean 표기로 감싼 것뿐이고, 진리표는 종전과 같다.
function cumulativeMode(f: StandardFilters, allRuns?: boolean): boolean {
  return isCumulativePeriod(f, { allRuns, anchorAxis: anchorAxisKnownEnabled() });
}

/**
 * 답변 경로 데이터 술어의 **기본 지표 계열** (검증 D).
 *
 * `'mentions'` = `hidden_scope='all'` 회차만 제외한다. `'all'` 로 두면 인용만 깨져
 * 숨긴 회차(`hidden_scope='citations'`)의 **멀쩡한 언급 값까지** 사라진다 — 값이
 * 틀리는 방향은 아니지만 이 전환이 요구한 적 없는 손실이다. 인용 계열 화면은
 * 자기 술어(`excludeHiddenCycleRuns(…, "citation")`)로 더 좁히므로, 기본을
 * 느슨한 쪽에 두고 계열이 확실한 자리에서만 조이는 것이 두 방향 다 안전하다.
 *
 * ⚠️ 잔존: 인용 **카드** 경로(`aggregateCitationsFromMirror`)는 종전에도
 * `excludeHiddenCycleRuns` 를 안 걸었다. 그 화면에서 `hidden_scope='citations'`
 * 회차는 축 on 에서도 남는다(종전과 같음 = 회귀 아님, 보고 대상).
 */
const DEFAULT_HIDDEN_FAMILY: AnchorHiddenFamily = "mentions";

// ── 앵커 축의 기간 절 (옵트인, 계약 §3) ──────────────────────────────────────
//
// 켜져 있고 **기간이 걸렸을 때만** 만들어진다. 꺼져 있거나 기간이 없으면 `null` 이고,
// 호출부는 절을 통째로 생략하므로 종전 SQL 과 바이트 동일이다.
//
// 절의 구성(전부 비상관 semi-join 안의 상수 술어 — 계약 §5):
//   ① `ca.round_date BETWEEN from AND to`  — 회차는 통째로 들어오거나 나간다
//   ② `anchorViewableSql()`                — 노출 시간 게이트(§3 축 ①)
//   ③ `is_default_engine`                  — 엔진 필터가 **비었을 때만**(§3, 스펙 §2-17)
// 숨김 게이트(축 ②)와 대량 미러 진행 게이트(축 ③)는 여기 없다 — 전자는 async·계열
// 인자가 필요해 `excludeHiddenCycleRuns` 가, 후자는 run 축이라 `bulkMirrorRunVisibleSql`
// 이 각각 맡는다. 셋이 **나란히 AND** 되는 것이 완결 조건이다.
function anchorPeriodPreds(
  f: StandardFilters,
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL[] | null {
  if (!anchorAxisKnownEnabled()) return null;
  const bounds = periodBounds(f, anchorRoundAxis());
  if (bounds.length === 0) return null;
  const preds: SQL[] = [
    ...bounds,
    anchorViewableSql(),
    anchorNotHiddenKnownSql("ca", family),
    // 함대 게이트(프리뷰 실측 2026-09-20) — 원장이 서빙을 허락한 회차만. 기간을
    // 명시한 경우도 집계층과 같은 회차 집합이어야 한다(카드는 원장 경로를 탄다).
    anchorLedgerServableKnownSql("ca"),
  ];
  const engineScope = anchorDefaultEngineScope(f.engine);
  if (engineScope) preds.push(engineScope);
  return preds;
}

/**
 * **run 축** 앵커 절 — `job_id` 가 없는 표(ACR 롤업)용. 기간이 있으면 그 회차들,
 * 없으면 최신 회차 하나. 노출 시간·숨김 게이트를 함께 건다.
 * 기본 엔진 범위는 답변 단위라 여기 넣지 않는다(`anchorRunIdIn` 머리 주석).
 */
function anchorRunClause(
  f: StandardFilters,
  runIdCol: SQL,
  anchorScope: SQL[],
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL | null {
  if (!anchorAxisKnownEnabled()) return null;
  const bounds = periodBounds(f, anchorRoundAxis());
  // 안쪽(최신 회차 선택)과 바깥이 **같은 계열**이다 — `anchorSnapshotPreds` 의 ⚠️.
  const gate = [
    anchorViewableSql(ANCHOR_LATEST_ALIAS),
    anchorNotHiddenKnownSql("ca2", family),
    anchorLedgerServableKnownSql("ca2"),
  ];
  const preds: SQL[] = bounds.length
    ? [...bounds]
    : [anchorLatestRoundClause(anchorScope, gate)];
  preds.push(
    anchorViewableSql(),
    anchorNotHiddenKnownSql("ca", family),
    anchorLedgerServableKnownSql("ca"),
  );
  return anchorRunIdIn(runIdCol, preds);
}

/** 위 술어들을 **비상관 semi-join** 으로 감싼 것. `ca` 가 조인돼 있지 않은 자리용. */
function anchorPeriodClause(
  f: StandardFilters,
  jobIdCol: SQL,
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL | null {
  const preds = anchorPeriodPreds(f, family);
  return preds ? anchorJobIdIn(jobIdCol, preds) : null;
}

// ── 앵커 축의 **기간 미지정** 절 (제품 결정 2026-09-20) ─────────────────
//
// 기본 화면 = 그 화면 범위에서 **노출 가능한 가장 최신 `round_date` 한 회차**.
// 표면 단위 단일 날짜이고, 그 회차에 데이터가 없는 프로젝트는 빠진다(기존 `partial`
// 의미론과 같다). 종전 기본도 사실상 "최신 1회차"였다 — 루트는 `started_at` 7일
// full-cycle 창, 프로젝트는 "그 프로젝트 최신 측정 − 7일" 창의 셀당 최신 1건.
// 바뀌는 것은 **무엇을 한 회차로 보느냐**이지 "최신 하나"라는 성질이 아니다.
//
// 구성: ① 최신 회차 일치 ② 노출 시간 게이트 ③ 숨김 게이트 ④ 기본 엔진 범위.
// ②③ 은 **최신 회차를 고르는 서브쿼리 안에도** 들어간다(`anchorLatestRoundClause` 의
// `gatePreds`) — 안 그러면 아직 안 열린 회차가 기준으로 뽑혀 화면이 통째로 빈다.
function anchorSnapshotPreds(
  f: StandardFilters,
  anchorScope: SQL[],
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL[] | null {
  if (!anchorAxisKnownEnabled()) return null;
  // 최신 회차를 **고르는** 서브쿼리도 바깥 술어와 **같은 계열**이다(검증 N2).
  //
  // 종전에는 여기만 `'all'` 고정이었다. 그러면 바깥 `family` 항이 죽는다 —
  // 바깥이 `round_date = max(…'all' 게이트…)` 를 요구하므로 선택된 회차는 이미
  // `'all'` 을 통과했고, 그보다 느슨한 `'mentions'` 는 그 회차에서 항상 참이다.
  // 그래서 기간 미지정 화면에서 계열 결정이 통째로 무효였고, 인용만 숨긴 회차가
  // 최신이면 **언급 화면도 한 회차 뒤로 밀렸다**(D 가 막으려던 바로 그 손실).
  //
  // 계열이 같으므로 "기준 회차가 계열마다 갈릴 수 있다"가 계약이 된다 — 언급 화면은
  // 인용만 숨긴 최신 회차를 보고, 인용 화면은 그 앞 회차를 본다. 한 화면 안에서는
  // 카드와 드릴다운이 같은 계열을 쓰므로 갈리지 않는다(같은 빌더, N1).
  // ⚠️ 함대 게이트가 **안쪽(max 선택)에도 바깥에도** 들어간다(프리뷰 실측 2026-09-20).
  //    안쪽에 없으면 원장이 아직 발행하지 않은 회차가 기준으로 뽑히고, 그 결과 카드
  //    (원장 경로)와 미러 경로가 한 지면에서 다른 회차를 본다 — website 에서 카드 09-11
  //    vs 달력·하위 탭 09-18 로 실제로 났다.
  const gate = [
    anchorViewableSql(ANCHOR_LATEST_ALIAS),
    anchorNotHiddenKnownSql("ca2", family),
    anchorLedgerServableKnownSql("ca2"),
  ];
  const preds: SQL[] = [
    anchorLatestRoundClause(anchorScope, gate),
    anchorViewableSql(),
    anchorNotHiddenKnownSql("ca", family),
    anchorLedgerServableKnownSql("ca"),
  ];
  const engineScope = anchorDefaultEngineScope(f.engine);
  if (engineScope) preds.push(engineScope);
  return preds;
}

/** 앵커 테이블 기준의 화면 범위 술어 — 최신 회차를 고르는 `max()` 의 모수. */
function anchorScopeForProjects(projectIds: string[], alias = ANCHOR_LATEST_ALIAS): SQL[] {
  return [sql`${sql.raw(alias)}.project_id = ${uuidAnyParam(projectIds)}`];
}

/**
 * 루트(글로벌) 범위. 루트 프로젝트 id 를 주소 지정할 수 있으면 그것으로, 아니면
 * **표면**으로 좁힌다(mock·dev 처럼 루트 id 가 없는 환경). 표면 어휘는 앵커 테이블
 * 쪽 `'standard'` 다 — 원장은 같은 개념을 `'global'` 로 부른다(계약 §2).
 */
function anchorScopeForRoot(
  rootProjectId: string | null,
  alias = ANCHOR_LATEST_ALIAS,
): SQL[] {
  const a = sql.raw(alias);
  return rootProjectId
    ? [sql`${a}.project_id = ${rootProjectId}::uuid`]
    : [sql`${a}.surface = 'standard'`];
}

/**
 * **필터 옵션 창의 축 라우터** (검증 B3) — 옵션 창과 데이터 창을 1:1 로 유지한다.
 *
 * `optionWindowPredicate` 머리 주석이 못 박은 계약이 "규칙은 데이터 경로와 1:1"이고,
 * 그렇게 하지 않아 EG 가 드롭다운에 남고 고르면 빈 화면이 된 실측이 거기 적혀 있다.
 * 축 on 에서 데이터는 "노출 가능한 최신 `round_date` 한 회차"(또는 기간의 회차들)인데
 * 옵션만 "최근 7일 run 시작"으로 두면 그 계약이 반대 방향으로도 깨진다:
 *   · 옵션이 더 넓다   → 죽은 옵션(고르면 빈 화면)
 *   · 옵션이 더 좁다   → `round_date` 가 run 시작보다 미래인 배정(`basis='next_empty'`,
 *                        §9.2 실측 1건)에서 **데이터가 있는데 옵션이 없다**
 *
 * 축 off 면 `null` — 호출부가 종전 run 창 술어를 그대로 쓰고 SQL 은 바이트 동일이다.
 *
 * 루트(표준) 표면 전용이다. website·프로젝트 경로는 이미 `snapshotAnswerIds` 를 통해
 * 데이터 경로와 같은 서브쿼리를 쓰므로 여기를 타지 않는다.
 */
function optionAnchorJobClause(
  jobIdCol: SQL,
  dateRange?: { dateFrom?: string; dateTo?: string },
): SQL | null {
  if (!anchorAxisKnownEnabled()) return null;
  const f: StandardFilters = {
    dateFrom: dateRange?.dateFrom,
    dateTo: dateRange?.dateTo,
  };
  // 계열은 **가장 느슨한** `'mentions'` 를 명시한다(검증 N2 점검). 옵션은 여러
  // 계열 화면이 공유하므로 `옵션 ⊇ 데이터` 가 안전한 방향이다 — 옵션이 데이터보다
  // 좁으면 "데이터는 있는데 고를 수 없다"가 되고, 넓으면 죽은 옵션 하나가 남는다.
  const preds =
    anchorPeriodPreds(f, OPTION_HIDDEN_FAMILY) ??
    anchorSnapshotPreds(f, anchorScopeForRoot(addressableRootProjectId()), OPTION_HIDDEN_FAMILY);
  return preds ? anchorJobIdIn(jobIdCol, preds) : null;
}

/** 옵션 창의 숨김 계열 — 위 주석(옵션 ⊇ 데이터). */
const OPTION_HIDDEN_FAMILY: AnchorHiddenFamily = "mentions";

/** 같은 라우터의 **run 축** 판 — `job_id` 가 없는 표(ACR 롤업) 옵션용. */
function optionAnchorRunClause(
  runIdCol: SQL,
  dateRange?: { dateFrom?: string; dateTo?: string },
): SQL | null {
  return anchorRunClause(
    { dateFrom: dateRange?.dateFrom, dateTo: dateRange?.dateTo },
    runIdCol,
    anchorScopeForRoot(addressableRootProjectId()),
    OPTION_HIDDEN_FAMILY,
  );
}

// exported for tests (SQL 텍스트 검증) — 런타임 호출부는 이 파일 내부뿐.
// 측정 개요 카드의 "측정" 칸이 이 술어에서 나오므로, "적용" 카운트
// (catalogPromptCountWhere)와 같은 카탈로그 컬럼을 보는지 테스트가 대조한다.
// 표면별 lang 라우팅이 세 술어 빌더(answerWhere · detailAnswerWhere ·
// snapshotRunFilter)에서 갈라지지 않는지 한 테스트가 셋을 동시에 본다
// (2026-08-25 사고: 셋 중 하나만 축을 빠뜨려 드릴다운이 필터를 무시했다).
export function answerWhere(
  f: StandardFilters,
  projectCtx?: string | string[],
  opts: {
    allRuns?: boolean;
    recentDays?: number;
    /** 숨김 게이트 계열(검증 D·후속). 생략 = `DEFAULT_HIDDEN_FAMILY`. */
    hiddenFamily?: AnchorHiddenFamily;
    /**
     * 호출부가 `trendWindowFloor()`(= `round_date >= 오늘 − TREND_WINDOW_DAYS`)를
     * **자기 문장에 반드시 얹는가**. 참이면 dim semi-join 안쪽도 같은 바닥으로 좁힌다
     * (성능). 바깥이 안 거는데 참으로 넘기면 셀이 조용히 빠진다 — `trendRoundFloorSql`.
     */
    trendRoundFloor?: boolean;
    /**
     * 이 문장이 **이미 `ca`(앵커)와 `d`(dim 파생표)를 조인했는가**. 참이면 dim 술어가
     * semi-join 없이 조인된 컬럼을 그대로 본다. 호출부는 `AnswerSetBudget.join` 에
     * `anchorJoinSql(...)` **와** `trendDimJoinSql()` 을 함께 넣어야 한다.
     */
    caJoined?: boolean;
  } = {},
): SQL {
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  // dim 경로에서 루트 프로젝트 한정을 **미뤄 둔** 상태인가(아래 병합 직전에 판정).
  let rootCatalogScopeDeferred = false;
  // Per-prompt catalog axis (brand / list_type / depth* / brandPresence)
  // predicates — accumulated and merged into ONE `a.prompt_id IN (SELECT …
  // FROM prompts WHERE …)` subquery at the end (root path folds the 705
  // catalog gate into the same subquery). 2026-07-22: stacking each axis as
  // its own IN-subquery alongside the gate made the planner pick a
  // catastrophic plan on the full-history trend joins (readMention/Citation
  // DayCounts) — brandPresence+gate went 120s+ statement-timeout; one merged
  // semi-join runs in ~3s. `col` is a fixed literal (never user input).
  const catalogPreds: SQL[] = [];
  const catalogIn = (col: string, vals: string[]) =>
    catalogPreds.push(sql`${sql.raw(col)} IN (${inList(vals)})`);
  const conds: SQL[] = [
    sql`a.status = 'completed'`,
    bulkMirrorRunVisibleSqlKnown(sql`a.run_id`),
  ];

  // 2026-07-02 의미론 확정: 기간 필터 = "기간 내 최신 배치/런" (기간말 시점의
  // 스냅샷). 이전의 "기간 → 기간 내 모든 런 합산"은 필터를 켜는 순간 숫자의
  // 단위(시점 상태 → 누적 flow)가 바뀌는 혼선이 있어 폐기. 기간 동안의 변화는
  // 추이(allRuns) 읽기가 전담한다. 스냅샷 모드에서는 런 윈도 선택에 날짜 상·하한을
  // 걸고(measured_at 클리핑 없음 — 배치는 원자 단위), allRuns(추이)에서만
  // measured_at 범위로 행을 좁힌다.
  // 2026-09-04 기획 수정: 답변분석(Mention·Citation) 화면은 filters.cumulative
  // 로 "기간 내 누적"을 요청한다 — 배치 선택(스냅샷) 대신 추이 읽기와 같은
  // 경로(런 전체 + measured_at 범위 클리핑)를 타면 그것이 곧 누적이다.
  // 2026-09-16 제품 확정: 그 누적은 **기간이 걸렸을 때만**이다. 판정 정본은
  // `cumulativeMode` 한 곳 — 머리 주석에 세 조건의 근거와 실측이 있다.
  const cumulative = cumulativeMode(f, opts.allRuns);
  const allRuns = opts.allRuns === true || cumulative;

  const projectIds = Array.isArray(projectCtx)
    ? projectCtx
    : projectCtx
      ? [projectCtx]
      : [];

  // 앵커 축(옵트인) — 기간이 걸렸으면 run 창 대신 **회차 귀속 날짜**로 건다.
  // `null` 이면(축 off 또는 기간 없음) 추이 경로는 종전 창을 그대로 쓴다.
  const hiddenFamily = opts.hiddenFamily ?? DEFAULT_HIDDEN_FAMILY;
  const anchorPeriod = anchorPeriodClause(f, sql`a.job_id`, hiddenFamily);
  // 축이 켜져 있으면 **기간이 없어도** 스냅샷 경로는 앵커 축이다(= 최신 회차 하나).
  // 추이(allRuns)는 자기 창이 있어 대상이 아니다.
  const anchorOn = anchorAxisKnownEnabled();

  if (projectIds.length >= 1) {
    // Per-project (website: one project per brand×country, or a single project
    // when narrowed to one). "가장 최근 run 1개"는 그 run의 소수 job만 세고
    // (2026-07-05), "가장 최근 배치일(day) 전체"는 여러 날에 걸쳐 트리클되는
    // 측정에서 어제 다 끝난 프롬프트를 오늘의 미완료 day가 가려버린다(2026-07-06,
    // 100개 중 34개만 보임). prompt+engine 쌍별 최신 완료 답변을 쓴다.
    if (anchorOn && opts.allRuns !== true) {
      // 스냅샷 경로(기간 유무 무관) — 기간이 있으면 그 회차들, 없으면 최신 회차 하나.
      // 기간 술어는 **dedup 서브쿼리 안**에 있다. 밖에 한 번 더 걸면 같은 집합을
      // 세미조인으로 두 번 도는 낭비다(`job_id` PK 라 항등).
      //
      // ⚠️ **`snapshotAnswerIds` 한 빌더를 쓴다**(검증 N1). 카드(`answerWhere`)·
      // 상세(`detailAnswerWhere`)·드릴다운(`snapshotRunFilter`) 셋이 각자 서브쿼리를
      // 조립하면 조건 하나가 갈리는 순간 모수가 갈린다 — N1 이 정확히 그 형태였다
      // (상세만 dedup 없이 회차 안 재측정을 전부 계상). 이제 세 경로가 **같은 함수**를
      // 부르므로 구조적으로 갈릴 수 없다.
      conds.push(sql`a.job_id IN ${snapshotAnswerIds(projectIds, f, hiddenFamily)}`);
    } else if (anchorPeriod) {
      // 추이는 버킷이 따로 있고 버킷 안에서 dedup 한다 — 여기서 회차 dedup 을
      // 또 걸면 이중이다. 창만 앵커 축으로 바꾼다.
      conds.push(
        sql`a.run_id IN (SELECT run_id FROM scope_runs WHERE project_id = ${uuidAnyParam(projectIds)})`,
        anchorPeriod,
      );
    } else {
    conds.push(
      allRuns
        ? cumulative
          // 누적 = 기간에 걸치는 **회차 앵커** 전부 (cumulativeRunWindow 머리 주석).
          ? cumulativeRunWindow(f, sql`a.run_id`, sql`a.measured_at`, sql`project_id = ${uuidAnyParam(projectIds)}`)
          // 추이(opts.allRuns)는 자기 창을 쓰고 버킷이 measured_at 이라 종전 그대로.
          : sql`a.run_id IN (SELECT run_id FROM scope_runs WHERE project_id = ${uuidAnyParam(projectIds)})`
        : sql`a.job_id IN ${perProjectLatestAnswerIds(projectIds, f)}`,
    );
    }
  } else {
    // Standard (root) view, no explicit projectCtx. Every other scope project
    // (per-market website projects, brand PoCs, …) fires its own runs too, and
    // those can land on the same calendar day as the root's batch — without a
    // project_id restriction here, their answers silently leak into the 표준
    // aggregate (found 2026-07-03: 18 unrelated website/PoC projects summed
    // into what should have been root-only numbers). Scope to the root project
    // whenever it's addressable; dev/mock leaves this unrestricted since the
    // mock placeholder id is never actually stored on scope_runs.project_id.
    // 루트 식별·스코프 술어는 `lib/surface/run-surface.ts` 가 정본이다 — 같은 삼항이
    // 이 파일 안에만 네 벌 있었다(여기·snapshotAnswerIds·detailAllRunsWindowPreds·acrWhere).
    const rootProjectId = addressableRootProjectId();
    const rootScope = rootRunScopeSql("", rootProjectId);
    const rootScopeR = rootRunScopeSql("r.", rootProjectId);
    // 2026-07-07: root used to snap to a single calendar day (it fires many
    // small parallel sub-runs continuously rather than one atomic batch), so
    // a day only ever showed a fraction of the catalog (2026-07-03: 391/705).
    // Now a job_id filter on (prompt, engine, region) instead of a run_id/day
    // filter — rootFullCycleAnswerIds only counts a prompt once ALL of its own
    // cells (varies per prompt: 6 or 12 depending on region rollout) refresh
    // inside the window, so a mid-refresh prompt never shows a blend of this
    // cycle's + the previous cycle's cells (2026-07-07 feedback: "이번 주기의
    // 답변 합, 누적 합 아님"). Without an explicit date filter, default to a
    // 7-day trailing window — the root catalog fully cycles in ~3 days
    // (2026-07-07 measured), so 7 days safely covers a whole cycle without
    // ever double-counting a cell (still exactly one row per prompt×engine
    // ×region no matter how many times it was re-measured inside the window).
    const rootWindowPredicate = f.dateFrom || f.dateTo
      ? dateBoundPredicate(f)
      : sql`r.started_at >= now() - interval '7 days'`;
    if (anchorOn && opts.allRuns !== true) {
      // 앵커 축에서는 **full-cycle 게이트가 불필요**하다. 그 게이트(`rootFullCycleAnswerIds`)
      // 는 "창 안에서 그 프롬프트의 셀이 전부 갱신됐는가" 로 반쪽 주기 혼입을 막던
      // 대용물인데, 앵커 축은 회차가 **통째로** 들어오거나 나가므로(계약 §3) 반쪽
      // 주기라는 상태 자체가 없다. 대신 회차마다 셀당 대표 1건을 고른다.
      // 기간이 없으면 그 "회차"는 노출 가능한 최신 `round_date` 하나다.
      // 루트도 같은 빌더다(위 프로젝트 분기의 ⚠️). 지역 스코핑 2종과 숨김 지역은
      // `snapshotAnswerIds` 루트 경로가 서브쿼리 **안**에서 건다 — 그래서 아래
      // 바깥 `HIDDEN_STANDARD_REGIONS` 푸시는 이 분기에서 생략한다(두 벌 방지).
      conds.push(sql`a.job_id IN ${snapshotAnswerIds(undefined, f, hiddenFamily)}`);
    } else if (anchorPeriod) {
      conds.push(
        sql`a.run_id IN (SELECT run_id FROM scope_runs WHERE ${rootScope})`,
        anchorPeriod,
      );
    } else
    conds.push(
      allRuns
        ? cumulative
          ? cumulativeRunWindow(f, sql`a.run_id`, sql`a.measured_at`, rootScope)
          : sql`a.run_id IN (SELECT run_id FROM scope_runs WHERE ${rootScope})`
        : sql`a.job_id IN ${rootFullCycleAnswerIds(rootScopeR, rootWindowPredicate)}`,
    );
    // PR④ — **추이만** 사실표와 모수를 맞춘다(`trendAlignedRootPreds` 머리 주석).
    //   · 스냅샷(`allRuns` 아님)은 이미 `snapshotAnswerIds`·`rootFullCycleAnswerIds` 가
    //     같은 술어를 걸고 있다 — 여기서 또 걸면 두 벌이다.
    //   · 누적(`cumulative`)은 이 PR 의 범위가 아니다(설계 §9-2 는 ④를 추이로 한정).
    //   · 함대 게이트는 `anchorPeriod` 가 이미 걸었으면 생략한다(같은 술어 두 번 금지).
    if (allRuns && !cumulative) {
      conds.push(
        ...trendAlignedRootPreds(
          sql`a.job_id`,
          !anchorPeriod,
          trendRoundFloorSql(f, opts),
          opts.caJoined === true,
        ),
      );
    }
    // 숨김 지역(신규 편입 부분 데이터) 제외 — 표준 루트 경로 한정. 웹사이트/
    // 프로젝트 분기에는 걸지 않는다(CA를 정식 측정하는 프로젝트 존재).
    // 앵커 스냅샷 분기는 `snapshotAnswerIds` 가 서브쿼리 안에서 이미 걸었다(위 주석).
    if (HIDDEN_STANDARD_REGIONS.length && !(anchorOn && opts.allRuns !== true)) {
      conds.push(
        sql`a.region NOT IN (${inList([...HIDDEN_STANDARD_REGIONS])})`,
      );
    }
    // 표준 = 705 카탈로그 게이트 (allRuns 추이·스냅샷 공통) — 카탈로그 축 술어와
    // 하나의 서브쿼리로 병합되도록 predicate로 쌓는다(함수 머리 주석 참조).
    // ⚠️ dim 스냅샷 경로에서는 **멤버십 게이트로는** 걸지 않는다(`trendDimPathActive`).
    //    다만 카탈로그 **축 필터**(brand·depth·list_type·funnel·brandPresence)가 붙으면
    //    그 조회는 루트 프로젝트 행만 봐야 한다 — 아래 병합 직전에 되돌려 넣는다.
    if (!trendDimPathActive(allRuns === true, cumulative === true)) {
      catalogPreds.push(sql`project_id = ${STANDARD_ROOT_PROJECT_ID}`);
    } else {
      rootCatalogScopeDeferred = true;
    }
  }
  // 추이(allRuns) 읽기만 measured_at 범위로 행을 좁힌다 (inclusive 하루 단위;
  // measured_at 없는 답변은 활성 기간 필터에서 제외 — 인메모리 정책과 동일).
  // 스냅샷 모드는 위에서 배치 선택에 날짜를 걸었으므로 행 클리핑을 하지 않는다
  // (자정 경계에 걸친 배치가 반토막 나는 것을 막는다).
  //
  // ⚠️ 누적(cumulative)은 **제외** — 위 `cumulativeRunWindow` 가 이미 기간을
  // **회차 앵커**로 걸었다(2026-09-16 축 이동). 여기서 measured_at 을 또 자르면
  // 회차 안에서 다음 날로 이월된 측정(90일 27.0%)이 잘려 "회차 전부"가 깨진다.
  // 추이는 버킷 자체가 measured_at 이라 종전 축을 유지한다.
  // ⚠️ 앵커 축이 기간을 이미 `ca.round_date` 로 걸었으면(위 `anchorPeriod`) **여기서
  // 또 자르지 않는다** — 회차의 꼬리 측정이 다음 날로 이월되는 것이 상시 현상이라
  // (라이브 90일 27.0%) measured_at 으로 다시 자르면 "회차 통째로"가 깨진다.
  if (allRuns && !cumulative && !anchorPeriod) {
    conds.push(...periodBounds(f, answerMeasuredAxis(sql`a.measured_at`)));
  }
  // (종전의 "누적인데 기간 미지정 → 기본 7일 창" 분기는 제거했다 — `cumulativeMode`
  //  가 기간 없는 누적을 아예 만들지 않으므로 도달 불가능하다. 머리 주석 참조.)
  if (f.region?.length) conds.push(sql`a.region IN (${inList(f.region)})`);
  if (f.engine?.length) conds.push(sql`a.target IN (${inList(f.engine)})`);
  if (f.funnelStage?.length) {
    // 2026-06-10 (D6): HMG 3-stage Korean vocab is canonical
    // (인지/탐색 · 비교/검증 · 구매/사후관리). The prompts catalog stores it
    // verbatim; scope's legacy 5-stage values on scope_prompts.funnel_stage
    // are no longer used by the filter — catalog.funnel_stage is the join.
    catalogIn("funnel_stage", f.funnelStage);
  }
  if (f.brand?.length) catalogIn("brand", f.brand);
  // brandPresence — 프롬프트 문구의 브랜드 포함 여부(brandPresencePredicate 참조).
  if (f.brandPresence?.length) {
    const pred = brandPresencePredicate(f.brandPresence);
    if (pred) catalogPreds.push(pred);
  }
  if (f.listType?.length) catalogIn("list_type", f.listType);
  if (f.depth1?.length) catalogIn("depth1", f.depth1);
  if (f.depth2?.length) catalogIn("depth2", f.depth2);
  if (f.depth3?.length) catalogIn("depth3", f.depth3);
  // 위에서 쌓인 카탈로그 축 + (루트) 705 게이트를 단일 semi-join으로 병합.
  // 카탈로그 **축 필터**가 하나라도 있으면 루트 한정을 되살린다(검증자 주장 2).
  // 없으면(기본 화면) 순수 멤버십 게이트뿐이라 dim 이 쥔다 — 그것이 소급 제외의 원인이다.
  // `unshift` 인 이유: 종전과 **같은 순서**(루트가 맨 앞)를 유지한다.
  //
  // ⚠️ **알려진 한계 — 필터를 걸면 이중 게이트가 부활한다**(2026-09-20 2차 검증 §2).
  //    필터가 있는 문장에는 현재값 루트 멤버십(`project_id = ROOT`)과 dim 스냅샷 게이트
  //    (`d.in_root_catalog` / `dim_small`)가 **함께** 걸린다. 그래서 회차 생성 뒤 루트
  //    카탈로그에서 빠진 프롬프트는 **필터 뷰에서만** 소급 제외되고, "브랜드 전체 선택"과
  //    "필터 없음"의 분모가 갈릴 수 있다.
  //    구조적 원인: 필터 값(`brand`·`depth*`·`list_type`·`funnel_stage`·`brand_presence`)은
  //    `prompts` 에만 있고 `summary_prompt_dim` 스냅샷에는 없다 — 회차 시점 값으로
  //    판정할 방법이 지금은 없다. 닫으려면 dim 에 그 컬럼들을 얹어야 하고 이 PR 범위 밖이다.
  //    현재 영향 **0** (메인 미러 실측 2026-09-20: 회차 생성 이후 루트에서 빠진 프롬프트 0행).
  //    대조 감사 후보: `summary_prompt_dim.in_root_catalog = 1` 인데 지금 `prompts` 에
  //    루트로 없는 행 수를 회차별로 세어 0 이 아니면 경고.
  if (rootCatalogScopeDeferred && catalogPreds.length) {
    catalogPreds.unshift(sql`project_id = ${STANDARD_ROOT_PROJECT_ID}`);
  }
  if (catalogPreds.length) {
    conds.push(
      sql`a.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE ${sql.join(catalogPreds, sql` AND `)} AND scope_prompt_id IS NOT NULL)`,
    );
  }
  // 프로젝트 커스텀 필드 필터 (project_custom_fields, 2026-07-06) — 표준/웹사이트
  // 경로는 이 값을 채우는 UI가 없어 항상 undefined라 여기 도달 안 함. 필드마다
  // AND로 결합(위 brand/depth1과 동일한 결합 지점).
  if (f.customFieldFilters) {
    for (const [fieldId, values] of Object.entries(f.customFieldFilters)) {
      if (!values.length) continue;
      // 같은 태그 안에서는 OR(IN), 태그 간에는 AND(각 fieldId가 별도 conds).
      const valList = sql.join(values.map((v) => sql`${v}`), sql`, `);
      conds.push(sql`a.prompt_id IN (
        SELECT p.scope_prompt_id FROM prompts p
        JOIN prompt_custom_field_values v ON v.prompt_id = p.id
        WHERE v.field_id = ${fieldId}::uuid AND v.value IN (${valList})
          AND p.scope_prompt_id IS NOT NULL
      )`);
    }
  }
  // 프롬프트 속성 축(lang·websiteCountry) — 정본은 promptAxisPreds.
  // lang 은 표면별로 판정 컬럼이 갈린다(project=website_prompts.lang_code /
  // standard=scope_prompts.lang) — 그 함수의 머리 주석 참조. websiteCountry 는
  // website_sites.country_code 기준으로 standard 의 scope_answers.region 과 다르다
  // (worldwide→KR 같은 가상 코드 때문) — 표준 표면은 이 축을 보내지 않는다.
  conds.push(
    ...promptAxisPreds(f, sql`a.prompt_id`, projectIds.length >= 1 ? "project" : "standard"),
  );
  return sql.join(conds, sql` AND `);
}

// ── 답변셋 1회 확정 (2026-08-27 대시보드 콜드 로드 타임아웃 수정) ─────────────
// 표준 스냅샷/Sub KPI/추이 집계는 한 호출에서 4~6개 문장을 순차 실행하는데,
// 종전에는 문장마다 answerWhere(W — full-cycle 게이트·카탈로그 semi-join 포함)를
// 통째로 다시 박아 (a) 같은 무거운 서브쿼리를 문장 수만큼 재계산했고 (b) mention/
// citation 조인과 결합될 때 플래너가 플랜을 붕괴시킬 여지를 문장마다 다시 열었다
// (statement timeout 57014 계열 — readMentionBrandDayCounts MATERIALIZED·KPI⑤
// owned-clause 와 동일 교훈; 콜드 로드 실측 admin 무필터 직렬 합 ~70s → 첫 조회
// 실패·재조회는 그 사이 채워진 캐시로 즉시 성공하는 증상의 원인).
// 트랜잭션-로컬 TEMP 테이블로 필터된 답변셋을 딱 1회 계산해 두고 모든 문장이 그
// 집합만 조인한다. ON COMMIT DROP 이라 커밋 시 자동 소멸하고, TEMP 테이블은
// 세션(=트랜잭션이 예약한 커넥션) 스코프라 동시 요청과 충돌하지 않는다(Supabase
// transaction-mode pooler 에서도 트랜잭션 안에서는 안전). ANALYZE 로 플래너가
// 실측 행수를 알게 해 기본 추정에 의한 nested-loop 폭주를 막는다.
type MirrorTx = Pick<ReturnType<typeof getDb>, "execute">;
// 버려진 트랜잭션이 스스로 죽게 하는 상한. 2026-08-27 프로덕션 실측: 이
// 트랜잭션이 `idle in transaction` 으로 **215~346초** 방치된 세션이 여러 개
// 관측됐고(마지막 쿼리 = CREATE TEMP TABLE _answer_set / c2 … JOIN _answer_set,
// application_name=Supavisor, wait_event=ClientRead), 그동안 scope_answers·
// scope_prompts 에 AccessShareLock 을 쥐고 있어 마이그레이션 0046 의
// `ALTER TABLE … ADD COLUMN` 이 55P03(lock timeout)으로 거부됐다.
// 서버 기본값 `idle_in_transaction_session_timeout = 0`(무제한)이라 아무도
// 수거하지 않는다 — 락 차단뿐 아니라 xmin 고정(vacuum 방해)·풀러 서버 커넥션
// 점유가 함께 따라온다.
//
// `SET LOCAL` 이라 커밋/롤백 시 자동 해제되고, transaction-mode 풀러에서도 이
// 트랜잭션이 점유한 서버 커넥션에만 적용된다(다른 요청에 새지 않는다).
// 30초는 문장 사이 JS 구간(행 매핑)의 상한이지 쿼리 실행 시간이 아니다 —
// 쿼리 자체는 서버 `statement_timeout`(현재 120s)이 이미 덮는다. 그래서 여기서
// statement_timeout 은 건드리지 않는다(무관한 동작 변경 금지).
const ANSWER_SET_IDLE_TX_TIMEOUT = "30s";

/**
 * 답변셋 트랜잭션의 실행 예산 — 두 값의 **의미가 다르다**(2026-09-01 재검증 C1).
 *
 * 종전에 `timeoutMs` 하나만 두고 "이 값을 넘지 않는다"고 적었던 것은 거짓이었다:
 * `statement_timeout` 은 **문장당**이고 이 트랜잭션은 문장을 여러 개 발행한다
 * (`CREATE TEMP TABLE` + `ANALYZE` + fn 의 분석 쿼리들). 8s 를 주면 6~7문장짜리
 * 단계의 최악은 8s 가 아니라 48~56s 다 (2026-09-01 실측: 스냅샷 6문장·추이 7문장).
 *
 * 그래서 상한을 둘로 나눈다:
 *   - `statementTimeoutMs` — 문장 하나가 붙잡을 수 있는 시간(진짜 statement_timeout).
 *   - `deadlineAt` — 이 트랜잭션 전체의 벽시계 마감(epoch ms). **문장을 보내기 전마다**
 *     확인해 이미 지났으면 즉시 던진다(진행 중 문장을 취소하지는 못한다).
 *
 * 실효 최악 = (deadlineAt 까지 남은 시간) + statementTimeoutMs. 마지막으로 보낸
 * 문장 하나는 끝까지 기다려야 하기 때문이다. 이 한 줄이 정직한 상한이고,
 * 호출부 jsdoc 도 이 식으로 적어야 한다.
 *
 * 둘 다 생략하면 종전 동작 그대로(세션 기본 timeout, 마감 없음).
 */
export interface AnswerSetBudget {
  statementTimeoutMs?: number;
  deadlineAt?: number;
  // 버킷별 스냅샷(2026-09-01, main #160) — 추이 읽기가 버킷 안에서 셀(프롬프트×
  // 엔진×지역)당 최신 답변 1개만 남기기 위한 DISTINCT ON. `on` 과 `order` 는 한
  // 세트로 준다(Postgres 는 ORDER BY 선두가 DISTINCT ON 식과 일치할 것을 요구).
  // 미지정이면 종전대로 전 행을 담는다.
  //
  // ⚠️ 예산(statementTimeoutMs/deadlineAt)과 **같은 객체**에 둔 이유: 둘을 별도
  // 위치 인자로 두면 호출부가 4번째 자리에 무엇을 넘겼는지에 따라 조용히 다른
  // 뜻이 된다(dedupe 객체가 예산으로 해석돼도 타입이 통과할 수 있다). 한 객체로
  // 합치면 그 오해석 자체가 불가능하다.
  dedupe?: { on: SQL; order: SQL };
  // 답변셋 생성 문장의 `FROM scope_answers a` **바로 뒤**에 붙는 조인 조각(2026-09-18).
  //
  // 왜 필요한가: 4-KPI 탭 추이의 주 격자 키가 원장 회차 주(`trendWeekKey("cycle")`)가
  // 되면 `cols` 가 그 조인이 만드는 컬럼(`_cw.cycle_week`)을 참조한다. 버킷 계산이
  // **답변셋 생성 문장 안**에 있으므로(아래 `kpiTabTrendCols`) 조인도 같은 자리여야 한다.
  //
  // 미지정이면 빈 SQL 이라 문장 텍스트가 종전과 **문자 그대로** 같다
  // (`scope-aggregates.kpi-trend-week.sql.test.ts` 가 그 동일성을 고정한다).
  //
  // 글로벌 표면의 측정 폴백 주 키(`mirrorWeekKey("anchorKst")`, 2026-09-28 main #300)도
  // run 의 회차 앵커를 읽으므로 같은 자리를 쓴다. 조각은 행을 불리지 않아야 한다
  // (1:1 PK·UNIQUE 조인만) — 답변셋 모수가 곧 집계 모수다.
  join?: SQL;
}

export class AnswerSetDeadlineError extends Error {
  constructor(label: string) {
    super(`answer-set budget exhausted before ${label}`);
    this.name = "AnswerSetDeadlineError";
  }
}

// ── 측정 기준일(asOf) 정본 (2026-09-09, PR① B5) ─────────────────────────────
// **회차(cycle) 기준**. 종전 `max(a.measured_at)` 은 회차의 꼬리 측정 시각을 집어,
// 앵커 8/31 회차가 9/1 15:30 까지 이어지면 화면에 "2026-09-01" 이 떴다(2026-09-05
// 실측, 루트 be28fe15). 측정 이월은 상시 현상이라(8/1 이후 `measured_at ≠
// cycle_anchor_at` 인 답변 59,527건) 예외 처리가 아니라 기준 자체를 회차로 옮긴다.
//
// COALESCE 폴백: scope 의 measurements API 가 `cycle_anchor_at` 을 아직 다 싣지
// 않아 미러 컬럼(0058)이 NULL 인 동안은 종전과 동일하게 동작하고, 값이 실리면
// 코드 변경 없이 회차 기준으로 전환된다.
//
// **식을 상수 하나로 둔 이유**: 인용 화면은 회차 기준, 언급 화면은 `max(measured_at)`
// 이라 같은 요청·같은 필터에서 두 탭의 "측정 기준일"이 서로 달랐다. 화면마다 식을
// 복제하면 다시 갈라진다 — 소비처는 이 상수를 쓰고, 쓰는 문장은 반드시
// `LEFT JOIN scope_runs r ON r.run_id = a.run_id` 를 갖는다.
// (행 단위 회차 기준일은 `COALESCE(r.cycle_anchor_at, a.measured_at)` 그대로 —
//  지역별 asOf 롤업이 그 형태를 쓴다.)
const CYCLE_AS_OF_ROW_SQL = sql`COALESCE(r.cycle_anchor_at, a.measured_at)`;

/**
 * 측정 기준일의 **행 단위** 축 라우터. 집계 전 값이 필요한 자리(지역별 롤업의 CTE)가
 * 쓴다. 아래 `cycleAsOfSql()` 이 이 식을 `max()` 로 감싼 것이므로 **정의는 하나**다 —
 * 두 벌로 두면 한쪽만 축이 바뀌어 같은 화면의 기준일이 갈린다(이 전환 전에 실제로
 * 그랬다: 대시보드 pill 은 run 앵커, 언급·인용은 `round_date`).
 */
function cycleAsOfRowSql(): SQL {
  return anchorAxisKnownEnabled() ? anchorRoundDateSql() : CYCLE_AS_OF_ROW_SQL;
}

/**
 * 측정 기준일의 **축 라우터**(계약 §3: 측정 기준일 = `max(ca.round_date)`).
 *
 * 앵커 축에서 `COALESCE(r.cycle_anchor_at, a.measured_at)` 를 그대로 두면 안 된다 —
 * 그 값은 run 앵커(UTC timestamptz)라 달력에서 고른 날짜(`round_date`, KST date)와
 * **하루 어긋날 수 있고**(회차 1,033 중 209개가 UTC↔KST 로 날짜가 갈린다), §9.2 의
 * 정규 요일 귀속을 통과하지 않은 날짜다. 같은 화면에서 "기간"과 "기준일"이 다른
 * 시계를 보는 것이 이 전환이 없애려는 결함이다.
 *
 * 이 식을 쓰는 문장은 앵커 축에서 `ca` 조인을 함께 가져야 한다(아래 `anchorAsOfJoinSql`).
 */
function cycleAsOfSql(): SQL {
  return sql`max(${cycleAsOfRowSql()})`;
}

/**
 * 같은 값을 **화면이 그대로 쓰는 텍스트**로 낸다 — 앵커 축이면 `YYYY-MM-DD`.
 *
 * 왜 SQL 에서 자르는가: raw `db.execute` 는 drizzle 컬럼 매퍼를 안 타고 postgres.js
 * 기본 파서를 타는데, `date`(OID 1082)도 `new Date(x)` 로 파싱된다
 * (`node_modules/postgres/src/types.js`). 그러면 JS 가 다시 `toISOString()` 해서
 * `2026-09-04T00:00:00.000Z` 라는 **없는 시각**이 붙고, JS 롤업 경로가 내는
 * `2026-09-04` 와 같은 필드의 형식이 갈린다(계약 §3 "축 안에서는 형식이 균일하다").
 *
 * 종전 축에서는 **감싸지 않는다** — 문장이 바이트 단위로 같아야 한다.
 */
function cycleAsOfDisplaySql(): SQL {
  return anchorAxisKnownEnabled()
    ? sql`to_char(max(${anchorRoundDateSql()}), 'YYYY-MM-DD')`
    : sql`max(${CYCLE_AS_OF_ROW_SQL})`;
}

/**
 * 측정 기준일을 읽기 위한 `ca` 조인 — **값 투영 전용이라 LEFT 다.**
 *
 * `anchorJoinSql` 이 INNER 인 것은 그 조인이 **기간 술어를 거는 자리**이기 때문이다
 * (앵커 없는 답변을 통과시키면 기간이 샌다). 여기는 반대로 모집단이 이미
 * `_answer_set`(= `answerWhere` 의 앵커 semi-join 통과분)으로 **확정된 뒤**이고,
 * 조인의 용도는 `round_date` 를 꺼내는 것 하나다. INNER 로 두면 앵커 행이 없는
 * 답변이 `count(*)`·tracked 에서 **조용히 빠져** KPI 분모가 바뀐다 — 기준일 하나를
 * 고치려다 수치를 흔드는 것이라 값이 사라지는 방향으로도 허용하지 않는다.
 * `job_id` 가 PK 라 LEFT 여도 행이 불어나지 않고, 앵커가 없으면 `round_date` 가
 * NULL 이라 `max()` 가 알아서 무시한다.
 */
function anchorAsOfJoinSql(jobIdCol: SQL): SQL {
  return anchorAxisKnownEnabled()
    ? sql` LEFT JOIN ${sql.raw(ANCHOR_TABLE)} ${sql.raw(ANCHOR_ALIAS)} ON ${sql.raw(ANCHOR_ALIAS)}.job_id = ${jobIdCol}`
    : sql``;
}

/** 측정 기준일 원시값 → 화면 계약 문자열. 날짜(`YYYY-MM-DD`)면 그대로, 시각이면 ISO. */
const AS_OF_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function normalizeAsOf(raw: Date | string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === "string" && AS_OF_DATE_ONLY.test(raw)) return raw;
  return raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString();
}

/**
 * 트랜잭션 밖에서 도는 미러 집계에 **문장 상한 + 벽시계 마감**을 건다 (E-2).
 *
 * `withAnswerSet` 은 TEMP TABLE 경로라 이미 트랜잭션이고 거기 `SET LOCAL` 을 걸 수
 * 있다. 그런데 `aggregateCitationsFromMirror` 처럼 **`Promise.all` 로 독립 문장을
 * 병렬 발행**하는 집계는 트랜잭션이 없다 — 하나로 묶으면 한 커넥션에 직렬화되어
 * 정상 경로가 느려진다. 그래서 문장마다 **자기 트랜잭션**을 열어 `SET LOCAL
 * statement_timeout` 을 걸고 그 안에서 원 문장을 보낸다. 병렬성은 그대로다.
 *
 * ⚠️ `SET LOCAL` 이어야 한다. transaction-mode 풀러(Supavisor 6543)에서 맨
 *    `SET statement_timeout` 은 커넥션에 남아 **다음 요청으로 샌다**.
 *
 * 대가는 문장당 왕복 2회(BEGIN+SET, COMMIT)다. 25초짜리 집계에 문장 10개면 왕복이
 * 수십 ms 늘지만, 막는 것은 **함수 120s 초과로 HTML 이 절단되는 것**이다
 * (2026-09-10 T12 실측: `/ko/standard/answer-analysis/citation` 1,519 KB → 319 KB,
 * Vercel `Task timed out after 120 seconds` 2회).
 *
 * 실효 최악 = (deadlineAt 까지 남은 시간) + statementTimeoutMs — `withAnswerSet` 과
 * 같은 식이다. 진행 중 문장은 취소하지 못한다.
 *
 * 둘 다 없으면 **원본 db 를 그대로 돌려준다**(왕복 증가 0, 종전 동작 그대로).
 */
export function budgetedMirrorDb(
  db: ReturnType<typeof getDb>,
  budget: AnswerSetBudget | undefined,
): MirrorTx {
  const statementTimeoutMs = budget?.statementTimeoutMs;
  const deadlineAt = budget?.deadlineAt;
  if (!statementTimeoutMs && !deadlineAt) return db;
  // 캐스트가 필요한 이유: drizzle 의 `execute` 는 `PgRaw`(thenable)를 돌려주는 제네릭이고
  // `transaction` 은 평범한 Promise 를 돌려준다. 호출부는 전부 `await` 하므로 실질 형태
  // (행 배열)는 같지만 타입은 다르다 — `withAnswerSet` 의 `guarded` 는 tx.execute 를
  // 그대로 되돌려주므로 이 문제가 없었다.
  const execute = (q: Parameters<MirrorTx["execute"]>[0]) => {
    if (deadlineAt && Date.now() >= deadlineAt) {
      throw new AnswerSetDeadlineError("mirror statement");
    }
    return db.transaction(async (tx) => {
      if (statementTimeoutMs && statementTimeoutMs > 0) {
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`),
        );
      }
      return tx.execute(q);
    });
  };
  return { execute } as unknown as MirrorTx;
}

/** `budgetedReader` 가 넘겨주는 읽기 핸들 — drizzle 쿼리 빌더도 쓸 수 있어야 한다. */
type MirrorReader = Pick<ReturnType<typeof getDb>, "select" | "execute">;

/**
 * **쿼리 빌더**(`db.select()…`)로 읽는 집계에 예산을 거는 판 (PR③).
 *
 * `budgetedMirrorDb` 는 `execute` 만 감싸므로 `db.select()` 경로(미러 JS 집계의 답변·언급
 * 행 로드)에는 못 쓴다. 그래서 이 헬퍼가 **읽기 단위로 자기 트랜잭션**을 열고
 * `SET LOCAL statement_timeout` 을 건 뒤 그 안의 핸들을 넘긴다 — 읽기끼리는 서로 다른
 * 트랜잭션이라 `Promise.all` 병렬성이 그대로다(하나로 묶으면 한 커넥션에 직렬화된다).
 *
 * ⚠️ **서버 실행도 전송도 취소하지는 못한다.** `statement_timeout` 은 서버가 결과를
 *    만들 때까지만 세고, 마감은 아래 `raceDeadline` 로 **기다리기를 포기**할 뿐이다 —
 *    버려진 read 의 커넥션은 그 문장이 끝날 때까지 계속 잡혀 있다. 2026-09-10 실측에서
 *    프로젝트 언급 JS 경로의 최장 문장은 서버 1.5 s · 왕복 47 s(전 언급 행 로드)였다.
 *    그래도 포기가 낫다: 대안은 그 지면이 함수 상한 120 s 를 넘겨 **HTML 이 절단**되는 것이다.
 */
async function budgetedReader<T>(
  budget: AnswerSetBudget | undefined,
  label: string,
  run: (db: MirrorReader) => Promise<T>,
): Promise<T> {
  const statementTimeoutMs = budget?.statementTimeoutMs;
  const deadlineAt = budget?.deadlineAt;
  if (!statementTimeoutMs && !deadlineAt) return run(getDb());
  if (statementTimeoutMs === undefined) {
    // 문장 상한이 없는 프로파일(`mentionsJs`)은 트랜잭션을 열 이유가 없다 —
    // `SET LOCAL` 이 없으면 BEGIN/COMMIT 왕복만 늘고 얻는 것이 없다.
    return raceDeadline(budget, label, run(getDb()));
  }
  return raceDeadline(budget, label, getDb().transaction(async (tx) => {
    if (statementTimeoutMs > 0) {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`));
    }
    return run(tx as unknown as MirrorReader);
  }));
}

/**
 * 마감까지만 기다린다 — **진행 중 문장을 취소하지 않는다**(2026-09-11 검증 F2).
 *
 * 종전에는 마감을 문장 **발행 전**에만 봤다. 그런데 미러 JS 경로는 무거운 read 를
 * `Promise.all` 로 t≈0 에 한꺼번에 띄우므로, 그 시점엔 마감이 아직 안 지났고 그 뒤로는
 * 아무도 마감을 보지 않는다 — 즉 **예산이 사실상 없었다**(문장 상한이 없는 `mentionsJs`
 * 프로파일에서는 더더욱). 그래서 기다리기 자체에 상한을 건다.
 *
 * 대가를 정직하게 적는다: 버려진 read 의 커넥션은 그 문장이 끝날 때까지 잡혀 있고
 * (풀 압력은 그대로), 우리는 결과만 버린다. 그럼에도 이 편이 낫다 — 지면 하나가
 * degrade 되는 것과 페이지 전체가 120 s 에 절단되는 것의 차이다.
 */
function raceDeadline<T>(
  budget: AnswerSetBudget | undefined,
  label: string,
  work: Promise<T>,
): Promise<T> {
  const deadlineAt = budget?.deadlineAt;
  if (!deadlineAt) return work;
  // 버려진 프로미스의 거부가 미처리로 남으면 서버리스에서 프로세스가 죽는다.
  const swallow = () => { void work.catch(() => {}); };
  const left = deadlineAt - Date.now();
  if (left <= 0) {
    swallow();
    return Promise.reject(new AnswerSetDeadlineError(label));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      swallow();
      reject(new AnswerSetDeadlineError(label));
    }, left);
    // 타이머가 이벤트 루프를 붙잡아 함수 종료를 늦추지 않게 한다.
    (timer as unknown as { unref?: () => void }).unref?.();
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function withAnswerSet<T>(
  cols: SQL,
  W: SQL,
  fn: (tx: MirrorTx) => Promise<T>,
  budget: AnswerSetBudget = {},
): Promise<T> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const { statementTimeoutMs, deadlineAt, dedupe } = budget;
  // 조인 미지정이면 `sql\`\`` 라 문장이 종전과 문자 그대로 같다(빈 조각은 아무것도 내지 않는다).
  const src = sql`scope_answers a${budget.join ?? sql``}`;
  const select = dedupe
    ? sql`SELECT DISTINCT ON (${dedupe.on}) ${cols} FROM ${src} WHERE ${W} ORDER BY ${dedupe.order}`
    : sql`SELECT ${cols} FROM ${src} WHERE ${W}`;
  return getDb().transaction(async (tx) => {
    // fn 이 보내는 문장까지 포함해 **모든** 문장 앞에서 마감을 확인하려면 tx 를
    // 감싸야 한다 — fn 안의 execute 를 가로챌 다른 방법이 없다.
    const guarded: MirrorTx = deadlineAt
      ? {
          execute: (q: Parameters<MirrorTx["execute"]>[0]) => {
            if (Date.now() >= deadlineAt) throw new AnswerSetDeadlineError("statement");
            return tx.execute(q);
          },
        }
      : tx;

    await guarded.execute(
      sql`SET LOCAL idle_in_transaction_session_timeout = ${sql.raw(`'${ANSWER_SET_IDLE_TX_TIMEOUT}'`)}`,
    );
    if (statementTimeoutMs && statementTimeoutMs > 0) {
      await guarded.execute(
        sql.raw(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`),
      );
    }
    await guarded.execute(
      sql`CREATE TEMP TABLE _answer_set ON COMMIT DROP AS ${select}`
    );
    await guarded.execute(sql`ANALYZE _answer_set`);
    return fn(guarded);
  });
}


// ── 요청단위 공유 답변셋 (2026-09-03) ────────────────────────────────────────
// 스냅샷 계열 표준 읽기는 **같은 요청에서 같은 W 로 같은 답변셋을 각자 확정**한다.
// 대시보드 콜드 로드 1회 = 집계·SubKPI·GEO·주제구성·출처구성 5개(언급 화면은
// 헤드라인+SubKPI 2개)가 전부 `answerWhere(filters, ctx)` 를 통째로 다시 계산한다.
// 그 술어의 본체는 full-cycle 게이트(`rootFullCycleAnswerIds` — 셀 카운트 GROUP BY
// + 셀당 최신 1행 DISTINCT ON)라 싸지 않다.
//
// 프로덕션 EXPLAIN ANALYZE (2026-09-03, admin 무필터·표준 루트):
//   · 종전 `SELECT job_id, region, measured_at FROM scope_answers WHERE ${W}`
//       → **991.1ms** / 30,080행 (shared hit 366,427)
//   · 게이트 `count(DISTINCT ROW(target,region))` → 2단 집계 재작성
//       → 794.0ms (같은 30,080행) — 20%뿐이라 재작성만으로는 부족
//   · `WHERE job_id = ANY(string_to_array($1, ',')::uuid[])`
//       → **43.5ms** (PK index scan, 30,080행)
// 즉 답변셋을 요청단위로 1회 확정하고 나머지는 job_id 목록으로 받으면
// 5×991ms → 991ms + 4×44ms 다. 트랜잭션은 그대로 페처마다 하나씩이라
// **병렬성은 유지**된다(한 tx 공유안은 직렬화되어 기각 — PR 본문 참조).
//
// 왜 job_id 목록인가: `scope_answers.job_id` 는 PK 라 `job_id = ANY(<그 W 의 결과>)`
// 는 정의상 W 와 **같은 행 집합**이다. 모수 변화 가능성이 구조적으로 0 —
// 통계적 대조가 아니라 항등이다.
//
// 왜 CSV 텍스트 1개 파라미터인가: `ARRAY[$1,$2,…]`(이 파일 arr() 패턴)는 3만 개면
// 바인드 파라미터 3만 개라 프로토콜 상한(65,535)에 근접하고 파싱도 비싸다.
// `string_to_array($1, ',')::uuid[]` 는 **파라미터 1개**이고, 위 EXPLAIN 이
// 그 형태 그대로(플래너가 길이를 모르는 상태에서) PK index scan 을 고른 것을 확인했다.
//
// 범위(scope): AsyncLocalStorage. React `cache()` 를 쓰지 않는 이유는 이 계산이
// **`unstable_cache` 콜백 안**(= 캐시 미스일 때만)에서 일어나야 하기 때문이다 —
// 게이트웨이에서 미리 계산하면 캐시 적중(정상 경로)에도 991ms 를 내게 된다.
// 그 안에서 React 요청 캐시가 유지되는지는 문서화된 계약이 아니라, 스코프를 명시
// 전파하는 ALS 로 고정한다. 스코프가 없으면(단위 테스트·비-요청 경로) `null` 을
// 돌려주고 **종전 W 를 그대로** 쓴다 — 동작 동일, 공유만 없음.
export type SnapshotAnswerSetStore = Map<string, Promise<string>>;
const snapshotAnswerSetScope = new AsyncLocalStorage<SnapshotAnswerSetStore>();

export function createSnapshotAnswerSetStore(): SnapshotAnswerSetStore {
  return new Map();
}

/** 요청 하나의 스냅샷 답변셋 공유 스코프를 연다 (게이트웨이 전용). */
export function withSnapshotAnswerSetScope<T>(
  store: SnapshotAnswerSetStore,
  fn: () => T,
): T {
  return snapshotAnswerSetScope.run(store, fn);
}

/** 공유 스코프의 크기 — 테스트·진단용. 스코프 밖이면 null. */
export function snapshotAnswerSetScopeSize(): number | null {
  return snapshotAnswerSetScope.getStore()?.size ?? null;
}

// 스냅샷 답변셋의 job_id 목록(CSV). 공유 스코프가 없으면 null.
function sharedSnapshotAnswerIds(
  filters: StandardFilters,
  projectCtx: string | string[] | undefined,
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): Promise<string> | null {
  const store = snapshotAnswerSetScope.getStore();
  if (!store) return null;
  // 키는 술어를 결정하는 입력 전부 — (filters, projectCtx, 숨김 계열). ownedBasePrefixes
  // 류는 답변셋이 아니라 그 뒤 문장의 입력이라 키에 넣지 않는다.
  // ⚠️ 계열이 키에 없으면 한 요청 안에서 언급 화면과 인용 화면이 **같은 집합**을
  //    공유한다 — 먼저 도착한 쪽의 게이트가 다른 쪽에 그대로 적용된다.
  const key = stableKey([filters, projectCtx, family]);
  const hit = store.get(key);
  if (hit) return hit;
  const run = (async () => {
    await bulkMirrorRunVisibleSql(sql`a.run_id`);
    // 상한 있음(2026-09-10) — 이 프로브는 `withAnswerSet` **밖**에서 도는데 캡이 없었다.
    // 대시보드의 모든 스냅샷 읽기가 이것을 기다리므로, 여기가 늦으면 페이지의 모든
    // 경계가 함께 늦는다(PR #235 프리뷰 120.5 s 절단의 후보 중 하나).
    const rows = (await budgetedMirrorDb(getDb(), mirrorHeavyBudget("summaryRead")).execute(
      sql`SELECT a.job_id FROM scope_answers a WHERE ${answerWhere(filters, projectCtx, { hiddenFamily: family })}`,
    )) as unknown as Array<{ job_id: string }>;
    return rows.map((r) => String(r.job_id)).join(",");
  })();
  store.set(key, run);
  // 실패한 프로미스를 요청 내내 붙잡으면 다른 섹션이 재시도조차 못 한다.
  run.catch(() => {
    if (store.get(key) === run) store.delete(key);
  });
  return run;
}

/**
 * 스냅샷(비-allRuns) 읽기의 답변 술어. 공유 스코프 안에서는 요청단위로 1회
 * 확정된 job_id 목록을, 밖에서는 종전 `answerWhere` 를 그대로 돌려준다.
 * 두 경로의 행 집합은 항등(job_id 는 PK)이라 산식·모수가 바뀌지 않는다.
 */
export async function snapshotAnswerWhere(
  filters: StandardFilters,
  projectCtx: string | string[] | undefined,
  /** 숨김 게이트 계열. 요청단위 공유 키에도 들어간다(계열이 다르면 다른 집합이다). */
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): Promise<SQL> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const shared = sharedSnapshotAnswerIds(filters, projectCtx, family);
  if (!shared) return answerWhere(filters, projectCtx, { hiddenFamily: family });
  const csv = await shared;
  // 빈 집합: `string_to_array('', ',')` 는 `{""}` 라 uuid 캐스트가 22P02 로 죽는다.
  if (csv.length === 0) return sql`false`;
  return sql`a.job_id = ANY(string_to_array(${csv}, ',')::uuid[])`;
}

export async function aggregateStandardFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  // 공식(당사) 판정 베이스 — 디폴트 없음(2026-08-05): 전사 카탈로그 암묵 디폴트가
  // 표준/웹사이트 경로에서 축E 좁히기를 새게 한 원인이라, 콜사이트(게이트웨이)가
  // 항상 명시한다. 표준/웹사이트 = ownedBasePrefixesForScope(축E), 프로젝트 =
  // ownedBasePrefixesForProject(설정 owned bases → domain → brand×country).
  ownedBasePrefixes: string[],
  // '가장 긴 접두가 이긴다'의 형제 모집단 — 선언 base(website_prompts.owned_base_url)를
  // 쓸 때는 그 사이트의 선언 목록을 넘긴다. 미지정이면 카탈로그(종전 동작).
  ownedSiblingUniverse?: string[],
  // website 전용 — 타겟 URL 집합에 일치하는 인용을 자사로 판정(websiteTargetOwnedClause).
  websiteTargetsOwned = false,
  // 실행 예산(2026-09-10) — 카드 미러 폴백의 캡. 생략하면 종전 동작.
  budget?: AnswerSetBudget,
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
  // **글로벌 전용** ⑤ 분자 — 공식(HMG) 그룹 키 목록(제품 책임자 2026-09-29). 주면
  // `citations.officialHmgCitations` 를 싣는다. 분류는 JS(`officialHmgGroupKeys`)가 끝낸
  // 목록이고 SQL 은 인용 탭과 같은 그룹 키 식(`citationGroupKeySql`)으로 멤버십만 본다.
  // website·project 호출부는 넘기지 않는다(= 종전 정의).
  officialGroupKeys?: readonly string[],
): Promise<StandardAggregates | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // 격자 판정도 여기서 확정한다(2026-09-20). 이 함수는 **캐시 셀 안**에서 도는데,
  // 그 셀의 키에는 격자 슬롯(`trendGridCacheSlot()`)이 들어간다(`server.ts::mirrorCache`).
  // 그런데 본문이 읽는 동기 판정(`preCatalogCycleIdsKnown` → `withPreCatalogEscape`,
  // 스냅샷 답변셋 술어가 그것을 쓴다)은 확정을 전제로 한다 — 확정 없이 돌면 **키는
  // 격자 셀인데 내용은 격자 미판정**인 비대칭이 생긴다(값이 틀리는 방향은 아니지만,
  // 그 셀이 TTL 동안 "켰는데 6월이 닫힌" 값을 서빙한다). 다른 `allRuns` 진입점들이
  // 이미 같은 이유로 이 줄을 갖고 있고, `trend-grid-wiring.test.ts` 가 그 규율의 정본이다.
  // 격자 키가 꺼져 있으면 왕복 0(30초 메모)이고 SQL·반환값은 종전과 바이트 동일이다.
  await ensureTrendGrid();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return null;
  // 유닛 단위 판정(키 on)이면 ⑤ 의 자사 술어가 **그 프롬프트의 유닛 base** 로 바뀐다.
  // 키 off 면 `units` 가 `null` 이라 아래 SQL 이 글자 그대로 종전과 같다.
  const units = websiteUnitsIfEnabled(ownedUnits);
  // 요청단위 공유 답변셋 — snapshotAnswerWhere 참조(공유 스코프 밖이면 종전 W).
  const W = await snapshotAnswerWhere(filters, projectCtx, "all");
  // 필터된 답변셋(_answer_set)을 트랜잭션에서 1회만 계산 — withAnswerSet 참조.
  // a.run_id 는 아래 지역별 asOf 문장이 `_answer_set a LEFT JOIN scope_runs r ON r.run_id = a.run_id`
  // 로 회차 기준일(cycle_anchor_at, #209)을 읽기 때문에 필요하다 — 투영에서 빠지면 TEMP 표에
  // 컬럼이 없어 42703 으로 대시보드 전체가 죽는다(2026-09-05 프로덕션 장애, 캐시 미스 시점에 발현).
  // a.job_id 는 tracked EXISTS 와 **앵커 축 asOf 조인**(anchorAsOfJoinSql)이 둘 다 쓴다.
  // 유닛 판정은 인용 행의 **프롬프트**를 봐야 하므로 답변셋에 `a.prompt_id` 를 더 싣는다
  // (키 off 면 조각이 비어 투영이 종전과 바이트 동일).
  return withAnswerSet(
    sql`a.job_id, a.region, a.measured_at, a.run_id${units ? sql`, a.prompt_id` : sql``}`,
    W,
    async (db) => {

  // ── answer-level: region rollup + tracked-answer flag ────────────────────
  const ansRows = (await db.execute(sql`
    WITH ans AS (
      -- 지역별 asOf 도 회차(cycle) 기준 — 표준 asOf 와 같은 규칙(축 라우터
      -- cycleAsOfRowSql: 앵커 축이면 ca.round_date, 아니면 COALESCE 폴백).
      SELECT COALESCE(a.region, 'UNKNOWN') AS region,
        ${cycleAsOfRowSql()} AS measured_at,
        EXISTS (
          SELECT 1 FROM scope_mentions m
          WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}
        ) AS has_tracked
      FROM _answer_set a LEFT JOIN scope_runs r ON r.run_id = a.run_id${anchorAsOfJoinSql(sql.raw("a.job_id"))}
    )
    SELECT region,
      count(*)::int AS answers,
      count(*) FILTER (WHERE has_tracked)::int AS tracked,
      ${
        anchorAxisKnownEnabled()
          ? sql`to_char(max(measured_at), 'YYYY-MM-DD')`
          : sql`max(measured_at)`
      } AS last_measured_at
    FROM ans GROUP BY region ORDER BY region
  `)) as unknown as Array<{
    region: string;
    answers: number;
    tracked: number;
    last_measured_at: Date | string | null;
  }>;

  let totalAnswers = 0;
  let trackedAnswerCount = 0;
  // 측정 기준일 = 이 집계 모집단(필터·full-cycle 게이트 적용 후)의 최신 measured_at.
  // 필터바 배지가 답변분석(언급/인용)과 같은 값을 쓰게 하기 위한 것 — 종전의
  // getLatestMeasuredAt — 스코프 raw max은 국가·엔진 필터를 무시했다(2026-09-01).
  // 최댓값의 **원시값**을 함께 들고 있는다 — 앵커 축에서는 이 값이 이미 `YYYY-MM-DD`
  // 라 그대로 내보내야 하고(형식 균일), 종전 축에서는 Date 라 `toISOString()` 이
  // `new Date(asOfMs).toISOString()` 과 같은 순간을 낸다(출력 무변경).
  let asOfMs = 0;
  let asOfRaw: Date | string | null = null;
  const regions = ansRows.map((r) => {
    totalAnswers += num(r.answers);
    trackedAnswerCount += num(r.tracked);
    if (r.last_measured_at != null) {
      const t = new Date(r.last_measured_at).getTime();
      if (Number.isFinite(t) && t > asOfMs) {
        asOfMs = t;
        asOfRaw = r.last_measured_at;
      }
    }
    return {
      region: r.region,
      answerCount: num(r.answers),
      trackedAnswerCount: num(r.tracked),
    };
  });
  if (totalAnswers === 0) return null;

  // ── brands: mention + answer counts per brand (모델 rollup 포함) ──────────
  // brand_rollup_entity_id 로 묶어 Product(모델) 언급이 소속 브랜드에 합산된다 —
  // 자사·경쟁 대칭. 표기는 rollup 대상 Brand 행의 brand 를 대표로 쓴다.
  // 형태는 추이 ②(aggregateStandardTrendFromMirror)와 같다 — OFFSET 0 배리어로
  // 답변셋 조인·rid 계산을 먼저 확정하고, 표기(rollupDisplayName)·제외 키
  // (rollupBareName)는 names 쪽 사전 계산을 쓴다. 근거·전후 수치는 그쪽 주석.
  // `count(DISTINCT m.job_id)` 를 유지해야 하므로 배리어가 job_id 를 함께 낸다.
  // 종전 `m.job_id IN (SELECT job_id FROM _answer_set)`(semi-join) → `JOIN` 은
  // 행을 늘리지 않는다: `_answer_set` 은 `scope_answers` 의 PK(job_id)를 그대로
  // 담아 job 당 정확히 1행이다(withAnswerSet 의 select 목록 참조).
  const brandRows = (await db.execute(sql`
    WITH names AS ${ROLLUP_NAMES_BARE}
    SELECT ${rollupDisplayName("x")} AS name,
      sum(x.mention_count)::int AS mentions,
      count(DISTINCT x.job_id)::int AS answers,
      bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_tracked
    FROM (
      SELECT m.job_id, m.mention_count, m.brand,
        ${canonRollupSql(filters)} AS rid
      FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
      WHERE m.brand_rollup_entity_id IS NOT NULL
      OFFSET 0
    ) x
    LEFT JOIN names n ON n.entity_id = x.rid
    WHERE COALESCE(n.brand, x.brand) IS NOT NULL
      AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
    GROUP BY 1
    ORDER BY mentions DESC
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

  // ── ③ sentiment: mention-unit positive rate (Scope 정본 정렬, 2026-07-29) ──
  // 모집단(answerIds × tracked rollup)의 멘션 sentiment 4계열 카운트를 그대로
  // 합산해 100×P÷(P+NE+NG+MX). 답변(job) 단위 우세(dominant) 분류는 폐지됐다 —
  // 우세 분류는 동률 답변(p==ng)을 긍정·부정 분자에 동시 계상하는 비대칭을
  // 가졌고, Scope 정본(getTrackedKpiAggregate)과도 단위가 어긋났다.
  const sentRows = (await db.execute(sql`
    SELECT
      COALESCE(sum(m.sentiment_positive), 0)::int AS p,
      COALESCE(sum(m.sentiment_neutral), 0)::int AS ne,
      COALESCE(sum(m.sentiment_negative), 0)::int AS ng,
      COALESCE(sum(m.sentiment_mixed), 0)::int AS mx
    FROM scope_mentions m
    WHERE ${trackedRollupPredicate(filters)} AND m.job_id IN (SELECT job_id FROM _answer_set)
  `)) as unknown as Array<{ p: number; ne: number; ng: number; mx: number }>;
  const positiveMentions = num(sentRows[0]?.p);
  const sampledMentions =
    positiveMentions + num(sentRows[0]?.ne) + num(sentRows[0]?.ng) + num(sentRows[0]?.mx);
  const sentiment = {
    positiveRate:
      sampledMentions > 0 ? round1((100 * positiveMentions) / sampledMentions) : null,
    positiveMentions,
    sampledMentions,
  };

  // ── ④ position: 답변당 자사 브랜드 내 순위(ownBrandRankPerJobSql); 순위가 있는
  //    답변만 평균 — 자사가 등장하지 않는 답변은 제외 ─────────────────────────
  const posRows = (await db.execute(sql`
    WITH pos AS (
      SELECT r.rk AS tp
      FROM _answer_set a
      LEFT JOIN ${ownBrandRankPerJobSql(filters)} r ON r.job_id = a.job_id
    )
    SELECT round(avg(tp)::numeric, 1) AS avg_position, count(tp)::int AS sampled
    FROM pos
  `)) as unknown as Array<{ avg_position: string | null; sampled: number }>;
  const position = {
    avgPosition:
      posRows[0]?.avg_position != null ? Number(posRows[0].avg_position) : null,
    sampledAnswers: num(posRows[0]?.sampled),
  };

  // ── ⑤ citations: totals + per-domain rollup ──────────────────────────────
  // owned 판정은 CTE(MATERIALIZED)에서 URL 정규화를 행당 1회만 계산해 둔 `base`
  // 컬럼과의 prefix 비교로. 정규화(regex 6회)를 prefix×2 predicate마다 인라인
  // 반복하면 행당 ~2,000회 regex — 트렌드(전체 이력)에서는 statement timeout
  // (57014)까지 갔다. MATERIALIZED 강제: planner가 CTE를 pull-up 하며 식을
  // 참조마다 재치환하는 것을 막는다.
  // URL 정규화(6중 regex)·owned 판정을 인용 "행"이 아니라 DISTINCT url 당 1회만
  // 계산한다(2026-08-27 콜드 로드 수정 — 전 이력 인용 2.4M행 × 행당 regex 6회가
  // pg_stat_statements 최상위 병목). LEFT JOIN + COALESCE 는 url NULL 행(현재
  // 0건이지만)도 종전과 동일하게 총계에 포함·owned=false 로 다루기 위함.
  //
  // 유닛 판정(키 on): 판정을 `ub`(DISTINCT url)에서 **인용 행**으로 내린다 — 같은 url 도
  // 어느 프롬프트가 인용했느냐에 따라 자사 여부가 갈리기 때문이다. 정규화 사슬은 그대로
  // DISTINCT url 당 1회다(`citationBaseByUrlSelect`). `_answer_set` 조인은 `job_id` 가
  // `scope_answers` 의 PK 라 행을 늘리지 않는다(위 브랜드 문장과 같은 논거).
  const ownedClause = websiteTargetOwnedClause(
    ownedBasePrefixClause(sql`base`, ownedBasePrefixes, ownedSiblingUniverse),
    sql`base`, "base", projectCtx, filters, websiteTargetsOwned,
  );
  const ownedByUrl = (citSet: SQL) =>
    units ? citationBaseByUrlSelect(citSet) : citationOwnedByUrlSelect(citSet, ownedClause);
  // 행 단위 자사 — 키 on 은 유닛 판정, off 는 `ub` 가 이미 접어 둔 불리언.
  // `COALESCE(…, false)` 는 off 경로와 **같은 NULL 취급**을 유지한다: 판정 입력(base)이
  // NULL 인 행(url 없는 인용)은 종전에도 owned=false 로 셌다.
  const ownedRow = units
    ? sql`COALESCE(${websiteUnitOwnedTargetClause(sql`ub.base`, sql`ub.cnorm`, "wup")}, false)`
    : sql`COALESCE(ub.owned, false)`;
  const unitCtes = units ? sql`${websiteUnitPromptCtes(units)},\n    ` : sql``;
  const unitJoin = units ? websiteUnitPromptJoin(sql`c2.prompt_id`) : sql``;
  const citFrom = units
    ? sql`FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id`
    : sql`FROM scope_citations c`;
  // 공식(HMG) 분자(글로벌) — 인용 탭과 **같은 그룹 키 식**으로 키를 만들고 JS 가 고른 목록에
  // 대해 멤버십만 본다. 목록이 없으면 투영·열 모두 없다(website·project = 바이트 동일).
  const officialGk = officialGroupKeys
    ? sql`, ${citationGroupKeySql(sql`c.domain`, sql`c.url`)} AS gk`
    : sql``;
  const officialCol = officialGroupKeys
    ? sql`,
      count(*) FILTER (WHERE c2.gk = ANY(${sql.param([...officialGroupKeys])}::text[]))::int AS official`
    : sql``;
  const citAgg = (await db.execute(sql`
    WITH ${unitCtes}c2 AS MATERIALIZED (
      SELECT c.job_id, c.url${units ? sql`, a.prompt_id` : sql``}${citationNormProjection(sql`c.url_base_norm`, "bk")}${units ? citationNormProjection(sql`c.url_norm`, "nk") : sql``}${officialGk}
      ${citFrom}${units ? sql`` : sql` WHERE c.job_id IN (SELECT job_id FROM _answer_set)`}
    ),
    ub AS MATERIALIZED ${ownedByUrl(sql`c2`)}
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE ${ownedRow})::int AS owned,
      count(DISTINCT c2.job_id)::int AS with_cit${officialCol}
    FROM c2 LEFT JOIN ub ON ub.url = c2.url${unitJoin}
  `)) as unknown as Array<{ total: number; owned: number; with_cit: number; official?: number }>;
  const domRows = (await db.execute(sql`
    WITH ${unitCtes}c2 AS MATERIALIZED (
      SELECT c.job_id, c.domain, c.url${units ? sql`, a.prompt_id` : sql``}${citationNormProjection(sql`c.url_base_norm`, "bk")}${units ? citationNormProjection(sql`c.url_norm`, "nk") : sql``}
      ${citFrom}
      WHERE c.domain IS NOT NULL${units ? sql`` : sql` AND c.job_id IN (SELECT job_id FROM _answer_set)`}
    ),
    ub AS MATERIALIZED ${ownedByUrl(sql`c2`)}
    SELECT c2.domain AS host,
      count(DISTINCT c2.job_id)::int AS citing_answers,
      count(*)::int AS citations,
      count(*) FILTER (WHERE ${ownedRow})::int AS owned_citations,
      bool_or(${ownedRow}) AS is_ours
    FROM c2 LEFT JOIN ub ON ub.url = c2.url${unitJoin}
    GROUP BY c2.domain ORDER BY citing_answers DESC
  `)) as unknown as Array<{
    host: string;
    citing_answers: number;
    citations: number;
    owned_citations: number;
    is_ours: boolean;
  }>;
  const citations = {
    sampledAnswers: totalAnswers,
    answersWithCitation: num(citAgg[0]?.with_cit),
    totalCitations: num(citAgg[0]?.total),
    ownedCitations: num(citAgg[0]?.owned),
    ...(officialGroupKeys ? { officialHmgCitations: num(citAgg[0]?.official) } : {}),
    // citationCount = raw domain total (registrable-domain grouping collapses
    // subdomains, so a domain can carry citations outside the owned base-URL
    // prefix — an owners portal, staging host, etc.). ownedCitationCount is the
    // row-level match against the SAME ownedClause ⑤'s numerator uses; consumers
    // that need to reconcile a domain row's "owned share" with the ⑤ tile
    // (e.g. the dashboard ranking) must sum this, not citationCount.
    domains: domRows.map((d) => ({
      host: d.host,
      citingAnswers: num(d.citing_answers),
      citationCount: num(d.citations),
      ownedCitationCount: num(d.owned_citations),
      isOurs: d.is_ours === true,
    })),
  };

  return {
    rootProjectId: getStandardRootId() ?? "",
    asOf: asOfMs > 0 ? normalizeAsOf(asOfRaw) : null,
    totalAnswers,
    totalMentions,
    trackedAnswerCount,
    brands,
    regions,
    citations,
    position,
    sentiment,
  };
  }, budget ?? {});
}

// ─── Sub KPI (Core 카드 안에 함께 노출) + 엔진별 분해 ────────────────────────
// PROTOTYPE (2026-06-18). Core KPI 카드에 보조 지표를 함께 싣기 위한 집계.
//  #1 브랜드 언급 답변 수      → tracked 답변 수 (① 노출률 분자)
//  #2 브랜드 복수 언급 답변 수  → 당사 mention_count 합 ≥2 인 답변 수 (② 점유율)
//  #3 브랜드 부정 언급 비율     → Σnegative ÷ 신호 합(P+NE+NG+MX) × 100 (③ 우호도의 반대편
//                                 세그먼트 — 언급 단위, 신호 없으면 null)
//  #4 Top3 노출 비율           → min(당사 avg_position) ≤3 ÷ tracked × 100 (④ 우선노출도)
//  #7 엔진 간 일관성           → 해당 Core 의 엔진(target) 간 min ÷ max × 100
// 모두 한 번에 engine(target)별로 집계하고, 전체값(#1~4)은 행 합산으로 도출한다.
// #5(주제 구성비)·#6(출처 구성비)은 중복 정리 백로그(인용분석/Core⑤와 겹침) — 미포함.
export interface SubKpiEngineRow {
  engine: string;
  answers: number;
  tracked: number; // 당사 1회 이상 등장
  multi: number; // 당사 mention_count 합 ≥2
  top1: number; // #10 tracked & min 순위 =1 (ACR 1위 노출의 측정 가능 성분)
  top3: number; // tracked & min 순위 ≤3
  avgPosition: number | null; // min 당사 순위 평균 (순위 미진입 답변 제외 — ④ Core 동일)
  totalMentions: number;
  trackedMentions: number;
  // ③ 계열 — 전부 멘션 sentiment 카운트(신호) 합이다. 답변 수가 아니다.
  // #17(긍정 키워드 언급 수)·#18(부정 키워드 언급 수)은 각각 positiveMentions·
  // negativeMentions 와 동일 값이라 별도 필드를 두지 않는다(design §4).
  sentMentions: number; // 당사 멘션 sentiment 신호 합 (P+NE+NG+MX; 분모)
  positiveMentions: number; // Σ positive (③ 분자 = #17)
  negativeMentions: number; // Σ negative (부정 언급 비율 분자 = #18)
  citTotal: number;
  citOwned: number;
}

/**
 * Overview 카드 다섯 개의 **스냅샷 값**. 전부 한 `StandardAggregates` 에서 나온다
 * (`app/[locale]/(dash)/dashboard/_data/live.ts::buildMirrorKpis` 와 같은 식).
 *
 * ⚠️ 여기 **없는 것**이 있다(사실표·집계 스냅샷에 소스가 없다):
 *   · 우호도의 **부정률** — `StandardAggregates.sentiment` 는 positive/sampled 둘뿐이다.
 *   · 우선 노출도의 **최고 순위**(`rank`) — 스냅샷은 평균만 낸다.
 * 그 둘은 종전 미러 경로가 계속 담당한다(같은 탭 안에서 원천이 갈리므로 주석으로 박는다).
 */
export interface OverviewCardValues {
  /** ① AI 노출률 — 당사 언급 답변 ÷ 모니터링 답변. */
  visibility: { numerator: number; denominator: number };
  /** ② AI 점유율 — 당사 언급 수 ÷ 전체 언급 수. */
  shareOfVoice: { numerator: number; denominator: number };
  /** ③ AI 우호도 — 긍정 신호 ÷ 전체 감정 신호(**언급 단위 신호 수**). */
  sentiment: { numerator: number; denominator: number };
  /** ④ AI 우선 노출도 — 평균 순위(낮을수록 좋다)와 그 모수. */
  position: { avgPosition: number | null; sampledAnswers: number };
  /** ⑤ AI 인용 점유율 — 자사 도메인 인용 ÷ 전체 인용. */
  citationShare: { numerator: number; denominator: number };
}

export interface StandardSubKpis {
  // 엔진별 분해행 (#1·#2·#3·#4·#7 산출 원천).
  rows: SubKpiEngineRow[];
  // #9 브랜드 미언급 답변의 프롬프트 수 — 트래킹 프롬프트 중 당사 브랜드가 어떤
  // 답변에도 등장하지 않는 프롬프트 수. 측정 프롬프트가 없으면 null(= 측정 대기).
  promptsWithoutBrand: number | null;
  // 측정 프롬프트 수(Q5 분모) — 직전 측정 대비 증감 계산용(2026-08-07, 고객
  // 피드백: Sub KPI 변화 추이). 화면 표시값은 여전히 MentionsLive.summary.
  measuredPrompts: number | null;
  /**
   * **Overview 카드와 같은 원천에서 온 카드 값들**(제품 책임자 2026-09-20 "나머지 카드들도
   * 원천 일치인지?"). Overview 카드 다섯 개를 만드는 **바로 그 함수**
   * (`fetchStandardAggregates`)가 낸 값이고, 이 필드가 있으면 히어로 계산이 `rows` 합
   * 대신 이것을 쓴다.
   *
   * 왜 rows 를 고치지 않는가: `rows` 는 **엔진 분해행**인데 사실표 카드 리더는 엔진
   * 축을 그 화면과 같은 필터로 내지 않는다. 합계만 바꾸면 엔진 행과 합이 어긋나므로,
   * 합계를 **별도 필드**로 싣고 어느 쪽이 정본인지 타입으로 드러낸다.
   *
   * 없으면(격자 off·루트 없음) 종전 그대로 `rows` 합이다 — 필드가 안 실리므로
   * 캐시 셀·직렬화 모두 바이트 동일.
   */
  overviewCards?: OverviewCardValues;
}

/**
 * 이 집계가 발행하는 **문장 하나 = 파트 하나**. 화면이 실제로 읽는 파트만 계산해
 * 나머지 문장을 아예 보내지 않기 위한 선택 축이다 (2026-09-02).
 *
 * | 파트 | 문장 | 채우는 필드 |
 * | --- | --- | --- |
 * | `answers`   | Q1 | `rows[].{answers,tracked,multi,top1,top3,avgPosition}` |
 * | `mentions`  | Q2 | `rows[].{totalMentions,trackedMentions}` |
 * | `sentiment` | Q3 | `rows[].{sentMentions,positiveMentions,negativeMentions}` |
 * | `citations` | Q4 | `rows[].{citTotal,citOwned}` |
 * | `prompts`   | Q5 | `promptsWithoutBrand` · `measuredPrompts` |
 */
export const SUB_KPI_PARTS = [
  "answers",
  "mentions",
  "sentiment",
  "citations",
  "prompts",
] as const;
export type SubKpiPart = (typeof SUB_KPI_PARTS)[number];

export interface SubKpiOptions {
  /**
   * 계산할 파트. **미지정 = 전량**(종전과 완전히 동일한 산출)이 불변식이다.
   *
   * ⚠️ `answers`(Q1)는 **행 골격**이라 목록에서 빠져도 항상 돈다 — 엔진(target)
   * 행 자체가 Q1 에서 나오므로, 빼면 다른 파트를 요청해도 `rows` 가 통째로 비어
   * "측정 없음"으로 위장된다. 그래서 이 옵션은 결과를 **요청한 것보다 비게**
   * 만들지 않는다(요청분의 상위집합이 나올 수는 있다).
   *
   * 계산하지 않은 파트의 필드는 `rows[]` 쪽은 0, prompts 쪽은 null 이다 —
   * 즉 **"측정 없음"과 구분되지 않는다.** 좁힌 결과를 그 파트를 읽는 지면으로
   * 흘리면 화면이 조용히 빈다. 좁히기 전에 소비 지점을 전수 확인할 것.
   */
  parts?: ReadonlyArray<SubKpiPart>;
  // ── 예산 (PR④ A4) — 다른 미러 집계와 같은 규약 ─────────────────────────
  //
  // 이 집계는 **문장 5개를 한 트랜잭션에서** 발행하는데(파트 표 참조) 종전에는 상한이
  // 아예 없었다. 라이브 실측(2026-09-10, `website:summary-deltas`) **6.8~7.0 s**.
  // 상한 없는 경로는 degrade 조차 못 하고 Vercel 함수 120 s 에서 HTML 이 잘린다
  // (`kpi-tab-budget.ts` 의 E-2 블록이 그 사고의 정본).
  //
  // 마감(`deadlineAt`)이 아니라 **길이(`budgetMs`)** 로 받는다 — 마감을 인자로 받으면
  // 캐시 키에 `Date.now()` 가 섞여 셀이 매 요청 갈린다. 변환은 아래 호출 시점에서 한다.
  /** 문장 하나의 상한(ms). 실효 최악 = `budgetMs` + 이 값 (`withAnswerSet` 참조). */
  statementTimeoutMs?: number;
  /** 이 집계 전체의 벽시계 예산(ms). 미지정이면 종전대로 마감 없음. */
  budgetMs?: number;
}

export async function aggregateSubKpisFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  // 공식(당사) 판정 베이스 — 콜사이트 명시 필수 (aggregateStandardFromMirror 참조).
  ownedBasePrefixes: string[],
  // '가장 긴 접두가 이긴다'의 형제 모집단 — 선언 base(website_prompts.owned_base_url)를
  // 쓸 때는 그 사이트의 선언 목록을 넘긴다. 미지정이면 카탈로그(종전 동작).
  ownedSiblingUniverse?: string[],
  // website 전용 — 타겟 URL 집합에 일치하는 인용을 자사로 판정(websiteTargetOwnedClause).
  websiteTargetsOwned = false,
  opts: SubKpiOptions = {},
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<StandardSubKpis> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  // 파트 선택 — 미지정이면 전량(종전 동작). Q1 은 행 골격이라 항상 돈다.
  const wanted = opts.parts;
  const want = (p: SubKpiPart) => !wanted || wanted.includes(p);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
  // 요청단위 공유 답변셋 — snapshotAnswerWhere 참조(공유 스코프 밖이면 종전 W).
  const W = await snapshotAnswerWhere(filters, projectCtx, "all");
  // 필터된 답변셋(_answer_set)을 트랜잭션에서 1회만 계산 — withAnswerSet 참조.
  return withAnswerSet(sql`a.job_id, a.target, a.prompt_id`, W, async (db) => {

  // Q1 — answer-level (engine별): visibility / multi-mention / top3 / position
  const ans = (await db.execute(sql`
    WITH ans AS (
      SELECT a.target,
        EXISTS (
          SELECT 1 FROM scope_mentions m
          WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}
        ) AS has_tracked,
        r.rk AS tp,
        (SELECT COALESCE(sum(m.mention_count), 0) FROM scope_mentions m
          WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}) AS tracked_mc
      FROM _answer_set a
      LEFT JOIN ${ownBrandRankPerJobSql(filters)} r ON r.job_id = a.job_id
    )
    SELECT target,
      count(*)::int AS answers,
      count(*) FILTER (WHERE has_tracked)::int AS tracked,
      count(*) FILTER (WHERE tracked_mc >= 2)::int AS multi,
      count(*) FILTER (WHERE has_tracked AND COALESCE(tp, 100) <= 1)::int AS top1,
      count(*) FILTER (WHERE has_tracked AND COALESCE(tp, 100) <= 3)::int AS top3,
      -- 순위가 매겨진 답변만 평균 (④ Core 와 동일 정의). 미언급 답변을 100위로
      -- 채우면 평균이 '순위'가 아니라 '노출률의 역수'가 되어, 엔진 간 일관성이
      -- ① 노출률 일관성을 복제하던 버그를 낳았다 (2026-07-29 실측: 65.3/39.9 →
      -- 6.1/5.9, 일관성 61.1% → 95.9%).
      round(avg(tp)::numeric, 1) AS avg_position
    FROM ans GROUP BY target
  `)) as unknown as Array<{
    target: string; answers: number; tracked: number; multi: number;
    top1: number; top3: number; avg_position: string | null;
  }>;

  // Q2 — mentions (engine별): share-of-voice. rollup 기준(모델 포함) — 모델
  // 언급도 부모 브랜드로 합산해 자사·경쟁 대칭 유지. 모수 법칙은 언급표
  // (aggregateMentionsHeadlineSql)·표준 코어와 동일하게 통일: rollup + 전역
  // 표기 해석(ROLLUP_NAMES) + 비경쟁(Apple/Google) 제외. 이걸 안 맞추면 대시보드
  // SOV 분모만 비경쟁·무표기까지 세어 언급 분석 점유율과 어긋난다(2026-08 정합).
  // 형태는 추이 ②(aggregateStandardTrendFromMirror)와 같다 — OFFSET 0 배리어로
  // 답변셋 조인·rid 계산을 먼저 확정하고, 표기·제외 키는 names 쪽 사전 계산을
  // 쓴다. 근거·전후 수치는 그쪽 주석이 정본.
  const men = !want("mentions") ? [] : (await db.execute(sql`
    WITH names AS ${ROLLUP_NAMES_BARE}
    SELECT x.target,
      sum(x.mention_count)::int AS total,
      sum(x.mention_count) FILTER (WHERE x.rid IN ${trackedRollupIn(filters)})::int AS tracked
    FROM (
      SELECT a.target, m.mention_count, m.brand,
        ${canonRollupSql(filters)} AS rid
      FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
      WHERE m.brand_rollup_entity_id IS NOT NULL
      OFFSET 0
    ) x
    LEFT JOIN names n ON n.entity_id = x.rid
    WHERE COALESCE(n.brand, x.brand) IS NOT NULL
      AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
    GROUP BY x.target
  `)) as unknown as Array<{ target: string; total: number; tracked: number }>;

  // Q3 — sentiment (engine별): 멘션 단위 신호 합. 답변별 우세(dominant) 분류를
  // 쓰지 않는다 — 구 SQL은 p==ng 동률 답변을 pos/neg 양쪽 FILTER에 동시 계상해
  // JS 분류(else-if 배타)와도 어긋났다(2026-07-29 언급 단위 정렬로 소멸).
  const sent = !want("sentiment") ? [] : (await db.execute(sql`
    SELECT a.target,
      COALESCE(sum(m.sentiment_positive), 0)::int AS p,
      COALESCE(sum(m.sentiment_neutral), 0)::int AS ne,
      COALESCE(sum(m.sentiment_negative), 0)::int AS ng,
      COALESCE(sum(m.sentiment_mixed), 0)::int AS mx
    FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
    WHERE ${trackedRollupPredicate(filters)}
    GROUP BY a.target
  `)) as unknown as Array<{
    target: string; p: number; ne: number; ng: number; mx: number;
  }>;

  // Q4 — citations (engine별): owned share. 정규화·판정은 DISTINCT url 당 1회
  // (코어 ⑤와 동일 — 행당 regex 반복이 콜드 로드 최상위 병목이었다).
  // 유닛 판정(키 on)은 판정을 인용 행으로 내린다 — 근거·형태는 코어 ⑤ 쪽 주석 참조.
  const ownedClause = websiteTargetOwnedClause(
    ownedBasePrefixClause(sql`base`, ownedBasePrefixes, ownedSiblingUniverse),
    sql`base`, "base", projectCtx, filters, websiteTargetsOwned,
  );
  const ownedRow = units
    ? sql`COALESCE(${websiteUnitOwnedTargetClause(sql`ub.base`, sql`ub.cnorm`, "wup")}, false)`
    : sql`COALESCE(ub.owned, false)`;
  const cit = !want("citations") ? [] : (await db.execute(sql`
    WITH ${units ? sql`${websiteUnitPromptCtes(units)},
    ` : sql``}c2 AS MATERIALIZED (
      SELECT a.target, c.url${units ? sql`, a.prompt_id` : sql``}${citationNormProjection(sql`c.url_base_norm`, "bk")}${units ? citationNormProjection(sql`c.url_norm`, "nk") : sql``}
      FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
    ),
    ub AS MATERIALIZED ${
      units ? citationBaseByUrlSelect(sql`c2`) : citationOwnedByUrlSelect(sql`c2`, ownedClause)
    }
    SELECT c2.target,
      count(*)::int AS total,
      count(*) FILTER (WHERE ${ownedRow})::int AS owned
    FROM c2 LEFT JOIN ub ON ub.url = c2.url${
      units ? websiteUnitPromptJoin(sql`c2.prompt_id`) : sql``}
    GROUP BY c2.target
  `)) as unknown as Array<{ target: string; total: number; owned: number }>;

  // Q5 — prompt-grain (#9): 트래킹 프롬프트 중 당사 브랜드가 어떤 답변에도
  // 등장하지 않는 프롬프트 수. 한 프롬프트는 여러 엔진/회차 답변을 가지므로
  // 엔진별 합산이 아니라 prompt_id 로 묶어 집계한다 — 한 엔진이라도 언급하면 그
  // 프롬프트는 '언급'으로 본다. 측정 프롬프트가 0개면 null(측정 대기).
  const miss = !want("prompts") ? [] : (await db.execute(sql`
    WITH pa AS (
      SELECT a.prompt_id,
        bool_or(EXISTS (
          SELECT 1 FROM scope_mentions m
          WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}
        )) AS mentioned
      FROM _answer_set a
      WHERE a.prompt_id IS NOT NULL
      GROUP BY a.prompt_id
    )
    SELECT count(*) FILTER (WHERE NOT mentioned)::int AS missing,
           count(*)::int AS prompts
    FROM pa
  `)) as unknown as Array<{ missing: number; prompts: number }>;
  const promptsWithoutBrand = num(miss[0]?.prompts) > 0 ? num(miss[0]?.missing) : null;

  const menBy = new Map(men.map((r) => [r.target, r]));
  const sentBy = new Map(sent.map((r) => [r.target, r]));
  const citBy = new Map(cit.map((r) => [r.target, r]));

  const rows = ans.map((a) => {
    const m = menBy.get(a.target);
    const s = sentBy.get(a.target);
    const c = citBy.get(a.target);
    return {
      engine: a.target,
      answers: num(a.answers),
      tracked: num(a.tracked),
      multi: num(a.multi),
      top1: num(a.top1),
      top3: num(a.top3),
      avgPosition: a.avg_position != null ? Number(a.avg_position) : null,
      totalMentions: num(m?.total),
      trackedMentions: num(m?.tracked),
      sentMentions: num(s?.p) + num(s?.ne) + num(s?.ng) + num(s?.mx),
      positiveMentions: num(s?.p),
      negativeMentions: num(s?.ng),
      citTotal: num(c?.total),
      citOwned: num(c?.owned),
    };
  });

  return {
    rows,
    promptsWithoutBrand,
    measuredPrompts: num(miss[0]?.prompts) > 0 ? num(miss[0]?.prompts) : null,
  };
  }, {
    // 예산(PR④ A4) — 마감은 **여기서** 만든다(캐시 키 밖). 둘 다 미지정이면
    // `withAnswerSet` 이 종전 동작 그대로 간다(세션 기본 timeout · 마감 없음).
    statementTimeoutMs: opts.statementTimeoutMs,
    deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
  });
}

// ── "측정일" 리더의 축 (검증 B4) ────────────────────────────────────────────
//
// 이 두 리더가 내는 값은 **그대로 `dateTo` 로 되먹여져** 같은 집계를 한 번 더 돌린다.
// 그래서 값의 축과 술어의 축이 같아야 한다. 축 on 에서 기간 술어는
// `ca.round_date <= dateTo` 인데 값이 측정일이면 양방향으로 틀린다:
//   · `round_date` < 측정일(`prev_empty`·`merged` 배정, 실측 다수) — 한 회차의 이틀치
//     측정일이 `limit=2` 에 둘 다 뽑혀 "현재 vs 직전"이 같은 회차 대 같은 회차가 되고
//     증감이 0 으로 표시된다.
//   · `round_date` > 측정일(`next_empty` 배정, 앵커 09-14 → 귀속 09-18) — 최신 회차가
//     `dateTo` 를 넘어서 비교 기준 스냅샷이 통째로 빈다.
// 라이브 90일 실측으로 `date(measured_at) ≠ date(cycle_anchor_at)` 이 27.0% 이고,
// §9.2 정규 요일 귀속이 거기에 며칠을 더 얹는다.
//
// 노출 게이트를 함께 거는 이유: 아직 열리지 않았거나 숨긴 회차의 날짜를 돌려주면
// 그 날짜로 다시 집계한 결과가 **빈 스냅샷**이 된다(데이터 경로가 그 회차를 뺀다).
function measureDayAxis(): { join: SQL; key: SQL; guard: SQL } {
  if (anchorAxisKnownEnabled()) {
    return {
      // 값(키)을 꺼내는 조인이지만 **INNER** 다 — 앵커 없는 답변은 회차 날짜 자체가
      // 없어 NULL 그룹을 만들 뿐이고, 그 NULL 이 `dateTo` 로 되먹여지면 안 된다.
      join: anchorJoinSql(sql.raw("a.job_id")),
      key: anchorRoundDateSql(),
      // 계열 `'all'` 을 **명시**한다(검증 N2 점검). 이 값의 소비처는 Sub KPI 의
      // "직전 측정 대비" 비교인데 그 집계(`aggregateSubKpisFromMirror`)가 언급·인용을
      // 함께 내는 `'all'` 롤업이다 — 비교 기준일과 비교 대상 집계의 계열이 갈리면
      // 그 날짜로 다시 돌린 스냅샷이 비거나 다른 회차를 본다.
      guard: sql`${anchorViewableSql()} AND ${anchorNotHiddenKnownSql("ca", "all")}`,
    };
  }
  return {
    join: sql``,
    key: sql`date_trunc('day', a.measured_at)`,
    guard: sql`a.measured_at IS NOT NULL`,
  };
}

// 스코프·필터 창 안의 측정일(일 단위, 최신순) — Sub KPI "직전 측정 대비" 증감의
// 비교 시점 탐색용. 기간 = 기간 내 최신 배치 의미론이므로, 직전 측정일을
// dateTo 로 넣어 다시 집계하면 그 시점의 스냅샷이 나온다 (2026-08-07).
// 축 on 에서는 "측정일"이 **회차 귀속 날짜**다(위 `measureDayAxis`).
export async function latestMeasureDays(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
  limit = 2,
): Promise<string[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  const db = getDb();
  const W = answerWhere(filters, projectCtx, { allRuns: true });
  // ⚠️ `OFFSET 0` 은 장식이 아니라 **플랜 안전장치**다 (2026-09-01).
  // 종전 형태(`… GROUP BY 1 ORDER BY 1 DESC LIMIT n`)에서 플래너는 LIMIT 2 를
  // 보고 "정렬된 입력에서 두 그룹만 뽑으면 된다"고 판단해 카탈로그 semi-join 을
  // **Nested Loop Semi Join + Materialize** 로 골랐다. 당시 조인 키
  // (`prompts.scope_prompt_id`)에 인덱스가 없어 Join Filter 로 떨어졌고, 결과가
  // 이것이다 (프로덕션 EXPLAIN ANALYZE, 2026-09-01):
  //     Rows Removed by Join Filter: **332,120,490**   → 47,097 ms
  // 바깥 61,125행 × Materialize 된 프롬프트 5,434행 전수 비교다. 이 호출은 콜드
  // 로드에서 **2회** 발생한다(Sub KPI 현재/직전 비교) → 그것만으로 ~94초.
  //
  // 근본 원인은 인덱스 부재였고 그쪽을 고쳤다(`prompts_scope_prompt_id_idx`,
  // migration 0047). 인덱스만으로 47,097 ms → 348 ms 다.
  // `OFFSET 0` 은 서브쿼리 pull-up 을 막아 LIMIT 이 조인 아래로 내려가지 못하게
  // 한다 → 집계를 먼저 끝내고(Hash Semi Join) 2개를 자른다. **인덱스 없이도**
  // 47,097 ms → 333 ms 였다. 즉 이 한 줄은 "그 인덱스가 사라지거나 플래너가
  // 다시 뒤집혀도 이 쿼리는 안 터진다"는 보험이고, 인덱스가 있는 지금도
  // 348 ms → 334 ms 로 손해가 없다(교차 3회 중앙값 · 산출 동일).
  const ax = measureDayAxis();
  const rows = (await db.execute(sql`
    SELECT day FROM (
      SELECT to_char(${ax.key}, 'YYYY-MM-DD') AS day
      FROM scope_answers a${ax.join}
      WHERE ${ax.guard} AND ${W}
      GROUP BY 1
      OFFSET 0
    ) d
    ORDER BY day DESC LIMIT ${limit}
  `)) as unknown as Array<{ day: string }>;
  return rows.map((r) => r.day);
}

// 기간 창 안의 측정일 경계 — 누적(cumulative) 모드의 증감(Δ) 기준점 탐색용
// (2026-09-04). Δ = 기간 누적 − 기간 '첫 측정일까지'의 누적 이므로, 첫 측정일과
// 측정일 수만 있으면 된다. 측정일이 1개면 비교 대상이 없다 → 뷰가 배지를 숨긴다.
export interface MeasureDayBounds {
  first: string | null; // 기간 내 가장 이른 측정일 (YYYY-MM-DD)
  days: number; // 기간 내 측정일 수
}

export async function measureDayBoundsInRange(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
): Promise<MeasureDayBounds> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return { first: null, days: 0 };
  const db = getDb();
  const W = answerWhere(filters, projectCtx, { allRuns: true });
  const ax = measureDayAxis();
  const rows = (await db.execute(sql`
    SELECT to_char(min(d), 'YYYY-MM-DD') AS first_day, count(*)::int AS days
    FROM (
      SELECT ${ax.key} AS d
      FROM scope_answers a${ax.join}
      WHERE ${ax.guard} AND ${W}
      GROUP BY 1
    ) t
  `)) as unknown as Array<{ first_day: string | null; days: number }>;
  return { first: rows[0]?.first_day ?? null, days: num(rows[0]?.days) };
}

// ─── #21 프롬프트 주제별 구성비 — prompt-topic composition ───────────────────
// 전체 모니터링 프롬프트를 주제(= catalog funnel_stage, HMG 3단계 정식 vocab)별로
// 묶어 프롬프트 수 분포를 낸다. 프롬프트 단위(여러 엔진/회차 답변을 한 프롬프트로
// 접음)라 prompt_id 로 GROUP 하고, 그 프롬프트의 catalog funnel_stage 를 한 개만
// 집는다(LIMIT 1). funnel_stage 미지정 프롬프트는 topic=null → 뷰에서 '미분류'
// 라벨. 구성비(%)는 뷰에서 합 대비로 계산한다 — 여기선 카운트만.
export interface PromptTopicSlice {
  topic: string | null; // funnel_stage 값 (null = 미분류)
  prompts: number;
}

export async function aggregatePromptTopicFromMirror(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
): Promise<PromptTopicSlice[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  const db = getDb();
  // ⚠️ **계열은 지면 단위다**(D1, 2026-09-20 결정). 이 리더는 Overview·website·
  // 프로젝트 지면에서만 쓰이고(대시보드/웹사이트 `_data/live.ts`), 그 세 지면의 카드는
  // 7 KPI 묶음이라 `'all'` 이다. 기본값(`'mentions'`)에 기대면 **같은 화면에서 기준
  // 회차가 갈린다**: N2 수리로 `max(ca2.round_date)` 게이트가 바깥 계열을 따라가므로,
  // 느슨한 계열은 인용만 숨긴 회차를 최신으로 잡고 엄격한 계열은 그 앞 회차를 잡는다.
  // 그러면 달력에 없는 날짜를 이 위젯만 그린다(통합 검증 D1).
  const W = await snapshotAnswerWhere(filters, projectCtx, "all");

  // ⚠️ **인덱스 의존성 (제거 금지)**: `prompts_scope_prompt_id_idx`
  //    = (scope_prompt_id) INCLUDE (funnel_stage) — migration 0050.
  //    아래 상관 스칼라 서브쿼리는 프롬프트 그룹마다 1회 실행된다(admin 무필터
  //    11,302회). 인덱스가 없으면 매번 `prompts` 를 Seq Scan 해
  //    shared hit 5,097,020 · **18,233 ms** 였다. 인덱스로 **694 ms**(26배).
  //    산출은 동일(3행, md5 6f06832f1e8c0e4c132048f1208ba5cf).
  const rows = (await db.execute(sql`
    WITH pa AS (
      SELECT a.prompt_id,
        (SELECT p.funnel_stage FROM prompts p
          WHERE p.scope_prompt_id = a.prompt_id AND p.funnel_stage IS NOT NULL
          LIMIT 1) AS topic
      FROM scope_answers a
      WHERE ${W} AND a.prompt_id IS NOT NULL
      GROUP BY a.prompt_id
    )
    SELECT topic, count(*)::int AS prompts
    FROM pa GROUP BY topic ORDER BY prompts DESC
  `)) as unknown as Array<{ topic: string | null; prompts: number }>;

  return rows.map((r) => ({ topic: r.topic ?? null, prompts: num(r.prompts) }));
}

// ─── 시계열 롤업 (측정주기가 불규칙 → 캘린더 버킷으로 normalize) ─────────────
// PROTOTYPE (2026-06-18). cadence-probe 실측 결과 측정주기가 불규칙(희소 배치 →
// 시간당 cron, 2일 공백)하고 run_id 는 fragment 라 회차 축으로 못 쓴다. 그래서
// measured_at 을 캘린더 버킷(주 기본 / 일 drill-down)으로 normalize 한다.
//
// 원칙 (이전 리서치 결정):
//  - 저장 grain 은 일, 표시 기본은 주. 인트라데이 과측정(같은 prompt 하루 10+회)은
//    버킷 내 집계로 흡수된다 — answer 1개=점 1개로 찍지 않는다.
//  - 보간 금지: 측정 없는 버킷은 행 자체가 없다(빈 구간은 차트에서 끊김). 절대
//    직선으로 메우지 않는다.
//  - 셀 단위 일별 커버리지가 ~46%뿐이라 각 버킷에 coverage(measuredDays/answers/
//    firstAt/lastAt)를 함께 실어 보낸다 → 뷰에서 "측정 N일" 배지로 정직하게 노출.
//
// KPI 최종 산식(visibility/SOV/citationShare 의 pct 등)은 스냅샷과 동일하게
// view-model(dashboard/_data/live.ts)에서 적용한다 — 여기서는 버킷별 raw 집계만.
export type BucketUnit = "week" | "day";
// date_trunc 의 첫 인자는 bind 파라미터로 넘기지만, 화이트리스트로 한 번 더 막는다
// (사용자 입력이 SQL field 토큰으로 새지 않도록).
const BUCKET_FIELD: Record<BucketUnit, SessionTzBucketUnit> = { week: "week", day: "day" };

// ── 글로벌 표면 추이의 주 격자 = 회차 앵커의 **KST** 주 (2026-09-28, 제품 책임자 옵션 1) ──
//
// 미러 추이의 주 격자는 종전 `date_trunc('week', a.measured_at)` — 측정 시각의 세션 TZ
// (= UTC) 주다. 글로벌(표준 루트) 회차는 **KST 월요일 0시대**(= UTC 일요일 15~16시)에
// 앵커가 서고 드레인이 곧바로 시작되므로, 측정 시각의 UTC 주는 **회차의 한 주 앞**이 된다.
//   · 앵커 9/8 회차 2026-09-08T01:10Z · 9/14 회차 09-13T15:48Z · 9/21 회차 09-20T15:50Z ·
//     9/28 회차 09-27T16:00Z.
//   · 2026-09-28 프로덕션 재현(관리자 `/ko/standard/answer-analysis/mention?geography=PH`):
//     측정 커버리지 "8/31, 9/7, 9/21". 필리핀 9/14 회차 답변은 09-13(일) 16~17Z 측정이라
//     9/7 칸에 9/8 회차와 합쳐지고(셀당 최신 1건 DISTINCT ON 이라 9/8 답변이 밀려난다)
//     **9/14 칸이 빈다**.
//
// 키 = `date_trunc('week', r.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')` 의 날짜.
//   · 재측정(manual) run 은 원 회차의 앵커를 물려받는다 → run 앵커로 충분하다.
//   · 앵커 NULL run 은 **종전 식**(측정 시각 주)으로 떨어진다.
//   · 값·술어·dedup 규칙은 하나도 안 바뀐다 — **주 배정만** 바뀐다. DISTINCT ON 의 주 자리도
//     같은 키를 쓰므로 한 회차는 한 칸 안에서 셀당 1건으로 접힌다.
//
// 표면 판정 = projectCtx 유무 — `answerWhere`·`snapshotRunFilter` 와 **같은 규칙**
// (ctx 없음 = 표준 루트 = 글로벌). 웹사이트·프로젝트는 **문자 그대로 종전 식**이다:
//   · 웹사이트 — 원장 `cycle_week` 가 UTC 절단과 KST 절단 모두와 일치(797/797, 프리뷰
//     PR #272 `trendWeekKey` 머리 주석 실측). 앵커가 KST 월요일 새벽에 서지 않아 두 규칙이
//     같은 값을 낸다 — 바꿀 이유가 없다.
//   · 프로젝트 — 원장 규칙이 UTC(145/145, KST 는 132/145). KST 로 바꾸면 틀린다.
//
// 타입은 종전 식과 같은 timestamptz 로 맞춘다(`::date::timestamptz`). 두 팔이 같은 세션 TZ
// 규칙으로 해석돼 `to_char(…)`·`bucketKey()` 가 폴백 팔과 한 격자(월요일)에 선다.
// 조인은 `scope_runs` PK(run_id) 1:1 이라 행이 불지 않는다. 열 이름을 `_wk_*` 로 바꿔
// 노출하는 이유: 바깥 술어(W)의 무접두 `run_id` 가 조인 쪽과 모호해지지 않게.
// 조각 안에 바인드 파라미터가 없다 — DISTINCT ON 과 ORDER BY 가 **문자적으로** 같아야 한다.

/** 주 격자 원천. `measured` = 종전(측정 시각의 세션 TZ 주) · `anchorKst` = 회차 앵커의 KST 주. */
export type MirrorWeekGrid = "measured" | "anchorKst";

/** 표면 → 주 격자. projectCtx 가 없으면 글로벌(표준 루트)이다 — answerWhere 와 같은 판정. */
export function mirrorWeekGridFor(projectCtx: string | string[] | undefined): MirrorWeekGrid {
  return hasProjectCtx(projectCtx) ? "measured" : "anchorKst";
}

export interface MirrorWeekKey {
  /** `FROM scope_answers a` 바로 뒤에 이어 붙이는 조인 조각. `measured` 면 빈 SQL. */
  join: SQL;
  /** 주 키 식 — 종전 `date_trunc('week', a.measured_at)` 자리에 그대로 쓴다. */
  key: SQL;
  grid: MirrorWeekGrid;
}

/**
 * 주 격자 키 조각. `measured` 는 **종전 식과 문자 그대로 같다**(웹사이트·프로젝트 문장
 * 텍스트 무변경 → pg_stat_statements 정규화 텍스트도 그대로).
 */
export function mirrorWeekKey(grid: MirrorWeekGrid, answerAlias = "a"): MirrorWeekKey {
  const a = sql.raw(answerAlias);
  const measured = sql`date_trunc('week', ${a}.measured_at)`;
  if (grid !== "anchorKst") return { join: sql``, key: measured, grid: "measured" };
  return {
    join: sql` LEFT JOIN (SELECT run_id AS _wk_run_id, cycle_anchor_at AS _wk_anchor FROM scope_runs) _wk ON _wk._wk_run_id = ${a}.run_id`,
    key: sql`COALESCE((date_trunc('week', (_wk._wk_anchor AT TIME ZONE 'Asia/Seoul')))::date::timestamptz, ${measured})`,
    grid,
  };
}

// ── 추이(allRuns) 읽기의 공통 안전 창 — 120일(~17주) ────────────────────────
// allRuns 추이는 런 윈도 제한이 없어 **전 이력**을 스캔한다. 언급/인용 추이
// (readMentionBrandDayCounts · readCitationDomainDayCounts)는 2026-08-12 부터
// 이미 이 창을 쓰고 있었고, KPI 추이·인용정확도 추이만 무바운드로 남아 있었다.
//
// 2026-09-03 제품 결정으로 **allRuns 추이 계열 전체를 이 창으로 통일**한다.
//
// ⚠️ 이것은 **성능 개선이 아니라 성장 가드**다. 도입 시점 실측을 정확히 적어 둔다
// (다음 사람이 "이미 바운드했는데 왜 안 빨라지나"로 헤매지 않게):
//   · 미러의 완료 답변은 전량이 창 안에 있다 — 2026-09-03 실측
//     `scope_answers` status='completed' AND measured_at IS NOT NULL = 381,636행,
//     그 중 120일 이내 **381,636행(100%)**. 최고(最古) 측정은 2026-06-07
//     (= 88일치). 즉 **지금은 한 행도 걸러내지 않는다.**
//   · 그래서 구/신 산출값이 완전히 같고(digest 일치), 벽시계도 같다 — ⑥ website
//     추이 admin 무필터 구 25.6s / 신 24.6s (EXPLAIN ANALYZE, 차이는 캐시 온도).
//   · PR #178 §6 이 근거로 든 "바운드 계열 2.2s vs 무바운드 53.5s" 는 **창 때문이
//     아니었다**. 그 계열(read*DayCounts)은 owned/target 판정 CTE 자체가 없다.
//   · `lib/scope/mirror/` 에 보존기간 삭제가 없어 이력은 계속 쌓인다 — 창은
//     대략 2026-10-05(= 최고 측정 + 120일)부터 실제로 행을 자르기 시작한다.
//     그때부터 스캔 모수가 상수로 묶여, 추이 쿼리가 이력에 비례해 느려지지 않는다.
//
// ⚠️ 화면 의미는 "전 이력 추이" → "최근 17주 추이"로 바뀐다(지금은 같은 그림이지만
// 계약이 바뀐 것이다). 차트 설명 문구(messages/{ko,en}.json
// `dashboard.trend.description`)가 창을 표기한다.
//
// 사용자가 명시 기간 필터를 걸면 answerWhere(allRuns)가 measured_at 상·하한을
// 추가로 얹으므로 **둘 중 좁은 쪽**이 이긴다(AND 결합 — 기존 규칙 그대로).
export const TREND_WINDOW_DAYS = 120;

// `interval '120 days'` 를 리터럴로 굳힌다(바인드 파라미터가 아니라). 이미 이
// 창을 쓰던 두 리더가 리터럴이었고, pg_stat_statements 정규화 텍스트를 그대로
// 유지해야 배포 전후 비교가 성립한다. 인자는 모듈 상수(숫자)라 주입 경로가 없다.
const TREND_WINDOW_SQL = sql.raw(`interval '${TREND_WINDOW_DAYS} days'`);

/**
 * **격자가 켜졌을 때의 바닥 일수** — 자리 목록의 상한(`TREND_GRID_MAX_DAYS`)과 같다.
 *
 * 왜 상수 하나로는 안 되나(2026-09-20 통합 병합에서 발견): 격자는 "가장 오래된 자리"
 * 를 바닥으로 넘긴다(`server.ts::globalSeriesFilters` · `withTrendGridWindow`). 정상
 * 케이던스에서는 13자리 × 7일 = 84일이라 120일 안이지만, **케이던스가 멈추면**
 * `trimTrailingUnpublished` 가 끝 자리를 과거에 고정하므로 `now − 첫 자리` 가 계속
 * 자란다(자리 목록 자체는 180일 상한 안에서 만들어진다). 그때 120일 상수가 가장
 * 오래된 자리들을 잘라 **없던 갭**이 화면에 뜬다 — 격자 쪽이 91일 상수에서 이미 한 번
 * 고친 것과 같은 결함이고, 사실표 경로에는 이 바닥이 아예 없어 두 층이 121~180일
 * 구간에서 어긋난다(단일 원천 위반).
 *
 * ⚠️ 값은 `lib/period/trend-grid.ts::TREND_GRID_MAX_DAYS` 와 같아야 한다. 그 모듈은
 *    `server-only` + react `cache` 라 여기서 import 하지 않고, 대신
 *    `trend-grid-floor.test.ts` 가 두 상수의 동일성을 단언한다.
 */
const TREND_GRID_FLOOR_DAYS = 180;

/**
 * 지금 걸어야 할 바닥 일수. 격자가 꺼져 있으면 종전 상수 그대로다(바이트 동일).
 *
 * ⚠️ **단위를 받는다**(검증 W2, 2026-09-20). 격자는 **주 버킷에만** 얹힌다
 *    (`server.ts::trendSlotsFor` 가 `unit !== "week"` 에서 `null` 을 낸다). 단위를 모르면
 *    일 버킷 경로(프로젝트 일 추이 `getLiveTrend(filters, "day", projectId)`)가 격자를
 *    안 얹는데 바닥만 180 으로 넓어져 **스캔만 1.5배**가 된다. 값은 안 바뀌지만
 *    "격자가 안 갇히는 곳은 안 넓힌다" 는 이 상수의 취지와 어긋난다.
 *
 * 단위를 생략하면 종전 판정(주 취급)이다 — 단위를 모르는 호출부가 아직 없으므로
 * 기본값이 쓰이는 경로도 없지만, 시그니처를 선택적으로 두어 호출부를 강제하지 않는다.
 */
function trendFloorDays(unit?: BucketUnit): number {
  if (unit !== undefined && unit !== "week") return TREND_WINDOW_DAYS;
  return trendGridKnownEnabled() ? TREND_GRID_FLOOR_DAYS : TREND_WINDOW_DAYS;
}
/**
 * 추이 창의 **바닥**. 축 on 에서는 회차 귀속 날짜로 자른다(검증 B4 잔존 경로).
 *
 * 왜 축을 맞춰야 하나: 축 on 의 버킷은 `ca.anchor_week`/`ca.round_date` 인데 바닥만
 * 측정 시각이면, 회차의 꼬리 측정이 창 밖으로 밀린 회차에서 **대표가 바뀐다**
 * (그 회차의 일부 답변만 남는다). 회차는 통째로 들어오거나 나가야 한다(계약 §3).
 *
 * 형태는 **비상관 semi-join** 이다 — 이 술어가 붙는 문장 다섯 곳 중 일부만 `ca` 를
 * 조인하고 있어서, 조인 존재를 전제하면 나머지에서 42703 이 난다. 서브쿼리 안의
 * `ca` 는 바깥 `ca` 와 다른 스코프라 충돌하지 않는다(바깥 별칭을 참조하지 않으므로
 * 상관도 아니다).
 *
 * 날짜 산술은 `hmg_anchor_today()`(KST 오늘, `date`)에서 뺀다 — `now()` 를 쓰면
 * 세션 TimeZone 을 타고, `round_date` 는 KST 로 굳은 `date` 라 축이 어긋난다.
 */
function trendWindowFloor(
  col: SQL = sql`a.measured_at`,
  jobIdCol: SQL = sql.raw("a.job_id"),
  /**
   * 이 문장이 **이미 `ca` 를 조인했는가**(검증 P2). 참이면 semi-join 대신 조인된
   * 컬럼에 범위 술어를 직접 건다 — 앵커 표를 한 번 더 해시할 이유가 없다. 값은 같다
   * (`job_id` 가 PK 라 semi-join 과 조인이 같은 집합을 고른다).
   */
  caJoined = false,
  /**
   * 이 문장이 **`sv` 조인을 방출했는가**(`trendMirrorJoins().joined`). 거짓이면 함대
   * 게이트는 `ca` 만 참조하는 semi-join 판본으로 간다 — `caJoined` 하나로 묶으면
   * `ca` 만 조인한 호출부가 없는 별칭을 참조해 42P01 로 죽는다(5f5b84e 차단 결함).
   */
  svJoined = false,
  /**
   * 바닥 일수. 기본은 종전 상수(120)다. **격자가 자리 바닥을 넘기는 호출부**만
   * `trendFloorDays()` 를 실어 격자 상한(180)까지 넓힌다 — 그 주석 참조.
   * 격자가 꺼져 있으면 `trendFloorDays()` 도 120 을 돌려주므로 텍스트가 같다.
   */
  windowDays: number = TREND_WINDOW_DAYS,
): SQL {
  if (anchorAxisKnownEnabled()) {
    const floor = sql`${anchorRoundDateSql()} >= hmg_anchor_today() - ${sql.raw(String(windowDays))}`;
    // ⚠️ **추이도 카드·달력이 보는 회차만 본다**(프리뷰 실측 2026-09-20). 종전에는
    //    창 바닥만 걸어, 원장이 아직 발행하지 않은 회차(요약 세대 없음 · 노출일 미도래)가
    //    추이에만 점으로 섰다 — website 마지막 점이 미발행 09-18 회차라 카드 기준일
    //    (09-11)과 어긋났다. 같은 두 게이트를 여기도 건다:
    //      · `anchorViewableSql()`      노출일이 왔는가
    //      · `anchorLedgerServableKnownSql` 원장이 서빙을 허락했는가(함대 규칙)
    //    숨김 게이트는 여기 넣지 않는다 — 추이는 숨긴 회차를 **갭 슬롯으로 그려야**
    //    하므로 값 술어(`excludeHiddenCycleRuns`)가 따로 계열별로 건다.
    // ⚠️ `caJoined` 경로는 함대 게이트를 **조인 판본**으로 쓴다 — 상관 `EXISTS` 를 남기면
    //    `summary_cycles` 를 행마다 조회한다(5차 실측 `sc_1` loops=187,233).
    //    그 경로의 호출부는 `trendServableJoinSql()` 을 FROM 에 이미 붙였다.
    if (caJoined && svJoined) {
      return sql.join([floor, anchorViewableSql(), trendServableJoinedPred()], sql` AND `);
    }
    const preds = [floor, anchorViewableSql(), anchorLedgerServableKnownSql("ca")];
    // ⚠️ `sv` 조인이 **없어도** `ca` 를 조인했으면 직접 AND 다(8c9b3e7 원형 복원 —
    //    2026-09-20 2차 검증 P1-SAME=false). 여기서 semi-join 으로 떨어지면 인용 추이
    //    두 문장(`readCitationDomainDayCounts`·`aggregateWebsiteCitationAccuracyTrend`)
    //    이 앵커 표를 한 번 더 스캔하고 그 안에서 `summary_cycles` 상관 EXISTS 를 행마다
    //    돈다 — 5차 실측 `ca_1`·`sc_1` loops=187,233 · 순증 1.06초. 통합 프리뷰의 기본
    //    상태(축 on · 격자 off)가 정확히 이 경로라, 빠지면 main 보다 느려진다.
    if (caJoined) return sql.join(preds, sql` AND `);
    const clause = anchorJobIdIn(jobIdCol, preds);
    if (clause) return clause;
  }
  return sql`${col} >= now() - ${TREND_WINDOW_SQL}`;
}

// ── 진행 중 회차 감추기 — 추이 전용 (2026-09-10 핫픽스) ─────────────────────
//
// 미러 추이는 `scope_answers` 를 직접 읽으므로 **측정이 도착하는 즉시** 그래프에
// 점이 생긴다. 회차가 아직 도는 중이면 그 점은 반쪽 데이터다 — 2026-09-10 실측
// (리더 직접 호출 · 웹사이트 무필터 주 버킷): 8/24 20,162 · 8/31 19,956 인데
// 9/07 주는 19,243 이고 그 중 **19,146(99.5%)이 관제 원장상 `open` 인 9/10 회차의
// 진행분**(measured_at 9/10 03:11~06:14)이었다. 글로벌(root)도 같은 리더라
// 9/07 주 37,569 가 **전량 open 9/08 회차**였다(수리 후 그 버킷 자체가 사라진다).
//
// 제품 책임자 규칙("뷰 앵커 = 측정 앵커 + 1~2일 뒤 노출")은 사실표(summary_*) 경로에만
// 있었고 미러 폴백 경로에는 없었다. 그 구멍을 원장 술어 한 줄로 막는다.
//
// ⚠️ **상수 없는 표면의 폴백에만** 쓴다(핫픽스 A3, 2026-09-10). 핫픽스 A·A2 는 이 목록을
// 술어의 본체로 썼는데, 상태는 뷰 앵커 규칙의 **대리 변수일 뿐이라 양방향으로 틀렸다**:
//   · 지나치게 감춘다 — 글로벌 9/08 회차 `9db294d8`(anchor 2026-09-08 01:10Z)는 앵커+2일 =
//     9/10 01:10Z 가 이미 지나 **노출돼야 하는데** 관제가 아직 `open`(38,747/38,748 · sealed 1 ·
//     gap 0.0191)이라 통째로 숨겨졌다. 9/07 주 버킷(≈37,569)이 전량 이 회차라 주가 사라졌다.
//   · 지나치게 드러낸다 — 관제가 100% 로 닫는 순간(`closed`) 술어가 풀려, 뷰 앵커가 아직
//     안 온 회차의 **부분 분석 데이터**가 그대로 샌다.
// 상태를 늘려 막는 길도 막혀 있다 — `generating`·`closed` 를 넣으면 백필 대기분까지 빠져
// **과거 버킷이 소급해 줄어든다**(2026-09-10 실측: `generating` 이 8/28 앵커 회차 1개에
// 13일째 멈춰 있고 그 완료 답변 335건이 웹사이트 8/24 주 버킷 20,162 안에 있다).
// 시간 규칙은 이 셋을 한 번에 푼다 — 앵커가 오래된 회차는 상태와 무관하게 노출되고,
// 앵커가 아직 안 온 회차는 상태와 무관하게 숨는다.
export const TREND_HIDDEN_CYCLE_STATUSES = ["open"] as const;

/**
 * 뷰 앵커(V-1)가 아직 오지 않은 회차에 귀속된 run 을 빼는 술어.
 *
 * 규칙 정본은 쓰기 쪽 **V-1**(`lib/summary/generate/swap.ts::publishCycleSql`) 과 읽기 게이트
 * **V-2**(`lib/db/repositories/summary-cycles.ts::cycleViewableSql`) 다. 사실표 경로는 그 둘로
 * 이미 막혀 있었고, 미러 폴백 경로에만 없던 규칙을 여기에 옮긴다:
 *
 *   숨김 ⇔ `COALESCE(view_anchor_at, cycle_anchor_at + 표면 지연) > now()`
 *
 * ⚠️ V-2 와 **문자 그대로 같지는 않다**(2026-09-10 검증자 실측). `view_anchor_at` 이 있는
 *   published 회차에서는 같지만, 없는 회차(closed 141·open 96)에서 V-2 는 무조건 비노출이고
 *   이 술어는 `cycle_anchor_at + 지연` 으로 노출한다. V-2 를 그대로 쓰면 120일 창에서 답변
 *   85,452건(14.6%)이 사라진다 — 미러 폴백은 미발행 회차(백필 대기·분석 갭)의 답변도 보여야
 *   하므로 이 이탈은 의도다. "V-2 로 통일하자"로 되돌리지 말 것.
 * ⚠️ 술어는 `now()` 인데 결과는 `mirrorCache`(`unstable_cache`, TTL 7,200 s — `lib/scope/server.ts`)
 *   에 굳는다. 뷰 앵커 통과 후 최대 2시간(+SWR) 늦게 노출되고, 화면별 캐시 키가 달라 그 사이
 *   화면 간 모수가 다를 수 있다. 즉시 반영이 필요하면 `POST /api/internal/summary/published`.
 * ⚠️ 시간 규칙에는 완결·분석 갭 항이 없다 — 지연이 지났는데 관제가 닫지 않았거나 생성기가
 *   발행하지 않은 회차(미완결·gap > 5%)는 그대로 노출된다. 이것이 상태 규칙과의 트레이드다.
 *
 * · `view_anchor_at` 이 이미 찍힌(published) 회차는 **그 값이 이긴다** — V-1 이
 *   `GREATEST(cycle_anchor_at + 지연, 첫 스왑)` 이라 지연만으로는 재현되지 않는다
 *   (실측: 글로벌 8/31 회차 anchor+2일 = 9/02 인데 `view_anchor_at` 은 9/06).
 * · 표면 지연은 `VIEW_ANCHOR_DELAY`(코어 상수) 에서 **생성**한다 — 리터럴 복사 금지.
 * · 상수가 없는 표면(`project` 등 — 관제 원장에 실재하며 2026-09-10 기준 83개)은 노출
 *   리듬이 정의된 적이 없다. 없는 규칙을 지어내지 않고 **종전 `open` 규칙을 그대로 둔다**
 *   (`TREND_HIDDEN_CYCLE_STATUSES`). 그 표면에 지연이 정해지면 상수에 한 줄 추가하는 것만으로
 *   자동 전환된다 — 이 함수는 안 고친다.
 * · 원장 미적용 환경(0059 전)에서는 `true` 를 돌려준다 = 술어 없음 = **값 무변경**
 *   (`summaryLedgerAvailable()` 프로브 — 앵커·드롭 레지스트리와 같은 자세).
 * · 어느 회차에도 **미귀속**인 run 은 그대로 둔다(관제 반영 지연 ≤20분). 아직 안 온 회차를
 *   감추는 것이 목적이지 "원장에 없으면 숨긴다"가 아니다.
 *
 * 2026-09-10 관제 전수 대조(읽기 전용) — 이 교체로 판정이 바뀌는 회차는 **1개뿐**이다:
 * 글로벌 `9db294d8`(open · runs 1,263) 숨김→노출. 웹사이트 open 94개(anchor 9/10 → +1일 =
 * 9/11 미래)와 project open 2개(폴백)는 숨김 유지, published 631·closed 141 은 전부 무변경.
 *
 * ── **원장 숨김**(0070, 2026-09-10) ────────────────────────────────────────
 * 위 규칙에 사유 하나가 **OR 로** 더 붙는다: `c.hidden_reason IS NOT NULL`.
 *
 *   숨김 ⇔ `hidden_reason IS NOT NULL`  **OR**  <표면별 시각 규칙>
 *
 * · **CASE 밖·앞에 둔다.** 안에 넣으면 표면마다 따로 써야 하고(WHEN 절 3벌 + ELSE),
 *   `project` 처럼 규칙이 정의되지 않은 표면에서 조용히 빠진다. 숨김은 표면과 무관한
 *   사람의 판단이므로 **모든 표면에 동일하게** 걸려야 한다.
 * · 컬럼이 없는 배포(0070 미적용)에서는 절이 통째로 빠진다 — 종전 SQL 과 바이트 동일.
 *   판정은 `hiddenCycleColumnsAvailable()` 이 하고, 이 함수는 이미 async 다.
 * · 이 술어는 **run 단위**다. 숨긴 회차에 귀속된 run 의 답변이 전부 빠지므로, 그 주의
 *   미러 집계는 0 이 아니라 **행 자체가 없어진다** — 그래서 화면이 "골짜기" 대신
 *   빈 슬롯을 보고, 그 자리에 갭 마커를 얹을 수 있다(`hiddenCycleSlots`).
 *
 * ── **숨김 범위**(0071, 2026-09-11) ────────────────────────────────────────
 * 숨김이 계열별로 갈린다. 원장의 `hidden_scope`(NULL = `'all'`)가 "무엇을 숨겼나" 를
 * 말하고, 이 함수의 `family` 가 "누가 읽고 있나" 를 말한다.
 *
 *   family = "citation" → 숨긴 회차는 **범위와 무관하게 전부** 제외
 *   family = "mention"  → `hidden_scope = 'all'` 인 회차만 제외
 *                         (`citations` 범위 회차는 언급 값을 그대로 낸다)
 *
 * · **`family` 에 기본값을 두지 않는다.** `ownedBasePrefixes` 와 같은 "콜사이트 명시
 *   필수" 규율이다 — 새 리더가 조용히 틀린 쪽 기본값을 먹으면 숨겨야 할 인용을
 *   내보내거나(고객 오도) 살려야 할 언급을 지운다. 어느 쪽도 화면만 봐서는 안 보인다.
 * · **시각 규칙(`timeRule`)은 계열과 무관하게 그대로**다. 아직 노출일이 안 온 회차는
 *   언급이든 인용이든 보이면 안 된다 — 그건 품질이 아니라 시간의 문제다.
 * · 0071 미적용(`hiddenCycleScopeAvailable() === false`)이면 두 계열의 SQL 이 **서로
 *   같고**, 0070 만 적용된 종전 SQL 과 **문자열 동일**이다(교차 배포 내성).
 */
export type HiddenCycleFamily = "mention" | "citation";

export async function excludeHiddenCycleRuns(
  runIdCol: SQL,
  family: HiddenCycleFamily,
  /**
   * 앵커 축에서 게이트를 **답변 단위**로 옮기기 위한 job_id 표기(계약 §3).
   *
   * 없으면 앵커 축에서도 종전 run 단위 게이트로 간다 — 조용히 틀리는 방향이 아니라
   * "축 전환이 덜 됐다"는 방향이라 안전하지만, 그 자리는 보고 대상이다.
   */
  jobIdCol?: SQL,
  /**
   * `job_id` 가 없는 표(ACR 롤업)용 **run 축** 앵커 게이트. `jobIdCol` 이 있으면
   * 그쪽이 이긴다(답변 단위가 더 정확하다).
   */
  anchorRunIdCol?: SQL,
): Promise<SQL> {
  // 이 술어 자체는 컬럼 가용성과 무관하지만, export 된 async 진입점의 계약이다
  // (scope-aggregates.column-availability.test.ts — "SQL 을 만들기 전에 ensure").
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const bulkVisible = await bulkMirrorRunVisibleSql(runIdCol);
  // ── 앵커 축의 노출 게이트 = **세 축 AND** (계약 §3 · verify-B N-8) ───────────
  //
  //   ① 시간   `anchorViewableSql()`            — `view_anchor_date` 가 왔는가
  //   ② 숨김   `await anchorNotHiddenSql(fam)`  — 0070/0071 회차 숨김
  //   ③ 진행 중 `bulkMirrorRunVisibleSql`        — 대량 미러 적재 중 run  ← **유지**
  //
  // ③ 을 빼면 적재 중인 run 의 반쪽 데이터가 고객 화면에 나온다(N-8 이 축 전환의
  // 차단 조건으로 박아 둔 항목). ①·② 는 답변 단위(`ca.job_id`), ③ 은 run 단위라
  // 조인 키가 다르다 — 그래서 합치지 않고 나란히 AND 한다.
  //
  // 계열 어휘 매핑: 이 함수는 `'mention'|'citation'`(단수), 앵커 게이트는
  // `'mentions'|'citations'|'all'`(복수)이다. 두 어휘를 잇는 자리는 여기 한 곳뿐이다.
  if (anchorAxisKnownEnabled() && (jobIdCol || anchorRunIdCol)) {
    const notHidden = await anchorNotHiddenSql(
      family === "mention" ? "mentions" : "citations",
    );
    const preds = [anchorViewableSql(), notHidden];
    const gate = jobIdCol
      ? anchorJobIdIn(jobIdCol, preds)
      : anchorRunIdIn(anchorRunIdCol!, preds);
    if (gate) return sql`${bulkVisible} AND ${gate}`;
  }
  if (!(await summaryLedgerAvailable())) return bulkVisible;
  // interval 리터럴은 표면 상수(VIEW_ANCHOR_DELAY)에서만 온다 — 사용자 입력 경로가 없다.
  // 표면 이름은 바인드 파라미터로, 지연만 리터럴로 굳힌다(`interval $1` 은 PG 가 안 받는다).
  const delayed = Object.entries(VIEW_ANCHOR_DELAY).map(
    ([surface, delay]) => sql`WHEN ${surface} THEN COALESCE(
           c.view_anchor_at, c.cycle_anchor_at + ${sql.raw(`interval '${delay}'`)}
         ) > now()`,
  );
  const timeRule = sql`CASE c.surface
         ${sql.join(delayed, sql` `)}
         ELSE c.status IN (${sql.join(
           TREND_HIDDEN_CYCLE_STATUSES.map((s) => sql`${s}`),
           sql`, `,
         )})
       END`;
  // 원장 숨김(0070) — 표면과 무관하므로 CASE **밖**에서 OR 로 결합한다(머리 주석).
  // 컬럼 미적용이면 이 절이 없다 = 종전 SQL 과 동일.
  //
  // 범위(0071): 언급 계열은 `hidden_scope='citations'` 회차를 **안 숨긴다**. 0071
  // 미적용이면 두 계열 다 종전 절(`hidden_reason IS NOT NULL`)이라 SQL 이 동일하다.
  const scopeAware = family === "mention" && (await hiddenCycleScopeAvailable());
  const hiddenClause = scopeAware
    ? sql`(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')`
    : sql`c.hidden_reason IS NOT NULL`;
  const hideRule = (await hiddenCycleColumnsAvailable())
    ? sql`(${hiddenClause} OR ${timeRule})`
    : timeRule;
  return sql`${bulkVisible} AND NOT EXISTS (
    SELECT 1 FROM summary_cycle_runs cr
      JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
     WHERE cr.run_id = ${runIdCol}
       AND ${hideRule}
  )`;
}

/**
 * **계열 델타 술어**(0071) — 이미 `excludeHiddenCycleRuns(…, "mention")` 로 걸러진 행
 * 집합에서 **인용 계열이 추가로 빼야 할** run 을 뺀다.
 *
 *   mention 술어 = 제외( hidden ∧ scope='all' )  ∪ 제외( timeRule )
 *   citation 술어 = 제외( hidden )               ∪ 제외( timeRule )
 *   차집합       = 제외( hidden ∧ scope='citations' )   ← 이 함수
 *
 * 즉 `mention 술어 AND 이 술어` ≡ `citation 술어` 다(항등 — 통계적 근사가 아니다).
 *
 * 왜 ⑤ 에서 `excludeHiddenCycleRuns(…, "citation")` 을 그대로 쓰지 않는가:
 * 그 술어는 표면별 `CASE` 시각 규칙을 통째로 안고 있고, ⑤ 는 **행 수가 답변이 아니라
 * 인용**이다(전 이력 allRuns — 수십만 행). 콜드 로드 최대 비용 문장(2026-09-01 실측
 * 3,912 ms)에 표면 CASE 를 행마다 다시 얹는 것은 피한다. 이 술어의 내부 집합은
 * `hidden_scope='citations'` 인 회차의 run 뿐이라 오늘 실측으로 **416 run**이다.
 *
 * 프로덕션 EXPLAIN (ANALYZE, BUFFERS) — ⑤ c2 형태 프록시(TEMP 대신 MATERIALIZED CTE,
 * 루트 무필터 120일, 3회):
 *   · 술어 없음(오늘)      3,297.7 / 3,193.3 / 3,187.0 ms  → 중앙값 **3,193 ms**
 *   · 술어 있음(0071 후)   2,435.6 / 2,409.7 / 3,079.8 ms  → 중앙값 **2,436 ms**
 * 플래너가 `Hash Anti Join (Hash Cond: a.run_id = cr.run_id)` 로 접는다 — 416행 해시
 * 하나를 만들고 끝이라 행마다 재평가하지 않는다(`summary_cycle_runs_run_id_key` UNIQUE).
 * 8/24 인용 행이 집계 전에 빠지므로 **오히려 빨라진다**. TEMP 테이블 경로의 실제 문장은
 * 읽기 전용 하네스에서 EXPLAIN 할 수 없어(read-only tx 는 TEMP 생성 불가) 이 프록시가
 * 근거의 한계다 — 배포 후 `chunk-trace` 로 재확인할 것.
 *
 * 0071 미적용이면 `sql\`true\`` = 절 없음(종전 SQL 과 동일). 0070 미적용도 마찬가지다 —
 * 범위 컬럼이 있는데 사유 컬럼이 없는 상태는 0071 의 가드가 만들어질 수 없게 막는다.
 */
export async function excludeCitationOnlyHiddenRuns(runIdCol: SQL): Promise<SQL> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  if (!(await summaryLedgerAvailable())) return sql`true`;
  if (!(await hiddenCycleColumnsAvailable())) return sql`true`;
  if (!(await hiddenCycleScopeAvailable())) return sql`true`;
  return sql`NOT EXISTS (
    SELECT 1 FROM summary_cycle_runs cr
      JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
     WHERE cr.run_id = ${runIdCol}
       AND c.hidden_reason IS NOT NULL
       AND COALESCE(c.hidden_scope, 'all') = 'citations'
  )`;
}

// ── 추이 주 격자 키 — 측정시각 주 vs **회차 주** (2026-09-17, 제품 결정) ─────
//
// 미러 추이는 주 격자를 `date_trunc('week', a.measured_at)` 로 만든다. 그래서 **드레인이
// 여러 날에 걸친 회차가 두 주로 쪼개진다.** 루트 카탈로그 09-13 15:48Z 회차는 9/13
// 15:49Z~9/16 02:11Z 에 걸쳐 드레인됐고, 그 결과 언급 추이에서:
//
//   · 9/14 주  = 그 회차의 **뒷부분만** (Hyundai 14,962)
//   · 9/7 주   = 그 회차의 앞부분 + 09-08 회차 — 인데 `DISTINCT ON` 이 셀당 최신 1건만
//                남기므로 **09-08 회차가 09-13 답변에 밀려 통째로 소멸**한다(실측: 9/7 주
//                기여 회차가 09-13 단독). 봉우리 뒤 급락으로 보이는 그림의 정체다.
//
// 원장(`summary_cycles.cycle_week`)은 그 회차를 이미 `2026-09-14` 로 들고 있다. 즉
// "회차가 어느 주에 속하는가" 의 정본은 원장이고, 미러의 `date_trunc(measured_at)` 만
// 그것을 모른다. 이 키를 갈아 끼우면 **값·술어·dedup 규칙을 하나도 안 바꾸고** 주 배정만
// 고쳐진다 — `DISTINCT ON` 의 주 자리도 같은 키가 되므로 09-08 회차도 되살아난다.
//
// ── 원천은 **원장 한 곳**이다 (2026-09-17 실데이터 판단) ────────────────────
//
// ⭐ **이 블록이 이 변경의 수치 정본이다.** `screens.ts` 의 `S2.mentionTrend` 블록과
//    테스트 주석은 여기를 가리키기만 한다 — 같은 수치를 두 곳에 적으면 갈린다
//    (docs/development-guide.md "수치를 두 곳에 적지 말 것").
//
// ⚠️ 모수는 **리더가 실제로 읽는 답변셋**이다. `status='completed'` 까지만 건 254,223 은
//    모수가 아니다 — 거기서 `region NOT IN ('ID')` 로 249,101, 루트 카탈로그 게이트로
//    **216,908** 이 남는다(글로벌 루트 · 120일 창 · 무필터, 검증자 독립 재계산).
//
// 후보 셋을 그 답변셋 위에서 재 봤다:
//   ① 원장 `summary_cycles.cycle_week` (`summary_cycle_runs` 로 run 매칭)
//      **216,908 / 216,908 (100%)** 매칭. 미매칭 0.
//   ② `scope_runs.cycle_anchor_at` 의 KST 주 절단
//      ①과 거의 같지만(원장 20/20 global) **원장의 주 규칙이 표면마다 다르다** —
//      `cycle_week` vs KST 절단 일치율은 global 20/20 · website 797/797 이지만
//      **project 는 132/145**(그쪽은 UTC 절단이 145/145 다). 즉 KST 는 규칙이 아니라
//      global·website 에서 우연히 맞는 관측이고, 폴백으로 두면 표면을 옮길 때 조용히 틀린다.
//   ③ 종전 `date_trunc('week', a.measured_at)`
//      ①과 **64,425건(29.70%)이 불일치** — 그 답변들이 자기 회차의 주가 아닌 주에 찍힌다.
//      이것이 이 버그의 크기다.
// → ② 를 **버렸다**. 원천은 ① 이고, 원장에 없는 run 만 ③ 으로 떨어진다(오늘 0건, 종전 동작).
//
// 회차 단위로 보면 창 안 **16회차 중 7개**가 주 경계를 넘어 드레인된다. 그중 하나
// (anchor 07-11)는 답변이 **100% 원장 주 밖**이라, 종전 격자에서는 그 회차의 값이
// 통째로 남의 주에 실려 있었다.
//
// ⚠️ 행이 불어나지 않는 근거는 **제약**이다: `summary_cycle_runs_run_id_key` UNIQUE(run_id)
//    + `summary_cycles_pkey` PK(cycle_id). 데이터 관측이 아니라 인덱스가 보장한다.
//
// 같은 `date_trunc('week', a.measured_at)` 패턴이 인용 추이·KPI 탭·웹사이트·프로젝트
// 추이에도 있다 — 그래서 식이 아니라 **재사용 가능한 조각**으로 뽑는다. 이번 PR 은
// 언급 탭 추이 한 곳에만 붙인다.

/** 주 격자 키의 원천. `measured` = 종전(측정시각 주) · `cycle` = 원장 회차 주. */
export type TrendWeekSource = "measured" | "cycle";

/**
 * 실제로 적용된 원천. `anchor` 는 앵커 축(0077 `ca.anchor_week`)이고 **요청과 무관하게**
 * 축 판정이 켜져 있으면 그것이 이긴다 — 한 요청 안에서 카드와 추이가 다른 시계를
 * 보면 안 되기 때문이다.
 */
export type TrendWeekApplied = TrendWeekSource | "anchor";

export interface TrendWeekKey {
  /** `FROM scope_answers a …` 뒤에 그대로 이어 붙이는 조인 조각. `measured` 면 빈 SQL. */
  join: SQL;
  /** 주 격자 키 식 — 종전 `date_trunc('week', a.measured_at)` 이 있던 자리에 그대로 쓴다. */
  key: SQL;
  /** 실제로 적용된 원천. 원장 미적용 환경에서는 `cycle` 을 요청해도 `measured` 다. */
  applied: TrendWeekApplied;
  /**
   * 측정 폴백(원장 미귀속 run · 원장 미적용 · `measured` 요청)의 **표면 격자**
   * (2026-09-28 main #300 — `mirrorWeekKey` 머리 주석). 글로벌 = `anchorKst`(회차 앵커의
   * KST 주), 웹사이트·프로젝트 = `measured`(종전 식 문자 그대로). 앵커 축이면 쓰이지 않는다.
   */
  grid: MirrorWeekGrid;
}

/**
 * 주 격자에 맞는 dedup 키 — 앵커 축이면 **회차 단위**로 잘게 자른다.
 *
 * 버킷(`anchor_week`)보다 dedup 키(`round_date`)가 잘아야 한다: 한 주에 회차가 둘이면
 * 주 버킷 하나에 회차 둘이 합산돼야 하고(계약 §3 "회차 간 합산"), 주 단위로 dedup 하면
 * 앞 회차가 뒤 회차에 밀려 통째로 소멸한다(2026-09-17 언급 추이에서 실증된 형태).
 */
function trendCellKeys(wk: TrendWeekKey, alias: CellAliasPrefix = "a."): CellSnapshotKeys {
  return wk.applied === "anchor"
    ? anchorCellSnapshotKeys({ alias })
    : cellSnapshotKeys({ alias, bucket: wk.key });
}

/**
 * 주 격자 키 조각. `measured` 는 **종전 식과 문자 그대로 같다**(문장 텍스트 무변경 →
 * pg_stat_statements 정규화 텍스트도 그대로라 배포 전후 비교가 성립한다).
 *
 * `cycle` 은 타입을 `date` 로 고정한다 — 종전 `date_trunc('week', timestamptz)` 는
 * **세션 TZ 의존**이고 `cycle_week` 는 `date` 라, 둘을 `COALESCE` 로 섞으면 암묵 캐스트가
 * 세션 TZ 를 탄다. 양쪽을 `::date` 로 맞춰 `to_char(…, 'YYYY-MM-DD')` 결과를 TZ 무관하게 둔다.
 * (UTC 세션에서 두 식의 출력은 같다 — 즉 폴백 경로의 값은 종전과 동일하다.)
 */
export async function trendWeekKey(
  source: TrendWeekSource,
  /**
   * 측정 폴백의 표면 격자(2026-09-28 main #300) — 호출부가 `mirrorWeekGridFor(projectCtx)`
   * 로 넘긴다. 생략 = `measured`(종전 식 문자 그대로)라 웹사이트·프로젝트·드릴다운은
   * 인자를 안 넘겨도 문장이 종전과 같다.
   */
  grid: MirrorWeekGrid = "measured",
  /** 답변 테이블 별칭. 조인 별칭은 충돌을 피해 `_cw*`·`_wk*` 로 고정한다. */
  answerAlias = "a",
): Promise<TrendWeekKey> {
  // 진입점 계약 — SQL 조각을 만들기 **전에** 프로브를 끝낸다
  // (`scope-aggregates.column-availability.test.ts` 가 이 순서를 단언한다).
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const a = sql.raw(answerAlias);
  // 앵커 축(옵트인)이 켜져 있으면 **요청 원천과 무관하게** 그것이 이긴다. 원장
  // `cycle_week` 와 `ca.anchor_week` 는 둘 다 "회차가 속한 주"이지만 절단 규칙이 달라
  // (원장은 표면마다 다르다 — `trendWeekKey` 머리 주석의 ② 각주) 섞으면 조용히 갈린다.
  if (anchorAxisKnownEnabled()) {
    return {
      join: anchorJoinSql(sql`${a}.job_id`),
      key: anchorWeekSql(),
      applied: "anchor",
      grid,
    };
  }
  // 측정 폴백 = **표면별 주 격자**(2026-09-28 main #300). `measured` 는 종전
  // `date_trunc('week', a.measured_at)` 과 문자 그대로 같고 조인이 없다. 글로벌
  // (`anchorKst`)은 run 앵커의 KST 주로 — 원장 미귀속·원장 미적용·`measured` 요청이
  // 전부 이 식으로 떨어진다. 원장(`cycleWeekForSurfaceExpr`)도 같은 표면 규칙이라
  // 원장 경로와 폴백 경로가 한 격자(월요일)에 선다.
  const fb = mirrorWeekKey(grid, answerAlias);
  // 원장 미적용 환경(신규 DB·로컬)에서는 폴백 격자로 떨어진다 — 조인할 표가 없다.
  if (source !== "cycle" || !(await summaryLedgerAvailable())) {
    return { join: fb.join, key: fb.key, applied: "measured", grid: fb.grid };
  }
  return {
    join: sql` LEFT JOIN (
        SELECT cr.run_id, c.cycle_week
        FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
      ) _cw ON _cw.run_id = ${a}.run_id${fb.join}`,
    key: sql`COALESCE(_cw.cycle_week, (${fb.key})::date)`,
    applied: "cycle",
    grid: fb.grid,
  };
}

/** 자리 × 엔진 하나. 필드 이름은 `StandardTrendBucket` 의 같은 이름과 같은 뜻이다. */
export interface StandardTrendEnginePoint {
  engine: string;
  answers: number;
  trackedAnswers: number;
  totalMentions: number;
  trackedMentions: number;
  sentMentions: number;
  positiveMentions: number;
  /** 서수 합·개수 — 평균은 소비자가 나눈다(평균의 평균 금지). */
  rankSum: number;
  rankedAnswers: number;
}

export interface StandardTrendBucket {
  bucketStart: string; // 버킷 시작일 ISO (week = 해당 주 월요일, day = 그 날, cycle = 회차 anchor 일)
  /**
   * **회차 버킷 표시자**(PR③). 집계층 경로(`summaryWebsiteTrend`·글로벌
   * `summary-global-trend-read`)만 채운다 — 미러 경로는 항상 `undefined` 다. 값이 있으면
   * 이 버킷의 x 는 `date_trunc(unit, measured_at)` 주/일 격자가 아니라 **회차 anchor** 다.
   *
   * 화면 계약: 값이 있으면 `fillGaps`/`fillTrendGaps` 를 **건너뛴다** — 회차가 없는 주는
   * 점이 없는 것이 맞고(주 격자로 채우면 없던 자리를 만든다), 한 주에 회차가 둘이면 점도
   * 둘이다. Δ 는 `applyTrendDeltas` 그대로(값 있는 마지막 두 점 = **직전 회차 대비**).
   * 축이 바뀌었다는 사실을 화면까지 나르는 유일한 신호라, 값(anchor ISO)을 겸한다.
   */
  cycleAnchorAt?: string;
  /**
   * **축 on 의 x축 라벨 날짜**(`round_date`, `YYYY-MM-DD`). 버킷 키(`bucketStart`)는
   * 주 격자(`anchor_week`, 월요일)인데 화면이 찍어야 하는 날짜는 그 회차의 **귀속
   * 날짜**다 — website 는 금요일이라 둘이 다르다(글로벌은 같다).
   *
   * 달력에서 고르는 날짜 · 카드 기준일 · 추이 라벨이 같은 날짜여야 한다는 것이 이
   * 전환의 목적이다(2026-09-20 관찰: website 마지막 점 `9. 14.` vs 기준일 `09-11`).
   * 축 off 면 `undefined` = 종전 라벨 규칙.
   */
  roundDate?: string;
  /**
   * **수집 오류 회차 표시자**(2026-09-10). 값이 있으면 이 버킷은 수집이 깨진 회차라
   * 화면이 측정값 대신 음영 + 안내 문구를 낸다. 측정값 필드는 전부 `null` 이어야 한다
   * (계약 정본: lib/viz/trend-gap.ts).
   */
  gap?: TrendGap;
  /**
   * **공용 추이 격자(D5)가 만든 자리인가**(2026-09-20). 배열 전체가 이 표식을 가지면
   * 화면은 자기 채움(`fillGaps`/`fillTrendGaps`)을 건너뛴다 —
   * `lib/period/trend-grid-axis.ts::isTrendGridApplied`.
   *
   * ⚠️ 판정을 **스위치가 아니라 데이터**로 두는 이유가 계약이다. 키가 켜져 있어도 격자를
   *    안 얹는 경로가 둘 있다(일 버킷 · 자리를 못 세운 경우). 스위치로 물으면 그 두
   *    경로에서 종전 채움이 통째로 사라진다.
   */
  gridSlot?: true;
  /**
   * **엔진 분해**(2026-09-20). 사실표 경로(`toSeries`)만 채운다 — 미러는 `undefined`.
   *
   * 있으면 엔진별 라인도 히어로 주 계열과 **같은 배열·같은 자리·같은 갭 판정**을 쓴다.
   * 없으면 그 차트는 종전 미러 버킷으로 간다 = 한 차트 안에서 원천이 섞이지 않는다.
   * 직렬화 가능한 배열이다(`unstable_cache` 셀 규약 — Map 금지).
   */
  engines?: StandardTrendEnginePoint[];
  answers: number; // 버킷 내 분석 답변 수
  trackedAnswers: number; // 추적 브랜드가 1개 이상 등장한 답변 수
  totalMentions: number;
  trackedMentions: number;
  // ③ 우호도 입력 — 멘션 sentiment 카운트(신호) 합. 답변 수가 아니다.
  sentMentions: number; // 추적 브랜드 멘션의 sentiment 신호 합 (P+NE+NG+MX)
  positiveMentions: number; // 그 중 positive 신호 합 (분자)
  avgPosition: number | null;
  totalCitations: number;
  ownedCitations: number;
  /**
   * **글로벌 ⑤ 분자**(제품 책임자 2026-09-29) — 출처 카테고리 `Official (HMG)` 인용 수.
   * 글로벌 리더(사실표 `toSeries` · 미러 `aggregateStandardTrendFromMirror` 의 글로벌 호출)만
   * 싣는다. website·project 추이에는 없고 ⑤ 는 종전 `ownedCitations` 다.
   * 소비는 `lib/kpi/overview-card-values.ts::citationShareNumerator` 로만.
   */
  officialHmgCitations?: number;
  // coverage — 불규칙 cadence 를 숨기지 않기 위한 정직성 신호
  measuredDays: number; // 버킷 안에서 실제 측정이 일어난 distinct 일수
  firstAt: string | null;
  lastAt: string | null;
}

export async function aggregateStandardTrendFromMirror(
  filters: StandardFilters = {},
  unit: BucketUnit = "week",
  projectCtx: string | string[] | undefined,
  // 공식(당사) 판정 베이스 — 콜사이트 명시 필수 (aggregateStandardFromMirror 참조).
  ownedBasePrefixes: string[],
  // '가장 긴 접두가 이긴다'의 형제 모집단 — 선언 base(website_prompts.owned_base_url)를
  // 쓸 때는 그 사이트의 선언 목록을 넘긴다. 미지정이면 카탈로그(종전 동작).
  ownedSiblingUniverse?: string[],
  // website 전용 — 타겟 URL 집합에 일치하는 인용을 자사로 판정(websiteTargetOwnedClause).
  websiteTargetsOwned = false,
  // 실행 예산(S1 extras). 생략하면 종전 동작 — 문장 상한도 마감도 없다.
  budget: AnswerSetBudget = {},
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
  // **글로벌 전용** ⑤ 분자 — 공식(HMG) 그룹 키 목록(`aggregateStandardFromMirror` 같은 인자
  // 주석). 주면 버킷마다 `officialHmgCitations` 를 싣는다.
  officialGroupKeys?: readonly string[],
): Promise<StandardTrendBucket[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  // `trendRoundFloor: true` 의 근거는 **아래 `bucketed` 가 `trendWindowFloor()` 를 반드시
  // 얹는다는 것**이다(같은 `round_date` 바닥). 그 줄을 지우면 이 플래그도 함께 내려야 한다.
  const W = answerWhere(filters, projectCtx, {
    allRuns: true,
    hiddenFamily: "all",
    trendRoundFloor: true,
    // 이 문장은 답변셋 생성 시 `ca`(앵커)를 조인한다(아래 `join:`). 축이 켜져 있으면
    // dim 파생표도 같은 자리에 붙이므로 술어는 semi-join 없이 조인 컬럼을 본다.
    caJoined: trendMirrorJoins().joined,
  });
  const field = BUCKET_FIELD[unit] ?? "week"; // 화이트리스트
  // measured_at 이 있는 답변만 시계열에 포함 (없으면 버킷팅 불가).
  // 120일 창 — TREND_WINDOW_DAYS 머리 주석 참조. 이 답변셋이 아래 5개 문장
  // (①답변/②언급/③감정/④순위/⑤인용)의 공통 모수라, 여기 한 번만 걸면 된다.
  // 뷰 앵커 전 회차 제외도 같은 자리에 건다 — excludeHiddenCycleRuns 머리 주석.
  // ⚠️ 이 리더는 화면 추이(week)와 **카드 Δ 롤업(day)** 이 공유한다. 그래서 Δ 의
  // 비교 시점에서도 열린 회차의 반쪽이 함께 사라진다(의도된 효과).
  // 계열 = **언급**(0071). 이 답변셋은 ①~④(답변·언급·감정·순위)의 공통 모수이고,
  // 그 넷은 `hidden_scope='citations'` 회차에서도 값이 정상이다(8/25 실측: 언급 있는
  // 답변 chatgpt 83.8% · gemini 93.5%). ⑤(인용)만 아래 c2 CTE 에서 한 겹 더 좁힌다.
  // 조인 조각과 "조인했다" 를 **한 객체**에서 받는다(`trendMirrorJoins` 머리 주석의
  // 차단 결함). `anchorTrend` 는 이 줄 아래에서 선언되므로(TDZ) 여기서 직접 부른다.
  const mirrorJoins = trendMirrorJoins();
  const bucketed = sql`${W} AND a.measured_at IS NOT NULL AND ${trendWindowFloor(
    sql`a.measured_at`,
    sql.raw("a.job_id"),
    mirrorJoins.joined,
    mirrorJoins.joined,
    // 격자가 자리 바닥을 넘기는 호출부다 — `TREND_GRID_FLOOR_DAYS` 머리 주석.
    // **단위를 넘긴다**(W2): `day` 는 격자를 안 얹으므로 바닥도 넓히지 않는다.
    trendFloorDays(unit),
  )}
    AND ${await excludeHiddenCycleRuns(sql`a.run_id`, "mention", sql`a.job_id`)}`;
  // ⑤ 전용 — 이 답변셋에서 **인용 계열이 추가로 빼야 할** run(= 범위가 citations 인 숨긴
  // 회차). 위 술어가 이미 'all' 범위와 시각 규칙을 걷어냈으므로, 여기 이 델타만 더하면
  // 결과는 `excludeHiddenCycleRuns(…, "citation")` 과 **같은 행 집합**이다.
  const citOnlyHidden = await excludeCitationOnlyHiddenRuns(sql`a.run_id`);
  // DISTINCT ON / ORDER BY 가 **문자적으로 동일한 식**이어야 하므로(바인드 파라미터가
  // 두 번 들어가면 Postgres 가 "must match initial ORDER BY" 로 거부한다) 화이트리스트
  // 통과한 field 를 리터럴로 굳혀 쓴다.
  // ── 버킷·dedup 의 축 (앵커 축은 옵트인) ──────────────────────────────────
  // off: 버킷 = 표면별 주 격자(`mirrorWeekKey` — 글로벌은 회차 앵커의 KST 주, 웹사이트·
  //      프로젝트는 종전 `date_trunc('week', a.measured_at)` 문자 그대로, 2026-09-28 main
  //      #300) · `day` 는 종전 측정일 격자(대시보드 Δ 롤업 전용) · dedup 키 = (버킷, 셀)
  //      · 동점 measured_at
  // on : 버킷 `ca.anchor_week`(day 면 `ca.round_date`) · dedup 키 = (**회차**, 셀)
  //      · 동점 `ca.measured_at_orig`
  // 버킷과 dedup 키가 **갈리는 것이 의도**다: 한 주에 회차가 둘이면 주 버킷 하나에
  // 회차 둘이 합산돼야 하고(계약 §3 "회차 간 합산"), dedup 은 그보다 잘게 회차
  // 단위여야 앞 회차가 뒤 회차에 밀려 소멸하지 않는다(2026-09-17 언급 추이의 형태).
  const anchorTrend = anchorAxisKnownEnabled();
  const weekKey =
    !anchorTrend && field === "week" ? mirrorWeekKey(mirrorWeekGridFor(projectCtx)) : null;
  const bkt = weekKey
    ? weekKey.key
    : periodBucketSql(field, sql`a.measured_at`, { anchorAxis: anchorTrend });
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. 아래 `withAnswerSet` 의 `dedupe`
  // 로 넘어가 TEMP 답변셋 생성 시점에 걸린다(이 함수 자신은 DISTINCT ON 을 적지 않는다).
  // 이 사본은 버킷이 키 **맨 앞**이다 — dedup 의 주 자리가 버킷 키와 같은 식이다.
  const trendKeys = anchorTrend
    ? anchorCellSnapshotKeys({ alias: "a." })
    : cellSnapshotKeys({ alias: "a.", bucket: bkt, bucketFirst: true });

  // 필터된 답변셋(_answer_set)을 트랜잭션에서 1회만 계산 — withAnswerSet 참조.
  // 버킷도 여기서 미리 계산해 문장마다 date_trunc 를 반복하지 않는다.
  //
  // 버킷별 스냅샷 (2026-09-01, 제품 결정 "추이를 카드에 맞춘다"): 버킷 안에서
  // 셀(프롬프트×엔진×지역)당 **최신 답변 1개**만 남긴다. 종전에는 그 기간의 전
  // 답변을 셌기 때문에, 한 주에 재측정된 셀이 이중 계상돼 같은 화면의 카드와
  // 그래프 호버가 소수점 한 자리에서 어긋났다(2026-09-01 실측, Kia·KR 웹사이트:
  // 카드 300답변/1,930인용 vs 마지막 주 버킷 497답변/1,950인용 → ⑤·⑥ 0.1~0.2%p).
  // 답변분석 추이(readCitationDomainDayCounts, 2026-08-12 결정)가 같은 이유로
  // 이미 이 규칙을 쓰고 있었다 — KPI 추이만 남아 있던 것을 맞춘다.
  return withAnswerSet(
    // `a.run_id` 는 ⑤(인용)의 계열 술어가 쓴다(0071). 투영에 없으면 그 문장이 런타임에만
    // 42703 으로 터진다 — 투영 제거 뮤테이션은 `scope-aggregates.hidden-cycle.test.ts` 가 잡는다(`answer-set-run-id.test.ts` 는 본문 리터럴 템플릿만 훑어 `${citOnlyHidden}` 안의 참조를 못 본다 — 검증 F2).
    // 축 on 이면 **라벨 열**(귀속 날짜)도 함께 싣는다 — 버킷 키는 주(`anchor_week`)
    // 인데 화면이 찍어야 하는 날짜는 그 회차의 귀속 날짜다(website 는 금요일).
    // 투영에서 빠지면 아래 집계 문장이 런타임에만 42703 으로 터진다.
    // 유닛 판정(키 on)은 ⑤ 가 인용 행의 **프롬프트**를 봐야 하므로 `a.prompt_id` 를 더 싣는다
    // (키 off 면 조각이 비어 투영이 종전과 바이트 동일).
    anchorTrend
      ? sql`a.job_id, a.run_id, a.measured_at, ${bkt} AS bucket, ${anchorRoundDateSql()} AS round_date${units ? sql`, a.prompt_id` : sql``}`
      : sql`a.job_id, a.run_id, a.measured_at, ${bkt} AS bucket${units ? sql`, a.prompt_id` : sql``}`,
    bucketed,
    async (db) => {

  // ① 버킷별 답변/추적/커버리지 (answer-level)
  const ansRows = (await db.execute(sql`
    WITH ans AS (
      SELECT a.measured_at,
        a.bucket,${anchorTrend ? sql`
        a.round_date,` : sql``}
        EXISTS (
          SELECT 1 FROM scope_mentions m
          WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}
        ) AS has_tracked
      FROM _answer_set a
    )
    SELECT bucket,
      count(*)::int AS answers,
      count(*) FILTER (WHERE has_tracked)::int AS tracked,
      count(DISTINCT date_trunc('day', measured_at))::int AS measured_days,${anchorTrend ? sql`
      to_char(max(round_date), 'YYYY-MM-DD') AS round_label,` : sql``}
      min(measured_at) AS first_at, max(measured_at) AS last_at
    FROM ans GROUP BY bucket ORDER BY bucket
  `)) as unknown as Array<{
    bucket: string; answers: number; tracked: number;
    measured_days: number; first_at: string | null; last_at: string | null;
    round_label?: string | null;
  }>;

  // ② 버킷별 브랜드 언급 (SOV) — 모수 법칙은 men/언급표와 동일 통일:
  // rollup + 전역 표기 해석(ROLLUP_NAMES) + 비경쟁 제외 (2026-08 정합).
  //
  // ── 성능: 답변셋 조인을 먼저 확정한다 (2026-09-01) ──────────────────────────
  // 이 문장이 대시보드 콜드 로드의 단일 최대 비용이었다. 프로덕션 EXPLAIN
  // (ANALYZE, BUFFERS · admin 무필터 · 84일 · postgres 롤 · TEMP TABLE 경로) 실측:
  //
  //   HashAggregate                                27,506 ms
  //     └ Hash Join  (m.job_id = a.job_id)         25,788 ms   rows 776,035
  //         └ Hash Left Join (names)               25,298 ms   rows 1,878,223  ← 전부 여기
  //         └ names(ROLLUP_NAMES) 빌드                  18 ms   rows 1,508
  //   Buffers: shared **hit** 75,997 (디스크 IO 0) → 순수 식 평가 CPU.
  //
  // 두 가지가 겹쳐 있었다:
  //  (a) 플래너가 `scope_mentions ⟕ names` 를 **먼저** 하고 그 뒤에 `_answer_set`
  //      을 조인했다. 즉 비싼 식이 2,086,875행에 걸렸는데, 답변셋과 맞는 행은
  //      853,822 뿐이다(2.44배 낭비). 추정이 틀려서다 — 플래너는 답변셋 조인이
  //      행을 안 줄인다고 봤다(est 1,035,397 → 1,035,397).
  //  (b) 그 비싼 식이 실제로는 두 덩어리다: canonRollupSql(정규식 3개) 9.3s +
  //      비경쟁 제외(38-branch CASE × 28회) 9.9s.
  //
  // 그래서 `_answer_set` 조인과 canonRollupSql 을 **OFFSET 0 배리어** 서브쿼리
  // 안에 넣는다. OFFSET 은 서브쿼리 pull-up 을 막으므로 조인 순서가 고정되고
  // (`MATERIALIZED` CTE 와 달리) 스트리밍이라 temp 스필이 없다. rid 도 여기서
  // 한 번만 계산돼 바깥의 조인·FILTER 가 재평가하지 않는다.
  // 표기·제외 키는 names 쪽 사전 계산(ROLLUP_NAMES_BARE) 을 쓴다.
  //
  // 프로덕션 실측 (같은 조건 · 교차 3회 중앙값 · 산출 동치 md5
  // dd25b80c3ea16cfaa29c9b4eeec30db7 · 10행):
  //   종전                                 27,855 ms
  //   제외 술어 CASE 접기만                21,511 ms
  //   + 조인 순서 고정(MATERIALIZED)        8,031 ms
  //   + names 쪽 표기 사전계산              4,481 ms
  //   + 배리어를 OFFSET 0 로 (현재)         3,912 ms   → **7.1배**
  const mentionRows = (await db.execute(sql`
    WITH names AS ${ROLLUP_NAMES_BARE}
    SELECT x.bucket AS bucket,
      sum(x.mention_count)::int AS total_mentions,
      sum(x.mention_count) FILTER (WHERE x.rid IN ${trackedRollupIn(filters)})::int AS tracked_mentions
    FROM (
      SELECT a.bucket AS bucket, m.mention_count, m.brand,
        ${canonRollupSql(filters)} AS rid
      FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
      WHERE m.brand_rollup_entity_id IS NOT NULL
      OFFSET 0
    ) x
    LEFT JOIN names n ON n.entity_id = x.rid
    WHERE COALESCE(n.brand, x.brand) IS NOT NULL
      AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
    GROUP BY x.bucket
  `)) as unknown as Array<{ bucket: string; total_mentions: number; tracked_mentions: number }>;

  // ③ 버킷별 sentiment — 멘션 단위 긍정률 입력(Core ③ 카드와 동일 정의).
  //    답변별 우세 분류가 아니라 4계열 신호 카운트의 단순 합이다.
  const sentRows = (await db.execute(sql`
    SELECT a.bucket AS bucket,
      COALESCE(sum(m.sentiment_positive), 0)::int AS p,
      COALESCE(sum(m.sentiment_neutral), 0)::int AS ne,
      COALESCE(sum(m.sentiment_negative), 0)::int AS ng,
      COALESCE(sum(m.sentiment_mixed), 0)::int AS mx
    FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
    WHERE ${trackedRollupPredicate(filters)}
    GROUP BY a.bucket
  `)) as unknown as Array<{
    bucket: string; p: number; ne: number; ng: number; mx: number;
  }>;

  // ④ 버킷별 position (추적 브랜드 최선 순위; 순위 미진입 답변 제외 — Core ④ 카드와
  //    동일 정의. 2026-07-29 이전에는 미랭크를 100으로 채워 추이선이 40~65 대를
  //    그렸고, 같은 화면 카드는 6위대를 표시하는 모순이 있었다.)
  //    2026-09-06: 값의 단위를 브랜드 내 순위(ownBrandRankPerJobSql)로 — 카드·언급 탭과
  //    같은 문장. 과거 버킷까지 소급 재계산되므로 카탈로그 팽창 이전·이후가 한 눈금.
  const posRows = (await db.execute(sql`
    WITH pos AS (
      SELECT a.bucket, r.rk AS tp
      FROM _answer_set a
      LEFT JOIN ${ownBrandRankPerJobSql(filters)} r ON r.job_id = a.job_id
    )
    SELECT bucket, round(avg(tp)::numeric, 1) AS avg_position
    FROM pos GROUP BY bucket
  `)) as unknown as Array<{ bucket: string; avg_position: string | null }>;

  // ⑤ 버킷별 인용 (owned share) — 전체 이력(allRuns)이라 이 쿼리가 인라인
  // 정규화 반복의 최대 피해 지점이었다 (113k행 × ~2,000 regex → statement
  // timeout 57014, 2026-07-02 dev 실측). 정규화·판정은 DISTINCT url 당 1회
  // (2026-08-27: 행당 1회로도 부족 — 전 이력 인용은 행이 수십만이라 regex 6회
  // ×행이 pg_stat_statements 최상위(평균 23.8s)였다. URL 중복 ~3x 를 접는다).
  // 유닛 판정(키 on)은 판정을 인용 행으로 내린다 — 근거·형태는 코어 ⑤ 쪽 주석 참조.
  const ownedClause = websiteTargetOwnedClause(
    ownedBasePrefixClause(sql`base`, ownedBasePrefixes, ownedSiblingUniverse),
    sql`base`, "base", projectCtx, filters, websiteTargetsOwned,
  );
  const ownedRow = units
    ? sql`COALESCE(${websiteUnitOwnedTargetClause(sql`ub.base`, sql`ub.cnorm`, "wup")}, false)`
    : sql`COALESCE(ub.owned, false)`;
  // 공식(HMG) 분자(글로벌) — 카드 미러 경로와 같은 형태(그룹 키 식 + JS 가 고른 목록).
  const officialGk = officialGroupKeys
    ? sql`, ${citationGroupKeySql(sql`c.domain`, sql`c.url`)} AS gk`
    : sql``;
  const officialCol = officialGroupKeys
    ? sql`,
      count(*) FILTER (WHERE c2.gk = ANY(${sql.param([...officialGroupKeys])}::text[]))::int AS official`
    : sql``;
  const citRows = (await db.execute(sql`
    WITH ${units ? sql`${websiteUnitPromptCtes(units)},
    ` : sql``}c2 AS MATERIALIZED (
      SELECT a.bucket AS bucket, c.url${units ? sql`, a.prompt_id` : sql``}${citationNormProjection(sql`c.url_base_norm`, "bk")}${units ? citationNormProjection(sql`c.url_norm`, "nk") : sql``}${officialGk}
      FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
      WHERE ${citOnlyHidden}
    ),
    ub AS MATERIALIZED ${
      units ? citationBaseByUrlSelect(sql`c2`) : citationOwnedByUrlSelect(sql`c2`, ownedClause)
    }
    SELECT c2.bucket,
      count(*)::int AS total,
      count(*) FILTER (WHERE ${ownedRow})::int AS owned${officialCol}
    FROM c2 LEFT JOIN ub ON ub.url = c2.url${
      units ? websiteUnitPromptJoin(sql`c2.prompt_id`) : sql``}
    GROUP BY c2.bucket
  `)) as unknown as Array<{ bucket: string; total: number; owned: number; official?: number }>;

  // bucket(ISO date) 키로 병합 — ①의 버킷 집합이 기준(답변이 없으면 KPI도 없음).
  const key = (b: string) => new Date(b).toISOString().slice(0, 10);
  const mention = new Map(mentionRows.map((r) => [key(r.bucket), r]));
  const sent = new Map(sentRows.map((r) => [key(r.bucket), r]));
  const pos = new Map(posRows.map((r) => [key(r.bucket), r]));
  const cit = new Map(citRows.map((r) => [key(r.bucket), r]));

  return ansRows.map((a) => {
    const k = key(a.bucket);
    const m = mention.get(k);
    const s = sent.get(k);
    const p = pos.get(k);
    const c = cit.get(k);
    return {
      bucketStart: k,
      answers: num(a.answers),
      trackedAnswers: num(a.tracked),
      totalMentions: num(m?.total_mentions),
      trackedMentions: num(m?.tracked_mentions),
      sentMentions: num(s?.p) + num(s?.ne) + num(s?.ng) + num(s?.mx),
      positiveMentions: num(s?.p),
      avgPosition: p?.avg_position != null ? Number(p.avg_position) : null,
      totalCitations: num(c?.total),
      ownedCitations: num(c?.owned),
      ...(officialGroupKeys ? { officialHmgCitations: num(c?.official) } : {}),
      measuredDays: num(a.measured_days),
      firstAt: a.first_at ? new Date(a.first_at).toISOString() : null,
      lastAt: a.last_at ? new Date(a.last_at).toISOString() : null,
      // 축 on 의 x축 라벨.
      //
      // ⚠️ **정정(2026-09-20 미러 실측)** — 종전 주석은 "한 주 버킷에 귀속 날짜가 둘일
      //    수 없다는 것은 감사(`project_week_split = 0`)가 보장한다" 였다. **프로젝트
      //    표면에서는 성립하지 않는다**: `anchor_week` 09-14 에서 프로젝트 주 42개 중
      //    **23개가 다자리**이고 한 주 최대 3자리다(07-20·07-27 도 2자리씩). 그러므로
      //    `max` 는 방어가 아니라 **실제로 골라야 하는 값**이다.
      //
      // ⚠️ 그리고 이 `max` 의 모집단은 **필터된 답변셋**(`_answer_set`)이다 — 사용자
      //    필터·기간·답변 단위 숨김을 통과한 답변만 본다. 그래서 이 라벨은 원장의 그 주
      //    마지막 회차와 **다를 수 있다**(그 회차의 답변이 전부 걸러지면 앞 회차 날짜가
      //    된다). 추이 격자가 이 값을 자리 키로 곧장 쓰지 않고 **주 키로 재시도**하는
      //    이유가 그것이다(`lib/summary/read/trend-grid-buckets.ts::applyTrendGridToBuckets`
      //    의 2단 해소). SQL 은 그대로 둔다 — 고칠 것은 이 값의 **쓰임**이지 값이 아니다.
      ...(a.round_label ? { roundDate: a.round_label } : {}),
    };
  });
  },
    {
      ...budget,
      // 앵커 축이면 dedup 키·버킷 식이 `ca.*` 를 참조하므로 답변셋 생성 문장에
      // 조인이 함께 있어야 한다(`AnswerSetBudget.join` 의 계약 — 버킷 계산이 그
      // 문장 안이라 조인도 같은 자리다). off 면 빈 조각이라 문장이 종전과 동일하다.
      // ⚠️ `answerWhere(..., { caJoined })` 와 **함께 간다** — 술어가 `d.*` 를 보는데
      //    조인이 없으면 42P01 이다. 격자 키가 꺼져 있으면 `trendDimJoinSql()` 이 빈
      //    조각이라 문장이 종전과 바이트 동일하다(배선 가드가 둘의 동행을 고정).
      // 축 off 의 글로벌 주 격자(`anchorKst`)는 run 앵커 조인(`_wk`)을 같은 자리에 더한다
      // (2026-09-28 main #300). `measured` 면 빈 조각이라 종전 문장 그대로다.
      join: anchorTrend
        ? sql`${anchorJoinSql(sql.raw("a.job_id"))}${mirrorJoins.join}`
        : weekKey?.grid === "anchorKst"
          ? sql`${budget.join ?? sql``}${weekKey.join}`
          : budget.join,
      dedupe: {
        on: trendKeys.all,
        order: sql`${trendKeys.all}, ${trendKeys.tieBreak}`,
      },
    },
  );
}

// ─── Mention / Citation detail — reconstruct + reuse result-adapter's rollup ──
// The mention/citation pages have a rich drilldown (per-prompt answers, answer-
// modal highlights, type breakdown). Rather than re-express all of that in SQL,
// we reconstruct the SAME inputs result-adapter consumes (MeasurementJob[] /
// QueryRunView[] / promptMap) from the mirror and run its already-tested pure
// transforms. The win vs the old scope-API path: the mirror holds EVERY answer
// (all engines, no /results cap), so Gemini's citations/answers are included.

async function readMirrorPromptMap(): Promise<PromptMap> {
  const db = getDb();
  // Join the prompts catalog (1:1 via scope_prompt_id) so the mention/citation
  // transforms can narrow by the v0.4 taxonomy (brand / list_type / depth*).
  const rows = await db
    .select({
      id: scopePrompts.promptId,
      text: scopePrompts.text,
      // 퍼널 정본은 카탈로그(HMG 3단계 한글). scope_prompts.funnel_stage 는
      // 레거시 영문 5단계라 필터 옵션과 어휘가 다르다 — 카탈로그에 없는
      // 프롬프트에 한해서만 폴백한다 (2026-09-04, 위 SQL 술어와 동일 규칙).
      funnel: prompts.funnelStage,
      funnelLegacy: scopePrompts.funnelStage,
      brand: prompts.brand,
      brandPresence: prompts.brandPresence,
      listType: prompts.listType,
      depth1: prompts.depth1,
      depth2: prompts.depth2,
      depth3: prompts.depth3,
    })
    .from(scopePrompts)
    .leftJoin(prompts, eq(prompts.scopePromptId, scopePrompts.promptId));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        text: r.text ?? "",
        funnel: r.funnel ?? r.funnelLegacy ?? null,
        brand: r.brand ?? null,
        brandPresence: r.brandPresence ?? null,
        listType: r.listType ?? null,
        depth1: r.depth1 ?? null,
        depth2: r.depth2 ?? null,
        depth3: r.depth3 ?? null,
      },
    ]),
  );
}

// 전역 엔티티→브랜드 표기 맵 (SQL ROLLUP_NAMES 의 JS 진입점). JS 롤업 경로가
// "이 답변들 안의 Brand 행"만 보고 표기를 해석하면, 모델로만 언급된 브랜드
// (예: 'Fiat' 없이 "Fiat 500")는 표기를 못 찾아 조용히 탈락한다(모수 불일치의
// 원인). SQL 경로와 동일하게 미러 전체 Brand 행에서 표기를 뽑아
// makeBrandResolver 에 시드로 넘긴다 — 라틴 표기 우선 + 사전순 결정적.
//
// 2026-08-28: 종전에는 같은 SQL 을 손으로 복사한 "트윈"이었다. 두 사본이 갈리면
// 같은 화면의 SQL 경로와 JS 경로가 **서로 다른 대표 표기**를 쓰게 되므로
// (2026-08-06 아랍어 라벨 사고가 정확히 이 결정론 규칙의 문제였다) ROLLUP_NAMES
// 상수를 그대로 재사용해 규칙이 리포에 한 곳만 존재하게 한다. loose index scan
// 최적화도 함께 상속된다.
async function readBrandNameMap(): Promise<Map<string, string>> {
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT entity_id, brand FROM ${ROLLUP_NAMES} rn
  `)) as unknown as Array<{ entity_id: string; brand: string }>;
  return new Map(rows.map((r) => [r.entity_id, r.brand]));
}

// ── 스냅샷 런 윈도 (bare-column 버전 — drizzle .where 용) ────────────────────
// 2026-07-02 의미론: 기간 필터 = 기간 내 최신 배치/런 (기간말 시점 스냅샷).
// answerWhere의 스냅샷 윈도와 같은 규칙을 alias 없는 컬럼으로 낸다(job_id IN …
// — run_id/day 매칭이 아니라 latestAnswerIds와 동일한 prompt×engine×region
// dedup). JS 미러 집계(mentions/citations)의 리드가 이 윈도로 좁혀지므로 전량
// 로드가 사라진다(표준: 112k행 → 최신 배치 수천 행). 추이는 슬림 GROUP BY
// 리더가 전담.

// Per-project (one or many — website's JS mention/citation path narrows to a
// list of brand×country projects the same way the SQL path does): the latest
// completed answer per (prompt, engine, region), same rule as answerWhere's
// per-project branch (perProjectLatestAnswerIds) — a "latest run" or "latest
// batch day" pick both undercount when scope trickles one project's
// measurement across many small runs/days (found 2026-07-05, 2026-07-06 on
// website projects).
// 스냅샷 job_id 집합 서브쿼리 (`(SELECT ... job_id ...)`). 컬럼 없이 쓰는
// snapshotRunFilter(bare job_id IN)와, 조인 쿼리에서 alias 가 필요한
// detailAnswerWhere(a.job_id IN — scope_citations 조인 시 job_id 가 모호해짐)
// 둘 다 이 하나에서 파생시킨다 — 창 선택 규칙이 한 곳에만 존재하도록.
// ⚠ 표준(루트) 경로의 705 카탈로그 게이트(rootCatalogGate, 00fa333)는 이 ids
// 서브쿼리가 아니라 두 호출부가 자기 컬럼 표기(bare `prompt_id` / 별칭
// `a.prompt_id`)에 맞춰 덧댄다 — 아래 snapshotRunFilter·detailAnswerWhere 참조.
// ── 컬럼 존재 프로브 (마이그레이션 선/후 배포 내성) ─────────────────────────
// 구현 정본은 lib/db/column-availability.ts 로 뽑았다 (2026-09-03, 0052) —
// scope_prompts(is_korean·regions)와 scope_citations(url_norm)이 같은 내성을
// 요구하면서 테이블까지 일반화가 필요해졌다. 여기서는 이 파일의 기존 호출
// 형태(`columnKnownAvailable("regions")` = scope_prompts 기준)만 유지한다.
//
// ⚠️ 이 판정은 **동기**라서 확정 전에 읽으면 폴백 술어가 나간다 — 프로세스의 첫
// 호출만 다른 SQL 을 만들어 모수가 달라졌다(2026-09-10 실측 36,308 vs 37,568).
// 그래서 이 파일의 **export 된 async 진입점은 전부 첫 줄에서
// `await ensureColumnAvailability()`** 를 부른다(사실표 리더의 `await
// presenceSetColumnAvailable()` 과 같은 자세). 새 진입점이 그것을 빠뜨리면
// scope-aggregates.column-availability.test.ts 가 소스에서 잡는다.

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function __resetIsKoreanColumnStateForTests(): void {
  resetColumnAvailabilityForTests();
}

/** 테스트 전용 — full-cycle 게이트 서브쿼리를 창 술어와 함께 그대로 컴파일한다(PGlite 실행용). */
export function __rootFullCycleAnswerIdsForTests(rootScopeR: SQL, windowPredicate: SQL): SQL {
  return rootFullCycleAnswerIds(rootScopeR, windowPredicate);
}

function columnKnownAvailable(column: "is_korean" | "regions"): boolean {
  return sharedColumnKnownAvailable("scope_prompts", column);
}

function isKoreanColumnKnownAvailable(): boolean {
  return columnKnownAvailable("is_korean");
}

function snapshotAnswerIds(
  scopeProjectId: string | string[] | undefined,
  f: StandardFilters,
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL {
  const ids = Array.isArray(scopeProjectId)
    ? scopeProjectId
    : scopeProjectId
      ? [scopeProjectId]
      : [];
  // 앵커 축(옵트인) — `answerWhere` 의 스냅샷 분기와 **같은 서브쿼리**를 돌려준다.
  // 두 벌로 갈라 두면 드릴다운(JS 경로)과 카드가 다른 회차를 본다.
  if (anchorAxisKnownEnabled()) {
    if (ids.length > 0) {
      return anchorRoundCellAnswerIdsSubquery(
        sql`r.project_id = ${uuidAnyParam(ids)}`,
        f,
        anchorScopeForProjects(ids),
        undefined,
        family,
      );
    }
    const rootId = addressableRootProjectId();
    return anchorRoundCellAnswerIdsSubquery(
      rootRunScopeSql("r.", rootId),
      f,
      anchorScopeForRoot(rootId),
      // `answerWhere` 루트 분기와 같은 술어 — 두 벌이 갈리면 카드와 드릴다운이 어긋난다(B1).
      // 이 경로는 바깥에 숨김 지역 술어가 없으므로 여기서 함께 건다(머리 주석).
      rootRegionScopingPreds({ hiddenRegions: true }),
      family,
    );
  }
  if (ids.length > 0) return perProjectLatestAnswerIds(ids, f);
  // Bare-column twin of answerWhere's root branch (see latestAnswerIds) — same
  // prompt×engine×region dedup, same 7-day default window when no explicit
  // date filter is given.
  const rootProjectId = addressableRootProjectId();
  const rootScopeR = rootRunScopeSql("r.", rootProjectId);
  const rootWindowPredicate = f.dateFrom || f.dateTo
    ? dateBoundPredicate(f)
    : sql`r.started_at >= now() - interval '7 days'`;
  return rootFullCycleAnswerIds(rootScopeR, rootWindowPredicate);
}

function hasProjectCtx(scopeProjectId: string | string[] | undefined): boolean {
  return Array.isArray(scopeProjectId) ? scopeProjectId.length > 0 : !!scopeProjectId;
}

// ── 브랜드 드릴다운 선축소 (2026-09-16) ───────────────────────────────────────
//
// 드릴다운은 **한 브랜드만** 필요한데 `readMirrorMentionsByJob` 은 그 창의 **전
// 브랜드 언급 행**을 Node 로 끌어온다. 누적을 켜면 그대로 터진다 — 라이브 실측
// (루트 · 기간 08-19~09-15): 언급 행 **2,179,516**(현 스냅샷도 614,328).
// rollup 별 최대는 **157,864** 이므로 브랜드로 먼저 좁히면 **13.8배** 줄고,
// 지금 스냅샷(614,328)보다도 **3.9배 가볍다**.
//
// 판정은 헤드라인 SQL(`aggregateMentionsHeadlineSql` 의 `mm` CTE)과 **같은 식**을
// 쓴다 — 사용자가 클릭한 이름이 바로 그 식이 낸 이름이다. JS 쪽 최종 판정
// (`aggregateMentionsFrom` / `aggregateBrandCitationsFrom`)은 그대로 두므로 이
// 술어는 **초과 포함(superset)** 이기만 하면 되고, 그래서 rollup 표기와 원표기
// (`x.brand`) 둘 다를 OR 로 받는다.
function brandMentionJobNarrow(brandName: string, f: StandardFilters): SQL {
  return sql`job_id IN (
    WITH names AS ${ROLLUP_NAMES_BARE}
    SELECT x.job_id FROM (
      SELECT m.job_id, m.brand, ${canonRollupSql(f)} AS rid
      FROM scope_mentions m
      WHERE m.brand_rollup_entity_id IS NOT NULL
      OFFSET 0
    ) x
    LEFT JOIN names n ON n.entity_id = x.rid
    WHERE ${rollupDisplayName("x")} = ${brandName} OR x.brand = ${brandName}
  )`;
}

// exported for tests (SQL 텍스트 검증) — 런타임 호출부는 이 파일 내부뿐.
export function snapshotRunFilter(
  scopeProjectId: string | string[] | undefined,
  f: StandardFilters,
  // 브랜드 드릴다운 전용 선축소 (brandMentionJobNarrow 머리 주석). 생략하면 종전
  // 동작·종전 SQL 그대로다.
  onlyBrand?: string,
  /** 숨김 게이트 계열 — 카드와 같은 값을 내야 하므로 호출부가 화면 계열을 넘긴다. */
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL {
  // 기간 의미론 — `answerWhere`·`detailAnswerWhere` 와 **같은 판정**(cumulativeMode).
  // 이 술어는 JS 미러 경로(브랜드 언급·인용 드릴다운)의 모집단인데 종전에는
  // `f.cumulative` 를 전혀 읽지 않아 **항상 스냅샷**이었다. 그래서 고객이 기간을
  // 걸고 브랜드를 클릭하면 부모 카드와 숫자가 갈렸다 — 2026-09-16 실측
  // (기간 08-19~09-15): **카드 156,566 vs 드릴다운 37,200 = 4.2배.**
  // 그 라우트 주석이 스스로 금지하던 것이기도 하다
  // (`app/api/scope/brand-citations/route.ts:45` "본문 카드·표와 같은 '기간 내
  // 누적' 의미론을 써야 숫자가 어긋나지 않는다").
  // 앵커 축에서는 기간 유무와 무관하게 **회차 선택 서브쿼리**를 쓴다(검증 C).
  // 종전 축의 누적 분기(`detailAllRunsWindowPreds`)에는 run 상태 술어가 없어,
  // 축 on 에서 카드(`answerWhere` → `anchorRoundCellAnswerIds`, `r.status IN
  // ('completed','partial_failed')` 요구)와 **모집단이 갈린다**. 축 off 에서는
  // JS 가 dedup 을 안 해 "JS 가 더 센다"로 끝났지만, 축 on 에서는 두 경로가 각자
  // dedup 을 하므로 **다른 대표를 고르는** 결함이 된다.
  // `snapshotAnswerIds` 는 축 on 에서 기간 유무를 스스로 갈라 같은 서브쿼리를 낸다.
  const base = anchorAxisKnownEnabled()
    ? sql`job_id IN ${snapshotAnswerIds(scopeProjectId, f, family)}`
    : cumulativeMode(f)
      ? sql.join(detailAllRunsWindowPreds(f, scopeProjectId, true, ""), sql` AND `)
      : sql`job_id IN ${snapshotAnswerIds(scopeProjectId, f, family)}`;
  // 프롬프트 속성 축(lang·websiteCountry) — JS 집계 경로(readMirrorJobs →
  // aggregateMentionsFrom)는 makeResultPasses/promptAttrPasses 가 이 두 축을 모르므로
  // SQL 단계에서 좁힌다. 안 그러면 언급 드릴다운(브랜드 클릭)이 국가·언어 필터를
  // 무시한다(2026-08-25). 표면 판정은 answerWhere/detailAnswerWhere 와 동일하게
  // project ctx 유무 — 세 호출부가 갈라지면 그 사고가 그대로 재발한다.
  const withPromptAxes = [
    base,
    ...(onlyBrand ? [brandMentionJobNarrow(onlyBrand, f)] : []),
    // This predicate is evaluated by the outer scope_answers query. Qualify
    // the column so the progress subquery compares p.run_id to the answer's
    // run, rather than resolving bare run_id to p.run_id itself.
    bulkMirrorRunVisibleSqlKnown(sql`scope_answers.run_id`),
    ...promptAxisPreds(f, sql`prompt_id`, hasProjectCtx(scopeProjectId) ? "project" : "standard"),
  ];
  const narrowed = sql.join(withPromptAxes, sql` AND `);
  // 표준(루트) 뷰 = 705 카탈로그 게이트 (00fa333 — standardBatchRunFilter와 동일
  // 시맨틱을 추출 구조에서 유지). 프로젝트/웹사이트 경로는 게이트 없음.
  return hasProjectCtx(scopeProjectId)
    ? narrowed
    : sql`${narrowed} AND ${rootCatalogGate(sql`prompt_id`)}`;
}

// ── 슬림 미러 리더 — 스냅샷 창의 answer 메타만 (answer_text 제외) ─────────────
// 종전 readMirrorJobs 는 db.select().from(scopeAnswers) 풀컬럼 셀렉트로
// answer_text(표준 스냅샷 창 기준 ~54MB)까지 매 요청 전송했지만, 집계 변환
// (aggregateMentionsFrom/aggregateCitationsFrom/aggregateBrandCitationsFrom)은
// 본문을 전혀 쓰지 않는다 — 본문은 답변 모달의 lazy 단건 조회(getMirrorAnswerBody)
// 전용. 여기서 필요한 6개 컬럼만 내려 전송량을 구조적으로 제거한다(2026-07-22).
interface MirrorAnswerMeta {
  jobId: string;
  promptId: string | null;
  target: string;
  region: string | null;
  status: string | null;
  measuredAt: Date | null;
  // ── 앵커 축(0077) 투영 — 계약 §2, 타입 정본은 `result-adapter.ts::AnswerAnchorFields` ──
  // 축이 꺼진 경로에서는 **키 자체가 없다**(undefined). `view_anchor_date` 는 그
  // 구분이 곧 게이트의 on/off 라(키 없음 = 게이트 없음 · null = 비노출) 다섯 값을
  // 통째로 싣거나 통째로 빼는 것 말고 중간 상태를 만들지 않는다.
  roundDate?: string | null;
  anchorWeek?: string | null;
  measuredAtOrig?: string | null;
  isDefaultEngine?: boolean | null;
  viewAnchorDate?: string | null;
}

/**
 * 앵커 축 투영의 행 모양 — raw 경로라 컬럼명 그대로다.
 *
 * 날짜·시각을 **전부 `to_char` 로 텍스트화**하는 이유: `date`/`timestamptz` 의 JS
 * 변환은 드라이버 파서에 달려 있는데, 이 값들은 `YYYY-MM-DD` 문자열 비교(기간 술어·
 * 노출 게이트)와 사전식 최댓값(대표 선택)에 그대로 쓰인다. `AT TIME ZONE 'UTC'` 로
 * 먼저 고정해 세션 TimeZone GUC 와도 무관하게 만든다(이 리포에 Supavisor 풀에서
 * 앞선 세션의 GUC 가 남은 전례가 있다).
 */
interface MirrorAnswerAnchorRow {
  job_id: string;
  prompt_id: string | null;
  target: string;
  region: string | null;
  status: string | null;
  /**
   * UTC ISO(ms) 텍스트: `measured_at_orig` 와 같은 `to_char` 관례. 2026-09-28 전에는
   * `timestamptz` 를 그대로 싣고 `Date` 로 선언했는데, drizzle 의 postgres-js 드라이버는
   * raw `execute` 결과의 timestamptz 를 **문자열**로 둔다(`construct()` 가 1184 등의 파서를
   * 투명 파서로 덮어쓴다). 그 거짓 선언 때문에 `buildMirrorJobs` 의 `.toISOString()` 이
   * 프리뷰 드릴다운에서 500 을 냈다. `Date` 로의 변환은 매핑이 명시적으로 한다.
   */
  measured_at: string | null;
  round_date: string | null;
  anchor_week: string | null;
  measured_at_orig: string | null;
  is_default_engine: boolean | null;
  view_anchor_date: string | null;
}

async function readMirrorAnswerMeta(
  runFilter: SQL,
  db: MirrorReader = getDb(),
): Promise<MirrorAnswerMeta[]> {
  // 앵커 축(옵트인) — 다섯 컬럼을 `job_id` 조인으로 싣는다. **상관 서브쿼리가 아니다**
  // (계약 §5). `job_id` 가 PK 라 행이 불어나지 않는다.
  //
  // `runFilter` 를 파생 테이블 안에 가둔 이유: 그 술어는 `job_id`·`prompt_id` 를
  // **한정 없이** 쓰고 `scope_answers.run_id` 만 한정한다(`snapshotRunFilter`). 바깥에서
  // `ca` 를 조인하면 `job_id` 가 양쪽에 있어 모호해진다. 파생 테이블 안에서는 표가
  // `scope_answers` 하나뿐이라 술어 텍스트를 **한 글자도 고치지 않고** 그대로 쓴다.
  if (anchorAxisKnownEnabled()) {
    const rows = (await db.execute(sql`
      SELECT sa.job_id, sa.prompt_id, sa.target, sa.region, sa.status,
             to_char(sa.measured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS measured_at,
             to_char(${anchorRoundDateSql()}, 'YYYY-MM-DD') AS round_date,
             to_char(${anchorWeekSql()}, 'YYYY-MM-DD') AS anchor_week,
             to_char(${anchorMeasuredOrigSql()} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS measured_at_orig,
             ${anchorDefaultEngineSql()} AS is_default_engine,
             to_char(${anchorViewAnchorDateSql()}, 'YYYY-MM-DD') AS view_anchor_date
      FROM (
        SELECT job_id, prompt_id, target, region, status, measured_at
        FROM scope_answers WHERE ${runFilter}
      ) sa${anchorJoinSql(sql.raw("sa.job_id"))}
    `)) as unknown as MirrorAnswerAnchorRow[];
    return rows.map((r) => ({
      jobId: r.job_id,
      promptId: r.prompt_id,
      target: r.target,
      region: r.region,
      status: r.status,
      // 축 off(`db.select()` → 컬럼 mapFromDriverValue)와 같은 `Date` 계약. `to_char` 의 MS 는
      // 절사라 off 경로의 `new Date(µs 텍스트)`(V8 도 절사)와 ms 까지 같다.
      measuredAt: r.measured_at === null ? null : new Date(r.measured_at),
      roundDate: r.round_date,
      anchorWeek: r.anchor_week,
      measuredAtOrig: r.measured_at_orig,
      isDefaultEngine: r.is_default_engine,
      viewAnchorDate: r.view_anchor_date,
    }));
  }
  return db
    .select({
      jobId: scopeAnswers.jobId,
      promptId: scopeAnswers.promptId,
      target: scopeAnswers.target,
      region: scopeAnswers.region,
      status: scopeAnswers.status,
      measuredAt: scopeAnswers.measuredAt,
    })
    .from(scopeAnswers)
    .where(runFilter);
}

type MirrorMentionRow = typeof scopeMentions.$inferSelect;

function toResolvedMention(m: MirrorMentionRow): ResolvedMention {
  return {
    entity_id: m.entityId,
    entity_type: m.entityType,
    display_name: m.brand,
    rollups: {
      product_entity_id: null,
      brand_entity_id: m.brandRollupEntityId,
      company_entity_id: null,
    },
    surfaces: m.surfaces ?? [],
    mention_count: m.mentionCount,
    sentiment: {
      positive: m.sentimentPositive,
      neutral: m.sentimentNeutral,
      negative: m.sentimentNegative,
      mixed: m.sentimentMixed,
    },
    avg_position: m.avgPosition,
    type_breakdown: {
      mention: m.typeMention,
      recommendation: m.typeRecommendation,
      comparison: m.typeComparison,
      definition: m.typeDefinition,
      final_choice: m.typeFinalChoice,
    },
  };
}

function groupMentionsByJob(rows: MirrorMentionRow[]): Map<string, ResolvedMention[]> {
  const byJob = new Map<string, ResolvedMention[]>();
  for (const m of rows) {
    const list = byJob.get(m.jobId) ?? [];
    list.push(toResolvedMention(m));
    byJob.set(m.jobId, list);
  }
  return byJob;
}

// Mentions only for the selected answers — the mirror holds every run's
// mentions; loading them all was the standard path's main transfer cost.
async function readMirrorMentionsByJob(
  runFilter: SQL,
  db: MirrorReader = getDb(),
): Promise<Map<string, ResolvedMention[]>> {
  const mentions = await db
    .select()
    .from(scopeMentions)
    .where(sql`job_id IN (SELECT job_id FROM scope_answers WHERE ${runFilter})`);
  return groupMentionsByJob(mentions);
}

// Citations only for the selected answers (기존 readMirrorResults 내부와 동일).
async function readMirrorCitationsByJob(
  runFilter: SQL,
): Promise<Map<string, ScopeCitation[]>> {
  const db = getDb();
  const cits = await db
    .select()
    .from(scopeCitations)
    .where(sql`job_id IN (SELECT job_id FROM scope_answers WHERE ${runFilter})`);
  const byJob = new Map<string, ScopeCitation[]>();
  for (const c of cits) {
    const list = byJob.get(c.jobId) ?? [];
    list.push({
      url: c.url ?? undefined,
      host: c.domain ?? undefined, // mirror already stores the registrable domain
      title: c.title ?? undefined,
      refIndex: c.refIndex ?? undefined,
      // Restore scope's classification so the standard category card/pie/badge
      // populate on the mirror path (subcategory 폐기 — not mirrored).
      category: c.category ?? undefined,
    });
    byJob.set(c.jobId, list);
  }
  return byJob;
}

// Rebuild MeasurementJob[] (with full resolved_mentions) from the slim answer
// meta + per-job mentions, narrowed to the snapshot run window (numbers path).
// The weekly trend is computed separately from the slim day-level readers, so
// this never loads full history. Non-date filters still apply in the transforms.
//
// 앵커 축: `roundDate` 가 실려 온 행만 다섯 필드를 싣는다. 그 값이 **축의 존재
// 신호**라(`result-adapter.ts::anchorAxisCarried`) 집계층은 옵션 없이도 축을 켠다.
// 다섯을 함께 싣는 것이 계약이다 — 특히 `round_date` 만 싣고 `measured_at_orig` 를
// 빼면 대표 선택이 접힌 `measured_at` 으로 폴백해 조용히 틀린다(계약 위반).
function buildMirrorJobs(
  answers: MirrorAnswerMeta[],
  mentionsByJob: Map<string, ResolvedMention[]>,
): AnchoredJob[] {
  return answers.map((a) => ({
    job_id: a.jobId,
    prompt_id: a.promptId,
    target: a.target,
    region: a.region,
    status: a.status ?? "completed",
    measured_at: a.measuredAt?.toISOString() ?? "",
    analysis: {
      status: "completed",
      resolved_mentions: mentionsByJob.get(a.jobId) ?? [],
    },
    ...(a.roundDate
      ? {
          round_date: a.roundDate,
          anchor_week: a.anchorWeek ?? null,
          measured_at_orig: a.measuredAtOrig ?? null,
          is_default_engine: a.isDefaultEngine ?? null,
          view_anchor_date: a.viewAnchorDate ?? null,
        }
      : {}),
  }));
}

/** 미러 투영·측정 기준일 라우터의 SQL 텍스트를 고정하기 위한 테스트 진입점. */
export const __testables = {
  readMirrorAnswerMeta,
  buildMirrorJobs,
  trendWindowFloor,
  trendFloorDays,
  // 주별 Top-N 두 리더의 **실제 바닥** — SQL 컴파일 증명 테스트가 이것을 쓴다
  // (재조립하면 리더가 실제로 거는 것을 안 본다).
  weeklyTopNTrendFloor,
  cycleAsOfRowSql,
  cycleAsOfSql,
  cycleAsOfDisplaySql,
  anchorAsOfJoinSql,
  normalizeAsOf,
  // 축 on 의 `_answer_set` 투영·소비 한 쌍 — **실행 스모크**가 이 둘을 같이 꺼내
  // 쓴다(`scope-aggregates.answer-set.pglite.test.ts`). 텍스트 스냅샷은 컬럼의
  // 존재를 검증하지 못한다는 것이 2026-09-20 차단 결함의 교훈이다.
  kpiTabTrendAxis,
  kpiTabCellSnapshot,
  // 5차(함대 게이트 조인 판본) — G2e 덤프가 비용 귀속용 C 문장을 조립할 때 쓴다.
  trendServableJoinSql,
  trendServableJoinedPred,
};

// 프로젝트 커스텀 태그의 허용 scope_prompt_id 집합 — answerWhere/detailAnswerWhere
// 술어와 동일 의미(같은 태그 안 OR, 태그 간 AND)를 JS 경로(jobs)에서 재현한다.
async function readCustomFieldPromptIds(
  cff: Record<string, string[]>,
  db: MirrorReader = getDb(),
): Promise<Set<string>> {
  const clauses = Object.entries(cff)
    .filter(([, values]) => values.length)
    .map(
      ([fieldId, values]) => sql`p.id IN (
        SELECT v.prompt_id FROM prompt_custom_field_values v
        WHERE v.field_id = ${fieldId}::uuid
          AND v.value IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})
      )`,
    );
  if (!clauses.length) return new Set();
  const rows = (await db.execute(sql`
    SELECT p.scope_prompt_id FROM prompts p
    WHERE ${sql.join(clauses, sql` AND `)} AND p.scope_prompt_id IS NOT NULL
  `)) as unknown as Array<{ scope_prompt_id: string }>;
  return new Set(rows.map((r) => r.scope_prompt_id));
}

// website country 필터의 허용 scope_prompt_id 집합 — answerWhere/detailAnswerWhere
// 의 websiteCountry 서브쿼리와 동일 술어를 JS(드릴다운) 경로용 집합으로 낸다.
async function readWebsiteCountryPromptIds(
  countries: string[],
  db: MirrorReader = getDb(),
): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT wp.scope_prompt_id FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ${websiteSiteGeoPred(countries)}
      AND wp.scope_prompt_id IS NOT NULL
  `)) as unknown as Array<{ scope_prompt_id: string }>;
  return new Set(rows.map((r) => r.scope_prompt_id));
}

async function readMirrorJobs(
  scopeProjectId: string | string[] | undefined,
  filters: StandardFilters,
  // 예산(PR③) — 읽기마다 자기 트랜잭션에 `SET LOCAL statement_timeout`. 생략 시 종전 그대로.
  budget?: AnswerSetBudget,
  // 브랜드 드릴다운이면 그 브랜드의 job 으로 선축소 (brandMentionJobNarrow).
  onlyBrand?: string,
): Promise<AnchoredJob[]> {
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const runFilter = snapshotRunFilter(scopeProjectId, filters, onlyBrand);
  const [answers, mentionsByJob] = await Promise.all([
    budgetedReader(budget, "mirror answer meta", (db) => readMirrorAnswerMeta(runFilter, db)),
    budgetedReader(budget, "mirror mentions", (db) => readMirrorMentionsByJob(runFilter, db)),
  ]);
  return buildMirrorJobs(answers, mentionsByJob);
}

// Rebuild the /results-shaped feed (QueryRunView[] with result.citations) from
// the SAME slim answer meta — 종전에는 인용 경로가 answers 를 자체적으로 한 번 더
// 읽었다(같은 요청에서 스냅샷 answers 2회 로드). 이제 호출부가 answer 메타를 한
// 번만 읽어 jobs/results 두 형태로 재사용한다.
function buildMirrorResults(
  answers: MirrorAnswerMeta[],
  citationsByJob: Map<string, ScopeCitation[]>,
): QueryRunView[] {
  return answers.map((a) => ({
    job_id: a.jobId,
    target: a.target,
    status: a.status ?? "completed",
    result: {
      answer_text: "",
      citations: citationsByJob.get(a.jobId) ?? [],
      // 기간 필터(makeResultPasses::datePasses)가 인용 경로에서도 판정 가능하도록
      // answer의 측정 시각을 싣는다 ("" = 미측정 → 활성 기간 필터에서 제외).
      measured_at: a.measuredAt?.toISOString() ?? "",
    },
  }));
}

// ── 슬림 추이 리더 — 일 단위 (day, key, n) 롤업 ─────────────────────────────
// 수치는 스냅샷 배치(위의 좁혀진 리드)로, 주간 추이는 이 GROUP BY로 계산한다.
// 주차 버킷팅은 SQL date_trunc가 아니라 기존 JS weekStartUTC(buildWeeklyTrend)를
// 그대로 태워 주 경계 패리티를 보존한다. answerWhere(allRuns)가 기간·엔진·퍼널·
// 카탈로그 축을 SQL에서 동일하게 적용한다.
interface DayKeyCount {
  day: string;
  key: string;
  n: number;
}

/**
 * 주별 Top-N 두 리더(`readCitationDomainDayCounts`·`readMentionBrandDayCounts`)의
 * **창 바닥 — 한 벌**. 테스트가 리더와 같은 것을 컴파일할 수 있게 `__testables` 로 낸다.
 *
 * ── 왜 인자로 받는가 (통합 검증 B1, 2026-09-20 2차) ────────────────────────
 *
 * 이 두 리더의 산출물은 **주 격자에 얹힌다**(`withWeeklyTrendGrid`). 그런데 리더 자신은
 * 자기 출력이 격자에 갇히는지 알 수 없다 — 같은 함수가 격자 밖에서도 불릴 수 있다.
 * 그래서 **호출부가 그 사실을 인자로 명시**하고 리더는 추측하지 않는다.
 *
 * ⚠️ 이 한 줄이 없으면 수리가 반쪽이다. 호출부가 `withTrendGridWindow` 로 `dateFrom = S0`
 *    를 심어도, 여기 바닥이 120 이면 두 하한이 **AND** 라 **좁은 쪽이 이긴다**:
 *    `S0 < 오늘 − 120` 인 구간(= B1 의 정의)에서는 여전히 120일에서 잘린다. 1차 수리의
 *    "120 은 그보다 넓은 바깥 창일 뿐" 이라는 판단이 바로 그 지점에서 틀렸다
 *    (검증자 SQL 컴파일 실측: `ca.round_date >= hmg_anchor_today() - 120` AND
 *     `ca.round_date >= '2026-04-23'::date` → 실효 하한 `T-120`).
 *
 * 격자 off 에서는 `trendFloorDays` 가 단위와 무관하게 120 이라 **텍스트가 종전과 동일**하다.
 */
function weeklyTopNTrendFloor(onTrendGrid: boolean, caJoined = false): SQL {
  // 격자에 얹히면 자리 상한(180)까지, 아니면 종전 상수(120).
  const days = trendFloorDays(onTrendGrid ? "week" : "day");
  return trendWindowFloor(undefined, undefined, caJoined, false, days);
}

/**
 * 인용 화면 **주별 상위 도메인** 추이의 원천.
 *
 * ⚠️ 바닥은 **120 그대로**다(검증 B1 의 채택안, 2026-09-20). 이 산출물은
 *    `server.ts::withWeeklyTrendGrid` 가 자리 목록에 얹지만, 그 헬퍼가 **읽기 전에**
 *    `withTrendGridWindow(filters, slots)` 로 `dateFrom = slots[0]` 을 심는다. 그러면
 *    아래 `answerWhere` 의 기간 술어가 자리 창과 **정확히 같은 바닥**을 걸므로, 실효
 *    바닥은 `max(slots[0], 오늘 − 120)` 가 아니라 `slots[0]` 이다 — 자리가 120일보다
 *    멀어도 값이 따라온다. 바닥 상수를 180 으로 넓히는 쪽을 택하지 않은 이유: 격자가
 *    안 붙는 호출(미러 단독·기간 미지정)의 스캔만 1.5배가 되고, 값의 창과 자리의 창이
 *    **정의상 같아지지는 않는다**(둘 다 넓어질 뿐 서로를 안 본다).
 */
async function readCitationDomainDayCounts(
  filters: StandardFilters,
  /**
   * 이 산출물이 **주 격자에 얹히는가**(통합 B1). 기본값을 두지 않는다 — 새 호출부가
   * 조용히 120 을 상속하면 자리가 120일보다 멀 때 값이 잘려 거짓 갭이 된다.
   */
  onTrendGrid: boolean,
  scopeProjectId?: string | string[],
): Promise<DayKeyCount[]> {
  const db = getDb();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const W = answerWhere(filters, scopeProjectId, { allRuns: true });
  // 주별 스냅샷 (2026-08-12 결정): 주 안에서 셀(프롬프트×엔진×지역)당 최신 답변
  // 1개만 집계 — 한 주에 재측정돼도 이중 카운트하지 않아 그래프 주간 점과 표
  // 스냅샷이 같은 단위가 된다. 창은 TREND_WINDOW_DAYS(추이 계열 공통) 참조.
  // day 컬럼은 주 시작일(월요일) — JS weekStartUTC 가 그대로 통과시킨다.
  // 뷰 앵커 전 회차 제외 — excludeHiddenCycleRuns 머리 주석. 이 롤업은 인용
  // 화면의 **주간 추이 라인**만 만든다(표·카드는 별도 스냅샷 리드).
  // 계열 = **인용**(0071) — 범위가 citations 인 회차도 여기서는 그대로 숨긴다.
  const notHidden = await excludeHiddenCycleRuns(sql`a.run_id`, "citation", sql`a.job_id`);
  // 주 격자 — off 는 **표면별 주 격자**(`mirrorWeekKey` — 글로벌은 회차 앵커의 KST 주,
  // 웹사이트·프로젝트는 종전 세션 TZ 식 문자 그대로, 2026-09-28 main #300), on 은
  // `ca.anchor_week`. 세 자리(DISTINCT ON · 선택 리스트 · ORDER BY)가 **같은 식**이어야
  // 하므로 한 번만 만든다.
  const anchorOn = anchorAxisKnownEnabled();
  const wk = mirrorWeekKey(mirrorWeekGridFor(scopeProjectId));
  const wkBucket = anchorOn
    ? periodBucketSql("week", sql`a.measured_at`, { anchorAxis: true })
    : wk.key;
  const k = anchorOn
    ? anchorCellSnapshotKeys({ alias: "a." })
    : cellSnapshotKeys({ alias: "a.", bucket: wkBucket });
  return (await db.execute(sql`
    WITH ans AS MATERIALIZED (
      SELECT DISTINCT ON (${k.all})
        a.job_id, ${wkBucket} AS wk
      FROM scope_answers a${anchorOn ? anchorJoinSql(sql.raw("a.job_id")) : wk.join}
      WHERE a.measured_at IS NOT NULL
        AND ${weeklyTopNTrendFloor(onTrendGrid, anchorOn)} AND ${W} AND ${notHidden}
      ORDER BY ${k.all},
        ${k.tieBreak}
    )
    SELECT to_char(ans.wk, 'YYYY-MM-DD') AS day,
      ${citationGroupKeySql(sql`c.domain`, sql`c.url`)} AS key,
      count(*)::int AS n
    FROM scope_citations c JOIN ans ON ans.job_id = c.job_id
    WHERE c.domain IS NOT NULL
    GROUP BY 1, 2
  `)) as unknown as DayKeyCount[];
}

async function readMentionBrandDayCounts(
  filters: StandardFilters,
  /** 이 산출물이 **주 격자에 얹히는가**(통합 B1). 기본값 없음 — 위 리더와 같은 규율. */
  onTrendGrid: boolean,
  scopeProjectId?: string | string[],
  // 표시 대상(상위 N) 브랜드로 결과를 좁힌다 — 추이 시리즈는 어차피 상위 10개뿐이라
  // 나머지 브랜드의 day×brand 롤업은 버려진다. 지정 시 GROUP BY 출력이 급감한다.
  seriesKeys?: string[],
  // 이 쿼리에만 거는 statement_timeout(ms). 무거운 필터 조합에서 추이 쿼리가
  // 오래 걸릴 때 DB 기본 timeout(수십초~2분)까지 기다리지 않고 빠르게 실패시켜,
  // 호출부(aggregateMentionsHeadlineSql)가 추이만 null 로 degrade 하고 헤드라인
  // 수치는 즉시 서빙하게 한다. 미지정 시 기존대로(세션 기본 timeout).
  timeoutMs?: number,
  // 주 격자 키의 원천(2026-09-17) — `trendWeekKey` 머리 주석이 정본. 기본값은
  // **종전 그대로**(측정시각 주)라, 이 인자를 넘기지 않는 호출부는 SQL 문자까지 같다.
  weekSource: TrendWeekSource = "measured",
): Promise<DayKeyCount[]> {
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const W = answerWhere(filters, scopeProjectId, { allRuns: true });
  const seriesClause =
    seriesKeys && seriesKeys.length
      ? sql`AND ${rollupDisplayName("x")} IN (${sql.join(seriesKeys.map((k) => sql`${k}`), sql`, `)})`
      : sql``;
  // 주간 추이 안전 창 — allRuns(전 이력) × mention⋈answer 조인은 무거운 필터
  // 조합에서 statement_timeout 을 냈다(라이브 crash 의 한 원인). 주간 라인은 최근
  // 구간만 의미가 있어 120일(~17주)로 바운드해 스캔을 상수화한다. 사용자가 명시
  // 기간 필터를 걸면 answerWhere 가 그 범위를 더 좁힌다(둘 중 좁은 쪽).
  // 2026-09-03: 이 창이 추이 계열 공통 상수로 승격됐다 — TREND_WINDOW_DAYS 참조.
  //
  // ⚠️ 격자가 켜져도 이 상수는 **안 넓힌다**(검증 B1 채택안). 호출부
  //    (`server.ts::withWeeklyTrendGrid`)가 읽기 전에 `dateFrom = slots[0]` 을 심어
  //    `answerWhere` 가 자리 창과 같은 바닥을 걸기 때문이다 —
  //    `readCitationDomainDayCounts` 머리 주석이 정본.
  const trendFloor = weeklyTopNTrendFloor(onTrendGrid);
  // 답변셋을 먼저 MATERIALIZED CTE 로 확정한 뒤 mention 을 조인한다 — mention⋈answer
  // 를 한 스캔으로 두고 필터를 얹으면 answerWhere(allRuns)+brandPresence 조합에서
  // 플래너가 비싼 스냅샷/카탈로그 서브쿼리를 재평가하며 플랜이 붕괴(statement_
  // timeout)했다. 필터된 답변(대개 소수)을 먼저 고정하면 조인이 그 소수에만 붙어
  // 안정적으로 빠르다(KPI5 owned-clause 와 동일 교훈).
  // 주별 스냅샷 (2026-08-12 결정): 주 안에서 셀(프롬프트×엔진×지역)당 최신 답변
  // 1개만 남긴다 — 한 주에 재측정된 셀의 이중 카운트를 제거해, 그래프의 주간 점이
  // 표(셀당 최신 스냅샷)와 같은 단위("그 주말 시점 상태")가 된다. day 는 주
  // 시작일(월요일)로 반환 — JS weekStartUTC 는 월요일 입력을 그대로 통과시킨다.
  // ── 성능: OFFSET 0 배리어 + names 쪽 사전 계산 (이식 2026-09-02) ─────────────
  // 형태·근거는 추이 ②(aggregateStandardTrendFromMirror) 주석이 정본이다. 이 자리는
  // 그 처방을 못 받은 채 남아 있었고, 프로덕션 pg_stat_statements 에서 원형
  // `WITH names AS ( WITH RECURSIVE _rn_pairs …` 형태로 상위에 떠 있었다.
  // 프로덕션 A/B (ANALYZE · 무필터 allRuns 120일 · TEMP TABLE 경로 · 3회 중앙값,
  // 산출 동치 md5 20795227184cc8b6c803898bc28dc402 · 2,473행 · EXCEPT ALL 0/0):
  //   종전 11,975 ms → 5,931 ms (**2.0배**). 자체 가드가 8s 라 종전 형태는 무필터
  //   콜드에서 가드를 넘겨 추이가 degrade 되는 쪽이었다.
  // 뷰 앵커 전 회차 제외 — excludeHiddenCycleRuns 머리 주석. 이 롤업은 언급
  // 화면의 **주간 추이 라인**만 만든다(헤드라인 수치는 별도 스냅샷 문장).
  // 계열 = **언급**(0071) — 범위가 citations 인 회차는 언급 값을 그대로 낸다.
  const notHidden = await excludeHiddenCycleRuns(sql`a.run_id`, "mention", sql`a.job_id`);
  // 주 격자 키(2026-09-17). `measured` 면 아래 식이 종전과 **문자 그대로 같고** 조인도 없다.
  // `cycle` 이면 `DISTINCT ON`·`ORDER BY`·선택 리스트 **셋 다 같은 키**로 바뀐다 — 셋 중
  // 하나만 바꾸면 dedup 격자와 표시 격자가 갈려 한 셀이 두 점에 실린다.
  // 측정 폴백은 표면별 주 격자다(2026-09-28 main #300 — 글로벌은 회차 앵커의 KST 주).
  const wk = await trendWeekKey(weekSource, mirrorWeekGridFor(scopeProjectId));
  const query = mentionBrandDayCountsQuery({
    filters, wk, trendFloor, answerWhere: W, notHidden, seriesClause,
  });
  if (timeoutMs && timeoutMs > 0) {
    // SET LOCAL 은 트랜잭션 스코프에서만 유효 — 같은 트랜잭션에서 쿼리를 돌린다.
    return getDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`));
      return (await tx.execute(query)) as unknown as DayKeyCount[];
    });
  }
  return (await getDb().execute(query)) as unknown as DayKeyCount[];
}

/**
 * 위 문장 본체 — **컴파일된 SQL 을 단언하기 위해** 떼어 놓은 순수 빌더다(`ROLLUP_NAMES`
 * 를 export 한 것과 같은 이유: 소스 grep 가드는 포맷 변경에 뚫린다).
 *
 * ⚠️ 주 격자 키 `wk.key` 가 **세 자리에 같은 식**으로 들어간다 — `DISTINCT ON` ·
 *    선택 리스트 · `ORDER BY`. 셋 중 하나만 바꾸면 dedup 격자와 표시 격자가 갈려
 *    한 셀이 두 점에 실리거나(그래프가 부풀고) `DISTINCT ON` 이 문법 오류가 된다.
 *    그 셋을 `scope-aggregates.mention-trend-week.sql.test.ts` 가 고정한다.
 */
export function mentionBrandDayCountsQuery(p: {
  filters: StandardFilters;
  wk: TrendWeekKey;
  trendFloor: SQL;
  answerWhere: SQL;
  notHidden: SQL;
  seriesClause: SQL;
}): SQL {
  const { wk } = p;
  // 앵커 축이면 dedup 키가 주(`anchor_week`)가 아니라 **회차**(`round_date`)다 —
  // `trendCellKeys` 머리 주석.
  const k = trendCellKeys(wk);
  return sql`
    WITH names AS ${ROLLUP_NAMES_BARE},
    ans AS MATERIALIZED (
      SELECT DISTINCT ON (${k.all})
        a.job_id, ${wk.key} AS wk
      FROM scope_answers a${wk.join}
      WHERE a.measured_at IS NOT NULL AND ${p.trendFloor} AND ${p.answerWhere} AND ${p.notHidden}
      ORDER BY ${k.all},
        ${k.tieBreak}
    )
    SELECT to_char(x.wk, 'YYYY-MM-DD') AS day,
      ${rollupDisplayName("x")} AS key,
      sum(x.mention_count)::int AS n
    FROM (
      SELECT ans.wk AS wk, m.mention_count AS mention_count, m.brand AS brand,
        ${canonRollupSql(p.filters)} AS rid
      FROM scope_mentions m JOIN ans ON ans.job_id = m.job_id
      WHERE m.brand_rollup_entity_id IS NOT NULL
      OFFSET 0
    ) x
    LEFT JOIN names n ON n.entity_id = x.rid
    WHERE COALESCE(n.brand, x.brand) IS NOT NULL
      AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
      ${p.seriesClause}
    GROUP BY 1, 2
  `;
}

// null(EmptyState) vs empty-but-non-null(필터 패널 유지) 판정 — 좁혀진 리드가
// 비었을 때, 미러에 데이터 자체가 없는 것인지(→ null) 기간/필터가 비운 것인지
// (→ empty shape)를 구분한다. 종전에는 전량 로드 후 JS에서 판정하던 계약.
function projectIdsClause(scopeProjectId: string | string[] | undefined): SQL | null {
  const ids = Array.isArray(scopeProjectId) ? scopeProjectId : scopeProjectId ? [scopeProjectId] : [];
  if (!ids.length) return null;
  return sql`project_id = ${uuidAnyParam(ids)}`;
}

async function mirrorHasCitations(scopeProjectId?: string | string[]): Promise<boolean> {
  const db = getDb();
  const pidClause = projectIdsClause(scopeProjectId);
  const inner = pidClause
    ? sql`SELECT 1 FROM scope_citations c WHERE c.job_id IN (
        SELECT job_id FROM scope_answers WHERE run_id IN (
          SELECT run_id FROM scope_runs WHERE ${pidClause}))`
    : sql`SELECT 1 FROM scope_citations`;
  const rows = (await db.execute(sql`SELECT EXISTS (${inner}) AS has`)) as unknown as Array<{ has: boolean }>;
  return rows[0]?.has === true;
}

async function mirrorHasAnswers(scopeProjectId?: string | string[]): Promise<boolean> {
  const db = getDb();
  const pidClause = projectIdsClause(scopeProjectId);
  const inner = pidClause
    ? sql`SELECT 1 FROM scope_answers WHERE status = 'completed' AND run_id IN (
        SELECT run_id FROM scope_runs WHERE ${pidClause})`
    : sql`SELECT 1 FROM scope_answers WHERE status = 'completed'`;
  const rows = (await db.execute(sql`SELECT EXISTS (${inner}) AS has`)) as unknown as Array<{ has: boolean }>;
  return rows[0]?.has === true;
}

// 스냅샷 리드에 기간이 이미 반영됐으므로 순수 집계에는 날짜 축을 넘기지 않는다
// (makeJobPasses/makeResultPasses의 measured_at 클리핑이 배치를 반토막 내는 것 방지).
function stripDates(f: StandardFilters): StandardFilters {
  return { ...f, dateFrom: undefined, dateTo: undefined };
}

// ── 캐시 바이트 상한 (2026-07-22) ────────────────────────────────────────────
// Next unstable_cache 는 항목이 2MB 를 넘으면 조용히 캐시하지 않는다 — 표준/
// 웹사이트 인용·언급 뷰모델이 그 한도를 넘겨 warm 재방문마다 전체 재계산·재전송이
// 일어났다(2026-07-22 실측: 인용 warm 9.2s/18.2s). 미러 집계는 반환 직전에
// 직렬화 바이트 상한을 강제해 "캐시 가능한 형태"를 구조적으로 보장한다.
// 1.5MB = 2MB 한도 - Next 캐시 엔벨로프(키·태그·직렬화 오버헤드) 여유분.
// 상한은 요약·랭킹·판정 수치는 건드리지 않고 드릴다운 리스트 길이만 줄인다.
const MIRROR_CACHE_BUDGET_BYTES = 1_500_000;

// 인용 드릴다운 fetch 상한 — 캐시(2MB 한도)와 RSC payload 를 구조적으로 bound.
// 도메인 합계 행은 전부 계산하되(판정·파이·요약 정확), URL/프롬프트 리스트는
// 인용수 상위 도메인에만 싣는다. (아래 SQL 집계 aggregateCitationsFromMirror 와
// 슬리밍 레벨 CITATION_SLIM_LEVELS 이 공유.)
const CITATION_DRILLDOWN_DOMAINS = 80;
// 공식(HMG) 도메인은 **인용 순위와 무관하게** 드릴다운을 싣는다 (2026-09-16 고객
// QA: "인용 수와 상관 없이 공식 도메인이면 샘플 URL도 제공하는 게 맞다").
//
// ⚠️ 공식(HMG) 도메인 집합은 **열거 가능한 유한 목록이 아니다.** 초안 주석은
// "geo-catalog owned 42 + 공식 소셜 9 + seed 26 = 77개 유한"이라고 적었는데
// 틀렸다 — `citation-categorizer/rules.ts::isHmgBrandDomain` 이 `hyundai.<tld>` ·
// `kia.<tld>` · `genesis.<sub>.<tld>` 를 **패턴으로** 공식 판정하므로 77은 하한이고,
// 운영자 오버라이드까지 더하면 상한이 없다. 프로덕션 미러 실측(2026-09-16,
// 최근 28일 전 프로젝트 합산: 도메인 33,583)에서 공식(HMG)은 **193개**,
// 그중 상위 80 밖이 **170개**였다(kia.no 88위 · hyundai.cz 153위 · … 최하 32,647위).
// 250 = 실측 193 + 여유. 드릴다운 IN 리스트는 80+250=330 도메인으로 bound.
//
// 초과분(상한 밖 공식)은 행에 `drilldownOmitted: true` 를 실어, 화면이 "URL이
// 아직 없습니다"(정말 없음)가 아니라 종전 "미제공" 문구를 쓰게 한다 — 상한이
// 있는 한 문구가 거짓이 될 여지를 구조적으로 막는다.
export const CITATION_OFFICIAL_DRILLDOWN_MAX = 250;
// 상위 N **밖** 공식 도메인이 싣는 URL 수. 고객 요구가 "샘플 URL" 이므로 꼬리는
// URL 만 소량 싣고 프롬프트 드릴다운(promptList)은 비운다 — 꼬리 1도메인의
// 바이트를 지배하는 것이 promptList(프롬프트 12 × 답변 ref 8)이고, 그것을 두면
// 꼬리 50개부터 캐시 예산 레벨이 강등돼 **비공식 행의 표·드릴다운이 줄어든다**
// (검증자 합성 실측: 표 1,500→1,050행 −30%, 비공식 드릴다운 50→30).
export const CITATION_OFFICIAL_TAIL_URLS = 5;
const CITATION_URLS_PER_DOMAIN = 10; // 종전 JS 경로의 urls.slice(0,10)과 동일
const CITATION_PROMPTS_PER_DOMAIN = 12;
const CITATION_REFS_PER_PROMPT = 8;
const CITATION_SPLIT_PROMPTS = 20; // promptSplit 리스트 상한 (카운트는 전량 정확)
const CITATION_SPLIT_REFS = 8;

function byteSize(vm: unknown): number {
  return Buffer.byteLength(JSON.stringify(vm) ?? "");
}

// 후보 생성기를 앞에서부터 평가해 예산에 드는 첫 결과를 반환. 전부 초과하면
// 마지막 후보(절대 상한이 보장되는 형태)를 반환한다.
function fitToBudget<T>(candidates: Array<() => T>): T {
  let last: T | null = null;
  for (const make of candidates) {
    last = make();
    if (byteSize(last) <= MIRROR_CACHE_BUDGET_BYTES) return last;
  }
  return last as T;
}

// ── 언급 뷰모델 슬리밍 — 드릴다운 top-N 캡 ──────────────────────────────────
// 헤드라인(summary·brands 랭킹행·감정/유형 합계·추이)은 전량 집계값 그대로 두고,
// perBrandPrompts 드릴다운만 브랜드당 상위 프롬프트 N개·프롬프트당 답변 ref R개·
// 하이라이트 용어 수로 캡한다. 리스트는 이미 언급수 내림차순 정렬이라 slice 가
// 곧 top-N. 표준 루트 실측(2026-07-22): 브랜드×프롬프트 쌍 10,612·답변 ref 쌍당
// 평균 6.1개 — 캡 없이는 수 MB 로 2MB 한도를 항상 초과한다.
interface MentionSlimLevel {
  prompts: number; // 브랜드당 프롬프트 드릴다운 행
  refs: number; // 프롬프트당 답변 ref (엔진×지역 변형)
  hlBrand: number; // 답변 ref 하이라이트 용어 수 (브랜드 표기)
  hlModel: number; // 〃 (모델 표기)
}
const MENTION_SLIM_LEVELS: MentionSlimLevel[] = [
  { prompts: 25, refs: 8, hlBrand: 8, hlModel: 24 },
  { prompts: 15, refs: 6, hlBrand: 6, hlModel: 18 },
  { prompts: 10, refs: 4, hlBrand: 5, hlModel: 12 },
  { prompts: 5, refs: 2, hlBrand: 4, hlModel: 8 },
];

function applyMentionLevel(live: MentionsLive, level: MentionSlimLevel): MentionsLive {
  const perBrandPrompts: MentionsLive["perBrandPrompts"] = {};
  for (const [brand, prompts] of Object.entries(live.perBrandPrompts)) {
    perBrandPrompts[brand] = prompts.slice(0, level.prompts).map((p) => ({
      ...p,
      answers: p.answers.slice(0, level.refs).map((a) => ({
        ...a,
        highlights: {
          brand: a.highlights.brand.slice(0, level.hlBrand),
          model: a.highlights.model.slice(0, level.hlModel),
        },
      })),
    }));
  }
  return { ...live, perBrandPrompts };
}

// exported for tests.
// main 8c42657(멘션 드릴다운 lazy fetch)과의 정합: 표준/웹사이트 캐시 집계는
// brandPrompts:"none"으로 perBrandPrompts 가 이미 비어 있고, lazy 경로는
// {onlyBrand}로 한 브랜드 전량을 싣는다. 예산 이내면 원본을 무손실 통과시켜
// lazy 페이로드(한 브랜드의 전체 프롬프트 목록)를 자르지 않고, 예산 초과일 때만
// 레벨 캡이 안전판으로 든다 — 이중 캡이 서로를 깨지 않게 하는 규칙.
// typesByBrand.brands 를 랭킹 top-N ∪ 당사 로 캡. 나머지 브랜드는 UI 에서
// totals − Σ(표시 브랜드) = "기타" 세그먼트로 접히므로 손실 없음. totals 는
// 전량 유지(각 유형 점유율의 분모 불변). 증분은 브랜드 N × 5 int ≈ 수 KB 라
// 캐시 한도(2MB, perBrandPrompts 가 지배)엔 영향 없지만 상한을 못 박아 둔다.
const TYPES_BY_BRAND_CAP = 30;
function capTypesByBrand(live: MentionsLive): MentionsLive {
  const t = live.typesByBrand;
  if (!t || t.brands.length <= TYPES_BY_BRAND_CAP) return live;
  const kept = t.brands.filter((b, i) => i < TYPES_BY_BRAND_CAP || b.isTracked);
  return { ...live, typesByBrand: { totals: t.totals, brands: kept } };
}

export function slimMentionsLiveForCache(live: MentionsLive): MentionsLive {
  const capped = capTypesByBrand(live);
  return fitToBudget([
    () => capped,
    ...MENTION_SLIM_LEVELS.map((level) => () => applyMentionLevel(capped, level)),
    // 최후 안전판 — 드릴다운 답변 ref 를 비운다(프롬프트 행·수치는 유지).
    () => {
      const base = applyMentionLevel(capped, MENTION_SLIM_LEVELS[MENTION_SLIM_LEVELS.length - 1]);
      const perBrandPrompts: MentionsLive["perBrandPrompts"] = {};
      for (const [brand, prompts] of Object.entries(base.perBrandPrompts)) {
        perBrandPrompts[brand] = prompts.map((p) => ({ ...p, answers: [] }));
      }
      return { ...base, perBrandPrompts };
    },
    // 절대 상한 — 드릴다운 전체 제거 (브랜드 랭킹·요약·추이는 유지).
    () => ({ ...capped, perBrandPrompts: {} }),
  ]);
}

// ── 인용 뷰모델 슬리밍 — 도메인 행 수·드릴다운 top-N 캡 ─────────────────────
// 요약·분류 파이·엔진 구성·promptSplit 카운트(전량 SQL 집계값)는 어느 레벨에서도
// 불변. 도메인 테이블 행 수(표준 창 실측 ~8.9천 도메인 — 행만으로 >1MB)와
// 드릴다운 리스트 길이만 줄인다. domains 는 인용수 내림차순이라 slice = top-N.
interface CitationSlimLevel {
  domains: number; // 도메인 테이블 행
  drilldown: number; // urls/promptList 를 유지할 상위 도메인 수
  prompts: number; // 도메인당 프롬프트 드릴다운 행
  refs: number; // 프롬프트당 답변 ref
  splitPrompts: number; // promptSplit 버킷당 리스트 행 (카운트는 불변)
}
const CITATION_SLIM_LEVELS: CitationSlimLevel[] = [
  { domains: 2000, drilldown: CITATION_DRILLDOWN_DOMAINS, prompts: 12, refs: 8, splitPrompts: 20 },
  { domains: 1500, drilldown: 50, prompts: 10, refs: 5, splitPrompts: 15 },
  { domains: 1000, drilldown: 30, prompts: 8, refs: 4, splitPrompts: 10 },
  { domains: 600, drilldown: 15, prompts: 5, refs: 3, splitPrompts: 5 },
];

/**
 * 한 도메인 행이 실을 드릴다운의 정도.
 *  - `full`     : urls + promptList (종전 동작)
 *  - `urlsOnly` : URL 샘플만 (상위 N 밖 공식(HMG) 도메인 — 고객 요구가 "샘플 URL")
 *  - `none`     : 둘 다 비움 (순위 밖 일반 도메인 · 최후 안전판)
 */
type DrilldownKeep = "full" | "urlsOnly" | "none";

function slimDomainRow(
  d: CitationDomainLive,
  keep: DrilldownKeep,
  level: Pick<CitationSlimLevel, "prompts" | "refs">,
): CitationDomainLive {
  if (keep === "none") {
    // 공식(HMG) 행에만 "일부러 안 실었다" 표시를 남긴다 — 화면이 "URL이 아직
    // 없습니다"(정말 없음)를 띄우면 거짓말이 되기 때문. 비공식 행은 종전 문구
    // 그대로라 표시가 불필요하고, 9천 행에 붙이면 페이로드만 는다.
    return isOfficialHmgDomain(d)
      ? { ...d, urls: [], promptList: [], drilldownOmitted: true }
      : { ...d, urls: [], promptList: [] };
  }
  if (keep === "urlsOnly") {
    return { ...d, urls: d.urls.slice(0, CITATION_OFFICIAL_TAIL_URLS), promptList: [] };
  }
  return {
    ...d,
    promptList: d.promptList.slice(0, level.prompts).map((p) => ({
      ...p,
      answers: p.answers.slice(0, level.refs),
    })),
  };
}

/**
 * 공식(HMG) 도메인 여부 — 화면 카테고리 배지(`row.category`)와 **같은 값**을 본다.
 * 판정 자체는 이미 서버 집계(resolveCitationCategory)가 끝내 행에 실어 둔 것이고,
 * 여기서는 새로 분류하지 않는다 (배지와 어긋날 여지를 남기지 않기 위해서).
 */
function isOfficialHmgDomain(d: CitationDomainLive): boolean {
  return d.category === OFFICIAL_HMG_CATEGORY;
}

function applyCitationLevel(
  live: CitationsLive,
  level: CitationSlimLevel,
  // 공식(HMG) 도메인은 순위 밖이어도 행·드릴다운을 유지한다(고객 QA). false 는
  // 최후 안전판 전용 — 공식 도메인 드릴다운만으로도 예산을 넘는 병리적 입력에서
  // "캐시가 조용히 비활성화"되는 것을 막는 절대 상한이다.
  opts: { keepOfficial: boolean } = { keepOfficial: true },
): CitationsLive {
  const officialKept = (d: CitationDomainLive) => opts.keepOfficial && isOfficialHmgDomain(d);
  // `live.domains` 는 인용수 desc · 도메인 asc 로 정렬돼 있어 인덱스 = 순위이고,
  // 미러 SQL 의 `ranked` 와 같은 순서다 — 그래서 여기서 CITATION_DRILLDOWN_DOMAINS
  // 를 경계로 "상위 N 안/밖"을 다시 말할 수 있다.
  const keepOf = (d: CitationDomainLive, i: number): DrilldownKeep => {
    if (i < level.drilldown) return "full"; // 순위 캡 안 — 종전 그대로
    if (!officialKept(d)) return "none";
    // 공식 예외. SQL 이 상위 80 안에는 프롬프트까지 실었으므로 그대로 두고,
    // 80 밖 꼬리는 URL 샘플만 남긴다(레벨 강등 방지 — 위 상수 주석 참조).
    return i < CITATION_DRILLDOWN_DOMAINS ? "full" : "urlsOnly";
  };
  // filter 는 원본 상위 prefix(i < level.domains)를 그대로 두고 순위 밖 공식
  // 도메인만 뒤에 덧붙인다 — prefix 구간의 인덱스가 원본 순위와 일치하므로
  // keepOf 의 순위 판정은 종전과 동일하게 동작한다.
  const domains = live.domains
    .filter((d, i) => i < level.domains || officialKept(d))
    .map((d, i) => slimDomainRow(d, keepOf(d, i), level));
  const promptSplit =
    live.promptSplit == null
      ? live.promptSplit
      : {
          ...live.promptSplit,
          owned: live.promptSplit.owned.slice(0, level.splitPrompts),
          uncited: live.promptSplit.uncited.slice(0, level.splitPrompts),
        };
  return { ...live, domains, ...(promptSplit !== undefined ? { promptSplit } : {}) };
}

// exported for tests. 예산 이내면 원본 무손실 통과(전 도메인 행·전체 드릴다운
// 유지 — 작은 필터 조합/프로젝트 경로), 초과 시에만 레벨 캡.
export function slimCitationsLiveForCache(live: CitationsLive): CitationsLive {
  return fitToBudget([
    () => live,
    ...CITATION_SLIM_LEVELS.map((level) => () => applyCitationLevel(live, level)),
    // 절대 상한 — 드릴다운 전체 제거, 도메인 행 400개 (수치 컬럼은 유지).
    // 여기서만 공식(HMG) 예외를 끈다: 이 후보는 "무조건 예산에 드는 형태"라는
    // 보증이 존재 이유라, 예외를 남기면 그 보증이 깨진다.
    () => ({
      ...applyCitationLevel(
        live,
        { domains: 400, drilldown: 0, prompts: 0, refs: 0, splitPrompts: 3 },
        { keepOfficial: false },
      ),
    }),
  ]);
}

// ── 브랜드 인용출처(드릴다운 탭) 슬리밍 — lazy 경로지만 캐시는 같은 2MB 한도 ──
const BRAND_CITATION_SLIM_LEVELS: Array<{ domains: number; prompts: number; refs: number }> = [
  { domains: 500, prompts: 12, refs: 8 },
  { domains: 300, prompts: 8, refs: 4 },
  { domains: 150, prompts: 5, refs: 3 },
];

// exported for tests. 예산 이내면 원본 무손실 통과, 초과 시에만 레벨 캡.
export function slimBrandCitationDomainsForCache(
  domains: CitationDomainLive[],
): CitationDomainLive[] {
  return fitToBudget([
    () => domains,
    ...BRAND_CITATION_SLIM_LEVELS.map((level) => () =>
      domains.slice(0, level.domains).map((d) => slimDomainRow(d, "full", level)),
    ),
    () => domains.slice(0, 100).map((d) => slimDomainRow(d, "none", { prompts: 0, refs: 0 })),
  ]);
}

const EMPTY_MENTIONS: MentionsLive = {
  summary: { total: 0, uniqueBrands: 0, totalPrompts: 0 },
  asOf: null,
  brands: [],
  perBrandPrompts: {},
  sentimentTotals: null,
  typeTotals: null,
  hasPosition: false,
  trend: null,
};

const EMPTY_CITATIONS: CitationsLive = {
  summary: { total: 0, uniqueDomains: 0, officialOwnShare: null },
  asOf: null,
  domains: [],
  categories: null,
  trend: null,
  categoryTrend: null,
  engineCategories: null,
  promptSplit: null,
};

// 표준/website mention 페이지(brandPrompts="none")용 SQL GROUP BY 경로.
// 종전 readMirrorJobs(스냅샷의 전 브랜드·전 지역 mention 행을 통째로 로드)+
// aggregateMentionsFrom(JS 롤업)이 Hyundai 등 대형 브랜드 + 필터 조합에서 수십 초~
// Vercel 타임아웃이던 것을, 대시보드 aggregateStandard 와 동일한 answerWhere +
// GROUP BY brand_rollup_entity_id 로 대체(subKpis 급, <10s). 드릴다운
// (perBrandPrompts)은 이 경로에서 애초에 "none" 이라 계산하지 않는다. 엔티티 해석
// (rollup 이름/tracked/비경쟁 제외)은 ROLLUP_NAMES / trackedRollupIn /
// excludeNonCompetitorBrandsSql — aggregateStandard 가 쓰는 검증된 SQL 트윈이라
// JS 경로(aggregateMentionsFrom)와 동일한 수치를 낸다.
async function aggregateMentionsHeadlineSql(
  filters: StandardFilters,
  scopeProjectId: string | string[] | undefined,
  // 실행 예산 — 답변셋 트랜잭션의 문장 상한·마감. 생략하면 종전 동작(상한도 마감도 없다).
  budget: AnswerSetBudget = {},
  // 추이 주 격자 키의 원천 — **추이 문장 하나에만** 닿는다(헤드라인 수치는 무관).
  weekSource: TrendWeekSource = "measured",
): Promise<MentionsLive | null> {
  // 요청단위 공유 답변셋 — snapshotAnswerWhere 참조(공유 스코프 밖이면 종전 W).
  //
  // ⚠️ **이 한 문장은 예산 밖이다**(2026-09-11 검증 지적). `budget` 은 아래
  // `withAnswerSet` 트랜잭션 안의 문장에만 걸리는데, `snapshotAnswerWhere` 는 그 **밖**
  // 에서 full-cycle 게이트 쿼리(셀 카운트 GROUP BY + 셀당 최신 1행 DISTINCT ON, 실측
  // ~991 ms)를 먼저 돈다. 즉 언급 집계의 실효 최악은 "예산 + 문장 상한" 이 아니라
  // 거기에 **이 게이트 쿼리의 무상한 시간**이 더해진 값이다.
  // 이 경로에 예산을 씌우는 것은 PR③ 위생 A(무예산 경계 일괄 처리)로 이관한다 —
  // 게이트 쿼리는 대시보드 카드 경로도 공유하므로 한 곳에서 같이 다뤄야 한다.
  const W = await snapshotAnswerWhere(filters, scopeProjectId);

  // 필터된 답변셋(_answer_set)을 트랜잭션에서 1회만 계산 — withAnswerSet 참조.
  // 종전에는 아래 세 문장이 각각 W(표준 경로 = full-cycle 게이트 서브쿼리)를
  // 인라인으로 다시 박았고, 특히 브랜드 랭킹 문장(mentions⋈answers+names 조인)
  // 에서 플래너가 플랜을 붕괴시켜 브랜드·지역 필터 계정 대부분이 2분 statement
  // timeout(57014)으로 죽었다(2026-08-27 QA-SCN-005, 122s 재현 → 수정).
  // a.run_id 는 아래 asOf 문장이 `_answer_set a LEFT JOIN scope_runs r ON r.run_id = a.run_id`
  // 로 회차 기준일(CYCLE_AS_OF_SQL)을 읽기 때문에 필요하다 — **추가만** 하고 기존
  // 컬럼은 그대로 둔다. 투영에서 컬럼이 빠지면 TEMP 표에 없어 42703 으로 화면이
  // 통째로 죽는다(2026-09-05 프로덕션 장애, 캐시 미스 시점에 발현).
  const head = await withAnswerSet(
    sql`a.job_id, a.prompt_id, a.measured_at, a.run_id`,
    W,
    async (db) => {

  // 답변 집계 — mentionRate 분모(총 답변) · 총 프롬프트 · 측정 기준일(asOf).
  const ansAgg = (await db.execute(sql`
    SELECT count(*)::int AS answers,
      count(DISTINCT a.prompt_id)::int AS prompts,
      ${cycleAsOfDisplaySql()} AS as_of
    FROM _answer_set a LEFT JOIN scope_runs r ON r.run_id = a.run_id${anchorAsOfJoinSql(sql.raw("a.job_id"))}
  `)) as unknown as Array<{ answers: number; prompts: number; as_of: Date | string | null }>;
  const totalAnswers = num(ansAgg[0]?.answers);
  // null/empty 판정은 트랜잭션 밖(호출부)에서 — 여기서는 표식만 돌려준다.
  if (totalAnswers === 0) return null;
  const totalPrompts = num(ansAgg[0]?.prompts);
  // 앵커 축이면 이미 `YYYY-MM-DD` 텍스트다 — 다시 Date 로 파싱해 `toISOString()` 하면
  // 없는 시각(`T00:00:00.000Z`)이 붙어 JS 롤업 경로의 `round_date` 와 형식이 갈린다.
  const asOf = normalizeAsOf(ansAgg[0]?.as_of ?? null);

  // 브랜드 롤업 — 모델 rollup 합산 · 답변당 최선 순위의 평균 · tracked · 프롬프트 수.
  //
  // 2026-08-28 정합 수정 — 위치(순위)의 단위를 **코어 KPI ④와 동일하게** 맞춘다.
  // 종전 이 행은 `sum(avg_position)/count(avg_position)` = **언급 단위 평균**이라,
  // 한 답변에서 브랜드가 여러 번(브랜드 행 + 모델 행) 언급되면 그 답변이 여러 번
  // 계상됐다. 코어 ④(aggregateStandardFromMirror)는 **답변당 min(avg_position)의
  // 평균**(순위가 매겨진 답변만)이라, 같은 슬라이스에서 두 화면이 다른 값을 냈다
  // (AE/Genesis 실측: 대시보드 26.5 n=27 vs 언급 탭 26.9 n=62).
  // 이제 pos CTE 가 (브랜드, 답변) 단위로 min 을 먼저 접고, 그 평균을 낸다 —
  // pos_sum/pos_cnt 의 소비 규약(avgPosition = pos_sum ÷ pos_cnt)은 그대로다.
  //
  // 2026-09-06 — 단위를 **브랜드 내 순위**로 바꾼다(ownBrandRankPerJobSql 머리 주석).
  // pos 의 (브랜드, 답변) min 위에 답변 안 rank() 를 매기고 그 순위를 합산한다.
  // 모집단(mm: rollup 보유 + 비경쟁 제외)이 ownBrandRankPerJobSql 과 같으므로 자사
  // 행의 값은 ④ 카드와 일치한다(8/28 정합 결정 유지).
  //
  // ⚠️ `mm` 의 FROM 안에 `OFFSET 0` 배리어가 있는 이유는 추이 ②
  // (aggregateStandardTrendFromMirror)와 같다 — `MATERIALIZED` 는 CTE **결과**만
  // 고정할 뿐 그 안의 조인 순서는 여전히 플래너 몫이라, names 조인이 먼저 가면
  // 비싼 식(canonRollupSql 정규식 3개 + 비경쟁 제외 CASE)이 답변셋 밖의 언급까지
  // 전부 훑는다. 배리어가 `_answer_set` 조인과 rid 계산을 먼저 확정한다.
  // 프로덕션 실측(admin 무필터 · 표준 스냅샷): **21,252 ms → 2,320 ms** (9.2배).
  const brandRows = (await db.execute(sql`
    WITH names AS ${ROLLUP_NAMES_BARE},
    mm AS MATERIALIZED (
      SELECT ${rollupDisplayName("x")} AS name,
        x.job_id, x.prompt_id, x.mention_count, x.avg_position,
        x.rid IN ${trackedRollupIn(filters)} AS is_trk,
        x.type_mention, x.type_recommendation, x.type_comparison,
        x.type_definition, x.type_final_choice,
        x.s_pos, x.s_neu, x.s_neg, x.s_mix
      FROM (
        SELECT m.job_id, a.prompt_id, m.mention_count, m.avg_position, m.brand,
          m.type_mention, m.type_recommendation, m.type_comparison,
          m.type_definition, m.type_final_choice,
          m.sentiment_positive AS s_pos, m.sentiment_neutral AS s_neu,
          m.sentiment_negative AS s_neg, m.sentiment_mixed AS s_mix,
          ${canonRollupSql(filters)} AS rid
        FROM scope_mentions m
        JOIN _answer_set a ON a.job_id = m.job_id
        WHERE m.brand_rollup_entity_id IS NOT NULL
        OFFSET 0
      ) x
      LEFT JOIN names n ON n.entity_id = x.rid
      WHERE COALESCE(n.brand, x.brand) IS NOT NULL
        AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
    ),
    pos AS (
      SELECT name, job_id, min(avg_position) AS tp
      FROM mm WHERE avg_position IS NOT NULL GROUP BY 1, 2
    ),
    rk AS (
      SELECT name, job_id, rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM pos
    ),
    posagg AS (
      SELECT name, sum(rk) AS pos_sum, count(*)::int AS pos_cnt FROM rk GROUP BY 1
    ),
    -- 복수 언급(2026-09-02, 공통 하단 "브랜드 복수 언급" 토글): 한 답변 안에서 그
    -- 브랜드가 2회 이상 언급된 답변만 센 값. 답변×브랜드로 접은 뒤 mc>=2 필터.
    -- mm 은 MATERIALIZED 라 재스캔 비용은 접힌 행 수만큼이다.
    multi AS (
      SELECT name,
        count(*) FILTER (WHERE mc >= 2)::int AS multi_answers,
        COALESCE(sum(mc) FILTER (WHERE mc >= 2), 0)::int AS multi_mentions,
        count(DISTINCT prompt_id) FILTER (WHERE mc >= 2)::int AS multi_prompts
      FROM (
        SELECT name, job_id, prompt_id, sum(mention_count) AS mc FROM mm GROUP BY 1, 2, 3
      ) g
      GROUP BY 1
    )
    SELECT mm.name AS name,
      sum(mm.mention_count)::int AS mentions,
      count(DISTINCT mm.job_id)::int AS answers,
      count(DISTINCT mm.prompt_id)::int AS prompts,
      max(p.pos_sum) AS pos_sum,
      COALESCE(max(p.pos_cnt), 0)::int AS pos_cnt,
      COALESCE(max(mu.multi_answers), 0)::int AS multi_answers,
      COALESCE(max(mu.multi_mentions), 0)::int AS multi_mentions,
      COALESCE(max(mu.multi_prompts), 0)::int AS multi_prompts,
      bool_or(mm.is_trk) AS is_tracked,
      -- 유형×브랜드 (2026-08-12) — 브랜드 GROUP BY 안에서 유형 5종 합. 랭킹과 동일
      -- 접기·비경쟁 제외·스냅샷 술어(W) 안이라 JS 경로와 parity.
      sum(mm.type_mention)::int AS type_mention,
      sum(mm.type_recommendation)::int AS type_recommendation,
      sum(mm.type_comparison)::int AS type_comparison,
      sum(mm.type_definition)::int AS type_definition,
      sum(mm.type_final_choice)::int AS type_final_choice,
      -- 브랜드별 감정 신호 합(2026-09-02, Overview 카드의 경쟁사 우호도) — 당사 카드
      -- 산식(Q3)과 같은 언급 단위 신호 합. 컬럼만 늘어난 것이라 스캔 추가 없음.
      COALESCE(sum(mm.s_pos), 0)::int AS s_pos,
      COALESCE(sum(mm.s_neu), 0)::int AS s_neu,
      COALESCE(sum(mm.s_neg), 0)::int AS s_neg,
      COALESCE(sum(mm.s_mix), 0)::int AS s_mix
    FROM mm LEFT JOIN posagg p ON p.name = mm.name LEFT JOIN multi mu ON mu.name = mm.name
    GROUP BY 1
    ORDER BY mentions DESC
  `)) as unknown as Array<{
    name: string;
    mentions: number;
    answers: number;
    prompts: number;
    pos_sum: string | number | null;
    pos_cnt: number;
    multi_answers: number;
    multi_mentions: number;
    multi_prompts: number;
    s_pos: number;
    s_neu: number;
    s_neg: number;
    s_mix: number;
    is_tracked: boolean;
    type_mention: number;
    type_recommendation: number;
    type_comparison: number;
    type_definition: number;
    type_final_choice: number;
  }>;

  // 감정·유형 — 당사(tracked rollup) 언급 신호 합. 감정은 4계열 합 0이면 null,
  // 유형은 tracked 언급 자체가 0건이면 null(JS: type_breakdown 존재=tracked 언급 유무).
  const sig = (await db.execute(sql`
    SELECT count(*)::int AS trk_n,
      COALESCE(sum(m.sentiment_positive),0)::int AS p,
      COALESCE(sum(m.sentiment_neutral),0)::int AS ne,
      COALESCE(sum(m.sentiment_negative),0)::int AS ng,
      COALESCE(sum(m.sentiment_mixed),0)::int AS mx,
      COALESCE(sum(m.type_mention),0)::int AS t_mention,
      COALESCE(sum(m.type_recommendation),0)::int AS t_rec,
      COALESCE(sum(m.type_comparison),0)::int AS t_comp,
      COALESCE(sum(m.type_definition),0)::int AS t_def,
      COALESCE(sum(m.type_final_choice),0)::int AS t_final
    FROM scope_mentions m
    JOIN _answer_set a ON a.job_id = m.job_id
    WHERE ${trackedRollupPredicate(filters)}
  `)) as unknown as Array<Record<string, number>>;

  return { totalAnswers, totalPrompts, asOf, brandRows, sig };
  }, budget);

  // null(EmptyState) vs empty-shape(필터가 비움) 구분 — 종전 wrapper 계약과 동일.
  // 트렌드(별도 8s 가드 쿼리)와 폴백 판정은 답변셋 트랜잭션 밖에서 돈다.
  if (!head) {
    return (await mirrorHasAnswers(scopeProjectId)) ? { ...EMPTY_MENTIONS } : null;
  }
  const { totalAnswers, totalPrompts, asOf, brandRows, sig } = head;

  const totalMentions = brandRows.reduce((s, b) => s + num(b.mentions), 0);
  const pctOf = (n: number, d: number): number =>
    d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
  let positionSeen = false;
  const brands: MentionsBrandLive[] = brandRows.map((b) => {
    const posCnt = num(b.pos_cnt);
    if (posCnt > 0) positionSeen = true;
    return {
      brand: b.name,
      mentions: num(b.mentions),
      prompts: num(b.prompts),
      share: pctOf(num(b.mentions), totalMentions),
      mentionRate: pctOf(num(b.answers), totalAnswers),
      avgPosition: posCnt > 0 ? Math.round((num(b.pos_sum) / posCnt) * 10) / 10 : null,
      isTracked: b.is_tracked === true,
      multi: {
        mentions: num(b.multi_mentions),
        answers: num(b.multi_answers),
        prompts: num(b.multi_prompts),
      },
      sentiment: {
        positive: num(b.s_pos),
        neutral: num(b.s_neu),
        negative: num(b.s_neg),
        mixed: num(b.s_mix),
      },
    };
  });
  const s = sig[0] ?? {};
  const sentimentTotals: MentionSentimentBreakdown = {
    positive: num(s.p),
    neutral: num(s.ne),
    negative: num(s.ng),
    mixed: num(s.mx),
  };
  const sentimentSeen =
    sentimentTotals.positive +
      sentimentTotals.neutral +
      sentimentTotals.negative +
      sentimentTotals.mixed >
    0;
  const typeTotals: MentionTypeBreakdown = {
    mention: num(s.t_mention),
    recommendation: num(s.t_rec),
    comparison: num(s.t_comp),
    definition: num(s.t_def),
    final_choice: num(s.t_final),
  };
  const typesSeen = num(s.trk_n) > 0;

  // 추이 — 일별 SQL 롤업(전체 이력) + JS 주차 버킷. allRuns(전 이력)이라 무거운
  // 필터 조합에서 statement_timeout 을 낼 수 있다 → 8s 가드로 빠르게 실패시키고
  // 추이만 null 로 degrade(헤드라인 수치는 위 SQL 로 이미 확정, 페이지 안 죽음).
  // 시리즈 = 창 내 어느 주차든 top-10 에 든 브랜드의 합집합(누적 상위 15 캡) —
  // union 계산에 전 브랜드 day-count 가 필요하므로 seriesKeys 로 좁히지 않는다
  // (답변셋은 readMentionBrandDayCounts 의 MATERIALIZED CTE 로 이미 바운드).
  let trend: MentionsLive["trend"] = null;
  let trendDegraded = false;
  try {
    // 예산이 이미 소진됐으면 **보내지 않는다**(PR③) — 헤드라인은 위에서 확정됐고,
    // 이 문장을 마감 뒤에 또 보내면 실효 최악이 그만큼 늘어난다. 종전처럼 추이만 degrade.
    if (budget?.deadlineAt && Date.now() >= budget.deadlineAt) {
      throw new AnswerSetDeadlineError("mention trend rollup");
    }
    // 문장 상한 20s — 종전 8s 의 근거(CTE 하네스 측정)는 오측정이었다(kpi-tab-budget
    // 주석). 초과 시 trendDegraded=true 로 표시해 캐시가 그 결과를 저장하지 않게 한다.
    // `true` = 이 산출물은 `withWeeklyTrendGrid` 가 자리 목록에 얹는다(통합 B1).
    const trendRows = await readMentionBrandDayCounts(
      filters, true, scopeProjectId, undefined,
      budget?.statementTimeoutMs ?? 20_000, weekSource);
    const entries = trendRows.map((r) => ({ date: r.day, key: r.key, count: r.n }));
    const seriesBrands = weeklyTopNUnion(entries, 10, 15);
    trend = buildMentionTrend(
      entries.map((e) => ({ date: e.date, brand: e.key, count: e.count })),
      seriesBrands,
    );
  } catch (e) {
    console.warn(
      "[mentions] trend rollup skipped (headline still served):",
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    trendDegraded = true;
  }

  // 유형×브랜드 (JS 경로와 동일 규칙·null 규약 = totals 합 > 0). totals = 전
  // 브랜드 합(컷 전), brands = 랭킹 순서(ORDER BY mentions DESC) 그대로.
  const typesByBrandTotals: MentionTypeBreakdown = brandRows.reduce(
    (acc, b) => {
      acc.mention += num(b.type_mention);
      acc.recommendation += num(b.type_recommendation);
      acc.comparison += num(b.type_comparison);
      acc.definition += num(b.type_definition);
      acc.final_choice += num(b.type_final_choice);
      return acc;
    },
    { mention: 0, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
  );
  const typesByBrandSum =
    typesByBrandTotals.mention +
    typesByBrandTotals.recommendation +
    typesByBrandTotals.comparison +
    typesByBrandTotals.definition +
    typesByBrandTotals.final_choice;
  const typesByBrand =
    typesByBrandSum > 0
      ? {
          totals: typesByBrandTotals,
          brands: brandRows.map((b) => ({
            brand: b.name,
            isTracked: b.is_tracked === true,
            types: {
              mention: num(b.type_mention),
              recommendation: num(b.type_recommendation),
              comparison: num(b.type_comparison),
              definition: num(b.type_definition),
              final_choice: num(b.type_final_choice),
            },
          })),
        }
      : null;

  return slimMentionsLiveForCache({
    summary: { total: totalMentions, uniqueBrands: brands.length, totalPrompts, totalAnswers },
    asOf,
    brands,
    perBrandPrompts: {},
    sentimentTotals: sentimentSeen ? sentimentTotals : null,
    typeTotals: typesSeen ? typeTotals : null,
    typesByBrand,
    hasPosition: positionSeen,
    trend,
    ...(trendDegraded ? { trendDegraded: true } : {}),
  });
}

export async function aggregateMentionsFromMirror(
  filters: StandardFilters = {},
  scopeProjectId?: string | string[],
  // 2026-07-08: 드릴다운 perBrandPrompts를 어디까지 채울지. 표준/웹사이트의
  // 캐시되는 집계는 "none"으로 호출해 12.4MB→13KB로 줄이고(2MB 캐시 한도),
  // 드릴다운 클릭 시 {onlyBrand}로 그 브랜드만 lazy fetch. 미지정(프로젝트 경로)은
  // "all"(전량) — 프로젝트 단일 데이터는 작아 한도 안. result-adapter 참조.
  brandPrompts: "all" | "none" | { onlyBrand: string } = "all",
  // 실행 예산. 생략하면 종전 동작 — 문장 상한도 마감도 없다.
  // **두 경로가 예산을 다르게 집행한다**(PR③ 통합에서 JS 경로까지 넓혔다):
  //   · "none"(SQL 헤드라인) → `withAnswerSet` 이 트랜잭션에 `SET LOCAL` 로 건다.
  //   · JS 경로            → 무거운 읽기마다 자기 트랜잭션(`budgetedReader`).
  //     드릴다운은 데이터가 작아 호출부가 예산을 안 넘기고(= 종전 동작), 프로젝트
  //     표면만 `mentionsJs` 프로파일을 넘긴다(전송 지배라 문장 상한 없이 마감만).
  // 값 계약(`MentionsLive | null`)은 무변경이다 — 예산 초과는 **예외**로 나가고
  // 호출부(`degradeAware`)가 그것만 삼킨다.
  budget: AnswerSetBudget = {},
  // 추이 주 격자 키의 원천(2026-09-17). 기본값 `measured` = **종전 SQL 과 문자 동일** —
  // 이 인자를 안 넘기는 표면(웹사이트·프로젝트·드릴다운)은 아무것도 안 바뀐다.
  // 정본 주석은 `trendWeekKey`. 켜는 것은 화면 키 `S2.mentionTrend` 다(`lib/scope/server.ts`).
  weekSource: TrendWeekSource = "measured",
): Promise<MentionsLive | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  // 표준/website 페이지 로드(=캐시되는 "none") 는 SQL GROUP BY 경로로 — 전 mention
  // 행 로드+JS 롤업의 타임아웃을 없앤다. 프로젝트("all")·드릴다운({onlyBrand})은
  // 기존 JS 경로 유지(데이터가 작아 문제 없고, 드릴다운 상세를 그대로 산출).
  if (brandPrompts === "none") {
    return aggregateMentionsHeadlineSql(filters, scopeProjectId, budget, weekSource);
  }
  // ⚠️ 이 경로 전체를 **하나의 마감**으로 감싼다(2026-09-11 검증 F2). read 를 t≈0 에
  // 한꺼번에 띄우므로 "문장 발행 전 마감 확인" 만으로는 아무것도 못 막았다 — 개별
  // read 의 `raceDeadline` 은 그 read 하나만 보고, 여기 바깥 마감이 **경로 전체**의
  // 벽시계를 보장한다(둘 다 같은 `deadlineAt` 이라 먼저 도달한 쪽이 발화한다).
  return raceDeadline(budget, "mentions JS path", (async () => {
  const [jobs, promptMap, trendRows, brandNames] = await Promise.all([
    readMirrorJobs(
      scopeProjectId,
      filters,
      budget,
      typeof brandPrompts === "object" ? brandPrompts.onlyBrand : undefined,
    ),
    readMirrorPromptMap(),
    // 이 경로의 추이 문장은 종전에 상한이 **없었다**(세션 기본). 예산이 있으면 건다.
    // `mentionsJs` 는 문장 상한이 없으므로(전송 지배) 바깥 마감이 유일한 상한이다.
    // `true` = 주 격자에 얹히는 산출물(통합 B1).
    readMentionBrandDayCounts(
      filters, true, scopeProjectId, undefined, budget?.statementTimeoutMs, weekSource),
    readBrandNameMap(),
  ]);
  // 프로젝트 커스텀 태그 — JS 경로(jobs)에는 promptAttrPasses 가 태그를 모른다.
  // SQL 경로(answerWhere/detailAnswerWhere)와 동일 의미로 허용 prompt 집합을
  // 좁힌다 (2026-08-06 고객 피드백: Tag Filter 미작동). 추이(trendRows)는
  // answerWhere 를 타므로 이미 적용돼 있다.
  const cff = filters.customFieldFilters;
  const cffJobs =
    cff && Object.values(cff).some((v) => v.length)
      ? await (async () => {
          // 후속 문장도 예산 안이다 — 종전에는 이 둘만 예산 밖이라 마감 뒤에도 나갔다(F2).
          const allowed = await budgetedReader(budget, "custom field prompt ids",
            (db) => readCustomFieldPromptIds(cff, db));
          return jobs.filter((j) => j.prompt_id && allowed.has(j.prompt_id));
        })()
      : jobs;
  // website country — JS 경로(makeResultPasses)는 이 축을 모른다. SQL 경로
  // (answerWhere/detailAnswerWhere)와 동일 의미로 허용 prompt 집합을 좁힌다
  // (2026-08-25 GGMD 버그: website 멘션 드릴다운 프롬프트가 지오 필터 무시).
  const wc = filters.websiteCountry;
  const taggedJobs = wc?.length
    ? await (async () => {
        const allowed = await budgetedReader(budget, "website country prompt ids",
          (db) => readWebsiteCountryPromptIds(wc, db));
        return cffJobs.filter((j) => j.prompt_id && allowed.has(j.prompt_id));
      })()
    : cffJobs;
  const base = aggregateMentionsFrom(taggedJobs, promptMap, stripDates(filters), { brandPrompts, globalNames: brandNames });
  if (!base) {
    return (await mirrorHasAnswers(scopeProjectId)) ? { ...EMPTY_MENTIONS } : null;
  }
  // 추이 교체: 수치는 스냅샷 배치, 추이는 기간 내 전체 이력 (일별 SQL 롤업 →
  // 기존 JS 주차 버킷). 시리즈는 스냅샷 상위 10개 브랜드 — 종전과 동일.
  base.trend = buildMentionTrend(
    trendRows.map((r) => ({ date: r.day, brand: r.key, count: r.n })),
    base.brands.slice(0, 10).map((b) => b.brand),
  );
  // 캐시 바이트 상한 — 헤드라인 수치는 그대로, 드릴다운만 top-N 캡.
  return slimMentionsLiveForCache(base);
  })());
}

// ── 인용 분석 — SQL GROUP BY 집계 (2026-07-22 전환) ─────────────────────────
// 종전에는 스냅샷 창의 scope_citations 전 행(표준 ~18만 행, URL 평균 146자 →
// 수십 MB)을 Node 로 가져와 aggregateCitationsFrom 이 JS 로 롤업했다 — 인용
// 페이지가 warm 에서도 9~18s 를 내던 1차 원인. 이제 도메인/카테고리/엔진 합계는
// SQL GROUP BY 로 내리고, URL·프롬프트 드릴다운은 상위 도메인에 한해서만
// 행 단위로 가져온다. 출력 형태(CitationsLive)와 판정 규칙은 종전 JS 경로와
// 동일하게 유지한다(아래 각 지점에 대응 규칙 주석).
//
// 종전 JS 경로와의 의도적 현상 유지(변경 아님 — 기존에도 이랬음):
//  - funnelStage: 종전에는 scope_prompts.funnel_stage 기준이라 대시보드 KPI 의
//    answerWhere(카탈로그 prompts.funnel_stage)와 어휘가 갈렸다. 필터 옵션이
//    한글 3단계 정본이라 이 경로는 **항상 빈 결과**였다 → 2026-09-04 부로
//    카탈로그 우선(COALESCE) 으로 통일.
//  - customFieldFilters 는 2026-08-07 적용 (프로젝트 Tag Filter 미작동 고객
//    피드백 — 아래 술어 참조).
//  - lang/websiteCountry 는 종전 미적용("판정 불변" 보존)이었으나, 웹사이트 언급
//    드릴다운에서 국가·언어 필터 밖 프롬프트가 노출되는 것으로 고객 검수에서
//    확인돼(2026-08-25) answerWhere 와 동일 술어를 적용한다. 표준 경로는 이 두
//    축을 보내지 않으므로 영향 없음.
//
// makeResultPasses(stripDates) + promptAttrPasses 의 SQL 트윈 — 스냅샷 창 +
// 비날짜 축. answerWhere 를 재사용하지 않는 이유: answerWhere 는 funnel 을
// 카탈로그(prompts.funnel_stage)로 좁히고 lang/websiteCountry 도 적용하는데,
// 인용/언급 상세 페이지의 종전 JS 판정은 lang 등을 적용하지 않았다
// (funnel 어휘 불일치는 2026-09-04 에 카탈로그 우선으로 해소). 판정 불변을 위해 JS 규칙을 그대로 SQL 로 옮긴다.
// 카탈로그 축 술어는 answerWhere(2026-07-22 planner 교훈)와 동일하게 하나의
// prompts semi-join 으로 병합하고, 표준(루트) 경로의 705 게이트(00fa333)도 같은
// 서브쿼리에 접는다.
// 추이(allRuns) 모드의 창 술어 — answerWhere 의 allRuns 분기와 1:1 대응.
//  · 프로젝트 경로: run_id → project_id 로만 좁힌다(셀당 최신 접기 없음).
//  · 루트(표준) 경로: 루트 프로젝트의 런 + 숨김 지역 제외(answerWhere 와 동일 —
//    카탈로그 705 게이트는 호출부에서 catalogPreds 로 이미 접힌다).
//  · 날짜: 스냅샷은 "기간 내 최신 배치"라 런 선택에 걸지만, 추이는 기간 안의
//    변화를 보는 읽기라 measured_at 행 범위로 좁힌다(answerWhere :519 와 동일).
// a.status='completed' 는 스냅샷 모드에서 ids 서브쿼리가 이미 걸어주지만 추이
// 모드에는 그 서브쿼리가 없으므로 여기서 명시한다.
// `prefix` — 컬럼 표기. 별칭 있는 경로는 `"a."`(detailAnswerWhere), 미러의 bare
// 경로는 `""`(snapshotRunFilter — `scope_answers` 단일 FROM 이라 별칭이 없다).
// 두 경로가 **같은 창 규칙**을 쓰게 하려고 뽑았다: 한쪽만 누적으로 바뀌면 같은
// 화면의 카드(SQL 경로)와 드릴다운(JS 미러 경로)이 다른 모집단을 센다 —
// 2026-09-16 독립 검증 실측 **카드 156,566 vs 드릴다운 37,200 = 4.2배**.
function detailAllRunsWindowPreds(
  f: StandardFilters,
  projectCtx: string | string[] | undefined,
  // 누적이면 기간 축이 **회차 앵커**다(cumulativeRunWindow). 추이(allRuns)는 버킷이
  // measured_at 일(day)이라 종전 축을 유지한다 — answerWhere 의 같은 분기와 1:1.
  cumulative = false,
  prefix: "a." | "" = "a.",
  family: AnchorHiddenFamily = DEFAULT_HIDDEN_FAMILY,
): SQL[] {
  const col = (name: string) => sql.raw(`${prefix}${name}`); // 고정 리터럴 — 사용자 입력 아님
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const ids = Array.isArray(projectCtx) ? projectCtx : projectCtx ? [projectCtx] : [];
  const conds: SQL[] = [sql`${col("status")} = 'completed'`];
  const rootProjectId = ids.length > 0 ? null : addressableRootProjectId();
  const runScope =
    ids.length > 0
      ? sql`project_id = ${uuidAnyParam(ids)}`
      : rootRunScopeSql("", rootProjectId);
  // 앵커 축(옵트인) — 누적이든 추이든 기간은 `ca.round_date` 로 건다.
  //   · 누적: `cumulativeRunWindow`(run 앵커 + measured 폴백)를 대체한다.
  //   · 추이: 아래 `measured_at` 행 클리핑을 대체한다. 버킷은 별도로 전환된다.
  // run 스코프 semi-join 은 두 경우 모두 그대로 남는다(프로젝트 경계는 run 축이다).
  const anchorPeriod = anchorPeriodClause(f, col("job_id"), family);
  conds.push(
    anchorPeriod || !cumulative
      ? sql`${col("run_id")} IN (SELECT run_id FROM scope_runs WHERE ${runScope})`
      : cumulativeRunWindow(f, col("run_id"), col("measured_at"), runScope),
  );
  if (anchorPeriod) conds.push(anchorPeriod);
  if (ids.length === 0 && HIDDEN_STANDARD_REGIONS.length) {
    conds.push(sql`${col("region")} NOT IN (${inList([...HIDDEN_STANDARD_REGIONS])})`);
  }
  // PR④ — 루트 추이만 사실표와 모수를 맞춘다(`answerWhere` 루트 분기와 **같은 함수**).
  // KPI 탭 추이 3종이 이 한 자리를 공유하므로, 여기 한 번이면 셋 다 같은 모수를 본다
  // (`kpiTabTrendWhere` 머리 주석이 `excludeHiddenCycleRuns` 에 대해 말하는 것과 같다).
  // ⚠️ 술어가 `a.prompt_id`·`a.region` 을 **별칭으로** 참조한다 — bare 경로(`prefix=""`,
  //    누적 전용)에서는 컬럼이 안 맞으므로 누적과 함께 제외된다(아래 조건의 `!cumulative`).
  if (ids.length === 0 && !cumulative && prefix === "a.") {
    // 이 계열(KPI 탭 추이)의 자기 창은 `measured_at` 축이라 바닥으로 못 쓴다 —
    // 기간 필터(`f.dateFrom`)가 있을 때만 넘긴다(`trendRoundFloorSql` 주석).
    conds.push(...trendAlignedRootPreds(col("job_id"), !anchorPeriod, trendRoundFloorSql(f, {})));
  }
  // ⚠️ 앵커 축이 기간을 이미 걸었으면 `measured_at` 으로 또 자르지 않는다 —
  // 회차 꼬리 측정의 이월(라이브 90일 27.0%)이 잘려 "회차 통째로"가 깨진다.
  if (!cumulative && !anchorPeriod) {
    conds.push(...periodBounds(f, answerMeasuredAxis(col("measured_at"))));
  }
  return conds;
}

// 카탈로그(prompts 테이블) 축 술어 — brand / brandPresence / listType / depth1-3
// + 루트 게이트. **detailAnswerWhere 와 프롬프트 수 카운트가 같은 함수를 쓰게**
// 하려고 뽑았다: 화면의 "적용 프롬프트 수"가 탭 지표의 모집단과 다른 술어로
// 세어지면, 사용자는 두 숫자 중 어느 쪽이 틀렸는지 알 길이 없다.
// push 순서는 종전 detailAnswerWhere 본문과 동일하다 — 컴파일 SQL 이 바이트
// 동일해야 기존 술어 테스트가 그대로 성립한다.
function catalogPromptPreds(
  f: StandardFilters,
  projectCtx?: string | string[],
  /**
   * 루트 카탈로그 게이트를 **생략**한다(dim 스냅샷 경로에서만 true). 기본 false 라
   * 종전 호출부(프롬프트 수 카운트·스냅샷)는 한 글자도 안 바뀐다.
   */
  skipRootCatalogGate = false,
): SQL[] {
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const catalogPreds: SQL[] = [];
  const catalogIn = (col: string, vals: string[]) =>
    catalogPreds.push(sql`${sql.raw(col)} IN (${inList(vals)})`);
  // 표준(루트) 뷰 = 705 카탈로그 게이트 — snapshotRunFilter(bare)와 동일 시맨틱.
  // dim 경로(`skipRootCatalogGate`)에서도 **축 필터가 붙으면** 루트 한정을 살린다 —
  // 아래에서 필터를 쌓은 뒤 판정한다(검증자 주장 2: 필터 값 조회가 스코프를 잃었다).
  const rootScopePred = sql`project_id = ${STANDARD_ROOT_PROJECT_ID}`;
  if (!hasProjectCtx(projectCtx) && !skipRootCatalogGate) {
    catalogPreds.push(rootScopePred);
  }
  if (f.brand?.length) catalogIn("brand", f.brand);
  // brandPresence: JS promptAttrPasses 는 brandPresenceOf(brand, brand_presence)가
  // non-null 이고 선택값에 포함될 때만 통과 — 둘 다 선택돼도 presence 미상(null)
  // 프롬프트는 제외된다 (answerWhere 의 "둘 다 선택 → 무필터"와 다른, 상세 경로의
  // 종전 규칙). 단일 선택은 brandPresencePredicate(0032 정본 우선 + 태그 폴백).
  if (f.brandPresence?.length) {
    const pred = brandPresencePredicate(f.brandPresence);
    catalogPreds.push(pred ?? sql`${brandPresenceResolvedSql()} IS NOT NULL`);
  }
  if (f.listType?.length) catalogIn("list_type", f.listType);
  if (f.depth1?.length) catalogIn("depth1", f.depth1);
  if (f.depth2?.length) catalogIn("depth2", f.depth2);
  if (f.depth3?.length) catalogIn("depth3", f.depth3);
  // ⚠️ 알려진 한계는 `answerWhere` 의 같은 자리 주석과 동일하다 — 필터가 붙으면 현재값
  //    루트 한정과 dim 스냅샷 게이트가 함께 걸려, 회차 생성 뒤 루트에서 빠진 프롬프트가
  //    **필터 뷰에서만** 소급 제외된다. 필터 값이 `prompts` 에만 있고 dim 에 없어서 생기는
  //    구조적 한계다(현재 영향 0, 대조 감사 후보).
  if (!hasProjectCtx(projectCtx) && skipRootCatalogGate && catalogPreds.length) {
    catalogPreds.unshift(rootScopePred);
  }
  return catalogPreds;
}

/**
 * 필터가 걸린 **카탈로그 프롬프트 수**("적용 프롬프트") — 측정 개요 카드용.
 *
 * 미러(측정된 것)가 아니라 카탈로그(측정 대상)를 센다: "적용 233 / 측정 230 /
 * 미측정 3"의 첫 칸이 이 값이고, 미측정은 두 수의 차다. 카탈로그는 수백 행
 * 규모라 스캔이 상수급이다(미러 집계와 달리 timeout 가드가 필요 없다).
 *
 * **비교 상대는 카드의 "측정" 칸**, 즉 `aggregateSubKpisFromMirror` → `answerWhere`
 * 다(2026-09-01 재검증 C6 — 종전 주석이 상대를 `detailAnswerWhere` 로 잘못 지목했다).
 * 두 경로는 같은 카탈로그 컬럼을 본다: `answerWhere` 의 퍼널은
 * `catalogIn("funnel_stage", …)` 로 **카탈로그 `prompts.funnel_stage`** 이고
 * (2026-06-10 D6 — HMG 3단계 한국어 어휘가 정본), 이 카운트도 같은 컬럼을 쓴다.
 * 따라서 이 카드의 두 수 사이에 퍼널 해석 차이는 없다.
 *
 * **프롬프트 축은 빠짐없이 반영해야 한다.** 2026-09-01 실측: 퍼널(promptContext)이
 * 카운트 쪽에만 빠져 있어, 퍼널을 고르면 "적용"은 그대로인데 "측정"만 줄어
 * **미측정이 통째로 부풀려졌다**. 퍼널은 필터 바의 프롬프트 행
 * (FILTER_SECTIONS.prompt)이므로 이 카운트에도 걸려야 한다.
 *
 * `deleted_at` 은 **일부러 걸지 않는다** — 두 상대 경로의 카탈로그 semi-join 에도
 * 없다. 한쪽에만 걸면 소프트삭제 행만큼 모집단이 어긋난다. 소프트삭제를 실제로
 * 제외하려면 세 경로를 함께 바꿔야 한다(후속).
 *
 * 답변 축(지역·엔진·기간)은 계속 무시한다 — 그 축들은 "이 프롬프트가 카탈로그에
 * 있는가"가 아니라 "측정이 있었는가"만 바꾼다. 대신 그 축이 걸린 화면은
 * 뺄셈을 멈추고 문구를 바꾼다(`hasAnswerOnlyAxes` / `promptCoverage`).
 */
/** exported for tests (SQL 텍스트 검증) — 런타임 호출부는 아래 카운트 하나뿐. */
export function catalogPromptCountWhere(
  filters: StandardFilters,
  projectCtx?: string | string[],
): SQL {
  const preds = catalogPromptPreds(filters, projectCtx);
  // 퍼널(promptContext)은 필터 바의 **프롬프트 행** 축이다 — 카운트에서 빠지면
  // "적용"만 안 줄어 미측정이 부풀려진다(verifier 2026-09-01 실측).
  if (filters.funnelStage?.length) {
    preds.push(
      sql`funnel_stage IN (${sql.join(filters.funnelStage.map((v) => sql`${v}`), sql`, `)})`,
    );
  }
  preds.push(sql`scope_prompt_id IS NOT NULL`);
  return sql.join(preds, sql` AND `);
}

export async function countCatalogPromptsFromCatalog(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
): Promise<number | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  if (!kpiTabHasScope(projectCtx)) return null;
  const rows = (await getDb().execute(sql`
    SELECT count(*)::int AS n FROM prompts WHERE ${catalogPromptCountWhere(filters, projectCtx)}
  `)) as unknown as Array<{ n: number }>;
  return num(rows[0]?.n);
}

export interface UnmeasuredPrompt {
  id: string;
  text: string;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  funnelStage: string | null;
}

/**
 * 미측정 프롬프트 목록(2026-09-02 피그마 1:1 — 측정 개요 카드 "미측정" 모달).
 * 적용 = 카탈로그(countCatalogPromptsFromCatalog 와 같은 술어), 측정 = 스냅샷 답변셋에
 * 답변이 있는 prompt_id. 차집합이 미측정이다 — 카드의 "적용 − 측정" 과 같은 정의.
 * 답변 축(지역·엔진·기간)이 걸리면 "그 조건에서 안 잡힌 것"이지 미측정이 아니므로
 * 호출부(카드)가 conditional 이면 이 목록을 열지 않는다.
 */
export async function listUnmeasuredPromptsFromCatalog(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
  opts: { limit?: number; statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<{ total: number; rows: UnmeasuredPrompt[] } | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (!kpiTabHasScope(projectCtx)) return null;
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  return withAnswerSet(
    sql`a.prompt_id`,
    detailAnswerWhere(filters, projectCtx),
    async (db) => {
      const rows = (await db.execute(sql`
        WITH measured AS (SELECT DISTINCT prompt_id FROM _answer_set)
        SELECT p.id::text AS id, p.text AS text, p.list_type AS list_type,
          p.depth1 AS depth1, p.depth2 AS depth2, p.funnel_stage AS funnel_stage,
          count(*) OVER ()::int AS total
        FROM prompts p
        WHERE ${catalogPromptCountWhere(filters, projectCtx)}
          AND NOT EXISTS (SELECT 1 FROM measured m WHERE m.prompt_id = p.scope_prompt_id)
        ORDER BY p.list_type NULLS LAST, p.depth1 NULLS LAST, p.text
        LIMIT ${limit}
      `)) as unknown as Array<{
        id: string; text: string; list_type: string | null; depth1: string | null;
        depth2: string | null; funnel_stage: string | null; total: number;
      }>;
      return {
        total: num(rows[0]?.total),
        rows: rows.map((r) => ({
          id: r.id, text: r.text, listType: r.list_type, depth1: r.depth1,
          depth2: r.depth2, funnelStage: r.funnel_stage,
        })),
      };
    },
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
}

// exported for tests (SQL 텍스트 검증) — 런타임 호출부는 이 파일 내부뿐.
//
// `opts.allRuns` (2026-08-28, 4-KPI 탭 집계): 회차 시계열 읽기용. 스냅샷(기본)은
// job_id 를 "셀당 최신 1건"으로 접기 때문에 버킷이 하나로 붕괴한다 — 추이는 창
// 안의 모든 런을 봐야 한다. 창 선택 규칙은 answerWhere(:430, opts.allRuns)와
// **같은 시맨틱**으로 맞춘다(run→project 로 좁히고, 루트 경로는 숨김 지역 제외,
// 날짜는 measured_at 행 클리핑). 축(지역·엔진·카탈로그·태그·website) 술어는 두
// 모드가 그대로 공유하므로, 탭 트렌드와 탭 히어로의 모집단이 창 폭에서만 다르고
// 필터 해석에서는 갈라지지 않는다. 기존 2-인자 호출부는 동작·SQL 텍스트 불변.
export function detailAnswerWhere(
  f: StandardFilters,
  projectCtx?: string | string[],
  opts: { allRuns?: boolean; hiddenFamily?: AnchorHiddenFamily } = {},
): SQL {
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const catalogPreds: SQL[] = catalogPromptPreds(
    f,
    projectCtx,
    // dim 스냅샷 경로면 루트 게이트는 dim 이 쥔다(두 벌이면 소급 제외가 살아난다).
    trendDimPathActive(opts.allRuns === true, cumulativeMode(f, opts.allRuns === true)),
  );
  const conds: SQL[] = [bulkMirrorRunVisibleSqlKnown(sql`a.run_id`)];
  // 기간 의미론 — `answerWhere`(:1109-1110)와 **같은 규칙**이어야 한다.
  //
  // 2026-09-15 고객 신고(이노션, GENESIS GV80 HEV 런칭 1.2v): "기간을 걸어도
  // genesisnewseurope.com 인용이 안 보인다". 원인은 이 함수가 `f.cumulative` 를
  // 아예 읽지 않아 **항상 스냅샷**으로 돌던 것이다 — 페이지는 2026-09-04부터
  // `cumulative: true` 를 넘기고 있었는데(`.../analysis/citation/page.tsx:51`)
  // 술어가 무시했다. 떨어뜨리는 게이트가 둘이고 각각 단독으로 충분했다:
  //   ① 셀당 최신 1건(latestAnswerIds) — 8/19~9/15 창의 당선 474셀이 전부 9/9·9/10
  //   ② floor_at 7일 바닥 — 창 안 max(measured_at) 2026-09-10 05:12Z 기준 바닥이
  //      2026-09-03 05:12Z(KST 09-03 14:12)라 9/2 답변은 순위와 무관하게 배제
  // 실측(prompt 77eb27e1…·chatgpt·KR): 스냅샷 8/19~9/15 → 인용 0, 누적 → 3
  // (9/2 2건 + 8/19 1건). 확정 기획(제품 책임자 2026-09-16) = 필터 없으면 최신 1회차,
  // 기간을 걸면 그 기간에 걸치는 회차 전부 — #225 가 웹사이트 경로에 세운 규약
  // (스냅샷 = 배치 선택 / 누적 = 런 전체 + measured_at 클리핑)과 같다.
  //
  // ⚠️ 추이 읽기(`opts.allRuns`)에는 걸지 않는다 — `kpiTabTrendWhere` 가 자기 창
  // (now − N days)을 갖는데 아래 기본 7일 창이 얹히면 주별 그래프가 한 주로
  // 접힌다(2026-09-04 answerWhere 에서 실제로 발생한 사고).
  //
  // 판정은 `answerWhere` 와 **같은 함수** `cumulativeMode` 다 — 세 조건("누적
  // 표면이고 / 추이가 아니고 / 기간이 실제로 걸렸을 때")의 근거와 실측은 그
  // 머리 주석에 있다. 술어를 두 벌로 두면 또 어긋난다(이 버그가 정확히 그것이었다).
  const cumulative = cumulativeMode(f, opts.allRuns);
  // ⚠️ 축 on 의 분기 조건은 `answerWhere`(:anchorOn && opts.allRuns !== true)와 **같아야**
  // 한다(검증 N1). 종전에는 여기만 `cumulative` 를 함께 봤고, 축 on + 기간이면
  // `cumulativeMode` 가 `anchor_period` 를 내 `cumulative=true` → 창 술어로 빠져
  // **회차 dedup 이 없었다**. 그 결과 같은 필터에서 카드는 회차당 셀 1건, 상세 탭은
  // 회차 안 재측정 전부였다(축 off 에서는 양쪽 다 dedup 이 없어 일치했으므로 회귀다).
  const anchorSnapshot = anchorAxisKnownEnabled() && opts.allRuns !== true;
  const allRuns = !anchorSnapshot && (opts.allRuns === true || cumulative);
  const hiddenFamily = opts.hiddenFamily ?? DEFAULT_HIDDEN_FAMILY;
  conds.push(
    ...(allRuns
      ? detailAllRunsWindowPreds(f, projectCtx, cumulative, "a.", hiddenFamily)
      : [sql`a.job_id IN ${snapshotAnswerIds(projectCtx, f, hiddenFamily)}`]),
  );
  // region: makeResultPasses 는 region 미상(null) 답변을 활성 필터에서 제외 —
  // SQL IN 도 NULL 을 제외하므로 동일.
  if (f.region?.length) conds.push(sql`a.region IN (${inList(f.region)})`);
  if (f.engine?.length) conds.push(sql`a.target IN (${inList(f.engine)})`);
  // funnel: JS promptMap(readMirrorPromptMap)의 funnel = scope_prompts.funnel_stage.
  if (f.funnelStage?.length) {
    // 2026-09-04: 종전에는 scope_prompts.funnel_stage 만 봤다. 필터 옵션은 HMG
    // 3단계 한글 정본(인지/탐색·비교/검증·구매/사후관리)인데 그 컬럼은 scope 의
    // 레거시 영문 5단계라 **어떤 값도 매칭되지 않았다** — 퍼널을 걸면 화면이
    // 통째로 비었다(라이브 실측: 한글 3값 매칭 답변 192건 vs 카탈로그 기준
    // 169,523건). 카탈로그(prompts.funnel_stage)를 우선하고, 카탈로그에 없는
    // 프롬프트만 scope 값으로 폴백한다 — readMirrorPromptMap 의 JS 판정과 동일.
    conds.push(
      sql`a.prompt_id IN (
        SELECT sp.prompt_id FROM scope_prompts sp
        LEFT JOIN prompts pc ON pc.scope_prompt_id = sp.prompt_id
        WHERE COALESCE(pc.funnel_stage, sp.funnel_stage) IN (${inList(f.funnelStage)})
      )`,
    );
  }
  // lang/websiteCountry — 정본은 promptAxisPreds. 종전에는 이 상세 경로가 두 축을
  // 무시해, website 드릴다운 API 가 region→websiteCountry 로 치환해 넘기는 순간
  // 지오 필터가 통째로 사라졌다 (2026-08-25 GGMD 버그: 멘션 필터를 걸어도 프롬프트
  // 목록은 전체). lang 표면 판정은 answerWhere/snapshotRunFilter 와 동일.
  conds.push(
    ...promptAxisPreds(f, sql`a.prompt_id`, hasProjectCtx(projectCtx) ? "project" : "standard"),
  );
  // 카탈로그 축(브랜드·brandPresence·유형·depth)은 catalogPromptPreds 가 정본이다
  // — 위에서 이미 받아 왔다(2026-09-02 추출). 여기서 다시 쌓으면 이중 술어가 된다.
  if (catalogPreds.length) {
    conds.push(
      sql`a.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE ${sql.join(catalogPreds, sql` AND `)} AND scope_prompt_id IS NOT NULL)`,
    );
  }
  // 프로젝트 커스텀 태그 — answerWhere 와 동일 술어(같은 태그 안 OR, 태그 간 AND).
  // 종전에는 이 상세 경로에서 미적용이라 프로젝트 인용/언급 화면의 Tag Filter 가
  // 조용히 무시됐다 (2026-08-06 고객 피드백: Tag Filter 미작동).
  if (f.customFieldFilters) {
    for (const [fieldId, values] of Object.entries(f.customFieldFilters)) {
      if (!values.length) continue;
      const valList = sql.join(values.map((v) => sql`${v}`), sql`, `);
      conds.push(sql`a.prompt_id IN (
        SELECT p.scope_prompt_id FROM prompts p
        JOIN prompt_custom_field_values v ON v.prompt_id = p.id
        WHERE v.field_id = ${fieldId}::uuid AND v.value IN (${valList})
          AND p.scope_prompt_id IS NOT NULL
      )`);
    }
  }
  return sql.join(conds, sql` AND `);
}

// 자사 판정 — 종전 JS 규칙의 SQL 트윈: url 이 있으면 base-url prefix 매칭
// (citationBaseNormSql/ownedBasePrefixClause 가 JS 와 동일 정규화·predicate —
// verify:url-match 가 SQL↔JS 일치 강제), url 이 없으면 도메인 서픽스 폴백.
// 2026-08-05 축E 통일: 베이스 목록은 콜사이트가 전달(표준/웹사이트 = 축E 스코프,
// 프로젝트 = 프로젝트 사슬). 폴백 도메인 집합도 같은 목록에서 파생 — 전사 상수
// 를 쓰면 좁힌 베이스가 도메인 폴백에서 다시 넓어진다. 빈 목록 → 판정 false
// (owned 0 — 프로젝트 brand/country 미설정 등, KPI ⑤ 와 동일한 무판정 상태).
// `targetOwned` — website 타겟 집합 일치 = 자사(websiteTargetOwnedClause). `base` 는
// 후보 도메인 행만 정규화되는데(citationOwnedBaseSql) 타겟은 전부 선언 base 의
// registrable domain 아래(2026-09-06 실측: 호스트가 다른 타겟 8건 전부 그 서브도메인)라
// 후보 밖 행에서 타겟 판정이 빠지는 일은 없다.
export function citationOwnedClause(
  ownedBasePrefixes: string[],
  ownedSiblingUniverse?: string[],
  targetOwned?: { projectCtx: string | string[] | undefined; filters: StandardFilters; enabled: boolean },
): SQL {
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(ownedBasePrefixes));
  if (!pattern) return sql`false`;
  const prefix = ownedBasePrefixClause(sql`base`, ownedBasePrefixes, ownedSiblingUniverse);
  const byUrl = targetOwned
    ? websiteTargetOwnedClause(prefix, sql`base`, "base", targetOwned.projectCtx, targetOwned.filters, targetOwned.enabled)
    : prefix;
  return sql`(${byUrl} OR (NULLIF(base, '') IS NULL AND domain ~* ${sql`${pattern}`}))`;
}

// c2 CTE 의 base 컬럼 — URL 정규화(regex 6회)를 owned "후보" 도메인 행에만 수행.
// 2026-07-22 프리뷰 실측: website 창(93 프로젝트, 인용 15.9만 행)에서 전 행
// 정규화 + 218-prefix 매칭이 Q1 4.8s·Q5 5.1s 의 지배 비용(pg_stat_statements).
// 판정 동일성 근거: base-prefix 매칭이 성립하려면 정규화된 URL 이 owned base 의
// 호스트로 시작해야 하고, 그 URL 의 registrable domain(= 미러 c.domain, sync 가
// url 에서 계산) 은 반드시 GEO_OWNED_DOMAINS 에 속한다 — 후보 밖 행은 어차피
// 매칭 불가라 base 를 NULL 로 둬도 owned 판정이 바뀌지 않는다(정규식 폴백의
// `domain ~* OWNED` 도 같은 도메인 집합). 후보 행만 정규화하므로 비용은
// owned-후보 비율에 비례한다.
export function citationOwnedBaseSql(ownedBasePrefixes: string[]): SQL {
  // 후보 도메인 = 전달된 베이스에서 파생 (citationOwnedClause 와 동일 집합) —
  // 판정 동일성 논거는 위와 같되, 집합이 카탈로그 상수가 아니라 콜사이트 스코프.
  const domains = ownedFallbackDomains(ownedBasePrefixes);
  if (domains.length === 0) return sql`NULL::text`;
  const list = sql.join(domains.map((d) => sql`${d}`), sql`, `);
  // lower(): 미러 domain 은 sync 가 소문자로 계산하지만, 종전 폴백(~* 대소문자
  // 무시)과 동일한 관용도를 유지한다. 파생 도메인은 전부 소문자.
  return sql`CASE WHEN lower(c.domain) IN (${list}) THEN ${citationNormExpr("base", sql`c.url`, sql`c.url_base_norm`)} END`;
}

/**
 * 위 함수의 **tracked NORM 짝**(유닛 판정 전용). 리포트 정본의 타겟 항이 tracked NORM 으로
 * 비교하므로(`websiteUnitOwnedTargetClause`) 그 입력을 같은 후보 게이트 아래에서 낸다.
 *
 * 같은 `CASE` 게이트를 쓰는 이유도 같다: 후보 도메인 밖 행은 base 항도 타겟 항도 맞을 수
 * 없다(타겟은 전부 선언 base 의 registrable 도메인 아래 — 2026-09-06 실측). 그래서 정규화
 * 비용이 후보 비율에만 비례한다.
 */
function citationOwnedTrackedSql(ownedBasePrefixes: string[]): SQL {
  const domains = ownedFallbackDomains(ownedBasePrefixes);
  if (domains.length === 0) return sql`NULL::text`;
  const list = sql.join(domains.map((d) => sql`${d}`), sql`, `);
  return sql`CASE WHEN lower(c.domain) IN (${list}) THEN ${citationNormExpr("tracked", sql`c.url`, sql`c.url_norm`)} END`;
}

// SQL 롤업 행 형태 — foldCitationsLive(순수 변환, 테스트 대상)의 입력.
export interface CitDomainGroupRow {
  domain: string; // lower(registrable domain)
  category: string | null; // scope 분류 (현재 미러 전량 null → 로컬 분류)
  target: string;
  citations: number;
  owned: boolean;
  // 행 단위 owned 매칭 카운트 (KPI ⑤ 분자와 동일한 FILTER 규칙) — 공식(당사)
  // 인용 비중 타일의 분자. 그룹 bool(owned)과 달리 도메인 안의 비매칭 URL
  // (owned base 밖 서브도메인/경로)은 세지 않는다.
  owned_citations: number;
}
export interface CitDomainStatRow {
  domain: string;
  citing_answers: number;
  prompts: number;
}
export interface CitUrlRow {
  domain: string;
  url: string;
  title: string | null;
  prompt_text: string | null;
  cites: number;
  targets: string[];
}
export interface CitPromptRow {
  domain: string;
  prompt_id: string;
  text: string | null;
  funnel: string | null;
  cites: number;
  // cites 중 owned base 에 맞은 행 수 (KPI ⑤ 분자와 같은 행 단위 규칙). 뷰의
  // 자사/미인용 프롬프트 분할이 도메인 단위 isOurs 가 아니라 이 값으로 갈린다.
  owned_cites: number;
  targets: string[];
}
export interface CitPromptRefRow {
  domain: string;
  prompt_id: string;
  job_id: string;
  target: string;
  region: string | null;
  cites: number;
}
export interface CitSplitPromptRow {
  prompt_id: string;
  text: string | null;
  funnel: string | null;
  cites: number;
  targets: string[];
  owned: boolean;
  bucket_total: number; // 같은 owned 버킷의 전체 프롬프트 수 (창 내 정확값)
}
export interface CitSplitRefRow {
  prompt_id: string;
  job_id: string;
  target: string;
  region: string | null;
  cites: number;
}

// 프롬프트 답변 ref — 종전 JS 경로(aggregateCitationsFrom 의 pa.answers)와 동일
// 형태: position/highlights/measuredAt 은 인용 경로에서 항상 비어 있었다.
function citationAnswerRef(r: {
  job_id: string;
  target: string;
  region: string | null;
  cites: number;
}): MentionAnswerLive {
  return {
    jobId: r.job_id,
    provider: providerLabel(r.target),
    region: r.region ?? null,
    mentionCount: num(r.cites), // 이 답변 안의 해당 도메인(또는 프롬프트) 인용 수
    position: null,
    highlights: { brand: [], model: [] },
    measuredAt: null,
    runs: 1,
  };
}

// 순수 변환: SQL 롤업 행 → CitationsLive (trend 는 호출부가 채움 — 종전과 동일).
// 판정 대응 관계 (aggregateCitationsFrom 기준):
//  - cat = resolveCitationCategory(c.category, domain, overrides) → 운영자 교정이
//    최우선, 없으면 행 단위 category, 그것도 null 이면
//    도메인 로컬 분류. sourceCategory 필터도 같은 지점(행 단위)에서 적용.
//  - 도메인 대표 category = 인용수 최다 그룹의 cat (미러는 도메인당 분류가
//    단일이라 종전 "첫 행" 규칙과 동치; scope 분류는 도메인 단위 분류기).
//  - coverageRate 분모 = 창 내 필터 통과 답변 수 (sampledAnswers).
//  - summary.uniqueDomains = 필터 통과 인용이 1건 이상인 도메인 수 (전량 계산 —
//    domains 배열 상한과 무관하게 정확).
/** 도메인 단위 롤업 한 줄 — 인용수·자사 여부·대표 카테고리. */
export interface CitationDomainAgg {
  citations: number;
  isOurs: boolean;
  /** 대표 카테고리 = 인용수 최다 그룹의 분류(동률 시 먼저 집계된 것). */
  category: string | null;
}

/**
 * SQL 롤업 행 → 도메인 단위 집계. `foldCitationsLive`(화면 행·배지)와 미러
 * 집계의 드릴다운 대상 선정이 **같은 함수**를 보게 하려고 따로 뺐다 — 도메인의
 * 대표 카테고리를 두 곳에서 각자 계산하면 "배지는 공식 (HMG) 인데 드릴다운은
 * 비어 있다" 는 어긋남이 조용히 생긴다(2026-09-16 고객 QA 대응).
 *
 * `sourceCats` 는 행 단위 분류 필터로, 두 호출부가 같은 지점에서 적용한다.
 */
export function citationDomainRollup(
  groups: CitDomainGroupRow[],
  overrides: CitationOverrideMap | undefined,
  sourceCats: ReadonlySet<string> | null,
): Map<string, CitationDomainAgg> {
  interface Acc {
    citations: number;
    isOurs: boolean;
    catCounts: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  for (const g of groups) {
    const cat = resolveCitationCategory(g.category, g.domain, overrides);
    if (sourceCats && !sourceCats.has(cat)) continue;
    let d = acc.get(g.domain);
    if (!d) {
      d = { citations: 0, isOurs: false, catCounts: new Map() };
      acc.set(g.domain, d);
    }
    d.citations += num(g.citations);
    if (g.owned === true) d.isOurs = true;
    d.catCounts.set(cat, (d.catCounts.get(cat) ?? 0) + num(g.citations));
  }
  const out = new Map<string, CitationDomainAgg>();
  for (const [dom, d] of acc) {
    let category: string | null = null;
    let catMax = -1;
    for (const [c, n] of d.catCounts) {
      if (n > catMax) {
        catMax = n;
        category = c;
      }
    }
    out.set(dom, { citations: d.citations, isOurs: d.isOurs, category });
  }
  return out;
}

/** 드릴다운 fetch 대상 선정 결과. */
export interface CitationDrilldownSelection {
  /** SQL IN 리스트 — 상위 N + 공식 꼬리 (이 순서). */
  domains: string[];
  /** 상위 N 안 — urls + promptList 를 싣는다. */
  top: string[];
  /** 상위 N 밖 공식(HMG) — URL 샘플만 싣는다. */
  officialTail: string[];
  /** 공식이지만 상한(officialMax) 초과로 드릴다운을 못 실은 도메인. */
  officialOmitted: string[];
}

/**
 * 인용 드릴다운을 가져올 도메인 선정 — **순수 함수**.
 *
 * `상위 top개 ∪ (상위 밖 공식(HMG) 최대 officialMax개)`. 공식 합집합이 곧
 * 2026-09-16 고객(GGMD) 요구("인용 수와 상관 없이 공식 도메인이면 샘플 URL도
 * 제공")의 집행 지점이라, 인라인으로 두지 않고 따로 뺐다 — 이 술어가 조용히
 * 무력화되면(예: officialMax=0) 고객 요구가 그대로 사라지는데 SQL 안에 섞여
 * 있으면 테스트가 닿지 않는다.
 *
 * `ranked` 는 인용수 desc · 도메인 asc 로 이미 정렬된 도메인 롤업이다.
 * 수치(citations·share·prompts·coverage)는 이 선정과 무관하게 groups/stats
 * 전량에서 나오므로 어떤 값을 넘겨도 영향이 없다.
 */
export function selectCitationDrilldownDomains(
  ranked: ReadonlyArray<readonly [string, CitationDomainAgg]>,
  top: number,
  officialMax: number,
): CitationDrilldownSelection {
  const topDomains = ranked.slice(0, top).map(([d]) => d);
  const inTop = new Set(topDomains);
  const tail = ranked
    .filter(([d, a]) => a.category === OFFICIAL_HMG_CATEGORY && !inTop.has(d))
    .map(([d]) => d);
  const officialTail = tail.slice(0, officialMax);
  return {
    domains: [...topDomains, ...officialTail],
    top: topDomains,
    officialTail,
    officialOmitted: tail.slice(officialMax),
  };
}

export function foldCitationsLive(input: {
  sampledAnswers: number;
  groups: CitDomainGroupRow[];
  stats: CitDomainStatRow[];
  urls: CitUrlRow[];
  promptRows: CitPromptRow[];
  promptRefs: CitPromptRefRow[];
  split: { rows: CitSplitPromptRow[]; refs: CitSplitRefRow[] } | null;
  filters: StandardFilters;
  // 운영자 인용 카테고리 오버라이드. 생략 = 오버라이드 도입 이전과 동일 분류
  // (회귀 기준). live 경로(aggregateCitationsFrom)와 같은 맵을 받아 패리티가
  // 파라미터로 보장된다.
  overrides?: CitationOverrideMap;
  // 공식(HMG)이지만 드릴다운 상한 초과로 **일부러 안 가져온** 도메인.
  // 이 행에는 `drilldownOmitted: true` 가 붙어 화면이 "URL이 아직 없습니다"
  // 대신 종전 "미제공" 문구를 쓴다 (selectCitationDrilldownDomains 의 결과).
  drilldownOmitted?: readonly string[];
}): CitationsLive {
  const pctOf = (n: number, d: number): number =>
    d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
  const sourceCats = input.filters.sourceCategory?.length
    ? new Set(input.filters.sourceCategory)
    : null;

  // 도메인 행(수치·자사 여부·대표 카테고리)은 공용 롤업이 만든다 — 미러 집계의
  // 드릴다운 대상 선정과 같은 함수를 봐야 배지와 드릴다운이 어긋나지 않는다.
  const domainMap = citationDomainRollup(input.groups, input.overrides, sourceCats);
  const categoryTotals = new Map<string, number>();
  const engineCats = new Map<string, Map<string, number>>();
  let totalCitations = 0;
  // 공식(당사) 인용 비중 분자 — 행 단위 owned 매칭 합 (KPI ⑤ 분자와 동일 규칙).
  // groups 는 top-N 캡 이전 전량이라 슬리밍과 무관하게 정확하다. sourceCategory
  // 필터는 분모(totalCitations)와 같은 지점에서 적용 — 타일이 항상 화면의 다른
  // 수치와 같은 모집단을 말한다.
  let ownedCitations = 0;
  for (const g of input.groups) {
    const cat = resolveCitationCategory(g.category, g.domain, input.overrides);
    if (sourceCats && !sourceCats.has(cat)) continue;
    totalCitations += num(g.citations);
    ownedCitations += num(g.owned_citations);
    categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + num(g.citations));
    const eng = providerLabel(g.target);
    const em = engineCats.get(eng) ?? new Map<string, number>();
    em.set(cat, (em.get(cat) ?? 0) + num(g.citations));
    engineCats.set(eng, em);
  }

  const statBy = new Map(input.stats.map((s) => [s.domain, s]));
  const urlsBy = new Map<string, CitUrlRow[]>();
  for (const u of input.urls) {
    const list = urlsBy.get(u.domain) ?? [];
    list.push(u);
    urlsBy.set(u.domain, list);
  }
  const promptsBy = new Map<string, CitPromptRow[]>();
  for (const p of input.promptRows) {
    const list = promptsBy.get(p.domain) ?? [];
    list.push(p);
    promptsBy.set(p.domain, list);
  }
  const refsBy = new Map<string, MentionAnswerLive[]>();
  for (const r of input.promptRefs) {
    const key = `${r.domain}|${r.prompt_id}`;
    const list = refsBy.get(key) ?? [];
    list.push(citationAnswerRef(r));
    refsBy.set(key, list);
  }

  const omittedSet = new Set(input.drilldownOmitted ?? []);
  const domains: CitationDomainLive[] = [...domainMap.entries()]
    .map(([dom, d]) => {
      const stat = statBy.get(dom);
      // 대표 카테고리: 인용수 최다 (동률 시 먼저 집계된 것 — 도메인당 단일 분류라
      // 실질적으로 유일). citationDomainRollup 이 계산해 둔 값.
      const category = d.category;
      return {
        ...(omittedSet.has(dom) ? { drilldownOmitted: true as const } : {}),
        domain: dom,
        citations: d.citations,
        share: pctOf(d.citations, totalCitations),
        prompts: num(stat?.prompts),
        coverageRate: pctOf(num(stat?.citing_answers), input.sampledAnswers),
        isOurs: d.isOurs,
        category,
        subcategory: null, // 미러에 subcategory 없음 — 종전 경로도 항상 null
        urls: (urlsBy.get(dom) ?? [])
          .map((u) => ({
            url: u.url,
            title: u.title || displayCitationUrl(u.url),
            count: num(u.cites),
            aiProvider: (u.targets ?? []).map(providerLabel).join(", "),
            promptText: u.prompt_text ?? "",
            country: geoEntryForUrl(u.url)?.country ?? null,
          }))
          .sort((a, b) => b.count - a.count),
        promptList: (promptsBy.get(dom) ?? [])
          .map((p) => ({
            id: p.prompt_id,
            promptText: p.text ?? "",
            funnelStage: p.funnel ?? null,
            citations: num(p.cites),
            ownedCitations: num(p.owned_cites),
            providers: (p.targets ?? []).map(providerLabel),
            answers: refsBy.get(`${dom}|${p.prompt_id}`) ?? [],
          }))
          .sort((a, b) => b.citations - a.citations),
      };
    })
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));

  const categories: CitationCategorySlice[] | null =
    totalCitations > 0
      ? [...categoryTotals.entries()]
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value)
      : null;

  // 프롬프트 단위 자사 인용 분할 — 카운트는 SQL 전량 집계값(정확), 리스트는
  // 상위 일부. 종전 클라이언트 판정과 동일하게 "자사 인용 프롬프트가 0이면
  // 섹션 숨김(null)". split 자체가 없으면(undefined) 뷰가 종전 방식으로 계산.
  let promptSplit: CitationsPromptSplit | null | undefined;
  if (input.split) {
    const splitRefsBy = new Map<string, MentionAnswerLive[]>();
    for (const r of input.split.refs) {
      const list = splitRefsBy.get(r.prompt_id) ?? [];
      list.push(citationAnswerRef(r));
      splitRefsBy.set(r.prompt_id, list);
    }
    const toPrompt = (r: CitSplitPromptRow): CitationPromptLive => ({
      id: r.prompt_id,
      promptText: r.text ?? "",
      funnelStage: r.funnel ?? null,
      citations: num(r.cites),
      providers: (r.targets ?? []).map(providerLabel),
      answers: splitRefsBy.get(r.prompt_id) ?? [],
    });
    const ownedRows = input.split.rows.filter((r) => r.owned === true);
    const uncitedRows = input.split.rows.filter((r) => r.owned !== true);
    const ownedCount = num(ownedRows[0]?.bucket_total);
    const uncitedCount = num(uncitedRows[0]?.bucket_total);
    promptSplit =
      ownedCount === 0
        ? null
        : {
            owned: ownedRows.map(toPrompt),
            uncited: uncitedRows.map(toPrompt),
            ownedCount,
            uncitedCount,
          };
  }

  return {
    summary: {
      total: totalCitations,
      uniqueDomains: domainMap.size,
      // 분모 0 → null ("—") — 0% (인용은 있으나 당사 0) 과 구분.
      officialOwnShare:
        totalCitations > 0
          ? Math.round((ownedCitations / totalCitations) * 1000) / 10
          : null,
    },
    asOf: null, // aggregateCitationsFromMirror가 fold 뒤 base.asOf로 채움
    domains,
    categories,
    trend: null, // 호출부가 슬림 추이 리더로 채움 (종전과 동일)
    categoryTrend: null,
    engineCategories: engineCategorySlices(engineCats),
    ...(promptSplit !== undefined ? { promptSplit } : {}),
  };
}

export async function aggregateCitationsFromMirror(
  filters: StandardFilters = {},
  scopeProjectId: string | string[] | undefined,
  // 공식(당사) 판정 베이스 — 콜사이트 명시 필수 (aggregateStandardFromMirror 참조).
  // owned 배지·promptSplit·officialOwnShare 타일이 전부 이 목록 하나로 판정된다.
  ownedBasePrefixes: string[],
  // 형제 모집단 — websiteDeclaredOwnedBases 주석 참조.
  ownedSiblingUniverse?: string[],
  // website 전용 — 타겟 URL 집합에 일치하는 인용을 자사로 판정(websiteTargetOwnedClause).
  websiteTargetsOwned = false,
  // 실행 예산(E-2). 생략하면 종전 동작 — 문장 상한도 마감도 없다.
  // 이 집계는 문장 10개를 `Promise.all` 로 병렬 발행하므로 `withAnswerSet` 이 아니라
  // `budgetedMirrorDb`(문장마다 자기 트랜잭션 + SET LOCAL)로 상한을 건다.
  budget?: AnswerSetBudget,
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  // 이 하나로 owned 배지·promptSplit·officialOwnShare·프롬프트 드릴다운의 `owned_cites`
  // 가 **함께** 움직인다 — 한 화면에 두 정의가 섞이지 않게 하는 것이 이 키의 목적이다.
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<CitationsLive | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const db = budgetedMirrorDb(getDb(), budget);
  // 오버라이드는 이 async 진입점에서 한 번 로드해 아래 세 분류 지점(top-N 선정 ·
  // fold · 추이)에 같은 맵으로 흘린다 — 한 응답 안에서 분류가 갈리지 않게.
  // 이 함수 자체가 unstable_cache(MIRROR_AGGREGATE_TAG) 안에서 돌므로 맵을 인자로
  // 받지 않는다(Map 은 캐시 키로 직렬화되지 않는다 — 콤보 간 오염). 저장 액션이
  // 두 태그를 함께 revalidate 하는 것이 무효화 경로다.
  const overrides = await loadCitationOverrides();
  const W = detailAnswerWhere(filters, scopeProjectId, { hiddenFamily: "citations" });
  // base = owned-후보 도메인 행만 정규화 (citationOwnedBaseSql — 전 행 regex 가
  // website 창에서 쿼리당 ~5s 를 만들던 지배 비용).
  // 유닛 판정(키 on)에서는 후보 도메인 집합에 **유닛 base** 도 넣는다 — 근거는
  // `ownedCandidateBases` 머리 주석(후보 밖 행은 base 가 NULL 이라 판정이 통째로 빠진다).
  const ownedBase = citationOwnedBaseSql(ownedCandidateBases(ownedBasePrefixes, units));
  const owned = citationOwnedClause(ownedBasePrefixes, ownedSiblingUniverse, {
    projectCtx: scopeProjectId, filters, enabled: websiteTargetsOwned,
  });
  // 유닛 판정은 인용 **행**에서 한다(같은 url 도 인용한 프롬프트에 따라 갈린다). 판정에
  // 쓰는 유닛 컬럼은 각 CTE 가 `wup` 에서 받아 실어 두고, 여기서는 그 별칭만 받는다.
  //
  // ⚠️ 유닛 경로에는 도메인 서픽스 폴백(`base IS NULL AND domain ~* OWNED`)이 없다.
  //    그 폴백은 "자사 도메인이면 유닛과 무관하게 자사" 라 flat 의 정의 그 자체이고,
  //    리포트 정본(`scripts/summary/surface-website.ts::unitOwnedSql`)에도 없다. 대상은
  //    url 이 비어 base 를 못 만드는 인용 행뿐이다(미러 실측 0건).
  const ownedAt = (alias: string): SQL =>
    units
      ? sql`COALESCE(${websiteUnitOwnedTargetClause(
          sql.raw(`${alias}.base`), sql.raw(`${alias}.cnorm`), alias,
        )}, false)`
      : owned;
  const unitCtes = units ? sql`${websiteUnitPromptCtes(units)},
      ` : sql``;
  /**
   * `wup` 유닛 컬럼 + **tracked NORM** 을 CTE 투영에 싣는 조각(판정이 그 별칭에서 읽는다).
   * `cnorm` 은 base 와 **같은 후보 게이트** 아래에서 계산되므로 정규화 행수가 안 는다.
   */
  const ownedTracked = citationOwnedTrackedSql(ownedCandidateBases(ownedBasePrefixes, units));
  const unitCols = units
    ? sql`, ${ownedTracked} AS cnorm, wup.unit_base, wup.unit_sibs, wup.unit_home_host, wup.unit_turls`
    : sql``;
  // 인용 롤업의 그룹 키. 종전 `lower(c.domain)` 을 대체하되 **공식 HMG 소셜
  // 계정 행만** `도메인+계정경로` 로 넓어지고 나머지는 글자 그대로 동일하다
  // (lib/db/repositories/citation-group-key.ts — JS 쌍둥이는 citationGroupKey).
  //
  // ⚠️ owned(자사) 판정에는 이 키를 쓰지 않는다. `citationOwnedBaseSql` /
  // `citationOwnedClause` 는 raw registrable domain 위에서 base-URL prefix 를
  // 매칭하는 KPI ⑤ 의 분자 규칙이고, 그 입력을 host+path 로 바꾸면 owned 판정
  // 자체가 흔들린다. 이번 변경은 **분류(category)** 만 건드린다.
  const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
  // sourceCategory 활성 시 promptSplit 은 계산하지 않는다(undefined) — 분류가
  // JS 파생(categorizeDomain)이라 SQL 만으로 도메인 필터를 재현할 수 없고, 뷰가
  // 종전 방식(도메인 promptList 스캔)으로 폴백한다.
  const wantSplit = !filters.sourceCategory?.length;

  // 1차: 합계 롤업 (도메인×분류×엔진), 도메인 단위 distinct 카운트, 분모,
  //      프롬프트 분할, 전체 이력 추이 — 서로 독립이라 병렬.
  const [ansRows, groupRows, statRows, splitRows, trendRows] = await Promise.all([
    db.execute(
      // 측정 기준일(asOf) — **회차(cycle) 기준**이다. 종전 `max(a.measured_at)` 은
      // 회차의 꼬리 측정 시각을 집어, 앵커 8/31 회차가 9/1 15:30 까지 이어지면
      // 화면에 "2026-09-01" 이 떴다(2026-09-05 실측, 루트 be28fe15). 측정 이월은
      // 상시 현상이라(8/1 이후 measured_at ≠ cycle_anchor_at 인 답변 59,527건)
      // 예외 처리가 아니라 기준 자체를 회차로 옮긴다.
      // COALESCE 폴백: scope 의 measurements API 가 `cycle_anchor_at` 을 아직
      // 노출하지 않아 미러 컬럼(0058)이 NULL 인 동안은 종전과 동일하게 동작하고,
      // scope 가 필드를 싣기 시작하면 코드 변경 없이 회차 기준으로 전환된다.
      // 앵커 축(옵트인)에서는 `max(ca.round_date)` 다 — 축 라우터 `cycleAsOfSql()` 머리 주석.
      sql`SELECT count(*)::int AS answers,
                 ${
                   anchorAxisKnownEnabled()
                     ? cycleAsOfDisplaySql() // `to_char(max(ca.round_date), 'YYYY-MM-DD')`
                     : sql`${cycleAsOfSql()}::text`
                 } AS last_measured_at
            FROM scope_answers a LEFT JOIN scope_runs r ON r.run_id = a.run_id${
              anchorAxisKnownEnabled() ? anchorJoinSql(sql.raw("a.job_id")) : sql``
            }
           WHERE ${W}`,
    ) as unknown as Promise<Array<{ answers: number; last_measured_at: string | null }>>,
    db.execute(sql`
      WITH ${unitCtes}c2 AS MATERIALIZED (
        SELECT ${groupKey} AS domain, c.category, a.target, ${ownedBase} AS base${unitCols}
        FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id${
          units ? websiteUnitPromptJoin(sql`a.prompt_id`) : sql``}
        WHERE ${W} AND c.domain IS NOT NULL
      )
      SELECT domain, category, target,
        count(*)::int AS citations,
        -- COALESCE: 비후보 도메인 그룹은 base 가 전행 NULL → bool_or 가 NULL.
        COALESCE(bool_or(${ownedAt("c2")}), false) AS owned,
        -- 행 단위 owned 카운트 (KPI ⑤ 분자 규칙) — 공식(당사) 타일의 분자.
        count(*) FILTER (WHERE ${ownedAt("c2")})::int AS owned_citations
      FROM c2 GROUP BY domain, category, target
    `) as unknown as Promise<CitDomainGroupRow[]>,
    db.execute(sql`
      SELECT ${groupKey} AS domain,
        count(DISTINCT c.job_id)::int AS citing_answers,
        count(DISTINCT a.prompt_id)::int AS prompts
      FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id
      WHERE ${W} AND c.domain IS NOT NULL
      GROUP BY 1
    `) as unknown as Promise<CitDomainStatRow[]>,
    wantSplit
      ? (db.execute(sql`
          WITH ${unitCtes}c2 AS MATERIALIZED (
            SELECT a.prompt_id, a.job_id, a.target, ${groupKey} AS domain, ${ownedBase} AS base${unitCols}
            FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id${
              units ? websiteUnitPromptJoin(sql`a.prompt_id`) : sql``}
            WHERE ${W} AND c.domain IS NOT NULL AND a.prompt_id IS NOT NULL
          ), pr AS (
            -- 자사 판정은 **인용 행 단위**다(2026-09-08). 도메인 단위로 접으면
            -- genesis.com 처럼 국가 경로로 갈리는 공유 호스트에서 타국·글로벌
            -- 페이지만 인용한 프롬프트가 자사로 승격된다.
            SELECT c2.prompt_id, count(*)::int AS cites,
              array_agg(DISTINCT c2.target) AS targets,
              COALESCE(bool_or(${ownedAt("c2")}), false) AS owned,
              min(sp.text) AS text, min(sp.funnel_stage) AS funnel
            FROM c2
            LEFT JOIN scope_prompts sp ON sp.prompt_id = c2.prompt_id
            GROUP BY c2.prompt_id
          )
          SELECT prompt_id, text, funnel, cites, targets, owned, bucket_total::int AS bucket_total FROM (
            SELECT pr.*,
              row_number() OVER (PARTITION BY owned ORDER BY cites DESC, prompt_id) AS rk,
              count(*) OVER (PARTITION BY owned) AS bucket_total
            FROM pr
          ) t WHERE rk <= ${CITATION_SPLIT_PROMPTS}
        `) as unknown as Promise<CitSplitPromptRow[]>)
      : Promise.resolve(null),
    // `true` = 주 격자에 얹히는 산출물(통합 B1).
    readCitationDomainDayCounts(filters, true, scopeProjectId),
  ]);

  const groups = groupRows as CitDomainGroupRow[];
  if (groups.length === 0) {
    // 창 내 인용 0건 — 미러(프로젝트)에 인용이 아예 없으면 EmptyState(null),
    // 있으면 빈 형태(필터 패널 유지). 종전 null/empty 판정과 동치.
    return (await mirrorHasCitations(scopeProjectId)) ? { ...EMPTY_CITATIONS } : null;
  }

  // 상위 도메인(필터 반영 후 인용수 기준) + **공식(HMG) 도메인 전량**만 드릴다운
  // 행을 가져온다. 공식 도메인은 인용 수가 적어도 샘플 URL을 봐야 한다는 고객
  // 요구(2026-09-16 GGMD QA)라 순위 술어에 합집합으로 얹는다. 판정은 화면
  // 카테고리 배지와 같은 롤업(citationDomainRollup)의 대표 카테고리다.
  const sourceCats = filters.sourceCategory?.length ? new Set(filters.sourceCategory) : null;
  const domAggs = citationDomainRollup(groups, overrides, sourceCats);
  const ranked = [...domAggs.entries()].sort(
    (a, b) => b[1].citations - a[1].citations || a[0].localeCompare(b[0]),
  );
  // 선정은 순수 함수가 한다(테스트 대상) — 수치는 이 선정과 무관하다.
  const pick = selectCitationDrilldownDomains(
    ranked,
    CITATION_DRILLDOWN_DOMAINS,
    CITATION_OFFICIAL_DRILLDOWN_MAX,
  );
  const drilldownDomains = pick.domains;

  let urls: CitUrlRow[] = [];
  let promptRows: CitPromptRow[] = [];
  let promptRefs: CitPromptRefRow[] = [];
  let splitRefs: CitSplitRefRow[] = [];
  if (drilldownDomains.length > 0 || (splitRows?.length ?? 0) > 0) {
    const topList = sql.join(drilldownDomains.map((d) => sql`${d}`), sql`, `);
    // 상위 N 밖 공식(HMG) 꼬리 — URL 샘플만, 최대 CITATION_OFFICIAL_TAIL_URLS 개.
    // 프롬프트 드릴다운(pl/prompts/refs/prefs)은 상위 N 으로만 제한한다.
    const tailSet = pick.officialTail;
    const urlCapSql = tailSet.length === 0
      ? sql`${CITATION_URLS_PER_DOMAIN}::int`
      // THEN/ELSE 의 바인드 파라미터는 타입 없이 나가면 PG 가 text 로 추론해
      // `rk <= CASE … END` 가 `bigint <= text` 로 실패한다(42883, 2026-09-16 프리뷰
      // 실증 — 인용 화면 전체가 "데이터를 불러오지 못했습니다"). 명시 캐스트 필수.
      : sql`CASE WHEN domain IN (${sql.join(tailSet.map((d) => sql`${d}`), sql`, `)})
                 THEN ${CITATION_OFFICIAL_TAIL_URLS}::int ELSE ${CITATION_URLS_PER_DOMAIN}::int END`;
    // pick.top 은 ranked 가 비지 않는 한 항상 1개 이상이다(groups.length>0 보장).
    const promptDomainSql = sql.join(pick.top.map((d) => sql`${d}`), sql`, `);
    const splitIds = (splitRows ?? []).map((r) => r.prompt_id);
    // 2차: 드릴다운 행 (상위 도메인 한정 — 행 수가 캡으로 bound).
    // 종전에는 urls/promptRows/promptRefs 를 각각 별도 쿼리로 병렬 발사했는데,
    // 셋(정확히는 promptRefs 안의 pl+refs 까지 4벌)이 **완전히 같은 베이스 스캔**
    // (citations⋈answers WHERE W AND lower(domain) IN topList)을 반복했다.
    // DB 가 2 vCPU 라 이 중복이 곱해져 동시 콜드 로드에서 타임아웃을 만들었다
    // (2026-08-26 실측: 장기 쿼리가 전부 wait_event_type=null = CPU 실행 중).
    // → 베이스를 cbase 한 벌로 고정하고 세 결과셋을 json_agg 로 한 번에 받는다.
    //   판정 불변: W·topList·정렬 키·캡이 전부 종전과 동일하고, scope_prompts 는
    //   prompt_id PK 조인이라 카디널리티가 늘지 않는다.
    const drill = drilldownDomains.length === 0
      ? Promise.resolve([] as Array<{ urls: unknown; prompt_rows: unknown; prompt_refs: unknown }>)
      : (db.execute(sql`
          WITH ${unitCtes}cbase AS MATERIALIZED (
            SELECT ${groupKey} AS domain, COALESCE(c.url, '') AS url,
              c.title AS title, c.id AS cid, ${ownedBase} AS base,
              a.prompt_id, a.job_id, a.target, a.region, a.measured_at${unitCols}
            FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id${
              units ? websiteUnitPromptJoin(sql`a.prompt_id`) : sql``}
            WHERE ${W} AND c.domain IS NOT NULL AND ${groupKey} IN (${topList})
          ), u AS (
            SELECT b.domain, b.url,
              count(*)::int AS cites,
              array_agg(DISTINCT b.target) AS targets,
              (array_agg(b.title ORDER BY b.measured_at ASC NULLS LAST, b.cid ASC))[1] AS title,
              (array_agg(sp.text ORDER BY b.measured_at ASC NULLS LAST, b.cid ASC))[1] AS prompt_text
            FROM cbase b LEFT JOIN scope_prompts sp ON sp.prompt_id = b.prompt_id
            GROUP BY 1, 2
          ), urls AS (
            SELECT domain, url, title, prompt_text, cites, targets FROM (
              SELECT u.*, row_number() OVER (PARTITION BY domain ORDER BY cites DESC, url) AS rk
              FROM u
            ) t WHERE rk <= ${urlCapSql}
          ), pl AS (
            SELECT b.domain, b.prompt_id, count(*)::int AS cites,
              count(*) FILTER (WHERE ${ownedAt("b")})::int AS owned_cites,
              array_agg(DISTINCT b.target) AS targets
            FROM cbase b
            WHERE b.prompt_id IS NOT NULL AND b.domain IN (${promptDomainSql})
            GROUP BY 1, 2
          ), plr AS (
            SELECT pl.*, row_number() OVER (PARTITION BY domain ORDER BY cites DESC, prompt_id) AS rk
            FROM pl
          ), keep AS (
            SELECT domain, prompt_id FROM plr WHERE rk <= ${CITATION_PROMPTS_PER_DOMAIN}
          ), prompts AS (
            SELECT r.domain, r.prompt_id, r.cites, r.owned_cites, r.targets, sp.text, sp.funnel_stage AS funnel
            FROM plr r LEFT JOIN scope_prompts sp ON sp.prompt_id = r.prompt_id
            WHERE r.rk <= ${CITATION_PROMPTS_PER_DOMAIN}
          ), refs AS (
            SELECT b.domain, b.prompt_id, b.job_id, b.target, b.region, count(*)::int AS cites
            FROM cbase b
            WHERE b.prompt_id IS NOT NULL AND b.domain IN (${promptDomainSql})
            GROUP BY 1, 2, 3, 4, 5
          ), prefs AS (
            SELECT domain, prompt_id, job_id, target, region, cites FROM (
              SELECT refs.*, row_number() OVER (PARTITION BY refs.domain, refs.prompt_id ORDER BY refs.cites DESC, refs.job_id) AS rk
              FROM refs JOIN keep ON keep.domain = refs.domain AND keep.prompt_id = refs.prompt_id
            ) t WHERE rk <= ${CITATION_REFS_PER_PROMPT}
          )
          SELECT
            COALESCE((SELECT json_agg(urls) FROM urls), '[]'::json) AS urls,
            COALESCE((SELECT json_agg(prompts) FROM prompts), '[]'::json) AS prompt_rows,
            COALESCE((SELECT json_agg(prefs) FROM prefs), '[]'::json) AS prompt_refs
        `) as unknown as Promise<Array<{ urls: unknown; prompt_rows: unknown; prompt_refs: unknown }>>);

    const [drillRow, splitRefRows] = await Promise.all([
      drill,
      splitIds.length === 0
        ? Promise.resolve([])
        : db.execute(sql`
            SELECT prompt_id, job_id, target, region, cites FROM (
              SELECT a.prompt_id, a.job_id, a.target, a.region, count(*)::int AS cites,
                row_number() OVER (PARTITION BY a.prompt_id ORDER BY count(*) DESC, a.job_id) AS rk
              FROM scope_citations c JOIN scope_answers a ON a.job_id = c.job_id
              WHERE ${W} AND c.domain IS NOT NULL
                AND a.prompt_id IN (${sql.join(splitIds.map((id) => sql`${id}`), sql`, `)})
              GROUP BY a.prompt_id, a.job_id, a.target, a.region
            ) t WHERE rk <= ${CITATION_SPLIT_REFS}
          `),
    ]);
    const d = (drillRow as Array<{ urls: unknown; prompt_rows: unknown; prompt_refs: unknown }>)[0];
    urls = (d?.urls ?? []) as CitUrlRow[];
    promptRows = (d?.prompt_rows ?? []) as CitPromptRow[];
    promptRefs = (d?.prompt_refs ?? []) as CitPromptRefRow[];
    splitRefs = splitRefRows as unknown as CitSplitRefRow[];
  }

  const base = foldCitationsLive({
    sampledAnswers: num((ansRows as Array<{ answers: number }>)[0]?.answers),
    groups,
    stats: statRows as CitDomainStatRow[],
    urls,
    promptRows,
    promptRefs,
    split: wantSplit ? { rows: (splitRows ?? []) as CitSplitPromptRow[], refs: splitRefs } : null,
    filters,
    overrides,
    drilldownOmitted: pick.officialOmitted,
  });
  // 측정 기준일 = 스냅샷 창 답변의 최신 measured_at (ansRows 1차 쿼리에서).
  base.asOf =
    (ansRows as Array<{ last_measured_at: string | null }>)[0]?.last_measured_at ?? null;

  // 추이 교체: 수치·드릴다운·파이는 스냅샷 배치, 두 추이는 기간 내 전체 이력.
  // sourceCategory 축은 분류가 JS 파생이라 여기서 적용 (수치 경로와 동일 규칙).
  const domainEntries: { date: string; key: string; count: number }[] = [];
  const categoryEntries: { date: string; key: string; count: number }[] = [];
  for (const r of trendRows) {
    const cat = categorizeDomain(r.key, overrides);
    if (filters.sourceCategory?.length && !filters.sourceCategory.includes(cat)) continue;
    domainEntries.push({ date: r.day, key: r.key, count: r.n });
    categoryEntries.push({ date: r.day, key: cat, count: r.n });
  }
  // 시리즈 = 창 내 어느 주차든 top-10 에 든 도메인의 합집합(누적 상위 15 캡) —
  // 스냅샷 top-10 만 쓰면 최근 진입/과거 상위 도메인이 라인에서 빠진다(2026-07-30).
  base.trend = buildWeeklyTrend(domainEntries, weeklyTopNUnion(domainEntries, 10, 15));
  base.categoryTrend = buildWeeklyTrend(categoryEntries, (base.categories ?? []).map((c) => c.name));
  // 캐시 바이트 상한 — 요약·분류·엔진 구성·promptSplit 카운트는 그대로,
  // 도메인 행 수와 드릴다운 리스트만 top-N 캡.
  return slimCitationsLiveForCache(base);
}

// 출처(도메인)별 인용 구성비 — 대시보드 도넛 전용 SLIM 롤업. 전체 CitationsLive는
// 도메인마다 URL·프롬프트 드릴다운을 안고 있어 캐시 한도(2MB)를 넘겼다(#20MB).
// 대시보드는 도메인 단위 {citations, share, isOurs}만 쓰므로 SQL GROUP BY 한 번으로
// 좁혀 캐시 가능한 크기로 만든다. answerWhere 로 다른 표준 읽기와 필터 일관성 유지.
export interface SourceDomainSlice {
  domain: string;
  citations: number;
  share: number; // % of total citations
  isOurs: boolean;
}

export async function aggregateSourceCompositionFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  // 당사(isOurs) 배지 판정 베이스 — 콜사이트 명시 필수. 도넛은 도메인 단위라
  // 베이스의 registrable 도메인 서픽스 매칭으로 판정한다(경로 수준 좁히기는
  // 도메인 그룹핑에서 표현 불가 — 종전 글로벌 패턴과 동일한 granularity).
  ownedBasePrefixes: string[],
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  //
  // 켜지면 판정 **입도**가 함께 바뀐다: 종전 도넛의 `isOurs` 는 registrable 도메인 서픽스
  // 매칭(경로를 안 본다)이라 ⑤ 카드보다도 느슨했다 — 같은 화면에서 ⑤ 는 유닛인데 도넛은
  // 호스트 전체가 자사가 되면 "자사 인용 42% 인데 도넛의 자사 도메인이 전부 파랗다" 가 된다.
  // 유닛 경로에서는 ⑤ 와 같은 base prefix + 형제 제외 + 루트 홈 + 타겟 ⊂ 자사 로 판정하고,
  // 도메인 행은 그 행 단위 판정의 `bool_or` 다(코어 ⑤ 의 `is_ours` 와 같은 접기).
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<SourceDomainSlice[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  const db = getDb();
  // ⚠️ **계열은 지면 단위다**(D1). 이 도넛도 Overview·website·프로젝트 전용이라
  // 그 지면의 계열 `'all'` 을 쓴다. 종전 `'citations'` 과 **SQL 이 문자 단위로 같다**
  // (`anchorNotHiddenSql` 진리표가 이진이라 `'all'`·`'citations'` 가 같은 식이다) —
  // 값은 안 바뀌고, 지면 안에서 계열 이름이 하나로 모여 공유 답변셋이 1키가 된다.
  const W = await snapshotAnswerWhere(filters, projectCtx, "all");
  const answerIds = sql`(SELECT a.job_id FROM scope_answers a WHERE ${W})`;
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(ownedBasePrefixes));
  const isOurs = pattern ? sql`bool_or(c.domain ~* ${sql`${pattern}`})` : sql`false`;
  // 유닛 경로 — 판정 입력(base 정규화)을 **owned 후보 도메인 행에만** 만들고(비용은 후보
  // 비율에 비례) 그 위에서 행 단위로 판정한 뒤 도메인으로 접는다. `snap`/`cb` 를 굳히는
  // 이유는 인용 계열 다른 문장과 같다(정규화 식이 조인 조건으로 끌려 올라가는 것 차단).
  const unitRows = !units
    ? null
    : ((await db.execute(sql`
    WITH ${websiteUnitPromptCtes(units)},
    snap AS MATERIALIZED (SELECT a.job_id, a.prompt_id FROM scope_answers a WHERE ${W}),
    cb AS MATERIALIZED (
      SELECT c.domain AS domain,
        ${citationOwnedBaseSql(ownedCandidateBases(ownedBasePrefixes, units))} AS base,
        ${citationOwnedTrackedSql(ownedCandidateBases(ownedBasePrefixes, units))} AS cnorm,
        wup.unit_base, wup.unit_sibs, wup.unit_home_host, wup.unit_turls
      FROM scope_citations c JOIN snap ON snap.job_id = c.job_id${
        websiteUnitPromptJoin(sql`snap.prompt_id`)}
      WHERE c.domain IS NOT NULL
    )
    SELECT domain,
      count(*)::int AS citations,
      COALESCE(bool_or(${websiteUnitOwnedTargetClause(sql`cb.base`, sql`cb.cnorm`, "cb")}), false) AS is_ours
    FROM cb GROUP BY domain ORDER BY citations DESC
  `)) as unknown as Array<{ domain: string; citations: number; is_ours: boolean }>);
  const rows = unitRows ?? ((await db.execute(sql`
    SELECT c.domain AS domain,
      count(*)::int AS citations,
      ${isOurs} AS is_ours
    FROM scope_citations c
    WHERE c.domain IS NOT NULL AND c.job_id IN ${answerIds}
    GROUP BY c.domain ORDER BY citations DESC
  `)) as unknown as Array<{ domain: string; citations: number; is_ours: boolean }>);
  const total = rows.reduce((s, r) => s + num(r.citations), 0);
  return rows.map((r) => ({
    domain: r.domain,
    citations: num(r.citations),
    share: total > 0 ? round1((100 * num(r.citations)) / total) : 0,
    isOurs: r.is_ours === true,
  }));
}

// ── GEO 경쟁 위치 — per-market (ISO region) brand share-of-voice ───────────
// Feeds the dashboard GEO snapshot's competitive view: for each market we need
// every brand's mention total so the view-model can compute HMG's share + rank
// vs competitors (and which HMG brand leads the market). One GROUP BY over the
// joined mirror; the same answerWhere(filters) as the other standard reads, so
// engine/funnel/region narrowing is consistent. is_tracked marks HMG brands.
export interface GeoBrandMention {
  code: string; // ISO region (scope_answers.region)
  brand: string;
  mentions: number;
  isTracked: boolean;
  /**
   * 명부 제외 엔티티(entity_registry role='excluded') 표식: 집계가 아니라 게이트웨이가
   * **캐시 밖에서** 단다(`lib/scope/excluded-brands.ts::markExcludedGeo`). 행을 빼지 않는
   * 이유: 시장 SOV 분모가 이 행들의 합이다. 소비자는 최대 경쟁사·순위 모수에서만 건너뛴다.
   */
  excluded?: boolean;
}

export async function aggregateGeoCompetitionFromMirror(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
  // 실행 예산(2026-09-10) — 카드 계열과 같은 경계에 있다.
  budget?: AnswerSetBudget,
): Promise<GeoBrandMention[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  // ⚠️ **계열은 지면 단위다**(D1, 2026-09-20 결정). 이 리더는 Overview·website·
  // 프로젝트 지면에서만 쓰이고(대시보드/웹사이트 `_data/live.ts`), 그 세 지면의 카드는
  // 7 KPI 묶음이라 `'all'` 이다. 기본값(`'mentions'`)에 기대면 **같은 화면에서 기준
  // 회차가 갈린다**: N2 수리로 `max(ca2.round_date)` 게이트가 바깥 계열을 따라가므로,
  // 느슨한 계열은 인용만 숨긴 회차를 최신으로 잡고 엄격한 계열은 그 앞 회차를 잡는다.
  // 그러면 달력에 없는 날짜를 이 위젯만 그린다(통합 검증 D1).
  const W = await snapshotAnswerWhere(filters, projectCtx, "all");
  // 2026-08-28 정합 수정(#113): 이 랭킹만 알리아스 접기가 빠져 있었다 — names 조인·
  // GROUP BY·is_tracked 가 전부 raw rollup id 였고 표시명 병합(canonBrandNameSql)
  // 도 없어서, 같은 브랜드가 '제네시스'/'Genesis'·'폭스바겐'/'Volkswagen' 처럼
  // 두 행으로 갈라지고 언급 탭 랭킹과 순위가 어긋났다. 언급 탭·코어 KPI 와
  // 동일한 접기 규칙(canonRollupSql + canonBrandNameSql)으로 통일한다.
  //
  // 2026-08-29 성능: 위 산식은 그대로 두고 **답변셋 배관만** 바꾼다. 종전에는
  // `scope_mentions ⋈ scope_answers WHERE ${W}` 를 한 문장에 인라인해 full-cycle
  // 게이트·카탈로그 semi-join 을 mention 조인과 함께 플래닝시켰다 — 표준 집계
  // 3곳이 이미 받은 처방(#104)과 같은 형태로 통일한다. 컬럼 집합은
  // aggregateStandardFromMirror 와 동일한 `a.job_id, a.region`.
  // 모수 안전: scope_answers.job_id 는 PK(unique)라 _answer_set 도 job 당 1행 —
  // 조인 배수가 종전과 같아 sum(mention_count) 이 부풀지 않는다.
  //
  // ── 성능: OFFSET 0 배리어 + names 쪽 사전 계산 (이식 2026-09-02) ─────────────
  // 형태·근거는 추이 ②(aggregateStandardTrendFromMirror) 주석이 정본이다.
  // 이 문장이 **미적용 콜사이트 중 최대 비용**이었다 — 프로덕션 pg_stat_statements
  // 에서 원형 `WITH names AS ( WITH RECURSIVE …` 로 mean 19.8s 를 찍던 정체가 이것.
  // 프로덕션 A/B (ANALYZE · 무필터 스냅샷 창 · TEMP TABLE 경로 · 중앙값,
  // 산출 동치 md5 673327201239962a8660d07bb0cb7620 · 5,558행 · EXCEPT ALL 0/0):
  //   종전 20,209 ms → 1,331 ms (**15.2배**).
  // `bool_or(trackedRollupPredicate)` 는 배리어에서 한 번 계산한 `x.rid` 로 옮긴다
  // (술어 정의상 `canonRollupSql(m) IN trackedRollupIn` 과 같은 식이다).
  return withAnswerSet(sql`a.job_id, a.region`, W, async (db) => {
    const rows = (await db.execute(sql`
      WITH names AS ${ROLLUP_NAMES_BARE}
      SELECT x.code AS code, ${rollupDisplayName("x")} AS brand,
        sum(x.mention_count)::int AS mentions,
        bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_tracked
      FROM (
        SELECT a.region AS code, m.mention_count AS mention_count, m.brand AS brand,
          ${canonRollupSql(filters)} AS rid
        FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
        WHERE m.brand_rollup_entity_id IS NOT NULL AND a.region IS NOT NULL
        OFFSET 0
      ) x
      LEFT JOIN names n ON n.entity_id = x.rid
      WHERE COALESCE(n.brand, x.brand) IS NOT NULL
        AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
      GROUP BY 1, 2
    `)) as unknown as Array<{
      code: string;
      brand: string;
      mentions: number;
      is_tracked: boolean;
    }>;
    return rows.map((r) => ({
      code: r.code,
      brand: r.brand,
      mentions: num(r.mentions),
      isTracked: r.is_tracked === true,
    }));
  }, budget ?? {});
}

// Per-brand citation domains for the mention drilldown's 인용출처 tab. Lazy —
// fetched only when a brand row's tab is opened, so the mention aggregate stays
// light (it would otherwise carry every brand's domains × prompts × answers).
// ── 감정·유형 신호 드릴다운 (2026-08-07, 고객 피드백: 어떤 프롬프트에서 어떤
// 긍정·부정 표현이 발생했는지 확인 불가) ────────────────────────────────────
// 감정 분포/Mention 유형 카드의 세그먼트를 클릭하면 그 신호가 실제로 발생한
// 프롬프트 목록을 연다. 키워드 자체는 scope 가 제공하지 않으므로(별도 요청
// 트랙), 신호가 붙은 프롬프트 → 답변 원문 모달 경로로 근거를 확인하게 한다.
//
// 판정 단위는 화면 카드와 동일: 당사(축E) 언급 행의 신호 컬럼 > 0.
export const SIGNAL_COLUMNS = {
  positive: "sentiment_positive",
  neutral: "sentiment_neutral",
  mixed: "sentiment_mixed",
  negative: "sentiment_negative",
  mention: "type_mention",
  recommendation: "type_recommendation",
  comparison: "type_comparison",
  definition: "type_definition",
  final_choice: "type_final_choice",
} as const;
export type SignalKey = keyof typeof SIGNAL_COLUMNS;
export const isSignalKey = (v: string): v is SignalKey => v in SIGNAL_COLUMNS;

const SIGNAL_PROMPTS_LIMIT = 50;
const SIGNAL_REFS_PER_PROMPT = 6;

export async function aggregateSignalPromptsFromMirror(
  signal: SignalKey,
  filters: StandardFilters = {},
  projectCtx?: string | string[],
): Promise<MentionsPromptLive[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return [];
  const db = getDb();
  // 상세(드릴다운) 경로라 detailAnswerWhere — 인용 프롬프트 분리와 동일한 창.
  const W = detailAnswerWhere(filters, projectCtx);
  const col = sql.raw(`m.${SIGNAL_COLUMNS[signal]}`);
  const rows = (await db.execute(sql`
    WITH sig AS (
      SELECT a.prompt_id, a.job_id, a.target, a.region,
             sum(${col})::int AS n
      FROM scope_mentions m JOIN scope_answers a ON a.job_id = m.job_id
      WHERE ${W} AND ${trackedRollupPredicate(filters)}
        AND ${col} > 0 AND a.prompt_id IS NOT NULL
      GROUP BY a.prompt_id, a.job_id, a.target, a.region
    ), pr AS (
      SELECT prompt_id, sum(n)::int AS total,
             row_number() OVER (ORDER BY sum(n) DESC, prompt_id) AS rk
      FROM sig GROUP BY prompt_id
    )
    SELECT pr.prompt_id, pr.total, sp.text, sp.funnel_stage,
           s.job_id, s.target, s.region, s.n
    FROM pr
    JOIN sig s ON s.prompt_id = pr.prompt_id
    LEFT JOIN scope_prompts sp ON sp.prompt_id = pr.prompt_id
    WHERE pr.rk <= ${SIGNAL_PROMPTS_LIMIT}
    ORDER BY pr.total DESC, pr.prompt_id, s.n DESC, s.job_id
  `)) as unknown as Array<{
    prompt_id: string; total: number; text: string | null; funnel_stage: string | null;
    job_id: string; target: string; region: string | null; n: number;
  }>;

  const byPrompt = new Map<string, MentionsPromptLive>();
  for (const r of rows) {
    let p = byPrompt.get(r.prompt_id);
    if (!p) {
      p = {
        id: r.prompt_id,
        promptText: r.text ?? r.prompt_id,
        mentions: num(r.total), // 이 프롬프트에서 발생한 해당 신호 수
        share: 0,
        funnelStage: r.funnel_stage ?? null,
        providers: [],
        answers: [],
      };
      byPrompt.set(r.prompt_id, p);
    }
    const provider = providerLabel(r.target);
    if (!p.providers.includes(provider)) p.providers.push(provider);
    if (p.answers.length < SIGNAL_REFS_PER_PROMPT) {
      p.answers.push({
        jobId: r.job_id,
        provider,
        region: r.region ?? null,
        mentionCount: num(r.n),
        position: null,
        highlights: { brand: [], model: [] },
        measuredAt: null,
        runs: 1,
      });
    }
  }
  const list = [...byPrompt.values()];
  const sum = list.reduce((s, p) => s + p.mentions, 0);
  for (const p of list) p.share = sum > 0 ? Math.round((1000 * p.mentions) / sum) / 10 : 0;
  return list;
}

/**
 * 답변 단위 브랜드 스탠스 분포 (0072 · 우호도 탭의 **답변 축** 카드).
 *
 * ⚠️ 발생 단위 감정 분포(`aggregateMentionsHeadlineSql` 의 `sig`)를 **대체하지 않는다.**
 * 두 축은 세는 단위가 다르다:
 *   · 발생 축 = 언급 발생마다 1 신호. 한 답변이 브랜드를 5번 언급하면 5.
 *   · 답변 축 = (답변 × 브랜드) 1행. 같은 답변·같은 브랜드면 언제나 1.
 * 그래서 두 숫자를 더하거나 한 차트에 섞지 않고, 화면이 축을 라벨로 말한다(스펙 R6).
 *
 * 당사 판정은 미러의 `is_tracked`(코어 판정)가 아니라 이 파일의 단일 정본
 * `trackedRollupPredicate` 를 쓴다 — 단위 컨텍스트(프로젝트 brand)·자사 명부·표기
 * 접두 교정이 전부 거기 있고, 우호도 히어로(Q3)와 같은 술어여야 두 지면이 안 갈린다.
 *
 * 반환 null = 스탠스 축이 이 배포에 없다(테이블 미적용) 또는 루트 미설정.
 * 행 0건은 null 이 아니라 `pairs: 0` 이다 — 화면이 "측정 대기"와 "0건"을 구분한다.
 */
export interface AnswerStanceDistribution {
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  /**
   * 4계열 합 = 이 회차의 (답변 × 브랜드) 쌍 수. WU8 AC3 의 SQL 대조 대상.
   *
   * ⚠️ **턴은 접는다.** 미러 행의 단위는 (답변 × 턴 × 브랜드)이고 2턴 답변(ACR
   * 후속 선택)이 라이브의 8.2% 다 — 그대로 세면 그 답변들이 두 번 계상되어
   * "답변 × 브랜드" 라는 이 지표의 정의가 깨진다(검증자 F2). 대표 턴 규칙은
   * **가장 낮은 turn_index**(= 본답변)다: ACR 2턴은 강제 선택 후속이라 답변 전체의
   * 태도를 대표하지 않고, 규칙이 결정적이어야 같은 필터가 같은 수를 낸다.
   */
  pairs: number;
}

export async function aggregateAnswerStanceDistributionFromMirror(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
  /**
   * 문장 상한 + 전체 벽시계 예산. 실효 최악 = budgetMs + statementTimeoutMs
   * (`aggregateTypeKpiFromMirror` 와 같은 모양). 없으면 문장 상한도 마감도 없어서
   * 느린 조합이 `kpiDegrade` 에 안 잡히고 우호도 탭 전체가 에러가 된다(검증자 F7).
   */
  opts: { statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<AnswerStanceDistribution | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return null;
  // 테이블이 없는 창(코드가 db:apply 보다 앞선 배포)에서는 **조용히 발생 축으로
  // 떨어지지 않는다** — null 을 내고 화면이 "스탠스 미수집"을 말한다.
  if (!(await answerStancesAvailable())) return null;
  // 우호도 히어로(Sub KPI Q3)와 **같은 답변셋**. 공유 스코프 안이면 요청단위로 이미
  // 확정된 job_id 목록을 그대로 탄다(추가 왕복 0).
  const W = await snapshotAnswerWhere(filters, projectCtx);
  const budget: AnswerSetBudget = {
    statementTimeoutMs: opts.statementTimeoutMs,
    deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
  };
  const rows = await budgetedReader(budget, "stanceDist", async (db) => (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE sx.stance = 'positive')::int AS positive,
      count(*) FILTER (WHERE sx.stance = 'neutral')::int  AS neutral,
      count(*) FILTER (WHERE sx.stance = 'mixed')::int    AS mixed,
      count(*) FILTER (WHERE sx.stance = 'negative')::int AS negative,
      count(*)::int AS pairs
    FROM (
      -- ① 턴 접기 — (답변 × 브랜드) 하나로. DISTINCT ON + ORDER BY turn_index 라
      --    **가장 낮은 턴이 대표**다(위 pairs 주석이 규칙의 정본).
      -- ② canonRollupSql 이 기대하는 컬럼명(brand_rollup_entity_id · brand)으로 투영해
      --    당사 판정 술어를 **문자 그대로 재사용**한다.
      SELECT DISTINCT ON (s.job_id, s.entity_id)
             s.stance,
             s.entity_id   AS brand_rollup_entity_id,
             s.brand_label AS brand
      FROM scope_answer_stances s
      JOIN scope_answers a ON a.job_id = s.job_id
      WHERE ${W}
      ORDER BY s.job_id, s.entity_id, s.turn_index
    ) sx
    WHERE ${trackedRollupPredicate(filters, "sx")}
      -- 어휘 밖 값은 **버린다**(중립으로 접지 않는다 — F3). 이 필터가 있어야
      -- "4계열 합 = pairs" 등식이 무조건 성립한다. 대표 턴의 값이 어휘 밖이면 그
      -- (답변, 브랜드)는 통째로 빠진다 — 조용한 오분류보다 결손이 낫다.
      AND sx.stance IN ('positive', 'negative', 'mixed', 'neutral')
  `)) as unknown as Array<Record<string, number>>);
  const r = rows[0] ?? {};
  return {
    positive: num(r.positive),
    neutral: num(r.neutral),
    mixed: num(r.mixed),
    negative: num(r.negative),
    pairs: num(r.pairs),
  };
}

export async function aggregateBrandCitationsFromMirror(
  brandName: string,
  filters: StandardFilters = {},
  scopeProjectId?: string | string[],
): Promise<CitationDomainLive[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  // 브랜드 판정(brandJobs)에 mentions 가 필요하므로 여기만 mentions 를 유지 —
  // 단 answers 메타는 한 번만 읽어 jobs/results 두 형태로 재사용한다(종전에는
  // readMirrorJobs + readMirrorResults 가 같은 스냅샷 answers 를 2회 로드).
  // 선축소 — 이 집계는 `brandName` 을 언급한 답변만 쓴다(아래 brandJobs). 창의 전
  // 브랜드 행을 끌어올 이유가 없다(brandMentionJobNarrow 머리 주석).
  const runFilter = snapshotRunFilter(scopeProjectId, filters, brandName, "citations");
  const [answerMeta, mentionsByJob, citationsByJob, promptMap, overrides, brandNames] =
    await Promise.all([
      readMirrorAnswerMeta(runFilter),
      readMirrorMentionsByJob(runFilter),
      readMirrorCitationsByJob(runFilter),
      readMirrorPromptMap(),
      // 인용 탭과 같은 오버라이드 — 드릴다운 분류가 부모 표와 어긋나지 않게.
      loadCitationOverrides(),
      // 전역 표기 맵 — 선축소의 **전제**다. `makeBrandResolver` 는 이 맵이 없으면
      // jobs 스캔으로 브랜드 표기를 시드하는데, 축소가 그 입력을 바꾸면 해석이
      // 달라질 수 있다. 언급 경로(`aggregateMentionsFrom`)는 이미 이 맵을 넘긴다.
      readBrandNameMap(),
    ]);
  const jobs = buildMirrorJobs(answerMeta, mentionsByJob);
  const results = buildMirrorResults(answerMeta, citationsByJob);
  // 리드가 이미 스냅샷 배치(기간 내 최신)로 좁혀져 별도 snapshotJobIds 불필요.
  // 캐시 바이트 상한 — 도메인 수치는 그대로, 리스트 길이만 캡.
  return slimBrandCitationDomainsForCache(
    aggregateBrandCitationsFrom(
      jobs,
      promptMap,
      results,
      brandName,
      stripDates(filters),
      { globalNames: brandNames },
      overrides,
    ),
  );
}

// 2026-06-11: DISTINCT ISO country codes the mirror has actually measured
// answers for. Drives the geography filter dropdown so users only see options
// that can return data — scope.countries narrows further (so a country-scoped
// account never sees a country they have no read access to).
//
// scope.brands is enforced through the prompts catalog join when set; that
// matches the same brand semantics used by answerWhere (prompts.brand IN ...).
// scope.regions is HMG editorial bucket (KR/US/EU/IN/LATAM), not ISO — we don't
// try to map it here; the catalog brand link is the meaningful narrowing.
export async function listMeasuredRegions(
  scope?: { all?: boolean; brands?: string[]; countries?: string[]; regions?: string[] },
  // website 표면 전용: 옵션 모집단을 이 프로젝트들의 답변으로 제한한다.
  // website 프롬프트는 표준 prompts 카탈로그 밖이라 아래 brands 카탈로그 조인이
  // 안 먹으므로, 브랜드 선택 반영은 project id 집합(브랜드별 website_sites)으로
  // 한다 — 데이터 읽기(withWebsite→answerWhere multi-project)와 동일한 축.
  // 부수 효과로 표준/타 프로젝트 측정 국가가 website 드롭다운에 새는 것도 막는다.
  projectIds?: string[],
  // 표준(글로벌) 표면 전용: 옵션을 루트 카탈로그(705 게이트)로 제한한다. 표준
  // 데이터(answerWhere)는 루트 프로젝트 답변만 읽는데, 옵션은 그 게이트가 없어
  // 전 프로젝트(website·타 프로젝트 포함)의 측정 국가를 나열했다 → 데이터엔 6개국
  // 뿐인데 필터엔 수십 개가 뜨는 불일치(2026-07-30). projectIds(website)와는
  // 배타적으로 쓴다.
  rootScoped?: boolean,
  // 2026-09-04: 표준 경로의 **측정 창**. 데이터 경로와 같은 규칙으로 좁혀
  // "옵션에 있으면 데이터가 있다"를 성립시킨다(optionWindowPredicate 주석 참조).
  // 미전달 시 기본 창(최근 7일). website(projectIds) 경로에는 걸지 않는다 —
  // 그쪽 읽기는 창이 아니라 셀당 최신이라 이력에 있으면 데이터가 있다.
  dateRange?: { dateFrom?: string; dateTo?: string },
): Promise<string[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const conds: SQL[] = [sql`region IS NOT NULL AND region <> 'UNKNOWN'`];
  if (projectIds?.length) {
    // 옵션 창 = 데이터 창 (2026-09-04 계약, 2026-09-06 프로젝트 경로에도 적용):
    // 종전에는 그 프로젝트가 **이력에 한 번이라도** 측정한 지역을 전부 냈다.
    // 스냅샷과 같은 셀 선택(perProjectLatestAnswerIds — 측정이 끊긴 셀 제외)에서
    // 뽑아야 "옵션엔 있는데 고르면 0건"이 안 생긴다(2026-09-06 실측: 웹사이트
    // 프로젝트에서 지역 9쌍·엔진 4쌍이 통째로 끊긴 상태였다).
    // 축 라우팅은 `snapshotAnswerIds` 한 곳에 있다 — 앵커 축이면 데이터 경로와
    // **같은 서브쿼리**(최신 회차 / 기간 회차들)를 쓴다. off 면 종전과 바이트 동일.
    conds.push(sql`job_id IN ${snapshotAnswerIds(projectIds, dateRange ?? {})}`);
  } else if (rootScoped) {
    // 데이터 경로(answerWhere)의 rootCatalogGate 와 동일 — 루트 카탈로그 프롬프트로
    // 측정된 답변만. 브랜드 조인(아래)과 함께 걸려 표준 필터 축과 정확히 일치한다.
    conds.push(rootCatalogGate(sql`prompt_id`));
    // 측정 창 — 이력에만 있고 이번 창엔 없는 시장(EG 등)을 옵션에서 뺀다.
    // 축 on 이면 데이터와 같은 회차 축으로(B3), off 면 종전 run 창 그대로.
    conds.push(
      optionAnchorJobClause(sql`job_id`, dateRange) ??
        sql`run_id IN (SELECT r.run_id FROM scope_runs r WHERE ${optionWindowPredicate(dateRange)})`,
    );
    // 숨김 지역은 옵션에서도 제외 — 데이터(answerWhere 루트 분기)와 동일 규칙.
    if (HIDDEN_STANDARD_REGIONS.length) {
      conds.push(
        sql`region NOT IN (${sql.join(HIDDEN_STANDARD_REGIONS.map((r) => sql`${r}`), sql`, `)})`,
      );
    }
  }
  if (scope && !scope.all) {
    // 허용 국가는 읽기 필터와 동일한 effectiveScopeCountries로 파생 — countries가
    // 없고 regions만 있는 region(RHQ) 계정도 권역 국가로 옵션이 좁혀진다. 이전엔
    // scope.countries만 봐서 region 계정에 전 권역이 드롭다운에 노출됐다(버그).
    const allowedCountries = effectiveScopeCountries(scope);
    if (allowedCountries?.length) {
      const inList = sql.join(allowedCountries.map((c) => sql`${c}`), sql`, `);
      conds.push(sql`region IN (${inList})`);
    }
    // projectIds가 오면 브랜드 좁히기는 이미 프로젝트 레벨에서 끝났고, website
    // 답변은 표준 카탈로그 밖이라 이 조인을 적용하면 전부 0건이 된다 — 스킵.
    if (scope.brands?.length && !projectIds?.length) {
      // 2026-07-02: 집계 락(readStandardFilters)과 동일하게 HMG 엄브렐러(공통
      // 프롬프트)를 포함 — 공통 프롬프트로만 측정된 국가도 드롭다운에 나오도록.
      const inList = sql.join(
        [...scope.brands, UMBRELLA_BRAND].map((b) => sql`${b}`),
        sql`, `,
      );
      conds.push(
        sql`prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE brand IN (${inList}) AND scope_prompt_id IS NOT NULL)`,
      );
    }
  }
  const rows = (await db.execute(sql`
    SELECT DISTINCT region FROM scope_answers
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY region
  `)) as unknown as Array<{ region: string }>;
  return rows.map((r) => r.region);
}

// 옵션 조회의 국가 좁히기 정본 — 허용 국가(effectiveScopeCountries) ∩ 적용된 국가
// 선택. 교집합이 비면 허용 국가로 폴백한다(클라이언트가 스코프를 넓히지 못한다 —
// readStandardFilters 의 geography 규칙과 같은 방향). 표준·ACR 언어 옵션이 같은
// 규칙을 쓰도록 한 곳에 둔다.
function optionCountryScope(
  scope?: { all?: boolean; brands?: string[]; countries?: string[]; regions?: string[] },
  countryFilter?: string[],
): string[] | undefined {
  const allowed = scope && !scope.all ? effectiveScopeCountries(scope) : undefined;
  const picked = countryFilter?.filter(Boolean);
  if (allowed?.length) {
    const allowSet = new Set(allowed);
    const intersected = picked?.filter((c) => allowSet.has(c)) ?? [];
    return intersected.length ? intersected : allowed;
  }
  return picked?.length ? picked : undefined;
}

// 표준(글로벌) 표면이 **실제로 측정한** 프롬프트 언어 목록 — 표준 language 필터의
// 옵션 소스 (2026-09-03). listMeasuredRegions 의 언어판이며, 좁히는 규칙을 그것과
// 의도적으로 똑같이 맞췄다: 루트 카탈로그 게이트 + 숨김 지역 제외 + 스코프 허용 국가
// (effectiveScopeCountries) + 브랜드 카탈로그 조인(엄브렐러 HMG 포함).
//
// 왜 필요한가 — 종전 표준 대시보드의 language 드롭다운은 정적 폴백
// `DIMENSIONS.language = ["en","ko","fr"]` 였다. 스코프·국가와 무관해서 KR 국가
// 계정에 프랑스어가 떴고(고객 제보 2026-09-03), 고르면 답변이 0건이 됐다.
// 옵션과 술어(promptAxisPreds→langAxisPred)가 같은 컬럼(scope_prompts.lang)에서
// 나와야 "옵션에 있으면 데이터가 있다"가 성립한다 — listMeasuredRegions 주석과 같은 논리.
//
// 반환은 **소문자 BCP-47**(케이싱 규약 — langAxisPred 머리 주석). 저장값은 대문자다.
// 모집단은 답변(scope_answers)이지 카탈로그가 아니다: 카탈로그에만 있고 측정된 적 없는
// 언어는 죽은 필터라 내지 않는다. 형태는 프롬프트 주도 semi-join — 답변 주도 조인 대비
// 프로덕션 실측 226ms → 92ms(admin 무필터, 29개 언어. 2026-09-03 EXPLAIN ANALYZE).
//
// ⚠️ 기간(스냅샷 창)은 걸지 않는다 — listMeasuredRegions 와 동일한 현상 유지다.
// 따라서 "이력에는 있으나 이번 주기에는 안 돈" 언어가 옵션에 남을 수 있다(국가 축이
// 이미 갖고 있는 같은 성질). 창을 걸려면 두 함수를 함께 바꿔야 한다.
// 표준(글로벌) 표면 필터 옵션의 **의존 매트릭스** — (브랜드 × 국가 × 언어) 조합
// (2026-09-04 고객 검수: "권역을 고르면 화면마다 국가·언어가 다르다").
//
// 왜 목록이 아니라 매트릭스인가 — 종전에는 국가·언어 옵션을 서버가 **적용된 필터**
// 로 좁혀 내려줬다. 그런데 상위 축(브랜드·국가)의 선택은 패널의 **클라이언트
// draft** 다. 두 축이 서로 다른 시점을 보므로 "고르는 중"과 "적용 후"가 어긋난다:
//   · 브랜드를 Hyundai 로 고르고 곧장 권역 중동을 누르면 국가가 AE·IL·SA(=브랜드
//     미적용 시점 옵션)로 채워진다. 적용하면 AE·SA 로 줄어든다 — 실측: 측정 국가가
//     Hyundai 중동 AE·SA / Kia 중동 AE·IL 로 브랜드마다 다르다.
//   · 국가를 태국만 적용해 둔 상태에서 권역 APAC 을 눌러 8개국을 draft 에 채우면,
//     언어 드롭다운은 여전히 태국 기준(en·th)만 보여준다 — 실측으로 화면과 일치.
// 옵션을 서버에서 미리 좁히는 한 이 어긋남은 구조적이다. 그래서 **좁히기를 하지
// 않은 조합표**를 한 번 내려주고, 패널이 draft 로 좁힌다. 그러면 정의상 적용 전후가
// 같다.
//
// 크기: 프로덕션 실측 138행(브랜드 3 × 측정국 45 × 언어 29 의 실제 조합만).
// 스코프 게이트·루트 카탈로그 게이트·숨김 지역 제외는 형제 함수들과 동일하게 건다 —
// 좁히지 않는 것은 **사용자 선택(브랜드·국가)** 뿐이고 권한은 그대로 적용된다.
//
// brand 가 null 인 행 = 공통(브랜드 무관) 프롬프트. 어느 브랜드를 골라도 남아야 하므로
// 클라이언트 필터가 null 을 통과시킨다(UMBRELLA_BRAND 도 같은 취급 — 여기서 null 로
// 정규화해 내려보내 클라이언트가 규칙 하나만 알면 되게 한다).
// lang 이 null 인 행 = 언어 태그 없는 프롬프트. 국가 옵션에는 기여하고 언어 옵션에는
// 기여하지 않는다(죽은 옵션 방지).
export interface MeasuredScopeCombo {
  brand: string | null;
  region: string;
  lang: string | null;
}

export async function listMeasuredScopeMatrix(
  scope?: { all?: boolean; brands?: string[]; countries?: string[]; regions?: string[] },
  // 측정 창 (2026-09-04) — 데이터 경로와 같은 규칙. 이력에만 있고 이번 창엔 없는
  // 시장·언어는 옵션에서 뺀다(고르면 빈 화면이 되는 죽은 옵션 방지).
  dateRange?: { dateFrom?: string; dateTo?: string },
): Promise<MeasuredScopeCombo[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const inList = (vals: readonly string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const conds: SQL[] = [
    sql`a.status = 'completed'`,
    sql`a.region IS NOT NULL AND a.region <> 'UNKNOWN'`,
    sql`p.project_id = ${STANDARD_ROOT_PROJECT_ID}`,
    // 옵션 창 = 데이터 창 (B3) — 축 on 이면 회차, off 면 종전 run 창.
    optionAnchorJobClause(sql.raw("a.job_id"), dateRange) ??
      sql`${optionWindowPredicate(dateRange)}`,
  ];
  if (HIDDEN_STANDARD_REGIONS.length) {
    conds.push(sql`a.region NOT IN (${inList(HIDDEN_STANDARD_REGIONS)})`);
  }
  if (scope && !scope.all) {
    const allowed = effectiveScopeCountries(scope);
    if (allowed?.length) conds.push(sql`a.region IN (${inList(allowed)})`);
    if (scope.brands?.length) {
      conds.push(sql`p.brand IN (${inList([...scope.brands, UMBRELLA_BRAND])})`);
    }
  }
  const rows = (await db.execute(sql`
    SELECT DISTINCT
      CASE WHEN p.brand = ${UMBRELLA_BRAND} THEN NULL ELSE p.brand END AS brand,
      a.region,
      lower(NULLIF(sp.lang, '')) AS lang
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    JOIN prompts p ON p.scope_prompt_id = a.prompt_id
    LEFT JOIN scope_prompts sp ON sp.prompt_id = a.prompt_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY 2, 3, 1
  `)) as unknown as Array<{ brand: string | null; region: string; lang: string | null }>;
  return rows;
}

export async function listMeasuredStandardLanguages(
  scope?: { all?: boolean; brands?: string[]; countries?: string[]; regions?: string[] },
  // 적용된 국가 선택(readStandardFilters.region — URL ?geography ∩ 스코프, 없으면
  // 스코프 전체). 넘기면 그 국가로 옵션이 더 좁혀진다(캐스케이드). 이 값은 이미
  // 스코프 안으로 교정된 뒤라 권한을 넓히는 방향으로는 갈 수 없다.
  countryFilter?: string[],
  // 측정 창 (2026-09-04) — 데이터 경로와 같은 규칙. 이 목록은 language 축의
  // **노출 여부**를 정하므로, 창 밖 언어만 남은 스코프에서 죽은 축이 뜨지 않게 한다.
  dateRange?: { dateFrom?: string; dateTo?: string },
): Promise<string[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  // 답변 쪽 술어(EXISTS 안) — 지역 관련.
  const answerConds: SQL[] = [
    sql`a.prompt_id = sp.prompt_id`,
    sql`a.status = 'completed'`,
    // 옵션 창 = 데이터 창 (B3).
    optionAnchorJobClause(sql.raw("a.job_id"), dateRange) ??
      sql`a.run_id IN (SELECT r.run_id FROM scope_runs r WHERE ${optionWindowPredicate(dateRange)})`,
    sql`a.region IS NOT NULL AND a.region <> 'UNKNOWN'`,
  ];
  if (HIDDEN_STANDARD_REGIONS.length) {
    answerConds.push(sql`a.region NOT IN (${inList([...HIDDEN_STANDARD_REGIONS])})`);
  }
  const countries = optionCountryScope(scope, countryFilter);
  if (countries?.length) answerConds.push(sql`a.region IN (${inList(countries)})`);
  // 카탈로그 쪽 술어 — 루트 게이트 + 브랜드. answerWhere 와 동일하게 하나의
  // prompts semi-join 으로 병합한다(플래너 교훈, 2026-07-22).
  const catalogPreds: SQL[] = [sql`project_id = ${STANDARD_ROOT_PROJECT_ID}`];
  if (scope && !scope.all && scope.brands?.length) {
    // 2026-07-02 락과 동일하게 HMG 엄브렐러(공통 프롬프트) 포함.
    catalogPreds.push(sql`brand IN (${inList([...scope.brands, UMBRELLA_BRAND])})`);
  }
  const rows = (await db.execute(sql`
    SELECT DISTINCT lower(sp.lang) AS lang
    FROM scope_prompts sp
    WHERE sp.lang IS NOT NULL AND sp.lang <> ''
      AND sp.prompt_id IN (
        SELECT scope_prompt_id FROM prompts
        WHERE ${sql.join(catalogPreds, sql` AND `)} AND scope_prompt_id IS NOT NULL
      )
      AND EXISTS (SELECT 1 FROM scope_answers a WHERE ${sql.join(answerConds, sql` AND `)})
    ORDER BY lang
  `)) as unknown as Array<{ lang: string }>;
  return rows.map((r) => r.lang);
}

// ACR(AI Agent Funnel) 화면이 **실제로 ACR 측정한** 프롬프트 언어 목록 (2026-09-03).
//
// 표준 언어 옵션(listMeasuredStandardLanguages)을 그대로 쓰지 않는 이유: ACR 화면의
// 데이터는 scope_answers 가 아니라 **scope_acr_rollups** 이고, 두 모집단이 다르다.
// 운영 DB 실측(2026-09-03): 표준 옵션 28종 vs ACR 롤업 보유 21종 — 그대로 쓰면 7개
// 언어가 "고르면 빈 화면"인 죽은 옵션이 된다. "옵션에 있으면 데이터가 있다" 불변식이
// 이 PR 전체의 요점이므로 ACR 은 자기 모집단에서 옵션을 낸다.
//
// 좁히는 규칙은 acrWhere 와 **1:1로 맞춘다** — 루트 프로젝트 런 스코프 + 카탈로그
// 브랜드(엄브렐러 포함) + 국가(x.region). acrWhere 에는 rootCatalogGate·숨김 지역이
// 없으므로 여기에도 넣지 않는다(옵션이 데이터보다 좁아지면 그것도 불일치다).
// 반환은 소문자 BCP-47 — 케이싱 규약은 langAxisPred 머리 주석.
export async function listMeasuredAcrLanguages(
  scope?: { all?: boolean; brands?: string[]; countries?: string[]; regions?: string[] },
  countryFilter?: string[],
  /**
   * 측정 창(검증 P3). 종전에는 이 인자가 없어 축 on 에서 옵션이 **항상 최신 회차
   * 하나**였다 — 기간을 건 화면의 데이터는 그 기간의 회차 전부라 1:1 이 깨진다.
   */
  dateRange?: { dateFrom?: string; dateTo?: string },
): Promise<string[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const rollupConds: SQL[] = [sql`x.prompt_id = sp.prompt_id`];
  const rootProjectId = addressableRootProjectId();
  if (rootProjectId) {
    rollupConds.push(
      sql`x.run_id IN (SELECT run_id FROM scope_runs WHERE project_id = ${rootProjectId})`,
    );
  }
  // 옵션 창 = 데이터 창 (B3). ACR 데이터 경로(`acrWhere`)가 축 on 에서 run 축
  // 앵커 절을 쓰므로 옵션도 같은 절을 쓴다 — 종전에는 창 자체가 없어 이력 전체였다.
  const acrAnchor = optionAnchorRunClause(sql.raw("x.run_id"), dateRange);
  if (acrAnchor) rollupConds.push(acrAnchor);
  const countries = optionCountryScope(scope, countryFilter);
  if (countries?.length) rollupConds.push(sql`x.region IN (${inList(countries)})`);
  const promptConds: SQL[] = [sql`sp.lang IS NOT NULL AND sp.lang <> ''`];
  if (scope && !scope.all && scope.brands?.length) {
    // acrWhere 의 catalogIn("brand", …) 과 동일 축 + 엄브렐러(공통 프롬프트).
    promptConds.push(
      sql`sp.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE brand IN (${inList([...scope.brands, UMBRELLA_BRAND])}) AND scope_prompt_id IS NOT NULL)`,
    );
  }
  const rows = (await db.execute(sql`
    SELECT DISTINCT lower(sp.lang) AS lang
    FROM scope_prompts sp
    WHERE ${sql.join(promptConds, sql` AND `)}
      AND EXISTS (SELECT 1 FROM scope_acr_rollups x WHERE ${sql.join(rollupConds, sql` AND `)})
    ORDER BY lang
  `)) as unknown as Array<{ lang: string }>;
  return rows.map((r) => r.lang);
}

// 프로젝트가 **해당 기간에 실제로 답변을 수집한** AI 엔진 목록 — 답변 분석의
// engine 필터 옵션 소스(project-ai-engine-selection). 정적 DIMENSIONS.engine
// (chatgpt/gemini) 대신 이걸 주입하면, 엔진 설정을 바꾼 프로젝트에서 "기간 내
// 수집이 없는 엔진"이 죽은 필터로 뜨지 않는다. 기간 술어는 스냅샷 읽기
// (perProjectLatestAnswerIds: 기간 상·하한 + 측정이 끊긴 셀 제외)와 동일 —
// 옵션에 있는 엔진은 반드시 데이터에 있고, 그 역도 성립한다.
export async function listMeasuredEngines(
  projectIds: string[],
  f: StandardFilters = {},
): Promise<string[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  if (projectIds.length === 0) return [];
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT DISTINCT a.target
    FROM scope_answers a
    WHERE a.target IS NOT NULL
      AND a.job_id IN ${snapshotAnswerIds(projectIds, f)}
    ORDER BY a.target
  `)) as unknown as Array<{ target: string }>;
  return rows.map((r) => r.target);
}

// Answer detail for the mention answer-modal — straight from the mirror (no
// scope round-trip; answer_text / citations / mentions are already synced).
// Beyond the body it carries the job's full citation list and the per-entity
// mention counts (Brand rows split 자사/경쟁 via tracked; non-Brand rows are the
// 연관 차량모델, tied to their brand through brand_rollup_entity_id).
export interface MirrorAnswerDetail {
  available: boolean;
  answerText?: string;
  measuredAt?: string | null;
  citations?: {
    url: string | null;
    domain: string | null;
    title: string | null;
    category: string | null;
  }[];
  brandMentions?: { name: string; count: number; tracked: boolean }[];
  modelMentions?: { name: string; count: number; brand: string | null }[];
  // 답변 원문 감성 밑줄(0061·scope#632). 발생 행이 없으면 키 자체가 없다 — 과거 회차·
  // 테이블 미적용 창에서 모달은 종전과 동일하게 그린다.
  sentiment?: { spans: SentimentSpan[]; skipped: number };
  // 답변 단위 브랜드 스탠스(0072). **발생 감성과 다른 축**이라 키를 따로 둔다 —
  // 없으면(과거 회차·코어 미배포·테이블 미적용) 키 자체가 없고, 모달은 스탠스 줄을
  // 아예 그리지 않는다. 발생 감성으로 대체하지 않는다(스펙 FR10).
  stances?: AnswerStanceView[];
}

/**
 * 스탠스 어휘 — 발생 단위 감성과 **같은 4값**(스펙 FR2). 읽기·쓰기가 같은 집합으로
 * 거르므로 어휘 밖 값은 어느 축에도 안 들어간다(중립 접힘 금지 — F3).
 */
const STANCE_VALUES = new Set(["positive", "negative", "mixed", "neutral"]);

/** 답변 모달의 브랜드 스탠스 태그 1개. */
export interface AnswerStanceView {
  /**
   * 답변 턴 인덱스. **뷰에 반드시 실린다** — 미러 PK 는 (job, turn, entity)인데
   * 뷰에서 턴을 떨어뜨리면 2턴 답변(ACR)에서 같은 브랜드가 두 번 나오면서
   * "브랜드가 중복된 배지"로 보이고 React key 도 충돌한다. 라이브 실측(2026-09-14
   * 검증자): 2턴 답변이 전체의 **8.2%**(52,698/642,521).
   */
  turnIndex: number;
  entityId: string;
  /** 표시명 — 멘션 사전(brandById)으로 해소 후 정본 표기로 정규화. 없으면 미러의 brand_label. */
  brand: string;
  tracked: boolean;
  stance: "positive" | "negative" | "mixed" | "neutral";
  confidence: number | null;
  evidenceText: string | null;
  /**
   * **미러 원문과 실제로 대조한 결과**(검증자 F5). 코어가 오프셋을 줬다는 사실이
   * 아니라 이 판정이 화면 문구를 결정한다:
   *   verified    — 원문에서 확인됨(원문 위치를 주장해도 되는 유일한 상태)
   *   mismatch    — 대조했는데 원문에 없다 = 코어 인용의 문제
   *   unavailable — 대조 자체 불가(그 턴의 원문이 미러에 없다 — turn>0)
   * 파일럿 실측: 완전일치 79.2% · 불일치 8.6%. 산식 정본은 `verifyStanceEvidence`.
   */
  evidenceMatch: StanceEvidenceMatch;
  reason: string | null;
}

export async function getMirrorAnswerBody(
  jobId: string,
  // 당사 배지의 단위 컨텍스트 (2026-07-03 결정: 모달도 단위 규칙 통일) —
  // contextBrand(프로젝트)/brand(계정 스코프)/ownEntities(명부)를 KPI 판정과
  // 동일하게 적용. 미전달 시 전체 자사 명부(그룹) 기준.
  f?: StandardFilters,
  // 프로젝트/웹사이트 표면의 접근 게이트 — 이 표면들의 프롬프트는 표준 카탈로그
  // (prompts.brand) 밖(brand NULL)이라 아래 brand 게이트가 전부 오차단했다
  // (2026-08-06 고객 피드백: AI 답변 화면 깨짐, 비admin 전 계정 영향). 콜사이트가
  // 접근 검증(assertProjectInScope / 스코프의 website project id 집합)을 마친
  // run project id 를 전달하면 brand 게이트 대신 run 소속으로 게이트한다.
  opts?: { runProjectIds?: string | string[] },
): Promise<MirrorAnswerDetail> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const bulkVisible = await bulkMirrorRunVisibleSql(sql`scope_answers.run_id`);
  // 2026-07-08 보안(IDOR 방어): 답변 본문은 jobId만으로 조회하면 스코프 밖(다른
  // 권역/브랜드) 답변도 열려버린다. 호출자 스코프(f.region=허용 국가, f.brand=허용
  // 브랜드)로 답변 자체를 게이트해, 스코프 밖 jobId는 존재 여부도 노출하지 않고
  // available:false로 처리한다(목록은 readStandardFilters로 이미 스코프됨 — 여기선
  // 크래프팅된 직접 요청 대비 심층 방어). f 미지정(admin/무제한)이면 게이트 없음.
  const answerScope: SQL[] = [eq(scopeAnswers.jobId, jobId)];
  answerScope.push(bulkVisible);
  if (f?.region?.length) answerScope.push(inArray(scopeAnswers.region, f.region));
  const runProjectIds =
    opts?.runProjectIds == null
      ? []
      : Array.isArray(opts.runProjectIds)
        ? opts.runProjectIds
        : [opts.runProjectIds];
  if (runProjectIds.length) {
    // 프로젝트/웹사이트: 검증된 프로젝트의 run 소속 답변만 — 표준 brand 게이트보다
    // 좁은 게이트라 IDOR 방어 강도는 유지된다.
    answerScope.push(
      sql`${scopeAnswers.runId} IN (SELECT run_id FROM scope_runs WHERE project_id = ${uuidAnyParam(
        runProjectIds,
      )})`,
    );
  } else if (f?.brand?.length) {
    answerScope.push(
      sql`${scopeAnswers.promptId} IN (SELECT scope_prompt_id FROM prompts WHERE brand IN (${sql.join(
        f.brand.map((b) => sql`${b}`),
        sql`, `,
      )}) AND scope_prompt_id IS NOT NULL)`,
    );
  }
  const occAvailable = await mentionOccurrencesAvailable();
  const stanceAvailable = await answerStancesAvailable();
  const [answers, cits, ments, occRows, stanceRows] = await Promise.all([
    db
      .select({ text: scopeAnswers.answerText, measuredAt: scopeAnswers.measuredAt })
      .from(scopeAnswers)
      .where(and(...answerScope))
      .limit(1),
    db
      .select({
        url: scopeCitations.url,
        domain: scopeCitations.domain,
        title: scopeCitations.title,
        category: scopeCitations.category,
      })
      .from(scopeCitations)
      .where(eq(scopeCitations.jobId, jobId))
      .orderBy(scopeCitations.refIndex),
    db.select().from(scopeMentions).where(eq(scopeMentions.jobId, jobId)),
    occAvailable
      ? db.select().from(scopeMentionOccurrences).where(eq(scopeMentionOccurrences.jobId, jobId))
      : Promise.resolve([] as ScopeMentionOccurrenceRow[]),
    stanceAvailable
      ? db.select().from(scopeAnswerStances).where(eq(scopeAnswerStances.jobId, jobId))
      : Promise.resolve([] as ScopeAnswerStanceRow[]),
  ]);
  const text = answers[0]?.text;
  if (!text) return { available: false };
  const brandById = new Map<string, string>();
  for (const m of ments) {
    if (m.entityType === "Brand" && m.brand) brandById.set(m.entityId, m.brand);
  }
  // 답변 모달 배지 — KPI와 동일한 단위 규칙(당사 = 자사 명부 ∩ 단위 컨텍스트).
  // 판정 전에 표기 병합(브랜드 표기 병합, PR#40)과 같은 규칙으로 접는다:
  //   ① 레지스트리 알리아스 페어로 entity_id → 정본 id
  //   ② 페어가 없으면 표기명 해석('제네시스'→Genesis 등) — 레지스트리에 알리아스
  //      행이 없는 환경 드리프트에도 안전한 이름 폴백 (result-adapter 와 동일)
  //   ③ 표시명은 canonicalBrandDisplayName 으로 정규화 후 같은 이름 행을 합산
  // (2026-08-06 고객 피드백: 국문명이 경쟁사로 집계 — 이 경로만 접기 밖이었다)
  const trackedIds = new Set(
    trackedEntityIdsFor(f?.contextBrand ?? f?.brand, f?.ownEntities),
  );
  const aliasToCanon = new Map(rollupCanonicalPairs(f?.ownEntities));
  const canonEntityId = (id: string, name: string): string => {
    // ①' 표기 접두 교정 — SQL canonRollupSql 과 동일 우선순위(표기 우선).
    const byPrefix = hmgRollupIdByNamePrefix(name);
    if (byPrefix) return byPrefix;
    const viaRoster = aliasToCanon.get(id);
    if (viaRoster) return viaRoster;
    const b = resolveHmgBrandName(name);
    return b ? HMG_BRAND_ENTITY_IDS[b] : id;
  };
  const brandAgg = new Map<string, { name: string; count: number; tracked: boolean }>();
  for (const m of ments) {
    if (m.entityType !== "Brand" || !m.brand) continue;
    const name = canonicalBrandDisplayName(m.brand);
    const tracked =
      trackedIds.has(m.entityId) || trackedIds.has(canonEntityId(m.entityId, m.brand));
    const prev = brandAgg.get(name);
    if (prev) {
      prev.count += m.mentionCount;
      prev.tracked = prev.tracked || tracked;
    } else {
      brandAgg.set(name, { name, count: m.mentionCount, tracked });
    }
  }
  const brandMentions = [...brandAgg.values()].sort((a, b) => b.count - a.count);
  const modelMentions = ments
    .filter((m) => m.entityType !== "Brand" && m.brand)
    .map((m) => {
      const parent = m.brandRollupEntityId
        ? (brandById.get(m.brandRollupEntityId) ?? null)
        : null;
      return {
        name: m.brand!,
        count: m.mentionCount,
        // 소속 브랜드 배지도 정본 표시명으로 (Genesis/제네시스 갈림 방지).
        brand: parent ? canonicalBrandDisplayName(parent) : null,
      };
    })
    .sort((a, b) => b.count - a.count);
  // 감성 밑줄 — 당사 판정은 위 trackedIds(단위 컨텍스트 규칙) 그대로. 발생의 브랜드명은
  // 부모 멘션 사전(brandById)으로 해소하고 표시명은 정본으로 정규화한다.
  const occInputs: OccurrenceInput[] = occRows.map((o) => {
    const rawName = brandById.get(o.brandRollupEntityId ?? o.entityId) ?? null;
    return {
      entityId: o.entityId,
      brandRollupEntityId: o.brandRollupEntityId,
      brandName: rawName ? canonicalBrandDisplayName(rawName) : null,
      sourceStart: o.sourceStart, sourceEnd: o.sourceEnd, surfaceText: o.surfaceText,
      sentiment: (["positive", "negative", "mixed"].includes(o.sentiment) ? o.sentiment : "neutral") as OccurrenceInput["sentiment"],
      assertion: o.assertion, contextSnippet: o.contextSnippet,
      descriptors: o.descriptors ?? [], criteria: o.criteria ?? [], turnIndex: o.turnIndex,
    };
  });
  const trackedIdsForSpans = new Set<string>();
  for (const id of trackedIds) trackedIdsForSpans.add(id);
  // 롤업 정본 id 도 포함 — canonEntityId 가 표기 접두/명부/이름 폴백으로 접은 결과와
  // 발생 행의 brand_rollup_entity_id 가 같은 브랜드를 다른 id 로 가리킬 수 있다.
  for (const m of ments) if (trackedIds.has(canonEntityId(m.entityId, m.brand ?? ""))) trackedIdsForSpans.add(m.entityId);
  const sentiment = buildSentimentSpans(text, occInputs, trackedIdsForSpans);

  // 브랜드 스탠스(0072) — 표시명은 발생 밑줄과 같은 규칙으로 해소한다(멘션 사전 →
  // 정본 표기). 당사 판정도 위 trackedIdsForSpans 를 그대로 써서 배지·밑줄·태그가
  // 한 화면에서 서로 다른 답을 내지 않게 한다. 미러의 is_tracked(코어 판정)는
  // 쓰지 않는다 — hmg 의 단위 컨텍스트 규칙과 다르다.
  const stanceViews: AnswerStanceView[] = stanceRows
    // 어휘 밖 stance 는 **버린다**(neutral 로 접지 않는다). 쓰기 경로가 이미 같은
    // 어휘로 거르므로 여기 걸리는 값은 "미러에 직접 들어온 것" 아니면 코어가 어휘를
    // 넓힌 신호다 — 중립으로 접으면 그 사실이 조용히 사라지고, 분포 카드(4계열 합)와
    // 모달 배지가 서로 다른 모수를 갖는다(F3).
    .filter((r) => STANCE_VALUES.has(r.stance))
    .map((r): AnswerStanceView => {
      const rawName = brandById.get(r.entityId) ?? r.brandLabel ?? null;
      return {
        turnIndex: r.turnIndex ?? 0,
        entityId: r.entityId,
        brand: rawName ? canonicalBrandDisplayName(rawName) : (r.brandLabel ?? r.entityId),
        tracked: trackedIdsForSpans.has(r.entityId) || trackedIds.has(canonEntityId(r.entityId, rawName ?? "")),
        stance: r.stance as AnswerStanceView["stance"],
        confidence: r.confidence ?? null,
        evidenceText: r.evidenceText ?? null,
        // 오프셋 존재가 아니라 **원문 대조**로 판정한다(F5). 미러가 가진 원문은
        // `text`(= scope_answers.answer_text, 1턴)뿐이라 turn>0 은 항상 unavailable.
        evidenceMatch: verifyStanceEvidence(text, {
          turnIndex: r.turnIndex ?? 0,
          evidenceText: r.evidenceText ?? null,
          evidenceStart: r.evidenceStart ?? null,
          evidenceEnd: r.evidenceEnd ?? null,
        }),
        reason: r.reason ?? null,
      };
    })
    // 턴 오름차순 → 당사 먼저 → 표시명. 결정적 순서(같은 답변을 두 번 열어도 같은 배열)
    // 이고, 턴이 1차 키라 화면이 턴별로 묶어 그릴 수 있다.
    .sort((a, b) =>
      a.turnIndex !== b.turnIndex
        ? a.turnIndex - b.turnIndex
        : a.tracked === b.tracked
          ? a.brand.localeCompare(b.brand)
          : a.tracked
            ? -1
            : 1,
    );

  return {
    available: true,
    answerText: text,
    measuredAt: answers[0]?.measuredAt?.toISOString() ?? null,
    citations: cits,
    brandMentions,
    modelMentions,
    ...(occRows.length ? { sentiment } : {}),
    // 행이 없으면 **키 자체를 안 싣는다** — occurrence 와 같은 규약(과거 회차·테이블
    // 미적용 창에서 모달이 종전과 바이트 동일하게 그려지도록).
    ...(stanceViews.length ? { stances: stanceViews } : {}),
  };
}

// ── Mirror 상태 진단 (운영 — trend chart "측정 누적 중" 폴백이 멈춰있을 때) ──
// scope_answers 누적 카운트 + distinct bucket cadence + 사이드 테이블 카운트를
// 한 번에 묶어 노출. /api/cron/mirror-status route 가 호출.
//
// brandSample / trackedMentionRows — scope_mentions.brand 의 실제 표기와
// TRACKED 상수('Hyundai','Kia','Genesis')가 일치하는지 가르기 위해. 표기가
// 다르면 trend 가 항상 visibility 0%, position 100 으로 평탄해진다.
export interface MirrorStatus {
  totalAnswers: number;
  measuredAnswers: number;
  distinctWeeks: number;
  distinctDays: number;
  firstMeasuredAt: string | null;
  lastMeasuredAt: string | null;
  mentionRows: number;
  citationRows: number;
  trackedMentionRows: number;
  brandSample: Array<{ brand: string; rows: number }>;
}

export async function getMirrorStatus(): Promise<MirrorStatus> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT
      count(*)::int AS total_answers,
      count(*) FILTER (WHERE a.measured_at IS NOT NULL)::int AS measured_answers,
      count(DISTINCT ${sessionTzBucketSql("week", sql`a.measured_at`)})::int AS distinct_weeks,
      count(DISTINCT date_trunc('day', a.measured_at))::int AS distinct_days,
      min(a.measured_at) AS first_measured_at,
      max(a.measured_at) AS last_measured_at
    FROM scope_answers a
  `)) as unknown as Array<{
    total_answers: number;
    measured_answers: number;
    distinct_weeks: number;
    distinct_days: number;
    first_measured_at: string | null;
    last_measured_at: string | null;
  }>;
  const r = rows[0] ?? {
    total_answers: 0,
    measured_answers: 0,
    distinct_weeks: 0,
    distinct_days: 0,
    first_measured_at: null,
    last_measured_at: null,
  };
  const sideRows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM scope_mentions) AS mention_rows,
      (SELECT count(*)::int FROM scope_citations) AS citation_rows,
      (SELECT count(*)::int FROM scope_mentions WHERE brand IN ${TRACKED}) AS tracked_mention_rows
  `)) as unknown as Array<{
    mention_rows: number;
    citation_rows: number;
    tracked_mention_rows: number;
  }>;
  const s = sideRows[0] ?? {
    mention_rows: 0,
    citation_rows: 0,
    tracked_mention_rows: 0,
  };
  // TRACKED 와 매칭 안 되더라도 어떤 brand 표기가 실제로 들어와 있는지 보기
  // 위해 top 10 brand sample 노출. 표기 불일치 (예: '현대' / 'HYUNDAI')면 한 번에 보임.
  const brandRows = (await db.execute(sql`
    SELECT brand, count(*)::int AS rows
    FROM scope_mentions
    WHERE brand IS NOT NULL
    GROUP BY brand
    ORDER BY rows DESC
    LIMIT 10
  `)) as unknown as Array<{ brand: string; rows: number }>;
  return {
    totalAnswers: r.total_answers,
    measuredAnswers: r.measured_answers,
    distinctWeeks: r.distinct_weeks,
    distinctDays: r.distinct_days,
    firstMeasuredAt: r.first_measured_at,
    lastMeasuredAt: r.last_measured_at,
    mentionRows: s.mention_rows,
    citationRows: s.citation_rows,
    trackedMentionRows: s.tracked_mention_rows,
    brandSample: brandRows,
  };
}

// ── KPI ⑥ AI 타겟 URL 인용률 — citation accuracy ──────────────────────────
// 자사 도메인 인용 답변(분모) 중 project_tracked_urls.url 과 매칭되는 답변(분자)의
// 비율. trackedUrls 가 비면 null → 카드에 '측정 대기' 칩 (라벨링 안 된 상태).
// answerWhere(filters) 로 분모/분자 모두 동일 필터 적용 — KPI 카드 변화량과
// 시계열이 정합한다.
export interface CitationAccuracyResult {
  ownedAnswers: number;
  targetAnswers: number;
  rate: number | null; // %, null = 라벨 0개 또는 분모 0
}

export interface CitationAccuracyTrendBucket {
  bucketStart: string;
  ownedAnswers: number;
  targetAnswers: number;
  rate: number | null;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
}

export async function aggregateCitationAccuracy(
  filters: StandardFilters,
  trackedUrls: string[],
  ownedPrefix = "",
  scopeProjectId?: string,
): Promise<CitationAccuracyResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  if (trackedUrls.length === 0) {
    return { ownedAnswers: 0, targetAnswers: 0, rate: null };
  }
  const db = getDb();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const W = answerWhere(filters, scopeProjectId, { hiddenFamily: "citations" });

  // citation url 을 비교용으로 정규화: 트림 → lower → scheme → 선행 www. →
  // fragment(#…) → 끝 슬래시를 JS normalizeUrlForMatch 와 동일한 순서·독립
  // 단계로 제거한다. (각 단계가 독립이라 scheme 없는 www. / 앞뒤 공백 / #:~:text=
  // 같은 변형도 JS 와 같은 결과로 수렴 — verify:url-match 가 SQL↔JS 일치를 강제.)
  const cnorm = citationNormExpr("tracked", sql`c.url`, sql`c.url_norm`);

  // 분모(자사 도메인 인용) 판정. 프로젝트가 소유 도메인을 설정했으면 그
  // 프리픽스(호스트+경로)로 좁히고 — 예: 'kia.com/it' 는 kia.com/it 와 그
  // 하위 경로만 매칭(kia.com/italy 는 제외), 미설정이면 글로벌 geo-catalog
  // 호스트 패턴으로 fallback.
  const ownedClause = ownedPrefix
    ? sql`(${cnorm} = ${ownedPrefix} OR ${cnorm} LIKE ${ownedPrefix} || '/%')`
    : sql`c.domain ~* ${OWNED}`;

  // 분자(타겟 URL 인용) 판정. 추적 URL 도 같은 규칙으로 정규화 후 비교 —
  // http/https·www·끝 슬래시·트래킹 파라미터 차이로 누락되지 않게 한다(자원을
  // 식별하는 쿼리는 보존 → 의도적으로 다른 URL). 정규화 후 빈 값/중복은 제거.
  const targets = [
    ...new Set(trackedUrls.map(normalizeUrlForMatch).filter(Boolean)),
  ];
  const targetClause = targets.length
    ? sql`${cnorm} IN (${sql.join(
        targets.map((u) => sql`${u}`),
        sql`, `,
      )})`
    : sql`false`;

  const rows = (await db.execute(sql`
    WITH ans AS (
      SELECT a.job_id,
        EXISTS (
          SELECT 1 FROM scope_citations c
          WHERE c.job_id = a.job_id AND ${ownedClause}
        ) AS owned,
        EXISTS (
          SELECT 1 FROM scope_citations c
          WHERE c.job_id = a.job_id AND ${targetClause}
        ) AS target
      FROM scope_answers a WHERE ${W}
    )
    SELECT
      count(*) FILTER (WHERE owned)::int AS owned_answers,
      count(*) FILTER (WHERE owned AND target)::int AS target_answers
    FROM ans
  `)) as unknown as Array<{ owned_answers: number; target_answers: number }>;
  const r = rows[0] ?? { owned_answers: 0, target_answers: 0 };
  const owned = num(r.owned_answers);
  const target = num(r.target_answers);
  const rate = owned > 0 ? round1((100 * target) / owned) : null;
  return { ownedAnswers: owned, targetAnswers: target, rate };
}

export async function aggregateCitationAccuracyTrend(
  filters: StandardFilters,
  trackedUrls: string[],
  unit: BucketUnit = "week",
  ownedPrefix = "",
  scopeProjectId?: string,
): Promise<CitationAccuracyTrendBucket[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (trackedUrls.length === 0) return [];
  const db = getDb();
  const W = answerWhere(filters, scopeProjectId, { allRuns: true, hiddenFamily: "citations" });
  const field = BUCKET_FIELD[unit] ?? "week";
  // 120일 창 — TREND_WINDOW_DAYS 머리 주석 참조 (allRuns 추이 계열 공통).
  // 뷰 앵커 전 회차 제외 — excludeHiddenCycleRuns 머리 주석. 프로젝트 ⑥ 은
  // 웹사이트 ⑥(aggregateWebsiteCitationAccuracyTrend, 핫픽스 A)과 같은 지표라
  // 같은 모수를 봐야 한다. 계열 = **인용**(0071) — 지표 자체가 인용 정확도다.
  // 격자가 자리 바닥을 넘기는 호출부다(`fetchProjectCitationAccuracyTrend` ·
  // `withTrendGridWindow`) — `TREND_GRID_FLOOR_DAYS` 머리 주석.
  const bucketed = sql`${W} AND a.measured_at IS NOT NULL AND ${trendWindowFloor(
    undefined, undefined, false, false, trendFloorDays(unit),
  )}
    AND ${await excludeHiddenCycleRuns(sql`a.run_id`, "citation", sql`a.job_id`)}`;
  // 버킷별 스냅샷 (2026-09-01) — 버킷 안에서 셀(프롬프트×엔진×지역)당 최신 답변
  // 1개만. 카드(스냅샷)와 같은 단위여야 같은 화면의 두 숫자가 어긋나지 않는다.
  // DISTINCT ON / ORDER BY 는 문자적으로 같은 식이어야 하므로 field 를 리터럴로 굳힌다.
  const anchorOn = anchorAxisKnownEnabled();
  const bkt = periodBucketSql(field, sql`a.measured_at`, { anchorAxis: anchorOn });
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. 이 사본은 버킷이 키 **맨 앞**이다
  // (같은 일을 하는 다른 사본은 뒤에 둔다 — 순서 차이를 인자로 드러낸다).
  // 앵커 축이면 키 선두가 버킷(주)이 아니라 **회차**다(`trendCellKeys` 머리 주석).
  const cellKeys = anchorOn
    ? anchorCellSnapshotKeys({ alias: "a." })
    : cellSnapshotKeys({ alias: "a.", bucket: bkt, bucketFirst: true });
  const cnorm = citationNormExpr("tracked", sql`c.url`, sql`c.url_norm`);
  const ownedClause = ownedPrefix
    ? sql`(${cnorm} = ${ownedPrefix} OR ${cnorm} LIKE ${ownedPrefix} || '/%')`
    : sql`c.domain ~* ${OWNED}`;
  const targets = [
    ...new Set(trackedUrls.map(normalizeUrlForMatch).filter(Boolean)),
  ];
  const targetClause = targets.length
    ? sql`${cnorm} IN (${sql.join(
        targets.map((u) => sql`${u}`),
        sql`, `,
      )})`
    : sql`false`;

  const rows = (await db.execute(sql`
    WITH ans AS (
      SELECT DISTINCT ON (${cellKeys.all})
        ${bkt} AS bucket,
        a.measured_at,
        EXISTS (
          SELECT 1 FROM scope_citations c
          WHERE c.job_id = a.job_id AND ${ownedClause}
        ) AS owned,
        EXISTS (
          SELECT 1 FROM scope_citations c
          WHERE c.job_id = a.job_id AND ${targetClause}
        ) AS target
      FROM scope_answers a${anchorOn ? anchorJoinSql(sql.raw("a.job_id")) : sql``}
      WHERE ${bucketed}
      ORDER BY ${cellKeys.all}, ${cellKeys.tieBreak}
    )
    SELECT
      bucket,
      count(*) FILTER (WHERE owned)::int AS owned_answers,
      count(*) FILTER (WHERE owned AND target)::int AS target_answers,
      count(DISTINCT date_trunc('day', measured_at))::int AS measured_days,
      min(measured_at) AS first_at,
      max(measured_at) AS last_at
    FROM ans
    GROUP BY bucket
    ORDER BY bucket
  `)) as unknown as Array<{
    bucket: string;
    owned_answers: number;
    target_answers: number;
    measured_days: number;
    first_at: string | null;
    last_at: string | null;
  }>;

  return rows.map((r) => {
    const ownedAnswers = num(r.owned_answers);
    const targetAnswers = num(r.target_answers);
    return {
      bucketStart: new Date(r.bucket).toISOString().slice(0, 10),
      ownedAnswers,
      targetAnswers,
      rate: ownedAnswers > 0 ? round1((100 * targetAnswers) / ownedAnswers) : null,
      measuredDays: num(r.measured_days),
      firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
      lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    };
  });
}

// ── website 자사 base — 측정 유닛이 선언한 값 (2026-09-01) ──────────────────
// geo-catalog(브랜드×국가)로는 실제 측정 유닛을 표현할 수 없어 website_prompts 가
// owned_base_url 을 직접 갖는다(migration 0049). 화면 필터와 **같은 축**으로 좁혀
// 읽으므로, 언어를 고르면 그 언어의 base 만, 국가를 고르면 그 나라 base 만 나온다.
// 선언이 하나도 없으면 빈 배열 — 호출부가 카탈로그로 폴백한다.
export async function websiteDeclaredOwnedBases(
  filters: StandardFilters,
  scopeProjectIds: string[],
): Promise<{ prefixes: string[]; universe: string[] }> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  if (scopeProjectIds.length === 0) return { prefixes: [], universe: [] };
  const db = getDb();
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const conds: SQL[] = [
    sql`ws.scope_project_id::text = ${textAnyParam(scopeProjectIds)}`,
    sql`wp.owned_base_url IS NOT NULL`,
    sql`wp.owned_base_url <> ''`,
  ];
  if (filters.lang?.length) conds.push(sql`wp.lang_code IN (${inList(filters.lang)})`);
  if (filters.websiteCountry?.length) conds.push(websiteSiteGeoPred(filters.websiteCountry));
  const pick = async (where: SQL[]) => {
    const rows = (await db.execute(sql`
      SELECT DISTINCT wp.owned_base_url AS base
      FROM website_prompts wp
      JOIN website_sites ws ON ws.id = wp.site_id
      WHERE ${sql.join(where, sql` AND `)}
    `)) as unknown as Array<{ base: string }>;
    return rows.map((r) => r.base).filter(Boolean);
  };
  const prefixes = await pick(conds);
  if (prefixes.length === 0) return { prefixes, universe: [] };
  // `universe` 는 '가장 긴 접두가 이긴다' 판정의 형제 모집단 — 선택된 base 와 **호스트가
  // 같은 선언 전부**다. 화면 축(언어·국가)과 계정 스코프(project id) 어느 것으로도
  // 좁히지 않는다: 형제는 같은 사이트 행이 아닐 수 있기 때문이다. 2026-09-05 실측 —
  // Hyundai N 은 KO 가 `country_code=KR`·EN 이 `worldwide` 로 **사이트 행이 둘**이라,
  // EN 쪽을 국가로 좁히거나 EN 프로젝트만 가진 계정이면 모집단에 `hyundai-n.com/ko` 가
  // 없어 /ko 인용 39건(자사 273 중)이 EN 자사로 잡혔다. 호스트가 다른 선언은 판정에
  // 영향이 없으므로(접두 매칭이 안 된다) 호스트로만 거른다. 카탈로그를 모집단으로 쓰면
  // 같은 사이트의 하위 경로를 남의 자산으로 오인해 제외한다(선언 `kia.com/my` 에
  // 카탈로그의 `kia.com/my/en` 이 걸리던 문제) — 그래서 선언 목록에서만 뽑는다.
  const hosts = [...new Set(prefixes.map((p) => p.split("/")[0]).filter(Boolean))];
  const universe = await pick([
    sql`wp.owned_base_url IS NOT NULL`,
    sql`wp.owned_base_url <> ''`,
    sql`split_part(wp.owned_base_url, '/', 1) IN (${inList(hosts)})`,
  ]);
  return { prefixes, universe };
}

/**
 * 이 문장이 유닛 단위 판정을 쓰는가. 쓰면 유닛 행을, 아니면 `null`.
 *
 * 두 조건을 **모두** 본다: ① 화면 키(동기 읽기 — 진입점이 `ensureWebsiteOwnedUnit()`
 * 을 await 해 둬야 한다) ② 호출부가 실제로 유닛을 넘겼는가. 빈 배열이면 종전 flat 이다
 * (선언도 타겟도 없는 스코프에서 판정이 통째로 공집합이 되는 것을 막는다 —
 * `ownedBasePrefixClause` 의 `prefixes.length === 0 → false` 와 같은 자리).
 *
 * `null` 을 내면 호출부의 SQL 이 **글자 그대로 종전과 같아야 한다**. 그 성질을
 * `website-owned-unit.sql-shape.test.ts` 가 키 on/off 텍스트 대조로 고정한다.
 */
function websiteUnitsIfEnabled(
  units: readonly WebsiteOwnedUnit[] | undefined,
): readonly WebsiteOwnedUnit[] | null {
  if (!units || units.length === 0) return null;
  return websiteOwnedUnitKnownEnabled() ? units : null;
}

/**
 * 유닛 목록이 넘어온 진입점만 판정을 **확정**한다.
 *
 * 왜 조건부인가: 표준(글로벌)·프로젝트 표면은 유닛을 절대 넘기지 않는데, 그쪽에서도
 * `ensureWebsiteOwnedUnit()` 을 부르면 그 표면에 아무 영향도 없는 설정 읽기가 한 번 더
 * 생긴다. `websiteUnitsIfEnabled(undefined)` 는 판정을 보기도 전에 `null` 이므로,
 * 확정을 건너뛰어도 결과가 달라질 자리가 없다(미확정 경고도 나지 않는다).
 */
async function ensureWebsiteOwnedUnitFor(
  units: readonly WebsiteOwnedUnit[] | undefined,
): Promise<void> {
  if (units && units.length > 0) await ensureWebsiteOwnedUnit();
}

/**
 * 유닛 판정의 **프롬프트 대응표** — `wu`(유닛 VALUES) + `wut`(유닛의 타겟 집합) +
 * `wup`(프롬프트 → 유닛 1행).
 *
 * `unit_turls` = 그 유닛의 `target_url` 전부를 **tracked NORM** 으로 접은 배열 = 리포트
 * 추출기의 `tset`(extract-citation-data.mts:76, `DISTINCT NORM_T(target_url)` over `lp`)와
 * 같은 값이다. 초판은 이 자리에 **그 프롬프트 하나의 타겟을 base NORM 으로** 실었는데,
 * 정본 대비 NORM 종류와 범위가 **둘 다** 달랐다(2026-09-20 검증 F). 판정식은
 * `websiteUnitOwnedTargetClause` 한 곳이다.
 *
 * ⚠️ `DISTINCT ON (scope_prompt_id)` 이 **행 배수를 고정한다**. 인용 집계는 `count(*)` 가
 *    분모·분자라, 한 프롬프트가 두 행으로 붙는 순간 인용 수가 조용히 부풀어 오른다.
 *    `website_prompts` 는 (site_id, file_seq, seq_no) 유니크라 같은 `scope_prompt_id` 가
 *    여러 행일 수 있고(중복 등록·재사용), 그 경우에도 여기서 한 행으로 접힌다.
 *
 * ⚠️ **동률 정렬 키는 `(unit_base, file_seq, site_id)` 셋이다.** `unit_base` 하나만으로는
 *    비결정적이었다 — `unit_sibs`·`unit_home_host` 는 base 의 함수라 동률이면 같은 값이지만
 *    `unit_turls` 는 아니다(유닛마다 다른 프롬프트 집합). 그래서 같은 base 를 선언한 유닛이
 *    둘이면 어느 행이 뽑히느냐로 타겟 항이 흔들렸다(2026-09-20 검증 C 지적 1).
 *
 * ⚠️ **한 프롬프트 = 한 유닛**이 이 표의 계약이다. 리포트는 (유닛, 프롬프트) 쌍마다
 *    독립으로 판정하므로, 한 프롬프트가 유닛 **둘**에 걸리면 대시보드(프롬프트당 판정 1개)
 *    와 리포트가 그 프롬프트에서 갈릴 수 있다. 실재 여부 확인 SQL:
 *    `notes/hmg-anchor-table/website-citation-parity/owned-unit/C1-prompt-multi-unit.sql`
 *    (0 이면 이론적 위험). `aggregateWebsiteTargetHitRate` 도 **같은 표**를 쓴다 —
 *    종전에는 그 카드만 `wp LEFT JOIN wu` 로 유닛들의 OR 을 취해 규칙이 둘이었다(검증 C 지적 2).
 *
 * ⚠️ **필터를 받지 않는다.** 유닛 base 도 유닛의 타겟 집합도 화면 축과 무관한 고유값이다
 *    (flat 경로의 결함이 정확히 "필터에 따라 자사 집합이 달라진다" 였다).
 */
function websiteUnitPromptCtes(
  units: readonly WebsiteOwnedUnit[],
  /**
   * `wup` 을 이 프롬프트들로만 좁힌다(text `scope_prompt_id` 를 내는 서브쿼리). 생략하면
   * 종전 문장과 **글자 그대로 같다**(대시보드 호출부는 전부 생략).
   *
   * 좁혀도 판정이 안 바뀌는 이유: `DISTINCT ON (scope_prompt_id)` 의 키 자체로 거르므로
   * 남는 프롬프트마다 고르는 행은 그대로다. `wut`(유닛의 tset)는 좁히지 않는다 :
   * 그것은 유닛의 **모든** 프롬프트 타겟이어야 한다(리포트 정본).
   *
   * 사실표 생성기(`websitePromptUrlHitJobFlagsSql`)가 쓴다. 좁히지 않으면 `wup` 이
   * 함대 전체 12,685행이고, 프로젝트 하나(~200 job)의 인용 행 × 그 CTE 스캔 Nested Loop
   * 가 잡힐 수 있다(2026-09-27 라이브 EXPLAIN: Kia MX 4,182 × 12,685 = 5,300만 비교, 86 s).
   */
  promptScope?: SQL,
): SQL {
  const narrow = promptScope
    ? sql`
        AND wp.scope_prompt_id IN (${promptScope})`
    : sql``;
  return sql`${websiteOwnedUnitCte(units)},
    wut AS MATERIALIZED (
      -- 유닛의 tset. wu 조인으로 **판정에 쓰이는 유닛만** 접는다(비용 축소) — 유닛을
      -- 거르는 것이지 유닛 안의 프롬프트를 거르는 것이 아니므로 집합은 정본과 같다.
      SELECT wp.site_id, wp.file_seq,
        array_agg(DISTINCT ${citationTrackedNormSql(sql`wp.target_url`)}) AS unit_turls
      FROM website_prompts wp
      JOIN wu ON wu.site_id = wp.site_id AND wu.file_seq = wp.file_seq
      WHERE coalesce(wp.target_url, '') <> ''
      GROUP BY wp.site_id, wp.file_seq
    ),
    wup AS MATERIALIZED (
      SELECT DISTINCT ON (wp.scope_prompt_id) wp.scope_prompt_id AS prompt_id,
        wu.unit_base, wu.unit_sibs, wu.unit_home_host, wut.unit_turls
      FROM website_prompts wp
      JOIN wu ON wu.site_id = wp.site_id AND wu.file_seq = wp.file_seq
      LEFT JOIN wut ON wut.site_id = wp.site_id AND wut.file_seq = wp.file_seq
      WHERE wp.scope_prompt_id IS NOT NULL AND wp.scope_prompt_id <> ''${narrow}
      ORDER BY wp.scope_prompt_id, wu.unit_base, wp.file_seq, wp.site_id
    )`;
}

/** `wup` 되붙이기 — 프롬프트당 1행이라 조인 배수가 1:1 이다(위 ⚠️). */
function websiteUnitPromptJoin(promptCol: SQL): SQL {
  return sql`
      LEFT JOIN wup ON wup.prompt_id = ${promptCol}::text`;
}

/**
 * owned **후보 도메인**(비싼 정규화를 돌릴 행)을 고르는 base 목록.
 *
 * `citationOwnedBaseSql` 은 이 목록의 registrable 도메인에 속한 행만 정규화하고 나머지는
 * `NULL` 로 둔다. 유닛 판정에서는 판정 입력이 **유닛 base** 라, flat 목록(화면 축으로
 * 좁혀진 선언 base)만 후보로 쓰면 그 축 밖의 유닛 base 가 통째로 NULL 이 되어 자사가
 * **조용히 적게** 잡힌다. 그래서 유닛 base 를 합집합으로 더한다 — 후보는 넓혀도 판정은
 * 안 바뀌고(호스트 사전필터가 그대로 있다) 비용만 후보 비율에 비례해 는다.
 */
function ownedCandidateBases(
  ownedBasePrefixes: string[],
  units: readonly WebsiteOwnedUnit[] | null,
): string[] {
  if (!units) return ownedBasePrefixes;
  return [...new Set([...ownedBasePrefixes, ...units.map((u) => u.base)])];
}

// ── website 자사 base — **유닛 단위**(2026-09-20, 화면 키 `X.websiteOwnedUnit`) ──
// 위 `websiteDeclaredOwnedBases` 가 내는 평면 합집합의 짝. 같은 선언값을 읽되 유닛
// (사이트 × `file_seq`)마다 **하나의 base** 로 접어, 그 유닛 프롬프트의 인용만 그
// base 로 판정하게 한다. 규칙은 집계 사실표 생성기(`scripts/summary/surface-website.ts`
// 의 `decl`·`heur`·`sib`)와 1:1 이고, 그 생성기가 발행 리포트와 같은 값을 낸다.
//
// ⚠️ **필터를 받지 않는다.** 유닛 base 는 그 유닛 고유의 값이라 화면 축(브랜드·국가·
//    언어)과 무관해야 한다 — flat 경로의 결함이 정확히 "필터에 따라 자사 집합이
//    달라져 같은 프롬프트의 판정이 바뀐다" 였다. 계정 스코프도 받지 않는다: 형제
//    모집단은 선언 목록 **전량**이어야 하고(surface-website.ts:179 와 같은 모집단),
//    유닛 자체는 프롬프트 조인에서 자연히 걸러진다.
//
// ⚠️ 프리픽스 변환·형제 계산을 **TS 에서** 한다. `ownedBasePrefixFromUrl` 과
//    `SHARED_GLOBAL_HOSTS` 를 그대로 부르므로 SQL 근사와 갈라질 자리가 없다.
export async function websiteOwnedUnits(): Promise<WebsiteOwnedUnit[]> {
  await ensureColumnAvailability();
  const db = getDb();
  const rows = (await db.execute(sql`
    WITH wp AS (
      SELECT wp.site_id, wp.file_seq,
             nullif(wp.owned_base_url, '') AS decl,
             ${citationBaseNormSql(sql`wp.target_url`)} AS turl_base
      FROM website_prompts wp
      JOIN website_sites ws ON ws.id = wp.site_id
      WHERE ws.scope_project_id IS NOT NULL AND ws.scope_project_id <> ''
        AND wp.scope_prompt_id IS NOT NULL AND wp.file_seq IS NOT NULL
    ),
    -- 선언 base 의 최빈값. 동률은 문자열로 가른다(생성기가 비결정성을 막는 자리).
    decl AS (
      SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, decl AS base
      FROM (SELECT site_id, file_seq, decl, count(*) AS n FROM wp
            WHERE decl IS NOT NULL GROUP BY 1, 2, 3) d
      ORDER BY site_id, file_seq, n DESC, decl
    ),
    -- 선언이 없는 유닛의 폴백 = 타겟 URL 의 최다 호스트(공유 글로벌 호스트만 host/1seg).
    heur AS (
      SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, k AS base
      FROM (
        SELECT site_id, file_seq,
               CASE WHEN split_part(turl_base, '/', 1) = ANY(${sql.param([...SHARED_GLOBAL_HOSTS])}::text[])
                         AND split_part(turl_base, '/', 2) <> ''
                    THEN split_part(turl_base, '/', 1) || '/' || split_part(turl_base, '/', 2)
                    ELSE split_part(turl_base, '/', 1) END AS k,
               count(*) AS n
        FROM wp WHERE coalesce(turl_base, '') <> '' GROUP BY 1, 2, 3
      ) h ORDER BY site_id, file_seq, n DESC, k
    )
    SELECT u.site_id::text AS site_id, u.file_seq::int AS file_seq,
           coalesce(d.base, h.base) AS base
    FROM (SELECT DISTINCT site_id, file_seq FROM wp) u
    LEFT JOIN decl d ON d.site_id = u.site_id AND d.file_seq = u.file_seq
    LEFT JOIN heur h ON h.site_id = u.site_id AND h.file_seq = u.file_seq
  `)) as unknown as Array<{ site_id: string; file_seq: number; base: string | null }>;
  // 형제 모집단 = 선언 base **전량**(스코프·필터로 좁히지 않는다 — 위 ⚠️).
  const declRows = (await db.execute(sql`
    SELECT DISTINCT wp.owned_base_url AS base FROM website_prompts wp
    WHERE wp.owned_base_url IS NOT NULL AND wp.owned_base_url <> ''
  `)) as unknown as Array<{ base: string }>;
  const declared = [...new Set(declRows.map((r) => ownedBasePrefixFromUrl(r.base)).filter(Boolean))];
  const out: WebsiteOwnedUnit[] = [];
  for (const r of rows) {
    const base = ownedBasePrefixFromUrl(r.base);
    if (!base) continue; // 선언도 타겟도 없는 유닛 — 판정은 false (flat 의 빈 prefixes 와 같다)
    const host = base.split("/")[0] ?? "";
    out.push({
      siteId: r.site_id,
      fileSeq: Number(r.file_seq),
      base,
      // `ownedBasePrefixClause` 의 longerSiblings 와 같은 식: 선택되지 않은,
      // 이 base 아래에 놓인 **더 긴** 선언.
      sibs: declared.filter((q) => q.length > base.length && q.startsWith(`${base}/`)),
      homeHost: host && !SHARED_GLOBAL_HOSTS.has(host) ? host : null,
    });
  }
  return out;
}

// ── KPI ⑥ website 타겟 인용률 (flat) ──────────────────────────────────────
// website는 프롬프트마다 website_prompts.target_url(공식 사이트의 기대 인용 페이지)이
// 이미 채워져 있다(9,569행 100%). 프로젝트판 aggregateCitationAccuracy와 같은 flat
// 시맨틱 — 분모=당사 공식 도메인을 인용한 답변, 분자=(자기 프롬프트든 아니든) 타겟
// 페이지를 인용한 답변 — 이되, 타겟 셋이 9천+개라 인라인 IN 대신 정규화된 target
// 서브쿼리로 조인한다(2026-07-08). 소유 판정은 website citationShare와 동일하게
// 글로벌 OWNED 패턴. target_url은 citation url과 동일한 SQL 정규화를 적용해 비교.
// 정규화된 타겟 URL 집합(bare SELECT — CTE 본문/서브쿼리 양쪽에서 재사용). citation
// url과 동일한 SQL 정규화(citationTrackedNormSql)를 target_url에 적용해 비교 정합.
// 타겟 집합도 **화면과 같은 축으로 좁힌다**(2026-09-01). 종전에는 site_id 로만 좁혀,
// 언어를 가른 사이트에서 다른 언어의 타겟까지 분자로 셌다 — 실측: 현대 캐나다를
// lang=fr 로 좁힌 답변 200건 중 '영어 타겟만 인용' 41건이 타겟 도달로 잡혔다(도달
// 159건의 26%). 답변 모수는 promptAxisPreds 가 이미 lang/websiteCountry 로 좁히므로
// 분자만 넓은 비대칭이었다.
// `kind` — 비교 상대 컬럼과 같은 정규화를 골라야 등치가 성립한다: ⑥ 계열은 tracked
// 정규화(`n`), ⑤ 계열의 자사 판정은 base 정규화(`base`)와 비교한다(websiteTargetOwnedClause).
function websiteTargetSetSelect(
  scopeProjectIds: string[],
  filters?: StandardFilters,
  kind: CitationNormKind = "tracked",
): SQL {
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const extra: SQL[] = [];
  if (filters?.lang?.length) extra.push(sql`wp.lang_code IN (${inList(filters.lang)})`);
  if (filters?.websiteCountry?.length) extra.push(websiteSiteGeoPred(filters.websiteCountry));
  const narrow = extra.length ? sql` AND ${sql.join(extra, sql` AND `)}` : sql``;
  const turl =
    kind === "tracked"
      ? citationTrackedNormSql(sql`wp.target_url`)
      : citationBaseNormSql(sql`wp.target_url`);
  return sql`
    SELECT DISTINCT ${turl} AS turl
    FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ws.scope_project_id::text = ${textAnyParam(scopeProjectIds)} AND wp.target_url <> ''${narrow}`;
}

// ── 타겟 페이지 = 자사 (2026-09-06) ─────────────────────────────────────────
// website 유닛이 지정한 타겟 URL 은 정의상 그 사이트의 자사 페이지다. 그런데 자사
// 판정은 선언 base 의 prefix 매칭이라, base 밖에 놓인 타겟이 "타겟 도달인데 자사가
// 아닌" 모순을 냈다 — 2026-09-04 회차 인용 데이터(v2.2) 실측 37건: 베이징현대 base
// `beijing-hyundai.com.cn` 아래 차종 서브도메인 타겟(custo./eo./mufasa./sonata./
// tucson./elantra./showroom.) 31건, 현대캐나다 `/en` base 밖 `/newsroom/…` 1건,
// 기아캐나다 `/en` base 밖 루트 `kia.ca` 5건. 규칙(제품 결정): **타겟 집합에 일치하는
// 인용은 자사**(타겟 ⊂ 자사) — 발행 인용 데이터 v2.3 과 같은 판정이다.
//
// 타겟 집합은 ⑥ 과 같은 축(lang·websiteCountry)으로 좁힌다 — 다른 언어 유닛의 타겟이
// 이 화면의 자사가 되면 안 된다. website 표면(projectCtx = string[]) 전용이라 표준·
// 프로젝트 표면은 콜사이트가 켜지 않으며(기본 false) SQL 이 글자 그대로 종전과 같다.
// 서브쿼리는 상관되지 않아 플래너가 해시 서브플랜으로 1회만 평가한다(타겟 ≤1만 행).
function websiteTargetOwnedClause(
  ownedClause: SQL,
  cnorm: SQL,
  kind: CitationNormKind,
  projectCtx: string | string[] | undefined,
  filters: StandardFilters | undefined,
  enabled: boolean,
): SQL {
  if (!enabled || !Array.isArray(projectCtx) || projectCtx.length === 0) return ownedClause;
  return sql`(${ownedClause} OR ${cnorm} IN (${websiteTargetSetSelect(projectCtx, filters, kind)}))`;
}

// ── 인용 판정 사전계산 (2026-09-03) ─────────────────────────────────────────
// website 인용 계열 3개(⑥ 카드 · ⑥ 추이 · 타겟 URL 인용률)는 스냅샷 job 으로
// 좁힌 뒤에도 `citationTrackedNormSql(c.url)`(regexp_replace 7단)을 **행마다**,
// 그리고 **식이 등장한 횟수만큼** 평가했다. owned 판정 하나가 그 식을 4번
// (호스트 prefilter + `= ANY` / `LIKE ANY` / `= ANY`), target 판정이 1번 —
// Postgres 는 스칼라 CSE 를 하지 않으므로 5회 전부 실제 평가다.
//
// 더 나쁜 것은 플랜이었다. `cit` 가 비-MATERIALIZED CTE 라 플래너가 인라인하며
// 정규화 식을 **조인 조건**으로 끌어올렸고, 그 결과 `job_id IN (snap)` 이 스캔을
// 줄이지 못해 scope_citations **전체**에 regex 를 돌렸다 — 프로덕션
// EXPLAIN (ANALYZE) 2026-09-03, 타겟 URL 인용률(admin 무필터·126 프로젝트):
//   Seq Scan on scope_citations rows=2,940,483 · Hash Cond 에 regexp_replace 사슬
//   → 전체 73,910ms 중 InitPlan 하나가 72,946ms.
//
// 고치는 방식은 KPI⑤ 추이가 2026-08-27 에 이미 쓰던 것과 같다:
//   ① 스냅샷 job 으로 좁힌 인용을 MATERIALIZED CTE(`c2`)로 **먼저 확정**하고
//   ② 정규화를 그 안의 **DISTINCT (url, domain) 당 1회**만 하고(`un`)
//   ③ owned/target 판정도 그 distinct 집합에서 1회만 한 뒤(`ub`)
//   ④ 원래 행에 되붙여 job 단위로 접는다.
// ①②③ 을 **각각 MATERIALIZED** 로 두는 것이 핵심이다 — 하나로 합치면 서브쿼리
// 풀업으로 정규화 식이 다시 5번 인라인된다(위 KPI⑤ 주석의 "인라인 시 하위식이
// 반복 평가" 와 같은 함정).
//
// NULL 취급: 조인 키는 `coalesce(...,'')` 로 만들고 판정식은 `nullif(...,'')` 로
// 원래 값을 되돌린다 — 해시 조인 가능한 등치 조건을 유지하면서 술어 의미는 종전과
// 같다. `''` 로만 갈리는 경우(url/domain 이 빈 문자열)의 결과는 NULL↔false 차이인데,
// 소비처가 전부 `FILTER (WHERE owned)` / `bool_or` 라 둘 다 "아님"으로 접힌다.
//
// `snap`(job_id 보유 CTE)을 전제로 c2/un/ub/cit 네 CTE 를 낸다. 호출부는 이 앞에
// `snap` 을, target 판정을 쓸 때는 `target_set` 을 미리 선언한다.
// 형태 고정 가드: scope-aggregates.citation-norm-once.test.ts
// ── 유닛 판정(키 on)에서 이 CTE 뭉치가 달라지는 점 ─────────────────────────
// ① 자사 판정이 `ub`(DISTINCT url×domain)에서 `cit`(인용 행)으로 내려간다 — 같은 url 도
//    어느 프롬프트가 인용했느냐로 갈리기 때문이다. 정규화 사슬(`un`)은 그대로 1회다.
// ② **base 항의 입력만 tracked NORM(`n`) 이다.** ⑥ 은 종전 flat 도 `ownedBasePrefixClause(n)`
//    로 tracked 입력을 썼고(비교 상대 `target_set` 이 tracked), 그 축은 이 트랙의 범위가
//    아니라 그대로 둔다. ⑤ 계열(base NORM 입력)과 다른 것은 **의도된 기존 차이**다.
// ③ 타겟 항은 리포트 정본과 같은 **그 유닛의 tset**(`unit_turls`, tracked NORM)을 쓴다.
//    여기에 종전 flat `target_set` OR 이 그대로 남는데, flat 집합은 화면 스코프 전체의
//    타겟이라 유닛 tset 의 상위집합이다(필터가 한 유닛의 프롬프트를 쪼개지 않는 한).
//    분자(`target`)는 **의도적으로 flat 그대로**다 — 분모를 분자보다 좁히면 비율이 100%
//    를 넘을 수 있다(`aggregateWebsiteTargetHitRate` 머리 주석의 같은 취지).
//    ⇒ 실질 효과: 분모는 종전과 같거나 커질 뿐이라 `target ⊆ owned` 가 유지된다.
function websiteCitationJudgmentCtes(
  ownedBasePrefixes: string[],
  ownedSiblingUniverse: string[] | undefined,
  units: readonly WebsiteOwnedUnit[] | null = null,
): SQL {
  const ownedOnN = ownedBasePrefixes.length
    ? ownedBasePrefixClause(sql`n`, ownedBasePrefixes, ownedSiblingUniverse)
    : sql`nullif(dk, '') ~* ${OWNED}`;
  // 타겟 페이지 = 자사(websiteTargetOwnedClause 주석) — ⑥ 의 분모(자사 인용 답변)에도
  // 같은 규칙을 건다. 호출부가 이미 선언한 `target_set`(tracked 정규화 = `n` 과 동종)을
  // 재사용하므로 정규화 사슬은 늘지 않는다(citation-norm-once 형태 가드 유지).
  const ownedOrTarget = sql`(${ownedOnN} OR n IN (SELECT turl FROM target_set))`;
  return sql`${units ? sql`${websiteUnitPromptCtes(units)},` : sql``}
    c2 AS MATERIALIZED (
      SELECT c.job_id, ${units ? sql`snap.prompt_id, ` : sql``}coalesce(c.url, '') AS uk, coalesce(c.domain, '') AS dk${citationNormProjection(sql`c.url_norm`, "nk")}
      FROM scope_citations c JOIN snap ON snap.job_id = c.job_id
    ),
    un AS MATERIALIZED (${
      citationNormColumnsAvailable()
        ? sql`
      SELECT uk, dk, coalesce(nk, citation_url_norm(nullif(uk, ''))) AS n
      FROM (SELECT uk, dk, max(nk) AS nk FROM c2 GROUP BY uk, dk) d`
        : sql`
      SELECT uk, dk, ${citationTrackedNormSql(sql`nullif(uk, '')`)} AS n
      FROM (SELECT DISTINCT uk, dk FROM c2) d`
    }
    ),
    ub AS MATERIALIZED (
      SELECT uk, dk, ${units ? sql`n,` : sql`${ownedOrTarget} AS owned,`}
        (n IN (SELECT turl FROM target_set)) AS target
      FROM un
    ),
    cit AS (
      SELECT c2.job_id,
        bool_or(${
          units
            ? sql`COALESCE(${websiteUnitOwnedTargetClause(sql`ub.n`, sql`ub.n`, "wup")}, false) OR ub.target`
            : sql`ub.owned`
        }) AS owned,
        bool_or(ub.target) AS target
      FROM c2 JOIN ub ON ub.uk = c2.uk AND ub.dk = c2.dk${
        units ? websiteUnitPromptJoin(sql`c2.prompt_id`) : sql``}
      GROUP BY c2.job_id
    )`;
}

// `ownedBasePrefixes` 는 ⑤ 와 **같은 판정**을 쓰기 위한 인자다(2026-09-01). 종전에는
// `c.domain ~* OWNED`(HMG 3사 전 도메인 호스트 정규식)라, 국가·브랜드를 좁힌 화면에서도
// 다른 나라·다른 브랜드 도메인 인용이 분모(자사 인용 답변)에 들어갔다 — Kia/KR 실측에서
// 분모 258 → 269. 빈 배열이면 종전 호스트 정규식으로 폴백(판정 공집합 방지).
export async function aggregateWebsiteCitationAccuracy(
  filters: StandardFilters,
  scopeProjectIds: string[],
  ownedBasePrefixes: string[] = [],
  ownedSiblingUniverse?: string[],
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<CitationAccuracyResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (scopeProjectIds.length === 0) return { ownedAnswers: 0, targetAnswers: 0, rate: null };
  const db = getDb();
  const W = answerWhere(filters, scopeProjectIds, { hiddenFamily: "citations" });

  // scope_citations를 답변당 두 번 스캔(owned/target EXISTS)하면 20s+ → 스냅샷
  // job으로 좁힌 뒤 job_id 단위 단일 패스(bool_or)로 owned/target을 한 번에 접는다.
  // 정규화·판정은 DISTINCT (url, domain) 당 1회 — websiteCitationJudgmentCtes 참조.
  // `snap` 은 아래에서 두 번 참조되므로(c2 조인 · 최종 LEFT JOIN) MATERIALIZED 로
  // 굳혀 두 번 계산되지 않게 한다.
  const rows = (await db.execute(sql`
    WITH snap AS MATERIALIZED (SELECT a.job_id${units ? sql`, a.prompt_id` : sql``} FROM scope_answers a WHERE ${W}),
    target_set AS MATERIALIZED (${websiteTargetSetSelect(scopeProjectIds, filters)}),
    ${websiteCitationJudgmentCtes(ownedBasePrefixes, ownedSiblingUniverse, units)}
    SELECT
      count(*) FILTER (WHERE cit.owned)::int AS owned_answers,
      count(*) FILTER (WHERE cit.owned AND cit.target)::int AS target_answers
    FROM snap LEFT JOIN cit ON cit.job_id = snap.job_id
  `)) as unknown as Array<{ owned_answers: number; target_answers: number }>;
  const r = rows[0] ?? { owned_answers: 0, target_answers: 0 };
  const owned = num(r.owned_answers);
  const target = num(r.target_answers);
  return { ownedAnswers: owned, targetAnswers: target, rate: owned > 0 ? round1((100 * target) / owned) : null };
}

export interface WebsiteTargetHitRateResult {
  hitPrompts: number;      // 지정 타겟 URL 이 인용된 프롬프트 수
  ownedPrompts: number;    // 자사 URL(선언 base ∪ 타겟)이 인용된 프롬프트 수
  measuredPrompts: number; // 스냅샷에 답변이 있는 **등록** 프롬프트 수 (두 카드 공통 분모)
  rate: number | null;      // 타겟 URL 인용률 %, null = 분모 0 (측정 대기 — 0% 와 구분)
  ownedRate: number | null; // 자사 URL 인용률 %, 같은 분모
}

// 프롬프트 기준 인용률 2종 — 웹사이트 전용. 판정 단위가 **프롬프트**라서 답변 단위인
// aggregateWebsiteCitationAccuracy(⑥) 와 분모가 다르다:
//   ⑥              = 타겟 인용 답변 ÷ 자사 인용 답변
//   자사 URL 인용률  = 자사 URL 인용 프롬프트 ÷ 측정 프롬프트   ← 이 함수
//   타겟 URL 인용률  = 타겟 도달 프롬프트   ÷ 측정 프롬프트   ← 이 함수
// 발행 인용 리포트(v1.1/v1.2 본문 KPI)와 같은 산식이라, 화면과 리포트를 그대로
// 대조할 수 있다(2026-08-26 실측: Kia KR 96.00 · Genesis GB 80.65 · IT 71.43 ·
// NL 63.64 · Kia SG 23.00 · PH 50.52 — 6/6 리포트 값과 일치).
// 그 "같은 산식"을 지탱하는 것이 **정확 일치**(`targetMatchSql` = 정규화 후 등치)다.
// 2026-09-17 에 대시보드만 느슨한 일치(쿼리 제거 + `.html` 동치)로 갔다가 2026-09-20
// 철회했다 — 리포트가 정본이고 대시보드가 거기에 맞춘다. 근거 수치는
// `lib/scope/url-match.ts::matchesTargetUrlNorm` 머리 주석.
//
// 매칭은 반드시 **그 프롬프트의 타겟 URL** 과 한다. 사이트 전체 타겟 집합(flat)으로
// 매칭하면 다른 프롬프트의 타겟이 잡힌 것까지 성공으로 세어 부풀려진다(같은 실측에서
// NL 63.64% → 83.33%). ⑥ 가 flat 집합을 쓰는 것과 의도적으로 다르다.
//
// ── GGMD-61 (2026-09-17) ─────────────────────────────────────────────────────
// ① 두 지표를 **한 문장**에 담는다. 스펙 수용 기준 A1(두 카드의 "측정 프롬프트" 가
//    모든 필터 조합에서 같을 것)을 코드 구조로 보장하는 가장 싼 방법이다 — 같은
//    `snap`·같은 `wp`·같은 서브쿼리 골격을 쓰므로 두 값이 갈라질 자리가 없다.
// ② 분모가 "타겟 보유 프롬프트" → **등록 프롬프트 전체**(타겟 유무 무관)로 바뀌었다
//    (제품 결정 4). 미등록 프롬프트는 여전히 제외 — 웹사이트 화면의 모수는
//    `website_prompts` 에 등록된 유닛이다.
// ③ 타겟 일치는 `targetMatchSql`. 2026-09-20 제품 결정으로 **리포트와 같은 정확
//    일치**(정규화 후 등치)로 되돌렸다 — GGMD-61 의 완화(결정 2)는 철회.
// ④ 자사 판정은 ⑤ 와 같은 `ownedBasePrefixClause` 를 **base 정규화 입력**으로 건다.
//    ⑥ 의 `ownedOnN`(추적 정규화 입력)을 복사하면 base 와 다른 값을 비교하게 된다.
//    여기에 "타겟 ⊂ 자사"(2026-09-06 결정, websiteTargetOwnedClause 주석)를 **그
//    프롬프트의 타겟**으로 건다 — flat 집합이 아니라 per-prompt 이므로 A2
//    (타겟 인용 프롬프트 ≤ 자사 인용 프롬프트)가 술어 포함관계로 성립한다.
//
// ── 유닛 판정(키 on) ────────────────────────────────────────────────────────
// 자사 술어가 `websiteUnitOwnedTargetClause`(리포트 정본)로 바뀌고, 유닛은 **다른 자리와
// 같은 `wup`** 에서 온다. 종전에는 이 카드만 `wp LEFT JOIN wu` + `bool_or` 로 **유닛들의
// OR** 을 취해 규칙이 둘이었다(2026-09-20 검증 C 지적 2). `target_hit`(타겟 URL 인용률의
// 분자)는 그대로 **그 프롬프트의 타겟**이다 — 리포트의 `target_hit` 도 per-prompt 다
// (extract-citation-data.mts:100 `c3.tn = NORM_T(lp.target_url)`).
// 최종 `owned_prompts` 의 `OR pm.target_hit` 는 남겨 둔다: 그 프롬프트의 타겟은 정의상
// 그 유닛 tset 의 원소라 **이미 포함**이고(중복 항), 지우면 off 문장이 바뀐다.
export async function aggregateWebsiteTargetHitRate(
  filters: StandardFilters,
  scopeProjectIds: string[],
  ownedBasePrefixes: string[] = [],
  ownedSiblingUniverse?: string[],
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<WebsiteTargetHitRateResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await ensureWebsiteOwnedUnit();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const empty: WebsiteTargetHitRateResult = {
    hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null,
  };
  if (scopeProjectIds.length === 0) return empty;
  const db = getDb();
  const W = answerWhere(filters, scopeProjectIds, { hiddenFamily: "citations" });
  // 유닛 단위 판정(키 on) — 자사 술어가 **그 프롬프트의 유닛 base** 로 바뀐다.
  // 키 off 면 `units` 가 비어 아래 SQL 이 글자 그대로 종전과 같다.
  const units = websiteUnitsIfEnabled(ownedUnits);
  // 선언 base 가 없으면 ⑥ 폴백과 같은 호스트 정규식(판정 공집합 방지).
  const ownedOnBase = ownedBasePrefixes.length
    ? ownedBasePrefixClause(sql`base`, ownedBasePrefixes, ownedSiblingUniverse)
    : sql`nullif(dk, '') ~* ${OWNED}`;
  // 인용 ↔ 그 프롬프트의 타겟. `cit`/`wp` 는 아래 서브쿼리 두 곳에서 글자 그대로 같다.
  const targetHit = targetMatchSql(sql`cit.cnorm`, sql`wp.turl`);

  const rows = (await db.execute(sql`
    WITH ${units ? sql`${websiteUnitPromptCtes(units)},
    ` : sql``}snap AS MATERIALIZED (
      SELECT a.job_id, a.prompt_id FROM scope_answers a
      WHERE ${W} AND a.prompt_id IS NOT NULL
    ),
    wp AS MATERIALIZED (
      -- 등록 프롬프트 ↔ 그 프롬프트의 지정 타겟(정규화). 인용 URL 과 같은 정규화를 써야
      -- http/https·www·끝 슬래시·트래킹 파라미터 차이로 도달을 놓치지 않는다.
      -- 타겟이 빈 유닛도 **분모에는 남는다**(결정 4) — 빈 타겟은 NULL 로 만들어
      -- 비교식이 NULL(=미도달)로 접히게 한다.
      SELECT wp.scope_prompt_id AS prompt_id,
        nullif(${citationTrackedNormSql(sql`coalesce(wp.target_url, '')`)}, '') AS turl
      FROM website_prompts wp
      JOIN website_sites ws ON ws.id = wp.site_id
      WHERE ws.scope_project_id::text = ${textAnyParam(scopeProjectIds)}
    ),
    -- 정규화는 DISTINCT url 당 1회. 종전에는 cit 가 인라인되며 정규화 식이 해시
    -- 조인 조건으로 올라가, snap(2.7만 job) 으로 좁히지 못하고 scope_citations
    -- 전체 294만행에 regex 7단을 돌렸다 (2026-09-03 프로덕션 EXPLAIN: 73.9s 중 72.9s).
    c2 AS MATERIALIZED (
      SELECT snap.prompt_id, c.url, coalesce(c.domain, '') AS dk${
        citationNormProjection(sql`c.url_norm`, "nk")}${
        citationNormProjection(sql`c.url_base_norm`, "bk")}
      FROM scope_citations c JOIN snap ON snap.job_id = c.job_id
      WHERE c.url IS NOT NULL
    ),
    un AS MATERIALIZED (${
      citationNormColumnsAvailable()
        ? sql`
      SELECT url, dk, coalesce(nk, citation_url_norm(url)) AS cnorm,
        coalesce(bk, citation_url_base_norm(url)) AS base
      FROM (SELECT url, dk, max(nk) AS nk, max(bk) AS bk FROM c2 GROUP BY url, dk) d`
        : sql`
      SELECT url, dk, ${citationTrackedNormSql(sql`url`)} AS cnorm,
        ${citationBaseNormSql(sql`url`)} AS base
      FROM (SELECT DISTINCT url, dk FROM c2) d`
    }
    ),
    -- 자사 판정도 DISTINCT (url, domain) 당 1회 — ⑥ 의 ub 와 같은 구조다.
    ub AS MATERIALIZED (
      SELECT url, dk, cnorm, ${units ? sql`base` : sql`${ownedOnBase} AS owned_base`} FROM un
    ),
    cit AS (
      SELECT c2.prompt_id, ub.cnorm, ${units ? sql`ub.base` : sql`ub.owned_base`}
      FROM c2 JOIN ub ON ub.url = c2.url AND ub.dk = c2.dk
    ),
    -- 프롬프트 단위로 한 번에 접는다. 타겟 일치식은 **행당 1회**만 평가된다 —
    -- 분자 두 개가 각자 cit ⋈ wp 를 돌면 같은 식이 두 번 평가된다(실측 5.2s → 4.1s).
    -- 자사는 여기서 base 판정만 접고, "타겟 ⊂ 자사" 는 아래에서 OR 로 얹는다:
    -- bool_or(a OR b) = bool_or(a) OR bool_or(b) 이므로 결과가 같다.
    pm AS MATERIALIZED (
      SELECT cit.prompt_id,
        bool_or(${targetHit}) AS target_hit,
        bool_or(${
          units
            ? websiteUnitOwnedTargetClause(sql`cit.base`, sql`cit.cnorm`, "wup")
            : sql`cit.owned_base`
        }) AS owned_base_hit
      FROM cit JOIN wp ON wp.prompt_id = cit.prompt_id::text${
        units ? websiteUnitPromptJoin(sql`cit.prompt_id`) : sql``}
      GROUP BY cit.prompt_id
    )
    SELECT
      (SELECT count(DISTINCT snap.prompt_id) FROM snap
        JOIN wp ON wp.prompt_id = snap.prompt_id::text)::int AS measured_prompts,
      (SELECT count(*) FROM pm WHERE pm.target_hit)::int AS hit_prompts,
      (SELECT count(*) FROM pm WHERE pm.owned_base_hit OR pm.target_hit)::int AS owned_prompts
  `)) as unknown as Array<{
    measured_prompts: number; hit_prompts: number; owned_prompts: number;
  }>;

  const r = rows[0] ?? { measured_prompts: 0, hit_prompts: 0, owned_prompts: 0 };
  const measured = num(r.measured_prompts);
  const hit = num(r.hit_prompts);
  const owned = num(r.owned_prompts);
  return {
    hitPrompts: hit,
    ownedPrompts: owned,
    measuredPrompts: measured,
    rate: measured > 0 ? round1((100 * hit) / measured) : null,
    ownedRate: measured > 0 ? round1((100 * owned) / measured) : null,
  };
}

/**
 * 자사·타겟 URL 인용률(GGMD-61)의 **job 단위 플래그**: 사실표(`summary_url_hits`, 0081)
 * 생성기가 굳히는 값. 바로 위 `aggregateWebsiteTargetHitRate` 의 **유닛 판정 경로**와
 * 같은 판정을 job 그레인으로 낸다(그 함수는 같은 판정을 프롬프트로 접는다).
 *
 * 출력 열: `job_id uuid, prompt_id uuid, registered bool, owned_hit bool, target_hit bool`.
 *   registered  그 job 의 프롬프트가 `projectIds` 사이트의 `website_prompts` 에 등록돼 있다
 *               (= 위 함수의 `snap ⋈ wp`, 두 카드 공통 분모의 자격)
 *   target_hit  그 job 의 인용 중 하나가 **그 프롬프트의** 타겟 URL 과 정확 일치
 *               (위 함수 `pm.target_hit` 와 같은 `targetMatchSql(cit.cnorm, wp.turl)`)
 *   owned_hit   유닛 자사 판정(`websiteUnitOwnedTargetClause`) 또는 target_hit
 *               (위 함수 `pm.owned_base_hit OR pm.target_hit` 와 같은 식)
 * 미등록 프롬프트의 job 은 `registered=false` 이고 두 플래그도 false 다: 위 함수에서
 * 그 프롬프트는 `cit ⋈ wp` 에 안 붙어 어느 분자에도 못 들어간다.
 *
 * 프롬프트 단위 값은 리더가 `bool_or` 로 복원한다. `bool_or` 는 job 들로 먼저 접고 다시
 * 접어도 같다(결합법칙): 그래서 job 그레인에 굳혀도 필터(엔진·국가·언어)가 고른 job
 * 부분집합마다 위 함수와 같은 프롬프트 판정이 나온다.
 *
 * ⚠️ **유닛 판정 전용**이다. flat 판정(키 `X.websiteOwnedUnit` off)의 자사 base 는 화면
 *    필터(언어·국가)의 함수라 생성 시점에 굳힐 수 없다: 그 경우 호출부는 이 사실표를
 *    쓰지 않고 위 함수(라이브)로 간다.
 * ⚠️ 판정 식을 옮겨 적지 않았다: 정규화(`citationNormProjection`·`citation_url_norm`
 *    폴백), 타겟 일치(`targetMatchSql`), 유닛 판정(`websiteUnitOwnedTargetClause` + `wup`)
 *    모두 위 함수와 같은 빌더다. 위 함수의 유닛 경로를 바꾸면 이 함수도 같이 고친다 :
 *    `lib/scope/server.website-url-rates-summary.test.ts`("판정 한 벌") 가 두 문장의 판정 조각이
 *    같은지 대조하고, `summary-url-hits.pglite.test.ts` 가 실행으로 판정을 고정한다.
 *
 * `jobs` 는 `(job_id uuid, prompt_id uuid)` 를 내는 SELECT 다(생성기 = 굳힌
 * `summary_cycle_jobs`). `wup` 은 그 job 들의 프롬프트로 좁힌다: 좁히지 않으면 인용 행 ×
 * 함대 전체 `wup` Nested Loop 가 잡힐 수 있다(`websiteUnitPromptCtes` 의 `promptScope` 주석).
 */
export function websitePromptUrlHitJobFlagsSql(args: {
  jobs: SQL;
  projectIds: string[];
  units: readonly WebsiteOwnedUnit[];
}): SQL {
  const targetHit = targetMatchSql(sql`cit.cnorm`, sql`wp.turl`);
  return sql`
    WITH snap AS MATERIALIZED (${args.jobs}),
    ${websiteUnitPromptCtes(args.units, sql`SELECT DISTINCT prompt_id::text FROM snap`)},
    wp AS MATERIALIZED (
      SELECT wp.scope_prompt_id AS prompt_id,
        nullif(${citationTrackedNormSql(sql`coalesce(wp.target_url, '')`)}, '') AS turl
      FROM website_prompts wp
      JOIN website_sites ws ON ws.id = wp.site_id
      WHERE ws.scope_project_id::text = ${textAnyParam(args.projectIds)}
        AND wp.scope_prompt_id IN (SELECT DISTINCT prompt_id::text FROM snap)
    ),
    c2 AS MATERIALIZED (
      SELECT snap.job_id, snap.prompt_id, c.url, coalesce(c.domain, '') AS dk${
        citationNormProjection(sql`c.url_norm`, "nk")}${
        citationNormProjection(sql`c.url_base_norm`, "bk")}
      FROM scope_citations c JOIN snap ON snap.job_id = c.job_id
      WHERE c.url IS NOT NULL
    ),
    un AS MATERIALIZED (${
      citationNormColumnsAvailable()
        ? sql`
      SELECT url, dk, coalesce(nk, citation_url_norm(url)) AS cnorm,
        coalesce(bk, citation_url_base_norm(url)) AS base
      FROM (SELECT url, dk, max(nk) AS nk, max(bk) AS bk FROM c2 GROUP BY url, dk) d`
        : sql`
      SELECT url, dk, ${citationTrackedNormSql(sql`url`)} AS cnorm,
        ${citationBaseNormSql(sql`url`)} AS base
      FROM (SELECT DISTINCT url, dk FROM c2) d`
    }
    ),
    cit AS (
      SELECT c2.job_id, c2.prompt_id, un.cnorm, un.base
      FROM c2 JOIN un ON un.url = c2.url AND un.dk = c2.dk
    ),
    jm AS MATERIALIZED (
      SELECT cit.job_id,
        bool_or(${targetHit}) AS target_hit,
        bool_or(${websiteUnitOwnedTargetClause(sql`cit.base`, sql`cit.cnorm`, "wup")}) AS owned_base_hit
      FROM cit JOIN wp ON wp.prompt_id = cit.prompt_id::text${websiteUnitPromptJoin(sql`cit.prompt_id`)}
      GROUP BY cit.job_id
    )
    SELECT snap.job_id, snap.prompt_id,
      EXISTS (SELECT 1 FROM wp WHERE wp.prompt_id = snap.prompt_id::text) AS registered,
      COALESCE(jm.owned_base_hit, false) OR COALESCE(jm.target_hit, false) AS owned_hit,
      COALESCE(jm.target_hit, false) AS target_hit
    FROM snap LEFT JOIN jm ON jm.job_id = snap.job_id`;
}

// 스냅샷(aggregateWebsiteCitationAccuracy)과 같은 자사 판정을 써야 추이와 타일이
// 어긋나지 않는다 — ownedBasePrefixes 인자 주석 참조(2026-09-01).
export async function aggregateWebsiteCitationAccuracyTrend(
  filters: StandardFilters,
  unit: BucketUnit,
  scopeProjectIds: string[],
  ownedBasePrefixes: string[] = [],
  ownedSiblingUniverse?: string[],
  // 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`). 생략·빈 배열 = 종전 flat.
  ownedUnits?: readonly WebsiteOwnedUnit[],
): Promise<CitationAccuracyTrendBucket[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await ensureWebsiteOwnedUnitFor(ownedUnits);
  const units = websiteUnitsIfEnabled(ownedUnits);
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (scopeProjectIds.length === 0) return [];
  const db = getDb();
  const W = answerWhere(filters, scopeProjectIds, { allRuns: true, hiddenFamily: "citations" });
  const field = BUCKET_FIELD[unit] ?? "week";
  // 버킷별 스냅샷 (2026-09-01) — 버킷 안에서 셀(프롬프트×엔진×지역)당 최신 답변
  // 1개만. 카드(스냅샷)와 같은 단위여야 같은 화면의 두 숫자가 어긋나지 않는다.
  // DISTINCT ON / ORDER BY 는 문자적으로 같은 식이어야 하므로 field 를 리터럴로 굳힌다.
  const anchorOn = anchorAxisKnownEnabled();
  // 스냅샷 CTE 안은 `a.` 별칭이다 — 같은 단위, 다른 별칭(세션 TZ 의존 형태 유지).
  const ansBucket = periodBucketSql(field, sql`a.measured_at`, { anchorAxis: anchorOn });
  // 바깥 SELECT 는 `snap` 을 본다. 앵커 축에서는 `ca` 가 CTE 안에만 있으므로 버킷을
  // **CTE 에서 투영**해 바깥이 그 컬럼을 읽는다(투영 누락은 런타임 42703 이다).
  const bkt = anchorOn
    ? sql.raw("snap.bucket")
    : sessionTzBucketSql(field, sql`snap.measured_at`);
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. 버킷이 키 맨 앞인 사본.
  // 앵커 축이면 키 선두가 주가 아니라 **회차**다(`trendCellKeys` 머리 주석).
  const ansKeys = anchorOn
    ? anchorCellSnapshotKeys({ alias: "a." })
    : cellSnapshotKeys({ alias: "a.", bucket: ansBucket, bucketFirst: true });
  // 뷰 앵커 전 회차 제외 — excludeHiddenCycleRuns 머리 주석. ⑤(위 KPI 추이)와
  // 같은 화면에 그려지므로 같은 모수를 봐야 한다. 계열 = **인용**(0071).
  const notHidden = await excludeHiddenCycleRuns(sql`a.run_id`, "citation", sql`a.job_id`);

  // 정규화·판정은 DISTINCT (url, domain) 당 1회 — websiteCitationJudgmentCtes 참조.
  // `snap` 은 두 번 참조되므로(c2 조인 · 최종 LEFT JOIN) MATERIALIZED 로 굳힌다.
  const rows = (await db.execute(sql`
    WITH snap AS MATERIALIZED (
      SELECT DISTINCT ON (
        ${ansKeys.all}
      ) a.job_id, a.measured_at${anchorOn ? sql`, ${ansBucket} AS bucket` : sql``}${
        units ? sql`, a.prompt_id` : sql``}
      FROM scope_answers a${anchorOn ? anchorJoinSql(sql.raw("a.job_id")) : sql``}
      WHERE ${W} AND a.measured_at IS NOT NULL AND ${trendWindowFloor(
        undefined, undefined, anchorOn, false, trendFloorDays(unit),
      )} AND ${notHidden}
      ORDER BY ${anchorOn ? anchorRoundDateSql() : ansBucket},
        ${ansKeys.cells}, ${ansKeys.tieBreak}
    ),
    target_set AS MATERIALIZED (${websiteTargetSetSelect(scopeProjectIds, filters)}),
    ${websiteCitationJudgmentCtes(ownedBasePrefixes, ownedSiblingUniverse, units)}
    SELECT ${bkt} AS bucket,
      count(*) FILTER (WHERE cit.owned)::int AS owned_answers,
      count(*) FILTER (WHERE cit.owned AND cit.target)::int AS target_answers,
      count(DISTINCT date_trunc('day', snap.measured_at))::int AS measured_days,
      min(snap.measured_at) AS first_at, max(snap.measured_at) AS last_at
    FROM snap LEFT JOIN cit ON cit.job_id = snap.job_id
    GROUP BY bucket ORDER BY bucket
  `)) as unknown as Array<{
    bucket: string; owned_answers: number; target_answers: number;
    measured_days: number; first_at: string | null; last_at: string | null;
  }>;

  return rows.map((r) => {
    const ownedAnswers = num(r.owned_answers);
    const targetAnswers = num(r.target_answers);
    return {
      bucketStart: new Date(r.bucket).toISOString().slice(0, 10),
      ownedAnswers,
      targetAnswers,
      rate: ownedAnswers > 0 ? round1((100 * targetAnswers) / ownedAnswers) : null,
      measuredDays: num(r.measured_days),
      firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
      lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    };
  });
}

// ─── ACR (AI's Choice Rate) — scope_acr_rollups 집계 ─────────────────────
// scope의 2턴 선택 측정(prompt kind='acr') prompt-run 롤업을 SQL로 집계한다.
//
// ⚠️ scope 원자료 의미론 (2026-07-08 실데이터 검증으로 확정):
//  - appearance_count = turn1 "언급 횟수" 합 (한 반복에서 여러 번 셀 수 있어
//    반복 수를 초과함 — 실측 최대 75/10). scope 자체 appearance_rate(7.5)와
//    acr(choice÷appearance) 필드도 같은 분모라 비율 지표로 부적합 → 미러
//    컬럼은 보존하되 화면 지표로 쓰지 않는다.
//  - choice_count ≤ valid_acr_iterations (실측 위반 0건) → 신뢰 가능.
// 따라서 모든 비율 지표는 "유효 반복(valid_acr_iterations)"을 분모로 자체
// 산출한다 (0~100% 보장):
//  - Top1 ACR(선택 점유율) = choice ÷ 전체 유효 반복
//  - 후보군 포함율(coverage) = 등장한 셀 수 ÷ 전체 셀 수
//  - 차종 전환율 = choice ÷ (그 차종이 등장한 셀들의 유효 반복 합)
// "최신 주기" 선택은 (prompt × engine × region) 셀별 최신 prompt-run 1개 —
// answerWhere의 latestAnswerIds와 같은 dedup 규칙을 rollup에 적용.
// 엔티티 표시명이 sync에서 미해소(null)인 행은 미러 전체 이름 사전
// (ROLLUP_NAMES: scope_mentions의 Brand 행)으로 폴백 해소 — 조용한 탈락 방지
// (2026-07-08 실측: brand-null 24행).

export interface AcrBrandAgg {
  brand: string;
  isOurs: boolean;
  choiceCount: number; // 최종 선택된 반복 수
  appearanceCount: number; // turn1 언급 수 (강도 지표 — 비율 아님)
  choiceShare: number | null; // % = choice ÷ 전체 유효 반복 (Top1 ACR)
  coverage: number | null; // % = 등장 셀 ÷ 전체 셀 (후보군 포함율)
}

export interface AcrTrendBucket {
  date: string; // 일 단위 (YYYY-MM-DD) — 기획 확정 레이아웃의 "일별 선택률"
  series: Record<string, number | null>; // brand → 선택 점유율 % (choice ÷ 당일 유효 반복)
}

export interface AcrBattleRow {
  promptId: string;
  promptText: string | null;
  cells: {
    engine: string;
    winner: string | null; // null = no single choice
    winnerIsOurs: boolean;
    choiceCount: number;
  }[];
}

export interface AcrModelConversionRow {
  brand: string | null; // 소속 브랜드 표시명
  model: string; // product 엔티티 표시명
  isOurs: boolean;
  conversionRate: number | null; // % = choice ÷ 등장 셀들의 유효 반복 합
  shortlistCount: number; // 등장 셀 수 (후보로 등장한 측정 셀)
  top1Count: number; // choice (최종 선택 반복 수)
}

// 테리토리 맵(기획 확정 레이아웃의 "모델별 점유 맵") — 시트 = 지역 × 엔진,
// 행 = 프롬프트, 셀 = 반복 validAcr회 중 브랜드별 선택 횟수 분포.
// 반복의 "순서"는 공개 API에 없으므로(rollup만 노출) 분포로 그린다.
export interface AcrTerritorySheet {
  region: string | null;
  engine: string;
  rows: {
    promptId: string;
    promptText: string | null;
    validAcr: number;
    entries: { brand: string; choice: number; isOurs: boolean }[];
  }[];
}

export interface StandardAcr {
  measured: boolean; // rollup이 하나라도 있는가 (없으면 측정 대기 상태)
  brands: AcrBrandAgg[];
  /**
   * 관점 당사(합친 당사) 합계 — KPI 카드 원천(API 원천만). 브랜드 행은 브랜드별·상위 12 라 다중 관점(HMG)은 첫 당사만,
   * 상한 밖 당사는 값이 없었다. 없으면(legacy·옛 캐시) 카드는 첫 당사 브랜드 행을 읽는다.
   */
  own?: Omit<AcrBrandAgg, "brand" | "isOurs">;
  trend: AcrTrendBucket[];
  battle: AcrBattleRow[];
  modelConversion: AcrModelConversionRow[];
  territory: AcrTerritorySheet[];
  totals: { promptRuns: number; prompts: number; iterations: number; engines: string[] };
}

const EMPTY_STANDARD_ACR: StandardAcr = {
  measured: false,
  brands: [],
  trend: [],
  battle: [],
  modelConversion: [],
  territory: [],
  totals: { promptRuns: 0, prompts: 0, iterations: 0, engines: [] },
};

// scope_acr_rollups (alias `x`) 공통 WHERE — answerWhere의 축 중 rollup에
// 의미 있는 것만: region/engine 직접 컬럼, 카탈로그 축(funnel/brand/listType/
// depth/brandPresence)은 prompts↔scope_prompt_id 조인, 날짜는 measured_at.
// exported for tests (SQL 텍스트 검증) — 런타임 호출부는 이 파일 내부뿐.
export function acrWhere(f: StandardFilters): SQL {
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
  const catalogIn = (col: string, vals: string[]) =>
    sql`x.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE ${sql.raw(col)} IN (${inList(vals)}) AND scope_prompt_id IS NOT NULL)`;
  const conds: SQL[] = [sql`true`];
  const rootProjectId = addressableRootProjectId();
  const runScope = rootRunScopeSql("", rootProjectId);
  // 기간 축 = 회차 앵커 (2026-09-16). ACR 롤업도 run 단위라 같은 준-조인으로 푼다.
  //
  // 기간이 걸리면 `cumulativeRunWindow` 가 **run 스코프를 자기 안에 접어** 들고
  // 가므로, 위에 같은 `project_id` semi-join 을 또 두지 않는다 — 2026-09-16 적대적
  // 검증에서 2벌이 생기는 것이 지적됐다(결과 동일·비용 미미였지만, 답변 경로에
  // 세운 "semi-join 을 늘리지 않는다" 규약이 ACR 에서만 깨져 있었다).
  // 기간이 없으면 종전 형태 그대로다(SQL 바이트 동일).
  // 앵커 축(옵트인) — ACR 롤업에는 `job_id` 가 없어 **run 축**으로 붙인다
  // (`anchorRunIdIn` 머리 주석의 성립 조건: run 당 `round_date` 하나).
  // ⚠️ 계열은 **지면 단위**다(D1·N1). ACR 지면의 달력도 `'all'` 이므로 여기서 명시한다 —
  //    기본값(`'mentions'`)에 두면 `hidden_scope='citations'` 회차가 최신일 때 달력은 그
  //    날짜를 지우는데 ACR 데이터는 그 회차를 기준 회차로 잡는다(Overview 에서 닫은 것과
  //    똑같은 형태). ACR 롤업은 언급·인용을 한 덩어리로 싣는 지면 카드다.
  const acrAnchor = anchorRunClause(
    f,
    sql`x.run_id`,
    anchorScopeForRoot(rootProjectId),
    "all",
  );
  if (acrAnchor) {
    if (rootProjectId) {
      conds.push(sql`x.run_id IN (SELECT run_id FROM scope_runs WHERE ${runScope})`);
    }
    conds.push(acrAnchor);
  } else if (f.dateFrom || f.dateTo) {
    conds.push(cumulativeRunWindow(f, sql`x.run_id`, sql`x.measured_at`, runScope));
  } else if (rootProjectId) {
    conds.push(sql`x.run_id IN (SELECT run_id FROM scope_runs WHERE ${runScope})`);
  }
  if (f.region?.length) conds.push(sql`x.region IN (${inList(f.region)})`);
  if (f.engine?.length) conds.push(sql`x.target IN (${inList(f.engine)})`);
  if (f.funnelStage?.length) conds.push(catalogIn("funnel_stage", f.funnelStage));
  if (f.brand?.length) conds.push(catalogIn("brand", f.brand));
  if (f.brandPresence?.length) {
    const pred = brandPresencePredicate(f.brandPresence);
    if (pred) {
      conds.push(
        sql`x.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE ${pred} AND scope_prompt_id IS NOT NULL)`,
      );
    }
  }
  if (f.listType?.length) conds.push(catalogIn("list_type", f.listType));
  if (f.depth1?.length) conds.push(catalogIn("depth1", f.depth1));
  if (f.depth2?.length) conds.push(catalogIn("depth2", f.depth2));
  if (f.depth3?.length) conds.push(catalogIn("depth3", f.depth3));
  // 언어 축 (2026-09-03) — ACR 은 scope_acr_rollups 를 읽는 **독립 술어 빌더**라
  // promptAxisPreds 를 타지 않는다. 그래서 표준 language 축을 이 화면에 노출하기
  // 전에 여기서 같은 규칙(langAxisPred standard = scope_prompts.lang, upper 비교)을
  // 먼저 붙인다. 순서를 뒤집으면 "축은 켜졌는데 데이터가 안 좁혀지는" 죽은 필터가
  // 되고, 그것이 2026-08-25 사고의 형태다 (이 파일 머리의 "무시하는 축을 띄우면
  // 필터 스키마와 데이터 스키마가 어긋난다" 원칙과 동일).
  if (f.lang?.length) conds.push(langAxisPred(f.lang, sql`x.prompt_id`, "standard"));
  return sql.join(conds, sql` AND `);
}

// (prompt × engine × region) 셀별 최신 prompt-run — 스냅샷 dedup 규칙.
//
// 2026-09-16 제품 확정 — 기간 의미론을 답변 경로와 통일한다. 종전 ACR 은 기간을
// 걸어도 "그 기간 안의 **최신** 1건"(= 기간말 스냅샷)이라, 달력을 넓혀도 셀 수가
// 거의 안 늘었다(라이브 실측: 2026-08-19~09-15 셀 3,129 vs 기본 4,054 — 창을
// 넓혔는데 오히려 적다). 이제 기간이 걸리면 그 기간의 prompt-run 을 **전부** 센다.
//
// ⚠️ ACR 은 고객 계약 지표다. 같은 창(2026-08-19~09-15)에서 모집단이
// **3,129 → 11,676 (×3.7)** 로 바뀐다 — 모든 ACR 비율의 공통 분모(`aggregateAcr
// FromMirror` Q1)가 여기서 나오므로, 반복 측정된 셀의 가중치가 커진다.
// 기간 미지정(기본)은 종전 그대로 셀당 최신 1건이다(실측 4,054, 불변).
// exported for tests (SQL 텍스트 검증) — 런타임 호출부는 이 파일 내부뿐
// (`answerWhere`·`detailAnswerWhere`·`snapshotRunFilter` 와 같은 관례).
export function latestAcrPromptRunIds(f: StandardFilters): SQL {
  const rows = sql`(
      SELECT DISTINCT prompt_run_id, run_id, prompt_id, target, region, measured_at
      FROM scope_acr_rollups
    ) x`;
  if (cumulativeMode(f)) {
    return sql`(SELECT DISTINCT x.prompt_run_id FROM ${rows} WHERE ${acrWhere(f)})`;
  }
  // dedup 키 정본 — `lib/period/cell-snapshot.ts`. 투영이 job_id 가 아니라
  // prompt_run_id 인 것만 다르고, 셀 키·동점 규칙은 답변 경로와 같다.
  const k = cellSnapshotKeys({ alias: "x." });
  return sql`(
    SELECT DISTINCT ON (${k.all}) x.prompt_run_id
    FROM ${rows}
    WHERE ${acrWhere(f)}
    ORDER BY ${k.all}, ${k.tieBreak}
  )`;
}

// 표시명 폴백 — sync가 못 푼 entity_id를 미러 전체 Brand 이름 사전으로 해소.
const ACR_BRAND_NAME = sql`COALESCE(x.brand, n.brand)`;
const ACR_NAME_JOIN = sql`LEFT JOIN ${ROLLUP_NAMES} n ON n.entity_id = x.entity_id`;
// 당사 판정 — brand_rollup_entity_id(정상 경로) 또는 entity_id(rollup 미해소
// 행 폴백)가 tracked 집합에 있으면 당사.
// 2026-08-28: rollup id 는 언급 계열과 같은 canonRollupSql 로 접은 뒤 비교한다 —
// ACR 만 raw 로 남으면 같은 브랜드가 ACR 에서만 '경쟁'으로 잡힌다.
function acrIsOurs(f: StandardFilters, tracked: SQL): SQL {
  return sql`max((${canonRollupSql(f, "x")} IN ${tracked} OR x.entity_id IN ${tracked})::int)`;
}

export async function aggregateAcrFromMirror(
  filters: StandardFilters = {},
): Promise<StandardAcr> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const latest = latestAcrPromptRunIds(filters);
  const tracked = trackedRollupIn(filters);

  // Q1 — 총량 (prompt-run=셀 단위 dedup): 모든 비율 지표의 공통 분모.
  const totalRows = (await db.execute(sql`
    SELECT count(*)::int AS prompt_runs,
      count(DISTINCT prompt_id)::int AS prompts,
      COALESCE(sum(vacr), 0)::int AS iterations,
      array_agg(DISTINCT target) AS engines
    FROM (
      SELECT x.prompt_run_id, min(x.prompt_id::text) AS prompt_id,
        min(x.target) AS target, max(x.valid_acr_iterations) AS vacr
      FROM scope_acr_rollups x
      WHERE x.prompt_run_id IN ${latest}
      GROUP BY x.prompt_run_id
    ) pr
  `)) as unknown as Array<{
    prompt_runs: number; prompts: number; iterations: number; engines: string[] | null;
  }>;
  const totals = {
    promptRuns: num(totalRows[0]?.prompt_runs),
    prompts: num(totalRows[0]?.prompts),
    iterations: num(totalRows[0]?.iterations),
    engines: (totalRows[0]?.engines ?? []).filter(Boolean),
  };
  if (totals.promptRuns === 0) return EMPTY_STANDARD_ACR;

  // Q2 — 브랜드 레벨: 선택 수·언급 수·등장 셀 수 (비율은 JS에서 공통 분모로).
  const brandRows = (await db.execute(sql`
    SELECT ${ACR_BRAND_NAME} AS brand,
      ${acrIsOurs(filters, tracked)} AS is_ours,
      sum(x.choice_count)::int AS choice,
      sum(x.appearance_count)::int AS appearance,
      count(DISTINCT x.prompt_run_id)::int AS cells
    FROM scope_acr_rollups x ${ACR_NAME_JOIN}
    WHERE x.prompt_run_id IN ${latest}
      AND x.rollup_level = 'brand' AND ${ACR_BRAND_NAME} IS NOT NULL
      AND ${excludeNonCompetitorBrandsSql(ACR_BRAND_NAME, sql`x.brand`)}
    GROUP BY ${ACR_BRAND_NAME}
    ORDER BY sum(x.choice_count) DESC, count(DISTINCT x.prompt_run_id) DESC
    LIMIT 12
  `)) as unknown as Array<{
    brand: string; is_ours: number; choice: number; appearance: number; cells: number;
  }>;
  const pct = (numer: number, denom: number): number | null =>
    denom > 0 ? round1((100 * numer) / denom) : null;
  const brands: AcrBrandAgg[] = brandRows.map((r) => ({
    brand: r.brand,
    isOurs: r.is_ours === 1,
    choiceCount: num(r.choice),
    appearanceCount: num(r.appearance),
    choiceShare: pct(num(r.choice), totals.iterations),
    coverage: pct(num(r.cells), totals.promptRuns),
  }));

  // Q3 — 일별 선택률 추이. 시리즈 값 = 당일 브랜드 선택 수 ÷ 당일 전체 유효
  // 반복 (Top1 ACR와 같은 공통 분모 정의). 시리즈 = 당사 + 상위 브랜드 5개.
  const topBrands = [
    ...brands.filter((b) => b.isOurs).map((b) => b.brand),
    ...brands.filter((b) => !b.isOurs).map((b) => b.brand),
  ].slice(0, 5);
  let trend: AcrTrendBucket[] = [];
  if (topBrands.length) {
    const inBrands = sql.join(topBrands.map((b) => sql`${b}`), sql`, `);
    // 뷰 앵커 전 회차 제외 — excludeHiddenCycleRuns 머리 주석. **분자(brand_day)와
    // 분모(cells→day_tot)에 같이** 건다. 한쪽만 걸면 그 날의 선택률이 다른 모수로
    // 나뉜다. 실측(2026-09-10): ACR run 2,491 중 418 이 open 회차 귀속이었다.
    // ⚠️ 위 스냅샷 문장들(Q1·Q2·Q4)에는 걸지 않는다 — 카드·배틀 그리드는 "지금 시점
    // 상태"라 추이와 규칙이 다르다(핫픽스 A 가 고정한 범위와 같다).
    // 계열 = **언급**(0071) — ACR(브랜드 선택률)의 입력은 언급이지 인용이 아니다.
    // ACR 은 답변 단위 게이트를 걸 키가 없다 — run 축 앵커 게이트를 넘긴다.
    const notHidden = await excludeHiddenCycleRuns(
      sql`x.run_id`,
      "mention",
      undefined,
      sql`x.run_id`,
    );
    const trendRows = (await db.execute(sql`
      WITH cells AS (
        SELECT x.prompt_run_id, min(x.measured_at) AS mat, max(x.valid_acr_iterations) AS vacr
        FROM scope_acr_rollups x
        WHERE ${acrWhere(filters)} AND x.measured_at IS NOT NULL AND ${notHidden}
        GROUP BY x.prompt_run_id
      ), day_tot AS (
        SELECT date_trunc('day', mat) AS bucket, sum(vacr) AS vacr
        FROM cells GROUP BY 1
      ), brand_day AS (
        SELECT date_trunc('day', x.measured_at) AS bucket, ${ACR_BRAND_NAME} AS brand,
          sum(x.choice_count) AS choice
        FROM scope_acr_rollups x ${ACR_NAME_JOIN}
        WHERE ${acrWhere(filters)} AND x.rollup_level = 'brand'
          AND ${ACR_BRAND_NAME} IN (${inBrands}) AND x.measured_at IS NOT NULL
          AND ${notHidden}
        GROUP BY 1, 2
      )
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket, b.brand,
        b.choice::int AS choice, t.vacr::int AS vacr
      FROM brand_day b JOIN day_tot t ON t.bucket = b.bucket
      ORDER BY 1
    `)) as unknown as Array<{
      bucket: string; brand: string; choice: number; vacr: number;
    }>;
    const byBucket = new Map<string, Record<string, number | null>>();
    for (const r of trendRows) {
      const series = byBucket.get(r.bucket) ?? {};
      series[r.brand] = pct(num(r.choice), num(r.vacr));
      byBucket.set(r.bucket, series);
    }
    trend = [...byBucket.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, series]) => ({ date, series }));
  }

  // Q4 — 배틀 그리드: (prompt × engine)별 승자 = choice 최다 브랜드.
  // region이 여럿이면 같은 (prompt, engine)의 셀들을 합산해 판정.
  const battleRows = (await db.execute(sql`
    SELECT DISTINCT ON (agg.prompt_id, agg.target)
      agg.prompt_id, agg.target, agg.brand, agg.choice, agg.is_ours
    FROM (
      SELECT x.prompt_id, x.target, ${ACR_BRAND_NAME} AS brand,
        sum(x.choice_count)::int AS choice,
        ${acrIsOurs(filters, tracked)} AS is_ours
      FROM scope_acr_rollups x ${ACR_NAME_JOIN}
      WHERE x.prompt_run_id IN ${latest}
        AND x.rollup_level = 'brand' AND ${ACR_BRAND_NAME} IS NOT NULL
        AND x.prompt_id IS NOT NULL
      GROUP BY x.prompt_id, x.target, ${ACR_BRAND_NAME}
    ) agg
    WHERE agg.choice > 0
    ORDER BY agg.prompt_id, agg.target, agg.choice DESC, agg.brand
  `)) as unknown as Array<{
    prompt_id: string; target: string; brand: string; choice: number; is_ours: number;
  }>;
  const cellRows = (await db.execute(sql`
    SELECT DISTINCT x.prompt_id, x.target, p.text
    FROM scope_acr_rollups x
    LEFT JOIN scope_prompts p ON p.prompt_id = x.prompt_id
    WHERE x.prompt_run_id IN ${latest} AND x.prompt_id IS NOT NULL
  `)) as unknown as Array<{ prompt_id: string; target: string; text: string | null }>;

  const winnerByCell = new Map(
    battleRows.map((r) => [`${r.prompt_id}|${r.target}`, r]),
  );
  const battleByPrompt = new Map<string, AcrBattleRow>();
  for (const c of cellRows) {
    const row =
      battleByPrompt.get(c.prompt_id) ??
      ({ promptId: c.prompt_id, promptText: c.text, cells: [] } as AcrBattleRow);
    const win = winnerByCell.get(`${c.prompt_id}|${c.target}`);
    row.cells.push({
      engine: c.target,
      winner: win?.brand ?? null,
      winnerIsOurs: win?.is_ours === 1,
      choiceCount: num(win?.choice),
    });
    battleByPrompt.set(c.prompt_id, row);
  }
  const battle = [...battleByPrompt.values()]
    .map((r) => ({
      ...r,
      cells: r.cells.sort((a, b) => a.engine.localeCompare(b.engine)),
    }))
    .sort(
      (a, b) =>
        b.cells.reduce((s, c) => s + c.choiceCount, 0) -
        a.cells.reduce((s, c) => s + c.choiceCount, 0),
    )
    // 상한은 페이로드 폭주 방지용 안전장치 — 화면은 상위 N개만 펼치고 나머지는
    // 접어서 노출하므로(acr-live-view) 측정된 프롬프트를 여기서 30개로 자르지
    // 않는다. 표준 루트 실측 67개(2026-07-08)라 200이면 전량 통과.
    .slice(0, 200);

  // Q5 — 차종(product) 전환율: 등장한 셀들의 유효 반복 대비 최종 선택 비율.
  // 분모 = 그 차종 행들이 실린 셀의 valid_acr 합 (행이 (셀×엔티티) 유일이라
  // sum(x.valid_acr_iterations)이 정확히 그 값). choice ≤ vacr per 셀 → ≤100%.
  const modelRows = (await db.execute(sql`
    SELECT x.brand AS model,
      COALESCE(x.parent_brand, pn.brand) AS parent_brand,
      ${acrIsOurs(filters, tracked)} AS is_ours,
      sum(x.choice_count)::int AS choice,
      sum(x.valid_acr_iterations)::int AS cell_vacr,
      count(DISTINCT x.prompt_run_id)::int AS cells
    FROM scope_acr_rollups x
    LEFT JOIN ${ROLLUP_NAMES} pn ON pn.entity_id = x.brand_rollup_entity_id
    WHERE x.prompt_run_id IN ${latest}
      AND x.rollup_level = 'product' AND x.brand IS NOT NULL
    GROUP BY x.brand, COALESCE(x.parent_brand, pn.brand)
    HAVING sum(x.choice_count) > 0
    ORDER BY (sum(x.choice_count)::float / NULLIF(sum(x.valid_acr_iterations), 0)) DESC,
      sum(x.choice_count) DESC
    LIMIT 12
  `)) as unknown as Array<{
    model: string; parent_brand: string | null; is_ours: number;
    choice: number; cell_vacr: number; cells: number;
  }>;
  const modelConversion: AcrModelConversionRow[] = modelRows.map((r) => ({
    brand: r.parent_brand,
    model: r.model,
    isOurs: r.is_ours === 1,
    conversionRate: pct(num(r.choice), num(r.cell_vacr)),
    shortlistCount: num(r.cells),
    top1Count: num(r.choice),
  }));

  // Q6 — 테리토리 맵: 셀(prompt-run)별 브랜드 선택 분포. 시트 = 지역 × 엔진.
  const terrCells = (await db.execute(sql`
    SELECT x.prompt_run_id, x.prompt_id, p.text, x.target, x.region,
      max(x.valid_acr_iterations)::int AS vacr
    FROM scope_acr_rollups x
    LEFT JOIN scope_prompts p ON p.prompt_id = x.prompt_id
    WHERE x.prompt_run_id IN ${latest} AND x.prompt_id IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
  `)) as unknown as Array<{
    prompt_run_id: string; prompt_id: string; text: string | null;
    target: string; region: string | null; vacr: number;
  }>;
  const terrEntries = (await db.execute(sql`
    SELECT x.prompt_run_id, ${ACR_BRAND_NAME} AS brand,
      sum(x.choice_count)::int AS choice,
      ${acrIsOurs(filters, tracked)} AS is_ours
    FROM scope_acr_rollups x ${ACR_NAME_JOIN}
    WHERE x.prompt_run_id IN ${latest}
      AND x.rollup_level = 'brand' AND ${ACR_BRAND_NAME} IS NOT NULL
      AND x.choice_count > 0
    GROUP BY 1, 2
  `)) as unknown as Array<{
    prompt_run_id: string; brand: string; choice: number; is_ours: number;
  }>;
  const entriesByRun = new Map<string, { brand: string; choice: number; isOurs: boolean }[]>();
  for (const e of terrEntries) {
    const list = entriesByRun.get(e.prompt_run_id) ?? [];
    list.push({ brand: e.brand, choice: num(e.choice), isOurs: e.is_ours === 1 });
    entriesByRun.set(e.prompt_run_id, list);
  }
  const sheetMap = new Map<string, AcrTerritorySheet>();
  for (const c of terrCells) {
    const key = `${c.region ?? "—"}|${c.target}`;
    const sheet =
      sheetMap.get(key) ?? { region: c.region, engine: c.target, rows: [] };
    sheet.rows.push({
      promptId: c.prompt_id,
      promptText: c.text,
      validAcr: num(c.vacr),
      entries: (entriesByRun.get(c.prompt_run_id) ?? []).sort((a, b) => b.choice - a.choice),
    });
    sheetMap.set(key, sheet);
  }
  // 시트가 지역×엔진 조합만큼 폭증할 수 있어 셀 수 기준 상위 12개로 캡.
  const territory = [...sheetMap.values()]
    .map((s) => ({ ...s, rows: s.rows.sort((a, b) => (a.promptText ?? "").localeCompare(b.promptText ?? "")) }))
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, 12);

  return { measured: true, brands, trend, battle, modelConversion, territory, totals };
}

// 당사 합계 (renewal ACR, 2026-10-21) — the backend's own_sql on the mirror. The brand
// rows above are per brand and capped at 12, so the legacy cards read the first own row
// only (an HMG admin sees Hyundai alone) and miss own brands below the cap. Same row
// conditions as the brand rows (Q2: brand level, name resolved, non-competitor brands
// excluded); choices add up without overlap (one pick per repetition); a cell counts once
// however many own brands it holds. Ratios use aggregateAcrFromMirror's totals.
export interface AcrOwnCounts {
  choiceCount: number;
  appearanceCount: number;
  cells: number;
}

export async function aggregateAcrOwnFromMirror(
  filters: StandardFilters = {},
): Promise<AcrOwnCounts> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const latest = latestAcrPromptRunIds(filters);
  const tracked = trackedRollupIn(filters);
  const rows = (await db.execute(sql`
    SELECT COALESCE(sum(x.choice_count), 0)::int AS choice,
      COALESCE(sum(x.appearance_count), 0)::int AS appearance,
      count(DISTINCT x.prompt_run_id)::int AS cells
    FROM scope_acr_rollups x ${ACR_NAME_JOIN}
    WHERE x.prompt_run_id IN ${latest}
      AND x.rollup_level = 'brand' AND ${ACR_BRAND_NAME} IS NOT NULL
      AND ${excludeNonCompetitorBrandsSql(ACR_BRAND_NAME, sql`x.brand`)}
      AND (${canonRollupSql(filters, "x")} IN ${tracked} OR x.entity_id IN ${tracked})
  `)) as unknown as Array<{ choice: number; appearance: number; cells: number }>;
  return { choiceCount: num(rows[0]?.choice), appearanceCount: num(rows[0]?.appearance), cells: num(rows[0]?.cells) };
}

// ── 글로벌 프롬프트 수집 기간 (2026-07-23 피드백 ③) ─────────────────────────
// /standard/prompts 헤더의 "수집 기간 · 마지막 수집일". 계정 scope로 좁힌
// 글로벌(루트) 카탈로그 프롬프트의 completed 답변에서 measured_at min/max를
// 읽는다. 프로젝트 id 해소 없이 rootCatalogGate(카탈로그 705 게이트)로 루트를
// 특정하고, 값 격리는 카탈로그와 동일한 brand 규칙(공통 = null/HMG 포함) +
// effectiveScopeCountries(권역→국가 전개, QA 불변식과 동일 소스)로 지킨다.

export interface StandardCollectionDates {
  firstMeasuredAt: Date | null;
  lastMeasuredAt: Date | null;
}

export async function standardCollectionDates(
  scope: AllowedScope | null | undefined,
): Promise<StandardCollectionDates> {
  // default-deny 가 먼저다 — 권한 없는 호출이 DB 왕복(프로브)을 만들지 않게.
  if (!scope) throw new UnauthorizedError(); // listStandardCatalogScoped와 동일
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  const db = getDb();
  const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

  const conds: SQL[] = [
    sql`a.status = 'completed'`,
    sql`a.measured_at IS NOT NULL`,
  ];
  if (!scope.all && scope.brands?.length) {
    conds.push(
      sql`a.prompt_id IN (
        SELECT scope_prompt_id FROM prompts
        WHERE project_id = ${STANDARD_ROOT_PROJECT_ID}
          AND scope_prompt_id IS NOT NULL
          AND (brand IN (${inList(scope.brands)}) OR brand IS NULL OR brand = ${UMBRELLA_BRAND})
      )`,
    );
  } else {
    conds.push(rootCatalogGate(sql`a.prompt_id`));
  }
  const countries = effectiveScopeCountries(scope);
  if (countries?.length) conds.push(sql`a.region IN (${inList(countries)})`);

  // ── 기준일 축 = 회차 앵커 + 노출 게이트 (2026-09-16 제품 책임자 지적) ──────────────
  // 종전에는 `scope_runs` 조인 없이 `max(a.measured_at)` 을 그대로 냈다. 이 화면
  // (글로벌 프롬프트)의 "최근 수집일"만 다른 축을 쓰고 있었던 것이다 — 같은 성격의
  // 값을 내는 다른 화면들은 전부 `CYCLE_AS_OF_SQL`(= `max(COALESCE(r.cycle_anchor_at,
  // a.measured_at))`) 이다(답변분석 pill · Overview pill · 웹사이트 프롬프트 표).
  //
  // 라이브 실측(미러, 루트 카탈로그 전체 이력):
  //   max(measured_at)                       = 2026-09-15 03:31Z  ← 화면에 뜨던 값
  //   max(COALESCE(anchor, measured_at))     = 2026-09-13 15:48Z  ← 축만 고친 값
  //   노출 게이트까지 적용                      → 그 앞 회차          ← 이 함수의 결과
  // 9/13 회차는 `view_anchor_at`(= 앵커 + `VIEW_ANCHOR_DELAY.global` 2일)이 아직
  // 안 왔다. 축만 고치면 Overview pill 과 여전히 어긋나므로 **게이트도 같이** 건다
  // (`excludeHiddenCycleRuns` — `IS NOT NULL` 이 아니라 `<= now()` 규칙이 그 안에 있다).
  // family="mention": 이 값은 인용 전용이 아니라 화면 헤더의 수집 기간이다.
  conds.push(await excludeHiddenCycleRuns(sql`a.run_id`, "mention", sql`a.job_id`));
  // 앵커 축(옵트인)에서는 행 단위 회차일도 `ca.round_date` 다 — 위 pill 두 곳과 같은 축.
  const anchorOn = anchorAxisKnownEnabled();
  const asOfCol = anchorOn
    ? anchorRoundDateSql()
    : sql`COALESCE(r.cycle_anchor_at, a.measured_at)`;
  // ⚠️ 조인은 **LEFT** 다(검증 E-1). 이 문장의 `ca` 는 `min/max` 를 꺼내기 위한
  // **값 투영**이고 모집단은 위 `conds` 가 이미 정했다 — INNER 로 두면 앵커 행 없는
  // 답변이 수집 기간 모수에서 조용히 빠진다. `job_id` 가 PK 라 행은 안 불어나고,
  // NULL 은 `min`/`max` 가 무시한다(`anchorAsOfJoinSql` 이 세운 규칙과 같다).
  const rows = (await db.execute(sql`
    SELECT min(${asOfCol}) AS first_at, max(${asOfCol}) AS last_at
    FROM scope_answers a
    LEFT JOIN scope_runs r ON r.run_id = a.run_id${anchorAsOfJoinSql(sql.raw("a.job_id"))}
    WHERE ${sql.join(conds, sql` AND `)}
  `)) as unknown as Array<{ first_at: string | Date | null; last_at: string | Date | null }>;

  const toDate = (v: string | Date | null | undefined): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(v);
  return {
    firstMeasuredAt: toDate(rows[0]?.first_at),
    lastMeasuredAt: toDate(rows[0]?.last_at),
  };
}

// ─── 답변분석 > Mention 4-KPI 탭 집계 (2026-08-28) ────────────────────────────
// 피그마 GGMD 1차 고도화가 Mention 화면을 4개 KPI 탭(노출률 · 점유율 · 우호도 ·
// 우선 노출도)으로 재편하면서 필요해진 집계 4종. 기존 함수는 하나도 건드리지
// 않는다(시그니처·산출 불변) — 신규 화면이 소비하는 형태만 새로 낸다.
//
// 공통 규율:
//  · **모집단 술어는 detailAnswerWhere 하나만 쓴다.** 자체 WHERE 를 조립하면
//    탭 간·기존 화면 간 모집단이 조용히 갈라진다(스펙 "모든 탭 지표는 동일 모집단
//    술어를 쓴다"). 회차 시계열은 같은 함수의 `{ allRuns: true }` 모드를 쓴다.
//  · **빈 회차는 갭.** 측정이 없는 버킷은 행 자체가 없다 — 직전값으로 잇지 않는다
//    (aggregateStandardTrendFromMirror 와 동일 원칙). 반면 "측정은 있었는데 그
//    브랜드 언급이 0" 은 진짜 0이므로 0으로 채운다. 둘을 구분하는 것이 요점.
//  · **주별 셀 스냅샷.** 한 버킷 안에서 (프롬프트×엔진×지역) 셀이 재측정되면 최신
//    1건만 센다(2026-08-12 결정, readMentionBrandDayCounts 와 동일) — 재측정이
//    잦은 주의 점이 표(셀당 최신 스냅샷)와 다른 단위가 되는 것을 막는다.
//  · **모수 법칙 통일.** 브랜드 롤업(canonRollupSql) + 전역 표기 해석(ROLLUP_NAMES)
//    + 표기 병합(canonBrandNameSql) + 비경쟁 제외(excludeNonCompetitorBrandsSql).
//    언급표·Sub KPI·표준 코어가 쓰는 것과 같은 조합이다.

// 추이 스캔 상한 — allRuns × mention 조인은 필터 조합에 따라 무거워져 statement
// timeout 을 냈던 자리다(readMentionBrandDayCounts 주석 참조). 주간 라인은 최근
// 구간만 의미가 있어 120일(~17주)로 바운드해 스캔을 상수화한다. 사용자가 명시
// 기간 필터를 걸면 detailAnswerWhere 가 더 좁힌다(둘 중 좁은 쪽).
//
// ⚠️ 이 값이 추이 3종의 지배 비용이다 — 프로덕션 EXPLAIN(2026-08-28) 기준 120일
// 창의 답변셋이 71,662행이고 여기에 붙는 멘션이 674,709행이다. 4회차 스파크라인만
// 필요한 호출부는 `opts.trendDays` 로 창을 좁혀 스캔을 비례 축소할 수 있다.
const KPI_TAB_TREND_FLOOR_DAYS = 120;
const KPI_TAB_TREND_MAX_DAYS = 365;
// 시리즈 하드 상한 — cap 파라미터가 아무리 커도 페이로드가 폭주하지 않게.
const KPI_TAB_MAX_SERIES = 50;
// 정본 = `lib/kpi/first-position-rank.ts::RANK_TABLE_TOP_BRANDS`(경쟁사 미니값 후보 모집단과 같은 값).
const KPI_TAB_DEFAULT_TOP_BRANDS = RANK_TABLE_TOP_BRANDS;

/**
 * 엔진 × 브랜드 스냅샷(`latestBrands`)의 **엔진당 경쟁 브랜드 표시 상한**.
 * 브랜드 수백~천 개를 전부 내려보내지 않기 위한 절단이다(당사는 상한 밖으로 늘 포함).
 *
 * ⚠️ 이 값은 "그 엔진의 경쟁 브랜드 수"가 아니다 — 라이브 실측(2026-09-10 검증자)에서
 * chatgpt 850 · gemini 1,115 개 중 상위 30 만 내려간다. 그래서 이 배열에서 센 어떤
 * 수도 모수로 말하면 안 되고, 화면 라벨은 `상위 N` 으로만 쓴다
 * (`engine.competitorAvgWithCount`, kpi-view.ts `EngineCompetitorBar.competitorCount`).
 */
export const ENGINE_BRAND_TOP_N = 30;

// 버킷 안에서 셀(프롬프트×엔진×지역)당 최신 답변 1건만 남기는 CTE 본문.
// _answer_set(withAnswerSet 이 만든 TEMP 테이블) 위에서 돌아 원본 테이블을 다시
// 훑지 않는다 — 무거운 술어는 답변셋 생성 때 한 번만 평가된다.
const KPI_TAB_CELL_KEYS = cellSnapshotKeys({ alias: "", bucket: sql`bucket` });
/**
 * 앵커 축 판. `_answer_set` 은 `kpiTabTrendCols` 가 만든 **bare 컬럼**을 들고 있으므로
 * 여기서도 bare 다(`round_date`·`measured_at_orig` — 원본 표의 `ca.` 가 아니다).
 * dedup 은 버킷(주)이 아니라 **회차** 단위다(`trendCellKeys` 머리 주석).
 */
const KPI_TAB_ANCHOR_CELL_KEYS = cellSnapshotKeys({
  alias: "",
  bucket: sql.raw("round_date"),
  bucketFirst: true,
  // 동률은 `job_id` 사전식 최대로 깬다 — JS 짝과 같은 규칙(검증 C,
  // `cell-snapshot.ts::anchorCellSnapshotKeys` 머리 주석).
  tieBreak: sql.raw("measured_at_orig DESC, job_id DESC"),
});
function kpiTabCellSnapshot(): SQL {
  const anchorOn = anchorAxisKnownEnabled();
  const k = anchorOn ? KPI_TAB_ANCHOR_CELL_KEYS : KPI_TAB_CELL_KEYS;
  const extra = anchorOn ? sql.raw(", round_date, measured_at_orig") : sql``;
  return sql`
  SELECT DISTINCT ON (${k.all})
    job_id, prompt_id, target, region, measured_at, bucket${extra}
  FROM _answer_set
  ORDER BY ${k.all}, ${k.tieBreak}
`;
}


// 분모 0 은 0% 가 아니라 "측정 없음" — null 로 전파한다(스펙: 0 과 구분).
const pctOrNull = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

const bucketKey = (b: string | Date): string =>
  (b instanceof Date ? b : new Date(b)).toISOString().slice(0, 10);

const isoOrNull = (v: string | Date | null | undefined): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

function kpiTabUnit(unit: BucketUnit | undefined): BucketUnit {
  return unit === "day" ? "day" : "week";
}

// 추이 창(일)의 정규화 — SQL 에 리터럴로 합성되므로 정수·범위를 여기서 강제한다
// (사용자 입력이 interval 토큰으로 새는 경로를 원천 차단).
function kpiTabTrendDays(v: number | undefined): number {
  const n = Math.trunc(v ?? KPI_TAB_TREND_FLOOR_DAYS);
  if (!Number.isFinite(n) || n < 1) return KPI_TAB_TREND_FLOOR_DAYS;
  return Math.min(n, KPI_TAB_TREND_MAX_DAYS);
}

/**
 * 추이 읽기의 답변셋 술어 — allRuns + measured_at 존재 + 창 바닥 + 열린 회차 제외.
 *
 * 4-KPI 탭 추이 3종(브랜드·엔진·우선노출도)이 **이 한 자리**를 공유한다. 그래서
 * `excludeHiddenCycleRuns` 를 여기 한 번만 걸면 셋 다 같은 모수를 본다 —
 * 술어 머리 주석 참조(오버뷰 경쟁사 행이 2026-09-10 실측에서 open 9/08 회차 진행분
 * 37,569 답변을 9/07 주 버킷으로 그리고 있었다). 술어가 async 라 이 함수도 async 다.
 *
 * ⚠️ **스냅샷 단계(`detailAnswerWhere` 기본 모드)에는 걸지 않는다.** 엔진 KPI 의
 * `latest`·우선노출도의 순위표는 "지금 시점 상태"를 보여주는 카드라 추이와 규칙이
 * 다르다(핫픽스 A 가 고정한 범위와 같다).
 */
async function kpiTabTrendWhere(
  filters: StandardFilters,
  projectCtx: string | string[] | undefined,
  trendDays?: number,
): Promise<SQL> {
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  // PR④ — 이 한 자리가 KPI 탭 추이 3종의 모수다(머리 주석). 판정을 여기서 확정하면
  // 셋이 같은 술어를 본다.
  await ensureTrendGrid();
  const days = kpiTabTrendDays(trendDays);
  return sql`${detailAnswerWhere(filters, projectCtx, { allRuns: true })}
    AND a.measured_at IS NOT NULL
    AND a.measured_at >= now() - ${sql.raw(`interval '${days} days'`)}
    AND ${await excludeHiddenCycleRuns(sql`a.run_id`, "mention", sql`a.job_id`)}`;
}

/**
 * 추이 **축의 창 경계** — 측정이 하나도 없는 회차까지 포함한 첫/마지막 버킷.
 *
 * 왜 필요한가(2026-09-01 재검증 C3): 측정된 버킷의 min/max 로 축을 만들면 축이
 * 첫/마지막 **측정**에 갇힌다. 그러면 창의 앞뒤 결측이 통째로 사라지고, 커버리지
 * 라벨이 "미측정 0"이라고 **적극적으로 거짓 주장**한다. 특히 최신 회차 결측은
 * "측정이 멈췄다"는 신호라 운영 지면이 반드시 드러내야 한다.
 *
 * 경계는 `kpiTabTrendWhere` 의 창(now - N days)과 사용자 기간 필터의 교집합이며,
 * **DB 에서** date_trunc 로 잘라 온다 — JS 로 계산하면 서버·DB 타임존이 갈리는
 * 순간 축이 한 칸 밀린다. 테이블을 읽지 않는 1행 문장이라 비용은 사실상 0.
 *
 * ── ⚠️ 앵커 축 **미전환** (의도적 보류, 검증 B4 잔존 경로) ────────────────────
 * 이 경계는 달력 격자(`date_trunc(field, now() - N일)`)이고 축 on 의 버킷은 회차
 * 날짜다. `unit='day'` 에서 둘을 맞추지 않으면 회차가 없는 날짜마다 결측 슬롯이
 * 생겨 `trendCoverage.missingCycles` 가 부풀려진다(커버리지 **라벨**만 틀린다 —
 * 값·모수는 버킷 쪽 축이 이미 회차라 영향이 없다).
 *
 * 고치지 않은 이유: 올바른 경계는 "그 창 안에 실제로 존재하는 `round_date` 의
 * min/max" 인데, 그것을 내려면 이 1행 문장이 앵커 표를 읽어야 하고 그 순간
 * "측정이 없는 회차까지 포함한다"는 이 함수의 존재 이유(위 문단)와 충돌한다 —
 * 회차 격자에서 "없는 회차"의 정의가 달력 격자와 다르기 때문이다. 축 전환의
 * 값 계약이 아니라 **커버리지 라벨의 의미 재정의**라 별도 결정이 필요하다.
 * 그 전까지 축 on 의 `unit='day'` 커버리지 라벨은 과다 계상된다.
 */
function kpiTabWindowBoundsSql(
  filters: StandardFilters,
  unit: BucketUnit,
  trendDays?: number,
  // 주 격자(2026-09-28) — 버킷 키와 같은 규칙으로 잘라야 축 끝이 버킷과 어긋나지 않는다.
  // 글로벌(`anchorKst`)은 KST 주로 자른다. 생략 = 종전(세션 TZ 주) — 문장 텍스트 무변경.
  grid: MirrorWeekGrid = "measured",
): SQL {
  const days = kpiTabTrendDays(trendDays);
  const field = BUCKET_FIELD[unit] ?? "week"; // 화이트리스트 (사용자 입력 차단)
  const windowFloor = sql`now() - ${sql.raw(`interval '${days} days'`)}`;
  const floor = filters.dateFrom
    ? sql`greatest(${windowFloor}, ${filters.dateFrom}::timestamptz)`
    : windowFloor;
  const ceil = filters.dateTo ? sql`least(now(), ${filters.dateTo}::timestamptz)` : sql`now()`;
  if (field === "week" && grid === "anchorKst") {
    const kstWeek = (t: SQL) => sql`(date_trunc('week', (${t}) AT TIME ZONE 'Asia/Seoul'))::date`;
    return sql`
    SELECT to_char(${kstWeek(floor)}, 'YYYY-MM-DD') AS win_start,
           to_char(${kstWeek(ceil)}, 'YYYY-MM-DD') AS win_end`;
  }
  return sql`
    SELECT to_char(date_trunc(${field}, ${floor}), 'YYYY-MM-DD') AS win_start,
           to_char(date_trunc(${field}, ${ceil}), 'YYYY-MM-DD') AS win_end`;
}

async function readWindowBounds(
  db: MirrorTx,
  filters: StandardFilters,
  unit: BucketUnit,
  trendDays?: number,
  grid: MirrorWeekGrid = "measured",
): Promise<{ windowStartBucket: string | null; windowEndBucket: string | null }> {
  const rows = (await db.execute(
    kpiTabWindowBoundsSql(filters, unit, trendDays, grid),
  )) as unknown as Array<{ win_start: string | null; win_end: string | null }>;
  return {
    windowStartBucket: rows[0]?.win_start ?? null,
    windowEndBucket: rows[0]?.win_end ?? null,
  };
}

/**
 * 추이 답변셋의 컬럼 목록 (버킷 포함) — withAnswerSet 의 첫 인자.
 *
 * ⚠️ **버킷은 여기 한 자리에서만 정해진다.** `KPI_TAB_CELL_SNAPSHOT` 의 `DISTINCT ON`
 *    과 모든 `GROUP BY bucket` 이 이 컬럼을 그대로 읽으므로, 이 식을 바꾸면 dedup 격자와
 *    표시 격자가 **함께** 움직인다(언급 화면 추이가 세 자리를 각각 고쳐야 했던 것과 대비 —
 *    `mentionBrandDayCountsQuery` 주석 참조). 그래서 09-08 회차가 09-13 회차 답변에
 *    밀려 사라지던 결함이 이 한 줄로 같이 고쳐진다.
 *
 * `wk` 미지정 또는 `applied === "measured"` 이고 폴백 격자가 `measured` 면 식이 **종전과
 * 문자 그대로 같다**(`date_trunc($1, a.measured_at)` — `field` 는 바인드다. 회차 키 쪽
 * 폴백은 리터럴 `'week'` 를 쓰는 별개 문장이라 이 동일성과 무관하다).
 *
 * 글로벌 주 격자(`wk.grid === "anchorKst"`, 2026-09-28 main #300)는 측정 폴백도 회차
 * 앵커의 KST 주다(`mirrorWeekKey` 머리 주석) — 그때는 `wk.key` 를 쓰고, 그 키가 읽는
 * run 앵커 조인은 `wk.join` 으로 함께 나간다(`kpiTabTrendAxis`). `day` 축에는 얹지 않는다.
 */
// ⚠️ `wk` 는 **필수**다(프리뷰 차단 결함 2026-09-20). 선택 인자로 두었더니 한 호출부가
//    그것을 빠뜨렸고, 축이 켜져도 종전 컬럼만 싣는 투영이 나갔다 — 소비 문장은 축을
//    따로 판단해 `round_date` 를 참조하므로 런타임 42703 이다. 필수로 만들면 축 판단이
//    **호출부 하나**(`kpiTabTrendAxis`)로 모이고 컴파일러가 우회를 막는다.
function kpiTabTrendCols(unit: BucketUnit, wk: TrendWeekKey): SQL {
  const field = BUCKET_FIELD[unit] ?? "week"; // 화이트리스트 (사용자 입력 차단)
  // 앵커 축: 주는 `ca.anchor_week`, 일은 `ca.round_date`(앵커 축의 하루 = 회차 하나).
  // dedup 과 동점 처리가 TEMP 표 위에서 돌므로 회차·원본 측정 시각도 함께 투영한다 —
  // 투영에서 빠지면 그 문장이 런타임에만 42703 으로 터진다(2026-09-05 전례).
  if (wk.applied === "anchor") {
    return sql`a.job_id, a.prompt_id, a.target, a.region, a.measured_at, ${periodBucketSql(
      field,
      sql`a.measured_at`,
      { anchorAxis: true },
    )} AS bucket, ${anchorRoundDateSql()} AS round_date, ${anchorMeasuredOrigSql()} AS measured_at_orig`;
  }
  const bucket =
    wk.applied === "cycle" || (field === "week" && wk.grid === "anchorKst")
      ? wk.key
      : sql`date_trunc(${field}, a.measured_at)`;
  return sql`a.job_id, a.prompt_id, a.target, a.region, a.measured_at, ${bucket} AS bucket`;
}

/**
 * 4-KPI 탭 추이의 **주 격자 축 조각** (2026-09-18) — 답변셋 컬럼 + 조인 한 쌍.
 *
 * 정본 주석은 `trendWeekKey` 머리다(원천·매칭률·불일치율). 여기서 더하는 규칙은 하나뿐:
 * **`day` 축에는 회차 주를 얹지 않는다.** `cycle_week` 는 월요일 격자라 일 단위 축에
 * 끼우면 없던 날을 만든다(같은 이유로 갭 슬롯도 `day` 에는 안 들어간다 —
 * `lib/summary/read/trend-gaps.ts` 머리 주석). 오늘 KPI 탭 호출부는 전부 `week` 지만,
 * `opts.unit` 이 열려 있으므로 여기서 막는다.
 *
 * ── EXPLAIN (프로덕션 미러 · ANALYZE+BUFFERS · 같은 세션 A→B 교대 ×2, 2026-09-18) ──
 * 하네스: `scripts/summary/explain-kpi-trend-week.ts`(쓰기 0).
 * **텍스트가 바뀌는 문장은 답변셋 SELECT 하나뿐**이고, 그 문장은 오히려 빨라졌다 —
 * 조인 때문에 플래너가 병렬(`Parallel Hash Left Join`, 7 워커)로 내려간다:
 *
 *   글로벌 무필터  exec 677·682 ms → **276·279 ms** · shared 942,816 → 1,227,7xx · 노드 20 → 28
 *   region=KR      exec 104·104 ms → **115·115 ms** · shared 856,3xx → 1,104,7xx · 노드 21 → 27
 *
 * 산출 행수는 동일(216,908)하고 `scope_answers_run_cycle_idx` Index Only Scan·Nested Loop
 * 없음도 그대로다. buffers 증가는 병렬 워커의 중복 읽기 몫이다.
 *
 * ⚠️ **늘어난 것은 뒤따르는 문장이고, 그건 의도한 결과다.** 무필터 엔진 추이의 최장 문장
 *    (`ENGINE_KPI_PER_JOB`, 텍스트 무변경)이 **10.1 → 11.3 s** 다 — 회차 격자에서는 셀
 *    스냅샷 `DISTINCT ON` 이 09-08 회차를 **안 지우므로** `ans` 행이 더 남는다(그것이 이
 *    변경의 목적). 문장 상한 **20 s** 대비 여유가 충분하다.
 *    **예산 상수는 올리지 않았다** — 상한을 올려 느려진 문장을 덮지 말라는 것이
 *    `kpi-tab-budget.ts` 의 규율이다.
 *    ⚠️ **경로 합계(함수 wall)는 여기 적지 않는다.** 로컬→풀러 RTT(문장당 ~140 ms)가
 *       섞여 있고, 검증자의 프로덕션 재현(창 84일 ×2)에서 A/B 방향이 반대로 나왔다 —
 *       재현되지 않는 수치를 주석에 두면 다음 사람이 그것을 기준으로 판단한다.
 */
async function kpiTabTrendAxis(
  unit: BucketUnit,
  weekSource: TrendWeekSource,
  /**
   * 측정 폴백의 표면 격자(2026-09-28 main #300) — 호출부가 `mirrorWeekGridFor(projectCtx)`
   * 로 넘긴다. `day` 축에는 얹지 않는다(위 규칙과 같은 이유 — 월요일 격자).
   */
  grid: MirrorWeekGrid,
): Promise<{ cols: SQL; join: SQL; applied: TrendWeekApplied }> {
  const week = unit === "week";
  const wk = await trendWeekKey(week ? weekSource : "measured", week ? grid : "measured");
  return { cols: kpiTabTrendCols(unit, wk), join: wk.join, applied: wk.applied };
}

/** 스코프가 아예 없으면(루트 미설정 + 프로젝트 미지정) 집계가 성립하지 않는다. */
function kpiTabHasScope(projectCtx: string | string[] | undefined): boolean {
  return hasProjectCtx(projectCtx) || !!getStandardRootId();
}

// cap 적용 — 언급 합 내림차순(동률은 이름 오름차순으로 결정적 고정). 당사(tracked)
// 브랜드는 cap 밖이어도 항상 남긴다: 경쟁 비교 차트에서 기준선이 사라지면 화면이
// 의미를 잃는다(cap 은 "비교 대상 상한"이지 "당사 제외 조건"이 아니다).
function capBrandSeries(
  totals: Map<string, { mentions: number; isTracked: boolean }>,
  cap: number,
): string[] {
  const ranked = [...totals.entries()].sort(
    (a, b) => b[1].mentions - a[1].mentions || a[0].localeCompare(b[0]),
  );
  const picked: string[] = [];
  for (const [name, t] of ranked) {
    if (t.isTracked || picked.length < cap) picked.push(name);
    if (picked.length >= KPI_TAB_MAX_SERIES) break;
  }
  return picked;
}

function normalizeCap(v: number | undefined): number {
  const n = Math.trunc(v ?? KPI_TAB_DEFAULT_TOP_BRANDS);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, KPI_TAB_MAX_SERIES);
}

// ── 1. 회차×브랜드 추이 (주별 Top10 라인 · 경쟁사 스파크라인 · WoW) ───────────

export interface BrandTrendPoint {
  brand: string;
  isTracked: boolean;
  mentions: number;
  /** 그 브랜드가 등장한 답변 수 (노출률 분자). */
  answers: number;
  /** answers / 버킷 답변 수. 버킷에 답변이 없으면 그 버킷 자체가 없다. */
  exposurePct: number | null;
  /** mentions / 버킷 전체 브랜드 언급 합 (cap 밖 브랜드도 분모에 포함). */
  sharePct: number | null;
}

export interface BrandTrendBucket {
  bucketStart: string; // 버킷 시작일 ISO (week = 월요일)
  answers: number;
  /** cap 과 무관한 전 브랜드 언급 합 — 점유율 분모. */
  totalMentions: number;
  // coverage — 불규칙 cadence 를 숨기지 않기 위한 정직성 신호
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  /** 시리즈 브랜드마다 1점. 측정은 있었으나 언급이 없으면 0(갭 아님). */
  brands: BrandTrendPoint[];
}

/** 추이 축의 창 경계 — 측정이 없는 앞뒤 회차까지 포함한다(readWindowBounds). */
export interface TrendWindowBounds {
  windowStartBucket: string | null;
  windowEndBucket: string | null;
}

/**
 * **숨긴 회차의 갭 슬롯 후보 키**(0070, 2026-09-10) — 주 격자 키(`cycle_week`) 목록.
 *
 * 이 결과를 만든 것은 미러 집계지만, 값은 미러가 아니라 **원장**에서 온다
 * (`lib/summary/read/trend-gaps.ts::trendGapWeekKeys` 가 페처 경계에서 얹는다).
 * 여기 두는 이유는 화면(kpi-view.ts)까지 나르는 그릇이 이 타입뿐이기 때문이다.
 *
 * ⚠️ **후보**다 — 마커를 찍는 판정은 축을 쥔 화면이 한다(축 안쪽인가 · 그 주에 다른
 * 회차 측정이 남아 있지 않은가). 판정 정본은 `lib/viz/trend-gap.ts::trendGapKeysToMark`.
 */
export interface TrendGapBucketKeys {
  gapBuckets?: string[];
  /**
   * **공용 추이 격자의 자리 목록**(D5, 2026-09-20). 있으면 화면은 축을 스스로 채우지
   * 않고(`trendAxis` 의 `fillTrendGaps`) **이 목록 그대로** 축을 세운다.
   *
   * `gapBuckets` 와 같은 자세다 — 값은 미러가 아니라 **원장**에서 오고
   * (`lib/period/trend-grid.ts::buildTrendGrid`), 페처 경계(`withKpiTrendGaps`)가 얹는다.
   * 여기 두는 이유도 같다: 화면까지 나르는 그릇이 이 타입뿐이다.
   *
   * ⚠️ 이쪽은 **후보가 아니라 축 그 자체**다. `gapBuckets` 는 화면이 판정할 후보 키지만
   *    자리 목록은 이미 판정이 끝난 격자다(점이냐 갭이냐가 `gapReason` 에 실려 있다).
   */
  trendGrid?: TrendGridSlotView[];
}

export interface BrandTrendResult extends TrendWindowBounds, TrendGapBucketKeys {
  unit: BucketUnit;
  /** cap 적용 후 시리즈 브랜드 (창 전체 언급 합 내림차순, 당사 우선 보존). */
  brands: Array<{ brand: string; isTracked: boolean; mentions: number }>;
  buckets: BrandTrendBucket[];
}

/**
 * 회차(measured_at 버킷) × 브랜드 언급 수·노출률·점유율.
 * 주별 상위 N 브랜드 라인차트와 경쟁사 스파크라인(직전 4회차)·WoW 의 원천.
 */
export async function aggregateBrandTrendFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: {
    unit?: BucketUnit;
    topBrands?: number;
    trendDays?: number;
    /** 문장 하나의 상한(ms). 실효 최악 = budgetMs + 이 값 (withAnswerSet 참조). */
    statementTimeoutMs?: number;
    /** 이 집계 전체의 벽시계 예산(ms). 문장 발행 전마다 확인한다. */
    budgetMs?: number;
    // 주 격자 키의 원천(2026-09-18) — `trendWeekKey` 머리 주석이 정본. 기본값은
    // **종전 그대로**(측정시각 주)라, 이 인자를 안 넘기는 호출부는 SQL 문자까지 같다.
    weekSource?: TrendWeekSource;
  } = {},
): Promise<BrandTrendResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  const unit = kpiTabUnit(opts.unit);
  const emptyBounds = { windowStartBucket: null, windowEndBucket: null };
  if (!kpiTabHasScope(projectCtx)) return { unit, brands: [], buckets: [], ...emptyBounds };
  const cap = normalizeCap(opts.topBrands);
  // 측정 폴백·축 경계의 주 격자 — 글로벌은 회차 앵커의 KST 주(2026-09-28 main #300).
  const weekGrid = mirrorWeekGridFor(projectCtx);
  const axis = await kpiTabTrendAxis(unit, opts.weekSource ?? "measured", weekGrid);

  return withAnswerSet(
    axis.cols,
    await kpiTabTrendWhere(filters, projectCtx, opts.trendDays),
    async (db) => {
      // (0) 축의 창 경계 — 앞뒤 결측 회차가 사라지지 않게(C3). 테이블 미접근 1행.
      const bounds = await readWindowBounds(db, filters, unit, opts.trendDays, weekGrid);

      // (1) 버킷별 답변/커버리지 — 버킷 집합의 정본. 여기 없는 버킷 = 측정 없음(갭).
      const ansRows = (await db.execute(sql`
        WITH ans AS (${kpiTabCellSnapshot()})
        SELECT bucket,
          count(*)::int AS answers,
          count(DISTINCT date_trunc('day', measured_at))::int AS measured_days,
          min(measured_at) AS first_at, max(measured_at) AS last_at
        FROM ans GROUP BY bucket ORDER BY bucket
      `)) as unknown as Array<{
        bucket: string | Date; answers: number; measured_days: number;
        first_at: string | Date | null; last_at: string | Date | null;
      }>;

      // (2) 버킷×브랜드 언급/등장답변 — cap 은 여기서 걸지 않는다(점유율 분모가
      //     전 브랜드 합이라, 자르면 분모가 함께 줄어 값이 부풀려진다).
      //
      // 2단 집계인 이유(프로덕션 EXPLAIN 2026-08-28): 한 답변 안에서 같은 브랜드가
      // 모델 롤업으로 여러 행이 되므로 "등장 답변 수"는 job_id 중복 제거가 필요한데,
      // `count(DISTINCT m.job_id)` 를 바깥 GROUP BY 에 붙이면 플래너가 GroupAggregate
      // 로 내려가 674,709행을 **디스크 41MB 외부 병합 정렬**한다(5.32s). (bucket,
      // brand, job_id)로 먼저 접고 바깥에서 count(*) 를 세면 양쪽 다 HashAggregate
      // 로 붙어 4.52s — 산출은 동일하고 정렬 스필만 사라진다.
      //
      // ── 성능: 추이 ②(aggregateStandardTrendFromMirror)의 3종 세트 이식 (2026-09-02) ──
      // ffcf573 은 대시보드 콜드 경로만 고쳤고 KPI 탭 3종은 미수정으로 남아 있었다.
      // 그 결과 admin 무필터에서 이 집계가 **10,036 ms** 로 예산(9,000)을 넘겨
      // 프리뷰의 경쟁사 추이가 degrade 됐다. 같은 기법을 그대로 적용한다:
      //   (a) `ans` 조인 + canonRollupSql 을 **OFFSET 0 배리어** 안에 가둬 조인
      //       순서를 고정 — 플래너가 `scope_mentions ⟕ names` 를 먼저 해 답변셋
      //       밖 행까지 비싼 식을 평가하던 것을 막는다.
      //   (b) 표기(rollupDisplayName)·제외 키(rollupBareName)는 names(1,508행) 쪽
      //       사전 계산값을 쓴다 — 38-branch CASE 평가 횟수가 행수 → 1,508 로.
      //   (c) 제외 술어는 단순 CASE(excludeNonCompetitorBaresSql) 로 테스트 식 1회 평가.
      // 근거·전후 수치는 추이 ② 주석과 이 함수의 커밋 메시지 참조.
      const brandRows = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE}, ans AS (${kpiTabCellSnapshot()}),
        per AS (
          SELECT x.bucket AS bucket,
            ${rollupDisplayName("x")} AS name,
            x.job_id AS job_id,
            sum(x.mention_count)::int AS mc,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_tracked
          FROM (
            SELECT ans.bucket AS bucket, m.job_id AS job_id,
              m.mention_count AS mention_count, m.brand AS brand,
              ${canonRollupSql(filters)} AS rid
            FROM scope_mentions m
            JOIN ans ON ans.job_id = m.job_id
            WHERE m.brand_rollup_entity_id IS NOT NULL
            OFFSET 0
          ) x
          LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
          GROUP BY 1, 2, 3
        )
        SELECT bucket, name,
          sum(mc)::int AS mentions,
          count(*)::int AS answers,
          bool_or(is_tracked) AS is_tracked
        FROM per GROUP BY 1, 2
      `)) as unknown as Array<{
        bucket: string | Date; name: string; mentions: number;
        answers: number; is_tracked: boolean;
      }>;

      // 창 전체 누적으로 시리즈를 뽑고(버킷마다 시리즈가 바뀌면 라인이 끊긴다),
      // 버킷별 점유율 분모는 cap 전 전 브랜드 합을 쓴다.
      const totals = new Map<string, { mentions: number; isTracked: boolean }>();
      const perBucket = new Map<
        string,
        Map<string, { mentions: number; answers: number }>
      >();
      const bucketMentionTotal = new Map<string, number>();
      for (const r of brandRows) {
        const k = bucketKey(r.bucket);
        const mentions = num(r.mentions);
        const t = totals.get(r.name) ?? { mentions: 0, isTracked: false };
        t.mentions += mentions;
        t.isTracked = t.isTracked || r.is_tracked === true;
        totals.set(r.name, t);
        bucketMentionTotal.set(k, (bucketMentionTotal.get(k) ?? 0) + mentions);
        let inBucket = perBucket.get(k);
        if (!inBucket) perBucket.set(k, (inBucket = new Map()));
        inBucket.set(r.name, { mentions, answers: num(r.answers) });
      }

      const series = capBrandSeries(totals, cap);
      const buckets: BrandTrendBucket[] = ansRows.map((a) => {
        const k = bucketKey(a.bucket);
        const answers = num(a.answers);
        const totalMentions = bucketMentionTotal.get(k) ?? 0;
        const inBucket = perBucket.get(k);
        return {
          bucketStart: k,
          answers,
          totalMentions,
          measuredDays: num(a.measured_days),
          firstAt: isoOrNull(a.first_at),
          lastAt: isoOrNull(a.last_at),
          brands: series.map((brand) => {
            const hit = inBucket?.get(brand);
            const mentions = num(hit?.mentions);
            const brandAnswers = num(hit?.answers);
            return {
              brand,
              isTracked: totals.get(brand)?.isTracked === true,
              mentions,
              answers: brandAnswers,
              exposurePct: pctOrNull(brandAnswers, answers),
              sharePct: pctOrNull(mentions, totalMentions),
            };
          }),
        };
      });

      return {
        unit,
        brands: series.map((brand) => ({
          brand,
          isTracked: totals.get(brand)?.isTracked === true,
          mentions: num(totals.get(brand)?.mentions),
        })),
        buckets,
        ...bounds,
      };
    },
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
      join: axis.join,
    },
  );
}

// ── 2. 엔진(target)별 노출률·점유율 시계열 + 최신 스칼라 ──────────────────────

export interface EngineKpiPoint {
  engine: string;
  answers: number;
  /** 당사가 1회 이상 등장한 답변 수. */
  trackedAnswers: number;
  exposurePct: number | null;
  totalMentions: number;
  trackedMentions: number;
  sovPct: number | null;
  /**
   * 우호도 입력(2026-09-02) — 당사 언급의 감정 신호 합. 답변 수가 아니다.
   * 산식은 Sub KPI Q3(대시보드 우호도 카드)와 동일: positive ÷ (P+NE+NG+MX).
   */
  sentSignals: number;
  positiveSignals: number;
  negativeSignals: number;
}

export interface EngineKpiBucket {
  bucketStart: string;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  engines: EngineKpiPoint[];
}

/**
 * 엔진 × 브랜드 스냅샷(2026-09-02 피그마 1:1 D24 — "경쟁사 평균 / 선택 경쟁사" 엔진 바).
 * 브랜드 표기는 언급 집계(MentionsLive.brands[].brand)와 같은 rollupDisplayName 이라
 * 경쟁사 선택 드롭다운의 값으로 바로 조회할 수 있다.
 */
export interface EngineBrandPoint {
  engine: string;
  brand: string;
  isTracked: boolean;
  /** 이 엔진에서 그 브랜드가 1회 이상 등장한 답변 수(노출률 분자). */
  answersWithBrand: number;
  mentions: number;
}

/** 유형 × 회차(2026-09-02 D29) — 당사 언급에 그 유형 신호가 있는 답변 수(노출률 분자). */
export interface TypeTrendBucket {
  bucketStart: string;
  answers: number;
  byType: Record<MentionTypeKey, number>;
}

export interface EngineKpiTrend extends TrendWindowBounds, TrendGapBucketKeys {
  unit: BucketUnit;
  /** 창 안에서 관측된 엔진 목록 (이름 오름차순 — 라인 색 고정용). */
  engines: string[];
  buckets: EngineKpiBucket[];
  /**
   * 엔진 × 브랜드 스냅샷 — 스냅샷 창(latest 와 같은 모집단).
   * 엔진당 언급 상위 `ENGINE_BRAND_TOP_N` + 당사. **전체 경쟁 브랜드가 아니다.**
   * 화면은 여기서 경쟁사 평균(브랜드별 노출률의 평균)을 낸다 — 그 평균의 모수는
   * "그 엔진의 경쟁사 수"가 아니라 상위 N 이며, 라벨도 그렇게 말해야 한다(검증자 B4).
   */
  latestBrands: EngineBrandPoint[];
  /** 유형 × 회차 시계열(allRuns 창, buckets 와 같은 축). 시계열 degrade 시 빈 배열. */
  typeTrend: TypeTrendBucket[];
  /**
   * 최신 스칼라 — 추이의 마지막 버킷이 아니라 **스냅샷 창**(detailAnswerWhere
   * 기본 모드)에서 낸다. 탭 히어로·요약 카드와 같은 모집단이어야 하기 때문이다
   * (스펙 "모집단 일치"). 마지막 버킷 값은 재측정 진행 중이면 반토막일 수 있다.
   */
  latest: EngineKpiPoint[];
  latestMeasuredAt: string | null;
  /**
   * 시계열 단계만 실패했는가(2026-09-01 재검증 C2). true 면 `buckets` 는 비었지만
   * `latest`(스냅샷 스칼라)는 유효하다 — 엔진 바는 그대로 두고 시계열만 "표시 불가"로
   * 그려야 한다. 종전에는 단계 하나가 죽으면 집계 전체를 null 로 던져 히어로 추이·
   * 엔진 섹션·유형 콤보·커버리지가 **동시에** 비었다.
   */
  trendDegraded: boolean;
  /**
   * **Overview 추이의 자리 배열 그대로**(제품 책임자 2026-09-20). Overview 를 만드는 **바로 그
   * 함수**(`fetchStandardTrend`)가 낸 배열이다 — 자리 목록·게이트·회차 대표 선택·폴백
   * 판정까지 전부 그 함수 안에서 한 번만 일어난다.
   *
   * 두 가지가 여기서 나온다:
   *   · **노출률 추이**(`kpiTrendPoints(_, "exposure")`) — 축과 값 둘 다.
   *   · **카드 Δ 셋**(노출률·점유율·우호도) — `overviewCardDelta(slots, key)`.
   *     Overview 카드의 Δ 도 같은 배열·같은 규칙이다(`live.ts::applyTrendDeltas`).
   *
   * ⚠️ **추이 차트는 노출률만** 이 배열을 쓴다. 점유율·우호도·엔진별 라인의 **선**은
   *    그대로 `buckets`(미러)다 — 사실표에 그 축이 없다(`own_negative` 부재 ·
   *    `(cycle, engine, brand)` 축 부재). 그래서 같은 탭에서 **카드(사실표)와 추이의
   *    마지막 점(미러)이 다를 수 있다.** 후속 범위이고, 그 사실을 여기에 박아 둔다.
   *
   * 없으면 종전 그대로다(격자 off·루트 없음) — 필드가 안 실리므로 캐시 셀 바이트 동일.
   */
  overviewSlots?: readonly StandardTrendBucket[];
  /**
   * **카드 Δ 의 입력** — Overview 카드가 쓰는 **바로 그 Δ 롤업** 배열이다
   * (`deltaTrendFilters(filters)` + `DELTA_TREND_BUCKET`, 2026-09-20 독립 검증 N2).
   *
   * 추이 차트가 쓰는 `overviewSlots`(13자리 주 격자)와 **다른 배열**이다. 둘을 하나로
   * 합치지 않는 이유: Overview 는 화면 추이와 Δ 롤업을 일부러 갈라 두었고
   * (`live.ts` 의 Δ 출처 주석), 그것을 합치는 것은 **Overview 숫자를 바꾸는 산식 변경**이라
   * 제품 결정 사항이다. 그래서 언급 화면이 Overview 쪽 입력에 맞춘다.
   */
  overviewDeltaSlots?: readonly StandardTrendBucket[];
}

// ── 엔진 KPI: 답변 플래그 + 언급 합계를 **한 패스**로 (2026-09-02) ──────────
//
// 종전에는 같은 답변셋을 두 문장이 각각 훑었다: ① `EXISTS(… tracked …)` 로 답변별
// tracked 플래그, ② mention 조인으로 언급 합계. ②의 스캔이 ①의 상위집합이므로
// 한 번만 훑고 job 단위로 접은 뒤 답변셋에 되붙인다.
//
// ── 동치성 (이 형태는 새 형태라 전제를 명시적으로 증명한다) ─────────────────
// P1. `trackedRollupPredicate(m)` ⟹ `m.brand_rollup_entity_id IS NOT NULL`.
//     canonRollupSql 은 `CASE WHEN rid IS NULL THEN rid …` 로 시작하는 **NULL 보존**
//     함수라, rollup 이 NULL 인 행은 결과도 NULL 이고 `NULL IN (…)` 은 TRUE 가 될 수
//     없다. 따라서 배리어의 `WHERE brand_rollup_entity_id IS NOT NULL` 은 tracked
//     판정을 받을 수 있는 행을 **하나도 떨어뜨리지 않는다**.
//     미러 전수 반증(프로덕션 2026-09-02): scope_mentions 2,656,866행 중 rollup NULL
//     569,878행 · 그중 술어가 TRUE 인 행 **0**. (나머지는 전부 NULL 평가 = EXISTS 거짓.)
// P2. `bool_or(x.rid IN tracked)` ≡ `EXISTS(… m.job_id = a.job_id AND 술어 …)`.
//     같은 job 의 같은 행 집합(P1)에 같은 식을 적용한다. 언급이 0건인 답변은
//     LEFT JOIN 으로 `pj.has_tracked = NULL` 이 되고 `FILTER (WHERE …)` 는 NULL 을
//     세지 않는다 — EXISTS 의 FALSE 와 같다.
// P3. 표기·비경쟁 필터를 **WHERE 가 아니라 FILTER 로** 옮긴 이유가 P2 다. tracked
//     플래그는 그 필터를 받지 않는 술어이므로, 필터를 WHERE 로 두면 has_tracked 가
//     좁아진다. `keep` 이 NULL 인 행은 FILTER 가 제외 — 종전 WHERE 의 NULL 탈락과 같다.
// 검증(프로덕션 · 무필터 · TEMP TABLE 경로 · EXCEPT ALL 양방향 0):
//   추이   md5 b8f9dfe49fbc254d46d63e50b43506ce · 20행 · 5,909 ms → 5,486 ms
//   스냅샷 md5 c2a4b6fc73c861fd838d95b63baf1e42 ·  2행 · 1,577 ms → 1,466 ms
//
// ⚠️ 절감폭은 0e11563 주석의 예상(~1,800 ms)보다 훨씬 작다(실측 합 ~530 ms). 예상이
// 틀린 이유는 EXPLAIN 이 말해 준다: EXISTS 문장은 애초에 비싸지 않았고(추이 1,622 ms ·
// 스냅샷 283 ms), 이 집계의 지배 비용은 **식 평가가 아니라 행 인출**이다 —
// 언급 조인 Nested Loop 만 2,999 ms(853,909행 · shared hit 403,486 · 100,130 loops).
// 병합은 그 인출을 한 번으로 줄이지만, 대신 job 단위 GROUP BY(100k 그룹)를 새로 내므로
// 순이득이 차액만 남는다. 남은 3s 는 "답변 100,130건에 붙은 언급 853,909행을 읽는다"는
// 모집단 자체의 비용이라 이 계층에서 더 줄일 수 없다(아래 인덱스 검토 참조).
//
// 검토 후 기각 — **커버링 인덱스로 index-only scan 만들기**. Nested Loop 의 buffers
// 403,486 / 100,130 loops = loop 당 4.03 페이지인데, `scope_mentions_job_idx`(43MB)
// 의 높이가 3 이므로 그 중 **힙은 1 페이지뿐**이다(한 job 의 ~9행이 같은 힙 페이지에
// 몰려 있다). 즉 힙 접근을 없애도 상한이 ~25% 이고, 대가는 (job_id) INCLUDE
// (brand_rollup_entity_id, brand, mention_count) ≈ 200MB 인덱스와 미러 동기화마다의
// 쓰기 증폭이다. 비용이 이득을 넘는다.
function ENGINE_KPI_PER_JOB(filters: StandardFilters, answerSrc: string): SQL {
  const keep = sql`(COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)})`;
  return sql`
        x AS (
          SELECT m.job_id AS job_id, m.mention_count AS mention_count,
            m.brand AS brand, ${canonRollupSql(filters)} AS rid,
            m.sentiment_positive AS sp, m.sentiment_neutral AS sne,
            m.sentiment_negative AS sng, m.sentiment_mixed AS smx
          FROM scope_mentions m JOIN ${sql.raw(answerSrc)} a ON a.job_id = m.job_id
          WHERE m.brand_rollup_entity_id IS NOT NULL
          OFFSET 0
        ),
        per_job AS (
          SELECT x.job_id AS job_id,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS has_tracked,
            sum(x.mention_count) FILTER (WHERE ${keep}) AS total,
            sum(x.mention_count) FILTER (
              WHERE ${keep} AND x.rid IN ${trackedRollupIn(filters)}
            ) AS tracked,
            -- 우호도 탭(2026-09-02): 당사 언급의 감정 신호 합. Sub KPI Q3 와 같은
            -- 술어(tracked 롤업, 표기 필터 없음)라 스냅샷 카드와 산식이 일치한다.
            -- 같은 스캔에 열만 늘린 것이라 추가 인출은 없다.
            sum(x.sp + x.sne + x.sng + x.smx) FILTER (
              WHERE x.rid IN ${trackedRollupIn(filters)}
            ) AS sent,
            sum(x.sp) FILTER (WHERE x.rid IN ${trackedRollupIn(filters)}) AS pos,
            sum(x.sng) FILTER (WHERE x.rid IN ${trackedRollupIn(filters)}) AS neg
          FROM x LEFT JOIN names n ON n.entity_id = x.rid
          GROUP BY 1
        )`;
}

/** 엔진별 노출률·점유율 — 시계열(allRuns) + 최신 스칼라(스냅샷). */
export async function aggregateEngineKpiTrendFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: {
    unit?: BucketUnit;
    trendDays?: number;
    /** 문장 하나의 상한(ms) — 진짜 statement_timeout. */
    statementTimeoutMs?: number;
    /**
     * 이 집계 **전체**(두 단계 합)의 벽시계 예산(ms).
     *
     * 이 함수는 트랜잭션을 두 번 연다(스냅샷 창 + allRuns 창). 종전 구현은 1단계
     * 소요를 빼고 남은 예산을 2단계 `statement_timeout` 으로 넘기며 "두 단계 합이
     * 예산을 넘지 않는다"고 적었는데, **그것은 거짓이었다**(2026-09-01 재검증 C1):
     * `statement_timeout` 은 문장당이고 한 단계가 여러 문장(SET·CREATE TEMP·ANALYZE·
     * 분석 쿼리들 — 2026-09-01 실측 6~7개)을 발행하므로 1단계만으로 6~7×timeout 을
     * 쓸 수 있었다.
     *
     * 지금은 **하나의 마감(deadlineAt)** 을 두 단계가 공유하고, withAnswerSet 이
     * 모든 문장 앞에서 그 마감을 확인한다. 정직한 상한은:
     *   실효 최악 = budgetMs + statementTimeoutMs
     * (마감 직전에 보낸 문장 하나는 끝까지 기다려야 한다).
     */
    budgetMs?: number;
    /**
     * 주 격자 키의 원천(2026-09-18). **추이 단계에만** 적용된다 — 스냅샷 단계
     * (`latest`·`latestBrands`)는 버킷이 없는 "지금 시점 상태" 라 대상이 아니다.
     * 기본값은 종전(측정시각 주). 정본은 `trendWeekKey` 머리 주석.
     */
    weekSource?: TrendWeekSource;
  } = {},
): Promise<EngineKpiTrend> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const unit = kpiTabUnit(opts.unit);
  const emptyBounds = { windowStartBucket: null, windowEndBucket: null };
  if (!kpiTabHasScope(projectCtx)) {
    return {
      unit, engines: [], buckets: [], latest: [], latestMeasuredAt: null,
      latestBrands: [], typeTrend: [],
      trendDegraded: false, ...emptyBounds,
    };
  }
  const deadlineAt = opts.budgetMs && opts.budgetMs > 0 ? Date.now() + opts.budgetMs : undefined;
  const phaseBudget = { statementTimeoutMs: opts.statementTimeoutMs, deadlineAt };

  // 최신 스칼라 (스냅샷 창)
  const latestPhase = await withAnswerSet(
    sql`a.job_id, a.target, a.measured_at`,
    detailAnswerWhere(filters, projectCtx),
    async (db) => {
      const ans = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE},
        ${ENGINE_KPI_PER_JOB(filters, "_answer_set")}
        SELECT a.target AS target,
          count(*)::int AS answers,
          count(*) FILTER (WHERE pj.has_tracked)::int AS tracked,
          max(a.measured_at) AS last_at,
          COALESCE(sum(pj.total), 0)::int AS total,
          COALESCE(sum(pj.tracked), 0)::int AS tracked_mentions,
          COALESCE(sum(pj.sent), 0)::int AS sent,
          COALESCE(sum(pj.pos), 0)::int AS pos,
          COALESCE(sum(pj.neg), 0)::int AS neg
        FROM _answer_set a LEFT JOIN per_job pj ON pj.job_id = a.job_id
        GROUP BY 1 ORDER BY 1
      `)) as unknown as Array<{
        target: string; answers: number; tracked: number; last_at: string | Date | null;
        total: number; tracked_mentions: number; sent: number; pos: number; neg: number;
      }>;
      // 엔진 × 브랜드(D24). 같은 답변셋을 한 번 더 훑지만 브랜드 표기(rollupDisplayName)
      // 를 붙여 GROUP BY 하므로 위 문장과 합치면 job×brand 카디널리티가 per_job 을
      // 깨뜨린다 — 별도 문장. 브랜드 표기·제외 규칙은 언급 집계(1102행 부근)와 동일.
      const brands = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE},
        x AS (
          SELECT m.job_id AS job_id, a.target AS target, m.mention_count AS mention_count,
            m.brand AS brand, ${canonRollupSql(filters)} AS rid
          FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
          WHERE m.brand_rollup_entity_id IS NOT NULL
          OFFSET 0
        ),
        per AS (
          SELECT x.target AS target, ${rollupDisplayName("x")} AS name,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_own,
            x.job_id AS job_id, sum(x.mention_count) AS mentions
          FROM x LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
          GROUP BY 1, 2, 4
        )
        SELECT target, name, bool_or(is_own) AS is_own,
          count(*)::int AS answers_with_brand, COALESCE(sum(mentions), 0)::int AS mentions
        FROM per GROUP BY 1, 2 ORDER BY 1, 5 DESC, 2
      `)) as unknown as Array<{
        target: string; name: string; is_own: boolean; answers_with_brand: number; mentions: number;
      }>;
      return { ans, brands };
    },
    phaseBudget,
  );
  // 엔진당 언급 상위 N + 당사 전부 — 표시 상한(브랜드 수백~천 개를 전부 내려보내지 않는다).
  // 상수는 ENGINE_BRAND_TOP_N 한 곳에서만 온다: 화면이 이 절단을 모수로 오해하지
  // 않도록(검증자 B4) 숫자를 여기 리터럴로 두지 않는다.
  const latestBrands: EngineBrandPoint[] = [];
  {
    const perEngine = new Map<string, number>();
    for (const b of latestPhase.brands) {
      const seen = perEngine.get(b.target) ?? 0;
      if (!b.is_own && seen >= ENGINE_BRAND_TOP_N) continue;
      if (!b.is_own) perEngine.set(b.target, seen + 1);
      latestBrands.push({
        engine: b.target,
        brand: b.name,
        isTracked: b.is_own === true,
        answersWithBrand: num(b.answers_with_brand),
        mentions: num(b.mentions),
      });
    }
  }

  const latest: EngineKpiPoint[] = latestPhase.ans.map((a) => {
    const answers = num(a.answers);
    const totalMentions = num(a.total);
    return {
      engine: a.target,
      answers,
      trackedAnswers: num(a.tracked),
      exposurePct: pctOrNull(num(a.tracked), answers),
      totalMentions,
      trackedMentions: num(a.tracked_mentions),
      sovPct: pctOrNull(num(a.tracked_mentions), totalMentions),
      sentSignals: num(a.sent),
      positiveSignals: num(a.pos),
      negativeSignals: num(a.neg),
    };
  });
  const latestMeasuredAt = latestPhase.ans.reduce<string | null>((acc, r) => {
    const v = isoOrNull(r.last_at);
    return v && (!acc || v > acc) ? v : acc;
  }, null);

  // 시계열 (allRuns 창) — 1단계와 **같은 마감**을 공유한다.
  //
  // 실패해도 던지지 않는다(2026-09-01 재검증 C2): 1단계는 이미 성공했고 그 결과
  // (`latest`)는 엔진 바·히어로 분모의 원천이다. 통째로 던지면 히어로 추이·엔진
  // 섹션·유형 콤보·커버리지가 **한꺼번에** 빈다 — 실제로는 시계열 하나만 못 낸 것이다.
  // 대신 `trendDegraded: true` 로 표시해 화면이 "추이만 표시 불가"를 말하게 한다.
  let trendDegraded = false;
  type TypeTrendRow = {
    bucket: string | Date; answers: number;
    t_mention: number; t_recommendation: number; t_comparison: number; t_definition: number; t_final_choice: number;
  };
  let trend: {
    rows: Array<{
      bucket: string | Date; target: string; answers: number; tracked: number;
      measured_days: number; first_at: string | Date | null; last_at: string | Date | null;
      total: number; tracked_mentions: number; sent: number; pos: number; neg: number;
    }>;
    typeRows: TypeTrendRow[];
    bounds: { windowStartBucket: string | null; windowEndBucket: string | null };
  };
  // 추이 단계의 주 격자 축 — 스냅샷 단계(`phaseBudget` 그대로)와 **다른 예산 객체**를
  // 쓴다. 조인을 `phaseBudget` 에 넣으면 버킷도 없는 스냅샷 답변셋까지 원장을 조인한다.
  // 측정 폴백·축 경계의 주 격자 — 글로벌은 회차 앵커의 KST 주(2026-09-28 main #300).
  const weekGrid = mirrorWeekGridFor(projectCtx);
  const axis = await kpiTabTrendAxis(unit, opts.weekSource ?? "measured", weekGrid);
  try {
    trend = await withAnswerSet(
    axis.cols,
    await kpiTabTrendWhere(filters, projectCtx, opts.trendDays),
    async (db) => {
      const bounds = await readWindowBounds(db, filters, unit, opts.trendDays, weekGrid);
      // 답변 플래그 + 언급 합계를 한 패스로 — 근거·동치성 증명은 ENGINE_KPI_PER_JOB 주석.
      // `ans` 는 두 번 참조되므로 Postgres 가 자동으로 materialize 한다(셀 스냅샷
      // DISTINCT ON 을 두 문장이 각각 계산하던 종전 낭비도 함께 사라진다).
      const rows = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE}, ans AS (${kpiTabCellSnapshot()}),
        ${ENGINE_KPI_PER_JOB(filters, "ans")}
        SELECT ans.bucket AS bucket, ans.target AS target,
          count(*)::int AS answers,
          count(*) FILTER (WHERE pj.has_tracked)::int AS tracked,
          count(DISTINCT date_trunc('day', ans.measured_at))::int AS measured_days,
          min(ans.measured_at) AS first_at, max(ans.measured_at) AS last_at,
          COALESCE(sum(pj.total), 0)::int AS total,
          COALESCE(sum(pj.tracked), 0)::int AS tracked_mentions,
          COALESCE(sum(pj.sent), 0)::int AS sent,
          COALESCE(sum(pj.pos), 0)::int AS pos,
          COALESCE(sum(pj.neg), 0)::int AS neg
        FROM ans LEFT JOIN per_job pj ON pj.job_id = ans.job_id
        GROUP BY 1, 2 ORDER BY 1, 2
      `)) as unknown as Array<{
        bucket: string | Date; target: string; answers: number; tracked: number;
        measured_days: number; first_at: string | Date | null; last_at: string | Date | null;
        total: number; tracked_mentions: number; sent: number; pos: number; neg: number;
      }>;
      // 유형 × 회차(D29): 당사 언급의 유형 5 플래그를 답변 단위로 접어(bool_or) 회차별
      // "그 유형 신호가 있는 당사 노출 답변 수"를 낸다 — 유형 섹션 콤보의 유형별 선.
      // 당사 행만 읽으므로(rid IN tracked) 위 문장보다 훨씬 작은 스캔이다.
      const typeRows = (await db.execute(sql`
        WITH ans AS (${kpiTabCellSnapshot()}),
        x AS (
          SELECT m.job_id AS job_id, ${canonRollupSql(filters)} AS rid,
            m.type_mention, m.type_recommendation, m.type_comparison,
            m.type_definition, m.type_final_choice
          FROM scope_mentions m JOIN ans a ON a.job_id = m.job_id
          WHERE m.brand_rollup_entity_id IS NOT NULL
          OFFSET 0
        ),
        per_job AS (
          SELECT job_id,
            bool_or(type_mention > 0) AS t_mention,
            bool_or(type_recommendation > 0) AS t_recommendation,
            bool_or(type_comparison > 0) AS t_comparison,
            bool_or(type_definition > 0) AS t_definition,
            bool_or(type_final_choice > 0) AS t_final_choice
          FROM x WHERE x.rid IN ${trackedRollupIn(filters)}
          GROUP BY 1
        )
        SELECT ans.bucket AS bucket, count(*)::int AS answers,
          count(*) FILTER (WHERE pj.t_mention)::int AS t_mention,
          count(*) FILTER (WHERE pj.t_recommendation)::int AS t_recommendation,
          count(*) FILTER (WHERE pj.t_comparison)::int AS t_comparison,
          count(*) FILTER (WHERE pj.t_definition)::int AS t_definition,
          count(*) FILTER (WHERE pj.t_final_choice)::int AS t_final_choice
        FROM ans LEFT JOIN per_job pj ON pj.job_id = ans.job_id
        GROUP BY 1 ORDER BY 1
      `)) as unknown as TypeTrendRow[];
      return { rows, typeRows, bounds };
    },
    { ...phaseBudget, join: axis.join },
    );
  } catch (e) {
    // 원인 종류(57014 / AnswerSetDeadlineError / 그 외)를 함께 남긴다 — 메시지만
    // 남기면 Vercel 로그에서 SQL 본문에 잘려 원인을 못 읽는다(2026-09-02 실증).
    const kinds: string[] = [];
    for (let cur: unknown = e, d = 0; cur && typeof cur === "object" && d < 8; d++) {
      const c = cur as { name?: unknown; code?: unknown; cause?: unknown };
      kinds.push(`${String(c.name ?? "?")}${c.code ? `:${String(c.code)}` : ""}`);
      cur = c.cause;
    }
    console.warn(
      `[engineKpiTrend] trend phase degraded (snapshot scalars still served) [${kinds.join(" <- ")}]:`,
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    trendDegraded = true;
    trend = { rows: [], typeRows: [], bounds: { windowStartBucket: null, windowEndBucket: null } };
  }
  const typeTrend: TypeTrendBucket[] = trend.typeRows.map((r) => ({
    bucketStart: bucketKey(r.bucket),
    answers: num(r.answers),
    byType: {
      mention: num(r.t_mention),
      recommendation: num(r.t_recommendation),
      comparison: num(r.t_comparison),
      definition: num(r.t_definition),
      final_choice: num(r.t_final_choice),
    },
  }));

  const engines = [...new Set(trend.rows.map((r) => r.target))].sort();
  const byBucket = new Map<string, EngineKpiBucket>();
  for (const a of trend.rows) {
    const k = bucketKey(a.bucket);
    let b = byBucket.get(k);
    if (!b) {
      b = { bucketStart: k, measuredDays: 0, firstAt: null, lastAt: null, engines: [] };
      byBucket.set(k, b);
    }
    const answers = num(a.answers);
    const totalMentions = num(a.total);
    b.engines.push({
      engine: a.target,
      answers,
      trackedAnswers: num(a.tracked),
      exposurePct: pctOrNull(num(a.tracked), answers),
      totalMentions,
      trackedMentions: num(a.tracked_mentions),
      sovPct: pctOrNull(num(a.tracked_mentions), totalMentions),
      sentSignals: num(a.sent),
      positiveSignals: num(a.pos),
      negativeSignals: num(a.neg),
    });
    // 버킷 커버리지는 엔진 행들의 합집합 — 측정일수는 max, 창은 min/max.
    b.measuredDays = Math.max(b.measuredDays, num(a.measured_days));
    const f = isoOrNull(a.first_at);
    const l = isoOrNull(a.last_at);
    if (f && (!b.firstAt || f < b.firstAt)) b.firstAt = f;
    if (l && (!b.lastAt || l > b.lastAt)) b.lastAt = l;
  }

  return {
    unit,
    engines,
    buckets: [...byBucket.values()].sort((a, b) =>
      a.bucketStart.localeCompare(b.bucketStart),
    ),
    latest,
    latestMeasuredAt,
    latestBrands,
    typeTrend,
    trendDegraded,
    ...trend.bounds,
  };
}

// ── 3. 멘션 유형 5종 × 브랜드군 + 유형×감정 매트릭스 ─────────────────────────

export const MENTION_TYPE_KEYS = [
  "mention",
  "recommendation",
  "comparison",
  "definition",
  "final_choice",
] as const;
export type MentionTypeKey = (typeof MENTION_TYPE_KEYS)[number];

export interface TypeKpiRow {
  type: MentionTypeKey;
  /** 당사(tracked rollup) 유형 신호 합. */
  ownMentions: number;
  /** 비교(당사 아닌 경쟁 브랜드) 유형 신호 합. */
  otherMentions: number;
  totalMentions: number;
  /** 그 유형 신호가 1개 이상인 답변 수 — 노출률 분자(당사/비교 각각). */
  ownAnswers: number;
  otherAnswers: number;
  /** ownAnswers / 전체 답변 수. */
  ownExposurePct: number | null;
  otherExposurePct: number | null;
  /** ownMentions / (own+other) — 그 유형 안에서의 당사 점유율. */
  ownSharePct: number | null;
}

export interface TypeSentimentRow {
  type: MentionTypeKey;
  /** 그 유형 신호가 있는 (답변×브랜드) 행 수 — 매트릭스 셀의 모수. */
  rows: number;
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
}

export interface TypeKpi {
  /** 모집단 답변 수 — 노출률 분모. 요약 카드(Sub KPI)의 분모와 같은 창. */
  totalAnswers: number;
  totalMentions: number;
  ownMentions: number;
  rows: TypeKpiRow[];
  /**
   * 유형×감정 매트릭스. `own` = 당사만(기본), `all` = 타사 포함(토글) —
   * 스택바 분모가 당사 한정 ↔ 전 브랜드로 바뀌는 UI 토글에 대응한다.
   *
   * ⚠️ 근사임을 명시한다: 미러의 `type_*` 5컬럼과 `sentiment_*` 4컬럼은 같은
   * (답변×브랜드) 행의 **독립된 분해**라, 진짜 교차(이 유형의 이 감정이 몇 건)는
   * 원자료에 없다. 여기서는 "그 유형 신호가 있는 행들의 감정 신호 합"을 낸다 —
   * 한 행이 두 유형을 가지면 그 행의 감정이 두 유형에 각각 계상된다(중복).
   * 따라서 셀 합계는 총 감정 신호 수와 일치하지 않는다. 화면은 유형 **안에서의
   * 감정 구성비**로만 읽어야 하며, 유형 간 합산은 하지 않는다.
   * 엄밀 교차는 scope 분류 패스가 교차 카운트를 내려줘야 가능하다(후속).
   */
  sentimentMatrix: { own: TypeSentimentRow[]; all: TypeSentimentRow[] };
}

/** 멘션 유형 5종 × 브랜드군(당사/비교) 노출·점유율 + 유형×감정 매트릭스. */
export async function aggregateTypeKpiFromMirror(
  filters: StandardFilters = {},
  projectCtx?: string | string[],
  /** 문장 상한 + 전체 벽시계 예산. 실효 최악 = budgetMs + statementTimeoutMs. */
  opts: { statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<TypeKpi> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (!kpiTabHasScope(projectCtx)) {
    return {
      totalAnswers: 0,
      totalMentions: 0,
      ownMentions: 0,
      rows: [],
      sentimentMatrix: { own: [], all: [] },
    };
  }

  return withAnswerSet(
    sql`a.job_id`,
    detailAnswerWhere(filters, projectCtx),
    async (db) => {
      const totals = (await db.execute(sql`
        SELECT count(*)::int AS answers FROM _answer_set
      `)) as unknown as Array<{ answers: number }>;
      const totalAnswers = num(totals[0]?.answers);

      // 유형 5컬럼을 LATERAL VALUES 로 세로 전개해 한 번의 GROUP BY 로 낸다 —
      // 5종 × (당사/비교) × (언급·답변·감정 4계열)을 컬럼으로 펼치면 aggregate
      // 40개짜리 문장이 되어 읽기도 고치기도 어렵다.
      // 형태는 추이 ②(aggregateStandardTrendFromMirror)와 같다 — OFFSET 0 배리어로
      // 답변셋 조인·rid 계산을 먼저 확정하고, 제외 키는 names 쪽 사전 계산
      // (ROLLUP_NAMES_BARE)을 쓴다 (이식 2026-09-02: admin 무필터 24.2s → 예산 초과로
      // "유형별 측정 데이터가 없습니다" degrade 였다). 이 집계는 표시명을 안 쓰므로
      // rollupDisplayName 은 필요 없고, NOT NULL 가드와 제외 판정에만 names 가 든다.
      const rows = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE},
        base AS (
          SELECT x.job_id AS job_id,
            (x.rid IN ${trackedRollupIn(filters)}) AS is_own,
            x.p AS p, x.ne AS ne, x.ng AS ng, x.mx AS mx,
            x.type_mention, x.type_recommendation, x.type_comparison,
            x.type_definition, x.type_final_choice
          FROM (
            SELECT m.job_id AS job_id, m.brand AS brand,
              ${canonRollupSql(filters)} AS rid,
              m.sentiment_positive AS p, m.sentiment_neutral AS ne,
              m.sentiment_negative AS ng, m.sentiment_mixed AS mx,
              m.type_mention, m.type_recommendation, m.type_comparison,
              m.type_definition, m.type_final_choice
            FROM scope_mentions m
            JOIN _answer_set a ON a.job_id = m.job_id
            WHERE m.brand_rollup_entity_id IS NOT NULL
            OFFSET 0
          ) x
          LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
        ),
        ex AS (
          SELECT b.job_id, b.is_own, b.p, b.ne, b.ng, b.mx, t.type, t.n
          FROM base b
          CROSS JOIN LATERAL (VALUES
            ('mention', b.type_mention),
            ('recommendation', b.type_recommendation),
            ('comparison', b.type_comparison),
            ('definition', b.type_definition),
            ('final_choice', b.type_final_choice)
          ) AS t(type, n)
        ),
        -- (유형×브랜드군×답변)으로 먼저 접는다. 바깥에서 곧장
        -- count(DISTINCT job_id) 을 세면 플래너가 GroupAggregate 로 내려가
        -- 545,700행(= 109,140 멘션행 × 유형 5)을 **디스크 39.9MB 외부 병합
        -- 정렬**한다(프로덕션 EXPLAIN 2026-08-28: 4.19s). 답변 단위로 먼저
        -- 접으면 "그 유형이 있는 답변 수" 는 바깥의 count(*) 로 떨어지고
        -- 양쪽 다 HashAggregate 로 붙는다 — 산출은 동일.
        per AS (
          SELECT type, is_own, job_id,
            COALESCE(sum(n), 0) AS n_sum,
            count(*) FILTER (WHERE n > 0) AS rows_pos,
            COALESCE(sum(p) FILTER (WHERE n > 0), 0) AS p_sum,
            COALESCE(sum(ne) FILTER (WHERE n > 0), 0) AS ne_sum,
            COALESCE(sum(ng) FILTER (WHERE n > 0), 0) AS ng_sum,
            COALESCE(sum(mx) FILTER (WHERE n > 0), 0) AS mx_sum
          FROM ex GROUP BY 1, 2, 3
        )
        SELECT type,
          COALESCE(sum(n_sum) FILTER (WHERE is_own), 0)::int AS own_mentions,
          COALESCE(sum(n_sum) FILTER (WHERE NOT is_own), 0)::int AS other_mentions,
          count(*) FILTER (WHERE is_own AND rows_pos > 0)::int AS own_answers,
          count(*) FILTER (WHERE NOT is_own AND rows_pos > 0)::int AS other_answers,
          COALESCE(sum(rows_pos) FILTER (WHERE is_own), 0)::int AS own_rows,
          COALESCE(sum(rows_pos), 0)::int AS all_rows,
          COALESCE(sum(p_sum) FILTER (WHERE is_own), 0)::int AS own_p,
          COALESCE(sum(ne_sum) FILTER (WHERE is_own), 0)::int AS own_ne,
          COALESCE(sum(ng_sum) FILTER (WHERE is_own), 0)::int AS own_ng,
          COALESCE(sum(mx_sum) FILTER (WHERE is_own), 0)::int AS own_mx,
          COALESCE(sum(p_sum), 0)::int AS all_p,
          COALESCE(sum(ne_sum), 0)::int AS all_ne,
          COALESCE(sum(ng_sum), 0)::int AS all_ng,
          COALESCE(sum(mx_sum), 0)::int AS all_mx
        FROM per GROUP BY type
      `)) as unknown as Array<Record<string, string | number>>;

      const byType = new Map(rows.map((r) => [String(r.type), r]));
      const typeRows: TypeKpiRow[] = MENTION_TYPE_KEYS.map((type) => {
        const r = byType.get(type);
        const ownMentions = num(r?.own_mentions);
        const otherMentions = num(r?.other_mentions);
        const totalMentions = ownMentions + otherMentions;
        return {
          type,
          ownMentions,
          otherMentions,
          totalMentions,
          ownAnswers: num(r?.own_answers),
          otherAnswers: num(r?.other_answers),
          ownExposurePct: pctOrNull(num(r?.own_answers), totalAnswers),
          otherExposurePct: pctOrNull(num(r?.other_answers), totalAnswers),
          ownSharePct: pctOrNull(ownMentions, totalMentions),
        };
      });

      const matrix = (scope: "own" | "all"): TypeSentimentRow[] =>
        MENTION_TYPE_KEYS.map((type) => {
          const r = byType.get(type);
          return {
            type,
            rows: num(r?.[`${scope}_rows`]),
            positive: num(r?.[`${scope}_p`]),
            neutral: num(r?.[`${scope}_ne`]),
            negative: num(r?.[`${scope}_ng`]),
            mixed: num(r?.[`${scope}_mx`]),
          };
        });

      return {
        totalAnswers,
        // ⚠️ 아래 두 합계는 유형 5종 신호 카운트의 합이다 — mention_count 합
        // ("총 언급 수")이 아니다. 한 언급이 유형 신호를 여러 개 가지면 중복
        // 계상되므로, 화면에서 "언급 수" 라벨로 쓰지 말 것.
        totalMentions: typeRows.reduce((s, r) => s + r.totalMentions, 0),
        ownMentions: typeRows.reduce((s, r) => s + r.ownMentions, 0),
        rows: typeRows,
        sentimentMatrix: { own: matrix("own"), all: matrix("all") },
      };
    },
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
}

// ── 4. 우선 노출도: 브랜드별 답변 안 경쟁 순위 ─────────────────────────────────
//
// 산식 (2026-09-28 제품 책임자 A안, 경쟁 순위 축으로 교체): 답변(job)마다 브랜드(표시명)별로
// `tp = min(avg_position)` 을 접고, 그 답변 안에서 `rank() OVER (PARTITION BY job_id
// ORDER BY tp)` 로 **몇 번째로 언급된 브랜드인가**를 매긴 뒤, 브랜드 값 = 그 순위의 평균
// (round 1). `ranked_answers` = 순위를 받은 답변 수. 추이는 (bucket, name, job) 에 같은 규칙.
//
// 이 규칙은 미러 언급 브랜드 표(`aggregateMentionsHeadlineSql` 의 pos → rk → posagg)·
// Overview 카드 ④(`ownBrandRankPerJobSql`)·경쟁사 행(사실표 `comp_rank_sum`)과 **같은 축**이다.
// 모집단 술어(rollup 보유 + 비경쟁 제외 + 표시명 접기)도 헤드라인 `mm` 과 글자 그대로 같다.
//
// 종전(2026-08-28 ~ 09-28)은 **본문 서수**였다: `avg(avg_position)` 을 (name, job) 과
// 브랜드로 두 번 평균. 같은 화면의 카드 ④·히어로·경쟁사 행은 경쟁 순위라 한 화면에서
// 두 축이 섞였다(프리뷰 실측: 히어로 2.5 옆 경쟁사 타일 Tesla 21.3).
//
// ⚠️ 순위는 **series cap(상위 10) 적용 전**, 그 답변의 적격 브랜드 전부 위에서 매긴다.
//    cap 은 아래 JS(`capBrandSeries`)가 행을 고를 뿐 SQL 순위에 닿지 않는다: cap 밖
//    브랜드가 먼저 언급됐으면 cap 안 브랜드의 순위가 그만큼 밀린 채로 남는다.
// ⚠️ 순위는 `tp IS NOT NULL` 인 행끼리만 의미가 있다. NULL tp 는 ORDER BY 에서 뒤로 가므로
//    non-null 행의 rank() 에 영향이 없고(앞선 행 수만 센다), 그 행 자신의 순위만 NULL 로 지운다.
//    헤드라인의 `pos`(WHERE avg_position IS NOT NULL) 와 같은 결과다.
//
// ⚠️ 모집단의 답변셋 술어는 헤드라인과 **한 곳이 다르다**: 헤드라인은 `snapshotAnswerWhere`
//    (= `answerWhere`, `a.status = 'completed'` 포함), 여기는 `detailAnswerWhere`(그 술어 없음).
//    값 대조(2026-09-28)는 같은 답변셋 위에서 했다.
export interface FirstPositionPoint {
  brand: string;
  isTracked: boolean;
  /** 회차 평균 등장 순위. 순위가 매겨진 답변이 없으면 null(= 측정 없음). */
  avgPosition: number | null;
  /** 순위가 매겨진 답변 수 (avgPosition 의 모수). */
  rankedAnswers: number;
}

export interface FirstPositionBucket {
  bucketStart: string;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  brands: FirstPositionPoint[];
}

export interface FirstPositionRow {
  brand: string;
  isTracked: boolean;
  /** null = 그 창에 순위 데이터 없음. **0 이 아니다** (스펙: "측정 없음" 표기). */
  avgPosition: number | null;
  /** avgPosition 오름차순 경쟁 순위(동률 공동, 다음 순위 건너뜀). null 전파. */
  rank: number | null;
  rankedAnswers: number;
  mentions: number;
}

export interface FirstPositionResult extends TrendGapBucketKeys {
  unit: BucketUnit;
  brands: string[];
  buckets: FirstPositionBucket[];
  /** 최신 순위 테이블 — 스냅샷 창(요약 카드와 같은 모집단). */
  latest: FirstPositionRow[];
  /**
   * Overview 카드와 같은 원천(제품 책임자 2026-09-20). 우선 노출도 탭은 `engineTrend` 를 안
   * 받으므로(자기 프로미스 하나뿐) 카드 값과 Δ 입력을 **여기에** 싣는다.
   *
   * ⚠️ `overviewCards.position.avgPosition` 만 정본으로 쓴다. 히어로의 **최고 순위**
   *    (`rank`)는 스냅샷 집계에 소스가 없어 종전 미러 경로(`latest`)가 계속 낸다.
   */
  overviewCards?: OverviewCardValues;
  /** 추이 축용 — `EngineKpiTrend.overviewSlots` 와 같은 배열. */
  overviewSlots?: readonly StandardTrendBucket[];
  /** Δ 의 유일한 입력 — `EngineKpiTrend.overviewDeltaSlots` 와 같은 배열(N2). */
  overviewDeltaSlots?: readonly StandardTrendBucket[];
}

/**
 * 우선 노출도 두 문장의 트랜잭션 한정 `work_mem`(SET LOCAL). 값은 노드별 **상한**이지 할당이
 * 아니다: 작은 필터 조합은 그만큼 쓰지 않는다. 정렬·MATERIALIZED 저장의 상한은 work_mem,
 * 해시 노드의 상한은 **work_mem x hash_mem_multiplier** 다.
 *
 * 인스턴스 실측(2026-09-28): PG 17.6 · work_mem 20MB · hash_mem_multiplier 2 · shared_buffers 8GB ·
 * max_connections 380. 기본값 20MB 에서는 종전 서수 문장조차 추이 해시 접기가 9 배치로
 * 디스크를 쓰고(루트 무필터 약 135 MB), 경쟁 순위 문장은 윈도 정렬까지 디스크로 간다.
 *
 * 루트 무필터 추이 실측(가장 큰 스코프, 문장별 피크):
 *   | 시점        | 접기 그룹  | 해시 피크 | 윈도 정렬 | DISTINCT 정렬 | 비고               |
 *   | 22:25       | 1,122,277 | 208 MB   | 105 MB   | 26 MB         | 128MB 시절, 본 빌더 |
 *   | 22:40       | 1,377,243 | 245.8 MB | 123.5 MB | 36 MB         | 128MB, 독립 검증자  |
 *   | 22:51       | 1,265,367 | 224 MB   | 127 MB   | 35 MB         | 192MB, 본 빌더      |
 * 128MB 는 두 피크가 상한(256 / 128 MB)의 94% 까지 찼다. 그룹은 측정 사이에도 늘었고(원인
 * 미확정, 회차 앵커 등록이 유력) 더 늘면 external merge 로 돌아가 추이 +30% 회귀가 재발한다.
 * 192MB 면 해시 상한 384 MB · 정렬 상한 192 MB 로, 관측 최대 피크 대비 해시 56% · 정렬 51%
 * 여유(사용률 64% / 66%)다. 그룹이 대략 1.5배가 되기 전까지 메모리 안에 든다.
 * 256MB 를 넘기지 않는다(요청 경로 상한).
 *
 * 문장당 최악 메모리 = 해시 피크 + 윈도 정렬 + DISTINCT 정렬 + MATERIALIZED 저장분
 * (저장분은 EXPLAIN 에 안 나오고 상한이 work_mem 이다). 루트 무필터 추이 기준 약
 * 246 + 127 + 36 + 192 이하 = 600 MB 이하.
 *
 * ⚠️ 이 문장은 **요청 경로**다: 미러 셀 캐시 미스 때 렌더가 돌리고, 동시성 상한은 앱 풀
 * (`lib/db` 인스턴스당 10)과 Supavisor pool_size 뿐이다(SQL 로 조회 불가). 같은 256MB 를 쓰는
 * `lib/summary/generate/fold.ts` 의 접기 tx 는 러너 커넥션 2개로 묶인 **배치**라 동시성 가정이
 * 다르다. 그래서 전역 기본값이 아니라 이 두 트랜잭션에만 걸고, 셀 캐시가 반복 실행을 막는다.
 *
 * 소규모 스코프(US 추이, n=2)는 종전 1,076 ms 대비 1,226 ms(x1.14, 절대 +150 ms)다. 윈도
 * 정렬의 고정비가 작은 스코프에서 상대적으로 크다. 수용선(루트 x1.10)의 예외로 기록한다.
 */
const FIRST_POSITION_WORK_MEM = "192MB";

/** 브랜드별 등장 순위 — 회차 시계열 + 최신 순위 테이블(순위 정렬). */
export async function aggregateFirstPositionFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: {
    unit?: BucketUnit;
    topBrands?: number;
    trendDays?: number;
    /** 문장 하나의 상한(ms). 두 단계(스냅샷·추이)가 마감 하나를 공유한다 — 엔진 추이와 동일 규약. */
    statementTimeoutMs?: number;
    budgetMs?: number;
  } = {},
): Promise<FirstPositionResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  // PR④ — 추이 술어(`trendAlignedRootPreds`)가 동기라 여기서 판정을 확정한다.
  await ensureTrendGrid();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const unit = kpiTabUnit(opts.unit);
  if (!kpiTabHasScope(projectCtx)) return { unit, brands: [], buckets: [], latest: [] };
  const cap = normalizeCap(opts.topBrands);
  const deadlineAt = opts.budgetMs && opts.budgetMs > 0 ? Date.now() + opts.budgetMs : undefined;
  const phaseBudget = { statementTimeoutMs: opts.statementTimeoutMs, deadlineAt };

  // ── 성능: OFFSET 0 배리어 + names 쪽 사전 계산 (이식 2026-09-02) ─────────────
  // 형태·근거는 추이 ②(aggregateStandardTrendFromMirror) 주석이 정본이다. 이 함수는
  // 우선 노출도 탭(후속 PR)이 쓸 집계인데 직전 라운드의 지정 3개 밖이라 미최적화로
  // 남아 있었다 — 무필터 warm 실측 **38.8s** 로 이 파일에서 가장 느린 집계였다.
  // 프로덕션 A/B (ANALYZE · 무필터 · TEMP TABLE 경로 · 중앙값 · EXCEPT ALL 0/0):
  //   스냅샷  20,234 ms → 1,391 ms (md5 2980c6b2a730034847284b2c36171abd · 834행, 14.6배)
  //   추이    13,986 ms → 5,282 ms (md5 3cbaa40ddd8823a22e893c6bad612eb4 · 2,473행, 2.7배)
  // `bool_or(canonRollupSql IN …)` 은 배리어에서 한 번 계산한 `x.rid` 로 옮긴다.

  // ── 성능: 경쟁 순위 문장의 형태 (2026-09-28 재구성) ────────────────────────────
  // 경쟁 순위는 (name, job) 접기 위에 윈도(rank)를 얹는다. 형태를 안 박으면 플래너가
  // "윈도가 어차피 job 순서를 원한다"며 접기를 **정렬 기반 GroupAggregate** 로 바꾸고,
  // 그 정렬이 언급 행 전체(추이 루트 1,800,509행)를 디스크로 흘렸다(external merge 116 MB,
  // 독립 검증 실측 추이 13,230 에서 17,233 ms, +30%). 세 가지로 막는다:
  //   ① `per AS MATERIALIZED`: 접기를 윈도와 떼어 종전처럼 해시 집계로 끝낸다.
  //   ② 윈도 파티션은 `job_id` 하나: 정렬 키가 짧아진다(추이 동치 근거는 추이 문장 주석).
  //   ③ `SET LOCAL work_mem`(FIRST_POSITION_WORK_MEM): 접기 해시와 윈도 정렬(1.1M행)이
  //      메모리 안에서 끝나게 한다. 트랜잭션 한정이라 다른 문장에 새지 않는다.

  // 최신 순위 테이블 (스냅샷 창)
  const snapRows = await withAnswerSet(
    sql`a.job_id`,
    detailAnswerWhere(filters, projectCtx),
    async (db) => {
      await db.execute(sql`SET LOCAL work_mem = ${sql.raw(`'${FIRST_POSITION_WORK_MEM}'`)}`);
      return (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE},
        per AS MATERIALIZED (
          SELECT ${rollupDisplayName("x")} AS name,
            x.job_id AS job_id,
            min(x.avg_position) AS tp,
            sum(x.mention_count)::int AS mc,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_tracked
          FROM (
            SELECT m.job_id AS job_id, m.avg_position AS avg_position,
              m.mention_count AS mention_count, m.brand AS brand,
              ${canonRollupSql(filters)} AS rid
            FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
            WHERE m.brand_rollup_entity_id IS NOT NULL
            OFFSET 0
          ) x
          LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
          GROUP BY 1, 2
        ),
        rk AS (
          SELECT name, mc, is_tracked,
            CASE WHEN tp IS NULL THEN NULL
              ELSE rank() OVER (PARTITION BY job_id ORDER BY tp) END AS rk
          FROM per
        )
        SELECT name,
          round(avg(rk)::numeric, 1) AS avg_position,
          count(rk)::int AS ranked_answers,
          COALESCE(sum(mc), 0)::int AS mentions,
          bool_or(is_tracked) AS is_tracked
        FROM rk GROUP BY 1
      `)) as unknown as Array<{
        name: string; avg_position: string | number | null;
        ranked_answers: number; mentions: number; is_tracked: boolean;
      }>;
    },
    phaseBudget,
  );

  // 회차 시계열 (allRuns 창)
  //
  // ⚠️ **축 헬퍼를 거친다**(프리뷰 차단 결함 2026-09-20). 종전에는 `kpiTabTrendCols(unit)`
  //    을 `wk` 없이 불러, 축이 켜져도 TEMP 투영이 종전 컬럼만 실었다. 그런데 소비 문장
  //    (`kpiTabCellSnapshot`)은 `anchorAxisKnownEnabled()` 로 판단해 `round_date` ·
  //    `measured_at_orig` 를 참조한다 — 두 조건이 갈려 `column "round_date" does not
  //    exist`(42703)로 글로벌 대시보드의 주 단위 창이 통째로 죽었다.
  //    조인(`axis.join`)도 함께 넘긴다: 축 on 투영이 `ca.*` 를 읽기 때문이다.
  //    측정 폴백의 주 격자는 표면별이다(글로벌 = 회차 앵커의 KST 주, 2026-09-28 main #300).
  const trendAxis = await kpiTabTrendAxis(unit, "measured", mirrorWeekGridFor(projectCtx));
  const trend = await withAnswerSet(
    trendAxis.cols,
    await kpiTabTrendWhere(filters, projectCtx, opts.trendDays),
    async (db) => {
      await db.execute(sql`SET LOCAL work_mem = ${sql.raw(`'${FIRST_POSITION_WORK_MEM}'`)}`);
      const ansRows = (await db.execute(sql`
        WITH ans AS (${kpiTabCellSnapshot()})
        SELECT bucket,
          count(DISTINCT date_trunc('day', measured_at))::int AS measured_days,
          min(measured_at) AS first_at, max(measured_at) AS last_at
        FROM ans GROUP BY bucket ORDER BY bucket
      `)) as unknown as Array<{
        bucket: string | Date; measured_days: number;
        first_at: string | Date | null; last_at: string | Date | null;
      }>;

      const posRows = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE}, ans AS (${kpiTabCellSnapshot()}),
        per AS MATERIALIZED (
          SELECT x.bucket AS bucket, ${rollupDisplayName("x")} AS name,
            x.job_id AS job_id,
            min(x.avg_position) AS tp,
            sum(x.mention_count)::int AS mc,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_tracked
          FROM (
            SELECT ans.bucket AS bucket, m.job_id AS job_id,
              m.avg_position AS avg_position, m.mention_count AS mention_count,
              m.brand AS brand, ${canonRollupSql(filters)} AS rid
            FROM scope_mentions m JOIN ans ON ans.job_id = m.job_id
            WHERE m.brand_rollup_entity_id IS NOT NULL
            OFFSET 0
          ) x
          LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
          GROUP BY 1, 2, 3
        ),
        rk AS (
          -- 파티션은 job_id 하나로 충분하다(= (bucket, job_id) 와 동치): 답변셋은
          -- scope_answers(PK job_id) 한 행씩이고 붙는 조인도 PK 조인뿐이라(scope_runs.run_id,
          -- scope_answer_cycle_anchors.job_id) job 하나는 버킷 하나에만 속한다(프로덕션 실측
          -- 2026-09-28 추이 루트 257,532 job 중 다중 버킷 0). 키가 짧으면 정렬이 싸다.
          SELECT bucket, name, mc, is_tracked,
            CASE WHEN tp IS NULL THEN NULL
              ELSE rank() OVER (PARTITION BY job_id ORDER BY tp) END AS rk
          FROM per
        )
        SELECT bucket, name,
          round(avg(rk)::numeric, 1) AS avg_position,
          count(rk)::int AS ranked_answers,
          COALESCE(sum(mc), 0)::int AS mentions,
          bool_or(is_tracked) AS is_tracked
        FROM rk GROUP BY 1, 2
      `)) as unknown as Array<{
        bucket: string | Date; name: string; avg_position: string | number | null;
        ranked_answers: number; mentions: number; is_tracked: boolean;
      }>;
      return { ansRows, posRows };
    },
    // 축 on 투영이 `ca.*` 를 읽으므로 조인도 함께 넘긴다(9106 과 같은 형태).
    { ...phaseBudget, join: trendAxis.join },
  );

  // 시리즈 = 추이 창 ∪ 스냅샷 창의 브랜드. 스냅샷에 언급이 0건이어도 추이 창에
  // 있었다면 행을 남긴다 — 그 행이 "0위 0%" 가 아니라 "측정 없음"(null)으로
  // 표기돼야 한다는 것이 스펙 시나리오다.
  const totals = new Map<string, { mentions: number; isTracked: boolean }>();
  const bump = (name: string, mentions: number, tracked: boolean) => {
    const t = totals.get(name) ?? { mentions: 0, isTracked: false };
    t.mentions += mentions;
    t.isTracked = t.isTracked || tracked;
    totals.set(name, t);
  };
  for (const r of trend.posRows) bump(r.name, num(r.mentions), r.is_tracked === true);
  for (const r of snapRows) bump(r.name, 0, r.is_tracked === true);
  const series = capBrandSeries(totals, cap);
  const seriesSet = new Set(series);

  const perBucket = new Map<string, Map<string, { pos: number | null; ranked: number }>>();
  for (const r of trend.posRows) {
    if (!seriesSet.has(r.name)) continue;
    const k = bucketKey(r.bucket);
    let inBucket = perBucket.get(k);
    if (!inBucket) perBucket.set(k, (inBucket = new Map()));
    inBucket.set(r.name, {
      pos: r.avg_position != null ? Number(r.avg_position) : null,
      ranked: num(r.ranked_answers),
    });
  }

  const buckets: FirstPositionBucket[] = trend.ansRows.map((a) => {
    const k = bucketKey(a.bucket);
    const inBucket = perBucket.get(k);
    return {
      bucketStart: k,
      measuredDays: num(a.measured_days),
      firstAt: isoOrNull(a.first_at),
      lastAt: isoOrNull(a.last_at),
      brands: series.map((brand) => {
        const hit = inBucket?.get(brand);
        return {
          brand,
          isTracked: totals.get(brand)?.isTracked === true,
          // 언급이 없거나 순위가 안 매겨졌으면 null — 0 으로 채우면 "1위보다
          // 좋은 순위"라는 없는 사실이 그래프에 그려진다.
          avgPosition: hit?.pos ?? null,
          rankedAnswers: num(hit?.ranked),
        };
      }),
    };
  });

  const snapBy = new Map(snapRows.map((r) => [r.name, r]));
  const latestBase = series.map((brand) => {
    const r = snapBy.get(brand);
    return {
      brand,
      isTracked: totals.get(brand)?.isTracked === true,
      avgPosition: r?.avg_position != null ? Number(r.avg_position) : null,
      rankedAnswers: num(r?.ranked_answers),
      mentions: num(r?.mentions),
    };
  });
  // 순위표: 브랜드 간 경쟁 순위(동률 공동, 다음 순위 건너뜀)와 정렬은 탭 재순위와 같은 함수다
  // (`lib/kpi/first-position-rank.ts`). 탭이 값을 Overview 경쟁사 값으로 덮은 뒤 다시
  // 매길 때도 같은 함수를 쓴다. 순위 없는 브랜드는 rank=null 로 표 끝("측정 없음").
  const latest: FirstPositionRow[] = rankFirstPositionRows(latestBase);

  return { unit, brands: series, buckets, latest };
}

// ═══════════════════════════════════════════════════════════════════════════
// PR ④ — Citation 개편 집계 확장 (2026-09-02, 디자인 571:380)
//
// 세 집계 전부 `withAnswerSet` + `detailAnswerWhere`(인용 화면의 기존 모집단 술어)
// 위에서 돈다. 도메인 분류는 기존 인용 집계와 같은 read-time 파생(categorizeDomain +
// 운영자 오버라이드)이라 SQL 은 **도메인 단위로만** 접고 카테고리는 JS 에서 붙인다.
// ═══════════════════════════════════════════════════════════════════════════

/** 당사(tracked) 언급의 유형 플래그를 답변(job) 단위로 접은 CTE 본문. */
function OWN_TYPE_FLAGS_PER_JOB(filters: StandardFilters): SQL {
  return sql`
    SELECT m.job_id AS job_id,
      bool_or(m.type_mention > 0) AS t_mention,
      bool_or(m.type_recommendation > 0) AS t_recommendation,
      bool_or(m.type_comparison > 0) AS t_comparison,
      bool_or(m.type_definition > 0) AS t_definition,
      bool_or(m.type_final_choice > 0) AS t_final_choice
    FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
    WHERE ${trackedRollupPredicate(filters)}
    GROUP BY 1`;
}

/** 당사 언급의 감정 신호를 답변(job) 단위로 접은 CTE 본문 — 톤 판정(p>ng / ng>p)의 입력. */
function OWN_SENTIMENT_PER_JOB(filters: StandardFilters): SQL {
  return sql`
    SELECT m.job_id AS job_id,
      COALESCE(sum(m.sentiment_positive), 0)::int AS p,
      COALESCE(sum(m.sentiment_negative), 0)::int AS ng
    FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
    WHERE ${trackedRollupPredicate(filters)}
    GROUP BY 1`;
}

/** 카테고리별 인용 수 합(2026-09-02 피그마 D13/C09 — 카테고리 Δ의 직전 스냅샷 원천). */
export interface CitationCategoryTotals {
  total: number;
  byCategory: Record<string, number>;
}

/**
 * 스냅샷 창의 카테고리별 인용 수 — 인용 집계(categories)와 같은 정의(도메인 단위 read-time
 * 분류)를 **가볍게** 낸다. 직전 측정일(`dateTo = days[1]`)로 부르면 카테고리 Δ 의 분모가
 * 된다. 도메인 표·URL 은 필요 없으므로 GROUP BY 도메인 한 문장이다.
 */
export async function aggregateCitationCategoryTotalsFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: { statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<CitationCategoryTotals | null> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (!kpiTabHasScope(projectCtx)) return null;
  const overrides = await loadCitationOverrides();
  const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
  const rows = await withAnswerSet(
    sql`a.job_id`,
    detailAnswerWhere(filters, projectCtx, { hiddenFamily: "citations" }),
    async (db) =>
      (await db.execute(sql`
        SELECT ${groupKey} AS domain, min(c.category) AS category, count(*)::int AS citations
        FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
        WHERE c.domain IS NOT NULL
        GROUP BY 1
      `)) as unknown as Array<{ domain: string; category: string | null; citations: number }>,
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const cat = resolveCitationCategory(r.category, r.domain, overrides);
    const n = num(r.citations);
    byCategory[cat] = (byCategory[cat] ?? 0) + n;
    total += n;
  }
  return { total, byCategory };
}

export interface CitationTypeCategoryRow {
  type: MentionTypeKey;
  /** 그 유형 신호가 있는 당사 언급 답변들이 인용한 총 인용 수. */
  total: number;
  /** 카테고리(영문 택소노미 값) → 인용 수. */
  byCategory: Record<string, number>;
}

/**
 * 멘션 유형별 출처 카테고리 구성(디자인 "멘션 유형별 출처 카테고리 구성").
 * 답변에 당사 언급이 유형 X 신호를 가지면 그 답변의 인용 전부를 유형 X 에 귀속한다 —
 * 한 답변이 여러 유형 신호를 가지면 여러 유형에 중복 계상된다(유형 5종 신호 합 규약과
 * 동일). 분류는 도메인 단위 read-time.
 */
export async function aggregateCitationTypeCategoriesFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: { statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<CitationTypeCategoryRow[]> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  if (!kpiTabHasScope(projectCtx)) return [];
  const overrides = await loadCitationOverrides();
  const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
  const rows = await withAnswerSet(
    sql`a.job_id`,
    detailAnswerWhere(filters, projectCtx, { hiddenFamily: "citations" }),
    async (db) =>
      (await db.execute(sql`
        WITH jt AS (${OWN_TYPE_FLAGS_PER_JOB(filters)})
        SELECT ${groupKey} AS domain, min(c.category) AS category,
          count(*) FILTER (WHERE jt.t_mention)::int AS c_mention,
          count(*) FILTER (WHERE jt.t_recommendation)::int AS c_recommendation,
          count(*) FILTER (WHERE jt.t_comparison)::int AS c_comparison,
          count(*) FILTER (WHERE jt.t_definition)::int AS c_definition,
          count(*) FILTER (WHERE jt.t_final_choice)::int AS c_final_choice
        FROM scope_citations c JOIN jt ON jt.job_id = c.job_id
        WHERE c.domain IS NOT NULL
        GROUP BY 1
      `)) as unknown as Array<{
        domain: string; category: string | null; c_mention: number; c_recommendation: number; c_comparison: number;
        c_definition: number; c_final_choice: number;
      }>,
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
  const sourceCats = filters.sourceCategory?.length ? new Set(filters.sourceCategory) : null;
  const acc = new Map<MentionTypeKey, { total: number; byCategory: Map<string, number> }>();
  for (const t of MENTION_TYPE_KEYS) acc.set(t, { total: 0, byCategory: new Map() });
  for (const r of rows) {
    // 분류 정본(citation-categorizer/index.ts): 저장 category 우선 → 오버라이드 → 규칙.
    // fold(foldCitationsLive)와 같은 경로라 도메인 표와 분류가 갈리지 않는다.
    const cat = resolveCitationCategory(r.category, r.domain, overrides);
    if (sourceCats && !sourceCats.has(cat)) continue;
    const per: Array<[MentionTypeKey, number]> = [
      ["mention", num(r.c_mention)],
      ["recommendation", num(r.c_recommendation)],
      ["comparison", num(r.c_comparison)],
      ["definition", num(r.c_definition)],
      ["final_choice", num(r.c_final_choice)],
    ];
    for (const [type, n] of per) {
      if (n <= 0) continue;
      const a = acc.get(type)!;
      a.total += n;
      a.byCategory.set(cat, (a.byCategory.get(cat) ?? 0) + n);
    }
  }
  return MENTION_TYPE_KEYS.map((type) => {
    const a = acc.get(type)!;
    return { type, total: a.total, byCategory: Object.fromEntries(a.byCategory) };
  });
}

export type CitationTone = "positive" | "negative";

export interface CitationToneSummary {
  positive: { urls: number; citations: number; answers: number };
  negative: { urls: number; citations: number; answers: number };
}

/**
 * 답변 우호도별 인용 요약(타일 2장의 카운트). 톤 = 답변 안 당사 언급의 감정 신호 합
 * 비교: positive = P>NG, negative = NG>P (동률·둘 다 0은 어느 쪽도 아니다).
 * URL 수는 DISTINCT url. 카테고리 필터(sourceCategory)는 도메인 분류가 JS 파생이라
 * 여기서는 적용하지 않는다(타일은 전체 인용 기준 — 캡션이 말한다).
 */
export async function aggregateCitationToneSummaryFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: { statementTimeoutMs?: number; budgetMs?: number } = {},
): Promise<CitationToneSummary> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const empty = { urls: 0, citations: 0, answers: 0 };
  if (!kpiTabHasScope(projectCtx)) return { positive: { ...empty }, negative: { ...empty } };
  const rows = await withAnswerSet(
    sql`a.job_id`,
    detailAnswerWhere(filters, projectCtx, { hiddenFamily: "citations" }),
    async (db) =>
      (await db.execute(sql`
        WITH js AS (${OWN_SENTIMENT_PER_JOB(filters)})
        SELECT
          count(DISTINCT c.url) FILTER (WHERE js.p > js.ng)::int AS pos_urls,
          count(*) FILTER (WHERE js.p > js.ng)::int AS pos_cites,
          count(DISTINCT c.job_id) FILTER (WHERE js.p > js.ng)::int AS pos_answers,
          count(DISTINCT c.url) FILTER (WHERE js.ng > js.p)::int AS neg_urls,
          count(*) FILTER (WHERE js.ng > js.p)::int AS neg_cites,
          count(DISTINCT c.job_id) FILTER (WHERE js.ng > js.p)::int AS neg_answers
        FROM scope_citations c JOIN js ON js.job_id = c.job_id
        WHERE c.domain IS NOT NULL AND c.url IS NOT NULL
      `)) as unknown as Array<Record<string, number>>,
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
  const r = rows[0] ?? {};
  return {
    positive: { urls: num(r.pos_urls), citations: num(r.pos_cites), answers: num(r.pos_answers) },
    negative: { urls: num(r.neg_urls), citations: num(r.neg_cites), answers: num(r.neg_answers) },
  };
}

export interface CitationToneUrlRow {
  /** groupBy=domain 이면 null. */
  url: string | null;
  domain: string;
  title: string | null;
  promptText: string | null;
  citations: number;
  providers: string[];
  /** read-time 분류(영문 택소노미 값). 출처에 카테고리가 없으면 null('—', Gold 의 Other 와 다름). */
  category: string | null;
}
export interface CitationToneUrlPage {
  rows: CitationToneUrlRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 화면에 보이는 인용 URL 라벨의 SQL 쌍둥이 — `displayCitationUrl`(lib/url-display.ts)과
 * **같은 문자열**을 만든다: `#` 이후(프래그먼트) 제거 + 앞머리 `http://`·`https://` 제거.
 *
 * 순서가 JS(스킴 → 프래그먼트)와 반대여도 결과는 같다 — 스킴에는 `#` 가 없다.
 * 둘 다 대소문자를 구분한다(JS 정규식 플래그 없음 = PG regexp_replace 기본).
 * 의미 대조 표는 scope-aggregates.citation-url-search.test.ts.
 */
export function citationDisplayUrlSql(urlCol: SQL): SQL {
  return sql`regexp_replace(split_part(${urlCol}, '#', 1), '^https?://', '')`;
}

/**
 * 긍정/부정 URL 하위 페이지의 검색 술어.
 * - domain 모드: 그룹 키(화면의 도메인 라벨)에 ILIKE — 종전 그대로.
 * - url 모드: **화면에 보이는 URL**(`citationDisplayUrlSql`)에 ILIKE.
 *   2026-09-17 GGMD QA: 원본 URL 전체에 걸었더니 Gemini 인용의 `#:~:text=If%20you%20are…`
 *   조각에서 "you" 가 걸려, 화면 URL 에 검색어가 없는 행이 섞여 나왔다.
 * 빈 q 는 술어 없음. `%`·`_` 이스케이프는 하지 않는다(종전 유지).
 */
export function citationToneUrlSearchSql(q: string, byDomain: boolean, groupKey: SQL, urlCol: SQL): SQL {
  if (!q) return sql``;
  const pattern = "%" + q + "%";
  return byDomain
    ? sql`AND ${groupKey} ILIKE ${pattern}`
    : sql`AND ${citationDisplayUrlSql(urlCol)} ILIKE ${pattern}`;
}

/**
 * 긍정/부정 답변에 인용된 URL 목록(하위 페이지 585:1820) — 페이지·검색·도메인별 보기.
 * 정렬 = 인용 수 내림차순. total 은 검색 반영 전체 행 수(윈도 count).
 */
export async function aggregateCitationToneUrlsFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  opts: {
    tone: CitationTone;
    page?: number;
    pageSize?: number;
    q?: string;
    groupBy?: "url" | "domain";
    statementTimeoutMs?: number;
    budgetMs?: number;
  },
): Promise<CitationToneUrlPage> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const emptyPage = { rows: [], total: 0, page, pageSize };
  if (!kpiTabHasScope(projectCtx)) return emptyPage;
  const overrides = await loadCitationOverrides();
  const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
  const toneWhere = opts.tone === "positive" ? sql`js.p > js.ng` : sql`js.ng > js.p`;
  const q = (opts.q ?? "").trim();
  const byDomain = opts.groupBy === "domain";
  const searchWhere = citationToneUrlSearchSql(q, byDomain, groupKey, sql`c.url`);
  const rows = await withAnswerSet(
    sql`a.job_id, a.prompt_id, a.target, a.measured_at`,
    detailAnswerWhere(filters, projectCtx, { hiddenFamily: "citations" }),
    async (db) =>
      (await db.execute(sql`
        WITH js AS (${OWN_SENTIMENT_PER_JOB(filters)}),
        base AS (
          SELECT ${byDomain ? sql`NULL::text` : sql`c.url`} AS url, ${groupKey} AS domain,
            c.category AS category,
            c.title AS title, c.id AS cid, a.target AS target, a.measured_at AS measured_at, a.prompt_id AS prompt_id
          FROM scope_citations c
          JOIN js ON js.job_id = c.job_id
          JOIN _answer_set a ON a.job_id = c.job_id
          WHERE ${toneWhere} AND c.domain IS NOT NULL AND c.url IS NOT NULL ${searchWhere}
        )
        SELECT url, domain, count(*)::int AS cites, min(b.category) AS category,
          array_agg(DISTINCT target) AS targets,
          (array_agg(b.title ORDER BY b.measured_at ASC NULLS LAST, b.cid ASC))[1] AS title,
          (array_agg(sp.text ORDER BY b.measured_at ASC NULLS LAST, b.cid ASC))[1] AS prompt_text,
          count(*) OVER ()::int AS total_rows
        FROM base b LEFT JOIN scope_prompts sp ON sp.prompt_id = b.prompt_id
        GROUP BY 1, 2
        ORDER BY cites DESC, domain, url
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `)) as unknown as Array<{
        url: string | null; domain: string; cites: number; category: string | null; targets: string[] | null;
        title: string | null; prompt_text: string | null; total_rows: number;
      }>,
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
  return {
    rows: rows.map((r) => ({
      url: r.url,
      domain: r.domain,
      title: r.title,
      promptText: r.prompt_text,
      citations: num(r.cites),
      providers: (r.targets ?? []).map(providerLabel),
      category: resolveCitationCategory(r.category, r.domain, overrides),
    })),
    total: num(rows[0]?.total_rows),
    page,
    pageSize,
  };
}

export interface CitationOwnedPromptRow {
  id: string;
  promptText: string;
  funnelStage: string | null;
  citations: number;
  providers: string[];
  answers: MentionAnswerLive[];
}
export interface CitationOwnedPromptPage {
  rows: CitationOwnedPromptRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 공식(당사) URL 인용/미인용 프롬프트 전량 목록(하위 페이지 580:1146) — 페이지·검색.
 * 판정 규칙은 기존 promptSplit 과 동일(인용한 도메인 중 하나라도 도메인 단위 owned).
 * 기존 promptSplit 은 상위 20개만 실어 오므로 전량 목록은 이 경로가 담당한다.
 */
export async function aggregateCitationOwnedPromptsFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  ownedBasePrefixes: string[],
  opts: {
    owned: boolean;
    page?: number;
    pageSize?: number;
    q?: string;
    ownedSiblingUniverse?: string[];
    statementTimeoutMs?: number;
    budgetMs?: number;
  },
): Promise<CitationOwnedPromptPage> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const emptyPage = { rows: [], total: 0, page, pageSize };
  if (!kpiTabHasScope(projectCtx)) return emptyPage;
  const groupKey = citationGroupKeySql(sql`c.domain`, sql`c.url`);
  const ownedBase = citationOwnedBaseSql(ownedBasePrefixes);
  const owned = citationOwnedClause(ownedBasePrefixes, opts.ownedSiblingUniverse);
  const q = (opts.q ?? "").trim();
  const searchWhere = q ? sql`AND text ILIKE ${"%" + q + "%"}` : sql``;
  const budget = {
    statementTimeoutMs: opts.statementTimeoutMs,
    deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
  };
  return withAnswerSet(
    sql`a.job_id, a.prompt_id, a.target, a.region`,
    detailAnswerWhere(filters, projectCtx, { hiddenFamily: "citations" }),
    async (db) => {
      const rows = (await db.execute(sql`
        WITH c2 AS MATERIALIZED (
          SELECT a.prompt_id, a.job_id, a.target, ${groupKey} AS domain, ${ownedBase} AS base
          FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
          WHERE c.domain IS NOT NULL AND a.prompt_id IS NOT NULL
        ), downed AS (
          SELECT domain, bool_or(${owned}) AS d_owned FROM c2 GROUP BY domain
        ), pr AS (
          SELECT c2.prompt_id, count(*)::int AS cites,
            array_agg(DISTINCT c2.target) AS targets,
            COALESCE(bool_or(d.d_owned), false) AS owned,
            min(sp.text) AS text, min(sp.funnel_stage) AS funnel
          FROM c2 JOIN downed d ON d.domain = c2.domain
          LEFT JOIN scope_prompts sp ON sp.prompt_id = c2.prompt_id
          GROUP BY c2.prompt_id
        )
        SELECT prompt_id, text, funnel, cites, targets, count(*) OVER ()::int AS total_rows
        FROM pr WHERE owned = ${opts.owned} ${searchWhere}
        ORDER BY cites DESC, prompt_id
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `)) as unknown as Array<{
        prompt_id: string; text: string | null; funnel: string | null; cites: number;
        targets: string[] | null; total_rows: number;
      }>;
      const ids = rows.map((r) => r.prompt_id);
      const refs = ids.length === 0
        ? []
        : ((await db.execute(sql`
            SELECT prompt_id, job_id, target, region, cites FROM (
              SELECT a.prompt_id, a.job_id, a.target, a.region, count(*)::int AS cites,
                row_number() OVER (PARTITION BY a.prompt_id ORDER BY count(*) DESC, a.job_id) AS rk
              FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
              WHERE c.domain IS NOT NULL
                AND a.prompt_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
              GROUP BY a.prompt_id, a.job_id, a.target, a.region
            ) t WHERE rk <= ${CITATION_SPLIT_REFS}
          `)) as unknown as CitSplitRefRow[]);
      const refsBy = new Map<string, MentionAnswerLive[]>();
      for (const r of refs) {
        const list = refsBy.get(r.prompt_id) ?? [];
        list.push(citationAnswerRef(r));
        refsBy.set(r.prompt_id, list);
      }
      return {
        rows: rows.map((r) => ({
          id: r.prompt_id,
          promptText: r.text ?? "",
          funnelStage: r.funnel ?? null,
          citations: num(r.cites),
          providers: (r.targets ?? []).map(providerLabel),
          answers: refsBy.get(r.prompt_id) ?? [],
        })),
        total: num(rows[0]?.total_rows),
        page,
        pageSize,
      };
    },
    budget,
  );
}


// ── GEO KPI (Overview 국가별 GEO 현황, 2026-09-02) ───────────────────────────
// 기존 aggregateGeoCompetitionFromMirror(언급 수만)를 KPI 5종으로 넓힌 집계.
// 한 트랜잭션에서 세 문장: ① (국가 × 브랜드) 언급 수·등장 답변 수·순위 합·감정 합
// ② 국가별 답변 수·당사 등장 답변 수 ③ 국가별 인용 수·공식(당사) 인용 수.
// 산식은 대시보드 카드(buildMirrorKpis)와 같다 — 국가로 좁혀 다시 계산한 것뿐.
export interface GeoBrandKpiRow extends GeoBrandMention {
  /** 이 브랜드가 1회 이상 등장한 답변 수(distinct job). */
  answers: number;
  posSum: number;
  posCnt: number;
  sentPositive: number;
  sentTotal: number;
}
export interface GeoCodeTotals {
  code: string;
  answers: number;
  /** 당사(tracked) 브랜드가 1회 이상 등장한 답변 수. */
  ownAnswers: number;
  citTotal: number;
  citOwned: number;
  /**
   * 글로벌 ⑤ 분자 — 공식(HMG) 카테고리 인용 수(제품 책임자 2026-09-29, 카드 ⑤ 와 같은 정의).
   * 글로벌 리더만 싣는다. 소비는 `citationShareNumerator` 규약과 같게 "있으면 이것, 없으면
   * `citOwned`" 다(`overview-metrics.ts::marketMetrics`).
   */
  citOfficialHmg?: number;
}
export interface GeoKpiResult {
  brands: GeoBrandKpiRow[];
  codes: GeoCodeTotals[];
}

export async function aggregateGeoKpiFromMirror(
  filters: StandardFilters = {},
  projectCtx: string | string[] | undefined,
  ownedBasePrefixes: string[],
  opts: {
    statementTimeoutMs?: number;
    budgetMs?: number;
    /** 글로벌 ⑤ 분자용 공식(HMG) 그룹 키 목록 — 주면 `codes[].citOfficialHmg` 를 싣는다. */
    officialGroupKeys?: readonly string[];
  } = {},
): Promise<GeoKpiResult> {
  await ensureColumnAvailability();
  await ensureAnchorAxis();
  await bulkMirrorRunVisibleSql(sql`a.run_id`);
  const hasExplicit = Array.isArray(projectCtx) ? projectCtx.length > 0 : !!projectCtx;
  if (!hasExplicit && !getStandardRootId()) return { brands: [], codes: [] };
  const W = answerWhere(filters, projectCtx, { hiddenFamily: "all" });
  const ownedBase = citationOwnedBaseSql(ownedBasePrefixes);
  const owned = citationOwnedClause(ownedBasePrefixes);
  return withAnswerSet(
    sql`a.job_id, a.region`,
    W,
    async (db) => {
      const brandRows = (await db.execute(sql`
        WITH names AS ${ROLLUP_NAMES_BARE},
        x AS (
          SELECT a.region AS code, m.job_id AS job_id, m.mention_count AS mention_count,
            m.brand AS brand, m.avg_position AS avg_position,
            m.sentiment_positive AS sp, m.sentiment_neutral AS sne,
            m.sentiment_negative AS sng, m.sentiment_mixed AS smx,
            ${canonRollupSql(filters)} AS rid
          FROM scope_mentions m JOIN _answer_set a ON a.job_id = m.job_id
          WHERE m.brand_rollup_entity_id IS NOT NULL AND a.region IS NOT NULL
          OFFSET 0
        ),
        per AS (
          SELECT x.code AS code, ${rollupDisplayName("x")} AS brand, x.job_id AS job_id,
            sum(x.mention_count) AS mc, min(x.avg_position) AS tp,
            sum(x.sp) AS sp, sum(x.sp + x.sne + x.sng + x.smx) AS st,
            bool_or(x.rid IN ${trackedRollupIn(filters)}) AS is_trk
          FROM x LEFT JOIN names n ON n.entity_id = x.rid
          WHERE COALESCE(n.brand, x.brand) IS NOT NULL
            AND ${excludeNonCompetitorBaresSql(rollupBareName("x"), sql`x.brand`)}
          GROUP BY 1, 2, 3
        )
        SELECT code, brand,
          sum(mc)::int AS mentions,
          count(*)::int AS answers,
          COALESCE(sum(tp), 0) AS pos_sum, count(tp)::int AS pos_cnt,
          COALESCE(sum(sp), 0)::int AS sent_pos, COALESCE(sum(st), 0)::int AS sent_total,
          bool_or(is_trk) AS is_tracked
        FROM per GROUP BY 1, 2
      `)) as unknown as Array<{
        code: string; brand: string; mentions: number; answers: number;
        pos_sum: string | number; pos_cnt: number; sent_pos: number; sent_total: number; is_tracked: boolean;
      }>;
      const codeRows = (await db.execute(sql`
        SELECT a.region AS code, count(*)::int AS answers,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM scope_mentions m WHERE m.job_id = a.job_id AND ${trackedRollupPredicate(filters)}
          ))::int AS own_answers
        FROM _answer_set a WHERE a.region IS NOT NULL GROUP BY 1
      `)) as unknown as Array<{ code: string; answers: number; own_answers: number }>;
      const citRows = (await db.execute(sql`
        WITH c2 AS (
          SELECT a.region AS code, ${citationGroupKeySql(sql`c.domain`, sql`c.url`)} AS domain, ${ownedBase} AS base
          FROM scope_citations c JOIN _answer_set a ON a.job_id = c.job_id
          WHERE c.domain IS NOT NULL AND a.region IS NOT NULL
        )
        SELECT code, count(*)::int AS cit_total, count(*) FILTER (WHERE ${owned})::int AS cit_owned${
          opts.officialGroupKeys
            ? sql`,
          count(*) FILTER (WHERE domain = ANY(${sql.param([...opts.officialGroupKeys])}::text[]))::int AS cit_official`
            : sql``}
        FROM c2 GROUP BY 1
      `)) as unknown as Array<{ code: string; cit_total: number; cit_owned: number; cit_official?: number }>;
      const citBy = new Map(citRows.map((r) => [r.code, r]));
      return {
        brands: brandRows.map((r) => ({
          code: r.code,
          brand: r.brand,
          mentions: num(r.mentions),
          isTracked: r.is_tracked === true,
          answers: num(r.answers),
          posSum: Number(r.pos_sum) || 0,
          posCnt: num(r.pos_cnt),
          sentPositive: num(r.sent_pos),
          sentTotal: num(r.sent_total),
        })),
        codes: codeRows.map((r) => ({
          code: r.code,
          answers: num(r.answers),
          ownAnswers: num(r.own_answers),
          citTotal: num(citBy.get(r.code)?.cit_total),
          citOwned: num(citBy.get(r.code)?.cit_owned),
          ...(opts.officialGroupKeys ? { citOfficialHmg: num(citBy.get(r.code)?.cit_official) } : {}),
        })),
      };
    },
    {
      statementTimeoutMs: opts.statementTimeoutMs,
      deadlineAt: opts.budgetMs ? Date.now() + opts.budgetMs : undefined,
    },
  );
}
