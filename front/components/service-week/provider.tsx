"use client";

import { Suspense, createContext, use, useContext, useEffect, useMemo, useRef, useState, type Context, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { serviceWeekApplies, serviceWeekSites, serviceWeekSurface, weekEndOf, type ServiceWeekSurface, type ServiceWeekView } from "@/lib/service-week";
import { createServiceWeekSync, fetchServiceWeek } from "./sync";

// The service week in the shells (renewal and (dash) layouts, 2026-11-02). The layout starts the read
// (lib/service-week-server.ts) and hands its promise here without waiting, so no page waits on the week: the chip and
// the notes read it inside their own Suspense, and the date pickers take its end once it is known in this tab — what a
// page prints of its period takes the layout's read before then, in a Suspense of its own (ServiceWeekShownEnd, review r3-6).
// Layouts keep their first render across soft navigations, so the week is read again (GET /api/service-week) on a page
// or filter change — the body re-reads then too — and when the tab comes back; a different end re-reads the body
// (sync.ts). It is read again once the layout's read is known as well: that read and the body's screens are separate
// requests, and the BFF may move on between them (review r1-16). A page the BFF does not hold to the week (Project,
// the GA4 pages, Admin pages of no Gold round: serviceWeekApplies) shows none of it, its pickers keep their own end,
// and nothing is read again there.
// The renewal shell shows the site notes (`notes`): its reads carry the page's site picks, and a layout read (which
// has none) is followed by one with the page's (review r1-7, 2026-11-03: the notes are the page's sites).
// It also counts the page's reads (`read`): the layout renders anew only when the page is read again (router.refresh,
// the week having moved), and the body takes its new answer in the same render — what the browser read on top of the
// answer before is read again for it (useServiceWeekRead, review r3-4).

export interface ServiceWeekContextValue {
  /** the layout's read, settled by the time the page streams in; never rejects (null = the read failed) */
  initial: Promise<ServiceWeekView | null>;
  /** the newest view this tab has — the layout's read once settled, then each read again; undefined until then */
  latest: ServiceWeekView | null | undefined;
  /** false on a page the BFF does not hold to the week (serviceWeekApplies: Project, GA4 days, Admin pages and tabs of no Gold round) */
  applies: boolean;
  /** the Gold surface the page shows (its period notes), null for pages without one */
  surface: ServiceWeekSurface | null;
  /** the page's site picks its notes are read with (serviceWeekSites); "" or absent = none */
  sites?: string;
  /** the site picks the notes of `latest` were read with ("" or absent = none, as the layout's read) */
  notesFor?: string;
  /** how many times the page was read again since the shell mounted (useServiceWeekRead); absent = 0 */
  read?: number;
}

let context: Context<ServiceWeekContextValue | null> | undefined;

/**
 * The shell's service week context (tests hand it a value without the provider's reads). Created on first use, not
 * when the module loads: tests that run (dash) pages under the react-server React (lib/hgh/adapters/*.parity.test.ts)
 * load this client module as a plain one, and that build has no createContext.
 */
export function serviceWeekContext(): Context<ServiceWeekContextValue | null> {
  return (context ??= createContext<ServiceWeekContextValue | null>(null));
}

export function RnServiceWeekProvider({
  week,
  notes = false,
  children,
}: {
  week: Promise<ServiceWeekView | null>;
  /** the shell shows the site notes (the renewal one): the week is read with the page's site picks */
  notes?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const router = useRouter();
  // the page's view counts too: 인용 출처 분류's 코드표 tab reads no Gold round (review r3-9)
  const applies = serviceWeekApplies(pathname, params);
  const surface = serviceWeekSurface(pathname);
  const sites = notes && applies ? serviceWeekSites(surface, params) : "";
  const [latest, setLatest] = useState<ServiceWeekView | null | undefined>(undefined);
  const [notesFor, setNotesFor] = useState("");
  // the page's read: one more for each layout render of a new `week` (router.refresh), taken during that render
  const [reads, setReads] = useState({ week, n: 0 });
  if (reads.week !== week) setReads({ week, n: reads.n + 1 });
  const read = reads.week !== week ? reads.n + 1 : reads.n;
  const routerRef = useRef(router);
  const appliesRef = useRef(applies);
  const sitesRef = useRef(sites);
  useEffect(() => {
    routerRef.current = router;
    appliesRef.current = applies;
    sitesRef.current = sites;
  }, [router, applies, sites]);
  const [sync] = useState(() =>
    createServiceWeekSync({
      load: fetchServiceWeek,
      onView: (view, picks) => {
        setLatest(view);
        setNotesFor(picks);
      },
      refresh: () => routerRef.current.refresh(),
      moved: notes ? () => window.location.reload() : undefined,
    }),
  );

  // The week the body was read with: the layout's read, again when a refresh renders the layout anew. On a page held to
  // the week it is read again next (sync.adopt), with the page's site picks — the layout's read has none.
  useEffect(() => {
    let live = true;
    week.then(
      (view) => {
        if (!live) return;
        setLatest(view);
        setNotesFor("");
        void sync.adopt(view, appliesRef.current ? sitesRef.current : undefined);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [week, sync]);

  // Read again on a page or filter change (not on the first render: adopting the layout's read reads it).
  const shown = useRef(`${pathname}?${search}`);
  useEffect(() => {
    const at = `${pathname}?${search}`;
    if (at === shown.current) return;
    shown.current = at;
    if (applies) void sync.check(sites);
  }, [pathname, search, applies, sites, sync]);

  // ...and when the tab comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && appliesRef.current) void sync.check(sitesRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      sync.stop();
    };
  }, [sync]);

  const value = useMemo(
    () => ({ initial: week, latest, applies, surface, sites, notesFor, read }),
    [week, latest, applies, surface, sites, notesFor, read],
  );
  const Ctx = serviceWeekContext();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The shell's service week when the page is held to it; null without the provider (a page rendered on its own) and on a page that is not. */
export function useServiceWeekContext(): ServiceWeekContextValue | null {
  const ctx = useContext(serviceWeekContext());
  return ctx?.applies ? ctx : null;
}

/** The view to show: the newest this tab has, else the layout's read — suspends until that settles, so call it inside a Suspense. */
export function useServiceWeekView(ctx: ServiceWeekContextValue): ServiceWeekView | null {
  return ctx.latest !== undefined ? ctx.latest : use(ctx.initial);
}

/**
 * The last day the screens show, for the date pickers (presets, date inputs). Never suspends: null
 * until the week is known in this tab (the server render and the first browser render), without the provider, without
 * a week and on a page not held to the week (a GA4 page's pickers end at GA4's own latest day) — they then work as before.
 * What a page prints of its period takes ServiceWeekShownEnd.
 */
export function useServiceWeekEnd(): string | null {
  const ctx = useContext(serviceWeekContext());
  return ctx?.applies ? weekEndOf(ctx.latest) : null;
}

/**
 * The last day the screens show, for what a page prints of its period (the applied chip, a 기간 summary, 직접 선택, a
 * lens line) and the pickers printed beside it: useServiceWeekEnd's day, and before this tab knows the week (the server
 * render and the first browser render) the layout's read. With useServiceWeekEnd's null there they printed the URL's
 * end while the page header beside them, the screen's own answer, named the week's (review r3-6, 2026-11-03). Suspends
 * until the layout's read settles (it streams in with the page): call it inside a Suspense — ServiceWeekShownEnd.
 */
export function useServiceWeekShownEnd(): string | null {
  const ctx = useContext(serviceWeekContext());
  if (!ctx?.applies) return null;
  return weekEndOf(ctx.latest !== undefined ? ctx.latest : use(ctx.initial));
}

/**
 * `children` with useServiceWeekShownEnd's day, in a Suspense of their own: until the layout's read is known they render
 * with none (the period as picked — what useServiceWeekEnd gives then), and nothing around them waits on the week.
 * `children` only builds elements (it runs for the fallback too): what needs hooks is a component it renders.
 */
export function ServiceWeekShownEnd({ children }: { children: (end: string | null) => ReactNode }) {
  return (
    <Suspense fallback={children(null)}>
      <ShownEnd>{children}</ShownEnd>
    </Suspense>
  );
}

function ShownEnd({ children }: { children: (end: string | null) => ReactNode }) {
  return children(useServiceWeekShownEnd());
}

/**
 * Which read of the page the body shows: one more each time the shell's layout renders anew — router.refresh, the
 * week having moved (sync.ts) — which renders the body with its new answer in the same pass. A read the browser keeps
 * on top of the page's answer (a table's next rows and searches, a 분포 sheet, a row's detail, a picked brand's
 * compare) keys what it keeps by it, so the new answer has them read again rather than the week before's shown beside
 * it (review r3-4). Not the chip's week (useServiceWeekEnd): that moves before the new answer lands. null without the
 * provider and on a page not held to the week: their reads are kept as before.
 */
export function useServiceWeekRead(): number | null {
  const ctx = useContext(serviceWeekContext());
  return ctx?.applies ? (ctx.read ?? 0) : null;
}

/**
 * useState of a sheet a page opens over its answer (the row or the brand it shows): `initial` (closed) again once the
 * page is read again (useServiceWeekRead) — its numbers and its own reads were the answer before (review r3-4). Taken
 * during the render, so the sheet is not drawn over the new answer. As useState without the provider and on a page
 * not held to the week.
 */
export function useServiceWeekReadState<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
  const read = useServiceWeekRead();
  const [state, setState] = useState(initial);
  const [seen, setSeen] = useState(read);
  if (seen !== read) {
    setSeen(read);
    setState(initial);
  }
  return [seen !== read ? initial : state, setState];
}
