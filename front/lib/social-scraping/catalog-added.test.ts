import { describe, expect, it } from "vitest";
import type { GeneratedPrompt } from "@/components/social-scraping/types";
import { isAlreadyAdded } from "./catalog-added";

const row = (question: string, over: Partial<GeneratedPrompt> = {}): GeneratedPrompt => ({
  id: question,
  question,
  layer: "L1-context",
  funnelStage: "consideration",
  sourceLabel: "",
  priority: 0,
  ...over,
});

describe("isAlreadyAdded", () => {
  it("legacy: exact question in the page's candidate texts (or sent this session)", () => {
    const added = new Set(["가족용 SUV 추천해줘"]);
    expect(isAlreadyAdded(added, row("가족용 SUV 추천해줘"))).toBe(true);
    // Exact text only: a near-duplicate is the similarity hint, not "이미 추가됨".
    expect(isAlreadyAdded(added, row("가족용 SUV 추천해 줘"))).toBe(false);
  });

  it("api: the backend's in-candidate-pool mark, without the pool on the page", () => {
    expect(isAlreadyAdded(new Set(), row("q", { inCandidatePool: true }))).toBe(true);
    expect(isAlreadyAdded(new Set(), row("q", { inCandidatePool: false }))).toBe(false);
    expect(isAlreadyAdded(new Set(), row("q"))).toBe(false);
  });
});
