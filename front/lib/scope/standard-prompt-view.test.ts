import { describe, it, expect } from "vitest";
import { standardPromptInScope } from "@/lib/auth/scope-policy";
import { isExcludedStandardPrompt } from "@/lib/scope/standard-prompt-exclusions";
import type { AllowedScope } from "@/lib/auth/types";

// Read-only 표준 프롬프트 viewer visibility rule. Unlike the scoped domain
// tables, the root catalog tags brand-agnostic prompts with the umbrella brand
// 'HMG' (not null) — so both null and 'HMG' must stay common. This pure rule is
// mirrored in SQL by listStandardCatalogScoped.
describe("standardPromptInScope — read-only catalog brand scoping", () => {
  const admin: AllowedScope = { all: true };
  const kia: AllowedScope = { all: false, brands: ["Kia"] };
  const noBrand: AllowedScope = { all: false, regions: ["EU"] };

  it("admin (scope.all) sees every brand", () => {
    expect(standardPromptInScope(admin, "Hyundai")).toBe(true);
    expect(standardPromptInScope(admin, "Genesis")).toBe(true);
    expect(standardPromptInScope(admin, null)).toBe(true);
  });

  it("brand-scoped user sees own marque + common (null and umbrella HMG)", () => {
    expect(standardPromptInScope(kia, "Kia")).toBe(true);
    expect(standardPromptInScope(kia, "HMG")).toBe(true); // umbrella = 공통
    expect(standardPromptInScope(kia, null)).toBe(true); // null = 공통
  });

  it("brand-scoped user does NOT see other marques", () => {
    expect(standardPromptInScope(kia, "Hyundai")).toBe(false);
    expect(standardPromptInScope(kia, "Genesis")).toBe(false);
  });

  it("user without brand scope is unrestricted on brand", () => {
    expect(standardPromptInScope(noBrand, "Hyundai")).toBe(true);
    expect(standardPromptInScope(noBrand, "Kia")).toBe(true);
  });
});

describe("isExcludedStandardPrompt — multi-brand 잘못 exclusion", () => {
  it("does not exclude normal rows (empty curated list by default)", () => {
    expect(
      isExcludedStandardPrompt({ id: "abc", text: "가족용 SUV 추천해줘" }),
    ).toBe(false);
  });
});
