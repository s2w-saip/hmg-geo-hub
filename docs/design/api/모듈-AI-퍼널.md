# AI 퍼널 모듈 설계 (funnel: FU-1 ACR, FU-2 GA4 전환)

작성 2026-09-27 · 기준: 설계 공용 계약 v2, 확정 DDL `db/DB-v2.sql`, 현행 코드 통합 프리뷰 7639b9e

## 1. 개요

AI 퍼널은 두 원천을 한 메뉴에서 보여 준다.

| 단위 | 화면 | 원천 | 시간축 |
| --- | --- | --- | --- |
| FU-1 AI 선택률(ACR) | /standard/ai-funnel/acr (website 는 현재 정적 샘플) | Scope ACR 측정: rd.acr_cell · rd.acr_choice | round_date(KST 앵커), 스냅샷 = 최신 노출 회차(A1), 기간 = D1 |
| FU-2 AI 유입·전환 | /standard·/website ai-funnel/conversion, 대시보드 KPI 7번 | GA4 보고서 원본 그레인: rd.ga4_row | GA4 속성 시간대 날짜, 기본 최근 90일 |

두 원천은 서로 조인하지 않는다. 같은 필터 바를 공유하지만 from/to·engine 의 의미가 다르다(6절).

확정 엔드포인트는 둘이다.

| ID | 메서드 | 경로 | 요약 | 위험 |
| --- | --- | --- | --- | --- |
| FU-1 | GET | /v1/funnel/acr | ACR 화면 전 구획 1회 응답 | medium |
| FU-2 | GET | /v1/funnel/conversion | GA4 전환·방문·커버리지 1회 응답 | low |

FU-2 초안의 `/v1/funnel/conversion/coverage` 는 data.coverage 로 흡수해 삭제했다(P4, G-25).

가시성 4분면(/standard/ai-funnel/visibility)은 현행이 정적 fixture 라 이번 모듈에서 엔드포인트를 내지 않는다. 프론트는 A12 '준비 중'을 유지한다.

## 2. 엔드포인트 명세

### 2.1 GET /v1/funnel/acr (FU-1)

**필터(공용 모델)**

| 축 | 처리 |
| --- | --- |
| surface | global 은 실데이터. website·project 는 원천 부재로 source_pending |
| own_brand | 서버 결정. 모수 bgrp = ANY(brand_masks(X or 8)), 당사 판정 비트 = X(HMG 관점 7) |
| brand[] | bgrp = ANY(교차 마스크) |
| country[] | geo_key = ANY(권역은 dim_country 로 펼침). website 가상 코드는 bgrp 조건 |
| lang[] | lang_key = ANY, 모든 지면(현행 표준 지면 적용 중: scope-aggregates.ts:9274-9281) |
| engine[] | 비면 rd.dim_engine.is_default 목록, 있으면 그 목록 |
| from/to | 없으면 스냅샷(게이트 통과 최신 회차 1개), 있으면 round_date 범위의 게이트 통과 회차 전부 |
| funnel[]·brand_presence[]·list_type[]·depth1~3[] | 카탈로그 해석 결과 prompt_key = ANY (현행 acrWhere 가 전부 적용: scope-aggregates.ts:9260-9273) |
| source[] | ignored_filters(인용 전용 축) |

**확장 파라미터**: top_brands(12, 1..50), trend_series(5, 1..10), trend_cycles(null = 전 게이트 회차, 1..104), battle_limit(200, 1..500), territory_limit(12, 1..24), model_limit(12, 1..50).

**응답**

```
data: {
  totals: { prompt_runs:int, prompts:int, iterations:int, engines:[code], catalog_acr_prompts:int },
  brands: [{ brand, is_ours, choice:int, appearance:int, cells:int,
             choice_share:Ratio(choice / totals.iterations), coverage:Ratio(cells / totals.prompt_runs) }],
  trend: { series_brands:[brand], buckets:[{ cyc_key, round_date, gap:bool, den:int, series:[{brand, num:int}] }] },
  battle: [{ prompt_id, prompt_text, cells:[{ engine, winner_brand, winner_is_ours, choice:int }] }],
  model_conversion: [{ brand, model, is_ours, conversion:Ratio(choice / cell_vacr), cells:int, top1:int }],
  territory: [{ country, engine, rows:[{ prompt_id, prompt_text, valid_acr:int, entries:[{brand, choice:int, is_ours}] }] }]
}
meta: { surface, mode:'snapshot'|'cumulative', as_of, cycles:[cycle_id], generation, ignored_filters, dropped_filters, suppressed }
```

KPI 카드 4종(Top1·Top5·답변 수·1순위)은 brands·totals 에서 프론트가 만든다. totals.catalog_acr_prompts 는 현행 countStandardAcrPrompts(standards.ts:375)의 대체로, '카탈로그에 ACR 프롬프트 없음'과 '측정 0'을 구분한다.

**산식 규칙**

- G-11(a): 스냅샷 = 최신 노출 회차의 모든 셀(A1), 기간 = 앵커가 기간 안인 게이트 통과 회차의 모든 셀(D1). 현행(셀당 최신 1건 스냅샷, scope-aggregates.ts:9285-9321)에서 바뀐다.
- 숨김 = 언급 계열: hidden_scope NOT IN (1,3). 현행 ACR 의 지면 'all' 예외(scope-aggregates.ts:9238-9248)가 사라진다.
- 레벨 보존: acr_choice PK 에 level 이 있어 현행 brand 우선 접기(sync.ts:1145-1152)가 사라진다.
- 반복 접기(R13·A15)는 적재 시 셀 단위로 끝나 있다. 조회부는 acr_in 만 건다.
- 비경쟁 이름 제외 = keep, 브랜드 계열 전 구획(현행은 Q2 만).
- 비율 분모: choice_share = Σchoice / Σvalid_acr, coverage = 등장 셀 / 셀, 차종 전환 = Σchoice / 등장 셀 Σvalid_acr(scope-aggregates.ts:9505-9508 과 같음).
- 추이 버킷 = 회차(round_date). 분자·분모에 같은 게이트. 현행 일별(measured_at)에서 바뀌는 것은 A4 1회 고지 대상.

**쿼리 설계(한 트랜잭션 순차 6문장)**

```sql
-- 공통 머리: acr_cells_cte
WITH cells AS MATERIALIZED (
  SELECT c.acr_cell_key, c.round_date, c.cyc_key, c.prompt_key, c.engine_key, c.geo_key, c.valid_acr
  FROM rd.acr_cell c
  WHERE c.surface = :s AND c.bgrp = ANY(:masks) AND c.cyc_key = ANY(:cyc_keys)
    [AND c.round_date BETWEEN :lo AND :hi]      -- 기간 모드: acr_cell_round_cov
    AND c.acr_in AND c.engine_key = ANY(:engine_keys)
    [AND c.geo_key = ANY(:geo_keys)] [AND c.lang_key = ANY(:lang_keys)] [AND c.prompt_key = ANY(:catalog_keys)])
-- 1 totals
SELECT count(*), count(DISTINCT prompt_key), sum(valid_acr), array_agg(DISTINCT engine_key) FROM cells;
-- 2 brands
SELECT ch.brand_key, bool_or((ch.own_bit & :own_bits) <> 0) AS is_ours,
       sum(ch.choice), sum(ch.appearance), count(DISTINCT ch.acr_cell_key)
FROM cells JOIN rd.acr_choice ch ON ch.level = 1 AND ch.acr_cell_key = cells.acr_cell_key
WHERE ch.keep GROUP BY ch.brand_key ORDER BY 3 DESC, 5 DESC LIMIT :top_brands;
-- 3 trend: cells 를 추이용 회차 목록(:trend_cyc_keys)으로 다시 뽑고
--   den = SELECT cyc_key, sum(valid_acr) FROM cells GROUP BY cyc_key
--   num = ... WHERE ch.keep AND ch.brand_key = ANY(:series_brand_keys) GROUP BY cells.cyc_key, ch.brand_key
--   게이트 회차 목록과 LEFT JOIN 해 gap 표시
-- 4 battle: GROUP BY prompt_key, engine_key, brand_key HAVING sum(choice) > 0 후
--   DISTINCT ON (prompt_key, engine_key) ORDER BY choice DESC, brand_key (동점 결정 규칙 고정)
-- 5 model_conversion: level = 2, rd.dim_entity.rep_name 과 parent_brand_key 로 GROUP BY,
--   HAVING sum(choice) > 0, ORDER BY sum(choice)::float8 / NULLIF(sum(cells.valid_acr), 0) DESC LIMIT :model_limit
-- 6 territory: 시트 = (geo_key, engine_key) 셀 수 상위 :territory_limit, 항목 = level 1·keep·choice > 0
```

당사 판정 비트식은 SELECT 투영에만 있고 WHERE 에는 없다. 차종 표시명 묶음 단위는 현행처럼 표시 이름(rep_name)이다.

### 2.2 GET /v1/funnel/conversion (FU-2)

**필터**

| 축 | 처리 |
| --- | --- |
| own_brand | 스코프 게이트만(브랜드 계정은 자기 브랜드 속성만) |
| brand[]·country[] | rd.ga4_dim_property.brand_bit·geo_key 로 속성 해석 |
| engine[] | AI 유입 sessionSource 엔진. rd.dim_engine.code → ga4_row.engine_key. 빈 값 = 전 AI 엔진 |
| from/to | GA4 보고서 날짜(속성 시간대). 없으면 to = 최신 적재일, from = to - 89 |
| lang·funnel·brand_presence·list_type·depth1~3·source | ignored_filters |
| surface | 값 무관(속성은 브랜드×국가 단위). meta.surface 에만 반영 |

**확장 파라미터**: device[](mobile·desktop·tablet), visitor_type[](new·returning), page_limit(15, 1..50).

**응답**

```
data: {
  summary: { ai: {sessions:int, conversions:int, page_views:int, conv:Ratio},
             human: {sessions:int, conversions:int, conv:Ratio} },
  trend: [{ date, ai_sessions, ai_conversions, human_sessions, human_conversions }],
  by_engine: [{ engine, sessions, conversions, conv:Ratio }],
  pages: [{ url, ai_sessions, ai_conversions, human_sessions, human_conversions }],
  by_country: [{ brand, country, ai:{sessions, conversions}, human:{sessions, conversions} }] | null,
  coverage: { measured_markets:int, total_markets:int, markets:[{brand, country, status, as_of}] }
}
meta: { surface, mode:'cumulative', as_of, cycles:[], generation:null, ignored_filters, dropped_filters, suppressed }
```

사용자 수는 주지 않는다(G-12 a). lift 는 프론트가 두 Ratio 로 계산한다. by_country 는 매칭 active 속성이 2개 이상일 때만.

**산식 규칙(GA4 행 역할 규칙)**

- AI 세션 = report 2(traffic_ai) sessions 합, engine 필터 적용 가능.
- 비AI 세션 = report 1(traffic_total) 의 NOT is_ai 행 sessions 합. 현행 human = total - AI 와 같은 뜻.
- 전환 = report 3(events) 의 is_conv 행, 속성 conv_basis(제안 열)가 1 이면 key_events, 2 면 event_count 합. 현행 resolveConvSpec(conversion.ts:258-266)과 fetchCohortMap(:285-322)의 속성별 분기를 적재 판정으로 옮긴 것.
- 페이지 = report 4(landing), GROUP BY page_key 하나에 FILTER 집계.
- 분모 변경 activeUsers → sessions 는 결정된 정의 변경(A13 대조에서 설명).

**쿼리 설계(한 트랜잭션 순차 4~5문장)**

```sql
-- 0 속성: SELECT prop_key, brand_bit, geo_key, status FROM rd.ga4_dim_property
--         WHERE brand_bit = ANY(:bits) AND geo_key = ANY(:geos)   (active 만 :props)
-- 1 AI 세션
SELECT date, prop_key, engine_key, sum(sessions), sum(page_views)
FROM rd.ga4_row WHERE prop_key = ANY(:props) AND report = 2 AND date BETWEEN :from AND :to
  AND engine_key = ANY(:engine_keys) [AND device_key = ANY(:dev)] [AND nvr_key = ANY(:nvr)]
GROUP BY GROUPING SETS ((date), (prop_key), (engine_key), ());
-- 2 비AI 세션: report = 1 AND NOT is_ai, GROUPING SETS ((date), (prop_key), ())
-- 3 전환: report = 3 AND is_conv, rd.ga4_dim_property 조인(conv_basis),
--   AND (NOT is_ai OR engine_key = ANY(:engine_keys)),
--   GROUPING SETS ((is_ai, date), (is_ai, prop_key), (is_ai, engine_key), (is_ai))
-- 4 페이지: report = 4, GROUP BY page_key, sum(sessions) FILTER (WHERE is_ai) ...,
--   ORDER BY ai_sessions DESC LIMIT :page_limit, 라벨은 rd.ga4_dim_value(kind='page')
-- 5 as_of: SELECT prop_key, max(date) FROM rd.ga4_row WHERE prop_key = ANY(:props) AND report = 1
--   AND date >= :to - 7 GROUP BY prop_key
```

## 3. 공통 구성요소

- 라우터 `app/modules/funnel/router.py` (prefix /v1/funnel), 핸들러 acr.py·conversion.py, 모델 schemas.py, 리포지토리 repo_acr.py·repo_ga4.py.
- 공유 모델: Ratio {num, den}, FunnelResponse[T], Meta(계약 공통 형태), A12 표현 meta.suppressed = [{scope:'all', reason:'source_pending'}].
- 공통 모듈에서 받는 것: CommonFilters, AuthScope, 회차 게이트(series='mentions'), 카탈로그 축 해석, brand_masks.
- read_tx: 한 커넥션 READ ONLY REPEATABLE READ 순차 실행(PgBouncer transaction 모드 호환, prepared statement 캐시 끔).
- acr_cells_cte, ACR 레벨 조인 규약(level 가지치기, keep, 당사 투영).
- resolve_ga4_props, GA4 행 역할 규칙, conversion_summary()(대시보드 재사용)와 conversion_detail().

## 4. 읽기 스키마

**확정 DDL 에 있는 것**

- ACR: rd.acr_cell(커버링 인덱스 2개), rd.acr_choice(level 파티션, PK INCLUDE, BRIN), rd.dim_brand_name, rd.dim_entity, rd.dim_prompt, rd.catalog_entry, rd.dim_engine·dim_country·dim_lang·dim_project, rd.cycle(cycle_pick_idx), rd.surface_generation.
- GA4: rd.ga4_row(RANGE date, PK 선두 prop_key), rd.ga4_dim_property, rd.ga4_dim_value, rd.dim_engine, rd.dim_country.
- 읽지 않음: app.ga4_property·app.ga4_tracked_event(admin 전용), rd.acr_cell_job(QA 전용), ing 전부.

**제안(확정 DDL 에 없음)**

| 제안 | 근거 | D8 판정 |
| --- | --- | --- |
| rd.ga4_dim_property.conv_basis int2 | 속성별 분자 정의(key events 대 추적 이벤트 eventCount)를 is_conv 만으로 복원 불가 | 적재 판정 열, 허용 |
| GA4 시장 카탈로그(app.ga4_market 또는 설정 상수) | 현행은 속성 없는 시장도 커버리지 분모에 든다(property-map.ts:107-142). DB-v2 는 property_id NOT NULL 뿐 | 참조 데이터, 허용 |
| app.judgment_change.kind 에 ga4_property·ga4_tracked_event | 최근 3일 교체 적재로는 과거 is_conv 가 안 바뀜 | 무관 |
| rd.dim_engine 에 GA4 엔진 코드 행 | engine[] 공용 축 재사용 | DDL 변경 없음 |

기각: FU-2 의 rd.ga4_row PK 순서 변경(전제 오류), app.ga4_property 역방향 인덱스(API 가 안 읽음).

## 5. 권한

- 역할 hq·region·country·admin·vendor·website(§9)의 허용 브랜드·권역·국가를 서버가 계산해 요청 필터와 교집합한다(default-deny). 권한 밖 값은 meta.dropped_filters.
- own_brand 는 클라이언트가 바꿀 수 없다. 현행 브랜드 계정 잠금(scope.brands ∪ HMG 엄브렐러, standard-filters.ts:56-63)은 brand_masks(X | 8) 로 같은 모수를 만든다.
- GA4: 스코프 밖 브랜드·국가 속성은 coverage 에도 나오지 않는다. active 가 아닌 속성은 실데이터 없이 coverage 에만.
- 두 엔드포인트 모두 읽기 전용(api_ro). 운영자 게이트 해당 없음. 전환 이벤트 쓰기는 admin 모듈(api_rw)이 소유.

## 6. 두 원천의 필터 의미 차이(프론트 문서에 명시)

| 축 | ACR | GA4 |
| --- | --- | --- |
| from/to | KST 앵커 날짜(round_date), 없으면 스냅샷 | 속성 시간대 보고서 날짜, 없으면 최근 90일 |
| engine | 측정 엔진, 비면 기본 엔진 | AI 유입 sessionSource 엔진, 비면 전 AI 엔진 |
| country | 측정 지역(geo_key) | 속성의 국가 |
| 카탈로그 축 | 지원 | ignored |

## 7. 성능

| 경로 | 10배 읽는 규모 | 가지치기·인덱스 | 위험 |
| --- | --- | --- | --- |
| ACR 스냅샷 | 셀 수만 + 브랜드 행 수십만 | acr_cell_cyc_cov 인덱스 전용, acr_choice PK INCLUDE | low |
| ACR 1년 기간 | acr_choice_brand 약 590만 행 중 기간 셀 | acr_cell_round_cov, PK 조인, BRIN(acr_cell_key) | medium |
| ACR 추이(전 이력) | 게이트 회차 전부의 브랜드 행 | brand_key 인덱스 없음, 셀 단위 전수 | medium~high |
| GA4 90일 | 속성 수 × 90일 × 차원 조합, 수천~수십만 | 날짜 leaf 가지치기 + PK (prop_key, report, date) | low |

- acr_cell 은 파티션이 없고 acr_choice 만 level 파티션이다.
- 한 요청 6문장(ACR)·5문장(GA4)은 같은 트랜잭션 순차 실행. 셀 선택은 각 문장에서 인덱스 전용 재평가(작음).
- 결과 캐시·요약 표·매트뷰 없음(D8). 1초 초과 경로는 RDS 실측 게이트에서 판정하고, 추이는 trend_cycles 상한으로 먼저 대응한다.

## 8. 대조 방법(신구 병행, A13)

- 하네스에 F08(ACR: aggregateAcrFromMirror, scope-aggregates.ts:9327)·F09(GA4: getAiConversionLive·getAiTrafficConversionRollup·getAiVisitsLive)를 추가한다. 현행 하네스는 F01~F07 뿐이다.
- ACR: 정수(prompt_runs, iterations, 브랜드별 choice·appearance·cells)를 비교. 차이는 다음 결정 변경으로만 설명돼야 한다: A1 스냅샷(셀당 최신 1건 → 회차 전 셀), 기간 게이트, mentions 숨김, 레벨 보존, keep 전 구획, 엔진 기본값, 추이 회차 버킷.
- GA4: 같은 고정 날짜 창에서 현행 GA4 API 를 sessions·전환 정수로 직접 조회해 비교(현행 비율은 activeUsers 분모라 비교 불가, 정의 변경으로 설명). 일 단위 합산과 창 합계의 임계값 차이는 totals 보고서(report 5)로 미귀속 폭을 드러낸다. 최근 3일은 비교에서 뺀다.
- GA4 속성 해석의 예상 차이(mig.known_diff 등록 대상, 2026-09-28 bg-funnel 검증 수정):
  - DC-1(보안 축소, 검증 D1): 프로젝트 직접 지정 속성(app.project.ga4_property_id)이 다른 시장에 귀속된 레지스트리·적재 속성이면 project 표면은
    읽지 않고 unmapped 로 내며, 전환 이벤트 비관리자 경로도 404 다. 현행은 Owner 가 설정만으로 그 시장 수치를 읽고 추적 이벤트를 바꿀 수 있었다.
  - DC-2(검증 D2): 직접 지정 속성이 active 로 적재되기 전이면 레지스트리 상태와 무관하게 pending_grant(현행 page.tsx:89-100 대기 안내와 같음).
  - DC-3(검증 D3): 프로젝트 대시보드 ⑦(live.ts:219-231)은 시장 속성만 쓴다. API 는 surface=project 에 property_source=market 을 주면 같고,
    생략하면 전환 화면처럼 직접 지정 우선이다. 어댑터가 ⑦ 에 market 을 넘기지 않으면 직접 지정 프로젝트에서 ⑦ 값이 달라진다.
  - DC-4(의도된 축소, 검증 D4): 레지스트리 상태 unmapped 인 시장(속성 id 있음)은 coverage.property_id 가 null 이고 비관리자 이벤트 경로 404 다.
    현행 resolveProperties(property-map.ts:59-79·107-121)는 상태를 보지 않아 website 다이얼로그가 열린다.
  - DC-5(설계 합의, 2차 검증 D4): days(7·28·90) 창 = [최신 적재일 - (N-1), 최신 적재일], N 일. 현행은 GA4 '{N}daysAgo'..'today'
    (front/lib/ga4/client.ts:70-73)라 N+1 달력일이고 오늘(부분일)을 포함한다. 끝점 = 최신 적재일은 적재 원천(rd.ga4_row) 설계상 고정이고,
    길이도 요청 N 과 같게 둔다(창 수치 비교는 같은 고정 날짜 창으로 한다).
- ACR 옵션(BG-33, 2차 검증 D2·D5 수정으로 현행과 같음): options.langs 는 현행 listMeasuredAcrLanguages 처럼 스코프 브랜드·국가·기간만 건다
  (엔진 축·기본 엔진 한정·택소노미·커스텀 축 없음). 그래서 기본 엔진 데이터(DC-01 계열 엔진 기본값)에는 없는 언어(비기본 엔진에서만 측정)도
  옵션에 나온다(현행과 같은 성질). options.countries 는 숨김 국가(global = hidden_standard, website = 숨김 시장)를 뺀다
  (현행 listMeasuredRegions(..., true)·/v1/filters/options regions 와 같다).

## 9. 열린 질문

1. ACR 추이 스냅샷 모드 기본 창: 현행처럼 전 이력(권장 아님, 10배 위험) 대 최근 12회차 상한(권장). 제품 결정 필요.
2. 비기본 엔진 ACR 셀 존재 여부: 있으면 엔진 기본값 적용으로 현행 대비 값이 줄어든다. RDS 실측으로 확인.
3. acr_cell.acr_in 과 A16(언급 분석 결손)의 관계: 적재 모듈 확인.
4. acr_cell.co_*(선택 결과 유형 분포) 노출 여부: 현행 대응 화면 없음. 이번 이관에서는 응답에 넣지 않는다(권장).
5. GA4 보고서 차원 구성: events(report 3)·landing(report 4)에 source·device·nvr·event 차원이 있는지, 세션 행과 이벤트 행이 event_key 로 구분되는지. 없으면 해당 필터는 페이지·전환 구획에서 ignored 로 표시.
6. conv_basis 열(제안 1), 시장 카탈로그(제안 2), GA4 재투영 kind(제안 3) 채택 여부: 통합자·적재 설계자.
7. coverage 에서 pending_grant 와 unmapped 를 구분해 보여 줄지: API 는 status 를 그대로 주고 현행 UI(conversion/page.tsx:53-61 '미연동' 단일 문구) 유지 여부는 프론트 결정.
8. project 표면 ACR 탭 신설 여부: 프로젝트 모듈과 경계 합의(이번 이관은 source_pending).
9. extra_params 상한값의 정본: 이 문서를 정본으로 하고 계약서에는 링크만(권장).
