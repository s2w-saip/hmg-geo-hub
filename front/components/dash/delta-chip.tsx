"use client";

// GGMD-107 — 증감(Δ) 칩의 **공용 프리미티브**.
//
// 왜 새로 만들었나: Δ 칩 렌더러는 6곳에 각자 있다(design §5-3 실사) —
// `overview-kpi-cards.tsx` · `summary-tiles.tsx` · `kpi/kpi-bits.tsx` ·
// `kpi/competitor-kpi-table.tsx` · `citations-standard-view.tsx` · `mentions-view.tsx`.
// 억제 상태·사유 캡션·aria 문구가 한 곳에 없으면 6개 지면이 조용히 갈린다.
// (`components/kpi-card.tsx` 의 `DeltaChip` 은 **앱이 import 하지 않는 사코드**다 —
//  design §13-3(C). 거기 고치면 화면에 아무것도 안 나온다.)
//
// ── 이 컴포넌트가 하지 않는 것 ─────────────────────────────────────────────
// 반올림·부호·단위·좋고 나쁨 판정·캡션 키 선택은 전부 순수 모듈이 끝냈다
// (`@/lib/kpi/period-compare-view`). 분기를 JSX 로 옮기면 테스트가 HTML 정규식으로
// 밀려난다.

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  SUPPRESSED_GLYPH,
  periodChipText,
  type PeriodCaptionMessage,
  type PeriodChip,
} from "@/lib/kpi/period-compare-view";

export type DeltaChipSize = "sm" | "md";
export type DeltaChipGlyph = "icon" | "triangle" | "none";
export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "positive" | "negative" | "neutral";

export interface DeltaChipProps {
  /**
   * ⚠️ **개선 방향**이다(액면 증감이 아니다). 순위처럼 작을수록 좋은 지표는 순수 계층
   * (`periodChip`)이 이미 뒤집어 놓는다. 그래서 이 값은 화살표이자 색이다.
   */
  direction: DeltaDirection;
  /** 색. 생략하면 `direction` 에서 파생한다(개선=positive). */
  tone?: DeltaTone;
  /** 부호 없는 본문(단위 포함). 정본은 `periodChipText`. */
  text: string;
  /** 억제 — 방향도 부호도 색도 없다. 중립 톤 + U+2015 하나. */
  suppressed?: boolean;
  size?: DeltaChipSize;
  glyph?: DeltaChipGlyph;
  /** 스크린리더 문구. 지정하지 않으면 aria 를 붙이지 않는다(기호가 장식으로 남는다). */
  ariaLabel?: string;
  className?: string;
}

/** 개선 방향 → 색. 두 축이 같은 값이라 파생이 정본이다(호출부가 따로 고르지 않는다). */
export function toneOfDirection(direction: DeltaDirection): DeltaTone {
  return direction === "up" ? "positive" : direction === "down" ? "negative" : "neutral";
}

/**
 * 상승 / 하락 / 변화 없음 / 억제 4상태.
 *
 * 억제와 정상이 **같은 상자**여야 한 줄 안에서 높이가 흔들리지 않는다.
 * 클래스 문자열은 여기 한 곳에만 둔다.
 */
export function DeltaChip({
  direction,
  tone,
  text,
  suppressed = false,
  size = "sm",
  glyph = "icon",
  ariaLabel,
  className,
}: DeltaChipProps) {
  const state = suppressed ? "suppressed" : direction;
  const resolvedTone = suppressed ? "neutral" : (tone ?? toneOfDirection(direction));
  const toneClass =
    resolvedTone === "positive"
      ? "text-positive"
      : resolvedTone === "negative"
        ? "text-destructive"
        : "text-muted-foreground";
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const showGlyph = !suppressed && glyph !== "none";
  return (
    <span
      data-period-delta={state}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 font-medium whitespace-nowrap tabular-nums",
        size === "md" ? "text-sm" : "text-xs",
        toneClass,
        className,
      )}
    >
      {showGlyph ? (
        glyph === "triangle" ? (
          <span aria-hidden className="text-[0.8em] leading-none">
            {direction === "up" ? "▲" : direction === "down" ? "▼" : "·"}
          </span>
        ) : (
          <Icon className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden />
        )
      ) : null}
      {suppressed ? SUPPRESSED_GLYPH : text}
    </span>
  );
}

/**
 * 순수 계층이 만든 칩 하나를 그린다. 지면은 이것만 부른다 —
 * 방향·색·자릿수·억제 글리프를 지면마다 다시 고르지 않게 하려는 것이 이 함수의 전부다.
 */
export function PeriodDeltaChip({
  chip,
  size = "sm",
  glyph = "icon",
  className,
}: {
  chip: PeriodChip;
  size?: DeltaChipSize;
  glyph?: DeltaChipGlyph;
  className?: string;
}) {
  const t = useTranslations("periodCompare");
  // 순위형(`rank`)만 단위가 **번역 대상**이다(ko `0.1번째` · en `#0.1`). `pp`·`%` 는
  // 기호라 순수 계층이 붙이지만, 이 단위는 언어마다 다르므로 여기서 메시지로 붙인다.
  //
  // ⚠️ 이 줄이 없으면 기간 비교 칩만 단위가 빠진다(2026-09-20 프리뷰 실측: 기간 미지정
  //    카드는 종전 Δ 경로라 `0.1위` 인데, 주 단위 창은 기간 비교 경로라 `0.1` 이었다).
  //    같은 화면의 같은 지표가 창에 따라 다른 표기를 갖는 형태다. 그래서 단위 문자열은
  //    이제 `metricUnit.position` **한 곳**이 정본이다(카드·표·지도·이 칩이 같은 키).
  //    `rank` 단위를 쓰는 지표는 AI 우선 노출도 하나뿐이다(COMPARE_METRIC_UNITS).
  const tUnit = useTranslations("metricUnit");
  const text =
    !chip.suppressed && chip.unit === "rank" && chip.value != null
      ? tUnit("position", { n: chip.value.toFixed(1) })
      : periodChipText(chip);
  const ariaLabel = chip.suppressed
    ? t("aria.suppressed")
    : t(`aria.${chip.direction}`, { value: text });
  return (
    <DeltaChip
      direction={chip.direction}
      text={text}
      suppressed={chip.suppressed}
      size={size}
      glyph={glyph}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}

/**
 * 캡션 한 문장. 키는 순수 계층이 고른다(`periodCaption` → `window` | `reason.*`).
 *
 * `reasonOnly`(기본 true) — 정상 상태의 `window` 문구("현재 N회차 / 직전 M회차")는
 * 카드·타일처럼 자리가 좁은 지면에서 매번 반복되면 소음이다. 억제 사유만 그린다.
 */
export function PeriodDeltaCaption({
  caption,
  reasonOnly = true,
  className,
}: {
  caption: PeriodCaptionMessage;
  reasonOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations("periodCompare");
  if (reasonOnly && caption.key === "window") return null;
  return (
    <span
      // 마지막 마디만 남긴다 — 프리뷰 DOM 에서 `reason.` 접두사는 잡음이다.
      data-period-delta-reason={caption.key.replace(/^reason\./, "")}
      className={cn("text-[11px] text-muted-foreground", className)}
    >
      {t(caption.key, caption.params)}
    </span>
  );
}
