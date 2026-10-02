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
import { planTrendGaps, trendGapApplies, type TrendGap } from "@/lib/viz/trend-gap";
import { mixedTrendGapFamily } from "../_data/trend-kpi-family";
import {
  trendBucketDisplayDay,
  trendBucketDisplays,
  type TrendBucketDisplay,
} from "@/lib/as-of-date";
import type { PromptAuditDailyCount } from "@/lib/db/repositories/prompt-audit-logs";
import type { LiveTrend, TrendKpiKey } from "../_data/live";

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

// X축 라벨 — 실제 측정일(M/D). 주 단위는 그 주 첫 측정일(firstAt), 일 단위는 그 날.
// timeZone 은 UTC 로 고정한다 (hydration 결정론 — React #418 수정, 2026-07-22):
// firstAt 은 풀 타임스탬프(min(measured_at))라 timeZone 미지정 시 서버(UTC)가 만든
// SSR 텍스트와 브라우저(뷰어 TZ)의 hydration 렌더가 달라진다. 버킷 경계 자체가 SQL
// date_trunc(UTC) 산출이므로 UTC 표기가 데이터와도 일치한다.
export function trendBucketLabelFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
}

//
// ⚠️ **회차 버킷**(`cycleAnchorAt` 있음)은 위 규칙의 예외다 — 앵커의 **KST 달력 날짜**를
// 그린다(2026-09-28). 회차 키·`firstAt` 은 앵커의 UTC 시각이라 KST 자정 직후 앵커
// (…T15:48Z = KST 다음 날 00:48)가 하루 앞서 보였다. KST 일은 `trendBucketDisplays` 가
// 문자열(YYYY-MM-DD)로 먼저 확정하고, 여기서는 그 날의 UTC 자정을 UTC 포매터로 찍으므로
// 하이드레이션 결정론은 그대로다. 같은 KST 날에 회차가 둘이면 `display.time` 이 붙는다.
/**
 * x축 라벨.
 *
 * ⚠️ **앵커 축이면 버킷 키가 곧 라벨이다**(2026-09-20). 종전에는 주 단위에서 항상
 *    `firstAt`(그 버킷의 첫 측정 시각)을 썼는데, 축 on 에서는 버킷 키가 귀속 날짜
 *    (`round_date`/`anchor_week`)라 라벨만 다른 시계에 남았다. 실제 결함 셋:
 *      · website 추이 x축이 목·월·화가 섞인 **측정 시작일**로 찍혔다
 *      · 두 버킷의 첫 측정일이 같은 날이면 **같은 라벨이 두 번**(`7. 27.` × 2)
 *      · 마지막 점 라벨이 카드 기준일과 달랐다(09-17 vs 09-11)
 *    축 off 는 종전 그대로다 — `axis` 가 없거나 `"measured"` 면 한 글자도 안 바뀐다.
 *
 * `bucketStart` 는 `YYYY-MM-DD` 라 `new Date()` 가 **UTC 자정**으로 파싱하고
 * 포매터도 `timeZone: "UTC"` 라 날짜가 그대로 나온다(hydration 결정론도 유지).
 */
export function trendBucketLabel(
  fmt: Intl.DateTimeFormat,
  point: LiveTrend["points"][number],
  unit: LiveTrend["unit"],
  axis?: LiveTrend["axis"],
  display?: TrendBucketDisplay,
): string {
  // 축 on 주 단위 라벨은 **그 버킷의 귀속 날짜**다 — 버킷 키(주 월요일)가 아니라.
  // 글로벌은 귀속이 월요일이라 둘이 같고, website 는 금요일이라 다르다(`9. 11.`).
  // 달력에서 고르는 날짜·카드 기준일·추이 라벨이 같아야 한다는 것이 전환의 목적이다.
  if (axis === "anchor") return fmt.format(new Date(point.roundDate ?? point.bucketStart));
  // 축 off 의 회차 버킷(`cycleAnchorAt` 있음)은 앵커의 KST 달력 날짜(2026-09-28).
  if (point.cycleAnchorAt) {
    const day = display?.day ?? trendBucketDisplayDay(point);
    const md = fmt.format(new Date(`${day}T00:00:00Z`));
    return display?.time ? `${md} ${display.time}` : md;
  }
  return fmt.format(
    new Date(unit !== "week" ? point.bucketStart : (point.firstAt ?? point.bucketStart)),
  );
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

export function LiveTrendChart({
  trend,
  promptChanges,
}: {
  trend: LiveTrend;
  // 프롬프트 변경 마커 (catalog-prompt-audit) — 글로벌 카탈로그 변경의 일 단위
  // 카운트. 표준 dashboard만 전달한다(프로젝트/웹사이트 추이는 해당 없음).
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

  // 이 플롯이 지금 말하는 **계열**(0071). 혼합 차트라 시리즈 목록에서 도출한다 —
  // 음영(`ReferenceArea`)은 플롯 전체 높이를 덮으므로 "이 슬롯엔 값이 없다"는 주장이고,
  // 언급 라인이 관통하는 슬롯을 덮으면 화면이 스스로 모순된다. 그래서 그리는 시리즈가
  // **전부 인용 계열일 때만** 인용으로 본다(`mixedTrendGapFamily`).
  const gapFamily = useMemo(() => mixedTrendGapFamily(visible), [visible]);

  const rows = useMemo<Row[]>(() => {
    const displays = trendBucketDisplays(trend.points);
    return trend.points.map((p) => ({
      label: trendBucketLabel(fmt, p, trend.unit, trend.axis, displays.get(p.bucketStart)),
      measuredDays: p.measuredDays,
      answers: p.answers,
      ...p.values,
      // 계열이 안 맞는 마커는 **행에서** 잘라야 한다 — 툴팁(`GapAwareTooltip`)은
      // plan 이 아니라 행을 읽으므로, 남겨 두면 값이 있는 슬롯에서 **툴팁이 통째로
      // 사라진다**(갭 행에서는 아무것도 안 낸다 — 2026-09-11 제품 책임자).
      ...(trendGapApplies(p.gap, gapFamily) ? { gap: p.gap } : {}),
    }));
  }, [trend.points, trend.unit, trend.axis, fmt, gapFamily]);
  // 수집 오류 회차 — 음영 슬롯 + 이웃 연결용 보조 라인. 토글(visible)과 무관하게
  // 한 번만 계산하고, 숨겨진 시리즈는 아래 styleOf 가 걸러낸다.
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
    () =>
      TREND_SERIES.filter((series) =>
        trend.points.some((point) => typeof point.values[series.key] === "number"),
      ),
    [trend.points],
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
