import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

const dialect = new PgDialect();
const compile = (value: ReturnType<typeof sql>) => dialect.sqlToQuery(value).sql;

beforeEach(() => {
  vi.resetModules();
  h.getDb.mockReset();
});

describe("bulk mirror reader gate", () => {
  it("returns true before migration 0073 and does not use DATABASE_URL as a fallback", async () => {
    const db = { execute: vi.fn(async () => [{ table_name: null }]) };
    h.getDb.mockReturnValue(db);
    const reader = await import("./scope-mirror-progress-read");

    expect(compile(await reader.bulkMirrorRunVisibleSql(sql`a.run_id`))).toBe("true");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("builds the exact incomplete-run exclusion after a successful probe", async () => {
    const db = { execute: vi.fn(async () => [{ table_name: "scope_mirror_progress" }]) };
    h.getDb.mockReturnValue(db);
    const reader = await import("./scope-mirror-progress-read");

    const text = compile(await reader.bulkMirrorRunVisibleSql(sql`a.run_id`));
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("scope_mirror_progress p");
    expect(text).toContain("p.run_id = a.run_id");
    expect(text).toContain("p.phase = 'complete'");
    expect(text).toContain("p.phase = 'finalize'");
    expect(text).toContain("p.state->>'step' = 'invalidate-published'");
    expect(text).toContain("IS NOT TRUE");
  });

  it("caches a successful probe and shares one in-flight probe", async () => {
    let resolveProbe!: (value: Array<{ table_name: string }>) => void;
    const pending = new Promise<Array<{ table_name: string }>>((resolve) => { resolveProbe = resolve; });
    const db = { execute: vi.fn(() => pending) };
    h.getDb.mockReturnValue(db);
    const reader = await import("./scope-mirror-progress-read");

    const one = reader.bulkMirrorRunVisibleSql(sql`a.run_id`);
    const two = reader.bulkMirrorRunVisibleSql(sql`b.run_id`);
    resolveProbe([{ table_name: "scope_mirror_progress" }]);
    await Promise.all([one, two]);
    await reader.bulkMirrorRunVisibleSql(sql`c.run_id`);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("propagates probe failures instead of treating them as an absent table", async () => {
    const failure = new Error("probe failed");
    const db = { execute: vi.fn(async () => { throw failure; }) };
    h.getDb.mockReturnValue(db);
    const reader = await import("./scope-mirror-progress-read");

    await expect(reader.bulkMirrorRunVisibleSql(sql`a.run_id`)).rejects.toBe(failure);
  });
});
