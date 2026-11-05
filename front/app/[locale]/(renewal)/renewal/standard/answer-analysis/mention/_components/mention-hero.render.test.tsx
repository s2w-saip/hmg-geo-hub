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
// - the board's trend chip counts the measured rounds, not the axis slots — and names the axis's unmeasured rounds, as
//   the original table's coverage line did (2026-11-05).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(),
}));

const { MentionProvider } = await import("./mention-context");
const { Board, Engines, HeroValue, RateHero, Types } = await import("./mention-rate");
const { PerAnswerLine, Summary } = await import("./mention-body");
const { FavorHeroCard } = await import("./mention-favor");
const { RankBody, RankHeroCard } = await import("./mention-rank");
const { KpiBasisChip, RnMentionPageProvider } = await import("./mention-tabs");

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
  hero: { avgPosition: null, rankedAnswers: null, delta: NO_DELTA, series: [], rankedSeries: [], axis: [] },
  ahead: null,
  standing: null,
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
  ownBrands: ["HMG"],
  ownSum: ["Hyundai", "Kia", "Genesis"],
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

const render = (node: ReactNode, over: { tables?: string[]; input?: object; pick?: { auto: boolean; brands: string[] } } = {}) => {
  const inp = { ...(input as object), ...over.input } as never;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnMentionPageProvider input={inp}>
        <MentionProvider value={{ ...ctx, input: inp, tables: new Set(over.tables ?? []), ...(over.pick ? { pick: over.pick } : {}) }}>{node}</MentionProvider>
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

  it("the board's trend chip counts the measured rounds, and the axis's unmeasured ones when there are", () => {
    // the original competitor table's coverage line: '추이 축 18회차 · 측정 14회차 · 미측정 4회차' (06-01 ~ 10-31)
    const html = render(<Board metric="exposure" />);
    expect(html).toContain("추이 축 4회차 · 측정 3 · 미측정 1");
    expect(html).not.toContain("추이 3회차");
    expect(html).not.toContain("추이 4회차");
    for (const global of [false, true]) {
      const all = { ...rateHero, exposure: metric(AXIS, 4) };
      const full = render(<Board metric="exposure" />, { input: { rateHero: settled(all), global } });
      expect(full).toContain("추이 4회차");
      expect(full).not.toContain("미측정");
    }
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
    expect(dd(html)).toEqual(["—", "—", "—"]);
    expect(html).toContain(ko.renewal.mention.rank.ahead);
    expect(html).toContain(ko.renewal.mention.rank.aheadTip);
    expect(html).toContain("(단위: 번째)");
    expect(html).not.toContain("(단위: 위)");
    expect(html).toContain(ko.renewal.mention.hero.basisAll);
  });

  // 2026-11-02 premise review: the original's counts and basis chips, gone from the renewal or hidden by the dense layout
  it("the rate hero names the brands of its sum and the favorability hero its basis, in the dense layout too", () => {
    const rate = render(<HeroValue metric="exposure" />);
    expect(rate).toContain("당사 = Hyundai+Kia+Genesis 합산");
    expect(rate).not.toContain("rn-dense_&amp;]:hidden");
    const favor = render(<FavorHeroCard />);
    expect(favor).toContain(ko.renewal.mention.favor.chipSignal);
    expect(favor).not.toContain("rn-dense_&amp;]:hidden");
  });

  it("first position names the ranked answers of every round and 당사's place in the table", () => {
    const ranked = {
      ...rank,
      fp: true,
      hero: { avgPosition: 2.4, rankedAnswers: 900, delta: NO_DELTA, series: [2.1, 2.4], axis: ["2026-09-28", "2026-10-05"], rankedSeries: [800, 900] },
      ahead: 6,
      standing: { rank: 7, total: 11, topPct: 64 },
    };
    const html = render(<RankHeroCard />, { input: { rank: settled(ranked) }, tables: ["rank-trend"] });
    expect(cells(html)).toContainEqual([ko.renewal.mention.rank.ranked, "800", "900"]);
    expect(dd(html)[2]).toBe("7위 · 상위 64%");
    expect(html).toContain("아래 표 11개 브랜드 중 당사 자리입니다");
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

  // renewal audit 15 (⛔L, HUB rule 5): no HUB-made baseline. Without a compare brand the hero draws 당사 alone (a payload
  // that still carried the old competitor average is not drawn), and the type card compares with the picked brands only
  it("with no compare brand the hero trend draws 당사 alone, no competitor average", () => {
    const old = { ...rateHero, exposure: { ...rateHero.exposure, trend: { ...rateHero.exposure.trend, average: AXIS.map(() => 30) } } };
    const over = { input: { rateHero: settled(old) }, pick: { auto: false, brands: [] } };
    expect(render(<RateHero metric="exposure" />, over)).not.toContain("경쟁사 평균");
    const rows = cells(render(<RateHero metric="exposure" />, { ...over, tables: ["hero-exposure"] }));
    expect(rows.map((r) => r[0])).toEqual(["", "HMG", "브랜드 언급 답변 수", "모니터링 답변 수"]);
  });

  it("the type card compares with the picked brands only: no competitor average, no gap without a pick", () => {
    const cell = (value: number, own: number) => ({ value, gap: own - value, lo: Math.min(own, value), hi: Math.max(own, value) });
    // the old payload's average fields (rows[].avg, avgRef) are not drawn
    const cmp = { covered: ["BMW"], rows: [{ type: "final_choice", own: 30, avg: 11.7 }], avgRef: [cell(11.7, 30)], dots: [[cell(20, 30)]], options: { "0": { refs: [[]], top: 40 }, "1": { refs: [["BMW"]], top: 40 } } };
    const types = { ...rateTypes, cmp } as unknown as RnRateTypesVM;
    const none = render(<Types metric="exposure" />, { input: { rateTypes: settled(types) }, pick: { auto: false, brands: [] } });
    expect(none).not.toContain("경쟁사 평균");
    expect(none).not.toContain("vs ");
    expect(none).toContain("비교 브랜드를 고르면 차이가 보입니다");
    expect(none).toContain("최종 선택: 당사 30.0%");
    const bmw = render(<Types metric="exposure" />, { input: { rateTypes: settled(types) } });
    expect(bmw).toContain("vs BMW");
    expect(bmw).toContain("+10.0pp");
    expect(bmw).not.toContain("경쟁사 평균");
  });

  // renewal audit 15 (W6): a gap change or a type gap shown as 0.0 has no direction
  it("the summary names a gap change of 0.0 as no change, and a type gap of 0.0 as level with the compare brand", () => {
    const s = {
      asOf: "2026-10-05",
      exp: { rank: 2, pct: 40, delta: 0.3 },
      sov: { rank: 2, pct: 20, delta: null },
      fav: 50,
      pos: 2.4,
      covered: ["BMW"],
      fixed: [{ kind: "standingTrail", tone: "warn", pri: 6, target: "sec-comp", kpi: "exposure", brand: "BMW", params: { rank: 2, rival: "BMW", gap: 10, own: 40, move: 0, widened: "same" } }],
      typeFindings: [{ kind: "typeLead", tone: "info", pri: 4, target: "sec-mix", kpi: "exposure", params: { type: "final_choice", gap: 0, own: 30, dir: "same" }, refCands: ["BMW"] }],
      options: { "0": { type: null, order: [0] }, "1": { type: 0, order: [0, -1] } },
      monthLine: null,
    } as unknown as RnSummaryVM;
    const html = render(<Summary />, { input: { summary: settled(s) } });
    expect(html).toContain("직전 회차 대비 격차 변화 없음");
    expect(html).not.toContain("좁혀졌습니다");
    expect(html).toContain("같은 값: 최종 선택 · BMW — 뒤지는 유형 없음");
    expect(html).not.toContain("모든 유형에서");
  });

  // renewal audit 5-2: a calendar month shows the 답변당 언급 수 line, as the original did
  it("a calendar month names the 답변당 언급 수 change", () => {
    const html = render(<PerAnswerLine />);
    expect(html).toContain("답변당 언급 수");
    expect(html).toContain("전전월 대비");
    expect(render(<PerAnswerLine />, { input: { summary: settled(summary(null)) } })).toBe("");
  });
});

// Global 지표 정리 (2026-11-05): Global says each number once — Project and Website keep their layout (input.global unset)
describe("renewal Mention: Global says each number once", () => {
  const standing = { n: 13, rank: 1, other: "BMW", gap: 45.2 };
  const withStanding = { exposure: { ...rateHero.exposure, standing }, sov: { ...rateHero.sov, standing } } as unknown as RnRateHeroVM;

  it("the rate hero has no standing line on Global (the board holds the place and the gap)", () => {
    const project = render(<HeroValue metric="exposure" />, { input: { rateHero: settled(withStanding) } });
    expect(project).toContain("비교 13개 브랜드 중");
    expect(project).toContain("2위 BMW 대비 +45.2pp");
    const global = render(<HeroValue metric="exposure" />, { input: { rateHero: settled(withStanding), global: true } });
    expect(global).not.toContain("비교 13개 브랜드 중");
    expect(global).not.toContain("BMW 대비");
    expect(global).toContain("당사 = Hyundai+Kia+Genesis 합산");
  });

  // 지표 정리 moved the column to the row tooltip; the user dropped it there too the same day (and from the CSV)
  it("the competitor board has no 당사 대비 on Global, neither a column nor on the row tooltip; Project keeps the column", () => {
    const head = `>${ko.renewal.mention.board.colGap}<`;
    const project = render(<Board metric="exposure" />);
    expect(project).toContain(head);
    expect(project).toContain(">−45.2pp<");
    expect(project).toContain(ko.renewal.mention.board.infoExposure);
    const global = render(<Board metric="exposure" />, { input: { global: true } });
    expect(global).not.toContain(head);
    expect(global).not.toContain("−45.2pp");
    expect(global).not.toContain(ko.renewal.mention.board.colGap);
    expect(global).toContain(ko.renewal.mention.board.infoExposureGlobal);
  });

  // the engine card's competitor average: a HUB-made baseline (the engine's top 30 rivals), 당사 ahead of it by 29 pp or
  // more in every condition — out on Global with its gap chip, its chip and the CSV columns (the user's call, 2026-11-05)
  it("the engine card has no competitor average on Global; Project keeps it with the gap chip", () => {
    const engines = { exposure: { rows: [{ engine: "chatgpt", own: 78.2, avg: 10.8, avgCount: 29, gap: 67.4, series: [77.9, 78.2], delta: 0.3, hasSeries: true }], x: ["2026-09-28", "2026-10-05"], trendMissing: false } };
    const over = (global: boolean) => ({ input: { rateEngines: settled({ ...engines, sov: engines.exposure }), global } });
    const project = render(<Engines metric="exposure" />, over(false));
    expect(project).toContain("78.2%");
    expect(project).toContain("10.8%");
    expect(project).toContain("경쟁사 평균 (상위 29개사)");
    expect(project).toContain(`title="${ko.renewal.mention.engine.gapTitle}"`);
    expect(project).toContain(ko.renewal.mention.engine.chip);
    const global = render(<Engines metric="exposure" />, over(true));
    expect(global).toContain("78.2%");
    expect(global).not.toContain("10.8%");
    expect(global).not.toContain("경쟁사 평균");
    expect(global).not.toContain("+67.4pp");
    expect(global).toContain(ko.renewal.mention.engine.infoExposureGlobal);
  });

  // the first-position hero: 앞선 경쟁사 (0 of 21 conditions) out; 표에서 당사 순위 · 상위 N% onto the table's 당사 row
  const ranked = {
    ...rank,
    fp: true,
    degraded: false,
    hero: { avgPosition: 2.4, rankedAnswers: 900, delta: NO_DELTA, series: [2.1, 2.4], axis: ["2026-09-28", "2026-10-05"], rankedSeries: [800, 900] },
    ahead: 0,
    standing: { rank: 1, total: 11, topPct: 9 },
    rows: [
      { key: "__own", own: true, sibling: false, avgPosition: 2.4, rank: null, spark: [2.1, 2.4], delta: 0.3, gap: null, covered: true, pos: 1, hasSpark: true },
      { key: "Tesla", own: false, sibling: false, avgPosition: 3.7, rank: 1, spark: [3.6, 3.7], delta: 0.1, gap: 1.3, covered: false, pos: 2, hasSpark: true },
    ],
    ownFirst: [0, 1],
    barMax: 3.7,
    track: { lo: 2.4, hi: 3.7 },
  } as unknown as RnRankVM;

  // 앞선 경쟁사 and 표에서 당사 순위 went with 지표 정리; the ranked answers (the exposure hero's numerator in every Gold
  // cell) and the track (the table's dots on the same axis) the same day, the user's call
  it("first position: the hero has no counts and no track on Global; Project keeps both, the Website card its count", () => {
    const project = render(<RankHeroCard />, { input: { rank: settled(ranked) } });
    expect(dd(project)).toEqual(["900개", "0개", "1위 · 상위 9%"]);
    expect(project).toContain(ko.renewal.mention.rank.ahead);
    expect(project).toContain(ko.renewal.mention.rank.trackTitle);
    const global = render(<RankHeroCard />, { input: { rank: settled(ranked), global: true }, tables: ["rank-trend"] });
    expect(dd(global)).toEqual([]);
    expect(global).not.toContain(ko.renewal.mention.rank.ahead);
    expect(global).not.toContain(ko.renewal.mention.rank.aheadTip);
    expect(global).not.toContain(ko.renewal.mention.rank.trackTitle);
    expect(global).not.toContain(`aria-label="${ko.renewal.mention.rank.trackAria}"`);
    // each round's ranked answers stay on the trend's table
    expect(cells(global)).toContainEqual([ko.renewal.mention.rank.ranked, "800", "900"]);
    // the Website page's plain card stays as it was
    expect(dd(render(<RankHeroCard plain />, { input: { rank: settled(ranked) } }))).toEqual(["900개"]);
  });

  it("favorability: the hero has no counts on Global (the 감정 분포 card shows them); Project keeps them", () => {
    const measured = { ...favorHero, positivePct: 54.1, negativePct: 1.9, positive: 175995, total: 325173, degraded: false };
    const project = render(<FavorHeroCard />, { input: { favorHero: settled(measured) } });
    expect(dd(project)).toEqual(["175,995", "325,173"]);
    const global = render(<FavorHeroCard />, { input: { favorHero: settled(measured), global: true }, tables: ["fav-trend"] });
    expect(dd(global)).toEqual([]);
    expect(global).toContain(ko.renewal.mention.favor.chipSignal);
    expect(cells(global)).toContainEqual([ko.renewal.mention.favor.posCount, "169,090", "175,995"]);
  });

  it("the section heads carry no '{KPI} 기준' chip on Global; Project keeps it", () => {
    const chip = (global: boolean) => render(<KpiBasisChip />, { input: { global } });
    expect(chip(false)).toContain("AI 노출률 기준");
    expect(chip(true)).toBe("");
  });

  it("first position: the table has no 당사 대비 column on Global, and 당사's row names its place and top %", () => {
    const head = `>${ko.renewal.mention.rank.colGap}<`;
    const project = render(<RankBody />, { input: { rank: settled(ranked) } });
    expect(project).toContain(head);
    expect(project).toContain(">+1.3<");
    expect(project).not.toContain("표 11개 브랜드 중 1위");
    const global = render(<RankBody />, { input: { rank: settled(ranked), global: true } });
    expect(global).not.toContain(head);
    expect(global).not.toContain(">+1.3<");
    expect(global).toContain('title="HMG · 표 11개 브랜드 중 1위 · 상위 9%"');
    // the ⓘ keeps the denominator (decision 2026-11-02) and says where the gap went
    expect(global).toContain("아래 표 11개 브랜드 중 당사 자리입니다");
    expect(global).toContain(ko.renewal.mention.rank.tableInfoGlobal);
  });

  // one view per tab on Global: the share tab compares brands (shares within a type), the exposure tab shows 당사 (지표
  // 정리 took the share tab's 당사 view; the exposure tab's compare view and the 유형 구성 % tooltip went the same day)
  it("the type card has one view per tab on Global: compare on the share tab, 당사 on the exposure tab; Project has both", () => {
    const two = {
      ...rateTypes,
      own: {
        exposure: rateTypes.own.exposure,
        sov: { rows: [{ type: "recommendation", pct: 1.8, signals: 9, spark: [], counts: [], delta: null, hasSpark: false }], maxPct: 1.8, maxCount: 9, x: [], answers: [] },
      },
    };
    const over = (global: boolean) => ({ input: { rateTypes: settled(two), global } });
    const ty = ko.renewal.mention.type;
    const views = (html: string) => [ty.viewCompare, ty.viewOwnExposure, ty.viewOwnSov].filter((v) => html.includes(`>${v}<`));
    expect(views(render(<Types metric="sov" />, over(false)))).toEqual([ty.viewCompare, ty.viewOwnSov]);
    expect(views(render(<Types metric="exposure" />, over(false)))).toEqual([ty.viewCompare, ty.viewOwnExposure]);
    const sov = render(<Types metric="sov" initialView="own" />, over(true));
    expect(views(sov)).toEqual([]);
    expect(sov).not.toContain(ty.footSov);
    expect(sov).not.toContain("data-rn-type=");
    const exposure = render(<Types metric="exposure" />, over(true));
    expect(views(exposure)).toEqual([]);
    expect(exposure).not.toContain(ty.footCompare);
    expect(exposure).toContain(ty.footExposure);
    expect(exposure).toContain('data-rn-type="recommendation"');
    expect(exposure).not.toContain("당사 유형 구성 1.8%");
  });
});
