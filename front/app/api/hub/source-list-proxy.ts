import { NextResponse, type NextRequest } from "next/server";
import { hubFetch, type HubMethod } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Admin › 인용 출처 분류 › 시드 · 공식 소셜 · 코드표 (2026-10-30): the browser's calls, passed to the BFF with the HUB
// session token (back/bff/hub_stores/source_lists.py), as /api/hub/source-overrides does. A key can hold a slash (an
// official social account), so it travels in the body or the query (`queryKeys`, history only), never in the path.

type Ctx = { params: Promise<{ rest?: string[] }> };

export function sourceListProxy(base: string, routes: ReadonlyArray<readonly [HubMethod, string]>, queryKeys: readonly string[]) {
  async function handle(method: HubMethod, req: NextRequest, ctx: Ctx): Promise<NextResponse> {
    const rest = ((await ctx.params).rest ?? []).join("/");
    if (!routes.some(([m, p]) => m === method && p === rest)) return hubFail(404, "not_found");
    if (method !== "GET" && !sameOrigin(req)) return hubFail(403, "forbidden");
    const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
    if (!token) return hubFail(401, "unauthorized");
    let body: unknown;
    if (method === "POST") {
      body = await jsonBody(req);
      if (body === undefined) return hubFail(422, "invalid_value");
    }
    const params = new URLSearchParams();
    if (rest === "history") {
      for (const k of queryKeys) {
        const v = req.nextUrl.searchParams.get(k);
        if (v) params.set(k, v);
      }
    }
    const query = params.toString();
    try {
      const out = await hubFetch<unknown>(method, `${base}${rest ? `/${rest}` : ""}`, { token, body, ...(query ? { query } : {}) });
      return NextResponse.json(out, { status: 200, headers: NO_STORE });
    } catch (e) {
      return hubErrorResponse(e);
    }
  }
  return {
    GET: (req: NextRequest, ctx: Ctx) => handle("GET", req, ctx),
    POST: (req: NextRequest, ctx: Ctx) => handle("POST", req, ctx),
  };
}
