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
const { BrandDrawer, BrandRanking, CITE_SORTS, CitationDetail, CitationList, CitationRow, PROMPT_SORTS, PromptList, RANK_TABLE_STEP, brandDrillPaths, citationNos, rankTableRows, rowsInOrder } = await import("./mention-brands");

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
  ownSum: [],
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

  // 2026-11-02 premise review: the arrow tells a rival's move; only 당사's change is better or worse (the boards' rule)
  it("colours 당사's Δ only", () => {
    const moved = (i: number, own: boolean): RankingRow => ({ ...row(i), own, off: { ...vals(i), delta: 1.2, covered: true } });
    const rows = [moved(1, true), moved(2, false)];
    const one = { ...ranking, rows, count: 2, orders: { off: { ...orders, rank: { asc: [0, 1], desc: [1, 0] } }, on: orders } as RnRankingVM["orders"] };
    const inp = { ...(input as object), ranking: settled(one) } as never;
    const html = render(<MentionProvider value={{ ...ctx, input: inp }}><BrandRanking initialView="table" /></MentionProvider>);
    expect([...html.matchAll(/data-tone="(\w+)"/g)].map((m) => m[1])).toEqual(["up", "flat"]);
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

// renewal audit step 7 (the drawer's drills):
// - 7-1: the citation sources tab showed domain · category · citations · "URLs" (always "—": the list rows carry no URLs)
//   · prompts; the original drawer's domain table showed the share, the coverage and the 당사 mark, and a row opened its
//   URLs and prompts (the route's &skey= detail). Now: those columns, no URL column, a row opens its detail.
// - 7-2: the 당사 row's citation sources sent its label only (HMG is no Gold brand); both tabs now ask for 당사.
// - 7-3: the signal drawer also lists a mention type's prompts (the original type breakdown's drilldown).
describe("renewal Mention brand drawer drills", () => {
  const domain = (over: Partial<Record<string, unknown>>) =>
    ({ domain: "kia.com", skey: "kia.com", citations: 1234, share: 12.5, prompts: 40, coverageRate: 33.3, urls: [], promptList: [], isOurs: false, category: "Official (HMG)", subcategory: null, ...over }) as never;
  const ready = (list: unknown[]) => ({ status: "ready" as const, list: list as never[] });

  it("lists the sources with share, prompts, coverage, the category and the 당사 mark, without a URL column", () => {
    const html = render(<CitationList state={ready([domain({ isOurs: true }), domain({ domain: "reddit.com", skey: "reddit.com", isOurs: false, category: "Social & Video", share: 3.1 })])} detailQuery="mentionBrand=Toyota" onAnswer={() => {}} />);
    const c = ko.answerAnalysis.citations.table.col;
    for (const head of [c.domain, c.citations, c.share, c.prompts, c.coverage]) expect(html).toContain(head);
    expect(html).not.toContain(ko.answerAnalysis.mentions.drilldown.col.urls);
    expect(html).toContain("12.5%");
    expect(html).toContain("33.3%");
    expect(html).toContain("1,234");
    expect(html.match(/>HMG</g)).toHaveLength(1);
    expect(html).toContain(ko.citationCategories.officialHmg);
    expect(html).toContain(ko.renewal.mention.brands.citeHint);
    const b = ko.renewal.mention.brands;
    const head = tips(html);
    expect(head.find((h) => h.includes(b.citeShareDef))).toContain(b.citeShareFormula);
    expect(head.find((h) => h.includes(b.citeCoverageDef))).toContain(b.citeCoverageFormula);
    expect([...html.matchAll(/aria-expanded="(\w+)"/g)].map((m) => m[1])).toEqual(["false", "false"]);
  });

  it("an opened source reads its detail", () => {
    const html = render(<CitationRow row={domain({})} open onToggle={() => {}} detailQuery="mentionBrand=Toyota" onAnswer={() => {}} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(ko.answerAnalysis.mentions.drilldown.citationsLoading);
  });

  it("an opened source lists its URLs, or its prompts", () => {
    const detail = {
      url: "/x",
      status: "ready" as const,
      urls: [{ url: "https://www.kia.com/us/ev9", title: "EV9", count: 7, aiProvider: "ChatGPT", promptText: "best SUV?", country: null }],
      promptList: [{ id: "p1", promptText: "best SUV?", funnelStage: null, citations: 7, ownedCitations: 7, providers: ["chatgpt"], answers: [{ jobId: "j1" }], share: null }],
      urlTotal: 20,
    } as never;
    const urls = render(<CitationDetail row={domain({})} detail={detail} onAnswer={() => {}} />);
    expect(urls).toContain("EV9");
    expect(urls).toContain("www.kia.com/us/ev9");
    expect(urls).toContain(`7 ${ko.answerAnalysis.citations.drilldown.cites}`);
    expect(urls).toContain(`${ko.renewal.citation.drawer.urls} 20`);
    expect(urls).toContain("20개 중 1개 표시");
    const prompts = render(<CitationDetail row={domain({})} detail={detail} onAnswer={() => {}} initialView="prompts" />);
    expect(prompts).toContain('data-rn-prompt="p1"');
    expect(prompts).not.toContain(`>${ko.answerAnalysis.citations.table.col.share}<`);
  });

  it("the 당사 row asks for 당사 on both tabs; a competitor row names its brand", () => {
    const own = brandDrillPaths("geography=US", { brand: "HMG", own: { code: null }, isWebsite: false, projectId: null });
    expect(own.prompts).toBe("/api/scope/brand-mention-prompts?geography=US&mentionBrand=HMG&own=1");
    expect(own.citations).toBe("/api/scope/brand-citations?geography=US&mentionBrand=HMG&own=1");
    const rival = brandDrillPaths("", { brand: "Toyota", own: null, isWebsite: true, projectId: null });
    expect(rival.citations).toBe("/api/scope/brand-citations?mentionBrand=Toyota&surface=website");
  });

  it("the signal drawer names a mention type", () => {
    const html = render(<BrandDrawer target={{ kind: "signal", signal: "recommendation" }} onClose={() => {}} />);
    expect(html).toContain("‘추천’ 신호가 발생한 프롬프트");
    expect(render(<BrandDrawer target={{ kind: "signal", signal: "negative" }} onClose={() => {}} />)).toContain("‘부정’ 신호가 발생한 프롬프트");
  });
});

// renewal audit step 8 (the treemap):
// - 8-2: the '자동차 외' group (Google, Apple, …) folded into '그 외' always; it now folds by the share and order rule of
//   every group, so it can show: a single brand is its name (its key the brand, like any one-brand group), several the
//   group's name, without a short code.
// - 8-3: the Δ colours painted |Δ| < 0.2pp as "no change"; only a Δ that rounds to 0.0 is. The tint steps are a size
//   scale (0.1 · 0.5 · 1.0pp), not a judgment.
const treemap = await import("./mention-brands");
describe("renewal Mention treemap", () => {
  const { DIV_NEG, DIV_POS, DIV_ZERO, divColor, groupTile } = treemap;
  const groupName = (g: string, several = false) => (g === "__nonAuto" ? "자동차 외" : g === "__rest" ? "그 외" : several && g !== "HMG" ? `${g} 그룹` : g);
  const member = (brand: string) => ({ brand, value: 10, share: 2, delta: null, own: false, sibling: false });
  const group = (key: string, brands: string[]) => ({ key, members: brands.map(member), value: 10, share: 2, delta: null, partial: false, own: false });

  it("paints no change only for a Δ that rounds to 0.0, the tint by size", () => {
    // the size the tile reads: "0.0pp" under 0.05, else one decimal (deltaTxt)
    expect([0, 0.04, -0.04].map(divColor)).toEqual([DIV_ZERO, DIV_ZERO, DIV_ZERO]);
    expect([0.1, 0.19, 0.4].map(divColor)).toEqual([DIV_POS[0], DIV_POS[0], DIV_POS[0]]);
    expect([-0.1, -0.15, -0.4].map(divColor)).toEqual([DIV_NEG[0], DIV_NEG[0], DIV_NEG[0]]);
    expect([0.5, 0.9, 1.0, 3].map(divColor)).toEqual([DIV_POS[1], DIV_POS[1], DIV_POS[2], DIV_POS[2]]);
    expect([-0.5, -0.9, -1.0, -2.5].map(divColor)).toEqual([DIV_NEG[1], DIV_NEG[1], DIV_NEG[2], DIV_NEG[2]]);
  });

  it("names the steps in the legend", () => {
    const html = render(<BrandRanking />);
    const steps = ko.renewal.mention.treemap.steps.split(",");
    expect(steps).toEqual(["−1.0pp 이하", "−0.5", "−0.1", "변화 없음", "+0.1", "+0.5", "+1.0pp 이상"]);
    for (const s of steps) expect(html).toContain(s);
    expect(html).not.toContain("±0.2");
  });

  it("a '자동차 외' group is a tile like any group", () => {
    expect(groupTile(group("__nonAuto", ["Google"]), groupName)).toEqual({ key: "Google", title: "Google", short: undefined });
    expect(groupTile(group("__nonAuto", ["Google", "Apple"]), groupName)).toEqual({ key: "__nonAuto", title: "자동차 외", short: undefined });
    expect(groupTile(group("Toyota", ["Toyota"]), groupName)).toEqual({ key: "Toyota", title: "Toyota", short: undefined });
    expect(groupTile(group("Toyota", ["Toyota", "Lexus"]), groupName)).toEqual({ key: "Toyota", title: "Toyota 그룹", short: "Toyota" });
    expect(groupTile(group("__rest", ["Tesla"]), groupName)).toEqual({ key: "__rest", title: "그 외", short: undefined });
    expect(groupTile(group("__rest", ["Tesla", "BMW"]), groupName)).toEqual({ key: "__rest", title: "그 외", short: undefined });
  });
});

// Global 지표 정리 (2026-11-05): the 복수 언급 toggle goes on Global (turned on, the top 10 stayed the same 10); its values sit
// on each row's tooltip and in the CSV, and each column's ⓘ names both bases. Project and Website keep the toggle.
describe("renewal Mention brand ranking: Global has no 복수 언급 toggle", () => {
  const multi = (i: number): RankingRow => ({ ...row(i), on: { mentions: 40 - i, prompts: 3, share: 2.5, mentionRate: 0.7, delta: null, covered: false } });
  const two = { ...ranking, rows: [multi(1), multi(2)], count: 2, orders: { off: { ...orders, rank: { asc: [0, 1], desc: [1, 0] } }, on: orders } as RnRankingVM["orders"] };
  const at = (global: boolean) => {
    const inp = { ...(input as object), ranking: settled(two), global } as never;
    return render(
      <MentionProvider value={{ ...ctx, input: inp }}>
        <BrandRanking initialView="table" />
      </MentionProvider>,
    );
  };
  const c = ko.answerAnalysis.mentions.table;
  const b = ko.renewal.mention.brands;

  it("Project and Website keep the toggle and a plain row tooltip", () => {
    const html = at(false);
    expect(html).toContain('role="switch"');
    expect(html).toContain(`${c.multiToggle}</button>`);
    expect(html).not.toContain("복수 언급 기준 —");
  });

  it("Global: no toggle; each row names its 복수 언급 values, each head both definitions", () => {
    const html = at(true);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain(`${c.multiToggle}</button>`);
    expect(html).toContain(`${b.rowTip}\n복수 언급 기준 — 브랜드 복수 언급 수 39 · 복수 언급 점유율 2.5% · 복수 언급 프롬프트 3 · 복수 언급률 0.7%`);
    const head = tips(html);
    expect(head.find((h) => h.includes(c.colDefinition.mentions))).toContain(c.colDefinition.multiMentions);
    expect(head.find((h) => h.includes(c.colDefinition.share))).toContain(b.multiShareFormula);
    expect(head.find((h) => h.includes(c.colDefinition.prompts))).toContain(b.multiPromptsDef);
    expect(head.find((h) => h.includes(c.colDefinition.rate))).toContain(b.multiRateFormula);
  });
});

// Restored 2026-11-05 (the original drawer's sorts, every page): the prompt table's six keys and the citation sources'
// five with the '#' citation rank, from the route's orders, one direction each.
describe("renewal Mention brand drawer sorts", () => {
  const prompt = (id: string, text: string, mentions: number) => ({ id, promptText: text, mentions, share: mentions / 2, providers: ["chatgpt"], funnelStage: null, answers: [], bestRank: 2, topRank: false }) as never;
  const list = [prompt("p1", "b prompt", 3), prompt("p2", "a prompt", 9), prompt("p3", "c prompt", 5)];
  // the route's orders (indices into the list), as mention_drilldown.prompt_orders sends them
  const promptOrders = {
    mentions: { asc: [0, 2, 1], desc: [1, 2, 0] },
    prompt: { asc: [1, 0, 2], desc: [2, 0, 1] },
    rank: { asc: [0, 1, 2], desc: [0, 1, 2] },
    share: { asc: [0, 2, 1], desc: [1, 2, 0] },
    funnel: { asc: [0, 1, 2], desc: [0, 1, 2] },
    providers: { asc: [0, 1, 2], desc: [0, 1, 2] },
  };
  const ids = (html: string) => [...html.matchAll(/data-rn-prompt="(\w+)"/g)].map((m) => m[1]);

  it("each key has one direction: names, the funnel and the best rank ascending, the counts descending", () => {
    expect(PROMPT_SORTS).toEqual({ mentions: "desc", rank: "asc", share: "desc", prompt: "asc", funnel: "asc", providers: "desc" });
    expect(CITE_SORTS).toEqual({ citations: "desc", domain: "asc", share: "desc", prompts: "desc", coverageRate: "desc" });
    expect(rowsInOrder(["x", "y", "z"], promptOrders, "prompt", "asc")).toEqual(["y", "x", "z"]);
    // no orders (or a stale order of another length): as received
    expect(rowsInOrder(["x", "y"], undefined, "prompt", "asc")).toEqual(["x", "y"]);
    expect(rowsInOrder(["x", "y"], promptOrders, "prompt", "asc")).toEqual(["x", "y"]);
  });

  it("the prompt list opens on mentions, names its six sorts, and sorts by the route's order", () => {
    const state = { status: "ready" as const, list, orders: promptOrders };
    const html = render(<PromptList state={state} onAnswer={() => {}} />);
    expect(ids(html)).toEqual(["p2", "p3", "p1"]);
    const p = ko.renewal.mention.brands.promptSort;
    for (const k of Object.keys(PROMPT_SORTS)) expect(html).toContain(`>${p[k as keyof typeof p]}</option>`);
    expect(html).toContain(`aria-label="${ko.renewal.mention.brands.sortLabel}"`);
    // the heads of the keys with a column sort; the active one is pressed
    expect([...html.matchAll(/<button type="button" aria-pressed="(\w+)"/g)].map((m) => m[1])).toEqual(["false", "false", "true", "false"]);
    expect(ids(render(<PromptList state={state} onAnswer={() => {}} initialSort="prompt" />))).toEqual(["p2", "p1", "p3"]);
    // without the route's orders: no sort controls, the order received
    const plain = render(<PromptList state={{ status: "ready", list }} onAnswer={() => {}} />);
    expect(ids(plain)).toEqual(["p1", "p2", "p3"]);
    expect(plain).not.toContain("<select");
    expect(plain).not.toContain("aria-pressed");
  });

  const domain = (name: string, citations: number) =>
    ({ domain: name, skey: name, citations, share: citations / 10, prompts: 4, coverageRate: 5, urls: [], promptList: [], isOurs: false, category: null, subcategory: null }) as never;
  const sources = [domain("kia.com", 50), domain("bmw.com", 80), domain("audi.com", 20)];
  const citeOrders = {
    citations: { asc: [2, 0, 1], desc: [1, 0, 2] },
    domain: { asc: [2, 1, 0], desc: [0, 1, 2] },
    share: { asc: [2, 0, 1], desc: [1, 0, 2] },
    prompts: { asc: [0, 1, 2], desc: [0, 1, 2] },
    coverageRate: { asc: [0, 1, 2], desc: [0, 1, 2] },
  };
  const cites = (html: string) => [...html.matchAll(/data-rn-cite="([^"]+)"[^>]*>\s*<button[\s\S]*?data-rn-cite-no="">(\d*)</g)].map((m) => `${m[2]} ${m[1]}`);

  it("the citation sources sort by the route's order, and '#' stays the citation rank", () => {
    expect(citationNos(3, citeOrders)).toEqual([2, 1, 3]);
    expect(citationNos(2, undefined)).toEqual([1, 2]);
    const state = { status: "ready" as const, list: sources, orders: citeOrders };
    expect(cites(render(<CitationList state={state} detailQuery="mentionBrand=Toyota" onAnswer={() => {}} />))).toEqual(["1 bmw.com", "2 kia.com", "3 audi.com"]);
    const byName = render(<CitationList state={state} detailQuery="mentionBrand=Toyota" onAnswer={() => {}} initialSort="domain" />);
    expect(cites(byName)).toEqual(["3 audi.com", "1 bmw.com", "2 kia.com"]);
    expect(byName).toContain(`>${ko.answerAnalysis.citations.table.col.rank}</span>`);
    expect([...byName.matchAll(/<button type="button" aria-pressed="(\w+)"/g)].map((m) => m[1])).toEqual(["true", "false", "false", "false", "false"]);
  });
});
