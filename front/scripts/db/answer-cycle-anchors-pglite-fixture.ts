/**
 * 0077·0078 계열 SQL 을 **진짜 Postgres(pglite = wasm 빌드)** 에서 돌리기 위한 공통 토대.
 *
 * 이 모듈은 테스트 전용이다(런타임 코드가 import 하지 않는다). 두 테스트 파일
 * (`scripts/db/answer-cycle-anchors-sql.pglite.test.ts`,
 *  `lib/db/migrations/0078_answer_cycle_anchor_hot_path.pglite.test.ts`)이 같은 토대를
 * 쓰도록 **한 곳**에 둔다 — 두 벌이 되면 한쪽의 컬럼 타입만 낡아 "테스트는 통과하는데
 * 실 DB 에서 터지는" 종류가 다시 생긴다(이 계열이 이미 두 번 겪은 실패 모드다).
 *
 * 기존 표의 DDL 은 **원본 파일에서 읽어** 쓴다 — 타입을 여기 복사하지 않는다.
 */
import fs from "node:fs";
import path from "node:path";

export const MIG_DIR = path.resolve(__dirname, "..", "..", "lib", "db", "migrations");
export const MIGRATION_0077 = path.join(MIG_DIR, "0077_scope_answer_cycle_anchors.sql");
export const MIGRATION_0078 = path.join(MIG_DIR, "0078_answer_cycle_anchor_hot_path.sql");
export const MIGRATION_0079 = path.join(MIG_DIR, "0079_scope_runs_project_cycle_idx.sql");

/** 다른 파일에 이미 있는 DDL 을 **그 파일에서 읽어** 쓴다(타입을 여기 복사하지 않는다). */
export function createTableFrom(file: string, table: string): string {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS "?${table}"?\\s*\\([\\s\\S]*?\\n\\);`, "i"),
  );
  if (!m) throw new Error(`${table} 의 CREATE TABLE 을 ${file} 에서 못 찾았다`);
  return m[0];
}

/**
 * 이 SQL 들이 읽는 기존 표의 **최소 DDL**. 컬럼은 부분집합이지만 **타입은 원본 그대로**다
 * (원본 파일에서 읽어 오거나, 원본이 drizzle 스키마뿐인 표만 여기 적는다).
 */
export function baseSchema(): string {
  const mirror = path.resolve(__dirname, "scope-mirror.sql");
  return [
    createTableFrom(mirror, "scope_runs"),
    // 0020·0058 이 나중에 붙인 컬럼(미러 DDL 에는 없다).
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS cycle_anchor_at timestamptz;`,
    createTableFrom(mirror, "scope_answers"),
    createTableFrom(path.join(MIG_DIR, "0053_scope_answer_anchors.sql"), "scope_answer_anchors"),
    createTableFrom(path.join(MIG_DIR, "0059_summary_tables.sql"), "summary_cycles"),
    createTableFrom(path.join(MIG_DIR, "0059_summary_tables.sql"), "summary_cycle_runs"),
    createTableFrom(path.join(MIG_DIR, "0019_website_sites_prompts.sql"), "website_sites"),
    // `projects` 는 drizzle 스키마(lib/db/schema.ts:83)가 정본이고 컬럼이 많다.
    // 이 SQL 들이 읽는 것은 `scope_project_id uuid` 하나뿐이라 그 축소판을 둔다.
    `CREATE TABLE projects (
       id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       name             text NOT NULL,
       country          text NOT NULL,
       scope_project_id uuid
     );`,
  ].join("\n");
}

/** 마이그레이션의 실행 대상 문장 — REVOKE/GRANT 만 뺀다(pglite 에 그 롤이 없다). */
export function migrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0 && !/^(REVOKE|GRANT)\b/i.test(s));
}

/** 파일 경로로 읽어 바로 문장 배열로. */
export function statementsOf(file: string): string[] {
  return migrationStatements(fs.readFileSync(file, "utf8"));
}

export type PgliteDb = {
  query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (s: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/**
 * 빈 pglite 인스턴스에 기존 표 + 0077(+ 선택적으로 0078·0079)을 적용한다.
 * `fixtures` 는 적용 **뒤**에 실행된다.
 *
 * ⚠️ 0079(=`scope_runs (project_id, cycle_anchor_at)` 인덱스)는 **0078 과 한 세트**로
 * 적용된다(프로덕션도 그렇다). 인덱스뿐이라 값에는 영향이 없고, 대신 0078 테스트 전부가
 * 그 DDL 을 한 번씩 태우게 된다. 0079 만 따로 보려면 `withV79` 로 가른다.
 */
export async function newDb(opts: {
  withV78: boolean;
  withV79?: boolean;
  fixtures?: string;
}): Promise<PgliteDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite() as unknown as PgliteDb;
  await db.exec(baseSchema());
  for (const s of statementsOf(MIGRATION_0077)) await db.exec(s);
  if (opts.withV78) {
    for (const s of statementsOf(MIGRATION_0078)) await db.exec(s);
  }
  if (opts.withV79 ?? opts.withV78) {
    for (const s of statementsOf(MIGRATION_0079)) await db.exec(s);
  }
  if (opts.fixtures) await db.exec(opts.fixtures);
  return db;
}
