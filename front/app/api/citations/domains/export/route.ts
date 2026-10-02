import { NextRequest } from "next/server";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { DOMAIN_SORTS, relayDomainsExport, type DomainSort } from "@/lib/hgh/adapters/citations";
import { openCitationRoute, routeFail } from "../../_lib/route";

// BFF: the citation domain table as a file (unit U7, BG-22), streamed from the backend without
// buffering (lib/hgh/relay.ts: Content-Type, Content-Disposition attachment, X-Export-Truncated).
//
//   GET /api/citations/domains/export?<the screen's filter params>[&surface=website]
//       [&projectId=<uuid>][&q=<text>][&sort=...][&dir=asc|desc][&locale=ko|en][&max_rows=1..5000]
//
// The file is the legacy onExport 7 columns (rank, domain, category, citations, share, prompts,
// coverage) over the same search, sort and competitor pick as the table; '#' follows the surface
// rule (global = rank, website / project = match rank). Gates and source: ../../_lib/route.ts.
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
    return await relayDomainsExport(opened.filters, opened.ctx, {
      q: search,
      sort: sort as DomainSort,
      ...(dir ? { dir: dir as "asc" | "desc" } : {}),
      competitor: opened.competitor,
      locale,
      ...(maxRows ? { maxRows } : {}),
    });
  } catch (e) {
    return hghErrorResponse(e);
  }
}
