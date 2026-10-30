# KPI 모듈 설계 (kpi)

작성 2026-09-27 · 모듈 설계 리드 · 입력: 단위 설계 K-1·K-2·K-3, 설계 공용 계약 v2, 확정 DDL `db/DB-v2.sql`, 결정 `db/DECISIONS.md`, 현행 코드 7639b9e(읽기 전용 확인).

## 1. 개요

KPI 모듈은 대시보드 핵심 지표를 낸다. 엔드포인트는 넷이다(K-1b 는 2026-09-28 값 갭 보강 BG-04 로 추가).

| ID | 경로 | 내용 | 위험 |
| --- | --- | --- | --- |
| K-1 | GET /v1/kpi/summary | M01~M05 카드, 웹사이트 M06·M07·인용 정확도, M12 모수, A16 분석 결손 | medium |
| K-1b | GET /v1/kpi/unmeasured-prompts | M12 미측정 프롬프트 목록(적용 − 측정, 카드와 같은 술어, 상한 200) | low |
| K-2 | GET /v1/kpi/compare | 기간 비교 Δ(window·calendarMonth·calendarWeek·cycle), 억제 사유 3종(2026-10-31 6종 → 3종) | high |
| K-3 | GET /v1/kpi/engines | 엔진별 서브 지표 행과 total, 엔진 간 일관성 | medium |

설계의 중심은 **스캔 빌더 두 개**다. 세 엔드포인트가 같은 계산을 각자 SQL 로 쓰지 않는다.

- `answer_counts`: rd.answer 한 번 스캔. M01~M04, M06·M07, M12 측정 프롬프트 수, A16 을 한 문장으로 낸다.
- `citation_counts`: rd.citation 한 번 스캔. M05 를 낸다.

두 빌더는 `group_by` 만 다르다. K-1 은 그룹 없음, K-3 는 engine_key, K-2 는 창 라벨이다. trend 모듈도 같은 빌더(group_by = 회차·주·월)를 써야 D6(카드 = 추이 버킷 합)이 구조적으로 보장된다.

D8 을 지킨다. 사전 집계·캐시·새 카운터가 없다. 당사 수치는 D8 예외 ②(rd.answer 당사 열, G-03)로 자식 스캔 없이 읽는다.

## 2. 엔드포인트 명세

### 공통 입력

- 공통 필터 모델(계약 §2): own_brand(서버 결정), brand[], country[], lang[], engine[], from/to, funnel[], brand_presence[], list_type[], depth1~3[], depth4[](BG-03), source[].
- KpiSurfaceParams:
  - `surface`: global|website|project, 필수.
  - `project_id`: project 표면에서 필수. 비멤버면 403.
  - `cycle_offset`: 0|1, 기본 0. 스냅샷 모드에서만 쓴다. 1 이면 직전 노출 회차다.

필터 축 지원 표(세 엔드포인트 공통, D6 때문에 카드·Δ·엔진이 같은 축을 받는다):

| 축 | 방식 | 표면 |
| --- | --- | --- |
| own_brand | 모수 `bgrp = ANY(:pop_bgrps)`, 측정 열은 own_cols | 전부 |
| brand[] | pop_bgrps 교차 마스크 | global·website |
| country[]·권역 | `geo_key = ANY` (가상 코드 HYUNDAI-N 은 bgrp 로 변환) | 전부 |
| lang[] | `lang_key = ANY` (현행 langAxisPred scope-aggregates.ts:949 가 세 표면 모두 라우팅). 글로벌 M05 는 언어로 좁힌 허용 배열이면 rd.citation 원소 스캔(BG-01, core KPI_SUPPORT) | 전부 |
| engine[] | 비면 `dflt`, 있으면 `engine_key = ANY` | 전부 |
| from/to | `round_date BETWEEN` (G-04) | 전부 |
| funnel·brand_presence·list_type·depth1~3 | rd.catalog_entry 에서 prompt_key 집합을 풀어 `prompt_key = ANY` (1,000 초과면 semi-join, G-06) | global 만, 나머지는 ignored_filters |
| depth4[] (BG-03) | global = 관점 카탈로그 행(brand_bit ∈ 관점 ∪ 엄브렐러)의 app.prompt.depth4 정확 일치 → prompt_key 집합(다른 택소노미 축과 같은 행 조건, 관점 행에 없는 값 dropped), project = 프로젝트 app.prompt.depth4 | global·project, website 는 ignored_filters. 선언하지 않은 다른 모듈 엔드포인트도 ignored_filters |
| source[] | 해당 없음 | ignored_filters |

### K-1 GET /v1/kpi/summary

스냅샷(from/to 없음)이면 A1 을 따른다. 프로젝트별 최신 노출 회차의 모든 완료 측정을 모수로 쓴다. 기간 누적이면 D1 을 따른다. round_date 가 [from, to] 안인 모든 완료 측정이다.

```
data:
  visibility        Ratio   M01  tracked / answers                      (std_in, 언급 계열 회차)
  share_of_voice    Ratio   M02  Σ own ment / Σ ment_total
  sentiment         Ratio   M03  Σ own sent_pos / Σ own sent_all        (A3: mixed 분모 포함)
  position          RankAvg M04  rank_sum / ranked                      (D5, HMG 는 3사 순위 중 0 을 뺀 최솟값)
  citation_share    Ratio   M05  cit_owned / cit_total                  (cit_in, 인용 계열 회차)
  target_url_rate   Ratio?  M06  tgt_cited / (cit_in ∧ web_reg)         (website 전용, R09)
  owned_url_rate    Ratio?  M07  own_url_cited / (cit_in ∧ web_reg)     (website 전용, R09)
  citation_accuracy Ratio?       tgt_cited / own_url_cited              (website 전용, §6 등재 대기)
  params  { answers, measured_prompts, applied_prompts, prompts_without_brand|null,
            measured_by_funnel?[{ funnel|null, measured_prompts }] }   M12 (BG-06·BG-08)
  analysis_gap { gap_answers, base_answers, rate }                      A16 (cit_in ∧ gap / cit_in)
meta: 계약 §8 + source{ url_rates: report|live, reason, publications[slug],
                        round_date?, site_count?, publication_details?[{slug, cycle_label, cycle_label_en, round_date}] }   (발행값일 때만 ? 키, BG-26)
```

- prompts_without_brand(BG-06): 세 표면 모두 measured_prompts − 관점 브랜드 언급 프롬프트 수. 숨김 창 hidden, 빈 창 또는 측정 프롬프트 0 이면 null·`no_data`(현행 promptsWithoutBrand = prompts > 0 ? missing : null).
- measured_by_funnel(BG-08): `by_funnel=true` 일 때만. 측정 프롬프트를 rd.dim_prompt.funnel_key(scope_prompt_id 가 같은 app.prompt 어느 행이든)로 나눈 수, 합 = measured_prompts.
- meta.source BG-26 키: 발행값(report)이면 발행 회차 round_date, 헤드라인 풀 규칙 뒤 합산 유닛 수 site_count(현행 publishedSubtotal.siteCount), 발행물 회차 라벨 publication_details. 라이브면 키가 없다(기존 publications slug 목록은 그대로).

- website 전용 지표를 다른 표면에서 요청하면 `null` 을 낸다. meta.suppressed 는 `not_website_surface` 다.
- 분모가 0 이면 rate 는 null 이고 사유는 `no_data` 다. 숨김 회차만 남으면 사유는 `hidden` 이다.

### K-1b GET /v1/kpi/unmeasured-prompts

측정 개요 카드 "미측정" 모달(현행 listUnmeasuredPromptsFromCatalog)을 채운다. 파라미터 = K-1 과 같은 공통 필터·surface·project_id·cycle_offset + `limit`(1~200, 기본 200).

```
data: { items: [ { prompt_id, scope_prompt_id, text, list_type, depth1, depth2, funnel_stage } ] }
meta: 계약 §8 + page{ limit, total }       total = 절단 전 |적용 \ 측정|
```

- 적용 집합 = core `applied_prompt_keys_sql`(K-1 applied_prompts 와 같은 술어), 측정 집합 = core `measured_prompt_where`(K-1 measured_prompts 와 같은 술어). 한 프롬프트 키 한 행, 정렬 = list_type·depth1(NULL 뒤)·text·키.
- 권한 게이트: 본문을 내므로 global 적용 키는 살아 있는(soft-delete 제외) 루트 카탈로그 행 중 계정 대상 시장 3분기(core.filters.catalog_market_scope, 모듈-프롬프트 P-1 과 같은 술어)를 통과하는 행이 있는 키로 한정하고 대표 행도 그 행에서 고른다(bg-kpi-filters 검증 D1). K-1 applied_prompts 에는 시장 게이트가 없어(현행과 같음) 시장 밖 적용 행이 있는 계정은 total < applied − measured 다. K-1 에도 걸지는 결정 대기(§8 Q10).
- 행 게이트는 한 행 단위다(bg-kpi-filters 2차 검증 D1·D3): 브랜드 스코프(catalog_brand_scope) ∧ 대상 시장 3분기 ∧ 적용된 택소노미 축(rd.catalog_entry 키, rd.dim_taxon 사전) ∧ depth4 를 **같은 카탈로그 행**이 통과해야 그 키가 목록에 들어가고, 대표 행도 그 행 중 가장 작은 prompt_id 다. 그래서 목록 ⊆ 같은 계정·같은 필터의 GET /v1/prompts 이고, 필터를 걸면 대표 행이 필터에 맞지 않는 형제 행이 되지 않는다.
- known_diff(한 키 한 행): 현행 listUnmeasuredPromptsFromCatalog(scope-aggregates.ts:6178)는 카탈로그 **행** 단위라 같은 prompt_key 에 브랜드 행이 둘이면(예: 'best suv' 현대·Genesis) 두 행을 내고 total 도 행 수다. K-1b 는 K-1 applied·measured 의 서로 다른 키 단위를 따라 한 키 한 행으로 접고 total = 서로 다른 키 수다(total = applied − measured 를 지키기 위한 의도적 차이, mig.known_diff 등록 요청 CORE-REQUESTS/bg-kpi-filters.md R4).
- 답변 축(국가·엔진·언어·기간)은 적용 집합을 좁히지 않는다(현행과 같다). 스냅샷 노출 회차 없음 = `suppressed['*'] = no_active_snapshot` 빈 목록, 창의 언급 계열 전부 숨김 = `suppressed.items = hidden` 빈 목록.

### K-2 GET /v1/kpi/compare

추가 파라미터:

- `kind`: window|calendarMonth|calendarWeek|cycle, 기본 window.
- `days`: 7|14|30|365. window 에서 from/to 가 없을 때 쓴다. from/to 가 있으면 from/to 가 이긴다.
- `metrics[]`: 기본 M01~M05. 요청하면 `mentions_per_answer`(관점 언급 합 ÷ std_in 답변)·`citations_per_answer`(인용 합 ÷ cit_in 답변)도 낸다(BG-05, 단위 `pct` = round1((cur − prev) ÷ prev × 100), prev 0 이면 delta null, 현행 deltaOf). 상한 7.

창 수식은 현행을 그대로 이식한다. cur = [E−(N−1), E], prev = [E−(2N−1), E−N] 이고(period-compare.ts 머리 주석), E 는 to 또는 최신 노출 round_date 다. `cycle` 은 새로 추가한 종류다. cur = 최신 노출 회차, prev = 직전 노출 회차이고 프로젝트별로 잡는다.

```
data: [ { metric, family: mention|citation, unit: pp|rank,
          prev: Ratio|RankAvg, cur: Ratio|RankAvg, delta: number|null,
          suppressed: bool, reason: SuppressReason|null,
          cycles_prev, cycles_cur, planned_prev, planned_cur,
          missing_share_prev, missing_share_cur } ]
meta: mode = cumulative, compare = { kind, windows: { prev, cur, before? } }
```

- delta 규칙:
  - pp = round1((cur.rate − prev.rate)).
  - rank = round1(cur.avg − prev.avg).
  - 부호는 원시값이다. 순위의 해석 반전은 화면이 한다. 현행 overview-card-values.ts 머리 주석과 같다.
- 억제 사유는 3종(unsupported, no_prev, no_data)이고 우선순위는 그 순서다. 비교할 값이 없을 때만 억제한다.
- **2026-10-31 HUB 규칙 5로 뺌(⛔K):** missing_share(수집분이 계획의 70% 미만) · start_window(시작 유예 `ceil(N/4)`일) · start_month(직전 달 첫 측정이 7일 뒤)는 더 이상 억제 사유가 아니다. 측정 방식 · 범위가 회차마다 달라 값이 튀어도 숨기거나 경고하지 않는다(admin-todo 규칙 5, 2026-10-29 ACR 숨김 철회와 같은 원칙). 아래 missing_share 계산과 firstPublishedAnchor 는 응답 값(`missing_share_*`, `meta.compare.first_published`)으로만 남는다. 구현은 `back/bff/gold_reader/compare_logic.py` `suppression_of`. 원래 규칙은 suppressionOf(period-compare.ts:490) 이식이었다.
- missing_share 는 **대안 (b)** 로 계산한다. 구간 안 (프로젝트 x 회차) 행 중 미발행 비율이다.
  - plannedKnown = ledger_backed 회차가 있다. 프로젝트 가상 회차만 있는 구간은 현행처럼 판정을 건너뛴다.
  - (2026-10-31까지) 억제 임계는 0.3 이었다. 적용 조건은 appliesMissingShare(:445) 이식이었다(window 30일 이상, 달력 월·주는 항상). 지금은 값만 싣는다.
- firstPublishedAnchor 는 `min(round_date) FROM rd.cycle WHERE surface, project_key = ANY, servable` 1문장이다. 전 이력 기준이다.
- PERIOD_COMPARE_EPOCH(:297) 게이트는 폐기한다. A4 로 전 기간을 새 정의로 재계산하므로 목적이 사라졌다. 2026-10-31 HUB 규칙 5로 BFF에 남아 있던 상수와 `before_epoch` 처리도 지웠다(Gold 리더는 처음부터 이 게이트가 없었다).

### K-3 GET /v1/kpi/engines

추가 파라미터: `part`: all|exposure|sov|favorability|position|citation. SELECT 열만 좁힌다. 현행 SUB_KPI_PARTS(scope-aggregates.ts:3157 표)를 계승한다.

```
data:
  rows:  [ { engine, answers, tracked, multi, top1, top3, rank_sum, ranked,
             total_mentions, tracked_mentions, sent_mentions, positive_mentions, negative_mentions,
             cit_total, cit_owned } ]
  total: 같은 모양(행 합, avg 는 합에서 재계산)
  engine_consistency: { visibility, share_of_voice, sentiment, position, citation_share }
```

- 일관성은 서버가 계산한다. 값은 100 x min / max 를 round1 한 것이다. 유효 엔진(분모 > 0)이 2개 미만이면 null 이다. 산식은 live.ts:831·838 을 이식한다.
- multi 는 당사 언급 2회 이상인 답변이다. top1·top3 는 best_rk 기준이다. 현행 Q1(scope-aggregates.ts:3215 이하)과 같은 정의다.
- 현행 웹사이트 요약 카드(미언급·복수언급·Top3, fetchWebsiteSubKpis server.ts:4880)는 두 곳에서 나온다. 미언급 프롬프트 수는 K-1 params 에서, 복수언급·Top3 는 K-3 total 에서 가져온다.

## 3. 공통 구성요소

- **resolve_scope** (common): JWT → ScopeContext → ResolvedScope. 만드는 값은 project_keys, own_bits, pop_bgrps, geo_keys, lang_keys, engine 술어, 택소노미 prompt_keys, global M05 허용 owner_keys, dropped·ignored 목록이다. 스코프가 비면 403(default-deny)이다.
- **CycleSet** (common): rd.cycle 1문장이다. 스냅샷 cyc_keys(offset 0|1), 기간 lo·hi, 계열별 제외 목록을 만든다. 규칙은 R03·R04·R07 을 따른다.
  - 언급 계열 제외: servable 거짓, view_date > rd.today_kst(), hidden_scope ∈ (1 all, 3 mentions).
  - 인용 계열 제외: 같은 조건, hidden_scope ∈ (1 all, 2 citations).
  - 제외 목록은 FILTER 안 `NOT cyc_key = ANY(...)` 로 건다. 1,000 을 넘으면 unnest 반조인으로 바꾼다.
- **own_cols**: 관점 브랜드 비트로 열을 고른다. 선택지는 h·k·g allow-list 뿐이다. 만드는 식은 vis, ment, sent_*, best_rk, ranked, multi, top1, top3 다.
- **answer_counts / citation_counts**: 아래 뼈대. 괄호 안 식은 own_bits = HMG 예시다.

```sql
SELECT {group_cols},
  count(*) FILTER (WHERE a.std_in AND NOT a.cyc_key = ANY(:m_excl))                                   AS answers,
  count(*) FILTER (WHERE a.std_in AND NOT a.cyc_key = ANY(:m_excl) AND (a.own_mask & 7) <> 0)          AS tracked,
  sum(a.ment_h + a.ment_k + a.ment_g) FILTER (WHERE a.std_in AND NOT a.cyc_key = ANY(:m_excl))         AS own_mentions,
  sum(a.ment_total)                   FILTER (WHERE a.std_in AND NOT a.cyc_key = ANY(:m_excl))         AS total_mentions,
  sum(a.sent_pos_h + a.sent_pos_k + a.sent_pos_g) FILTER (...)                                         AS pos,
  sum(a.sent_all_h + a.sent_all_k + a.sent_all_g) FILTER (...)                                         AS sent,
  sum(LEAST(NULLIF(a.own_rk_h,0), NULLIF(a.own_rk_k,0), NULLIF(a.own_rk_g,0))) FILTER (...)            AS rank_sum,
  count(*) FILTER (WHERE ... AND (a.own_rk_h > 0 OR a.own_rk_k > 0 OR a.own_rk_g > 0))                 AS ranked,
  count(DISTINCT a.prompt_key) FILTER (WHERE a.std_in AND NOT a.cyc_key = ANY(:m_excl))                AS measured_prompts,
  count(DISTINCT a.prompt_key) FILTER (WHERE ... AND (a.own_mask & 7) <> 0)                            AS mentioned_prompts,
  count(*) FILTER (WHERE a.cit_in AND NOT a.cyc_key = ANY(:m_excl))                                    AS gap_base,
  count(*) FILTER (WHERE a.cit_in AND a.gap AND NOT a.cyc_key = ANY(:m_excl))                          AS gap_answers,
  count(*) FILTER (WHERE a.cit_in AND a.web_reg AND NOT a.cyc_key = ANY(:c_excl))                      AS url_den,
  count(*) FILTER (WHERE a.cit_in AND a.web_reg AND a.tgt_cited AND NOT a.cyc_key = ANY(:c_excl))      AS tgt_hits,
  count(*) FILTER (WHERE a.cit_in AND a.web_reg AND a.own_url_cited AND NOT a.cyc_key = ANY(:c_excl))  AS own_url_hits
FROM rd.answer a
WHERE a.surface = :sf AND a.round_date BETWEEN :lo AND :hi      -- 스냅샷: round_date = ANY(:dates) AND cyc_key = ANY(:snap)
  AND a.project_key = ANY(:pk) AND a.bgrp = ANY(:pop_bgrps)
  AND a.dflt                                                   -- 또는 a.engine_key = ANY(:eng)
  [AND a.geo_key = ANY(:geo)] [AND a.lang_key = ANY(:lang)] [AND a.prompt_key = ANY(:tax)]
GROUP BY {group_cols};

SELECT {group_cols}, count(*) AS cit_total,
       count(*) FILTER (WHERE {owned}) AS cit_owned           -- global: c.owner_key = ANY(:owner_keys)
FROM rd.citation c                                            -- website: (c.loc_owned OR c.tgt_hit) · project: c.loc_owned
WHERE c.surface = :sf AND c.round_date BETWEEN :lo AND :hi AND c.cit_in
  AND c.project_key = ANY(:pk) AND c.bgrp = ANY(:pop_bgrps) AND c.dflt [...같은 축]
  AND NOT c.cyc_key = ANY(:c_excl)                            -- 인용 계열 제외 목록은 WHERE 로 걸어도 된다(인용 계열뿐)
GROUP BY {group_cols};
```

- **url_rates**: citations 모듈과 공유한다. R09 는 surface = website 이고 app.report_publication(status='active') 이 있는 round_date 에만 적용한다. rd.report_unit_value ⋈ rd.web_unit 의 정수쌍으로 그 회차 라이브 값을 대체한다. engine[] 처럼 발행값이 지원하지 않는 축이 걸리면 라이브 + meta.source 표식이다(G-22).
- **prompt_counts**: M12 적용 프롬프트 수. global 은 rd.catalog_entry ⋈ rd.dim_prompt, website 는 rd.dim_prompt.web_reg, project 는 rd.dim_prompt.
- **compare.py / consistency.py**: 현행 순수 로직을 이식한다. 골든 테스트도 함께 옮긴다.
- **schemas.py**: KpiMetricKey, Ratio, RankAvg, SuppressReason, KpiMeta.

## 4. 읽기 스키마

rd.answer 에서 쓰는 열: surface, round_date, cyc_key, project_key, prompt_key, engine_key, geo_key, lang_key, bgrp, dflt, std_in, cit_in, gap, web_reg, own_mask, own_rk_h/k/g, ment_total, ment_h/k/g, sent_pos/neg/all_h/k/g, tgt_cited, own_url_cited.

rd.citation 에서 쓰는 열: 같은 필터 축, cit_in, owner_key, loc_owned, tgt_hit.

그 밖의 읽기 표:

- 회차·세대: rd.cycle, rd.surface_generation.
- 차원: rd.dim_project, rd.dim_prompt, rd.catalog_entry, rd.dim_country·region·lang·engine·taxon.
- R09: rd.web_unit, rd.report_unit_value, app.report_publication.
- 권한·자사 판정: app.user_account·project·project_member·brand·rhq_region(_country)·owned_base·website_site.

단위 제안의 판정은 셋 다 기각이다.

| 제안 | 단위 | 판정 | 근거 |
| --- | --- | --- | --- |
| rd.cycle.expected_units·completed_units | K-2 | 기각(D8) | 계약 §3 예외 ③ 은 'API 비노출' 로 명시됐다(DB-v2.sql:335). 회차 수 비율 대안 (b) 로 구현하고, 가중이 필요하면 계약 개정을 제품 책임자에게 올린다 |
| rd.citation (surface, round_date, engine_key) WHERE cit_in | K-3 | 기각(HOT) | cit_in 은 전파 함수가 제자리 UPDATE 하는 열이다(DB-v2.sql:561). 부분 인덱스 술어 열도 HOT 판정 대상이다 |
| rd.cycle (surface, round_date ASC) | K-2 | 기각(불필요) | btree 는 역방향 스캔이 된다. rd.cycle 은 소형이고 cycle_project_idx 가 이미 있다 |
| M07 유닛 컬럼 | K-1(질문) | 불필요 | A2 로 측정 단위가 확정됐고 own_url_cited 로 충분하다 |

## 5. 권한

- 인증: A8 공통 미들웨어(JWT JWKS). 스코프는 서버가 계산하고 요청 필터와 교집합한다. 교집합이 비면 403(default-deny, fail-closed)이다.
- own_brand 는 서버가 정한다. 클라이언트는 바꿀 수 없다.
  - global: 계정 브랜드 스코프(+ HMG 공통 모집단)를 쓴다. 전사 무선택이면 HMG 3사다.
  - website: 사이트 브랜드다.
  - project: app.project.brand_code 다.
- 표면 접근:
  - project 는 app.project_member(status='active') 가 필요하다. 없으면 DB 조회 전에 403 이다.
  - website 는 역할·menu_groups 경로 정책(현행 route-policy 계승)을 따른다.
- 운영자 게이트는 없다. 읽기 전용이고 비용 액션이 아니다.
- 쓰기: 없다. 조회 감사 로그는 AU-1 결정을 따른다. 결정 전에는 쓰지 않는다.

## 6. 성능(10배, 잠정: 폭 10배 근거 없음)

| 엔드포인트 | 스냅샷 | 기간 누적 최악 | 가지치기 | 인덱스 | 위험 |
| --- | --- | --- | --- | --- | --- |
| K-1 | 월 leaf 1개, 글로벌 수십만 행 | 글로벌 1년 rd.answer 약 391만 행, 웹 1년 rd.citation 약 1,400만 행(추정) | surface LIST + round_date RANGE, cyc_key·round_date ANY | answer_rd_brin, answer_cell_idx(스냅샷), answer_p_proj_idx(project), cit_rd_brin, cit_p_proj_idx, cycle_pick_idx | medium |
| K-2 | cycle 종류: 두 회차 | window 365 = 730일 스캔, 웹 인용 약 2,800만 행 | 같음 | 같음 | high |
| K-3 | K-1 과 같은 스캔 + GROUP BY engine_key | K-1 과 같음 | 같음 | 같음(엔진 인덱스 없음, 병렬 순차 스캔) | medium |

- 알려진 고위험은 두 가지다. 웹사이트 인용 1년 조합(계약 §3)과, 화면당 API 5개 동시 호출(G-25)이다.
- 완화책은 차례로: 창 상한(G-17), M05 한정 G-02 (c) 예외, summary·engines 병합(Q7)이다.
- 게이트: RDS 구축 후 EXPLAIN (ANALYZE, BUFFERS, SETTINGS)로 잰다. heap fetch·temp 0, 콜드 p95 1초 이하, 동시 조건이어야 합격이다.

## 7. 대조 방법

- F01(카드) ↔ K-1: 현행 fetchStandardAggregates(server.ts:1917)·fetchWebsiteAggregates(:4818)·fetchWebsiteTargetHitRate(:5194)와 분자·분모 정수를 비교한다. 12조합이다.
- F07(기간 비교) ↔ K-2: 현행 스위치가 꺼져 값이 비어 있다. 현행 순수 함수 computeCompare(period-compare.ts:554)에 같은 원장·측정 입력을 넣어 로직을 대조하고, 입력 합은 F01 과 같은 빌더로 대조한다.
- F08(신설, 엔진별) ↔ K-3: 현행 aggregateSubKpisFromMirror(scope-aggregates.ts:3203) rows 와 비교한다.
- D6 불변식: K-1 누적 값 = trend 버킷 합이다. K-2 kind=cycle = trend bucket=cycle 마지막 두 점이다. 70/70 이어야 한다.
- 예상 차이는 mig.known_diff 에 등록한다: A1 스냅샷 모수, A2 URL 인용률 단위, A15·A16 ACR 반복·결손, G-21 owner_key, missing_share 비가중, K-1b 미측정 목록 한 키 한 행(카탈로그 행 단위 아님).

## 8. 열린 질문

1. **Q1 (제품 결정)**: missing_share 가중 판정을 위해 rd.cycle 에 expected_units 를 투영할지 정해야 한다. 투영하면 계약 D8 예외 ③ 'API 비노출' 을 개정해야 한다. 기본안은 회차 수 비율이다.
2. **Q2 (제품 책임자·명세)**: R10 문구('추이 배열 마지막 두 자리 차, 입력은 Δ 전용 롤업')를 정정해야 한다. 이 설계는 기간 비교(K-2 window·월·주)와 직전 회차 비교(K-2 cycle = 추이 마지막 두 점)를 한 엔드포인트로 둔다.
3. **Q3 (적재)**: project 표면 rd.answer.tgt_cited 가 app.project_tracked_url 로 채워지는지 확인해야 한다. 채워지지 않으면 프로젝트 7 KPI 의 타겟 URL 인용률을 낼 수 없다.
4. ~~**Q4 (명세 §6)**: 현행 mentionsPerAnswer·citationsPerAnswer(언급·인용 분석 화면의 기간 비교 줄)를 §6 에 등재할지 정해야 한다. 등재 전까지 K-2 는 M01~M05 만 낸다.~~ 해소(2026-09-28, 값 갭 BG-05): K-2 가 요청 시 `mentions_per_answer`·`citations_per_answer`(unit pct)를 낸다. 기본 목록은 M01~M05 그대로다. 인용 분모(cit_in 답변)와 현행 summary_trend_own.monitored 의 동치성은 대조 대상으로 남긴다.
5. **Q5 (명세 §6)**: 웹사이트 인용 정확도(tgt_cited / own_url_cited)와 브랜드 미언급 프롬프트 수를 §6 에 등재할지 정해야 한다. M12 하위 항목으로 둘지도 함께 정한다.
6. **Q6 (명세 §4)**: lang[] 를 '웹사이트 전용' 으로 둘지 정해야 한다. 현행 코드는 세 표면을 지원하고, 이 설계도 지원한다.
7. **Q7 (G-25)**: 실측에서 동시 호출이 불합격하면 summary·engines 를 GROUPING SETS 한 문장으로 병합할지 정해야 한다. 병합하면 P4 예외가 된다.
8. **Q8 (common)**: 전 권한(scope_all) 계정이 brand[] 를 복수 선택했을 때 own_bits 를 어떻게 정할지 정해야 한다. 이 설계의 가정은 단일 선택이면 그 브랜드, 그 외에는 HMG 다.
9. **Q9 (citations)**: 호스트 없는 인용(G-21 a)을 적재에서 rd.citation 에 넣지 않는지 확인해야 한다. 넣는다면 cit_total 제외 방식을 정해야 한다.
10. **Q10 (메인)**: K-1 applied_prompts(글로벌)에 계정 대상 시장 3분기(catalog_market_scope)와 soft-delete 제외를 걸지 정해야 한다. 현행 catalogPromptCountWhere 는 걸지 않는다. K-1b 목록은 권한 때문에 이미 건다(검증 D1). 걸면 두 값이 다시 같아지고 KIA_EU 같은 계정의 미측정 수가 줄어든다.
