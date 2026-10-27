import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  isOfficialHmgGroupKey,
  officialHmgGroupKeys,
  OFFICIAL_HMG_CATEGORY,
} from "./official-hmg-citations";
import { citationShareNumerator, overviewTrendValues } from "./overview-card-values";
import type { CitationOverrideMap } from "@/lib/citation-categorizer";
import {
  foldCitationsLive,
  type CitDomainGroupRow,
  type StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import { __trendTestables } from "@/lib/db/repositories/summary-global-aggregates";
import {
  buildTrendStatements,
  summaryGroupKeyUniverseSql,
  type TrendAggregates,
  type TrendDomainRow,
  type TrendOwnRow,
  type TrendReadScope,
} from "@/lib/db/repositories/summary-trend-aggregates";
import {
  G_CORE_AXES,
  G_CORE_LIMITS,
  toSeries,
  toStandardTrendBuckets,
} from "@/lib/db/repositories/summary-global-trend-read";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardAggregates } from "@/lib/scope/result-adapter";

// 글로벌 ⑤ "AI 인용 점유율" = 공식(HMG) 카테고리 인용 ÷ 전체 인용(제품 책임자 2026-09-29).
//
// 수용 기준: **같은 입력에서 세 값이 같은 수**다.
//   ① Overview ⑤ 카드의 분자·분모(`citationShareNumerator` ← 사실표 S1 `toStandardAggregates`) · 그 추이 점
//      (`overviewTrendValues` ← 사실표 코어 `toSeries` 의 회차별 `officialCitations`)
//   ② 인용 현황 카드 = ③ 출처 카테고리 차트의 Official (HMG) 비중(같은 `live.categories`,
//      `foldCitationsLive`). 그 비중은 인용 화면(back/bff/screens/citation.py)이 같은 식으로 낸다 —
//      아래 `shareOf` 는 그 식(카테고리 합 대비, 1자리 반올림)이다.
// 캐시 경계는 JSON 라운드트립으로 흉내 낸다(Map 반환 결함 전례 — 셀 값은 직렬화 가능해야 한다).

const rt = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── 픽스처: 한 회차 · 한 엔진의 group_key 단위 인용 ─────────────────────────────
//   · hyundai.com / kia.co.kr / genesis.com  — 카탈로그·규칙상 Official (HMG)
//   · linkedin.com/hyundai-motor-group       — 공식 소셜 계정 키(Official (HMG))
//   · linkedin.com                           — 같은 도메인의 비공식 행(Social & Video)
//   · my-dealer.example                       — 운영자 오버라이드로 Official (HMG)
//   · example.com / wikipedia.org            — 비공식
const GROUPS: Array<{ key: string; citations: number; owned: number }> = [
  { key: "hyundai.com", citations: 40, owned: 25 },
  { key: "kia.co.kr", citations: 12, owned: 0 },
  { key: "genesis.com", citations: 8, owned: 8 },
  { key: "linkedin.com/hyundai-motor-group", citations: 5, owned: 0 },
  { key: "linkedin.com", citations: 9, owned: 0 },
  { key: "my-dealer.example", citations: 6, owned: 0 },
  { key: "example.com", citations: 70, owned: 0 },
  { key: "wikipedia.org", citations: 50, owned: 0 },
];
const OVERRIDES: CitationOverrideMap = new Map([["my-dealer.example", OFFICIAL_HMG_CATEGORY]]);
const TOTAL = GROUPS.reduce((s, g) => s + g.citations, 0);
const OWNED_BASE = GROUPS.reduce((s, g) => s + g.owned, 0);
const pct = (n: number, d: number) => Math.round((n / d) * 1000) / 10;
/** A category's share (%) of the slices, one decimal; null when the slices sum to 0 (the citation screen's rule). */
const shareOf = (categories: Array<{ name: string; value: number }> | null | undefined, name: string): number | null => {
  if (!categories) return null;
  const total = categories.reduce((s, c) => s + c.value, 0);
  if (total <= 0) return null;
  return Math.round(((100 * (categories.find((c) => c.name === name)?.value ?? 0)) / total) * 10) / 10;
};

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const A1 = "2026-09-20T15:00:00.000Z";
const A2 = "2026-09-27T15:00:00.000Z";
const SET: CycleSet = {
  surface: "global",
  mode: "period",
  cycles: [
    { cycleId: UUID(1), generationId: UUID(2), projectId: UUID(9), cycleAnchorAt: A1, cycleWeek: "2026-09-21" },
    { cycleId: UUID(3), generationId: UUID(4), projectId: UUID(9), cycleAnchorAt: A2, cycleWeek: "2026-09-28" },
  ],
  cycleKey: `${UUID(1)}:${UUID(2)},${UUID(3)}:${UUID(4)}`,
  projectIds: [UUID(9)],
  missingProjectIds: [],
  weeks: ["2026-09-21", "2026-09-28"],
  anchorCount: 2,
};

const ownRow = (p: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "total", bucket: null, cycleAnchorAt: null, keyRows: 1,
  monitored: 0, trackedAnswers: 0, multiAnswers: 0, top1Answers: 0, top3Answers: 0,
  rankSum: 0, rankedAnswers: 0, ownMentions: 0, ownPositive: 0, ownSignals: 0,
  compMentions: 0, allCitations: 0, ownCitations: 0, ownFallbackCitations: 0,
  tileOwnMentions: 0, citingAnswers: 0, citMonitored: 0, ...p,
});
const domRow = (p: Partial<TrendDomainRow>): TrendDomainRow => ({
  axis: "total", isRest: false, restCount: 0, keyRows: 1, groupKey: null, domain: null,
  country: null, cycleAnchorAt: null, citations: 0, citingAnswers: 0, ownedCitations: 0,
  isOurs: false, ...p,
});

/** 사실표 S1 read(최신 회차 A2 스냅샷) — `group` 축 절단 없음 + `total` 행. */
const s1Agg = (): TrendAggregates => ({
  empty: false,
  answers: [],
  brands: [],
  own: [ownRow({ monitored: 100, trackedAnswers: 40 })],
  domains: [
    domRow({ axis: "total", citations: TOTAL, ownedCitations: OWNED_BASE }),
    ...GROUPS.map((g) =>
      domRow({ axis: "group", groupKey: g.key, citations: g.citations, ownedCitations: g.owned }),
    ),
  ],
});

/**
 * 사실표 코어 read — 회차 두 개. 문장의 `official_citations` 열은 `group_key = ANY($keys)`
 * 의 합이므로, 여기서는 같은 멤버십 규칙으로 값을 만든다(SQL 형태는 아래 describe 가 본다).
 * A1 은 절반 크기, A2 는 S1 과 같은 회차(= 카드 == 추이 마지막 점).
 */
const coreAgg = (keys: readonly string[]): TrendAggregates => {
  const K = new Set(keys);
  const official = GROUPS.filter((g) => K.has(g.key)).reduce((s, g) => s + g.citations, 0);
  return {
    empty: false,
    answers: [],
    brands: [],
    own: [
      ownRow({ axis: "cycle", cycleAnchorAt: A1, monitored: 50, trackedAnswers: 20 }),
      ownRow({ axis: "cycle", cycleAnchorAt: A2, monitored: 100, trackedAnswers: 40 }),
    ],
    domains: [
      domRow({ axis: "cycle", cycleAnchorAt: A1, citations: TOTAL / 2, ownedCitations: 0, officialCitations: official / 2 }),
      domRow({ axis: "cycle", cycleAnchorAt: A2, citations: TOTAL, ownedCitations: OWNED_BASE, officialCitations: official }),
    ],
  };
};

/** 미러 인용 화면 fold 입력 — 같은 group_key 행(엔진 하나). */
const foldGroups = (): CitDomainGroupRow[] =>
  GROUPS.map((g) => ({
    domain: g.key, category: null, target: "chatgpt",
    citations: g.citations, owned: g.owned > 0, owned_citations: g.owned,
  }));
const foldLive = (sourceCategory?: string[]) =>
  foldCitationsLive({
    sampledAnswers: 100,
    groups: foldGroups(),
    stats: [], urls: [], promptRows: [], promptRefs: [], split: null,
    filters: sourceCategory ? { sourceCategory } : {},
    overrides: OVERRIDES,
  });

describe("분류 — 카테고리 차트와 같은 함수·같은 오버라이드", () => {
  it("공식 사이트·공식 소셜 계정·오버라이드는 공식(HMG), 같은 도메인의 비공식 행은 아니다", () => {
    expect(isOfficialHmgGroupKey("hyundai.com", OVERRIDES)).toBe(true);
    expect(isOfficialHmgGroupKey("kia.co.kr", OVERRIDES)).toBe(true);
    expect(isOfficialHmgGroupKey("linkedin.com/hyundai-motor-group", OVERRIDES)).toBe(true);
    expect(isOfficialHmgGroupKey("linkedin.com", OVERRIDES)).toBe(false);
    expect(isOfficialHmgGroupKey("my-dealer.example", OVERRIDES)).toBe(true);
    expect(isOfficialHmgGroupKey("my-dealer.example", new Map())).toBe(false);
    expect(isOfficialHmgGroupKey("example.com", OVERRIDES)).toBe(false);
  });

  it("키 목록은 정렬·중복 제거된 문자열 배열이다(캐시 셀 직렬화 그대로)", () => {
    const keys = officialHmgGroupKeys(
      [...GROUPS.map((g) => g.key), "hyundai.com", null, undefined, ""],
      OVERRIDES,
    );
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(rt(keys)).toEqual(keys);
  });
});

describe("수용 기준 — 세 값이 같은 입력에서 같은 수", () => {
  const OFFICIAL = 40 + 12 + 8 + 5 + 6; // hyundai·kia·genesis·linkedin 공식계정·오버라이드
  const EXPECTED = pct(OFFICIAL, TOTAL);

  it("③ 카테고리 차트의 Official (HMG) 비중", () => {
    expect(shareOf(rt(foldLive()).categories, OFFICIAL_HMG_CATEGORY)).toBe(EXPECTED);
  });

  it("② 인용 현황 카드 = ③ (같은 `live.categories` · 같은 식)", () => {
    const live = rt(foldLive());
    const status = shareOf(live.categories, OFFICIAL_HMG_CATEGORY);
    expect(status).toBe(EXPECTED);
    // 종전 값(base URL prefix 분자)은 다른 수였다 — 이 변경이 실제로 값을 바꾼다는 확인.
    expect(live.summary.officialOwnShare).toBe(pct(OWNED_BASE, TOTAL));
    expect(live.summary.officialOwnShare).not.toBe(EXPECTED);
  });

  it("① Overview 카드의 분자·분모(사실표 S1, 캐시 라운드트립 포함) = ③", () => {
    const own = s1Agg().own[0];
    const agg = rt(__trendTestables.toStandardAggregates(s1Agg(), SET, own, OVERRIDES));
    expect(agg.citations.officialHmgCitations).toBe(OFFICIAL);
    expect(citationShareNumerator(agg.citations)).toBe(OFFICIAL);
    expect(agg.citations.totalCitations).toBe(TOTAL);
    expect(pct(citationShareNumerator(agg.citations), agg.citations.totalCitations)).toBe(EXPECTED);
  });

  it("① 추이 마지막 점(사실표 코어 → overviewTrendValues) = 카드 값", () => {
    const keys = rt(officialHmgGroupKeys(GROUPS.map((g) => g.key), OVERRIDES));
    const buckets = rt(toStandardTrendBuckets(toSeries(coreAgg(keys), SET)));
    const last = buckets[buckets.length - 1];
    expect(last.officialHmgCitations).toBe(OFFICIAL);
    expect(overviewTrendValues(last).citationShare).toBe(EXPECTED);
    // 앞 자리도 같은 정의(절반 규모 → 같은 비율).
    expect(overviewTrendValues(buckets[0]).citationShare).toBe(EXPECTED);
  });

  it("`?source=` 로 공식(HMG)을 빼면 ②·③ 이 같은 지점에서 0 이 된다(모집단이 함께 좁혀진다)", () => {
    const live = foldLive(["Other", "Wiki & Reference", "Social & Video"]);
    expect(live.summary.total).toBe(70 + 50 + 9);
    expect(shareOf(live.categories, OFFICIAL_HMG_CATEGORY)).toBe(0);
  });
});

describe("표면 분기 — website·project 는 종전 정의 그대로", () => {
  it("필드가 없으면(website·project 리더) 분자는 `ownedCitations` 다", () => {
    expect(citationShareNumerator({ ownedCitations: 7 })).toBe(7);
    expect(citationShareNumerator({ ownedCitations: 7, officialHmgCitations: 3 })).toBe(3);
    expect(citationShareNumerator({ ownedCitations: 7, officialHmgCitations: 0 })).toBe(0);
  });

  it("카드 분자는 필드가 없으면 종전 값이다", () => {
    const agg = {
      rootProjectId: "p", totalAnswers: 10, totalMentions: 0, trackedAnswerCount: 1,
      brands: [], regions: [],
      citations: { sampledAnswers: 10, answersWithCitation: 5, totalCitations: 200, ownedCitations: 30, domains: [] },
      position: { avgPosition: null, sampledAnswers: 0 },
      sentiment: { positiveRate: null, positiveMentions: 0, sampledMentions: 0 },
    } as StandardAggregates;
    expect(citationShareNumerator(agg.citations)).toBe(30);
    expect(pct(citationShareNumerator(agg.citations), agg.citations.totalCitations)).toBe(15);
  });

  it("추이 버킷도 필드가 없으면 종전 값이다", () => {
    const b = {
      bucketStart: "2026-09-28", answers: 10, trackedAnswers: 1, totalMentions: 0,
      trackedMentions: 0, sentMentions: 0, positiveMentions: 0, avgPosition: null,
      totalCitations: 200, ownedCitations: 30, measuredDays: 1, firstAt: null, lastAt: null,
    } as StandardTrendBucket;
    expect(overviewTrendValues(b).citationShare).toBe(15);
  });

  it("사실표 S1 `group` 축이 잘려 오면(잔여 행) 조용히 과소 집계하지 않고 던진다", () => {
    const agg = s1Agg();
    agg.domains.push(domRow({ axis: "group", isRest: true, citations: 3 }));
    expect(() =>
      __trendTestables.toStandardAggregates(agg, SET, agg.own[0], OVERRIDES),
    ).toThrow(/group axis truncated/);
  });

  it("오버라이드를 안 넘기면(테스트·종전 호출부) 필드를 만들지 않는다", () => {
    const agg = __trendTestables.toStandardAggregates(s1Agg(), SET, s1Agg().own[0]);
    expect("officialHmgCitations" in agg.citations).toBe(false);
  });
});

describe("SQL — 분류 어휘 없이 키 목록 멤버십만, 추가 문장·추가 행 0", () => {
  const dialect = new PgDialect();
  const scope: TrendReadScope = {
    set: SET, filters: {}, ownVariant: OWN_VARIANT_ALL,
    ownedBasePrefixes: ["https://www.hyundai.com/"], axes: G_CORE_AXES, limits: G_CORE_LIMITS,
  };
  const domainsSql = (s: TrendReadScope) =>
    dialect.sqlToQuery(buildTrendStatements(s, { only: ["domains"] })[0].sql);

  it("목록이 없으면 종전 문장과 바이트 동일(열 없음)", () => {
    const before = domainsSql(scope);
    expect(before.sql).not.toContain("official_citations");
    expect(domainsSql({ ...scope }).sql).toBe(before.sql);
  });

  it("목록이 있으면 같은 문장·같은 grouping set 에 열 하나만 붙는다(잔여 행 합산 포함)", () => {
    const before = domainsSql(scope).sql;
    const after = domainsSql({ ...scope, officialGroupKeys: ["hyundai.com", "kia.co.kr"] });
    expect(after.sql).toContain("FILTER (WHERE group_key = ANY(");
    expect(after.sql).toContain("AS official_citations");
    expect(after.sql).toContain("sum(official_citations)");
    // 스캔 수·grouping set 은 그대로다.
    expect(after.sql.match(/summary_trend_domains/g)).toHaveLength(before.match(/summary_trend_domains/g)!.length);
    expect(after.sql).toContain("GROUP BY GROUPING SETS ((group_key), (domain), (cycle_anchor_at), ())");
    // 키는 바인드 배열 하나로 넘어간다(스칼라 펼침 금지).
    expect(after.params).toContainEqual(["hyundai.com", "kia.co.kr"]);
  });

  it("키 후보는 인용 계열 회차 목록의 group_key 전수다(필터 술어 없음)", () => {
    const q = dialect.sqlToQuery(summaryGroupKeyUniverseSql({ ...SET, citationExcludedCycleIds: [UUID(1)] }));
    expect(q.sql).toContain("SELECT DISTINCT group_key FROM summary_trend_domains");
    expect(q.sql).not.toContain("catalog_brands");
    expect(q.sql).not.toContain("country");
    // 0071 인용 제외 회차는 후보에서도 빠진다(도메인 문장과 같은 회차 목록).
    expect(q.params).toContain(UUID(3));
    expect(q.params).not.toContain(UUID(1));
  });

  it("같은 자리에 회차가 둘이면 공식(HMG) 분자도 분모처럼 합산된다", () => {
    const agg = coreAgg(["hyundai.com"]);
    // A1 을 A2 와 같은 UTC 일로 옮긴다(축 off 키 = UTC 일).
    const sameDay = "2026-09-27T01:00:00.000Z";
    agg.own[0] = { ...agg.own[0], cycleAnchorAt: sameDay };
    agg.domains[0] = { ...agg.domains[0], cycleAnchorAt: sameDay };
    const series = toSeries(agg);
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0].officialHmgCitations).toBe(20 + 40);
    expect(series.buckets[0].allCitations).toBe(TOTAL / 2 + TOTAL);
  });

  it("코어 read 에 목록이 없으면 버킷에 필드가 없다(종전 정의로 읽힌다)", () => {
    const agg = coreAgg([]);
    agg.domains = agg.domains.map(({ officialCitations: _o, ...r }) => r as TrendDomainRow);
    const b = toStandardTrendBuckets(toSeries(agg, SET));
    expect(b.every((x) => !("officialHmgCitations" in x))).toBe(true);
  });
});

describe("Overview GEO 국가별 ⑤ — 카드와 같은 분자", () => {
  // 국가 지표(공식(HMG) 열 ÷ 인용 총수)는 overview/geo 화면(back/bff/screens/overview.py)이 낸다.
  it("사실표 S1 국가 축의 공식(HMG) 열이 국가 행에 실린다", async () => {
    const agg: TrendAggregates = {
      ...s1Agg(),
      own: [
        ownRow({ monitored: 100, trackedAnswers: 40 }),
        ownRow({ axis: "country", bucket: "KR", monitored: 60, trackedAnswers: 20 }),
      ],
      brands: [{
        axis: "country", country: "KR", engine: null, cycleAnchorAt: null, brandName: "Kia",
        isRest: false, restCount: 0, keyRows: 1, isTracked: true, mentions: 5, answers: 5,
        rankSum: 0, rankedAnswers: 0, compRankSum: 0, compRankedAnswers: 0, top3Answers: 0,
        positive: 0, neutral: 0, negative: 0, mixed: 0, typeMention: 0, typeRecommendation: 0,
        typeComparison: 0, typeDefinition: 0, typeFinalChoice: 0,
      }],
      domains: [
        ...s1Agg().domains,
        domRow({ axis: "country", country: "KR", citations: 200, ownedCitations: 10, officialCitations: 50 }),
      ],
    };
    const geo = rt(__trendTestables.toGeoKpi(agg));
    const kr = geo!.codes.find((c) => c.code === "KR")!;
    expect(kr.citOfficialHmg).toBe(50);
    expect(kr.citTotal).toBe(200);
  });
});
