import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import ko from "@/messages/ko.json";
import type { TilesView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { websiteFindings, type FindingFormat } from "./website-findings";
import type { WebsiteBrandsView, WebsiteEnginesView } from "./website-format";
import { TILES, tile } from "./_fixtures";

// 핵심 요약 (W1, 2026-10-30): cards picked from the screens' values — no threshold, no judgment of its own — each a
// list of label · value rows (the user, 2026-10-30: rows, not one joined sentence).

const t = createTranslator({ locale: "ko", messages: ko, namespace: "renewal.website.overview" });
const tr = (k: string, p?: Record<string, string | number>) => t(k as "kpiTitle", p);
const SHORT: Record<string, string> = { visibility: "노출률", shareOfVoice: "점유율", sentiment: "우호도", position: "우선 노출도", citationShare: "인용 점유율", citationAccuracy: "타겟 출처" };
const f: FindingFormat = {
  value: (unit, v) => (unit === "rank" ? `${v.toFixed(1)}번째` : `${v.toFixed(1)}%`),
  delta: (unit, d) => (unit === "rank" ? `${Math.abs(d).toFixed(1)}번째` : `${Math.abs(d).toFixed(1)}pp`),
  count: (n) => n.toLocaleString("ko-KR"),
  short: (k) => SHORT[k] ?? k,
  engine: (c) => ({ chatgpt: "ChatGPT", deepseek: "DeepSeek", gemini: "Gemini" })[c] ?? c,
};
const ENGINES: WebsiteEnginesView = {
  engines: [
    { engine: "deepseek", answers: 284, values: { visibility: 31, shareOfVoice: 97.3, sentiment: 23, position: 1.1, citationShare: 31.8 }, ratios: {} as WebsiteEnginesView["engines"][0]["ratios"] },
    { engine: "gemini", answers: 9939, values: { visibility: 89.4, shareOfVoice: 94.8, sentiment: 41.7, position: 1.1, citationShare: 23.1 }, ratios: {} as WebsiteEnginesView["engines"][0]["ratios"] },
  ],
  consistency: { visibility: 34.7 },
  extremes: { visibility: { best: { engine: "gemini", value: 89.4 }, worst: { engine: "deepseek", value: 31 } } },
  widest: "visibility",
  degraded: false,
};
const cell = (value: number) => ({ unit: "percent" as const, value, pending: false, delta: null, direction: "flat" as const, tone: "flat" as const, period: null, bar: 0, best: false });
const BRANDS: WebsiteBrandsView = {
  brands: [
    { brand: "Genesis", state: "ok", cells: { citationShare: cell(13.4) } },
    { brand: "Hyundai", state: "ok", cells: { citationShare: cell(28.3) } },
    { brand: "Kia", state: "ok", cells: { citationShare: cell(27.2) } },
  ],
};
const COMPOSITION = {
  topics: [],
  sources: [
    { domain: "kia.com", citations: 83061, share: 20, isOurs: true },
    { domain: "hyundai.news", citations: 6694, share: 1.6, isOurs: false },
    { domain: "genesis.com", citations: 43138, share: 10.4, isOurs: true },
    { domain: "", citations: 194466, share: 46.8, isOurs: false },
  ],
  degraded: false,
};

describe("websiteFindings", () => {
  const rows = (x: { rows: { label: string; meta?: string; value: string; change?: { dir: string; tone: string }; mark?: { text: string } }[] }) =>
    x.rows.map((r) => [r.label, r.meta, r.mark?.text, r.change ? `${r.change.dir === "up" ? "▲" : "▼"}${r.value}` : r.value].filter(Boolean).join(" "));

  it("restates the sections' values as rows: what got worse, the widest engine gap, the brands, the sources", () => {
    const out = websiteFindings({ tiles: TILES, engines: ENGINES, brands: BRANDS, composition: COMPOSITION }, tr, f);
    expect(out.map((x) => [x.key, x.tone, x.tag, x.note ?? null])).toEqual([
      ["change", "warn", "직전 회차 대비", "나빠짐 1 · 좋아짐 2 · 같음 1"],
      ["engine", "info", "엔진 차이가 가장 큰 지표", "노출률 일관성 34.7%"],
      ["brand", "info", "브랜드별 인용 점유율", null],
      ["source", "info", "인용 출처", null],
    ]);
    expect(out.map(rows)).toEqual([
      ["노출률 ▼5.2pp"],
      ["Gemini 답변 9,939 가장 앞섬 89.4%", "DeepSeek 답변 284 가장 뒤짐 31.0%"],
      ["Hyundai 28.3%", "Kia 27.2%", "Genesis 13.4%"],
      ["1위 kia.com 20.0%", "상위 3개 중 당사 2개", "기타 46.8%"],
    ]);
    expect(out[0].rows[0].change).toEqual({ dir: "down", tone: "down" });
  });

  it("draws a change row as its tile does: the arrow follows the value, the colour better / worse (a rank that rose is worse)", () => {
    const tiles: TilesView = {
      groups: [{ category: "content", tiles: [tile({ key: "position", unit: "rank", value: 1.4, delta: 0.3, direction: "up", tone: "bad" })] }],
      suppressionCaption: null,
    };
    const [change] = websiteFindings({ tiles, engines: null, brands: null, composition: null }, tr, f);
    expect(change.rows).toEqual([{ label: "우선 노출도", value: "0.3번째", change: { dir: "up", tone: "down" } }]);
  });

  it("reads a compared period from the period chips, and says when nothing got worse", () => {
    const tiles: TilesView = {
      groups: [{ category: "content", tiles: [
        tile({ key: "visibility", value: 88, period: { key: "visibility", unit: "pp", suppressed: false, value: 2.1, direction: "up" } }),
        tile({ key: "sentiment", value: 20, period: { key: "favorability", unit: "pp", suppressed: true, value: null, direction: "flat" } }),
      ] }],
      suppressionCaption: null,
    };
    const [change] = websiteFindings({ tiles, engines: null, brands: null, composition: null }, tr, f);
    // nothing worse: the counts say so and the rows are the better ones
    expect([change.tone, change.tag, change.note, rows(change)]).toEqual(["good", "선택 기간 비교", "나빠짐 0 · 좋아짐 1 · 같음 0", ["노출률 ▲2.1pp"]]);
    const flat: TilesView = { groups: [{ category: "content", tiles: [tile({ key: "visibility", value: 88, delta: 0, direction: "flat", tone: "flat" })] }], suppressionCaption: null };
    const [none] = websiteFindings({ tiles: flat, engines: null, brands: null, composition: null }, tr, f);
    expect([none.rows, none.empty]).toEqual([[], "바뀐 지표 없음"]);
  });

  it("in a period compare, a tile without a period result is not counted as a change (no round Δ under a period header)", () => {
    const tiles: TilesView = {
      groups: [{ category: "content", tiles: [
        tile({ key: "visibility", value: 88, period: { key: "visibility", unit: "pp", suppressed: false, value: 2.1, direction: "down" } }),
        tile({ key: "citationAccuracy", value: 64.6, delta: -1.4, direction: "down", tone: "bad" }),
      ] }],
      suppressionCaption: null,
    };
    const [change] = websiteFindings({ tiles, engines: null, brands: null, composition: null }, tr, f);
    expect([change.note, rows(change)]).toEqual(["나빠짐 1 · 좋아짐 0 · 같음 0", ["노출률 ▼2.1pp"]]);
  });

  it("drops a line whose values are missing (failed read, one engine, one brand, no sources)", () => {
    const out = websiteFindings(
      { tiles: TILES, engines: { ...ENGINES, widest: null }, brands: "failed", composition: { ...COMPOSITION, degraded: true } },
      tr,
      f,
    );
    expect(out.map((x) => x.key)).toEqual(["change"]);
    expect(websiteFindings({ tiles: TILES, engines: null, brands: { brands: [BRANDS.brands![0]] }, composition: null }, tr, f).map((x) => x.key)).toEqual(["change"]);
  });
});
