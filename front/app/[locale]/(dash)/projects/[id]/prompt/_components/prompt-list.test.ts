import { describe, expect, it, vi } from "vitest";

// Pure rules of the prompt list (B016 tag-column delete confirmation, B019 lifecycle status overlay).
// The list renders 200 rows at a time (useWindowedRows); these rules decide what it shows for rows
// and values outside that window. The server actions are not called here.
vi.mock("../_actions", () => ({}));

const { applyStatusOverlay, statusAfterLifecycle, usedTagFieldIds } = await import("./prompt-list");
type Row = Parameters<typeof applyStatusOverlay>[0][number];

const row = (i: number, d: Partial<Row> = {}): Row => ({
  id: `p${i}`,
  text: `t${i}`,
  promptType: null,
  category: null,
  brand: null,
  status: "draft",
  scopePromptId: null,
  customValues: {},
  ...d,
});
// The loaded window: 200 rows, none of them tagged.
const WINDOW = Array.from({ length: 200 }, (_, i) => row(i));

describe("usedTagFieldIds: which tag columns ask before the hard delete (B016)", () => {
  it("a column whose values are all outside the loaded window still asks (server value_count)", () => {
    const used = usedTagFieldIds(
      [
        { id: "outside", label: "Outside", archived: false, valueCount: 3 },
        { id: "empty", label: "Empty", archived: false, valueCount: 0 },
      ],
      WINDOW,
    );
    expect(used.has("outside")).toBe(true);
    expect(used.has("empty")).toBe(false);
  });

  it("legacy rows (no valueCount) keep the loaded-rows rule", () => {
    expect(usedTagFieldIds([{ id: "f", label: "F", archived: false }], WINDOW).has("f")).toBe(false);
    const tagged = [...WINDOW.slice(1), row(0, { customValues: { f: "SUV" } })];
    expect(usedTagFieldIds([{ id: "f", label: "F", archived: false }], tagged).has("f")).toBe(true);
  });

  it("values saved on screen since the render count too (loaded rows and rows outside the window)", () => {
    const fields = [{ id: "f", label: "F", archived: false, valueCount: 0 }];
    expect(usedTagFieldIds(fields, [row(0, { customValues: { f: "v" } })]).has("f")).toBe(true);
    // Bulk tagging of a select-all selection writes rows that are not loaded: the overlay carries them.
    expect(usedTagFieldIds(fields, WINDOW, { p999: { f: "v" } }).has("f")).toBe(true);
    // A cleared value (null) does not count.
    expect(usedTagFieldIds(fields, WINDOW, { p0: { f: null } }).has("f")).toBe(false);
  });
});

describe("applyStatusOverlay: pause / resume shows the action at once, then the server's status (B019)", () => {
  it("resume: 'done' until the revalidated row arrives, then the server status (unpublished rows come back 'queued')", () => {
    const overlay = { p1: { status: "done" as const, from: "paused" as const } };
    const before = [row(1, { status: "paused" })];
    expect(applyStatusOverlay(before, overlay).map((r) => r.status)).toEqual(["done"]);
    const queued = [row(1, { status: "queued" })];
    expect(applyStatusOverlay(queued, overlay).map((r) => r.status)).toEqual(["queued"]);
    const done = [row(1, { status: "done", scopePromptId: "s1" })];
    expect(applyStatusOverlay(done, overlay).map((r) => r.status)).toEqual(["done"]);
  });

  it("pause: 'paused' at once; other rows untouched", () => {
    const overlay = { p1: { status: "paused" as const, from: "done" as const } };
    const rows = [row(1, { status: "done" }), row(2, { status: "running" })];
    expect(applyStatusOverlay(rows, overlay).map((r) => r.status)).toEqual(["paused", "running"]);
    expect(applyStatusOverlay([row(1, { status: "paused" })], overlay)[0].status).toBe("paused");
  });
});

describe("statusAfterLifecycle: the overlay status right after pause / resume (B019)", () => {
  it("the server status when the action answers one (api source): resume of an unpublished row shows 'queued' at once", () => {
    expect(statusAfterLifecycle(true, { status: "queued" })).toBe("queued");
    expect(statusAfterLifecycle(true, { status: "done" })).toBe("done");
    expect(statusAfterLifecycle(false, { status: "paused" })).toBe("paused");
    // The overlay then matches the revalidated row: nothing flips from 'done' to 'queued' later.
    const overlay = { p1: { status: statusAfterLifecycle(true, { status: "queued" }), from: "paused" as const } };
    expect(applyStatusOverlay([row(1, { status: "paused" })], overlay)[0].status).toBe("queued");
    expect(applyStatusOverlay([row(1, { status: "queued" })], overlay)[0].status).toBe("queued");
  });

  it("no value (legacy source, or a status the list cannot show): the old overlay, resume 'done', pause 'paused'", () => {
    expect(statusAfterLifecycle(true, undefined)).toBe("done");
    expect(statusAfterLifecycle(false, undefined)).toBe("paused");
  });
});
