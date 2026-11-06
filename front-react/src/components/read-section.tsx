import { createContext, useContext, type ReactNode } from "react";
import { useLocale } from "use-intl";
import type { ReadControls } from "~/api/bundle";
import { RnButton, RnSkeleton } from "@/components/renewal-ui";

const Reads = createContext<ReadControls | null>(null);
export const ReadProvider = Reads.Provider;

/** Gate a copied UI section before it consumes its resolved promises. Query errors remain errors in the cache. */
export function ReadSection({ names, label, children, loading, quiet = false }: {
  names: readonly string[]; label: string; children: ReactNode; loading?: ReactNode; quiet?: boolean;
}) {
  const reads = useContext(Reads);
  const en = useLocale() === "en";
  if (!reads) return <>{children}</>;
  const states = names.map(name => {
    const state = reads.states[name];
    if (!state) throw new Error(`Missing section read: ${name}`);
    return state;
  });
  const failed = names.filter((_, i) => states[i].error);
  if (failed.length) {
    if (quiet) return null;
    const busy = states.some(state => state.refreshing);
    return <div role="alert" data-read-error={failed.join(" ")} className="flex items-center justify-between gap-4 rounded-lg border border-rn-line bg-rn-surface p-4 text-rn-13">
      <span>{en ? `Could not load ${label}.` : `${label} 데이터를 불러오지 못했습니다.`}</span>
      <RnButton disabled={busy} onClick={() => void reads.retry(failed)} aria-label={en ? `Retry ${label}` : `${label} 다시 조회`}>{en ? "Retry" : "다시 조회"}</RnButton>
    </div>;
  }
  if (states.some(state => state.pending)) return <div role="status" data-read-loading={names.join(" ")} aria-label={en ? `Loading ${label}` : `${label} 불러오는 중`}>{loading === undefined ? <RnSkeleton className="h-40 w-full" /> : loading}</div>;
  return <>{children}</>;
}
