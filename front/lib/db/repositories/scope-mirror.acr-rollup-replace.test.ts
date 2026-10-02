/**
 * ACR 롤업은 **prompt_run 단위로 교체**된다 — 한 prompt_run 이 여러 run 에 걸쳐도
 * 23505 로 죽지 않는다 (2026-09-28 루트 프로젝트 싱크 영구 정지).
 *
 * ── 무엇이 문제였나 ──────────────────────────────────────────────────────
 * ACR prompt_run 의 반복 중 실패분이 manual run 으로 재측정되면 **한 prompt_run 이
 * 여러 measurement run 에 걸친다**(코어 실측: 9/21 회차 prompt_run 3,131 중 262,
 * 9/28 회차 3,196 중 196). 예: prompt_run adde83ef… = scheduled run 7a1a587b(10잡)
 * + manual run 332f7ec1(1잡).
 *
 * `writeMirrorChunk` 는 롤업을 **runId 로만** 지우고 (prompt_run_id, entity_id) PK 로
 * insert 했다. 두 번째 run 을 쓸 때 첫 run 이 쥔 같은 prompt_run 행과 충돌 →
 * `scope_acr_rollups_pkey` 23505 → run 트랜잭션 통째 롤백 → 워터마크 미생성 →
 * 다음 패스도 같은 run 에서 죽는다(크론 포함 영구 정지).
 *
 * scope 는 같은 prompt_run 의 모든 job 에 **prompt_run 전체 기준** acr_summary 를
 * 돌려준다(sync.ts collectAcrPromptRuns). 어느 run 에서 읽든 그 시점의 prompt_run
 * 전체 스냅샷이므로 "나중에 쓴 쪽이 이긴다" 가 의미상 맞다.
 *
 * 실제 PK 제약으로 판정해야 하므로 fake db 가 아니라 PGlite(인메모리 Postgres)에서
 * 0025 마이그레이션의 DDL 그대로 테이블을 만든다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { ScopeMirrorProgressTx } from "./scope-mirror-progress";
import { PgDialect } from "drizzle-orm/pg-core";
import { acrResidualWhere, writeMirrorChunk, type MirrorAcrRollup, type MirrorRun } from "./scope-mirror";
import { verifyBulkRows, expectedAcrByPromptRun, type BulkRunState } from "@/lib/scope/mirror/bulk-run";

const RUN_A = "7a1a587b-0000-4000-8000-000000000001"; // scheduled
const RUN_B = "332f7ec1-0000-4000-8000-000000000002"; // manual 재측정
const PROJECT = "be28fe15-c743-4a88-abb8-182b25602812";
const P = "adde83ef-0000-4000-8000-00000000000a"; // A·B 에 걸친 prompt_run
const Q = "adde83ef-0000-4000-8000-00000000000b"; // A 에만 있는 prompt_run
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

const CAPS = { anchors: false, drops: false, occAvailable: false, stances: false };

const acrDdl = readFileSync(
  fileURLToPath(new URL("../migrations/0025_prompt_kind_acr_rollups.sql", import.meta.url)),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => /scope_acr_rollups/.test(s));

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

const run = (runId: string, cycleAnchorAt?: string | null): MirrorRun => ({
  runId,
  projectId: PROJECT,
  status: "completed",
  startedAt: new Date("2026-09-20T23:21:00Z"),
  completedAt: new Date("2026-09-21T00:00:00Z"),
  totalJobs: 1,
  ...(cycleAnchorAt !== undefined ? { cycleAnchorAt: cycleAnchorAt ? new Date(cycleAnchorAt) : null } : {}),
});

const rollup = (
  promptRunId: string,
  entityId: string,
  runId: string,
  choiceCount: number,
  measuredAt = "2026-09-21T00:00:00Z",
  promptId: string | null = null,
): MirrorAcrRollup => ({
  promptRunId,
  entityId,
  runId,
  promptId,
  target: "chatgpt",
  region: "KR",
  measuredAt: new Date(measuredAt),
  rollupLevel: "brand",
  plannedIterations: 10,
  validAcrIterations: 10,
  choiceCount,
  acr: choiceCount / 10,
});

/** replaceRun 과 같은 모양 — 한 트랜잭션에서 writeMirrorChunk 1회. `anchor` = 소스 run 의 cycle_anchor_at. */
async function write(
  runId: string,
  rows: MirrorAcrRollup[],
  options: { append?: boolean; finalize?: boolean } = {},
  anchor?: string | null,
) {
  await db.transaction(async (tx) => {
    await writeMirrorChunk(tx as unknown as ScopeMirrorProgressTx, run(runId, anchor), [], [], [], rows, [], [], CAPS, options);
  });
}

async function rowsOf(promptRunId: string) {
  const r = await pg.query<{ entity_id: string; run_id: string; choice_count: number }>(
    "SELECT entity_id, run_id, choice_count FROM scope_acr_rollups WHERE prompt_run_id = $1 ORDER BY entity_id",
    [promptRunId],
  );
  return r.rows;
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle({ client: pg });
  await pg.exec(`
    -- A1 동시 쓰기 재현용: 세션 플래그가 켜지면 행 delete 를 건너뛴다 = "delete 가
    -- 상대 트랜잭션의 미커밋 insert 를 못 봤다" 는 READ COMMITTED 경합의 결과 상태.
    -- (PGlite 는 단일 커넥션이라 진짜 동시 트랜잭션을 못 띄운다.)
    CREATE TABLE IF NOT EXISTS _test_flags (k text PRIMARY KEY);
    CREATE TABLE scope_runs (
      run_id uuid PRIMARY KEY, project_id uuid, status text,
      started_at timestamptz, completed_at timestamptz,
      cycle_anchor_at timestamptz, total_jobs integer,
      synced_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid NOT NULL);
  `);
  expect(acrDdl.length).toBeGreaterThan(0);
  for (const stmt of acrDdl) await pg.exec(stmt);
  await pg.exec(`
    CREATE FUNCTION _test_hide_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- prompt_run 단위 사전 delete **만** 못 본 것으로 만든다(= 경합 상태). run_id delete·
      -- 잔여 정리 delete 는 그대로 돈다 — 잔여 정리가 실제로 잔여를 지우는지 봐야 하므로.
      IF EXISTS (SELECT 1 FROM _test_flags WHERE k = 'hide_deletes')
         AND current_query() ILIKE 'delete from "scope_acr_rollups" where "scope_acr_rollups"."prompt_run_id" in%'
         AND current_query() NOT ILIKE '%not exists%'
      THEN RETURN NULL; END IF;
      RETURN OLD;
    END $$;
    CREATE TRIGGER _test_hide_delete BEFORE DELETE ON scope_acr_rollups
      FOR EACH ROW EXECUTE FUNCTION _test_hide_delete();
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("TRUNCATE scope_acr_rollups, scope_runs, scope_answers, _test_flags");
});

describe("ACR 롤업 prompt_run 단위 교체 (루트 싱크 23505 정지)", () => {
  it("★ run A 가 쥔 prompt_run P 를 run B 가 다시 쓰면 23505 없이 B 의 값·run_id 로 교체된다", async () => {
    await write(RUN_A, [rollup(P, E1, RUN_A, 3), rollup(P, E2, RUN_A, 2), rollup(Q, E1, RUN_A, 7)]);
    expect(await rowsOf(P)).toHaveLength(2);

    // B 의 스냅샷(P 전체 기준, 나중 시점) — E2 는 더 이상 없고 E3 가 새로 생겼다.
    await expect(write(RUN_B, [rollup(P, E1, RUN_B, 4), rollup(P, E3, RUN_B, 1)])).resolves.toBeUndefined();

    expect(await rowsOf(P)).toEqual([
      { entity_id: E1, run_id: RUN_B, choice_count: 4 },
      { entity_id: E3, run_id: RUN_B, choice_count: 1 },
    ]);
    // B 에 없는 prompt_run 은 건드리지 않는다 — A 소유 그대로.
    expect(await rowsOf(Q)).toEqual([{ entity_id: E1, run_id: RUN_A, choice_count: 7 }]);
    // run 행(워터마크)도 B 까지 써졌다 — 롤백되지 않았다는 흔적.
    const runs = await pg.query<{ run_id: string }>("SELECT run_id FROM scope_runs ORDER BY run_id");
    expect(runs.rows.map((r) => r.run_id).sort()).toEqual([RUN_A, RUN_B].sort());
  });

  it("A→B→A: B→A 방향도 23505 없이 A 가 이긴다 (last writer wins, 멱등)", async () => {
    await write(RUN_A, [rollup(P, E1, RUN_A, 3)]);
    await write(RUN_B, [rollup(P, E1, RUN_B, 4)]);
    await write(RUN_A, [rollup(P, E1, RUN_A, 5)]);
    expect(await rowsOf(P)).toEqual([{ entity_id: E1, run_id: RUN_A, choice_count: 5 }]);
    // 같은 run 재싱크 반복도 멱등.
    await write(RUN_A, [rollup(P, E1, RUN_A, 5)]);
    expect(await rowsOf(P)).toEqual([{ entity_id: E1, run_id: RUN_A, choice_count: 5 }]);
  });

  it("append(대량/슬라이스 ACR 청크) 경로도 다른 run 이 쥔 prompt_run 과 충돌하지 않는다", async () => {
    await write(RUN_A, [rollup(P, E1, RUN_A, 3), rollup(P, E2, RUN_A, 2)]);
    await expect(
      write(RUN_B, [rollup(P, E1, RUN_B, 6)], { append: true, finalize: false }),
    ).resolves.toBeUndefined();
    expect(await rowsOf(P)).toEqual([{ entity_id: E1, run_id: RUN_B, choice_count: 6 }]);
  });

  it("prompt_run 이 청크 크기(500)를 넘어도 전부 교체된다", async () => {
    const ids = Array.from({ length: 1_201 }, (_, i) => `adde83ef-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await write(RUN_A, ids.map((id) => rollup(id, E1, RUN_A, 1)));
    await write(RUN_B, ids.map((id) => rollup(id, E1, RUN_B, 2)));
    const r = await pg.query<{ run_id: string; n: number }>(
      "SELECT run_id, count(*)::int AS n FROM scope_acr_rollups GROUP BY run_id",
    );
    expect(r.rows).toEqual([{ run_id: RUN_B, n: 1_201 }]);
  });
});

async function measuredAtOf(promptRunId: string): Promise<string[]> {
  const r = await pg.query<{ m: Date }>(
    "SELECT DISTINCT measured_at AS m FROM scope_acr_rollups WHERE prompt_run_id = $1",
    [promptRunId],
  );
  return r.rows.map((x) => new Date(x.m).toISOString());
}

describe("A1 동시 쓰기 — delete 가 못 본 행과 insert 가 부딪혀도 23505 없이 흡수·잔여 정리", () => {
  it("★ 상대 tx 의 행이 delete 를 피해 남아 있어도 ON CONFLICT 로 덮고, 상대 전용 엔티티 잔여는 같은 tx 에서 지운다", async () => {
    await write(RUN_A, [rollup(P, E1, RUN_A, 3, "2026-09-20T23:21:00Z"), rollup(P, E2, RUN_A, 2, "2026-09-20T23:21:00Z")]);
    await pg.exec("INSERT INTO _test_flags VALUES ('hide_deletes')");
    await expect(write(RUN_B, [rollup(P, E1, RUN_B, 9, "2026-09-21T12:47:00Z")])).resolves.toBeUndefined();
    await pg.exec("DELETE FROM _test_flags");
    const r = await pg.query<{ entity_id: string; run_id: string; choice_count: number; acr: number; m: Date }>(
      "SELECT entity_id, run_id, choice_count, acr, measured_at AS m FROM scope_acr_rollups WHERE prompt_run_id = $1 ORDER BY entity_id",
      [P],
    );
    // E1 은 B 가 전 컬럼을 덮었고, A 전용이던 E2 는 잔여 정리로 사라졌다 — prompt_run 이 한 run·한 날짜.
    expect(r.rows.map((x) => ({ ...x, m: new Date(x.m).toISOString(), acr: Math.round(x.acr * 10) / 10 }))).toEqual([
      { entity_id: E1, run_id: RUN_B, choice_count: 9, acr: 0.9, m: "2026-09-21T12:47:00.000Z" },
    ]);
  });

  it("잔여 정리 술어는 prompt_run IN 으로 먼저 좁힌다 — pkey 선두 컬럼을 타게(순차 경로 오버헤드)", () => {
    const q = new PgDialect().sqlToQuery(acrResidualWhere([P, Q], JSON.stringify([[P, E1], [Q, E2]]))!);
    expect(q.sql).toMatch(/^\("scope_acr_rollups"\."prompt_run_id" in \(\$1, \$2\) and NOT EXISTS/);
    expect(q.params).toEqual([P, Q, JSON.stringify([[P, E1], [Q, E2]])]);
  });

  it("잔여 정리는 이번 배치의 prompt_run 만 건드린다 — 다른 prompt_run 은 보존", async () => {
    await write(RUN_A, [rollup(P, E1, RUN_A, 3), rollup(P, E2, RUN_A, 2), rollup(Q, E2, RUN_A, 7)]);
    await pg.exec("INSERT INTO _test_flags VALUES ('hide_deletes')");
    await write(RUN_B, [rollup(P, E1, RUN_B, 9)], { append: true, finalize: false });
    await pg.exec("DELETE FROM _test_flags");
    expect(await rowsOf(P)).toEqual([{ entity_id: E1, run_id: RUN_B, choice_count: 9 }]);
    expect(await rowsOf(Q)).toEqual([{ entity_id: E2, run_id: RUN_A, choice_count: 7 }]);
  });
});

describe("날짜 — 롤업 measured_at 은 job measured_at(마지막 writer), run 앵커로 치환하지 않는다", () => {
  const ANCHOR_0914 = "2026-09-13T15:00:00.000Z"; // 같은 회차 앵커를 공유하는 두 run
  const PROMPT = "99999999-0000-4000-8000-000000000001";
  const P_SCHED = "adde83ef-0000-4000-8000-0000000000d1"; // scheduled run 의 prompt_run
  const P_MANUAL = "adde83ef-0000-4000-8000-0000000000d2"; // 같은 회차 manual 대량 run 의 prompt_run
  const RUN_C = "cccccccc-0000-4000-8000-000000000003";
  const LATEST = `SELECT DISTINCT ON (x.prompt_id, x.target, x.region) x.prompt_run_id
    FROM (SELECT DISTINCT prompt_run_id, run_id, prompt_id, target, region, measured_at FROM scope_acr_rollups) x
    ORDER BY x.prompt_id, x.target, x.region, x.measured_at DESC`;

  it("★ 같은 셀·같은 앵커의 prompt_run 2개 — 쓰기 순서와 무관하게 measured_at 이 늦은 쪽이 최신으로 결정된다", async () => {
    for (const order of [["sched", "manual"], ["manual", "sched"]] as const) {
      await pg.exec("TRUNCATE scope_acr_rollups, scope_runs");
      for (const which of order) {
        if (which === "sched") await write(RUN_A, [rollup(P_SCHED, E1, RUN_A, 3, "2026-09-14T02:00:00Z", PROMPT)], {}, ANCHOR_0914);
        else await write(RUN_C, [rollup(P_MANUAL, E1, RUN_C, 5, "2026-09-15T08:30:00Z", PROMPT)], {}, ANCHOR_0914);
      }
      // 앵커가 있어도 롤업 날짜는 job 측정 시각 그대로 — 동률이 생기지 않는다.
      expect(await measuredAtOf(P_SCHED)).toEqual(["2026-09-14T02:00:00.000Z"]);
      expect(await measuredAtOf(P_MANUAL)).toEqual(["2026-09-15T08:30:00.000Z"]);
      expect((await pg.query<{ prompt_run_id: string }>(LATEST)).rows.map((r) => r.prompt_run_id)).toEqual([P_MANUAL]);
    }
  });

  it("알려진 한계(고정): 여러 run 에 걸친 prompt_run 은 마지막 writer 의 job 시각을 갖는다", async () => {
    const ORIG = "2026-09-20T23:21:00.000Z";
    const RETRY = "2026-09-21T12:47:00.000Z";
    await write(RUN_A, [rollup(P, E1, RUN_A, 3, ORIG)]);
    await write(RUN_B, [rollup(P, E1, RUN_B, 4, RETRY)]);
    expect(await measuredAtOf(P)).toEqual([RETRY]);
    await write(RUN_A, [rollup(P, E1, RUN_A, 3, ORIG)]); // 원 run 재싱크 → 원 시각으로 복귀(래칫 없음)
    expect(await measuredAtOf(P)).toEqual([ORIG]);
  });
});

describe("A4 대량 경로 verify — run_id 가 아니라 계획의 prompt_run 집합으로 대조", () => {
  const R = "aaaaaaaa-0000-4000-8000-000000000001";
  const pr = (i: number) => `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const ent = (i: number) => `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const plan = (prs: string[], per: number) => prs.flatMap((p) => Array.from({ length: per }, (_, e) => rollup(p, ent(e), R, 1)));

  /** bulk-run.ts 의 acr 스텝 모양: 25 prompt_run 슬라이스, append:true, finalize:false. */
  async function bulkAcrSteps(rows: MirrorAcrRollup[]) {
    const byPr = [...new Set(rows.map((r) => r.promptRunId))];
    for (let i = 0; i < byPr.length; i += 25) {
      const slice = new Set(byPr.slice(i, i + 25));
      await write(R, rows.filter((r) => slice.has(r.promptRunId)), { append: true, finalize: false });
    }
  }
  async function verify(state: Partial<BulkRunState>) {
    await db.transaction(async (tx) => {
      // postgres.js 모양(execute → 행 배열)으로 맞춘다. drizzle-pglite 는 {rows} 를 준다.
      const pgjsLike = { execute: async (q: unknown) => ((await tx.execute(q as never)) as unknown as { rows: unknown[] }).rows };
      await verifyBulkRows(pgjsLike as unknown as ScopeMirrorProgressTx, R, { selected: [], ...state } as BulkRunState, CAPS);
    });
  }

  it("★ R 의 ACR 스텝 뒤·verify 전에 다른 run 이 같은 prompt_run 을 가져가도 verify 통과", async () => {
    const prs = Array.from({ length: 30 }, (_, i) => pr(i));
    const rows = plan(prs, 2);
    await write(R, [], { append: false, finalize: false });
    await bulkAcrSteps(rows);
    // 일반 크론이 manual 재측정 run B 를 싱크 — prs[3] 을 가져가고 엔티티 수도 바뀌었다.
    await write(RUN_B, [rollup(prs[3], ent(0), RUN_B, 2), rollup(prs[3], ent(1), RUN_B, 2), rollup(prs[3], ent(2), RUN_B, 2)]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(verify({ expectedAcrRows: rows.length, expectedAcr: expectedAcrByPromptRun(rows) })).resolves.toBeUndefined();
    // 관측: 존재만 확인한 prompt_run 수가 로그에 남는다.
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1 ACR prompt_run(s) owned by other runs"));
    info.mockRestore();
  });

  it("verify 실패 메시지에 다른 run 소유(존재만 확인) prompt_run 수가 남는다", async () => {
    const prs = Array.from({ length: 3 }, (_, i) => pr(i));
    const rows = plan(prs, 2);
    await bulkAcrSteps(rows.filter((r) => r.promptRunId !== prs[2])); // prs[2] 누락
    await write(RUN_B, [rollup(prs[0], ent(0), RUN_B, 2)]); // prs[0] 은 B 가 가져감
    await expect(verify({ expectedAcrRows: rows.length, expectedAcr: expectedAcrByPromptRun(rows) }))
      .rejects.toMatchObject({ name: "BulkVerifyAcrMismatch", message: expect.stringContaining("mismatches=1 foreign_owned=1") });
  });

  it("계획한 prompt_run 이 통째로 없거나, R 소유 prompt_run 의 엔티티 수가 틀리면 BulkVerifyAcrMismatch", async () => {
    const prs = Array.from({ length: 3 }, (_, i) => pr(i));
    const rows = plan(prs, 2);
    await bulkAcrSteps(rows.filter((r) => r.promptRunId !== prs[2])); // prs[2] 누락
    const err = await verify({ expectedAcrRows: rows.length, expectedAcr: expectedAcrByPromptRun(rows) }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BulkVerifyAcrMismatch");
    expect(err.message).toContain("Bulk mirror verification failed");

    await pg.exec("TRUNCATE scope_acr_rollups");
    await bulkAcrSteps(rows.filter((r) => !(r.promptRunId === prs[1] && r.entityId === ent(1)))); // R 소유인데 1행 부족
    await expect(verify({ expectedAcrRows: rows.length, expectedAcr: expectedAcrByPromptRun(rows) }))
      .rejects.toMatchObject({ name: "BulkVerifyAcrMismatch" });
  });

  it("R 소유 행이 계획 밖 prompt_run 에 있으면 BulkVerifyAcrMismatch", async () => {
    const rows = plan([pr(0)], 1);
    await bulkAcrSteps([...rows, rollup(pr(9), ent(0), R, 1)]);
    await expect(verify({ expectedAcrRows: 1, expectedAcr: expectedAcrByPromptRun(rows) }))
      .rejects.toMatchObject({ name: "BulkVerifyAcrMismatch" });
  });

  it("expectedAcr 없는 옛 체크포인트는 종전 run_id 행 수로 폴백하고, 답변 불일치는 BulkVerifyAnswerMismatch", async () => {
    const rows = plan([pr(0), pr(1)], 2);
    await bulkAcrSteps(rows);
    await expect(verify({ expectedAcrRows: 4 })).resolves.toBeUndefined();
    await expect(verify({ expectedAcrRows: 5 })).rejects.toMatchObject({ name: "BulkVerifyAcrMismatch" });
    await expect(verify({ expectedAcrRows: 4, selected: ["dddddddd-0000-4000-8000-000000000001"] }))
      .rejects.toMatchObject({ name: "BulkVerifyAnswerMismatch" });
  });
});
