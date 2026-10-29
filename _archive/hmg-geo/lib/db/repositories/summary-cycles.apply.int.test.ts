// 회차 관제 **쓰기 경로**의 행동 검증 — 실 DB, 그러나 **절대 커밋하지 않는다**.
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-cycles.apply.int.test.ts
//
// 왜 필요한가 (T16 검증 D3, 2026-09-10): 형태 테스트는 "ON CONFLICT 가 문자열에 있다"
// 까지만 증명한다. **다섯 문장이 한 tx 에서 순서대로 돌 때 두 번째 패스가 0행을 쓴다**는
// 것은 다른 명제다(특히 카운터·fleet 의 IS DISTINCT FROM 가드와 CTE 간 스냅샷 상호작용).
// `late` + `stale_since` 경로는 현 데이터가 late=0 이라 드라이런으로도 볼 수 없다.
//
// 안전장치 3겹 — 이 파일은 **프로덕션 DB 에 postgres 롤로** 붙는다:
//   ① 모든 쓰기는 하나의 트랜잭션 안에서만 일어난다.
//   ② 트랜잭션은 마지막에 **반드시 throw** 해서 롤백된다(성공 경로에도 throw 한다).
//   ③ 롤백 뒤 원장 행수를 다시 세어 **시작값과 같은지 단언**한다. 커밋됐다면 여기서 깨진다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { applyCycleControl, readCycleControlPlan } from "./summary-cycles";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";
const NOW = new Date("2026-09-09T16:34:39.180Z"); // 드라이런 표와 같은 기준 시각
const OPTS = { now: NOW, rootProjectId: ROOT, recheckWindowDays: 3, statementTimeoutMs: 60_000 };

/** 이 값으로 던져야만 "의도된 롤백" 이다. 다른 예외는 그대로 터뜨린다. */
const ROLLBACK = Symbol("intentional-rollback");

interface Counts {
  cycles: number;
  cycleRuns: number;
  open: number;
  dupRunIds: number;
}

async function counts(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): Promise<Counts> {
  const rows = (await tx.execute(sql`
    SELECT (SELECT count(*)::int FROM summary_cycles)                       AS cycles,
           (SELECT count(*)::int FROM summary_cycle_runs)                   AS cycle_runs,
           (SELECT count(*)::int FROM summary_cycles WHERE status = 'open') AS open,
           (SELECT count(*)::int FROM (
              SELECT run_id FROM summary_cycle_runs GROUP BY run_id HAVING count(*) > 1
            ) x)                                                            AS dup_run_ids
  `)) as unknown as Array<{ cycles: number; cycle_runs: number; open: number; dup_run_ids: number }>;
  const r = rows[0];
  return {
    cycles: Number(r.cycles), cycleRuns: Number(r.cycle_runs),
    open: Number(r.open), dupRunIds: Number(r.dup_run_ids),
  };
}

/** 트랜잭션을 열어 body 를 돌리고 **무조건 롤백**한다. body 의 반환값은 그대로 돌려준다. */
async function inRolledBackTx<T>(
  body: (tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      out = await body(tx);
      throw ROLLBACK; // ← 성공 경로에도 반드시 던진다
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
}

d("applyCycleControl — 쓰기 경로 (트랜잭션 내 적용 후 강제 롤백)", () => {
  it(
    "1회 적용이 드라이런 표와 일치하고, 2회째는 쓰기 0이며, 롤백된다",
    async () => {
      const before = await counts(getDb());
      // 드라이런(읽기 전용)이 예고한 값 — 같은 기준 시각으로 뽑는다.
      const plan = await readCycleControlPlan(OPTS);
      const expectOpened = plan.open.length;
      const expectAttributed =
        plan.attribution.scope + plan.attribution.derived + plan.attribution.late;
      const expectClosed = plan.close.filter((r) => !r.blockedBy).length;

      const seen = await inRolledBackTx(async (tx) => {
        const first = await applyCycleControl(OPTS, tx);
        const afterFirst = await counts(tx);
        // 같은 tx 에서 곧바로 두 번째 패스 — 멱등이면 전부 0이다.
        const second = await applyCycleControl(OPTS, tx);
        const afterSecond = await counts(tx);
        return { first, afterFirst, second, afterSecond };
      });

      // ① 드라이런 표와 일치
      expect(seen.first.opened).toBe(expectOpened);
      expect(seen.first.attributed).toBe(expectAttributed);
      expect(seen.first.closed).toBe(expectClosed);
      // 행수 증가분도 같은 수여야 한다(RETURNING 개수와 실제 삽입의 일치).
      expect(seen.afterFirst.cycles - before.cycles).toBe(expectOpened);
      expect(seen.afterFirst.cycleRuns - before.cycleRuns).toBe(expectAttributed);

      // ③ UNIQUE(run_id) 위반 0
      expect(seen.afterFirst.dupRunIds).toBe(0);
      expect(seen.afterSecond.dupRunIds).toBe(0);

      // ② 2회째는 다섯 문장 전부 0행 — 여기가 형태 단언이 증명하지 못하던 지점이다
      expect(seen.second).toEqual({
        opened: 0, attributed: 0, late: 0, staleMarked: 0,
        countersUpdated: 0, closed: 0, fleetChanged: 0,
      });
      expect(seen.afterSecond).toEqual(seen.afterFirst);

      // 롤백 실증 — 커밋됐다면 이 단언이 깨진다.
      const after = await counts(getDb());
      expect(after).toEqual(before);
    },
    180_000,
  );

  it(
    "종결 회차에 늦게 온 run 은 late 로 붙고 stale_since 가 한 번만 찍힌다",
    async () => {
      const before = await counts(getDb());
      const seen = await inRolledBackTx(async (tx) => {
        await applyCycleControl(OPTS, tx);
        // 방금 닫힌 회차 하나를 고른다.
        const closed = (await tx.execute(sql`
          SELECT cycle_id::text AS cycle_id, project_id::text AS project_id,
                 to_char(cycle_anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS anchor
          FROM summary_cycles
          WHERE status = 'closed' AND closed_at = ${NOW.toISOString()}::timestamptz
          ORDER BY cycle_anchor_at LIMIT 1
        `)) as unknown as Array<{ cycle_id: string; project_id: string; anchor: string }>;
        const c = closed[0];
        if (!c) return null;

        // 그 회차 anchor 를 단 run 이 **뒤늦게** 미러에 도착한 상황을 만든다.
        // 미러 쓰기지만 이 tx 는 반드시 롤백된다(P5 는 런타임 모듈의 계약이고,
        // 여기는 롤백이 보장된 테스트 픽스처다).
        const runId = "dddddddd-0000-0000-0000-0000000000ff";
        await tx.execute(sql`
          INSERT INTO scope_runs (run_id, project_id, status, started_at, cycle_anchor_at, synced_at)
          VALUES (${runId}::uuid, ${c.project_id}::uuid, 'completed',
                  ${NOW.toISOString()}::timestamptz, ${c.anchor}::timestamptz,
                  ${NOW.toISOString()}::timestamptz)
        `);
        const late1 = await applyCycleControl(OPTS, tx);
        const row1 = (await tx.execute(sql`
          SELECT cr.attributed_by, c.stale_since
          FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
          WHERE cr.run_id = ${runId}::uuid
        `)) as unknown as Array<{ attributed_by: string; stale_since: Date | null }>;
        // 한 번 더 — stale_since 는 덮어쓰지 않는다(멱등).
        const late2 = await applyCycleControl(OPTS, tx);
        return { late1, late2, row: row1[0], cycleId: c.cycle_id };
      });

      expect(seen, "닫힌 회차가 없어 late 경로를 못 만들었다").not.toBeNull();
      expect(seen!.late1.attributed).toBe(1);
      expect(seen!.late1.late).toBe(1);
      expect(seen!.late1.staleMarked).toBe(1);
      expect(seen!.row.attributed_by).toBe("late");
      expect(seen!.row.stale_since).not.toBeNull();
      // 두 번째 패스는 아무것도 더 하지 않는다.
      expect(seen!.late2.attributed).toBe(0);
      expect(seen!.late2.staleMarked).toBe(0);

      const after = await counts(getDb());
      expect(after).toEqual(before);
    },
    180_000,
  );

  it(
    "maxAttributions 상한을 넘겨도 멤버 0 회차가 생기지 않는다 (D1 회귀)",
    async () => {
      const before = await counts(getDb());
      const seen = await inRolledBackTx(async (tx) => {
        const r = await applyCycleControl({ ...OPTS, maxAttributions: 1 }, tx);
        // 이번 패스에 열린 회차마다 멤버가 최소 1개여야 한다.
        const orphan = (await tx.execute(sql`
          SELECT count(*)::int AS n
          FROM summary_cycles c
          WHERE c.anchor_source = 'scope'
            AND NOT EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.cycle_id = c.cycle_id)
        `)) as unknown as Array<{ n: number }>;
        // 모수가 NULL 인 채 닫힌 회차도 0이어야 한다.
        const nullClosed = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM summary_cycles
          WHERE status = 'closed' AND closed_at = ${NOW.toISOString()}::timestamptz
            AND expected_units IS NULL
        `)) as unknown as Array<{ n: number }>;
        return { r, orphan: Number(orphan[0].n), nullClosed: Number(nullClosed[0].n) };
      });

      // 상한 1 → 회차도 1개만 열린다(종전에는 19개 전부 열려 18개가 멤버 0이었다).
      expect(seen.r.opened).toBe(1);
      expect(seen.r.attributed).toBe(1);
      expect(seen.orphan).toBe(0);
      expect(seen.nullClosed).toBe(0);

      const after = await counts(getDb());
      expect(after).toEqual(before);
    },
    180_000,
  );
});
