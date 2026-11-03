import { describe, expect, it, vi } from "vitest";
import { Suspense, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { ServiceWeekView } from "@/lib/service-week";

// A surface with no round in the service week (decision '기준 주 세부', 2026-11-02: it does not hold the week back, and
// its '측정 없음' is shown as it is). Review r1-19 (2026-11-03): under a week with no Website round (07-27..08-02 on live
// Gold: Global 07-27 only) the BFF reads no Website snapshot, and the pages said '이 필터 조합에는 측정 결과가 없습니다 …
// 필터를 줄이거나 초기화해 보세요' with a reset that cannot bring a round back, '측정 데이터가 아직 없습니다', or drew a
// measured page of 0 citations. Where a page's read came back empty and it reads its surface's snapshot, the empty
// state names the week instead — and where its period starts after the week, of which the BFF reads no round (review
// r3-12).

const nav = vi.hoisted(() => ({ path: "/ko/renewal/website/answer-analysis/mention", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));

const { RnServiceWeekProvider } = await import("./provider");
const { RnServiceWeekEmpty, RnServiceWeekEmptyLine, ServiceWeekAfterWeek, ServiceWeekNoRoundNotice } = await import("./no-round");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const W0727 = { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 };
// shared/service-week for the week of 07-27 (review r1-19: r11_sim on live Gold, the HUB week faked)
const NO_WEBSITE: ServiceWeekView = { state: "ok", week: W0727, delay: null, checkedAt: null, recordedAt: null, rounds: { global: true, website: false }, notes: [] };
const BOTH: ServiceWeekView = { ...NO_WEBSITE, rounds: { global: true, website: true } };
const UNCONFIGURED: ServiceWeekView = { state: "unconfigured", week: null, delay: null, checkedAt: null, recordedAt: null, rounds: null, notes: [] };

const WEBSITE = "/ko/renewal/website/answer-analysis/mention";
const GLOBAL = "/ko/renewal/standard/answer-analysis/mention";

function html(week: Promise<ServiceWeekView | null> | null, node: ReactNode, at: { path: string; search: string }, locale: "ko" | "en" = "ko") {
  nav.path = at.path;
  nav.search = at.search;
  const tree = week ? <RnServiceWeekProvider week={week} notes>{node}</RnServiceWeekProvider> : node;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {tree}
    </NextIntlClientProvider>,
  );
}
const text = (out: string) => out.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "").replace(/&#x27;/g, "'");
// a page's empty branch: its own state (a filter-empty card with a reset), or the card the page draws for the week
const body = <RnServiceWeekEmpty render={(n) => <section data-card=""><h2>{n.title}</h2><p>{n.desc}</p></section>}><p>OWN EMPTY<button>필터 초기화</button></p></RnServiceWeekEmpty>;
const empty = (view: ServiceWeekView | null, at: { path: string; search: string }, locale: "ko" | "en" = "ko") => text(html(settled(view), body, at, locale));

describe("RnServiceWeekEmpty: a snapshot page whose surface the service week holds no round of", () => {
  it("says 측정 없음 and names the week, in place of the page's own empty state and its reset", () => {
    for (const search of ["", "engine=chatgpt", "geography=US&brand=Kia"]) {
      expect(empty(NO_WEBSITE, { path: WEBSITE, search }), search).toBe("측정 없음|서비스 기준 주 7월 5주차(7/27~8/2)에는 Website 측정 회차가 없습니다.");
    }
    // Website Overview and Citation alike: the surface is the page's
    expect(empty(NO_WEBSITE, { path: "/ko/renewal/website", search: "" })).toContain("Website 측정 회차가 없습니다");
    expect(empty(NO_WEBSITE, { path: "/ko/renewal/website/answer-analysis/citation", search: "" })).toContain("Website 측정 회차가 없습니다");
  });

  it("a Global page of a week with no Global round likewise", () => {
    const noGlobal: ServiceWeekView = { ...NO_WEBSITE, rounds: { global: false, website: true } };
    expect(empty(noGlobal, { path: GLOBAL, search: "" })).toBe("측정 없음|서비스 기준 주 7월 5주차(7/27~8/2)에는 Global 측정 회차가 없습니다.");
    expect(empty(noGlobal, { path: "/ko/renewal/standard/ai-funnel/acr", search: "language=en" })).toContain("Global 측정 회차가 없습니다");
    expect(empty(noGlobal, { path: WEBSITE, search: "" })).toBe("OWN EMPTY|필터 초기화");
  });

  it("the page's own empty state otherwise: a period, a surface with a round, an answer that does not say, no week", () => {
    const own = "OWN EMPTY|필터 초기화";
    // a period reads the rounds before the week too: its empty state is the period's (the reset does bring rounds back)
    expect(empty(NO_WEBSITE, { path: WEBSITE, search: "time=2026-07-01..2026-07-31" })).toBe(own);
    expect(empty(NO_WEBSITE, { path: WEBSITE, search: "time=..2026-08-02" })).toBe(own);
    expect(empty(NO_WEBSITE, { path: GLOBAL, search: "" })).toBe(own);
    expect(empty(BOTH, { path: WEBSITE, search: "engine=chatgpt" })).toBe(own);
    expect(empty({ ...NO_WEBSITE, rounds: undefined }, { path: WEBSITE, search: "" })).toBe(own);
    expect(empty(UNCONFIGURED, { path: WEBSITE, search: "" })).toBe(own);
    // the shell's read failed (the chip says so)
    expect(empty(null, { path: WEBSITE, search: "" })).toBe(own);
  });

  it("not on a page the week does not hold (Project, GA4 days), nor without the shell's provider", () => {
    expect(empty(NO_WEBSITE, { path: "/ko/renewal/website/ai-funnel/conversion", search: "" })).toBe("OWN EMPTY|필터 초기화");
    expect(empty(NO_WEBSITE, { path: "/ko/renewal/projects", search: "" })).toBe("OWN EMPTY|필터 초기화");
    // no provider: nothing is read and no message is looked up
    nav.search = "";
    expect(renderToStaticMarkup(body)).toBe("<p>OWN EMPTY<button>필터 초기화</button></p>");
  });

  it("waits for the shell's read of the week (the page's own Suspense shows meanwhile)", () => {
    const out = html(new Promise<ServiceWeekView | null>(() => {}), <Suspense fallback={<i>SKELETON</i>}>{body}</Suspense>, { path: WEBSITE, search: "" });
    expect(text(out)).toBe("SKELETON");
    // a period that starts after a day waits too (is it after the week?); one with no start is the page's at once
    const at = (search: string) => text(html(new Promise<ServiceWeekView | null>(() => {}), <Suspense fallback={<i>SKELETON</i>}>{body}</Suspense>, { path: WEBSITE, search }));
    expect(at("time=2026-08-03..2026-08-09")).toBe("SKELETON");
    expect(at("time=..2026-08-09")).toBe("OWN EMPTY|필터 초기화");
  });

  it("a period that starts after the week: the BFF reads no round of it on either surface — it names the week, not the filters (review r3-12)", () => {
    // review r3-12 (2026-11-03): time=2026-10-12..2026-10-18 under the week of 10-05 — Mention blamed the filters,
    // Citation drew zeros under '공식(HMG) 카테고리가 출처 필터에서 빠져 있습니다'
    const AFTER = "아직 보이지 않는 기간|고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다. Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.";
    for (const view of [NO_WEBSITE, BOTH]) {
      expect(empty(view, { path: WEBSITE, search: "time=2026-08-03..2026-08-09" })).toBe(AFTER);
      expect(empty(view, { path: GLOBAL, search: "time=2026-08-03..2026-08-09&engine=chatgpt" })).toBe(AFTER);
      expect(empty(view, { path: "/ko/renewal/standard/answer-analysis/citation", search: "time=2026-08-03..2026-08-09" })).toBe(AFTER);
    }
    // an open end, and a reversed range read as the BFF reads it (swapped)
    expect(empty(BOTH, { path: WEBSITE, search: "time=2026-08-03.." })).toBe(
      "아직 보이지 않는 기간|고른 기간(2026-08-03 ~ …)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다. Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.",
    );
    expect(empty(BOTH, { path: WEBSITE, search: "time=2026-08-09..2026-08-03" })).toBe(AFTER);
    // a period that reaches into the week or ends before it reads rounds: the page's own state
    for (const time of ["2026-07-27..2026-08-09", "2026-08-02..2026-08-09", "..2026-08-09", "2026-07-01..2026-07-26"]) {
      expect(empty(BOTH, { path: WEBSITE, search: `time=${time}` }), time).toBe("OWN EMPTY|필터 초기화");
    }
    // no week, the shell's read failed, a page the week does not hold: nothing is said
    expect(empty(UNCONFIGURED, { path: WEBSITE, search: "time=2026-08-03..2026-08-09" })).toBe("OWN EMPTY|필터 초기화");
    expect(empty(null, { path: WEBSITE, search: "time=2026-08-03..2026-08-09" })).toBe("OWN EMPTY|필터 초기화");
    expect(empty(BOTH, { path: "/ko/renewal/website/ai-funnel/conversion", search: "time=2026-08-03..2026-08-09" })).toBe("OWN EMPTY|필터 초기화");
    expect(empty(BOTH, { path: "/en/renewal/website/answer-analysis/mention", search: "time=2026-08-03..2026-08-09" }, "en")).toBe(
      "Period not shown yet|The picked period (2026-08-03 ~ 2026-08-09) is after the service week Jul week 5 (7/27–8/2). Gold's measurement results are shown only for rounds completed up to that week.",
    );
  });

  it("the line of a server page's empty notice (Overview · Website Overview: RnEmpty)", () => {
    const line = <RnServiceWeekEmptyLine>측정 데이터가 아직 없습니다</RnServiceWeekEmptyLine>;
    expect(text(html(settled(NO_WEBSITE), line, { path: "/ko/renewal/website", search: "" }))).toBe(
      "측정 없음| — 서비스 기준 주 7월 5주차(7/27~8/2)에는 Website 측정 회차가 없습니다.",
    );
    expect(text(html(settled(BOTH), line, { path: "/ko/renewal/website", search: "" }))).toBe("측정 데이터가 아직 없습니다");
  });

  it("reads in English too", () => {
    expect(empty(NO_WEBSITE, { path: "/en/renewal/website/answer-analysis/mention", search: "" }, "en")).toBe(
      "No measurement|The service week Jul week 5 (7/27–8/2) has no Website round.",
    );
  });
});

// A page whose period is a lens over rows it keeps (Website Prompts: the period chooses the answers a row counts, never
// the rows). Review r4-4 (2026-11-03): with a period after the week the lens held no round, and the page said '엔진 없음
// (미측정) 12,729' over an empty 회차별 chart and '측정 없음' on every row — of prompts Gold measured after the week — with
// nothing naming the week. What it draws of the lens takes the week's text then; its rows stay.
describe("ServiceWeekAfterWeek: the lens of a period after the week (review r4-4)", () => {
  const probe = <ServiceWeekAfterWeek>{(n) => <p>{n ? `${n.title}|${n.desc}` : "LENS"}</p>}</ServiceWeekAfterWeek>;
  const lens = (view: ServiceWeekView | null, at: { path: string; search: string }, locale: "ko" | "en" = "ko") => text(html(settled(view), probe, at, locale));
  const WP = "/ko/renewal/website/prompts";

  it("the week's text for a period that starts after the week, whatever rounds the week holds", () => {
    for (const view of [NO_WEBSITE, BOTH]) {
      expect(lens(view, { path: WP, search: "time=2026-08-03..2026-08-09&engine=gemini" })).toBe(
        "아직 보이지 않는 기간|고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다. Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.",
      );
    }
    expect(lens(BOTH, { path: "/en/renewal/website/prompts", search: "time=2026-08-03.." }, "en")).toBe(
      "Period not shown yet|The picked period (2026-08-03 ~ …) is after the service week Jul week 5 (7/27–8/2). Gold's measurement results are shown only for rounds completed up to that week.",
    );
  });

  it("the lens otherwise: no period (the page shows every round: 측정 없음 is not its to say), a period that reads rounds, no week, no provider", () => {
    expect(lens(NO_WEBSITE, { path: WP, search: "" })).toBe("LENS");
    for (const time of ["2026-07-27..2026-08-09", "..2026-08-09", "2026-07-01..2026-07-26"]) {
      expect(lens(BOTH, { path: WP, search: `time=${time}` }), time).toBe("LENS");
    }
    expect(lens(UNCONFIGURED, { path: WP, search: "time=2026-08-03..2026-08-09" })).toBe("LENS");
    expect(lens(null, { path: WP, search: "time=2026-08-03..2026-08-09" })).toBe("LENS");
    expect(lens(BOTH, { path: "/ko/renewal/website/ai-funnel/conversion", search: "time=2026-08-03..2026-08-09" })).toBe("LENS");
    // no provider: nothing is read and no message is looked up
    nav.search = "time=2026-08-03..2026-08-09";
    expect(renderToStaticMarkup(probe)).toBe("<p>LENS</p>");
  });

  it("until the shell's read of the week is known: the lens, and nothing around it waits", () => {
    const out = html(new Promise<ServiceWeekView | null>(() => {}), <Suspense fallback={<i>SKELETON</i>}>{probe}<b>ROWS</b></Suspense>, { path: WP, search: "time=2026-08-03..2026-08-09" });
    expect(text(out)).toBe("LENS|ROWS");
  });
});

describe("ServiceWeekNoRoundNotice: the original (dash) screens (review r2-12)", () => {
  // The original screens draw an empty read as they always have: '측정 데이터가 아직 없습니다' (Overview, Website), or — the
  // reads of no round still answer counts of 0 — a measured page of zeros: under the week of 07-27 (live Gold, in
  // process) mention/view answers 총 언급 0 · 고유 브랜드 0 and citation/website 0 citations, which Website 언급 · 인용
  // draw (they go empty only without data). One note at the top of main says the week holds no round of the page's
  // surface, in the slot of the delay note; the page itself stays as it is.
  const notice = (view: ServiceWeekView | null, at: { path: string; search: string }, locale: "ko" | "en" = "ko") =>
    text(html(settled(view), <ServiceWeekNoRoundNotice />, at, locale));
  const LINE = "측정 없음| — 서비스 기준 주 7월 5주차(7/27~8/2)에는 Website 측정 회차가 없습니다.";

  it("names the week on a page of the surface the week holds no round of, read with no period", () => {
    for (const path of ["/ko/website", "/ko/website/answer-analysis/mention", "/ko/website/answer-analysis/citation"]) {
      expect(notice(NO_WEBSITE, { path, search: "" }), path).toBe(LINE);
    }
    expect(notice(NO_WEBSITE, { path: "/ko/website/answer-analysis/mention", search: "geography=US&engine=chatgpt" })).toBe(LINE);
    const noGlobal: ServiceWeekView = { ...NO_WEBSITE, rounds: { global: false, website: true } };
    expect(notice(noGlobal, { path: "/ko/dashboard", search: "" })).toBe("측정 없음| — 서비스 기준 주 7월 5주차(7/27~8/2)에는 Global 측정 회차가 없습니다.");
    expect(notice(NO_WEBSITE, { path: "/en/website/answer-analysis/mention", search: "" }, "en")).toBe(
      "No measurement| — The service week Jul week 5 (7/27–8/2) has no Website round.",
    );
  });

  it("nothing otherwise: a period, a surface with a round, an answer that does not say, Project · GA4 pages, no provider", () => {
    expect(notice(NO_WEBSITE, { path: "/ko/website/answer-analysis/mention", search: "time=2026-07-01..2026-07-31" })).toBe("");
    expect(notice(NO_WEBSITE, { path: "/ko/dashboard", search: "" })).toBe("");
    expect(notice(BOTH, { path: "/ko/website", search: "" })).toBe("");
    expect(notice({ ...NO_WEBSITE, rounds: undefined }, { path: "/ko/website", search: "" })).toBe("");
    expect(notice(UNCONFIGURED, { path: "/ko/website", search: "" })).toBe("");
    expect(notice(null, { path: "/ko/website", search: "" })).toBe("");
    expect(notice(NO_WEBSITE, { path: "/ko/projects/c0000000-0000-4000-8000-000000000003", search: "" })).toBe("");
    expect(notice(NO_WEBSITE, { path: "/ko/website/ai-funnel/conversion", search: "" })).toBe("");
    nav.search = "";
    expect(renderToStaticMarkup(<ServiceWeekNoRoundNotice />)).toBe("");
  });

  it("not on Prompts (Global · Website): with no period they read every round, and their rows are measured (review r3-11)", () => {
    // review r3-11 (2026-11-03): under the week of 07-27 /ko/website/prompts listed rows (답변 5, 마지막 측정 07-24)
    // below '측정 없음 — … Website 측정 회차가 없습니다'; /ko/standard/prompts (Gold's catalog of every round) likewise
    const noGlobal: ServiceWeekView = { ...NO_WEBSITE, rounds: { global: false, website: true } };
    expect(notice(NO_WEBSITE, { path: "/ko/website/prompts", search: "" })).toBe("");
    expect(notice(NO_WEBSITE, { path: "/en/website/prompts", search: "geography=US" }, "en")).toBe("");
    expect(notice(noGlobal, { path: "/ko/standard/prompts", search: "" })).toBe("");
    expect(notice(noGlobal, { path: "/ko/standard/prompts", search: "tab=history" })).toBe("");
    // the snapshot pages of the same surfaces still name the week
    expect(notice(NO_WEBSITE, { path: "/ko/website/answer-analysis/mention", search: "" })).toBe(LINE);
    expect(notice(noGlobal, { path: "/ko/standard/answer-analysis/mention", search: "" })).toContain("Global 측정 회차가 없습니다");
  });

  it("a period that starts after the week: the note names the week on a page that reads the period, not on Global Prompts (review r3-12, r4-4)", () => {
    const AFTER = "아직 보이지 않는 기간| — 고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다. Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.";
    const EN_AFTER =
      "Period not shown yet| — The picked period (2026-08-03 ~ 2026-08-09) is after the service week Jul week 5 (7/27–8/2). Gold's measurement results are shown only for rounds completed up to that week.";
    for (const view of [NO_WEBSITE, BOTH]) {
      expect(notice(view, { path: "/ko/website/answer-analysis/mention", search: "time=2026-08-03..2026-08-09" })).toBe(AFTER);
      expect(notice(view, { path: "/ko/dashboard", search: "time=2026-08-03..2026-08-09&engine=chatgpt" })).toBe(AFTER);
    }
    expect(notice(BOTH, { path: "/en/website/answer-analysis/citation", search: "time=2026-08-03..2026-08-09" }, "en")).toBe(EN_AFTER);
    // Website Prompts reads the period as a lens over its rows: the lens holds no round, and every row said 측정 없음 of
    // prompts Gold measured after the week, with nothing naming the week (review r4-4, 2026-11-03)
    for (const view of [NO_WEBSITE, BOTH]) {
      expect(notice(view, { path: "/ko/website/prompts", search: "time=2026-08-03..2026-08-09&geography=US" })).toBe(AFTER);
    }
    expect(notice(BOTH, { path: "/en/website/prompts", search: "time=2026-08-03..2026-08-09" }, "en")).toBe(EN_AFTER);
    // ...its lens of a period that reads rounds, or of none, is its own (review r3-11)
    for (const time of ["2026-07-27..2026-08-09", "..2026-08-09", "2026-07-01..2026-07-26"]) {
      expect(notice(BOTH, { path: "/ko/website/prompts", search: `time=${time}` }), time).toBe("");
    }
    // Global Prompts reads no period
    expect(notice(BOTH, { path: "/ko/standard/prompts", search: "time=2026-08-03..2026-08-09" })).toBe("");
    // a period that reads rounds, no week, a page the week does not hold: nothing
    expect(notice(BOTH, { path: "/ko/website/answer-analysis/mention", search: "time=2026-07-27..2026-08-09" })).toBe("");
    expect(notice(UNCONFIGURED, { path: "/ko/website", search: "time=2026-08-03..2026-08-09" })).toBe("");
    expect(notice(BOTH, { path: "/ko/projects/c0000000-0000-4000-8000-000000000003", search: "time=2026-08-03..2026-08-09" })).toBe("");
  });
});
