// 발생 단위 감성 V2 수용 (PR-Lane). 코어 PR(Kongventures/scope feat/mention-semantics-v2)보다 먼저 배포된다.
//
// 이 파일이 지키는 명제는 셋이다.
//
//   ① json_schema 가 **최종 HTTP 바디까지** 남는다. 벤더 코드가 만든 `ClaudeRequest` 에서 시작해
//      라이브 배선 그대로(`createLaneInvokerFactory` → `buildInvoker` → `createPoolInvoker` →
//      `fetch`) 조립된 바디를 녹화해서 본다. 중간 단계만 보면 어느 층이 떨어뜨렸는지 못 잡는다.
//   ② json_schema 를 못 받는 방언에서는 json_object 로 강등하고 **로그를 남긴다**(조용한 드롭 금지).
//      스키마가 없는 요청의 바디는 이 변경 전과 같다.
//   ③ 계약이 `enableLlmMentionSemanticsV2` 를 키 있음·없음 모두 받는다. 없으면 파싱 결과에도 없다.
//
// LLM 실비 0: 모든 응답은 녹화 스텁이다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AnalysisTicketRequestSchema, ResolvedAnalysisOptionsSchema } from "../contracts/index.ts";
import type { ClaudeRequest } from "../packages/analysis-core/shims/llm-invoke.ts";
import { Semaphore } from "../worker/concurrency.ts";
import type { LaneLogger, LlmInvokeRequest } from "../worker/engine.ts";
import { buildVendorInvoker, toLaneRequest } from "../worker/engines/core-engine.ts";
import { createLaneInvokerFactory, createPoolInvoker } from "../worker/invoker.ts";
import { PoolHealth, loadPools, poolWireFields } from "../worker/llm-pools.ts";

const CORE_MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "LLM_TASK_MODEL_measurement_analysis_mention_semantics",
  "LLM_TASK_POOLS_measurement_analysis_mention_semantics",
  "ANALYSIS_LLM_CACHE_BUST",
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withAllKeys(): void {
  // 테스트용 더미. 실키가 아니다.
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.OPENAI_API_KEY = "test-oa";
  process.env.GOOGLE_AI_API_KEY = "test-gg";
  delete process.env.ANALYSIS_LLM_CACHE_BUST;
}

/**
 * 코어 V2 스키마 사본(코어 PR #710, mention_type 추가판). 원본은 검증 라운드에서 받은
 * `schema-v3sm.json` 의 `json_schema` 이고, 키 순서까지 그대로 옮겼다(바디 비교가 JSON 직렬화 기준이라).
 */
const SEMANTICS_SCHEMA = {
  name: "semantics",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["semantics"],
    properties: {
      semantics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "sentiment", "mention_type", "evidence", "reason"],
          properties: {
            index: { type: "integer" },
            sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },
            evidence: { type: "string" },
            reason: { type: "string" },
            mention_type: {
              type: "string",
              enum: ["mention_only", "recommend", "final_choice", "compare", "reject", "definition"],
            },
          },
        },
      },
    },
  },
} as const;

function vendorSemanticsRequest(responseFormat: ClaudeRequest["responseFormat"]): ClaudeRequest {
  return {
    task: "measurement.analysis.mention_semantics",
    model: "haiku",
    system: "semantics v2",
    messages: [{ role: "user", content: '{"mentions":[]}' }],
    maxTokens: 9600,
    temperature: 0,
    ...(responseFormat === undefined ? {} : { responseFormat }),
  };
}

interface Recorded {
  url: string;
  body: Record<string, unknown>;
}

function recordingFetch(): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        id: "gen-test",
        choices: [{ index: 0, message: { role: "assistant", content: '{"semantics":[]}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

interface LogLine {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}
function capturingLog(): { log: LaneLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, event, fields });
    };
  return { log: { info: push("info"), warn: push("warn"), error: push("error") }, lines };
}

/** 라이브 워커가 조립하는 것과 같은 경로로 벤더 요청 1건을 보내고 녹화된 바디를 돌려준다. */
async function sendThroughLiveWiring(req: ClaudeRequest, pool: string): Promise<{ calls: Recorded[]; lines: LogLine[] }> {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = `${pool}:1`;
  const { impl, calls } = recordingFetch();
  const { log, lines } = capturingLog();
  const make = createLaneInvokerFactory({
    semaphore: new Semaphore(2),
    acquireTimeoutMs: 1000,
    requestTimeoutMs: 5000,
    log,
    engine: "core",
    fetchImpl: impl,
    cacheBust: { enabled: false, mode: "nonce" },
  });
  const invokeFn = buildVendorInvoker({
    llm: make("t-v2"),
    log,
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof buildVendorInvoker>[0]);
  await invokeFn(req);
  return { calls, lines };
}

// ── ① json_schema 가 최종 HTTP 바디까지 ─────────────────────────────────────────

test("V2 ① toLaneRequest 가 json_schema 객체를 버리지 않는다 (responseFormat 은 json 으로 함께 채운다)", () => {
  const lane = toLaneRequest(vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }));
  assert.deepEqual(lane.jsonSchema, SEMANTICS_SCHEMA);
  assert.equal(lane.responseFormat, "json", "강등 기준값이 없다");
});

test("V2 ① json_object 요청의 lane 요청은 이전과 같다 (jsonSchema 키 자체가 없다)", () => {
  for (const rf of ["json_object", { type: "json_object" }] as const) {
    const lane = toLaneRequest(vendorSemanticsRequest(rf));
    assert.equal(lane.responseFormat, "json");
    assert.equal(Object.hasOwn(lane, "jsonSchema"), false);
  }
  const bare = toLaneRequest(vendorSemanticsRequest(undefined));
  assert.equal(Object.hasOwn(bare, "responseFormat"), false);
  assert.equal(Object.hasOwn(bare, "jsonSchema"), false);
});

test("V2 ① openrouter: 벤더 요청 → 라이브 배선 → fetch 바디에 json_schema 가 **그대로** 실린다", async () => {
  const { calls, lines } = await sendThroughLiveWiring(
    vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }),
    "openrouter",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_schema", json_schema: SEMANTICS_SCHEMA });
  assert.equal(lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 0, "지원 방언인데 강등 로그가 났다");
  // 다른 필드는 영향이 없다.
  assert.equal(calls[0]!.body.temperature, 0);
  assert.equal(calls[0]!.body.max_tokens, 9600);
});

test("V2 ① openai_compat(google 직결): json_schema 가 그대로 실린다", async () => {
  const { calls, lines } = await sendThroughLiveWiring(
    vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }),
    "google_direct",
  );
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_schema", json_schema: SEMANTICS_SCHEMA });
  assert.equal(lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 0);
});

// ── ② 강등과 무변경 ──────────────────────────────────────────────────────────────

test("V2 ② openai 직결: json_object 로 강등하고 warn 로그에 풀·방언·스키마 이름을 남긴다", async () => {
  // openai 직결 풀은 openai 벤더 모델만 받는다(벤더 게이트). 모델을 맞춰 라우팅이 성립하게 한다.
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openai_direct:1";
  const { impl, calls } = recordingFetch();
  const { log, lines } = capturingLog();
  const invoke = createPoolInvoker({ pools: loadPools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  const req: LlmInvokeRequest = toLaneRequest(vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }));
  await invoke(req, new AbortController().signal);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" }, "강등하지 않았거나 response_format 을 통째로 버렸다");
  const degraded = lines.filter((l) => l.event === "analysis_lane.json_schema_degraded");
  assert.equal(degraded.length, 1, "강등했는데 조용하다");
  assert.equal(degraded[0]!.level, "warn");
  assert.equal(degraded[0]!.fields.poolKey, "openai_direct");
  assert.equal(degraded[0]!.fields.dialect, "openai");
  assert.equal(degraded[0]!.fields.schemaName, "semantics");
  assert.equal(degraded[0]!.fields.appliedFormat, "json_object");
  // 스키마 본문은 로그에 싣지 않는다.
  assert.equal(JSON.stringify(degraded[0]!.fields).includes("additionalProperties"), false);
});

test("V2 ② 스키마 없는 요청은 세 방언 모두 바디가 이전과 같고 강등 로그도 없다", async () => {
  for (const pool of ["openrouter", "google_direct"]) {
    const { calls, lines } = await sendThroughLiveWiring(vendorSemanticsRequest({ type: "json_object" }), pool);
    assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" }, `${pool}: json_object 바디가 바뀌었다`);
    assert.equal(lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 0);
    const none = await sendThroughLiveWiring(vendorSemanticsRequest(undefined), pool);
    assert.equal(Object.hasOwn(none.calls[0]!.body, "response_format"), false, `${pool}: 형식 없는 요청에 response_format 이 생겼다`);
  }
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/openai/gpt-5.6-luna";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openai_direct:1";
  const { impl, calls } = recordingFetch();
  const { log, lines } = capturingLog();
  const invoke = createPoolInvoker({ pools: loadPools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  await invoke(toLaneRequest(vendorSemanticsRequest("json_object")), new AbortController().signal);
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
  assert.equal(lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 0);
});

// ── ③ 계약 수용 ──────────────────────────────────────────────────────────────────

const coreTicket = (): Record<string, unknown> =>
  JSON.parse(readFileSync(`${CORE_MIRROR}analysis-ticket-request.v1.json`, "utf8")) as Record<string, unknown>;
const live = (raw: Record<string, unknown>): Record<string, unknown> => ({
  ...raw,
  deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
});

test("V2 ③ 키가 없는 티켓(코어 제출기 off = 라이브 대부분)이 통과하고, 파싱 결과에도 키가 생기지 않는다", () => {
  const raw = coreTicket();
  assert.equal(Object.hasOwn(raw.options as object, "enableLlmMentionSemanticsV2"), false, "코어 픽스처 모수가 바뀌었다");
  const parsed = AnalysisTicketRequestSchema.parse(live(raw));
  assert.equal(Object.hasOwn(parsed.options, "enableLlmMentionSemanticsV2"), false, "기본값을 주입하면 코어와 키 집합이 갈린다");
});

test("V2 ③ 키가 true·false 로 들어와도 통과하고 값이 보존된다", () => {
  const raw = coreTicket();
  for (const v of [true, false]) {
    const parsed = AnalysisTicketRequestSchema.parse({
      ...live(raw),
      options: { ...(raw.options as Record<string, unknown>), enableLlmMentionSemanticsV2: v },
    });
    assert.equal(parsed.options.enableLlmMentionSemanticsV2, v);
  }
});

test("V2 ③ .strict() 경계는 그대로다 (오타 키·비불리언 거부)", () => {
  const opts = coreTicket().options as Record<string, unknown>;
  assert.equal(ResolvedAnalysisOptionsSchema.safeParse({ ...opts, enableLlmMentionSemanticV2: true }).success, false);
  assert.equal(ResolvedAnalysisOptionsSchema.safeParse({ ...opts, enableLlmMentionSemanticsV2: "true" }).success, false);
});

// ── 검증 권고 반영: 커스텀 풀 기본 강등 · 스키마 객체 누락 강등 ─────────────────────

async function sendThroughCustomPool(envExtra: Record<string, string>): Promise<{ calls: Recorded[]; lines: LogLine[] }> {
  withAllKeys();
  const custom = {
    LLM_POOL_KEYS: "acme",
    LLM_POOL_ACME_BASE_URL: "https://acme.example/v1",
    LLM_POOL_ACME_API_KEY: "test-acme",
    ...envExtra,
  };
  const prev = new Map(Object.keys({ ...custom, LLM_POOL_ACME_JSON_SCHEMA: "" }).map((k) => [k, process.env[k]]));
  Object.assign(process.env, custom);
  try {
    process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
    process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "acme:1";
    const { impl, calls } = recordingFetch();
    const { log, lines } = capturingLog();
    const invoke = createPoolInvoker({ pools: loadPools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
    await invoke(toLaneRequest(vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA })), new AbortController().signal);
    return { calls, lines };
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("V2 권고② 커스텀 풀(LLM_POOL_KEYS)은 방언이 openai_compat 여도 기본으로 json_schema 를 보내지 않는다 (강등 + 로그)", async () => {
  const pool = (() => {
    process.env.LLM_POOL_KEYS = "acme";
    process.env.LLM_POOL_ACME_BASE_URL = "https://acme.example/v1";
    try {
      return loadPools().find((p) => p.key === "acme")!;
    } finally {
      delete process.env.LLM_POOL_KEYS;
      delete process.env.LLM_POOL_ACME_BASE_URL;
    }
  })();
  assert.equal(pool.dialect, "openai_compat");
  assert.equal(poolWireFields(pool).jsonSchema, false, "커스텀 풀 기본이 json_schema 를 연다");

  const { calls, lines } = await sendThroughCustomPool({});
  assert.equal(calls[0]!.url, "https://acme.example/v1/chat/completions");
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
  const degraded = lines.filter((l) => l.event === "analysis_lane.json_schema_degraded");
  assert.equal(degraded.length, 1, "커스텀 풀 강등이 조용하다");
  assert.equal(degraded[0]!.fields.poolKey, "acme");
  assert.equal(degraded[0]!.fields.dialect, "openai_compat");
});

test("V2 권고② 커스텀 풀은 LLM_POOL_<KEY>_JSON_SCHEMA=true 로만 열리고, 잘못된 값은 기동에서 죽는다", async () => {
  const opened = await sendThroughCustomPool({ LLM_POOL_ACME_JSON_SCHEMA: "true" });
  assert.deepEqual(opened.calls[0]!.body.response_format, { type: "json_schema", json_schema: SEMANTICS_SCHEMA });
  assert.equal(opened.lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 0);

  process.env.LLM_POOL_KEYS = "acme";
  process.env.LLM_POOL_ACME_BASE_URL = "https://acme.example/v1";
  process.env.LLM_POOL_ACME_JSON_SCHEMA = "yes";
  try {
    assert.throws(() => loadPools(), /LLM_POOL_ACME_JSON_SCHEMA must be "true" or "false"/);
  } finally {
    delete process.env.LLM_POOL_KEYS;
    delete process.env.LLM_POOL_ACME_BASE_URL;
    delete process.env.LLM_POOL_ACME_JSON_SCHEMA;
  }
});

test("V2 권고② 풀 단위 스위치는 좁히기 전용이다 (openai 방언 풀을 true 로 열 수 없다), 내장 풀은 방언 정본 그대로", () => {
  withAllKeys();
  process.env.LLM_POOL_OPENAI_DIRECT_JSON_SCHEMA = "true";
  try {
    const byKey = Object.fromEntries(loadPools().map((p) => [p.key, p]));
    assert.equal(poolWireFields(byKey.openai_direct!).jsonSchema, false);
    assert.equal(poolWireFields(byKey.openrouter!).jsonSchema, true);
    assert.equal(poolWireFields(byKey.google_direct!).jsonSchema, true);
  } finally {
    delete process.env.LLM_POOL_OPENAI_DIRECT_JSON_SCHEMA;
  }
});

test("V2 권고③ {type:json_schema} 인데 스키마 객체가 없으면 json_object 로 강등하고 같은 warn 로그를 남긴다", () => {
  for (const broken of [{ type: "json_schema" }, { type: "json_schema", json_schema: null }, { type: "json_schema", json_schema: "semantics" }]) {
    const { log, lines } = capturingLog();
    const lane = toLaneRequest(vendorSemanticsRequest(broken as unknown as ClaudeRequest["responseFormat"]), log);
    assert.equal(lane.responseFormat, "json", `${JSON.stringify(broken)}: response_format 이 사라졌다`);
    assert.equal(Object.hasOwn(lane, "jsonSchema"), false);
    const degraded = lines.filter((l) => l.event === "analysis_lane.json_schema_degraded");
    assert.equal(degraded.length, 1, `${JSON.stringify(broken)}: 강등이 조용하다`);
    assert.equal(degraded[0]!.level, "warn");
    assert.equal(degraded[0]!.fields.reason, "json_schema_object_missing");
    assert.equal(degraded[0]!.fields.appliedFormat, "json_object");
  }
  // 정상 스키마에서는 로그가 없다.
  const { log, lines } = capturingLog();
  toLaneRequest(vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }), log);
  assert.equal(lines.length, 0);
});

test("V2 권고③ 누락 강등은 라이브 배선(buildVendorInvoker)에서도 로그와 json_object 바디로 나타난다", async () => {
  withAllKeys();
  process.env.LLM_TASK_MODEL_measurement_analysis_mention_semantics = "openrouter/google/gemini-3.1-flash-lite";
  process.env.LLM_TASK_POOLS_measurement_analysis_mention_semantics = "openrouter:1";
  const { impl, calls } = recordingFetch();
  const { log, lines } = capturingLog();
  const invoke = createPoolInvoker({ pools: loadPools(), health: new PoolHealth(), log, sink: () => {}, fetchImpl: impl });
  const invokeFn = buildVendorInvoker({ llm: invoke, log, signal: new AbortController().signal } as unknown as Parameters<typeof buildVendorInvoker>[0]);
  await invokeFn(vendorSemanticsRequest({ type: "json_schema" } as unknown as ClaudeRequest["responseFormat"]));
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
  assert.equal(lines.filter((l) => l.event === "analysis_lane.json_schema_degraded").length, 1);
});

// ── 마지막 라운드: E1 스위치 파싱 규칙 · E2 스키마 모양 강등 · E3 내장 풀 킬스위치 ─────────────

function acmePoolWith(raw: string | undefined): () => ReturnType<typeof loadPools> {
  return () => {
    const keys = ["LLM_POOL_KEYS", "LLM_POOL_ACME_BASE_URL", "LLM_POOL_ACME_JSON_SCHEMA"];
    const prev = new Map(keys.map((k) => [k, process.env[k]]));
    process.env.LLM_POOL_KEYS = "acme";
    process.env.LLM_POOL_ACME_BASE_URL = "https://acme.example/v1";
    if (raw === undefined) delete process.env.LLM_POOL_ACME_JSON_SCHEMA;
    else process.env.LLM_POOL_ACME_JSON_SCHEMA = raw;
    try {
      return loadPools();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

test("V2 E1 JSON_SCHEMA 스위치 규칙: \"true\" 만 개방, \"false\"·미설정·\"\" 은 강등, 그 외는 기동 throw", () => {
  const acme = (raw: string | undefined) => acmePoolWith(raw)().find((p) => p.key === "acme")!;
  assert.equal(poolWireFields(acme("true")).jsonSchema, true, '"true" 가 열지 않는다');
  for (const closed of ["false", undefined, ""]) {
    assert.equal(poolWireFields(acme(closed)).jsonSchema, false, `${JSON.stringify(closed)} 가 강등되지 않는다`);
  }
  for (const bad of ["TRUE", "True", "FALSE", " true", "true ", " false", "1", "0", "yes", "no", "   ", "\t"]) {
    assert.throws(acmePoolWith(bad), /LLM_POOL_ACME_JSON_SCHEMA must be "true" or "false"/, `${JSON.stringify(bad)} 가 기동을 통과했다`);
  }
});

test("V2 E2 json_schema 객체에 schema 가 없거나 객체가 아니면 json_object 로 강등하고 reason 을 구분한다", () => {
  const cases: Array<[unknown, string, string | null]> = [
    [{}, "json_schema_schema_missing", null],
    [{ name: "x" }, "json_schema_schema_missing", "x"],
    [{ name: "x", schema: undefined }, "json_schema_schema_missing", "x"],
    [{ name: "x", schema: [] }, "json_schema_schema_not_object", "x"],
    [{ name: "x", schema: [{ type: "object" }] }, "json_schema_schema_not_object", "x"],
    [{ name: "x", schema: null }, "json_schema_schema_not_object", "x"],
    [{ name: "x", schema: "object" }, "json_schema_schema_not_object", "x"],
    [{ name: "x", schema: 1 }, "json_schema_schema_not_object", "x"],
    [[], "json_schema_object_missing", null],
  ];
  for (const [jsonSchema, reason, name] of cases) {
    const { log, lines } = capturingLog();
    const rf = { type: "json_schema", json_schema: jsonSchema } as unknown as ClaudeRequest["responseFormat"];
    const lane = toLaneRequest(vendorSemanticsRequest(rf), log);
    const label = JSON.stringify(jsonSchema);
    assert.equal(lane.responseFormat, "json", `${label}: response_format 이 사라졌다`);
    assert.equal(Object.hasOwn(lane, "jsonSchema"), false, `${label}: 깨진 스키마가 그대로 나간다`);
    const degraded = lines.filter((l) => l.event === "analysis_lane.json_schema_degraded");
    assert.equal(degraded.length, 1, `${label}: 강등이 조용하다`);
    assert.equal(degraded[0]!.level, "warn");
    assert.equal(degraded[0]!.fields.reason, reason, `${label}: reason 이 다르다`);
    assert.equal(degraded[0]!.fields.schemaName, name);
    assert.equal(degraded[0]!.fields.appliedFormat, "json_object");
  }
});

test("V2 E2 배열 스키마는 최종 fetch 바디에도 json_schema 로 나가지 않는다", async () => {
  const { calls, lines } = await sendThroughLiveWiring(
    vendorSemanticsRequest({ type: "json_schema", json_schema: { name: "semantics", strict: true, schema: [] } } as unknown as ClaudeRequest["responseFormat"]),
    "openrouter",
  );
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
  assert.equal(lines.filter((l) => l.fields.reason === "json_schema_schema_not_object").length, 1);
});

test("V2 E3 내장 풀도 JSON_SCHEMA=false 면 실제로 강등한다 (운영 킬스위치), 잘못된 값이면 기동 throw", async () => {
  process.env.LLM_POOL_OPENROUTER_JSON_SCHEMA = "false";
  process.env.LLM_POOL_GOOGLE_DIRECT_JSON_SCHEMA = "false";
  try {
    for (const [pool, poolKey] of [["openrouter", "openrouter"], ["google_direct", "google_direct"]] as const) {
      const { calls, lines } = await sendThroughLiveWiring(
        vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }),
        pool,
      );
      assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" }, `${pool}: 킬스위치가 무시됐다`);
      const degraded = lines.filter((l) => l.event === "analysis_lane.json_schema_degraded");
      assert.equal(degraded.length, 1, `${pool}: 강등이 조용하다`);
      assert.equal(degraded[0]!.fields.poolKey, poolKey);
    }
  } finally {
    delete process.env.LLM_POOL_OPENROUTER_JSON_SCHEMA;
    delete process.env.LLM_POOL_GOOGLE_DIRECT_JSON_SCHEMA;
  }
  withAllKeys();
  process.env.LLM_POOL_OPENROUTER_JSON_SCHEMA = "off";
  try {
    assert.throws(() => loadPools(), /LLM_POOL_OPENROUTER_JSON_SCHEMA must be "true" or "false"/);
  } finally {
    delete process.env.LLM_POOL_OPENROUTER_JSON_SCHEMA;
  }
  // 스위치를 치우면 내장 풀은 다시 방언 정본대로 연다.
  const { calls } = await sendThroughLiveWiring(vendorSemanticsRequest({ type: "json_schema", json_schema: SEMANTICS_SCHEMA }), "openrouter");
  assert.deepEqual(calls[0]!.body.response_format, { type: "json_schema", json_schema: SEMANTICS_SCHEMA });
});

test("V2 스키마 사본이 코어 #710 모양이다 (mention_type 포함, required 순서)", () => {
  const item = SEMANTICS_SCHEMA.schema.properties.semantics.items;
  assert.deepEqual([...item.required], ["index", "sentiment", "mention_type", "evidence", "reason"]);
  assert.deepEqual([...item.properties.mention_type.enum], ["mention_only", "recommend", "final_choice", "compare", "reject", "definition"]);
});
