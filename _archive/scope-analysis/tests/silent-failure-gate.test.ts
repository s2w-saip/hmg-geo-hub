// **성공 위장 차단** — invoker 가 죽어 있을 때 lane 이 `completed` 를 내지 않는다는 것을
// **라이브 배선 그대로** 판정한다.
//
// ── 왜 이 파일이 따로 있나
//
//   골든 게이트(`golden-analysis-core.test.ts`)는 순수 산출물이 코어와 바이트 동일한지를 본다 —
//   그 축은 "LLM 이 전부 죽어도 벤더 코드는 `failed:true` 로 정상 종료한다" 를 **정상으로 판정**한다
//   (실제로 그 테스트가 그렇게 단언한다). 맞는 판정이다: 엔진의 일은 분석이고, 그 결과를
//   `completed` 로 올릴지 말지는 **워커의 일**이다.
//
//   그 결정이 없으면 이렇게 된다 — invoker 미배선·풀 0·업스트림 전량 5xx 인 상태로 함대가 뜨고,
//   큐를 전부 끌어다, 멘션 0건짜리 분석을 `completed` 로 코어에 답장한다. 화면에는 "분석은
//   돌았는데 언급이 없다" 로 보이고, 그 상태가 며칠 간다. 이 파일은 그 경로 둘을 막는다:
//
//     (a) 기동 게이트  — `ANALYSIS_ENGINE=core` + 활성 풀 0 → **프로세스가 뜨지 않는다**
//     (b) 실행 게이트  — 업스트림 전량 503 → `deferred(transient)` + 실패 콜은 원장에 남는다
//
// ⚠️ (a) 는 **진짜 `worker/main.ts` 를 자식 프로세스로 띄워서** 본다. 팩토리를 직접 부르는
//    단위 테스트는 "가드가 존재한다"만 증명하고 **그 가드가 배선돼 있다**는 것은 증명하지
//    못한다 — 실제로 이 PR 직전까지 가드는 있었고 `worker/main.ts` 는 스텁 invoker 를 꽂고
//    있었다. 그 간극이 정확히 이 테스트가 없어서 안 보였던 것이다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as T from "../app/tickets.ts";
import {
  AnalysisTicketRequestSchema,
  deterministicAnalysisTicketId,
  type AnalysisTicketRequest,
} from "../contracts/index.ts";
import { loadPureEquivalenceCases } from "../packages/analysis-core/vendor/lib/measurement-analysis/pure/analyze-turn.fixtures.ts";
import { Semaphore } from "../worker/concurrency.ts";
import { ContextCache } from "../worker/context-cache.ts";
import { createLaneInvokerFactory } from "../worker/invoker.ts";
import { detectSilentLlmFailure, processTicket, type WorkerDeps } from "../worker/main.ts";
import { resolveEngine } from "../worker/registry.ts";
import { createPgliteDb, type TestDb } from "./helpers/pglite-db.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL("../worker/main.ts", import.meta.url));

const POOL_KEY_ENVS = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY"] as const;
const silentLog = { info: (): void => {}, warn: (): void => {}, error: (): void => {} };

// ─────────────────────────────────────────────────────────────────────────────
// (a) 기동 게이트 — 실배선
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 기동 게이트가 **둘**이고 순서가 있다(`worker/main.ts`): ① 태스크 모델 정합(B2) → ② 활성 풀.
 * 그래서 ②를 보려면 ①은 라이브처럼 채워 줘야 한다 — 라이브 worker TD 는 이 키들을 갖는다.
 * 안 채우면 "키가 없어서 죽었다" 를 볼 수 없고 **모델 가드가 먼저 죽여** 이 파일의 판정이
 * 통째로 무의미해진다.
 *
 * ⚠️ **`infra/cdk.json` 에서 읽는다 — 손으로 복사하지 않는다.** 초판은 사본이었고, 그 사본은
 *    태스크가 늘 때마다 조용히 낡는다(2026-09-14 WU2 에서 실제로 낡아 이 파일이 깨졌다:
 *    stance 키가 없어 **모델 가드가 먼저 죽였고** (a″)·(a‴) 의 판정이 무의미해졌다).
 *    cdk.json 이 워커 TD env 의 정본이므로 거기서 읽으면 그 드리프트가 구조적으로 없다.
 */
const LIVE_TASK_MODELS: Record<string, string> = (() => {
  const ctx = (
    JSON.parse(readFileSync(fileURLToPath(new URL("../infra/cdk.json", import.meta.url)), "utf8")) as {
      context: Record<string, unknown>;
    }
  ).context;
  return { ...(ctx.llmTaskModels as Record<string, string>) };
})();

/**
 * 자식 워커를 띄운다. DSN 은 **닫힌 포트**를 가리킨다 — 가드를 지나가면 DB 에서 죽고,
 * 안 지나가면 풀 에러로 죽는다. 즉 **어느 쪽으로 죽었는지가 곧 판정**이다.
 * (비번은 자리표시자 3글자다 — 시크릿 모양 리터럴 검사에 걸리지 않는다.)
 *
 * `opts.taskModels=false` 면 모델 env 를 빼서 **B2 가드**를 겨냥한다.
 * `opts.poolKey` 면 더미 공급자 키를 넣어 **풀 가드는 지나가게** 한다 — 축을 하나만 흔들기 위해.
 */
function bootWorker(
  engine: string,
  opts: { taskModels?: boolean; poolKey?: boolean } = {},
): { status: number | null; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("LLM_POOL_") || k.startsWith("LLM_TASK_")) continue;
    if ((POOL_KEY_ENVS as readonly string[]).includes(k)) continue;
    env[k] = v;
  }
  if (opts.taskModels !== false) Object.assign(env, LIVE_TASK_MODELS);
  if (opts.poolKey) env.OPENROUTER_API_KEY = "test-or"; // 더미. 실키가 아니다.
  env.ANALYSIS_ENGINE = engine;
  env.ANALYSIS_STORE_DSN = "postgres://analysis:dev@127.0.0.1:1/analysis";
  env.ANALYSIS_WORKER_ID = "boot-probe";
  const r = spawnSync(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

test("(a) ANALYSIS_ENGINE=core + 활성 풀 0 → 워커 프로세스가 **뜨지 못한다** (실배선)", () => {
  const { status, out } = bootWorker("core");
  assert.notEqual(status, 0, `기동이 성공했다 — 키 없이 뜨면 큐를 끌어다 전부 태운다\n${out.slice(0, 2000)}`);
  assert.match(
    out,
    /requires at least one provider pool/,
    `풀 가드가 아니라 다른 이유로 죽었다 — 가드가 배선돼 있지 않다는 뜻이다\n${out.slice(0, 2000)}`,
  );
  // **DB 보다 먼저** 죽어야 한다. 커넥션 에러가 보이면 가드가 마이그레이션 뒤로 밀린 것이고,
  // 그러면 실패한 기동이 매번 커넥션·마이그레이션 락을 먼저 잡았다 죽는다.
  assert.doesNotMatch(out, /ECONNREFUSED|ENOTFOUND|CONNECT_TIMEOUT/, `DB 를 먼저 건드렸다\n${out.slice(0, 2000)}`);
});

test("(a′) 같은 env 라도 스텁 엔진은 풀을 요구하지 않는다 — 가드가 엔진 조건부다", () => {
  const { out } = bootWorker("stub", { taskModels: false });
  assert.doesNotMatch(out, /requires at least one provider pool/, `스텁인데 풀을 요구했다\n${out.slice(0, 2000)}`);
  assert.doesNotMatch(out, /requires an explicit model/, `스텁인데 모델을 요구했다\n${out.slice(0, 2000)}`);
  // 두 가드를 지나 **DB 까지 갔다**는 증거. (a)·(a″) 가 DB 에 못 간 것이 "원래 못 가는 설정" 이
  // 아니라 **가드가 먼저 죽인 것**임을 이 한 줄이 대조로 보인다.
  assert.match(out, /ECONNREFUSED|ENOTFOUND|CONNECT_TIMEOUT/, `DB 단계까지 가지 않았다\n${out.slice(0, 2000)}`);
});

test("(a″) ANALYSIS_ENGINE=core + 태스크 모델 env 0 → 워커가 **뜨지 못한다** (B2 실배선)", () => {
  // 라이브 TD rev 9 가 정확히 이 상태였다 — 그런데 워커는 **정상 기동해서** alias 기본값
  // (haiku/sonnet)으로 돌았다. 콜은 전부 200 이라 실패로 안 보이고, 남은 것은 턴 체류 2.3배·
  // 단가 17배·shadow A/B 무효였다. 그래서 폴백을 기동 사망으로 바꾼다.
  //
  // 공급자 키는 **준다** — 축을 하나만 흔들어야 "모델 때문에 죽었다" 가 증명된다.
  const { status, out } = bootWorker("core", { taskModels: false, poolKey: true });
  assert.notEqual(status, 0, `기동이 성공했다 — 코어와 다른 모델로 조용히 돈다\n${out.slice(0, 2000)}`);
  assert.match(
    out,
    /requires an explicit model per analysis task/,
    `모델 가드가 아니라 다른 이유로 죽었다 — 가드가 배선돼 있지 않다는 뜻이다\n${out.slice(0, 2000)}`,
  );
  // lane 이 부르는 태스크를 **한 번에** 알려준다 — 한 개씩 고치며 여러 번 재배포하지 않게.
  for (const key of Object.keys(LIVE_TASK_MODELS)) {
    if (key.includes("unknown_discovery")) continue; // lane 이 부르지 않는 태스크는 요구하지 않는다
    assert.match(out, new RegExp(key), `${key} 가 메시지에 없다\n${out.slice(0, 2000)}`);
  }
  // **DB 보다 먼저** 죽어야 한다(풀 가드와 같은 이유 — 실패할 기동이 커넥션·마이그레이션 락을
  // 먼저 잡지 않게). `pools_ready` 보다도 먼저다.
  assert.doesNotMatch(out, /ECONNREFUSED|ENOTFOUND|CONNECT_TIMEOUT/, `DB 를 먼저 건드렸다\n${out.slice(0, 2000)}`);
  assert.doesNotMatch(out, /pools_ready/, `pools_ready 뒤에서 죽었다 — 가드 순서가 뒤집혔다\n${out.slice(0, 2000)}`);
});

test("(a‴) 모델 env 가 채워지면 기동 요약이 **무엇으로 도는지** 로그로 남긴다", () => {
  // B2 가 발견된 경로가 턴 로그의 모델 문자열이었다. 기동 요약에 없어서 아무도 먼저 못 봤다.
  const { out } = bootWorker("core", { poolKey: true });
  assert.match(out, /analysis_lane\.task_models/, `기동 요약에 모델이 없다\n${out.slice(0, 2000)}`);
  assert.match(out, /openrouter\/openai\/gpt-5\.6-luna/, `코어 모델이 요약에 없다\n${out.slice(0, 2000)}`);
  assert.match(out, /openrouter\/google\/gemini-3\.1-flash-lite/, `코어 모델이 요약에 없다\n${out.slice(0, 2000)}`);
  // 두 가드를 다 지나 DB 까지 갔다는 대조.
  assert.match(out, /ECONNREFUSED|ENOTFOUND|CONNECT_TIMEOUT/, `DB 단계까지 가지 않았다\n${out.slice(0, 2000)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) 실행 게이트 — 업스트림 전량 503
// ─────────────────────────────────────────────────────────────────────────────

const CASE = loadPureEquivalenceCases().find((c) => c.name === "b-extract-merge")!;
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const CONTEXT_VERSION = `${PROJECT}:0a1b2c3d4e5f6071`;
/** 골든 픽스처의 컨텍스트를 **직렬화 왕복**시킨 것 — 라이브 경로(HTTP 본문)와 같은 모양. */
const SNAPSHOT = JSON.parse(
  JSON.stringify({
    // ⚠️ 스냅샷의 catalog 는 **`{entities, industry}`** 다(D-6) — 순수 픽스처의 `catalog` 는
    //    순수 코드가 받는 배열이라 그대로 실으면 라이브와 다른 모양을 태운다.
    catalog: { entities: CASE.context.catalog, industry: CASE.context.industry },
    rels: CASE.context.rels,
    grouping: CASE.context.grouping.compiled,
    trackedAugmentTargets: CASE.context.trackedAugmentTargets,
  }),
) as Record<string, unknown>;

let db: TestDb;

function ticketRequest(): AnalysisTicketRequest {
  const analysisVersion = CASE.context.options.analysisVersion;
  return AnalysisTicketRequestSchema.parse({
    version: 1,
    ticketId: deterministicAnalysisTicketId(WORKSPACE, CASE.input.turnRunId, analysisVersion, 1),
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    lineage: {
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      queryRunId: CASE.input.trace.queryRunId,
      promptRunId: CASE.input.trace.promptRunId,
      turnRunId: CASE.input.turnRunId,
      turnIndex: CASE.input.turnIndex,
      attemptNumber: 1,
    },
    analysisVersion,
    industry: { ids: CASE.context.industry.ids, name: CASE.context.industry.name, source: CASE.context.industry.source },
    options: JSON.parse(JSON.stringify(CASE.context.options)) as Record<string, unknown>,
    turn: {
      turnRunId: CASE.input.turnRunId,
      turnIndex: CASE.input.turnIndex,
      promptText: CASE.input.promptText,
      answerText: CASE.input.answerText ?? "",
      sourceTurnHash: "c".repeat(64),
      target: CASE.input.trace.target,
      region: CASE.input.trace.region ?? "KR",
    },
    context: { ref: `https://core.invalid/ctx/${CONTEXT_VERSION}`, contextVersion: CONTEXT_VERSION },
    citationHostsToClassify: [],
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    priority: "scheduled",
    callbackUrl: null,
  });
}

before(async () => {
  db = await createPgliteDb();
  const { migrate } = await import("../app/migrate.ts");
  await migrate(db);
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.query("TRUNCATE analysis_call_usage, analysis_callback_outbox, analysis_ticket_events, analysis_tickets CASCADE");
  await db.query("DELETE FROM analysis_contexts");
});

test("(b) 업스트림 전량 503 → completed 0 · deferred(transient) · 실패 콜은 원장에 남는다", async () => {
  const saved = [...POOL_KEY_ENVS, "ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS"].map((k) => [k, process.env[k]] as const);
  // 풀 하나만 활성. invoker 층 재시도는 1회로 — 여기서 보려는 것은 재시도 횟수가 아니라 **판정**이다.
  process.env.OPENROUTER_API_KEY = "test-or";
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  process.env.ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS = "1";
  try {
    let upstreamCalls = 0;
    const semaphore = new Semaphore(4);
    const deps: WorkerDeps = {
      db,
      engine: resolveEngine("core", "0.0.0-dev"),
      llmSemaphore: semaphore,
      contextCache: new ContextCache({
        maxEntries: 4,
        maxBytes: 8_000_000,
        fetchTimeoutMs: 1000,
        dbCacheEnabled: true,
        // 코어 200 은 **봉투**다 — `{version, snapshot}`(코어 route.ts:98~109, D-5).
        fetchImpl: async () => ({ status: 200, body: { version: CONTEXT_VERSION, snapshot: SNAPSHOT } }),
      }),
      // **`worker/main.ts` 가 쓰는 바로 그 팩토리**다 — 소켓만 녹화 응답으로 바꿨다.
      makeInvoker: createLaneInvokerFactory({
        semaphore,
        acquireTimeoutMs: 1_000,
        requestTimeoutMs: 5_000,
        log: silentLog,
        engine: "core",
        fetchImpl: (async () => {
          upstreamCalls += 1;
          return new Response(JSON.stringify({ error: { message: "upstream down" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      }),
    };

    const req = ticketRequest();
    await db.begin((tx) => T.accept(tx, req));
    const [row] = await db.begin((tx) =>
      T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
    );
    assert.ok(row, "티켓이 리스되지 않았다");

    const outcome = await processTicket(deps, row);
    assert.equal(outcome, "deferred", "업스트림이 전부 죽었는데 completed 로 끝났다 — 성공 위장이다");
    assert.ok(upstreamCalls > 0, "업스트림을 한 번도 안 불렀다 — 배선이 끊겼다");

    const [t] = await db.query<{ status: string; failure_class: string | null; failure_reason: string | null }>(
      "SELECT status, failure_class, failure_reason FROM analysis_tickets WHERE ticket_id=$1",
      [req.ticketId],
    );
    assert.equal(t?.status, "deferred");
    assert.equal(t?.failure_class, "transient", "재시도로 풀리는 실패여야 한다(영구 실패로 태우지 않는다)");
    assert.match(String(t?.failure_reason), /llm_mention_failed=true/, `사유가 게이트를 가리키지 않는다: ${t?.failure_reason}`);

    const completed = await db.query<{ n: string }>("SELECT count(*) AS n FROM analysis_tickets WHERE status='completed'");
    assert.equal(Number(completed[0]?.n), 0, "completed 티켓이 하나라도 있으면 안 된다");

    // **실비는 이미 나갔다.** 안 적으면 `v_analysis_ticket_cost.wasted_cost_usd` 가 0 으로 보인다.
    const usage = await db.query<{ outcome: string; http_status: number | null; cost_usd: string | null; task: string }>(
      "SELECT outcome, http_status, cost_usd, task FROM analysis_call_usage WHERE ticket_id=$1 ORDER BY run_index",
      [req.ticketId],
    );
    assert.ok(usage.length > 0, "실패한 업스트림 콜이 원장에 하나도 없다 — 실패 턴이 공짜로 보인다");
    assert.equal(usage.length, upstreamCalls, `원장 행(${usage.length}) 과 업스트림 콜(${upstreamCalls}) 이 다르다`);
    for (const u of usage) {
      assert.notEqual(u.outcome, "completed", "전부 503 인데 completed 행이 있다");
      assert.equal(u.http_status, 503);
      assert.equal(u.cost_usd, null, "실패 콜 비용은 미계측(null)이지 0 이 아니다");
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 게이트의 **반대편** — 과잉 차단을 하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

test("게이트는 '모델이 깨진 JSON 을 줬다' 를 deferred 로 만들지 않는다 — 코어 인라인 경로와 같은 판정", () => {
  const row = {
    task: "extract" as const,
    poolKey: "openrouter",
    modelId: "anthropic/claude-haiku-4.5",
    inputTokens: 100,
    outputTokens: 10,
    latencyMs: 120,
    costUsd: 0.0001,
    attempts: 1,
    outcome: "completed" as const,
  };
  // 업스트림은 멀쩡히 응답했고(=`completed` 행), 파서가 봉투를 못 읽어 `failed` 가 된 경우.
  // 코어 인라인 경로는 이것을 그대로 persist 한다 — lane 이 여기서 갈라지면 A/B 가 깨진다.
  assert.equal(
    detectSilentLlmFailure({
      turn: { extractionMetadata: { llm_mention_enabled: true, llm_mention_failed: true } } as never,
      llmUsage: [row],
    }),
    null,
  );
  // 같은 메타데이터인데 성공한 콜이 0 이면 인프라 실패다.
  assert.match(
    String(
      detectSilentLlmFailure({
        turn: { extractionMetadata: { llm_mention_enabled: true, llm_mention_failed: true } } as never,
        llmUsage: [{ ...row, outcome: "failed", costUsd: null }],
      }),
    ),
    /llm_mention_failed=true/,
  );
});

test("게이트는 정상적인 '콜 0' 을 건드리지 않는다 — 빈 답변·pending 0 은 실패가 아니다", () => {
  // extract 는 `qualityState === "valid_answer"` 일 때만 돈다. 실패 답변 턴은 콜 0 이고
  // `llm_mention_failed` 도 false 다 — 여기서 deferred 를 내면 빈 답변마다 큐가 쌓인다.
  assert.equal(
    detectSilentLlmFailure({
      turn: {
        extractionMetadata: {
          llm_mention_enabled: true,
          llm_mention_failed: false,
          llm_pending_resolver_enabled: true,
          llm_pending_resolver_failed: false,
          llm_mention_semantics_enabled: true,
          llm_mention_semantics_failed: false,
        },
      } as never,
      llmUsage: [],
    }),
    null,
  );
  // 게이트가 **꺼져 있으면** failed 플래그가 true 라도 보지 않는다(그 층이 애초에 산출에 없다).
  assert.equal(
    detectSilentLlmFailure({
      turn: { extractionMetadata: { llm_mention_enabled: false, llm_mention_failed: true } } as never,
      llmUsage: [],
    }),
    null,
  );
});

test("resolve·semantics 층도 같은 게이트를 받는다 — extract 만 보면 뒤 두 층이 조용히 빈다", () => {
  const base = { llm_mention_enabled: true, llm_mention_failed: false };
  for (const [enabledKey, failedKey, task] of [
    ["llm_pending_resolver_enabled", "llm_pending_resolver_failed", "resolve"],
    ["llm_mention_semantics_enabled", "llm_mention_semantics_failed", "semantics"],
  ] as const) {
    const detail = detectSilentLlmFailure({
      turn: { extractionMetadata: { ...base, [enabledKey]: true, [failedKey]: true } } as never,
      // extract 는 성공했다 — 그 성공이 뒤 층의 실패를 가리면 안 된다.
      llmUsage: [
        {
          task: "extract",
          poolKey: "openrouter",
          modelId: "m",
          inputTokens: null,
          outputTokens: null,
          latencyMs: 1,
          costUsd: null,
          attempts: 1,
          outcome: "completed",
        },
      ],
    });
    assert.match(String(detail), new RegExp(`${failedKey}=true`), `${task} 층이 게이트를 안 받는다`);
  }
});
