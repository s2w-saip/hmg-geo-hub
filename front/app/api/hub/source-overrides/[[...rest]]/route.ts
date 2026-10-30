import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Admin › 인용 출처 분류 (2026-10-30): the browser's calls, passed to the BFF with the HUB session token
// (back/bff/hub_stores/source_overrides.py). The BFF answers the top-level administrator only. A source key can hold
// a slash (an official social account), so it travels in the body or the query, never in the path.
//
//   GET  /api/hub/source-overrides                 -> Gold's latest global round with the HUB's corrections
//   GET  /api/hub/source-overrides/history?skey=   -> one source's correction and history (no skey: the latest changes)
//   POST /api/hub/source-overrides                 -> correct {skey, category}
//   POST /api/hub/source-overrides/clear           -> revert {skey}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTES: ReadonlyArray<readonly [HubMethod, string]> = [
  ["GET", ""],
  ["GET", "history"],
  ["POST", ""],
  ["POST", "clear"],
];

type Ctx = { params: Promise<{ rest?: string[] }> };

async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rest = ((await ctx.params).rest ?? []).join("/");
  if (!ROUTES.some(([m, p]) => m === method && p === rest)) return hubFail(404, "not_found");
  if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  let body: unknown;
  if (method === "POST") {
    body = await jsonBody(req);
    if (body === undefined) return hubFail(422, "invalid_value");
  }
  const skey = rest === "history" ? req.nextUrl.searchParams.get("skey") : null;
  const query = skey ? new URLSearchParams({ skey }).toString() : undefined;
  try {
    const out = await hubFetch<unknown>(method, `/v1/hub/source-overrides${rest ? `/${rest}` : ""}`, { token, body, ...(query ? { query } : {}) });
    return NextResponse.json(out, { status: 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
