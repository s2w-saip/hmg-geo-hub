"use client";

// AI 우호도 탭 (PR ③, 디자인 327:981).
//
// ① 히어로 — 좌측 긍정·부정 신호 비율 카드 2장(스냅샷 Sub KPI Q3, 대시보드 우호도
//    카드와 같은 산식), 우측 긍정·부정 비율 추이(엔진 추이 집계에 더한 감정 합).
// ② 감정 분포 — 4분류 스택바 + 항목 목록. 항목 클릭 → 기존 신호 드릴다운 팝업
//    (디자이너 주석: "클릭 시 프롬프트 및 답변 팝업으로 제공(현행 유지)").
// ③ 멘션 유형별 감정 분포 — 전체 + 유형 5종 × 감정 4분류 스택. 우측 수치 = 긍정
//    비율. "당사 유형별 언급 건수 보기" 토글로 비율 ↔ 건수(디자이너 주석).
//
// 스트리밍 규약은 mention-kpi-tab.tsx 와 같다 — 각 prop 은 값 또는 프로미스, 섹션마다
// 자기 <Suspense> 경계에서 `useAwaited` 로 푼다.

import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  AnswerStanceDistribution,
  EngineKpiTrend,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { MentionSentimentBreakdown } from "@/lib/scope/types";
import { cn } from "@/lib/utils";
import { KpiChartSlotSkeleton, KpiHeroSkeleton, KpiSectionSkeleton } from "@/components/dash/section-skeleton";
import {
  favorabilityHero,
  favorabilityTrendPoints,
  deltaPp,
  sentimentSegments,
  stanceSegments,
  typeSentimentRows,
  type SentimentKey,
  type TypeSentimentRowVM,
} from "../../_data/kpi-view";
import { ColInfo } from "@/components/dash/col-info";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DeltaBadge, pctText } from "./kpi-bits";
import { useAwaited, type Awaitable } from "./mention-kpi-tab";
import { FavorabilityTrendChart } from "./favorability-trend-chart";
import { SignalPromptsDialog } from "../signal-prompts-dialog";

/** 감정 4분류 색 — 기존 감정 분포 카드(mentions-view.tsx)와 동일. */
// 2026-09-02 피그마 327:981 감정 4색 — globals.css 의 --color-sentiment-* 토큰(운영 결정).
export const SENTIMENT_CLASS: Record<SentimentKey, string> = {
  positive: "bg-sentiment-positive",
  neutral: "bg-sentiment-neutral",
  mixed: "bg-sentiment-mixed",
  negative: "bg-sentiment-negative",
};

type TabProps = {
  subKpis: Awaitable<StandardSubKpis | null>;
  prevSubKpis: Awaitable<StandardSubKpis | null>;
  prevBasisDate: Awaitable<string | null>;
  /** null = 집계 degrade → 추이 지면만 대체 문구. */
  engineTrend: Awaitable<EngineKpiTrend | null>;
  /** 언급 집계(MentionsLive)의 감정 총량 — 감정 분포 카드의 원천(**발생 축**). */
  sentimentTotals: Awaitable<MentionSentimentBreakdown | null>;
  /**
   * 답변 단위 브랜드 스탠스 분포(0072 — **답변 축**). 기존 감정 분포를 대체하지 않고
   * 그 옆에 **병치**한다. null = 스탠스 축이 아직 없는 배포·회차(테이블 미적용 또는
   * 코어 미배포) → 카드가 "수집 대기" 문구로 떨어진다. 발생 감성으로 대체하지 않는다.
   */
  stanceDist: Awaitable<AnswerStanceDistribution | null>;
  typeKpi: Awaitable<TypeKpi | null>;
  /** 렌더 테스트 seam — 건수 모드 분기. 화면 기본은 비율. */
  initialCounts?: boolean;
};

export function FavorabilityKpiTab({
  subKpis,
  prevSubKpis,
  prevBasisDate,
  engineTrend,
  sentimentTotals,
  stanceDist,
  typeKpi,
  initialCounts,
}: TabProps) {
  const t = useTranslations("answerAnalysis.mentions");
  const [signal, setSignal] = useState<{ signal: string; label: string } | null>(null);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      <Suspense fallback={<KpiHeroSkeleton />}>
        <FavorabilityHero
          subKpis={subKpis}
          prevSubKpis={prevSubKpis}
          prevBasisDate={prevBasisDate}
          engineTrend={engineTrend}
        />
      </Suspense>

      {/* ⚠️ 이 행은 **종전 그대로**다(감정 분포 | 유형×감정 매트릭스). 스탠스 카드를
          여기 끼워 매트릭스를 아래로 밀었더니 매트릭스가 반폭 → 전폭으로 바뀌어
          지면이 +324px 움직였다(검증자 F6). 기존 지면의 위치는 값·산식만큼이나
          A/B 의 대상이라, 새 카드는 **자기 행**에 둔다. */}
      <div className="grid gap-3 md:grid-cols-2 md:gap-6">
        <Suspense fallback={<KpiSectionSkeleton />}>
          <SentimentDistCard
            sentimentTotals={sentimentTotals}
            onSignalClick={(k, label) => setSignal({ signal: k, label })}
          />
        </Suspense>
        <Suspense fallback={<KpiSectionSkeleton />}>
          <TypeSentimentMatrix typeKpi={typeKpi} initialCounts={initialCounts} />
        </Suspense>
      </div>
      {/* 답변 축(0072) — 발생 축 카드들 **아래 새 행**. 축 라벨이 카드 헤더에 붙고,
          두 축의 숫자를 합치는 지면은 어디에도 만들지 않는다(스펙 R6). */}
      <div className="grid gap-3 md:grid-cols-2 md:gap-6">
        <Suspense fallback={<KpiSectionSkeleton />}>
          <StanceDistCard stanceDist={stanceDist} />
        </Suspense>
      </div>

      {/* 열릴 때만 마운트 — 다이얼로그가 usePathname/useSearchParams 를 쓰므로 라우터
          없는 정적 렌더(테스트)에서 닫힌 채 마운트되면 깨진다. 닫힘 = 언마운트. */}
      {signal ? (
        <SignalPromptsDialog
          signal={signal.signal}
          title={t("signalDrilldown.title", { signal: signal.label })}
          onOpenChange={(o) => {
            if (!o) setSignal(null);
          }}
        />
      ) : null}
    </div>
    </TooltipProvider>
  );
}

// ─── ① 히어로 ────────────────────────────────────────────────────────────────
function FavorabilityHero({
  subKpis,
  prevSubKpis,
  prevBasisDate,
  engineTrend,
}: Pick<TabProps, "subKpis" | "prevSubKpis" | "prevBasisDate" | "engineTrend">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const sub = useAwaited(subKpis);
  const hero = useMemo(() => favorabilityHero(sub), [sub]);
  return (
    <>
      {/* 피그마 327:981 히어로: 바깥 p-5·gap-3, 좌열 267px(다른 3탭 KpiHero 와 동일), 카드 gap-3.5. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 lg:flex-row lg:items-stretch">
        <div className="flex shrink-0 flex-col gap-3.5 lg:w-[267px]">
          {/* 히어로 산식은 **무변경**(Sub KPI Q3, 발생 축) — 축 라벨만 더한다. */}
          <AxisBadge axis="occurrence" />
          <RatioCard
            tone="positive"
            title={t("favorability.positiveTitle")}
            pct={hero.positivePct}
            deltaSlot={
              <Suspense fallback={null}>
                <HeroDelta kind="positive" prevSubKpis={prevSubKpis} current={hero.positivePct} />
              </Suspense>
            }
          />
          <RatioCard
            tone="negative"
            title={t("favorability.negativeTitle")}
            pct={hero.negativePct}
            deltaSlot={
              <Suspense fallback={null}>
                <HeroDelta kind="negative" prevSubKpis={prevSubKpis} current={hero.negativePct} />
              </Suspense>
            }
          />
        </div>
        <Suspense fallback={<KpiChartSlotSkeleton className="h-52" />}>
          <HeroTrend engineTrend={engineTrend} />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <DeltaBasis prevBasisDate={prevBasisDate} />
      </Suspense>
    </>
  );
}

/** 긍정(초록)/부정(빨강) 비율 카드 — 디자인 327:1041/1045. */
function RatioCard({
  tone,
  title,
  pct,
  deltaSlot,
}: {
  tone: "positive" | "negative";
  title: string;
  pct: number | null;
  deltaSlot: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-1 rounded-lg px-4 py-5 text-center",
        tone === "positive"
          ? "bg-sentiment-positive/15 text-sentiment-positive-ink"
          : "bg-sentiment-negative/10 text-sentiment-negative-ink",
      )}
      data-tone={tone}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-[34px] leading-none font-semibold tracking-tight tabular-nums">{pctText(pct)}</span>
      {deltaSlot}
    </div>
  );
}

function HeroDelta({
  kind,
  prevSubKpis,
  current,
}: {
  kind: "positive" | "negative";
  prevSubKpis: TabProps["prevSubKpis"];
  current: number | null;
}) {
  const prev = useAwaited(prevSubKpis);
  const prevHero = useMemo(() => favorabilityHero(prev), [prev]);
  const previous = kind === "positive" ? prevHero.positivePct : prevHero.negativePct;
  // 부정 비율은 **올라가면 나쁘다** → 색만 뒤집는다(invert).
  return <DeltaBadge value={prev ? deltaPp(current, previous) : null} unit="pp" invert={kind === "negative"} />;
}

function DeltaBasis({ prevBasisDate }: Pick<TabProps, "prevBasisDate">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const basis = useAwaited(prevBasisDate);
  if (!basis) return null;
  return <p className="-mt-4 text-[11px] text-muted-foreground">{t("hero.deltaBasis", { date: basis })}</p>;
}

function HeroTrend({ engineTrend }: Pick<TabProps, "engineTrend">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const engine = useAwaited(engineTrend);
  const points = useMemo(() => favorabilityTrendPoints(engine), [engine]);
  if (engine == null || engine.trendDegraded === true) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-10 text-xs text-muted-foreground">
        {t("degraded")}
      </div>
    );
  }
  return <FavorabilityTrendChart points={points} />;
}

// ─── ② 감정 분포 ─────────────────────────────────────────────────────────────
function SentimentDistCard({
  sentimentTotals,
  onSignalClick,
}: {
  sentimentTotals: TabProps["sentimentTotals"];
  onSignalClick: (signal: SentimentKey, label: string) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi.favorability.dist");
  const tLabel = useTranslations("answerAnalysis.mentions.breakdown");
  const totals = useAwaited(sentimentTotals);
  const segs = useMemo(() => sentimentSegments(totals), [totals]);
  const hasAny = segs.some((s) => s.count > 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
          {/* 종전 값·산식 그대로. 라벨만 붙여 "무엇을 세었는지"를 명시한다. */}
          <AxisBadge axis="occurrence" />
        </div>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </header>
      {!hasAny ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          {/* 피그마: 13px 트랙, 세그먼트 사이 3px 간격, 각 세그먼트 2px 라운드(연속 바가 아님). */}
          <div className="flex h-[13px] w-full gap-[3px]" aria-hidden>
            {segs.map((s) => (
              <span
                key={s.key}
                className={cn("h-full rounded-full", SENTIMENT_CLASS[s.key])}
                style={{ width: `${s.pct ?? 0}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1.5">
            {segs.map((s) => {
              const label = tLabel(s.key);
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    disabled={s.count === 0}
                    onClick={() => onSignalClick(s.key, label)}
                    className="flex w-full items-center justify-between rounded-md bg-bg-soft px-1.5 py-2 text-[13px] text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-default"
                    title={t("signals", { n: s.count })}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span className={cn("h-3 w-3 rounded-[2px]", SENTIMENT_CLASS[s.key])} aria-hidden />
                      <span className="text-foreground">{label}</span>
                    </span>
                    <span className="tabular-nums">{pctText(s.pct)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">{t("clickHint")}</p>
        </>
      )}
    </section>
  );
}

/**
 * 축 라벨 — "이 숫자를 무엇으로 세었는가"를 화면이 말한다.
 *
 * 이 배지가 규율인 이유: 발생 축과 답변 축은 같은 4어휘(긍정·중립·혼합·부정)를 쓰고
 * 색도 같아서, 라벨이 없으면 두 카드가 **같은 지표의 다른 값**처럼 읽힌다. 스탠스가
 * 없는 회차에서 발생 축 값만 보이는 것도 마찬가지다 — 그것이 어느 축인지 말하지
 * 않으면 "조용한 회귀"가 된다(column-availability.ts 가 경계하는 형태).
 */
function AxisBadge({ axis }: { axis: "occurrence" | "answer" }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.favorability.axis");
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t(axis)}
    </span>
  );
}

// ─── ②' 브랜드 스탠스 분포 (답변 축, 0072) ───────────────────────────────────
//
// 감정 분포 카드의 **대체가 아니라 병치**다. 값 산출은 별도 집계
// (aggregateAnswerStanceDistributionFromMirror)이고 기존 감정 SQL 은 손대지 않았다 —
// 스탠스가 0건인 과거 회차에서 우호도 탭의 모든 기존 값이 변경 전과 동일해야 한다(A14).
//
// 폴백 3층(프로브 → null → 전용 문구)이 여기서 끝난다:
//   · dist === null  → 축 자체가 없다(테이블 미적용·코어 미배포) → pendingNote
//   · dist.pairs === 0 → 축은 있는데 이 필터에 행이 없다 → empty
//   · 그 외 → 4계열 스택바. **샘플·발생 감성 대체는 없다.**
function StanceDistCard({ stanceDist }: Pick<TabProps, "stanceDist">) {
  const t = useTranslations("answerAnalysis.mentions.kpi.favorability.stance");
  const tLabel = useTranslations("answerAnalysis.mentions.breakdown");
  const dist = useAwaited(stanceDist);
  const segs = useMemo(() => stanceSegments(dist), [dist]);
  const hasAny = dist != null && dist.pairs > 0;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
          <AxisBadge axis="answer" />
        </div>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </header>
      {dist == null ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("pendingNote")}</p>
      ) : !hasAny ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="flex h-[13px] w-full gap-[3px]" aria-hidden>
            {segs.map((s) => (
              <span
                key={s.key}
                className={cn("h-full rounded-full", SENTIMENT_CLASS[s.key])}
                style={{ width: `${s.pct ?? 0}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1.5">
            {segs.map((s) => (
              <li
                key={s.key}
                className="flex w-full items-center justify-between rounded-md bg-bg-soft px-1.5 py-2 text-[13px] text-muted-foreground"
              >
                <span className="inline-flex items-center gap-2">
                  <span className={cn("h-3 w-3 rounded-[2px]", SENTIMENT_CLASS[s.key])} aria-hidden />
                  <span className="text-foreground">{tLabel(s.key)}</span>
                </span>
                <span className="tabular-nums">{pctText(s.pct)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">{t("pairs", { n: dist.pairs })}</p>
        </>
      )}
    </section>
  );
}

// ─── ③ 멘션 유형별 감정 분포 ─────────────────────────────────────────────────
function TypeSentimentMatrix({
  typeKpi,
  initialCounts = false,
}: {
  typeKpi: TabProps["typeKpi"];
  initialCounts?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi.favorability.matrix");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const kpi = useAwaited(typeKpi);
  const rows = useMemo(() => typeSentimentRows(kpi, "own"), [kpi]);
  const [counts, setCounts] = useState(initialCounts);
  const hasAny = rows.some((r) => r.total > 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="inline-flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-foreground">
            {t("title")}
            {/* 산식 각주는 본문이 아니라 ⓘ 툴팁(운영 결정: 오독 방지용만 본문, 나머지 ⓘ). */}
            <ColInfo title={t("noteTitle")} definition={t("note")} />
          </h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
      </header>
      {!hasAny ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <div className="flex items-center justify-end text-xs text-ink-400">
            <span className="w-[75px] text-right">{t("positiveCol")}</span>
          </div>
          <ul className="flex flex-col gap-[15px]">
            {rows.map((r) => (
              <MatrixRow
                key={r.type}
                row={r}
                label={r.type === "all" ? t("all") : tType(r.type)}
                counts={counts}
                countText={(n) => t("count", { n })}
              />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            {(["positive", "neutral", "mixed", "negative"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full", SENTIMENT_CLASS[k])} aria-hidden />
                <SentimentLabel k={k} />
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setCounts((v) => !v)}
            aria-pressed={counts}
            className="self-start text-xs text-foreground underline-offset-2 hover:underline"
          >
            {counts ? t("showPct") : t("showCounts")}
          </button>
        </>
      )}
    </section>
  );
}

/** 훅 규칙 때문에 map 안에서 useTranslations 를 못 부른다 — 라벨 컴포넌트로 감싼다. */
function SentimentLabel({ k }: { k: SentimentKey }) {
  const tLabel = useTranslations("answerAnalysis.mentions.breakdown");
  return <>{tLabel(k)}</>;
}

function MatrixRow({
  row,
  label,
  counts,
  countText,
}: {
  row: TypeSentimentRowVM;
  label: string;
  counts: boolean;
  countText: (n: number) => string;
}) {
  return (
    <li className={cn("flex items-center gap-2 text-xs", row.type === "all" && "font-bold")}>
      <span className="w-[91px] shrink-0 truncate text-foreground">{label}</span>
      <span className="flex h-[13px] flex-1 gap-[3px]" data-type-sentiment-track={row.type}>
        {row.segments.map((s) => (
          <span
            key={s.key}
            className={cn("h-full rounded-full", SENTIMENT_CLASS[s.key])}
            style={{ width: `${s.pct ?? 0}%` }}
            title={`${s.key} ${counts ? countText(s.count) : pctText(s.pct)}`}
          />
        ))}
      </span>
      <span className="w-[75px] shrink-0 text-right tabular-nums">
        {counts ? countText(row.positive) : pctText(row.positivePct)}
      </span>
    </li>
  );
}
