# admin.accounts.users · 운영 관리 / 계정·권한 / 계정 CRUD·감사

설계 단위: AD-5 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/users` | low |
| POST | `/v1/admin/users` | low |
| GET | `/v1/admin/users/{user_id}` | low |
| PATCH | `/v1/admin/users/{user_id}` | low |
| DELETE | `/v1/admin/users/{user_id}` | low |
| GET | `/v1/admin/users/{user_id}/audit` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
- `adapters.py` Supabase Auth Admin 어댑터(주입: `get_auth_admin`). 설정은 core.config(`supabase_url`·`supabase_service_role_key`·`supabase_timeout_s`)

## 구현 메모(2026-09-28)
- 감사: app.permission_audit_log 는 DB 트리거가 쓴다(DB-v2.3 P31). 스코프 참조 검증·권역 참조 보호도 DB 트리거(23503 → 422 `unknown_scope_ref`).
- 생성: 사전 검증(쓰기 트랜잭션에 넣어 보고 롤백) → Supabase createUser → INSERT → 실패 시 보상 삭제(실패면 502 `compensation_failed`).
  admin 은 scope_all 강제(명시 false 는 422), 임시 비밀번호는 응답에만 1회.
- 수정: `If-Match: <row_version>` 필수(없으면 428). 가드 순서 vendor operator 422 → 자기 강등·정지 409 `self_demote`·마지막 admin 409
  → menu_groups ⊆ 역할 허용 그룹 422 → row_version 409 → CHECK 422(제약명).
  - 강등 판정은 "실효 admin"(role admin ∧ active ∧ (menu_groups null ∨ 'admin' 포함)) 기준이다. admin 메뉴 그룹만 빼도 관리 화면에서
    잠기므로 강등으로 본다(자기면 `self_demote`, 남는 실효 admin 0 이면 `last_admin`). 삭제의 마지막 admin 보호도 같은 정의.
  - scope_all 을 명시하지 않은 PATCH: admin 에서 다른 역할로 내리거나 비어 있지 않은 스코프 배열을 명시하면 scope_all=false 로 해석한다
    (Q16 강제분이 강등 뒤에도 남아 요청보다 넓은 권한이 되는 것을 막음). scope_all=true 를 명시하면 배열을 비운다(현행 정규화).
- 삭제: 자기 삭제 409, 참조 기록(프로젝트 생성자·초대자·검수 기록) 있으면 409 `user_referenced`(정지로 처리), 인증 선삭제 → 앱 삭제 + Owner 승계.
- 비밀번호 재발급은 범위 밖(Q16). 최근 로그인은 Supabase 조회(실패 시 null + `meta.suppressed.last_sign_in_at`).
- Supabase 를 부르는 엔드포인트(목록·단건·생성·삭제)는 `CurrentUserDetached`: 게이트도 Detached principal 로(같은 코드 `admin_only`·`menu_forbidden`),
  읽기는 `RoSession`(짧은 api_ro), 쓰기는 `get_db().write`. 외부 호출 중 요청 api_ro 커넥션 0(회귀 테스트).
- 마지막 실효 admin 은 앱이 409 `last_admin` 으로 먼저 막고, DB 제약 트리거 `ua_last_admin`(DB-v2.6 P50, 커밋 때 23514)이 최후 방어
  (`service.db_error` 는 409 `last_admin` 으로 바꾼다. 앱 판정을 우회한 직접 쓰기·api_rw 쓰기가 커밋에서 거부되는 것은 회귀 테스트로 확인).
