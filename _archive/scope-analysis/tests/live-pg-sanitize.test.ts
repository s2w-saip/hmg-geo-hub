// 실 PostgreSQL + postgres.js 로 보는 **문자열 정화**(C-1). 기본은 **건너뛴다**(옵트인).
//
// ── 왜 이 파일이 따로 있나 (PGlite 테스트와 무엇이 다른가)
//
//   `tests/jsonb-params.test.ts` ⑥ 이 이미 "jsonb 는 짝 없는 서로게이트를 거부한다" 를 PGlite 로
//   못박는다 — 2026-09-13 실측에서 **PGlite 도 이 갈래를 본다**(22P02). 즉 C-1 회귀는 CI 에서
//   잡힌다. 그래도 이 파일이 필요한 이유는 축이 다르기 때문이다:
//
//     · PGlite  — **서버 파서**가 거부하는가 (SQL 의 정확성)
//     · 여기    — **postgres.js 의 Bind 직렬화 → 실 서버 → 되읽기** 왕복이 통째로 사는가
//
//   이 lane 은 이미 그 간극에서 라이브를 통째로 잃은 전례가 있다(jsonb 이중 인코딩 —
//   `app/db.ts` 머리말: PGlite 는 통과하고 postgres.js 만 깨졌다). 같은 종류의 결함이 정화
//   경로에도 숨을 수 있으므로, **드라이버까지 포함한 확인 경로를 한 번은 만들어 둔다.**
//
//   덤으로 여기서만 볼 수 있는 것이 하나 더 있다: **같은 문자열이 text 컬럼에는 조용히
//   U+FFFD 로 들어간다**(실 서버의 인코딩 단계). 두 컬럼 타입의 동작이 왜 일치해야 하는지의
//   근거가 그 관측이다(코어 `lib/db/jsonb-param.ts` 머리말과 같은 사실).
//
// ── 쓰는 법
//
//     ANALYSIS_LIVE_PG_DSN=postgresql://user:pw@127.0.0.1:5432/postgres \
//       node --import tsx --test tests/live-pg-sanitize.test.ts
//
//   · DSN 이 없으면 **건너뛴다**(CI 기본 — 이 lane 의 CI 는 Docker·PG 를 요구하지 않는다).
//   · `REQUIRE_LIVE_PG=1` 이면 DSN 부재가 **실패**다 — 나중에 PG 를 붙인 잡에서 "조용히
//     건너뛰고 초록" 이 되지 않게 하는 스위치다.
//   · 격리: 테스트가 **자기 스키마**(`analysis_live_<rand>`)를 만들고 끝나면 CASCADE 로 지운다.
//     `search_path` 는 DSN 의 `options=-c search_path=…` 로 내린다(실측 확인).
//   · ⚠️ DSN 은 **env 로만** 받는다 — argv 는 `ps` 에 그대로 보인다(워크스페이스 룰
//     secrets-handling 6). 값을 출력하지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresDb, type Db } from "../app/db.ts";
import { migrate } from "../app/migrate.ts";
import * as T from "../app/tickets.ts";
import { AnalysisReplySchema, AnalysisTicketRequestSchema, deterministicAnalysisTicketId } from "../contracts/index.ts";
import { sanitizeStorableStrings } from "../worker/main.ts";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/analysis-ticket-request.v1.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

const BASE_DSN = process.env.ANALYSIS_LIVE_PG_DSN ?? "";
const REQUIRED = process.env.REQUIRE_LIVE_PG === "1";
const SKIP = BASE_DSN === "" && !REQUIRED;
const skipReason = "ANALYSIS_LIVE_PG_DSN 미설정 — 실 PG 검증 생략 (REQUIRE_LIVE_PG=1 이면 실패로 바뀐다)";

const SCHEMA = `analysis_live_${Math.random().toString(36).slice(2, 10)}`;
/** 짝 없는 high surrogate. `JSON.stringify` 가 `\ud83d` 이스케이프로 내보내는 그 값. */
const LONE = "\uD83D";
const BELL = "\u0007";

let db: Db | null = null;
let admin: Db | null = null;

function dsnWithSchema(base: string, schema: string): string {
  const u = new URL(base);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

before(async () => {
  if (SKIP) return;
  assert.notEqual(BASE_DSN, "", "REQUIRE_LIVE_PG=1 인데 ANALYSIS_LIVE_PG_DSN 이 없다");
  admin = createPostgresDb(BASE_DSN, { max: 1 });
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  db = createPostgresDb(dsnWithSchema(BASE_DSN, SCHEMA), { max: 2 });
  const applied = await migrate(db);
  assert.ok(applied.length > 0, "마이그레이션이 하나도 안 돌았다 — 스키마 격리가 안 됐다");
});

after(async () => {
  await db?.close();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  }
});

/** 계약 픽스처를 그대로 쓴다 — 손으로 만든 요청이 계약과 갈리면 이 테스트가 딴 걸 보게 된다. */
function ticketRequest(turnRunId: string): ReturnType<typeof AnalysisTicketRequestSchema.parse> {
  const workspaceId = String((FIXTURE.lineage as Record<string, unknown>).workspaceId);
  const analysisVersion = FIXTURE.analysisVersion as string;
  return AnalysisTicketRequestSchema.parse({
    ...FIXTURE,
    ticketId: deterministicAnalysisTicketId(workspaceId, turnRunId, analysisVersion, 1),
    lineage: { ...(FIXTURE.lineage as object), turnRunId },
    turn: { ...(FIXTURE.turn as object), turnRunId },
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    priority: "scheduled",
    callbackUrl: null,
  });
}

function replyWith(ticketId: string, snippet: string): unknown {
  return {
    version: 1,
    ticketId,
    traceId: FIXTURE.traceId as string,
    status: "failed",
    finishedAt: new Date().toISOString(),
    analysisVersion: FIXTURE.analysisVersion as string,
    result: null,
    evidence: null,
    deferred: null,
    failureReason: snippet,
    terminalReason: "permanent",
  };
}

test("실 PG: 정화 없는 답장은 settle 에서 22P02 로 죽고 **티켓이 running 에 남는다** (C-1 이 막는 그 경로)", { skip: SKIP ? skipReason : false }, async () => {
  assert.ok(db);
  const req = ticketRequest("55555555-5555-4555-8555-555555555001");
  const ticketId = req.ticketId;
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "live", ttlSeconds: 1200, allowScheduled: true, limit: 1, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);

  // 계약은 통과한다 — **짝 없는 서로게이트는 zod 가 잡는 종류의 결함이 아니다.** 그래서
  // "검증을 통과한 답장" 이 DB 경계에서만 죽는다(이 결함이 숨어 있던 이유).
  const dirty = AnalysisReplySchema.parse(replyWith(ticketId, `bad json near LG${LONE}${BELL}`));
  await assert.rejects(
    () => db!.begin((tx) => T.settle(tx, ticketId, String(row.lease_token), dirty)),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, "22P02", `기대한 SQLSTATE 가 아니다: ${err.code} ${err.message}`);
      assert.match(String(err.message), /invalid input syntax for type json/);
      return true;
    },
    "실 PG 가 서로게이트를 받아들였다 — C-1 하드닝의 전제가 바뀌었다",
  );

  // **이것이 유료 재실행의 입구다**: 정산이 통째로 롤백돼 티켓이 리스 상태로 남는다 →
  // 리스 만료 → 리퍼 → 같은 턴을 LLM 으로 다시 돈다.
  const after = await db.query<{ status: string }>("SELECT status FROM analysis_tickets WHERE ticket_id=$1", [ticketId]);
  assert.equal(after[0]?.status, "leased", "정산 실패 후 티켓이 터미널이 되면 이 테스트의 전제가 틀린 것이다");
});

test("실 PG: 워커가 하는 정화(sanitizeStorableStrings)를 거치면 같은 답장이 살아서 되읽힌다", { skip: SKIP ? skipReason : false }, async () => {
  assert.ok(db);
  const req = ticketRequest("55555555-5555-4555-8555-555555555002");
  const ticketId = req.ticketId;
  await db.begin((tx) => T.accept(tx, req));
  const [row] = await db.begin((tx) =>
    T.leaseBatch(tx, { workerId: "live", ttlSeconds: 1200, allowScheduled: true, limit: 1, minRunwaySeconds: 120, maxAttempts: 3 }),
  );
  assert.ok(row);

  // 워커의 `parseReply` 와 **같은 순서**: 정화 → 계약 파싱.
  const clean = AnalysisReplySchema.parse(sanitizeStorableStrings(replyWith(ticketId, `bad json near LG${LONE}${BELL}`)));
  assert.equal(await db.begin((tx) => T.settle(tx, ticketId, String(row.lease_token), clean)), true);

  // 되읽기 — 드라이버 왕복까지 통과했는지.
  const back = (await T.reply(db, ticketId)) as { failureReason: string; status: string };
  assert.equal(back.status, "failed");
  assert.equal(back.failureReason, "bad json near LG�", "치환이 안 됐거나 C0 가 남았다");

  const st = await db.query<{ status: string }>("SELECT status FROM analysis_tickets WHERE ticket_id=$1", [ticketId]);
  assert.equal(st[0]?.status, "failed");
});

test("실 PG: 같은 문자열이 text 컬럼에는 **조용히** U+FFFD 로 들어간다 — 그래서 두 타입을 맞춰야 한다", { skip: SKIP ? skipReason : false }, async () => {
  assert.ok(db);
  // 이 사실이 정책의 근거다: jsonb 를 U+FFFD 로 맞추면 **text 컬럼이 이미 하던 것과 같아진다**
  // (제거가 아니라 치환을 고른 이유 — 코어 `toStorableText` 와 동일).
  await db.query("CREATE TABLE IF NOT EXISTS analysis_live_text_probe (id int primary key, t text NOT NULL)");
  await db.query("INSERT INTO analysis_live_text_probe (id, t) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET t=EXCLUDED.t", [
    `LG${LONE} 스타일러`,
  ]);
  const got = await db.query<{ t: string }>("SELECT t FROM analysis_live_text_probe WHERE id=1");
  assert.equal(got[0]?.t, "LG� 스타일러", "실 서버의 text 인코딩 동작이 바뀌었다");
});
