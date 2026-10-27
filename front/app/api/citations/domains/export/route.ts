import { NextRequest, NextResponse } from "next/server";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { DOMAIN_SORTS } from "@/lib/hgh/citation-route";
import { screenGet } from "@/lib/screen";
import { openCitationRoute, routeFail } from "../../_lib/route";

// BFF: the citation domain table as a file (unit U7, BG-22).
//
//   GET /api/citations/domains/export?<the screen's filter params>[&surface=website]
//       [&projectId=<uuid>][&q=<text>][&sort=...][&dir=asc|desc][&locale=ko|en][&max_rows=1..5000]
//
// A thin proxy to the screen citation/domains-export (the export read with the table's search,
// sort and competitor pick). The Gold source has no export: the read answers 404, which this route
// returns as before (the client shows its export failure notice). Gates and source:
// ../../_lib/route.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const sort = q.get("sort") ?? "citations";
  const dir = q.get("dir");
  const locale = q.get("locale") ?? "ko";
  const maxRaw = q.get("max_rows");
  const maxRows = maxRaw === null ? undefined : Number(maxRaw);
  if (!DOMAIN_SORTS.has(sort) || (dir !== null && dir !== "asc" && dir !== "desc")) return routeFail(422, "invalid_value");
  if (locale !== "ko" && locale !== "en") return routeFail(422, "invalid_value");
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000)) return routeFail(422, "invalid_value");
  const search = (q.get("q") ?? "").trim();
  if (search.length > 200 || /[\x00-\x1f\x7f]/.test(search)) return routeFail(422, "invalid_value");
  const opened = await openCitationRoute(q);
  if (opened instanceof Response) return opened;
  try {
    const body = await screenGet<unknown>("citation/domains-export", opened.query);
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" },
    });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
