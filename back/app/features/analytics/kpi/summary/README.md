# analytics.kpi.summary · 분석 조회 / KPI / 요약 카드

설계 단위: K-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/kpi/summary` | medium |
| GET | `/v1/kpi/unmeasured-prompts` | low (적용 수백~수천 행 − 스냅샷 측정, 상한 200) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/website`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28, an-kpi)
- 파라미터: 공통 필터(`KPI_SUPPORT`) + `cycle_offset`(0|1, 스냅샷 전용. 기간 모드에서 1 이면 `meta.ignored_filters`). 표면 경로 게이트(core `require_surface`: route-policy 역할 천장 + menu_groups) 위반은 403 `role_forbidden`·`menu_forbidden`.
- 응답: `visibility`·`share_of_voice`·`sentiment`·`citation_share`·`target_url_rate`·`owned_url_rate`·`citation_accuracy` = `Ratio{num, den}` 또는 null, `position` = `RankAvg{sum, count}`, `params`(M12), `analysis_gap{gap_answers, base_answers}`(A16).
- 억제 사유(`meta.suppressed`): `hidden`(계열 숨김) · `no_data`(분모 0) · `not_website_surface`(글로벌의 M06·M07·정확도, 웹사이트 밖의 prompts_without_brand) · `*: no_active_snapshot`.
- 프로젝트 표면 M06·M07·인용 정확도(Q5): core urls 분모 = cit_in 답변 전체(web_reg 게이트는 website 만, core D-url-denominator). 픽스처 k31 = 1/1·1/1·1/1.
- 인용 정확도 = 타겟 ∧ 자사 / 자사(core urls `tgt_own_hits`, 현행 summaryWebsiteCitationAccuracy). 발행 회차에서도 라이브.
- A16(`analysis_gap`): 창의 언급 계열이 전부 숨김이면 쌍은 {0,0} 이고 `meta.suppressed.analysis_gap = "hidden"`(결손 0 이 아니다). 웹사이트 스냅샷에 노출 회차가 없으면 `prompts_without_brand` 는 null + `no_data`.
- 계산: `core.measure.fetch_counts`(rd.answer 1회에 urls 포함 + M12 측정 프롬프트 보조 문장), `url_rates(live=...)`(같은 스캔 행을 넘겨
  rd.answer 재스캔 없음. R09 발행값 = 스냅샷 또는 from = to 한 회차, 헤드라인 풀 규칙 core), `prompt_counts`.
  `meta.source = {url_rates: report|live, reason, publications}`(라이브 사유 = core R09_*: engine_axis·period_range·no_publication·not_website).
  현행 프로필 web_url_rate(WU-7) 켜짐이면 발행값 선택이 현행 X.reportTruth 규칙(권한 게이트·발행물 어휘 브랜드·어휘 분기·from = to 날짜)이고
  사유가 더 있다: unsupported_axis·period_open_ended·scope_narrower·brand_not_in_publication·vocabulary_split·no_published_sites.
- 공용 조각: `shared.py`(읽기 문맥·기준일 의존성 `kpi_today`, compare·engines 가 함께 쓴다). compare 원장·첫 발행은 core.cycles(ledger_rows·first_published).

## 값 갭 보강(2026-09-28, bg-kpi-filters)
- BG-01: 글로벌 `lang[]` 적용(core `KPI_SUPPORT.global_` 에 lang 추가, 모듈-KPI §2 축 표 "전부"와 일치). 글로벌 M05 는 언어로 좁힌
  허용 배열이면 core 원소 스캔(scan) 경로. KPI_SUPPORT 를 쓰는 summary·engines·compare 와 파생 선언(trend TREND_SUPPORT)이 함께 받는다.
- BG-03: `depth4[]` 축(core `DEPTH4_AXIS`). global = 관점 카탈로그 행(brand_bit ∈ 관점 ∪ 엄브렐러)의 app.prompt.depth4 정확 일치(다른
  택소노미 축과 같은 행 조건), project = 프로젝트 프롬프트 depth4. 관점 카탈로그 행에 없는 값은 `dropped_filters.depth4`(전부 버려지면 빈 집합,
  타 브랜드 행에만 있는 값도 dropped: 검증 D5). website 는 `ignored_filters`. depth4 를 선언하지 않은 다른 엔드포인트(언급·인용·GEO 등)도
  `ignored_filters` 에 적는다(core 가 준 축으로 센다, 검증 D2).
- BG-04: `GET /v1/kpi/unmeasured-prompts` = 적용 집합(core `applied_prompt_keys_sql`, 카드 `params.applied_prompts` 와 같은 술어) −
  측정 집합(core `measured_prompt_where`, `params.measured_prompts` 와 같은 술어). 한 프롬프트 키 한 행, 정렬 = list_type·depth1(NULL 뒤)·
  text·키(현행 listUnmeasuredPromptsFromCatalog), `limit` 1~200(기본 200), `meta.page.total` = 절단 전 수 = |적용 \ 측정|.
  행 = {prompt_id(global 카탈로그 행·project 프롬프트·website Scope id), scope_prompt_id, text, list_type, depth1, depth2, funnel_stage}.
  창·필터·cycle_offset 은 K-1 과 같다. 스냅샷 노출 회차 없음 = `suppressed['*']` 빈 목록, 창의 언급 계열 전부 숨김 = `suppressed.items = hidden`.
  답변 축(국가·엔진·언어·기간)은 적용 집합을 좁히지 않는다(현행과 같다: 그 축이 걸리면 "그 조건에서 안 잡힌 것"이고 카드가 문구를 바꾼다).
  권한 게이트(검증 D1): 목록은 본문을 내므로 global 적용 키를 **살아 있는(soft-delete 제외) 루트 카탈로그 행 중 계정 대상 시장 3분기
  (core.filters.catalog_market_scope, GET /v1/prompts 와 같은 술어)를 통과하는 행이 있는 키**로 한정하고 대표 행도 그 행에서 고른다.
  카드 `params.applied_prompts` 에는 시장 게이트를 걸지 않는다(현행 catalogPromptCountWhere 와 같음). 그래서 대상 시장 밖 적용 행이 있는
  계정(예: regions = {US} 인 Kia 행과 KIA_EU)은 `total` < 카드 applied − measured 다. 카드에도 걸지는 메인 결정 대기(CORE-REQUESTS R1).
  행 게이트는 한 행 단위다(2차 검증 D1·D3): 브랜드 스코프(`catalog_brand_scope`) ∧ 대상 시장 3분기 ∧ 적용된 택소노미 축(rd.catalog_entry 키,
  rd.dim_taxon 사전) ∧ depth4 를 **같은 카탈로그 행**이 통과해야 키가 들어가고, 대표 행도 그 행 중 가장 작은 prompt_id 다(`queries.CatalogRowGate`).
  그래서 목록 ⊆ 같은 계정·같은 필터의 GET /v1/prompts(회귀 `test_r2_d1_*`), 필터를 걸면 대표 행이 필터에 안 맞는 형제 행이 되지 않는다(`test_r2_d3_*`).
  **known_diff(한 키 한 행, 2차 검증 D3)**: 현행 listUnmeasuredPromptsFromCatalog(scope-aggregates.ts:6178)는 카탈로그 행 단위라 같은 prompt_key 에
  브랜드 행이 둘이면(픽스처 키 1 'best suv' 현대 c1..01·Genesis c1..11) 두 행을 내고 total 도 행 수다. 이 API 는 카드 applied·measured 의
  서로 다른 키 단위를 따라 한 키 한 행으로 접고 total = 서로 다른 키 수다(total = applied − measured 유지). mig.known_diff 등록은 CORE-REQUESTS R4.
- BG-06: `params.prompts_without_brand` 를 세 표면 모두 채운다(측정 − 관점 언급 프롬프트). 억제 사유 `not_website_surface` 는 더 이상 쓰지 않는다.
  측정 프롬프트 0 이면(빈 창이 아니어도) null + `suppressed.prompts_without_brand = no_data`(현행 promptsWithoutBrand = prompts > 0 ? missing : null,
  화면 '—'. 검증 D3).
- BG-08: `by_funnel=true` 이면 `params.measured_by_funnel[{funnel, measured_prompts}]`(rd.dim_prompt.funnel_key → 퍼널 코드, 0 = 미분류 null,
  측정 수 내림차순). 합 = `measured_prompts`. 기본(false)은 null(추가 문장 없음).
- BG-26: 발행값(report)이면 `meta.source` 에 `round_date`·`site_count`(헤드라인 풀 규칙 뒤 합산 유닛 수 = 현행 publishedSubtotal.siteCount)·
  `publication_details[{slug, cycle_label, cycle_label_en, round_date}]` 를 더한다(추가형, 기존 `publications` slug 목록은 그대로). 라이브면 null(core 9라운드부터 키는 늘 있다).
- fe-u4 요청 1·2(core 9라운드): `meta.source` 는 OpenAPI 명명 스키마 `SummarySource`(응답 `SummaryResponse`·`SummaryMeta`). 발행물이 여럿이면
  `publication_details`·`publications` 순서 = round_date 내림차순 → slug 오름차순, 헤드라인 라벨 한 쌍 `cycle_label`·`cycle_label_en` = 첫 원소.
  현행 front 는 정해진 순서가 없다(report-publications.ts:210-217 ORDER BY 없는 LIMIT 1, 활성 유일 색인이 brand_scope 를 포함해 한 회차에 둘 이상 가능).
