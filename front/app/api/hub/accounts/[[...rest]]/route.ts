import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Admin › 사용자 관리 (2026-10-29): the browser's calls, passed to the BFF with the HUB session token
// (back/bff/hub_stores/accounts.py). The BFF answers the top-level administrator only.
//
//   GET  /api/hub/accounts                        -> every account
//   POST /api/hub/accounts                        -> create {login, displayName?, email?, role, brands, regions, countries}
//                                                    (the answer carries the temporary password, once)
//   GET  /api/hub/accounts/<id>                   -> one account and its history
//   PUT  /api/hub/accounts/<id>                   -> change {displayName, email, role, brands, regions, countries, expectedVersion}
//   POST /api/hub/accounts/<id>/disable|enable    -> stop or restart its use (disable ends its sessions)
//   POST /api/hub/accounts/<id>/reset-password    -> a new temporary password (its sessions end)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES: ReadonlyArray<readonly [HubMethod, RegExp]> = [
  ["GET", /^$/],
  ["POST", /^$/],
  ["GET", new RegExp(`^${ID}$`)],
  ["PUT", new RegExp(`^${ID}$`)],
  ["POST", new RegExp(`^${ID}/(disable|enable|reset-password)$`)],
];

type Ctx = { params: Promise<{ rest?: string[] }> };

async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rest = ((await ctx.params).rest ?? []).join("/");
  if (!ROUTES.some(([m, re]) => m === method && re.test(rest))) return hubFail(404, "not_found");
  if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  let body: unknown;
  if (method === "PUT" || (method === "POST" && !rest)) {
    body = await jsonBody(req);
    if (body === undefined) return hubFail(422, "invalid_value");
  }
  try {
    const out = await hubFetch<unknown>(method, `/v1/hub/accounts${rest ? `/${rest}` : ""}`, { token, body });
    return NextResponse.json(out, { status: method === "POST" && !rest ? 201 : 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
export const PUT = (req: NextRequest, ctx: Ctx) => handle("PUT", req, ctx);
