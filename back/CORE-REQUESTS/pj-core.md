# core 요청: pj-core 그룹(PJ-1·PJ-2·PJ-4)

작성: pj-core 빌더(feat/pj-core, stg 0092400 기준, 검증 수정 라운드에서 R7·R8 추가·R1·R4 보강). 막힌 기능은 없다(전 엔드포인트 구현·테스트 통과). 아래는 우회 없이 기능 안에 둔
임시 구현을 core 로 옮기거나, core 규약 보강이 필요한 항목이다.

## R1. 프로젝트 모듈 공용 도우미 승격(권장)

- 무엇: `app/features/projects/project/core/shared.py` 의 공용 함수를 core(또는 core 가 지정하는 프로젝트 공용 모듈)로 옮긴다.
  - `normalize_url_for_match(raw) -> str` (현행 lib/scope/url-match.ts 1:1 이식. 적재기 타겟 인용 판정 `url_norm` 과 같은 규칙이어야 한다)
  - `canonical_http_url(raw, *, field) -> str` (http(s) 검증·정규화, 실패 422 invalid_url)
  - `rebuild_tracked_brand(rw, project_id) -> list[dict]` (현행 syncTrackedBrandCatalog 이식, PJ-1 PATCH·PJ-4 추적 대상 공용)
  - `resync_project_domain(rw, project_id) -> str | None` (대표 도메인 = 가장 먼저 등록된 owned base)
  - `engine_vocab(refs)`·`normalize_engines(values, refs)`·`default_engines(conn)` (rd.dim_engine·app.rule_param 기반 엔진 어휘)
  - `crud_meta(request, page=, source=)`·`ignored_filters(request, support)` (CommonFilters 를 받지 않는 CRUD 엔드포인트가
    들어온 공통 필터 축을 meta.ignored_filters 로 드러내는 방법)
  - `filters.query_axes() -> dict[str, str]` (쿼리 파라미터 이름 → 축 이름, CommonFilters 필드·별칭 파생). 검증 D8 이후 기능 안
    `shared._axis_params()` 가 CommonFilters.model_fields 에서 파생하지만, 축 이름표의 정본은 core 여야 한다.
  - `PgText`·`PgLine` (NUL·서로게이트·제어 문자 거부 Annotated str, 검증 D2). 모든 기능의 자유 문자열 입력이 같은 문제를 가진다.
- 왜: PJ-3(프롬프트)·적재 모듈(URL 정규화 패리티)·관리자 모듈이 같은 규칙을 다시 만들 위험. 특히 URL 정규화는 SQL 쪽 판정과
  글자 단위로 같아야 해서 정본이 하나여야 한다.
- 제안 시그니처: 위 그대로(`app.core.projects` 또는 `app.core.urls` + `app.core.envelope.crud_meta`).
- 막힌 기능: 없음(기능 안 구현으로 동작).

## R2. `core.write.enqueue_change` 대기 행 합치기 모드

- 무엇: `dedupe` 를 불리언 대신 `Literal["raise", "coalesce_pending", "off"]` 로. `coalesce_pending` = 같은 kind·주체의
  **pending**(running 제외) 행이 있으면 그 change_id 를 돌려주고 새 행을 넣지 않는다(running 이면 새 행: 적재기가 이미 옛 상태를 읽었을 수 있다).
- 왜: 설정 화면은 같은 프로젝트를 연달아 고친다(경쟁사 2개 추가 등). 현재 기본 `dedupe=True` 는 두 번째 편집을 409 duplicate_pending 으로
  막고, 409 를 잡아 기존 id 를 쓰면 running 행에 편집이 묻힌다. 그래서 owned_bases·tracked_urls·tracked_targets 는 `dedupe=False` 로
  매 편집 1행을 넣는다(정확하지만 큐에 같은 주체 대기 행이 쌓일 수 있음).
- 제안 시그니처: `async def enqueue_change(conn, kind, *, payload=None, subject_uuids=None, subject_texts=None, requested_by=None,
  dedupe: Literal["raise", "coalesce_pending", "off"] = "raise") -> int`
- 막힌 기능: 없음. 채택되면 세 기능의 `dedupe=False` 를 `"coalesce_pending"` 으로 바꾼다.

## R3. xlsx·multipart 의존성과 공용 xlsx 유틸

- 무엇: pyproject 에 `openpyxl`(xlsx 읽기·쓰기)과 `python-multipart`(UploadFile) 추가, `app.core.xlsx`(스트리밍 쓰기, 한도 있는 읽기) 신설.
- 왜: 공유 venv 에 둘 다 없다(`pip install` 금지). 추적 URL 내보내기·가져오기는 `settings/tracked_urls/xlsx.py` 에 표준 라이브러리
  (zipfile + ElementTree, DOCTYPE 거부·크기·행 한도)로 최소 구현했고, 가져오기는 multipart 대신 **요청 본문에 xlsx 바이트를 그대로**
  받는다(Content-Type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`). PJ-3 프롬프트 io 도 같은 문제를 겪는다.
- 제안: `build_xlsx(sheet_name, columns, rows) -> bytes`, `parse_xlsx(data, *, columns, max_rows, max_bytes) -> tuple[list[dict], list[str]]`,
  업로드는 `UploadFile` 로 전환(프론트 FormData 계승).
- 막힌 기능: 없음(현 구현 동작). 전환 시 가져오기 요청 형식이 multipart 로 바뀐다.

## R4. `resolve_project` 수준 'active_member'

- 무엇: `ProjectLevel` 에 `"active_member"`(활성 멤버 또는 admin, 비멤버는 404) 추가. owner·operate 수준도 비멤버는 403 owner_only 가
  아니라 404(존재 은닉)여야 한다(모듈-프로젝트.md §2, 검증 D1). 지금은 `shared.project_access` 가 403 이 나면 member 수준으로 다시
  판정해 비멤버면 404 로 바꾼다(쿼리 1회 추가).
- 왜: core `member` 수준은 비멤버 스코프 열람(2026-07-02 결정)을 허용하지만, 멤버 목록·멤버 감사·설정 조회·추적 URL 조회/내보내기·엔진 이력은
  현행이 멤버 전용이다(member/page.tsx:38-40, setting/_actions.ts requireMember). 지금은 `shared.require_member_view` 가 core 판정 뒤에
  한 번 더 좁힌다(넓히지 않음).
- 제안 시그니처: `resolve_project(conn, p, refs, project_id, level: Literal["member", "active_member", "owner", "operate", "owner_and_operate"])`
- 막힌 기능: 없음.

## R5. 운영자 global 분기의 스코프 대조(모듈-프로젝트 consistency_fixes[23])

- 무엇: `can_operate_project` 의 `operator == 'global'` 분기에서 프로젝트 brand_code·country_code 가 세션 스코프 안인지 확인.
- 왜: 설계 결정(DB-앱-도메인.md:42)인데 core 에 아직 없다. PUT /settings/engines(owner_and_operate)는 core 판정을 그대로 쓴다.
- 막힌 기능: 없음(core 반영 시 자동 적용).

## R6. 외부 호출 중 요청 커넥션 점유

- 무엇: 라이브 Scope 진단 어댑터(`settings/scope_link/adapter.py`, 기본 꺼짐)를 켤 경우, `CurrentUser` 가 RoConn 에 의존해 핸들러 동안
  api_ro 커넥션이 열려 있다. core.db 규약("외부 호출은 커넥션을 쥔 채 하지 않는다")을 지키려면 principal 조회 후 커넥션을 돌려주는
  의존성(예: `CurrentUserShort`)이 필요하다.
- 막힌 기능: 없음(운영 기본값은 호출 안 함, 계약 §5 "요청 경로에서 Scope API 금지"와 일치).

## R7. `DataScope.project_in_scope` 브랜드 NULL 프로젝트의 권역 국가 대조(검증 D1 근본 원인, 보안)

- 무엇: 프로젝트 `brand_code IS NULL` 이면 `if brand and country:` 분기를 건너뛰어 계정 권역(scope_regions) → 국가 대조가 빠진다.
  브랜드가 없어도 계정 권역이 있으면 `region_countries(계정 권역 전부)` 안의 국가만 통과시켜야 한다.
- 재현(검증자, ceacbf1): ADMIN 이 brand 없는 US·KR 프로젝트 생성 → KIA_EU(Kia, 권역 kia-western-europe = AT..SK) 가
  `resolve_project(level='member')` 를 통과(가시). pj-core 는 아래 기능 방어로 막았지만, core `member` 수준을 그대로 쓰는 다른 그룹
  (프롬프트·프로젝트 분석 등)은 같은 누출이 남는다.
- 기능 쪽 방어(이번 라운드): `shared.project_access` 가 core 판정 뒤 항상 "활성 멤버 또는 admin" 으로 좁힌다(비멤버 404, 쓰기 포함).
  그래서 pj-core 30개 엔드포인트는 비멤버 스코프 열람 경로를 쓰지 않는다. R4(active_member 수준)가 core 에 들어오면 이 방어를 걷는다.
- 막힌 기능: 없음.

## R8. SQLSTATE class 22(데이터 예외) → 422 최후 방어

- 무엇: core 전역 오류 처리기에서 DBAPIError 의 SQLSTATE 가 22xxx(22021 character_not_in_repertoire, 22P05 untranslatable_character,
  22001 string_data_right_truncation 등)면 500 internal 대신 422 unprocessable 로 응답. 지금은 `pagination._is_data_error` 가 커서 경로만 처리한다.
  asyncpg 는 NUL 을 `CharacterNotInRepertoireError`(22021)로 던진다.
- 왜: 검증 D2 에서 NUL(\u0000) 입력이 13개 이상 엔드포인트에서 500 이었다. 기능 쪽은 `PgText`·`PgLine` 입력 타입으로 422 를 내지만,
  새 필드가 이 타입을 빠뜨리면 다시 500 이 된다.
- 막힌 기능: 없음(기능 쪽 입력 검증으로 방어 중).

## 참고(적재 모듈 계약, core 아님)

- outbox 페이로드: `project:create|update` = {project_id, scope_project_id, name, description, domain, brand_code, country_code},
  `project:delete` = {project_id, scope_project_id}, `schedule:set_targets` = {project_id, engines, reenable}. 워커 계약 확정 필요(모듈 §10-1).
- judgment_change 페이로드: `project_owned_base` {op: add|remove, project_id, base_norm}, `project_target_url` {op: add|remove|import, project_id, …},
  추적 대상 `project_setting` {op, project_id, source: 'tracked_targets', …}(트리거의 project_setting 과 source 로 구분).
