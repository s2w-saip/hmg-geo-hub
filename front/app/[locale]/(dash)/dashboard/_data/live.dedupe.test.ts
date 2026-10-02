import { beforeEach, describe, expect, it, vi } from "vitest";

// react-server 빌드로 바꿔야 `cache()` 가 실제로 memoize 한다 (test/request-scope.ts 참조).
// mock 팩토리는 호이스팅되므로 외부 import 를 참조할 수 없다 — 로더를 인라인한다.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

vi.mock("@/lib/scope/server", () => ({
  fetchStandardAggregates: vi.fn(),
  fetchStandardGeoKpi: vi.fn(),
  fetchStandardTrend: vi.fn(),
  fetchStandardSubKpis: vi.fn(),
  fetchStandardPromptTopics: vi.fn(),
  fetchStandardSourceComposition: vi.fn(),
  fetchProjectTrend: vi.fn(),
  fetchProjectSubKpis: vi.fn(),
  fetchProjectPromptTopics: vi.fn(),
  fetchProjectSourceComposition: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("@/lib/ga4/property-map", () => ({
  resolveProperty: vi.fn(async () => null),
  resolveProperties: vi.fn(async () => []),
}));
vi.mock("@/lib/ga4/conversion", () => ({
  getAiTrafficConversionKpi: vi.fn(async () => null),
  getAiTrafficConversionRollup: vi.fn(async () => null),
  getAiVisitsKpi: vi.fn(async () => null),
}));

const { withRequestScope } = await import("@/test/request-scope");
const {
  fetchStandardAggregates,
  fetchStandardGeoKpi,
  fetchStandardTrend,
  fetchStandardSourceComposition,
  fetchStandardPromptTopics,
} = await import("@/lib/scope/server");
const { getLiveDashboard, getLiveGeo, getLiveTrend, getLiveComposition } = await import("./live");

const AGGREGATES = {
  totalAnswers: 10,
  trackedAnswerCount: 6,
  totalMentions: 20,
  brands: [{ name: "Hyundai", mentionCount: 8, answerCount: 6, isTracked: true }],
  regions: [],
  citations: {
    sampledAnswers: 10,
    answersWithCitation: 8,
    totalCitations: 20,
    ownedCitations: 5,
    domains: [],
  },
  position: { avgPosition: 2.5, sampledAnswers: 6 },
  sentiment: { positiveRate: 50, positiveMentions: 3, sampledMentions: 6 },
};

// 이 테스트가 지키는 것: **섹션 분할이 중복 집계(herd)를 만들지 않는다.**
// 대시보드 본문은 섹션별 <Suspense> 로 쪼개져 있고, ① SUMMARY 와 ④ GEO 는 둘 다
// getLiveDashboard 를, ② 추이와 ① 의 delta 는 둘 다 getLiveTrend 를 부른다.
// 각 섹션이 자기 filters 객체를 조립해도(참조가 달라도) 값이 같으면 게이트웨이
// 호출은 1회여야 한다. 이 가드가 없으면 콜드 키에서 같은 스캔이 N번 돈다.
describe("대시보드 섹션 분할 — 요청단위 dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchStandardAggregates).mockResolvedValue(AGGREGATES as never);
    vi.mocked(fetchStandardGeoKpi).mockResolvedValue({ brands: [], codes: [] } as never);
    vi.mocked(fetchStandardTrend).mockResolvedValue([] as never);
    vi.mocked(fetchStandardSourceComposition).mockResolvedValue([] as never);
    vi.mocked(fetchStandardPromptTopics).mockResolvedValue([] as never);
  });

  it("① SUMMARY 와 ④ GEO 가 같은 필터로 각자 페처를 불러도 집계는 각 1회", async () => {
    // 2026-08-28 분할: ① 은 getLiveDashboard, ④ 는 getLiveGeo 를 소유한다.
    // getLiveGeo 는 빈 상태 판정을 위해 getLiveDashboard 를 **참조**하는데,
    // 그것이 ① 의 호출과 접혀 표준 집계가 1회로 유지되는지가 이 가드의 핵심이다
    // (접히지 않으면 콜드 키에서 같은 스캔이 2번 돈다).
    await withRequestScope(async () =>
      Promise.all([
        // 섹션마다 자기 객체 리터럴 — 참조는 다르고 값은 같다(실제 분할과 동일).
        getLiveDashboard({ region: ["KR"], engine: ["gpt"] }),
        getLiveGeo({ engine: ["gpt"], region: ["KR"] }),
      ]),
    );
    expect(fetchStandardAggregates).toHaveBeenCalledTimes(1);
    expect(fetchStandardGeoKpi).toHaveBeenCalledTimes(1);
  });

  it("④ GEO 가 렌더되지 않으면 GEO 집계는 아예 돌지 않는다", async () => {
    // showsGeoMap(lib/auth/scope-policy.ts)이 false 인 역할(country·website·vendor)
    // 에서는 page.tsx 가 GeoSection 자체를 렌더하지 않는다. 종전에는 GEO 집계가
    // getLiveDashboard 안에 묶여 있어 **그 역할에서도 돌고 결과만 버려졌다**.
    await withRequestScope(async () => getLiveDashboard({ region: ["KR"] }));
    expect(fetchStandardAggregates).toHaveBeenCalledTimes(1);
    expect(fetchStandardGeoKpi).not.toHaveBeenCalled();
  });

  it("④ GEO 단독 호출도 표준 집계는 1회 — 역방향으로도 접힌다", async () => {
    // ④ 가 ① 보다 먼저 도착하는 렌더 순서에서도 dedup 이 성립해야 한다.
    await withRequestScope(async () => {
      const geo = await getLiveGeo({ region: ["KR"] });
      await getLiveDashboard({ region: ["KR"] });
      return geo;
    });
    expect(fetchStandardAggregates).toHaveBeenCalledTimes(1);
    expect(fetchStandardGeoKpi).toHaveBeenCalledTimes(1);
  });

  it("측정이 없으면(집계 null) GEO 는 그려지지 않는다 — 빈 상태 의미 보존", async () => {
    vi.mocked(fetchStandardAggregates).mockResolvedValue(null as never);
    const geo = await withRequestScope(async () => getLiveGeo({ region: ["KR"] }));
    expect(geo).toBeNull();
  });

  it("② 추이가 다른 버킷을 부르면 접히지 않는다 — dedup 이 값을 뭉개지 않는다", async () => {
    await withRequestScope(async () =>
      Promise.all([
        getLiveTrend({ region: ["KR"] }, "week"),
        getLiveTrend({ region: ["KR"] }, "day"),
        getLiveTrend({ region: ["KR"] }, "week"), // 첫 번째와 동일 → 접힌다
      ]),
    );
    expect(fetchStandardTrend).toHaveBeenCalledTimes(2);
  });

  it("요청이 다르면 다시 읽는다 — 요청 간 캐시는 unstable_cache 의 층이다", async () => {
    await withRequestScope(async () => getLiveDashboard({ region: ["KR"] }));
    await withRequestScope(async () => getLiveDashboard({ region: ["KR"] }));
    expect(fetchStandardAggregates).toHaveBeenCalledTimes(2);
  });

  it("구성 분석도 같은 필터면 1회 — 섹션이 겹쳐 불러도 안전", async () => {
    await withRequestScope(async () =>
      Promise.all([getLiveComposition({ region: ["KR"] }), getLiveComposition({ region: ["KR"] })]),
    );
    expect(fetchStandardSourceComposition).toHaveBeenCalledTimes(1);
    expect(fetchStandardPromptTopics).toHaveBeenCalledTimes(1);
  });
});
