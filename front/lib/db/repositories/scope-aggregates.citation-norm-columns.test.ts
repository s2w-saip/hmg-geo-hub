import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { citationTrackedNormSql, citationBaseNormSql } from "./scope-aggregates";

// 정규화 정의가 **세 벌**로 갈라지는 것을 막는다 (2026-09-03, migration 0052).
//
// 0052 가 인용 URL 정규화를 조회 시점 식에서 저장 컬럼으로 승격하면서 정의가
//   ① TS 식 (citationTrackedNormSql / citationBaseNormSql — 폴백 경로가 쓴다)
//   ② SQL 함수 (citation_url_norm / citation_url_base_norm — 컬럼을 채우는 정본)
//   ③ JS (lib/scope/url-match.ts::normalizeUrlForMatch — ①의 쌍둥이)
// 셋이 됐다. ①↔③ 은 `npm run verify:url-match`(라이브 DB)가 이미 강제하므로,
// 이 테스트는 **①↔②** 를 DB 없이 강제한다: 마이그레이션 파일에서 함수 본문을
// 꺼내 TS 빌더의 컴파일 결과와 문자적으로 대조한다.
//
// 왜 중요한가: ②가 ①과 어긋나면 **컬럼에 저장된 값과 폴백이 계산한 값이 달라진다.**
// 백필된 행과 미충전 행이 서로 다른 판정을 받게 되고, 그 차이는 화면에서
// "일부 인용만 자사로 안 잡힘"으로 나타나 원인 추적이 매우 어렵다.

const MIGRATION = path.join(
  process.cwd(),
  "lib/db/migrations/0052_scope_citations_url_norm.sql",
);

const dialect = new PgDialect();

/** drizzle SQL → 바인드 파라미터를 리터럴로 되돌린 순수 텍스트 ($1 = 인자). */
function compile(build: (col: SQL) => SQL): string {
  const q = dialect.sqlToQuery(build(sql.raw("__COL__")));
  let text = q.sql;
  q.params.forEach((p, i) => {
    text = text.split(`$${i + 1}`).join(`'${String(p).replace(/'/g, "''")}'`);
  });
  return text.replace("__COL__", "$1");
}

/** 마이그레이션 파일에서 `CREATE OR REPLACE FUNCTION <name>` 의 본문(SELECT 이후). */
function migrationFunctionBody(name: string): string {
  const file = fs.readFileSync(MIGRATION, "utf8");
  const start = file.indexOf(`CREATE OR REPLACE FUNCTION ${name}(text)`);
  expect(start, `${name} 정의가 0052 에 없다`).toBeGreaterThanOrEqual(0);
  const open = file.indexOf("$fn$", start);
  const close = file.indexOf("$fn$", open + 4);
  expect(close).toBeGreaterThan(open);
  return file.slice(open + 4, close).trim().replace(/^SELECT\s+/, "");
}

// E'…' 트림 리터럴은 양쪽 표기가 다르다(TS 는 JS 가 해석한 **실제 제어문자**,
// SQL 파일은 PG 가 해석할 **escape 표기**). 텍스트 대조에서는 토큰으로 가리고,
// 문자 집합 자체는 아래 별도 케이스가 못박는다.
const maskTrim = (s: string) => s.replace(/E'[^']*'/g, "E'<TRIM>'");

describe("인용 URL 정규화 — TS 식과 0052 SQL 함수가 같은 정의인가", () => {
  it("citation_url_norm(text) === citationTrackedNormSql (KPI⑥ tracked)", () => {
    expect(migrationFunctionBody("citation_url_norm")).toBe(
      compile(citationTrackedNormSql),
    );
  });

  it("citation_url_base_norm(text) === citationBaseNormSql (KPI⑤ base)", () => {
    expect(maskTrim(migrationFunctionBody("citation_url_base_norm"))).toBe(
      maskTrim(compile(citationBaseNormSql)),
    );
  });

  // btrim 의 트림 문자 집합. PG 의 E'' 는 \v 를 escape 로 인식하지 않고 문자 'v'
  // 로 접는다 — 마이그레이션에 `\v` 라고 쓰면 트림 집합이 조용히 (공백,t,n,r,f,v)
  // 로 바뀌고, 수직탭으로 끝나는 URL 이 컬럼과 폴백에서 다르게 정규화된다.
  it("트림 문자 집합 — TS 는 실제 제어문자, SQL 은 8진 escape(\\013)", () => {
    const tsLiteral = compile(citationBaseNormSql).match(/E'([^']*)'/)?.[1];
    expect(tsLiteral).toBe(" \t\n\r\f\v");
    const sqlLiteral = migrationFunctionBody("citation_url_base_norm").match(
      /E'([^']*)'/,
    )?.[1];
    // 파일에 적힌 그대로(백슬래시 2글자 표기). \013(8진) = 0x0B = 수직탭.
    expect(sqlLiteral).toBe(" \\t\\n\\r\\f\\013");
  });

  it("citation_url_host 는 url_norm 에서 유도한다 (정의를 두 벌로 만들지 않는다)", () => {
    expect(migrationFunctionBody("citation_url_host")).toBe(
      "split_part(citation_url_norm($1), '/', 1)",
    );
  });

  it("컬럼 추가는 카탈로그 선확인 + lock_timeout 으로 감싼다", () => {
    const file = fs.readFileSync(MIGRATION, "utf8");
    // `ADD COLUMN IF NOT EXISTS` 는 no-op 이어도 ACCESS EXCLUSIVE 를 먼저 잡는다.
    expect(file).toContain("SET LOCAL lock_timeout");
    expect(file).toContain("FROM pg_attribute");
    expect(file).not.toMatch(/ALTER TABLE .*ALTER COLUMN/);
    expect(file).not.toMatch(/DROP COLUMN/);
  });
});
