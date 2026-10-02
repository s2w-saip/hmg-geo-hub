import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CompetitorBrandValue } from "./result-adapter";
import { competitorCandidates, competitorDeltaBrands, competitorMiniPicks } from "./competitor-row";
import { RANK_TABLE_TOP_BRANDS } from "@/lib/kpi/first-position-rank";

// 우선 노출도 경쟁사 미니값 4개 = **순위 기준**(제품 책임자 2026-09-29).
// 모집단 = 순위표와 같은 언급 수 상위 N(자사 포함) → 그 안의 경쟁사 중 평균 순위 상위 4.
// 다른 지표(노출률·점유율·우호도)는 종전대로 언급 수 상위 4 → 값 순.

const v = (brand: string, avgPosition: number | null, mentions: number, isTracked = false): CompetitorBrandValue => ({
  brand,
  mentions,
  share: mentions / 10_000,
  mentionRate: mentions / 5_000,
  avgPosition,
  isTracked,
});

// 09-28 회차 프리뷰 실측(언급 수 = 브랜드 표, 값 = Overview 리더).
const brands = [
  v("Hyundai", 2.5, 134_919, true),
  v("Kia", 3.6, 134_735, true),
  v("Toyota", 3.9, 56_010),
  v("Genesis", 3.3, 52_267, true),
  v("Tesla", 3.7, 48_978),
  v("BMW", 4.8, 47_521),
  v("Mercedes-Benz", 4.9, 34_368),
  v("Honda", 4.1, 26_613),
  v("Porsche", 4.7, 24_995),
  v("Lexus", 3.7, 23_979),
  v("Volkswagen", 5.2, 21_025),
  v("Rolls-Royce", 1.8, 4_588),
  v("Tiny", 1.0, 1),
];

describe("competitorCandidates position: 순위 기준", () => {
  it("언급 수 상위 10 안의 경쟁사 중 평균 순위 상위 4 (동률은 이름 순)", () => {
    expect(competitorMiniPicks(brands, "position").map((p) => [p.brand, p.value])).toEqual([
      ["Lexus", 3.7],
      ["Tesla", 3.7],
      ["Toyota", 3.9],
      ["Honda", 4.1],
    ]);
  });

  it("모집단 밖(언급 수 11위 이하)은 순위가 좋아도 후보가 아니다: 소수 브랜드 가드", () => {
    const names = competitorCandidates(brands, "position").map((c) => c.brand);
    expect(names).not.toContain("Rolls-Royce");
    expect(names).not.toContain("Tiny");
  });

  it("모집단은 자사 포함 상위 10: 자사 3개가 자리를 차지해 경쟁사는 7개만 후보", () => {
    const pool = competitorCandidates(brands, "position", 99).map((c) => c.brand);
    expect(pool).toHaveLength(RANK_TABLE_TOP_BRANDS - 3);
    expect(pool).not.toContain("Volkswagen");
  });

  it("값이 없는 브랜드는 모집단 자리는 차지하되 후보가 아니다", () => {
    const withNull = brands.map((b) => (b.brand === "Lexus" ? { ...b, avgPosition: null } : b));
    expect(competitorMiniPicks(withNull, "position").map((p) => p.brand)).toEqual(["Tesla", "Toyota", "Honda", "Porsche"]);
  });

  it("다른 지표는 종전대로 언급 수 상위 4", () => {
    expect(competitorCandidates(brands, "visibility").map((c) => c.brand)).toEqual(["Toyota", "Tesla", "BMW", "Mercedes-Benz"]);
  });

  it("Δ 읽기 이름(competitorDeltaBrands)에 순위 기준 후보가 들어간다: 새 타일의 Δ 가 비지 않는다", () => {
    const names = competitorDeltaBrands(brands);
    for (const b of ["Lexus", "Tesla", "Toyota", "Honda"]) expect(names).toContain(b);
  });
});

describe("모집단 상수 = 순위표 상한 (수치 한 곳)", () => {
  it("server.ts 의 우선 노출도 cap 과 미러 집계 기본 상한이 같은 값이다", () => {
    const server = readFileSync("lib/scope/server.ts", "utf8");
    const i = server.indexOf("export async function fetchStandardKpiFirstPosition");
    const body = server.slice(i, server.indexOf("\n}\n", i));
    expect(body).toContain("cap: RANK_TABLE_TOP_BRANDS");
    expect(body).not.toMatch(/cap: \d/);
    const agg = readFileSync("lib/db/repositories/scope-aggregates.ts", "utf8");
    expect(agg).toMatch(/const KPI_TAB_DEFAULT_TOP_BRANDS = RANK_TABLE_TOP_BRANDS;/);
  });
});
