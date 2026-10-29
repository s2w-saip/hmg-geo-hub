import { beforeEach, describe, expect, it, vi } from "vitest";

// 갭의 **범위**(0071) — 인용만 깨진 회차에서 언급 값을 살린다.
//
// 배경(운영 2026-09-11): "8/24 인용만 누락된거라 멘션에 대한 부분은 살려줘야해."
// 8/25 글로벌 회차는 chatgpt 인용 수집만 깨졌고(인용률 3.8% vs 이웃 55~80%) 언급은
// 정상이다(83.8%/93.5%). 원장이 `hidden_scope='citations'` 로 그 사실을 들고 있고,
// 미러 리더의 언급 술어가 완화돼 그 주 버킷이 **값을 실은 채** 여기까지 온다.
//
// 이 계층(값 계산)이 지킬 것 셋:
//   ① `scope:"citations"` + 값 있음 → ①~④ 를 계산한다(오늘은 통째로 버린다 = FAIL)
//   ② 같은 버킷의 ⑤(인용 점유율)는 **끝까지 null** — 갭 계열의 값은 만들지 않는다
//   ③ `scope` 없는 갭(종전 `all`)·값 없는 갭 슬롯은 **오늘과 동일**(회귀)

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
const { getLiveTrend } = await import("./live");

/** 미러 주 격자 버킷(표시자 없음). 인용·언급 값이 다 있는 정상 주. */
const weekBucket = (day: string, over: Record<string, unknown> = {}) => ({
  bucketStart: day,
  answers: 100,
  trackedAnswers: 60,
  totalMentions: 400,
  trackedMentions: 100,
  sentMentions: 200,
  positiveMentions: 100,
  avgPosition: 2.5,
  totalCitations: 80,
  ownedCitations: 20,
  measuredDays: 7,
  firstAt: `${day}T00:00:00.000Z`,
  lastAt: `${day}T00:00:00.000Z`,
  ...over,
});

const CITATIONS_GAP = { reason: "collection_error", scope: "citations" } as const;
const ALL_GAP = { reason: "collection_error" } as const;

describe("혼합 버킷 — `scope:\"citations\"` 는 언급 값을 살린다", () => {
  beforeEach(() => vi.clearAllMocks());

  /** 8/24 실물 모양 — 언급은 살아 있고 인용만 0, 마커는 인용 범위. */
  const survivingBucket = () =>
    weekBucket("2026-08-24", {
      totalCitations: 0,
      ownedCitations: 0,
      gap: CITATIONS_GAP,
    });

  it("①~④ 가 계산된다 — 오늘은 통째로 버려 빈 점이 된다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      survivingBucket(),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values.visibility).toBe(60);
    expect(p.values.shareOfVoice).toBe(25);
    expect(p.values.sentiment).toBe(50);
    expect(p.values.position).toBe(2.5);
  });

  it("⑤ 인용 점유율만 null 이다 — 갭 계열의 값은 만들지 않는다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      survivingBucket(),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values.citationShare).toBeUndefined();
  });

  it("인용 값이 남아 있어도 인용 계열 갭이면 ⑤ 를 안 만든다(계약: 갭 계열 값은 null)", async () => {
    // 방어선 — 마커와 값이 같이 오는 버킷은 원래 생기지 않지만(`trendGapKeysToMark`
    // 가 `totalCitations > 0` 을 거른다), 여기서 계산해 버리면 "음영 위에 점" 이 된다.
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      weekBucket("2026-08-24", { gap: CITATIONS_GAP }),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values.citationShare).toBeUndefined();
    expect(p.values.visibility).toBe(60);
  });

  it("마커·모수(answers)·측정일수를 그대로 나른다 — 그 주 언급 측정은 실재한다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      survivingBucket(),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.gap).toEqual(CITATIONS_GAP);
    expect(p.answers).toBe(100);
    expect(p.measuredDays).toBe(7);
    expect(trend!.totalAnswers).toBe(300);
  });
});

describe("회귀 — 종전 갭은 한 글자도 안 바뀐다", () => {
  beforeEach(() => vi.clearAllMocks());

  const emptyGap = (day: string, gap: unknown) =>
    weekBucket(day, {
      answers: 0,
      trackedAnswers: 0,
      totalMentions: 0,
      trackedMentions: 0,
      sentMentions: 0,
      positiveMentions: 0,
      avgPosition: null,
      totalCitations: 0,
      ownedCitations: 0,
      measuredDays: 0,
      firstAt: null,
      lastAt: null,
      gap,
    });

  it("`scope` 없는 갭 슬롯 → 값 전부 없음 + 마커(오늘 그대로)", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      emptyGap("2026-08-24", ALL_GAP),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values).toEqual({});
    expect(p.gap).toEqual(ALL_GAP);
    expect(p.answers).toBe(0);
  });

  it("`scope:\"all\"` 을 명시해도 같다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      emptyGap("2026-08-24", { reason: "collection_error", scope: "all" }),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values).toEqual({});
  });

  it("값이 하나도 없는 `citations` 슬롯(사실표 회차 축 삽입, D-4 A)도 빈 점이다 — `pct(0,0)` 금지", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      emptyGap("2026-08-24", CITATIONS_GAP),
      weekBucket("2026-08-31"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    const p = trend!.points.find((x) => x.bucketStart === "2026-08-24")!;
    expect(p.values).toEqual({});
    // 마커는 남아야 인용 카드가 음영을 그린다.
    expect(p.gap).toEqual(CITATIONS_GAP);
  });

  it("갭이 없는 데이터는 그대로다", async () => {
    vi.mocked(fetchStandardTrend).mockResolvedValue([
      weekBucket("2026-08-17"),
      weekBucket("2026-08-24"),
    ] as never);
    const trend = await getLiveTrend({}, "week");
    expect(trend!.points.every((p) => p.gap === undefined)).toBe(true);
    expect(trend!.points[1].values.citationShare).toBe(25);
  });
});
