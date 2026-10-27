import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { searchParamsToRecord } from "@/lib/search-params";

// BFF: the Global prompts list's browser reads (/standard/prompts and /renewal/standard/prompts).
//
//   GET /api/standard/prompts/page?<list params>     -> screen catalog/prompts-page    (filters, order, one page)
//   GET /api/standard/prompts/export?<list params>   -> screen catalog/prompts-export  (every row, list order)
//   GET /api/standard/prompts/history?days&event     -> screen catalog/prompts-history (변경 이력 tab)
//   GET /api/standard/prompts/timeline?prompt_id     -> screen catalog/prompts-timeline (a row's 이력)
//
// Thin proxies: the gate, then the params pass through (route context `ctx.*` is not taken from the
// browser). List params: _data/screen-query.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCREENS: Record<string, string> = {
  page: "catalog/prompts-page",
  export: "catalog/prompts-export",
  history: "catalog/prompts-history",
  timeline: "catalog/prompts-timeline",
};

const fail = (status: number, code: string) => NextResponse.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ view: string }> }) {
  const screen = SCREENS[(await params).view];
  if (!screen) return fail(404, "not_found");
  const session = await getSession();
  if (!session) return fail(401, "unauthorized");
  // The 3rd argument (menu groups) is the account's menu gate; a route handler has no layout to apply it.
  if (!canAccessRoute(session.user.role, "/standard/prompts", session.user.menuGroups)) return fail(403, "forbidden");
  const query = Object.fromEntries(Object.entries(searchParamsToRecord(req.nextUrl.searchParams)).filter(([key]) => !key.startsWith("ctx.")));
  try {
    const body = await screenGet<unknown>(screen, query);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
