import { NextResponse, type NextRequest } from "next/server";
import { localReadOnly } from "@/lib/local-readonly";
import { hubMe } from "@/lib/hub/client";
import { HUB_SESSION_COOKIE } from "@/lib/hub/cookie";
import { NO_STORE, hubErrorResponse, hubFail } from "@/lib/hub/route";
import { browserScreenQuery } from "@/lib/hub/screen-read";
import { screenGet } from "@/lib/screen";

// Local migration bridge: React -> the existing Next cookie boundary -> the current data server.
// The permanent Hub will take over the same browser contract. No browser bearer token or metric calculation.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!localReadOnly()) return hubFail(404, "not_found");
  const token = req.cookies.get(HUB_SESSION_COOKIE)?.value;
  if (!token) return hubFail(401, "unauthorized");
  try {
    const user = await hubMe(token);
    if (!user) return hubFail(401, "unauthorized");
    const name = (await params).path.join("/");
    const query = browserScreenQuery(name, req.nextUrl.searchParams, user);
    return NextResponse.json(await screenGet<unknown>(name, query), { headers: NO_STORE });
  } catch (error) { return hubErrorResponse(error); }
}
