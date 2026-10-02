#!/usr/bin/env npx tsx
/**
 * 드리프트 대조 SQL 생성기 — DB 접속 없이 돌아간다.
 *
 *   npx tsx scripts/db/drift-sql.ts > /tmp/drift.sql     (= npm run db:drift-sql)
 *
 * `npm run db:drift` 는 introspect 로 실제 DB 를 뽑아 대조하지만, DATABASE_URL 이
 * 없는 환경(워크트리·CI·대시보드만 있는 경우)에서는 쓸 수 없다. 이 스크립트는
 * 같은 대조를 **SQL 한 덩어리**로 만들어 준다 — Supabase SQL Editor 에 붙여넣으면
 * 된다. 읽기 전용이고, 결과 0행이면 드리프트 없음.
 *
 * ── 왜 스냅샷이 아니라 schema.ts 인가 (2026-09-15) ──────────────────────────
 * 종전에는 `meta/` 의 **가장 최신 스냅샷**을 기준선으로 삼았다. 그런데 이 리포는
 * 0062 부터 마이그레이션을 손으로 쓰고 `db:generate` 를 돌리지 않아 스냅샷이
 * **0061 에서 멈춰 있다**(meta/_journal.json 도 같다). 즉 기준선이 조용히 낡는다 —
 * 0072(`scope_answer_stances`)를 적용하면 그 테이블이 통째로 `3_EXTRA_IN_DB` 로
 * 뜬다. "스키마가 정본"인데 기준선은 그 복사본의 옛 판본이었다.
 *
 * 그래서 **schema.ts 에서 직접** 읽는다. drizzle 테이블 객체의 `getSQLType()` 은
 * 스냅샷의 `type` 필드와 같은 문자열이라(아래 자기검증 참조) 산출물은 동일하고,
 * 기준선이 코드와 함께 움직인다.
 *
 * ── 스키마 밖 테이블 (측정 실측 2026-09-15) ────────────────────────────────
 * 라이브 public 스키마 = **196 테이블 / 3,856 컬럼**. 그중 schema.ts 가 모델링한
 * 52 테이블 = **424 컬럼이고 드리프트 0** 이다. 나머지 **144 테이블 / 3,432 컬럼**은
 * schema.ts 에 애초에 없다 — 대부분(**135 테이블 / 3,322 컬럼**)이 `summary_*`
 * 사실표·주차 파티션 계열로, 마이그레이션 SQL 로만 만들어지고 drizzle 로는 모델링된
 * 적이 없다(docs/development-guide.md "저널 밖 DDL 이 존재한다").
 *
 * 그 3,432 행이 매번 `3_EXTRA_IN_DB` 로 쏟아지면 **진짜 드리프트 1건이 묻힌다.**
 * 그래서 `OUT_OF_BAND_PREFIXES` 의 테이블은 결과에서 제외하고, 헤더에 그 사실과
 * 개수를 적는다. 제외가 아니라 **분류**다 — 모델링되면 접두어를 지우면 된다.
 */
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../lib/db/schema";

/**
 * schema.ts 가 모델링하지 않는 것으로 **알려진** 테이블 접두어.
 * 여기 있는 것은 "드리프트가 아니라 설계"다. 새 접두어를 추가할 때는 왜 모델링 밖인지
 * 한 줄로 적는다 — 아니면 이 목록이 드리프트를 숨기는 서랍이 된다.
 */
const OUT_OF_BAND_PREFIXES = [
  // 요약 사실표·집계층·주차 파티션(0056~0071). 파티션이 매주 늘어 drizzle 로 모델링할
  // 수 없고, 정본은 마이그레이션 SQL + lib/summary/ 의 리더다. 실측 135테이블.
  "summary_",
  // 웹사이트 GEO 수집·SEO 계열. 이 앱의 읽기 경로가 쓰지 않고 별도 파이프라인이 소유한다.
  "webgeo_",
  "crawl_",
  // drizzle 자신의 적용 기록 테이블(drizzle 스키마가 아니라 public 에 있을 수 있다).
  "__drizzle",
  // ⚠️ `_bak_*`(일회성 백업 테이블)은 **일부러 빼지 않는다.** 정리 대상 부채라 결과에
  // 계속 뜨는 편이 낫다 — 여기 넣는 순간 아무도 다시 안 본다.
];

type Row = [table: string, column: string, type: string, notnull: "YES" | "NO"];

const isPgTable = (v: unknown): v is PgTable =>
  typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in v;

const enumNames = new Set<string>();
for (const v of Object.values(schema)) {
  // ⚠️ `pgEnum(...)` 이 돌려주는 것은 **호출 가능한 객체(함수)** 다 — `typeof v === "object"`
  // 로 거르면 enum 이 하나도 안 잡히고, 그러면 enum 컬럼의 기대 타입이 실제
  // information_schema 값(USER-DEFINED)과 어긋나 14개 컬럼이 상시 가짜 드리프트가 된다.
  if ((typeof v === "object" || typeof v === "function") && v !== null) {
    const name = (v as { enumName?: unknown }).enumName;
    if (typeof name === "string") enumNames.add(name);
  }
}
if (enumNames.size === 0) {
  console.error("enum 을 하나도 못 읽었다 — pgEnum 표현이 바뀌었을 수 있다(가짜 드리프트 방지)");
  process.exit(1);
}

/** drizzle SQL 타입 → information_schema.data_type */
function pgType(t: string): string {
  const bare = t.replace(/^"public"\./, "").replace(/"/g, "");
  if (bare.endsWith("[]")) return "ARRAY";
  if (enumNames.has(bare)) return "USER-DEFINED";
  return ({ bigserial: "bigint", serial: "integer" } as Record<string, string>)[bare] ?? bare;
}

const rows: Row[] = [];
for (const value of Object.values(schema)) {
  if (!isPgTable(value)) continue;
  const cfg = getTableConfig(value);
  for (const c of cfg.columns) {
    rows.push([cfg.name, c.name, pgType(c.getSQLType()), c.notNull ? "YES" : "NO"]);
  }
}
rows.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

if (rows.length === 0) {
  console.error("schema.ts 에서 테이블을 하나도 읽지 못했다 — import 경로 확인");
  process.exit(1);
}

const tables = new Set(rows.map((r) => r[0]));
const q = (x: string) => `'${String(x).replaceAll("'", "''")}'`;
const values = rows.map((r) => `  (${r.map(q).join(",")})`).join(",\n");
// ⚠️ LIKE 에서 `_` 는 **한 글자 와일드카드**다. `'summary_%'` 로 쓰면 `summaryX…` 까지
// 걸러져 진짜 드리프트를 숨긴다 — 접두어의 `_` 를 반드시 이스케이프한다.
const likeEscape = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("_", "\\_").replaceAll("%", "\\%");
// ⚠️ 별칭은 **`c`** 다 — 이 절이 들어가는 곳은 아래 `actual` CTE 의 WHERE 이고 거기서
// information_schema.columns 의 별칭은 c 다. `a` 로 쓰면 그 별칭은 바깥 FULL OUTER JOIN
// 에서만 존재하므로 생성 SQL 이 **42P01 missing FROM-clause entry for table "a"** 로
// 통째로 죽는다(2026-09-15 검증자 실행). 이 파일은 SQL 을 "출력"만 하므로 tsc·유닛으로는
// 안 잡힌다 — 그래서 아래 drift-sql.test.ts 가 **생성 SQL 을 실제로 실행**한다.
const skipClause = OUT_OF_BAND_PREFIXES.map(
  (p) => `c.table_name NOT LIKE ${q(`${likeEscape(p)}%`)}`,
).join("\n     AND ");

process.stdout.write(`-- hmg-geo 스키마 드리프트 대조 — 읽기 전용, 결과 0행이면 드리프트 없음.
-- 기준선: lib/db/schema.ts (직접 읽음 — 스냅샷이 아니다) · ${tables.size}테이블 / ${rows.length}컬럼
-- 재생성: npx tsx scripts/db/drift-sql.ts
--
-- ⚠️ schema.ts 밖 테이블(${OUT_OF_BAND_PREFIXES.join(", ")} 접두어)은 결과에서 뺀다 —
--    별도 파이프라인이 소유하는 계열이라 상시 EXTRA 로 뜨면 진짜 드리프트가 묻힌다.
--    실측(2026-09-15 · MCP 읽기 전용): 라이브 196테이블/3,856컬럼 중 summary_ 계열이
--    135테이블/3,322컬럼. 같은 실측에서 모델링된 52테이블은 **형태 불일치 0** 이었다.
WITH expected(table_name, column_name, data_type, is_notnull) AS (VALUES
${values}
),
actual AS (
  SELECT c.table_name::text, c.column_name::text, c.data_type::text,
         CASE WHEN c.is_nullable = 'NO' THEN 'YES' ELSE 'NO' END AS is_notnull
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND ${skipClause}
)
SELECT
  CASE
    WHEN a.column_name IS NULL AND NOT EXISTS (
      SELECT 1 FROM actual a2 WHERE a2.table_name = e.table_name
    ) THEN '1_TABLE_MISSING'
    WHEN a.column_name IS NULL             THEN '2_COLUMN_MISSING'
    WHEN e.column_name IS NULL             THEN '3_EXTRA_IN_DB'
    WHEN a.data_type  IS DISTINCT FROM e.data_type  THEN '4_TYPE_MISMATCH'
    WHEN a.is_notnull IS DISTINCT FROM e.is_notnull THEN '5_NOTNULL_MISMATCH'
  END                                    AS issue,
  COALESCE(e.table_name,  a.table_name)  AS table_name,
  COALESCE(e.column_name, a.column_name) AS column_name,
  e.data_type  AS expected_type,    a.data_type  AS actual_type,
  e.is_notnull AS expected_notnull, a.is_notnull AS actual_notnull
FROM expected e
FULL OUTER JOIN actual a
  ON a.table_name = e.table_name AND a.column_name = e.column_name
WHERE a.column_name IS NULL
   OR e.column_name IS NULL
   OR a.data_type  IS DISTINCT FROM e.data_type
   OR a.is_notnull IS DISTINCT FROM e.is_notnull
ORDER BY 1, 2, 3;
`);
