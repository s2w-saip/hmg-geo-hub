/**
 * 축 on 문장 전수를 파일로 떨군다 — 사람이 프로덕션 미러에 그대로 붙여 넣는 용도.
 *
 * 목록·규약의 정본은 `scripts/db/axis-on-sql-manifest.ts` 다(같은 목록을
 * `lib/db/repositories/axis-on-statements.pglite.test.ts` 가 PREPARE 로 단언한다).
 * 이 스크립트는 **DB 에 접속하지 않는다.**
 *
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/db/dump-axis-on-sql.ts <출력 디렉토리>
 */
import fs from "node:fs";
import path from "node:path";
import { buildAxisOnStatements } from "./axis-on-sql-manifest";

const OUT = process.argv[2];
if (!OUT) {
  console.error(
    "사용법: npx tsx --tsconfig scripts/summary/tsconfig.json scripts/db/dump-axis-on-sql.ts <출력 디렉토리>",
  );
  process.exit(2);
}

void (async () => {
  const stmts = await buildAxisOnStatements();
  fs.mkdirSync(OUT, { recursive: true });
  for (const s of stmts) {
    fs.writeFileSync(path.join(OUT, s.name), `${s.header.trimEnd()}\n${s.body}\n`, "utf8");
    console.log(`wrote ${s.name} (${s.body.length}B)`);
  }
  console.log(`\n완료 — ${stmts.length}개 · ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
