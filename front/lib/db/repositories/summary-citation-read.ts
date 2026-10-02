import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  readTrendAggregates,
  trendWhere,
  type TrendReadScope,
  type TrendDomainRow,
} from "@/lib/db/repositories/summary-trend-aggregates";
import {
  providerLabel,
  engineCategorySlices,
  type CitationsLive,
  type CitationDomainLive,
  type CitationCategorySlice,
  type EngineCategorySlice,
} from "@/lib/scope/result-adapter";
import { loadCitationOverrides } from "@/lib/citation-categorizer/overrides-loader";
import {
  resolveCitationCategory,
  type CitationOverrideMap,
} from "@/lib/citation-categorizer";
import type { SourceDomainSlice } from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 인용 화면(S3/S6) 공통 리더 — 집계층 롤업 + **2단 조회** (PR② T7)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: 플랜 `internal-kb/hmg-geo-perf-pr2-aggregate-layer-plan-2026-09-10.md`
//   §3-4 판정표 9(출처 도넛)·10(카테고리)·15(고유 도메인/카테고리 수)·**19(도메인별
//   프롬프트 수·커버리지 = 2단 조회)** · §3-5 E2 · §9 T7.
//
// ── 왜 두 층을 함께 읽나 ────────────────────────────────────────────────────
//
// 도메인 표의 값 일곱 중 다섯(`citations`·`share`·`isOurs`·`category`·순서)은 집계층
// `summary_trend_domains` 의 SUM 만으로 나온다. 남은 둘 — **프롬프트 수**와 **인용
// 답변 수(커버리지)** — 은 `COUNT(DISTINCT …)` 이고 집계층에서 복원되지 않는다:
//   · `prompt` 는 (engine, country) 키 그룹을 **가로지른다** → SUM 이 이중 계상.
//   · `citing_answers` 는 집계층에도 있지만 접기 키가
//     `(group_key, domain, matched_base, base_norm_null)` 이라 한 답변이 같은 도메인을
//     서로 다른 base 로 인용하면 행이 갈려 두 번 세어진다 — **상한이지 distinct 가
//     아니다**(T4 `TrendDomainRow.citingAnswers` 주석: 글로벌 한 도메인 최대 +1,748).
// 그래서 집계층에서 **상위 N group_key 를 고르고**, 세부층 `summary_domain_citations`
// 에서 **그 N 개만** distinct 를 다시 센다(§3-4 19). 이것이 `enrichTopDomains` 다.
//
// ── 세부층 술어에 job 세미조인을 쓰지 않는다 ────────────────────────────────
//
// 오늘의 사실표 리더(`summary-{global,website}-aggregates.ts::factScope`)는
// `job_id IN (SELECT job_id FROM summary_answers WHERE …)` 로 축을 건다. 그런데
// `summary_domain_citations` 는 **같은 축 컬럼을 전부 denormalize 해서 들고 있다**
// (0059 + 0060 `unit_owned_citations` + 0063 `presence_set`). 그래서 세미조인 없이
// 직접 술어를 걸 수 있고, 그 편이 인덱스(`summary_domain_key_idx`)를 탄다.
//
// 2026-09-10 라이브 대조(글로벌 회차 `74eca7fb`, 읽기 전용):
//   · 직접 술어 10,537 그룹 · 세미조인 10,537 그룹 · **불일치 0**
//   · 전체 group_key 355.92 ms / **top-80 한정 182.38 ms**
//     (둘 다 `summary_domain_citations_…_cycle_id_generation_id_group_idx` 사용)
// 값이 같고 절반이 싸다 — 그래서 직접 술어 + top-N 한정이다. 술어 자체는 호출부
// (표면별 리더)가 만들어 넘긴다. 여기서 두 번째 어휘를 만들지 않기 위해서다.
//
// ── 이 경로가 **내지 않는** 값 (그래서 소비자를 고른다) ─────────────────────
//
// `CitationsLive` 는 롤업 말고 드릴다운·추이도 싣는다. 그중 셋은 집계층에도
// 세부층에도 원천이 없다:
//   · `domains[].urls` — 인용 **원문 URL·제목**. 사실표 6표 어디에도 `url` 컬럼이
//     없다(0059). 플랜 §3-4 20 이 "미러 `scope_citations` — 사실표 밖, **PR③**" 로
//     이미 판정한 항목이다.
//   · `domains[].promptList` / `promptSplit` — 프롬프트 본문·답변 ref 드릴다운.
//     세부층에 prompt_id·job_id 는 있지만 본문은 `summary_prompt_dim` 조인이 필요하고,
//     답변 ref 의 region·target 까지 맞추면 문장이 3개 더 는다. PR③.
//   · `trend` / `categoryTrend` — **주 단위 시계열**. 스냅샷 회차 1개에서는 원천이
//     없다(미러는 창 전체의 day count 를 따로 읽는다).
// 이 셋은 `null`/`[]` 로 나간다. 따라서 **그 필드를 그리는 화면은 이 경로를 쓰면
// 안 된다** — 호출부(`lib/scope/server.ts`)가 소비자 단위로 게이트한다. 조용히
// 빈 값을 그리는 것보다 느린 쪽이 낫다는 이 PR 의 일관된 자세다(§5-2).

const num = (v: unknown): number => Number(v ?? 0);
/** 미러 `foldCitationsLive::pctOf` 와 **같은 반올림** — 소수 1자리, 분모 0 → 0. */
const pctOf = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** §3-4 19 의 "top-80". 미러의 드릴다운 캡(`CITATION_DRILLDOWN_DOMAINS`)과 같은 값이다. */
export const CITATION_TOP_DOMAINS = 80;

// ── 2단 조회 (§3-4 19 · 수용 기준 ①②③) ─────────────────────────────────────

export interface DomainEnrichCounts {
  /** 그 group_key 를 인용한 **고유 프롬프트 수**. */
  prompts: number;
  /** 그 group_key 를 인용한 **고유 답변(job) 수** — 커버리지 분자. */
  citingAnswers: number;
}

/**
 * 2단 조회 문장. 형태를 테스트가 고정할 수 있게 SQL 만 만든다.
 *
 * `group_key = ANY($top)` 이 **선행 술어**여야 `summary_domain_key_idx
 * (cycle_id, generation_id, group_key)` 를 탄다 — 배열은 `sql.param` 한 개로 넘겨
 * (스칼라 펼침 금지, T4 바인드 규율) 계획 재사용을 살린다.
 */
export function domainEnrichSql(detailWhere: SQL, groupKeys: readonly string[]): SQL {
  return sql`
    SELECT group_key,
           count(DISTINCT prompt_id)::int AS prompts,
           count(DISTINCT job_id)::int    AS citing_answers
      FROM summary_domain_citations
     WHERE ${detailWhere}
       AND group_key = ANY(${sql.param([...groupKeys])}::text[])
     GROUP BY group_key`;
}

/**
 * 집계층이 고른 상위 group_key 의 **정확한** distinct 수를 세부층에서 받아 온다.
 * 키가 0개면 문장을 아예 내지 않는다(빈 `ANY` 는 항상 0행이므로 왕복이 낭비다).
 */
export async function enrichTopDomains(
  detailWhere: SQL,
  groupKeys: readonly string[],
): Promise<Map<string, DomainEnrichCounts>> {
  const out = new Map<string, DomainEnrichCounts>();
  if (groupKeys.length === 0) return out;
  const rows = (await getDb().execute(domainEnrichSql(detailWhere, groupKeys))) as unknown as Array<{
    group_key: string;
    prompts: unknown;
    citing_answers: unknown;
  }>;
  for (const r of rows) {
    out.set(r.group_key, { prompts: num(r.prompts), citingAnswers: num(r.citing_answers) });
  }
  return out;
}

// ── 엔진 × 카테고리 (`engineCategories`) ────────────────────────────────────

/**
 * 집계층 `(engine, group_key)` 한 문장. 리더(`readTrendAggregates`)에 이 축이 없어서
 * **`trendWhere` 탈출구**로 직접 만든다(T4 머리 주석이 허용한 경로). 축을 리더에
 * 올리는 편이 원칙이지만 이 라운드에서 `summary-trend-aggregates.ts` 는 T1 과의
 * 병렬 작업 경계라 만지지 않는다 — 반복해서 필요해지면 그때 `axes` 로 올린다.
 *
 * 같은 표를 두 번 스캔하게 되는 것(§3-3 규칙 3 위반)은 사실이다. 대신 얻는 것은
 * 미러 경로의 `scope_citations ⋈ scope_answers` 전량 스캔 제거다(실측 4,427 ms).
 */
export function trendEngineCategorySql(scope: TrendReadScope): SQL {
  return sql`
    SELECT engine, group_key, COALESCE(sum(citations), 0)::bigint AS citations
      FROM summary_trend_domains
     WHERE ${trendWhere(scope)}
     GROUP BY engine, group_key`;
}

// ── 조립 ────────────────────────────────────────────────────────────────────

export interface CitationReadInput {
  /** 집계층 스코프 — 호출부(표면별 리더)가 `planTrendRead` 를 통과시킨 것. */
  trend: TrendReadScope;
  /**
   * 세부층 `summary_domain_citations` 직접 술어(회차·주 파티션·필터 축 전부).
   * **job 세미조인이 아니다** — 머리 주석의 대조 실측 참조.
   */
  detailWhere: SQL;
  /** 커버리지 분모 = 이 회차·필터의 답변 수. `summary_answers` 술어. */
  answerWhere: SQL;
  /** 2단 조회 대상 수. 기본 80(§3-4 19). */
  topDomains?: number;
}

/** 집계층 읽기 결과 — `empty` 는 폴백 신호다(값 0 이 아니다). T6 과 같은 타입. */
export type CitationTrendRead = { empty: true } | { empty: false; value: CitationsLive };

const EMPTY_READ = { empty: true } as const;

/** 도메인 표 행 — 그룹 축(`axis === "group"`)만. `isRest` 잔여 행은 이름이 없다. */
const namedGroups = (rows: TrendDomainRow[]): TrendDomainRow[] =>
  rows.filter((r) => r.axis === "group" && !r.isRest && r.groupKey !== null);

/**
 * 카테고리 축 롤업 — 미러 `foldCitationsLive` 와 **같은 순서·같은 판정**.
 *
 * ⚠️ `resolveCitationCategory` 의 첫 인자(scope 가 보낸 행 단위 category)를 `null` 로
 *    넘긴다. 사실표 6표에 그 컬럼이 없기 때문이다(0059). 미러는 `c.category` 를
 *    넘기지만 **2026-08-28 실측 기준 `scope_citations.category` 는 246만 행 중
 *    non-null 656건**이고, `resolveCitationCategory` 는 택소노미 밖 문자열을 버리므로
 *    실질 차이는 그 656건 안에서만 생길 수 있다. 패리티 하네스가 이 가정을 검증한다.
 */
function categoryOf(groupKey: string, overrides: CitationOverrideMap): string {
  return resolveCitationCategory(null, groupKey, overrides);
}

/**
 * 인용 화면의 **롤업**을 집계층 + 2단 조회로 낸다. 문장 **4개**:
 *   1. 집계층 `domains`(`only`) — 도메인 표·카테고리·⑤ 분모/분자·고유 도메인 수
 *   2. 집계층 `(engine, group_key)` — `engineCategories`
 *   3. 세부층 `summary_answers` count — 커버리지 분모
 *   4. 세부층 2단 조회 — top-N 의 프롬프트 수·인용 답변 수
 *
 * 반환 `domains` 는 **인용 수 상위 `topDomains` 개**다. 그 밖의 그룹을 0 으로 채워
 * 내보내지 않는다 — 2단 조회를 안 한 행의 `prompts`/`coverageRate` 는 알 수 없는
 * 값이지 0 이 아니기 때문이다(합계·분모는 아래 `summary` 가 전량 기준으로 보존한다).
 */
export async function summaryCitationsFromTrend(
  input: CitationReadInput,
): Promise<CitationTrendRead> {
  const top = input.topDomains ?? CITATION_TOP_DOMAINS;
  const overrides = await loadCitationOverrides();
  const sourceCats = input.trend.filters.sourceCategory?.length
    ? new Set(input.trend.filters.sourceCategory)
    : null;

  const db = getDb();
  const [agg, engineRows, answerRows] = await Promise.all([
    readTrendAggregates(input.trend, { only: ["domains"] }),
    db.execute(trendEngineCategorySql(input.trend)) as unknown as Promise<
      Array<{ engine: string | null; group_key: string; citations: unknown }>
    >,
    db.execute(sql`
      SELECT count(*)::int AS answers FROM summary_answers WHERE ${input.answerWhere}
    `) as unknown as Promise<Array<{ answers: unknown }>>,
  ]);
  if (agg.empty) return EMPTY_READ;

  // ① 그룹 축 → 카테고리 합계 · 도메인 표 재료. `sourceCategory` 는 미러와 **같은
  //    지점**(분모 합산 직전)에서 적용한다 — 타일과 표가 늘 같은 모집단을 말하도록.
  const groups = namedGroups(agg.domains)
    .map((r) => ({ row: r, category: categoryOf(r.groupKey as string, overrides) }))
    .filter((g) => !sourceCats || sourceCats.has(g.category));
  if (groups.length === 0) return EMPTY_READ; // 인용 0건 = 미러가 null/빈형태를 가른다

  let totalCitations = 0;
  let ownedCitations = 0;
  const categoryTotals = new Map<string, number>();
  for (const g of groups) {
    totalCitations += g.row.citations;
    ownedCitations += g.row.ownedCitations;
    categoryTotals.set(g.category, (categoryTotals.get(g.category) ?? 0) + g.row.citations);
  }
  if (totalCitations === 0) return EMPTY_READ;

  // ② 2단 조회 — 인용 수 상위 N group_key 만. 정렬 tie-break 는 미러의
  //    `b[1]-a[1] || a[0].localeCompare(b[0])` 와 같다.
  const ranked = [...groups].sort(
    (a, b) =>
      b.row.citations - a.row.citations ||
      (a.row.groupKey as string).localeCompare(b.row.groupKey as string),
  );
  const topKeys = ranked.slice(0, top).map((g) => g.row.groupKey as string);
  const enriched = await enrichTopDomains(input.detailWhere, topKeys);

  const sampledAnswers = num(answerRows[0]?.answers);
  const domains: CitationDomainLive[] = ranked.slice(0, top).map((g) => {
    const key = g.row.groupKey as string;
    const e = enriched.get(key);
    return {
      domain: key,
      citations: g.row.citations,
      share: pctOf(g.row.citations, totalCitations),
      prompts: e?.prompts ?? 0,
      coverageRate: pctOf(e?.citingAnswers ?? 0, sampledAnswers),
      isOurs: g.row.isOurs,
      category: g.category,
      subcategory: null, // 미러에도 없다 — 종전 경로도 항상 null
      urls: [], // 사실표 밖(§3-4 20 · PR③) — 머리 주석 참조
      promptList: [], // 세부층 드릴다운 미구현(PR③)
    } satisfies CitationDomainLive;
  });

  // ③ 엔진 × 카테고리. 엔진 라벨·정렬은 미러 `engineCategorySlices` 를 그대로 쓴다.
  const engineCats = new Map<string, Map<string, number>>();
  for (const r of engineRows) {
    const cat = categoryOf(r.group_key, overrides);
    if (sourceCats && !sourceCats.has(cat)) continue;
    const label = providerLabel(r.engine ?? "");
    const m = engineCats.get(label) ?? new Map<string, number>();
    m.set(cat, (m.get(cat) ?? 0) + num(r.citations));
    engineCats.set(label, m);
  }

  const categories: CitationCategorySlice[] = [...categoryTotals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return {
    empty: false,
    value: {
      summary: {
        total: totalCitations,
        // 고유 도메인 수는 **절단 전 그룹 수**다(§3-4 15) — 표가 top-N 이어도 개수는 전량.
        uniqueDomains: groups.length,
        // 분모 0 → null("—", 측정 대기)와 0%(인용은 있으나 당사 0)를 가른다.
        officialOwnShare: pctOf(ownedCitations, totalCitations),
      },
      asOf: asOfOfSet(input.trend),
      domains,
      categories,
      trend: null, // 주 단위 시계열 — 스냅샷 회차 1개에 원천 없음(머리 주석)
      categoryTrend: null,
      engineCategories: engineCategorySlices(engineCats) as EngineCategorySlice[] | null,
      // `promptSplit` 은 **키 자체를 넣지 않는다** — `undefined` 가 "미계산" 이고
      // `null` 은 "계산했는데 자사 인용 0" 이다(뷰의 섹션 숨김 판정이 갈린다).
    },
  };
}

/** 회차 집합의 최신 anchor — T6 `asOfOf` 와 같은 규칙(측정 기준일 = 회차 기준). */
function asOfOfSet(scope: TrendReadScope): string | null {
  const anchors = scope.set.cycles.map((c) => c.cycleAnchorAt).filter(Boolean);
  if (anchors.length === 0) return null;
  const ms = Date.parse(anchors.reduce((a, b) => (a > b ? a : b)));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

// ── 출처 도넛 (SLIM) ────────────────────────────────────────────────────────

/**
 * 출처 도넛 — 집계층 `domain` 축. 문장 **1개**.
 *
 * `isOurs` 는 ⑤ 분자와 **판정이 다르다**(오늘도 그렇다): 도메인 그룹핑에서는 경로
 * 수준 좁히기를 표현할 수 없어 **도메인 서픽스 정규식**을 쓴다(미러 SA:3623-3625 ·
 * 웹사이트판 `summaryWebsiteSourceComposition` 과 같은 규칙). 그래서 리더가 실어
 * 보내는 `isOurs`(= base 판정)를 쓰지 않고 같은 정규식을 도메인 문자열에 적용한다.
 */
export function sourceCompositionFrom(
  domains: TrendDomainRow[],
  ownedDomainPattern: string | null,
): SourceDomainSlice[] {
  const re = ownedDomainPattern ? new RegExp(ownedDomainPattern, "i") : null;
  const rows = domains
    .filter((r) => r.axis === "domain" && !r.isRest && r.domain !== null)
    .sort((a, b) => b.citations - a.citations);
  const total = rows.reduce((s, r) => s + r.citations, 0);
  return rows.map((r) => {
    const domain = r.domain as string;
    return {
      domain,
      citations: r.citations,
      share: pctOf(r.citations, total),
      isOurs: re ? re.test(domain) : false,
    };
  });
}

/** 테스트가 형태를 고정할 수 있게 노출한다. */
export const __testables = { domainEnrichSql, trendEngineCategorySql, categoryOf, pctOf };
