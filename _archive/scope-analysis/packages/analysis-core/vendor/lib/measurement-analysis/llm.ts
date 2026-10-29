import { z } from "zod";
// ⚠️ **타입 전용 import 다.** 값으로 가져오면
// `@/lib/llm/invoke` → `lib/llm/cost.ts` → `@/lib/db` + `@/db/schema` 로 이어져
// 이 모듈을 import 하는 것만으로 DB·env·AWS SDK 가 딸려 온다(플랜 §1.3 L1·L3).
// 분석 lane 은 그 배선 없이 이 모듈을 돌려야 하므로 invoker 는 **주입 필수**다.
import type { ClaudeRequest, ClaudeResponse } from "@/lib/llm/invoke";
import {
  MentionAssertionSchema,
  EntityTypeSchema,
  MentionRoleSchema,
  MentionSentimentSchema,
  type MeasurementCandidate,
  type MeasurementEntityType,
  type OntologyCatalogEntity,
  type MentionAssertion,
  type MentionRole,
  type MentionSentiment,
  STANCE_ASPECT_CAP,
  STANCE_ASPECT_LABEL_CAP,
} from "./schema";
import { normalizeSurface } from "./normalize";
import { containingLine } from "./core";
import { isAutomotiveIndustryName } from "./industry-context";
import {
  CATALOG_BLOCK_LEGEND,
  CATALOG_BLOCK_LEGEND_WITH_IDS,
  EXTRACT_CATALOG_ALIAS_CAP,
  EXTRACT_CATALOG_ENTITY_CAP,
  EXTRACT_CATALOG_TOKEN_BUDGET,
  RESOLVE_CATALOG_ALIAS_CAP,
  RESOLVE_CATALOG_ENTITY_CAP,
  RESOLVE_CATALOG_TOKEN_BUDGET,
  projectCatalogForPrompt,
} from "./catalog-projection";
import { log } from "@/lib/log";

const UnknownDiscoverySchema = z.object({
  candidates: z
    .array(
      z.object({
        surface_text: z.string().min(1),
        entity_type: z.enum(["Brand", "Product"]),
        confidence: z.number().min(0).max(1).optional(),
        evidence_snippet: z.string().optional(),
      }),
    )
    .default([]),
});

export interface UnknownDiscoveryResult {
  candidates: MeasurementCandidate[];
  parserPartial: boolean;
  malformedCount: number;
  costUsd?: number;
  attempts?: number;
  modelSlug?: string;
}

export type UnknownDiscoveryInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

const MentionExtractionSchema = z.object({
  mentions: z
    .array(
      z.object({
        surface_text: z.string().min(1),
        entity_type: EntityTypeSchema.optional(),
        canonical_guess: z.string().optional(),
        confidence: z.coerce.number().min(0).max(1).optional(),
        evidence_snippet: z.string().optional(),
        start_char: z.coerce.number().int().nonnegative().optional(),
        end_char: z.coerce.number().int().nonnegative().optional(),
        mention_position: z.coerce.number().int().positive().optional(),
        mention_role: MentionRoleSchema.optional(),
        assertion: MentionAssertionSchema.optional(),
        sentiment: MentionSentimentSchema.optional(),
        rank: z.coerce.number().int().positive().nullable().optional(),
        rank_group: z
          .union([z.string(), z.number()])
          .nullable()
          .optional()
          .transform((value) =>
            value == null
              ? undefined
              : typeof value === "number"
                ? String(value)
                : value,
          ),
        descriptors: z.array(z.string()).optional().default([]),
        criteria: z.array(z.string()).optional().default([]),
      }),
    )
    .default([]),
  generic_final_choice: z
    .object({
      evidence_snippet: z.string().optional(),
      confidence: z.coerce.number().min(0).max(1).optional(),
    })
    .nullable()
    .optional(),
  warnings: z.array(z.string()).optional().default([]),
});

export interface LlmExtractedMention {
  surfaceText: string;
  entityType?: MeasurementEntityType;
  canonicalGuess?: string;
  confidence?: number;
  evidenceSnippet?: string;
  startChar?: number;
  endChar?: number;
  mentionPosition?: number;
  mentionRole?: MentionRole;
  assertion?: MentionAssertion;
  sentiment?: MentionSentiment;
  rank?: number;
  rankGroup?: string;
  descriptors: string[];
  criteria: string[];
}

export interface MentionExtractionResult {
  mentions: LlmExtractedMention[];
  genericFinalChoice?: {
    evidenceSnippet?: string;
    confidence?: number;
  };
  parserPartial: boolean;
  malformedCount: number;
  warnings: string[];
  costUsd?: number;
  attempts?: number;
  modelSlug?: string;
  traceId?: string;
  failed?: boolean;
  errorMessage?: string;
  /** 봉투는 읽혔으나 원소 일부가 스키마를 벗어나 버려진 수 (부분 추출) */
  droppedEntries?: number;
  /** 마지막 실패 응답의 앞부분 — 재현 없이 원인을 보기 위한 진단 필드 */
  lastResponseExcerpt?: string;
}

export type MentionExtractionInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

const PendingMentionResolutionSchema = z.object({
  decisions: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative().optional(),
        surface_text: z.string().min(1),
        action: z.enum([
          "resolve_existing",
          "keep_pending",
          "ignore_non_metric",
        ]),
        existing_entity_id: z.guid().optional(),
        canonical_name: z.string().optional(),
        confidence: z.coerce.number().min(0).max(1).optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).optional().default([]),
});

export interface PendingMentionResolutionDecision {
  index?: number;
  surfaceText: string;
  action: "resolve_existing" | "keep_pending" | "ignore_non_metric";
  existingEntityId?: string;
  canonicalName?: string;
  confidence?: number;
  reason?: string;
}

export interface PendingMentionResolutionResult {
  decisions: PendingMentionResolutionDecision[];
  parserPartial: boolean;
  malformedCount: number;
  warnings: string[];
  costUsd?: number;
  attempts?: number;
  modelSlug?: string;
  traceId?: string;
  failed?: boolean;
  errorMessage?: string;
}

export type PendingMentionResolutionInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

// System prompt for verbatim mention extraction. Industry-parameterized
// (change complete-project-industry-scoping): the automotive variant keeps the
// original hand-tuned HMG wording byte-identical; any other named industry gets
// the same contract with industry-generic guidance, so a non-automotive project
// is no longer instructed with car examples. No industry (null) keeps the
// automotive-era wording — identical to pre-change behavior.
export function buildExtractMentionsSystemPrompt(
  industryName?: string | null,
): string {
  const generic = industryName != null && !isAutomotiveIndustryName(industryName);
  return [
    "You tag brand and model entities in an AI assistant's answer to a consumer purchase-decision question.",
    'Return JSON only: {"mentions":[{"surface_text":"<verbatim>","entity_type":"Brand|Product"}]}.',
    ...(generic
      ? [
          `The answers concern the "${industryName}" industry; known_entities lists that industry's catalog.`,
          "Brand = a consumer manufacturer marque of that industry. Product = a specific model, lineup, edition, or variant made by such a brand.",
          "ONLY tag real, consumer-purchasable brands and models in the same industry as the known_entities context. A parent corporate group or holding company is a Brand.",
          "Do NOT tag: cited sources, review sites, or publications (e.g. Reddit, YouTube, news sites); dealerships or retailers; generic product categories; technology, feature, material, or component names; or descriptive phrases and sentence fragments.",
        ]
      : [
          "Brand = a manufacturer marque (e.g. Hyundai/현대, Kia/기아, Toyota/도요타). Product = a specific model, grade, trim, or powertrain variant (e.g. Tucson/투싼, IONIQ 5, K5 하이브리드).",
          "ONLY tag real, consumer-purchasable brands and models in the same industry as the known_entities context. A parent corporate group or holding company (e.g. 현대자동차그룹) is a Brand.",
          "Do NOT tag: cited sources, review sites, or publications (Reddit, Car and Driver, Edmunds, MotorTrend, AP News, YouTube); dealerships or retailers (Doral Hyundai); generic categories (SUV, 세단, 전기차); features, options, ADAS, powertrains, engines, or transmissions (스마트센스, 스마트스트림 IVT, e-VMT); or descriptive phrases and sentence fragments.",
        ]),
    "CRITICAL — copy each surface_text VERBATIM: the exact characters as they appear in the answer, in the SAME language and script. If the answer writes '현대', return '현대' (NOT 'Hyundai'); if it writes '현대 투싼', return '현대 투싼' (NOT 'Tucson'). Do NOT translate, romanize, expand, abbreviate, or normalize. Every surface_text MUST be a literal substring of answer_text. List each distinct surface once.",
    "A coordinated compound of multiple brand names joined by a separator (e.g. '삼성·LG', 'Samsung/LG', '삼성전자/LG전자') is NOT one entity: emit one mention per constituent brand, each surface_text the verbatim constituent (e.g. '삼성' and 'LG'). Never emit the joined string as a single Brand.",
    // 카탈로그 블록의 표기 규약은 **시스템 프롬프트**에 둔다 — 요청마다 동일한
    // 문자열이라 프롬프트 캐시에 들어가고, 사용자 메시지 쪽에서 반복되던
    // JSON 키(`"canonical_name"` 등)를 대체한다 (change ontology-catalog-snapshot 4단계).
    CATALOG_BLOCK_LEGEND,
    "known_entities is context about this industry, NOT an allow-list: tag a brand/model that appears in the answer even if it is absent from known_entities.",
    "Do not invent entities. Do not emit anything other than surface_text and entity_type.",
  ].join(" ");
}

export async function extractMentionsWithLlm(input: {
  promptText?: string | null;
  answerText: string;
  turnIndex: number;
  catalog: OntologyCatalogEntity[];
  industryName?: string | null;
  /** 주입 필수 — 이 모듈은 transport 를 값으로 갖지 않는다(파일 머리 참고). */
  invokeFn: MentionExtractionInvoker;
  /** 테스트가 백오프 대기를 없애기 위해 주입한다 (기본값은 env/상수). */
  retry?: { maxAttempts?: number; baseMs?: number };
}): Promise<MentionExtractionResult> {
  const invokeFn = input.invokeFn;
  const maxAttempts = Math.max(
    1,
    input.retry?.maxAttempts ?? EXTRACT_MAX_ATTEMPTS,
  );
  const retryBaseMs = Math.max(0, input.retry?.baseMs ?? EXTRACT_RETRY_BASE_MS);
  // The LLM does ONE job: tag the brand/model surfaces in the answer. Identity
  // resolution, char-spans, mention role, and final-choice detection are all
  // derived mechanically downstream from the verbatim surface + turn structure.
  // Asking the LLM for offsets / role / assertion / sentiment was the source of
  // the noise and span misses this design removes — so the contract is just
  // {surface_text, entity_type}, copied VERBATIM.
  const system = buildExtractMentionsSystemPrompt(input.industryName);
  const answerText = input.answerText.slice(0, 20000);
  // change ontology-catalog-snapshot 4단계 — 온톨로지 컨텍스트를 토큰 예산 안으로
  // 투영한다. 이전에는 `catalog.slice(0, 500)` × 별칭 20개를 JSON 객체 배열로
  // 통째 넣어 요청당 12.4k 프롬프트 토큰(답변분석 비용의 ~97%)의 본체였다.
  const projection = projectCatalogForPrompt(input.catalog, {
    answerText,
    tokenBudget: EXTRACT_CATALOG_TOKEN_BUDGET,
    maxAliasesPerEntity: EXTRACT_CATALOG_ALIAS_CAP,
    maxEntities: EXTRACT_CATALOG_ENTITY_CAP,
  });
  // 어느 요청이 예산에 걸려 관련 엔티티를 잘랐는지 로그 한 번에 보이게 남긴다 —
  // 예산은 "느려질 뿐"이 아니라 정확도 축이므로 미관측으로 두지 않는다.
  log.info("measurement_analysis.extract.catalog_projection", {
    catalog_size: input.catalog.length,
    projected_entities: projection.entityCount,
    projected_aliases: projection.aliasCount,
    estimated_tokens: projection.estimatedTokens,
    token_budget: EXTRACT_CATALOG_TOKEN_BUDGET,
    relevant_entities: projection.relevantCount,
    relevant_included: projection.relevantIncluded,
    relevant_truncated: projection.relevantCount - projection.relevantIncluded,
  });
  const payload = {
    prompt_text: input.promptText ?? null,
    answer_text: answerText,
    known_entities: projection.text,
    required_schema: {
      mentions: [
        {
          surface_text: "verbatim brand/model surface, a literal substring of answer_text",
          entity_type: "Brand|Product",
        },
      ],
    },
  };

  let malformedCount = 0;
  let attempts = 0;
  let costUsd = 0;
  let modelSlug: string | undefined;
  let traceId: string | undefined;

  let lastExcerpt: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(retryBackoffMs(attempt - 1, retryBaseMs));
    let res: ClaudeResponse;
    try {
      res = await invokeFn({
        task: "measurement.analysis.extract_mentions",
        model: "haiku",
        temperature: 0,
        maxTokens: 6000,
        responseFormat: { type: "json_object" },
        reasoning: { max_tokens: 256, exclude: true },
        system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      });
    } catch (error) {
      attempts++;
      lastExcerpt = error instanceof Error ? error.message : String(error);
      // 호출 자체가 던진 경우도 일시적일 수 있다 — 남은 시도가 있으면 계속한다.
      if (attempt < maxAttempts) continue;
      return {
        mentions: [],
        parserPartial: true,
        malformedCount,
        warnings: [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        failed: true,
        errorMessage: lastExcerpt,
        lastResponseExcerpt: lastExcerpt,
      };
    }
    attempts++;
    costUsd += res.costUsd ?? 0;
    modelSlug = res.modelId;
    traceId = res.traceId;
    try {
      const envelope = MentionExtractionEnvelopeSchema.parse(
        parseJsonObject(res.text),
      );
      // 원소 단위 파싱 — 멘션 하나가 스키마를 벗어나도 나머지 멘션은 살린다.
      // (기존은 배열 전체 parse 라 원소 하나가 그 턴의 추출 전부를 날렸다.)
      const mentions: LlmExtractedMention[] = [];
      let dropped = 0;
      for (const raw of envelope.mentions) {
        const entry = MentionExtractionEntrySchema.safeParse(raw);
        if (!entry.success) {
          dropped++;
          continue;
        }
        const m = entry.data;
        mentions.push({
          surfaceText: m.surface_text,
          entityType: m.entity_type,
          canonicalGuess: m.canonical_guess,
          confidence: m.confidence,
          evidenceSnippet: m.evidence_snippet,
          startChar: m.start_char,
          endChar: m.end_char,
          mentionPosition: m.mention_position,
          mentionRole: m.mention_role,
          assertion: m.assertion,
          sentiment: m.sentiment,
          rank: m.rank ?? undefined,
          rankGroup: m.rank_group,
          descriptors: m.descriptors ?? [],
          criteria: m.criteria ?? [],
        });
      }
      // semantics 와 달리 **빈 멘션은 정상 결과**다 (브랜드가 언급되지 않은 답변).
      // 그러므로 봉투가 읽힌 이상 재시도하지 않는다 — 재시도는 JSON 이 깨졌을 때만.
      return {
        mentions,
        genericFinalChoice: envelope.generic_final_choice
          ? {
              evidenceSnippet: envelope.generic_final_choice.evidence_snippet,
              confidence: envelope.generic_final_choice.confidence,
            }
          : undefined,
        parserPartial: dropped > 0,
        malformedCount,
        warnings: envelope.warnings ?? [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        droppedEntries: dropped,
        ...(dropped > 0 ? { lastResponseExcerpt: responseExcerpt(res.text) } : {}),
      };
    } catch {
      malformedCount++;
      lastExcerpt = responseExcerpt(res.text);
    }
  }

  return {
    mentions: [],
    parserPartial: true,
    malformedCount,
    warnings: [],
    lastResponseExcerpt: lastExcerpt,
    costUsd,
    attempts,
    modelSlug,
    traceId,
  };
}

// ─── Per-mention sentiment + type (dedicated pass) ────────────────────
// A SEPARATE pass from verbatim extraction. Extraction returns {surface_text,
// entity_type} only — overloading it with sentiment/offsets was rolled back for
// noise + span misses (see extractMentionsWithLlm comment). This pass takes the
// already-extracted mentions and scores each one's sentiment + type at the
// clause level, so two brands in one line can carry opposite sentiment.
//
// 파싱은 항목 단위다. 봉투(semantics 배열)만 스키마로 강제하고 각 원소는
// 개별 파싱해 **유효한 것만** 취한다. 배열 전체를 한 번에 parse 하면 원소 하나가
// enum 을 벗어났을 때 그 턴의 모든 언급이 미채점으로 떨어진다 — 실제로 부분 실패가
// 0건이고 전체 실패만 관측된 이유가 이 all-or-nothing 이었다 (2026-07-29 실측).
const MentionSemanticsEntrySchema = z.object({
  index: z.coerce.number().int().nonnegative(),
  sentiment: MentionSentimentSchema,
  mention_type: MentionAssertionSchema,
});
const MentionSemanticsEnvelopeSchema = z.object({
  semantics: z.array(z.unknown()).default([]),
  warnings: z.array(z.string()).optional().default([]),
});

// 재시도 정책 (change semantics-retry-hardening).
//
// 기존은 백오프 없는 2회였다. 감성 채점 실패는 입력 탓이 아니라 **일시적**이며
// (실패한 턴 3건을 그대로 재요청하니 전부 정상 JSON 반환) 부하와 상관한다:
// 로컬 재분석(concurrency 4 집중) 15.8% vs 워커(분산) 2.5%. 즉시 두 번 던지는
// 재시도는 레이트리밋 구간을 그대로 통과하지 못한다 — 백오프를 넣고 횟수를 늘린다.
const SEMANTICS_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.MEASUREMENT_ANALYSIS_SEMANTICS_MAX_ATTEMPTS ?? 4),
);
const SEMANTICS_RETRY_BASE_MS = Math.max(
  0,
  Number(process.env.MEASUREMENT_ANALYSIS_SEMANTICS_RETRY_BASE_MS ?? 400),
);
/** 지수 백오프 + jitter(0~50%). attempt 는 1-based. */
function retryBackoffMs(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  const exp = baseMs * 2 ** (attempt - 1);
  return Math.round(exp * (1 + Math.random() * 0.5));
}

// 멘션 추출도 같은 재시도 결함을 공유한다 (change extract-retry-hardening).
// 다만 semantics 와 성공 판정이 다르다: **멘션 0개는 정상 결과**다(브랜드가
// 언급되지 않은 답변). 그래서 "빈 배열이면 재시도"를 쓰면 안 되고, 봉투가 읽히면
// 성공으로 친다 — 재시도는 JSON 자체가 깨졌을 때만.
const EXTRACT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.MEASUREMENT_ANALYSIS_EXTRACT_MAX_ATTEMPTS ?? 4),
);
const EXTRACT_RETRY_BASE_MS = Math.max(
  0,
  Number(process.env.MEASUREMENT_ANALYSIS_EXTRACT_RETRY_BASE_MS ?? 400),
);
/** 멘션 원소 — 배열 전체 parse 대신 원소별로 걸러 유효한 것만 취한다. */
const MentionExtractionEntrySchema =
  MentionExtractionSchema.shape.mentions.removeDefault().element;
const MentionExtractionEnvelopeSchema = z.object({
  mentions: z.array(z.unknown()).default([]),
  generic_final_choice: z
    .object({
      evidence_snippet: z.string().optional(),
      confidence: z.coerce.number().min(0).max(1).optional(),
    })
    .nullable()
    .optional(),
  warnings: z.array(z.string()).optional().default([]),
});
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** 진단용 — 실패한 응답의 앞부분. 원문을 남기지 않으면 재현 실험 없이는 원인을 못 본다. */
function responseExcerpt(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…(${t.length}자)` : t;
}

export interface MentionSemanticsDecision {
  index: number;
  sentiment: MentionSentiment;
  mentionType: MentionAssertion;
}

export interface MentionSemanticsResult {
  decisions: MentionSemanticsDecision[];
  parserPartial: boolean;
  malformedCount: number;
  warnings: string[];
  costUsd?: number;
  attempts?: number;
  modelSlug?: string;
  traceId?: string;
  failed?: boolean;
  errorMessage?: string;
  /** 봉투는 읽혔으나 원소 일부가 스키마를 벗어나 버려진 수 (부분 채점) */
  droppedEntries?: number;
  /** 마지막 실패 응답의 앞부분 — 재현 없이 원인을 보기 위한 진단 필드 */
  lastResponseExcerpt?: string;
}

export type MentionSemanticsInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

export async function classifyMentionSemanticsWithLlm(input: {
  promptText?: string | null;
  answerText: string;
  mentions: Array<{
    index: number;
    surfaceText: string;
    mentionPosition: number;
    contextSnippet?: string | null;
  }>;
  /** 주입 필수 — 이 모듈은 transport 를 값으로 갖지 않는다(파일 머리 참고). */
  invokeFn: MentionSemanticsInvoker;
  /** 테스트가 백오프 대기를 없애기 위해 주입한다 (기본값은 env/상수). */
  retry?: { maxAttempts?: number; baseMs?: number };
}): Promise<MentionSemanticsResult> {
  const invokeFn = input.invokeFn;
  const maxAttempts = Math.max(
    1,
    input.retry?.maxAttempts ?? SEMANTICS_MAX_ATTEMPTS,
  );
  const retryBaseMs = Math.max(0, input.retry?.baseMs ?? SEMANTICS_RETRY_BASE_MS);
  if (input.mentions.length === 0) {
    return {
      decisions: [],
      parserPartial: false,
      malformedCount: 0,
      warnings: [],
      attempts: 0,
      costUsd: 0,
    };
  }
  const system = [
    "You score the sentiment and the type of each given brand/model mention in an AI assistant's answer to a consumer purchase-decision question.",
    'Return JSON only: {"semantics":[{"index":<int>,"sentiment":"positive|neutral|negative|mixed","mention_type":"mention_only|recommend|final_choice|compare|reject|definition"}]}.',
    "Score EACH mention by its index, using ONLY the clause/sentence about THAT specific mention. Do NOT let a neighboring brand's sentiment leak across — two brands in the same line can have opposite sentiment.",
    "sentiment: positive = the answer speaks well of it or recommends it; negative = criticizes it or advises against it; mixed = states clear upsides AND clear downsides; neutral = merely listed, compared neutrally, or factual.",
    "mention_type: recommend = recommended/endorsed; final_choice = the single chosen pick; compare = presented as a comparison target; reject = advised against; definition = defined or explained; mention_only = a plain reference.",
    "Return exactly one entry per provided index. Do not invent indices or add mentions that were not given.",
  ].join(" ");
  const payload = {
    prompt_text: input.promptText ?? null,
    answer_text: input.answerText.slice(0, 20000),
    mentions: input.mentions.slice(0, 150).map((mention) => ({
      index: mention.index,
      surface_text: mention.surfaceText,
      mention_position: mention.mentionPosition,
      context_snippet: mention.contextSnippet?.slice(0, 400) ?? null,
    })),
    required_schema: {
      semantics: [
        {
          index: "the provided mention index",
          sentiment: "positive|neutral|negative|mixed",
          mention_type:
            "mention_only|recommend|final_choice|compare|reject|definition",
        },
      ],
    },
  };

  let malformedCount = 0;
  let attempts = 0;
  let costUsd = 0;
  let modelSlug: string | undefined;
  let traceId: string | undefined;

  let lastExcerpt: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 첫 시도 외에는 백오프. 실패가 일시적이므로 즉시 재던지면 같은 장애 구간을
    // 그대로 다시 맞는다.
    if (attempt > 1) await sleep(retryBackoffMs(attempt - 1, retryBaseMs));
    let res: ClaudeResponse;
    try {
      res = await invokeFn({
        task: "measurement.analysis.mention_semantics",
        model: "haiku",
        temperature: 0,
        maxTokens: 4000,
        responseFormat: { type: "json_object" },
        reasoning: { max_tokens: 256, exclude: true },
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      });
    } catch (error) {
      attempts++;
      // 호출 자체가 던진 경우도 일시적일 수 있다 — 남은 시도가 있으면 계속한다.
      lastExcerpt = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) continue;
      return {
        decisions: [],
        parserPartial: true,
        malformedCount,
        warnings: [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        failed: true,
        errorMessage: lastExcerpt,
        lastResponseExcerpt: lastExcerpt,
      };
    }
    attempts++;
    costUsd += res.costUsd ?? 0;
    modelSlug = res.modelId;
    traceId = res.traceId;
    try {
      const envelope = MentionSemanticsEnvelopeSchema.parse(
        parseJsonObject(res.text),
      );
      // 원소 단위 파싱 — 하나가 어긋나도 나머지는 살린다.
      const decisions: MentionSemanticsDecision[] = [];
      let dropped = 0;
      for (const raw of envelope.semantics) {
        const entry = MentionSemanticsEntrySchema.safeParse(raw);
        if (!entry.success) {
          dropped++;
          continue;
        }
        decisions.push({
          index: entry.data.index,
          sentiment: entry.data.sentiment,
          mentionType: entry.data.mention_type,
        });
      }
      // 하나도 못 건졌으면 파싱 성공으로 치지 않는다 — 남은 시도를 쓴다.
      if (decisions.length === 0 && input.mentions.length > 0) {
        malformedCount++;
        lastExcerpt = responseExcerpt(res.text);
        continue;
      }
      return {
        decisions,
        parserPartial: dropped > 0,
        malformedCount,
        warnings: envelope.warnings ?? [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        droppedEntries: dropped,
        ...(dropped > 0 ? { lastResponseExcerpt: responseExcerpt(res.text) } : {}),
      };
    } catch {
      malformedCount++;
      lastExcerpt = responseExcerpt(res.text);
    }
  }

  return {
    decisions: [],
    parserPartial: true,
    malformedCount,
    warnings: [],
    lastResponseExcerpt: lastExcerpt,
    costUsd,
    attempts,
    modelSlug,
    traceId,
  };
}

// ─── 감성 판별 V2 (change mention-semantics-v2) ──────────────────────────────
//
// 현행 semantics 패스와 다른 점:
//   ① 대상은 Brand·Product 멘션만(D1). 나머지는 기계 감성(regex_line)을 유지한다.
//   ② 근거 입력은 contextSnippet 이 아니라 **멘션 오프셋으로 파생한 줄**이다.
//      contextSnippet 은 같은 표면의 다른 출현에서 왔을 수 있어 금지.
//   ③ 판정마다 evidence(원문 인용)·reason(한국어 한 문장)을 받고, evidence 는 원문에서
//      다시 찾아 검증한다. 못 찾으면 null(환각 인용 저장 금지).
//   ④ json_schema strict 로 요청한다. Bedrock 폴백은 response_format 을 버리므로
//      파싱은 여전히 원소 단위 safeParse 다.
//   ⑤ 첫 응답에서 빠진 index 만 모아 **1회** 재요청한다.
//
// 시스템 프롬프트는 실험 V3SM 원문 그대로다(수정 금지, 품질 수치가 이 문구에 묶여 있다).
// V3S 에 mention_type 을 더한 판이다(테오 결정 2026-09-17: V2 가 현행 semantics 를 대체해도
// type_breakdown 이 정규식 assertion 으로 폴백하지 않게). 45개국 카나리 Brand·Product 1,355건
// 에서 현행 V0 와 감성 일치 90.9%(V3S 86.9%).
export const MENTION_SEMANTICS_V2_SYSTEM_PROMPT =
  "You score the sentiment of each brand/model mention in an AI assistant's answer to a consumer purchase-decision question. Each mention comes with `line`: the full line (newline to newline) of answer_text that contains it. Judge primarily from that line; use the rest of answer_text only to resolve what the line refers to (e.g. '이 부분'). Return JSON only: {\"semantics\":[{\"index\":<int>,\"sentiment\":\"positive|neutral|negative|mixed\",\"mention_type\":\"mention_only|recommend|final_choice|compare|reject|definition\",\"evidence\":\"<verbatim quote>\",\"reason\":\"<Korean>\"}]}. mention_type: recommend = recommended/endorsed; final_choice = the single chosen pick; compare = presented as a comparison target; reject = advised against; definition = defined or explained; mention_only = a plain reference. sentiment: positive = the answer speaks well of it or recommends it; negative = criticizes it or advises against it; mixed = states clear upsides AND clear downsides; neutral = merely listed, compared neutrally, or factual. Do NOT let a neighboring brand's sentiment leak across — two brands in the same sentence can have opposite sentiment. evidence: copy VERBATIM the shortest span of answer_text (one clause or sentence, max 200 chars) that justifies the sentiment for THAT mention. It must be an exact substring of answer_text. reason: one short sentence in Korean. Return exactly one entry per provided index.";

/** strict json_schema. OpenAI strict 규칙상 모든 객체가 additionalProperties false·required 전부. */
export const MENTION_SEMANTICS_V2_JSON_SCHEMA = {
  type: "object",
  properties: {
    semantics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          sentiment: {
            type: "string",
            enum: ["positive", "neutral", "negative", "mixed"],
          },
          mention_type: {
            type: "string",
            enum: [
              "mention_only",
              "recommend",
              "final_choice",
              "compare",
              "reject",
              "definition",
            ],
          },
          evidence: { type: "string" },
          reason: { type: "string" },
        },
        required: ["index", "sentiment", "mention_type", "evidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["semantics"],
  additionalProperties: false,
} as const;

/** V2 대상 엔티티 타입(D1). */
export const SEMANTICS_V2_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "Brand",
  "Product",
]);
/** 한 콜에 싣는 대상 수 상한. 현행 semantics 와 같다. */
export const SEMANTICS_V2_MENTION_CAP = 150;
/** 줄 입력 상한(자). 넘으면 오프셋을 포함하는 문장으로 자른다. */
export const SEMANTICS_V2_LINE_CHAR_CAP = 1000;
/** evidence·reason 저장 상한(자). */
export const SEMANTICS_V2_TEXT_CAP = 300;
/**
 * 누락 index 재요청 호출 수. **1회 고정**이고 이 호출 자체는 백오프 재시도하지 않는다.
 * 그래서 한 턴의 V2 호출 총상한 = 첫 패스 백오프 루프(maxAttempts, 기본 4) + 1 이다.
 * 과금 폭주를 막는 상한이므로 env 로 열지 않는다.
 */
export const SEMANTICS_V2_MISSING_RETRY_CALLS = 1;
/**
 * 출력 토큰 상한. 현행 semantics 4,000 대비 V2 는 evidence·reason 때문에 실측 출력이
 * 약 2.4배(실험 보고서)라 4,000 x 2.4 = 9,600 을 올림해 10,000 으로 둔다. 잘리면 JSON 이
 * 통째로 깨져 재시도 루프를 태우므로 여유를 둔다.
 */
export const SEMANTICS_V2_MAX_TOKENS = 10000;

export type SemanticsV2Source =
  | "llm_semantics_v2"
  | "llm_semantics_v2_retry"
  | "regex_line";

/**
 * 멘션 오프셋(UTF-16, `finalizeMentionOffsets` 이전)으로 판정 입력 줄을 만든다.
 * 줄이 상한을 넘으면 오프셋을 포함하는 문장(종결부호 `.!?。` 뒤 공백·줄바꿈 경계)으로
 * 자르고, 그래도 넘으면 멘션을 중심으로 상한 길이 창을 잘라낸다.
 */
export function deriveSemanticsV2Line(
  answerText: string,
  sourceStart: number,
  sourceEnd: number,
  cap: number = SEMANTICS_V2_LINE_CHAR_CAP,
): string {
  const start = Math.max(0, Math.min(sourceStart, answerText.length));
  const end = Math.max(start, Math.min(sourceEnd, answerText.length));
  const line = containingLine(answerText, start, end);
  if (line.text.length <= cap) return line.text;

  // 문장 경계. 줄 경계는 containingLine 이 이미 잡았다.
  //   · 서양 종결부호 . ! ? 는 뒤에 공백류가 올 때만 경계다(소수점 3.5·URL 오탐 방지).
  //   · CJK 전각 종결부호 。！？ 는 뒤 공백 없이도 경계다(중국어·일본어는 띄어 쓰지 않는다).
  // 두 갈래 모두 매치 길이가 1이라 경계 위치는 m.index + 1 이다.
  const text = line.text;
  const localStart = start - line.start;
  const localEnd = end - line.start;
  let sentStart = 0;
  const boundary = /[.!?](?=\s)|[。！？]/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const after = m.index + 1;
    if (after <= localStart) {
      sentStart = after;
    } else {
      break;
    }
  }
  let sentEnd = text.length;
  boundary.lastIndex = Math.max(localEnd - 1, 0);
  while ((m = boundary.exec(text)) !== null) {
    if (m.index + 1 >= localEnd) {
      sentEnd = m.index + 1;
      break;
    }
  }
  // 앞 공백은 문장에 속하지 않는다.
  while (sentStart < localStart && /\s/.test(text[sentStart]!)) sentStart++;
  if (sentEnd - sentStart <= cap) return text.slice(sentStart, sentEnd);

  // 문장조차 상한을 넘으면 멘션 중심 창. 멘션 자체가 상한보다 길면 멘션 앞부분부터.
  const span = localEnd - localStart;
  const pad = Math.max(0, Math.floor((cap - span) / 2));
  let winStart = Math.max(sentStart, localStart - pad);
  const winEnd = Math.min(sentEnd, winStart + cap);
  winStart = Math.max(sentStart, winEnd - cap);
  return text.slice(winStart, winEnd);
}

/** 마크다운 강조 기호·백틱 제거 + 연속 공백 1칸 접기. evidence 느슨 대조용. */
function looseEvidenceKey(s: string): string {
  return s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}

/** 코드포인트 기준 절단. UTF-16 slice 는 짝 없는 서로게이트로 끝날 수 있다. */
function sliceCodePoints(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return Array.from(s).slice(0, cap).join("");
}

/**
 * evidence 가 답변 원문에 실제로 있는지 검증. 정확 일치 또는 마크다운 기호·연속 공백을
 * 무시한 일치면 (300자 상한으로 자른) 인용을 돌려주고, 아니면 null.
 */
export function verifySemanticsV2Evidence(
  answerText: string,
  evidence: string | null | undefined,
  cap: number = SEMANTICS_V2_TEXT_CAP,
): string | null {
  const ev = (evidence ?? "").trim();
  if (ev.length === 0) return null;
  // 기호를 벗긴 본문에 문자(글자·숫자) 가 하나도 없으면 인용이 아니다("**", "...", U+2014 류).
  // 이 조건은 정확 일치보다 먼저 본다: 기호만 인용은 원문에 그대로 있어도 근거가 아니다.
  const key = looseEvidenceKey(ev);
  if (!/[\p{L}\p{N}]/u.test(key)) return null;
  // ① 원문에 바이트 그대로 있으면 통과. 느슨 정규화는 이 경우를 포함하지 **않는다**:
  //    원문 "**현대 투싼**은" 에서 인용 "*현대 투싼*" 은 정확 일치지만, 벗기면 "*현대 투싼*"
  //    과 "현대 투싼은" 이 되어 느슨 대조에서는 떨어진다(943a243 회귀, 검증자 재현).
  if (answerText.includes(ev)) return sliceCodePoints(ev, cap);
  // ② 정확 일치가 아니면 마크다운 기호·연속 공백을 같은 방식으로 정규화한 원문에서 찾는다.
  if (!looseEvidenceKey(answerText).includes(key)) return null;
  return sliceCodePoints(ev, cap);
}

// ⚠️ `.optional()` 이 transform 앞에 있어야 한다. zod 4 에서 `z.unknown().transform()`
// 은 키 자체가 빠진 원소를 필수 키 누락으로 거부해, evidence·reason 을 생략한 응답이
// 통째로 버려지고 재시도 루프만 소진했다(검증자 재현: {index, sentiment} 만 있는 응답).
const LenientOptionalTextSchema = z.unknown().optional().transform((raw) =>
  typeof raw === "string" ? raw : null,
);
// mention_type 도 부속 정보다: enum 밖이거나 빠지면 null 로 접고 감성 판정은 살린다.
const LenientMentionTypeSchema = z
  .unknown()
  .optional()
  .transform((raw): MentionAssertion | null => {
    const parsed = MentionAssertionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
const MentionSemanticsV2EntrySchema = z.object({
  index: z.coerce.number().int().nonnegative(),
  sentiment: MentionSentimentSchema,
  mention_type: LenientMentionTypeSchema,
  // evidence·reason 은 부속 정보다. 빠지거나 null 이어도 감성 판정은 살린다.
  evidence: LenientOptionalTextSchema,
  reason: LenientOptionalTextSchema,
});
const MentionSemanticsV2EnvelopeSchema = z.object({
  semantics: z.array(z.unknown()).default([]),
});

export interface MentionSemanticsV2Mention {
  /** 원배열 index. LLM index 로 그대로 쓰고 결과도 이 index 로 돌아온다. */
  index: number;
  surfaceText: string;
  mentionPosition: number;
  entityType?: string | null;
  entityId?: string | null;
  /** UTF-16 오프셋. 없으면 줄을 만들 수 없어 V2 대상에서 빠진다(regex_line). */
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface MentionSemanticsV2Decision {
  index: number;
  sentiment: MentionSentiment;
  /** LLM mention_type. enum 밖·누락이면 null(병합은 llm_mention_type 을 싣지 않는다). */
  mentionType: MentionAssertion | null;
  evidence: string | null;
  reason: string | null;
  source: Exclude<SemanticsV2Source, "regex_line">;
}

export interface MentionSemanticsV2Result {
  /** 중복 fan-out 이 끝난 판정. 여기 없는 index 는 호출부가 regex_line 으로 둔다. */
  decisions: MentionSemanticsV2Decision[];
  /** D1·오프셋 조건을 통과한 멘션 수(중복 포함). */
  eligibleCount: number;
  /** 중복 제거 후 실제로 보낸 대상 수(상한 적용 후). */
  requestedCount: number;
  /** 누락으로 재요청한 index 수(0 이면 재요청 안 함). */
  retryRequestedCount: number;
  /** 재요청 후에도 판정 못 받은 대상 수(중복 제거 기준). */
  missingCount: number;
  /** evidence 가 원문 대조에 실패해 null 로 접힌 수. */
  evidenceRejectedCount: number;
  parserPartial: boolean;
  malformedCount: number;
  droppedEntries: number;
  attempts: number;
  costUsd: number;
  modelSlug?: string;
  traceId?: string;
  failed: boolean;
  errorMessage?: string;
  lastResponseExcerpt?: string;
}

interface V2CallOutcome {
  entries: Array<z.infer<typeof MentionSemanticsV2EntrySchema>>;
  attempts: number;
  costUsd: number;
  malformedCount: number;
  droppedEntries: number;
  modelSlug?: string;
  traceId?: string;
  failed: boolean;
  errorMessage?: string;
  lastResponseExcerpt?: string;
}

export async function classifyMentionSemanticsV2(input: {
  promptText?: string | null;
  answerText: string;
  mentions: MentionSemanticsV2Mention[];
  /** 주입 필수. 이 모듈은 transport 를 값으로 갖지 않는다(파일 머리 참고). */
  invokeFn: MentionSemanticsInvoker;
  /** 테스트가 백오프 대기를 없애기 위해 주입한다 (기본값은 env/상수). */
  retry?: { maxAttempts?: number; baseMs?: number };
}): Promise<MentionSemanticsV2Result> {
  const maxAttempts = Math.max(
    1,
    input.retry?.maxAttempts ?? SEMANTICS_MAX_ATTEMPTS,
  );
  const retryBaseMs = Math.max(0, input.retry?.baseMs ?? SEMANTICS_RETRY_BASE_MS);
  const answerText = input.answerText;

  // D1 필터 + 오프셋 필수 + 중복 제거. 대표 index 는 그룹의 첫 원소.
  const eligible = input.mentions.filter(
    (m) =>
      m.entityType != null &&
      SEMANTICS_V2_ENTITY_TYPES.has(m.entityType) &&
      typeof m.sourceStart === "number" &&
      typeof m.sourceEnd === "number" &&
      m.sourceEnd > m.sourceStart,
  );
  const groups = new Map<string, { rep: MentionSemanticsV2Mention; members: number[] }>();
  for (const m of eligible) {
    const key = `${m.sourceStart}\u0000${m.sourceEnd}\u0000${m.entityId ?? m.surfaceText}`;
    const g = groups.get(key);
    if (g) g.members.push(m.index);
    else groups.set(key, { rep: m, members: [m.index] });
  }
  const targets = [...groups.values()].slice(0, SEMANTICS_V2_MENTION_CAP);

  const empty: MentionSemanticsV2Result = {
    decisions: [],
    eligibleCount: eligible.length,
    requestedCount: 0,
    retryRequestedCount: 0,
    missingCount: 0,
    evidenceRejectedCount: 0,
    parserPartial: false,
    malformedCount: 0,
    droppedEntries: 0,
    attempts: 0,
    costUsd: 0,
    failed: false,
  };
  if (targets.length === 0) return empty;

  const lineByIndex = new Map<number, string>();
  for (const t of targets) {
    lineByIndex.set(
      t.rep.index,
      deriveSemanticsV2Line(answerText, t.rep.sourceStart!, t.rep.sourceEnd!),
    );
  }
  const targetIndexSet = new Set(targets.map((t) => t.rep.index));

  const callOnce = async (
    subset: typeof targets,
    loopAttempts: number,
  ): Promise<V2CallOutcome> => {
    const payload = {
      prompt_text: input.promptText ?? null,
      answer_text: answerText.slice(0, 20000),
      mentions: subset.map((t) => ({
        index: t.rep.index,
        surface_text: t.rep.surfaceText,
        mention_position: t.rep.mentionPosition,
        // 문장으로 대체된 경우에도 키 이름은 line 그대로(프롬프트 원문이 이 키를 가리킨다).
        line: lineByIndex.get(t.rep.index) ?? "",
      })),
    };
    const out: V2CallOutcome = {
      entries: [],
      attempts: 0,
      costUsd: 0,
      malformedCount: 0,
      droppedEntries: 0,
      failed: false,
    };
    for (let attempt = 1; attempt <= loopAttempts; attempt++) {
      if (attempt > 1) await sleep(retryBackoffMs(attempt - 1, retryBaseMs));
      let res: ClaudeResponse;
      try {
        res = await input.invokeFn({
          // 태스크 이름은 현행 semantics 와 같다: 모델 라우팅 표(LIVE_TASK_MODELS)를 그대로 탄다.
          task: "measurement.analysis.mention_semantics",
          model: "haiku",
          temperature: 0,
          maxTokens: SEMANTICS_V2_MAX_TOKENS,
          responseFormat: {
            type: "json_schema",
            json_schema: {
              name: "semantics",
              strict: true,
              schema: MENTION_SEMANTICS_V2_JSON_SCHEMA,
            },
          },
          reasoning: { max_tokens: 256, exclude: true },
          system: MENTION_SEMANTICS_V2_SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(payload) }],
        });
      } catch (error) {
        out.attempts++;
        out.lastResponseExcerpt =
          error instanceof Error ? error.message : String(error);
        if (attempt < loopAttempts) continue;
        out.failed = true;
        out.errorMessage = out.lastResponseExcerpt;
        return out;
      }
      out.attempts++;
      out.costUsd += res.costUsd ?? 0;
      out.modelSlug = res.modelId;
      out.traceId = res.traceId;
      try {
        const envelope = MentionSemanticsV2EnvelopeSchema.parse(
          parseJsonObject(res.text),
        );
        const entries: V2CallOutcome["entries"] = [];
        let dropped = 0;
        for (const raw of envelope.semantics) {
          const entry = MentionSemanticsV2EntrySchema.safeParse(raw);
          // 스키마 위반·요청하지 않은 index 는 버린다(환각 index 가 남의 멘션을 덮지 않게).
          if (!entry.success || !targetIndexSet.has(entry.data.index)) {
            dropped++;
            continue;
          }
          entries.push(entry.data);
        }
        out.droppedEntries += dropped;
        if (entries.length === 0) {
          out.malformedCount++;
          out.lastResponseExcerpt = responseExcerpt(res.text);
          continue;
        }
        out.entries = entries;
        if (dropped > 0) out.lastResponseExcerpt = responseExcerpt(res.text);
        return out;
      } catch {
        out.malformedCount++;
        out.lastResponseExcerpt = responseExcerpt(res.text);
      }
    }
    // 루프 소진: 호출은 됐지만 건진 판정이 없다.
    out.failed = true;
    return out;
  };

  const decidedByRep = new Map<number, MentionSemanticsV2Decision>();
  let evidenceRejected = 0;
  const absorb = (
    entries: V2CallOutcome["entries"],
    source: MentionSemanticsV2Decision["source"],
  ): void => {
    for (const e of entries) {
      if (decidedByRep.has(e.index)) continue; // 같은 index 중복 응답은 첫 값
      const evidence = verifySemanticsV2Evidence(answerText, e.evidence);
      if (evidence === null && (e.evidence ?? "").trim().length > 0) {
        evidenceRejected++;
      }
      const reason = sliceCodePoints((e.reason ?? "").trim(), SEMANTICS_V2_TEXT_CAP);
      decidedByRep.set(e.index, {
        index: e.index,
        sentiment: e.sentiment,
        mentionType: e.mention_type,
        evidence,
        reason: reason.length > 0 ? reason : null,
        source,
      });
    }
  };

  const first = await callOnce(targets, maxAttempts);
  absorb(first.entries, "llm_semantics_v2");

  let attempts = first.attempts;
  let costUsd = first.costUsd;
  let malformedCount = first.malformedCount;
  let droppedEntries = first.droppedEntries;
  let modelSlug = first.modelSlug;
  let traceId = first.traceId;
  let lastExcerpt = first.lastResponseExcerpt;
  let retryRequestedCount = 0;

  // 누락 재요청: 첫 패스가 일부라도 건졌을 때만. 첫 패스가 통째로 실패했다면 백오프
  // 루프가 이미 같은 요청을 maxAttempts 번 던졌으므로 한 번 더 던져도 얻을 게 없다.
  const missingAfterFirst = targets.filter((t) => !decidedByRep.has(t.rep.index));
  if (decidedByRep.size > 0 && missingAfterFirst.length > 0) {
    retryRequestedCount = missingAfterFirst.length;
    const retry = await callOnce(missingAfterFirst, SEMANTICS_V2_MISSING_RETRY_CALLS);
    absorb(retry.entries, "llm_semantics_v2_retry");
    attempts += retry.attempts;
    costUsd += retry.costUsd;
    malformedCount += retry.malformedCount;
    droppedEntries += retry.droppedEntries;
    modelSlug = retry.modelSlug ?? modelSlug;
    traceId = retry.traceId ?? traceId;
    lastExcerpt = retry.lastResponseExcerpt ?? lastExcerpt;
  }

  const decisions: MentionSemanticsV2Decision[] = [];
  for (const t of targets) {
    const d = decidedByRep.get(t.rep.index);
    if (!d) continue;
    for (const idx of t.members) decisions.push({ ...d, index: idx });
  }
  decisions.sort((a, b) => a.index - b.index);
  const missingCount = targets.length - decidedByRep.size;

  return {
    decisions,
    eligibleCount: eligible.length,
    requestedCount: targets.length,
    retryRequestedCount,
    missingCount,
    evidenceRejectedCount: evidenceRejected,
    parserPartial: droppedEntries > 0 || missingCount > 0,
    malformedCount,
    droppedEntries,
    attempts,
    costUsd,
    modelSlug,
    traceId,
    failed: decidedByRep.size === 0,
    ...(decidedByRep.size === 0 && first.errorMessage
      ? { errorMessage: first.errorMessage }
      : {}),
    ...(lastExcerpt ? { lastResponseExcerpt: lastExcerpt } : {}),
  };
}

// ─── 답변 단위 브랜드 스탠스 (change add-answer-brand-stance) ─────────────────
//
// semantics 와 **입력 단위가 다르다**. semantics 는 `context_snippet` 400자를 가진
// 멘션 배열을 받아 절(clause) 안에서만 채점한다(`:548` "using ONLY the clause/
// sentence about THAT specific mention") — 그래서 브랜드 표면이 없는 문장은
// 구조적으로 채점 대상이 아니고, 대명사·"厂方"·"이 업데이트" 로 이어지는 비판이
// 어느 멘션에도 붙지 않는다. 이 패스는 **답변 전문 + 브랜드 목록**을 받아 그
// 누락을 회수한다.
//
// 한 콜에 합치지 않는 이유는 프롬프트 크기가 아니라 **실패 격리**다: 현행 semantics
// 는 실패해도 기계적 감성값이 남는데(`pure/analyze-turn.ts` 의 폴백), 합쳐 실패하면
// 둘 다 잃는다(스펙 §0 R1).
//
// 파싱 규율은 semantics 와 **같다** — 봉투만 zod, 원소는 개별 safeParse
// (2026-07-29 all-or-nothing 사고의 수리를 복제한다).
/**
 * **엄격한 축과 관대한 축을 나눈다.**
 *
 * `brand`·`stance` 는 엄격하다 — 그 둘이 틀리면 **오귀속**이고, 조용한 오분류는
 * 결손보다 나쁘다(퍼지 브랜드 매칭 금지와 같은 원칙).
 *
 * 나머지 셋(`confidence`·`evidence`·`reason_ko`)은 **부속 정보**인데, 초판은
 * 이것들도 엄격해서 값 하나가 어긋나면 **항목 전체가 드롭**됐다. 그 비용이 크다:
 * 드롭이 전부면 `decisions.length === 0` 이라 이 함수가 "파싱 실패"로 보고
 * **temperature 0 으로 같은 프롬프트를 4회까지 재던진다** — 결정적 모델이니
 * 같은 응답이 돌아오고, 결과 0건에 **비용만 4배**다. 구체적 지문 셋:
 *   · `confidence: 95`(백분율) 또는 `"high"` → `.min(0).max(1)` 위반
 *   · `reason_ko: null` → `z.string().optional()` 은 **null 을 거부한다**
 *     (`optional` ≠ `nullable`)
 *   · `evidence: null` → 같은 이유
 * 프롬프트는 이미 `0..1` 스케일을 두 곳에서 명시한다(시스템 프롬프트 ·
 * `required_schema.confidence`). 그래도 어기는 모델이 있고, 그때 잃을 것은
 * 신뢰도 숫자 하나이지 스탠스 판정 전체가 아니다.
 *
 * ⚠️ 범위 밖 숫자는 **clamp 하지 않고 null** 로 접는다. `95 → 1` 로 접으면
 * "확신함"이라는 없는 사실을 만들어낸다 — 모르는 것은 모른다고 적는다.
 */
/**
 * 관대하되 **조작하지는 않는다.**
 *
 * ⚠️ `Number()` 에 아무거나 넣지 않는다 — `Number(true) === 1`,
 * `Number([]) === 0`, `Number([0.5]) === 0.5` 다. 그대로 두면 모델이 `true` 를
 * 보냈을 때 **"신뢰도 1.0"** 이라는 없는 사실이 저장된다. 관대함의 목적은
 * "항목을 살리는 것"이지 "값을 지어내는 것"이 아니다.
 * 숫자·문자열만 숫자로 읽고, 나머지 타입은 전부 null 이다.
 */
export function normalizeStanceConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // 범위 밖은 clamp 하지 않고 null — `95 → 1` 은 없는 확신을 만든다.
  if (n < 0 || n > 1) return null;
  return n;
}

/** 값이 **주어졌는데** 규약을 못 맞춰 강등된 경우만 참. 명시 `null` 은 강등이 아니다. */
export function stanceConfidenceWasCoerced(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  return normalizeStanceConfidence(raw) === null;
}

const LenientConfidenceSchema = z
  .unknown()
  .transform((raw) => normalizeStanceConfidence(raw));
const LenientTextSchema = z.unknown().transform((raw) => {
  if (typeof raw === "string") return raw;
  return null;
});

/**
 * `aspects[]` 파싱 — **어휘는 고정하지 않는다**(테오 결정 2026-09-15). `aspect`
 * 는 자유 문자열이라 zod 어휘 스키마로 검증할 게 없다. 관대함의 경계는 구조
 * 뿐이다: `aspect` 가 비어 있거나 `stance` 가 4값 밖이면 **그 원소만** 드롭한다
 * (브랜드 판정 전체를 드롭하지 않는다 — 부속 필드 관례의 연장).
 *
 * `AnswerBrandStanceEntrySchema` 에 넣지 않고 별도 함수로 둔 이유는
 * `stanceConfidenceWasCoerced` 와 같다 — zod 트랜스폼 안에서 드롭 카운트까지
 * 계수하려면 부작용이 있는 코드가 되어 zod 의 선언적 파싱과 섞인다.
 */
function normalizeStanceAspects(raw: unknown): {
  aspects: RawStanceAspectDecision[];
  dropped: number;
} {
  if (!Array.isArray(raw)) return { aspects: [], dropped: 0 };
  const kept: RawStanceAspectDecision[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (item == null || typeof item !== "object") {
      dropped++;
      continue;
    }
    const obj = item as Record<string, unknown>;
    const aspectLabel =
      typeof obj.aspect === "string" ? obj.aspect.trim() : "";
    if (aspectLabel.length === 0) {
      dropped++;
      continue;
    }
    const stanceParsed = MentionSentimentSchema.safeParse(obj.stance);
    if (!stanceParsed.success) {
      dropped++;
      continue;
    }
    const evidenceRaw = typeof obj.evidence === "string" ? obj.evidence : null;
    kept.push({
      aspect: aspectLabel.slice(0, STANCE_ASPECT_LABEL_CAP),
      stance: stanceParsed.data,
      evidence: evidenceRaw && evidenceRaw.length > 0 ? evidenceRaw : null,
    });
  }
  // 상한 절단은 **드롭이 아니다** — 구조가 멀쩡한 원소가 순서상 밀린 것뿐이다.
  return { aspects: kept.slice(0, STANCE_ASPECT_CAP), dropped };
}

const AnswerBrandStanceEntrySchema = z.object({
  // ── 엄격: 틀리면 오귀속이다 ──
  brand: z.string().min(1),
  // 어휘를 복사하지 않고 재사용한다 (FR2).
  stance: MentionSentimentSchema,
  // ── 관대: 틀려도 스탠스 판정은 살린다 ──
  confidence: LenientConfidenceSchema.optional(),
  evidence: LenientTextSchema.optional(),
  reason_ko: LenientTextSchema.optional(),
});
const AnswerBrandStanceEnvelopeSchema = z.object({
  stances: z.array(z.unknown()).default([]),
  warnings: z.array(z.string()).optional().default([]),
});

const STANCE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.MEASUREMENT_ANALYSIS_STANCE_MAX_ATTEMPTS ?? 4),
);
const STANCE_RETRY_BASE_MS = Math.max(
  0,
  Number(process.env.MEASUREMENT_ANALYSIS_STANCE_RETRY_BASE_MS ?? 400),
);

/** 프롬프트에 싣는 브랜드 상한 — 파일럿(`pilot.py:147`)과 같은 값. */
export const STANCE_BRAND_CAP = 12;
/** 답변 전문 절단 — semantics 와 같은 상한. */
export const STANCE_ANSWER_CHAR_CAP = 20000;

/** 원소 하나 — 아직 증거 검증 전(오프셋 계산은 순수 계층의 몫). */
export interface RawStanceAspectDecision {
  /** 자유 문자열. 어휘를 고정하지 않는다(테오 결정 2026-09-15). */
  aspect: string;
  stance: MentionSentiment;
  evidence: string | null;
}

export interface AnswerBrandStanceDecision {
  /** 모델이 돌려준 브랜드 문자열 **그대로**. 매칭은 순수 계층이 한다. */
  brand: string;
  stance: MentionSentiment;
  confidence: number | null;
  evidence: string | null;
  reasonKo: string | null;
  /** 0~`STANCE_ASPECT_CAP`개. 관대하게 파싱됐다 — 개별 드롭은 envelope 의
   *  `droppedAspects` 로 계수된다(원소 하나가 어긋나도 브랜드 판정 전체는 산다). */
  aspects: RawStanceAspectDecision[];
}

export interface AnswerBrandStanceResult {
  decisions: AnswerBrandStanceDecision[];
  parserPartial: boolean;
  malformedCount: number;
  warnings: string[];
  costUsd?: number;
  attempts?: number;
  modelSlug?: string;
  traceId?: string;
  failed?: boolean;
  errorMessage?: string;
  /** 봉투는 읽혔으나 원소 일부가 스키마를 벗어나 버려진 수 (부분 채점) */
  droppedEntries?: number;
  /**
   * `confidence` 가 규약(0..1)을 벗어나 null 로 접힌 항목 수. **드롭이 아니다** —
   * 스탠스 판정은 살아 있다. 이 값이 꾸준히 높으면 프롬프트의 스케일 지시가
   * 안 먹는다는 뜻이고, 그때 고칠 것은 재시도가 아니라 프롬프트다.
   */
  coercedConfidence?: number;
  /**
   * `aspects[]` 원소 중 구조가 어긋나(빈 `aspect` 문자열·어휘 밖 `stance`) 그
   * 원소만 드롭된 수의 합(전 브랜드 합산). **브랜드 판정 자체의 드롭이 아니다**
   * — `droppedEntries` 와 구분된다. 상한(`STANCE_ASPECT_CAP`) 절단은 여기 안
   * 센다(구조가 멀쩡한데 잘린 것은 결함 신호가 아니다).
   */
  droppedAspects?: number;
  /** 마지막 실패 응답의 앞부분 — 재현 없이 원인을 보기 위한 진단 필드 */
  lastResponseExcerpt?: string;
}

export type AnswerBrandStanceInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

/**
 * `stance-v2` 시스템 프롬프트. 파일럿 SYSTEM(`scratchpad/sincha-stance/pilot.py:96~104`)
 * 을 기반으로 코어 semantics 의 **금지 조항 관례**(`:551` "Do not invent indices…")
 * 를 이식했다. 문구를 바꾸면 `STANCE_PROMPT_VERSION` 을 올린다 — `ANALYSIS_VERSION`
 * 은 건드리지 않는다(전 코퍼스 재분석 트리거).
 */
export const ANSWER_BRAND_STANCE_SYSTEM_PROMPT = [
  "You judge an AI assistant's OVERALL stance toward each listed brand in one answer to a consumer purchase-decision question.",
  'Read the WHOLE answer first. Criticism or praise that refers to a brand by pronoun, by one of its model names, by "the manufacturer"/"厂方"/"this update", or by an unnamed reference that the surrounding text makes unambiguous, STILL COUNTS for that brand. This is the difference from per-mention scoring: you are not limited to the clause containing the name.',
  "stance: positive = praise, recommendation, or advantages clearly dominate; negative = criticism, complaints, warnings, or advising against clearly dominate; mixed = substantive upsides AND substantive downsides are both stated; neutral = only listed, compared factually, or mentioned in passing without evaluation.",
  'evidence MUST be a VERBATIM substring of the answer, at most 200 characters, that is the single strongest support for the stance. Copy it exactly — do not paraphrase, translate, trim whitespace differently, or add ellipses. If no single span supports it, return "".',
  // ── aspects[] (테오 결정 2026-09-15) ── 어휘를 미리 정의하지 않는다. 카탈로그를
  // 주면 그 목록 밖 속성은 모델이 아예 뽑지 않게 되고, 그 결손은 나중에 되돌릴
  // 수 없다 — 정규화(같은 뜻을 한 축으로 묶는 것)는 v2 사후 처리로 미룬다.
  `For each brand, also list up to ${STANCE_ASPECT_CAP} SPECIFIC attributes the answer actually evaluated for that brand (e.g. fuel economy, ride comfort, price, reliability, design, after-sales service, software/updates — but do NOT limit yourself to this list; use whatever the answer actually talks about). There is NO fixed vocabulary — write the aspect label as a SHORT phrase (at most ${STANCE_ASPECT_LABEL_CAP} characters) in the SAME LANGUAGE the answer uses for it. Only include an aspect the answer explicitly evaluates for that brand; if the answer gives no attribute-level detail, return an empty aspects list for it.`,
  'Each aspect needs its own stance (same 4 values as above) and its own evidence (VERBATIM substring of the answer, at most 200 characters, or "" if none) — an aspect\'s evidence is usually a narrower span than the brand\'s overall evidence.',
  'Return JSON only: {"stances":[{"brand":<exact name as given>,"stance":"positive|negative|mixed|neutral","confidence":0..1,"evidence":<verbatim quote or "">,"reason_ko":<one short Korean sentence>,"aspects":[{"aspect":<short free-text label, answer\'s own language>,"stance":"positive|negative|mixed|neutral","evidence":<verbatim quote or "">}]}]}.',
  "Return exactly one entry per brand in brands_to_rate, using the brand string EXACTLY as given. Do not invent brands, do not merge brands, do not omit any.",
].join(" ");

/**
 * 답변 전문 1건에 대해 브랜드별 스탠스를 받는다.
 *
 * 호출부는 순수 계층(`pure/analyze-turn.ts`)이고 transport 는 주입이다 — 이
 * 모듈은 `@/lib/llm/invoke` 를 값으로 갖지 않는다(파일 머리 ⚠️,
 * `check:analysis-pure-boundary` 불변식 4).
 */
export async function classifyAnswerBrandStanceWithLlm(input: {
  promptText?: string | null;
  answerText: string;
  /** 이미 §4.5 규칙으로 정렬·절단된 목록. 이 함수는 순서를 바꾸지 않는다. */
  brands: string[];
  invokeFn: AnswerBrandStanceInvoker;
  retry?: { maxAttempts?: number; baseMs?: number };
}): Promise<AnswerBrandStanceResult> {
  const invokeFn = input.invokeFn;
  const maxAttempts = Math.max(
    1,
    input.retry?.maxAttempts ?? STANCE_MAX_ATTEMPTS,
  );
  const retryBaseMs = Math.max(0, input.retry?.baseMs ?? STANCE_RETRY_BASE_MS);
  if (input.brands.length === 0) {
    return {
      decisions: [],
      parserPartial: false,
      malformedCount: 0,
      warnings: [],
      attempts: 0,
      costUsd: 0,
    };
  }
  const system = ANSWER_BRAND_STANCE_SYSTEM_PROMPT;
  const payload = {
    prompt_text: input.promptText ?? null,
    answer_text: input.answerText.slice(0, STANCE_ANSWER_CHAR_CAP),
    brands_to_rate: input.brands.slice(0, STANCE_BRAND_CAP),
    required_schema: {
      stances: [
        {
          brand: "the brand string exactly as given in brands_to_rate",
          stance: "positive|negative|mixed|neutral",
          confidence: "0..1",
          evidence: "verbatim substring of answer_text, or empty string",
          reason_ko: "one short Korean sentence",
          // 어휘를 못박지 않는다 — `aspect` 는 자유 텍스트다(테오 결정 2026-09-15).
          aspects: [
            {
              aspect: `free-text label in the answer's own language, no fixed vocabulary, at most ${STANCE_ASPECT_LABEL_CAP} chars`,
              stance: "positive|negative|mixed|neutral",
              evidence: "verbatim substring of answer_text, or empty string",
            },
          ],
        },
      ],
    },
  };

  let malformedCount = 0;
  let attempts = 0;
  let costUsd = 0;
  let modelSlug: string | undefined;
  let traceId: string | undefined;
  let lastExcerpt: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(retryBackoffMs(attempt - 1, retryBaseMs));
    let res: ClaudeResponse;
    try {
      res = await invokeFn({
        task: "measurement.analysis.answer_brand_stance",
        // ← alias. 라이브 모델은 `lib/config/llm-task-models.ts` 의
        //   LIVE_TASK_MODELS 가 정본이다(env > 표 > 별칭). 통제 접두
        //   `measurement.analysis.` 라, 표에도 env 에도 없으면 관리 런타임에서
        //   **throw** 한다 — 2026-09-13 haiku 폴백 사고의 재발을 막는 가드.
        model: "haiku",
        temperature: 0,
        maxTokens: 4000,
        responseFormat: { type: "json_object" },
        // 파일럿 실측에서 추론 토큰이 출력의 대부분이었다(답변당 1,062) — 억제한다.
        reasoning: { max_tokens: 256, exclude: true },
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      });
    } catch (error) {
      attempts++;
      lastExcerpt = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) continue;
      return {
        decisions: [],
        parserPartial: true,
        malformedCount,
        warnings: [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        failed: true,
        errorMessage: lastExcerpt,
        lastResponseExcerpt: lastExcerpt,
      };
    }
    attempts++;
    costUsd += res.costUsd ?? 0;
    modelSlug = res.modelId;
    traceId = res.traceId;
    try {
      const envelope = AnswerBrandStanceEnvelopeSchema.parse(
        parseJsonObject(res.text),
      );
      const decisions: AnswerBrandStanceDecision[] = [];
      let dropped = 0;
      let coercedConfidence = 0;
      let droppedAspects = 0;
      for (const raw of envelope.stances) {
        const entry = AnswerBrandStanceEntrySchema.safeParse(raw);
        if (!entry.success) {
          dropped++;
          continue;
        }
        // `aspects` 는 엄격한 zod 스키마 밖에서 별도 처리한다(어휘가 자유
        // 문자열이라 위 스키마가 검증할 게 없다 — normalizeStanceAspects 주석).
        const rawAspects =
          raw != null && typeof raw === "object"
            ? (raw as Record<string, unknown>).aspects
            : undefined;
        const aspectResult = normalizeStanceAspects(rawAspects);
        droppedAspects += aspectResult.dropped;
        decisions.push({
          brand: entry.data.brand,
          stance: entry.data.stance,
          confidence: entry.data.confidence ?? null,
          evidence: entry.data.evidence ?? null,
          reasonKo: entry.data.reason_ko ?? null,
          aspects: aspectResult.aspects,
        });
        // 부속 필드가 접힌 것은 드롭이 아니라 **부분 손실**이다 — 재시도 판정에
        // 넣지 않고(재시도해도 같은 값이 온다) 계수만 한다.
        //
        // ⚠️ 모델이 **명시적으로 `null`** 을 보낸 것은 강등이 아니라 정상 응답이다.
        // 그것까지 세면 이 카운터가 "프롬프트가 안 먹는다" 신호로 쓸모없어진다.
        if (
          raw != null &&
          typeof raw === "object" &&
          stanceConfidenceWasCoerced((raw as Record<string, unknown>).confidence)
        ) {
          coercedConfidence++;
        }
      }
      // 하나도 못 건졌으면 파싱 성공으로 치지 않는다 — 남은 시도를 쓴다.
      if (decisions.length === 0) {
        malformedCount++;
        lastExcerpt = responseExcerpt(res.text);
        continue;
      }
      return {
        decisions,
        parserPartial: dropped > 0,
        malformedCount,
        droppedAspects,
        warnings: envelope.warnings ?? [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        droppedEntries: dropped,
        coercedConfidence,
        ...(dropped > 0 ? { lastResponseExcerpt: responseExcerpt(res.text) } : {}),
      };
    } catch {
      malformedCount++;
      lastExcerpt = responseExcerpt(res.text);
    }
  }

  return {
    decisions: [],
    parserPartial: true,
    malformedCount,
    warnings: [],
    lastResponseExcerpt: lastExcerpt,
    costUsd,
    attempts,
    modelSlug,
    traceId,
    // 시도를 전부 소진했다 = 이 턴의 스탠스는 없다. **턴 분석은 실패시키지
    // 않는다**(FR6) — 호출부가 이 값을 받아 멘션·감성은 그대로 persist 한다.
    failed: true,
    errorMessage: lastExcerpt,
  };
}

// System prompt for the pending-mention resolver. Industry-parameterized
// (change complete-project-industry-scoping): the automotive variant keeps the
// original hand-tuned HMG wording byte-identical ("a real car the catalog is
// missing"); a non-automotive named industry gets the same three-action
// contract phrased for that industry, so real competitor brands of the
// project's industry are no longer actively discarded as "not a car".
export function buildResolvePendingMentionsSystemPrompt(
  industryName?: string | null,
): string {
  const generic = industryName != null && !isAutomotiveIndustryName(industryName);
  return [
    "You classify and resolve pending brand/product mentions extracted from an AI assistant's answer to a consumer purchase-decision question, against an approved ontology catalog.",
    "Return JSON only. The approved catalog is the only identity authority. Never invent entity ids, entities, brands, aliases, or relationships.",
    "Goal: only a real consumer brand/model that the answer presents as a shortlist candidate or final choice should remain metric-impacting. Everything else must be resolved to the catalog or declassified.",
    ...(generic
      ? [
          `The project's industry is "${industryName}"; known_entities lists that industry's catalog.`,
          "resolve_existing: the surface refers to a catalog entity in known_entities — pick its id. Resolve editions/variants/capacity/year trims to their base catalog model, and a bare brand token to its catalog Brand. Match across the LLM-guessed entity_type — trust the catalog entity's own type, not the guessed one.",
          "ignore_non_metric: the surface is NOT a consumer brand/model choice and must NOT affect ACR or delivery readiness. Use it (even when the surface was guessed as a Brand/Product and looks metric-impacting) for: cited sources, review sites and publications (e.g. Reddit, YouTube, news sites), dealerships/retailers, parent companies/holding groups when not the chosen model, technology/feature/material/component names, and generic categories, descriptors, or sentence fragments.",
          `keep_pending: ONLY for a genuinely new, concrete consumer brand or model of the "${industryName}" industry that is absent from known_entities. When in doubt between keep_pending and ignore_non_metric for something that is clearly not a consumer brand/model of that industry, choose ignore_non_metric.`,
        ]
      : [
          "resolve_existing: the surface refers to a catalog entity in known_entities — pick its id. Resolve trims/variants/powertrain/year editions to their base catalog model (e.g. 'K5 하이브리드'→Kia K5, '투싼 AWD'→Hyundai Tucson, '신형 산타페'→Hyundai Santa Fe). Resolve a bare brand token to its catalog Brand (e.g. '현대'→Hyundai). Match across the LLM-guessed entity_type — trust the catalog entity's own type, not the guessed one.",
          "ignore_non_metric: the surface is NOT a consumer brand/model choice and must NOT affect ACR or delivery readiness. Use it (even when the surface was guessed as a Brand/Product and looks metric-impacting) for: cited sources, review sites and publications (e.g. Reddit, Car and Driver, Edmunds, MotorTrend, AP News, YouTube), dealerships/retailers (e.g. Doral Hyundai, Lithia Auto Stores), parent companies/holding groups (e.g. 현대차그룹, 현대기아) when not the chosen model, ADAS/feature/technology/powertrain/engine/transmission names (e.g. 현대 스마트센스, 스마트스트림 IVT), and generic categories, descriptors, or sentence fragments.",
          "keep_pending: ONLY for a genuinely new, concrete consumer brand or model that is absent from known_entities (a real car the catalog is missing). When in doubt between keep_pending and ignore_non_metric for something that is clearly not a car model/brand, choose ignore_non_metric.",
        ]),
    "Use the same industry implied by known_entities. Do not map across industries.",
    "A coordinated compound of multiple brand names joined by a separator (e.g. '삼성·LG', 'Samsung/LG', '삼성전자/LG전자') is NOT a new entity — never keep_pending it. The constituents are the real brands; such a joined surface must be ignore_non_metric.",
    // 표기 규약은 시스템 프롬프트에 (프롬프트 캐시 대상) — change
    // ontology-catalog-snapshot 4단계.
    CATALOG_BLOCK_LEGEND_WITH_IDS,
  ].join(" ");
}

export async function resolvePendingMentionsWithLlm(input: {
  promptText?: string | null;
  answerText: string;
  turnIndex: number;
  catalog: OntologyCatalogEntity[];
  pendingMentions: Array<{
    index: number;
    surfaceText: string;
    entityType?: MeasurementEntityType | null;
    canonicalGuess?: string | null;
    mentionRole?: MentionRole | null;
    assertion?: MentionAssertion | null;
    sentiment?: MentionSentiment | null;
    contextSnippet?: string | null;
    confidence?: number | null;
  }>;
  industryName?: string | null;
  /** 주입 필수 — 이 모듈은 transport 를 값으로 갖지 않는다(파일 머리 참고). */
  invokeFn: PendingMentionResolutionInvoker;
}): Promise<PendingMentionResolutionResult> {
  const invokeFn = input.invokeFn;
  const system = buildResolvePendingMentionsSystemPrompt(input.industryName);
  const answerText = input.answerText.slice(0, 20000);
  const pendingMentions = input.pendingMentions.slice(0, 80);
  // change ontology-catalog-snapshot 4단계. 리졸버는 답변 본문뿐 아니라
  // **pending 표면**도 관련도 신호다 — 해결해야 할 대상이 그것이므로, 그 표면과
  // 겹치는 카탈로그 엔티티가 예산에서 먼저 자리를 잡아야 한다.
  const projection = projectCatalogForPrompt(input.catalog, {
    answerText,
    extraSurfaces: pendingMentions.flatMap((m) =>
      [m.surfaceText, m.canonicalGuess ?? ""].filter(Boolean),
    ),
    tokenBudget: RESOLVE_CATALOG_TOKEN_BUDGET,
    maxAliasesPerEntity: RESOLVE_CATALOG_ALIAS_CAP,
    maxEntities: RESOLVE_CATALOG_ENTITY_CAP,
    includeIds: true,
  });
  log.info("measurement_analysis.resolve.catalog_projection", {
    catalog_size: input.catalog.length,
    pending_mentions: pendingMentions.length,
    projected_entities: projection.entityCount,
    projected_aliases: projection.aliasCount,
    estimated_tokens: projection.estimatedTokens,
    token_budget: RESOLVE_CATALOG_TOKEN_BUDGET,
    relevant_entities: projection.relevantCount,
    relevant_included: projection.relevantIncluded,
    relevant_truncated: projection.relevantCount - projection.relevantIncluded,
  });
  const payload = {
    turn_index: input.turnIndex,
    prompt_text: input.promptText ?? null,
    answer_text: answerText,
    pending_mentions: pendingMentions.map((mention) => ({
      index: mention.index,
      surface_text: mention.surfaceText,
      entity_type: mention.entityType ?? null,
      canonical_guess: mention.canonicalGuess ?? null,
      mention_role: mention.mentionRole ?? null,
      assertion: mention.assertion ?? null,
      sentiment: mention.sentiment ?? null,
      confidence: mention.confidence ?? null,
      context_snippet: mention.contextSnippet?.slice(0, 600) ?? null,
    })),
    known_entities: projection.text,
    required_schema: {
      decisions: [
        {
          index: "pending_mentions index",
          surface_text: "exact pending surface",
          action:
            "resolve_existing|keep_pending|ignore_non_metric",
          existing_entity_id:
            "known_entities id, only for resolve_existing",
          canonical_name:
            "known_entities canonical_name, only for resolve_existing",
          confidence: "0..1",
          reason: "short reason",
        },
      ],
      warnings: ["parser uncertainty notes"],
    },
  };

  let malformedCount = 0;
  let attempts = 0;
  let costUsd = 0;
  let modelSlug: string | undefined;
  let traceId: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: ClaudeResponse;
    try {
      res = await invokeFn({
        task: "measurement.analysis.resolve_pending_mentions",
        model: "sonnet",
        temperature: 0,
        maxTokens: 4000,
        responseFormat: { type: "json_object" },
        reasoning: { max_tokens: 512, exclude: true },
        system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      });
    } catch (error) {
      attempts++;
      return {
        decisions: [],
        parserPartial: true,
        malformedCount,
        warnings: [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
        failed: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    attempts++;
    costUsd += res.costUsd ?? 0;
    modelSlug = res.modelId;
    traceId = res.traceId;
    try {
      const parsed = PendingMentionResolutionSchema.parse(parseJsonObject(res.text));
      return {
        decisions: parsed.decisions.map((decision) => ({
          index: decision.index,
          surfaceText: decision.surface_text,
          action: decision.action,
          existingEntityId: decision.existing_entity_id,
          canonicalName: decision.canonical_name,
          confidence: decision.confidence,
          reason: decision.reason,
        })),
        parserPartial: false,
        malformedCount,
        warnings: parsed.warnings ?? [],
        costUsd,
        attempts,
        modelSlug,
        traceId,
      };
    } catch {
      malformedCount++;
    }
  }

  return {
    decisions: [],
    parserPartial: true,
    malformedCount,
    warnings: [],
    costUsd,
    attempts,
    modelSlug,
    traceId,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return parseJsonObject(withoutFence);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw error;
  }
}

export async function discoverUnknownCandidatesWithLlm(input: {
  answerText: string;
  knownSurfaces: string[];
  /** 주입 필수 — 이 모듈은 transport 를 값으로 갖지 않는다(파일 머리 참고). */
  invokeFn: UnknownDiscoveryInvoker;
}): Promise<UnknownDiscoveryResult> {
  const invokeFn = input.invokeFn;
  const system = [
    "You extract possible product or brand identity candidates from AI answers.",
    "Return JSON only.",
    "Do not merge identities. Do not claim a canonical id.",
    "Known surfaces are already handled; focus only on other clear brand/product surfaces.",
    // Verbatim hardening (2026-07-31 Luna A/B round 2): without this, luna
    // returned 12% non-substring surfaces; with it, both gemini-3.5-flash and
    // luna measured 100% verbatim-valid on the same 80 turns.
    "CRITICAL: every surface_text MUST be an exact, character-for-character substring of answer_text.",
    "Before returning, verify each candidate against answer_text and DROP any whose surface_text is not an exact substring.",
    "Never normalize, translate, or paraphrase a surface.",
  ].join(" ");
  const payload = {
    known_surfaces: input.knownSurfaces,
    answer_text: input.answerText.slice(0, 12000),
    required_schema: {
      candidates: [
        {
          surface_text: "string",
          entity_type: "Brand|Product",
          confidence: "0..1",
          evidence_snippet: "short source phrase",
        },
      ],
    },
  };

  let malformedCount = 0;
  let attempts = 0;
  let costUsd = 0;
  let modelSlug: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await invokeFn({
      task: "measurement.analysis.unknown_discovery",
      model: "haiku",
      temperature: 0,
      maxTokens: 1200,
      responseFormat: { type: "json_object" },
      reasoning: { max_tokens: 128, exclude: true },
      system,
      messages: [
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
    });
    attempts++;
    costUsd += res.costUsd ?? 0;
    modelSlug = res.modelId;
    try {
      const parsed = UnknownDiscoverySchema.parse(parseJsonObject(res.text));
      return {
        candidates: parsed.candidates.map((c) => ({
          candidateKind:
            c.entity_type === "Product" ? "create_product" : "create_brand",
          signature: [
            "llm_unknown",
            c.entity_type,
            normalizeSurface(c.surface_text),
          ].join("|"),
          surfaceText: c.surface_text,
          surfaceNormalized: normalizeSurface(c.surface_text),
          surfaceVariants: [c.surface_text],
          suggestedEntityType: c.entity_type,
          confidence: c.confidence,
          answerSnippets: c.evidence_snippet ? [c.evidence_snippet] : [],
          metricImpact: { source: "llm_unknown_discovery" },
        })),
        parserPartial: false,
        malformedCount,
        costUsd,
        attempts,
        modelSlug,
      };
    } catch {
      malformedCount++;
    }
  }

  return {
    candidates: [],
    parserPartial: true,
    malformedCount,
    costUsd,
    attempts,
    modelSlug,
  };
}
