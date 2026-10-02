import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ko from "@/messages/ko.json";
import type { ProjectDashboard as ProjectDashboardData } from "../_data/live";

// 서버 컴포넌트라 `next-intl/server` 의 `getTranslations` 를 세운다. 문구는 지어내지
// 않고 **실제 `messages/ko.json`** 에서 뽑는다 — 죽은 키를 쓰면 여기서 바로 죽는다
// (`citations-standard-view.render.test.tsx` 가 `ko.…` 로 단언하는 것과 같은 규율).
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => {
    const path = [...namespace.split("."), ...key.split(".")];
    const value = path.reduce<unknown>(
      (node, seg) => (node as Record<string, unknown> | undefined)?.[seg],
      ko,
    );
    if (typeof value !== "string") throw new Error(`missing i18n key: ${namespace}.${key}`);
    return value;
  },
}));
vi.mock("../_data/live", () => ({ getProjectDashboard: vi.fn() }));
// 자식은 클라이언트 컴포넌트(intl provider·recharts) — 이 테스트의 관심사가 아니다.
vi.mock("../../../dashboard/_components/summary-tiles", () => ({
  SummaryTiles: () => <div data-testid="summary-tiles" />,
}));
vi.mock("../../../dashboard/_components/live-trend-chart", () => ({
  LiveTrendChart: () => <div data-testid="live-trend-chart" />,
}));
vi.mock("../../../dashboard/_components/composition-panel", () => ({
  CompositionPanel: () => <div data-testid="composition-panel" />,
}));

import { getProjectDashboard } from "../_data/live";
import { ProjectMeasurementSections } from "./project-dashboard";

const ACCRUING = ko.dashboard.trend.accruing;
const DEGRADED = ko.answerAnalysis.mentions.kpi.degraded;

function model(overrides: Partial<ProjectDashboardData>): ProjectDashboardData {
  return {
    kpis: [],
    trend: null,
    trendDegraded: false,
    composition: { topics: [], sources: [] },
    citationAccuracyNotice: null,
    ...overrides,
  };
}

async function render(data: ProjectDashboardData): Promise<string> {
  vi.mocked(getProjectDashboard).mockResolvedValue(data);
  return renderToStaticMarkup(
    await ProjectMeasurementSections({
      projectId: "p1",
      filters: {},
      hasMeasuredPrompts: true,
    }),
  );
}

const point = (bucketStart: string, visibility: number) => ({
  bucketStart, firstAt: null, lastAt: null, measuredDays: 1, answers: 10,
  values: { visibility },
});

// 추이 슬롯의 세 상태를 고정한다. 핵심은 ①과 ②의 구분 — 둘 다 `trend === null` 인데
// 사유가 다르다(예산 초과 vs 아직 2버킷 미만). 표식이 없으면 화면이 ①을 ②로 위장한다.
describe("프로젝트 추이 슬롯 — degrade / 집계 중 / 차트", () => {
  it("① trend=null + degraded → 지연 문구를 내고 '집계 중' 을 숨긴다", async () => {
    const html = await render(model({ trend: null, trendDegraded: true }));

    expect(html).toContain(DEGRADED);
    expect(html).not.toContain(ACCRUING);
  });

  it("② trend=null + degrade 아님 → 종전대로 '집계 중' 을 유지한다", async () => {
    const html = await render(model({ trend: null, trendDegraded: false }));

    expect(html).toContain(ACCRUING);
    expect(html).not.toContain(DEGRADED);
  });

  it("③ 버킷 2개 이상이면 차트를 그린다", async () => {
    const html = await render(model({
      trend: {
        unit: "week",
        lastMeasuredAt: "2026-09-07T00:00:00.000Z",
        totalAnswers: 20,
        points: [point("2026-08-31", 40), point("2026-09-07", 50)],
      },
    }));

    expect(html).toContain('data-testid="live-trend-chart"');
    expect(html).not.toContain(ACCRUING);
    expect(html).not.toContain(DEGRADED);
  });
});
