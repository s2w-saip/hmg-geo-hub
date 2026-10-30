import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { searchParamsToRecord } from "@/lib/search-params";

// BFF: the renewal Website › Prompts list's browser reads (/renewal/website/prompts, 2026-10-30).
//
//   GET /api/website/prompts/page?<page URL params>&page   -> screen website/prompts-page (one numbered page)
//   GET /api/website/prompts/rows?<page URL params>        -> screen website/prompts-rows (every row, list order)
//   GET /api/website/prompts/insights?<page URL params>    -> screen website/prompts-insights (counts of the list)
//
// GET, as the local read-only mode allows only reads outside /api/hub (a server action is a POST). Thin
// proxies: the gate, then the params pass through; the route context comes from the session, never from the
// browser (`ctx.*` dropped, ctx.admin = the account's role: the 브랜드 axis is the administrators').
// The original page's export stays /api/website/prompts/export (the static segment wins over [view]).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCREENS: Record<string, string> = {
  page: "website/prompts-page",
  rows: "website/prompts-rows",
  insights: "website/prompts-insights",
};

const fail = (status: number, code: string) => NextResponse.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ view: string }> }) {
  const screen = SCREENS[(await params).view];
  if (!screen) return fail(404, "not_found");
  const session = await getSession();
  if (!session) return fail(401, "unauthorized");
  // The 3rd argument (menu groups) is the account's menu gate; a route handler has no layout to apply it.
  if (!canAccessRoute(session.user.role, "/website/prompts", session.user.menuGroups)) return fail(403, "forbidden");
  const query = Object.fromEntries(Object.entries(searchParamsToRecord(req.nextUrl.searchParams)).filter(([key]) => !key.startsWith("ctx.")));
  try {
    const body = await screenGet<unknown>(screen, { ...query, "ctx.admin": session.user.role === "admin" });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
