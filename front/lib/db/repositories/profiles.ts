import "server-only";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { profiles, type ProfileRow } from "@/lib/db/schema";
import type { Role, OperatorScope } from "@/lib/auth/types";

// The profile lookup is the IDENTITY bootstrap: it is used to BUILD the
// AuthContext from an already-authenticated user, so it is keyed by the user's
// own id (not a scoped query). Scoped domain repositories (added later) must go
// through the scope-enforced path instead (see lib/db/scoped.ts).
//
// Mutation methods (insert / update) are reachable ONLY by admin server actions
// (access-control spec: profiles 변경은 관리자 액션을 통해서만). The repository
// itself doesn't enforce that — callers must assert before invoking.
export interface ProfileUpdate {
  role?: Role;
  scopeAll?: boolean;
  brands?: string[] | null;
  regions?: string[] | null;
  countries?: string[] | null;
  operator?: OperatorScope;
  email?: string | null;
}

export interface ProfileInsert {
  id: string;
  email?: string | null;
  role: Role;
  scopeAll?: boolean;
  brands?: string[] | null;
  regions?: string[] | null;
  countries?: string[] | null;
  operator?: OperatorScope;
}

export interface ProfileRepository {
  getByUserId(userId: string): Promise<ProfileRow | null>;
  getByEmail(email: string): Promise<ProfileRow | null>;
  list(): Promise<ProfileRow[]>;
  insert(input: ProfileInsert): Promise<ProfileRow>;
  update(id: string, patch: ProfileUpdate): Promise<ProfileRow>;
  delete(id: string): Promise<void>;
  /**
   * Counts profiles with role='admin' excluding the given id. Used to enforce
   * the "at least one admin must always exist" invariant when an admin role
   * is removed (demote/delete). Caller passes the id of the row being changed
   * so the count reflects the post-operation state.
   */
  countAdminsExcept(id: string): Promise<number>;
}

export const profileRepository: ProfileRepository = {
  async getByUserId(userId) {
    // operator 컬럼(0013_profiles_operator)이 prod DB에 아직 적용 안 된
    // 환경에서 select() 가 throw → session 전체 → /ko 5xx. 광역 select 가
    // schema 와 mismatch 일 때 explicit fallback. operator 가 빠지면
    // session.ts 가 'none' 으로 default — 비용 액션 게이트 OFF(가장 안전).
    // 마이그 적용 후엔 try 분기로 자동 정상화.
    try {
      const rows = await getDb()
        .select()
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      return rows[0] ?? null;
    } catch {
      const rows = await getDb()
        .select({
          id: profiles.id,
          email: profiles.email,
          role: profiles.role,
          scopeAll: profiles.scopeAll,
          brands: profiles.brands,
          regions: profiles.regions,
          countries: profiles.countries,
          createdAt: profiles.createdAt,
        })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      const r = rows[0];
      // menu_groups(0038)도 select 에서 제외 — 미적용 환경 방어. null = 제한 없음
      // (route-policy 가 role 기본 메뉴 그대로 노출, 가장 안전한 기본값).
      return r
        ? { ...r, operator: "none" as const, menuGroups: null, updatedAt: new Date(0) }
        : null;
    }
  },

  async getByEmail(email) {
    // Used by the project-member invite flow (Q7(b) resolution 2026-06-01:
    // only existing users can be invited). Case-sensitive match — Supabase
    // Auth stores emails lowercased, so callers normalise to lower-case
    // before lookup.
    const rows = await getDb()
      .select()
      .from(profiles)
      .where(eq(profiles.email, email))
      .limit(1);
    return rows[0] ?? null;
  },

  async list() {
    return getDb()
      .select()
      .from(profiles)
      .orderBy(desc(profiles.createdAt));
  },

  async insert(input) {
    if (input.role === "local_reader") throw new Error("Local readers are not stored user accounts");
    const rows = await getDb()
      .insert(profiles)
      .values({
        id: input.id,
        email: input.email ?? null,
        role: input.role,
        scopeAll: input.scopeAll ?? false,
        brands: input.brands ?? null,
        regions: input.regions ?? null,
        countries: input.countries ?? null,
        operator: input.operator ?? "none",
      })
      .returning();
    const created = rows[0];
    if (!created) {
      throw new Error("profileRepository.insert: no row returned");
    }
    return created;
  },

  async update(id, patch) {
    // Build a partial update set — only the fields explicitly present in the
    // patch are touched. updatedAt is server-stamped here (not trusted from
    // the client) — persistence-foundation spec: "updatedAt은 서버에서 강제 갱신".
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.scopeAll !== undefined) set.scopeAll = patch.scopeAll;
    if (patch.brands !== undefined) set.brands = patch.brands;
    if (patch.regions !== undefined) set.regions = patch.regions;
    if (patch.countries !== undefined) set.countries = patch.countries;
    if (patch.operator !== undefined) set.operator = patch.operator;
    if (patch.email !== undefined) set.email = patch.email;

    const rows = await getDb()
      .update(profiles)
      .set(set)
      .where(eq(profiles.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new Error("profileRepository.update: no row matched id=" + id);
    }
    return updated;
  },

  async delete(id) {
    // No FK to auth.users (schema is portable) — caller (admin server action) is
    // responsible for sequencing with adminDeleteUser. Idempotent: deleting a
    // missing row is a no-op rather than an error since the desired end state
    // is "row gone".
    await getDb().delete(profiles).where(eq(profiles.id, id));
  },

  async countAdminsExcept(id) {
    const rows = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(profiles)
      .where(and(eq(profiles.role, "admin"), ne(profiles.id, id)));
    return rows[0]?.n ?? 0;
  },
};
