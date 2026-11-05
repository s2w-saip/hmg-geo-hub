import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for the renewal Overview's 근거 drawer (2026-11-05, D-12 step 3): a market cell's answers — the KPI's numerator
// (side=num) or the rest of its denominator (side=rest) among the market's representative answers, under the page's
// URL filters (+ market=<country> repeated, kpi, side, cursor). Screen overview/market-evidence.
// Body {items, total, nextCursor, counts?}; a bad request 400 {error}.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "overview/market-evidence");
}
