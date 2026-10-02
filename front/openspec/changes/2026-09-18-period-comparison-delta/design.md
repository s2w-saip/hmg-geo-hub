# 설계: 기간 비교 Δ (GGMD-107)

기준 코드: 워크트리 `../hmg-geo-ggmd107`, 브랜치 `feat/GGMD-107-period-comparison`,
기준 sha **`5aa8c62`**(통합 프리뷰 head). `main` 은 `fe1de1d` 이고 기간 필터의 회차 앵커
축·2주간 프리셋은 **프리뷰에만** 있다.
실측은 전부 2026-09-17~18 라이브 미러(읽기 전용, `mcp__supabase-hmg`).

---

## 1. 창(window) 정의: 정본 수식

```
E  = 표면별 "최신 노출 회차 앵커일" (UTC 일, YYYY-MM-DD)
N  = 프리셋 길이(일): weekly 7 · biweekly 14 · monthly 30 · yearly 365

현재 창  cur  = [ E − (N−1) , E ]        (UTC 일, 양 끝 포함)
직전 창  prev = [ E − (2N−1) , E − N ]   (UTC 일, 양 끝 포함)
```

- **길이가 정확히 같다**(각 N일). 겹치지 않고 맞닿는다: `cur.lo − 1 = prev.hi`.
- 회차의 창 소속은 `cycle_anchor_at` 으로 판정한다(`measured_at` 아님).
- `minDay`(수집 시작일) 클램프는 **현재 창에만** 적용한다. 직전 창에 적용하면 길이가
  달라져 비교가 깨진다: 직전 창이 `minDay` 앞으로 삐져나가면 그것은 클램프 대상이
  아니라 **`start_window` 억제 대상**이다(§5).

### 1-1. 경계의 시간대: 멤버십은 UTC, 표시는 KST

| 축 | 채택 | 근거 |
| --- | --- | --- |
| 창 멤버십 판정 | **UTC 일** | 현행 코드가 전부 UTC다. `summary-cycles.ts:346` 은 명시적으로 `(date)::timestamp AT TIME ZONE 'UTC'`, 미러 `cumulativeRunWindow`(`scope-aggregates.ts:808`)는 `::date` = 세션 TZ(UTC). |
| 라벨·캡션 표시 | **KST** | `fe1de1d` 가 측정 기준일을 KST 달력 날짜로 옮긴 것과 정합. |

⚠️ 비대칭을 **의도적으로** 둔다. 멤버십까지 KST 로 옮기면 기존 기간 필터의 값이 바뀐다:
실측(노출 가능 회차): **웹사이트 178/713 = 25.0%**, 글로벌 2/16 = 12.5% 가 UTC 일과 KST 일이
다르다(앵커 시각 분포 00:00Z ~ 23:45Z). 멤버십 TZ 이동은 별도 변경으로 다룬다.

### 1-2. `E` 의 정의: **원장 술어 하나로 고정한다**

`E` = `max(cycle_anchor_at::date)` over
`summary_cycles` WHERE `surface = <표면>` AND `cycleViewableSql()` AND `active_generation_id IS NOT NULL`
(웹사이트는 `fleet_visible` 추가).

**두 개의 노출 술어가 있고, 웹사이트에서 3일 갈린다.** 실측(2026-09-17):

| 표면 | 원장 술어(`cycleViewableSql`) | 미러 술어(`excludeHiddenCycleRuns` 시간 규칙) |
| --- | --- | --- |
| global | **2026-09-13** | 2026-09-13 |
| website | **2026-09-11** | 2026-09-14 |

미러 술어는 `COALESCE(view_anchor_at, cycle_anchor_at + 표면지연) > now()` 로 **미발행
회차까지 노출**한다(`scope-aggregates.ts:2410` 주석: 의도된 이탈). 그 날짜를 `E` 로 잡으면
현재 창의 끝에 **화면에 값이 없는 꼬리**가 생긴다.

→ **결정: `E` 는 원장 술어로만 해소한다.** 끝점은 값이 아니라 **필터 축**이므로, 그 화면이
미러로 폴백하든 사실표를 읽든 **같은 창**이어야 한다.

### 1-3. 왜 "값의 창"도 함께 옮기는가 (핵심 판정)

확정 기획은 이미 **기간 = 회차 앵커 누적**이다:
`cumulativeMode(f, allRuns) = f.cumulative && allRuns !== true && (dateFrom || dateTo)`
(`scope-aggregates.ts:1148`), 그 안에서 창은 `cumulativeRunWindow` 가 `cycle_anchor_at` 으로 잡는다.
즉 **값의 창은 이미 앵커 축이고, "오늘 기준" 인 것은 프리셋이 만드는 `dateFrom/dateTo` 뿐**이다.

따라서 선택지는 둘이다.

| 안 | 내용 | 판정 |
| --- | --- | --- |
| **A (채택)** | 프리셋의 끝점을 `E` 로 옮긴다. 값·Δ 가 **같은 `(dateFrom,dateTo)`** 에서 파생 | **권장** |
| B | 값의 창은 오늘 기준 트레일링 유지, Δ 의 현재 창만 앵커 기준 | 기각 |

**B 기각 근거(실측).** 같은 화면에서 두 수가 갈린다: 오늘(KST 09-18) 기준 7일 창은
회차 `09-13` 하나라 값 **76.27%**(28,656/37,570)인데, 앵커 기준 7일 창은 `09-08`+`09-13` 이라
**74.57%**(56,033/75,138)다. 카드에 76.27% 를 찍고 그 옆에 "74.57 → 64.78, +9.80pp" 라고
쓰면 세 수 중 어느 것도 서로를 설명하지 못한다. A 는 이 구조를 원천 차단한다.

**A 의 대가**는 "기준일이 오늘이 아니다" 를 고객이 이해해야 한다는 것 하나뿐이고, 그것은
회차 앵커 축을 채택한 2026-09-16 결정이 이미 지고 있는 비용이다(화면의 "측정 기준일" 표기).

### 1-4. 전달 경로 (구현)

`presetRange(preset, today, minDay)` → `presetRange(preset, endDay, minDay)`.
`endDay` 는 서버가 내린다: `collectionStartDay`(서버 → `DimensionFilterPanel` → `minDay`,
`dimension-filter-panel.tsx:1410`)와 **같은 배선**에 `latestAnchorDay` 를 하나 더 얹는다.
`endDay` 가 없으면(원장 미적용·오류) **오늘로 폴백** = 종전 동작.

---

## 2. 지면별 데이터 경로: Δ 표시 전수 (2026-09-18 코드 실사)

렌더 지면 **12개**. 각 행의 "오늘의 Δ" 는 코드로 확인한 것이다.

| # | 지면 · 렌더 파일:줄 | 오늘의 Δ 산식 | Δ 원천 | 집계층 |
| --- | --- | --- | --- | --- |
| 1 | `/dashboard` KPI 카드 ①~⑤ · `dashboard/_components/overview-kpi-cards.tsx:279,322` | 값 있는 마지막 두 **day 버킷** 차 (`_data/live.ts:678`), 창은 기간 지정 시 그대로·미지정 시 30일 (`:660`) | `getLiveTrend` | ✅ `S1.dashboard` |
| 2 | `/dashboard` 카드 하단 **경쟁사 미니값** · `overview-kpi-cards.tsx:149,536,617` | `lastTwoDelta`: 브랜드 추이(week)·`firstPosition`(comp 축) 마지막 두 점 | `fetchStandardCompetitorSources` | ✅ `S1.competitors`(옵트인) |
| 3 | `/projects/[id]` 현황 타일 · `dashboard/_components/summary-tiles.tsx:135` | 같은 `applyTrendDeltas`, 단 **30일 바운드 없이** `filters` 를 그대로 day 추이에 넘긴다 (`projects/[id]/_data/live.ts:152`) → 기간 미지정이면 **전 이력** day 추이의 마지막 두 점 | `getLiveTrend(…, "day", projectId)` | ❌ (아래 실측) |
| 4 | `/website` Overview 타일 · `website/page.tsx:314` | **화면에 그리는 그 추이(week)에서 파생**(1회 호출). 버킷은 `readBucketParam` 이 **항상 week 로 고정**(`components/dash/measurement-basis.ts:6`) | `getLiveWebsiteTrend` | ✅ `S4.dashboard` |
| 5 | 글로벌 언급 4KPI **히어로**(노출률·점유율) · `kpi/mention-kpi-tab.tsx:217,262` | `subKpisPrevImpl` **누적 분기**: 페이지가 `cumulative: true` 를 **무조건** 건다(`mention/page.tsx:86`) → `Δ = 기간 누적 − 기간 첫 측정일까지의 누적` | `fetchStandardKpiHeroSubKpisPrev` | ⚠️ `S2.mention` 옵트인 off |
| 6 | 같은 히어로의 **경쟁사 미니카드** · `mention-kpi-tab.tsx:280` | `wowPp`: **추이 축 마지막 두 칸**(`kpi-view.ts:333`). #5 와 **원천이 다른데 캡션을 공유**한다 | `brandTrend` | ⚠️ |
| 7 | 경쟁사 KPI **테이블** "증감" 열 · `kpi/competitor-kpi-table.tsx:97` | 같은 `wowPp` | `brandTrend` | ⚠️ |
| 8 | 우호도 탭 히어로 · `kpi/favorability-kpi-tab.tsx:229` | #5 와 동일 구조·동일 키 | `…SubKpisPrev` | ⚠️ |
| 9 | 우선 노출도 탭 히어로·순위표 WoW · `kpi/first-rank-kpi-tab.tsx:200` · `kpi-view.ts:1083` | 회차 축 마지막 두 점(스냅샷 prev 를 안 쓴다: 순위 모수가 없어서) | `fetchStandardKpiFirstPosition` | ✅ `S1.firstPosition`(옵트인) |
| 10 | 인용 현황 "공식(당사) 인용 비중" Δ · `citations-standard-view.tsx:190,239` | #5 와 동일: `citation/page.tsx:67` 도 `cumulative: true` 강제 | `fetchStandardKpiHeroSubKpisPrev` | ✅ `S3.citation` |
| 11 | 같은 카드 "딜러 비중"·카테고리 바 Δ · `citations-standard-view.tsx:200,232` | **진짜 직전 측정일 스냅샷**: `cachedCitationCategoriesPrev`(`server.ts:1770`)가 `dateTo = days[1]` 로 고정하고 `cumulative` 를 **명시적으로 제거**한다 | `fetchStandardCitationCategoriesPrev` | (해당 없음) |
| 12 | 웹사이트·프로젝트 언급 요약 타일 · `answer-analysis/_components/mentions-view.tsx:319,403` | `subKpisPrevImpl` 누적 분기(두 페이지 다 `cumulative: true` 강제) | `fetchWebsiteSubKpisPrev`(`server.ts:3599`) · `fetchProjectSubKpisPrev`(`server.ts:2600`) | ⚠️ `S5.mention` off |

**범위 밖으로 판정한 것**: `/standard/ai-funnel/conversion` 의 "Lift"(`conversion-view.tsx:244`)는
시계열 Δ 가 아니라 **같은 기간 안 두 세그먼트(AI 유입 vs 일반 유입)의 횡단 차**다:
기간 비교가 아니므로 이 변경의 대상이 아니다. 경쟁사 표의 "당사 대비 Gap" 도 같은 이유로 제외.

**사(死) 코드**(앱이 import 하지 않는다, 테스트 전용): `components/kpi-card.tsx`(§10-2 참조) ·
`dashboard/_components/detail-table.tsx` 의 Δ 열.

**실측 주의: `project` 표면에는 노출 가능한 회차가 하나도 없다.** `summary_cycles`
surface='project' 147행 중 `view_anchor_at <= now() AND active_generation_id IS NOT NULL` 이
**0건**이다. 그래서 프로젝트 표면(#3·#12 의 프로젝트 쪽)은 `E` 자체를 해소할 수 없다 → §12 Q5.

### 2-1. 기간 필터의 URL 규약 (건드리지 않는다)

`?time=YYYY-MM-DD..YYYY-MM-DD`(`filter-encoding.ts:29 TIME_RANGE_SEP = ".."`), 한쪽만 채우면
open-ended. 인코더·파서가 **중립 모듈** 하나라 클라이언트(패널)와 서버(`standard-filters.ts:92`)가
같은 함수를 쓴다. 이 변경은 **인코딩을 바꾸지 않는다**: 프리셋이 만들어 넣는 날짜만 바뀐다.
그래서 고객이 캘린더로 직접 고른 임의 구간도 같은 규칙으로 비교된다(창 길이 `N = hi − lo + 1`).

---

## 3. 성능: 창을 넓히되 문장은 늘리지 않는다

Δ 를 위해 **집계를 한 번 더 돌리지 않는다.** 회차 축 사실표는 이미 회차별 분자·분모를
갖고 있으므로, **회차 집합을 N일에서 2N일로 넓히고 JS 에서 두 창으로 가르면 끝**이다.

### 3-1. EXPLAIN ANALYZE (프로덕션 미러, 2026-09-18)

두 창을 한꺼번에 덮는 60일 회차 축 읽기:

| 워크스페이스 | 창 | Execution | shared hit | 출력행 |
| --- | --- | --- | --- | --- |
| **글로벌**(root, 무필터) | 2026-07-16 ~ 09-13 | **94.256 ms** | 6,022 | 25,893 → 11 버킷 |
| **웹사이트 함대**(95 프로젝트) | 2026-07-14 ~ 09-11 | **11.009 ms** | 2,838 | 1,609 → 308 버킷 |

두 계획 모두 `summary_cycles_week_idx` → `summary_trend_own_gen` Nested Loop 로,
회차 수에 **선형**이고 조인 폭발이 없다. 창을 30 → 60일로 넓히는 비용이 곧 이 수치다.

(비교: 같은 화면의 미러 경로 언급 문장은 ~11 s 급이다. 그것을 두 번 돌리는 설계는 금지.)

### 3-2. 차원 필터가 걸린 상태

집계층 술어 `trendWhere`(`summary-trend-aggregates.ts:560`)가 지원하는 축:
`country/region` · `lang` · `brand(catalog_brands)` · `engine` · `funnelStage` · `listType` ·
`depth1` · `brandPresence(presence_set)` · 웹사이트 `websiteCountry` · 유닛 게이트(`report_fs`).
전부 집계층 **키**라 창을 넓혀도 같은 인덱스 경로다.

**지원 불가 2종**(`trendUnsupportedAxisReason` / `planTrendRead`):
`depth2`·`depth3`(집계층 키가 depth1 까지) · admin 임의 **다중 브랜드**(`own_variant` 밖).

### 3-3. 집계층을 못 타는 조합의 처리

→ **Δ 를 억제한다**(사유 `unsupported`). 미러로 두 창을 각각 집계하는 경로는 만들지 않는다.
근거: 그 경로의 비용이 정확히 이 설계가 피하려는 것이고, depth2/depth3 은 URL 파라미터
전용이라 **기본 경로에 걸리지 않는다**(집계층 주석의 같은 판단).

---

## 4. 집계층이 없는 표면(프로젝트): 추이 시리즈 파생

프로젝트 표면은 사실표 경로가 없고 노출 회차도 0이다. 여기서는 **이미 화면이 그리는
추이 시리즈에서 파생**한다(PR #179 가 되돌렸던 "Δ 를 화면 추이에서 파생" 과 같은 기법을,
이번에는 **창 대 창**으로 쓴다):

- 추이 버킷을 `cycle` 축(`cycleAnchorAt` 이 있는 버킷)으로 읽고,
- `cur` 창 버킷들의 분자·분모를 합산, `prev` 창 버킷들의 분자·분모를 합산해 나눈다.
- 버킷이 비율만 갖고 분자·분모를 안 실어 주면 **억제**(`unsupported`): 비율의 평균은 금지.

읽기 왕복은 **0회 증가**다(창만 2N일로 넓힌다).

---

## 5. 억제(suppression): 사유 enum·우선순위·창 길이별 임계

`feat/mom-delta` 의 4종을 **이름만 창 어휘로** 바꿔 그대로 쓴다.

```ts
export type PeriodSuppressionReason =
  | "no_prev_window"   // (mom: no_prev_month) 직전 창에 발행 회차 0
  | "no_data"          // 그 필터에서 데이터 회차 0 (어느 쪽 창이든)
  | "missing_share"    // 누락 비중 >= 0.30 : 30일·1년 창에만 적용
  | "start_window"     // (mom: start_month) 직전 창이 측정 시작 구간에 걸친다
  | "unsupported";     // 집계층 표현 불가(depth2·depth3·다중 브랜드): 신규
```

**우선순위**(mom `SUPPRESSION_PRECEDENCE` 를 그대로 + `unsupported` 를 맨 앞):

```
unsupported > no_prev_window > no_data > missing_share > start_window
```

`unsupported` 를 맨 앞에 두는 이유: 그 상태에서는 다른 사유를 **판정할 입력 자체가 없다**.

### 5-1. 누락 비중: 창 길이별 적용

```
missingShare = Σ expected_units (창 안 **미발행** 회차) / Σ expected_units (창 안 **전체** 회차)
억제 ⇔ missingShare >= 0.30   (경계 포함)
```

- 분자·분모는 **회차 원장 기준**(필터 무관): 필터를 좁히면 분모가 흔들리는 것을 막는다.
- **7·14일 창에는 적용하지 않는다**(제품 책임자 방향 2). 회차 1~3개짜리 창에서 30% 임계는
  회차 하나만 미발행이어도 곧바로 걸려, 억제가 기본값이 된다.
- 30일·1년에만 적용. 실측 근거는 §9 골든 G3(30일 직전 창 40.85% → 억제).

### 5-2. `start_window` 재정의 (브리프가 요구한 항목)

mom 조항 ⑤ 는 "직전 **달**이 측정을 시작한 달이면 억제" 이고, 유예는 **"그 달 첫째 주
7일"** 이었다(`MOM_START_WEEK_LAST_DAY = 7`). 달력 월이 없는 임의 창으로 옮긴다:

```
F = 그 필터 범위의 **첫 발행 회차 앵커일**
grace(N) = ceil(N / 4)        // 30일의 7일 ≈ N/4 → 7:2 · 14:4 · 30:8 · 365:92

start_window ⇔ F > prev.lo + grace(N)
```

읽는 법: "직전 창이 열린 뒤 `grace` 안에 첫 회차가 들어왔으면 온전한 창으로 본다.
그보다 늦게 시작했으면 그 창은 측정 시작 구간이라 비교하지 않는다."

- 대안 (a) 유예 없음(`F > prev.lo`): 엄격하지만 첫 창 다음 창까지 억제될 수 있다.
- 대안 (b) 유예 고정 7일: 7일 창에서 유예가 창 전체와 같아져 무의미해진다.
- `grace` 를 비례로 둔 것이 mom 의 의도(월의 첫 주 ≈ 창의 첫 1/4)를 유일하게 보존한다.

### 5-3. 억제 칩: **공용 프리미티브를 새로 만들어야 한다**

글리프는 **U+2015 HORIZONTAL BAR `―`** 다: `feat/mom-delta` 의
`lib/kpi/mom-view.ts:213 SUPPRESSED_GLYPH` 를 코드포인트로 재확인했다.
**U+2014 em dash(`\u2014`) 를 쓰지 않는다**(리포 금지 + mom 테스트가 양쪽에서 고정).

⚠️ **`components/kpi-card.tsx` 는 앱이 쓰지 않는다.** 이 브랜치에서 전수 확인 결과 그 파일을
import 하는 앱 코드가 **0건**이고 `DeltaChip` 의 유일한 사용처는 같은 파일 안(`:177`)이다.
`feat/mom-delta` 의 WU4 가 억제 상태를 그 컴포넌트에 넣었지만, **그대로 가져오면 화면에
아무것도 안 나온다.**

실제 Δ 칩 렌더러는 **6곳에 각자** 있다: `overview-kpi-cards.tsx` · `summary-tiles.tsx` ·
`kpi/kpi-bits.tsx`(+`kpi-hero.tsx`) · `kpi/competitor-kpi-table.tsx` ·
`citations-standard-view.tsx` · `mentions-view.tsx`.

→ **신규 `components/dash/delta-chip.tsx`** 를 공용 프리미티브로 만들고 6곳을 갈아끼운다
(WU-4). 억제 글리프·사유 캡션·`aria` 문구가 한 곳에 있어야 6개 지면이 갈리지 않는다.
`kpi-card.tsx` 는 이번 범위에서 **건드리지 않는다**(사 코드 정리는 별건).

---

## 6. 지표 유형: 건수형은 "회차당 평균" 이 아니라 **답변 1건당**

브리프의 "건수형 지표는 회차당 평균으로 환산" 을 **기각**하고 mom 의 per-answer 정규화를
채택한다.

| 유형 | 산식 | 단위 |
| --- | --- | --- |
| 비율 | `Σ분자/Σ분모` 끼리 차 | `%p` |
| 건수형 | `(Σ건수 / Σmonitored)` 끼리 증감률. 직전 0 이면 `null` | `%` |
| 순위형 | 평균 순위(`Σrank_sum/Σranked_answers`)의 절대 차 | `rank` |

**기각 근거(실측).** 웹사이트 표면의 30일 직전 창은 회차 수가 현재 창과 2.6배 다르고
(`4 × 95 = 380` project-cycle vs `25+7+6+1+24+5+24+23+31 = 146`), 회차 **크기**도 불균등하다
(한 앵커일의 참여 프로젝트가 1~95개). "회차당 평균" 은 회차 수에는 불변이지만 **회차
크기 변동은 그대로 먹는다**. per-answer 는 둘 다에 불변이고, 이미 구현·테스트돼 있다
(`summary-mom-aggregates.ts:444,448` 이 `denominator: monitored` 로 고정, 뮤턴트 테스트 T1).

### 6-1. 건수형 지표 목록

- 답변당 언급 수 (`own_mentions / monitored`)
- 답변당 인용 수 (`all_citations / monitored`)
- 웹사이트 자사 URL 수 · 타겟 URL 수 (GGMD-61 카드 2종): 같은 정규화

### 6-2. 범위 제외: ⑤ AI 인용 점유율

mom 이 제외한 것과 같은 이유로 제외한다: 집계층 `summary_trend_own.own_citations`(5.30%)와
화면 정본인 도메인 표(10.39%)가 다르다. 도메인 표 원천(`trend_domains` 회차 축)으로 재부착하는
것은 후속 워크유닛(WU-7)으로 뗀다.

### 6-3. `hidden_scope='citations'` 회차

인용 계열 분자·분모에서만 제외하고, 언급 계열에는 **남긴다**(`excludeHiddenCycleRuns` 의
`family` 규약과 동일). 실측으로 값이 크게 갈린다: §9 골든 G2 참조(4.18 %p).

---

## 7. `feat/mom-delta` 에서 가져올 것 / 일반화할 것

참고 워크트리 `../hmg-geo-mom`(`feat/mom-delta`, 미push, 읽기 전용).

**그대로 가져온다**: `ratio()` · `deltaOf()` · 단위 어휘(`pp`/`pct`/`rank`) ·
억제 enum·우선순위 · `momMissingShare` 의 계획단위 기반 산식 · 억제 칩 글리프/캡션 계약 ·
`scopeChanged`/`ledgerScopeMismatch` 불변식 · `inScopeProbe` 구조 게이트 · 테스트 3층 구조
(`*.test.ts` 순수 / `*.sql.test.ts` 컴파일 SQL / `*.int.test.ts` 실 DB).

**일반화가 필요하다** (달력 월 종속부):

| 종속부 | 위치(mom 워크트리) | 일반화 |
| --- | --- | --- |
| 월 키 `YYYY-MM` | `mom.ts:36` `MOM_TIME_ZONE` · `mom-view.ts:45` `momMonthKeyOf` · `summary-mom-aggregates.ts:106` `to_char(..., 'YYYY-MM')` | 기간 식별자를 **`(lo, hi)` UTC 일 쌍**으로. 월 버킷팅 SQL 자체를 제거하고 회차 축 합산으로 대체 |
| 월 1일 경계 | `summary-mom-aggregates.ts:108-112` `'-01'` 접합 + `interval '1 month'` | `lo::date` / `(hi::date + 1)` 반개구간 |
| 월 산술 | `mom.ts:77-84` `momMonthMinus` | 일 오프셋(`E − N` / `E − 2N + 1`) |
| 첫째 주 7일 | `mom.ts:60` `MOM_START_WEEK_LAST_DAY` · `momKstDayOfMonth` | `grace(N) = ceil(N/4)` (§5-2) |
| "전전월" 2단 판정 | `mom.ts:360` `judgeMomStartMonth` · `summary-mom-aggregates.ts:729` | "직전 창의 직전 창" 이 아니라 **첫 발행 앵커 `F`** 하나로 단순화(§5-2): 창을 3배로 읽지 않아도 된다 |
| 고정 월 쌍 | `mom-view.ts:57` `momMonthPair(now)` | `E`·`N` 에서 유도 |
| 월 형식 검증 | `summary-mom-aggregates.ts:98` `MONTH_RE` | `YYYY-MM-DD` 날짜쌍 검증 |

신규 모듈은 `lib/kpi/period-compare.ts`(순수) + `lib/db/repositories/summary-period-compare.ts`.
mom 모듈을 **수정하지 않는다**: 두 브랜치가 아직 머지되지 않았고, 공통화는 둘 다
main 에 들어온 뒤에 한다(그 전에 합치면 머지 충돌이 산식 한가운데를 지난다).

---

## 8. 캐시

- 셀 TTL = **600 s**(mom `MOM_CACHE_TTL` 선례). 공통 `MIRROR_CACHE_TTL = 7200`(`server.ts:706`)로
  두면 `E` 가 `view_anchor_at <= now()` **시계 이벤트**로 바뀌는데 최대 2시간 안 따라온다.
- 캐시 키에 **해소된 `E` 를 넣는다**. 필터(`dateFrom/dateTo`)는 이미 `JSON.stringify(args)` 로
  키에 들어가지만, `E` 는 프리셋을 거쳐 `dateTo` 가 되므로 **직접 URL 로 날짜를 넣은 요청**과
  프리셋 요청이 같은 키를 쓰게 된다. `E` 를 키에 실어 회차 공개 시점에 키가 갈리게 한다.
- 무효화 태그는 기존 `SUMMARY_TAG` 를 그대로 단다: 생성 러너의
  `POST /api/internal/summary/published` 가 즉시 반영 경로다.
- `MIRROR_CACHE_BASE_GENERATION` 은 **올리지 않는다.** 소스 해시가 자동으로 무효화한다
  (`MIRROR_CACHE_SOURCE_HASH`).

---

## 9. 골든 수치 (라이브 미러 실측, 2026-09-18 · 글로벌 표면 · 무필터 · `own_variant='ALL'`)

게이트: `run_status IN ('completed','partial_failed')` · `in_root_catalog=1` ·
`in_tagged_region=1` · `in_full_cycle=1` · `country <> 'ID'` · 원장 노출 술어.
`E = 2026-09-13`.

### G1: 7일 창 (AI 노출률 = tracked_answers / monitored)

| 창 | 범위(UTC) | 회차 | 분자 | 분모 | 값 |
| --- | --- | --- | --- | --- | --- |
| cur | 09-07 ~ 09-13 | 09-08, 09-13 | 56,033 | 75,138 | **74.5735 %** |
| prev | 08-31 ~ 09-06 | 08-31 | 24,336 | 37,570 | **64.7751 %** |

**Δ = +9.7984 %p → 표시 +9.8 %p.** 억제 없음(양쪽 창 누락 0).

### G2: 14일 창 (같은 지표) + 숨김 회차 계열 규약

| 창 | 범위(UTC) | 회차 | 분자 | 분모 | 값 |
| --- | --- | --- | --- | --- | --- |
| cur | 08-31 ~ 09-13 | 08-31, 09-08, 09-13 | 80,369 | 112,708 | **71.3073 %** |
| prev | 08-17 ~ 08-30 | 08-18, 08-19, **08-25** | 14,234 | 19,536 | **72.8604 %** |

**Δ = −1.5531 %p → 표시 −1.6 %p.**

`08-25` 는 `hidden_reason IS NOT NULL AND hidden_scope='citations'` 다. **언급 계열에는
포함**해야 한다: 빼면 prev 가 `7,616/9,886 = 77.0382 %` 가 되어 Δ 가 **−5.73 %p** 로
**4.18 %p 틀어진다**. 이 대조가 회귀 테스트다.

인용 계열(답변당 인용 수)에서는 같은 회차를 **뺀다**: cur `5.3553` / prev `14.8635`.

### G3: 30일 창 → **억제**

| 창 | 범위(UTC) | 데이터 회차 | 값(참고) | 계획 단위 | 미발행 단위 | 누락 비중 |
| --- | --- | --- | --- | --- | --- | --- |
| cur | 08-15 ~ 09-13 | 6 | 71.5367 % | 135,873 | 0 | 0 % |
| prev | 07-16 ~ 08-14 | 5 | 79.2608 % | 35,264 | **14,404** | **40.846 %** |

`40.846 % >= 30 %` → **`missing_share` 억제**. 억제를 끄면 Δ 는 −7.7241 %p.
미발행 2회차 = `07-19`(expected 7,769) · `07-24`(6,635): 둘 다 `closed` + 분석 갭 ~16.7 %
라 생성기가 영원히 뽑지 않는 회차다.

### G4: 1년 창 → **억제**

`prev = [2024-09-15, 2025-09-13]` 에 회차 0 → `no_prev_window`.
글로벌 첫 앵커 `2026-06-07`, 웹사이트 `2026-07-02`.

---

## 10. i18n 키 (ko / en): U+2014 금지

```
periodCompare.label.weekly      = "지난 7일 대비"        / "vs. previous 7 days"
periodCompare.label.biweekly    = "지난 14일 대비"       / "vs. previous 14 days"
periodCompare.label.monthly     = "지난 30일 대비"       / "vs. previous 30 days"
periodCompare.label.yearly      = "지난 1년 대비"        / "vs. previous year"
periodCompare.basis             = "▲▼ 증감은 선택한 기간({cur})과 바로 앞 같은 길이의 기간({prev})을 비교한 값입니다."
                                / "▲▼ Change compares the selected period ({cur}) with the immediately preceding period of the same length ({prev})."
periodCompare.window            = "현재 {curCycles}회차 / 직전 {prevCycles}회차 수집 기준"
                                / "Based on {curCycles} cycle(s) now vs {prevCycles} previously"
periodCompare.asOf              = "기준일 {date} (가장 최근 공개된 측정 회차)"
                                / "As of {date} (most recent published measurement cycle)"
periodCompare.reason.noPrevWindow  = "비교할 직전 {days}일 구간의 측정 회차가 없습니다"
                                   / "No measurement cycles in the preceding {days}-day period"
periodCompare.reason.noPrevYear    = "비교할 직전 1년 데이터가 없습니다"
                                   / "No data for the preceding year"
periodCompare.reason.noDataPrev    = "이 조건에서는 직전 기간에 수집된 데이터가 없습니다"
                                   / "No data collected in the preceding period under these filters"
periodCompare.reason.noDataCur     = "이 조건에서는 선택한 기간에 수집된 데이터가 없습니다"
                                   / "No data collected in the selected period under these filters"
periodCompare.reason.missingShare  = "직전 기간 수집분이 계획의 {pct}%에 그쳐 비교를 표시하지 않습니다"
                                   / "Only {pct}% of the planned collection completed in the preceding period, so no comparison is shown"
periodCompare.reason.startWindow   = "직전 기간이 측정을 시작한 구간이라 비교를 표시하지 않습니다"
                                   / "The preceding period overlaps the start of measurement, so no comparison is shown"
periodCompare.reason.unsupported   = "이 필터 조합에서는 기간 비교를 제공하지 않습니다"
                                   / "Period comparison is not available for this filter combination"
```

`yearly` 는 `noPrevWindow` 대신 `noPrevYear` 를 쓴다(고객 요청 문안, 제품 책임자 방향 4).
억제 칩 글리프는 i18n 이 아니라 `SUPPRESSED_GLYPH`(U+2015) 상수다.

### 10-1. 라벨 정정 (값 무변경, 별도 커밋)

**문구 전용 커밋으로 분리**해 값 diff 0 을 증명한다.

| 키 | 지금 문구 | 코드가 하는 일 | 판정 |
| --- | --- | --- | --- |
| `answerAnalysis.mentions.kpi.hero.deltaBasis` | "직전 측정일({date}) 스냅샷 대비" | 페이지가 `cumulative: true` 를 무조건 걸어 **항상 누적 분기**. `{date}` 는 "직전 측정일" 이 아니라 **그 범위의 첫 측정일**(기간 미지정이면 프로젝트 최초 측정일) | **불일치: 정정** |
| `answerAnalysis.citations.v2.status.deltaBasis` | 위와 같은 문구 | 같은 원인. 게다가 **같은 카드 안 두 Δ 의 기준이 다르다**: "공식(당사)" 은 누적 기준(#10), "딜러·카테고리" 는 진짜 직전 측정일 스냅샷(#11)인데 `{date}` 는 전자의 것을 쓴다 | **불일치: 두 문장으로 분리** |
| `dashboard.overview.compare` | "직전 회차 대비" | 축은 **day 버킷**이다. 한 회차가 여러 날에 걸쳐 드레인되면 회차와 갈린다: 미러 실측 `date(measured_at) ≠ date(cycle_anchor_at)` 이 **27.0%**(128,945/477,770, `scope-aggregates.ts:772`) | **부분 불일치: "직전 측정일 대비" 로 정정하거나 축을 회차로 옮긴다** |
| `dashboard.overview.competitorDeltaBasis` | "마지막 두 측정 **회차**의 차" | `S1.competitors` **on** 이면 맞고, **off**(기본)면 주 버킷이다 | **조건부 불일치: 키를 켜기 전까지 문구에 축 명시** |
| `answerAnalysis.mentions.summary.deltaBasis` | "기간 내 누적 기준: 기간 첫 측정일({date}) 시점의 누적과 비교" | 정확히 그렇게 동작한다 | **일치: 손대지 않는다** |
| `answerAnalysis.mentions.kpi.firstRank.deltaBasis` | "직전 회차 대비 평균 순위 변화" | 회차 축을 쓴다 | **일치** |

이 표는 MoM 플랜 §8 "결정 대기 4" 의 "라벨 불일치 4건" 을 코드로 재확인·확장한 것이다.
`mentions.summary.deltaBasis` 는 **불일치가 아니다**(플랜의 목록과 다른 결론).

---

## 11. 롤아웃

### 11-1. 스위치는 **하나**다

`summary_settings` 에 설정 `period_compare`(기본 off)를 두고, 이것이 **두 가지를 함께** 켠다:

1. 프리셋 끝점 `E` (값의 창)
2. 창 대 창 Δ 산식

둘을 따로 켤 수 있게 하면 §1-3 B 안의 불일치가 정확히 재현된다. 그래서 **하나로 묶는다.**

### 11-2. 왜 화면 키(`SUMMARY_SCREEN_KEYS`)가 아닌가

`S1.brandTrend`·`S2.mentionTrend`·`S1.competitors` 관례는 "**리더 경로**를 사실표로 바꿀 때"
쓰는 스위치다(`lib/summary/read/screens.ts`). 이 변경은 리더를 바꾸지 않고 **필터의 끝점**을
바꾼다: 미러 폴백 화면에서도 똑같이 적용돼야 한다. 화면 키에 얹으면 사실표를 타는 화면만
창이 옮겨가고 폴백 화면은 안 옮겨간다 = 화면 간 모수가 갈린다.

관례는 지킨다: **값이 바뀌므로 기본 off, 켜는 것은 운영 결정**이다(`SUMMARY_SCREEN_OPT_IN` 과
같은 자세). 프리뷰에서 켜는 경로는 env 오버라이드로 둔다: 프리뷰와 프로덕션이 같은
`summary_settings` 를 읽는지 **미확인**이다(MoM 플랜 §7 의 같은 미확인 항목).

### 11-3. 게이트

`data-impact: yes`. 스키마·쓰기 없음 → 백업·카나리 해당 없음.
사전 스냅샷 = 현행 Δ·값 표(화면 × 지표 × 표면 × 프리셋 4종), 사후 대조 = 프리뷰 화면 값과
독립 SQL(§9 골든) 대조. 집계 SQL 을 건드리므로 **프리뷰 실측이 통과 조건**이다
(2026-09-16 42883 사고: 단위 테스트가 SQL 경로를 안 탄다).

---

## 12. 확정 결정 (v2, 2026-09-19 제품 책임자)

v1 의 열린 질문 6건이 전부 닫혔다. 이노션 게이트는 **해제**됐다.

| # | 결정 | v1 권장과 같은가 |
| --- | --- | --- |
| Q1 | **a. 최신 공개 회차일 기준.** 창 끝점 `E` = §1-2 정의 그대로 | 같음 |
| Q2 | **b. 달력 월 프리셋 "이번 달/지난달" 을 신설하고 MoM 정책을 거기 붙인다** | **v1 권장 a 기각** → §13 |
| Q3 | **a. "지난 7일 대비" 계열** (기간 길이를 문구에 넣는다) | 같음 |
| Q4 | **웹사이트는 함대 회차일 하나.** 제품 책임자 원문: "전체 프로젝트가 회차일거라서, 회차 일자로 해야함". 결과는 v1 a 와 같되 **근거가 다르다**: '최대 앵커'가 아니라 **'함대가 공유하는 회차일'** 이다 (§13-4) | 결과 같음·근거 교체 |
| Q5 | **a. 프로젝트 표면 제외.** 노출 회차 0건 | 같음 |
| Q6 | **b. 적용일 이후만** | **v1 권장 a 기각** → §14 |

---

## 13. Q2b: 달력 월 프리셋 신설 + MoM 정책 이식

### 13-1. 프리셋 2종을 더한다

`TimePreset` (`dimension-filter-panel.tsx:1769`) 을 6종으로 넓힌다:

```ts
type TimePreset =
  | "weekly" | "biweekly" | "monthly" | "yearly"   // 창 비교 (N일)
  | "thisMonth" | "lastMonth";                     // 달력 월 비교 (MoM)
```

| 프리셋 | 범위(KST 달력 월) | 비교 대상 | 정책 계층 |
| --- | --- | --- | --- |
| `thisMonth` "이번 달" | 이번 달 1일 ~ **`E`** (진행 중이므로 부분 월) | **지난달 전체**(완결 월) | MoM |
| `lastMonth` "지난달" | 지난달 1일 ~ 말일 (완결 월) | **전전월 전체** | MoM |
| `monthly` "월간 (최근 30일)" | `[E−29, E]` | `[E−59, E−30]` | 창 비교 |

- 세 프리셋은 **공존**한다. 기존 `monthly`(최근 30일)를 그대로 두고 창 비교를 적용한다
  (고객의 GGMD-107 요구 문구가 "30일 선택 시 지난 동일 기간" 이라 이것이 그 요구의 대상이다).
- **30일 창의 누락 30% 규칙은 유지**한다(v1 §5-1 그대로). 실측 G3 가 그 규칙으로 억제된다.
- 달력 월 프리셋에는 창 비교의 `start_window`(§5-2 `grace(N)`) 대신 **MoM 의 `start_month`**
  (전전월 데이터 유무 2단 판정 + 신규 인입 **첫째 주 7일**)를 쓴다. 두 규칙은 배타다.

### 13-2. 월 경계 (KST)

```
thisMonthLo = KST 이번 달 1일          thisMonthHi = E
lastMonthLo = KST 지난달 1일           lastMonthHi = KST 지난달 말일
beforeLo    = KST 전전월 1일           beforeHi    = KST 전전월 말일
```

월 소속은 `cycle_anchor_at AT TIME ZONE 'Asia/Seoul'` 의 연·월이다
(mom `MOM_TIME_ZONE`). 실측(2026-09-17, 전 표면 1,028 회차): **월이 바뀌는 회차 0건**
(날짜만 밀리는 회차 208). 그래서 §1-1 의 "멤버십은 UTC" 비대칭이 달력 월에서는 **무해**하다.

⚠️ `thisMonth` 는 `E` 로 끝난다. 월초 며칠은 `E` 가 아직 지난달에 있어 **이번 달 회차 0**
이 될 수 있다(회차 공개 = 앵커 + 표면 지연). 그때는 `no_data`(cur) 억제 + 캡션.
`thisMonth` 프리셋 자체를 숨기지는 않는다.

### 13-3. MoM 정책을 어디서 가져오는가: **정책은 이식, 읽기는 일반화**

`feat/mom-delta`(`b07b133`, `../hmg-geo-mom` 읽기 전용)의 MoM 기여는 8커밋
(`359b8db`·`dbcb6fd`·`a4f1b65`·`7259361`·`763716a`·`b07b133`·`0816b53`·`47829a7`)이지만,
그 브랜치는 `main`(`fe1de1d`) 기준 201파일이 달라 **체리픽은 쓰지 않는다**:
`lib/scope/server.ts`·`messages/*.json`·`lib/summary/read/screens.ts` 가 이 프리뷰 브랜치에서
크게 움직였다. **파일 단위 이식**으로 간다.

#### (A) 그대로 복사 (신규 파일 6, 테스트 포함 11)

| 파일 | 줄 | 처리 |
| --- | --- | --- |
| `lib/kpi/mom.ts` + `mom.test.ts` | 479 + 615 | **복사 후 개명** → `lib/kpi/calendar-month-compare.ts`. 공용 타입은 `period-compare.ts` 에서 import 로 교체 |
| `lib/kpi/mom-view.ts` + `mom-view.test.ts` | 291 + 504 | 복사. `SUPPRESSED_GLYPH`(U+2015)는 `period-compare-view.ts` 로 **올려** 한 곳에 둔다 |
| `lib/summary/read/mom-flag.ts` + test | 46 + 44 | 복사(화면 키 env 오버라이드 판정) |
| `scripts/db/enable-mom-delta-screen.sql` | 88 | 복사 |
| `lib/scope/server.mom-gate.test.ts` | 273 | 복사 후 신규 게이트 이름으로 수정 |

#### (B) 이식하지 않는다 (일반화로 대체)

**`lib/db/repositories/summary-mom-aggregates.ts`(795줄) + 두 테스트(1,206줄)는 가져오지 않는다.**

그 파일은 `to_char(cycle_anchor_at AT TIME ZONE 'Asia/Seoul','YYYY-MM')` 로 **월 버킷팅**을 하는데,
§15 의 `readComparePeriods` 는 **임의 `(key, lo, hi)` 목록**을 받는다. 달력 월은 그 목록의
원소 셋(`before`·`prev`·`cur`)일 뿐이다. 두 벌을 유지하면 게이트 술어(`trendWhere`)가
두 곳에서 갈린다. 이 리포가 반복해서 값을 튀어나가게 만든 형태다.

→ **읽기 계층은 하나, 정책 계층은 둘**(창 비교 / 달력 월). 이 판정이 하루 일정을 가능하게 한다.

#### (C) 사(死) 코드로 들어간 부분의 대체

`feat/mom-delta` 는 억제 칩을 `components/kpi-card.tsx:119 DeltaChip` 에 넣었는데
**그 파일은 앱이 import 하지 않는다**(§5-3 실측). 그 42줄 diff 는 **버린다.**
대체물은 이 change 가 만드는 **`components/dash/delta-chip.tsx`** 하나이고,
`mom-delta-line.tsx`(57줄)도 그 칩을 쓰도록 고쳐서 복사한다.

| mom 브랜치 산출 | 이 change 에서 |
| --- | --- |
| `components/kpi-card.tsx` 의 `suppressed` 분기 | **폐기** → `components/dash/delta-chip.tsx` |
| `components/dash/mom-delta-line.tsx` | 복사 + 칩 import 교체 |
| `components/dash/mom-delta-line.render.test.tsx` | 복사(U+2015 vs U+2014 대조 테스트가 이 change 의 수용 기준이기도 하다) |

#### (D) 기존 파일에 손으로 다시 얹을 것 (4곳)

1. `lib/scope/server.ts`: `fetchCalendarMonthCompare` + 캐시 셀(TTL 600). 시그니처는 §15
2. `lib/summary/read/screens.ts`: 화면 키 `S2.momDelta` 를 `SUMMARY_SCREEN_KEYS` + `SUMMARY_SCREEN_OPT_IN` 에
3. `messages/{ko,en}.json`: `momDelta.*` 키 블록(라벨 1 + metric 6 + caption 11 + note 1)
4. `app/[locale]/(dash)/standard/answer-analysis/{mention,citation}/page.tsx`: 줄 배선

### 13-4. Q4 근거 교체: '함대 회차일'

제품 책임자 원문 "전체 프로젝트가 회차일거라서, 회차 일자로 해야함". 실측이 이를 뒷받침한다:
최근 4회차(`08-21`·`08-28`·`09-04`·`09-11`)는 **95개 프로젝트 전원이 같은 앵커일**을 공유한다.
그래서 `E` 는 "여러 프로젝트 앵커의 최대값"(우연히 큰 값을 고르는 것)이 아니라
**"함대가 공유하는 회차일"** 이다. 7월분처럼 앵커가 프로젝트마다 갈리는 과거 구간에서는
그 정의가 성립하지 않으므로, 구현은 `max` 로 하되 **주석에 이 근거를 남기고**
"함대 앵커 일치율" 을 진단 신호로 노출한다(불일치 시 로그 1줄).

---

## 14. Q6b: "적용일 이후만" 의 정의

### 14-1. 판정 입력 = **현재 창의 끝점**

```
적용 ⇔ cur.hi >= PERIOD_COMPARE_EPOCH
```

- `PERIOD_COMPARE_EPOCH` 는 **상수 1곳**: `lib/kpi/period-compare.ts`.
  운영이 바꿀 수 있게 `summary_settings.period_compare_epoch` 가 있으면 그것이 이긴다.
- 프리셋이든 캘린더 직접 지정이든 **같은 술어**다. 적용일 이전 구간을 직접 조회하면
  **종전 Δ** 가 그대로 나온다 = 기발행 리포트가 재현된다.

| 안 | 술어 | 판정 |
| --- | --- | --- |
| **a (채택)** | `cur.hi >= EPOCH` | **권장** |
| b | `prev.lo >= EPOCH` | 기각: 적용 직후 30일(1년 프리셋은 2년)간 새 산식이 아예 안 보인다 |
| c | `now() >= EPOCH` | 기각: 과거 구간 직접 조회에도 새 산식이 걸려 "적용일 이후만" 이 무의미해진다 |

### 14-2. 분기 코드는 **1곳**

`lib/scope/server.ts::fetchPeriodCompare` 진입부에서만 본다:

```
if (cur.hi < epoch) return null;     // 화면은 종전 Δ 경로를 그대로 쓴다
```

`null` 을 돌려주면 **화면은 기존 Δ 를 그린다**(오늘의 코드 경로 그대로). 그래서
분기가 12개 지면으로 퍼지지 않고, 억제 사유 `before_epoch` 는 **내부 진단용**으로만 쓴다
(칩에 "―" 를 그리지 않는다. 고객에게는 종전 Δ 가 보인다).

⚠️ `epoch` 는 §8 캐시 키에 **넣지 않는다**(상수다). 설정으로 바꾸면
`POST /api/internal/summary/published` 로 무효화한다.

---

## 15. 인터페이스 고정 (빌더 착수용. 이 절은 계약이다)

기술 리드가 데이터 담당에게 **결정 무관부**를 먼저 착수시켰다. 아래 시그니처를
v2 가 바꾸지 않는다는 것이 계약이다. 달력 월(Q2b)은 **이 타입들 위에 얹힌다.**

```ts
// lib/kpi/period-compare.ts  = 순수, DB·테넌트 비의존
export type CompareUnit = "pp" | "pct" | "rank";
export type CompareKind = "window" | "calendarMonth";

export type CompareMetricKey =
  | "visibility" | "share" | "favorability" | "position"
  | "mentionsPerAnswer" | "citationsPerAnswer";

export type SuppressionReason =
  | "unsupported"     // 집계층 표현 불가(depth2·depth3·다중 브랜드)
  | "no_prev"         // 직전 구간에 발행 회차 0   (v1 no_prev_window 를 개명)
  | "no_data"         // 그 필터에서 데이터 회차 0
  | "missing_share"   // 누락 비중 >= 0.30
  | "start_window"    // 창 비교 전용 (grace(N))
  | "start_month";    // 달력 월 전용 (MoM 조항 ⑤)
// 우선순위: unsupported > no_prev > no_data > missing_share > start_window|start_month
// (`before_epoch` 는 사유가 아니다. 게이트웨이가 null 을 돌려주므로 여기 오지 않는다)

export interface CompareMeasure { numerator: number; denominator: number; }

export interface CompareLedger {
  plannedUnits: number;            // Σ expected_units (구간 안 전체 회차)
  missingUnits: number;            // Σ expected_units (미발행 회차)
  publishedCycles: number;
  dataCycles: number;
  firstPublishedAnchor: string | null;   // 'YYYY-MM-DD' | null
}

export interface ComparePeriod {
  key: string;                     // 창: 'YYYY-MM-DD..YYYY-MM-DD' · 월: 'YYYY-MM'
  lo: string; hi: string;          // UTC 일, inclusive
  measures: Partial<Record<CompareMetricKey, CompareMeasure>>;
  ledger: CompareLedger;
}

export interface CompareResult {
  metric: CompareMetricKey;
  unit: CompareUnit;
  prev: number | null; cur: number | null; delta: number | null;
  suppressed: boolean;
  reason: SuppressionReason | null;
  cyclesPrev: number; cyclesCur: number;
  plannedPrev: number; plannedCur: number;
}

export const MISSING_SHARE_MAX = 0.30;          // 경계 포함(>=)
export const PERIOD_COMPARE_EPOCH = "2026-09-08"; // 제품 책임자 09-18: 09-19 면 첫 적용 회차 공개(~09-23)까지 전 지면 null
export function graceDays(days: number): number;               // ceil(days/4)
export function missingShare(l: CompareLedger): number;
export function resolveWindows(endDay: string, days: number):
  { cur: { lo: string; hi: string }; prev: { lo: string; hi: string } };
export function computeCompare(
  prev: ComparePeriod, cur: ComparePeriod,
  opts: { kind: CompareKind; days?: number; before?: ComparePeriod;
          metrics: readonly CompareMetricKey[] },
): CompareResult[];
```

```ts
// lib/db/repositories/summary-period-compare.ts  = 읽기 하나가 두 정책을 먹인다
export async function resolveWindowEnd(
  surface: "global" | "website", projectIds: string[],
): Promise<string | null>;                      // = E (UTC 일) · null = 해소 불가

export async function readComparePeriods(scope: {
  surface: "global" | "website";
  filters: StandardFilters;
  ownVariant: string; ownedBasePrefixes: string[];
  unitFlags?: boolean; excludedUnits?: number[];
  family: "mention" | "citation";               // 기본값 없음 (hidden_scope 규약)
  windows: readonly { key: string; lo: string; hi: string }[];
}): Promise<Map<string, ComparePeriod> | null>; // null = 집계층 불가 → unsupported
```

**달력 월은 `windows` 에 3원소를 넣는 것으로 끝난다** (`before`·`prev`·`cur`).
창 비교는 2원소다. 읽기 문장 수는 둘 다 **2개**(원장 1 + 사실표 1)로 같다.

```ts
// lib/scope/server.ts
export async function fetchPeriodCompare(
  filters: StandardFilters,
  opts: { surface; family; kind: CompareKind; days?: number;
          metrics: readonly CompareMetricKey[] },
): Promise<CompareResult[] | null>;             // null = 종전 Δ 를 그려라
```

**빌더가 지금 착수해도 안전한 것**(결정 무관): `resolveWindows` · `missingShare` ·
`graceDays` · 비율/건수형/순위형 산식 · 억제 우선순위 · `readComparePeriods` 의
회차 축 SQL · `resolveWindowEnd`.
**v2 가 더한 것**(나중에 얹힘): `kind: "calendarMonth"` 분기 · `before` 입력 ·
`start_month` 판정 · `PERIOD_COMPARE_EPOCH` 게이트.

## 16. 미확인 (실측하지 못한 것)

- GGMD-107 Jira 첨부 이미지 2장: **미열람**. Q3=a 로 문안이 정해져 블로커는 아니다.
- 프리뷰와 프로덕션의 `summary_settings` 공유 여부: **미확인**(§11-2).
- 웹사이트·프로젝트 표면의 골든 수치: **미산출**(글로벌만 §9 에 고정).
- 달력 월(`thisMonth`/`lastMonth`) 골든: **미산출**. `feat/mom-delta` 의
  `summary-mom-aggregates.int.test.ts` 가 2026-07/08/09 실측 골든을 갖고 있으므로
  이식 시 그 수치를 `readComparePeriods` 위에서 재현해 대조한다(동치 증명).
- 미러 폴백 경로에서 두 구간을 각각 집계했을 때의 소요: **미측정**(그 경로를 안 만든다).
