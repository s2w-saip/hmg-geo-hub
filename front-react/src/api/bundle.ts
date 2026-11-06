import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useSession } from "~/app/session";
import { hub, queryString, screen, type Query } from "./client";

export interface Read { name: string; query?: Query; kind?: "screen" | "hub" }
/** Scope is part of every browser cache key. Every backend response still enforces its own scope. */
export function useBundle(reads: Record<string, Read>) {
  const { user } = useSession();
  const identity = JSON.stringify([user?.id, user?.role, user?.scope]);
  const entries = Object.entries(reads);
  const queries = useQueries({ queries: entries.map(([, read]) => ({
    queryKey: [read.kind ?? "screen", identity, read.name, queryString(read.query)],
    queryFn: ({ signal }: { signal: AbortSignal }) => (read.kind === "hub" ? hub : screen)<unknown>(read.name, read.query ?? {}, signal),
    enabled: !!user,
  })) });
  const fingerprint = queries.map(q => `${q.status}:${q.fetchStatus}:${q.dataUpdatedAt}`).join("|");
  const data = useMemo(() => Object.fromEntries(entries.map(([key], i) => [key, queries[i].data])), [identity, fingerprint, JSON.stringify(entries)]);
  return {
    data,
    error: queries.find(q => q.error)?.error ?? null,
    pending: queries.some(q => q.isPending || q.isFetching),
    retry: () => queries.forEach(q => { void q.refetch(); }),
  };
}
