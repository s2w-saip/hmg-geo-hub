import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { OVERVIEW_KPI_KEYS } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { BrandMatrixView, CardTrendView, OverviewCardView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { RnOverviewBody } from "./overview-body";
import { FEEDBACK_EMAIL_TEXT } from "@/lib/support-contact";

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
        deferred={{ trend: settled(trend), matrix: settled(matrix) }}
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
    cards: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, { delta: 0.5, spark: k === "position" ? rank : rate }])) as CardTrendView["cards"],
  };
  const out = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnOverviewBody cards={cards} compareTitle={null} geo={null} qs="" deferred={{ trend: settled(valued), matrix: settled(null) }} />
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

// 브랜드 비교 (2026-10-28, 1920×1050): one 40px line per brand — each cell value · bar · Δ side by side.
// 2026-11-05 Global 지표 정리: 당사's row has no Δ — the KPI cards above show the same Δ (17 of 17 the same).
describe("renewal Overview brand table", () => {
  const own = (value: number) => ({ value, bar: value, best: false });
  const cell = (value: number, r: number | null) => ({ value, delta: r, bar: value, best: false, deltaMark: r == null ? null : { r, tone: "neutral" as const } });
  const matrix: BrandMatrixView = {
    cols: OVERVIEW_KPI_KEYS.map((key) => ({ key, best: null, max: null, standing: null })),
    rows: [
      { name: "HMG", own: true, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, own(76.6)])) as BrandMatrixView["rows"][0]["cells"] },
      { name: "BMW", own: false, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k, i) => [k, i ? null : cell(31.2, null)])) as BrandMatrixView["rows"][0]["cells"] },
    ],
  };

  it("puts a cell's value and bar on one line, 당사 without Δ", () => {
    const out = html(matrix);
    const own = out.slice(out.indexOf('data-rn-brand-row="own"'), out.indexOf("</tr>", out.indexOf('data-rn-brand-row="own"')));
    const cells = [...own.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(1).map(([, c]) => c);
    expect(cells).toHaveLength(5);
    // (the rank KPI's unit word stands where the rates read % / pp); no Δ, no no-Δ mark
    for (const c of cells) expect(c).toMatch(/^<div class="flex items-center[^"]*"><b[^>]*>76\.6[^<]+<\/b><span[^>]*><i[^>]*><\/i><\/span><\/div>$/);
    // a Δ on 당사's cell (as the screen sent before 2026-11-05) is not drawn
    const withDelta = { ...matrix, rows: [{ ...matrix.rows[0], cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, cell(76.6, -0.2)])) as BrandMatrixView["rows"][0]["cells"] }, matrix.rows[1]] };
    const out2 = html(withDelta);
    const own2 = out2.slice(out2.indexOf('data-rn-brand-row="own"'), out2.indexOf("</tr>", out2.indexOf('data-rn-brand-row="own"')));
    expect(own2).not.toMatch(/[▲▼]|data-rn-no-delta/);
    // an uncompared KPI stays a dash; a compared one without Δ says so with the no-Δ mark after its bar (renewal
    // audit 3-6: the place was left empty)
    const bmw = out.slice(out.indexOf('data-rn-brand-row="BMW"'), out.indexOf("</tr>", out.indexOf('data-rn-brand-row="BMW"')));
    expect([...bmw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(2).map(([, c]) => c)).toEqual(["—", "—", "—", "—"]);
    expect(bmw).toMatch(/<b[^>]*>31\.2%<\/b><span[^>]*><i[^>]*><\/i><\/span><span data-rn-no-delta=""[^>]*>−<\/span><\/div>/);
  });

  // 2026-11-02 premise review: the arrow tells a rival's move; only 당사's change is better or worse (Mention's rule)
  it("a rival's Δ keeps its arrow without the better/worse colour", () => {
    const moved = { value: 31.2, delta: 0.4, bar: 31.2, best: false, deltaMark: { r: 0.4, tone: "neutral" as const } };
    const rival = { ...matrix.rows[1], cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, moved])) as BrandMatrixView["rows"][0]["cells"] };
    const out = html({ ...matrix, rows: [matrix.rows[0], rival] });
    const from = out.indexOf('data-rn-brand-row="BMW"');
    const row = out.slice(from, out.indexOf("</tr>", from));
    expect(row).toContain("▲");
    expect(row).not.toMatch(/text-rn-(up|danger)-ink/);
    expect(row).not.toContain(ko.renewal.overview.deltaUp);
  });

  // 2026-11-05: HMG 3사 against single competitor brands hid each brand's place; 당사's brands come under 당사
  it("당사's brands under 당사: indented, the lighter own bar, no Δ, a dash with its own reason for the citation share", () => {
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    const brandCells = Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, k === "citationShare" ? null : own(53.1)])) as BrandMatrixView["rows"][0]["cells"];
    const kia = { name: "Kia", own: false, ownBrand: true, cells: brandCells };
    const out = html({ ...matrix, rows: [matrix.rows[0], kia, matrix.rows[1]] });
    expect(out.indexOf('data-rn-brand-row="own"')).toBeLessThan(out.indexOf('data-rn-brand-row="Kia"'));
    expect(out.indexOf('data-rn-brand-row="Kia"')).toBeLessThan(out.indexOf('data-rn-brand-row="BMW"'));
    const from = out.indexOf('data-rn-brand-row="Kia"');
    const row = out.slice(from, out.indexOf("</tr>", from));
    expect(row).toContain('data-rn-own-brand=""');
    expect(row).toContain("pl-10");
    expect(row).not.toContain(ko.renewal.overview.ownTag);
    expect((row.match(/bg-rn-navy-300/g) ?? []).length).toBe(4);
    expect(row).not.toMatch(/[▲▼]|data-rn-no-delta/);
    expect(decode(row)).toContain(ko.renewal.overview.ownBrandNoValue.replace("{kpi}", ko.dashboard.kpi.name.citationShare));
    expect(decode(row)).not.toContain(ko.renewal.overview.notCompared.replace("{kpi}", ko.dashboard.kpi.name.citationShare));
    // competitors are still there: no "no competitor" note
    expect(decode(out)).not.toContain(ko.dashboard.overview.noCompetitorData);
    const alone = html({ ...matrix, rows: [matrix.rows[0], kia] });
    expect(decode(alone)).toContain(ko.dashboard.overview.noCompetitorData);
    // the foot says what the brand rows count, only when there are some
    expect(decode(out)).toContain(ko.renewal.overview.brandsFootOwnBrands);
    expect(decode(html(matrix))).not.toContain(ko.renewal.overview.brandsFootOwnBrands);
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
  const one = { value: 50, bar: 50, best: true };
  const ownOnly = (degraded?: string[]): BrandMatrixView & { degraded?: string[] } => ({
    cols: OVERVIEW_KPI_KEYS.map((key) => ({ key, best: 50, max: 50, standing: null })),
    rows: [{ name: "HMG", own: true, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, one])) as BrandMatrixView["rows"][0]["cells"] }],
    ...(degraded ? { degraded } : {}),
  });
  function render(opts: { matrix?: unknown; compareTitle?: { key: string; params: Record<string, unknown> } | null }) {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody
          cards={cards}
          compareTitle={(opts.compareTitle ?? null) as never}
          geo={null}
          qs=""
          deferred={{
            trend: settled(trend),
            matrix: settled((opts.matrix ?? null) as never),
          }}
        />
      </NextIntlClientProvider>,
    );
  }
  const brandCard = (out: string) => out.slice(out.indexOf(`aria-label="${O.brandsTitle}"`));

  it("names the 대표 답변 basis in the KPI header and in every KPI's tip, with the page that counts every answer", () => {
    const out = render({});
    const head = text(out.slice(0, out.indexOf("data-rn-kpi=")));
    expect(head).toContain(O.kpiHintBasis);
    for (const k of OVERVIEW_KPI_KEYS) {
      const page = k === "citationShare" ? "Citation" : "Mention";
      expect(text(card(out, k)), k).toContain(`${O.basisLabel} ${fill(O.basisTip, { page })}`);
    }
  });

  it("says 당사's Δ is on the KPI cards, the rivals' is their last two rounds and a period has none", () => {
    // last review (2026-11-02): the hint said 'the period's last two rounds on every row'; 2026-11-05: 당사's row has no Δ
    const out = render({ matrix: ownOnly(), compareTitle: { key: "label.weekly", params: {} } });
    const hint = text(brandCard(out).slice(0, brandCard(out).indexOf("<table")));
    expect(hint).toContain(O.brandsHintPeriod);
    expect(O.brandsHintPeriod).toContain("당사 증감은 위 KPI");
    expect(hint).not.toContain("마지막 두 회차");
    const plain = brandCard(render({ matrix: ownOnly() }));
    expect(text(plain.slice(0, plain.indexOf("<table")))).toContain(fill(O.brandsHint, { compare: ko.dashboard.overview.compare }));
    expect(O.brandsHint).toContain("당사 증감은 위 KPI");
  });

  it("says a period's competitor citation shares count every answer", () => {
    expect(text(brandCard(render({ matrix: ownOnly() })))).toContain(O.brandsFoot);
    expect(O.brandsFoot).toContain("전체 답변");
  });

  it("shows the brand table's failure instead of dropping the table", () => {
    const out = render({ matrix: "failed" });
    expect(out).toContain(`aria-label="${O.brandsTitle}"`);
    expect(text(brandCard(out))).toContain(O.brandsFailed.replace("{contact}", FEEDBACK_EMAIL_TEXT));
  });

  it("says a competitor read failed instead of 'no competitor value'", () => {
    const failed = render({ matrix: ownOnly(["standardMentions"]) });
    expect(text(brandCard(failed))).toContain(O.brandsPartial.replace("{contact}", FEEDBACK_EMAIL_TEXT));
    expect(text(brandCard(failed))).not.toContain(ko.dashboard.overview.noCompetitorData);
    // nothing failed and nobody compared: the old wording stays
    const none = render({ matrix: ownOnly() });
    expect(text(brandCard(none))).toContain(ko.dashboard.overview.noCompetitorData);
  });
});

// 2026-11-05 Global 지표 정리: two KPI card parts said a number the page shows elsewhere — '비교 브랜드 N개 중 M위' (the
// brand table's column head '당사 M위/N', the same in 17 of 17 reads) and the header's '추이 = 최근 N회차' (the spark's
// dated rounds). Both are gone; the header keeps 집계 and 증감, the table its column standing.
describe("renewal Overview KPI card without repeats", () => {
  const decode = (s: string) => s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const matrix: BrandMatrixView = {
    cols: OVERVIEW_KPI_KEYS.map((key) => ({ key, best: 50, max: 50, standing: { rank: 1, count: 5 } })),
    rows: [{ name: "HMG", own: true, cells: Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, { value: 50, bar: 50, best: true }])) as BrandMatrixView["rows"][0]["cells"] }],
  };
  const out = html(matrix);
  const head = decode(out.slice(0, out.indexOf("data-rn-kpi=")));

  it("no standing line on the cards", () => {
    expect(out).not.toContain("data-rn-standing");
    const kpis = out.slice(0, out.indexOf(`aria-label="${ko.renewal.overview.brandsTitle}"`));
    for (const k of OVERVIEW_KPI_KEYS) expect(decode(card(kpis, k)), k).not.toMatch(/비교 브랜드|\d+위/);
  });
  it("the header names the basis and the compare, not the trend's rounds", () => {
    expect(head).toContain(ko.renewal.overview.kpiHintBasis);
    expect(head).toContain(ko.renewal.overview.kpiHintDelta.replace("{compare}", ko.dashboard.overview.compare));
    expect(head).not.toContain("추이");
  });
  it("the table keeps 당사's column standing", () => {
    expect(decode(out.slice(out.indexOf("data-rn-brand-matrix")))).toContain(ko.renewal.overview.colStanding.replace("{rank}", "1").replace("{count}", "5"));
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
        <RnOverviewBody cards={cs} compareTitle={compareTitle} geo={null} qs="" deferred={{ trend: settled(trend), matrix: settled(null) }} />
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

// 2026-11-05 Global 지표 정리: with 2026-09 picked the AI 우선 노출도 chip read ↑0.1 in green while the brand table read
// ▼0.1 — 2.2번째 was 0.1 ahead of the month before. The period chip's direction is better / worse; its arrow drew that
// direction, so a rank that fell (better) pointed up. The arrow is the value's and the colour better / worse (design
// rules: 위아래 화살표는 숫자 방향, 색은 좋아짐 · 나빠짐), as the round Δ chip (RnDeltaChip) already draws it.
describe("renewal Overview period chip arrow", () => {
  const chip = (key: string, unit: "pp" | "rank", direction: "up" | "down") => ({ key, unit, suppressed: false, value: 0.1, direction });
  const render = (direction: "up" | "down") =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody
          cards={OVERVIEW_KPI_KEYS.map((key) => ({
            key,
            value: 50,
            pending: false,
            period: { chip: key === "position" ? chip("position", "rank", direction) : chip(key, "pp", direction), label: { key: "label.weekly", params: {} }, caption: { key: "window", params: {} } },
          }) as OverviewCardView)}
          compareTitle={{ key: "label.weekly", params: {} }}
          geo={null}
          qs=""
          deferred={{ trend: settled(trend), matrix: settled(null) }}
        />
      </NextIntlClientProvider>,
    );
  const arrow = (out: string, k: string) => {
    const html = card(out, k);
    // 새 외형 (2026-11-05): a solid triangle (data-rn-dir) and the chip's ink on the chip itself
    const chip = html.match(/<span[^>]*data-tone="\w+"[^>]*class="([^"]*)"/)?.[1] ?? "";
    return { tone: html.match(/data-tone="(\w+)"/)?.[1], dir: html.match(/data-rn-dir="(up|down)"/)?.[1], ink: chip.match(/text-rn-(up|danger)-ink/)?.[1] };
  };

  it("a rank that fell (better) points down in green", () => {
    expect(arrow(render("up"), "position")).toEqual({ tone: "up", dir: "down", ink: "up" });
  });
  it("a rank that rose (worse) points up in red", () => {
    expect(arrow(render("down"), "position")).toEqual({ tone: "down", dir: "up", ink: "danger" });
  });
  it("a rate's arrow is its better / worse direction, which is its value's", () => {
    expect(arrow(render("up"), "visibility")).toEqual({ tone: "up", dir: "up", ink: "up" });
    expect(arrow(render("down"), "citationShare")).toEqual({ tone: "down", dir: "down", ink: "danger" });
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
  it("AI 노출률 names the representative answers its formula counts, the other KPIs keep the shared formulas", () => {
    expect(card(html(), "visibility")).toContain(ko.renewal.overview.formulaVisibility);
    expect(card(html(), "shareOfVoice")).toContain(ko.dashboard.kpi.formula.shareOfVoice);
  });
});

// 2026-10-28 (user): 상세 opened the original pages — from the renewal shell the card opens the renewal
// ones, with the KPI's tab and the page's filters
describe("renewal Overview detail links", () => {
  it("opens each KPI's renewal analysis page", () => {
    const out = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <RnOverviewBody cards={cards} compareTitle={null} geo={null} qs="brand=Kia" deferred={{ trend: settled(trend), matrix: settled(null) }} />
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
