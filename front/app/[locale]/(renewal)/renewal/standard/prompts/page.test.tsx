import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { clientRoot } from "@/test/client-root";

// Renewal Global Prompts: the view keeps its first catalog page in state (prompts-view.tsx useState(remote.initial)),
// and its own reads replace it. The shell re-reads the page once the service week moved (router.refresh(),
// components/service-week/sync.ts), which keeps a client component's state while its type and key stay: unkeyed, the
// catalog went on with the week before under a header ('수집 기간 … ~ 2026-10-12') and a chip naming the next week
// (review r2-7, 2026-11-03). The page keys it by its answer: a new one mounts it again, the same one keeps it.

const st = vi.hoisted(() => ({ catalog: null as unknown }));
// what the view shows and how often it was mounted (the stub below)
const view = vi.hoisted(() => ({ shown: null as null | number, mounts: 0 }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null } }),
}));
vi.mock("../../_components/saved-filters-server", () => ({ loadSavedFilters: async () => [] }));
vi.mock("@/app/[locale]/(dash)/standard/prompts/_data/server", () => ({
  loadPromptsScreens: async () => ({ catalog: st.catalog, header: { period: { from: "2026-06-08", to: "2026-10-05" } }, history: { available: true, shown: 0, groups: [] } }),
}));
// The view as it keeps its answer, drawing nothing.
vi.mock("./_components/prompts-view", async () => {
  const { useState } = await import("react");
  return {
    RnPromptsView: ({ remote }: { remote: { initial: { count: number } } }) => {
      const [data] = useState(() => {
        view.mounts += 1;
        return remote.initial;
      });
      view.shown = data.count;
      return null;
    },
  };
});

const Page = (await import("./page")).default;

/** The page's view for the catalog answer `count` (one row of it, as catalog/prompts-page sends its first page). */
async function viewOf(count: number): Promise<ReactElement> {
  st.catalog = { rows: [{ id: `p${count}` }], total: count, count, facets: {}, columns: [], offset: 0, limit: 50, collation: "ko", page: 1, pages: 1, rangeFrom: 1, rangeTo: 1 };
  return (await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({}) })) as ReactElement;
}

beforeEach(() => {
  view.shown = null;
  view.mounts = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renewal Global Prompts: a new catalog answer reaches the view (review r2-7)", () => {
  it("the next week's catalog mounts the view again with it; the same catalog keeps it (its picks, sort and page)", async () => {
    const first = await viewOf(12164);
    const moved = await viewOf(12201);
    const again = await viewOf(12201);

    const root = clientRoot();
    await root.render(first);
    expect(view.shown).toBe(12164);
    await root.render(moved);
    expect(view.shown).toBe(12201);
    const mounts = view.mounts;
    await root.render(again);
    expect(view.mounts).toBe(mounts);
    await root.unmount();
  });
});
