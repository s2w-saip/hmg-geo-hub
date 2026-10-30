import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for the 미언급 프롬프트 card's list (2026-10-30, the renewal Website Mention): the measured prompts where 당사
// is in no answer — the members of the card's count under the page's URL filters (+ surface=website / projectId=) —
// each with its latest answers. Screen mention/drill-missing-prompts. Body {prompts, total}; 403 / 404 {prompts:[]}.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "mention/drill-missing-prompts");
}
