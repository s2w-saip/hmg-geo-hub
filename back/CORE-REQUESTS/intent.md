# core·DB 요청: intent (keywords.tracked·research·fetches·serp_drafts, candidates.submit, social.context_map·prompts)

작성 2026-09-28 · 빌더 intent · 기준 stg 0092400. 각 항목은 무엇·왜·제안 시그니처·막힌 기능 순이다.
기능 경로 밖에 공용 파일을 둘 수 없어 intent 7기능 공용 도우미는 `app/features/intent/keywords/research/intent_common.py` 에 두고
나머지 기능이 import 한다. 아래 R1·R2·R7 이 core 로 들어오면 그 파일과 기능 안 설정 모델을 지운다.

## R1. term_norm·DataForSEO 국가 프리셋을 core 로 (core.codes 또는 core.kw): 적재기와 한 벌

- **무엇**: `term_norm(term) = NFC → trim → lower` 와 30개국 프리셋(ISO2 → location_code·language_code, 현행 lib/keyword/location-presets.ts).
- **왜**: rd.dim_keyword.term_norm 은 적재기(ingest dfs_fetch 처리기)가 쓰고 API 가 = 로 읽는다. 두 쪽 정규화가 다르면 조회가 전부
  missing 이 되고 같은 키워드를 거듭 수집·과금한다(모듈-고객-관심 risks). 적재기는 `app.features` 를 import 하면 안 되므로 core 가 맞다.
- **제안 시그니처**: `core.kw.term_norm(term: str) -> str`, `core.kw.PRESETS: dict[str, Preset]`, `core.kw.preset_of(country) -> Preset`(모르면 422
  `unknown_country`). 골든 세트 테스트(한글 NFD 입력 포함)를 core 테스트로.
- **막힌 기능**: 없음(기능 안 사본으로 동작). 적재기 구현 전에 옮겨야 불일치가 안 생긴다.

## R2. LLM(OpenRouter) 클라이언트·설정과 컨텍스트 맵 산업 설정을 core.config 로

- **무엇**: 기능 안 설정 모델(HGH_ 접두 env) 두 개.
  `HGH_OPENROUTER_API_KEY`·`HGH_OPENROUTER_BASE_URL`(기본 https://openrouter.ai/api/v1)·`HGH_OPENROUTER_MODEL`(기본 google/gemini-2.5-flash)·
  `HGH_OPENROUTER_TIMEOUT_S`(기본 60) → `app/features/intent/keywords/serp_drafts/llm.py`(social.prompts 도 import).
  `HGH_CONTEXT_MAP_INDUSTRY_ENTITY_ID`·`HGH_CONTEXT_MAP_KEYWORD`(기본 '자동차') → `app/features/intent/social/context_map/config.py`.
- **왜**: 시크릿(API 키)은 core.config 의 SecretStr 로 한 곳에서 다뤄야 하고, LLM 호출은 커넥션을 쥔 채 하지 않는다는 core.db 규약을
  클라이언트 시그니처(커넥션 인자 없음)로 강제하는 편이 모듈마다 사본을 두는 것보다 안전하다. 다른 모듈(admin keyword-tools 등)도 쓸 것이다.
- **제안 시그니처**: `Settings.openrouter_api_key: SecretStr | None`, `openrouter_base_url`, `openrouter_model`, `openrouter_timeout_s`,
  `context_map_industry_entity_id: UUID | None`, `context_map_keyword: str`. `core.llm.LlmClient`(Protocol: `model`, `complete_json(prompt, schema, *,
  temperature, max_tokens) -> dict`), `core.llm.get_llm()`(키 없으면 호출 시점 503 `llm_unavailable`), `core.llm.call_llm`(실패 → 502 `llm_failed`).
- **막힌 기능**: 없음.

## R3. enqueue_change 중복 판정이 payload 를 보지 않는다 (core.write)

- **무엇**: `enqueue_change(dedupe=True)` 는 같은 kind·subject_uuids·subject_texts 의 대기 행이 있으면 409 `duplicate_pending`.
  dfs_fetch 는 같은 term 집합이라도 수집 종류(insight·related·search)·국가(location·language)가 다르면 다른 요청이다.
- **왜**: 그대로 쓰면 "같은 키워드, 다른 국가" 수집 요청이 먼저 들어온 다른 국가 요청에 묻혀 수집되지 않는다.
- **지금 우회(기능 안, 2026-09-28 검증 D1·D4 반영)**: core dedupe 를 쓰지 않는다(`dedupe=False`). 기능 SQL 로 같은 (fetch, location_code,
  language_code, subject_texts)의 pending·running 행을 직접 찾고(트랜잭션 advisory 잠금 `pg_advisory_xact_lock(hashtextextended(key, 0))` 로
  동시 요청 직렬화), 요청자가 상태 조회로 볼 수 있는 행이 있으면 그 change_id 를 202 pending 으로 돌려준다. 이전 우회(409 받은 행 payload 비교)는
  core 가 LIMIT 1 로 다른 국가 행을 고르면 매번 새 행을 넣는 결함이 있었다(검증 D1 재현: us 1회 + kr 3회 → 대기 행 4개).
- **제안 시그니처**: `enqueue_change(..., dedupe_key: dict[str, Any] | None = None)` → 중복 판정에 `payload @> CAST(:dk AS jsonb)` 를 더한다.
- **막힌 기능**: 없음(intent.keywords.fetches 는 우회로 동작). core 가 `dedupe_key` + 가시성 콜백(또는 잠금)을 주면 기능 SQL·잠금을 지운다.

## R4. rd.kw_suggestion 에 관측 시각 열이 없다 (DB)

- **무엇**: rd.kw_volume_monthly·rd.kw_serp 에는 observed_at 이 있는데 rd.kw_suggestion 에는 없다(DB-v2.4 rd.kw_suggestion).
- **왜**: 모듈-고객-관심 §2 는 related·search 신선도(TTL 7일, 현행 lib/keyword/cache.ts:41-44)를 observed_at 으로 계산하라고 정했다.
  API 는 ext.dfs_call(적재기 전용, requested_at 파티션)을 읽지 않는다.
- **제안**: DB-v2.5 패치 `ALTER TABLE rd.kw_suggestion ADD COLUMN observed_at timestamptz NOT NULL;`(적재기가 ext.dfs_call.requested_at 을 옮겨 쓴다.
  기존 행이 없으므로 기본값 불필요, 이관 시 dfs_call 에서 채움).
- **막힌 기능**: intent.keywords.research 의 related·lookup 신선도는 `unknown`(데이터 유무만 missing 판정), intent.keywords.fetches 의
  related·search 는 "신선하면 skip" 을 못 해 항상 큐에 넣는다(대기 중 중복은 막힌다). 둘 다 partial.

## R5. LLM 핸들러가 요청 끝까지 api_ro 커넥션을 쥔다 (core.auth·core.db)

- **무엇**: `CurrentUser`(= get_principal) 는 `RoConn`(scope="function")을 공유해 핸들러가 끝날 때까지 api_ro 트랜잭션을 연 채로 둔다.
  serp_drafts·social.prompts POST 는 LLM(수 초~수십 초)을 기다리는 동안 이 커넥션을 쥔다(api_rw 는 LLM 뒤에 `get_db().write()` 로 따로 연다).
- **왜**: core.db 규약 "LLM·외부 호출은 커넥션을 쥔 채 하지 않는다". 동시 생성이 몰리면 api_ro 풀(기본 5+5)이 LLM 지연만큼 점유된다.
- **제안 시그니처**: `core.auth.CurrentUserDetached`(JWT 검증 → 짧은 자체 api_ro 트랜잭션에서 계정 로드 → 커넥션 반납),
  `core.db.ro_transaction()`(핸들러가 읽기 단계만 짧게 여는 컨텍스트 관리자). 기능은 읽기 → (커넥션 없음) LLM → 쓰기 3단으로 이미 짜여 있어
  의존성만 바꾸면 된다.
- **막힌 기능**: 없음(동작함). 운영 위험(풀 점유)만 남는다.

## R6. xlsx 작성 공용화 (의존성 또는 core.xlsx)

- **무엇**: 공유 venv 에 xlsx 라이브러리가 없어 `app/features/intent/social/context_map/xlsx.py` 에 표준 라이브러리(zipfile) 최소 작성기를 두었다
  (인라인 문자열·숫자 셀, 첫 행 굵게·고정, 열 너비). 컨텍스트 맵 내보내기(Q13 서버 xlsx)가 쓴다.
- **왜**: P-1 프롬프트 카탈로그 xlsx(Q19)·admin 카탈로그 export 도 같은 일을 한다(ad-content R4 와 같은 요청).
- **제안**: `openpyxl>=3.1`(write_only 모드 스트리밍) 추가 또는 이 작성기를 `core.xlsx.build_workbook(sheets) -> bytes` 로 이관.
- **막힌 기능**: 없음. 지금은 전량을 메모리에 만든 뒤 한 번에 응답한다(현재 약 1만 행, 10배 10만 행에서도 수 MB). 서버 커서 스트리밍은 미구현.

## R7. 표면 없는 엔드포인트의 공통 필터 무시 기록 도우미 (core.filters)

- **무엇**: intent 는 공통 필터 축을 하나도 지원하지 않는데 `CommonFilters` 는 surface 필수라 받을 수 없다. 요청 쿼리에서 공통 축 이름을 읽어
  `meta.ignored_filters` 로 드러내는 도우미를 기능 안(`intent_common.ignored_filters`)에 두었다(FilterSupport 빈 선언과 함께).
- **제안 시그니처**: `core.filters.ignored_axes(request, support: FilterSupport, consumed: frozenset[str]) -> list[str]`
  (from·to → period, cf.* → custom, surface·own_brand 포함, consumed = 엔드포인트가 자기 파라미터로 쓰는 이름. 예: research 의 country 는 단일 국가
  파라미터라 공통 축이 아니다). ad-content R3 과 같은 요청.
- **막힌 기능**: 없음.

## R8. dfs_fetch 큐 행 계약 확정 (ingest 모듈과 합의)

- **무엇**: intent.keywords.fetches 가 넣는 행: `kind='dfs_fetch'`, `subject_texts = term_norm 정렬 배열`, `requested_by = 행위자`,
  `payload = {fetch: insight|related|search, country: 프리셋 id, location_code, language_code, depth: 10, project_id: uuid|null, terms: [원문 term],
  force: bool}`. 적재기 처리: insight = search_volume + serp_organic(depth), related·search = keyword_suggestions(search 는 include_seed,
  seed 행은 is_seed = true 로 저장). 상태 전이 pending → running → applied|failed(error).
- **왜**: 적재기(dfs_fetch 빠른 경로)가 아직 없다(ingest.cycles.workers 스텁). 형식이 어긋나면 수집이 조용히 실패한다.
- **막힌 기능**: 실제 수집(적재기 소관). API 쪽은 완료.

## R9. (낮음) ext.ctx_combination (snapshot_id, co_count DESC) 인덱스 (DB)

- **무엇**: 조합 목록(동시 언급 정렬 키셋)은 스냅샷 조합 전체를 읽어 top-N 정렬한다(로컬 EXPLAIN: 2,500행 Seq Scan + top-N heapsort 1.0ms).
- **왜**: 현재 약 5.7천 행, 10배 5.7만 행이면 페이지마다 수십 ms. 다른 목록(맥락·조건)은 ctx_entity_type_mentions 로 인덱스 순서를 탄다.
- **제안**: `CREATE INDEX ctx_combination_count_idx ON ext.ctx_combination (snapshot_id, co_count DESC, cond_a DESC, cond_b DESC);` RDS 실측 게이트 후 판단.
- **막힌 기능**: 없음.

## R10. app.project_tracked_keyword 식 유니크 (DB)

- **무엇**: 지금 UNIQUE NULLS NOT DISTINCT (project_id, term, country_code) 는 원문 term·저장 국가에 걸려 'A' 와 'a', NULL(프로젝트 국가)과
  'kr' 을 다른 행으로 본다(검증 D6).
- **왜**: 같은 term_norm·유효 국가의 탭이 둘 생기고 목록 latest_volume 이 두 번 나온다. 기능은 프로젝트 단위 advisory 잠금 안에서 판정하고
  프로젝트 국가와 같은 국가를 NULL 로 저장해 막았지만, 적재·이관 같은 다른 쓰기 경로는 막지 못한다.
- **제안**: term_norm 열 추가(`GENERATED ALWAYS AS (lower(btrim(normalize(term, NFC)))) STORED`, 앱 term_norm 과 골든 세트 대조 필요) +
  `CREATE UNIQUE INDEX ... ON app.project_tracked_keyword (project_id, term_norm, coalesce(country_code, ''))` 와 이관 시 프로젝트 국가와 같은
  country_code 를 NULL 로 정규화. 기존 중복 행 정리 선행.
- **막힌 기능**: 없음(기능 판정으로 동작).

## R11. 모듈-고객-관심 §5 권한 결정 반영 (설계 문서, 기능 경로 밖)

- **무엇**: 검증 D3·D5 로 정한 규칙을 모듈 문서 §5 에 옮겨 달라(빌더는 담당 경로 밖이라 못 쓴다. 기능 README 에 적어 두었다).
  1) project_id 없는 키워드 경로(insight·related·lookup·fetches·serp-drafts)는 메뉴 그룹 standard 게이트, 있는 경로는 project 게이트.
  2) project_id 경로의 국가는 프로젝트 국가 ∪ 추적 키워드 국가로 묶이고, 밖이면 project_id 없는 규칙.
  3) serp-drafts 의 프로젝트 권한은 SERP (키워드, location, language)가 그 프로젝트 추적 키워드와 맞을 때만.
  4) fetches 의 "같은 요청이 미완료면 기존 change_id 반환"은 요청자가 볼 수 있는 행에 한한다.
- **막힌 기능**: 없음.
