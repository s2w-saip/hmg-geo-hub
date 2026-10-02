/**
 * schema.ts ↔ 실제 DB 드리프트 검사 (읽기 전용).
 *
 * 이 리포는 마이그레이션을 손으로 적용해 왔고, 저널 밖(대시보드·MCP)에서 적용된 DDL 도
 * 있다. 그래서 "schema.ts 와 DB 가 어긋나도 아무도 모른다"가 진짜 문제였다 —
 * 이 스크립트가 그 감시를 담당한다.
 *
 *   npm run db:drift            # DATABASE_URL 대상 (.env.local)
 *
 * 동작: drizzle-kit introspect(pull)로 대상 DB 를 읽어 .drizzle-introspect/ 에
 * 스냅샷을 만들고, lib/db/migrations/meta 의 최신 스냅샷(= schema.ts 기준선)과
 * 테이블/컬럼 단위로 대조한다. **DB 에 아무것도 쓰지 않는다.**
 *
 * 종료 코드: 0 = 차이 없음, 1 = 차이 있음(또는 실행 실패).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const OUT = path.join(REPO, ".drizzle-introspect");
const META = path.join(REPO, "lib/db/migrations/meta");

// DRIFT_SKIP_PULL=1 → introspect 를 건너뛰고 이미 뽑아둔 .drizzle-introspect/ 로 대조만
// 다시 한다 (DB 재접속 없이 비교 로직만 돌릴 때 / 오프라인 검증용).
if (!process.env.DRIFT_SKIP_PULL) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 없다 — .env.local 확인 (npm run db:drift 는 --env-file 로 로드한다)");
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const r = spawnSync(
    "npx",
    ["drizzle-kit", "pull", "--config=drizzle.introspect.config.ts"],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
  );
  if (r.status !== 0) {
    console.error("introspect 실패 — 위 출력 확인");
    process.exit(1);
  }
} else if (!fs.existsSync(path.join(OUT, "meta"))) {
  console.error("DRIFT_SKIP_PULL=1 인데 .drizzle-introspect/meta 가 없다 — 먼저 pull 이 필요하다");
  process.exit(1);
}

const baselineFile = fs
  .readdirSync(META)
  .filter((f) => f.endsWith("_snapshot.json"))
  .sort()
  .pop();
const baseline = JSON.parse(fs.readFileSync(path.join(META, baselineFile), "utf8"));
const liveFile = fs
  .readdirSync(path.join(OUT, "meta"))
  .filter((f) => f.endsWith("_snapshot.json"))
  .sort()
  .pop();
const live = JSON.parse(fs.readFileSync(path.join(OUT, "meta", liveFile), "utf8"));

const norm = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim().toLowerCase();
const tablesOf = (snap) => {
  const out = new Map();
  for (const t of Object.values(snap.tables ?? {})) {
    const cols = new Map();
    for (const c of Object.values(t.columns ?? {})) {
      cols.set(c.name, { type: norm(c.type), notNull: !!c.notNull, default: norm(c.default) });
    }
    out.set(t.name, { cols, indexes: new Set(Object.keys(t.indexes ?? {})) });
  }
  return out;
};

const A = tablesOf(baseline); // schema.ts 기준선
const B = tablesOf(live); // 실제 DB
const diffs = [];

for (const name of [...A.keys()].sort()) {
  if (!B.has(name)) {
    diffs.push(`[테이블 없음] ${name} — schema.ts 에는 있고 DB 에는 없다`);
    continue;
  }
  const a = A.get(name), b = B.get(name);
  for (const [col, spec] of [...a.cols].sort()) {
    const other = b.cols.get(col);
    if (!other) { diffs.push(`[컬럼 없음] ${name}.${col} — schema.ts 에만 있다`); continue; }
    if (spec.type !== other.type) diffs.push(`[타입 불일치] ${name}.${col} — schema.ts=${spec.type} / DB=${other.type}`);
    if (spec.notNull !== other.notNull) diffs.push(`[NOT NULL 불일치] ${name}.${col} — schema.ts=${spec.notNull} / DB=${other.notNull}`);
    if (spec.default !== other.default) diffs.push(`[DEFAULT 불일치] ${name}.${col} — schema.ts=${spec.default || "(없음)"} / DB=${other.default || "(없음)"}`);
  }
  for (const col of [...b.cols.keys()].sort()) {
    if (!a.cols.has(col)) diffs.push(`[컬럼 잉여] ${name}.${col} — DB 에만 있다 (schema.ts 미반영)`);
  }
}
const extraTables = [...B.keys()].filter((t) => !A.has(t)).sort();

console.log(`\n기준선: lib/db/migrations/meta/${baselineFile}  |  DB introspect: ${liveFile}`);
if (extraTables.length) console.log(`\n(참고) DB 에만 있는 테이블 ${extraTables.length}개: ${extraTables.join(", ")}`);
if (diffs.length === 0) {
  console.log("\n✅ 드리프트 없음 — schema.ts 와 DB 가 일치한다.\n");
  process.exit(0);
}
console.log(`\n❌ 드리프트 ${diffs.length}건:\n`);
for (const d of diffs) console.log("  - " + d);
console.log("");
process.exit(1);
