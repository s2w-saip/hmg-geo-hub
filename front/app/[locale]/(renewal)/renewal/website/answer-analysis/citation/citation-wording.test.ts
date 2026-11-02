import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// Last review (2026-11-02): the website 공식(당사) tile said its gap to 공식(HMG) came from "3사 전체" (61.7 % vs 24.9 % with no
// filter, the same three brands), and the prompts sub page spoke of "공식 도메인" while Gold's website 자사 is the site's
// registered URLs and the pages under them or a target URL (loc_owned ∨ tgt_hit): 968 of its 1,131 '미인용' prompts cite an
// Official (HMG) source.

describe("website citation wording follows Gold's website 자사", () => {
  const own = ko.renewal.website.citation.lens.own;

  it("the 공식(당사) tile names the site's own URLs, not group official sites", () => {
    expect(own.def).toContain("자사 URL");
    expect(own.def).not.toContain("3사 전체");
    expect(own.formula).toContain("자사 URL");
  });

  it("the prompts sub page has its own website title and description", () => {
    const page = ko.renewal.website.citation.promptsPage;
    expect(page.title).toContain("자사 URL");
    expect(page.description).not.toContain("공식 도메인");
    expect(Object.keys(en.renewal.website.citation.promptsPage).sort()).toEqual(Object.keys(page).sort());
  });
});
