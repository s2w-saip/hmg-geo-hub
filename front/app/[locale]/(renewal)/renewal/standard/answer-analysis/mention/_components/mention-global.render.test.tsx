import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnFavorHeroVM, RnPresenceSplitVM, RnRankVM, RnRateHeroVM, RnRateValueVM, RnShellVM } from "../_data/screen-types";

// The Global Mention 당사 지표 tab (2026-11-05 개편, docs/handoff/global-mention-redesign.md): the four KPI trend cards
// with the BFF's values, where 당사 stands by each KPI (the board's / rank table's / drawer brands' place), and the
// brand-presence split — which steps aside once the page's filter already picks a presence.

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { serviceWeekContext } = await import("@/components/service-week/provider");
const { RnMentionBody } = await import("./mention-body");
const { RnMentionPageProvider } = await import("./mention-tabs");
const ServiceWeek = serviceWeekContext();

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const pending = <T,>(): Promise<T> => new Promise<T>(() => {});
const AXIS = ["2026-09-28", "2026-10-05"];
const DELTA = { value: 1.2, basis: { kind: "round", prev: "2026-09-28" } };

const rateMetric = (pct: number, standing: { rank: number; n: number } | null) => ({
  delta: DELTA,
  standing: standing && { ...standing, other: null, gap: null },
  trend: { missing: false, x: AXIS, own: [pct - 1, pct], average: null, averageGaps: null, ownNum: [100, 110], ownDen: [200, 200], competitors: [], values: [], gaps: [] },
  board: { rows: [], axis: AXIS, measuredCycles: 2, barMax: pct },
});
const rateHero = { exposure: rateMetric(76.6, { rank: 1, n: 21 }), sov: rateMetric(18.4, { rank: 2, n: 21 }) } as unknown as RnRateHeroVM;
const rateValue: RnRateValueVM = { exposure: { pct: 76.6, numerator: 34452, denominator: 44979 }, sov: { pct: 18.4, numerator: 60000, denominator: 326000 }, degraded: false };
const favorHero = {
  positivePct: 54.1,
  negativePct: 1.9,
  positive: 175995,
  total: 325173,
  positiveDelta: DELTA,
  negativeDelta: { value: 0.3, basis: DELTA.basis },
  mixedBasis: false,
  points: AXIS.map((key, i) => ({ key, positive: 52 + i, negative: 1.6, positiveCount: 169090, total: 325173, gap: false })),
  trendMissing: false,
  degraded: false,
} as unknown as RnFavorHeroVM;
const rank = {
  fp: true,
  degraded: false,
  hero: { avgPosition: 2.4, rankedAnswers: 9000, delta: { value: -0.1, basis: DELTA.basis }, series: [2.5, 2.4], rankedSeries: [8800, 9000], axis: AXIS },
  ahead: null,
  standing: { rank: 3, total: 40, topPct: 7.5 },
  rows: [],
  ownFirst: [],
  barMax: 1,
  track: null,
  covered: [],
  series: [],
  hasValue: [],
  gaps: [],
} as unknown as RnRankVM;
const presence = (applied: boolean): RnPresenceSplitVM =>
  applied
    ? { applied: true, presences: {} }
    : {
        applied: false,
        presences: {
          unbranded: { own: { exposure: 58.7, answers: 1200, sov: 9.1, favorability: 50.2, firstRank: 3.1 }, brands: { BMW: { exposure: 61.2, sov: 9.8, firstRank: 2.9 } } },
          branded: { own: { exposure: 91.0, answers: 2400, sov: 30.5, favorability: 57.9, firstRank: 1.8 }, brands: {} },
        },
      };
const SHELL = { measured: true, degraded: false, ownBrands: ["Hyundai", "Kia", "Genesis"], ownSum: [], drawer: [], favStanding: { rank: 79, n: 98 } } as unknown as RnShellVM;

function render({ shell = SHELL, applied = false, degraded = false }: { shell?: RnShellVM; applied?: boolean; degraded?: boolean } = {}) {
  nav.search = "";
  const reads = Object.fromEntries(["tabDeltas", "summary", "rateTypes", "rateEngines", "favorDist", "favorMatrix", "bump", "ranking", "engineExtra"].map((k) => [k, pending()]));
  const tabValue = Object.fromEntries(["exposure", "sov", "favorability", "first-rank"].map((k) => [k, pending()]));
  const input = {
    kpi: "exposure",
    view: "brands",
    ownLabel: "HMG",
    period: null,
    filtered: false,
    brandsFirst: true,
    global: true,
    shell: settled(shell),
    // the first covered brand is the auto pick
    compare: settled({ covered: ["BMW"] }),
    tabValue,
    ...reads,
    rateValue: settled({ ...rateValue, degraded }),
    rateHero: settled(rateHero),
    favorHero: settled(favorHero),
    rank: settled(rank),
    presence: settled(presence(applied)),
  } as never;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <ServiceWeek.Provider value={null}>
        <RnFilterRuntime>
          <RnOverviewFilters props={{ stage: "mention", scope: { all: true } }} savedFilters={{ page: "mention", userId: "test", initial: [] }}>
            <RnMentionPageProvider input={input}>
              <RnMentionBody />
            </RnMentionPageProvider>
          </RnOverviewFilters>
        </RnFilterRuntime>
      </ServiceWeek.Provider>
    </NextIntlClientProvider>,
  );
}

const cardOf = (html: string, kpi: string) => {
  const at = html.indexOf(`data-rn-gcard="${kpi}"`);
  const next = html.indexOf('data-rn-gcard="', at + 1);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("Global Mention 당사 지표: the four KPI trend cards", () => {
  it("exposure · share · favorability · first-rank, in that order, each with its BFF value", () => {
    const html = render();
    const order = ["exposure", "sov", "favorability", "first-rank"].map((k) => html.indexOf(`data-rn-gcard="${k}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(cardOf(html, "exposure")).toMatch(/data-rn-gvalue=""[^>]*>76\.6<small/);
    expect(cardOf(html, "sov")).toMatch(/data-rn-gvalue=""[^>]*>18\.4<small/);
    expect(cardOf(html, "favorability")).toMatch(/data-rn-gvalue=""[^>]*>54\.1<small/);
    expect(cardOf(html, "first-rank")).toMatch(/data-rn-gvalue=""[^>]*>2\.4<small/);
  });

  it("where 당사 stands: the board's place for exposure and share, the rank table's for first-rank, the drawer brands' for favorability", () => {
    const html = render();
    const standing = (kpi: string) => cardOf(html, kpi).match(/data-rn-standing="[^"]+"[^>]*>(.*?)<\/span>/)?.[1];
    expect(standing("exposure")).toBe("21개 브랜드 중 1위");
    expect(standing("sov")).toBe("21개 브랜드 중 2위");
    expect(standing("first-rank")).toBe("40개 브랜드 중 3위");
    expect(standing("favorability")).toBe("98개 브랜드 중 79위");
  });

  it("an unmeasured favorability standing shows no chip (no place is made up)", () => {
    const html = render({ shell: { ...SHELL, favStanding: null } as unknown as RnShellVM });
    expect(cardOf(html, "favorability")).not.toContain("data-rn-standing");
    expect(cardOf(html, "exposure")).toContain("data-rn-standing");
  });
});

describe("Global Mention 당사 지표: what the original KPI tabs said stays on the cards", () => {
  const Q = ko.dashboard.kpi.question;
  it("each card's ⓘ asks the original tab's question; favorability and first-rank keep their trend notes", () => {
    const html = render();
    expect(cardOf(html, "exposure")).toContain(Q.coverage);
    expect(cardOf(html, "sov")).toContain(Q.density);
    expect(cardOf(html, "favorability")).toContain(Q.favorability);
    expect(cardOf(html, "first-rank")).toContain(Q.priority);
    expect(cardOf(html, "favorability")).toContain(ko.answerAnalysis.mentions.kpi.favorability.trendNote);
    expect(cardOf(html, "favorability")).toContain(ko.renewal.mention.favor.chipSignal);
    expect(cardOf(html, "first-rank")).toContain(ko.answerAnalysis.mentions.kpi.firstRank.chartNote);
  });

  it("a failed read says so under its value", () => {
    const note = ko.renewal.mention.degraded.all.slice(0, 12);
    expect(cardOf(render(), "exposure")).not.toContain(note);
    expect(cardOf(render({ degraded: true }), "exposure")).toContain(note);
    expect(cardOf(render({ degraded: true }), "favorability")).not.toContain(note);
  });
});

describe("Global Mention 당사 지표: the brand-presence split", () => {
  it("each card shows 당사 under 브랜드 미포함 · 포함 questions, with the filter shortcut", () => {
    const html = render();
    for (const k of ["exposure", "sov", "favorability", "first-rank"]) expect(cardOf(html, k)).toContain(`data-rn-presence="${k}"`);
    expect(cardOf(html, "exposure")).toContain("HMG 58.7%");
    expect(cardOf(html, "exposure")).toContain("HMG 91.0%");
    // beside 당사: the first compare brand under the unbranded read; favorability has no rival values
    expect(cardOf(html, "exposure")).toContain(" · BMW 61.2%");
    expect(cardOf(html, "first-rank")).toContain("HMG 3.1번째");
    expect(cardOf(html, "first-rank")).toContain("BMW 2.9번째");
    expect(cardOf(html, "favorability")).not.toContain("BMW");
    expect(cardOf(html, "exposure")).toContain("미포함 질문만 보기");
  });

  it("steps aside when the page's filter already picks a presence", () => {
    const html = render({ applied: true });
    expect(html).toContain('data-rn-gcard="exposure"');
    expect(html).not.toContain("data-rn-presence");
  });
});
