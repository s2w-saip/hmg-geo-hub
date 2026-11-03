import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { SERVICE_WEEK_SITE_PICKS } from "@/lib/service-week";
import { readServiceWeek } from "@/lib/service-week-server";

// The service week, read again by the shells (components/service-week/provider.tsx) on a page or filter change and
// when the tab comes back: the layouts keep their first read across soft navigations, and the cron may advance the
// week in between.
//
//   GET /api/service-week[?brand=<A~B>][&geography=<A~B>][&language=<A~B>][&engine=<A~B>]
//                           200 ServiceWeekView (screen shared/service-week, as it is)
//                           401 unauthenticated · the screen's failure status (503 = no week to fall back on)
//
// Session gate only: the week is the same for every account (the BFF reads it with the request's HUB token). The
// page's site picks (lib/service-week serviceWeekSites) are passed on: the screen's site notes are the page's sites
// (review r1-7 · r5-1, 2026-11-03), inside the account's scope. Never cached. GET, so the local read-only mode lets it
// through.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated" } }, { status: 401, headers: noStore });
  // the page URL's params that pick a Website page's sites; nothing else of the page's query is passed on
  const sites: Record<string, string> = {};
  for (const key of SERVICE_WEEK_SITE_PICKS) {
    const v = req.nextUrl.searchParams.get(key);
    if (v) sites[key] = v;
  }
  try {
    return NextResponse.json(await readServiceWeek(sites), { headers: noStore });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
