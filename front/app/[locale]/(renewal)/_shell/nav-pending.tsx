"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "@/i18n/navigation";
import { cx } from "@/components/renewal-ui";

// Instant feedback for a menu click (2026-10-23).
// The sidebar links keep prefetch={false} (the 2026-08-27 production rule), so the next page
// needs a server round trip before anything on screen changes — measured 0.4–2.2s of nothing on
// the dev stack. A click now marks its target at once: the item turns active with a spinner,
// a progress bar runs over the content and (after 150ms) the old content dims, until the new
// page commits (the pathname changes). Back/forward and a 20s guard clear it too.

interface NavPending {
  /** locale-less path of the page being opened, null when idle */
  target: string | null;
  start: (path: string) => void;
}

const NavPendingContext = createContext<NavPending>({ target: null, start: () => {} });

export function useRnNavPending(): NavPending {
  return useContext(NavPendingContext);
}

export function RnNavPendingProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [target, setTarget] = useState<string | null>(null);
  const guard = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setTarget(null);
    if (guard.current) clearTimeout(guard.current);
  }, [pathname]);
  useEffect(() => {
    const clear = () => setTarget(null);
    window.addEventListener("popstate", clear);
    return () => {
      window.removeEventListener("popstate", clear);
      if (guard.current) clearTimeout(guard.current);
    };
  }, []);
  const start = useCallback(
    (path: string) => {
      if (path === pathname) return; // same page (a filter-carry link): no page swap to wait for
      setTarget(path);
      if (guard.current) clearTimeout(guard.current);
      guard.current = setTimeout(() => setTarget(null), 20000);
    },
    [pathname],
  );
  const value = useMemo(() => ({ target, start }), [target, start]);
  return <NavPendingContext.Provider value={value}>{children}</NavPendingContext.Provider>;
}

/** The shell's content area: progress bar + dim while a menu navigation is pending. */
export function RnNavMain({ children }: { children: ReactNode }) {
  const { target } = useRnNavPending();
  return (
    <main data-rn-nav-pending={target ? "" : undefined} aria-busy={target ? true : undefined} className="relative min-h-0 min-w-0 overflow-y-auto">
      {target ? (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-40 h-[3px] overflow-hidden bg-rn-navy-25">
          <span className="absolute inset-y-0 w-[35%] animate-rn-progress bg-rn-navy" />
        </div>
      ) : null}
      <div className={cx("transition-opacity", target ? "opacity-55 delay-150 duration-200" : "duration-100")}>{children}</div>
    </main>
  );
}
