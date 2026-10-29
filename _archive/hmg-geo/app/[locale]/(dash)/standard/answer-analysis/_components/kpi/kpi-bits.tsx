"use client";

// 4-KPI 탭이 공유하는 작은 표시 조각들. 값 없음(null)을 0 으로 위장하지 않는
// 규칙이 여러 곳에 반복되므로 한 곳에 모은다.

import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

/** null → em dash. 0 은 0 으로 표시된다(둘은 다른 상태). */
export function pctText(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

export function ppText(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}pp`;
}

/**
 * 증감 배지 — 방향 글리프 + 절대값. 방향이 좋은지 나쁜지는 지표마다 다르므로
 * (순위는 낮을수록 좋다) `invert` 로 색만 뒤집는다.
 *
 * 2026-09-02 피그마 1:1(운영 결정): 개선 = 초록(--color-positive), 악화 = danger.
 * 부호는 붙이지 않는다(글리프가 방향). `size="md"` 는 히어로용(14px), `glyph="triangle"`
 * 은 툴팁용 ▲▼ 텍스트 글리프(피그마 툴팁 표기).
 */
export function DeltaBadge({
  value,
  unit,
  invert = false,
  size = "sm",
  glyph = "icon",
  className,
}: {
  value: number | null;
  unit: "pp" | "pct";
  invert?: boolean;
  size?: "sm" | "md";
  glyph?: "icon" | "triangle";
  className?: string;
}) {
  if (value == null) return null;
  const up = value > 0;
  const good = invert ? !up : up;
  const abs = Math.abs(value);
  const text = unit === "pp" ? `${abs.toFixed(1)}pp` : `${abs.toFixed(1)}%`;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium tabular-nums",
        size === "md" ? "text-sm font-normal" : "text-xs",
        value === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-destructive",
        className,
      )}
    >
      {glyph === "triangle" ? (
        <span aria-hidden className="text-[0.8em] leading-none">{up ? "▲" : "▼"}</span>
      ) : (
        <Icon className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden />
      )}
      {text}
    </span>
  );
}

/**
 * 값 바 — 테이블 셀의 가로 막대. max 는 호출부가 고정(행마다 축이 달라지지 않게).
 *
 * 2026-09-09 QA 2차 #1(운영) — 막대는 **양끝 완전 반원**이다. 종전의 `radius="sm"`
 * (rounded-[2px]) 각진 트랙 분기는 제거했다: 화면의 모든 막대가 같은 모양이어야 한다.
 */
export function ValueBar({
  value,
  max,
  color,
  label,
  className,
}: {
  value: number | null;
  max: number;
  color: string;
  label: string;
  /** 높이·폭 등 트랙 클래스 override(기본 h-2.5 w-full min-w-16). */
  className?: string;
}) {
  const w = value == null || max <= 0 ? 0 : Math.max(0, Math.min(100, (100 * value) / max));
  return (
    <span
      className={cn("inline-flex h-2.5 w-full min-w-16 overflow-hidden rounded-full bg-muted", className)}
      role="img"
      aria-label={label}
    >
      <span className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </span>
  );
}
