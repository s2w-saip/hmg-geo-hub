import { NextRequest, NextResponse } from "next/server";
import {
  generateNaturalQuestions,
  generateNaturalQuestionsBatch,
  attachVolumes,
} from "@/lib/keyword/keyword-to-prompt";
import { HttpError, requireAdminUser } from "@/lib/keyword/api";

// POST /api/keyword/to-prompt
// Body: { keywords: string[], keywordVolumeMap?: Record<string, number>, maxQuestions?: number }
// → { success, data: { questions, totalQuestions, sourceKeywords } }
//
// Converts keywords (or "[kw1,kw2]-Title - Desc" rows) into natural AI prompts
// via OpenRouter. Admin only — the LLM call is billable.
export async function POST(req: NextRequest) {
  try {
    await requireAdminUser();

    const body = await req.json().catch(() => ({}));
    const { keywords, keywordVolumeMap, maxQuestions = 100 } = body ?? {};

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { error: "keywords array is required and must not be empty" },
        { status: 400 },
      );
    }

    const limit = typeof maxQuestions === "number" ? maxQuestions : 100;

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
