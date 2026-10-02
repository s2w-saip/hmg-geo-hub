import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  TrendAggregates,
  TrendBrandRow,
  TrendDomainRow,
  TrendOwnRow,
} from "./summary-trend-aggregates";
import type { WebsiteCyclePick } from "./summary-cycles";

// 집계층 리더는 DB 를 만지므로 **읽기 함수만** 대체한다 — `planTrendRead`(변형 판정)는
// 진짜를 쓴다. 이 파일이 보는 것은 "리더가 준 행 → 화면 계약" 매핑 규칙이고,
// 값 동치(오늘 경로 대비 정수 0 오차)는 실DB 패리티 하네스의 몫이다.
const readTrendAggregates = vi.fn<[unknown, unknown], Promise<TrendAggregates>>();
vi.mock("./summary-trend-aggregates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./summary-trend-aggregates")>();
  return {
    ...actual,
    readTrendAggregates: (scope: unknown, opts: unknown) => readTrendAggregates(scope, opts),
  };
});

// 세부층 두 문장(프롬프트 그레인)만 여기서 대체한다 — Sub-KPI 매핑을 DB 없이 보기 위해서.
const execute = vi.fn<[unknown], Promise<unknown>>();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: (q: unknown) => execute(q) }) }));
vi.mock("@/lib/summary/read/presence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/summary/read/presence")>();
  return { ...actual, presenceSetColumnAvailable: () => Promise.resolve(true) };
});

const {
  summaryWebsiteAggregates,
  summaryWebsiteDashboard,
  summaryWebsiteSourceComposition,
  summaryWebsiteGeoCompetition,
  summaryWebsiteSubKpis,
} = await import("./summary-website-aggregates");

const CYCLES: WebsiteCyclePick[] = [
  {
    cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
    generationId: "bbbbbbbb-0000-0000-0000-000000000001",
    projectId: "11111111-1111-1111-1111-111111111111",
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  },
];
const scope = (over: Partial<Parameters<typeof summaryWebsiteAggregates>[0]> = {}) => ({
  cycles: CYCLES,
  projectIds: ["11111111-1111-1111-1111-111111111111"],
  filters: {},
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
  unitFlags: true,
  ...over,
});

const own = (o: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "total", bucket: null, cycleAnchorAt: null, keyRows: 1, monitored: 0, trackedAnswers: 0, multiAnswers: 0,
  top1Answers: 0, top3Answers: 0, rankSum: 0, rankedAnswers: 0, ownMentions: 0,
  ownPositive: 0, ownSignals: 0, compMentions: 0, allCitations: 0, ownCitations: 0,
  ownFallbackCitations: 0, tileOwnMentions: 0, citingAnswers: 0, citMonitored: 0, ...o,
});
const brand = (b: Partial<TrendBrandRow>): TrendBrandRow => ({
  axis: "brand", country: null, engine: null, brandName: null,
  isRest: false, restCount: 0, keyRows: 1, isTracked: false,
  mentions: 0, answers: 0, rankSum: 0, rankedAnswers: 0, top3Answers: 0,
  positive: 0, neutral: 0, negative: 0, mixed: 0, typeMention: 0,
  typeRecommendation: 0, typeComparison: 0, typeDefinition: 0, typeFinalChoice: 0, ...b,
});
const dom = (d: Partial<TrendDomainRow>): TrendDomainRow => ({
  axis: "domain", isRest: false, restCount: 0, keyRows: 1, groupKey: null, domain: null,
  country: null,
  citations: 0, citingAnswers: 0, ownedCitations: 0, isOurs: false, ...d,
});
const agg = (o: Partial<TrendAggregates>): TrendAggregates => ({
  own: [], answers: [], brands: [], domains: [], empty: false, ...o,
});

/** 집계층 read 의 값 — `empty` 면 테스트를 세운다(그 경로는 전용 케이스가 본다). */
const val = <T,>(r: { empty: true } | { empty: false; value: T }): T => {
  if (r.empty) throw new Error("집계층 read 가 empty 다 — 이 케이스는 값 경로를 본다");
  return r.value;
};

beforeEach(() => {
  readTrendAggregates.mockReset();
  execute.mockReset();
});

/** 리더가 어떤 `only`/`axes` 로 불렸나 — 문장 수 수용 기준(①)의 단위 테스트판. */
const lastCall = () => readTrendAggregates.mock.calls[readTrendAggregates.mock.calls.length - 1];

describe("summaryWebsiteAggregates — 집계층 행 → 화면 계약", () => {
  it("모수 0(접기 행 없음)이면 null — 미러 경로와 같은 '측정 대기' 형태", async () => {
    readTrendAggregates.mockResolvedValue(agg({}));
    expect(await summaryWebsiteAggregates(scope())).toBeNull();
  });

  it("지역 롤업: country 축의 '' 는 UNKNOWN, 이름 오름차순", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [
          own({ axis: "total", monitored: 10, trackedAnswers: 4 }),
          own({ axis: "country", bucket: "NO", monitored: 6, trackedAnswers: 3 }),
          own({ axis: "country", bucket: "", monitored: 4, trackedAnswers: 1 }),
        ],
      }),
    );
    const r = await summaryWebsiteAggregates(scope());
    expect(r?.regions).toEqual([
      { region: "NO", answerCount: 6, trackedAnswerCount: 3 },
      { region: "UNKNOWN", answerCount: 4, trackedAnswerCount: 1 },
    ]);
    expect(r?.totalAnswers).toBe(10);
    expect(r?.trackedAnswerCount).toBe(4);
  });

  it("② 타일: 절단 잔여(isRest) 행은 목록에서 빠지지만 총언급 분모에는 남는다", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [own({ axis: "total", monitored: 10 })],
        brands: [
          brand({ brandName: "Kia", mentions: 30, answers: 5, isTracked: true }),
          brand({ brandName: "Tesla", mentions: 50, answers: 7 }),
          brand({ brandName: null, isRest: true, restCount: 12, mentions: 20 }),
          // 국가 축·엔진 축 행은 타일에 섞이면 안 된다.
          brand({ axis: "country", country: "NO", brandName: "Kia", mentions: 9 }),
          brand({ axis: "engine", engine: "chatgpt", brandName: "Kia", mentions: 9 }),
        ],
      }),
    );
    const r = await summaryWebsiteAggregates(scope());
    expect(r?.brands.map((b) => b.name)).toEqual(["Tesla", "Kia"]);
    expect(r?.totalMentions).toBe(100);
  });

  it("④ 는 서수 평균(rankSum/rankedAnswers), 분모 0 이면 null", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({ own: [own({ axis: "total", monitored: 10, rankSum: 7, rankedAnswers: 4 })] }),
    );
    expect((await summaryWebsiteAggregates(scope()))?.position).toEqual({
      avgPosition: 1.8,
      sampledAnswers: 4,
    });
    readTrendAggregates.mockResolvedValue(agg({ own: [own({ axis: "total", monitored: 10 })] }));
    expect((await summaryWebsiteAggregates(scope()))?.position).toEqual({
      avgPosition: null,
      sampledAnswers: 0,
    });
  });

  it("⑤ 분모·분자는 domains total 행, '인용 답변 수' 는 own.citingAnswers (도메인 합이 아니다)", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [own({ axis: "total", monitored: 10, citingAnswers: 6 })],
        domains: [
          dom({ axis: "total", citations: 100, ownedCitations: 25, citingAnswers: 9 }),
          dom({ domain: "kia.com", citations: 60, citingAnswers: 5, ownedCitations: 25, isOurs: true }),
          dom({ domain: "reddit.com", citations: 40, citingAnswers: 8 }),
        ],
      }),
    );
    const r = await summaryWebsiteAggregates(scope());
    expect(r?.citations.totalCitations).toBe(100);
    expect(r?.citations.ownedCitations).toBe(25);
    // 도메인 표의 citingAnswers 합(13)도, total 행의 상한(9)도 아니다.
    expect(r?.citations.answersWithCitation).toBe(6);
    // 도메인 표는 citingAnswers 내림차순(오늘 경로의 ORDER BY).
    expect(r?.citations.domains.map((d) => d.host)).toEqual(["reddit.com", "kia.com"]);
  });

  // ── 인용 분모는 **인용 계열 모수**다 (0071, 2026-09-18) ────────────────────
  //
  // `hidden_scope='citations'` 회차는 집합에 남고 인용 계열에서만 빠진다. 분자를 뺐으면
  // 분모도 빼야 비율이 정합한다: 안 그러면 "인용 보유 답변 비율" 이 체계적으로 낮아진다.
  it("인용 분모는 monitored 가 아니라 cit_monitored 다", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [own({ axis: "total", monitored: 100, citMonitored: 70, citingAnswers: 42 })],
        domains: [dom({ axis: "total", citations: 10, ownedCitations: 2 })],
      }),
    );
    const r = await summaryWebsiteAggregates(scope());
    // 언급 계열 모수는 그대로 100.
    expect(r?.totalAnswers).toBe(100);
    // 인용 분모는 70 이라 비율이 60%(42/70)다. 100 을 쓰면 42% 로 낮아진다.
    expect(r?.citations.sampledAnswers).toBe(70);
    expect(r?.citations.answersWithCitation).toBe(42);
  });

  it("뺄 회차가 없으면(열 부재) 인용 분모는 모수와 같다", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        // `citMonitored` 를 일부러 빼고 넘긴다: tsconfig 가 테스트를 타입 체크에서
        // 제외하므로 이런 행이 실제로 만들어질 수 있다(리더의 `??` 폴백이 그 방어다).
        own: [{ ...own({ axis: "total", monitored: 55 }), citMonitored: undefined } as never],
        domains: [dom({ axis: "total", citations: 3, ownedCitations: 1 })],
      }),
    );
    const r = await summaryWebsiteAggregates(scope());
    expect(r?.citations.sampledAnswers).toBe(55);
  });
});

describe("summaryWebsiteSourceComposition — isOurs 는 도메인 서픽스 판정", () => {
  it("리더의 isOurs(유닛 판정)를 쓰지 않고 자사 도메인 정규식을 도메인 문자열에 건다", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        domains: [
          // 리더는 isOurs=false 라고 했지만 도메인은 자사다 → 출처 도넛에서는 자사.
          dom({ domain: "www.hyundai.com", citations: 30, isOurs: false }),
          // 반대로 리더가 true 라고 해도 도메인이 남이면 아니다.
          dom({ domain: "nothyundai.com", citations: 10, isOurs: true }),
          dom({ axis: "total", citations: 40 }),
          dom({ isRest: true, restCount: 3, citations: 0 }),
        ],
      }),
    );
    const r = val(await summaryWebsiteSourceComposition(scope()));
    expect(r).toEqual([
      { domain: "www.hyundai.com", citations: 30, share: 75, isOurs: true },
      { domain: "nothyundai.com", citations: 10, share: 25, isOurs: false },
    ]);
  });

  it("자사 base 가 비면 아무것도 자사가 아니다(공집합이 전부를 자사로 만들지 않는다)", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({ domains: [dom({ domain: "www.hyundai.com", citations: 1 })] }),
    );
    const r = val(await summaryWebsiteSourceComposition(scope({ ownedBasePrefixes: [] })));
    expect(r[0]?.isOurs).toBe(false);
  });
});

describe("summaryWebsiteGeoCompetition — brands 의 country 축", () => {
  it("axis='country' 행만 — '' (세부층 NULL)·절단 잔여·엔진 축 제외", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        brands: [
          brand({ axis: "country", country: "NO", brandName: "Kia", mentions: 9, isTracked: true }),
          brand({ axis: "country", country: "NO", brandName: "Tesla", mentions: 4 }),
          brand({ axis: "country", country: "", brandName: "Kia", mentions: 3 }),
          brand({ axis: "country", country: "NO", brandName: null, isRest: true, restCount: 5, mentions: 2 }),
          brand({ axis: "brand", brandName: "Kia", mentions: 9 }),
          // `axes.engineBrand` 를 켜면 엔진 행도 country 가 null 이다 — 축으로만 갈라야 한다.
          brand({ axis: "engine", engine: "chatgpt", brandName: "Kia", mentions: 9 }),
        ],
      }),
    );
    expect(await summaryWebsiteGeoCompetition(scope())).toEqual([
      { code: "NO", brand: "Kia", mentions: 9, isTracked: true },
      { code: "NO", brand: "Tesla", mentions: 4, isTracked: false },
    ]);
  });
});

// ── 문장 선택자(only)·축(axes) — 렌더당 문장 수의 근거 ───────────────────────
describe("위젯별로 읽는 표", () => {
  it("카드+GEO 는 own·brands·domains 3표를 **한 read** 로, 출처는 domains 1표만", async () => {
    readTrendAggregates.mockResolvedValue(agg({ own: [own({ axis: "total", monitored: 1 })] }));
    await summaryWebsiteDashboard(scope());
    expect(lastCall()?.[1]).toEqual({ only: ["own", "brands", "domains"] });
    expect(readTrendAggregates).toHaveBeenCalledTimes(1);

    readTrendAggregates.mockClear();
    await summaryWebsiteSourceComposition(scope());
    expect(lastCall()?.[1]).toEqual({ only: ["domains"] });

    readTrendAggregates.mockClear();
    await summaryWebsiteGeoCompetition(scope());
    expect(lastCall()?.[1]).toEqual({ only: ["brands"] });
  });

  it("Sub-KPI 는 own·brands 2표 + engineBrand 축(negativeMentions 의 유일한 원천)", async () => {
    readTrendAggregates.mockResolvedValue(agg({}));
    execute.mockResolvedValue([{ prompts: 0 }]);
    await summaryWebsiteSubKpis(scope());
    expect(lastCall()?.[1]).toEqual({ only: ["own", "brands"] });
    expect((lastCall()?.[0] as { axes?: unknown }).axes).toEqual({ engineBrand: true });
  });
});

describe("summaryWebsiteSubKpis — 엔진 행 매핑", () => {
  it("negativeMentions 는 engine 축의 **당사** 브랜드 행 합, 나머지는 own(engine)", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [
          own({ axis: "total", monitored: 30 }),
          own({
            axis: "engine", bucket: "chatgpt", monitored: 20, trackedAnswers: 12,
            multiAnswers: 5, top1Answers: 3, top3Answers: 7, rankSum: 24, rankedAnswers: 12,
            compMentions: 200, ownMentions: 60, ownSignals: 40, ownPositive: 25,
            allCitations: 90, ownCitations: 30, ownFallbackCitations: 0,
          }),
        ],
        brands: [
          brand({ axis: "engine", engine: "chatgpt", brandName: "Kia", isTracked: true, negative: 8 }),
          brand({ axis: "engine", engine: "chatgpt", brandName: "Hyundai", isTracked: true, negative: 5 }),
          // 경쟁사 행·브랜드 축 행은 분자에 들어가면 안 된다.
          brand({ axis: "engine", engine: "chatgpt", brandName: "Tesla", negative: 99 }),
          brand({ axis: "brand", brandName: "Kia", isTracked: true, negative: 77 }),
        ],
      }),
    );
    execute
      .mockResolvedValueOnce([{ prompts: 40 }])   // 측정 프롬프트
      .mockResolvedValueOnce([{ prompts: 31 }]);  // 당사 언급 프롬프트
    const r = val(await summaryWebsiteSubKpis(scope()));
    expect(r.rows).toEqual([
      {
        engine: "chatgpt", answers: 20, tracked: 12, multi: 5, top1: 3, top3: 7,
        avgPosition: 2, totalMentions: 200, trackedMentions: 60,
        sentMentions: 40, positiveMentions: 25, negativeMentions: 13,
        citTotal: 90, citOwned: 30,
      },
    ]);
    // 미언급 = 측정 − 당사 언급 (종전 prompt 별 bool_or 과 동치)
    expect(r.measuredPrompts).toBe(40);
    expect(r.promptsWithoutBrand).toBe(9);
  });

  it("측정 프롬프트가 0이면 두 값 모두 null — '측정 대기' 형태 유지", async () => {
    readTrendAggregates.mockResolvedValue(agg({}));
    execute.mockResolvedValue([{ prompts: 0 }]);
    const r = val(await summaryWebsiteSubKpis(scope()));
    expect(r).toEqual({ rows: [], promptsWithoutBrand: null, measuredPrompts: null });
  });
});

// ── 폴백 신호 전달 (PR③ R3) ─────────────────────────────────────────────────
//
// `viaTrend` 가 `agg-empty → detail` 분기를 갖게 됐다. 그 분기가 살아 있으려면 리더가
// `empty` 를 **버리지 않고** 밖으로 내야 한다 — 종전에는 값만 내서 게이트가 못 봤다.
// "0 을 그리지 않는다"는 계약(§5-2)이 웹사이트 표면에서도 성립하는 자리다.
describe("집계층 read 는 리더의 `empty` 를 그대로 낸다", () => {
  it("카드+GEO · 출처 · Sub-KPI 셋 다 empty 를 흘린다(값 대신)", async () => {
    readTrendAggregates.mockResolvedValue(agg({ empty: true }));
    execute.mockResolvedValue([{ prompts: 0 }]);
    expect(await summaryWebsiteDashboard(scope())).toEqual({ empty: true });
    expect(await summaryWebsiteSourceComposition(scope())).toEqual({ empty: true });
    expect(await summaryWebsiteSubKpis(scope())).toEqual({ empty: true });
  });

  it("리더가 비지 않았으면 값이 실린다", async () => {
    readTrendAggregates.mockResolvedValue(agg({ own: [own({ axis: "total", monitored: 3 })] }));
    execute.mockResolvedValue([{ prompts: 0 }]);
    const d = await summaryWebsiteDashboard(scope());
    expect(d.empty).toBe(false);
    expect(d.empty === false && d.value.aggregates).toBeTruthy();
  });
});
