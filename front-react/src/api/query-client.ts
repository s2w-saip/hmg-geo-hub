import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60_000,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
    mutations: { retry: false },
  },
});

export function refreshPageData() {
  return queryClient.invalidateQueries({ predicate: q => q.queryKey[0] !== "session" });
}
