import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { OVERVIEW_KPI_KEYS } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { BrandMatrixView, CardTrendView, OverviewCardView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { RnOverviewBody } from "./overview-body";

// Renewal Overview KPI cards — every round the spark draws is dated under its point
// (2026-10-28: with only the first and the last dated, the five-round line read as two rounds).

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const DAYS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const spark: CardTrendView["cards"]["visibility"]["spark"] = {
  points: DAYS.map((day, i) => ({ bucketStart: day, value: 70 + i, wow: null, display: { day, time: null } })),
  domain: [0, 100],
  hasValue: true,
};
const trend: CardTrendView = {
  degraded: false,
  count: DAYS.length,
  cards: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, { delta: 0.5, spark }])) as CardTrendView["cards"],
};
const cards: OverviewCardView[] = OVERVIEW_KPI_KEYS.map((key) => ({ key, value: 50, pending: false, period: null }));

function html(matrix: BrandMatrixView | null = null): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnOverviewBody
        cards={cards}
        compareTitle={null}
        geo={null}
        qs=""
        deferred={{ trend: settled(trend), competitors: settled({ degraded: [], rows: {} as never }), matrix: settled(matrix) }}
      />
    </NextIntlClientProvider>,
  );
}

/** The KPI card's markup, from its own data-rn-kpi up to the next card's. */
function card(out: string, k: string): string {
  const from = out.indexOf(`data-rn-kpi="${k}"`);
  const next = out.indexOf("data-rn-kpi=", from + 1);
  return out.slice(from, next < 0 ? undefined : next);
}

describe("renewal Overview KPI spark", () => {
  it.each(OVERVIEW_KPI_KEYS)("dates every round under its point on %s", (k) => {
    const labels = [...card(html(), k).matchAll(/<span[^>]*style="left:([\d.]+)%"[^>]*>(?:<span[^>]*>)?([^<]+)</g)].map(([, left, text]) => `${text} @ ${left}%`);
    // the spark's points sit at 3 + i·114/(n−1) of its 120-wide box
    expect(labels).toEqual(["9/7 @ 2.5%", "9/14 @ 26.25%", "9/21 @ 50%", "9/28 @ 73.75%", "10/5 @ 97.5%"]);
  });
});

// Renewal audit 3-2 (2026-10-31): the original card showed each round's value and WoW on hover; the renewal spark was an
// aria-hidden line. Each point now names its round, its value and the change from the round before (overview/card-trend
// spark points: value, wow = the two Gold values' difference) — the first drawn round and a round after a gap say no change.
describe("renewal Overview KPI spark values", () => {
  const point = (i: number, value: number | null, wow: number | null, time: string | null = null) => ({ bucketStart: DAYS[i], value, wow, display: { day: DAYS[i], time } });
  const rate = { points: [point(0, 70, null), point(1, 71.04, 1), point(2, null, null), point(3, 72.4, null), point(4, 72.4, 0, "10:00")], domain: [0, 100] as [number, number], hasValue: true };
  const rank = { points: [point(0, 2.31, null), point(1, 2.1, -0.2), point(2, 2.4, 0.3), point(3, 2.4, 0), point(4, 2.5, 0.1)], domain: [1, 5] as [number, number], hasValue: true };
  const valued: CardTrendView = {
    degraded: false,
    count: DAYS.length,
    cards: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, { delta: 0.5, spark: k === "position" ? rank : rate }])) as CardTrendView["cards"],
  };
  const out = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnOverviewBody cards={cards} compareTitle={null} geo={null} qs="" deferred={{ trend: settled(valued), competitors: settled({ degraded: [], rows: {} as never }), matrix: settled(null) }} />
    </NextIntlClientProvider>,
  );
  const tips = (k: string) => [...card(out, k).matchAll(/data-rn-tip="([^"]*)"/g)].map(([, s]) => s.replace(/&#x27;/g, "'"));

  it("names every round's day and value, and the change from the round before", () => {
    expect(tips("visibility")).toEqual([
      "9/7 · 70.0%",
      "9/14 · 71.0%\n직전 회차 대비 ▲1.0pp",
      "9/21 · 데이터 없음",
      "9/28 · 72.4%",
      "10/5 10:00 · 72.4%\n직전 회차 대비 변화 없음",
    ]);
  });

  it("reads the rank card in its unit, the arrow following the value", () => {
    expect(tips("position")).toEqual([
      "9/7 · 2.3번째",
      "9/14 · 2.1번째\n직전 회차 대비 ▼0.2번째",
      "9/21 · 2.4번째\n직전 회차 대비 ▲0.3번째",
      "9/28 · 2.4번째\n직전 회차 대비 변화 없음",
      "10/5 · 2.5번째\n직전 회차 대비 ▲0.1번째",
    ]);
  });
});

// 브랜드 비교 (2026-10-28, 1920×1050): one 40px line per brand — each cell value · bar · Δ side by side
describe("renewal Overview brand table", () => {
  const cell = (value: number, r: number | null) => ({ value, delta: r, bar: value, best: false, deltaMark: r == null ? null : { r, tone: r > 0 ? ("good" as const) : ("bad" as const) } });
  const matrix: BrandMatrixView = {
    cols: OVERVIEW_KPI_KEYS.map((key) => ({ key, best: null, max: null, standing: null })),
    rows: [
      { name: "HMG", own: true, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, cell(76.6, -0.2)])) as BrandMatrixView["rows"][0]["cells"] },
      { name: "BMW", own: false, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k, i) => [k, i ? null : cell(31.2, null)])) as BrandMatrixView["rows"][0]["cells"] },
    ],
  };

  it("puts a cell's value, bar and Δ on one line", () => {
    const out = html(matrix);
    const own = out.slice(out.indexOf('data-rn-brand-row="own"'), out.indexOf("</tr>", out.indexOf('data-rn-brand-row="own"')));
    const cells = [...own.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(1).map(([, c]) => c);
    expect(cells).toHaveLength(5);
    // (the rank KPI's unit word stands where the rates read % / pp)
    for (const c of cells) expect(c).toMatch(/^<div class="flex items-center[^"]*"><b[^>]*>76\.6[^<]+<\/b><span[^>]*><i[^>]*><\/i><\/span><span[^>]*>▼(<!-- -->)?0\.2[^<]+<\/span><\/div>$/);
    // an uncompared KPI stays a dash; a compared one without Δ says so with the no-Δ mark after its bar (renewal
    // audit 3-6: the place was left empty)
    const bmw = out.slice(out.indexOf('data-rn-brand-row="BMW"'), out.indexOf("</tr>", out.indexOf('data-rn-brand-row="BMW"')));
    expect([...bmw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(2).map(([, c]) => c)).toEqual(["—", "—", "—", "—"]);
    expect(bmw).toMatch(/<b[^>]*>31\.2%<\/b><span[^>]*><i[^>]*><\/i><\/span><span data-rn-no-delta=""[^>]*>−<\/span><\/div>/);
  });
});

// Gold metric review ⚠️ (2026-10-29, Overview #20 #28 #30 #31 #32): the page says what its numbers count
// (대표 답변, while Mention / Citation count every answer), what the brand table's Δ compares in a period,
// and a read that failed says it failed — it neither vanishes nor reads as "no competitor value".
describe("renewal Overview basis and failure wording", () => {
  const O = ko.renewal.overview;
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const text = (s: string) => decode(s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const fill = (s: string, params: Record<string, string>) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), s);
  const NONE = Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, null])) as never;
  const one = { value: 50, delta: 0.5, bar: 50, best: true, deltaMark: { r: 0.5, tone: "good" as const } };
  const ownOnly = (degraded?: string[]): BrandMatrixView & { degraded?: string[] } => ({
    cols: OVERVIEW_KPI_KEYS.map((key) => ({ key, best: 50, max: 50, standing: null })),
    rows: [{ name: "HMG", own: true, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, one])) as BrandMatrixView["rows"][0]["cells"] }],
    ...(degraded ? { degraded } : {}),
  });
  function render(opts: { matrix?: unknown; compareTitle?: { key: string; params: Record<string, unknown> } | null; competitors?: unknown }) {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody
          cards={cards}
          compareTitle={(opts.compareTitle ?? null) as never}
          geo={null}
          qs=""
          deferred={{
            trend: settled(trend),
            competitors: settled((opts.competitors ?? { degraded: [], rows: {}, standing: NONE }) as never),
            matrix: settled((opts.matrix ?? null) as never),
          }}
        />
      </NextIntlClientProvider>,
    );
  }
  const brandCard = (out: string) => out.slice(out.indexOf(`aria-label="${O.brandsTitle}"`));
  const standing = (out: string, k: string) => text(out.match(new RegExp(`data-rn-standing="${k}"[^>]*>([\\s\\S]*?)</span>`))?.[1] ?? "");

  it("names the 대표 답변 basis in the KPI header and in every KPI's tip, with the page that counts every answer", () => {
    const out = render({});
    const head = text(out.slice(0, out.indexOf("data-rn-kpi=")));
    expect(head).toContain(O.kpiHintBasis);
    for (const k of OVERVIEW_KPI_KEYS) {
      const page = k === "citationShare" ? "Citation" : "Mention";
      expect(text(card(out, k)), k).toContain(`${O.basisLabel} ${fill(O.basisTip, { page })}`);
    }
  });

  it("says in a period compare that the brand table's Δ is the period's last two rounds, not the cards' compare", () => {
    const out = render({ matrix: ownOnly(), compareTitle: { key: "label.weekly", params: {} } });
    const hint = text(brandCard(out).slice(0, brandCard(out).indexOf("<table")));
    expect(hint).toContain(fill(O.brandsHintPeriod, { compare: ko.periodCompare.label.weekly }));
    expect(brandCard(out)).toContain(`title="${O.deltaUp} · ${O.deltaRounds}"`);
    // without a period the table and the cards compare the same rounds
    const plain = brandCard(render({ matrix: ownOnly() }));
    expect(text(plain.slice(0, plain.indexOf("<table")))).toContain(fill(O.brandsHint, { compare: ko.dashboard.overview.compare }));
  });

  it("says a period's competitor citation shares count every answer", () => {
    expect(text(brandCard(render({ matrix: ownOnly() })))).toContain(O.brandsFoot);
    expect(O.brandsFoot).toContain("전체 답변");
  });

  it("shows the brand table's failure instead of dropping the table", () => {
    const out = render({ matrix: "failed" });
    expect(out).toContain(`aria-label="${O.brandsTitle}"`);
    expect(text(brandCard(out))).toContain(O.brandsFailed);
  });

  it("says a competitor read failed instead of 'no competitor value'", () => {
    const failed = render({ matrix: ownOnly(["standardMentions"]), competitors: { degraded: ["standardMentions"], rows: {}, standing: NONE } });
    for (const k of OVERVIEW_KPI_KEYS) expect(standing(failed, k), k).toBe(O.rivalsFailed);
    expect(text(brandCard(failed))).toContain(O.brandsPartial);
    expect(text(brandCard(failed))).not.toContain(ko.dashboard.overview.noCompetitorData);
    // nothing failed and nobody compared: the old wording stays
    const none = render({ matrix: ownOnly() });
    expect(standing(none, "visibility")).toBe(ko.dashboard.overview.noCompetitorData);
    expect(text(brandCard(none))).toContain(ko.dashboard.overview.noCompetitorData);
  });
});

// Renewal audit 3-4 (2026-10-31): the header named the first compare result's label for every card. A window compare
// counts its rounds per metric, so the cards may compare different rounds: the header names the label they share, else
// says each card names its own, and the card shows it beside its chip.
describe("renewal Overview period compare labels", () => {
  const O = ko.renewal.overview;
  const P = ko.periodCompare;
  const text = (s: string) => s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const chip = { unit: "pp" as const, suppressed: false, value: 1.2, direction: "up" as const };
  const windowOf = (cur: number, prev: number) => ({ key: "window", params: { curCycles: cur, prevCycles: prev } });
  const withPeriods = (labels: Record<string, { key: string; params: Record<string, number> }>): OverviewCardView[] =>
    OVERVIEW_KPI_KEYS.map((key) => ({ key, value: 50, pending: false, period: { chip: { ...chip, key: "visibility" }, label: labels[key], caption: { key: "window", params: {} } } }) as OverviewCardView);
  const render = (cs: OverviewCardView[], compareTitle: { key: string; params: Record<string, number> } | null) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody cards={cs} compareTitle={compareTitle} geo={null} qs="" deferred={{ trend: settled(trend), competitors: settled({ degraded: [], rows: {} as never }), matrix: settled(null) }} />
      </NextIntlClientProvider>,
    );
  const head = (out: string) => text(out.slice(0, out.indexOf("data-rn-kpi=")));
  const fill = (s: string, params: Record<string, number | string>) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);

  it("names each card's own compare when the cards compare different rounds", () => {
    const labels = Object.fromEntries(OVERVIEW_KPI_KEYS.map((k, i) => [k, windowOf(3, i)]));
    const out = render(withPeriods(labels), null);
    expect(head(out)).toContain(fill(O.kpiHintDelta, { compare: O.comparePerCard }));
    OVERVIEW_KPI_KEYS.forEach((k, i) => expect(text(card(out, k)), k).toContain(fill(P.window, { curCycles: 3, prevCycles: i })));
  });

  it("names the shared compare once in the header, not on every card", () => {
    const labels = Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, { key: "label.weekly", params: {} }]));
    const out = render(withPeriods(labels), { key: "label.weekly", params: {} });
    expect(head(out)).toContain(fill(O.kpiHintDelta, { compare: P.label.weekly }));
    for (const k of OVERVIEW_KPI_KEYS) expect(text(card(out, k)), k).not.toContain(P.label.weekly);
  });
});

// The AI 우선 노출도 card reads "2.3번째"; its formula tip said "(단위: 위)" (the shared dashboard copy the legacy page and
// its copy test keep). The renewal card says the unit it shows, as the renewal Mention does.
describe("renewal Overview first position unit", () => {
  it("the position formula's unit is the card's (번째)", () => {
    const tip = card(html(), "position");
    expect(tip).toContain("(단위: 번째)");
    expect(tip).not.toContain("(단위: 위)");
  });
  it("the other KPIs keep the shared formulas", () => {
    expect(card(html(), "visibility")).toContain(ko.dashboard.kpi.formula.visibility);
  });
});

// 2026-10-28 (user): 상세 opened the original pages — from the renewal shell the card opens the renewal
// ones, with the KPI's tab and the page's filters
describe("renewal Overview detail links", () => {
  it("opens each KPI's renewal analysis page", () => {
    const out = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody cards={cards} compareTitle={null} geo={null} qs="brand=Kia" deferred={{ trend: settled(trend), competitors: settled({ degraded: [], rows: {} as never }), matrix: settled(null) }} />
      </NextIntlClientProvider>,
    );
    // one link per card, the card itself (no 상세 text): named "{KPI} 상세 보기" for a screen reader
    for (const k of OVERVIEW_KPI_KEYS) {
      const anchors = [...card(out, k).matchAll(/<a [^>]*>[^<]*<\/a>/g)].map(([a]) => a);
      expect(anchors, k).toHaveLength(1);
      expect(anchors[0], k).toContain(` aria-label="${ko.renewal.overview.detailLabel.replace("{name}", ko.dashboard.kpi.name[k])}"`);
      expect(anchors[0], k).toMatch(/><\/a>$/);
      // a new tab: the Overview being read stays as it is (2026-10-28)
      expect(anchors[0], k).toMatch(/ target="_blank"/);
      expect(anchors[0], k).toMatch(/ rel="noopener noreferrer"/);
    }
    const links = OVERVIEW_KPI_KEYS.map((k) => decodeURI(card(out, k).match(/<a [^>]*href="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&"));
    expect(links).toEqual([
      "/ko/renewal/standard/answer-analysis/mention?kpi=exposure&brand=Kia",
      "/ko/renewal/standard/answer-analysis/mention?kpi=sov&brand=Kia",
      "/ko/renewal/standard/answer-analysis/mention?kpi=favorability&brand=Kia",
      "/ko/renewal/standard/answer-analysis/mention?kpi=first-rank&brand=Kia",
      "/ko/renewal/standard/answer-analysis/citation?brand=Kia",
    ]);
  });
});
