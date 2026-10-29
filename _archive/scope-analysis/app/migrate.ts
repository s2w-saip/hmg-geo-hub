// 번호 마이그레이션 — `migrations/NNNN_*.sql` 을 순서대로 1회 적용.
// 측정 lane `app/migrate.py` 의 TS 이식본. 규율(동결 트랙 교훈)을 그대로 가져온다:
//   · 번호 중복 금지
//   · **파일은 불변** — 수정 대신 새 번호(적용 후 sha 가 바뀌면 실패시킨다)
//   · additive 만. 깨는 변경은 새 번호 + 호환 기간
//
// 동시 기동 안전: `pg_advisory_xact_lock`(**트랜잭션 스코프**). 세션 스코프를 쓰면 RDS Proxy 가
// 그 커넥션을 DB 커넥션에 영구 피닝한다 — 측정 lane 이 실측으로 치른 값이다(worker/main.py 주석).
//
//   pnpm migrate            # 적용
//   pnpm migrate --status   # 적용/미적용 목록
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresDb, type Db, type Queryable } from "./db.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** 임의 상수. 다른 advisory lock(리퍼 리더)과 겹치지 않게 둔다. */
export const MIGRATION_LOCK_KEY = 734_101;

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (entries.length === 0) throw new Error(`no migration files under ${dir}`);
  const out: MigrationFile[] = [];
  for (const name of entries) {
    const m = NAME_RE.exec(name);
    if (!m) throw new Error(`bad migration filename: ${name}`);
    out.push({ version: Number(m[1]), name, path: join(dir, name) });
  }
  const nums = out.map((o) => o.version);
  if (new Set(nums).size !== nums.length) throw new Error(`duplicate migration numbers: ${nums.join(",")}`);
  return out;
}

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** 한 트랜잭션 안에서 미적용분을 전부 적용하고 이름 목록을 돌려준다. */
export async function applyMigrations(tx: Queryable, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await tx.query(ENSURE_TABLE);
  await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  const done = new Map<number, string>();
  for (const r of await tx.query<{ version: number; sha256: string }>("SELECT version, sha256 FROM schema_migrations")) {
    done.set(Number(r.version), r.sha256);
  }
  const applied: string[] = [];
  for (const f of listMigrationFiles(dir)) {
    const body = readFileSync(f.path);
    const sha = createHash("sha256").update(body).digest("hex");
    const prev = done.get(f.version);
    if (prev !== undefined) {
      if (prev !== sha) {
        throw new Error(`migration ${f.name} changed after apply (sha mismatch) — add a new numbered file instead`);
      }
      continue;
    }
    await tx.query(body.toString("utf8"));
    await tx.query("INSERT INTO schema_migrations (version, name, sha256) VALUES ($1,$2,$3)", [f.version, f.name, sha]);
    applied.push(f.name);
  }
  return applied;
}

export async function migrationStatus(tx: Queryable, dir: string = MIGRATIONS_DIR): Promise<Array<[string, boolean]>> {
  await tx.query(ENSURE_TABLE);
  const done = new Set<number>();
  for (const r of await tx.query<{ version: number }>("SELECT version FROM schema_migrations")) done.add(Number(r.version));
  return listMigrationFiles(dir).map((f) => [f.name, done.has(f.version)] as [string, boolean]);
}

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  return db.begin((tx) => applyMigrations(tx, dir));
}

async function main(argv: string[]): Promise<number> {
  const dsn = process.env.ANALYSIS_STORE_DSN;
  if (!dsn) {
    process.stderr.write("ANALYSIS_STORE_DSN required\n");
    return 2;
  }
  const db = createPostgresDb(dsn, { max: 2 });
  try {
    if (argv.includes("--status")) {
      for (const [name, ok] of await db.begin((tx) => migrationStatus(tx))) {
        process.stdout.write(`${ok ? "applied" : "pending"} ${name}\n`);
      }
      return 0;
    }
    for (const name of await migrate(db)) process.stdout.write(`applied ${name}\n`);
    return 0;
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
