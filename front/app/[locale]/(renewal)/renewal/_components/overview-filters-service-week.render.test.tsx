import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { ServiceWeekView } from "@/lib/service-week";
import type { SavedFilter } from "./saved-filters";

// The service week (2026-11-02) in the renewal filter panel: when the BFF hands no round dates the time axis falls
// back to two date inputs, which took any day; they now stop at the service week's end (the start at the picked end
// too). The presets are held to the week in resolveTimeRangeView (time-preset-week.test.ts).

let SEARCH = "";
let PATH = "/ko/renewal/website";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => PATH,
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewApplied, RnOverviewFilters, RnOverviewFilterPanel } = await import("./overview-filters");
const { RnServiceWeekProvider, serviceWeekContext } = await import("@/components/service-week/provider");
const ServiceWeekContext = serviceWeekContext();

const WEEK: ServiceWeekView = {
  state: "ok",
  week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 },
  delay: null,
  checkedAt: null,
  recordedAt: null,
  notes: [],
};
/** the layout's read as it streams in with the page: settled (React reads a settled promise without waiting) */
const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

type RenderOpts = { selectableDates?: string[]; latestAnchorDay?: string; saved?: SavedFilter[] };

/** The panel and the applied chips at `PATH`, under `shell` (a service week context, or the shell's provider). */
function renderUnder(shell: ((panel: ReactNode) => ReactNode) | null, url = "", opts: RenderOpts = {}): string {
  SEARCH = url;
  const panel = (
    <RnFilterRuntime>
      <RnOverviewFilters
        props={{
          stage: "overview",
          surface: "website",
          scope: { all: true },
          geographyOptions: ["US"],
          selectableDates: opts.selectableDates,
          latestAnchorDay: opts.latestAnchorDay,
        }}
        savedFilters={{ page: "website-overview", userId: "test", initial: opts.saved ?? [] }}
      >
        <RnOverviewApplied />
        <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
      </RnOverviewFilters>
    </RnFilterRuntime>
  );
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {shell ? shell(panel) : panel}
    </NextIntlClientProvider>,
  );
}

/** Once this tab knows the week (`latest`); `view` null = no shell provider. */
function render(view: ServiceWeekView | null, url = "", opts: RenderOpts = {}): string {
  PATH = "/ko/renewal/website";
  return renderUnder(
    view ? (panel) => <ServiceWeekContext.Provider value={{ initial: Promise.resolve(view), latest: view, applies: true, surface: "website" }}>{panel}</ServiceWeekContext.Provider> : null,
    url,
    opts,
  );
}

/** The server render (and the browser's first): the shell's provider with the layout's read, `latest` not known yet. */
function firstPaint(week: Promise<ServiceWeekView | null>, url = "", opts: RenderOpts = {}, path = "/ko/renewal/website"): string {
  PATH = path;
  return renderUnder((panel) => <RnServiceWeekProvider week={week} notes>{panel}</RnServiceWeekProvider>, url, opts);
}

const inputsOf = (html: string) => [...html.matchAll(/<input[^>]*type="date"[^>]*>/g)].map((m) => m[0]);
const dateInputs = (view: ServiceWeekView | null, url = "") => inputsOf(render(view, url));
const appliedOf = (html: string) => html.slice(html.indexOf('aria-live="polite"'), html.indexOf('id="rn-filter-panel"'));
const panelOf = (html: string) => html.slice(html.indexOf('id="rn-filter-panel"'));
const textOf = (html: string) => html.replace(/<[^>]*>/g, "");
/** the time section's 직접 선택 range */
const customOf = (html: string) => /<span class="font-semibold text-rn-navy tabular-nums"[^>]*>([^<]*)<\/span>/.exec(panelOf(html));
/** the time section's summary, beside its title */
const summaryOf = (html: string) => /data-fk="s:time"[\s\S]*?<span class="ml-auto max-w-\[150px\][^"]*">([^<]*)<\/span>/.exec(panelOf(html))?.[1] ?? null;
const dayCell = (html: string, day: string) => new RegExp(`<button[^>]*data-day="${day}"[^>]*>`).exec(html)?.[0] ?? "";
const weeklyOf = (html: string) => /<div[^>]*data-fk="t:weekly"[^>]*>/.exec(html)?.[0] ?? "";

describe("renewal time axis without round dates: the date inputs", () => {
  it("stop at the service week's end", () => {
    const inputs = dateInputs(WEEK);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).toContain('max="2026-10-11"');
  });

  it("the start stops at the picked end when that is earlier", () => {
    const [from, to] = dateInputs(WEEK, "time=2026-09-01..2026-09-30");
    expect(from).toContain('max="2026-09-30"');
    expect(to).toContain('max="2026-10-11"');
  });

  it("no service week known (no shell provider): no cap, as before", () => {
    const inputs = dateInputs(null);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).not.toContain("max=");
  });
});

// The applied period (review r1-15). The BFF reads a `to` after the week up to the week's last day (Context.create) and
// the page header says so, but the applied chip and the panel's 직접 선택 printed the URL's own range: '기간 누적
// 2026-09-28 ~ 2026-10-11' in the header next to '기간 2026-09-28 ~ 2026-10-25' in the chip. They print the period as it
// is read now, the picked one in their title; the URL keeps the pick, so a later week shows more under the same link.
// A saved filter's summary (and the name it suggests) is the filter as saved.
describe("the applied period stops at the service week's end", () => {
  const PICKED = "time=2026-09-28..2026-10-25";
  const CUT_TITLE = "고른 기간 2026-09-28 ~ 2026-10-25 중 서비스 기준 주의 끝(2026-10-11)까지 보입니다.";

  it("the chip under the title and the panel's 직접 선택 print the period as read, the pick in their title", () => {
    const html = render(WEEK, PICKED);
    const applied = appliedOf(html);
    expect(textOf(applied)).toContain("기간2026-09-28 ~ 2026-10-11");
    expect(textOf(applied)).not.toContain("2026-10-25");
    expect(applied).toContain(`title="${CUT_TITLE}"`);
    const custom = customOf(html);
    expect(custom?.[1]).toBe("2026-09-28 ~ 2026-10-11");
    expect(custom?.[0]).toContain(`title="${CUT_TITLE}"`);
  });

  it("the end date input holds the day read, never a day past its own max", () => {
    const to = [...render(WEEK, PICKED).matchAll(/<input[^>]*type="date"[^>]*>/g)].map((m) => m[0])[1];
    expect(to).toContain('value="2026-10-11"');
    expect(to).toContain('max="2026-10-11"');
  });

  it("the round calendar marks the end read, not the day picked", () => {
    const html = render(WEEK, PICKED, { selectableDates: ["2026-09-25", "2026-10-02", "2026-10-09"] });
    const cellOf = (day: string) => new RegExp(`<button[^>]*data-day="${day}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(cellOf("2026-10-11")).toContain("text-white");
    expect(cellOf("2026-10-25")).not.toContain("text-white");
  });

  it("a saved filter's summary is the filter as saved", () => {
    const html = render(WEEK, "", { saved: [{ id: "a", name: "10월", isDefault: false, query: PICKED }] });
    expect(textOf(panelOf(html))).toContain("2026-09-28 ~ 2026-10-25");
  });

  it("a period within the week, or with an open end, prints as picked and has no title", () => {
    for (const [url, shown] of [
      ["time=2026-09-28..2026-10-09", "2026-09-28 ~ 2026-10-09"],
      ["time=2026-09-28..", "2026-09-28 ~ …"],
    ]) {
      const applied = appliedOf(render(WEEK, url));
      expect(textOf(applied)).toContain(`기간${shown}`);
      expect(applied).not.toContain("title=");
    }
  });

  it("a period that starts after the week holds no round read: it prints as picked (the page says 측정 없음)", () => {
    const applied = appliedOf(render(WEEK, "time=2026-10-12..2026-11-01"));
    expect(textOf(applied)).toContain("기간2026-10-12 ~ 2026-11-01");
    expect(applied).not.toContain("title=");
  });

  it("no service week known (no shell provider): as picked, as before", () => {
    const html = render(null, PICKED);
    expect(textOf(appliedOf(html))).toContain("기간2026-09-28 ~ 2026-10-25");
    expect(customOf(html)?.[1]).toBe("2026-09-28 ~ 2026-10-25");
    expect(html).not.toContain("서비스 기준 주의 끝");
  });

  it("the presets end at the week's end when the page names a later day, with round dates or without", () => {
    // review r1-17 (2026-11-03): the panel hands the week's end on to its presets (timeViewOf). The BFF names no day
    // past the week, but a body read under a later week than the chip's (review r1-16, until the page re-reads) does:
    // 주간 is the week 10-05 ~ 10-11, not 10-13 ~ 10-19
    const weekly = (html: string) => /<div[^>]*data-fk="t:weekly"[^>]*>/.exec(html)?.[0] ?? "";
    for (const selectableDates of [undefined, ["2026-10-02", "2026-10-09", "2026-10-16"]]) {
      const html = render(WEEK, "time=2026-10-05..2026-10-11", { latestAnchorDay: selectableDates ? "2026-10-16" : "2026-10-19", selectableDates });
      expect(weekly(html), String(selectableDates)).toContain('aria-checked="true"');
      expect(textOf(appliedOf(html)), String(selectableDates)).toContain("기간주간 (최근 7일)");
    }
  });
});

// The first paint (review r3-6, 2026-11-03). The shell learns the week in its first effect, so the server render and the
// browser's first printed the URL's period in the chip, the 기간 summary and 직접 선택 while the page header beside them,
// the screen's own answer, named the week's: '기간 누적 2026-10-01 ~ 2026-10-11' over '기간 2026-10-01 ~ 2026-10-31' until
// the page had hydrated. The chips and the time section take the layout's read then (it streams in with the page), each
// in a Suspense of its own: while that read is not known they print the pick, and nothing else waits on it.
describe("the first paint holds the period to the layout's week", () => {
  const PICKED = "time=2026-10-01..2026-10-31";
  const CUT = "고른 기간 2026-10-01 ~ 2026-10-31 중 서비스 기준 주의 끝(2026-10-11)까지 보입니다.";

  it("the applied chip, the 기간 summary and 직접 선택 print the period read, the pick in their title", () => {
    const html = firstPaint(settled(WEEK), PICKED);
    const applied = appliedOf(html);
    expect(textOf(applied)).toContain("기간2026-10-01 ~ 2026-10-11");
    expect(textOf(applied)).not.toContain("2026-10-31");
    expect(applied).toContain(`title="${CUT}"`);
    expect(summaryOf(html)).toBe("2026-10-01 ~ 2026-10-11");
    expect(customOf(html)?.[1]).toBe("2026-10-01 ~ 2026-10-11");
    expect(customOf(html)?.[0]).toContain(`title="${CUT}"`);
  });

  it("so do the time section's pickers: the date inputs and the round calendar end at the week", () => {
    const inputs = inputsOf(firstPaint(settled(WEEK), PICKED));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).toContain('max="2026-10-11"');
    expect(inputs[1]).toContain('value="2026-10-11"');
    const calendar = firstPaint(settled(WEEK), PICKED, { selectableDates: ["2026-09-25", "2026-10-02", "2026-10-09"] });
    expect(dayCell(calendar, "2026-10-11")).toContain("text-white");
    expect(dayCell(calendar, "2026-10-31")).not.toContain("text-white");
  });

  it("a layout read not known yet, or failed: the pick, and the rest of the panel renders", () => {
    for (const week of [new Promise<ServiceWeekView | null>(() => {}), settled(null)]) {
      const html = firstPaint(week, PICKED);
      expect(textOf(appliedOf(html))).toContain("기간2026-10-01 ~ 2026-10-31");
      expect(customOf(html)?.[1]).toBe("2026-10-01 ~ 2026-10-31");
      expect(html).not.toContain("서비스 기준 주의 끝");
      expect(html).toContain('data-fk="s:geography"');
    }
  });
});

// A week that holds no round of the page's surface (review r4-3, 2026-11-03). With no period the BFF reads no snapshot
// then (Context.create) and the page says '측정 없음' (decision '기준 주 세부'), but the time section named the surface's
// last round before the week as the one the page shows: '기간 미선택 시 이 회차를 봅니다 · 2026-09-25' and that day
// outlined on the calendar. The rounds before the week stay pickable; none is named as the page's.
describe("no period under a week that holds no round of the surface", () => {
  const BEFORE = ["2026-09-18", "2026-09-25"];
  const DEFAULT = ko.dashboard.filters.timeRange.defaultRound;
  const OUTLINE = "shadow-[inset_0_0_0_1.5px_var(--color-rn-navy)]";

  it("names no round as the page's — no hint, no outline — on the first paint and once the tab knows the week", () => {
    for (const html of [render(WEEK, "", { selectableDates: BEFORE }), firstPaint(settled(WEEK), "", { selectableDates: BEFORE })]) {
      expect(panelOf(html)).not.toContain(DEFAULT);
      expect(dayCell(html, "2026-09-25")).not.toContain(OUTLINE);
      expect(dayCell(html, "2026-09-25")).not.toContain("disabled");
    }
  });

  it("a round in the week is the page's, as before; so is the last round with no week known", () => {
    const inWeek = render(WEEK, "", { selectableDates: [...BEFORE, "2026-10-09"] });
    expect(textOf(panelOf(inWeek))).toContain(`${DEFAULT}2026-10-09`);
    expect(dayCell(inWeek, "2026-10-09")).toContain(OUTLINE);
    const unknown = render(null, "", { selectableDates: BEFORE });
    expect(textOf(panelOf(unknown))).toContain(`${DEFAULT}2026-09-25`);
    expect(dayCell(unknown, "2026-09-25")).toContain(OUTLINE);
  });
});

// A page the BFF does not hold to the week (review r3-8, 2026-11-03): the GA4 pages read GA4's days up to its latest
// one, so their pickers keep the page's own end. The shell knows the week there too (it reads it on every page), and
// only its `applies` keeps the week's end off them — no test held that.
describe("a page not held to the week (GA4) keeps its own end", () => {
  const GA4 = "/ko/renewal/standard/ai-funnel/visibility";
  const shells: Array<[string, (panel: ReactNode) => ReactNode]> = [
    ["the week known in the tab", (panel) => <ServiceWeekContext.Provider value={{ initial: settled(WEEK), latest: WEEK, applies: false, surface: null }}>{panel}</ServiceWeekContext.Provider>],
    ["the first paint", (panel) => <RnServiceWeekProvider week={settled(WEEK)} notes>{panel}</RnServiceWeekProvider>],
  ];

  it.each(shells)("%s: no date input stops at the week, 주간 ends at the page's last day, a later pick prints as picked", (_label, shell) => {
    PATH = GA4;
    // the page's last GA4 day is 10-25: 주간 is 10-19 ~ 10-25, not the week's 10-05 ~ 10-11
    const weekly = renderUnder(shell, "time=2026-10-19..2026-10-25", { latestAnchorDay: "2026-10-25" });
    expect(weeklyOf(weekly)).toContain('aria-checked="true"');
    expect(textOf(appliedOf(weekly))).toContain("기간주간 (최근 7일)");
    for (const input of inputsOf(weekly)) expect(input).not.toContain('max="2026-10-11"');
    const later = renderUnder(shell, "time=2026-10-01..2026-10-31", { latestAnchorDay: "2026-10-25" });
    expect(textOf(appliedOf(later))).toContain("기간2026-10-01 ~ 2026-10-31");
    expect(customOf(later)?.[1]).toBe("2026-10-01 ~ 2026-10-31");
    expect(later).not.toContain("서비스 기준 주의 끝");
    const [from, to] = inputsOf(later);
    expect(from).toContain('max="2026-10-31"');
    expect(to).not.toContain("max=");
  });
});
