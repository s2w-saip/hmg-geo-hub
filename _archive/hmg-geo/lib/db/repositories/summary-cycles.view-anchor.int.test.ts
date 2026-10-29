// 뷰 앵커 게이트 **V-2** — 실 DB, 그러나 **절대 커밋하지 않는다** (PR② T14).
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-cycles.view-anchor.int.test.ts
//
// 왜 실 DB 인가: 형태 테스트는 "`view_anchor_at <= now()` 라는 문자열이 있다" 까지만
// 증명한다. **노출일이 아직 안 된 회차가 실제로 픽에서 빠지고 직전 회차가 대신 나온다**
// 는 것은 다른 명제다 — `now()` 는 서버가 계산하고, 픽 문장은 부분 인덱스
// (`summary_cycles_pick_idx … WHERE view_anchor_at IS NOT NULL`)를 타며, 웹사이트 경로는
// 주 선택(`wk`)과 본 조회 **두 곳**에서 같은 술어를 봐야 공집합이 안 난다.
//
// 안전장치 3겹 — 이 파일은 **프로덕션 DB 에 postgres 롤로** 붙는다
// (`summary-cycles.apply.int.test.ts` 와 같은 패턴):
//   ① 모든 쓰기는 하나의 트랜잭션 안에서만 일어난다.
//   ② 트랜잭션은 마지막에 **반드시 throw** 해서 롤백된다(성공 경로에도 throw 한다).
//   ③ 롤백 뒤 원장 행수·픽 결과를 다시 읽어 **시작값과 같은지 단언**한다.
//      커밋됐다면 여기서 깨진다.
//
// 픽 함수는 `@/lib/db` 의 풀에서 **자기 커넥션**을 잡으므로, 그냥 tx 를 열면 주입 행이
// 보이지 않는다(다른 커넥션 = 미커밋 불가시). 그래서 `getDb()` 를 갈아 끼워 픽이
// **그 tx 안에서** 자기 SQL 을 그대로 발행하게 한다 — 재구현이 아니라 배포되는 문장이다.
import { describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type Exec = (q: SQL) => Promise<unknown>;

const holder = vi.hoisted(() => ({ exec: null as Exec | null }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: (q: SQL) => {
      if (!holder.exec) throw new Error("executor 미설정 — tx 밖에서 픽을 부르지 않는다");
      return holder.exec(q);
    },
  }),
}));

const { pickGlobalCycle, pickWebsiteCycles, pickCyclesInRange } = await import("./summary-cycles");
const { judgeCycleRange } = await import("@/lib/summary/read/cycle-set");

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";

/** 이 값으로 던져야만 "의도된 롤백" 이다. 다른 예외는 그대로 터뜨린다. */
const ROLLBACK = Symbol("intentional-rollback");

const db = hasDb
  ? drizzle(postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false }))
  : null;

/** tx 를 열어 body 를 돌리고 **무조건 롤백**한다. body 동안 픽은 그 tx 를 본다. */
async function inRolledBackTx<T>(body: (tx: { execute: Exec }) => Promise<T>): Promise<T> {
  let out: T | undefined;
  const prev = holder.exec;
  try {
    await (db as NonNullable<typeof db>).transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
      holder.exec = (q) => tx.execute(q);
      out = await body({ execute: (q) => tx.execute(q) });
      throw ROLLBACK; // ← 성공 경로에도 반드시 던진다
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  } finally {
    holder.exec = prev;
  }
  return out as T;
}

/** tx 밖(읽기 전용) 실행 — 롤백 확인용. */
async function outside<T>(body: () => Promise<T>): Promise<T> {
  const prev = holder.exec;
  holder.exec = (q) => (db as NonNullable<typeof db>).execute(q);
  try {
    return await body();
  } finally {
    holder.exec = prev;
  }
}

async function cycleCount(ex: { execute: Exec }): Promise<number> {
  const rows = (await ex.execute(
    sql`SELECT count(*)::int AS n FROM summary_cycles`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n);
}

d("V-2 뷰 앵커 게이트 — 미래 앵커 회차 주입 후 강제 롤백", () => {
  it(
    "글로벌: 노출일 전 회차는 픽에서 빠지고 **직전 회차**가 그대로 나온다",
    async () => {
      const before = await outside(async () => ({
        count: await cycleCount({ execute: (q) => (db as NonNullable<typeof db>).execute(q) }),
        pick: await pickGlobalCycle(ROOT),
      }));
      expect(before.pick, "라이브 글로벌 회차가 있어야 이 테스트가 의미를 가진다").toBeTruthy();
      const baselineCycleId = before.pick?.cycleId as string;

      const seen = await inRolledBackTx(async (tx) => {
        // ① 직전 회차보다 **뒤에** 앵커된, 아직 노출일이 안 된 회차를 하나 주입한다.
        //    상태는 published + active_generation_id 존재 = 종전 술어로는 노출 가능.
        const ins = (await tx.execute(sql`
          INSERT INTO summary_cycles (
            surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status,
            fleet_visible, active_generation_id, view_anchor_at
          )
          SELECT 'global', ${ROOT}::uuid, c.cycle_anchor_at + interval '7 days',
                 (date_trunc('week', (c.cycle_anchor_at + interval '7 days') AT TIME ZONE 'UTC'))::date,
                 'operator', 'published', true, gen_random_uuid(), now() + interval '2 days'
          FROM summary_cycles c
          WHERE c.cycle_id = ${baselineCycleId}::uuid
          RETURNING cycle_id::text AS cycle_id
        `)) as unknown as Array<{ cycle_id: string }>;
        const injected = ins[0]?.cycle_id as string;

        const pickWhileEmbargoed = await pickGlobalCycle(ROOT);
        const range = await pickCyclesInRange({ surface: "global", projectIds: [ROOT] });

        // ② 같은 행의 노출일만 과거로 당긴다 — 게이트 말고는 아무것도 안 바뀐다.
        await tx.execute(sql`
          UPDATE summary_cycles SET view_anchor_at = now() - interval '1 minute'
          WHERE cycle_id = ${injected}::uuid
        `);
        const pickAfterRelease = await pickGlobalCycle(ROOT);

        return { injected, pickWhileEmbargoed, range, pickAfterRelease, count: await cycleCount(tx) };
      });

      // ③ 노출일 전 — 직전 회차가 그대로 나온다(D-1(2) 와 같은 경로).
      expect(seen.pickWhileEmbargoed?.cycleId).toBe(baselineCycleId);
      expect(seen.pickWhileEmbargoed?.cycleId).not.toBe(seen.injected);

      // ④ 범위 조회: 주입 회차는 renderable=false · pending=true 로 온다.
      expect(seen.range).not.toBeNull();
      const injectedRow = (seen.range ?? []).find((r) => r.cycleId === seen.injected);
      expect(injectedRow, "주입 회차는 범위에 걷혀 온다(노출 불가여도)").toBeTruthy();
      expect(injectedRow?.renderable).toBe(false);
      expect(injectedRow?.pending).toBe(true);

      // ⑤ 판정: 금족은 구멍이 아니다 → 폴백 없이 직전 회차만 집합에 남는다.
      const verdict = judgeCycleRange("global", [ROOT], seen.range ?? []);
      expect(verdict.ok, "pending 을 구멍으로 세면 여기서 폴백이 난다").toBe(true);
      if (verdict.ok) {
        expect(verdict.set.cycles.map((c) => c.cycleId)).not.toContain(seen.injected);
        expect(verdict.set.cycles.map((c) => c.cycleId)).toContain(baselineCycleId);
      }

      // ⑥ 노출일이 지나면 같은 행이 곧바로 픽된다 — 막고 있던 것은 게이트뿐이었다.
      expect(seen.pickAfterRelease?.cycleId).toBe(seen.injected);
      expect(seen.count).toBe(before.count + 1);

      // ⑦ 롤백 확인 — 행수·픽 모두 시작값.
      const after = await outside(async () => ({
        count: await cycleCount({ execute: (q) => (db as NonNullable<typeof db>).execute(q) }),
        pick: await pickGlobalCycle(ROOT),
      }));
      expect(after.count).toBe(before.count);
      expect(after.pick?.cycleId).toBe(baselineCycleId);
    },
    60_000,
  );

  it(
    "웹사이트: 노출일 전 **새 주** 회차가 `max(cycle_week)` 를 끌어가지 않는다",
    async () => {
      // 주 선택(`wk`)과 본 조회 중 한 쪽만 게이트를 걸면, wk 는 미래 주를 고르고
      // 본 조회는 그 주에서 아무것도 못 찾아 **함대 전체가 공집합**이 된다.
      const ids = await outside(async () => {
        const rows = (await (db as NonNullable<typeof db>).execute(sql`
          SELECT DISTINCT project_id::text AS id FROM summary_cycles WHERE surface = 'website'
        `)) as unknown as Array<{ id: string }>;
        return rows.map((r) => r.id);
      });
      expect(ids.length).toBeGreaterThan(0);
      const before = await outside(() => pickWebsiteCycles(ids));
      expect(before, "라이브 웹사이트 함대 회차가 있어야 의미를 가진다").not.toBeNull();
      const baseWeek = before?.cycles[0]?.cycleWeek as string;
      const baseCount = before?.cycles.length ?? 0;

      const seen = await inRolledBackTx(async (tx) => {
        const target = before?.cycles[0]?.projectId as string;
        await tx.execute(sql`
          INSERT INTO summary_cycles (
            surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status,
            fleet_visible, active_generation_id, view_anchor_at
          )
          SELECT 'website', ${target}::uuid, c.cycle_anchor_at + interval '7 days',
                 (c.cycle_week + 7)::date, 'operator', 'published', true,
                 gen_random_uuid(), now() + interval '1 day'
          FROM summary_cycles c
          WHERE c.project_id = ${target}::uuid AND c.cycle_week = ${baseWeek}::date
            AND c.surface = 'website' AND c.fleet_visible
          LIMIT 1
        `);
        return await pickWebsiteCycles(ids);
      });

      expect(seen, "주 선택이 미래 주로 끌려가면 여기서 null 또는 1건이 된다").not.toBeNull();
      expect(seen?.cycles.length).toBe(baseCount);
      for (const c of seen?.cycles ?? []) expect(c.cycleWeek).toBe(baseWeek);

      // 롤백 확인.
      const after = await outside(() => pickWebsiteCycles(ids));
      expect(after?.cycles.length).toBe(baseCount);
    },
    60_000,
  );
});
