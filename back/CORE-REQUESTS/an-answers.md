# core·DB 요청: an-answers (analytics.answers.list · analytics.answers.detail)

작성 2026-09-28 · 빌더 an-answers · 기준 stg 0092400. 각 항목은 무엇·왜·제안 시그니처·막힌 기능 순이다.

## R1. rd.answer_stance 에 cyc_key 가 없어 경계 가드(G1)를 통과할 수 없다 (DB 또는 core.sqlguard)

- **무엇**: `app.core.sqlguard.FACT_TABLES` 는 rd.answer_stance 를 사실 표로 보고 surface·round_date·cyc_key 세 술어를 요구한다.
  그런데 DB-v2.4 의 rd.answer_stance(`back/db/DB-v2.4.sql` 6-4)에는 cyc_key 열이 없다. 어떤 기능도 이 표를 읽을 수 없다
  (실측: 상세 번들에서 `s.cyc_key` 를 넣으면 `column s.cyc_key does not exist`, 빼면 G1 위반).
- **왜**: 상세(AN-2)의 스탠스 당사 판정과 스탠스 분포 계열 기능(M-2 등)이 이 표를 읽는 설계다(모듈-답변-드릴다운 §3.2).
- **제안**(택1)
  1. DB: `rd.answer_stance` 에 `cyc_key int4 NOT NULL` 추가(다른 사실 표 3종과 같은 투영 규칙, 적재기 투영 1열).
  2. core: sqlguard 가 사실 표별 필수 술어를 갖게 한다. 예 `FACT_REQUIRED = {"answer_stance": {"surface", "round_date"}, …}`.
- **막힌 기능**: analytics.answers.detail 의 stances 는 우회 없이 같은 그레인의 문서형 뷰 `rd.v_answer_stance_raw`(판정 원문)
  + `rd.dim_entity → rd.dim_brand_name.own_bit` 로 읽었다(술어 재구현 아님, 판정값 = 같은 원천). R1 이 풀리면 rd.answer_stance.own_bit 로 바꿀 수 있다.

## R2. 표면 경로 게이트 헬퍼 (core.auth)

- **무엇**: 표면(global·website·project)마다 허용 역할 × 메뉴 그룹을 거는 게이트. 현행 `lib/auth/route-policy.ts`
  STANDARD_VIEWERS(hq·region·country·admin)·WEBSITE_VIEWERS(+website)·PROJECT_VIEWERS(+vendor) 와 menu_groups 좁히기.
- **왜**: 표면을 질의 파라미터로 받는 읽기 API 는 `require_menu_group` 을 정적 dependencies 로 걸 수 없다. 모듈-KPI §5·모듈-프롬프트 §3 도
  같은 정책을 요구한다. 지금은 두 기능(list·detail)이 같은 표를 각자 들고 있다(`_SURFACE_ROUTE`).
- **제안 시그니처**: `def surface_route_allowed(p: Principal, surface: Surface) -> tuple[bool, str]` 와
  `def require_surface_route(p: Principal, surface: Surface) -> None`(403 role_forbidden | menu_forbidden).
- **막힌 기능**: 없음. 2026-09-28 수정 라운드(검증 D3)에서 표를 목록(`list/service.py`) 한 벌로 줄이고 상세는 그 함수를 import 한다.
  core 에 들어오면 목록의 `_SURFACE_ROUTE`·`surface_route_allowed` 와 상세의 import 를 지운다.
- **중재 요청(설계, D3)**: DECISIONS-API 추가 결정(2026-09-28) "브랜드 스코프가 빈 vendor 계정의 글로벌·웹사이트 조회 = 현행처럼 무제한"과
  모듈-프롬프트 §3("vendor 는 전 엔드포인트 403")·현행 `route-policy.ts`(vendor 는 표준·웹사이트 경로 밖)가 충돌해 보인다.
  이 기능의 해석: 추가 결정은 **데이터 스코프**(`DataScope.of`, 경로를 통과한 뒤의 브랜드 무제한)에 관한 것이고, **경로 계층의 vendor 배제는 유지**한다
  (현행 route-policy.ts:40 "Here we only keep vendor OUT at the route layer"). 그래서 vendor 의 `?surface=global|website` 는 403 `role_forbidden`,
  surface 없이 상세를 부르면 404(존재 은폐)다. 이 해석이 맞는지 DECISIONS-API 에 한 줄 중재를 요청한다. 반대로 결정되면 `_SURFACE_ROUTE` 의
  global·website 역할 집합에 vendor 를 넣는 한 줄 수정이다.

## R3. envelope.Page 에 창 경계 필드 (core.envelope)

- **무엇**: `Page` 에 `window_from: date | None`, `window_to: date | None`.
- **왜**: 답변 목록은 기간 모드에서 한 페이지가 훑는 round_date 창을 92일로 끊어 걷는다(모듈-답변-드릴다운 §3.1, 열린 질문 2).
  부분 페이지의 창 경계를 프론트가 알아야 "이 구간에는 더 없음"을 그릴 수 있다. 지금은 `data.window{window_from, window_to}` 로 낸다.
- **막힌 기능**: 없음. 합의되면 data.window 를 meta.page 로 옮긴다.

## R4. pytest 모듈 이름 충돌 (pyproject 또는 기능 트리 __init__.py)

- **무엇**: `app/features/<대분류>/<도메인>/` 중간 디렉토리에 `__init__.py` 가 없고 기능 디렉토리(list·detail 등)와 `tests/` 에만 있다.
  pytest 기본 prepend 모드는 이때 모듈 이름을 `list.tests.test_x` 로 만든다. 다른 도메인의 `list/tests/` 가 둘 이상 수집되면 충돌한다
  (실측: 임시 트리 a/list/tests·b/list/tests → `ModuleNotFoundError: No module named 'list.tests.test_b'`).
- **제안**: pyproject `[tool.pytest.ini_options] addopts = "--import-mode=importlib"` 또는 기능 트리 중간 디렉토리에 `__init__.py`.
- **이 기능의 조치**: 담당 경로의 `tests/__init__.py` 를 지우고 파일명을 고유하게 했다(`test_an_answers_list.py`·`test_an_answers_detail.py`).
  core 조치 후 되돌려도 된다.

## R5. rd.dim_source(domain) 인덱스 (DB, 제안: RDS 실측 후 판단)

- **무엇**: `CREATE INDEX dim_source_domain_idx ON rd.dim_source (domain)`(모듈-답변-드릴다운 §5 제안 그대로).
- **왜**: 목록의 `domain` 필터는 요청마다 `rd.dim_source WHERE domain = :d` 로 source_key 를 푼다. 10배 dim_source 규모에서 순차 스캔이면
  요청마다 전량을 읽는다. 차원 표 btree 라 D8·HOT 규율과 무관.
- **막힌 기능**: 없음(현재 순차 스캔으로 동작).

## R6. 접근 감사 버퍼 조회 공개 API (core.write, 선택)

- **무엇**: `AccessAuditWriter.pending() -> tuple[AuditEvent, ...]`(읽기 전용 스냅샷).
- **왜**: 기능 테스트가 "민감 조회 1건 = 감사 1건"을 단언하려면 지금은 비공개 `_buf` 를 읽어야 한다.
- **막힌 기능**: 없음(테스트가 `_buf` 를 읽고, `flush()` 후 app.access_audit_log 를 조회해 확인).

## R7. 억제 사유 코드 문서 정렬 (설계 문서, D4)

- **무엇**: 모듈-답변-드릴다운 §3.2 응답 예시의 `meta.suppressed` 사유 `hidden_scope` 를 `hidden` 으로 고치고, 목록(§3.1)에 `partial_hidden` 을 추가.
- **왜**: core 는 계열 숨김 사유를 `hidden` 으로 쓴다(`app.core.cycles.Window.hidden` docstring "지표 억제 사유 'hidden'"). 다른 기능도 전부 `hidden` 이다.
  기능마다 다른 코드를 쓰면 프론트가 사유별 분기를 둘로 둬야 하므로, 이 기능은 문서 예시가 아니라 core 코드를 따른다(문서와 코드가 다르면 코드가 이긴다).
  또 목록 기간 모드에서 언급·인용 술어가 걸린 채 창의 **일부** 회차만 그 계열 숨김이면, 그 회차 행이 빠지는데도 사유가 비어 있었다.
  이제 `partial_hidden`(남은 회차 행만 나온다는 고지)을 적는다(`list/service.py family_hidden_reason`). 전부 숨김은 그대로 `hidden`.
- **제안**: 공통 사유 어휘에 `partial_hidden` 을 올릴지 결정(core.envelope docstring 또는 DESIGN-CONTRACT 에 억제 사유 표). 다른 기간 모드 기능도 같은 공백이 있을 수 있다.
- **막힌 기능**: 없음.

## R8. website 목록의 당사 판정 기준 (설계 중재, D1 연관)

- **무엇**: 상세(AN-2)는 §3.2 3단계대로 website 당사 비트를 **답변 사이트의 브랜드**(`rd.dim_project.site_brand_bit` → 당사 열 비트)로 고쳤다(검증 D1).
  목록(AN-1)의 `mentions.own`·`signal` 술어는 모듈 문서 §3.1 대로 요청 관점 `own_bits`(brand[] ∩ 스코프)를 쓴다.
- **왜**: brand[] 를 준 경우(예 brand=Kia)에는 사이트가 그 브랜드로 좁혀져 둘이 같다. brand[] 가 없는 ADMIN·HQ 는 관점이 3사라,
  Kia 사이트 답변의 Hyundai 언급이 목록 own 합에는 들어가고 상세에서는 own=false 로 보인다.
- **제안**(택1): ① 목록 website 도 행 단위 사이트 브랜드 비트로 own·signal 을 계산(행의 project_key → site own bit, signal EXISTS 에 사이트별 비트 조건).
  ② 현행 유지(목록 = 요청 관점 집계, 상세 = 사이트 관점)를 문서에 명시. 결정 전까지 목록은 문서 §3.1 그대로 둔다.
- **막힌 기능**: 없음.

## R9. 픽스처 변형 도우미 (tests/support, 선택)

- **무엇**: 복제 DB 의 rd 행을 잠깐 바꾸고 되돌리는 테스트 도우미(예 `tests.support.rd_patch(sql_apply, sql_revert)` 비동기 컨텍스트 매니저).
- **왜**: 기능 트리(`app/features/**`)는 tests 까지 정적 가드 G6(rd 쓰기 금지)·G1 대상이라, 기능 테스트가 "사이트 답변에 다른 브랜드 행 추가"나
  "회차 하나만 언급 숨김" 같은 상태를 DB 에 만들 수 없다. 이번 라운드(D1·D4 회귀)는 번들 결과 주입과 `ReadContext.window` 결과 재접기(core.build_window)로 대신했다.
  SQL 경로 자체(사이트 다브랜드 행이 번들로 읽히는가, hidden_scope 3 회차가 창에서 빠지는가)는 core·검증자 쪽 DB 변형으로만 확인된다.
- **막힌 기능**: 없음.
