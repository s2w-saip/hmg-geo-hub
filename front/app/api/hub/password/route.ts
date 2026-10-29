import { NextResponse, type NextRequest } from "next/server";
import { localReadOnly } from "@/lib/local-readonly";
import { hubChangePassword } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE, hubCookieOptions } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin, secureRequest } from "@/lib/hub/route";

// The signed-in HUB account replaces its password (2026-10-29): an issued one at the first sign-in, or its own
// any time. POST {current, new} -> BFF POST /v1/auth/password; every session of the account ends and the new
// token goes into the httpOnly cookie, so this browser stays signed in.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!localReadOnly()) return hubFail(404, "not_found");
  if (!sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  const body = (await jsonBody(req)) as { current?: unknown; new?: unknown } | undefined;
  if (typeof body?.current !== "string" || typeof body?.new !== "string") return hubFail(422, "invalid_value");
  try {
    const { token: fresh, expiresAt, user } = await hubChangePassword(token, body.current, body.new);
    const res = NextResponse.json({ user }, { headers: NO_STORE });
    res.cookies.set(HUB_SESSION_COOKIE, fresh, hubCookieOptions(secureRequest(req), expiresAt));
    return res;
  } catch (e) {
    return hubErrorResponse(e);
  }
}
