import { NextResponse, type NextRequest } from "next/server";
import { localReadOnly } from "@/lib/local-readonly";
import { hubLogin, hubMe } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE, hubCookieOptions } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin, secureRequest } from "@/lib/hub/route";

// HUB login of the local mode (2026-10-27): the top-level administrator signs in to use the HUB.
//
//   POST   /api/hub/session  {login, password}  -> BFF POST /v1/auth/login; the token goes into the httpOnly cookie
//   DELETE /api/hub/session                     -> the cookie is cleared (sign out)
//
// Every local page needs it (2026-10-28). The password passes through to the BFF only; the token never reaches the page.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** React's session read: only the account view is returned; the token stays in its HttpOnly cookie. */
export async function GET(req: NextRequest) {
  if (!localReadOnly()) return hubFail(404, "not_found");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ user: null }, { headers: NO_STORE });
  try {
    return NextResponse.json({ user: await hubMe(token) }, { headers: NO_STORE });
  } catch (error) { return hubErrorResponse(error); }
}

export async function POST(req: NextRequest) {
  if (!localReadOnly()) return hubFail(404, "not_found");
  if (!sameOrigin(req)) return hubFail(403, "forbidden");
  const body = (await jsonBody(req)) as { login?: unknown; password?: unknown } | undefined;
  if (typeof body?.login !== "string" || typeof body?.password !== "string") return hubFail(422, "invalid_value");
  try {
    const { token, expiresAt, user } = await hubLogin(body.login, body.password);
    const res = NextResponse.json({ user }, { headers: NO_STORE });
    res.cookies.set(HUB_SESSION_COOKIE, token, hubCookieOptions(secureRequest(req), expiresAt));
    return res;
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req)) return hubFail(403, "forbidden");
  const res = new NextResponse(null, { status: 204, headers: NO_STORE });
  res.cookies.set(HUB_SESSION_COOKIE, "", hubCookieOptions(secureRequest(req)));
  return res;
}
