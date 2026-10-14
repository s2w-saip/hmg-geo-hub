import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Tone URL sub page, api source (B045): the two tab counts (BG-27) ignore q, the cursor, the tab and
// the domain switch, so a cursor or search move made inside the screen (the router's fetch,
// Sec-Fetch-Dest "empty") does not ask with_counts again: counts null -> the screen reuses the
// counts it already shows (CitationToneUrlsPage). A document request (reload, opened URL) and the
// first page keep the former call (with_counts=true). Same rows either way; URL contract unchanged.

const st = vi.hoisted(() => ({ legacy: [] as string[], headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(st.headers) }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("nf");
  },
  redirect: (to: string) => {
    throw new Error(`rd:${to}`);
  },
}));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined, getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"], regions: [], countries: ["US", "KR"] }, operator: "none", menuGroups: null },
  }),
}));
const legacyProxy = () =>
  new Proxy(
    {},
    {
      has: () => true,
      get: (_t, name) =>
        name === "then" || name === "__esModule"
          ? undefined
          : async () => {
              st.legacy.push(String(name));
              return null;
            },
    },
  );
vi.mock("@/lib/scope/server", () => legacyProxy());
vi.mock("@/lib/db/repositories/scope-aggregates", () => legacyProxy());

const { bindHghAuth } = await import("@/lib/hgh/auth");
const TonePage = (await import("./page")).default;
const { CitationToneUrlsPage } = await import("../../_components/citation-tone-urls-page");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const log: URL[] = [];
const ITEM = { url: "https://hyundai.news/eu/x", skey: "hyundai.news", title: "t", prompt_text: null, citations: 2, engines: ["chatgpt"], category: null };

beforeEach(() => {
  st.legacy = [];
  st.headers = {};
  log.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_SOURCE_G2", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      log.push(url);
      const withCounts = url.searchParams.get("with_counts") === "true";
      const body =
        url.pathname === "/v1/citations/sources/tone"
          ? {
              data: { items: [ITEM], counts: withCounts ? { positive: 3, negative: 1 } : null },
              meta: { mode: "cumulative", as_of: "2026-09-21", cycles: ["2026-09-21"], page: { limit: 50, next_cursor: "n2", total: 120 } },
            }
          : { error: { code: "not_found" } };
      return new Response(JSON.stringify(body), { status: body.error ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const args = (sp: Record<string, string>) => ({
  params: Promise.resolve({ locale: "ko" }),
  searchParams: Promise.resolve(sp as Record<string, string | string[] | undefined>),
});

/** Props handed to the client screen (the page is one server component, nothing else to resolve). */
function viewProps(node: unknown): Record<string, unknown> {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    const el = n as ReactElement<Record<string, unknown>>;
    if (el.type === CitationToneUrlsPage) return el.props;
    queue.push(el.props.children);
  }
  throw new Error("CitationToneUrlsPage not rendered");
}

const toneCalls = () => log.filter((u) => u.pathname === "/v1/citations/sources/tone").map((u) => u.searchParams);
const IN_SCREEN = { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };
const DOCUMENT = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

describe("tone sub page: with_counts only where the screen has no counts yet (B045)", () => {
  it("first page (entry, tab switch, domain switch): counts asked, even inside the screen", async () => {
    for (const headers of [IN_SCREEN, DOCUMENT, {}]) {
      st.headers = headers;
      log.length = 0;
      const props = viewProps(await TonePage(args({ tone: "negative", by: "domain" })));
      expect(props.counts).toEqual({ positive: 3, negative: 1 });
      expect(toneCalls().map((q) => [q.get("with_counts"), q.get("group_by"), q.get("cursor")])).toEqual([["true", "source", null]]);
    }
    expect(st.legacy).toEqual([]);
  });

  it("cursor or search move inside the screen: one call without with_counts, counts null (reuse); the rows are the same", async () => {
    st.headers = IN_SCREEN;
    const moved = [
      viewProps(await TonePage(args({ tone: "positive", page: "2", cursor: "c1" }))),
      viewProps(await TonePage(args({ tone: "positive", q: "ev" }))),
    ];
    expect(toneCalls().map((q) => [q.get("cursor"), q.get("q"), q.get("with_counts")])).toEqual([
      ["c1", null, null],
      [null, "ev", null],
    ]);
    expect(moved.map((p) => p.counts)).toEqual([null, null]);

    // the same URLs as a document request: counts asked as before, same page rows
    st.headers = DOCUMENT;
    log.length = 0;
    const loaded = [
      viewProps(await TonePage(args({ tone: "positive", page: "2", cursor: "c1" }))),
      viewProps(await TonePage(args({ tone: "positive", q: "ev" }))),
    ];
    expect(toneCalls().map((q) => q.get("with_counts"))).toEqual(["true", "true"]);
    expect(loaded.map((p) => p.counts)).toEqual([
      { positive: 3, negative: 1 },
      { positive: 3, negative: 1 },
    ]);
    expect(loaded.map((p) => p.page)).toEqual(moved.map((p) => p.page));
  });

  it("no fetch metadata (older browser): the former call (with_counts=true)", async () => {
    viewProps(await TonePage(args({ tone: "positive", page: "2", cursor: "c1" })));
    expect(toneCalls().map((q) => q.get("with_counts"))).toEqual(["true"]);
  });

  it("a blank search is not a search move (q trimmed): counts asked", async () => {
    st.headers = IN_SCREEN;
    viewProps(await TonePage(args({ tone: "positive", q: "  " })));
    expect(toneCalls().map((q) => q.get("with_counts"))).toEqual(["true"]);
  });
});
