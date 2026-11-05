import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";
import { FEEDBACK_EMAIL_TEXT } from "@/lib/support-contact";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Citation body — static render of the states the local api demo cannot show
// ════════════════════════════════════════════════════════════════════════════
// Every read is a settled promise (React's use() reads it synchronously), so the whole body
// renders in one pass. The renewal model comes precomputed from the screen (rn); the fixture builds
// it with the same rules from the parts below and the page URL (citation-rn.fixture.ts): prompt tiles with counts and links, the legacy "not computed" reason under
// a 출처 filter, a competitor pick, one picked 출처 (counts in the matrix), the empty / delayed states.

let SEARCH = "";
let PATH = "/ko/renewal/standard/answer-analysis/citation";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => PATH,
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnCitationBody } = await import("./citation-body");
const { rnVmFor } = await import("./citation-rn.fixture");
const { serviceWeekContext } = await import("@/components/service-week/provider");
type Input = import("./citation-input").RnCitationInput;
const ServiceWeek = serviceWeekContext();
// the shell's service week (components/service-week/provider.tsx), null = a page rendered on its own
let WEEK: import("@/components/service-week/provider").ServiceWeekContextValue | null = null;

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const HMG = "Official (HMG)";
const COMP = "Official (Competitor)";
const AUTO = "Automotive Media";
const NEWS = "News & Media";
const dom = (domain: string, category: string, citations: number, isOurs = false): CitationDomainLive => ({
  domain,
  category,
  citations,
  share: citations / 10,
  prompts: Math.round(citations / 9),
  coverageRate: citations / 20,
  urls: [{ url: `https://${domain}/a`, title: domain, count: 3, aiProvider: "chatgpt", promptText: "best SUV" }],
  promptList: [],
  isOurs,
  subcategory: null,
});
const weeks = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const live = (over: Partial<CitationsLive> = {}): CitationsLive => ({
  summary: { total: 1000, uniqueDomains: 9 },
  asOf: "2026-10-12T09:00:00.000Z",
  domains: [dom("caranddriver.com", AUTO, 200), dom("hyundai.com", HMG, 150, true), dom("motortrend.com", AUTO, 100), dom("toyota.com", COMP, 80), dom("reuters.com", NEWS, 60), dom("kia.com", HMG, 50, true), dom("tesla.com", COMP, 40)],
  categories: [
    { name: AUTO, value: 400 },
    { name: HMG, value: 250 },
    { name: COMP, value: 150 },
    { name: NEWS, value: 200 },
  ],
  trend: { series: ["caranddriver.com", "hyundai.com", "motortrend.com", "toyota.com"], points: weeks.map((week, i) => ({ week, "caranddriver.com": 50 + i, "hyundai.com": 30 + i * 6, "motortrend.com": 45 - i * 4, "toyota.com": 20 + i })) },
  categoryTrend: { series: [AUTO, NEWS, HMG, COMP], points: weeks.map((week, i) => ({ week, [AUTO]: 100 + i, [NEWS]: 50, [HMG]: 60 + i * 2, [COMP]: 40 })) },
  engineCategories: [
    { engine: "chatgpt", total: 400, byCategory: { [AUTO]: 200, [HMG]: 60, [COMP]: 60, [NEWS]: 80 } },
    { engine: "gemini", total: 600, byCategory: { [AUTO]: 200, [HMG]: 190, [COMP]: 90, [NEWS]: 120 } },
  ],
  promptSplit: { owned: [], uncited: [], ownedCount: 57, uncitedCount: 39 },
  ...over,
});
const parts = (over: Partial<Parts> = {}, liveOver: Partial<CitationsLive> = {}): Parts => ({
  api: false,
  filtered: false,
  data: live(liveOver),
  dataDegraded: false,
  officialDelta: { delta: -1.4, basisDate: "2026-10-05" },
  prevCategories: { totals: { total: 1000, byCategory: { [AUTO]: 380, [HMG]: 270, [COMP]: 150, [NEWS]: 200 } }, asOf: "2026-10-05" },
  typeCategories: [
    { type: "mention", total: 500, byCategory: { [AUTO]: 200, [HMG]: 150, [NEWS]: 150 } },
    { type: "recommendation", total: 200, byCategory: { [AUTO]: 120, [HMG]: 30, [NEWS]: 50 } },
  ],
  ...over,
});
type Parts = {
  api: boolean;
  filtered: boolean;
  data: CitationsLive | null;
  dataDegraded: boolean;
  officialDelta: { delta: number; basisDate: string } | null;
  prevCategories: { totals: { total: number; byCategory: Record<string, number> }; asOf: string };
  typeCategories: import("@/lib/db/repositories/scope-aggregates").CitationTypeCategoryRow[] | null;
};
const input = parts;
// The standard body renders the Global page (`global`, 2026-11-05 지표 정리) unless `asProject` runs it as the Project
// page, which keeps the layout the Global page had (the same body without `website` or `global`)
let PROJECT = false;
// the calendar month's line (`periodView`, null = no month picked)
let PERIOD_VIEW: import("@/lib/kpi/period-compare-view").PeriodDeltaView | null = null;
const asProject = <T,>(fn: () => T): T => {
  PROJECT = true;
  try {
    return fn();
  } finally {
    PROJECT = false;
  }
};
// `website`: the website page's parts; its tests reuse the frozen model of the bare URL (`rnSearch`) and parts (`rnBase`)
type Vm = import("./citation-input").RnCitationVm;
const render = (p: Parts, search = "", website?: Input["website"], rnSearch = website ? "" : search, rnBase: Parts = p, rnEdit?: (vm: Vm) => Vm) => {
  SEARCH = search;
  PATH = website ? "/ko/renewal/website/answer-analysis/citation" : PROJECT ? "/ko/renewal/projects/p1/analysis/citation" : "/ko/renewal/standard/answer-analysis/citation";
  const i: Input = {
    api: p.api,
    period: null,
    filtered: p.filtered,
    data: settled(p.data),
    dataDegraded: settled(p.dataDegraded),
    sectionDegraded: settled(null),
    prevCategories: settled(p.prevCategories),
    toneSummary: settled({ positive: { urls: 120, citations: 300, answers: 90 }, negative: { urls: 12, citations: 20, answers: 8 } }),
    tableSource: settled(null),
    periodView: settled(PERIOD_VIEW),
    rn: settled(((vm) => (vm && rnEdit ? rnEdit(vm) : vm))(rnVmFor({ live: rnBase.data, prev: rnBase.prevCategories, card: rnBase.officialDelta, typeRows: rnBase.typeCategories, sections: null, search: rnSearch }))),
    website,
    ...(website || PROJECT ? {} : { global: true }),
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "citation", scope: { all: true } }} savedFilters={{ page: "citation", userId: "test", initial: [] }}>
          <ServiceWeek.Provider value={WEEK}>{(<RnCitationBody input={i} />) as ReactNode}</ServiceWeek.Provider>
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
};
const T = ko.renewal.citation;

describe("renewal Citation body", () => {
  it("prompt tiles: counts, share of all and links to the sub page with the filters (Project)", () => {
    const html = asProject(() => render(input(), "geography=US"));
    expect(html).toContain('href="/ko/renewal/projects/p1/analysis/citation/prompts?geography=US&amp;tab=owned"');
    expect(html).toContain('href="/ko/renewal/projects/p1/analysis/citation/prompts?geography=US&amp;tab=uncited"');
    expect(html).toMatch(/57<small[^>]*>개<\/small><\/span><span[^>]*>59%/); /* i18n-ignore */
    expect(html).toContain("41%");
  });
  it("findings include the uncited-prompt opportunity; the headline carries the split (Project)", () => {
    const html = asProject(() => render(input()));
    expect(html).toContain("공식(당사) URL이 한 번도 인용되지 않은 프롬프트 39개 (41%)");
    expect(html).toContain("공식(당사) URL 인용 프롬프트 57개 / 미인용 39개");
  });
  it("legacy + 출처 filter: the split is not computed — the tiles say so", () => {
    const html = render(input({ data: live({ promptSplit: undefined }) }), `source=${encodeURIComponent(HMG)}`);
    expect(html).toContain(T.lens.split.notComputed);
    expect(html).not.toContain(T.lens.split.noOwnCategory);
  });
  it("출처 filter without 공식(HMG): the HMG tile and the prompt tiles explain why", () => {
    // the page reads that source only: its trend holds that series alone, a 100% share every round
    const base = input({ data: live({ categories: [{ name: AUTO, value: 400 }], promptSplit: undefined }) });
    const only = { series: [AUTO], points: weeks.map((week, i) => ({ week, [AUTO]: 100 + i })) };
    const html = render({ ...base, data: { ...base.data!, categoryTrend: only } }, `source=${encodeURIComponent(AUTO)}`, undefined, `source=${encodeURIComponent(AUTO)}`, base, (vm) => ({
      ...vm,
      rows: vm.rows.map((r) => ({ ...r, trend: weeks.map(() => 100) })),
    }));
    expect(html).not.toContain('points="3.0,18.0 41.0,18.0 79.0,18.0 117.0,18.0"');
    expect(html).toContain(T.lens.hmg.excluded);
    expect(html).toContain(T.lens.split.noOwnCategory);
    expect(html).toContain(T.matrix.oneSource);
  });
  it("a competitor pick: the 공식(경쟁사) row shows the picked domains, no Δ, and the scope note", () => {
    const html = render(input(), "competitor=toyota.com");
    const row = html.slice(html.indexOf(`data-rn-src="${COMP}"`), html.indexOf("</button>", html.indexOf(`data-rn-src="${COMP}"`)));
    expect(row).toContain(">80<");
    expect(row).not.toContain("pp");
    expect(html).toContain(ko.answerAnalysis.citations.v2.competitor.scopeNote);
  });
  it("matrix: engine columns, every cell coloured; composition rows with the previous-round tick", () => {
    const html = render(input());
    expect((html.match(/data-rn-cell="/g) ?? []).length).toBe(8);
    expect((html.match(/data-rn-cell="[^"]*"[^>]*style="background:rgb/g) ?? []).length).toBe(8);
    expect((html.match(/data-rn-src="/g) ?? []).length).toBe(4);
    expect(html).toContain(T.comp.chipDelta.replace("{date}", "2026-10-05"));
  });
  it("matrix: a column without citations reads '—' and is not coloured; no type with citations says so (renewal audit 9-1)", () => {
    const blank = <T,>(m: { rows: string[] }, v: T) => Object.fromEntries(m.rows.map((k) => [k, v]));
    const html = render(input(), "", undefined, "", input(), (vm) => {
      const m = vm.engineMatrix.m!;
      const zero = { key: "perplexity", n: 0, shares: blank(m, null), counts: blank(m, 0) };
      return { ...vm, engineMatrix: { status: "ok", m: { ...m, cols: [...m.cols, zero], gaps: { ...m.gaps, perplexity: blank(m, null) } } } };
    });
    const cells = [...html.matchAll(/data-rn-cell="perplexity\|[^"]*"([^>]*)>([^<]*)</g)];
    expect(cells.length).toBe(4);
    expect(cells.every(([, attrs, text]) => text === "—" && !attrs.includes("background"))).toBe(true);
    expect((html.match(/data-rn-cell="[^"]*"[^>]*style="background:rgb/g) ?? []).length).toBe(8);
    const empty = render(input(), "", undefined, "", input(), (vm) => ({ ...vm, engineMatrix: { status: "empty", m: null } as unknown as Vm["engineMatrix"] }));
    expect(empty).toContain(ko.answerAnalysis.citations.v2.typeCategory.empty);
    expect(empty).not.toContain("data-rn-matrix=");
  });
  it("출처 구성: Δ bars on one axis (largest change), direction only, no tick (Project)", () => {
    const html = asProject(() => render(input()));
    const row = (name: string) => {
      const at = html.indexOf(`data-rn-src="${name.replace(/&/g, "&amp;")}"`);
      return at < 0 ? "" : html.slice(at, html.indexOf("</button>", at));
    };
    // 자동차 미디어 38% → 40% = +2.0pp is the largest change → the axis is ±2
    expect(html).toMatch(/data-rn-daxis="">.*?−2.*?\+2/);
    expect(row(AUTO)).toContain('data-rn-dbar="up"');
    expect(row(AUTO)).toMatch(/width:50%/);
    expect(row(HMG)).toContain('data-rn-dbar="down"');
    expect(row(HMG)).toMatch(/width:35%/);
    expect(row(NEWS)).toContain('data-rn-dbar="flat"');
    expect(html).not.toContain("-translate-x-1/2 rounded-[1px] bg-rn-ink");
  });
  it("no data: empty, filtered and delayed states", () => {
    expect(render(input({ data: null }))).toContain(ko.answerAnalysis.empty);
    expect(render(input({ data: null, filtered: true }))).toContain(T.states.noResultTitle);
    // a failed read says it could not load (the shared copy said every failure "timed out")
    expect(render(input({ data: null, dataDegraded: true }))).toContain(ko.renewal.mention.degraded.all.replace("{contact}", FEEDBACK_EMAIL_TEXT));
  });
  it("a snapshot of a surface the service week holds no round of: 측정 없음 and the week, not zeros or the filter advice", () => {
    // review r1-19 (2026-11-03): under the week of 07-27 (no Website round on live Gold) citation/website answered
    // live {total 0, asOf null} — no round read — and the page drew 인용 0건 with its Δ chips
    const none = live({ summary: { total: 0, uniqueDomains: 0 }, asOf: null, domains: [], categories: null, trend: null, categoryTrend: null, engineCategories: null, promptSplit: null });
    const at = (website: boolean, search: string, p: Parts = input({ data: none })) => {
      const view = { state: "ok" as const, week: { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 }, delay: null, checkedAt: null, recordedAt: null, rounds: { global: true, website }, notes: [] };
      WEEK = { initial: settled(view), latest: view, applies: true, surface: "website", sites: "", notesFor: "" };
      try {
        return render(p, search, site(), "", input());
      } finally {
        WEEK = null;
      }
    };
    for (const search of ["", "engine=chatgpt"]) {
      const html = at(false, search);
      expect(html, search).toContain("측정 없음");
      expect(html, search).toContain("서비스 기준 주 7월 5주차(7/27~8/2)에는 Website 측정 회차가 없습니다.");
      expect(html, search).not.toContain('data-rn-cmeta=""');
      expect(html, search).not.toContain(T.states.reset);
    }
    expect(at(false, "", input({ data: null, filtered: true }))).toContain("Website 측정 회차가 없습니다.");
    // a round of the surface in the week, or a period (it reads the rounds before the week): the page as before
    expect(at(true, "")).toContain('data-rn-cmeta=""');
    expect(at(false, "time=2026-07-01..2026-07-31")).toContain('data-rn-cmeta=""');
    expect(at(false, "time=2026-07-01..2026-07-31", input({ data: null, filtered: true }))).toContain(T.states.noResultTitle);
    // a failed read still says so
    expect(at(false, "", input({ data: null, dataDegraded: true }))).toContain(ko.renewal.mention.degraded.all.replace("{contact}", FEEDBACK_EMAIL_TEXT));
  });
  it("a period that starts after the service week: the week names it, not zeros under a source-filter headline (review r3-12)", () => {
    // review r3-12 (2026-11-03): time=2026-10-12..2026-10-18 under the week of 10-05 read no round (the BFF's cap), and
    // Global Citation drew '공식(HMG) 카테고리가 출처 필터에서 빠져 있습니다 — 인용 0회' over '—' tiles
    const none = live({ summary: { total: 0, uniqueDomains: 0 }, asOf: null, domains: [], categories: null, trend: null, categoryTrend: null, engineCategories: null, promptSplit: null });
    const view = { state: "ok" as const, week: { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 }, delay: null, checkedAt: null, recordedAt: null, rounds: { global: true, website: true }, notes: [] };
    // the frozen model of the bare URL, with the 공식(HMG) share of a read of no citations (none: the headline above)
    const noHmg = (vm: Vm): Vm => ({ ...vm, lens: { ...vm.lens, hmg: { ...vm.lens.hmg, value: null } } });
    const at = (website: boolean, search: string, p: Parts = input({ data: none })) => {
      WEEK = { initial: settled(view), latest: view, applies: true, surface: website ? "website" : "global", sites: "", notesFor: "" };
      try {
        return website ? render(p, search, site(), "", input()) : render(p, search, undefined, "", input(), noHmg);
      } finally {
        WEEK = null;
      }
    };
    const headlineNoHmg = T.summary.headlineNoHmg.split(" — ")[0];
    // the measured page: the Website's chip row, the Global KPI card (2026-11-05: the chip row's totals moved to the
    // domain table, the HMG cell says why it has no value)
    const measured = (website: boolean) => (website ? 'data-rn-cmeta=""' : 'data-rn-kpis=""');
    for (const website of [false, true]) {
      for (const p of [input({ data: none }), input({ data: null, filtered: true })]) {
        const html = at(website, "time=2026-08-03..2026-08-09", p);
        expect(html, String(website)).toContain("아직 보이지 않는 기간");
        expect(html, String(website)).toContain("고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다.");
        expect(html, String(website)).not.toContain(headlineNoHmg);
        expect(html, String(website)).not.toContain(T.lens.hmg.excluded);
        expect(html, String(website)).not.toContain(measured(website));
        expect(html, String(website)).not.toContain(T.states.noResultTitle);
      }
    }
    // a period that reaches into the week reads its rounds: the page as before (the model draws the headline the review
    // saw on the Project page; the Global KPI card's HMG cell says the same)
    expect(asProject(() => at(false, "time=2026-07-27..2026-08-09"))).toContain(headlineNoHmg);
    expect(at(false, "time=2026-07-27..2026-08-09")).toContain(T.lens.hmg.excluded);
    expect(at(false, "time=2026-07-27..2026-08-09")).toContain(measured(false));
    expect(at(true, "time=2026-07-27..2026-08-09")).toContain(measured(true));
    expect(at(false, "time=2026-07-27..2026-08-09", input({ data: null, filtered: true }))).toContain(T.states.noResultTitle);
  });
  it("tone tiles: api vs legacy basis chip", () => {
    expect(render(input())).toContain(T.tone.chipLegacy);
    expect(render(input({ api: true }))).toContain(T.tone.chipApi);
  });
});

// The website page (W3, 2026-10-30): the same body with the website parts — the screen's model is the frozen
// one above (its Δ basis does not matter here), the website part comes as citation/website sends it.
type Website = Awaited<NonNullable<Input["website"]>>;
type Reach = Extract<Website["reach"], { status: "ok" }>;
const REACH: Reach = {
  status: "ok",
  measured: 10021,
  owned: 8815,
  target: 6673,
  ownedRate: 88.0,
  targetRate: 66.6,
  prev: { measured: 9982, owned: 8826, target: 6509, ownedRate: 88.4, targetRate: 65.2 },
  delta: { ownedRate: -0.5, targetRate: 1.4, basis: "round", date: "2026-10-02" },
  engines: [
    { engine: "ChatGPT", measured: 10021, owned: 8016, target: 5333, ownedRate: 80.0, targetRate: 53.2 },
    { engine: "Gemini", measured: 10021, owned: 6825, target: 4349, ownedRate: 68.1, targetRate: 43.4 },
  ],
  enginesDegraded: false,
  source: "live",
};
const OWN: NonNullable<Website["own"]> = { value: 24.9, delta: { value: -3.6, basis: "card", date: "2026-10-02" }, spark: [28.5, 28.5, 24.9], sparkOn: true };
const site = (over: Partial<Website> = {}) => settled<Website>({ own: OWN, reach: REACH, ...over });
const W = ko.renewal.website.citation;
const tile = (html: string, kind: string) => {
  const at = html.indexOf(`data-rn-tile="${kind}"`);
  const next = html.indexOf('data-rn-tile="', at + 10);
  return at < 0 ? "" : html.slice(at, next > 0 ? next : undefined);
};
const between = (html: string, from: string, to: string) => {
  const at = html.indexOf(from);
  return at < 0 ? "" : html.slice(at, html.indexOf(to, at + from.length));
};
const fill = (s: string, v: Record<string, string>) => Object.entries(v).reduce((o, [k, x]) => o.replace(`{${k}}`, x), s);

describe("renewal Citation body — website page", () => {
  it("sections per prompt first, then per citation", () => {
    const html = render(input(), "", site());
    const ids = [...html.matchAll(/id="(sec-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["sec-summary", "sec-reach", "sec-prompts", "sec-overview", "sec-comp", "sec-mix", "sec-dom"]);
  });
  it("headline: the URL funnel and the shares with their Δ", () => {
    const html = render(input(), "", site());
    const head = between(html, 'id="sec-summary"', "</p>");
    expect(head).toContain(`${W.summary.ownedUrl} <b>88.0%</b> (▼0.5pp)`);
    expect(head).toContain(`${W.summary.targetUrl} <b>66.6%</b> (▲1.4pp)`);
    expect(head).toContain(`${W.summary.own} <b>24.9%</b> (▼3.6pp)`);
  });
  it("reach: three steps on one denominator, the two drops, the Δ basis and the engines with 전체 first", () => {
    const html = render(input(), "", site());
    const reach = between(html, 'data-rn-reach=""', "</table>");
    expect(between(reach, 'data-rn-step="owned"', "</div>")).toMatch(/8,815.*88\.0%/);
    expect(between(reach, 'data-rn-step="target"', "</div>")).toMatch(/6,673.*66\.6%/);
    expect(reach).toContain(fill(W.reach.dropOwned, { n: "1,206" }));
    expect(reach).toContain(fill(W.reach.dropTarget, { n: "2,142" }));
    expect(between(reach, 'data-rn-step="owned"', ">")).toContain(fill(W.reach.tipPrev, { rate: "88.4%", n: "8,826", measured: "9,982" }));
    expect(html).toContain(fill(W.reach.chipDelta, { date: "2026-10-02" }));
    expect([...reach.matchAll(/data-rn-engine="([^"]+)"/g)].map((m) => m[1])).toEqual(["all", "ChatGPT", "Gemini"]);
    expect(between(reach, 'data-rn-engine="Gemini"', "</tr>")).toMatch(/68\.1%.*43\.4%/);
  });
  it("reach under a 출처 filter says why it is not computed", () => {
    const html = render(input(), `source=${encodeURIComponent(HMG)}`, site({ reach: { status: "notComputed" } }));
    expect(html).toContain(W.reach.notComputed);
    expect(html).not.toContain('data-rn-reach=""');
  });
  it("prompts: both buckets with counts, the top prompts and links to the website sub page", () => {
    const owned = [{ id: "p1", promptText: "best kia suv", funnelStage: null, citations: 203, providers: ["ChatGPT", "Gemini"], answers: [] }];
    const html = render(input({ data: live({ promptSplit: { owned, uncited: [], ownedCount: 57, uncitedCount: 39 } }) }), "geography=US", site(), "", input());
    const bucket = between(html, 'data-rn-bucket="owned"', 'data-rn-bucket="uncited"');
    expect(bucket).toContain("best kia suv");
    expect(bucket).toContain(fill(W.prompts.cites, { n: "203" }));
    expect(bucket).toContain('href="/ko/renewal/website/answer-analysis/citation/prompts?geography=US&amp;tab=owned"');
    expect(between(html, 'data-rn-bucket="uncited"', "</a>")).toContain(W.prompts.empty);
  });
  it("shares: 공식(HMG) · 공식(당사) · 딜러 and the original's totals (출처 분류 수 too)", () => {
    const html = render(input(), "", site());
    const order = [...html.matchAll(/data-rn-tile="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["hmg", "own", "dealer"]);
    expect(tile(html, "own")).toMatch(/24\.9<small[^>]*>%<\/small>/);
    expect(tile(html, "own")).toContain(T.delta.basisPrev.replace("{date}", "2026-10-02"));
    expect(html).not.toMatch(/data-rn-b="[^"]*" data-rn-tile="own"/);
    expect(html).toContain(fill(W.lens.categories, { n: "4" }));
  });
  it("the rank bump names the site's own domains 당사, as the table tag does; the standard page keeps 공식(HMG) (renewal audit 9-3)", () => {
    const bump = T.bump as Record<string, string>;
    const legend = (html: string) => between(html, 'data-rn-bumplg=""', "</span>");
    expect(legend(render(input(), "", site()))).toContain(bump.legendOwnWebsite);
    expect(bump.legendOwnWebsite).toBe("당사 도메인");
    expect(legend(render(input()))).toContain(T.bump.legendOwn);
  });
  // 2026-11-02 premise review: the page says what it splits; what is a strength or an opportunity is the reader's call
  it("the prompts page's description names no strengths or opportunities", () => {
    expect((T.sub as Record<string, string>).promptsDescription).toContain("나눠 봅니다");
    expect((T.sub as Record<string, string>).promptsDescription).not.toMatch(/강점|기회/);
  });
  // 2026-11-02 premise review: the movers are other domains; their climb or fall is not good or bad in itself
  it("the rank bump's movers tell their direction with no better/worse colour", () => {
    const html = render(input());
    const from = html.indexOf('data-rn-bumplg=""');
    const legend = html.slice(from, html.indexOf("</div>", from));
    expect(legend).toMatch(/[▲▼]/);
    expect(legend).not.toMatch(/text-rn-(up|danger)-ink/);
  });
  it("the standard pages keep their layout: the Global KPI card's three cells, the Project page's four tiles", () => {
    const tiles = (html: string) => [...html.matchAll(/data-rn-tile="([a-zA-Z]+)"/g)].map((m) => m[1]);
    const html = render(input());
    expect(tiles(html)).toEqual(["hmg", "dealer", "prompts"]);
    expect(html).not.toContain('id="sec-reach"');
    const project = asProject(() => render(input()));
    expect(tiles(project)).toEqual(["hmg", "dealer", "owned", "uncited"]);
    expect(project).not.toContain('id="sec-reach"');
  });
});

// 2026-11-05 Global 지표 정리 (user approved): the Global page says each number once. Removed what restated another
// card, merged what said one thing twice, and the navy card moved to the KPIs. Website and Project keep their layout;
// the restored original values (matrix cell citations) are on every page.
describe("renewal Citation body — Global 지표 정리 (2026-11-05)", () => {
  const hero = (html: string) => between(html, 'data-rn-kpis=""', "</section>");
  const heroes = (html: string) => (html.match(/data-rn-tone="hero"/g) ?? []).length;
  it("no 이번 회차 요약 on Global: one navy card, the KPI card; Website and Project keep the summary", () => {
    const html = render(input());
    expect(html).not.toContain('id="sec-summary"');
    expect(html).not.toContain(T.summary.title);
    expect(html).not.toContain("공식(당사) URL이 한 번도 인용되지 않은 프롬프트");
    expect(heroes(html)).toBe(1);
    expect(html).toMatch(/data-rn-tone="hero"[^>]*data-rn-kpis=""/);
    for (const other of [asProject(() => render(input())), render(input(), "", site())]) {
      expect(other).toContain('id="sec-summary"');
      expect(heroes(other)).toBe(1);
      expect(other).not.toContain('data-rn-kpis=""');
    }
  });
  it("the KPI card: the shares with their Δ and basis, no tile line; the chip row's basis on the card", () => {
    const html = render(input());
    const card = hero(html);
    expect(between(card, 'data-rn-tile="hmg"', 'data-rn-tile="dealer"')).toMatch(/25\.0<small[^>]*>%<\/small>/);
    expect(card).toContain(T.delta.basisPrev.replace("{date}", "2026-10-05"));
    expect(card).not.toContain('preserveAspectRatio="none"');
    expect(card).toContain(fill(T.lens.basisSnapshot, { date: "2026-10-12" }));
    // the Project page's tiles still draw the line
    expect(between(asProject(() => render(input())), 'data-rn-tile="hmg"', 'data-rn-tile="dealer"')).toContain('preserveAspectRatio="none"');
  });
  it("the prompt split in one cell: both counts, both links, the cited share once", () => {
    const html = render(input(), "geography=US");
    const cell = between(hero(html), 'data-rn-tile="prompts"', "</section>");
    const L = T.lens as typeof T.lens & { prompts: Record<string, string> };
    expect(cell).toContain(L.prompts.name);
    const owned = between(cell, 'data-rn-link="owned"', "</a>");
    const uncited = between(cell, 'data-rn-link="uncited"', "</a>");
    const tag = (kind: string) => cell.match(new RegExp(`<a [^>]*data-rn-link="${kind}"[^>]*>`))?.[0] ?? "";
    expect(tag("owned")).toContain('href="/ko/renewal/standard/answer-analysis/citation/prompts?geography=US&amp;tab=owned"');
    expect(tag("uncited")).toContain('href="/ko/renewal/standard/answer-analysis/citation/prompts?geography=US&amp;tab=uncited"');
    expect(owned).toMatch(/57<small[^>]*>개<\/small><\/span><span[^>]*>59%/); /* i18n-ignore */
    expect(owned).toContain(L.prompts.owned);
    expect(uncited).toMatch(/39<small[^>]*>개<\/small>/); /* i18n-ignore */
    expect(uncited).toContain(L.prompts.uncited);
    expect(uncited).not.toContain("%");
    expect(html).not.toContain("41%");
    // a split the page does not compute says why, once
    const off = render(input({ data: live({ promptSplit: undefined }) }), `source=${encodeURIComponent(HMG)}`);
    expect(off.split(T.lens.split.notComputed).length - 1).toBe(1);
    expect(off).not.toContain('data-rn-link="');
  });
  it("the chip row's totals name the domain table's population and denominator", () => {
    const html = render(input());
    expect(html).not.toContain('data-rn-cmeta=""');
    expect(html).not.toContain(fill(T.lens.total, { n: "1,000" }));
    expect(html).not.toContain(fill(T.lens.domains, { n: "9" }));
    const TT = T.table as typeof T.table & Record<string, string>;
    expect(between(html, `aria-label="${T.table.title}"`, "</table>")).toContain(fill(TT.chipGlobal, { n: "100", domains: "9", total: "1,000" }));
    // the Project page keeps its chip row
    const project = asProject(() => render(input()));
    expect(project).toContain(fill(T.lens.total, { n: "1,000" }));
    expect(project).not.toContain(fill(TT.chipGlobal, { n: "100", domains: "9", total: "1,000" }));
  });
  it("출처 구성: the Δ values without the bar, its axis or the up / down legend; no top domains in the row tooltip", () => {
    const C = T.comp as typeof T.comp & Record<string, string>;
    const topLine = C.tipTop.split("{list}")[0];
    const html = render(input());
    expect(html).not.toContain("data-rn-daxis");
    expect(html).not.toContain("data-rn-dbar");
    expect(html).not.toContain('data-rn-dlg=""');
    expect(html).not.toContain(topLine);
    // the Δ value column stays, under the head the axis had
    expect((html.match(/data-rn-dc=""/g) ?? []).length).toBe(4);
    expect(between(html, `data-rn-src="${AUTO.replace(/&/g, "&amp;")}"`, "</button>")).toContain("▲2.0pp");
    expect(between(html, `aria-label="${T.comp.title}"`, 'data-rn-src="')).toContain(C.col.deltaAxis);
    expect(html).toContain(fill(C.trendNote, { span: "2" }));
    // Project keeps them
    const project = asProject(() => render(input()));
    expect(project).toContain("data-rn-daxis");
    expect(project).toContain('data-rn-dlg=""');
    expect(project).toContain(topLine);
  });
  it("no month line on Global (C4, the user's legacy exception); Project and Website keep it", () => {
    // the 2026-09 month's live line: 답변당 인용 수 +46.6 %, 4 rounds against 5
    PERIOD_VIEW = { days: 30, presetKey: null, caption: { key: "window", params: { prevCycles: 5, curCycles: 4 } }, chips: [{ key: "citationsPerAnswer", unit: "pct", suppressed: false, value: 46.6, direction: "up" }] };
    try {
      expect(render(input())).not.toContain("data-period-delta-line");
      for (const other of [asProject(() => render(input())), render(input(), "", site())]) expect(other).toContain('data-period-delta-line="window"');
    } finally {
      PERIOD_VIEW = null;
    }
  });
});

// 2026-11-05: the original's per-cell citations in the source preference matrix (tooltip and CSV), on every page.
describe("renewal Citation body — matrix cell citations (restored, every page)", () => {
  const M = T.matrix as typeof T.matrix & Record<string, string>;
  const cellTitle = (html: string, cell: string) => between(html, `data-rn-cell="${cell}"`, ">").replace(/&#x27;/g, "'");
  it("each cell's tooltip names its citations as Gold has them, on Global, Project and Website", () => {
    for (const html of [render(input()), asProject(() => render(input())), render(input(), "", site())]) {
      // chatgpt: 공식(HMG) 60 of 400, 자동차 미디어 200; gemini 공식(HMG) 190
      expect(cellTitle(html, `chatgpt|${HMG}`)).toContain(fill(M.tipCount, { n: "60" }));
      expect(cellTitle(html, `chatgpt|${AUTO}`)).toContain(fill(M.tipCount, { n: "200" }));
      expect(cellTitle(html, `gemini|${HMG}`)).toContain(fill(M.tipCount, { n: "190" }));
    }
  });
  it("the CSV: each column's share, citations and gap", async () => {
    const { matrixCsvRows } = await import("./citation-body");
    const p = input();
    const vm = rnVmFor({ live: p.data, prev: p.prevCategories, card: p.officialDelta, typeRows: p.typeCategories, sections: null, search: "" })!;
    const rows = matrixCsvRows(vm.engineMatrix.m!, { category: "c", all: "a", count: "n", gap: "g" }, (k) => k, (k) => k);
    expect(rows[0]).toEqual(["c", "a", "chatgpt", "chatgpt n", "chatgpt g", "gemini", "gemini n", "gemini g"]);
    // 공식(HMG): 60 / 400 = 15.0% and 190 / 600 = 31.7% of 전체 250 / 1,000 = 25.0%
    expect(rows.find((r) => r[0] === HMG)).toEqual([HMG, "25.0", "15.0", 60, "-10.0", "31.7", 190, "6.7"]);
  });
});

// 2026-10-31 renewal audit 10-1: each 출처 구성 row drew a weekly share line only — no round, no citation count, and
// the card's CSV had neither. The original composition chart named every round on its axis, showed the round's
// citations in its tooltip, shaded the gaps and drew citations (not 100% shares) with one 출처 picked.
describe("renewal Citation body — 출처 구성 rounds (renewal audit 10-1)", () => {
  const C = T.comp as typeof T.comp & Record<string, string> & { col: Record<string, string> };
  const tips = (html: string) => [...html.matchAll(/data-rn-tip="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  it("every point of a row's line names its round, its share and its citations", () => {
    const html = render(input());
    // 9/21: 자동차 미디어 100 of 250 citations (100 · 50 · 60 · 40)
    expect(tips(html)).toContain(fill(C.tipPoint, { day: "9/21", pct: "40.0%", n: "100" }));
    expect(tips(html)).toContain(fill(C.tipPoint, { day: "10/12", pct: "15.4%", n: "40" }));
    expect((html.match(/data-rn-spark-point="/g) ?? []).length).toBe(16);
    // the line sits outside the row's filter button (a focusable point inside a button is not reachable)
    const row = html.slice(html.indexOf(`data-rn-src="${AUTO}"`), html.indexOf("</button>", html.indexOf(`data-rn-src="${AUTO}"`)));
    expect(row).not.toContain("data-rn-spark-point");
    // the column names the rounds it spans
    expect(html).toContain(fill(C.col.trendRange, { from: "9/21", to: "10/12" }));
  });
  it("a round without a value has no point and says so", () => {
    const gapLive = live({
      categoryTrend: {
        series: [AUTO, NEWS, HMG, COMP],
        points: weeks.map((week, i) => (i === 1 ? { week, [AUTO]: null, [NEWS]: null, [HMG]: null, [COMP]: null, gap: { reason: "collection_error" } } : { week, [AUTO]: 100 + i, [NEWS]: 50, [HMG]: 60 + i * 2, [COMP]: 40 })),
      },
    });
    // the screen's shares of that round are null as well (category_share_series)
    const gapHtml = render({ ...input(), data: gapLive }, "", undefined, "", input(), (vm) => ({ ...vm, rows: vm.rows.map((r) => ({ ...r, trend: (r.trend ?? []).map((v, i) => (i === 1 ? null : v)) })) }));
    expect(tips(gapHtml).filter((s) => s === fill(C.tipGap, { day: "9/28" }))).toHaveLength(4);
    // no ring marker on that round's zone, a marker on the others
    const after = (i: number) => [...gapHtml.matchAll(new RegExp(`<span[^>]*data-rn-spark-point="${i}"[^>]*>(<i|</span>)`, "g"))].map((m) => m[1]);
    expect(after(1)).toEqual(["</span>", "</span>", "</span>", "</span>"]);
    expect(after(2)).toEqual(["<i", "<i", "<i", "<i"]);
  });
  it("one 출처 picked: the line draws the round's citations, the column says so", () => {
    // the page reads that source only: its trend holds that series alone, a 100% share every round
    const base = input({ data: live({ categories: [{ name: AUTO, value: 400 }], promptSplit: undefined }) });
    const only = { series: [AUTO], points: weeks.map((week, i) => ({ week, [AUTO]: 100 + i })) };
    const html = render({ ...base, data: { ...base.data!, categoryTrend: only } }, `source=${encodeURIComponent(AUTO)}`, undefined, `source=${encodeURIComponent(AUTO)}`, base, (vm) => ({
      ...vm,
      rows: vm.rows.map((r) => ({ ...r, trend: weeks.map(() => 100) })),
    }));
    expect(html).not.toContain('points="3.0,18.0 41.0,18.0 79.0,18.0 117.0,18.0"');
    // 100 · 101 · 102 · 103 citations over the full height (a 100% share would be flat)
    expect(html).toContain('points="3.0,33.0 41.0,23.0 79.0,13.0 117.0,3.0"');
    expect(html).toContain(C.col.trendCount);
    expect(tips(html)).toContain(fill(C.tipPoint, { day: "10/12", pct: "100.0%", n: "103" }));
  });
  it("table view and CSV: the list's values, then each round's share and citations", async () => {
    const { compositionRounds, compositionCsvRows, CompositionTable } = await import("./citation-body");
    const p = input();
    const vm = rnVmFor({ live: p.data, prev: p.prevCategories, card: p.officialDelta, typeRows: p.typeCategories, sections: null, search: "" })!;
    const rounds = compositionRounds(vm.rows, p.data!.categoryTrend);
    expect(rounds.x).toEqual(weeks);
    const csv = compositionCsvRows(vm.rows, rounds, { category: "c", citations: "n", pct: "%", prev: "p", delta: "d" }, (x) => x);
    expect(csv[0]).toEqual(["c", "n", "%", "p", "d", "2026-09-21 n", "2026-09-21 %", "2026-09-28 n", "2026-09-28 %", "2026-10-05 n", "2026-10-05 %", "2026-10-12 n", "2026-10-12 %"]);
    // 자동차 미디어: 100 of 250 → 101 of 253 → 102 of 256 → 103 of 259
    expect(csv.find((r) => r[0] === AUTO)!.slice(5)).toEqual([100, "40.0", 101, "39.9", 102, "39.8", 103, "39.8"]);
    const table = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <CompositionTable rows={vm.rows} rounds={rounds} period={false} />
      </NextIntlClientProvider>,
    );
    expect(table).toContain(">9/21<");
    const cell = (pct: string, n: string) => new RegExp(`<b[^>]*>${pct.replace(".", "\\.")}</b><small[^>]*>${n}</small>`);
    expect(table).toMatch(cell("40.0%", "100"));
    expect(table).toMatch(cell("15.4%", "40"));
  });
});
