# 설계: 기간 누적의 집계층 서빙

기준 커밋: 통합 프리뷰 `b0f4c59`. 아래 file:line 은 그 트리 기준이다.
실측은 전부 2026-09-18 세션, 프로덕션 DB 읽기 전용(`mcp supabase-hmg execute_sql`).

## 1. 증상 (운영 담당 실측, 재검증 가능)

| 지면 | 기간 없음 / 7일 | 30일(2026-08-20..09-18) |
| --- | --- | --- |
| `/ko/dashboard` 프로덕션(`fe1de1d`) | 정상 3.9s | 정상 3.9s |
| `/ko/dashboard` 통합 프리뷰 | 정상 | **빈 값**, 18~25s 뒤 degrade 문구 |
| `/ko/website` 프로덕션·프리뷰 | 정상 | **빈 값**, 29~37s, "측정 데이터가 아직 없습니다" |
| 글로벌·웹사이트 언급/인용 | 정상 | 값은 나오나 26~41s |

캐시 우회(`x-hmg-perf-nocache`, ACK 확인)에서도 동일하므로 캐시 문제가 아니다.

프리뷰 런타임 로그(같은 요청):

```
x-hmg-summary(global S1.dashboard): fallback:cumulative
x-hmg-summary(global S1.dashboard period): hit cycles:4
[kpi-tabs] standardAggregates timed out (page still served): Failed query: WITH names AS (…)
[kpi-tabs] … standard-citations … extras … Failed query: WITH c2 AS MATERIALIZED (…)
x-hmg-summary(S4.dashboard): fallback:cumulative
x-hmg-summary(S4.subkpi): fallback:cumulative
x-hmg-summary(S6.citation): fallback:cumulative
x-hmg-summary(S4.dashboard.trend): fallback:unpublished-cycle-in-range
[kpi-tabs] websiteAggregates timed out …
```

두 줄이 나란히 있는 것이 이 결함의 요약이다: **같은 요청에서 카드는 미러로 떨어지고,
추이는 집계층에서 회차 4개를 이미 읽는다.**

## 2. 기전

```
dashboard/page.tsx:102   cumulative = Boolean(dateFrom || dateTo)
website/page.tsx:111     동일
        ↓
gate.ts:140              mode === "snapshot" && cumulative === true  → "cumulative"
        ↓  (사실표 리더 포기)
server.ts:1578 viaGlobalS1 → onMirror = cachedStandardAggregates (server.ts:903)
server.ts:3582 viaTrend    → onMirror = cachedWebsiteAggregates (server.ts:3126)
        ↓
aggregateStandardFromMirror + mirrorHeavyBudget("cardsMirror")
        = 문장 10s / 벽시계 30s  (kpi-tab-budget.ts:485)
        ↓ 초과
degradeAware("standardAggregates") → null → 카드 자리 빈 채 degrade 문구
```

정정 1건: 임무 브리핑은 초과 상수를 `KPI_TAB_STATEMENT_TIMEOUT_MS = 20_000`
(`kpi-tab-budget.ts:42`)으로 적었으나, 카드 미러 폴백이 실제로 쓰는 것은
`MIRROR_HEAVY_PROFILES.cardsMirror`(문장 10s · 벽시계 30s)다. 관측된 18~25s degrade 는
벽시계 30s 가 아니라 **문장 10s** 가 먼저 죽인 뒤 남은 문장들이 이어 돈 형태와 맞는다.
빌더는 이 귀속을 로그의 `Failed query` 문장으로 한 번 더 확인할 것.

## 3. 영향 지면·셀 전수

### 3-1. `cumulative` 때문에 미러로 가는 곳 (기간 지정 시)

| # | 표면·지면 | 화면 키 | 페처 | 미러 목적지 | 셀 |
| --- | --- | --- | --- | --- | --- |
| 1 | 글로벌 대시보드 KPI 카드 ①~⑤ | `S1.dashboard` | `fetchStandardAggregates` (server.ts:1566) | `cachedStandardAggregates` (:903) | 노출률·점유율·인용·우선노출도·감정 + 모수 |
| 2 | 글로벌 대시보드 국가별 GEO | `S1.dashboard` | `fetchStandardGeoKpi` (:2953) | `cachedGeoKpi` | 국가 KPI 5종·지도 채색·권역/국가 트리표 |
| 3 | 글로벌 카드 하단 경쟁사 행 | `S1.competitors` | `fetchStandardCompetitorSources` (:2800) | 미러 언급 집계 | 경쟁사 미니값 4(언급·점유율·노출률·순위·감정) |
| 4 | 웹사이트 오버뷰 카드 | `S4.dashboard` | `fetchWebsiteAggregates` (:3576) | `cachedWebsiteAggregates` (:3126) | 카드 ①~⑤ + 모수 |
| 5 | 웹사이트 엔진 일관성 배지 | `S4.subkpi` | `fetchWebsiteSubKpis` (:3625) | `cachedWebsiteSubKpis` (:3160대) | 배지(answers·mentions·sentiment·citations) |
| 6 | 웹사이트 GEO 경쟁 | S4 계열 | `cachedWebsiteGeoCompetition` (:3200대) | 미러 | 국가별 경쟁 언급 |

### 3-2. 기간과 무관하게 **항상** 미러인 곳 (`cumulative: true` 상시)

| # | 지면 | 화면 키 | `cumulative` 를 세우는 자리 |
| --- | --- | --- | --- |
| 7 | 글로벌 인용 | `S3.citation` | `standard/answer-analysis/citation/page.tsx:67` |
| 8 | 글로벌 인용 하위(톤 URL·프롬프트) | `S3.citation` | 같은 폴더 `tone-urls/page.tsx:25`, `prompts/page.tsx:27` |
| 9 | 글로벌 언급 | `S2.mention` | `standard/answer-analysis/mention/page.tsx:87` |
| 10 | 웹사이트 인용 | `S6.citation` | `website/answer-analysis/citation/page.tsx:67` |
| 11 | 웹사이트 언급 | `S5.mention` | `website/answer-analysis/mention/page.tsx:66` |

7·8·10 은 프로덕션 `read_screens` 에 **켜져 있는데도** 게이트가 `cumulative` 로 막아 한 번도
집계층을 못 타고 있다. 30일에서 26~41s 가 나오는 이유가 이것이다.
9·11 은 화면 키 자체가 `SUMMARY_SCREEN_OPT_IN`(`screens.ts`)에 있어 별도 승인 대상이다.

### 3-3. 프로덕션 스위치 실측 (2026-09-18)

```
read_enabled  = 1
read_screens  = ["S4.dashboard","S1.dashboard","S3.citation","S6.citation",
                 "S4.subkpi","S1.competitors","S2.mentionTrend"]
website_excluded_fs = [71,94,97]
```

즉 1·2·3·4·5 의 화면 키는 이미 켜져 있고, 막는 것은 게이트 한 줄이다.

## 4. 누적 산식의 집계층 동치성 (지표별)

집계층 리더(`summary-trend-aggregates.ts`)는 회차 집합을 `(cycle_id, generation_id)` 쌍으로
받아 GROUPING SETS 로 SUM 한다(`cycleScope` :488). 회차가 N개면 N회차 합이 그대로 나온다.
회차는 답변을 **분할**하므로(한 답변은 한 회차에만 속한다) 카운터의 회차 간 SUM 은 중복이 없다.

### 4-1. 그대로 재현되는 지표 (`summary-global-aggregates.ts:756-864`)

| 카드 셀 | 집계층 식 | 가산성 근거 |
| --- | --- | --- |
| 총 답변(모수) | `sum(own.monitored)` | 답변 카운터. 회차가 답변을 분할 |
| 당사 등장 답변 | `sum(own.tracked_answers)` | 같음 |
| 총 언급 | `Σ brand_rows.mentions`(잔여 행 포함) | 언급 카운터 |
| 브랜드 타일·순위 | `(brand_name)` 그룹 SUM | GROUP BY 가 회차를 접는다. 고유 브랜드 수는 SUM 이 아니라 합집합이라 정확 |
| 인용 있는 답변 | `sum(own.citing_answers)` | 답변 카운터 |
| 총 인용·자사 인용 | `trend_domains` 의 `sum(citations)`·`ownedCitationExpr` FILTER | 인용 카운터 |
| 국가 롤업(regions·GEO codes) | `(country)` 그룹 SUM | 같음 |
| 우선노출도 ④ | `sum(rank_sum) / sum(ranked_answers)` | **비율은 분자·분모를 각각 합산**. 미러 누적도 같은 Σ/Σ 형태 |
| 감정 ③ | `sum(own_positive) / sum(own_signals)` | 같음 |
| 경쟁사 점유율 | `mentions / Σ mentions` | 같음 |
| 경쟁사 노출률 | `brand.answers / own.monitored` | 같음 |
| 경쟁사 평균 순위 | `sum(comp_rank_sum) / sum(comp_ranked_answers)` | 같음(0069 가 축을 맞췄다) |

비율 지표에서 "회차별 비율의 평균"이 아니라 **분자 합 / 분모 합**이라는 점이 중요하다.
기간 의미론 정본("그 기간 회차 전부 누적")과 일치하고, 미러 누적 경로와도 같은 형태다.

### 4-2. 재현 불가 지표 (반드시 별도 처리)

**프롬프트 단위 고유 개수**(측정 프롬프트 수·미언급 프롬프트 수·주제별 프롬프트 수).

- 집계층의 `prompts_measured`·`prompts_tracked` 는 **키 그룹 안 DISTINCT** 라 그룹 간 SUM 이
  이미 이중 계상이고(0065 의 컬럼 COMMENT), 리더는 그래서 그 두 컬럼을 **SELECT 하지 않는다**
  (`summary-trend-aggregates.ts:87`). 회차 간 SUM 은 더 나쁘다: 같은 프롬프트가 4회차에 4번 센다.
- 오늘 그 값은 세부층 `summary_answers` 에서 온다(`summaryGlobalPromptTopics` 등).
  세부층 호출은 **단일 회차 스코프**라, 기간 모드에서 그대로 두면 "30일" 라벨 옆에
  1회차 프롬프트 수가 선다.

대안(권장 순):

1. **(권장) 세부층을 회차 집합 전체로 읽고 `count(DISTINCT prompt_id)`.** 세부층 6표는 주
   파티션이므로 `set.weeks` 를 `dateArray()` 스칼라 펼침으로 넘겨 프루닝한다
   (`cycle-set.ts` 계약 ②: `sql.param(배열)::date[]` 금지). 문장 1개가 늘고, 값은 "기간 내
   고유 프롬프트 수"라는 정확한 의미가 된다.
2. 비용이 문제면 그 셀만 **최신 회차 기준**임을 화면 캡션에 명시하고 기간과 분리한다.
   값은 틀리지 않지만 같은 카드 안에 두 축이 서므로 차선이다.
3. 기간 모드에서 그 셀을 **감춘다**. 최후 수단.

### 4-3. 미러와 값이 같지 않은 이유 (수용 기준 설계의 전제)

집계층 누적 = 미러 누적이 **아니다.** 차이는 판정이 아니라 창·모수다:

| 축 | 미러 누적 | 집계층 기간 |
| --- | --- | --- |
| 회차 선택 | `cycle_anchor_at` 이 기간 안인 run 전부, 앵커 NULL run 은 `measured_at` 폴백(0.14%) (`scope-aggregates.ts:802-830`) | `summary_cycles` 원장에서 노출 가능(view anchor 통과)·미숨김·생성 완료 회차만 |
| 미발행 회차 | 포함 | 제외(구멍이면 전체 폴백) |
| 숨김 회차(0070/0071) | 포함 | 제외. `hidden_scope='citations'` 는 언급만 포함 |
| 유닛 게이트 | 웹사이트 `report_fs IS NOT NULL` | `report_fs <> 0` + `website_excluded_fs` 배제 |
| 자사 인용 판정 | 미러 규칙 | 0060 유닛 판정 |

`screens.ts` 의 `S4.subkpi` 예외 블록이 같은 성질을 이미 수치로 기록해 두었다
(answers 25,169 vs 19,530 등). 그러므로 **"미러 값과 오차 0"은 수용 기준이 될 수 없다.**
대신 tasks.md 의 수용 기준은 (a) 집계층 내부 대조(독립 SQL) 오차 0, (b) 미러와의 차이는
설명 가능한 항목으로만 구성되는가(모수 차이 분해)로 쓴다.

## 5. 회차 집합 판정 실측과 웹사이트 블로커

창 2026-08-20..2026-09-18, 읽기 전용 실측:

| 표면 | 창 안 회차 | 노출 가능 | open | 생성기 미선택(skipped) | 숨김 | 구멍 |
| --- | --- | --- | --- | --- | --- | --- |
| global | 4 | 4 | 0 | 0 | 1(`hidden_scope='citations'`) | **0** |
| website | 475 | 378 | 94 | 2 | 0 | **1** |

- **글로벌**: 구멍 0. 숨김 1건은 `hidden_scope='citations'`(앵커 2026-08-25)라 언급 계열은
  집합에 남고 인용만 갭으로 덮인다(`cycle-set.ts:249-258`). 로그의 `cycles:4` 와 일치한다.
  → 글로벌 1순위는 **오늘 상태에서 곧바로 발화한다.**
- **웹사이트**: 구멍 정확히 1건.

  ```
  cycle_id   be63ee63-72d3-44d9-bbc4-5fa360c8965d
  project_id 5de09736-6b44-4986-ab2c-8423887cbe22
  anchor     2026-09-14   week 2026-09-14
  status     closed   renderable false   pending false   hidden false
  analysis_gap_ratio 0.00000   expected_units 102   completed_units 102
  ```

  `closed` + 갭 0 이므로 생성기 `--pending` 술어가 **뽑을 수 있는** 회차인데
  `active_generation_id` 가 아직 비어 있다. `isGeneratorSkipped`(갭 > 임계 또는 NULL)에
  해당하지 않으므로 구멍으로 세어지고, 함대 전체 기간 읽기가 폴백한다.
  같은 주(2026-09-14)의 나머지 94 회차는 `open` 이라 면제다.
- 주 중복 규칙(`duplicate-cycle-in-week`) 위반 0건: 주별 94/94·94/94·95/95·95/95.
- 창 안 378 회차 전부 `summary_trend_own`·`brands`·`domains` 에 행이 있다(fold 누락 0).

즉 **웹사이트 1순위는 코드가 아니라 원장 상태에 막혀 있다.** 처리 옵션은 §8 D1.

## 6. 설계

### 6-1. 게이트 (`lib/summary/read/gate.ts`)

`commonUnsupportedReason` 의 `cumulative` 분기를 두 갈래로 좁힌다.

- 기간이 **있는** `cumulative` 요청은 호출부가 `mode: "period"` 로 넘긴다. 그 모드에서는
  이미 막지 않는다(현행 주석 그대로: "기간 모드는 그 누적을 회차 집합 SUM 으로 내는 것이 목적").
- 기간이 **없는** `cumulative` 요청(항상 미러인 3-2 화면들)은 미러 산식 정본
  `cumulativeMode`(`scope-aggregates.ts:1148`)가 이미 **스냅샷**으로 판정하므로, 사실표
  스냅샷과 의미론이 같다. 따라서 폴백 사유에서 내린다.
  구현은 판정을 `filters.cumulative === true` 가 아니라 "미러가 실제로 누적이 되는 조건"
  (`cumulative && (dateFrom || dateTo)`)으로 바꾸는 것이고, **그 술어는 한 곳에서만 정의한다**
  (두 벌로 갈라져 2026-09-04~09-16 에 이노션 신고를 만든 전례가 `cumulativeMode` 머리 주석에 있다).

⚠️ 기간 없는 요청을 `mode: "period"` 로 보내면 안 된다. `resolveCycleSet` 의 period 갈래는
`pickCyclesInRange` 를 무경계로 돌려 전 이력 회차를 집합에 넣는다. 모드 선택 규칙은
`dateFrom || dateTo` 하나다.

### 6-2. 리더 라우팅 (`lib/scope/server.ts`)

- `viaGlobalS1`(:1397)과 `viaTrend`(:3529)에 모드 인자를 준다. 기간이 있으면 각각
  `resolveGlobalSummaryRouteBase(..., { mode: "period" })` /
  `resolveWebsiteSummaryRouteBase(..., { mode: "period" })` 를 쓴다.
  판정 캐시 키는 지금처럼 `{r,f}`/`{p,f}` 이고 **화면 키를 넣지 않는다**(PR① R2 규율).
  모드는 필터에서 파생되므로 키에 추가로 넣을 필요가 없다.
- 로그 문자열은 기존 기간 경로와 같은 형태(`x-hmg-summary(global S1.dashboard period): …`)로
  통일해 `cycles:<n>` 이 관측에 남게 한다.

### 6-3. 폴백 목적지 규율 (이 설계에서 가장 위험한 지점)

현행 `viaGlobalS1` 은 `agg-fold-missing`·`agg-empty`·`agg-widget-empty` 에서
`onDetail(route.cycleKey, route.cycles[0], …)` 로 간다. **세부층은 단일 회차만 읽는다.**
기간 모드에서 이 경로를 그대로 두면 "2026-08-20..09-18" 라벨 아래 **1회차 값**이 조용히 실린다.
빈 화면보다 나쁘다(틀린 숫자는 아무도 못 잡는다).

규칙: **기간 모드에서 `agg-*` 폴백의 목적지는 미러다.** 세부층으로 가지 않는다.
이미 그렇게 하는 선례가 `viaGlobalSeries`(server.ts:2059 계열)와 `websiteTrendSet` 이다
("추이엔 세부층 쌍둥이가 없다"). 세부층을 기간으로 확장하는 것은 이 변경의 범위 밖이다.

### 6-4. 캐시 키 (웹사이트에서만 문제)

`requestS1`·`cachedSummaryWebsiteDashboard` 는 `JSON.stringify({set,…})` 를 React cache /
`mirrorCache` 키로 쓴다. 웹사이트 기간 집합은 회차 378개라 `cycleKey` 만 약 28 KB 이고,
`set` 전체 직렬화는 그보다 크다. 요청마다 문자열을 만들고 비교하는 비용이 붙고,
`unstable_cache` 키 길이도 커진다.
→ 기간 모드에서는 `cycleKey` 를 **안정 해시**(예: sha256 앞 16자)로 접어 키에 쓰고,
집합 원본은 인자로만 넘긴다. 값에는 영향이 없다(키 충돌 위험은 해시 길이로 관리).

### 6-5. 화면 키·스위치

새 플래그를 만들지 않는다. 켜고 끄는 수단은 `summary_settings.read_screens` 의 기존 키다
(`scripts/summary/read-switch.ts`). 기간 모드 전환은 값을 바꾸므로, 대상 키를
`SUMMARY_SCREEN_OPT_IN` 으로 올릴지는 §8 D2 결정에 따른다.

### 6-6. 마이그레이션

**없다.** 집계층 4표·인덱스·접기 모두 그대로 쓴다. 따라서 `db:apply → 배포` 순서 규율의
적용 대상이 아니다. 만약 후속 EXPLAIN 에서 기간 모드 전용 인덱스가 필요해지면 그때는
별도 change 로 분리하고, 그 파일에서 `db:apply` 선행 규율을 따른다
(docs/development-guide.md "DB 마이그레이션 절차", 멱등·카탈로그 선확인·`CONCURRENTLY` 불가).

## 7. 성능 근거

### 7-1. 새 경로 (집계층 기간 읽기) : 실행함

프로덕션 DB, `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`, 2026-09-18.
**근사 측정이다**: 대상 표·인덱스 진입 술어·GROUPING SETS 형태는 리더와 같지만,
`own_variant` 별 `$sel` FILTER 식과 절단(`is_rest`)은 재현하지 않았다. 따라서 아래 값은
리더 문장의 **하한**으로 읽어야 하고, 빌더는 `scripts/summary/explain-s1.ts` 계열을
회차 집합 N개로 확장해 실제 문장으로 다시 잰다(tasks.md W5).

글로벌(루트 `be28fe15…`), 창 2026-08-20..09-18 = 회차 4개:

| 문장 | 조합 | 스캔 행 | Execution Time |
| --- | --- | --- | --- |
| `trend_own` GROUPING SETS ((),(engine),(country)) | 무필터(ALL) 4회차 | 22,496 | **35.5 ms** |
| 같은 문장 | 무필터(ALL) **1회차**(9/13) | 6,439 | 11.2 ms |
| `trend_brands` GROUPING SETS ((brand),(country,brand)) | 무필터 함대 4회차 | 452,980 | **585.9 ms** |
| `trend_brands` | 단일 브랜드(Hyundai) 4회차 | 206,659 | **335.4 ms** |
| `trend_brands` | 소형(Hyundai + KR) 4회차 | 4,674 | **52.9 ms** |
| `trend_domains` GROUPING SETS ((group),(domain),(country),()) | 무필터 4회차 | 250,083 | **291.2 ms** |

무필터 기준 S1 3문장 합 약 **0.91 s**. 회차 1개 대비 행 수는 3.5배, 시간은 3.2배로
**회차 수에 선형**이다(폭발하지 않는다). 플래너는 `summary_trend_*_pick` 인덱스를 탔고,
소형 조합은 `summary_trend_brands_cb`(gin) + `_read` BitmapAnd 로 4,674행까지 좁혔다.

웹사이트(함대), 같은 창 = 노출 가능 회차 378개:

| 문장 | 스캔 행 | Execution Time |
| --- | --- | --- |
| `trend_own` (surface=website, `report_fs <> 0`) | 1,194 | **2.5 ms** |
| `trend_brands` (surface=website) | 63,338 | **72.8 ms** |

웹사이트 집계층은 글로벌보다 훨씬 작다(사이트별 키 그룹이 좁다). 회차 378개가 성능 문제를
만들지 않는다는 뜻이고, 웹사이트의 진짜 장애물은 §5 의 구멍 1건이다.

### 7-2. 오늘의 느린 미러 문장 : **미실행**

로그가 지목한 두 문장(`WITH names AS (…)` = `ROLLUP_NAMES` 계열,
`WITH c2 AS MATERIALIZED (…)` = `scope_citations` 계열)의 `EXPLAIN (ANALYZE)` 는
작성 시점에 **돌리지 않았다.** 이유:

1. 그 문장들은 `withAnswerSet` 의 TEMP TABLE 안에서만 성립한다. 떼어내 재면 못 돌고,
   CTE 로 바꿔 재면 비용 귀속이 틀린다(`kpi-tab-budget.ts:26-40` 이 그 오진의 대가를 기록).
   제대로 재려면 `scripts/summary/explain-mirror-heavy.ts --explain` 을 돌려야 한다.
2. 그 하네스는 **라이브 고객 DB**에서 20~40s 짜리 문장을 다수 발행한다. 스펙 작성 단계에서
   고객 트래픽과 경합시킬 근거가 부족하다고 판단했다.

대신 이 스펙이 근거로 쓰는 미러 측 수치는 **화면 벽시계 실측**이다(§1 표: 18~25s / 29~37s /
26~41s). 추정치가 아니라 관측치이지만 EXPLAIN 이 아니라는 점을 명시한다.
서버측 exec 귀속은 W5 에서 빌더가 채운다.

## 8. 제품 결정이 필요한 것

### D1. 웹사이트 구멍 회차(`be63ee63…`, 앵커 2026-09-14) 처리 (권장: 1)

1. **(권장) 운영 조치로 그 회차를 생성한다.** 갭 0·유닛 102/102 로 생성 조건을 이미 만족한다.
   `scripts/summary/generate-cycle.ts --pending` 경로. 코드 변경 0, 이번 창이 바로 풀린다.
   단 **같은 형태가 매주 재발한다**(함대가 끝나기 전 한 사이트만 먼저 닫히는 구조).
2. 판정을 바꾼다: `closed` + 생성기가 뽑을 수 있는 상태(`gap <= MAX`) + `active_generation_id`
   없음 = "생성 대기"로 보고 `open` 과 같이 면제한다. 재발이 없어진다. 대가는 그 회차 데이터가
   조용히 창에서 빠지는 것이고, 이는 fail-closed 원칙의 완화다(`cycle-set.ts:210-247`).
3. 1 + 2 를 함께: 지금은 1로 풀고, 2는 별도 change 로 근거(재발 빈도 실측)를 쌓은 뒤 결정.

### D2. 어느 화면 키를 언제 켜는가 (권장: 2)

1. 게이트만 고치고 키는 전부 그대로 둔다. 이미 켜진 키(S1.dashboard·S4.dashboard·
   S3.citation·S6.citation·S4.subkpi·S1.competitors)가 **즉시** 기간 모드를 탄다.
   빠르지만 6지면의 숫자가 한 번에 바뀐다.
2. **(권장) 게이트 수정 + 기간 모드 전환분을 opt-in 으로 가른다.** 기존 키는 스냅샷에서만
   집계층을 타고, 기간 모드는 이름을 명시한 키에서만 켜진다. 9/21 QA 에는 글로벌 1개만
   켜서 확인하고 나머지는 순차 확대.
3. 전부 off 로 머지하고 2순위(문구)만 QA 에 태운다. 가장 안전하지만 30일 빈 화면이 유지된다.

### D3. 프롬프트 수 계열 처리 (권장: 1, §4-2)

1. **(권장) 세부층을 회차 집합 전체로 읽어 `count(DISTINCT prompt_id)`.** 문장 1개 추가.
2. 그 셀만 최신 회차 기준임을 캡션에 명시.
3. 기간 모드에서 감춘다.

### D4. 9/21 QA 탑재 범위 (권장: 2, §11)

## 9. 병합 충돌 위험

GGMD-107(`feat/GGMD-107-impl`)은 통합 프리뷰 `b0f4c59` 에 **아직 병합되지 않았다**
(`git merge-base --is-ancestor` 로 `fc9663f`·`aaed32f`·`dbca54a`·`0d8468b` 전부 NOT in HEAD).
`b0f4c59` 기준 GGMD-107 diff 의 충돌면:

| 파일 | GGMD-107 변경 | 이 change 의 변경 | 위험 |
| --- | --- | --- | --- |
| `lib/summary/read/gate.ts` | 없음 | 판정 수정 | **없음** |
| `lib/summary/read/cycle-set.ts` | 없음 | (D1-2 채택 시만) | 없음 |
| `lib/scope/server.ts` | import 블록(:67) · `mirrorCache`(:795-830) · 말미 +357줄(:3805~) | `viaGlobalS1`(:1397) · `fetchStandardAggregates`(:1566) · `viaTrend`(:3529) | **낮음**(구간 비중첩). import 블록만 손충돌 |
| `app/[locale]/(dash)/website/page.tsx` | `WebsiteSummarySection` 시그니처에 `filters` 추가(:292~) | 같은 함수의 `if (!dash)` 블록(:296-303) | **중간**, 기계적 해소 |
| `app/[locale]/(dash)/dashboard/page.tsx` | `KpiCardsSection`(:306~) | (1순위는 페이지 무수정이 목표) | 낮음 |
| `lib/summary/read/screens.ts` | 키 +17줄 | (D2-2 채택 시 키 추가) | **중간**, 같은 배열 |

권고: 이 change 의 브랜치는 `b0f4c59` 를 base 로 유지하고, GGMD-107 병합 **이후**에
통합 프리뷰로 올린다. 순서가 반대면 server.ts 말미 357줄 위에서 리베이스하게 된다.

또한 hmg-geo PR #269 통합 프리뷰 자체가 여러 트랙을 모으는 브랜치이므로, 이 change 는
**게이트·라우팅(lib)** 과 **문구(app)** 를 다른 커밋으로 분리해 2순위만 따로 체리픽할 수 있게 한다.

## 10. `S4.dashboard.trend: fallback:unpublished-cycle-in-range` 판정

**관련 있다. 같은 원인(§5 구멍 1건)의 다른 발현이다.**

- 그 로그는 웹사이트 **추이**가 기간 모드 게이트에서 거부됐다는 뜻이고, 거부 사유가 곧
  이 change 의 1순위가 웹사이트에서 발화하지 못하는 이유다.
- 다만 추이 자체는 **깨져 보이지 않는다**: 미러로 떨어져 값이 나오기 때문이다(증상 표에서
  "추이 차트는 나온다"). 그래서 이 로그는 결함의 증상이 아니라 **진단 신호**로 다룬다.
- 범위는 넓히지 않는다. 이 change 는 그 사유를 **해소 대상 블로커(B1)로 기록**할 뿐,
  추이 경로를 수정하지 않는다.

## 11. 9/21 QA 탑재 범위 판정

**판정: 2순위만 확실, 1순위는 글로벌 한정 조건부.**

| 항목 | 9/21 탑재 | 근거 |
| --- | --- | --- |
| 2순위(웹사이트 degrade 문구) | **가능** | 파일 1개·i18n 키 재사용·값 무변경. 데이터·원장 의존 0 |
| 1순위 글로벌(S1 카드·GEO·경쟁사) | **조건부 가능** | 구멍 0·fold 0 누락·집계층 3문장 약 0.91s 로 경로는 준비됐다. 조건은 (a) D2 결정 (b) W5 실문장 EXPLAIN (c) 검증자 판정 |
| 1순위 웹사이트(S4 카드·배지·GEO) | **불가** | B1 미해소 상태에서는 코드가 맞아도 미러로 간다. D1-1 을 QA 전에 실행하면 가능해지지만, 재발 구조라 QA 당일 상태를 보장 못 한다 |
| S3/S6 인용, S2/S5 언급(3-2) | **불가** | 항상 미러였던 경로를 바꾸는 것이라 파급이 가장 크다. 별도 워크유닛·별도 승인 |
| 프롬프트 수 계열(D3) | **불가** | 설계 미확정 |

## 12. 기각한 안

1. **`statement_timeout` / 벽시계 예산 상향.** 증상을 가린다. 같은 상수의 주석이 이미
   "이 값을 올려서 느려진 문장을 덮지 마라"를 두 번 적어 두었고
   (`kpi-tab-budget.ts:38-40`·`:70-71`), 30일이 통과해도 60일·90일에서 같은 자리로 돌아온다.
2. **페이지에서 `cumulative` 를 떼기.** 산식이 스냅샷으로 되돌아가 2026-09-16 확정 의미론을
   깬다. 이노션 2026-09-15 신고(genesisnewseurope.com 인용 미표시)가 정확히 그 상태였다.
3. **미러 문장 자체 최적화.** 근본이 아니다. 같은 값을 집계층이 1/20 비용으로 이미 낸다
   (`kpi-tab-budget.ts:188-189`: 미러 29,175 ms vs 집계층 478 ms).
4. **기간 모드에서 세부층(단일 회차) 폴백 유지.** 틀린 숫자를 낳는다(§6-3).
5. **기간 모드를 무경계로 허용(기간 없는 `cumulative` 도 period).** 전 이력 회차가 집합에
   들어간다(§6-1 경고).
