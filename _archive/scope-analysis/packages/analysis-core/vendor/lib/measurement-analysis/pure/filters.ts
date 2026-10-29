// 제외 컨텍스트·superseded 필터와 멘션 정렬 — store.ts 에서 무수정 이동.
import { compactSurface, contextSnippet } from "../normalize";
import type { MeasurementCandidate, MeasurementMention } from "../schema";

export function normalizeMentionOrder(mentions: MeasurementMention[]): MeasurementMention[] {
  return [...mentions]
    .sort((a, b) => {
      const aStart = a.sourceStart ?? Number.MAX_SAFE_INTEGER;
      const bStart = b.sourceStart ?? Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
      return a.mentionPosition - b.mentionPosition;
    })
    .map((mention, idx) => ({ ...mention, mentionPosition: idx + 1 }));
}

export function filterExcludedContextMentions(
  mentions: MeasurementMention[],
): MeasurementMention[] {
  return mentions.filter((mention) => !hasExcludedOptionContext(mention));
}

export function filterExcludedContextCandidates(
  candidates: MeasurementCandidate[],
): MeasurementCandidate[] {
  return candidates.filter((candidate) => {
    const snippets = candidate.answerSnippets ?? [];
    return !snippets.some((snippet) =>
      hasExcludedOptionCue(snippet, candidate.surfaceText),
    );
  });
}

export function filterSupersededDeterministicFinalChoiceCandidates(
  candidates: MeasurementCandidate[],
  mentions: MeasurementMention[],
): MeasurementCandidate[] {
  const hasResolvedFinalChoice = mentions.some(
    (mention) =>
      mention.resolutionStatus === "resolved" &&
      (mention.entityType === "Brand" || mention.entityType === "Product") &&
      (mention.mentionRole === "single_choice" ||
        mention.assertion === "final_choice"),
  );
  if (!hasResolvedFinalChoice) return candidates;
  return candidates.filter(
    (candidate) =>
      candidate.metricImpact.source !== "deterministic_final_choice_unknown",
  );
}

export function hasExcludedOptionContext(mention: MeasurementMention): boolean {
  const window = mention.extractionMetadata.source_sentence_window as
    | { before?: unknown; sentence?: unknown; after?: unknown }
    | undefined;
  const text = [
    typeof window?.before === "string" ? window.before : "",
    typeof window?.sentence === "string" ? window.sentence : "",
    typeof window?.after === "string" ? window.after : "",
    mention.contextSnippet,
  ].join(" ");
  return hasExcludedOptionCue(text, mention.surfaceText);
}

export function hasExcludedOptionCue(text: string, surface: string): boolean {
  if (!text || !surface) return false;
  const compactText = compactSurface(text);
  const compactSurfaceText = compactSurface(surface);
  if (!compactText.includes(compactSurfaceText)) return false;
  const compactIdx = compactText.indexOf(compactSurfaceText);
  const compactBefore = compactText.slice(Math.max(0, compactIdx - 32), compactIdx);
  const compactAfter = compactText.slice(
    compactIdx + compactSurfaceText.length,
    compactIdx + compactSurfaceText.length + 40,
  );
  const lowerText = text.toLocaleLowerCase();
  const lowerSurface = surface.toLocaleLowerCase();
  const rawIdx = lowerText.indexOf(lowerSurface);
  const rawLocal =
    rawIdx >= 0
      ? text.slice(Math.max(0, rawIdx - 80), rawIdx + surface.length + 100)
      : text;
  return (
    /\b(?:unrelated|irrelevant)\b/i.test(rawLocal) ||
    /\b(?:not|never)\s+(?:be\s+)?(?:considered|included|treated)\b/i.test(
      rawLocal,
    ) ||
    /\bshould\s+(?:be\s+)?ignored\b/i.test(rawLocal) ||
    /\bignore(?:d)?\s+(?:for|in)\s+this\b/i.test(rawLocal) ||
    /\bnot\s+(?:an?\s+)?(?:appliance|laundry|home\s+appliance|car|vehicle|suv)\s+option\b/i.test(
      rawLocal,
    ) ||
    /(?:관련|상관)(?:이)?없|무관|선택지(?:가)?아니|분석대상(?:이)?아니/u.test(
      `${compactBefore}${compactSurfaceText}${compactAfter}`,
    )
  );
}
