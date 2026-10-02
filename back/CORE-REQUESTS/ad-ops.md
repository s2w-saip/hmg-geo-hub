# core 요청: ad-ops 그룹 (admin.citation_sources.overrides · admin.cycles.cycles · admin.cycles.jobs · admin.accounts.users · admin.integrations.ga4 · admin.integrations.keyword_tools · admin.changes.queue)

작성: ad-ops 빌더 (2026-09-28, 브랜치 feat/ad-ops, 기준 stg 0092400). 막힌 기능은 없다. 아래는 기능 안에 임시로 둔 것을 core 로 옮기거나
계약으로 굳혀 달라는 요청이다. 각 항목은 무엇·왜·제안 시그니처·지금 우회 위치 순서로 적는다.

## R1. 외부 서비스 설정 키를 core.config 로 이관

- 무엇: Supabase Admin·GA4 서비스 계정·OpenRouter 설정. 지금은 기능 안 설정 모델이 HGH_ 접두 env 를 직접 읽는다.
  - `HGH_SUPABASE_URL`, `HGH_SUPABASE_SERVICE_ROLE_KEY`(SecretStr), `HGH_SUPABASE_TIMEOUT_S`: `admin/accounts/users/adapters.py`
  - `HGH_GA4_CREDENTIALS_JSON`(SecretStr, 서비스 계정 JSON), `HGH_GA4_TIMEOUT_S`: `admin/integrations/ga4/adapters.py`
  - `HGH_OPENROUTER_API_KEY`(SecretStr), `HGH_OPENROUTER_MODEL`, `HGH_OPENROUTER_URL`, `HGH_OPENROUTER_TIMEOUT_S`: `admin/integrations/keyword_tools/adapters.py`
- 왜: stg·prod 필수 여부 검증(load_settings)과 비밀값 취급(repr 마스킹)을 한 곳에서 해야 한다. intent(IN-1 serp-drafts LLM)·projects 도 같은 키를 쓴다.
- 제안: `Settings` 에 `supabase_url: str | None`, `supabase_service_role_key: SecretStr | None`, `ga4_credentials_json: SecretStr | None`,
  `openrouter_api_key: SecretStr | None`, `openrouter_model: str = "google/gemini-2.5-flash"`, `openrouter_url: str`, 각 timeout.
  이관되면 기능 어댑터의 `load_*_settings()` 를 `get_settings()` 읽기로 바꾼다(어댑터 시그니처는 그대로).

## R2. 외부 호출 전에 api_ro 커넥션을 놓는 세션 사용자 의존성

- 무엇: `CurrentUser` 는 `RoConn`(api_ro REPEATABLE READ 트랜잭션)을 요청 끝까지 쥔다. 외부 호출이 있는 엔드포인트
  (POST·DELETE /v1/admin/users = Supabase, PUT /v1/admin/ga4/properties/{id}?verify = GA4, POST /v1/admin/keyword-tools/to-prompt·prompt-to-volume = LLM 최대 180초)
  에서 읽기 커넥션이 idle in transaction 으로 남는다(core.db 규약 "외부 호출은 커넥션을 쥔 채 하지 않는다"와 어긋남).
- 지금: 쓰기 트랜잭션은 외부 호출 전후로 나눠 `get_db().write(uid)` 로 직접 연다(쓰기 트랜잭션은 쥐지 않는다). 읽기 커넥션은 core 없이는 못 놓는다.
- 제안: `async def get_principal_detached(request) -> Principal` (짧은 api_ro 트랜잭션에서 계정만 읽고 닫음) +
  `CurrentUserDetached = Annotated[Principal, Depends(get_principal_detached)]`. 필요한 읽기는 핸들러가 `get_db().read()` 로 짧게 연다.

## R3. DB 제약 위반 → API 오류 변환 헬퍼

- 무엇: SQLAlchemy 로 감싼 asyncpg 예외에서 (SQLSTATE, constraint_name) 을 꺼내 23514→422 constraint_violation(제약명),
  23503→422, 23505→409, 22xxx→422 로 바꾸는 코드가 기능마다 생긴다.
- 지금: `admin/accounts/users/service.py` `_err_info`·`db_error`, `admin/citation_sources/overrides/service.py`·`admin/integrations/ga4/service.py` `_sqlstate`.
- 제안: `app/core/errors.py` 에 `def db_error_info(e: BaseException) -> tuple[str | None, str | None]` 와
  `def from_db_error(e: BaseException, *, messages: dict[str, str] | None = None) -> ApiError | None`.

## R4. 공통 필터를 받지 않는 엔드포인트의 ignored_filters 헬퍼

- 무엇: 공통 필터 축이 없는 목록 API(계정·GA4)도 들어온 공통 축(brand·country·from/to·cf.* 등)을 조용히 무시하지 않고 meta.ignored_filters 로 드러내야 한다.
  CommonFilters 를 받지만 resolve_read_context 를 부르지 않는 목록(회차 목록)도 같은 계산이 필요하다.
- 지금: `admin/accounts/users/router.py`·`admin/integrations/ga4/router.py` `ignored_common(request)`, `admin/cycles/cycles/service.py`
  `sorted(q.provided() - LIST_SUPPORT.for_surface(q.surface))`.
- 제안: `app/core/filters.py` 에 `def ignored_axes(query_params, support: FilterSupport | None, surface: str | None = None) -> list[str]`
  (from·to → period, cf.* → custom).

## R5. 키워드 정규화·DataForSEO 지역 프리셋 공유 위치

- 무엇: term_norm(NFC → trim → lower), sanitizeKeywords, 지역 프리셋 29개(현행 location-presets.ts). intent.keywords·적재기 dfs_fetch 처리기와 한 벌이어야 한다
  (모듈-고객-관심 §3 "적재기와 한 벌을 공유").
- 지금: `admin/integrations/keyword_tools/keywords.py`.
- 제안: `app/core/keywords.py`(`term_norm(s) -> str`, `sanitize(s) -> str`, `PRESETS`, `preset_by_id`, `preset_by_location`) 로 옮기고 적재기도 import.

## R6. 운영 요청 큐 payload 계약(적재기 소비 측과 합의 필요)

core.write.enqueue_change 문서(또는 DECISIONS)에 kind 별 payload 를 계약으로 적어 달라. 이 그룹이 쓰는 형태:

| kind | subject | payload |
| --- | --- | --- |
| citation_override | subject_texts=[domain] | `{op: set\|clear, domain, category_key(새 값, clear 면 null), old: {category_key, note}\|null, new: {category_key, note}\|null}` |
| cycle_admin | subject_uuids=[cycle_id] | `{cycle_id, op: hide\|unhide\|close\|set_view_date, hidden_scope: all\|citations, reason, closed_by: operator, view_date, expected_generation, old: {status, view_date, hidden_scope, hidden_reason}}` |
| anchor_pin | subject_uuids=[job_id] | `{job_id, anchor, reason, old: {anchor, reason}\|null}` |
| answer_drop | subject_uuids=[job_id] | `{job_id, reason}` |
| ga4_property | subject_texts=[property_id] | `{op: upsert\|delete, property_id, old: {brand_code, country_code, status[, tracked_events]}\|null, new: {…}\|null}` |
| ga4_tracked_event | subject_texts=[property_id] | `{op: replace, property_id, old: [event], new: [event]}` |
| dfs_fetch | subject_texts=["search_volume:<loc>:<lang>", …정렬된 term_norm] | `{endpoint: search_volume, terms, location_code, language_code, requested_via}` |

- dfs_fetch 는 intent.keywords.fetches(IN-1)도 같은 kind 를 쓴다. subject 규칙이 다르면 dedupe(같은 kind·주체 대기 중 409)가 두 경로 사이에서 작동하지 않는다.
  subject 규칙을 하나로 정해 달라(제안: 위 형태).
- 갱신(검증 D4): dfs_fetch 는 기능 쪽에서 term 단위 dedupe 를 한다(`keyword_tools/queries.py` PENDING_OVERLAP_SQL: 같은 지역·언어의
  대기·진행 중 요청의 payload.terms 와 겹치는 term 은 빼고 나머지만 새 요청). 주체가 아니라 payload(endpoint·location_code·language_code·terms)로
  판정하므로 IN-1 이 같은 payload 형태를 쓰면 두 경로 사이에서도 작동한다. payload 형태를 계약으로 굳혀 달라. language_code 는 프리셋 언어만 받는다.
- 같은 kind·같은 주체 대기 요청이 있으면 409 duplicate_pending 이라, 한 회차에 숨김 요청이 대기 중이면 노출일 요청도 막힌다(cycle_admin 한 kind).
  의도라면 그대로, 아니면 dedupe 키에 payload.op 를 넣는 옵션(`dedupe_on_op: bool`)이 필요하다.

## R7. DB: GA4 시장 유일성 제약(제안)

- 무엇: 현행 ga4_properties 는 (brand, country) 유니크였다. DB-v2 app.ga4_property 는 PK property_id 뿐이라 같은 시장을 두 속성이 가리킬 수 있다.
- 지금: PUT 에서 `SELECT … FOR UPDATE`(대상 행) + 시장 중복 조회로 409 market_taken. 서로 다른 속성 id 두 요청이 동시에 오면 둘 다 통과할 수 있다(경합).
- 제안: `CREATE UNIQUE INDEX ga4_property_market_uq ON app.ga4_property (brand_code, country_code) WHERE brand_code IS NOT NULL;`
  (D8 무관, 인덱스). 적용되면 23505 → 409 market_taken 으로 바꾼다.

## R8. 테스트 기반: pytest 모듈 이름 충돌과 rd 시드

- 모듈 이름 충돌: 기능 `tests/__init__.py` 가 있고 상위(`app/features/admin/changes/`)에 `__init__.py` 가 없어 pytest(prepend) 가
  `queue.tests.test_*` 로 import → 표준 라이브러리 `queue` 와 충돌해 수집 실패. 담당 7기능의 `tests/__init__.py` 를 지우고 파일명을
  `test_ad_ops_<기능>.py` 로 고유하게 했다. 제안: pyproject `addopts = "--import-mode=importlib"` 또는 생성기가 중간 디렉터리 `__init__.py` 를 만들기.
- rd 시드: 정적 가드(test_feature_sql_passes_guard)가 기능 테스트 파일의 rd INSERT·DELETE 문자열도 G6 로 막는다. GA4·키워드 테스트는
  합성 픽스처에 데이터가 없어 소유자 접속 `copy_records_to_table`(SQL 문자열 없음)로 무작위 키에 시드하고 rd 행은 지우지 않는다(복제본에 누적).
  제안: `tests/support.py` 에 `seed_rd(conn, table, rows)`·정리 헬퍼, 또는 `tests/fixtures` 에 GA4·키워드 합성 행 추가.
- 갱신(2026-09-28 수정 라운드, 검증 D6): 반복 실행마다 rd 가 늘던 문제는 기능 쪽에서 막았다. 시드 키를 KST 날짜로 고정하고
  (GA4 속성 `9<YYYYMMDD>001`·이벤트 `*_s<YYYYMMDD>`, 키워드 `t-kw-s<YYYYMMDD> *`) 이미 있으면 넣지 않는다. 같은 날 재실행은 rd 행 불변
  (실측: 3회 연속 실행 뒤 kw_volume_monthly 27·ga4_row 15·ga4_dim_property 3 고정, 회귀 테스트 test_d6_rd_seed_idempotent 2건).
  남는 한계: 날짜가 바뀌면 한 벌(키워드 3행·GA4 5행+차원 3행)이 더 쌓인다. 지우려면 가드 밖(tests/support.py)의 정리 헬퍼가 필요하다(위 제안 유지).

## R9. taxonomy: 회차 경로 이름

- `/v1/admin/cycles/{cyc_key}` 의 경로 이름이 내부 정수 키다. 응답 규약(core.envelope: 내부 정수 키 비노출)과 맞추려면 `{cycle_id}` 가 맞다.
  지금은 경로를 바꾸지 않고 cycle_id(uuid, 공개 식별자)와 정수 cyc_key 를 둘 다 받으며 응답에는 cycle_id 만 싣는다. taxonomy 개정 여부 결정 필요.

## R10. 공통 필터: cf.*·표면에 안 맞는 project_id 도 ignored_filters 로(검증 D3)

- 무엇: `resolve_read_context` 는 `custom_fields` 를 넘겨야만 cf.* 를 축으로 센다. 호출자가 넘기지 않으면 cf.* 가 조용히 버려진다.
  또 global 표면에서 `project_id` 는 쓰이지 않는데 `CommonFilters.provided()` 가 세지 않아 ignored_filters 에 안 나온다.
- 지금(기능 방어): 후보 조회는 라우터에서 `parse_custom_fields(request.query_params)` 를 넘기고 global + project_id 면 서비스에서
  ignored_filters 에 `project_id` 를 더한다(`citation_sources/overrides/service.py`). 회차 목록도 cf.* 를 `custom` 으로 드러낸다
  (`cycles/cycles/service.py`, R4 헬퍼가 생기면 그것으로 바꾼다). 회귀 테스트 test_d3_* 2건.
- 제안: `CommonFilters.provided()` 가 global 표면의 project_id 를 `project_id` 로 돌려주거나, `resolve_read_context` 가 표면에 맞지 않는
  project_id 를 ignored 로 싣는다. cf.* 는 `request.query_params` 에서 core 가 직접 읽는 의존성(`CommonFiltersWithCustom`)을 두면
  기능마다 빠뜨리는 일이 없어진다.

## R11. DB: 마지막 실효 admin 보호(선택, 검증 D1)

- 무엇: 앱은 PATCH·DELETE 에서 "실효 admin"(role admin ∧ active ∧ (menu_groups null ∨ 'admin' 포함))이 0명이 되는 변경을 409 로 막는다
  (`accounts/users/queries.py` OTHER_ADMINS_SQL 은 실효 admin 을 FOR UPDATE 로 잠그고 센다). DB 직접 쓰기·다른 경로는 이 보호를 거치지 않는다.
- 제안: app.user_account 에 제약 트리거(AFTER UPDATE OR DELETE, DEFERRABLE)로 실효 admin 수 ≥ 1 을 단언. 채택 여부는 DB 담당 판단.
