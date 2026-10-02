"use client";

// 탭 히어로 — 좌측 스칼라 + 우측 추이.
//
// 좌측 스칼라는 **스냅샷**(Sub KPI)에서, 우측 추이는 **회차 집계**에서 온다.
// 마지막 버킷이 재측정 중이면 반토막일 수 있어 스칼라로 쓰지 않는다(집계 jsdoc).
// 노출률은 반원 게이지, 점유율은 큰 숫자 + 경쟁사 미니 카드 — 디자인 차이지만
// 값의 출처와 Δ 규약은 동일하다.

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { KpiHeroValue, KpiMetric } from "../../_data/kpi-view";
import { pctText } from "./kpi-bits";
import { KpiGauge } from "./kpi-gauge";

// 2026-09-02 — 우측 추이와 경쟁사 미니 카드는 **슬롯**이다.
//
// 이 카드의 좌측 스칼라는 스냅샷(Sub KPI, 프로덕션 실측 ~1s)에서 오는데, 우측
// 추이는 엔진/브랜드 추이 집계(7~11s)에서 온다. 한 컴포넌트가 둘을 다 prop 으로
// 받으면 **호출부가 둘 다 await 한 뒤에야** 카드를 그릴 수 있어, 빠른 스칼라가
// 느린 추이에 인질로 잡힌다. 슬롯으로 받으면 호출부가 각 슬롯을 자기 <Suspense>
// 경계로 감싸 준비되는 대로 채워 넣는다(값 파생은 mention-kpi-tab.tsx 가 소유).
export function KpiHero({
  metric,
  hero,
  deltaSlot,
  trendSlot,
  competitorsSlot,
}: {
  metric: KpiMetric;
  hero: KpiHeroValue;
  /**
   * 직전 측정일 스냅샷 대비 Δ(pp) 배지. **다른 집계**(sub-kpis-prev)에서 오므로
   * 슬롯이다 — 스칼라가 이것을 기다리면 게이지가 늦어진다.
   */
  deltaSlot: ReactNode;
  /** 우측 추이 지면 — 단일 라인 / 다중 브랜드 라인 / degrade 문구 중 하나. */
  trendSlot: ReactNode;
  /** 점유율 히어로의 경쟁사 미니 카드 (노출률 탭에서는 안 쓴다). */
  competitorsSlot?: ReactNode;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const label = t(`metric.${metric}`);
  return (
    // 피그마 327:116/327:550 히어로 실측: 바깥 p-5·gap-3, 좌열 267px, 스칼라 카드 p-5·최소 123px,
    // 라벨 14px medium, 값 34px semibold. 우측 추이는 ChartBox(테두리 박스)가 자기 프레임을 가진다.
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 lg:flex-row lg:items-stretch">
      <div className="flex shrink-0 flex-col gap-3 lg:w-[267px]">
        {metric === "exposure" ? (
          // QA 2차 #6 — 좌측 게이지 카드와 우측 추이(ChartBox)의 top·bottom 을 맞춘다.
          //
          // 근거(높이가 같아지는 이유): 이 열과 trendSlot 은 **같은 flex 행의 두 아이템**
          // 이고 행이 `lg:items-stretch` 라 두 열의 높이는 정의상 같다(= 더 큰 쪽).
          // 종전에는 카드에 `h-full`(부모 높이의 100%)을 걸었는데, 부모의 높이가
          // stretch 로 정해지는 auto 라 브라우저에 따라 auto 로 되돌아갔다 → 안 맞았다.
          // 이제 카드를 `flex-1` 로 **열 안에서 늘려** 열 높이를 그대로 차지한다
          // (열 높이 = 행 높이 = ChartBox 높이). 내용은 계속 중앙 정렬.
          <div className="flex min-h-[123px] flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-border p-5">
            <KpiGauge pct={hero.pct} label={label} valueText={pctText(hero.pct)} />
            {deltaSlot}
          </div>
        ) : (
          <>
            <div className="flex min-h-[123px] flex-1 flex-col justify-center gap-1.5 rounded-lg border border-border p-5">
              <div className="text-sm font-medium text-muted-foreground">{label}</div>
              <div className="flex items-baseline gap-2">
                <span className="text-[34px] leading-none font-semibold tracking-tight tabular-nums">
                  {pctText(hero.pct)}
                </span>
                {deltaSlot}
              </div>
            </div>
            {competitorsSlot}
          </>
        )}
      </div>
      {trendSlot}
    </div>
  );
}
