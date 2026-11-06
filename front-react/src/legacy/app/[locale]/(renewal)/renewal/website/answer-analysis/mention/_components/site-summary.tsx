"use client";

import { use } from "react";
import { useTranslations } from "use-intl";
import type { RnFinding } from "@/components/renewal-ui";
import { SummaryCard } from "../../../../standard/answer-analysis/mention/_components/mention-body";
import { deltaTxt, pctTxt, useMention } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { useMarketName, type RnMarketRow, type RnMarketsVM } from "./site-markets";

// 이번 회차 요약 (2026-11-02): the standard headline over four findings of this page, in a fixed order and never filtered by
// a threshold: where the answers naming 당사 fell and rose most (both, a fall alone would be a HUB pick), the 미언급
// prompts, every engine, favorability. Only favorability's own move carries a colour.

/** The markets where the answers naming 당사 fell and rose most; null when no market compares. */
export function marketMoves(rows: readonly RnMarketRow[]): { down: RnMarketRow; up: RnMarketRow } | null {
  const moved = rows.filter((r) => r.mentionedDelta != null);
  if (!moved.length) return null;
  const by = (sign: number) => moved.reduce((a, b) => (sign * (b.mentionedDelta! - a.mentionedDelta!) > 0 ? b : a));
  return { down: by(-1), up: by(1) };
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString()}`;

export function RnSiteSummary({ markets }: { markets: Promise<RnMarketsVM> }) {
  const { input, engineLabel } = useMention();
  const t = useTranslations("renewal.website.mention.summary");
  const name = useMarketName();
  const vm = use(markets);
  const engines = use(input.rateEngines).exposure.rows;
  const favor = use(input.favorHero);
  const items: RnFinding[] = [];
  const moves = marketMoves(vm.rows);
  if (moves) {
    const { down, up } = moves;
    const flat = down.mentionedDelta === 0 && up.mentionedDelta === 0;
    items.push({
      key: "market",
      tone: "info",
      tag: t("tagMarket"),
      title: flat
        ? t("marketFlat")
        : down === up
          ? t("marketOne", { country: name(down.country), delta: signed(down.mentionedDelta!) })
          : t("marketMoves", { down: name(down.country), downDelta: signed(down.mentionedDelta!), up: name(up.country), upDelta: signed(up.mentionedDelta!) }),
    });
  }
  if (vm.rows.length) {
    const count = vm.rows.reduce((s, r) => s + r.missing, 0);
    const withBrands = vm.rows.reduce((s, r) => s + r.missingWithBrands, 0);
    items.push({
      key: "missing",
      tone: "info",
      tag: t("tagMissing"),
      title: t("missing", { count: count.toLocaleString(), withBrands: withBrands.toLocaleString(), noBrands: (count - withBrands).toLocaleString() }),
    });
  }
  if (engines.length) {
    items.push({
      key: "engine",
      tone: "info",
      tag: t("tagEngine"),
      title: t("engine", { list: engines.map((e) => `${engineLabel(e.engine)} ${pctTxt(e.own)}`).join(" · ") }),
    });
  }
  if (favor.positivePct != null) {
    const d = favor.positiveDelta.value;
    items.push({
      key: "favor",
      tone: d == null || d === 0 ? "info" : d > 0 ? "good" : "warn",
      tag: t("tagFavor"),
      title: d == null ? t("favorFlat", { pct: pctTxt(favor.positivePct), neg: pctTxt(favor.negativePct) }) : t("favor", { pct: pctTxt(favor.positivePct), delta: deltaTxt(d), neg: pctTxt(favor.negativePct) }),
    });
  }
  return <SummaryCard items={items} how={t("how")} />;
}
