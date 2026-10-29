// 공급자 풀 invoker — 타임아웃 · 페일오버 · 콜 원장 · 단가 (스펙 §8.3 · §8.4 · §8.5).
//
// **LLM 실비 0.** 모든 응답은 `fetchImpl` 로 주입한 **녹화 스텁**이다 — 네트워크를 타지 않는다.
// 녹화 본문은 OpenRouter `/chat/completions` 실응답 모양 그대로(`usage.cost_details` 포함)라,
// 벤더 코드(`llm.ts`)의 프롬프트 조립·파싱 경로가 실제로 지나간다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { afterEach, test } from "node:test";

// 원장 행 스키마는 lane 전용(`AnalysisCallUsage`)이다 — 코어가 받는 8필드
// `AnalysisLlmUsage` 와 다른 타입이고, 그 투영은 `toReplyUsage` 가 한다.
import { AnalysisCallUsageSchema, type AnalysisCallUsage } from "../contracts/index.ts";
import type { LaneLogger, LlmInvokeRequest } from "../worker/engine.ts";
import { buildInvoker, createPoolInvoker, describeFetchError, networkErrorClass, PoolCallError } from "../worker/invoker.ts";
import { configureHttpKeepAlive } from "../worker/http-agent.ts";
import { Semaphore } from "../worker/concurrency.ts";
import {
  BUILT_IN_POOLS,
  CORE_TASK_POOL_ENV_KEYS,
  PoolHealth,
  compatiblePoolWeights,
  isStandbyPool,
  loadPools,
  pickPool,
  poolAcceptsModel,
  poolWireFields,
  resolveLaneCost,
  resolveLaneModel,
  summarizeTaskStandby,
  taskPoolWeights,
  wireModelId,
  type PoolConfig,
} from "../worker/llm-pools.ts";

const quietLog: LaneLogger = { info: () => {}, warn: () => {}, error: () => {} };

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "LLM_TASK_MODEL_measurement_analysis_extract_mentions",
  "LLM_TASK_POOLS_measurement_analysis_extract_mentions",
  "LLM_TASK_MODEL_measurement_analysis_mention_semantics",
  "LLM_TASK_POOLS_measurement_analysis_mention_semantics",
  "ANALYSIS_LLM_FETCH_TIMEOUT_MS",
  "ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS",
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withKeys(): void {
  // 테스트용 더미. **실키가 아니다** — 경계 테스트의 시크릿 모양 정규식에도 안 걸리는 짧은 값.
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.OPENAI_API_KEY = "test-oa";
  delete process.env.GOOGLE_AI_API_KEY; // 키 없는 풀이 **비활성**임을 같이 본다
}

/** OpenRouter 실응답 모양. BYOK 라 `total_cost` 는 0 이고 실비는 `cost_details` 에 있다. */
function recordedBody(text: string, opts: { upstreamCost?: number; tokens?: [number, number] } = {}): unknown {
  const [pt, ct] = opts.tokens ?? [4210, 318];
  return {
    id: "gen-01J0TEST0000000000000000",
    model: "openai/gpt-5.6-luna",
    provider: "OpenAI",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: pt + ct,
      total_cost: 0,
      is_byok: true,
      ...(opts.upstreamCost === undefined ? {} : { cost_details: { upstream_inference_cost: opts.upstreamCost } }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Recorded {
  url: string;
  body: Record<string, unknown>;
}

function recordingFetch(responses: Array<() => Response | Promise<Response>>): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!next) throw new Error("no recorded response");
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function extractRequest(): LlmInvokeRequest {
  return {
    task: "extract",
    sourceTask: "measurement.analysis.extract_mentions",
    modelAlias: "haiku",
    prompt: '{"answer_text":"현대 투싼"}',
    systemPrompt: "extract mentions",
    responseFormat: "json",
    maxOutputTokens: 6000,
    temperature: 0,
    reasoning: { max_tokens: 256, exclude: true },
  };
}

function pools(): PoolConfig[] {
  return loadPools();
}

// ─────────────────────────────────────────────────────────────────────────────

test("성공 콜 1회 = usage 행 1개. 계약을 통과하고 풀·모델·비용 출처가 붙는다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const rows: AnalysisCallUsage[] = [];
  const { impl, calls } = recordingFetch([() => jsonResponse(recordedBody('{"mentions":[]}', { upstreamCost: 0.00155 }))]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}');
  assert.equal(rows.length, 1);
  const row = AnalysisCallUsageSchema.parse(rows[0]);
  assert.equal(row.outcome, "completed");
  assert.equal(row.poolKey, "openrouter");
  assert.equal(row.modelId, "openai/gpt-5.6-luna");
  assert.equal(row.inputTokens, 4210);
  assert.equal(row.outputTokens, 318);
  // BYOK 실비가 1순위다 — `total_cost: 0` 을 "무료" 로 읽으면 안 된다(코어 cost.ts 와 같은 우선순위).
  assert.equal(row.costUsd, 0.00155);
  assert.equal(row.costSource, "vendor_reported");
  assert.equal(row.httpStatus, 200);
  assert.equal(out.displayModelId, "openrouter/openai/gpt-5.6-luna");

  // 요청 바디가 코어와 같은 필드·기본값을 쓴다(스펙 §8.3 — 파라미터화 대상은 baseUrl·키·헤더뿐).
  const body = calls[0]!.body;
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(body.model, "openai/gpt-5.6-luna");
  assert.equal(body.temperature, 0, "temperature 0 이 사라지면 분석 4태스크의 결정성 전제가 깨진다");
  assert.equal(body.max_tokens, 6000);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.reasoning, { max_tokens: 256, exclude: true });
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.messages, [
    { role: "system", content: "extract mentions" },
    { role: "user", content: '{"answer_text":"현대 투싼"}' },
  ]);
});

test("429 → 다른 풀로 1회 페일오버. 행이 2개이고 첫 행이 failed_over 다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:1";
  const rows: AnalysisCallUsage[] = [];
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ error: { message: "rate limited" } }, 429),
    () => jsonResponse(recordedBody('{"mentions":[]}')),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    rand: () => 0, // 첫 후보 고정 = openrouter
    sleep: async () => assert.fail("페일오버는 대기 없이 즉시 다른 풀로 가야 한다"),
  });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}');
  assert.equal(rows.length, 2, "실패한 콜도 행이다 — 실비·낭비가 거기 있다");
  assert.equal(rows[0]!.outcome, "failed_over");
  assert.equal(rows[0]!.poolKey, "openrouter");
  assert.equal(rows[0]!.httpStatus, 429);
  assert.equal(rows[0]!.errorClass, "rate_limited");
  assert.equal(rows[0]!.costUsd, null, "실패 콜의 비용은 미계측(null)이지 0 이 아니다");
  assert.equal(rows[1]!.outcome, "completed");
  assert.equal(rows[1]!.poolKey, "openai_direct");
  // **모델은 절대 안 바뀐다**(스펙 §8.3) — 풀만 바뀐다.
  assert.equal(rows[1]!.modelId, "openai/gpt-5.6-luna");
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[1]!.body.model, "gpt-5.6-luna", "직결 풀에는 vendor 접두사를 벗긴 id 를 보낸다");
  assert.equal(calls[1]!.body.usage, undefined, "`usage.include` 는 OpenRouter 확장이다 — 직결 풀에 보내면 400 이 난다");
});

test("직결 풀은 usage.total_cost 를 안 준다 → 단가표로 계산하고 출처를 rate_table 로 남긴다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openai_direct:1";
  const rows: AnalysisCallUsage[] = [];
  const body = { id: "x", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } };
  const { impl } = recordingFetch([() => jsonResponse(body)]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl });
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(rows[0]!.costSource, "rate_table");
  // luna $0.0002/1k in · $0.0012/1k out
  assert.ok(Math.abs((rows[0]!.costUsd ?? 0) - 0.0014) < 1e-9, `단가 계산이 코어 표와 다르다: ${rows[0]!.costUsd}`);
});

test("미등재 모델은 비용 0 이 아니라 null(미계측) 이다 — 조용한 0 을 만들지 않는다", () => {
  const cost = resolveLaneCost({ canonicalId: "openrouter/acme/not-registered", inputTokens: 100, outputTokens: 10 });
  assert.equal(cost.costUsd, null);
  assert.equal(cost.source, null);
  assert.equal(cost.unregisteredModelId, "openrouter/acme/not-registered");
});

test("fetch 타임아웃이 실재한다 — 한 요청의 행업이 콜을 무한 점유하지 않는다 (스펙 §8.4)", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const rows: AnalysisCallUsage[] = [];
  // 신호를 **실제로 존중하는** 느린 fetch. 신호가 없으면 이 테스트는 영원히 매달린다 =
  // 타임아웃이 안 걸린다는 증거가 된다.
  const hanging = (async (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
    })) as unknown as typeof fetch;
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: (r) => rows.push(r),
    fetchImpl: hanging,
    fetchTimeoutMs: () => 25,
    maxAttempts: () => 1,
  });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), (e: unknown) => {
    assert.ok(e instanceof PoolCallError);
    assert.equal(e.errorClass, "fetch_timeout");
    return true;
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "failed");
  assert.equal(rows[0]!.errorClass, "fetch_timeout");
});

test("4xx 검증 오류는 재시도하지 않는다 — 같은 요청을 다시 보내도 같은 400 이다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:1";
  const rows: AnalysisCallUsage[] = [];
  const { impl, calls } = recordingFetch([() => jsonResponse({ error: { message: "bad request" } }, 400)]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), /PoolCallError/);
  assert.equal(calls.length, 1, "non-retriable 인데 재시도했다");
  assert.equal(rows[0]!.outcome, "failed");
  assert.equal(rows[0]!.errorClass, "validation");
});

test("바깥 신호(드레인·리스 만료)로 끊기면 drained 행을 남기고 즉시 포기한다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const rows: AnalysisCallUsage[] = [];
  const ac = new AbortController();
  const hanging = (async (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: hanging });
  const p = invoke(extractRequest(), ac.signal);
  setTimeout(() => ac.abort(new Error("drain")), 10);
  await assert.rejects(() => p);
  assert.equal(rows.length, 1);
  // 실비가 이미 나갔을 수 있으므로 **행은 남긴다** — 0003 의 `drained` 가 그 자리다.
  assert.equal(rows[0]!.outcome, "drained");
});

test("키 없는 풀은 비활성이다 — 라우팅 대상에서 빠진다", () => {
  withKeys();
  const enabled = pools().filter((p) => process.env[p.apiKeyEnv]);
  assert.deepEqual(enabled.map((p) => p.key).sort(), ["openai_direct", "openrouter"]);
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "google_direct:1,openrouter:1";
  const w = taskPoolWeights("measurement.analysis.extract_mentions", enabled);
  assert.deepEqual(w, [{ poolKey: "openrouter", weight: 1 }], "키 없는 풀에 가중치가 남으면 매 콜이 401 이다");
});

test("모델 해석이 코어와 같은 우선순위다 — env override > alias 기본값, bedrock 은 거부", () => {
  delete process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions;
  assert.equal(resolveLaneModel("measurement.analysis.extract_mentions", "haiku").canonicalId, "openrouter/anthropic/claude-haiku-4.5");
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  assert.equal(resolveLaneModel("measurement.analysis.extract_mentions", "haiku").slug, "openai/gpt-5.6-luna");
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "bedrock:haiku";
  assert.throws(() => resolveLaneModel("measurement.analysis.extract_mentions", "haiku"), /Bedrock/);
});

test("직결 풀의 wire id 는 vendor 접두사를 벗긴다 (모델 정체는 그대로)", () => {
  withKeys();
  const direct = pools().find((p) => p.key === "openai_direct")!;
  const or = pools().find((p) => p.key === "openrouter")!;
  const model = { slug: "openai/gpt-5.6-luna", canonicalId: "openrouter/openai/gpt-5.6-luna" };
  assert.equal(wireModelId(or, model), "openai/gpt-5.6-luna");
  assert.equal(wireModelId(direct, model), "gpt-5.6-luna");
});

test("헬스 게이팅 — 5분 창 429/5xx > 10% 면 그 풀이 쿨다운된다", () => {
  let now = 1_700_000_000_000;
  const health = new PoolHealth(() => now);
  for (let i = 0; i < 19; i++) health.record("openrouter", false);
  health.record("openrouter", true); // 1/20 = 5% — 아직 아니다
  assert.equal(health.isGated("openrouter"), false);
  for (let i = 0; i < 3; i++) health.record("openrouter", true); // 4/23 = 17%
  assert.equal(health.isGated("openrouter"), true);
  now += 61_000;
  assert.equal(health.isGated("openrouter"), false, "쿨다운 60s 뒤에는 다시 후보다");
});

test("전역 콜 슬롯이 페일오버 **바깥**이다 — 풀을 바꿔 가며 재시도하는 동안 슬롯 1개를 쥔다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:1";
  const semaphore = new Semaphore(1);
  let maxSeen = 0;
  const { impl } = recordingFetch([
    () => {
      maxSeen = Math.max(maxSeen, semaphore.stats.inflight);
      return jsonResponse({ error: { message: "boom" } }, 503);
    },
    () => {
      maxSeen = Math.max(maxSeen, semaphore.stats.inflight);
      return jsonResponse(recordedBody("{}"));
    },
  ]);
  const rows: AnalysisCallUsage[] = [];
  const invoke = buildInvoker(
    { semaphore, acquireTimeoutMs: 1_000, requestTimeoutMs: 5_000 },
    createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 }),
  );
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(maxSeen, 1, "슬롯이 재시도마다 다시 잡히면 전역 상한이 조용히 초과된다");
  assert.equal(semaphore.stats.inflight, 0, "슬롯이 반납되지 않았다");
  assert.equal(rows.length, 2);
});

test("녹화 응답이 벤더 llm.ts 의 파서를 통과한다 — 프롬프트 조립·파싱 경로가 실제로 돈다", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const { extractMentionsWithLlm } = await import("../packages/analysis-core/vendor/lib/measurement-analysis/llm.ts");
  const rows: AnalysisCallUsage[] = [];
  const recorded = JSON.stringify({
    mentions: [{ surface_text: "현대 투싼", entity_type: "Product", mention_role: "single_choice", assertion: "final_choice", sentiment: "positive" }],
    warnings: [],
  });
  const { impl, calls } = recordingFetch([() => jsonResponse(recordedBody(recorded, { upstreamCost: 0.0009 }))]);
  const laneInvoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl });
  const { toLaneRequest } = await import("../worker/engines/core-engine.ts");
  const signal = new AbortController().signal;

  const result = await extractMentionsWithLlm({
    answerText: "현대 투싼을 추천합니다.",
    turnIndex: 1,
    catalog: [{ id: "00000000-0000-4000-8000-000000000001", type: "Brand", canonicalName: "Hyundai", aliases: [] }],
    industryName: "Automotive",
    invokeFn: async (req) => {
      const out = await laneInvoke(toLaneRequest(req), signal);
      return { text: out.text, tokenUsage: { input: out.usage.inputTokens ?? 0, output: out.usage.outputTokens ?? 0 }, costUsd: out.usage.costUsd ?? 0, modelId: out.displayModelId ?? "", traceId: out.traceId ?? "" };
    },
  });

  assert.equal(result.failed ?? false, false);
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0]!.surfaceText, "현대 투싼");
  assert.equal(result.attempts, 1);
  assert.equal(result.modelSlug, "openrouter/openai/gpt-5.6-luna");
  assert.equal(result.costUsd, 0.0009);
  // 벤더 코드가 만든 system 프롬프트가 실제로 전송됐다(자동차 변형 — `isAutomotiveIndustryName`).
  const sent = calls[0]!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(sent[0]!.role, "system");
  assert.ok(sent[0]!.content.length > 100, "system 프롬프트가 비었다 — 조립 경로가 안 돌았다");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task, "extract");
});

/**
 * **회귀 방지 — "건너뛸 수 있는 타임아웃은 타임아웃이 아니다".**
 *
 * `AbortSignal.timeout(ms)` 의 타이머는 **unref** 라, 이벤트 루프에 다른 할 일이 없으면 루프가
 * 먼저 비어 타임아웃이 **아예 안 걸린다**. 2026-09-12 CI 가 이것을 잡았다(node 20 에서
 * `Promise resolution is still pending but the event loop has already resolved` — 로컬 node 26
 * 에서는 통과했다). `worker/concurrency.ts` 가 세마포어 대기에서 같은 값을 이미 치렀다.
 *
 * 그래서 판정을 **빈 이벤트 루프**에서 한다 — 자식 프로세스에 마감 대기 하나만 남기고,
 * 그 프로세스가 타임아웃으로 끝나는지를 본다. 부모 테스트 러너 안에서는 러너 자신의 타이머가
 * 루프를 붙잡아 줘서 **결함이 보이지 않는다**(그게 로컬이 통과했던 이유다).
 */
test("마감 타이머는 ref 다 — 루프가 비어도 타임아웃이 실제로 걸린다 (CI node20 회귀)", () => {
  const invokerUrl = new URL("../worker/invoker.ts", import.meta.url).href;
  const script = [
    `import { withDeadline } from ${JSON.stringify(invokerUrl)};`,
    "const started = Date.now();",
    "let fired = false;",
    // 루프에 남는 것은 이 마감 하나뿐이다. 영원히 안 끝나는 작업을 준다.
    "await withDeadline(120, new AbortController().signal, (s) => new Promise((_r, rej) => {",
    "  s.addEventListener('abort', () => { fired = true; rej(s.reason); });",
    "})).catch(() => {});",
    "process.stdout.write(JSON.stringify({ fired, ms: Date.now() - started }));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const result = JSON.parse(out) as { fired: boolean; ms: number };
  assert.equal(result.fired, true, "빈 루프에서 마감이 건너뛰어졌다 — AbortSignal.timeout 으로 되돌아간 것이다");
  assert.ok(result.ms >= 100, `마감이 너무 일찍 걸렸다(${result.ms}ms)`);
});

test("마감은 타이머·리스너를 남기지 않는다 — 640 in-flight 에서 누수는 그 자체가 결함이다", async () => {
  const { withDeadline } = await import("../worker/invoker.ts");
  const outer = new AbortController();
  const before = outer.signal as unknown as { listenerCount?: (t: string) => number };
  for (let i = 0; i < 50; i++) await withDeadline(5_000, outer.signal, async () => "ok");
  // node 는 EventTarget 리스너 수를 직접 안 준다 → 같은 신호에 50회 돌린 뒤에도 abort 가
  // 정상 동작하는지로 본다(리스너가 쌓이면 abort 가 50번 불린다 = 아래 카운터가 1이 아니다).
  let aborts = 0;
  outer.signal.addEventListener("abort", () => (aborts += 1));
  outer.abort(new Error("done"));
  assert.equal(aborts, 1);
  assert.equal(typeof before, "object");
});

// ─────────────────────────────────────────────────────────────────────────────
// D-7 — **200 인데 쓸 수 없는 본문.**
//
// 라이브 지문(2026-09-13 07:15~07:24Z · 워커 fa7f08e): `analysis_lane.llm_call_failed` 32건이
// 전부 `status=200` · `errorClass=malformed_response` · `retriable=false` · `willRetry=false`
// 였다. 200 이라 페일오버가 한 번도 안 돌았고, 남은 필드로는 **왜 못 읽었는지 알 길이 없었다**
// (초판 `ChatResponseBody` 는 `choices[0].message.content` 하나만 알았다).
//
// 아래 6종은 전부 **status 200** 이다. 판정은 상태가 아니라 본문이 한다.
// ─────────────────────────────────────────────────────────────────────────────

interface LogLine {
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

function capturingLog(): { log: LaneLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: LogLine["level"]) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, event, fields });
    };
  return { log: { info: push("info"), warn: push("warn"), error: push("error") }, lines };
}

function malformedLine(lines: LogLine[]): LogLine {
  const line = lines.find((l) => l.event === "analysis_lane.llm_malformed_body");
  assert.ok(line, `llm_malformed_body 가 없다 (events=${lines.map((l) => l.event).join(",") || "none"})`);
  assert.equal(line.level, "warn");
  return line;
}

/** 본문에 섞어 두는 "답변처럼 생긴" 조각들. 로그 어느 필드에도 나오면 안 된다. */
const PARTIAL_ANSWER = '{"mentions":[{"surface_text":"제네시스 GV80"';
const LEAK_NEEDLES = ["제네시스 GV80", "현대 투싼", "answer_text", "extract mentions", "게이트웨이"];

/**
 * **값으로** 단언한다 — "안 실었다" 는 주장이 아니라 관측이어야 한다(`app/log.ts` 머리말:
 * 시크릿·답변 본문을 필드에 넣지 않는다, 길이·해시까지만).
 */
function assertNoPayloadLeak(lines: LogLine[]): void {
  const blob = JSON.stringify(lines.map((l) => l.fields));
  for (const needle of LEAK_NEEDLES) {
    assert.ok(!blob.includes(needle), `로그 필드에 프롬프트/답변이 실렸다: ${JSON.stringify(needle)} — ${blob.slice(0, 400)}`);
  }
}

function textResponse(body: string, contentType = "text/html"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

/**
 * 페일오버가 가능한 배선(풀 2개·첫 후보 고정). 재시도 가능 분류의 판정에 쓴다.
 *
 * ⚠️ 모델이 **luna(openai 벤더)** 인 것이 배선의 일부다 — `openai_direct` 는 `openai/*` 만 받으므로
 *    haiku(anthropic)로는 그 풀이 라우팅에서 빠지고(벤더 게이트) **페일오버 자체가 성립하지 않는다.**
 *    그게 바로 이 PR 이 막는 조용한 결함이다(standby 를 켜 뒀는데 장애 때 안 넘어감).
 */
function twoPools(): void {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:1";
}

test("① 정상 본문 — malformed 로그를 만들지 않는다(새 관측이 정상 경로를 오염시키지 않는다)", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl } = recordingFetch([() => jsonResponse(recordedBody('{"mentions":[]}'))]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}');
  assert.equal(rows[0]!.outcome, "completed");
  assert.equal(rows[0]!.errorClass, null);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.llm_malformed_body").length, 0);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.llm_content_parts").length, 0, "문자열 content 는 파트 로그를 내지 않는다");
});

test("② choices[0].error + finish_reason=error → provider_mid_generation_error 이고 **재시도된다**", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    // OpenRouter 문서 "Non-Streaming Mid-Stream Errors" 의 실제 모양 — 부분 출력 + 선택지별 error.
    () =>
      jsonResponse({
        id: "gen-01J0MIDGEN00000000000000",
        model: "anthropic/claude-haiku-4.5",
        provider: "Anthropic",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: PARTIAL_ANSWER },
            finish_reason: "error",
            native_finish_reason: "upstream_error",
            error: { code: 502, message: "Provider disconnected mid-stream", metadata: { error_type: "provider_unavailable" } },
          },
        ],
        usage: { prompt_tokens: 4210, completion_tokens: 2849 },
      }),
    () => jsonResponse(recordedBody('{"mentions":[]}')),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    rand: () => 0,
    sleep: async () => assert.fail("아직 안 써 본 풀이 있으면 대기 없이 그쪽으로 가야 한다"),
  });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}');
  assert.equal(calls.length, 2, "200 이라는 이유로 재시도가 막히면 이 값이 1 이다 — 그것이 라이브 지문이었다");

  // 원장: 새 클래스가 그대로, http_status 는 200 유지, outcome 은 페일오버.
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.errorClass, "provider_mid_generation_error");
  assert.ok((rows[0]!.errorClass ?? "").length <= 64, "0003 적재·계약(.max(64)) 상한");
  assert.equal(rows[0]!.httpStatus, 200);
  assert.equal(rows[0]!.outcome, "failed_over");
  assert.equal(rows[0]!.poolKey, "openrouter");
  assert.equal(rows[1]!.outcome, "completed");
  assert.equal(rows[1]!.poolKey, "openai_direct");

  // 관측: 형태만 남는다.
  const shape = malformedLine(lines).fields;
  assert.equal(shape.errorClass, "provider_mid_generation_error");
  assert.equal(shape.status, 200);
  assert.equal(shape.provider, "Anthropic");
  assert.equal(shape.id, "gen-01J0MIDGEN00000000000000");
  assert.equal(shape.finishReason, "error");
  assert.equal(shape.nativeFinishReason, "upstream_error");
  assert.equal(shape.choicesLength, 1);
  assert.equal(shape.contentType, "string");
  assert.equal(shape.contentLength, PARTIAL_ANSWER.length, "길이는 남기고 값은 안 남긴다");
  assert.equal(shape.choiceErrorCode, 502);
  assert.equal(shape.choiceErrorMessage, "Provider disconnected mid-stream");
  assert.equal(shape.errorCode, null, "최상위 error 는 없었다");
  assert.equal(shape.completionTokens, 2849);
  assert.ok((shape.bytes as number) > 0);
  assert.equal(shape.bodyHead, undefined, "JSON 파싱은 성공했다 — 본문 앞머리를 남기지 않는다");

  // `llm_call_failed` 의 판정도 함께 뒤집혔는지 본다(라이브에서 틀렸던 두 필드).
  const failed = lines.find((l) => l.event === "analysis_lane.llm_call_failed");
  assert.ok(failed, "llm_call_failed 가 없다");
  assert.equal(failed.fields.retriable, true);
  assert.equal(failed.fields.willRetry, true);
  assert.equal(failed.fields.status, 200);
  assertNoPayloadLeak(lines);
});

test("③ 최상위 error 만 있고 choices 가 없는 200 — 문서가 명시한 비스트리밍 중도 실패 형태", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ id: "gen-01J0TOPERR0000000000000", provider: "Anthropic", error: { code: 502, message: "Provider returned error" } }),
    () => jsonResponse(recordedBody('{"mentions":[]}')),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0, sleep: async () => {} });

  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(rows[0]!.errorClass, "provider_mid_generation_error");
  assert.equal(rows[0]!.httpStatus, 200);
  const shape = malformedLine(lines).fields;
  assert.equal(shape.choicesLength, 0);
  assert.equal(shape.contentType, "undefined");
  assert.equal(shape.contentLength, 0);
  assert.equal(shape.errorCode, 502);
  assert.equal(shape.errorMessage, "Provider returned error");
  assert.equal(shape.choiceErrorCode, null);
  assertNoPayloadLeak(lines);
});

test("④ finish_reason=length + 빈 content → truncated_empty. **재시도하지 않는다**(같은 요청은 같은 결과다)", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () =>
      jsonResponse({
        id: "gen-01J0TRUNC00000000000000",
        provider: "Anthropic",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length", native_finish_reason: "max_tokens" }],
        usage: { prompt_tokens: 4210, completion_tokens: 6000 },
      }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });

  await assert.rejects(
    () => invoke(extractRequest(), new AbortController().signal),
    (e: unknown) => {
      assert.ok(e instanceof PoolCallError);
      assert.equal(e.errorClass, "truncated_empty");
      assert.equal(e.status, 200);
      assert.equal(e.retriable, false, "생성 예산을 다 쓴 것은 결정적이다 — 재시도는 실비만 배로 태운다");
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(rows[0]!.outcome, "failed");
  assert.equal(rows[0]!.errorClass, "truncated_empty");
  assert.equal(rows[0]!.httpStatus, 200);
  const shape = malformedLine(lines).fields;
  assert.equal(shape.finishReason, "length");
  assert.equal(shape.nativeFinishReason, "max_tokens");
  assert.equal(shape.completionTokens, 6000);
  assert.equal(shape.contentLength, 0);
  assertNoPayloadLeak(lines);
});

test("⑤ content 가 배열(콘텐츠 파트) 이면 text 파트를 이어붙여 **수용**하고 info 1줄을 남긴다", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () =>
      jsonResponse({
        id: "gen-01J0PARTS000000000000000",
        provider: "Anthropic",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "…" }, // text 가 없는 파트는 건너뛴다
                { type: "text", text: '{"mentions"' },
                { type: "text", text: ":[]}" },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4210, completion_tokens: 318 },
      }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}', "파트를 이어붙이지 못하면 정상 응답이 malformed 로 버려진다");
  assert.equal(calls.length, 1);
  assert.equal(rows[0]!.outcome, "completed");
  assert.equal(rows[0]!.errorClass, null);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.llm_malformed_body").length, 0);
  const info = lines.find((l) => l.event === "analysis_lane.llm_content_parts");
  assert.ok(info, `llm_content_parts 가 없다 (events=${lines.map((l) => l.event).join(",")})`);
  assert.equal(info.level, "info");
  assert.equal(info.fields.parts, 3);
  assert.equal(info.fields.contentLength, 15);
  assert.equal(info.fields.provider, "Anthropic");
  assertNoPayloadLeak(lines);
});

test("⑥ reasoning 만 오고 content 가 비면 reasoning_only_empty — malformed 와 구분된다", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () =>
      jsonResponse({
        id: "gen-01J0REASON00000000000000",
        provider: "Anthropic",
        choices: [
          {
            index: 0,
            // `reasoning: {exclude: true}` 를 보냈는데도 추론만 돌아온 경우.
            message: { role: "assistant", content: null, reasoning: "x".repeat(240) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4210, completion_tokens: 240 },
      }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });

  await assert.rejects(
    () => invoke(extractRequest(), new AbortController().signal),
    (e: unknown) => {
      assert.ok(e instanceof PoolCallError);
      assert.equal(e.errorClass, "reasoning_only_empty");
      assert.equal(e.retriable, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(rows[0]!.errorClass, "reasoning_only_empty");
  assert.equal(rows[0]!.httpStatus, 200);
  const shape = malformedLine(lines).fields;
  assert.equal(shape.contentType, "null");
  assert.equal(shape.contentLength, 0);
  assert.equal(shape.reasoningLength, 240, "추론 **길이**만 남긴다 — 내용은 안 남긴다");
  assert.equal(shape.finishReason, "stop");
  assertNoPayloadLeak(lines);
});

test("⑦ 아무 신호 없이 content 만 비면 empty_content — malformed_response 라는 이름을 쓰지 않는다", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl } = recordingFetch([
    () => jsonResponse({ id: "gen-01J0EMPTY000000000000000", provider: "Anthropic", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: {} }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), (e: unknown) => {
    assert.ok(e instanceof PoolCallError);
    assert.equal(e.errorClass, "empty_content");
    return true;
  });
  assert.equal(rows[0]!.errorClass, "empty_content");
  assert.equal(malformedLine(lines).fields.completionTokens, null);
});

test("JSON 이 아닌 200 본문만 malformed_response 로 남고, 앞머리는 ASCII 만 남긴 채 마스킹된다", async () => {
  twoPools();
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const gateway = "<html><head><title>504 Gateway Time-out</title></head><body>게이트웨이 시간 초과</body></html>";
  const { impl, calls } = recordingFetch([() => textResponse(gateway)]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: (r) => rows.push(r), fetchImpl: impl, rand: () => 0 });

  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), (e: unknown) => {
    assert.ok(e instanceof PoolCallError);
    assert.equal(e.errorClass, "malformed_response");
    assert.equal(e.retriable, false, "200 + 비-JSON 은 기존 판정 그대로다 — 이 PR 이 뒤집는 것은 본문 실패뿐이다");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(rows[0]!.errorClass, "malformed_response");
  assert.equal(rows[0]!.httpStatus, 200);
  const shape = malformedLine(lines).fields;
  const head = shape.bodyHead as string;
  assert.ok(head.includes("504 Gateway Time-out"), `원인 문자열이 사라졌다: ${head}`);
  assert.ok(!/[^\x20-\x7E]/.test(head), `ASCII 밖 문자가 남았다: ${head}`);
  assert.ok(head.includes("*"), "마스킹 흔적이 없다 — 필터가 안 돈 것이다");
  assert.equal(shape.bytes, Buffer.byteLength(gateway, "utf8"));
  assertNoPayloadLeak(lines);
});


// ── D-8 : `network_error` 가 원인을 삼키던 것 ──────────────────────────────────
//
//   2026-09-13 라이브 25분 관측: `analysis_lane.llm_call_failed` **171건이 전부**
//   `status:null · errorClass:"network_error"` 였다(luna 118 · flash-lite 51 · haiku 2,
//   지연 1.4~15s · 중앙 5.8s). 재시도로 전량 회복했지만 **원인을 가릴 근거가 하나도 남지
//   않았다** — 제공자 리셋인지, NAT/게이트웨이 타임아웃인지, 유휴 소켓 재사용인지.
//
//   원인은 항상 `err.cause` 에 있다. 최상위 메시지는 `fetch failed` 또는 `terminated` 둘뿐이라
//   그것만 남겨서는 아무것도 못 가른다. 아래 테스트들은 **진짜 소켓을 끊어서** 그 모양을 고정한다
//   (녹화 스텁으로는 undici 가 만드는 `cause` 를 재현할 수 없다 — 그게 이 결함이 숨어 있던 이유다).

/** 요청을 받은 뒤 지정한 시점에 소켓을 파괴하는 로컬 서버. 외부 네트워크 0. */
async function socketKiller(when: "before-response" | "mid-body"): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (when === "before-response") {
      setTimeout(() => req.socket.destroy(), 10);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "content-length": "9999" });
    res.write('{"choi');
    setTimeout(() => res.socket?.destroy(), 10);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("D-8 ① 응답 대기 중 소켓이 끊기면 원인 코드가 원장·예외에 남는다 (network_error:UND_ERR_SOCKET)", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const killer = await socketKiller("before-response");
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  try {
    const invoke = createPoolInvoker({
      pools: pools().map((p) => (p.key === "openrouter" ? { ...p, baseUrl: killer.url } : p)),
      health: new PoolHealth(),
      log,
      sink: (r) => rows.push(r),
      // ⚠️ **진짜 fetch 다.** undici 가 만드는 `cause` 를 봐야 하는 테스트라 스텁을 쓸 수 없다.
      fetchImpl: globalThis.fetch,
      maxAttempts: () => 1,
    });
    await assert.rejects(
      () => invoke(extractRequest(), new AbortController().signal),
      (e: unknown) => {
        assert.ok(e instanceof PoolCallError);
        assert.equal(e.status, null);
        assert.match(e.errorClass, /^network_error:[A-Z0-9_]+$/, `원인 코드가 안 붙었다: ${e.errorClass}`);
        assert.ok(e.detail, "detail 이 비었다 — 원인을 버렸다");
        assert.equal(e.detail.errorName, "TypeError", "fetch 계약상 최상위는 TypeError 다");
        assert.ok(e.detail.causeCode, `cause.code 가 없다: ${JSON.stringify(e.detail)}`);
        return true;
      },
    );
  } finally {
    killer.close();
  }

  // 원장 — `error_class` 가 세분화됐고 계약(.max(64))을 통과한다.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "failed");
  assert.match(String(rows[0]!.errorClass), /^network_error:/);
  assert.ok(String(rows[0]!.errorClass).length <= 64);
  AnalysisCallUsageSchema.parse(rows[0]);

  // 로그 — 이 다섯 필드가 D-8 의 전부다. 하나라도 빠지면 같은 171건이 또 익명으로 쌓인다.
  const line = lines.find((l) => l.event === "analysis_lane.llm_call_failed");
  assert.ok(line, `llm_call_failed 가 없다 (events=${lines.map((l) => l.event).join(",") || "none"})`);
  for (const f of ["errorName", "errorCode", "causeName", "causeCode", "detail"]) {
    assert.ok(f in line.fields, `로그에 ${f} 가 없다`);
  }
  assert.equal(line.fields.errorName, "TypeError");
  assert.ok(typeof line.fields.causeCode === "string" && (line.fields.causeCode as string).length > 0);
  // 답변/프롬프트는 여전히 안 실린다 — 관측을 늘리면서 유출 경계를 넓히지 않는다.
  assertNoPayloadLeak(lines);
});

test("D-8 ② 헤더는 왔는데 바디 도중 끊긴 갈래도 같은 자리에서 잡힌다 (라이브 중앙 지연 5.8s 의 모양)", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  const killer = await socketKiller("mid-body");
  const rows: AnalysisCallUsage[] = [];
  try {
    const invoke = createPoolInvoker({
      pools: pools().map((p) => (p.key === "openrouter" ? { ...p, baseUrl: killer.url } : p)),
      health: new PoolHealth(),
      log: quietLog,
      sink: (r) => rows.push(r),
      fetchImpl: globalThis.fetch,
      maxAttempts: () => 1,
    });
    await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), (e: unknown) => {
      assert.ok(e instanceof PoolCallError);
      // `response.text()` 가 죽는 자리다 — 초판은 여기도 맨 `network_error` 였다.
      assert.match(e.errorClass, /^network_error:[A-Z0-9_]+$/);
      assert.ok(e.detail?.message, "cause 메시지가 없다 — 'terminated' 만 남으면 원인이 사라진다");
      return true;
    });
  } finally {
    killer.close();
  }
  assert.equal(rows.length, 1);
  assert.match(String(rows[0]!.errorClass), /^network_error:/);
});

test("D-8 ③ 타임아웃은 여전히 fetch_timeout 이다 — 세분화가 기존 분류를 덮어쓰지 않는다", () => {
  const timeoutish = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const d = describeFetchError(timeoutish);
  assert.equal(d.errorName, "TimeoutError");
  // `callPool` 이 이 축으로 갈라 `fetch_timeout` 을 유지한다(위 §8.4 테스트가 그 값을 고정한다).
  assert.equal(d.causeCode, null);
});

test("D-8 ④ describeFetchError 는 AggregateError 의 첫 하위 오류까지 본다", () => {
  const agg = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })], "all failed"));
  const err = Object.assign(new TypeError("fetch failed"), { cause: agg });
  const d = describeFetchError(err);
  assert.equal(d.causeCode, "ECONNREFUSED");
  assert.equal(networkErrorClass(d), "network_error:ECONNREFUSED");
});

test("D-8 ⑤ error_class 는 64자 계약 안에 머문다 — 공급자가 무엇을 넣든", () => {
  const wild = { name: "TypeError", cause: { name: "X", code: `ECONN${"X".repeat(200)}!!! 한글` } };
  const cls = networkErrorClass(describeFetchError(wild));
  assert.ok(cls.length <= 64, `error_class 가 64자를 넘었다: ${cls.length}`);
  assert.match(cls, /^network_error:[A-Z0-9_]+$/, cls);
  // 코드를 못 얻으면 **옛 이름 그대로** — 분류가 사라지지 않는다.
  assert.equal(networkErrorClass(describeFetchError(new TypeError("fetch failed"))), "network_error");
});

test("D-8 ⑥ 세분화가 재시도 정책을 바꾸지 않는다 — network_error:* 는 여전히 retriable 이다", () => {
  assert.equal(new PoolCallError(null, "network_error:UND_ERR_SOCKET", "openrouter").retriable, true);
  assert.equal(new PoolCallError(null, "network_error", "openrouter").retriable, true);
  // 비재시도 둘은 그대로다.
  assert.equal(new PoolCallError(null, "missing_api_key", "openrouter").retriable, false);
  assert.equal(new PoolCallError(null, "malformed_response", "openrouter").retriable, false);
});

// ── D-8 (완화) : 전역 HTTP 디스패처를 **명시**한다 ────────────────────────────
//
//   Node 내장 fetch 의 keep-alive 값은 암묵 기본값이다(idle 4s · 서버 광고 수용 상한 600s).
//   `worker/http-agent.ts` 는 npm `undici` 를 새로 넣지 않고 **런타임이 이미 쓰는 Agent 클래스**를
//   재사용해 그 값을 세운다. 여기서 보는 것은 "정말로 교체됐는가" 와 "실패를 조용히 넘기지
//   않는가" 둘이다.

/**
 * 전역 디스패처 심볼은 런타임마다 다르다 — node 20 은 `.1`(Agent), node 26 은 `.2`(Agent)이고
 * `.1` 은 구버전 호환 래퍼다(2026-09-13 실측). 테스트는 **양쪽을 저장·복원**한다.
 */
const DISPATCHER_SYMS = [Symbol.for("undici.globalDispatcher.1"), Symbol.for("undici.globalDispatcher.2")];
const globalScope = globalThis as unknown as Record<symbol, unknown>;

/** Agent 내부의 오리진→클라이언트 맵. **fetch 가 정말 이 에이전트를 썼는지**의 유일한 관측점. */
function agentClients(dispatcher: unknown): Map<string, unknown> | null {
  if (dispatcher === null || typeof dispatcher !== "object") return null;
  const sym = Object.getOwnPropertySymbols(dispatcher).find((s) => String(s) === "Symbol(clients)");
  const v = sym ? (dispatcher as Record<symbol, unknown>)[sym] : null;
  return v instanceof Map ? (v as Map<string, unknown>) : null;
}

test("D-8 ⑦ 전역 디스패처가 교체되고 **그 뒤의 fetch 가 실제로 그것을 쓴다**", async () => {
  const before = DISPATCHER_SYMS.map((s) => [s, globalScope[s]] as const);
  const summary = configureHttpKeepAlive({ keepAliveTimeoutMs: 4_000, keepAliveMaxTimeoutMs: 10_000, connections: null });
  try {
    assert.equal(summary.applied, true, `교체 실패: ${summary.reason}`);
    assert.equal(summary.reason, null);
    assert.equal(summary.dispatcher, "Agent", `Agent 가 아닌 것을 만들었다: ${summary.dispatcher}`);
    assert.ok(summary.slot === 1 || summary.slot === 2);

    const installed = globalScope[summary.slot === 2 ? DISPATCHER_SYMS[1]! : DISPATCHER_SYMS[0]!];
    const clients = agentClients(installed);
    assert.ok(clients, "Agent 의 clients 맵을 못 찾았다 — 이 단언의 근거가 사라졌다");
    assert.equal(clients.size, 0, "교체 직후에는 아직 아무 오리진도 안 붙어 있어야 한다");

    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${origin}/`);
      assert.equal(res.status, 200, "교체 후 fetch 가 깨졌다 — 버전 스큐다");
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      srv.close();
    }
    // **관측**: 방금 그 요청이 새 에이전트의 풀에 오리진을 만들었다 = fetch 가 이것을 썼다.
    assert.deepEqual([...clients.keys()], [origin], "fetch 가 교체된 디스패처를 쓰지 않았다");
  } finally {
    for (const [s, v] of before) globalScope[s] = v; // 전역을 다른 테스트로 흘리지 않는다
  }
});

test("D-8 ⑧ 적용 못 하면 **이유와 함께** applied:false 다 — 조용히 넘어가지 않는다", () => {
  // 심볼이 없는 가짜 전역. `new Request` 로도 안 채워지므로 부재가 그대로 보고돼야 한다.
  const emptyScope: Record<symbol, unknown> = {};
  const missing = configureHttpKeepAlive({ keepAliveTimeoutMs: 4_000, keepAliveMaxTimeoutMs: 10_000, connections: null }, emptyScope);
  assert.equal(missing.applied, false);
  assert.equal(missing.reason, "global_dispatcher_absent");

  // 값이 뒤집힌 설정(max < idle)은 **적용하지 않는다** — 조용히 고쳐 쓰지도 않는다.
  const bad = configureHttpKeepAlive({ keepAliveTimeoutMs: 9_000, keepAliveMaxTimeoutMs: 1_000, connections: null }, emptyScope);
  assert.equal(bad.applied, false);
  assert.equal(bad.reason, "invalid_keepalive_values");

  // 생성자가 없는 디스패처가 앉아 있으면 그 사실을 이름으로 말한다.
  const weird: Record<symbol, unknown> = { [Symbol.for("undici.globalDispatcher.1")]: Object.create(null) as object };
  const noCtor = configureHttpKeepAlive({ keepAliveTimeoutMs: 4_000, keepAliveMaxTimeoutMs: 10_000, connections: null }, weird);
  assert.equal(noCtor.applied, false);
  assert.equal(noCtor.reason, "dispatcher_ctor_unavailable");

  // node 26 의 `.1` 래퍼를 `.2` 보다 먼저 잡으면 `InvalidArgumentError` 로 죽는다 — 그 회귀를
  // 고정한다: 둘 다 있으면 **`.2` 를 쓴다**.
  class FakeAgent {
    constructor(readonly opts: Record<string, unknown>) {}
  }
  class WrapperOnly {
    constructor() {
      throw new Error("Argument dispatcher must implement dispatch");
    }
  }
  const dual: Record<symbol, unknown> = {
    [Symbol.for("undici.globalDispatcher.1")]: Object.create(WrapperOnly.prototype) as object,
    [Symbol.for("undici.globalDispatcher.2")]: new FakeAgent({}),
  };
  const picked = configureHttpKeepAlive({ keepAliveTimeoutMs: 4_000, keepAliveMaxTimeoutMs: 10_000, connections: 64 }, dual);
  assert.equal(picked.applied, true, `.2 를 안 골랐다: ${picked.reason}`);
  assert.equal(picked.slot, 2);
  assert.equal(picked.dispatcher, "FakeAgent");
  assert.deepEqual((dual[Symbol.for("undici.globalDispatcher.2")] as FakeAgent).opts, {
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 10_000,
    pipelining: 1,
    connections: 64,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 직결 풀 standby 페일오버 (운영 결정 2026-09-13)
//
// **평시 트래픽은 OpenRouter 100%, 직결은 OpenRouter 가 못 받을 때만.** 그래서 여기서
// 증명해야 하는 것은 "넘어간다" 만이 아니라 **"평시엔 안 넘어간다"** 이기도 하다 — 후자가
// 깨지면 이 PR 은 비용·장부 성격이 다른 트래픽 분산을 몰래 켠 것이 된다.
// ─────────────────────────────────────────────────────────────────────────────

const LUNA = { slug: "openai/gpt-5.6-luna", canonicalId: "openrouter/openai/gpt-5.6-luna" };
const FLASH_LITE = { slug: "google/gemini-3.1-flash-lite", canonicalId: "openrouter/google/gemini-3.1-flash-lite" };

/** 세 풀 다 활성. google_direct 까지 봐야 벤더 게이트가 관측된다. */
function withAllKeys(): void {
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.OPENAI_API_KEY = "test-oa";
  process.env.GOOGLE_AI_API_KEY = "test-gg";
}

/** 5분 창을 429 로 채워 그 풀을 쿨다운시킨다(HEALTH_MIN_SAMPLE=20). */
function gate(health: PoolHealth, poolKey: string): void {
  for (let i = 0; i < 20; i++) health.record(poolKey, true);
  assert.equal(health.isGated(poolKey), true, `${poolKey} 가 게이팅되지 않았다 — 전제가 깨졌다`);
}

function semanticsRequest(): LlmInvokeRequest {
  return {
    task: "semantics",
    sourceTask: "measurement.analysis.mention_semantics",
    modelAlias: "haiku",
    prompt: '{"mentions":[]}',
    systemPrompt: "semantics",
    responseFormat: "json",
    maxOutputTokens: 4000,
    temperature: 0,
    reasoning: { max_tokens: 256, exclude: true },
  };
}

test("standby — `weight 0` 은 버려지지 않는다 (버리면 standby 를 표현할 방법이 없다)", () => {
  withAllKeys();
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const w = taskPoolWeights("measurement.analysis.extract_mentions", loadPools());
  assert.deepEqual(w, [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "openai_direct", weight: 0 },
  ]);
  assert.equal(isStandbyPool(w, "openai_direct"), true);
  assert.equal(isStandbyPool(w, "openrouter"), false);
  // 음수·NaN 은 **여전히** 던진다 — 0 에 뜻이 생겼다고 그 밖의 이상한 값까지 통과시키지 않는다.
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:-1";
  assert.throws(() => taskPoolWeights("measurement.analysis.extract_mentions", loadPools()), /invalid weight/);
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:x";
  assert.throws(() => taskPoolWeights("measurement.analysis.extract_mentions", loadPools()), /invalid weight/);
});

test("standby — 평시(primary 건강)에는 **한 번도** 안 골린다", () => {
  const weights = [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "openai_direct", weight: 0 },
  ];
  const health = new PoolHealth();
  const picks = new Set<string>();
  // rand 를 창 전체로 훑는다 — 가중 랜덤이 0 가중치를 확률로 섞으면 여기서 드러난다.
  for (let i = 0; i < 1000; i++) picks.add(pickPool(weights, health, () => i / 1000)!);
  assert.deepEqual([...picks], ["openrouter"], "평시에 직결로 샜다 — 이건 페일오버가 아니라 트래픽 분산이다");
});

test("standby — primary 가 게이팅되면 그때 골린다(②), 게이팅 풀리면 다시 primary(①)", () => {
  let now = 1_700_000_000_000;
  const health = new PoolHealth(() => now);
  const weights = [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "openai_direct", weight: 0 },
  ];
  gate(health, "openrouter");
  assert.equal(pickPool(weights, health, () => 0), "openai_direct");
  now += 61_000; // 쿨다운 60s
  assert.equal(pickPool(weights, health, () => 0), "openrouter", "쿨다운이 풀렸는데 standby 에 눌러앉았다");
});

test("standby — standby 가 여러 개면 **균등**이다 (0 을 확률로 쓰면 아무도 안 뽑힌다)", () => {
  let now = 1_700_000_000_000;
  const health = new PoolHealth(() => now);
  const weights = [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "openai_direct", weight: 0 },
    { poolKey: "google_direct", weight: 0 },
  ];
  gate(health, "openrouter");
  assert.equal(pickPool(weights, health, () => 0.1), "openai_direct");
  assert.equal(pickPool(weights, health, () => 0.9), "google_direct");
});

test("standby — 전부 게이팅이면 ③ 원래 가중치로 돌아간다(분석이 통째로 멈추지 않는다)", () => {
  let now = 1_700_000_000_000;
  const health = new PoolHealth(() => now);
  const weights = [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "openai_direct", weight: 0 },
  ];
  gate(health, "openrouter");
  gate(health, "openai_direct");
  // ②(게이팅 안 된 standby)가 비었으므로 ③ — primary 로 던져 본다. null 이 되면 안 된다.
  assert.equal(pickPool(weights, health, () => 0), "openrouter");
  // primary 가 아예 없고 standby 만 전부 게이팅이어도 null 을 내지 않는다.
  assert.equal(pickPool([{ poolKey: "openai_direct", weight: 0 }], health, () => 0), "openai_direct");
});

test("standby — 429 가 나면 그 콜이 직결로 넘어가고 **standby 발화가 로그에 남는다**", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const rows: AnalysisCallUsage[] = [];
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ error: { message: "rate limited" } }, 429),
    () => jsonResponse({ id: "x", choices: [{ message: { content: '{"mentions":[]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    rand: () => 0,
    sleep: async () => assert.fail("아직 안 써 본 풀이 있으면 대기 없이 그쪽으로 가야 한다"),
  });

  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"mentions":[]}');
  assert.equal(rows[0]!.poolKey, "openrouter");
  assert.equal(rows[0]!.outcome, "failed_over");
  assert.equal(rows[1]!.poolKey, "openai_direct");
  assert.equal(rows[1]!.outcome, "completed");
  // 직결은 실비를 안 주므로 단가표로 계상된다(장부 구멍 아님).
  assert.equal(rows[1]!.costSource, "rate_table");
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/chat/completions");

  const standby = lines.filter((l) => l.event === "analysis_lane.pool_standby");
  assert.equal(standby.length, 1, `standby 발화가 로그에 없다 (events=${lines.map((l) => l.event).join(",")})`);
  assert.equal(standby[0]!.level, "warn");
  assert.equal(standby[0]!.fields.poolKey, "openai_direct");
  // CloudWatch 메트릭 필터(`PoolStandbyCalls`)가 세는 숫자 필드.
  assert.equal(standby[0]!.fields.standbyCall, 1);
  assert.deepEqual(standby[0]!.fields.primaryPools, ["openrouter"]);
});

test("standby — primary 성공이면 standby 로그가 **없다**(평시에 경보가 울면 경보가 죽는다)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const { log, lines } = capturingLog();
  const { impl } = recordingFetch([() => jsonResponse(recordedBody('{"mentions":[]}'))]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.pool_standby").length, 0);
});

// ── 모델 ↔ 풀 벤더 ───────────────────────────────────────────────────────────────

test("벤더 게이트 — 직결 풀은 자기 벤더 모델만 받는다 (풀이 바뀌어도 모델은 안 바뀐다)", () => {
  const or = BUILT_IN_POOLS.find((p) => p.key === "openrouter")!;
  const oa = BUILT_IN_POOLS.find((p) => p.key === "openai_direct")!;
  const gg = BUILT_IN_POOLS.find((p) => p.key === "google_direct")!;
  assert.equal(poolAcceptsModel(or, LUNA), true, "집계자는 벤더를 안 가린다");
  assert.equal(poolAcceptsModel(or, FLASH_LITE), true);
  assert.equal(poolAcceptsModel(oa, LUNA), true);
  assert.equal(poolAcceptsModel(oa, FLASH_LITE), false);
  assert.equal(poolAcceptsModel(gg, FLASH_LITE), true);
  assert.equal(poolAcceptsModel(gg, LUNA), false);
  // anthropic 은 직결 풀이 없다 — 어느 쪽도 못 받는다.
  const haiku = { slug: "anthropic/claude-haiku-4.5", canonicalId: "openrouter/anthropic/claude-haiku-4.5" };
  assert.equal(poolAcceptsModel(oa, haiku), false);
  assert.equal(poolAcceptsModel(gg, haiku), false);
});

test("벤더 게이트 — 안 맞는 풀은 라우팅에서 빠지고 그 사실이 로그에 남는다(조용히 빼지 않는다)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
  // ⚠️ 오배선: flash-lite(google) 인데 standby 를 openai_direct 로 걸었다.
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openrouter:1,openai_direct:0";
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ error: { message: "rate limited" } }, 429),
    () => jsonResponse({ id: "x", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl, rand: () => 0, sleep: async () => {} });
  await invoke(semanticsRequest(), new AbortController().signal);
  // 페일오버 대상이 없으므로 같은 풀로 backoff 재시도 — **openai 로는 절대 안 간다**.
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"],
  );
  const mismatch = lines.filter((l) => l.event === "analysis_lane.pool_vendor_mismatch");
  assert.equal(mismatch.length, 1, "벤더 불일치를 조용히 뺐다");
  assert.equal(mismatch[0]!.fields.poolKey, "openai_direct");
  assert.equal(mismatch[0]!.fields.modelVendor, "google");
});

test("벤더 게이트 — 전부 안 맞으면 `no_pool_configured` 가 아니라 `no_compatible_pool` 이다", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openai_direct:1";
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([() => jsonResponse(recordedBody("{}"))]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  await assert.rejects(
    () => invoke(semanticsRequest(), new AbortController().signal),
    (e: unknown) => {
      assert.ok(e instanceof PoolCallError);
      // 배선 미설정(no_pool_configured)과 **오배선**을 같은 이름으로 부르면 진단이 갈린다.
      assert.equal(e.errorClass, "no_compatible_pool");
      return true;
    },
  );
  assert.equal(calls.length, 0, "안 맞는 풀로 실제 요청을 보냈다");
  // ⚠️ **이 경고는 프로세스당 (태스크, 풀) 1회다.** 바로 위 테스트가 같은 조합을 이미 찍었으므로
  //    여기서는 조용해야 한다 — 배선 오류는 매 콜 반복되니 억제가 없으면 로그가 잠긴다.
  assert.equal(lines.filter((l) => l.event === "analysis_lane.pool_vendor_mismatch").length, 0, "중복 억제가 안 된다");
});

test("벤더 게이트 — `compatiblePoolWeights` 는 weight>0 도 똑같이 뺀다 (명시했어도 404 는 404 다)", () => {
  withAllKeys();
  const all = loadPools();
  const { weights, dropped } = compatiblePoolWeights(
    [
      { poolKey: "openrouter", weight: 1 },
      { poolKey: "openai_direct", weight: 1 },
      { poolKey: "google_direct", weight: 0 },
    ],
    FLASH_LITE,
    all,
  );
  assert.deepEqual(weights, [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "google_direct", weight: 0 },
  ]);
  assert.deepEqual(
    dropped.map((d) => d.poolKey),
    ["openai_direct"],
  );
});

// ── 요청 바디 방언 ───────────────────────────────────────────────────────────────

test("방언 — OpenRouter 바디는 **한 바이트도 안 바뀐다**(usage.include · reasoning 그대로)", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  delete process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions; // 미설정 = 현행 단일 경로
  const { impl, calls } = recordingFetch([() => jsonResponse(recordedBody("{}"))]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: () => {}, fetchImpl: impl });
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions", "미설정인데 openrouter 가 아니다");
  assert.deepEqual(calls[0]!.body.usage, { include: true });
  assert.deepEqual(calls[0]!.body.reasoning, { max_tokens: 256, exclude: true });
  assert.equal(calls[0]!.body.max_tokens, 6000, "openrouter 의 출력 상한 키가 바뀌었다");
  assert.equal(calls[0]!.body.max_completion_tokens, undefined);
  assert.equal(calls[0]!.body.temperature, 0, "결정성 전제(스펙 §6.3)가 openrouter 에서 깨졌다");
  assert.equal(calls[0]!.body.model, "openai/gpt-5.6-luna");
  assert.equal(calls[0]!.body.provider, undefined, "`provider` 는 lane 이 보내는 필드가 아니다");
});

test("방언 — 직결 풀에는 OpenRouter 전용 필드가 **안 나간다**(`usage.include`·`reasoning`)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openai_direct:1";
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ id: "x", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: () => {}, fetchImpl: impl });
  await invoke(extractRequest(), new AbortController().signal);
  const body = calls[0]!.body;
  assert.equal(body.usage, undefined, "`usage.include` 는 OpenRouter 확장이다 — 직결은 400 이다");
  assert.equal(body.reasoning, undefined, "`reasoning` 은 OpenRouter 통합 파라미터다 — 직결은 400 이다");
  assert.equal(body.provider, undefined);
  // ── 2026-09-13 라이브 스모크 실측 고정 (lane 바디 그대로 1콜씩) ──────────────────
  //   `max_tokens`                       → 400 "Use 'max_completion_tokens' instead"
  //   `max_completion_tokens` + `temperature: 0` → 400 "Only the default (1) value is supported"
  //   `max_completion_tokens` + temperature 생략 → 200
  assert.equal(body.max_tokens, undefined, "openai 직결에 `max_tokens` 를 보내면 400 이다(실측)");
  assert.equal(body.max_completion_tokens, 6000, "출력 상한 키가 개명되지 않았다");
  assert.equal(body.temperature, undefined, "openai 직결의 luna 는 temperature 0 을 400 으로 거부한다(실측)");
  // 나머지 공통 필드는 그대로 간다 — 모델 정체도(접두사만 벗긴다).
  assert.equal(body.model, "gpt-5.6-luna");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("방언 — 200 이 온 실측 바디 모양(`*_details` 포함)에서 토큰·비용 파싱이 안 깨진다", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openai_direct:1";
  const rows: AnalysisCallUsage[] = [];
  // 2026-09-13 스모크의 200 응답 모양. OpenAI 는 `usage` 에 `*_details` 객체를 함께 싣는다.
  const { impl } = recordingFetch([
    () =>
      jsonResponse({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        model: "gpt-5.6-luna",
        choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 1000,
          total_tokens: 2000,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0 },
        },
      }),
  ]);
  const invoke = createPoolInvoker({ pools: pools(), health: new PoolHealth(), log: quietLog, sink: (r) => rows.push(r), fetchImpl: impl });
  const out = await invoke(extractRequest(), new AbortController().signal);
  assert.equal(out.text, '{"ok":true}');
  assert.equal(rows[0]!.inputTokens, 1000, "`*_details` 가 섞이면 토큰 파싱이 깨진다");
  assert.equal(rows[0]!.outputTokens, 1000);
  // 직결은 실비를 안 준다 → 단가표. luna $0.0002/1k in · $0.0012/1k out
  assert.equal(rows[0]!.costSource, "rate_table");
  assert.ok(Math.abs((rows[0]!.costUsd ?? 0) - 0.0014) < 1e-9, `${rows[0]!.costUsd}`);
});

test("방언 — google 직결에도 같은 규칙 + 프롬프트 캐시 파라미터가 안 나간다", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "google_direct:1";
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ id: "x", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log,
    sink: () => {},
    fetchImpl: impl,
    // 게이트③ `params` 모드 — Gemini 호환 엔드포인트에는 대응 파라미터가 없다.
    cacheBust: { enabled: true, mode: "params" },
  });
  await invoke(semanticsRequest(), new AbortController().signal);
  const body = calls[0]!.body;
  assert.equal(body.url, undefined);
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(body.usage, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.prompt_cache_key, undefined, "OpenAI 계열 전용 파라미터가 Gemini 로 나갔다 — 400 이다");
  assert.equal(body.prompt_cache_options, undefined);
  // ⚠️ google 직결은 **현행 유지**다 — 2026-09-13 실측에서 `max_tokens` + `temperature: 0` 으로
  //    200 이 왔다. openai 쪽 개명을 여기까지 번지게 하면 멀쩡한 경로를 바꾸는 것이다.
  assert.equal(body.max_tokens, 4000, "google 직결에서 출력 상한 키가 바뀌었다(실측은 max_tokens 200)");
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.temperature, 0, "google 직결은 temperature 0 을 받는다(실측)");
  // ⚠️ 그렇다고 **무효화를 포기하지 않는다** — nonce 로 내려앉는다. 그냥 빼면 그 콜만
  //    캐시에 맞아 게이트 창이 조용히 오염된다.
  const first = (body.messages as Array<{ content: string }>)[0]!;
  assert.match(first.content, /^\[nocache [0-9a-f-]{36}\]/, "params 를 못 받는데 nonce 로도 안 바꿨다 = 캐시 그대로");
  const degraded = lines.filter((l) => l.event === "analysis_lane.cache_bust_degraded");
  assert.equal(degraded.length, 1, "모드가 내려앉았는데 조용하다");
  assert.equal(degraded[0]!.fields.appliedMode, "nonce");
});

test("방언 — OpenAI 직결은 프롬프트 캐시 파라미터를 **받는다**(OpenAI 자기 파라미터다)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openai_direct:1";
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ id: "x", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log,
    sink: () => {},
    fetchImpl: impl,
    cacheBust: { enabled: true, mode: "params" },
  });
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(typeof calls[0]!.body.prompt_cache_key, "string");
  assert.deepEqual(calls[0]!.body.prompt_cache_options, { mode: "explicit" });
  assert.equal(lines.filter((l) => l.event === "analysis_lane.cache_bust_degraded").length, 0);
});

test("방언 — 내장 3풀의 필드 집합이 코드 정본과 같다 (새 풀이 조용히 openrouter 방언을 쓰지 않게)", () => {
  withAllKeys();
  const byKey = Object.fromEntries(loadPools().map((p) => [p.key, p]));
  assert.deepEqual(poolWireFields(byKey.openrouter!), {
    usageInclude: true,
    reasoning: true,
    promptCacheParams: true,
    maxTokensField: "max_tokens",
    temperature: true,
    jsonSchema: true,
  });
  assert.deepEqual(poolWireFields(byKey.openai_direct!), {
    usageInclude: false,
    reasoning: false,
    promptCacheParams: true,
    maxTokensField: "max_completion_tokens",
    temperature: false,
    jsonSchema: false,
  });
  assert.deepEqual(poolWireFields(byKey.google_direct!), {
    usageInclude: false,
    reasoning: false,
    promptCacheParams: false,
    maxTokensField: "max_tokens",
    temperature: true,
    jsonSchema: true,
  });
  // 커스텀 풀의 기본은 **가장 좁은** 방언이다 — 모르는 엔드포인트에 확장 필드를 보내지 않는다.
  process.env.LLM_POOL_KEYS = "acme";
  process.env.LLM_POOL_ACME_BASE_URL = "https://acme.example/v1";
  try {
    const acme = loadPools().find((p) => p.key === "acme")!;
    assert.equal(acme.dialect, "openai_compat");
    assert.equal(acme.modelVendors, null, "모르는 풀에 벤더 제약을 걸면 기존 배선이 조용히 끊긴다");
  } finally {
    delete process.env.LLM_POOL_KEYS;
    delete process.env.LLM_POOL_ACME_BASE_URL;
  }
});

test("standby — lane 이 부르는 태스크의 풀 env 키가 정본과 같다(오타는 조용히 무시된다)", () => {
  assert.deepEqual(
    [...CORE_TASK_POOL_ENV_KEYS].sort(),
    [
      // 2026-09-14 WU2: 답변 단위 브랜드 스탠스 태스크 추가(스펙 §4.1).
      "LLM_TASK_POOLS_measurement_analysis_answer_brand_stance",
      "LLM_TASK_POOLS_measurement_analysis_classify_citation_domain",
      "LLM_TASK_POOLS_measurement_analysis_extract_mentions",
      "LLM_TASK_POOLS_measurement_analysis_mention_semantics",
      "LLM_TASK_POOLS_measurement_analysis_resolve_pending_mentions",
    ],
  );
});

test("standby — 선언은 됐는데 키가 없으면 기동 요약이 그것을 **말한다**(합성 가드의 사각지대)", () => {
  withKeys(); // GOOGLE_AI_API_KEY 없음 = google_direct 비활성
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openrouter:1,google_direct:0";
  const active = loadPools().filter((p) => process.env[p.apiKeyEnv]);
  const summary = summarizeTaskStandby(active);
  const extract = summary.find((s) => s.coreTask === "measurement.analysis.extract_mentions")!;
  assert.deepEqual(extract.primary, ["openrouter"]);
  assert.deepEqual(extract.standby, ["openai_direct"]);
  assert.deepEqual(extract.declaredButInactive, []);
  const semantics = summary.find((s) => s.coreTask === "measurement.analysis.mention_semantics")!;
  assert.deepEqual(semantics.standby, [], "키 없는 풀이 standby 로 세어졌다 — 페일오버는 안 일어난다");
  assert.deepEqual(semantics.declaredButInactive, ["google_direct"]);
  // 미설정 태스크는 보고 대상이 아니다(openrouter 단독이 정상이다).
  assert.equal(summary.some((s) => s.coreTask === "measurement.analysis.classify_citation_domain"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 — standby 의 **비재시도 실패**(검증자 지적, 2026-09-13)
//
// standby 가 골리는 상황은 정의상 primary 가 게이팅된 때다. 게이팅은 "5분 창 실패율 10%
// 초과" 이지 "죽었다" 가 아니다 — 90% 는 아직 답한다. 그래서 standby 가 400/401/404 를
// 내면 ⓐ 아직 안 써 본 primary 로 **1회 폴백**하고 ⓑ 그 standby 를 헬스에 bad 로 센다.
// ⓑ 가 없으면 배선이 틀린 standby 가 영원히 게이팅되지 않아 장애마다 같은 400 을 반복한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 비재시도 4xx 3종 — 검증자가 실측한 케이스 그대로. */
const NON_RETRIABLE_4XX: Array<[number, unknown, string]> = [
  [400, { error: { message: "bad request" } }, "validation"],
  [401, { error: { message: "invalid api key" } }, "auth"],
  [404, { error: { message: "no such model" } }, "model_not_found"],
];

for (const [status, errBody, errorClass] of NON_RETRIABLE_4XX) {
  test(`F1 — primary 게이팅 + standby ${status} → 경로 OA>OR, standby 가 스스로 게이팅된다`, async () => {
    withAllKeys();
    process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
    process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
    let now = 1_700_000_000_000;
    const health = new PoolHealth(() => now);
    gate(health, "openrouter"); // primary 쿨다운 = standby 가 첫 시도로 골린다
    const rows: AnalysisCallUsage[] = [];
    const { log, lines } = capturingLog();
    const { impl, calls } = recordingFetch([
      () => jsonResponse(errBody, status),
      () => jsonResponse(recordedBody('{"mentions":[]}')),
    ]);
    const invoke = createPoolInvoker({
      pools: pools(),
      health,
      log,
      sink: (r) => rows.push(r),
      fetchImpl: impl,
      rand: () => 0,
      sleep: async () => assert.fail("아직 안 써 본 primary 가 있으면 대기 없이 넘어가야 한다"),
    });

    const out = await invoke(extractRequest(), new AbortController().signal);
    assert.equal(out.text, '{"mentions":[]}', "standby 4xx 에서 콜이 죽었다 — 멀쩡한 primary 를 한 번도 안 썼다");
    // ⓐ 경로: openai_direct → openrouter
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://api.openai.com/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"],
    );
    assert.equal(rows[0]!.poolKey, "openai_direct");
    assert.equal(rows[0]!.errorClass, errorClass);
    assert.equal(rows[0]!.outcome, "failed_over", "폴백했는데 원장은 failed 로 적었다");
    assert.equal(rows[1]!.poolKey, "openrouter");
    assert.equal(rows[1]!.outcome, "completed");
    // ⓑ standby 가 bad 로 세어졌다 — 기존 규칙(4xx 는 bad 아님)이 그대로면 0 이다.
    assert.equal(health.window("openai_direct").badCalls, 1, "standby 의 4xx 가 헬스 창에 안 들어갔다");
    // 로그로도 남는다 — 이건 공급자 장애가 아니라 **배선 결함**이다.
    const wiring = lines.filter((l) => l.event === "analysis_lane.pool_standby_wiring_failed");
    assert.equal(wiring.length, 1, `배선 실패가 조용하다 (events=${lines.map((l) => l.event).join(",")})`);
    assert.equal(wiring[0]!.fields.fallbackPoolKey, "openrouter");
    assert.equal(wiring[0]!.fields.errorClass, errorClass);
  });
}

test("F1 — standby 4xx 가 20콜 쌓이면 그 풀이 실제로 게이팅된다(영원히 안 걸리던 축)", () => {
  let now = 1_700_000_000_000;
  const health = new PoolHealth(() => now);
  // 새 규칙: standby 의 실패는 전부 bad. 20콜이면 HEALTH_MIN_SAMPLE 을 넘겨 쿨다운이 걸린다.
  for (let i = 0; i < 20; i++) health.record("openai_direct", true);
  assert.equal(health.isGated("openai_direct"), true);
});

test("F1 — 재시도 가능(500) 경로는 기존과 **동일**하다(폴백 규칙이 번지지 않는다)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const rows: AnalysisCallUsage[] = [];
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ error: { message: "boom" } }, 503),
    () => jsonResponse(recordedBody('{"mentions":[]}')),
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    rand: () => 0,
    sleep: async () => assert.fail("아직 안 써 본 풀이 있으면 대기 없이 넘어가야 한다"),
  });
  await invoke(extractRequest(), new AbortController().signal);
  // 평시(게이팅 없음) → primary 먼저, 503 은 재시도 가능 → standby 로 페일오버. 기존 동작 그대로.
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://openrouter.ai/api/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
  );
  assert.equal(rows[0]!.poolKey, "openrouter");
  assert.equal(rows[1]!.poolKey, "openai_direct");
});

test("F1 — primary 를 이미 써 봤으면 standby 4xx 는 그대로 실패한다(무한 왕복 금지)", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ error: { message: "boom" } }, 503), // primary 실패 → standby 로
    () => jsonResponse({ error: { message: "bad request" } }, 400), // standby 400 — 남은 primary 없음
  ]);
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: () => {},
    fetchImpl: impl,
    rand: () => 0,
    maxAttempts: () => 3,
    sleep: async () => {},
  });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), /PoolCallError/);
  assert.equal(calls.length, 2, "이미 써 본 primary 로 되돌아갔다 — 같은 콜이 왕복한다");
});

test("F1 — primary 의 4xx 취급은 **안 바뀐다**(스펙 §8.3: 헬스 bad 아님·재시도 없음)", async () => {
  withKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const health = new PoolHealth();
  const { impl, calls } = recordingFetch([() => jsonResponse({ error: { message: "bad request" } }, 400)]);
  const invoke = createPoolInvoker({ pools: pools(), health, log: quietLog, sink: () => {}, fetchImpl: impl, rand: () => 0 });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal), /PoolCallError/);
  assert.equal(calls.length, 1, "primary 의 400 을 재시도했다");
  assert.equal(health.window("openrouter").badCalls, 0, "primary 의 4xx 가 bad 로 세어졌다 — 기존 규칙이 바뀌었다");
});

// ── F3 — primary 가 하나도 활성이 아닐 때 ───────────────────────────────────────

test("F3 — OPENROUTER_API_KEY 가 비면 primary 0 · standby 만 남는다 (그리고 콜마다 pool_standby)", async () => {
  // 직결 키만 있는 상태 = OpenRouter 키가 사라진 라이브 모양.
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = "test-oa";
  process.env.GOOGLE_AI_API_KEY = "test-gg";
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_extract_mentions = "openrouter:1,openai_direct:0";
  const active = loadPools().filter((p) => process.env[p.apiKeyEnv]);
  const summary = summarizeTaskStandby(active);
  const extract = summary.find((s) => s.coreTask === "measurement.analysis.extract_mentions")!;
  assert.deepEqual(extract.primary, [], "openrouter 가 활성으로 세어졌다");
  assert.deepEqual(extract.standby, ["openai_direct"]);
  assert.deepEqual(extract.declaredButInactive, ["openrouter"]);

  // 그리고 그 상태의 콜은 **계속** standby 로그를 낸다 — 상시 직결 100% 를 조용히 돌지 않는다.
  const { log, lines } = capturingLog();
  const { impl, calls } = recordingFetch([
    () => jsonResponse({ id: "x", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
  ]);
  const invoke = createPoolInvoker({ pools: active, health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  await invoke(extractRequest(), new AbortController().signal);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(lines.filter((l) => l.event === "analysis_lane.pool_standby").length, 1);
});
