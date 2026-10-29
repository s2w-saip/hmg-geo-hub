// LLM verbatim 추출 → 멘션 레이어 조립 — store.ts 에서 무수정 이동.
import { splitCompoundBrandSurface } from "../compound-brand";
import type { analyzeMeasurementTurn } from "../core";
import type { LlmExtractedMention, MentionExtractionResult } from "../llm";
import {
  compactSurface,
  contextSnippet,
  inferSurfaceLanguage,
  normalizeSurface,
  sliceAtCodePointBoundary,
  surfaceHash,
} from "../normalize";
import {
  resolverAuthorityForMethod,
  resolverAuthorityPriority,
  type MeasurementCandidate,
  type MeasurementMention,
  type OntologyCatalogEntity,
} from "../schema";
import {
  filterExcludedContextCandidates,
  filterExcludedContextMentions,
} from "./filters";
import {
  candidateKindForEntityType,
  isAcrMetricImpactMention,
  isFinalChoiceCueForMention,
  isGenericFeatureLikeProductSurface,
  llmMentionCandidateSignature,
  normalizeLlmAssertion,
  normalizeLlmMentionRole,
} from "./mention-classify";
import {
  mentionsReferToSameSurface,
  mergeLlmSemantics,
  resolveLlmMentionIdentity,
  resolveLlmMentionSpan,
  sentenceWindow,
} from "./surface-identity";

/** 턴 루프가 멘션 레이어에 넘기는 최소 턴 정보 (store.ts:235~238 무수정 이동). */
export interface LlmMentionLayerTurnInput {
  turnAnswerText: string | null;
  turnIndex: number;
}

// A deterministic-only match on a short, single-token, digit-free surface — in
// ANY script: "is", "air", "GM", "현대"(modern), "기아"(starvation) — can be a
// common word rather than a brand. When the gate is on, such a match is kept
// only if the context-reading extraction LLM also surfaced it (corroboration).
// Digit-bearing badges ("EV6", "G80", "911", "X5") and multi-token / longer
// surfaces are distinctive enough to stand on the deterministic match alone.
// This is language-agnostic: no per-language stopword list — the LLM judges by
// meaning in the answer's own language.
export function deterministicSurfaceNeedsCorroboration(
  surfaceText: string,
): boolean {
  const s = surfaceText.trim();
  if (!s || /\s/.test(s) || /[0-9]/.test(s)) return false;
  return Array.from(s).length <= 3;
}

export function buildMentionsFromLlmExtraction(input: {
  extraction: MentionExtractionResult;
  analysis: ReturnType<typeof analyzeMeasurementTurn>;
  turn: LlmMentionLayerTurnInput;
  catalog: OntologyCatalogEntity[];
  gateShortDeterministic?: boolean;
}): { mentions: MeasurementMention[]; candidates: MeasurementCandidate[] } {
  if (input.extraction.mentions.length === 0) {
    return { mentions: filterExcludedContextMentions(input.analysis.mentions), candidates: [] };
  }
  // 결합 브랜드 표면("삼성·LG")은 하나의 엔티티가 아니라 두 브랜드의 병렬
  // 언급이다 — 모든 파트가 카탈로그의 서로 다른 Brand 로 확인될 때만 구성
  // 표면으로 분해한다(compound-brand.ts). canonical_guess/추정 스팬은 결합
  // 표면의 것이므로 파트에 전파하지 않는다.
  const extractionMentions = input.extraction.mentions.flatMap((mention) => {
    if (mention.entityType === "Product") return [mention];
    const parts = splitCompoundBrandSurface(mention.surfaceText, input.catalog);
    if (!parts) return [mention];
    return parts.map((part) => ({
      ...mention,
      surfaceText: part,
      entityType: "Brand" as const,
      canonicalGuess: undefined,
      startChar: undefined,
      endChar: undefined,
    }));
  });
  const llmItems = extractionMentions
    .filter((mention) => !isLowQualityLlmMentionSurface(mention))
    .map((mention, idx) =>
      mentionFromLlmExtraction({
        mention,
        turn: input.turn,
        catalog: input.catalog,
        fallbackPosition: idx + 1,
      }),
    );
  if (llmItems.length === 0) {
    return {
      mentions: filterExcludedContextMentions(input.analysis.mentions),
      candidates: filterExcludedContextCandidates(input.analysis.candidates),
    };
  }
  const usedBase = new Set<number>();
  const mergedItems = llmItems.map((item) => {
    const baseIdx = input.analysis.mentions.findIndex(
      (base, idx) =>
        !usedBase.has(idx) && mentionsReferToSameSurface(base, item.mention),
    );
    if (baseIdx < 0) return item;
    usedBase.add(baseIdx);
    const mention = mergeLlmSemantics(
      input.analysis.mentions[baseIdx]!,
      item.mention,
    );
    return {
      mention,
      candidate:
        mention.resolutionStatus === "pending" ? item.candidate : undefined,
    };
  });
  const mentions = mergedItems.map((item) => item.mention);
  // Surface-LEVEL (not occurrence-level) LLM corroboration: a surface the LLM
  // tagged ANYWHERE in this turn vouches for ALL deterministic occurrences of
  // it. "Kia" appears 5× but the LLM tags it once → all 5 kept; "is"/"air" the
  // LLM never tags → all dropped. (Occurrence-level gating wrongly killed
  // multi-mention real brands because the LLM dedupes surfaces.)
  //
  // CASE-SENSITIVE (raw, not normalized): the LLM's "IS" badge must NOT vouch
  // for the word "is". Real badges/brands appear in proper case ("IS", "Kia");
  // common-word collisions are lowercase ("is", "air"). A real IS mention still
  // enters via the LLM's own "IS"/"Lexus IS" item, so dropping the deterministic
  // word "is" loses nothing.
  const llmCorroboratedSurfaces = new Set(
    extractionMentions.map((m) => m.surfaceText.trim()),
  );
  for (const [idx, base] of input.analysis.mentions.entries()) {
    if (!usedBase.has(idx)) {
      // Short ambiguous deterministic-only match (is/air/현대/기아) whose exact
      // surface the LLM never tagged in this turn → the LLM's silence is evidence
      // it is a common word, not a brand. Distinctive / corroborated surfaces kept.
      if (
        input.gateShortDeterministic &&
        deterministicSurfaceNeedsCorroboration(base.surfaceText) &&
        !llmCorroboratedSurfaces.has(base.surfaceText.trim())
      ) {
        continue;
      }
      mentions.push(base);
    }
  }
  const candidates = mergedItems
    .map((item) => item.candidate)
    .filter((candidate): candidate is MeasurementCandidate => !!candidate);
  return {
    mentions: filterExcludedContextMentions(mentions),
    candidates: filterExcludedContextCandidates(candidates),
  };
}

export function buildLlmMentionLayerForTest(input: {
  extraction: MentionExtractionResult;
  analysis: ReturnType<typeof analyzeMeasurementTurn>;
  turn: LlmMentionLayerTurnInput;
  catalog: OntologyCatalogEntity[];
  gateShortDeterministic?: boolean;
}): { mentions: MeasurementMention[]; candidates: MeasurementCandidate[] } {
  return buildMentionsFromLlmExtraction(input);
}

export function mentionFromLlmExtraction(input: {
  mention: LlmExtractedMention;
  turn: LlmMentionLayerTurnInput;
  catalog: OntologyCatalogEntity[];
  fallbackPosition: number;
}): { mention: MeasurementMention; candidate?: MeasurementCandidate } {
  const answerText = input.turn.turnAnswerText ?? "";
  const llmMention = normalizeLlmExtractedMention(input.mention);
  const span = resolveLlmMentionSpan(answerText, llmMention);
  const context =
    span
      ? contextSnippet(answerText, span.start, span.end)
      : llmMention.evidenceSnippet ?? sliceAtCodePointBoundary(answerText, 0, 240);
  const normalized = normalizeSurface(llmMention.surfaceText);
  const resolved = resolveLlmMentionIdentity(llmMention, input.catalog);
  const sourceSentenceWindow = span
    ? sentenceWindow(answerText, span.start, span.end)
    : undefined;
  const metricImpactEntity =
    llmMention.entityType === "Brand" || llmMention.entityType === "Product";
  const finalChoiceCue =
    metricImpactEntity &&
    isFinalChoiceCueForMention({
      sentence: sourceSentenceWindow?.sentence,
      evidenceSnippet: llmMention.evidenceSnippet,
      context,
      surfaceText: llmMention.surfaceText,
    });
  // Role/assertion are derived from the turn the mention appears in, not from a
  // per-mention LLM assertion — the verbatim extraction returns only
  // {name, type}. Turn 1 is the shortlist, where every named brand/model is
  // appearance evidence (shortlist_candidate). The final "pick one" turn yields
  // the final choice: the cued/selected concrete entity is single_choice and the
  // rest are comparison_target. Non-metric surfaces stay background. The legacy /
  // deterministic path may still supply role/assertion — honor it when present.
  const role: MeasurementMention["mentionRole"] = !metricImpactEntity
    ? normalizeLlmMentionRole(llmMention)
    : input.turn.turnIndex > 1
      ? finalChoiceCue
        ? "single_choice"
        : (llmMention.mentionRole ?? "comparison_target")
      : (llmMention.mentionRole ?? "shortlist_candidate");
  const assertion: MeasurementMention["assertion"] = !metricImpactEntity
    ? normalizeLlmAssertion(llmMention)
    : input.turn.turnIndex > 1
      ? finalChoiceCue
        ? "final_choice"
        : (llmMention.assertion ?? "compare")
      : (llmMention.assertion ?? "compare");
  const sentiment = llmMention.sentiment ?? "neutral";
  const baseMetadata = {
    source: "llm_mention_extraction",
    canonical_guess: llmMention.canonicalGuess,
    evidence_snippet: llmMention.evidenceSnippet,
    source_sentence_window: sourceSentenceWindow,
    source_start: span?.start,
    source_end: span?.end,
    source_verified: Boolean(span),
    suggested_entity_type: llmMention.entityType,
    llm_suggested_entity_type: input.mention.entityType,
    entity_type_normalized: llmMention.entityType !== input.mention.entityType,
    resolution_authority_level: resolverAuthorityForMethod(
      resolved.method ?? "llm_proposal",
    ),
    resolution_authority_priority: resolverAuthorityPriority(
      resolved.method ?? "llm_proposal",
    ),
  };

  const mention: MeasurementMention = {
    entityId: resolved.entityId,
    entityType: resolved.entityType ?? llmMention.entityType ?? null,
    surfaceText: llmMention.surfaceText,
    surfaceLanguage: inferSurfaceLanguage(llmMention.surfaceText),
    surfaceNormalized: normalized,
    surfaceHash: surfaceHash(llmMention.surfaceText),
    sourceStart: span?.start,
    sourceEnd: span?.end,
    resolutionStatus: resolved.status,
    resolutionMethod: resolved.method ?? "llm_proposal",
    resolutionConfidence: resolved.confidence ?? llmMention.confidence ?? 0.55,
    mentionPosition: llmMention.mentionPosition ?? input.fallbackPosition,
    mentionRole: role,
    assertion,
    sentiment,
    rank: llmMention.rank,
    rankGroup: llmMention.rankGroup,
    contextSnippet: context,
    descriptors: llmMention.descriptors,
    criteria: llmMention.criteria,
    extractionMetadata: {
      ...baseMetadata,
      matched_surface: resolved.matchedSurface,
      conflict_entity_ids: resolved.conflictEntityIds,
    },
  };

  if (mention.resolutionStatus !== "pending" || !llmMention.entityType) {
    return { mention };
  }
  const candidate: MeasurementCandidate = {
    candidateKind: candidateKindForEntityType(llmMention.entityType),
    // 산식 사본을 만들지 않는다 — 정본은 llmMentionCandidateSignature 하나다
    // (change candidate-append-only, A16ⓓ. 이전에는 같은 리터럴이 두 벌이었다).
    signature: llmMentionCandidateSignature({
      entityType: llmMention.entityType,
      surfaceNormalized: normalized,
      mentionRole: role,
      assertion,
    }),
    surfaceText: llmMention.surfaceText,
    surfaceNormalized: normalized,
    surfaceVariants: [
      ...new Set(
        [llmMention.surfaceText, llmMention.canonicalGuess].filter(
          (v): v is string => !!v,
        ),
      ),
    ],
    suggestedEntityType: llmMention.entityType,
    confidence: llmMention.confidence,
    answerSnippets: [context],
    metricImpact: {
      source: "llm_mention_extraction",
      entity_type: llmMention.entityType,
      mention_role: role,
      assertion,
      metric_impact: isAcrMetricImpactMention(mention, input.turn.turnIndex),
    },
  };
  return { mention, candidate };
}

export function normalizeLlmExtractedMention(
  mention: LlmExtractedMention,
): LlmExtractedMention {
  const nonMetricEntityType = nonMetricEntityTypeForLlmSurface(mention);
  if (nonMetricEntityType) {
    return {
      ...mention,
      entityType: nonMetricEntityType,
      mentionRole: "background",
      assertion: "mention_only",
      rank: undefined,
      rankGroup: undefined,
    };
  }
  if (
    (mention.entityType === "Product" || mention.entityType === "Brand") &&
    isGenericFeatureLikeProductSurface(mention)
  ) {
    return {
      ...mention,
      entityType: "Feature",
      mentionRole: "background",
      assertion: "mention_only",
      rank: undefined,
      rankGroup: undefined,
    };
  }
  return mention;
}

export function isLowQualityLlmMentionSurface(mention: LlmExtractedMention): boolean {
  const surface = mention.surfaceText.trim();
  if (!surface) return true;
  const normalized = normalizeSurface(surface);
  if (!normalized) return true;
  if (surface.length > 80) return true;
  if (isKoreanGrammarFragmentSurface(normalized, surface)) return true;
  if (isEnglishDescriptorSurface(normalized)) return true;
  if (isCombinedCatalogSurface(surface)) return true;
  if (
    (mention.entityType === "Brand" || mention.entityType === "Product") &&
    isGenericCategoryOnlySurface(normalized)
  ) {
    return false;
  }
  return false;
}

export function nonMetricEntityTypeForLlmSurface(
  mention: LlmExtractedMention,
): "Feature" | "ProductCategory" | null {
  if (mention.entityType !== "Brand" && mention.entityType !== "Product") {
    return null;
  }
  const normalized = normalizeSurface(mention.surfaceText);
  if (!normalized) return null;
  if (isNonMetricAutomotiveOrgOrServiceSurface(mention.surfaceText)) return "Feature";
  if (isGenericFeatureLikeProductSurface(mention)) return "Feature";
  if (isGenericCategoryOnlySurface(normalized)) return "ProductCategory";
  return null;
}

export function isKoreanGrammarFragmentSurface(
  normalized: string,
  rawSurface: string,
): boolean {
  if (!/[가-힣]/.test(rawSurface)) return false;
  const compact = compactSurface(normalized);
  if (/^(?:은|는|이|가|을|를|으로|에게|에서|에는)(?:\s|$)/u.test(normalized)) {
    return true;
  }
  if (
    /(?:합니다|드립니다|되겠습니다|겠습니다|같습니다|쉽습니다|좋습니다|적합합니다|말씀드립니다|정리합니다|보겠습니다|있습니다)$/u.test(
      compact,
    )
  ) {
    return true;
  }
  if (
    /(?:^모두|하면$|한다면|해야한다면|선택해야|추천하면|고르라면|다음과같|차량은|모델은|선택은|추천은|1대만선택|선택$|추천$)/u.test(
      compact,
    )
  ) {
    return true;
  }
  return false;
}

export function isEnglishDescriptorSurface(normalized: string): boolean {
  return /^(?:family|business|executive|premium|budget|urban|starter|winter|camping|pet|safe|teen|long[-\s]*highway|crossover|vehicle|car)(?:\s+(?:family|business|executive|premium|budget|urban|starter|winter|camping|pet|safe|teen|long[-\s]*highway|crossover|vehicle|car|suv|sedan|ev|hev|hybrid))*$/i.test(
    normalized,
  );
}

export function isGenericCategoryOnlySurface(normalized: string): boolean {
  return /^(?:차량|자동차|하이브리드|전기|전기차|내연기관|중소형|준중형|준대형|소형|중형|대형|컴팩트|크로스오버|패밀리|가족용|업무용|법인|임원차|장거리|도심형|프리미엄|안전|안전성|쪽|계열|타입|compact|crossover|family|business|executive|premium|hybrid|hev|phev|electric|ev|gas|diesel|suv|sedan|vehicle|car|category|option|choice|model|모델|제품|브랜드|카테고리)(?:\s+(?:차량|자동차|하이브리드|전기|전기차|내연기관|중소형|준중형|준대형|소형|중형|대형|컴팩트|크로스오버|패밀리|가족용|업무용|법인|임원차|장거리|도심형|프리미엄|안전|안전성|쪽|계열|타입|compact|crossover|family|business|executive|premium|hybrid|hev|phev|electric|ev|gas|diesel|suv|sedan|vehicle|car|category|option|choice|model|모델|제품|브랜드|카테고리))*$/i.test(
    normalized,
  );
}

export function isCombinedCatalogSurface(surface: string): boolean {
  return /\s(?:&|\+|and|및|와|과)\s/u.test(surface.trim());
}

export function isNonMetricAutomotiveOrgOrServiceSurface(surface: string): boolean {
  const normalized = normalizeSurface(surface);
  const compact = compactSurface(surface);
  return (
    /^(?:hyundai|kia|genesis)\s+(?:usa|america|motor\s+america|motors\s+america)$/i.test(
      normalized,
    ) ||
    /^(?:suburbanhyundai|reddit|레딧|블루핸즈|bluehands|bluelink|차량)$/i.test(
      compact,
    ) ||
    /(?:현대차그룹|현대자동차그룹|hyundaimotorgroup|kiamotorgroup|hmg)$/i.test(
      compact,
    )
  );
}
