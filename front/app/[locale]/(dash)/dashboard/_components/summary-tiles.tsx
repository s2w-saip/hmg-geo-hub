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
import type { KpiUnit } from "../_data/model";
import { PeriodDeltaCaption, PeriodDeltaChip } from "@/components/dash/delta-chip";
import type { TilesView, TileView } from "../_data/screen-types";

// SUMMARY 영역 — L2 KPI 타일 (HMG 지표 table, 3 카테고리).
//
//   답변의 내용 (content):  ①노출률 / ②점유율 / ③우호도 / ④우선노출도
//   답변의 출처 (source):   자사·타겟 URL 인용률 (웹사이트) / ⑤인용 점유율 / ⑥타겟 URL 인용률
//   답변의 전환 (conversion): ⑦유입 전환율
//
// 각 타일은 KPI 타이틀 + 값을 표시하고, 타이틀 옆 Info 아이콘 hover 시 정의 + 산식을 보여준다.
// 측정 대기 KPI 는 숫자 대신 "측정 대기" 칩을 렌더한다.
//
// SummaryTilesView renders the tiles view the website screens compute (website/summary(-deferred):
// categories, tile state, Δ tone, period chip, suppression caption).

// count(건수)는 정수 + 자릿수 구분 — 로케일은 라우트 세그먼트로 고정(Tile 의 useLocale 주석 참조).
export function formatValue(value: number, unit: KpiUnit, locale?: string): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "rank") return `${value.toFixed(1)} Rank`;
  if (unit === "count") return Math.round(value).toLocaleString(locale);
  return value.toFixed(1);
}

export function formatDelta(delta: number, unit: KpiUnit, locale?: string): string {
  const abs = Math.abs(delta);
  if (unit === "percent") return `${abs.toFixed(1)}pp`;
  if (unit === "count") return Math.round(abs).toLocaleString(locale);
  return abs.toFixed(1);
}

export function SummaryTilesView({ view }: { view: TilesView }) {
  const tCat = useTranslations("dashboard.kpi.category");
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-4">
        {view.groups.map((group) => (
          <div key={group.category} className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {tCat(group.category)}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {group.tiles.map((tile) => (
                <Tile key={tile.key} tile={tile} />
              ))}
            </div>
          </div>
        ))}
        {/* 억제 사유는 **줄 단위 사실**이라 타일마다 반복하지 않는다 — 타일 격자 아래 한 문장. */}
        {view.suppressionCaption ? <PeriodDeltaCaption caption={view.suppressionCaption} /> : null}
      </div>
    </TooltipProvider>
  );
}

function Tile({ tile }: { tile: TileView }) {
  const tKpi = useTranslations("dashboard.kpi");
  // 라우트 로케일로 고정 — no-arg toLocaleString()은 서버/브라우저 로케일이 갈려 hydration 불일치(React #418).
  const locale = useLocale();
  // 원천별 문구(copyVariant): api 카드는 정의가 바뀐 지표의 라벨·툴팁을 api.* 에서 고른다.
  const copy = tile.copyVariant === "api" ? "api." : "";
  const DeltaIcon = tile.direction === "up" ? TrendingUp : tile.direction === "down" ? TrendingDown : Minus;
  const deltaColor =
    tile.tone === "good" ? "text-emerald-600" : tile.tone === "bad" ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-soft">
      {/* Δ 칩 줄 — **항상 자리를 잡는다**(GGMD-61). Δ 가 없으면 칩만 비우고 높이는 유지한다. */}
      <div className="flex h-4 items-center justify-end gap-2">
        {tile.period ? (
          <PeriodDeltaChip chip={tile.period} size="sm" glyph="icon" />
        ) : tile.delta !== null ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums",
              deltaColor,
            )}
          >
            <DeltaIcon className="h-3 w-3" aria-hidden />
            {formatDelta(tile.delta, tile.unit, locale)}
          </span>
        ) : null}
      </div>
      {/* 타이틀(지표명) + 오른쪽 i 아이콘 — hover 시 정의/산식 */}
      <div className="flex items-center gap-1.5">
        <span className="line-clamp-2 text-sm font-semibold text-foreground">
          {tKpi(`name.${tile.key}`)}
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
          {/* Tooltip surface is bg-foreground (dark) — keep all text on the light `background` token. */}
          <TooltipContent className="max-w-72 space-y-3 p-3.5 text-left text-pretty">
            <p className="text-xs font-semibold text-background">
              {tKpi(`name.${tile.key}`)}
            </p>
            <div className="space-y-1">
              <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
                {tKpi("definitionLabel")}
              </p>
              <p className="text-[11px] leading-relaxed text-background/90">
                {tKpi(`${copy}definition.${tile.key}`)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
                {tKpi("formulaLabel")}
              </p>
              <p className="text-[11px] leading-relaxed text-background/90">
                {tKpi(`${copy}formula.${tile.key}`)}
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
      {/* 값 줄 — 왼쪽 큰 값, 오른쪽 엔진 간 일관성 배지(min ÷ max, 측정 대기·엔진 2개 미만이면 없음). */}
      <div className="flex items-center justify-between gap-2">
        {tile.pending ? (
          <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tKpi("pending")}
          </span>
        ) : (
          <span className="font-head text-2xl font-semibold tracking-tight tabular-nums text-foreground">
            {formatValue(tile.value as number, tile.unit, locale)}
          </span>
        )}
        {tile.engineConsistency != null ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
            <GitCompareArrows className="h-3 w-3" aria-hidden />
            <span className="tabular-nums">{tile.engineConsistency.toFixed(1)}%</span>
            <ColInfo
              title={tKpi("sub.engineConsistency")}
              definition={tKpi("sub.def.engineConsistency.definition")}
              formula={tKpi("sub.def.engineConsistency.formula")}
            />
          </span>
        ) : null}
      </div>
      {/* Coverage hint — region/HQ KPI #7 only. */}
      {tile.coverage ? (
        <span className="text-[10.5px] text-muted-foreground">
          {tKpi("coverageLabel", {
            measured: tile.coverage.measured,
            total: tile.coverage.total,
          })}
        </span>
      ) : null}
      {/* Card sparkline — date-dimensioned daily series (trafficConversion only: GA4 daily 방문 수). */}
      {tile.sparkline && tile.sparkline.length >= 2 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          <Sparkline values={tile.sparkline} />
          <span className="text-[10px] text-muted-foreground">
            {tKpi("sparklineHint")}
          </span>
        </div>
      ) : null}
      {/* 분자/분모 수량 — 라벨은 KPI별 i18n(dashboard.kpi.ratio.{key}.num / .den). */}
      {tile.ratio != null &&
      tile.ratio.numerator != null &&
      tile.ratio.denominator != null ? (
        <dl className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">
              {tKpi(`${copy}ratio.${tile.key}.num`)}
            </dt>
            <dd className="text-[11px] font-semibold tabular-nums text-foreground">
              {tile.ratio.numerator.toLocaleString(locale)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">
              {tKpi(`${copy}ratio.${tile.key}.den`)}
            </dt>
            <dd className="text-[11px] font-semibold tabular-nums text-foreground">
              {tile.ratio.denominator.toLocaleString(locale)}
            </dd>
          </div>
        </dl>
      ) : null}
      {/* KPI #16 경쟁사 대비 SOV — shareOfVoice 카드 전용 부가 행(분모 브랜드명 노출). */}
      {tile.competitorSov ? (
        <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-border/60 pt-2">
          <span className="text-[11px] text-muted-foreground">
            {tKpi("competitorSov", { brand: tile.competitorSov.brand })}
          </span>
          {tile.competitorSov.value === null ? (
            <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {tKpi("pending")}
            </span>
          ) : (
            <span className="text-[11px] font-semibold tabular-nums text-foreground">
              {tile.competitorSov.value.toFixed(1)}%
            </span>
          )}
        </div>
      ) : null}
      {/* 값의 출처 — 발행 리포트 정본 경로가 켜졌을 때만 뜬다. */}
      {tile.provenance ? (
        <p className="mt-1 border-t border-border/60 pt-2 text-[10px] leading-snug text-muted-foreground">
          {tile.provenance.source === "published"
            ? tKpi("provenance.published", {
                cycle:
                  (locale === "ko"
                    ? tile.provenance.cycleLabel
                    : tile.provenance.cycleLabelEn) ??
                  tile.provenance.cycleLabel ??
                  tile.provenance.roundDate ??
                  "",
                sites: tile.provenance.siteCount ?? 0,
              })
            : tKpi("provenance.live")}
        </p>
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
