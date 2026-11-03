import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { ServiceWeekView } from "@/lib/service-week";

// The service week in the shells (decisions '발행 시점 판정' · '기준 주 세부', 2026-11-02): one chip at the end of the
// page header's meta row names the week the page's Gold rounds are held to; when the next week is late (the BFF
// decides: more than 10 days after the week ended) the chip says so and one note heads the content column; a week
// Gold left a site out of gets a note when the page's period meets it. A page the BFF does not hold to the week
// (Project, GA4 days, Admin pages of no Gold round) shows none of it, and without the shell's provider (a page
// rendered on its own) nothing renders and no message is looked up.

const nav = vi.hoisted(() => ({ path: "/ko/renewal/dashboard", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));

const { RnServiceWeekProvider, serviceWeekContext } = await import("./provider");
const ServiceWeekContext = serviceWeekContext();
const { ServiceWeekDelayNotice } = await import("./notes");
const { RnPageHeader } = await import("@/components/renewal-ui");
const { RnFilterSplit, RnPageFrame } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-split");
const { PageHeader } = await import("@/components/page-header");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const OK: ServiceWeekView = {
  state: "ok",
  week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 },
  delay: null,
  checkedAt: "2026-11-02T12:10:00Z",
  recordedAt: "2026-10-12T01:10:00Z",
  notes: [
    { surface: "website", week: { start: "2026-07-20", end: "2026-07-26", month: 7, nth: 4 }, unpublished: 1, hidden: 0 },
    { surface: "website", week: { start: "2026-09-14", end: "2026-09-20", month: 9, nth: 3 }, unpublished: 0, hidden: 1 },
  ],
};
const LATE: ServiceWeekView = { ...OK, delay: { days: 22, threshold: 10, next: { start: "2026-10-12", end: "2026-10-18", month: 10, nth: 3 } } };
const UNCONFIGURED: ServiceWeekView = { state: "unconfigured", week: null, delay: null, checkedAt: null, recordedAt: null, notes: [] };

// the renewal shell's provider (it shows the site notes); the (dash) components below do not depend on it
function html(week: Promise<ServiceWeekView | null> | null, node: ReactNode, at = { path: "/ko/renewal/dashboard", search: "" }, locale: "ko" | "en" = "ko") {
  nav.path = at.path;
  nav.search = at.search;
  const tree = week ? <RnServiceWeekProvider week={week} notes>{node}</RnServiceWeekProvider> : node;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      {tree}
    </NextIntlClientProvider>,
  );
}
const text = (out: string) => out.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const header = <RnPageHeader title="Mention" meta={<span>desc</span>} />;
const chipOf = (out: string) => /data-rn-service-week="(\w+)"/.exec(out)?.[1] ?? null;
/** The text of the note box (an RnNote: a div with no div inside) holding `attr`, null when there is none. */
const block = (out: string, attr: string) => {
  const i = out.indexOf(attr);
  return i < 0 ? null : text(out.slice(out.lastIndexOf("<div", i), out.indexOf("</div>", i)));
};

describe("RnServiceWeekChip in the renewal page header", () => {
  it("names the week and its days at the end of the meta row, with what it means", () => {
    const out = html(settled(OK), header);
    expect(chipOf(out)).toBe("ok");
    expect(text(out)).toContain("desc10월 2주차 · 10/5~10/11");
    // what the page's Gold results show, not every screen (the GA4 pages are not held to the week, review r1-12) nor
    // the whole page: the HUB lists beside them (Global prompts' 변경 이력, 교정 · 시드 · 공식 소셜) are not (review r3-9)
    expect(out).toContain("서비스 기준 주 — Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.");
    expect(out).not.toContain("모든 화면");
    expect(out).not.toContain("이 화면");
    expect(text(out)).not.toContain("지연");
  });

  it("a late next week: a warning and the days since the week ended", () => {
    const out = html(settled(LATE), header);
    expect(chipOf(out)).toBe("late");
    expect(text(out)).toContain("10월 2주차 · 10/5~10/11");
    // Gold's publication, the feature's word ('발행 시점 판정'): '반영' is the HUB's for an input Gold has taken in
    // (반영됨 / 반영 대기) — review r3-10
    expect(text(out)).toContain("발행 지연 22일");
    expect(out).not.toContain("반영");
  });

  it("no week store (state unconfigured) and a failed read say so", () => {
    expect(chipOf(html(settled(UNCONFIGURED), header))).toBe("unconfigured");
    expect(text(html(settled(UNCONFIGURED), header))).toContain("기준 주 미정");
    // Gold's results to its latest round, not the whole page (review r3-9)
    expect(text(html(settled(UNCONFIGURED), header))).toContain("기준 주가 정해져 있지 않아 Gold 측정 결과는 최신 회차까지 보입니다.");
    expect(chipOf(html(settled(null), header))).toBe("unreadable");
    expect(text(html(settled(null), header))).toContain("기준 주를 읽지 못함");
  });

  it("keeps the pill's place while the week is read", () => {
    const out = html(new Promise<ServiceWeekView | null>(() => {}), header);
    expect(chipOf(out)).toBe("loading");
    expect(text(out)).not.toContain("주차");
  });

  it("a header without a meta line gets the chip row", () => {
    const out = html(settled(OK), <RnPageHeader title="Entity" />);
    expect(text(out)).toContain("10월 2주차 · 10/5~10/11");
  });

  it("not on a Project page", () => {
    const out = html(settled(LATE), header, { path: "/ko/renewal/projects", search: "" });
    expect(chipOf(out)).toBeNull();
    expect(text(out)).not.toContain("주차");
  });

  it("not on a page the BFF does not hold to the week: GA4 days, Admin pages of no Gold round", () => {
    // review r1-12 (2026-11-03): AI 유입 전환 showed GA4 days 10-12 ~ 10-25 under '10월 2주차 · 10/5~10/11 | 반영 지연
    // 22일', the note telling the viewer every screen stopped at 10/11
    for (const path of [
      "/ko/renewal/standard/ai-funnel/conversion",
      "/ko/renewal/standard/ai-funnel/visibility",
      "/ko/renewal/website/ai-funnel/conversion",
      "/ko/renewal/admin",
      "/ko/renewal/admin/ga4",
      // review r2-8 (2026-11-03): the entity catalog's answers and mentions are Gold's all-time totals ('Hit Box · 1 · 3 ·
      // 2026-10-12' under the chip and the note saying the page shows up to 10/11)
      "/ko/renewal/admin/standards/entities",
    ]) {
      const out = html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, { path, search: "" });
      expect(chipOf(out), path).toBeNull();
      expect(out, path).not.toContain("data-rn-service-week-delay");
      expect(text(out), path).not.toContain("주차");
    }
    // the Admin page whose Gold reads the BFF caps (인용 출처 분류: the latest global round) keeps the chip and the note
    const sources = html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, { path: "/ko/renewal/admin/standards/citation-sources", search: "" });
    expect(chipOf(sources)).toBe("late");
    expect(sources).toContain("data-rn-service-week-delay");
  });

  it("인용 출처 분류: not on its 코드표 tab, which reads no Gold round; its other tabs keep both (review r3-9)", () => {
    // review r3-9 (2026-11-03): ?tab=codes showed '10월 2주차 · 10/5~10/11 | 반영 지연 23일' and '…이 화면은 10월 2주차
    // (10/5~10/11)까지 보입니다' over the HUB code table and Gold's category names (source_lists.py codes())
    const at = (search: string) =>
      html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, { path: "/ko/renewal/admin/standards/citation-sources", search });
    const codes = at("tab=codes");
    expect(chipOf(codes)).toBeNull();
    expect(codes).not.toContain("data-rn-service-week-delay");
    expect(text(codes)).not.toContain("주차");
    for (const search of ["tab=seeds", "tab=social", "tab=overrides"]) {
      expect(chipOf(at(search)), search).toBe("late");
      expect(at(search), search).toContain("data-rn-service-week-delay");
    }
  });

  it("without the shell's provider: the header as before, no message looked up", () => {
    const plain = renderToStaticMarkup(<RnPageHeader title="Mention" meta={<span>desc</span>} />);
    expect(chipOf(plain)).toBeNull();
    expect(renderToStaticMarkup(<RnPageHeader title="Entity" />)).toBe(
      '<header class="flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5"><div class="min-w-0 flex-1"><h1 class="m-0 text-rn-26 font-bold tracking-[-0.025em] text-balance text-rn-ink [&amp;_span]:tracking-normal">Entity</h1></div></header>',
    );
  });

  it("reads in English too", () => {
    const out = html(settled(LATE), header, undefined, "en");
    expect(text(out)).toContain("Oct week 2 · 10/5–10/11");
    expect(text(out)).toContain("22 days late");
    expect(text(out)).toContain("Service week — Gold's measurement results are shown only for rounds completed up to this week.");
    expect(text(out)).not.toContain("this screen");
    expect(text(html(settled(UNCONFIGURED), header, undefined, "en"))).toContain("No service week is set, so Gold's measurement results are shown up to the latest round.");
  });
});

describe("a page whose HUB lists stand beside its Gold results (review r3-9, r3-10)", () => {
  const page = (path: string, search: string, locale: "ko" | "en" = "ko") =>
    html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, { path, search }, locale);

  it("Global prompts' 변경 이력: the chip and the note claim Gold's results only, not the HUB revisions under them", () => {
    // review r3-9 (2026-11-03): '…이 화면은 10월 2주차(10/5~10/11)까지 보입니다' right above HUB revisions of 2026. 10. 28.
    // The (dash) tab is not in the URL, so the copy says what is held to the week rather than the tab hiding the chip
    for (const search of ["tab=history", ""]) {
      const out = page("/ko/renewal/standard/prompts", search);
      expect(chipOf(out), search).toBe("late");
      expect(text(out), search).toContain("서비스 기준 주 — Gold 측정 결과는 이 주까지 완료된 회차만 보입니다.");
      expect(block(out, "data-rn-service-week-delay"), search).toContain("Gold 측정 결과는 10월 2주차(10/5~10/11)까지 보입니다.");
      expect(out, search).not.toContain("이 화면");
    }
    const en = page("/en/renewal/standard/prompts", "tab=history", "en");
    expect(block(en, "data-rn-service-week-delay")).toContain("so Gold's measurement results are shown up to Oct week 2 (10/5–10/11).");
    expect(en).not.toContain("this screen");
  });

  it("인용 출처 분류: the delay is Gold's publication, not '반영' — the page's word for a HUB edit Gold has taken in", () => {
    // review r3-10 (2026-11-03): '반영 지연 23일' and '데이터 반영이 늦어지고 있습니다' over the page's '반영 시점' note,
    // its '반영 상태' filter and '반영 대기 0': read as the corrections being 23 days late into Gold
    const out = page("/ko/renewal/admin/standards/citation-sources", "");
    expect(text(out)).toContain("발행 지연 22일");
    expect(block(out, "data-rn-service-week-delay")).toContain("발행 지연: 10월 3주차(10/12~10/18) 결과가 아직 완료로 확인되지 않아");
    expect(out).not.toContain("반영");
    expect(block(page("/en/renewal/admin/standards/citation-sources", "", "en"), "data-rn-service-week-delay")).toContain(
      "Publication delayed: the results of Oct week 3 (10/12–10/18) have not been confirmed complete yet",
    );
  });
});

describe("the delay note heads the content column", () => {
  const delay = (out: string) => block(out, "data-rn-service-week-delay");

  it("RnPageFrame: the late week, the week shown and Gold's last check (KST)", () => {
    const out = html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>);
    // Gold's publication (not '반영', review r3-10), and what is held to the week: Gold's results (review r3-9)
    expect(delay(out)).toContain("발행 지연: 10월 3주차(10/12~10/18) 결과가 아직 완료로 확인되지 않아, Gold 측정 결과는 10월 2주차(10/5~10/11)까지 보입니다.");
    expect(delay(out)).not.toContain("모든 화면");
    expect(delay(out)).not.toContain("이 화면");
    expect(delay(out)).not.toContain("반영");
    expect(text(out)).toContain("Gold 마지막 확인 2026-11-02 21:10");
    // first in the dense column, before the page's own content
    expect(out.indexOf("data-rn-service-week-delay")).toBeLessThan(out.indexOf("BODY"));
    expect(out.slice(out.indexOf("rn-dense"), out.indexOf("data-rn-service-week-delay"))).not.toContain("BODY");
  });

  it("says what the HUB's last check of Gold found, not Gold's state now: a stopped check keeps the week", () => {
    // review r1-20 (2026-11-03): with the hourly check stopped (no crontab line, a read refused every hour) the week
    // stays, and 10 days after it the note and the chip said the next week's results were not complete yet — of a week
    // Gold may have completed since. The old check time beside them tells a stopped check from a late Gold.
    const STALE: ServiceWeekView = { ...LATE, checkedAt: "2026-10-15T01:10:00Z" };
    const page = <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>;
    const out = html(settled(STALE), page);
    // the delay named as the chip names it, then what the check found — not a sentence that Gold is late now, which a
    // stopped check would make untrue (review r3-10 kept to r1-20)
    expect(delay(out)).toContain("발행 지연: 10월 3주차(10/12~10/18) 결과가 아직 완료로 확인되지 않아, Gold 측정 결과는 10월 2주차(10/5~10/11)까지 보입니다.");
    expect(delay(out)).toContain("(Gold 마지막 확인 2026-10-15 10:10)");
    expect(text(out)).toContain("기준 주가 끝난 지 22일이 지났지만 다음 주 결과가 아직 완료로 확인되지 않았습니다.");
    expect(text(out)).not.toContain("아직 완료되지 않");
    expect(text(out)).not.toContain("늦어지고 있습니다");
    const en = html(settled(STALE), page, undefined, "en");
    expect(delay(en)).toContain("Publication delayed: the results of Oct week 3 (10/12–10/18) have not been confirmed complete yet, so Gold's measurement results are shown up to Oct week 2 (10/5–10/11).");
    expect(delay(en)).toContain("(Gold last checked 2026-10-15 10:10)");
    expect(text(en)).toContain("22 days have passed since this week ended, and the next week's results have not been confirmed complete yet.");
    expect(text(en)).not.toContain("are not complete yet");
  });

  it("RnFilterSplit: the same note above the content, beside the panel", () => {
    const out = html(settled(LATE), <RnFilterSplit header={header} panel={<aside>panel</aside>} rail={<nav>rail</nav>}>{<p>BODY</p>}</RnFilterSplit>);
    expect(delay(out)).toContain("10월 3주차(10/12~10/18)");
    expect(out.indexOf("data-rn-service-week-delay")).toBeLessThan(out.indexOf("BODY"));
  });

  it("not when the next week is on time, nor on a Project page, nor without the provider", () => {
    expect(delay(html(settled(OK), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>))).toBeNull();
    expect(delay(html(settled(LATE), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, { path: "/ko/renewal/projects", search: "" }))).toBeNull();
    expect(delay(renderToStaticMarkup(<RnPageFrame header={<RnPageHeader title="x" />}>{<p>BODY</p>}</RnPageFrame>))).toBeNull();
  });
});

describe("the notes of a week Gold left a site out of", () => {
  const notes = (out: string) => block(out, "data-rn-service-week-notes");
  const page = (at: { path: string; search: string }, view: ServiceWeekView = OK) =>
    notes(html(settled(view), <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>, at));
  const WEBSITE = "/ko/renewal/website/answer-analysis/citation";

  it("a website period that takes in the 07-20 week names the site Gold did not publish", () => {
    expect(page({ path: WEBSITE, search: "time=2026-07-01..2026-07-31" })).toBe("Website 7월 4주차: Gold가 발행하지 않은 사이트 1곳은 이 주 값에 들어 있지 않습니다.");
  });

  it("the 09-14 week names the site an administrator hid; both weeks, one note", () => {
    expect(page({ path: WEBSITE, search: "time=2026-09-01..2026-09-30" })).toBe("Website 9월 3주차: 관리자가 숨긴 사이트 1곳은 이 주 값에 들어 있지 않습니다.");
    const both = page({ path: WEBSITE, search: "time=2026-07-01..2026-09-30" })!;
    expect(both).toContain("Website 7월 4주차");
    expect(both).toContain("Website 9월 3주차");
  });

  it("the snapshot (no period) looks at the service week only; a Global page or another period: none", () => {
    expect(page({ path: WEBSITE, search: "" })).toBeNull();
    expect(page({ path: "/ko/renewal/standard/answer-analysis/citation", search: "time=2026-07-01..2026-07-31" })).toBeNull();
    expect(page({ path: WEBSITE, search: "time=2026-08-01..2026-08-31" })).toBeNull();
  });

  it("a period that holds none of a noted week's round days: no note of that week (review r2-10)", () => {
    // live (2026-11-03): Website Overview over 09-19..09-30 showed '측정 회차 2026-09-25 기준' under 'Website 9월 3주차:
    // 관리자가 숨긴 사이트 1곳…', though every round of that week, the hidden site's too, is of 09-18; Website Citation over
    // 07-26..08-10 (round 08-07) named the 7월 4주차 site. The days are the BFF's (the rounds shown that week and those of
    // the sites left out: Kia Italy's one cycle of 07-20)
    const DAYS: ServiceWeekView = {
      ...OK,
      notes: [{ ...OK.notes[0], days: ["2026-07-20", "2026-07-24"] }, { ...OK.notes[1], days: ["2026-09-18"] }],
    };
    expect(page({ path: WEBSITE, search: "time=2026-09-19..2026-09-30" }, DAYS)).toBeNull();
    expect(page({ path: WEBSITE, search: "time=2026-07-26..2026-08-10" }, DAYS)).toBeNull();
    expect(page({ path: WEBSITE, search: "time=2026-09-01..2026-09-30" }, DAYS)).toBe("Website 9월 3주차: 관리자가 숨긴 사이트 1곳은 이 주 값에 들어 있지 않습니다.");
    expect(page({ path: WEBSITE, search: "time=2026-07-01..2026-07-21" }, DAYS)).toBe("Website 7월 4주차: Gold가 발행하지 않은 사이트 1곳은 이 주 값에 들어 있지 않습니다.");
  });

  describe("a page that names its own period (Website · Global Prompts: every round with no 기간)", () => {
    // review r1-13 (2026-11-03): Website Prompts with no time showed '측정 회차 2026-07-03 ~ 2026-10-09' and the 07-24
    // drop, yet no note — the notes took the page for a snapshot of the service week
    const PROMPTS = "/ko/renewal/website/prompts";
    type Period = { from: string; to: string } | null;
    const split = (notesPeriod: Period | Promise<Period> | undefined, search = "", view: ServiceWeekView = OK) =>
      html(
        settled(view),
        <RnFilterSplit header={header} panel={<aside>panel</aside>} rail={<nav>rail</nav>} notesPeriod={notesPeriod}>
          {<p>BODY</p>}
        </RnFilterSplit>,
        { path: PROMPTS, search },
      );
    const AXIS = { from: "2026-07-03", to: "2026-10-09" }; // live website/prompts-page roundAxis, 14 rounds
    const JULY = "Website 7월 4주차: Gold가 발행하지 않은 사이트 1곳은 이 주 값에 들어 있지 않습니다.";
    const SEPT = "Website 9월 3주차: 관리자가 숨긴 사이트 1곳은 이 주 값에 들어 있지 않습니다.";

    it("every noted week its rounds meet, as a value or as the page's read of it", () => {
      expect(notes(split(AXIS))).toBe(JULY + SEPT);
      expect(notes(split(settled(AXIS)))).toBe(JULY + SEPT);
      expect(notes(split({ from: "2026-08-07", to: "2026-10-09" }))).toBe(SEPT);
      // no page period (the page is a snapshot): the service week's own notes, none here
      expect(notes(split(undefined))).toBeNull();
    });

    it("a page's own period goes before the URL's (Website Prompts passes none with a 기간, review r2-10)", () => {
      // a period of 07-03..07-17 under time=07-01..07-21: the 07-20 week is not in it
      expect(notes(split({ from: "2026-07-03", to: "2026-07-17" }, "time=2026-07-01..2026-07-21"))).toBeNull();
      expect(notes(split({ from: "2026-07-03", to: "2026-07-31" }, "time=2026-07-01..2026-07-31"))).toBe(JULY);
    });

    it("no round shown (none in the lens, a failed read): no note", () => {
      expect(notes(split(null))).toBeNull();
      expect(notes(split(settled(null)))).toBeNull();
    });

    it("the delay note does not wait for the page's read of its period", () => {
      const out = split(new Promise<Period>(() => {}), "", LATE);
      expect(block(out, "data-rn-service-week-delay")).toContain("10월 3주차(10/12~10/18)");
      expect(notes(out)).toBeNull();
    });
  });

  it("a page with site picks: the layout's read (every site of the account's) names none of them", () => {
    // review r1-7 (2026-11-03): a Genesis page over July was told of Kia Italy's unpublished site, a Hyundai page over
    // September of Genesis US's hidden one. The layout reads no page's picks; the shell reads the page's (provider.tsx)
    expect(page({ path: WEBSITE, search: "brand=Genesis&time=2026-07-01..2026-07-31" })).toBeNull();
    expect(page({ path: WEBSITE, search: "brand=Hyundai&time=2026-09-01..2026-09-30" })).toBeNull();
    expect(page({ path: WEBSITE, search: "geography=US&time=2026-07-01..2026-07-31" })).toBeNull();
    // the language and the engine pick sites too (review r5-1: a German page was told of an Italian and an English site)
    expect(page({ path: WEBSITE, search: "language=de&time=2026-07-01..2026-07-31" })).toBeNull();
    expect(page({ path: WEBSITE, search: "engine=deepseek&time=2026-07-01..2026-07-31" })).toBeNull();
    // no site pick (the period alone): the layout's read is the page's
    expect(page({ path: WEBSITE, search: "time=2026-07-01..2026-07-31" })).toContain("Website 7월 4주차");
  });

  it("the notes read with the page's picks name its sites; a read of other picks names none", () => {
    // cycles/week-notes for brand=genesis on live Gold (2026-11-03): the 09-14 week's hidden site only
    const genesis: ServiceWeekView = { ...OK, notes: [OK.notes[1]] };
    const at = (search: string, notesFor: string) => {
      nav.path = WEBSITE;
      nav.search = search;
      return notes(
        renderToStaticMarkup(
          <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
            <ServiceWeekContext.Provider value={{ initial: settled(OK), latest: genesis, applies: true, surface: "website", sites: "brand=Genesis", notesFor }}>
              <RnPageFrame header={header}>{<p>BODY</p>}</RnPageFrame>
            </ServiceWeekContext.Provider>
          </NextIntlClientProvider>,
        ),
      );
    };
    expect(at("brand=Genesis&time=2026-09-01..2026-09-30", "brand=Genesis")).toBe("Website 9월 3주차: 관리자가 숨긴 사이트 1곳은 이 주 값에 들어 있지 않습니다.");
    expect(at("brand=Genesis&time=2026-07-01..2026-07-31", "brand=Genesis")).toBeNull();
    // the newest read was another page's (Kia): none until the page's own arrives
    expect(at("brand=Genesis&time=2026-09-01..2026-09-30", "brand=Kia")).toBeNull();
  });
});

describe("the original (dash) screens", () => {
  it("the chip after the title in PageHeader, not on /projects", () => {
    const out = html(settled(LATE), <PageHeader title="Overview" meta={<span>m</span>} />, { path: "/ko/dashboard", search: "" });
    expect(chipOf(out)).toBe("late");
    expect(text(out)).toContain("10월 2주차 · 10/5~10/11");
    expect(chipOf(html(settled(LATE), <PageHeader title="Projects" />, { path: "/ko/projects", search: "" }))).toBeNull();
    expect(chipOf(renderToStaticMarkup(<PageHeader title="Overview" />))).toBeNull();
  });

  it("the delay notice at the top of main (not sticky), not on /projects", () => {
    const out = html(settled(LATE), <ServiceWeekDelayNotice />, { path: "/ko/dashboard", search: "" });
    expect(text(out)).toContain("발행 지연: 10월 3주차(10/12~10/18) 결과가 아직 완료로 확인되지 않아, Gold 측정 결과는 10월 2주차(10/5~10/11)까지 보입니다.");
    expect(out).not.toContain("sticky");
    expect(html(settled(OK), <ServiceWeekDelayNotice />, { path: "/ko/dashboard", search: "" })).toBe("");
    expect(html(settled(LATE), <ServiceWeekDelayNotice />, { path: "/ko/projects/x", search: "" })).toBe("");
  });

  it("neither on a page the BFF does not hold to the week (GA4 days, keyword research, the Admin screens)", () => {
    // review r1-12 (2026-11-03): AI 유입 · 전환 and Google 키워드 carried both under '모든 화면이 … 까지 보입니다'
    for (const path of ["/ko/standard/ai-funnel/conversion", "/ko/website/ai-funnel/conversion", "/ko/customer-interest/google-keywords", "/ko/admin", "/ko/no-access"]) {
      expect(chipOf(html(settled(LATE), <PageHeader title="Page" meta={<span>m</span>} />, { path, search: "" })), path).toBeNull();
      expect(html(settled(LATE), <ServiceWeekDelayNotice />, { path, search: "" }), path).toBe("");
    }
    // the original Website ACR reads Gold's rounds
    expect(chipOf(html(settled(LATE), <PageHeader title="ACR" />, { path: "/ko/website/ai-funnel/acr", search: "" }))).toBe("late");
  });
});

describe("messages", () => {
  it("ko and en have the same serviceWeek keys", () => {
    const shape = (o: unknown): unknown => (typeof o === "object" && o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : "");
    expect(shape((en as Record<string, unknown>).serviceWeek)).toEqual(shape((ko as Record<string, unknown>).serviceWeek));
    expect((ko as Record<string, unknown>).serviceWeek).toBeTruthy();
  });
});
