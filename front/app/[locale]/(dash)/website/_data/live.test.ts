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
  fetchWebsiteTargetHitRate: vi.fn(),
}));

import {
  fetchWebsiteAggregates,
  fetchWebsiteTrend,
  fetchWebsitePromptTopics,
  fetchWebsiteSourceComposition,
  fetchWebsiteCitationAccuracy,
  fetchWebsiteCitationAccuracyTrend,
  fetchWebsiteTargetHitRate,
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
    // GGMD-61 — 프롬프트 기준 카드 2종. 기본값은 측정 대기(분모 0).
    vi.mocked(fetchWebsiteTargetHitRate).mockResolvedValue({
      hitPrompts: 0,
      ownedPrompts: 0,
      measuredPrompts: 0,
      rate: null,
      ownedRate: null,
    });
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

  // GGMD-61 — 자사 URL·타겟 URL 카드는 **프롬프트 기준 비율**이고, 두 값은 같은
  // 집계 응답 하나에서 나온다(같은 snap·같은 분모). 분모가 갈릴 자리가 없어야 한다.
  it("GGMD-61: owned/target URL cards are prompt-basis rates sharing one denominator, left of ⑤⑥", async () => {
    const { KPI_DEFINITIONS } = await import("../../dashboard/_data/sample");
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
    vi.mocked(fetchWebsiteTargetHitRate).mockResolvedValue({
      hitPrompts: 5820,
      ownedPrompts: 7000,
      measuredPrompts: 9984,
      rate: 58.3,
      ownedRate: 70.1,
    });
    expect(fetchWebsiteTargetHitRate).toHaveBeenCalledTimes(0);

    const data = await getLiveWebsiteDashboard({});
    const owned = data?.kpis.find((k) => k.key === "ownedUrlRate");
    const target = data?.kpis.find((k) => k.key === "targetUrlRate");

    expect(owned?.value).toBe(70.1);
    expect(target?.value).toBe(58.3);
    // 하단 두 줄 = 분자·분모(프롬프트). 두 카드의 분모는 **같은 값**이어야 한다(A1).
    expect(owned?.ratio).toEqual({ numerator: 7000, denominator: 9984 });
    expect(target?.ratio).toEqual({ numerator: 5820, denominator: 9984 });
    expect(owned?.ratio?.denominator).toBe(target?.ratio?.denominator);
    // 타겟 ⊂ 자사 (A2).
    expect(target?.ratio?.numerator).toBeLessThanOrEqual(owned!.ratio!.numerator);
    // Δ 칩 없음(결정 5).
    expect(owned?.delta).toBeNull();
    expect(target?.delta).toBeNull();
    // 집계 조회는 한 번 — 두 카드가 같은 응답을 쓴다.
    expect(fetchWebsiteTargetHitRate).toHaveBeenCalledTimes(1);
    // ⑤⑥ 는 불변 — ⑥ 는 여전히 답변 그레인(8/40).
    expect(data?.kpis.find((k) => k.key === "citationAccuracy")?.ratio)
      .toEqual({ numerator: 8, denominator: 40 });
    expect(data?.kpis.find((k) => k.key === "citationShare")?.ratio)
      .toEqual({ numerator: 5, denominator: 20 });

    // 화면 순서 = KPI_DEFINITIONS 의 source 카테고리 순서: 자사 → 타겟 → ⑤ → ⑥.
    const sourceOrder = KPI_DEFINITIONS.filter((d) => d.category === "source").map((d) => d.key);
    expect(sourceOrder).toEqual(["ownedUrlRate", "targetUrlRate", "citationShare", "citationAccuracy"]);
    // 둘 다 비율 단위 — 타일이 % 로 그린다.
    expect(KPI_DEFINITIONS.find((d) => d.key === "ownedUrlRate")?.unit).toBe("percent");
    expect(KPI_DEFINITIONS.find((d) => d.key === "targetUrlRate")?.unit).toBe("percent");
  });

  // 분모 0 = 측정 대기(null). 0% 와 구분해야 한다 — 0% 는 "측정했는데 한 건도 없다".
  it("GGMD-61: zero measured prompts renders pending (null), not 0%", async () => {
    vi.mocked(fetchWebsiteAggregates).mockResolvedValue({
      totalAnswers: 10, trackedAnswerCount: 6, totalMentions: 20,
      brands: [], regions: [],
      citations: { sampledAnswers: 10, answersWithCitation: 8, totalCitations: 20, ownedCitations: 0, domains: [] },
      position: { avgPosition: null, sampledAnswers: 0 },
      sentiment: { positiveRate: null, positiveMentions: 0, sampledMentions: 0 },
    } as never);
    const data = await getLiveWebsiteDashboard({});
    const owned = data?.kpis.find((k) => k.key === "ownedUrlRate");
    const target = data?.kpis.find((k) => k.key === "targetUrlRate");
    expect(owned?.value).toBeNull();
    expect(target?.value).toBeNull();
    // 근거 행도 숨긴다 — 0/0 은 보여줄 값이 아니다.
    expect(owned?.ratio).toBeUndefined();
    expect(target?.ratio).toBeUndefined();
    expect(data?.kpis.find((k) => k.key === "citationAccuracy")?.value).toBeNull();
  });

  // 측정은 됐는데 인용이 하나도 없으면 0% — 측정 대기가 아니다.
  it("GGMD-61: measured prompts with no citation renders 0% (not pending)", async () => {
    vi.mocked(fetchWebsiteAggregates).mockResolvedValue({
      totalAnswers: 10, trackedAnswerCount: 6, totalMentions: 20,
      brands: [], regions: [],
      citations: { sampledAnswers: 10, answersWithCitation: 0, totalCitations: 0, ownedCitations: 0, domains: [] },
      position: { avgPosition: null, sampledAnswers: 0 },
      sentiment: { positiveRate: null, positiveMentions: 0, sampledMentions: 0 },
    } as never);
    vi.mocked(fetchWebsiteTargetHitRate).mockResolvedValue({
      hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 120, rate: 0, ownedRate: 0,
    });
    const data = await getLiveWebsiteDashboard({});
    expect(data?.kpis.find((k) => k.key === "ownedUrlRate")?.value).toBe(0);
    expect(data?.kpis.find((k) => k.key === "targetUrlRate")?.value).toBe(0);
    expect(data?.kpis.find((k) => k.key === "ownedUrlRate")?.ratio)
      .toEqual({ numerator: 0, denominator: 120 });
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

  // GGMD-61 — 새 카드(프롬프트 기준 비율)에는 Δ 칩이 없다(제품 결정 5). 종전에 추이에
  // 실리던 ⑥ 의 분모·분자 건수(`ownedUrlAnswers`·`targetUrlAnswers`)는 그 Δ 의 유일한
  // 원천이었으므로 함께 제거됐다. 이 테스트가 그 제거를 못 박는다 — 되돌아오면 키가
  // 다시 추이에 실려 화면에 정의 없는 Δ 가 뜬다. ⑥ 비율 병합은 종전 그대로.
  it("GGMD-61: 추이에는 인용 건수를 싣지 않는다 (새 카드 Δ 없음) · ⑥ 비율 병합은 불변", async () => {
    const point = (start: string, gap?: unknown) => ({
      bucketStart: start,
      cycleAnchorAt: `${start}T00:00:00.000Z`,
      ...(gap ? { gap } : {}),
      answers: gap ? 0 : 10, trackedAnswers: gap ? 0 : 6,
      totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0,
      avgPosition: null, totalCitations: 0, ownedCitations: 0, measuredDays: 1,
      firstAt: `${start}T00:00:00.000Z`, lastAt: `${start}T00:00:00.000Z`,
    });
    vi.mocked(fetchWebsiteTrend).mockResolvedValue([
      point("2026-08-21"),
      point("2026-08-28", { scope: "citations", reason: "collection_error" }),
      point("2026-09-11"),
    ] as never);
    const acc = (start: string, owned: number, target: number) => ({
      bucketStart: start, ownedAnswers: owned, targetAnswers: target,
      rate: owned > 0 ? Math.round((1000 * target) / owned) / 10 : null,
      measuredDays: 1, firstAt: null, lastAt: null,
    });
    vi.mocked(fetchWebsiteCitationAccuracyTrend).mockResolvedValue([
      acc("2026-08-21", 30, 10),
      acc("2026-08-28", 99, 99),
      acc("2026-09-11", 40, 8),
    ] as never);

    const trend = await getLiveWebsiteTrend({}, "week");
    // 어떤 점에도 건수 키가 없다(값 객체의 키 자체가 비어 있어야 한다).
    const carriedKeys = new Set(trend!.points.flatMap((p) => Object.keys(p.values)));
    expect(carriedKeys.has("ownedUrlAnswers")).toBe(false);
    expect(carriedKeys.has("targetUrlAnswers")).toBe(false);
    expect(carriedKeys.has("ownedUrlRate")).toBe(false);
    expect(carriedKeys.has("targetUrlRate")).toBe(false);
    // ⑥ 비율 병합은 종전 그대로(갭 가드 없음 — /projects 와 같은 동작, 검증자 F-3).
    expect(trend?.points[1]?.values.citationAccuracy).toBe(100);
    expect(trend?.points[2]?.values.citationAccuracy).toBe(20);
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
