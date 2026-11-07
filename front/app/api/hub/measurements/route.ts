import { NextResponse, type NextRequest } from "next/server";
import { hubFetch } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail } from "@/lib/hub/route";

// GET /api/hub/measurements (T14.5.3r): Admin › 측정 설정's list for the React client while it reaches the hub server through this site. The Next page reads it on the server.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  try {
    return NextResponse.json(await hubFetch<unknown>("GET", "/v1/hub/measurements", { token }), { status: 200, headers: NO_STORE });
  } catch (e) {
    return hubErrorResponse(e);
  }
}
