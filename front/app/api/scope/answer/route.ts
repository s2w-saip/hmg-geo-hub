import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for one AI answer body, looked up by ?jobId= (the id the answer modal holds on each answer
// reference), fetched per click. The modal sends the screen's URL filters (and projectId= or
// surface=website): screen mention/drill-answer gates the read like the legacy reader and answers
// the modal's payload ({available:false} when the answer is missing, hidden or out of scope).
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "mention/drill-answer");
}
