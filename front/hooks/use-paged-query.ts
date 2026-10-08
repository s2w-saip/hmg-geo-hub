"use client";

import { useEffect, useRef, useState } from "react";

/** Late replies and unmounted reads never replace a newer view. Failures reach the page error boundary. */
export function usePagedQuery<T, Q>(initial: T | undefined, load: ((query: Q) => Promise<T>) | undefined, query: Q, reloadInitial = false) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const first = useRef(true);
  const key = JSON.stringify(query);
  useEffect(() => {
    if (!load) return;
    if (first.current) { first.current = false; if (!reloadInitial) return; }
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      load(JSON.parse(key)).then(result => { if (active) { setData(result); setError(null); } })
        .catch(cause => { if (active) setError(cause instanceof Error ? cause : new Error("Page read failed")); })
        .finally(() => { if (active) setLoading(false); });
    }, 80);
    return () => { active = false; clearTimeout(timer); };
  }, [key, load, initial, reloadInitial]);
  return { data, error, loading };
}
