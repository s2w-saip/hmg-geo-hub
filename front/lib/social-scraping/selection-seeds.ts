import type { Seed } from "./generate-context-prompts";

/**
 * 구성(selection) flow — turns user-picked context-map rows into LLM seeds.
 *
 * Pure module (no server-only import) so it unit-tests without the OpenRouter
 * client. The auto path stays in generate-context-prompts.ts::buildSeeds; this
 * builder differs in that the *user* decides which contexts / conditions /
 * combinations participate, and picked contexts × picked conditions are crossed
 * into intersection seeds (that crossing is the "구성" the flow is named for).
 *
 * Seed id formats are load-bearing and MUST match buildSeeds exactly — they are
 * the dedup keys against every project's persisted prompt set:
 *   L1: `l1-<contextId>`
 *   L2: `l2-<conditionId>`
 *   L3: `l3-<condAId>:<condBId>`        (combination — colon-joined)
 *   L3: `l3-<contextId>-<conditionId>`  (context×condition cross — hyphen-joined)
 */

export interface SelectionInput {
  contexts: Array<{ id: string; name: string; mentionCount: number }>;
  conditions: Array<{ id: string; name: string; mentionCount: number }>;
  combinations: Array<{ aId: string; aName: string; bId: string; bName: string }>;
  /** Cross picked contexts × picked conditions into L3 seeds. */
  cross: boolean;
  /** Seed ids already generated for this project — skipped, counted as skipped. */
  excludeIds: ReadonlySet<string>;
}

export interface SelectionSeeds {
  seeds: Seed[];
  /** Selected items dropped because their seed id was already generated. */
  skippedExisting: number;
}

// Per-round caps. A selection is user-bounded, but the cross product is not —
// 10 contexts × 10 conditions would be 100 LLM questions. Caps keep one round
// inside a single predictable OpenRouter call (~40 questions max).
export const MAX_SEL_CONTEXTS = 10;
export const MAX_SEL_CONDITIONS = 10;
export const MAX_SEL_COMBINATIONS = 10;
export const MAX_SEL_CROSSES = 12;

function bucket(value: number, max: number): number {
  if (max <= 0) return 50;
  return Math.max(1, Math.min(100, Math.round((value / max) * 100)));
}

export function buildSelectionSeeds(input: SelectionInput): SelectionSeeds {
  const seeds: Seed[] = [];
  let skippedExisting = 0;
  const has = (id: string) => input.excludeIds.has(id);

  const contexts = input.contexts.slice(0, MAX_SEL_CONTEXTS);
  const conditions = input.conditions.slice(0, MAX_SEL_CONDITIONS);
  const combinations = input.combinations.slice(0, MAX_SEL_COMBINATIONS);

  const maxCtx = Math.max(0, ...contexts.map((c) => c.mentionCount));
  const maxCond = Math.max(0, ...conditions.map((c) => c.mentionCount));

  for (const c of contexts) {
    if (has(`l1-${c.id}`)) {
      skippedExisting += 1;
      continue;
    }
    seeds.push({
      id: `l1-${c.id}`,
      layer: "L1-context",
      sourceLabel: c.name,
      priority: bucket(c.mentionCount, maxCtx),
      concept: c.name,
    });
  }

  for (const c of conditions) {
    if (has(`l2-${c.id}`)) {
      skippedExisting += 1;
      continue;
    }
    seeds.push({
      id: `l2-${c.id}`,
      layer: "L2-condition",
      sourceLabel: c.name,
      priority: bucket(c.mentionCount, maxCond),
      concept: c.name,
    });
  }

  for (const combo of combinations) {
    // The corpus stores a pair once in (cond_a, cond_b) order, but exclude sets
    // could hold either orientation — check both before generating.
    if (has(`l3-${combo.aId}:${combo.bId}`) || has(`l3-${combo.bId}:${combo.aId}`)) {
      skippedExisting += 1;
      continue;
    }
    seeds.push({
      id: `l3-${combo.aId}:${combo.bId}`,
      layer: "L3-intersection",
      sourceLabel: `${combo.aName} × ${combo.bName}`,
      priority: 80,
      concept: `${combo.aName} + ${combo.bName}`,
    });
  }

  if (input.cross) {
    // Strongest-first pairing so the cap keeps the highest-signal crosses.
    const orderedPairs = contexts
      .flatMap((ctx) =>
        conditions.map((cond) => ({
          ctx,
          cond,
          weight: ctx.mentionCount + cond.mentionCount,
        })),
      )
      .sort((a, b) => b.weight - a.weight);
    let crossed = 0;
    for (const { ctx, cond } of orderedPairs) {
      if (crossed >= MAX_SEL_CROSSES) break;
      const id = `l3-${ctx.id}-${cond.id}`;
      if (has(id)) {
        skippedExisting += 1;
        continue;
      }
      seeds.push({
        id,
        layer: "L3-intersection",
        sourceLabel: `${ctx.name} × ${cond.name}`,
        priority: Math.round(
          (bucket(ctx.mentionCount, maxCtx) + bucket(cond.mentionCount, maxCond)) / 2,
        ),
        concept: `${ctx.name} + ${cond.name}`,
      });
      crossed += 1;
    }
  }

  return { seeds, skippedExisting };
}
