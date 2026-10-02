"use client";

// 반원 게이지 — 노출률 히어로. 순수 SVG(라이브러리 없음)라 SSR 결과가 결정적이고
// 하이드레이션 불일치가 없다. 값이 null 이면 트랙만 그리고 채우지 않는다
// ("측정 없음"과 0% 는 다른 상태 — 게이지가 0 으로 위장하지 않는다).

// 피그마 327:116 히어로 게이지 실측: 186×104, 굵기 22 → R=82.
const R = 82;
const STROKE = 22;
const W = 2 * R + STROKE; // 186
const H = R + STROKE; // 104
const ARC_LEN = Math.PI * R;

// 좌(180°) → 우(0°) 반원. 시작·끝 y 를 같게 두어 바닥이 수평이다.
const ARC_PATH = `M ${STROKE / 2} ${H - STROKE / 2} A ${R} ${R} 0 0 1 ${W - STROKE / 2} ${H - STROKE / 2}`;

export function KpiGauge({
  pct,
  label,
  valueText,
}: {
  pct: number | null;
  label: string;
  valueText: string;
}) {
  const clamped = pct == null ? null : Math.max(0, Math.min(100, pct));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[104px] w-[186px]"
        role="img"
        aria-label={`${label} ${valueText}`}
      >
        <path
          d={ARC_PATH}
          fill="none"
          stroke="var(--color-ink-100)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        {clamped == null ? null : (
          <path
            d={ARC_PATH}
            fill="none"
            stroke="var(--color-brand-700)"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${(ARC_LEN * clamped) / 100} ${ARC_LEN}`}
          />
        )}
      </svg>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="text-[34px] leading-none font-semibold tracking-tight text-foreground tabular-nums">
        {valueText}
      </span>
    </div>
  );
}
