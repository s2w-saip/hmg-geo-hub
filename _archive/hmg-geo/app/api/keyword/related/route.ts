import { NextRequest, NextResponse } from "next/server";
import { getRelatedKeywords } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";

// POST /api/keyword/related
// Body: { keyword: string, country?: string (ISO, e.g. "KR") }
// → { foundCount, items: { id, term, volume, intent }[] }
//
// Live "관련 검색어" panel: DataForSEO keyword suggestions for a seed keyword.
// Authenticated users only.
export async function POST(req: NextRequest) {
  try {
    await requireUser();

    const body = await req.json().catch(() => ({}));
    const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) {
      return NextResponse.json({ error: "keyword is required" }, { status: 400 });
    }
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
