"use client";

// 차트 공통 프레임(피그마 1:1, 2026-09-02) — 모든 추이 차트는 테두리 박스(rounded-lg
// border p-3) 안에 그리고, 회차마다 교차 음영 세로 밴드를 깐다(피그마 327:116 우측
// 추이의 회색 밴드). recharts 는 Tailwind 를 못 읽으므로 밴드 색은 CSS 변수 문자열.
//
// 밴드는 CartesianGrid 의 `verticalFill` 로 그린다 — 세로 그리드선 사이를 배열 색으로
// 번갈아 채우는 recharts 고유 기능. ReferenceArea 를 회차마다 그리는 것보다 가볍고,
// 카테고리 축(bucketStart)에서도 정확히 한 회차 폭이다.

import type { ReactNode } from "react";
import { CartesianGrid } from "recharts";
import { cn } from "@/lib/utils";

export function ChartBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3", className)}>
      {children}
    </div>
  );
}

/** 교차 음영 밴드 그리드 — 가로선은 점선, 세로 밴드는 bg-soft/투명 교차. */
export function BandedGrid() {
  // 프리뷰 실측(2026-09-02 dpl_BbtAFfpk): `vertical={false}` 면 recharts 가 세로 스트라이프
  // (verticalFill)도 건너뛴다 → 밴드가 안 그려졌다. 그리드를 두 겹으로 — ① 가로 점선만,
  // ② 세로선은 투명하게 두고 교차 채움만.
  return (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-ink-100)" vertical={false} />
      <CartesianGrid
        horizontal={false}
        vertical
        stroke="transparent"
        verticalFill={["var(--color-bg-soft)", "transparent"]}
        fillOpacity={0.9}
      />
    </>
  );
}

/** Y 축 도메인 — 피그마는 데이터 범위에 맞춰 눈금을 잡는다(0~100 고정 아님). */
export const AUTO_PCT_DOMAIN: [number, string] = [0, "auto"];

/**
 * recharts `<Bar radius>` — **양쪽 끝 완전 반원**(2026-09-09 QA 2차 #1).
 *
 * 네 모서리에 큰 값을 주면 recharts 가 `Math.min(|width|, |height|) / 2` 로 클램프하므로
 * (`Rectangle.getRectanglePath`), 막대 두께의 정확히 절반 = 반원이 된다. 두께를 모르는
 * 반응형 차트에서 고정 px 를 쓰지 않는 이유다.
 */
export const PILL_BAR_RADIUS: [number, number, number, number] = [999, 999, 999, 999];
