import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Renewal ACR: the header pill names the period as the reads take it (acr/renewal-header: the URL range held to the
// service week) or, for a snapshot, the round the body's read answered. Review r1-18 (2026-11-03): a period wholly
// after the week — the header answers period true with no days — read '기간 누적 … ~ …', an open range over every
// round, while the body said there is no ACR result; and a snapshot whose read answered no round (none in the service
// week) kept the loading label '최신 회차 스냅샷'. Both print "—", as the Citation and Mention pills do.

const st = vi.hoisted(() => ({
  head: { period: false, dateFrom: null, dateTo: null } as { period: boolean; dateFrom: string | null; dateTo: string | null },
  asOf: null as string | null,
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
  screenGet: async (name: string) => {
    if (name === "acr/renewal-header") return st.head;
    if (name === "acr/renewal")
      return {
        props: { stage: "acr", languageOptions: [] },
        body: { measured: st.asOf != null, filtered: false, acrPromptCount: 67, roundBuckets: true, period: st.head.period, asOf: st.asOf, ownLabel: "HMG", totals: {}, view: null },
      };
    throw new Error(`unexpected screen ${name}`);
  },
}));

const Page = (await import("./page")).default;
const { RnPageHeader } = await import("@/components/renewal-ui");

type El = ReactElement<Record<string, unknown>>;

/** The first element (breadth first, through props) that `match` accepts. */
function find(node: unknown, match: (n: El) => boolean): El | null {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    if (match(n as El)) return n as El;
    for (const v of Object.values(n.props as Record<string, unknown>)) queue.push(v);
  }
  return null;
}

/** The text of a server subtree: function components are called (async ones awaited). */
async function textOf(node: unknown): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(textOf))).join("");
  if (!isValidElement(node)) return "";
  const props = node.props as { children?: unknown };
  if (typeof node.type === "function") return textOf(await (node.type as (p: unknown) => unknown)(props));
  return textOf(props.children);
}

const pillOf = (tree: unknown) => {
  const header = find(tree, (n) => n.type === RnPageHeader);
  expect(header).not.toBeNull();
  return textOf(header!.props.meta);
};

/** The pill while the body's read loads (the Suspense fallback's header) and once it has answered (the page body's). */
async function pills(time?: string): Promise<{ loading: string; answered: string }> {
  const tree = await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(time ? { time } : {}) });
  const fallback = find(tree, (n) => isValidElement(n.props.fallback));
  const body = find(tree, (n) => typeof n.props.header === "function");
  expect(fallback && body).not.toBeNull();
  const answered = await (body!.type as (p: unknown) => Promise<unknown>)(body!.props);
  return { loading: await pillOf(fallback!.props.fallback), answered: await pillOf(answered) };
}

beforeEach(() => {
  st.head = { period: false, dateFrom: null, dateTo: null };
  st.asOf = "2026-10-05";
});

describe("renewal ACR header pill", () => {
  it("a period wholly after the service week (no days) prints '—', not an open range", async () => {
    st.head = { period: true, dateFrom: null, dateTo: null };
    st.asOf = null;
    const { loading, answered } = await pills("2026-10-12..2026-10-25");
    for (const text of [loading, answered]) {
      expect(text).toContain("—");
      expect(text).not.toContain("periodRange");
      expect(text).not.toContain("…");
    }
  });

  it("a period prints its days as the reads take them, an open end as before", async () => {
    st.head = { period: true, dateFrom: "2026-10-01", dateTo: "2026-10-11" };
    expect((await pills("2026-10-01..2026-10-25")).answered).toContain('periodRange{"from":"2026-10-01","to":"2026-10-11"}');
    st.head = { period: true, dateFrom: null, dateTo: "2026-10-11" };
    expect((await pills("..2026-10-25")).answered).toContain('periodRange{"from":"…","to":"2026-10-11"}');
  });

  it("a snapshot names the round the body answered; the loading skeleton keeps its label", async () => {
    const { loading, answered } = await pills();
    expect(answered).toContain('snapshotOf{"date":"2026-10-05"}');
    expect(loading).toContain("snapshot");
    expect(loading).not.toContain("2026-10-05");
  });

  it("a snapshot whose read answered no round (none in the service week) prints '—', not the loading label", async () => {
    st.asOf = null;
    const { loading, answered } = await pills();
    expect(answered).toContain("—");
    expect(answered).not.toContain("snapshot");
    expect(loading).toContain("snapshot");
  });
});
