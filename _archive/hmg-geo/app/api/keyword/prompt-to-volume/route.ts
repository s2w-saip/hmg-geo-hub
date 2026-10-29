import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter, defaultModel } from "@/lib/openrouter/client";
import { getKeywordVolumes } from "@/lib/keyword/service";
import { HttpError, requireAdminUser } from "@/lib/keyword/api";

// POST /api/keyword/prompt-to-volume
// Body: { promptText: string, locationCode?: number, languageCode?: string }
// → { volume, keywords, debug }
//
// Reverse of keyword→prompt: an LLM extracts 1-2 Google keywords from a prompt,
// then DataForSEO returns their max search volume. Admin only. Ported from
// aeorank (app/api/analysis/prompt-to-volume/route.ts).
export async function POST(req: NextRequest) {
  try {
    await requireAdminUser();

    const body = await req.json().catch(() => ({}));
    const { promptText, locationCode, languageCode } = body ?? {};

    if (!promptText || typeof promptText !== "string") {
      return NextResponse.json(
        { error: "promptText is required" },
        { status: 400 },
      );
    }

    // 1. Prompt → keywords.
    const systemPrompt = `Convert the given user prompt into Google search keywords that would help find the information the user is looking for.

Instructions:
- Analyze what the user is trying to find or learn from their prompt
- Convert it into 1-2 relevant Google search keywords in the SAME LANGUAGE as the prompt
- If the prompt is in Korean, return Korean keywords
- If the prompt is in English, return English keywords
- Focus on keywords that have reasonable search volume (not too long-tail)
- Include both broad and moderately specific keywords
- Think about what someone would actually type into Google to find this information

User Prompt: ${promptText}`;

    const llmResult = await callOpenRouter<{ keywords: string[] }>(systemPrompt, {
      model: defaultModel(),
      temperature: 0.3,
      maxOutputTokens: 200,
      responseSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 2,
          },
        },
        required: ["keywords"],
        additionalProperties: false,
      },
    });

    const keywords = llmResult.data?.keywords ?? [];
    if (keywords.length === 0) {
      return NextResponse.json({ volume: null, keywords: [] });
    }

    // 2. Keywords → volumes (cache-first).
    const volumes = await getKeywordVolumes(
      keywords,
      typeof locationCode === "number" ? locationCode : undefined,
      typeof languageCode === "string" ? languageCode : undefined,
      "search_volume",
    );
    if (volumes.length === 0) {
      return NextResponse.json({ volume: null, keywords });
    }

    const maxVolume = Math.max(...volumes.map((k) => k.search_volume || 0));

    return NextResponse.json({
      volume: maxVolume > 0 ? maxVolume : null,
      keywords,
      debug: {
        extractedKeywords: keywords,
        volumes: volumes.map((v) => ({
          keyword: v.keyword,
          volume: v.search_volume,
        })),
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[/api/keyword/prompt-to-volume] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch search volume",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
