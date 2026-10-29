import { describe, expect, it } from "vitest";
import {
  ALL_GROUPS,
  DIMENSIONS,
  STAGE_PRIMARY,
  type DimensionGroup,
} from "./dimension-filter-panel";

// 7-Dimension catalog + Stage matrix invariants. These guarantee that
// every consumer (Overview / Funnel 3 stages / 답변분석 2 sub-tabs) sees
// a well-formed catalog without runtime surprises.

describe("DIMENSIONS catalog", () => {
  it("DIMENSIONS keys match ALL_GROUPS", () => {
    expect(Object.keys(DIMENSIONS).sort()).toEqual(
      [...ALL_GROUPS].sort() satisfies DimensionGroup[],
    );
  });

  it("each group has at least one option (except cascade-only placeholders)", () => {
    // 2026-06-11: depth4 is a placeholder until editorial finalizes the 4-th
    // axis. Its options are filled in dynamically from catalogRows (cascading
    // filter). Allow it to start empty here — the test asserts the contract.
    // geography(2026-07): 옵션은 항상 geographyOptions(listMeasuredRegions,
    // scope-narrowed)로 동적 주입 → 정적 하드코딩 제거로 빈 배열 허용.
    // time(2026-07-02): 옵션 리스트가 아닌 날짜 범위 축 (TimeRangeFilter 특수
    // 렌더링 — 프리셋 + from/to) → 정적 옵션 없음.
    const ALLOW_EMPTY = new Set<DimensionGroup>(["depth4", "geography", "time"]);
    for (const g of ALL_GROUPS) {
      if (ALLOW_EMPTY.has(g)) continue;
      expect(DIMENSIONS[g].length).toBeGreaterThan(0);
    }
  });

  it("no group has duplicate options", () => {
    for (const g of ALL_GROUPS) {
      const opts = DIMENSIONS[g];
      expect(new Set(opts).size).toBe(opts.length);
    }
  });

  it("no option is empty string or 'all' (reserved sentinel)", () => {
    for (const g of ALL_GROUPS) {
      for (const opt of DIMENSIONS[g]) {
        expect(opt.trim()).not.toBe("");
        expect(opt).not.toBe("all");
      }
    }
  });
});

describe("STAGE_PRIMARY matrix", () => {
  it("has entries for all 6 stages", () => {
    expect(Object.keys(STAGE_PRIMARY).sort()).toEqual([
      "acr",
      "citations",
      "conversion",
      "mentions",
      "overview",
      "visibility",
    ]);
  });

  it("overview exposes the 4 highest-use groups first", () => {
    // 2026-06-04: vehicle dropped — replaced by promptContext in overview.
    expect(STAGE_PRIMARY.overview).toEqual([
      "time",
      "geography",
      "engine",
      "promptContext",
    ]);
  });

  it("non-overview stages expose exactly 4 primary groups (F2 decision)", () => {
    const nonOverview: (keyof typeof STAGE_PRIMARY)[] = [
      "visibility",
      "acr",
      "conversion",
      "mentions",
      "citations",
    ];
    for (const stage of nonOverview) {
      expect(STAGE_PRIMARY[stage].length).toBe(4);
    }
  });

  it("every primary group is a valid DimensionGroup", () => {
    const validGroups = new Set<DimensionGroup>(ALL_GROUPS);
    for (const stage of Object.keys(STAGE_PRIMARY) as (keyof typeof STAGE_PRIMARY)[]) {
      for (const g of STAGE_PRIMARY[stage]) {
        expect(validGroups.has(g)).toBe(true);
      }
    }
  });

  it("each stage's primary list has no duplicates", () => {
    for (const stage of Object.keys(STAGE_PRIMARY) as (keyof typeof STAGE_PRIMARY)[]) {
      const list = STAGE_PRIMARY[stage];
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("'time' is in every scope-backed stage's primary list (cross-stage common filter)", () => {
    // conversion is GA4-backed (2026-06-23): its axes map to real GA4 Data API
    // dimensions, and the 'time' axis (scope measured_at date range) is not a
    // GA4 range selector, so conversion intentionally omits it.
    for (const stage of Object.keys(STAGE_PRIMARY) as (keyof typeof STAGE_PRIMARY)[]) {
      if (stage === "conversion") continue;
      expect(STAGE_PRIMARY[stage]).toContain("time");
    }
  });

  it("conversion primary list is GA4-backed axes only (no scope/time axes)", () => {
    expect(STAGE_PRIMARY.conversion).toEqual([
      "geography",
      "engine",
      "device",
      "visitorType",
    ]);
  });

  it("ACR includes engine + competitor (KPI ShortList 4-3 'High' picks; vehicle dropped 2026-06-04)", () => {
    expect(STAGE_PRIMARY.acr).toContain("engine");
    expect(STAGE_PRIMARY.acr).toContain("competitor");
  });

  it("Citation Sources primary list focuses on source dimension (per scope doc)", () => {
    expect(STAGE_PRIMARY.citations).toContain("source");
  });
});
