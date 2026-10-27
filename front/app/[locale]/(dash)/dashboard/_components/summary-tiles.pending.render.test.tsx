import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { KpiSummary } from "../_data/model";
import { SummaryTilesView } from "./summary-tiles";
import { tilesViewFor } from "./__fixtures__/tiles-views";

// 측정 대기 타일은 Δ 를 그리지 않는다(Overview overviewCardState 와 같은 규칙). 웹사이트·프로젝트 타일은 Δ 를 추이의 마지막 두
// 회차(applyTrendDeltas)에서 채우므로, 카드가 대기여도 직전 회차들의 Δ 가 칩으로 새어 나왔다. 분모가 없는 0(0/0)도 측정된 0 이
// 아니라 대기다(SOV: 답변은 있는데 언급이 0 이면 API 가 null + no_data, 어댑터는 비율 없는 0).

vi.mock("next-intl/server", () => ({ getRequestConfig: <T,>(fn: T) => fn }));
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("next/navigation");
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

const { loadMessages } = await import("@/i18n/request");

async function render(items: KpiSummary[]): Promise<string> {
  const messages = await loadMessages("ko");
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      <TooltipProvider>
        <SummaryTilesView view={tilesViewFor(items)} />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
}

const pendingLabel = async () => ((await loadMessages("ko")) as { dashboard: { kpi: { pending: string } } }).dashboard.kpi.pending;

describe("summary tiles: pending cards show no delta", () => {
  it("a null card (e.g. the latest round hides mentions) draws no delta chip", async () => {
    const html = await render([{ key: "sentiment", value: null, delta: 2.1, direction: "up" }]);
    expect(html).toContain(await pendingLabel());
    expect(html).not.toContain("2.1pp");
  });

  it("0 without a denominator (0/0) is pending, not 0.0%, and draws no delta", async () => {
    const html = await render([{ key: "shareOfVoice", value: 0, delta: -1.4, direction: "down" }]);
    expect(html).toContain(await pendingLabel());
    expect(html).not.toContain("0.0%");
    expect(html).not.toContain("1.4pp");
  });

  it("a measured 0 (denominator > 0) keeps its value and delta", async () => {
    const html = await render([
      { key: "shareOfVoice", value: 0, delta: -3.2, direction: "down", ratio: { numerator: 0, denominator: 120 } },
    ]);
    expect(html).toContain("0.0%");
    expect(html).toContain("3.2pp");
  });
});
