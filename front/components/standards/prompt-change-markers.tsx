"use client";

import { useRouter } from "next/navigation";
import { ReferenceLine } from "recharts";
import type { PromptAuditDailyCount } from "@/lib/db/repositories/prompt-audit-logs";

// 추이 차트의 프롬프트 변경 마커 (catalog-prompt-audit). LiveTrendChart의
// X축은 Date가 아니라 미리 포맷한 label 문자열(카테고리 축)이다 — 마커는 부모
// 차트와 같은 포맷터로 day → label을 만들어 카테고리가 일치하는 날에만 그려진다.
// 축에 없는 날짜(측정 없는 날·주 단위 뷰)는 조용히 스킵된다(v1은 일 단위 대상).
//
// recharts 제약 2가지:
// - LineChart의 children이어야 하므로 컴포넌트가 아니라 element 배열을 반환한다.
// - 이 차트의 YAxis는 id("pct"/"rank")가 있어 ReferenceLine에 yAxisId 지정 필수.

export interface PromptChangeMarkerOptions {
  markers: PromptAuditDailyCount[];
  labelForDay: (day: string) => string; // 부모 차트의 fmt와 동일해야 함
  markerLabel: (count: number) => string;
  axisLabels: Set<string>; // 실제 X축에 존재하는 label들
  yAxisId: string;
  // 클릭 시 이동할 경로 (예: /ko/standard/prompts?tab=history). useRouter는
  // 이 라벨 컴포넌트 안에서만 호출한다 — 부모 차트가 라우터 없는 환경(SSR
  // 결정론 테스트 등)에서 마커 없이 렌더될 수 있기 때문.
  historyHref?: string;
}

function MarkerLabel(props: {
  viewBox?: { x?: number; y?: number };
  value: string;
  historyHref?: string;
}) {
  const router = useRouter();
  const x = props.viewBox?.x ?? 0;
  const y = props.viewBox?.y ?? 0;
  const href = props.historyHref;
  return (
    <text
      x={x}
      y={y + 10}
      dx={4}
      fontSize={10}
      fill="rgba(0,44,95,0.7)"
      style={href ? { cursor: "pointer" } : undefined}
      onClick={href ? () => router.push(href) : undefined}
    >
      {props.value}
    </text>
  );
}

export function promptChangeMarkerLines(opts: PromptChangeMarkerOptions) {
  return opts.markers
    .map((m) => ({ m, label: opts.labelForDay(m.day) }))
    .filter(({ label }) => opts.axisLabels.has(label))
    .map(({ m, label }) => (
      <ReferenceLine
        key={"pcm-" + m.day}
        x={label}
        yAxisId={opts.yAxisId}
        stroke="rgba(0,44,95,0.35)"
        strokeDasharray="4 4"
        label={
          <MarkerLabel value={opts.markerLabel(m.total)} historyHref={opts.historyHref} />
        }
      />
    ));
}
