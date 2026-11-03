import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { ServiceWeekView } from "@/lib/service-week";
import type { WebsitePromptInsights, WebsitePromptRow, WebsitePromptsPage } from "./website-prompt-model";

// Renewal Website › Prompts body (2026-10-30, W4; cards cut to what answers "what is measured, where, how steadily"
// 2026-11-02): the KPI strip, the rounds chart and the market table (every number one the screens sent), the list
// keeping every original field (prompt, brand, country · language, target URL, answers with their engines, latest
// measurement), the list's picks from the URL, the lens line, the detail sheet with the measured rounds, and the URL
// the list keeps.

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/website/prompts",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("./website-prompts-read", () => ({ readWebsitePromptsPage: vi.fn(), readWebsitePromptRows: vi.fn(), readWebsitePromptInsights: vi.fn() }));
vi.mock("../../../_components/overview-filters", () => ({ useRnFilterToggle: () => () => {} }));
// the lens the body hands its detail sheet, and whether the sheet shows the measurement (the sheet opens on a row's
// click, which a static render has none of)
const sheet = vi.hoisted(() => ({ lens: null as string[] | null, measured: undefined as boolean | undefined }));
vi.mock("./website-prompt-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./website-prompt-list")>();
  return {
    ...actual,
    RnWebsitePromptDetail: (props: Parameters<typeof actual.RnWebsitePromptDetail>[0]) => {
      sheet.lens = props.lens;
      sheet.measured = props.measured;
      return actual.RnWebsitePromptDetail(props);
    },
  };
});

// the export (a static render has no click): its button's handler, and the sheet it writes
const exportButton = vi.hoisted(() => ({ onClick: null as null | (() => unknown) }));
vi.mock("@/components/renewal-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/renewal-ui")>();
  const label = (await import("@/messages/ko.json")).default.website.prompts.exportLabel;
  return {
    ...actual,
    RnButton: (props: Parameters<typeof actual.RnButton>[0]) => {
      if ([props.children].flat().includes(label)) exportButton.onClick = props.onClick as () => unknown;
      return actual.RnButton(props);
    },
  };
});
vi.mock("@/lib/export/xlsx", () => ({ downloadXlsx: vi.fn(async () => {}) }));

const { RnToastProvider } = await import("@/components/renewal-ui");
const { downloadXlsx } = await import("@/lib/export/xlsx");
const { RnWebsitePrompts } = await import("./website-prompts-view");
const { RnWebsitePromptDetail } = await import("./website-prompt-list");
const { readDrill, withList, engineSetKey } = await import("./website-prompt-model");
const ServiceWeekContext = (await import("@/components/service-week/provider")).serviceWeekContext();

const AXIS = ["2026-09-25", "2026-10-02", "2026-10-09"];
const row = (id: string, over: Partial<WebsitePromptRow> = {}): WebsitePromptRow => ({
  id,
  promptText: `prompt ${id}`,
  brand: "Kia",
  countryCode: "DE",
  langCode: "de",
  targetUrl: "kia.com/de/models/ev6",
  domain: "kia.com",
  answers: 1234,
  lastMeasuredAt: "2026-10-09",
  engines: ["chatgpt", "gemini"],
  firstMeasuredAt: "2026-10-02",
  rounds: ["2026-10-02", "2026-10-09"],
  engineAnswers: { chatgpt: 700, gemini: 534 },
  ...over,
});
const ROWS = [
  row("a"),
  row("b", { brand: "", countryCode: "MIDDLEEAST", langCode: "ar", answers: 0, lastMeasuredAt: null, firstMeasuredAt: null, engines: [], rounds: [], engineAnswers: {} }),
];
const page = (rows: WebsitePromptRow[], over: Partial<WebsitePromptsPage> = {}): WebsitePromptsPage => ({
  rows,
  total: 120,
  listed: 120,
  page: 1,
  pages: 3,
  pageSize: 50,
  rangeFrom: 1,
  rangeTo: 50,
  sort: "lastMeasuredAt",
  dir: "desc",
  roundAxis: AXIS,
  ...over,
});
const INSIGHTS: WebsitePromptInsights = {
  prompts: 120,
  engines: ["gemini", "chatgpt"],
  rounds: [
    { date: "2026-09-18", prompts: 40 },
    { date: "2026-09-25", prompts: 0 },
    { date: "2026-10-02", prompts: null },
    { date: "2026-10-09", prompts: 95 },
  ],
  engineSets: [
    { engines: ["chatgpt", "gemini"], prompts: 90 },
    { engines: [], prompts: 20 },
    { engines: ["gemini"], prompts: 10 },
  ],
  brands: ["Kia", "Hyundai", ""],
  markets: [
    { country: "DE", prompts: 100, brands: { Kia: 60, Hyundai: 40 } },
    { country: "KR", prompts: 15, brands: { Kia: 15 } },
    { country: "MIDDLEEAST", prompts: 5, brands: { "": 5 } },
  ],
  langCount: 2,
  siteCount: 1,
};

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnToastProvider>{node}</RnToastProvider>
    </NextIntlClientProvider>,
  );
const body = (p = page(ROWS), i = INSIGHTS) => wrap(<RnWebsitePrompts initial={p} initialInsights={i} />);
const w = ko.renewal.website.prompts;

beforeEach(() => {
  nav.search = "";
  sheet.lens = null;
  sheet.measured = undefined;
  exportButton.onClick = null;
});

describe("insights", () => {
  it("the KPI strip counts the list, the latest round's measured and missing prompts, and the engine sets", () => {
    const html = body();
    const kpis = html.slice(html.indexOf("data-rn-website-kpis"), html.indexOf("data-rn-website-insights"));
    for (const text of [w.kpi.prompts, "120", "타겟 도메인 1 · 국가 3 · 언어 2", w.kpi.latest, "95", "2026-10-09 회차 · 목록의 79.2%", w.kpi.missing, "25", "2026-10-09 회차 · 목록의 20.8%", w.engineSets.title, "ChatGPT · Gemini · 90개", w.engineSets.noEngine]) {
      expect(kpis, text).toContain(text);
    }
  });

  it("names none of what left: no card of its own, no KPI that never moved", () => {
    const html = body();
    const insights = html.slice(html.indexOf("data-rn-website-kpis"), html.indexOf("rn-website-prompt-list"));
    for (const text of [">측정된 프롬프트<", "측정 깊이", "data-rn-depth-chart", 'data-rn-bars="langs"', 'data-rn-bars="sites"', "ChatGPT 1,400"]) expect(insights, text).not.toContain(text);
  });

  it("the missing count opens the prompts the latest round left out; none missing is a plain 0", () => {
    expect(body()).toMatch(/data-rn-tip="2026-10-09 회차에 측정되지 않은 프롬프트만 목록에 남기기"/);
    const all = { ...INSIGHTS, rounds: [{ date: "2026-10-09", prompts: 120 }] };
    expect(body(page(ROWS), all)).not.toContain("측정되지 않은 프롬프트만");
  });

  it("draws one bar per round, the latest labelled, the list's size as the line, a week without a round as an empty slot", () => {
    const html = body();
    const chart = html.slice(html.indexOf("data-rn-rounds-chart"), html.indexOf("data-rn-markets-table"));
    // every round of the lens has its bar, one with none measured included
    expect(chart.match(/data-rn-tip="2026-[^"]+ 회차 · /g)).toHaveLength(3);
    expect(chart).toContain("2026-09-25 회차 · 0개 측정 (목록의 0.0%)");
    expect(chart).toContain("목록 120");
    // at the left end: a latest bar as tall as the list has its label under the line's, not over it (2026-11-02)
    expect(chart).toMatch(/-top-\[18px\] left-0[^>]*>목록 120</);
    expect(chart).toMatch(/data-rn-tip="2026-10-02 · 회차 없음"[^>]*data-rn-round-gap=""/);
    expect(chart).toContain(">10-02<");
    expect(chart).not.toContain('aria-label="2026-10-02');
    expect(html).toContain(">10-09<");
  });

  it("the market table puts the most empty brands first, one tint for a brand present", () => {
    const html = body();
    const table = html.slice(html.indexOf("data-rn-markets-table"));
    const countries = [...table.matchAll(/<th scope="row"[^>]*>.*?aria-label="([^"]+) — 국가 필터/g)].map((m) => m[1]);
    // two blanks first, more prompts first among them
    expect(countries).toEqual(["대한민국", ko.dashboard.filters.value.MIDDLEEAST, "독일"]);
    expect(html).toContain(w.markets.orderGaps);
    expect(html).toContain("시장 3 · 조합 4");
    expect(html).not.toContain("data-rn-markets-legend");
    expect(table).not.toMatch(/bg-rn-heat-/);
    expect(table).toContain("독일 · Kia · 60개");
    expect(table).toContain(w.markets.noBrand);
  });

  it("a pick in force is pressed and the other marks of its card fade", () => {
    nav.search = "rd=2026-10-09&eset=chatgpt~gemini";
    const html = body();
    expect(html).toMatch(/data-rn-tip="2026-10-09 회차 · 95개[^"]*"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-rn-tip="ChatGPT · Gemini · 90개[^"]*"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-rn-tip="2026-09-18 회차 · 40개[^"]*"[^>]*class="[^"]*opacity-35/);
  });
});

describe("list", () => {
  it("keeps every original field in one line per prompt, the engines as dots beside the count", () => {
    const html = body();
    const heads = [...html.matchAll(/<th scope="col"[^>]*><button[^>]*><span[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(["프롬프트", "브랜드", "시장", "타겟 URL", "측정 횟수", "최근 측정"]);
    expect(html.match(/data-rn-website-prompt-row="/g)).toHaveLength(2);
    expect(html).toContain("독일 · 독일어");
    expect(html).toContain(`${ko.dashboard.filters.value.MIDDLEEAST} · 아랍어`);
    expect(html).toContain('href="https://kia.com/de/models/ev6" target="_blank" rel="noreferrer noopener"');
    expect(html).toContain("1,234");
    expect(html).toContain("ChatGPT 700 · Gemini 534");
    expect(html.match(/data-engine="/g)).toHaveLength(2);
    expect(html).not.toContain("data-rn-round-strip");
    expect(html).toContain(ko.website.prompts.notMeasured);
    expect(html).toMatch(/aria-sort="descending"[^>]*><button[^>]*><span[^>]*>최근 측정</);
  });

  it("pages by number and names the engines it colours", () => {
    const html = body();
    expect(html).toContain("1–50 / 120");
    expect(html).toContain("1 / 3 페이지");
    expect(html).toContain("페이지당 100");
    const legend = html.slice(html.indexOf("data-rn-engine-legend"));
    expect(legend.indexOf("ChatGPT")).toBeLessThan(legend.indexOf("Gemini"));
  });

  it("shows the list's picks from the URL as tokens and counts against the list", () => {
    expect(body()).not.toContain("data-rn-drill");
    expect(body()).not.toContain("data-rn-jump");
    nav.search = "miss=2026-10-09&last=none";
    const html = body(page(ROWS, { total: 20, listed: 120 }));
    expect(html).toContain("data-rn-drill");
    expect(html).toContain(w.drill.label);
    expect(html).toContain("프롬프트 20개 / 목록 120개");
    expect(html).toContain(w.drill.clear);
    // the cards sit above the list: a jump to it says how many are left
    expect(html).toContain("좁힌 목록 20개 보기");
    expect(html).toContain("2026-10-09 회차에 미측정");
    expect(body()).toContain("data-rn-jump");
  });

  it("names the lens in force and says it does not drop rows", () => {
    expect(body()).not.toContain("data-rn-lens");
    nav.search = "engine=gemini&time=2026-09-01..2026-10-09";
    const html = body();
    expect(html).toContain("측정 렌즈 · Gemini · 2026-09-01 ~ 2026-10-09");
    expect(html).toContain(ko.website.prompts.lensHint);
  });

  it("an empty list says so, with no pager and no export", () => {
    const html = body(page([], { total: 0, pages: 1, rangeFrom: 0, rangeTo: 0 }));
    expect(html).toContain(ko.renewal.prompts.emptyFiltered);
    expect(html).not.toContain("페이지당");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?엑셀 다운로드/);
  });
});

// The lens's period (review r2-11, 2026-11-03). The BFF reads a `to` past the service week up to the week's last day
// (Context.create) and the header's basis chip names the rounds read, but the lens line and the detail sheet printed the
// URL's own range: '측정 렌즈 · 2026-10-01 ~ 2026-10-31' over a list of rounds up to 10-09. They print the period as it is
// read (shownTimeRange, as the applied chip: review r1-15), the pick in the line's title; the URL keeps the pick.
describe("the lens's period stops at the service week's end", () => {
  const WEEK: ServiceWeekView = { state: "ok", week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  const inWeek = () =>
    wrap(
      <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: true, surface: "website" }}>
        <RnWebsitePrompts initial={page(ROWS)} initialInsights={INSIGHTS} />
      </ServiceWeekContext.Provider>,
    );
  const lensOf = (html: string) => /<p data-rn-lens=""[^>]*>[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
  const textOf = (html: string) => html.replace(/<[^>]*>/g, "");

  it("a pick past the week prints up to the week's last day, in the line and the sheet; the pick is the line's title", () => {
    nav.search = "engine=gemini&time=2026-10-01..2026-10-31";
    const lens = lensOf(inWeek());
    expect(textOf(lens)).toContain("측정 렌즈 · Gemini · 2026-10-01 ~ 2026-10-11");
    expect(textOf(lens)).not.toContain("2026-10-31");
    expect(lens).toContain('title="고른 기간 2026-10-01 ~ 2026-10-31 중 서비스 기준 주의 끝(2026-10-11)까지 보입니다."');
    expect(sheet.lens).toEqual(["Gemini", "2026-10-01 ~ 2026-10-11"]);
  });

  it("a pick within the week or open-ended prints as picked, with no title", () => {
    for (const [time, shown] of [
      ["2026-09-01..2026-10-09", "2026-09-01 ~ 2026-10-09"],
      ["2026-09-01..", "2026-09-01 ~ …"],
    ]) {
      nav.search = `time=${time}`;
      const lens = lensOf(inWeek());
      expect(textOf(lens), time).toContain(`측정 렌즈 · ${shown}`);
      expect(lens, time).not.toContain("title=");
      expect(sheet.lens, time).toEqual([shown]);
    }
  });

  it("a pick that starts after the week (no round read) has no lens line: the week's card names it (review r4-4)", () => {
    nav.search = "time=2026-10-12..2026-11-01";
    const html = inWeek();
    expect(lensOf(html)).toBe("");
    expect(textOf(html)).toContain("고른 기간(2026-10-12 ~ 2026-11-01)은 서비스 기준 주 10월 2주차(10/5~10/11) 뒤입니다.");
    expect(sheet.measured).toBe(false);
  });

  it("no service week known (no shell provider): as picked, as before", () => {
    nav.search = "time=2026-10-01..2026-10-31";
    const lens = lensOf(body());
    expect(textOf(lens)).toContain("측정 렌즈 · 2026-10-01 ~ 2026-10-31");
    expect(lens).not.toContain("title=");
  });

  it("the first paint (the server render) holds the line to the layout's week; not known yet, the pick (review r3-6)", async () => {
    // the shell learns the week in its first effect: the line printed '2026-10-01 ~ 2026-10-31' until the page hydrated
    const { RnServiceWeekProvider } = await import("@/components/service-week/provider");
    const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
    const first = (week: Promise<ServiceWeekView | null>) =>
      lensOf(
        wrap(
          <RnServiceWeekProvider week={week} notes>
            <RnWebsitePrompts initial={page(ROWS)} initialInsights={INSIGHTS} />
          </RnServiceWeekProvider>,
        ),
      );
    nav.search = "engine=gemini&time=2026-10-01..2026-10-31";
    const lens = first(settled(WEEK));
    expect(textOf(lens)).toContain("측정 렌즈 · Gemini · 2026-10-01 ~ 2026-10-11");
    expect(lens).toContain('title="고른 기간 2026-10-01 ~ 2026-10-31 중 서비스 기준 주의 끝(2026-10-11)까지 보입니다."');
    for (const week of [new Promise<ServiceWeekView | null>(() => {}), settled(null)]) {
      expect(textOf(first(week))).toContain("측정 렌즈 · Gemini · 2026-10-01 ~ 2026-10-31");
    }
  });
});

// A period that starts after the service week (review r4-4, 2026-11-03). The BFF reads no round of it (Context.create: a
// `from` after the week selects nothing), so the lens held none: the page said '엔진 없음 (미측정) 12,729' over an empty
// 회차별 chart and '— 측정 없음' on every row — of prompts Gold measured in rounds after the week — and nothing on it named
// the week (the other pages say '아직 보이지 않는 기간', review r3-12). The lens's results give way to that card; the rows
// stay with their catalog columns (the period is a lens: it never drops a row), and no row, sheet or file says what the
// lens measured.
describe("a period that starts after the service week", () => {
  const WEEK: ServiceWeekView = { state: "ok", week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  // website/prompts-page and -insights for time=2026-10-19..2026-10-25 under the week of 10-05 (live, 2026-11-03)
  const UNREAD = [
    row("a", { answers: 0, lastMeasuredAt: null, firstMeasuredAt: null, engines: [], rounds: [], engineAnswers: {} }),
    row("b", { brand: "", countryCode: "MIDDLEEAST", langCode: "ar", answers: 0, lastMeasuredAt: null, firstMeasuredAt: null, engines: [], rounds: [], engineAnswers: {} }),
  ];
  const NO_LENS: WebsitePromptInsights = { ...INSIGHTS, engines: [], rounds: [], engineSets: [{ engines: [], prompts: 120 }] };
  const AFTER = "고른 기간(2026-10-19 ~ 2026-10-25)은 서비스 기준 주 10월 2주차(10/5~10/11) 뒤입니다. Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.";
  const inWeek = (search: string, p = page(UNREAD, { roundAxis: [] }), i = NO_LENS) => {
    nav.search = search;
    return wrap(
      <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: true, surface: "website" }}>
        <RnWebsitePrompts initial={p} initialInsights={i} />
      </ServiceWeekContext.Provider>,
    );
  };
  const textOf = (html: string) => html.replace(/<[^>]*>/g, "");
  const heads = (html: string) => [...html.matchAll(/<th scope="col"[^>]*><button[^>]*><span[^>]*>([^<]+)</g)].map((m) => m[1]);

  it("names the week in place of the lens's results: no insights, no measured column, no lens line", () => {
    const html = inWeek("engine=gemini&time=2026-10-19..2026-10-25");
    expect(textOf(html)).toContain(`${ko.serviceWeek.afterWeek.title}${AFTER}`);
    for (const gone of ["data-rn-website-kpis", "data-rn-rounds-chart", "data-rn-markets-table", w.engineSets.noEngine, ko.website.prompts.notMeasured, "data-rn-lens", "data-engine="]) {
      expect(html, gone).not.toContain(gone);
    }
    // the rows stay, with what they are: the prompt, its brand, market and target
    expect(html.match(/data-rn-website-prompt-row="/g)).toHaveLength(2);
    expect(heads(html)).toEqual(["프롬프트", "브랜드", "시장", "타겟 URL"]);
    for (const kept of ["prompt a", "독일 · 독일어", 'href="https://kia.com/de/models/ev6"', "프롬프트 120개", "1–50 / 120"]) expect(html, kept).toContain(kept);
    // the sheet a row opens shows no measurement either
    expect(sheet.measured).toBe(false);
  });

  it("a period that reads rounds — inside the week, before it, with no start — keeps the lens as before", () => {
    for (const time of ["2026-10-05..2026-10-11", "2026-09-01..2026-09-30", "..2026-10-25"]) {
      const html = inWeek(`time=${time}`, page(ROWS), INSIGHTS);
      expect(html, time).not.toContain(ko.serviceWeek.afterWeek.title);
      expect(html, time).toContain("data-rn-website-kpis");
      expect(html, time).toContain("data-rn-lens");
      expect(heads(html), time).toEqual(["프롬프트", "브랜드", "시장", "타겟 URL", "측정 횟수", "최근 측정"]);
      expect(sheet.measured, time).toBe(true);
    }
  });

  it("no service week known (no shell provider): as before", () => {
    nav.search = "time=2026-10-19..2026-10-25";
    const html = body(page(UNREAD, { roundAxis: [] }), NO_LENS);
    expect(html).not.toContain(ko.serviceWeek.afterWeek.title);
    expect(html).toContain("data-rn-website-kpis");
    expect(html).toContain(ko.website.prompts.notMeasured);
  });

  it("the first paint takes the layout's read; while it is not known, the page as before and nothing waits", async () => {
    const { RnServiceWeekProvider } = await import("@/components/service-week/provider");
    const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
    const first = (week: Promise<ServiceWeekView | null>) =>
      wrap(
        <RnServiceWeekProvider week={week} notes>
          <RnWebsitePrompts initial={page(UNREAD, { roundAxis: [] })} initialInsights={NO_LENS} />
        </RnServiceWeekProvider>,
      );
    nav.search = "time=2026-10-19..2026-10-25";
    const html = first(settled(WEEK));
    expect(textOf(html)).toContain(AFTER);
    expect(heads(html)).toEqual(["프롬프트", "브랜드", "시장", "타겟 URL"]);
    for (const week of [new Promise<ServiceWeekView | null>(() => {}), settled(null)]) {
      const before = first(week);
      expect(before).not.toContain(ko.serviceWeek.afterWeek.title);
      expect(before.match(/data-rn-website-prompt-row="/g)).toHaveLength(2);
    }
  });

  it("the detail sheet carries the prompt and its attributes, no measurement", () => {
    const html = wrap(<RnWebsitePromptDetail row={UNREAD[0]} axis={[]} lens={["2026-10-19 ~ 2026-10-25"]} measured={false} onClose={() => {}} />);
    for (const kept of [ko.renewal.prompts.detail.title, "prompt a", "독일 (DE)", "kia.com/de/models/ev6"]) expect(html, kept).toContain(kept);
    for (const gone of [`>${w.measurement}<`, "측정 렌즈", ko.website.prompts.notMeasured, "data-rn-round-strip"]) expect(html, gone).not.toContain(gone);
  });

  it("the export writes the rows' catalog columns; a period that reads rounds writes the lens's too", async () => {
    const rowsRead = vi.fn(async () => ({ rows: UNREAD, roundAxis: [] as string[] }));
    const sheetOf = async (search: string) => {
      vi.mocked(downloadXlsx).mockClear();
      nav.search = search;
      wrap(
        <ServiceWeekContext.Provider value={{ initial: Promise.resolve(WEEK), latest: WEEK, applies: true, surface: "website" }}>
          <RnWebsitePrompts initial={page(UNREAD, { roundAxis: [] })} initialInsights={NO_LENS} readRows={rowsRead} />
        </ServiceWeekContext.Provider>,
      );
      vi.stubGlobal("window", { location: { search: `?${search}` } });
      try {
        await exportButton.onClick?.();
      } finally {
        vi.unstubAllGlobals();
      }
      const [, headers, cells] = vi.mocked(downloadXlsx).mock.calls[0] ?? [];
      return { headers, cells };
    };
    const after = await sheetOf("time=2026-10-19..2026-10-25");
    expect(after.headers).toEqual(["프롬프트", "브랜드", "국가", "언어", "타겟 URL"]);
    expect(after.cells).toEqual([
      ["prompt a", "Kia", "독일", "독일어", "kia.com/de/models/ev6"],
      ["prompt b", "", ko.dashboard.filters.value.MIDDLEEAST, "아랍어", "kia.com/de/models/ev6"],
    ]);
    const within = await sheetOf("time=2026-10-05..2026-10-11");
    expect(within.headers?.slice(0, 7)).toEqual(["프롬프트", "브랜드", "국가", "언어", "타겟 URL", "측정 횟수", "최근 측정"]);
  });
});

describe("detail sheet", () => {
  it("carries the full text, the attributes and the measurement: engines, first and latest, every round on its strip", () => {
    const html = wrap(<RnWebsitePromptDetail row={ROWS[0]} axis={AXIS} lens={["Gemini"]} onClose={() => {}} />);
    expect(html).toContain("data-rn-round-strip");
    for (const text of [ko.renewal.prompts.detail.title, "prompt a", "독일 (DE)", "독일어 (DE)", "kia.com/de/models/ev6", ">kia.com<", "측정 렌즈 Gemini 범위의 값입니다.", "700", "534", "2/3회차", "2026-10-02 · 2026-10-09"]) {
      expect(html, text).toContain(text);
    }
    expect(wrap(<RnWebsitePromptDetail row={null} axis={AXIS} lens={[]} onClose={() => {}} />)).not.toContain(ko.renewal.prompts.detail.title);
  });
});

describe("the URL the list keeps", () => {
  const sort = { key: "lastMeasuredAt" as const, asc: false };
  it("keeps the panel's filters and drops the list's defaults", () => {
    expect(withList("geography=DE&engine=gemini&q=old&size=25&miss=2026-10-09", { q: "  ", sort, size: 50 }).toString()).toBe("geography=DE&engine=gemini");
  });
  it("writes a search, a non-default order and size, the picks, and a page only past the first", () => {
    const p = withList("geography=DE", { q: " ev ", sort: { key: "rounds", asc: true }, size: 100, page: 3, drill: { miss: "2026-10-09", eset: "chatgpt~gemini" } });
    expect(Object.fromEntries(p)).toEqual({ geography: "DE", q: "ev", sort: "rounds", dir: "asc", size: "100", page: "3", miss: "2026-10-09", eset: "chatgpt~gemini" });
  });
  it("reads only well-formed picks", () => {
    expect(readDrill(new URLSearchParams("rd=2026-10-09&miss=2026-10-02&last=none&eset=GEMINI~chatgpt"))).toEqual({ rd: "2026-10-09", miss: "2026-10-02", last: "none", eset: "chatgpt~gemini" });
    expect(readDrill(new URLSearchParams("m=1&ans=3&rd=today&miss=x&last=x"))).toEqual({});
    expect(engineSetKey([])).toBe("none");
  });
});
