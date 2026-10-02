import { NextRequest, NextResponse } from "next/server";
import {
  generateNaturalQuestions,
  generateNaturalQuestionsBatch,
  attachVolumes,
} from "@/lib/keyword/keyword-to-prompt";
import { HttpError, requireAdminUser } from "@/lib/keyword/api";
import * as api from "@/lib/hgh/adapters/admin";

// POST /api/keyword/to-prompt
// Body: { keywords: string[], keywordVolumeMap?: Record<string, number>, maxQuestions?: number }
// → { success, data: { questions, totalQuestions, sourceKeywords } }
//
// Converts keywords (or "[kw1,kw2]-Title - Desc" rows) into natural AI prompts
// via OpenRouter. Admin only — the LLM call is billable.
//
// Gate (both sources, before anything else): admin + the keyword-tools screen gate (menu
// groups). Source (D8, HGH_SOURCE_G7): api relays POST /v1/admin/keyword-tools/to-prompt (the LLM
// call runs on the backend) and answers the same body. maxDuration sits above the BFF timeout of
// the call (KEYWORD_LLM_TIMEOUT_MS 185 s = the backend LLM cap 180 s + margin, as legacy's abort).
export const maxDuration = 200;

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdminUser();
    if (!api.canUseKeywordTools(user)) throw new HttpError(403, "forbidden");

    const body = await req.json().catch(() => ({}));
    const { keywords, keywordVolumeMap, maxQuestions = 100 } = body ?? {};

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { error: "keywords array is required and must not be empty" },
        { status: 400 },
      );
    }

    const limit = typeof maxQuestions === "number" ? maxQuestions : 100;

    if (api.isAdminApi()) {
      try {
        const data = await api.keywordsToPrompts(
          keywords.filter((k): k is string => typeof k === "string"),
          keywordVolumeMap && typeof keywordVolumeMap === "object"
            ? (keywordVolumeMap as Record<string, number>)
            : undefined,
          limit,
        );
        return NextResponse.json({ success: true, data });
      } catch (e) {
        const r = api.keywordRouteError(e, "Failed to generate prompts");
        return NextResponse.json(r.body, { status: r.status });
      }
    }

    // Large sets → parallel batches; small sets → single call.
    const questions =
      keywords.length > 25
        ? await generateNaturalQuestionsBatch(keywords, 10, limit)
        : await generateNaturalQuestions(keywords, limit);

    const questionsWithVolume = attachVolumes(
      questions,
      keywordVolumeMap && typeof keywordVolumeMap === "object"
        ? (keywordVolumeMap as Record<string, number>)
        : undefined,
    );

    return NextResponse.json({
      success: true,
      data: {
        questions: questionsWithVolume,
        totalQuestions: questionsWithVolume.length,
        sourceKeywords: keywords.length,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/to-prompt] error:", err);
    return NextResponse.json(
      {
        error: "Failed to generate prompts",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
