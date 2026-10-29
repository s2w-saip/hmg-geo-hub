import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 드리프트 대조 SQL 생성기의 계약.
 *
 * 이 스크립트가 틀리면 **조용히 틀린다** — 결과가 0행이면 "드리프트 없음"으로 읽히고,
 * 반대로 가짜 행이 쏟아지면 진짜 1건이 묻힌다. 실제로 두 함정을 다 밟았다:
 *   · 기준선이 `meta/` 최신 스냅샷이었는데 0062 부터 `db:generate` 를 안 돌려
 *     스냅샷이 0061 에 멈췄다 → 그 뒤 추가된 테이블이 전부 EXTRA 로 떴다.
 *   · `pgEnum(...)` 은 **함수**라 `typeof v === "object"` 로 거르면 enum 이 하나도
 *     안 잡히고, enum 컬럼 14개가 상시 가짜 타입 불일치가 된다.
 *
 * 라이브 대조(2026-09-15 · MCP 읽기 전용): 모델링된 52테이블 **형태 불일치 0**,
 * `scope_answer_stances` 만 `1_TABLE_MISSING`(0072 미적용 — 정상).
 */
const REPO = path.resolve(__dirname, "../..");
const out = execFileSync("npx", ["tsx", "scripts/db/drift-sql.ts"], {
  cwd: REPO,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const valueRows = out.split("\n").filter((l) => /^ {2}\('/.test(l));
/** 생성된 SQL 본문 — 주석까지 포함해 **출력 그대로** 실행한다(그것이 붙여넣기의 실체다). */
const sql = out;

describe("drift-sql — 기준선", () => {
  it("schema.ts 를 직접 읽는다 (스냅샷 아님)", () => {
    expect(out).toContain("기준선: lib/db/schema.ts");
    const schemaSrc = fs.readFileSync(path.join(REPO, "lib/db/schema.ts"), "utf8");
    const tableCount = (schemaSrc.match(/pgTable\(/g) ?? []).length;
    expect(out).toMatch(new RegExp(`· ${tableCount}테이블`));
  });

  it("0072 의 새 테이블이 기준선에 들어 있다 — 스냅샷 기준일 때 빠지던 자리", () => {
    const stance = valueRows.filter((r) => r.includes("'scope_answer_stances'"));
    expect(stance).toHaveLength(12);
    expect(stance.join("\n")).toContain("('scope_answer_stances','turn_index','integer','YES')");
  });

  it("enum 컬럼 15개가 USER-DEFINED 로 매핑된다 (pgEnum 은 함수라 놓치기 쉽다)", () => {
    // 15 = 실측(2026-09-15). prompt_type 이 prompts·standard_prompts 두 곳에 있어
    // "enum 종류 수"(14)와 "enum 컬럼 수"(15)가 다르다 — 세는 단위를 혼동하지 말 것.
    expect(valueRows.filter((r) => r.includes("'USER-DEFINED'"))).toHaveLength(15);
    // 하나라도 enum 이름이 그대로 새면 그 컬럼은 영원히 가짜 4_TYPE_MISMATCH 다.
    expect(out).toContain("('profiles','role','USER-DEFINED','YES')");
    expect(out).toContain("('ai_responses','ai_provider','USER-DEFINED','YES')");
    expect(valueRows.some((r) => r.endsWith("','role','YES')"))).toBe(false);
  });

  it("배열 컬럼은 ARRAY", () => {
    expect(valueRows.some((r) => r.includes("'ARRAY'"))).toBe(true);
    expect(valueRows.some((r) => r.includes("text[]"))).toBe(false);
  });

  it("스키마 밖 계열은 actual CTE 안(별칭 c)에서 제외된다", () => {
    // ⚠️ 별칭이 이 단언의 핵심이다. 종전에는 이 테스트가 `a.table_name` 을 기대해
    // **깨진 SQL 을 통과시켰다** — 그 절이 들어가는 곳은 actual CTE(별칭 c)라 `a` 는
    // 그 스코프에 없고, 생성 SQL 이 42P01 로 죽었다. 문자열 단언은 "문법이 맞다"를
    // 증명하지 못한다 — 그래서 아래 pglite 실행 테스트가 함께 있다.
    for (const p of ["summary\\_%", "webgeo\\_%", "crawl\\_%"]) {
      expect(out).toContain(`c.table_name NOT LIKE '${p}'`);
    }
    expect(out).not.toMatch(/a\.table_name NOT LIKE/);
    // 일회성 백업 테이블은 **일부러 남긴다**(정리 부채가 계속 보이도록).
    expect(out).not.toContain("_bak");
  });

  it("읽기 전용이다 — 생성된 SQL 에 쓰기 구문이 없다", () => {
    expect(out).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  });
});

// ── 생성 SQL 을 **실제로 실행**한다 (2026-09-15 검증자 차단급 지적) ──────────
//
// 이 파일은 SQL 을 **문자열로 출력**만 한다 — tsc 도 유닛도 그 문자열이 유효한 SQL 인지
// 모른다. 실제로 그 구멍으로 사고가 났다: 스킵 절이 `a.table_name` 을 참조했는데 그
// 별칭은 바깥 FULL OUTER JOIN 에만 있어서, 생성된 SQL 이 PostgreSQL 에서
// **42P01 missing FROM-clause entry for table "a"** 로 통째로 죽었다. 그런데도
// "라이브 대조 통과"라고 보고됐다 — 실제로 돌린 것은 손으로 쓴 다른 쿼리였기 때문이다.
//
// 그래서 여기서는 **파서·플래너를 가진 진짜 Postgres**(pglite = wasm 빌드)에 스키마
// 일부를 만들고 생성 SQL 을 돌린다. 에러 0 + 결과 분류가 기대와 같아야 한다.
describe("drift-sql — 생성 SQL 실행 (pglite)", () => {
  /** 기대 행에서 그 테이블의 DDL 을 만든다 — 기준선과 DDL 이 갈리지 않게 같은 출처를 쓴다. */
  function ddlFor(table: string): string {
    const cols = valueRows
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.startsWith(`('${table}',`))
      .map((l) => l.slice(1, -1).split("','").map((p) => p.replace(/^'|'$/g, "")));
    expect(cols.length).toBeGreaterThan(0);
    const defs = cols.map(([, name, type, notnull]) => {
      const t = type === "ARRAY" ? "text[]" : type;
      return `"${name}" ${t}${notnull === "YES" ? " NOT NULL" : ""}`;
    });
    return `CREATE TABLE "${table}" (${defs.join(", ")})`;
  }

  it("에러 없이 돌고, 형태가 같은 테이블은 결과에 안 나온다", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      // ① 기준선과 **정확히 같은** 테이블 하나(0072 의 새 테이블 — 단순 타입만 쓴다)
      await db.exec(ddlFor("scope_answer_stances"));
      // ② 스킵 대상 계열 — 결과에 나오면 안 된다(스킵 절이 실제로 먹는지)
      await db.exec(`CREATE TABLE "summary_trend_brands" ("x" text)`);
      // ③ 스킵 밖의 모르는 테이블 — EXTRA 로 나와야 한다
      await db.exec(`CREATE TABLE "zz_unknown_table" ("y" integer)`);

      // ⚠️ 여기서 throw 되면 그것이 이 테스트의 존재 이유다(42P01 등).
      const res = await db.query<{ issue: string; table_name: string; column_name: string }>(sql);
      const byTable = new Map<string, string[]>();
      for (const r of res.rows) {
        byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.issue]);
      }

      // 형태가 같은 테이블 → 한 행도 없다.
      expect(byTable.get("scope_answer_stances")).toBeUndefined();
      // 스킵 계열 → 없다(스킵이 안 먹으면 EXTRA 로 뜬다).
      expect(byTable.get("summary_trend_brands")).toBeUndefined();
      // 스킵 밖 모르는 테이블 → EXTRA.
      expect(byTable.get("zz_unknown_table")).toEqual(["3_EXTRA_IN_DB"]);
      // 나머지 기준선 테이블은 전부 TABLE_MISSING (pglite 는 빈 DB 다).
      const missing = res.rows.filter((r) => r.issue === "1_TABLE_MISSING");
      expect(new Set(missing.map((r) => r.table_name)).size).toBe(
        new Set(valueRows.map((l) => l.trim().slice(2).split("'")[0])).size - 1,
      );
    } finally {
      await db.close();
    }
  }, 60_000);

  it("`_bak_*` 는 스킵하지 않는다 — 정리 부채가 계속 보이도록", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE "_bak_anchor_fold" ("z" text)`);
      const res = await db.query<{ issue: string; table_name: string }>(sql);
      expect(res.rows.some((r) => r.table_name === "_bak_anchor_fold" && r.issue === "3_EXTRA_IN_DB")).toBe(true);
    } finally {
      await db.close();
    }
  }, 60_000);
});
