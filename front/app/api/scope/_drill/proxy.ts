import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { DrillScreenReply } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/drilldown-screen-types";

// The mention drilldown routes (/api/scope/brand-mention-prompts, /brand-citations,
// /signal-prompts, /answer) are proxies of the screens mention/drill-* (back/bff/screens/
// mention_drilldown.py), which decide every status and body the routes answered before (parameter
// checks, the project gate, the filter reading, the backend reads, the error mapping) and add the
// values the drilldown components used to compute.
//
// The route keeps the session check (no session -> 401 {error: "unauthorized"}) and sends its
// search params exactly as received (repeated keys and empty values included) as one JSON list,
// `ctx.params`. A failure the screen raises (a backend 5xx, a timeout) is answered with
// hghErrorResponse ({error: {code}} with its status), as the routes did with backend failures.

export type DrillScreen = "mention/drill-brand-prompts" | "mention/drill-brand-citations" | "mention/drill-signal-prompts" | "mention/drill-answer" | "mention/drill-missing-prompts";

export async function proxyDrill(req: NextRequest, screen: DrillScreen): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const reply = await screenGet<DrillScreenReply>(screen, { "ctx.params": JSON.stringify([...req.nextUrl.searchParams]) });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (err) {
    return hghErrorResponse(err);
  }
}
