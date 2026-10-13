import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
const { readCatalogPage, readCatalogRows } = await import("./catalog-page");
const { readProjectPromptPage, readProjectCandidatePage } = await import("./project-prompt-page");
const { STANDARD_ROOT_PROJECT_ID: root } = await import("./standards");
const { exportCatalogPages } = await import("@/lib/standards/catalog-page");

// An explicitly supplied, local disposable DB is required. Never uses DATABASE_URL.
const url = process.env.HGH_SCREEN_TEST_DB_URL;
describe.skipIf(!url)("native PostgreSQL screen reads (ICU and large catalogs)", () => {
  let client: ReturnType<typeof postgres>;
  const schema = `screen_${randomUUID().replaceAll("-", "")}`;
  const project = randomUUID(), field = randomUUID();
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/hmg_preserve_front") throw new Error("Disposable local screen test database required");
    client = postgres(url!, { max: 1 });
    await client.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
      CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, text text,
        prompt_type text, category text, brand text, brand_presence text, list_type text, depth1 text,
        depth2 text, depth3 text, depth4 text, funnel_stage text, kind text DEFAULT 'single', lang text,
        regions text[], scope_prompt_id uuid, deleted_at timestamptz, status text DEFAULT 'draft', created_at timestamptz DEFAULT now());
      CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text);
      CREATE TABLE project_custom_fields (id uuid PRIMARY KEY, project_id uuid);
      CREATE TABLE prompt_custom_field_values (prompt_id uuid, field_id uuid, value text);
      CREATE TABLE prompt_candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, source text, source_keyword text, text text, created_at timestamptz);
    `);
    state.db = drizzle(client);
    await client`INSERT INTO prompts(project_id,text,brand,regions,depth1,depth2,depth4)
      SELECT ${root}, 'catalog ' || lpad(n::text,5,'0'), CASE WHEN n%2=0 THEN 'Hyundai' ELSE 'Kia' END,
        ARRAY['KR'], 'A', CASE WHEN n%2=0 THEN 'a' ELSE 'b' END, CASE WHEN n=12005 THEN 'deep-only' END FROM generate_series(1,12005) n`;
    await client`INSERT INTO prompts(project_id,text,brand,category,created_at)
      SELECT ${project}, 'project ' || lpad(n::text,5,'0'), CASE WHEN n=25001 THEN 'Kia' END,
        CASE WHEN n=25001 THEN 'rare-category' END, now() + n * interval '1 second' FROM generate_series(1,25001) n`;
    await client`INSERT INTO project_custom_fields VALUES (${field},${project})`;
    await client`INSERT INTO prompt_custom_field_values SELECT id,${field},'rare-tag' FROM prompts WHERE text='project 25001'`;
    await client`INSERT INTO prompt_candidates(project_id,source,text,created_at)
      SELECT ${project},'manual','candidate ' || lpad(n::text,5,'0'), now() + n * interval '1 second' FROM generate_series(1,25001) n`;
  }, 30000);
  afterAll(async () => { if (client) { await client.unsafe(`DROP SCHEMA ${schema} CASCADE`); await client.end(); } });

  it("limits first and deep pages, applies account scope before counts/facets and exports every match", async () => {
    const all = { all: true };
    const first = await readCatalogPage(all, {});
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(12005);
    expect(first.columns).toContain("depth4");
    const scoped = await readCatalogPage({ all: false, brands: ["Hyundai"], countries: ["KR"] }, {});
    expect(scoped.total).toBe(6002);
    expect(scoped.facets.depth2).toEqual(["a"]);
    expect(scoped.columns).not.toContain("depth4");
    const denied = await readCatalogPage({ all: false, brands: ["Hyundai"], countries: ["US"] }, {});
    expect(denied.total).toBe(0);
    expect(denied.facets.depth2).toEqual([]);
    const deep = await readCatalogPage(all, { offset: 12000, sort: "text" });
    expect(deep.rows.map(r => r.text)).toEqual(Array.from({ length: 5 }, (_, i) => `catalog ${12001 + i}`));
    const exported = await exportCatalogPages(q => readCatalogPage(all, q), { sort: "text" });
    expect(exported).toHaveLength(12005);
    expect(new Set(exported.map(r => r.id)).size).toBe(12005);
  }, 30000);
  it("rows-only reads return the full read's rows and total without the scope metadata (standard and admin)", async () => {
    const cases = [
      [{ all: false, brands: ["Hyundai"], countries: ["KR"] }, { filters: { depth2: "a" }, search: "catalog 1", sort: "text" as const, offset: 100 }, false],
      [{ all: true }, { sort: "text" as const, asc: false, offset: 12000 }, true],
    ] as const;
    for (const [scope, q, admin] of cases) {
      const full = await readCatalogPage(scope, q, admin);
      expect(await readCatalogRows(scope, q, admin)).toEqual({ rows: full.rows, total: full.total, offset: full.offset, limit: full.limit });
      expect(full.total).toBeGreaterThan(0);
    }
  }, 30000);
  it("sorts Unicode like the existing browser comparator in both supported collations", async () => {
    const words = ["sort 사과", "sort 가방", "sort Apple", "sort Zebra", "sort ä", "sort 10", "sort 2"];
    for (const text of words) await client`INSERT INTO prompts(project_id,text) VALUES(${root},${text})`;
    for (const collation of ["ko", "en"] as const) {
      const result = await readCatalogPage({ all: true }, { search: "sort ", sort: "text", collation });
      expect(result.rows.map(r => r.text)).toEqual([...words].sort((a, b) => a.localeCompare(b, collation)));
    }
  });
  it("keeps whole-project columns/tags, deep candidates and every selected ID beyond 20000", async () => {
    const first = await readProjectPromptPage(project, {});
    expect(first.rows).toHaveLength(200);
    expect(first).toMatchObject({ total: 25001, show_brand: true, show_category: true, draft_count: 25001, values: { [field]: ["rare-tag"] } });
    expect(first.rows.every(r => r.brand === null)).toBe(true);
    const last = await readProjectPromptPage(project, { offset: 25000, ids_only: true, limit: 500 });
    expect(last.rows).toEqual([]);
    expect(last.ids).toHaveLength(1);
    const tagSort = await readProjectPromptPage(project, { sort: field, direction: "desc" });
    expect(tagSort.rows[0].text).toBe("project 25001");
    expect(tagSort.rows[0].customValues[field]).toBe("rare-tag");
    // include_values=false: same rows, totals and columns; only the project-wide suggestions are left out.
    const deep = { sort: field, direction: "desc" as const, offset: 400 };
    const withValues = await readProjectPromptPage(project, deep);
    expect(await readProjectPromptPage(project, { ...deep, include_values: false })).toEqual({ ...withValues, values: {} });
    const candidate = await readProjectCandidatePage(project, { sort: "oldest", offset: 25000, limit: 200 });
    expect(candidate.rows[0].text).toBe("candidate 25001");
    const selected: string[] = [];
    for (let offset = 0; offset < 25001; offset += 500) selected.push(...(await readProjectPromptPage(project, { offset, limit: 500, ids_only: true })).ids);
    expect(new Set(selected).size).toBe(25001);
  }, 30000);
});
