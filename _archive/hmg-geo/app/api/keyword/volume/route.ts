import { NextRequest, NextResponse } from "next/server";
import { getKeywordVolumes } from "@/lib/keyword/service";
import { summarizeKeywordSearchVolume } from "@/lib/keyword/dataforseo";
import { HttpError, requireAdminUser } from "@/lib/keyword/api";

// POST /api/keyword/volume
// Body: { keywords: string[], locationCode?: number, languageCode?: string, sortBy?: string }
// → { success, keywords: KeywordSearchVolume[], summary, count }
//
// Cache-first DataForSEO search-volume lookup (lib/keyword/service.ts). Admin
// only — the underlying API is billable.
export async function POST(req: NextRequest) {
  try {
    await requireAdminUser();

    const body = await req.json().catch(() => ({}));
    const { keywords, locationCode, languageCode, sortBy } = body ?? {};

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { error: "keywords array is required and must not be empty" },
        { status: 400 },
      );
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
