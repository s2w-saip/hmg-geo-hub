"use client";

// 노출률·점유율 탭의 본문 조립 — **metric prop 하나만 다르다**(스펙 SHALL).
// 값은 전부 화면 API(back/bff/screens/mention.py, `mention/kpi-*`)가 계산해 보낸다 — 이
// 컴포넌트는 섹션별 결과를 받아 그리기만 한다(두 탭의 분기 정본은 서버 view model).
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

import { Suspense, use, useState } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { useTranslations } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  KpiChartSlotSkeleton,
  KpiCompetitorTableSkeleton,
  KpiHeroSkeleton,
  KpiSectionSkeleton,
} from "@/components/dash/section-skeleton";
import {
  typeBarsOf,
  type KpiCompetitorsScreen,
  type KpiEnginesScreen,
  type KpiHeroDeltaScreen,
  type KpiHeroScreen,
  type KpiHeroTrendScreen,
  type KpiMetric,
  type KpiTypesScreen,
  type TypeScope,
} from "../../_data/mention-screen";
import { DeltaBadge, pctText } from "./kpi-bits";
import { KpiHero } from "./kpi-hero";
import { KpiTrendChart } from "./kpi-trend-chart";
import { BrandTrendChart } from "./brand-trend-chart";
import { CompetitorKpiTable } from "./competitor-kpi-table";
import { EngineKpiSection } from "./engine-kpi-section";
import { TypeKpiSection, TypeKpiTrend } from "./type-kpi-section";
import { PeriodDeltaSlot, type PeriodSlots } from "@/components/dash/period-delta-slot";
import { compareMetricForKpiTab } from "@/components/dash/period-delta-metrics";

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
  /** mention/kpi-hero — 히어로 스칼라 + 일시 실패 표식(B034). */
  hero: Awaitable<KpiHeroScreen>;
  /** mention/kpi-hero-delta — Δ 배지 폴백 값과 기준일 문구. */
  heroDelta: Awaitable<KpiHeroDeltaScreen>;
  /** mention/kpi-competitors — 히어로 경쟁사 미니 카드와 경쟁사 표. */
  competitors: Awaitable<KpiCompetitorsScreen>;
  /** mention/kpi-hero-trend — 히어로 우측 추이(브랜드 라인 / 단일 라인 / degrade 문구). */
  heroTrend: Awaitable<KpiHeroTrendScreen>;
  /** mention/kpi-engines — AI 엔진별 섹션과 유형 콤보(엔진 추이 집계 하나). */
  engines: Awaitable<KpiEnginesScreen>;
  /** mention/kpi-types — 유형별 막대(두 scope · 경쟁사별 세그먼트)와 전체 행. */
  types: Awaitable<KpiTypesScreen>;
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
  periodCompare?: PeriodSlots | null;
  /** 선택된 구간의 길이(일) — 억제 캡션 입력. */
  periodDays?: number;
};

export function MentionKpiTab({
  metric,
  hero,
  heroDelta,
  competitors,
  heroTrend,
  engines,
  types,
  initialTypeScope,
  initialCompetitors,
  initialTypeCompetitor,
  periodCompare,
  periodDays,
}: TabProps) {
  // 2026-09-10 QA 2차 #6(고객 기대값): "경쟁사 분석(노출률), 멘션 유형별 노출은
  // 각각 경쟁사 선택을 할 수 있는 구조로 따로 작동해야함(연계성 없음)."
  // 섹션마다 자기 상태를 갖고, ③ AI 엔진별은 선택을 아예 받지 않는다.
  //
  // 두 상태 모두 모든 <Suspense> 경계보다 **위**에 남긴다: 아래 섹션이 늦게
  // 도착해도 선택이 리셋되지 않고, 경계가 다시 서스펜드해도 값이 유지된다.
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
          hero={hero}
          heroDelta={heroDelta}
          competitors={competitors}
          heroTrend={heroTrend}
          periodCompare={periodCompare}
          periodDays={periodDays}
        />
      </Suspense>

      {/* ② 경쟁사 표 — 언급 집계 + 스파크라인(브랜드 추이). */}
      <Suspense fallback={<KpiCompetitorTableSkeleton />}>
        <CompetitorBlock
          metric={metric}
          competitors={competitors}
          selected={competitorSelection}
          onSelectedChange={setCompetitorSelection}
        />
      </Suspense>

      {/* ③ AI 엔진별 — 엔진 추이 집계 하나(이 지면에서 가장 느리다).
          경쟁사 선택은 넘기지 않는다(QA 2차 #6): 당사 · 경쟁사 평균만 그린다. */}
      <Suspense fallback={<KpiSectionSkeleton />}>
        <EngineBlock metric={metric} engines={engines} />
      </Suspense>

      {/* ④ 멘션 유형별 — 유형 집계 + 언급 집계. 우측 콤보만 엔진 추이를 더 기다린다. */}
      <Suspense fallback={<KpiSectionSkeleton />}>
        <TypeBlock
          metric={metric}
          types={types}
          engines={engines}
          competitor={typeCompetitor}
          onPickCompetitor={setTypeCompetitor}
          initialScope={initialTypeScope}
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
  hero,
  heroDelta,
  competitors,
  heroTrend,
  periodCompare,
  periodDays,
}: Pick<TabProps, "metric" | "hero" | "heroDelta" | "competitors" | "heroTrend" | "periodCompare" | "periodDays">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const vm = useAwaited(hero);

  return (
    <>
      <KpiHero
        metric={metric}
        hero={vm.hero}
        // Δ 배지와 기준일 문구는 **다른 집계**(직전 회차·엔진 추이)라 따로 흘려보낸다.
        deltaSlot={
          <Suspense fallback={null}>
            <HeroDelta
              metric={metric}
              heroDelta={heroDelta}
              periodCompare={periodCompare}
              periodDays={periodDays}
            />
          </Suspense>
        }
        competitorsSlot={
          <Suspense fallback={null}>
            <HeroCompetitors competitors={competitors} />
          </Suspense>
        }
        trendSlot={
          <Suspense fallback={<KpiChartSlotSkeleton className="h-52" />}>
            <HeroTrend metric={metric} heroTrend={heroTrend} />
          </Suspense>
        }
      />
      {/* 스칼라 집계가 일시 실패했으면(B034) "—" 가 "측정 없음"으로 읽히지 않게 기존 degraded
          문구를 히어로 아래 캡션 자리에 한 줄 둔다. 정상 경로에서는 아무것도 그리지 않는다. */}
      {vm.degraded ? <p className="-mt-4 text-[11px] text-muted-foreground">{t("degraded")}</p> : null}
      <Suspense fallback={null}>
        <HeroDeltaBasis heroDelta={heroDelta} />
      </Suspense>
      <SectionDoneMarker id="standard-mention:kpi-hero" />
    </>
  );
}

/** Δ 배지 — 기간 비교가 있으면 그 칩, 없으면 화면이 고른 Δ(직전 회차 → 직전 스냅샷). */
function HeroDelta({
  metric,
  heroDelta,
  periodCompare,
}: Pick<TabProps, "metric" | "heroDelta" | "periodCompare" | "periodDays">) {
  const vm = useAwaited(heroDelta);
  return (
    <>
      <PeriodDeltaSlot
        slots={periodCompare}
        metric={compareMetricForKpiTab(metric)}

        size="md"
        withCaption
        fallback={<DeltaBadge value={vm.value} unit="pp" size="md" />}
      />
      <SectionDoneMarker id="standard-mention:kpi-hero-delta" />
    </>
  );
}

/** Δ 의 기준일 문구. 히어로 카드 **밖**(아래)이라 별도 경계다. 문구 선택은 화면이 한다. */
function HeroDeltaBasis({ heroDelta }: Pick<TabProps, "heroDelta">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const { basis } = useAwaited(heroDelta);
  if (!basis) return null;
  return <p className="-mt-4 text-[11px] text-muted-foreground">{t(basis.key, { date: basis.date })}</p>;
}

/** 히어로 좌측의 경쟁사 미니 카드(점유율 탭): 값 내림차순 상위 4개(화면이 고른다). */
function HeroCompetitors({ competitors }: Pick<TabProps, "competitors">) {
  const { top } = useAwaited(competitors);
  if (top.length === 0)
    return <SectionDoneMarker id="standard-mention:kpi-hero-competitors" />;
  return (
    <div className="grid grid-cols-2 gap-2">
      {top.map((c) => (
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
 * 당사 단일 라인(엔진 추이 집계). 어느 것을 그릴지는 화면이 정해 보낸다(`kind`).
 */
function HeroTrend({ metric, heroTrend }: Pick<TabProps, "metric" | "heroTrend">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const vm = useAwaited(heroTrend);

  // 세 경로 전부 마커를 낸다 — "이 슬롯의 집계가 도착했다"가 표식의 뜻이다.
  const done = <SectionDoneMarker id="standard-mention:kpi-hero-trend" />;
  if (vm.kind === "brand") {
    return (
      <>
        <BrandTrendChart metric={metric} data={vm.chart} />
        {done}
      </>
    );
  }
  if (vm.kind === "degraded") {
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
      <KpiTrendChart metric={metric} points={vm.points} coverage={vm.coverage} />
      {done}
    </>
  );
}

// ─── ② 경쟁사 KPI 표 ─────────────────────────────────────────────────────────
function CompetitorBlock({
  metric,
  competitors,
  selected,
  onSelectedChange,
}: Pick<TabProps, "metric" | "competitors"> & {
  selected: string[];
  onSelectedChange: (brands: string[]) => void;
}) {
  const vm = useAwaited(competitors);
  return (
    <>
      <CompetitorKpiTable
        metric={metric}
        rows={vm.rows}
        ownPct={vm.ownPct}
        donut={vm.donut}
        barMax={vm.barMax}
        ownBrand={vm.ownBrand}
        coverage={vm.coverage}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
      <SectionDoneMarker id="standard-mention:kpi-competitor" />
    </>
  );
}

// ─── ③ AI 엔진별 ─────────────────────────────────────────────────────────────
function EngineBlock({ metric, engines }: Pick<TabProps, "metric" | "engines">) {
  const { engine } = useAwaited(engines);
  return (
    <>
      <EngineKpiSection
        metric={metric}
        bars={engine.bars}
        competitorBars={engine.competitorBars}
        series={engine.series}
        coverage={engine.coverage}
        trendUnavailable={engine.trendUnavailable}
      />
      <SectionDoneMarker id="standard-mention:kpi-engine" />
    </>
  );
}

// ─── ④ 멘션 유형별 ───────────────────────────────────────────────────────────
function TypeBlock({
  metric,
  types,
  engines,
  competitor,
  onPickCompetitor,
  initialScope,
}: Pick<TabProps, "metric" | "types" | "engines"> & {
  competitor: string | null;
  /** 헤더 경쟁사 드롭다운(QA #1) — 이 섹션 **전용** 선택이다(QA 2차 #6). */
  onPickCompetitor?: (brand: string | null) => void;
  initialScope?: TypeScope;
}) {
  const vm = useAwaited(types);
  // scope · 경쟁사 선택마다 화면이 미리 계산한 막대를 고른다(계산 없음).
  const barsFor = (scope: TypeScope) => typeBarsOf(vm, scope, competitor);
  return (
    <>
      <TypeKpiSection
        metric={metric}
        barsFor={barsFor}
        initialScope={initialScope}
        competitor={competitor}
        competitors={vm.competitors}
        onPickCompetitor={onPickCompetitor}
        total={vm.total}
        degraded={vm.degraded}
        trendSlot={
          <Suspense fallback={<KpiChartSlotSkeleton />}>
            <TypeCombo engines={engines} />
          </Suspense>
        }
      />
      <SectionDoneMarker id="standard-mention:kpi-type" />
    </>
  );
}

/** 유형 섹션 우측 콤보 — 엔진 추이 집계 하나만 기다린다(좌측 바와 분리). */
function TypeCombo({ engines }: Pick<TabProps, "engines">) {
  const { combo } = useAwaited(engines);
  return (
    <>
      <TypeKpiTrend combo={combo.combo} coverage={combo.coverage} trendUnavailable={combo.trendUnavailable} />
      <SectionDoneMarker id="standard-mention:kpi-type-trend" />
    </>
  );
}
