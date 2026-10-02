// `readMirrorAnswerMeta` 를 **drizzle 드라이버를 태워** 진짜 Postgres(pglite)에서 돌린다 (2026-09-28).
//
// 고치는 결함(프리뷰 드릴다운 500): 축을 켠 통합 프리뷰에서 Global > Mention "브랜드 언급
// 순위" 행을 펼치면 `/api/scope/brand-mention-prompts`·`/api/scope/brand-citations` 가
// `TypeError: a.measuredAt?.toISOString is not a function`(buildMirrorJobs) 로 죽었다.
//
// 원인: 축 on 분기는 raw `db.execute(sql…)` 로 `sa.measured_at` 을 그대로 싣는다. drizzle 의
// postgres-js 드라이버는 `construct()` 에서 timestamptz(1184) 등의 파서를 투명 파서로 덮어쓰고
// (`drizzle-orm/postgres-js/driver.js`), pglite 드라이버도 같은 일을 한다
// (`drizzle-orm/pglite/session.js` 의 `rawQueryConfig.parsers`). 그래서 raw execute 결과의
// timestamptz 는 **문자열**이다. `db.select()` 경로만 컬럼 `mapFromDriverValue` 로 Date 가 된다.
//
// 왜 기존 테스트가 못 잡았나: pglite 스모크(`answer-set.pglite.test.ts`)는 **드라이버를
// 거치지 않고** `PGlite.query` 로 문장을 직접 돌린다. PGlite 기본 파서는 timestamptz 를 Date
// 로 준다. 미러 투영 테스트(`mirror-projection.test.ts`)는 가짜 리더가 빈 배열만 돌려준다.
// 여기서는 리포지토리가 프로덕션에서 쓰는 것과 **같은 drizzle 매핑 계층**을 태운다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  resetAnchorAxisForTests,
  setAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import { newDb, type PgliteDb } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import type { ResolvedMention } from "@/lib/scope/types";

// 리포지토리 기본 리더(getDb)는 쓰지 않는다: 리더는 인자로 명시 주입한다.
vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("이 테스트는 getDb 를 쓰지 않는다: 리더를 인자로 넘긴다");
  },
}));

let raw: PgliteDb;
let drz: unknown;
let T: typeof import("./scope-aggregates").__testables;

const RUN = "22222222-2222-4222-8222-222222222222";
const J_US = "11111111-1111-4111-8111-111111111111"; // µs 가 붙은 값(절사 검증)
const J_ROUND = "11111111-1111-4111-8111-111111111112"; // .xxx999: 반올림이면 갈린다
const J_NULL = "11111111-1111-4111-8111-111111111113"; // measured_at NULL
const RUN_FILTER = sql`run_id = ${RUN}::uuid`;

beforeAll(async () => {
  raw = await newDb({ withV78: true });
  await raw.exec(`
    INSERT INTO scope_answers (job_id, run_id, status, measured_at, target, region, prompt_id)
    VALUES ('${J_US}'::uuid, '${RUN}'::uuid, 'completed', '2026-09-11T02:00:00.123456Z',
            'chatgpt', 'KR', '33333333-3333-4333-8333-333333333333'::uuid),
           ('${J_ROUND}'::uuid, '${RUN}'::uuid, 'completed', '2026-09-12T23:59:59.999999Z',
            'gemini', 'US', '33333333-3333-4333-8333-333333333333'::uuid),
           ('${J_NULL}'::uuid, '${RUN}'::uuid, 'completed', NULL,
            'chatgpt', 'KR', '33333333-3333-4333-8333-333333333333'::uuid)
  `);
  await raw.exec(`
    INSERT INTO scope_answer_cycle_anchors
      (job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week, anchor_month,
       round_date, measured_at_orig, is_default_engine, source)
    SELECT job_id, run_id, '44444444-4444-4444-8444-444444444444'::uuid, 'standard',
           '2026-09-11T02:00:00Z', DATE '2026-09-11', DATE '2026-09-07', DATE '2026-09-01',
           DATE '2026-09-11', COALESCE(measured_at, '2026-09-11T02:00:00Z'), true, 'ledger'
      FROM scope_answers
  `);
  const { drizzle } = await import("drizzle-orm/pglite");
  // 같은 인스턴스를 drizzle 로 감싼다: 프로덕션 리더와 같은 결과 매핑 계층.
  // pglite 드라이버의 `execute` 는 `{ rows }` 를 주고 postgres-js 는 행 배열(RowList)을
  // 준다. 리포지토리는 postgres-js 모양을 가정하므로 `rows` 만 벗겨 같은 모양으로 맞춘다.
  // 값 파싱은 건드리지 않는다: timestamptz 를 문자열로 두는 것은 drizzle 드라이버 자신이다.
  const d = drizzle(raw as never);
  drz = {
    select: d.select.bind(d),
    execute: async (q: Parameters<typeof d.execute>[0]) => (await d.execute(q)).rows,
  };
  T = (await import("./scope-aggregates")).__testables;
}, 180_000);

afterAll(async () => {
  resetAnchorAxisForTests();
  await raw?.close();
});

type Meta = Awaited<ReturnType<typeof T.readMirrorAnswerMeta>>;

async function readWith(axis: boolean): Promise<Meta> {
  setAnchorAxisForTests(axis);
  try {
    return await T.readMirrorAnswerMeta(RUN_FILTER, drz as never);
  } finally {
    resetAnchorAxisForTests();
  }
}

const iso = (rows: Meta) =>
  Object.fromEntries(
    rows.map((r) => [r.jobId, r.measuredAt === null ? null : r.measuredAt.toISOString()]),
  );

describe("readMirrorAnswerMeta: drizzle 드라이버 경유 measuredAt 계약(Date | null)", () => {
  it("축 on: measuredAt 이 Date 이거나 null 이다(문자열이 새지 않는다)", async () => {
    const rows = await readWith(true);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      if (r.measuredAt !== null) expect(r.measuredAt).toBeInstanceOf(Date);
    }
    expect(rows.find((r) => r.jobId === J_NULL)!.measuredAt).toBeNull();
  });

  it("축 on/off 의 measured_at ISO 가 ms 까지 같다(µs 는 절사, 반올림 아님)", async () => {
    const on = iso(await readWith(true));
    const off = iso(await readWith(false));
    expect(on).toEqual(off);
    // 손계산: .123456 → .123 · 23:59:59.999999 → .999(반올림이면 다음 날 00:00:00.000)
    expect(on[J_US]).toBe("2026-09-11T02:00:00.123Z");
    expect(on[J_ROUND]).toBe("2026-09-12T23:59:59.999Z");
    expect(on[J_NULL]).toBeNull();
  });

  it("축 on: buildMirrorJobs 가 던지지 않고 ISO 를 싣는다(프리뷰 500 의 그 호출)", async () => {
    const rows = await readWith(true);
    const jobs = T.buildMirrorJobs(rows, new Map<string, ResolvedMention[]>());
    const byId = Object.fromEntries(jobs.map((j) => [j.job_id, j]));
    expect(byId[J_US].measured_at).toBe("2026-09-11T02:00:00.123Z");
    expect(byId[J_NULL].measured_at).toBe("");
    // 축 필드도 함께 실린다(행이 축 on 모양이라는 증거).
    expect(byId[J_US].round_date).toBe("2026-09-11");
  });
});
