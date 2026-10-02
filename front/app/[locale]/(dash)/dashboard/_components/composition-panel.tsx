"use client";

import { useTranslations } from "next-intl";
import { PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer } from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import type { LiveTopicSlice, LiveSourceSlice } from "../_data/live";

// 구성 분석 — #21 프롬프트 주제별 / #22 출처별 구성비. 둘 다 다범주 분포라
// Core 카드 칩이 아닌 미니 도넛으로 요약 노출(상세는 답변분석/인용분석 화면).
// 차트 시리즈 색상은 도넛 슬라이스용 고정 팔레트(기존 인용분석 차트와 동일 관례).
const PIE_COLORS = [
  "#002c5f", "#e63312", "#00aad2", "#a36b4f", "#6b89b3",
  "#1a4d8e", "#0d6e2f", "#fbbf24", "#f97316", "#a855f7",
];

interface Slice {
  label: string;
  value: number; // count (prompts or citations)
  share: number; // %
}

function Donut({
  title,
  unit,
  data,
  empty,
}: {
  title: string;
  unit: string;
  data: Slice[];
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {data.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <div className="h-40 w-40 shrink-0">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 160, height: 160 }}
            >
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={70}
                  paddingAngle={1}
                >
                  {data.map((d, i) => (
                    <Cell key={d.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <RTooltip
                  contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }}
                  formatter={(_value, _name, item) => {
                    const s = item?.payload as Slice | undefined;
                    return s ? [`${s.value} ${unit} · ${s.share}%`, s.label] : null;
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <dl className="flex min-w-0 flex-1 flex-col gap-1.5">
            {data.map((d, i) => (
              <div key={d.label} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <dt className="min-w-0 flex-1 truncate text-muted-foreground" title={d.label}>
                  {d.label}
                </dt>
                <dd className="shrink-0 tabular-nums text-muted-foreground">
                  {d.value} {unit}
                </dd>
                <dd className="w-10 shrink-0 text-right font-semibold tabular-nums text-foreground">
                  {d.share}%
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

export function CompositionPanel({
  topics,
  sources,
  showTopics = true,
}: {
  topics: LiveTopicSlice[];
  // 출처 도넛은 선택 — 대시보드는 둘 다, 답변분석 상세는 주제만 노출.
  sources?: LiveSourceSlice[];
  // 주제(퍼널) 도넛 표시 여부. website는 프롬프트 세트가 표준 카탈로그 밖(scope에서
  // 별도 관리)이라 funnel taxonomy가 없어 전부 '미분류'로만 나온다 → website에선
  // false로 숨기고 출처 구성비만 노출한다(2026-07-08).
  showTopics?: boolean;
}) {
  const t = useTranslations("dashboard.composition");

  const topicData: Slice[] = topics.map((s) => ({
    label: s.topic ?? t("unclassified"),
    value: s.prompts,
    share: s.share,
  }));
  const sourceData: Slice[] | null = sources
    ? sources.map((s) => ({
        label: s.domain === "" ? t("others") : s.domain,
        value: s.citations,
        share: s.share,
      }))
    : null;

  const bothShown = showTopics && !!sourceData;
  return (
    <div className={bothShown ? "grid grid-cols-1 gap-4 md:grid-cols-2" : ""}>
      {showTopics ? (
        <Donut
          title={t("topicTitle")}
          unit={t("promptsUnit")}
          data={topicData}
          empty={t("empty")}
        />
      ) : null}
      {sourceData ? (
        <Donut
          title={t("sourceTitle")}
          unit={t("citationsUnit")}
          data={sourceData}
          empty={t("empty")}
        />
      ) : null}
    </div>
  );
}
