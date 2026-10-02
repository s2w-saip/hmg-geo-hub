import { describe, expect, it } from "vitest";
import {
  AI_ENGINE_IDS,
  DEFAULT_AI_ENGINES,
  effectiveAiEngines,
  isAiEngineId,
  normalizeAiEngines,
  sameAiEngines,
} from "./engines";

describe("engines catalog", () => {
  it("normalizes to catalog order, dropping unknown + duplicates", () => {
    expect(normalizeAiEngines(["gemini", "chatgpt", "gemini", "perplexity", ""])).toEqual([
      "chatgpt",
      "gemini",
    ]);
    expect(normalizeAiEngines(null)).toEqual([]);
    expect(normalizeAiEngines(["deepseek"])).toEqual(["deepseek"]);
  });

  it("treats NULL (legacy) as the scope default targets, [] as explicit none", () => {
    expect(effectiveAiEngines(null)).toEqual([...DEFAULT_AI_ENGINES]);
    expect(effectiveAiEngines(undefined)).toEqual(["chatgpt", "gemini"]);
    expect(effectiveAiEngines([])).toEqual([]);
    expect(effectiveAiEngines(["gemini"])).toEqual(["gemini"]);
  });

  it("compares selections order-insensitively", () => {
    expect(sameAiEngines(["gemini", "chatgpt"], ["chatgpt", "gemini"])).toBe(true);
    expect(sameAiEngines(["chatgpt"], ["chatgpt", "gemini"])).toBe(false);
    expect(sameAiEngines([], [])).toBe(true);
  });

  it("every catalog id is a valid scope schedule target token", () => {
    // scope lib/scheduling/schema.ts TargetCode enum — keep in sync by hand.
    const scopeTargets = new Set(["chatgpt", "gemini", "claude-sonnet", "claude-opus", "claude-web", "deepseek"]);
    for (const id of AI_ENGINE_IDS) expect(scopeTargets.has(id)).toBe(true);
    expect(isAiEngineId("perplexity")).toBe(false);
  });
});
