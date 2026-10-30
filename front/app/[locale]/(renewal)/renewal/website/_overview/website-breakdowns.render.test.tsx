import { describe, expect, it, vi } from "vitest";
import { RnWebsiteBrands, RnWebsiteEngines } from "./website-breakdowns";
import type { TilesView, TileView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { BrandCellView, WebsiteBrandsView, WebsiteEnginesView } from "./website-format";
import { TILES, part, settled, text, wrap } from "./_fixtures";

// Renewal Website Overview breakdowns (W1, 2026-10-30): website/brands and website/engines laid out — every value
// is the screen's; the table only marks what the screen marked (best) or named (best / worst engine).

const cell = (value: number, extra: Partial<BrandCellView> = {}): BrandCellView => ({
  unit: "percent", value, pending: false, delta: -1.2, direction: "down", tone: "bad", period: null, bar: 50, best: false, ...extra,
});
const BRANDS: WebsiteBrandsView = {
  brands: [
    { brand: "Genesis", state: "ok", cells: { visibility: cell(95.6, { best: true, bar: 100 }), citationShare: cell(13.4, { bar: 47 }) } },
    { brand: "Hyundai", state: "ok", cells: { visibility: cell(86.6, { bar: 90 }), citationShare: cell(28.3, { best: true, bar: 100, delta: 0, direction: "flat", tone: "flat" }) } },
    { brand: "Kia", state: "degraded", cells: {} },
  ],
};

describe("renewal Website Overview brands", () => {
  const out = wrap(<RnWebsiteBrands brands={settled(BRANDS)} total={settled(TILES)} />);
  const row = (b: string) => part(out, "data-rn-brand-row", b);

  it("leads with the HMG total (the KPI card's tiles), then each brand", () => {
    expect([...out.matchAll(/data-rn-brand-row="([^"]+)"/g)].map((m) => m[1])).toEqual(["total", "Genesis", "Hyundai", "Kia"]);
    expect(text(row("total"))).toContain("HMG 전체위 KPI");
    expect(text(row("total"))).toContain("88.0%▼5.2pp");
  });

  it("marks the screen's best per column and draws its bar widths", () => {
    expect(row("Genesis")).toMatch(/data-rn-best=""[^>]*>.*95\.6%/);
    expect(row("Genesis")).toContain("width:100.0%");
    expect(row("Hyundai")).toMatch(/data-rn-best=""[^>]*>.*28\.3%/);
    // a Δ that rounds to 0 reads 변화 없음 (the renewal Overview's brand table), never "–0.0pp"
    expect(text(row("Hyundai"))).toContain("28.3%변화 없음");
    expect(text(row("Hyundai"))).not.toContain("0.0pp");
  });

  it("in a period compare, a cell without a period result shows no round Δ", () => {
    const chip: NonNullable<TileView["period"]> = { key: "visibility", unit: "pp", suppressed: false, value: 2.1, direction: "up" };
    const periodTiles: TilesView = { ...TILES, groups: TILES.groups.map((g) => ({ ...g, tiles: g.tiles.map((t) => (t.key === "visibility" ? { ...t, period: chip } : t)) })) };
    const out2 = wrap(<RnWebsiteBrands brands={settled(BRANDS)} total={settled(periodTiles)} />);
    // Genesis's cells carry a round Δ (−1.2pp) but no period result; the HMG total keeps its period chip
    expect(text(part(out2, "data-rn-brand-row", "Genesis"))).not.toContain("1.2pp");
    expect(text(part(out2, "data-rn-brand-row", "total"))).toContain("2.1pp");
  });

  it("says a brand failed instead of leaving its cells empty", () => {
    expect(text(row("Kia"))).toContain("이 브랜드의 값을 불러오지 못했습니다");
  });

  it("is not shown without the brand axis or with a brand pick", () => {
    expect(wrap(<RnWebsiteBrands brands={settled({ brands: null })} total={settled(TILES)} />)).toBe("");
    expect(text(wrap(<RnWebsiteBrands brands={settled("failed" as const)} total={settled(TILES)} />))).toContain("브랜드별 비교를 불러오지 못했습니다");
  });
});

const ENGINES: WebsiteEnginesView = {
  engines: [
    { engine: "chatgpt", answers: 9993, values: { visibility: 88.3, shareOfVoice: 96.8, sentiment: 20.5, position: 1.1, citationShare: 25.8 },
      ratios: { visibility: { num: 8824, den: 9993 }, shareOfVoice: { num: 1, den: 1 }, sentiment: { num: 1, den: 1 }, position: { sum: 9700, count: 8824 }, citationShare: { num: 1, den: 1 } } },
    { engine: "deepseek", answers: 284, values: { visibility: 31, shareOfVoice: 97.3, sentiment: 23, position: 1.1, citationShare: 31.8 },
      ratios: { visibility: { num: 88, den: 284 }, shareOfVoice: { num: 1, den: 1 }, sentiment: { num: 1, den: 1 }, position: { sum: 97, count: 88 }, citationShare: { num: 1, den: 1 } } },
  ],
  consistency: { visibility: 34.7, shareOfVoice: 97.5, sentiment: 49.3, position: 97.7, citationShare: 72.7 },
  extremes: {
    visibility: { best: { engine: "chatgpt", value: 88.3 }, worst: { engine: "deepseek", value: 31 } },
    position: { best: { engine: "deepseek", value: 1.1 }, worst: { engine: "chatgpt", value: 1.1 } },
  },
  widest: "visibility",
  degraded: false,
};

describe("renewal Website Overview engines", () => {
  it("lists every engine with its answers, values and num / den on hover", () => {
    const out = wrap(<RnWebsiteEngines engines={settled(ENGINES)} />);
    const row = part(out, "data-rn-engine-row", "deepseek");
    expect(text(row)).toContain("DeepSeek284");
    expect(row).toContain('title="88 ÷ 284"');
    expect(part(out, "data-rn-engine-row", "chatgpt")).toContain('title="순위 합 9,700 ÷ 순위가 매겨진 답변 8,824"');
  });

  it("marks the screen's best and worst, only where the shown values differ", () => {
    const out = wrap(<RnWebsiteEngines engines={settled(ENGINES)} />);
    expect(part(out, "data-rn-engine-row", "chatgpt")).toMatch(/data-rn-mark="best"[^>]*>.*88\.3%/);
    expect(part(out, "data-rn-engine-row", "deepseek")).toMatch(/data-rn-mark="worst"[^>]*>.*31\.0%/);
    // both 1.1번째: not ranked
    expect(out.match(/data-rn-mark="(best|worst)"/g)).toHaveLength(2);
  });

  it("ends with the badge's consistency row, the widest one bold", () => {
    const out = wrap(<RnWebsiteEngines engines={settled(ENGINES)} />);
    const row = part(out, "data-rn-engine-row", "consistency");
    expect(text(row)).toContain("엔진 간 일관성 (최저 ÷ 최고)34.7%97.5%49.3%97.7%72.7%");
    expect(row).toMatch(/data-rn-widest=""[^>]*>34\.7%/);
  });

  it("narrows to an engine the panel offers only", () => {
    const pick = vi.fn();
    const out = wrap(<RnWebsiteEngines engines={settled(ENGINES)} onPick={pick} pickable={(e) => e === "chatgpt"} />);
    expect(part(out, "data-rn-engine-row", "chatgpt")).toContain('title="ChatGPT 엔진만 보기"');
    expect(part(out, "data-rn-engine-row", "deepseek")).not.toContain("엔진만 보기");
  });

  it("says the read failed or that there is nothing", () => {
    expect(text(wrap(<RnWebsiteEngines engines={settled({ ...ENGINES, engines: [], degraded: true })} />))).toContain("엔진별 값을 불러오지 못했습니다");
    expect(text(wrap(<RnWebsiteEngines engines={settled({ ...ENGINES, engines: [] })} />))).toContain("엔진별 측정 데이터가 없습니다");
  });
});
