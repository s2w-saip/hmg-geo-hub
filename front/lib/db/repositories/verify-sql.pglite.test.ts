// 수용 SQL(`notes/.../verify/*.sql`)이 **미러에서 돌기 전에** 해석되는가 (2026-09-20).
//
// 왜: G2 초판이 미러에서 6자리 전부 빈 값으로 돌아왔다. 원인은 루트 id 혼동(카탈로그
// CTE 가 scope id 를 써서 0행)이었고, **문장은 정상 실행됐다** — 오류가 아니라 침묵이다.
// PREPARE 는 그 침묵을 못 잡지만, 같은 왕복에서 잡을 수 있는 것은 전부 잡아 둔다:
//   · 열 이름·타입·함수 해석(42703/42883/42P01)
//   · `LEFT JOIN` 키 타입 불일치(date ↔ text)
//   · `DISTINCT ON` 과 `ORDER BY` 의 선두 식 불일치(PG 가 거부한다)
// "0행" 자체는 데이터 문제라 **픽스처 1행**을 심어 사다리 네 열이 전부 값을 내는지까지 본다.
//
// ⚠️ 이 SQL 은 리포 **밖**(워크스페이스 스크래치패드)에 있다 — CI 체크아웃에는 없다.
//    그래서 파일이 없으면 **skip** 한다. 로컬(개발자)에서만 도는 가드다.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTableFrom, MIG_DIR } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

const VERIFY_DIR = path.resolve(
  process.cwd(),
  "../../notes/hmg-anchor-table/single-source/verify",
);
/** 분모 사다리 · 노출률 근사 — 합본이 미러에서 5분 timeout 이라 둘로 갈랐다. */
const G2A = path.join(VERIFY_DIR, "G2a-denominator-ladder.sql");
const G2B = path.join(VERIFY_DIR, "G2b-exposure-approx.sql");
/** 셀 단위 대칭차 — 08-03·08-17 의 176·180셀 부족을 원인 범주로 가른다. */
const G2C = path.join(VERIFY_DIR, "G2c-cell-diff.sql");
const has = [G2A, G2B, G2C].every((f) => fs.existsSync(f));

const mig = (f: string) => path.join(MIG_DIR, f);
const MIRROR_SQL = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");

/** scope 프로젝트 id 와 **로컬 카탈로그 id** — G2 가 둘을 구분해 쓰는지 픽스처로 확인한다. */
const SCOPE_ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const CATALOG_ROOT = "26751906-c175-485c-9e69-29fc68d0fdbb";
const HYUNDAI = "00000000-0000-0000-0000-000000000301";

let db: Db;

beforeAll(async () => {
  if (!has) return;
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
  const ddl: string[] = [
    ...["scope_runs", "scope_answers", "scope_prompts", "scope_mentions"].map((t) =>
      createTableFrom(MIRROR_SQL, t),
    ),
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS is_korean boolean;`,
    `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS regions text[];`,
    // 0044 — 대시보드/MCP 로 붙었던 컬럼(분자 판정이 읽는다).
    `ALTER TABLE scope_mentions ADD COLUMN IF NOT EXISTS brand_rollup_entity_id uuid;`,
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_trend_own"),
    // G2c 가 읽는 두 표 — 회차 셀 목록과 프롬프트 차원 스냅샷.
    // ⚠️ 둘 다 `PARTITION BY RANGE (cycle_week)` 라 **파티션을 만들어야** INSERT 가 붙는다
    //    (없으면 "no partition of relation … found for row"). 픽스처가 쓰는 주 하나씩.
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycle_jobs"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_prompt_dim"),
    ...["summary_cycle_jobs", "summary_prompt_dim"].flatMap((t) => [
      `CREATE TABLE IF NOT EXISTS ${t}_p2026w31 PARTITION OF ${t}
         FOR VALUES FROM ('2026-07-27') TO ('2026-08-03');`,
    ]),
    ...[
      "hidden_reason text", "hidden_scope text", "fleet_visible boolean",
      "view_anchor_at timestamptz", "active_generation_id uuid", "cycle_week date",
    ].map((c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`),
    anchorTableDdl(),
    `CREATE TABLE IF NOT EXISTS prompts (
       id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid);`,
    `CREATE TABLE IF NOT EXISTS entity_registry (
       entity_id uuid PRIMARY KEY, name text, role text);`,
    `CREATE OR REPLACE FUNCTION hmg_anchor_today() RETURNS date
       LANGUAGE sql IMMUTABLE AS $fn$ SELECT '2026-09-20'::date $fn$;`,
  ];
  for (const s of ddl) await db.exec(s);
  await seed();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

/** 0077 앵커 표 DDL — 원본 마이그레이션에서 읽는다(타입 복사 금지). */
function anchorTableDdl(): string {
  const src = fs.readFileSync(mig("0077_scope_answer_cycle_anchors.sql"), "utf8");
  const m = src.match(/CREATE TABLE scope_answer_cycle_anchors \([\s\S]*?\n {4}\);/);
  if (!m) throw new Error("0077 의 scope_answer_cycle_anchors DDL 을 못 찾았다");
  return m[0].replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS");
}

/**
 * **자리 둘(2026-08-03 · 2026-09-07) × 한 셀씩** 심는다. 앞 자리는 G2a 사다리용,
 * 뒤 자리는 G2b(노출률, 자리 하나 고정)용이다. 사다리 네 열이 전부 1 이 되는 최소 구성이라,
 * 어느 겹에서 0 으로 떨어지면 그 겹의 술어가 픽스처와 어긋난 것이다 — G2 초판의
 * "카탈로그 0행" 이 이 픽스처에서 재현된다(로컬 카탈로그 id 를 scope id 로 쓰면 0).
 */
async function seed(): Promise<void> {
  const cyc = "11111111-1111-4111-8111-111111111111";
  const gen = "22222222-2222-4222-8222-222222222222";
  const run = "33333333-3333-4333-8333-333333333333";
  const job = "44444444-4444-4444-8444-444444444444";
  const prompt = "55555555-5555-4555-8555-555555555555";
  // G2b 는 `2026-09-07` 자리 하나만 본다 — 같은 프롬프트·다른 회차/run/job 으로 심는다.
  const cyc2 = "1111aaaa-1111-4111-8111-111111111111";
  const gen2 = "2222aaaa-2222-4222-8222-222222222222";
  const run2 = "3333aaaa-3333-4333-8333-333333333333";
  const job2 = "4444aaaa-4444-4444-8444-444444444444";
  // 드리프트 셀(EG) — dim 스냅샷과 현재 `scope_prompts` 가 다른 프롬프트.
  const promptD = "5555bbbb-5555-4555-8555-555555555555";
  const jobD = "4444bbbb-4444-4444-8444-444444444444";
  await db.exec(`
    INSERT INTO summary_cycles (cycle_id, project_id, surface, cycle_anchor_at, cycle_week,
                                anchor_source, status, active_generation_id, fleet_visible,
                                view_anchor_at)
    VALUES ('${cyc}'::uuid, '${SCOPE_ROOT}'::uuid, 'global', '2026-07-30T00:05:04Z',
            '2026-07-27'::date, 'scope', 'published', '${gen}'::uuid, true,
            '2026-09-10T05:51:50Z');
    INSERT INTO scope_runs (run_id, project_id, status) VALUES ('${run}'::uuid, '${SCOPE_ROOT}'::uuid, 'completed');
    INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status, measured_at)
    VALUES ('${job}'::uuid, '${run}'::uuid, '${prompt}'::uuid, 'chatgpt', 'US', 'completed',
            '2026-07-30T01:00:00Z');
    INSERT INTO scope_answer_cycle_anchors
      (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
       measured_at_orig, is_default_engine, round_date, view_anchor_date, cycle_id, source)
    VALUES ('${job}'::uuid, '${run}'::uuid, '${SCOPE_ROOT}'::uuid, 'standard',
            '2026-07-30T00:05:04Z', '2026-07-30'::date, '2026-07-27'::date, '2026-07-01'::date,
            '2026-07-30T01:00:00Z', true, '2026-08-03'::date, '2026-09-10'::date,
            '${cyc}'::uuid, 'ledger');
    -- 카탈로그는 **로컬 id** 로 심는다(G2 가 scope id 를 쓰면 여기서 0행이 된다).
    INSERT INTO prompts (id, scope_prompt_id, project_id)
    VALUES ('66666666-6666-4666-8666-666666666666'::uuid, '${prompt}'::uuid, '${CATALOG_ROOT}'::uuid);
    -- 시장 태그 없음 = 전체 상속(제외 안 됨) · 한국어 아님.
    INSERT INTO scope_prompts (prompt_id, text, is_korean, regions)
    VALUES ('${prompt}'::uuid, 'best ev suv', false, NULL);
    INSERT INTO entity_registry (entity_id, name, role) VALUES ('${HYUNDAI}'::uuid, 'Hyundai', 'own');
    -- 표기 접두 규칙이 **발화**하도록 rollup 은 남의 것으로 두고 표기만 당사로 둔다.
    INSERT INTO scope_mentions (job_id, entity_id, brand, brand_rollup_entity_id)
    VALUES ('${job}'::uuid, '77777777-7777-4777-8777-777777777777'::uuid,
            'Hyundai Ioniq 5', '88888888-8888-4888-8888-888888888888'::uuid);
    INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, lang,
       engine, funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
    VALUES ('${cyc}'::uuid, '${gen}'::uuid, '2026-07-30T00:05:04Z', '2026-07-27'::date, 'global',
            '${SCOPE_ROOT}'::uuid, 'US', 'EN', 'chatgpt', '', '', '', '', '',
            1, 1, 0, 'completed', 'ALL', 1, 1, 0, 0, 0, 0, 1, 0, 0, 0);
    -- G2c: 같은 셀을 회차 잡 목록과 차원 스냅샷에도 심는다. dim 스냅샷이 현재
    -- scope_prompts 와 같은 값이므로 이 셀은 both-ok 로 떨어져야 한다.
    INSERT INTO summary_cycle_jobs
      (cycle_week, cycle_id, generation_id, job_id, run_id, prompt_id, engine, country, measured_at)
    VALUES ('2026-07-27'::date, '${cyc}'::uuid, '${gen}'::uuid, '${job}'::uuid, '${run}'::uuid,
            '${prompt}'::uuid, 'chatgpt', 'US', '2026-07-30T01:00:00Z');
    INSERT INTO summary_prompt_dim
      (cycle_week, cycle_id, generation_id, prompt_id, project_id, regions, is_korean,
       in_root_catalog, in_full_cycle)
    VALUES ('2026-07-27'::date, '${cyc}'::uuid, '${gen}'::uuid, '${prompt}'::uuid,
            '${SCOPE_ROOT}'::uuid, NULL, 0, 1, 0);
    -- ── 드리프트 셀 (미러 실측 08-03 176셀의 축소판) ─────────────────────────
    -- 스냅샷(dim)은 EG 를 태그 안으로 굳혔는데 **지금** scope_prompts 는 EG 를 뺐다.
    -- 사실표는 센다(스냅샷 기준) · 현재값 술어를 쓰면 미러만 뺀다 → 이 셀이 그 차이다.
    INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status, measured_at)
    VALUES ('${jobD}'::uuid, '${run}'::uuid, '${promptD}'::uuid, 'chatgpt', 'EG', 'completed',
            '2026-07-30T01:30:00Z');
    INSERT INTO scope_answer_cycle_anchors
      (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
       measured_at_orig, is_default_engine, round_date, view_anchor_date, cycle_id, source)
    VALUES ('${jobD}'::uuid, '${run}'::uuid, '${SCOPE_ROOT}'::uuid, 'standard',
            '2026-07-30T00:05:04Z', '2026-07-30'::date, '2026-07-27'::date, '2026-07-01'::date,
            '2026-07-30T01:30:00Z', true, '2026-08-03'::date, '2026-09-10'::date,
            '${cyc}'::uuid, 'ledger');
    INSERT INTO prompts (id, scope_prompt_id, project_id)
    VALUES ('6666aaaa-6666-4666-8666-666666666666'::uuid, '${promptD}'::uuid, '${CATALOG_ROOT}'::uuid);
    -- **현재** 태그: US 만. EG 는 빠졌다.
    INSERT INTO scope_prompts (prompt_id, text, is_korean, regions)
    VALUES ('${promptD}'::uuid, 'best ev suv in egypt', false, ARRAY['US']);
    -- **스냅샷** 태그: US·EG (생성 시점엔 EG 가 안에 있었다).
    INSERT INTO summary_prompt_dim
      (cycle_week, cycle_id, generation_id, prompt_id, project_id, regions, is_korean,
       in_root_catalog, in_full_cycle)
    VALUES ('2026-07-27'::date, '${cyc}'::uuid, '${gen}'::uuid, '${promptD}'::uuid,
            '${SCOPE_ROOT}'::uuid, ARRAY['US', 'EG'], 0, 1, 0);
    INSERT INTO summary_cycle_jobs
      (cycle_week, cycle_id, generation_id, job_id, run_id, prompt_id, engine, country, measured_at)
    VALUES ('2026-07-27'::date, '${cyc}'::uuid, '${gen}'::uuid, '${jobD}'::uuid, '${run}'::uuid,
            '${promptD}'::uuid, 'chatgpt', 'EG', '2026-07-30T01:30:00Z');
    -- 사실표는 그 셀을 **센다**(스냅샷 기준 태그 안) — 08-03 자리 분모가 2 가 된다.
    INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, lang,
       engine, funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
    VALUES ('${cyc}'::uuid, '${gen}'::uuid, '2026-07-30T00:05:04Z', '2026-07-27'::date, 'global',
            '${SCOPE_ROOT}'::uuid, 'EG', 'EN', 'chatgpt', '', '', '', '', '',
            1, 1, 0, 'completed', 'ALL', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    -- ── 2026-09-07 자리 (G2b) ────────────────────────────────────────────────
    INSERT INTO summary_cycles (cycle_id, project_id, surface, cycle_anchor_at, cycle_week,
                                anchor_source, status, active_generation_id, fleet_visible,
                                view_anchor_at)
    VALUES ('${cyc2}'::uuid, '${SCOPE_ROOT}'::uuid, 'global', '2026-09-08T01:10:26Z',
            '2026-09-07'::date, 'scope', 'published', '${gen2}'::uuid, true,
            '2026-09-10T10:38:37Z');
    INSERT INTO scope_runs (run_id, project_id, status) VALUES ('${run2}'::uuid, '${SCOPE_ROOT}'::uuid, 'completed');
    INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status, measured_at)
    VALUES ('${job2}'::uuid, '${run2}'::uuid, '${prompt}'::uuid, 'chatgpt', 'US', 'completed',
            '2026-09-08T02:00:00Z');
    INSERT INTO scope_answer_cycle_anchors
      (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
       measured_at_orig, is_default_engine, round_date, view_anchor_date, cycle_id, source)
    VALUES ('${job2}'::uuid, '${run2}'::uuid, '${SCOPE_ROOT}'::uuid, 'standard',
            '2026-09-08T01:10:26Z', '2026-09-08'::date, '2026-09-07'::date, '2026-09-01'::date,
            '2026-09-08T02:00:00Z', true, '2026-09-07'::date, '2026-09-10'::date,
            '${cyc2}'::uuid, 'ledger');
    INSERT INTO scope_mentions (job_id, entity_id, brand, brand_rollup_entity_id)
    VALUES ('${job2}'::uuid, '77777777-7777-4777-8777-777777777777'::uuid,
            'Hyundai Ioniq 5', '88888888-8888-4888-8888-888888888888'::uuid);
    INSERT INTO summary_trend_own
      (cycle_id, generation_id, cycle_anchor_at, cycle_week, surface, project_id, country, lang,
       engine, funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant,
       monitored, tracked_answers, multi_answers, top1_answers, top3_answers,
       ranked_answers, own_mentions, own_positive, own_signals, prompts_tracked)
    VALUES ('${cyc2}'::uuid, '${gen2}'::uuid, '2026-09-08T01:10:26Z', '2026-09-07'::date, 'global',
            '${SCOPE_ROOT}'::uuid, 'US', 'EN', 'chatgpt', '', '', '', '', '',
            1, 1, 0, 'completed', 'ALL', 1, 1, 0, 0, 0, 0, 1, 0, 0, 0);
  `);
}

/** pglite 는 `date` 를 JS `Date` 로 준다 — 문자열 비교 전에 UTC 일자로 접는다. */
const dayOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const suite = has ? describe : describe.skip;

const read = (f: string) => fs.readFileSync(f, "utf8").trim().replace(/;\s*$/, "");

suite("G2a·G2b 수용 SQL — 해석되고, 값을 낸다", () => {
  const body = () => read(G2A);

  it.each([
    ["G2a", G2A],
    ["G2b", G2B],
    ["G2c", G2C],
  ])("%s 규약: 단일 문장 · 세미콜론 없음 · WITH 로 시작 · 바인드 없음", (_n, f) => {
    const t = read(f);
    expect(t).not.toContain(";");
    // 머리 주석(`--`)은 규약상 허용된다 — 첫 **문장** 줄이 WITH 여야 한다.
    const firstStatementLine = t.split("\n").find((l) => l.trim() && !l.trim().startsWith("--"));
    expect(firstStatementLine?.trim()).toMatch(/^WITH\b/);
    expect(t).not.toMatch(/\$\d/);
  });

  it.each([
    ["G2a", G2A],
    ["G2b", G2B],
    ["G2c", G2C],
  ])("%s uuid 리터럴에 ::uuid 캐스트가 붙어 있다", (_n, f) => {
    const bare = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'(?!::uuid)/i;
    expect(bare.test(read(f))).toBe(false);
  });

  // 초판의 결함을 **텍스트로** 고정한다 — 두 루트가 각자의 표에 붙어 있는가.
  it.each([
    ["G2a", G2A],
    ["G2b", G2B],
    ["G2c", G2C],
  ])("%s 루트 id 둘을 구분해 쓴다 (카탈로그는 로컬 id)", (_n, f) => {
    const t = read(f);
    expect(t).toContain(`FROM prompts p\n   WHERE p.project_id = '${CATALOG_ROOT}'::uuid`);
    expect(t).toContain(`ca.project_id = '${SCOPE_ROOT}'::uuid`);
    expect(t).toContain(`sc.project_id = '${SCOPE_ROOT}'::uuid`);
  });

  // 무거운 쪽(분자)이 G2a 에 남아 있으면 5분 timeout 이 재발한다.
  // 커밋 1910e33 이후의 술어를 써야 한다 — 옛 `hidden_reason IS NULL` 은
  // `hidden_scope='citations'` 회차를 언급 계열에서도 빼서 08-24 자리를 갈랐다.
  it.each([
    ["G2a", G2A],
    ["G2b", G2B],
    ["G2c", G2C],
  ])("%s 는 계열별 숨김 규칙을 쓴다 (1910e33 이후)", (_n, f) => {
    const stmt = read(f)
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(stmt).toContain("COALESCE(sc.hidden_scope, 'all') <> 'all'");
    expect(stmt).not.toMatch(/AND sc\.hidden_reason IS NULL/);
  });

  it("G2c 는 분자를 안 읽고 원인 범주를 낸다", async () => {
    const stmt = read(G2C);
    const code = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toContain("scope_mentions");
    expect(code).not.toContain("entity_registry");
    const { rows } = await db.query(stmt);
    // 픽스처의 셀 하나는 dim 스냅샷·현재 값이 같으므로 `both-ok` 로 떨어진다.
    const total = rows.find((r) => r.cause === "both-ok" && r.region === null);
    expect(total, "both-ok 롤업 행이 없다").toBeTruthy();
    expect(Number(total?.cells)).toBe(1);
  }, 120_000);

  it("G2a 는 분자를 **안 읽는다** (timeout 재발 방지)", () => {
    const stmt = body()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(stmt).not.toContain("scope_mentions");
    expect(stmt).not.toContain("entity_registry");
    // `DISTINCT ON` 은 정확히 셋 — 사다리 앞 셋은 한 번 접은 집합을 FILTER 로 세고,
    // `m_pr4`(현재값)·`m_dim`(스냅샷)만 각자 "거른 뒤 접기" 를 한다.
    expect(stmt.match(/DISTINCT ON/g) ?? []).toHaveLength(3);
    // dim 경로는 상관 서브쿼리가 아니라 LEFT JOIN 이어야 한다(timeout 전례).
    // 사전 집계 + 등치 해시 조인(제품 코드와 같은 모양). 셀마다 파티션 표를 찌르면
    // 13자리 창에서 Nested Loop 209,480회가 된다(미러 EXPLAIN 1차 실측 4,324ms).
    expect(stmt).toContain("dim_small AS MATERIALIZED");
    expect(stmt).toContain("LEFT JOIN dim_small d ON d.cycle_id = ca.cycle_id");
    expect(stmt).not.toContain("LEFT JOIN summary_prompt_dim");
    expect(stmt).not.toContain("LATERAL");
  });

  it.each([
    ["G2a", G2A],
    ["G2b", G2B],
    ["G2c", G2C],
  ])("%s PREPARE 를 통과한다 (열 이름·타입·조인 키)", async (_n, f) => {
    await db.exec(`PREPARE _g2 AS ${read(f)}`);
    await db.exec(`DEALLOCATE _g2`);
  }, 120_000);

  it("G2a 사다리 네 열과 판정 열이 값을 낸다 (빈 값 = 술어 과다)", async () => {
    const { rows } = await db.query(body());
    const row = rows.find((r) => dayOf(r.round_date) === "2026-08-03");
    expect(row, "2026-08-03 행이 없다").toBeTruthy();
    const n = (k: string) => Number(row?.[k]);
    // 셀 둘(US 정상 + EG 드리프트). 현재값 사다리는 EG 를 빼고(`m_region` 1),
    // **dim 기준 열(`m_dim`)은 사실표와 같은 2** 여야 한다 — 이 수리의 핵심 단언이다.
    expect([n("m_raw"), n("m_region"), n("m_catalog"), n("m_pr4")]).toEqual([2, 1, 1, 1]);
    expect(n("m_dim"), "dim 기준 분모가 사실표와 같아야 한다").toBe(2);
    expect(n("fact_denom")).toBe(2);
    expect(n("dim_rel_err"), "dim 기준 오차 0").toBe(0);
    expect(row?.g2_dim_pass).toBe(true);
    expect(n("slot_cycles_all")).toBe(1);
    expect(n("slot_cycles_fleet")).toBe(1);
    // 접두 규칙이 **발화했다**(rollup 은 남의 id, 표기는 'Hyundai …') — 코드 주석의 규율.
  }, 120_000);

  it("G2b 노출률 열이 값을 낸다 — 접두 규칙 발화까지", async () => {
    const { rows } = await db.query(read(G2B));
    const row = rows.find((r) => dayOf(r.round_date) === "2026-09-07");
    expect(row, "2026-09-07 행이 없다").toBeTruthy();
    const n = (k: string) => Number(row?.[k]);
    expect(n("mirror_denom")).toBe(1);
    expect(n("fact_denom")).toBe(1);
    expect(n("mirror_exposure_pct_approx")).toBe(100);
    expect(n("fact_exposure_pct")).toBe(100);
    expect(n("exposure_abs_pp_approx")).toBe(0);
    expect(row?.g2_exposure_pass).toBe(true);
    // rollup 은 남의 id · 표기는 'Hyundai …' → 접두 규칙이 **발화**해야 1 이다.
    expect(n("prefix_rule_fired")).toBe(1);
  }, 120_000);

  // 초판이 침묵한 형태를 **픽스처로 재현**한다: 카탈로그에 scope id 를 쓰면 0행이 된다.
  it("G2a 카탈로그에 scope id 를 쓰면 미러가 0행이 된다 (초판 침묵의 재현)", async () => {
    const broken = body().replaceAll(`'${CATALOG_ROOT}'::uuid`, `'${SCOPE_ROOT}'::uuid`);
    const { rows } = await db.query(broken);
    const row = rows.find((r) => dayOf(r.round_date) === "2026-08-03");
    expect(Number(row?.m_raw), "게이트 전 셀은 그대로 둘").toBe(2);
    expect(Number(row?.m_catalog)).toBe(0);
    expect(row?.m_pr4 ?? null).toBeNull();
    // ⚠️ `m_dim` 은 **안 죽는다** — dim 행이 있는 셀은 스냅샷 분기가 이기므로
    //    카탈로그 CTE 가 틀려도 판정이 흔들리지 않는다(경로 분리의 부수 효과).
    expect(Number(row?.m_dim)).toBe(2);
  }, 120_000);
});
