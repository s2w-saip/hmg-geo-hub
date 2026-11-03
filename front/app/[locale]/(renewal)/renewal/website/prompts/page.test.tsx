import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { clientRoot } from "@/test/client-root";

// Renewal Website › Prompts: with no 기간 picked the list counts every round, its header naming them ('측정 회차
// 2026-07-03 ~ 2026-10-09'), so the service week's notes take those rounds as the page's period — not the service
// week, as a snapshot page does. Review r1-13 (2026-11-03): the default view showed the 07-24 drop and no note of the
// 7월 4주차 site Gold did not publish. The header chip and the notes read the same range, so they cannot disagree.
// With a 기간 the notes take the URL range, as on the other Website pages (review r2-10: they match a period by the
// round days of each note, and the lens reads every round of that range).
// The body keeps its first answer in state, so the page keys it by that answer too (review r2-7: below).

const st = vi.hoisted(() => ({ list: null as null | (() => Promise<unknown>), insights: null as null | (() => Promise<unknown>) }));
// what the body shows and how often it was mounted (the stub below)
const body = vi.hoisted(() => ({ shown: null as null | { last: string | undefined; prompts: number }, mounts: 0 }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}${JSON.stringify(v)}` : k),
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null } }),
}));
vi.mock("../../_components/saved-filters-server", () => ({ loadSavedFilters: async () => [] }));
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string) => {
    if (name === "website/prompts-page") return st.list!();
    if (name === "website/prompts-options")
      return Promise.resolve({ geographyOptions: ["US"], languageOptions: ["en"], brandOptions: ["Hyundai"], engineOptions: ["chatgpt"], selectableDates: ["2026-10-09"] });
    if (name === "website/prompts-insights" && st.insights) return st.insights();
    return new Promise(() => {}); // the insights: not needed for the frame
  },
}));
// The body as it keeps its answer (website-prompts-view.tsx: useState(initial) · useState(initialInsights)), drawing nothing.
vi.mock("./_components/website-prompts-view", async () => {
  const { useState } = await import("react");
  return {
    RnWebsitePrompts: ({ initial, initialInsights }: { initial: { roundAxis: string[] }; initialInsights: { prompts: number } }) => {
      const [data] = useState(() => {
        body.mounts += 1;
        return initial;
      });
      const [insights] = useState(initialInsights);
      body.shown = { last: data.roundAxis.at(-1), prompts: insights.prompts };
      return null;
    },
  };
});

const Page = (await import("./page")).default;
const { RnFilterSplit } = await import("../../_components/filter-split");
const { RnPageHeader } = await import("@/components/renewal-ui");

type Period = { from: string; to: string } | null;
type Split = ReactElement<{ header: unknown; notesPeriod?: Period | Promise<Period> }>;

/** The first element `is` picks in a server tree (props are walked, nothing is rendered). */
function findWhere<P>(node: unknown, is: (el: ReactElement) => boolean): ReactElement<P> | null {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    if (is(n)) return n as ReactElement<P>;
    for (const v of Object.values(n.props as Record<string, unknown>)) queue.push(v);
  }
  return null;
}

/** The first element of `type` in a server tree. */
const find = <P,>(node: unknown, type: unknown) => findWhere<P>(node, (el) => el.type === type);

/** The text of a server subtree: function components are called (async ones awaited), Suspense shows its content. */
async function textOf(node: unknown): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(textOf))).join("");
  if (!isValidElement(node)) return "";
  const props = node.props as { children?: unknown };
  if (typeof node.type === "function") return textOf(await (node.type as (p: unknown) => unknown)(props));
  return textOf(props.children);
}

async function split(time?: string): Promise<Split> {
  const sp: Record<string, string> = time ? { time } : {};
  const tree = await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) });
  const found = find<Split["props"]>(tree, RnFilterSplit);
  expect(found).not.toBeNull();
  return found!;
}

const listOf = (roundAxis: string[]) => () => Promise.resolve({ rows: [], total: 0, listed: 0, page: 1, pages: 1, pageSize: 50, rangeFrom: 0, rangeTo: 0, sort: "id", dir: "asc", roundAxis });
// live website/prompts-page with no time (2026-11-03): 14 rounds, 07-03 ~ 10-09
const AXIS = ["2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-07-31", "2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18", "2026-10-02", "2026-10-09"];

beforeEach(() => {
  st.list = listOf(AXIS);
  st.insights = null;
  body.shown = null;
  body.mounts = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renewal Website Prompts: the service week's notes take the page's rounds", () => {
  it("every round (no 기간): the list's first to last round, the range the header chip names", async () => {
    const s = await split();
    expect(await s.props.notesPeriod).toEqual({ from: "2026-07-03", to: "2026-10-09" });
    const header = find<{ meta: unknown }>(s.props.header, RnPageHeader)!;
    expect(await textOf(header.props.meta)).toContain('basisRounds{"from":"2026-07-03","to":"2026-10-09"}');
  });

  it("a 기간: none of its own — the notes take the URL's, the lens the list reads (review r2-10)", async () => {
    // the notes match a period by their round days, and the lens reads every round of the URL range: 07-01..07-21 would
    // have read Kia Italy's 07-20 round, the one Gold did not publish, as the other Website pages over that URL say
    st.list = listOf(["2026-07-03", "2026-07-10", "2026-07-17"]);
    const s = await split("2026-07-01..2026-07-21");
    expect(s.props.notesPeriod).toBeUndefined();
    // the header still names the rounds the lens leaves
    const header = find<{ meta: unknown }>(s.props.header, RnPageHeader)!;
    expect(await textOf(header.props.meta)).toContain('basisRounds{"from":"2026-07-03","to":"2026-07-17"}');
  });

  it("no round, or a failed list read: no period (no note)", async () => {
    st.list = listOf([]);
    expect(await (await split()).props.notesPeriod).toBeNull();
    st.list = () => {
      const down = Promise.reject(new Error("503"));
      down.catch(() => {}); // the body reads it later
      return down;
    };
    expect(await (await split()).props.notesPeriod).toBeNull();
  });
});

/** The body the page renders: its section run (it waits for the list and the insights), as the client receives it. */
async function bodyOf(): Promise<ReactElement> {
  const tree = await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({}) });
  const section = findWhere<Record<string, unknown>>(tree, (el) => "bodyKey" in (el.props as object));
  expect(section).not.toBeNull();
  return (section!.type as (p: unknown) => Promise<ReactElement>)(section!.props);
}

const insightsOf = (prompts: number) => () => Promise.resolve({ prompts, engines: [], rounds: [], engineSets: [], brands: [], markets: [], langCount: 0, siteCount: 0 });

describe("renewal Website Prompts: a new answer to the same query reaches the body (review r2-7)", () => {
  // The shell re-reads the page once the service week moved (router.refresh(), components/service-week/sync.ts), and a
  // refresh keeps a client component's state while its type and key stay. Keyed by the URL alone, the body went on
  // showing the week before (its KPI strip '2026-10-09 회차') under a header and a chip naming the next week.
  it("the next week's answer mounts the body again with it; the same answer keeps it (its page, an open row)", async () => {
    st.insights = insightsOf(10021);
    const first = await bodyOf();
    st.list = listOf([...AXIS, "2026-10-16"]);
    st.insights = insightsOf(10500);
    const moved = await bodyOf();
    const again = await bodyOf();

    const root = clientRoot();
    await root.render(first);
    expect(body.shown).toEqual({ last: "2026-10-09", prompts: 10021 });
    await root.render(moved);
    expect(body.shown).toEqual({ last: "2026-10-16", prompts: 10500 });
    const mounts = body.mounts;
    await root.render(again);
    expect(body.mounts).toBe(mounts);
    await root.unmount();
  });
});
