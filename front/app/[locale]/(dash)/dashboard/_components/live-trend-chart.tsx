"use client";

import { useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceArea,
} from "recharts";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { promptChangeMarkerLines } from "@/components/standards/prompt-change-markers";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { planTrendGaps, type TrendGap } from "@/lib/viz/trend-gap";
import { mixedTrendGapFamily } from "../_data/trend-kpi-family";
import type { PromptAuditDailyCount } from "@/lib/db/repositories/prompt-audit-logs";
import type { TrendKpiKey } from "../_data/live-types";
import type { TrendChartView } from "../_data/screen-types";

// 라이브 추이 — 미러에 쌓인 measured_at 을 주/일 버킷으로 normalize 한 KPI 시계열.
// 샘플용 TrendChart 와 달리 (1) 가짜 scale 없음 (2) connectNulls=false 로 측정
// 없는 버킷에서 선이 끊긴다 (보간 금지 원칙) (3) 단위가 다른 KPI(% vs 순위)는
// 좌/우 분리축으로 그린다. 버킷별 "측정 커버리지" 범례는 2026-09-03 고객 요청으로
// 제거 — 회차가 앵커로 접힌 뒤로는 주 = 회차라 측정일수 배지가 정보가 아니라 노이즈였다.
// 표준/웹사이트는 ①~⑤만, 프로젝트는 ⑥까지 시계열이 있을 수 있다. ⑦은 제외.
// axis: 퍼센트 KPI 5종은 왼쪽(pct), 평균순위(rank)는 오른쪽 축. 순위 축은
// reversed(위 = 1위 = 좋음) + 대시 라인 — 역방향 지표가 % 지표와 같은 시각
// 문법으로 읽히게 (2026-08-06 고객 피드백).
type AxisId = "pct" | "rank";
const TREND_SERIES: { key: TrendKpiKey; color: string; axis: AxisId }[] = [
  { key: "visibility", color: "#002c5f", axis: "pct" },
  { key: "shareOfVoice", color: "#e63312", axis: "pct" },
  { key: "sentiment", color: "#00aad2", axis: "pct" },
  { key: "citationShare", color: "#6b89b3", axis: "pct" },
  { key: "citationAccuracy", color: "#1a4d8e", axis: "pct" },
  { key: "position", color: "#a36b4f", axis: "rank" },
];

const DEFAULT_VISIBLE: TrendKpiKey[] = ["visibility", "shareOfVoice"];

// `gap` = 수집 오류 회차 마커(lib/viz/trend-gap.ts). 붙어 있으면 그 슬롯의 KPI 값은
// 전부 비어 있고, 화면은 값 대신 음영 + 안내 문구를 낸다.
type Row = {
  label: string;
  measuredDays: number;
  answers: number;
  gap?: TrendGap;
} & Partial<Record<TrendKpiKey, number>>;

// X축 라벨 — 화면이 보낸 행 날짜(YYYY-MM-DD, website/trend)를 M/D 로 찍는다.
// timeZone 은 UTC 로 고정한다 (hydration 결정론 — React #418 수정, 2026-07-22):
// `new Date("YYYY-MM-DD")` 는 UTC 자정이라 timeZone 미지정 시 서버(UTC)가 만든 SSR 텍스트와
// 브라우저(뷰어 TZ)의 hydration 렌더가 하루 어긋날 수 있다.
export function trendBucketLabelFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
}

// 툴팁 값 포맷 — % 축 KPI 는 단위를 붙이고(2026-09-03 고객 요청), 순위 축은 그대로.
const SERIES_AXIS: Record<string, AxisId> = Object.fromEntries(
  TREND_SERIES.map((s) => [s.key, s.axis]),
);
export function formatTrendTooltipValue(
  value: unknown,
  dataKey: unknown,
): string {
  if (typeof value !== "number") return String(value ?? "");
  return SERIES_AXIS[String(dataKey)] === "pct" ? `${value}%` : String(value);
}

/** One chart slot as the screen sends it: the x label, the values and the gap marker per gap family. */
export interface TrendChartPoint {
  label: string;
  measuredDays: number;
  answers: number;
  values: Partial<Record<TrendKpiKey, number>>;
  gap: { mention: TrendGap | null; citation: TrendGap | null };
}

/**
 * The KPI trend chart of the website overview: rows and series from website/trend
 * (back/bff/screens/overview.py trend_chart_view); the x label is the row's date, formatted here.
 */
export function LiveTrendChartView({
  view,
  promptChanges,
}: {
  view: TrendChartView;
  promptChanges?: PromptAuditDailyCount[];
}) {
  const locale = useLocale();
  const fmt = useMemo(() => trendBucketLabelFormatter(locale), [locale]);
  const points = useMemo<TrendChartPoint[]>(
    () => view.rows.map((r) => ({ label: fmt.format(new Date(r.day)), measuredDays: r.measuredDays, answers: r.answers, values: r.values, gap: r.gap })),
    [view.rows, fmt],
  );
  return <TrendChartBody points={points} seriesKeys={view.availableSeries} promptChanges={promptChanges} />;
}

function TrendChartBody({
  points,
  seriesKeys,
  promptChanges,
}: {
  points: TrendChartPoint[];
  /** The series that have a value somewhere (TREND_SERIES order). */
  seriesKeys: readonly TrendKpiKey[];
  promptChanges?: PromptAuditDailyCount[];
}) {
  const tKpi = useTranslations("dashboard.kpi.name");
  const t = useTranslations("dashboard.trend");
  const tAudit = useTranslations("promptAudit");
  const locale = useLocale();
  const [visible, setVisible] = useState<Set<TrendKpiKey>>(
    new Set(DEFAULT_VISIBLE),
  );

  const fmt = useMemo(() => trendBucketLabelFormatter(locale), [locale]);

  // 이 플롯이 지금 말하는 **계열**(0071) — 그리는 시리즈(사용자 토글)가 전부 인용 계열일 때만 인용.
  // 음영(`ReferenceArea`)은 플롯 전체 높이를 덮으므로, 언급 라인이 관통하는 슬롯을 덮으면 안 된다.
  const gapFamily = useMemo(() => mixedTrendGapFamily(visible), [visible]);

  const rows = useMemo<Row[]>(
    () =>
      points.map((p) => ({
        label: p.label,
        measuredDays: p.measuredDays,
        answers: p.answers,
        ...p.values,
        // 그 계열이 읽는 마커만 행에 싣는다 — 툴팁(`GapAwareTooltip`)은 행을 읽는다.
        ...(p.gap[gapFamily] ? { gap: p.gap[gapFamily]! } : {}),
      })),
    [points, gapFamily],
  );
  // 수집 오류 회차 — 음영 슬롯 + 이웃 연결용 보조 라인. 숨겨진 시리즈는 아래 styleOf 가 걸러낸다.
  const gapPlan = useMemo(
    () =>
      planTrendGaps(rows, {
        xKey: "label",
        seriesKeys: TREND_SERIES.map((s) => s.key),
        family: gapFamily,
      }),
    [rows, gapFamily],
  );

  const availableSeries = useMemo(
    () => TREND_SERIES.filter((series) => seriesKeys.includes(series.key)),
    [seriesKeys],
  );

  // 프롬프트 변경 마커 — rows와 같은 fmt로 day→label을 만들어 X축 카테고리에
  // 존재하는 날만 그린다(주 단위 뷰에서는 자연히 스킵). 클릭 → 이력 탭.
  const markerLines = useMemo(() => {
    if (!promptChanges || promptChanges.length === 0) return null;
    return promptChangeMarkerLines({
      markers: promptChanges,
      labelForDay: (day) => fmt.format(new Date(day + "T00:00:00Z")),
      markerLabel: (count) => tAudit("marker", { count }),
      axisLabels: new Set(rows.map((r) => r.label)),
      yAxisId: "pct",
      historyHref: `/${locale}/standard/prompts?tab=history`,
    });
  }, [promptChanges, fmt, rows, tAudit, locale]);

  // 보이는 라인이 실제로 쓰는 축만 렌더 (안 쓰는 축이 빈 눈금으로 남지 않게).
  const showPct = availableSeries.some((s) => s.axis === "pct" && visible.has(s.key));
  const showRank = visible.has("position");

  function toggle(k: TrendKpiKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size > 1) next.delete(k); // 최소 1개 유지
      } else {
        next.add(k);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("selector")}
        </span>
        {availableSeries.map((s) => {
          const on = visible.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                on
                  ? "border-transparent text-white"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
              style={on ? { backgroundColor: s.color } : undefined}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {tKpi(s.key)}
            </button>
          );
        })}
      </div>

      <div className="h-72 min-w-0 rounded-lg border border-border bg-card p-4">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 640, height: 288 }}
        >
          {/* 좌우 여백 (2026-09-04 고객 리포트 "추이 그래프가 잘려서 보인다").
              종전 left/right = -8 은 플롯을 컨테이너 밖으로 밀어 두 가지를 잘랐다 —
              헤들리스 크롬 실측(recharts 3.8.1 동일 설정 A/B):
                · 세로 축 라벨 "%" 가 1~2px 조각으로 남았다.
                · **마지막 버킷의 데이터 포인트(dot)가 통째로 사라졌다** — 선만
                  오른쪽 끝으로 흘러가 "측정이 없는 것처럼" 보인다.
              right 0 은 dot 이 절반만 잘려 여전히 부족했고, right 12 에서 라벨·dot
              이 모두 온전해진다. left 4 는 축 라벨 "%" 의 여백. */}
          <LineChart data={gapPlan.rows} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            {/* 왼쪽 축 — 퍼센트 KPI (0~100). 항상 존재하되 보이는 % 라인이 있을
                때만 눈금 표시 (recharts 는 참조되지 않는 축은 그리지 않음). */}
            <YAxis
              yAxisId="pct"
              hide={!showPct}
              tick={{ fontSize: 11 }}
              stroke="rgba(0,0,0,0.4)"
              unit="%"
              label={{
                value: t("axis.percent"),
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 10, fill: "rgba(0,0,0,0.45)" },
              }}
            />
            {/* 오른쪽 축 — 평균 순위 (점유율과 단위가 달라 분리).
                reversed(2026-08-06 고객 피드백): 순위는 낮을수록 좋음 — 축을
                뒤집어 "위 = 좋음"이 % 지표들과 일치하게 한다. 축 라벨에도
                방향성을 명시. */}
            <YAxis
              yAxisId="rank"
              orientation="right"
              hide={!showRank}
              reversed
              tick={{ fontSize: 11 }}
              stroke="rgba(0,0,0,0.4)"
              label={{
                value: t("axis.rankDirectional"),
                angle: 90,
                position: "insideRight",
                style: { fontSize: 10, fill: "rgba(0,0,0,0.45)" },
              }}
            />
            {/* 주(버킷) 단위 교대 배경 — 흰색/회색 면으로 구간을 구분. 짝수 버킷
                슬롯에만 옅은 회색 밴드(나머지는 카드 흰 배경). 라인보다 먼저
                선언해 뒤에 깔린다. 마지막 버킷은 x2 생략 → 축 끝까지 채움. */}
            {rows.map((r, i) =>
              i % 2 === 0 ? (
                <ReferenceArea
                  key={`band-${r.label}`}
                  yAxisId="pct"
                  x1={r.label}
                  x2={rows[i + 1]?.label}
                  fill="rgba(0,0,0,0.04)"
                  fillOpacity={1}
                  stroke="none"
                  ifOverflow="extendDomain"
                />
              ) : null,
            )}
            {/* 수집 오류 회차 음영 — 교대 배경 위, 라인 아래. */}
            {trendGapAreas(gapPlan.areas, { yAxisId: "pct" })}
            {markerLines}
            {/* filterNull={false} — 전 KPI 가 null 인 갭 슬롯에서도 payload 가 살아 있어야
                content 가 갭 마커를 본다(사유는 GapAwareTooltip 주석). */}
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              itemSorter={(item) => -Number(item.value ?? 0)}
              wrapperStyle={{ zIndex: 50 }}
              filterNull={false}
              formatter={(value, _name, item) => formatTrendTooltipValue(value, item.dataKey)}
              content={<GapAwareTooltip />}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {availableSeries.filter((s) => visible.has(s.key)).map((s) => (
              <Line
                key={s.key}
                yAxisId={s.axis}
                type="monotone"
                dataKey={s.key}
                name={tKpi(s.key)}
                stroke={s.color}
                strokeWidth={2}
                // rank 축 시리즈는 대시로 구분 — 좌(%)/우(순위) 축이 다른 지표임을
                // 색 외의 부호로도 표시 (2026-08-06 고객 피드백).
                strokeDasharray={s.axis === "rank" ? "5 3" : undefined}
                dot={{ r: 2 }}
                // 보간 금지: 측정 없는 버킷은 선이 끊겨 그대로 보인다.
                connectNulls={false}
              />
            ))}
            {/* 이웃 잇기 — 갭 슬롯 양옆 값만 실은 보조 라인(갭 칸에 값을 만들지 않는다). */}
            {trendGapBridgeLines(gapPlan.bridges, (key) => {
              const s = availableSeries.find((x) => x.key === key);
              if (!s || !visible.has(s.key)) return null;
              return {
                stroke: s.color,
                strokeWidth: 2,
                strokeDasharray: s.axis === "rank" ? "5 3" : undefined,
                yAxisId: s.axis,
              };
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
