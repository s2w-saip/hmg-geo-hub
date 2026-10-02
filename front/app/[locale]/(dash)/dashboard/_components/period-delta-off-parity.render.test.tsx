import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CompetitorBrandValue } from "@/lib/scope/result-adapter";
import type { KpiSummary } from "../_data/sample";
import { OverviewKpiCards } from "./overview-kpi-cards";
import { SummaryTiles } from "./summary-tiles";

// `useFilterSignal` 이 `useSearchParams()` 를 부른다 — 라우터 컨텍스트가 없는 정적
// 렌더에서는 null 이므로 빈 쿼리스트링으로 고정한다(필터 무선택 = 기본 화면).
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("next/navigation");
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

// GGMD-107 C4 의 수용 기준 하나: **기간 비교 Δ 가 off 일 때 화면이 바이트 하나도 안 바뀐다.**
//
// 스펙 `period-comparison-delta`「기간 미선택 기본 화면은 값이 바뀌지 않는다」·
// 「off 에서 왕복·페이로드 증가 0」의 렌더 쪽 대응물이다.
//
// ── 골든의 출처 (정확히) ───────────────────────────────────────────────────
//   · 최초 생성: 착수 전 기준 sha **20bef01**(구현 0줄). 그래서 이 파일이 통과한다는 것은
//     "지금 코드가 지금 코드와 같다" 가 아니라 **"지금 코드가 구현 전 코드와 같다"** 다.
//   · **재생성 1회: `59ec9c1`**(C5 — Δ 기준 라벨 정정, 문구 전용 커밋). 그때의 word-diff 는
//     `dashboard.overview.competitorDeltaBasis` 문구 치환 **3건뿐**이다:
//       ko `회차` → `지점` · ko `측정 회차가` → `비교할 지점이` · en `cycle` → `point`.
//     `summaryTiles/{ko,en}` 은 바이트 동일이었다. 구조·수치·클래스 변경 0 = "값 diff 0".
//
// 재생성: `UPDATE_OFF_PARITY_FIXTURE=1 npx vitest run <이 파일>`.
// ⚠️ 재생성은 **의도적으로 off 상태 렌더를 바꿨을 때만** 하고, 커밋 메시지에 word-diff 를
//    적어 "무엇이 바뀌어도 되는지" 를 남긴다. 값을 맞추려고 골든을 다시 찍으면 이
//    테스트는 아무것도 지키지 않는다.

const FIXTURE = fileURLToPath(
  new URL("./__fixtures__/period-delta-off-parity.json", import.meta.url),
);

const kpi = (
  key: KpiSummary["key"],
  value: number | null,
  delta: number | null,
): KpiSummary => ({
  key,
  value,
  delta,
  direction: delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down",
  ratio: { numerator: 1, denominator: 100 },
});

const brand = (b: string, over: Partial<CompetitorBrandValue>): CompetitorBrandValue => ({
  brand: b,
  mentions: 10,
  share: 1,
  mentionRate: 1,
  avgPosition: null,
  isTracked: false,
  ...over,
});

const BRANDS: CompetitorBrandValue[] = [
  brand("Hyundai", { isTracked: true, mentionRate: 60, share: 30, avgPosition: 1.8 }),
  brand("Tesla", { mentionRate: 40, share: 20, avgPosition: 2.4 }),
  brand("Toyota", { mentionRate: 31.5, share: 12.5, avgPosition: 3.1 }),
];

// 카드 ①~⑤ + 순위형(내림이 좋은 지표) + Δ 없음(null) 을 한 번에 덮는다.
const KPIS: KpiSummary[] = [
  kpi("visibility", 74.6, 9.8),
  kpi("shareOfVoice", 31.2, -1.6),
  kpi("sentiment", 62.0, 0),
  kpi("position", 2.1, -0.4),
  kpi("citationShare", 5.3, null),
];

// 웹사이트 Overview 타일 — betterIs=lower(우선노출도)와 count 단위를 포함시킨다.
const TILE_ITEMS: KpiSummary[] = [
  kpi("visibility", 74.6, 9.8),
  kpi("shareOfVoice", 31.2, -1.6),
  kpi("sentiment", 62.0, 0),
  kpi("position", 2.1, -0.4),
  kpi("citationAccuracy", 84.2, 1.4),
  kpi("trafficConversion", 2.7, null),
  kpi("citationShare", 5.3, null),
];

function render(node: React.ReactNode, locale: "ko" | "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );
}

/** 골든 대상 — 이름 → 렌더 문자열. 키를 늘리면 골든도 늘어난다. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const locale of ["ko", "en"] as const) {
    out[`overviewKpiCards/${locale}`] = render(
      <OverviewKpiCards kpis={KPIS} trend={null} brands={BRANDS} locale={locale} />,
      locale,
    );
    out[`summaryTiles/${locale}`] = render(
      <SummaryTiles items={TILE_ITEMS} perturb={false} />,
      locale,
    );
  }
  return out;
}

describe("기간 비교 Δ off — 렌더 바이트 동일 (C4 수용 기준)", () => {
  const current = snapshot();

  if (process.env.UPDATE_OFF_PARITY_FIXTURE === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }

  it("골든 파일이 존재한다", () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  const golden: Record<string, string> = existsSync(FIXTURE)
    ? JSON.parse(readFileSync(FIXTURE, "utf8"))
    : {};

  it("골든과 현재 렌더의 대상 집합이 같다", () => {
    expect(Object.keys(current).sort()).toEqual(Object.keys(golden).sort());
  });

  for (const key of Object.keys(current)) {
    it(`${key} 가 변경 전과 바이트 동일하다`, () => {
      expect(current[key]).toBe(golden[key]);
    });
  }
});
