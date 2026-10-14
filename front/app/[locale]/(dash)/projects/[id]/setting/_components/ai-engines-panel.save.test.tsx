import { beforeEach, describe, expect, it, vi } from "vitest";

// Setting > AI 엔진 panel, save path (#16). The panel is called as a plain function with a minimal hook
// shim (no DOM in this test setup): useState slots are recorded in call order, useTransition runs the
// callback, the save button's onClick is invoked from the returned element tree. Proves:
//   - the save sends the carried kept engines back unchanged (a project without them sends [], which the
//     action turns into the body of before: setting/_actions*.test.ts, lib/hgh/adapters/projects.test.ts)
//   - after the save the panel carries the stored kept engines, the local history row shows the stored
//     set, and the "all engines off" toast only fires when nothing is measured any more.

const h = vi.hoisted(() => ({
  slots: [] as { value: unknown }[],
  transitions: [] as Promise<unknown>[],
  toasts: [] as [string, string][],
  save: vi.fn(),
}));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const slot = { value: typeof init === "function" ? (init as () => unknown)() : init };
      h.slots.push(slot);
      const set = (v: unknown) => {
        slot.value = typeof v === "function" ? (v as (p: unknown) => unknown)(slot.value) : v;
      };
      return [slot.value, set];
    },
    useTransition: () => [false, (fn: () => Promise<unknown>) => void h.transitions.push(fn())],
  };
});
vi.mock("next-intl", () => ({ useTranslations: (ns: string) => (k: string) => `${ns}.${k}` }));
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => h.toasts.push(["success", m]),
    warning: (m: string) => h.toasts.push(["warning", m]),
    error: (m: string) => h.toasts.push(["error", m]),
  },
}));
vi.mock("../_actions", () => ({ updateProjectEngines: (...a: unknown[]) => h.save(...a) }));

const { AiEnginesPanel } = await import("./ai-engines-panel");
const { Button } = await import("@/components/ui/button");

type El = { type: unknown; props: { children?: unknown; onClick?: () => void } };
function find(node: unknown, type: unknown): El[] {
  const out: El[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === "object" && "props" in n) {
      const el = n as El;
      if (el.type === type) out.push(el);
      visit(el.props.children);
    }
  };
  visit(node);
  return out;
}

// useState call order in the panel: engines, saved, savedExplicit, rows, keptEngines.
const SLOT = { engines: 0, saved: 1, explicit: 2, rows: 3, kept: 4 } as const;
const NS = "projectDetail.setting.aiEngines";

async function save(props: Partial<Parameters<typeof AiEnginesPanel>[0]>, reply: unknown) {
  h.save.mockResolvedValue(reply);
  const tree = AiEnginesPanel({ projectId: "p1", initial: ["chatgpt"], explicit: true, history: [], ...props });
  const [button] = find(tree, Button);
  button.props.onClick!();
  await Promise.all(h.transitions);
}

beforeEach(() => {
  h.slots.length = 0;
  h.transitions.length = 0;
  h.toasts.length = 0;
  h.save.mockReset();
});

describe("AiEnginesPanel save (#16)", () => {
  it("a project in the front vocabulary: sends kept [] and keeps the old state, history row and toast", async () => {
    await save({}, { ok: true, value: { engines: ["chatgpt"], changed: true, pushed: true, queued: true } });
    expect(h.save).toHaveBeenCalledWith("p1", ["chatgpt"], []);
    expect(h.slots[SLOT.saved].value).toEqual(["chatgpt"]);
    expect(h.slots[SLOT.kept].value).toEqual([]);
    expect((h.slots[SLOT.rows].value as { engines: string[] }[]).map((r) => r.engines)).toEqual([["chatgpt"]]);
    expect(h.toasts).toEqual([["success", `${NS}.savedQueued`]]);
  });

  it("kept engines go back unchanged and stay carried; the history row shows the stored set", async () => {
    await save(
      { initial: ["chatgpt"], kept: ["claude-web"] },
      { ok: true, value: { engines: ["chatgpt"], changed: true, pushed: true, queued: true, kept: ["claude-web"] } },
    );
    expect(h.save).toHaveBeenCalledWith("p1", ["chatgpt"], ["claude-web"]);
    expect(h.slots[SLOT.engines].value).toEqual(["chatgpt"]);
    expect(h.slots[SLOT.kept].value).toEqual(["claude-web"]);
    expect((h.slots[SLOT.rows].value as { engines: string[] }[]).map((r) => r.engines)).toEqual([["chatgpt", "claude-web"]]);
    expect(h.toasts).toEqual([["success", `${NS}.savedQueued`]]);
  });

  it("every checkbox off: 'collection stops' only when no kept engine is left (api); legacy as before", async () => {
    await save(
      { initial: [], kept: ["claude-web"], keptCollects: true },
      { ok: true, value: { engines: [], changed: true, pushed: true, queued: true, kept: ["claude-web"] } },
    );
    expect(h.toasts).toEqual([["success", `${NS}.savedQueued`]]);
    h.slots.length = 0;
    h.transitions.length = 0;
    h.toasts.length = 0;
    // legacy: the Scope schedule is disabled (front vocabulary only), so the warning stays
    await save({ initial: [], kept: ["claude-web"] }, { ok: true, value: { engines: [], changed: true, pushed: true, kept: ["claude-web"] } });
    expect(h.toasts).toEqual([["warning", `${NS}.savedNone`]]);
    h.slots.length = 0;
    h.transitions.length = 0;
    h.toasts.length = 0;
    await save({ initial: [] }, { ok: true, value: { engines: [], changed: true, pushed: true, queued: true } });
    expect(h.toasts).toEqual([["warning", `${NS}.savedNone`]]);
  });

  it("a refused save keeps the carried kept engines and shows the error", async () => {
    await save({ kept: ["claude-web"] }, { ok: false, error: "알 수 없는 엔진입니다" });
    expect(h.slots[SLOT.kept].value).toEqual(["claude-web"]);
    expect(h.toasts).toEqual([["error", "알 수 없는 엔진입니다"]]);
  });
});
