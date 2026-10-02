"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Trophy, Hash, BarChart3, Swords, ArrowRightLeft, Hourglass, Info } from "lucide-react";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import {
  Tooltip as InfoTooltip,
  TooltipContent as InfoTooltipContent,
  TooltipProvider as InfoTooltipProvider,
  TooltipTrigger as InfoTooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";
import { BATTLE_BRAND_COLORS, ACR_SERIES_FALLBACK } from "../_data/sample";

// 표준 ACR — scope 2턴 선택 측정(prompt kind='acr')의 실데이터 뷰.
// 섹션 구성·문구는 기획 확정본(샘플 AcrView, aiFunnelView.acr 딕셔너리)을
// 따르고 데이터만 미러 집계(fetchStandardAcr)로 교체한다. 산식(전부 0~100%
// 보장, scope-aggregates ACR 섹션 주석 참조):
//   Top1 ACR = 최종 선택 ÷ 전체 유효 반복 (선택 점유율)
//   Top5 ACR(후보군 포함율) = 등장한 측정 셀 ÷ 전체 셀
//   ※ scope의 appearance_count/appearance_rate/acr 원필드는 언급 횟수 기반
//     (반복 수 초과 가능, 2026-07-08 실측)이라 비율 지표로 쓰지 않는다.
// 기획 확정본과 다른 두 가지: ① 브랜드별 ACR을 필(태그)이 아니라 정렬 가능한
// 표로 (2026-07-08 피드백), ② 테리토리 맵은 반복 "순서"가 공개 API에 없어
// 선택 횟수 분포로 그린다. 측정 전에는 대기 상태 — 샘플 폴백 없음.

type ConvSortKey = "brand" | "model" | "conv" | "shortlist" | "top1";
type BrandSortKey = "brand" | "top1" | "coverage" | "choices" | "appearances";

// ACR 필터 축 = aggregateAcrFromMirror::acrWhere 가 실제로 좁히는 축만 노출.
// (mentions/citations 뷰가 STANDARD_*_ONLY_GROUPS 로 하는 것과 동일 패턴 —
// 패널이 competitor/source/language/device/visitorType/depth4 처럼 acrWhere 가
// 무시하는 축을 띄우면 "적용해도 아무 변화 없는" 죽은 필터가 되어 필터 스키마와
// 데이터 스키마가 어긋난다.) brand 는 admin 일 때 패널이 자동 삽입(acrWhere 도
// 카탈로그 brand 를 honor)하므로 여기 나열하지 않는다.
// 퍼널(promptContext) 제외 (2026-07-08): 표준 ACR 지정 프롬프트 69개가 전부
// '비교/검증' 단일 단계라 퍼널 필터는 값이 하나뿐인 죽은 축 — 인지/구매 단계에
// ACR 프롬프트가 생기면 재도입.
// language (2026-09-03): 표준 ACR 롤업은 21개 언어에 걸쳐 있어(운영 DB 실측) 죽은
// 단일값 축이 아니다. 축을 켜기 **전에** acrWhere 에 표준 언어 술어를 먼저 넣었고
// (scope-aggregates::acrWhere → langAxisPred), 옵션도 이 화면의 모집단인
// scope_acr_rollups 에서 낸다(listMeasuredAcrLanguages). 옵션이 비면 아래
// acrOnlyGroups 가 축을 도로 내린다 — 위 "죽은 필터 금지" 원칙 그대로.
const STANDARD_ACR_ONLY_GROUPS: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "time",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
];

// 실측 언어가 없으면 language 축을 뺀 목록 — 대시보드(overviewOnlyGroups)와 같은 규칙.
// exported for tests.
export function acrOnlyGroups(languageOptions?: string[]): DimensionGroup[] {
  return languageOptions?.length
    ? STANDARD_ACR_ONLY_GROUPS
    : STANDARD_ACR_ONLY_GROUPS.filter((g) => g !== "language");
}
const STANDARD_ACR_PRIMARY: DimensionGroup[] = ["geography", "engine", "time"];

// Battle grid 는 측정된 프롬프트가 많을 수 있어(표준 루트 67개) 상위 N개만 펼치고
// 나머지는 접어서 노출 — "N개 더 보기"로 펼침.
const BATTLE_VISIBLE = 30;

export function AcrLiveView({
  data,
  acrPromptCount,
  scope,
  catalogRows,
  geographyOptions,
  languageOptions,
  selectableDates,
}: {
  data: StandardAcr | null;
  acrPromptCount: number;
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
  geographyOptions?: string[];
  // ACR 롤업이 실제로 보유한 언어(소문자 BCP-47) — scope-aggregates::
  // listMeasuredAcrLanguages. 표준 답변 옵션(28종)이 아니라 ACR 모집단(21종)에서
  // 내야 "고르면 빈 화면"인 죽은 옵션 7개가 안 생긴다.
  languageOptions?: string[];
  /** 앵커 축(스펙 §5.1) — 회차가 있는 KST 날짜. 지면 계열은 ACR 리더와 같다. */
  selectableDates?: string[];
}) {
  // 기획 확정 문구는 aiFunnelView.acr(샘플과 공유), 실데이터 전용 문구(대기
  // 상태·분포 주석)는 aiFunnelView.acrLive.
  const t = useTranslations("aiFunnelView.acr");
  const tLive = useTranslations("aiFunnelView.acrLive");

  const ours = data?.brands.find((b) => b.isOurs) ?? null;

  const trendBrands = useMemo(() => {
    const set = new Set<string>();
    for (const b of data?.trend ?? []) for (const k of Object.keys(b.series)) set.add(k);
    return [...set];
  }, [data]);
  const trendRows = useMemo(
    () => (data?.trend ?? []).map((b) => ({ date: b.date, ...b.series })),
    [data],
  );

  // 브랜드 → 색 고정 맵 — 추이·범례·분포 셀이 같은 브랜드에 항상 같은 색을
  // 쓰도록 한 곳에서 배정 (행/차트마다 인덱스가 달라지는 색 흔들림 방지).
  const brandColorMap = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    const assign = (brand: string) => {
      if (map.has(brand)) return;
      map.set(
        brand,
        BATTLE_BRAND_COLORS[brand] ?? ACR_SERIES_FALLBACK[i++ % ACR_SERIES_FALLBACK.length],
      );
    };
    for (const b of data?.brands ?? []) assign(b.brand);
    for (const b of trendBrands) assign(b);
    for (const s of data?.territory ?? [])
      for (const row of s.rows) for (const e of row.entries) assign(e.brand);
    return map;
  }, [data, trendBrands]);
  const brandColor = (brand: string): string =>
    brandColorMap.get(brand) ?? "var(--color-ink-300)";

  // 브랜드별 ACR 표 — 기본 Top1(선택 점유율) 내림차순, 헤더로 재정렬 가능.
  const { sorted: brandRanked, headerProps: brandHeader } = useSortableTable<
    StandardAcr["brands"][number],
    BrandSortKey
  >(
    data?.brands ?? [],
    {
      brand: (r) => r.brand,
      top1: (r) => r.choiceShare ?? -1,
      coverage: (r) => r.coverage ?? -1,
      choices: (r) => r.choiceCount,
      appearances: (r) => r.appearanceCount,
    },
    { defaultKey: "top1", defaultAsc: false, ascByDefault: ["brand"] },
  );

  const { sorted: convRanked, headerProps: convHeader } = useSortableTable<
    StandardAcr["modelConversion"][number],
    ConvSortKey
  >(
    data?.modelConversion ?? [],
    {
      brand: (r) => r.brand ?? "",
      model: (r) => r.model,
      conv: (r) => r.conversionRate ?? -1,
      shortlist: (r) => r.shortlistCount,
      top1: (r) => r.top1Count,
    },
    { defaultKey: "conv", defaultAsc: false, ascByDefault: ["brand", "model"] },
  );

  const engines = data?.totals.engines ?? [];
  const territory = data?.territory ?? [];
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [battleExpanded, setBattleExpanded] = useState(false);
  const battleAll = data?.battle ?? [];
  const battleRows = battleExpanded ? battleAll : battleAll.slice(0, BATTLE_VISIBLE);
  const battleHidden = battleAll.length - battleRows.length;
  const activeSheet = territory[Math.min(activeSheetIdx, Math.max(0, territory.length - 1))];
  // 범례: 활성 시트에 등장하는 브랜드 (선택 수 내림차순).
  const legendBrands = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of activeSheet?.rows ?? [])
      for (const e of row.entries) counts.set(e.brand, (counts.get(e.brand) ?? 0) + e.choice);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([brand]) => brand);
  }, [activeSheet]);

  return (
    <InfoTooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      <DimensionFilterPanel
        stage="acr"
        selectableDates={selectableDates}
        onlyGroups={acrOnlyGroups(languageOptions)}
        primaryGroups={STANDARD_ACR_PRIMARY}
        sections={FILTER_SECTIONS}
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        sticky
      />

      {!data || !data.measured ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-6 py-14 text-center">
          <Hourglass className="h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-semibold text-foreground">{tLive("empty.title")}</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            {tLive("empty.desc", { count: acrPromptCount })}
          </p>
        </div>
      ) : (
        <>
          {/* 브랜드별 ACR — 정렬 가능한 표 (Top1 = 선택 점유율 내림차순) */}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold tracking-tight text-foreground">
                {t("pillsLabel")}
              </h3>
              <p className="text-[11px] text-muted-foreground">{tLive("brandTable.hint")}</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  <th className="w-10 px-3 py-2 text-right">#</th>
                  <th className="px-3 py-2"><SortableHeader {...brandHeader("brand")}>{tLive("brandTable.col.brand")}</SortableHeader></th>
                  <th className="px-3 py-2">
                    <div className="flex w-full items-center justify-end gap-1">
                      <SortableHeader {...brandHeader("top1")}>{t("kpi.top1")}</SortableHeader>
                      <MetricInfo
                        title={t("def.top1.title")}
                        definition={t("def.top1.definition")}
                        formula={t("def.top1.formula")}
                      />
                    </div>
                  </th>
                  <th className="px-3 py-2">{tLive("brandTable.col.bar")}</th>
                  <th className="px-3 py-2">
                    <div className="flex w-full items-center justify-end gap-1">
                      <SortableHeader {...brandHeader("coverage")}>{tLive("brandTable.col.coverage")}</SortableHeader>
                      <MetricInfo
                        title={t("def.coverage.title")}
                        definition={t("def.coverage.definition")}
                        formula={t("def.coverage.formula")}
                      />
                    </div>
                  </th>
                  <th className="px-3 py-2"><SortableHeader {...brandHeader("choices")} align="right">{tLive("brandTable.col.choices")}</SortableHeader></th>
                  <th className="px-3 py-2"><SortableHeader {...brandHeader("appearances")} align="right">{tLive("brandTable.col.appearances")}</SortableHeader></th>
                </tr>
              </thead>
              <tbody>
                {brandRanked.map((b, i) => (
                  <tr
                    key={b.brand}
                    className={cn(
                      "border-t border-border first:border-t-0",
                      b.isOurs && "bg-brand-700/[0.04]",
                    )}
                  >
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {i + 1}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 font-medium",
                        b.isOurs ? "text-brand-700" : "text-foreground",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2.5 w-2.5 rounded-[2px]"
                          style={{ backgroundColor: brandColor(b.brand) }}
                          aria-hidden
                        />
                        {b.brand}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-foreground">
                      {b.choiceShare != null ? `${b.choiceShare.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="h-2 w-full max-w-[140px] overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            b.isOurs ? "bg-brand-700" : "bg-brand-300",
                          )}
                          style={{ width: `${Math.min(100, b.choiceShare ?? 0)}%` }}
                          aria-hidden
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {b.coverage != null ? `${b.coverage.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {b.choiceCount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {b.appearanceCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* KPI cards — 우리 브랜드 기준 (기획 확정 4카드) */}
          <div className="grid gap-3 sm:grid-cols-4">
            <KpiCard
              icon={Trophy}
              label={t("kpi.top1")}
              value={ours?.choiceShare != null ? `${ours.choiceShare.toFixed(1)}%` : "—"}
              hint={t("kpi.top1Hint")}
              info={{
                title: t("def.top1.title"),
                definition: t("def.top1.definition"),
                formula: t("def.top1.formula"),
              }}
            />
            <KpiCard
              icon={Trophy}
              label={t("kpi.top5")}
              value={ours?.coverage != null ? `${ours.coverage.toFixed(1)}%` : "—"}
              hint={t("kpi.top5Hint")}
              info={{
                title: t("def.coverage.title"),
                definition: t("def.coverage.definition"),
                formula: t("def.coverage.formula"),
              }}
            />
            <KpiCard
              icon={BarChart3}
              label={t("kpi.answers")}
              value={data.totals.iterations.toLocaleString()}
              hint={t("kpi.answersHint")}
            />
            <KpiCard
              icon={Hash}
              label={t("kpi.rank1")}
              value={(ours?.choiceCount ?? 0).toLocaleString()}
              hint={t("kpi.rank1Hint")}
            />
          </div>

          {/* Trend chart — 일별 선택률 */}
          {trendRows.length > 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  {t("trend.title")}
                </h3>
                <p className="text-[11px] text-muted-foreground">{t("trend.hint")}</p>
              </div>
              <div className="h-64 min-w-0 p-3">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 640, height: 256 }}
                >
                  <LineChart data={trendRows} margin={{ left: -16, right: 8, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
                    <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" unit="%" />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {trendBrands.map((brand, i) => (
                      <Line
                        key={brand}
                        type="monotone"
                        dataKey={brand}
                        stroke={brandColor(brand)}
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : null}

          {/* Battle grid — 프롬프트 × 엔진 승자 */}
          {data.battle.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  {t("battle.title")}
                </h3>
                <p className="text-[11px] text-muted-foreground">{t("battle.hint")}</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      <th className="px-3 py-2">{t("battle.col.prompt")}</th>
                      {engines.map((m) => (
                        <th key={m} className="px-3 py-2 text-center">
                          {m}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {battleRows.map((row) => (
                      <tr key={row.promptId} className="border-t border-border first:border-t-0">
                        <td className="max-w-md px-3 py-2 text-foreground">
                          <span className="line-clamp-2">{row.promptText ?? row.promptId}</span>
                        </td>
                        {engines.map((m) => {
                          const cell = row.cells.find((c) => c.engine === m);
                          return (
                            <td key={m} className="px-3 py-2 text-center">
                              {cell?.winner ? (
                                <span
                                  className={cn(
                                    "rounded px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
                                    cell.winnerIsOurs
                                      ? "bg-brand-700/10 text-brand-700"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {cell.winner}
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {battleAll.length > BATTLE_VISIBLE ? (
                <div className="border-t border-border px-4 py-2">
                  <button
                    type="button"
                    onClick={() => setBattleExpanded((v) => !v)}
                    className="text-[11px] font-medium text-brand-700 underline-offset-2 hover:underline"
                  >
                    {battleExpanded
                      ? t("battle.showLess")
                      : t("battle.showMore", { count: battleHidden })}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Model conversion — (브랜드 × 차종) shortlist→top1 전환율 */}
          {convRanked.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <ArrowRightLeft className="h-4 w-4 text-muted-foreground" aria-hidden />
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {t("modelConversion.title")}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {t("modelConversion.hint")}
                  </p>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    <th className="w-10 px-3 py-2 text-right">#</th>
                    <th className="px-3 py-2"><SortableHeader {...convHeader("brand")}>{t("modelConversion.col.brand")}</SortableHeader></th>
                    <th className="px-3 py-2"><SortableHeader {...convHeader("model")}>{t("modelConversion.col.model")}</SortableHeader></th>
                    <th className="px-3 py-2">
                      <div className="flex w-full items-center justify-end gap-1">
                        <SortableHeader {...convHeader("conv")}>{t("modelConversion.col.conv")}</SortableHeader>
                        <MetricInfo
                          title={t("def.conversion.title")}
                          definition={t("def.conversion.definition")}
                          formula={t("def.conversion.formula")}
                        />
                      </div>
                    </th>
                    <th className="px-3 py-2">{t("modelConversion.col.bar")}</th>
                    <th className="px-3 py-2"><SortableHeader {...convHeader("shortlist")} align="right">{t("modelConversion.col.shortlist")}</SortableHeader></th>
                    <th className="px-3 py-2"><SortableHeader {...convHeader("top1")} align="right">{t("modelConversion.col.top1")}</SortableHeader></th>
                  </tr>
                </thead>
                <tbody>
                  {convRanked.map((r, i) => (
                    <tr
                      key={`${r.brand}-${r.model}`}
                      className={cn(
                        "border-t border-border first:border-t-0",
                        r.isOurs && "bg-brand-700/[0.04]",
                      )}
                    >
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {i + 1}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 font-medium",
                          r.isOurs ? "text-brand-700" : "text-foreground",
                        )}
                      >
                        {r.brand ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-foreground">{r.model}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-foreground">
                        {r.conversionRate != null ? `${r.conversionRate.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="h-2 w-full max-w-[140px] overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              r.isOurs ? "bg-brand-700" : "bg-brand-300",
                            )}
                            style={{ width: `${Math.min(100, r.conversionRate ?? 0)}%` }}
                            aria-hidden
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {r.shortlistCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {r.top1Count.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Territory map — 지역×엔진 시트별 선택 분포 맵 */}
          {territory.length > 0 && activeSheet ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Swords className="h-4 w-4 text-muted-foreground" aria-hidden />
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {t("territory.title")}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {tLive("territoryHint")}
                  </p>
                </div>
              </div>

              {/* Sheet tabs (지역 × 엔진) */}
              <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2">
                {territory.map((s, i) => (
                  <button
                    key={`${s.region}-${s.engine}`}
                    type="button"
                    onClick={() => setActiveSheetIdx(i)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
                      s === activeSheet
                        ? "border-brand-700 bg-brand-700/5 text-brand-700"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.region ?? "—"} · {s.engine}
                  </button>
                ))}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-[10px] text-muted-foreground">
                {legendBrands.map((brand, i) => (
                  <span key={brand} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-[2px]"
                      style={{ backgroundColor: brandColor(brand) }}
                      aria-hidden
                    />
                    {brand}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
                  {t("territory.noChoice")}
                </span>
              </div>

              {/* Grid — 셀 = 브랜드별 선택 횟수 분포 (validAcr 칸) */}
              <div className="overflow-x-auto px-4 py-3">
                <table className="text-sm">
                  <thead>
                    <tr className="text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      <th className="px-2 py-1">{t("battle.col.prompt")}</th>
                      <th className="px-2 py-1 text-center" colSpan={10}>
                        {tLive("territoryDistribution")}
                      </th>
                      <th className="px-2 py-1">{t("territory.dominant")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.rows.map((row) => {
                      const chosen = row.entries.reduce((s, e) => s + e.choice, 0);
                      const noChoice = Math.max(0, row.validAcr - chosen);
                      const dom = row.entries[0] ?? null;
                      return (
                        <tr key={row.promptId}>
                          <td className="max-w-sm px-2 py-1 text-foreground">
                            <span className="line-clamp-1">{row.promptText ?? row.promptId}</span>
                          </td>
                          <td className="px-0.5 py-1" colSpan={10}>
                            <div className="flex items-center gap-0.5">
                              {row.entries.flatMap((e, ei) =>
                                Array.from({ length: e.choice }, (_, n) => (
                                  <span
                                    key={`${e.brand}-${n}`}
                                    className="inline-block h-4 w-4 rounded-[2px]"
                                    style={{ backgroundColor: brandColor(e.brand) }}
                                    title={e.brand}
                                    aria-label={e.brand}
                                  />
                                )),
                              )}
                              {Array.from({ length: noChoice }, (_, n) => (
                                <span
                                  key={`nc-${n}`}
                                  className="mx-[5px] inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/30"
                                  aria-label={t("territory.noChoice")}
                                />
                              ))}
                            </div>
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {dom ? (
                              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                                <span
                                  className="h-2.5 w-2.5 rounded-[2px]"
                                  style={{ backgroundColor: brandColor(dom.brand) }}
                                  aria-hidden
                                />
                                {dom.brand} {dom.choice}
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <p className="text-[11px] text-muted-foreground">
            {tLive("measuredNote", {
              prompts: data.totals.prompts,
              promptRuns: data.totals.promptRuns,
              iterations: data.totals.iterations,
            })}
          </p>
        </>
      )}
    </div>
    </InfoTooltipProvider>
  );
}

// 지표 정의 아이콘 — citations-view ColInfo 와 동일 패턴(공유 라벨 dashboard.kpi).
function MetricInfo({
  title,
  definition,
  formula,
}: {
  title: string;
  definition: string;
  formula: string;
}) {
  const t = useTranslations("dashboard.kpi");
  return (
    <InfoTooltip>
      <InfoTooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("infoAriaLabel")}
          className="shrink-0 rounded-sm text-muted-foreground normal-case hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </InfoTooltipTrigger>
      <InfoTooltipContent className="max-w-72 space-y-3 p-3.5 text-left text-pretty normal-case">
        <p className="text-xs font-semibold text-background">{title}</p>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
            {t("definitionLabel")}
          </p>
          <p className="text-[11px] leading-relaxed text-background/90">{definition}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
            {t("formulaLabel")}
          </p>
          <p className="text-[11px] leading-relaxed text-background/90">{formula}</p>
        </div>
      </InfoTooltipContent>
    </InfoTooltip>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  info,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  info?: { title: string; definition: string; formula: string };
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {info ? (
          <span className="ml-auto">
            <MetricInfo {...info} />
          </span>
        ) : null}
      </div>
      <span className="font-head text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}
