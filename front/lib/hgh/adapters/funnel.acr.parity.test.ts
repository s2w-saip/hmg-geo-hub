import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { components } from "../api-types";

// Legacy <-> API parity of the ACR screen (unit U8, verify D5).
//
// Method. One small ACR WORLD (two prompts, two engines, two countries, two measured rounds and
// one gated round without ACR cells; brand-level and product-level rollups with choice,
// appearance and valid ACR iterations) is read twice:
//   legacy: rows in scope_acr_rollups on PGlite (real PostgreSQL), read by the UNCHANGED
//           aggregateAcrFromMirror({}) the standard ACR page calls (through fetchStandardAcr);
//   api:    a model of GET /v1/funnel/acr over the same WORLD written from the backend SQL
//           (back/app/features/analytics/funnel/acr/queries.py + service.py: snapshot = the
//           latest gated round, totals/brands/battle/models/territory over its cells, trend =
//           gated round buckets with gap rounds), converted by lib/hgh/adapters/funnel.ts.
// brands, battle, modelConversion and totals must be equal. trend differs by DC-09 (legacy day
// buckets of measured_at, api round buckets), U8-N1 (a gap round is dropped) and U8-N22 (a
// series brand without a row in a bucket is 0 on api, absent on legacy); territory is
// equal as a set (per ACR cell in the snapshot) and differs only in the order of tied sheets.
// Both engines are default engines here, so DC-01 (no engine chosen = default engines) does not
// move the numbers.

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
vi.mock("@/lib/period/anchor-axis-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/period/anchor-axis-state")>()),
  ensureAnchorAxis: async () => false,
  anchorAxisKnownEnabled: () => false,
}));

const { aggregateAcrFromMirror, aggregateAcrOwnFromMirror } = await import("@/lib/db/repositories/scope-aggregates");
const { HMG_BRAND_ENTITY_IDS } = await import("@/lib/scope/hmg-brands");
const { createTableFrom, MIG_DIR } = await import("@/scripts/db/answer-cycle-anchors-pglite-fixture");
const F = await import("./funnel");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

// ── WORLD ───────────────────────────────────────────────────────────────────

interface Brand { name: string; id: string; ours: boolean }
const KIA: Brand = { name: "Kia", id: HMG_BRAND_ENTITY_IDS.Kia, ours: true };
const HYUNDAI: Brand = { name: "Hyundai", id: HMG_BRAND_ENTITY_IDS.Hyundai, ours: true };
const TOYOTA: Brand = { name: "Toyota", id: u(0xa1), ours: false };
const HONDA: Brand = { name: "Honda", id: u(0xa2), ours: false };
interface Model { name: string; id: string; parent: Brand }
const EV9: Model = { name: "EV9", id: u(0xb1), parent: KIA };
const RAV4: Model = { name: "RAV4", id: u(0xb2), parent: TOYOTA };

interface Prompt { id: string; text: string }
const P1: Prompt = { id: u(0x11), text: "best family suv" };
const P2: Prompt = { id: u(0x12), text: "cheapest ev" };

interface Cell {
  run: string;
  round: string; // round_date (YYYY-MM-DD)
  measuredAt: string;
  prompt: Prompt;
  engine: "chatgpt" | "gemini";
  country: "KR" | "US";
  vacr: number;
  brands: { b: Brand; choice: number; appearance: number }[];
  models: { m: Model; choice: number; appearance: number }[];
}
const R1 = u(0x301);
const R2 = u(0x302);
// Round 2026-09-10 drains over two days: the US cell is measured on 09-11 (DC-09 case).
const CELLS: Cell[] = [
  // round 1 (2026-09-03): older, only the trend reads it
  { run: R1, round: "2026-09-03", measuredAt: "2026-09-03T02:00:00Z", prompt: P1, engine: "chatgpt", country: "KR", vacr: 10,
    brands: [{ b: KIA, choice: 2, appearance: 6 }, { b: TOYOTA, choice: 6, appearance: 9 }], models: [] },
  { run: R1, round: "2026-09-03", measuredAt: "2026-09-03T03:00:00Z", prompt: P2, engine: "chatgpt", country: "KR", vacr: 8,
    brands: [{ b: KIA, choice: 1, appearance: 4 }, { b: HONDA, choice: 5, appearance: 8 }], models: [] },
  // round 2 (2026-09-10): the snapshot
  { run: R2, round: "2026-09-10", measuredAt: "2026-09-10T02:00:00Z", prompt: P1, engine: "chatgpt", country: "KR", vacr: 10,
    brands: [{ b: KIA, choice: 7, appearance: 10 }, { b: TOYOTA, choice: 2, appearance: 7 }, { b: HONDA, choice: 0, appearance: 3 }],
    models: [{ m: EV9, choice: 5, appearance: 8 }, { m: RAV4, choice: 1, appearance: 5 }] },
  { run: R2, round: "2026-09-10", measuredAt: "2026-09-10T02:10:00Z", prompt: P1, engine: "gemini", country: "KR", vacr: 9,
    brands: [{ b: TOYOTA, choice: 4, appearance: 9 }, { b: HYUNDAI, choice: 3, appearance: 5 }], models: [{ m: RAV4, choice: 3, appearance: 7 }] },
  { run: R2, round: "2026-09-10", measuredAt: "2026-09-10T02:20:00Z", prompt: P2, engine: "chatgpt", country: "KR", vacr: 6,
    brands: [{ b: HONDA, choice: 4, appearance: 6 }, { b: KIA, choice: 1, appearance: 2 }], models: [{ m: EV9, choice: 1, appearance: 2 }] },
  // no brand chosen in this cell: the battle cell has no winner
  { run: R2, round: "2026-09-10", measuredAt: "2026-09-10T02:30:00Z", prompt: P2, engine: "gemini", country: "KR", vacr: 4,
    brands: [{ b: TOYOTA, choice: 0, appearance: 4 }], models: [] },
  { run: R2, round: "2026-09-10", measuredAt: "2026-09-11T03:00:00Z", prompt: P1, engine: "chatgpt", country: "US", vacr: 5,
    brands: [{ b: KIA, choice: 3, appearance: 5 }, { b: HYUNDAI, choice: 1, appearance: 2 }], models: [] },
];
const cellId = (c: Cell) => u(0x400 + CELLS.indexOf(c));
// Gated rounds the backend knows (latest first in the trend window). 2026-08-27 has no ACR cell.
const GATED_ROUNDS = ["2026-08-27", "2026-09-03", "2026-09-10"];
const SNAPSHOT_ROUND = "2026-09-10";

// ── PGlite (legacy) ─────────────────────────────────────────────────────────

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
function inserts(): string {
  const rows: string[] = [];
  for (const p of [P1, P2]) rows.push(`INSERT INTO scope_prompts (prompt_id, text) VALUES (${lit(p.id)}, ${lit(p.text)});`);
  for (const c of CELLS) {
    const base = (entity: string, level: string, name: string, parent: string | null, rollup: string, choice: number, appearance: number) =>
      `INSERT INTO scope_acr_rollups (prompt_run_id, entity_id, run_id, prompt_id, target, region, measured_at, rollup_level, brand, parent_brand, brand_rollup_entity_id, entity_type, valid_acr_iterations, choice_count, appearance_count) VALUES (${lit(cellId(c))}, ${lit(entity)}, ${lit(c.run)}, ${lit(c.prompt.id)}, ${lit(c.engine)}, ${lit(c.country)}, ${lit(c.measuredAt)}::timestamptz, ${lit(level)}, ${lit(name)}, ${lit(parent)}, ${lit(rollup)}, ${lit(level === "brand" ? "Brand" : "Product")}, ${c.vacr}, ${choice}, ${appearance});`;
    for (const x of c.brands) rows.push(base(x.b.id, "brand", x.b.name, null, x.b.id, x.choice, x.appearance));
    for (const x of c.models) rows.push(base(x.m.id, "product", x.m.name, x.m.parent.name, x.m.parent.id, x.choice, x.appearance));
  }
  return rows.join("\n");
}

let pg: Pg;
beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(
    [
      createTableFrom(MIRROR, "scope_runs"),
      createTableFrom(MIRROR, "scope_prompts"),
      createTableFrom(MIRROR, "scope_mentions"),
      createTableFrom(path.join(MIG_DIR, "0025_prompt_kind_acr_rollups.sql"), "scope_acr_rollups"),
      createTableFrom(path.join(MIG_DIR, "0059_summary_tables.sql"), "summary_cycles"),
      createTableFrom(path.join(MIG_DIR, "0059_summary_tables.sql"), "summary_cycle_runs"),
      `CREATE TABLE IF NOT EXISTS prompts (id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text,
         list_type text, depth1 text, depth2 text, depth3 text, funnel_stage text, lang text, kind text);`,
    ].join("\n"),
  );
  await pg.exec(inserts());
  const real = drizzle(pg as never);
  st.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") return async (q: unknown) => (await target.execute(q as never)).rows;
      return Reflect.get(target, prop, receiver);
    },
  });
}, 60_000);
afterAll(async () => {
  await pg?.close();
});

// ── backend model (queries.py / service.py) ─────────────────────────────────

const ratio = (num: number, den: number): S["Ratio"] => ({ num, den });

function backendAcr(): S["AcrData"] {
  const cells = CELLS.filter((c) => c.round === SNAPSHOT_ROUND);
  const iterations = cells.reduce((s, c) => s + c.vacr, 0);
  // brands_sql: level 1, keep, group by brand; order choice desc, cells desc, name
  const agg = new Map<string, { b: Brand; choice: number; appearance: number; cells: Set<string> }>();
  for (const c of cells) {
    for (const x of c.brands) {
      const a = agg.get(x.b.name) ?? { b: x.b, choice: 0, appearance: 0, cells: new Set<string>() };
      a.choice += x.choice;
      a.appearance += x.appearance;
      a.cells.add(cellId(c));
      agg.set(x.b.name, a);
    }
  }
  const brandRows = [...agg.values()].sort((a, b) => b.choice - a.choice || b.cells.size - a.cells.size || a.b.name.localeCompare(b.b.name));
  const brands: S["AcrBrand"][] = brandRows.map((a) => ({
    brand: a.b.name,
    is_ours: a.b.ours,
    choice: a.choice,
    appearance: a.appearance,
    cells: a.cells.size,
    choice_share: ratio(a.choice, iterations),
    coverage: ratio(a.cells.size, cells.length),
  }));
  // trend: series = ours first, then the rest, 5; buckets = gated rounds, gap when no ACR cell
  const series = [...brandRows.filter((a) => a.b.ours), ...brandRows.filter((a) => !a.b.ours)].slice(0, 5).map((a) => a.b.name);
  const buckets: S["AcrTrendBucket"][] = GATED_ROUNDS.map((round) => {
    const rc = CELLS.filter((c) => c.round === round);
    const den = rc.reduce((s, c) => s + c.vacr, 0);
    return {
      round_date: round,
      gap: den === 0,
      den,
      series: series.map((brand) => ({ brand, num: rc.flatMap((c) => c.brands).filter((x) => x.b.name === brand).reduce((s, x) => s + x.choice, 0) })),
    };
  });
  // battle_sql: (prompt, engine) over countries; winner = most choice, tie by name
  const pe = new Map<string, { p: Prompt; engine: string; by: Map<string, { b: Brand; choice: number }> }>();
  for (const c of cells) {
    const k = `${c.prompt.id}|${c.engine}`;
    const e = pe.get(k) ?? { p: c.prompt, engine: c.engine, by: new Map() };
    for (const x of c.brands) {
      const w = e.by.get(x.b.name) ?? { b: x.b, choice: 0 };
      w.choice += x.choice;
      e.by.set(x.b.name, w);
    }
    pe.set(k, e);
  }
  const byPrompt = new Map<string, S["AcrBattleRow"]>();
  for (const e of pe.values()) {
    const win = [...e.by.values()].filter((w) => w.choice > 0).sort((a, b) => b.choice - a.choice || a.b.name.localeCompare(b.b.name))[0];
    const row = byPrompt.get(e.p.id) ?? { prompt_id: e.p.id, prompt_text: e.p.text, cells: [] };
    row.cells.push({ engine: e.engine, winner_brand: win?.b.name ?? null, winner_is_ours: win?.b.ours ?? false, choice: win?.choice ?? 0 });
    byPrompt.set(e.p.id, row);
  }
  const sum = (r: S["AcrBattleRow"]) => r.cells.reduce((s, c) => s + c.choice, 0);
  const battle = [...byPrompt.values()]
    .map((r) => ({ ...r, cells: [...r.cells].sort((a, b) => a.engine.localeCompare(b.engine)) }))
    .sort((a, b) => sum(b) - sum(a) || (a.prompt_text ?? "").localeCompare(b.prompt_text ?? "") || a.prompt_id.localeCompare(b.prompt_id));
  // models_sql: level 2 grouped by (model, parent brand)
  const mAgg = new Map<string, { m: Model; choice: number; vacr: number; cells: Set<string> }>();
  for (const c of cells) {
    for (const x of c.models) {
      const a = mAgg.get(x.m.name) ?? { m: x.m, choice: 0, vacr: 0, cells: new Set<string>() };
      a.choice += x.choice;
      a.vacr += c.vacr;
      a.cells.add(cellId(c));
      mAgg.set(x.m.name, a);
    }
  }
  const model_conversion: S["AcrModelRow"][] = [...mAgg.values()]
    .filter((a) => a.choice > 0)
    .sort((a, b) => b.choice / b.vacr - a.choice / a.vacr || b.choice - a.choice || a.m.name.localeCompare(b.m.name))
    .map((a) => ({ brand: a.m.parent.name, model: a.m.name, is_ours: a.m.parent.ours, conversion: ratio(a.choice, a.vacr), cells: a.cells.size, top1: a.choice }));
  // territory_sql: sheets (country, engine) by cell count; rows = cells; entries choice > 0
  const sheets = new Map<string, S["AcrTerritorySheet"]>();
  for (const c of [...cells].sort((a, b) => a.prompt.text.localeCompare(b.prompt.text))) {
    const k = `${c.country}|${c.engine}`;
    const sh = sheets.get(k) ?? { country: c.country, engine: c.engine, rows: [] };
    sh.rows.push({
      prompt_id: c.prompt.id,
      prompt_text: c.prompt.text,
      valid_acr: c.vacr,
      entries: c.brands
        .filter((x) => x.choice > 0)
        .sort((a, b) => b.choice - a.choice || a.b.name.localeCompare(b.b.name))
        .map((x) => ({ brand: x.b.name, choice: x.choice, is_ours: x.b.ours })),
    });
    sheets.set(k, sh);
  }
  const territory = [...sheets.values()].sort((a, b) => b.rows.length - a.rows.length || (a.country ?? "").localeCompare(b.country ?? "") || a.engine.localeCompare(b.engine));
  return {
    totals: {
      prompt_runs: cells.length,
      prompts: new Set(cells.map((c) => c.prompt.id)).size,
      iterations,
      engines: [...new Set(cells.map((c) => c.engine))].sort(),
      catalog_acr_prompts: 2,
    },
    brands,
    trend: { series_brands: series, buckets },
    battle,
    model_conversion,
    territory,
    options: { langs: [], countries: ["KR", "US"] },
  };
}

// ── cases ───────────────────────────────────────────────────────────────────

type Territory = Awaited<ReturnType<typeof aggregateAcrFromMirror>>["territory"];
const canonTerritory = (t: Territory) =>
  t
    .map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, entries: [...r.entries].sort((a, b) => b.choice - a.choice || a.brand.localeCompare(b.brand)) })) }))
    .sort((a, b) => `${a.region}|${a.engine}`.localeCompare(`${b.region}|${b.engine}`));

describe("ACR legacy (aggregateAcrFromMirror on PGlite) vs api (backend model -> toStandardAcr)", () => {
  it("the WORLD is not vacuous: legacy measures the snapshot round with ours and competitors", async () => {
    const legacy = await aggregateAcrFromMirror({});
    expect(legacy.measured).toBe(true);
    // hand check: snapshot = round 2 (5 cells, 34 iterations); Kia 7+1+3 = 11 choices in 3 cells
    expect(legacy.totals).toEqual({ promptRuns: 5, prompts: 2, iterations: 34, engines: expect.arrayContaining(["chatgpt", "gemini"]) });
    expect(legacy.brands[0]).toMatchObject({ brand: "Kia", isOurs: true, choiceCount: 11, choiceShare: 32.4, coverage: 60 });
    // a (prompt, engine) cell where nobody was chosen: no winner
    expect(legacy.battle.find((r) => r.promptId === P2.id)?.cells.find((c) => c.engine === "gemini")).toEqual({ engine: "gemini", winner: null, winnerIsOurs: false, choiceCount: 0 });
    expect(legacy.brands.find((b) => b.brand === "Toyota")).toMatchObject({ isOurs: false, choiceCount: 6 });
  });

  it("totals, brands, battle and modelConversion are equal", async () => {
    const legacy = await aggregateAcrFromMirror({});
    const api = F.toStandardAcr(backendAcr(), {});
    expect(api.measured).toBe(legacy.measured);
    expect({ ...api.totals, engines: [...api.totals.engines].sort() }).toEqual({ ...legacy.totals, engines: [...legacy.totals.engines].sort() });
    expect(api.brands).toEqual(legacy.brands);
    expect(api.battle).toEqual(legacy.battle);
    expect(api.modelConversion).toEqual(legacy.modelConversion);
  });

  it("territory: the same sheets, rows and entries per ACR cell; only the order of tied sheets may differ", async () => {
    const legacy = await aggregateAcrFromMirror({});
    const api = F.toStandardAcr(backendAcr(), {});
    expect(canonTerritory(api.territory)).toEqual(canonTerritory(legacy.territory));
    expect(api.territory.map((s) => s.rows.length)).toEqual(legacy.territory.map((s) => s.rows.length));
  });

  it("trend DC-09: legacy = measured days (the 09-10 round drains into 09-11), api = rounds; U8-N1 gap round dropped; U8-N22", async () => {
    const legacy = await aggregateAcrFromMirror({});
    const data = backendAcr();
    expect(data.trend.buckets.find((b) => b.round_date === "2026-08-27")).toMatchObject({ gap: true, den: 0 });
    const api = F.toStandardAcr(data, {});
    expect(legacy.trend.map((b) => b.date)).toEqual(["2026-09-03", "2026-09-10", "2026-09-11"]);
    expect(api.trend.map((b) => b.date)).toEqual(["2026-09-03", "2026-09-10"]);
    // the round that did not drain across days is identical, except U8-N22: a series brand with
    // no rollup row in the bucket (Hyundai on 09-03) is 0 on api; legacy left the key out
    expect(legacy.trend[0].series).not.toHaveProperty("Hyundai");
    expect(api.trend[0].series.Hyundai).toBe(0);
    const { Hyundai: _absent, ...apiRest } = api.trend[0].series;
    expect({ ...api.trend[0], series: apiRest }).toEqual(legacy.trend[0]);
    // 09-10: legacy day = 4 KR cells (29 iterations), api round = + the US cell (34 iterations)
    expect(legacy.trend[1].series.Kia).toBe(27.6); // (7 + 1) / 29
    expect(api.trend[1].series.Kia).toBe(32.4); // (7 + 1 + 3) / 34
    expect(legacy.trend[2].series.Kia).toBe(60); // 3 / 5 on 09-11
    // same series brands (ours first, then the top brands)
    expect(Object.keys(api.trend[1].series).sort()).toEqual(Object.keys(legacy.trend[1].series).sort());
  });

  it("renewal 당사 합계: aggregateAcrOwnFromMirror = the backend own_sql (every own brand, a cell once)", async () => {
    const own = await aggregateAcrOwnFromMirror({});
    // own_sql over the snapshot cells: own brand rows summed, cells DISTINCT
    const rows = CELLS.filter((c) => c.round === SNAPSHOT_ROUND).flatMap((c) => c.brands.filter((x) => x.b.ours).map((x) => ({ cell: c, ...x })));
    expect(own).toEqual({
      choiceCount: rows.reduce((s, r) => s + r.choice, 0),
      appearanceCount: rows.reduce((s, r) => s + r.appearance, 0),
      cells: new Set(rows.map((r) => r.cell)).size,
    });
    // hand check: Kia 7+1+3 + Hyundai 3+1 = 15 choices; the US cell holds both and counts once → 4 of 5 cells
    expect(own).toEqual({ choiceCount: 15, appearanceCount: 24, cells: 4 });
    // what the legacy cards show instead: the first own brand row (Kia, 11 choices in 3 cells)
    const legacy = await aggregateAcrFromMirror({});
    expect(legacy.brands.find((b) => b.isOurs)).toMatchObject({ brand: "Kia", choiceCount: 11, coverage: 60 });
  });
});
