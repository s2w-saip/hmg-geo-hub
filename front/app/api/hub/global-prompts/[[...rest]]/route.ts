import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Global prompt editing (renewal Admin › Global prompts, 2026-10-27): the browser's calls, passed to the
// BFF with the HUB session token. The BFF checks the token and the top-level role on every call.
//
//   GET  /api/hub/global-prompts?q&status&origin&kind&language&region&<label>&sort&order&limit&offset
//                                                                            -> list page + counts
//   GET  /api/hub/global-prompts/options                                     -> codes the catalog uses
//   POST /api/hub/global-prompts                                             -> create (HUB-owned)
//   GET  /api/hub/global-prompts/<id>                                        -> item + change history
//   PUT  /api/hub/global-prompts/<id>                                        -> edit (expectedVersion)
//   POST /api/hub/global-prompts/<id>/archive | /restore                     -> status (expectedVersion)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES: ReadonlyArray<readonly [HubMethod, RegExp]> = [
  ["GET", /^$/],
  ["POST", /^$/],
  ["GET", /^options$/],
  ["GET", new RegExp(`^${ID}$`)],
  ["PUT", new RegExp(`^${ID}$`)],
  ["POST", new RegExp(`^${ID}/(archive|restore)$`)],
];
// <label> = funnel, brandPresence, listType, depth1–4
const LIST_PARAMS = ["q", "status", "origin", "kind", "language", "region", "sort", "order", "limit", "offset", "funnel", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4"];

type Ctx = { params: Promise<{ rest?: string[] }> };

async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rest = ((await ctx.params).rest ?? []).join("/");
  if (!ROUTES.some(([m, re]) => m === method && re.test(rest))) return hubFail(404, "not_found");
  if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  let body: unknown;
  if (method !== "GET") {
    body = await jsonBody(req);
    if (body === undefined) return hubFail(422, "invalid_value");
  }
  const query = new URLSearchParams();
  if (method === "GET" && !rest) {
    for (const key of LIST_PARAMS) {
      const value = req.nextUrl.searchParams.get(key);
      if (value) query.set(key, value);
    }
  }
  try {
    const out = await hubFetch<unknown>(method, `/v1/hub/global-prompts${rest ? `/${rest}` : ""}`, { token, body, query: query.toString() });
    return NextResponse.json(out, { status: method === "POST" && !rest ? 201 : 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
export const PUT = (req: NextRequest, ctx: Ctx) => handle("PUT", req, ctx);
