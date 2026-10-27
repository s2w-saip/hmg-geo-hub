import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for the mention drilldown's 인용출처 tab: the citation sources of the answers where one brand
// was mentioned ({domains, total?, orders}; rows carry skey, urls / promptList empty), and with
// &skey= one source's detail when its row opens ({urls, promptList, urlTotal?, promptTotal?},
// citation-domain-table.tsx). Screen mention/drill-brand-citations; same target and filter params as
// /api/scope/brand-mention-prompts.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "mention/drill-brand-citations");
}
