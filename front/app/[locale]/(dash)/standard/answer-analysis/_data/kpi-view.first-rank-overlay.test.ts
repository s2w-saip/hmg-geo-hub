import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import type { CompetitorBrandValue } from "@/lib/scope/result-adapter";
import { competitorValueOf } from "@/lib/kpi/competitor-values";
import { rankFirstPositionRows } from "@/lib/kpi/first-position-rank";
import { competitorMinis } from "../../../dashboard/_components/overview-kpi-cards";
import {
  firstRankCompetitorCards,
  firstRankHero,
  overlayFirstPositionValues,
  rankLadder,
  rankTableRows,
} from "./kpi-view";

// 우선 노출도 탭의 값을 Overview 경쟁사 행 값으로 덮고 **그 값으로 다시 순위를 매긴다**
// (2026-09-28 제품 책임자 A안). 프리뷰에서 같은 탭 히어로(당사 2.5, Overview 원천) 옆 경쟁사 타일이
// 미러 서수(Tesla 21.3)를 그렸던 것을, 타일·표·래더가 Overview 와 같은 수를 보게 한다.

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

const row = (
  brand: string,
  avgPosition: number | null,
  opts: { tracked?: boolean; ranked?: number; mentions?: number } = {},
) => ({
  brand,
  isTracked: opts.tracked ?? false,
  avgPosition,
  rankedAnswers: opts.ranked ?? (avgPosition == null ? 0 : 10),
  mentions: opts.mentions ?? 100,
});

/** 미러 결과: 순위는 공용 규칙으로 매긴 상태(집계가 내는 모양 그대로). */
function mirror(): FirstPositionResult {
  return {
    unit: "week",
    brands: ["Hyundai", "Kia", "Tesla", "Toyota", "BMW", "Ford"],
    buckets: [
      {
        bucketStart: "2026-09-14",
        measuredDays: 1,
        firstAt: null,
        lastAt: null,
        brands: [
          { brand: "Hyundai", isTracked: true, avgPosition: 3.3, rankedAnswers: 10 },
          { brand: "Tesla", isTracked: false, avgPosition: 3.8, rankedAnswers: 10 },
        ],
      },
    ],
    latest: rankFirstPositionRows([
      row("Hyundai", 3.4, { tracked: true }),
      row("Kia", 3.8, { tracked: true }),
      row("Tesla", 3.9),
      row("Toyota", 4.1),
      row("BMW", 5.0),
      row("Ford", 6.0, { mentions: 5 }),
    ]),
  };
}

const value = (brand: string, avgPosition: number | null, isTracked = false): CompetitorBrandValue => ({
  brand,
  mentions: 50,
  share: 1,
  mentionRate: 1,
  avgPosition,
  isTracked,
});

describe("overlayFirstPositionValues: 값 덮어쓰기 + 재순위", () => {
  it("리더 값이 없으면(null·미전달) 미러 결과를 **그대로** 돌려준다(격자 off 무변경)", () => {
    const fp = mirror();
    expect(overlayFirstPositionValues(fp, null)).toBe(fp);
    expect(overlayFirstPositionValues(fp, undefined)).toBe(fp);
    expect(overlayFirstPositionValues(null, [value("Tesla", 1)])).toBeNull();
  });

  it("값을 리더 것으로 바꾸고, **덮은 값으로** 순위를 다시 매긴다(동률 공동·다음 건너뜀)", () => {
    const out = overlayFirstPositionValues(mirror(), [
      value("Hyundai", 3.7, true),
      value("Kia", 3.9, true),
      value("Tesla", 3.7),
      value("Toyota", 3.9),
      value("BMW", 4.8),
      value("Ford", 5.0),
    ])!;
    expect(out.latest.map((r) => [r.brand, r.avgPosition, r.rank])).toEqual([
      ["Hyundai", 3.7, 1],
      ["Tesla", 3.7, 1],
      ["Kia", 3.9, 3],
      ["Toyota", 3.9, 3],
      ["BMW", 4.8, 5],
      ["Ford", 5.0, 6],
    ]);
  });

  it("값은 Overview 경쟁사 행과 **같은 함수**(competitorValueOf position)에서 나온다", () => {
    const vals = [value("Hyundai", 3.7, true), value("Kia", 4.0, true), value("Tesla", 3.7)];
    const out = overlayFirstPositionValues(mirror(), vals)!;
    for (const v of vals) {
      expect(out.latest.find((r) => r.brand === v.brand)!.avgPosition).toBe(
        competitorValueOf(v, "position"),
      );
    }
  });

  it("리더에 없는 브랜드는 null(측정 없음)로 표 끝에 간다: 미러 값으로 메우지 않는다", () => {
    const out = overlayFirstPositionValues(mirror(), [
      value("Hyundai", 3.7, true),
      value("Kia", 4.2, true),
      value("Tesla", 3.9),
    ])!;
    const toyota = out.latest.find((r) => r.brand === "Toyota")!;
    expect(toyota.avgPosition).toBeNull();
    expect(toyota.rank).toBeNull();
    expect(toyota.rankedAnswers).toBe(0);
    // 순위 없는 행은 언급 수 내림차순으로 끝에 붙는다(Ford 5 < 나머지 100).
    expect(out.latest.slice(-3).map((r) => r.brand)).toEqual(["BMW", "Toyota", "Ford"]);
    expect(out.latest.slice(0, 3).map((r) => [r.brand, r.rank])).toEqual([
      ["Hyundai", 1],
      ["Tesla", 2],
      ["Kia", 3],
    ]);
  });

  it("브랜드 키는 대소문자·앞뒤 공백을 접는다(competitorKpiRows 와 같은 매칭)", () => {
    const out = overlayFirstPositionValues(mirror(), [
      value(" HYUNDAI ", 2.0, true),
      value("kia", 2.5, true),
      value("TESLA", 1.5),
    ])!;
    expect(out.latest[0]!.brand).toBe("Tesla");
    expect(out.latest[0]!.avgPosition).toBe(1.5);
  });

  it("당사 행 하나라도 리더에서 못 찾으면 **통째로 포기**하고 미러 값을 쓴다(경고 1줄)", () => {
    const fp = mirror();
    const out = overlayFirstPositionValues(fp, [value("Hyundai", 1.0, true), value("Tesla", 1.0)]);
    expect(out).toBe(fp);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![1])).toContain("Kia");
  });

  it("한 건도 못 맞추면 포기한다", () => {
    const fp = mirror();
    expect(overlayFirstPositionValues(fp, [value("Nissan", 1.0)])).toBe(fp);
  });

  it("추이 버킷(스파크·WoW·차트)은 건드리지 않는다: 미러 회차 그대로", () => {
    const fp = mirror();
    const out = overlayFirstPositionValues(fp, [
      value("Hyundai", 3.7, true),
      value("Kia", 3.9, true),
      value("Tesla", 3.7),
    ])!;
    expect(out.buckets).toBe(fp.buckets);
    expect(out.brands).toBe(fp.brands);
  });

  it("타일·순위 표·래더·히어로 최고 순위가 **같은 행**(덮은 값)에서 나온다", () => {
    const out = overlayFirstPositionValues(mirror(), [
      value("Hyundai", 3.7, true),
      value("Kia", 4.4, true),
      value("Tesla", 3.9),
      value("Toyota", 3.6),
      value("BMW", 4.8),
      value("Ford", 5.0),
    ])!;
    const rows = rankTableRows(out, { sparkCycles: 4 });
    expect(rows.map((r) => [r.brand, r.avgPosition, r.rank])).toEqual([
      ["Toyota", 3.6, 1],
      ["Hyundai", 3.7, 2],
      ["Tesla", 3.9, 3],
      ["Kia", 4.4, 4],
      ["BMW", 4.8, 5],
      ["Ford", 5.0, 6],
    ]);
    expect(firstRankCompetitorCards(rows).map((c) => [c.brand, c.avgPosition])).toEqual([
      ["Toyota", 3.6],
      ["Tesla", 3.9],
      ["BMW", 4.8],
      ["Ford", 5.0],
    ]);
    const ladder = rankLadder(rows.filter((r) => r.brand === "Hyundai" || r.brand === "Toyota"));
    expect(ladder.map((m) => [m.brand, m.avgPosition, m.rank])).toEqual([
      ["Toyota", 3.6, 1],
      ["Hyundai", 3.7, 2],
    ]);
    // 히어로의 "최고 순위"도 재순위 결과다(당사 중 최선 = Hyundai 2위).
    expect(firstRankHero(out).rank).toBe(2);
    // 스파크는 미러 회차 값 그대로(Tesla 3.8).
    expect(rows.find((r) => r.brand === "Tesla")!.spark.at(-1)).toBe(3.8);
  });
});

describe("rankFirstPositionRows: 미러 집계와 탭 재순위가 같이 쓰는 순위표 규칙", () => {
  it("동률 공동·다음 건너뜀 · null 은 순위 없이 끝(언급 수 내림차순) · 입력 불변", () => {
    const input = [
      row("C", 3.0),
      row("A", 1.5),
      row("N1", null, { mentions: 3 }),
      row("B", 1.5),
      row("N2", null, { mentions: 9 }),
    ];
    const snapshot = JSON.stringify(input);
    const out = rankFirstPositionRows(input);
    expect(out.map((r) => [r.brand, r.rank])).toEqual([
      ["A", 1],
      ["B", 1],
      ["C", 3],
      ["N2", null],
      ["N1", null],
    ]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("rankFirstPositionRows: 동률 타이브레이커는 로케일 무관(코드 단위)", () => {
  it("SSR·브라우저 기본 로케일과 무관하게 같은 순서다(hydration 불일치 방지)", () => {
    // 로케일 비교(en)라면 "a" < "B" < "현대" 가 아니라 대소문자를 접어 a, B 순이 된다.
    // 코드 단위 비교는 "B"(0x42) < "a"(0x61) < "현"(0xD604) 로 환경과 무관하게 고정이다.
    const out = rankFirstPositionRows([row("현대", 2), row("a", 2), row("B", 2)]);
    expect(out.map((r) => r.brand)).toEqual(["B", "a", "현대"]);
    expect(out.every((r) => r.rank === 1)).toBe(true);
  });
});

describe("배선: 언급 페이지가 우선 노출도 탭에도 같은 리더를 넘긴다", () => {
  it("FirstRankKpiTab 에 competitorValues={fetchStandardMentionCompetitorBrands(filters)}", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../mention/page.tsx", import.meta.url)),
      "utf8",
    );
    const i = page.indexOf("<FirstRankKpiTab");
    expect(i).toBeGreaterThan(0);
    const block = page.slice(i, page.indexOf("/>", i));
    expect(block).toContain("competitorValues={fetchStandardMentionCompetitorBrands(filters)}");
    const tab = readFileSync(
      fileURLToPath(new URL("../_components/kpi/first-rank-kpi-tab.tsx", import.meta.url)),
      "utf8",
    );
    // 히어로·순위 섹션이 **같은 훅**으로 덮은 결과를 받는다(각자 useAwaited 로 미러를 읽지 않는다).
    expect(tab.match(/useFirstPosition\(firstPosition, competitorValues\)/g)?.length).toBe(2);
    expect(tab).not.toMatch(/const fp = useAwaited\(firstPosition\)/);
  });
});

// ── 히어로 경쟁사 타일 4개 = Overview 경쟁사 행 4개 (2026-09-29) ────────────────
//
// 프리뷰 실측(09-28 회차, admin 무필터): Overview 카드 경쟁사 Tesla 3.7·Toyota 3.9·BMW 4.8·
// Mercedes-Benz 4.9 대 언급 우선 노출도 탭 히어로 Lexus 3.7·Tesla 3.7·Toyota 3.9·Honda 4.1.
// 값은 같은 리더였고 **고르는 규칙**이 달랐다(hmg-geo PR #312 로 한 함수로 통일).
// 같은 날 제품 결정: 우선 노출도는 **순위 기준**으로 고른다. 모집단은 순위표와 같은 언급 수
// 상위 10(자사 포함), 그 안의 경쟁사 중 평균 순위 상위 4(`competitorCandidates` position 분기).
describe("firstRankCompetitorCards: Overview 경쟁사 행과 같은 후보 규칙", () => {
  const v = (brand: string, avgPosition: number | null, mentions: number, isTracked = false): CompetitorBrandValue => ({
    brand,
    mentions,
    share: 1,
    mentionRate: 1,
    avgPosition,
    isTracked,
  });
  // 언급 수는 09-28 프리뷰 브랜드 표 실측값, 값은 Overview 리더 값. Rolls-Royce 는 순위는
  // 가장 좋지만 언급 수 상위 10 밖(11위 이하)이라 후보가 아니다(소수 브랜드 가드).
  const top10 = [
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
  ];
  const values = [...top10, v("Rolls-Royce", 1.8, 4_588)];
  /** 미러 순위표(상위 10) — 값은 일부러 리더와 다르게 둔다(덮어쓰기 후 리더 값이 보여야 함). */
  function mirror10(): FirstPositionResult {
    return {
      unit: "week",
      brands: top10.map((x) => x.brand),
      buckets: [],
      latest: rankFirstPositionRows(top10.map((x) => row(x.brand, Math.round(((x.avgPosition ?? 0) + 0.2) * 10) / 10, { tracked: x.isTracked, mentions: x.mentions }))),
    };
  }

  it("리더 값이 오면 타일 = competitorMinis(values, 'position') (브랜드·순서·값)", () => {
    const rows = rankTableRows(overlayFirstPositionValues(mirror10(), values), { sparkCycles: 4 });
    const tiles = firstRankCompetitorCards(rows, values).map((c) => [c.brand, c.avgPosition]);
    expect(tiles).toEqual(competitorMinis(values, "position").map((m) => [m.brand, m.value]));
    expect(tiles).toEqual([
      ["Lexus", 3.7],
      ["Tesla", 3.7],
      ["Toyota", 3.9],
      ["Honda", 4.1],
    ]);
  });

  it("타일 = 순위표의 경쟁사 앞 4행(같은 모집단·같은 순위)", () => {
    const rows = rankTableRows(overlayFirstPositionValues(mirror10(), values), { sparkCycles: 4 });
    const tableCompetitors = rows.filter((r) => !r.isTracked).slice(0, 4).map((r) => r.brand);
    expect(firstRankCompetitorCards(rows, values).map((c) => c.brand)).toEqual(tableCompetitors);
  });

  it("리더 값이 없으면(격자 off·degrade) 같은 규칙을 미러 행에 적용한다", () => {
    const rows = rankTableRows(mirror10(), { sparkCycles: 4 });
    expect(firstRankCompetitorCards(rows).map((c) => c.brand)).toEqual(["Lexus", "Tesla", "Toyota", "Honda"]);
  });

  it("후보가 순위표(미러 상위 N)에 없으면 리더 값으로 타일을 채운다(Δ 없음) — 타일이 조용히 빠지지 않는다", () => {
    const fp = mirror10();
    const rows = rankTableRows({ ...fp, latest: fp.latest.filter((r) => r.brand !== "Honda") }, { sparkCycles: 4 });
    const cards = firstRankCompetitorCards(rows, values);
    expect(cards.map((c) => [c.brand, c.avgPosition, c.wow])).toEqual([
      ["Lexus", 3.9, null],
      ["Tesla", 3.9, null],
      ["Toyota", 4.1, null],
      ["Honda", 4.1, null],
    ]);
  });
});
