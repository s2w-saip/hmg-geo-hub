import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { WebsitePromptInsights, WebsitePromptRow, WebsitePromptsPage } from "./website-prompt-model";

// Renewal Website › Prompts body (2026-10-30, W4): the insights (KPI strip + six cards, every number one the
// screens sent), the list keeping every original field (prompt, brand, country · language, target URL, answers
// with their engines, latest measurement) plus the rows' measured rounds, the list's picks from the URL, the
// lens line, the detail sheet, and the URL the list keeps.

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/website/prompts",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("./website-prompts-read", () => ({ readWebsitePromptsPage: vi.fn(), readWebsitePromptRows: vi.fn(), readWebsitePromptInsights: vi.fn() }));
vi.mock("../../../_components/overview-filters", () => ({ useRnFilterToggle: () => () => {} }));

const { RnToastProvider } = await import("@/components/renewal-ui");
const { RnWebsitePrompts } = await import("./website-prompts-view");
const { RnWebsitePromptDetail } = await import("./website-prompt-list");
const { readDrill, withList, engineSetKey } = await import("./website-prompt-model");

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
  measured: 100,
  answers: 2468,
  roundAxis: AXIS,
  engines: [
    { engine: "gemini", prompts: 100, answers: 1068 },
    { engine: "chatgpt", prompts: 90, answers: 1400 },
  ],
  rounds: [
    { date: "2026-09-25", prompts: 0 },
    { date: "2026-10-02", prompts: 80 },
    { date: "2026-10-09", prompts: 95 },
  ],
  lastMeasured: [
    { date: "2026-10-09", prompts: 95 },
    { date: "2026-10-02", prompts: 5 },
    { date: null, prompts: 20 },
  ],
  depth: [
    { answers: 0, prompts: 20 },
    { answers: 12, prompts: 100 },
  ],
  engineSets: [
    { engines: ["chatgpt", "gemini"], prompts: 90 },
    { engines: [], prompts: 20 },
    { engines: ["gemini"], prompts: 10 },
  ],
  brands: [
    { brand: "Kia", prompts: 100, measured: 90, answers: 2000 },
    { brand: "", prompts: 20, measured: 10, answers: 468 },
  ],
  markets: [
    { country: "DE", prompts: 100, brands: { Kia: 100 } },
    { country: "MIDDLEEAST", prompts: 20, brands: { "": 20 } },
  ],
  langs: [
    { lang: "de", prompts: 100, measured: 90, answers: 2000 },
    { lang: "ar", prompts: 20, measured: 10, answers: 468 },
  ],
  sites: [{ domain: "kia.com", prompts: 120, measured: 100, answers: 2468 }],
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
});

describe("insights", () => {
  it("the KPI strip shows the screen's counts", () => {
    const html = body();
    const kpis = html.slice(html.indexOf("data-rn-website-kpis"), html.indexOf("data-rn-website-insights"));
    for (const text of [w.kpi.prompts, "120", "타겟 도메인 1 · 국가 2 · 언어 2", w.kpi.measured, "100", "목록의 83.3%", "미측정 20", "2,468", "ChatGPT 1,400", "Gemini 1,068", "3회", "2026-09-25 ~ 2026-10-09", "95", "2026-10-09 회차 · 목록의 79.2%"]) {
      expect(kpis, text).toContain(text);
    }
    // ChatGPT before Gemini whatever order the screen sent (fixed engine order and colour)
    expect(kpis.indexOf("ChatGPT")).toBeLessThan(kpis.indexOf("Gemini"));
  });

  it("draws one bar per round, the latest labelled, the list's size as the line", () => {
    const html = body();
    const chart = html.slice(html.indexOf("data-rn-rounds-chart"), html.indexOf("data-rn-depth"));
    // every round of the lens has its bar, one with none measured included
    expect(chart.match(/data-rn-tip="2026-[^"]+ 회차 · /g)).toHaveLength(3);
    expect(chart).toContain("2026-09-25 회차 · 0개 측정 (목록의 0.0%)");
    expect(chart).toContain("2026-10-02 회차 · 80개 측정 (목록의 66.7%)");
    expect(chart).toContain("목록 120");
    expect(html).toContain(">10-09<");
  });

  it("the depth and engine-set cards list every value; no latest-round card (each row's 최근 측정 stays in the list)", () => {
    const html = body();
    expect(html).not.toContain("data-rn-last-chart");
    expect(html).toContain("측정 12회 · 100개 (목록의 83.3%)");
    expect(html).toContain("ChatGPT · Gemini · 90개");
    expect(html).toContain(w.depth.noEngine);
  });

  it("the market table crosses site country and brand, a nameless brand named as such", () => {
    const html = body();
    const table = html.slice(html.indexOf("data-rn-markets-table"));
    expect(table).toContain(ko.dashboard.filters.value.MIDDLEEAST);
    expect(table).toContain(w.markets.noBrand);
    expect(table).toContain("독일 · Kia · 100개");
  });

  it("a pick in force is pressed and the other marks of its card fade", () => {
    nav.search = "rd=2026-10-09&eset=chatgpt~gemini";
    const html = body();
    expect(html).toMatch(/data-rn-tip="2026-10-09 회차 · 95개[^"]*"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-rn-tip="ChatGPT · Gemini · 90개[^"]*"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-rn-tip="2026-10-02 회차 · 80개[^"]*"[^>]*class="[^"]*opacity-35/);
  });
});

describe("list", () => {
  it("keeps every original field in one line per prompt, with the measured rounds", () => {
    const html = body();
    const heads = [...html.matchAll(/<th scope="col"[^>]*><button[^>]*><span[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(["프롬프트", "브랜드", "시장", "타겟 URL", "측정 회차", "측정 횟수", "최근 측정"]);
    expect(html.match(/data-rn-website-prompt-row="/g)).toHaveLength(2);
    expect(html).toContain("독일 · 독일어");
    expect(html).toContain(`${ko.dashboard.filters.value.MIDDLEEAST} · 아랍어`);
    expect(html).toContain('href="https://kia.com/de/models/ev6" target="_blank" rel="noreferrer noopener"');
    expect(html).toContain("1,234");
    expect(html).toContain("ChatGPT 700 · Gemini 534");
    expect(html).toContain("측정 2/3회차 · 첫 측정 2026-10-02 · 최근 2026-10-09");
    expect(html).toContain(w.columns.roundsNone);
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
    nav.search = "m=0&last=none&ans=0";
    const html = body(page(ROWS, { total: 20, listed: 120 }));
    expect(html).toContain("data-rn-drill");
    expect(html).toContain(w.drill.label);
    expect(html).toContain("프롬프트 20개 / 목록 120개");
    expect(html).toContain(w.drill.clear);
    // the cards sit above the list: a jump to it says how many are left
    expect(html).toContain("좁힌 목록 20개 보기");
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

describe("detail sheet", () => {
  it("carries the full text, the attributes and the measurement: engines, first and latest, every round", () => {
    const html = wrap(<RnWebsitePromptDetail row={ROWS[0]} axis={AXIS} lens={["Gemini"]} onClose={() => {}} />);
    for (const text of [ko.renewal.prompts.detail.title, "prompt a", "독일 (DE)", "독일어 (DE)", "kia.com/de/models/ev6", ">kia.com<", "측정 렌즈 Gemini 범위의 값입니다.", "700", "534", "2/3회차", "2026-10-02 · 2026-10-09"]) {
      expect(html, text).toContain(text);
    }
    expect(wrap(<RnWebsitePromptDetail row={null} axis={AXIS} lens={[]} onClose={() => {}} />)).not.toContain(ko.renewal.prompts.detail.title);
  });
});

describe("the URL the list keeps", () => {
  const sort = { key: "lastMeasuredAt" as const, asc: false };
  it("keeps the panel's filters and drops the list's defaults", () => {
    expect(withList("geography=DE&engine=gemini&q=old&size=25&m=0", { q: "  ", sort, size: 50 }).toString()).toBe("geography=DE&engine=gemini");
  });
  it("writes a search, a non-default order and size, the picks, and a page only past the first", () => {
    const p = withList("geography=DE", { q: " ev ", sort: { key: "rounds", asc: true }, size: 100, page: 3, drill: { m: "1", eset: "chatgpt~gemini", ans: 0 } });
    expect(Object.fromEntries(p)).toEqual({ geography: "DE", q: "ev", sort: "rounds", dir: "asc", size: "100", page: "3", m: "1", eset: "chatgpt~gemini", ans: "0" });
  });
  it("reads only well-formed picks", () => {
    expect(readDrill(new URLSearchParams("m=1&rd=2026-10-09&last=none&eset=GEMINI~chatgpt&ans=3"))).toEqual({ m: "1", rd: "2026-10-09", last: "none", eset: "chatgpt~gemini", ans: 3 });
    expect(readDrill(new URLSearchParams("m=2&rd=today&last=x&ans=-1"))).toEqual({});
    expect(engineSetKey([])).toBe("none");
  });
});
