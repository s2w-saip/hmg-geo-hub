"use client";

import { useLocale, useTranslations } from "next-intl";
import { TrendingUp, TrendingDown, Minus, Info, GitCompareArrows } from "lucide-react";
import { ColInfo } from "@/components/dash/col-info";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { KPI_DEFINITIONS, type KpiSummary, type KpiCategory } from "../_data/sample";
import { useFilterSignal } from "@/components/dash/use-filter-signal";

// SUMMARY 영역 — 7개 L2 KPI 타일 (HMG 지표 table, 3 카테고리 × 7 KPI).
//
//   답변의 내용 (content):  ①노출률 / ②점유율 / ③우호도 / ④우선노출도
//   답변의 출처 (source):   ⑤인용 점유율 / ⑥타겟 URL 인용률
//   답변의 전환 (conversion): ⑦유입 전환율
//
// 각 타일은 Core Question(작은 머리말) + KPI 타이틀 + 값을 표시하고, 타이틀
// 옆 Info 아이콘 hover 시 정의 + 산식을 보여준다 (Tooltip은 ko/en i18n).
// value === null 인 KPI(scope 미제공: 우호도/우선노출도/타겟URL인용률/
// 유입전환율)는 숫자 대신 "측정 대기" 칩을 렌더한다.

function formatValue(value: number, unit: "percent" | "score" | "rank"): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "rank") return `${value.toFixed(1)} Rank`;
  return value.toFixed(1);
}

function formatDelta(delta: number, unit: "percent" | "score" | "rank"): string {
  const abs = Math.abs(delta);
  if (unit === "percent") return `${abs.toFixed(1)}pp`;
  return abs.toFixed(1);
}

// goodnessOf — combines KPI direction (up/down/flat) with `betterIs`
// (higher/lower) to decide whether a delta should render in green or red.
function goodnessOf(
  direction: "up" | "down" | "flat",
  betterIs: "higher" | "lower",
): "good" | "bad" | "flat" {
  if (direction === "flat") return "flat";
  if (betterIs === "higher") return direction === "up" ? "good" : "bad";
  return direction === "down" ? "good" : "bad";
}

const CATEGORIES: KpiCategory[] = ["content", "source", "conversion"];

export function SummaryTiles({
  items,
  perturb = true,
}: {
  items: KpiSummary[];
  /**
   * When true (default), the deterministic demo signal perturbs the values so
   * the filters visibly move sample fixtures. Set false when `items` is already
   * a real scope-filtered aggregation (e.g. the per-project KPI section) so the
   * tiles show the actual measured numbers, not a demo perturbation.
   */
  perturb?: boolean;
}) {
  const tCat = useTranslations("dashboard.kpi.category");
  // Dimension filters perturb the fixtures via the deterministic signal.
  const sig = useFilterSignal();
  const itemMap = new Map(
    items.map(
      (i) =>
        [
          i.key,
          {
            ...i,
            // i.value is `number | null` (live mode omits unsupported KPIs).
            // Preserve null so the tile can render "—"; only perturb numerics
            // when running on demo fixtures.
            value:
              i.value === null || !perturb
                ? i.value
                : Number(sig.scale(i.value, i.key).toFixed(1)),
          },
        ] as const,
    ),
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-4">
        {CATEGORIES.map((cat) => {
          const defs = KPI_DEFINITIONS.filter(
            (d) => d.category === cat && itemMap.has(d.key),
          );
          // Hide a whole category when none of its KPIs have data (live mode
          // omits unsupported KPIs — e.g. the conversion category).
          if (defs.length === 0) return null;
          return (
            <div key={cat} className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                {tCat(cat)}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {defs.map((def) => (
                  <Tile key={def.key} def={def} summary={itemMap.get(def.key)!} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function Tile({
  def,
  summary,
}: {
  def: (typeof KPI_DEFINITIONS)[number];
  summary: KpiSummary;
}) {
  const tKpi = useTranslations("dashboard.kpi");
  // 라우트 로케일로 고정 — no-arg toLocaleString()은 런타임 기본 로케일(서버
  // Node=en-US vs 브라우저=사용자 언어)을 타서 자릿수 구분자가 갈리면 hydration
  // 텍스트 불일치(React #418)가 된다. 서버/클라이언트가 항상 같은 값을 쓰는
  // 유일한 로케일 소스는 URL 세그먼트다.
  const locale = useLocale();

  const isPending = summary.value === null;
  const hasDelta = summary.delta !== null;

  const goodness = goodnessOf(summary.direction, def.betterIs);
  const DeltaIcon =
    summary.direction === "up"
      ? TrendingUp
      : summary.direction === "down"
        ? TrendingDown
        : Minus;
  const deltaColor =
    goodness === "good"
      ? "text-emerald-600"
      : goodness === "bad"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-soft">
      {hasDelta ? (
        <div className="flex items-baseline justify-end gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums",
              deltaColor,
            )}
          >
            <DeltaIcon className="h-3 w-3" aria-hidden />
            {formatDelta(summary.delta as number, def.unit)}
          </span>
        </div>
      ) : null}
      {/* 타이틀(지표명) + 오른쪽 i 아이콘 — hover 시 정의/산식 */}
      <div className="flex items-center gap-1.5">
        <span className="line-clamp-2 text-sm font-semibold text-foreground">
          {tKpi(`name.${def.key}`)}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={tKpi("infoAriaLabel")}
              className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          {/* Tooltip surface is bg-foreground (dark) — keep all text on the
              light `background` token so it stays readable (was dark-on-dark). */}
          <TooltipContent className="max-w-72 space-y-3 p-3.5 text-left text-pretty">
            <p className="text-xs font-semibold text-background">
              {tKpi(`name.${def.key}`)}
            </p>
            <div className="space-y-1">
              <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
                {tKpi("definitionLabel")}
              </p>
              <p className="text-[11px] leading-relaxed text-background/90">
                {tKpi(`definition.${def.key}`)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
                {tKpi("formulaLabel")}
              </p>
              <p className="text-[11px] leading-relaxed text-background/90">
                {tKpi(`formula.${def.key}`)}
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
      {/* 값 줄 — 왼쪽 큰 값, 오른쪽 엔진 간 일관성 배지. 배지는 이 Core 의 엔진별
          값이 서로 얼마나 붙어 있는지(min ÷ max)를 말하는 별개 지표라, 값과 혼동
          되지 않도록 중립색 + 아이콘 + ⓘ 정의를 함께 둔다. 측정 엔진이 2개 미만
          이거나 카드가 측정 대기면 붙지 않는다. */}
      <div className="flex items-center justify-between gap-2">
        {isPending ? (
          <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tKpi("pending")}
          </span>
        ) : (
          <span className="font-head text-2xl font-semibold tracking-tight tabular-nums text-foreground">
            {formatValue(summary.value as number, def.unit)}
          </span>
        )}
        {summary.engineConsistency != null ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
            <GitCompareArrows className="h-3 w-3" aria-hidden />
            <span className="tabular-nums">{summary.engineConsistency.toFixed(1)}%</span>
            <ColInfo
              title={tKpi("sub.engineConsistency")}
              definition={tKpi("sub.def.engineConsistency.definition")}
              formula={tKpi("sub.def.engineConsistency.formula")}
            />
          </span>
        ) : null}
      </div>
      {/* Coverage hint — region/HQ KPI #7 only. The raw rate over a multi-
          market rollup is misleading on its own, so we surface measurement
          coverage as the partner signal (settled design note). Single-market
          KPIs leave `coverage` undefined and this row stays hidden. */}
      {summary.coverage ? (
        <span className="text-[10.5px] text-muted-foreground">
          {tKpi("coverageLabel", {
            measured: summary.coverage.measured,
            total: summary.coverage.total,
          })}
        </span>
      ) : null}
      {/* Card sparkline — date-dimensioned daily series (trafficConversion only:
          GA4 daily 방문 수). The other cards use the shared trend chart. */}
      {summary.sparkline && summary.sparkline.length >= 2 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          <Sparkline values={summary.sparkline} />
          <span className="text-[10px] text-muted-foreground">
            {tKpi("sparklineHint")}
          </span>
        </div>
      ) : null}
      {/* 분자/분모 수량 — 비율 KPI는 (분자 ÷ 분모 × 100 = 값), 평균순위(④)는
          (순위의 합 ÷ 언급된 답변 수 = avgPosition). 측정 대기 KPI는 ratio 없음.
          라벨은 KPI별 i18n(dashboard.kpi.ratio.{key}.num / .den). */}
      {summary.ratio != null &&
      summary.ratio.numerator != null &&
      summary.ratio.denominator != null ? (
        <dl className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">
              {tKpi(`ratio.${def.key}.num`)}
            </dt>
            <dd className="text-[11px] font-semibold tabular-nums text-foreground">
              {summary.ratio.numerator.toLocaleString(locale)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">
              {tKpi(`ratio.${def.key}.den`)}
            </dt>
            <dd className="text-[11px] font-semibold tabular-nums text-foreground">
              {summary.ratio.denominator.toLocaleString(locale)}
            </dd>
          </div>
        </dl>
      ) : null}
      {/* KPI #16 경쟁사 대비 SOV — shareOfVoice 카드 전용 부가 행. 분모 브랜드
          (지정 타겟 또는 SOV 1위 자동)를 라벨에 노출해 자동 선택도 투명하게.
          value=null → 그 브랜드가 이 집계 창에 언급 0 (측정 대기 칩). */}
      {summary.competitorSov ? (
        <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-border/60 pt-2">
          <span className="text-[11px] text-muted-foreground">
            {tKpi("competitorSov", { brand: summary.competitorSov.brand })}
          </span>
          {summary.competitorSov.value === null ? (
            <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {tKpi("pending")}
            </span>
          ) : (
            <span className="text-[11px] font-semibold tabular-nums text-foreground">
              {summary.competitorSov.value.toFixed(1)}%
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Inline SVG sparkline — dependency-free (recharts is overkill for a 28-point
// micro-trend). Normalizes to its own min/max; a flat series renders a midline.
function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 22;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 1 - ((v - min) / range) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="text-brand-700"
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
