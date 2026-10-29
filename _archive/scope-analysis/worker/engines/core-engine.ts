// `ANALYSIS_ENGINE=core` — 벤더된 순수 분석 코드를 티켓 계약에 물린다.
//
// ── 이 파일이 하는 일은 **실행이 아니라 주입과 번역**이다
//
//   분석 로직은 한 줄도 여기 없다. 전부 `packages/analysis-core/vendor/` 의 바이트 사본이고
//   (핀: `ANALYSIS_CORE_PIN.json`), 이 파일은 그 사이의 **경계 번역기**다:
//
//     AnalysisTicketRequestV1  ──(b) 경로──▶  analyzeTurnPure(input, context, deps)
//            컨텍스트 스냅샷  ──재구성──▶           │           ▲
//                                                  │           └── deps.llm = lane invoker 브리지
//                                                  ▼
//                                    AnalysisReplyV1.result.turn
//
//   그래서 lane 경로와 코어 인라인 경로의 차이는 **직렬화·역직렬화뿐**이고, diff 가 0 이 아니면
//   그것은 전부 이 파일의 결함이다(스펙 §6.4 게이트 ②의 논리). 골든 13개가 그걸 판정한다
//   (`tests/golden-analysis-core.test.ts`).
//
// ── (b) 경로 — `rawResponse` 없이 `sourceTurnHash` 를 받는다
//
//   티켓에는 `rawResponse` 가 실리지 않으므로(스펙 §4.3 — 본문에서 가장 큰 필드) lane 은
//   `turnHash` 를 **계산할 수 없다**. 코어가 계산해 보내고 lane 이 에코한다(D4). 벤더 코드의
//   `assertExclusiveTurnInput` 이 그 배타성을 **런타임에** 집행한다 — 둘 다 있거나 둘 다 없으면
//   조용한 오염이 되므로 진입에서 죽는다.
import {
  analyzeTurnPure,
  type AnalysisTurnContext,
  type AnalysisTurnInputWithHash,
} from "../../packages/analysis-core/vendor/lib/measurement-analysis/pure/index.ts";
import type { AnalysisLlmDeps } from "../../packages/analysis-core/vendor/lib/measurement-analysis/pure/deps.ts";
import {
  buildGroupingIndex,
  type CompiledGrouping,
} from "../../packages/analysis-core/vendor/lib/brand-grouping/types.ts";
import {
  classifyAnswerBrandStanceWithLlm,
  classifyMentionSemanticsV2,
  classifyMentionSemanticsWithLlm,
  extractMentionsWithLlm,
  resolvePendingMentionsWithLlm,
} from "../../packages/analysis-core/vendor/lib/measurement-analysis/llm.ts";
import { resolveCitationDomain } from "../../packages/analysis-core/vendor/lib/measurement-analysis/citation-classify.ts";
import {
  AnalysisOptionsSchema,
  OntologyCatalogEntitySchema,
} from "../../packages/analysis-core/vendor/lib/measurement-analysis/schema.ts";
import type {
  ClaudeRequest,
  ClaudeResponse,
} from "../../packages/analysis-core/shims/llm-invoke.ts";

import { z } from "zod";

import { AnalysisIndustrySchema, type AnalysisCallUsage, type AnalysisResultTurn } from "../../contracts/index.ts";
import {
  AnalysisContractError,
  AnalysisDeferrable,
  type AnalysisEngine,
  type AnalysisEngineInput,
  type AnalysisEngineOutput,
  type CitationClassification,
  type LaneLogger,
  type LlmInvokeRequest,
} from "../engine.ts";
import { usageRowsFromError } from "../invoker.ts";
import { CORE_TASK_TO_LANE_TASK } from "../llm-pools.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 컨텍스트 스냅샷 — 코어가 직렬화한 4종을 lane 이 재구성한다 (스펙 §5.4)
// ─────────────────────────────────────────────────────────────────────────────

const RelationshipRowSchema = z.object({ fromId: z.string(), type: z.string(), toId: z.string() }).strict();

const GroupingLevelSchema = z.enum(["product", "brand", "company"]);

/**
 * ⚠️ `grouping` 은 코어에서 **함수를 가진 인덱스 객체**(`GroupingIndex`)다 — 함수는 직렬화되지
 * 않는다. 그래서 코어가 **원시 규칙 배열**(`CompiledGrouping`)로 내리고 lane 이
 * `buildGroupingIndex` 로 되세운다(스펙 §5.4, `lib/brand-grouping/load.ts:43~58` 의 원본 두 테이블 형태).
 *
 * 이걸 빼먹으면 조용히 틀린다: `grouping` 이 빈 인덱스가 되면 예외 없이 **롤업 판정이 통째로
 * 달라진다**(`resolveRollups` 가 전부 null 을 준다). 그래서 키 자체가 없으면 여기서 죽인다
 * (`ContextCache.parseSnapshot` 이 이미 4키 존재를 확인하지만, 모양까지 보는 것은 여기다).
 */
const CompiledGroupingSchema = z
  .object({
    entityRules: z
      .array(z.object({ sourceEntityId: z.string(), level: GroupingLevelSchema, rollupEntityId: z.string() }).strict())
      .default([]),
    surfaceRules: z
      .array(
        z
          .object({
            fromEntityId: z.string(),
            surfaceNormalized: z.string(),
            level: GroupingLevelSchema,
            rollupEntityId: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const TrackedAugmentTargetSchema = z
  .object({
    brandKey: z.string(),
    representativeEntityId: z.string(),
    representativeCanonical: z.string(),
    entityType: z.enum(["Brand", "Product", "ProductCategory", "Feature"]),
    entityIds: z.array(z.string()),
    surfaces: z.array(z.string()),
  })
  .strict();

/**
 * ⚠️ **`catalog` 은 배열이 아니다** — D-6 의 자리(2026-09-13 06:26Z 라이브, 295건 종결).
 *
 * 초판은 `z.array(OntologyCatalogEntitySchema)` 였다. 그것은 **순수 코드가 받는 형태**
 * (`AnalysisTurnContext.catalog: OntologyCatalogEntity[]`)이지 **스냅샷의 형태가 아니다.**
 * 코어 스냅샷은 `SharedAnalysisContext.catalog` 를 그대로 싣고(`context-snapshot.ts`
 * `toAnalysisContextSnapshot`), 그 타입은 `loadOntologyCatalog` 의 반환
 * `{ entities: OntologyCatalogEntity[]; industry: IndustryScopeContext }` 다
 * (코어 `lib/measurement-analysis/store.ts:219`·`:1826~`). 배열을 기대하면 라이브의 모든
 * 티켓이 `catalog: expected array, received object` 로 죽는다 — 실제로 그렇게 됐다.
 *
 * 배열로 펴 주는 주체는 코어 `store.ts:569` 다: `catalog = context.catalog?.entities`,
 * `industry = context.catalog?.industry ?? UNSCOPED_INDUSTRY`. lane 도 **같은 자리에서**
 * 같은 변환을 한다(`buildTurnContext`).
 *
 * ⚠️ 이 객체만 `.strict()` 가 아니다. 여기는 **코어가 소유한 모양**이라 코어가 축을 더하면
 *    lane 이 통째로 죽는다(D-6 의 실제 손해가 그것이다). lane 이 읽는 것은 `entities` 뿐이고
 *    `industry` 는 티켓이 정본이므로, 모르는 키는 무시하는 쪽이 **안전한 실패 방향**이다.
 *    반대로 `entities` 가 없으면 분석이 조용히 빈 카탈로그로 도므로 그것은 막는다.
 */
const CatalogScopeSchema = z.object({
  entities: z.array(OntologyCatalogEntitySchema),
  // 코어 `IndustryScopeContext`. lane 은 이 값을 **쓰지 않는다**(티켓이 정본) — 다르면 warn 만.
  industry: AnalysisIndustrySchema,
});

const ContextSnapshotSchema = z
  .object({
    catalog: CatalogScopeSchema,
    rels: z.array(RelationshipRowSchema),
    grouping: CompiledGroupingSchema,
    trackedAugmentTargets: z.array(TrackedAugmentTargetSchema),
  })
  .strict();

export type ContextSnapshotPayload = z.infer<typeof ContextSnapshotSchema>;

/**
 * 스냅샷 파싱 실패의 재시도 간격. `maxAttempts` 가 3 이라 이 티켓은 30s 간격으로 3회 시도한 뒤
 * `cap_exhausted` 로 종결된다(~1분) — 그 값은 계약상 "코어가 재발행하면 성공할 수 있다" 다.
 * 짧게 잡지 않는 이유: 이 결함의 실제 해소 경로는 **lane 재배포**이고 몇 초 안에 풀리지 않는다.
 * 길게 잡지 않는 이유: 티켓이 큐에서 버티면 마감(`deadlineAt`)을 먹는다.
 */
const SNAPSHOT_MALFORMED_RETRY_AFTER_MS = 30_000;

/**
 * 스냅샷 → 순수 코드가 받는 컨텍스트. `industry`·`options` 는 스냅샷이 아니라 **티켓**에서 온다
 * (프로젝트별로 다르고, `options` 는 코어가 확정해 보내는 정책이라 캐시에 섞으면 안 된다).
 */
export function buildTurnContext(input: AnalysisEngineInput): AnalysisTurnContext {
  const snapshot = ContextSnapshotSchema.safeParse({
    catalog: input.context.catalog,
    rels: input.context.rels,
    grouping: input.context.grouping,
    trackedAugmentTargets: input.context.trackedAugmentTargets,
  });
  if (!snapshot.success) {
    // ── 종결 등급 재검토 (D-6) ───────────────────────────────────────────────
    //
    // 초판은 `AnalysisContractError`(= permanent 1회 종결)였다. 근거는 "재시도해도 같은
    // 스냅샷" 이었고 그 자체는 맞다 — **그러나 무엇이 틀렸는지를 틀리게 가정했다.**
    // 이 판정문은 "코어 데이터가 깨졌다" 를 전제하는데, 2026-09-13 06:26Z 에 실제로 일어난
    // 일은 **lane 스키마가 코어 실물과 달랐던 것**이고(카탈로그 모양), 그 대가로 잔여 표본
    // **295건이 전부 failed(permanent)** 로 사라졌다. 코어는 permanent 를 재발행하지 않는다.
    //
    // 두 원인의 사전 확률과 손실이 비대칭이다:
    //   · lane 스키마 결함(관측된 실제 원인) → **배포 한 번이면 같은 티켓이 성공한다.**
    //     permanent 면 그 회수 기회가 사라진다.
    //   · 코어 스냅샷 오염 → deferred 로 두면 3회 재시도 후 `cap_exhausted` 로 종결된다.
    //     계약상 그것은 "코어가 재발행하면 성공할 수 있다" 이고, 오염이 지속되면 같은 결론에
    //     **조금 늦게** 도달할 뿐이다. 재시도 비용도 싸다 — 이 실패는 LLM 호출 **이전**이라
    //     실비가 0 이고 컨텍스트는 캐시에서 온다.
    // 그래서 스냅샷 파싱 실패는 `deferred(transient)` 다. 409 version_mismatch(코어가 명시적으로
    // "그 버전은 없다" 고 답한 경우)는 permanent 그대로다 — 그건 코어가 판정한 사실이다.
    const detail = `context snapshot ${input.context.contextVersion} is malformed: ${snapshot.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`;
    // ⚠️ **값은 싣지 않는다** — 이 스냅샷은 워크스페이스 전체 카탈로그다(app/log.ts 머리말).
    //    zod 의 issue 는 경로(키 이름)와 타입 이름만 담는다.
    input.log.error("analysis_lane.context_snapshot_malformed", {
      contextVersion: input.context.contextVersion,
      issues: snapshot.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.code}`),
      detail: detail.slice(0, 512),
    });
    throw new AnalysisDeferrable("transient", SNAPSHOT_MALFORMED_RETRY_AFTER_MS, detail);
  }
  // ⚠️ 계약이 이미 11필드 `.strict()` 로 좁혀 놨지만 여기서 한 번 더 파싱한다 — 벤더
  //    `AnalysisOptionsSchema` 는 코어가 소유한 **기본값·강제값**을 갖고 있고, 순수 코드가
  //    받는 것은 그 산출물이어야 한다(코어 인라인 경로와 같은 객체).
  const options = AnalysisOptionsSchema.safeParse(input.ticket.options);
  if (!options.success) {
    throw new AnalysisContractError(
      `ticket options are not ResolvedAnalysisOptions: ${options.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const compiled: CompiledGrouping = snapshot.data.grouping;
  // ⚠️ 스냅샷의 `catalog.industry` 와 티켓의 `industry` 가 갈릴 수 있다 — 스냅샷은 **버전 캐시**라
  //    프로젝트 산업이 바뀐 직후 창에서 옛 값을 들고 있을 수 있고, 티켓은 발행 시점 값이다.
  //    규약은 그대로 "industry·options 는 티켓이 정본"이고(이 함수 머리말), 여기서는 **갈렸다는
  //    사실만** 남긴다. 값 중 `name` 은 싣지 않는다 — ids·source 로 추적에 충분하다.
  const snapshotIndustry = snapshot.data.catalog.industry;
  const ticketIndustry = input.ticket.industry;
  const sameIds =
    snapshotIndustry.ids.length === ticketIndustry.ids.length &&
    [...snapshotIndustry.ids].sort().join(",") === [...ticketIndustry.ids].sort().join(",");
  if (!sameIds || snapshotIndustry.source !== ticketIndustry.source) {
    input.log.warn("analysis_lane.industry_mismatch", {
      contextVersion: input.context.contextVersion,
      ticketIds: ticketIndustry.ids,
      ticketSource: ticketIndustry.source,
      snapshotIds: snapshotIndustry.ids,
      snapshotSource: snapshotIndustry.source,
    });
  }
  return {
    // ⚠️ 순수 코드가 받는 것은 **배열**이다(`AnalysisTurnContext.catalog: OntologyCatalogEntity[]`).
    //    코어도 같은 자리에서 편다: `store.ts:569` `catalog = context.catalog?.entities`.
    catalog: snapshot.data.catalog.entities,
    rels: snapshot.data.rels,
    grouping: buildGroupingIndex(compiled),
    trackedAugmentTargets: snapshot.data.trackedAugmentTargets,
    // 코어 `store.ts:569` `context.catalog?.industry ?? UNSCOPED_INDUSTRY` 의 lane 쪽 짝.
    //
    // ⚠️ **합성하지 않는다.** 초판은 계약이 `{id, name}` 이던 시절의 잔재로 `ids: [id]` 와
    //    `source: id ? "project" : "none"` 을 **지어냈다**. 둘 다 틀릴 수 있다:
    //    tracked-brand 휴리스틱은 `ids` 를 복수로 내고(그때 초판은 첫 개만 넘긴다),
    //    `source` 는 `env`·`tracked_brands` 일 수 있다(그때 초판은 `project` 로 위조한다).
    //    `industry.name` 은 순수 코드의 프롬프트 변형 게이트 입력이므로
    //    (`analyze-turn.ts:204,225` `industryName`), 값이 갈리면 코어 인라인 경로와 **다른
    //    프롬프트로 다른 분석**을 한다. 계약이 실물 타입을 싣게 된 지금은 그대로 넘긴다.
    industry: {
      ids: input.ticket.industry.ids,
      name: input.ticket.industry.name,
      source: input.ticket.industry.source,
    },
    // 감성 V2 게이트(`enableLlmMentionSemanticsV2`)는 벤더 재동기(코어 64de80d2) 이후 벤더
    // `AnalysisOptionsSchema` 가 직접 받는다. 키가 없는 티켓은 스키마 기본값 false 가 되고,
    // 순수 계층은 `=== true` 로만 분기하므로 산출 바이트가 이전과 같다(골든 13개).
    // #29 의 재부착(Object.assign)은 strip 을 우회하던 임시 배선이라 이 재동기에서 걷었다.
    // lane 은 이 값으로 아무것도 판단하지 않는다: 게이트는 벤더 순수 계층 한 곳뿐이어야 한다.
    options: options.data,
  };
}

/** 티켓 `turn` → 순수 입력. **(b) 경로 고정**: `rawResponse` 를 넣지 않는다(D4). */
export function buildTurnInput(input: AnalysisEngineInput): AnalysisTurnInputWithHash {
  const t = input.ticket.turn;
  const l = input.ticket.lineage;
  return {
    turnRunId: t.turnRunId,
    turnIndex: t.turnIndex,
    // ⚠️ 여기서 **턴 단위** 텍스트가 들어간다. 코어 DB 행의 필드명은 `turnPromptText`/
    //    `turnAnswerText` 이고 같은 행에 **쿼리 단위** `promptText` 가 따로 있다 — 매핑을
    //    코어 어댑터가 틀리면 멀티턴에서 1턴 프롬프트가 전 턴에 실리는 **조용한 품질 저하**가
    //    된다(스펙 §4.3). lane 쪽은 계약 필드명이 이미 턴 단위라 그대로 받는다.
    promptText: t.promptText,
    answerText: t.answerText,
    trace: {
      queryRunId: l.queryRunId,
      promptRunId: l.promptRunId,
      target: t.target,
      region: t.region,
    },
    sourceTurnHash: t.sourceTurnHash,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 브리지 — 벤더 코드의 `ClaudeRequest/ClaudeResponse` ↔ lane `LlmInvoker`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 벤더 코드는 코어와 **같은 `ClaudeRequest`** 를 만든다(프롬프트·temperature·reasoning·모델
 * alias 전부). 여기서는 그것을 lane 의 `LlmInvokeRequest` 로 **손실 없이** 옮기기만 한다 —
 * 필드를 하나라도 떨어뜨리면 "코어와 같은 코드로 돌렸다"가 거짓이 된다.
 */
export function toLaneRequest(req: ClaudeRequest, log?: LaneLogger): LlmInvokeRequest {
  const laneTask = CORE_TASK_MAP[req.task];
  if (!laneTask) {
    throw new AnalysisContractError(`vendored code asked for an unknown task: ${req.task}`);
  }
  const userMessage = req.messages.find((m) => m.role === "user");
  if (!userMessage) {
    throw new AnalysisContractError(`vendored request for ${req.task} has no user message`);
  }
  // json_schema 는 **버리지 않는다.** 초판은 json_object 만 "json" 으로 접고 json_schema 객체를
  // 통째로 떨어뜨렸다: 그러면 코어가 스키마를 강제한 태스크(감성 V2)가 lane 에서만 스키마 없이
  // 돌고, 콜은 전부 200 이라 차이가 출력 품질로만 나타난다. 스키마 객체는 `jsonSchema` 로 그대로
  // 옮기고, 방언별 전송·강등 판단은 invoker 가 한다(`worker/invoker.ts` callPool).
  const wantsSchema = typeof req.responseFormat === "object" && req.responseFormat?.type === "json_schema";
  const rawSchema: unknown = wantsSchema ? (req.responseFormat as { json_schema?: unknown }).json_schema : undefined;
  const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  // `{type:"json_schema"}` 인데 보낼 수 있는 스키마가 없으면 response_format 을 **버리지 않는다.** 버리면
  // JSON 강제 자체가 사라지고 아무 흔적도 없다. json_object 로 강등하고 invoker 강등과 같은 이벤트를 남긴다.
  // reason 으로 모양을 구분한다(값은 싣지 않는다):
  //   json_schema_object_missing    : `json_schema` 가 없거나 객체가 아니다(null·문자열·배열)
  //   json_schema_schema_missing    : `json_schema` 는 객체인데 `schema` 키가 없다(`{}` · `{name}`)
  //   json_schema_schema_not_object : `schema` 가 객체가 아니거나 배열이다
  // 공급자는 이 셋을 400 으로 거부하거나(재시도 불가) 무시하므로, 보내는 것보다 강등이 낫다.
  let degradeReason: string | null = null;
  if (wantsSchema) {
    if (!isPlainObject(rawSchema)) degradeReason = "json_schema_object_missing";
    else if (!Object.hasOwn(rawSchema, "schema") || rawSchema.schema === undefined) degradeReason = "json_schema_schema_missing";
    else if (!isPlainObject(rawSchema.schema)) degradeReason = "json_schema_schema_not_object";
  }
  const jsonSchema =
    wantsSchema && degradeReason === null ? (rawSchema as unknown as NonNullable<LlmInvokeRequest["jsonSchema"]>) : undefined;
  if (degradeReason !== null) {
    log?.warn("analysis_lane.json_schema_degraded", {
      task: req.task,
      stage: "to_lane_request",
      reason: degradeReason,
      schemaName: isPlainObject(rawSchema) && typeof rawSchema.name === "string" ? rawSchema.name : null,
      appliedFormat: "json_object",
    });
  }
  const responseFormat =
    req.responseFormat === "json_object" ||
    (typeof req.responseFormat === "object" && req.responseFormat?.type === "json_object") ||
    wantsSchema
      ? ("json" as const)
      : undefined;
  return {
    task: laneTask,
    sourceTask: req.task,
    modelAlias: req.model,
    prompt: userMessage.content,
    ...(req.system === undefined ? {} : { systemPrompt: req.system }),
    ...(responseFormat ? { responseFormat } : {}),
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
    ...(req.maxTokens === undefined ? {} : { maxOutputTokens: req.maxTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.reasoning === undefined ? {} : { reasoning: req.reasoning }),
  };
}

/**
 * 코어 task 문자열 → lane task. **`worker/llm-pools.ts` `CORE_TASK_TO_LANE_TASK` 가 정본이고
 * 여기는 별칭이다 — 사본이 아니다.**
 *
 * ⚠️ 2026-09-15 WU6 에서 이것이 **사본**이라 물렸다. 같은 매핑이 두 군데 손으로 적혀 있었고,
 *    WU2 가 `llm-pools.ts` 쪽에만 stance 를 더했다. 기동 가드(`assertTaskModelParity`)도 풀
 *    배선도 전부 `llm-pools.ts` 목록을 모수로 쓰므로 거기만 보면 "배선 끝" 으로 보였다.
 *
 *    ⚠️ **실패 모드는 `output_contract` 가 아니다 — 그보다 나쁘다.** 초판 주석은 여기서 던지는
 *       `AnalysisContractError` 가 티켓을 영구 종결시킨다고 적었는데 **틀렸다**: 이 예외는
 *       invoker 안에서 나고, 벤더 `llm.ts` 의 태스크 함수 4개가 그것을 **catch 해서**
 *       `{ decisions: [], failed: true }` 로 접는다(`llm.ts` 스탠스 블록의 catch). 순수 계층도
 *       `deps.llm.stance` 호출을 try/catch 로 감싼다(`pure/analyze-turn.ts` stanceThrewMessage).
 *       그래서 실제로 남는 것은 **티켓 completed · 스탠스 0건 · 원장 0행의 조용한 결손**이다 —
 *       아무것도 실패로 보이지 않고, 켰는데 데이터가 안 쌓이는 것만 나중에 발견된다.
 *       그 성질이 이 사본을 특히 위험하게 만든다(시끄럽게 죽으면 배포 중에 잡힌다).
 *       근거: `tests/stance-engine.test.ts` 의 실패 격리 케이스가 그 경로를 그대로 재현한다.
 *
 *    그래서 사본을 지우고 **정본을 참조**한다. 다음에 태스크가 늘면 고칠 곳이 한 곳뿐이다.
 */
const CORE_TASK_MAP: Record<string, LlmInvokeRequest["task"]> = CORE_TASK_TO_LANE_TASK;

/**
 * lane invoker → 벤더 코드가 기대하는 `ClaudeResponse`.
 *
 * ⚠️ `costUsd` 가 **null(미계측)** 이면 벤더 코드에는 `0` 을 준다. 이유: `ClaudeResponse.costUsd`
 *    는 `number` 이고, 그 값이 가는 곳은 `extractionMetadata.analysis_llm_cost_usd`(합산 진단
 *    필드)뿐이다. **미계측의 정본은 lane 원장 `analysis_call_usage` 다** — 거기서만 null 이
 *    null 로 남는다(0003 의 NULL 규율). 코어로 나가는 `evidence.llmUsage[]` 는 코어 계약이
 *    nullable 을 받지 않아 `toReplyUsage` 가 0 으로 접는다(`contracts/v1.ts` 참조) — 즉
 *    "미계측인데 0 으로 보이는" 구간이 코어 `cost_ledger` 에 있다. 그 구분이 필요하면
 *    lane 원장(`v_analysis_ticket_cost.unmetered_calls`)을 봐야 한다.
 */
function toClaudeResponse(text: string, usage: AnalysisCallUsage, traceId: string | undefined, displayModelId: string | undefined): ClaudeResponse {
  return {
    text,
    tokenUsage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
    costUsd: usage.costUsd ?? 0,
    modelId: displayModelId ?? `${usage.poolKey}/${usage.modelId}`,
    traceId: traceId ?? "",
  };
}

/**
 * **원장 태스크만 갈아끼우는 래퍼**(PR-L1 에서 준비, 배선은 PR-L2).
 * 정본: `(내부 설계 문서)` §3.2.
 *
 * 왜 필요한가: 섀도 V2 호출의 벤더 요청 task 는 현행 V0 와 같은
 * `measurement.analysis.mention_semantics` 다(벤더 `llm.ts` 가 그렇게 보낸다 — **벤더는 한 바이트도
 * 안 고친다**). 그대로 두면 V0 감성 비용과 섀도 비용이 `analysis_call_usage` 에서 같은 행 종류로
 * 뭉개져 플랜 §5 수용 기준 6("`task='semantics_shadow'` 로 섀도 비용이 따로 집계된다")을 판정할
 * 수 없다. 그래서 **lane 쪽에서** 요청의 task 문자열만 바꿔 준다.
 *
 * ⚠️ **모델·풀은 바뀌지 않는다** — `worker/llm-pools.ts` 의 `TASK_ROUTING_ALIAS` 가 이 태스크의
 *    모델·풀 해석을 `mention_semantics` 로 되돌리기 때문이다. 즉 이 래퍼가 바꾸는 것은 **원장 축
 *    하나**이고, 같은 답변을 같은 모델·같은 풀로 다시 채점한다는 전제는 그대로 유지된다.
 *
 * ⚠️ **순수 함수다.** 입력 요청을 변형하지 않고 얕은 복사본을 넘긴다 — 같은 `ClaudeRequest` 객체가
 *    V0 경로와 공유될 수 있고, 제자리에서 고치면 V0 콜의 원장 태스크까지 오염된다.
 *
 * ⚠️ **PR-L1 에서는 아무도 부르지 않는다.** 벤더 타입에 `semanticsV2Shadow` seam 이 아직 없어
 *    배선할 자리가 없다(seam 은 코어 PR-C1 + 벤더 재동기 PR-L2). 미리 두는 이유는 stance 의 task
 *    매핑과 같다 — 배선이 붙는 PR 에서 "한 줄 빠뜨렸는데 조용히 뭉개진다" 를 막기 위해서다.
 */
export function withTaskOverride(
  invokeFn: (req: ClaudeRequest) => Promise<ClaudeResponse>,
  task: string,
): (req: ClaudeRequest) => Promise<ClaudeResponse> {
  return (req: ClaudeRequest): Promise<ClaudeResponse> => invokeFn({ ...req, task });
}

/** 벤더 코드가 부르는 invoker 3종(+ 인용 1종)을 lane invoker 위에 세운다. */
export function buildVendorInvoker(input: AnalysisEngineInput): (req: ClaudeRequest) => Promise<ClaudeResponse> {
  return async (req: ClaudeRequest): Promise<ClaudeResponse> => {
    const out = await input.llm(toLaneRequest(req, input.log), input.signal);
    return toClaudeResponse(out.text, out.usage, out.traceId, out.displayModelId);
  };
}

/** `analyzeTurnPure` 의 `deps.llm`: 벤더 `llm.ts` 5함수에 invoker 를 주입한 것. */
export function buildPureLlmDeps(input: AnalysisEngineInput): AnalysisLlmDeps {
  const invokeFn = buildVendorInvoker(input);
  return {
    extract: (i) => extractMentionsWithLlm({ ...i, invokeFn }),
    resolve: (i) => resolvePendingMentionsWithLlm({ ...i, invokeFn }),
    semantics: (i) => classifyMentionSemanticsWithLlm({ ...i, invokeFn }),
    // 답변 단위 브랜드 스탠스 (WU6).
    //
    // ⚠️ **여기서 게이트를 보지 않는다 — 주입은 무조건, 판단은 순수 계층이 한다.**
    //    벤더 `analyze-turn.ts` 가 `options.enableLlmAnswerBrandStance && deps.llm.stance &&
    //    quality === "valid_answer" && mentions.length > 0` 을 이미 본다. lane 이 여기서
    //    옵션을 한 번 더 보면 게이트가 **두 곳**이 되고, 코어가 조건을 바꿀 때 lane 만 낡는다
    //    (그 드리프트는 "안 도는데 아무도 모른다" 로 나타난다 — 실패가 아니라 결손이다).
    //    주입만 하고 호출 여부는 핀된 코어 코드가 정한다 = 인라인 경로와 같은 조건.
    //
    //    task 문자열은 벤더 `llm.ts` 가 `measurement.analysis.answer_brand_stance` 로 보내고,
    //    모델은 `worker/llm-pools.ts` 의 env 표(`LLM_TASK_MODEL_…answer_brand_stance`)가 정한다.
    stance: (i) => classifyAnswerBrandStanceWithLlm({ ...i, invokeFn }),
    // 감성 판별 V2 (코어 #710, change mention-semantics-v2).
    //
    // ⚠️ 이 줄이 없으면 옵션이 켜져도 V2 는 **돌지 않는다.** 벤더 `analyze-turn.ts` 는
    //    `deps.llm.semanticsV2 === undefined` 이면 현행 semantics 패스로 돌고
    //    `measurement_analysis.semantics_v2.seam_missing` 경고만 남긴다(데이터는 쌓이지만 V2 가 아니다).
    //    stance 와 같은 원칙으로 주입은 무조건, 호출 여부는 순수 계층의 게이트가 정한다.
    //    task 문자열은 현행 semantics 와 같은 `measurement.analysis.mention_semantics` 라 풀·모델
    //    배선(`LLM_TASK_MODEL_…mention_semantics`)을 그대로 탄다.
    semanticsV2: (i) => classifyMentionSemanticsV2({ ...i, invokeFn }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 인용 도메인 분류 — lane 몫은 ②뿐 (스펙 §5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ① 미분류 호스트 선별과 ③ `ON CONFLICT DO NOTHING` 적재는 **코어**다. lane 은 분류만 한다:
 * `DOMAIN_CATEGORY_TABLE` 우선, 미스만 LLM. bounded 병렬 4(P3 §3.2 흡수) — 직렬로 돌면
 * 호스트 수만큼 LLM 지연이 턴 지연에 더해진다.
 *
 * ⚠️ **여기서 던지지 않는다.** `resolveCitationDomain` 은 실패해도 `method:"default"` + `Other` 를
 *    돌려주도록 벤더 코드가 이미 설계돼 있다 — 인용 분류 하나 때문에 턴 분석을 버리지 않기 위해서다.
 *    계약의 `method` 어휘에 `"default"` 가 들어 있는 이유가 그것이다.
 */
export async function classifyCitationHosts(
  hosts: string[],
  invokeFn: (req: ClaudeRequest) => Promise<ClaudeResponse>,
  concurrency: number,
  signal: AbortSignal,
): Promise<CitationClassification[]> {
  if (hosts.length === 0) return [];
  const unique = [...new Set(hosts)];
  const out = new Array<CitationClassification | null>(unique.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= unique.length) return;
      signal.throwIfAborted();
      const host = unique[i]!;
      const r = await resolveCitationDomain(host, invokeFn);
      out[i] = {
        host: r.host,
        category: r.category,
        subcategory: r.subcategory,
        method: r.method,
        modelSlug: r.modelSlug ?? null,
      };
    }
  });
  await Promise.all(workers);
  return out.filter((r): r is CitationClassification => r !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 엔진
// ─────────────────────────────────────────────────────────────────────────────

export interface CoreEngineOptions {
  /** `@scope/analysis-core` 자리 — 지금은 핀한 코어 SHA. reply `evidence.runtime.laneRevision`. */
  revision: string;
  citationConcurrency?: number;
  /**
   * 테스트가 **순수 코드의 LLM seam 을 직접 잡는** 자리. 코어 동치성 테스트
   * (`analyze-turn.equivalence.test.ts`)가 붙는 지점과 **같은 seam** 이라, 여기 스텁을 주면
   * 코어와 완전히 같은 입력으로 돌릴 수 있다 → 골든 13개가 "바이트 동일"을 판정할 수 있다.
   * ⚠️ 라이브에서는 절대 설정되지 않는다(`registry.ts` 가 넘기지 않는다).
   */
  llmDepsOverride?: (input: AnalysisEngineInput) => AnalysisLlmDeps;
}

/**
 * **순수 산출물을 그대로 돌려주는 경로.** 골든 게이트(`tests/golden-analysis-core.test.ts`)가
 * 여기 붙는다 — 코어 `analyze-turn.equivalence.test.ts` 가 단언하는 것과 **같은 객체**
 * (`analysisForPersist`)를 얻어야 "바이트 동일"을 말할 수 있기 때문이다. 계약 변환
 * (`toResultTurn`)은 키를 3개 더하므로 그 뒤에서 비교하면 바이트가 이미 달라져 있다.
 *
 * 반환하는 `llmUsage` 는 **콜 1회당 1행**이다 — lane invoker 가 재시도·풀 전환까지 각각
 * 행으로 내고 여기서 순서대로 모은다.
 */
export async function runCoreTurnPure(
  input: AnalysisEngineInput,
  llmDepsOverride?: (input: AnalysisEngineInput) => AnalysisLlmDeps,
  /** 호출부가 원장을 소유하고 싶을 때. 예외 경로에서도 그때까지의 행을 붙잡기 위한 것이다. */
  sink: AnalysisCallUsage[] = [],
): Promise<{
  analysis: Awaited<ReturnType<typeof analyzeTurnPure>>["analysis"];
  // ⚠️ **`analysis` 안이 아니라 payload 형제 키다**(벤더 `analyze-turn.ts` 말미
  //    `return { analysis: analysisOut, usage, answerStances }`). 골든 13개가 `analysis` 의
  //    바이트 동일을 요구하므로 코어가 일부러 밖에 뒀다 — 안으로 접으면 골든이 깨진다.
  answerStances: Awaited<ReturnType<typeof analyzeTurnPure>>["answerStances"];
  llmUsage: AnalysisCallUsage[];
  invoke: (req: ClaudeRequest) => Promise<ClaudeResponse>;
}> {
  const llmUsage = sink;
  const context = buildTurnContext(input);
  const turnInput = buildTurnInput(input);

  const collecting: AnalysisEngineInput = {
    ...input,
    llm: async (req, signal) => {
      try {
        const out = await input.llm(req, signal);
        // 재시도·페일오버로 버린 콜까지 전부. `usage` 하나만 올리면 **성공한 마지막 콜만**
        // 장부에 남아 낭비 비용이 사라진다(0003 의 `wasted_cost_usd` 가 계산 불가가 된다).
        llmUsage.push(...(out.usageRows ?? [out.usage]));
        return out;
      } catch (e) {
        // ⚠️ 벤더 `llm.ts` 는 invoker 예외를 **잡아서** `failed: true` 결과로 바꾼다 — 즉 티켓은
        //    대개 completed 로 끝난다. 여기서 행을 안 거두면 실패한 콜의 실비가 통째로 증발한다.
        llmUsage.push(...usageRowsFromError(e));
        throw e;
      }
    },
  };
  const llmDeps = llmDepsOverride ? llmDepsOverride(input) : buildPureLlmDeps(collecting);

  const { analysis, answerStances } = await analyzeTurnPure(turnInput, context, {
    llm: llmDeps,
    // 로거는 **래핑하지 않는다** — 이벤트 이름·필드는 운영 대시보드·알람의 계약이다
    // (코어 추출 리팩터 플랜 §5 R-4).
    log: input.log,
  });
  return { analysis, answerStances, llmUsage, invoke: buildVendorInvoker(collecting) };
}

export function createCoreAnalysisEngine(opts: CoreEngineOptions): AnalysisEngine {
  const citationConcurrency = opts.citationConcurrency ?? 4;
  return {
    revision: opts.revision,
    kind: "core",
    async analyzeTurn(input: AnalysisEngineInput): Promise<AnalysisEngineOutput> {
      input.signal.throwIfAborted();

      // 원장을 **엔진이 소유한다** — 실패 경로에서도 그때까지 나간 콜의 실비를 붙잡아야 하기
      // 때문이다. 워커는 `error.llmUsage` 를 읽어 적재한다(`worker/main.ts` `usageFromError`).
      const llmUsage: AnalysisCallUsage[] = [];
      try {
        const { analysis, answerStances, invoke } = await runCoreTurnPure(input, opts.llmDepsOverride, llmUsage);

        const citationClassifications = await classifyCitationHosts(
          input.ticket.citationHostsToClassify,
          invoke,
          citationConcurrency,
          input.signal,
        );

        return {
          turn: toResultTurn(input.ticket.turn.turnRunId, analysis, answerStances),
          citationClassifications,
          llmUsage,
          // 지금은 턴 내 병렬이 인용 분류뿐이다(P3-A 는 범위 밖). 거짓 true 를 내지 않는다.
          parallelFlags: { citationParallel: citationClassifications.length > 1 },
        };
      } catch (e) {
        // ⚠️ **이미 나간 콜은 되돌아오지 않는다.** 안 붙이면 "실패한 턴은 공짜" 라는 잘못된
        //    그림이 되고, `v_analysis_ticket_cost.wasted_cost_usd` 가 그만큼 과소가 된다.
        //    필드명 `llmUsage` 는 워커가 읽는 이름이다 — 바꾸면 조용히 0행이 된다.
        if (e !== null && typeof e === "object" && llmUsage.length > 0) {
          (e as { llmUsage?: AnalysisCallUsage[] }).llmUsage = [...llmUsage];
        }
        throw e;
      }
    },
  };
}

/**
 * 순수 산출물 → 계약의 `result.turn`.
 *
 * ⚠️ **필드를 재계산하거나 덧붙이지 않는다.** 여기서 하는 일은 `modelSlug: undefined → null`
 *    하나뿐이다(JSON 경계에서 `undefined` 는 사라지므로 계약이 null 로 받는다). 다른 값에
 *    손을 대는 순간 "lane 경로와 인라인 경로의 차이는 직렬화뿐"이라는 전제가 깨진다.
 */
export function toResultTurn(
  // ⚠️ `turnRunId` 는 순수 산출물에 **없다** — `analysisForPersist` 는 턴 좌표를 들고 있지
  //    않다(코어에서는 호출부의 `turn` 행이 그 좌표를 쥔다). 티켓에서 그대로 가져온다.
  //    지어내거나 추론하면 결과가 엉뚱한 턴에 붙는다.
  turnRunId: string,
  analysis: Awaited<ReturnType<typeof analyzeTurnPure>>["analysis"],
  // ⚠️ **`analysis` 밖에서 따로 받는다** — 순수 payload 의 형제 키이기 때문이다(위 주석).
  //    기본값을 두는 이유는 스텁·테스트 호출부가 스탠스를 모르기 때문이고, 그 기본값이
  //    "스탠스 없음" = 빈 배열이라 계약의 `.default([])` 와 같은 값이다.
  answerStances: Awaited<ReturnType<typeof analyzeTurnPure>>["answerStances"] = [],
): AnalysisResultTurn {
  return {
    turnRunId,
    quality: analysis.quality,
    mentions: analysis.mentions,
    candidates: analysis.candidates,
    // 답변 단위 브랜드 스탠스 (WU6). **재계산·가공 없이 그대로 싣는다** — 순수 계층이
    // 이미 브랜드 매칭·증거 검증(`verifyEvidence`)·오프셋 정규화를 끝낸 값이다.
    // 게이트가 꺼졌거나 대상 브랜드가 0이면 순수 계층이 `[]` 를 돌려주므로 여기서
    // 분기하지 않는다(= 인라인 경로와 같은 값).
    answerStances,
    // ⚠️ 순수 산출물의 버전 4종(`analysisVersion`·`promptVersion`·`parserVersion`·
    //    `resolverVersion`)은 **싣지 않는다** — 코어 정본 `AnalysisReplyTurnSchema` 가
    //    그 넷을 빼고 `.strict()` 라, 실으면 reply 파싱이 통째로 튕긴다. persist 는 코어가
    //    자기 `options` 값을 쓴다(`store.ts:1139~1143`). 계약 주석 참조.
    modelSlug: analysis.modelSlug ?? null,
    extractionMetadata: analysis.extractionMetadata,
    sourceTurnHash: analysis.sourceTurnHash,
    failed: false,
    failureDetail: null,
  };
}
