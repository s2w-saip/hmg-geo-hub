# core 요청: an-cit-a(analytics.citations.domains·domain_detail·sources·tone, C-1·C-2)

막힌 기능 없음(4기능 5엔드포인트 전부 구현). 아래 R1·R2 는 기능이 core 밖에서 임시로 들고 있는 것이고(R2 는 2차 라운드부터 임시 게이트),
R3~R5 는 비차단 제안, R6·R7 은 DB 제안(확정 DDL 변경이라 채택 여부만 판단 요청)이다.

## R1. 출처 카테고리 해석(오버라이드 반영)과 source[] 축을 core.measure 로 이관(우선순위 높음, 비차단)

- 무엇: 인용 원소의 유효 카테고리 = `coalesce(app.citation_domain_override.category_key, rd.dim_source.category_key)`(결합 키 `o.domain = ds.skey`),
  그리고 공통 필터 source[](ReadContext.source_category_keys)를 rd.citation 에 거는 술어.
  지금은 `app/features/analytics/citations/domains/shared.py`(EFFECTIVE_CATEGORY·OVERRIDE_JOIN·source_category_where)에 두고 네 기능이 import 한다.
- 왜:
  - core.measure.citation_where 는 모듈-인용 §3 이 적은 "선택: source 카테고리(dim_source 조인)" 축을 아직 받지 않는다. MeasureScope 에도 source 축이 없다.
    같은 축을 C-3(an-cit-b, /v1/citations/prompts)·T-1(카테고리 추이)·AD-3 후보 목록이 각자 쓰면 해석이 갈린다.
  - 오버라이드 우선순위는 적재기 category_of(seed-3x-common.sql:199, category_src 1 = 오버라이드)와 같다. 조회 시 결합하면 judgment_change
    'citation_override' 적재 반영 전에도 화면에 즉시 보이고, 반영 뒤에는 dim_source 값과 같아 결과가 변하지 않는다.
- 제안 시그니처:
  - `core.measure.CATEGORY_EXPR = "coalesce(o.category_key, ds.category_key)"`, `core.measure.OVERRIDE_JOIN`
  - `MeasureScope.source_category_keys: tuple[int, ...] | None` (ReadContext.measure() 가 채움)
  - `citation_where(ms, win, c, b)` 가 source_category_keys 가 있으면
    `c.source_key IN (SELECT ds.source_key FROM rd.dim_source ds LEFT JOIN app.citation_domain_override o ON o.domain = ds.skey WHERE <CATEGORY_EXPR> = ANY(:keys))` 를 더한다.
  - 이관되면 기능 쪽은 shared.py 의 세 상수·함수를 core import 로 바꾸기만 하면 된다(동작 동일).
- 막힌 기능: 없음(임시 구현으로 동작). 이관 전까지 C-3 빌더가 같은 조각을 원하면 shared.py 를 import 하도록 안내 요청.

## R2. 표면별 경로 게이트(route-policy 계승)를 resolve_read_context 에(우선순위 높음, 보안)

- 무엇: 읽기 요청의 surface 에 따른 역할·메뉴 게이트. 현행 lib/auth/route-policy.ts: global(표준) = hq·region·country·admin,
  website = 표준 4역할 + website, project = hq·region·country·admin·vendor, 그리고 menu_groups(standard·website·project) 좁히기.
- 왜: core.auth 의 require_menu_group·require_role 은 라우터 dependencies= 로 거는 정적 게이트라, surface 를 쿼리로 받는 분석 API 는 요청마다 다른 그룹을
  걸어야 한다. 지금 분석 API 는 이 게이트 없이 데이터 스코프(DataScope)만으로 거른다. 예: 테스트 계정 VENDOR(menu {project}, 브랜드 스코프 없음 =
  추가 결정으로 글로벌·웹사이트 무제한)는 /v1/citations/domains?surface=global 을 200 으로 받는다. HQ_HYUNDAI(menu {standard, project})의 website
  요청도 게이트 없이 데이터 스코프만 적용된다(현대 사이트가 없어 빈 결과).
  기능마다 게이트를 따로 쓰면 재구현이라 core 에 두어야 한다.
- 임시 방어(2차 라운드, 검증 결함 D1 critical): core 이관 전까지 기능 쪽 `domains/shared.require_surface` 를 `open_read` 첫 줄에서 건다
  (인용 5엔드포인트 공통, route-policy 역할 천장 + menu_groups 좁히기, 403 `role_forbidden`·`menu_forbidden`). 회귀 테스트
  `domains/tests/test_surface_gate.py`. core 에 `require_surface` 가 들어오면 shared 의 표·함수를 지우고 core 호출로 바꾼다(동작 동일해야 함).
  fail-closed 로 route-policy 쪽을 택했다: 추가 결정 'vendor 글로벌·웹사이트 무제한'은 반영 기록상 DataScope(데이터 값) 결정이고, 경로 게이트는
  현행(route-policy.ts STANDARD_VIEWERS·WEBSITE_VIEWERS 에 vendor 없음)이 막는다고 읽었다. 결정권자가 vendor 의 표면 진입까지 허용한다고 확정하면
  `_SURFACE_ROLES` 의 global·website 에 vendor 를 더하면 된다(menu_groups 좁히기는 그와 무관하게 유지).
- 제안 시그니처: `core.auth.require_surface(p: Principal, surface: Surface) -> None`(403 `role_forbidden`·`menu_forbidden`),
  resolve_read_context 첫 줄에서 호출(모든 분석 읽기에 일괄 적용). 추가 결정(vendor 글로벌·웹사이트 무제한)과 route-policy 가 충돌하므로 어느 쪽이
  API 기준인지 결정도 함께 요청.
- 막힌 기능: 없음. 결정 요청: vendor 역할의 global·website 표면 진입 허용 여부(데이터 스코프 결정과 별개).

## R3. 공통 필터 + 기능 추가 파라미터 합성 방식(비차단)

- 무엇: FastAPI 0.141 은 쿼리 파라미터 모델(`Annotated[CommonFilters, Query()]`)과 다른 개별 Query 인자를 한 엔드포인트에 섞으면 모델 전체를
  'filters' 라는 필수 인자 하나로 본다(실측: 422 `loc: [query, filters]`). 그래서 기능은 CommonFilters 를 상속한 쿼리 모델(DomainsQuery·ToneQuery 등)에
  limit·cursor·tone 등을 더한다.
- 제안: core.filters 머리 주석에 이 패턴을 적고, 키셋 목록 공용 믹스인 `class PagedFilters(CommonFilters): limit, cursor` 와
  커서 필터 해시 `core.pagination.params_hash(params, request)`(cursor·limit 제외 + cf.* 포함)를 core 로. 지금은 shared.py request_hash 가 한다.
- 막힌 기능: 없음.

## R4. Refs 에 출처 카테고리 표시 정보(비차단)

- 무엇: Refs.categories 는 slug → category_key 만 있다. 응답 CategoryRef(key·slug·name)를 만들려고 기능이 요청마다 app.citation_category(13행)를 한 번 더 읽는다.
- 제안: `_REFS_SQL` 'cats' 에 name·ord 를 싣고 `Refs.category_refs: dict[int, (slug, name, ord)]` 추가(같은 문장, 추가 왕복 0).
- 막힌 기능: 없음.

## R5. 억제 사유 코드 상수(비차단)

- 무엇: 응답 전체 억제 '*' 사유로 `no_active_snapshot`(스냅샷 회차 없음)·`hidden`(창 회차가 계열에서 전부 숨김, Window.hidden 주석)을 쓴다.
- 제안: core.envelope 에 `SUPPRESS_NO_SNAPSHOT`·`SUPPRESS_HIDDEN` 상수와 `window_suppression(win, family) -> dict[str, str]` 도우미를 두어 기능마다
  같은 판정을 쓰게 한다(지금은 shared.open_read 가 판정).
- 막힌 기능: 없음.

## R6. (DB 제안) rd.dim_url 표시 URL 열(비차단, 모듈-인용 §8 열린 질문 10)

- 톤 드릴다운 q 검색은 현행 citationDisplayUrlSql 을 조회 시 식 `regexp_replace(split_part(du.url, '#', 1), '^https?://', '')` 로 이식했다.
  행 수가 집계 뒤 URL 수라 부담은 작지만, P1 취지대로 적재 시 `rd.dim_url.display_url` 로 굳히면 식 이식이 사라진다. 채택 여부만 판단 요청.

## R7. (DB 제안) 인용 URL 국가(비차단)

- 드릴다운 urls[].country 는 현행 geoEntryForUrl(geo 카탈로그) 대신 자사 URL 의 owned base 국가(`rd.dim_url.owner_key → app.owned_base.geo_code`)로
  냈다. 자사가 아닌 URL 은 null. 현행과 같게 하려면 적재 시 `rd.dim_url.geo_code` 판정 열이 필요하다. 채택 여부만 판단 요청.

## R8. 자유 문자열 파라미터 값 규칙 공개(비차단, 검증 결함 D2·D3)

- 무엇: core.filters 의 `_VALUE_RE`(`^[^\x00-\x1f\x7f]{1,100}$`)는 비공개라 기능의 자유 문자열 파라미터(mention_brand·경로 skey·검색 q)에 걸 수 없었다.
  NUL 이 DB 까지 가면 드라이버 인코딩 오류가 500 internal 로(D2), core fetch_keyset 경로에서는 422 `cursor_invalid` 로(D3, 원인과 다른 메시지) 나왔다.
- 기능 쪽 조치: `domains/shared.SAFE_TEXT = r"^[^\x00-\x1f\x7f]+$"` 를 Field·Path `pattern=` 으로 걸어 422 unprocessable(loc = 필드명)로 막았다.
- 제안: core 에 `SAFE_TEXT_PATTERN`(길이는 Field 가 맡는 형태) 공개 상수, 그리고 `fetch_keyset` 이 DB 인코딩 오류(CharacterNotInRepertoireError·
  UntranslatableCharacterError)를 cursor_invalid 로 뭉개지 않게 분리(원인 코드 보존). 전 기능 공통 방어가 된다.
- 막힌 기능: 없음.
