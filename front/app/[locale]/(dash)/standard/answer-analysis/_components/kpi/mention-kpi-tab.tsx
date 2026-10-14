"use client";

// 노출률·점유율 탭의 본문 조립 — **metric prop 하나만 다르다**(스펙 SHALL).
// 서버는 집계 결과를 그대로 넘기고, view-model 파생은 `_data/kpi-view.ts` 의
// 순수 함수가 담당한다(두 탭이 조용히 갈라지지 않도록 분기를 한 곳에 모은 것).
//
// ── 2026-09-02: 섹션별 스트리밍 ───────────────────────────────────────────────
//
// 종전에는 page.tsx 가 6개 집계를 `Promise.all` 하나로 묶어 await 한 뒤 이 탭을
// 렌더했다. 그래서 **가장 느린 하나가 끝날 때까지 지면 전체가 대기**했다
// (프로덕션 실측: 스냅샷 ~1s · 유형 4.2s · 브랜드추이 7.5s · 엔진 10.8s →
//  화면은 항상 10.8s+ 뒤에야 한꺼번에 나타났고, 예산에 걸리면 통째로 비었다).
//
// 이제 각 prop 은 **값 또는 프로미스**를 받는다(`Awaitable<T>`). 서버가 await 하지
// 않고 프로미스를 그대로 넘기면, 각 섹션이 자기 <Suspense> 경계 안에서 `use()` 로
// 풀어 **준비되는 대로 개별 스트리밍**된다. 값이 오면(단위 테스트·mock) `use` 를
// 부르지 않으므로 동기 렌더 그대로다 — 두 경로가 같은 마크업을 낸다.
//
// 요청단위 dedup 은 깨지지 않는다: 같은 프로미스 인스턴스를 여러 섹션이 나눠 쓰고,
// 서버 페처는 `requestDeduped`(lib/request-dedupe.ts)로 접힌다. DB 왕복은 1회다.

import { Suspense, use, useMemo, useState } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { useTranslations } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BrandTrendResult,
  EngineKpiTrend,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type {
  CompetitorBrandValue,
  MentionsBrandLive,
  MentionTypesByBrand,
} from "@/lib/scope/result-adapter";
import {
  KpiChartSlotSkeleton,
  KpiCompetitorTableSkeleton,
  KpiHeroSkeleton,
  KpiSectionSkeleton,
} from "@/components/dash/section-skeleton";
import {
  brandTrendChart,
  competitorKpiRows,
  coverageEntries,
  deltaPp,
  engineCompetitorBars,
  engineKpiBars,
  engineKpiSeries,
  engineTrendSeriesAvailable,
  heroTrendAvailable,
  overviewDeltaFromSlots,
  kpiHero,
  kpiTrendPoints,
  trendAxis,
  trendCoverage,
  typeComboPoints,
  typeKpiBars,
  type CompetitorKpiRow,
  type KpiMetric,
  type TypeScope,
} from "../../_data/kpi-view";
import { DeltaBadge, pctText } from "./kpi-bits";
import { KpiHero } from "./kpi-hero";
import { KpiTrendChart } from "./kpi-trend-chart";
import { BrandTrendChart } from "./brand-trend-chart";
import { CompetitorKpiTable } from "./competitor-kpi-table";
import { EngineKpiSection } from "./engine-kpi-section";
import { TypeKpiSection, TypeKpiTrend } from "./type-kpi-section";
import { PeriodDeltaSlot } from "@/components/dash/period-delta-slot";
import { compareMetricForKpiTab } from "@/components/dash/period-delta-metrics";
import type { CompareResult } from "@/lib/kpi/period-compare";

/** 값 또는 프로미스. 프로미스면 그 섹션만 자기 경계에서 늦게 채워진다. */
export type Awaitable<T> = T | Promise<T>;

function isThenable<T>(v: Awaitable<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * `use()` 는 조건부 호출이 허용된 유일한 훅이다(React 공식 — 훅 규칙의 예외).
 * 값이면 그대로 돌려주므로 프로미스를 안 쓰는 호출부(테스트·mock)는 서스펜드하지
 * 않는다.
 */
export function useAwaited<T>(v: Awaitable<T>): T {
  return isThenable(v) ? use(v) : v;
}

type TabProps = {
  metric: KpiMetric;
  subKpis: Awaitable<StandardSubKpis | null>;
  prevSubKpis: Awaitable<StandardSubKpis | null>;
  brands: Awaitable<MentionsBrandLive[]>;
  /**
   * 브랜드별 **값**의 정본 — Overview 경쟁사 줄과 같은 리더가 낸 행들
   * (`server.ts::fetchStandardMentionCompetitorBrands`). `null`·미전달이면 종전대로
   * 위 `brands`(미러)의 값을 쓴다. **행 목록은 여기서 오지 않는다** — 값만 덮는다.
   */
  competitorValues?: Awaitable<CompetitorBrandValue[] | null>;
  /** null = 그 집계만 degrade(예산 초과). 나머지 지면은 그대로 그린다. */
  engineTrend: Awaitable<EngineKpiTrend | null>;
  brandTrend: Awaitable<BrandTrendResult | null>;
  typeKpi: Awaitable<TypeKpi | null>;
  /**
   * 브랜드별 유형 신호 합(스냅샷) — 유형 섹션의 `당사 · 경쟁사 · 기타` 3분할
   * 스택의 원천. 경쟁사 표와 **같은 소스**(MentionsLive)라 브랜드명이 그대로 맞는다.
   */
  typesByBrand: Awaitable<MentionTypesByBrand | null>;
  prevBasisDate: Awaitable<string | null>;
  /**
   * 유형 섹션 토글의 초기값. 화면은 지정하지 않는다(기본 "자사만") — 렌더
   * 테스트가 "타사 포함" 분기를 밟기 위한 seam 이다(재검증 C7).
   */
  initialTypeScope?: TypeScope;
  /**
   * ② 경쟁사 분석 섹션의 선택 초기값(복수). 화면은 지정하지 않는다(기본 없음) —
   * initialTypeScope 와 같은 이유의 렌더 테스트 seam 이다.
   */
  initialCompetitors?: string[];
  /** ④ 멘션 유형별 섹션의 선택 초기값(단일). 같은 성격의 seam. */
  initialTypeCompetitor?: string | null;
  /**
   * 기간 비교 Δ (GGMD-107 지면 #5 글로벌 언급 히어로). `null`·미전달이면 종전 Δ 그대로.
   * 판정은 `PeriodDeltaSlot` 한 곳에서만 한다.
   */
  periodCompare?: readonly CompareResult[] | null;
  /** 선택된 구간의 길이(일) — 억제 캡션 입력. */
  periodDays?: number;
  /**
   * `subKpis` 의 빈 값이 **일시 실패**인가(= 측정 없음이 아니라 지연, B034). 판정은 서버의
   * 요청 스코프 표식이라 페이지가 같은 집계 뒤에 이어 붙여 넘긴다. 참이면 히어로 아래에 기존
   * degraded 문구 한 줄. 미전달이면 종전 그대로다.
   */
  heroDegraded?: Awaitable<boolean>;
  /** `typeKpi` 의 null 이 일시 실패인가(B034) — 유형 막대 자리의 "데이터 없음" 대신 기존 degraded 문구. */
  typeKpiDegraded?: Awaitable<boolean>;
};

export function MentionKpiTab({
  metric,
  subKpis,
  prevSubKpis,
  brands,
  competitorValues,
  engineTrend,
  brandTrend,
  typeKpi,
  typesByBrand,
  prevBasisDate,
  initialTypeScope,
  initialCompetitors,
  initialTypeCompetitor,
  periodCompare,
  periodDays,
  heroDegraded,
  typeKpiDegraded,
}: TabProps) {
  // 2026-09-10 QA 2차 #6(고객 기대값): "경쟁사 분석(노출률), 멘션 유형별 노출은
  // 각각 경쟁사 선택을 할 수 있는 구조로 따로 작동해야함(연계성 없음)."
  // 종전에는 상태가 **하나**였고 세 섹션이 그것을 나눠 썼다(디자인 327:369) —
  // 그래서 한쪽 드롭다운이 다른 두 섹션을 함께 바꿨다. 이제 섹션마다 자기 상태를
  // 갖고, ③ AI 엔진별은 선택을 아예 받지 않는다.
  //
  // 두 상태 모두 모든 <Suspense> 경계보다 **위**에 남긴다: 아래 섹션이 늦게
  // 도착해도 선택이 리셋되지 않고, 경계가 다시 서스펜드해도 값이 유지된다.
  // URL 축으로는 올리지 않는다(제품 책임자 D7) — 지금은 서버 왕복이 0 이라 즉각 반응한다.
  const [competitorSelection, setCompetitorSelection] = useState<string[]>(
    () => initialCompetitors ?? [],
  );
  const [typeCompetitor, setTypeCompetitor] = useState<string | null>(
    initialTypeCompetitor ?? null,
  );

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      {/* ① 히어로 스칼라 — 스냅샷(Sub KPI)만 기다린다. 가장 먼저 뜬다. */}
      <Suspense fallback={<KpiHeroSkeleton />}>
        <HeroBlock
          metric={metric}
          subKpis={subKpis}
          prevSubKpis={prevSubKpis}
          prevBasisDate={prevBasisDate}
          brands={brands}
          competitorValues={competitorValues}
          brandTrend={brandTrend}
          engineTrend={engineTrend}
          periodCompare={periodCompare}
          periodDays={periodDays}
          heroDegraded={heroDegraded}
        />
      </Suspense>

      {/* ② 경쟁사 표 — 언급 집계 + 스파크라인(브랜드 추이). */}
      <Suspense fallback={<KpiCompetitorTableSkeleton />}>
        <CompetitorBlock
          metric={metric}
          subKpis={subKpis}
          brands={brands}
          competitorValues={competitorValues}
          brandTrend={brandTrend}
          selected={competitorSelection}
          onSelectedChange={setCompetitorSelection}
        />
      </Suspense>

      {/* ③ AI 엔진별 — 엔진 추이 집계 하나(이 지면에서 가장 느리다).
          경쟁사 선택은 넘기지 않는다(QA 2차 #6): 당사 · 경쟁사 평균만 그린다. */}
      <Suspense fallback={<KpiSectionSkeleton />}>
        <EngineBlock metric={metric} engineTrend={engineTrend} />
      </Suspense>

      {/* ④ 멘션 유형별 — 유형 집계 + 언급 집계. 우측 콤보만 엔진 추이를 더 기다린다. */}
      <Suspense fallback={<KpiSectionSkeleton />}>
        <TypeBlock
          metric={metric}
          subKpis={subKpis}
          typeKpi={typeKpi}
          typesByBrand={typesByBrand}
          engineTrend={engineTrend}
          competitor={typeCompetitor}
          onPickCompetitor={setTypeCompetitor}
          initialScope={initialTypeScope}
          typeKpiDegraded={typeKpiDegraded}
        />
      </Suspense>
    </div>
    </TooltipProvider>
  );
}

// ─── ① 히어로 ────────────────────────────────────────────────────────────────
// 좌측 스칼라·Δ·게이지는 스냅샷에서만 온다. 우측 추이와 경쟁사 미니 카드는 더 느린
// 집계에서 오므로 **중첩 경계**로 흘려보낸다(카드 자체는 바로 그려진다).
function HeroBlock({
  metric,
  subKpis,
  prevSubKpis,
  prevBasisDate,
  brands,
  competitorValues,
  brandTrend,
  engineTrend,
  periodCompare,
  periodDays,
  heroDegraded,
}: Pick<
  TabProps,
  | "metric"
  | "subKpis"
  | "prevSubKpis"
  | "prevBasisDate"
  | "brands"
  | "competitorValues"
  | "brandTrend"
  | "engineTrend"
  | "periodCompare"
  | "periodDays"
  | "heroDegraded"
>) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const sub = useAwaited(subKpis);
  // `undefined` 면 `use()` 를 부르지 않는다(useRows 의 competitorValues 와 같은 이유).
  const degraded = useAwaited(heroDegraded ?? false);
  const hero = useMemo(() => kpiHero(sub, metric), [sub, metric]);

  return (
    <>
      <KpiHero
        metric={metric}
        hero={hero}
        // Δ 배지와 기준일 문구는 **다른 집계**(sub-kpis-prev)라 따로 흘려보낸다 —
        // 실측(로컬 콜드)에서 이 둘을 한 경계에 묶었을 때 게이지가 30s+ 늦었다.
        deltaSlot={
          <Suspense fallback={null}>
            <HeroDelta
              metric={metric}
              prevSubKpis={prevSubKpis}
              engineTrend={engineTrend}
              ownPct={hero.pct}
              periodCompare={periodCompare}
              periodDays={periodDays}
            />
          </Suspense>
        }
        competitorsSlot={
          <Suspense fallback={null}>
            <HeroCompetitors
              metric={metric}
              brands={brands}
              competitorValues={competitorValues}
              brandTrend={brandTrend}
              ownPct={hero.pct}
            />
          </Suspense>
        }
        trendSlot={
          <Suspense fallback={<KpiChartSlotSkeleton className="h-52" />}>
            <HeroTrend
              metric={metric}
              brands={brands}
              competitorValues={competitorValues}
              brandTrend={brandTrend}
              engineTrend={engineTrend}
              ownPct={hero.pct}
            />
          </Suspense>
        }
      />
      {/* 스칼라 집계가 일시 실패했으면(B034) "—" 가 "측정 없음"으로 읽히지 않게 기존 degraded
          문구를 히어로 아래 캡션 자리에 한 줄 둔다. 정상 경로에서는 아무것도 그리지 않는다. */}
      {degraded ? <p className="-mt-4 text-[11px] text-muted-foreground">{t("degraded")}</p> : null}
      <Suspense fallback={null}>
        <HeroDeltaBasis
          metric={metric}
          prevBasisDate={prevBasisDate}
          engineTrend={engineTrend}
        />
      </Suspense>
      <SectionDoneMarker id="standard-mention:kpi-hero" />
    </>
  );
}

/**
 * Δ 배지.
 *
 * **노출률은 Overview 와 같은 규칙**(값이 있는 마지막 두 자리의 차 = 직전 회차 대비)을
 * 같은 배열(`exposureSlots`)에 걸어 낸다 — 카드 값이 회차 스냅샷으로 옮겨 갔으므로
 * 비교 대상도 같은 축 위의 점이어야 한다(`kpi-view.ts::exposureDeltaFromSlots` 머리 주석).
 * 점유율은 종전 그대로 누적 스냅샷 대비다(사실표에 그 축이 없다 = 후속 범위).
 */
function HeroDelta({
  metric,
  prevSubKpis,
  engineTrend,
  ownPct,
  periodCompare,
  periodDays,
}: Pick<
  TabProps,
  "metric" | "prevSubKpis" | "engineTrend" | "periodCompare" | "periodDays"
> & {
  ownPct: number | null;
}) {
  const prev = useAwaited(prevSubKpis);
  const engine = useAwaited(engineTrend);
  const prevHero = useMemo(() => kpiHero(prev, metric), [prev, metric]);
  // 노출률·점유율 **둘 다** Overview 와 같은 규칙(값 있는 마지막 두 자리)이다.
  const cycleDelta = useMemo(
    () =>
      overviewDeltaFromSlots(
        engine?.overviewDeltaSlots,
        metric === "exposure" ? "visibility" : "shareOfVoice",
      ),
    [metric, engine],
  );
  return (
    <>
      <PeriodDeltaSlot
        compare={periodCompare}
        metric={compareMetricForKpiTab(metric)}
        days={periodDays}
        size="md"
        withCaption
        fallback={
          <DeltaBadge
            value={cycleDelta ? cycleDelta.pp : prev ? deltaPp(ownPct, prevHero.pct) : null}
            unit="pp"
            size="md"
          />
        }
      />
      <SectionDoneMarker id="standard-mention:kpi-hero-delta" />
    </>
  );
}

/**
 * Δ 의 기준일 문구. 히어로 카드 **밖**(아래)이라 별도 경계다.
 *
 * **문구는 실제 비교 기준을 말해야 한다**(2026-09-20 회귀 수리). 노출률이 직전 회차
 * 대비로 바뀌었는데 각주만 "기간 첫 측정일" 로 남아 있으면, 배지와 각주가 서로 다른
 * 비교를 말하게 된다 — 값보다 고치기 어려운 종류의 오류다(숫자는 맞고 설명이 틀리다).
 */
function HeroDeltaBasis({
  metric,
  prevBasisDate,
  engineTrend,
}: Pick<TabProps, "metric" | "prevBasisDate" | "engineTrend">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const basis = useAwaited(prevBasisDate);
  const engine = useAwaited(engineTrend);
  const cycleDelta = overviewDeltaFromSlots(
    engine?.overviewDeltaSlots,
    metric === "exposure" ? "visibility" : "shareOfVoice",
  );
  if (cycleDelta) {
    return (
      <p className="-mt-4 text-[11px] text-muted-foreground">
        {t("hero.deltaBasisCycle", { date: cycleDelta.basisDate })}
      </p>
    );
  }
  if (!basis) return null;
  return (
    <p className="-mt-4 text-[11px] text-muted-foreground">
      {t("hero.deltaBasis", { date: basis })}
    </p>
  );
}

/** 히어로 좌측의 경쟁사 미니 카드(점유율 탭). 언급 집계 + 브랜드 추이. */
function HeroCompetitors({
  metric,
  brands,
  competitorValues,
  brandTrend,
  ownPct,
}: Pick<TabProps, "metric" | "brands" | "competitorValues" | "brandTrend"> & {
  ownPct: number | null;
}) {
  const rows = useRows({ metric, brands, competitorValues, brandTrend, ownPct });
  const competitors = rows.filter((r) => !r.isTracked);
  if (competitors.length === 0)
    return <SectionDoneMarker id="standard-mention:kpi-hero-competitors" />;
  // QA #15 — 정렬 없이 앞 4개를 자르면 원래 순서(원자료 순서)에 좌우된다.
  // 값(pct) 내림차순으로 상위 4개를 보여준다. null 은 "값 없음"이라 뒤로 보낸다.
  const topCompetitors = [...competitors]
    .sort((a, b) => {
      if (a.pct == null && b.pct == null) return 0;
      if (a.pct == null) return 1;
      if (b.pct == null) return -1;
      return b.pct - a.pct;
    })
    .slice(0, 4);
  return (
    <div className="grid grid-cols-2 gap-2">
      {topCompetitors.map((c) => (
        <div key={c.brand} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
          <div className="truncate text-xs text-muted-foreground">{c.brand}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl leading-none font-semibold tabular-nums">{pctText(c.pct)}</span>
            <DeltaBadge value={c.wowPp} unit="pp" />
          </div>
        </div>
      ))}
      <SectionDoneMarker id="standard-mention:kpi-hero-competitors" />
    </div>
  );
}

/**
 * 히어로 우측 추이. 점유율 탭은 다중 브랜드 라인(브랜드 추이 집계), 노출률 탭은
 * 당사 단일 라인(엔진 추이 집계). 브랜드 추이가 degrade 되면 단일 라인으로
 * 폴백한다 — 지면을 통째로 비우는 것보다 당사 추이라도 보이는 편이 낫다.
 */
function HeroTrend({
  metric,
  brands,
  competitorValues,
  brandTrend,
  engineTrend,
  ownPct,
}: Pick<
  TabProps,
  "metric" | "brands" | "competitorValues" | "brandTrend" | "engineTrend"
> & {
  ownPct: number | null;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const engine = useAwaited(engineTrend);
  const trend = useAwaited(brandTrend);
  const rows = useRows({ metric, brands, competitorValues, brandTrend: trend, ownPct });

  const trendPoints = useMemo(() => kpiTrendPoints(engine, metric), [engine, metric]);
  // 판정은 **그리는 원천**의 가용성이다(`heroTrendAvailable` 머리 주석). 격자 on 이면 점은
  // 집계층 배열에서 오므로 미러 추이 단계의 degrade 가 이 패널을 막지 않는다.
  const trendUnavailable = !heroTrendAvailable(engine);
  const heroBrandTrend = useMemo(
    () => brandTrendChart(rows, trend, metric),
    [rows, trend, metric],
  );

  // 세 경로 전부 마커를 낸다 — "이 슬롯의 집계가 도착했다"가 표식의 뜻이다.
  const done = <SectionDoneMarker id="standard-mention:kpi-hero-trend" />;
  if (metric === "sov" && heroBrandTrend.series.length > 0) {
    // 브랜드 추이는 엔진 추이와 **다른 집계**라 엔진 쪽이 degrade 돼도 살아 있다.
    return (
      <>
        <BrandTrendChart metric={metric} data={heroBrandTrend} />
        {done}
      </>
    );
  }
  if (trendUnavailable) {
    return (
      <>
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-10 text-xs text-muted-foreground">
          {t("degraded")}
        </div>
        {done}
      </>
    );
  }
  return (
    <>
      <KpiTrendChart metric={metric} points={trendPoints} />
      {done}
    </>
  );
}

// ─── ② 경쟁사 KPI 표 ─────────────────────────────────────────────────────────
function CompetitorBlock({
  metric,
  subKpis,
  brands,
  competitorValues,
  brandTrend,
  selected,
  onSelectedChange,
}: Pick<
  TabProps,
  "metric" | "subKpis" | "brands" | "competitorValues" | "brandTrend"
> & {
  selected: string[];
  onSelectedChange: (brands: string[]) => void;
}) {
  const sub = useAwaited(subKpis);
  const trend = useAwaited(brandTrend);
  const hero = useMemo(() => kpiHero(sub, metric), [sub, metric]);
  const rows = useRows({
    metric,
    brands,
    competitorValues,
    brandTrend: trend,
    ownPct: hero.pct,
  });

  // 경쟁사 표의 커버리지 — 스파크라인이 쓰는 축 그대로(갭 포함).
  const brandCoverage = useMemo(
    () => trendCoverage(trend ? trendAxis(trend.buckets, trend.unit, trend) : []),
    [trend],
  );

  return (
    <>
      <CompetitorKpiTable
        metric={metric}
        rows={rows}
        ownPct={hero.pct}
        coverage={brandCoverage}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
      <SectionDoneMarker id="standard-mention:kpi-competitor" />
    </>
  );
}

// ─── ③ AI 엔진별 ─────────────────────────────────────────────────────────────
function EngineBlock({ metric, engineTrend }: Pick<TabProps, "metric" | "engineTrend">) {
  const engine = useAwaited(engineTrend);
  const competitorBars = useMemo(
    () => engineCompetitorBars(engine, metric),
    [engine, metric],
  );
  // 추이가 없는 두 가지 사유를 구분한다(재검증 C2): 집계 자체가 degrade 된 경우와,
  // 스냅샷은 살아 있고 **시계열 단계만** 죽은 경우. 후자는 엔진 바가 그대로 살아
  // 있으므로 섹션을 통째로 비우면 안 된다. 라인이 집계층 배열에서 오면 미러 시계열
  // 단계의 실패와 무관하다(`engineTrendSeriesAvailable`).
  const trendUnavailable = !engineTrendSeriesAvailable(engine);
  const bars = useMemo(() => engineKpiBars(engine, metric), [engine, metric]);
  const series = useMemo(() => engineKpiSeries(engine, metric), [engine, metric]);
  const coverage = useMemo(
    () => coverageEntries(kpiTrendPoints(engine, metric)),
    [engine, metric],
  );
  return (
    <>
      <EngineKpiSection
        metric={metric}
        bars={bars}
        competitorBars={competitorBars}
        series={series}
        coverage={coverage}
        trendUnavailable={trendUnavailable}
      />
      <SectionDoneMarker id="standard-mention:kpi-engine" />
    </>
  );
}

// ─── ④ 멘션 유형별 ───────────────────────────────────────────────────────────
function TypeBlock({
  metric,
  subKpis,
  typeKpi,
  typesByBrand,
  engineTrend,
  competitor,
  onPickCompetitor,
  initialScope,
  typeKpiDegraded,
}: Pick<TabProps, "metric" | "subKpis" | "typeKpi" | "typesByBrand" | "engineTrend" | "typeKpiDegraded"> & {
  competitor: string | null;
  /** 헤더 경쟁사 드롭다운(QA #1) — 이 섹션 **전용** 선택이다(QA 2차 #6). */
  onPickCompetitor?: (brand: string | null) => void;
  initialScope?: TypeScope;
}) {
  const kpi = useAwaited(typeKpi);
  const byBrand = useAwaited(typesByBrand);
  const sub = useAwaited(subKpis);
  const degraded = useAwaited(typeKpiDegraded ?? false);
  const barsFor = useMemo(
    () => (scope: TypeScope) =>
      typeKpiBars({ kpi, typesByBrand: byBrand, metric, scope, competitor }),
    [kpi, byBrand, metric, competitor],
  );
  // 헤더 드롭다운 옵션 — 경쟁사 표와 같은 소스(typesByBrand, isTracked=false).
  const competitors = useMemo(
    () => byBrand?.brands.filter((b) => !b.isTracked).map((b) => b.brand) ?? [],
    [byBrand],
  );
  // 첫 행 "전체" = 히어로와 같은 스칼라(피그마 327:369). 건수는 당사 유형 신호 합.
  const total = useMemo(() => {
    const hero = kpiHero(sub, metric);
    const ownSignals = kpi ? barsFor("own").reduce((s, b) => s + b.ownSignals, 0) : null;
    return { pct: hero.pct, ownSignals };
  }, [sub, kpi, metric, barsFor]);
  return (
    <>
      <TypeKpiSection
        metric={metric}
        barsFor={barsFor}
        initialScope={initialScope}
        competitor={competitor}
        competitors={competitors}
        onPickCompetitor={onPickCompetitor}
        total={total}
        degraded={degraded}
        trendSlot={
          <Suspense fallback={<KpiChartSlotSkeleton />}>
            <TypeCombo metric={metric} engineTrend={engineTrend} />
          </Suspense>
        }
      />
      <SectionDoneMarker id="standard-mention:kpi-type" />
    </>
  );
}

/** 유형 섹션 우측 콤보 — 엔진 추이 집계 하나만 기다린다(좌측 바와 분리). */
function TypeCombo({
  metric,
  engineTrend,
}: Pick<TabProps, "metric" | "engineTrend">) {
  const engine = useAwaited(engineTrend);
  // QA 2차 #9 — 콤보는 유형 5종 노출률 선만 그린다. 우선 노출도(firstPosition)는
  // 더 이상 이 차트에 없으므로 **집계 자체를 부르지 않는다**(불필요한 read 제거).
  const combo = useMemo(() => typeComboPoints(engine), [engine]);
  const coverage = useMemo(
    () => coverageEntries(kpiTrendPoints(engine, metric)),
    [engine, metric],
  );
  return (
    <>
      <TypeKpiTrend
        combo={combo}
        coverage={coverage}
        trendUnavailable={engine == null || engine.trendDegraded === true}
      />
      <SectionDoneMarker id="standard-mention:kpi-type-trend" />
    </>
  );
}

/**
 * 경쟁사 행 파생 — 히어로 미니 카드·차트·경쟁사 표가 **같은 규칙**을 쓰게 하는
 * 한 곳. 색 인덱스가 행 순서에서 나오므로 세 지면이 갈라지면 색이 어긋난다.
 */
function useRows({
  metric,
  brands,
  competitorValues,
  brandTrend,
  ownPct,
}: {
  metric: KpiMetric;
  brands: Awaitable<MentionsBrandLive[]>;
  /** Overview 와 같은 리더가 낸 값. 미전달·`null` 이면 미러 값 그대로(격자 off). */
  competitorValues?: Awaitable<CompetitorBrandValue[] | null>;
  brandTrend: Awaitable<BrandTrendResult | null>;
  ownPct: number | null;
}): CompetitorKpiRow[] {
  const list = useAwaited(brands);
  const trend = useAwaited(brandTrend);
  // `undefined` 면 `use()` 를 부르지 않는다 — 프로미스를 안 받는 호출부(렌더 테스트)가
  // 서스펜드하지 않게 하는 `useAwaited` 의 계약과 같은 이유다.
  const values = useAwaited(competitorValues ?? null);
  return useMemo(
    () => competitorKpiRows({ brands: list, trend, metric, ownPct, values }),
    [list, trend, metric, ownPct, values],
  );
}
