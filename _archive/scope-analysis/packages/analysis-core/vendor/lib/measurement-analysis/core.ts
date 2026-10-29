import {
  AnalysisOptionsSchema,
  resolverAuthorityForMethod,
  resolverAuthorityPriority,
  type AnalysisOptions,
  type MeasurementCandidate,
  type MeasurementEntityType,
  type MeasurementMention,
  type MeasurementTurnAnalysisResult,
  type OntologyCatalogEntity,
} from "./schema";
import { classifyAnswerQuality } from "./quality";
import {
  compactSurface,
  contextSnippet,
  inferSurfaceLanguage,
  isAlphaNum,
  normalizeSurface,
  surfaceHash,
  turnHash,
} from "./normalize";

interface SurfaceEntry {
  entityId: string;
  entityType: MeasurementEntityType;
  canonicalName: string;
  surface: string;
  normalized: string;
  compact: string;
  language?: string;
  method: "canonical_exact" | "alias_exact";
}

interface SpanMatch {
  start: number;
  end: number;
  surfaceText: string;
  entries: SurfaceEntry[];
}

interface IndexedText {
  text: string;
  startMap: number[];
  endMap: number[];
}

export interface AnalyzeMeasurementTurnInput {
  promptText?: string | null;
  answerText: string | null | undefined;
  rawResponse?: string | null;
  turnIndex?: number;
  catalog: OntologyCatalogEntity[];
  options?: Partial<AnalysisOptions>;
}

export function analyzeMeasurementTurn(
  input: AnalyzeMeasurementTurnInput,
): MeasurementTurnAnalysisResult {
  const options = AnalysisOptionsSchema.parse(input.options ?? {});
  const answerText = input.answerText ?? "";
  const quality = classifyAnswerQuality(answerText);
  const sourceTurnHash = turnHash({
    promptText: input.promptText,
    answerText,
    rawResponse: input.rawResponse,
  });

  if (quality.qualityState !== "valid_answer") {
    return {
      quality,
      mentions: [],
      candidates: [],
      analysisVersion: options.analysisVersion,
      promptVersion: options.promptVersion,
      parserVersion: options.parserVersion,
      resolverVersion: options.resolverVersion,
      sourceTurnHash,
      extractionMetadata: {
        known_matches: 0,
        parser_partial: false,
        llm_mention_enabled: options.enableLlmMentionExtraction,
        llm_unknown_enabled: options.enableLlmUnknownDiscovery,
      },
    };
  }

  const matches = findDeterministicMatches(answerText, input.catalog);
  const mentions: MeasurementMention[] = [];
  const candidates: MeasurementCandidate[] = [];
  let position = 0;

  for (const match of matches) {
    position++;
    const semantics = inferMentionSemantics(answerText, match, input.turnIndex ?? 1);
    if (match.entries.length > 1) {
      const normalized = normalizeSurface(match.surfaceText);
      mentions.push({
        entityId: null,
        entityType: null,
        surfaceText: match.surfaceText,
        surfaceLanguage: inferSurfaceLanguage(match.surfaceText),
        surfaceNormalized: normalized,
        surfaceHash: surfaceHash(match.surfaceText),
        sourceStart: match.start,
        sourceEnd: match.end,
        resolutionStatus: "conflict",
        resolutionMethod: "human_review",
        resolutionConfidence: 0,
        mentionPosition: position,
        ...semantics,
        extractionMetadata: {
        conflict_entity_ids: match.entries.map((e) => e.entityId),
        conflict_reason: "same surface matched multiple approved ontology entries",
        source_start: match.start,
        source_end: match.end,
        source_verified: true,
        ...resolutionAuthorityMetadata("human_review"),
      },
      });
      candidates.push({
        candidateKind: "reject_surface",
        signature: candidateSignature("conflict", normalized, match.entries.map((e) => e.entityId)),
        surfaceText: match.surfaceText,
        surfaceNormalized: normalized,
        surfaceVariants: unique(match.entries.map((e) => e.surface)),
        confidence: 0,
        conflictReason: "alias_conflict",
        answerSnippets: [semantics.contextSnippet],
        metricImpact: { mention_role: semantics.mentionRole, assertion: semantics.assertion },
      });
      continue;
    }

    const entry = match.entries[0]!;
    mentions.push({
      entityId: entry.entityId,
      entityType: entry.entityType,
      surfaceText: match.surfaceText,
      surfaceLanguage: entry.language ?? inferSurfaceLanguage(match.surfaceText),
      surfaceNormalized: normalizeSurface(match.surfaceText),
      surfaceHash: surfaceHash(match.surfaceText),
      sourceStart: match.start,
      sourceEnd: match.end,
      resolutionStatus: "resolved",
      resolutionMethod: entry.method,
      resolutionConfidence: entry.method === "canonical_exact" ? 1 : 0.98,
      mentionPosition: position,
      ...semantics,
      extractionMetadata: {
        canonical_name: entry.canonicalName,
        matched_surface: entry.surface,
        source_start: match.start,
        source_end: match.end,
        source_verified: true,
        ...resolutionAuthorityMetadata(entry.method),
      },
    });
  }

  // The deterministic final-choice detector is a fallback for deterministic-only
  // mode. When LLM mention extraction is enabled it owns final-choice detection
  // (it understands sentence structure), and this heuristic otherwise grabs lead-in
  // sentence fragments ("고르라고 하면, 저는 ...") and hallucinated names as
  // single_choice Products that then block delivery. Skip it under LLM extraction.
  const unknownFinalChoices = options.enableLlmMentionExtraction
    ? []
    : findUnknownFinalChoiceCandidates({
        answerText,
        turnIndex: input.turnIndex ?? 1,
        matches,
        catalog: input.catalog,
      });
  for (const unknown of unknownFinalChoices) {
    position++;
    mentions.push({
      entityId: null,
      entityType: unknown.suggestedEntityType,
      surfaceText: unknown.surfaceText,
      surfaceLanguage: inferSurfaceLanguage(unknown.surfaceText),
      surfaceNormalized: unknown.surfaceNormalized,
      surfaceHash: surfaceHash(unknown.surfaceText),
      sourceStart: unknown.sourceStart,
      sourceEnd: unknown.sourceEnd,
      resolutionStatus: "pending",
      resolutionMethod: "human_review",
      resolutionConfidence: unknown.confidence,
      mentionPosition: position,
      mentionRole: "single_choice",
      assertion: "final_choice",
      sentiment: "positive",
      contextSnippet: unknown.contextSnippet,
      descriptors: [],
      criteria: extractCriteria(unknown.contextSnippet),
      extractionMetadata: {
        source: "deterministic_final_choice_unknown",
        candidate_signature: unknown.signature,
        suggested_entity_type: unknown.suggestedEntityType,
        raw_choice_surface: unknown.rawSurface,
        source_start: unknown.sourceStart,
        source_end: unknown.sourceEnd,
        source_verified: true,
        ...resolutionAuthorityMetadata("human_review"),
      },
    });
    candidates.push({
      candidateKind:
        unknown.suggestedEntityType === "Product" ? "create_product" : "create_brand",
      signature: unknown.signature,
      surfaceText: unknown.surfaceText,
      surfaceNormalized: unknown.surfaceNormalized,
      surfaceVariants: unique([unknown.surfaceText, unknown.rawSurface]),
      suggestedEntityType: unknown.suggestedEntityType,
      confidence: unknown.confidence,
      answerSnippets: [unknown.contextSnippet],
      metricImpact: {
        source: "deterministic_final_choice_unknown",
        mention_role: "single_choice",
        assertion: "final_choice",
        metric_impact: true,
      },
    });
  }

  return {
    quality,
    // ⚠️ 여기서 코드포인트로 바꾸지 않는다(scope#632 최종 리뷰). 상류에서 바꾸면
    // 이 값이 LLM 경로(resolveLlmMentionSpan — 원문 .indexOf 로 UTF-16 을 새로
    // 계산)와 **기준이 갈라져** mentionsReferToSameSurface 의 span 겹침 판정이
    // 어긋나고, 같은 표기가 멘션 둘로 쪼개진다. 변환은 영속 직전 choke point
    // (store.ts analysisForPersist.mentions) 한 곳에서만 한다.
    mentions,
    candidates,
    analysisVersion: options.analysisVersion,
    promptVersion: options.promptVersion,
    parserVersion: options.parserVersion,
    resolverVersion: options.resolverVersion,
    sourceTurnHash,
    extractionMetadata: {
      known_matches: mentions.filter((m) => m.resolutionStatus === "resolved").length,
      conflict_matches: mentions.filter((m) => m.resolutionStatus === "conflict").length,
      parser_partial: false,
      llm_mention_enabled: options.enableLlmMentionExtraction,
      llm_unknown_enabled: options.enableLlmUnknownDiscovery,
    },
  };
}

function resolutionAuthorityMetadata(
  method: MeasurementMention["resolutionMethod"],
): Record<string, unknown> {
  return {
    resolution_authority_level: resolverAuthorityForMethod(method),
    resolution_authority_priority: resolverAuthorityPriority(method),
  };
}

export function findDeterministicMatches(
  text: string,
  catalog: OntologyCatalogEntity[],
): SpanMatch[] {
  const entries = buildSurfaceEntries(catalog);
  const bySurface = groupBy(entries, (e) => e.normalized);
  const byCompact = groupBy(entries, (e) => e.compact);
  const folded = buildNormalizedIndex(text);
  const compact = buildCompactIndex(text);
  const matches: SpanMatch[] = [];

  for (const [surface, surfaceEntries] of bySurface) {
    if (surface.length < 2) continue;
    let idx = 0;
    while (idx < folded.text.length) {
      const found = folded.text.indexOf(surface, idx);
      if (found < 0) break;
      const end = found + surface.length;
      const sourceStart = folded.startMap[found] ?? 0;
      const sourceEnd = folded.endMap[end - 1] ?? sourceStart;
      if (
        passesBoundary(folded.text, found, end, surface) &&
        looksLikeReadableSpan(text.slice(sourceStart, sourceEnd))
      ) {
        matches.push({
          start: sourceStart,
          end: sourceEnd,
          surfaceText: text.slice(sourceStart, sourceEnd),
          entries: surfaceEntries,
        });
      }
      idx = Math.max(found + 1, end);
    }
  }

  for (const [surface, surfaceEntries] of byCompact) {
    if (
      surface.length < 2 ||
      bySurface.has(surface) ||
      !canUseCompactMatch(surface, surfaceEntries)
    ) {
      continue;
    }
    let idx = 0;
    while (idx < compact.text.length) {
      const found = compact.text.indexOf(surface, idx);
      if (found < 0) break;
      const start = compact.startMap[found] ?? 0;
      const end = compact.endMap[found + surface.length - 1] ?? start;
      if (
        passesSourceBoundary(text, start, end, surfaceEntries) &&
        looksLikeReadableSpan(text.slice(start, end))
      ) {
        matches.push({
          start,
          end,
          surfaceText: text.slice(start, end),
          entries: surfaceEntries,
        });
      }
      idx = found + 1;
    }
  }

  return dedupeMatches(matches);
}

function buildSurfaceEntries(catalog: OntologyCatalogEntity[]): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  for (const entity of catalog) {
    const canonical = entity.canonicalName.trim();
    if (canonical) {
      entries.push({
        entityId: entity.id,
        entityType: entity.type,
        canonicalName: entity.canonicalName,
        surface: canonical,
        normalized: normalizeSurface(canonical),
        compact: compactSurface(canonical),
        language: inferSurfaceLanguage(canonical),
        method: "canonical_exact",
      });
    }
    for (const alias of entity.aliases) {
      const surface = alias.alias.trim();
      if (!surface) continue;
      entries.push({
        entityId: entity.id,
        entityType: entity.type,
        canonicalName: entity.canonicalName,
        surface,
        normalized: normalizeSurface(surface),
        compact: compactSurface(surface),
        language: alias.language,
        method: "alias_exact",
      });
    }
  }
  return entries.filter((e) => e.normalized.length >= 2 && e.compact.length >= 2);
}

function buildNormalizedIndex(text: string): IndexedText {
  let out = "";
  const startMap: number[] = [];
  const endMap: number[] = [];
  let lastWasSpace = true;

  for (let i = 0; i < text.length; ) {
    const char = nextCodePoint(text, i);
    const sourceEnd = i + char.length;
    const normalized = char.normalize("NFKC").toLocaleLowerCase("und");
    for (const normalizedChar of normalized) {
      if (/\s/u.test(normalizedChar)) {
        if (!lastWasSpace && out.length > 0) {
          out += " ";
          startMap.push(i);
          endMap.push(sourceEnd);
          lastWasSpace = true;
        }
        continue;
      }
      out += normalizedChar;
      for (let j = 0; j < normalizedChar.length; j++) {
        startMap.push(i);
        endMap.push(sourceEnd);
      }
      lastWasSpace = false;
    }
    i = sourceEnd;
  }

  while (out.endsWith(" ")) {
    out = out.slice(0, -1);
    startMap.pop();
    endMap.pop();
  }
  return { text: out, startMap, endMap };
}

function buildCompactIndex(text: string): IndexedText {
  let out = "";
  const startMap: number[] = [];
  const endMap: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = nextCodePoint(text, i);
    const sourceEnd = i + char.length;
    const compact = compactSurface(char);
    for (const compactChar of compact) {
      out += compactChar;
      for (let j = 0; j < compactChar.length; j++) {
        startMap.push(i);
        endMap.push(sourceEnd);
      }
    }
    i = sourceEnd;
  }
  return { text: out, startMap, endMap };
}

function nextCodePoint(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint == null ? "" : String.fromCodePoint(codePoint);
}

function passesBoundary(
  text: string,
  start: number,
  end: number,
  surface: string,
): boolean {
  if (!/[a-z0-9]/i.test(surface)) return true;
  return !isAlphaNum(text[start - 1]) && !isAlphaNum(text[end]);
}

function canUseCompactMatch(surface: string, entries: SurfaceEntry[]): boolean {
  if (isCommonWordCompactCollision(surface)) return false;
  if (surface.length < 5) return false;
  return entries.some(
    (entry) =>
      entry.entityType === "Product" ||
      /[\s\-_/()[\]{}]/.test(entry.surface) ||
      entry.surface.length >= 5,
  );
}

function isCommonWordCompactCollision(surface: string): boolean {
  return COMMON_WORD_COMPACT_COLLISIONS.has(surface);
}

const COMMON_WORD_COMPACT_COLLISIONS = new Set([
  "models",
]);

function passesSourceBoundary(
  text: string,
  start: number,
  end: number,
  entries: SurfaceEntry[],
): boolean {
  if (!entries.some((entry) => /[A-Za-z0-9]/.test(entry.surface))) return true;
  return !isAlphaNum(text[start - 1]) && !isAlphaNum(text[end]);
}

function looksLikeReadableSpan(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /[\p{L}\p{N}]/u.test(trimmed);
}

interface UnknownFinalChoiceInput {
  answerText: string;
  turnIndex: number;
  matches: SpanMatch[];
  catalog: OntologyCatalogEntity[];
}

interface UnknownFinalChoice {
  surfaceText: string;
  rawSurface: string;
  surfaceNormalized: string;
  suggestedEntityType: "Brand" | "Product";
  sourceStart: number;
  sourceEnd: number;
  signature: string;
  confidence: number;
  contextSnippet: string;
}

function findUnknownFinalChoiceCandidates(
  input: UnknownFinalChoiceInput,
): UnknownFinalChoice[] {
  if (input.turnIndex <= 1) return [];

  const knownSurfaces = new Set<string>();
  for (const match of input.matches) {
    knownSurfaces.add(normalizeSurface(match.surfaceText));
    for (const entry of match.entries) {
      knownSurfaces.add(entry.normalized);
      knownSurfaces.add(normalizeSurface(entry.canonicalName));
      knownSurfaces.add(normalizeSurface(entry.surface));
    }
  }
  for (const entity of input.catalog) {
    knownSurfaces.add(normalizeSurface(entity.canonicalName));
    for (const alias of entity.aliases) {
      knownSurfaces.add(normalizeSurface(alias.alias));
    }
  }

  const out: UnknownFinalChoice[] = [];
  const seen = new Set<string>();
  let lineStart = 0;
  let sawContent = false;
  let awaitingCueContinuation = false;
  for (const lineText of input.answerText.split(/\n/)) {
    const lineEnd = lineStart + lineText.length;
    const trimmedLine = lineText.trim();
    const hasCue = hasFinalChoiceCue(lineText);
    const rawSurfaces = hasCue
      ? extractFinalChoiceSurfacesFromLine(lineText)
      : !sawContent || awaitingCueContinuation
        ? extractLeadingFinalChoiceSurfacesFromLine(lineText)
        : [];
    if (rawSurfaces.length > 0) {
      const beforeCount = out.length;
      for (const rawSurface of rawSurfaces) {
        const surfaceText = canonicalizeUnknownChoiceSurface(rawSurface);
        const surfaceNormalized = normalizeSurface(surfaceText);
        if (!surfaceNormalized || seen.has(surfaceNormalized)) continue;
        if (knownSurfaces.has(surfaceNormalized)) continue;
        if (!looksLikeConcreteEntitySurface(surfaceText)) continue;
        seen.add(surfaceNormalized);
        const surfaceIndexInLine =
          lineText.indexOf(surfaceText) >= 0
            ? lineText.indexOf(surfaceText)
            : Math.max(0, lineText.indexOf(rawSurface));
        const start =
          surfaceIndexInLine >= 0 ? lineStart + surfaceIndexInLine : lineStart;
        const end =
          surfaceIndexInLine >= 0
            ? start + surfaceText.length
            : Math.min(lineEnd, start + rawSurface.length);
        const suggestedEntityType = inferUnknownEntityType(surfaceText);
        out.push({
          surfaceText,
          rawSurface: rawSurface.trim(),
          surfaceNormalized,
          suggestedEntityType,
          sourceStart: start,
          sourceEnd: end,
          signature: candidateSignature("unknown_final_choice", surfaceNormalized, [
            suggestedEntityType,
          ]),
          confidence: 0.72,
          contextSnippet: contextSnippet(input.answerText, start, end),
        });
      }
      awaitingCueContinuation = hasCue && out.length === beforeCount;
    } else if (hasCue) {
      awaitingCueContinuation = true;
    } else if (trimmedLine) {
      awaitingCueContinuation = false;
    }
    if (trimmedLine) sawContent = true;
    lineStart = lineEnd + 1;
  }
  return chooseMetricImpactUnknownFinalChoices(out);
}

function hasFinalChoiceCue(line: string): boolean {
  if (
    /(?:구매\s*팁|trim\s*recommendation|추천\s*이유|최종\s*추천을\s*받은\s*이유|final\s*recommendation\s*reason)/i.test(
      line,
    )
  ) {
    return false;
  }
  return /(딱\s*하나|하나만|최종\s*(추천|선택)|최종적으로|추천\s*모델|고르(?:면|라면|겠습니다)|선택(?:은|하면)|top\s*pick|final\s*(recommendation|choice)|my\s*(recommendation|choice)|i\s*(recommend|choose|pick)|best\s*choice|single\s*best)/i.test(
    line,
  );
}

function extractFinalChoiceSurfacesFromLine(line: string): string[] {
  const surfaces: string[] = [];
  const emphasized = [...line.matchAll(/\*\*([^*\n]{2,100})\*\*/g)]
    .map((m) => m[1])
    .filter((v): v is string => !!v);
  surfaces.push(...emphasized);

  const patterns = [
    /(?:최종\s*(?:추천|선택)(?:\s*모델)?|추천\s*모델|선택(?:은|하면)|딱\s*하나(?:만)?\s*(?:고르(?:면|라면)|선택(?:하면)?)?|하나만\s*(?:고르(?:면|라면)|추천(?:하면)?)?|고르(?:면|라면))[\s:은는,]*(.{2,120})/i,
    /(?:final\s*(?:recommendation|choice)|my\s*(?:recommendation|choice)|top\s*pick|i\s*(?:recommend|choose|pick)|best\s*choice|single\s*best)\s*(?:is|would be|:)?\s*(.{2,120})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) surfaces.push(match[1]);
  }
  if (surfaces.length === 0) {
    surfaces.push(line);
  }
  return unique(surfaces.map(cleanChoiceSurface).filter(Boolean));
}

function extractLeadingFinalChoiceSurfacesFromLine(line: string): string[] {
  const stripped = line
    .replace(/^\s*(?:>+\s*)?(?:#{1,6}\s*)?/, "")
    .trim();
  if (!stripped) return [];
  if (/^(?:[-*]\s*)?(?:이유|근거|장기|가족|잔존|사용성|신뢰성|내구성|resale|reliability|family)\b/i.test(stripped)) {
    return [];
  }
  const surfaces: string[] = [];
  const emphasizedLead = /^\*\*([^*\n]{2,100})\*\*/.exec(stripped);
  if (emphasizedLead?.[1]) surfaces.push(emphasizedLead[1]);
  const leadClause = stripped
    .replace(/\*\*/g, "")
    .split(
      /\s+(?:이유는|이유|because|since|as|for)\s+|(?:를|을)?\s*추천(?:합니다|해요|드립니다)?|(?:이|가)?\s*(?:입니다|이에요|예요)|[.;。]/i,
    )[0]!
    .trim();
  const concrete = extractConcreteModelPhrase(cleanChoiceSurface(leadClause));
  if (concrete) surfaces.push(concrete);
  return unique(surfaces.map(cleanChoiceSurface).filter(Boolean));
}

function cleanChoiceSurface(value: string): string {
  let out = value
    .replace(/\*\*/g, "")
    .replace(/^[\s\-–—:|>*_`"'“”'\[\]]+/, "")
    .replace(
      /^(?:#{1,6}\s*)?(?:저는|개인적으로|제\s*추천은|추천은|the|a|an|overall|personally|i\s+would)\s+/i,
      "",
    )
    .replace(
      /^(?:최종\s*(?:추천|선택|결론|요약)(?:\s*모델)?|추천\s*모델|브랜드\s*(?:및|\/)?\s*모델명|브랜드|모델명|final\s*(?:recommendation|choice|answer)|top\s*pick|my\s*(?:recommendation|choice))\s*[:：\-–—|/]*\s*/i,
      "",
    )
    .trim();
  out = out
    .split(
      /\s+(?:because|since|as|for)\s+|(?:를|을)?\s*(?:추천(?:합니다|해요|드립니다)?|드립니다|권합니다|제안합니다)|(?:쪽|계열|타입)?(?:을|를)?\s*(?:고르겠습니다|고릅니다|선택하겠습니다|선택합니다)|(?:이|가)?\s*(?:입니다|이에요|예요)|[.;。]/i,
    )[0]!
    .trim();
  out = out.replace(
    /^(.{2,80}?[A-Za-z0-9][A-Za-z0-9-]*)(?:이|가|은|는)\s+.+$/u,
    "$1",
  );
  return out.replace(/^[\s\-–—:|>*_`"'“”'\[\]]+|[\s\-–—:|>*_`"'“”'\[\]]+$/g, "");
}

function canonicalizeUnknownChoiceSurface(rawSurface: string): string {
  const cleaned = cleanChoiceSurface(rawSurface);
  const candidates: string[] = [];
  const outerParentheticalModel =
    /([A-Za-z가-힣][A-Za-z가-힣&.+-]{1,40})\s*\([^()]{2,40}\)\s*(?:의|[-–—/:]|\s+\/\s*(?:모델명|model)\s*:?)?\s*([A-Z0-9][A-Za-z0-9-]{1,20})/i.exec(
      cleaned,
    );
  if (
    outerParentheticalModel?.[1] &&
    outerParentheticalModel[2] &&
    looksLikeModelToken(outerParentheticalModel[2])
  ) {
    candidates.push(`${outerParentheticalModel[1].trim()} ${outerParentheticalModel[2].trim()}`);
  }
  const parentheticalBrandModel =
    /\(([^()]{2,40})\)\s*(?:의|[-–—/:]|\s+\/\s*(?:모델명|model)\s*:?)?\s*([A-Z0-9][A-Za-z0-9-]{1,20})/i.exec(
      cleaned,
    );
  if (
    parentheticalBrandModel?.[1] &&
    parentheticalBrandModel[2] &&
    looksLikeConcreteEntitySurface(parentheticalBrandModel[1]) &&
    looksLikeModelToken(parentheticalBrandModel[2])
  ) {
    candidates.push(`${parentheticalBrandModel[1].trim()} ${parentheticalBrandModel[2].trim()}`);
  }
  const parenthetical = [...cleaned.matchAll(/\(([^()]{2,80})\)/g)]
    .map((m) => m[1]?.trim())
    .filter((v): v is string => !!v && looksLikeConcreteEntitySurface(v));
  candidates.push(...parenthetical);
  const withoutParenthetical = cleaned.replace(/\([^()]{2,80}\)/g, "").trim();
  const concrete = extractConcreteModelPhrase(withoutParenthetical);
  if (concrete) candidates.push(concrete);
  else candidates.push(withoutParenthetical);
  return chooseBestUnknownChoiceSurface(candidates) ?? withoutParenthetical;
}

function extractConcreteModelPhrase(value: string): string | null {
  const matches = [
    ...value.matchAll(
      /([A-Za-z가-힣][A-Za-z가-힣&.+-]{1,40})(?:\s+|\s*[-–—/:]\s*)([A-Z]{1,5}-?[A-Z0-9]{1,8})/g,
    ),
  ];
  for (const match of matches.reverse()) {
    const brand = (match[1] ?? "").trim();
    const model = (match[2] ?? "").trim();
    if (!brand || !model) continue;
    const normalizedBrand = normalizeSurface(brand);
    if (
      /(?:기준|조건|이유|근거|차량|모델|추천|선택|핵심|가치|사용성|신뢰성|잔존가치)/.test(
        normalizedBrand,
      )
    ) {
      continue;
    }
    if (/(?:에서|으로|에게|에는|은|는|이|가|의)$/.test(normalizedBrand)) {
      continue;
    }
    return `${brand} ${model}`;
  }
  return null;
}

function chooseBestUnknownChoiceSurface(candidates: string[]): string | null {
  const uniqueCandidates = unique(
    candidates.map(normalizeChoiceCandidateSurface).filter(Boolean),
  ).filter(looksLikeConcreteEntitySurface);
  if (uniqueCandidates.length === 0) return null;
  return uniqueCandidates.sort(
    (a, b) => unknownChoiceSurfaceScore(b) - unknownChoiceSurfaceScore(a),
  )[0]!;
}

function normalizeChoiceCandidateSurface(value: string): string {
  return value
    .trim()
    .replace(/\s*[-–—/:]\s*([A-Z0-9][A-Za-z0-9-]{1,20})$/i, " $1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function unknownChoiceSurfaceScore(surface: string): number {
  let score = inferUnknownEntityType(surface) === "Product" ? 30 : 10;
  if (unknownChoiceModelKey(surface)) score += 20;
  if (/^[A-Za-z]/.test(surface)) score += 8;
  if (/[A-Za-z]/.test(surface) && /\s/.test(surface)) score += 5;
  score += Math.min(10, surface.length / 8);
  return score;
}

function looksLikeConcreteEntitySurface(surface: string): boolean {
  const trimmed = surface.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  const normalized = normalizeSurface(trimmed);
  if (isNonEntityChoiceSurface(normalized)) return false;
  if (isGenericChoiceSurface(normalized)) return false;
  if (isKoreanGrammarFragmentSurface(normalized, trimmed)) return false;
  if (isEnglishDescriptorSurface(normalized)) return false;
  if (/[A-Z][A-Za-z0-9]*[\s-]+[A-Z0-9][A-Za-z0-9-]*/.test(trimmed)) return true;
  if (/[가-힣]{2,}\s*[A-Za-z0-9][A-Za-z0-9-]+/.test(trimmed)) return true;
  if (/\b[A-Z]{2,}[0-9]*\b/.test(trimmed)) return true;
  if (/[0-9]/.test(trimmed) && /[\p{L}]/u.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9&.+-]*(?:\s+[A-Za-z0-9&.+-]+){0,3}$/.test(trimmed)) {
    return true;
  }
  if (/^[가-힣][가-힣0-9&.+-]{1,12}$/.test(trimmed)) {
    return true;
  }
  if (/^[가-힣]{2,8}\s+[가-힣A-Za-z0-9&.+-]{2,16}$/.test(trimmed)) {
    return true;
  }
  return false;
}

function isKoreanGrammarFragmentSurface(
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
    /(?:^모두|한다면|해야한다면|선택해야|추천하면|고르라면|다음과같|차량은|모델은|선택은|추천은|1대만선택|선택$|추천$)/u.test(
      compact,
    )
  ) {
    return true;
  }
  if (
    /(?:조건|기준|이유|근거|장점|단점|결론|요약|사용성|실용성|안락함|편의성|유지비|정숙성|공간|가격|가성비|가치)$/u.test(
      compact,
    )
  ) {
    return true;
  }
  return false;
}

function isEnglishDescriptorSurface(normalized: string): boolean {
  return /^(?:family|business|executive|premium|budget|urban|starter|winter|camping|pet|safe|teen|long[-\s]*highway|crossover|vehicle|car)(?:\s+(?:family|business|executive|premium|budget|urban|starter|winter|camping|pet|safe|teen|long[-\s]*highway|crossover|vehicle|car|suv|sedan|ev|hev|hybrid))*$/i.test(
    normalized,
  );
}

function isNonEntityChoiceSurface(normalized: string): boolean {
  if (!normalized) return true;
  const compact = compactSurface(normalized);
  if (
    /^(?:드립니다|추천드립니다|추천합니다|추천해요|권합니다|제안합니다|고르겠습니다|고릅니다|선택하겠습니다|선택합니다|합니다|입니다|같습니다|좋습니다|적합합니다|말씀드립니다)$/u.test(
      compact,
    )
  ) {
    return true;
  }
  if (
    /^(?:다음과\s*같습니다|최종|결론|최종\s*결론|최종\s*요약|한\s*줄\s*결론|단\s*하나|브랜드\s*및\s*모델명|브랜드|모델명)$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(?:유지비|보험료|연비|중고\s*감가|감가|실내\s*공간|승차감|실내\s*품질|이미지|안전성|가성비|실용성|경제성|정비\s*비용|유류비|잔존\s*가치|균형)(?:\s*중심)?(?:의\s*선택)?$/u.test(
      normalized,
    ) ||
    /^(?:유지비|보험료|연비|중고감가|감가|실내공간|승차감|실내품질|이미지|안전성|가성비|실용성|경제성|정비비용|유류비|잔존가치|균형)중심(?:의선택)?$/u.test(
      compact,
    )
  ) {
    return true;
  }
  if (
    /^(?:long[-\s]*term\s*)?reliability|^family\s*(?:usability|practicality|utility)|^resale\s*value|^trade[-\s]*in$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/^(?:reliability|usability|practicality|utility)$/i.test(normalized)) {
    return true;
  }
  if (
    /^(?:full[-\s]*flat|walk[-\s]*through|tco(?:\s*,?\s*total\s+cost\s+of\s+ownership)?|total\s+cost\s+of\s+ownership|safety|safe)$/i.test(
      normalized,
    ) ||
    /^(?:안전|안전성|총소유비용|총\s*소유\s*비용)$/u.test(normalized)
  ) {
    return true;
  }
  if (
    /^(?:[a-z0-9]+[-\s]*)?(?:x[-\s]*pro|gt[-\s]*line|n[-\s]*line|signature|prestige|calligraphy)(?:\s*(?:trim|트림|grade|라인|line))?$/i.test(
      normalized,
    ) ||
    /(?:트림|grade|trim)$/i.test(normalized)
  ) {
    return true;
  }
  if (
    /(?:신뢰성|사용성|실용성|잔존가치|내구성|감가상각|조건|기준|가치|이유|근거|장점|단점|결론|요약)$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function looksLikeModelToken(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[A-Z]{1,5}-[A-Z0-9]{1,8}$/i.test(trimmed) ||
    /^[A-Z]{1,5}\d[A-Z0-9-]{0,8}$/i.test(trimmed) ||
    /^[A-Z]{2,6}$/i.test(trimmed)
  );
}

function chooseMetricImpactUnknownFinalChoices(
  choices: UnknownFinalChoice[],
): UnknownFinalChoice[] {
  const filtered = choices.filter(
    (choice) =>
      !choices.some(
        (other) =>
          other !== choice &&
          other.surfaceNormalized.includes(choice.surfaceNormalized) &&
          other.surfaceNormalized.length > choice.surfaceNormalized.length,
      ),
  );
  const byModel = new Map<string, UnknownFinalChoice>();
  for (const choice of filtered) {
    const key = unknownChoiceModelKey(choice.surfaceText) ?? choice.surfaceNormalized;
    const prev = byModel.get(key);
    if (!prev || unknownChoiceScore(choice) > unknownChoiceScore(prev)) {
      byModel.set(key, choice);
    }
  }
  const ranked = [...byModel.values()].sort(
    (a, b) => unknownChoiceScore(b) - unknownChoiceScore(a),
  );
  const productLike = ranked.filter((choice) => choice.suggestedEntityType === "Product");
  return (productLike.length ? productLike : ranked).slice(0, 1);
}

function unknownChoiceModelKey(surface: string): string | null {
  const model = /(?:^|\s)([A-Z]{1,5}-?[A-Z0-9]{1,8}|[A-Z]{1,5}\d[A-Z0-9-]{0,8})(?:\s|$)/i.exec(
    surface,
  )?.[1];
  return model ? compactSurface(model) : null;
}

function unknownChoiceScore(choice: UnknownFinalChoice): number {
  let score = choice.suggestedEntityType === "Product" ? 30 : 10;
  if (unknownChoiceModelKey(choice.surfaceText)) score += 20;
  if (/[A-Za-z]/.test(choice.surfaceText) && /\s/.test(choice.surfaceText)) score += 5;
  score += Math.min(10, choice.surfaceText.length / 8);
  return score;
}

function isGenericChoiceSurface(normalized: string): boolean {
  const genericTerms =
    /^(?:하이브리드|전기|전기차|내연기관|중소형|준중형|준대형|소형|중형|대형|컴팩트|크로스오버|패밀리|가족용|업무용|법인|임원차|장거리|도심형|프리미엄|안전|안전성|쪽|계열|타입|compact|crossover|family|business|executive|premium|hybrid|hev|phev|electric|ev|gas|diesel|suv|sedan|vehicle|car|category|option|choice|model|모델|제품|브랜드|카테고리)(?:\s+(?:하이브리드|전기|전기차|내연기관|중소형|준중형|준대형|소형|중형|대형|컴팩트|크로스오버|패밀리|가족용|업무용|법인|임원차|장거리|도심형|프리미엄|안전|안전성|쪽|계열|타입|compact|crossover|family|business|executive|premium|hybrid|hev|phev|electric|ev|gas|diesel|suv|sedan|vehicle|car|category|option|choice|model|모델|제품|브랜드|카테고리))*$/i;
  return genericTerms.test(normalized);
}

function inferUnknownEntityType(surface: string): "Brand" | "Product" {
  if (/[0-9-]/.test(surface)) return "Product";
  if (/\s/.test(surface) && !/^[A-Z]{2,}$/.test(surface.trim())) return "Product";
  return "Brand";
}

function dedupeMatches(matches: SpanMatch[]): SpanMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const kept: SpanMatch[] = [];
  for (const match of sorted) {
    const overlaps = kept.some(
      (k) => match.start < k.end && match.end > k.start,
    );
    if (overlaps) continue;
    const byEntity = new Map<string, SurfaceEntry>();
    for (const entry of match.entries) {
      byEntity.set(entry.entityId, entry);
    }
    kept.push({ ...match, entries: [...byEntity.values()] });
  }
  return kept;
}

function inferMentionSemantics(
  answerText: string,
  match: SpanMatch,
  turnIndex: number,
): Omit<
  MeasurementMention,
  | "entityId"
  | "entityType"
  | "surfaceText"
  | "surfaceLanguage"
  | "surfaceNormalized"
  | "surfaceHash"
  | "resolutionStatus"
  | "resolutionMethod"
  | "resolutionConfidence"
  | "mentionPosition"
  | "extractionMetadata"
> {
  const line = containingLine(answerText, match.start, match.end);
  const rank = inferRank(line.text);
  const tableAxis = inferTableAxisRole(
    line.text,
    match.start - line.start,
    match.end - line.start,
  );
  const choiceCue = /(딱\s*하나|최선|하나만|choose|pick|my choice|best choice|single best)/i;
  const recommendCue = /(추천|recommend|best|top|후보|shortlist|선택지|option)/i;
  const compareCue = /(비교|versus|vs\.?|compared|대비|경쟁)/i;
  const negativeCue = /(비추천|avoid|나쁘|단점|weak|poor|worse)/i;
  const positiveCue = /(추천|best|강점|좋|excellent|strong|적합)/i;
  const explanatoryRecommendationCue =
    /(추천\s*(이유|사유|근거|포인트|설명)|why\s+recommend|recommendation\s+reason)/i;

  let mentionRole: MeasurementMention["mentionRole"] = "background";
  let assertion: MeasurementMention["assertion"] = "mention_only";
  if (turnIndex > 1 && choiceCue.test(line.text)) {
    mentionRole = "single_choice";
    assertion = "final_choice";
  } else if (
    rank != null ||
    tableAxis === "entity_axis" ||
    (recommendCue.test(line.text) &&
      tableAxis !== "attribute_axis" &&
      !explanatoryRecommendationCue.test(line.text))
  ) {
    mentionRole = "shortlist_candidate";
    assertion = "recommend";
  } else if (compareCue.test(line.text)) {
    mentionRole = "comparison_target";
    assertion = "compare";
  }

  const sentiment = negativeCue.test(line.text)
    ? "negative"
    : positiveCue.test(line.text)
      ? "positive"
      : "neutral";

  return {
    mentionRole,
    assertion,
    sentiment,
    ...(rank != null ? { rank, rankGroup: `rank:${rank}` } : {}),
    contextSnippet: contextSnippet(answerText, match.start, match.end),
    descriptors: extractDescriptors(line.text, match.surfaceText),
    criteria: extractCriteria(line.text),
  };
}

// export 는 감성 판별 V2(`llm.ts` classifyMentionSemanticsV2)의 줄 파생 재사용용. 동작 불변.
export function containingLine(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } {
  const lineStart = Math.max(text.lastIndexOf("\n", start - 1) + 1, 0);
  const next = text.indexOf("\n", end);
  const lineEnd = next >= 0 ? next : text.length;
  return { text: text.slice(lineStart, lineEnd), start: lineStart, end: lineEnd };
}

function inferRank(line: string): number | undefined {
  const trimmed = line.trim();
  const m =
    /^(?:[#*\-\s]*)(\d{1,2})(?:[.)\]:]|위|\s+-)/.exec(trimmed) ??
    /(?:^|\s)(?:rank|top)\s*(\d{1,2})\b/i.exec(trimmed);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

type TableAxisRole = "entity_axis" | "attribute_axis" | "not_table";

function inferTableAxisRole(
  line: string,
  localStart: number,
  localEnd: number,
): TableAxisRole {
  if (!line.includes("|")) return "not_table";
  const cells = parseTableCells(line);
  const matchCellIndex = cells.findIndex(
    (cell) => localStart >= cell.start && localEnd <= cell.end,
  );
  if (matchCellIndex < 0) return "not_table";

  const priorCells = cells.slice(0, matchCellIndex).map((cell) => cell.text);
  if (priorCells.some(isAttributeAxisHeader)) return "attribute_axis";
  if (priorCells.some(isEntityAxisHeader)) return "entity_axis";

  const firstNonEmptyIndex = cells.findIndex((cell) => cell.text.length > 0);
  if (matchCellIndex === firstNonEmptyIndex) {
    return isAttributeAxisHeader(cells[matchCellIndex]?.text ?? "")
      ? "attribute_axis"
      : "entity_axis";
  }
  return "attribute_axis";
}

function parseTableCells(line: string): Array<{ text: string; start: number; end: number }> {
  const cells: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i !== line.length && line[i] !== "|") continue;
    const raw = line.slice(start, i);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    cells.push({
      text: raw.trim(),
      start: start + leading,
      end: i - trailing,
    });
    start = i + 1;
  }
  return cells.filter((cell) => cell.text.length > 0);
}

function isEntityAxisHeader(text: string): boolean {
  return /(모델명|추천\s*모델|추천\s*모델\s*예시|제품명|상품명|브랜드|보험사|플랫폼|서비스명|model|product|brand|service|platform|insurer)/i.test(
    text,
  );
}

function isAttributeAxisHeader(text: string): boolean {
  return /(가격|예산|유지비|관리비|용도|사용\s*사례|추천\s*(이유|사유|근거|포인트|설명)|장점|단점|특징|설명|비고|price|cost|budget|maintenance|use\s*case|reason|note|description)/i.test(
    text,
  );
}

function extractDescriptors(line: string, surface: string): string[] {
  const cleaned = line
    .replace(surface, "")
    .replace(/^[\s\-*#\d.)\]:]+/, "")
    .replace(/\|/g, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/[;,·•]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 4);
}

function extractCriteria(line: string): string[] {
  const criteria = [
    ["price", /(가격|예산|cost|price|budget)/i],
    ["safety", /(안전|safety)/i],
    ["maintenance", /(유지비|maintenance|repair)/i],
    ["family", /(가족|패밀리|family)/i],
    ["performance", /(성능|performance|power)/i],
  ] as const;
  return criteria.filter(([, re]) => re.test(line)).map(([name]) => name);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const prev = out.get(key);
    if (prev) prev.push(item);
    else out.set(key, [item]);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * `conflict`·`unknown_final_choice` 후보의 signature 산식.
 *
 * export 한 이유: 턴별 백필(change candidate-append-only)이 mention 행에서
 * `conflict` 갈래를 재구성할 때 **이 함수를 부른다.** `parts.sort()` 규칙을 복제하면
 * 그 순간 사본이 생기고 조용히 갈라진다 — 백필이 라이브와 다른 키를 만들면 롤업이
 * 같은 후보를 두 signature 로 세게 된다.
 */
export function candidateSignature(
  kind: string,
  normalized: string,
  parts: string[],
): string {
  return [kind, normalized, ...parts.sort()].join("|");
}
