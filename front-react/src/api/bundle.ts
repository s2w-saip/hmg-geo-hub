import { useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useSession } from "~/app/session";
import { hub, queryString, screen, type Query } from "./client";
import { isHghApiError } from "@/lib/hgh/errors";
import { CONNECTED } from "./client";

export interface Read { name: string; query?: Query; kind?: "screen" | "hub"; optional?: boolean; deferred?: boolean }
export interface ReadState { pending: boolean; refreshing: boolean; error: Error | null }
export interface ReadControls { states: Record<string, ReadState>; retry: (names?: readonly string[]) => Promise<void> }
function blocks(read: Read, error: Error | null) {
  if (!error) return false;
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
    data: Object.fromEntries(entries.map(([name, read], i) => [name, read.optional && queries[i].error ? null : queries[i].data])),
    states: Object.fromEntries(entries.map(([name], i) => [name, { pending: queries[i].isPending, refreshing: queries[i].isFetching, error: queries[i].error }])),
    error: queries.find((q, i) => blocks(entries[i][1], q.error))?.error ?? null,
    pending: queries.some((q, i) => q.isPending && !entries[i][1].optional && !entries[i][1].deferred),
    refreshing: queries.some(q => q.isFetching),
  }) });
  return { ...result, retry, key };
}
