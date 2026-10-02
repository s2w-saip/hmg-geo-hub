import { describe, expect, it } from "vitest";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import { brandRowValues, isTopRank, promptBestRank } from "./prompt-rank";

const ans = (position: number | null) => ({
  jobId: "j", provider: "ChatGPT", region: null, mentionCount: 1, position,
}) as MentionsBrandLive extends never ? never : { jobId: string; provider: string; region: null; mentionCount: number; position: number | null };

describe("promptBestRank / isTopRank", () => {
  it("takes the lowest positive position across answers", () => {
    expect(promptBestRank({ answers: [ans(5), ans(2), ans(null), ans(7)] as never })).toBe(2);
  });
  it("returns null (not 0) when no answer carries a position", () => {
    expect(promptBestRank({ answers: [ans(null), ans(0)] as never })).toBeNull();
    expect(promptBestRank({ answers: [] })).toBeNull();
  });
  it("flags TOP 3 only for ranks 1..3", () => {
    expect(isTopRank(1)).toBe(true);
    expect(isTopRank(3)).toBe(true);
    expect(isTopRank(4)).toBe(false);
    expect(isTopRank(null)).toBe(false);
  });
});

describe("brandRowValues — 복수 언급 토글", () => {
  const row: MentionsBrandLive = {
    brand: "Kia", mentions: 100, prompts: 40, share: 25, mentionRate: 50, avgPosition: 3, isTracked: true,
    multi: { mentions: 30, answers: 12, prompts: 9 },
  };
  it("passes the snapshot values through when the toggle is off", () => {
    expect(brandRowValues(row, { multi: false, multiTotalMentions: 60, totalAnswers: 200 })).toEqual({
      mentions: 100, prompts: 40, share: 25, mentionRate: 50,
    });
  });
  it("switches to multi-mention counts, share over the multi total, rate over all answers", () => {
    expect(brandRowValues(row, { multi: true, multiTotalMentions: 60, totalAnswers: 200 })).toEqual({
      mentions: 30, prompts: 9, share: 50, mentionRate: 6,
    });
  });
  it("yields nulls when the row has no multi data (legacy cache) instead of zeros", () => {
    const legacy = { ...row, multi: undefined };
    expect(brandRowValues(legacy, { multi: true, multiTotalMentions: 60, totalAnswers: 200 })).toEqual({
      mentions: null, prompts: null, share: null, mentionRate: null,
    });
  });
});
