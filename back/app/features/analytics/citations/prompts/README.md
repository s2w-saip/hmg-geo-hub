# analytics.citations.prompts · 분석 조회 / 인용 / 프롬프트별 인용

설계 단위: C-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/prompts` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/citation`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/citation/prompts`
- `/website/answer-analysis/citation`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, an-cit-b)
- 파라미터: 공통 필터 + `owned`(필수) · `q`(부분 일치, 와일드카드 글자 그대로, 제어 문자 `\x00-\x1f`·`\x7f` 는 422 `unprocessable`
  `details.field='q'`) · `limit`(1~200, 기본 50) · `cursor`(키셋). 한 쿼리 모델 `PromptsQuery`.
- 응답: `data.items[]`(prompt_id·text·funnel·citations·providers·answers 상위 8) · `data.counts{owned, uncited}`(q 무관 탭 카운트) · `meta.page{next_cursor, limit, total}`.
- 값: rd.answer 답변당 인용 수 열(G-25)을 `core.measure.plan_counts(group_by=prompt·engine, parts=citations)` 로 집계(rd.citation 스캔 없음). 정렬 = 인용 수 내림차순, prompt_id 오름차순.
- 지원 축: global = brand·country·lang·engine·기간·택소노미(lang 은 BG-01, 2026-09-28) / website = brand·country·lang·engine·기간 / project = country·lang·engine·기간·택소노미·커스텀. + 세 표면 모두 source[](core MeasureScope.source_category_keys: 원소 스캔으로 선택 카테고리 출처 인용만, 답변 표본의 인용 수도 그 출처만).
- 억제: 스냅샷 회차 없음 `*: no_active_snapshot`, 인용 숨김 회차 `citations: hidden`.

## 테스트(2026-09-28 2차, 검증 D4·D6 반영)
- `tests/test_citations_prompts.py`: 합성 픽스처 그대로(웹사이트는 창 주입).
- `tests/test_citations_prompts_staged.py`: `tests/staged.pgsql`(@global) 을 소유자 접속으로 넣고 지운다. 여러 프롬프트 정렬·동률·키셋(HTTP),
  표본 상한 8·job_id 동률 순서, 실제 창 경로의 숨김 2 배제·숨김 3 포함·미래 노출일 배제, 비기본 엔진·호스트 없음·cit_in 거짓 배제.
  기대값은 rd.citation 원소 스캔(구현과 다른 경로)으로 같은 테스트 안에서 계산한다.
- rd 쓰기는 정적 가드 G6 대상인 기능 모듈 SQL 이 아니라 데이터 파일(.pgsql)에 둔다(analytics.funnel 선례). C-4 테스트도 같은 파일을 쓴다.

## BG 보강(2026-09-28, bg-citations: BG-01 인용 프롬프트 부분)
- global 지원 축에 lang 추가(같은 화면의 /domains·/sources 와 같은 모집단). 답변·인용 원소의 lang_key 로 좁히고, 글로벌 자사 판정은 core
  OwnerScope 가 요청 언어로 허용 배열을 좁혀(비면 안 좁힘) core plan_counts 가 원소 스캔(scan 모드)으로 센다. 이전 테스트의
  "global lang = ignored_filters" 단언은 새 동작으로 바꿨다.
- 테스트: `tests/test_citations_prompts_bg.py`(준비 = staged.pgsql @global + domains/tests/bg.pgsql @lang_ko).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `include_refs`(B099): false = 행당 답변 표본 문장을 돌리지 않고 `items[].answers` = [].
- `fields`(B099, all|text): text = 퍼널·AI 엔진을 계산하지 않는다(`items[].funnel` = null, `providers` = []). 정렬·citations·버킷·카운트는 같다.
- `both_buckets`(B099): true = 같은 집계 한 번으로 반대 버킷(owned 의 반대)의 첫 페이지(같은 q·limit·정렬·include_refs·fields)를
  `data.other_bucket` 에 싣는다. items·counts·meta.page 는 요청 버킷 그대로. cursor 와 함께면 422. 키는 both_buckets=true 일 때만 있고,
  빈·숨김 창이면 [].
- 보내는 화면: 표준 분할 카드 = `owned=true&limit=1&include_refs=false&fields=text`, 웹사이트·프로젝트 분할 = `owned=true&limit=5&both_buckets=true`
  (owned = items, 미인용 = other_bucket), 하위 프롬프트 페이지 = `fields=text`.
