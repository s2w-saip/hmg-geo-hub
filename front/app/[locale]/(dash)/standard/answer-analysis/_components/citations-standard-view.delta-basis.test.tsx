import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsStandardView } from "./citations-standard-view";
import { standardVmFor } from "./citation-vm.fixture";

// 카테고리 Δ(공식(HMG)·딜러·카테고리 바)의 두 값은 같은 단위여야 한다. 기간(?time=)이 회차 2개 이상이면 카드 값은 기간 누적인데
// 직전 값은 추이의 직전 회차 하나라, 누적 − 회차 하나가 Δ 로 찍혔다(r1..r4 = 30·10·10·10/100 → 누적 15.0%, 직전 r3 10.0% → ▲5.0pp,
// 실제 r3→r4 변화 0). API 원천은 직전 값과 같은 추이의 마지막 회차(`current`)를 함께 실어 회차 − 회차로 낸다(공식(HMG) Δ 정본과 같은 기준).

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

// 카드(기간 누적): 공식(HMG) 60 / 400 = 15.0%
const LIVE = {
  summary: { total: 400, uniqueDomains: 2, officialOwnShare: 15 },
  asOf: "2026-09-22",
  domains: [],
  categories: [
    { name: "Official (HMG)", value: 60 },
    { name: "Automotive Media", value: 340 },
  ],
  categoryTrend: null,
  engineCategories: null,
  trend: null,
  promptSplit: null,
} as unknown as CitationsLive;

// 직전 회차 r3 = 10 / 100 = 10.0%, 마지막 회차 r4 = 10 / 100 = 10.0%
const PREV = { totals: { total: 100, byCategory: { "Official (HMG)": 10, "Automotive Media": 90 } }, asOf: "2026-09-15" };
const LAST = { total: 100, byCategory: { "Official (HMG)": 10, "Automotive Media": 90 } };

function view(prevCategories: unknown) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationsStandardView
        data={LIVE}
        vm={standardVmFor(LIVE, { prev: prevCategories as never })}
        typeChart={null}
        toneSummary={null}
      />
    </NextIntlClientProvider>,
  );
}

describe("category deltas compare a round with a round", () => {
  it("API source (current = last trend round): r3 → r4 is flat, not ▲5.0pp", () => {
    const html = view({ ...PREV, current: LAST });
    expect(html).not.toContain("5.0pp");
  });

  it("legacy source (no current): the card value is still the current side", () => {
    const html = view(PREV);
    expect(html).toContain("5.0pp");
  });
});
