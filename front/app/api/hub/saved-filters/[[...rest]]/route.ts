import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Saved filters of the renewal pages (2026-10-28): the signed-in account's own list per page, kept in the
// HUB operations DB (back/bff/hub_stores/saved_filters.py). The browser's calls, passed to the BFF with the
// HUB session token; the BFF binds every read and write to that account.
//
//   GET    /api/hub/saved-filters?page=<page>   -> the list
//   POST   /api/hub/saved-filters               -> save {page, name, query, isDefault?, before?}
//   POST   /api/hub/saved-filters/import        -> this browser's earlier (localStorage) list {page, items}
//   PATCH  /api/hub/saved-filters/<id>          -> rename / overwrite / open by default {name?, query?, isDefault?}
//   DELETE /api/hub/saved-filters/<id>          -> delete
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES: ReadonlyArray<readonly [HubMethod, RegExp]> = [
  ["GET", /^$/],
  ["POST", /^$/],
  ["POST", /^import$/],
  ["PATCH", new RegExp(`^${ID}$`)],
  ["DELETE", new RegExp(`^${ID}$`)],
];

type Ctx = { params: Promise<{ rest?: string[] }> };

async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rest = ((await ctx.params).rest ?? []).join("/");
  if (!ROUTES.some(([m, re]) => m === method && re.test(rest))) return hubFail(404, "not_found");
  if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  let body: unknown;
  if (method === "POST" || method === "PATCH") {
    body = await jsonBody(req);
    if (body === undefined) return hubFail(422, "invalid_value");
  }
  const query = new URLSearchParams();
  const page = method === "GET" ? req.nextUrl.searchParams.get("page") : null;
  if (page) query.set("page", page);
  try {
    const out = await hubFetch<unknown>(method, `/v1/hub/saved-filters${rest ? `/${rest}` : ""}`, { token, body, query: query.toString() });
    return NextResponse.json(out, { status: method === "POST" && !rest ? 201 : 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
export const PATCH = (req: NextRequest, ctx: Ctx) => handle("PATCH", req, ctx);
export const DELETE = (req: NextRequest, ctx: Ctx) => handle("DELETE", req, ctx);
