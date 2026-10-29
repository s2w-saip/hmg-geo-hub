// 골격 e2e — **접수 202 → 상태 → 워커 실행 → 정산 → reply 되읽기** 가 끝까지 돈다.
//
// LLM 실비 0(스텁 엔진), Docker 0(PGlite), AWS 0. 이 테스트가 증명하는 것은 분석 품질이 아니라
// **경로가 이어져 있다는 것**이고, 그것이 G3-1 의 수용 기준이다. 품질은 G3-2 + 게이트 ①②③ 소관.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "../app/migrate.ts";
import { createServer } from "../app/server.ts";
import * as T from "../app/tickets.ts";
import {
  AnalysisMentionSchema,
  AnalysisReplySchema,
  AnalysisTicketRequestSchema,
  deterministicAnalysisTicketId,
} from "../contracts/index.ts";
import { Semaphore } from "../worker/concurrency.ts";
import { ContextCache } from "../worker/context-cache.ts";
import { createStubAnalysisEngine, AnalysisContractError, AnalysisDeferrable } from "../worker/engine.ts";
import { buildInvoker } from "../worker/invoker.ts";
import { allowScheduledLease, processTicket, recordCallUsage, replyForError, safeReplyForError, sanitizeStorableStrings, usageFromError, type WorkerDeps } from "../worker/main.ts";
import { resolveEngine } from "../worker/registry.ts";
import { createPgliteDb, type TestDb } from "./helpers/pglite-db.ts";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/analysis-ticket-request.v1.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

let db: TestDb;
let app: ReturnType<typeof createServer>;

/** 코어 `/api/internal/analysis-context` 대역. **네트워크를 타지 않는다.** */
// ⚠️ **실물 모양이다**(D-6). 스텁 엔진은 스냅샷을 파싱하지 않지만, 자리표시자가 틀린 모양을
//    들고 있으면 그 가짜가 다음 결함을 가린다 — `catalog` 은 `{entities, industry}` 이고
//    `grouping` 은 `{entityRules, surfaceRules}` 다(코어 `toAnalysisContextSnapshot`).
const SNAPSHOT = {
  catalog: { entities: [], industry: { ids: [], name: null, source: "none" } },
  rels: [],
  grouping: { entityRules: [], surfaceRules: [] },
  trackedAugmentTargets: [],
};
/** 티켓이 요구하는 버전. 봉투의 `version` 이 이것과 다르면 lane 이 **종결**한다(D-5). */
const CONTEXT_VERSION = String((FIXTURE.context as Record<string, unknown>).contextVersion);
/** 코어 200 응답은 **봉투**다 — `{version, snapshot}`(코어 route.ts:98~109). */
const envelope = (snapshot: unknown, version: string = CONTEXT_VERSION) => ({ status: 200, body: { version, snapshot } });
let contextFetches = 0;

function makeDeps(): WorkerDeps {
  const semaphore = new Semaphore(4);
  return {
    db,
    engine: createStubAnalysisEngine("stub-0"),
    llmSemaphore: semaphore,
    contextCache: new ContextCache({
      maxEntries: 8,
      maxBytes: 1_000_000,
      fetchTimeoutMs: 1000,
      dbCacheEnabled: true,
      fetchImpl: async () => {
        contextFetches += 1;
        return envelope(SNAPSHOT);
      },
    }),
    makeInvoker: (ticketId) =>
      buildInvoker({ semaphore, acquireTimeoutMs: 1000, requestTimeoutMs: 1000 }, async () => {
        throw new AnalysisContractError(`llm invoker not wired (G3-2); ticket=${ticketId}`);
      }),
  };
}

function ticketBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const turnRunId = (overrides.turnRunId as string) ?? String((FIXTURE.lineage as Record<string, unknown>).turnRunId);
  const workspaceId = String((FIXTURE.lineage as Record<string, unknown>).workspaceId);
  const analysisVersion = String(FIXTURE.analysisVersion);
  return {
    ...FIXTURE,
    ticketId: deterministicAnalysisTicketId(workspaceId, turnRunId, analysisVersion, 1),
    lineage: { ...(FIXTURE.lineage as object), turnRunId },
    turn: { ...(FIXTURE.turn as object), turnRunId, ...((overrides.turn as object) ?? {}) },
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    callbackUrl: null,
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/analysis-tickets", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  db = await createPgliteDb();
  await migrate(db);
  app = createServer({ db, coordination: () => ({ sample: null, error: null }) });
});

after(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE analysis_call_usage, analysis_callback_outbox, analysis_ticket_events, analysis_tickets CASCADE");
  await db.query("DELETE FROM analysis_contexts");
  contextFetches = 0;
});

test("full skeleton: 202 accept → status queued → worker runs stub → reply read-back", async () => {
  const body = ticketBody();
  const res = await post(body, { "idempotency-key": String(body.ticketId) });
  assert.equal(res.status, 202);
  const accepted = (await res.json()) as { ticketId: string; status: string; idempotentReplay: boolean };
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.idempotentReplay, false);

  const st1 = await app.request(`/v1/analysis-tickets/${accepted.ticketId}`);
  assert.equal(((await st1.json()) as { status: string }).status, "queued");

  // reply 가 아직 없으면 **204** — 404 가 아니다(측정 lane `GET .../reply` 와 같은 계약).
  assert.equal((await app.request(`/v1/analysis-tickets/${accepted.ticketId}/reply`)).status, 204);

  const deps = makeDeps();
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);
  assert.equal(await processTicket(deps, row), "completed");

  const st2 = await app.request(`/v1/analysis-tickets/${accepted.ticketId}`);
  assert.equal(((await st2.json()) as { status: string }).status, "completed");

  const replyRes = await app.request(`/v1/analysis-tickets/${accepted.ticketId}/reply`);
  assert.equal(replyRes.status, 200);
  const rawReply = await replyRes.json();
  const parsed = AnalysisReplySchema.parse(rawReply);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.analysisVersion, body.analysisVersion, "analysisVersion must be echoed verbatim");
  // D4 — sourceTurnHash 는 **요청값 에코**다. lane 은 rawResponse 가 없어 그 해시를 계산할 수 없다.
  assert.equal(parsed.result?.turn.sourceTurnHash, (body.turn as Record<string, unknown>).sourceTurnHash);
  assert.equal(parsed.evidence?.runtime.contextVersionUsed, (body.context as Record<string, unknown>).contextVersion);
  assert.equal(parsed.result?.turn.extractionMetadata.stub, true, "stub output must be self-identifying");
  // ⚠️ **게이트③ off 는 키가 아예 없다**(운영 결정 2026-09-13). 코어 `evidence.runtime` 은
  //    `.strict()` 라, 이 필드를 아직 모르는 코어(측정 워커 TD 240)에 `false` 라도 보내면
  //    답장이 통째로 거부된다 — 완주한 분석이 `output_contract` 로 버려지고 실비만 나간다.
  //    즉 lane 을 먼저 배포해도 **기본 태세(off)인 한 구버전 코어와 호환된다**.
  //    `parsed.evidence.runtime` 이 아니라 **원본 JSON** 을 본다 — 스키마 파싱은 optional 키의
  //    부재를 `undefined` 로 접어 "안 보냈다" 와 "보냈는데 undefined" 를 구분하지 못한다.
  const rawRuntime = (rawReply as { evidence: { runtime: Record<string, unknown> } }).evidence.runtime;
  assert.equal("cacheBust" in rawRuntime, false, "off 인데 cacheBust 키가 실렸다 — 구버전 코어가 답장을 거부한다");
});

test("replay: the same ticketId returns 202 with X-Idempotent-Replay and does not queue twice", async () => {
  const body = ticketBody();
  await post(body);
  const again = await post(body);
  assert.equal(again.status, 202);
  assert.equal(again.headers.get("X-Idempotent-Replay"), "true");
  const n = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_tickets");
  assert.equal(Number(n[0]?.n), 1);
});

test("Idempotency-Key that disagrees with ticketId is a 400", async () => {
  const res = await post(ticketBody(), { "idempotency-key": "11111111-1111-4111-8111-111111111111" });
  assert.equal(res.status, 400);
});

test("a turn over the 1 MiB cap is rejected at accept — the worker slot is never spent (A19)", async () => {
  const res = await post(ticketBody({ turn: { answerText: "가".repeat(400_000) } }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; issues: Array<{ loc: string[]; type: string }> };
  assert.equal(body.error, "contract");
  assert.equal(body.issues[0]?.type, "too_big");
  assert.equal(Number((await db.query<{ n: string }>("SELECT count(*) n FROM analysis_tickets"))[0]?.n), 0);
});

test("execution fields in options are rejected at the API boundary, not just in code review", async () => {
  const res = await post({ ...ticketBody(), options: { poolKey: "openai_direct" } });
  assert.equal(res.status, 400);
});

test("context snapshot is fetched once per version, then served from cache", async () => {
  const deps = makeDeps();
  for (const turnRunId of ["cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000002"]) {
    await post(ticketBody({ turnRunId }));
  }
  const rows = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(await processTicket(deps, row), "completed");
  assert.equal(contextFetches, 1, "same contextVersion must not be fetched twice");
  // 2차 캐시(lane PG)에도 적재됐다 — 태스크 교체 후에도 코어를 다시 치지 않는다.
  const cached = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_contexts");
  assert.equal(Number(cached[0]?.n), 1);
});

test("a context snapshot carrying entityNames is refused — persist-only data must not cross the boundary", async () => {
  const deps = makeDeps();
  deps.contextCache = new ContextCache({
    maxEntries: 4,
    maxBytes: 1_000_000,
    fetchTimeoutMs: 1000,
    dbCacheEnabled: false,
    fetchImpl: async () => envelope({ ...SNAPSHOT, entityNames: { "a": "b" } }),
  });
  await post(ticketBody());
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);
  // 경계 위반은 **분석 실패로 드러나야 한다** — 조용히 무시하면 그 필드가 정착한다.
  assert.equal(await processTicket(deps, row), "deferred");
  const rep = (await T.reply(db, row.ticket_id)) as { deferred: { detail: string } };
  assert.match(rep.deferred.detail, /entityNames/);
});

test("capacity exposes the D13 coordination block with nulls when no sample exists", async () => {
  const res = await app.request("/v1/capacity");
  assert.equal(res.status, 200);
  const cap = (await res.json()) as { coordination: { measurementQueueDepth: number | null; prewarmDesiredWorkers: number; vcpuBudget: { analysisMaxWorkers: number } } };
  assert.equal(cap.coordination.measurementQueueDepth, null);
  assert.equal(cap.coordination.prewarmDesiredWorkers, 0);
  assert.ok(cap.coordination.vcpuBudget.analysisMaxWorkers >= 0);
});

test("/metrics omits gauges whose value is unknown rather than emitting 0", async () => {
  const text = await (await app.request("/metrics")).text();
  assert.match(text, /^analysis_queue_depth \d+$/m);
  // 측정 샘플이 없으므로 그 게이지 **행 자체가 없어야** 한다 — 0 이면 "큐가 비었다"로 읽힌다.
  assert.doesNotMatch(text, /^analysis_measurement_queue_depth /m);
  assert.match(text, /# HELP analysis_measurement_queue_depth/);
});

test("DELETE cancels and the terminal reply body says cancelled — not a stale deferred body", async () => {
  const body = ticketBody();
  await post(body);
  const res = await app.request(`/v1/analysis-tickets/${body.ticketId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const rep = AnalysisReplySchema.parse(await (await app.request(`/v1/analysis-tickets/${body.ticketId}/reply`)).json());
  assert.equal(rep.status, "cancelled");
  assert.equal(rep.terminalReason, "permanent");
});

test("unknown ticket is a 404 on every read route", async () => {
  const id = "99999999-9999-4999-8999-999999999999";
  assert.equal((await app.request(`/v1/analysis-tickets/${id}`)).status, 404);
  assert.equal((await app.request(`/v1/analysis-tickets/${id}/reply`)).status, 404);
  assert.equal((await app.request(`/v1/analysis-tickets/${id}`, { method: "DELETE" })).status, 404);
});

test("error classification decides the retry policy (D5)", () => {
  const args = {
    ticketId: "6f3d6f7a-2f0e-5a2f-9c1b-0d4a3b5c6d7e",
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    analysisVersion: "v1",
    attempt: 2,
  };
  // 계약 위반 = 결정적 실패 → 재시도 없이 1회 종결
  const contract = replyForError({ ...args, error: new AnalysisContractError("bad shape") });
  assert.equal(contract.status, "failed");
  assert.equal(contract.terminalReason, "permanent");
  // 엔진이 재시도 가능하다고 말한 것 → deferred
  const deferrable = replyForError({ ...args, error: new AnalysisDeferrable("transient", 1234, "llm 503") });
  assert.equal(deferrable.status, "deferred");
  assert.equal(deferrable.deferred?.retryAfterMs, 1234);
  // 알 수 없는 예외 → transient + 지수 백오프
  const unknown = replyForError({ ...args, error: new Error("boom") });
  assert.equal(unknown.status, "deferred");
  assert.equal(unknown.deferred?.failureClass, "transient");
  assert.equal(unknown.deferred?.retryAfterMs, 10_000); // 5s × 2^(2-1)
});

test("unknown ANALYSIS_ENGINE fails loudly instead of silently falling back to the stub", () => {
  // G3-2: `core` 는 이제 실제 엔진이다(벤더된 순수 분석 코드). 판정은
  // `tests/golden-analysis-core.test.ts` 로 옮겼다 — 여기서는 **조용한 폴백이 없다**만 본다.
  assert.equal(resolveEngine("core", "0.0.0-dev").kind, "core");
  assert.throws(() => resolveEngine("camoufox", "x"), /unknown ANALYSIS_ENGINE/);
  assert.equal(resolveEngine("stub", "0.0.0-dev").kind, "stub");
});

test("the request stored in the ledger still has to pass strict validation on the worker side", async () => {
  await post(ticketBody());
  // 원장 안의 request 를 오염시킨다 — 측정 lane 8/25 사고(타입 캐스트 한 줄)의 재현 방지선.
  await db.query(`UPDATE analysis_tickets SET request = request || '{"rogueField": 1}'::jsonb`);
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);
  const outcome = await processTicket(makeDeps(), row);
  assert.notEqual(outcome, "completed", "a ticket that violates the contract must never be analyzed");
});

// 계약이 요구하는 것을 코드가 실제로 만족하는지 — fixture 는 모양을, 이것은 동작을 본다.
test("stub engine output satisfies the reply contract without touching an LLM", async () => {
  const engine = createStubAnalysisEngine("stub-0");
  const ticket = AnalysisTicketRequestSchema.parse(ticketBody());
  const out = await engine.analyzeTurn({
    ticket,
    context: { contextVersion: ticket.context.contextVersion, ...SNAPSHOT },
    llm: async () => {
      throw new Error("stub engine must not call the LLM");
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  });
  assert.equal(out.llmUsage.length, 0);
  assert.equal(out.turn.sourceTurnHash, ticket.turn.sourceTurnHash);
});

// ── 골격 검증 수정분 (F5 · F12 · F15) ────────────────────────────────────────────

test("reserved manual units are actually reserved — the last slots are manual-only (F5)", () => {
  // `reservedManualUnits` 는 설정에 있고 `/v1/capacity` 로 보고까지 됐지만 **아무도 읽지 않았다**:
  // 워커가 `allowScheduled: true` 를 하드코딩해서 빈 슬롯이 1개든 40개든 scheduled 를 집었다.
  // 그러면 케이던스가 함대를 채운 순간 사람이 누른 재분석이 앞 유닛들 뒤에 줄을 선다.
  assert.equal(allowScheduledLease(40, 2), true);
  assert.equal(allowScheduledLease(3, 2), true);
  assert.equal(allowScheduledLease(2, 2), false, "마지막 예약분은 manual 전용이다");
  assert.equal(allowScheduledLease(1, 2), false);
  assert.equal(allowScheduledLease(0, 2), false);
  // 예약 0 이면 옛 동작과 같다 — 빈 슬롯이 있으면 무엇이든 집는다.
  assert.equal(allowScheduledLease(1, 0), true);
});

test("callbackUrl scheme is narrowed to https (loopback http for local dev) (F12)", async () => {
  // lane 은 이 URL 로 **실제 요청을 보내는 주체**다(콜백 펌프). `z.url()` 만으로는
  // http://10.0.0.5/… · file:// · ftp:// 가 전부 통과한다 — 계약이 막을 수 있는 것을
  // 운영 신뢰에 맡기지 않는다.
  assert.equal((await post({ ...ticketBody(), callbackUrl: "https://scope.example.internal/cb" })).status, 202);
  for (const bad of ["http://10.0.0.5/cb", "ftp://scope.example.internal/cb", "http://evil.example.com/cb"]) {
    const res = await post({ ...ticketBody(), callbackUrl: bad });
    assert.equal(res.status, 400, `${bad} must be rejected at the contract boundary`);
  }
  // compose 로컬 스택은 루프백 http 로 돈다 — 그 문만 남긴다.
  assert.equal((await post({ ...ticketBody(), callbackUrl: "http://localhost:8080/cb" })).status, 202);
});

test("the call ledger records one row PER CALL with the engine's own outcome (F15)", async () => {
  // ⚠️ 초판은 `outcome='completed'`·`cost_source='vendor_reported'` 를 SQL 에 하드코딩하고
  //    실패 경로에서는 아예 쓰지 않았다. 그러면 `v_analysis_ticket_cost.wasted_cost_usd`(낭비)와
  //    `v_analysis_pool_activity.rate_limited_calls`(429 비율)가 **구조적으로 항상 0** 이다 —
  //    보라고 만든 뷰가 볼 것이 없다고 말한다(마이그레이션 0003 의 설계가 통째로 죽는다).
  const body = ticketBody();
  await post(body);
  const ticketId = String(body.ticketId);

  await recordCallUsage(db, {
    ticketId,
    attempt: 1,
    workerId: "w1",
    laneRevision: "stub-0",
    usage: [
      // ① 성공 — 벤더가 비용을 보고한 풀(OpenRouter)
      {
        task: "extract", poolKey: "openrouter", modelId: "m", inputTokens: 10, outputTokens: 20,
        latencyMs: 1200, costUsd: 0.0012, attempts: 1, outcome: "completed", costSource: "vendor_reported",
      },
      // ② 타임아웃 — **실비는 나갔고 비용은 미계측**이다. 0 으로 적으면 조용히 과소 집계된다.
      {
        task: "semantics", poolKey: "openai_direct", modelId: "m", inputTokens: 0, outputTokens: 0,
        latencyMs: 180_000, costUsd: 0, attempts: 1, outcome: "failed", errorClass: "transient",
      },
      // ③ 429 → 다른 풀로 페일오버. 모델은 안 바뀐다(스펙 §8.3).
      {
        task: "resolve", poolKey: "openrouter", modelId: "m", inputTokens: 5, outputTokens: 0,
        latencyMs: 300, costUsd: 0, attempts: 1, outcome: "failed_over", httpStatus: 429, errorClass: "capacity",
      },
    ],
  });

  const rows = await db.query<{ run_index: number; outcome: string; cost_source: string | null; http_status: number | null; error_class: string | null }>(
    "SELECT run_index, outcome, cost_source, http_status, error_class FROM analysis_call_usage WHERE ticket_id=$1 ORDER BY run_index",
    [ticketId],
  );
  assert.equal(rows.length, 3, "콜 1회 = 행 1개 — 실패 콜도 행을 남긴다");
  assert.deepEqual(rows.map((r) => r.outcome), ["completed", "failed", "failed_over"]);
  assert.equal(rows[0]?.cost_source, "vendor_reported");
  assert.equal(rows[1]?.cost_source, null, "출처를 모르면 NULL — 계산값을 vendor_reported 로 위조하지 않는다");
  assert.equal(rows[2]?.http_status, 429, "429 비율은 헬스 게이팅(§8.3)의 사후 검산 입력이다");
  assert.equal(rows[1]?.error_class, "transient");

  // 뷰가 낭비를 실제로 본다 — 초판에서는 이 값이 항상 0 이었다.
  const view = await db.query<{ calls: string; failover_calls: string; unmetered_calls: string }>(
    "SELECT calls, failover_calls, unmetered_calls FROM v_analysis_ticket_cost WHERE ticket_id=$1",
    [ticketId],
  );
  assert.equal(Number(view[0]?.calls), 3);
  assert.equal(Number(view[0]?.failover_calls), 1);
});

test("게이트③ — cache_bust 가 행에 남고 무캐시/캐시 구간이 뷰에서 갈린다 (0008)", async () => {
  // ⚠️ 시간 범위로 사후에 재구성하면 배포·재기동 경계가 섞인다. **행이 자기 태세를 들고 있어야**
  //    "이 실비는 캐시 없이 나온 값" 이 증명된다 — 섞인 창을 게이트③ 근거로 쓰는 것은 실패가
  //    아니라 오답이고, 아무 알람도 울지 않는다.
  const body = ticketBody({ turnRunId: "aaaa1111-0000-4000-8000-00000000000b" });
  await post(body);
  const ticketId = String(body.ticketId);

  await recordCallUsage(db, {
    ticketId,
    attempt: 1,
    workerId: "w1",
    laneRevision: "stub-0",
    usage: [
      // ① 무캐시 창의 콜
      {
        task: "extract", poolKey: "openrouter", modelId: "m", inputTokens: 4210, outputTokens: 318,
        latencyMs: 1200, costUsd: 0.004, attempts: 1, outcome: "completed", cacheBust: true,
      },
      // ② 캐시 켜진(기본) 창의 콜 — 같은 태스크라도 축이 갈려야 한다.
      {
        task: "extract", poolKey: "openrouter", modelId: "m", inputTokens: 4210, outputTokens: 318,
        latencyMs: 900, costUsd: 0.0018, attempts: 1, outcome: "completed", cacheBust: false,
      },
      // ③ 축을 아예 안 준 행(손으로 만든 원장·구 엔진) — **false 로 정규화**된다(NULL 아님).
      {
        task: "resolve", poolKey: "openrouter", modelId: "m", inputTokens: 1, outputTokens: 1,
        latencyMs: 100, costUsd: 0.0001, attempts: 1, outcome: "completed",
      },
    ],
  });

  const rows = await db.query<{ run_index: number; cache_bust: boolean }>(
    "SELECT run_index, cache_bust FROM analysis_call_usage WHERE ticket_id=$1 ORDER BY run_index",
    [ticketId],
  );
  assert.deepEqual(rows.map((r) => r.cache_bust), [true, false, false], "미기록은 false 다 — 스위치가 없었다 = 무효화하지 않았다");

  const view = await db.query<{ cache_bust: boolean; calls: string; cost_usd: string }>(
    "SELECT cache_bust, calls, cost_usd FROM v_analysis_cache_bust_cost WHERE task='extract' ORDER BY cache_bust",
    [],
  );
  assert.equal(view.length, 2, "무캐시/캐시가 한 줄로 합쳐지면 −55% 캐시 할인이 평균에 녹아 근거가 죽는다");
  assert.equal(view[0]?.cache_bust, false);
  assert.equal(Number(view[0]?.cost_usd), 0.0018);
  assert.equal(view[1]?.cache_bust, true);
  assert.equal(Number(view[1]?.cost_usd), 0.004);
});

test("콜 창은 **엔진이 잰 시각**을 그대로 적재한다 — 없을 때만 now()-latency 로 합성한다", async () => {
  // ⚠️ 초판은 두 컬럼을 무조건 `now() - make_interval(latency)` · `now()` 로 **합성**했다.
  //    계약에는 `startedAt`/`finishedAt` 이 이미 있었고 invoker 가 실측해서 보내는데도 버렸다.
  //    적재가 배치·재시도로 밀리면 창이 통째로 이동해 `v_analysis_pool_daily` 의 일자 버킷
  //    (`started_at AT TIME ZONE 'UTC'`)이 자정 근처에서 하루씩 어긋난다.
  const body = ticketBody({ turnRunId: "aaaa1111-0000-4000-8000-00000000000a" });
  await post(body);
  const ticketId = String(body.ticketId);
  const startedAt = "2026-09-01T00:00:10.000Z";
  const finishedAt = "2026-09-01T00:00:11.500Z";
  const longClass = "x".repeat(100);

  await recordCallUsage(db, {
    ticketId,
    attempt: 1,
    workerId: "w1",
    laneRevision: "stub-0",
    usage: [
      // ① 엔진이 창을 실측해 보낸 행 — 그 값이 그대로 가야 한다.
      {
        task: "extract", poolKey: "openrouter", modelId: "m", inputTokens: 1, outputTokens: 1,
        latencyMs: 1500, costUsd: null, attempts: 1, outcome: "completed", startedAt, finishedAt,
      },
      // ② 창이 없는 행(손으로 만든 원장·구 버전 엔진) — 합성 폴백이 살아 있어야 한다.
      //    `errorClass` 는 계약 상한(64)보다 길게 줘서 잘림도 함께 본다.
      {
        task: "resolve", poolKey: "openrouter", modelId: "m", inputTokens: null, outputTokens: null,
        latencyMs: 2000, costUsd: null, attempts: 1, outcome: "failed", errorClass: longClass,
      },
    ],
  });

  const rows = await db.query<{
    run_index: number; started_matches: boolean; finished_matches: boolean; span_s: number; recent: boolean; class_len: number;
  }>(
    `SELECT run_index,
            (started_at  = $2::timestamptz)                       AS started_matches,
            (finished_at = $3::timestamptz)                       AS finished_matches,
            EXTRACT(EPOCH FROM (finished_at - started_at))::float8 AS span_s,
            (finished_at > now() - interval '60 seconds')          AS recent,
            coalesce(length(error_class), 0)                       AS class_len
       FROM analysis_call_usage WHERE ticket_id=$1 ORDER BY run_index`,
    [ticketId, startedAt, finishedAt],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.started_matches, true, "엔진이 준 started_at 이 버려지고 적재 시점으로 덮였다");
  assert.equal(rows[0]?.finished_matches, true, "엔진이 준 finished_at 이 버려졌다");
  assert.equal(rows[1]?.started_matches, false, "창이 없는 행까지 남의 시각을 쓰면 안 된다");
  // 합성 폴백: 창의 길이가 latencyMs 와 같고, 적재 시점 근처여야 한다.
  assert.ok(Math.abs(Number(rows[1]?.span_s) - 2) < 0.5, `합성 창이 latencyMs 와 다르다: ${rows[1]?.span_s}s`);
  assert.equal(rows[1]?.recent, true, "합성 창이 적재 시점 근처가 아니다");
  // 계약(`AnalysisLlmUsageSchema.errorClass`)이 `.max(64)` 다 — 원장만 더 길게 받으면
  // 같은 값이 reply 검증에서는 튕기는 비대칭이 생긴다.
  assert.equal(Number(rows[1]?.class_len), 64, "errorClass 가 계약 상한(64)과 다른 길이로 잘렸다");
});

test("a turn that dies mid-way still books the calls it already burned (F15)", async () => {
  // 엔진이 중간까지 돌다 죽으면 그때까지의 콜 실비는 되돌아오지 않는다. 안 적으면
  // "실패한 턴은 공짜" 라는 그림이 된다 — 단위원가가 성공분에만 붙어 과소 집계된다.
  const err = Object.assign(new Error("llm 503"), {
    llmUsage: [
      { task: "extract", poolKey: "openrouter", modelId: "m", inputTokens: 9, outputTokens: 0, latencyMs: 700, costUsd: 0.0004, attempts: 1, outcome: "retried" },
    ],
  });
  assert.equal(usageFromError(err).length, 1);
  assert.deepEqual(usageFromError(new Error("no usage attached")), [], "usage 가 없으면 행을 지어내지 않는다");

  const body = ticketBody({ turnRunId: "aaaa1111-0000-4000-8000-000000000009" });
  await post(body);
  await recordCallUsage(db, { ticketId: String(body.ticketId), attempt: 2, workerId: "w1", laneRevision: "stub-0", usage: usageFromError(err) });
  const rows = await db.query<{ outcome: string; attempt: number }>(
    "SELECT outcome, attempt FROM analysis_call_usage WHERE ticket_id=$1",
    [String(body.ticketId)],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.outcome, "retried");
  assert.equal(Number(rows[0]?.attempt), 2);
});

// ── 답장 조립이 실패해도 **정산은 반드시 일어난다** (2026-09-13) ─────────────────
//
// `replyForError` 는 마지막에 `AnalysisReplySchema.parse` 를 탄다 — 즉 **자기가 던질 수 있다.**
// 초판은 그 예외가 `processTicket` 의 `catch` 안에서 나면서 `settle` 을 통째로 건너뛰었다.
// 그 티켓은 `running` 으로 남아 리스 TTL 까지 방치되고 → 리퍼가 회수 → **같은 턴을 처음부터
// 다시 돌린다** = 유료 LLM 2벌. 조립 버그 하나의 청구서가 재실행 비용인 구조다.

/** 조립을 확실히 터뜨리는 엔진: `retryAfterMs: NaN` 은 `z.number().int()` 를 통과하지 못한다. */
function poisonReplyEngine() {
  return {
    revision: "poison-0",
    kind: "stub",
    async analyzeTurn(): Promise<never> {
      throw new AnalysisDeferrable("transient", Number.NaN, "engine gave a non-integer backoff");
    },
  };
}

test("답장 조립이 던져도 티켓은 terminal 로 정산된다 — 리스 만료 → 리퍼 → 유료 재실행이 아니다", async () => {
  const deps = makeDeps();
  deps.engine = poisonReplyEngine();
  const body = ticketBody();
  await post(body);
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);

  const outcome = await processTicket(deps, row);
  assert.equal(outcome, "failed", "조립 실패가 deferred 로 둔갑하면 재시도가 같은 조립을 또 터뜨린다");

  const [t] = await db.query<{ status: string; terminal_reason: string | null; failure_reason: string | null }>(
    "SELECT status, terminal_reason, failure_reason FROM analysis_tickets WHERE ticket_id=$1",
    [String(body.ticketId)],
  );
  // **핵심 단언**: running 으로 남아 있지 않다. 남으면 리퍼가 회수해 LLM 을 다시 태운다.
  assert.equal(t?.status, "failed", `정산이 누락됐다 (status=${t?.status})`);
  assert.equal(t?.terminal_reason, "permanent", "재시도해도 같은 조립이 또 실패한다 — 1회 종결이 맞다");
  assert.match(String(t?.failure_reason), /reply build failed/);

  // 답장 본문도 되읽힌다(코어가 GET 으로 가져가는 그 본문) — 계약을 통과한 답장이어야 한다.
  const rep = (await T.reply(db, row.ticket_id)) as { status: string; terminalReason: string; ticketId: string };
  assert.equal(rep.status, "failed");
  assert.equal(rep.terminalReason, "permanent");
  assert.equal(rep.ticketId, String(body.ticketId));
});

test("safeReplyForError: 조립 실패를 error 로그로 표면화하고 최소 실패 답장을 낸다 (무음 0)", () => {
  const captured: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    captured.push(String(chunk));
    return true;
  };
  let rep: ReturnType<typeof safeReplyForError>;
  try {
    rep = safeReplyForError({
      ticketId: String(ticketBody().ticketId),
      traceId: String(FIXTURE.traceId),
      analysisVersion: String(FIXTURE.analysisVersion),
      attempt: 1,
      error: new AnalysisDeferrable("transient", Number.NaN, "bad backoff"),
    });
  } finally {
    (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
  }

  assert.equal(rep.status, "failed");
  assert.equal(rep.terminalReason, "permanent");
  assert.equal(rep.deferred, null);
  assert.match(String(rep.failureReason), /reply build failed/);
  // 상관관계 축은 살아 있어야 한다 — 조립만 실패했지 티켓 좌표는 멀쩡하다.
  assert.equal(rep.traceId, String(FIXTURE.traceId));
  assert.equal(rep.analysisVersion, String(FIXTURE.analysisVersion));

  const line = captured.find((l) => l.includes("analysis_lane.reply_build_failed"));
  assert.ok(line, `조립 실패가 조용히 지나갔다 (stderr=${captured.join("").slice(0, 300)})`);
  const parsed = JSON.parse(line!.trim()) as Record<string, unknown>;
  assert.equal(parsed.level, "error");
  // 원 예외도 함께 남아야 한다 — 조립 실패만 남으면 "무엇을 처리하다 실패했나" 가 사라진다.
  assert.match(String(parsed.originalError), /AnalysisDeferrable: bad backoff/);
});

test("safeReplyForError: traceId 가 계약을 못 통과해도 답장이 나온다 (정산 포기 < 자리표시자)", () => {
  const rep = safeReplyForError({
    ticketId: String(ticketBody().ticketId),
    traceId: "not-a-uuid", // 티켓 파싱 실패 시 DB 행 값이 그대로 남는 경로
    analysisVersion: "",
    attempt: 2,
    error: new Error("boom"),
  });
  assert.equal(rep.status, "failed");
  assert.equal(rep.terminalReason, "permanent");
  // 지어낸 값임이 **값만 보고도** 드러나야 한다.
  assert.equal(rep.traceId, "00000000-0000-4000-8000-000000000000");
  assert.equal(rep.analysisVersion, "unknown");
  // 표식은 **맨 앞**이어야 한다 — 뒤에 붙이면 `.max(512)` 절단에 먹혀 사라진다(실제로 잘렸다).
  assert.match(String(rep.failureReason), /^traceId\/analysisVersion replaced/);
});

test("정상 경로에서는 safeReplyForError 가 replyForError 와 **같은 답장**이다 (감싸기가 분류를 안 바꾼다)", () => {
  const args = {
    ticketId: String(ticketBody().ticketId),
    traceId: String(FIXTURE.traceId),
    analysisVersion: String(FIXTURE.analysisVersion),
    attempt: 2,
    error: new AnalysisDeferrable("capacity", 15_000, "slots busy"),
  };
  const a = replyForError(args);
  const b = safeReplyForError(args);
  assert.deepEqual({ ...a, finishedAt: "" }, { ...b, finishedAt: "" });
  assert.equal(b.status, "deferred");
  assert.equal(b.deferred?.retryAfterMs, 15_000);
});

// ── 검증자 잔여 리스크 하드닝 ② : 답변 본문의 U+0000 ─────────────────────────────
//
//   포스트그레스는 `jsonb` 문자열의 U+0000 을 `unsupported Unicode escape sequence` 로
//   **거부한다**(PGlite 실측 — `tests/jsonb-params.test.ts` 의 같은 이름 테스트). 그 거부가
//   터지는 자리가 둘이고 둘 다 완주한 분석을 버린다:
//     ① lane `settle` 의 `reply=$n::jsonb` → 정산 실패 → 리스 만료 → 리퍼 → **유료 재실행**
//     ② 코어 shadow INSERT → lane 은 completed 인데 코어에는 결과가 없다(무음 유실)
//   답변 본문은 임의의 사용자 데이터라 모델이 NUL 을 뱉는 경로를 lane 이 막을 수 없다 →
//   **나가는 경계에서 턴다**(`worker/main.ts` `stripNulChars`).
const NUL = "\u0000";

/** 계약을 통과하는 최소 멘션 — `contextSnippet`·`surfaceText` 에 NUL 을 심는다. */
const MENTION_WITH_NUL = {
  entityId: null,
  entityType: null,
  surfaceText: `LG${NUL} 스타일러`,
  surfaceNormalized: "lg 스타일러",
  surfaceHash: "deadbeef",
  resolutionStatus: "pending",
  resolutionMethod: "llm_proposal",
  resolutionConfidence: 0.5,
  mentionPosition: 0,
  mentionRole: "shortlist_candidate",
  assertion: "recommend",
  sentiment: "neutral",
  contextSnippet: `…${NUL}추천드립니다${NUL}`,
  descriptors: [`조용함${NUL}`],
  criteria: [],
  extractionMetadata: { [`note${NUL}`]: `값${NUL}` },
};

test("답변 본문의 U+0000 은 답장에서 사라진다 — 그 외 바이트는 동일하고 정산이 성공한다", async () => {
  const deps = makeDeps();
  const stub = createStubAnalysisEngine("stub-nul");
  deps.engine = {
    revision: stub.revision,
    kind: stub.kind,
    async analyzeTurn(input) {
      const out = await stub.analyzeTurn(input);
      // 스키마로 통과시켜 **계약상 정상인 멘션**임을 못박는다(NUL 은 zod 가 건드리지 않는다).
      return { ...out, turn: { ...out.turn, mentions: [AnalysisMentionSchema.parse(structuredClone(MENTION_WITH_NUL))] } };
    },
  };

  const body = ticketBody();
  await post(body);
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);
  // ⚠️ 이 단언이 **하드닝 전에는 실패한다** — `settle` 의 jsonb INSERT 가 NUL 에서 죽는다.
  assert.equal(await processTicket(deps, row), "completed");

  const replyRes = await app.request(`/v1/analysis-tickets/${String(body.ticketId)}/reply`);
  assert.equal(replyRes.status, 200, "정산이 죽으면 reply 가 없다");
  const raw = await replyRes.text();
  assert.equal(raw.includes(NUL), false, "답장 본문에 NUL 이 남아 있다");
  assert.equal(raw.includes("\\u0000"), false, "이스케이프된 NUL 도 남아 있으면 안 된다(코어 jsonb 가 거부한다)");

  const parsed = AnalysisReplySchema.parse(JSON.parse(raw));
  const m = parsed.result?.turn.mentions[0];
  assert.ok(m);
  // **그 외 바이트는 동일하다** — NUL 만 빠진 문자열이어야 한다(치환 문자를 넣지 않는다).
  assert.equal(m.contextSnippet, "…추천드립니다");
  assert.equal(m.surfaceText, "LG 스타일러");
  assert.deepEqual(m.descriptors, ["조용함"]);
  assert.equal(m.surfaceNormalized, MENTION_WITH_NUL.surfaceNormalized, "NUL 이 없던 값은 그대로다");
  assert.equal(m.resolutionConfidence, 0.5, "숫자 축은 건드리지 않는다");
  // 키 이름의 NUL 도 털린다 — 키에 남으면 같은 jsonb 거부가 난다.
  assert.deepEqual(Object.keys(m.extractionMetadata), ["note"]);
  assert.equal(m.extractionMetadata.note, "값");
});

// ── 검증자 잔여 리스크 하드닝 ③ : 짝 없는 서로게이트 (C-1) ─────────────────────
//
//   ②(U+0000)와 **완전히 같은 실패 경로인데 초판이 반만 막았다.** `stripNulChars` 는 U+0000 만
//   털었고, 답변에 짝 없는 서로게이트가 하나 들어오면 `settle` 의 `reply=$7::jsonb` 가
//   `invalid input syntax for type json`(22P02)으로 죽는다 → 티켓 `running` 잔존 → 리스 만료 →
//   리퍼 → **유료 LLM 재실행 ×3** → `cap_exhausted`. 코어는 이 둘을 `lib/db/jsonb-param.ts`
//   `toStorableText` 에서 **같이** 다룬다(2026-08-18 서로게이트 · 2026-08-22 제어문자).
//
//   ⚠️ 서로게이트가 답변에 들어오는 경로는 실재한다: 창 절단이 이모지를 반토막 내거나(코어가
//      실제로 겪은 것), 모델이 그냥 그런 UTF-16 단위를 뱉거나. lane 이 막을 수 있는 자리는
//      **나가는 경계** 하나뿐이다.
//
//   ⚠️ PGlite 도 이 갈래를 **본다**(2026-09-13 실측 — `tests/jsonb-params.test.ts` ⑥). 드라이버
//      경계까지 포함한 확인은 실 PG 옵트인 테스트(`tests/live-pg-sanitize.test.ts`)가 맡는다.
const LONE_SURROGATE = "\uD83D";
const BELL = "\u0007"; // C0 — 저장은 되지만 무의미하고 재수출에서 깨진다
const TAB_NEWLINE = "\t\n"; // **보존돼야 한다** — 답변 서식이다

const MENTION_WITH_SURROGATE = {
  entityId: null,
  entityType: null,
  surfaceText: `LG${LONE_SURROGATE} 스타일러`,
  surfaceNormalized: "lg 스타일러",
  surfaceHash: "deadbeef",
  resolutionStatus: "pending",
  resolutionMethod: "llm_proposal",
  resolutionConfidence: 0.5,
  mentionPosition: 0,
  mentionRole: "shortlist_candidate",
  assertion: "recommend",
  sentiment: "neutral",
  contextSnippet: `줄1${TAB_NEWLINE}줄2${BELL}${LONE_SURROGATE}`,
  descriptors: [`조용함${LONE_SURROGATE}`],
  criteria: [],
  extractionMetadata: { [`note${LONE_SURROGATE}`]: `값${BELL}` },
};

test("답변 본문의 짝 없는 서로게이트는 U+FFFD 가 되고 정산이 성공한다 (C-1)", async () => {
  const deps = makeDeps();
  const stub = createStubAnalysisEngine("stub-surrogate");
  deps.engine = {
    revision: stub.revision,
    kind: stub.kind,
    async analyzeTurn(input) {
      const out = await stub.analyzeTurn(input);
      return { ...out, turn: { ...out.turn, mentions: [AnalysisMentionSchema.parse(structuredClone(MENTION_WITH_SURROGATE))] } };
    },
  };

  const body = ticketBody();
  await post(body);
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "w1", ttlSeconds: 1200, allowScheduled: true, limit: 10, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);
  // ⚠️ 이 단언이 **하드닝 전에는 실패한다** — `settle` 의 jsonb 바인드가 22P02 로 죽는다.
  assert.equal(await processTicket(deps, row), "completed");

  const replyRes = await app.request(`/v1/analysis-tickets/${String(body.ticketId)}/reply`);
  assert.equal(replyRes.status, 200, "정산이 죽으면 reply 가 없다");
  const parsed = AnalysisReplySchema.parse(JSON.parse(await replyRes.text()));
  const m = parsed.result?.turn.mentions[0];
  assert.ok(m);

  // 서로게이트는 **치환**(제거가 아니다) — text 컬럼이 이미 하는 손실과 같은 모양이어야 한다.
  assert.equal(m.surfaceText, "LG� 스타일러");
  assert.deepEqual(m.descriptors, ["조용함�"]);
  // C0 는 제거, 탭·개행은 **보존**.
  assert.equal(m.contextSnippet, `줄1${TAB_NEWLINE}줄2�`);
  // 키 이름도 정화된다 — 키에 남으면 같은 jsonb 거부가 난다.
  assert.deepEqual(Object.keys(m.extractionMetadata), ["note�"]);
  assert.equal(m.extractionMetadata["note�"], "값");
  assert.equal(m.surfaceNormalized, MENTION_WITH_SURROGATE.surfaceNormalized, "정상 값은 그대로다");
});

test("실패 답장의 자유문(failureReason·deferred.detail)도 정화된다 — 같은 jsonb 안으로 들어간다 (C-1)", () => {
  // ⚠️ 초판이 `result`·`evidence` 만 감싸서 빠뜨렸던 자리다. 예외 메시지는 모델 출력을 그대로
  //    품을 수 있다(파싱 실패 메시지에 답변 조각이 들어간다).
  const dirty = `bad json near LG${LONE_SURROGATE}${BELL}`;
  const errArgs = {
    ticketId: "6f3d6f7a-2f0e-5a2f-9c1b-0d4a3b5c6d7e",
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    analysisVersion: "v1",
    attempt: 1,
  };
  const contract = replyForError({ ...errArgs, error: new AnalysisContractError(dirty) });
  assert.equal(contract.failureReason, "bad json near LG�");

  const deferred = replyForError({ ...errArgs, error: new AnalysisDeferrable("transient", 1000, dirty) });
  assert.equal(deferred.deferred?.detail, "bad json near LG�");

  // 답장 전체에 서로게이트·C0 가 **하나도** 안 남는다 = jsonb 가 거부할 이유가 없다.
  const blob = JSON.stringify([contract, deferred]);
  assert.equal(/\\u000[0-8bcef]|\\u001|\\u007f/i.test(blob), false, blob.slice(0, 200));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(blob), false);
});

test("sanitizeStorableStrings 는 코어 toStorableText 와 같은 정책이다 (짝 맞는 서로게이트는 살린다)", () => {
  // 정상 이모지(짝이 맞는 서로게이트 쌍)는 **건드리지 않는다** — 안 그러면 답변이 상한다.
  const emoji = "좋아요 👍";
  assert.equal(sanitizeStorableStrings(emoji), emoji);
  // 짝 없는 low 도 잡는다(앞에 high 가 없는 경우).
  assert.equal(sanitizeStorableStrings(`x\uDC4Dy`), "x�y");
  // 멱등 — 두 번 적용해도 같다.
  const once = sanitizeStorableStrings(`a\uD83D${BELL}b`);
  assert.equal(sanitizeStorableStrings(once), once);
  // NUL 은 그대로 **제거**다(② 의 계약이 안 바뀐다).
  assert.equal(sanitizeStorableStrings(`x${NUL}y`), "xy");
});

test("sanitizeStorableStrings 는 원본을 건드리지 않는다 — 같은 객체가 원장·로그로도 간다", () => {
  const src = { a: `x${NUL}y`, nested: [{ b: `p${NUL}` }] };
  const out = sanitizeStorableStrings(src);
  assert.equal(src.a, `x${NUL}y`, "원본이 변형됐다");
  assert.equal(out.a, "xy");
  assert.equal(out.nested[0]!.b, "p");
  assert.notEqual(out, src);
});
