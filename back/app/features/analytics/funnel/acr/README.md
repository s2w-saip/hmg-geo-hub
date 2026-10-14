# analytics.funnel.acr · 분석 조회 / AI 퍼널 / AI 선택률(ACR)

설계 단위: FU-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/funnel/acr` | medium (1년·전 이력 추이 high 가능) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/standard/ai-funnel/acr`
- `/website/ai-funnel/acr`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 값 갭 보강(2026-09-28, 추가형)
- BG-33 `data.options{langs, countries}`: ACR 셀 모집단 옵션(현행 listMeasuredAcrLanguages). 창이 비었거나 숨김·원천 준비 중이면 빈 목록.
  langs = 현행처럼 스코프 브랜드·국가·기간만 건다(엔진은 전 엔진, lang·택소노미·커스텀 축 없음: 검증 D5).
  countries = 데이터와 같은 셀 선택에서 geo 축만 계정 국가 스코프로 바꾸고 숨김 국가(global = hidden_standard, website = 숨김 시장)를
  뺀다(검증 D2, /v1/filters/options regions 와 같은 규칙). 셀 선택 머리(cells CTE)에 lang_key 열 추가(커버링 인덱스 포함 열).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `include_option_countries`(B097): false = `options.countries` = [](국가 옵션 문장 생략, 화면 국가 목록은 `/v1/filters/options`). options.langs 등은 같다.
- `include_catalog_count`(B097): false = 셀이 있는 응답에서 카탈로그 ACR 프롬프트 수를 세지 않고 `totals.catalog_acr_prompts` = null(int|null).
  셀이 없는 응답(prompt_runs 0·빈 창·숨김·원천 준비 중)에서는 센다(측정 대기 안내만 이 값을 읽는다). 다른 값은 같다.
- ACR 화면(front `funnel.ts` loadAcrScreen)이 둘 다 false 로 보낸다. 배틀 상한은 같은 정렬 키로 SQL 에서 먼저 자른다(값 같음).
