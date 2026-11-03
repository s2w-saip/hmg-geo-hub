import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { clientRoot } from "@/test/client-root";

// 표준 프롬프트 (the original Global prompts page): the read-only list keeps its first catalog page in state
// (prompt-list-readonly.tsx useState(remote.initial)), and its own reads replace it. The (dash) shell re-reads the page
// once the service week moved (router.refresh(), components/service-week/sync.ts), which keeps a client component's
// state while its type and key stay: unkeyed, the list went on with the week before under a card count and a chip
// naming the next week (review r2-7, 2026-11-03). The page keys it by its answer: a new one mounts it again, the same
// one keeps it.

const st = vi.hoisted(() => ({ catalog: null as unknown }));
// what the list shows and how often it was mounted (the stub below)
const list = vi.hoisted(() => ({ shown: null as null | number, mounts: 0 }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null } }),
}));
vi.mock("./_data/server", () => ({
  loadPromptsScreens: async () => ({ catalog: st.catalog, header: { period: { from: "2026-06-08", to: "2026-10-05" } }, history: { available: true, shown: 0, groups: [] } }),
}));
// The list as it keeps its answer, drawing nothing.
vi.mock("./_components/prompt-list-readonly", async () => {
  const { useState } = await import("react");
  return {
    StandardPromptReadonlyList: ({ remote }: { remote: { initial: { count: number } } }) => {
      const [data] = useState(() => {
        list.mounts += 1;
        return remote.initial;
      });
      list.shown = data.count;
      return null;
    },
  };
});

const Page = (await import("./page")).default;
const { StandardPromptReadonlyList } = await import("./_components/prompt-list-readonly");

/** The first element of `type` in a server tree (props are walked, nothing is rendered). */
function find(node: unknown, type: unknown): ReactElement | null {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    if (n.type === type) return n;
    for (const v of Object.values(n.props as Record<string, unknown>)) queue.push(v);
  }
  return null;
}

/** The page's list for the catalog answer `count` (one row of it, as catalog/prompts-page sends its first page). */
async function listOf(count: number): Promise<ReactElement> {
  st.catalog = { rows: [{ id: `p${count}` }], total: count, count, facets: {}, columns: [], offset: 0, limit: 50, collation: "ko", page: 1, pages: 1, rangeFrom: 1, rangeTo: 1 };
  const found = find(await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({}) }), StandardPromptReadonlyList);
  expect(found).not.toBeNull();
  return found!;
}

beforeEach(() => {
  list.shown = null;
  list.mounts = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("표준 프롬프트: a new catalog answer reaches the list (review r2-7)", () => {
  it("the next week's catalog mounts the list again with it; the same catalog keeps it (its picks, sort and page)", async () => {
    const first = await listOf(12164);
    const moved = await listOf(12201);
    const again = await listOf(12201);

    const root = clientRoot();
    await root.render(first);
    expect(list.shown).toBe(12164);
    await root.render(moved);
    expect(list.shown).toBe(12201);
    const mounts = list.mounts;
    await root.render(again);
    expect(list.mounts).toBe(mounts);
    await root.unmount();
  });
});
