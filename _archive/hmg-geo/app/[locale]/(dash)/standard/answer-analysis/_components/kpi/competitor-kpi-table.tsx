"use client";

// 경쟁사 KPI 테이블 — 노출률·점유율 두 탭이 `metric` prop 만 바꿔 공유한다
// (스펙 SHALL: "노출률·점유율 탭은 공용 컴포넌트를 공유한다").
//
// 열의 출처가 다르다는 점이 이 표의 핵심 규약이다:
//   값·바   = 스냅샷(요약 카드와 같은 창)
//   추이·증감 = 회차 집계(allRuns 창, 결측은 갭)
// 한 열에 섞으면 재측정 중인 마지막 버킷이 값 열을 흔든다.
//
// 2026-09-02 피그마 1:1(327:116 하단 표, 운영 결정):
//   · "경쟁사 선택"은 **복수 선택 + 검색** 드롭다운. 선택하면 표는 당사 + 선택 브랜드만.
//   · 표 바는 당사 navy / 경쟁사 회색(ink-300), 15px 각진 트랙. 헤더 30px·행 38px·스크롤.
//
// 2026-09-10 QA 2차 #4·#6(고객 지적, 운영 결정 D3·D7):
//   · 도넛은 **선택한 경쟁사 전부**가 조각이다(당사 + N + 그 외). 종전에는 `onPick`
//     계약이 단수라 `next[0]` 으로 잘려 첫 1개만 올라갔다.
//   · 조각 호버 툴팁(`<Tooltip>`)을 배선한다 — 종전에는 아예 없었다.
//   · 선택 상태는 **탭이 소유**하되 이 섹션 전용이다(유형·엔진 섹션과 결합 해제).
//   · 노출률(exposure)은 브랜드별 "등장 답변 비율"이라 브랜드 간 합이 100 을 넘을 수
//     있다. recharts Pie 는 합으로 정규화하므로 조각 각도는 **선택 브랜드 간 상대
//     비중**이 된다 — 중앙 라벨(당사 합산 값)과 모순돼 보이지 않도록 각주로 명시한다.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Search } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { cn } from "@/lib/utils";
import type { CompetitorKpiRow, KpiMetric, TrendCoverage } from "../../_data/kpi-view";
import { ownShareDonut } from "../../_data/kpi-view";
import { brandColor } from "./series-colors";
import { DeltaBadge, pctText, ppText, ValueBar } from "./kpi-bits";
import { SparkLine } from "./spark-line";

/** 도넛 조각 하나 — 이름·값·색이 범례·툴팁과 **같은 배열**에서 나온다. */
export interface DonutSlice {
  /** react key. 브랜드명이 라벨과 겹칠 수 있어 접두사를 붙인다. */
  key: string;
  name: string;
  value: number;
  color: string;
}

/**
 * 도넛 조각 = 당사 합산 · 선택 경쟁사 각각 · 그 외.
 *
 * 규약 셋:
 *   1. 조각 순서는 **표의 행 순서**다(클릭 순서가 아니다) — 같은 선택 집합이면
 *      항상 같은 그림이 나온다.
 *   2. 색은 `colorIndex`(필터 전 행 순서)에서 나온다 — 선택 개수가 바뀌어도 한
 *      브랜드의 색이 흔들리지 않고, 같은 표의 스파크라인·히어로 차트와 맞는다.
 *   3. '그 외'는 음수가 될 수 없다(노출률 합이 100 을 넘으면 0 으로 눌린다).
 */
export function donutSlices({
  rows,
  ownPct,
  selected,
  ownLabel,
  restLabel,
  colorIndex,
}: {
  rows: CompetitorKpiRow[];
  ownPct: number | null;
  selected: string[];
  ownLabel: string;
  restLabel: string;
  colorIndex: Map<string, number>;
}): DonutSlice[] | null {
  const donut = ownShareDonut(ownPct);
  if (!donut) return null;
  const picked = new Set(selected);
  const chosen = rows.filter((r) => !r.isTracked && picked.has(r.brand) && r.pct != null);
  const rest = Math.max(0, Math.round((donut.rest - chosen.reduce((s, r) => s + (r.pct ?? 0), 0)) * 10) / 10);
  return [
    { key: "own", name: ownLabel, value: donut.own, color: "var(--color-brand-700)" },
    ...chosen.map((r) => ({
      key: `brand:${r.brand}`,
      name: r.brand,
      value: r.pct as number,
      color: brandColor(r.brand, false, colorIndex.get(r.brand) ?? 0),
    })),
    { key: "rest", name: restLabel, value: rest, color: "var(--color-ink-100)" },
  ];
}

export function CompetitorKpiTable({
  metric,
  rows,
  ownPct,
  coverage,
  selected,
  onSelectedChange,
}: {
  metric: KpiMetric;
  rows: CompetitorKpiRow[];
  /** 히어로와 같은 당사 **합산** 값 — 도넛 중앙과 Gap 기준. */
  ownPct: number | null;
  /** 스파크라인 축의 커버리지 — 총 회차·측정 회차·결측 회차. */
  coverage: TrendCoverage;
  /**
   * 이 섹션의 경쟁사 선택(복수). **완전 제어 컴포넌트**다 — 상태를 탭이 들고 있는
   * 이유는 <Suspense> 경계가 다시 서스펜드해도 선택이 리셋되지 않게 하기 위해서고,
   * 그 상태는 이 섹션 전용이다(QA 2차 #6: 유형·엔진 섹션과 결합 해제).
   */
  selected: string[];
  onSelectedChange: (brands: string[]) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const [query, setQuery] = useState("");

  const competitors = rows.filter((r) => !r.isTracked);
  // 색 인덱스는 **필터 전 행 순서**로 고정한다 — 선택으로 행이 줄어들 때 인덱스가
  // 당겨지면 같은 브랜드가 다른 색이 되고, 히어로 차트와도 어긋난다.
  const colorIndex = useMemo(() => new Map(rows.map((r, i) => [r.brand, i])), [rows]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(
    () => (selected.length === 0 ? rows : rows.filter((r) => r.isTracked || selectedSet.has(r.brand))),
    [rows, selected, selectedSet],
  );
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? competitors.filter((c) => c.brand.toLowerCase().includes(q)) : competitors;
  }, [competitors, query]);

  // 종전 `onPick(next[0] ?? null)` 이 다중 선택을 첫 1개로 잘라 도넛·유형 섹션에
  // 올렸다(QA 2차 #4a 의 직접 원인). 이제 선택 전체를 그대로 올린다.
  function commit(next: string[]) {
    onSelectedChange(next);
  }
  function toggle(brand: string) {
    commit(selectedSet.has(brand) ? selected.filter((b) => b !== brand) : [...selected, brand]);
  }

  // 바 축은 표 전체의 최대값으로 고정한다 — 행마다 축이 달라지면 길이 비교가 거짓말이 된다.
  const barMax = Math.max(1, ...rows.map((r) => r.pct ?? 0));

  // 도넛 중앙 라벨 — `ownPct` 는 당사 **합집합**(Hyundai·Kia·Genesis 합산)이다.
  // 종전에는 tracked 첫 행의 브랜드명을 붙여, 표준 루트 무필터에서 중앙이
  // "Hyundai 60.0%" 인데 같은 표의 Hyundai 행은 40.0% 인 모순이 났다
  // (2026-09-01 verifier 지적 F3). 당사가 둘 이상이면 집합 라벨을 쓴다.
  const trackedRows = rows.filter((r) => r.isTracked);
  const ownBrandLabel =
    trackedRows.length === 1
      ? trackedRows[0].brand
      : trackedRows.length > 1
        ? t("competitor.ownSet", { n: trackedRows.length })
        : t("competitor.ownDonutLabel");
  const showSeriesFootnote = visible.some((r) => !r.inTrendSeries);

  // 도넛 · 범례 · 툴팁이 **같은 배열**을 본다 — 셋이 갈라지면 그림과 라벨이 어긋난다.
  const slices = donutSlices({
    rows,
    ownPct,
    selected,
    ownLabel: ownBrandLabel,
    restLabel: t("competitor.restLegend"),
    colorIndex,
  });
  // 노출률은 브랜드 간 합이 100 을 넘을 수 있어 조각 각도가 절대값이 아니다(운영 D3).
  const showRelativeNote = metric === "exposure" && slices != null && slices.length > 2;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            {t("competitor.title", { metric: t(`metricShort.${metric}`) })}
          </h3>
          <p className="text-xs text-muted-foreground">{t(`competitor.hint.${metric}`)}</p>
        </div>
        {competitors.length > 0 ? (
          <DropdownMenu onOpenChange={(o) => !o && setQuery("")}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-44 justify-between text-xs font-medium"
                aria-label={t("competitor.select")}
              >
                <span className="truncate">
                  {selected.length === 0
                    ? t("competitor.select")
                    : selected.length === 1
                      ? selected[0]
                      : t("competitor.selectedCount", { n: selected.length })}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 p-1.5">
              <div className="relative mb-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("competitor.search")}
                  aria-label={t("competitor.search")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  commit([]);
                }}
                className="text-xs"
              >
                {t("competitor.selectAll")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="max-h-64 overflow-y-auto">
                {filteredOptions.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.brand}
                    checked={selectedSet.has(c.brand)}
                    onCheckedChange={() => toggle(c.brand)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {c.brand}
                  </DropdownMenuCheckboxItem>
                ))}
                {filteredOptions.length === 0 ? (
                  <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">{t("competitor.noMatch")}</p>
                ) : null}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">
          {t("competitor.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-start">
          {/* 종전 고정 h-[220px] 은 범례가 1~2개일 때의 값이다. 선택이 늘면 범례가
              여러 줄이 되므로(표 행 상한 12 → 경쟁사 최대 11개) 최소 높이로 바꿔
              표와의 정렬은 유지하되 범례가 카드 밖으로 넘치지 않게 한다. */}
          <div className="flex min-h-[220px] shrink-0 flex-col items-center justify-center gap-2 lg:w-64">
            {slices ? (
              <>
                <div className="relative h-44 w-44">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    initialDimension={{ width: 176, height: 176 }}
                  >
                    <PieChart>
                      <Pie
                        data={slices}
                        dataKey="value"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={1}
                        isAnimationActive={false}
                      >
                        {slices.map((sl) => (
                          <Cell key={sl.key} fill={sl.color} />
                        ))}
                      </Pie>
                      {/* QA 2차 #4b — 조각 호버가 무동작이던 원인은 이 한 줄의 부재였다.
                          중앙 라벨 오버레이는 pointer-events-none 이라 호버를 막지 않는다. */}
                      <RTooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        wrapperStyle={{ zIndex: 50 }}
                        formatter={(v: unknown) => pctText(v == null ? null : Number(v))}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xs text-muted-foreground">{ownBrandLabel}</span>
                    <span className="text-xl font-semibold tabular-nums">{pctText(ownPct)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-muted-foreground">
                  {/* '그 외'(마지막 조각)는 범례에 넣지 않는다 — 피그마 규약. */}
                  {slices.slice(0, -1).map((sl, i) => (
                    <LegendDot
                      key={sl.key}
                      color={sl.color}
                      text={i === 0 ? t("competitor.ownLegend", { brand: sl.name }) : sl.name}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {/* 피그마 327:116 표: 헤더 30px·bg-soft·11px, 행 38px, 당사 행 brand-25.
              QA 2차 #7(운영) — 보이는 행은 **5행**(당사 3사 Hyundai·Kia·Genesis + 경쟁사 2)
              이고 나머지는 카드 안에서 세로 스크롤한다. 행 순서는 `competitorKpiRows` 가
              "당사 먼저 → 값 내림차순"으로 고정하므로(kpi-view.ts) 처음 5행이 그 구성이다.
              높이 근거: 헤더 30px + 행 38px × 5 = **220px** 고정(= 게이지 히어로의 차트
              지면 220px 과 같은 값). 스크롤 컨테이너라 행이 4개뿐이어도 높이가 안 흔들린다. */}
          <div className="min-w-0 flex-1 h-[220px] overflow-y-auto overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[38rem] text-xs">
              <thead className="sticky top-0 z-10 bg-bg-soft">
                <tr className="h-[30px] border-b border-border text-left text-[11px] text-muted-foreground">
                  <th scope="col" className="px-3 font-medium">{t("competitor.col.brand")}</th>
                  <th scope="col" className="px-3 font-medium">{t(`metric.${metric}`)}</th>
                  <th scope="col" className="px-3 font-medium">
                    {t("competitor.col.trend", { n: coverage.cycles })}
                  </th>
                  <th scope="col" className="px-3 font-medium">{t("competitor.col.delta")}</th>
                  <th scope="col" className="px-3 font-medium">{t("competitor.col.gap")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.brand}
                    className={cn("h-[38px] border-b border-border/60", r.isTracked && "bg-brand-25")}
                  >
                    <th
                      scope="row"
                      className={cn("px-3 text-left text-foreground", r.isTracked ? "font-semibold" : "font-normal")}
                    >
                      {r.brand}
                    </th>
                    <td className="px-3">
                      <span className="flex items-center gap-2">
                        <span className="w-12 shrink-0 tabular-nums">{pctText(r.pct)}</span>
                        <ValueBar
                          value={r.pct}
                          max={barMax}
                          // 피그마: 당사 navy, 경쟁사 회색 — 브랜드 색은 추이 라인에서만 쓴다.
                          color={r.isTracked ? "var(--color-brand-700)" : "var(--color-ink-300)"}
                          label={`${r.brand} ${pctText(r.pct)}`}
                          className="h-[15px]"
                        />
                      </span>
                    </td>
                    <td className="px-3">
                      {/* 시리즈 밖(cap 초과) = 추이를 **계산하지 않은** 것이지 측정이
                          없는 것이 아니다 — 같은 "—" 로 보이면 값 열의 수치와 모순돼
                          보인다(verifier 지적 F5). 별도 표기 + 각주로 구분한다. */}
                      {r.inTrendSeries ? (
                        <SparkLine
                          values={r.spark}
                          color={brandColor(r.brand, r.isTracked, colorIndex.get(r.brand) ?? 0)}
                          label={`${r.brand} ${t("competitor.col.trend", { n: coverage.cycles })}`}
                        />
                      ) : (
                        <span
                          className="text-[11px] text-muted-foreground"
                          title={t("competitor.notInSeriesHint")}
                        >
                          {t("competitor.notInSeries")}
                        </span>
                      )}
                    </td>
                    <td className="px-3">
                      {r.wowPp == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <DeltaBadge value={r.wowPp} unit="pp" />
                      )}
                    </td>
                    <td className="px-3 tabular-nums">
                      <span className={r.gapPp == null ? "text-muted-foreground" : undefined}>
                        {ppText(r.gapPp)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 커버리지 각주는 스크롤 영역 밖 — 표가 스크롤해도 항상 보인다. 스파크라인 축이
              히어로 추이와 같은 축임을 드러내고, 결측 회차가 몇 개인지 숫자로 말한다
              (스펙: "커버리지 라벨이 결측을 드러낸다"). */}
          {showRelativeNote ? (
            <p className="w-full text-[11px] text-muted-foreground">
              {t("competitor.donutRelativeNote")}
            </p>
          ) : null}
          <p className="w-full text-[11px] text-muted-foreground">
            {coverage.missingCycles > 0
              ? t("competitor.coverageWithGaps", {
                  cycles: coverage.cycles,
                  measured: coverage.measuredCycles,
                  missing: coverage.missingCycles,
                })
              : t("competitor.coverage", {
                  cycles: coverage.cycles,
                  measured: coverage.measuredCycles,
                })}
            {showSeriesFootnote ? ` · ${t("competitor.notInSeriesHint")}` : ""}
          </p>
        </div>
      )}
    </section>
  );
}

function LegendDot({ color, text }: { color: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
      {text}
    </span>
  );
}
