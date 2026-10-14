# intent.keywords.fetches · 고객 관심 / 키워드 / 수집 요청(비동기)

설계 단위: IN-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/intent/fetches` | medium |
| GET | `/v1/intent/fetches/{change_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/customer-interest/google-keywords`
- `/projects/[id]/intent/google-keyword`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 결정(2026-09-28 검증 D1·D3·D4·D5 반영, core 6라운드 전환)
- 같은 요청 = 같은 (fetch, location_code, language_code, term_norm 집합)의 pending·running 행. core.write.enqueue_change_result
  (dedupe="coalesce_active", dedupe_key={fetch, location_code, language_code})가 advisory 잠금으로 동시 요청을 직렬화하고 대조한다.
- 돌려주는 기존 change_id 는 요청자가 `GET /v1/intent/fetches/{id}` 로 볼 수 있는 행(요청자·admin·그 프로젝트 운영자·프로젝트 없는 요청이면
  전역 운영자)만이다(reusable 판정). 보이는 행이 없으면 새 행을 넣는다(남의 프로젝트 요청에 묶여 폴링 불가한 id 를 받지 않게).
- 신선하면 skip(force 면 무시): insight = 검색량·SERP 둘 다 24시간, related = 최신 연관어 호출 7일, search = seed 행을 포함한 최신 연관어 호출 7일
  (rd.kw_suggestion.observed_at).
- payload = core.contracts DfsFetch 계약(fetch·terms·location_code·language_code·country·depth·project_id·force), subject_texts = 정렬된 term_norm.
- 권한: project_id 없음 = 메뉴 standard + admin·전역 운영자 + 국가 스코프. 있음 = 메뉴 project + resolve_project(operate), 국가가 프로젝트 국가·추적
  키워드 국가 밖이면 project_id 없는 규칙.

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/intent/fetches?ids=…`(B063·B073, 1~20건, 반복): 수집 요청 상태 일괄(폴링용, 응답 items = 요청 순서). 단건
  `GET /v1/intent/fetches/{change_id}` 와 같은 가시성: 하나라도 없거나 볼 수 없으면 404. 구글 키워드·키워드 도구 폴링이 change id 별 GET 대신 쓴다.
