import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { RnSiteCardsVM } from "./site-cards";
import type { RnMarketRow, RnMarketsVM } from "./site-markets";
import type { RnWebsiteMentionReads } from "./website-mention-body";

// The renewal Website Mention (2026-11-02, docs/handoff/website-mention-redesign.md):
// - the market table keeps Gold's values, leads with the prompts where another brand was named (not with the falls,
//   which mostly list answers analyzed empty, upstream D8), and says nothing about them: no warning, no adjusted rate;
// - the summary's findings keep a fixed order and pass no threshold; a market fall comes with the rise beside it;
// - the KPI view and 브랜드 상세 replace each other under the KPI cells, nothing under them stays still.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/website/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../../_components/overview-filters", () => ({ useRnFilterToggle: () => () => {} }));

const { RnSiteMarkets, orderMarkets } = await import("./site-markets");
const { RnSiteSummary, marketMoves } = await import("./site-summary");
const { RnSiteEngines } = await import("./site-engines");
const { RnWebsiteMentionBody } = await import("./website-mention-body");
const { RnMentionPageProvider } = await import("../../../../standard/answer-analysis/mention/_components/mention-tabs");
const { MentionProvider } = await import("../../../../standard/answer-analysis/mention/_components/mention-context");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const K = (exposure: number | null, position: number | null = 1.1) => ({ exposure, sov: 90, favorability: 25, "first-rank": position });
const row = (country: string, over: Partial<RnMarketRow> = {}): RnMarketRow => ({
  country, answers: 100, values: K(90), deltas: K(1, 0), mentioned: 90, mentionedDelta: 0, rival: { brand: "Toyota", exposure: 5 },
  brands: {}, missing: 30, missingWithBrands: 1, noBrandAnswers: 8, ...over,
});
const ROWS = [
  row("TR", { mentionedDelta: -363, missingWithBrands: 0, answers: 300, values: K(9.6, 1.4) }),
  row("KR", { mentionedDelta: 190, missingWithBrands: 2, answers: 200, values: K(99) }),
  row("SG", { mentionedDelta: -20, missingWithBrands: 23, answers: 173, values: K(31.8) }),
  row("JP", { mentionedDelta: null, missingWithBrands: 2, answers: 50, values: K(null, null) }),
];
const VM: RnMarketsVM = { brands: [], rows: ROWS, unmeasured: 0, degraded: false };

const ctx = (input: object) => ({
  input: input as never, kpi: "exposure" as const, setKpi: () => {}, ownLabel: "HMG", drawer: [], ownBrands: ["HMG"], ownSum: [],
  pick: { auto: true, brands: [] }, setPick: () => {}, lit: [], hover: () => {}, flash: () => {}, tables: new Set<string>(),
  toggleTable: () => {}, engineLabel: (e: string) => e, openDrawer: () => {},
});
const ENGINES = {
  exposure: {
    x: ["2026-10-02", "2026-10-09"],
    trendMissing: false,
    rows: [
      { engine: "chatgpt", own: 88.3, delta: -5.1, avg: 0.6, avgCount: 12, gap: 87.7, series: [93, 88.3], hasSeries: true },
      { engine: "deepseek", own: 31, delta: null, avg: 0.6, avgCount: 12, gap: 30.4, series: [null, 31], hasSeries: true },
    ],
  },
  sov: { x: [], trendMissing: false, rows: [] },
};
const FAVOR = { positivePct: 25.5, negativePct: 0.1, positiveDelta: { value: -4.2 } };
const SUMMARY = { asOf: "2026-10-09", exp: { rank: 1, pct: 88, delta: -5.2 }, sov: { rank: 1, pct: 96.3, delta: 1.4 }, fav: 25.5, pos: 1.1 };
const render = (node: ReactNode, input: object = {}, kpi = "exposure", view = "kpi") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnMentionPageProvider input={{ kpi, view, ownLabel: "HMG", period: null, filtered: false, ...input } as never}>
        <MentionProvider value={ctx(input)}>{node}</MentionProvider>
      </RnMentionPageProvider>
    </NextIntlClientProvider>,
  );
const marketOrder = (html: string) => [...html.matchAll(/data-rn-market="(\w+)"/g)].map(([, c]) => c);
const T = ko.renewal.website.mention;

describe("website mention market order", () => {
  it("each order sorts by its own column, ties by answers, no value last", () => {
    expect(orderMarkets(ROWS, "rivals", "exposure").map((r) => r.country)).toEqual(["SG", "KR", "JP", "TR"]);
    expect(orderMarkets(ROWS, "drop", "exposure").map((r) => r.country)).toEqual(["TR", "SG", "KR", "JP"]);
    expect(orderMarkets(ROWS, "low", "exposure").map((r) => r.country)).toEqual(["TR", "SG", "KR", "JP"]);
    expect(orderMarkets(ROWS, "answers", "exposure").map((r) => r.country)).toEqual(["TR", "KR", "SG", "JP"]);
  });

  it("a position's weak end is its largest", () => {
    expect(orderMarkets(ROWS, "low", "first-rank").map((r) => r.country)[0]).toBe("TR");
  });
});

describe("website mention market table", () => {
  it("leads with the prompts where another brand was named, and shows each market's counts as they are", () => {
    const html = render(<RnSiteMarkets vm={VM} />);
    expect(marketOrder(html)).toEqual(["SG", "KR", "JP", "TR"]);
    for (const head of [T.markets.missing, T.markets.withBrands, T.markets.noBrand, T.markets.answers, T.markets.rival]) expect(html).toContain(head);
    expect(html).toContain("Toyota 5.0%");
  });

  it("no warning, no corrected rate: the empty-answer count sits beside the value, the value stays Gold's", () => {
    const html = render(<RnSiteMarkets vm={VM} />);
    expect(html).toContain("9.6%");
    expect(html).not.toMatch(/주의|경고|보정|왜곡|신뢰/);
  });

  it("the brand columns come with two brands or more, a cell without a value is a dot", () => {
    const withBrands: RnMarketsVM = { ...VM, brands: ["Hyundai", "Kia"], rows: [row("US", { brands: { Hyundai: { ...K(0), delta: null }, Kia: null } })] };
    const html = render(<RnSiteMarkets vm={withBrands} />);
    expect(html).toContain(">Hyundai</th>");
    expect(html).toContain(">Kia</th>");
    expect(html).toContain("0.0%");
    expect(html).toContain(">·</td>");
    expect(html).toContain(T.markets.noteBrand);
    expect(render(<RnSiteMarkets vm={VM} />)).not.toContain(T.markets.noteBrand);
  });

  it("says how many markets have no answer; a position reads as a position", () => {
    expect(render(<RnSiteMarkets vm={{ ...VM, unmeasured: 14 }} />)).toContain(T.markets.noteUnmeasured.replace("{n}", "14"));
    const rank = render(<RnSiteMarkets vm={VM} />, {}, "first-rank");
    expect(rank).toContain(">1.4<");
  });

  it("no market: the empty line, or the degraded one", () => {
    expect(render(<RnSiteMarkets vm={{ ...VM, rows: [] }} />)).toContain(T.markets.empty);
    expect(render(<RnSiteMarkets vm={{ ...VM, rows: [], degraded: true }} />)).toContain(ko.renewal.mention.degraded.all);
  });
});

describe("website mention summary", () => {
  it("names the largest fall and the largest rise together, with no pick of its own", () => {
    const m = marketMoves(ROWS)!;
    expect([m.down.country, m.up.country]).toEqual(["TR", "KR"]);
    expect(marketMoves([row("JP", { mentionedDelta: null })])).toBeNull();
  });

  it("four findings in a fixed order, colour only on favorability's own move", () => {
    const html = render(<RnSiteSummary markets={settled(VM)} />, { rateEngines: settled(ENGINES), favorHero: settled(FAVOR), summary: settled(SUMMARY) });
    expect([...html.matchAll(/data-rn-finding="(\w+)"/g)].map(([, f]) => f)).toEqual(["market", "missing", "engine", "favor"]);
    expect(html).toContain("−363");
    expect(html).toContain("+190");
    expect(html).toContain(T.summary.missing.replace("{count}", "120").replace("{withBrands}", "27").replace("{noBrands}", "93"));
    expect(html).toContain("chatgpt 88.3% · deepseek 31.0%");
    expect(html).toContain("긍정 신호 25.5%");
    expect(html).toContain("부정 신호 0.1%");
    expect(html.match(/text-rn-warn-ink/g)).toHaveLength(1); // the warn icon: favorability's fall alone
  });
});

describe("website mention engine table", () => {
  it("shows 당사, its change and the rounds behind each engine", () => {
    const html = render(<RnSiteEngines metric="exposure" />, { rateEngines: settled(ENGINES) });
    expect([...html.matchAll(/data-rn-engine="(\w+)"/g)].map(([, e]) => e)).toEqual(["chatgpt", "deepseek"]);
    expect(html).toContain("88.3%");
    expect(html).toContain(T.engines.rounds.replace("{n}", "2"));
    expect(html).toContain(T.engines.rounds.replace("{n}", "1"));
  });

  it("heads the change column as a change (last review 2026-11-02: no head, its label said 당사 − 경쟁사 평균)", () => {
    const html = render(<RnSiteEngines metric="exposure" />, { rateEngines: settled(ENGINES) });
    const heads = [...html.slice(0, html.indexOf("</thead>")).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(([, h]) => h);
    expect(heads[2]).toBe(T.engines.colDelta);
    expect(html).not.toContain(`aria-label="${ko.renewal.mention.engine.gapTitle}"`);
  });
});

describe("website mention wording says what the values are (last review 2026-11-02)", () => {
  it("the rival column names how the rival is picked", () => {
    expect(T.markets.rival).toContain("언급 1위");
  });

  it("the weekly table speaks of a table, not of the chart it was", () => {
    for (const s of [T.weekly.desc, T.weekly.gapNote]) {
      expect(s).not.toContain("선");
      expect(s).not.toContain("눈금");
    }
  });

  it("Top 3 is the answers whose 당사 competitive rank is 3 or better (Gold top3), not an average", () => {
    expect(ko.answerAnalysis.mentions.def.top3Rate.definition).not.toContain("평균");
  });
});

describe("website mention views", () => {
  const reads: RnWebsiteMentionReads = { cards: settled({ asOf: null, summary: null, subKpis: null, deltas: null, prevBasisDate: null, degraded: { data: false, types: false, subKpis: false } } as unknown as RnSiteCardsVM), markets: settled(VM), weekly: settled({ weeks: [], gaps: [], rows: [], degraded: false }), compare: settled({ comparison: null, typeShare: null }) };
  const input = { tabValue: {}, tabDeltas: settled({}), rateEngines: settled(ENGINES), favorHero: settled(FAVOR), summary: settled(SUMMARY), shell: settled({}), compare: settled({}), rateValue: settled({}), rateHero: settled({}), rateTypes: settled({}), favorDist: settled({}), favorMatrix: settled({}), rank: settled({}), bump: settled({}), ranking: settled({}) };
  const body = <RnWebsiteMentionBody reads={reads} period={false} pageAsOf={null} admin={false} />;
  const ids = (html: string) => [...html.matchAll(/id="(sec-[\w-]+)"/g)].map(([, s]) => s);
  const HEAD = ["sec-summary", "sec-site-cards"];

  it("the KPI view: 현황, markets, then what that KPI breaks into", () => {
    expect(ids(render(body, input, "exposure"))).toEqual([...HEAD, "sec-overview", "sec-markets", "sec-mix"]);
    expect(ids(render(body, input, "favorability"))).toEqual([...HEAD, "sec-overview", "sec-markets", "sec-comp", "sec-mix"]);
    expect(ids(render(body, input, "first-rank"))).toEqual([...HEAD, "sec-overview", "sec-markets"]);
  });

  it("브랜드 상세 replaces them: no KPI section stays under it", () => {
    expect(ids(render(body, input, "exposure", "brands"))).toEqual([...HEAD, "sec-brands", "sec-site-weekly"]);
  });
});

describe("website mention messages", () => {
  it("every Korean key has its English", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(en.renewal.website.mention).sort()).toEqual(keys(ko.renewal.website.mention).sort());
  });
});
