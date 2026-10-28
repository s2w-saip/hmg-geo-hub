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
    // an uncompared KPI stays a dash; a compared one without Δ ends after its bar
    const bmw = out.slice(out.indexOf('data-rn-brand-row="BMW"'), out.indexOf("</tr>", out.indexOf('data-rn-brand-row="BMW"')));
    expect([...bmw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(2).map(([, c]) => c)).toEqual(["—", "—", "—", "—"]);
    expect(bmw).toMatch(/<b[^>]*>31\.2%<\/b><span[^>]*><i[^>]*><\/i><\/span><\/div>/);
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
