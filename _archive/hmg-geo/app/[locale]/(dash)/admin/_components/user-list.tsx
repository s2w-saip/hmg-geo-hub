import { getTranslations } from "next-intl/server";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { adminListUsers } from "@/lib/supabase/admin";
import { getSession } from "@/lib/auth/session";
import { UserListClient, type UserRow } from "./user-list-client";

// Server component: joins profiles (Drizzle) + auth.users metadata (Supabase
// Admin API), then projects to a plain serializable shape for the client
// wrapper that owns the search and dialog state. Dates are pre-formatted to
// ISO date strings here so the client doesn't need to receive Date objects
// across the boundary.
export async function UserList() {
  const t = await getTranslations("admin.list");

  const [profiles, authUsers, session] = await Promise.all([
    profileRepository.list(),
    adminListUsers().catch(() => []), // network failure shouldn't blank the page
    getSession(),
  ]);
  const authById = new Map(authUsers.map((u) => [u.id, u]));

  if (profiles.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  const users: UserRow[] = profiles.map((p) => {
    const auth = authById.get(p.id);
    return {
      id: p.id,
      email: p.email ?? auth?.email ?? null,
      role: p.role,
      scopeAll: p.scopeAll,
      brands: p.brands,
      regions: p.regions,
      countries: p.countries,
      operator: p.operator,
      createdAt: p.createdAt
        ? new Date(p.createdAt).toISOString().slice(0, 10)
        : null,
      lastSignInAt: auth?.lastSignInAt
        ? new Date(auth.lastSignInAt).toISOString().slice(0, 10)
        : null,
    };
  });

  // selfId enables the dialog to gate self-edit deletion (mirrors the server
  // action's check) without a separate round-trip from the client.
  const selfId = session?.user.id ?? "";

  return <UserListClient users={users} selfId={selfId} />;
}
