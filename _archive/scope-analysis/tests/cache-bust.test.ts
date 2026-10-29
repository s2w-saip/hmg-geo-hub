// 프롬프트 캐시 무효화(게이트③ · 운영 결정 2026-09-13).
//
// **LLM 실비 0.** 모든 응답은 `fetchImpl` 로 주입한 녹화 스텁이다 — 네트워크를 타지 않는다.
//
// ── 이 파일이 지키는 명제 셋
//
//   ① **꺼져 있으면 한 바이트도 안 바뀐다.** 게이트 스위치가 라이브 기본 경로를 건드리면
//      그 자체가 A/B 를 무효화한다 — off 본문이 기준 본문과 `deepEqual` 인지를 먼저 본다.
//   ② **켜면 접두가 실제로 깨진다.** "nonce 를 붙였다" 가 아니라 **요청마다 다르고**
//      **맨 앞**이라는 것이 캐시 미스의 조건이다(캐시는 접두 정확 일치로만 걸린다).
//   ③ **표기가 코어를 통과한다.** 코어 `AnalysisReplySchema` 는 `.strict()` 이고
//      `evidence.runtime` 도 `.strict()` 다 — 자유 record 가 아닌 자리에 키를 얹으면 완주한
//      분석이 `output_contract` 로 버려진다. 그래서 **코어 픽스처 바이트 사본**에 직접 얹어
//      파싱을 통과하는지(그리고 잘못된 자리는 **거부되는지**)를 고정한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AnalysisCallUsageSchema, AnalysisReplySchema, toReplyUsage, type AnalysisCallUsage } from "../contracts/index.ts";
import { CACHE_BUST_MODES, cacheBustReplyMark, loadCacheBustConfig, type CacheBustConfig } from "../worker/cache-bust.ts";
import type { LaneLogger, LlmInvokeRequest } from "../worker/engine.ts";
import { createLaneInvokerFactory, createPoolInvoker } from "../worker/invoker.ts";
import { Semaphore } from "../worker/concurrency.ts";
import { PoolHealth, loadPools, type PoolConfig } from "../worker/llm-pools.ts";

const quietLog: LaneLogger = { info: () => {}, warn: () => {}, error: () => {} };

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "LLM_TASK_MODEL_measurement_analysis_extract_mentions",
  "ANALYSIS_LLM_CACHE_BUST",
  "ANALYSIS_LLM_CACHE_BUST_MODE",
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
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
}

function recordedBody(text: string): unknown {
  return {
    id: "gen-01J0TEST0000000000000000",
    model: "openai/gpt-5.6-luna",
    provider: "OpenAI",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4210, completion_tokens: 318, total_tokens: 4528, total_cost: 0.0012 },
  };
}

function recordingFetch(): { impl: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify(recordedBody('{"mentions":[]}')), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const SYSTEM = "extract mentions";
const USER = '{"answer_text":"현대 투싼"}';

function extractRequest(withSystem = true): LlmInvokeRequest {
  return {
    task: "extract",
    sourceTask: "measurement.analysis.extract_mentions",
    modelAlias: "haiku",
    prompt: USER,
    ...(withSystem ? { systemPrompt: SYSTEM } : {}),
    responseFormat: "json",
    maxOutputTokens: 6000,
    temperature: 0,
  };
}

const pools = (): PoolConfig[] => loadPools();

/** 같은 배선으로 n 번 호출하고 업스트림이 실제로 받은 본문을 돌려준다. */
async function callN(
  cacheBust: CacheBustConfig | undefined,
  n: number,
  opts: { withSystem?: boolean } = {},
): Promise<{ bodies: Array<Record<string, unknown>>; rows: AnalysisCallUsage[] }> {
  withKeys();
  const rows: AnalysisCallUsage[] = [];
  const { impl, bodies } = recordingFetch();
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    ...(cacheBust ? { cacheBust } : {}),
  });
  for (let i = 0; i < n; i++) await invoke(extractRequest(opts.withSystem ?? true), new AbortController().signal);
  return { bodies, rows };
}

const NONCE_RE = /^\[nocache [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]\n/;
type Msg = { role: string; content: string };
const messagesOf = (b: Record<string, unknown>): Msg[] => b.messages as Msg[];

// ── env 파서 ────────────────────────────────────────────────────────────────────

test("기본값은 off/nonce 다 — 아무것도 설정하지 않은 라이브가 게이트 태세로 돌지 않는다", () => {
  assert.deepEqual(loadCacheBustConfig({}), { enabled: false, mode: "nonce" });
  assert.deepEqual(loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST: "" }), { enabled: false, mode: "nonce" });
  // 빈 모드는 미설정과 같다(값이 없으면 기본 수단).
  assert.deepEqual(loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST: "true", ANALYSIS_LLM_CACHE_BUST_MODE: "  " }), {
    enabled: true,
    mode: "nonce",
  });
});

test("truthy 어휘는 settings 의 bool() 과 같다 — 두 벌로 갈라지면 '설정했는데 안 켜진다' 가 된다", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST: v }).enabled, true, v);
  }
  for (const v of ["0", "false", "no", "off", "maybe"]) {
    assert.equal(loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST: v }).enabled, false, v);
  }
});

test("모르는 모드는 **던진다** — 오타가 기본값으로 접히면 게이트가 조용히 다른 것을 잰다", () => {
  assert.throws(
    () => loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST: "true", ANALYSIS_LLM_CACHE_BUST_MODE: "nonc" }),
    /ANALYSIS_LLM_CACHE_BUST_MODE must be one of/,
  );
  for (const m of CACHE_BUST_MODES) {
    assert.equal(loadCacheBustConfig({ ANALYSIS_LLM_CACHE_BUST_MODE: m }).mode, m);
  }
});

// ── ① 꺼져 있으면 무변경 ────────────────────────────────────────────────────────

test("off — 요청 본문이 기준과 **완전히 같다**(nonce 도 파라미터도 없다)", async () => {
  const { bodies, rows } = await callN({ enabled: false, mode: "both" }, 2);
  for (const b of bodies) {
    assert.deepEqual(messagesOf(b), [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ]);
    assert.equal("prompt_cache_key" in b, false);
    assert.equal("prompt_cache_options" in b, false);
  }
  // 두 요청이 **완전히 동일**해야 한다 — 그래야 캐시가 걸리는 현행 동작이 보존된다.
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(AnalysisCallUsageSchema.parse(rows[0]).cacheBust, false);
});

test("모드가 both 여도 enabled=false 면 아무 일도 없다 — 스위치는 하나다", async () => {
  const { bodies } = await callN({ enabled: false, mode: "both" }, 1);
  assert.equal(JSON.stringify(bodies[0]).includes("nocache"), false);
});

// ── ② 켜면 접두가 깨진다 ────────────────────────────────────────────────────────

test("nonce — system 첫 줄이 `[nocache <uuid>]` 이고 **요청마다 다르다**", async () => {
  const { bodies, rows } = await callN({ enabled: true, mode: "nonce" }, 3);
  const firsts = bodies.map((b) => messagesOf(b)[0]!.content);
  for (const c of firsts) {
    assert.match(c, NONCE_RE, "맨 앞 한 줄이 nonce 여야 한다 — 뒤·가운데는 접두를 안 깬다");
    // 원문은 한 글자도 안 바뀐다(줄바꿈 하나만 사이에 둔다).
    assert.equal(c.slice(c.indexOf("\n") + 1), SYSTEM);
  }
  assert.equal(new Set(firsts).size, 3, "같은 nonce 를 재사용하면 두 번째 콜이 자기 첫 콜의 캐시에 맞는다");
  // user 메시지·역할 구성은 그대로다.
  for (const b of bodies) {
    assert.deepEqual(
      messagesOf(b).map((m) => m.role),
      ["system", "user"],
    );
    assert.equal(messagesOf(b)[1]!.content, USER);
    assert.equal("prompt_cache_key" in b, false, "nonce 모드는 공급자 파라미터를 쓰지 않는다");
  }
  assert.equal(AnalysisCallUsageSchema.parse(rows[0]).cacheBust, true);
});

test("nonce — systemPrompt 가 없는 태스크는 **user 맨 앞**에 붙는다 (메시지 모양은 안 바꾼다)", async () => {
  const { bodies } = await callN({ enabled: true, mode: "nonce" }, 2, { withSystem: false });
  for (const b of bodies) {
    assert.deepEqual(
      messagesOf(b).map((m) => m.role),
      ["user"],
      "system 메시지를 새로 지어내면 캐시가 아니라 **프롬프트**가 달라진 A/B 가 된다",
    );
    const c = messagesOf(b)[0]!.content;
    assert.match(c, NONCE_RE);
    assert.equal(c.slice(c.indexOf("\n") + 1), USER);
  }
  assert.notEqual(messagesOf(bodies[0]!)[0]!.content, messagesOf(bodies[1]!)[0]!.content);
});

test("params — 프롬프트 바이트는 **그대로**이고 공급자 파라미터만 붙는다", async () => {
  const { bodies } = await callN({ enabled: true, mode: "params" }, 2);
  const keys: string[] = [];
  for (const b of bodies) {
    assert.deepEqual(messagesOf(b), [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ]);
    // OpenAI 문서의 명시 opt-out. breakpoint 를 하나도 안 주므로 암묵 캐시가 안 걸린다.
    assert.deepEqual(b.prompt_cache_options, { mode: "explicit" });
    assert.equal(typeof b.prompt_cache_key, "string");
    keys.push(b.prompt_cache_key as string);
  }
  // 무작위 키 = OpenRouter 의 sticky routing 이 안 걸린다(그 자체로 미스 보장은 아니다 — 그래서 기본값이 아니다).
  assert.equal(new Set(keys).size, 2);
});

test("both — nonce 와 파라미터가 **같은 토큰**을 쓴다(로그에서 한 콜로 이어붙일 수 있어야 한다)", async () => {
  const { bodies } = await callN({ enabled: true, mode: "both" }, 1);
  const b = bodies[0]!;
  const first = messagesOf(b)[0]!.content;
  assert.match(first, NONCE_RE);
  const uuid = first.slice("[nocache ".length, first.indexOf("]"));
  assert.equal(b.prompt_cache_key, uuid);
  assert.deepEqual(b.prompt_cache_options, { mode: "explicit" });
});

test("env 를 안 주면 프로세스 env 를 읽는다 — 라이브 정본은 ANALYSIS_LLM_CACHE_BUST 다", async () => {
  process.env.ANALYSIS_LLM_CACHE_BUST = "true";
  const { bodies, rows } = await callN(undefined, 1);
  assert.match(messagesOf(bodies[0]!)[0]!.content, NONCE_RE);
  assert.equal(rows[0]!.cacheBust, true);
});

test("팩토리가 **프로세스 1회** 읽는다 — 창 중간의 env 변화가 티켓 사이에 섞이지 않는다", async () => {
  // ⚠️ `createPoolInvoker` 는 티켓마다 불린다. 거기서 env 를 읽으면 한 게이트 창 안에 캐시
  //    유무가 혼재해 측정이 무효가 되고, 기동 1회 읽는 `app/settings.ts`(답장 표기의 출처)와도
  //    갈린다. 그래서 팩토리가 잡아 전 티켓에 같은 값을 내린다.
  withKeys();
  process.env.ANALYSIS_LLM_CACHE_BUST = "true";
  const { impl, bodies } = recordingFetch();
  const make = createLaneInvokerFactory({
    semaphore: new Semaphore(4),
    acquireTimeoutMs: 1000,
    requestTimeoutMs: 5000,
    log: quietLog,
    engine: "core",
    fetchImpl: impl,
  });
  // 팩토리 조립 **뒤**에 태세를 바꾼다 — 라이브에서는 일어나지 않지만, 일어나도 안 따라가야 한다.
  process.env.ANALYSIS_LLM_CACHE_BUST = "false";
  await make("t-1")(extractRequest(), new AbortController().signal);
  await make("t-2")(extractRequest(), new AbortController().signal);
  assert.equal(bodies.length, 2);
  for (const b of bodies) assert.match(messagesOf(b)[0]!.content, NONCE_RE, "티켓마다 env 를 다시 읽고 있다");
});

// ── 원장·답장 표기 ──────────────────────────────────────────────────────────────

test("실패 행에도 cacheBust 가 붙는다 — 무캐시 창의 실패율·낭비를 같은 축으로 세야 한다", async () => {
  withKeys();
  const rows: AnalysisCallUsage[] = [];
  const impl = (async (): Promise<Response> =>
    new Response(JSON.stringify({ error: { code: 400, message: "bad" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const invoke = createPoolInvoker({
    pools: pools(),
    health: new PoolHealth(),
    log: quietLog,
    sink: (r) => rows.push(r),
    fetchImpl: impl,
    cacheBust: { enabled: true, mode: "nonce" },
    rand: () => 0,
  });
  await assert.rejects(() => invoke(extractRequest(), new AbortController().signal));
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(AnalysisCallUsageSchema.parse(r).cacheBust, true);
});

test("cacheBust 는 답장 usage 로 **새지 않는다** — 코어 8필드 `.strict()` 가 튕긴다", () => {
  const row = AnalysisCallUsageSchema.parse({
    task: "extract",
    poolKey: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    inputTokens: 10,
    outputTokens: 2,
    latencyMs: 5,
    costUsd: 0.1,
    attempts: 1,
    outcome: "completed",
    cacheBust: true,
  });
  assert.equal(row.cacheBust, true);
  assert.equal("cacheBust" in toReplyUsage(row), false, "투영이 떨어뜨리지 않으면 완주한 분석이 output_contract 로 버려진다");
});

// ── ③ 코어 스키마(strict) 통과 자리 고정 ─────────────────────────────────────────
//
// 표기 자리 = **`evidence.runtime.cacheBust`** (운영 결정 2026-09-13). 코어 gate3 스크립트
// (Kongventures/scope#661)가 shadow 행의 `runtime->>'cacheBust'` 를 읽는다. 코어 쪽 짝은
// `AnalysisReplyEvidenceSchema.runtime` 에 `cacheBust: z.boolean().optional()` 를 더하는 PR-h 이고,
// `contracts/v1.ts` 의 미러는 **그것과 바이트 동일**해야 한다.
//
// ⚠️ `runtime` 은 `.strict()` 다. 그래서 두 가지가 동시에 참이어야 한다:
//    ① 이름이 정확히 `cacheBust` 인 boolean 은 통과한다
//    ② **그 외 새 키는 여전히 거부된다** — 미러를 넓히다 `.strict()` 를 잃으면 코어가 거부할
//       답장을 lane 이 통과시키고, 그 불일치는 라이브에서 `output_contract` 로만 드러난다.
//
// ⚠️ **off 면 키를 아예 싣지 않는다.** 코어가 이 필드를 모르는 동안(측정 워커 TD 240) `false`
//    라도 보내면 답장이 통째로 거부된다 — 완주한 분석이 버려지고 실비만 나간다.
//    배포 순서: 코어 PR-h 머지 + 워커 재배포 → lane 배포.

const CORE_MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));
const coreReply = (): Record<string, unknown> =>
  JSON.parse(readFileSync(CORE_MIRROR + "analysis-reply.completed.json", "utf8")) as Record<string, unknown>;

/** 코어 픽스처 바이트 사본의 `evidence.runtime` 에 패치를 얹어 파싱한다. */
function replyWithRuntime(patch: Record<string, unknown>): Record<string, unknown> {
  const raw = coreReply();
  const ev = raw.evidence as { runtime: Record<string, unknown> };
  return { ...raw, evidence: { ...ev, runtime: { ...ev.runtime, ...patch } } };
}

test("표기 자리 — evidence.runtime.cacheBust 가 코어 계약을 통과한다 (gate3 가 읽는 축)", () => {
  const parsed = AnalysisReplySchema.parse(replyWithRuntime({ cacheBust: true }));
  assert.equal(parsed.evidence!.runtime.cacheBust, true);
  // 기존 축은 그대로 살아 있어야 한다(더하기이지 덮어쓰기가 아니다).
  assert.equal(parsed.evidence!.runtime.laneRevision, "analysis-lane@abc1234");
  assert.deepEqual(parsed.evidence!.runtime.parallelFlags, { turn_internal_parallel: false });
});

test("off 표기는 **키 없음**이다 — `false` 조차 싣지 않는다 (구버전 코어 호환)", () => {
  assert.deepEqual(cacheBustReplyMark(false), {}, "false 를 실으면 이 필드를 모르는 코어가 답장을 거부한다");
  assert.deepEqual(cacheBustReplyMark(true), { cacheBust: true });
  // 병합 결과가 실제로 키를 안 갖는다(spread 로 사라지는지까지 본다).
  const runtime = { laneRevision: "x", contextVersionUsed: "y", parallelFlags: {}, ...cacheBustReplyMark(false) };
  assert.equal("cacheBust" in runtime, false);
  // 그리고 코어 픽스처 사본은 원래 이 키가 **없다** — 그것이 구버전 코어가 받던 모양이다.
  assert.equal("cacheBust" in ((coreReply().evidence as { runtime: Record<string, unknown> }).runtime), false);
});

test("⚠️ `.strict()` 는 살아 있다 — `cacheBust` 하나만 넓혔고 다른 새 키는 여전히 거부된다", () => {
  // 미러를 넓히다 `.strict()` 를 잃으면 코어가 거부할 답장을 lane 이 통과시킨다(라이브에서만 터진다).
  assert.throws(() => AnalysisReplySchema.parse(replyWithRuntime({ cacheBusted: true })));
  assert.throws(() => AnalysisReplySchema.parse(replyWithRuntime({ cache_bust: true })));
  // 최상위도 마찬가지다(코어 `AnalysisReplySchema` 자신이 `.strict()`).
  assert.throws(() => AnalysisReplySchema.parse({ ...coreReply(), cacheBust: true }));
  // 자료형도 좁다 — 문자열 "true" 는 거부된다(코어 정의가 `z.boolean()` 이다).
  assert.throws(() => AnalysisReplySchema.parse(replyWithRuntime({ cacheBust: "true" })));
});
