# intent.keywords.research · 고객 관심 / 키워드 / 인사이트·연관어·조회

설계 단위: IN-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/intent/insight?term=&country=` | low |
| GET | `/v1/intent/related?term=&country=` | low |
| GET | `/v1/intent/lookup?terms=&country=` | low |
| GET | `/v1/intent/standard-keywords?source_type=&brand=` | low(소규모 원천 표, 상한 500) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/customer-interest/google-keywords`
- `/projects/[id]/intent/google-keyword`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 권한 결정(2026-09-28 검증 D3·D5 반영, 모듈-고객-관심 §5 보강)
- project_id 없음 = 표준 화면: 메뉴 그룹 `standard`(menu_groups NULL = 무제한) + 표준 열람 역할(hq·region·country·admin) + 국가 스코프.
  현행 route-policy.ts:28·55-56 의 STANDARD_VIEWERS × group 'standard' 짝을 이식한다. 코드 `menu_forbidden`·`role_forbidden`·`country_forbidden`.
- project_id 있음 = 메뉴 그룹 `project` + resolve_project(member). 국가가 그 프로젝트에 묶인 국가(프로젝트 국가 ∪ 추적 키워드 국가) 밖이면
  표준 화면 규칙을 그대로 적용한다(프로젝트 id 를 붙여 표준 화면 국가 스코프를 우회하지 못하게).
- 메뉴 게이트는 project_id 유무로 갈려 라우터 dependencies 로 걸 수 없어 핸들러 안에서 core.auth.check_menu_group(require_menu_group 과 같은 판정)으로 건다.

## 신선도(DB-v2.6 P43)
- insight = 검색량·SERP 최신 관측 중 오래된 쪽 기준 24시간(한쪽만 있으면 stale).
- related·lookup = 최신 연관어 호출의 rd.kw_suggestion.observed_at 기준 7일. lookup meta 는 찾은 term 중 하나라도 stale 이면 stale
  (`source.stale_terms`), 찾은 term 이 없으면 missing.

## 공용 도우미
- `intent_common.py`: intent 7기능이 함께 쓰는 기능 전용 도우미(신선도·meta 조립·표준 화면 권한). term_norm·프리셋·검색어 정리는 core.kw,
  공통 필터 무시 기록은 core.filters.ignored_axes(core.envelope.crud_meta)가 정본이다.

## 표준 키워드 목록(BG-41, 2026-09-28 값 갭 보강)
- `GET /v1/intent/standard-keywords`: 표준 화면(customer-interest/google-keywords) 키워드 탭 원천. 현행은 샘플 고정 목록이었다(G11).
  app.standard_keyword 의 enabled 행만, 관리용 필드(notes·created_by)는 싣지 않는다. 쓰기는 admin 경로(/v1/admin/interest/keywords) 그대로.
- 권한: 표면 게이트 global(역할 hq·region·country·admin + 메뉴 standard). vendor·website 역할은 403 role_forbidden.
- 스코프: brand_code NULL(공통)은 모든 계정, 그 밖은 계정 스코프 브랜드 안(DataScope.brand_allowed. 엄브렐러는 전체 스코프만).
- 필터: `brand`(공통 필터 축) = 볼 수 있는 브랜드로 좁히기(그 브랜드 + 공통). 알 수 없는·스코프 밖 값은 meta.dropped_filters.brand,
  남는 값이 없으면 스코프 전체. 원천에 국가·기간·엔진이 없어 나머지 축은 meta.ignored_filters. `source_type` 기본 google_keyword.
- term 합치기(수정 라운드 검증 D4): 가시 행을 app.term_norm(term) 으로 묶어 한 항목으로 준다(공통 'p common' 과 Kia 'p common' 이 KIA_US 화면에
  탭 둘로 뜨던 문제). 항목 = {keyword_id(대표 행), keyword_ids(묶음 전 행), term(대표 행 원문), brand_codes(NULL = 공통, 맨 앞), created_at(대표),
  updated_at(묶음 최댓값)}. 대표 = created_at 최신, 동률 keyword_id 최소. 어댑터는 탭 id = keyword_id, label = term 을 그대로 쓰면 되고 둘 다 응답 안에서 유일하다.
- 정렬 대표 created_at 내림차순, 동률 keyword_id 오름차순(관리 목록과 같은 규칙). 한 페이지 `limit` 기본·최대 500 항목(`MAX_STANDARD_KEYWORDS`).
  넘치면 `meta.page.next_cursor`(키셋: created_at, keyword_id)로 이어 받는다(수정 라운드 검증 D2: 전에는 501번째 이후를 받을 길이 없었다).
  커서는 source_type·좁히기 브랜드 해시에 묶여 다른 필터로 쓰면 422 cursor_invalid. meta.page.total = 커서·limit 과 무관한 필터 전체 항목(묶음) 수
  (커서 뒤가 비어도 유지).
- 테스트는 표가 비어 있다고 가정하지 않는다(검증 D1): 표식 keyword_id 를 품은 항목으로 걸러 대조하고 total 은 독립 SQL 의 가시 행 서로 다른 term_norm 수와 대조한다.
- BG-39(core 8라운드, DB-v2.9 P62): `Related.total_count`·`LookupRow.total_count` = 최신 연관어 호출의 DataForSEO total_count(rd.kw_suggestion.total_count,
  적재기가 호출 단위로 행마다 쓴다). 현행 'N건 발견' foundCount 값. 응답에 없던 호출은 null(프론트는 found_count 폴백). found_count 의미는 그대로.
