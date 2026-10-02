// 자사·타겟 URL 인용률(GGMD-61) 사실표 경로를 **진짜 Postgres(pglite)** 에서 끝까지 돌린다
// (2026-09-27, 0081).
//
//   생성: `insertUrlHitsSql` + `websitePromptUrlHitJobFlagsSql` (웹사이트 생성기가 보내는 문장)
//   조회: `summaryWebsitePromptHitRates` (대시보드 카드 2종의 사실표 리더)
//
// 텍스트 가드로는 못 보는 것만 여기서 본다:
//   ① 판정: 타겟은 **그 프롬프트의** 타겟과 정확 일치(쿼리 트래킹 파라미터 제거 후),
//      다른 프롬프트의 타겟은 자사일 뿐 타겟이 아니다, 형제 base 는 자사가 아니다,
//      미등록 프롬프트는 어느 분자에도 못 들어간다.
//   ② 프롬프트 접기: 엔진 필터로 고른 job 부분집합마다 bool_or 가 다시 된다.
//   ③ 커버리지: 원장에 없는 generation 이 하나라도 섞이면 null(→ 미러) 이다.
//   ④ 리더 SQL ≡ JS 오라클(미러 쌍둥이의 `pm` 의미론): 무작위 사실 600건 × 필터 조합.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
import { createTableFrom, MIG_DIR, migrationStatements } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import type { WebsiteCyclePick } from "@/lib/db/repositories/summary-cycles";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

let db: Db;
const dialect = new PgDialect();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 바인드를 리터럴로 되박는다(owned-unit-statements.pglite.test.ts 와 같은 방식). */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    if (v.length === 0) return "ARRAY[]::text[]";
    return `ARRAY[${v.map((x) => literal(x)).join(", ")}]`;
  }
  const s = String(v).replace(/'/g, "''");
  return UUID_RE.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
}
function inline(q: SQL): string {
  const c = dialect.sqlToQuery(q);
  let out = c.sql;
  for (let i = c.params.length; i >= 1; i -= 1) out = out.split(`$${i}`).join(literal(c.params[i - 1]));
  return out;
}
const run = async (q: SQL) => (await db.query(inline(q))).rows;

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: (q: SQL) => run(q) }),
}));

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
const mig = (f: string) => path.join(MIG_DIR, f);
function normFnDdl(): string[] {
  const src = fs.readFileSync(mig("0052_scope_citations_url_norm.sql"), "utf8");
  return ["citation_url_norm", "citation_url_base_norm"].map((n) => {
    const m = src.match(
      new RegExp(`CREATE OR REPLACE FUNCTION ${n}\\(text\\)[\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;`),
    );
    if (!m) throw new Error(`0052 에서 ${n} 정의를 못 찾았다`);
    return m[0];
  });
}

// ── 고정 픽스처 ──────────────────────────────────────────────────────────────
const P1 = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const CYC = "33333333-3333-4333-8333-333333333333";
const GEN = "44444444-4444-4444-8444-444444444444";
const GEN_UNCOVERED = "45454545-4545-4545-8545-454545454545";
const WEEK = "2026-09-21";
const PA = "a0000000-0000-4000-8000-00000000000a";
const PB = "b0000000-0000-4000-8000-00000000000b";
const PC = "c0000000-0000-4000-8000-00000000000c"; // 미등록
const PD = "d0000000-0000-4000-8000-00000000000d"; // 인용 없음
const PE = "f1000000-0000-4000-8000-00000000000e"; // **다른 프로젝트(P2) 사이트에만** 등록
const P2 = "12121212-1212-4212-8212-121212121212";
const S2 = "23232323-2323-4323-8323-232323232323";
/** 같은 회차의 **다른 generation**: 같은 job id 에 반대 플래그를 싣는다(조인 키 검증용). */
const GEN_OTHER = "47474747-4747-4747-8747-474747474747";
const job = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const UNITS: WebsiteOwnedUnit[] = [
  { siteId: S1, fileSeq: 10, base: "kia.com/mx", sibs: ["kia.com/mx/en"], homeHost: null },
];

// [job, prompt, engine, run_status, citations[]]
const JOBS: Array<[string, string, string, string, string[]]> = [
  [job(1), PA, "chatgpt", "completed", ["https://kia.com/mx/autos/ev6.html"]], // 자기 타겟 → 자사+타겟
  [job(2), PA, "gemini", "completed", ["https://www.kia.com/mx/autos/k3.html"]], // 남의 타겟 → 자사만
  [job(3), PB, "chatgpt", "completed", ["https://www.kia.com/mx/en/foo", "https://toyota.com/mx"]], // 형제 base·타사 → 없음
  [job(4), PB, "gemini", "completed", ["https://www.kia.com/mx/autos/k3.html?utm_source=x"]], // 트래킹 제거 후 자기 타겟
  [job(5), PC, "chatgpt", "completed", ["https://www.kia.com/mx/autos/ev6.html"]], // 미등록 → 분모·분자 밖
  [job(6), PD, "chatgpt", "completed", []], // 인용 없음 → 분모만
  [job(7), PD, "gemini", "failed", ["https://www.kia.com/mx/servicio"]], // run 상태 게이트 밖
  // base NORM(쿼리 제거)으로만 자사다: tracked NORM 으로 판정하면 빠진다(surface-website.ts 11 job 전례).
  [job(8), PB, "claude", "completed", ["https://www.kia.com/mx?ref=abc"]],
  // P2 사이트에만 등록된 프롬프트를 P1 회차가 측정했다: 판정 스코프(프로젝트) 밖 = 미등록.
  [job(9), PE, "chatgpt", "completed", ["https://www.kia.com/co/autos/sportage.html"]],
];

const cycles = (gens: string[]): WebsiteCyclePick[] =>
  gens.map((g) => ({
    cycleId: CYC,
    generationId: g,
    projectId: P1,
    cycleAnchorAt: "2026-09-25T00:00:00.000Z",
    cycleWeek: WEEK,
  })) as WebsiteCyclePick[];
const scopeOf = (gens: string[], filters: Record<string, unknown> = {}) =>
  ({
    cycles: cycles(gens),
    projectIds: [P1],
    filters,
    ownedBasePrefixes: [],
    unitFlags: true,
  }) as never;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
  const ddl = [
    createTableFrom(MIRROR, "scope_citations"),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_sites"),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_prompts"),
    `ALTER TABLE website_prompts ADD COLUMN IF NOT EXISTS owned_base_url text;`,
    // 리더가 읽는 summary_answers 의 부분집합(타입은 0059·0063 원본과 같다). 파티션은 생략.
    `CREATE TABLE summary_answers (
       cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
       job_id uuid NOT NULL, prompt_id uuid NOT NULL, engine text NOT NULL, country text NOT NULL,
       project_id uuid NOT NULL, lang text, funnel_catalog text, list_type text,
       depth1 text, depth2 text, depth3 text, run_status text NOT NULL,
       presence_set text[] NOT NULL DEFAULT '{}')`,
    `CREATE TABLE summary_cycle_jobs (
       cycle_week date NOT NULL, cycle_id uuid NOT NULL, generation_id uuid NOT NULL,
       job_id uuid NOT NULL, prompt_id uuid NOT NULL)`,
    ...normFnDdl(),
  ];
  for (const s of ddl) await db.exec(s);
  // 0081: db:apply 경로처럼 트랜잭션 안에서(가드 DO 블록이 그것을 단언한다).
  const m0081 = migrationStatements(fs.readFileSync(mig("0081_summary_url_hits.sql"), "utf8"));
  await db.exec("BEGIN");
  for (const s of m0081) await db.exec(s);
  await db.exec("COMMIT");

  await db.exec(`INSERT INTO website_sites (id, brand, country_code, scope_project_id)
                 VALUES ('${S1}', 'Kia', 'MX', '${P1}')`);
  const wp: Array<[string, number, string]> = [
    [PA, 1, "https://www.kia.com/mx/autos/ev6.html"],
    [PB, 2, "https://www.kia.com/mx/autos/k3.html"],
    [PD, 3, "https://www.kia.com/mx/servicio"],
  ];
  for (const [p, seq, t] of wp) {
    await db.exec(`INSERT INTO website_prompts
      (site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text, scope_prompt_id, owned_base_url)
      VALUES ('${S1}', 10, 'kia.com', 'es', ${seq}, '${t}', 'q', '${p}', 'https://www.kia.com/mx')`);
  }
  await db.exec(`INSERT INTO website_sites (id, brand, country_code, scope_project_id)
                 VALUES ('${S2}', 'Kia', 'CO', '${P2}')`);
  await db.exec(`INSERT INTO website_prompts
    (site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text, scope_prompt_id, owned_base_url)
    VALUES ('${S2}', 20, 'kia.com', 'es', 1, 'https://www.kia.com/co/autos/sportage.html', 'q', '${PE}', 'https://www.kia.com/co')`);
  for (const [j, p, e, st, cits] of JOBS) {
    await db.exec(`INSERT INTO summary_cycle_jobs VALUES ('${WEEK}', '${CYC}', '${GEN}', '${j}', '${p}')`);
    for (const g of [GEN, GEN_UNCOVERED]) {
      await db.exec(`INSERT INTO summary_answers
        (cycle_week, cycle_id, generation_id, job_id, prompt_id, engine, country, project_id, lang, run_status)
        VALUES ('${WEEK}', '${CYC}', '${g}', '${j}', '${p}', '${e}', 'MX', '${P1}', 'es', '${st}')`);
    }
    for (const u of cits) {
      await db.exec(`INSERT INTO scope_citations (job_id, url, domain) VALUES ('${j}', '${u}', '${new URL(u).host}')`);
    }
  }
}, 120_000);

afterAll(async () => {
  resetColumnAvailabilityForTests();
  await db?.close();
});

async function generate(normCols: boolean) {
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, normCols);
  const { websitePromptUrlHitJobFlagsSql } = await import("./scope-aggregates");
  const { insertUrlHitsSql, purgeOldUrlHitsSql } = await import("@/lib/summary/generate/load");
  const keys = { cycleWeek: WEEK, cycleId: CYC, generationId: GEN };
  // 재실행 안전: 같은 generation 을 다시 쓰기 전에 지운다(테스트 전용: 생성기는 매번 새 generation).
  await db.exec(`DELETE FROM summary_url_hits; DELETE FROM summary_url_hit_generations;`);
  await run(
    insertUrlHitsSql({
      keys,
      version: "test",
      flags: websitePromptUrlHitJobFlagsSql({
        jobs: sql`SELECT j.job_id, j.prompt_id FROM summary_cycle_jobs j
          WHERE j.cycle_week = ${WEEK}::date AND j.cycle_id = ${CYC}::uuid AND j.generation_id = ${GEN}::uuid`,
        projectIds: [P1],
        units: UNITS,
      }),
    }),
  );
  // 옛 generation 정리 문장이 파싱·실행된다(지울 것은 없다).
  for (const s of purgeOldUrlHitsSql(keys)) await run(s);
}

describe.each([false, true])("0081 사실표: 정규화 컬럼(0052) %s", (normCols) => {
  beforeAll(async () => generate(normCols), 60_000);

  it("① job 판정: 자기 타겟·남의 타겟·형제 base·트래킹 파라미터·미등록", async () => {
    const rows = (await db.query(
      `SELECT job_id::text AS j, registered, owned_hit, target_hit FROM summary_url_hits ORDER BY 1`,
    )).rows;
    const by = Object.fromEntries(rows.map((r) => [String(r.j), [r.registered, r.owned_hit, r.target_hit]]));
    expect(by[job(1)]).toEqual([true, true, true]);
    expect(by[job(2)]).toEqual([true, true, false]);
    expect(by[job(3)]).toEqual([true, false, false]);
    expect(by[job(4)]).toEqual([true, true, true]);
    expect(by[job(5)]).toEqual([false, false, false]);
    expect(by[job(6)]).toEqual([true, false, false]);
    // run 상태는 생성 시 판정에 안 들어간다(조회 게이트): D 의 타겟을 인용했으므로 참.
    expect(by[job(7)]).toEqual([true, true, true]);
    expect(by[job(8)]).toEqual([true, true, false]);
    // 자기 사이트 타겟을 정확히 인용했지만 P1 스코프에는 등록이 없다: 분모·분자 밖.
    expect(by[job(9)]).toEqual([false, false, false]);
    const g = (await db.query(`SELECT jobs FROM summary_url_hit_generations WHERE generation_id = '${GEN}'`)).rows;
    expect(g).toEqual([{ jobs: JOBS.length }]);
  });

  it("② 프롬프트 접기: 무필터·엔진 필터", async () => {
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    expect(await summaryWebsitePromptHitRates(scopeOf([GEN]))).toEqual({
      measuredPrompts: 3, ownedPrompts: 2, hitPrompts: 2, rate: 66.7, ownedRate: 66.7,
    });
    expect(await summaryWebsitePromptHitRates(scopeOf([GEN], { engine: ["chatgpt"] }))).toEqual({
      measuredPrompts: 3, ownedPrompts: 1, hitPrompts: 1, rate: 33.3, ownedRate: 33.3,
    });
    // gemini: A(자사만) · B(타겟) · D(run 실패 → 모수 밖)
    expect(await summaryWebsitePromptHitRates(scopeOf([GEN], { engine: ["gemini"] }))).toEqual({
      measuredPrompts: 2, ownedPrompts: 2, hitPrompts: 1, rate: 50, ownedRate: 100,
    });
  });

  it("③ 커버리지: 원장에 없는 generation 이 섞이면 null(미러로 간다)", async () => {
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    expect(await summaryWebsitePromptHitRates(scopeOf([GEN_UNCOVERED]))).toBeNull();
    const two = scopeOf([GEN]) as unknown as { cycles: WebsiteCyclePick[] };
    two.cycles.push({ ...two.cycles[0], generationId: GEN_UNCOVERED });
    expect(await summaryWebsitePromptHitRates(two as never)).toBeNull();
    expect(await summaryWebsitePromptHitRates(scopeOf([]))).toBeNull();
  });

  it("④ generation 조인: 같은 job 의 다른 generation 행을 섞지 않는다", async () => {
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    // 같은 회차·같은 job id 로 **전부 참인** 다른 generation 을 원장까지 넣는다.
    for (const [j, p] of JOBS) {
      await db.exec(`INSERT INTO summary_url_hits VALUES ('${WEEK}', '${CYC}', '${GEN_OTHER}', '${j}', '${p}', true, true, true)`);
    }
    await db.exec(`INSERT INTO summary_url_hit_generations (generation_id, cycle_id, cycle_week, jobs)
      VALUES ('${GEN_OTHER}', '${CYC}', '${WEEK}', ${JOBS.length})`);
    try {
      // 값은 ② 와 같아야 한다: 조인에서 generation 을 빼면 전 프롬프트가 자사·타겟이 된다.
      expect(await summaryWebsitePromptHitRates(scopeOf([GEN]))).toEqual({
        measuredPrompts: 3, ownedPrompts: 2, hitPrompts: 2, rate: 66.7, ownedRate: 66.7,
      });
    } finally {
      await db.exec(`DELETE FROM summary_url_hits WHERE generation_id = '${GEN_OTHER}';
        DELETE FROM summary_url_hit_generations WHERE generation_id = '${GEN_OTHER}';`);
    }
  });

  it("⑤ 재판정(--force): 한 트랜잭션에서 지우고 다시 넣어 카탈로그 수정을 반영한다", async () => {
    const { websitePromptUrlHitJobFlagsSql } = await import("./scope-aggregates");
    const { insertUrlHitsSql, forceDeleteUrlHitsSql } = await import("@/lib/summary/generate/load");
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    const keys = { cycleWeek: WEEK, cycleId: CYC, generationId: GEN };
    const reinsert = () =>
      insertUrlHitsSql({
        keys, version: "force",
        flags: websitePromptUrlHitJobFlagsSql({
          jobs: sql`SELECT j.job_id, j.prompt_id FROM summary_cycle_jobs j
            WHERE j.cycle_week = ${WEEK}::date AND j.cycle_id = ${CYC}::uuid AND j.generation_id = ${GEN}::uuid`,
          projectIds: [P1], units: UNITS,
        }),
      });
    const force = async () => {
      await db.exec("BEGIN");
      for (const d of forceDeleteUrlHitsSql(keys)) await run(d);
      await run(reinsert());
      await db.exec("COMMIT");
    };
    // 카탈로그 수정: A 의 타겟을 다른 페이지로 → job1 은 자기 타겟이 아니게 된다.
    await db.exec(`UPDATE website_prompts SET target_url = 'https://www.kia.com/mx/autos/niro.html' WHERE scope_prompt_id = '${PA}'`);
    try {
      await force();
      const j1 = (await db.query(`SELECT owned_hit, target_hit FROM summary_url_hits
        WHERE generation_id = '${GEN}' AND job_id = '${job(1)}'`)).rows;
      expect(j1).toEqual([{ owned_hit: true, target_hit: false }]);
      const reg = (await db.query(`SELECT jobs, generator_version FROM summary_url_hit_generations
        WHERE generation_id = '${GEN}'`)).rows;
      expect(reg).toEqual([{ jobs: JOBS.length, generator_version: "force" }]);
      expect((await summaryWebsitePromptHitRates(scopeOf([GEN])))?.hitPrompts).toBe(1);
      // 재판정 중 실패하면 **롤백**: 옛 행이 그대로 남고 원장도 남는다(미러로 떨어지지 않는다).
      await db.exec("BEGIN");
      for (const d of forceDeleteUrlHitsSql(keys)) await run(d);
      await expect(db.exec("SELECT 1/0")).rejects.toThrow();
      await db.exec("ROLLBACK");
      expect((await db.query(`SELECT count(*)::int AS n FROM summary_url_hits WHERE generation_id = '${GEN}'`)).rows)
        .toEqual([{ n: JOBS.length }]);
    } finally {
      await db.exec(`UPDATE website_prompts SET target_url = 'https://www.kia.com/mx/autos/ev6.html' WHERE scope_prompt_id = '${PA}'`);
      await force();
    }
    expect((await summaryWebsitePromptHitRates(scopeOf([GEN])))?.hitPrompts).toBe(2);
  });
});

describe("0081 제약: 판정 불변식을 표가 막는다", () => {
  it("타겟인데 자사가 아닌 행·미등록인데 자사인 행은 거부된다", async () => {
    const ins = (reg: boolean, own: boolean, tgt: boolean) =>
      db.exec(`INSERT INTO summary_url_hits VALUES ('${WEEK}', '${CYC}', gen_random_uuid(),
        gen_random_uuid(), '${PA}', ${reg}, ${own}, ${tgt})`);
    await expect(ins(true, false, true)).rejects.toThrow();
    await expect(ins(false, true, false)).rejects.toThrow();
    await expect(ins(true, true, false)).resolves.toBeDefined();
  });
});

// ── ④ 리더 ≡ 오라클 ─────────────────────────────────────────────────────────
// 오라클 = 미러 쌍둥이(`aggregateWebsiteTargetHitRate`)의 의미론을 JS 로:
//   모수 job = 고른 회차·프로젝트·run 상태·화면 축을 통과한 job
//   프롬프트별 bool_or(owned_hit)/bool_or(target_hit), 분모 = 등록 프롬프트 수
describe("0081 리더 ≡ JS 오라클 (무작위 사실)", () => {
  it("엔진·언어 필터 조합 전부에서 같은 세 정수를 낸다", async () => {
    const { summaryWebsitePromptHitRates } = await import("./summary-website-aggregates");
    await db.exec(`DELETE FROM summary_answers; DELETE FROM summary_url_hits; DELETE FROM summary_url_hit_generations;`);
    let seed = 20260927;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const G2 = "46464646-4646-4646-8646-464646464646";
    const P2 = "12121212-1212-4212-8212-121212121212";
    const engines = ["chatgpt", "gemini", "claude"];
    const langs = ["es", "en"];
    const statuses = ["completed", "completed", "partial_failed", "failed"];
    const prompts = Array.from({ length: 40 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    type Fact = { g: string; p: string; job: string; prompt: string; engine: string; lang: string; st: string;
      reg: boolean; own: boolean; tgt: boolean };
    const facts: Fact[] = [];
    for (let i = 0; i < 600; i += 1) {
      const [g, p] = rnd() < 0.5 ? [GEN, P1] : [G2, P2];
      const reg = rnd() < 0.85;
      const tgt = reg && rnd() < 0.4;
      const own = tgt || (reg && rnd() < 0.3);
      facts.push({ g, p, job: `99999999-0000-4000-8000-${String(i).padStart(12, "0")}`,
        prompt: pick(prompts), engine: pick(engines), lang: pick(langs), st: pick(statuses), reg, own, tgt });
    }
    for (const f of facts) {
      await db.exec(`INSERT INTO summary_answers
        (cycle_week, cycle_id, generation_id, job_id, prompt_id, engine, country, project_id, lang, run_status)
        VALUES ('${WEEK}', '${CYC}', '${f.g}', '${f.job}', '${f.prompt}', '${f.engine}', 'MX', '${f.p}', '${f.lang}', '${f.st}')`);
      await db.exec(`INSERT INTO summary_url_hits VALUES ('${WEEK}', '${CYC}', '${f.g}', '${f.job}', '${f.prompt}', ${f.reg}, ${f.own}, ${f.tgt})`);
    }
    for (const g of [GEN, G2]) {
      await db.exec(`INSERT INTO summary_url_hit_generations (generation_id, cycle_id, cycle_week, jobs)
        VALUES ('${g}', '${CYC}', '${WEEK}', 0)`);
    }
    const scope2 = (filters: Record<string, unknown>) =>
      ({
        cycles: [
          { cycleId: CYC, generationId: GEN, projectId: P1, cycleAnchorAt: "2026-09-25T00:00:00.000Z", cycleWeek: WEEK },
          { cycleId: CYC, generationId: G2, projectId: P2, cycleAnchorAt: "2026-09-25T00:00:00.000Z", cycleWeek: WEEK },
        ],
        projectIds: [P1, P2],
        filters,
        ownedBasePrefixes: [],
        unitFlags: true,
      }) as never;
    const oracle = (filters: { engine?: string[]; lang?: string[] }) => {
      const m = new Map<string, { own: boolean; tgt: boolean }>();
      for (const f of facts) {
        if (!["completed", "partial_failed"].includes(f.st)) continue;
        if (filters.engine && !filters.engine.includes(f.engine)) continue;
        if (filters.lang && !filters.lang.includes(f.lang)) continue;
        if (!f.reg) continue;
        const cur = m.get(f.prompt) ?? { own: false, tgt: false };
        cur.own ||= f.own; cur.tgt ||= f.tgt;
        m.set(f.prompt, cur);
      }
      const v = [...m.values()];
      return { measured: v.length, owned: v.filter((x) => x.own).length, hit: v.filter((x) => x.tgt).length };
    };
    const combos: Array<{ engine?: string[]; lang?: string[] }> = [
      {}, { engine: ["chatgpt"] }, { engine: ["gemini", "claude"] }, { lang: ["en"] },
      { engine: ["claude"], lang: ["es"] }, { engine: ["chatgpt", "gemini", "claude"], lang: ["en", "es"] },
    ];
    for (const c of combos) {
      const got = await summaryWebsitePromptHitRates(scope2(c));
      const want = oracle(c);
      expect(got, JSON.stringify(c)).not.toBeNull();
      expect(
        { measured: got!.measuredPrompts, owned: got!.ownedPrompts, hit: got!.hitPrompts },
        JSON.stringify(c),
      ).toEqual(want);
      expect(got!.hitPrompts).toBeLessThanOrEqual(got!.ownedPrompts);
    }
  });
});

// ── 감시 ③ 조회(`readUrlHitsGaps`)가 진짜 Postgres 에서 돈다 ─────────────────
// 감시가 42703 으로 죽으면 "누락 0" 이 아니라 "판정 불가" 인데, 라우트는 그것을 울리지 않는다.
// 문장 자체가 성립하는지를 여기서 실행으로 고정한다.
describe("readUrlHitsGaps (감시 ③)", () => {
  const GAP_CYC = "56565656-5656-4656-8656-565656565656";
  const GAP_GEN = "67676767-6767-4767-8767-676767676767";
  // 지난 주 회차: 원장에 없지만 스냅샷 카드가 **안 읽는다**(최신 주가 아니다).
  const OLD_CYC = "78787878-7878-4878-8878-787878787878";
  const OLD_GEN = "89898989-8989-4989-8989-898989898989";
  const OLD_WEEK = "2026-09-14";
  beforeAll(async () => {
    for (const s of [
      createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
      `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS hidden_reason text`,
      `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS hidden_scope text`,
      createTableFrom(mig("0059_summary_tables.sql"), "summary_generations"),
      `ALTER TABLE summary_generations ADD COLUMN IF NOT EXISTS timings jsonb`,
    ]) await db.exec(s);
    await db.exec(`INSERT INTO summary_cycles
      (cycle_id, surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status,
       fleet_visible, active_generation_id, view_anchor_at)
      VALUES ('${GAP_CYC}', 'website', '${P1}', now() - interval '2 days', '${WEEK}', 'scope', 'published',
              true, '${GAP_GEN}', now() - interval '1 day'),
             ('${OLD_CYC}', 'website', '${P1}', now() - interval '9 days', '${OLD_WEEK}', 'scope', 'published',
              true, '${OLD_GEN}', now() - interval '8 days')`);
    await db.exec(`INSERT INTO summary_generations (generation_id, cycle_id, generator_version, status, timings)
      VALUES ('${GAP_GEN}', '${GAP_CYC}', 't', 'active', '{"url_hits_failed": 1}'::jsonb)`);
  });

  it("카드가 읽는 최신 주 회차만 센다: 지난 주 누락은 울리지 않는다", async () => {
    resetColumnAvailabilityForTests();
    const { readUrlHitsGaps } = await import("./summary-cycle-health");
    const ids = async () => (await readUrlHitsGaps())?.map((r) => [r.cycleId, r.failed]);
    // 최신 주(WEEK)의 GAP 만: OLD 는 원장에 없어도 대상 밖.
    expect(await ids()).toEqual([[GAP_CYC, true]]);
    await db.exec(`INSERT INTO summary_url_hit_generations (generation_id, cycle_id, cycle_week, jobs)
      VALUES ('${GAP_GEN}', '${GAP_CYC}', '${WEEK}', 1)`);
    try {
      expect(await ids()).toEqual([]);
      // 최신 주 회차를 숨기면 카드는 지난 주를 읽는다: 그때는 OLD 가 대상이다(같은 규칙).
      await db.exec(`DELETE FROM summary_url_hit_generations WHERE generation_id = '${GAP_GEN}'`);
      await db.exec(`UPDATE summary_cycles SET hidden_reason = 'operator' WHERE cycle_id = '${GAP_CYC}'`);
      expect(await ids()).toEqual([[OLD_CYC, null]]);
      // 최신 주 회차가 아직 노출 전이어도 마찬가지.
      await db.exec(`UPDATE summary_cycles SET hidden_reason = NULL, view_anchor_at = now() + interval '1 day' WHERE cycle_id = '${GAP_CYC}'`);
      expect(await ids()).toEqual([[OLD_CYC, null]]);
    } finally {
      await db.exec(`DELETE FROM summary_url_hit_generations WHERE generation_id = '${GAP_GEN}'`);
      await db.exec(`UPDATE summary_cycles SET hidden_reason = NULL, view_anchor_at = now() - interval '1 day' WHERE cycle_id = '${GAP_CYC}'`);
    }
  });
});
