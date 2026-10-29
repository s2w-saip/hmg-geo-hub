// Admin › 사용자 관리 (2026-10-29): the list's filters, search and order. Accounts are few (tens to hundreds), so
// the page reads them all once and filters in the browser. The URL and the saved filters (page "accounts") carry
// the picks and the search text.

import { HUB_BRANDS, HUB_ROLES, type HubAccount } from "./hub-accounts-api";

export const ALL = "all";
export const ACCOUNT_AXES = ["role", "state", "brand"] as const;
export type AccountAxis = (typeof ACCOUNT_AXES)[number];
export type AccountFilter = Record<AccountAxis, string>;
export const DEFAULT_FILTER: AccountFilter = { role: ALL, state: ALL, brand: ALL };

/** 사용 중 · 첫 로그인 전 (an issued password not yet replaced) · 사용 중지 */
export const STATES = ["active", "pending", "disabled"] as const;
export type AccountState = (typeof STATES)[number];
export const NO_ROLE = "none";

export const AXIS_OPTIONS: Record<AccountAxis, readonly string[]> = {
  role: [...HUB_ROLES, NO_ROLE],
  state: STATES,
  brand: HUB_BRANDS,
};

export function stateOf(a: HubAccount): AccountState {
  return a.status === "disabled" ? "disabled" : a.mustChangePassword ? "pending" : "active";
}

export function queryToFilter(q: URLSearchParams | string): { filters: AccountFilter; search: string } {
  const sp = typeof q === "string" ? new URLSearchParams(q) : q;
  const filters = { ...DEFAULT_FILTER };
  for (const axis of ACCOUNT_AXES) {
    const v = sp.get(axis);
    if (v && AXIS_OPTIONS[axis].includes(v)) filters[axis] = v;
  }
  return { filters, search: (sp.get("q") ?? "").slice(0, 200) };
}

export function filterToQuery(filters: AccountFilter, search: string): string {
  const sp = new URLSearchParams();
  for (const axis of ACCOUNT_AXES) if (filters[axis] !== ALL) sp.set(axis, filters[axis]);
  if (search.trim()) sp.set("q", search.trim());
  return sp.toString();
}

export function pickedAxes(filters: AccountFilter): AccountAxis[] {
  return ACCOUNT_AXES.filter((a) => filters[a] !== ALL);
}

/** The brand axis lists the accounts whose scope names the brand (the administrator's covers every brand but names none). */
export function matches(a: HubAccount, f: AccountFilter, search: string): boolean {
  if (f.role !== ALL && (a.role ?? NO_ROLE) !== f.role) return false;
  if (f.state !== ALL && stateOf(a) !== f.state) return false;
  if (f.brand !== ALL && !a.brands.includes(f.brand)) return false;
  const q = search.trim().toLowerCase();
  return !q || [a.login, a.displayName, a.email].some((v) => v?.toLowerCase().includes(q));
}

export const ACCOUNT_SORTS = ["role", "login", "state", "lastSignIn", "created"] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];
export const DEFAULT_SORT: { key: AccountSort; asc: boolean } = { key: "role", asc: true };

/** Times read newest first on the first click; the rest A → Z. */
export function firstAsc(key: AccountSort): boolean {
  return key !== "lastSignIn" && key !== "created";
}

const ROLE_RANK: Record<string, number> = { admin: 0, hq: 1, region: 2, country: 3, [NO_ROLE]: 4 };
const STATE_RANK: Record<AccountState, number> = { active: 0, pending: 1, disabled: 2 };

/** One column, then the login ID. A never-signed-in account sorts after every sign-in either way. */
export function sortAccounts(items: HubAccount[], key: AccountSort, asc: boolean): HubAccount[] {
  const login = (a: HubAccount, b: HubAccount) => a.login.localeCompare(b.login);
  const dir = asc ? 1 : -1;
  const by = (a: HubAccount, b: HubAccount): number => {
    switch (key) {
      case "role":
        return (ROLE_RANK[a.role ?? NO_ROLE] - ROLE_RANK[b.role ?? NO_ROLE]) * dir;
      case "state":
        return (STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)]) * dir;
      case "lastSignIn":
        if (!a.lastSignInAt || !b.lastSignInAt) return a.lastSignInAt ? -1 : b.lastSignInAt ? 1 : 0;
        return a.lastSignInAt.localeCompare(b.lastSignInAt) * dir;
      case "created":
        return a.createdAt.localeCompare(b.createdAt) * dir;
      default:
        return login(a, b) * dir;
    }
  };
  return [...items].sort((a, b) => by(a, b) || login(a, b));
}
