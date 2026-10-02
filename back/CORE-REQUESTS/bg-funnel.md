# core·DB 요청: bg-funnel (값 갭 보강 라운드, BG-28~33)

작성 2026-09-28 · 기준 stg 8890406 · 빌더 그룹 bg-funnel(analytics.funnel.acr · analytics.funnel.conversion · admin.integrations.ga4)

BG-28·29·30·31·33 은 core·DB 변경 없이 기능 안에서 구현했다. BG-32 만 DDL(적재 원천)이 필요해 막혀 있다.

## 1. GA4 창 사용자 수 원천(BG-32, DB·적재): 막힘

- 무엇: 전환 화면 방문 카드의 '순 방문자'·'방문 빈도'(front visits-view.tsx:19·34-45·41)와 입구 페이지 표 사용자 열(:66·77)이 쓰는
  기간 창 사용자 수(현행 getAiVisitsLive conversion.ts:766-790: GA4 runReport activeUsers, 창 전체 1회 조회 + landingPage 별 activeUsers).
- 왜 API 만으로 못 만드나:
  1. rd.ga4_row.users_day 는 행(날짜 × 채널·소스·기기·신규재방문·페이지·이벤트) 사이에서 합할 수 없다(DDL 주석·G-12 a). 날짜를 가로질러 더하면
     같은 사용자를 여러 번 센다. 한 날짜 안에서도 기기·엔진 행을 더하면 중복이다.
  2. 창 합계 보고서(report 5 totals)는 DDL 에 자리만 있고 창 경계(시작·끝)를 담는 열이 없다(rd.ga4_row PK 는 date 하나).
     ing.ga4_pull.date_from·date_to 는 ing 라 api_ro 가 못 읽는다.
  3. 필터(engine[]·device[]·visitor_type[]) 조합마다 창 사용자 수가 다르다(비가산). 다중 선택은 GA4 에 다시 묻지 않으면 정확한 값이 없다.
- 제안(G-12 b 'D8 예외로 창 합계 저장' 채택 시):
  - DDL: `rd.ga4_window_total(prop_key int2, window_days int2 CHECK (window_days IN (7,28,90)), end_date date, is_ai bool, engine_key int2,
    device_key int4, nvr_key int4, page_key int4, users int, sessions int, PRIMARY KEY (prop_key, window_days, end_date, is_ai, engine_key,
    device_key, nvr_key, page_key))`. 차원 값 0 = 그 축 전체(단일 선택·무선택만 정확, 다중 선택은 null 로 낸다).
  - 적재(IG-4 GA4 일 적재): 최신 적재일 기준 7·28·90일 창을 (AI 코호트 전체, 엔진별, 기기별, 신규재방문별, 입구 페이지 상위 N) 로 pull 해 교체 적재.
  - API(이 그룹, 원천이 생기면 추가형으로): `summary.ai.users_window: int | null`(days 모드·단일 시장·필터 단일 선택일 때만 값),
    `pages[].ai_users_window: int | null`. from/to 임의 창이면 null.
- 대안(결정 필요): G-12 a 유지 = 사용자 수 미제공 → front visits-view 의 두 카드·사용자 열을 숨긴다(front-adapter-plan 3.5 #9 원안).
- 막힌 기능: analytics.funnel.conversion BG-32(카드 유지 결정 시). 그 밖 항목은 막힘 없음.

## 2. 참고(core 변경 없음, 통합 시 반영할 것)

- 새 엔드포인트 2개(경로 수 상수·taxonomy.json·FEATURES.md 는 통합에서 일괄): `GET /v1/funnel/conversion/events`, `PUT /v1/funnel/conversion/events`.
- `resolve_read_context(..., project_level="active_member")` 를 conversion 조회에 넘긴다(기존 선택 인자 사용). project 표면 게이트가
  '가시 비멤버 허용'에서 '활성 멤버 ∨ admin' 으로 좁아진다(현행 프로젝트 화면 notFound 와 같다).
- analytics.funnel.conversion 이 admin.integrations.ga4 의 service(load_events·put_events)·schemas(EventsPut)를 가져다 쓴다(같은 그룹 소유,
  추적 이벤트 목록·교체 본체를 한 벌로 두기 위해). 대분류를 넘는 import 규칙이 생기면 둘 중 하나를 core 로 올린다.

## 3. 검증 D1 후속 요청(core·DB 아님, 다른 기능·적재): 권고

bg-funnel 쪽은 읽기·이벤트 경로에서 '프로젝트 몫' 규칙으로 막았다(analytics.funnel.conversion service._override_owned). 원천에서 막으려면:

- pj-core(projects): `PATCH /v1/projects/{id}` 의 ga4_property_id 가 다른 시장에 귀속된 레지스트리 속성(app.ga4_property.brand_code·country_code
  가 프로젝트와 다름)이면 비관리자에게 422(또는 403)로 거절. 현행 front(setting/_actions.ts requireOwner)는 검사하지 않는다.
- 적재(IG-4 GA4): project_override 출처 rd.ga4_dim_property 행에 그 프로젝트의 brand_bit·geo_key 를 찍는다. 지금은 미귀속 project_override
  행을 프로젝트 몫으로 보므로, 서로 다른 시장의 두 프로젝트가 같은 속성 id 를 지정하면 둘 다 읽는다(잔여 위험, 같은 속성 id 를 아는 경우만).

### 3.1 메인 결정 필요(2차 검증 D1, critical)

- 현행 front 는 같은 규칙(tracked-events-actions.ts:85-88, projects page.tsx:52-55, setting/_actions.ts:189-197)이라 Owner 가 설정만으로
  다른 시장 GA4 수치를 읽고 추적 이벤트(전역 재판정)를 바꿀 수 있었다. 그룹 결정 '편집은 현행 front 규칙'을 그대로 따르면 이 구멍도 따라온다.
- bg-funnel 의 현재 처리(결정 전 최소 조치, 검증 권고의 '최소한'보다 넓다): project 맥락 읽기·쓰기 모두 '속성 시장 = 프로젝트 시장 ∨
  시장 미귀속(레지스트리 brand·country 없음, 적재 전, project_override 출처 미귀속)'일 때만 허용. 그 밖은 project 표면 unmapped,
  이벤트 GET·PUT 비관리자 404, admin 은 admin 경로 규칙(알려진 속성이면 연다).
- 선택지: (가) 지금처럼 funnel 쪽에서만 막는다(권장, projects 는 현행 그대로 저장). (나) 추가로 projects PATCH 가 다른 시장 귀속 속성 id 를
  admin 외에는 거절(pj-core 소관, 위 3절 첫 항목). (나)를 고르면 funnel 쪽 규칙은 안전망으로 남긴다.
