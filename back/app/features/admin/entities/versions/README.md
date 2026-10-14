# admin.entities.versions · 운영 관리 / 엔티티 / 엔티티 버전 관리(E6)

설계 정본: `notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md` 3·7·8절, 제품 결정 26~29(a4-decisions-batch.md).
데이터 모델: `back/db/DB-v2.17-patch.sql` P94~P102. 적재기 계약: `back/ingest/project/apply/ecat_engine.py` 머리 주석(E4·E5).

## 엔드포인트(전부 admin 전용 + 메뉴 admin, 비관리자 403 `admin_only`)
| 메서드 | 경로 | 내용 · 주요 오류 |
| --- | --- | --- |
| GET | `/v1/admin/entities/versions` | 버전 목록 + active_ver·draft_ver |
| POST | `/v1/admin/entities/versions` | 초안 생성(활성 복사) · 409 `ECAT_DRAFT_EXISTS`·`ECAT_NO_ACTIVE` |
| GET | `/v1/admin/entities/versions/{ver}` | 상세(덮어쓰기 엔티티·표면·린트·지문) · 404 `ECAT_VERSION_NOT_FOUND` |
| PATCH | `/v1/admin/entities/versions/{ver}` | 초안 제목·사유 · 409 `ECAT_VERSION_STATE` |
| POST | `/v1/admin/entities/versions/{ver}/discard` | 초안 폐기(discarded, 열린 요청 rejected) |
| GET | `/v1/admin/entities/versions/{ver}/diff?against=` | 두 버전 차이(기본 based_on) |
| PUT | `/v1/admin/entities/versions/{ver}/entities/{entity_id}` | 역할·병합·모 브랜드·메모 · 422 `ECAT_MERGE_CHAIN`·`ECAT_MERGE_SELF`·`brand_required`·`invalid_brand`, 404 `ECAT_UNKNOWN_ENTITY` |
| POST | `/v1/admin/entities/versions/{ver}/entities` | 허브 엔티티 추가(origin hub) |
| DELETE | `/v1/admin/entities/versions/{ver}/entities/{entity_id}` | 덮어쓰기 행 삭제 · 409 `ECAT_ENTITY_IN_USE` |
| POST | `/v1/admin/entities/versions/{ver}/surfaces` | 표면 add·block · 422 `ECAT_SURFACE_ADD_GLOBAL`·`ECAT_SURFACE_EMPTY` |
| DELETE | `/v1/admin/entities/versions/{ver}/surfaces/{surface_id}` | 표면 끄기 |
| POST | `/v1/admin/entities/versions/{ver}/lint` | 린트 실행·저장 |
| PUT | `/v1/admin/entities/versions/{ver}/lint/acks` | L2 확인(키 교체) · 409 `ECAT_LINT_STALE`, 422 `ECAT_LINT_UNKNOWN_KEY` |
| GET | `/v1/admin/entities/applies` | 반영 목록 |
| POST | `/v1/admin/entities/applies` | 반영 요청(범위) = 미리보기 큐 · 422 `ECAT_LINT_BLOCKED`·`ECAT_LINT_UNACKED`·`ECAT_SCOPE_INVALID`·`ECAT_NO_DRAFT`, 409 `ECAT_APPLY_RUNNING`·`ECAT_APPLY_OPEN`·`ECAT_NO_ACTIVE`·`ECAT_VERSION_STATE` |
| GET | `/v1/admin/entities/applies/{apply_id}` | 상세(미리보기 JSON·큐·can_approve·actions) · 404 `ECAT_APPLY_NOT_FOUND` |
| POST | `/v1/admin/entities/applies/{apply_id}/preview` | 다시 미리보기(초안이면 린트 게이트 재실행) · 422 `ECAT_LINT_BLOCKED`·`ECAT_LINT_UNACKED`, 409 `ECAT_BASE_CHANGED`·`duplicate_pending` |
| POST | `/v1/admin/entities/applies/{apply_id}/approve` | 승인 · 403 `ECAT_EXPOSED_REQUIRES_APPROVAL`, 409 `ECAT_PREVIEW_STALE`·`ECAT_PREVIEW_PENDING`·`ECAT_APPLY_STATE`·`ECAT_LINT_STALE`, 422 `ECAT_LINT_BLOCKED`·`ECAT_LINT_UNACKED` |
| POST | `/v1/admin/entities/applies/{apply_id}/reject` | 거절(사유 필수) |
| POST | `/v1/admin/entities/applies/{apply_id}/resume` | 재개(failed → resume, 오류로 멈춘 approved → apply) |
| POST | `/v1/admin/entities/applies/{apply_id}/abandon` | 포기(failed → op abandon, 사유 필수: 범위 회차를 반영 전 버전으로 되돌려 투영 → rejected `ECAT_APPLY_ABANDONED`, 활성 버전 유지) · 409 `ECAT_APPLY_STATE`·`duplicate_pending` |
| POST | `/v1/admin/entities/applies/{apply_id}/rollback` | 되돌리기(이전 버전 내용 rollback 초안 + 같은 범위 요청) |
| GET | `/v1/admin/entities/review` | 검토 대기함 |
| POST | `/v1/admin/entities/review/{review_id}/decision` | register(초안 반영)·dismiss · 409 `ECAT_REVIEW_DECIDED`·`ECAT_NO_DRAFT`·`ECAT_ROLLBACK_IMMUTABLE` |
| GET | `/v1/admin/entities/audit` | 감사(app.ecat_audit_log) |
| GET | `/v1/admin/entities/{entity_id}/mentions` | 언급 표본 문맥(접근 감사 data_access) |

초안 내용 편집(엔티티 PUT·POST·DELETE, 표면 POST·DELETE, 검토 register)은 되돌리기 초안(origin rollback)이면 409 `ECAT_ROLLBACK_IMMUTABLE`.

기존 `PUT /v1/admin/entities/{entity_id}`(admin.entities.registry)는 컷오버 뒤 409 `ECAT_LEGACY_WRITE`(쓰기 0), 전에는 현행 그대로.

## 규칙 메모
- 쓰기마다 같은 트랜잭션에서 `app.ecat_audit_log` 한 행 이상(행위자 = app.actor(), request_id). no-op 은 쓰기·감사 없음.
- 초안 편집 → 그 초안의 draft·previewed·approved 반영을 낡음 표시(approved → previewed, error `ECAT_PREVIEW_STALE`). 미리보기 전(draft)
  요청도 표시하고, 승인은 저장된 린트의 내용 지문이 지금 내용과 같아야 한다(409 `ECAT_LINT_STALE` → 다시 미리보기가 린트를 다시 돈다).
- 린트 게이트(요청·다시 미리보기) 면제 = 되돌리기 초안 ∧ 내용 지문 = 되돌릴 버전 지문. 되돌리기 초안은 내용 편집 불가(이중 방어).
- 린트는 기준 버전 대비: 기준에 이미 있던 비무결성 L3 는 INFO(차단 아님), 자사 편집 L2 는 새로 생기거나 바뀐 행만. 순환·체인·자기 참조는 항상 L3.
  전역 차단 표면은 추적 엔티티 표면(관측·대표 표기·이름·add 표면)과 같으면 L2 에스컬레이션. L2 확인 키 = 코드|대상|내용 지문.
- L2 확인 저장은 키 집합이 같으면(순서만 다름) 쓰기·감사 없음.
- 전역 차단 대조에 자사(추적) 엔티티와 자사로 귀속되는 엔티티(제품 등)의 Scope 관측 표면·이름을 더한다(검증 N4·N4 잔여·N7): 새 전역
  차단이 있을 때만. 자사 귀속 판정 = lint.RollupRule(투영 오버레이와 같은 규칙: 덮어쓰기(자기 → 병합 대상) 우선, 없으면 접두 교정 J1
  app.ecat_hmg_prefix_id(seed pg_temp.hmg_prefix_id 사본) → 별칭 접기 → Scope 롤업, 2단, 제거 제외). 엔진 동치 = 표 시험
  ingest/project/apply/tests/test_ecat_lint_parity.py(규칙마다 실제 엔진 투영과 대조, 접두 함수 사본 = 원본 대조). 조회: 자사 귀속 후보
  엔티티(차원 rd.dim_entity 표시 브랜드가 자사이거나 대표 표기가 3사 접두 후보) ∪ 추적·별칭·덮어쓰기 id 의 언급을 뷰 rd.v_entity_mention_surface
  (DB-v2.17 P104)에서 admin_long 으로 최근 N개월(기본 3) 읽어 (엔티티, 롤업, 표시명, 원문) distinct 뒤 정규화 적중만(상한 5000). 언급 표 표시명
  술어는 색인이 없어 쓰지 않는다. 조회 실패는 린트를 막지 않고 observed_source 에 남는다.
- 반영 상세(GET)·포기 응답의 `abandon_pins`: 포기 전(failed) = 예정(pins_before, 적재기 포기 절과 같은 규칙), 포기 중·포기로 닫힘 = rd.cycle.ecat_ver
  실측. 고정 회차는 이후 unexposed 반영에서 빠지고, 그 회차를 범위에 넣는 반영은 승인자 승인이 필요하다(화면 고지, 검증 N2).
- 린트 관측 표면 = 허브 표면 정의(활성·초안 add)·검토 대기함 새 표면·rd.dim_entity 대표 표기. ing.mention.surfaces 전수 충돌은 보지 않는다(근사).
- 노출 판정·영향 계산·KPI 전후는 적재기(E4)가 한다. 승인 게이트는 `preview.requires_approval` 과 `app.rule_param ecat_approvers`.

## 파일
- `router.py` · `schemas.py` · `service.py` · `queries.py` · `dberr.py`(DB 트리거·색인 오류 → 코드) · `tests/`(ecat6.pgsql = 준비·정리 문장)

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/admin/entities/versions?view=gate`(B084): 활성·초안 번호만(items = [], status·limit 무시). 하위 화면 게이트용. 기본 full = 종전.
- `GET /v1/admin/entities/versions/{ver}?view=lint`(B087): 버전 요약·content_md5·lint 만(값은 full 과 같다), entities·surfaces = [](반영 상세 화면 보조).
- `POST /v1/admin/entities/versions`(초안 생성)·`PATCH /v1/admin/entities/versions/{ver}`(초안 수정)의 `?return=minimal`(B085): 버전 요약(version)만,
  content_md5·lint = null, entities·surfaces = [](화면이 번호만 쓰고 다시 읽을 때). 기본 full = 종전.
