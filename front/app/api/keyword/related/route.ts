import { NextRequest, NextResponse } from "next/server";
import { getRelatedKeywords } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  isIntentApi,
  keywordPreset,
  keywordRouteGate,
  loadRelatedKeywords,
} from "@/lib/hgh/adapters/intent";
import { legacyKeywordProjectAllowed } from "../_lib/legacy-project-gate";

// POST /api/keyword/related
// Body: { keyword: string, country?: string (ISO, e.g. "KR"), projectId?: uuid }
// → { foundCount, items: { id, term, volume, intent }[] }
//
// Live "관련 검색어" panel: DataForSEO keyword suggestions for a seed keyword.
// Authenticated users only.
//
// Source (D8, unit U10): HGH_SOURCE_G6=api reads the backend (lib/hgh/adapters/intent.ts
// loadRelatedKeywords: stored data, operator-only collection + polling); legacy (default) is the
// live DataForSEO path. On BOTH sources the place gate runs first (keywordRouteGate, U10-N12,
// verification D1 / D3; same rule as /api/keyword/insight).
export const maxDuration = 120;

async function apiRelated(body: Record<string, unknown>, keyword: string, projectId: string | undefined): Promise<NextResponse> {
  try {
    const related = await loadRelatedKeywords({ term: keyword, country: keywordPreset(body.country), projectId });
    return NextResponse.json({ success: true, ...related });
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
    const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) {
      return NextResponse.json({ error: "keyword is required" }, { status: 400 });
    }
    if (isIntentApi()) return await apiRelated(body ?? {}, keyword, gate.projectId);
    const preset =
      getPresetById(String(body?.country ?? "kr").toLowerCase()) ??
      getPresetById("kr")!;

    const related = await getRelatedKeywords(
      keyword,
      preset.location_code,
      preset.language_code,
    );
    return NextResponse.json({ success: true, ...related });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/related] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load related keywords",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
