import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import type { GeoCountryView, GeoRegionView, GeoView } from "../_data/screen-types";
import type { OverviewKpiKey } from "../_data/overview-metrics";
import { GeoOverview } from "./geo-overview";
import {
  DEFAULT_MARKET_VIEW,
  marketAriaSort,
  marketBarPct,
  marketViewOf,
  marketViewQuery,
  pickColumn,
  sortMarketRows,
  type MarketView,
} from "./geo-market-table";

// 2026-11-05 D-12 (the user's '본 프로젝트에 개발 시작' on docs/design/ui/market-heatmap-mockup.html): the renewal
// 시장별 현황 table shows the five KPIs, the answers and the rival of the picked KPI; the column heads pick the KPI and
// the sort (the chips merged into them); 권역별 (closed) / 국가 전체; the picked column's bar starts at zero.

vi.mock("./geo-map-lazy", () => ({
  GeoMapLazy: (p: { metric?: string }) => <i data-geo-map-lazy={p.metric} />,
}));

type Values = Record<OverviewKpiKey, number | null>;
const v = (visibility: number | null, position: number | null, citationShare = 20): Values => ({ visibility, shareOfVoice: 30, sentiment: 50, position, citationShare });
const country = (code: string, values: Values, answers: number): GeoCountryView => ({
  code, numeric: null, values, answers, rivals: { visibility: { name: "BMW", value: 31.2 }, shareOfVoice: null, sentiment: null, position: { name: "Toyota", value: 3.9 }, citationShare: null },
  showLead: false, hmgSov: 30, hmgRank: 1, fieldSize: 5, topBrand: null, topRival: null,
});
const region = (id: string, values: Values, countries: GeoCountryView[]): GeoRegionView => ({
  region: id, numerics: [], countries, values, answers: countries.reduce((n, c) => n + (c.answers ?? 0), 0),
  rivals: { visibility: { name: "BMW", value: 31.2 }, shareOfVoice: null, sentiment: null, position: null, citationShare: null },
  showLead: false, hmgSov: 30, hmgRank: 1, fieldSize: 5, topBrand: null, topRival: null,
});
const GEO: GeoView = {
  ourLabel: "HMG", pending: [], countryOrder: ["JP", "KR", "DE"],
  countryGroups: [{ region: "Asia", codes: ["JP", "KR"] }, { region: "Europe", codes: ["DE"] }],
  domains: { visibility: [61, 90.5], shareOfVoice: [30, 30], sentiment: [50, 50], position: [1.6, 2.6], citationShare: [20, 20] },
  markets: [
    region("Asia", v(76.7, 2.2), [country("JP", v(61.0, 1.6), 569), country("KR", v(90.5, 2.6), 1234)]),
    region("Europe", v(76.0, 2.4), [country("DE", v(72.1, null), 2300)]),
  ],
};
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );
const rowsOf = (html: string) => [...html.matchAll(/<tr[^>]*data-geo-country="(\w+)"/g)].map((m) => m[1]);
const M = ko.renewal.overview.markets;

describe("renewal market table", () => {
  it("five KPI heads as buttons, answers and the rival column; no KPI chips on the renewal screen, the original keeps them", () => {
    const html = render(<GeoOverview geo={GEO} renewal />);
    expect((html.match(/data-rn-mkt-head="/g) ?? []).length).toBe(5);
    expect(html).not.toContain('role="tab"');
    expect(html).toContain(M.colAnswers);
    expect(html).toContain(ko.dashboard.overview.geo.colRival);
    expect(html).toContain(`data-rn-market-table="region"`);
    // regions start closed: their rows, no country rows
    expect(html).toContain('data-geo-region="Asia"');
    expect(rowsOf(html)).toEqual([]);
    // a region row carries its countries' answers
    expect(html).toContain((569 + 1234).toLocaleString("ko-KR"));
    const original = render(<GeoOverview geo={GEO} />);
    expect((original.match(/role="tab"/g) ?? []).length).toBe(5);
    expect(original).not.toContain("data-rn-mkt-head");
  });

  it("국가 전체 lists every country best-first on the picked KPI, values missing last; the map follows the head", () => {
    const flat = (view: MarketView) => render(<GeoOverview geo={GEO} renewal initialMarketView={view} />);
    expect(rowsOf(flat({ ...DEFAULT_MARKET_VIEW, layout: "flat" }))).toEqual(["KR", "DE", "JP"]);
    expect(rowsOf(flat({ metric: "visibility", dir: "worst", layout: "flat" }))).toEqual(["JP", "DE", "KR"]);
    const pos = flat({ metric: "position", dir: "best", layout: "flat" });
    expect(rowsOf(pos)).toEqual(["JP", "KR", "DE"]);
    expect(pos).toContain('data-geo-map-lazy="position"');
    expect(pos).toMatch(/aria-sort="ascending"[^>]*><button[^>]*data-rn-mkt-head="position"/);
  });

  it("only the picked column draws its bar, from zero", () => {
    const html = render(<GeoOverview geo={GEO} renewal initialMarketView={{ ...DEFAULT_MARKET_VIEW, layout: "flat" }} />);
    const kr = html.slice(html.indexOf('data-geo-country="KR"'), html.indexOf("</tr>", html.indexOf('data-geo-country="KR"')));
    expect((kr.match(/<i [^>]*style="width:/g) ?? []).length).toBe(1);
    expect(kr).toMatch(/data-rn-mkt-cell="visibility"[^>]*>.*90\.5%.*width:90\.5%/);
  });
});

describe("market view helpers", () => {
  it("the URL round-trips the view and leaves the defaults out", () => {
    const view: MarketView = { metric: "sentiment", dir: "worst", layout: "flat" };
    const q = marketViewQuery(new URLSearchParams("brand=Kia"), view);
    expect(q).toBe("?brand=Kia&mkt=sentiment&mktDir=worst&mktView=flat");
    expect(marketViewOf(new URLSearchParams(q))).toEqual(view);
    expect(marketViewQuery(new URLSearchParams("brand=Kia&mkt=sentiment"), DEFAULT_MARKET_VIEW)).toBe("?brand=Kia");
    expect(marketViewOf(new URLSearchParams("mkt=nope&mktDir=x"))).toEqual(DEFAULT_MARKET_VIEW);
  });
  it("a new head starts best-first, the same head flips", () => {
    expect(pickColumn(DEFAULT_MARKET_VIEW, "position")).toEqual({ ...DEFAULT_MARKET_VIEW, metric: "position", dir: "best" });
    expect(pickColumn(DEFAULT_MARKET_VIEW, "visibility").dir).toBe("worst");
  });
  it("the rank sorts lower-first when best, rows without a value last, ties keep their order", () => {
    const rows = [{ id: "a", values: v(50, 3) }, { id: "b", values: v(50, null) }, { id: "c", values: v(60, 1.5) }, { id: "d", values: v(50, 3) }];
    expect(sortMarketRows(rows, { ...DEFAULT_MARKET_VIEW, metric: "position" }).map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
    expect(sortMarketRows(rows, DEFAULT_MARKET_VIEW).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });
  it("bars from zero: a rate its value, a rank 1 ÷ value; aria-sort follows the numbers", () => {
    expect(marketBarPct("visibility", 61)).toBe(61);
    expect(marketBarPct("position", 1)).toBe(100);
    expect(marketBarPct("position", 2)).toBe(50);
    expect(marketBarPct("position", null)).toBe(0);
    expect(marketAriaSort({ ...DEFAULT_MARKET_VIEW, metric: "position" })).toBe("ascending");
    expect(marketAriaSort(DEFAULT_MARKET_VIEW)).toBe("descending");
  });
});
