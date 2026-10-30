// Renewal Website Overview — 핵심 요약 cards as lists (2026-10-30, the user): the look of the analysis pages'
// finding cards (RnFindingGrid: tone bar, icon, tag) with one row per value — label left, value right — so the
// values read down a column instead of along a joined sentence. Rows come from website-findings.ts.

import { Sparkles, TrendingUp, TriangleAlert } from "lucide-react";
import { cx, type RnFindingTone } from "@/components/renewal-ui";
import type { FindingRow, WebsiteFinding } from "./website-findings";

const TONE_BAR: Record<RnFindingTone, string> = {
  warn: "shadow-[inset_3px_0_0_#d65a43]",
  good: "shadow-[inset_3px_0_0_var(--color-rn-up)]",
  info: "shadow-[inset_3px_0_0_var(--color-rn-navy-300)]",
};
const TONE_ICON: Record<RnFindingTone, string> = { warn: "text-[#d65a43]", good: "text-rn-up", info: "text-rn-navy-300" };

export function WebsiteFindingList({ items }: { items: ReadonlyArray<WebsiteFinding> }) {
  return (
    <div className="grid grid-cols-4 gap-2.5 px-6 @max-[900px]/rnpage:grid-cols-2 [.rn-dense_&]:px-4.5" data-rn-findings="">
      {items.map((x) => {
        const Icon = x.tone === "warn" ? TriangleAlert : x.tone === "good" ? TrendingUp : Sparkles;
        return (
          <section key={x.key} data-rn-finding={x.key} className={cx("flex min-w-0 flex-col gap-1 rounded-[10px] bg-rn-surface py-2 pr-3.5 pl-4 break-keep", TONE_BAR[x.tone])}>
            <h3 className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-rn-11 font-bold text-rn-muted">
              <span className="inline-flex items-center gap-1.5">
                <Icon className={cx("size-3", TONE_ICON[x.tone])} aria-hidden />
                {x.tag}
              </span>
              {x.note ? <span className="ml-auto font-semibold text-rn-faint">{x.note}</span> : null}
            </h3>
            {x.rows.length ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {x.rows.map((r, i) => (
                  <Row key={i} row={r} />
                ))}
              </ul>
            ) : x.empty ? (
              <p className="m-0 text-rn-12 font-semibold text-rn-ink-2">{x.empty}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Row({ row }: { row: FindingRow }) {
  const c = row.change;
  return (
    <li className="flex items-baseline gap-2 text-rn-12 leading-[19px]">
      <span className="min-w-0 truncate font-semibold text-rn-ink-2" title={row.label}>
        {row.label}
      </span>
      {row.meta ? <span className="shrink-0 text-rn-11 text-rn-muted tabular-nums">{row.meta}</span> : null}
      <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
        {row.mark ? (
          <span data-rn-mark={row.mark.best ? "best" : "worst"} className={cx("text-rn-11 font-semibold", row.mark.best ? "text-rn-navy" : "text-rn-danger-ink")}>
            {row.mark.text}
          </span>
        ) : null}
        <b
          data-tone={c?.tone}
          className={cx("font-bold whitespace-nowrap tabular-nums", !c ? "text-rn-ink" : c.tone === "up" ? "text-rn-up-ink" : c.tone === "down" ? "text-rn-danger-ink" : "text-rn-muted")}
        >
          {c ? (c.dir === "up" ? "▲" : "▼") : null}
          {row.value}
        </b>
      </span>
    </li>
  );
}
