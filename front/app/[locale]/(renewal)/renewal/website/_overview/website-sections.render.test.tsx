import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";
import type { CompositionView, GeoCountryView, GeoView, TrendChartView, WebsiteGeoView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { RnWebsiteTrend, TrendMultiples, rankTick } from "./website-trend";
import { RnWebsiteSources, sliceFills } from "./website-sources";
import { MarketsTable, RnWebsiteMarkets, orderCountries } from "./website-markets";
import { part, settled, text, wrap } from "./_fixtures";

// Renewal Website Overview (W1, 2026-10-30): the trend as small multiples with the rounds' answers and gaps, the
// sources with their 100% bar, and the markets table with every value website/geo sends.

/** Container query names (`@max-[…]/name:`) the markup uses without an `@container/name` of its own. The page puts
 * the sections in no named container (website/page.tsx names rnpage around 핵심 요약 only), so such a query never
 * applies. */
const orphanQueries = (html: string) => {
  const defined = new Set([...html.matchAll(/@container\/([\w-]+)/g)].map((m) => m[1]));
  return [...new Set([...html.matchAll(/@(?:min|max)-\[[^\]]+\]\/([\w-]+):/g)].map((m) => m[1]))].filter((n) => !defined.has(n));
};

describe("renewal Website Overview trend", () => {
  const view: TrendChartView = {
    rows: ["2026-09-25", "2026-10-02", "2026-10-09"].map((day, i) => ({
      key: day, day, measuredDays: 0, answers: 20000 + i,
      values: i === 1 ? { visibility: 90 } : { visibility: 90 - i, shareOfVoice: 96, position: 1.1, citationShare: 25 },
      gap: { mention: null, citation: i === 1 ? { reason: "collection_error" as const, scope: "citations" as const } : null },
    })),
    availableSeries: ["visibility", "shareOfVoice", "citationShare", "position"],
  };

  it("draws every series the screen has, each on its own chart", () => {
    const out = wrap(<TrendMultiples view={view} />);
    expect([...out.matchAll(/data-rn-multiple="(\w+)"/g)].map((m) => m[1])).toEqual(["visibility", "shareOfVoice", "citationShare", "position"]);
    expect(text(part(out, "data-rn-multiple", "position"))).toContain("위쪽일수록 앞섬");
  });

  it("lists each round's answers and names a gap by its family", () => {
    const out = wrap(<TrendMultiples view={view} />);
    expect([...out.matchAll(/data-rn-round="([^"]+)"[^>]*>(.*?)<\/td>/g)].map((m) => `${m[1]} ${text(m[2])}`)).toEqual([
      "2026-09-25 20,000", "2026-10-02 20,001인용 공백", "2026-10-09 20,002",
    ]);
    expect(out).toContain('data-rn-gap="citation"');
  });

  it("draws each round's answers as a bar from 0 on one scale, over its count", () => {
    const few: TrendChartView = { ...view, rows: view.rows.map((r, i) => ({ ...r, answers: [20000, 1573, 0][i] })) };
    const out = wrap(<TrendMultiples view={few} />);
    expect([...out.matchAll(/data-rn-answers-bar=""[^>]*height:([\d.]+)%/g)].map((m) => m[1])).toEqual(["100.0", "7.9", "0.0"]);
  });

  it("draws the answer bars in a neutral gray: a count has no better side and is not a 당사 series", () => {
    const out = wrap(<TrendMultiples view={view} />);
    const bars = [...out.matchAll(/<i data-rn-answers-bar=""[^>]*>/g)].map((m) => m[0]);
    expect(bars).toHaveLength(3);
    for (const bar of bars) expect(bar).not.toMatch(/navy|rn-up|rn-down/);
  });

  it("tips each round's answers with the change from the round before, without a tone", () => {
    const out = wrap(<TrendMultiples view={{ ...view, rows: view.rows.map((r, i) => ({ ...r, answers: [20000, 18750, 18750][i] })) }} />);
    const tips = [...out.matchAll(/data-rn-round="[^"]+"[^>]*data-rn-tip="([^"]*)"/g)].map((m) => m[1].replace(/&#x27;|&#39;/g, "'").split("\n"));
    expect(tips).toEqual([
      ["9/25 회차 · 답변 20,000", "표시 범위의 첫 회차라 비교하지 않음"],
      ["10/2 회차 · 답변 18,750", "직전 회차(9/25) 대비 −1,250", "인용 공백"],
      ["10/9 회차 · 답변 18,750", "직전 회차(10/2)와 같음"],
    ]);
  });

  it("shows no answer count for a mention-gap round (the screen sends 0 there), and compares no round with it", () => {
    const gap = { reason: "collection_error" as const };
    const rows = view.rows.map((r, i) => (i === 1 ? { ...r, answers: 0, values: {}, gap: { mention: gap, citation: null } } : r));
    const out = wrap(<TrendMultiples view={{ ...view, rows }} />);
    expect([...out.matchAll(/data-rn-round="([^"]+)"[^>]*>(.*?)<\/td>/g)].map((m) => `${m[1]} ${text(m[2])}`)).toEqual([
      "2026-09-25 20,000", "2026-10-02 —언급 공백", "2026-10-09 20,002",
    ]);
    const tips = [...out.matchAll(/data-rn-round="[^"]+"[^>]*data-rn-tip="([^"]*)"/g)].map((m) => m[1].split("\n"));
    expect(tips[1]).toEqual(["10/2 회차 · 답변 수 없음", "언급 공백"]);
    expect(tips[2]).toEqual(["10/9 회차 · 답변 20,002", "직전 회차(10/2)는 답변 수가 없어 비교하지 않음"]);
  });

  it("keeps the rank axis ticks apart, at one decimal count per axis", () => {
    const fine = [0.95, 1, 1.05, 1.1];
    expect(fine.map(rankTick(fine))).toEqual(["0.95", "1.00", "1.05", "1.10"]);
    const coarse = [1, 1.2, 1.4, 1.6];
    expect(coarse.map(rankTick(coarse))).toEqual(["1.0", "1.2", "1.4", "1.6"]);
  });

  it("gives the multiples no colour of their own: each is the 당사 series (the old legend dot drew 점유율 in red)", () => {
    const out = wrap(<TrendMultiples view={view} />);
    expect(out).not.toMatch(/#e63312|rn-down/i);
    expect(part(out, "data-rn-multiple", "shareOfVoice")).not.toContain("rounded-full");
  });

  it("uses no container query without its container (renewal audit 3-6: the page names no rnpage around it)", () => {
    const out = wrap(<RnWebsiteTrend trend={settled({ trend: view })} />);
    expect(out).toContain("data-rn-multiples=");
    expect(orphanQueries(out)).toEqual([]);
  });

  it("tells a failed read from a trend still accruing", () => {
    expect(text(wrap(<RnWebsiteTrend trend={settled("failed" as const)} />))).toContain("KPI 추이를 불러오지 못했습니다");
    expect(text(wrap(<RnWebsiteTrend trend={settled({ trend: null })} />))).toContain(ko.dashboard.trend.accruing);
  });
});

describe("renewal Website Overview sources", () => {
  const c: CompositionView = {
    topics: [],
    sources: [
      { domain: "kia.com", citations: 83061, share: 20, isOurs: true },
      { domain: "hyundai.news", citations: 6694, share: 1.6, isOurs: false },
      { domain: "", citations: 194466, share: 46.8, isOurs: false },
    ],
    degraded: false,
  };

  it("shows the whole as one bar, then the domains, 당사 marked, and the rest as 기타", () => {
    const out = wrap(<RnWebsiteSources composition={settled(c)} citationHref="/ko/renewal/website/answer-analysis/citation" />);
    const bar = out.slice(out.indexOf("data-rn-sources-bar"), out.indexOf("data-rn-sources=", out.indexOf("data-rn-sources-bar") + 1));
    expect([...bar.matchAll(/width:([\d.]+)%/g)].map((m) => m[1])).toEqual(["20", "1.6", "46.8"]);
    expect(bar).toContain('title="kia.com 20.0% · 83,061회"');
    const row = (k: string) => {
      const at = out.indexOf(`data-rn-source="${k}"`);
      return text(out.slice(out.indexOf(">", at) + 1, out.indexOf("</li>", at)));
    };
    expect(row("kia.com")).toBe("1kia.com당사83,061회20.0%");
    expect(row("rest")).toBe("기타194,466회46.8%");
  });

  it("colours 당사 in navy steps, the others in greys, 기타 lightest", () => {
    expect(sliceFills(c.sources)).toEqual(["#002c5f", "#8a837b", "#eee9e2"]);
  });

  it("says the read failed instead of showing no sources", () => {
    expect(text(wrap(<RnWebsiteSources composition={settled({ topics: [], sources: [], degraded: true })} citationHref="" />))).toContain("출처별 구성비를 불러오지 못했습니다");
  });
});

describe("renewal Website Overview markets", () => {
  const empty: GeoView = { markets: [], pending: [], ourLabel: "HMG", countryOrder: [], countryGroups: [], domains: {} as GeoView["domains"] };
  const vals = (v: number) => ({ visibility: v, shareOfVoice: v + 10, sentiment: 20, position: 1.1, citationShare: 13 });
  const rivals = { visibility: { name: "Tata", value: 3.5 }, shareOfVoice: { name: "Tata", value: 0.8 }, sentiment: null, position: null, citationShare: null };
  const country = (code: string, v: number): GeoCountryView =>
    ({ code, numeric: null, values: vals(v), rivals, showLead: true, hmgSov: v + 10, hmgRank: 1, fieldSize: 9, topBrand: { name: "Hyundai", sov: v + 10 }, topRival: null, answers: 100 }) as GeoCountryView;
  const geo: GeoView = {
    ...empty,
    ourLabel: "Hyundai",
    markets: [
      { region: "", numerics: [], countries: [country("CO", 40), country("EU", 90)], values: vals(80), rivals, showLead: true, hmgSov: 90, hmgRank: 1, fieldSize: 79,
        topBrand: { name: "Hyundai", sov: 91.6 }, topRival: { name: "Tata", sov: 0.8 }, answers: 1225 } as GeoView["markets"][number],
    ],
    pending: [],
  };
  const shown = (g: GeoView): WebsiteGeoView => ({ show: true, degraded: false, geo: g });

  it("shows every market value in one table: answers, our rank, the five KPIs with their rival, the lead brand", () => {
    const out = wrap(<MarketsTable geo={geo} />);
    const region = text(part(out, "data-rn-market", "~unassigned"));
    expect(region).toContain("권역 미분류2개국");
    expect(region).toContain("1,2251위 / 79");
    // the rival's name and value in two spans (the name may be cut, the value never)
    expect(region).toContain("80.0%Tata3.5%90.0%Tata0.8%");
    expect(region).toContain("Hyundai 91.6%");
    expect(text(part(out, "data-rn-country", "CO"))).toContain("콜롬비아");
  });

  it("names a virtual market code as the filter panel does, and shows 선두 브랜드 only when a lead is not 당사 (showLead)", () => {
    const own = { ...geo, markets: geo.markets.map((m) => ({ ...m, showLead: false, countries: m.countries.map((c) => ({ ...c, showLead: false, code: c.code === "EU" ? "worldwide" : c.code })) })) };
    const out = wrap(<MarketsTable geo={own} />);
    expect(text(part(out, "data-rn-country", "worldwide"))).toContain(ko.dashboard.filters.value.worldwide);
    expect(out).not.toContain(ko.renewal.website.overview.colLead);
    expect(text(out)).not.toContain("Hyundai 91.6%");
  });

  it("starts on 점유율 in the screen's order; a column head orders each market's countries by it", () => {
    const out = wrap(<MarketsTable geo={geo} />);
    expect(out).toMatch(/aria-pressed="true"[^>]*>점유율/);
    expect([...out.matchAll(/data-rn-country="(\w+)"/g)].map((m) => m[1])).toEqual(["CO", "EU"]);
    expect(orderCountries(geo.markets[0].countries, "visibility").map((c) => c.code)).toEqual(["EU", "CO"]);
    expect(orderCountries(geo.markets[0].countries, "position").map((c) => c.code)).toEqual(["CO", "EU"]);
  });

  it("asks an administrator to pick one brand; the other accounts have no brand axis", () => {
    expect(text(wrap(<RnWebsiteMarkets geo={settled(shown(empty))} isAdmin />))).toContain("브랜드를 하나 고르면");
    expect(wrap(<RnWebsiteMarkets geo={settled(shown(empty))} isAdmin={false} />)).toBe("");
  });

  it("uses no container query without its container (renewal audit 3-6: the page names no rnpage around it)", () => {
    const out = wrap(<RnWebsiteMarkets geo={settled(shown(geo))} isAdmin />);
    expect(out).toContain("data-rn-market-map=");
    expect(orphanQueries(out)).toEqual([]);
  });

  it("shows nothing without card data and a notice when the read failed", () => {
    expect(wrap(<RnWebsiteMarkets geo={settled({ show: false } as WebsiteGeoView)} isAdmin />)).toBe("");
    expect(text(wrap(<RnWebsiteMarkets geo={settled("failed" as const)} isAdmin />))).toContain("시장별 현황을 불러오지 못했습니다");
  });
});
