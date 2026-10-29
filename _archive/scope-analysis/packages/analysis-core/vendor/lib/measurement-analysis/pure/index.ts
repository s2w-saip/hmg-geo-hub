// 순수 분석 계층의 공개 표면.
//
// ⚠️ 이 디렉토리는 `lib/measurement-analysis/index.ts` 배럴에 **넣지 않는다** —
// 그 배럴은 `export * from "./store"` 라서, 배럴을 거치면 DB 의존 store.ts 가
// 통째로 의존 그래프에 들어온다(플랜 §5 R-8). 소비자는 이 경로를 직접 import 한다.
export { analyzeTurnPure } from "./analyze-turn";
export type {
  AnalysisCallUsage,
  AnalysisTurnContext,
  AnalysisTurnInput,
  AnalysisTurnInputWithHash,
  AnalysisTurnInputWithRaw,
  AnalysisTurnUsage,
  TurnAnalysisForPersist,
  TurnAnalysisPayload,
} from "./analyze-turn";
export type {
  AnalysisLlmDeps,
  AnalysisLogger,
  AnalysisPureDeps,
  AnswerBrandStanceInput,
  MentionExtractionInput,
  MentionSemanticsInput,
  MentionSemanticsV2Input,
  PendingMentionResolutionInput,
} from "./deps";
// 답변 단위 브랜드 스탠스의 순수 부품 (change add-answer-brand-stance).
// ⚠️ lane 벤더 매니페스트(`packages/analysis-core/vendor-manifest.ts`)에
// `pure/stance-targets.ts` 를 등재해야 lane 이 같은 바이트를 쓴다(WU6).
export {
  buildStanceTargets,
  matchAndVerifyStances,
  STANCE_TARGET_CAP,
} from "./stance-targets";
export type {
  EvidenceMatch,
  StanceMatchResult,
  StanceTarget,
  StanceTargetSet,
} from "./stance-targets";
export {
  buildLlmMentionLayerForTest,
  buildMentionsFromLlmExtraction,
  deterministicSurfaceNeedsCorroboration,
} from "./llm-mention-layer";
export type { LlmMentionLayerTurnInput } from "./llm-mention-layer";
export {
  resolvePendingMentionLayerForTest,
  resolvePendingMentionLayerWithLlm,
} from "./resolver-layer";
export {
  filterExcludedContextCandidates,
  filterExcludedContextMentions,
  filterSupersededDeterministicFinalChoiceCandidates,
  normalizeMentionOrder,
} from "./filters";
export {
  candidateKindForEntityType,
  isAcrAppearanceEvidence,
  isAcrMetricImpactMention,
  isGenericFeatureLikeProductSurface,
  isLlmResolverEligibleMention,
  // 후보 signature 산식의 **유일한 사본** (change candidate-append-only, A16ⓒⓓ).
  // store.ts 가 이것을 재수출한다 — 백필·테스트의 import 경로를 지키기 위해서다.
  llmMentionCandidateSignature,
} from "./mention-classify";
// 아래 넷은 store.ts 의 unknown-discovery 잔류 헬퍼가 계속 쓴다
// (`isConcreteMetricUnknownCandidate`·`resolveUnknownCandidateAgainstCatalog`).
export {
  isEnglishDescriptorSurface,
  isGenericCategoryOnlySurface,
  isKoreanGrammarFragmentSurface,
} from "./llm-mention-layer";
export { resolveLlmMentionIdentity } from "./surface-identity";
export { resolveRollups } from "./rollups";
export type { RelationshipRow, RollupIds } from "./rollups";
