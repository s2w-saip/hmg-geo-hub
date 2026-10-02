// 종결 사유 판정식의 **진리표** — 실 Postgres 에서 합성 행으로 돌린다(읽기 전용).
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-cycles.close-rule.int.test.ts
//
// 형태 테스트는 "가드가 SQL 에 있다" 까지만 본다. 여기서는 그 SQL 을 **Postgres 가
// 실제로 어떻게 평가하는지** 를 본다 — 라이브 데이터에 기대지 않고 allc·allmem 을
// VALUES 로 갈아 끼워 여섯 경우를 고정한다. 쓰기는 없다.
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { __testables, DEFAULT_COMPLETE_QUIET_HOURS } from "./summary-cycles";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const NOW = new Date("2026-09-10T12:00:00.000Z");
const iso = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const RECHECK_CUTOFF = iso(3 * 24);
const QUIET_CUTOFF = iso(DEFAULT_COMPLETE_QUIET_HOURS);

const P = (n: number) => `0000000${n}-0000-0000-0000-00000000000${n}`;
const A = "2026-09-08T00:00:00.000Z";
const A2 = "2026-09-08T06:00:00.000Z";

d("종결 사유 진리표 (실 DB · 합성 행)", () => {
  // 이 파일은 프로덕션 DB 에 postgres 롤로 붙는다(하네스가 그 URL 을 준다). 본문이
  // VALUES 뿐이라 지금은 읽기 전용이지만, **편집 한 줄이면 프로덕션 쓰기가 된다** —
  // 세션을 읽기 전용으로 못 박아 그 경로를 원천 차단한다(T16 검증 부수 지적 5-①).
  beforeAll(async () => {
    await getDb().execute(sql`SET default_transaction_read_only = on`);
  });

  it("여섯 경우가 설계대로 갈린다", async () => {
    const rows = (await getDb().execute(sql`
      WITH allc(cycle_id, project_id, anchor, status, expected, completed) AS (
        VALUES
          -- ① 100% · 마지막 run 10시간 전 = 정온 창(36h) 안이다 → 열어 둔다
          (NULL::uuid, ${P(1)}::uuid, ${A}::timestamptz, 'open'::text, 10::int, 10::int),
          -- ② 100% · 마지막 run 40시간 전 = 정온 창 밖(그러나 recheck 72h 안) → complete
          (NULL, ${P(2)}::uuid, ${A}::timestamptz, 'open', 10, 10),
          -- ③ 100% · 조용하지만 **다음 anchor 가 열렸다** → next_anchor 가 이긴다
          (NULL, ${P(3)}::uuid, ${A}::timestamptz, 'open', 10, 10),
          (NULL, ${P(3)}::uuid, ${A2}::timestamptz, 'open', 0, 0),
          -- ④ 50% · 회차 run 전부 4일 전 = 미러가 다시 안 당긴다 → recheck_window
          (NULL, ${P(4)}::uuid, ${A}::timestamptz, 'open', 10, 5),
          -- ⑤ 50% · run 이 최근(10시간 전) → 아무 사유도 아니다
          (NULL, ${P(5)}::uuid, ${A}::timestamptz, 'open', 10, 5),
          -- ⑥ 100% · 창 밖이지만 started_at 을 모르는 run 이 섞였다 → 닫지 않는다
          (NULL, ${P(6)}::uuid, ${A}::timestamptz, 'open', 10, 10)
      ),
      allmem(project_id, anchor, started_at) AS (
        VALUES
          (${P(1)}::uuid, ${A}::timestamptz, ${iso(10)}::timestamptz),
          (${P(2)}::uuid, ${A}::timestamptz, ${iso(40)}::timestamptz),
          (${P(3)}::uuid, ${A}::timestamptz, ${iso(40)}::timestamptz),
          (${P(3)}::uuid, ${A2}::timestamptz, ${iso(10)}::timestamptz),
          (${P(4)}::uuid, ${A}::timestamptz, ${iso(4 * 24)}::timestamptz),
          (${P(5)}::uuid, ${A}::timestamptz, ${iso(10)}::timestamptz),
          (${P(6)}::uuid, ${A}::timestamptz, ${iso(40)}::timestamptz),
          (${P(6)}::uuid, ${A}::timestamptz, NULL::timestamptz)
      )
      SELECT allc.project_id::text AS pid,
             to_char(allc.anchor AT TIME ZONE 'UTC', 'HH24') AS h,
             ${__testables.closeReasonExpr(RECHECK_CUTOFF, QUIET_CUTOFF)} AS reason
      FROM allc
      ORDER BY 1, 2
    `)) as unknown as Array<{ pid: string; h: string; reason: string | null }>;

    const at = (n: number, h = "00") =>
      rows.find((r) => r.pid === P(n) && r.h === h)?.reason ?? null;

    expect(at(1)).toBeNull(); // 정온 창 안 — 100% 여도 open 유지
    expect(at(2)).toBe("complete"); // 정온 창 밖
    expect(at(3)).toBe("next_anchor"); // (a) 가 (b) 보다 우선
    expect(at(4)).toBe("recheck_window");
    expect(at(5)).toBeNull();
    expect(at(6)).toBeNull(); // started_at 미상은 "모른다" → 닫지 않는다
  });

  it("정온 창 경계: 창 밖으로 1초만 나가면 complete 로 뒤집힌다", async () => {
    const probe = async (startedAt: string) => {
      const rows = (await getDb().execute(sql`
        WITH allc(cycle_id, project_id, anchor, status, expected, completed) AS (
          VALUES (NULL::uuid, ${P(1)}::uuid, ${A}::timestamptz, 'open'::text, 4::int, 4::int)
        ),
        allmem(project_id, anchor, started_at) AS (
          VALUES (${P(1)}::uuid, ${A}::timestamptz, ${startedAt}::timestamptz)
        )
        SELECT ${__testables.closeReasonExpr(RECHECK_CUTOFF, QUIET_CUTOFF)} AS reason FROM allc
      `)) as unknown as Array<{ reason: string | null }>;
      return rows[0]?.reason ?? null;
    };
    // 컷오프 정각은 `>=` 라 아직 "시끄럽다" 쪽이다.
    expect(await probe(QUIET_CUTOFF)).toBeNull();
    expect(await probe(new Date(Date.parse(QUIET_CUTOFF) - 1000).toISOString())).toBe("complete");
  });
});
