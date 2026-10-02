"use client";

// 멘션 유형별 노출/점유율 — 좌측 유형 5종 스택바(자사만 ↔ 타사 포함 토글),
// 우측 콤보 차트(막대 = 모니터링 답변 수, 선 = **유형 5종의 노출률 추이**).
//
// 타사 포함 = **100% 구성비 스택**(디자인 327:369 의 `당사 · BMW · 기타`).
// 비교 세그먼트의 브랜드는 상단 "경쟁사 선택" 드롭다운이 정한다. 세그먼트 합이
// 100% 인 것이 이 막대의 계약이며, 계산은 `typeKpiBars` 가 정본이다.
//
// ⚠️ 두 가지 제약을 화면이 지켜야 한다(집계 jsdoc):
//   1. `ownMentions`/`totalMentions` 는 **유형 5종 신호의 합**이지 총 언급 수가
//      아니다 — 한 언급이 유형 신호를 여럿 가지면 중복 계상된다. "언급 수" 라벨 금지.
//   2. 우측 선 5개는 **유형별 노출률**(그 유형 신호가 있는 당사 노출 답변 ÷ 답변)
//      추이다(2026-09-09 QA 2차 #9). 측정 없는 회차는 null → 선이 끊긴다(보간 금지).

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  Bar,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { planTrendGaps, TREND_GAP_FIELD, type TrendGapRow } from "@/lib/viz/trend-gap";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { cn } from "@/lib/utils";
import { ColInfo } from "@/components/dash/col-info";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MENTION_TYPE_KEYS_UI, type KpiMetric, type TypeComboPoint, type TypeKpiBar, type TypeScope } from "../../_data/kpi-view";
import { pctText } from "./kpi-bits";
import { bucketMD, CoverageLabel } from "./kpi-trend-chart";
import { AUTO_PCT_DOMAIN, BandedGrid, ChartBox, PILL_BAR_RADIUS } from "./chart-box";
import { seriesColor } from "./series-colors";

const ALL_COMPETITORS = "__all__";

export function TypeKpiSection({
  metric,
  barsFor,
  trendSlot,
  initialScope = "own",
  competitor = null,
  competitors,
  onPickCompetitor,
  total = null,
  initialCounts = false,
}: {
  metric: KpiMetric;
  /**
   * 첫 행 "전체" — 히어로와 같은 값(노출률 = 전체 노출률, 점유율 = 당사 총 점유율).
   * 피그마 327:369 의 굵은 첫 행. null 이면 행을 그리지 않는다.
   */
  total?: { pct: number | null; ownSignals: number | null } | null;
  /** 렌더 테스트 seam — 건수 모드 초기값(화면 기본은 비율). */
  initialCounts?: boolean;
  /** scope 토글이 분모를 바꾸므로 계산을 호출부 순수 함수에 위임한다. */
  barsFor: (scope: TypeScope) => TypeKpiBar[];
  /**
   * 우측 콤보 차트 지면 — **슬롯**이다(2026-09-02). 좌측 유형 바는 유형 집계
   * (실측 ~4s)에서 오는데 우측 콤보는 엔진 추이 집계(~11s)에서 온다. 한 컴포넌트가
   * 둘 다 prop 으로 받으면 좌측이 우측을 기다린다 — 호출부가 각자 <Suspense>
   * 경계를 씌운다. 내용물의 정본은 아래 `TypeKpiTrend`.
   */
  trendSlot: ReactNode;
  /**
   * 초기 토글 값. 기본은 "자사만"이고 사용자가 바꾼다 — **테스트가 parallel
   * 분기를 밟기 위한 seam** 이기도 하다(재검증 C7: renderToStaticMarkup 은
   * useState 를 뒤집을 수 없어 노출률×타사 포함이 한 번도 렌더되지 않았다).
   */
  initialScope?: TypeScope;
  /**
   * 비교 세그먼트로 뺄 경쟁사(상단 드롭다운 값). null = 전체 → 당사/기타 2분할.
   * 값 자체는 `barsFor` 가 이미 반영해 넘기고, 여기서는 **라벨**에만 쓴다.
   */
  competitor?: string | null;
  /**
   * 추적 경쟁사 목록(QA #1) — 있으면 "타사 포함" 모드일 때 헤더에 경쟁사 선택
   * 드롭다운을 보여준다. 선택 상태는 `mention-kpi-tab.tsx` 가 들고 있되 **이
   * 섹션 전용**이다 — 2026-09-10 QA 2차 #6 에서 경쟁사 표와의 공유를 끊었다
   * (고객: "각각 경쟁사 선택을 할 수 있는 구조로 따로 작동해야함").
   */
  competitors?: string[];
  /** 드롭다운 선택 콜백. 없으면(또는 competitors 가 비면) 드롭다운을 그리지 않는다. */
  onPickCompetitor?: (brand: string | null) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const [scope, setScope] = useState<TypeScope>(initialScope);
  const [counts, setCounts] = useState(initialCounts);
  const bars = barsFor(scope);
  const stacked = scope === "all";
  const countText = (n: number | null) => (n == null ? "—" : t("type.signals", { n }));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="inline-flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-foreground">
            {t(`type.title.${metric}`)}
            {/* 신호 합·구성비·콤보 각주는 본문이 아니라 ⓘ(제품 결정: 오독 방지용만 본문, 나머지 ⓘ). */}
            <span data-type-note title={stacked ? `${t("type.signalNote")} ${t("type.stackNote")}` : t("type.signalNote")}>
              <ColInfo
                title={t("type.noteTitle")}
                definition={`${t("type.signalNote")} ${stacked ? t("type.stackNote") : ""}`}
                formula={t("type.comboNote")}
              />
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{t(`type.hint.${metric}`)}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* QA #1 — 타사 포함 모드에서 경쟁사를 여기서 바로 고른다(경쟁사 표
              드롭다운과 같은 state 를 공유 — mention-kpi-tab.tsx 의 competitor). */}
          {stacked && onPickCompetitor && competitors && competitors.length > 0 ? (
            <Select
              value={competitor ?? ALL_COMPETITORS}
              onValueChange={(v) => onPickCompetitor(v === ALL_COMPETITORS ? null : v)}
            >
              <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
                <SelectValue placeholder={t("type.competitorAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_COMPETITORS}>{t("type.competitorAll")}</SelectItem>
                {competitors.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            <ScopeButton active={scope === "own"} onClick={() => setScope("own")}>
              {t("type.ownOnly")}
            </ScopeButton>
            <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
              {t("type.withOthers")}
            </ScopeButton>
          </div>
        </div>
      </header>

      {bars.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("type.empty")}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-[11px] text-muted-foreground">
              {t(`type.denominator.${scope}.${metric}`)}
            </p>
            <ul className="flex flex-col gap-2">
              {total ? (
                <li className="flex items-start gap-2 text-xs font-semibold">
                  <span className="w-16 shrink-0 truncate pt-0.5 text-foreground">{t("type.total")}</span>
                  <span className="flex flex-1 flex-col gap-1">
                    {/* 전체 행 트랙은 유형 행(rounded-full bg-muted)과 클래스가 다르다 — 렌더 테스트가
                        유형 5행을 그 클래스로 세기 때문. */}
                    <span className="flex h-3 overflow-hidden rounded-full bg-bg-subtle" data-type-total-track>
                      <span className="h-full rounded-full bg-brand-700" style={{ width: `${clamp(total.pct)}%` }} />
                    </span>
                  </span>
                  <span className="w-28 shrink-0 pt-0.5 text-right tabular-nums">
                    {counts ? countText(total.ownSignals) : t("type.ownValue", { pct: pctText(total.pct) })}
                  </span>
                </li>
              ) : null}
              {bars.map((b) => (
                <li key={b.type} className="flex items-start gap-2 text-xs">
                  <span className="w-16 shrink-0 truncate pt-0.5 text-foreground">
                    {tType(b.type)}
                  </span>
                  <span className="flex flex-1 flex-col gap-1">
                    {/* 한 트랙 = 100%. 세그먼트는 당사 · (선택 경쟁사) · 기타 —
                        분모가 그 유형의 전 브랜드 신호 합이라 잘릴 일이 없다. */}
                    <span className="flex h-3 overflow-hidden rounded-full bg-muted">
                      <span
                        className="h-full bg-brand-700"
                        style={{ width: `${clamp(b.ownPct)}%` }}
                      />
                      {b.competitorPct != null ? (
                        <span
                          className="h-full bg-accent-gold"
                          style={{ width: `${clamp(b.competitorPct)}%` }}
                        />
                      ) : null}
                      {b.otherPct != null ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="h-full bg-ink-300"
                              style={{ width: `${clamp(b.otherPct)}%` }}
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("type.otherValue", { pct: pctText(b.otherPct) })}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                  </span>
                  <span className="w-28 shrink-0 pt-0.5 text-right tabular-nums">
                    {counts ? countText(b.ownSignals) : t("type.ownValue", { pct: pctText(b.ownPct) })}
                    {stacked && b.competitorPct != null && competitor ? (
                      <>
                        <br />
                        <span className="text-muted-foreground">
                          {t("type.competitorValue", {
                            brand: competitor,
                            pct: pctText(b.competitorPct),
                          })}
                        </span>
                      </>
                    ) : null}
                    {/* 기타(otherPct) 수치는 막대 위에 인라인으로 찍지 않는다 — 위 트랙의
                        기타 세그먼트에 붙인 Tooltip 이 hover 시에만 보여준다(QA #2). */}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <LegendDot className="bg-brand-700" text={t("type.own")} />
              {stacked && competitor ? (
                <LegendDot className="bg-accent-gold" text={competitor} />
              ) : null}
              {stacked ? <LegendDot className="bg-ink-300" text={t("type.other")} /> : null}
            </div>
            {/* 피그마 주석: "당사 유형별 언급 건수 보기" 토글 — 비율 ↔ 유형 신호 건수. */}
            <button
              type="button"
              onClick={() => setCounts((v) => !v)}
              aria-pressed={counts}
              className="self-start text-xs text-foreground underline-offset-2 hover:underline"
            >
              {counts ? t("type.showPct") : t("type.showCounts")}
            </button>
          </div>

          <ChartBox className="flex-1">{trendSlot}</ChartBox>
        </div>
      )}
    </section>
  );
}

/**
 * 유형 섹션 우측 콤보 — 막대 = 모니터링 답변 수, 선 = **유형 5종 노출률 추이**.
 * 엔진 추이 집계 하나에서만 파생되므로 TypeKpiSection 과 분리돼 자기 <Suspense>
 * 경계에 산다.
 */
export function TypeKpiTrend({
  combo,
  coverage,
  trendUnavailable = false,
}: {
  combo: TypeComboPoint[];
  coverage: { bucketStart: string; measuredDays: number }[];
  /** 시계열만 실패 — 좌측 유형 바(스냅샷)는 그대로 두고 우측 콤보만 대체한다. */
  trendUnavailable?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  // 2026-09-09 QA 2차 #9(제품 결정) — 유형 칩으로 선 하나를 갈아끼우던 방식을 버리고
  // **유형 5종의 노출률 선을 동시에** 그린다. 범례 = 그 다섯. 우호도·점유율·우선
  // 노출도 선은 이 차트에서 뺐다(범례가 유형 5종이어야 한다는 요구).
  //
  // 데이터는 `combo[].byType[type]` — 없는 버킷은 null 이고 `connectNulls={false}`
  // 라 선이 끊긴다(보간 금지 — 측정 없는 회차를 이어 그리면 거짓 신호다).
  //
  // 수집 오류 회차(0070)는 값이 아니라 **음영 + 사유**로 나가야 한다 — 마커는
  // `typeComboPoints` 가 히어로 추이에서 그대로 옮겨 온다. 여기서 떨어뜨리면
  // `planTrendGaps` 가 hasGap:false 를 돌려 오버레이가 통째로 사라진다.
  const data: TrendGapRow[] = combo.map((p) => ({
    bucketStart: p.bucketStart,
    answers: p.answers,
    ...Object.fromEntries(MENTION_TYPE_KEYS_UI.map((k) => [k, p.byType[k] ?? null])),
    ...(p.gap ? { [TREND_GAP_FIELD]: p.gap } : {}),
  }));
  // 보조선은 **선 5종**만 잇는다 — 막대(answers)는 갭 칸에 막대가 없는 것이 정상이다.
  const gapPlan = planTrendGaps(data, {
    xKey: "bucketStart",
    seriesKeys: MENTION_TYPE_KEYS_UI,
  });
  return (
    <>
      {trendUnavailable ? (
        <div className="flex h-56 items-center justify-center rounded-md border border-dashed border-border px-4 text-xs text-muted-foreground">
          {t("degradedTrend")}
        </div>
      ) : (
      <div className="h-56 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 480, height: 224 }}
        >
          <ComposedChart data={gapPlan.rows} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
            <BandedGrid />
            {/* 음영은 막대·라인보다 먼저 — 뒤에 깔린다. YAxis 에 id 가 있으므로 지정 필수. */}
            {trendGapAreas(gapPlan.areas, { yAxisId: "pct" })}
            <XAxis
              dataKey="bucketStart"
              tickFormatter={bucketMD}
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
            />
            <YAxis
              yAxisId="pct"
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
              domain={AUTO_PCT_DOMAIN}
              tickFormatter={(v: number) => `${v}%`}
            />
            <YAxis
              yAxisId="count"
              orientation="right"
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
            />
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelFormatter={(v: unknown) => bucketMD(String(v))}
              wrapperStyle={{ zIndex: 50 }}
              // 갭 슬롯은 전 시리즈 null — filterNull 기본값이면 payload 가 비어
              // content 가 마커를 못 본다. 마커를 본 GapAwareTooltip 은 **아무것도
              // 안 낸다**(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘"). null
              // 걷어내기도 GapAwareTooltip 이 대신하므로 갭 아닌 칸은 종전 그대로다.
              filterNull={false}
              content={<GapAwareTooltip />}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              yAxisId="count"
              dataKey="answers"
              name={t("type.answers")}
              fill="var(--color-accent-soft)"
              radius={PILL_BAR_RADIUS}
              isAnimationActive={false}
            />
            {MENTION_TYPE_KEYS_UI.map((k, i) => (
              <Line
                key={k}
                yAxisId="pct"
                type="monotone"
                dataKey={k}
                name={tType(k)}
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={{ r: 2.5 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {/* 이웃 잇기 — 갭 칸에 값을 만들지 않는 합성 시리즈(보간 아님). */}
            {trendGapBridgeLines(gapPlan.bridges, (key) => {
              const i = MENTION_TYPE_KEYS_UI.indexOf(key as (typeof MENTION_TYPE_KEYS_UI)[number]);
              return i < 0 ? null : { stroke: seriesColor(i), strokeWidth: 2, yAxisId: "pct" };
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      )}
      {trendUnavailable ? null : <CoverageLabel entries={coverage} />}
    </>
  );
}

function clamp(v: number | null): number {
  return v == null ? 0 : Math.max(0, Math.min(100, v));
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "px-3 py-1 text-[11px] transition-colors",
        active ? "bg-brand-700 text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LegendDot({ className, text }: { className: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-2 w-2 rounded-full", className)} aria-hidden />
      {text}
    </span>
  );
}
