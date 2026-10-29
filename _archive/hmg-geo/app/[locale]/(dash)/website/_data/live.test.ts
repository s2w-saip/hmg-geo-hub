import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/scope/server", () => ({
  fetchWebsiteAggregates: vi.fn(),
  fetchWebsiteGeoCompetition: vi.fn(),
  fetchWebsiteTrend: vi.fn(),
  fetchWebsiteSubKpis: vi.fn(),
  fetchWebsitePromptTopics: vi.fn(),
  fetchWebsiteSourceComposition: vi.fn(),
  fetchWebsiteCitationAccuracy: vi.fn(),
  fetchWebsiteCitationAccuracyTrend: vi.fn(),
}));

import {
  fetchWebsiteAggregates,
  fetchWebsiteTrend,
  fetchWebsitePromptTopics,
  fetchWebsiteSourceComposition,
  fetchWebsiteCitationAccuracy,
  fetchWebsiteCitationAccuracyTrend,
  fetchWebsiteSubKpis,
} from "@/lib/scope/server";
import {
  getLiveWebsiteDashboard,
  getLiveWebsiteTrend,
  getLiveWebsiteComposition,
  getLiveWebsiteSubKpis,
} from "./live";

describe("website live view-model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ⑥ 타겟 인용률 — 대부분의 테스트는 값이 없어도 무방하도록 기본값.
    vi.mocked(fetchWebsiteCitationAccuracy).mockResolvedValue({
      ownedAnswers: 0,
      targetAnswers: 0,
      rate: null,
    });
    vi.mocked(fetchWebsiteCitationAccuracyTrend).mockResolvedValue([]);
  });

  it("builds citation-share KPI from website aggregates", async () => {
    vi.mocked(fetchWebsiteAggregates).mockResolvedValue({
      totalAnswers: 10,
      trackedAnswerCount: 6,
      totalMentions: 20,
      brands: [
        { name: "Hyundai", mentionCount: 8, answerCount: 6, isTracked: true },
        { name: "Tesla", mentionCount: 12, answerCount: 7, isTracked: false },
      ],
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
    } as never);

    const data = await getLiveWebsiteDashboard({});
    const citationShare = data?.kpis.find((k) => k.key === "citationShare");

    expect(citationShare?.value).toBe(25);
    expect(citationShare?.ratio).toEqual({ numerator: 5, denominator: 20 });
  });

  it("builds ⑥ citationAccuracy KPI from website target-url accuracy", async () => {
    vi.mocked(fetchWebsiteAggregates).mockResolvedValue({
      totalAnswers: 10,
      trackedAnswerCount: 6,
      totalMentions: 20,
      brands: [{ name: "Hyundai", mentionCount: 8, answerCount: 6, isTracked: true }],
      regions: [],
      citations: { sampledAnswers: 10, answersWithCitation: 8, totalCitations: 20, ownedCitations: 5, domains: [] },
      position: { avgPosition: 2.5, sampledAnswers: 6 },
      sentiment: { positiveRate: 50, positiveMentions: 3, sampledMentions: 6 },
    } as never);
    vi.mocked(fetchWebsiteCitationAccuracy).mockResolvedValue({
      ownedAnswers: 40,
      targetAnswers: 8,
      rate: 20,
    });

    const data = await getLiveWebsiteDashboard({});
    const accuracy = data?.kpis.find((k) => k.key === "citationAccuracy");

    expect(accuracy?.value).toBe(20);
    expect(accuracy?.ratio).toEqual({ numerator: 8, denominator: 40 });
  });

  it("builds trend citationShare from website buckets", async () => {
    vi.mocked(fetchWebsiteTrend).mockResolvedValue([
      {
        bucketStart: "2026-06-01",
        answers: 4,
        trackedAnswers: 2,
        totalMentions: 8,
        trackedMentions: 3,
        sentMentions: 2,
        positiveMentions: 1,
        avgPosition: 2.5,
        totalCitations: 10,
        ownedCitations: 4,
        measuredDays: 1,
        firstAt: "2026-06-01T00:00:00.000Z",
        lastAt: "2026-06-01T00:00:00.000Z",
      },
      {
        bucketStart: "2026-06-08",
        answers: 5,
        trackedAnswers: 3,
        totalMentions: 10,
        trackedMentions: 5,
        sentMentions: 3,
        positiveMentions: 2,
        avgPosition: 2.1,
        totalCitations: 20,
        ownedCitations: 5,
        measuredDays: 1,
        firstAt: "2026-06-08T00:00:00.000Z",
        lastAt: "2026-06-08T00:00:00.000Z",
      },
    ] as never);

    const trend = await getLiveWebsiteTrend({}, "week");

    expect(trend?.points[0]?.values.citationShare).toBe(40);
    expect(trend?.points[1]?.values.citationShare).toBe(25);
  });

  // 회차 버킷(PR③) — `cycleAnchorAt` 이 있으면 **빈 주를 채우지 않는다**. 회차 간격은
  // 주 격자가 아니고, 회차 없는 주는 점이 없는 것이 화면 계약이다.
  it("cycle-bucketed trend keeps only measured points (no week gap filling)", async () => {
    const bucket = (start: string, cycle?: string) => ({
      bucketStart: start,
      ...(cycle ? { cycleAnchorAt: cycle } : {}),
      answers: 4, trackedAnswers: 2, totalMentions: 8, trackedMentions: 3,
      sentMentions: 2, positiveMentions: 1, avgPosition: 2.5,
      totalCitations: 10, ownedCitations: 4, measuredDays: 1,
      firstAt: `${start}T00:00:00.000Z`, lastAt: `${start}T00:00:00.000Z`,
    });
    // 3주 떨어진 두 회차 — 주 격자였다면 사이에 빈 점 2개가 생긴다.
    vi.mocked(fetchWebsiteTrend).mockResolvedValue([
      bucket("2026-08-21", "2026-08-21T00:00:00.000Z"),
      bucket("2026-09-11", "2026-09-11T00:00:00.000Z"),
    ] as never);
    vi.mocked(fetchWebsiteCitationAccuracyTrend).mockResolvedValue([
      { bucketStart: "2026-09-11", ownedAnswers: 4, targetAnswers: 3, rate: 75, measuredDays: 1, firstAt: null, lastAt: null },
    ] as never);

    const cycled = await getLiveWebsiteTrend({}, "week");
    expect(cycled?.points.map((p) => p.bucketStart)).toEqual(["2026-08-21", "2026-09-11"]);
    // ⑥ 는 같은 bucketStart 로 병합된다.
    expect(cycled?.points[1]?.values.citationAccuracy).toBe(75);

    // 미러 경로(회차 표시자 없음)는 종전대로 주 격자를 채운다 — 회귀 방지.
    vi.mocked(fetchWebsiteCitationAccuracyTrend).mockResolvedValue([] as never);
    vi.mocked(fetchWebsiteTrend).mockResolvedValue([
      bucket("2026-08-21"),
      bucket("2026-09-11"),
    ] as never);
    const weekly = await getLiveWebsiteTrend({}, "week");
    expect(weekly?.points.map((p) => p.bucketStart)).toEqual([
      "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11",
    ]);
  });

  // Δ 계약 — 회차 버킷에서 Δ 는 **직전 회차 대비**다(검증자 D-3). `applyTrendDeltas` 는
  // "값 있는 마지막 두 점" 을 보므로 산식은 그대로이고, 축이 회차로 바뀌면서 의미가
  // "직전 주" → "직전 회차" 로 옮겨간다. 그 의미를 여기서 실행으로 못 박는다.
  it("cycle-bucketed Δ compares the last two cycles (not weeks)", async () => {
    const { applyTrendDeltas } = await import("../../dashboard/_data/live");
    const point = (start: string, tracked: number, answers: number) => ({
      bucketStart: start,
      cycleAnchorAt: `${start}T00:00:00.000Z`,
      answers,
      trackedAnswers: tracked,
      totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0,
      avgPosition: null, totalCitations: 0, ownedCitations: 0, measuredDays: 1,
      firstAt: `${start}T00:00:00.000Z`, lastAt: `${start}T00:00:00.000Z`,
    });
    // 회차 3개(주 간격이 아니다) — 8/21 60% · 9/04 70% · 9/11 85%.
    vi.mocked(fetchWebsiteTrend).mockResolvedValue([
      point("2026-08-21", 6, 10),
      point("2026-09-04", 7, 10),
      point("2026-09-11", 17, 20),
    ] as never);
    vi.mocked(fetchWebsiteCitationAccuracyTrend).mockResolvedValue([] as never);

    const trend = await getLiveWebsiteTrend({}, "week");
    // 빈 주가 끼지 않았다 = Δ 가 "직전 회차" 를 본다는 전제.
    expect(trend?.points.map((p) => p.bucketStart)).toEqual([
      "2026-08-21", "2026-09-04", "2026-09-11",
    ]);
    const [kpi] = applyTrendDeltas(
      [{ key: "visibility", label: "", value: 85, delta: null, direction: "flat" }] as never,
      trend,
    );
    expect(kpi.delta).toBe(15); // 85 − 70 (직전 회차), 주 격자였다면 빈 점이 끼어 null
    expect(kpi.direction).toBe("up");
  });

  it("keeps website source composition stable", async () => {
    vi.mocked(fetchWebsitePromptTopics).mockResolvedValue([
      { topic: "awareness", prompts: 3 },
    ] as never);
    vi.mocked(fetchWebsiteSourceComposition).mockResolvedValue([
      { domain: "kia.com", citations: 5, share: 50, isOurs: true },
      { domain: "reddit.com", citations: 5, share: 50, isOurs: false },
    ] as never);

    const composition = await getLiveWebsiteComposition({});

    expect(composition.topics[0]?.share).toBe(100);
    expect(composition.sources).toEqual([
      { domain: "kia.com", citations: 5, share: 50, isOurs: true },
      { domain: "reddit.com", citations: 5, share: 50, isOurs: false },
    ]);
  });

  // B6 회귀 가드 — 대시보드 배지는 **S5 가 아니라 `S4.subkpi`** 키로 읽는다.
  // 이 단언이 없으면 `{ screen }` 인자를 지워도 전 테스트가 통과한다(검증자 D4).
  it("대시보드 Sub-KPI 는 S4.subkpi 화면 키로 부른다", async () => {
    vi.mocked(fetchWebsiteSubKpis).mockResolvedValue({
      rows: [], promptsWithoutBrand: null, measuredPrompts: null,
    });
    const filters = { websiteCountry: ["KR"] };
    await getLiveWebsiteSubKpis(filters);
    expect(fetchWebsiteSubKpis).toHaveBeenCalledWith(filters, { screen: "S4.subkpi" });
  });
});
