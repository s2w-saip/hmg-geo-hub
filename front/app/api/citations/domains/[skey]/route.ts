import { NextRequest } from "next/server";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { decodeSkey, loadDomainDrilldown } from "@/lib/hgh/adapters/citations";
import { openCitationRoute, routeFail, routeJson } from "../../_lib/route";

// BFF: one source's drilldown, loaded when a citation domain row opens (unit U7, design 3.5 #6).
//
//   GET /api/citations/domains/<base64url(skey)>?<the screen's filter params>[&surface=website]
//       [&projectId=<uuid>]
//   200 {urls: CitationUrlLive[], promptList: CitationPromptLive[]}  (the legacy row fields)
//
// The path segment is the source group key in base64url: social account keys are host+path
// ("instagram.com/hyundai"), and a raw "/" would split the segment. A segment that is not the
// canonical base64url of a printable key -> 422 invalid_value.
// Gates and source: ../../_lib/route.ts (place gate and project gate on both sources, api only).
// Backend errors: hghErrorResponse (status kept, body {error:{code}}); 404 = the source is not in
// the window for these filters.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ skey: string }> }) {
  const { skey: segment } = await params;
  const skey = decodeSkey(segment);
  if (!skey) return routeFail(422, "invalid_value");
  const opened = await openCitationRoute(req.nextUrl.searchParams);
  if (opened instanceof Response) return opened;
  try {
    return routeJson(await loadDomainDrilldown(opened.filters, opened.ctx, skey));
  } catch (e) {
    return hghErrorResponse(e);
  }
}
