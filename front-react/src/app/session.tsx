import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CONNECTED, request } from "~/api/client";
import { queryClient } from "~/api/query-client";
import type { Role, AllowedScope } from "@/lib/auth/types";
import { HghApiError } from "@/lib/hgh/errors";

export interface HubUser {
  id: string; login: string; email: string | null; displayName: string | null;
  role: Role; scope: AllowedScope; mustChangePassword: boolean;
}
export function sessionUser(value: unknown): HubUser | null {
  if (value === null) return null;
  const user = value as Partial<HubUser> | undefined;
  const scope = user?.scope;
  const list = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === "string"));
  if (!user || typeof user.id !== "string" || !user.id || typeof user.login !== "string" || !["admin", "hq", "region", "country"].includes(user.role ?? "") || !scope || typeof scope.all !== "boolean" || !list(scope.brands) || !list(scope.regions) || !list(scope.countries) || typeof user.mustChangePassword !== "boolean") {
    throw new HghApiError(502, "invalid_session_response");
  }
  return user as HubUser;
}
const Session = createContext<{ user: HubUser | null; loading: boolean; error: Error | null; reload: () => void }>({ user: null, loading: false, error: null, reload: () => {} });
export function SessionProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["session"],
    enabled: CONNECTED,
    queryFn: async ({ signal }) => {
      try {
        const result = await request<{ user: HubUser | null }>("/api/hub/session", { signal });
        return sessionUser(result.user);
      } catch (e) {
        if (e instanceof HghApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
  });
  useEffect(() => {
    const expired = () => {
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "session" });
      queryClient.setQueryData(["session"], null);
    };
    window.addEventListener("hub-session-expired", expired);
    return () => window.removeEventListener("hub-session-expired", expired);
  }, []);
  return <Session.Provider value={{ user: query.error ? null : query.data ?? null, loading: CONNECTED && query.isPending, error: query.error, reload: () => { void query.refetch(); } }}>{children}</Session.Provider>;
}
export function useSession() { return useContext(Session); }
export function useLogout() {
  return useCallback(async () => {
    // Keep the authenticated UI until the server confirms that its cookie was cleared.
    await request<void>("/api/hub/session", { method: "DELETE" });
    await queryClient.cancelQueries();
    queryClient.clear();
    window.location.assign(`/${document.documentElement.lang}/login`);
  }, []);
}
