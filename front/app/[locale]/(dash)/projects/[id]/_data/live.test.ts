import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/scope/server", () => ({
  fetchProjectStandardAggregates: vi.fn(),
  fetchProjectCitationAccuracy: vi.fn(),
  fetchProjectCitationAccuracyTrend: vi.fn(),
  wasDegraded: vi.fn(() => false),
}));
vi.mock("@/lib/db/repositories/project-tracked-urls", () => ({
  listProjectTrackedUrls: vi.fn(),
}));
vi.mock("@/lib/db/repositories/project-owned-bases", () => ({
  listProjectOwnedBases: vi.fn(),
}));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn() },
}));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  // KPI #16 — 타겟 미지정(null) 기본: applyCompetitorSov는 SOV 1위 자동 폴백.
  trackedCompetitorRepository: { getTargetBrand: vi.fn(() => Promise.resolve(null)) },
}));
vi.mock("@/lib/ga4/property-map", () => ({
  resolveProperty: vi.fn(async () => null),
}));
vi.mock("@/lib/ga4/conversion", () => ({
  getAiTrafficConversionKpi: vi.fn(),
}));
vi.mock("../../../dashboard/_data/live", async () => {
  const actual = await vi.importActual<typeof import("../../../dashboard/_data/live")>(
    "../../../dashboard/_data/live",
  );
  return {
    ...actual,
    getLiveTrend: vi.fn(),
    getLiveComposition: vi.fn(),
    getLiveSubKpis: vi.fn(),
  };
});

import {
  fetchProjectStandardAggregates,
  fetchProjectCitationAccuracy,
  fetchProjectCitationAccuracyTrend,
  wasDegraded,
} from "@/lib/scope/server";
import { listProjectTrackedUrls } from "@/lib/db/repositories/project-tracked-urls";
import { listProjectOwnedBases } from "@/lib/db/repositories/project-owned-bases";
import { projectRepository } from "@/lib/db/repositories/projects";
import {
  getLiveTrend,
  getLiveComposition,
  getLiveSubKpis,
} from "../../../dashboard/_data/live";
import { resolveProperty } from "@/lib/ga4/property-map";
import { getAiTrafficConversionKpi } from "@/lib/ga4/conversion";
import { getProjectDashboard } from "./live";

describe("getProjectDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wasDegraded).mockReturnValue(false);
    vi.mocked(fetchProjectStandardAggregates).mockResolvedValue({
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
    vi.mocked(getLiveSubKpis).mockResolvedValue({ rows: [], promptsWithoutBrand: null } as never);
    vi.mocked(getLiveComposition).mockResolvedValue({ topics: [], sources: [] } as never);
    vi.mocked(listProjectTrackedUrls).mockResolvedValue([
      { id: "u1", projectId: "p1", url: "https://kia.com/it/model", label: null, createdBy: "x", createdAt: new Date(0) },
    ] as never);
    vi.mocked(projectRepository.getById).mockResolvedValue({
      id: "p1",
      brand: "Kia",
      country: "IT",
      domain: "kia.com/it",
      ga4PropertyId: null,
    } as never);
    vi.mocked(listProjectOwnedBases).mockResolvedValue([
      { id: "b1", projectId: "p1", baseUrl: "kia.com/it", label: null, createdBy: "x", createdAt: new Date(0) },
    ] as never);
    vi.mocked(fetchProjectCitationAccuracy).mockResolvedValue({
      ownedAnswers: 5,
      targetAnswers: 2,
      rate: 40,
    });
    vi.mocked(getLiveTrend)
      .mockResolvedValueOnce({
        unit: "week",
        points: [
          {
            bucketStart: "2026-06-02",
            firstAt: "2026-06-02T00:00:00.000Z",
            values: { citationShare: 20 },
            measuredDays: 1,
            answers: 3,
            lastAt: "2026-06-02T00:00:00.000Z",
          },
        ],
        lastMeasuredAt: "2026-06-02T00:00:00.000Z",
        totalAnswers: 3,
      } as never)
      .mockResolvedValueOnce({
        unit: "day",
        points: [
          {
            bucketStart: "2026-06-09",
            firstAt: "2026-06-09T00:00:00.000Z",
            values: { citationShare: 25 },
            measuredDays: 1,
            answers: 2,
            lastAt: "2026-06-09T00:00:00.000Z",
          },
          {
            bucketStart: "2026-06-10",
            firstAt: "2026-06-10T00:00:00.000Z",
            values: { citationShare: 30 },
            measuredDays: 1,
            answers: 2,
            lastAt: "2026-06-10T00:00:00.000Z",
          },
        ],
        lastMeasuredAt: "2026-06-10T00:00:00.000Z",
        totalAnswers: 4,
      } as never);
    vi.mocked(fetchProjectCitationAccuracyTrend)
      .mockResolvedValueOnce([
        {
          bucketStart: "2026-06-02",
          ownedAnswers: 5,
          targetAnswers: 2,
          rate: 40,
          measuredDays: 1,
          firstAt: "2026-06-02T00:00:00.000Z",
          lastAt: "2026-06-02T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          bucketStart: "2026-06-09",
          ownedAnswers: 5,
          targetAnswers: 2,
          rate: 40,
          measuredDays: 1,
          firstAt: "2026-06-09T00:00:00.000Z",
          lastAt: "2026-06-09T00:00:00.000Z",
        },
        {
          bucketStart: "2026-06-10",
          ownedAnswers: 6,
          targetAnswers: 3,
          rate: 50,
          measuredDays: 1,
          firstAt: "2026-06-10T00:00:00.000Z",
          lastAt: "2026-06-10T00:00:00.000Z",
        },
      ]);
  });

  it("merges citationAccuracy trend into project trend and delta", async () => {
    const data = await getProjectDashboard("p1", {}, "week");
    const citationAccuracy = data?.kpis.find((k) => k.key === "citationAccuracy");

    expect(citationAccuracy?.value).toBe(40);
    expect(citationAccuracy?.delta).toBe(10);
    expect(citationAccuracy?.ratio).toEqual({ numerator: 2, denominator: 5 });
    expect(data?.trend?.points[0]?.values.citationAccuracy).toBe(40);
  });

  // 추이 슬롯의 `null` 두 뜻을 화면이 가르려면 표식이 모델까지 와야 한다.
  // 라벨은 **차트 버킷 단위**여야 한다 — 같은 요청의 `day`(KPI Δ 칩) 호출이 걸렸다고
  // 멀쩡한 주별 차트를 "지연" 으로 덮으면 안 된다.
  it("carries the bucket-scoped projectTrend degrade marker to the dashboard model", async () => {
    vi.mocked(wasDegraded).mockReturnValue(true);

    const data = await getProjectDashboard("p1", {}, "week");

    expect(wasDegraded).toHaveBeenCalledWith("projectTrend:week");
    expect(wasDegraded).not.toHaveBeenCalledWith("projectTrend:day");
    expect(data?.trendDegraded).toBe(true);
  });

  it("degrade 표식이 없으면 trendDegraded 는 false 다 (종전 '집계 중' 경로)", async () => {
    const data = await getProjectDashboard("p1", {}, "week");

    expect(data?.trendDegraded).toBe(false);
  });

  // 카드 표시조건 (2026-09-01) — GA4 미연동/추적 URL 미등록이면 항목 자체를 빼서
  // SummaryTiles 가 카드(그리고 마지막 KPI 면 카테고리 섹션까지) 를 숨기게 한다.
  // "측정 대기" 칩이 상시 떠 있던 것이 이 계약 위반이었다.
  it("omits trafficConversion when the project has no GA4 property mapping", async () => {
    // 기본 픽스처의 resolveProperty 는 null (= GA4 미연동).
    const data = await getProjectDashboard("p1", {}, "week");

    expect(data?.kpis.some((k) => k.key === "trafficConversion")).toBe(false);
  });

  it("includes trafficConversion when a GA4 property resolves", async () => {
    vi.mocked(resolveProperty).mockResolvedValue("469542848");
    vi.mocked(getAiTrafficConversionKpi).mockResolvedValue({
      aiConvRate: 8.5,
      aiKeyEvents: 105,
      aiUsers: 1240,
    } as never);

    const data = await getProjectDashboard("p1", {}, "week");
    const conv = data?.kpis.find((k) => k.key === "trafficConversion");

    expect(conv?.value).toBe(8.5);
    expect(conv?.ratio).toEqual({ numerator: 105, denominator: 1240 });
  });

  it("omits citationAccuracy when no tracked URL is registered", async () => {
    vi.mocked(listProjectTrackedUrls).mockResolvedValue([] as never);

    const data = await getProjectDashboard("p1", {}, "week");

    expect(data?.kpis.some((k) => k.key === "citationAccuracy")).toBe(false);
  });

  it("suppresses the legacyDomainFallback notice when the card itself is hidden", async () => {
    // owned base 0개(= project.domain 폴백) + 추적 URL 0개 → 카드가 사라지므로
    // "domain 으로 계산했다" 안내만 남으면 가리킬 카드가 없다.
    vi.mocked(listProjectOwnedBases).mockResolvedValue([] as never);
    vi.mocked(listProjectTrackedUrls).mockResolvedValue([] as never);

    const data = await getProjectDashboard("p1", {}, "week");

    expect(data?.kpis.some((k) => k.key === "citationAccuracy")).toBe(false);
    expect(data?.citationAccuracyNotice).toBeNull();
  });

  it("keeps the hiddenMultipleOwnedBases notice — it explains the missing card", async () => {
    vi.mocked(listProjectOwnedBases).mockResolvedValue([
      { id: "b1", projectId: "p1", baseUrl: "kia.com/it", label: null, createdBy: "x", createdAt: new Date(0) },
      { id: "b2", projectId: "p1", baseUrl: "kia.it", label: null, createdBy: "x", createdAt: new Date(0) },
    ] as never);

    const data = await getProjectDashboard("p1", {}, "week");

    expect(data?.kpis.some((k) => k.key === "citationAccuracy")).toBe(false);
    expect(data?.citationAccuracyNotice).toBe("hiddenMultipleOwnedBases");
  });
});
