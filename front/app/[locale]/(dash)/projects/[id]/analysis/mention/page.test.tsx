import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /projects/[id]/analysis/mention: the gate (loadProjectAnalysisContext) first, then ONE screen,
// mention/view with ctx.surface=project (the project's options and custom-field filters, the mention
// body, Sub KPI, previous window and calendar are read and computed by the API,
// back/bff/screens/mention_surfaces.py). MentionsView draws its own filter panel from the payload.

const st = vi.hoisted(() => ({ calls: [] as { name: string; query: Record<string, unknown> }[] }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("../_lib/auth-and-locks", () => ({
  loadProjectAnalysisContext: async () => ({ locks: [{ group: "geography", value: "US" }], lockedGroups: ["geography"] }),
}));
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    return {
      data: null,
      degraded: { data: false, types: false, subKpis: false },
      subKpis: null,
      prevSubKpis: null,
      prevBasisDate: null,
      panel: { catalogRows: [], engineOptions: ["chatgpt"], dynamicAxes: [{ id: "f1", label: "캠페인", options: ["봄"] }], selectableDates: null },
    };
  },
}));

const Page = (await import("./page")).default;

function find(node: unknown, name: string): Record<string, unknown> | null {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    const el = n as ReactElement<Record<string, unknown>>;
    if (typeof el.type !== "string" && (el.type as { name?: string }).name === name) return el.props;
    queue.push(el.props.children);
  }
  return null;
}

beforeEach(() => {
  st.calls = [];
});

describe("project mention page", () => {
  it("one mention/view screen with the project context; the panel props come from its payload", async () => {
    const id = "e0011964-039f-423b-a754-d74d9e2249f3";
    const tree = await Page({ params: Promise.resolve({ locale: "ko", id }), searchParams: Promise.resolve({ time: "2026-09-01..2026-09-30", cf_f1: "봄" }) });
    expect(st.calls).toEqual([
      { name: "mention/view", query: { time: "2026-09-01..2026-09-30", cf_f1: "봄", "ctx.surface": "project", "ctx.project_id": id } },
    ]);
    const view = find(tree, "MentionsView")!;
    expect(view.compareSource).toEqual({ surface: "project", projectId: id });
    expect(view.lockedGroups).toEqual(["geography"]);
    expect(view.engineOptions).toEqual(["chatgpt"]);
    expect(view.dynamicAxes).toEqual([{ id: "f1", label: "캠페인", options: ["봄"] }]);
    expect(view.selectableDates).toBeUndefined();
    expect(view.lazyPrompts).toBe(true);
  });
});
