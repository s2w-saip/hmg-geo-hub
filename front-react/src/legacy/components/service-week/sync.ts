
import { browserFetch as fetch } from "~/api/browser-fetch";
import { isServiceWeekView, weekEndOf, type ServiceWeekView } from "@/lib/service-week";

// Keeps the shells' service week current (provider.tsx). A layout renders once and stays across soft navigations, so
// its read would outlive a cron advance. The provider reads the week again on a page or filter change and when the
// tab comes back; this decides what an answer does:
//   - a different end than the week the page body was read with -> the body re-reads (router.refresh), so the page
//     and the chip never name different weeks for long;
//   - the same end -> only the chip's view is updated (a later Gold check, the delay's day count);
//   - a failed read changes nothing (the chip keeps what the body was read with).
// The newest read wins: a read still in flight when the next one starts is aborted and its answer dropped.
// Each read carries the page's site picks (serviceWeekSites, "" = none): the screen's notes are those sites'. The
// layout's read has none, so a page with some reads them once that read is known (review r1-7, 2026-11-03).
// Every page held to the week reads it again then (review r1-16): the layout's read and the body's screens are separate
// requests, and the BFF serves its kept week at once while it reads the next one, so a page read as it moved on can
// hold two weeks. A body ahead of the layout's read shows as another end; a body behind it only the BFF can tell
// (justMoved: it moved to the layout's week moments before) — either way the body re-reads once for that week.
// A read again on a page change goes out while the new page renders and can reach the BFF before the page's screens:
// the BFF reads the week again before it answers the shell (back/bff/hub_stores/service_week.py fresh()), so the
// answer is the week those screens take — short of a week the HUB job records between the two — and a page read on a
// new week shows as another end (review r5-2).
// router.refresh() renders the page anew but keeps a client component's state: a body that keeps its server answer in
// state is keyed by that answer (lib/service-week-server.ts answerKey) or takes the new one (hooks/use-served-state.ts),
// or it stays on the week before (review r2-7). What the browser reads on top of the answer (a table's next rows, a
// sheet, a row's detail, a picked compare) is kept by the page's read, and a sheet opened over the answer closes with
// it (provider.tsx useServiceWeekRead, useServiceWeekReadState, review r3-4): not by the chip's week, which onView moves
// before the re-read lands — the tone tab counts keep the week their answer names for the same reason (review r3-5).

export interface ServiceWeekSyncDeps {
  /** reads the week with the page's site picks; rejects on any failure */
  load: (signal: AbortSignal, sites: string) => Promise<ServiceWeekView>;
  /** the newest view, for the chip and the notes, and the site picks its notes were read with */
  onView: (view: ServiceWeekView, sites: string) => void;
  /** re-reads the page body (router.refresh) */
  refresh: () => void;
}

export interface ServiceWeekSync {
  /**
   * The week the page body was read with (the layout's read, no site picks); null = that read failed, so there is
   * nothing to compare. On a page held to the week (`sites`: its site picks, "" = none) it reads the week again with
   * them, and re-reads the body once if the BFF had just moved to that week (justMoved). Without `sites` (a page the
   * BFF does not hold to the week) nothing is read.
   */
  adopt(view: ServiceWeekView | null, sites?: string): Promise<void>;
  /** Reads the week again, with the page's site picks. */
  check(sites?: string): Promise<void>;
  /** Drops a read in flight (unmount). */
  stop(): void;
}

export function createServiceWeekSync(deps: ServiceWeekSyncDeps): ServiceWeekSync {
  let known: ServiceWeekView | null = null;
  let inflight: AbortController | null = null;
  // the end the body was last re-read for: one re-read per move (the layout's read the re-read brings says justMoved too)
  let reread: string | null = null;
  const refresh = (end: string | null) => {
    reread = end;
    deps.refresh();
  };
  const check = async (sites = "") => {
    inflight?.abort();
    const ctl = new AbortController();
    inflight = ctl;
    let view: ServiceWeekView;
    try {
      view = await deps.load(ctl.signal, sites);
    } catch {
      if (inflight === ctl) inflight = null;
      return;
    }
    if (ctl.signal.aborted) return;
    inflight = null;
    const moved = known !== null && weekEndOf(known) !== weekEndOf(view);
    known = view;
    deps.onView(view, sites);
    if (moved) refresh(weekEndOf(view));
  };
  return {
    async adopt(view, sites) {
      known = view;
      if (sites === undefined) return;
      if (view?.justMoved && weekEndOf(view) !== reread) refresh(weekEndOf(view));
      await check(sites);
    },
    check,
    stop() {
      inflight?.abort();
      inflight = null;
    },
  };
}

/** GET /api/service-week (app/api/service-week/route.ts) with the page's site picks: the screen's answer, or a rejection. */
export async function fetchServiceWeek(signal: AbortSignal, sites = ""): Promise<ServiceWeekView> {
  const res = await fetch(sites ? `/api/service-week?${sites}` : "/api/service-week", { cache: "no-store", headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`service week: ${res.status}`);
  const body: unknown = await res.json();
  if (!isServiceWeekView(body)) throw new Error("service week: unexpected answer");
  return body;
}
