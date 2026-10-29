import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { searchParamsToRecord } from "@/lib/search-params";

// BFF: one 분포 sheet of the renewal ACR page, read when its tab opens (2026-10-29: every sheet's rows were
// 94% of the page's answer, so the page comes with the sheet tabs and the first sheet).
//
//   GET /api/standard/acr/sheet?<the page's URL params>&sheet=<country>|<engine>  -> screen acr/renewal-sheet
//   200 {sheet: AcrDistSheet | null}
//
// A thin proxy like /api/standard/prompts: the gate, then the params pass through (route context `ctx.*` is
// not taken from the browser).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fail = (status: number, code: string) => NextResponse.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return fail(401, "unauthorized");
  // The 3rd argument (menu groups) is the account's menu gate; a route handler has no layout to apply it.
  if (!canAccessRoute(session.user.role, "/renewal/standard/ai-funnel/acr", session.user.menuGroups)) return fail(403, "forbidden");
  const query = Object.fromEntries(Object.entries(searchParamsToRecord(req.nextUrl.searchParams)).filter(([key]) => !key.startsWith("ctx.")));
  try {
    return NextResponse.json(await screenGet<unknown>("acr/renewal-sheet", query), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
