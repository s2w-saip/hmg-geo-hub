# analytics.filters.dates · 분석 조회 / 필터 / 선택 가능 날짜·기준일

설계 단위: F-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/filters/dates` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]`
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/standard/ai-funnel/acr`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/standard/prompts`
- `/website`
- `/website/ai-funnel/acr`
- `/website/answer-analysis/citation`
- `/website/answer-analysis/mention`
- `/website/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(F-2)
- 쿼리: `surface`(필수) · `project_id`(project 필수) · `family`(mentions 기본 | citations | all). 공통 축은 기간(from/to)까지 전부
  `meta.ignored_filters` 로 알리고 날짜 목록을 바꾸지 않는다.
- 게이트: 인증 → 표면 메뉴 그룹 → core 스코프(global 루트, website 스코프 안 사이트, project 가시성 404).
- 회차 후보(R01 servable·R03 노출)는 core `resolve_window` 기간 모드(전 기간)에서 받고, R04 숨김은 `HIDDEN_EXCLUDE`
  (mentions {1,3} · citations {1,2} · all {1,2,3}).
- data: `surface` · `latest_round_date` · `first_measured_date` · `dates`(내림차순, 최대 400) · `dates_truncated` ·
  `presets[{preset, from, to}]`(presetRange 이식: 주 -6·격주 -13·월 -29일·년 -1년, JS setFullYear 2/29 동작 포함, 최초일 클램프).
  meta.as_of = latest_round_date, meta.cycles = [].

## F-1 기준일과의 관계(검증 M3)
- 기준일은 family 별이다(모듈-필터 열린 질문 3 의 family 별 안). F-1 `meta.as_of` 는 core 함대 스냅샷(row 계열: hidden_scope 1 만 배제).
- 항상 `latest_round_date(family) ≤ F-1 meta.as_of`. 같음은 최신 게이트 통과 회차의 hidden_scope 가 그 family 배제 집합 밖일 때
  (mentions {0,2} · citations {0,3} · all {0}) 또는 1(둘 다 직전 회차로 물러남)일 때다. 예: 최신 회차 hidden_scope 3(Q18 예비값)이면
  F-1 as_of = 그 회차, F-2 mentions = 직전 회차. 회귀 테스트 `test_latest_vs_options_as_of_by_hidden_scope`.
- 모듈 문서 §7 불변식 문구는 이 규칙으로 동기화됐다(core 5라운드). 날짜 목록은 core `cycles.selectable_round_dates`(DB DISTINCT·절단).

## 값 갭 보강(2026-09-28, bg-kpi-filters)
- BG-03: 들어온 `depth4` 쿼리도 `meta.ignored_filters` 에 적는다(날짜 축은 값 필터를 받지 않는다. core 가 depth4 를 준 축으로 세어 비선언 엔드포인트를 표식한다, 검증 D2).
