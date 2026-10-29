// LLM 멘션 표면 → 카탈로그 정체성 해석과 오프셋 스팬 — store.ts 에서 무수정 이동.
import type { LlmExtractedMention } from "../llm";
import { compactSurface, contextSnippet, normalizeSurface } from "../normalize";
import { OFFSET_BASIS_KEY } from "../offsets";
import type { MeasurementMention, OntologyCatalogEntity } from "../schema";
import { isAcrMetricImpactMention } from "./mention-classify";

export function mentionsReferToSameSurface(
  a: MeasurementMention,
  b: MeasurementMention,
): boolean {
  if (a.entityId && b.entityId && a.entityId === b.entityId) return true;
  if (a.surfaceNormalized === b.surfaceNormalized) return true;
  if (
    typeof a.sourceStart === "number" &&
    typeof a.sourceEnd === "number" &&
    typeof b.sourceStart === "number" &&
    typeof b.sourceEnd === "number"
  ) {
    return a.sourceStart < b.sourceEnd && b.sourceStart < a.sourceEnd;
  }
  return false;
}

export function mergeLlmSemantics(
  base: MeasurementMention,
  llm: MeasurementMention,
): MeasurementMention {
  const upgradePendingIdentity =
    base.resolutionStatus === "pending" && llm.resolutionStatus === "resolved";
  const keepBaseMetricSemantics =
    isAcrMetricImpactMention(base) && !isAcrMetricImpactMention(llm);
  const mergedMetadata: Record<string, unknown> = {
    ...base.extractionMetadata,
    ...(upgradePendingIdentity
      ? {
          matched_surface: llm.extractionMetadata.matched_surface,
          resolution_authority_level:
            llm.extractionMetadata.resolution_authority_level,
          resolution_authority_priority:
            llm.extractionMetadata.resolution_authority_priority,
        }
      : {}),
    llm_mention_extraction: llm.extractionMetadata,
  };
  // 오프셋을 llm 쪽에서 가져오는 경우(base 에 오프셋이 없음), base 에 붙어 있던
  // offset_basis 표식은 그 값의 기준이 아니다 — 표식만 남으면 UTF-16 값을
  // 코드포인트라고 주장하게 되고 영속 choke point 가 멱등 판정으로 건너뛴다.
  if (base.sourceStart == null) delete mergedMetadata[OFFSET_BASIS_KEY];
  return {
    ...base,
    entityId: upgradePendingIdentity ? llm.entityId : base.entityId,
    entityType: upgradePendingIdentity ? llm.entityType : base.entityType,
    resolutionStatus: upgradePendingIdentity
      ? llm.resolutionStatus
      : base.resolutionStatus,
    resolutionMethod: upgradePendingIdentity
      ? llm.resolutionMethod
      : base.resolutionMethod,
    resolutionConfidence: upgradePendingIdentity
      ? llm.resolutionConfidence
      : base.resolutionConfidence,
    sourceStart: base.sourceStart ?? llm.sourceStart,
    sourceEnd: base.sourceEnd ?? llm.sourceEnd,
    mentionRole: keepBaseMetricSemantics ? base.mentionRole : llm.mentionRole,
    assertion: keepBaseMetricSemantics ? base.assertion : llm.assertion,
    sentiment: llm.sentiment,
    rank: llm.rank ?? base.rank,
    rankGroup: llm.rankGroup ?? base.rankGroup,
    contextSnippet: llm.contextSnippet || base.contextSnippet,
    descriptors: llm.descriptors.length > 0 ? llm.descriptors : base.descriptors,
    criteria: llm.criteria.length > 0 ? llm.criteria : base.criteria,
    extractionMetadata: mergedMetadata,
  };
}

export function resolveLlmMentionSpan(
  answerText: string,
  mention: LlmExtractedMention,
): { start: number; end: number } | null {
  if (
    typeof mention.startChar === "number" &&
    typeof mention.endChar === "number" &&
    mention.startChar >= 0 &&
    mention.endChar > mention.startChar &&
    mention.endChar <= answerText.length
  ) {
    const claimed = answerText.slice(mention.startChar, mention.endChar);
    if (surfacesEquivalent(claimed, mention.surfaceText)) {
      return { start: mention.startChar, end: mention.endChar };
    }
  }
  const idx = answerText
    .toLocaleLowerCase()
    .indexOf(mention.surfaceText.toLocaleLowerCase());
  if (idx >= 0) {
    return { start: idx, end: idx + mention.surfaceText.length };
  }
  return null;
}

export function surfacesEquivalent(a: string, b: string): boolean {
  return normalizeSurface(a) === normalizeSurface(b) || compactSurface(a) === compactSurface(b);
}

export function sentenceWindow(
  text: string,
  start: number,
  end: number,
): { before: string | null; sentence: string; after: string | null } {
  const sentenceBreak = /[.!?。！？]\s*|\n+/g;
  let leftBoundary = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceBreak.exec(text)) && match.index < start) {
    leftBoundary = sentenceBreak.lastIndex;
  }
  sentenceBreak.lastIndex = end;
  const rightMatch = sentenceBreak.exec(text);
  const rightBoundary = rightMatch ? sentenceBreak.lastIndex : text.length;
  const sentence = text.slice(leftBoundary, rightBoundary).trim();
  const before =
    text
      .slice(0, leftBoundary)
      .trim()
      .split(/\n+|[.!?。！？]\s*/)
      .filter(Boolean)
      .pop() ?? null;
  const after =
    text
      .slice(rightBoundary)
      .trim()
      .split(/\n+|[.!?。！？]\s*/)
      .filter(Boolean)[0] ?? null;
  return { before, sentence, after };
}

export function resolveLlmMentionIdentity(
  mention: LlmExtractedMention,
  catalog: OntologyCatalogEntity[],
): {
  status: MeasurementMention["resolutionStatus"];
  method?: MeasurementMention["resolutionMethod"];
  entityId: string | null;
  entityType: MeasurementMention["entityType"];
  confidence?: number;
  matchedSurface?: string;
  conflictEntityIds?: string[];
} {
  const probes = [
    mention.surfaceText,
    mention.canonicalGuess,
  ].filter((v): v is string => !!v && v.trim().length > 0);
  for (const probe of probes) {
    const matches: Array<{
      entity: OntologyCatalogEntity;
      method: MeasurementMention["resolutionMethod"];
      surface: string;
    }> = [];
    for (const entity of catalog) {
      if (mention.entityType && entity.type !== mention.entityType) continue;
      const surfaces = [
        { value: entity.canonicalName, method: "canonical_exact" as const },
        ...entity.aliases.map((alias) => ({
          value: alias.alias,
          method: "alias_exact" as const,
        })),
      ];
      const probeNorm = normalizeSurface(probe);
      const probeCompact = compactSurface(probe);
      for (const surface of surfaces) {
        if (
          normalizeSurface(surface.value) === probeNorm ||
          compactSurface(surface.value) === probeCompact
        ) {
          matches.push({ entity, method: surface.method, surface: surface.value });
        }
      }
    }
    const deduped = new Map<string, (typeof matches)[number]>();
    for (const match of matches) deduped.set(match.entity.id, match);
    const values = [...deduped.values()];
    if (values.length === 1) {
      const match = values[0]!;
      return {
        status: "resolved",
        method: match.method,
        entityId: match.entity.id,
        entityType: match.entity.type,
        confidence: match.method === "canonical_exact" ? 1 : 0.98,
        matchedSurface: match.surface,
      };
    }
    if (values.length > 1) {
      return {
        status: "conflict",
        method: "human_review",
        entityId: null,
        entityType: null,
        confidence: 0,
        conflictEntityIds: values.map((match) => match.entity.id),
      };
    }
  }
  const decoratedMatch = resolveDecoratedLlmMentionIdentity(
    mention,
    probes,
    catalog,
  );
  if (decoratedMatch) return decoratedMatch;
  return {
    status: "pending",
    method: "llm_proposal",
    entityId: null,
    entityType: mention.entityType ?? null,
    confidence: mention.confidence ?? 0.55,
  };
}

export function resolveDecoratedLlmMentionIdentity(
  mention: LlmExtractedMention,
  probes: string[],
  catalog: OntologyCatalogEntity[],
): {
  status: MeasurementMention["resolutionStatus"];
  method?: MeasurementMention["resolutionMethod"];
  entityId: string | null;
  entityType: MeasurementMention["entityType"];
  confidence?: number;
  matchedSurface?: string;
  conflictEntityIds?: string[];
} | null {
  if (mention.entityType !== "Product" && mention.entityType !== "Brand") {
    return null;
  }

  const matches: Array<{
    entity: OntologyCatalogEntity;
    method: MeasurementMention["resolutionMethod"];
    surface: string;
    score: number;
  }> = [];
  for (const probe of probes) {
    const probeCompact = compactSurface(stripDecorativePunctuation(probe));
    if (!probeCompact) continue;
    for (const entity of catalog) {
      if (entity.type !== mention.entityType) continue;
      const surfaces = catalogIdentitySurfaces(entity);
      for (const surface of surfaces) {
        const surfaceCompact = compactSurface(surface.value);
        if (!isDecoratedSurfaceMatch(probeCompact, surfaceCompact, entity.type)) {
          continue;
        }
        matches.push({
          entity,
          method: surface.method,
          surface: surface.value,
          score: surfaceCompact.length,
        });
      }
    }
  }
  if (matches.length === 0) return null;

  const bestByEntity = new Map<string, (typeof matches)[number]>();
  for (const match of matches) {
    const prev = bestByEntity.get(match.entity.id);
    if (!prev || match.score > prev.score) bestByEntity.set(match.entity.id, match);
  }
  const values = [...bestByEntity.values()].sort((a, b) => b.score - a.score);
  const topScore = values[0]!.score;
  const top = values.filter((match) => match.score === topScore);
  if (top.length === 1) {
    const match = top[0]!;
    return {
      status: "resolved",
      method: match.method === "canonical_exact" ? "canonical_exact" : "alias_exact",
      entityId: match.entity.id,
      entityType: match.entity.type,
      confidence: match.method === "canonical_exact" ? 0.96 : 0.94,
      matchedSurface: match.surface,
    };
  }
  return {
    status: "conflict",
    method: "human_review",
    entityId: null,
    entityType: null,
    confidence: 0,
    conflictEntityIds: top.map((match) => match.entity.id),
  };
}

export function catalogIdentitySurfaces(entity: OntologyCatalogEntity): Array<{
  value: string;
  method: "canonical_exact" | "alias_exact";
}> {
  return [
    { value: entity.canonicalName, method: "canonical_exact" as const },
    ...entity.aliases.map((alias) => ({
      value: alias.alias,
      method: "alias_exact" as const,
    })),
  ].filter((surface) => surface.value.trim().length >= 2);
}

export function stripDecorativePunctuation(surface: string): string {
  return surface
    .replace(/[()[\]{}]/g, " ")
    .replace(/[·•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDecoratedSurfaceMatch(
  probeCompact: string,
  surfaceCompact: string,
  entityType: OntologyCatalogEntity["type"],
): boolean {
  if (!surfaceCompact || probeCompact === surfaceCompact) return false;
  if (surfaceCompact.length < 3) return false;
  if (!probeCompact.includes(surfaceCompact)) return false;
  if (entityType === "Brand") {
    return surfaceCompact.length >= 4;
  }
  const remainder = probeCompact.replace(surfaceCompact, "");
  if (!remainder) return false;
  return isAllowedVehicleSurfaceDecorator(remainder);
}

export function isAllowedVehicleSurfaceDecorator(remainderCompact: string): boolean {
  if (!remainderCompact) return true;
  const normalized = remainderCompact
    .replace(/^(?:hyundai|kia|genesis|현대|기아|제네시스)/i, "")
    .replace(/(?:hyundai|kia|genesis|현대|기아|제네시스)$/i, "");
  if (!normalized) return true;
  return /^(?:mx5|mq4|lx2|lx3|cn7|awd|4wd|fwd|rwd|hybrid|hev|phev|ev|longrange|롱레인지|earth|어스|gtline|xline|xpro|nline|signature|prestige|calligraphy|캘리그래피|시그니처|프레스티지|가솔린|디젤|터보|하이브리드|전기|전동화|모델|트림|계열|사양|라인업|[0-9]+|[0-9]+t|[0-9]+가솔린|[0-9]+디젤|[0-9]+터보|[0-9]+인승|[0-9]+륜구동|[a-z]*[0-9][a-z0-9]*)+$/iu.test(
    normalized,
  );
}
