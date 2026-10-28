// HUB login session cookie (2026-10-27): the BFF's signed token (back/bff/hub_stores/hub_auth.py).
// httpOnly and this site only; the route handlers under /api/hub/* set and clear it.

export const HUB_SESSION_COOKIE = "hgh_hub_session";

export interface HubCookieOptions {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/";
  expires?: Date;
  maxAge?: number;
}

/** Options to set the cookie until `expiresAt` (epoch seconds), or to clear it when omitted. */
export function hubCookieOptions(secure: boolean, expiresAt?: number): HubCookieOptions {
  const base = { httpOnly: true, sameSite: "strict", secure, path: "/" } as const;
  return expiresAt ? { ...base, expires: new Date(expiresAt * 1000) } : { ...base, maxAge: 0 };
}
