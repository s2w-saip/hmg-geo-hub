import { z } from "zod";

export const ANALYSIS_VERSION = "measurement-analysis-v1";
export const PROMPT_VERSION = "prompt-v1";
export const PARSER_VERSION = "parser-v1";
export const RESOLVER_VERSION = "resolver-v1";
/**
 * 답변 단위 브랜드 스탠스 프롬프트 버전 (change add-answer-brand-stance).
 *
 * **`ANALYSIS_VERSION` 과 별개 축인 것이 요점이다.** 스탠스 프롬프트만 고칠 때
 * `analysisVersion` 을 올리면 `measurement_turn_analysis` 의 UNIQUE 키가 바뀌어
 * **전 코퍼스 재분석**이 트리거된다. 스탠스 축만 따로 센다(스펙 §3.1 RK10).
 *
 * `stance-v2`(2026-09-15, 테오 결정): 브랜드별 `aspects[]` 를 추가하며 프롬프트
 * 문구가 바뀌었다 — 어휘는 **고정하지 않는다**(모델이 답변에 나온 표현 그대로
 * 자유 문자열로 뽑고, 정규화는 v2 사후 처리로 미룬다).
 */
export const STANCE_PROMPT_VERSION = "stance-v2";

export const AnswerQualityStateSchema = z.enum([
  "valid_answer",
  "empty_answer",
  "trash_answer",
  "failed_answer",
  "refusal_or_non_answer",
]);
export type AnswerQualityState = z.infer<typeof AnswerQualityStateSchema>;

export const ResolutionStatusSchema = z.enum([
  "resolved",
  "pending",
  "conflict",
  "rejected",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const ResolutionMethodSchema = z.enum([
  "canonical_exact",
  "alias_exact",
  "relationship",
  "embedding_neighbor",
  "llm_proposal",
  "human_review",
]);
export type ResolutionMethod = z.infer<typeof ResolutionMethodSchema>;

export const ResolverAuthorityLevelSchema = z.enum([
  "canonical",
  "alias",
  "relationship",
  "embedding_neighbor",
  "llm_proposal",
  "human_review",
]);
export type ResolverAuthorityLevel = z.infer<
  typeof ResolverAuthorityLevelSchema
>;

export const RESOLVER_AUTHORITY_PRIORITY: Record<
  ResolverAuthorityLevel,
  number
> = {
  canonical: 1,
  alias: 2,
  relationship: 3,
  embedding_neighbor: 4,
  llm_proposal: 5,
  human_review: 6,
};

export function resolverAuthorityForMethod(
  method: ResolutionMethod,
): ResolverAuthorityLevel {
  switch (method) {
    case "canonical_exact":
      return "canonical";
    case "alias_exact":
      return "alias";
    case "relationship":
      return "relationship";
    case "embedding_neighbor":
      return "embedding_neighbor";
    case "llm_proposal":
      return "llm_proposal";
    case "human_review":
      return "human_review";
  }
}

export function resolverAuthorityPriority(method: ResolutionMethod): number {
  return RESOLVER_AUTHORITY_PRIORITY[resolverAuthorityForMethod(method)];
}

export const MentionAssertionSchema = z.enum([
  "recommend",
  "final_choice",
  "reject",
  "compare",
  "mention_only",
  "definition",
  "other",
]);
export type MentionAssertion = z.infer<typeof MentionAssertionSchema>;

export const MentionRoleSchema = z.enum([
  "shortlist_candidate",
  "single_choice",
  "comparison_target",
  "citation_reference",
  "background",
]);
export type MentionRole = z.infer<typeof MentionRoleSchema>;

export const MentionSentimentSchema = z.enum([
  "positive",
  "negative",
  "neutral",
  "mixed",
]);
export type MentionSentiment = z.infer<typeof MentionSentimentSchema>;

// Citation domain classification — fixed category set shared with the HMG BFF.
// `subcategory` is free-text (e.g. "Industry blog", "Mainstream news").
export const CitationCategorySchema = z.enum([
  "Auto media",
  "News",
  "Social",
  "Community",
  "Brand owned",
  "PR",
  "Government",
  "Other",
]);
export type CitationCategory = z.infer<typeof CitationCategorySchema>;

export type CitationClassificationMethod = "table" | "llm" | "default";

export interface CitationDomainClassification {
  host: string;
  category: CitationCategory;
  subcategory: string | null;
  method: CitationClassificationMethod;
  modelSlug?: string | null;
}

export const EntityTypeSchema = z.enum([
  "Brand",
  "Product",
  "ProductCategory",
  "Feature",
]);
export type MeasurementEntityType = z.infer<typeof EntityTypeSchema>;

export const CandidateKindSchema = z.enum([
  "add_alias",
  "create_product",
  "create_product_category",
  "create_brand",
  "create_feature",
  "link_product_brand",
  "link_brand_company",
  "reject_surface",
]);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

export const CandidateStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "suppressed",
  "closed",
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const CandidateClosureMethodSchema = z.enum([
  "project_seed_catalog",
  "authoritative_source",
  "deterministic_no_conflict",
  "human_approval",
]);
export type CandidateClosureMethod = z.infer<
  typeof CandidateClosureMethodSchema
>;

export const RollupLevelSchema = z.enum(["product", "brand", "company"]);
export type RollupLevel = z.infer<typeof RollupLevelSchema>;

export const ProjectRollupMethodSchema = z.enum([
  "ontology_default",
  "operator_override",
]);
export type ProjectRollupMethod = z.infer<typeof ProjectRollupMethodSchema>;

export const ChoiceOutcomeSchema = z.enum([
  "single_entity",
  "conditional_multiple",
  "generic_category",
  "resolved_off_shortlist",
  "unresolved_choice",
  "none",
]);
export type ChoiceOutcome = z.infer<typeof ChoiceOutcomeSchema>;

export const FollowUpModeSchema = z.enum([
  "natural_consumer",
  "strict_calibration",
  "custom",
]);
export type FollowUpMode = z.infer<typeof FollowUpModeSchema>;

export const DeliveryStatusSchema = z.enum([
  "analysis_ready",
  "blocked_closure_required",
  "not_applicable",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const OntologyCatalogEntitySchema = z.object({
  id: z.guid(),
  type: EntityTypeSchema,
  canonicalName: z.string().min(1),
  aliases: z
    .array(
      z.object({
        alias: z.string().min(1),
        language: z.string().optional(),
      }),
    )
    .default([]),
});
export type OntologyCatalogEntity = z.infer<
  typeof OntologyCatalogEntitySchema
>;

export const AnalysisOptionsSchema = z.object({
  analysisVersion: z.string().min(1).default(ANALYSIS_VERSION),
  promptVersion: z.string().min(1).default(PROMPT_VERSION),
  parserVersion: z.string().min(1).default(PARSER_VERSION),
  resolverVersion: z.string().min(1).default(RESOLVER_VERSION),
  enableLlmMentionExtraction: z.boolean().default(false),
  enableLlmPendingResolver: z.boolean().default(false),
  enableLlmUnknownDiscovery: z.boolean().default(false),
  // Dedicated post-extraction LLM pass that scores each mention's sentiment +
  // type per clause (NOT the verbatim extraction call). Off → mechanical
  // line-scoped fallback in core.inferMentionSemantics.
  enableLlmMentionSemantics: z.boolean().default(false),
  // 감성 판별 V2 (change mention-semantics-v2). semantics 패스를 대체하는 줄 기반
  // 판별: Brand·Product 멘션만, 오프셋으로 파생한 줄을 근거로 채점하고
  // evidence·reason·source 를 함께 남긴다. `enableLlmMentionSemantics` 가 켜져 있고
  // 프로젝트가 env allowlist 에 있을 때만 true 가 된다(`resolveAnalysisOptions`).
  enableLlmMentionSemanticsV2: z.boolean().default(false),
  // Require the context-reading extraction LLM to corroborate a short,
  // single-token, digit-free deterministic match (any script: is/air/GM/현대/
  // 기아) before keeping it — kills common-word collisions (e.g. "is"→Lexus IS)
  // language-agnostically without a per-language stopword list. Off → keep all
  // deterministic matches (legacy).
  enableShortAliasLlmGate: z.boolean().default(false),
  // Deterministic tracked-brand presence capture after extraction/resolution
  // (change capture-tracked-brand-factual-mentions). Default ON — this is a
  // correctness floor, not an experimental LLM pass. env kill-switch:
  // MEASUREMENT_ANALYSIS_TRACKED_AUGMENT_ENABLED="false".
  enableTrackedBrandAugment: z.boolean().default(true),
  // 답변 **전문**을 읽어 (턴 × 브랜드) 단위 태도를 매기는 4번째 LLM 패스
  // (change add-answer-brand-stance). 발생 단위 감성(`enableLlmMentionSemantics`)
  // 과 **다른 축**이며 서로를 덮지 않는다 — semantics 는 절(clause) 안에서만
  // 채점하므로 대명사·"厂方"·"이 업데이트" 로 이어지는 비판이 어느 멘션에도
  // 붙지 않는다. 기본 off(opt-in), env `MEASUREMENT_ANALYSIS_STANCE_ENABLED`.
  enableLlmAnswerBrandStance: z.boolean().default(false),
  followUpMode: FollowUpModeSchema.default("natural_consumer"),
});
export type AnalysisOptions = z.infer<typeof AnalysisOptionsSchema>;

export const AnalysisRequestOptionSchema = z.union([
  z.boolean(),
  z.object({ enabled: z.boolean() }),
]);
export type AnalysisRequestOption = z.infer<typeof AnalysisRequestOptionSchema>;

export function parseAnalysisEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  const parsed = AnalysisRequestOptionSchema.safeParse(value);
  if (parsed.success && typeof parsed.data === "object") {
    return parsed.data.enabled;
  }
  return true;
}

export interface AnswerQualityResult {
  qualityState: AnswerQualityState;
  reason: string;
  answerChars: number;
}

export interface MeasurementMention {
  entityId: string | null;
  entityType: MeasurementEntityType | null;
  surfaceText: string;
  surfaceLanguage?: string;
  surfaceNormalized: string;
  surfaceHash: string;
  sourceStart?: number;
  sourceEnd?: number;
  resolutionStatus: ResolutionStatus;
  resolutionMethod: ResolutionMethod;
  resolutionConfidence: number;
  mentionPosition: number;
  mentionRole: MentionRole;
  assertion: MentionAssertion;
  sentiment: MentionSentiment;
  rank?: number;
  rankGroup?: string;
  contextSnippet: string;
  descriptors: string[];
  criteria: string[];
  extractionMetadata: Record<string, unknown>;
}

export interface MeasurementCandidate {
  candidateKind: CandidateKind;
  signature: string;
  surfaceText: string;
  surfaceNormalized: string;
  surfaceVariants: string[];
  suggestedEntityType?: MeasurementEntityType;
  suggestedEntityId?: string;
  suggestedRelationshipType?: string;
  suggestedTargetEntityId?: string;
  confidence?: number;
  conflictReason?: string;
  answerSnippets: string[];
  metricImpact: Record<string, unknown>;
}

export interface MeasurementTurnAnalysisResult {
  quality: AnswerQualityResult;
  mentions: MeasurementMention[];
  candidates: MeasurementCandidate[];
  analysisVersion: string;
  promptVersion: string;
  parserVersion: string;
  resolverVersion: string;
  modelSlug?: string;
  sourceTurnHash: string;
  extractionMetadata: Record<string, unknown>;
}

export interface AcrEntityRollup {
  rollupLevel: RollupLevel;
  entityId: string;
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  appearanceCount: number;
  choiceCount: number;
  conditionalChoiceCount: number;
  appearanceRate: number | null;
  acr: number | null;
  overallChoiceShare: number | null;
  offShortlistChoiceCount: number;
  unresolvedChoiceCount: number;
  genericChoiceCount: number;
  qualityBreakdown: Record<AnswerQualityState, number>;
  choiceOutcomeBreakdown: Record<ChoiceOutcome, number>;
  inputMentionIds: string[];
  deliveryStatus: DeliveryStatus;
  customerFacingChoiceBehaviorReady: boolean;
  unresolvedMetricImpactCount: number;
}

// 추이 버킷의 표시 타임존 (change trend-measured-at-kst).
//
// 버킷을 UTC 달력일로 자르면 한국 측정일 하루가 두 점으로 갈린다(KR 03:45 KST 실행이
// 전날 UTC 로 떨어진다). 고객은 그것을 측정 2회로 읽는다. 추이는 KR 고객에게
// 보고되므로 Asia/Seoul 로 자른다.
//
// 여기(스키마 상수)에 두는 이유: 집계 모듈과 큐브 계산기가 **같은 기준**을 써야
// 하는데, 집계 모듈에 두면 store → cube → dashboard-aggregates → store 순환이 된다.
export const TREND_TZ = "Asia/Seoul";

// ─── 답변 단위 브랜드 스탠스 (change add-answer-brand-stance) ─────────────────
//
// 단위가 **(턴 × 브랜드 롤업 엔티티)** 다. 발생 단위 멘션과 카디널리티가 다르므로
// `measurement_entity_mentions` 에 컬럼으로 얹지 않고 별 테이블
// (`measurement_answer_brand_stances`)에 영속한다 — 같은 브랜드의 멘션 5건에 같은
// 스탠스가 5번 복제되면 `sum(sentiment_n)` 류 발생 단위 집계가 조용히 오염된다
// (스펙 §0 R3).
//
// 어휘는 발생 단위 감성과 **같은 4값**을 재사용한다(FR2) — 도구·알람·i18n 키가
// 같은 문자열을 공유하는 값이 크다. 복사하지 않고 `MentionSentimentSchema` 를
// 그대로 쓴다.
//
// ─── 속성 스탠스 aspects[] (테오 결정 2026-09-15) ──────────────────────────
//
// **어휘를 고정하지 않는다.** "연비"·"디자인"·"내구성" 같은 카탈로그를 미리
// 만들지 않고, 모델이 답변에 실제로 나온 표현을 **원문 언어 그대로** 짧은 자유
// 문자열로 뽑는다. 정규화(같은 뜻의 다른 표현을 한 축으로 묶는 것)는 v2 사후
// 처리로 미룬다 — 지금 고정하면 어휘가 못 담는 속성은 통째로 사라지고, 그 결손은
// 나중에 되돌릴 수 없다(카탈로그를 넓혀도 이미 지나간 답변은 재분석 전엔 그대로).
//
// 키를 **snake_case** 로 두는 이유: 이 배열은 관계형 컬럼이 아니라 jsonb 블롭
// 하나에 통째로 들어간다(`db/schema.ts` 의 `aspects` 컬럼). 이 코드베이스의
// 관례상 jsonb 블롭 내부 키는 snake_case 다(`extractionMetadata` 의
// `stance_prompt_version`·`evidence_match` 등과 같은 자리).
export const AnswerBrandStanceAspectSchema = z.object({
  /** 자유 문자열, 원문 언어 그대로. 길이 상한 80자(프롬프트 절단과 같은 값). */
  aspect: z.string().min(1).max(80),
  stance: MentionSentimentSchema,
  /** 답변 원문 인용. 오프셋 검증에 실패해도 **보존**한다(FR4 규율 재사용). */
  evidence_text: z.string().nullable(),
  /** 코드포인트 오프셋. 0회·2회 이상 매치면 **둘 다 null**(브랜드 evidence 와
   *  같은 `verifyEvidence` 규칙). */
  evidence_start: z.number().int().min(0).nullable(),
  evidence_end: z.number().int().min(0).nullable(),
  evidence_verified: z.boolean(),
});
export type AnswerBrandStanceAspect = z.infer<
  typeof AnswerBrandStanceAspectSchema
>;
/** 브랜드 항목당 상한 — 파일럿 급 프롬프트 폭주를 막는다. */
export const STANCE_ASPECT_CAP = 8;
export const STANCE_ASPECT_LABEL_CAP = 80;

export const AnswerBrandStanceSchema = z.object({
  /** 채점 대상 = 브랜드 **롤업** 엔티티 id (멘션 entity 가 아니다). */
  entityId: z.guid(),
  /** 프롬프트에 실제로 넘긴 이름 — 모델이 돌려준 문자열 키를 되짚는 축. */
  brandLabel: z.string().min(1),
  /** 이 브랜드가 프로젝트 tracked 대상인가 (KPI 분모 판정용 비정규화). */
  isTracked: z.boolean(),
  stance: MentionSentimentSchema,
  confidence: z.number().min(0).max(1).nullable(),
  /** 답변 원문 인용. 오프셋 검증에 실패해도 **보존**한다(FR4). */
  evidenceText: z.string().nullable(),
  /**
   * 코드포인트 오프셋 [start, end). 원문에서 정확히 1회 찾히지 않으면 **둘 다
   * null** 이고 `extractionMetadata.evidence_verified=false` 가 남는다 — 지어내지
   * 않는다(FR4).
   */
  evidenceStart: z.number().int().min(0).nullable(),
  evidenceEnd: z.number().int().min(0).nullable(),
  /** 한국어 1문장. */
  reason: z.string().nullable(),
  /** 그 스탠스를 만든 모델 slug (FR3). 영속 컬럼 `model_slug` 의 정본. */
  modelSlug: z.string().nullable(),
  extractionMetadata: z.record(z.string(), z.unknown()),
  /** 브랜드별 속성 스탠스 — 0~8개, 없으면 빈 배열(테오 결정 2026-09-15). */
  aspects: z.array(AnswerBrandStanceAspectSchema).max(STANCE_ASPECT_CAP).default([]),
});
export type AnswerBrandStance = z.infer<typeof AnswerBrandStanceSchema>;
