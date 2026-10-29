// 뷰 앵커 전 회차 감추기 술어의 **행 의미** — 실 DB(read-only) 실행 검증. DATABASE_URL 이 있을 때만 돈다.
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.open-cycle-trend.int.test.ts
//
// 컴파일 텍스트 테스트(scope-aggregates.open-cycle-trend.test.ts)는 술어가 **어떤 행을
// 남기는지**를 못 본다. 여기서는 원장에서 회차를 골라 픽스처(VALUES)로 세우고 술어를
// 그대로 평가한다 — 쓰기는 없다.
//
// ⚠️ 핫픽스 A3(2026-09-10)로 판정 기준이 **상태에서 시간으로** 바뀌었다. 그래서 이 파일도
// `open` 을 뽑아 "제외되는가" 를 묻지 않는다 — 상태는 이제 폴백일 뿐이고, 같은 `open` 이라도
// 뷰 앵커가 지났으면 **노출돼야** 한다. 실제로 2026-09-10 대조 도중 글로벌 9/08 회차
// `9db294d8`(anchor 09-08 01:10Z)가 앵커+2일이 지난 뒤에도 `open` 이었다가 10:38:37Z 에
// published 로 전이했다 — 그 사이 A2 술어는 9/07 주 41,159건을 통째로 감추고 있었다.
//   · 지연 상수가 있는 표면(global·website): `COALESCE(view_anchor_at, anchor+지연) > now()`
//   · 상수가 없는 표면(project 등): 종전 `open` 폴백
//   · 어느 회차에도 미귀속: 유지(관제 반영 지연 ≤20분)
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { excludeHiddenCycleRuns } from "./scope-aggregates";
import { summaryLedgerAvailable } from "./summary-settings";
import { VIEW_ANCHOR_DELAY } from "@/lib/summary/generate/types";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

interface Pick {
  run_id: string;
  cycle_id: string;
  surface: string;
  status: string;
  viewable: boolean;
}

/**
 * 원장에서 조건에 맞는 (run, 회차) 한 쌍을 뽑는다. `viewable` 은 **DB 가 계산한 기대값**
 * 이다 — 술어와 같은 식을 여기서 다시 쓰면 자기 자신을 검증하는 꼴이라, 식은 상수에서
 * 만들되(표면 지연) 판정 자체는 서버 시각으로 맡긴다.
 */
async function pick(where: ReturnType<typeof sql>): Promise<Pick | null> {
  const branches = Object.entries(VIEW_ANCHOR_DELAY).map(
    ([surface, delay]) => sql`WHEN ${surface} THEN COALESCE(
        c.view_anchor_at, c.cycle_anchor_at + ${sql.raw(`interval '${delay}'`)}) <= now()`,
  );
  const rows = (await getDb().execute(sql`
    SELECT cr.run_id::text AS run_id, c.cycle_id::text AS cycle_id, c.surface, c.status,
           (CASE c.surface ${sql.join(branches, sql` `)} ELSE c.status <> 'open' END) AS viewable
      FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
     WHERE ${where}
     LIMIT 1`)) as unknown as Array<Pick>;
  return rows[0] ?? null;
}

async function keeps(runId: string): Promise<boolean> {
  const pred = await excludeHiddenCycleRuns(sql`a.run_id`, "citation");
  const rows = (await getDb().execute(sql`
    SELECT (${pred}) AS keep FROM (VALUES (${runId}::uuid)) AS a(run_id)
  `)) as unknown as Array<{ keep: boolean }>;
  return rows[0]!.keep;
}

const surfaceIn = sql.join(
  Object.keys(VIEW_ANCHOR_DELAY).map((s) => sql`${s}`),
  sql`, `,
);

d("뷰 앵커 전 회차 감추기 술어 (실 DB · 읽기 전용)", () => {
  it("지연 상수가 있는 표면: 뷰 앵커가 지났으면 상태와 무관하게 남긴다", async () => {
    expect(await summaryLedgerAvailable()).toBe(true); // 원장 미적용이면 검증 자체가 무의미
    const p = await pick(sql`c.surface IN (${surfaceIn})
      AND COALESCE(c.view_anchor_at, c.cycle_anchor_at) <= now() - interval '3 days'`);
    expect(p, "뷰 앵커가 지난 회차가 원장에 하나도 없다").toBeTruthy();
    expect(p!.viewable).toBe(true);
    expect(await keeps(p!.run_id), `${p!.surface}/${p!.status} ${p!.cycle_id}`).toBe(true);
  }, 60_000);

  it("지연 상수가 있는 표면: 뷰 앵커가 아직이면 상태와 무관하게 뺀다", async () => {
    const p = await pick(sql`c.surface IN (${surfaceIn}) AND c.view_anchor_at IS NULL
      AND c.cycle_anchor_at > now() - interval '12 hours'`);
    if (!p) {
      // 12시간 안에 열린 회차가 없는 시간대도 있다 — 없는 것은 실패가 아니다.
      console.log("[int] 뷰 앵커 이전 회차 없음 — 이 케이스는 건너뛴다");
      return;
    }
    expect(p.viewable).toBe(false);
    expect(await keeps(p.run_id), `${p.surface}/${p.status} ${p.cycle_id}`).toBe(false);
  }, 60_000);

  it("상수 없는 표면: `open` 이면 빼고 그 외는 남긴다(폴백)", async () => {
    for (const [status, keep] of [
      ["open", false],
      ["closed", true],
    ] as const) {
      const p = await pick(sql`c.surface NOT IN (${surfaceIn}) AND c.status = ${status}`);
      if (!p) {
        console.log(`[int] 상수 없는 표면의 ${status} 회차 없음 — 건너뛴다`);
        continue;
      }
      expect(await keeps(p.run_id), `${p.surface}/${status} ${p.cycle_id}`).toBe(keep);
    }
  }, 60_000);

  it("어느 회차에도 미귀속인 run 은 남긴다(관제 반영 지연)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT r.run_id::text AS run_id FROM scope_runs r
       WHERE NOT EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id = r.run_id)
       LIMIT 1`)) as unknown as Array<{ run_id: string }>;
    if (!rows[0]) {
      console.log("[int] 미귀속 run 없음 — 이 케이스는 건너뛴다");
      return;
    }
    expect(await keeps(rows[0].run_id)).toBe(true);
  }, 60_000);
});
