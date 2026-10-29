// Deterministic tracked-brand presence capture (change
// capture-tracked-brand-factual-mentions).
//
// The LLM verbatim-extraction prompt is tuned for consumer purchase-decision
// recommendations, so it under-tags a project's OWN brand when it appears in a
// factual / support answer ("LG 가전 이상 시 LG전자 고객센터 1544-7777"). Worse,
// when the tracked entity is out of the project's industry scope, the scoped
// analysis catalog can contain a same-surface NON-tracked duplicate entity that
// absorbs the mention (2026-07-25 LG 생활가전: tracked LG resolves to entities in
// other industries; the scoped catalog holds an untracked "LG Electronics").
// Either way the answer is recorded with zero tracked mentions and the risk
// index counts it as a miss (missRate ≥ 0.8 → forced `critical`).
//
// This layer is the deterministic floor: after LLM extraction + resolution, if a
// tracked brand's surface is present in the answer but nothing in the turn rolls
// up to that tracked brand, add exactly one conservative mention resolved to a
// representative tracked entity. Tracked-only (never tags arbitrary brands),
// no-duplicate (skips a brand already captured), non-destructive (never edits
// existing mentions).

import {
  type MeasurementEntityType,
  type MeasurementMention,
  resolverAuthorityForMethod,
  resolverAuthorityPriority,
} from "./schema";
import {
  contextSnippet,
  inferSurfaceLanguage,
  normalizeSurface,
  surfaceHash,
} from "./normalize";
import { locateSurfaceMatch } from "./surface-match";
import type { GroupingIndex } from "@/lib/brand-grouping/types";

export interface TrackedBrandConfigEntry {
  brand_name: string;
  alternative_names?: string[];
  aliases?: string[];
}

/** An ontology entity a tracked-brand surface resolved to, with its surfaces. */
export interface TrackedEntityRow {
  id: string;
  /** entities.type — only Brand/Product entities can host a metric mention */
  type: string;
  canonicalName: string;
  aliases: string[];
}

export interface TrackedBrandAugmentTarget {
  /** config brand_name — the dedup group id / log label */
  brandKey: string;
  representativeEntityId: string;
  representativeCanonical: string;
  entityType: MeasurementEntityType;
  /** every entity id this tracked brand resolves to (membership for dedup) */
  entityIds: string[];
  /** union of config surfaces + resolved entities' canonical + aliases */
  surfaces: string[];
}

const lowerKey = (s: string): string => s.trim().toLowerCase();

export function normalizeTrackedBrandConfig(value: unknown): TrackedBrandConfigEntry[] {
  if (!Array.isArray(value)) return [];
  const out: TrackedBrandConfigEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      brand_name?: unknown;
      alternative_names?: unknown;
      aliases?: unknown;
    };
    if (typeof row.brand_name !== "string" || !row.brand_name.trim()) continue;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    out.push({
      brand_name: row.brand_name,
      alternative_names: strings(row.alternative_names),
      aliases: strings(row.aliases),
    });
  }
  return out;
}

function configSurfacesOf(entry: TrackedBrandConfigEntry): string[] {
  return [
    entry.brand_name,
    ...(entry.alternative_names ?? []),
    ...(entry.aliases ?? []),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Group tracked_brands config → resolved ontology entities → augment targets.
 * An entity belongs to a group when its canonical name OR any alias equals a
 * config surface (trim + lowercase — the SAME rule as
 * `resolveTrackedEntityIds`), so grouping is consistent with the downstream
 * tracked-ness judgment. Pure: `entityRows` is the already-fetched candidate
 * set (resolved against the FULL ontology, not the industry-scoped catalog).
 */
/**
 * 보정 대상을 만든다.
 *
 * `grouping` 을 넘기면 **프로젝트 묶음 규칙이 다른 묶음으로 보낸 글자를
 * 검색 목록에서 뺀다** (change project-brand-grouping, design.md D6).
 *
 * 왜 필요한가: `tracked_brands` 별칭 목록은 이 보정 레이어가 "이 글자가 보이면
 * 우리 브랜드"로 삼는 목록이다. 담당자가 규칙으로 "베스트샵" 을 LG전자에서
 * 떼어냈는데 별칭 목록에 그 글자가 남아 있으면, 규칙이 떼어낸 것을 보정이
 * 합성 언급으로 도로 붙인다 — 같은 프로젝트 안에서 두 진실이 다툰다.
 * 2026-07-26 LG RCA 가 지적한 범주 오류의 현장이 정확히 이 목록이다.
 */
export function buildTrackedAugmentTargets(
  config: TrackedBrandConfigEntry[],
  entityRows: TrackedEntityRow[],
  grouping?: GroupingIndex,
): TrackedBrandAugmentTarget[] {
  const targets: TrackedBrandAugmentTarget[] = [];
  const seenBrandKeys = new Set<string>();
  for (const entry of config) {
    const brandKey = entry.brand_name.trim();
    if (!brandKey || seenBrandKeys.has(lowerKey(brandKey))) continue;
    const configSurfaces = configSurfacesOf(entry);
    const configKeys = new Set(configSurfaces.map(lowerKey));
    const matched = entityRows.filter(
      (e) =>
        configKeys.has(lowerKey(e.canonicalName)) ||
        e.aliases.some((a) => configKeys.has(lowerKey(a))),
    );
    // Only Brand/Product entities can host a metric mention; a tracked brand
    // that resolves to nothing usable is skipped (caller logs the count).
    const usable = matched.filter(
      (e) => e.type === "Brand" || e.type === "Product",
    );
    if (usable.length === 0) continue;
    const surfaceCount = (e: TrackedEntityRow): number =>
      1 + e.aliases.length;
    // Representative = richest identity (most surfaces), tie-break smallest id —
    // deterministic when a tracked surface resolves to duplicate entities.
    const representative = [...usable].sort(
      (a, b) => surfaceCount(b) - surfaceCount(a) || (a.id < b.id ? -1 : 1),
    )[0]!;
    // Surfaces to search: config surfaces PLUS every resolved entity's canonical
    // + aliases (dedup by lowercased key, first original-case kept).
    const surfaceByKey = new Map<string, string>();
    const addSurface = (s: string): void => {
      const t = s.trim();
      if (!t) return;
      const k = lowerKey(t);
      if (!surfaceByKey.has(k)) surfaceByKey.set(k, t);
    };
    for (const s of configSurfaces) addSurface(s);
    for (const e of matched) {
      addSurface(e.canonicalName);
      for (const a of e.aliases) addSurface(a);
    }
    const entityIds = matched.map((e) => e.id);
    const memberIds = new Set(entityIds);
    // 규칙이 이 브랜드 밖으로 보낸 글자는 검색 목록에서 뺀다. 브랜드 레벨만
    // 보는 이유: 보정이 만드는 것은 브랜드/제품 언급 1건이고, 그것이 어느
    // 칸에 세어질지를 정하는 것이 브랜드 레벨 규칙이다.
    const surfaces = [...surfaceByKey.values()].filter((s) => {
      if (!grouping || grouping.surfaceCount === 0) return true;
      const normalized = normalizeSurface(s);
      for (const id of entityIds) {
        const routed = grouping.surfaceRule(id, normalized, "brand");
        if (routed && !memberIds.has(routed)) return false;
      }
      return true;
    });
    targets.push({
      brandKey,
      representativeEntityId: representative.id,
      representativeCanonical: representative.canonicalName,
      entityType: representative.type === "Product" ? "Product" : "Brand",
      // Dedup membership spans ALL matched entities (incl. non-Brand/Product),
      // so an existing mention on any of them counts as "already captured".
      entityIds,
      surfaces,
    });
    seenBrandKeys.add(lowerKey(brandKey));
  }
  return targets;
}

export interface TrackedBrandAugmentResult {
  mentions: MeasurementMention[];
  augmentedCount: number;
  augmentedBrandKeys: string[];
}

/**
 * Add at most one conservative tracked-brand mention per target when its
 * surface is present in the answer and the turn has no mention already rolling
 * up to that tracked brand (`coveredEntityIds` = entityId + rollup ids of the
 * existing mentions). Never edits existing mentions; never tags non-tracked
 * brands. Positions are provisional — the caller re-orders via
 * `normalizeMentionOrder`.
 */
export function augmentTrackedBrandMentions(input: {
  mentions: MeasurementMention[];
  answerText: string;
  turnIndex: number;
  targets: TrackedBrandAugmentTarget[];
  coveredEntityIds: Set<string>;
}): TrackedBrandAugmentResult {
  const out = [...input.mentions];
  const augmentedBrandKeys: string[] = [];
  const answerText = input.answerText ?? "";
  if (input.targets.length === 0 || !answerText.trim()) {
    return { mentions: out, augmentedCount: 0, augmentedBrandKeys };
  }
  // Local copy so an augment we just added also blocks a later overlapping
  // target: two tracked_brands entries can resolve to the SAME entity (e.g.
  // {"LG"} and {"LG전자"} both → LG전자). Without folding the newly-added entity
  // ids back in, both would emit a mention for the same brand in one turn —
  // harmless to the DISTINCT-turn miss rate, but inflates mention-count SoV.
  const covered = new Set(input.coveredEntityIds);
  for (const target of input.targets) {
    // Already captured for this turn (existing mention OR a prior augment) → skip.
    if (target.entityIds.some((id) => covered.has(id))) continue;
    const loc = locateSurfaceMatch(answerText, target.surfaces);
    if (!loc) continue;
    const surfaceText = answerText.slice(loc.start, loc.end);
    const isCanonicalHit =
      normalizeSurface(loc.surface) ===
      normalizeSurface(target.representativeCanonical);
    const method = isCanonicalHit ? "canonical_exact" : "alias_exact";
    out.push({
      entityId: target.representativeEntityId,
      entityType: target.entityType,
      surfaceText,
      surfaceLanguage: inferSurfaceLanguage(surfaceText),
      surfaceNormalized: normalizeSurface(surfaceText),
      surfaceHash: surfaceHash(surfaceText),
      sourceStart: loc.start,
      sourceEnd: loc.end,
      resolutionStatus: "resolved",
      resolutionMethod: method,
      resolutionConfidence: isCanonicalHit ? 1 : 0.98,
      // provisional; normalizeMentionOrder re-numbers by source offset
      mentionPosition: out.length + 1,
      mentionRole: "background",
      assertion: "mention_only",
      sentiment: "neutral",
      contextSnippet: contextSnippet(answerText, loc.start, loc.end),
      descriptors: [],
      criteria: [],
      extractionMetadata: {
        source: "tracked_surface_augment",
        augmented: true,
        tracked_brand_key: target.brandKey,
        matched_surface: loc.surface,
        source_start: loc.start,
        source_end: loc.end,
        source_verified: true,
        resolution_authority_level: resolverAuthorityForMethod(method),
        resolution_authority_priority: resolverAuthorityPriority(method),
      },
    });
    for (const id of target.entityIds) covered.add(id);
    augmentedBrandKeys.push(target.brandKey);
  }
  return {
    // 오프셋은 UTF-16 그대로 내보낸다 — 코드포인트 변환은 영속 직전 choke point
    // (store.ts analysisForPersist.mentions) 한 곳에서만 한다(scope#632 최종 리뷰).
    mentions: out,
    augmentedCount: augmentedBrandKeys.length,
    augmentedBrandKeys,
  };
}
