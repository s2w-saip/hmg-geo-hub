import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Renewal Citation (Global and Website): the header pill prints the period the page shows. Until the service week
// (2026-11-02) it printed the URL's own range, so a URL or a saved filter past the week — 2026-10-01..2026-10-31 with
// the week ending 10-11 — read as data up to 10-31. It now prints the effective period the BFF answers in
// citation/renewal-header (`period`: the URL range held to the service week, null when there is none to show; no Gold
// read, review r2-13: from citation/as-of it waited for the citation read).

const st = vi.hoisted(() => ({
  asOf: null as null | (() => Promise<unknown>),
  head: null as null | (() => Promise<unknown>),
  calls: [] as string[],
}));
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
vi.mock("../../../_components/saved-filters-server", () => ({ loadSavedFilters: async () => [] }));
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string) => {
    st.calls.push(name);
    if (name === "citation/as-of") return st.asOf!();
    if (name === "citation/renewal-header") return st.head!();
    if (name === "citation/filter-bar")
      return Promise.resolve({
        options: { catalogRows: [], geographyOptions: ["US"], languageOptions: ["en"], optionMatrix: [] },
        dates: { collectionStartDay: null, latestAnchorDay: "2026-10-05", selectableDates: ["2026-10-05"] },
      });
    return new Promise(() => {}); // the body's reads: not needed for the header
  },
}));

const GlobalPage = (await import("./page")).default;
const WebsitePage = (await import("../../../website/answer-analysis/citation/page")).default;
const { RnPageHeader } = await import("@/components/renewal-ui");

type Page = (p: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

/** The page's header element (handed to the skeleton and to the page body as a prop). */
function findHeader(node: unknown): ReactElement<{ meta: unknown }> | null {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    if (n.type === RnPageHeader) return n as ReactElement<{ meta: unknown }>;
    for (const v of Object.values(n.props as Record<string, unknown>)) queue.push(v);
  }
  return null;
}

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

async function pill(page: Page, time?: string): Promise<string> {
  const sp: Record<string, string> = time ? { time } : {};
  const tree = await page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) });
  const header = findHeader(tree);
  expect(header).not.toBeNull();
  return textOf(header!.props.meta);
}

beforeEach(() => {
  st.calls = [];
  st.asOf = () => Promise.resolve({ asOf: "2026-10-05", competitorOptions: [], period: null });
  st.head = () => Promise.resolve({ period: null });
});

/** `p`, or "(waiting)" when it has not settled within 50 ms. */
function soon<T>(p: Promise<T>): Promise<T | "(waiting)"> {
  return Promise.race([p, new Promise<"(waiting)">((r) => setTimeout(() => r("(waiting)"), 50))]);
}

describe.each([
  ["Global", GlobalPage as Page],
  ["Website", WebsitePage as Page],
])("renewal %s Citation header period", (_surface, page) => {
  it("prints the BFF's effective period, not the URL's range past the service week", async () => {
    st.head = () => Promise.resolve({ period: { from: "2026-10-01", to: "2026-10-11" } });
    const text = await pill(page, "2026-10-01..2026-10-31");
    expect(text).toContain('periodRange{"from":"2026-10-01","to":"2026-10-11"}');
    expect(text).not.toContain("2026-10-31");
  });

  it("prints it without waiting for the citation read (review r2-13)", async () => {
    // citation/as-of answers after the citation read (1.4–12.7 s cold on live Gold); the period needs none of it
    st.asOf = () => new Promise(() => {});
    st.head = () => Promise.resolve({ period: { from: "2026-09-07", to: "2026-10-11" } });
    expect(await soon(pill(page, "2026-09-07..2026-10-31"))).toContain('periodRange{"from":"2026-09-07","to":"2026-10-11"}');
  });

  it("a period with nothing to show (wholly after the week) or a failed read prints no dates", async () => {
    st.head = () => Promise.resolve({ period: null });
    const empty = await pill(page, "2026-10-20..2026-10-31");
    expect(empty).toContain("—");
    expect(empty).not.toContain("2026-10-2");
    st.head = () => {
      const down = Promise.reject(new Error("503"));
      down.catch(() => {}); // the page reads it later, in the header
      return down;
    };
    const failed = await pill(page, "2026-10-20..2026-10-31");
    expect(failed).toContain("—");
    expect(failed).not.toContain("2026-10-31");
  });

  it("no period: the round the page shows, as before", async () => {
    const text = await pill(page);
    expect(text).toContain('lastMeasured{"date":"2026-10-05"}');
    expect(text).not.toContain("periodRange");
    expect(st.calls).not.toContain("citation/renewal-header");
  });
});

it("the Website page asks citation/as-of only for a snapshot's round (it has no 경쟁사 options)", async () => {
  await pill(WebsitePage as Page, "2026-09-07..2026-10-31");
  expect(st.calls).toContain("citation/renewal-header");
  expect(st.calls).not.toContain("citation/as-of");
});
