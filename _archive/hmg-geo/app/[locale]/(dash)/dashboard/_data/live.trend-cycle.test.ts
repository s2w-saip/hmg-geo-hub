import { beforeEach, describe, expect, it, vi } from "vitest";

// 글로벌 대시보드 추이의 **화면 계약**을 실행으로 못 박는다 — PR③ 검증자 GG-1.
//
// 이 계약은 스위치 없이 자동으로 켜진다: `fetchStandardTrend` 는 `S1.dashboard`
// (라이브 ON)를 타므로, 원장에 글로벌 회차가 2개가 되는 순간 미러 → 집계층으로 넘어가고
// x축이 **주 버킷 → 회차 anchor** 로 바뀐다. 바뀌는 것 셋을 여기서 고정한다:
//   ① 회차 축(`cycleAnchorAt` 있음)이면 **빈 주를 채우지 않는다**
//   ② Δ 는 **직전 회차 대비**(카드 Δ 가 종전 day 롤업에서 옮겨온다)
//   ③ 미러 경로(표시자 없음)는 **종전 격자 그대로** — 회귀 방지
// 웹사이트 쪽 같은 계약은 `app/[locale]/(dash)/website/_data/live.test.ts` 에 있다.

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

const { fetchStandardTrend } = await import("@/lib/scope/server");
const { getLiveTrend, applyTrendDeltas, isCycleBucketed } = await import("./live");

/** 회차 축 버킷 — `cycleAnchorAt` 이 있는 것이 집계층 경로의 표시자다. */
const cycleBucket = (day: string, tracked: number, answers: number) => ({
  bucketStart: day,
  cycleAnchorAt: `${day}T00:00:00.000Z`,
  answers,
  trackedAnswers: tracked,
  totalMentions: 100,
  trackedMentions: 20,
  sentMentions: 10,
  positiveMentions: 5,
  avgPosition: 2.5,
  totalCitations: 50,
  ownedCitations: 5,
  measuredDays: 1,
  firstAt: `${day}T00:00:00.000Z`,
  lastAt: `${day}T00:00:00.000Z`,
});

/** 미러 경로 버킷 — 표시자가 **없다**. */
const weekBucket = (day: string, tracked: number, answers: number) => {
  const b = cycleBucket(day, tracked, answers) as Record<string, unknown>;
  delete b.cycleAnchorAt;
  return b;
};

const kpi = (value: number) =>
  ({ key: "visibility", label: "", value, delta: null, direction: "flat" }) as never;

describe("isCycleBucketed — 회차 축 판별", () => {
  it("전부 표시자가 있어야 회차 축이다(`every`)", () => {
    expect(isCycleBucketed([cycleBucket("2026-08-31", 1, 2)] as never)).toBe(true);
    // 섞이면 경로가 섞였다는 뜻 — 보수적으로 종전 격자를 쓴다.
    expect(isCycleBucketed([
      cycleBucket("2026-08-31", 1, 2), weekBucket("2026-09-07", 1, 2),
    ] as never)).toBe(false);
    expect(isCycleBucketed([] as never)).toBe(false);
  });
});

describe("글로벌 추이 x축 — 회차 버킷이면 빈 주를 채우지 않는다", () => {
  beforeEach(() => vi.clearAllMocks());

  it("3주 떨어진 회차 둘 → 점 둘(사이에 빈 점 없음)", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      cycleBucket("2026-08-21", 6, 10),
      cycleBucket("2026-09-11", 9, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    expect(trend?.points.map((p) => p.bucketStart)).toEqual(["2026-08-21", "2026-09-11"]);
  });

  it("한 주에 회차가 둘이면 **점도 둘**이다(글로벌은 주당 1회차 규칙이 없다)", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      cycleBucket("2026-09-08", 5, 10),
      cycleBucket("2026-09-11", 7, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    expect(trend?.points.map((p) => p.bucketStart)).toEqual(["2026-09-08", "2026-09-11"]);
  });

  it("미러 경로(표시자 없음)는 **종전 주 격자**를 채운다 — 회귀 방지", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-21", 6, 10),
      weekBucket("2026-09-11", 9, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    expect(trend?.points.map((p) => p.bucketStart)).toEqual([
      "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11",
    ]);
  });

  it("`unit=\"day\"`(Δ 페처) 여도 회차 축이면 일 격자를 만들지 않는다", async () => {
    // 집계층은 `day` 버킷을 만들 수 없다(회차 그레인). 격자를 채우면 회차 사이에
    // 값 없는 일 점이 20개 끼어 Δ 의 "마지막 두 점" 의미가 흐려진다.
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      cycleBucket("2026-08-21", 6, 10),
      cycleBucket("2026-09-11", 9, 10),
    ] as never);
    const trend = await getLiveTrend({}, "day");
    expect(trend?.points).toHaveLength(2);
  });
});

describe("Δ 계약 — 회차 축에서는 '직전 회차 대비'", () => {
  beforeEach(() => vi.clearAllMocks());

  it("주 간격이 아닌 회차 셋 → Δ 는 마지막 두 회차의 차", async () => {
    // 8/21 60% · 9/04 70% · 9/11 85%
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      cycleBucket("2026-08-21", 6, 10),
      cycleBucket("2026-09-04", 7, 10),
      cycleBucket("2026-09-11", 17, 20),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    expect(trend?.points.map((p) => p.bucketStart)).toEqual([
      "2026-08-21", "2026-09-04", "2026-09-11",
    ]);
    const [out] = applyTrendDeltas([kpi(85)], trend);
    expect(out.delta).toBe(15); // 85 − 70
    expect(out.direction).toBe("up");
  });

  it("회차가 하나뿐이면 Δ 는 null(칩 숨김) — 게이트가 이 상태를 미러로 돌리는 이유", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      cycleBucket("2026-09-11", 9, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const [out] = applyTrendDeltas([kpi(90)], trend);
    expect(out.delta).toBeNull();
  });

  it("미러 경로에서는 빈 주가 끼어도 값 있는 마지막 둘을 본다(종전 동작 유지)", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-21", 6, 10),
      weekBucket("2026-09-11", 9, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    // 격자가 채워져 점은 4개지만 값이 있는 것은 둘이다.
    expect(trend?.points).toHaveLength(4);
    const [out] = applyTrendDeltas([kpi(90)], trend);
    expect(out.delta).toBe(30); // 90% − 60%
  });
});

// ── 수집 오류 회차 갭 슬롯(0070) ────────────────────────────────────────────
//
// 갭 버킷은 **페처가 만들어서 준다**(`lib/summary/read/trend-gaps.ts`). 이 계층이 지킬
// 것은 둘: ① 그 버킷의 값 계산을 **하지 않는다**(pct(0,0) 로 0% 를 만들면 골짜기가 그대로
// 남는다) ② `fillTrendGaps` 가 만드는 **진짜 미측정** 빈 점에는 마커를 붙이지 않는다.
describe("갭 버킷 — 값 계산을 건너뛰고 마커만 나른다", () => {
  beforeEach(() => vi.clearAllMocks());

  const gapBucket = (day: string) => {
    const b = weekBucket(day, 0, 0) as Record<string, unknown>;
    b.answers = 0;
    b.trackedAnswers = 0;
    b.totalMentions = 0;
    b.trackedMentions = 0;
    b.sentMentions = 0;
    b.positiveMentions = 0;
    b.avgPosition = null;
    b.totalCitations = 0;
    b.ownedCitations = 0;
    b.measuredDays = 0;
    b.firstAt = null;
    b.lastAt = null;
    b.gap = { reason: "collection_error" };
    return b;
  };

  it("갭 슬롯은 values 가 비고 gap 이 실린다 — 0% 가 아니다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17", 6, 10),
      gapBucket("2026-08-24"),
      weekBucket("2026-08-31", 8, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const gap = trend?.points.find((p) => p.bucketStart === "2026-08-24");
    expect(gap?.gap).toEqual({ reason: "collection_error" });
    expect(gap?.values).toEqual({});
    expect(gap?.answers).toBe(0);
    // 이웃은 그대로 — 8/17 60% · 8/31 80%.
    expect(trend?.points.find((p) => p.bucketStart === "2026-08-17")?.values.visibility).toBe(60);
    expect(trend?.points.find((p) => p.bucketStart === "2026-08-31")?.values.visibility).toBe(80);
  });

  it("Δ 는 갭을 건너뛴다 — 8/17 과 8/31 이 이웃이 된다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17", 6, 10),
      gapBucket("2026-08-24"),
      weekBucket("2026-08-31", 8, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const [out] = applyTrendDeltas([kpi(80)], trend);
    expect(out.delta).toBe(20); // 80 − 60. 갭을 값으로 세면 여기가 80 이 된다.
  });

  it("`fillTrendGaps` 가 채운 **진짜 미측정** 점에는 마커가 없다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17", 6, 10),
      gapBucket("2026-08-24"),
      weekBucket("2026-09-07", 8, 10),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    // 8/31 은 측정이 아예 없던 주다 — 채워지되 gap 은 없다.
    const filled = trend?.points.find((p) => p.bucketStart === "2026-08-31");
    expect(filled).toBeDefined();
    expect(filled?.gap).toBeUndefined();
    // 마커가 붙은 점은 정확히 하나(숨긴 회차의 주)여야 한다.
    expect(trend?.points.filter((p) => p.gap).map((p) => p.bucketStart)).toEqual(["2026-08-24"]);
  });
});
