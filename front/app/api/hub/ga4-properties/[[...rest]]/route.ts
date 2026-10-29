import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Admin › GA4 연동 (2026-10-29): the browser's calls, passed to the BFF with the HUB session token
// (back/bff/hub_stores/ga4_registry.py). The BFF answers the top-level administrator only and never calls GA4.
//
//   GET  /api/hub/ga4-properties                  -> every registered property with the collector's last result
//   POST /api/hub/ga4-properties                  -> register {propertyId, brand, country, basis, events}
//   GET  /api/hub/ga4-properties/<id>             -> one property and its history
//   PUT  /api/hub/ga4-properties/<id>             -> change {brand, country, basis, events, expectedVersion}
//   GET  /api/hub/ga4-properties/<id>/events      -> the events the collector stored for it (last 90 collected days)
//   POST /api/hub/ga4-properties/<id>/stop|resume -> leave it out of the collection, or take it back
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = "[0-9]{1,20}";
const ROUTES: ReadonlyArray<readonly [HubMethod, RegExp]> = [
  ["GET", /^$/],
  ["POST", /^$/],
  ["GET", new RegExp(`^${ID}$`)],
  ["PUT", new RegExp(`^${ID}$`)],
  ["GET", new RegExp(`^${ID}/events$`)],
  ["POST", new RegExp(`^${ID}/(stop|resume)$`)],
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
    const out = await hubFetch<unknown>(method, `/v1/hub/ga4-properties${rest ? `/${rest}` : ""}`, { token, body });
    return NextResponse.json(out, { status: method === "POST" && !rest ? 201 : 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
export const PUT = (req: NextRequest, ctx: Ctx) => handle("PUT", req, ctx);
