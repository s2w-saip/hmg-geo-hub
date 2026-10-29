// Admin › 사용자 관리 (2026-10-29): the shapes the BFF answers (back/bff/hub_stores/accounts.py) and the browser's
// calls through /api/hub/accounts (app/api/hub/accounts/[[...rest]]/route.ts).

export const HUB_ROLES = ["admin", "hq", "region", "country"] as const;
export type HubRole = (typeof HUB_ROLES)[number];
export const HUB_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;

export interface HubAccount {
  id: string;
  login: string;
  displayName: string | null;
  email: string | null;
  /** null: no role (registered elsewhere or revoked), so no sign-in */
  role: HubRole | null;
  brands: string[];
  regions: string[];
  countries: string[];
  status: "active" | "disabled";
  hasPassword: boolean;
  /** an administrator issued the password and the account has not replaced it yet */
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  /** the account as this answer saw it; an edit sends it back (expectedVersion) */
  version: string;
  /** the signed-in account's own */
  self: boolean;
  /** below the signed-in account's role, so it changes here; its own and other administrators' do not (accounts.below) */
  manageable: boolean;
}

export interface HubAccountList {
  items: HubAccount[];
  /** the roles the signed-in account hands out: those below its own */
  roles: HubRole[];
}

export interface HubAccountEvent {
  id: number;
  action: string;
  at: string;
  actor: { login: string; displayName: string | null } | null;
  /** field -> [before, after] */
  changes: Record<string, [unknown, unknown]>;
}

export interface HubAccountDetail {
  item: HubAccount;
  history: HubAccountEvent[];
}

/** The form's fields ("" = none). The axes a role does not use are dropped by `toBody`. */
export interface AccountDraft {
  login: string;
  displayName: string;
  email: string;
  role: HubRole;
  brands: string[];
  regions: string[];
  countries: string[];
}

export function draftOf(item: HubAccount | null): AccountDraft {
  return {
    login: item?.login ?? "",
    displayName: item?.displayName ?? "",
    email: item?.email ?? "",
    role: item?.role ?? "country",
    brands: item?.brands ?? [],
    regions: item?.regions ?? [],
    countries: item?.countries ?? [],
  };
}

/** Which scope axes a role keeps: admin none, hq brands, region + regions, country + countries. */
export function axesOf(role: HubRole): { brands: boolean; regions: boolean; countries: boolean } {
  return { brands: role !== "admin", regions: role === "region" || role === "country", countries: role === "country" };
}

export function toBody(d: AccountDraft) {
  const axes = axesOf(d.role);
  return {
    displayName: d.displayName.trim() || null,
    email: d.email.trim() || null,
    role: d.role,
    brands: axes.brands ? d.brands : [],
    regions: axes.regions ? d.regions : [],
    countries: axes.countries ? d.countries : [],
  };
}

export const LOGIN_PATTERN = /^[A-Za-z0-9._@-]{3,200}$/;

/** The fields the BFF would refuse, checked before sending (the BFF checks again). */
export function missingFields(d: AccountDraft, creating: boolean): string[] {
  const axes = axesOf(d.role);
  const out: string[] = [];
  if (creating && !LOGIN_PATTERN.test(d.login.trim())) out.push("login");
  if (d.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim())) out.push("email");
  if (axes.brands && !d.brands.length) out.push("brands");
  if (axes.regions && !d.regions.length) out.push("regions");
  if (axes.countries && !d.countries.length) out.push("countries");
  return out;
}

export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: { fields?: string[] },
  ) {
    super(code);
  }
}

async function call<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/accounts${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: AccountRequestError["details"] } } | null;
  if (!res.ok || !json?.data) throw new AccountRequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export type AccountAction = "disable" | "enable" | "reset-password";

export const accountsApi = {
  list: () => call<HubAccountList>(""),
  detail: (id: string) => call<HubAccountDetail>(`/${id}`),
  create: (d: AccountDraft) => call<{ item: HubAccount; temporaryPassword: string }>("", "POST", { login: d.login.trim(), ...toBody(d) }),
  update: (item: HubAccount, d: AccountDraft) => call<{ item: HubAccount }>(`/${item.id}`, "PUT", { ...toBody(d), expectedVersion: item.version }),
  act: (id: string, action: AccountAction) => call<{ item: HubAccount; temporaryPassword?: string }>(`/${id}/${action}`, "POST"),
};
