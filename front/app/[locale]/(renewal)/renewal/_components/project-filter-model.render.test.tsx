import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { axisOptions, customAxisKey, overviewPanelModel, type OverviewPanelInput } from "./overview-filter-model";

// The renewal Project tab's filter panel (2026-11-03): the original project panels' axes — 기간 · 측정 국가 · AI 엔진 —
// and the project's custom tags (Gold dim_custom_field · prompt_custom_value) as cf_<fieldId>; no brand or language
// axis (a project has none); 국가 locked when the project was measured in one country.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/projects/35ae7ec0-a80a-4c88-a431-9698470aa94b",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewApplied, RnOverviewFilters, RnOverviewFilterPanel } = await import("./overview-filters");

const TOPIC = { id: "784c45ea-8b19-48f5-9d56-32555ef20f25", label: "Topic_Depth1", options: ["AI", "Design", "Hybrid"] };
const LANG = { id: "2caa2e45-832c-48b3-a3c4-f92639ef074d", label: "언어", options: ["EN", "FR"] };
const EMPTY = { id: "11111111-2222-4333-8444-555555555555", label: "빈 태그", options: [] };
const base: OverviewPanelInput = {
  stage: "overview",
  surface: "project",
  scope: { all: true },
  geographyOptions: ["CA", "US"],
  engineOptions: ["chatgpt", "gemini"],
  dynamicAxes: [TOPIC, LANG, EMPTY],
};
const G = ko.dashboard.filters.group;

describe("renewal filter model: project", () => {
  it("has the project axes and one axis per custom tag with values, under 태그", () => {
    const m = overviewPanelModel(base, {});
    expect(m.visibleGroups).toEqual(["geography", "engine", "time", customAxisKey(TOPIC.id), customAxisKey(LANG.id)]);
    expect(m.sections).toEqual([
      { id: "dimension", axes: ["geography", "engine", "time"] },
      { id: "tag", axes: [`cf_${TOPIC.id}`, `cf_${LANG.id}`] },
    ]);
  });

  it("locks 국가 when the project was measured in one country", () => {
    expect(overviewPanelModel({ ...base, geographyOptions: ["CA"] }, {}).visibleGroups).not.toContain("geography");
  });

  it("offers a tag's own values and Gold's engines", () => {
    const m = overviewPanelModel(base, {});
    expect(axisOptions(m, base, {}, customAxisKey(TOPIC.id), [])).toEqual(["AI", "Design", "Hybrid"]);
    expect(axisOptions(m, base, {}, "engine", [])).toEqual(["chatgpt", "gemini"]);
  });
});

function render(url: string) {
  SEARCH = url;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={base} savedFilters={{ page: "project-dashboard", userId: "test", initial: [] }}>
          <RnOverviewApplied />
          <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

describe("renewal filter panel: project", () => {
  const html = render(`cf_${TOPIC.id}=AI~Hybrid&engine=gemini&brand=Kia`);

  it("names each tag axis by its label and lists its values", () => {
    expect(html).toContain(`>${ko.dashboard.filters.section.tag}<`);
    expect(html).toContain(`>${TOPIC.label}<`);
    expect(html).toContain(`>${LANG.label}<`);
    expect(html).not.toContain(`>${EMPTY.label}<`);
    expect(html).toContain(">Design<");
  });

  it("has no brand or language axis", () => {
    expect(html).not.toContain('data-fk="s:brand"');
    expect(html).not.toContain('data-fk="s:language"');
  });

  it("shows the picked tag values as an applied condition named by the tag", () => {
    expect(html).toMatch(new RegExp(`${TOPIC.label}.{0,200}AI, Hybrid`));
    expect(html).toMatch(new RegExp(`${G.engine}.{0,200}Gemini`));
  });
});
