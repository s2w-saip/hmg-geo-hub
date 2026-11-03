"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CalendarX2 } from "lucide-react";
import { parseTimeRange, type TimeRangeValue } from "@/components/dash/filter-encoding";
import { noRoundWeek, periodAfterWeek, serviceWeekPeriodPage, serviceWeekSnapshotPage, type ServiceWeekSurface } from "@/lib/service-week";
import { useWeekText } from "./chip";
import { useServiceWeekContext, useServiceWeekView, type ServiceWeekContextValue } from "./provider";

// A surface with no round in the service week (decision '기준 주 세부', 2026-11-02): it does not hold the week back, and
// its '측정 없음' is shown as it is. The BFF reads no snapshot of that surface then (gold_reader/context.py), so a page
// that reads one comes back empty — and said so as an empty filter result ('필터를 줄이거나 초기화해 보세요', with a
// reset that cannot bring a round back), as '측정 데이터가 아직 없습니다', or as a measured page of zeros (review r1-19,
// 2026-11-03). Where a page's read came back empty, its empty state names the week instead when the shell's week holds
// no round of the page's surface (shared/service-week `rounds`: Gold's round calendar as the reads take it) and the
// page reads the snapshot. A period (`time` in the URL) reads its own rounds up to the week: its empty state stays the
// period's, whose reset does bring rounds back — but for a period that starts after the week, of which the BFF reads no
// round on either surface (a `from` after the week's end): that page blamed its filters or drew zeros under a
// source-filter headline, so it names the week too, and says nothing of rounds or filters (review r3-12). A page whose
// period is a lens over rows it keeps (Website Prompts) takes the week's text for what it draws of that lens, its rows
// staying (review r4-4). Nothing is counted or decided here — the empty read is the page's, the absence of a round
// Gold's, the week the HUB job's — and a read that holds data is never replaced.

/** The text of an empty read the service week explains: the '측정 없음' of a week with no round of the page's surface, or a period after the week. */
export interface ServiceWeekNoRoundText {
  title: string;
  desc: string;
}

type Render = (text: ServiceWeekNoRoundText) => ReactNode;

/**
 * A page's empty branch: its own state (`children`), or `render` of the week's text — on a snapshot page whose surface
 * the service week holds no round of, or on a period that starts after the week. Render it only where the page's read
 * came back empty: it waits for the shell's read of the week (the page's Suspense shows meanwhile). Without the shell's
 * provider, on a page the week does not hold and on a period with no start (it reads up to the week) it is `children`
 * at once.
 */
export function RnServiceWeekEmpty({ render, children }: { render: Render; children: ReactNode }) {
  const ctx = useServiceWeekContext();
  const sp = useSearchParams();
  const period = parseTimeRange(sp?.get("time"));
  if (!ctx?.surface || (period && !period.from)) return children;
  return (
    <WeekText ctx={ctx} surface={ctx.surface} period={period} render={render}>
      {children}
    </WeekText>
  );
}

/** `render` of the week's text for the page's read — no period: no round of `surface` in the week; a period: one after the week — else `children`. */
function WeekText({ ctx, surface, period, render, children }: { ctx: ServiceWeekContextValue; surface: ServiceWeekSurface; period: TimeRangeValue | null; render: Render; children: ReactNode }) {
  const t = useTranslations("serviceWeek");
  const week = useWeekText();
  const view = useServiceWeekView(ctx);
  if (period) {
    const at = periodAfterWeek(view, period);
    return at ? render({ title: t("afterWeek.title"), desc: t("afterWeek.desc", { from: period.from ?? "…", to: period.to ?? "…", week: week.withRange(at) }) }) : children;
  }
  const at = noRoundWeek(view, surface);
  return at ? render({ title: t("noRound.title"), desc: t("noRound.desc", { week: week.withRange(at), surface: t(`surface.${surface}`) }) }) : children;
}

/**
 * `children` with the week's text when the URL's period starts after the service week, else with null — for a page
 * whose period is a lens over rows it keeps (Website Prompts: the period chooses the answers a row counts, never the
 * rows). The lens of such a period holds no round, and the page said '엔진 없음 (미측정)' over an empty 회차별 chart and
 * '측정 없음' on every row, of prompts Gold measured after the week (review r4-4, 2026-11-03): what it draws of the lens
 * takes the week's text then. With no period it shows every round, so the '측정 없음' of a week with no round is not its
 * to say (review r3-11). In a Suspense of its own, as ServiceWeekShownEnd: until the shell's read of the week is known
 * it renders with null (the page as before), and nothing around it waits. `children` only builds elements (it runs for
 * the fallback too).
 */
export function ServiceWeekAfterWeek({ children }: { children: (text: ServiceWeekNoRoundText | null) => ReactNode }) {
  const ctx = useServiceWeekContext();
  const sp = useSearchParams();
  const period = parseTimeRange(sp?.get("time"));
  if (!ctx?.surface || !period?.from) return children(null);
  return (
    <Suspense fallback={children(null)}>
      <WeekText ctx={ctx} surface={ctx.surface} period={period} render={children}>
        {children(null)}
      </WeekText>
    </Suspense>
  );
}

/** A server page's empty notice (Overview · Website Overview: the line in RnEmpty), or the week's line in its place. */
export function RnServiceWeekEmptyLine({ children }: { children: ReactNode }) {
  return (
    <RnServiceWeekEmpty
      render={(n) => (
        <>
          <b className="font-semibold text-rn-ink-2">{n.title}</b> — {n.desc}
        </>
      )}
    >
      {children}
    </RnServiceWeekEmpty>
  );
}

/**
 * Original (dash): the '측정 없음' of a service week with no round of the page's surface, at the top of main below the
 * delay note, on a page read with no period (review r2-12) — or the week's line for a period that starts after the
 * week (review r3-12). The original screens keep their own empty states, and the reads of no round still answer counts
 * of 0, so Website 언급 · 인용 draw a measured page of zeros under a week like 07-27's (mention/view, citation/website in
 * process on live Gold, 2026-11-03): the note says what the page cannot. Only on a page whose read is that snapshot (or
 * the period's rounds): the '측정 없음' not on Prompts, which read every round with no period (serviceWeekSnapshotPage,
 * review r3-11); a period after the week on every page that reads the period, Website Prompts' lens among them — its
 * rows said '측정 없음' of prompts Gold measured after the week (serviceWeekPeriodPage, review r4-4) —, not on Global
 * Prompts, which reads none; nothing on a page the week does not hold (Project, GA4 days, Admin).
 */
export function ServiceWeekNoRoundNotice() {
  const ctx = useServiceWeekContext();
  const pathname = usePathname() ?? "";
  if (!ctx?.surface || !serviceWeekPeriodPage(pathname)) return null;
  return (
    <Suspense fallback={null}>
      <DashNoRound ctx={ctx} surface={ctx.surface} snapshot={serviceWeekSnapshotPage(pathname)} />
    </Suspense>
  );
}

/** `snapshot`: the page reads its surface's snapshot with no period (its '측정 없음' is the week's to say). */
function DashNoRound({ ctx, surface, snapshot }: { ctx: ServiceWeekContextValue; surface: ServiceWeekSurface; snapshot: boolean }) {
  const sp = useSearchParams();
  const period = parseTimeRange(sp?.get("time"));
  return (period ? !period.from : !snapshot) ? null : (
    <WeekText
      ctx={ctx}
      surface={surface}
      period={period}
      render={(n) => (
        <div role="note" data-rn-service-week-no-round="" className="mb-6 flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground">
          <CalendarX2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <b className="font-semibold">{n.title}</b> — {n.desc}
          </span>
        </div>
      )}
    >
      {null}
    </WeekText>
  );
}
