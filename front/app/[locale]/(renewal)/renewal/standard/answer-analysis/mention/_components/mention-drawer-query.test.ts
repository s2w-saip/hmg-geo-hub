import { describe, expect, it } from "vitest";
import { drilldownParams } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/mentions-drilldown";
import { isWebsitePath, signalPromptsQuery } from "./mention-brands";

// The drawers' route queries (2026-10-30): on the renewal Website Mention (renewal/website/…) the brand and signal
// drawers read the website surface, as the original website page's drilldown and answer view do; the Global page
// (renewal/standard/…) sends no surface, a project page its id.

const SITE = "/ko/renewal/website/answer-analysis/mention";
const GLOBAL = "/ko/renewal/standard/answer-analysis/mention";

describe("mention drawer queries", () => {
  it("knows a Website page by its path", () => {
    expect([isWebsitePath(SITE), isWebsitePath(GLOBAL), isWebsitePath(null)]).toEqual([true, false, false]);
  });

  it("signal drawer: the website surface on a Website page, nothing on the Global page, the project id on a project page", () => {
    expect(signalPromptsQuery("geography=US&time=2026-10-03..2026-10-09", "positive", SITE)).toBe(
      "geography=US&time=2026-10-03..2026-10-09&signal=positive&surface=website",
    );
    expect(signalPromptsQuery("geography=US", "negative", GLOBAL)).toBe("geography=US&signal=negative");
    expect(signalPromptsQuery("", "mixed", "/ko/projects/p1/analysis/mention")).toBe("signal=mixed&projectId=p1");
  });

  it("brand drawer: the website flag adds the website surface to both lists", () => {
    const opts = { brand: "Toyota", isWebsite: isWebsitePath(SITE), projectId: null };
    expect(drilldownParams("geography=US", opts).toString()).toBe("geography=US&mentionBrand=Toyota&surface=website");
    expect(drilldownParams("geography=US", { ...opts, isWebsite: isWebsitePath(GLOBAL) }).toString()).toBe("geography=US&mentionBrand=Toyota");
  });
});
