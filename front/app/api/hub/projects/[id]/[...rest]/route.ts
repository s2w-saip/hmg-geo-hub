import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Project › Prompt (2026-11-03): the browser's calls for a project's prompts and tags, passed to the BFF with the HUB
// session token (back/bff/hub_stores/project_prompts.py). The BFF checks the token and the top-level role on every call.
//
//   POST /api/hub/projects/<pid>/prompts                              -> drafts, one per line {text}
//   GET  /api/hub/projects/<pid>/prompts/<id>/history                 -> the prompt + its revisions
//   POST /api/hub/projects/<pid>/prompts/<id>                         -> edit {expectedVersion, text?, kind?, language?}
//   POST /api/hub/projects/<pid>/prompts/<id>/pause|resume|archive|restore   -> status {expectedVersion}
//   POST /api/hub/projects/<pid>/prompt-tags                          -> one tag value on prompts {promptIds, fieldId, value}
//   POST /api/hub/projects/<pid>/prompt-fields                        -> a tag column {label}
//   POST /api/hub/projects/<pid>/prompt-fields/<fid>/archive|restore  -> its status ({})
//   GET  /api/hub/projects/<pid>/measurement                          -> the measurement settings (2026-11-06)
//   POST /api/hub/projects/<pid>/measurement                          -> a new version {expectedVersion, brands, ...}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PID = new RegExp(`^${UUID}$`);
const ROUTES: ReadonlyArray<readonly [HubMethod, RegExp]> = [
  ["POST", /^prompts$/],
  ["GET", new RegExp(`^prompts/${UUID}/history$`)],
  ["POST", new RegExp(`^prompts/${UUID}$`)],
  ["POST", new RegExp(`^prompts/${UUID}/(pause|resume|archive|restore)$`)],
  ["POST", /^prompt-tags$/],
  ["POST", /^prompt-fields$/],
  ["POST", new RegExp(`^prompt-fields/${UUID}/(archive|restore)$`)],
  ["GET", /^measurement$/],
  ["POST", /^measurement$/],
];

type Ctx = { params: Promise<{ id: string; rest?: string[] }> };

async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, rest: parts } = await ctx.params;
  const rest = (parts ?? []).join("/");
  if (!PID.test(id) || !ROUTES.some(([m, re]) => m === method && re.test(rest))) return hubFail(404, "not_found");
  if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  let body: unknown;
  if (method !== "GET") {
    body = await jsonBody(req);
    if (body === undefined) return hubFail(422, "invalid_value");
  }
  try {
    const out = await hubFetch<unknown>(method, `/v1/hub/projects/${id}/${rest}`, { token, body });
    return NextResponse.json(out, { status: 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx);
