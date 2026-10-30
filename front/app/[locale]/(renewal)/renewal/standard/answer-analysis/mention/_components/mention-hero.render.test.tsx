import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnFavorHeroVM, RnRankVM, RnRateHeroVM, RnRateTypesVM, RnRateValueVM, RnSummaryVM } from "../_data/screen-types";

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
const { Board, HeroValue, RateHero, Types } = await import("./mention-rate");
const { PerAnswerLine } = await import("./mention-body");
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
  trend: { missing: false, x: axis, own: axis.map(() => 76.6), average: null, ownNum: axis.map(() => 34452), ownDen: axis.map(() => 44979), competitors: [], values: [] },
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
    { key: "2026-09-28", positive: 52.0, negative: 1.6, positiveCount: 169090, total: 325173, gap: false },
    { key: "2026-10-05", positive: 54.1, negative: 1.9, positiveCount: 175995, total: 325173, gap: false },
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

// the 당사 type lines of the exposure view: two rounds, the first one's answers 40,100
const typeRow = (type: string, spark: (number | null)[], counts: (number | null)[]) => ({ type, pct: spark[1], signals: 9, spark, counts, delta: null, hasSpark: true });
const rateTypes = {
  degraded: false,
  cmp: { covered: [], rows: [], avgRef: [], dots: [], options: {} },
  own: {
    exposure: { rows: [typeRow("recommendation", [12.5, null], [5013, null])], maxPct: 12.5, maxCount: 9, x: ["2026-09-28", "2026-10-05"], answers: [40100, null] },
    sov: { rows: [], maxPct: 1, maxCount: 1, x: [], answers: [] },
  },
} as unknown as RnRateTypesVM;
const summary = (monthLine: RnSummaryVM["monthLine"]) => ({ monthLine }) as unknown as RnSummaryVM;
const MONTH_LINE = { days: 30, presetKey: "lastMonth", caption: { key: "window", params: {} }, chips: [{ key: "mentionsPerAnswer", unit: "pct", suppressed: false, value: 4.2, direction: "up" }] } as unknown as RnSummaryVM["monthLine"];

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
  rateTypes: settled(rateTypes),
  summary: settled(summary(MONTH_LINE)),
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

const render = (node: ReactNode, over: { tables?: string[]; input?: object } = {}) => {
  const inp = { ...(input as object), ...over.input } as never;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnMentionPageProvider input={inp}>
        <MentionProvider value={{ ...ctx, input: inp, tables: new Set(over.tables ?? []) }}>{node}</MentionProvider>
      </RnMentionPageProvider>
    </NextIntlClientProvider>,
  );
};
const cells = (html: string) => [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((c) => c[1]));

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

  // renewal audit 5-1: the trends name each round's counts, as the original's tooltips and type chart did
  it("the rate trend's table names 당사's numerator and denominator per round", () => {
    const rows = cells(render(<RateHero metric="exposure" />, { tables: ["hero-exposure"] }));
    expect(rows).toContainEqual(["브랜드 언급 답변 수", "34,452", "34,452", "34,452", "34,452"]);
    expect(rows).toContainEqual(["모니터링 답변 수", "44,979", "44,979", "44,979", "44,979"]);
  });

  it("the favorability trend's table names the signal counts per round", () => {
    const rows = cells(render(<FavorHeroCard />, { tables: ["fav-trend"] }));
    expect(rows).toContainEqual([ko.renewal.mention.favor.posCount, "169,090", "175,995"]);
    expect(rows).toContainEqual([ko.renewal.mention.favor.total, "325,173", "325,173"]);
  });

  it("a 당사 type line names its type answers and the round's answers at each point", () => {
    const html = render(<Types metric="exposure" initialView="own" />);
    const tips = [...html.matchAll(/data-rn-tip="([^"]*)"/g)].map((m) => m[1]);
    expect(tips).toEqual(["9/28 · 12.5%\n당사 추천 답변 5,013개 / 전체 답변 40,100개"]);
  });

  // renewal audit 7-3: the original type breakdown opened a type's prompts (the signal route with the type)
  it("a 당사 type row opens its prompts; a type without signals does not", () => {
    const two = {
      ...rateTypes,
      own: { ...rateTypes.own, exposure: { ...rateTypes.own.exposure, rows: [...rateTypes.own.exposure.rows, { ...rateTypes.own.exposure.rows[0], type: "definition", signals: 0 }] } },
    };
    const html = render(<Types metric="exposure" initialView="own" />, { input: { rateTypes: settled(two) } });
    const buttons = [...html.matchAll(/<button type="button" data-rn-type="(\w+)"( disabled="")?/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(buttons).toEqual([
      ["recommendation", false],
      ["definition", true],
    ]);
    expect(html).toContain(ko.answerAnalysis.mentions.breakdown.drilldownHint);
  });

  // renewal audit 5-2: a calendar month shows the 답변당 언급 수 line, as the original did
  it("a calendar month names the 답변당 언급 수 change", () => {
    const html = render(<PerAnswerLine />);
    expect(html).toContain("답변당 언급 수");
    expect(html).toContain("전전월 대비");
    expect(render(<PerAnswerLine />, { input: { summary: settled(summary(null)) } })).toBe("");
  });
});
