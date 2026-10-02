import { NextRequest, NextResponse } from "next/server";
import { getKeywordSearchGroups } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  isIntentApi,
  keywordPreset,
  keywordRouteGate,
  loadKeywordSearchGroups,
  MAX_SEARCH_TERMS,
  uniqueSearchTerms,
} from "@/lib/hgh/adapters/intent";
import { legacyKeywordProjectAllowed } from "../_lib/legacy-project-gate";

// POST /api/keyword/search
// Body: { keywords: string[], country?: string (ISO, e.g. "KR"), projectId?: uuid }
// → { success, groups: { term, volume, intent, foundCount, related }[] }
//
// Multi-keyword search for the empty-state Google Keyword flow (a project
// with no tracked keywords yet): each searched term carries its own
// volume/intent plus its related terms, so "a, b, c" resolves to three
// groups in one round trip. Authenticated users only.
//
// Source (D8, unit U10): HGH_SOURCE_G6=api reads the backend (lib/hgh/adapters/intent.ts
// loadKeywordSearchGroups: stored data, operator-only collection + polling under one shared
// budget); legacy (default) is the live DataForSEO path. On BOTH sources, first the place gate
// (keywordRouteGate, U10-N12, verification D1 / D3; same rule as /api/keyword/insight), then at
// most MAX_SEARCH_TERMS unique trimmed terms (400 above, U10-N14, verification D2).
export const maxDuration = 120;

async function apiSearch(body: Record<string, unknown>, keywords: string[], projectId: string | undefined): Promise<NextResponse> {
  try {
    const groups = await loadKeywordSearchGroups(keywords, { country: keywordPreset(body.country), projectId });
    return NextResponse.json({ success: true, groups });
  } catch (e) {
    return hghErrorResponse(e) as NextResponse;
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();

    const body = await req.json().catch(() => ({}));
    const gate = await keywordRouteGate(user, body?.projectId, legacyKeywordProjectAllowed);
    if (!gate.ok) return gate.response as NextResponse;
    const keywords: string[] = Array.isArray(body?.keywords)
      ? body.keywords.filter(
          (k: unknown): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];
    if (keywords.length === 0) {
      return NextResponse.json({ error: "keywords array is required" }, { status: 400 });
    }
    if (uniqueSearchTerms(keywords).length > MAX_SEARCH_TERMS) {
      return NextResponse.json({ error: `at most ${MAX_SEARCH_TERMS} keywords` }, { status: 400 });
    }
    if (isIntentApi()) return await apiSearch(body ?? {}, keywords, gate.projectId);
    const preset =
      getPresetById(String(body?.country ?? "kr").toLowerCase()) ??
      getPresetById("kr")!;

    const groups = await getKeywordSearchGroups(
      keywords,
      preset.location_code,
      preset.language_code,
    );
    return NextResponse.json({ success: true, groups });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/search] error:", err);
    return NextResponse.json(
      {
        error: "Failed to search keywords",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
