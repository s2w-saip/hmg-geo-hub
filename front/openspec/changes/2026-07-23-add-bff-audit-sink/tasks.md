## 1. 스키마 + 마이그레이션 (lib/db)

- [x] 1.1 `lib/db/schema.ts` — `bffAuditKindEnum`(`bff_audit_kind`: scope_call/data_access) +
      `bffAuditLogs`(id uuid PK defaultRandom / ts timestamptz notNull defaultNow / actor_id uuid
      notNull(FK 없음 — 의도) / actor_role text notNull(스냅샷) / kind notNull / action text notNull /
      target text null / detail jsonb null), 인덱스 (ts)·(actor_id, ts).
- [x] 1.2 `lib/db/migrations/0033_bff_audit_logs.sql` — 손작성 멱등(`DO $$` enum 가드 +
      `CREATE TABLE/INDEX IF NOT EXISTS`), additive-only. 2회 적용 가정 에러 0(SQL 구조로 보장).
      lockdown 커버리지 주의 주석 포함(신규 테이블 anon revoke 실측 필요).

## 2. Repository (insert 전용)

- [x] 2.1 `lib/db/repositories/bff-audit-logs.ts`(신규) — `bffAuditLogRepository.insert`만 export
      (v1 read 미노출). `@/lib/db` 경계는 `lib/db/**` 예외로 허용(ESLint).

## 3. Sink 교체 (lib/audit.ts)

- [x] 3.1 `auditScopeCall`·`auditDataAccess` sink를 `bffAuditLogRepository.insert`로 교체.
      **시그니처 동기 `void` 불변** → 기존 호출부 9파일·28지점 diff 0줄.
- [x] 3.2 fire-and-forget dispatch — `after()`(next/server)로 응답 후 insert. `after()` throw
      (request context 부재) 시 즉시 비동기 insert 폴백. 어떤 컨텍스트에서도 throw 금지.
- [x] 3.3 sink 실패 시 원본 payload `console.error` 폴백(무음 유실 금지). `console.info` 제거.
- [x] 3.4 `bff_audit_logs` insert는 `auditDataAccess`를 경유하지 않음(재귀 금지 — repo 직접 호출).

## 4. 테스트 (vitest)

- [x] 4.1 `lib/audit.test.ts`(신규) 4케이스: ① scope_call 행 형상(actor/role/action/filter 스냅샷)
      ② data_access 행 형상 ③ insert reject 시 no-throw + console.error 폴백 1회 ④ request context
      부재(after() throw) 시 no-throw + 즉시 폴백 insert.
- [x] 4.2 기존 `admin/_actions.test.ts`(@/lib/audit mock) 무수정 통과 확인.

## 5. 문서 (openspec + 서술 갱신)

- [x] 5.1 이 change(proposal/tasks/delta specs).
- [x] 5.2 `README.md`·`docs/development-guide.md`·`docs/qa/qa-matrix.md`의 "placeholder/콘솔 sink/영속 미구현"
      서술을 실저장으로 갱신.

## 6. 게이트

- [x] 6.1 `npm test` 전체 green · `npm run build` 성공 · `npm run lint` 통과.
- [ ] 6.2 (후속, 제품 책임자 실행 단계 — 이 change 범위 밖) 마이그 0033 prod 적용 → `lockdown.sql`
      재실행 → 신규 테이블 anon 권한 `has_table_privilege('anon','public.bff_audit_logs',…)=false`
      실측 · dev 스모크로 실제 행 적재 확인.
