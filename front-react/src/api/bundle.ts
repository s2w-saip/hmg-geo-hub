import { useQueries } from "@tanstack/react-query";
import { useSession } from "~/app/session";
import { hub, queryString, screen, type Query } from "./client";

export interface Read { name: string; query?: Query; kind?: "screen" | "hub"; optional?: boolean }
/** Scope is part of every browser cache key. Every backend response still enforces its own scope. */
export function useBundle(reads: Record<string, Read>) {
  const { user } = useSession();
  const identity = JSON.stringify([user?.id, user?.role, user?.scope]);
  const entries = Object.entries(reads);
  const key = JSON.stringify([identity, entries.map(([name, read]) => [name, read.kind, read.name, queryString(read.query)])]);
  const result = useQueries({ queries: entries.map(([, read]) => ({
    queryKey: [read.kind ?? "screen", identity, read.name, queryString(read.query)],
    queryFn: ({ signal }: { signal: AbortSignal }) => (read.kind === "hub" ? hub : screen)<unknown>(read.name, read.query ?? {}, signal),
    enabled: !!user,
  })), combine: queries => ({
    // combine structurally shares unchanged responses, keeping React's consumed promises stable.
    data: Object.fromEntries(entries.map(([name, read], i) => [name, read.optional && queries[i].error ? null : queries[i].data])),
    error: queries.find((q, i) => q.error && !entries[i][1].optional)?.error ?? null,
    pending: queries.some((q, i) => q.isPending && !entries[i][1].optional),
    refreshing: queries.some(q => q.isFetching),
    retry: () => queries.forEach(q => { void q.refetch(); }),
  }) });
  return { ...result, key };
}
