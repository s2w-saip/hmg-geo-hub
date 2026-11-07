import { useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useSession } from "~/app/session";
import { hub, queryString, screen, type Query } from "./client";
import { isHghApiError } from "@/lib/hgh/errors";
import { isTransientScreenError } from "@/app/[locale]/(dash)/dashboard/_data/screen-fallbacks";
import { CONNECTED } from "./client";

/**
 * `optional`: a failed read answers null. `deferred`: the page does not wait for it, its section does.
 * `fallback`: what a transient failure (5xx, timeout, network) answers instead of an error, as the Next page's onTransient; any other failure stays an error.
 */
export interface Read { name: string; query?: Query; kind?: "screen" | "hub"; optional?: boolean; deferred?: boolean; fallback?: unknown }
export interface ReadState { pending: boolean; refreshing: boolean; error: Error | null }
export interface ReadControls { states: Record<string, ReadState>; retry: (names?: readonly string[]) => Promise<void> }
const absorbed = (read: Read, error: Error | null) => read.fallback !== undefined && !!error && isTransientScreenError(error);
function blocks(read: Read, error: Error | null) {
  if (!error || absorbed(read, error)) return false;
  if (isHghApiError(error) && [401, 403].includes(error.status)) return true;
  if (read.optional) return false;
  // Only transient transport failures stay within a deferred section. Other failures deny the page.
  return !(read.deferred && isHghApiError(error) && error.status >= 500);
}
/** Scope is part of every browser cache key. Every backend response still enforces its own scope. */
export function useBundle(reads: Record<string, Read>) {
  const { user } = useSession();
  const client = useQueryClient();
  const identity = JSON.stringify([user?.id, user?.role, user?.scope]);
  const entries = Object.entries(reads);
  const resource = JSON.stringify([identity, entries.map(([name, read]) => [name, read.kind, read.name])]);
  const key = JSON.stringify([identity, entries.map(([name, read]) => [name, read.kind, read.name, queryString(read.query)])]);
  const retry = useCallback(async (names?: readonly string[]) => {
    await Promise.all(entries.filter(([name]) => !names || names.includes(name)).map(([, read]) => client.refetchQueries({
      queryKey: [read.kind ?? "screen", identity, read.name, queryString(read.query)], exact: true,
    })));
  }, [client, key]);
  const result = useQueries({ queries: entries.map(([, read]) => ({
    queryKey: [read.kind ?? "screen", identity, read.name, queryString(read.query)],
    queryFn: ({ signal }: { signal: AbortSignal }) => (read.kind === "hub" ? hub : screen)<unknown>(read.name, read.query ?? {}, signal),
    enabled: CONNECTED && !!user,
  })), combine: queries => ({
    // combine structurally shares unchanged responses, keeping React's consumed promises stable.
    data: Object.fromEntries(entries.map(([name, read], i) => [name, absorbed(read, queries[i].error) ? read.fallback : read.optional && queries[i].error ? null : queries[i].data])),
    states: Object.fromEntries(entries.map(([name, read], i) => [name, { pending: queries[i].isPending, refreshing: queries[i].isFetching, error: absorbed(read, queries[i].error) ? null : queries[i].error }])),
    error: queries.find((q, i) => blocks(entries[i][1], q.error))?.error ?? null,
    pending: queries.some((q, i) => q.isPending && !entries[i][1].optional && !entries[i][1].deferred),
    refreshing: queries.some(q => q.isFetching),
  }) });
  return { ...result, retry, key, resource };
}
