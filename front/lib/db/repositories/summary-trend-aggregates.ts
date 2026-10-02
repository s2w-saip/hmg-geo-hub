import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  resolveHmgBrandName,
  trackedEntityIdsFor,
  trackedRosterFor,
} from "@/lib/scope/hmg-brands";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import {
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
  registrableDomainOfHost,
} from "@/lib/geo-catalog/owned";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { summaryCountryGeoPred } from "@/lib/db/repositories/website-geo-pred";
import { citationCyclesOf, type CycleSet } from "@/lib/summary/read/cycle-set";
import { budgetedMirrorDb, type AnswerSetBudget } from "@/lib/db/repositories/scope-aggregates";
import { columnKnownAvailable, ensureColumnAvailability } from "@/lib/db/column-availability";
import { mirrorHeavyBudget } from "@/lib/scope/kpi-tab-budget";

// ════════════════════════════════════════════════════════════════════════════
// 집계층 리더 코어 — 표면 공통 4표, 대시보드 1회 렌더에 **문장 4개** (PR② T4)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: 플랜 `internal-kb/hmg-geo-perf-pr2-aggregate-layer-plan-2026-09-10.md`
//   §3-3(조회 규칙) · §3-4(화면 값 판정표) · §4-1(지연 산정) · §4-2(인덱스) · §6-2 · §9 T4.
// 스키마 정본: `lib/db/migrations/0059_summary_tables.sql`(집계층 4표) +
//   `0065_summary_aggregate_layer.sql`(own 확장 7컬럼 · `*_read` 조회 인덱스).
// 행 의미 정본: `lib/summary/generate/fold.ts` 머리 주석(T2 접기).
//
// ── 이 파일이 존재하는 이유 ─────────────────────────────────────────────────
//
// 오늘의 사실표 리더(`summary-global-aggregates.ts`·`summary-website-aggregates.ts`)는
// 세부층(셀 그레인)을 읽고 **`summary_answers` 와 job 조인**을 한다. 2026-09-10 라이브
// 실측에서 그 조인 하나가 223 ms → **3,943 ms** 를 만들었다(플랜 §0-2 · §2-3 X1/X2).
// 집계층은 키 그룹이 필터 축을 전부 들고 있어 그 조인이 필요 없고, `count(DISTINCT …)`
// 는 생성 시각에 int 로 굳어 있다. 그래서 이 리더는 **굳혀진 행을 고르고 SUM 과
// 나눗셈만** 한다 — 판정은 하지 않는다.
//
// ── 문장 4개 (수용 기준 ①) ──────────────────────────────────────────────────
//
//   1. `summary_trend_own`     GROUPING SETS ((), (engine), (country))
//        카드 ①~⑤ · Sub-KPI · 엔진 일관성 배지 · **지역 롤업**. 글로벌 ≈6,100행 스캔.
//   2. `summary_trend_answers` GROUPING SETS ((), (funnel_catalog), (depth1), (engine), (country))
//        모수 · 퍼널 도넛 · 주제 도넛(답변 그레인) · 엔진/국가별 모수.
//   3. `summary_trend_brands`  GROUPING SETS ((brand_name), (country, brand_name))
//        브랜드 타일 + 순위표 + GEO 경쟁. **같은 표를 두 번 스캔하지 않는다**(§3-3 규칙 3).
//   4. `summary_trend_domains` GROUPING SETS ((group_key), (domain), ())
//        카테고리 도넛 + 출처 도넛 + ⑤ 분모(전체 인용).
//
// ── 라운드 2 (0066 이후) 에서 바뀐 것 셋 ────────────────────────────────────
//
//   1. **술어 2개가 들어왔다** — `brandPresence` → `presence_set &&`(0061 정본과 동치),
//      웹사이트 유닛 게이트 → `report_fs <> 0` + 제외 유닛 배제. 라운드 1에서 이 둘이
//      각각 "글로벌 branded 모수 21.4% 손실" 과 "S4~S6 기본 경로 100% 폴백" 을 만들었다.
//      **이제 폴백 사유에서 빠졌다.**
//   2. **⑤ 분자의 정본이 `trend_domains` 로 옮겨졌다.** `trend_own.own_citations` 는
//      생성 시각에 (변형, country, lang) 스코프를 한 행으로 확정해 굳힌 값이라,
//      국가·언어를 **안 고른** 화면에서 오늘 값과 갈린다(글로벌 무필터 실측 5.39% vs
//      10.03%). 도메인 표는 `matched_base`·`base_norm_null`·`domain` 을 전부 키로 갖고
//      있어 오늘 리더와 **구조적으로 같은 FILTER** 를 걸 수 있다 — 그래서 그쪽이 정본이고
//      `own_citations` 는 감사값으로 남는다. 문장 수는 그대로다(출처 도넛과 같은 스캔).
//   3. **페이로드를 절단한다.** 글로벌 무필터 한 렌더가 30,210행·5,955 KB 였다 →
//      11,865행·1,988 KB(**−67%**). 잘린 몫은 버리지 않고 `is_rest` 행으로 합쳐 보내
//      분모(총언급·전체 인용)와 개수(고유 브랜드·도메인 수)가 보존된다.
//
// ── 라운드 3 에서 바뀐 것 넷 ────────────────────────────────────────────────
//
//   1. **`only` 선택자** — `readTrendAggregates(scope, { only: [...] })`. 위젯이 안 쓰는
//      표를 읽지 않는다. 수용 기준 ①("≤ 4")은 **함수당**이지 화면당이 아니다: S4 실측에서
//      위젯 3개가 각자 4문장을 내 렌더당 12문장이 됐다. `only` 로 aggregates=3 · 출처=1 ·
//      GEO=1 = **5문장**, 축 옵션으로 GEO 를 aggregates read 에 합치면 **4문장**이다.
//   2. **선택 축**(`axes`) — 회차(`cycle`) · 브랜드×엔진(`engineBrand`) ·
//      도메인×국가(`domainCountry`/`domainCountryGroup`). 축은 GROUPING SET 을 늘릴 뿐
//      **문장 수를 늘리지 않는다**. 기본은 전부 off = 라운드 2와 같은 문장.
//   3. **`empty` 결함 수리** — `GROUPING SETS ((), …)` 는 입력 0행에도 합계 행 1개를
//      내므로 "행이 0개인가" 판정이 **절대 발화하지 않았다**(없는 generation 으로 읽어도
//      own 1행·`empty=false` 실측). 접기 안 된 회차가 0 으로 그려질 위험이었다.
//      이제 각 표가 `key_rows`(그 그룹이 읽은 집계층 행 수)를 함께 내고 그것으로 판정한다.
//   4. **`trendWhere`·`ownedCitationExpr` 공개** — 리더가 안 주는 축이 필요한 호출부의
//      탈출구. 다만 원칙은 "리더가 축을 준다" 이고, 반복해서 필요하면 `axes` 로 올려라.
//
// 병합하지 않은 것이 하나 있다: **프롬프트 수 계열**(측정·미언급·주제별)은 집계층에
// 없다(§3-4 16·17). prompt 는 (engine, country) 키 그룹을 **가로지르므로** 집계층의
// `prompts_measured`·`prompts_tracked` 를 그룹 간 SUM 하면 이중 계상이다. 그래서 이
// 리더는 그 두 컬럼을 **아예 SELECT 하지 않는다** — 실수로 더할 수 없게 하는 것이
// 주석보다 강한 방어다. 화면의 프롬프트 수는 세부층 `summary_answers` 에서 온다
// (실측 48 ms, X4 — 예외 아님).
//
// ── 회차 술어 (T9 계약 ①) ───────────────────────────────────────────────────
//
// 항상 `(cycle_id, generation_id)` **쌍**이다. `summary_cycles` 를 다시 조인하지
// 않는다 — generation 이 읽기 시점에 재해석되면 게이트가 판정한 회차와 조회가 읽는
// 회차가 갈라진다. 집계층 행의 `generation_id` 는 **재생성마다 바뀐다**(집계층은
// 파티션이 아니라 DELETE→INSERT 로 갈린다) — 그래서 쌍 술어가 세부층보다 더 중요하다.
//
// 그 위에 **중복이지만 인덱스에 맞는** 술어를 하나 더 얹는다:
//   `surface = $s AND cycle_anchor_at BETWEEN $from AND $to AND project_id = ANY($p)`
// 0065 의 `summary_trend_*_read (surface, cycle_anchor_at, project_id, country, engine)` 는
// 선두가 `surface`·`cycle_anchor_at` 이다. 쌍 IN 만으로는 그 인덱스를 못 타므로,
// 집합에서 뽑은 anchor 범위를 명시해 스캔 진입점을 만든다. 값 의미는 안 바뀐다 —
// 범위 안이지만 집합 밖인 회차는 쌍 IN 이 거른다.
//
// ⚠️ 2026-09-10 EXPLAIN 실측 결론(글로벌 `74eca7fb` · 웹사이트 `a3204f07`, 각 3회):
//    플래너가 실제로 고르는 것은 표면마다 다르다 — 웹사이트는 `*_read`(4/4 문장),
//    글로벌은 **`*_gen (cycle_id, generation_id)`**(4/4 문장, 0065 블록 ③의 "정리 전용"
//    인덱스)다. 회차를 하나만 읽는 조회에서는 2컬럼 쌍이 가장 좁으므로 합리적이다.
//    0059 `*_pick` 는 **어느 표면에서도 안 뽑혔다**(통계가 낡았을 때 한 번 뽑힌 것이
//    전부). 그래서 셋 다 남겨 둔다 — 제거 판정은 기간 모드(회차 N개) 실측 뒤로 미룬다.
//
// **`cycle_week` 는 걸지 않는다.** 세부층 6표는 주 파티션이라 프루닝이 필수였지만
// (그래서 T9 계약 ②의 `dateArray()` 스칼라 펼침 규칙이 있다), 집계층 4표는
// `relkind='r'`·파티션 아님(0065 머리 주석 실측)이라 프루닝할 대상이 없다. 안 거는
// 것이 바인드 2개를 아끼고 date[] 직렬화 함정을 통째로 피한다. 세부층을 함께 읽는
// 2단 조회(§3-4 18·19)를 이 파일에 더한다면 그때는 `dateArray(set.weeks)` 가 필요하다.
//
// ── 모수 (T9 계약 ③) ────────────────────────────────────────────────────────
//
// `set.projectIds` 다. `set.missingProjectIds` 를 미러 값으로 메우지 않는다.
//
// ── 빈 집계층 = 폴백 (플랜 §5-2) ───────────────────────────────────────────
//
// 행이 0개인 것은 "측정 대기" 가 아니라 **접기가 안 돌았다**는 뜻이다. 0 으로 그리면
// 고객이 "성과가 0" 으로 읽는다. `readTrendAggregates` 는 `empty: true` 를 함께
// 돌려주고, 호출부(T5~T8)는 그것을 폴백 신호로 쓴다.

const num = (v: unknown): number => Number(v ?? 0);

// ── 스코프 ──────────────────────────────────────────────────────────────────

export interface TrendReadScope {
  /** T9 `resolveCycleSet` 이 판정한 회차 집합. 표면·모수·anchor 가 전부 여기 있다. */
  set: CycleSet;
  filters: StandardFilters;
  /**
   * 읽을 `own_variant` 키. `planTrendRead` 가 정한다 — **`null` 이면 이 리더를 부르지
   * 않는다**(집계층 밖 = E4 폴백).
   */
  ownVariant: string;
  /**
   * `$sel`·`$fbRe` 원본 — 게이트웨이의 `ownedBasePrefixesForScope(축E, 국가, 언어)` 결과.
   *
   * **글로벌 ⑤ 분자·`is_ours` 의 정본이다**(라운드 2). 오늘 리더
   * (`summary-global-aggregates.ts::ownedCitationExpr`)와 같은 두 갈래 판정을 집계층에
   * 그대로 건다 — `matched_base`·`base_norm_null`·`domain` 이 전부 `trend_domains` 키에
   * 있으므로 세부층과 **구조적으로 동일한 FILTER** 다. 웹사이트는 이 값을 쓰지 않고
   * 굳힌 `unit_owned_citations` 를 쓴다(아래 `unitFlags`).
   */
  ownedBasePrefixes: string[];
  /**
   * 웹사이트 유닛 경로(0060)를 쓸 수 있는가 — `summaryUnitFlagsAvailable()` 결과 그대로.
   * 두 가지를 동시에 켠다(라운드 2, 0066 이후):
   *   ① **모수 게이트** — `report_fs <> 0`(0 = 미부여 sentinel) + 제외 유닛 배제.
   *      오늘 리더의 `report_fs IS NOT NULL` + `report_fs <> ALL($excluded)` 와 같은 뜻이다.
   *   ② **⑤ 분자·`is_ours` 소스** — `trend_domains.unit_owned_citations`.
   * 글로벌 표면에서는 무시된다(세부층 `report_fs` 가 전량 NULL → 집계층 전량 0).
   */
  unitFlags?: boolean;
  /** `summary_settings.website_excluded_fs` — `unitFlags` 일 때만 적용. */
  excludedUnits?: number[];
  /**
   * 페이로드 절단(라운드 2). 라운드 1 실측에서 글로벌 무필터 한 렌더가
   * **domains 21,043행 · brands 9,043행**을 실어 날랐다 — EXPLAIN 의 Execution Time 에는
   * 안 잡히지만 직렬화·전송에서 되돌아온다.
   *
   * 절단은 **잘라내고 끝내지 않는다** — 잘린 몫을 `axis:"…-rest"` / `brandName: null`
   * 한 행으로 합쳐 함께 돌려주므로, 분모(share 계산)와 개수(고유 도메인 수)가 보존된다.
   * `null` = 절단 없음(라운드 1과 바이트 동일).
   */
  limits?: TrendLimits;
  /**
   * **선택 축**(라운드 3). 기본값은 전부 off — 켜지 않으면 라운드 2와 **바이트 동일**한
   * 문장이 나간다(회귀 0). 축 하나당 GROUPING SET 이 늘 뿐 **문장 수는 그대로**다.
   */
  axes?: TrendAxes;
  /**
   * **브랜드 표만** 이 이름 집합으로 좁힌다(2단 조회의 2단, PR③).
   *
   * 왜 필요한가: 글로벌 `trend_brands` 의 회차 축은 13회차에서 500k~800k행이라
   * 그대로 읽으면 500~800 ms 다(PR③ 플랜 §3-4 외삽). 화면이 실제로 그리는 것은
   * 시리즈 브랜드 10개뿐이므로, **스냅샷(최신 회차)에서 top-N 을 먼저 고르고**
   * 그 이름으로만 회차 축을 읽는다 — PR② E2(도메인 top-80 2단)와 같은 패턴이다.
   *
   * ⚠️ 좁히면 **잔여 행(`is_rest`)의 의미가 바뀐다** — 절단이 아니라 "고르지 않은
   *    브랜드" 가 되므로 총언급 분모로 쓰면 안 된다. 분모는 `trend_own.comp_mentions`
   *    에서 가져와라(회차 축이 있고 브랜드로 좁혀지지 않는다).
   * ⚠️ 이름은 **표시명**(`brand_name`)이다 — `brand_id` 가 아니다. 집계층이 표시명으로
   *    그룹핑하고 화면 시리즈도 표시명이라 축이 일치한다.
   */
  brandNames?: readonly string[];
  /**
   * **추이 격자 판본**(`X.trendGrid`, 설계 §4-A). 켜면 글로벌 3게이트 중
   * `in_full_cycle` **하나만** 빠진다 — 나머지 둘(`in_root_catalog`·`in_tagged_region`)은
   * 제품 정의라 그대로다.
   *
   * ── 왜 추이에서만 빼는가 ────────────────────────────────────────────────
   *
   * `in_full_cycle` = "그 프롬프트가 과거에 측정된 적 있는 모든 셀을 이 회차가 전부
   * 다시 돌았는가" 다(`scripts/summary/global-predicates.ts::fullCycleCte`). 미러의
   * **7일 롤링 창 스냅샷**을 위해 만들어진 술어이고, 그 자리에서는 부분 리프레시를
   * 신구 주기 혼합으로 보고 빼는 것이 옳다. 회차 축으로 옮기면 전제가 두 번 깨진다:
   *   ① 회차가 이미 한 번의 측정 주기다 — 회차 안에서 신구가 섞이지 않는다.
   *   ② 분모가 **생성 시점의 미러 이력**에 의존한다 — 같은 회차도 언제 생성했느냐에
   *      따라 값이 달라진다(과거 회차를 나중에 백필하면 미래 셀이 기대치에 든다).
   * 결과는 과거 자리의 분모가 줄어드는 것이고, 그 부분집합은 무작위 표본이 아니다
   * (완전 커버는 재측정이 없었던 프롬프트에 치우친다).
   *
   * 폭은 자리마다 다르다(메인 실측 2026-09-20, 게이트 제거 전후 분모):
   * 08-17 332 → 1,539(**4.6배**) · 08-10 742 → 1,259(**1.7배**) ·
   * 08-03 2,602 → 2,640(**1.015배**) · 08-24 18,662 → 18,716 · 08-31 37,570(무변화).
   * 초판이 적었던 "1/10~1/20" 은 **분모가 아니라 셀 수**(창 안 셀/기대 셀
   * 08-17 2,445/23,843)를 인용한 것이라 근거가 못 된다. 과거 분모를 가장 크게 자르는
   * 것은 이 게이트가 아니라 **지역 스코핑**(2026-08-20 한국어 비KR 제외, 08-17
   * 4,233 → 1,539)과 **카탈로그 게이트**(5,893 → 4,233)이고, 둘 다 추이에서도
   * 유지된다 — 이 조각을 빼도 미러 라이브 값까지 회복되지는 않는다.
   *
   * ⚠️ **스냅샷 카드는 그대로다.** 카드 리더(`summary-global-aggregates.ts`)는 이 필드를
   *    세우지 않는다 — "최신 회차의 상태" 에서는 완전 커버 요구가 여전히 합리적이고,
   *    그 자리를 함께 옮기는 것은 별도 승인이다(설계 §4-2).
   * ⚠️ 웹사이트 표면은 **무관**하다: 생성기가 `in_full_cycle = 1` 고정으로 굳히고
   *    (`scripts/summary/surface-website.ts:386`) 조회도 글로벌 분기에서만 건다.
   *
   * **`true` 만 받는다**(`boolean` 아님) — `false` 를 실을 수 있게 두면 꺼진 경로의
   * 스코프 객체가 달라져 "끄면 바이트 동일" 이 관측 불가능해진다.
   */
  trendGrid?: true;
  /**
   * **카탈로그 도입 전 회차** id 목록(제품 책임자 2026-09-20 지시 ① — "6월 자리를 채워라").
   *
   * 이 목록에 든 회차는 `in_root_catalog`·`in_tagged_region` 두 게이트를 **적용하지
   * 않는다** = 그 회차가 측정한 프롬프트 전체가 모수다. 판정·근거·왜 dim 으로 못
   * 하는지는 `summary-pre-catalog-cycles.ts` 머리 주석이 정본이고, 여기서는 그 결과를
   * **소비만** 한다(같은 목록을 미러 폴백도 읽는다 — 두 경로가 갈리지 않는 근거).
   *
   * `trendGrid` 가 없으면 무시한다. 비었으면 술어가 종전과 **바이트 동일**이다.
   */
  preCatalogCycleIds?: readonly string[];
  /**
   * **글로벌 ⑤ 분자용 공식(HMG) group_key 목록**(제품 책임자 2026-09-29).
   *
   * 있으면 `domains` 문장이 모든 grouping set 에 `official_citations` 열
   * (`sum(citations) FILTER (WHERE group_key = ANY($keys))`)을 더 싣는다 — 회차 축이 켜져
   * 있으면 회차별 값이 **추가 스캔·추가 행 없이** 나온다.
   *
   * 목록은 JS 분류기(`lib/kpi/official-hmg-citations.ts::officialHmgGroupKeys`, 카테고리
   * 차트와 같은 함수·같은 오버라이드)가 **이 집합의 group_key 전수**
   * (`readSummaryGroupKeyUniverse`)에서 고른 것이다. SQL 에 분류 규칙이 없다 — 분류는
   * 한 벌뿐이고 여기는 그 결과를 받기만 한다.
   *
   * 없으면 열도 없다(종전과 **바이트 동일** — website 표면·기존 호출부).
   */
  officialGroupKeys?: readonly string[];
}

export interface TrendAxes {
  /**
   * 회차 축 — `own`·`answers` 에 `(cycle_anchor_at)` 와 `(cycle_anchor_at, engine)` 을 더한다.
   *
   * 추이 화면(회차 N개 집합)이 **회차마다 문장을 발행하는 것**을 막으려고 있다. 회차 집합
   * 술어는 이미 N개를 한 번에 읽으므로, 여기서 회차를 그룹핑 축으로 세우면 시계열이
   * **1문장**에서 나온다(문장 N×4 → 4).
   *
   * ⚠️ **웹사이트 추이의 x축 의미가 바뀐다.** 오늘 `fetchWebsiteTrend` 는 **주(week) 버킷**
   *    이고 이 축은 **회차(anchor) 버킷**이다. 한 주에 회차가 둘이면 점이 둘로 갈리고,
   *    회차가 없는 주는 점이 사라진다. 리더는 회차 버킷만 낼 수 있다 — 주 버킷으로 접는
   *    것은 호출부의 선택이다(`cycleAnchorAt` 로 주를 계산해 합치면 된다).
   *    어느 쪽을 화면에 낼지는 **T5 후속 결정**이며 이 파일은 능력만 제공한다.
   */
  cycle?: boolean;
  /**
   * `brands` 에 `(engine, brand_name)` 을 더한다.
   *
   * 왜 브랜드 표인가: Sub-KPI 의 `negativeMentions`(엔진별 당사 부정 언급)를 낼 다른 길이
   * 없다 — `summary_trend_own` 에는 `own_positive`·`own_signals` 만 있고 **`own_negative` 가
   * 없다**(0059). 스키마를 넓히지 않고 내려면 브랜드 표에서 당사 행의 `negative` 를
   * 엔진별로 합하는 수밖에 없다.
   */
  engineBrand?: boolean;
  /**
   * `brands` 에 `(cycle_anchor_at, brand_name)` 를 더한다 — **브랜드별 회차 시계열**.
   *
   * `cycle` 축은 `own`·`answers` 만 회차로 가른다(모수·①~⑤ 시계열). 브랜드 라인차트
   * (`fetchStandardKpiBrandTrend`)와 우선노출도 버킷(`fetchStandardKpiFirstPosition`)은
   * **브랜드 × 회차**가 필요한데 그 축이 없어 회차마다 문장을 내야 했다(PR③).
   *
   * ⚠️ 절단은 **축마다 독립**이다 — `limits.brand` 가 회차별 top-N 으로 걸린다. 창 전체
   *    상위 브랜드가 특정 회차의 top-N 밖이면 그 회차의 점이 빠진다(차트는 선이 끊긴다).
   *    기본 200 이면 실무상 안 걸리지만, 호출부가 시리즈 cap 보다 넉넉히 잡아야 한다.
   */
  cycleBrand?: boolean;
  /**
   * `domains` 에 `(cycle_anchor_at)` 을 더한다 — **회차별 인용 분모·분자**(⑤ 시계열).
   *
   * ⑤ 분자의 정본이 `trend_domains` 이므로(위 `ownedCitationsAgg` 주석) 추이의 ⑤ 도
   * 여기서 나와야 카드와 같은 값이 된다. `trend_own.own_citations` 는 생성 시각에
   * (변형, country, lang) 로 굳힌 감사값이라 무필터 화면에서 갈린다.
   */
  cycleDomain?: boolean;
  /**
   * `domains` 에 `(country)` 와 `(country, group_key)` 를 더한다.
   *
   * GEO 패널이 인용 분모·분자를 **국가별로** 필요로 하는데, 그 값을 얻으려고 국가마다
   * 리더를 다시 부르면 문장이 국가 수만큼 는다. 축으로 세우면 한 스캔에서 나온다.
   *
   * 이것과 `engineBrand`·`only` 를 합치면 **카드와 GEO 가 한 read 를 공유**할 수 있다:
   * 종전에는 카드가 `own`+`brands`+`domains` 를, GEO 가 `brands` 를 따로 읽어
   * `trend_brands` 를 두 번 스캔했다(글로벌 실측 ≈235 ms × 2). GEO 가 필요로 하는
   * `(country, brand_name)`·`(country)` 가 이미 카드 쪽 문장의 grouping set 이므로,
   * 호출부는 **read 한 번**을 두 위젯이 나눠 쓰면 된다(§3-3 규칙 3 의 연장).
   */
  domainCountry?: boolean;
  /**
   * `domains` 에 `(country, group_key)` 까지 더한다(`domainCountry` 를 함축).
   *
   * ⚠️ **비싸다.** 국가 45 × 카테고리 그룹이라 글로벌 무필터에서 도메인 문장의 출력이
   * 10,616행 → **40,436행**, 소요 172 ms → **361 ms**, 페이로드 1,988 KB → 7,997 KB 로
   * 뛴다(2026-09-10 실측). "국가별 인용 총량" 만 필요하면 `domainCountry` 만 켜라 —
   * 그쪽은 국가 수(45행)라 사실상 공짜다. 이 축은 "국가 × 카테고리" 화면이 실제로
   * 생겼을 때만 켠다.
   */
  domainCountryGroup?: boolean;
}

const axesOf = (scope: TrendReadScope): Required<TrendAxes> => ({
  cycle: scope.axes?.cycle === true,
  engineBrand: scope.axes?.engineBrand === true,
  cycleBrand: scope.axes?.cycleBrand === true,
  cycleDomain: scope.axes?.cycleDomain === true,
  domainCountry: scope.axes?.domainCountry === true || scope.axes?.domainCountryGroup === true,
  domainCountryGroup: scope.axes?.domainCountryGroup === true,
});

export interface TrendLimits {
  /** 출처 도넛 — 인용 수 상위 N 도메인(§3-4 19 "집계층 top-80"). 기본 80. */
  domain?: number | null;
  /**
   * 카테고리 축(`group_key`). **기본 null = 절단 없음.**
   * 카테고리 매핑(`COALESCE(override, rule)`)이 조회 시각 파생이라(§3-4 10) 여기서 접으면
   * 꼬리의 카테고리가 통째로 사라진다 — 매핑을 SQL 로 내리기 전까지는 자르지 않는다.
   */
  group?: number | null;
  /** 브랜드 타일·순위표 — 언급 수 상위 N. 기본 200(화면 상한 top-20 의 10배 여유). */
  brand?: number | null;
  /** GEO 경쟁 — 국가당 상위 N 브랜드. 기본 20. */
  geoBrandPerCountry?: number | null;
}

const DEFAULT_LIMITS: Required<TrendLimits> = {
  domain: 80,
  group: null,
  brand: 200,
  geoBrandPerCountry: 20,
};

const limitsOf = (scope: TrendReadScope): Required<TrendLimits> => ({
  ...DEFAULT_LIMITS,
  ...(scope.limits ?? {}),
});

// ── 미지원 축 판정 + `own_variant` 선택 ─────────────────────────────────────

/**
 * `own_variant` 선택 규칙 — **필터 브랜드 조합 → 변형 key**.
 *
 * 생성기(T3)는 명부 스냅샷에서 변형 목록을 유도해 굳힌다(플랜 §3-2 실측 R2:
 * `ALL` · `Hyundai` · `Kia` · `Genesis` = 4개). 리더는 그 목록에서 **하나를 고른다**.
 * 고르는 입력은 리더 ①③④가 오늘 쓰는 것과 **같은 함수**여야 한다 —
 * `trackedRosterFor(contextBrand ?? brand, ownEntities)`(= `trackedEntityIdsFor` 의 몸통).
 * 다른 함수로 고르면 화면이 "그 변형" 이라고 믿는 것과 굳혀진 entityIds 가 갈린다.
 *
 * 규칙:
 *   · 좁혀지지 않았다(선택 없음 · 교집합 공집합 폴백 · 3사 전부) → `ALL`
 *   · 정확히 한 브랜드로 좁혀졌다 → 그 브랜드의 정본 표기(`resolveHmgBrandName`)
 *   · 두 브랜드 이상(admin 임의 조합) → **`null`**  ← 폴백 신호(E4, 플랜 §3-5)
 *
 * R2 의 두 실측 락이 이 규칙으로 자동 처리된다: `Hyundai+Genesis+Kia` 는 `ALL` 과
 * 같은 집합이라 `ALL`, 오타 락 `HYNDAI+KIA` 는 교집합이 비어 `intersectOrFallback`
 * 이 명부 전체로 폴백하므로 역시 `ALL` 이다.
 *
 * ⚠️ **T3 와의 결합**: 여기서 만드는 키 문자열과 T3 가 굳히는 `own_variant` 값은
 *    같은 어휘여야 한다(`ALL` + 명부 브랜드 정본 표기). `ALL` 은 `fold.ts` 의
 *    `OWN_VARIANT_ALL` 을 import 해 한 곳으로 묶었고, 브랜드 키는 양쪽이 같은
 *    `resolveHmgBrandName` 을 쓴다는 계약이다. 어긋나면 조회가 0행이 되고
 *    `readTrendAggregates` 의 `empty` 가 폴백으로 잡는다(조용히 0 이 되지 않는다).
 */
export function resolveOwnVariantKey(filters: StandardFilters): string | null {
  const brandFilter = filters.contextBrand ?? filters.brand;
  const roster = filters.ownEntities;
  const full = trackedRosterFor(undefined, roster);
  const selected = trackedRosterFor(brandFilter, roster);
  if (selected.length === full.length) return OWN_VARIANT_ALL;
  const names = new Set(selected.map((e) => resolveHmgBrandName(e.name) ?? e.name));
  if (names.size === 1) return [...names][0] as string;
  return null;
}

/**
 * 집계층으로 표현 불가능한 축 — 있으면 **폴백**이다(값이 조용히 달라지는 것보다 느린 쪽).
 *
 * 게이트(`lib/summary/read/gate.ts`)의 `unsupported*FilterReason` 과 **다른 층**이다:
 * 그쪽은 "사실표(세부층)로 표현 가능한가", 여기는 "**집계층**으로 표현 가능한가".
 *
 * ── 라운드 2에서 **둘이 닫혔다**(0066 이 키를 넓혔다) ───────────────────────
 *
 * | 닫힌 축 | 라운드 1에 막던 것 | 지금 |
 * | --- | --- | --- |
 * | `brandPresence` | 글로벌 branded 모수의 **21.4%**(8,294/38,748)가 스칼라 `brand_presence_resolved` 에서 안 보였다 | `presence_set && ARRAY[$want]` — 0061 정본과 동치 |
 * | 웹사이트 유닛 게이트 | **S4~S6 기본 경로 100% 폴백**(`unitFlags` 는 라이브에서 항상 true) | `report_fs <> 0` + 제외 유닛 배제 · ⑤ 분자는 `unit_owned_citations` |
 *
 * ── 남은 것은 하나뿐 ────────────────────────────────────────────────────────
 *
 * | 축 | 왜 | 판단 |
 * | --- | --- | --- |
 * | `depth2`·`depth3` | `trend_brands`/`_domains`/`_own` 키가 `depth1` 까지다(0059 PK, D11). `trend_answers` 만 갖는다 | **넓히지 않는다.** §2-2 실측상 depth 축이 브랜드 키 카디널리티를 지배하고(119,949 ↔ 80,765), URL 파라미터 전용이라 **기본 경로에 안 걸린다** |
 *
 * `own_variant` 밖(admin 임의 브랜드 다중 선택)은 축이 아니라 변형 문제라
 * `planTrendRead` 가 따로 판정한다(E4).
 */
export function trendUnsupportedAxisReason(
  scope: { surface: "global" | "website"; filters: StandardFilters; unitFlags?: boolean },
): string | null {
  const f = scope.filters;
  if (f.depth2?.length) return "unsupported-agg:depth2";
  if (f.depth3?.length) return "unsupported-agg:depth3";
  // `brand-presence` · `website-unit-flags` 는 **0066 으로 닫혔다**(라운드 2).
  // `presence_set`·`report_fs` 가 집계층 키에 들어와 술어로 표현된다(`trendWhere`).
  return null;
}

export type TrendReadPlan =
  | { ok: true; ownVariant: string }
  | { ok: false; reason: string };

/**
 * 집계층을 읽어도 되는가 + 어느 변형을 읽는가. 회차 판정(T9)·화면 게이트가 끝난
 * **뒤에** 부른다 — 여기는 "이 필터를 집계층 키로 표현할 수 있나" 한 층만 본다.
 */
export function planTrendRead(scope: {
  surface: "global" | "website";
  filters: StandardFilters;
  unitFlags?: boolean;
}): TrendReadPlan {
  const axis = trendUnsupportedAxisReason(scope);
  if (axis) return { ok: false, reason: axis };
  const variant = resolveOwnVariantKey(scope.filters);
  // E4 — admin 임의 브랜드 다중 선택. 세부층 두 문장(조인 없음)으로 가는 경로다.
  if (!variant) return { ok: false, reason: "unsupported-agg:own-variant" };
  return { ok: true, ownVariant: variant };
}

// ── 바인드 ──────────────────────────────────────────────────────────────────
//
// 배열은 전부 **`sql.param` 한 개**로 넘긴다(수용 기준 ②: 컴파일 SQL 바인드 ≤ 30).
// 스칼라 펼침(`ARRAY[$1,$2,…]`)은 웹사이트 함대 95 프로젝트에서 문장당 수백 개의
// 바인드를 만들어 계획 재사용을 막았다(PR① B4-a). `uuid[]`·`text[]`·`int[]` 는
// `sql.param` 배열이 안전하다 — **`date[]`·`timestamptz[]`·`numeric[]` 만** drizzle
// 직렬화기 함정이 있고(T9 계약 ②), 이 파일은 그 셋을 배열로 넘기지 않는다.

const textArray = (vals: readonly string[]): SQL => sql`${sql.param([...vals])}::text[]`;
const uuidArray = (vals: readonly string[]): SQL => sql`${sql.param([...vals])}::uuid[]`;

/** ⑤·`is_ours` 판정의 `$sel` — 세부층 `matched_base` 와 같은 정규형. */
function selectedBases(prefixes: string[]): string[] {
  return [...new Set(prefixes.map(ownedBasePrefixFromUrl).filter(Boolean))] as string[];
}

// `$fbRe` — base 정규화가 불가능했던 행(`base_norm_null = 1`)의 도메인 서픽스 폴백.
// 규칙 정본은 `scope-aggregates.ts` 의 ownedDomainPatternFor/ownedFallbackDomains
// (export 가 없다). 사본이 이미 셋(글로벌 리더·웹사이트 리더·`lib/summary/tenant/hmg.ts`)
// 이고 이것이 **넷째**다 — 규칙을 바꾸면 넷을 함께 고쳐야 한다.
function ownedFallbackDomains(basePrefixes: string[]): string[] {
  const out = new Set<string>();
  for (const p of basePrefixes) {
    const norm = normalizeOwnedBaseUrl(p);
    if (!norm) continue;
    const d = registrableDomainOfHost(norm.split("/")[0] ?? "");
    if (d) out.add(d);
  }
  return [...out];
}
function ownedDomainPatternFor(domains: string[]): string | null {
  if (domains.length === 0) return null;
  return `(^|\\.)(${domains.map((d) => d.replace(/\./g, "\\.")).join("|")})$`;
}

/**
 * `is_ours` / ⑤ 상세의 owned 판정 — 두 갈래. **공개 export**(라운드 3, `trendWhere` 와 같은 이유). 글로벌·웹사이트 리더의
 * `ownedCitationExpr` 와 **같은 형태**여야 집계층과 세부층이 대조된다.
 */
export function ownedCitationExpr(ownedBasePrefixes: string[]): SQL {
  const sel = selectedBases(ownedBasePrefixes);
  const pattern = ownedDomainPatternFor(ownedFallbackDomains(ownedBasePrefixes));
  const byBase = sel.length
    ? sql`(matched_base <> '' AND matched_base = ANY(${textArray(sel)}))`
    : sql`false`;
  const byDomain = pattern
    ? sql`(base_norm_null = 1 AND domain ~* ${pattern})`
    : sql`false`;
  return sql`(${byBase} OR ${byDomain})`;
}

// ── 술어 ────────────────────────────────────────────────────────────────────

/**
 * 회차 집합 술어. 바인드는 회차가 1개든 95개든 **6개 고정**이다.
 *
 * ── 왜 세미조인이 아니라 등치·`ANY` 인가 (0067 조사, 2026-09-10 라이브 확정) ──
 *
 * 라운드 3까지는 쌍 의미론을 **세미조인**으로 썼다:
 *   `(cycle_id, generation_id) IN (SELECT p.c, p.g FROM unnest($1, $2) AS p(c, g))`
 * 의미는 정확했지만 **플래너가 확장 통계를 쓰지 못한다** — `st_summary_trend_*_cyc_gen`
 * (0062/0065 의 dependencies·ndistinct·mcv)은 **단일 릴레이션 + 상수인 restriction
 * clause 에만** 적용되고 세미조인에는 안 붙는다. 그래서 선택도가 단일 컬럼 ndistinct 의
 * 곱으로 붕괴했다: `summary_trend_brands` 136,930 ÷ (96 × 96) = **15행 추정**(실제 85,961,
 * 약 1.4만 배 과소). 그 추정에서는 104 MB 짜리 `*_pkey`(19컬럼, `catalog_brands`·
 * `presence_set` 배열 포함)가 제일 싸 **보였고**, 그래서 매번 그것이 뽑혔다.
 *
 * 상수 등치로 펴면 확장 통계가 붙어 추정이 119,983(실제 120,081)로 돌아오고, S1 3문장이
 * **814.7 → 414.1 ms** 가 된다(0067 하네스 실측).
 *
 * ⚠️ **`ANY` 를 덧붙이고 쌍 IN 을 남기면 더 나빠진다**(est 4). 세미조인 **자체**를 없애야 한다.
 *
 * ── 쌍 정확성이 유지되는 근거 (불변식) ─────────────────────────────────────
 *
 * 기간 모드는 `cycle_id = ANY($c[]) AND generation_id = ANY($g[])` 라 문법상으로는
 * **교차곱**이다 — `(cycle_i, generation_j)`(i≠j) 조합도 술어를 통과한다. 그것이
 * 안전한 이유는 데이터에 그런 행이 **존재할 수 없기** 때문이다:
 *
 *   집계층은 파티션이 아니라 접기(`lib/summary/generate/fold.ts`)가
 *   **`DELETE … WHERE cycle_id = $c` → `INSERT`** 로 갈아끼운다(fold.ts 규율 1).
 *   그래서 한 회차에 남는 generation 은 **정확히 1개**이고, generation_id 는 uuid 라
 *   두 회차가 공유하지 않는다. 따라서 `$c[] × $g[]` 의 교차곱 중 **실재하는 조합은
 *   대각선(진짜 쌍)뿐**이다.
 *
 * 2026-09-10 라이브 실측으로 확인했다(집계층 4표 전부, `cycle_id` 당 distinct
 * `generation_id` 최대 1 · `generation_id` 당 distinct `cycle_id` 최대 1).
 * `summaryTrendGenerationInvariantSql` 이 그 감사 쿼리이고, 형태 테스트가 술어 모양을 고정한다.
 *
 * 불변식이 깨지는 유일한 창은 **재생성 경합**(접기가 도는 중에 읽기)인데, 그때는 게이트가
 * 준 generation 의 행이 아직/이미 없어 **행 0 → `empty` → 폴백**이다. 조용히 틀린 수가
 * 아니라 느린 정답으로 떨어진다(손실 비대칭 — 이 파일의 기본 자세).
 *
 * ── 인덱스 진입점 ──────────────────────────────────────────────────────────
 * `surface` + `cycle_anchor_at BETWEEN` + `project_id` 는 값 의미를 바꾸지 않는 **중복**
 * 술어다(범위 안이지만 집합 밖인 회차는 위 등치가 거른다). 0065 `*_read` 의 선두
 * 컬럼이라 스캔 진입점을 만든다.
 */
function cycleScope(set: CycleSet): SQL {
  // 회차가 0개면 읽을 것이 없다. 인용 계열 스코프가 창 안 회차를 **전부** 빼는 경우가
  // 유일한 실현 경로이고(0071 회차만 남은 창), 그때 아래 `reduce` 는 빈 배열에서 던진다.
  if (set.cycles.length === 0) return sql`false`;
  const anchors = set.cycles.map((c) => c.cycleAnchorAt);
  // ISO-8601 UTC 문자열은 사전순 = 시간순이라 min/max 를 그대로 쓴다.
  const from = anchors.reduce((a, b) => (a < b ? a : b));
  const to = anchors.reduce((a, b) => (a > b ? a : b));
  const cycleIds = [...new Set(set.cycles.map((c) => c.cycleId))];
  const generationIds = [...new Set(set.cycles.map((c) => c.generationId))];
  // 스냅샷(회차 1개) = 상수 등치. 확장 통계가 붙는 유일한 형태다.
  const pair =
    cycleIds.length === 1 && generationIds.length === 1
      ? sql`cycle_id = ${cycleIds[0]}::uuid AND generation_id = ${generationIds[0]}::uuid`
      : sql`cycle_id = ANY(${uuidArray(cycleIds)}) AND generation_id = ANY(${uuidArray(generationIds)})`;
  return sql`surface = ${set.surface}
    AND cycle_anchor_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
    AND project_id = ANY(${uuidArray(set.projectIds)})
    AND ${pair}`;
}

/**
 * 회차 집합의 **group_key 전수** — 글로벌 ⑤ 분자용 공식(HMG) 키 목록의 후보다
 * (`TrendReadScope.officialGroupKeys`).
 *
 * 술어는 **회차 스코프뿐**이다(필터·게이트 없음). 그래서 결과는 필터와 무관하고, 같은
 * 집합을 읽는 모든 필터 조합이 한 목록을 공유한다(캐시 키 = `set.cycleKey`). 필터·게이트를
 * 거친 어떤 부분집합의 키도 이 목록 안에 있다 — 분자 FILTER 는 "있는 키만 센다" 이므로
 * 상위집합이면 충분하다.
 */
export function summaryGroupKeyUniverseSql(set: CycleSet): SQL {
  // 도메인 문장과 **같은 회차 목록**(인용 계열 = `citationCyclesOf`)을 본다 — 그 목록은
  // `set.cycles` 밖 회차를 담을 수 있다(N3, `citationScopeOf` 주석).
  return sql`SELECT DISTINCT group_key FROM summary_trend_domains
    WHERE ${cycleScope({ ...set, cycles: citationCyclesOf(set) })}`;
}

export async function readSummaryGroupKeyUniverse(set: CycleSet): Promise<string[]> {
  const db = budgetedMirrorDb(getDb(), mirrorHeavyBudget("summaryRead"));
  const rows = (await db.execute(summaryGroupKeyUniverseSql(set))) as unknown as Array<{
    group_key: string | null;
  }>;
  return rows.map((r) => r.group_key).filter((k): k is string => !!k);
}

/**
 * 위 불변식("회차당 집계층 generation 1개")의 **감사 쿼리**. 읽기 전용이고, 운영·하네스가
 * 정기적으로 돌려 술어의 전제가 살아 있는지 확인한다. 위반 행이 나오면 기간 모드의
 * `ANY × ANY` 가 남의 generation 행을 빨아들일 수 있다는 뜻이다 — 그 즉시 세미조인
 * 판본으로 되돌리거나 접기를 고쳐야 한다.
 */
export function summaryTrendGenerationInvariantSql(): SQL {
  const parts = [
    "summary_trend_answers",
    "summary_trend_brands",
    "summary_trend_domains",
    "summary_trend_own",
  ].map(
    (t) => sql`
      SELECT ${t} AS tbl,
             max(gens_per_cycle)::int AS max_gens_per_cycle,
             max(cycles_per_gen)::int AS max_cycles_per_gen
      FROM (
        -- 안쪽이 이미 DISTINCT (cycle_id, generation_id) 라 창 함수는 count(*) 로 충분하다
        -- (count(DISTINCT ...) OVER 는 PostgreSQL 미구현 — 2026-09-10 실측 0A000).
        SELECT count(*) OVER (PARTITION BY cycle_id)     AS gens_per_cycle,
               count(*) OVER (PARTITION BY generation_id) AS cycles_per_gen
        FROM (SELECT DISTINCT cycle_id, generation_id FROM ${sql.raw(t)}) d
      ) x`,
  );
  return sql.join(parts, sql` UNION ALL `);
}



/**
 * funnel 축 컬럼 — **`funnel_catalog` 하나뿐**이다(§6-2 대시보드 열).
 *
 * 플랜 §6-2 는 "인용 화면만 COALESCE" 라고 적지만, 오늘의 코드에는 그 COALESCE 가
 * 없다: 미러 인용 경로도 2026-08 에 카탈로그 어휘로 옮겨졌고(`scope-aggregates.ts:3423-3424`
 * "종전에는 scope_prompts.funnel_stage 기준이라 대시보드 KPI 와 어휘가 갈렸다"),
 * 사실표 리더 둘의 sql 테스트는 `funnel_scope` 가 **없을 것**을 단언한다
 * (`summary-website-aggregates.sql.test.ts:116` · `summary-global-aggregates.sql.test.ts:120`).
 * 코드가 이긴다 — 여기서 두 번째 어휘를 새로 만들지 않는다. `funnel_scope` 는 집계층
 * 키에 남아 있으므로, 인용 화면이 정말 다른 원천을 원하면 그때 근거와 함께 더한다.
 */
function funnelCol(_scope: TrendReadScope): SQL {
  return sql`funnel_catalog`;
}

// ── 인용 계열 회차 스코프 (0071 `hidden_scope='citations'`) ──────────────────
//
// 그 회차는 집합에 **남는다**(언급 계열 값이 정상이므로). 인용만 깨져 있으므로 인용·
// 도메인 계열은 그 회차를 빼고 읽어야 하고, **분모도 같이 빼야** 비율이 정합한다
// (인용 보유 답변 비율 = 인용 보유 답변 / 답변 수: 둘이 다른 회차 집합이면 뜻이 없다).
// 미러 정본이 같은 규칙이다(`scope-aggregates.ts::hiddenClause` 의 `family` 분기,
// `trend-gap.ts::trendGapApplies` 의 계열 어휘와 같은 두 값).
//
// 목록이 비면 아래 두 함수는 **아무것도 바꾸지 않는다**: FILTER 는 빈 조각이고 스코프는
// 같은 객체라, 발행 SQL 텍스트가 종전과 바이트 단위로 같다(형태 테스트가 그것을 고정).

/** `sum(x) FILTER (…)` 의 FILTER 조각. 뺄 회차가 없으면 빈 조각이다. */
function citationFilter(set: CycleSet): SQL {
  const excluded = set.citationExcludedCycleIds;
  if (!excluded?.length) return sql``;
  return sql` FILTER (WHERE cycle_id <> ALL(${uuidArray(excluded)}))`;
}

/** 인용 계열 전용 스코프: 회차 목록에서 0071 회차를 뺀다. 뺄 것이 없으면 같은 객체. */
function citationScopeOf(scope: TrendReadScope): TrendReadScope {
  const cycles = citationCyclesOf(scope.set);
  if (cycles === scope.set.cycles) return scope;
  return { ...scope, set: { ...scope.set, cycles } };
}

/**
 * 집계층 4표 공통 WHERE. **공개 export 다**(라운드 3) — 리더가 안 내주는 축이 필요한
 * 호출부가 같은 술어로 자기 문장을 만들 수 있게. 다만 **원칙은 "리더가 축을 준다"** 이고,
 * 이 export 는 탈출구다: 새 축이 반복해서 필요하면 `axes` 옵션으로 리더에 넣어라
 * (문장이 늘지 않는다). 직접 문장을 만들면 §3-3 규칙 3(같은 표 두 번 스캔 금지)이 깨진다.
 * 표마다 다른 것은 **없다** — 집계층 키가 표면·필터 축을
 * 전부 들고 있어서 세부층처럼 `job_id IN (…)` 세미조인을 할 필요가 없다.
 * 이 한 줄이 3,943 ms → 223 ms 의 정체다(§0-2).
 */
export function trendWhere(scope: TrendReadScope): SQL {
  const f = scope.filters;
  const global = scope.set.surface === "global";
  const conds: SQL[] = [
    cycleScope(scope.set),
    // run 상태 게이트는 조회 시(§6-2) — 생성기는 상태 무관으로 굳힌다.
    sql`run_status IN ('completed', 'partial_failed')`,
  ];
  if (global) {
    // 글로벌 전용 3게이트. 굳혀진 값이라 조회는 등호다.
    // 추이 격자(`X.trendGrid`)에서는 **셋째만** 빠진다 — 이유는 `TrendReadScope.trendGrid`
    // 머리 주석. 꺼져 있으면 아래 세 줄이 한 push 와 **같은 배열**을 만든다(바이트 동일).
    //
    // 앞 둘은 **카탈로그 도입 전 회차에서만** 통째로 열린다(`preCatalogCycleIds`).
    // 그 회차들은 `in_root_catalog = 1` 인 행이 하나도 없어 등호 게이트가 자리 전체를
    // 0행으로 만든다 — 6월 점이 사라진 원인이다. 혼합 회차(카탈로그 행이 조금이라도
    // 있는 07-02 이후)는 목록에 들지 않으므로 종전 게이트 그대로다.
    const preCatalog = scope.trendGrid === true ? (scope.preCatalogCycleIds ?? []) : [];
    if (preCatalog.length) {
      conds.push(
        sql`(cycle_id = ANY(${uuidArray(preCatalog)})
          OR (in_root_catalog = 1 AND in_tagged_region = 1))`,
      );
    } else {
      conds.push(sql`in_root_catalog = 1`, sql`in_tagged_region = 1`);
    }
    if (scope.trendGrid !== true) conds.push(sql`in_full_cycle = 1`);
    if (HIDDEN_STANDARD_REGIONS.length) {
      conds.push(sql`country <> ALL(${textArray(HIDDEN_STANDARD_REGIONS)})`);
    }
    // 국가 = scope_answers.region(ISO). RHQ→ISO 환원은 상류에서 끝났다.
    if (f.region?.length) conds.push(sql`country = ANY(${textArray(f.region)})`);
    // 언어 = scope_prompts.lang(**대문자**). 웹사이트는 소문자 — 표면별 원천 고정.
    if (f.lang?.length) conds.push(sql`lang = ANY(${textArray(f.lang.map((v) => v.toUpperCase()))})`);
    // 브랜드 축 = 카탈로그 중복 행의 brand 집합과 any-match(오늘의 세미조인 재현).
    // 0065 의 gin(catalog_brands) 인덱스가 이 술어를 받는다.
    if (f.brand?.length) conds.push(sql`catalog_brands && ${textArray(f.brand)}`);
  } else {
    // 국가 = website_sites.country_code **verbatim**(worldwide·middleeast 가상 코드 그대로).
    if (f.websiteCountry?.length) conds.push(summaryCountryGeoPred(f.websiteCountry));
    if (f.lang?.length) conds.push(sql`lang = ANY(${textArray(f.lang.map((v) => v.toLowerCase()))})`);
    // 브랜드 축은 상류(withWebsite)가 이미 project_id 로 흡수했다 — catalog_brands 미적용.
    //
    // 유닛 게이트(0066 이후) — 오늘 리더 `summary-website-aggregates.ts::answerWhere` 의
    //   `report_fs IS NOT NULL` + `report_fs <> ALL($excluded)`
    // 와 **같은 뜻**이다. 집계층은 NULL 을 담지 못해 접기가 `COALESCE(report_fs, 0)` 으로
    // 굳히므로(0066 머리 주석), "미부여" 는 NULL 이 아니라 **0** 이다.
    // ⚠️ 0 을 sentinel 로 쓸 수 있는 근거는 세부층 실측 `report_fs = 0` 인 행이 0건이라는
    //    것뿐이다(값이 1부터 시작). 0 이 실값이 되면 이 술어가 조용히 행을 지운다.
    if (scope.unitFlags) {
      conds.push(sql`report_fs <> 0`);
      if (scope.excludedUnits?.length) {
        conds.push(sql`report_fs <> ALL(${sql.param(scope.excludedUnits)}::int[])`);
      }
    }
  }
  if (f.engine?.length) conds.push(sql`engine = ANY(${textArray(f.engine)})`);
  if (f.funnelStage?.length) conds.push(sql`${funnelCol(scope)} = ANY(${textArray(f.funnelStage)})`);
  if (f.listType?.length) conds.push(sql`list_type = ANY(${textArray(f.listType)})`);
  if (f.depth1?.length) conds.push(sql`depth1 = ANY(${textArray(f.depth1)})`);
  // brandPresence — 0061 정본과 **동치**인 any-match(0066 이 `presence_set` 을 키에 넣었다).
  // 규칙은 `lib/summary/read/presence.ts` 와 같다: 양쪽/0개 선택 = 무필터, 한쪽만 = 교집합.
  // 스칼라 `brand_presence_resolved` 는 쓰지 않는다 — 글로벌 8/31 회차에서 branded 모수의
  // 21.4%(8,294/38,748)가 그 컬럼에서는 안 보였다(라운드 1 실측).
  const presence = presenceWant(f.brandPresence);
  if (presence) conds.push(sql`presence_set && ${sql.param([presence])}::text[]`);
  // depth2·depth3 만 여기 오지 않는다 — `planTrendRead` 가 그 전에 폴백으로 돌린다.
  return sql.join(conds, sql` AND `);
}

/** 한쪽만 고른 `brandPresence` → 그 값. 양쪽/0개 = null(무필터). */
function presenceWant(selected: readonly string[] | undefined): string | null {
  if (!selected?.length) return null;
  const branded = selected.includes("branded");
  const unbranded = selected.includes("unbranded");
  if (branded === unbranded) return null;
  return unbranded ? "unbranded" : "branded";
}

// ── 문장 ① `summary_trend_own` — 카드 ①~⑤ · Sub-KPI · 엔진 일관성 ───────────

/**
 * 18측정 중 **16개**만 읽는다. `prompts_measured`·`prompts_tracked` 는 그룹 간 SUM 이
 * 이중 계상이라 의도적으로 뺐다(머리 주석). 세부층이 그 둘을 낸다.
 *
 * GROUPING SETS `((), (engine), (country))` — **한 스캔**에서 셋이 나온다:
 *   · `()`        카드 ①~⑤ · Sub-KPI 분자·분모
 *   · `(engine)`  엔진 일관성 배지(§3-4 12)
 *   · `(country)` 지역 롤업 — `StandardAggregates.regions[]` 의 `answerCount`(모수)와
 *                 `trackedAnswerCount`(① 분자)가 **둘 다** 여기서 나온다. ① 분자는
 *                 답변 표가 아니라 당사 그레인이라(`summary-global-aggregates.ts:232-241`
 *                 의 `o` CTE) `trend_answers` 로는 만들 수 없다 — 그래서 own 에 붙인다.
 * 종전엔 카드·엔진 배지·지역 롤업이 표를 각각 읽었다.
 */
function trendOwnSql(scope: TrendReadScope): SQL {
  const ax = axesOf(scope);
  // 인용 계열 4열은 0071 회차를 뺀다. **분모도 같이** 빼야 비율이 정합하므로
  // `cit_monitored`(= 인용 계열 회차의 모수)를 한 열 더 낸다. 뺄 회차가 없으면
  // FILTER 도 이 열도 나오지 않아 SQL 이 종전과 같다.
  //
  // ⚠️ `tile_own_mentions`·`own_mentions` 는 **언급 계열**이라 게이트를 안 건다.
  //    어느 열이 어느 계열인지는 `fold.ts` 의 접기 식이 정본이다.
  const citGate = citationFilter(scope.set);
  const citMonitored = scope.set.citationExcludedCycleIds?.length
    ? sql`,
           COALESCE(sum(monitored)${citGate}, 0)::bigint   AS cit_monitored`
    : sql``;
  const sets = ax.cycle
    ? sql.raw("((), (engine), (country), (cycle_anchor_at), (cycle_anchor_at, engine))")
    : sql.raw("((), (engine), (country))");
  // 회차 축이 꺼져 있으면 `cycle_anchor_at` 은 SELECT 에도 안 나온다 — 라운드 2와 바이트 동일.
  const axisExpr = ax.cycle
    ? sql`CASE
             WHEN GROUPING(cycle_anchor_at) = 0 AND GROUPING(engine) = 0 THEN 'cycle-engine'
             WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'
             WHEN GROUPING(engine) = 0  THEN 'engine'
             WHEN GROUPING(country) = 0 THEN 'country'
             ELSE 'total'
           END`
    : sql`CASE
             WHEN GROUPING(engine) = 0  THEN 'engine'
             WHEN GROUPING(country) = 0 THEN 'country'
             ELSE 'total'
           END`;
  const anchorExpr = ax.cycle
    ? sql`CASE WHEN GROUPING(cycle_anchor_at) = 0 THEN cycle_anchor_at END`
    : sql`NULL::timestamptz`;
  return sql`
    SELECT ${axisExpr} AS axis,
           COALESCE(
             CASE WHEN GROUPING(engine) = 0 THEN engine END,
             CASE WHEN GROUPING(country) = 0 THEN country END
           ) AS bucket,
           ${anchorExpr} AS cycle_anchor_at,
           count(*)::bigint                               AS key_rows,
           COALESCE(sum(monitored), 0)::bigint            AS monitored,
           COALESCE(sum(tracked_answers), 0)::bigint      AS tracked_answers,
           COALESCE(sum(multi_answers), 0)::bigint        AS multi_answers,
           COALESCE(sum(top1_answers), 0)::bigint         AS top1_answers,
           COALESCE(sum(top3_answers), 0)::bigint         AS top3_answers,
           COALESCE(sum(rank_sum), 0)::double precision   AS rank_sum,
           COALESCE(sum(ranked_answers), 0)::bigint       AS ranked_answers,
           COALESCE(sum(own_mentions), 0)::bigint         AS own_mentions,
           COALESCE(sum(own_positive), 0)::bigint         AS own_positive,
           COALESCE(sum(own_signals), 0)::bigint          AS own_signals,
           COALESCE(sum(comp_mentions), 0)::bigint        AS comp_mentions,
           COALESCE(sum(all_citations)${citGate}, 0)::bigint        AS all_citations,
           COALESCE(sum(own_citations)${citGate}, 0)::bigint        AS own_citations,
           COALESCE(sum(own_fallback_citations)${citGate}, 0)::bigint AS own_fallback_citations,
           COALESCE(sum(tile_own_mentions), 0)::bigint    AS tile_own_mentions,
           COALESCE(sum(citing_answers)${citGate}, 0)::bigint       AS citing_answers${citMonitored}
    FROM summary_trend_own
    WHERE ${trendWhere(scope)} AND own_variant = ${scope.ownVariant}
    GROUP BY GROUPING SETS ${sets}
  `;
}

// ── 문장 ② `summary_trend_answers` — 모수 · 퍼널/주제 도넛 ───────────────────

/**
 * GROUPING SETS 5개가 **한 스캔**에서 나온다: 전체 · funnel · depth1 · engine · country.
 * `axis`/`bucket` 두 컬럼으로 평평하게 내려 호출부가 한 번에 갈라 쓴다.
 *
 * ⚠️ 여기 나오는 도넛은 **답변 그레인**이다(`monitored` 합). 오늘 화면의 퍼널·주제
 * 도넛은 `count(DISTINCT prompt_id)`(프롬프트 그레인)라 값이 다르다 — 그쪽은 세부층
 * `summary_answers` 한 문장이 낸다(§3-4 16·17). 두 값을 섞지 마라.
 */
function trendAnswersSql(scope: TrendReadScope): SQL {
  const fc = funnelCol(scope);
  const ax = axesOf(scope);
  const sets = ax.cycle
    ? sql.raw("((), (funnel), (depth1), (engine), (country), (cycle_anchor_at), (cycle_anchor_at, engine))")
    : sql.raw("((), (funnel), (depth1), (engine), (country))");
  const anchorSel = ax.cycle ? sql.raw("cycle_anchor_at, ") : sql.raw("");
  const axisExpr = ax.cycle
    ? sql`CASE
             WHEN GROUPING(cycle_anchor_at) = 0 AND GROUPING(engine) = 0 THEN 'cycle-engine'
             WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'
             WHEN GROUPING(funnel) = 0  THEN 'funnel'
             WHEN GROUPING(depth1) = 0  THEN 'depth1'
             WHEN GROUPING(engine) = 0  THEN 'engine'
             WHEN GROUPING(country) = 0 THEN 'country'
             ELSE 'total'
           END`
    : sql`CASE
             WHEN GROUPING(funnel) = 0  THEN 'funnel'
             WHEN GROUPING(depth1) = 0  THEN 'depth1'
             WHEN GROUPING(engine) = 0  THEN 'engine'
             WHEN GROUPING(country) = 0 THEN 'country'
             ELSE 'total'
           END`;
  const anchorExpr = ax.cycle
    ? sql`CASE WHEN GROUPING(cycle_anchor_at) = 0 THEN cycle_anchor_at END`
    : sql`NULL::timestamptz`;
  return sql`
    WITH s AS (
      SELECT ${fc} AS funnel, ${anchorSel}depth1, engine, country,
             monitored, all_mentions, all_citations, has_any_brand
      FROM summary_trend_answers
      WHERE ${trendWhere(scope)}
    )
    SELECT ${axisExpr} AS axis,
           COALESCE(
             CASE WHEN GROUPING(funnel) = 0 THEN funnel END,
             CASE WHEN GROUPING(depth1) = 0 THEN depth1 END,
             CASE WHEN GROUPING(engine) = 0 THEN engine END,
             CASE WHEN GROUPING(country) = 0 THEN country END
           ) AS bucket,
           ${anchorExpr} AS cycle_anchor_at,
           count(*)::bigint                        AS key_rows,
           COALESCE(sum(monitored), 0)::bigint     AS monitored,
           COALESCE(sum(all_mentions), 0)::bigint  AS all_mentions,
           COALESCE(sum(all_citations), 0)::bigint AS all_citations,
           COALESCE(sum(has_any_brand), 0)::bigint AS has_any_brand
    FROM s
    GROUP BY GROUPING SETS ${sets}
  `;
}

// ── 문장 ③ `summary_trend_brands` — 타일 · 순위표 · GEO ──────────────────────

/**
 * GROUPING SETS `((brand_name), (country, brand_name))` — §3-3 규칙 3 의 정확한 형태.
 * 실측 X2(223 ms) 짜리 스캔이 두 번 돌던 것을 한 번으로 만든다.
 *
 * 모집단은 `is_competitor = 1` — 비경쟁 노이즈 제외를 통과한 행(자사 포함)이다.
 * 오늘의 리더(`summaryWebsiteGeoCompetition`·S2 순위표)와 같은 게이트다.
 *
 * **절단(라운드 2)**: 브랜드 축은 언급 상위 `limits.brand`, GEO 축은 **국가당** 상위
 * `limits.geoBrandPerCountry`. 잘린 몫은 버리지 않고 `brand_name = NULL` 한 행으로
 * 합쳐 같은 축에 실어 보낸다 — ② 타일의 분모(총언급)와 GEO 의 국가 총량이 보존된다.
 * `rest_count` 에 잘린 브랜드 수가 실려 "고유 브랜드 수"(§3-4 14)도 복원된다.
 *
 * ⚠️ `answers` 는 **브랜드 축을 가로질러 SUM 하면 이중 계상**이다(§3-4 전제 · §7-2 2).
 *    `trend_brands` 는 job 을 브랜드로 분할하므로 그 열은 "그 브랜드가 나온 답변 수"
 *    이지 모수가 아니다. 모수는 문장 ②(`trend_answers.monitored`)에서 온다.
 */
/**
 * 0069 적용 여부. **동기** 판정이라 `readTrendAggregates` 가 문장을 만들기 전에
 * `ensureColumnAvailability()` 를 await 한다(column-availability.ts 계약 ①).
 * 미적용이면 두 칸을 **상수 0** 으로 낸다 — 행 모양이 같아 매핑·절단 재집계가 안 갈린다.
 */
const compRankColumns = (): SQL =>
  columnKnownAvailable("summary_trend_brands", "comp_rank_sum")
    ? sql`
           COALESCE(sum(comp_rank_sum), 0)::double precision AS comp_rank_sum,
           COALESCE(sum(comp_ranked_answers), 0)::bigint     AS comp_ranked_answers`
    : sql`
           0::double precision                              AS comp_rank_sum,
           0::bigint                                        AS comp_ranked_answers`;

const brandMeasureSums = (): SQL => sql`
           COALESCE(sum(mentions), 0)::bigint               AS mentions,
           COALESCE(sum(answers), 0)::bigint                AS answers,
           COALESCE(sum(rank_sum), 0)::double precision     AS rank_sum,
           COALESCE(sum(ranked_answers), 0)::bigint         AS ranked_answers,
           ${compRankColumns()},
           COALESCE(sum(top3_answers), 0)::bigint           AS top3_answers,
           COALESCE(sum(positive), 0)::bigint               AS positive,
           COALESCE(sum(neutral), 0)::bigint                AS neutral,
           COALESCE(sum(negative), 0)::bigint               AS negative,
           COALESCE(sum(mixed), 0)::bigint                  AS mixed,
           COALESCE(sum(type_mention), 0)::bigint           AS type_mention,
           COALESCE(sum(type_recommendation), 0)::bigint    AS type_recommendation,
           COALESCE(sum(type_comparison), 0)::bigint        AS type_comparison,
           COALESCE(sum(type_definition), 0)::bigint        AS type_definition,
           COALESCE(sum(type_final_choice), 0)::bigint      AS type_final_choice`;

/** 위 SELECT 의 측정 컬럼 이름 — 세 곳(패스스루·재집계·행 매핑)이 같은 순서를 쓴다. */
const BRAND_MEASURE_COLS = sql.raw(
  "mentions, answers, rank_sum, ranked_answers, comp_rank_sum, comp_ranked_answers, top3_answers, " +
    "positive, neutral, negative, mixed, " +
    "type_mention, type_recommendation, type_comparison, type_definition, type_final_choice",
);

/** 절단 잔여 행이 다시 합칠 때 쓰는 집계(위와 **같은 순서**). */
const BRAND_MEASURE_REAGG = sql`
           sum(mentions)::bigint, sum(answers)::bigint, sum(rank_sum)::double precision,
           sum(ranked_answers)::bigint,
           sum(comp_rank_sum)::double precision, sum(comp_ranked_answers)::bigint,
           sum(top3_answers)::bigint,
           sum(positive)::bigint, sum(neutral)::bigint, sum(negative)::bigint, sum(mixed)::bigint,
           sum(type_mention)::bigint, sum(type_recommendation)::bigint, sum(type_comparison)::bigint,
           sum(type_definition)::bigint, sum(type_final_choice)::bigint`;

/** 2단 조회의 2단 — 이름 집합이 있으면 브랜드 표를 그것으로 좁힌다(`TrendReadScope.brandNames`). */
function brandNameFilter(scope: TrendReadScope): SQL {
  const names = scope.brandNames;
  if (!names || names.length === 0) return sql``;
  return sql` AND brand_name = ANY(${textArray([...names])})`;
}

function trendBrandsSql(scope: TrendReadScope): SQL {
  const own = trackedEntityIdsFor(scope.filters.contextBrand ?? scope.filters.brand, scope.filters.ownEntities);
  const ownArr = own.length ? uuidArray(own) : sql`ARRAY[]::uuid[]`;
  const lim = limitsOf(scope);
  const ax = axesOf(scope);
  // 엔진 축(옵션) — Sub-KPI 의 `negativeMentions` 를 낼 유일한 경로(`trend_own` 에
  // `own_negative` 가 없다). 켜지 않으면 컬럼도 grouping set 도 안 나온다.
  // 축 조합 — 켜지 않은 축은 컬럼도 grouping set 도 안 나온다(라운드 2와 바이트 동일).
  const baseSets = ["(brand_name)", "(country, brand_name)"];
  if (ax.engineBrand) baseSets.push("(engine, brand_name)");
  if (ax.cycleBrand) baseSets.push("(cycle_anchor_at, brand_name)");
  const sets = sql.raw(`(${baseSets.join(", ")})`);
  const byEngine = ax.engineBrand ? sql`GROUPING(engine)::int` : sql`1::int`;
  const engineCol = ax.engineBrand
    ? sql`CASE WHEN GROUPING(engine) = 1 THEN NULL ELSE engine END`
    : sql`NULL::text`;
  const byCycle = ax.cycleBrand ? sql`GROUPING(cycle_anchor_at)::int` : sql`1::int`;
  const cycleCol = ax.cycleBrand
    ? sql`CASE WHEN GROUPING(cycle_anchor_at) = 1 THEN NULL ELSE cycle_anchor_at END`
    : sql`NULL::timestamptz`;
  const base = sql`
      SELECT GROUPING(country)::int AS by_country,
             ${byEngine} AS by_engine,
             ${byCycle} AS by_cycle,
             CASE WHEN GROUPING(country) = 1 THEN NULL ELSE country END AS country,
             ${engineCol} AS engine,
             ${cycleCol} AS cycle_anchor_at,
             brand_name,
             bool_or(brand_id = ANY(${ownArr}))               AS is_tracked,
             count(*)::bigint                                 AS key_rows,
             ${brandMeasureSums()}
      FROM summary_trend_brands
      WHERE ${trendWhere(scope)} AND is_competitor = 1${brandNameFilter(scope)}
      GROUP BY GROUPING SETS ${sets}`;

  if (lim.brand === null && lim.geoBrandPerCountry === null) {
    return sql`SELECT g.*, 0::int AS is_rest, 0::bigint AS rest_count FROM (${base}) g`;
  }
  // `keep` 술어 — 축마다 상한이 다르다. null 이면 그 축은 자르지 않는다.
  // 엔진 축은 카디널리티가 작아(엔진 2개 × 브랜드) 브랜드 축 상한을 그대로 쓴다.
  const keepBrand = lim.brand === null ? sql`true` : sql`rn <= ${lim.brand}`;
  const keepGeo = lim.geoBrandPerCountry === null ? sql`true` : sql`rn <= ${lim.geoBrandPerCountry}`;
  const keepExpr = sql`CASE WHEN by_country = 0 THEN ${keepGeo} ELSE ${keepBrand} END`;
  // ⚠️ 파티션에 **축 판별자를 전부** 넣는다. 하나라도 빠지면 서로 다른 축의 행이 한
  //    순위 창에 섞여, 예컨대 회차별 top-N 이 "전 회차 통합 top-N" 이 된다(옛 회차가
  //    통째로 잘린다). 잔여 행 GROUP BY 도 같은 목록이어야 축별 합계가 유지된다.
  // `r` 은 두 번 참조되므로 PostgreSQL 이 CTE 를 **materialize** 한다 → 기반 표 스캔은 1회.
  return sql`
    WITH g AS (${base}),
    r AS (
      SELECT g.*, row_number() OVER (
               PARTITION BY by_country, country, by_engine, engine, by_cycle, cycle_anchor_at
               ORDER BY mentions DESC, brand_name
             ) AS rn
      FROM g
    )
    SELECT by_country, by_engine, by_cycle, country, engine, cycle_anchor_at,
           brand_name, is_tracked, key_rows,
           ${BRAND_MEASURE_COLS},
           0::int AS is_rest, 0::bigint AS rest_count
    FROM r
    WHERE ${keepExpr}
    UNION ALL
    SELECT by_country, by_engine, by_cycle, country, engine, cycle_anchor_at,
           NULL::text, bool_or(is_tracked),
           sum(key_rows)::bigint, ${BRAND_MEASURE_REAGG},
           1::int, count(*)::bigint
    FROM r
    WHERE NOT (${keepExpr})
    GROUP BY by_country, by_engine, by_cycle, country, engine, cycle_anchor_at
  `;
}

// ── 문장 ④ `summary_trend_domains` — 카테고리 · 출처 도넛 · ⑤ 분모·분자 ───────

/**
 * GROUPING SETS `((group_key), (domain), ())` — §3-3 규칙 3 의 정확한 형태.
 * 실측 X5(202 ms) 짜리 스캔이 두 번 돌던 것을 한 번으로.
 *
 * **⑤ 분자의 정본이 여기다**(라운드 2). 표면마다 소스가 다르다:
 *   · 글로벌 — `sum(citations) FILTER (matched_base ∈ $sel  OR  base_norm_null 폴백)`.
 *     오늘 리더(`summary-global-aggregates.ts::ownedCitationExpr`)와 **같은 식**이고,
 *     `matched_base`·`base_norm_null`·`domain` 이 전부 집계층 키라 세부층과 구조적으로
 *     동일하다. `trend_own.own_citations`(생성 시각에 굳힌 값)를 쓰지 않는 이유는 T3 실측이다
 *     — 굳힌 스코프는 (변형, country, lang) 한 행으로 확정되므로 **국가·언어를 안 고른
 *     화면에서 오늘 값과 갈린다**(무필터 글로벌 9.92% vs 5.29%). 그 컬럼은 감사값으로 남는다.
 *   · 웹사이트 — `sum(unit_owned_citations)`. 오늘 리더가 `scope.unitFlags` 일 때
 *     `sum(unit_owned_citations)` / `bool_or(unit_owned_citations > 0)` 을 쓰는 것과 같다.
 *     집계층에서는 `bool_or(x > 0)` 이 **`sum(x) > 0`** 이 된다(값이 음수가 아니므로 동치,
 *     0066 블록 ①-b 실측).
 *
 * `domain` 은 NULL 을 담을 수 있다(0059 에서 유일하게 nullable). 그래서 "이 행이 어느
 * 그룹핑 셋인가" 를 값으로 추론하면 안 되고 `GROUPING()` 비트로 갈라야 한다 — `axis` 다.
 *
 * 카테고리 도넛의 `COALESCE(override, rule)` 은 여기서 하지 않는다(§3-4 10) —
 * override 즉시 반영이 요건이라 `group_key` 를 화면에서 카테고리로 매핑한다. 그래서
 * `group` 축은 기본적으로 **자르지 않는다**(자르면 꼬리의 카테고리가 사라진다).
 */
function ownedCitationsAgg(scope: TrendReadScope): { sum: SQL; ours: SQL } {
  if (scope.set.surface === "website" && scope.unitFlags) {
    return {
      sum: sql`COALESCE(sum(unit_owned_citations), 0)::bigint`,
      ours: sql`COALESCE(sum(unit_owned_citations), 0) > 0`,
    };
  }
  const owned = ownedCitationExpr(scope.ownedBasePrefixes);
  return {
    sum: sql`COALESCE(sum(citations) FILTER (WHERE ${owned}), 0)::bigint`,
    ours: sql`bool_or(${owned})`,
  };
}

function trendDomainsSql(scope: TrendReadScope): SQL {
  const { sum: ownedSum, ours } = ownedCitationsAgg(scope);
  // 글로벌 ⑤ 분자(공식(HMG) 카테고리) — 목록이 있을 때만 열이 생긴다(`officialGroupKeys` 주석).
  // 빈 목록이면 `= ANY('{}')` 가 항상 거짓이라 값이 0 이다(공식 도메인이 하나도 없는 집합).
  const officialKeys = scope.officialGroupKeys;
  const officialCol = officialKeys
    ? sql`,
             COALESCE(sum(citations) FILTER (WHERE group_key = ANY(${textArray(officialKeys)})), 0)::bigint AS official_citations`
    : sql``;
  const officialPick = officialKeys ? sql`, official_citations` : sql``;
  const officialRest = officialKeys ? sql`, sum(official_citations)::bigint` : sql``;
  const lim = limitsOf(scope);
  const ax = axesOf(scope);
  // 국가 축·회차 축(옵션) — 켜지 않으면 컬럼도 grouping set 도 없다.
  const domSets = ["(group_key)", "(domain)"];
  if (ax.domainCountry) domSets.push("(country)");
  if (ax.domainCountryGroup) domSets.push("(country, group_key)");
  if (ax.cycleDomain) domSets.push("(cycle_anchor_at)");
  domSets.push("()");
  const sets = sql.raw(`(${domSets.join(", ")})`);
  // ⚠️ 축마다 **자기 WHEN 절이 반드시 있어야 한다.** 절이 빠지면 그 grouping set 의 행이
  //    다른 축으로 접힌다 — 회차 절을 지우면 `(cycle_anchor_at)` 행이
  //    `GROUPING(group_key)=1, GROUPING(domain)=1` 이라 `'total'` 이 되어 **`axis='cycle'` 이
  //    사라지고 `total` 이 2행**이 된다(⑤ 분모가 회차 수만큼 부푼다).
  //    WHEN **순서**는 무해하다 — grouping set 들은 서로 배타라 한 행이 두 WHEN 을 동시에
  //    만족하지 않는다. 지켜야 할 것은 순서가 아니라 **절의 존재**다
  //    (`summary-trend-aggregates.sql.test.ts` 가 절 자체를 단언한다).
  const cycleWhen = ax.cycleDomain
    ? sql`WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'`
    : sql``;
  const countryWhen = ax.domainCountry
    ? sql`WHEN GROUPING(country) = 0 AND GROUPING(group_key) = 0 THEN 'country-group'
               WHEN GROUPING(country) = 0 THEN 'country'`
    : sql``;
  const axisExpr = sql`CASE
               ${cycleWhen}
               ${countryWhen}
               WHEN GROUPING(group_key) = 0 THEN 'group'
               WHEN GROUPING(domain) = 0    THEN 'domain'
               ELSE 'total'
             END`;
  const countryCol = ax.domainCountry
    ? sql`CASE WHEN GROUPING(country) = 0 THEN country END`
    : sql`NULL::text`;
  const cycleCol = ax.cycleDomain
    ? sql`CASE WHEN GROUPING(cycle_anchor_at) = 0 THEN cycle_anchor_at END`
    : sql`NULL::timestamptz`;
  const base = sql`
      SELECT ${axisExpr} AS axis,
             CASE WHEN GROUPING(group_key) = 0 THEN group_key END AS group_key,
             CASE WHEN GROUPING(domain) = 0 THEN domain END       AS domain,
             ${countryCol} AS country,
             ${cycleCol} AS cycle_anchor_at,
             count(*)::bigint                         AS key_rows,
             COALESCE(sum(citations), 0)::bigint      AS citations,
             COALESCE(sum(citing_answers), 0)::bigint AS citing_answers,
             ${ownedSum} AS owned_citations,
             ${ours}     AS is_ours${officialCol}
      FROM summary_trend_domains
      WHERE ${trendWhere(scope)}
      GROUP BY GROUPING SETS ${sets}`;

  if (lim.domain === null && lim.group === null) {
    return sql`SELECT g.*, 0::int AS is_rest, 0::bigint AS rest_count FROM (${base}) g`;
  }

  // ── 절단 형태: `row_number()` 가 아니라 **`ORDER BY … LIMIT`** 다 ─────────────
  //
  // 창(window)으로 순위를 매기면 그룹 결과 21,043행을 **전부 정렬**한다(실측: 두 창에
  // 정렬 2회 = +146 ms). 필요한 건 순위가 아니라 "상위 N 의 이름 목록" 뿐이므로
  // `ORDER BY … LIMIT N` 으로 받는다 — PostgreSQL 이 **top-N heapsort** 를 써서
  // O(n log N) 에 끝난다.
  //
  // 정렬 기준이 **둘**인 이유: 오늘 화면이 도메인 표를 두 가지로 정렬한다.
  //   · 글로벌 인용 상세 = `citing_answers DESC`(`summary-global-aggregates.ts` domRows)
  //   · 출처 도넛      = `citations DESC`(`summaryWebsiteSourceComposition`)
  // 한쪽 기준으로만 자르면 다른 화면의 상위 항목이 잘려 나간다 → **합집합**을 남긴다.
  //
  // `domain IS NULL` 행은 항상 남긴다 — 전체 합과 도메인 합의 차이를 설명하는 유일한
  // 행이고 1행뿐이다. 잘린 몫은 `is_rest = 1` 한 행으로 합쳐 분모·개수를 보존한다.
  // 국가 축(`country`·`country-group`)은 **자르지 않는다** — GEO 는 국가 총량이 필요하고
  // 카디널리티가 국가 수(45)·국가×그룹이라 도메인 축만큼 크지 않다.
  const dl = lim.domain;
  const gl = lim.group;
  const keepDomain =
    dl === null
      ? sql`true`
      : sql`(domain IS NULL OR domain IN (
            (SELECT domain FROM g WHERE axis = 'domain' AND domain IS NOT NULL
              ORDER BY citations DESC, domain LIMIT ${dl})
            UNION
            (SELECT domain FROM g WHERE axis = 'domain' AND domain IS NOT NULL
              ORDER BY citing_answers DESC, domain LIMIT ${dl})
          ))`;
  const keepGroup =
    gl === null
      ? sql`true`
      : sql`group_key IN (
            SELECT group_key FROM g WHERE axis = 'group'
             ORDER BY citations DESC, group_key LIMIT ${gl}
          )`;
  const keep = sql`CASE axis WHEN 'domain' THEN ${keepDomain} WHEN 'group' THEN ${keepGroup} ELSE true END`;
  return sql`
    WITH g AS MATERIALIZED (${base})
    SELECT axis, group_key, domain, country, cycle_anchor_at, key_rows,
           citations, citing_answers, owned_citations, is_ours,
           0::int AS is_rest, 0::bigint AS rest_count${officialPick}
    FROM g WHERE ${keep}
    UNION ALL
    SELECT axis, NULL::text, NULL::text, country, cycle_anchor_at, sum(key_rows)::bigint,
           sum(citations)::bigint, sum(citing_answers)::bigint, sum(owned_citations)::bigint,
           bool_or(is_ours), 1::int, count(*)::bigint${officialRest}
    FROM g WHERE NOT (${keep})
    GROUP BY axis, country, cycle_anchor_at
  `;
}

// ── 행 타입 ─────────────────────────────────────────────────────────────────

/** `cycle`·`cycle-engine` 은 `axes.cycle` 을 켰을 때만 나온다. */
export type TrendOwnAxis = "total" | "engine" | "country" | "cycle" | "cycle-engine";

export interface TrendOwnRow {
  axis: TrendOwnAxis;
  /** `total`·`cycle` 이면 null. `engine`/`country`/`cycle-engine` 이면 그 값. */
  bucket: string | null;
  /** `cycle`·`cycle-engine` 축에서만 값이 있다(회차 anchor, ISO). */
  cycleAnchorAt: string | null;
  /**
   * 이 그룹이 **집계층에서 읽은 행 수**. 값이 아니라 **존재 증거**다.
   *
   * ⚠️ `GROUPING SETS ((), …)` 는 입력이 0행이어도 `()` 합계 행을 **1개 낸다**(전 측정 0).
   *    그래서 "행이 0개인가" 로는 빈 집계층을 판정할 수 없다 — 없는 `(cycle_id,
   *    generation_id)` 쌍으로 읽어도 own 은 1행이 나온다(2026-09-10 실측). 판정은
   *    `axis='total'` 행의 이 값이 0인지로 한다. `TrendAggregates.empty` 가 그렇게 센다.
   */
  keyRows: number;
  monitored: number;
  trackedAnswers: number;
  multiAnswers: number;
  top1Answers: number;
  top3Answers: number;
  /** ④ 분자 — job 별 당사 최선 **서수** 합. `trend_brands.rank_sum`(first_rank 실수 합)과 정의가 다르다. */
  rankSum: number;
  rankedAnswers: number;
  ownMentions: number;
  ownPositive: number;
  ownSignals: number;
  compMentions: number;
  allCitations: number;
  ownCitations: number;
  ownFallbackCitations: number;
  /**
   * **인용 계열 지표의 분모**(= 0071 회차를 뺀 회차 집합의 `monitored`).
   *
   * 뺄 회차가 없으면 `monitored` 와 같은 값이다. 인용 보유 답변 비율처럼 인용 분자를
   * 답변 수로 나누는 지표는 `monitored` 가 아니라 **이 값**을 분모로 써야 한다:
   * 분자에서 뺀 회차를 분모에 남기면 비율이 낮아진다(그 오차가 이 열의 존재 이유다).
   */
  citMonitored: number;
  tileOwnMentions: number;
  citingAnswers: number;
}

export type TrendAnswerAxis =
  | "total" | "funnel" | "depth1" | "engine" | "country" | "cycle" | "cycle-engine";

export interface TrendAnswerRow {
  axis: TrendAnswerAxis;
  /** `total`·`cycle` 이면 null. 세부층 NULL 차원은 집계층에서 `''` 다(fold.ts). */
  bucket: string | null;
  /** `cycle`·`cycle-engine` 축에서만 값이 있다. */
  cycleAnchorAt: string | null;
  /** 존재 증거 — `TrendOwnRow.keyRows` 주석 참고. */
  keyRows: number;
  monitored: number;
  allMentions: number;
  allCitations: number;
  hasAnyBrand: number;
}

/**
 * `brand` = 브랜드 축(타일·순위표) · `country` = GEO 축 · `engine` = 엔진 축
 * (`axes.engineBrand` 를 켰을 때만).
 *
 * ⚠️ **`country === null` 로 브랜드 축을 가르지 마라.** `axes.engineBrand` 를 켜면 엔진 행도
 *    `country` 가 null 이다. 축 판별은 이 필드로만 한다(라운드 3에서 추가된 이유).
 */
export type TrendBrandAxis = "brand" | "country" | "engine" | "cycle-brand";

export interface TrendBrandRow {
  axis: TrendBrandAxis;
  /** `axis='country'` 일 때만 값이 있다. */
  country: string | null;
  /** `axis='engine'` 일 때만 값이 있다(`axes.engineBrand`). */
  engine: string | null;
  /** `axis='cycle-brand'` 일 때만 값이 있다(`axes.cycleBrand`) — 회차 anchor, ISO. */
  cycleAnchorAt: string | null;
  /**
   * `null` = **절단 잔여 합계 행**(`isRest === true`). top-N 밖 브랜드를 한 행으로 합친 것이라
   * 이름이 없다. 분모(총언급)·국가 총량은 이 행을 **포함해야** 오늘 값과 같다.
   */
  brandName: string | null;
  /** 이 행이 절단 잔여 합계인가. 순위표·타일에 그리지 말고 분모에만 더한다. */
  isRest: boolean;
  /** 잔여 행이 합친 브랜드 수. "고유 브랜드 수"(§3-4 14) = 반환된 이름 행 수 + 이 값. */
  restCount: number;
  /** 존재 증거 — `TrendOwnRow.keyRows` 주석 참고. brands 는 `()` 셋이 없어 빈 입력이면 0행이다. */
  keyRows: number;
  isTracked: boolean;
  mentions: number;
  /**
   * ⚠️ 둘 다 조심할 것.
   *  ① **브랜드 축을 가로질러 SUM 하지 마라** — 이중 계상(§7-2 2). 모수는 문장 ②다.
   *  ② 같은 `brand_name` 에 `brand_id` 가 둘 이상인 답변이 있으면(플랜 §3-4 3 실측
   *     669/228,654 = 0.29%) 이 값도 그만큼 **상한**이다 — 접기가 `brand_id` 를 키에
   *     갖기 때문. `mentions`(순수 SUM)는 영향 없다.
   *     (2026-09-10 실측 — 웹사이트 `a3204f07`: 브랜드 29개 전부 일치(혼재 없음).
   *      글로벌 `74eca7fb`: 표시명 1,103개 중 **10개** 어긋남, 최대 초과 **+166**,
   *      합계 178,024 vs 177,355 = **+0.38%**.)
   */
  answers: number;
  /**
   * **본문 텍스트 내 서수**(`first_rank`) 합 — GEO 위젯(`toGeoKpi` 의 `posSum`)의 정본.
   * ⚠️ 카드 ④(`TrendOwnRow.rankSum`)와 **다른 양**이다. 경쟁사 행처럼 ④와 같은 축이
   * 필요한 곳은 아래 `compRankSum` 을 쓴다(fold.ts 머리 주석 3열 표).
   */
  rankSum: number;
  rankedAnswers: number;
  /**
   * **답변 안 경쟁 순위** 합·개수(0069) — `TrendOwnRow.rankSum`/`rankedAnswers` 와 **같은 축**.
   * 평균 = `compRankSum / compRankedAnswers`(분모 0 이면 값 없음 = `null`).
   *
   * ⚠️ 순위의 그레인은 **표시명**이라 접기가 한 표시명당 `min(brand_id)` 대표 행 하나에만
   *    싣는다(0069 COMMENT). 이 리더의 GROUPING SET 은 전부 `brand_name` 을 포함하므로
   *    롤업 결과가 미러와 일치한다 — `brand_id` 단위로 쪼개 읽으면 안 된다.
   * ⚠️ 0069 **미적용** DB 에서는 둘 다 0 이다(문장이 상수 0 을 SELECT 한다). 그때 평균은
   *    `null` 이 되어 화면에 빈칸으로 나온다 — 틀린 숫자가 아니라 "아직 없음" 이다.
   */
  compRankSum: number;
  compRankedAnswers: number;
  top3Answers: number;
  positive: number;
  neutral: number;
  /** Sub-KPI 의 `negativeMentions` 원천 — `axes.engineBrand` + `isTracked` 행 합. */
  negative: number;
  mixed: number;
  typeMention: number;
  typeRecommendation: number;
  typeComparison: number;
  typeDefinition: number;
  typeFinalChoice: number;
}

/** `country`·`country-group` 은 `axes.domainCountry` 를 켰을 때만 나온다. */
export type TrendDomainAxis =
  | "total" | "group" | "domain" | "country" | "country-group" | "cycle";

export interface TrendDomainRow {
  axis: TrendDomainAxis;
  /** `isRest` 면 `groupKey`·`domain` 이 둘 다 null 이다 — 잔여 합계에는 이름이 없다. */
  isRest: boolean;
  /** 잔여 행이 합친 도메인(또는 그룹) 수. 고유 개수 = 이름 행 수 + 이 값. */
  restCount: number;
  /** 존재 증거 — `TrendOwnRow.keyRows` 주석 참고. */
  keyRows: number;
  groupKey: string | null;
  /** `axis='domain'` 이어도 null 일 수 있다(0059 nullable) — 축 판별은 `axis` 로만. */
  domain: string | null;
  /** `axis='country'`·`'country-group'` 일 때만 값이 있다(`axes.domainCountry`). */
  country: string | null;
  /** `axis='cycle'` 일 때만 값이 있다(`axes.cycleDomain`) — 회차 anchor, ISO. */
  cycleAnchorAt: string | null;
  citations: number;
  /**
   * ⚠️ **정확한 distinct 가 아니다 — 상한이다.** 세부층의 `count(DISTINCT job_id)` 가
   * 접기 키 `(차원…, group_key, domain, matched_base, base_norm_null)` 안에서 세어졌기
   * 때문에, 한 답변이 같은 도메인의 URL 을 서로 다른 `matched_base` 로 인용하면
   * **행이 갈려 그 답변이 두 번 세어진다**.
   *
   * 2026-09-10 실측 — 웹사이트 회차 `a3204f07`: 도메인 43개 중 **1개** 어긋남, 초과 **+20**,
   * 합계 150 vs 130(**+15.4%**). 글로벌 회차 `74eca7fb`: 도메인 10,823개 중 **12개** 어긋남,
   * 한 도메인 최대 초과 **+1,748**, 합계 95,966 vs 92,131(**+4.2%**).
   * `citations`(순수 SUM)와 `ownedCitations` 는 영향이 없다 — 이 컬럼만이다.
   *
   * → 화면의 "커버리지(인용 답변 수)" 를 이 값으로 그리면 과대 표시된다. 정확한 수가
   *   필요하면 세부층 `summary_domain_citations` 2단 조회(§3-4 19)로 가라.
   */
  citingAnswers: number;
  ownedCitations: number;
  /**
   * 공식(HMG) 카테고리 인용 수 — `scope.officialGroupKeys` 를 넘겼을 때만 값이 있다
   * (없으면 `undefined` = "계산 안 함", 0 과 다르다).
   */
  officialCitations?: number;
  isOurs: boolean;
}

export interface TrendAggregates {
  own: TrendOwnRow[];
  answers: TrendAnswerRow[];
  brands: TrendBrandRow[];
  domains: TrendDomainRow[];
  /**
   * **접기가 안 돌았다** = 폴백 신호(플랜 §5-2). "측정 대기" 가 아니다 — 0 으로 그리면
   * 고객이 성과 0 으로 읽는다.
   *
   * ⚠️ 판정은 "행이 0개인가" 가 **아니다.** `GROUPING SETS ((), …)` 는 입력 0행에도 합계
   *    행 1개를 내므로 그 판정은 절대 발화하지 않는다(라운드 2까지의 결함 — 없는
   *    generation 으로 읽어도 `own` 1행·`empty=false` 였다). 지금은 각 표의 **`keyRows`**
   *    (그 그룹이 읽은 집계층 행 수)로 센다.
   *
   * `only` 로 일부만 발행했으면 **발행한 표만** 본다 — 안 부른 표가 비었다고 폴백하지 않는다.
   *
   * ── 판정 대상은 **모수 표뿐**이다 (PR③ R1, 2026-09-10) ─────────────────────
   *
   * `own`·`answers` 만 본다. 이 둘은 접기가 돌면 **반드시 행이 생긴다**(모수 행) —
   * 그러므로 `keyRows = 0` 은 "접기가 안 돌았다"와 동치다. 반면 `brands`·`domains` 의
   * 0 은 **정당한 0**이다: 그 슬라이스에 언급·인용이 없었다는 뜻이지 접기 실패가 아니다.
   *
   * 라운드 4(2026-09-10 오전)는 네 표 전부에 `some` 을 걸었다. 근거는 "접기는 표별로
   * 따로 쓰므로 `domains` 만 안 접힌 창이 실재한다" 였는데, **코드가 그 전제를 부정한다**:
   * `foldBatches()` 는 항상 `AGG_TABLES` 4개를 함께 만들고(순서 어긋나면 throw),
   * 정규 경로인 `swapGeneration()`(`lib/summary/generate/swap.ts`)이 그 넷을 **스왑과
   * 같은 트랜잭션**에서 DELETE→INSERT 한다(백필 전용 쌍둥이 `applyFoldTx()` 도 같은
   * 배치를 자기 tx 로 쓴다 — `generate-cycle.ts` 만 부른다). 표 단위 부분
   * 접힘은 구조적으로 불가능하다. 남는 부분 접힘은 **회차 단위**(95개 중 30개만 접힘)
   * 이고 그것은 읽기 **전**에 도는 `trendFoldPresent` 프로브가 잡는다.
   *
   * 대가는 실측으로 확인했다 — 있지도 않은 창을 막으면서 **실재하는 오폴백**을 만들고
   * 있었다(2026-09-10 프로덕션 글로벌 회차 `74eca7fb`): `own` 은 있는데 `domains` 가
   * 0인 `(country, depth1)` 셀이 **3개**(BE×Athletic Elegance · BE×Brand Owner Persona ·
   * IT×Brand Owner Persona — 셋 다 인용이 정말 0건이다). 그 화면들은 값이 맞는데도
   * 매번 세부층으로 떨어져 느렸다.
   *
   * ⚠️ 모수 표를 하나도 발행하지 않은 read(예: 출처 도넛 `only:["domains"]`)는 이 신호를
   *    못 낸다 — 그 경로의 접힘 판정은 프로브가 전담한다. `empty` 를 다시 넓히고 싶으면
   *    **접기 트랜잭션의 원자성이 깨졌는지 먼저 확인하라**(`swapGeneration` — 정규 경로,
   *    그리고 백필의 `applyFoldTx`). 그 원자성이 이 규칙의 전제다.
   */
  empty: boolean;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

export type TrendStatementKey = "own" | "answers" | "brands" | "domains";
export interface TrendStatement {
  key: TrendStatementKey;
  table: string;
  sql: SQL;
}

/**
 * 발행할 표를 고른다(라운드 3). 위젯이 안 쓰는 표를 읽지 않기 위한 것 —
 * S4 실측에서 위젯 3개가 각자 4문장을 내 **렌더당 12문장**이 됐다(전환 전 8).
 *   aggregates = `["own","brands","domains"]` · 출처 도넛 = `["domains"]` · GEO = `["brands"]`
 * 생략하면 4개 전부.
 */
export interface TrendReadOptions {
  only?: readonly TrendStatementKey[];
  /**
   * 실행 예산. 생략하면 **기본 안전망**(`summaryRead` 프로파일 — 문장 15 s·경로 20 s)이
   * 걸린다(2026-09-10). 집계층 read 는 정상값이 수백 ms 라 이 상한은 성능 목표가 아니라
   * "이 경계가 페이지를 잡아먹지 못하게" 하는 캡이다 — 발동하면 회귀 신호다.
   * `null` 을 주면 예산 없이 돈다(패리티·EXPLAIN 하네스가 종전 형태로 재는 용도).
   */
  budget?: AnswerSetBudget | null;
}

const ALL_KEYS: readonly TrendStatementKey[] = ["own", "answers", "brands", "domains"];

/**
 * 이 **함수 호출 한 번**이 집계층에 내는 문장 전부. 수용 기준 ①("≤ 4")은 위젯 합이 아니라
 * **함수당**이다 — 한 화면이 위젯 3개를 그리면 위젯마다 이 함수를 부르므로, 위젯 합을
 * 줄이는 수단은 `only`(안 쓰는 표를 빼기)와 축 옵션(한 read 를 여럿이 나눠 쓰기)이다.
 */
export function buildTrendStatements(
  scope: TrendReadScope,
  opts?: TrendReadOptions,
): TrendStatement[] {
  const want = new Set(opts?.only ?? ALL_KEYS);
  const all: TrendStatement[] = [
    { key: "own", table: "summary_trend_own", sql: trendOwnSql(scope) },
    { key: "answers", table: "summary_trend_answers", sql: trendAnswersSql(scope) },
    { key: "brands", table: "summary_trend_brands", sql: trendBrandsSql(scope) },
    // 도메인 표는 **통째로** 인용 계열이다: 회차 스코프를 좁힌다(FILTER 가 아니라).
    { key: "domains", table: "summary_trend_domains", sql: trendDomainsSql(citationScopeOf(scope)) },
  ];
  return all.filter((st) => want.has(st.key));
}

type OwnDbRow = {
  axis: TrendOwnAxis;
  bucket: string | null;
  cycle_anchor_at: unknown;
  key_rows: unknown;
  monitored: unknown; tracked_answers: unknown; multi_answers: unknown;
  top1_answers: unknown; top3_answers: unknown; rank_sum: unknown; ranked_answers: unknown;
  own_mentions: unknown; own_positive: unknown; own_signals: unknown;
  comp_mentions: unknown; all_citations: unknown; own_citations: unknown;
  own_fallback_citations: unknown; tile_own_mentions: unknown; citing_answers: unknown;
  /** 0071 회차를 뺀 회차 집합의 모수. 뺄 회차가 없으면 문장이 이 열을 안 낸다. */
  cit_monitored?: unknown;
};

/**
 * 회차 anchor → ISO 문자열. 드라이버가 `timestamptz` 를 `Date` 로 줄 수도, 문자열로 줄
 * 수도 있어서(`postgres` 파서 설정에 달렸다) 한 곳에서 정규화한다. 호출부가 이 값을
 * **버킷 키**로 쓰므로(`bucketStart = slice(0,10)`) 표현이 흔들리면 점이 갈린다.
 */
function isoAnchor(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const bucketOf = (axis: string, v: string | null) =>
  axis === "total" || axis === "cycle" ? null : v;

const mapOwn = (r: OwnDbRow): TrendOwnRow => ({
  axis: r.axis,
  bucket: bucketOf(r.axis, r.bucket),
  cycleAnchorAt: isoAnchor(r.cycle_anchor_at),
  keyRows: num(r.key_rows),
  monitored: num(r.monitored),
  trackedAnswers: num(r.tracked_answers),
  multiAnswers: num(r.multi_answers),
  top1Answers: num(r.top1_answers),
  top3Answers: num(r.top3_answers),
  rankSum: num(r.rank_sum),
  rankedAnswers: num(r.ranked_answers),
  ownMentions: num(r.own_mentions),
  ownPositive: num(r.own_positive),
  ownSignals: num(r.own_signals),
  compMentions: num(r.comp_mentions),
  allCitations: num(r.all_citations),
  ownCitations: num(r.own_citations),
  ownFallbackCitations: num(r.own_fallback_citations),
  tileOwnMentions: num(r.tile_own_mentions),
  citingAnswers: num(r.citing_answers),
  // 열이 없으면(= 뺄 회차 없음) 인용 분모는 모수와 같다.
  citMonitored: r.cit_monitored == null ? num(r.monitored) : num(r.cit_monitored),
});

type AnswerDbRow = {
  axis: TrendAnswerAxis; bucket: string | null; cycle_anchor_at: unknown;
  key_rows: unknown; monitored: unknown; all_mentions: unknown;
  all_citations: unknown; has_any_brand: unknown;
};
type DomainDbRow = {
  axis: TrendDomainAxis; group_key: string | null; domain: string | null; country: string | null;
  key_rows: unknown; citations: unknown; citing_answers: unknown; owned_citations: unknown;
  is_ours: boolean | null; is_rest: unknown; rest_count: unknown;
  cycle_anchor_at: unknown;
  /** `scope.officialGroupKeys` 를 넘겼을 때만 문장이 이 열을 낸다. */
  official_citations?: unknown;
};

/** `axis='total'` 행이 없거나 그 행의 `keyRows` 가 0이면 그 표는 **비었다**. */
const totalKeyRows = (rows: Array<{ axis: string; keyRows: number }>): number =>
  rows.find((r) => r.axis === "total")?.keyRows ?? 0;

/**
 * 집계층 문장을 **병렬로** 발행한다(§4-1: Suspense 섹션이 병렬이면 wall 은 최장 문장에
 * 가깝다). `opts.only` 로 고른 표만 나간다 — 나머지는 빈 배열이다(읽지 않았다는 뜻이지
 * 데이터가 없다는 뜻이 아니다).
 */
export async function readTrendAggregates(
  scope: TrendReadScope,
  opts?: TrendReadOptions,
): Promise<TrendAggregates> {
  // 동기 컬럼 판정(0069 `comp_rank_sum`)을 **문장을 만들기 전에** 확정한다 —
  // column-availability.ts 계약 ①. 이것이 없으면 프로세스의 **첫 렌더만** 상수 0 술어로
  // 나가고 그 값이 캐시에 굳는다(그 모듈 머리 주석의 실측 사고와 같은 형태).
  // 확정된 true 는 영구 캐시라 두 번째 호출부터 왕복이 없다.
  await ensureColumnAvailability();
  // 문장마다 자기 트랜잭션 + `SET LOCAL statement_timeout`(`budgetedMirrorDb`) — 병렬성은
  // 그대로다. 예산을 명시적으로 `null` 로 끈 경우에만 원본 핸들을 쓴다.
  const budget = opts?.budget === null ? undefined : (opts?.budget ?? mirrorHeavyBudget("summaryRead"));
  const db = budgetedMirrorDb(getDb(), budget);
  const statements = buildTrendStatements(scope, opts);
  const results = await Promise.all(statements.map((st) => db.execute(st.sql)));
  const by = new Map<TrendStatementKey, unknown[]>();
  statements.forEach((st, i) => by.set(st.key, results[i] as unknown as unknown[]));
  const rowsOf = <T>(k: TrendStatementKey): T[] => (by.get(k) ?? []) as T[];

  const ownRows = rowsOf<OwnDbRow>("own").map(mapOwn);
  const answerRows: TrendAnswerRow[] = rowsOf<AnswerDbRow>("answers").map((r) => ({
    axis: r.axis,
    bucket: bucketOf(r.axis, r.bucket),
    cycleAnchorAt: isoAnchor(r.cycle_anchor_at),
    keyRows: num(r.key_rows),
    monitored: num(r.monitored),
    allMentions: num(r.all_mentions),
    allCitations: num(r.all_citations),
    hasAnyBrand: num(r.has_any_brand),
  }));
  const brandRows: TrendBrandRow[] = rowsOf<Record<string, unknown>>("brands").map((r) => {
    const byCountry = Number(r.by_country) === 0;
    const byEngine = Number(r.by_engine) === 0;
    const byCycle = Number(r.by_cycle) === 0;
    return {
      axis: byCountry ? "country" : byEngine ? "engine" : byCycle ? "cycle-brand" : "brand",
      country: byCountry ? ((r.country as string | null) ?? null) : null,
      engine: byEngine ? ((r.engine as string | null) ?? null) : null,
      cycleAnchorAt: byCycle ? isoAnchor(r.cycle_anchor_at) : null,
      brandName: (r.brand_name as string | null) ?? null,
      isRest: Number(r.is_rest) === 1,
      restCount: num(r.rest_count),
      keyRows: num(r.key_rows),
      isTracked: r.is_tracked === true,
      mentions: num(r.mentions),
      answers: num(r.answers),
      rankSum: num(r.rank_sum),
      rankedAnswers: num(r.ranked_answers),
      compRankSum: num(r.comp_rank_sum),
      compRankedAnswers: num(r.comp_ranked_answers),
      top3Answers: num(r.top3_answers),
      positive: num(r.positive),
      neutral: num(r.neutral),
      negative: num(r.negative),
      mixed: num(r.mixed),
      typeMention: num(r.type_mention),
      typeRecommendation: num(r.type_recommendation),
      typeComparison: num(r.type_comparison),
      typeDefinition: num(r.type_definition),
      typeFinalChoice: num(r.type_final_choice),
    } satisfies TrendBrandRow;
  });
  const domainRows: TrendDomainRow[] = rowsOf<DomainDbRow>("domains").map((r) => ({
    axis: r.axis,
    isRest: Number(r.is_rest) === 1,
    restCount: num(r.rest_count),
    keyRows: num(r.key_rows),
    groupKey: r.group_key,
    domain: r.domain,
    country: r.country ?? null,
    cycleAnchorAt: r.axis === "cycle" ? isoAnchor(r.cycle_anchor_at) : null,
    citations: num(r.citations),
    citingAnswers: num(r.citing_answers),
    ownedCitations: num(r.owned_citations),
    ...(scope.officialGroupKeys ? { officialCitations: num(r.official_citations) } : {}),
    isOurs: r.is_ours === true,
  }));

  // ── `empty` — **모수 표**(own·answers)가 비면 폴백이다 ────────────────────
  //
  // 판정 대상과 그 근거는 `TrendAggregates.empty` 주석이 정본이다. 요지: 모수 표의
  // `keyRows = 0` 만 "접기 미실행"과 동치이고, `brands`·`domains` 의 0 은 그 슬라이스에
  // 언급·인용이 없었다는 **정당한 0** 이다(실측 오폴백 셀 3개 — BE/IT × depth1).
  // 표 단위 부분 접힘은 접기가 4표를 한 tx 로 쓰므로 불가능하고(정규 경로
  // `swapGeneration` · 백필 `applyFoldTx`), 회차 단위
  // 부분 접힘은 읽기 전 `trendFoldPresent` 프로브가 잡는다.
  const has: Partial<Record<TrendStatementKey, boolean>> = {};
  if (by.has("own")) has.own = totalKeyRows(ownRows) > 0;
  if (by.has("answers")) has.answers = totalKeyRows(answerRows) > 0;
  const flags = Object.values(has);
  const empty = flags.length > 0 && flags.some((v) => v === false);

  return { own: ownRows, answers: answerRows, brands: brandRows, domains: domainRows, empty };
}

/** 테스트가 컴파일된 SQL 형태를 고정할 수 있게 술어 빌더를 노출한다. */
export const __testables = {
  cycleScope,
  trendWhere,
  funnelCol,
  ownedCitationExpr,
  trendOwnSql,
  trendAnswersSql,
  trendBrandsSql,
  trendDomainsSql,
};
