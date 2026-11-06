import { NextResponse, type NextRequest } from "next/server";
import { hubFetch } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail, jsonBody, sameOrigin } from "@/lib/hub/route";

// Admin › 측정 설정 › 프로젝트 만들기 (T6.3): POST /api/hub/projects -> a new project-surface project {name, description, domain, brand, country, engines}.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) return hubFail(403, "forbidden");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  const body = await jsonBody(req);
  if (body === undefined) return hubFail(422, "invalid_value");
  try {
    return NextResponse.json(await hubFetch<unknown>("POST", "/v1/hub/projects", { token, body }), { status: 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}
