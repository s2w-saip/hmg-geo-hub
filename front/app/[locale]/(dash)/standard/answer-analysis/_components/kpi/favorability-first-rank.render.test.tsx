import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type {
  EngineKpiTrend,
  FirstPositionResult,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import { FavorabilityKpiTab } from "./favorability-kpi-tab";
import { FirstRankKpiTab } from "./first-rank-kpi-tab";
import { FAVORABILITY_LINES } from "./favorability-trend-chart";

// PR ③ 탭 두 개의 렌더 스모크 — mention-kpi-tab.render.test 와 같은 취지(렌더 중
// throw · i18n 키 누락을 정적 검사로는 못 잡는다). 값은 프로미스가 아니라 **값**으로
// 넘겨 서스펜드 없이 동기 렌더한다(useAwaited 규약).

function engineRow(over: Partial<StandardSubKpis["rows"][number]>) {
  return {
    engine: "chatgpt", answers: 0, tracked: 0, multi: 0, top1: 0, top3: 0,
    avgPosition: null, totalMentions: 0, trackedMentions: 0, sentMentions: 0,
    positiveMentions: 0, negativeMentions: 0, citTotal: 0, citOwned: 0, ...over,
  };
}
const SUB: StandardSubKpis = {
  rows: [engineRow({ engine: "chatgpt", sentMentions: 1000, positiveMentions: 552, negativeMentions: 128 })],
  promptsWithoutBrand: null, measuredPrompts: null,
};
const PREV: StandardSubKpis = {
  rows: [engineRow({ engine: "chatgpt", sentMentions: 900, positiveMentions: 450, negativeMentions: 135 })],
  promptsWithoutBrand: null, measuredPrompts: null,
};
const point = (over: Record<string, number | null>) =>
  ({ engine: "chatgpt", answers: 0, trackedAnswers: 0, exposurePct: null, totalMentions: 0, trackedMentions: 0, sovPct: null,
     sentSignals: 0, positiveSignals: 0, negativeSignals: 0, ...over }) as EngineKpiTrend["latest"][number];
const TREND: EngineKpiTrend = {
  unit: "week", trendDegraded: false, windowStartBucket: "2026-07-06", windowEndBucket: "2026-07-20",
  engines: ["chatgpt"], latest: [], latestMeasuredAt: null, latestBrands: [], typeTrend: [],
  buckets: [
    { bucketStart: "2026-07-06", measuredDays: 7, firstAt: null, lastAt: null, engines: [point({ sentSignals: 100, positiveSignals: 50, negativeSignals: 10 })] },
    { bucketStart: "2026-07-20", measuredDays: 3, firstAt: null, lastAt: null, engines: [point({ sentSignals: 200, positiveSignals: 120, negativeSignals: 20 })] },
  ],
};
const TYPE: TypeKpi = {
  totalAnswers: 0, totalMentions: 0, ownMentions: 0, rows: [],
  sentimentMatrix: {
    own: [
      { type: "mention", rows: 0, positive: 8, neutral: 1, negative: 1, mixed: 0 },
      { type: "recommendation", rows: 0, positive: 2, neutral: 0, negative: 2, mixed: 0 },
    ],
    all: [],
  },
};
const FP: FirstPositionResult = {
  unit: "week", brands: ["Hyundai", "Tesla", "BMW"],
  buckets: [
    { bucketStart: "2026-07-06", measuredDays: 7, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 4, rankedAnswers: 10 },
      { brand: "Tesla", isTracked: false, avgPosition: 2, rankedAnswers: 5 },
      { brand: "BMW", isTracked: false, avgPosition: null, rankedAnswers: 0 },
    ] },
    { bucketStart: "2026-07-13", measuredDays: 5, firstAt: null, lastAt: null, brands: [
      { brand: "Hyundai", isTracked: true, avgPosition: 3, rankedAnswers: 30 },
      { brand: "Tesla", isTracked: false, avgPosition: 2.5, rankedAnswers: 5 },
      { brand: "BMW", isTracked: false, avgPosition: 9, rankedAnswers: 1 },
    ] },
  ],
  latest: [
    { brand: "Tesla", isTracked: false, avgPosition: 2.5, rank: 1, rankedAnswers: 5, mentions: 5 },
    { brand: "Hyundai", isTracked: true, avgPosition: 3, rank: 2, rankedAnswers: 30, mentions: 40 },
    { brand: "BMW", isTracked: false, avgPosition: null, rank: null, rankedAnswers: 0, mentions: 0 },
  ],
};

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}
const RAW_KEY = /answerAnalysis\.mentions\./;

describe("FavorabilityKpiTab", () => {
  it.each(["ko", "en"] as const)("renders hero · distribution · matrix without raw i18n keys (%s)", (locale) => {
    const html = render(
      <FavorabilityKpiTab
        subKpis={SUB} prevSubKpis={PREV} prevBasisDate="2026-08-31" engineTrend={TREND}
        sentimentTotals={{ positive: 552, neutral: 300, mixed: 20, negative: 128 }}
        stanceDist={{ positive: 40, neutral: 5, mixed: 30, negative: 25, pairs: 100 }}
        typeKpi={TYPE}
      />, locale);
    expect(html).not.toMatch(RAW_KEY);
    expect(html).toContain("55.2%"); // 긍정 비율
    expect(html).toContain("12.8%"); // 부정 비율
    expect(html).toContain('data-tone="positive"');
    expect(html).toContain('data-type-sentiment-track="all"');
    expect(html).toContain('data-type-sentiment-track="mention"');
    // 유형 행의 우측 숫자 = 긍정 비율(80.0% / 50.0%)
    expect(html).toContain("80.0%");
    expect(html).toContain("50.0%");
  });
  it("shows counts instead of shares when the toggle seam is on", () => {
    const html = render(
      <FavorabilityKpiTab subKpis={SUB} prevSubKpis={null} prevBasisDate={null} engineTrend={TREND}
        sentimentTotals={null} stanceDist={null} typeKpi={TYPE} initialCounts />);
    expect(html).toContain("10건"); // 전체 행 positive 8+2
    expect(html).toContain("비율로 보기");
  });
  it("degrades the trend slot only when the engine aggregate is null", () => {
    const html = render(
      <FavorabilityKpiTab subKpis={SUB} prevSubKpis={null} prevBasisDate={null} engineTrend={null}
        sentimentTotals={null} stanceDist={null} typeKpi={null} />);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.degraded);
    expect(html).toContain("55.2%"); // 스칼라는 살아 있다
  });
  // ── 답변 축 스탠스 카드 (0072 · WU8) ──────────────────────────────────────
  // 고정하는 것: ① 두 축이 **라벨로 구분**되어 한 화면에 나란히 있고 ② 스탠스가 없는
  // 회차에서 발생 축 값이 **그대로**이며 스탠스 자리는 "수집 대기"로 떨어지고
  // ③ 0건과 미수집이 다른 문구라는 것.
  it.each(["ko", "en"] as const)("두 축 라벨이 함께 렌더된다 (%s)", (locale) => {
    const msgs = locale === "ko" ? ko : en;
    const html = render(
      <FavorabilityKpiTab
        subKpis={SUB} prevSubKpis={null} prevBasisDate={null} engineTrend={TREND}
        sentimentTotals={{ positive: 552, neutral: 300, mixed: 20, negative: 128 }}
        stanceDist={{ positive: 40, neutral: 5, mixed: 30, negative: 25, pairs: 100 }}
        typeKpi={TYPE}
      />, locale);
    expect(html).not.toMatch(RAW_KEY);
    const axis = msgs.answerAnalysis.mentions.kpi.favorability.axis;
    expect(html).toContain(axis.occurrence);
    // 2026-09-18 스탠스 카드 비활성(STANCE_CARD_ENABLED=false): 답변 축 카드·라벨·
    // 구성비(40.0%)가 렌더되지 않아야 하고, 발생 축 값(55.2%)은 그대로다.
    expect(html).not.toContain(msgs.answerAnalysis.mentions.kpi.favorability.stance.title);
    expect(html).not.toContain("40.0%");
    expect(html).toContain("55.2%");
  });

  it("스탠스 축이 없으면 '수집 대기' — 발생 축 값은 변하지 않는다", () => {
    const html = render(
      <FavorabilityKpiTab
        subKpis={SUB} prevSubKpis={null} prevBasisDate={null} engineTrend={TREND}
        sentimentTotals={{ positive: 552, neutral: 300, mixed: 20, negative: 128 }}
        stanceDist={null} typeKpi={TYPE}
      />);
    // 카드 비활성 — 어떤 스탠스 문구도 렌더되지 않는다.
    expect(html).not.toContain(ko.answerAnalysis.mentions.kpi.favorability.stance.pendingNote);
    // 발생 축 히어로·분포는 종전 값 그대로 — 스탠스 부재가 기존 지표를 건드리지 않는다.
    expect(html).toContain("55.2%");
    expect(html).toContain("12.8%");
    // 발생 감성으로 스탠스 자리를 채우지 않는다(= 스탠스 카드에 "0건" 도 아니다).
    expect(html).not.toContain(ko.answerAnalysis.mentions.kpi.favorability.stance.empty);
  });

  it("스탠스 축은 있는데 행이 0 이면 '수집 대기' 가 아니라 '0건' 문구다", () => {
    const html = render(
      <FavorabilityKpiTab
        subKpis={SUB} prevSubKpis={null} prevBasisDate={null} engineTrend={TREND}
        sentimentTotals={null}
        stanceDist={{ positive: 0, neutral: 0, mixed: 0, negative: 0, pairs: 0 }}
        typeKpi={TYPE}
      />);
    // 카드 비활성 — 0건 문구도 렌더되지 않는다.
    expect(html).not.toContain(ko.answerAnalysis.mentions.kpi.favorability.stance.empty);
    expect(html).not.toContain(ko.answerAnalysis.mentions.kpi.favorability.stance.pendingNote);
  });

  it("draws the positive line green and never connects nulls", () => {
    expect(FAVORABILITY_LINES[0]).toMatchObject({ dataKey: "positivePct", stroke: "var(--color-sentiment-positive-ink)", connectNulls: false });
    expect(FAVORABILITY_LINES[1]).toMatchObject({ dataKey: "negativePct", connectNulls: false });
  });
});

describe("FirstRankKpiTab", () => {
  it.each(["ko", "en"] as const)("renders hero · table without raw i18n keys (%s)", (locale) => {
    const html = render(<FirstRankKpiTab firstPosition={FP} />, locale);
    expect(html).not.toMatch(RAW_KEY);
    expect(html).toContain("3.0"); // 당사 평균 순위
    expect(html).toContain("Tesla");
    // 순위 없는 브랜드는 0 이 아니라 "측정 없음"
    expect(html).toContain(locale === "ko" ? "측정 없음" : "No data");
    expect(html).not.toContain(">0.0<");
  });
  it("opens the ladder when the seam is on and marks #1 at the top", () => {
    const html = render(<FirstRankKpiTab firstPosition={FP} initialLadder />);
    expect(html).toContain("data-rank-ladder");
    expect(html).toContain("calc(0% - 2px)"); // Tesla = 1위 → 0% (마커 3.5px 의 절반 보정)
    expect(html).toContain("상위 67%"); // Hyundai 2/3
  });
  it("narrows the table to own + picked competitor", () => {
    const html = render(<FirstRankKpiTab firstPosition={FP} initialCompetitor="BMW" />);
    expect(html).toContain("BMW");
    expect(html).toContain("Hyundai");
    // Tesla 행은 표에서 사라진다(히어로 미니 카드에는 남을 수 있어 tbody 만 본다)
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(tbody).not.toContain("Tesla");
  });
  it("shows the degrade notice for a null aggregate instead of zeros", () => {
    const html = render(<FirstRankKpiTab firstPosition={null} />);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.degraded);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.firstRank.table.empty);
  });
});

// P5 leftover (B034 pattern of mention-kpi-tab): a hero read that failed for a moment says so with
// the existing kpi.degraded line under the hero, instead of reading as "no measurement". The flag
// is the page's request-scope mark (wasKpiTabDegraded), handed in as a value or a promise.
describe("hero degraded line (favorability / first rank)", () => {
  const degraded = ko.answerAnalysis.mentions.kpi.degraded;
  const heroCaption = `<p class="-mt-4 text-[11px] text-muted-foreground">${degraded}</p>`;
  const count = (html: string, s: string) => html.split(s).length - 1;
  const fav = (extra: { heroDegraded?: boolean; subKpis?: StandardSubKpis }) => (
    <FavorabilityKpiTab
      subKpis={extra.subKpis ?? SUB} prevSubKpis={PREV} prevBasisDate="2026-08-31" engineTrend={TREND}
      sentimentTotals={{ positive: 552, neutral: 300, mixed: 20, negative: 128 }}
      stanceDist={null} typeKpi={TYPE}
      {...("heroDegraded" in extra ? { heroDegraded: extra.heroDegraded } : {})}
    />
  );

  it("not passed or false: markup is byte-equal to before (no line)", () => {
    expect(render(fav({ heroDegraded: false }))).toBe(render(fav({})));
    expect(render(fav({}))).not.toContain(heroCaption);
    expect(render(<FirstRankKpiTab firstPosition={FP} heroDegraded={false} />)).toBe(render(<FirstRankKpiTab firstPosition={FP} />));
    expect(render(<FirstRankKpiTab firstPosition={FP} />)).not.toContain(heroCaption);
  });

  it("favorability: the empty ratio cards ('—') get the existing degraded line right after the hero", () => {
    const empty: StandardSubKpis = { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
    const html = render(fav({ subKpis: empty, heroDegraded: true }));
    expect(count(html, heroCaption)).toBe(1);
    // the line sits between the hero box and the first section below it (the distribution card)
    expect(html.indexOf(heroCaption)).toBeGreaterThan(html.indexOf('data-tone="negative"'));
    expect(html.indexOf(heroCaption)).toBeLessThan(html.indexOf('data-type-sentiment-track="all"'));
    // values are untouched when the flag is on with real values
    expect(render(fav({ heroDegraded: true }))).toContain("55.2%");
  });

  it("first rank: the line under the hero, before the Δ basis caption; once only when the whole source failed", () => {
    const html = render(<FirstRankKpiTab firstPosition={FP} heroDegraded />);
    expect(count(html, heroCaption)).toBe(1);
    expect(html.indexOf(heroCaption)).toBeLessThan(html.indexOf(ko.answerAnalysis.mentions.kpi.firstRank.deltaBasis));
    expect(html.replace(heroCaption, "")).toBe(render(<FirstRankKpiTab firstPosition={FP} />));
    // fp null: the chart slot already says degraded; the hero line is not repeated
    expect(render(<FirstRankKpiTab firstPosition={null} heroDegraded />)).toBe(render(<FirstRankKpiTab firstPosition={null} />));
  });
});
