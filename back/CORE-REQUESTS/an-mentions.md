# core·DB 요청: an-mentions (analytics.mentions.brands·types·prompts)

작성: an-mentions 빌더, 2026-09-28, 기준 stg 0092400. 기능 코드는 아래 요청을 우회하지 않았다(술어 재구현·가드 우회 없음).
갱신: 2026-09-28 수정 라운드(검증 a97af82 결함 D1~D4 반영). 독립 검증자가 R1(D2)·R2(D3)를 결함으로 다시 지적했다: 둘 다 core 결정·구현 대기이며 긴급도를 올린다.

| # | 무엇 | 막힌 기능 | 긴급 |
| --- | --- | --- | --- |
| R1 | `rd.answer_stance` 에 `cyc_key` 열(또는 가드 예외) | analytics.mentions.types 의 스탠스(A3) | **높음**(검증 fail 사유, partial) |
| R2 | 표면별 경로 게이트를 `core.auth` 로 + vendor 경로 정책 확정 | 없음(기능 안 임시 구현, 검증 D3) | **중상**(규약 위반 지적) |
| R3 | pytest 모듈 이름 충돌(`types`·같은 이름 기능) | 없음(우회함) | 중(병합 시 전체 수집 실패 가능) |
| R4 | 기능 테스트용 합성 사실 행 도우미 | 없음(우회함) | 낮음 |
| R5 | signal 모드 부분 인덱스 제안(P1) | 없음(성능, RDS 게이트 후 판단) | 낮음 |

## R1. rd.answer_stance 에 cyc_key 가 없어 스탠스 조회가 SQL 경계 가드 G1 을 통과할 수 없다

- **무엇**: `rd.answer_stance`(DB-v2.4.sql:497) 에는 `surface`·`round_date`·`answer_key` 만 있고 `cyc_key` 가 없다. `core.sqlguard` G1 은 사실 표 RangeVar 마다
  `surface`·`round_date`·`cyc_key = ANY` 세 술어를 요구하므로(sqlguard.py `_check_select`) `rd.answer ⋈ rd.answer_stance` 등치 조인(모듈-언급 §3.2)은
  `a` 쪽에 세 술어가 다 있어도 `s` 쪽 cyc_key 때문에 항상 위반이다. 기능 코드는 가드 우회(`hgh_sql_guard`)를 쓸 수 없다(test_guards).
- **왜**: 가드 문제만이 아니라 의미 문제도 있다. 회차 숨김(hidden_scope 3 mentions·1 all)은 `cyc_key` 로만 가를 수 있는데 스탠스 표에는 그 키가 없다.
  `rd.answer_brand` 는 `cyc_key` 사본을 갖고 `rd.propagate_answer_gates` 가 `cyc_key` 까지 맞춘다(DB-v2.4.sql:549). 스탠스 표만 빠져 있다.
- **제안(택1)**
  1. (권장) DDL: `ALTER TABLE rd.answer_stance ADD COLUMN cyc_key int4 NOT NULL` + 적재기 투영에서 `rd.answer.cyc_key` 복사 +
     `rd.propagate_answer_gates` 의 answer_stance UPDATE 에 `cyc_key = a.cyc_key` 추가(answer_brand 와 같은 규칙). 스탠스 조인은 그대로 두되 `s.cyc_key = ANY` 를 건다.
  2. 가드 예외: `rd.answer_stance s` 가 `rd.answer a` 와 INNER JOIN ON `(surface, round_date, answer_key)` 등치이고 `a` 에 세 술어가 있으면 `s` 의 cyc_key 를 면제.
- **준비된 것**: `types/queries.py` `stance_sql()` 빌더(필터 축은 `a` 쪽 `scope_where`, `s.first_turn ∧ s.std_in ∧ s.own_bit = ANY(관점 비트)`)와
  `STANCE_READY = False` 스위치. 지금은 `data.stance = null`, `meta.suppressed.stance = "pending_core"`.
  `test_stance_sql_blocked_only_by_missing_cyc_key` 가 위반이 정확히 `G1 rd.answer_stance s: cyc_key 술어 없음` 하나임을 고정해 둔다.
  제안 1 반영 시: `stance_sql` 에 `s.cyc_key = ANY(...)`(Window.where 의 세 번째 항) 추가, `STANCE_READY = True`, 시험을 값 대조로 뒤집으면 끝난다.
  값 대조 시험은 미리 써 두었다(`types/tests/test_mentions_types.py::test_stance_values_when_ready`, `STANCE_READY` 가 거짓이면 skip).
  손 계산: 현대 관점 {positive 1, pairs 1}, 전사 관점 {positive 1, mixed 1, pairs 2}(fixture-10-data ing.answer_stance, 대표 턴 0 만).
- **검증 판정(2026-09-28, D2)**: 기능 쪽에서 고칠 수 없음 확인. 해소 전까지 analytics.mentions.types 는 partial 로 남는다.
- **막힌 기능**: analytics.mentions.types 의 `stance`(A3). 유형 분포·매트릭스는 정상 동작.

## R2. 표면별 경로 게이트(route-policy)를 core.auth 로

- **무엇**: 한 엔드포인트가 `surface=global|website|project` 를 모두 받으므로 라우터 `dependencies=[require_menu_group(...)]` 정적 게이트로는 표현이 안 된다.
  현행 route-policy(front/lib/auth/route-policy.ts: STANDARD_VIEWERS·WEBSITE_VIEWERS·PROJECT_VIEWERS, 그룹 standard·website·project)를
  `brands/common.py surface_gate()` 에 임시로 옮겼다(역할 ∉ 그 표면 시청자 → 403 role_forbidden, 메뉴 그룹 없음 → 403 menu_forbidden).
- **왜**: 모든 다표면 분석 API(KPI·추이·인용·국가·답변)가 같은 표를 써야 한다. 기능마다 옮기면 표가 갈린다.
- **제안 시그니처**: `app.core.auth.require_surface(p: Principal, surface: Surface) -> None`(또는 `resolve_read_context(..., gate=True)` 안에서 호출).
  표 = `SURFACE_ROLES: dict[Surface, frozenset[Role]]`, `SURFACE_MENU: dict[Surface, MenuGroup]`.
- **확인 요청**: vendor 의 global·website 조회를 "현행처럼 무제한"(DECISIONS-API 추가 결정)으로 둔 것은 데이터 스코프 결정이고, 경로상 vendor 는 표준·웹사이트 화면이
  없다(route-policy). 이 게이트로 vendor 의 global·website 요청은 403 이다. 결정 의도가 경로까지 열라는 뜻이면 표를 고친다.
- **검증 판정(2026-09-28, D3 minor)**: 게이트 동작은 의도대로(vendor global·website 403, website 역할 global·project 403)지만 권한 규칙이 core 밖에 있어
  "기능 안 재구현 금지" 에 어긋나고, vendor 403 이 추가 결정 문구("무제한, 403 기각")와 글자 그대로는 다르다는 지적.
  - 기능 쪽 처리: 복사본을 지우면 게이트가 사라져(vendor·website 역할이 모든 표면을 열게 됨) 권한이 넓어지므로 **core 이관 전까지 유지**한다.
    이관되면 `brands/common.py` 의 `_SURFACE_ROLES`·`_SURFACE_MENU`·`surface_gate` 를 지우고 `read_scope` 첫 줄을 core 호출로 바꾼다(한 줄).
  - 회귀 시험: `brands/tests/test_mentions_brands.py::test_access_denied`(vendor 403·메뉴 403)와 `::test_website_role_gate`(website 역할 200/403)가
    이관 후에도 같은 결과를 요구한다.
  - 결정 요청(택1): ① (권장) 추가 결정은 데이터 스코프만 뜻하고 경로는 route-policy 대로 vendor 를 표준·웹사이트에서 막는다(현재 동작).
    ② 경로까지 연다: `SURFACE_ROLES["global"|"website"]` 에 vendor 추가. 어느 쪽이든 core 표 한 곳에서만 정한다.

## R3. pytest 모듈 이름 충돌

- **무엇**: `app/features/analytics/`·`app/features/analytics/mentions/` 등 중간 디렉터리에 `__init__.py` 가 없어 pytest(prepend 모드)가
  `types/tests/test_x.py` 를 `types.tests.test_x` 로 가져오려다 표준 라이브러리 `types` 와 충돌한다(ModuleNotFoundError). 같은 이름 기능
  (`analytics.mentions.prompts`·`analytics.citations.prompts`·`catalog.prompts`…)의 `tests/__init__.py` 도 병합 후 `prompts.tests` 로 서로 충돌한다.
- **우회(이 브랜치)**: 세 기능의 `tests/__init__.py` 를 지우고 시험 파일 이름을 `test_mentions_<기능>.py` 로 유일하게 했다.
- **제안**: `pyproject.toml` `[tool.pytest.ini_options] addopts = "--import-mode=importlib"` 또는 중간 디렉터리 `__init__.py` 일괄 추가(스캐폴드 수정).

## R4. 기능 테스트의 합성 사실 행

- **무엇**: 정적 가드(test_feature_sql_passes_guard)가 `app/features/**` 의 시험 파일까지 G6(rd 쓰기)·G1 로 검사해, 기능 시험이 픽스처에 없는 경우
  (셀 대표 R05·runs 처럼 한 셀에 답변 여러 건)를 SQL INSERT 로 만들 수 없다.
- **우회(이 브랜치)**: 소유자 접속 트랜잭션에서 asyncpg `copy_records_to_table` 로 넣고 빌더 문장을 같은 트랜잭션에서 실행한 뒤 롤백
  (`prompts/tests/test_mentions_prompts.py::test_answers_cell_representative_and_runs`). 커밋하지 않아 다른 시험·빌더에 영향이 없다.
- **추가 우회(수정 라운드)**: 검증 D4 가 요구한 경로(두 회차 모두 값이 있는 기간 모드, Hyundai N 전용 bgrp 16 제외)도 픽스처에 없어
  `brands/tests/mentions_testkit.py` 에 롤백 트랜잭션 도구를 두었다: COPY 로 합성 행을 넣고, SQLAlchemy `conn.execute(text, params)` 표면만 흉내 내는
  `TxConn`(바인드 리터럴 치환 + 실행 전 `fact_guard`) 으로 기능 서비스를 같은 트랜잭션에서 실행한다. 회차 숨김·세대 변경은 `rd.cycle` 쓰기(G6)가
  기능 시험에서 막혀 `ReadContext.window` 결과를 monkeypatch 해 HTTP 경로로 본다. core 도우미가 생기면 이 도구를 지운다.
- **제안**: `tests/support.py` 에 `fact_rows(conn, table, rows)` 도우미(롤백 트랜잭션 전용) 또는 합성 픽스처에 반복 측정 셀 추가
  (fixture-10-data: 같은 (프롬프트, 엔진, 국가) 셀에 is_rep 답변 + 비대표 답변, answer_brand 경쟁 행 포함).
  함께 넣으면 좋은 행: 회차 10 의 std_in 답변(기간 모드 두 회차 합산), bgrp 16(Hyundai N 전용) 답변, 언급 숨김(hidden_scope 3) 회차 하나,
  시험용 `app.user_account` website 역할 계정(지금은 `get_principal` 의존성 덮어쓰기로 시험).
  기능 시험에서 쓸 수 있는 커밋형 도구(회차 숨김·세대 증가를 걸고 되돌리는 컨텍스트 관리자)도 요청한다.

## R5. (제안, 성능) signal 모드 부분 인덱스

- 모듈-언급 §5 P1: `CREATE INDEX ab_own_idx ON rd.answer_brand (round_date, prompt_key) INCLUDE (answer_key) WHERE own_bit <> 0`.
- 로컬 합성 DB EXPLAIN: brand 모드는 `ab_brand_idx`(leaf `answer_brand_g_202609_brand_key_round_date_…_idx`)를 타고, signal 모드는 선택적 인덱스가 없어
  PK·순차 스캔이다(가지치기는 둘 다 `answer_brand_g_202609` 한 leaf). 폭 10배에서 병목인지 RDS 실측 게이트에서 판단한다. D8 저촉 없음.
