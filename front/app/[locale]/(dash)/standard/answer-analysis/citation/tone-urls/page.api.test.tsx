import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Tone URL sub page (B045): the two tab counts (BG-27) ignore q, the cursor, the tab and the domain
// switch, so a cursor or search move made inside the screen (the router's fetch, Sec-Fetch-Dest
// "empty") does not ask with_counts again: counts null -> the screen reuses the counts it already
// shows (CitationToneUrlsPage). The page tells the screen API it is an in-page move
// (ctx.client_nav=1); the screen (back/bff/screens/citation.py tone_urls) decides from that, the
// cursor and q whether to count. A document request (reload, opened URL) never sends the flag.

const st = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
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
    user: { id: "u1", email: "x", role: "hq", scope: { all: true }, operator: "none", menuGroups: null },
  }),
}));

const TonePage = (await import("./page")).default;
const { CitationToneUrlsPage } = await import("../../_components/citation-tone-urls-page");

const log: URL[] = [];
const PAGE = { rows: [], total: 120, page: 2, pageSize: 50, nextCursor: "n2", win: { page: 2, pages: 3, from: 51, to: 100 } };

beforeEach(() => {
  st.headers = {};
  log.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = new URL(String(u));
      log.push(url);
      const reuse = url.searchParams.get("ctx.client_nav") === "1" && Boolean(url.searchParams.get("cursor") || (url.searchParams.get("q") ?? "").trim());
      const body = { tone: "positive", q: url.searchParams.get("q") ?? "", byDomain: false, page: PAGE, counts: reuse ? null : { positive: 3, negative: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
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

const flags = () => log.map((u) => [u.pathname, u.searchParams.get("ctx.client_nav")]);
const IN_SCREEN = { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };
const DOCUMENT = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

describe("tone sub page: the in-page move flag (B045)", () => {
  it("inside the screen: ctx.client_nav=1 with the URL; the screen's null counts reach the page (reuse)", async () => {
    st.headers = IN_SCREEN;
    const props = viewProps(await TonePage(args({ tone: "positive", page: "2", cursor: "c1" })));
    expect(flags()).toEqual([["/v1/screens/citation/tone-urls", "1"]]);
    expect([props.counts, props.page]).toEqual([null, PAGE]);
    expect(log[0].searchParams.get("cursor")).toBe("c1");
  });

  it("a document request or no fetch metadata: no flag (counts asked as before)", async () => {
    for (const headers of [DOCUMENT, {}]) {
      st.headers = headers;
      log.length = 0;
      const props = viewProps(await TonePage(args({ tone: "positive", q: "ev" })));
      expect(flags()).toEqual([["/v1/screens/citation/tone-urls", null]]);
      expect(props.counts).toEqual({ positive: 3, negative: 1 });
    }
  });
});
