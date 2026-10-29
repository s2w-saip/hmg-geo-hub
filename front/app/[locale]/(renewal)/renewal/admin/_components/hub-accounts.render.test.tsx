import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { draftOf, missingFields, toBody, type HubAccount, type HubRole } from "./hub-accounts-api";
import { DEFAULT_FILTER, filterToQuery, matches, queryToFilter, sortAccounts, stateOf } from "./hub-account-filter-model";

// Admin › 사용자 관리 (2026-10-29): the list as first rendered, its filter model, and the form's role-driven scope.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("role=country&q=kim") }));

const { HubAccountsManager } = await import("./hub-accounts-manager");
const { HubAccountForm } = await import("./hub-account-form");

const ROLES: HubRole[] = ["hq", "region", "country"]; // what an administrator hands out
const html = (ui: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );

const account = (over: Partial<HubAccount>): HubAccount => ({
  id: "8f6f0c1e-2b7a-4c1e-9d2a-1b2c3d4e5f60",
  login: "admin@hub",
  displayName: null,
  email: null,
  role: "admin",
  brands: [],
  regions: [],
  countries: [],
  status: "active",
  hasPassword: true,
  mustChangePassword: false,
  passwordChangedAt: "2026-10-28T02:00:00Z",
  createdAt: "2026-10-28T02:00:00Z",
  lastSignInAt: "2026-10-29T01:00:00Z",
  version: "v1",
  self: true,
  manageable: false,
  ...over,
});
const COUNTRY = account({ id: "11111111-2b7a-4c1e-9d2a-1b2c3d4e5f60", login: "kim.us", displayName: "김 미국", role: "country", brands: ["Kia"], regions: ["kia-north-america"], countries: ["US"], self: false, manageable: true, mustChangePassword: true, lastSignInAt: null, createdAt: "2026-10-29T02:00:00Z" });
const HQ = account({ id: "22222222-2b7a-4c1e-9d2a-1b2c3d4e5f60", login: "lee.hq", role: "hq", brands: ["Genesis"], self: false, manageable: true, status: "disabled", createdAt: "2026-10-29T03:00:00Z" });
const NOROLE = account({ id: "33333333-2b7a-4c1e-9d2a-1b2c3d4e5f60", login: "old", role: null, self: false, manageable: true, createdAt: "2026-10-27T03:00:00Z" });

describe("account list", () => {
  it("renders the URL's picks, one line per matching account, its scope and state", () => {
    const out = html(<HubAccountsManager initial={[account({}), COUNTRY, HQ, NOROLE]} roles={ROLES} savedFilters={{ page: "accounts", userId: "u", initial: [] }} />);
    expect(out).toContain(">사용자 관리<");
    expect(out).toContain('data-hub-account-row="kim.us"');
    expect(out).not.toContain('data-hub-account-row="admin@hub"'); // role=country picked in the URL
    expect(out).toContain("Kia · 미국");
    expect(out).toContain('data-hub-account-state="pending"');
    expect(out).toContain(">로그인 기록 없음<");
    expect(out).toContain("1 / 4개 계정");
  });

  it("filters by role, state, brand and the search text, and keeps them in the URL", () => {
    expect(matches(HQ, { ...DEFAULT_FILTER, state: "disabled" }, "")).toBe(true);
    expect(matches(HQ, { ...DEFAULT_FILTER, brand: "Kia" }, "")).toBe(false);
    expect(matches(account({}), { ...DEFAULT_FILTER, brand: "Kia" }, "")).toBe(false); // the administrator names no brand
    expect(matches(NOROLE, { ...DEFAULT_FILTER, role: "none" }, "")).toBe(true);
    expect(matches(COUNTRY, DEFAULT_FILTER, "미국")).toBe(true);
    expect(matches(COUNTRY, DEFAULT_FILTER, "lee")).toBe(false);
    expect([stateOf(COUNTRY), stateOf(HQ), stateOf(account({}))]).toEqual(["pending", "disabled", "active"]);
    const q = filterToQuery({ ...DEFAULT_FILTER, role: "hq", brand: "Genesis" }, " lee ");
    expect(q).toBe("role=hq&brand=Genesis&q=lee");
    expect(queryToFilter(q)).toEqual({ filters: { role: "hq", state: "all", brand: "Genesis" }, search: "lee" });
    expect(queryToFilter("role=viewer").filters.role).toBe("all");
  });

  it("orders by role, then the login ID; never signed in after every sign-in", () => {
    const all = [NOROLE, HQ, COUNTRY, account({})];
    expect(sortAccounts(all, "role", true).map((a) => a.login)).toEqual(["admin@hub", "lee.hq", "kim.us", "old"]);
    expect(sortAccounts(all, "lastSignIn", false).map((a) => a.login).at(-1)).toBe("kim.us");
    expect(sortAccounts(all, "created", false)[0].login).toBe("lee.hq");
  });
});

describe("account form", () => {
  it("asks for the scope axes the role uses, and offers only the roles below the administrator's", () => {
    const country = html(<HubAccountForm item={COUNTRY} roles={ROLES} onSaved={() => {}} onCancel={() => {}} />);
    expect(country).toContain("data-hub-account-brands");
    expect(country).toContain("data-hub-account-regions");
    expect(country).toContain("data-hub-account-countries");
    expect(country).toContain(">북아메리카<");
    expect(country).not.toContain('id="hub-account-login"'); // the login ID is set once
    const hq = html(<HubAccountForm item={{ ...HQ, status: "active" }} roles={ROLES} onSaved={() => {}} onCancel={() => {}} />);
    expect(hq).toContain("data-hub-account-brands");
    expect(hq).not.toContain("data-hub-account-regions");
    const create = html(<HubAccountForm item={null} roles={ROLES} onSaved={() => {}} onCancel={() => {}} />);
    expect(create).toContain('data-rn-seg="hq"');
    expect(create).not.toContain('data-rn-seg="admin"');
    expect(create).toContain('id="hub-account-login"');
    expect(create).toContain(ko.hubAccounts.form.passwordNote);
  });

  it("sends only the axes the role keeps and names what is missing", () => {
    const d = { ...draftOf(COUNTRY), role: "hq" as const };
    expect(toBody(d)).toEqual({ displayName: "김 미국", email: null, role: "hq", brands: ["Kia"], regions: [], countries: [] });
    expect(missingFields({ ...draftOf(null), login: "a b" }, true)).toEqual(["login", "brands", "regions", "countries"]);
    expect(missingFields({ ...draftOf(null), login: "kim", role: "admin" }, true)).toEqual([]);
    expect(missingFields({ ...draftOf(COUNTRY), email: "x" }, false)).toEqual(["email"]);
  });
});
