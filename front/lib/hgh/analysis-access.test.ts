import { describe, expect, it } from "vitest";
import * as F from "./analysis-access";

// The analysis source switch and the (dash) place gate the analysis BFF routes and actions apply.

describe("isAnalysisApi: HGH_SOURCE_<group> by sourceGroupFor(area, surface)", () => {
  it.each([
    ["dashboard", "global", "HGH_SOURCE_G1"],
    ["analysis", "global", "HGH_SOURCE_G2"],
    ["funnel", "global", "HGH_SOURCE_G4"],
    ["prompts", "global", "HGH_SOURCE_G5"],
    ["dashboard", "website", "HGH_SOURCE_G3"],
    ["analysis", "website", "HGH_SOURCE_G3"],
    ["analysis", "project", "HGH_SOURCE_G6"],
    ["dashboard", "project", "HGH_SOURCE_G6"],
  ] as const)("%s/%s -> %s", (area, surface, name) => {
    expect(F.isAnalysisApi(area, surface, {})).toBe(false); // default legacy
    expect(F.isAnalysisApi(area, surface, { [name]: "api" })).toBe(true);
    expect(F.isAnalysisApi(area, surface, { [name]: "legacy" })).toBe(false);
    // another group's flag does not switch this screen
    const other = name === "HGH_SOURCE_G1" ? "HGH_SOURCE_G2" : "HGH_SOURCE_G1";
    expect(F.isAnalysisApi(area, surface, { [other]: "api" })).toBe(false);
  });
});

describe("canReadAnalysis: the (dash) place gate for analysis BFF routes", () => {
  const u = (role: "hq" | "region" | "country" | "admin" | "vendor" | "website", menuGroups: ("standard" | "website" | "project" | "admin")[] | null = null) => ({ role, menuGroups });
  it("representative page per (surface, area)", () => {
    expect(F.analysisRoutePath("dashboard", "global")).toBe("/dashboard");
    expect(F.analysisRoutePath("analysis", "global")).toBe("/standard/answer-analysis");
    expect(F.analysisRoutePath("funnel", "global")).toBe("/standard/ai-funnel");
    expect(F.analysisRoutePath("prompts", "global")).toBe("/standard/prompts");
    expect(F.analysisRoutePath("analysis", "website")).toBe("/website/answer-analysis");
    expect(F.analysisRoutePath("funnel", "project")).toBe("/projects");
  });
  it.each([
    [u("vendor"), "dashboard", "global", false],
    [u("vendor"), "analysis", "project", true],
    [u("website"), "analysis", "global", false],
    [u("website"), "dashboard", "website", true],
    [u("website"), "analysis", "project", false],
    [u("hq", ["project"]), "dashboard", "website", false],
    [u("hq", ["project"]), "analysis", "project", true],
    [u("hq", ["website"]), "funnel", "global", false],
    [u("hq", []), "funnel", "global", true], // empty whitelist = role default
    [u("country"), "prompts", "website", true],
    [u("admin"), "prompts", "global", true],
  ] as const)("%o %s/%s -> %s", (user, area, surface, want) => {
    expect(F.canReadAnalysis(user, area, surface)).toBe(want);
  });
});
