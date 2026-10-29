// 큐·리스 로직 — **진짜 Postgres(PGlite)에서 실제 SQL 을 돌린다.**
// 마이그레이션도 라이브와 같은 파일을 같은 마이그레이터로 적용한다: 부분 인덱스·`to_regclass`
// 가드·`make_interval`·advisory lock 이 전부 실행된다.
//
// ── 이 파일이 잡는 변이 / 못 잡는 변이 (골격 검증 F10 — 정직하게 적는다)
//
//   잡는다:
//     · 누적 리스 상한을 **워커 메모리로 옮기는** 변이 → "the cumulative cap lives in the ROW"
//     · 누적에 **TTL 을 더하는** 변이 → "heartbeat accrues the HEARTBEAT interval"
//     · `expireDeadlines` 가 **답장 본문을 안 고치는** 변이 → "stamps a DEFERRED reply body"
//     · 리퍼 순서를 chronic-먼저로 되돌리는 변이 → "sweep order decides terminal_reason"
//     · manual 재분석을 중복으로 **취소하는** 변이 → "a manual re-analysis is never dropped"
//     · 마감 스윕 부분 인덱스와 술어가 **갈리는** 변이 → "deadline sweep uses its partial index"
//
//   못 잡는다 (PGlite 는 **단일 커넥션**이다 — 헬퍼 상단 ⚠️ 와 같은 한계):
//     · M1 `FOR UPDATE SKIP LOCKED` 제거 — 두 워커가 같은 행을 동시에 집는 경합이 재현 안 된다.
//       단일 커넥션에서는 SKIP LOCKED 가 있으나 없으나 같은 결과가 나온다.
//     · M3 `claimSweep` 의 advisory **xact** lock 을 세션 lock 으로 바꾸는 변이 — 피닝은 RDS
//       Proxy 뒤에서만 드러나고, 동시 클레임 경합도 커넥션이 하나면 재현되지 않는다.
//     둘 다 **스테이징 실측이 판정한다**(스펙 §9 단계 4~). 여기서 통과했다는 것이 그 둘의
//     증명이 아니라는 사실을 이 주석이 남긴다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "../app/migrate.ts";
import * as T from "../app/tickets.ts";
import { AnalysisReplySchema, AnalysisTicketRequestSchema, deterministicAnalysisTicketId } from "../contracts/index.ts";
import { trimContextTable } from "../worker/context-cache.ts";
import { createPgliteDb, type TestDb } from "./helpers/pglite-db.ts";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/analysis-ticket-request.v1.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

let db: TestDb;

const LEASE = {
  workerId: "w1",
  ttlSeconds: 1200,
  allowScheduled: true,
  limit: 10,
  minRunwaySeconds: 120,
  maxAttempts: 3,
};

function ticket(overrides: Record<string, unknown> = {}) {
  const turnRunId = (overrides.turnRunId as string) ?? String((FIXTURE.lineage as Record<string, unknown>).turnRunId);
  const analysisVersion = (overrides.analysisVersion as string) ?? (FIXTURE.analysisVersion as string);
  const attempt = (overrides.attempt as number) ?? 1;
  const workspaceId = String((FIXTURE.lineage as Record<string, unknown>).workspaceId);
  const raw = {
    ...FIXTURE,
    ticketId: deterministicAnalysisTicketId(workspaceId, turnRunId, analysisVersion, attempt),
    analysisVersion,
    lineage: { ...(FIXTURE.lineage as object), turnRunId },
    turn: { ...(FIXTURE.turn as object), turnRunId },
    deadlineAt: (overrides.deadlineAt as string) ?? new Date(Date.now() + 6 * 3600_000).toISOString(),
    priority: (overrides.priority as string) ?? "scheduled",
    callbackUrl: overrides.callbackUrl === undefined ? null : (overrides.callbackUrl as string | null),
  };
  return AnalysisTicketRequestSchema.parse(raw);
}

before(async () => {
  db = await createPgliteDb();
  const applied = await migrate(db);
  assert.ok(applied.length >= 4, `expected all migrations applied, got ${applied.join(",")}`);
});

after(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query(
    "TRUNCATE analysis_contexts, analysis_call_usage, analysis_callback_outbox, analysis_ticket_events, analysis_worker_gauges, analysis_tickets CASCADE",
  );
});

test("migrations are idempotent and refuse silent edits", async () => {
  const again = await migrate(db);
  assert.deepEqual(again, [], "re-running migrations must be a no-op");
});

test("accept is idempotent — the same ticketId never doubles execution (A5)", async () => {
  const req = ticket();
  const first = await db.begin((tx) => T.accept(tx, req));
  assert.equal(first.replay, false);
  const second = await db.begin((tx) => T.accept(tx, req));
  assert.equal(second.replay, true);
  assert.equal(second.accepted.acceptedAt, first.accepted.acceptedAt);
  const rows = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_tickets");
  assert.equal(Number(rows[0]?.n), 1);
});

test("lease moves queued → leased, bumps attempt, and is not re-leasable", async () => {
  await db.begin((tx) => T.accept(tx, ticket()));
  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 1);
  assert.equal(Number(leased[0]?.attempt_count), 1);
  const again = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(again.length, 0, "a leased ticket must not be picked again");
});

test("manual priority is picked before scheduled", async () => {
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "aaaaaaaa-0000-4000-8000-000000000001" })));
  await db.begin((tx) =>
    T.accept(tx, ticket({ turnRunId: "aaaaaaaa-0000-4000-8000-000000000002", priority: "manual" })),
  );
  const leased = await db.begin((tx) => T.leaseBatch(tx, { ...LEASE, limit: 1 }));
  assert.equal(leased[0]?.turn_run_id, "aaaaaaaa-0000-4000-8000-000000000002");
});

test("tickets near their deadline are not leased — slots are not spent on doomed work", async () => {
  await db.begin((tx) => T.accept(tx, ticket({ deadlineAt: new Date(Date.now() + 30_000).toISOString() })));
  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 0);
});

test("bare query_run 티켓이 접수된다 — 계약이 넓어졌으면 컬럼도 같이 넓어져야 한다 (0006)", async () => {
  // ⚠️ 계약만 고치고 컬럼을 그대로 두면 **스키마는 통과한 티켓이 INSERT 에서 죽는다.** 그때 API 는
  //    400 이 아니라 500 을 내고, 코어 클라이언트는 5xx 를 transient 로 보고 영원히 재시도한다
  //    (`client.ts:45`). 그래서 계약·마이그레이션을 한 커밋에 묶고 여기서 함께 단언한다.
  const req = AnalysisTicketRequestSchema.parse({
    ...ticket({ turnRunId: "66666666-6666-4666-8666-666666666666" }),
    lineage: {
      ...(FIXTURE.lineage as object),
      turnRunId: "66666666-6666-4666-8666-666666666666",
      projectId: null,
      promptRunId: null,
    },
    turn: { ...(FIXTURE.turn as object), turnRunId: "66666666-6666-4666-8666-666666666666", answerText: null, region: null },
    context: { ...(FIXTURE.context as object), contextVersion: "unscoped:a1b2c3d4e5f60718" },
    industry: { ids: [], name: null, source: "none" },
  });
  const { accepted } = await db.begin((tx) => T.accept(tx, req));
  assert.equal(accepted.status, "queued");
  const rows = await db.query<{ project_id: string | null }>("SELECT project_id FROM analysis_tickets WHERE ticket_id=$1", [req.ticketId]);
  assert.equal(rows[0]?.project_id, null, "project_id 는 NULL 로 들어가야 한다");
  // 워커가 그 티켓을 실제로 집을 수 있어야 한다 — 접수만 되고 못 집으면 조용히 쌓인다.
  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 1);
});

test("settle(deferred) sets next_eligible_at from retryAfterMs and re-leases after it passes", async () => {
  const req = ticket();
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: row.ticket_id,
    traceId: row.trace_id,
    status: "deferred",
    finishedAt: new Date().toISOString(),
    analysisVersion: req.analysisVersion,
    result: null,
    evidence: null,
    deferred: { failureClass: "transient", retryAfterMs: 60_000, detail: "llm 503" },
    failureReason: null,
    terminalReason: null,
  });
  assert.equal(await db.begin((tx) => T.settle(tx, row.ticket_id, row.lease_token, rep)), true);

  const st = await T.status(db, row.ticket_id);
  assert.equal(st?.status, "deferred");
  assert.equal(st?.deferred?.failureClass, "transient");

  // 아직 시간이 안 됐으면 안 잡힌다
  assert.equal((await db.begin((tx) => T.leaseBatch(tx, LEASE))).length, 0);
  // 시간이 지나면 잡힌다 (별도 redrive 없이 픽 쿼리가 deferred 도 본다)
  await db.query("UPDATE analysis_tickets SET next_eligible_at = now() - interval '1 second'");
  assert.equal((await db.begin((tx) => T.leaseBatch(tx, LEASE))).length, 1);
});

test("settle is rejected once the lease is lost — stale results must not overwrite", async () => {
  const req = ticket();
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: row.ticket_id,
    traceId: row.trace_id,
    status: "completed",
    finishedAt: new Date().toISOString(),
    analysisVersion: req.analysisVersion,
    result: {
      // `quality` 는 계약으로 좁혀졌고, **버전 4종은 계약에서 빠졌다**(코어 정본이 그 넷을
      // 빼고 `.strict()` — persist 는 코어가 자기 `options` 값을 쓴다).
      turn: {
        turnRunId: req.turn.turnRunId,
        quality: { qualityState: "valid_answer", reason: "ok", answerChars: 0 },
        mentions: [],
        candidates: [],
        modelSlug: null,
        extractionMetadata: {},
        sourceTurnHash: req.turn.sourceTurnHash,
        failed: false,
        failureDetail: null,
      },
      citationClassifications: [],
    },
    evidence: { llmUsage: [], runtime: { laneRevision: "stub-0", contextVersionUsed: req.context.contextVersion, parallelFlags: {} } },
    deferred: null,
    failureReason: null,
    terminalReason: null,
  });
  const wrongToken = "00000000-0000-4000-8000-000000000000";
  assert.equal(await db.begin((tx) => T.settle(tx, row.ticket_id, wrongToken, rep)), false);
  assert.equal((await T.status(db, row.ticket_id))?.status, "leased", "a rejected settle must leave the ticket untouched");
  assert.equal(await db.begin((tx) => T.settle(tx, row.ticket_id, row.lease_token, rep)), true);
  assert.equal((await T.status(db, row.ticket_id))?.status, "completed");
});

test("heartbeat accrues the HEARTBEAT interval, not the lease TTL — a healthy turn is not cut at 2 minutes", async () => {
  // ⚠️ 결함 고정 테스트였던 자리다. 초판은 누적에 TTL(1,200s)을 더했고 이 테스트가 "3번째에
  //    false" 를 **정답으로 박아** 두어, 60초마다 1,200 을 적립하는 버그를 통과시켰다.
  //    실제 의미: 정상 유닛(1턴 최악 p95 ~256s)이 **2분 만에** 리스를 잃고, 리퍼가 큐로 되돌리고,
  //    attempt 가 오르고, 재실행마다 유료 LLM 콜이 또 나간다. 상한이 아니라 실비 증폭기였다.
  await db.begin((tx) => T.accept(tx, ticket()));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);

  const id = row.ticket_id;
  const token = row.lease_token;
  const beat = (): Promise<boolean> => db.begin((tx) => T.heartbeat(tx, id, token, 1200, 2400, 60));

  // 60s 하트비트를 10회(= 실제 10분 보유) 쳐도 누적은 600s 라 계속 임대 상태다.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await beat(), true, `heartbeat #${i + 1} must keep the lease (accumulated ${(i + 1) * 60}s < 2400s)`);
  }
  const elapsed = (await db.query<{ e: string }>("SELECT lease_elapsed_s e FROM analysis_tickets WHERE ticket_id=$1", [id]))[0];
  assert.equal(Number(elapsed?.e), 600, "누적은 벽시계(간격 × 횟수)여야 한다 — TTL 의 배수가 아니다");

  // 그리고 상한은 여전히 작동한다: 40회(= 2,400s)까지만.
  for (let i = 10; i < 40; i += 1) {
    assert.equal(await beat(), true);
  }
  assert.equal(await beat(), false, "누적 2,400s 를 넘으면 갱신이 멈춘다 — 포이즌 유닛이 워커를 영원히 잡지 못하게");
});

test("the cumulative cap lives in the ROW, not in worker memory — a restarted worker cannot reset it", async () => {
  // 변이 감지(F10): 누적을 워커 프로세스 메모리로 옮기면 이 단언이 깨진다. 재기동한 워커는
  // 카운터가 0 이므로 같은 포이즌 유닛을 영원히 다시 잡는다(app/tickets.ts heartbeat 주석).
  await db.begin((tx) => T.accept(tx, ticket()));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  // "다른 프로세스가 이미 상한까지 썼다" 는 상태를 **원장에만** 만든다 — 이 테스트는 하트비트를
  // 한 번도 안 쳤다. 그래도 첫 갱신이 거절돼야 한다.
  await db.query("UPDATE analysis_tickets SET lease_elapsed_s = 2400 WHERE ticket_id=$1", [row.ticket_id]);
  assert.equal(
    await db.begin((tx) => T.heartbeat(tx, row.ticket_id, row.lease_token, 1200, 2400, 60)),
    false,
    "판정의 입력은 행의 lease_elapsed_s 다 — 프로세스 메모리가 아니다",
  );
});

test("expired leases are returned to the queue without refunding attempts", async () => {
  await db.begin((tx) => T.accept(tx, ticket()));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  await db.query("UPDATE analysis_tickets SET leased_until = now() - interval '1 second'");
  assert.equal(await db.begin((tx) => T.reapExpiredLeases(tx)), 1);
  const after = await db.query<{ status: string; attempt_count: number }>(
    "SELECT status, attempt_count FROM analysis_tickets WHERE ticket_id=$1",
    [row.ticket_id],
  );
  assert.equal(after[0]?.status, "queued");
  assert.equal(Number(after[0]?.attempt_count), 1, "attempt must not be refunded — the LLM spend already happened");
});

test("deadline reaper is two-stage: deferred(deadline) stamp, then terminal GC after grace", async () => {
  await db.begin((tx) => T.accept(tx, ticket()));
  await db.query("UPDATE analysis_tickets SET deadline_at = now() - interval '10 minutes'");

  assert.equal(await db.begin((tx) => T.expireDeadlines(tx)), 1);
  let st = await T.status(db, (await db.query<{ ticket_id: string }>("SELECT ticket_id FROM analysis_tickets"))[0]!.ticket_id);
  assert.equal(st?.status, "deferred");
  assert.equal(st?.deferred?.failureClass, "deadline");

  // grace 전에는 GC 하지 않는다
  assert.equal(await db.begin((tx) => T.reapExpired(tx, 3600)), 0);
  // grace 이후 terminal
  assert.equal(await db.begin((tx) => T.reapExpired(tx, 300)), 1);
  const row = (await db.query<{ status: string; terminal_reason: string; reply: unknown }>(
    "SELECT status, terminal_reason, reply FROM analysis_tickets",
  ))[0];
  assert.equal(row?.status, "failed");
  assert.equal(row?.terminal_reason, "deadline_exceeded");
  // ⚠️ 답장 본문도 terminal 이어야 한다 — 컬럼만 바꾸고 reply 를 deferred 로 두면 코어가
  //    retryable 로 읽어 재발행한다(측정 lane 2026-08-26 재시도 증폭 사고).
  assert.equal((row?.reply as { status: string }).status, "failed");
});

test("chronic reaper closes attempt-exhausted tickets as cap_exhausted with a terminal reply", async () => {
  await db.begin((tx) => T.accept(tx, ticket()));
  await db.query("UPDATE analysis_tickets SET attempt_count = 3");
  assert.equal(await db.begin((tx) => T.reapChronic(tx, 3)), 1);
  const row = (await db.query<{ status: string; terminal_reason: string; reply: { status: string; terminalReason: string } }>(
    "SELECT status, terminal_reason, reply FROM analysis_tickets",
  ))[0];
  assert.equal(row?.status, "failed");
  assert.equal(row?.terminal_reason, "cap_exhausted");
  assert.equal(row?.reply.status, "failed");
  assert.equal(row?.reply.terminalReason, "cap_exhausted");
});

test("attempt-exhausted tickets are no longer leasable", async () => {
  await db.begin((tx) => T.accept(tx, ticket()));
  await db.query("UPDATE analysis_tickets SET attempt_count = 3");
  assert.equal((await db.begin((tx) => T.leaseBatch(tx, LEASE))).length, 0);
});

test("duplicate of a completed turn is cancelled before it burns an LLM call", async () => {
  const first = ticket({ attempt: 1 });
  await db.begin((tx) => T.accept(tx, first));
  await db.query("UPDATE analysis_tickets SET status='completed', finished_at=now()");

  // 코어가 attempt 를 올려 재발행한 형태 — 같은 턴·같은 버전, 다른 ticketId
  const second = ticket({ attempt: 2 });
  await db.begin((tx) => T.accept(tx, second));
  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 0, "duplicate must be dropped before execution");

  const row = (await db.query<{ status: string; failure_reason: string }>(
    "SELECT status, failure_reason FROM analysis_tickets WHERE ticket_id=$1",
    [second.ticketId],
  ))[0];
  assert.equal(row?.status, "cancelled");
  assert.equal(row?.failure_reason, T.DUPLICATE_CANCEL_REASON);
  assert.equal(await T.duplicateCompletions1d(db), 0, "cancelled duplicates must not count as double completions");
});

test("callback outbox is written in the settle transaction when callbackUrl is set", async () => {
  const req = ticket({ callbackUrl: "https://scope.example.internal/api/internal/analysis-callback" });
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: row.ticket_id,
    traceId: row.trace_id,
    status: "failed",
    finishedAt: new Date().toISOString(),
    analysisVersion: req.analysisVersion,
    result: null,
    evidence: null,
    deferred: null,
    failureReason: "boom",
    terminalReason: "permanent",
  });
  await db.begin((tx) => T.settle(tx, row.ticket_id, row.lease_token, rep));
  const out = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_callback_outbox WHERE delivered_at IS NULL");
  assert.equal(Number(out[0]?.n), 1);
});

test("cancel is idempotent and writes a terminal reply body", async () => {
  const req = ticket();
  await db.begin((tx) => T.accept(tx, req));
  assert.equal(await db.begin((tx) => T.cancel(tx, req.ticketId)), "cancelled");
  assert.equal(await db.begin((tx) => T.cancel(tx, req.ticketId)), "cancelled");
  const rep = (await T.reply(db, req.ticketId)) as { status: string; terminalReason: string };
  assert.equal(rep.status, "cancelled");
  assert.equal(rep.terminalReason, "permanent");
  assert.equal(await db.begin((tx) => T.cancel(tx, "99999999-9999-4999-8999-999999999999")), null);
});

test("global sweep claim allows only one sweep per interval", async () => {
  assert.equal(await db.begin((tx) => T.claimSweep(tx, 15)), true);
  assert.equal(await db.begin((tx) => T.claimSweep(tx, 15)), false, "a second tick inside the interval must skip");
});

test("expireDeadlines stamps a DEFERRED reply body, not just the status column (F10)", async () => {
  // 변이 감지: `writeReply` 호출을 지우면 컬럼만 deferred(deadline) 이고 답장 본문은 **직전 것**이
  // 남는다. 코어는 종결 판정을 **답장 본문의 status** 로 하므로(2026-08-26 재시도 증폭 사고),
  // 본문이 안 바뀌면 lane 이 "마감" 이라고 쓴 사실이 코어 계층에 도달하지 않는다.
  const req = ticket({ callbackUrl: "https://scope.example.internal/api/internal/analysis-callback" });
  await db.begin((tx) => T.accept(tx, req));
  await db.query("UPDATE analysis_tickets SET deadline_at = now() - interval '10 minutes'");

  assert.equal(await db.begin((tx) => T.expireDeadlines(tx)), 1);
  const rep = (await T.reply(db, req.ticketId)) as { status: string; deferred: { failureClass: string } };
  assert.equal(rep.status, "deferred", "답장 본문이 그대로면 코어는 마감을 못 본다");
  assert.equal(rep.deferred.failureClass, "deadline");
  // 콜백 아웃박스도 같은 트랜잭션에서 갱신된다 — doorbell 이 안 울리면 코어는 되읽지 않는다.
  const out = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_callback_outbox WHERE delivered_at IS NULL");
  assert.equal(Number(out[0]?.n), 1);
});

test("sweep order decides terminal_reason — deadline beats cap_exhausted (F13)", async () => {
  // 한 티켓이 둘 다 해당한다: 마감을 넘긴 채 재시도를 소진했다.
  // chronic 이 먼저 돌면 `cap_exhausted`(= "재제출하면 된다")로 닫히고, 코어가 죽은 티켓을 다시
  // 발행해 LLM 실비를 또 태운다. 마감이 더 강한 사실이므로 먼저 써야 한다.
  const req = ticket();
  await db.begin((tx) => T.accept(tx, req));
  await db.query("UPDATE analysis_tickets SET attempt_count = 3, deadline_at = now() - interval '2 hours'");
  await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");

  const counts = await db.begin((tx) => T.sweep(tx, { reapIntervalSeconds: 15, deadlineGraceSeconds: 300, maxAttempts: 3 }));
  assert.ok(counts);
  assert.equal(counts.deadlines, 1);
  assert.equal(counts.expired, 1, "마감 GC 가 이 티켓을 먼저 가져가야 한다");
  assert.equal(counts.chronic, 0, "chronic 이 가져가면 재발행 판정이 뒤집힌다");

  const row = (await db.query<{ terminal_reason: string; reply: { terminalReason: string } }>(
    "SELECT terminal_reason, reply FROM analysis_tickets",
  ))[0];
  assert.equal(row?.terminal_reason, "deadline_exceeded");
  assert.equal(row?.reply.terminalReason, "deadline_exceeded");
});

test("sweep claims at most once per interval and returns null otherwise", async () => {
  const opts = { reapIntervalSeconds: 15, deadlineGraceSeconds: 300, maxAttempts: 3 };
  await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");
  assert.ok(await db.begin((tx) => T.sweep(tx, opts)));
  assert.equal(await db.begin((tx) => T.sweep(tx, opts)), null, "같은 창 안의 두 번째 틱은 건너뛴다");
});

test("a manual re-analysis is never dropped as a duplicate (F4)", async () => {
  // manual = 사람이 "저 턴을 다시 분석해 달라" 고 누른 것 → **직전 완주가 있는 것이 정상**이다.
  // 여기서 취소하면 재분석 기능이 조용히 죽는다(티켓도 답장도 계약을 지키므로 아무도 못 본다).
  const turnRunId = "dddddddd-0000-4000-8000-000000000001";
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId, attempt: 1 })));
  await db.query("UPDATE analysis_tickets SET status='completed', finished_at=now()");

  const again = ticket({ turnRunId, attempt: 2, priority: "manual" });
  await db.begin((tx) => T.accept(tx, again));
  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 1, "manual 재분석은 실행돼야 한다");
  assert.equal(leased[0]?.ticket_id, again.ticketId);
});

test("the duplicate lookback window is 24h — yesterday's completion still guards today's reissue (F4)", async () => {
  const turnRunId = "dddddddd-0000-4000-8000-000000000002";
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId, attempt: 1 })));
  // 6h 창이었다면 통과했을 나이. 24h 창은 여전히 잡는다.
  await db.query("UPDATE analysis_tickets SET status='completed', finished_at = now() - interval '10 hours'");
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId, attempt: 2 })));
  assert.equal((await db.begin((tx) => T.leaseBatch(tx, LEASE))).length, 0);
});

test("allowScheduled=false leases manual only — the reserved slots are actually reserved (F5)", async () => {
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "eeeeeeee-0000-4000-8000-000000000001" })));
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "eeeeeeee-0000-4000-8000-000000000002", priority: "manual" })));
  const leased = await db.begin((tx) => T.leaseBatch(tx, { ...LEASE, allowScheduled: false }));
  assert.equal(leased.length, 1);
  assert.equal(leased[0]?.turn_run_id, "eeeeeeee-0000-4000-8000-000000000002");
  // 그리고 scheduled 는 큐에 그대로 남는다(버려지지 않는다).
  const left = await db.query<{ n: string }>("SELECT count(*) n FROM analysis_tickets WHERE status='queued'");
  assert.equal(Number(left[0]?.n), 1);
});

test("the deadline sweep uses its partial index — its predicate matches expireDeadlines verbatim (F3)", async () => {
  // 0002 의 부분 인덱스는 status IN ('queued','deferred') 인데 expire_deadlines 는 leased/running
  // 까지 스윕한다. 플래너의 함의 증명은 **동일 표현식**에서만 확실하므로 그 인덱스는 못 탄다 —
  // 리퍼는 원장 전체를 도는 쿼리라 그것이 곧 Seq Scan 이다. 0005 가 맞는 인덱스를 넣었다.
  await db.query("SET enable_seqscan = off");
  const plan = await db.query<Record<string, string>>(
    `EXPLAIN UPDATE analysis_tickets
        SET status='deferred'
      WHERE status IN ('queued','deferred','leased','running')
        AND deadline_at <= now()
        AND failure_class IS DISTINCT FROM 'deadline'`,
  );
  await db.query("SET enable_seqscan = on");
  const text = plan.map((r) => Object.values(r).join(" ")).join("\n");
  assert.match(text, /analysis_tickets_deadline_sweep_all_idx/, `plan did not use the partial index:\n${text}`);
});

test("worker gauges: fresh reports are summed, stale ones are surfaced as unknown (F2)", async () => {
  // 이 경로가 없으면 /v1/capacity·/metrics 의 inflightCalls 가 **항상 0** 이다 = "상한을 하나도
  // 안 쓰고 있다". 램프(300 → 640)의 유일한 판정 입력이 거기 걸려 있다.
  const empty = await T.workerGauges(db, 60);
  assert.equal(empty.known, true, "행이 아예 없으면 함대가 0 인 것 — 그건 아는 값이다");
  assert.equal(empty.workerCount, 0);

  await T.reportWorkerGauges(db, { workerId: "w1", inflightCalls: 12, callSlots: 38, leasedUnits: 5, laneRevision: "stub-0" });
  await T.reportWorkerGauges(db, { workerId: "w2", inflightCalls: 7, callSlots: 38, leasedUnits: 3, laneRevision: "stub-0" });
  let g = await T.workerGauges(db, 60);
  assert.equal(g.workerCount, 2);
  assert.equal(g.inflightCalls, 19);
  assert.equal(g.callSlots, 76);
  assert.equal(g.known, true);

  // upsert — 같은 워커가 두 번 세지지 않는다.
  await T.reportWorkerGauges(db, { workerId: "w1", inflightCalls: 20, callSlots: 38, leasedUnits: 6, laneRevision: "stub-0" });
  g = await T.workerGauges(db, 60);
  assert.equal(g.workerCount, 2);
  assert.equal(g.inflightCalls, 27);

  // 보고가 끊긴 워커의 값을 더하면 죽은 함대의 in-flight 가 살아 있는 것처럼 보인다 → "미상".
  await db.query("UPDATE analysis_worker_gauges SET reported_at = now() - interval '10 minutes'");
  g = await T.workerGauges(db, 60);
  assert.equal(g.known, false, "stale 만 남으면 0 이 아니라 모름이다");
  assert.equal(g.staleWorkers, 2);
  assert.equal(g.inflightCalls, 0, "합산에서는 빠지되 known=false 가 그 0 을 믿지 말라고 말한다");

  await T.clearWorkerGauge(db, "w1");
  await T.clearWorkerGauge(db, "w2");
  assert.equal((await T.workerGauges(db, 60)).staleWorkers, 0, "정상 종료한 워커는 행을 남기지 않는다");
});

test("lane health gauges see what queueDepth cannot: terminal failures and deferred residue (F14)", async () => {
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "ffffffff-0000-4000-8000-000000000001" })));
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "ffffffff-0000-4000-8000-000000000002" })));
  await db.query(
    `UPDATE analysis_tickets SET status='failed', finished_at=now(), terminal_reason='cap_exhausted'
      WHERE turn_run_id=$1`,
    ["ffffffff-0000-4000-8000-000000000001"],
  );
  await db.query(
    `UPDATE analysis_tickets SET status='deferred', updated_at = now() - interval '3 hours'
      WHERE turn_run_id=$1`,
    ["ffffffff-0000-4000-8000-000000000002"],
  );

  const h = await T.laneHealthGauges(db, 3600);
  assert.equal(h.failedTerminal1d, 1, "끝난 실패는 queueDepth 에서 빠져 있어 큐만 보면 '건강' 이다");
  assert.equal(h.failedCapExhausted1d, 1);
  assert.equal(h.failedDeadlineExceeded1d, 0);
  assert.equal(h.deferredBacklog, 1);
  assert.equal(h.deferredStale, 1, "0 이 정상 — 측정 lane 0013 의 deferred 4,260건이 이 축에서 안 보였다");
});

test("queueDepth excludes doomed tickets — otherwise autoscaling never scales in", async () => {
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "bbbbbbbb-0000-4000-8000-000000000001" })));
  await db.begin((tx) => T.accept(tx, ticket({ turnRunId: "bbbbbbbb-0000-4000-8000-000000000002" })));
  await db.query("UPDATE analysis_tickets SET attempt_count = 3 WHERE turn_run_id = $1", [
    "bbbbbbbb-0000-4000-8000-000000000002",
  ]);
  const snap = await T.queueSnapshot(db, 120, 3);
  assert.equal(snap.queueDepth, 1);
  assert.equal(snap.statusCounts.queued, 2);
});

// ── B7 : 스윕 LIMIT — 큰 적체 한 번이 워커의 리스를 멈추지 않게 ──────────────────
//
//   리퍼는 워커 poll 루프 안에서 `await` 된다(`worker/main.ts` `reapOnce`). 상한이 없으면
//   장애 복구 직후·대량 마감 초과·함대 재기동처럼 **적체가 큰 순간**에 한 틱이 원장 전체를
//   한 트랜잭션으로 돌고, 그동안 그 워커는 리스를 하나도 집지 못한다. 게다가 세 스윕은
//   행마다 답장 UPDATE + 아웃박스 upsert + 이벤트 INSERT 를 하므로 비용이 행 수에 선형이다.
//
//   ⚠️ 진행 보장: 각 스윕은 처리한 행을 **자기 술어 밖으로** 내보낸다(상태·failure_class 가
//      바뀐다). 그래서 다음 틱은 반드시 다른 행을 본다 = 라이브락이 없다. 아래 두 번째
//      테스트가 그것을 관측한다.

/** `n` 건을 큐에 넣는다. `turn_run_id` 만 다르게(= 서로 다른 유닛) — 중복 취소에 안 걸린다. */
async function seedQueued(n: number, patch: string | null = null): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const hex = i.toString(16).padStart(12, "0");
    await db.begin((tx) => T.accept(tx, ticket({ turnRunId: `55555555-5555-4555-8555-${hex}` })));
  }
  if (patch) await db.query(patch);
}

test("B7 — 마감 스윕은 한 틱에 batchLimit 까지만 처리하고 나머지는 다음 틱에 남긴다", async () => {
  await seedQueued(1_200, "UPDATE analysis_tickets SET deadline_at = now() - interval '10 minutes'");
  const before = await db.query<{ n: string }>(
    "SELECT count(*) n FROM analysis_tickets WHERE failure_class IS DISTINCT FROM 'deadline'",
  );
  assert.equal(Number(before[0]?.n), 1_200, "시드가 안 깔렸다");

  const first = await db.begin((tx) => T.expireDeadlines(tx, 500));
  assert.equal(first, 500, "상한을 안 지켰다 — 한 틱이 원장 전체를 돈다");
  const left = await db.query<{ n: string }>(
    "SELECT count(*) n FROM analysis_tickets WHERE deadline_at <= now() AND failure_class IS DISTINCT FROM 'deadline'",
  );
  assert.equal(Number(left[0]?.n), 700, "잔여가 700 이 아니다");

  // 다음 틱 — **다른 행**을 본다(진행 보장). 세 틱이면 전부 소화된다.
  assert.equal(await db.begin((tx) => T.expireDeadlines(tx, 500)), 500);
  assert.equal(await db.begin((tx) => T.expireDeadlines(tx, 500)), 200);
  assert.equal(await db.begin((tx) => T.expireDeadlines(tx, 500)), 0, "다 처리했는데 또 잡혔다 = 라이브락");
});

test("B7 — sweep() 이 batchLimit 을 네 스윕 전부에 내리고 남으면 remaining:true 를 돌려준다", async () => {
  // 만료된 리스 12건 + 마감 초과 12건이 **같은 틱**에 잡히도록 깐다.
  await seedQueued(12);
  await db.query("UPDATE analysis_tickets SET status='leased', lease_token=gen_random_uuid(), leased_until=now() - interval '1 minute'");
  await seedQueued(12, "UPDATE analysis_tickets SET deadline_at = now() - interval '10 minutes' WHERE status='queued'");
  await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");

  const counts = await db.begin((tx) =>
    T.sweep(tx, { reapIntervalSeconds: 15, deadlineGraceSeconds: 3600, maxAttempts: 3, batchLimit: 5 }),
  );
  assert.ok(counts);
  assert.equal(counts.leases, 5, "리스 회수에도 상한이 걸려야 한다 — 같은 트랜잭션이다");
  assert.ok(counts.deadlines <= 5, `마감 스윕이 상한을 넘었다: ${counts.deadlines}`);
  assert.equal(counts.remaining, true, "남았는데 remaining 이 false 다 — 다음 틱이 안 돈다");

  // 상한을 넉넉히 주면 remaining 이 꺼진다(= 신호가 의미를 갖는다).
  for (let i = 0; i < 6; i += 1) {
    await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");
    await db.begin((tx) => T.sweep(tx, { reapIntervalSeconds: 15, deadlineGraceSeconds: 3600, maxAttempts: 3, batchLimit: 500 }));
  }
  await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");
  const done = await db.begin((tx) =>
    T.sweep(tx, { reapIntervalSeconds: 15, deadlineGraceSeconds: 3600, maxAttempts: 3, batchLimit: 500 }),
  );
  assert.ok(done);
  assert.equal(done.remaining, false, `다 끝났는데 remaining 이 true 다: ${JSON.stringify(done)}`);
});

test("B7 — 상한을 줘도 리퍼의 순서 계약은 그대로다 (마감이 cap_exhausted 를 이긴다, F13 회귀)", async () => {
  // LIMIT 서브쿼리를 넣으면서 순서가 뒤바뀌면 코어가 죽은 티켓을 다시 발행해 실비를 또 태운다.
  const req = ticket();
  await db.begin((tx) => T.accept(tx, req));
  await db.query("UPDATE analysis_tickets SET attempt_count = 3, deadline_at = now() - interval '2 hours'");
  await db.query("UPDATE analysis_reaper_state SET last_sweep_at = to_timestamp(0)");
  await db.begin((tx) => T.sweep(tx, { reapIntervalSeconds: 15, deadlineGraceSeconds: 0, maxAttempts: 3, batchLimit: 500 }));
  const row = await db.query<{ terminal_reason: string }>(
    "SELECT terminal_reason FROM analysis_tickets WHERE ticket_id=$1",
    [req.ticketId],
  );
  assert.equal(row[0]?.terminal_reason, "deadline_exceeded");
});

// ── B9 / D6 : 보존(retention) 배치 ──────────────────────────────────────────────
//
//   터미널 티켓은 **아무도 지우지 않았다.** 원장이 단조 증가하고, 자식 세 테이블
//   (`analysis_ticket_events`·`analysis_call_usage`·`analysis_callback_outbox`)이 함께 자란다.
//   FK 에 `ON DELETE CASCADE` 가 없으므로 **자식 먼저** 지워야 한다 — 반대로 하면 전량 롤백이고
//   그건 "돌긴 도는데 아무것도 안 지워지는" 보존 잡이다.

/** 터미널 티켓 1건 + 자식 행들을 만든다. `finishedAt` 을 과거로 밀어 보존 대상으로 만든다. */
async function seedTerminal(turnRunId: string, daysAgo: number, opts: { undelivered?: boolean } = {}): Promise<string> {
  const req = ticket({ turnRunId, callbackUrl: "https://scope.example.internal/api/internal/analysis-callback" });
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: row.ticket_id,
    traceId: row.trace_id,
    status: "failed",
    finishedAt: new Date().toISOString(),
    analysisVersion: req.analysisVersion,
    result: null,
    evidence: null,
    deferred: null,
    failureReason: "boom",
    terminalReason: "permanent",
  });
  await db.begin((tx) => T.settle(tx, row.ticket_id, row.lease_token, rep));
  await db.query(
    `INSERT INTO analysis_call_usage
       (ticket_id, attempt, run_index, worker_id, task, pool_key, model_id, outcome, started_at, finished_at, latency_ms)
     VALUES ($1,1,1,'w1','extract','openrouter','m','failed', now(), now(), 10)`,
    [row.ticket_id],
  );
  await db.query("UPDATE analysis_tickets SET finished_at = now() - make_interval(days => $2::int) WHERE ticket_id=$1", [
    row.ticket_id,
    daysAgo,
  ]);
  if (!opts.undelivered) {
    await db.query("UPDATE analysis_callback_outbox SET delivered_at = now() WHERE ticket_id=$1", [row.ticket_id]);
  }
  return row.ticket_id;
}

test("B9 — 보존 기간을 넘긴 터미널 티켓과 **자식 행**이 함께 지워진다 (FK CASCADE 가 없다)", async () => {
  const old1 = await seedTerminal("55555555-5555-4555-8555-0000000000a1", 30);
  const old2 = await seedTerminal("55555555-5555-4555-8555-0000000000a2", 20);
  const fresh = await seedTerminal("55555555-5555-4555-8555-0000000000a3", 1);

  const counts = await db.begin((tx) => T.purgeTerminalTickets(tx, { retentionDays: 14, batchLimit: 500 }));
  assert.equal(counts.tickets, 2, "보존 기간을 넘긴 2건만 지워야 한다");
  assert.equal(counts.remaining, false);
  assert.ok(counts.events > 0, "이벤트 행이 안 지워졌다 — FK 위반으로 롤백됐을 수 있다");
  assert.equal(counts.callUsage, 2, "원장 행이 안 지워졌다");
  assert.equal(counts.outbox, 2, "아웃박스 행이 안 지워졌다 — 다음 티켓 삭제가 FK 로 막힌다");

  for (const gone of [old1, old2]) {
    const r = await db.query("SELECT 1 FROM analysis_tickets WHERE ticket_id=$1", [gone]);
    assert.equal(r.length, 0, "티켓이 안 지워졌다");
    const c = await db.query("SELECT 1 FROM analysis_call_usage WHERE ticket_id=$1", [gone]);
    assert.equal(c.length, 0);
  }
  const kept = await db.query("SELECT 1 FROM analysis_tickets WHERE ticket_id=$1", [fresh]);
  assert.equal(kept.length, 1, "보존 기간 안의 티켓을 지웠다");
});

test("B9 — **미배달 콜백이 남은 티켓은 지우지 않는다** (아웃박스 행이 유일한 미배달 증거다)", async () => {
  const stuck = await seedTerminal("55555555-5555-4555-8555-0000000000b1", 30, { undelivered: true });
  const counts = await db.begin((tx) => T.purgeTerminalTickets(tx, { retentionDays: 14, batchLimit: 500 }));
  assert.equal(counts.tickets, 0, "코어가 아직 못 받은 결과를 지웠다");
  const r = await db.query("SELECT 1 FROM analysis_tickets WHERE ticket_id=$1", [stuck]);
  assert.equal(r.length, 1);
});

test("B9 — 배치를 가득 채우면 remaining:true 이고 다음 틱이 이어간다", async () => {
  for (let i = 0; i < 3; i += 1) {
    await seedTerminal(`55555555-5555-4555-8555-0000000000c${i}`, 30);
  }
  const first = await db.begin((tx) => T.purgeTerminalTickets(tx, { retentionDays: 14, batchLimit: 2 }));
  assert.equal(first.tickets, 2);
  assert.equal(first.remaining, true);
  const second = await db.begin((tx) => T.purgeTerminalTickets(tx, { retentionDays: 14, batchLimit: 2 }));
  assert.equal(second.tickets, 1);
  assert.equal(second.remaining, false);
});

test("B9 — 보존 리더 락은 한 워커만 통과시킨다 (두 워커가 같은 행을 두 번 지우지 않게)", async () => {
  // 같은 트랜잭션 안에서는 재진입이 허용되므로, 관측은 **다른 트랜잭션**이 동시에 잡는지로 한다.
  // PGlite 는 단일 커넥션이라 진짜 동시성은 재현되지 않는다(이 파일 머리말의 한계와 같다) —
  // 여기서 고정하는 것은 "클레임 함수가 존재하고 락을 실제로 요구한다" 는 계약이다.
  assert.equal(await db.begin((tx) => T.claimRetention(tx)), true);
  assert.equal(await db.begin((tx) => T.claimRetention(tx)), true, "커밋으로 풀리는 xact 락이어야 한다");
});

test("D6 — 2차 컨텍스트 캐시가 LRU 로 잘린다 (초판은 호출자가 0 이었다)", async () => {
  const project = "22222222-2222-4222-8222-222222222222";
  for (let i = 0; i < 10; i += 1) {
    await db.query(
      "INSERT INTO analysis_contexts (context_version, project_id, payload, payload_bytes, last_used_at) VALUES ($1,$2,$3::jsonb,$4, now() - make_interval(mins => $5::int))",
      [`${project}:v${i}`, project, { n: i }, 100, i],
    );
  }
  // keep=4 → 6건이 지워지고, **가장 최근에 쓰인 4건**이 남는다.
  assert.equal(await trimContextTable(db, 4), 6);
  const left = await db.query<{ context_version: string }>("SELECT context_version FROM analysis_contexts ORDER BY last_used_at DESC");
  assert.deepEqual(left.map((r) => r.context_version), [`${project}:v0`, `${project}:v1`, `${project}:v2`, `${project}:v3`]);

  // 배치 상한 — 한 트랜잭션이 통째로 지우지 않는다(스윕 LIMIT 과 같은 이유).
  for (let i = 10; i < 20; i += 1) {
    await db.query(
      "INSERT INTO analysis_contexts (context_version, project_id, payload, payload_bytes, last_used_at) VALUES ($1,$2,$3::jsonb,$4, now() - make_interval(mins => $5::int))",
      [`${project}:v${i}`, project, { n: i }, 100, i],
    );
  }
  assert.equal(await trimContextTable(db, 2, 3), 3, "maxDelete 를 안 지켰다");
});

// ── C-8 : 콜백 아웃박스 본문은 **신호**다 (결과 전체를 싣지 않는다) ─────────────
//
//   `worker/callbacks.ts` 머리말과 스펙 §7.3 ② 가 이미 그렇게 말하고 있었는데 코드는 답장
//   **전체**를 실었다. 결과 본문이 `analysis_tickets.reply` 와 아웃박스에 두 벌 저장되고,
//   그 덩어리가 lane → 코어 HTTP 바디로 나간다. 코어 라우트는 `{ticketId,status}` 만 읽고
//   나머지는 passthrough 로 버린다(`app/api/internal/analysis-callback/route.ts`).

test("C-8 — 아웃박스 본문은 {version,ticketId,traceId,status} 뿐이다 (결과는 GET reply 가 정본)", async () => {
  const req = ticket({ callbackUrl: "https://scope.example.internal/api/internal/analysis-callback" });
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.ok(row);
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: row.ticket_id,
    traceId: row.trace_id,
    status: "failed",
    finishedAt: new Date().toISOString(),
    analysisVersion: req.analysisVersion,
    result: null,
    evidence: null,
    deferred: null,
    // 아웃박스에 실리면 **안 되는** 자유문. 축소가 진짜로 잘랐는지의 관측점이다.
    failureReason: "OUTBOX_MUST_NOT_CARRY_THIS",
    terminalReason: "permanent",
  });
  await db.begin((tx) => T.settle(tx, row.ticket_id, row.lease_token, rep));

  const out = await db.query<{ body: Record<string, unknown> }>(
    "SELECT body FROM analysis_callback_outbox WHERE ticket_id=$1",
    [row.ticket_id],
  );
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]!.body).sort(), ["status", "ticketId", "traceId", "version"]);
  assert.deepEqual(out[0]!.body, { version: 1, ticketId: row.ticket_id, traceId: row.trace_id, status: "failed" });
  assert.equal(
    JSON.stringify(out[0]!.body).includes("OUTBOX_MUST_NOT_CARRY_THIS"),
    false,
    "아웃박스가 여전히 답장 본문을 싣고 있다",
  );
  // 권위 있는 본문은 그대로 티켓 행에 있다 — 축소가 결과를 잃는 것이 아님을 같이 본다.
  const authoritative = (await T.reply(db, row.ticket_id)) as { failureReason: string };
  assert.equal(authoritative.failureReason, "OUTBOX_MUST_NOT_CARRY_THIS", "GET reply 의 본문이 사라졌다 — 축소가 엉뚱한 것을 잘랐다");

  // 리퍼·취소 경로(writeReply)도 같은 모양이다.
  const c = ticket({ turnRunId: "55555555-5555-4555-8555-0000000000d1", callbackUrl: "https://scope.example.internal/cb" });
  await db.begin((tx) => T.accept(tx, c));
  await db.begin((tx) => T.cancel(tx, c.ticketId));
  const cout = await db.query<{ body: Record<string, unknown> }>(
    "SELECT body FROM analysis_callback_outbox WHERE ticket_id=$1",
    [c.ticketId],
  );
  assert.deepEqual(Object.keys(cout[0]!.body).sort(), ["status", "ticketId", "traceId", "version"]);
  assert.equal(cout[0]!.body.status, "cancelled");
});

test("C-8 — callbackBody 는 코어 CallbackBodySchema 가 요구하는 축을 전부 갖는다", () => {
  const rep = AnalysisReplySchema.parse({
    version: 1,
    ticketId: "6f3d6f7a-2f0e-5a2f-9c1b-0d4a3b5c6d7e",
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    status: "deferred",
    finishedAt: new Date().toISOString(),
    analysisVersion: "v1",
    result: null,
    evidence: null,
    deferred: { failureClass: "transient", retryAfterMs: 1000, detail: "x" },
    failureReason: null,
    terminalReason: null,
  });
  const body = T.callbackBody(rep);
  // 코어가 읽는 둘(`ticketId`·`status`)과 상관관계 축(`traceId`). 그 외는 싣지 않는다.
  assert.deepEqual(body, {
    version: 1,
    ticketId: "6f3d6f7a-2f0e-5a2f-9c1b-0d4a3b5c6d7e",
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    status: "deferred",
  });
});
