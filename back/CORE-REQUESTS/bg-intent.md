# core·DB 요청: bg-intent (값 갭 보강 라운드 BG-39·BG-40)

작성 2026-09-28 · 빌더 bg-intent · 기준 stg 8890406. 두 항목 모두 **DDL(rd 열 추가) + 적재기 쓰기** 가 있어야 API 가 값을 줄 수 있어
이 라운드에서 API 쪽은 구현하지 않았다(blocked). 각 항목은 무엇·왜·제안 DDL·적재기·API·막힌 화면 순이다.

공통 배경: DataForSEO 원본 응답은 `ext.dfs_call.response` 에 있지만 설계상 API 는 ext.dfs_call 을 읽지 않는다
(모듈-고객-관심.md §4 "ext.dfs_call 은 API 가 접근하지 않는다(적재기 전용)", research/queries.py 머리 주석). 그래서 값은 적재기가 rd 로 옮겨야 한다.
원본 응답에 값이 이미 있으므로 기존 행은 ext.dfs_call 에서 채울 수 있다(call_id 등치, requested_at = rd 의 observed_at).

## BG-39. 연관어 "N건 발견" 원래 총수(DataForSEO keyword_suggestions total_count)

- **무엇**: 현행 foundCount = DataForSEO keyword_suggestions 응답 `tasks[0].result[0].total_count`
  (front/lib/keyword/dataforseo-discovery.ts:146·168 `totalCount: result?.total_count ?? items.length`, insight.ts:149·206).
  화면 google-keyword-view.tsx:1059 "N건 발견", 빈 상태 검색(keyword-search-start) 그룹의 foundCount 도 같은 값.
  API 는 `Related.found_count = len(items)`(≤30, research/service.py `related`)만 주고 LookupRow 에는 없다. rd.kw_suggestion 에 총수 열이 없다.
- **제안 DDL(권장 A, 추가형)**:
  `ALTER TABLE rd.kw_suggestion ADD COLUMN total_count int;` + `COMMENT ... '그 호출의 DataForSEO total_count(호출 단위 같은 값, 행마다 반복)'`.
  기존 행 채움: `UPDATE rd.kw_suggestion s SET total_count = (d.response #>> '{tasks,0,result,0,total_count}')::int
  FROM ext.dfs_call d WHERE d.call_id = s.call_id AND d.requested_at = s.observed_at AND d.endpoint = 'keyword_suggestions';`
  (NULL 허용: 응답에 값이 없던 호출은 NULL → API 는 null, 프론트는 현행처럼 items 길이로 폴백).
  대안 B: 호출 머리 표 `rd.kw_suggestion_call(call_id PK, seed_kw_key, location_code, language_code, total_count int, observed_at)`.
  B 는 연관어 0건 호출도 남길 수 있으나 표가 하나 늘어난다. 현행 화면은 items 가 0 이면 총수를 쓰지 않으므로 A 로 충분하다.
- **적재기**(ingest/cycles/workers/dfs.py `write_dfs` keyword_suggestions 분기): `res[0].get("total_count")` 를 KW_SUGGEST 인자로 더해 행마다 쓴다.
- **API(열이 들어온 뒤 이 그룹이 할 일)**: research/queries.py `SUGGEST_LATEST` 에 `g.total_count` 추가 →
  `Related.total_count: int | None`(선택 필드, 기존 found_count 의미 유지), `LookupRow.total_count: int | None`. 테스트는 intent_fixtures 의
  kw_suggestion 행에 total_count 를 넣어 손계산 값과 대조.
- **막힌 화면**: U10 프로젝트·표준 키워드 화면 "N건 발견"(보강 전 어댑터 규칙: foundCount = found_count, 뜻 다름을 known_diff 로).

## BG-40. 운영자 키워드 도구 경쟁도 라벨(competition: LOW·MEDIUM·HIGH)

- **무엇**: 현행 keyword-tools.tsx:202(CSV)·:292(표 배지) 가 `competition` 문자열을 쓴다(front/lib/keyword/dataforseo.ts:28, service.ts:30·90
  `competition ?? "LOW"`). DataForSEO google_ads search_volume 응답 행의 `competition` 필드다. API VolumeItem
  (admin/integrations/keyword_tools/schemas.py)에는 competition_index·cpc 만 있고 rd.kw_volume_monthly 에 라벨 열이 없다.
  competition_index 에서 라벨을 산식으로 만들지 않았다: DataForSEO·Google Ads 가 라벨과 지수의 경계를 계약으로 주지 않아 추정이 된다.
- **제안 DDL(추가형)**:
  `ALTER TABLE rd.kw_volume_monthly ADD COLUMN competition text CHECK (competition IN ('LOW','MEDIUM','HIGH'));`
  (competition_index·cpc 와 같이 키워드 단위 값을 월 행마다 반복). 기존 행 채움: ext.dfs_call(endpoint 'search_volume', call_id 등치,
  requested_at = observed_at)의 `response->'tasks'->0->'result'` 원소 중 keyword 의 app.term_norm 이 그 kw_key 의 term_norm 과 같은 원소의
  `competition`. 값이 위 세 값 밖이면 NULL.
- **적재기**(dfs.py `write_dfs` search_volume 분기): `row.get("competition")` 을 KW_VOLUME 인자로 더한다(세 값 밖이면 None).
- **API(열이 들어온 뒤)**: keyword_tools/queries.py `VOLUMES_SQL` 에 `v.competition` → `VolumeItem.competition: str | None`(선택 필드).
  같은 열을 research `TREND` 에도 실으면 `TrendPoint.competition` 을 더할 수 있다(현행 인사이트 화면은 쓰지 않아 선택).
- **막힌 화면**: U11 /admin/keyword-tools 경쟁도 열(보강 전 어댑터 규칙: 빈 값, CSV 빈 칸).

## R1 (차단: 완료 게이트) tests/core/test_app.py OpenAPI 연산·경로 수 상수

- 무엇: `test_openapi_keeps_feature_stubs` 의 `n == 174 and len(spec["paths"]) == 139` 를 **175 / 140** 으로(이 그룹 몫 +1 연산, +1 경로:
  `GET /v1/intent/standard-keywords`). 주석 "기능 171 + 적재 운영 조회 GET 3" 에 "+ 표준 키워드 목록 GET 1(bg-intent BG-41)" 추가.
- 왜: 수정 라운드 검증 D3(2026-09-28). 게이트에서 `assert (175 == 174)` 1건 실패. tests/core 는 core 소유라 기능 쪽에서 고치지 않았다(ingest R2 와 같은 처리).
- 주의: 같은 라운드의 다른 bg 그룹이 경로를 더하면 합산 값이 달라진다. core 가 병합 순서에 맞춰 최종 값을 정한다(이 그룹 단독 기준 175/140).
- 확인(수정 라운드): 기능 설명은 back/FEATURES.md research(4), 설계는 모듈-고객-관심.md §2 IN-1 표·§8-3(닫음) 에 반영했다.

## 요청 아님(참고): BG-41 은 DDL 없이 구현했다

`GET /v1/intent/standard-keywords`(research 라우터). app.standard_keyword 는 이미 api_ro 가 읽을 수 있다.

응답 모양(수정 라운드 검증 D4): 같은 term 의 공통·브랜드 행을 app.term_norm 으로 한 항목으로 합친다. 항목 필드는 keyword_id(대표)·keyword_ids·term·
source_type·brand_codes·created_at·updated_at 이다(brand_code 단일 필드 대신 brand_codes 배열). 새 엔드포인트라 기존 계약 변경은 없고, R1 의 경로·연산 수에도 영향이 없다.
app.term_norm 은 api_ro 가 이미 EXECUTE 권한을 가진다(DB-v2.7.sql:1939), DDL 요청 없음.
