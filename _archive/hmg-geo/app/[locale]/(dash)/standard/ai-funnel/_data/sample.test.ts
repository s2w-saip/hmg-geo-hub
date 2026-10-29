import { describe, expect, it } from "vitest";
import {
  SAMPLE_VISIBILITY_PAGES,
  SAMPLE_VISIBILITY_QUADRANT_COUNTS,
  SAMPLE_ACR_BRANDS,
  SAMPLE_ACR_TREND,
  SAMPLE_ACR_BATTLE,
  SAMPLE_CONVERSION_PAGES,
  SAMPLE_CONVERSION_SUMMARY,
  SAMPLE_CONVERSION_TREND,
} from "./sample";

// AI Funnel sample data integrity. These tests guard against regressions
// in the placeholder dataset that powers Visibility / ACR / Conversion views
// until the real pipeline (Phase 5) lands.

describe("Visibility sample", () => {
  it("quadrant counts sum to total page count", () => {
    const { star, seoGap, aiGap, deadZone } = SAMPLE_VISIBILITY_QUADRANT_COUNTS;
    expect(star + seoGap + aiGap + deadZone).toBe(SAMPLE_VISIBILITY_PAGES.length);
  });

  it("every page has a valid quadrant", () => {
    for (const p of SAMPLE_VISIBILITY_PAGES) {
      expect(["star", "seoGap", "aiGap", "deadZone"]).toContain(p.quadrant);
    }
  });

  it("priority is 1, 2, or 3", () => {
    for (const p of SAMPLE_VISIBILITY_PAGES) {
      expect([1, 2, 3]).toContain(p.priority);
    }
  });

  it("declared quadrant counts match actual distribution", () => {
    const counts = { star: 0, seoGap: 0, aiGap: 0, deadZone: 0 };
    for (const p of SAMPLE_VISIBILITY_PAGES) {
      counts[p.quadrant] += 1;
    }
    expect(counts).toEqual(SAMPLE_VISIBILITY_QUADRANT_COUNTS);
  });
});

describe("ACR sample", () => {
  it("Top1 ACR is in [0, 100]", () => {
    for (const b of SAMPLE_ACR_BRANDS) {
      expect(b.top1Acr).toBeGreaterThanOrEqual(0);
      expect(b.top1Acr).toBeLessThanOrEqual(100);
    }
  });

  it("Top5 ACR is always >= Top1 ACR (Top5 is superset)", () => {
    for (const b of SAMPLE_ACR_BRANDS) {
      expect(b.top5Acr).toBeGreaterThanOrEqual(b.top1Acr);
    }
  });

  it("rank1Count <= answerCount per brand", () => {
    for (const b of SAMPLE_ACR_BRANDS) {
      expect(b.rank1Count).toBeLessThanOrEqual(b.answerCount);
    }
  });

  it("rank1Count / answerCount * 100 ~ top1Acr (sanity within 0.5pp)", () => {
    for (const b of SAMPLE_ACR_BRANDS) {
      const computed = (b.rank1Count / b.answerCount) * 100;
      expect(Math.abs(computed - b.top1Acr)).toBeLessThan(0.5);
    }
  });

  it("at least one brand is marked isOurs=true (HMG family)", () => {
    expect(SAMPLE_ACR_BRANDS.some((b) => b.isOurs)).toBe(true);
  });

  it("ACR trend has consistent series shape (Hyundai/Toyota/Tesla every row)", () => {
    for (const point of SAMPLE_ACR_TREND) {
      expect(typeof point.Hyundai).toBe("number");
      expect(typeof point.Toyota).toBe("number");
      expect(typeof point.Tesla).toBe("number");
    }
  });

  it("Battle grid is fully populated (every prompt × model has a winner)", () => {
    const prompts = new Set(SAMPLE_ACR_BATTLE.map((b) => b.prompt));
    const models = new Set(SAMPLE_ACR_BATTLE.map((b) => b.model));
    expect(SAMPLE_ACR_BATTLE.length).toBe(prompts.size * models.size);
  });
});

describe("Conversion sample", () => {
  it("Lift equals aiConvRate − humanConvRate (within rounding)", () => {
    for (const p of SAMPLE_CONVERSION_PAGES) {
      const computed = p.aiConvRate - p.humanConvRate;
      expect(Math.abs(computed - p.lift)).toBeLessThan(0.05);
    }
  });

  it("summary lift sign matches aggregate direction", () => {
    const { aiConvRate, humanConvRate, lift } = SAMPLE_CONVERSION_SUMMARY;
    const computed = aiConvRate - humanConvRate;
    expect(Math.abs(computed - lift) < 0.05).toBe(true);
  });

  it("active-user sums stay within the summary's all-pages totals", () => {
    const aiTotal = SAMPLE_CONVERSION_PAGES.reduce(
      (s, p) => s + p.aiUsers,
      0,
    );
    const humanTotal = SAMPLE_CONVERSION_PAGES.reduce(
      (s, p) => s + p.humanUsers,
      0,
    );
    // Summary is an "all pages" view; per-page rows are top-5. So per-page
    // sum should be <= summary, not equal.
    expect(aiTotal).toBeLessThanOrEqual(
      SAMPLE_CONVERSION_SUMMARY.aiUsersTotal,
    );
    expect(humanTotal).toBeLessThanOrEqual(
      SAMPLE_CONVERSION_SUMMARY.humanUsersTotal,
    );
  });

  it("trend points have both ai and human series", () => {
    for (const point of SAMPLE_CONVERSION_TREND) {
      expect(typeof point.ai).toBe("number");
      expect(typeof point.human).toBe("number");
    }
  });

  it("conversion rates are in [0, 100]", () => {
    for (const p of SAMPLE_CONVERSION_PAGES) {
      expect(p.aiConvRate).toBeGreaterThanOrEqual(0);
      expect(p.aiConvRate).toBeLessThanOrEqual(100);
      expect(p.humanConvRate).toBeGreaterThanOrEqual(0);
      expect(p.humanConvRate).toBeLessThanOrEqual(100);
    }
  });
});
