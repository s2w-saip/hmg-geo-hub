# 화면 × 화면 빌더 × `/v1` 읽기

대공사 T1.1의 결과다. 프런트 코드(`screenGet`)와 첫 화면 실행 기록에서 만들었다(2026-11-06). 어느 화면 값이 어느 읽기에서 오는지 찾을 때 쓴다. `/v1` 읽기가 비어 있으면 그 빌더는 첫 화면 실행에 넣지 않았거나 지표 값을 읽지 않는 빌더다(Admin · 설정 · GA4 · 키워드 등).

페이지 91개 중 빌더를 직접 부르는 페이지 37개, 지표 읽기가 확인된 페이지 32개. 공용 컴포넌트 안의 호출은 그 컴포넌트를 쓰는 페이지에 잡히지 않을 수 있다.

## 값이 어느 층에서 오는가

| 읽기 | 처음 계산하는 곳 | 비고 |
|---|---|---|
| `kpi/summary` · `kpi/engines` · `kpi/compare` · `trend` · `mentions/brands` · `geo` | `bff/metrics/gold_current.py` (`gold_reader/metrics.py`가 응답으로 조립) | 지표 계산 층 |
| `mentions/types` · `citations/*` · `mentions/prompts` · `mentions/missing-prompts` · `mentions/market-gaps` · `funnel/acr*` · `prompts` | `gold_reader`의 답변 단위 SQL | 정의는 지표 계산 층과 같게 맞췄다. T9에서 어댑터 ②로 옮긴다 |
| `filters/*` · `cycles/week-notes` · `gold/projects*` | `gold_reader` | 지표 값이 아니다. 첫 화면 값은 함께 사전 집계한다 |
| `answers*` · `gold/keywords` · `gold/social` | `gold_reader` | 그대로 읽는다(사전 집계 · 캐시 안 함) |
| `analytics/*` | `hub_stores/analytics_reader.py` | GA4 · SEO. Silver 밖 |

## 페이지별

| 구분 | 경로 | 빌더 | `/v1` 읽기 |
|---|---|---|---|
| 리뉴얼 | `/renewal/[slug]` | — | — |
| 리뉴얼 | `/renewal/admin/ga4` | — | — |
| 리뉴얼 | `/renewal/admin/keyword-tools` | — | — |
| 리뉴얼 | `/renewal/admin` | — | — |
| 리뉴얼 | `/renewal/admin/standards/citation-sources` | — | — |
| 리뉴얼 | `/renewal/admin/standards/customer-interest` | — | — |
| 리뉴얼 | `/renewal/admin/standards/entities` | — | — |
| 리뉴얼 | `/renewal/admin/standards/prompts` | — | — |
| 리뉴얼 | `/renewal/dashboard` | `overview/as-of` · `overview/brand-matrix` · `overview/card-trend` · `overview/cards` · `overview/filters` · `overview/geo` | `citations/domains` · `filters/dates` · `filters/options` · `geo` · `kpi/summary` · `mentions/brands` · `trend` |
| 리뉴얼 | `/renewal/projects/[id]/[sub]` | — | — |
| 리뉴얼 | `/renewal/projects/[id]/ai-funnel/conversion` | `conversion/renewal` · `conversion/renewal-header` | — |
| 리뉴얼 | `/renewal/projects/[id]/analysis/citation` | `citation/as-of` · `citation/project` · `citation/renewal-header` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `trend` |
| 리뉴얼 | `/renewal/projects/[id]/analysis/citation/prompts` | `citation/prompts` | `citations/prompts` |
| 리뉴얼 | `/renewal/projects/[id]/analysis/citation/tone-urls` | `citation/tone-urls` | `citations/sources/tone` |
| 리뉴얼 | `/renewal/projects/[id]/analysis/mention` | `mention/rn-asof` · `mention/rn-bump` · `mention/rn-compare` · `mention/rn-favor-dist` · `mention/rn-favor-hero` · `mention/rn-favor-matrix` · `mention/rn-page` · `mention/rn-rank` · `mention/rn-ranking` · `mention/rn-rate-engines` · `mention/rn-rate-hero` · `mention/rn-rate-types` · `mention/rn-rate-value` · `mention/rn-shell` · `mention/rn-summary` · `mention/rn-tab-deltas` · `mention/rn-tab-value` | `kpi/engines` · `kpi/summary` · `mentions/brands` · `mentions/types` · `trend` |
| 리뉴얼 | `/renewal/projects/[id]/intent/google-keyword` | — | — |
| 리뉴얼 | `/renewal/projects/[id]/intent/social-scraping` | — | — |
| 리뉴얼 | `/renewal/projects/[id]/member` | — | — |
| 리뉴얼 | `/renewal/projects/[id]` | `projects/as-of` · `projects/dash-composition` · `projects/dash-engines` · `projects/dash-status` · `projects/dash-summary` · `projects/dash-summary-deferred` · `projects/dash-trend` | `citations/domains` · `gold/projects` · `gold/projects/{id}` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `trend` |
| 리뉴얼 | `/renewal/projects/[id]/prompt` | `projects/prompts` | `gold/projects/{id}` |
| 리뉴얼 | `/renewal/projects/[id]/setting` | `projects/settings` | — |
| 리뉴얼 | `/renewal/projects` | `projects/filters` · `projects/list` | `filters/dates` · `filters/options` |
| 리뉴얼 | `/renewal/standard/ai-funnel/acr` | `acr/renewal` · `acr/renewal-header` | `filters/dates` · `filters/options` · `funnel/acr` · `funnel/acr/coverage` |
| 리뉴얼 | `/renewal/standard/ai-funnel/conversion` | `conversion/renewal` · `conversion/renewal-header` | — |
| 리뉴얼 | `/renewal/standard/ai-funnel/visibility` | `visibility/renewal` · `visibility/renewal-header` | — |
| 리뉴얼 | `/renewal/standard/answer-analysis/citation` | `citation/as-of` · `citation/filter-bar` · `citation/renewal-header` · `citation/standard` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `trend` |
| 리뉴얼 | `/renewal/standard/answer-analysis/citation/prompts` | `citation/prompts` | `citations/prompts` |
| 리뉴얼 | `/renewal/standard/answer-analysis/citation/tone-urls` | `citation/tone-urls` | `citations/sources/tone` |
| 리뉴얼 | `/renewal/standard/answer-analysis/mention` | `mention/rn-asof` · `mention/rn-bump` · `mention/rn-compare` · `mention/rn-engine-extra` · `mention/rn-favor-dist` · `mention/rn-favor-hero` · `mention/rn-favor-matrix` · `mention/rn-page` · `mention/rn-presence-split` · `mention/rn-rank` · `mention/rn-ranking` · `mention/rn-rate-engines` · `mention/rn-rate-hero` · `mention/rn-rate-types` · `mention/rn-rate-value` · `mention/rn-shell` · `shared/filter-dates` · `shared/panel-options` | `filters/dates` · `filters/options` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `mentions/types` · `trend` |
| 리뉴얼 | `/renewal/standard/prompts` | — | — |
| 리뉴얼 | `/renewal/website/ai-funnel/conversion` | `conversion/renewal` · `conversion/renewal-header` | — |
| 리뉴얼 | `/renewal/website/answer-analysis/citation` | `citation/as-of` · `citation/filter-bar` · `citation/renewal-header` · `citation/website` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `kpi/summary` · `trend` |
| 리뉴얼 | `/renewal/website/answer-analysis/citation/prompts` | `citation/prompts` | `citations/prompts` |
| 리뉴얼 | `/renewal/website/answer-analysis/citation/tone-urls` | `citation/tone-urls` | `citations/sources/tone` |
| 리뉴얼 | `/renewal/website/answer-analysis/mention` | `mention/rn-asof` · `mention/rn-compare` · `mention/rn-favor-dist` · `mention/rn-favor-hero` · `mention/rn-favor-matrix` · `mention/rn-markets` · `mention/rn-page` · `mention/rn-rank` · `mention/rn-ranking` · `mention/rn-rate-engines` · `mention/rn-rate-hero` · `mention/rn-rate-types` · `mention/rn-rate-value` · `mention/rn-shell` · `mention/rn-summary` · `mention/rn-tab-deltas` · `mention/rn-tab-value` · `mention/view-cards` · `mention/view-compare` · `mention/view-weekly` · `shared/filter-dates` · `shared/panel-options` | `filters/dates` · `filters/options` · `geo` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `mentions/market-gaps` · `mentions/types` · `trend` |
| 리뉴얼 | `/renewal/website` | `overview/as-of` · `overview/filters` · `website/brands` · `website/composition` · `website/engines` · `website/geo` · `website/summary` · `website/summary-deferred` · `website/trend` | `citations/domains` · `filters/dates` · `filters/options` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `trend` |
| 리뉴얼 | `/renewal/website/prompts` | `website/prompts-insights` · `website/prompts-options` · `website/prompts-page` | `filters/dates` · `filters/options` · `prompts` |
| 레거시 | `/admin/[slug]` | — | — |
| 레거시 | `/admin/ga4` | — | — |
| 레거시 | `/admin/keyword-tools` | — | — |
| 레거시 | `/admin` | — | — |
| 레거시 | `/admin/standards/citation-sources` | — | — |
| 레거시 | `/admin/standards/customer-interest` | — | — |
| 레거시 | `/admin/standards/entities/applies/[applyId]` | — | — |
| 레거시 | `/admin/standards/entities/audit` | — | — |
| 레거시 | `/admin/standards/entities/draft` | — | — |
| 레거시 | `/admin/standards/entities` | — | — |
| 레거시 | `/admin/standards/entities/review` | — | — |
| 레거시 | `/admin/standards/entities/versions` | — | — |
| 레거시 | `/admin/standards` | — | — |
| 레거시 | `/admin/standards/prompts` | — | — |
| 레거시 | `/customer-interest/google-keywords` | — | — |
| 레거시 | `/customer-interest` | — | — |
| 레거시 | `/customer-interest/social-scraping` | — | — |
| 레거시 | `/dashboard` | `overview/as-of` · `overview/card-competitors` · `overview/card-trend` · `overview/cards` · `overview/filters` · `overview/geo` | `citations/domains` · `filters/dates` · `filters/options` · `geo` · `kpi/summary` · `mentions/brands` · `trend` |
| 레거시 | `/no-access` | — | — |
| 레거시 | `/projects/[id]/ai-funnel/acr` | — | — |
| 레거시 | `/projects/[id]/ai-funnel/conversion` | — | — |
| 레거시 | `/projects/[id]/ai-funnel` | — | — |
| 레거시 | `/projects/[id]/ai-funnel/visibility` | — | — |
| 레거시 | `/projects/[id]/analysis/citation` | `citation/project` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `trend` |
| 레거시 | `/projects/[id]/analysis/mention` | `mention/view` | `kpi/engines` · `kpi/summary` · `mentions/brands` · `mentions/types` · `trend` |
| 레거시 | `/projects/[id]/analysis` | — | — |
| 레거시 | `/projects/[id]/intent/google-keyword` | — | — |
| 레거시 | `/projects/[id]/intent` | — | — |
| 레거시 | `/projects/[id]/intent/social-scraping` | — | — |
| 레거시 | `/projects/[id]/member` | — | — |
| 레거시 | `/projects/[id]` | — | — |
| 레거시 | `/projects/[id]/prompt` | — | — |
| 레거시 | `/projects/[id]/setting` | — | — |
| 레거시 | `/projects/by-scope/[scopeId]` | — | — |
| 레거시 | `/projects/new` | — | — |
| 레거시 | `/projects` | — | — |
| 레거시 | `/standard/ai-funnel/acr` | `acr/standard` | `filters/dates` · `filters/options` · `funnel/acr` |
| 레거시 | `/standard/ai-funnel/conversion` | — | — |
| 레거시 | `/standard/ai-funnel` | — | — |
| 레거시 | `/standard/ai-funnel/visibility` | — | — |
| 레거시 | `/standard/answer-analysis/citation` | `citation/as-of` · `citation/filter-bar` · `citation/standard` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `trend` |
| 레거시 | `/standard/answer-analysis/citation/prompts` | `citation/prompts` | `citations/prompts` |
| 레거시 | `/standard/answer-analysis/citation/tone-urls` | `citation/tone-urls` | `citations/sources/tone` |
| 레거시 | `/standard/answer-analysis/mention` | `mention/as-of` · `mention/kpi-period` · `mention/prompts-section` · `shared/filter-dates` · `shared/panel-options` | `filters/dates` · `filters/options` · `kpi/summary` · `mentions/brands` · `mentions/types` · `trend` |
| 레거시 | `/standard/answer-analysis` | — | — |
| 레거시 | `/standard/prompts` | `catalog/prompts-header` · `catalog/prompts-history` · `catalog/prompts-page` | `filters/dates` · `prompts` |
| 레거시 | `/website/ai-funnel/acr` | — | — |
| 레거시 | `/website/ai-funnel/conversion` | — | — |
| 레거시 | `/website/ai-funnel` | — | — |
| 레거시 | `/website/answer-analysis/citation` | `citation/as-of` · `citation/filter-bar` · `citation/website` | `citations/domains` · `citations/prompts` · `citations/sources` · `filters/dates` · `filters/options` · `kpi/summary` · `trend` |
| 레거시 | `/website/answer-analysis/mention` | `mention/as-of` · `mention/view` · `shared/filter-dates` · `shared/panel-options` | `filters/dates` · `filters/options` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `mentions/types` · `trend` |
| 레거시 | `/website/answer-analysis` | — | — |
| 레거시 | `/website` | `overview/as-of` · `overview/filters` · `website/composition` · `website/geo` · `website/summary` · `website/summary-deferred` · `website/trend` | `citations/domains` · `filters/dates` · `filters/options` · `kpi/engines` · `kpi/summary` · `mentions/brands` · `trend` |
| 레거시 | `/website/prompts` | `website/prompts-list` · `website/prompts-options` | `filters/dates` · `filters/options` · `prompts` |

## 레거시 KPI와 유지 지표

대공사 T1.5의 결과다. 레거시 KPI는 통합할 수 있어도 없애지 않는다(`CLAUDE.md` 2절). 원본은 `back/bff/metrics/catalog.py`의 `screens`다.

### 레거시 화면에만 있는 값 (7개)

| 지표 | 화면 |
|---|---|
| 복수 언급 답변 | 레거시 Mention |
| 답변당 언급 수 | 레거시 기간 비교 |
| 복수 언급률 · 복수 언급 점유율 · 프롬프트 | 레거시 Mention |
| 경쟁사 평균(상위 N개사) | 레거시 Mention |
| 멘션 유형별 점유율 · 유형별 언급 건수(당사) | 레거시 Mention |
| 분석 누락 답변 | 레거시 Overview |
| 답변당 인용 수 | 레거시 기간 비교 |

### 리뉴얼에서도 유지하는 값 (88개, 두 화면 값 대조 대상)

| 지표 | 화면 |
|---|---|
| AI 노출률 | Overview · Mention · Website · Project |
| AI 점유율 | Overview · Mention · Website · Project |
| AI 우호도 | Overview · Mention · Website · Project |
| AI 우선 노출도 | Overview · Mention · Website · Project |
| Top 3 노출 비율 | 레거시 Overview · Mention |
| 멘션 유형별 노출 · 단순 언급 | Mention · Website Mention |
| 멘션 유형별 노출 · 추천 | Mention · Website Mention |
| 멘션 유형별 노출 · 비교 | Mention · Website Mention |
| 멘션 유형별 노출 · 정의 | Mention · Website Mention |
| 멘션 유형별 노출 · 최종 선택 | Mention · Website Mention |
| 경쟁사 대비 SOV | Website Overview |
| 부정 비율 | Mention |
| 감정 분포 · 긍정 | Mention |
| 감정 분포 · 중립 | Mention |
| 감정 분포 · 부정 | Mention |
| 감정 분포 · 혼합 | Mention |
| 유형별 긍정 비율 | Mention |
| 유형 안 점유율 | Mention |
| 1위 답변 비율 | 레거시 Overview · Mention |
| 브랜드 언급 수 | Mention |
| 회차별 언급 순위 | Mention |
| 언급 프롬프트 | Mention |
| 모그룹 묶음 언급 · 비중 | Mention |
| 순위 칩(N개 브랜드 중 M위) | Overview · Mention |
| 격차 | Mention |
| 엔진 간 일관성 | Website Overview |
| 브랜드 포함 · 미포함 질문 값 | Mention · Overview 시장별 |
| 전체 언급 수 | 레거시 · Website Mention |
| 긍정 키워드 언급 수 | 레거시 · Website Mention |
| 부정 키워드 언급 수 | 레거시 · Website Mention |
| 언급 브랜드 수 | 레거시 · Website Mention · Mention |
| 미언급 프롬프트 수 | 레거시 · Website Mention |
| 다른 브랜드 언급 · 브랜드 언급 없음 · 일부 엔진만 빠짐 | Website Mention |
| 브랜드 언급 없는 답변 · 언급 답변 변화 | Website Mention |
| 브랜드 포함(시장별) | Overview 시장별 |
| 프롬프트별 언급 수 · 점유율 · 신호 수 · 최고 순위 | 브랜드 서랍 · 신호 서랍 |
| AI 인용 점유율(global) | Overview · Citation |
| AI 인용 점유율(website) | Website Overview · Citation |
| 인용 비중 | Citation · Website Citation |
| 자사 URL 인용률(website) | Website Overview · Citation · Project |
| 타겟 URL 인용률(website) | Website Overview · Citation · Project |
| AI 타겟 출처 인용률(website) | Website Overview |
| 공식(당사) URL 미인용 프롬프트 | Citation · Website Citation |
| 커버리지 | Citation |
| 공식(당사) URL 인용 프롬프트 | Citation |
| 도메인 인용 점유율 | Citation · Website Overview |
| 도메인 인용 프롬프트 | Citation |
| 주별 도메인 순위 | Citation |
| 경쟁사 공식 출처 인용 점유율 | Overview |
| 공식(당사) 인용 비중 | Website Citation |
| 엔진 × 출처 카테고리 | Citation |
| 멘션 유형 × 출처 카테고리 | Citation |
| 긍정 · 부정 답변의 인용 URL | Citation |
| 전체 인용 수 | Citation · Website Citation |
| 인용 도메인 수 | Citation · Website Citation |
| 공식(당사) URL 인용 · 미인용 몫 | Citation · Project Citation |
| 출처별 구성비 · 기타 | Website Overview · Project |
| 공식(HMG) 순위 · 상위 % | Citation · 레거시 Mention |
| 도메인 서랍 인용 URL · 프롬프트 몫 | 도메인 서랍 |
| 프롬프트별 인용 수 | 공식(당사) URL 인용 · 미인용 프롬프트 |
| Top1 ACR(선택률) | ACR |
| 후보군 포함율 | ACR |
| 차종별 선택 전환율 | ACR |
| 맞대결 | ACR |
| 최종 선택(1순위 횟수) | ACR |
| 후보 언급 수 | ACR |
| 후보군 등장(차종) | ACR |
| 당사 순위 · 1위와 격차 | ACR |
| 당사 상태(선택 · 후보 탈락 · 미등장) | ACR |
| 프롬프트 × 엔진 1위 브랜드 | ACR |
| 선택 분포 | ACR |
| 답변 수 | Overview · Website Overview |
| 측정 프롬프트 | 레거시 Overview · Prompts |
| 측정 셀 · 반복 · 프롬프트 · 엔진 | ACR |
| 프롬프트 측정 횟수 · 회차 · 엔진 조합 | Website Prompts |
| 프로젝트 현황(프롬프트 · 답변 · 회차 · 커스텀 태그) | Project 목록 · Dashboard |
| 프롬프트 상태 수(측정 중 · 초안 · 중지 · 삭제됨 · 타겟 지정) | Project Prompt · Setting |
| 측정 회차 · 미측정 회차 | 레거시 기간 비교 · Mention |
| 최근 회차 측정 · 미측정 · 시장 커버리지 · 엔진 조합 | Website Prompts · Global Prompts |
| 답변 한 건의 언급 수 · 인용 수 | 답변 모달 · Overview 근거 |
| AI 크롤 커버리지 · 읽힌 날 · 마지막 크롤 | AI 가시성(메뉴 숨김) |
| AI 크롤 · 검색 노출 · AI 관심도 | AI 가시성(메뉴 숨김) |
| 상위 N% 집중도 · 지니 계수 | AI 가시성(메뉴 숨김) |
| 달성률 · 부족분 · 기대 크롤 | AI 가시성(메뉴 숨김) |
| 엔진 · 크롤러 · 섹션 · 우선순위별 몫 | AI 가시성(메뉴 숨김) |
| 검색량 · 경쟁도 · CPC · 순위 | Customer Interest · 레거시 Project intent |
| 총 발화 · 맥락 · 요구 · 연결 강도 | Customer Interest · 레거시 Project intent |
| AI Conversion(GA4) | AI Conversion |
