import { NextRequest, NextResponse } from "next/server";
import { getKeywordInsight } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  isIntentApi,
  keywordPreset,
  keywordRouteGate,
  loadKeywordInsight,
} from "@/lib/hgh/adapters/intent";
import { legacyKeywordProjectAllowed } from "../_lib/legacy-project-gate";

// POST /api/keyword/insight
// Body: { keyword: string, country?: string (ISO, e.g. "KR"), fresh?: boolean, projectId?: uuid }
// → KeywordInsight { label, trend[] (12mo raw volume), serp[] }
//
// Live data for one Google Keyword tab: 12-month search-volume trend + SERP rows
// with LLM-drafted prompts. Cached (best-effort) so refreshes are cheap. The
// period filter is a client-side slice/normalize, so range is not a param here.
// Authenticated users only.
//
// Source (D8, unit U10): HGH_SOURCE_G6=api reads the backend (lib/hgh/adapters/intent.ts
// loadKeywordInsight: stored data, operator-only collection + polling, SERP drafts); legacy
// (default) is the live DataForSEO + LLM path. On BOTH sources the place gate runs first
// (keywordRouteGate, U10-N12, verification D1 / D3), before any backend, DataForSEO or LLM
// call: projectId present -> 400 unless a uuid, then the project page gate (ROUTES /projects
// rule, demo admin-only, admin or active member via GET /v1/projects/{id} on
// HGH_SOURCE_SESSION=api, else the legacy leaf gate) -> 403 / 404; projectId absent -> the
// standard keyword screen's ROUTES rule -> 403. The api SERP drafts call is sized to what is
// left of maxDuration (KEYWORD_ROUTE_MAX_DURATION_MS in intent.ts mirrors it: segment config
// must stay a literal here).
export const maxDuration = 120;

async function apiInsight(
  body: Record<string, unknown>,
  keyword: string,
  projectId: string | undefined,
  startedAt: number,
): Promise<NextResponse> {
  try {
    const insight = await loadKeywordInsight(
      { term: keyword, country: keywordPreset(body.country), projectId, fresh: body.fresh === true },
      // the SERP drafts call is sized to what is left of maxDuration from here (U10 N2)
      { startedAt },
    );
    return NextResponse.json({ success: true, insight });
  } catch (e) {
    return hghErrorResponse(e) as NextResponse;
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const user = await requireUser();

    const body = await req.json().catch(() => ({}));
    const gate = await keywordRouteGate(user, body?.projectId, legacyKeywordProjectAllowed);
    if (!gate.ok) return gate.response as NextResponse;
    const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) {
      return NextResponse.json({ error: "keyword is required" }, { status: 400 });
    }
    if (isIntentApi()) return await apiInsight(body ?? {}, keyword, gate.projectId, startedAt);

    const preset =
      getPresetById(String(body?.country ?? "kr").toLowerCase()) ??
      getPresetById("kr")!;

    const insight = await getKeywordInsight(
      keyword,
      preset.location_code,
      preset.language_code,
      { fresh: body?.fresh === true },
    );
    return NextResponse.json({ success: true, insight });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/insight] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load keyword insight",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
