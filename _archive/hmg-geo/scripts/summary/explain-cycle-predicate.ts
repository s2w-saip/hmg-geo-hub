/**
 * 회차 술어 형태 A/B — **집계층 인덱스 오선택의 원인과 수리를 재는 하네스** (PR② T15/0067 조사).
 *
 * 무엇을 재나: S1 이 내는 집계층 3문장(own·brands·domains)을 두 형태로 EXPLAIN 한다.
 *   A 현행 — `(cycle_id, generation_id) IN (SELECT p.c, p.g FROM unnest($1,$2) AS p(c,g))`
 *   B 상수 — 회차가 1개일 때 그것을 `cycle_id = … AND generation_id = …` 로 편 형태
 *
 * 왜 이게 문제인가 (2026-09-10 라이브 실측, `summary_trend_brands` 136,930행):
 *   A 는 **세미조인**이라 플래너가 확장 통계(`st_summary_trend_*_cyc_gen`)를 **쓰지 않는다** —
 *   확장 통계는 단일 릴레이션 + 상수인 restriction clause 에만 적용된다. 그래서 선택도가
 *   단일 컬럼 ndistinct 의 곱(1/96 × 1/96)으로 붕괴하고, 추정이 `rows=6`(실제 85,961,
 *   **14,327배 과소**)이 된다. 그 추정 아래에서는 104 MB 짜리 `*_pkey`(19컬럼,
 *   `catalog_brands text[]`·`presence_set text[]` 포함)가 제일 싸 **보인다**.
 *   B 로 바꾸면 추정이 45,795 로 돌아오고 플래너가 seq scan 을 고른다.
 *
 * 산술 증거: 표 전체 136,930 ÷ (96 × 96) = 14.9 ≈ A 의 pair-only 추정 15.
 *            확장 통계가 쓰였다면 136,930 ÷ 96 = 1,426 이었을 것이다. 15 이지 1,426 이 아니다.
 *
 * 이 스크립트는 **쓰기를 하지 않는다**(EXPLAIN 과 읽기뿐). 리더를 고친 뒤 A ≈ B 가 되면
 * 수리가 끝난 것이다 — T4 의 회귀 게이트로 쓰라.
 *
 * 사용:
 *   bash (내부 작업 파일) <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-cycle-predicate.ts
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { S1_STATEMENT_KEYS, S1_TREND_AXES, S1_TREND_LIMITS } from "@/lib/db/repositories/summary-global-aggregates";
import { buildTrendStatements } from "@/lib/db/repositories/summary-trend-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const dialect = new PgDialect();
const log = console.log; // eslint-disable-line no-console

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `ARRAY[${v.map(lit).join(",")}]`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const inline = (q: { sql: string; params: unknown[] }): string =>
  q.sql.replace(/\$(\d+)/g, (_m, n) => lit(q.params[Number(n) - 1]));

async function explain(label: string, text: string) {
  const rows = (await getDb().execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${text}`))) as unknown as Array<Record<string, string>>;
  const lines = rows.map((r) => Object.values(r)[0] ?? "");
  const t = lines.join("\n");
  const scan = lines.find((l) => /Index (Only )?Scan|Seq Scan|Bitmap Heap/.test(l))?.trim() ?? "?";
  const idx = scan.match(/using (\S+)/)?.[1] ?? (scan.includes("Seq Scan") ? "SEQ" : "?");
  const est = scan.match(/rows=(\d+)/)?.[1], act = scan.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/)?.[1];
  const ms = Number(t.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 0);
  const buf = t.match(/shared hit=(\d+)/)?.[1];
  log(`   ${label.padEnd(26)} idx=${idx.padEnd(28)} est=${String(est).padStart(7)} act=${String(act).padStart(7)} ${ms.toFixed(1).padStart(7)}ms buf=${buf}`);
  return ms;
}

/** `--website` = 함대 회차 전부(N개) — 기간 모드의 `ANY × ANY` 형태를 재는 경로. */
const WEBSITE = process.argv.includes("--website");

async function main() {
  const surface = WEBSITE ? "website" : "global";
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = ${surface} AND active_generation_id IS NOT NULL
      AND view_anchor_at IS NOT NULL
    ORDER BY cycle_anchor_at DESC ${WEBSITE ? sql`` : sql`LIMIT 1`}`)) as unknown as Array<Record<string, string>>;
  const r = rows[0];
  const set: CycleSet = {
    surface, mode: WEBSITE ? "period" : "snapshot",
    cycles: rows.map((x) => ({ cycleId: x.cycle_id, generationId: x.generation_id, projectId: x.project_id,
                               cycleAnchorAt: x.cycle_anchor_at, cycleWeek: x.cycle_week })),
    cycleKey: rows.map((x) => `${x.cycle_id}:${x.generation_id}`).sort().join(","),
    projectIds: [...new Set(rows.map((x) => x.project_id))], missingProjectIds: [],
    weeks: [...new Set(rows.map((x) => x.cycle_week))].sort(),
    anchorCount: new Set(rows.map((x) => x.cycle_anchor_at.slice(0, 10))).size,
  };
  const stmts = buildTrendStatements(
    { set, filters: {}, ownVariant: OWN_VARIANT_ALL, ownedBasePrefixes: globalBaseUniverse(),
      limits: S1_TREND_LIMITS, axes: S1_TREND_AXES },
    { only: S1_STATEMENT_KEYS },
  );

  // ── 방향 자동 판정 ─────────────────────────────────────────────────────────
  // 라운드 4 이전: 리더가 세미조인을 냈다 → 정방향(A=현행 세미조인 → B=상수 등치).
  // 라운드 4 이후: 리더가 이미 상수 등치를 낸다 → **역방향**으로 세미조인을 복원해
  //                A(옛 형태) vs B(현행)를 같은 자리에서 비교한다. 회귀 게이트다.
  const FWD = /\(cycle_id, generation_id\)\s+IN\s+\(\s*SELECT p\.c, p\.g FROM unnest\(\s*(ARRAY\[[^\]]*\]::uuid\[\]),\s*(ARRAY\[[^\]]*\]::uuid\[\])\s*\) AS p\(c, g\)\s*\)/i;
  const REV = /cycle_id = ('[0-9a-f-]+')::uuid and generation_id = ('[0-9a-f-]+')::uuid/i;
  // 기간 모드(회차 N개)의 형태 — `ANY × ANY`. 두 배열을 그대로 unnest 쌍으로 되돌린다.
  const REV_N = /cycle_id = ANY\((ARRAY\[[^\]]*\]::uuid\[\])\) and generation_id = ANY\((ARRAY\[[^\]]*\]::uuid\[\])\)/i;

  const texts = stmts.map((s) => ({ key: s.key, table: s.table, text: inline(dialect.sqlToQuery(s.sql)) }));
  const isFixed = texts.every((t) => REV.test(t.text) || REV_N.test(t.text));
  const toSemi = (text: string) =>
    REV_N.test(text)
      ? text.replace(
          REV_N,
          (_m, c: string, g: string) =>
            `(cycle_id, generation_id) IN (SELECT p.c, p.g FROM unnest(${c}, ${g}) AS p(c, g))`,
        )
      : text.replace(
          REV,
          (_m, c: string, g: string) =>
            `(cycle_id, generation_id) IN (SELECT p.c, p.g FROM unnest(ARRAY[${c}]::uuid[], ARRAY[${g}]::uuid[]) AS p(c, g))`,
        );
  const toConst = (text: string) => {
    const m = text.match(FWD);
    return m ? text.replace(FWD, `cycle_id = (${m[1]})[1] and generation_id = (${m[2]})[1]`) : null;
  };

  let a = 0, b = 0;
  log(`표면 ${surface} · 회차 ${set.cycles.length}개 · 대표 ${r.cycle_id} · 리더 현재 형태 = ${isFixed ? "상수 등치(수리됨)" : "unnest 세미조인(수리 전)"}`);

  log(`\n══ A 세미조인 (수리 전 형태) ══`);
  for (const t of texts) {
    const text = isFixed ? toSemi(t.text) : t.text;
    a += await explain(`${t.key} (${t.table})`, text);
  }
  log(`   ── 합 ${a.toFixed(1)} ms\n\n══ B 상수 등치 (수리 후 = 리더 현재) ══`);
  for (const t of texts) {
    const text = isFixed ? t.text : toConst(t.text);
    if (!text) { log(`   ${t.key}: 패턴 불일치 — 건너뜀`); continue; }
    b += await explain(`${t.key} (${t.table})`, text);
  }
  log(`   ── 합 ${b.toFixed(1)} ms   →  A/B ${(a / b).toFixed(2)}배`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
