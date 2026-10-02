import { NextRequest, NextResponse } from "next/server";
import { getKeywordVolumes } from "@/lib/keyword/service";
import { summarizeKeywordSearchVolume } from "@/lib/keyword/dataforseo";
import { HttpError, requireAdminUser } from "@/lib/keyword/api";
import * as api from "@/lib/hgh/adapters/admin";

// POST /api/keyword/volume
// Body: { keywords: string[], locationCode?: number, languageCode?: string, sortBy?: string }
// → { success, keywords: KeywordSearchVolume[], summary, count }
//
// Cache-first DataForSEO search-volume lookup (lib/keyword/service.ts). Admin
// only — the underlying API is billable.
//
// Gate (both sources, before anything else): admin + the keyword-tools screen gate (menu
// groups). Source (D8, HGH_SOURCE_G7): api relays POST /v1/admin/keyword-tools/volume, waits a
// bounded time for queued collection and answers the same body (+ `pending` terms, U11-N4).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdminUser();
    if (!api.canUseKeywordTools(user)) throw new HttpError(403, "forbidden");

    const body = await req.json().catch(() => ({}));
    const { keywords, locationCode, languageCode, sortBy } = body ?? {};

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { error: "keywords array is required and must not be empty" },
        { status: 400 },
      );
    }

    if (api.isAdminApi()) {
      try {
        const out = await api.lookupKeywordVolumes(
          keywords.filter((k): k is string => typeof k === "string"),
          typeof locationCode === "number" ? locationCode : undefined,
          typeof languageCode === "string" ? languageCode : undefined,
        );
        return NextResponse.json({
          success: true,
          keywords: out.keywords,
          summary: out.summary,
          count: out.keywords.length,
          ...(out.pending.length > 0 ? { pending: out.pending } : {}),
        });
      } catch (e) {
        const r = api.keywordRouteError(e, "Failed to fetch keyword volumes");
        return NextResponse.json(r.body, { status: r.status });
      }
    }

    const volumes = await getKeywordVolumes(
      keywords,
      typeof locationCode === "number" ? locationCode : undefined,
      typeof languageCode === "string" ? languageCode : undefined,
      typeof sortBy === "string" ? sortBy : "search_volume",
    );

    return NextResponse.json({
      success: true,
      keywords: volumes,
      summary: summarizeKeywordSearchVolume(volumes),
      count: volumes.length,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/volume] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch keyword volumes",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
