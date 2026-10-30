import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnFavorHeroVM, RnRankVM, RnRateHeroVM, RnRateValueVM } from "../_data/screen-types";

// The renewal Mention heroes as the 2026-10-29 metric review read them (display items, Mention #18 #26 #42 #47 #69):
// - a read that failed or was suppressed has no numerator / denominator (it showed "—%" over "0 / 0");
// - the failure copy says what is known, not "timed out" for every failure;
// - the heroes say which answers they count (every answer; the Overview cards count the representative ones);
// - the favorability trend legend names signal shares, not "AI 긍정 답변";
// - "앞선 브랜드" says it counts the table's rivals, and the position formula's unit is the page's (번째);
// - the board's trend chip counts the measured rounds, not the axis slots.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(),
}));

const { MentionProvider } = await import("./mention-context");
const { Board, HeroValue, RateHero } = await import("./mention-rate");
const { FavorHeroCard } = await import("./mention-favor");
const { RankHeroCard } = await import("./mention-rank");
const { RnMentionPageProvider } = await import("./mention-tabs");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const NO_DELTA = { value: null, basis: null };

// what the screen sends for a failed read (mention_renewal: no value, no parts)
const rateValue: RnRateValueVM = { exposure: { pct: null, numerator: null, denominator: null }, sov: { pct: null, numerator: null, denominator: null }, degraded: true };
const metric = (axis: string[], measuredCycles: number) => ({
  delta: NO_DELTA,
  standing: null,
  trend: { missing: false, x: axis, own: axis.map(() => 76.6), average: null, competitors: [], values: [] },
  board: {
    rows: [
      { key: "__own", own: true, sibling: false, pct: 76.6, mentions: null, spark: [], delta: null, gap: null, covered: true, pos: 1, top: true, hasSpark: false },
      { key: "BMW", own: false, sibling: false, pct: 31.4, mentions: 9, spark: [], delta: null, gap: -45.2, covered: true, pos: 2, top: true, hasSpark: false },
    ],
    axis,
    measuredCycles,
    barMax: 76.6,
  },
});
// an axis with a slot the scope did not measure (a later gap stays on the axis)
const AXIS = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const rateHero = { exposure: metric(AXIS, 3), sov: metric(AXIS, 3) } as unknown as RnRateHeroVM;
const favorHero: RnFavorHeroVM = {
  positivePct: null,
  negativePct: null,
  positive: null,
  total: null,
  positiveDelta: NO_DELTA,
  negativeDelta: NO_DELTA,
  mixedBasis: false,
  points: [
    { key: "2026-09-28", positive: 52.0, negative: 1.6, gap: false },
    { key: "2026-10-05", positive: 54.1, negative: 1.9, gap: false },
  ],
  trendMissing: false,
  degraded: true,
};
const rank = {
  fp: false,
  degraded: true,
  hero: { avgPosition: null, rankedAnswers: null, delta: NO_DELTA, series: [], axis: [] },
  ahead: null,
  rows: [],
  ownFirst: [],
  barMax: 1,
  track: null,
  covered: [],
  series: [],
  hasValue: [],
  options: {},
  ticks: {},
} as unknown as RnRankVM;

const input = {
  kpi: "exposure",
  view: "kpi",
  ownLabel: "HMG",
  period: null,
  filtered: false,
  compare: settled({ covered: ["BMW"] }),
  rateValue: settled(rateValue),
  rateHero: settled(rateHero),
  favorHero: settled(favorHero),
  rank: settled(rank),
} as never;

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
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnMentionPageProvider input={input}>
        <MentionProvider value={ctx}>{node}</MentionProvider>
      </RnMentionPageProvider>
    </NextIntlClientProvider>,
  );

const dd = (html: string) => [...html.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => m[1]);

describe("renewal Mention heroes", () => {
  it("a failed rate hero shows no numerator and denominator, and says it could not load", () => {
    const html = render(<HeroValue metric="exposure" />);
    expect(dd(html)).toEqual(["—", "—"]);
    expect(html).toContain(ko.renewal.mention.degraded.all);
    expect(html).not.toContain("시간 안에 끝나지 않아");
  });

  it("the rate hero says which answers it counts", () => {
    expect(render(<RateHero metric="sov" />)).toContain(ko.renewal.mention.hero.basisAll);
  });

  it("the board's trend chip counts the measured rounds", () => {
    const html = render(<Board metric="exposure" />);
    expect(html).toContain("추이 3회차");
    expect(html).not.toContain("추이 4회차");
  });

  it("favorability: no counts without a value, signal-share legend, the basis line", () => {
    const html = render(<FavorHeroCard />);
    expect(dd(html)).toEqual(["—", "—"]);
    expect(html).toContain(ko.renewal.mention.favor.positive);
    expect(html).not.toContain("AI 긍정 답변");
    expect(html).not.toContain("AI 부정 답변");
    expect(html).toContain(ko.renewal.mention.hero.basisAll);
    expect(html).not.toContain("시간 안에 끝나지 않아");
  });

  it("first position: no counts without a rank, the rivals' scope, the formula in 번째", () => {
    const html = render(<RankHeroCard />);
    expect(dd(html)).toEqual(["—", "—"]);
    expect(html).toContain(ko.renewal.mention.rank.ahead);
    expect(html).toContain(ko.renewal.mention.rank.aheadTip);
    expect(html).toContain("(단위: 번째)");
    expect(html).not.toContain("(단위: 위)");
    expect(html).toContain(ko.renewal.mention.hero.basisAll);
  });
});
