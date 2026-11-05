"use client";

import { Suspense, use } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Info, TriangleAlert } from "lucide-react";
// the primitive's own file, not the renewal-ui index (see chip.tsx)
import { RnNote } from "@/components/renewal-ui/card";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import {
  formatKstMinute,
  notesInPeriod,
  type ServiceWeekNote,
  type ServiceWeekPagePeriod,
  type ServiceWeekRange,
  type ServiceWeekSurface,
  type ServiceWeekView,
} from "@/lib/service-week";
import { useWeekText } from "./chip";
import { useServiceWeekContext, useServiceWeekView, type ServiceWeekContextValue } from "./provider";

// The service week's notes in the content (2026-11-02; the design rules' 보조 tier: 기준 설명 · 데이터 지연 안내):
//   - the delay note, first in the content column, while the next week is late (the BFF decides: more than 10 days
//     after the week ended). Gold's last check is on it: an old one tells a stopped cron from a late Gold. So it says
//     what that check found — the next week not yet confirmed complete — not Gold's state now: a stopped check keeps
//     the week, and the note, past a week Gold may have completed since (review r1-20, 2026-11-03; the chip's title too).
//     It names the delay as the chip does, '발행 지연' — Gold's publication, not '반영', the Admin's word for a HUB input
//     Gold has taken in (반영됨 / 반영 대기, review r3-10) — and what is held to the week: Gold's results, not the HUB
//     lists a page sets beside them (Global prompts' 변경 이력, the edits of 교정 · 시드 · 공식 소셜, review r3-9).
//   - a note for each week the page's period meets (the page's own, else the URL `time`, else the service week
//     itself) in which Gold left sites of the page's surface out: not published, or hidden by an administrator.
//     Gold's counts, as they are, of the page's sites: only from a read made with the page's site picks (the layout's
//     read has none — a Website page with a brand, a geography, a language or an engine shows its notes once the shell
//     has read them, review r1-7 · r5-1, 2026-11-03). A page that shows every round with no `time` names that period
//     itself (review r1-13). A period meets a week when it holds one of the note's round days, not just a day of the
//     week (review r2-10).
// Neither renders without the shell's provider or on a page not held to the week (serviceWeekApplies), and neither
// uses the helper-copy classes that .rn-dense hides.

/** A page's own period for the notes (ServiceWeekPagePeriod), or the page's read of it. */
export type ServiceWeekNotesPeriod = ServiceWeekPagePeriod | PromiseLike<ServiceWeekPagePeriod>;

/**
 * Renewal: heads the dense content column (RnPageFrame / RnFilterSplit). `period`: the page's own period for the
 * notes; absent, the URL `time`, else the service week (a snapshot page).
 */
/** `delay={false}`: the page shows the delay in its header chip instead (Global Mention, 2026-11-05 개편). */
export function RnServiceWeekNotices({ period, delay: showDelay = true }: { period?: ServiceWeekNotesPeriod; delay?: boolean }) {
  const ctx = useServiceWeekContext();
  if (!ctx) return null;
  return (
    <Suspense fallback={null}>
      <RnNotices ctx={ctx} period={period} showDelay={showDelay} />
    </Suspense>
  );
}

function RnNotices({ ctx, period, showDelay }: { ctx: ServiceWeekContextValue; period?: ServiceWeekNotesPeriod; showDelay: boolean }) {
  const view = useServiceWeekView(ctx);
  const sp = useSearchParams();
  const delay = useDelayText(view);
  // the site picks the shown view's notes were read with: the layout's read (before `latest`) has none
  const readFor = ctx.latest !== undefined ? (ctx.notesFor ?? "") : "";
  const noted = view && readFor === (ctx.sites ?? "") ? (view.notes ?? []) : [];
  return (
    <>
      {delay && showDelay ? (
        <RnNote>
          <TriangleAlert className="size-3.5 shrink-0 text-rn-warn-ink" aria-hidden />
          <span data-rn-service-week-delay="">{delay.text}</span>
          {delay.checked ? <span className="text-rn-muted tabular-nums">{delay.checked}</span> : null}
        </RnNote>
      ) : null}
      {!noted.length || !view ? null : period === undefined ? (
        <NotesNote notes={notesInPeriod(noted, ctx.surface, parseTimeRange(sp?.get("time")), view.week)} />
      ) : (
        // the page's read of its period: the delay note above does not wait for it
        <Suspense fallback={null}>
          <PageNotes notes={noted} surface={ctx.surface} period={period} week={view.week} />
        </Suspense>
      )}
    </>
  );
}

const isThenable = (v: unknown): v is PromiseLike<ServiceWeekPagePeriod> => typeof (v as PromiseLike<unknown> | null)?.then === "function";

function PageNotes({ notes, surface, period, week }: { notes: ServiceWeekNote[]; surface: ServiceWeekSurface | null; period: ServiceWeekNotesPeriod; week: ServiceWeekRange | null }) {
  const range = isThenable(period) ? use(period) : period;
  return range ? <NotesNote notes={notesInPeriod(notes, surface, range, week)} /> : null;
}

function NotesNote({ notes }: { notes: ServiceWeekNote[] }) {
  if (!notes.length) return null;
  return (
    <RnNote>
      <Info className="size-3.5 shrink-0 text-rn-muted" aria-hidden />
      <span data-rn-service-week-notes="" className="flex min-w-0 flex-col gap-0.5">
        <NoteLines notes={notes} />
      </span>
    </RnNote>
  );
}

function NoteLines({ notes }: { notes: ServiceWeekNote[] }) {
  const t = useTranslations("serviceWeek");
  const week = useWeekText();
  return notes.map((n) => {
    const at = { surface: t(`surface.${n.surface}`), week: week.label(n.week) };
    const line =
      n.unpublished > 0 && n.hidden > 0
        ? t("noteBoth", { ...at, unpublished: n.unpublished, hidden: n.hidden })
        : n.unpublished > 0
          ? t("noteUnpublished", { ...at, count: n.unpublished })
          : t("noteHidden", { ...at, count: n.hidden });
    return <span key={`${n.surface}:${n.week.start}`}>{line}</span>;
  });
}

/** The delay sentence and Gold's last check, null while the next week is on time (or there is no week). */
export function useDelayText(view: ServiceWeekView | null): { text: string; checked: string | null } | null {
  const t = useTranslations("serviceWeek");
  const week = useWeekText();
  if (!view?.week || !view.delay) return null;
  return {
    text: t("delayNote", { next: week.withRange(view.delay.next), week: week.withRange(view.week) }),
    checked: view.checkedAt ? t("checkedAt", { time: formatKstMinute(view.checkedAt) }) : null,
  };
}

/** Original (dash): the delay note at the top of main, above the page (not sticky: the (dash) chrome offsets are fixed). */
export function ServiceWeekDelayNotice() {
  const ctx = useServiceWeekContext();
  if (!ctx) return null;
  return (
    <Suspense fallback={null}>
      <DashDelay ctx={ctx} />
    </Suspense>
  );
}

function DashDelay({ ctx }: { ctx: ServiceWeekContextValue }) {
  const delay = useDelayText(useServiceWeekView(ctx));
  if (!delay) return null;
  return (
    <div role="note" data-rn-service-week-delay="" className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground">
      <TriangleAlert className="h-4 w-4 shrink-0 text-accent-gold" aria-hidden />
      <span>{delay.text}</span>
      {delay.checked ? <span className="text-muted-foreground tabular-nums">{delay.checked}</span> : null}
    </div>
  );
}
