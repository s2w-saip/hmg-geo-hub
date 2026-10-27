import type { NextRequest } from "next/server";
import { proxyDrill } from "../_drill/proxy";

// BFF for the 감정 분포 / Mention 유형 segment dialog: the prompts where the clicked signal
// (?signal=positive|neutral|mixed|negative|mention|recommendation|comparison|definition|final_choice)
// occurred, top 50 with 6 answer references each; each row opens the answer modal. Screen
// mention/drill-signal-prompts. Body {prompts, total?} (total only when the cap cut the list).
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return proxyDrill(req, "mention/drill-signal-prompts");
}
