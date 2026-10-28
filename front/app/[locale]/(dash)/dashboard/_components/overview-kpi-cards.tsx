"use client";

// Overview 5-KPI 카드(디자인 611:135, 2026-09-02) — 카드 = 값 + "직전 회차 대비" Δ
// + 주별 스파크라인(툴팁: 값·WoW) + 경쟁사 미니값 4 + 상세 화면 링크.
//
// Every value comes from the overview screens (back/bff/screens/overview.py): the card body
// (value, 측정 대기, period-compare block) from overview/cards, and — each in its own <Suspense>,
// skeletons holding the height — the Δ and sparkline from overview/card-trend and the competitor
// row from overview/card-competitors. This file formats and lays them out. 수집 오류 회차(0070
// `gap`)는 스파크라인에서 음영·이웃 연결로 그린다(차트 기하 planTrendGaps, 규약 lib/viz/trend-gap.ts).

import { Suspense, use } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { planTrendGaps } from "@/lib/viz/trend-gap";
import { trendKpiFamily } from "../_data/trend-kpi-family";
import { formatTrendBucketMD, type TrendBucketDisplay } from "@/lib/as-of-date";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { cn } from "@/lib/utils";
import { ColInfo } from "@/components/dash/col-info";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "../_data/overview-metrics";
import { PeriodDeltaCaption, PeriodDeltaChip } from "@/components/dash/delta-chip";
import type {
  CardCompetitorsView,
  CardTrendView,
  CompetitorMiniView,
  OverviewCardView,
  PeriodBlockView,
  SparkPointView,
} from "../_data/screen-types";

/** Δ 가 없을 때 찍는 표기(U+2212 MINUS SIGN) — 빈칸이면 "왜 없는지"가 안 보인다(QA #22). */
export const NO_DELTA = "−";

/** 카드 링크 — 상세 화면(답변분석 탭). `root` "/renewal" = 리뉴얼 화면(리뉴얼 Overview 는 리뉴얼 셸 안에 머문다, 2026-10-28). */
export function detailHref(key: OverviewKpiKey, locale: string, qs: string, root: "" | "/renewal" = ""): string {
  const base = `/${locale}${root}/standard/answer-analysis`;
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
 * (base URL 정의)는 website 타일(`SummaryTilesView`)이 계속 쓴다.
 */
function infoKeyOf(key: string): string {
  return key === "citationShare" ? "citationShareGlobal" : key;
}

/** The two late parts of the cards: Δ + sparklines, and the competitor rows (each its own Suspense). */
export interface OverviewCardsDeferred {
  trend: Promise<CardTrendView>;
  competitors: Promise<CardCompetitorsView>;
}

export function OverviewKpiCards({
  cards,
  locale,
  qs = "",
  deferred,
}: {
  /** The five cards (overview/cards). */
  cards: OverviewCardView[];
  locale: string;
  /** 현재 필터 쿼리스트링(선행 `?` 없이) — 상세 링크에 그대로 실어 나른다. */
  qs?: string;
  deferred: OverviewCardsDeferred;
}) {
  const t = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi");
  // 우선 노출도 값·Δ 의 단위는 지면 공통 정본(`metricUnit.position`)이다.
  const tUnit = useTranslations("metricUnit");
  const byKey = new Map(cards.map((c) => [c.key, c]));
  return (
    <TooltipProvider delayDuration={200}>
    <div className="grid gap-4 md:grid-cols-2">
      {OVERVIEW_KPI_KEYS.map((key) => {
        const card = byKey.get(key);
        const isRank = key === "position";
        const fmt = (v: number | null) => (v == null ? t("cardEmpty") : isRank ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
        // QA #23·#3 — 값이 "측정 대기"면 Δ·스파크라인·경쟁사 행을 함께 내린다.
        const pending = card?.pending ?? true;
        return (
          // 피그마 611:135 카드 실측: px-7 py-8, 헤더↔본문 gap-6, 값블록↔차트 gap-10.
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
                <span className="text-[28px] leading-none font-bold tracking-tight text-foreground/80 tabular-nums">{fmt(card?.value ?? null)}</span>
                {/* Δ — 기간 비교 블록, 측정 대기면 '−', 아니면 자기 경계에서 채운다(자리는 스켈레톤이 잡는다). */}
                {card?.period ? (
                  <PeriodDeltaBlock period={card.period} />
                ) : pending ? (
                  <DeltaBlock delta={null} isRank={isRank} />
                ) : (
                  <Suspense fallback={<DeltaBlockSkeleton />}>
                    <DeltaLive trend={deferred.trend} kpiKey={key} isRank={isRank} />
                  </Suspense>
                )}
              </div>
              <div className="h-28 min-w-0 flex-1">
                {/* 측정 대기면 선을 그리지 않는다(QA #23). */}
                {pending ? (
                  <SparkEmpty text={t("cardEmpty")} />
                ) : (
                  <Suspense fallback={<SparkSkeleton />}>
                    <SparkLive trend={deferred.trend} kpiKey={key} isRank={isRank} fmt={fmt} />
                  </Suspense>
                )}
              </div>
            </div>
            {/* 측정 대기면 경쟁사 행도 내린다(QA #23·Q3-A). */}
            {pending ? null : (
              <div className="border-t border-border pt-4">
                <Suspense fallback={<CompetitorRowSkeleton />}>
                  <CompetitorRowLive competitors={deferred.competitors} kpiKey={key} fmt={fmt} isRank={isRank} emptyText={t("noCompetitorData")} />
                </Suspense>
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
 * 상자가 다르면 켜고 끌 때 카드 높이가 흔들린다. 라벨(무엇과 비교했는가)과 사유는 API 가 고른 메시지다.
 */
function PeriodDeltaBlock({ period }: { period: PeriodBlockView }) {
  const t = useTranslations("periodCompare");
  return (
    <span className="flex flex-col gap-0.5" data-period-delta-block={period.chip.key}>
      <span className="text-[10px] text-muted-foreground">{t(period.label.key, period.label.params)}</span>
      <PeriodDeltaChip chip={period.chip} size="md" />
      <PeriodDeltaCaption caption={period.caption} />
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

function DeltaLive({ trend, kpiKey, isRank }: { trend: Promise<CardTrendView>; kpiKey: OverviewKpiKey; isRank: boolean }) {
  return <DeltaBlock delta={use(trend).cards[kpiKey].delta} isRank={isRank} />;
}

// ─── 스파크라인 (주 버킷) ───────────────────────────────────────────────────
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
export function SparkAreaView({
  points,
  domain,
  hasValue,
  kpiKey,
  isRank,
  fmt,
}: {
  /** The card's sparkline points, each with its axis display (overview/card-trend). */
  points: SparkPointView[];
  /** y domain (rates 0–100, rank [1, max(5, ⌈max⌉)]). */
  domain: [number, number];
  /** Some point has a value (else the empty box). */
  hasValue: boolean;
  kpiKey: OverviewKpiKey;
  isRank: boolean;
  fmt: (v: number | null) => string;
}) {
  const t = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi");
  // 수집 오류 회차 — 음영 + 이웃 연결. 시리즈는 `value` 하나뿐이고, 창(5점) 끝에 걸린
  // 갭은 이을 이웃이 없어 음영만 남는다(planTrendGaps 규칙 ①). 점의 `gap` 은 화면이 이 카드의
  // 계열(trendKpiFamily)로 이미 거른 것이고, 계열을 함께 넘겨 차트도 같은 판정을 한다.
  const gapPlan = planTrendGaps(points, {
    xKey: "bucketStart",
    seriesKeys: ["value"],
    family: trendKpiFamily(kpiKey),
  });
  if (!hasValue) return <SparkEmpty text={t("cardEmpty")} />;
  // x 값은 키(앵커의 UTC 일) 그대로 두고 **표시만** 앵커의 KST 일로(2026-09-28 — 9/13T15:48Z
  // 앵커가 "9. 13." 으로 찍혀 상단 KST pill 과 어긋났다). 미러 격자 점은 종전 그대로 키를 쓴다.
  const displays = new Map(points.map((p) => [p.bucketStart, p.display] as const));
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
        <YAxis hide domain={domain} reversed={isRank} />
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
  trend: Promise<CardTrendView>;
  kpiKey: OverviewKpiKey;
  isRank: boolean;
  fmt: (v: number | null) => string;
}) {
  const spark = use(trend).cards[kpiKey].spark;
  return <SparkAreaView points={spark.points} domain={spark.domain} hasValue={spark.hasValue} kpiKey={kpiKey} isRank={isRank} fmt={fmt} />;
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
  competitors: Promise<CardCompetitorsView>;
  kpiKey: OverviewKpiKey;
  fmt: (v: number | null) => string;
  isRank: boolean;
  emptyText: string;
}) {
  // 값 순으로 정렬된 미니값 + Δ (인용 점유율 = 공식 경쟁사 도메인을 브랜드로 접은 값) — overview/card-competitors.
  return <CompetitorRow minis={use(competitors).rows[kpiKey]} fmt={fmt} isRank={isRank} emptyText={emptyText} />;
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
  minis: CompetitorMiniView[];
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
