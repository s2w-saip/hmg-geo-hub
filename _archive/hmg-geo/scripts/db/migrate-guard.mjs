/**
 * `npm run db:migrate` 차단기 — drizzle-kit migrate 는 이 리포에서 쓰지 않는다.
 *
 * 이유(2026-08-21 조사):
 *  - 운영 DB 의 스키마는 마이그레이션 파일만으로 재현되지 않는다. scope_* 미러 5개
 *    테이블은 scripts/db/scope-mirror.sql 로, 일부 컬럼은 대시보드/MCP 로 저널 밖에서
 *    적용됐다. 즉 "0000부터 순서대로 돌린다"는 drizzle-kit migrate 의 전제가 거짓이다.
 *  - drizzle-kit migrate 는 drizzle.__drizzle_migrations 의 **최신 created_at 하나**만
 *    보고 그보다 when 이 큰 저널 항목을 전부 재실행한다(hash 대조 없음). 이 리포는
 *    0021~0043 을 저널 밖에서 적용해왔으므로, migrate 를 돌리면 이미 적용된 20여 개가
 *    한 트랜잭션 안에서 재실행된다.
 *
 * 적용 경로는 `npm run db:apply -- <번호>` 하나뿐이다 (scripts/db/apply-migration.ts).
 * 자세한 절차는 CLAUDE.md "DB 마이그레이션 절차" 참고.
 */
console.error(
  [
    "",
    "  ✋ db:migrate 는 이 리포에서 사용하지 않는다.",
    "",
    "  drizzle-kit migrate 는 저널(meta/_journal.json)에 있는 마이그레이션을",
    "  '아직 적용 안 됨'으로 판정해 재실행할 수 있다. 이 리포는 0021 부터 저널 밖에서",
    "  적용해 왔기 때문에, 운영 DB 에서 이 명령은 이미 적용된 마이그레이션 20여 개를",
    "  다시 실행한다.",
    "",
    "  대신:",
    "    npm run db:generate            # schema.ts 변경분 → 새 SQL 초안 + 스냅샷 갱신",
    "    (생성된 SQL 을 멱등하게 손질: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS …)",
    "    npm run db:apply -- 0045       # 번호 지정 적용 (유일한 적용 경로)",
    "    npm run db:drift               # schema.ts ↔ 실제 DB 대조 (읽기 전용)",
    "",
    "  신규 환경 구축 순서는 README.md '실행' 섹션 참고.",
    "",
  ].join("\n"),
);
process.exit(1);
