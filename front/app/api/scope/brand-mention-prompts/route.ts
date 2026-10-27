import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for the mention drilldown's 프롬프트 tab: the prompts where one brand row's brand was
// mentioned (with answer references), fetched when the row opens. Screen
// mention/drill-brand-prompts: ?mentionBrand= (required; the mentioned brand, not the `brand`
// prompt facet), own=1 [+ ownCode=] for the own row, projectId= (project) or surface=website, plus
// the screen's URL filters. Body {prompts, total?, orders}: total only when the 2,000-row cap cut
// the list; rows carry bestRank / topRank, answers carry highlightTerms, orders = the table's column
// orders. 403 {prompts:[]} / 400 {prompts:[]} are the tab's error state.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "mention/drill-brand-prompts");
}
