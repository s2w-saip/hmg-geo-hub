# core·DB 요청: 적재 파이프라인(ingest, IG-1·IG-2·IG-3)

작성 2026-09-28, 브랜치 feat/ingest(stg 0092400 기준). 표기: **차단** = 완료 게이트·기능을 막음, 개선 = 우회 구현 있음.

## R2 (차단: 완료 게이트) tests/core/test_app.py 경로 수 상수

- 무엇: `test_openapi_keeps_feature_stubs` 의 `n == 171 and len(paths) == 136` 을 **174 / 139** 로.
- 왜: 과업이 허용한 `app/features/__init__.py` 한 줄(`("ingest.pull.ops", "ingest.pull.ops.router")`)로 운영 조회 GET 3개
  (`/v1/admin/ingest/status·backlog·loads`)가 등록된다. 다른 기능은 501 스텁을 교체해 수가 그대로지만 ingest 는 스텁 라우터가 레지스트리에 없었다
  (taxonomy.json HTTP 176건 중 3건). 이 상수 하나 때문에 `pytest -q` 가 1건 실패한다(그 밖 129 통과, ingest 42 통과).
- 막힌 것: 완료 게이트의 "pytest -q 전체 통과". 기능 동작은 영향 없음.
- 2026-09-28 수정 라운드(검증 결함 D4) 재확인: 여전히 `assert (174 == 171)` 1건 실패. 기능 쪽에서 고칠 수 없다(tests/core 는 core 소유).

## R3 (차단: 검증 결함 D4) pytest testpaths·CI ruff 대상에 ingest 추가

- 무엇: ① `pyproject.toml` `[tool.pytest.ini_options] testpaths = ["tests/core", "app", "ingest"]`
  ② `ci/github-workflows/back-ci.yml` ruff 스텝 `ruff check app tests conftest.py ingest`(지금은 ingest 를 검사하지 않는다).
  ingest 테스트 일부는 `fresh_db`(CI DB 를 템플릿으로 `CREATE DATABASE`)를 쓰므로 CI 연결 롤은 지금처럼 슈퍼유저여야 한다.
- 왜: 이 빌더가 고칠 수 있는 pyproject 범위는 ruff exclude 뿐이다. 지금 `pytest -q` 는 ingest 테스트를 모으지 않는다(`pytest -q ingest` 로 따로 돈다).
  CI 가 ingest 를 안 돌리면 IG-2 동치 테스트(핵심 수용 기준)가 회귀를 못 잡는다.

## R1 (개선) loader 풀·적재 설정을 core 로

- 무엇: `core.config` 에 loader 연결(직접, PgBouncer 미경유)·Scope·DataForSEO·시스템 행위자 키, `core.db` 에 loader 연결 공장(세션 TimeZone UTC,
  statement 캐시 끔, 트랜잭션 로컬 statement_timeout 180s·lock_timeout 5s, 선택 SET ROLE).
  제안 시그니처: `Settings.ingest_db_url: SecretStr | None`, `scope_api_url`, `scope_api_key: SecretStr`, `dfs_*`, `ingest_system_actor: UUID`;
  `core.db.loader_connect() -> asyncpg.Connection`.
- 왜: core 에 loader 풀이 없어 `ingest/common/config.py`(HGH_INGEST_* env)·`ingest/common/db.py`(asyncpg 직접)에 두었다. 워커 SQL 은 ing·rd 쓰기라
  API 경계 가드(G3·G6) 대상이 아니고 SQLAlchemy 엔진 가드를 걸면 안 된다(가드 없는 별도 연결이 맞다).
- 막힌 것: 없음(기능 안 설정으로 동작). 이관 시 `ingest.common` 두 파일을 core 호출로 바꾼다.

## R4 (개선, 성능) loader 의 ANALYZE 권한

- 무엇: `rd.analyze_leaves(p_rel regclass[])` SECURITY DEFINER 헬퍼(허용 목록 = rd 사실 표 부모·leaf) 또는 `GRANT MAINTAIN ON rd.answer, answer_brand,
  answer_stance, citation, job TO loader`(+ `rd.ensure_leaf` 가 새 leaf 에도 MAINTAIN 부여).
- 왜: 설계는 "전파 직전 ANALYZE"(seed-40 §8 실측: 없으면 5만 청크 전파 10분+, 있으면 1.3초)와 "커밋 뒤 건드린 leaf ANALYZE" 를 요구하는데
  loader 는 소유자가 아니라 `WARNING: permission denied to analyze … skipping` 으로 건너뛴다(로컬 확인). 코드는 이미 ANALYZE 를 부른다.
- 막힌 것: 대량 적재 첫 트랜잭션의 계획 품질(RDS 실측 게이트 전 위험).

## R5 (개선, 성능) ing.citation URL 조회 인덱스

- 무엇: `CREATE INDEX citation_url_hash_idx ON ing.citation USING hash (url)`(파티션 부모 선언, D8 무관).
- 왜: URL 차원(host·도메인·제목 최빈)은 그 URL 의 전 인용 행에서 다시 센다(bulk 시드와 같은 전역 값). 지금은 적재마다 `url IN (…)` 로 ing.citation 전 leaf 를
  순차 스캔한다. 10배(인용 470만)에서 적재당 수 초. 2026-09-28: 재pull 로 인용이 빠진 URL 의 dim_url 정리(`URL_ORPHANS_DELETE`)도 같은 `url =` 조회를 한다.

## R6 (개선, 정확도) 공개 접미사 목록(PSL) 이관

- 무엇: 현행 `lib/public-suffix/data.ts` 를 Python 데이터 모듈(또는 app 참조 표)로.
- 왜: `ing.citation.domain_label`(등록 가능 도메인) = 현행 registrableDomainOfHost(sync.ts:1341, PSL). 지금은 2단 접미사 목록 근사(`ingest/pull/sync/stage.py`).
  목록 밖 다단 접미사(예 `*.gov.sg`)는 도메인이 달라져 출처 그룹 키가 갈린다.

## R7 (개선, 낮음) 운영 조회 뷰의 security_barrier

- 무엇: `rd.v_ingest_load`·`rd.v_ingest_backlog` 를 security_barrier 없이(행 필터가 없는 원장 발췌 뷰) 또는 정렬 키 인덱스가 먹는 형태로.
- 왜: EXPLAIN(api_ro): 키셋 술어(`load_id < :k`)는 PK 로 내려가지만 `ORDER BY … LIMIT` 이 뷰 위 Subquery Scan 에서 정렬돼 첫 페이지가 전 원장을 정렬한다.
  원장 규모(10배에서도 수십만 이하)라 위험 low.

## R8 (차단: 기능 일부) app 단방향 동기화 잡(Q15)

- 무엇: 병행 기간 구 시스템 → 새 app 표 단방향 동기화의 ① 쓰기 롤(loader 는 app DML 이 없고 migrator 는 app SELECT 만), ② 원천 어댑터 계약
  (구 hmg-geo DB 스냅샷 또는 mig_src 스테이지, `migration/export.py`·seed-10 매핑 재사용 여부), ③ 화면 그룹 동결·원자 전환 규칙(`mig.screen_group.state`).
- 왜: Q15 가 이 잡을 ingest 소유로 정했지만 위 셋이 정해지지 않아 구현하지 않았다(Scope 이중 pull 은 구현: 가짜 원천으로 시험).
- 막힌 것: ingest.pull.sync 의 app 동기화 부분(상태 partial). 검증 결함 D5(2026-09-28): 이 결정을 받아 구현·재검증하기 전까지 ingest.pull.sync 는 완료가 아니다.
  결정 요청 항목 = ① 쓰기 롤(loader 에 app 대상 표 DML 부여 vs 전용 sync 롤) ② 원천 어댑터 계약 ③ `mig.screen_group` 동결·원자 전환 규칙.

## R9 (계약) judgment_change 페이로드(생산자: AD-4·QA-2·IN-1·PJ)

이 모듈이 소비하는 형태(`ingest/cycles/ledger/service.py`·`ingest/cycles/workers/dfs.py`). 생산자 쪽 enqueue 와 맞춰 주세요.

| kind | subject | payload |
| --- | --- | --- |
| cycle_admin | - | `{cycle_id, op: hide|unhide|close|set_view_date, hidden_scope: all|citations|mentions, reason: operator|collection_error, view_date: YYYY-MM-DD}` |
| report_publication | subject_uuids = [publication_id] (또는 payload.publication_id) | - |
| anchor_pin | - | `{job_id, anchor: YYYY-MM-DD, reason, op: set|remove}` |
| answer_drop | - | `{job_id, reason, op: drop|restore}` |
| dfs_fetch | subject_texts = 키워드(또는 payload.keywords) | `{endpoint: search_volume|serp_organic|keyword_suggestions, keywords, location_code, language_code, project_id}` |
| project_* | subject_uuids = [app.project.project_id] | - |
| catalog·prompt_kind | 트리거가 채움(옛·새 scope_prompt_id) | 트리거 payload(prompt_id 로 catalog_entry 행 추적) |
| hidden_market·citation_override | subject_texts = 국가·도메인(선택) | - |
| entity | subject_uuids = entity_id | - |

아웃박스(`core.write.enqueue_scope`) 페이로드: `{body: <Scope 요청 본문>, scope_project_id?, scope_prompt_id?}`. id 가 없으면 워커가 app 에서 채우고,
생성 전이면 백오프한다. 생성 응답의 Scope id(project_id·prompt_id)는 워커가 app 에 되쓴다(행위자 = HGH_INGEST_SYSTEM_ACTOR).

## R10 (결정 필요) 발급 원장 차원의 참조 없는 행

- 전역 판정(엔티티 대표 표기, URL 최빈 도메인)이 뒤 적재에서 바뀌면 `rd.dim_brand_name`·`rd.dim_source` 의 옛 키가 참조 없이 남는다(재번호·재사용 금지 원칙).
  bulk 시드는 현재 입력에서 다시 만들어 그 행이 없다. 옵션 이름 목록이 차원을 직접 읽으면 옛 이름이 보일 수 있다 → 야간 감사 GC 여부 결정.
- 범위(2026-09-28 수정 라운드, 검증 결함 D6): 예외는 위 두 차원뿐이다. `rd.dim_url`·`rd.dim_entity` 는 원천(ing 인용·언급·스탠스·ACR 행)이 0 이 되면
  적재 트랜잭션에서 지운다(bulk 와 행 단위 동일, 정수 키는 IDENTITY 라 재사용 없음). 이 두 차원을 원장 예외로 바꾸려면 이 결정에 함께 올린다.

## R11 (개선) 스테이지 표 NOT NULL

- `ing.stage_answer (LIKE ing.answer)` 가 answer_key NOT NULL 을 복사해 스테이지에는 0 을 넣고 적재 트랜잭션에서 키를 채운다. 스테이지 answer_key 를 NULL 허용으로.

## R12 (정보) 외부 적재 소유

- `ga4_property`·`ga4_tracked_event` 큐 kind 와 GA4 일 적재(IG-4)는 소유 미정이라 워커가 집지 않고 대기로 둔다(watch 의 큐 대기 경보에서도 뺐다).

## R13 (개선, 검증 결함 D8) 비표면(admin) 엔드포인트용 무시 필터 도우미

- 무엇: `core.filters` 에 `ignored_filters(query_params, support: FilterSupport | None = None, *, extra: Iterable[str] = ()) -> list[str]`
  (쿼리 파라미터 이름 → 축 이름: `from`·`to` → period, `cf.<uuid>` → custom, 그 밖 CommonFilters 필드 이름). 표면 없는 엔드포인트도 쓸 수 있게.
- 왜: `FilterSupport` 는 표면 기반 해석(`resolve_read_context`)만 제공한다. ops 조회 3종은 표면이 없어 기능 안에서 파라미터 → 축 표를 만든다
  (`ingest/pull/ops/service.py`). 수정 라운드에서 표를 CommonFilters 선언에서 뽑게 바꿔 드리프트는 막았지만(`test_ignored_filter_params_follow_core_filters`),
  규약상 필터 해석은 core 소유다. 도우미가 생기면 이관한다.
- 막힌 것: 없음.
