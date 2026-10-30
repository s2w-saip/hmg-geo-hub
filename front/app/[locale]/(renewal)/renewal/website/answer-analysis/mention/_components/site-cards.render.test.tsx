import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnSiteCardsVM } from "./site-cards";
import type { RnWeeklyVM } from "./weekly-mentions";
import type { MissingPromptRow } from "./missing-prompts";

// The legacy website Mention's values on the renewal page (2026-10-30, the user: a legacy KPI is reshaped, never
// dropped; no value is made up):
// - KPI 세부 지표: the six summary cards and the sentiment card's signal counts, grouped under the KPI tab each one
//   explains, with the legacy labels, values, Δ, ratio line and the Δ basis said once; the open tab's group marked;
//   the 미언급 count opens its prompt list;
// - 주별 브랜드 언급 수: the legacy weekly chart as one line per brand (own scale) with the latest week and its change,
//   every week's count in 표로 보기;
// - the 미언급 list splits by the brand mentions the answers hold.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/website/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams("geography=US"),
}));

const { RnSiteCards, KPI_GROUPS } = await import("./site-cards");
const { RnWeeklyMentions, weekLabel } = await import("./weekly-mentions");
const { missingPromptsQuery, segmentRows } = await import("./missing-prompts");
const { RnMentionPageProvider } = await import("../../../../standard/answer-analysis/mention/_components/mention-tabs");
const { MentionProvider } = await import("../../../../standard/answer-analysis/mention/_components/mention-context");

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const S = ko.answerAnalysis.mentions.summary;
const SUB = ko.answerAnalysis.mentions.breakdown.sub;
const W = ko.renewal.website.mention;

const VM: RnSiteCardsVM = {
  asOf: "2026-10-09",
  summary: { total: 280499, uniqueBrands: 436, totalPrompts: 10009, totalAnswers: 20219 },
  subKpis: {
    missingPrompts: 836, multiMentionAnswers: 17579, top3Rate: 99.7, top3Count: 17744, top3Base: 17799,
    positiveKeywords: 68934, negativeKeywords: 357, ownMentionRate: 88.0, totalMentions: 280499, measuredPrompts: 10009,
  },
  deltas: {
    total: { diff: -12034, unit: "count", tone: "bad" },
    totalPrompts: { diff: 120, unit: "count", tone: "neutral" },
    missingPrompts: { diff: 410, unit: "count", tone: "bad" },
    multiMention: { diff: 0, unit: "count", tone: "good" },
    top3Rate: { diff: 0.2, unit: "pp", tone: "good" },
  },
  prevBasisDate: "2026-10-02",
  degraded: { data: false, types: false, subKpis: false },
};

const input = (kpi: "exposure" | "sov") => ({ kpi, view: "kpi", ownLabel: "HMG", period: null, filtered: false }) as never;
const ctx = (tables: string[] = []) => ({
  input: input("exposure"), kpi: "exposure" as const, setKpi: () => {}, ownLabel: "HMG", drawer: [], ownBrands: ["HMG"],
  pick: { auto: true, brands: [] }, setPick: () => {}, lit: [], hover: () => {}, flash: () => {}, tables: new Set(tables),
  toggleTable: () => {}, engineLabel: (e: string) => e, openDrawer: () => {},
});
const render = (node: ReactNode, kpi: "exposure" | "sov" = "exposure", tables: string[] = []) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnMentionPageProvider input={input(kpi)}>
        <MentionProvider value={ctx(tables)}>{node}</MentionProvider>
      </RnMentionPageProvider>
    </NextIntlClientProvider>,
  );
const text = (html: string) => html.replace(/<span class="group\/tip[\s\S]*?<\/dt>/g, "</dt>").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Group → its cards as "label value [Δ] [detail]". */
function groups(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [, kpi, body] of html.matchAll(/data-rn-kgroup="([\w-]+)"[^>]*>(.*?)<\/dl><\/section>/g)) {
    out[kpi] = [...body.matchAll(/data-rn-site-card="\w+"[^>]*>(.*?)<\/div>(?=<div data-rn-site-card|$)/g)].map(([, c]) => text(c));
  }
  return out;
}

describe("website mention KPI breakdown", () => {
  it("keeps every legacy count, grouped under the KPI it explains", () => {
    const html = render(<RnSiteCards cards={settled(VM)} period={false} pageAsOf={settled("2026-10-09")} />);
    expect(KPI_GROUPS.map((g) => g.kpi)).toEqual(["exposure", "sov", "favorability", "first-rank"]);
    expect(groups(html)).toEqual({
      exposure: [`${S.totalPrompts} 10,009 120`, `${S.missingPrompts} 836 410`],
      sov: [`${S.total} 280,499 12,034`, `${S.uniqueBrands} 436`, `${S.multiMention} 17,579 변화 없음`],
      favorability: [`${SUB.positiveKeywords} 68,934`, `${SUB.negativeKeywords} 357`],
      "first-rank": [`${S.top3Rate} 99.7% 0.2pp 17,744 / 17,799 답변`],
    });
    // tone: neutral (direction only) / worse / worse / unchanged / better
    expect([...html.matchAll(/data-tone="(\w+)"/g)].map(([, t]) => t)).toEqual(["flat", "down", "down", "flat", "up"]);
    // the Δ basis said once, in the head; the date only when it is not the page's (이번 회차 요약 says that one)
    expect(html).toContain(W.cards.chipDelta.replace("{date}", "2026-10-02"));
    expect(html).not.toContain("▲▼");
    expect(html).not.toContain(W.cards.chipAsOf.replace("{date}", "2026-10-09"));
    expect(render(<RnSiteCards cards={settled(VM)} period={false} pageAsOf={settled("2026-10-02")} />)).toContain(W.cards.chipAsOf.replace("{date}", "2026-10-09"));
    // the open tab's group is marked; every group title opens its KPI; the 미언급 count opens its list
    expect([...html.matchAll(/data-rn-kgroup="([\w-]+)" aria-current="true"/g)].map(([, k]) => k)).toEqual(["exposure"]);
    expect(html).toContain(`aria-label="${W.cards.openKpi.replace("{kpi}", "AI 점유율")}"`);
    expect(html).toContain(`aria-label="${W.cards.openMissing.replace("{count}", "836")}"`);
    expect(render(<RnSiteCards cards={settled(VM)} period={false} pageAsOf={settled("2026-10-09")} />, "sov")).toMatch(/data-rn-kgroup="sov" aria-current="true"/);
  });

  it("a period compares with the window's first round, as the legacy caption said (the period itself is the summary's chip)", () => {
    const html = render(<RnSiteCards cards={settled(VM)} period pageAsOf={null} />);
    expect(html).toContain(W.cards.chipDeltaPeriod.replace("{date}", "2026-10-02"));
    expect(html).not.toContain(ko.renewal.mention.summary.chipPeriod);
  });

  // without Sub KPI the screen sends only the summary Δ (mention_surfaces.summary_deltas)
  it("without Sub KPI the counts read — with the degraded line; nothing without data; no list without a missing prompt", () => {
    const html = render(<RnSiteCards cards={settled({ ...VM, subKpis: null, deltas: { total: VM.deltas!.total, totalPrompts: VM.deltas!.totalPrompts }, prevBasisDate: null, degraded: { data: false, types: false, subKpis: true } })} period={false} pageAsOf={settled("2026-10-09")} />);
    expect(groups(html).exposure).toEqual([`${S.totalPrompts} 10,009 120`, `${S.missingPrompts} —`]);
    expect(html).toContain(ko.renewal.mention.degraded.all);
    expect(html).not.toContain(W.cards.openMissing.replace("{count}", "0"));
    expect(render(<RnSiteCards cards={settled({ ...VM, summary: null })} period={false} pageAsOf={null} />)).not.toContain("data-rn-kgroup");
  });
});

const WEEKLY: RnWeeklyVM = {
  weeks: ["2026-09-21", "2026-09-28", "2026-10-05"],
  gaps: [false, true, false],
  rows: [
    { brand: "HMG", own: true, values: [100, null, 120], latest: 120, delta: null },
    { brand: "Toyota", own: false, values: [4, null, 6], latest: 6, delta: -2 },
  ],
  degraded: false,
};

describe("website mention weekly brand mentions", () => {
  it("one line per brand with the latest week and its change; the gap week said once", () => {
    const html = render(<RnWeeklyMentions weekly={settled(WEEKLY)} />);
    const rows = [...html.matchAll(/data-rn-weekly-row="([^"]+)"[^>]*>(.*?)<\/tr>/g)].map(([, b, body]) => [b, text(body)]);
    expect(rows).toEqual([
      ["HMG", "HMG 당사 120 증감 없음"],
      ["Toyota", "Toyota 6 2"],
    ]);
    expect(html).toContain('title="9/21 4 · 9/28 — · 10/5 6"');
    expect(html).toContain(W.weekly.chip.replace("{from}", "9/21").replace("{to}", "10/5").replace("{n}", "3"));
    expect(html).toContain(W.weekly.gapNote);
    // a rival's move keeps the arrow without better / worse
    expect([...html.matchAll(/data-tone="(\w+)"/g)].map(([, t]) => t)).toEqual(["flat"]);
  });

  it("표로 보기 shows every week's count", () => {
    const html = render(<RnWeeklyMentions weekly={settled(WEEKLY)} />, "exposure", ["site-weekly"]);
    expect(html).toContain('data-rn-weekly="table"');
    expect(text(html.match(/<tbody>.*<\/tbody>/)![0])).toBe("HMG 100 — 120 Toyota 4 — 6");
  });

  it("without a trend: pending, or the degraded line", () => {
    expect(render(<RnWeeklyMentions weekly={settled({ ...WEEKLY, rows: [], weeks: [], gaps: [] })} />)).toContain(ko.answerAnalysis.pending);
    expect(render(<RnWeeklyMentions weekly={settled({ weeks: [], gaps: [], rows: [], degraded: true })} />)).toContain(ko.answerAnalysis.mentions.kpi.degradedTrend);
    expect(weekLabel("2026-07-06")).toBe("7/6");
  });
});

describe("website mention missing prompts", () => {
  const row = (id: string, text: string, brandMentions: number) => ({ id, promptText: text, brandMentions, answersTotal: 2 }) as MissingPromptRow;
  const ROWS = [row("a", "Best used import car?", 47), row("b", "How to read the registration?", 0), row("c", "Best family MPV", 3)];

  it("reads the page's filters on the website surface", () => {
    expect(missingPromptsQuery("geography=US&time=2026-09-01..2026-09-30")).toBe("geography=US&time=2026-09-01..2026-09-30&surface=website");
  });

  it("splits by the brand mentions the answers hold, keeps the screen's order, searches the text", () => {
    expect(segmentRows(ROWS, "all", "").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(segmentRows(ROWS, "withBrands", "").map((r) => r.id)).toEqual(["a", "c"]);
    expect(segmentRows(ROWS, "noBrands", "").map((r) => r.id)).toEqual(["b"]);
    expect(segmentRows(ROWS, "all", "best").map((r) => r.id)).toEqual(["a", "c"]);
  });
});
