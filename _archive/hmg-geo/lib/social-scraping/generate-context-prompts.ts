import "server-only";
import { callOpenRouter, defaultModel } from "@/lib/openrouter/client";
import type {
  ContextSeedPool,
  GeneratedPrompt,
  PromptLayer,
  FunnelStage,
} from "@/components/social-scraping/types";

/**
 * 구매 맥락 지도(scope_context_* 실 미러) → 프로젝트/브랜드별 후보 프롬프트 생성.
 *
 * Replaces the static `getGeneratedPrompts()` fixture. The context map itself
 * is brand-neutral industry corpus, so differentiation (decision B, 2026-07-09)
 * comes from the *project's* brand context — which segment/competitors the
 * project tracks biases the framing of the generated questions, while the
 * questions stay brand-neutral (so measurement can observe which brand the AI
 * surfaces). The LLM call goes through hmg-geo's OpenRouter client, whose base
 * URL / model are env-swappable for a future customer-specific API.
 */

export interface BrandContext {
  /** projects.brand — HMG / Hyundai / Kia / Genesis (free-text, nullable). */
  brand: string | null;
  /** tracked competitor display names. */
  competitors: string[];
  /** tracked vehicle/model names. */
  vehicles: string[];
}

const MAX_CONTEXTS = 6;
const MAX_CONDITIONS = 4;
const MAX_INTERSECTIONS = 4;

// A seed carries the deterministic provenance (layer / sourceLabel / priority);
// only the natural-language `question` + `funnelStage` are asked of the LLM.
// Exported for the 구성(selection) flow — selection-seeds.ts builds these from
// user-picked rows instead of the auto Top-N pool.
export interface Seed {
  id: string;
  layer: PromptLayer;
  sourceLabel: string;
  priority: number;
  /** concept fed to the LLM (context / condition names, brand-neutral). */
  concept: string;
}

function bucketPriority(value: number, max: number): number {
  if (max <= 0) return 50;
  return Math.max(1, Math.min(100, Math.round((value / max) * 100)));
}

const STRENGTH_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

// `excludeIds` = seed ids already generated (from the project's cache). Seeds
// are drawn from the sorted-by-mention pool *after* skipping those, so each
// "더 생성" round pulls fresh contexts/conditions/combinations.
//
// 2026-07-15: input changed from the full ContextMatrix to ContextSeedPool —
// the matrix no longer exists (the context map is paged now), and seeding wants
// "the strongest N", which a page cannot express. The pool preserves the exact
// Top-N the matrix used to carry, so what gets generated is unchanged.
//
// NOTE on depth: an earlier version of this comment claimed the pool reaches a
// "1.7k / 2.4k / 5.7k long tail". It never did — the matrix handed in here was
// already capped at 150/200/500, so the real exhaustion point is ~850 seeds.
// Whether the pool SHOULD reach deeper is an open product question (it moves the
// "더 생성" exhaustion point and the OpenRouter cost); see
// openspec/changes/2026-07-15-add-context-map-query/design.md D2.
//
// Seed id formats are load-bearing and MUST NOT change: they are the keys in
// every project's persisted exclude set. Changing one would make already-
// generated prompts reappear on the next "더 생성".
//   L1: `l1-<contextId>`
//   L2: `l2-<conditionId>`
//   L3: `l3-<condAId>:<condBId>`        (combination — colon-joined)
//   L3: `l3-<contextId>-<conditionId>`  (drive fallback — hyphen-joined)
function buildSeeds(pool: ContextSeedPool, excludeIds?: Set<string>): Seed[] {
  const seeds: Seed[] = [];
  const has = (id: string) => excludeIds?.has(id) ?? false;

  const contexts = [...pool.contexts].sort((a, b) => b.mentionCount - a.mentionCount);
  const maxCtx = contexts[0]?.mentionCount ?? 0;
  for (const c of contexts.filter((c) => !has(`l1-${c.id}`)).slice(0, MAX_CONTEXTS)) {
    seeds.push({
      id: `l1-${c.id}`,
      layer: "L1-context",
      sourceLabel: c.name,
      priority: bucketPriority(c.mentionCount, maxCtx),
      concept: c.name,
    });
  }

  const conditions = [...pool.conditions].sort((a, b) => b.mentionCount - a.mentionCount);
  const maxCond = conditions[0]?.mentionCount ?? 0;
  for (const c of conditions.filter((c) => !has(`l2-${c.id}`)).slice(0, MAX_CONDITIONS)) {
    seeds.push({
      id: `l2-${c.id}`,
      layer: "L2-condition",
      sourceLabel: c.name,
      priority: bucketPriority(c.mentionCount, maxCond),
      concept: c.name,
    });
  }

  // L3 — intersections. Prefer condition↔condition combinations (they carry a
  // co-occurrence count); fall back to context→condition drives.
  // Names now arrive JOINed on the pool rows; the old code resolved them from a
  // Map of every loaded condition, which only held because nothing was paged.
  const combos = [...pool.combinations].sort((a, b) => b.coCount - a.coCount);
  const maxCombo = combos[0]?.coCount ?? 0;
  for (const combo of combos
    .filter((c) => !has(`l3-${c.condAId}:${c.condBId}`))
    .slice(0, MAX_INTERSECTIONS)) {
    seeds.push({
      id: `l3-${combo.condAId}:${combo.condBId}`,
      layer: "L3-intersection",
      sourceLabel: `${combo.condAName} × ${combo.condBName}`,
      priority: bucketPriority(combo.coCount, maxCombo),
      concept: `${combo.condAName} + ${combo.condBName}`,
    });
  }
  if (seeds.filter((s) => s.layer === "L3-intersection").length === 0) {
    const drives = [...pool.drives].sort(
      (a, b) => (STRENGTH_WEIGHT[b.strength] ?? 0) - (STRENGTH_WEIGHT[a.strength] ?? 0),
    );
    for (const d of drives
      .filter((d) => !has(`l3-${d.contextId}-${d.conditionId}`))
      .slice(0, MAX_INTERSECTIONS)) {
      seeds.push({
        id: `l3-${d.contextId}-${d.conditionId}`,
        layer: "L3-intersection",
        sourceLabel: `${d.contextName} × ${d.conditionName}`,
        priority: STRENGTH_WEIGHT[d.strength] === 3 ? 85 : 70,
        concept: `${d.contextName} + ${d.conditionName}`,
      });
    }
  }

  return seeds;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          seedId: { type: "string", description: "The input seed id, echoed back" },
          question: {
            type: "string",
            description: "Natural consumer question derived from the seed concept",
          },
          funnelStage: {
            type: "string",
            enum: ["awareness", "consideration", "purchase"],
          },
        },
        required: ["seedId", "question", "funnelStage"],
        additionalProperties: false,
      },
    },
  },
  required: ["prompts"],
  additionalProperties: false,
};

interface LlmPrompt {
  seedId: string;
  question: string;
  funnelStage: FunnelStage;
}

function buildLlmPrompt(
  seeds: Seed[],
  brand: BrandContext,
  keyword: string,
): string {
  const brandLine = brand.brand
    ? `The project tracks the brand "${brand.brand}" in the ${keyword} category.`
    : `The project is in the ${keyword} category.`;
  const competitors = brand.competitors.length
    ? ` Competitors it monitors: ${brand.competitors.join(", ")}.`
    : "";
  const vehicles = brand.vehicles.length
    ? ` Models of interest: ${brand.vehicles.join(", ")}.`
    : "";

  return `
${brandLine}${competitors}${vehicles}

You convert "purchase context" seeds into the underlying questions real people
ask ChatGPT or AI chatbots when shopping in this category. Each seed is a buyer
context, a purchase condition, or a combination of them.

RULES:
1. Produce EXACTLY one question per seed, echoing its seedId.
2. Write questions the way people actually talk to AI (casual, short).
3. Frame each question so it is relevant to this project's segment/competitors,
   but keep every question BRAND-NEUTRAL — do NOT name any brand or model in the
   question text (the point is to observe which brand an AI surfaces).
4. Write in the same language as the seed concepts.
5. Classify each into a funnelStage: awareness | consideration | purchase.

Seeds (${seeds.length}):
${seeds.map((s) => `- seedId=${s.id} [${s.layer}] concept: ${s.concept}`).join("\n")}
`;
}

/**
 * Generate brand/project-differentiated candidate prompts from the real context
 * matrix. Returns [] if the matrix has no usable entities. Throws on LLM
 * failure (caller decides whether to fall back to the static fixture).
 */
export async function generateContextPrompts(
  pool: ContextSeedPool,
  brand: BrandContext,
  /** Industry label fed to the LLM for framing. Previously read off
   *  `matrix.keyword`, which the paged context map no longer carries. */
  keyword: string,
  opts?: { excludeIds?: Set<string> },
): Promise<GeneratedPrompt[]> {
  return generateFromSeeds(buildSeeds(pool, opts?.excludeIds), brand, keyword);
}

/**
 * The LLM half of generateContextPrompts, callable with an explicit seed list.
 * The 구성(selection) flow builds its seeds from user-picked rows
 * (selection-seeds.ts) instead of the auto Top-N pool, then joins here so both
 * paths share the same prompt, schema, and output mapping.
 */
export async function generateFromSeeds(
  seeds: Seed[],
  brand: BrandContext,
  keyword: string,
): Promise<GeneratedPrompt[]> {
  if (seeds.length === 0) return [];

  const result = await callOpenRouter<{ prompts: LlmPrompt[] }>(
    buildLlmPrompt(seeds, brand, keyword),
    {
      model: defaultModel(),
      temperature: 0.5,
      maxOutputTokens: 8000,
      responseSchema: RESPONSE_SCHEMA,
    },
  );

  const byId = new Map(seeds.map((s) => [s.id, s]));
  const out: GeneratedPrompt[] = [];
  for (const p of result.data?.prompts ?? []) {
    const seed = byId.get(p.seedId);
    if (!seed || !p.question?.trim()) continue;
    out.push({
      id: seed.id,
      question: p.question.trim(),
      layer: seed.layer,
      funnelStage: p.funnelStage,
      sourceLabel: seed.sourceLabel,
      priority: seed.priority,
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}
