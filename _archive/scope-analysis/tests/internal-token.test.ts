// 코어 내부 토큰(`x-scope-internal-token`) 배선 — 헤더가 **실제로 붙는지**와
// **값이 로그에 안 나오는지**를 본다.
//
// ⚠️ 여기서 잡으려는 실패는 둘 다 조용하다:
//    ① 헤더 누락 → 코어가 404(라우트 은닉) → lane 아웃박스가 "배달 실패" 로 5회 재시도 →
//      로그에 `http 404` 만 남아 **"코어 라우트 미배포"로 오진**된다.
//    ② 값이 로그·지문에 새면 리포 미러·CloudWatch 를 거쳐 조직 밖으로 나간다
//      (룰 secrets-handling 1·4).
import assert from "node:assert/strict";
import { test } from "node:test";

import { pumpOnce } from "../worker/callbacks.ts";
import {
  INTERNAL_TOKEN_HEADER,
  checkTokenWiring,
  internalAuthHeaders,
  tokenFingerprint,
  tokenWiringSummary,
} from "../worker/internal-token.ts";
import type { Settings } from "../app/settings.ts";
import type { Db } from "../app/db.ts";

const TOKEN = "unit-test-token-not-a-credential";

test("internalAuthHeaders attaches the header only when a token exists", () => {
  assert.deepEqual(internalAuthHeaders(TOKEN), { [INTERNAL_TOKEN_HEADER]: TOKEN });
  // 빈 값 헤더를 만들지 않는다 — 코어에서 불일치 404 가 되어 "미배선"과 구분되지 않는다.
  assert.deepEqual(internalAuthHeaders(null), {});
  assert.deepEqual(internalAuthHeaders(""), {});
});

test("tokenFingerprint never reveals the token and separates absence from emptiness", () => {
  const fp = tokenFingerprint(TOKEN);
  assert.equal(fp.length, 8);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.ok(!TOKEN.includes(fp), "지문이 토큰의 부분문자열이면 안 된다");
  assert.ok(!fp.includes(TOKEN.slice(0, 4)), "지문에 토큰 조각이 들어가면 안 된다");
  // 없음 / 빈 값은 같은 표기로 접지 않는다 — 둘 다 `none` 이지만 그것은 "값이 없다" 하나의 뜻이다.
  assert.equal(tokenFingerprint(null), "none");
  assert.equal(tokenFingerprint(""), "none");
  // 결정적이어야 사람이 양쪽을 대조할 수 있다.
  assert.equal(tokenFingerprint(TOKEN), fp);
});

function settingsWith(over: Partial<Settings>): Settings {
  return {
    internalTokenSecretArn: null,
    internalCallbackToken: null,
    internalContextToken: null,
    ...over,
  } as Settings;
}

test("checkTokenWiring: 시크릿 참조가 있는데 값이 없으면 문제로 본다", () => {
  // 참조 없음 = 로컬·compose·테스트. 토큰이 없는 것이 정상이다.
  assert.deepEqual(checkTokenWiring(settingsWith({})), []);

  // 참조만 있고 값이 없다 = ECS 주입 누락. 기동을 세워야 하는 상태.
  const both = checkTokenWiring(settingsWith({ internalTokenSecretArn: "arn:aws:secretsmanager:us-west-2:0:secret:x" }));
  assert.deepEqual(
    both.map((p) => p.env).sort(),
    ["ANALYSIS_INTERNAL_CALLBACK_TOKEN", "ANALYSIS_INTERNAL_CONTEXT_TOKEN"],
  );

  // 한쪽만 빠진 경우도 잡는다 — 콜백은 되는데 컨텍스트 GET 만 404 나는 상태가 제일 나쁘다
  // (분석이 컨텍스트 없이 실패하는데 원인이 콜백 경로처럼 보인다).
  const one = checkTokenWiring(
    settingsWith({
      internalTokenSecretArn: "arn:aws:secretsmanager:us-west-2:0:secret:x",
      internalCallbackToken: TOKEN,
    }),
  );
  assert.deepEqual(one.map((p) => p.env), ["ANALYSIS_INTERNAL_CONTEXT_TOKEN"]);

  // 둘 다 있으면 통과.
  assert.deepEqual(
    checkTokenWiring(
      settingsWith({
        internalTokenSecretArn: "arn:aws:secretsmanager:us-west-2:0:secret:x",
        internalCallbackToken: TOKEN,
        internalContextToken: TOKEN,
      }),
    ),
    [],
  );
});

test("tokenWiringSummary 는 값을 담지 않는다 (기동 로그 1줄)", () => {
  const summary = tokenWiringSummary(
    settingsWith({
      internalTokenSecretArn: "arn:aws:secretsmanager:us-west-2:0:secret:x",
      internalCallbackToken: TOKEN,
      internalContextToken: `${TOKEN}-other`,
    }),
  );
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(TOKEN), `요약에 토큰 값이 들어갔다: ${serialized}`);
  assert.equal(summary.secretRefConfigured, true);
  // 두 토큰이 다르면 지문도 달라야 한다 — 같으면 "로테이션이 한쪽만 됐다"를 못 본다.
  assert.notEqual(summary.callbackTokenFingerprint, summary.contextTokenFingerprint);
});

// ── 콜백 펌프가 실제로 헤더를 붙이는지 ────────────────────────────────────────────
//
// PGlite 없이 본다: pumpOnce 는 `db.query` 와 `fetch` 만 쓰므로 둘을 대역으로 갈아 끼운다.
// 목적은 SQL 이 아니라 **HTTP 헤더**이고, SQL 은 tests/lane-e2e.test.ts 가 본다.

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function fakeDb(row: { ticket_id: string; url: string }): Db {
  let first = true;
  return {
    async query<T>(): Promise<T[]> {
      // 첫 쿼리 = 아웃박스 리스(행 1개), 그 다음 = 정산 UPDATE(행 0개).
      if (first) {
        first = false;
        return [{ ...row, body: { ticketId: row.ticket_id, status: "completed" }, attempts: 0, lease_token: "t" } as unknown as T];
      }
      return [];
    },
  } as unknown as Db;
}

async function pumpWithFakeFetch(token: string | null): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
    return { status: 202 } as Response;
  }) as typeof globalThis.fetch;
  try {
    await pumpOnce(
      fakeDb({ ticket_id: "11111111-1111-5111-8111-111111111111", url: "https://core.example/api/internal/analysis-callback?w=ws" }),
      () => 0,
      token,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

test("콜백 POST 에 x-scope-internal-token 이 붙는다", async () => {
  const reqs = await pumpWithFakeFetch(TOKEN);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.headers[INTERNAL_TOKEN_HEADER], TOKEN);
  // 토큰을 URL 에 싣지 않는다 — 콜백 URL 은 티켓 본문에 실려 lane DB·양쪽 액세스 로그에
  // 앉는다(코어 #645 검증자 지적 9 가 `?k=<secret>` 을 그 이유로 기각했다).
  assert.ok(!reqs[0]!.url.includes(TOKEN), "토큰이 URL 에 들어갔다");
  assert.ok(!reqs[0]!.url.includes("k="), "capability URL 형태가 되살아났다");
});

test("토큰이 없으면 헤더 자체가 없다 (빈 값이 아니다)", async () => {
  const reqs = await pumpWithFakeFetch(null);
  assert.equal(reqs.length, 1);
  assert.ok(!(INTERNAL_TOKEN_HEADER in reqs[0]!.headers), "토큰이 없는데 헤더가 붙었다");
  // 나머지 헤더는 그대로여야 한다(회귀 가드).
  assert.equal(reqs[0]!.headers["content-type"], "application/json");
  assert.ok(reqs[0]!.headers["x-ticket-id"]);
});
