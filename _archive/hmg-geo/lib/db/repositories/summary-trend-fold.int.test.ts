// 접힘 프로브 — 실 DB(read-only) **판정 동치성** 검증. DATABASE_URL 이 있을 때만 돈다.
//   bash (내부 작업 파일) <repo> npx vitest run \
//     lib/db/repositories/summary-trend-fold.int.test.ts
//
// PR⑤ U1 은 이 프로브의 문장을 `SELECT DISTINCT cycle_id, generation_id`(파티션 전수
// 스캔)에서 **쌍당 `EXISTS`**(인덱스 프로브)로 바꾼다. 값이 아니라 boolean 하나를 내는
// 게이트라, 회귀는 화면이 죽는 것이 아니라 **조용히 폴백**하거나 **조용히 통과**하는
// 형태로 나타난다 — 둘 다 사람 눈에 "조금 느리다/조금 이상하다" 로만 보인다.
// 그래서 라이브 데이터로 **구 문장과 새 문장의 판정이 같은지**를 직접 대조한다.
//
// 격자는 프로덕션 실측(2026-09-11, 읽기 전용 세션)과 같은 3세트다:
//   A 전부 접힘  global  published 91일 전수      (실측 13쌍 → true)
//   B 부분 접힘  global  60일 · closed 섞음        (실측 12쌍 중 9 → **false**)
//   C 대량       website published 91일 전수      (실측 618쌍 → true)
// B 가 요점이다 — "하나라도 있으면 true" 로 느슨해지지 않았음을 라이브에서 확인한다.
//
// ⚠️ 이 파일은 **SELECT 만** 낸다(쓰기·DDL 0). 구 문장은 아래에 문자열로 박아 둔다 —
//    리포에서 사라진 형태를 대조 기준으로 삼아야 하기 때문이다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { trendFoldPresent } from "./summary-trend-fold";
import type { CycleSet, CycleSetSurface } from "@/lib/summary/read/cycle-set";
import type { TrendStatementKey } from "./summary-trend-aggregates";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const TABLE_OF: Record<TrendStatementKey, string> = {
  own: "summary_trend_own",
  answers: "summary_trend_answers",
  brands: "summary_trend_brands",
  domains: "summary_trend_domains",
};

type Pair = { cycleId: string; generationId: string };

const setOf = (surface: CycleSetSurface, pairs: Pair[]): CycleSet => ({
  surface,
  mode: "period",
  cycles: pairs.map((p) => ({
    ...p,
    projectId: "00000000-0000-0000-0000-000000000000",
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  })),
  cycleKey: `int-${surface}-${pairs.length}`,
  projectIds: [],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: pairs.length,
});

/**
 * **구 문장**(PR⑤ 이전) — 파티션 전수 스캔형. 대조 기준이므로 그대로 둔다.
 * 판정 규약도 종전 그대로 재현한다: 행 수가 표 수와 다르면 false, 전부 `pairs.size`
 * 여야 true.
 */
async function legacyFoldPresent(
  surface: CycleSetSurface,
  set: CycleSet,
  tables: readonly TrendStatementKey[],
): Promise<{ verdict: boolean; counts: Record<string, number> }> {
  const pairs = new Set(set.cycles.map((c) => `${c.cycleId}:${c.generationId}`));
  if (pairs.size === 0 || tables.length === 0) return { verdict: false, counts: {} };
  const cycleIds = sql`${sql.param(set.cycles.map((c) => c.cycleId))}::uuid[]`;
  const generationIds = sql`${sql.param(set.cycles.map((c) => c.generationId))}::uuid[]`;
  const parts = tables.map(
    (k) => sql`
      SELECT ${k} AS tbl, count(*)::int AS n FROM (
        SELECT DISTINCT cycle_id, generation_id FROM ${sql.raw(TABLE_OF[k])}
        WHERE surface = ${surface} AND (cycle_id, generation_id) IN (
          SELECT p.c, p.g FROM unnest(${cycleIds}, ${generationIds}) AS p(c, g)
        )
      ) t`,
  );
  const rows = (await getDb().execute(
    sql.join(parts, sql` UNION ALL `),
  )) as unknown as Array<{ tbl: string; n: number }>;
  const counts = Object.fromEntries(rows.map((r) => [r.tbl, Number(r.n ?? 0)]));
  return {
    verdict:
      rows.length === tables.length &&
      rows.every((r) => Number(r.n ?? 0) === pairs.size),
    counts,
  };
}

/** 라이브 회차에서 쌍을 뽑는다 — 읽기 전용. */
async function pairsFrom(where: ReturnType<typeof sql>): Promise<Pair[]> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id AS "cycleId",
           COALESCE(active_generation_id, '00000000-0000-0000-0000-000000000000'::uuid) AS "generationId"
    FROM summary_cycles ${where}
  `)) as unknown as Pair[];
  return rows.map((r) => ({ cycleId: String(r.cycleId), generationId: String(r.generationId) }));
}

const G3: TrendStatementKey[] = ["own", "domains", "brands"];

d("trendFoldPresent — 구/신 문장 판정 동치 (실 DB · read-only)", () => {
  it("A 전부 접힘 · global published 91일 — 구/신 판정 동일", async () => {
    const pairs = await pairsFrom(sql`
      WHERE surface = 'global' AND status = 'published'
        AND active_generation_id IS NOT NULL
        AND cycle_anchor_at >= now() - interval '91 days'`);
    if (pairs.length === 0) {
      console.log("[int] A: global published 회차 0 — 대조 생략(폴백 경로)");
      expect(await trendFoldPresent("global", setOf("global", pairs), G3)).toBe(false);
      return;
    }
    const legacy = await legacyFoldPresent("global", setOf("global", pairs), G3);
    const next = await trendFoldPresent("global", setOf("global", pairs), G3);
    console.log(
      `[int] A pairs=${pairs.length} legacy=${legacy.verdict} next=${next} counts=${JSON.stringify(legacy.counts)}`,
    );
    expect(next).toBe(legacy.verdict);
    // 전부 접힌 집합이면 true 여야 한다 — 이 세트가 오늘의 대시보드 경로다.
    expect(next).toBe(true);
  });

  it("B **부분 접힘** · global 60일(closed 섞음) — 구/신 둘 다 false(폴백)", async () => {
    const pairs = await pairsFrom(sql`
      WHERE surface = 'global' AND cycle_anchor_at >= now() - interval '60 days'`);
    if (pairs.length === 0) {
      console.log("[int] B: 60일 회차 0 — 대조 생략");
      return;
    }
    const legacy = await legacyFoldPresent("global", setOf("global", pairs), G3);
    const next = await trendFoldPresent("global", setOf("global", pairs), G3);
    console.log(
      `[int] B pairs=${pairs.length} legacy=${legacy.verdict} next=${next} counts=${JSON.stringify(legacy.counts)}`,
    );
    expect(next).toBe(legacy.verdict);
    // 접힌 쌍 수가 요청 쌍 수보다 적으면 **반드시** false 다 — "하나라도 있으면 true" 가
    // 아니라는 것이 이 프로브의 존재 이유다(2026-09-10 웹사이트 1/95).
    const folded = Math.max(...Object.values(legacy.counts), 0);
    if (folded < pairs.length) expect(next).toBe(false);
  });

  it("C 대량 · website published 91일(618쌍 규모) — 구/신 판정 동일", async () => {
    const pairs = await pairsFrom(sql`
      WHERE surface = 'website' AND status = 'published'
        AND active_generation_id IS NOT NULL
        AND cycle_anchor_at >= now() - interval '91 days'`);
    if (pairs.length === 0) {
      console.log("[int] C: website published 회차 0 — 대조 생략");
      return;
    }
    const legacy = await legacyFoldPresent("website", setOf("website", pairs), ["own"]);
    const next = await trendFoldPresent("website", setOf("website", pairs), ["own"]);
    console.log(
      `[int] C pairs=${pairs.length} legacy=${legacy.verdict} next=${next} counts=${JSON.stringify(legacy.counts)}`,
    );
    expect(next).toBe(legacy.verdict);
  });

  it("회차 0개 — DB 를 보지 않고 false", async () => {
    expect(await trendFoldPresent("global", setOf("global", []), G3)).toBe(false);
  });

  it("중복 쌍을 넣어도 판정이 뒤집히지 않는다(분모 부풀림 방어 · R1)", async () => {
    const pairs = await pairsFrom(sql`
      WHERE surface = 'global' AND status = 'published'
        AND active_generation_id IS NOT NULL
        AND cycle_anchor_at >= now() - interval '91 days'`);
    if (pairs.length === 0) return;
    const plain = await trendFoldPresent("global", setOf("global", pairs), G3);
    const doubled = await trendFoldPresent("global", setOf("global", [...pairs, ...pairs]), G3);
    console.log(`[int] dup pairs=${pairs.length}→${pairs.length * 2} plain=${plain} doubled=${doubled}`);
    expect(doubled).toBe(plain);
  });
});
