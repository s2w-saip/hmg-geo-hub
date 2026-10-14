import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import {
  fetchStandardKpiBrandTrend,
  fetchStandardKpiEngineTrend,
  fetchStandardKpiFirstPosition,
  fetchStandardKpiHeroSubKpis,
  fetchStandardKpiHeroSubKpisPrev,
  fetchStandardKpiTypes,
  fetchStandardKpiStanceDist,
  fetchStandardMentionCompetitorBrands,
  fetchStandardMentions,
} from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { STANCE_CARD_ENABLED } from "../_data/kpi-view";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredStandardLanguages,
  listMeasuredScopeMatrix,
  standardCollectionDates,
} from "@/lib/db/repositories/scope-aggregates";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { PendingCard, type MentionsViewData } from "../_components/mentions-view";
import { MentionsPromptsSection } from "../_components/mentions-prompts-section";
import { AnalysisFilterBar } from "../_components/analysis-filter-bar";
import { KpiTabs } from "../_components/kpi-tabs";
import { MentionKpiTab } from "../_components/kpi/mention-kpi-tab";
import { FavorabilityKpiTab } from "../_components/kpi/favorability-kpi-tab";
import { FirstRankKpiTab } from "../_components/kpi/first-rank-kpi-tab";
import {
  KPI_TAB_PARAM,
  isImplementedKpiTab,
  resolveKpiTab,
  type KpiTab,
} from "../_data/kpi-tab";
import {
  AnswerAnalysisBodySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  LastMeasuredPill,
  LastMeasuredPillSkeleton,
} from "@/components/dash/last-measured-pill";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import {
  fetchLatestAnchorDay,
  fetchPeriodCompare,
  fetchSelectableAnchorDates,
} from "@/lib/scope/server";
import { MENTION_COMPARE_METRICS } from "@/components/dash/period-delta-metrics";
import { PeriodDeltaLine } from "@/components/dash/period-delta-line";
import { resolveRequestComparePeriodShape } from "@/lib/period/compare-shape";
import { kstToday } from "@/components/dash/selectable-dates";
import { toPeriodDeltaView } from "@/lib/kpi/period-compare-view";
import { throwForPage } from "@/lib/hgh/errors";
import {
  afterEssentials,
  degrade,
  loadMentionBrandRows,
  loadMentionsAsOf,
  loadMentionsLive,
  loadSentimentTotals,
  loadTypesByBrand,
  mentionsDegraded,
  type MentionsContext,
} from "@/lib/hgh/adapters/mentions";
import {
  loadBrandTrend,
  loadEngineKpiTrend,
  loadFirstPosition,
  loadKpiHeroSubKpis,
  loadKpiHeroSubKpisPrev,
  loadStanceDist,
  loadTypeKpi,
  wasKpiTabDegraded,
} from "@/lib/hgh/adapters/kpi-tab";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { fetchPeriodCompareApi } from "@/lib/hgh/adapters/compare";

// KPI 탭 집계의 앱 예산(엔진 12s + 문장 상한 8s = 실효 최악 20s)이 플랫폼 기본
// 함수 시간제한(플랜별 10~15s)보다 크다. 플랫폼이 먼저 끊으면 예산 초과 시
// 추이만 내리는 degradedTrend 경로가 아예 뜨지 못하고 함수 타임아웃이 된다 —
// dashboard/page.tsx 와 같은 이유로 여유를 확보한다(2026-09-01 검증 지적).
export const maxDuration = 120;

// Data source (unit U6, D8): HGH_SOURCE_G2 = api -> the backend adapters (lib/hgh/adapters/
// mentions.ts, kpi-tab.ts, filters.ts, compare.ts) in the same shapes; legacy (default) -> the
// readers below, unchanged. api first render (D6): brands, summary, calendar and the overview
// trend first; the options, engines, types and the other trends after them (afterEssentials).
// Known differences: the adapter headers (DC-01/05/08/21, U6-N1..N6).

export default async function StandardAnswerAnalysisMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis");

  // The DimensionFilterPanel writes URL params (geography / engine /
  // promptContext); read them here and narrow the live aggregation.
  // D4: scope.brands는 filter.brand 기본값으로 자동 주입.
  const session = await getSession();
  const sp = await searchParams;
  // 2026-09-04 기획 수정 — 답변분석은 '기간 내 누적' 의미론을 쓴다(대시보드·
  // 웹사이트 KPI 의 스냅샷과 구분). 기간을 7일/30일로 바꿔도 숫자가 그대로였던
  // 원인이 스냅샷(기간 내 최신 배치) 선택이었다. cumulative 는 캐시 키에 들어간다.
  const filters = { ...readStandardFilters(sp, session?.user.scope), cumulative: true };
  // 탭도 같은 URL 에서 읽는다 — 서버(read)와 탭 바(write)가 같은 파서를 쓰므로
  // 미지값 폴백 규칙이 갈라지지 않는다.
  const kpiTab = resolveKpiTab(sp[KPI_TAB_PARAM]);
  const api: MentionsContext | null = isAnalysisApi("analysis", "global")
    ? { surface: "global", scope: session?.user.scope ?? null }
    : null;
  // Header pill source: the body aggregate's asOf (legacy) or the same brands call (api).
  const fetchMentionsHead = (f: StandardFilters): Promise<{ asOf: string | null } | null> =>
    api ? loadMentionsAsOf(f, api).then((asOf) => ({ asOf })) : fetchStandardMentions(f);

  // 2026-08-27 — 경계를 둘로 쪼갠다. 예전엔 무거운 언급 집계 하나가 필터바까지
  // 붙잡아, 필터를 바꿔 캐시 미스가 나면 **정작 만지려는 필터바가 사라진** 채
  // 화면 전체가 스켈레톤이 됐다. 필터바는 값싼 옵션 read 만 필요하므로 자기
  // 경계에서 먼저 뜨고, 본문은 뒤이어 스트리밍된다.
  //
  // 어느 경계도 re-key 하지 않는다 — 필터 적용 시 이전 결과가 그대로 남아 있다가
  // 좁혀진 롤업으로 스왑된다(스켈레톤 플래시 없음). 특히 필터바 경계는 마운트가
  // 유지되어야 Apply 스피너가 계속 보인다.
  //
  // 2026-08-28 — KPI 탭 본문은 **또 하나의 경계**다. 신규 회차 집계는 8s 가드가
  // 걸린 무거운 read 라, 기존 언급 본문과 한 경계에 묶으면 둘 다 그만큼 늦게 뜬다.
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      {/* 피그마 327:116 부제: "언급 분석 - <설명>" 한 줄. */}
      {/* QA 2차 #3 — 헤더 우측 = 측정 기준일 pill(대시보드 Overview 와 동일). */}
      <PageHeader
        title={t("title")}
        description={t("pageSubtitle", { tab: t("tabs.mentions"), description: t("mentions.description") })}
        // QA 2차 #3(제품 결정: 헤더 pill) — 헤더 우측은 대시보드 Overview 와 **같은**
        // LastMeasured pill 이다.
        actions={
          <Suspense fallback={<LastMeasuredPillSkeleton />}>
            <LastMeasuredPill asOf={fetchMentionsHead(filters).then((d) => d?.asOf ?? null)} />
          </Suspense>
        }
      />
      <FilterTransitionProvider>
        {/* 필터 박스 행. 2026-09-28 측정 개요 카드 제거(제품 결정)로 이 행은 필터
            박스 한 열이다 — 종전 QA 2차 #10 의 우측 열(개요 카드)이 없어졌다.
            2026-09-10 핫픽스 — sticky 는 **이 행 래퍼**가 소유한다. 패널에 sticky 를
            두면 포함 블록이 자기와 같은 높이의 grid 행이라 이동거리가 0 이고, 그대로
            스크롤돼 올라가 베타 배너를 덮었다. 래퍼는 페이지 flex 열의 직접 자식이라
            (대시보드 Overview 와 같은 구조) 이동거리가 본문 전체다. bg-background 는
            고정됐을 때 패널 뒤로 본문이 비쳐 지나가는 것을 막는다. sticky 는 `lg:`
            부터다(GNB·SNB 도 같은 lg 경계다). */}
        <div className="grid items-stretch gap-4 bg-background lg:sticky lg:top-24 lg:z-20">
          <Suspense fallback={<FilterBarSkeleton />}>
            <MentionsFilterBar filters={filters} scope={session?.user.scope} api={api} locale={locale} />
          </Suspense>
        </div>
        <KpiTabs active={kpiTab} />
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <div className="flex flex-col gap-6">
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsKpiBody filters={filters} tab={kpiTab} api={api} />
            </Suspense>
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsData filters={filters} api={api} locale={locale} />
            </Suspense>
          </div>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 옵션 read 만 소유(카탈로그 택소노미 + 측정 국가). 측정 기준일만
// 본문과 같은 집계에서 오는데, await 하지 않고 프로미스로 넘겨 중첩 경계에서
// 채운다(요청단위 dedup 이라 DB 왕복은 늘지 않는다).
async function MentionsFilterBar({
  filters,
  scope,
  api,
  locale,
}: {
  filters: StandardFilters;
  scope?: AllowedScope;
  api: MentionsContext | null;
  locale: string;
}) {
  if (api) {
    // F-1 options (after the D6 essentials) + F-2 calendar (an essential), same panel props.
    let options: Awaited<ReturnType<typeof loadPanelOptions>>;
    let dates: Awaited<ReturnType<typeof loadFilterDates>>;
    try {
      [options, dates] = await Promise.all([
        afterEssentials(filters, api, () =>
          loadPanelOptions({
            surface: "global",
            dateFrom: filters.dateFrom,
            dateTo: filters.dateTo,
            scope: scope ?? null,
            filters,
          }),
        ),
        loadFilterDates({ surface: "global", family: "mentions" }),
      ]);
    } catch (e) {
      throwForPage(e, locale);
    }
    return (
      <>
        <AnalysisFilterBar
          stage="mentions"
          scope={scope}
          catalogRows={options.catalogRows}
          geographyOptions={options.geographyOptions}
          languageOptions={options.languageOptions}
          optionMatrix={options.optionMatrix}
          collectionStartDay={dates.collectionStartDay}
          latestAnchorDay={dates.latestAnchorDay}
          selectableDates={dates.selectableDates}
          sticky={false}
        />
        <SectionDoneMarker id="standard-mention:filters" />
      </>
    );
  }
  // 브랜드 선택을 반영한 유효 스코프로 옵션을 좁힌다 (dashboard/page.tsx와 동일).
  const optionScope = scope ? narrowScopeBrands(scope, filters.brand) : undefined;
  // 옵션의 측정 창 = 화면의 기간 필터. 데이터와 같은 창을 봐야 죽은 옵션이 안 생긴다.
  const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const [catalogRows, geographyOptions, languageOptions, optionMatrix, collection] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(
      optionScope,
      undefined,
      true, // 표준(글로벌): 루트 카탈로그로 옵션 제한 — 데이터와 동일 국가 집합
      dateRange, // 측정 창도 데이터와 동일 — 창 밖 시장(EG 등)은 옵션에서 뺀다
    ),
    // 언어 옵션 (2026-09-03) — 대시보드와 **같은 함수·같은 optionScope**. 술어도
    // 공통(promptAxisPreds standard)이라 두 화면이 같은 URL 에서 같은 모집단을 낸다.
    // 2026-09-04: 국가(filters.region)로 **좁히지 않는다** — 실제 드롭다운 내용은
    // optionMatrix 를 draft 로 좁혀 만든다.
    listMeasuredStandardLanguages(optionScope, undefined, dateRange),
    // 옵션 의존 매트릭스 (브랜드 × 국가 × 언어) — 사용자 선택으로 좁히지 않은 조합표.
    // 적용된 브랜드(optionScope)로 좁히지 않고 계정 스코프 그대로 넘긴다. 패널이 draft 브랜드로
    // 좁히는 표라, 서버가 먼저 적용 브랜드로 자르면 다른 브랜드를 고르는 순간 국가가 0개가 된다
    // (2026-09-18: brand=Hyundai 적용 상태에서 Kia 만 고르면 국가 옵션 전멸).
    listMeasuredScopeMatrix(scope, dateRange),
    // 수집 시작일 — 기간 축 캘린더 min·프리셋 클램프(QA #19·#20). min/max 1행
    // 쿼리라 옵션 read 와 병렬로 붙여도 비용이 사실상 없다. 실패해도 필터바를
    // 깨뜨리지 않는다 — 값이 없으면 캘린더 제한이 없을 뿐이다(종전 동작).
    scope ? standardCollectionDates(scope).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <>
      <AnalysisFilterBar
        stage="mentions"
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        collectionStartDay={collection?.firstMeasuredAt?.toISOString() ?? null}
        // 기간 프리셋의 끝점 E — 최신 노출 회차 앵커일(GGMD-107 C2). 스위치 off 면
        // null 이고 프리셋은 오늘 기준 그대로다(종전 동작).
        latestAnchorDay={await fetchLatestAnchorDay("global", filters)}
        // 앵커 축(스펙 §5.1) — 회차가 있는 날짜만 달력에서 활성. 축 off 면
        // undefined 라 달력은 종전대로 전 날짜를 연다.
        // 언급 화면의 카드는 `aggregateMentionsFromMirror` = 느슨한 `'mentions'`.
        // 인용만 숨긴 회차의 언급 값은 정상이므로 그 날짜를 고를 수 있어야 한다.
        selectableDates={await fetchSelectableAnchorDates("global", filters, "mentions")}
        // sticky 소유자는 위 grid 행 래퍼다(패널은 그 행과 높이가 같아 이동거리 0).
        sticky={false}
      />
      <SectionDoneMarker id="standard-mention:filters" />
    </>
  );
}

// KPI 탭 본문 (노출률 / 점유율). 우호도·우선 노출도는 이번 범위 밖 — 탭은 만들되
// 자리만 잡아 둔다(PendingCard). 지면이 붙을 때 이 분기만 바뀐다.
async function MentionsKpiBody({
  filters,
  tab,
  api,
}: {
  filters: StandardFilters;
  tab: KpiTab;
  api: MentionsContext | null;
}) {
  const t = await getTranslations("answerAnalysis.mentions.kpi");
  if (!isImplementedKpiTab(tab)) {
    return <PendingCard title={t(`tabs.${tab}`)} label={t("pending")} />;
  }

  // ── 기간 비교 Δ — 탭마다 따로 부르지 않고 **여기서 한 번** 해소한다 ──────────
  //
  // 달력 월("이번 달"·"지난달")이면 MoM 정책을, 아니면 창 비교를 탄다. 판정 입력은 URL 의
  // 날짜쌍뿐이다 — 프리셋 이름은 URL 에 안 실린다(`resolveCalendarMonths` 머리 주석).
  // 지표는 언급 계열 전부를 요청한다: 탭별 히어로 슬롯은 자기 지표 하나만 골라 쓰고
  // (`PeriodDeltaSlot`), 아래 줄이 나머지를 함께 그린다. 세 탭이 **같은 인자**로 부르므로
  // 캐시 키가 하나다(왕복이 탭 수만큼 늘지 않는다).
  const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo, {
    area: "analysis",
    surface: "global",
  });
  const periodDays = shape.days ?? undefined;
  const periodCompare = api
    ? await degrade(
        "standardPeriodCompare",
        () =>
          afterEssentials(filters, api, () =>
            fetchPeriodCompareApi(filters, { ...api, kind: shape.kind, metrics: MENTION_COMPARE_METRICS }),
          ),
        null,
      )
    : await fetchPeriodCompare(filters, {
        surface: "global",
        family: "mention",
        kind: shape.kind,
        metrics: MENTION_COMPARE_METRICS,
        ...(shape.months ? { months: shape.months } : {}),
        ...(shape.weeks ? { weeks: shape.weeks } : {}),
      });
  // 달력 월일 때만 줄을 그린다 — 창 비교는 카드·히어로의 칩이 이미 말하고 있다.
  const monthLine =
    shape.months && periodCompare ? (
      <PeriodDeltaLine
        view={toPeriodDeltaView(periodCompare, {
          days: periodDays ?? 0,
          kind: shape.kind,
          // 달력 주에서 '이번 주' 와 '지난주' 를 가른다(W4) — 지난주의 비교 대상은 전전주다.
          curLo: shape.weeks?.cur.lo ?? shape.months?.cur.lo ?? filters.dateFrom,
          todayKst: kstToday(),
        })}
      />
    ) : null;

  // PR ③(2026-09-02) — 우호도·우선 노출도는 지표 성질이 달라 자기 탭 컴포넌트를 갖는다.
  // 스트리밍·dedup 규약은 아래 노출률/점유율과 동일(프로미스를 그대로 넘긴다).
  if (tab === "first-rank") {
    // legacy first: its JSX stays hmg-geo main verbatim (the upstream wiring test reads the first
    // <FirstRankKpiTab> of this file).
    if (!api) {
      return (
        <>
          <FirstRankKpiTab
            firstPosition={fetchStandardKpiFirstPosition(filters)}
            // 브랜드별 값은 노출률·점유율 탭과 같은 리더(Overview 경쟁사 행)에서 온다
            // (2026-09-28 제품 책임자 A안). `null` 이면 미러 값 그대로다(격자 off·degrade).
            competitorValues={fetchStandardMentionCompetitorBrands(filters)}
            periodCompare={periodCompare}
            periodDays={periodDays}
          />
          {monthLine}
        </>
      );
    }
    // api: competitorValues null, the competitor rows and their values come from the same
    // /v1/mentions/brands (M-1) source, so there is nothing to overlay (U6-N6).
    return (
      <>
        <FirstRankKpiTab
          firstPosition={loadFirstPosition(filters, api)}
          competitorValues={null}
          periodCompare={periodCompare}
          periodDays={periodDays}
        />
        {monthLine}
      </>
    );
  }
  if (tab === "favorability") {
    if (api) {
      const prevApi = loadKpiHeroSubKpisPrev(filters, api, "favorability");
      return (
        <>
          <FavorabilityKpiTab
            subKpis={loadKpiHeroSubKpis(filters, api, "favorability")}
            prevSubKpis={prevApi.then((p) => p?.sub ?? null)}
            prevBasisDate={prevApi.then((p) => p?.asOf ?? null)}
            engineTrend={loadEngineKpiTrend(filters, api)}
            sentimentTotals={loadSentimentTotals(filters, api)}
            stanceDist={STANCE_CARD_ENABLED ? loadStanceDist(filters, api) : null}
            typeKpi={loadTypeKpi(filters, api)}
            periodCompare={periodCompare}
            periodDays={periodDays}
          />
          {monthLine}
        </>
      );
    }
    const data = fetchStandardMentions(filters);
    const prev = fetchStandardKpiHeroSubKpisPrev(filters, "favorability");
    return (
      <>
        <FavorabilityKpiTab
        subKpis={fetchStandardKpiHeroSubKpis(filters, "favorability")}
        prevSubKpis={prev.then((p) => p?.sub ?? null)}
        prevBasisDate={prev.then((p) => p?.asOf ?? null)}
        // 추이 주 격자 축 — 노출률/점유율 탭과 **같은 축**이어야 한다(아래 주석).
        engineTrend={fetchStandardKpiEngineTrend(filters, { weekAxis: "S2.mentionTrend" })}
        sentimentTotals={data.then((d) => d?.sentimentTotals ?? null)}
        // 답변 축(0072) — 발생 축과 **다른 집계**다. 기존 감정 집계는 손대지 않았고,
        // 스탠스가 없으면 null 이 흘러 카드가 "수집 대기"로 떨어진다.
        stanceDist={STANCE_CARD_ENABLED ? fetchStandardKpiStanceDist(filters) : null}
        typeKpi={fetchStandardKpiTypes(filters)}
          periodCompare={periodCompare}
          periodDays={periodDays}
        />
        {monthLine}
      </>
    );
  }
  const metric = tab === "sov" ? "sov" : "exposure";
  if (api) {
    // Same props from the backend adapters. competitorValues null: the competitor rows and their
    // values come from the same /v1/mentions/brands call (U6-N6).
    const prevApi = loadKpiHeroSubKpisPrev(filters, api, metric);
    const subKpisApi = loadKpiHeroSubKpis(filters, api, metric);
    const typeKpiApi = loadTypeKpi(filters, api);
    return (
      <>
        <MentionKpiTab
          metric={metric}
          subKpis={subKpisApi}
          prevSubKpis={prevApi.then((p) => p?.sub ?? null)}
          brands={loadMentionBrandRows(filters, api)}
          competitorValues={null}
          engineTrend={loadEngineKpiTrend(filters, api)}
          brandTrend={loadBrandTrend(filters, api)}
          typeKpi={typeKpiApi}
          typesByBrand={loadTypesByBrand(filters, api)}
          prevBasisDate={prevApi.then((p) => p?.asOf ?? null)}
          periodCompare={periodCompare}
          periodDays={periodDays}
          // B034: 빈 히어로·유형 막대가 "측정 없음"이 아니라 일시 실패인지(요청 스코프 표식).
          // 표식은 그 집계가 끝난 **뒤에만** 유효하므로 같은 프로미스에 이어 붙인다(추가 조회 0,
          // citation/page.tsx 의 dataDegraded 와 같은 짝).
          heroDegraded={subKpisApi.then(() => wasKpiTabDegraded("hero"))}
          typeKpiDegraded={typeKpiApi.then(() => wasKpiTabDegraded("types"))}
        />
        {monthLine}
      </>
    );
  }

  // ⚠️ 여기서 await 하지 않는다 — **프로미스를 그대로 넘긴다**(2026-09-02).
  //
  // 종전에는 이 6개를 `Promise.all` 하나로 묶어 await 했다. 경계가 하나뿐이라
  // 가장 느린 집계(엔진 추이 ~10.8s)가 끝날 때까지 **지면 전체가 대기**했고, 그
  // 하나가 예산에 걸리면 스칼라·표까지 같이 비었다. 실측 개별 소요는 스냅샷 ~1s ·
  // 유형 4.2s · 브랜드추이 7.5s · 엔진 10.8s 로 최대 10배 차이가 난다.
  //
  // MentionKpiTab 이 각 prop 을 자기 <Suspense> 경계 안에서 `use()` 로 풀므로,
  // 먼저 끝난 집계부터 개별 스트리밍된다. 여기서 await 하면 그 분리가 무의미해진다.
  //
  // dedup: 이 페처들은 전부 요청단위 dedup(`requestDeduped`)이라, 아래 본문 경계
  // (MentionsData)·필터바 슬롯이 같은 필터로 **같은 페처**를 다시 불러도 DB 왕복은
  // 1회다. 여러 섹션이 같은 프로미스 인스턴스를 나눠 쓰는 것도 같은 취지다.
  // (아래 Sub KPI 두 개만 예외 — 파트가 달라 전량 셀과 별도로 돈다. 이유는 그 주석.)
  //
  // ⚠️ 히어로는 **전량 Sub KPI 를 부르지 않는다**(2026-09-02).
  //
  // 이 탭이 Sub KPI 에서 읽는 값은 `kpiHero` 하나뿐이다 — 노출률은 Q1(answers),
  // 점유율은 Q1+Q2(mentions). 그런데 `fetchStandardSubKpis` 는 탭과 무관하게
  // Q1~Q5 를 전부 돌린다(로컬 warm 실측 17.0s, 콜드 ~30s). 아래 본문 경계
  // (MentionsData)는 감정·프롬프트까지 실제로 읽으므로 전량이
  // 맞지만, 히어로가 그것을 함께 기다릴 이유가 없다.
  //
  // 파트 표(어느 탭이 어느 문장을 읽는지)와 그 근거는
  // `lib/scope/kpi-tab-budget.ts::KPI_TAB_SUB_KPI_PARTS` 가 정본이다.
  const data = fetchStandardMentions(filters);
  const subKpis = fetchStandardKpiHeroSubKpis(filters, metric);
  const prevSubKpis = fetchStandardKpiHeroSubKpisPrev(filters, metric);
  return (
    <>
      <MentionKpiTab
        metric={metric}
      subKpis={subKpis}
      prevSubKpis={prevSubKpis.then((p) => p?.sub ?? null)}
      brands={data.then((d) => d?.brands ?? [])}
      // 브랜드별 **값**은 Overview 경쟁사 줄과 같은 리더에서 온다(제품 책임자 2026-09-20 지시 ①).
      // 행 목록·정렬·상한은 위 `brands`(미러) 그대로다 — 지면 목적이 달라 선정 기준은
      // 맞추지 않는다. `null` 이면 오버레이 없이 종전 값이다(격자 off·degrade).
      competitorValues={fetchStandardMentionCompetitorBrands(filters)}
      // 히어로 추이 + 엔진별 섹션 + 유형별 추이. null = 예산 초과 → 그 지면만 대체 문구.
      //
      // ⚠️ `weekAxis` 는 이 지면의 추이가 **아래 "주별 브랜드 언급 수" 차트와 같은 축**을
      //    쓰게 한다(2026-09-18). 그 차트는 이미 화면 키 `S2.mentionTrend` 로 원장 회차
      //    주를 타는데 여기 3종만 측정시각 주라, 같은 화면에서 같은 회차가 다른 주에
      //    찍혔다(실측: 09-13 회차가 9/14 주와 9/7 주로 쪼개지고, 9/7 주에서는 09-08
      //    회차가 dedup 에 밀려 소멸). 대시보드 경쟁사 행은 이 인자를 안 넘긴다 =
      //    종전 축 유지(`server.ts::KpiTabWeekAxis` 주석이 정본).
      engineTrend={fetchStandardKpiEngineTrend(filters, { weekAxis: "S2.mentionTrend" })}
      // 경쟁사 스파크라인 — 직전 4회차면 충분하므로 창을 28일로 좁힌다(창이 지배 비용).
      brandTrend={fetchStandardKpiBrandTrend(filters, { weekAxis: "S2.mentionTrend" })}
      typeKpi={fetchStandardKpiTypes(filters)}
      // 유형 스택의 `당사 · 경쟁사 · 기타` 3분할 원천. 이미 받아 온 언급 집계에
      // 들어 있으므로 새 쿼리를 만들지 않는다.
      typesByBrand={data.then((d) => d?.typesByBrand ?? null)}
      prevBasisDate={prevSubKpis.then((p) => p?.asOf ?? null)}
        periodCompare={periodCompare}
        periodDays={periodDays}
      />
      {monthLine}
    </>
  );
}

// 공통 하단 "프롬프트 및 답변"(2026-09-02) — 탭과 무관하게 언급 집계 하나만 기다린다.
// 요약 카드·헤드투헤드·감정/유형 카드는 탭이 담당하므로 표준 표면에서 빠졌다
// (website/project 는 MentionsView 그대로 — 스펙 회귀 기준). 빈 상태 판정은 이
// 경계 안에서만 — 필터바는 위 경계에 남아 데이터가 없어도 필터를 바꿀 수 있다.
async function MentionsData({
  filters,
  api,
  locale,
}: {
  filters: StandardFilters;
  api: MentionsContext | null;
  locale: string;
}) {
  let data: MentionsViewData | null;
  if (api) {
    try {
      data = await loadMentionsLive(filters, api);
    } catch (e) {
      throwForPage(e, locale);
    }
  } else {
    data = await fetchStandardMentions(filters);
  }
  return (
    <>
      {/* B034: api 원천에서 null 이 일시 실패(globalMentions 표식)면 "데이터 없음" 대신 기존 degraded 문구. */}
      <MentionsPromptsSection data={data} degraded={api ? mentionsDegraded(api).data : false} />
      <SectionDoneMarker id="standard-mention:data" />
    </>
  );
}
