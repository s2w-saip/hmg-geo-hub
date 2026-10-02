import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { CycleSet, CycleSetSurface } from "@/lib/summary/read/cycle-set";
import type { TrendStatementKey } from "./summary-trend-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 접힘 프로브 — "이 회차 집합이 집계층에 접혀 있는가" (표면 무관)
// ════════════════════════════════════════════════════════════════════════════
//
// 원래 웹사이트(T5)에만 있던 `websiteTrendFoldPresent` 를 표면 무관으로 올린 것이다.
// T11 기준 6 수리에서 글로벌 경로(S1·S3)도 같은 판정을 필요로 하게 됐다.
//
// ⚠️ 자리: 코디네이터 지시는 `lib/summary/read/` 였지만 **`lib/db/repositories/` 로 둔다** —
//    eslint `no-restricted-imports` 가 `@/lib/db`(raw 클라이언트) 임포트를 `lib/db/**`
//    밖에서 막는다(데이터 접근 choke point). `lib/summary/read/cycle-set.ts` 도 DB 를
//    직접 안 만지고 리포지터리를 부르는 같은 규율이다.
//
// ── 리더 `empty` 와 무엇이 다른가 ───────────────────────────────────────────
//
// 둘은 같은 사실을 **다른 시점**에 본다.
//   · 리더 `empty` = 읽고 **난 뒤**. 결과가 캐시 셀 안에서 만들어지므로, 그 자리에서
//     경로를 바꿔도 셀에는 이미 집계층 값이 들어간다.
//   · 이 프로브 = 읽기 **전**, 캐시 셀 **밖**. 경로 자체를 세부층으로 돌린다.
// 그래서 둘 다 유지한다 — 프로브가 1차, `empty` 가 2차 그물이다.
//
// ── 왜 `own` 만 보는가(기본값) ──────────────────────────────────────────────
//
// `summary_trend_own` 은 접기가 돌면 **변형당 반드시 행이 생긴다**(모수 행). 반면
// `brands`·`domains` 는 그 회차에 언급·인용이 0건이면 **정당하게 비어 있다** — 그것까지
// "접기 미실행" 으로 세면 조용한 오폴백이 된다.
//
// ⚠️ 초판은 "그 층은 리더 `empty`(`some` 판정)가 잡는다" 라고 적었는데 **지금은 그 층이
//    없다**(2026-09-11 검증 F5). R1 이후 리더 `empty` 는 **모수 표(own·answers)만** 보고,
//    출처 도넛처럼 `only:["domains"]` 로 읽는 경로는 모수 표를 발행하지 않아 신호 자체를
//    낼 수 없다. 즉 `brands`·`domains` 의 접힘은 **아무도 안 본다** — 그래도 되는 이유는
//    접기가 4표를 한 트랜잭션에서 쓰기 때문이다(`swapGeneration`). 그 원자성이 깨지면
//    이 프로브를 `tables` 로 넓히는 것이 첫 수단이고, 그래서 인자를 열어 뒀다.
//
// 문장은 **1개**다 — 표가 여럿이어도 `UNION ALL` 로 한 번에 센다.

const TABLE_OF: Record<TrendStatementKey, string> = {
  own: "summary_trend_own",
  answers: "summary_trend_answers",
  brands: "summary_trend_brands",
  domains: "summary_trend_domains",
};

/**
 * 이 회차 집합의 `(cycle_id, generation_id)` 쌍이 **전부** 집계층에 있는가.
 *
 * 부분 접힘(95개 중 30개만 접힘)을 잡는 것이 요점이다 — "하나라도 있으면 true" 로 세면
 * 나머지 프로젝트의 모수가 조용히 빠진 채 화면이 그려진다(2026-09-10 웹사이트 함대에서
 * 실제로 1/95 상태였다).
 */
export async function trendFoldPresent(
  surface: CycleSetSurface,
  set: CycleSet,
  tables: readonly TrendStatementKey[] = ["own"],
): Promise<boolean> {
  // ── 쌍은 **한 번만** 넘긴다 (PR⑤ U1, 2026-09-11) ───────────────────────────
  //
  // 판정의 분모(`pairs.size`)와 SQL 의 분모(`count(*) FROM p`)가 **같은 배열**에서
  // 나와야 한다. 종전 문장은 표 안에서 `SELECT DISTINCT` 로 접었으므로 요청 배열에
  // 중복이 있어도 상관없었지만, 아래 형태는 요청 쌍을 그대로 세므로 중복 하나가
  // 분모를 부풀려 **접혀 있는데 폴백**으로 오판한다. dedup 을 여기서 한다.
  const seen = new Set<string>();
  const uniq: typeof set.cycles = [];
  for (const c of set.cycles) {
    const k = `${c.cycleId}:${c.generationId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  const pairs = seen;
  if (pairs.size === 0 || tables.length === 0) return false;
  const cycleIds = sql`${sql.param(uniq.map((c) => c.cycleId))}::uuid[]`;
  const generationIds = sql`${sql.param(uniq.map((c) => c.generationId))}::uuid[]`;
  const pairRows = sql`unnest(${cycleIds}, ${generationIds}) AS p(c, g)`;
  // ── 왜 `EXISTS` 인가 — 스캔이 아니라 프로브다 (PR⑤ U1) ─────────────────────
  //
  // 종전 문장은 `SELECT DISTINCT cycle_id, generation_id … WHERE (cycle_id,
  // generation_id) IN (…)` 였다. PostgreSQL 에는 loose index scan(skip scan)이 없어서
  // "이 쌍이 있는가" 를 묻는데도 **그 쌍의 파티션 전체**를 인덱스로 훑어 distinct 값을
  // 만든다 — 프로덕션 실측(2026-09-11, 읽기 전용 세션, 회차 13쌍):
  //
  //   현행  Append rows=3  Buffers: shared hit=38,301  Execution 477.5 ms
  //         └ brands: Nested Loop rows=378,304  (Index Scan rows=29,100 × loops=13)
  //   새것  Append rows=3  Buffers: shared hit=   159  Execution   0.535 ms
  //         └ brands: Index Scan rows=1 × loops=13
  //
  // 인덱스는 **기존 것 그대로**다(`summary_trend_{own,brands,domains}_gen`) — DDL 없음.
  // 쌍이 618개(웹사이트 91일 전수)로 늘어도 EXISTS 가 더 싸다(13.9 → 5.0 ms 실측):
  // 쌍당 인덱스 프로브 1회라 선형이고 상수 계수가 작다.
  //
  // ⚠️ 판정 동치성: 종전 `n` = |{쌍 ∈ 요청집합 : 그 쌍의 행이 1개 이상}| (DISTINCT 가
  //   중복을 접으므로 정확히 이 뜻이다). 새 `n` = |{쌍 ∈ dedup(요청집합) : EXISTS}| —
  //   **같은 집합의 크기**다. 프로덕션 3세트 대조 실측(2026-09-11): 전부접힘 13쌍
  //   13/13 · 부분접힘 12쌍 9/9(양쪽 false 폴백) · website 618쌍 618/618, 판정 동일.
  const parts = tables.map(
    (k) => sql`
      SELECT ${k} AS tbl, count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ${sql.raw(TABLE_OF[k])} x
        WHERE x.cycle_id = p.c AND x.generation_id = p.g AND x.surface = ${surface}
      ))::int AS n
      FROM ${pairRows}`,
  );
  // ── 실패는 **던지지 않는다** — 게이트 프로브의 규약이다 (2026-09-10) ────────
  //
  // 이 프로브는 "집계층으로 갈 수 있는가"를 묻는 판정이고, 판정이 불가능하면 답은
  // **아니오**(= 폴백)여야 한다. 다른 게이트 프로브(`pickCyclesInRange`·`readEnabled`·
  // `summaryLedgerAvailable`·`websiteExcludedUnits`)는 전부 그 자세인데 이것만 던졌다.
  //
  // 던지면 화면이 폴백하는 게 아니라 **죽는다**: 호출부가 React `cache()` 셀이라
  // (`cachedWebsiteFoldPresent`·`cachedGlobalFoldPresent`) 거부된 프로미스가 그 요청 내내
  // 캐시되고, 그 셀을 기다리는 섹션이 통째로 에러 바운더리로 떨어진다. 아래 단계의
  // `.catch(() => [])` 로는 못 막는다 — 예외가 그보다 위에서 나기 때문이다.
  //
  // 조용히 넘기지도 않는다. 사유를 남긴다 — 프로브가 계속 실패하면 화면은 "느리지만
  // 정상"으로 보이고(세부층 값은 맞다) 로그만이 유일한 신호다.
  try {
    const rows = (await getDb().execute(
      sql.join(parts, sql` UNION ALL `),
    )) as unknown as Array<{ tbl: string; n: number }>;
    if (rows.length !== tables.length) return false;
    return rows.every((r) => Number(r.n ?? 0) === pairs.size);
  } catch (e) {
    console.warn(
      `[summary] trendFoldPresent(${surface}) 실패 — 집계층 폴백으로 처리한다:`,
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    return false;
  }
}
