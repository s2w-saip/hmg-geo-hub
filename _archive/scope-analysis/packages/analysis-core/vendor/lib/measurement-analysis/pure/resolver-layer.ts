// pending 멘션 LLM 해석 레이어 — store.ts 에서 무수정 이동.
//
// 유일한 수정: `resolver` 파라미터 타입이
// `NonNullable<AnalyzeRunOptions["mentionResolver"]>` → `AnalysisLlmDeps["resolve"]`.
// 두 타입은 구조가 같다(`pure/deps.ts` 헤더 참고) — `AnalyzeRunOptions` 는
// `sharedAnalysisContext`(DB 타입)를 물고 있어 순수 쪽으로 데려올 수 없다.
import type { PendingMentionResolutionResult } from "../llm";
import { contextSnippet, normalizeSurface } from "../normalize";
import {
  resolverAuthorityForMethod,
  resolverAuthorityPriority,
  type MeasurementCandidate,
  type MeasurementMention,
  type OntologyCatalogEntity,
} from "../schema";
import type { AnalysisLlmDeps } from "./deps";
import type { LlmMentionLayerTurnInput } from "./llm-mention-layer";
import {
  candidateSignatureForMention,
  isAcrMetricImpactMention,
  isLlmResolverEligibleMention,
} from "./mention-classify";

export async function resolvePendingMentionLayerWithLlm(input: {
  layer: { mentions: MeasurementMention[]; candidates: MeasurementCandidate[] };
  turn: LlmMentionLayerTurnInput;
  catalog: OntologyCatalogEntity[];
  promptText?: string | null;
  industryName?: string | null;
  resolver: AnalysisLlmDeps["resolve"];
}): Promise<{
  layer: { mentions: MeasurementMention[]; candidates: MeasurementCandidate[] };
  result: PendingMentionResolutionResult;
  pendingCount: number;
  resolvedCount: number;
  ignoredCount: number;
  keptPendingCount: number;
} | null> {
  const pending = input.layer.mentions
    .map((mention, index) => ({ mention, index }))
    .filter(({ mention }) => isLlmResolverEligibleMention(mention));
  if (pending.length === 0) return null;

  const result = await input.resolver({
    promptText: input.promptText,
    answerText: input.turn.turnAnswerText ?? "",
    turnIndex: input.turn.turnIndex,
    catalog: input.catalog,
    industryName: input.industryName,
    pendingMentions: pending.map(({ mention, index }) => ({
      index,
      surfaceText: mention.surfaceText,
      entityType: mention.entityType,
      canonicalGuess:
        typeof mention.extractionMetadata.canonical_guess === "string"
          ? mention.extractionMetadata.canonical_guess
          : null,
      mentionRole: mention.mentionRole,
      assertion: mention.assertion,
      sentiment: mention.sentiment,
      contextSnippet: mention.contextSnippet,
      confidence: mention.resolutionConfidence,
    })),
  });

  if (result.failed || result.parserPartial) {
    return {
      layer: input.layer,
      result,
      pendingCount: pending.length,
      resolvedCount: 0,
      ignoredCount: 0,
      keptPendingCount: pending.length,
    };
  }

  const catalogById = new Map(input.catalog.map((entity) => [entity.id, entity]));
  const pendingByIndex = new Map(pending.map((item) => [item.index, item]));
  const usedPendingIndexes = new Set<number>();
  const consumedCandidateSignatures = new Set<string>();
  const replacementByIndex = new Map<number, MeasurementMention>();
  let resolvedCount = 0;
  let ignoredCount = 0;
  let keptPendingCount = 0;

  for (const decision of result.decisions) {
    const pendingItem =
      typeof decision.index === "number"
        ? pendingByIndex.get(decision.index)
        : pending.find(
            (item) =>
              !usedPendingIndexes.has(item.index) &&
              normalizeSurface(item.mention.surfaceText) ===
                normalizeSurface(decision.surfaceText),
          );
    if (!pendingItem || usedPendingIndexes.has(pendingItem.index)) continue;
    usedPendingIndexes.add(pendingItem.index);
    const { mention, index } = pendingItem;
    const resolverMetadata = {
      action: decision.action,
      existing_entity_id: decision.existingEntityId,
      canonical_name: decision.canonicalName,
      confidence: decision.confidence,
      reason: decision.reason,
      model_slug: result.modelSlug,
      trace_id: result.traceId,
    };
    if (decision.action === "resolve_existing") {
      const entity = decision.existingEntityId
        ? catalogById.get(decision.existingEntityId)
        : undefined;
      const confidence = decision.confidence ?? 0;
      // Trust the catalog entity the resolver explicitly chose, and adopt its
      // type — the LLM-guessed entity_type is only a hint and is often wrong
      // (e.g. "Hyundai Tucson" guessed as Brand still resolves to the Product).
      if (entity && confidence >= 0.82) {
        replacementByIndex.set(index, {
          ...mention,
          entityId: entity.id,
          entityType: entity.type,
          resolutionStatus: "resolved",
          resolutionMethod: "llm_proposal",
          resolutionConfidence: Math.max(mention.resolutionConfidence, confidence),
          extractionMetadata: {
            ...mention.extractionMetadata,
            matched_surface: decision.canonicalName ?? entity.canonicalName,
            llm_pending_resolver: resolverMetadata,
            resolution_authority_level: resolverAuthorityForMethod("llm_proposal"),
            resolution_authority_priority:
              resolverAuthorityPriority("llm_proposal"),
          },
        });
        consumedCandidateSignatures.add(candidateSignatureForMention(mention));
        resolvedCount++;
        continue;
      }
    }

    // ignore_non_metric declassifies a surface the resolver judges is not a
    // consumer brand/model choice (cited source, publication, dealer, parent
    // company, feature/powertrain, generic phrase). Allow it even for a
    // metric-looking mention (e.g. a citation guessed as a Brand shortlist) —
    // otherwise such noise blocks delivery forever — but require resolver
    // confidence when the mention currently looks metric-impacting, so a real
    // choice is never silently dropped on a low-confidence guess.
    if (
      decision.action === "ignore_non_metric" &&
      (!isAcrMetricImpactMention(mention) || (decision.confidence ?? 0) >= 0.6)
    ) {
      replacementByIndex.set(index, {
        ...mention,
        resolutionStatus: "rejected",
        resolutionMethod: "llm_proposal",
        resolutionConfidence: Math.max(
          mention.resolutionConfidence,
          decision.confidence ?? 0,
        ),
        extractionMetadata: {
          ...mention.extractionMetadata,
          llm_pending_resolver: resolverMetadata,
          resolution_authority_level: resolverAuthorityForMethod("llm_proposal"),
          resolution_authority_priority: resolverAuthorityPriority("llm_proposal"),
        },
      });
      consumedCandidateSignatures.add(candidateSignatureForMention(mention));
      ignoredCount++;
      continue;
    }

    replacementByIndex.set(index, {
      ...mention,
      extractionMetadata: {
        ...mention.extractionMetadata,
        llm_pending_resolver: resolverMetadata,
      },
    });
    keptPendingCount++;
  }

  keptPendingCount += pending.length - usedPendingIndexes.size;

  return {
    layer: {
      mentions: input.layer.mentions.map((mention, index) =>
        replacementByIndex.get(index) ?? mention,
      ),
      candidates: input.layer.candidates.filter(
        (candidate) => !consumedCandidateSignatures.has(candidate.signature),
      ),
    },
    result,
    pendingCount: pending.length,
    resolvedCount,
    ignoredCount,
    keptPendingCount,
  };
}

export async function resolvePendingMentionLayerForTest(input: {
  layer: { mentions: MeasurementMention[]; candidates: MeasurementCandidate[] };
  turn: LlmMentionLayerTurnInput;
  catalog: OntologyCatalogEntity[];
  promptText?: string | null;
  resolver: AnalysisLlmDeps["resolve"];
}): Promise<NonNullable<Awaited<ReturnType<typeof resolvePendingMentionLayerWithLlm>>>> {
  const resolved = await resolvePendingMentionLayerWithLlm(input);
  if (!resolved) {
    throw new Error("expected pending mentions for resolver test");
  }
  return resolved;
}
