# core 요청: an-filters (analytics.filters.options F-1 · analytics.filters.dates F-2)

기준: stg 0092400. 아래는 막힌 것이 아니라(두 기능 모두 core 공개 함수만으로 구현 완료) 중복·성능·일관성 개선 요청이다.

## R1. 표면 인자형 메뉴 게이트 (core.auth)

- 무엇: `async def require_surface_menu(p: Principal, surface: Surface) -> None` (global→standard, website→website, project→project).
  또는 `check_menu_group(p, group) -> None` 을 공개하고 `require_menu_group` 이 그것을 감싸게.
- 왜: `surface` 가 쿼리 파라미터라 라우터 `dependencies=[require_menu_group(...)]` 로 고정할 수 없다. 지금은 두 기능이
  `await require_menu_group(SURFACE_MENU[surface]).dependency(principal)` 로 core 의존성 함수를 직접 부른다(동작은 core 그대로,
  모양이 우회적). 표면 매핑(SURFACE_MENU)이 기능마다 복제되면 다른 분석 기능과 어긋날 수 있다.
- 막힌 기능: 없음(임시 호출 방식으로 동작). 공개되면 두 기능의 `require_surface_menu` 를 교체.

## R2. 선택 가능 회차 날짜 함수 (core.cycles)

- 무엇: `async def selectable_round_dates(conn, *, surface, project_keys, family: Family, limit: int, today: date | None = None)
  -> tuple[list[date], int, int | None]` (내림차순 날짜·전체 개수·generation). SQL 은 `_RANGE_SQL` 과 같은 후보 술어
  (servable · view_date ≤ 오늘 KST) + `hidden_scope <> ALL(HIDDEN_EXCLUDE[family])` + `SELECT DISTINCT round_date … LIMIT`.
- 왜: F-2 는 게이트 술어(R01·R03)를 기능 안에 다시 쓰지 않으려고 `resolve_window(date_from=1900-01-01, date_to=9999-12-31)` 로
  후보 회차 행 전부를 받아 파이썬에서 DISTINCT·계열 배제·절단한다. 결과는 맞지만 website 10배 폭(사이트 수 × 회차 수, 수만 행)에서
  회차 행을 전부 전송한다. core 가 DISTINCT round_date 를 DB 에서 내면 전송이 최대 400행으로 준다. 로컬 EXPLAIN 은
  `cycle_pick_idx` Index Only Scan(surface·round_date 범위) 확인.
- 막힌 기능: 없음. 공개되면 `dates/service.py get_dates` 의 resolve_window 호출을 교체.

## R3. Refs 에 권역 코드·웹사이트 숨김 시장 추가 (core.codes)

- 무엇: `Refs.areas: dict[int, str]`(rd.dim_region region_key → code), `Refs.hidden_markets: dict[str, frozenset[str]]`
  (app.hidden_market surface → 국가 코드). 조회용 역색인 `Refs.lang_code(lang_key)`·`Refs.engine_code(engine_key)`·O(1) `country_by_key`.
- 왜: F-1 은 국가 옵션의 소속 권역 코드와 웹사이트 숨김 시장(app.hidden_market surface='website')이 필요해 기능 안에서 작은 참조
  문장(`options/queries.py DIM_SQL`)을 한 번 더 실행한다. 글로벌 숨김은 이미 `Country.hidden_standard` 로 Refs 에 있는데 웹사이트
  숨김만 빠져 있어 다른 웹사이트 기능(K-1·T-1 등)이 같은 표를 따로 읽게 된다(숨김 규칙 분산).
- 막힌 기능: 없음.

## R4. (확인 요청) 숨김 국가·계정 국가 스코프를 데이터 경로에도 거는가

- F-1 은 global 옵션에서 `rd.dim_country.hidden_standard` 국가를, website 옵션에서 app.hidden_market(website) 국가를 뺀다(단위 F-1
  metrics_rules, 현행 HIDDEN_STANDARD_REGIONS). core `scope_where`·`resolve_read_context` 는 데이터 경로에서 이 숨김을 걸지 않는다
  (합성 픽스처의 ID 답변은 적재기가 elig 거짓으로 둬서 결과는 같다). "옵션 ⊇ 데이터" 가 적재 판정(elig)에만 기대는 것이 의도인지 확인 필요.
- project 표면은 core 결정(계정 국가 스코프 미적용, 모듈-필터 열린 질문 6)을 따라 숨김도 걸지 않았다.

## R5. (문서 동기화) 모듈-필터.md §2.2 필드 이름·§7 기준일 불변식 (검증 M1·M3, 7384654 이후)

- 무엇: `docs/design/api/모듈-필터.md` 는 이 빌더의 수정 경로 밖이라 고치지 못했다. 설계 문서 담당이 두 곳을 맞춰 주기를 요청한다.
  1. §2.2 응답 data: `geo_matrix[{brand, country, lang}]` → `geo_matrix[{brand, region, lang}]`, `countries[{code, region, kind}]` →
     `regions[{code, area, kind}]`. 근거: 프론트 유지 원칙(계약서), 현행 `MeasuredScopeCombo {brand, region, lang}`
     (front/components/dash/dimension-filter-panel.tsx:643). 구현은 이 이름으로 확정하고 README·schemas.py 에 차이를 적었다.
  2. §7 불변식 "F-1 meta.as_of = F-2 latest_round_date" → "F-2 latest_round_date(family) ≤ F-1 meta.as_of, 최신 회차가 그 family 로
     숨겨지지 않았으면 같다". §8 열린 질문 3 의 family 별 안을 구현했다(F-1 스냅샷 = core 함대 스냅샷 row 계열, F-2 = family 별).
     hidden_scope 3 은 Q18 예비값이라 운영에서 아직 갈리지 않지만, 쓰기 시작하면 언급 화면 기준일이 F-1 보다 이르다.
- 막힌 기능: 없음(문서만).
