// jsonb 파라미터 이중 인코딩 — **라이브에서만 발현하던 결함의 회귀 가드**.
//
// ── 무슨 일이 있었나 (2026-09-13)
//
//   초판 바인딩 규약은 "jsonb 는 JSON 문자열 + `::jsonb` 캐스트" 였다. postgres.js(3.4.9)는
//   파라미터가 있으면 `prepare:false` 라도 **먼저 Describe** 하고(`src/connection.js:238`),
//   서버가 `$n::jsonb` 로 해소한 OID(3802)를 받아 **그 OID 의 직렬화기**로 Bind 한다
//   (`src/connection.js:959` → `types.json.serialize` = `JSON.stringify`). 즉 이미 JSON
//   문자열인 값을 **한 번 더** 직렬화해 컬럼에 jsonb **문자열 스칼라**가 앉았다.
//   워커의 `AnalysisTicketRequestSchema.parse(row.request)` 가 `expected object, received
//   string` 으로 **전량 실패**했다(worker/main.ts).
//
// ── 왜 기존 테스트가 못 잡았나 (이 파일이 존재하는 이유)
//
//   PGlite 에는 그 재직렬화가 없다 — 문자열을 주든 객체를 주든 **둘 다** jsonb 객체가 된다.
//   그래서 같은 SQL 을 진짜 Postgres 로 돌리는 `tests/queue-lease.test.ts` 가 통과했다.
//   드라이버 경계의 결함은 "SQL 이 맞는가" 로는 안 보인다. 그래서 여기서는 축을 바꿔
//   **드라이버에 무엇이 건네지는가**(아래 ①)와 **postgres.js 가 그것을 어떻게 직렬화하는가**
//   (②, 설치된 라이브러리의 진짜 직렬화기를 태운다)를 본다.
//
//   ⚠️ ② 가 이 파일의 핵심이다. ① 만 있으면 "문자열을 넘기지 마라" 라는 규약의 **재진술**일
//      뿐이고, 그 규약이 왜 필요한지는 증명하지 못한다. ② 는 옛 형태(문자열)를 실제로 태워
//      `jsonb_typeof='string'` 을 **재현**한다 — 라이브 PG 없이 CI 에서.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fromJsonb, type Db, type Queryable, type Row } from "../app/db.ts";
import { migrate } from "../app/migrate.ts";
import * as T from "../app/tickets.ts";
import {
  AnalysisReplySchema,
  AnalysisTicketRequestSchema,
  deterministicAnalysisTicketId,
} from "../contracts/index.ts";
import { pumpOnce } from "../worker/callbacks.ts";
import { ContextCache } from "../worker/context-cache.ts";
import { createPgliteDb, type TestDb } from "./helpers/pglite-db.ts";

// ── postgres.js 의 진짜 Bind 직렬화기 ─────────────────────────────────────────
//
// 설치된 라이브러리에서 직접 가져온다 — 여기서 성질을 **복제하면** 라이브러리가 바뀌었을 때
// 테스트만 옛 동작을 증명하게 된다. `exports` 맵에 서브경로가 없어 패키지 진입점을 해소한 뒤
// 옆 파일(`src/types.js`)을 URL 로 import 한다.
const POSTGRES_JSONB_OID = 3802;
const { serializers } = (await import(new URL("./types.js", import.meta.resolve("postgres")).href)) as {
  serializers: Record<number, (x: unknown) => string>;
};

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/analysis-ticket-request.v1.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

const CONTEXT_PAYLOAD = { catalog: [{ id: "e1" }], rels: [], grouping: {}, trackedAugmentTargets: [] };
const CONTEXT_VERSION = "22222222-2222-4222-8222-222222222222:deadbeefdeadbeef";
/** U+0000. 소스에 날 바이트를 두지 않는다 — 이스케이프로만 쓴다. */
const NUL = "\u0000";
const LEASE = {
  workerId: "w-jsonb",
  ttlSeconds: 1200,
  allowScheduled: true,
  limit: 10,
  minRunwaySeconds: 120,
  maxAttempts: 3,
};

let db: TestDb;

function ticket(overrides: Record<string, unknown> = {}) {
  const turnRunId = (overrides.turnRunId as string) ?? String((FIXTURE.lineage as Record<string, unknown>).turnRunId);
  const analysisVersion = FIXTURE.analysisVersion as string;
  const workspaceId = String((FIXTURE.lineage as Record<string, unknown>).workspaceId);
  return AnalysisTicketRequestSchema.parse({
    ...FIXTURE,
    ticketId: deterministicAnalysisTicketId(workspaceId, turnRunId, analysisVersion, 1),
    lineage: { ...(FIXTURE.lineage as object), turnRunId },
    turn: { ...(FIXTURE.turn as object), turnRunId },
    deadlineAt: (overrides.deadlineAt as string) ?? new Date(Date.now() + 6 * 3600_000).toISOString(),
    priority: "scheduled",
  });
}

/** 답장 본문은 **계약 픽스처**에서 만든다 — 손으로 지으면 스키마가 좁아질 때 이 파일부터 깨진다. */
function replyFixture(name: "completed" | "deferred", ticketId: string, traceId: string) {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../contracts/fixtures/analysis-reply.${name}.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
  return AnalysisReplySchema.parse({ ...raw, ticketId, traceId, analysisVersion: FIXTURE.analysisVersion as string });
}

// ── 기록 어댑터 ───────────────────────────────────────────────────────────────
//
// **SQL 을 고쳐 쓰지 않는다** — 그대로 통과시키고 (text, params) 만 적는다. 그래야 기록된
// 파라미터가 라이브 드라이버가 실제로 받는 값과 같은 것이다(`app/db.ts` 상단 원칙).
interface Recorded {
  text: string;
  params: readonly unknown[];
}

function recording(inner: Db, log: Recorded[]): Db {
  const wrap = (q: Queryable): Queryable => ({
    async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
      log.push({ text, params });
      return q.query<R>(text, params);
    },
  });
  const base = wrap(inner);
  return {
    query: base.query,
    begin: (fn) => inner.begin((tx) => fn(wrap(tx))),
    ping: () => inner.ping(),
    close: () => inner.close(),
  };
}

/** SQL 의 `$n::jsonb` 자리에 실제로 바인드된 값들. **이 자리에 문자열이 오면 결함이다.** */
function jsonbBinds(rec: Recorded): Array<{ position: number; value: unknown }> {
  const out: Array<{ position: number; value: unknown }> = [];
  for (const m of rec.text.matchAll(/\$(\d+)::jsonb/g)) {
    const position = Number(m[1]);
    out.push({ position, value: rec.params[position - 1] });
  }
  return out;
}

/** 커버리지 바닥 — 이 라벨이 전부 관측돼야 "전 경로를 봤다" 고 말할 수 있다. */
function label(text: string): string | null {
  if (/INSERT INTO analysis_tickets\b/.test(text)) return "tickets.request";
  if (/UPDATE analysis_tickets SET reply=/.test(text)) return "tickets.reply";
  if (/UPDATE analysis_tickets\b[\s\S]*\breply=\$/.test(text)) return "tickets.reply(settle)";
  if (/INSERT INTO analysis_ticket_events\b/.test(text)) return "ticket_events.detail";
  if (/INSERT INTO analysis_callback_outbox\b/.test(text)) return "callback_outbox.body";
  if (/INSERT INTO analysis_contexts\b/.test(text)) return "contexts.payload";
  return null;
}

before(async () => {
  db = await createPgliteDb();
  await migrate(db);
});

after(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query(
    "TRUNCATE analysis_contexts, analysis_call_usage, analysis_callback_outbox, analysis_ticket_events, analysis_worker_gauges, analysis_tickets CASCADE",
  );
});

// ── ① 드라이버에 건네지는 값 ──────────────────────────────────────────────────

test("모든 jsonb 쓰기 경로가 드라이버에 **객체**를 넘긴다 (문자열이면 라이브에서 이중 인코딩)", async () => {
  const log: Recorded[] = [];
  const rec = recording(db, log);

  // 정상 라이프사이클: 접수 → 리스 → 정산(완주, 콜백 있음)
  const a = ticket();
  await rec.begin((tx) => T.accept(tx, a));
  const leased = await rec.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 1);
  assert.equal(
    await rec.begin((tx) => T.settle(tx, a.ticketId, String(leased[0]!.lease_token), replyFixture("completed", a.ticketId, a.traceId))),
    true,
  );

  // deferred 정산 — 답장·이벤트 detail 이 다른 문장을 탄다.
  const b = ticket({ turnRunId: "bbbbbbbb-0000-4000-8000-000000000002" });
  await rec.begin((tx) => T.accept(tx, b));
  const leasedB = await rec.begin((tx) => T.leaseBatch(tx, LEASE));
  await rec.begin((tx) => T.settle(tx, b.ticketId, String(leasedB[0]!.lease_token), replyFixture("deferred", b.ticketId, b.traceId)));

  // 취소(api) — writeReply + 아웃박스 + 이벤트
  const c = ticket({ turnRunId: "cccccccc-0000-4000-8000-000000000003" });
  await rec.begin((tx) => T.accept(tx, c));
  assert.equal(await rec.begin((tx) => T.cancel(tx, c.ticketId)), "cancelled");

  // 리퍼 3종 — 마감 스탬프 → grace GC → attempt 소진
  const d = ticket({ turnRunId: "dddddddd-0000-4000-8000-000000000004", deadlineAt: new Date(Date.now() + 1000).toISOString() });
  await rec.begin((tx) => T.accept(tx, d));
  await rec.query("UPDATE analysis_tickets SET deadline_at = now() - interval '1 hour' WHERE ticket_id=$1", [d.ticketId]);
  assert.equal(await rec.begin((tx) => T.expireDeadlines(tx)), 1);
  assert.equal(await rec.begin((tx) => T.reapExpired(tx, 0)), 1);
  const e = ticket({ turnRunId: "eeeeeeee-0000-4000-8000-000000000005" });
  await rec.begin((tx) => T.accept(tx, e));
  await rec.query("UPDATE analysis_tickets SET attempt_count=3 WHERE ticket_id=$1", [e.ticketId]);
  assert.equal(await rec.begin((tx) => T.reapChronic(tx, 3)), 1);

  // 2차 컨텍스트 캐시 적재
  const cache = new ContextCache({
    maxEntries: 4,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 1000,
    dbCacheEnabled: true,
    // 코어 200 은 **봉투**다(D-5). 2차 캐시에 들어가는 것은 그 안의 `snapshot` 뿐이다.
    fetchImpl: async () => ({ status: 200, body: { version: CONTEXT_VERSION, snapshot: CONTEXT_PAYLOAD } }),
  });
  await cache.get(rec, CONTEXT_VERSION, "https://core.example/ctx");

  // ── 판정
  const binds = log.flatMap((r) => jsonbBinds(r).map((b2) => ({ ...b2, text: r.text })));
  assert.ok(binds.length >= 14, `jsonb 바인드를 ${binds.length} 개만 봤다 — 경로가 빠졌다`);
  const offenders = binds
    .filter((b2) => typeof b2.value === "string")
    .map((b2) => `$${b2.position} in: ${b2.text.replace(/\s+/g, " ").slice(0, 90)}`);
  assert.deepEqual(
    offenders,
    [],
    `jsonb 파라미터에 문자열이 갔다 — postgres.js 가 한 번 더 직렬화한다:\n${offenders.join("\n")}`,
  );
  for (const b2 of binds) assert.ok(b2.value !== null && typeof b2.value === "object", "jsonb 파라미터는 객체여야 한다");

  const seen = new Set(log.filter((r) => jsonbBinds(r).length > 0).map((r) => label(r.text)));
  for (const required of ["tickets.request", "ticket_events.detail", "callback_outbox.body", "contexts.payload"]) {
    assert.ok(seen.has(required), `${required} 경로를 이 테스트가 안 밟았다 — 커버리지 바닥이 깨졌다`);
  }
  assert.ok(
    seen.has("tickets.reply") || seen.has("tickets.reply(settle)"),
    "답장 쓰기 경로를 이 테스트가 안 밟았다",
  );
});

// ── ② postgres.js 직렬화기를 실제로 태운다 ────────────────────────────────────

/**
 * 라이브 파이프라인의 2단계를 그대로 잇는다:
 *   1) postgres.js Bind — 서버가 해소한 OID(3802)의 직렬화기로 **텍스트**를 만든다.
 *   2) 서버 — 그 텍스트를 jsonb 입력으로 파싱한다(여기서는 PGlite 가 그 역할).
 * 이 두 단계를 이으면 라이브 PG 없이 `jsonb_typeof` 를 CI 에서 관측할 수 있다.
 */
async function jsonbTypeofAfterBind(param: unknown): Promise<string> {
  const wireText = serializers[POSTGRES_JSONB_OID]!(param);
  const rows = await db.query<{ t: string }>("select jsonb_typeof($1::jsonb) as t", [wireText]);
  return String(rows[0]!.t);
}

test("드라이버 모델: 문자열을 넘기면 jsonb **문자열 스칼라**가 되고, 객체를 넘기면 객체가 된다", async () => {
  const obj = { version: 1, nested: { a: [1, 2] } };

  // 옛 형태(결함) — 라이브에서 워커를 전량 죽인 그 값. 재현된다.
  assert.equal(await jsonbTypeofAfterBind(JSON.stringify(obj)), "string");
  // 새 형태(수정) — 같은 직렬화기를 타도 객체로 남는다.
  assert.equal(await jsonbTypeofAfterBind(obj), "object");

  // 이중 인코딩의 지문: Bind 결과를 파싱하면 "객체" 가 아니라 "문자열" 이 나온다.
  assert.equal(typeof JSON.parse(serializers[POSTGRES_JSONB_OID]!(JSON.stringify(obj))), "string");
  assert.equal(typeof JSON.parse(serializers[POSTGRES_JSONB_OID]!(obj)), "object");
});

test("실제 쓰기 경로가 넘기는 값을 postgres.js 직렬화기에 태워도 jsonb 객체로 남는다", async () => {
  const log: Recorded[] = [];
  const rec = recording(db, log);
  const a = ticket();
  await rec.begin((tx) => T.accept(tx, a));
  assert.equal(await rec.begin((tx) => T.cancel(tx, a.ticketId)), "cancelled");

  const binds = log.flatMap(jsonbBinds);
  assert.ok(binds.length >= 3, `jsonb 바인드가 ${binds.length} 개뿐이다`);
  for (const b of binds) {
    assert.equal(await jsonbTypeofAfterBind(b.value), "object", `$${b.position} 가 jsonb 객체가 아니다`);
  }
});

// ── ③ 읽기 방어 — 이미 저장된 이중 인코딩 행 ──────────────────────────────────

test("fromJsonb: 문자열은 파싱하고, 객체·null 은 그대로, 비-JSON 문자열은 건드리지 않는다", () => {
  assert.deepEqual(fromJsonb('{"a":1}'), { a: 1 });
  assert.deepEqual(fromJsonb({ a: 1 }), { a: 1 });
  assert.equal(fromJsonb(null), null);
  assert.equal(fromJsonb(undefined), undefined);
  // JSON 이 아니면 원값 — 판정은 하류 zod 가 한다(여기서 던지면 읽기 경로 전체가 깨진다).
  assert.equal(fromJsonb("not json at all"), "not json at all");
});

/** 결함 기간에 저장된 행을 **실제로 재현한다** — `to_jsonb(text)` 는 문자열 스칼라를 만든다. */
async function doubleEncode(table: string, column: string, idColumn: string, id: string, value: unknown): Promise<void> {
  await db.query(`UPDATE ${table} SET ${column} = to_jsonb($1::text) WHERE ${idColumn}=$2`, [JSON.stringify(value), id]);
  const rows = await db.query<{ t: string }>(`SELECT jsonb_typeof(${column}) t FROM ${table} WHERE ${idColumn}=$1`, [id]);
  assert.equal(rows[0]!.t, "string", "시드가 이중 인코딩을 재현하지 못했다 — 이 테스트는 아무것도 증명하지 않는다");
}

test("이중 인코딩된 request 행도 리스·계약 파싱을 통과한다 (워커 전량 실패의 그 지점)", async () => {
  const a = ticket();
  await db.begin((tx) => T.accept(tx, a));
  await doubleEncode("analysis_tickets", "request", "ticket_id", a.ticketId, a);

  const leased = await db.begin((tx) => T.leaseBatch(tx, LEASE));
  assert.equal(leased.length, 1);
  assert.equal(typeof leased[0]!.request, "object", "leaseBatch 가 문자열을 그대로 돌려줬다");
  // 워커가 하는 바로 그 호출. 수정 전에는 여기서 `expected object, received string` 으로 죽었다.
  const parsed = AnalysisTicketRequestSchema.parse(leased[0]!.request);
  assert.equal(parsed.ticketId, a.ticketId);
});

test("이중 인코딩된 reply 행도 코어에 **객체**로 나간다 (GET …/reply)", async () => {
  const a = ticket();
  await db.begin((tx) => T.accept(tx, a));
  assert.equal(await db.begin((tx) => T.cancel(tx, a.ticketId)), "cancelled");
  const body = await T.reply(db, a.ticketId);
  await doubleEncode("analysis_tickets", "reply", "ticket_id", a.ticketId, body);

  const got = await T.reply(db, a.ticketId);
  assert.equal(typeof got, "object", "코어에 문자열이 나갔다 — 답장이 통째로 거부된다");
  assert.equal((got as { status: string }).status, "cancelled");
});

test("이중 인코딩된 아웃박스 body 도 콜백 POST 본문이 객체다", async () => {
  const a = ticket();
  await db.begin((tx) => T.accept(tx, a));
  await db.begin((tx) => T.cancel(tx, a.ticketId));
  const row = await db.query<{ body: unknown }>("SELECT body FROM analysis_callback_outbox WHERE ticket_id=$1", [a.ticketId]);
  assert.equal(row.length, 1, "취소가 아웃박스 행을 안 남겼다");
  await doubleEncode("analysis_callback_outbox", "body", "ticket_id", a.ticketId, row[0]!.body);

  const captured: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    captured.push(String(init?.body ?? ""));
    return { status: 202 } as Response;
  }) as typeof globalThis.fetch;
  try {
    await pumpOnce(db, () => 0, null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured.length, 1);
  const sent: unknown = JSON.parse(captured[0]!);
  assert.equal(typeof sent, "object", `콜백 본문이 JSON 문자열 리터럴로 나갔다: ${captured[0]!.slice(0, 60)}`);
  assert.equal((sent as { status: string }).status, "cancelled");
});

test("이중 인코딩된 컨텍스트 payload 도 2차 캐시 적중으로 읽힌다", async () => {
  const version = "22222222-2222-4222-8222-222222222222:cafebabecafebabe";
  await db.query(
    "INSERT INTO analysis_contexts (context_version, project_id, payload, payload_bytes) VALUES ($1,$2,$3::jsonb,$4)",
    [version, "22222222-2222-4222-8222-222222222222", CONTEXT_PAYLOAD, 100],
  );
  await doubleEncode("analysis_contexts", "payload", "context_version", version, CONTEXT_PAYLOAD);

  const cache = new ContextCache({
    maxEntries: 4,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 1000,
    dbCacheEnabled: true,
    // 3차(코어)로 새면 실패다 — 2차 적중이 예외로 죽는 것을 잡으려는 테스트다.
    fetchImpl: async () => {
      throw new Error("2차 캐시가 죽어 코어로 샜다");
    },
  });
  const snap = await cache.get(db, version, "https://core.example/ctx");
  assert.deepEqual(snap.catalog, CONTEXT_PAYLOAD.catalog);
  assert.equal(cache.stats.hitsDb, 1);
});

// ── ④ 정적 가드 ───────────────────────────────────────────────────────────────

test("app/tickets.ts 에는 JSON.stringify 가 없다 — 이 파일의 모든 직렬화는 jsonb 바인딩이다", () => {
  const src = readFileSync(`${ROOT}app/tickets.ts`, "utf8");
  const hits = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes("JSON.stringify") && !line.startsWith("//") && !line.startsWith("*"));
  assert.deepEqual(
    hits.map((h) => `${h.n}: ${h.line.slice(0, 100)}`),
    [],
    "app/tickets.ts 의 쿼리는 전부 jsonb 바인딩이다 — JSON.stringify 는 이중 인코딩을 되살린다.\n" +
      "직렬화가 아닌 정당한 용도가 새로 생겼다면 이 테스트를 **의도적으로** 고쳐라(`app/db.ts` jsonb 바인딩 규약).",
  );
});

// ── ⑤ U+0000 은 jsonb 가 **거부한다** (검증자 잔여 리스크 하드닝 ②의 근거) ────────────
//
//   포스트그레스는 jsonb 문자열 안의 U+0000 을 표현하지 못한다. 이 사실이 lane 을 무는 자리가
//   둘이다 — `settle` 의 `reply=$n::jsonb`(정산 실패 → 리스 만료 → 리퍼 → **유료 재실행**)와
//   코어 shadow INSERT(lane 은 completed 인데 코어엔 결과가 없다). 답변 본문은 임의의 사용자
//   데이터라 막을 방법이 "나가는 경계에서 턴다" 뿐이다(`worker/main.ts` `stripNulChars`).
//   그 전제를 **여기서 실측으로 못박는다** — 전제가 틀려지면(포스트그레스가 받아들이면)
//   이 테스트가 먼저 깨져서 알려 준다.

// ── ⑥ 짝 없는 서로게이트도 jsonb 가 **거부한다** (C-1 하드닝의 전제) ─────────────
//
//   U+0000 과 **같은 자리에서 같은 이유로** 죽는다. `JSON.stringify` 가 well-formed 규칙에 따라
//   `\ud83d` 이스케이프를 내보내고(ES2019), 그 ASCII 는 인코딩을 그대로 통과해 서버의 json
//   파서가 거부한다 — `invalid input syntax for type json`(22P02). 초판 `stripNulChars` 는
//   이 갈래를 못 봤다(그 이름이 곧 범위였다).
//
//   ⚠️ **PGlite 가 이 갈래를 본다**(2026-09-13 실측). 즉 이 회귀는 CI 에서 잡힌다 — 이중 인코딩
//      결함(이 파일 머리말)처럼 실 PG 에서만 나타나는 종류가 **아니다.** 드라이버 경계까지
//      포함한 확인은 `tests/live-pg-sanitize.test.ts`(옵트인)가 따로 한다.

const LONE_SURROGATE = "\uD83D"; // 뒤에 low 가 없는 high

test("jsonb 는 짝 없는 서로게이트를 거부한다 — U+0000 과 같은 자리다 (C-1 의 전제)", async () => {
  const probe = await createPgliteDb();
  try {
    await probe.query("CREATE TABLE surr_probe (id int primary key, payload jsonb not null)");
    await assert.rejects(
      () => probe.query("INSERT INTO surr_probe (id, payload) VALUES ($1,$2::jsonb)", [1, { snippet: `a${LONE_SURROGATE}b` }]),
      /invalid input syntax for type json/,
      "객체 바인드에서 거부되지 않았다 — 하드닝의 전제가 바뀌었다",
    );
    // U+FFFD 로 바꾸면 같은 INSERT 가 통과한다 = 다른 바이트는 문제가 아니었다(원인 특정).
    await probe.query("INSERT INTO surr_probe (id, payload) VALUES ($1,$2::jsonb)", [2, { snippet: "a�b" }]);
    // **짝이 맞는** 서로게이트(정상 이모지)는 원래부터 문제가 아니다 — 과잉 정화의 반증.
    await probe.query("INSERT INTO surr_probe (id, payload) VALUES ($1,$2::jsonb)", [3, { snippet: "좋아요 👍" }]);
    const rows = await probe.query<{ n: string }>("SELECT count(*) n FROM surr_probe");
    assert.equal(Number(rows[0]?.n), 2);
  } finally {
    await probe.close();
  }
});

test("jsonb 는 U+0000 을 거부한다 — 객체 바인드든 문자열 바인드든 똑같다 (하드닝의 전제)", async () => {
  const db = await createPgliteDb();
  try {
    await db.query("CREATE TABLE nul_probe (id int primary key, payload jsonb not null)");
    const withNul = { snippet: `a${NUL}b` };

    await assert.rejects(
      () => db.query("INSERT INTO nul_probe (id, payload) VALUES ($1,$2::jsonb)", [1, withNul]),
      /unsupported Unicode escape sequence/,
      "객체 바인드에서 거부되지 않았다 — 하드닝의 전제가 바뀌었다",
    );
    await assert.rejects(
      () => db.query("INSERT INTO nul_probe (id, payload) VALUES ($1,$2::jsonb)", [2, JSON.stringify(withNul)]),
      /unsupported Unicode escape sequence/,
      "문자열 바인드에서 거부되지 않았다",
    );

    // NUL 만 털면 같은 INSERT 가 통과한다 = 다른 바이트는 문제가 아니었다(원인 특정).
    await db.query("INSERT INTO nul_probe (id, payload) VALUES ($1,$2::jsonb)", [3, { snippet: "ab" }]);
    const rows = await db.query<{ n: string }>("SELECT count(*) n FROM nul_probe");
    assert.equal(Number(rows[0]?.n), 1);
  } finally {
    await db.close();
  }
});
