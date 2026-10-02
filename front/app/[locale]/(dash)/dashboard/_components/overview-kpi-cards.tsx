"use client";

// Overview 5-KPI 카드(디자인 611:135, 2026-09-02) — 카드 = 값 + "직전 회차 대비" Δ
// + 주별 스파크라인(툴팁: 값·WoW) + 경쟁사 미니값 4 + 상세 화면 링크.
//
// 값·Δ = 대시보드 종전 KPI(applyTrendDeltas 적용된 KpiSummary). 스파크라인 = 주 버킷
// KPI 시계열(LiveTrend, 갭 = null 로 선이 끊긴다 — 단 **수집 오류 회차**는 끊긴 선만으로는
// 미측정과 구분되지 않으므로 0070 `gap` 마커를 음영·이웃 연결로 그린다(툴팁은
// 갭 슬롯에서 아예 안 뜬다 — 2026-09-11 제품 책임자).
// 규약 정본 lib/viz/trend-gap.ts). 경쟁사 = 언급 집계 브랜드 행 —
// 노출률(mentionRate)·점유율(share)·우선 노출도(avgPosition)·우호도(브랜드별 감정 합).
// 인용 점유율은 경쟁사 값 원천(도메인→브랜드)이 없어 안내 문구만.
//
// 도착 시각(E-1, 2026-09-10): 카드 **본체**(값·모수·측정 대기 판정)만 페이지의 카드
// 경계에서 오고, Δ 배지·스파크라인·경쟁사 행은 각자 자기 <Suspense> 안에서 채워진다
// (`OverviewDeferred`). 값·산식·순서는 무변경 — 스켈레톤이 높이를 미리 잡으므로
// 채워질 때 레이아웃이 밀리지 않는다.

import { Suspense, use } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { planTrendGaps, trendGapApplies, type TrendGap } from "@/lib/viz/trend-gap";
import { trendKpiFamily } from "../_data/trend-kpi-family";
import {
  formatTrendBucketMD,
  trendBucketDisplays,
  type TrendBucketDisplay,
} from "@/lib/as-of-date";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { cn } from "@/lib/utils";
import type { CitationDomainLive, CompetitorBrandValue } from "@/lib/scope/result-adapter";
// 후보 선정·표기 중복 접기의 **정본은 코어**다(lib/scope/competitor-row.ts) — 읽기 계층
// (경쟁사 Δ 2단 조회)이 같은 규칙으로 브랜드를 골라야 해서 화면 밖으로 뺐다.
import {
  brandKey,
  competitorMiniPicks,
  dedupeBrandRows,
} from "@/lib/scope/competitor-row";
// 종전 위치에서 그대로 재수출한다 — 이 규칙의 소비자·테스트가 화면 모듈을 보고 있고,
// 정본이 옮겨졌다는 사실이 그들의 관심사가 아니다.
export { dedupeBrandRows, sortMinisByValue } from "@/lib/scope/competitor-row";
// 값·Δ 산식의 정본(두 화면 공용). 후보 선정과 달리 **읽기 계층이 아니라 뷰가** 쓴다.
import {
  competitorPositionDeltas,
  competitorTrendDeltas,
} from "@/lib/kpi/competitor-values";
import type { BrandTrendResult, FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import { competitorBrandOfDomain } from "@/lib/citation-categorizer/competitor-brand";
import { OFFICIAL_COMPETITOR_CATEGORY } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { ColInfo } from "@/components/dash/col-info";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { KpiSummary } from "../_data/sample";
import type { LiveTrend } from "../_data/live";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "../_data/overview-metrics";
import { PeriodDeltaSlot } from "@/components/dash/period-delta-slot";
import { PeriodDeltaCaption, PeriodDeltaChip } from "@/components/dash/delta-chip";
import {
  labelKeyOf,
  periodCaption,
  type PeriodChip,
  type PeriodLabelCtx,
  type PeriodPresetKey,
} from "@/lib/kpi/period-compare-view";
import { compareMetricForKpiKey } from "@/components/dash/period-delta-metrics";
import type { CompareResult } from "@/lib/kpi/period-compare";

const SPARK_POINTS = 5;

export interface CompetitorMini {
  brand: string;
  value: number | null;
  /** "직전 회차 대비" Δ — 브랜드별 주 버킷 시계열의 마지막 두 측정 회차 차. 없으면 null. */
  delta?: number | null;
}

/** 경쟁사 Δ 의 원천(2026-09-02 피그마 D10/D11) — 페이지가 프로미스로 넘기고 카드 하단만 기다린다. */
export interface OverviewExtras {
  brandTrend: BrandTrendResult | null;
  firstPosition: FirstPositionResult | null;
  citationDomains: CitationDomainLive[] | null;
}

/**
 * 경쟁사 행이 필요로 하는 전부 — 미니값의 원천(브랜드 행)까지 한 프로미스로 묶는다.
 *
 * 타입이 `MentionsBrandLive` 가 아니라 **부분집합**(`CompetitorBrandValue`)인 이유:
 * 원천이 두 갈래(미러 언급 집계 · 집계층 회차 스냅샷)인데 뒤쪽이 낼 수 있는 것이 이
 * 여섯 필드뿐이다(PR④ B1). `MentionsBrandLive` 는 이 타입의 구조적 상위라 미러 경로는
 * 그대로 대입된다 — 좁힌 쪽이 **없는 필드를 0 으로 지어내지 않게** 하는 것이 목적이다.
 */
export interface OverviewCompetitorSources extends OverviewExtras {
  brands: CompetitorBrandValue[];
}

/**
 * 카드 **본체 뒤에** 각자 자기 <Suspense> 로 도착하는 세 조각 (E-1, 2026-09-10).
 *
 * 종전에는 이 셋의 원천 read 가 카드 값과 한 Promise.all 에 묶여 있어서, 가장 느린
 * read 하나가 ①~⑤ 값까지 붙잡았다(T12 프리뷰 실측: 셸 0.87 s → 본문 32.9 s).
 * 지금은 값이 먼저 나오고 아래 셋이 채워진다 — **값·산식·순서는 무변경**이고
 * 바뀌는 것은 도착 시각뿐이다.
 *
 * 없으면(테스트·mock) `trend`·`brands` 프로퍼티를 쓰는 종전 동기 경로 그대로다.
 */
export interface OverviewDeferred {
  /** Δ 적용된 KPI 배열(applyTrendDeltas 결과) — 값·모수는 본체와 같고 delta 만 채워진다. */
  deltas: Promise<KpiSummary[]>;
  /** 스파크라인용 주 버킷 추이. */
  trend: Promise<LiveTrend | null>;
  /** 경쟁사 행 — 언급 브랜드 행 + Δ 원천 + 인용 도메인. */
  competitors: Promise<OverviewCompetitorSources | null>;
}

/** Δ 가 없을 때 찍는 표기(U+2212 MINUS SIGN) — 빈칸이면 "왜 없는지"가 안 보인다(QA #22). */
export const NO_DELTA = "−";

/**
 * 카드 하나의 표시 상태 — 값이 "측정 대기"인지, Δ 를 그릴지 (QA #23·#3). 순수 함수.
 *
 * 두 규칙:
 *  1. `value == null` = 측정 대기 → Δ·스파크라인·경쟁사 행을 전부 숨긴다. 종전에는
 *     값만 "측정 대기"인데 그 아래에 `↘44.4pp`·`↘1.0위` 가 함께 찍혔다.
 *  2. 값이 0 이라도 **모수(ratio.denominator)가 0** 이면 측정된 0 이 아니라 분모
 *     부재다 — live.ts 의 `pct(n, 0) = 0` 이 그대로 카드로 샌 것. ratio 자체가 없는
 *     0 도 같은 취급(buildMirrorKpis 는 분모 0 일 때 ratio 를 안 만든다).
 *     QA 이미지의 `0.0% ↘100.0pp` 는 이 규칙이 잡는다(분모 0 → 측정 대기).
 *
 * 모수가 있는 진짜 0 의 Δ 는 **그대로 둔다** — 답변 120건 중 당사 언급 0 이면 -100pp 는
 * 참값이다. (verifier 2026-09-08: "값 0 & Δ<0 → 숨김" 규칙은 실제 하락을 가리는 데다
 * 카드 창과 추이 창이 정합하면 도달 불가한 죽은 코드라 삭제.)
 */
export function overviewCardState(
  k?: Pick<KpiSummary, "value" | "delta" | "ratio"> | null,
): { value: number | null; pending: boolean; delta: number | null } {
  const value = k?.value ?? null;
  const rawDelta = k?.delta ?? null;
  const denom = k?.ratio?.denominator ?? null;
  if (value == null || (value === 0 && (denom == null || denom === 0))) {
    return { value: null, pending: true, delta: null };
  }
  return { value, pending: false, delta: rawDelta };
}


/**
 * 경쟁사별 Δ — 지표별 원천: 노출률·점유율 = 브랜드 추이, 우선 노출도 = 순위 시계열.
 *
 * **산식은 여기 없다**(2026-09-20). `lastTwoDelta` 와 두 매핑은
 * `lib/kpi/competitor-values.ts` 로 올렸다 — 언급 화면이 같은 규칙을 부를 수 있어야 하고,
 * 화면 컴포넌트에 두면 그 화면만 가질 수 있는 규칙이 된다. 이 함수는 `extras` 를 푸는
 * 껍데기만 남는다(값·반환 형태 무변경 — `overview-kpi-cards.delta-parity.test.ts`).
 */
export function competitorDeltas(extras: OverviewExtras | null, key: OverviewKpiKey): Map<string, number | null> {
  if (!extras) return new Map();
  if (key === "visibility" || key === "shareOfVoice") {
    return competitorTrendDeltas(extras.brandTrend, key);
  }
  if (key === "position") return competitorPositionDeltas(extras.firstPosition);
  return new Map();
}

/** 인용 점유율의 경쟁사 값 — 공식(경쟁사) 도메인을 브랜드로 접어 점유율 합. 순수 함수. */
export function competitorCitationShares(domains: CitationDomainLive[] | null, limit = 4): CompetitorMini[] {
  if (!domains) return [];
  // 표기 흔들림까지 접어 합산한다 — 같은 브랜드가 두 줄로 갈리지 않게(QA #22 부수).
  const acc = new Map<string, { brand: string; share: number }>();
  for (const d of domains) {
    if (d.category !== OFFICIAL_COMPETITOR_CATEGORY) continue;
    const brand = competitorBrandOfDomain(d.domain);
    if (!brand) continue;
    const key = brandKey(brand);
    const cur = acc.get(key);
    if (cur) cur.share += d.share;
    else acc.set(key, { brand, share: d.share });
  }
  return [...acc.values()]
    .sort((a, b) => b.share - a.share || a.brand.localeCompare(b.brand))
    .slice(0, limit)
    .map(({ brand, share }) => ({ brand, value: Math.round(share * 10) / 10 }));
}

/**
 * 경쟁사 미니값 — 후보 선정·표시 순서 모두 **코어 규칙**(`competitorMiniPicks`).
 *
 * 둘을 가르는 이유: **어느 4개를 고르는가**는 언급 수 상위이고(값으로 뽑으면 언급
 * 1건짜리가 100% 로 카드를 채운다), 그 규칙을 읽기 계층(경쟁사 Δ 2단 조회)도 써야 해서
 * `lib/scope/competitor-row.ts` 로 옮겼다. **고른 4개를 어떤 순서로 보이는가**는
 * 값 기준이다(QA #15). 2026-09-29 언급 화면 우선 노출도 히어로가 같은 4개를 내야 해서
 * 정렬도 코어로 올렸다 — 이 함수는 모양만 줄인다.
 */
export function competitorMinis(brands: CompetitorBrandValue[], key: OverviewKpiKey, limit = 4): CompetitorMini[] {
  return competitorMiniPicks(brands, key, limit).map(({ brand, value }) => ({ brand, value }));
}

/** 카드 링크 — 상세 화면(답변분석 탭). */
export function detailHref(key: OverviewKpiKey, locale: string, qs: string): string {
  const base = `/${locale}/standard/answer-analysis`;
  const q = qs ? `&${qs}` : "";
  switch (key) {
    case "visibility": return `${base}/mention?kpi=exposure${q}`;
    case "shareOfVoice": return `${base}/mention?kpi=sov${q}`;
    case "sentiment": return `${base}/mention?kpi=favorability${q}`;
    case "position": return `${base}/mention?kpi=first-rank${q}`;
    case "citationShare": return `${base}/citation${qs ? `?${qs}` : ""}`;
  }
}

/**
 * 정의·산식 툴팁의 문자열 키. Overview 는 **글로벌 표면 전용**이고 ⑤ 의 글로벌 정의가
 * "출처 카테고리 공식(HMG)" 이라(제품 책임자 2026-09-29) 전용 키를 쓴다. `definition.citationShare`
 * (base URL 정의)는 website·project 카드(`SummaryTiles`)가 계속 쓴다.
 */
function infoKeyOf(key: string): string {
  return key === "citationShare" ? "citationShareGlobal" : key;
}

export function OverviewKpiCards({
  kpis,
  trend = null,
  brands = [],
  locale,
  qs = "",
  deferred,
  periodCompare,
  periodDays,
  periodPreset,
  periodLabelCtx,
}: {
  kpis: KpiSummary[];
  /** 동기 경로(테스트·mock)의 스파크라인 원천. `deferred` 가 있으면 쓰이지 않는다. */
  trend?: LiveTrend | null;
  /** 동기 경로(테스트·mock)의 경쟁사 미니값 원천. `deferred` 가 있으면 쓰이지 않는다. */
  brands?: CompetitorBrandValue[];
  locale: string;
  /** 현재 필터 쿼리스트링(선행 `?` 없이) — 상세 링크에 그대로 실어 나른다. */
  qs?: string;
  /** 값 뒤에 따로 도착하는 세 조각(Δ · 스파크라인 · 경쟁사 행). @see OverviewDeferred */
  deferred?: OverviewDeferred;
  /**
   * 기간 비교 Δ (GGMD-107 지면 #1). `null`·미전달이면 **종전 Δ 경로 그대로**다 —
   * 판정은 `PeriodDeltaSlot` 한 곳에서만 한다.
   */
  periodCompare?: readonly CompareResult[] | null;
  /** 선택된 구간의 길이(일). 억제 캡션의 `{days}`·`noPrevYear` 분기 입력. */
  periodDays?: number;
  /** 프리셋 이름 — 라벨(`periodCompare.label.*`)용. 미전달이면 창 길이에서 파생한다. */
  periodPreset?: PeriodPresetKey | null;
  /**
   * 비교 **종류**와 현재 구간 시작일(검증 W3·W4). 종전에는 타일이 `days` 만 받아,
   * 달력 주에서 "비교할 직전 **1일** 구간의 측정 회차가 없습니다" 같은 틀린 문장이
   * 나갔다(실제 비교 구간은 직전 주 7일이다). 신설 키 `noPrevWeek`·`noPrevMonth` 도
   * 이 문맥이 없으면 타일 경로에서는 영영 도달하지 않는다.
   */
  periodLabelCtx?: PeriodLabelCtx;
}) {
  const t = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi");
  // 우선 노출도 값·Δ 의 단위는 지면 공통 정본(`metricUnit.position`)이다. 답변분석 탭·
  // 국가별 GEO 현황·기간 비교 칩이 같은 키를 쓴다(2026-09-20 표기 드리프트 방지).
  const tUnit = useTranslations("metricUnit");
  const byKey = new Map(kpis.map((k) => [k.key, k]));
  return (
    <TooltipProvider delayDuration={200}>
    <div className="grid gap-4 md:grid-cols-2">
      {OVERVIEW_KPI_KEYS.map((key) => {
        const k = byKey.get(key);
        const isRank = key === "position";
        const fmt = (v: number | null) => (v == null ? t("cardEmpty") : isRank ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
        // QA #23·#3 — 값이 "측정 대기"면 Δ·스파크라인·경쟁사 행을 함께 내린다.
        // 이 판정은 값·모수만 보므로(delta 는 안 본다) Δ 가 늦게 와도 결과가 같다.
        const state = overviewCardState(k);
        return (
          // 피그마 611:135 카드 실측: px-7 py-8, 헤더↔본문 gap-6, 값블록↔차트 gap-10.
          // 제목 20→16px · 값 40→28px (QA #6 — 언급 탭 히어로와 같은 크기로).
          // 개선 Δ = positive 토큰(제품 결정), 스파크라인은 회차 교차 밴드 + 흰 점.
          <section key={key} className="flex flex-col gap-6 rounded-md border border-border bg-card px-7 py-8" data-overview-card={key}>
            <header className="flex items-start justify-between gap-2">
              <h3 className="inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground/80">
                {tKpi(`name.${key}`)}
                <ColInfo title={tKpi(`name.${key}`)} definition={tKpi(`definition.${infoKeyOf(key)}`)} formula={tKpi(`formula.${infoKeyOf(key)}`)} />
              </h3>
              <Link href={detailHref(key, locale, qs)} aria-label={t("openDetail")} className="text-foreground/80 hover:text-foreground">
                <ArrowUpRight className="h-6 w-6" aria-hidden />
              </Link>
            </header>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch sm:gap-10">
              <div className="flex shrink-0 flex-col justify-center gap-4 sm:w-[130px]">
                <span className="text-[28px] leading-none font-bold tracking-tight text-foreground/80 tabular-nums">{fmt(state.value)}</span>
                {/* Δ — 측정 대기면 그리지 않고(QA #23), 지연 경로면 자기 경계에서 채운다.
                    자리는 스켈레톤이 미리 잡아 둔다(높이 고정 = 값이 튀지 않는다). */}
                <PeriodDeltaSlot
                  compare={periodCompare}
                  // 측정 대기 카드는 기간 Δ 도 그리지 않는다(QA #23 와 같은 규칙).
                  metric={state.pending ? null : compareMetricForKpiKey(key)}
                  days={periodDays}
                  render={(chip, r) => (
                    <PeriodDeltaBlock
                      chip={chip}
                      result={r}
                      days={periodDays}
                      preset={periodPreset}
                      labelCtx={periodLabelCtx}
                    />
                  )}
                  fallback={
                    state.pending || !deferred ? (
                      <DeltaBlock delta={state.delta} isRank={isRank} />
                    ) : (
                      <Suspense fallback={<DeltaBlockSkeleton />}>
                        <DeltaLive deltas={deferred.deltas} kpiKey={key} isRank={isRank} />
                      </Suspense>
                    )
                  }
                />
              </div>
              <div className="h-28 min-w-0 flex-1">
                {/* 측정 대기면 선을 그리지 않는다 — 값이 "측정 대기"인데 추이만 그려지면
                    카드가 서로 다른 두 사실을 동시에 주장한다(QA #23). */}
                {state.pending ? (
                  <SparkEmpty text={t("cardEmpty")} />
                ) : deferred ? (
                  <Suspense fallback={<SparkSkeleton />}>
                    <SparkLive trend={deferred.trend} kpiKey={key} isRank={isRank} fmt={fmt} />
                  </Suspense>
                ) : (
                  <SparkArea points={sparkPoints(trend, key)} kpiKey={key} isRank={isRank} fmt={fmt} />
                )}
              </div>
            </div>
            {/* 측정 대기면 경쟁사 행도 내린다 — 당사 값이 없는데 경쟁사만 있으면
                비교 대상이 없는 숫자가 남는다(QA #23·Q3-A). */}
            {state.pending ? null : (
              <div className="border-t border-border pt-4">
                {deferred ? (
                  <Suspense fallback={<CompetitorRowSkeleton />}>
                    <CompetitorRowLive competitors={deferred.competitors} kpiKey={key} fmt={fmt} isRank={isRank} emptyText={t("noCompetitorData")} />
                  </Suspense>
                ) : (
                  <CompetitorRow minis={competitorMinis(brands, key)} fmt={fmt} isRank={isRank} emptyText={t("noCompetitorData")} />
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
    </TooltipProvider>
  );
}

// ─── Δ (직전 회차 대비) ─────────────────────────────────────────────────────
function DeltaBlock({ delta, isRank }: { delta: number | null; isRank: boolean }) {
  const t = useTranslations("dashboard.overview");
  const tUnit = useTranslations("metricUnit");
  // 순위는 내려가는 것이 개선.
  const good = delta == null ? null : isRank ? delta < 0 : delta > 0;
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn("text-[10px]", delta == null || delta === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-destructive")}>{t("compare")}</span>
      {delta == null ? (
        // 회차 2개 미만·측정 대기 → 빈칸이 아니라 '−'(QA #22).
        <span className="text-xs text-muted-foreground tabular-nums">{NO_DELTA}</span>
      ) : (
        <span className={cn("inline-flex items-center gap-0.5 text-sm font-medium tabular-nums", delta === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-destructive")}>
          {delta > 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden />}
          {isRank ? tUnit("position", { n: Math.abs(delta).toFixed(1) }) : `${Math.abs(delta).toFixed(1)}pp`}
        </span>
      )}
    </span>
  );
}

/**
 * 기간 비교 Δ — `DeltaBlock` 과 **같은 상자**(flex-col gap-0.5)에 라벨·칩·사유를 얹는다.
 * 상자가 다르면 켜고 끌 때 카드 높이가 흔들린다.
 */
function PeriodDeltaBlock({
  chip,
  result,
  days,
  preset,
  labelCtx,
}: {
  chip: PeriodChip;
  result: CompareResult;
  days?: number;
  preset?: PeriodPresetKey | null;
  labelCtx?: PeriodLabelCtx;
}) {
  const t = useTranslations("periodCompare");
  // 라벨은 프리셋 이름이 정본이다. 캘린더 직접 지정처럼 프리셋이 없으면 회차 수 문구로
  // 떨어진다(`periodCompare.window`) — 어느 쪽이든 "무엇과 비교했는가" 를 말한다.
  // 종류를 알면 그쪽이 이긴다 — 달력 주의 길이(7)는 트레일링 `weekly` 와 구분되지 않는다.
  const presetKey = preset ?? labelKeyOf({ days: days ?? 0, ...labelCtx });
  return (
    <span className="flex flex-col gap-0.5" data-period-delta-block={result.metric}>
      <span className="text-[10px] text-muted-foreground">
        {presetKey
          ? t(`label.${presetKey}`)
          : t("window", { curCycles: result.cyclesCur, prevCycles: result.cyclesPrev })}
      </span>
      <PeriodDeltaChip chip={chip} size="md" />
      {/* 캡션도 **라벨과 같은 문맥**을 받는다(N2). 안 넘기면 달력 주에서 라벨은
          "지난주 대비" 인데 바로 아래 캡션은 "직전 1일 구간" 이라, 한 카드 안에서
          두 문장이 서로 모순한다. */}
      <PeriodDeltaCaption caption={periodCaption(result, { days: days ?? 0, ...labelCtx })} />
    </span>
  );
}

/** Δ 대기 자리 — 라벨은 그대로 두고 숫자 줄만 잡아 둔다(h-5 = text-sm 한 줄). */
function DeltaBlockSkeleton() {
  const t = useTranslations("dashboard.overview");
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground">{t("compare")}</span>
      <span className="inline-flex h-5 items-center" aria-hidden>
        <span className="h-3 w-12 animate-pulse rounded bg-muted" />
      </span>
    </span>
  );
}

function DeltaLive({ deltas, kpiKey, isRank }: { deltas: Promise<KpiSummary[]>; kpiKey: OverviewKpiKey; isRank: boolean }) {
  const applied = use(deltas);
  // 값·모수는 본체와 같은 KPI 라 pending 판정도 같다 — delta 만 꺼내 쓴다.
  return <DeltaBlock delta={overviewCardState(applied.find((x) => x.key === kpiKey)).delta} isRank={isRank} />;
}

// ─── 스파크라인 (주 버킷) ───────────────────────────────────────────────────
interface SparkPoint {
  bucketStart: string;
  /** 회차 버킷의 대표 앵커 — x축·툴팁 **라벨 전용**(앵커의 KST 일). 키는 `bucketStart` 그대로. */
  cycleAnchorAt?: string;
  value: number | null;
  wow: number | null;
  /** 수집 오류 회차(0070). 있으면 `value` 는 반드시 null 이다 — 계약. */
  gap?: TrendGap;
}

/**
 * 마지막 SPARK_POINTS 개 버킷 + 직전 버킷 대비(WoW). 순수 함수.
 *
 * export 하는 이유는 테스트 하나 때문이다 — recharts 는 `renderToStaticMarkup` 에서
 * SVG 를 내지 않아(브랜드 추이 테스트 헤더 참고) 이 매핑이 `gap` 을 떨어뜨렸는지를
 * 마크업으로는 볼 수 없다. `brandLineProps` 와 같은 자세.
 */
export function sparkPoints(trend: LiveTrend | null, key: OverviewKpiKey): SparkPoint[] {
  // 이 카드가 속한 **계열**(0071). 한 추이 배열에서 5장이 갈라지는 유일한 자리라
  // 범위 판정도 여기서 한다 — `scope:"citations"` 회차는 인용 점유율 카드에서만
  // 갭이고, 언급 카드 4장에서는 마커가 아예 없는 것처럼 굴어야 한다(제품 책임자 2026-09-11
  // "멘션에 대한 부분은 살려줘야해").
  const family = trendKpiFamily(key);
  return (trend?.points ?? []).slice(-SPARK_POINTS).map((p, i, arr) => {
    const v = p.values[key as keyof typeof p.values] ?? null;
    const prev = i > 0 ? arr[i - 1].values[key as keyof typeof p.values] ?? null : null;
    // `gap` 을 여기서 떨어뜨리면 스파크라인만 마커를 못 본다 — 같은 회차가 히어로
    // 추이에서는 음영인데 카드에서는 그냥 끊긴 선이 된다(2026-09-10 실측 지문).
    // 반대로 **안 떨어뜨리면** 값이 살아 있는 언급 카드에 음영이 덮이고 그 칸의
    // 툴팁이 사라진다(갭 행이면 툴팁을 안 낸다): 툴팁(`GapAwareTooltip`)은 plan 이
    // 아니라 **행**에서 마커를 읽으므로 계열이 안 맞는 마커는 여기서 잘라야 한다
    // (plan 의 `family` 만으로는 툴팁이 안 막힌다).
    return {
      bucketStart: p.bucketStart,
      ...(p.cycleAnchorAt ? { cycleAnchorAt: p.cycleAnchorAt } : {}),
      value: v,
      wow: v != null && prev != null ? Math.round((v - prev) * 10) / 10 : null,
      ...(trendGapApplies(p.gap, family) ? { gap: p.gap } : {}),
    };
  });
}

/**
 * 카드 스파크라인의 y 도메인. 순수 함수(테스트: overview-kpi-cards.spark-domain.test.ts).
 *
 * 순위 카드는 **상세 화면 추이 차트와 같은 앵커**를 쓴다 — `[1, max(5, ⌈관측최대⌉)]`
 * (rank-trend-chart.tsx 의 `domain={[1, data.yMax]}` · `_data/kpi-view.ts` 의
 * `yMax: Math.max(5, Math.ceil(observedMax))` 와 동일 산식) + `reversed`.
 * 앵커 없이 `["auto","auto"]` 를 쓰면 0.5위 변동이 플롯 높이 100% 를 먹어 "급락"으로
 * 오독된다(고객 QA 2차 #1 — 실제 3.0위인 회차가 카드 바닥까지 떨어져 보였다).
 * 비율 카드 4장은 종전 `[0,100]` 그대로 — 0 앵커라 과장 위험이 없다.
 */
export function sparkYDomain(points: readonly { value: number | null }[], isRank: boolean): [number, number] {
  if (!isRank) return [0, 100];
  const vals = points.map((p) => p.value).filter((v): v is number => v != null);
  return [1, Math.max(5, Math.ceil(vals.length ? Math.max(...vals) : 0))];
}

function SparkEmpty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground">{text}</div>;
}

/** 추이 대기 자리 — 컨테이너(h-28)를 그대로 채운다(도착해도 높이가 안 변한다). */
function SparkSkeleton() {
  return <div className="h-full w-full animate-pulse rounded-md bg-muted" aria-hidden />;
}

/**
 * 스파크라인 본체. `export` 는 테스트 seam 이다 — 갭 오버레이(음영·보조선)가 이
 * 차트에도 실제로 걸리는지를 마크업으로 보려면 컴포넌트에 직접 닿아야 한다
 * (`components/dash/trend-gap-bridge.render.test.tsx`).
 */
export function SparkArea({
  points,
  kpiKey,
  isRank,
  fmt,
}: {
  points: SparkPoint[];
  kpiKey: OverviewKpiKey;
  isRank: boolean;
  fmt: (v: number | null) => string;
}) {
  const t = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi");
  // 수집 오류 회차 — 음영 + 이웃 연결. 시리즈는 `value` 하나뿐이고, 창(5점) 끝에 걸린
  // 갭은 이을 이웃이 없어 음영만 남는다(planTrendGaps 규칙 ①).
  // 계열을 함께 넘긴다 — `sparkPoints` 가 이미 걸렀으므로 값은 같지만, 다음에 행을
  // 만드는 자리가 늘어나도 이 차트가 조용히 종전(전부 갭) 동작으로 안 돌아간다.
  const gapPlan = planTrendGaps(points, {
    xKey: "bucketStart",
    seriesKeys: ["value"],
    family: trendKpiFamily(kpiKey),
  });
  if (!points.some((p) => p.value != null)) return <SparkEmpty text={t("cardEmpty")} />;
  // x 값은 키(앵커의 UTC 일) 그대로 두고 **표시만** 앵커의 KST 일로(2026-09-28 — 9/13T15:48Z
  // 앵커가 "9. 13." 으로 찍혀 상단 KST pill 과 어긋났다). 미러 격자 점은 종전 그대로 키를 쓴다.
  const displays = trendBucketDisplays(points);
  const displayOf = (v: unknown): TrendBucketDisplay =>
    displays.get(String(v)) ?? { day: String(v), time: null };
  return (
    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 112 }}>
      <LineChart data={gapPlan.rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        {/* 세로선 투명 + 교차 채움 = 회차 밴드(vertical={false} 면 채움도 생략된다 — 프리뷰 실측). */}
        <CartesianGrid horizontal={false} vertical stroke="transparent" verticalFill={["var(--color-bg-soft)", "transparent"]} fillOpacity={0.9} />
        {/* QA #11 — 첫 tick(구간 시작일)과 마지막 tick 을 반드시 그린다.
            recharts 기본값은 preserveEnd 라 폭이 좁으면 **시작일이 먼저
            잘린다**. minTickGap=0 이어야 5점 스파크라인에서 양 끝이 남는다. */}
        <XAxis dataKey="bucketStart" interval="preserveStartEnd" minTickGap={0} tickFormatter={(v: string) => formatTrendBucketMD(displayOf(v))} tick={{ fontSize: 10 }} stroke="var(--color-ink-500)" />
        <YAxis hide domain={sparkYDomain(points, isRank)} reversed={isRank} />
        {/* 음영은 라인보다 먼저 — 회차 밴드 위, 라인 아래에 깔린다. */}
        {trendGapAreas(gapPlan.areas)}
        {/* filterNull={false} — 값이 null 인 갭 슬롯에서도 payload 가 살아야 갭 마커가
            content 에 닿는다(GapAwareTooltip 주석). 마커를 본 툴팁은 **아무것도 안 낸다**
            (2026-09-11 제품 책임자 "이거, 오류로 인해 수집되지 않음 호버 지워줘" → 같은 날
            "다른 차트에도 갭 툴팁 지워줘"). 음영·이웃 연결은 그대로고, 갭이 아닌 칸은
            종전 표시 그대로다(걷어내기는 GapAwareTooltip 이 재현한다). */}
        <RTooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          wrapperStyle={{ zIndex: 50 }}
          filterNull={false}
          content={<GapAwareTooltip />}
          // 헤더는 종전처럼 ISO 날짜 — 값만 축과 같은 표시일(앵커의 KST 일)로.
          labelFormatter={(v: unknown) => {
            const d = displayOf(v);
            return d.time ? `${d.day} ${d.time}` : d.day;
          }}
          formatter={(v: unknown, _n, item) => {
            const wow = (item?.payload as { wow?: number | null } | undefined)?.wow;
            const val = typeof v === "number" ? fmt(v) : "—";
            return [wow == null ? val : `${val} · ${t("sparkTooltipWow")} ${wow > 0 ? "+" : ""}${wow.toFixed(1)}${isRank ? "" : "pp"}`, tKpi(`name.${kpiKey}`)];
          }}
        />
        <Line type="monotone" dataKey="value" stroke="var(--color-brand-700)" strokeWidth={2} dot={{ r: 3, fill: "var(--color-card)", stroke: "var(--color-brand-700)", strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
        {/* 이웃 잇기 — 갭 칸에 값을 만들지 않는 합성 시리즈(보간 아님). */}
        {trendGapBridgeLines(gapPlan.bridges, () => ({
          stroke: "var(--color-brand-700)",
          strokeWidth: 2,
        }))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function SparkLive({
  trend,
  kpiKey,
  isRank,
  fmt,
}: {
  trend: Promise<LiveTrend | null>;
  kpiKey: OverviewKpiKey;
  isRank: boolean;
  fmt: (v: number | null) => string;
}) {
  return <SparkArea points={sparkPoints(use(trend), kpiKey)} kpiKey={kpiKey} isRank={isRank} fmt={fmt} />;
}

// ─── 경쟁사 행 ──────────────────────────────────────────────────────────────
/** 경쟁사 행 대기 자리 — 4열 그리드의 두 줄(브랜드 h-4 · 값 h-6)을 그대로 잡는다. */
function CompetitorRowSkeleton() {
  return (
    <ul className="grid grid-cols-4 gap-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex min-w-0 flex-col gap-3">
          <span className="h-4 w-16 max-w-full animate-pulse rounded bg-muted" />
          <span className="h-6 w-12 max-w-full animate-pulse rounded bg-muted" />
        </li>
      ))}
    </ul>
  );
}

function CompetitorRowLive({
  competitors,
  kpiKey,
  fmt,
  isRank,
  emptyText,
}: {
  competitors: Promise<OverviewCompetitorSources | null>;
  kpiKey: OverviewKpiKey;
  fmt: (v: number | null) => string;
  isRank: boolean;
  emptyText: string;
}) {
  const src = use(competitors);
  const deltas = competitorDeltas(src, kpiKey);
  const rows: CompetitorMini[] =
    kpiKey === "citationShare"
      ? competitorCitationShares(src?.citationDomains ?? null)
      : // competitorMinis 가 이미 값 순으로 정렬한다 — Δ 만 얹는다.
        competitorMinis(src?.brands ?? [], kpiKey).map((m) => ({ ...m, delta: deltas.get(m.brand) ?? null }));
  return <CompetitorRow minis={rows} fmt={fmt} isRank={isRank} emptyText={emptyText} />;
}

/**
 * 경쟁사 Δ 의 기준 안내 (PR④ B4).
 *
 * **말하는 것은 Δ 기준 하나뿐이다.** 경쟁사 값의 원천은 화면 키 `S1.competitors` 로
 * 갈리는데(off = 미러 언급 누적 / on = 당사 카드와 같은 회차 스냅샷, PR④ B1·B2),
 * 이 컴포넌트가 받는 `StandardCompetitorSources`(lib/scope/server.ts:2110)에는 **어느
 * 경로로 왔는지를 알려 주는 필드가 없다**. 그래서 "당사 카드와 같은 회차·모수" 는
 * 키가 off 인 지금 거짓이 되므로 쓰지 않는다 — 키를 켜는 PR④-b 에서 플래그가 함께
 * 내려오면 그때 모수 문구를 이 자리에 얹는다.
 *
 * Δ 기준은 두 경로가 같다: `lastTwoDelta` 가 **값 있는 마지막 두 점**의 차를 낸다
 * (카드 ①~⑤ 의 `applyTrendDeltas` 와 같은 형태 = 직전 회차 대비).
 *
 * 자리: Δ 칩을 `asChild` 로 감싸기만 한다 — 렌더되는 엘리먼트가 그대로라 카드
 * 레이아웃이 움직이지 않는다.
 */
function CompetitorDeltaBasis({ children }: { children: React.ReactElement }) {
  const t = useTranslations("dashboard.overview");
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-64 text-left text-pretty normal-case">
        {t("competitorDeltaBasis")}
      </TooltipContent>
    </Tooltip>
  );
}

function CompetitorRow({
  minis,
  fmt,
  isRank,
  emptyText,
}: {
  minis: CompetitorMini[];
  fmt: (v: number | null) => string;
  isRank: boolean;
  emptyText: string;
}) {
  const t = useTranslations("dashboard.overview");
  const tUnit = useTranslations("metricUnit");
  if (minis.length === 0) return <p className="text-[11px] text-muted-foreground">{emptyText}</p>;
  return (
    <>
      <ul className="grid grid-cols-4 gap-4">
        {minis.map((c) => {
          const d = c.delta ?? null;
          const good = d == null ? null : isRank ? d < 0 : d > 0;
          return (
            <li key={c.brand} className="flex min-w-0 flex-col gap-3">
              <div className="truncate text-xs text-foreground/80">{c.brand}</div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-base font-semibold tabular-nums">{fmt(c.value)}</span>
                {/* Δ 칩에 기준 안내를 붙인다 — 칩을 감싸기만 하므로 자리·크기는 그대로다. */}
                <CompetitorDeltaBasis>
                  {d != null ? (
                    <span className={cn("inline-flex items-center gap-0.5 text-[11px] tabular-nums", d === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-destructive")}>
                      {d > 0 ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
                      {isRank ? tUnit("position", { n: Math.abs(d).toFixed(1) }) : `${Math.abs(d).toFixed(1)}pp`}
                    </span>
                  ) : (
                    // 회차가 2개 미만이면 Δ 를 낼 수 없다(lastTwoDelta) — 빈칸 대신 '−'(QA #22).
                    <span className="text-[11px] tabular-nums text-muted-foreground">{NO_DELTA}</span>
                  )}
                </CompetitorDeltaBasis>
              </div>
            </li>
          );
        })}
      </ul>
      {/* 호버가 없는 경로(스크린리더·정적 렌더)를 위한 같은 문구. `sr-only` 는
          position:absolute 라 행 높이를 건드리지 않는다 — 인용 현황의 `deltaBasis`
          (citations-standard-view.tsx:246, 제품 결정)와 같은 형태. */}
      <p className="sr-only">{t("competitorDeltaBasis")}</p>
    </>
  );
}
