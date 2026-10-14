# analytics.funnel.conversion · 분석 조회 / AI 퍼널 / AI 유입·전환(GA4)

설계 단위: FU-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/funnel/conversion` | low |
| GET | `/v1/funnel/conversion/events` | low |
| PUT | `/v1/funnel/conversion/events` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]/ai-funnel/conversion`
- `/standard/ai-funnel/conversion`
- `/website/ai-funnel/conversion`
- `/projects/[id]/ai-funnel/conversion`, `/projects/[id]` ⑦(project 표면, BG-28)
- 전환 이벤트 다이얼로그(ga4-events-dialog.tsx: 웹사이트·프로젝트 전환 화면, BG-29)

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 값 갭 보강(2026-09-28, 전부 추가형)
- BG-28 project 표면: 프로젝트 직접 지정 속성(app.project.ga4_property_id) 우선, 없으면 그 (브랜드, 국가) 시장 속성. 게이트 = 활성 멤버 ∨ admin.
  지원 축 country·engine·period(+device·visitor_type·days). 국가 축이 프로젝트 국가를 빼면 억제 없는 빈 집합.
- BG-29 `coverage.markets[].property_id`(active·pending_grant, 프로젝트 직접 지정은 상태 무관) + 비관리자 이벤트 경로
  `GET·PUT /v1/funnel/conversion/events?property_id=&project_id=&surface=`: 표면 게이트 → 속성 소속(프로젝트 = 그 프로젝트 속성,
  그 밖 = 계정 스코프 시장 속성, 밖이면 404) → 쓰기 = admin·프로젝트 활성 Owner(403 owner_only)·역할 country·region·hq(403 role_forbidden).
  목록·교체 본체는 admin.integrations.ga4 service(load_events·put_events). 레지스트리 밖 속성 쓰기는 404.
- BG-30 `days`(7·28·90): 최신 적재일 기준 상대 창. from/to 와 같이 주면 422.
- BG-31 `by_engine_all`: engine[] 을 적용하지 않은 엔진별 분해(by_engine 은 그대로 engine[] 적용).
- BG-32 사용자 수(users_window): 막힘. 창 사용자 수 적재 원천 필요(back/CORE-REQUESTS/bg-funnel.md).
- 검증 수정(e9c64db 판정, tests/test_conversion_fix.py·test_conversion_events_write.py 회귀):
  - D1 직접 지정 속성은 '프로젝트 몫'일 때만 읽는다: 적재 투영(brand_bit·geo_key)·레지스트리(brand_code·country_code) 중 시장에 귀속된 행이
    프로젝트 (브랜드, 국가)와 다르거나, 레지스트리·env 출처 적재 행이 시장 미귀속이면 unmapped·property_id null. 이벤트 경로 비관리자 404.
  - D2 직접 지정 속성이 active 적재 전이면 상태와 무관하게 pending_grant(+property_id).
  - D3 `property_source=market|project`(project 표면 전용, 다른 표면 422): market = 시장 속성만(대시보드 ⑦).
  - D4 레지스트리 unmapped 시장의 속성 id 는 싣지 않는다(의도된 축소, known_diff DC-4).
  - known_diff DC-1~4: docs/design/api/모듈-AI-퍼널.md 8절.
- 2차 검증(e9c64db 재판정) 반영: D1 은 위 '프로젝트 몫' 규칙으로 이미 막혀 있어 재현 경로 그대로(PATCH /v1/projects → GET·PUT 이벤트,
  직접 지정 t-ga4-kia-it) 회귀를 더했다(원천 차단 방향은 메인 결정: CORE-REQUESTS/bg-funnel.md 3절). D3 은 property_source=market 으로 해소.
  D4 days 창 길이는 known_diff DC-5(끝점 = 최신 적재일, 길이 N, 현행은 N+1 달력일·오늘 포함)로 고정 테스트.
- EXPLAIN(로컬): 엔진 비교 두 문장은 prop_key·report 등치 + date 범위로 창 밖 월 리프 제외, 리프 PK 인덱스 스캔.

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `rollup_lite`(B096): true 이고 커버리지 시장이 2개 이상(전환 화면의 권역·본사 롤업 분기)이면 페이지 문장·엔진 비교 문장을 건너뛰고
  trend·by_engine·by_engine_all·pages = []. summary·by_country·coverage·period·meta 는 같다. 시장이 하나 이하(국가 리프)면 효과 없음.
  전환 화면(front `funnel.ts` loadConversionScreen)이 보낸다.
- `summary_only`(B096): 같은 생략 + `by_country` = null. 요약 카드(프로젝트 홈 ⑦)용.
- 두 파라미터가 생략을 켜면 세션·전환 문장도 GROUPING SETS 의 (날짜)·(엔진) 묶음을 빼고 (속성)·(전체)만 센다(P13d, `queries` `detail=False`:
  그 행 = 전 묶음 문장의 같은 행, `test_b096_summary_sets_equal_full_rows`·`test_b096_lite_calls_skip_date_and_engine_sets`).
