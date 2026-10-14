import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ko from "@/messages/ko.json";
import type { ProjectDashboard as ProjectDashboardData } from "../_data/live";

// 프로젝트 홈의 섹션 지연 고지(B027). 구성 패널·⑦ '답변의 전환' 은 일시 실패면 섹션째 사라졌다 — api 원천이
// 라벨(PROJECT_COMPOSITION_LABEL·PROJECT_CONVERSION_LABEL)을 남기고 화면은 그 자리에 기존 `DegradeNotice`
// (kpi.degraded)를 낸다. 표식(`wasDegraded`)은 요청 스코프 밖에서 항상 false 라 여기서는 그 함수만 세운다.
// 문구는 실제 `messages/ko.json` 에서 뽑는다(project-dashboard.render.test.tsx 와 같은 규율).
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
const degraded = vi.hoisted(() => ({ labels: new Set<string>() }));
vi.mock("@/lib/scope/server", () => ({
  wasDegraded: (label: string) => degraded.labels.has(label),
  fetchProjectStandardAggregates: vi.fn(),
  fetchProjectSelectableAnchorDates: vi.fn(),
}));
vi.mock("../_data/live", () => ({ getProjectDashboard: vi.fn() }));
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
import { PROJECT_COMPOSITION_LABEL, PROJECT_CONVERSION_LABEL } from "@/lib/hgh/adapters/dashboard";
import { ProjectMeasurementSections } from "./project-dashboard";

const DEGRADED = ko.answerAnalysis.mentions.kpi.degraded;
const COMPOSITION = ko.dashboard.composition.title;
const CONVERSION = ko.dashboard.kpi.category.conversion;

function model(overrides: Partial<ProjectDashboardData> = {}): ProjectDashboardData {
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
    await ProjectMeasurementSections({ projectId: "p1", filters: {}, hasMeasuredPrompts: true }),
  );
}

beforeEach(() => degraded.labels.clear());

describe("프로젝트 홈 — 섹션째 사라지던 일시 실패의 고지 (B027)", () => {
  it("라벨이 없으면 종전 마크업 그대로다(구성 없음 = 섹션 생략, ⑦ 없음 = 고지 없음)", async () => {
    const html = await render(model());
    expect(html).not.toContain(DEGRADED);
    expect(html).not.toContain(COMPOSITION);
    expect(html).not.toContain(CONVERSION);
  });

  it("구성 패널: 일시 실패 라벨이면 그 자리에 구성 분석 제목 + 지연 문구", async () => {
    degraded.labels.add(PROJECT_COMPOSITION_LABEL);
    const html = await render(model());
    expect(html).toContain(COMPOSITION);
    expect(html).toContain(DEGRADED);
    expect(html).not.toContain(CONVERSION);
  });

  it("구성 패널이 그려지면(값이 있으면) 고지는 나오지 않는다", async () => {
    degraded.labels.add(PROJECT_COMPOSITION_LABEL);
    const html = await render(model({ composition: { topics: [], sources: [{ domain: "a.com", citations: 1, share: 100, isOurs: false }] } }));
    expect(html).toContain('data-testid="composition-panel"');
    expect(html).not.toContain(DEGRADED);
  });

  it("⑦: 일시 실패 라벨이면 '답변의 전환' 제목 + 지연 문구(카드 섹션 바로 아래)", async () => {
    degraded.labels.add(PROJECT_CONVERSION_LABEL);
    const html = await render(model());
    expect(html).toContain(CONVERSION);
    expect(html).toContain(DEGRADED);
    expect(html.indexOf(CONVERSION)).toBeGreaterThan(html.indexOf('data-testid="summary-tiles"'));
    expect(html.indexOf(CONVERSION)).toBeLessThan(html.indexOf(ko.dashboard.trend.title));
  });
});
