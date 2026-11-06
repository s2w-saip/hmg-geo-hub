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

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/acr",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnAcrBody } = await import("./acr-body");
const { serviceWeekContext } = await import("@/components/service-week/provider");
const ServiceWeek = serviceWeekContext();

const bodies = fixture as unknown as Record<"snapshot" | "period", RnAcrInput>;
const T = ko.renewal.acr;

// `week`: the shell's service week (components/service-week/provider.tsx); none = a page rendered on its own
function render(input: RnAcrInput, week: import("@/components/service-week/provider").ServiceWeekContextValue | null = null): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <ServiceWeek.Provider value={week}>
        <RnFilterRuntime>
          <RnOverviewFilters props={{ stage: "acr", scope: { all: true } }} savedFilters={{ page: "acr", userId: "test", initial: [] }}>
            <RnAcrBody input={input} />
          </RnOverviewFilters>
        </RnFilterRuntime>
      </ServiceWeek.Provider>
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
    expect(html).toMatch(/data-rn-b="Toyota"[^>]*title="함께 후보에 오른 반복 8회\(상대 Toyota\) — 당사 승 2 \(25\.0%\) · Toyota 승 3 \(37\.5%\) · 그 외 3 \(37\.5%\)"/);
  });
});

describe("renewal ACR body: what the page counts, and when", () => {
  it("a snapshot names its round in the footer", () => {
    const html = render(bodies.snapshot);
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
  it("a snapshot under a service week with no Global round: 측정 없음 and the week, no filter advice", () => {
    // review r1-19 (2026-11-03): the BFF reads no snapshot of a surface the week holds no round of (Context.create);
    // the page said '국가·언어·카탈로그 조건을 줄여 보세요' with a reset that cannot bring a round back
    const week = (global: boolean) => {
      const view = { state: "ok" as const, week: { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 }, delay: null, checkedAt: null, recordedAt: null, rounds: { global, website: true }, notes: [] };
      return { initial: Promise.resolve(view), latest: view, applies: true, surface: "global" as const, sites: "", notesFor: "" };
    };
    const empty = (filtered: boolean): RnAcrInput => ({ ...bodies.snapshot, measured: false, filtered, view: null });
    for (const filtered of [true, false]) {
      const html = render(empty(filtered), week(false));
      expect(html).toContain("측정 없음");
      expect(html).toContain("서비스 기준 주 7월 5주차(7/27~8/2)에는 Global 측정 회차가 없습니다.");
      expect(html).not.toContain(T.states.noResultDesc);
      expect(html).not.toContain(T.states.reset);
    }
    // a Global round in the week, or a period in the URL: the page's own states
    expect(render(empty(true), week(true))).toContain(T.states.noResultDesc);
    nav.search = "time=2026-07-01..2026-07-31";
    try {
      expect(render({ ...empty(true), period: true }, week(false))).toContain("이 기간에는 ACR 측정 회차가 없거나");
    } finally {
      nav.search = "";
    }
  });
  it("a period that starts after the service week: the week names it, not the period or the filters (review r3-12)", () => {
    // review r3-12 (2026-11-03): the BFF reads no round of a period after the week (Context.create), and the page said
    // '이 기간에는 ACR 측정 회차가 없거나 … 조건을 줄여 보세요' with a reset of every filter
    const view = { state: "ok" as const, week: { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 }, delay: null, checkedAt: null, recordedAt: null, rounds: { global: true, website: true }, notes: [] };
    const week = { initial: Promise.resolve(view), latest: view, applies: true, surface: "global" as const, sites: "", notesFor: "" };
    const empty: RnAcrInput = { ...bodies.period, measured: false, filtered: true, period: true, view: null };
    nav.search = "time=2026-08-03..2026-08-09";
    try {
      const html = render(empty, week);
      expect(html).toContain("아직 보이지 않는 기간");
      expect(html).toContain("고른 기간(2026-08-03 ~ 2026-08-09)은 서비스 기준 주 7월 5주차(7/27~8/2) 뒤입니다.");
      expect(html).not.toContain("이 기간에는 ACR 측정 회차가 없거나");
      expect(html).not.toContain(T.states.reset);
    } finally {
      nav.search = "";
    }
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
  // 2026-11-02 premise review: the arrow tells a rival's move; only 당사's change is better or worse (Mention's rule)
  it("colours 당사's Δ only", () => {
    const input = structuredClone(bodies.snapshot);
    input.view!.brands[1].d = 5;
    const html = render(input);
    const chip = (brand: string) => html.slice(html.indexOf(`data-rn-b="${brand}" data-rn-top1`)).match(/data-tone="(\w+)"/)?.[1];
    expect(chip("Hyundai")).toBe("up");
    expect(chip("Toyota")).toBe("flat");
  });
  it("a period of several rounds shows their sums and its trend", () => {
    const html = render(bodies.period);
    expect(html).toContain("기간 누적 — 프롬프트 3개");
    expect(html).toContain(T.hero.basisPeriod);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
  });
  // SSOT Δ, D-11 (2026-11-06): a period compares with the one before (the fixture's period before answers the same counts)
  it("a period shows Δ against the period before", () => {
    const view = bodies.period.view!;
    expect(view.showDelta).toBe(true);
    expect(view.ownDelta).toBe(0);
    expect(render(bodies.period)).toContain(T.delta.flat);
  });
});

describe("renewal ACR body: each number once (2026-11-05 Global 지표 정리)", () => {
  it("has no round summary and no navy card", () => {
    for (const input of [bodies.snapshot, bodies.period]) {
      const html = render(input);
      expect(html).not.toContain('id="sec-summary"');
      expect(html).not.toContain('data-rn-tone="hero"');
    }
  });
  // D-11 (2026-11-06): the card is back with what makes it more than the board's two values
  it("후보 → 최종 선택 draws the brands against the brand average line", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(`aria-label="${T.map.title}"`);
    expect(html).toContain(`aria-label="${T.map.aria}"`);
    expect(html).toContain(T.map.chip.replace("{n}", String(bodies.snapshot.view!.brands.length)));
  });
  it("the hero keeps Top1 ACR and 후보군 포함율; 1순위 선택 is the board's 최종 선택, the cells and repetitions the footer's", () => {
    const html = render(bodies.snapshot);
    const hero = html.slice(html.indexOf(`aria-label="${T.hero.label}"`), html.indexOf(`aria-label="${T.board.title}"`));
    expect(hero.match(/<dt/g)).toHaveLength(1);
    expect(hero).toContain(T.hero.coverage);
    for (const gone of ["1순위 선택", "측정 셀", "반복 측정"]) expect(html).not.toContain(`>${gone}<`);
    // the single own brand's row carries 당사's 최종 선택 (7 = the own total's)
    expect(html).toMatch(/data-rn-b="Hyundai"[^>]*>[^]*?title="Hyundai — Top1 ACR 35\.0% · 후보군 포함율 37\.5% · 최종 선택 7회/);
    expect(html.match(/셀\(프롬프트×엔진×국가\) 8개 · 반복 20회/g)).toHaveLength(1);
  });
  it("the 당사 row stays when the top 12 leave the one own brand out", () => {
    const view = bodies.snapshot.view!;
    const kept = view.brands.flatMap((b, i) => (b.own ? [] : [i]));
    const boardOrders = Object.fromEntries(Object.entries(view.boardOrders).map(([k, o]) => [k, o.filter((i) => kept.includes(i)).map((i) => kept.indexOf(i))])) as typeof view.boardOrders;
    const out: RnAcrInput = { ...bodies.snapshot, view: { ...view, brands: kept.map((i) => view.brands[i]), boardOrders } };
    const html = render(out);
    expect(html).toMatch(/data-rn-b="__own" data-rn-top1[^>]*>[^]*?title="HMG — Top1 ACR 35\.0% · 후보군 포함율 37\.5% · 최종 선택 7회/);
    const row = html.slice(html.indexOf('data-rn-b="__own" data-rn-top1'), html.indexOf('data-rn-b="Toyota" data-rn-top1'));
    expect(row).toContain(`>${T.board.own}<`);
    expect(row).not.toContain(`>${T.board.ownTotal}<`);
    // an own brand on the board is 당사's row: no second one
    expect(render(bodies.snapshot)).not.toContain('data-rn-b="__own" data-rn-top1');
  });
  it("the head-to-head sample is said once, in the card's ⓘ", () => {
    const html = render(bodies.snapshot);
    expect(html.match(/셀당 반복 1개를 표본으로 계산합니다/g)).toHaveLength(1);
    const card = html.slice(html.indexOf(`aria-label="${T.duel.title}"`));
    expect(card.slice(0, card.indexOf("</section>"))).toContain(`role="tooltip"`);
  });
  it("the engine card's chip names the rival topping every engine in the most prompts, the summary's one value of its own", () => {
    const view = bodies.snapshot.view!;
    const swept: RnAcrInput = { ...bodies.snapshot, view: { ...view, sweeps: [{ brand: "Toyota", count: 156 }, { brand: "Tesla", count: 96 }] } };
    const html = render(swept);
    expect(html).toContain(">모든 엔진에서 Toyota 1위인 프롬프트 156개<");
    expect(html).not.toContain("Tesla 1위인");
    expect(html).toContain(`>${T.battle.sweepLabel}<`);
    const none = render(bodies.snapshot);
    expect(view.sweeps).toEqual([]);
    expect(none).not.toContain("모든 엔진에서");
    expect(none).not.toContain(`>${T.battle.sweepLabel}<`);
  });
});

describe("renewal ACR body: the rounds' numbers come back (the original 선택률 추이)", () => {
  it("every brand's spark names each round's Top1 ACR", () => {
    const html = render(bodies.snapshot);
    const row = (brand: string) => html.slice(html.indexOf(`data-rn-b="${brand}" data-rn-top1`), html.indexOf("</div>", html.indexOf(`data-rn-b="${brand}" data-rn-top1`)));
    expect(row("Hyundai")).toContain('data-rn-tip="2026-09-03 회차 · Top1 ACR 6.3%"');
    expect(row("Hyundai")).toContain('data-rn-tip="2026-09-10 회차 · Top1 ACR 33.3%"');
    // a round without a value has no point to name
    expect(row("Toyota")).not.toContain("2026-09-03 회차");
    expect(row("Toyota")).toContain('data-rn-tip="2026-09-10 회차 · Top1 ACR 66.7%"');
  });
  it("the spark's points sit outside the compare button (a focusable point inside a button is not reachable)", () => {
    const html = render(bodies.snapshot);
    const start = html.indexOf('data-rn-b="Toyota" data-rn-top1');
    const row = html.slice(start, html.indexOf("</div>", start));
    expect(row).toContain("aria-pressed=");
    const button = row.slice(row.indexOf("<button"), row.indexOf("</button>"));
    expect(button).toContain(">Toyota<");
    expect(button).not.toContain("data-rn-spark-point");
    expect(row).toContain("data-rn-spark-point");
  });
});

describe("renewal ACR body: the model table's name sorts (the original table's)", () => {
  it("sorts by rate, shortlist, picks, brand and model", () => {
    const html = render(bodies.snapshot);
    const card = html.slice(html.indexOf(`aria-label="${T.models.title}"`));
    const head = card.slice(0, card.indexOf('role="radiogroup"') + 2000);
    for (const [seg, label] of [["conversionRate", T.models.colRate], ["shortlistCount", T.models.colShortlist], ["top1Count", T.models.colTop1], ["brand", T.models.colBrand], ["model", T.models.colModel]]) {
      expect(head).toContain(`data-rn-seg="${seg}" class=`);
      expect(head).toMatch(new RegExp(`data-rn-seg="${seg}"[^>]*>${label.replace(/[()]/g, "\\$&")}<`));
    }
    expect(bodies.snapshot.view!.models.orders.brand).toEqual([0]);
  });
});

describe("renewal ACR body: the brand board (renewal audit 11-4 · 11-5)", () => {
  it("sorts by the original table's name, final picks and mentions too", () => {
    const html = render(bodies.snapshot);
    for (const label of [T.board.sortTop1, T.board.sortCoverage, T.board.sortDelta, T.board.sortChoices, T.board.sortMentions, T.board.sortBrand]) {
      expect(html).toContain(`>${label}<`);
    }
  });
  it("keeps the 당사 = … 합산 chip in the dense layout", () => {
    const multi: RnAcrInput = { ...bodies.snapshot, view: { ...bodies.snapshot.view!, ownBrands: ["Hyundai", "Kia"], multiOwn: true } };
    const html = render(multi);
    const chip = T.hero.ownSum.replace("{brands}", "Hyundai+Kia");
    expect(html).toContain(`>${chip}<`);
    const box = html.slice(html.lastIndexOf("<div", html.indexOf(`>${chip}<`)), html.indexOf(`>${chip}<`));
    expect(box).not.toContain("rn-dense_&amp;]:hidden");
    expect(box).not.toContain("rn-dense_&]:hidden");
  });
});

// no cap on the compare rivals (the user, 2026-11-05): a pick past the third takes the next Chart - Other colour —
// the fourth the yellow base — where it was capped at the three colours the palette was misread as
describe("renewal ACR compare colours", () => {
  it("colours every picked rival by pick order, 당사 navy and the rest grey", async () => {
    const { makeColorOf, OWN_COLOR, CONTEXT_COLOR } = await import("./acr-context");
    const colorOf = makeColorOf(["A", "B", "C", "D", "E"], (b) => b === "Kia");
    expect(["A", "B", "C", "D", "E"].map(colorOf)).toEqual(["#ff7651", "#ff0082", "#c00ced", "#ffbe42", "#ff9174"]);
    expect(colorOf("Kia")).toBe(OWN_COLOR);
    expect(colorOf("F")).toBe(CONTEXT_COLOR);
  });
});
