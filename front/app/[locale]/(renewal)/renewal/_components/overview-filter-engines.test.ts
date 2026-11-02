import { describe, expect, it } from "vitest";
import { DIMENSIONS } from "@/components/dash/dimension-filter-panel";
import { axisOptions, overviewPanelModel, type OverviewPanelInput } from "./overview-filter-model";

// Last review (2026-11-02): the website panel offered the static ChatGPT · Gemini while Gold measures DeepSeek on the CN
// site too (284 answers on 10-09), so no pick could narrow to it and its engine-table row could not be picked.

describe("renewal filter panel: AI 엔진 options", () => {
  const base: OverviewPanelInput = { stage: "overview", surface: "website", geographyOptions: ["CN", "US"], languageOptions: ["en", "zh"] };

  it("offers Gold's engines when the page passes them", () => {
    const input = { ...base, engineOptions: ["chatgpt", "deepseek", "gemini"] };
    expect(axisOptions(overviewPanelModel(input, {}), input, {}, "engine", [])).toEqual(["chatgpt", "deepseek", "gemini"]);
  });

  it("keeps the static list without them", () => {
    expect(axisOptions(overviewPanelModel(base, {}), base, {}, "engine", [])).toEqual(DIMENSIONS.engine);
  });
});
