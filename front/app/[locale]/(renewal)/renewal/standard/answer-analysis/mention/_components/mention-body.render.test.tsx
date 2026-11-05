import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { ServiceWeekView } from "@/lib/service-week";
import type { RnShellVM } from "../_data/screen-types";
import { FEEDBACK_EMAIL_TEXT } from "@/lib/support-contact";

// The renewal Mention body's empty states (MentionShell: the body aggregate mention/rn-shell decides the page), the
// Global and the Website page alike. Review r1-19 (2026-11-03): under a service week with no Website round (the week of
// 07-27 on live Gold) the BFF reads no Website snapshot, so rn-shell answers measured false — and the page blamed the
// filters ('필터를 줄이거나 초기화해 보세요', a reset that cannot bring a round back) or said '측정 데이터가 아직 없습니다'.

const nav = vi.hoisted(() => ({ path: "/ko/renewal/website/answer-analysis/mention", search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { serviceWeekContext } = await import("@/components/service-week/provider");
const { RnMentionBody } = await import("./mention-body");
const { RnMentionPageProvider } = await import("./mention-tabs");
const ServiceWeek = serviceWeekContext();

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const UNMEASURED: RnShellVM = { measured: false, degraded: false, ownBrands: [], ownSum: [], drawer: [] } as unknown as RnShellVM;
const W0727 = { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 };
const week = (website: boolean): ServiceWeekView => ({
  state: "ok",
  week: W0727,
  delay: null,
  checkedAt: null,
  recordedAt: null,
  rounds: { global: true, website },
  notes: [],
});

function render({ filtered, search = "", view, shell = UNMEASURED }: { filtered: boolean; search?: string; view: ServiceWeekView | null; shell?: RnShellVM }) {
  nav.search = search;
  const input = { kpi: "exposure", view: "kpi", ownLabel: "HMG", period: null, filtered, shell: settled(shell) } as never;
  const sw = view ? { initial: settled(view), latest: view, applies: true, surface: "website" as const, sites: "", notesFor: "" } : null;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <ServiceWeek.Provider value={sw}>
        <RnFilterRuntime>
          <RnOverviewFilters props={{ stage: "mention", surface: "website", scope: { all: true } }} savedFilters={{ page: "website-mention", userId: "test", initial: [] }}>
            <RnMentionPageProvider input={input}>
              <RnMentionBody />
            </RnMentionPageProvider>
          </RnOverviewFilters>
        </RnFilterRuntime>
      </ServiceWeek.Provider>
    </NextIntlClientProvider>,
  );
}
const S = ko.renewal.mention.states;

describe("renewal Mention body: nothing measured", () => {
  it("a snapshot of a surface the service week holds no round of: 측정 없음 and the week, no filter advice", () => {
    for (const filtered of [true, false]) {
      const html = render({ filtered, search: filtered ? "engine=chatgpt" : "", view: week(false) });
      expect(html).toContain("측정 없음");
      expect(html).toContain("서비스 기준 주 7월 5주차(7/27~8/2)에는 Website 측정 회차가 없습니다.");
      expect(html).not.toContain(S.noResultTitle);
      expect(html).not.toContain(S.reset);
      expect(html).not.toContain(ko.answerAnalysis.empty);
    }
  });

  it("otherwise its own states: the filters (with the reset) or no measurement yet", () => {
    expect(render({ filtered: true, search: "engine=chatgpt", view: week(true) })).toContain(S.noResultTitle);
    expect(render({ filtered: true, search: "engine=chatgpt", view: week(true) })).toContain(S.reset);
    expect(render({ filtered: false, view: week(true) })).toContain(ko.answerAnalysis.empty);
    // a period reads the rounds before the week: its empty state is the period's, and the reset brings them back
    const period = render({ filtered: true, search: "time=2026-07-01..2026-07-31", view: week(false) });
    expect(period).toContain(S.noResultTitle);
    expect(period).not.toContain("측정 없음");
    // no shell week (a page rendered on its own)
    expect(render({ filtered: true, search: "engine=chatgpt", view: null })).toContain(S.noResultTitle);
  });

  it("a period that starts after the service week: the week names it, not the filters (review r3-12)", () => {
    // review r3-12 (2026-11-03): time=2026-10-12..2026-10-18 under the week of 10-05 read no round (the BFF's cap), and
    // the page said '이 필터 조합에는 측정 결과가 없습니다 — … 필터를 줄이거나 초기화해 보세요'
    for (const website of [true, false]) {
      const html = render({ filtered: true, search: "time=2026-08-03..2026-08-09", view: week(website) });
      expect(html).toContain("아직 보이지 않는 기간");
      expect(html).toContain("고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다.");
      expect(html).not.toContain(S.noResultTitle);
      expect(html).not.toContain(S.noResultDesc);
      expect(html).not.toContain("측정 없음");
    }
  });

  it("a failed read still says it could not load", () => {
    const html = render({ filtered: false, view: week(false), shell: { ...UNMEASURED, degraded: true } as RnShellVM });
    expect(html).toContain(ko.renewal.mention.degraded.all.replace("{contact}", FEEDBACK_EMAIL_TEXT));
    expect(html).not.toContain("측정 없음");
  });
});

// Global 지표 정리 (2026-11-05, the user's choice C): Global has no 이번 회차 요약 card — no navy card at all, the view rail
// right under the control bar. Project (the same body) keeps the card; the Website page draws its own body.
describe("renewal Mention body: 이번 회차 요약 on Global and Project", () => {
  const pending = <T,>(): Promise<T> => new Promise<T>(() => {});
  const MEASURED = { measured: true, degraded: false, ownBrands: ["Hyundai", "Kia", "Genesis"], ownSum: [], drawer: [] } as unknown as RnShellVM;
  const page = (global: boolean, shell: Promise<RnShellVM>, over: object = {}) => {
    nav.path = global ? "/ko/renewal/standard/answer-analysis/mention" : "/ko/renewal/projects/p1/analysis/mention";
    nav.search = "";
    const tabValue = Object.fromEntries(["exposure", "sov", "favorability", "first-rank"].map((k) => [k, pending()]));
    const reads = Object.fromEntries(["tabDeltas", "compare", "summary", "rateValue", "rateHero", "rateEngines", "rateTypes", "favorHero", "favorDist", "favorMatrix", "rank", "bump", "ranking"].map((k) => [k, pending()]));
    const input = { kpi: "exposure", view: "brands", ownLabel: "HMG", period: null, filtered: false, shell, tabValue, ...reads, ...(global ? { brandsFirst: true, global: true } : {}), ...over } as never;
    const html = renderToStaticMarkup(
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
    nav.path = "/ko/renewal/website/answer-analysis/mention";
    return html;
  };

  it("Project keeps the card (its skeleton while it reads); Global has none, measured or loading", () => {
    for (const shell of [settled(MEASURED), pending<RnShellVM>()]) {
      const project = page(false, shell);
      expect(project).toContain('id="sec-summary"');
      const global = page(true, shell);
      expect(global).not.toContain('id="sec-summary"');
      expect(project).toMatch(/rounded-rn-card rn-hero/);
      expect(global).not.toMatch(/rounded-rn-card rn-hero/);
      expect(global).toContain('id="rn-kpi-tabs"');
    }
  });

  // a calendar month's 답변당 언급 수 change, with no level beside it: off Global (the user's call, 2026-11-05)
  it("a calendar month's 답변당 언급 수 line stays on Project, not on Global", () => {
    const monthLine = { days: 30, presetKey: "lastMonth", caption: { key: "window", params: { curCycles: 4, prevCycles: 5 } }, chips: [{ key: "mentionsPerAnswer", unit: "pct", suppressed: false, value: 4.2, direction: "up" }] };
    const summary = settled({ asOf: "2026-10-05", exp: null, sov: null, fav: null, pos: null, covered: [], fixed: [], typeFindings: [], options: {}, monthLine });
    expect(page(false, settled(MEASURED), { summary })).toContain("답변당 언급 수");
    expect(page(true, settled(MEASURED), { summary })).not.toContain("답변당 언급 수");
  });

  it("on Global the view rail follows the control bar", () => {
    const html = page(true, settled(MEASURED));
    const bar = html.indexOf("data-rn-cbar");
    const rail = html.indexOf('id="rn-kpi-tabs"');
    expect(bar).toBeGreaterThan(-1);
    expect(rail).toBeGreaterThan(bar);
    expect(html.slice(bar, rail)).not.toContain("rounded-rn-card");
  });
});
