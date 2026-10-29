// 스키마 없는 요청의 **최종 fetch 바디 원문 바이트** 골든.
//
// 왜 필요한가: json_schema 전달(감성 V2 수용)은 `callPool` 의 바디 조립을 건드렸다. 기존 테스트는
// 필드 값을 `deepEqual` 로만 비교해서 **키 순서만 바뀐 바디**를 통과시킨다. 공급자 캐시 접두와
// 요청 서명은 바이트 단위라, "스키마가 없으면 바디가 이전과 같다" 는 값 비교가 아니라 원문 문자열로
// 고정해야 참이다.
//
// 골든은 origin/main b380b72(수용 PR 이전)의 invoker 로 생성했고, 현 코드에서도 같은 문자열이 나온다.
// 캐시 무효화 uuid 는 콜마다 무작위라 `<uuid>` 로 정규화한다(그 외 바이트는 전부 그대로 비교).
//
// 갱신이 정말 필요하면 `REQUEST_BODY_GOLDEN_PRINT=1 node --import tsx --test tests/request-body-golden.test.ts`
// 로 실제 값을 출력해 **바뀐 이유를 커밋 메시지에 적고** 교체한다.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { CacheBustConfig } from "../worker/cache-bust.ts";
import type { LaneLogger, LlmInvokeRequest } from "../worker/engine.ts";
import { createPoolInvoker } from "../worker/invoker.ts";
import { PoolHealth, loadPools } from "../worker/llm-pools.ts";

const quietLog: LaneLogger = { info: () => {}, warn: () => {}, error: () => {} };

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "LLM_TASK_MODEL_measurement_analysis_mention_semantics",
  "LLM_TASK_POOLS_measurement_analysis_mention_semantics",
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function request(withJson: boolean): LlmInvokeRequest {
  return {
    task: "semantics",
    sourceTask: "measurement.analysis.mention_semantics",
    modelAlias: "haiku",
    prompt: '{"mentions":[{"index":0,"surface_text":"현대"}]}',
    systemPrompt: "score sentiment",
    ...(withJson ? { responseFormat: "json" as const } : {}),
    maxOutputTokens: 4000,
    temperature: 0,
    reasoning: { max_tokens: 256, exclude: true },
  };
}

async function rawBody(pool: string, model: string, withJson: boolean, cacheBust: CacheBustConfig): Promise<string> {
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.OPENAI_API_KEY = "test-oa";
  process.env.GOOGLE_AI_API_KEY = "test-gg";
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = model;
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = `${pool}:1`;
  const bodies: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body));
    return new Response(
      JSON.stringify({ id: "x", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const invoke = createPoolInvoker({ pools: loadPools(), health: new PoolHealth(), log: quietLog, sink: () => {}, fetchImpl: impl, cacheBust });
  await invoke(request(withJson), new AbortController().signal);
  assert.equal(bodies.length, 1);
  return bodies[0]!.replace(UUID_RE, "<uuid>");
}

const LUNA = "openrouter/openai/gpt-5.6-luna";
const FLASH = "openrouter/google/gemini-3.1-flash-lite";
const OFF: CacheBustConfig = { enabled: false, mode: "nonce" };
const BOTH: CacheBustConfig = { enabled: true, mode: "both" };

const CASES: Array<{ name: string; pool: string; model: string; json: boolean; cacheBust: CacheBustConfig }> = [
  { name: "openrouter.json.off", pool: "openrouter", model: LUNA, json: true, cacheBust: OFF },
  { name: "openrouter.none.off", pool: "openrouter", model: LUNA, json: false, cacheBust: OFF },
  { name: "openrouter.json.both", pool: "openrouter", model: LUNA, json: true, cacheBust: BOTH },
  { name: "openai_direct.json.off", pool: "openai_direct", model: LUNA, json: true, cacheBust: OFF },
  { name: "openai_direct.none.both", pool: "openai_direct", model: LUNA, json: false, cacheBust: BOTH },
  { name: "google_direct.json.off", pool: "google_direct", model: FLASH, json: true, cacheBust: OFF },
  { name: "google_direct.none.both", pool: "google_direct", model: FLASH, json: false, cacheBust: BOTH },
];

const GOLDEN: Record<string, string> = {
  // 생성: origin/main b380b72 invoker (수용 PR 이전). 현 코드 출력과 diff 0 확인.
  "openrouter.json.off": "{\"model\":\"openai/gpt-5.6-luna\",\"messages\":[{\"role\":\"system\",\"content\":\"score sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_tokens\":4000,\"temperature\":0,\"response_format\":{\"type\":\"json_object\"},\"reasoning\":{\"max_tokens\":256,\"exclude\":true},\"usage\":{\"include\":true}}",
  "openrouter.none.off": "{\"model\":\"openai/gpt-5.6-luna\",\"messages\":[{\"role\":\"system\",\"content\":\"score sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_tokens\":4000,\"temperature\":0,\"reasoning\":{\"max_tokens\":256,\"exclude\":true},\"usage\":{\"include\":true}}",
  "openrouter.json.both": "{\"model\":\"openai/gpt-5.6-luna\",\"messages\":[{\"role\":\"system\",\"content\":\"[nocache <uuid>]\\nscore sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_tokens\":4000,\"temperature\":0,\"response_format\":{\"type\":\"json_object\"},\"reasoning\":{\"max_tokens\":256,\"exclude\":true},\"prompt_cache_key\":\"<uuid>\",\"prompt_cache_options\":{\"mode\":\"explicit\"},\"usage\":{\"include\":true}}",
  "openai_direct.json.off": "{\"model\":\"gpt-5.6-luna\",\"messages\":[{\"role\":\"system\",\"content\":\"score sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_completion_tokens\":4000,\"response_format\":{\"type\":\"json_object\"}}",
  "openai_direct.none.both": "{\"model\":\"gpt-5.6-luna\",\"messages\":[{\"role\":\"system\",\"content\":\"[nocache <uuid>]\\nscore sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_completion_tokens\":4000,\"prompt_cache_key\":\"<uuid>\",\"prompt_cache_options\":{\"mode\":\"explicit\"}}",
  "google_direct.json.off": "{\"model\":\"gemini-3.1-flash-lite\",\"messages\":[{\"role\":\"system\",\"content\":\"score sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_tokens\":4000,\"temperature\":0,\"response_format\":{\"type\":\"json_object\"}}",
  "google_direct.none.both": "{\"model\":\"gemini-3.1-flash-lite\",\"messages\":[{\"role\":\"system\",\"content\":\"[nocache <uuid>]\\nscore sentiment\"},{\"role\":\"user\",\"content\":\"{\\\"mentions\\\":[{\\\"index\\\":0,\\\"surface_text\\\":\\\"현대\\\"}]}\"}],\"max_tokens\":4000,\"temperature\":0}",
};

test("스키마 없는 요청의 fetch 바디 원문이 골든과 바이트 동일하다 (키 순서 포함, uuid 만 정규화)", async () => {
  const actual: Record<string, string> = {};
  for (const c of CASES) actual[c.name] = await rawBody(c.pool, c.model, c.json, c.cacheBust);
  if (process.env.REQUEST_BODY_GOLDEN_PRINT === "1") {
    for (const [k, v] of Object.entries(actual)) console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  }
  assert.equal(Object.keys(GOLDEN).length, CASES.length, "골든 표가 케이스 수와 다르다");
  for (const c of CASES) {
    assert.equal(actual[c.name], GOLDEN[c.name], `${c.name}: 바디 원문이 골든과 다르다`);
  }
});
