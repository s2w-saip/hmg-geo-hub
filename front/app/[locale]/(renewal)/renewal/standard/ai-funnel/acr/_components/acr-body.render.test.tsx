import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnAcrInput } from "../_data/screen-types";
import fixture from "./acr-body.fixture.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal ACR body — static render of the cross-round hold
// ════════════════════════════════════════════════════════════════════════════
// The fixture is the BFF's own output (back/bff/screens/acr.py renewal over the reader answer of
// back/bff/tests/test_screens_acr.py; test_front_fixture_is_current keeps it in step): a snapshot with
// rounds held (COMPARE_ROUNDS off) and compared, and a period of two rounds held.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/acr",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnAcrBody } = await import("./acr-body");

const bodies = fixture as unknown as Record<"held" | "compared" | "period", RnAcrInput>;
const T = ko.renewal.acr;

function render(input: RnAcrInput): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "acr", scope: { all: true } }} savedFilters={{ page: "acr", userId: "test", initial: [] }}>
          <RnAcrBody input={input} />
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

describe("renewal ACR body: 후보 → 선택 전환 and 결선 맞대결", () => {
  it("the conversion card counts every market's questions by our state, the not-picked count first", () => {
    const html = render(bodies.held);
    const conv = bodies.held.view!.conversion.views.all;
    expect(html).toContain(T.conv.title);
    expect(html).toContain(`질문 × 시장 ${conv.n}개`);
    expect(html).toContain(`aria-label="${T.conv.open.replace("{country}", "—")}"`);
    expect(html).toContain(`>${T.conv.sortListed}<`);
  });
  it("the head-to-head card shows each rival's wins and says it is a sample", () => {
    const html = render(bodies.held);
    expect(html).toContain(T.duel.title);
    expect(html).toContain(T.duel.chip);
    expect(html).toContain("셀당 반복 1개를 표본으로 계산합니다(반복 20회 중 8회, 셀 8개)");
    expect(html).toMatch(/data-rn-b="Toyota"[^>]*title="Toyota와 함께 후보에 오른 반복 8회 — 당사 승 2 \(25\.0%\) · Toyota 승 3 \(37\.5%\) · 그 외 3 \(37\.5%\)"/);
  });
});

describe("renewal ACR body: rounds not compared", () => {
  it("a held snapshot says so, draws no trend and the board has no trend or Δ column", () => {
    const html = render(bodies.held);
    expect(html).toContain(T.held.note);
    expect(html).toContain(T.held.trend);
    expect(html).toContain(T.hero.basisHeld);
    expect(html).toContain(T.summary.chipHeld);
    expect(html).toContain(T.board.subHeld);
    expect(html).not.toContain(`aria-label="${T.hero.trendAria}"`);
    expect(html).not.toContain(`>${T.board.colTrend}</span>`);
    expect(html).not.toContain(`>${T.board.colDelta}</span>`);
    expect(html).not.toContain(`>${T.board.sortDelta}<`);
  });
  it("compared, the same page draws the trend, the Δ column and its sort", () => {
    const html = render(bodies.compared);
    expect(html).not.toContain(T.held.note);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
    expect(html).toContain(`>${T.board.colTrend}</span>`);
    expect(html).toContain(`>${T.board.colDelta}</span>`);
    expect(html).toContain(`>${T.board.sortDelta}<`);
  });
  it("a period of several rounds shows its rounds and the way to the latest round, no sums", () => {
    const html = render(bodies.period);
    expect(html).toContain(T.held.periodTitle);
    expect(html).toContain("선택한 기간에 측정 회차가 2개(2026-09-03 ~ 2026-09-10) 있습니다.");
    expect(html).toContain(`>${T.held.latest}</button>`);
    expect(html).not.toContain(T.summary.titlePeriod);
  });
});
