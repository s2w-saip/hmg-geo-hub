// The service week (decisions '발행 시점 판정' · '기준 주 세부', 2026-11-02): every Global and Website screen shows
// Gold only up to one ISO week (Monday–Sunday) that a HUB cron advances once Gold has completed it
// (back/hub_storage/service_week.py). The BFF screen `shared/service-week` names it; the BFF also holds every Gold
// read to it, so the front only shows it and keeps its own date pickers inside it. Project pages (surface 3), the
// pages of no Gold round (GA4 days, keyword research, most Admin pages, 인용 출처 분류's 코드표 tab) and the entity
// catalog (Gold's all-time totals) are not held to the week (serviceWeekApplies).
//
// Client-safe: types and pure helpers only (the server read is lib/service-week-server.ts). Dates are KST calendar
// days (YYYY-MM-DD) and are formatted by string assembly, so the server and the browser print the same text.
import { routing } from "@/i18n/routing";
import { DISPLAY_TIME_ZONE } from "@/lib/as-of-date";
import { joinFilterValues, splitFilterValues } from "@/components/dash/filter-encoding";

/** One ISO week: `month` / `nth` name it by its Thursday ("10월 2주차" = 2026-10-05..10-11). */
export interface ServiceWeekRange {
  start: string;
  end: string;
  month: number;
  nth: number;
}

/** The next week is late: `days` since the service week ended passed the BFF's `threshold` (10). */
export interface ServiceWeekDelay {
  days: number;
  threshold: number;
  next: ServiceWeekRange;
}

export type ServiceWeekSurface = "global" | "website";

/** A week in which Gold left sites out of a surface: not published (a blocking cycle) or hidden by an administrator. */
export interface ServiceWeekNote {
  surface: ServiceWeekSurface;
  week: ServiceWeekRange;
  unpublished: number;
  hidden: number;
  /**
   * The round days (YYYY-MM-DD) the note is about: the rounds the week's sites show and every round of a site it leaves
   * out (review r2-10). A period reads rounds by their day, so one that holds none of them holds none of the week's
   * values. Absent in an answer of before: the week's days.
   */
  days?: string[];
}

/** Screen shared/service-week. `unconfigured` = the BFF has no week store (development): nothing is held to a week. */
export interface ServiceWeekView {
  state: "ok" | "unconfigured";
  week: ServiceWeekRange | null;
  delay: ServiceWeekDelay | null;
  /** when the cron last read Gold; an old value tells a stopped cron from a late Gold */
  checkedAt: string | null;
  /** when the week last changed */
  recordedAt: string | null;
  /**
   * The BFF moved to this week moments ago: a screen of the same page read just before may hold the week before, so
   * the shell re-reads its page once (review r1-16). Absent = no.
   */
  justMoved?: boolean;
  /**
   * Whether the week holds a round of each surface (Gold's round calendar, as the BFF's reads take it: review r4-2). false
   * = the BFF reads no snapshot of that surface, and a page that reads one says '측정 없음' for the week (decision '기준
   * 주 세부', review r1-19). Absent or null = not known (an answer of before, no week, Gold unread): nothing is said.
   */
  rounds?: Record<ServiceWeekSurface, boolean> | null;
  notes: ServiceWeekNote[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-05" -> "10/5" (anything else as it is). */
export function monthDay(day: string): string {
  const m = DAY.exec(day);
  return m ? `${Number(m[2])}/${Number(m[3])}` : day;
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** The page path without its locale: "/ko/renewal/website/prompts" -> "/renewal/website/prompts". */
function localePath(pathname: string): string {
  const parts = pathname.split("/");
  return (routing.locales as readonly string[]).includes(parts[1] ?? "") ? `/${parts.slice(2).join("/")}` : pathname;
}

/** The page path without its locale and the renewal prefix: "/ko/renewal/website/prompts" -> "/website/prompts". */
function pagePath(pathname: string): string {
  const rest = localePath(pathname);
  return under(rest, "/renewal") ? rest.slice("/renewal".length) || "/" : rest;
}

// AI Visibility and AI Conversion read GA4 days of the HUB data DB (hub_stores/analytics_reader.py: up to GA4's latest
// day), not Gold rounds: the BFF does not hold them to the week.
const GA4_PAGES = ["/standard/ai-funnel/visibility", "/standard/ai-funnel/conversion", "/website/ai-funnel/visibility", "/website/ai-funnel/conversion"];

// The renewal Admin page whose Gold rounds are read through the BFF's Context.create, held to the week as the screens
// are: 인용 출처 분류 (hub_stores/source_overrides.py, source_lists.py: the citations of the latest global round). Not
// 엔티티 카탈로그 (entity_roles.py): its list is Gold's all-time totals (entity_mention_total) and only its sheet's
// mention samples are held to the week — a chip over the list said it stops at the week (review r2-8, 2026-11-03).
// The other Admin pages read no Gold round (accounts, the GA4 registry, the keyword sample, the HUB prompt catalog,
// Gold's keyword seeds and social snapshot), and the original (dash) Admin screens read the legacy /v1/admin API,
// which the BFF does not serve.
// `notTabs`: the page's views (`?tab=`) that read no Gold round — 인용 출처 분류's 코드표, the HUB code table beside
// Gold's category names (source_lists.py codes(): catalog.source_code, gold.dim_category); the chip over its rows said
// they stop at the week (review r3-9, 2026-11-03).
const CAPPED_ADMIN: readonly { base: string; notTabs: readonly string[] }[] = [{ base: "/admin/standards/citation-sources", notTabs: ["codes"] }];

/**
 * Whether the page is held to the service week — its chip, its notes and its date pickers' end: the pages of Gold's
 * global and website rounds (serviceWeekSurface) and the renewal Admin page whose Gold reads the BFF caps, but for
 * its view of no Gold round (`search`'s `tab`: 코드표, review r3-9). Not Project (surface 3), the GA4 pages, keyword
 * and social research (Gold reads of no round, capped=False), the other Admin pages (the entity catalog among them:
 * Gold's all-time totals, review r2-8) and no-access: their data is not held to the week, and a chip would say it is
 * (review r1-12, 2026-11-03). A page that sets HUB lists beside its Gold results (Global prompts' 변경 이력, the HUB's
 * edits on 교정 · 시드 · 공식 소셜) keeps it: its copy names Gold's results only.
 */
export function serviceWeekApplies(pathname: string, search?: { get(name: string): string | null } | null): boolean {
  if (serviceWeekSurface(pathname)) return true;
  if (!under(localePath(pathname), "/renewal")) return false;
  const page = pagePath(pathname);
  const tab = search?.get("tab") ?? "";
  return CAPPED_ADMIN.some(({ base, notTabs }) => under(page, base) && !notTabs.includes(tab));
}

/**
 * The Gold surface whose rounds the page shows — the notes of that surface's weeks apply to it. The GA4 pages read
 * GA4 / HUB analytics days, not Gold rounds; admin, research and Project pages have no surface of their own.
 */
export function serviceWeekSurface(pathname: string): ServiceWeekSurface | null {
  const p = pagePath(pathname);
  if (GA4_PAGES.some((base) => under(p, base))) return null;
  if (under(p, "/website")) return "website";
  if (under(p, "/dashboard") || under(p, "/standard")) return "global";
  return null;
}

// The pages of a surface that show more than its snapshot with no `time`: Global and Website Prompts, every round
// (ServiceWeekPagePeriod). With one, Website's reads the period as a lens over its rows; Global's reads none
// (serviceWeekPeriodPage).
const EVERY_ROUND_PAGES = ["/standard/prompts", "/website/prompts"];

/**
 * Whether the page's Gold read is its surface's snapshot with no `time` (with one, the period's rounds), so that an
 * empty read there is the service week's to explain ('측정 없음', a period after the week): Overview, Mention,
 * Citation, ACR. Not Prompts: with no `time` they show every round, and the original screens' '측정 없음' at the top
 * of main sat above their measured rows (review r3-11, 2026-11-03).
 */
export function serviceWeekSnapshotPage(pathname: string): boolean {
  const p = pagePath(pathname);
  return serviceWeekSurface(pathname) !== null && !EVERY_ROUND_PAGES.some((base) => under(p, base));
}

// The page of a surface that reads no period: Global Prompts (Gold's catalog of every round; a `time` in its URL is read
// by nothing).
const NO_PERIOD_PAGES = ["/standard/prompts"];

/**
 * Whether the page reads the URL's period (`time`) of its surface's rounds, so that a period that starts after the week
 * — of which the BFF reads no round — is the service week's to explain (review r3-12): every page of a surface but
 * Global Prompts. Website Prompts reads it as a lens over its rows, which said '측정 없음' then of prompts Gold measured
 * after the week (review r4-4, 2026-11-03).
 */
export function serviceWeekPeriodPage(pathname: string): boolean {
  const p = pagePath(pathname);
  return serviceWeekSurface(pathname) !== null && !NO_PERIOD_PAGES.some((base) => under(p, base));
}

// The page URL's params that pick a Website page's sites — the axes its reads take a site's cells by: the notes are read
// with them (shared/service-week reads them as the website pages do — the account's countries, brand an administrator's
// axis; GET /api/service-week passes these on and nothing else).
export const SERVICE_WEEK_SITE_PICKS = ["brand", "geography", "language", "engine"] as const;

/**
 * The page's site picks its notes are read with, as a query string ("" = none): a Website page's `brand`, `geography`,
 * `language` and `engine`, each value list sorted (equal picks share one read). Other pages have none — the Global
 * notes are everyone's. Review r1-7 (2026-11-03): a Website page filtered to Genesis over July was told of Kia Italy's
 * unpublished site, the layout having read the notes of every site of the account's; review r5-1: a German page was
 * told of an Italian site and an English one, the language and the engine having been left out.
 */
export function serviceWeekSites(surface: ServiceWeekSurface | null, search: { get(name: string): string | null } | null): string {
  if (surface !== "website" || !search) return "";
  const q = new URLSearchParams();
  for (const key of SERVICE_WEEK_SITE_PICKS) {
    const values = [...new Set(splitFilterValues(search.get(key)))].sort();
    if (values.length) q.set(key, joinFilterValues(values));
  }
  return q.toString();
}

/**
 * A page's own period for its notes, when it shows more than a snapshot with no `time` (Website and Global Prompts:
 * every round): the first and the last day of the rounds its header names; null = no round shown (no note) (review
 * r1-13). It goes before the URL's `time`; a page with a 기간 passes none (Website Prompts' lens reads the URL range,
 * review r2-10).
 */
export type ServiceWeekPagePeriod = { from: string; to: string } | null;

/**
 * The notes a page meets: its surface's noted weeks with one of their round days in its period (an open side reaches
 * to that end; a note without days: the week's), or with no period (the snapshot) the service week's own note. A
 * period that takes in only a week's other days holds none of its values — the Website 7-day preset starts on the
 * Saturday after the week before's round (review r2-10). Gold's values, as they are — nothing is counted here.
 */
export function notesInPeriod(
  notes: readonly ServiceWeekNote[],
  surface: ServiceWeekSurface | null,
  period: { from?: string; to?: string } | null,
  week: ServiceWeekRange | null,
): ServiceWeekNote[] {
  if (!surface || !week) return [];
  return notes.filter((n) => {
    if (n.surface !== surface) return false;
    if (!period || (!period.from && !period.to)) return n.week.start === week.start;
    const meets = (lo: string, hi: string) => (!period.to || lo <= period.to) && (!period.from || hi >= period.from);
    return n.days ? n.days.some((day) => meets(day, day)) : meets(n.week.start, n.week.end);
  });
}

// built once: an Intl formatter costs far more than a format call
const kstMinute = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An ISO timestamp as "YYYY-MM-DD HH:mm" on the KST clock (the same text on the server and in the browser). */
export function formatKstMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = kstMinute.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/** The last day the screens show, null without a week. */
export function weekEndOf(view: ServiceWeekView | null | undefined): string | null {
  return view?.week?.end ?? null;
}

/** The service week when it holds no round of `surface` (Gold's calendar, as the screen says it); null otherwise or when not known. */
export function noRoundWeek(view: ServiceWeekView | null | undefined, surface: ServiceWeekSurface): ServiceWeekRange | null {
  return view?.week && view.rounds?.[surface] === false ? view.week : null;
}

/**
 * The service week when the period starts after it: the BFF reads no round of such a period, on either surface (a
 * `from` after the week's end selects nothing, gold_reader/context.py); null otherwise or without a week (review r3-12).
 */
export function periodAfterWeek(view: ServiceWeekView | null | undefined, period: { from?: string; to?: string } | null): ServiceWeekRange | null {
  return view?.week && period?.from && period.from > view.week.end ? view.week : null;
}

const isRange = (v: unknown): v is ServiceWeekRange => {
  const r = v as ServiceWeekRange | null;
  return !!r && typeof r === "object" && DAY.test(String(r.start)) && DAY.test(String(r.end)) && Number.isInteger(r.month) && Number.isInteger(r.nth);
};

/** Whether a browser read (GET /api/service-week) answered the screen's shape; anything else is a failed read. */
export function isServiceWeekView(v: unknown): v is ServiceWeekView {
  const x = v as Partial<ServiceWeekView> | null;
  if (!x || typeof x !== "object") return false;
  if (x.state !== "ok" && x.state !== "unconfigured") return false;
  if (x.week !== null && !isRange(x.week)) return false;
  if (x.delay != null && !(typeof x.delay === "object" && Number.isFinite(x.delay.days) && isRange(x.delay.next))) return false;
  if (x.justMoved !== undefined && typeof x.justMoved !== "boolean") return false;
  if (x.rounds != null && (typeof x.rounds !== "object" || Array.isArray(x.rounds) || !Object.values(x.rounds).every((v) => typeof v === "boolean"))) return false;
  return x.notes === undefined || Array.isArray(x.notes);
}
