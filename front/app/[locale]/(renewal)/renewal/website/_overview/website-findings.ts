// Renewal Website Overview — 핵심 요약: at most four cards picked from what the screens sent, nothing judged or
// derived. Each card restates values shown in a section below, so the reader starts from them:
//   change   the tiles whose Δ the screen marked worse (tone bad / a period chip down), and the counts by tone
//   engine   the KPI of the lowest engine consistency (website/engines widest) with its best and worst engine
//            and their answer counts
//   brand    AI 인용 점유율 of each website brand (website/brands), highest first — the page's subject
//   source   the most cited domain, how many of the listed domains are 당사 (isOurs), the share of 기타
// No threshold, no "meaningful change": a card shows when its values exist.
// A card is a list (2026-10-30, the user): a head (what it lists, a short note) and one row per value, label left
// and value right, instead of the values joined into one sentence.

import type { RnFindingTone } from "@/components/renewal-ui";
import type { KpiKey, KpiUnit } from "@/app/[locale]/(dash)/dashboard/_data/model";
import type { CompositionView, TilesView, TileView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { Failed, WebsiteBrandsView, WebsiteEnginesView } from "./website-format";

type T = (key: string, params?: Record<string, string | number>) => string;

export interface FindingFormat {
  /** "88.0%", "1.1번째" */
  value: (unit: KpiUnit, v: number) => string;
  /** "5.2pp" (magnitude; the arrow carries the direction) */
  delta: (unit: KpiUnit, d: number) => string;
  count: (n: number) => string;
  short: (k: KpiKey) => string;
  engine: (code: string) => string;
}

export interface FindingRow {
  label: string;
  /** muted text after the label (an engine's answers) */
  meta?: string;
  value: string;
  /** a change row, drawn as its tile draws it: arrow = the value's direction (a period chip: better / worse), colour = better / worse */
  change?: { dir: "up" | "down"; tone: "up" | "down" | "flat" };
  /** the engine table's mark (가장 앞섬 / 가장 뒤짐) */
  mark?: { text: string; best: boolean };
}

export interface WebsiteFinding {
  key: "change" | "engine" | "brand" | "source";
  tone: RnFindingTone;
  tag: string;
  /** beside the tag: the counts by tone, the KPI and its consistency */
  note?: string;
  rows: FindingRow[];
  /** said instead of rows (no KPI changed) */
  empty?: string;
}

interface Change {
  tone: "up" | "down" | "flat";
  dir: "up" | "down";
  text: string;
}

/** A tile's change as the screen marked it: the period chip when a period is compared, else the trend Δ. Under a
 * period compare a tile without a period result has no change of that compare (its round Δ is not it). */
function changeOf(x: TileView, f: FindingFormat, periodMode: boolean): Change | null {
  if (x.pending) return null;
  if (x.period) {
    if (x.period.suppressed || x.period.value == null) return null;
    const unit = x.period.unit === "pp" ? "pp" : x.period.unit === "pct" ? "%" : "";
    // the chip draws its tone as the arrow (periodChipText: no sign)
    return { tone: x.period.direction, dir: x.period.direction === "down" ? "down" : "up", text: `${x.period.value.toFixed(1)}${unit}` };
  }
  if (periodMode || x.delta == null) return null;
  const tone = x.tone === "good" ? "up" : x.tone === "bad" ? "down" : "flat";
  return { tone, dir: x.direction === "down" || (x.direction !== "up" && x.delta < 0) ? "down" : "up", text: f.delta(x.unit, x.delta) };
}

export function websiteFindings(
  input: { tiles: TilesView; engines: WebsiteEnginesView | null; brands: WebsiteBrandsView | Failed | null; composition: CompositionView | null },
  t: T,
  f: FindingFormat,
): WebsiteFinding[] {
  const out: WebsiteFinding[] = [];
  const tiles = input.tiles.groups.flatMap((g) => g.tiles);

  const periodMode = tiles.some((x) => x.period);
  const changes = tiles.map((x) => ({ x, c: changeOf(x, f, periodMode) })).filter((r): r is { x: TileView; c: Change } => r.c != null);
  if (changes.length) {
    const by = (tone: string) => changes.filter((r) => r.c.tone === tone);
    const worse = by("down");
    const better = by("up");
    const shown = worse.length ? worse : better;
    out.push({
      key: "change",
      tone: worse.length ? "warn" : better.length ? "good" : "info",
      tag: t(periodMode ? "findings.changePeriod" : "findings.changeRound"),
      note: t("findings.changeCounts", { down: worse.length, up: better.length, flat: by("flat").length }),
      rows: shown.map((r) => ({ label: f.short(r.x.key), value: r.c.text, change: { dir: r.c.dir, tone: r.c.tone } })),
      empty: shown.length ? undefined : t("findings.noChange"),
    });
  }

  const e = input.engines;
  const widest = e && !e.degraded ? e.widest : null;
  const ex = widest ? e!.extremes[widest] : undefined;
  if (widest && ex && e!.consistency[widest] != null) {
    const unit: KpiUnit = widest === "position" ? "rank" : "percent";
    const answers = (code: string) => e!.engines.find((r) => r.engine === code)?.answers ?? 0;
    const row = (s: { engine: string; value: number | null }, best: boolean): FindingRow => ({
      label: f.engine(s.engine),
      meta: t("findings.engineAnswers", { answers: f.count(answers(s.engine)) }),
      value: s.value == null ? "—" : f.value(unit, s.value),
      mark: { text: t(best ? "legendBest" : "legendWorst"), best },
    });
    out.push({
      key: "engine",
      tone: "info",
      tag: t("findings.engineTag"),
      note: t("findings.engineNote", { kpi: f.short(widest), consistency: e!.consistency[widest]!.toFixed(1) }),
      rows: [row(ex.best, true), row(ex.worst, false)],
    });
  }

  const b = input.brands;
  if (b && b !== "failed" && b.brands) {
    const rows = b.brands
      .map((r) => ({ brand: r.brand, cell: r.cells.citationShare }))
      .filter((r) => r.cell && !r.cell.pending && r.cell.value != null)
      .sort((x, y) => y.cell!.value! - x.cell!.value!);
    if (rows.length >= 2) {
      out.push({
        key: "brand",
        tone: "info",
        tag: t("findings.brandTag", { kpi: f.short("citationShare") }),
        rows: rows.map((r) => ({ label: r.brand, value: f.value("percent", r.cell!.value!) })),
      });
    }
  }

  const c = input.composition;
  const listed = c && !c.degraded ? c.sources.filter((s) => s.domain !== "") : [];
  if (listed.length) {
    const rest = c!.sources.find((s) => s.domain === "");
    out.push({
      key: "source",
      tone: "info",
      tag: t("findings.sourceTag"),
      rows: [
        { label: t("findings.sourceTop", { domain: listed[0].domain }), value: `${listed[0].share.toFixed(1)}%` },
        { label: t("findings.sourceOwn", { top: listed.length }), value: t("findings.sourceOwnValue", { own: listed.filter((s) => s.isOurs).length }) },
        ...(rest ? [{ label: t("findings.sourceRest"), value: `${rest.share.toFixed(1)}%` }] : []),
      ],
    });
  }
  return out;
}
