import { NextRequest } from "next/server";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { DOMAIN_PAGE, DOMAIN_SORTS } from "@/lib/hgh/citation-route";
import { screenGet } from "@/lib/screen";
import type { DomainListPageView } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { openCitationRoute, routeFail, routeJson } from "../_lib/route";

// BFF: citation domain table pages read by the client (unit U7, BG-21 search / sort, D5 cursor).
//
//   GET /api/citations/domains?<the screen's filter params>[&surface=website][&projectId=<uuid>]
//       [&q=<text>][&sort=citations|share|coverage|prompts|skey][&dir=asc|desc]
//       [&limit=1..200][&cursor=<next_cursor>]
//   200 {rows: CitationDomainLive[] (+ skey, rank, matchRank, no = the row's '#'), nextCursor, total, views}
//
// A thin proxy to the screen citation/domains (back/bff/screens/citation.py). The standard screen
// sends its ?competitor= picks too (they are part of its filter params). A bad sort / dir / limit ->
// 422 invalid_value; 409 cursor_stale is passed through (the client restarts from page one).
// Gates and source: ../_lib/route.ts.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const sort = q.get("sort") ?? "citations";
  const dir = q.get("dir");
  const limitRaw = q.get("limit");
  const limit = limitRaw === null ? DOMAIN_PAGE : Number(limitRaw);
  if (!DOMAIN_SORTS.has(sort) || (dir !== null && dir !== "asc" && dir !== "desc")) return routeFail(422, "invalid_value");
  if (!Number.isInteger(limit) || limit < 1 || limit > DOMAIN_PAGE) return routeFail(422, "invalid_value");
  const search = (q.get("q") ?? "").trim();
  if (search.length > 200 || /[\x00-\x1f\x7f]/.test(search)) return routeFail(422, "invalid_value");
  const opened = await openCitationRoute(q);
  if (opened instanceof Response) return opened;
  try {
    return routeJson(await screenGet<DomainListPageView>("citation/domains", opened.query));
  } catch (e) {
    return hghErrorResponse(e);
  }
}
