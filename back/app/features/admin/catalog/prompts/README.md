# admin.catalog.prompts · 운영 관리 / 표준 카탈로그 / 표준 프롬프트 CRUD

설계 단위: AD-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/catalog/prompts` | low |
| POST | `/v1/admin/catalog/prompts` | low |
| GET | `/v1/admin/catalog/prompts/{prompt_id}` | low |
| PATCH | `/v1/admin/catalog/prompts/{prompt_id}/text` | low |
| PATCH | `/v1/admin/catalog/prompts/{prompt_id}/labels` | low |
| PATCH | `/v1/admin/catalog/prompts/{prompt_id}/regions` | low |
| PATCH | `/v1/admin/catalog/prompts/{prompt_id}/kind` | low |
| DELETE | `/v1/admin/catalog/prompts/{prompt_id}` | low |
| POST | `/v1/admin/catalog/prompts/{prompt_id}/restore` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, ad-content)
- 권한: 전 경로 `require_admin` + `require_menu_group('admin')`(admin 외 403 `admin_only`, 관리 메뉴 없는 admin 403 `menu_forbidden`,
  무인증·정지 401). 같은 화면(/admin/standards/prompts, 현행 route-policy group admin)을 받치는 bulk·reference 라우터도 같은 게이트(검증 D3).
  관리자는 전량(스코프 교집합 없음).
- 목록: 키셋(정렬 depth1·depth2·depth3 NULL 뒤, `left(text,256)`, prompt_id), 기본 100·최대 500. 지원 공통 축 = brand·funnel·
  brand_presence·list_type·depth1~3(app.prompt 열), 그 밖의 공통 축은 `meta.ignored_filters`. stats 는 루트 전체(필터 무관), deleted 는
  include_deleted 일 때만(현행 동일). scope_orphans = rd.dim_prompt(루트 project_key 가지치기) 중 어떤 app.prompt 도 연결하지 않은 수.
- 쓰기: app.prompt 만. 감사·재판정 요청(catalog·prompt_kind)은 트리거 `tg_catalog_change`. 응답 `change_ids` = 이번 트랜잭션에 트리거가 남긴 요청.
  Scope 반영 = `app.scope_outbox`(op create·update, payload = Scope 에 보일 필드의 현재 전체 상태: text·kind·regions·keywords·enabled).
  미연결 행은 대기 중 create 가 있을 때만 그 payload 를 갱신(현행: 미추적 행은 로컬만). lang·funnel_stage·depth* 는 로컬 전용.
- 상태 가드: 삭제된 행 수정·재삭제, 활성 행 복원은 409 `state_mismatch`(모듈-관리자 §2.1). 없음·루트 밖은 404.
- 시장 어휘 = rd.dim_project.regions(루트). 없으면 형식만 검사. 오류 코드 `invalid_region`·`region_out_of_vocabulary`·`invalid_lang`·`unknown_brand`.
- `{prompt_id}` 는 uuid 변환기(`{prompt_id:uuid}`)로 받아 `/prompts/export` 등 고정 경로를 가리지 않는다(OpenAPI 경로 표기는 그대로).
- `admin_common.py` = admin 기능 입력 도우미(목록 값 형식·트림·ILIKE·브랜드 FK 사전 검증). 무시 축(`meta.ignored_filters`)은
  core(`crud_meta`·`ignored_axes`)가 계산한다(메인 처분 2026-09-28: core 는 무시 축만, 도메인 입력 규칙은 기능).
- 자유 문자열 입력: 본문 `PgText`, 라벨·검색어 `PgLine`(core.filters: NUL·서로게이트, 한 줄은 제어 문자까지 422). 시장·언어는 코드 형식 검사.
- BG-44(값 갭 보강, 2026-09-28): 목록·상세 행에 `outbox_pending`(미완료 app.scope_outbox 행 있음)·`outbox_error`(미완료 행 중 가장 최근
  last_error) 추가(선택 필드). 완료 행(적용·superseded)은 보지 않는다. 쓰기 응답의 prompt 도 같은 술어로
  채운다(쓰기 트랜잭션 안에서 읽어 이번 쓰기의 outbox 행 포함, 변경 없는 요청은 기존 대기 그대로. 검증 D4: 전에는 null 이라 null 을 false 로 읽는 어댑터가
  '대기 없음' 으로 보였다).
  scope_outbox_aggregate_idx 접두 조회 행당 2회(페이지 상한 500).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- 쓰기 6종(`PATCH …/{prompt_id}/text`·`/labels`·`/regions`·`/kind`, `DELETE …/{prompt_id}`, `POST …/{prompt_id}/restore`)의 `?return=minimal`(B075):
  응답용 재조회 2문장(prompt 의 outbox 표시·이번 쓰기 change_ids)을 생략한다. prompt·change_id = null, change_ids = [], propagation 은 이번 쓰기의
  outbox 행만 본다(재판정 요청은 GET 상세 pending_changes). 쓰기·트리거·outbox 는 같다. 기본 full = 종전.
