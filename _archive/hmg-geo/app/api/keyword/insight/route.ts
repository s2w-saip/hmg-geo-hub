import { NextRequest, NextResponse } from "next/server";
import { getKeywordInsight } from "@/lib/keyword/insight";
import { getPresetById } from "@/lib/keyword/location-presets";
import { HttpError, requireUser } from "@/lib/keyword/api";

// POST /api/keyword/insight
// Body: { keyword: string, country?: string (ISO, e.g. "KR") }
// → KeywordInsight { label, trend[] (12mo raw volume), serp[] }
//
// Live data for one Google Keyword tab: 12-month search-volume trend + SERP rows
// with LLM-drafted prompts. Cached (best-effort) so refreshes are cheap. The
// period filter is a client-side slice/normalize, so range is not a param here.
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
