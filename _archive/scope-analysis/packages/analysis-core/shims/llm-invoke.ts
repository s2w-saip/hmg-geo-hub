// `@/lib/llm/invoke` 의 **타입 전용 shim**.
//
// 벤더된 `llm.ts:6`·`citation-classify.ts:11` 이 `import type { ClaudeRequest, ClaudeResponse }`
// 로만 이 경로를 참조한다 — 값 import 는 0건이다(그게 코어 PR-D 가 한 일이고, 값이면
// `lib/llm/cost.ts` → `@/lib/db` 가 따라 들어와 lane 의 G3 경계가 깨진다).
//
// 그래서 lane 은 **코어 `lib/llm/invoke.ts` 를 벤더하지 않는다.** 그 파일은 Bedrock SDK·
// cost_ledger 쓰기·env 스키마를 값으로 들고 있어 lane 이 돌릴 물건이 아니다. 필요한 것은
// 타입 두 개뿐이고, 그 두 타입을 여기 **코어 정의와 구조 동일**하게 다시 선언한다.
//
// ⚠️ 이 파일은 벤더가 아니라 **lane 소유**다(핀 대상 아님). 코어의 `ClaudeRequest` 가 바뀌면
//    벤더 재동기 때 typecheck 가 먼저 깨진다 — 그게 이 shim 의 드리프트 알람이다.
//    필드를 **빼지 마라**: 빠진 필드는 타입 에러가 아니라 `exactOptionalPropertyTypes` 가
//    없는 한 조용히 통과하고, 그러면 벤더 코드가 보낸 `temperature: 0` 이 invoker 에서
//    사라져도 아무도 모른다(분석 4태스크 전부 temperature 0 이다 — 스펙 §6.3).

/** 코어 `lib/llm/invoke.ts:27`. legacy alias 또는 provider-prefixed 문자열. */
export type LlmModel = "haiku" | "sonnet" | "cohere-embed" | (string & {});

/** 코어 `lib/llm/openrouter.ts:25~37` 의 `response_format` 과 같은 모양. */
export type ChatResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: { name: string; strict?: boolean; schema: unknown };
    };

/** 코어 `lib/llm/invoke.ts:284~311` 과 구조 동일. */
export interface ClaudeRequest {
  task: string;
  model: LlmModel;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "json_object" | ChatResponseFormat;
  reasoning?: {
    effort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    max_tokens?: number;
    exclude?: boolean;
    enabled?: boolean;
  };
  grounding?: { web?: boolean; webMaxResults?: number; webEngine?: "exa" | "native" };
  costMetadata?: Record<string, unknown>;
}

/** 코어 `lib/llm/invoke.ts:313~324` 와 구조 동일. */
export interface ClaudeResponse {
  text: string;
  tokenUsage: { input: number; output: number };
  costUsd: number;
  /** displayId. lane 에서는 `<poolKey>/<vendor>/<model>` (스펙 §8.5). */
  modelId: string;
  traceId: string;
  webCitations?: string[];
}
