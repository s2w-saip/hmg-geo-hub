import "server-only";

// Supabase Auth Admin API helpers (server-only). Uses the SERVICE ROLE KEY which
// MUST NEVER reach the browser — this file imports "server-only" to enforce that
// at build time. Anything in app/[locale] that touches these helpers must be a
// server action or server component (no client component imports allowed).
//
// We intentionally avoid pulling in the full supabase-js client here: a tiny fetch
// wrapper keeps the bundle thin and our dependency surface minimal. The Admin
// API is HTTP-only (no SDK affordances we need beyond create/delete).

interface AdminCreateUserInput {
  email: string;
  password: string;
  emailConfirm?: boolean;
}

interface AdminUserResponse {
  id: string;
  email: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
}

function adminEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin env missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return { url, key };
}

export async function adminCreateUser(
  input: AdminCreateUserInput,
): Promise<AdminUserResponse> {
  const { url, key } = adminEnv();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      // Default true so the admin-console flow doesn't depend on the user
      // clicking a confirmation email — mailer_autoconfirm is kept OFF in the
      // project policy (see proposal §7 + design D8).
      email_confirm: input.emailConfirm ?? true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase admin create user failed (${res.status}): ${body}`);
  }
  return (await res.json()) as AdminUserResponse;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const { url, key } = adminEnv();
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase admin delete user failed (${res.status}): ${body}`);
  }
}

export interface AdminUserListItem {
  id: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
}

export async function adminListUsers(): Promise<AdminUserListItem[]> {
  const { url, key } = adminEnv();
  // per_page defaults to 50 on Supabase; we only seed a handful for v1 and the
  // admin console list will paginate properly in a later change.
  const res = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase admin list users failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    users?: Array<{
      id: string;
      email: string | null;
      created_at?: string;
      last_sign_in_at?: string | null;
    }>;
  };
  return (data.users ?? []).map((u) => ({
    id: u.id,
    email: u.email,
    createdAt: u.created_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
  }));
}

// Cryptographically-random temp password generator. Composed to satisfy common
// password policies (upper / lower / digit / symbol) without relying on the
// random distribution. 18+ chars of entropy from /dev/urandom-backed Web Crypto.
export function generateTempPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  // base64url-ish, strip ambiguous chars
  const base = Buffer.from(bytes)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 14);
  // Append a fixed suffix to guarantee mixed character classes; suffix bytes
  // are not the only randomness, the 14 base chars carry the entropy.
  return `${base}Aa1!`;
}
