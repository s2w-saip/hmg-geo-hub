"use client";

import { Suspense, useMemo } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CalendarDays, TriangleAlert } from "lucide-react";
// the primitives' own files, not the renewal-ui index: page-header.tsx (in that index) renders this chip
import { RnPill } from "@/components/renewal-ui/chip";
import { monthDay, type ServiceWeekRange, type ServiceWeekView } from "@/lib/service-week";
import { useServiceWeekContext, useServiceWeekView, type ServiceWeekContextValue } from "./provider";
import { useDelayText } from "./notes";

// The service-week chip (2026-11-02): the week the page's Gold rounds are held to, at the end of the page header's
// meta row (the design rules' 기준 칩 slot) — "10월 2주차 · 10/5~10/11". A late next week adds a warning and the days
// since the week ended; no week store (unconfigured) and a failed read say so. The pages keep their own basis pills
// (측정 회차 …): those name the surface's round, this the week the service shows. Nothing renders without the shell's
// provider or on a page the BFF does not hold to the week (serviceWeekApplies: Project, GA4 days, Admin pages of no
// Gold round — review r1-12, 2026-11-03: the GA4 pages carried it over days past the week).

type ChipKind = "ok" | "late" | "unconfigured" | "unreadable";
interface ChipModel {
  kind: ChipKind;
  /** "10월 2주차", or the state's text when there is no week */
  label: string;
  range: string | null;
  late: string | null;
  title: string;
}

/** The week's name and days in this locale (the BFF names it: month of its Thursday, nth week of that month). */
export function useWeekText() {
  const t = useTranslations("serviceWeek");
  const locale = useLocale();
  const monthName = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }), [locale]);
  return useMemo(() => {
    const names = (w: ServiceWeekRange) => ({ month: w.month, nth: w.nth, monthName: monthName.format(Date.UTC(2026, w.month - 1, 1)) });
    return {
      label: (w: ServiceWeekRange) => t("week", names(w)),
      range: (w: ServiceWeekRange) => t("range", { from: monthDay(w.start), to: monthDay(w.end) }),
      withRange: (w: ServiceWeekRange) => t("weekWithRange", { ...names(w), from: monthDay(w.start), to: monthDay(w.end) }),
    };
  }, [monthName, t]);
}

function useChipModel(view: ServiceWeekView | null): ChipModel {
  const t = useTranslations("serviceWeek");
  const week = useWeekText();
  if (!view) return { kind: "unreadable", label: t("unreadable"), range: null, late: null, title: t("unreadableTitle") };
  if (!view.week) return { kind: "unconfigured", label: t("unconfigured"), range: null, late: null, title: t("unconfiguredTitle") };
  const late = view.delay;
  return {
    kind: late ? "late" : "ok",
    label: week.label(view.week),
    range: week.range(view.week),
    late: late ? t("late", { days: late.days }) : null,
    title: late ? `${t("title")} ${t("lateTitle", { days: late.days })}` : t("title"),
  };
}


/** Renewal page header (RnPageHeader). `row`: the meta line's class, for a header without one (the chip on its own line). */
/** `withDelay`: the pill's title and screen-reader text also carry the delay sentence (the page shows no delay note; Global Mention). */
export function RnServiceWeekChip({ row, withDelay = false }: { row?: string; withDelay?: boolean }) {
  const ctx = useServiceWeekContext();
  if (!ctx) return null;
  const chip = (
    <Suspense fallback={<span data-rn-service-week="loading" aria-hidden className="block h-[26px] w-[150px] animate-pulse rounded-full bg-rn-inset" />}>
      <RnChip ctx={ctx} withDelay={withDelay} />
    </Suspense>
  );
  return row ? <div className={row}>{chip}</div> : chip;
}

function RnChip({ ctx, withDelay }: { ctx: ServiceWeekContextValue; withDelay: boolean }) {
  const view = useServiceWeekView(ctx);
  const m = useChipModel(view);
  const delay = useDelayText(view);
  const title = withDelay && delay ? [m.title, delay.text, delay.checked].filter(Boolean).join("\n") : m.title;
  return (
    <span data-rn-service-week={m.kind} className="contents">
      <RnPill title={title}>
        <CalendarDays className="size-3 text-rn-muted" aria-hidden />
        {/* no week (unconfigured, a failed read): the state in muted text */}
        <span className={m.range ? "font-semibold text-rn-ink-2" : "text-rn-muted"}>{m.label}</span>
        {m.range ? <> · <span className="tabular-nums">{m.range}</span></> : null}
        {m.late ? (
          <>
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <TriangleAlert className="size-3 text-rn-warn-ink" aria-hidden />
            <span className="font-semibold text-rn-ink-2 tabular-nums">{m.late}</span>
          </>
        ) : null}
        <span className="sr-only">{title}</span>
      </RnPill>
    </span>
  );
}

/** Original (dash) page header (components/page-header.tsx), in its pill look (AsOfChip). */
export function ServiceWeekChip() {
  const ctx = useServiceWeekContext();
  if (!ctx) return null;
  return (
    <Suspense fallback={<span data-rn-service-week="loading" aria-hidden className="inline-flex h-[26px] w-40 shrink-0 animate-pulse rounded-full border border-border bg-muted/40" />}>
      <DashChip ctx={ctx} />
    </Suspense>
  );
}

function DashChip({ ctx }: { ctx: ServiceWeekContextValue }) {
  const m = useChipModel(useServiceWeekView(ctx));
  return (
    <span
      data-rn-service-week={m.kind}
      title={m.title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
    >
      <CalendarDays className="h-3 w-3" aria-hidden />
      <span className={m.range ? "font-semibold text-foreground" : undefined}>{m.label}</span>
      {m.range ? <> · <span className="tabular-nums">{m.range}</span></> : null}
      {m.late ? (
        <>
          <span aria-hidden className="h-3 w-px bg-border" />
          <TriangleAlert className="h-3 w-3 text-accent-gold" aria-hidden />
          <span className="font-semibold text-foreground tabular-nums">{m.late}</span>
        </>
      ) : null}
      <span className="sr-only">{m.title}</span>
    </span>
  );
}
