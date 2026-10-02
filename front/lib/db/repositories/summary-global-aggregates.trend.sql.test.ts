import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  S1_STATEMENT_KEYS,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
  __trendTestables,
} from "./summary-global-aggregates";
import {
  buildTrendStatements,
  type TrendAggregates,
  type TrendBrandRow,
  type TrendDomainRow,
  type TrendOwnRow,
  type TrendReadScope,
} from "./summary-trend-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

// S1(글로벌 대시보드)의 **집계층 경로 형태**를 고정한다 — PR② T6 수용 기준 ①.
//   ① S1 한 렌더가 내는 문장 = **3** (카드와 GEO 가 나눠 쓴다). 라운드 1은 카드 3 + GEO 2 였다.
//   ② 그 문장들은 **세부층 표를 건드리지 않는다**(job 조인 0 — 3,943 ms 의 정체).
//   ③ 안 쓰는 `summary_trend_answers` 는 발행되지 않는다.
//   ④ GEO 가 필요로 하는 축이 그 3문장 안에 서 있다(국가×브랜드 · 국가별 인용).
// 값 대조는 `scripts/summary/parity-global-s1.ts`(라이브 DB) 몫이다.

const dialect = new PgDialect();
const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const globalSet: CycleSet = {
  surface: "global",
  mode: "snapshot",
  cycles: [
    {
      cycleId: UUID(1),
      generationId: UUID(2),
      projectId: UUID(3),
      cycleAnchorAt: "2026-08-31T00:00:00.000Z",
      cycleWeek: "2026-08-31",
    },
  ],
  cycleKey: `${UUID(1)}:${UUID(2)}`,
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: 1,
};

const s1Scope: TrendReadScope = {
  set: globalSet,
  filters: {},
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: ["https://www.hyundai.com/"],
  limits: S1_TREND_LIMITS,
  axes: S1_TREND_AXES,
};

const s1Statements = () => buildTrendStatements(s1Scope, { only: S1_STATEMENT_KEYS });
const textOf = (key: string) =>
  dialect.sqlToQuery(s1Statements().find((s) => s.key === key)!.sql).sql;

describe("수용 기준 ① — S1 한 렌더가 내는 집계층 문장 = 3", () => {
  it("own·brands·domains 3문장이고 표가 서로 다르다", () => {
    const st = s1Statements();
    expect(st).toHaveLength(3);
    expect(st.map((s) => s.table)).toEqual([
      "summary_trend_own",
      "summary_trend_brands",
      "summary_trend_domains",
    ]);
  });

  it("`summary_trend_answers` 는 발행되지 않는다", () => {
    for (const st of s1Statements()) {
      expect(dialect.sqlToQuery(st.sql).sql).not.toContain("summary_trend_answers");
    }
  });

  it("각 표는 한 번만 스캔된다(§3-3 규칙 3)", () => {
    expect(textOf("brands").match(/summary_trend_brands/g)).toHaveLength(1);
    expect(textOf("domains").match(/summary_trend_domains/g)).toHaveLength(1);
    expect(textOf("own").match(/summary_trend_own/g)).toHaveLength(1);
  });
});

describe("job 조인 0 — 세부층 표를 건드리지 않는다", () => {
  // 오늘의 세부층 리더는 `job_id IN (SELECT job_id FROM summary_answers WHERE …)` 를
  // 브랜드·도메인 표에 건다. 그 한 줄이 223 ms → 3,943 ms 를 만들었다(플랜 §0-2).
  const DETAIL_TABLES = [
    "summary_answers",
    "summary_brand_mentions",
    "summary_domain_citations",
    "summary_target_hits",
    "summary_cycle_jobs",
  ];
  it("세부층 표 이름도 `job_id` 세미조인도 없다", () => {
    for (const st of s1Statements()) {
      const text = dialect.sqlToQuery(st.sql).sql;
      for (const t of DETAIL_TABLES) expect(text).not.toContain(t);
      expect(text).not.toContain("job_id");
    }
  });
});

describe("라운드 2 — GEO 가 카드와 같은 3문장을 쓴다", () => {
  it("브랜드 문장이 국가×브랜드 축을 함께 낸다(GEO 전용 스캔 없음)", () => {
    expect(textOf("brands")).toContain("GROUPING SETS ((brand_name), (country, brand_name))");
  });

  it("도메인 문장에 국가 축이 서 있다(`axes.domainCountry`)", () => {
    const text = textOf("domains");
    expect(text).toContain("(country)");
    // 국가×카테고리는 **켜지 않는다** — T4 실측 172→361 ms.
    expect(text).not.toContain("(country, group_key)");
  });

  it("국가 축은 절단하지 않는다(`geoBrandPerCountry: null`)", () => {
    // 절단하면 `marketStats` 의 분모(그 시장 전 브랜드 언급 합)가 이름 없는 잔여 행으로
    // 접혀 SoV 가 틀린다. 기본값(20)을 쓴 문장과 달라야 한다.
    const withLimit = dialect.sqlToQuery(
      buildTrendStatements({ ...s1Scope, limits: undefined }, { only: ["brands"] })[0].sql,
    ).sql;
    expect(textOf("brands")).not.toEqual(withLimit);
  });
});

// ── 매핑 규칙 (순수 함수) ───────────────────────────────────────────────────

const ownRow = (p: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "total", bucket: null, cycleAnchorAt: null, keyRows: 1,
  monitored: 0, trackedAnswers: 0, multiAnswers: 0, top1Answers: 0, top3Answers: 0,
  rankSum: 0, rankedAnswers: 0, ownMentions: 0, ownPositive: 0, ownSignals: 0,
  compMentions: 0, allCitations: 0, ownCitations: 0, ownFallbackCitations: 0,
  tileOwnMentions: 0, citingAnswers: 0, citMonitored: 0, ...p,
});
const brandRow = (p: Partial<TrendBrandRow>): TrendBrandRow => ({
  axis: "brand", country: null, engine: null, brandName: "X", isRest: false, restCount: 0,
  keyRows: 1, isTracked: false, mentions: 0, answers: 0, rankSum: 0, rankedAnswers: 0,
  compRankSum: 0, compRankedAnswers: 0,
  top3Answers: 0, positive: 0, neutral: 0, negative: 0, mixed: 0, typeMention: 0,
  typeRecommendation: 0, typeComparison: 0, typeDefinition: 0, typeFinalChoice: 0, ...p,
});
const domainRow = (p: Partial<TrendDomainRow>): TrendDomainRow => ({
  axis: "total", isRest: false, restCount: 0, keyRows: 1, groupKey: null, domain: null,
  country: null, citations: 0, citingAnswers: 0, ownedCitations: 0, isOurs: false, ...p,
});
const aggOf = (p: Partial<TrendAggregates>): TrendAggregates => ({
  own: [], answers: [], brands: [], domains: [], empty: false, ...p,
});

describe("브랜드 축 판별은 `axis` 로만 한다", () => {
  // ⚠️ `country === null` 로 가르면 안 된다 — `axes.engineBrand` 를 켜면 엔진 행도
  //    country 가 null 이다(리더 라운드 3 계약).
  it("엔진 행이 섞여도 브랜드 타일·총언급에 들어가지 않는다", () => {
    const agg = aggOf({
      own: [ownRow({ monitored: 10 })],
      brands: [
        brandRow({ axis: "brand", brandName: "A", mentions: 7 }),
        brandRow({ axis: "engine", engine: "chatgpt", brandName: "A", mentions: 7 }),
        brandRow({ axis: "country", country: "KR", brandName: "A", mentions: 7 }),
      ],
    });
    const out = __trendTestables.toStandardAggregates(agg, globalSet, agg.own[0]);
    expect(out.brands).toHaveLength(1);
    expect(out.totalMentions).toBe(7);
  });

  it("절단 잔여 행은 목록에서 빠지고 총언급에는 더해진다", () => {
    const agg = aggOf({
      own: [ownRow({ monitored: 10 })],
      brands: [
        brandRow({ brandName: "A", mentions: 7 }),
        brandRow({ brandName: null, isRest: true, restCount: 42, mentions: 5 }),
      ],
    });
    const out = __trendTestables.toStandardAggregates(agg, globalSet, agg.own[0]);
    expect(out.brands.map((b) => b.name)).toEqual(["A"]);
    expect(out.totalMentions).toBe(12);
  });
});

// ── 인용 분모는 **인용 계열 모수**다 (0071, 2026-09-18) ──────────────────────
//
// `hidden_scope='citations'` 회차는 집합에 남고 인용 계열에서만 빠진다(cycle-set.ts).
// 분자에서 뺀 회차를 분모에 남기면 "인용 보유 답변 비율" 이 체계적으로 낮아진다.
describe("인용 분모(citations.sampledAnswers)", () => {
  it("monitored 가 아니라 citMonitored 를 쓴다", () => {
    const agg = aggOf({
      own: [ownRow({ monitored: 100, citMonitored: 70, citingAnswers: 42 })],
    });
    const out = __trendTestables.toStandardAggregates(agg, globalSet, agg.own[0]);
    expect(out.totalAnswers).toBe(100);
    expect(out.citations.sampledAnswers).toBe(70);
    expect(out.citations.answersWithCitation).toBe(42);
  });

  it("열이 없으면(뺄 회차 없음) 모수로 접는다", () => {
    const agg = aggOf({
      own: [{ ...ownRow({ monitored: 55 }), citMonitored: undefined } as never],
    });
    const out = __trendTestables.toStandardAggregates(agg, globalSet, agg.own[0]);
    expect(out.citations.sampledAnswers).toBe(55);
  });
});

// ── 경쟁사 행 매핑 (PR④ B1) ─────────────────────────────────────────────────
//
// 이 매핑은 **미러 산식을 옮긴 것**이고(`scope-aggregates.ts:3465-3489`), 0069(PR④-b)
// 이후로는 **다섯 열 전부 산식이 같다** — 남는 차이는 창·모수뿐이다(미러 = 전 이력 ·
// 집계층 = 회차 스냅샷). 그 경계를 테스트로 못 박는다 — 산식이 조용히 갈리면 고객이 보는
// 경쟁사 순위가 바뀌는데 화면으로는 안 보인다.
describe("경쟁사 행 매핑 — 미러 산식을 그대로 옮긴다", () => {
  const agg = aggOf({
    own: [ownRow({ monitored: 200 })],
    brands: [
      brandRow({
        brandName: "Tesla", mentions: 30, answers: 25,
        // 본문 서수(rankSum)와 경쟁 순위(compRankSum)를 **일부러 다른 값**으로 둔다 —
        // 매핑이 옛 컬럼으로 돌아가면 값이 바로 갈려 보인다.
        rankSum: 40, rankedAnswers: 16,
        compRankSum: 12, compRankedAnswers: 16,
        positive: 6, neutral: 3, negative: 1, mixed: 0,
      }),
      brandRow({
        brandName: "BMW", mentions: 10, answers: 8,
        rankSum: 9, rankedAnswers: 3,
        compRankSum: 6, compRankedAnswers: 4,
      }),
      // 절단 잔여 — 목록에는 없지만 **점유율 분모에는 들어간다**.
      brandRow({ brandName: null, isRest: true, restCount: 12, mentions: 60 }),
    ],
  });
  const rows = __trendTestables.toCompetitorBrands(agg, agg.own[0]);

  it("점유율 분모는 잔여 행을 **포함한** 브랜드 축 언급 합이다", () => {
    // 30 + 10 + 60 = 100 → Tesla 30.0%. 잔여를 빼면 75.0% 로 부풀어 오른다.
    expect(rows.map((r) => r.share)).toEqual([30, 10]);
  });

  it("노출률 분모는 `trend_own.monitored`(모수)다 — 브랜드 축 SUM 이 아니다", () => {
    // 25/200 = 12.5%. 브랜드 축 answers 를 더해 분모로 쓰면 이중 계상이다(§7-2 2).
    expect(rows.map((r) => r.mentionRate)).toEqual([12.5, 4]);
  });

  it("`avgPosition` 은 **경쟁 순위**(`compRankSum / compRankedAnswers`)다 — 서수가 아니다", () => {
    // 12/16 = 0.75 · 6/4 = 1.5. 옛 정의(rankSum/rankedAnswers)면 2.5 · 3 이 나온다 —
    // 그 값이 카드 ④(경쟁 순위 축)와 나란히 서면 축이 갈린다(0069 가 고친 결함).
    expect(rows.map((r) => r.avgPosition)).toEqual([0.8, 1.5]);
    expect(rows.map((r) => r.avgPosition), "옛 서수 정의로 돌아갔다").not.toEqual([2.5, 3]);
  });

  it("경쟁 순위 표본이 없으면 null 이다 — 0069 미적용/refold 전의 모습", () => {
    // 컬럼이 없거나(문장이 상수 0 을 낸다) refold 전이면 `compRankedAnswers = 0` 이다.
    // 그때는 **0 이 아니라 빈칸**이어야 한다 — 0 은 "1등보다 앞" 이라는 틀린 숫자다.
    const noRank = __trendTestables.toCompetitorBrands(
      aggOf({
        own: [ownRow({ monitored: 10 })],
        // 서수는 있는데 경쟁 순위만 없는 경우 — 폴백으로 서수를 쓰면 여기서 잡힌다.
        brands: [brandRow({ brandName: "A", mentions: 1, rankSum: 20, rankedAnswers: 4 })],
      }),
      ownRow({ monitored: 10 }),
    );
    expect(noRank[0].avgPosition).toBeNull();
  });

  it("감정 4계열은 그대로 실린다(카드 경쟁사 우호도의 분자·분모)", () => {
    expect(rows[0].sentiment).toEqual({ positive: 6, neutral: 3, negative: 1, mixed: 0 });
  });

  it("잔여 행·엔진 행·국가 행은 목록에 없다 — 축 판별은 `axis` 로만", () => {
    const mixed = __trendTestables.toCompetitorBrands(
      aggOf({
        own: [ownRow({ monitored: 10 })],
        brands: [
          brandRow({ brandName: "A", mentions: 7 }),
          brandRow({ axis: "engine", engine: "chatgpt", brandName: "A", mentions: 7 }),
          brandRow({ axis: "country", country: "KR", brandName: "A", mentions: 7 }),
          brandRow({ brandName: null, isRest: true, mentions: 3 }),
        ],
      }),
      ownRow({ monitored: 10 }),
    );
    expect(mixed.map((r) => r.brand)).toEqual(["A"]);
    // 분모도 브랜드 축만 본다 — 엔진·국가 행을 더하면 점유율이 3중으로 희석된다.
    expect(mixed[0].share).toBe(70);
  });

  it("분모가 0 이면 0 이다(null 아님) — 미러 `pctOf` 와 같은 자세", () => {
    const zero = __trendTestables.toCompetitorBrands(
      aggOf({ own: [ownRow({ monitored: 0 })], brands: [brandRow({ brandName: "A", mentions: 0 })] }),
      ownRow({ monitored: 0 }),
    );
    expect(zero[0]).toMatchObject({ share: 0, mentionRate: 0 });
  });

  it("정렬은 언급 내림차순·동률은 이름 오름차순(패리티 대조가 결정적이어야 한다)", () => {
    const tie = __trendTestables.toCompetitorBrands(
      aggOf({
        own: [ownRow({ monitored: 10 })],
        brands: [
          brandRow({ brandName: "Zeta", mentions: 5 }),
          brandRow({ brandName: "Alpha", mentions: 5 }),
          brandRow({ brandName: "Omega", mentions: 9 }),
        ],
      }),
      ownRow({ monitored: 10 }),
    );
    expect(tie.map((r) => r.brand)).toEqual(["Omega", "Alpha", "Zeta"]);
  });

  it("`isTracked` 를 여기서 거르지 않는다 — 당사 제외는 화면(`competitorMinis`)의 일이다", () => {
    const withOwn = __trendTestables.toCompetitorBrands(
      aggOf({
        own: [ownRow({ monitored: 10 })],
        brands: [
          brandRow({ brandName: "Hyundai", isTracked: true, mentions: 9 }),
          brandRow({ brandName: "Tesla", mentions: 1 }),
        ],
      }),
      ownRow({ monitored: 10 }),
    );
    // 당사 행을 리더에서 빼면 **점유율 분모**가 함께 줄어 경쟁사 점유율이 부풀어 오른다.
    expect(withOwn.map((r) => r.brand)).toEqual(["Hyundai", "Tesla"]);
    expect(withOwn.find((r) => r.brand === "Tesla")?.share).toBe(10);
  });
});

describe("GEO 매핑 — 인용은 도메인 국가 축에서 온다", () => {
  const agg = aggOf({
    own: [
      ownRow({ monitored: 10 }),
      ownRow({ axis: "country", bucket: "KR", monitored: 6, trackedAnswers: 4 }),
      ownRow({ axis: "country", bucket: "", monitored: 4, trackedAnswers: 1 }),
    ],
    brands: [brandRow({ axis: "country", country: "KR", brandName: "A", mentions: 3 })],
    domains: [
      domainRow({ axis: "country", country: "KR", citations: 50, ownedCitations: 5 }),
      domainRow({ axis: "total", citations: 90, ownedCitations: 9 }),
    ],
  });

  it("codes 는 국가 축 own + 도메인 국가 축 인용을 합친다", () => {
    const geo = __trendTestables.toGeoKpi(agg);
    expect(geo?.codes).toEqual([
      { code: "KR", answers: 6, ownAnswers: 4, citTotal: 50, citOwned: 5 },
    ]);
  });

  it("빈 국가(`''`)는 GEO 코드가 되지 않는다", () => {
    expect(__trendTestables.toGeoKpi(agg)?.codes.map((c) => c.code)).not.toContain("");
  });

  it("축이 하나라도 안 서면 null — GEO 만 미러 폴백", () => {
    expect(__trendTestables.toGeoKpi(aggOf({ own: agg.own, domains: agg.domains }))).toBeNull();
    expect(__trendTestables.toGeoKpi(aggOf({ brands: agg.brands }))).toBeNull();
  });
});

describe("지역 라벨 — 집계층의 빈 차원은 `''` 다(fold.ts)", () => {
  it("`''` 는 오늘 리더의 `COALESCE(country,'UNKNOWN')` 과 같은 라벨이 된다", () => {
    expect(__trendTestables.regionLabel("")).toBe("UNKNOWN");
    expect(__trendTestables.regionLabel(null)).toBe("UNKNOWN");
    expect(__trendTestables.regionLabel("KR")).toBe("KR");
  });
});

describe("asOf — 회차 집합의 최신 anchor", () => {
  it("단일 회차면 그 anchor", () => {
    expect(__trendTestables.asOfOf(globalSet)).toBe("2026-08-31T00:00:00.000Z");
  });
  it("여러 회차면 가장 늦은 anchor", () => {
    const set: CycleSet = {
      ...globalSet,
      cycles: [
        { ...globalSet.cycles[0], cycleAnchorAt: "2026-08-24T00:00:00.000Z" },
        { ...globalSet.cycles[0], cycleAnchorAt: "2026-09-07T00:00:00.000Z" },
      ],
    };
    expect(__trendTestables.asOfOf(set)).toBe("2026-09-07T00:00:00.000Z");
  });
  it("회차가 없으면 null", () => {
    expect(__trendTestables.asOfOf({ ...globalSet, cycles: [] })).toBeNull();
  });
});
