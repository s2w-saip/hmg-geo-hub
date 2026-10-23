"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { RnToastProvider } from "@/components/renewal-ui";

// Instant-apply runtime of the renewal pages. A pick updates the panel in the same
// frame (the panel keeps its own optimistic draft); the URL follows after a short
// debounce so a burst of clicks is ONE navigation (one server round trip), and the
// navigation runs in a transition so the current numbers stay on screen with a
// progress line until the new ones arrive. Next's router drops superseded
// transitions, so a late response never overwrites a newer pick.
const COMMIT_DEBOUNCE_MS = 120;

interface Runtime {
  /** True from the first pick until the new page data has rendered. */
  busy: boolean;
  /** Queue the URL query (without `?`). `immediate` skips the debounce. */
  commit: (qs: string, opts?: { immediate?: boolean }) => void;
}

const RuntimeContext = createContext<Runtime>({ busy: false, commit: () => {} });

export function RnFilterRuntime({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [queued, setQueued] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const go = useCallback(
    (qs: string) => {
      setQueued(false);
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [pathname, router],
  );
  const commit = useCallback<Runtime["commit"]>(
    (qs, opts) => {
      if (timer.current) clearTimeout(timer.current);
      if (opts?.immediate) {
        go(qs);
        return;
      }
      setQueued(true);
      timer.current = setTimeout(() => go(qs), COMMIT_DEBOUNCE_MS);
    },
    [go],
  );
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const value = useMemo(() => ({ busy: isPending || queued, commit }), [isPending, queued, commit]);
  return (
    <RuntimeContext.Provider value={value}>
      <RnToastProvider>{children}</RnToastProvider>
    </RuntimeContext.Provider>
  );
}

export function useRnFilterRuntime(): Runtime {
  return useContext(RuntimeContext);
}

/**
 * Wraps server-rendered content. While a pick is being applied it sets
 * `data-rn-busy` (cards show their progress line through the group variant) and
 * aria-busy, without replacing the content.
 */
export function RnBusyScope({ children, className }: { children: ReactNode; className?: string }) {
  const { busy } = useRnFilterRuntime();
  return (
    <div data-rn-busy={busy ? "" : undefined} aria-busy={busy || undefined} className={["group/rnbusy", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
