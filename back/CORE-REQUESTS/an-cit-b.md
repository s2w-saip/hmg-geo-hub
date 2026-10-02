# core 요청: an-cit-b (C-3 analytics.citations.prompts · C-4 analytics.citations.targets)

기준: stg 0092400. 2차(검증 D1~D6 반영): R3 격상, R4 갱신, R6~R8 추가. 기능 안에서 술어를 재구현하지 않고, 막힌 부분은 meta(ignored_filters·suppressed)로 드러낸 채 두었다.

## R1. 출처 카테고리(source[]) 공통 술어 (막힘: C-3 source[] 지원)

- 무엇: `ReadContext.source_category_keys` 는 풀리지만 `MeasureScope` 에 출처 축이 없고, `citation_where`·`citation_counts_sql`
  어디에도 출처 카테고리 술어가 없다. 기능마다 `rd.dim_source` 세미조인을 따로 쓰면 C-1·C-2·C-3 이 갈린다.
- 왜: C-3 명세(filters.supported)가 source[] 신규 지원을 요구한다(현행은 JS 파생 분류라 억제). 적재 시점
  `rd.dim_source.category_key` 로 SQL 필터가 가능해졌다.
- 제안 시그니처:
  - `MeasureScope.source_category_keys: tuple[int, ...] | None = None`, `ReadContext.measure()` 가 채운다.
  - `citation_where(ms, win, c, b)` 가 값이 있으면
    `c.source_key = ANY(ARRAY(SELECT ds.source_key FROM rd.dim_source ds WHERE ds.category_key = ANY(:keys)))`
    (또는 EXISTS 세미조인)를 붙인다.
  - `plan_counts(parts=("citations",))` 는 출처 축이 있으면 답변 열(cit_*) 경로를 쓸 수 없으므로(답변 열은 출처 무관 합)
    `citation_counts_sql(ms, win, group_by=…)` 원소 스캔으로 내려가거나 ValueError 로 호출자에게 알린다.
- 기능 쪽 전환 계획: C-3 은 source[] 가 있을 때 `citation_counts_sql(ms, win, group_by=("prompt", "engine"))`
  (cit_total·cit_owned 가 같은 열 이름) 결과를 같은 버킷 CTE 에 넣고, `SUPPORT` 에 "source" 를 추가한다.
- 현재 상태: C-3 SUPPORT 에서 source 를 빼 `meta.ignored_filters` 에 드러낸다(조용히 무시하지 않음).

## R2. 프로젝트 표면 M06·M07 분모 (막힘: C-4 surface=project)

- 무엇: `plan_counts` 의 `urls` part 가 표면과 무관하게 `a.web_reg` 를 분모 게이트로 건다
  (`count(*) FILTER (WHERE web_reg)`). `web_reg` 는 웹사이트 카탈로그 등록 전용이라 프로젝트 답변은 항상 거짓이고,
  `url_rates` 는 프로젝트에서 분모 0(측정 대기)을 낸다. 픽스처 k31 은 `tgt_cited`·`own_url_cited` 가 참인데도 0/0 이 된다.
- 왜: DECISIONS-API Q5 가 "project 표면 M06·M07 채운다(적재 시 app.project_tracked_url·app.project_owned_base 판정)"로
  결정했다. 분모 정의(프로젝트 측정 전체 = cit_in 답변)는 core 의 지표 정의라 기능이 정할 수 없다.
- 제안 시그니처(둘 중 하나):
  - `plan_counts` 의 urls 분모 게이트를 `web_reg` 가 아니라 표면별로: sf=2 → `web_reg`, sf=3 → 게이트 없음(cit_in 답변 전체).
  - 또는 `url_rates(…)` 가 sf=3 을 명시 지원(R09 는 sf=2 전용 유지)하고 docstring 의 "웹사이트 전용"을 개정.
- 현재 상태: C-4 는 surface=project 에서 인증·멤버십·스코프 검사까지 수행한 뒤 `meta.suppressed = {target_url_rate: core_pending,
  owned_url_rate: core_pending}` 로 값 없이 응답한다. core 반영 후 `service.compute_targets` 의 project 분기만 지우면 된다.

## R3. R09 발행값 헤드라인 풀 규칙 (막힘: C-4 발행값 값 편차, 검증 D2로 "확인 요청"에서 격상)

- 무엇: `report_values_sql` 이 `rd.report_unit_value.in_headline_pool` 을 보지 않고 선택된 유닛을 전부 합친다. `app.report_publication`
  조인에 `p.surface = 'website'` 도 없다.
- 편차(검증 D2 재현, 2026-09-25 rep-0925 에 유닛 101 풀 11/20·13/20 + 유닛 103 비풀 1/7·2/7, KIA_EU 스냅샷):
  core = measured 27, target 12/27, owned 15/27. C-4 명세 query_design(`AND v.in_headline_pool`)과 현행 `publishedSubtotal`
  (front/lib/reports/truth-axes.ts:344-345, 풀 유닛이 하나라도 있으면 풀 유닛만)은 20, 11/20, 13/20. **현행과 동치가 아니다**
  (1차 제출의 "현행 동치인지 확인" 표현은 틀렸다). 실데이터도 무필터 표지가 비풀 유닛 1개를 빼는 구조(104/105)라 기본 화면에서 갈린다.
- 제안: 현행 규칙 그대로 "선택에 풀 유닛이 있으면 풀 유닛만, 없으면 전부"를 `report_values_sql` 에 넣는다
  (예: `SUM(..) FILTER (WHERE v.in_headline_pool OR NOT bool_or(v.in_headline_pool) OVER (PARTITION BY v.round_date))` 를 하위 질의로,
  또는 round_date 별 `bool_or` CTE). `JOIN app.report_publication p ON … AND p.surface = 'website'` 도 추가. K-1·T-1 도 같은 함수라 함께 맞는다.
- 기능 쪽 방어(C-4, 반영 완료): `targets/queries.py report_provenance_sql` 이 core 와 같은 선택의 전체 합·풀 합을 따로 낸다.
  core 값이 전체 합과 같고 선택에 풀·비풀이 섞였으면 틀린 발행값 대신 core 라이브 경로(`fetch_counts parts=urls`)로 내리고
  `meta.source = {origin: live, reason: headline_pool_pending}`. core 가 풀 규칙을 적용하면 core 값이 풀 합과 같아져 **기능 수정 없이**
  발행값으로 돌아간다(테스트 `test_d2_mixed_headline_pool_never_serves_unpooled_sum` 은 두 상태를 모두 허용한다). 웹사이트 밖 발행물 행이
  섞이면 `publication_surface_pending` 으로 같은 방어.

## R4. 발행값 출처(provenance) 반환 (검증 D1 관련, 임시 거울 운영 중)

- 무엇: `url_rates` 결과에 origin 만 있다. 1차 제출은 `app.report_publication` 에서 그 회차의 활성 웹사이트 발행물 slug 를 **전부** 읽어
  brand_scope 와 무관하게 관점 밖 발행물 식별자를 드러냈다(검증 D1, critical).
- 현재 기능 쪽 조치: `report_provenance_sql` 이 core `report_values_sql` 과 같은 술어(round_date·brand·웹 유닛 프로젝트·geo_keys·
  countries·langs·status active)로 **합산에 실제로 들어간** 발행물만 센다. 술어 드리프트는 합계 대조로 막는다(core 값 ≠ 출처 합이면
  발행값을 쓰지 않고 `reason: provenance_mismatch`). 즉 core 술어를 기능이 거울로 들고 있는 상태라 core 를 고칠 때 같이 고쳐야 한다.
- 제안: `url_rates`(또는 `fold_url_rates`)가 합산에 쓴 `pub_id`·slug 목록과 R09 를 쓰지 않은 사유(R7)를 함께 돌려준다.
  반영되면 `report_provenance_sql`·`provenance_verdict` 를 지운다. T-1·K-1 도 같은 출처 표시가 필요하면 한 곳에서 관리된다.

## R5. 쿼리 모델 + 추가 쿼리 인자 조합 (정보)

- FastAPI 0.141 에서 `Annotated[CommonFilters, Query()]` 와 다른 `Query()` 인자를 함께 선언하면 모델이 `filters` 라는 단일
  필드로 취급돼 422(`loc: [query, filters]`)가 난다. C-3 은 `PromptsQuery(CommonFilters)` 로 추가 인자(owned·q·limit·cursor)를
  한 모델에 합쳤다. 목록 기능이 여럿이므로 core 에 `PageQuery` 믹스인(cursor·limit)이나 가이드 한 줄이 있으면 좋다.

## R6. 하루짜리 기간(from = to)의 R09 라우팅 (결정 필요, 검증 D3)

- 무엇: `fold_url_rates` 는 발행값을 `win.mode == 'snapshot'` 일 때만 쓴다. 현행 `resolveReportTruthRoute`(truth-axes.ts:95-103)는
  `dateFrom === dateTo` 이면 그 날을 발행 회차로 읽어 발행값을 낸다. 명세 문구("조회 회차" vs "켜진 필터가 발행 축뿐")는 어느 쪽으로도 읽힌다.
- 재현: 2026-09-25 에 활성 발행값이 있을 때 `from=2026-09-25&to=2026-09-25` → mode cumulative, origin live(C-4·K-1 공통).
- 제안(권장 a): 누적 창이 회차 하나(`win.lo == win.hi` 이고 그 날짜가 `round_dates` 에 있음)이면 R09 판정에서 스냅샷과 같이 취급해 현행과 맞춘다.
  (b) 의도된 정의 변경이면 A4 공지 목록에 올린다.
- 기능 쪽: K-1 과 같은 함수를 써야 하므로 C-4 가 창을 바꿔 넘기지 않는다. 현재는 `meta.source = {origin: live, reason: period_range}` 로
  드러내고 targets README 편차 목록에 적었다(`test_d3_single_day_period_is_live_with_reason` 이 현재 동작을 고정, a 반영 시 기대값 갱신).

## R7. R09 미사용 사유(reason) 반환 (선택, 검증 D5)

- 모듈-인용 §2 C-4 provenance 는 `{source, publication_slug, reason}` 이다. 지금은 C-4 `live_reason` 이 core R09 판정 순서
  (엔진 축 → 스냅샷 여부 → 발행 유닛 유무)를 거울로 들고 `engine_axis`·`period_range`·`no_publication` 을 낸다.
  `url_rates` 가 사유를 돌려주면 판정이 한 곳에만 있게 된다(R4 와 한 번에).

## R8. fetch_keyset 의 SQLSTATE 22 → cursor_invalid 일괄 매핑 (정보, 검증 D4)

- `pagination.fetch_keyset` 은 커서가 없는 요청에서도 모든 22 계열(데이터 예외)을 `cursor_invalid` 로 바꾼다. C-3 은 검색어 `q` 의
  제어 문자(`\x00` 등)가 DB 에서 22021 을 내며 커서 오류로 잘못 보고됐다. 기능 쪽은 `q` 를 DB 전에 422 `unprocessable`
  `details.field='q'` 로 막았다. core 는 커서가 없을 때(또는 커서 바인드가 아닌 오류일 때) 매핑하지 않는 편이 오진을 줄인다.

## 참고: C-3 인덱스

- C-3 은 rd.citation 을 스캔하지 않고 rd.answer 답변당 인용 수 열(G-25)로 프롬프트 버킷을 낸다. 표본 문장은
  `answer_prompt_idx (prompt_key, round_date)` 와 `job_pkey` 를 쓴다(로컬 EXPLAIN, enable_seqscan off 확인).
  모듈 설계의 제안 인덱스 P-1 `rd.citation (surface, round_date, prompt_key)` 는 C-3 에 필요 없다.
