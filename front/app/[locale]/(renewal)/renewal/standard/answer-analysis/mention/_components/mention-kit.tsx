"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnDeltaChip, RnInfoTip, RnInfoTipItem, RnSkeleton, RnTag, cx, rnHighlightState } from "@/components/renewal-ui";
import type { RnDelta } from "../_data/screen-types";
import { useMention } from "./mention-context";

// Small building blocks shared by the renewal Mention cards.

export function StateCard({ icon, title, desc, children }: { icon: ReactNode; title: string; desc?: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-2.5 rounded-rn-card border-[1.5px] border-dashed border-rn-line-2 bg-rn-surface px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-rn-navy/8 text-rn-navy">{icon}</span>
      <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{title}</h2>
      {desc ? <p className="m-0 max-w-[600px] text-rn-13 text-rn-muted">{desc}</p> : null}
      {children}
    </section>
  );
}

/** Placeholder of a card body while its read is in flight. */
export function CardSkeleton({ height = 220, className }: { height?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-3 px-6 py-5", className)} style={{ minHeight: height }}>
      <RnSkeleton className="h-4 w-40" />
      <RnSkeleton className="w-full flex-1" />
    </div>
  );
}

/** Transient failure of a read (api degrade) — the other numbers on the page are fine. */
export function DegradedNote({ children }: { children: ReactNode }) {
  return <p className="m-0 rounded-lg bg-rn-page px-3 py-2.5 text-rn-12 text-rn-muted">{children}</p>;
}

export function DeltaChip({ value, rank = false, invert = false, unit = "pp" }: { value: number | null; rank?: boolean; invert?: boolean; unit?: "pp" | "" }) {
  const t = useTranslations("renewal.mention.delta");
  return (
    <RnDeltaChip
      delta={value}
      lowerIsBetter={rank || invert}
      format={(r) => `${Math.abs(r).toFixed(1)}${rank ? "" : unit}`}
      emptyText={t("none")}
      labels={{ up: t("up"), down: t("down"), flat: t("flat") }}
    />
  );
}

/** One-line basis of a Δ ("직전 회차(10/12) 대비" …). */
export function useDeltaBasis(): (d: RnDelta) => string | null {
  const t = useTranslations("renewal.mention.delta");
  const tp = useTranslations("periodCompare");
  return (d) => {
    const b = d.basis;
    if (!b) return null;
    if (b.kind === "period") return b.caption.key === "window" ? t("basisPeriod") : tp(b.caption.key, b.caption.params);
    if (b.kind === "cycle") return b.date ? t("basisCycle", { date: b.date }) : t("basisCycleNoDate");
    return t("basisPrev", { date: b.date });
  };
}

/** Footnote sentence of a Δ basis (the original's hero.deltaBasis* lines). */
export function useDeltaNote(): (d: RnDelta, rank?: boolean) => string | null {
  const t = useTranslations("renewal.mention.delta");
  return (d, rank) => {
    const b = d.basis;
    if (rank) return b?.kind === "period" ? t("noteRankPeriod") : t("noteRank");
    if (!b) return null;
    if (b.kind === "period") return t("notePeriod");
    if (b.kind === "cycle") return b.date ? t("noteCycle", { date: b.date }) : null;
    return t("notePrev", { date: b.date });
  };
}

export function InfoTip({ label, items, align }: { label: string; items: ReadonlyArray<[ReactNode, ReactNode]>; align?: "start" | "end" }) {
  return (
    <RnInfoTip label={label} align={align}>
      {items.map(([l, c], i) => (
        <RnInfoTipItem key={i} label={l}>
          {c}
        </RnInfoTipItem>
      ))}
    </RnInfoTip>
  );
}

export function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-rn-12 text-rn-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-rn-15 font-bold text-rn-ink tabular-nums">{value}</dd>
    </div>
  );
}

/** Series legend; hovering an item lights that brand across the page. */
export function Legend({ items, shape = "line" }: { items: ReadonlyArray<{ key: string; name: string; color: string; own?: boolean; dashed?: boolean }>; shape?: "line" | "dot" | "square" }) {
  const { lit, hover } = useMention();
  const t = useTranslations("renewal.mention.hero");
  const keys = items.map((i) => i.key);
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-rn-12 text-rn-ink-2">
      {items.map((s) => {
        const st = rnHighlightState(lit, [s.key], keys);
        return (
          <span key={s.key} data-rn-b={s.key} onPointerEnter={() => hover(s.key)} onPointerLeave={() => hover(null)} className={cx("inline-flex items-center gap-1.5 transition-opacity", st === "dim" && "opacity-45", st === "on" && "font-bold text-rn-ink")}>
            {shape === "line" ? (
              <i aria-hidden className={cx("inline-block w-3 rounded", s.dashed ? "h-0 border-t-2 border-dashed" : "h-0.5")} style={s.dashed ? { borderColor: s.color } : { background: s.color }} />
            ) : (
              <i aria-hidden className={cx("inline-block size-2.5", shape === "dot" ? "rounded-full" : "rounded-[3px]")} style={{ background: s.color }} />
            )}
            {s.name}
            {s.own ? <RnTag>{t("own")}</RnTag> : null}
          </span>
        );
      })}
    </div>
  );
}

export function TwinTable({ head, rows, align }: { head: ReadonlyArray<ReactNode>; rows: ReadonlyArray<ReadonlyArray<ReactNode>>; align?: ReadonlyArray<"left" | "right"> }) {
  const al = (i: number) => align?.[i] ?? (i === 0 ? "left" : "right");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-rn-12">
        <thead>
          <tr className="border-b border-rn-line text-rn-muted">
            {head.map((h, i) => (
              <th key={i} className={cx("px-2 py-1.5 font-semibold whitespace-nowrap", al(i) === "left" ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-rn-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cx("px-2 py-1.5 tabular-nums", al(j) === "left" ? "text-left" : "text-right", j === 0 ? "font-semibold text-rn-ink" : "text-rn-ink-2")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Brand name with its 당사 / HMG 계열 badge. */
export function BrandName({ name, own, sibling, className }: { name: string; own?: boolean; sibling?: boolean; className?: string }) {
  const t = useTranslations("renewal.mention.board");
  return (
    <span className={cx("flex min-w-0 items-center gap-1.5", className)}>
      <b className={cx("truncate font-semibold", own ? "text-rn-navy" : "text-rn-ink")}>{name}</b>
      {own ? <RnTag>{t("own")}</RnTag> : sibling ? <RnTag className="bg-transparent text-rn-navy-500 shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{t("sibling")}</RnTag> : null}
    </span>
  );
}
