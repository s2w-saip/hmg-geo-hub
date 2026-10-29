import { NextRequest, NextResponse } from "next/server";
import { getKeywordSearchGroups } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";

// POST /api/keyword/search
// Body: { keywords: string[], country?: string (ISO, e.g. "KR") }
// → { success, groups: { term, volume, intent, foundCount, related }[] }
//
// Multi-keyword search for the empty-state Google Keyword flow (a project
// with no tracked keywords yet): each searched term carries its own
// volume/intent plus its related terms, so "a, b, c" resolves to three
// groups in one round trip. Authenticated users only.
export async function POST(req: NextRequest) {
  try {
    await requireUser();

    const body = await req.json().catch(() => ({}));
    const keywords: string[] = Array.isArray(body?.keywords)
      ? body.keywords.filter(
          (k: unknown): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];
    if (keywords.length === 0) {
      return NextResponse.json({ error: "keywords array is required" }, { status: 400 });
    }
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
