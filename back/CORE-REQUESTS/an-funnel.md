# core·DB 요청: an-funnel (analytics.funnel.acr · analytics.funnel.conversion)

작성 2026-09-28 · 기준 stg 0092400 · 빌더 그룹 an-funnel(FU-1, FU-2) · 갱신 2026-09-28 검증 결함 수정 라운드(c063a69 판정 D1~D4, 항목 7~9 추가)

두 기능은 막힌 곳 없이 구현했다(상태 done). 아래는 기능 안에서 core 함수를 그대로 부르는 방식으로 우회했거나, 여러 기능이 같은 코드를 갖게 될 항목이다.
술어를 기능 안에 다시 쓴 곳은 없다.

## 1. 표면 → 메뉴 그룹 게이트 도우미(core.auth)

- 무엇: `require_surface_menu(principal, surface)` (global → standard, website → website, project → project). 또는 CommonFilters 를 받는 의존성.
- 왜: 표면이 쿼리 값이라 `require_menu_group(...)` 을 라우터 `dependencies=` 에 정적으로 걸 수 없다. 두 기능은 지금
  `await require_menu_group(SURFACE_MENU[surface]).dependency(p)` 로 core 판정 함수를 직접 호출한다(acr·conversion service.check_menu).
  분석 조회 기능 전부가 같은 매핑을 각자 갖게 되므로 core 가 정본을 두는 편이 맞다. 대시보드(/dashboard) 가 어느 메뉴 그룹인지도 정본이 필요하다(지금 standard 로 가정).
- 제안 시그니처: `def surface_menu_group(surface: Surface) -> MenuGroup` + `async def require_surface_menu(p: Principal, surface: Surface) -> None`.
- 막힌 기능: 없음(우회 중).

## 2. scope_where 의 rd.acr_cell 엔진 기본값(core.measure)

- 무엇: `scope_where` 는 `engine_keys is None` 이면 `{a}.dflt` 를 내는데 rd.acr_cell 에는 dflt 열이 없다(docstring 은 "사실 표 4종·rd.acr_cell 공통 열 이름").
- 왜: ACR 은 engine[] 이 비면 rd.dim_engine.is_default 목록을 써야 한다(모듈-AI-퍼널 §2.1). 지금은 기능이 `Refs.engines` 의 기본 엔진 키로
  `MeasureScope.engine_keys` 를 채운 뒤 scope_where 를 부른다(acr service.with_engines). 이걸 빠뜨린 호출은 실행 시 열 없음 오류가 난다.
- 제안: `scope_where(ms, a, b, *, default_engine_keys: Sequence[int] | None = None)` (None 이면 지금처럼 dflt) 또는 `Refs.default_engine_keys` 속성 +
  docstring 에 "acr_cell 은 engine_keys 필수" 명시.
- 막힌 기능: 없음(우회 중).

## 3. applied_prompts_sql 의 kind 인자(core.measure)

- 무엇: 카탈로그 적용 프롬프트 수에 `kind`('single'|'acr') 좁힘.
- 왜: ACR 화면의 '카탈로그에 ACR 프롬프트 없음' 과 '측정 대기' 구분(totals.catalog_acr_prompts, 현행 countStandardAcrPrompts 대체).
  지금은 rd.dim_prompt 에서 kind='acr' 키를 먼저 읽어 `MeasureScope.prompt_keys` 로 넘기고 core `prompt_counts` 를 부른다(문장 2개).
- 제안: `applied_prompts_sql(ms, *, kind: Literal['single','acr'] | None = None)`.
- 막힌 기능: 없음.

## 4. 기능 테스트 시드 경로(tests·가드)

- 무엇: 기능 테스트가 복제본에 추가 합성 행(rd 쓰기)을 넣는 공용 도우미 또는 정적 가드 스캔에서 기능 tests/ 시드 제외 규칙.
- 왜: `tests/core/test_guards.py::test_feature_sql_passes_guard` 가 app/features/** 의 모든 파싱되는 문자열·*.sql 을 API 문장 가드(G5 DO·G6 rd 쓰기)로 검사한다.
  공용 픽스처에 ACR 셀이 1개, GA4 행이 0개라 필터·스코프·게이트 기대값을 가르려면 추가 시드가 필요하다. 지금은 시드를 데이터 파일
  (`acr/tests/seed_acr.pgsql`·`clean_acr.pgsql`, `conversion/tests/seed_ga4.pgsql`·`clean_ga4.pgsql`)로 두고 conftest 가 소유자 접속으로 실행한다
  (모듈 앞뒤로 지워 다른 테스트에 영향 없음, 키 9000번대·prop 900번대).
- 제안: (a) `tests/support.py` 에 `seed_owner(sql_path)` 컨텍스트 관리자 + 가드 스캔에서 `*/tests/seed_*` 제외를 명문화, 또는
  (b) 공용 픽스처(fixture-10-data.sql)에 ACR 셀 몇 개와 GA4 속성·행을 추가(그러면 기능 시드 파일은 지운다).
- 막힌 기능: 없음.

## 5. GA4 적재 계약 확인(적재 모듈·DB, core 아님)

API 는 아래 행 역할 규칙을 전제한다. 적재 설계에서 다르면 알려 주면 쿼리만 바꾼다(conversion/queries.py 머리 주석).

1. 세션 행은 이벤트 차원이 비어 있다(event_key = 0). report 4(landing) 는 세션 행(event_key 0)과 전환 이벤트 행(is_conv, event_key ≠ 0)이 같은 page_key 로 섞여 있다고 본다.
2. report 3·4 도 device_key·nvr_key 를 채운다(현행 GA4 호출도 전환 쿼리에 device·newVsReturning 필터를 건다). 안 채우면 device[]·visitor_type[] 필터가 전환·페이지 구획을 0 으로 만든다.
3. ga4_row.engine_key 는 rd.dim_engine 과 같은 키 공간이다(모듈-AI-퍼널 §4 제안 4). 현행 ENGINE_SOURCE 의 copilot·perplexity·claude 는 rd.dim_engine 에 행이 없으면
   engine[] 로 고를 수 없다(dropped). 매핑 없는 AI 유입은 engine_key 0 으로 두면 by_engine 에 'other' 로 나온다.
4. rd.ga4_dim_property 의 brand_bit·geo_key 는 app.brand 비트·rd.dim_country 키다. API 는 시장 (브랜드, 국가) 를 이 둘로 매칭한다.

## 6. GA4 시장 카탈로그 상수의 위치

- 무엇: 코드 상수 `MARKET_CATALOG = (("Kia", "IT"),)` (현행 lib/ga4/property-map.ts MAP 의 레거시 시장). 지금은 conversion/service.py 에 있다.
- 왜: Q12 "코드 상수 + app.ga4_property". 관리 화면(GA4 레지스트리)·대시보드 KPI 타일도 같은 카탈로그를 쓰면 core.codes 로 옮기는 게 맞다.
- 막힌 기능: 없음.

## 7. ReadContext 에 website 가상 지역 비트 명시(core.filters) · 검증 D1

- 무엇: `ReadContext.virtual_brand_bits: tuple[int, ...] | None` (website 표면에서 country[] 의 virtual_brand 코드가 풀린 사이트 브랜드 비트, 없으면 None).
- 왜: `resolve_read_context` 는 HYUNDAI-N 같은 가상 코드를 국가가 아니라 사이트 브랜드 비트로 풀어 `project_keys`·`bgrps` 에만 반영하고,
  `countries` 는 스코프 국가 그대로 둔다. 사이트 프로젝트를 거치지 않는 원천(GA4 시장 = 브랜드 × 국가)은 그 좁힘을 볼 방법이 없어
  country 축이 조용히 무시됐다(ignored·dropped 어디에도 안 나옴).
- 지금 우회: conversion 은 website 표면에서 `ctx.bgrps`(= 관점 사이트 비트 ∩ 가상 비트, filters.py 의 website 분기)를 시장 브랜드 비트
  허용 집합으로 쓴다(service.resolve_markets). bgrps 의 website 의미가 바뀌면 깨지므로 명시 필드가 필요하다.
- 막힌 기능: 없음(우회 중). 같은 문제를 가질 기능: 사이트 프로젝트가 아닌 원천(GA4·ext)을 website 표면에서 읽는 기능 전부.

## 8. GA4 시장당 속성 유일성(DB·관리 모듈) · 검증 D2

- 무엇: (a) `app.ga4_property` 에 `UNIQUE (brand_code, country_code)` (현행 front `ga4_properties_brand_country_idx` 와 같음).
  (b) `rd.ga4_dim_property` 에 `UNIQUE (brand_bit, geo_key) WHERE source IN ('registry','env')` 부분 유일 색인.
- 왜: DDL 이 한 시장에 속성 여러 개를 허용해, 조회가 행 순서에 따라 다른 속성을 골랐다(값 무변화 UPDATE 한 번으로 Hyundai US 가 active →
  pending_grant, AI 세션 39 → 19). project_override 출처(프로젝트 자체 속성)도 같은 (brand_bit, geo_key) 를 가질 수 있다.
- 지금 방어: global·website 는 출처 registry·env 만 읽고(project_override 제외), 시장당 속성 하나를 active 우선 → prop_key 작은 것으로
  고른다(레지스트리 행은 상태 우선 → property_id 순). active 가 둘 이상이어도 합치지 않는다(옛·새 속성 이중 계상 방지).
  DB 제약이 생기면 선택 규칙은 무의미해지지만 해가 없다.
- 막힌 기능: 없음. 담당: DB-v2 스키마·관리 화면(GA4 레지스트리) 모듈.

## 9. (선택) 요청 필터가 결과를 비웠는지 판정 도우미(core.filters) · 검증 D4

- 무엇: `ReadContext.scope_only()` 처럼 요청 축을 뺀 스코프 기준 브랜드·국가(또는 "요청이 country/brand 를 줬는가" 플래그).
- 왜: 빈 결과가 '원천 준비 중(source_pending)' 인지 '필터가 다 걸러낸 빈 집합' 인지는 요청 전 스코프와 비교해야 가른다.
  지금은 conversion 이 `DataScope.brands`·`DataScope.countries` 로 스코프 시장을 다시 계산한다(service.scope_markets, 술어 재구현 아님).
- 막힌 기능: 없음.

