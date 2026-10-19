import { describe, expect, it } from "vitest";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import { ownCompareRow } from "./mentions-view";

// 헤드투헤드 '당사' 행. 현대 2.0(언급 500, 순위 답변 100) + 기아 4.0(언급 100, 순위 답변 100):
// 브랜드 행을 언급 수로 가중하면 (2·500 + 4·100) / 600 = 2.3 이고, 점유율은 반올림된 20.0 + 20.1 이다.
const row = (brand: string, mentions: number, share: number, avgPosition: number | null): MentionsBrandLive => ({
  brand,
  mentions,
  prompts: 3,
  share,
  mentionRate: 25,
  avgPosition,
  isTracked: true,
});
const own = [row("Hyundai", 500, 20.0, 2.0), row("Kia", 100, 20.1, 4.0)];

describe("ownCompareRow", () => {
  it("uses the server own values (M02 share, answer-level M04 position) when the API source sends them", () => {
    const r = ownCompareRow(own, { share: 40.2, avgPosition: 3.1 }, 31.5, "당사");
    expect(r).toEqual({ brand: "당사", mentions: 600, prompts: 6, share: 40.2, mentionRate: 31.5, avgPosition: 3.1, isTracked: true });
  });

  it("keeps the brand-row merge for the legacy source (no server own values)", () => {
    const r = ownCompareRow(own, null, null, "당사");
    expect(r.avgPosition).toBe(2.3);
    expect(r.share).toBeCloseTo(40.1, 10);
    expect(r.mentionRate).toBe(25);
  });

  it("shows no position when the server reports none", () => {
    expect(ownCompareRow(own, { share: 40.2, avgPosition: null }, null, "당사").avgPosition).toBeNull();
  });
});
