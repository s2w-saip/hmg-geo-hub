// `analyzeTurnPure` 동치성 픽스처 — A~F 6축 × (astral 유/무) 12 + 품질 게이트(G) 1
// = **13케이스**.
//
// 왜 astral 이 별 축이 아니라 **A~F 전 축의 곱**인가: `offsets.test.ts:20~21` 의 실측
// — *"astral 없는 답변 일치율 100.0% vs 있는 답변 73.6%"*. #633 이 고친 결함이
// 정확히 그 분포였다. 접두사 `🚗` 하나만 붙어도 UTF-16 오프셋과
// `mentionsReferToSameSurface` 의 기준이 갈린다.
//
// LLM 은 전부 **결정적 스텁**이다(녹화 불필요 — 순수 구간에 비결정 원천이 0건).
// 스텁이 `startChar`/`endChar` 를 대부분 비워 두는 것은 의도적이다: 비우면
// `resolveLlmMentionSpan`(pure/surface-identity.ts)의 `indexOf` 폴백을 타므로
// astral 변형에서 오프셋이 실제로 갈린다.
//
// G 는 astral 을 곱하지 않는다 — 산출이 멘션 0건이라 오프셋이 갈릴 표면이 없다.
// 대신 그 축이 덮는 것은 `qualityState !== "valid_answer"` 로 닫히는 분기 넷이다
// (`axisG` 주석 참고).
import { EMPTY_GROUPING } from "@/lib/brand-grouping/types";
import type {
  MentionExtractionResult,
  MentionSemanticsResult,
  PendingMentionResolutionResult,
} from "../llm";
import { AnalysisOptionsSchema, type OntologyCatalogEntity } from "../schema";
import type { TrackedBrandAugmentTarget } from "../tracked-brand-augment";
import type {
  AnalysisTurnContext,
  AnalysisTurnInput,
  AnalysisTurnInputWithRaw,
} from "./analyze-turn";
import type { AnalysisLlmDeps } from "./deps";

export const EMOJI = "🚗";

const HYUNDAI = "00000000-0000-0000-0000-000000000101";
const KIA = "00000000-0000-0000-0000-000000000102";
const TUCSON = "00000000-0000-0000-0000-000000000201";
const SPORTAGE = "00000000-0000-0000-0000-000000000202";
const INDUSTRY = "00000000-0000-0000-0000-0000000000f1";

const CATALOG: OntologyCatalogEntity[] = [
  {
    id: HYUNDAI,
    type: "Brand",
    canonicalName: "Hyundai",
    aliases: [
      { alias: "현대", language: "ko" },
      { alias: "Hyundai Motor", language: "en" },
    ],
  },
  {
    id: KIA,
    type: "Brand",
    canonicalName: "Kia",
    aliases: [{ alias: "기아", language: "ko" }],
  },
  {
    id: TUCSON,
    type: "Product",
    canonicalName: "Hyundai Tucson",
    aliases: [
      { alias: "투싼", language: "ko" },
      { alias: "현대 투싼", language: "ko" },
      { alias: "Hyundai Tucson", language: "en" },
    ],
  },
  {
    id: SPORTAGE,
    type: "Product",
    canonicalName: "Kia Sportage",
    aliases: [
      { alias: "스포티지", language: "ko" },
      { alias: "Kia Sportage", language: "en" },
    ],
  },
];

const RELS = [
  { fromId: TUCSON, type: "MADE_BY", toId: HYUNDAI },
  { fromId: SPORTAGE, type: "MADE_BY", toId: KIA },
];

const TRACKED: TrackedBrandAugmentTarget[] = [
  {
    brandKey: "Kia",
    representativeEntityId: KIA,
    representativeCanonical: "Kia",
    entityType: "Brand",
    entityIds: [KIA],
    // "오토큐" 는 **카탈로그 alias 가 아니다** — tracked_brands 설정에서만 온 표면이다.
    // 결정적 매칭이 못 잡으므로 augment 가 실제로 발화한다(억제가 아니라 추가 경로).
    surfaces: ["Kia", "기아", "오토큐"],
  },
];

const INDUSTRY_CTX = {
  ids: [INDUSTRY],
  name: "Automotive",
  source: "project" as const,
};

function options(over: Record<string, unknown> = {}) {
  return AnalysisOptionsSchema.parse(over);
}

function context(over: Partial<AnalysisTurnContext> = {}): AnalysisTurnContext {
  return {
    catalog: CATALOG,
    rels: RELS,
    grouping: EMPTY_GROUPING,
    trackedAugmentTargets: [],
    industry: INDUSTRY_CTX,
    options: options(),
    ...over,
  };
}

function turnInput(
  answerText: string,
  over: Partial<AnalysisTurnInputWithRaw> = {},
): AnalysisTurnInputWithRaw {
  return {
    turnRunId: "11111111-1111-1111-1111-111111111111",
    turnIndex: 1,
    promptText: "5천만 원 이하 안전한 SUV 추천해줘",
    answerText,
    rawResponse: null,
    trace: {
      queryRunId: "22222222-2222-2222-2222-222222222222",
      promptRunId: "33333333-3333-3333-3333-333333333333",
      target: "chatgpt",
      region: "KR",
    },
    ...over,
  };
}

const EMPTY_EXTRACTION: MentionExtractionResult = {
  mentions: [],
  parserPartial: false,
  malformedCount: 0,
  warnings: [],
  costUsd: 0,
  attempts: 1,
  modelSlug: "stub-extract",
  traceId: "trace-extract",
};

/** 호출되면 실패한다 — "이 축에서는 그 LLM 이 안 돈다"를 테스트로 못박는다. */
const never = (task: string) => async (): Promise<never> => {
  throw new Error(`[fixture] ${task} 는 이 케이스에서 호출되면 안 된다`);
};

export interface PureEquivalenceCase {
  name: string;
  input: AnalysisTurnInput;
  context: AnalysisTurnContext;
  llm: AnalysisLlmDeps;
}

// ── 축별 본문 ──────────────────────────────────────────────────────────────
// 각 축은 `prefix`(astral 유/무)를 받아 같은 구조의 케이스를 만든다.

function axisA(prefix: string): PureEquivalenceCase {
  // A. 결정적만 — extract off. analyzeMeasurementTurn → 제외컨텍스트 필터 → 오프셋 확정.
  //    셋째 문장의 "Hyundai Motor" 는 결정적으로 매칭되지만 "무관" 큐 때문에
  //    `filterExcludedContextMentions` 가 걷어낸다(= extract.excluded_context_filtered).
  return {
    name: "a-deterministic-only",
    input: turnInput(
      `${prefix}1. 현대 투싼 - 안전 사양과 유지비 균형이 좋아 추천합니다.\n2. Kia Sportage 도 비교해볼 수 있습니다. 두 차종 모두 안전 등급이 우수합니다.\n참고로 Hyundai Motor 는 이번 SUV 비교와 무관하므로 제외합니다.`,
    ),
    context: context({ options: options({ enableLlmMentionExtraction: false }) }),
    llm: {
      extract: never("extract"),
      resolve: never("resolve"),
      semantics: never("semantics"),
    },
  };
}

function axisB(prefix: string): PureEquivalenceCase {
  // B. extract + 병합 + 짧은 alias 게이트. "기아"(2자)는 LLM 이 짚어줬으므로 살고,
  //    결정적으로만 잡힌 짧은 표면은 게이트에 걸린다.
  const answerText = `${prefix}현대 투싼과 기아 스포티지를 비교하면, 최종 추천은 현대 투싼입니다.`;
  return {
    name: "b-extract-merge",
    input: turnInput(answerText),
    context: context({
      options: options({
        enableLlmMentionExtraction: true,
        enableShortAliasLlmGate: true,
      }),
    }),
    llm: {
      extract: async (): Promise<MentionExtractionResult> => ({
        ...EMPTY_EXTRACTION,
        mentions: [
          {
            surfaceText: "현대 투싼",
            entityType: "Product",
            mentionRole: "single_choice",
            assertion: "final_choice",
            sentiment: "positive",
            rank: 1,
            descriptors: ["안전"],
            criteria: ["safety"],
          },
          {
            surfaceText: "기아 스포티지",
            entityType: "Product",
            mentionRole: "comparison_target",
            assertion: "compare",
            sentiment: "neutral",
            rank: 2,
            descriptors: [],
            criteria: [],
          },
        ],
        genericFinalChoice: undefined,
      }),
      resolve: never("resolve"),
      semantics: never("semantics"),
    },
  };
}

function axisC(prefix: string): PureEquivalenceCase {
  // C. resolve 3분기 — resolve_existing / ignore_non_metric / keep_pending.
  const answerText =
    `${prefix}투싼 하이브리드가 가장 낫고, 스포티지 하이브리드도 좋습니다. ` +
    `자동차10년타기시민연합 자료도 참고하세요. 알 수 없는 신형 XQ7 은 판단 보류입니다.`;
  return {
    name: "c-resolver-branches",
    input: turnInput(answerText),
    context: context({
      options: options({
        enableLlmMentionExtraction: true,
        enableLlmPendingResolver: true,
      }),
    }),
    llm: {
      extract: async (): Promise<MentionExtractionResult> => ({
        ...EMPTY_EXTRACTION,
        mentions: [
          {
            surfaceText: "투싼 하이브리드",
            entityType: "Product",
            mentionRole: "single_choice",
            assertion: "recommend",
            sentiment: "positive",
            descriptors: [],
            criteria: [],
          },
          {
            surfaceText: "자동차10년타기시민연합",
            entityType: "Brand",
            mentionRole: "background",
            assertion: "mention_only",
            sentiment: "neutral",
            descriptors: [],
            criteria: [],
          },
          {
            surfaceText: "신형 XQ7",
            entityType: "Product",
            mentionRole: "comparison_target",
            assertion: "compare",
            sentiment: "neutral",
            descriptors: [],
            criteria: [],
          },
        ],
      }),
      resolve: async (): Promise<PendingMentionResolutionResult> => ({
        decisions: [
          {
            index: 0,
            surfaceText: "투싼 하이브리드",
            action: "resolve_existing",
            existingEntityId: TUCSON,
            canonicalName: "Hyundai Tucson",
            confidence: 0.92,
            reason: "투싼 트림 표기",
          },
          {
            index: 1,
            surfaceText: "자동차10년타기시민연합",
            action: "ignore_non_metric",
            reason: "시민단체 — 지표 대상 아님",
          },
          {
            index: 2,
            surfaceText: "신형 XQ7",
            action: "keep_pending",
            reason: "카탈로그에 없는 신규 후보",
          },
        ],
        parserPartial: false,
        malformedCount: 0,
        warnings: [],
        costUsd: 0,
        attempts: 1,
        modelSlug: "stub-resolve",
        traceId: "trace-resolve",
      }),
      semantics: never("semantics"),
    },
  };
}

function axisD(prefix: string): PureEquivalenceCase {
  // D. tracked augment — 답변에 tracked 표면("오토큐")이 있는데 추출·결정적 매칭
  //    둘 다 못 짚었다 → 보수적 멘션 1건이 추가된다. coveredEntityIds 는
  //    `resolveRollups` 경유라, 이미 롤업으로 덮인 브랜드는 중복 추가되지 않는다.
  const answerText = `${prefix}현대 투싼을 추천합니다. 오토큐 서비스망도 참고하세요.`;
  return {
    name: "d-tracked-augment",
    input: turnInput(answerText),
    context: context({
      trackedAugmentTargets: TRACKED,
      options: options({
        enableLlmMentionExtraction: true,
        enableTrackedBrandAugment: true,
      }),
    }),
    llm: {
      extract: async (): Promise<MentionExtractionResult> => ({
        ...EMPTY_EXTRACTION,
        mentions: [
          {
            surfaceText: "현대 투싼",
            entityType: "Product",
            mentionRole: "single_choice",
            assertion: "recommend",
            sentiment: "positive",
            descriptors: [],
            criteria: [],
          },
        ],
      }),
      resolve: never("resolve"),
      semantics: never("semantics"),
    },
  };
}

function axisE(prefix: string): PureEquivalenceCase {
  // E. semantics 병합 — byIndex 로 sentiment 를 덮고 llm_mention_type 을 스태시한다.
  const answerText = `${prefix}현대 투싼은 만족스럽지만 Kia Sportage 는 아쉽습니다.`;
  return {
    name: "e-semantics-merge",
    input: turnInput(answerText),
    context: context({
      options: options({
        enableLlmMentionExtraction: true,
        enableLlmMentionSemantics: true,
      }),
    }),
    llm: {
      extract: async (): Promise<MentionExtractionResult> => ({
        ...EMPTY_EXTRACTION,
        mentions: [
          {
            surfaceText: "현대 투싼",
            entityType: "Product",
            mentionRole: "single_choice",
            assertion: "recommend",
            sentiment: "neutral",
            descriptors: [],
            criteria: [],
          },
          {
            surfaceText: "Kia Sportage",
            entityType: "Product",
            mentionRole: "comparison_target",
            assertion: "compare",
            sentiment: "neutral",
            descriptors: [],
            criteria: [],
          },
        ],
      }),
      resolve: never("resolve"),
      semantics: async (): Promise<MentionSemanticsResult> => ({
        decisions: [
          { index: 0, sentiment: "positive", mentionType: "recommend" },
          { index: 1, sentiment: "negative", mentionType: "reject" },
        ],
        parserPartial: false,
        malformedCount: 0,
        warnings: [],
        costUsd: 0,
        attempts: 1,
        modelSlug: "stub-semantics",
        traceId: "trace-semantics",
      }),
    },
  };
}

function axisF(prefix: string): PureEquivalenceCase {
  // F. 실패 경로 — extract failed+parserPartial / resolve failed / semantics 미채점.
  //    세 실패가 `extractionMetadata` 의 합산 필드에 어떻게 접히는지가 요점이다.
  const answerText = `${prefix}현대 투싼과 Kia Sportage 를 비교해 드립니다.`;
  return {
    name: "f-failure-paths",
    input: turnInput(answerText),
    context: context({
      options: options({
        enableLlmMentionExtraction: true,
        enableLlmPendingResolver: true,
        enableLlmMentionSemantics: true,
      }),
    }),
    llm: {
      extract: async (): Promise<MentionExtractionResult> => ({
        mentions: [
          {
            surfaceText: "미지의 표면 ZZ9",
            entityType: "Product",
            mentionRole: "comparison_target",
            assertion: "compare",
            sentiment: "neutral",
            descriptors: [],
            criteria: [],
          },
        ],
        parserPartial: true,
        malformedCount: 2,
        warnings: ["schema_violation"],
        costUsd: 0,
        attempts: 2,
        modelSlug: "stub-extract",
        traceId: "trace-extract",
        failed: true,
        errorMessage: "malformed json envelope",
        droppedEntries: 1,
        lastResponseExcerpt: "{ mentions: [",
      }),
      resolve: async (): Promise<PendingMentionResolutionResult> => ({
        decisions: [],
        parserPartial: true,
        malformedCount: 1,
        warnings: ["resolver_timeout"],
        costUsd: 0,
        attempts: 2,
        modelSlug: "stub-resolve",
        traceId: "trace-resolve",
        failed: true,
        errorMessage: "resolver failed",
      }),
      semantics: async (): Promise<MentionSemanticsResult> => ({
        // 멘션 수보다 적은 decisions → unscored 진단 경로.
        decisions: [{ index: 0, sentiment: "mixed", mentionType: "compare" }],
        parserPartial: true,
        malformedCount: 1,
        warnings: [],
        costUsd: 0,
        attempts: 2,
        modelSlug: "stub-semantics",
        traceId: "trace-semantics",
        failed: false,
        droppedEntries: 2,
        lastResponseExcerpt: "[{\"index\":0",
      }),
    },
  };
}

function axisG(): PureEquivalenceCase {
  // G. 품질 게이트 — refusal 답변 × **LLM 4종 전부 on**.
  //
  // A~F 는 전부 `quality.qualityState === "valid_answer"` 다. 그런데 이 함수의
  // 분기 중 넷(extract·resolver·tracked augment·semantics)이 옵션 플래그가 아니라
  // **품질 상태**로 닫힌다. 그 닫힘은 지금까지 한 케이스도 안 태웠다 — 즉
  // 리팩터가 그 조건 하나를 떨어뜨려도 12케이스는 전부 초록이었다.
  //
  // 답변에 카탈로그 표면("현대 투싼")과 tracked 설정 표면("오토큐")을 **일부러**
  // 심어 둔다. 품질 게이트가 살아 있으면 `analyzeMeasurementTurn` 이 매칭 전에
  // early-return 하므로 멘션 0건이어야 하고, 게이트가 죽으면 그 표면들이 즉시
  // 산출에 나타나 스냅샷이 깨진다. LLM 3종은 `never` 스텁이라 한 번이라도
  // 호출되면 throw 한다.
  //
  // astral 변형을 만들지 않는 이유: astral 축의 대상은 **오프셋 기준**인데
  // 이 케이스의 멘션은 0건이다 — 오프셋이 갈릴 표면 자체가 없다. 그래서 이
  // 축만 곱하지 않고 1케이스다(전체 13).
  return {
    name: "g-invalid-quality",
    input: turnInput(
      "죄송하지만 특정 차종에 대한 추천은 제공할 수 없습니다. 현대 투싼·오토큐 문의는 공식 채널을 이용해 주세요.",
    ),
    context: context({
      trackedAugmentTargets: TRACKED,
      options: options({
        enableLlmMentionExtraction: true,
        enableLlmPendingResolver: true,
        enableLlmMentionSemantics: true,
        enableTrackedBrandAugment: true,
        enableShortAliasLlmGate: true,
      }),
    }),
    llm: {
      extract: never("extract"),
      resolve: never("resolve"),
      semantics: never("semantics"),
    },
  };
}

const AXES = [axisA, axisB, axisC, axisD, axisE, axisF];

/** 6축 × astral 유/무 = 12 + 품질 게이트 1 = 13케이스. 이름은 스냅샷 파일명이 된다. */
export function loadPureEquivalenceCases(): PureEquivalenceCase[] {
  const out: PureEquivalenceCase[] = [];
  for (const axis of AXES) {
    for (const [suffix, prefix] of [["", ""], ["-astral", `${EMOJI} `]] as const) {
      const c = axis(prefix);
      out.push({ ...c, name: `${c.name}${suffix}` });
    }
  }
  out.push(axisG());
  return out;
}

/** 키 순서를 고정해 직렬화한다 — 스냅샷 대조는 바이트 비교다. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

/** 로그는 산출물에 영향을 주지 않는다 — 픽스처 실행에서는 삼킨다. */
export const noopLogger = {
  info: () => {},
  warn: () => {},
};
