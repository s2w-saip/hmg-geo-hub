// 턴 분석의 순수 본체 — `store.ts` analyzeQueryRun 의 턴 루프 `:587~:952` 를
// 그대로 옮긴 것이다(origin/main 5a2b1ab7 기준).
//
// **동작 무변경이 이 파일의 유일한 계약이다.** 본문은 아래 셋을 빼면 바이트 동일하다:
//   1. 전체 4칸 dedent (`for` + `try` 두 겹이 사라졌다)
//   2. LLM 주입 seam 3곳 — 현행 `opts.X ?? <llm.ts 기본값>` 의 **우변(기본값)** 이
//      코어 어댑터로 올라갔다. 각 지점에 `[seam n/3]` 주석으로 현행 표기를 적어 뒀다.
//   3. 끝의 usage 조립 + `return`
// 대조 명령은 PR 본문 "동작 무변경 증명" 절에 있다.
//
// `:953` 부터(집계·롤업·persist)는 코어에 그대로 남는다 — 그래서 "persist 직전
// 객체가 같다"가 이 리팩터의 유일한 동치 조건이 된다(플랜 §4).
import { analyzeMeasurementTurn } from "../core";
import type { IndustryScopeContext } from "../industry-context";
import type {
  AnswerBrandStanceResult,
  MentionSemanticsResult,
  MentionSemanticsV2Result,
} from "../llm";
import { finalizeMentionOffsets } from "../offsets";
import { STANCE_PROMPT_VERSION } from "../schema";
import type {
  AnalysisOptions,
  AnswerBrandStance,
  OntologyCatalogEntity,
} from "../schema";
import {
  augmentTrackedBrandMentions,
  type TrackedBrandAugmentTarget,
} from "../tracked-brand-augment";
import type { GroupingIndex } from "@/lib/brand-grouping/types";
import type { AnalysisPureDeps } from "./deps";
import {
  filterExcludedContextCandidates,
  filterExcludedContextMentions,
  filterSupersededDeterministicFinalChoiceCandidates,
  normalizeMentionOrder,
} from "./filters";
import { buildMentionsFromLlmExtraction } from "./llm-mention-layer";
import { resolvePendingMentionLayerWithLlm } from "./resolver-layer";
import { resolveRollups, type RelationshipRow } from "./rollups";
import {
  buildStanceTargets,
  matchAndVerifyStances,
  type StanceTargetSet,
} from "./stance-targets";

/** 턴 하나. 필드명은 분석 lane 티켓 계약(`turns[]`)과 같다. */
interface AnalysisTurnInputBase {
  turnRunId: string;
  turnIndex: number;
  /** ← `QueryTurnRow.turnPromptText` (**턴** 단위). 쿼리 단위 `promptText` 와 다르다. */
  promptText: string;
  /** ← `QueryTurnRow.turnAnswerText` */
  answerText: string | null;
  /** 로그 상관용에만 쓰인다 — 산출물에 들어가지 않는다(플랜 §2.5 D-5). */
  trace: {
    queryRunId: string;
    promptRunId: string | null;
    target: string;
    region: string | null;
  };
}

/**
 * (a) 코어 인라인 경로 — `rawResponse` 를 받아 `core.ts:62` 가 `sourceTurnHash` 를
 * 계산한다. 현행과 동일하며 동치성 스냅샷 12개가 전부 이 경로를 탄다.
 */
export interface AnalysisTurnInputWithRaw extends AnalysisTurnInputBase {
  rawResponse: string | null;
  sourceTurnHash?: never;
}

/**
 * (b) lane 경로 — 티켓 `turns[]` 에는 `rawResponse` 가 실리지 않는다
 * (lane 스펙 §4.3). 그런데 `sourceTurnHash` 는
 * `turnHash({promptText, answerText, rawResponse})` 산출이라 lane 이 **계산할 수
 * 없다.** 계약은: 코어가 계산해 요청에 싣고 → lane 이 그대로 에코하고
 * (lane 스펙 §4.4 `result.turns[]`) → 코어가 persist 직전 자체 계산값과 대조한다.
 * 불일치는 재발행이 아니라 `output_contract` 즉시 종결이다.
 */
export interface AnalysisTurnInputWithHash extends AnalysisTurnInputBase {
  rawResponse?: never;
  sourceTurnHash: string;
}

export type AnalysisTurnInput =
  | AnalysisTurnInputWithRaw
  | AnalysisTurnInputWithHash;

/** query_run 안 모든 턴이 공유하는 컨텍스트. 호출부가 한 번만 만든다. */
export interface AnalysisTurnContext {
  catalog: OntologyCatalogEntity[];
  rels: RelationshipRow[];
  grouping: GroupingIndex;
  trackedAugmentTargets: TrackedBrandAugmentTarget[];
  industry: IndustryScopeContext;
  /** `resolveAnalysisOptions` 산출물 — env 게이트는 코어가 확정한다. */
  options: AnalysisOptions;
}

/**
 * LLM 콜 1회 = 1행. 현행은 이 값들이
 * `extractionMetadata.analysis_llm_{calls,cost_usd}` 안에 **합산돼 뭉개진다** —
 * 그 합산 필드는 동치성 때문에 그대로 두고(플랜 §2.2), 콜 단위 원본을 여기로
 * 승격한다. **이 PR 에서 코어는 이 필드를 읽지 않는다**(동작 무변경).
 */
export interface AnalysisCallUsage {
  task:
    | "measurement.analysis.extract_mentions"
    | "measurement.analysis.resolve_pending_mentions"
    | "measurement.analysis.mention_semantics"
    | "measurement.analysis.answer_brand_stance";
  modelSlug: string | null;
  attempts: number;
  costUsd: number;
  traceId: string | null;
  failed: boolean;
}

export type AnalysisTurnUsage = AnalysisCallUsage[];

/**
 * (a)/(b) 배타 유니온의 **런타임** 집행.
 *
 * 타입은 컴파일 시점에만 산다. lane 이 붙으면 이 함수의 입력은 티켓 JSON 을
 * 역직렬화한 객체이고, 그 시점에 `rawResponse?: never` 는 아무것도 막지 못한다.
 * 두 형태가 다 뭉개진 입력이 오면 조용히 틀린 값이 persist 된다:
 *   - 둘 다 있음 → (b) 가 에코해야 할 해시를 (a) 의 자체 계산이 덮는다.
 *   - 둘 다 없음 → `rawResponse: null` 로 계산한 해시가 진짜 해시인 척 저장된다.
 * 둘 다 예외가 아니라 **무음 오염**이라 진입에서 끊는다.
 *
 * 코어 인라인 경로는 `toAnalysisTurnInput`(store.ts) 하나뿐이고 항상 (a) 다
 * (`rawResponse` 를 언제나 싣는다 — `null` 이어도 **키는 있다**). 그래서 이
 * 가드는 코어에서 발화하지 않는다 = 동작 무변경.
 */
function assertExclusiveTurnInput(input: AnalysisTurnInput): void {
  // `null` 은 (a) 의 정상값이다 — 존재 여부로 판정한다(진리값 금지).
  const hasRaw = "rawResponse" in input && input.rawResponse !== undefined;
  const hasHash = input.sourceTurnHash !== undefined;
  if (hasRaw === hasHash) {
    throw new Error(
      "[measurement-analysis] analyzeTurnPure: rawResponse 와 sourceTurnHash 는 " +
        `정확히 하나여야 한다 (rawResponse=${hasRaw ? "있음" : "없음"}, ` +
        `sourceTurnHash=${hasHash ? "있음" : "없음"}; turn_run_id=${input.turnRunId}, ` +
        `turn_index=${input.turnIndex})`,
    );
  }
}

export async function analyzeTurnPure(
  input: AnalysisTurnInput,
  context: AnalysisTurnContext,
  deps: AnalysisPureDeps,
) {
  assertExclusiveTurnInput(input);
  // ── 어댑터 ────────────────────────────────────────────────────────────────
  // 아래 본문이 쓰던 이름을 그대로 만든다. 본문을 한 글자도 고치지 않기 위한
  // 바인딩이며, 로거는 래핑하지 않고 그대로 넘긴다(플랜 §5 R-4).
  const { catalog, rels, grouping, trackedAugmentTargets, industry, options } =
    context;
  const log = deps.log;
  const turn = {
    turnPromptText: input.promptText,
    turnAnswerText: input.answerText,
    // (b) lane 경로에는 rawResponse 가 없다 → `null`. 그 경우 core 가 계산한
    // 해시는 아래에서 에코값으로 덮이므로 버려진다. (a) 경로는 값 그대로다.
    rawResponse: input.rawResponse ?? null,
    turnIndex: input.turnIndex,
    turnRunId: input.turnRunId,
    queryRunId: input.trace.queryRunId,
    promptRunId: input.trace.promptRunId,
    target: input.trace.target,
    region: input.trace.region,
  };
  // ── 여기부터 store.ts:587~952 무수정 이동 ─────────────────────────────────
  const analysis = analyzeMeasurementTurn({
    promptText: turn.turnPromptText,
    answerText: turn.turnAnswerText,
    rawResponse: turn.rawResponse,
    turnIndex: turn.turnIndex,
    catalog,
    options,
  });
  log.info("measurement_analysis.turn.quality", {
    query_run_id: turn.queryRunId,
    turn_run_id: turn.turnRunId,
    prompt_run_id: turn.promptRunId,
    turn_index: turn.turnIndex,
    quality_state: analysis.quality.qualityState,
    answer_chars: analysis.quality.answerChars,
    reason: analysis.quality.reason,
    analysis_version: analysis.analysisVersion,
  });
  if (
    options.enableLlmMentionExtraction &&
    analysis.quality.qualityState === "valid_answer"
  ) {
    log.info("measurement_analysis.extract.llm_start", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      answer_chars: (turn.turnAnswerText ?? "").length,
      catalog_size: catalog.length,
      task: "measurement.analysis.extract_mentions",
    });
  }
  const llmMentionExtraction =
    options.enableLlmMentionExtraction &&
    analysis.quality.qualityState === "valid_answer"
          // [seam 1/3] 현행: `? await (opts.mentionExtraction ?? extractMentionsWithLlm)({`
      ? await deps.llm.extract({
          promptText: turn.turnPromptText,
          answerText: turn.turnAnswerText ?? "",
          turnIndex: turn.turnIndex,
          catalog,
          industryName: industry.name,
        })
      : null;
  let llmMentionLayer = llmMentionExtraction
    ? buildMentionsFromLlmExtraction({
        extraction: llmMentionExtraction,
        analysis,
        turn,
        catalog,
        gateShortDeterministic: options.enableShortAliasLlmGate,
      })
    : { mentions: analysis.mentions, candidates: [] };
  const llmPendingResolution =
    options.enableLlmPendingResolver &&
    llmMentionExtraction &&
    analysis.quality.qualityState === "valid_answer"
      ? await resolvePendingMentionLayerWithLlm({
          layer: llmMentionLayer,
          turn,
          catalog,
          promptText: turn.turnPromptText,
          industryName: industry.name,
              // [seam 2/3] 현행: `opts.mentionResolver ?? resolvePendingMentionsWithLlm`
          resolver: deps.llm.resolve,
        })
      : null;
  if (llmPendingResolution) {
    llmMentionLayer = llmPendingResolution.layer;
    if (llmPendingResolution.result.failed) {
      log.warn("measurement_analysis.resolve.llm_failed", {
        query_run_id: turn.queryRunId,
        turn_run_id: turn.turnRunId,
        prompt_run_id: turn.promptRunId,
        target: turn.target,
        region: turn.region,
        attempts: llmPendingResolution.result.attempts ?? 0,
        model_slug: llmPendingResolution.result.modelSlug,
        error_message: llmPendingResolution.result.errorMessage,
        pending_mentions: llmPendingResolution.pendingCount,
      });
    }
    log.info("measurement_analysis.resolve.llm_done", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      pending_mentions: llmPendingResolution.pendingCount,
      resolved_mentions: llmPendingResolution.resolvedCount,
      ignored_mentions: llmPendingResolution.ignoredCount,
      kept_pending_mentions: llmPendingResolution.keptPendingCount,
      parser_partial: llmPendingResolution.result.parserPartial,
      malformed_count: llmPendingResolution.result.malformedCount,
      attempts: llmPendingResolution.result.attempts ?? 0,
      model_slug: llmPendingResolution.result.modelSlug,
      cost_usd: llmPendingResolution.result.costUsd ?? 0,
      failed: llmPendingResolution.result.failed ?? false,
    });
  }
  if (options.enableLlmMentionExtraction) {
    const pendingCount = llmMentionLayer.mentions.filter(
      (mention) => mention.resolutionStatus === "pending",
    ).length;
    if (llmMentionExtraction?.failed) {
      log.warn("measurement_analysis.extract.llm_failed", {
        query_run_id: turn.queryRunId,
        turn_run_id: turn.turnRunId,
        prompt_run_id: turn.promptRunId,
        target: turn.target,
        region: turn.region,
        attempts: llmMentionExtraction.attempts ?? 0,
        model_slug: llmMentionExtraction.modelSlug,
        error_message: llmMentionExtraction.errorMessage,
        deterministic_mentions: analysis.mentions.length,
      });
    }
    log.info("measurement_analysis.extract.llm_done", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      answer_chars: (turn.turnAnswerText ?? "").length,
      mentions: llmMentionExtraction?.mentions.length ?? 0,
      pending_mentions: pendingCount,
      candidate_count: llmMentionLayer.candidates.length,
      generic_final_choice: Boolean(llmMentionExtraction?.genericFinalChoice),
      parser_partial: llmMentionExtraction?.parserPartial ?? false,
      malformed_count: llmMentionExtraction?.malformedCount ?? 0,
      attempts: llmMentionExtraction?.attempts ?? 0,
      model_slug: llmMentionExtraction?.modelSlug,
      cost_usd: llmMentionExtraction?.costUsd ?? 0,
      failed: llmMentionExtraction?.failed ?? false,
      error_message: llmMentionExtraction?.errorMessage,
    });
  }
  // No separate unknown-discovery pass: the verbatim extraction layer is
  // the single source of brand/model surfaces, the resolver maps the
  // unmatched bilingual/bare-model/variant ones, and whatever is still
  // pending after that is a genuine new-entity candidate (not a discovery
  // gap). See resolveAnalysisOptions — unknown discovery is disabled while
  // LLM extraction is on.
  const rawMentions = llmMentionLayer.mentions;
  const mentionsAfterExclusionFilter =
    filterExcludedContextMentions(rawMentions);
  const rawCandidates = [
    ...analysis.candidates,
    ...llmMentionLayer.candidates,
  ];
  const candidatesAfterSupersededFilter =
    filterSupersededDeterministicFinalChoiceCandidates(
      rawCandidates,
      mentionsAfterExclusionFilter,
    );
  const candidatesAfterExclusionFilter =
    filterExcludedContextCandidates(candidatesAfterSupersededFilter);
  if (
    mentionsAfterExclusionFilter.length !== rawMentions.length ||
    candidatesAfterExclusionFilter.length !== rawCandidates.length
  ) {
    log.info("measurement_analysis.extract.excluded_context_filtered", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      mentions_removed:
        rawMentions.length - mentionsAfterExclusionFilter.length,
      candidates_removed:
        rawCandidates.length - candidatesAfterExclusionFilter.length,
    });
  }
  // Deterministic tracked-brand presence capture (change
  // capture-tracked-brand-factual-mentions). Runs AFTER extraction /
  // resolution / exclusion so it is the floor: if a tracked brand's surface
  // is in the answer but nothing in the turn rolls up to it, add one
  // conservative mention resolved to a tracked entity. coveredEntityIds is
  // the existing mentions' identities AND rollups, so a brand already
  // captured (e.g. a Product that rolls up to it) is never duplicated. Only
  // for valid answers; tracked-only; non-destructive.
  let mentionsAfterAugment = mentionsAfterExclusionFilter;
  let trackedAugmentCount = 0;
  if (
    options.enableTrackedBrandAugment &&
    analysis.quality.qualityState === "valid_answer" &&
    trackedAugmentTargets.length > 0
  ) {
    const coveredEntityIds = new Set<string>();
    for (const existing of mentionsAfterExclusionFilter) {
      if (existing.entityId) coveredEntityIds.add(existing.entityId);
      const rl = resolveRollups(existing, rels, grouping);
      if (rl.brandRollupEntityId) coveredEntityIds.add(rl.brandRollupEntityId);
      if (rl.productRollupEntityId)
        coveredEntityIds.add(rl.productRollupEntityId);
      if (rl.companyRollupEntityId)
        coveredEntityIds.add(rl.companyRollupEntityId);
    }
    const augment = augmentTrackedBrandMentions({
      mentions: mentionsAfterExclusionFilter,
      answerText: turn.turnAnswerText ?? "",
      turnIndex: turn.turnIndex,
      targets: trackedAugmentTargets,
      coveredEntityIds,
    });
    mentionsAfterAugment = augment.mentions;
    trackedAugmentCount = augment.augmentedCount;
    if (augment.augmentedCount > 0) {
      log.info("measurement_analysis.extract.tracked_augment", {
        query_run_id: turn.queryRunId,
        turn_run_id: turn.turnRunId,
        prompt_run_id: turn.promptRunId,
        target: turn.target,
        region: turn.region,
        augmented: augment.augmentedCount,
        brand_keys: augment.augmentedBrandKeys,
      });
    }
  }
  // Per-mention sentiment + type via the dedicated LLM pass. Runs on the
  // post-filter set so the call is not spent on excluded surfaces.
  // OVERWRITES sentiment only (sentiment is not referenced by ACR /
  // delivery — those key off mention_role + assertion). The LLM mention_type
  // is stashed in extraction_metadata.llm_mention_type for display; it does
  // NOT overwrite the load-bearing `assertion`. Disable / failure → keep the
  // mechanical line-scoped values.
  let mentionsWithSemantics = mentionsAfterAugment;
  let semanticsResult: MentionSemanticsResult | null = null;
  // 감성 판별 V2 (change mention-semantics-v2). 옵션이 켜지고 seam 이 주입됐을 때만
  // 현행 semantics 패스를 **대체**한다. 옵션 off 면 이 변수는 false 이고 아래 현행
  // 블록의 조건이 이전과 같아 산출 바이트가 그대로다.
  const useSemanticsV2 =
    options.enableLlmMentionSemantics &&
    options.enableLlmMentionSemanticsV2 === true &&
    deps.llm.semanticsV2 !== undefined;
  if (
    options.enableLlmMentionSemantics &&
    options.enableLlmMentionSemanticsV2 === true &&
    deps.llm.semanticsV2 === undefined
  ) {
    // 무음 실패 금지: 게이트는 켰는데 배선이 없으면 현행 경로로 돌되 흔적을 남긴다.
    log.warn("measurement_analysis.semantics_v2.seam_missing", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
    });
  }
  if (
    !useSemanticsV2 &&
    options.enableLlmMentionSemantics &&
    analysis.quality.qualityState === "valid_answer" &&
    mentionsAfterAugment.length > 0
  ) {
    log.info("measurement_analysis.semantics.llm_start", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      mentions: mentionsAfterAugment.length,
      task: "measurement.analysis.mention_semantics",
    });
        // [seam 3/3] 현행: `await (opts.mentionSemantics ?? classifyMentionSemanticsWithLlm)({`
    semanticsResult = await deps.llm.semantics({
      promptText: turn.turnPromptText,
      answerText: turn.turnAnswerText ?? "",
      mentions: mentionsAfterAugment.map((mention, index) => ({
        index,
        surfaceText: mention.surfaceText,
        mentionPosition: mention.mentionPosition,
        contextSnippet: mention.contextSnippet,
      })),
    });
    if (semanticsResult.decisions.length > 0) {
      const byIndex = new Map(
        semanticsResult.decisions.map((d) => [d.index, d]),
      );
      mentionsWithSemantics = mentionsAfterAugment.map(
        (mention, index) => {
          const decision = byIndex.get(index);
          if (!decision) return mention;
          return {
            ...mention,
            sentiment: decision.sentiment,
            extractionMetadata: {
              ...mention.extractionMetadata,
              llm_mention_type: decision.mentionType,
              llm_sentiment_source: "llm_semantics_pass",
            },
          };
        },
      );
    }
    log.info("measurement_analysis.semantics.llm_done", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      mentions: mentionsAfterAugment.length,
      decisions: semanticsResult.decisions.length,
      parser_partial: semanticsResult.parserPartial,
      malformed_count: semanticsResult.malformedCount,
      attempts: semanticsResult.attempts ?? 0,
      model_slug: semanticsResult.modelSlug,
      cost_usd: semanticsResult.costUsd ?? 0,
      failed: semanticsResult.failed ?? false,
      error_message: semanticsResult.errorMessage,
      // 미채점 진단 (change semantics-retry-hardening): 응답 원문을 남기지
      // 않던 탓에 2026-07-29 실패 조사에서 재현 실험을 따로 돌려야 했다.
      dropped_entries: semanticsResult.droppedEntries ?? 0,
      unscored: Math.max(
        0,
        mentionsAfterAugment.length - semanticsResult.decisions.length,
      ),
      last_response_excerpt: semanticsResult.lastResponseExcerpt,
    });
  }
  let semanticsV2Result: MentionSemanticsV2Result | null = null;
  let semanticsV2ThrewMessage: string | null = null;
  if (
    useSemanticsV2 &&
    deps.llm.semanticsV2 &&
    analysis.quality.qualityState === "valid_answer" &&
    mentionsAfterAugment.length > 0
  ) {
    log.info("measurement_analysis.semantics_v2.llm_start", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      mentions: mentionsAfterAugment.length,
      task: "measurement.analysis.mention_semantics",
    });
    try {
      semanticsV2Result = await deps.llm.semanticsV2({
        promptText: turn.turnPromptText,
        answerText: turn.turnAnswerText ?? "",
        // 원배열 index 를 그대로 넘긴다. 오프셋은 아직 UTF-16(finalize 이전)이다.
        mentions: mentionsAfterAugment.map((mention, index) => ({
          index,
          surfaceText: mention.surfaceText,
          mentionPosition: mention.mentionPosition,
          entityType: mention.entityType,
          entityId: mention.entityId,
          sourceStart: mention.sourceStart ?? null,
          sourceEnd: mention.sourceEnd ?? null,
        })),
      });
    } catch (error) {
      // 현행 semantics 와 같은 실패 자세: 기계 감성을 유지하고 턴은 계속 간다.
      semanticsV2ThrewMessage =
        error instanceof Error ? error.message : String(error);
    }
    const v2ByIndex = new Map(
      (semanticsV2Result?.decisions ?? []).map((d) => [d.index, d]),
    );
    // 근거 3키는 extractionMetadata 경유로 persist 까지 간다(lane 답장 계약의
    // 멘션 필드는 .strict() 라 새 필드를 더하지 않는다). store 가 컬럼으로 옮긴다.
    mentionsWithSemantics = mentionsAfterAugment.map((mention, index) => {
      const decision = v2ByIndex.get(index);
      if (!decision) {
        return {
          ...mention,
          extractionMetadata: {
            ...mention.extractionMetadata,
            sentiment_evidence: null,
            sentiment_reason: null,
            sentiment_source: "regex_line",
          },
        };
      }
      return {
        ...mention,
        sentiment: decision.sentiment,
        extractionMetadata: {
          ...mention.extractionMetadata,
          // 현행 semantics 패스와 **같은 키**다. store `mentionTypeBucket` 이 이 키를 먼저
          // 읽고 없을 때만 정규식 assertion 으로 폴백한다. `assertion` 자체는 덮지 않는다
          // (ACR·delivery 가 assertion 에 걸려 있다, 현행 원칙 유지).
          // 현행 패스의 `llm_sentiment_source` 는 싣지 않는다: 읽는 곳이 없고, V2 의 출처는
          // `sentiment_source` 컬럼이 정본이다(메타에 사본을 두지 않는다는 저장 원칙과 같다).
          ...(decision.mentionType ? { llm_mention_type: decision.mentionType } : {}),
          sentiment_evidence: decision.evidence,
          sentiment_reason: decision.reason,
          sentiment_source: decision.source,
        },
      };
    });
    log.info("measurement_analysis.semantics_v2.llm_done", {
      query_run_id: turn.queryRunId,
      turn_run_id: turn.turnRunId,
      prompt_run_id: turn.promptRunId,
      target: turn.target,
      region: turn.region,
      mentions: mentionsAfterAugment.length,
      eligible: semanticsV2Result?.eligibleCount ?? 0,
      requested: semanticsV2Result?.requestedCount ?? 0,
      decisions: semanticsV2Result?.decisions.length ?? 0,
      retry_requested: semanticsV2Result?.retryRequestedCount ?? 0,
      missing: semanticsV2Result?.missingCount ?? 0,
      evidence_rejected: semanticsV2Result?.evidenceRejectedCount ?? 0,
      dropped_entries: semanticsV2Result?.droppedEntries ?? 0,
      malformed_count: semanticsV2Result?.malformedCount ?? 0,
      attempts: semanticsV2Result?.attempts ?? 0,
      model_slug: semanticsV2Result?.modelSlug,
      cost_usd: semanticsV2Result?.costUsd ?? 0,
      failed: semanticsV2Result?.failed ?? semanticsV2ThrewMessage !== null,
      error_message: semanticsV2Result?.errorMessage ?? semanticsV2ThrewMessage,
      last_response_excerpt: semanticsV2Result?.lastResponseExcerpt,
    });
  }
  // ── 답변 단위 브랜드 스탠스 (change add-answer-brand-stance) ───────────────
  //
  // semantics **뒤**·오프셋 finalize **앞**에 둔다. 대상 집합이 멘션 최종 집합
  // (필터·증강·semantics 후)에 의존하고, 증거 오프셋 변환이 멘션 오프셋 변환과
  // 같은 변환표를 공유하는 것이 싸기 때문이다(스펙 §4.6).
  //
  // ⚠️ **실패 격리(FR6)**: 이 블록은 무엇이 터져도 턴 분석을 죽이지 않는다.
  // invoker 가 throw 해도 `catch` 가 받아 `answerStances = []` 로 끝내고 멘션·
  // 감성·후보는 그대로 persist 된다. 스탠스는 새 축이고, 새 축이 기존 지표를
  // 인질로 잡아서는 안 된다.
  let answerStances: AnswerBrandStance[] = [];
  let stanceResult: AnswerBrandStanceResult | null = null;
  let stanceTargetSet: StanceTargetSet | null = null;
  let stanceMatch: ReturnType<typeof matchAndVerifyStances> | null = null;
  let stanceThrewMessage: string | null = null;
  if (
    options.enableLlmAnswerBrandStance &&
    deps.llm.stance &&
    analysis.quality.qualityState === "valid_answer" &&
    mentionsWithSemantics.length > 0
  ) {
    stanceTargetSet = buildStanceTargets({
      mentions: mentionsWithSemantics,
      catalog,
      rels,
      grouping,
      trackedAugmentTargets,
    });
    if (stanceTargetSet.targets.length > 0) {
      log.info("measurement_analysis.stance.llm_start", {
        query_run_id: turn.queryRunId,
        turn_run_id: turn.turnRunId,
        prompt_run_id: turn.promptRunId,
        target: turn.target,
        region: turn.region,
        answer_chars: (turn.turnAnswerText ?? "").length,
        brands: stanceTargetSet.targets.length,
        brands_truncated: stanceTargetSet.truncated,
        task: "measurement.analysis.answer_brand_stance",
      });
      try {
        stanceResult = await deps.llm.stance({
          promptText: turn.turnPromptText,
          answerText: turn.turnAnswerText ?? "",
          brands: stanceTargetSet.targets.map((t) => t.label),
        });
      } catch (error) {
        stanceThrewMessage =
          error instanceof Error ? error.message : String(error);
      }
      if (stanceResult && stanceResult.decisions.length > 0) {
        stanceMatch = matchAndVerifyStances({
          decisions: stanceResult.decisions,
          targets: stanceTargetSet.targets,
          answerText: turn.turnAnswerText ?? "",
          modelSlug: stanceResult.modelSlug ?? null,
          stancePromptVersion: STANCE_PROMPT_VERSION,
          brandsTruncated: stanceTargetSet.truncated,
        });
        answerStances = stanceMatch.stances;
      }
      log.info("measurement_analysis.stance.llm_done", {
        query_run_id: turn.queryRunId,
        turn_run_id: turn.turnRunId,
        prompt_run_id: turn.promptRunId,
        target: turn.target,
        region: turn.region,
        brands: stanceTargetSet.targets.length,
        brands_truncated: stanceTargetSet.truncated,
        decisions: stanceResult?.decisions.length ?? 0,
        stances: answerStances.length,
        // A3 커버리지(≥98%)의 지문 둘 — 둘 다 0 이 기대값이다.
        unscored: stanceMatch?.unscoredTargets ?? stanceTargetSet.targets.length,
        unmatched_brands: stanceMatch?.unmatchedBrands ?? [],
        // RK4 환각률의 계수 — evidence_match 분포를 여기서 센다.
        evidence_match: stanceMatch?.evidenceMatchCounts ?? null,
        // aspect 축은 **따로** 센다(D6). 모수도 span 성격도 달라 합치면 다크런치에서
        // "어느 축이 환각하는가" 를 못 가른다.
        aspect_evidence_match: stanceMatch?.aspectEvidenceMatchCounts ?? null,
        parser_partial: stanceResult?.parserPartial ?? false,
        malformed_count: stanceResult?.malformedCount ?? 0,
        dropped_entries: stanceResult?.droppedEntries ?? 0,
        // aspects[] 원소 구조 드롭 합계 — 브랜드 판정 드롭(dropped_entries)과 별개.
        dropped_aspects: stanceResult?.droppedAspects ?? 0,
        // 부속 필드 강등 계수 — 드롭이 아니다. 꾸준히 높으면 프롬프트 수리 신호.
        coerced_confidence: stanceResult?.coercedConfidence ?? 0,
        attempts: stanceResult?.attempts ?? 0,
        model_slug: stanceResult?.modelSlug,
        cost_usd: stanceResult?.costUsd ?? 0,
        failed: stanceResult?.failed ?? stanceThrewMessage !== null,
        error_message: stanceResult?.errorMessage ?? stanceThrewMessage,
        last_response_excerpt: stanceResult?.lastResponseExcerpt,
      });
    }
  }
  // 진짜 choke point: LLM verbatim-extraction 경로(buildMentionsFromLlmExtraction
  // → resolveLlmMentionSpan, 원문 .indexOf/.slice 로 새 UTF-16 오프셋을 직접
  // 계산)는 결정적 매칭 짝이 없는 LLM-only 멘션에서 반환 경계 2곳(core.ts·
  // tracked-brand-augment.ts)을 모두 우회한다. 영속 직전인 여기서 한 번 더
  // 태우면 그 멘션도 잡힌다 — 멱등(offset_basis 마커)이라 이미 변환된 나머지는
  // 그대로 통과한다.
  const analysisForPersist = {
    ...analysis,
    mentions: finalizeMentionOffsets(
      turn.turnAnswerText ?? "",
      normalizeMentionOrder(mentionsWithSemantics),
    ),
    candidates: candidatesAfterExclusionFilter,
    modelSlug:
      llmMentionExtraction?.modelSlug ??
      analysis.modelSlug,
    extractionMetadata: {
      ...analysis.extractionMetadata,
      parser_partial:
        Boolean(analysis.extractionMetadata.parser_partial) ||
        Boolean(llmMentionExtraction?.parserPartial),
      llm_mention_enabled: options.enableLlmMentionExtraction,
      llm_mention_failed: llmMentionExtraction?.failed ?? false,
      llm_mention_count: llmMentionExtraction?.mentions.length ?? 0,
      llm_mention_warnings: llmMentionExtraction?.warnings ?? [],
      tracked_augment_enabled: options.enableTrackedBrandAugment,
      tracked_augment_count: trackedAugmentCount,
      llm_pending_resolver_enabled: options.enableLlmPendingResolver,
      llm_pending_resolver_failed:
        llmPendingResolution?.result.failed ?? false,
      llm_pending_resolver_decisions:
        llmPendingResolution?.result.decisions.length ?? 0,
      llm_pending_resolver_resolved:
        llmPendingResolution?.resolvedCount ?? 0,
      llm_pending_resolver_kept_pending:
        llmPendingResolution?.keptPendingCount ?? 0,
      llm_pending_resolver_ignored:
        llmPendingResolution?.ignoredCount ?? 0,
      llm_pending_resolver_warnings:
        llmPendingResolution?.result.warnings ?? [],
      llm_mention_semantics_enabled: options.enableLlmMentionSemantics,
      llm_mention_semantics_failed: semanticsResult?.failed ?? false,
      llm_mention_semantics_decisions:
        semanticsResult?.decisions.length ?? 0,
      llm_mention_semantics_warnings: semanticsResult?.warnings ?? [],
      llm_unknown_enabled: options.enableLlmUnknownDiscovery,
      llm_malformed_count:
        (llmMentionExtraction?.malformedCount ?? 0) +
        (llmPendingResolution?.result.malformedCount ?? 0) +
        (semanticsResult?.malformedCount ?? 0) +
        (semanticsV2Result?.malformedCount ?? 0),
      llm_retry_count: Math.min(
        (llmMentionExtraction?.malformedCount ?? 0) +
          (llmPendingResolution?.result.malformedCount ?? 0) +
          (semanticsResult?.malformedCount ?? 0) +
          (semanticsV2Result?.malformedCount ?? 0),
        1,
      ),
      // ⚠️ 스탠스 콜의 attempts·cost 를 **여기 더한다**(`?? 0` 이라 패스가 안 돌면
      // 값이 그대로 = 골든 바이트 동일). 안 더하면 `analysis_llm_cost_usd` 가
      // 실비를 과소 보고하고, 동치성 테스트의 `usage.attempts 합 ==
      // analysis_llm_calls` 단언이 스탠스 on 에서 깨진다.
      analysis_llm_calls:
        (llmMentionExtraction?.attempts ?? 0) +
        (llmPendingResolution?.result.attempts ?? 0) +
        (semanticsResult?.attempts ?? 0) +
        (semanticsV2Result?.attempts ?? 0) +
        (stanceResult?.attempts ?? 0),
      analysis_llm_cost_usd:
        (llmMentionExtraction?.costUsd ?? 0) +
        (llmPendingResolution?.result.costUsd ?? 0) +
        (semanticsResult?.costUsd ?? 0) +
        (semanticsV2Result?.costUsd ?? 0) +
        (stanceResult?.costUsd ?? 0),
      analysis_llm_trace_id: llmMentionExtraction?.traceId,
      analysis_resolver_llm_trace_id:
        llmPendingResolution?.result.traceId,
      analysis_semantics_llm_trace_id: semanticsResult?.traceId,
      // 감성 판별 V2 턴 진단. 스탠스와 같은 이유로 **조건부 스프레드**다(off 면 키가
      // 없어 골든 바이트가 그대로).
      ...(useSemanticsV2 &&
      analysis.quality.qualityState === "valid_answer" &&
      mentionsAfterAugment.length > 0
        ? {
            llm_mention_semantics_v2_enabled: true,
            llm_mention_semantics_v2_failed:
              semanticsV2Result?.failed ?? semanticsV2ThrewMessage !== null,
            llm_mention_semantics_v2_calls: semanticsV2Result?.attempts ?? 0,
            llm_mention_semantics_v2_requested:
              semanticsV2Result?.requestedCount ?? 0,
            llm_mention_semantics_v2_decisions:
              semanticsV2Result?.decisions.length ?? 0,
            llm_mention_semantics_v2_retry_requested:
              semanticsV2Result?.retryRequestedCount ?? 0,
            llm_mention_semantics_v2_missing:
              semanticsV2Result?.missingCount ?? 0,
            llm_mention_semantics_v2_evidence_rejected:
              semanticsV2Result?.evidenceRejectedCount ?? 0,
            analysis_semantics_v2_llm_trace_id: semanticsV2Result?.traceId,
          }
        : {}),
      // ⚠️ 스탠스 키는 **조건부 스프레드**다. 무조건 넣으면(예:
      // `llm_answer_brand_stance_enabled: false`) 키가 하나 늘어 골든 13개가
      // 전부 깨진다 — `stableStringify` 는 키를 정렬하지만 **존재**는 못 숨긴다.
      // 게이트 off = 이 블록이 통째로 없다 = 리팩터 전과 바이트 동일(A1).
      ...(stanceTargetSet
        ? {
            llm_answer_brand_stance_enabled: true,
            llm_answer_brand_stance_failed:
              stanceResult?.failed ?? stanceThrewMessage !== null,
            llm_answer_brand_stance_brands:
              stanceTargetSet.targets.length,
            llm_answer_brand_stance_truncated: stanceTargetSet.truncated,
            llm_answer_brand_stance_count: answerStances.length,
            llm_answer_brand_stance_unscored:
              stanceMatch?.unscoredTargets ?? stanceTargetSet.targets.length,
            llm_answer_brand_stance_unmatched:
              stanceMatch?.unmatchedBrands ?? [],
            llm_answer_brand_stance_evidence_match:
              stanceMatch?.evidenceMatchCounts ?? null,
            llm_answer_brand_stance_aspect_evidence_match:
              stanceMatch?.aspectEvidenceMatchCounts ?? null,
            llm_answer_brand_stance_warnings: stanceResult?.warnings ?? [],
            // aspects[] 구조 드롭 수 (요구사항 2) — 브랜드 판정 드롭과 별도 축.
            llm_answer_brand_stance_dropped_aspects:
              stanceResult?.droppedAspects ?? 0,
            analysis_stance_llm_trace_id: stanceResult?.traceId,
            stance_prompt_version: STANCE_PROMPT_VERSION,
          }
        : {}),
    },
  };
  // ── 여기까지 store.ts:587~952 ─────────────────────────────────────────────
  const usage: AnalysisTurnUsage = [];
  if (llmMentionExtraction) {
    usage.push({
      task: "measurement.analysis.extract_mentions",
      modelSlug: llmMentionExtraction.modelSlug ?? null,
      attempts: llmMentionExtraction.attempts ?? 0,
      costUsd: llmMentionExtraction.costUsd ?? 0,
      traceId: llmMentionExtraction.traceId ?? null,
      failed: llmMentionExtraction.failed ?? false,
    });
  }
  if (llmPendingResolution) {
    usage.push({
      task: "measurement.analysis.resolve_pending_mentions",
      modelSlug: llmPendingResolution.result.modelSlug ?? null,
      attempts: llmPendingResolution.result.attempts ?? 0,
      costUsd: llmPendingResolution.result.costUsd ?? 0,
      traceId: llmPendingResolution.result.traceId ?? null,
      failed: llmPendingResolution.result.failed ?? false,
    });
  }
  if (semanticsResult) {
    usage.push({
      task: "measurement.analysis.mention_semantics",
      modelSlug: semanticsResult.modelSlug ?? null,
      attempts: semanticsResult.attempts ?? 0,
      costUsd: semanticsResult.costUsd ?? 0,
      traceId: semanticsResult.traceId ?? null,
      failed: semanticsResult.failed ?? false,
    });
  }
  if (semanticsV2Result) {
    usage.push({
      task: "measurement.analysis.mention_semantics",
      modelSlug: semanticsV2Result.modelSlug ?? null,
      attempts: semanticsV2Result.attempts,
      costUsd: semanticsV2Result.costUsd,
      traceId: semanticsV2Result.traceId ?? null,
      failed: semanticsV2Result.failed,
    });
  }
  if (stanceResult) {
    usage.push({
      task: "measurement.analysis.answer_brand_stance",
      modelSlug: stanceResult.modelSlug ?? null,
      attempts: stanceResult.attempts ?? 0,
      costUsd: stanceResult.costUsd ?? 0,
      traceId: stanceResult.traceId ?? null,
      failed: stanceResult.failed ?? false,
    });
  }
  // (b) lane 경로: 코어가 실어 보낸 `sourceTurnHash` 를 그대로 에코한다.
  // (a) 인라인 경로에서는 `input.sourceTurnHash` 가 undefined 라 같은 객체가
  // 그대로 나간다 — 산출은 바이트 동일하다.
  const analysisOut =
    input.sourceTurnHash === undefined
      ? analysisForPersist
      : { ...analysisForPersist, sourceTurnHash: input.sourceTurnHash };
  // ⚠️ `answerStances` 는 **`analysis` 안이 아니라 payload 형제 키**다.
  //
  // 스펙 §8.2 WU3 AC2 는 `out.analysis.answerStances` 를 적었지만, 골든 13개는
  // `stableStringify(analysis)` **바이트 대조**이고(analyze-turn.equivalence.
  // test.ts) `analysis` 에 키를 하나 더하면 13개가 전부 깨진다 — 즉 AC2 의 그
  // 표기는 AC1(A1: 게이트 off 에서 골든 바이트 동일)과 **직접 충돌**한다.
  // A1 이 이기고(동작 무변경이 이 계층의 유일한 계약), 키는 형제로 나간다.
  // "off 일 때 undefined 가 아니라 빈 배열" 이라는 AC2 의 성질은 그대로다.
  //
  // persist 도 이 편이 곧다 — `analysisForPersist` 는 `measurement_turn_analysis`
  // 행 그 자체이고 스탠스는 **다른 테이블**이다(스펙 §0 R3).
  return { analysis: analysisOut, usage, answerStances };
}

/** `analyzeTurnPure` 가 실제로 만드는 것 — 타입을 손으로 다시 쓰지 않는다. */
export type TurnAnalysisPayload = Awaited<ReturnType<typeof analyzeTurnPure>>;
/** = 현행 `analysisForPersist` (store.ts:889~952). persist 가 그대로 받는다. */
export type TurnAnalysisForPersist = TurnAnalysisPayload["analysis"];
