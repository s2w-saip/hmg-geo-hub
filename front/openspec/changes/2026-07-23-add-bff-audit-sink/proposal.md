## Why

`lib/audit.ts`의 두 감사 함수(`auditScopeCall`·`auditDataAccess`)는 도입 이래 **콘솔
placeholder**였다 — `console.info`로만 찍고 영속 저장소가 없었다(qa-matrix QA-SEC-005:
"영속 저장소 미구현, 운영 전 교체 필요"). 이 DB는 RLS를 쓰지 않고 앱 레이어가 유일한
가드이며(data-access-security), scope는 단일 workspace key라 호출자 구분이 감사 로그에만
의존한다(scope-gateway). 운영 전에 "누가 무엇을 언제" 했는지 조회 가능한 영속 기록이 필요하다.

## What Changes

- **신규 append-only 테이블 `bff_audit_logs`** — 감사 이벤트 1행. `kind ∈ {scope_call,
  data_access}`, `actor_id`(호출 시점 스냅샷 role 동반), `action`, `target`(data_access의
  테이블명), `detail`(scope_call의 ScopeFilter 스냅샷).
- **sink 교체**: `lib/audit.ts`가 콘솔 대신 `bff_audit_logs`에 기록. **함수 시그니처는 동기
  `void` 불변** → 기존 호출부 9파일·28지점 diff 0줄.
- **fire-and-forget 시멘틱**(승인): `after()`(next/server)로 응답 후 insert. request context
  밖(백그라운드 등 `after()` 미지원)이면 즉시 비동기 insert로 폴백. 어떤 컨텍스트에서도
  throw 금지. sink 쓰기 실패 시 원본 payload를 `console.error`로 폴백(무음 유실 금지).
  `console.info` sink는 제거(폴백 `console.error`만 유지).
- **재귀 금지**: `bff_audit_logs` insert 자체는 `auditDataAccess` 대상 아님.
- **retention v1 무기한, 조회 UI 없음**(승인) — repository는 insert 계열만 export(v1 read 미노출).

## Capabilities

### Modified Capabilities
- `data-access-security`: 보상 통제의 "데이터 접근 감사 로그"가 **영속 append-only sink로 확정**
  (콘솔 placeholder → `bff_audit_logs`). 신규 감사 테이블도 lockdown(anon revoke) 대상.
- `scope-gateway`: 강제 레이어가 남기는 "감사"가 **영속 sink에 fire-and-forget으로 기록**됨을 명시.

## Impact

- **DB/스키마**:
  - `lib/db/schema.ts` — `bffAuditKindEnum` + `bffAuditLogs`(id/ts/actor_id/actor_role/kind/
    action/target/detail, 인덱스 (ts)·(actor_id, ts)). **FK 없음(의도)**: 계정 삭제 후 감사 행
    생존. additive-only(0007 교훈).
  - 마이그레이션 `lib/db/migrations/0033_bff_audit_logs.sql` — 손작성 멱등(`DO $$` enum 가드 +
    `IF NOT EXISTS`), `npm run db:apply -- 0033`로 적용(원장은 0019 동결).
- **Repository**:
  - `lib/db/repositories/bff-audit-logs.ts`(신규) — insert 전용. `@/lib/db` 경계 준수.
- **감사 sink**:
  - `lib/audit.ts` — sink 교체 + `after()` dispatch + `console.error` 폴백, `console.info` 제거.
- **테스트**:
  - `lib/audit.test.ts`(신규) — scope_call/data_access 행 형상, insert reject no-throw+폴백,
    request context 부재 no-throw.
- **문서**: README·docs/development-guide.md·qa-matrix의 "placeholder/영속 미구현" 서술 갱신.
- **후속(제품 책임자 실행 단계, 이 change 범위 밖)**: 마이그 0033 prod 적용 → `scripts/db/lockdown.sql`
  재실행 → 신규 테이블 anon 권한 `has_table_privilege(...)=false` 실측.
