"use client";

// 기간 비교 Δ **한 줄** — 라벨 + 지표별 칩 + 캡션.
//
// 카드·타일의 슬롯(`PeriodDeltaSlot`)이 "지표 하나 옆의 칩"이라면, 이 줄은 **여러 지표를
// 한 번에** 보여 주는 지면용이다(달력 월 "전월 대비" 줄이 그 형태다).
//
// ── `feat/mom-delta` 의 `mom-delta-line.tsx` 를 대체한다 ────────────────────
// 그 컴포넌트는 `lib/kpi/mom-view.ts` 의 MoM 전용 view model 을 받았는데, 통합된
// 설계는 달력 월도 **같은 읽기·같은 결과 타입**(`CompareResult[]` · `kind:"calendarMonth"`)
// 을 쓴다(design §13-3 B "읽기 계층은 하나, 정책 계층은 둘"). 그래서 view model 도 하나면
// 충분하고, `momDelta.*` 사전은 `periodCompare.*` 로 흡수됐다.
// 원본이 쓰던 `components/kpi-card.tsx::DeltaChip` 은 앱 import 0건인 사코드라
// (design §13-3(C)) 이 change 의 공용 프리미티브를 쓴다.

import { useTranslations } from "next-intl";
import type { PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import { cn } from "@/lib/utils";
import { PeriodDeltaCaption, PeriodDeltaChip } from "./delta-chip";

export function PeriodDeltaLine({
  view,
  className,
}: {
  /** `null` = 줄 자체가 없다(스위치 off · 기간 미선택 · 적용일 이전). */
  view: PeriodDeltaView | null;
  className?: string;
}) {
  const t = useTranslations("periodCompare");
  if (!view || view.chips.length === 0) return null;
  return (
    <p
      className={cn(
        "-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
      data-period-delta-line={view.caption.key.replace(/^reason\./, "")}
    >
      {view.presetKey ? (
        <span className="font-medium text-foreground">{t(`label.${view.presetKey}`)}</span>
      ) : null}
      {view.chips.map((chip) => (
        <span key={chip.key} className="inline-flex items-center gap-1">
          <span>{t(`metric.${chip.key}`)}</span>
          <PeriodDeltaChip chip={chip} />
        </span>
      ))}
      {/* 정상 상태의 회차 문구도 여기서는 유용하다 — 줄 하나뿐이라 소음이 아니다. */}
      <PeriodDeltaCaption caption={view.caption} reasonOnly={false} />
    </p>
  );
}
