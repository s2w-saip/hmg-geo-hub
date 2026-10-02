# analytics.kpi.compare · 분석 조회 / KPI / 기간 비교 Δ

설계 단위: K-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/kpi/compare` | high (365일 창 = 730일 스캔, 웹사이트 인용) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/website`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28, an-kpi)
- 파라미터: 공통 필터 + `kind`(window|calendarMonth|calendarWeek|cycle, 기본 window) · `days`(7|14|30|365, 기본 30, from/to 가 있으면 무시하고 `ignored_filters`) · `metrics[]`(기본 M01~M05).
- 창: from/to 가 있으면 그 기간이 cur(달력 월은 1일~같은 달, 달력 주는 월요일~그 주, 형식이 틀리면 422 `invalid_compare_period`), 없으면 끝점 E = 함대 최신 노출 round_date. cycle = 스냅샷 offset 0·1.
  직전·전전 구간이 달력 범위(0001-01-01~9999-12-31)를 벗어나는 기간도 422 `invalid_compare_period`(500 아님). 2000-01-01 이전 기간은 정상 처리한다(전 이력 하한 = min(2000-01-01, 스캔 시작)).
- 응답: `data[]` = {metric, family, unit, prev, cur(정수 쌍), delta, suppressed, reason, cycles_*, planned_*, missing_share_*}, `meta.compare` = {kind, windows{prev, cur, before?}, first_published(언급 계열), first_published_citation(인용 계열)}, `meta.source.ledger = "fleet"`.
- 누락 비중(Q2 가중): rd.cycle expected_units. 발행·원장·첫 발행은 **지표 계열별**이다. 언급 계열(M01~M04): 원장 밖 = 진행 중(open ∧ 비서빙)·노출일 전·숨김 {1,3}, 인용 숨김 회차는 발행. 인용 계열(M05): 원장 밖 = 진행 중·노출일 전·숨김 {1,2}, 언급 숨김 회차는 발행(값에 들어가는 회차와 모수가 같다). closed ∧ 비서빙 회차는 원장 안의 미발행(누락)이다.
- 원장은 **함대 기준**이다: planned·missing·cycles·first_published 는 필터(국가·엔진·브랜드)와 계정 스코프에 무관하게 표면의 전체 프로젝트 회차로 센다(현행 CompareLedger "필터 무관" 계승. rd.cycle 은 국가 차원이 없어 스코프로 좁힐 수 없다). 그래서 스코프 안 데이터가 0 인 계정(예: KIA_EU 글로벌)도 원장 값은 채워진다. 이 동작 유지 여부는 결정 확인 대상이다(검증 M3).
- 순수 로직 `logic.py` = 현행 period-compare.ts 이식(골든 테스트 `tests/test_logic.py`). 새 정의(현행 프로필 스위치 꺼짐)에는 PERIOD_COMPARE_EPOCH 게이트가 없다.

## 현행 프로필(WU-9, 2026-10-01, 제품 결정 19·24·25)
`HGH_LEGACY_PROFILE` 의 두 스위치(core.profile). 켜면 현행 fetchPeriodCompare(front server.ts:5921-6034) 분기를 재현하고, 원장·측정 문장을 돌리지 않는다.
- `compare_epoch_gate`: 창 cur.hi < 2026-09-08(`logic.PERIOD_COMPARE_EPOCH`, 운영 summary_settings 덮어쓰기 행 없음)이면 `data = []`,
  `meta.suppressed['*'] = 'before_epoch'`, `meta.compare.windows` 는 채운다. 어댑터(front lib/hgh/adapters/compare.ts)가 null(= 화면 종전 Δ)로 바꾼다.
- `compare_suppress`: 현행 집계층이 표현 못 하는 조합(depth2·depth3 필터, 관점 브랜드 2개 이상이지만 3사 전부는 아님; global·website 만)이면
  전 지표 `reason = unsupported`(정수 쌍 0, 원장 0, first_published null = 현행 emptyCompare). 화면 칩은 "―".
- 판정 순서 = 현행: 적용일 게이트 → 집계층 억제. 시험: `tests/test_legacy_switches.py`, `back/tests/core/test_legacy_profile.py` test_switch_compare_*.

## 값 갭 보강(2026-09-28, bg-kpi-filters)
- BG-05: `metrics[]` 에 `mentions_per_answer`(관점 언급 합 ÷ std_in 답변, 언급 계열)·`citations_per_answer`(인용 합 ÷ 인용 계열 cit_in 답변) 추가.
  단위 `pct` = 증감률 round1((cur − prev) ÷ prev × 100), 직전 값 0 이면 delta null(현행 deltaOf). 요청할 때만 낸다(기본 목록은 M01~M05 그대로).
  인용 분모는 같은 스캔의 회차별 gap_base(cit_in 답변)이고, 언급만 숨긴 회차는 보조 문장(`queries.cit_answers_sql`, core 빌더 조립)으로 센다.
  metrics 상한 5 → 7.
- BG-01: 글로벌 `lang[]` 적용(core KPI_SUPPORT).
