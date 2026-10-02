/**
 * full-cycle 게이트 — **창 끝 이후에 처음 생긴 셀** · **한국어 비-KR 태그 우선** · ID 해제
 * (2026-09-28). 미러 실시간 경로(`rootFullCycleAnswerIds`)와 사실표 생성기
 * (`scripts/summary/global-predicates.ts::fullCycleCte`·`inTaggedRegionExpr`)를
 * PGlite(인메모리 Postgres)에서 **실제로 실행**해 값을 고정한다.
 *
 * ── 무엇이 문제였나 ──────────────────────────────────────────────────────
 * ① 2026-09-28 scope 가 743개 프롬프트에 시장을 추가했다(현대 EN 에 GB·AU·IN… 등).
 *    expected_cells 가 이력 무제한이라 그 **미래의** 새 셀이 과거 창의 기대치에 들어가
 *    과거 회차를 볼 때 그 프롬프트가 통째로 탈락했다. #188 의 active 한정은 그 시장이
 *    다른 프롬프트로 창 안에서 돌았으면(GB 등) 못 막는다 — 아래 P_EN2 가 그 역할이다.
 * ② 한국어 비-KR 제외가 태그와 무관하게 영구 제외여서, 기아 KO 에 US 를 태깅해도 화면에
 *    영영 안 나온다. 태그 우선으로 바꾸되 태깅(8/19) 이전 US 이력은 계속 뺀다 — 안 빼면
 *    과거 창에서 US 셀이 기대치로 되살아나 기아 KO 가 탈락한다.
 *
 * ── 픽스처 ──────────────────────────────────────────────────────────────
 *   R0  2026-08-05  태깅 이전 (한국어 프롬프트도 US 에서 측정되던 시절)
 *   R1  2026-09-20  회차 C1
 *   R2  2026-09-27  회차 C2 — 새로 태깅된 시장이 처음 측정된다
 *
 *   P_EN    EN · {US,GB}   C1 = US만(chatgpt·gemini) / C2 = US+GB      ← ① 대상
 *   P_EN2   EN · {GB,US}   C1·C2 = GB+US                                ← GB·US 를 두 창에서 active 로
 *   P_KO_US KO · {KR,US}   R0 = KR+US(태깅 이전) / C1 = KR / C2 = KR+US ← ② 대상
 *   P_KO_NT KO · 태그 없음 C2 = KR+US                                   ← US 는 여전히 제외
 *   P_ID    ID · {ID}      C1·C2 = ID                                   ← ID 해제
 *   P_EQ    EN · {US,GB}   C1 = US / R1B(창 밖 run) = GB, 측정 시각이 C1 창 끝과 **정확히 같다**
 *                          ← 경계: first_at = 창 끝 이면 기대치에 포함(`<=`). `<` 면 새어 나간다.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: async () => [] }),
}));

const dialect = new PgDialect();
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

const R0 = "a0000000-0000-4000-8000-000000000805";
const R1 = "a0000000-0000-4000-8000-000000000920";
const R2 = "a0000000-0000-4000-8000-000000000927";
// C1 창(run 집합 [R1]) 밖의 run — 같은 시각에 다른 셀을 측정한다(경계 픽스처 전용).
const R1B = "a0000000-0000-4000-8000-00000000092b";

const P_EN = "c0000000-0000-4000-8000-0000000000e1";
const P_EN2 = "c0000000-0000-4000-8000-0000000000e2";
const P_KO_US = "c0000000-0000-4000-8000-0000000000c1";
const P_KO_NT = "c0000000-0000-4000-8000-0000000000c2";
const P_ID = "c0000000-0000-4000-8000-0000000000d1";
const P_EQ = "c0000000-0000-4000-8000-0000000000f1";

const PROMPTS: Array<[id: string, text: string, regions: string[] | null]> = [
  [P_EN, "best family SUV", ["US", "GB"]],
  [P_EN2, "best EV in the UK", ["GB", "US"]],
  [P_KO_US, "패밀리 SUV 추천", ["KR", "US"]],
  [P_KO_NT, "전기차 추천", null],
  [P_ID, "mobil keluarga terbaik", ["ID"]],
  [P_EQ, "best hybrid sedan", ["US", "GB"]],
];

const RUNS: Array<[run: string, startedAt: string]> = [
  [R0, "2026-08-05T00:00:00Z"],
  [R1, "2026-09-20T16:00:00Z"],
  [R2, "2026-09-27T16:00:00Z"],
  [R1B, "2026-09-20T16:30:00Z"],
];

const at = { R0: "2026-08-05T03:00:00Z", R1: "2026-09-20T20:00:00Z", R2: "2026-09-27T20:00:00Z" };
const ENGINES = ["chatgpt", "gemini"] as const;

// [run, prompt, region, measured_at] × 엔진 2개로 펼친다.
const CELLS: Array<[run: string, prompt: string, region: string, measuredAt: string]> = [
  [R1, P_EN, "US", at.R1],
  [R2, P_EN, "US", at.R2],
  [R2, P_EN, "GB", at.R2],
  [R1, P_EN2, "GB", at.R1],
  [R2, P_EN2, "GB", at.R2],
  [R1, P_EN2, "US", at.R1],
  [R2, P_EN2, "US", at.R2],
  [R0, P_KO_US, "KR", at.R0],
  [R0, P_KO_US, "US", at.R0],
  [R1, P_KO_US, "KR", at.R1],
  [R2, P_KO_US, "KR", at.R2],
  [R2, P_KO_US, "US", at.R2],
  [R2, P_KO_NT, "KR", at.R2],
  [R2, P_KO_NT, "US", at.R2],
  [R1, P_ID, "ID", at.R1],
  [R2, P_ID, "ID", at.R2],
  // 경계: GB 셀의 최초 측정 = at.R1 = C1 창 안 마지막 측정. 창 밖 run 이지만 "창 이후"가 아니다.
  [R1, P_EQ, "US", at.R1],
  [R1B, P_EQ, "GB", at.R1],
];

let pg: PGlite;
let seq = 0;

async function rows<T>(q: SQL): Promise<T[]> {
  const built = dialect.sqlToQuery(q);
  return (await pg.query<T>(built.sql, built.params as unknown[])).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    SET TimeZone = 'UTC';
    CREATE TABLE scope_prompts (
      prompt_id uuid PRIMARY KEY, text text, regions text[],
      is_korean boolean GENERATED ALWAYS AS (text ~ '[가-힣]') STORED
    );
    CREATE TABLE scope_runs (
      run_id uuid PRIMARY KEY, project_id uuid, status text, started_at timestamptz,
      cycle_anchor_at timestamptz
    );
    CREATE TABLE scope_answers (
      job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, target text, region text,
      status text, measured_at timestamptz
    );
  `);
  for (const [id, text, regions] of PROMPTS) {
    await pg.query(`INSERT INTO scope_prompts (prompt_id, text, regions) VALUES ($1, $2, $3)`, [
      id, text, regions,
    ]);
  }
  for (const [run, startedAt] of RUNS) {
    await pg.query(`INSERT INTO scope_runs VALUES ($1, $2, 'completed', $3, $3)`, [run, ROOT, startedAt]);
  }
  for (const [run, prompt, region, measuredAt] of CELLS) {
    for (const engine of ENGINES) {
      seq += 1;
      const job = `b0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      await pg.query(
        `INSERT INTO scope_answers VALUES ($1, $2, $3, $4, $5, 'completed', $6)`,
        [job, run, prompt, engine, region, measuredAt],
      );
    }
  }
  // 운영 DB 와 같은 "컬럼 있음" 경로로 고정한다(is_korean·regions). 회차 원장은 없음 →
  // 노출 게이트는 `true` 로 접힌다(이 파일은 게이트 산식만 본다).
  const ca = await import("@/lib/db/column-availability");
  ca.resolveColumnAvailabilityForTests(false);
  ca.setColumnAvailabilityForTests("scope_prompts", "is_korean", true);
  ca.setColumnAvailabilityForTests("scope_prompts", "regions", true);
});

afterAll(async () => {
  await pg.close();
});

type Cell = { prompt_id: string; target: string; region: string };
const key = (c: Cell) => `${c.prompt_id}|${c.target}|${c.region}`;

/** 미러 실시간 경로 — 창 = 그 run 집합. 선택된 (prompt, engine, region) 셀. */
async function liveCells(runIds: string[]): Promise<Set<string>> {
  const sa = await import("./scope-aggregates");
  const window = sql`r.run_id IN (${sql.join(runIds.map((r) => sql`${r}::uuid`), sql`, `)})`;
  const ids = sa.__rootFullCycleAnswerIdsForTests(sql`r.project_id = ${ROOT}::uuid`, window);
  const out = await rows<Cell>(sql`
    SELECT a.prompt_id::text AS prompt_id, a.target, a.region
    FROM scope_answers a WHERE a.job_id IN ${ids}
  `);
  return new Set(out.map(key));
}

/** 생성기 경로 — mem = 그 run 집합. 프롬프트별 in_full_cycle. */
async function generatorGate(runIds: string[]): Promise<Record<string, boolean>> {
  const G = await import("@/scripts/summary/global-predicates");
  const mem = sql`mem AS (SELECT run_id FROM scope_runs WHERE run_id IN (${sql.join(
    runIds.map((r) => sql`${r}::uuid`),
    sql`, `,
  )}))`;
  const out = await rows<{ prompt_id: string; pass: boolean }>(sql`
    WITH ${mem}, ${G.fullCycleCte(ROOT)}
    SELECT prompt_id::text AS prompt_id, (window_cells > 0 AND window_cells >= expected_cells) AS pass
    FROM fc
  `);
  return Object.fromEntries(out.map((r) => [r.prompt_id, r.pass]));
}

/** 생성기 in_tagged_region — 답변 행 하나하나의 판정. */
async function taggedByCell(): Promise<Record<string, number>> {
  const G = await import("@/scripts/summary/global-predicates");
  const out = await rows<Cell & { run_id: string; t: number }>(sql`
    SELECT a.prompt_id::text AS prompt_id, a.target, a.region, a.run_id::text AS run_id,
           ${G.inTaggedRegionExpr(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`)} AS t
    FROM scope_answers a
  `);
  return Object.fromEntries(out.map((r) => [`${r.run_id}|${key(r)}`, r.t]));
}

const cell = (prompt: string, region: string, target = "chatgpt") =>
  key({ prompt_id: prompt, target, region });

describe("(a) 창 끝 이후에 처음 생긴 셀은 과거 창의 기대치가 아니다", () => {
  it("미러: C1 창에서 P_EN(US만 측정, GB 는 C2 에 처음 생김)이 탈락하지 않는다", async () => {
    const c1 = await liveCells([R1]);
    expect(c1.has(cell(P_EN, "US"))).toBe(true);
    expect(c1.has(cell(P_EN, "US", "gemini"))).toBe(true);
    // GB 는 C1 창에서 다른 프롬프트(P_EN2)로 active — #188 만으로는 못 막는 조건이다.
    expect(c1.has(cell(P_EN2, "GB"))).toBe(true);
  });

  it("미러: C2 창(새 셀이 측정된 회차)에서는 새 셀까지 전부 기대한다", async () => {
    const c2 = await liveCells([R2]);
    expect(c2.has(cell(P_EN, "US"))).toBe(true);
    expect(c2.has(cell(P_EN, "GB"))).toBe(true);
  });

  it("미러: 창 안에서 셀이 모자라면 여전히 탈락한다(게이트는 그대로 작동)", async () => {
    // C2 창에서 P_EN 의 US·gemini 를 실패로 두면(그 셀은 C1 에 이미 있다) 기대 셀 4 > 창 셀 3 → 탈락.
    await pg.query(
      `UPDATE scope_answers SET status = 'failed'
       WHERE run_id = $1 AND prompt_id = $2 AND region = 'US' AND target = 'gemini'`,
      [R2, P_EN],
    );
    try {
      const c2 = await liveCells([R2]);
      expect(c2.has(cell(P_EN, "US"))).toBe(false);
      expect(c2.has(cell(P_EN, "GB"))).toBe(false);
      const g2 = await generatorGate([R2]);
      expect(g2[P_EN]).toBe(false);
    } finally {
      await pg.query(
        `UPDATE scope_answers SET status = 'completed' WHERE run_id = $1 AND prompt_id = $2`,
        [R2, P_EN],
      );
    }
  });

  it("생성기: 같은 규칙 — C1 회차에서 P_EN 이 in_full_cycle", async () => {
    const g1 = await generatorGate([R1]);
    expect(g1[P_EN]).toBe(true);
    expect(g1[P_EN2]).toBe(true);
    const g2 = await generatorGate([R2]);
    expect(g2[P_EN]).toBe(true);
  });
});

describe("(a') 경계 — 최초 측정이 창 끝과 같은 시각이면 기대치에 포함한다", () => {
  it("미러: C1 창([R1])에서 P_EQ 는 GB 셀(창 밖·같은 시각)이 없어 탈락한다", async () => {
    const c1 = await liveCells([R1]);
    expect(c1.has(cell(P_EQ, "US"))).toBe(false);
    // 대조: 같은 셀을 창에 넣으면 통과한다(셀 자체는 정상).
    const both = await liveCells([R1, R1B]);
    expect(both.has(cell(P_EQ, "US"))).toBe(true);
    expect(both.has(cell(P_EQ, "GB"))).toBe(true);
  });

  it("생성기: C1 회차([R1])에서 P_EQ 는 in_full_cycle 이 아니다 (expected 4 > window 2)", async () => {
    const G = await import("@/scripts/summary/global-predicates");
    const mem = sql`mem AS (SELECT run_id FROM scope_runs WHERE run_id = ${R1}::uuid)`;
    const [row] = await rows<{ expected_cells: number; window_cells: number }>(sql`
      WITH ${mem}, ${G.fullCycleCte(ROOT)}
      SELECT expected_cells, window_cells FROM fc WHERE prompt_id = ${P_EQ}::uuid
    `);
    expect(row).toEqual({ expected_cells: 4, window_cells: 2 });
    expect((await generatorGate([R1]))[P_EQ]).toBe(false);
  });
});

describe("(b) 한국어 프롬프트의 US 태그 셀 — 태깅 이후는 포함, 이전은 제외", () => {
  it("미러: C2 창에서 P_KO_US 의 US 셀(태깅 이후)이 보인다", async () => {
    const c2 = await liveCells([R2]);
    expect(c2.has(cell(P_KO_US, "KR"))).toBe(true);
    expect(c2.has(cell(P_KO_US, "US"))).toBe(true);
    expect(c2.has(cell(P_KO_US, "US", "gemini"))).toBe(true);
  });

  it("미러: 태깅 이전(R0) US 셀은 제외 — R0 창에 US 가 없다", async () => {
    const c0 = await liveCells([R0]);
    expect(c0.has(cell(P_KO_US, "KR"))).toBe(true);
    expect(c0.has(cell(P_KO_US, "US"))).toBe(false);
  });

  it("미러: C1 창에서 P_KO_US 가 탈락하지 않는다(태깅 이전 US 이력이 기대치로 되살아나지 않음)", async () => {
    const c1 = await liveCells([R1]);
    expect(c1.has(cell(P_KO_US, "KR"))).toBe(true);
  });

  it("생성기: in_tagged_region — R0 US = 0, R2 US = 1, KR = 1", async () => {
    const t = await taggedByCell();
    expect(t[`${R0}|${cell(P_KO_US, "US")}`]).toBe(0);
    expect(t[`${R2}|${cell(P_KO_US, "US")}`]).toBe(1);
    expect(t[`${R0}|${cell(P_KO_US, "KR")}`]).toBe(1);
    expect(t[`${R2}|${cell(P_KO_US, "KR")}`]).toBe(1);
  });

  it("생성기: C1·C2 회차 모두 P_KO_US 가 in_full_cycle", async () => {
    expect((await generatorGate([R1]))[P_KO_US]).toBe(true);
    expect((await generatorGate([R2]))[P_KO_US]).toBe(true);
  });
});

describe("(c) 태그 없는 한국어 프롬프트는 KR 한정 유지", () => {
  it("미러: C2 창에서 P_KO_NT 는 KR 만, US 는 제외", async () => {
    const c2 = await liveCells([R2]);
    expect(c2.has(cell(P_KO_NT, "KR"))).toBe(true);
    expect(c2.has(cell(P_KO_NT, "US"))).toBe(false);
  });

  it("생성기: in_tagged_region — P_KO_NT 의 US = 0, KR = 1", async () => {
    const t = await taggedByCell();
    expect(t[`${R2}|${cell(P_KO_NT, "US")}`]).toBe(0);
    expect(t[`${R2}|${cell(P_KO_NT, "KR")}`]).toBe(1);
  });
});

describe("(d) ID 는 제외되지 않는다 (2026-09-28 숨김 해제)", () => {
  it("미러: C1·C2 창 모두 P_ID 의 ID 셀이 보인다", async () => {
    expect((await liveCells([R1])).has(cell(P_ID, "ID"))).toBe(true);
    expect((await liveCells([R2])).has(cell(P_ID, "ID"))).toBe(true);
  });

  it("생성기: P_ID 가 in_full_cycle 이고 in_tagged_region = 1", async () => {
    expect((await generatorGate([R1]))[P_ID]).toBe(true);
    const t = await taggedByCell();
    expect(t[`${R1}|${cell(P_ID, "ID")}`]).toBe(1);
  });
});
