import { describe, expect, it } from "vitest";
import {
  formatKstMinute,
  isServiceWeekView,
  monthDay,
  noRoundWeek,
  notesInPeriod,
  periodAfterWeek,
  serviceWeekApplies,
  serviceWeekPeriodPage,
  serviceWeekSites,
  serviceWeekSnapshotPage,
  serviceWeekSurface,
  weekEndOf,
  type ServiceWeekNote,
  type ServiceWeekRange,
  type ServiceWeekView,
} from "./service-week";

// The service week (decisions '발행 시점 판정' · '기준 주 세부', 2026-11-02): every Global and Website screen shows Gold
// up to one ISO week that a HUB cron advances; the BFF screen shared/service-week names it. These are the front's
// pure pieces: the week's M/D, where the week applies, which notes a page's period meets, the KST check time.

const W1002: ServiceWeekRange = { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 };
const note = (surface: "global" | "website", start: string, end: string, unpublished: number, hidden: number, days?: string[]): ServiceWeekNote => ({
  surface,
  week: { start, end, month: Number(start.slice(5, 7)), nth: 1 },
  unpublished,
  hidden,
  ...(days ? { days } : {}),
});
// today's notes (contract Q2): website 07-20 week 1 unpublished site, website 09-14 week 1 hidden site — with the round
// days each is about (live Gold, 2026-11-03): the 24 sites shown on 07-24 and Kia Italy's one cycle of 07-20; every
// round of the 09-14 week, the hidden site's too, of 09-18
const NOTES = [
  note("website", "2026-07-20", "2026-07-26", 1, 0, ["2026-07-20", "2026-07-24"]),
  note("website", "2026-09-14", "2026-09-20", 0, 1, ["2026-09-18"]),
];

describe("monthDay: M/D by string assembly (no time zone, hydration safe)", () => {
  it.each([
    ["2026-10-05", "10/5"],
    ["2026-10-11", "10/11"],
    ["2026-01-01", "1/1"],
  ])("%s -> %s", (day, md) => expect(monthDay(day)).toBe(md));

  it("leaves anything else as it is", () => expect(monthDay("soon")).toBe("soon"));
});

describe("where the week applies: the pages whose data the BFF holds to it", () => {
  it.each([
    // Gold's global and website rounds, in both shells
    ["/ko/renewal/dashboard", true],
    ["/en/renewal/website/answer-analysis/citation", true],
    ["/ko/renewal/website/prompts", true],
    ["/ko/renewal/standard/ai-funnel/acr", true],
    ["/ko/dashboard", true],
    ["/ko/standard/ai-funnel/acr", true],
    ["/ko/website/ai-funnel/acr", true],
    ["/dashboard", true],
    // the renewal Admin page whose Gold reads go through Context.create (인용 출처 분류: the latest global round's citations)
    ["/ko/renewal/admin/standards/citation-sources", true],
    // review r2-8 (2026-11-03): 엔티티 카탈로그 lists Gold's all-time totals (entity_mention_total) — 'Hit Box · 1 · 3 ·
    // 2026-10-12' under '10월 2주차 · 10/5~10/11'; only its sheet's mention samples are held to the week
    ["/ko/renewal/admin/standards/entities", false],
    ["/en/renewal/admin/standards/entities", false],
    ["/ko/projects", false],
    ["/ko/projects/c0000000-0000-4000-8000-000000000003/analysis/mention", false],
    ["/ko/renewal/projects", false],
    ["/projects/new", false],
    // review r1-12 (2026-11-03): these said '모든 화면이 10월 2주차까지 보입니다' over data the BFF does not hold to the
    // week — GA4 days (AI 가시성 · AI 유입 전환, read to GA4's latest day) ...
    ["/ko/renewal/standard/ai-funnel/visibility", false],
    ["/ko/renewal/standard/ai-funnel/conversion", false],
    ["/ko/renewal/website/ai-funnel/conversion", false],
    ["/ko/standard/ai-funnel/visibility", false],
    ["/ko/standard/ai-funnel/conversion", false],
    ["/ko/website/ai-funnel/conversion", false],
    // ... Gold reads of no round (Google 키워드 · 소셜) ...
    ["/ko/customer-interest/google-keywords", false],
    ["/ko/customer-interest/social-scraping", false],
    // ... Admin pages of no Gold round, the not-implemented ones ...
    ["/ko/renewal/admin", false],
    ["/ko/renewal/admin/ga4", false],
    ["/ko/renewal/admin/keyword-tools", false],
    ["/ko/renewal/admin/standards/prompts", false],
    ["/ko/renewal/admin/standards/customer-interest", false],
    ["/ko/renewal/admin/analysis", false],
    // ... the original Admin screens (the legacy /v1/admin reads, not the BFF's capped ones) and no-access
    ["/ko/admin", false],
    ["/ko/admin/standards/entities", false],
    ["/ko/admin/standards/citation-sources", false],
    ["/ko/no-access", false],
  ])("%s -> %s", (path, applies) => expect(serviceWeekApplies(path)).toBe(applies));

  it("인용 출처 분류 by its tab: not 코드표, which reads no Gold round (review r3-9)", () => {
    // review r3-9 (2026-11-03): ?tab=codes showed '10월 2주차 · 10/5~10/11 | 반영 지연 23일' and the delay note over the
    // 13 code-table rows — the HUB's code table beside Gold's category names (source_lists.py codes()), none of it held
    // to the week. 교정 · 시드 · 공식 소셜 read the latest global round's citations (Context.create)
    const sp = (q: string) => new URLSearchParams(q);
    const SOURCES = "/ko/renewal/admin/standards/citation-sources";
    expect(serviceWeekApplies(SOURCES, sp("tab=codes"))).toBe(false);
    expect(serviceWeekApplies("/en/renewal/admin/standards/citation-sources", sp("tab=codes&q=news"))).toBe(false);
    // 교정 is the page without a tab, and one the page does not know opens it (tabOf)
    for (const q of ["", "tab=overrides", "tab=seeds", "tab=social", "tab=other"]) expect(serviceWeekApplies(SOURCES, sp(q)), q).toBe(true);
    expect(serviceWeekApplies(SOURCES, null)).toBe(true);
    // the tab of another page is that page's: Global prompts' 변경 이력 (HUB revisions) keeps the chip, whose copy names
    // Gold's results only — its (dash) tab is not in the URL
    expect(serviceWeekApplies("/ko/renewal/standard/prompts", sp("tab=history"))).toBe(true);
    expect(serviceWeekApplies("/ko/renewal/standard/prompts", sp("tab=codes"))).toBe(true);
    expect(serviceWeekApplies("/ko/admin/standards/citation-sources", sp("tab=seeds"))).toBe(false);
  });
});

describe("the Gold surface a page shows (for its period notes)", () => {
  it.each([
    ["/ko/renewal/dashboard", "global"],
    ["/ko/renewal/standard/answer-analysis/mention", "global"],
    ["/ko/renewal/standard/ai-funnel/acr", "global"],
    ["/ko/renewal/standard/prompts", "global"],
    ["/ko/dashboard", "global"],
    ["/ko/renewal/website", "website"],
    ["/ko/renewal/website/answer-analysis/citation/tone-urls", "website"],
    ["/ko/website/prompts", "website"],
    // the original Website ACR (Gold's rounds; hidden from the menu, opened by its address)
    ["/ko/website/ai-funnel/acr", "website"],
    // GA4 / HUB analytics days, not Gold rounds
    ["/ko/renewal/standard/ai-funnel/visibility", null],
    ["/ko/renewal/standard/ai-funnel/conversion", null],
    ["/ko/renewal/website/ai-funnel/conversion", null],
    ["/ko/website/ai-funnel/conversion", null],
    ["/ko/renewal/admin/ga4", null],
    ["/ko/renewal/projects", null],
  ])("%s -> %s", (path, surface) => expect(serviceWeekSurface(path)).toBe(surface));
});

describe("serviceWeekSnapshotPage: a page whose Gold read is its surface's snapshot, or with a `time` the period's rounds", () => {
  // review r3-11 (2026-11-03): the original Prompts pages read every round with no `time` (ServiceWeekPagePeriod), and
  // the '측정 없음' at the top of main sat above their measured rows
  it.each([
    ["/ko/dashboard", true],
    ["/ko/website", true],
    ["/ko/website/answer-analysis/mention", true],
    ["/ko/standard/answer-analysis/citation/tone-urls", true],
    ["/ko/standard/ai-funnel/acr", true],
    ["/ko/website/ai-funnel/acr", true],
    ["/ko/renewal/website/answer-analysis/citation", true],
    ["/ko/standard/prompts", false],
    ["/ko/website/prompts", false],
    ["/en/renewal/standard/prompts", false],
    ["/ko/renewal/website/prompts", false],
    // no surface of their own: GA4 days, Project, Admin
    ["/ko/website/ai-funnel/conversion", false],
    ["/ko/projects/c0000000-0000-4000-8000-000000000003", false],
    ["/ko/renewal/admin/standards/citation-sources", false],
  ])("%s -> %s", (path, snapshot) => expect(serviceWeekSnapshotPage(path)).toBe(snapshot));
});

describe("serviceWeekPeriodPage: a page that reads the URL's period of its surface's rounds", () => {
  // review r4-4 (2026-11-03): Website Prompts reads it as a lens over its rows, so a period after the week is the week's
  // to explain there too; Global Prompts reads none
  it.each([
    ["/ko/dashboard", true],
    ["/ko/website/answer-analysis/mention", true],
    ["/ko/standard/ai-funnel/acr", true],
    ["/ko/website/prompts", true],
    ["/en/renewal/website/prompts", true],
    ["/ko/standard/prompts", false],
    ["/ko/renewal/standard/prompts", false],
    // no surface of their own: GA4 days, Project, Admin
    ["/ko/website/ai-funnel/conversion", false],
    ["/ko/projects/c0000000-0000-4000-8000-000000000003", false],
    ["/ko/renewal/admin/standards/citation-sources", false],
  ])("%s -> %s", (path, reads) => expect(serviceWeekPeriodPage(path)).toBe(reads));
});

describe("the notes a page's period meets", () => {
  it("a period: every noted week of the page's surface with one of its round days in the period", () => {
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-01", to: "2026-07-31" }, W1002)).toEqual([NOTES[0]]);
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-24", to: "2026-09-18" }, W1002)).toEqual(NOTES);
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-25", to: "2026-09-17" }, W1002)).toEqual([]);
  });

  it("a period that only takes in a noted week's other days holds none of its values: no note (review r2-10)", () => {
    // live (2026-11-03): '측정 회차 2026-09-25 기준' over '9월 3주차: 관리자가 숨긴 사이트 1곳…', whose rounds are all of 09-18;
    // the 7월 4주차 note over 07-26..08-10 (round 08-07)
    expect(notesInPeriod(NOTES, "website", { from: "2026-09-19", to: "2026-09-30" }, W1002)).toEqual([]);
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-26", to: "2026-08-10" }, W1002)).toEqual([]);
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-26", to: "2026-09-14" }, W1002)).toEqual([]);
    // the 7-day preset ends on the last Website round (Friday) and starts on the Saturday before: the week before it
    // is in the period by its weekend only
    const oct1 = note("website", "2026-09-28", "2026-10-04", 0, 1, ["2026-10-02"]);
    expect(notesInPeriod([oct1], "website", { from: "2026-10-03", to: "2026-10-09" }, W1002)).toEqual([]);
    expect(notesInPeriod([oct1], "website", { from: "2026-09-26", to: "2026-10-09" }, W1002)).toEqual([oct1]);
  });

  it("a round day of a site the week left out is one of its days: a period that holds it would have read that round", () => {
    // Kia Italy's one cycle of the 07-20 week is of 07-20 (Gold did not publish it); the other sites' round is of 07-24
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-01", to: "2026-07-21" }, W1002)).toEqual([NOTES[0]]);
    expect(notesInPeriod(NOTES, "website", { from: "2026-07-21", to: "2026-07-31" }, W1002)).toEqual([NOTES[0]]);
  });

  it("an open side reaches to that end", () => {
    expect(notesInPeriod(NOTES, "website", { from: "2026-09-01" }, W1002)).toEqual([NOTES[1]]);
    expect(notesInPeriod(NOTES, "website", { to: "2026-07-20" }, W1002)).toEqual([NOTES[0]]);
    expect(notesInPeriod(NOTES, "website", { from: "2026-09-19" }, W1002)).toEqual([]);
  });

  it("an answer without the days (of before): the noted weeks the period overlaps", () => {
    const bare = NOTES.map(({ surface, week, unpublished, hidden }) => ({ surface, week, unpublished, hidden }));
    expect(notesInPeriod(bare, "website", { from: "2026-09-19", to: "2026-09-30" }, W1002)).toEqual([bare[1]]);
    expect(notesInPeriod(bare, "website", { from: "2026-07-26", to: "2026-09-14" }, W1002)).toEqual(bare);
    expect(notesInPeriod(bare, "website", { from: "2026-07-27", to: "2026-09-13" }, W1002)).toEqual([]);
  });

  it("no period (the snapshot): the service week's own notes only", () => {
    expect(notesInPeriod(NOTES, "website", null, W1002)).toEqual([]);
    expect(notesInPeriod(NOTES, "website", null, { start: "2026-09-14", end: "2026-09-20", month: 9, nth: 3 })).toEqual([NOTES[1]]);
  });

  it("another surface's notes, a page without a surface or no week: none", () => {
    expect(notesInPeriod(NOTES, "global", { from: "2026-07-01", to: "2026-07-31" }, W1002)).toEqual([]);
    expect(notesInPeriod(NOTES, null, { from: "2026-07-01", to: "2026-07-31" }, W1002)).toEqual([]);
    expect(notesInPeriod(NOTES, "website", null, null)).toEqual([]);
  });
});

describe("serviceWeekSites: the page's site picks its notes are read with", () => {
  // review r1-7 (2026-11-03): a Website page filtered to Genesis over July was told of Kia Italy's unpublished site
  const sp = (q: string) => new URLSearchParams(q);

  it("a Website page's brand, geography, language and engine, each list sorted; nothing else of the URL", () => {
    // review r5-1 (2026-11-03): the reads take a site's cells by language and engine too — a German page was told of an
    // Italian site and an English one
    expect(
      serviceWeekSites("website", sp("geography=US~IT&brand=Genesis&time=2026-07-01..2026-07-31&language=en~de&engine=gemini~chatgpt&source=officialHmg")),
    ).toBe("brand=Genesis&geography=IT%7EUS&language=de%7Een&engine=chatgpt%7Egemini");
    expect(serviceWeekSites("website", sp("geography=IT"))).toBe("geography=IT");
    expect(serviceWeekSites("website", sp("time=2026-07-01..2026-07-31&language=en"))).toBe("language=en");
  });

  it("none: no pick, an 'all' or empty pick, a Global page, a page without a surface", () => {
    expect(serviceWeekSites("website", sp("time=2026-07-01..2026-07-31&source=officialHmg"))).toBe("");
    expect(serviceWeekSites("website", sp("brand=all&geography=&language=&engine=all"))).toBe("");
    // the Global notes are everyone's (the BFF reads no site of them)
    expect(serviceWeekSites("global", sp("brand=Kia&geography=IT"))).toBe("");
    expect(serviceWeekSites(null, sp("brand=Kia"))).toBe("");
    expect(serviceWeekSites("website", null)).toBe("");
  });
});

describe("formatKstMinute: the Gold check time on the KST clock", () => {
  it("UTC 12:10 is 21:10 KST; past 15:00 UTC it is the next day", () => {
    expect(formatKstMinute("2026-11-02T12:10:05Z")).toBe("2026-11-02 21:10");
    expect(formatKstMinute("2026-11-01T15:00:00+00:00")).toBe("2026-11-02 00:00");
  });

  it("an unreadable value stays as it is", () => expect(formatKstMinute("later")).toBe("later"));
});

describe("the screen's answer", () => {
  const ok: ServiceWeekView = { state: "ok", week: W1002, delay: null, checkedAt: null, recordedAt: null, notes: [] };

  it("weekEndOf: the end of the week, null without one", () => {
    expect(weekEndOf(ok)).toBe("2026-10-11");
    expect(weekEndOf({ ...ok, state: "unconfigured", week: null })).toBeNull();
    expect(weekEndOf(null)).toBeNull();
    expect(weekEndOf(undefined)).toBeNull();
  });

  it("isServiceWeekView accepts the two states and nothing else", () => {
    expect(isServiceWeekView(ok)).toBe(true);
    expect(isServiceWeekView({ state: "unconfigured", week: null, delay: null, checkedAt: null, recordedAt: null, notes: [] })).toBe(true);
    expect(isServiceWeekView({ error: { code: "service_unavailable" } })).toBe(false);
    expect(isServiceWeekView({ ...ok, week: { start: "2026-10-05" } })).toBe(false);
    expect(isServiceWeekView({ ...ok, state: "stale" })).toBe(false);
    expect(isServiceWeekView({ ...ok, notes: "none" })).toBe(false);
    // a week the BFF moved to moments ago says so (review r1-16); absent in an answer of before is no move
    expect(isServiceWeekView({ ...ok, justMoved: true })).toBe(true);
    expect(isServiceWeekView({ ...ok, justMoved: "yes" })).toBe(false);
    // which surfaces the week holds a round of (review r1-19); absent in an answer of before is unknown
    expect(isServiceWeekView({ ...ok, rounds: { global: true, website: false } })).toBe(true);
    expect(isServiceWeekView({ ...ok, rounds: null })).toBe(true);
    expect(isServiceWeekView({ ...ok, rounds: { global: true, website: "no" } })).toBe(false);
    expect(isServiceWeekView({ ...ok, rounds: [] })).toBe(false);
    expect(isServiceWeekView(null)).toBe(false);
  });

  it("noRoundWeek: the week, when it holds no round of the surface; null otherwise and when unknown", () => {
    // review r1-19 (2026-11-03): the week of 07-27 has Global 07-27 and no Website round (live Gold)
    const w0727: ServiceWeekRange = { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 };
    const view: ServiceWeekView = { ...ok, week: w0727, rounds: { global: true, website: false } };
    expect(noRoundWeek(view, "website")).toEqual(w0727);
    expect(noRoundWeek(view, "global")).toBeNull();
    expect(noRoundWeek({ ...view, rounds: { global: true, website: true } }, "website")).toBeNull();
    // an answer that does not say (rounds absent or null), no week, a failed read: nothing is claimed
    expect(noRoundWeek({ ...view, rounds: undefined }, "website")).toBeNull();
    expect(noRoundWeek({ ...view, rounds: null }, "website")).toBeNull();
    expect(noRoundWeek({ ...view, state: "unconfigured", week: null }, "website")).toBeNull();
    expect(noRoundWeek(null, "website")).toBeNull();
  });

  it("periodAfterWeek: the week, when the period starts after it (the BFF reads no round of it); null otherwise and when unknown", () => {
    // review r3-12 (2026-11-03): a typed or linked time=2026-10-12..2026-10-18 under the week of 10-05
    expect(periodAfterWeek(ok, { from: "2026-10-12", to: "2026-10-18" })).toEqual(W1002);
    expect(periodAfterWeek(ok, { from: "2026-10-12" })).toEqual(W1002);
    // a period that reaches into the week or ends before it reads rounds; one with no start reads up to the week
    expect(periodAfterWeek(ok, { from: "2026-10-11", to: "2026-10-18" })).toBeNull();
    expect(periodAfterWeek(ok, { from: "2026-09-01", to: "2026-09-30" })).toBeNull();
    expect(periodAfterWeek(ok, { to: "2026-10-18" })).toBeNull();
    expect(periodAfterWeek(ok, null)).toBeNull();
    // no week (unconfigured), a failed read: nothing is claimed
    expect(periodAfterWeek({ ...ok, state: "unconfigured", week: null }, { from: "2026-10-12" })).toBeNull();
    expect(periodAfterWeek(null, { from: "2026-10-12" })).toBeNull();
  });
});
