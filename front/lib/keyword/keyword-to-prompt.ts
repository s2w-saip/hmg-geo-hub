import "server-only";
import { callOpenRouter, defaultModel } from "@/lib/openrouter/client";

/**
 * keyword → AI prompt (natural question) generation.
 * Ported from aeorank (app/api/question-explorer/generate-questions.ts). The
 * LLM call now goes through hmg-geo's OpenRouter client; the prompt text and
 * structured-output schema are preserved verbatim so output matches aeorank.
 */

export type SearchIntent =
  | "informational"
  | "navigational"
  | "transactional"
  | "commercial";

export interface GeneratedQuestion {
  originalInput: string;
  question: string;
  searchIntent: SearchIntent;
}

interface NaturalQuestionsResponse {
  questions: GeneratedQuestion[];
}

const QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          originalInput: {
            type: "string",
            description:
              "Original input (Simple Keyword or KeywordList-Title-Description combinations)",
          },
          question: {
            type: "string",
            description: "Natural question converted from the input",
          },
          searchIntent: {
            type: "string",
            enum: ["informational", "navigational", "transactional", "commercial"],
            description: "Search intent classification",
          },
        },
        required: ["originalInput", "question", "searchIntent"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

/** Generate one natural question per input keyword (single LLM call). */
export async function generateNaturalQuestions(
  keywords: string[],
  maxQuestions: number = 100,
): Promise<GeneratedQuestion[]> {
  const limitedKeywords = keywords.slice(0, maxQuestions);
  if (limitedKeywords.length === 0) return [];

  const prompt = `
You MUST convert ALL ${limitedKeywords.length} input items into natural questions. Do not skip any items.

Convert the following input items into underlying questions that people would actually ask ChatGPT or AI chatbots.

The input can be in two different formats:

1. **Simple keywords** (e.g., "electric car", "smartphones", "notion app")
   - Convert these into underlying questions that someone searching for this keyword would have
   - Focus on what the person really wants to know when they search for this term

2. **KeywordList-Title-Description combinations** (e.g., "[노션 사용법,노션 튜토리얼,notion guide]-노션 쓰는 방법 - 완벽한 노션 사용 가이드")
   - Format: "[keyword1,keyword2,keyword3]-Title - Description"
   - This represents a web document (Title-Description) that ranks for multiple keywords in SERP
   - The keywords inside the brackets are what this document ranks for
   - Create an underlying question that encompasses the intent behind these ranking keywords and the document content
   - Focus on the underlying question that connects the ranking keywords with the document's purpose
   - Try to include the one of the keywords in the question naturally, but do not force them in if it doesn't fit

CRITICAL REQUIREMENTS:
1. You MUST process ALL ${limitedKeywords.length} input items below
2. Generate EXACTLY ${limitedKeywords.length} questions (one for each input)
3. Make them sound like how people actually talk to AI (casual, informal, short)
4. Understand the underlying search intent behind each item and convert appropriately
5. Search intent categories: informational, navigational, transactional, commercial
6. For KeywordList-Title-Description format, analyze both the ranking keywords and the document content to understand the underlying user intent
7. Focus on the core underlying intent rather than trying to include every detail
8. Make sure all questions are in same language as the Inputs and contain NO brand names

Input list (${limitedKeywords.length} items):
${limitedKeywords.map((keyword, index) => `${index + 1}. ${keyword}`).join("\n")}

IMPORTANT: Your response must contain exactly ${limitedKeywords.length} questions, one for each numbered input item above.
`;

  const result = await callOpenRouter<NaturalQuestionsResponse>(prompt, {
    model: defaultModel(),
    temperature: 0.5,
    maxOutputTokens: 20000,
    responseSchema: QUESTIONS_SCHEMA,
  });

  if (!result.data?.questions || !Array.isArray(result.data.questions)) {
    throw new Error("Invalid keyword→prompt response format.");
  }
  return result.data.questions;
}

/**
 * Batch variant for large keyword sets — splits into parallel LLM calls and
 * flattens results. Failed batches contribute nothing rather than failing the
 * whole run (Promise.allSettled).
 */
export async function generateNaturalQuestionsBatch(
  keywords: string[],
  batchSize: number = 25,
  maxTotal: number = 500,
): Promise<GeneratedQuestion[]> {
  const limitedKeywords = keywords.slice(0, maxTotal);
  if (limitedKeywords.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < limitedKeywords.length; i += batchSize) {
    batches.push(limitedKeywords.slice(i, i + batchSize));
  }

  const results = await Promise.allSettled(
    batches.map((batch) => generateNaturalQuestions(batch, batch.length)),
  );

  const all: GeneratedQuestion[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.error("[keyword→prompt] batch failed:", r.reason);
  }
  return all;
}

/**
 * Attach search volume to generated questions using a keyword→volume map.
 * Handles both simple keywords and the "[kw1,kw2]-Title - Desc" bracket format
 * (sums the volumes of the bracketed keywords). Ported from aeorank's
 * keyword-to-prompt route.
 */
export function attachVolumes(
  questions: GeneratedQuestion[],
  keywordVolumeMap?: Record<string, number>,
): (GeneratedQuestion & { volume: number | null })[] {
  // The volume map is keyed on DataForSEO/sanitized keyword forms (often
  // lowercased), while originalInput is the raw keyword the LLM echoed back.
  // Normalize both sides so casing/whitespace differences don't silently drop
  // the volume (rendering "-" for keywords that actually have data).
  const norm = (k: string) => k.trim().toLowerCase();
  const normMap = keywordVolumeMap
    ? new Map(Object.entries(keywordVolumeMap).map(([k, v]) => [norm(k), v]))
    : undefined;
  return questions.map((question) => {
    let volume: number | null = null;
    if (normMap) {
      if (
        question.originalInput.startsWith("[") &&
        question.originalInput.includes("]-")
      ) {
        const keywordsPart = question.originalInput.split("]-")[0].substring(1);
        const keywordList = keywordsPart.split(",");
        let total = 0;
        let hasValid = false;
        for (const kw of keywordList) {
          const v = normMap.get(norm(kw));
          if (v !== null && v !== undefined) {
            total += v;
            hasValid = true;
          }
        }
        volume = hasValid ? total : null;
      } else {
        volume = normMap.get(norm(question.originalInput)) ?? null;
      }
    }
    return { ...question, volume };
  });
}
