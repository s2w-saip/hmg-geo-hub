import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnAcrInput } from "../_data/screen-types";
import fixture from "./acr-body.fixture.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal ACR body — static render
// ════════════════════════════════════════════════════════════════════════════
// The fixture is the BFF's own output (back/bff/screens/acr.py renewal over the reader answer of
// back/bff/tests/test_screens_acr.py; test_front_fixture_is_current keeps it in step): a snapshot and a
// period of two rounds.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/acr",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnAcrBody } = await import("./acr-body");

const bodies = fixture as unknown as Record<"snapshot" | "period", RnAcrInput>;
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
    const html = render(bodies.snapshot);
    const conv = bodies.snapshot.view!.conversion.views.all;
    expect(html).toContain(T.conv.title);
    expect(html).toContain(`질문 × 시장 ${conv.n}개`);
    expect(html).toContain(`aria-label="${T.conv.open.replace("{country}", "—")}"`);
    expect(html).toContain(`>${T.conv.sortListed}<`);
  });
  it("the head-to-head card shows each rival's wins and says it is a sample", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(T.duel.title);
    expect(html).toContain(T.duel.chip);
    expect(html).toContain("셀당 반복 1개를 표본으로 계산합니다(반복 20회 중 8회, 셀 8개)");
    expect(html).toMatch(/data-rn-b="Toyota"[^>]*title="Toyota와 함께 후보에 오른 반복 8회 — 당사 승 2 \(25\.0%\) · Toyota 승 3 \(37\.5%\) · 그 외 3 \(37\.5%\)"/);
  });
});

describe("renewal ACR body: what the page counts, and when", () => {
  it("a snapshot names its round in the summary chip and the footer", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(">2026-09-14 기준 · 직전 회차 대비<");
    expect(html).toContain("최신 회차(2026-09-14) 스냅샷 — 프롬프트 3개");
  });
  it("the engine card counts the prompts with a pick, of the prompts measured", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(">선택이 나온 프롬프트 1개(측정 3개) × 엔진 2개<");
  });
  it("an empty period says the period may hold no ACR round; other filters keep the scope reason", () => {
    const empty = (b: RnAcrInput): RnAcrInput => ({ ...b, measured: false, filtered: true, view: null });
    expect(render(empty(bodies.period))).toContain("이 기간에는 ACR 측정 회차가 없거나");
    const filtered = render(empty(bodies.snapshot));
    expect(filtered).toContain(T.states.noResultDesc);
    expect(filtered).not.toContain("이 기간에는 ACR 측정 회차가 없거나");
  });
});

describe("renewal ACR body: rounds compared", () => {
  it("a snapshot draws the trend, the Δ column and its sort", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
    expect(html).toContain(`>${T.board.colTrend}</span>`);
    expect(html).toContain(`>${T.board.colDelta}</span>`);
    expect(html).toContain(`>${T.board.sortDelta}<`);
  });
  it("a period of several rounds shows their sums and its trend", () => {
    const html = render(bodies.period);
    expect(html).toContain(T.summary.titlePeriod);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
  });
});
