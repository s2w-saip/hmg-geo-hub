import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RankingRow, RnDrawerBrand, RnRankingVM } from "../_data/screen-types";

// The renewal Mention brand ranking (renewal audit step 6):
// - 6-1: the table showed the first 100 body brands and searched those 100; the original Global searched every brand
//   and showed 100, the original website table every brand. Now: 100 rows first, the search over every brand, "더 보기",
//   and the cut note with the real count. A row past the shell's drawer rows opens its drawer with its own values.
// - 6-2: the original brand table and drilldown named each column's definition and formula (ColInfo); the renewal
//   table heads had none.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(),
}));

const { MentionProvider } = await import("./mention-context");
const { BrandDrawer, BrandRanking, PromptList, RANK_TABLE_STEP, rankTableRows } = await import("./mention-brands");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const N = 150;
const name = (i: number) => `Brand ${String(i).padStart(3, "0")}`;
const vals = (i: number) => ({ mentions: 1000 - i, prompts: 10, share: 0.1, mentionRate: 0.2, delta: null, covered: false });
const drawerRow = (i: number): RnDrawerBrand => ({
  brand: name(i),
  rank: i,
  isTracked: false,
  own: null,
  sibling: false,
  mentions: 1000 - i,
  share: 0.1,
  avgPosition: 4.2,
  mentionRate: 0.2,
  sentiment: { positive: 3, neutral: 1, mixed: 0, negative: 0 },
  sentimentPct: { positive: 75, neutral: 25, mixed: 0, negative: 0 },
  types: { mention: 1, recommendation: 2, comparison: 0, definition: 0, final_choice: 0 },
});
const row = (i: number): RankingRow => ({
  brand: name(i),
  rank: i,
  own: false,
  sibling: false,
  avgPosition: 4.2,
  group: name(i),
  grouped: false,
  hasMulti: true,
  off: vals(i),
  on: vals(i),
  ...(i > 100 ? { drawer: drawerRow(i) } : {}),
});
const idx = Array.from({ length: N }, (_, i) => i);
const order = { asc: idx, desc: [...idx].reverse() };
const orders = Object.fromEntries(["rank", "brand", "mentions", "share", "delta", "avgPosition", "prompts", "mentionRate"].map((k) => [k, k === "rank" || k === "brand" ? order : { asc: order.desc, desc: order.asc }]));
const ranking: RnRankingVM = {
  rows: idx.map((i) => row(i + 1)),
  count: N,
  multiUnavailable: false,
  orders: { off: orders, on: orders } as RnRankingVM["orders"],
  treemap: { off: [], on: [] },
};

const input = { kpi: "exposure", view: "brands", ownLabel: "HMG", period: null, filtered: false, ranking: settled(ranking) } as never;
const ctx = {
  input,
  kpi: "exposure" as const,
  setKpi: () => {},
  ownLabel: "HMG",
  drawer: [],
  ownBrands: ["Hyundai", "Kia", "Genesis"],
  pick: { auto: true, brands: [] },
  setPick: () => {},
  lit: [],
  hover: () => {},
  flash: () => {},
  tables: new Set<string>(),
  toggleTable: () => {},
  engineLabel: (e: string) => e,
  openDrawer: () => {},
};
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul" onError={() => {}}>
      <MentionProvider value={ctx}>{node}</MentionProvider>
    </NextIntlClientProvider>,
  );
const rowBrands = (html: string) => [...html.matchAll(/data-rn-b="([^"]*)" data-rn-row=/g)].map((m) => m[1]);
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const tips = (html: string) => [...html.matchAll(/<span role="tooltip"[^>]*>(.*?)<\/span><\/span>/g)].map((m) => unescape(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));

describe("renewal Mention brand ranking", () => {
  it("shows the first 100 rows, the real count and a more button", () => {
    const html = render(<BrandRanking initialView="table" />);
    expect(rowBrands(html)).toHaveLength(100);
    expect(html).toContain("150개 중 100개 표시");
    expect(html).toContain("50개 더 보기");
    expect(html).not.toContain("(상위 100)");
  });

  it("searches every brand, the ones past the first 100 too", () => {
    const html = render(<BrandRanking initialView="table" initialQuery="Brand 14" />);
    expect(rowBrands(html)).toEqual(["Brand 140", "Brand 141", "Brand 142", "Brand 143", "Brand 144", "Brand 145", "Brand 146", "Brand 147", "Brand 148", "Brand 149"]);
    expect(html).toContain("150개 중 10개 일치");
    expect(html).not.toContain("더 보기");
  });

  it("더 보기 adds 100 rows at a time over the kept rows; the search and the group keep every brand", () => {
    const all = ranking.rows;
    const page = (q: string, group: string | null, limit: number) => {
      const r = rankTableRows(all, q, group, limit);
      return [r.rows.length, r.matched];
    };
    expect(RANK_TABLE_STEP).toBe(100);
    expect(page("", null, RANK_TABLE_STEP)).toEqual([100, 150]);
    expect(page("", null, 2 * RANK_TABLE_STEP)).toEqual([150, 150]);
    expect(page("  bRAND 1 ", null, RANK_TABLE_STEP)).toEqual([51, 51]);
    expect(page("brand", null, RANK_TABLE_STEP)).toEqual([100, 150]);
    expect(rankTableRows(all, "", name(130), RANK_TABLE_STEP).rows.map((r) => r.brand)).toEqual([name(130)]);
  });

  it("a brand past the shell's drawer rows opens its drawer with its values", () => {
    const html = render(<BrandDrawer target={{ kind: "brand", brand: name(140), row: drawerRow(140) }} onClose={() => {}} />);
    expect(html).toContain("140위");
    expect(html).toContain("4.2");
    expect(html).toContain(ko.answerAnalysis.mentions.breakdown.sentimentTitle);
    expect(html).toContain(ko.answerAnalysis.mentions.breakdown.typesTitle);
  });

  it("names each column's definition and formula in the table head", () => {
    const html = render(<BrandRanking initialView="table" />);
    const c = ko.answerAnalysis.mentions.table;
    const head = tips(html);
    expect(head).toEqual(expect.arrayContaining([expect.stringContaining(c.colDefinition.rank), expect.stringContaining(c.colDefinition.position)]));
    expect(head.find((h) => h.includes(c.colDefinition.share))).toContain(c.colFormula.share);
    expect(head.find((h) => h.includes(c.colDefinition.rate))).toContain(c.colFormula.rate);
    expect(head.some((h) => h.includes(c.colDefinition.mentions))).toBe(true);
    expect(head.some((h) => h.includes(c.colDefinition.prompts))).toBe(true);
  });

  it("names the drawer prompt list's columns, the share's own denominator", () => {
    const prompt = { id: "p1", promptText: "q", mentions: 3, share: 12.5, providers: ["chatgpt"], funnelStage: null, answers: [], bestRank: 2, topRank: true };
    const html = render(<PromptList state={{ status: "ready", list: [prompt as never] }} onAnswer={() => {}} />);
    const d = ko.answerAnalysis.mentions.drilldown;
    const head = tips(html);
    expect(head.find((h) => h.includes(d.colDefinition.share))).toContain(d.colFormula.share);
    expect(head.some((h) => h.includes(d.colDefinition.rank))).toBe(true);
    expect(head.some((h) => h.includes(d.colDefinition.mentions))).toBe(true);
  });
});
