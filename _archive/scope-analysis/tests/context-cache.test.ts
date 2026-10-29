// 컨텍스트 캐시 — **2026-09-13 라이브 장애의 재현·수정 확증**.
//
// 증상: `analysis_lane.turn_failed TimeoutError("The operation was aborted due to timeout")`
//       5분에 93건 → deferred → attempt 소진. 원인은 둘이고 여기서 각각 못박는다:
//
//   ① **brotli**(1차) — undici 기본 `accept-encoding: gzip, deflate, br` 로 요청하면 코어
//      origin 이 14.4 MB JSON 을 brotli 로 압축해 **37.5초**가 걸린다(gzip 3.0s · identity 3.2s).
//      단건이 혼자 20s 상한을 넘겼다. 수정 = `accept-encoding: gzip` 명시.
//   ② **스탬피드**(증폭) — `ANALYSIS_WORKER_UNIT_CONCURRENCY=40` 이 같은 `contextVersion` 을
//      동시에 40번 가져왔다. 수정 = 버전 단위 single-flight.
//
// 그리고 무음 실패 하나(2차 캐시 적재 `catch {}`)를 카운터·로그로 끌어올린다.
//
// ⚠️ ①은 **모의가 아니라 루프백 HTTP 서버**로 본다. 헤더를 실제로 내보내는 것은 `#fetch` 뿐이고
//    (`fetchImpl` 은 헤더를 받지도 않는다), "undici 가 명시 헤더를 존중하면서 자동 해제도
//    유지하는가" 는 **런타임 버전에 달린 사실**이라 CI 런타임(node 20)에서 재확인해야 한다.
//    로컬 node v26.8.1 의 기본값은 `gzip, deflate`(br 없음)였다 — 즉 기본값에 기대면 wire
//    인코딩이 undici 빌드마다 갈린다. 그래서 명시가 결정성이다.
//
// ── 그리고 **2026-09-13 05:41Z 의 두 번째 라이브 장애(D-5)**: 봉투를 안 벗겼다.
//
//   지문: `turn_failed` 104건/6분 · `"context snapshot <ver>:... missing key: catalog"` ·
//         같은 창에 `context_fetched` **0건**. 2차 캐시는 **0행**이었다(= 코어에서 방금 받은
//         200 본문이 그대로 거부됐다). 코어 라우트는 `{version, snapshot}` 봉투로 답하는데
//         (route.ts:98~109) lane 은 본문 최상위에서 4키를 찾았다.
//   여기서 못박는 것: ⓐ 봉투를 벗긴다 ⓑ 옛 4키 최상위 형태는 **거부**한다(계약은 하나)
//         ⓒ 버전 불일치(409 든 200 봉투든)는 **permanent 종결** ⓓ 2차 캐시에는 snapshot 만
//         ⓔ 200 인데 계약 위반이면 `context_invalid` 가 뜬다(= fetch 는 됐다는 흔적).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import type { Queryable, Row } from "../app/db.ts";
import { AnalysisContractError, type LaneLogger } from "../worker/engine.ts";
import { replyForError } from "../worker/main.ts";
import { ContextCache, CONTEXT_ACCEPT_ENCODING, CONTEXT_VERSION_MISMATCH } from "../worker/context-cache.ts";

const VERSION = "22222222-2222-4222-8222-222222222222:0a1b2c3d4e5f6071";
// ⚠️ **실물 모양이다.** `catalog` 은 배열이 아니라 `{entities, industry}` 다(D-6) — 캐시 층은
//    4키 존재만 보지만, 테스트가 가짜 모양을 들고 있으면 그 가짜가 다음 결함을 가린다
//    (D-6 이 정확히 그렇게 숨었다: lane 저작 픽스처가 lane 의 틀린 가정을 재생했다).
const SNAPSHOT = {
  catalog: { entities: [], industry: { ids: [], name: null, source: "none" } },
  rels: [],
  grouping: { entityRules: [], surfaceRules: [] },
  trackedAugmentTargets: [],
};

/** 코어 200 응답 = **봉투**. 테스트가 이 모양을 한 곳에서만 만들게 한다. */
const envelope = (snapshot: unknown, version: string = VERSION) => ({ status: 200, body: { version, snapshot } });

// ── 코어 라우트 응답 픽스처 (`contracts/fixtures/core-mirror/analysis-context.*.json`) ──
//   **코어가 자기 타입으로 생성한 픽스처의 바이트 사본**이다(코어 #654 `context-fixture.ts`).
//   초판은 lane 저작이었고, 그래서 D-6 이 숨었다 — lane 이 지은 픽스처가 lane 의 틀린 가정
//   (`catalog` 이 배열)을 재생해 테스트가 초록이었다. 지금은 코어 CI 가 먼저 판정한다.
const MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));
const mirrorFx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(MIRROR + name, "utf8")) as Record<string, unknown>;
const ENVELOPE_200 = mirrorFx("analysis-context.200-envelope.json");
const BODY_409 = mirrorFx("analysis-context.409-version-mismatch.json");
const FIXTURE_VERSION = String(ENVELOPE_200.version);

interface Captured {
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}
function capturingLog(): { log: LaneLogger; lines: Captured[] } {
  const lines: Captured[] = [];
  const push = (level: Captured["level"]) => (event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ level, event, fields });
  };
  return { log: { info: push("info"), warn: push("warn"), error: push("error") }, lines };
}

/** DB 없는 테스트용. `onInsert` 가 던지면 2차 캐시 적재 실패 경로다. */
function fakeDb(opts: { hit?: Row | null; onInsert?: () => void } = {}): Queryable & { inserts: number } {
  const db = {
    inserts: 0,
    async query<T extends Row = Row>(text: string): Promise<T[]> {
      if (text.includes("INSERT INTO analysis_contexts")) {
        db.inserts += 1;
        opts.onInsert?.();
        return [] as T[];
      }
      return (opts.hit ? [opts.hit] : []) as T[];
    },
  };
  return db;
}

// ── ② single-flight ────────────────────────────────────────────────────────────

test("동시 40건이 같은 contextVersion 을 요구하면 fetch 는 **1회** 다 (스탬피드 재현·차단)", async () => {
  let fetches = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 8,
    maxBytes: 100_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => {
      fetches += 1;
      // 첫 fetch 를 붙잡아 **40건이 전부 진행 중 상태에 도달하도록** 만든다. 이 게이트가 없으면
      // 첫 건이 순식간에 끝나 나머지가 1차 LRU 적중으로 통과해, single-flight 를 지워도 통과한다.
      await gate;
      return envelope(structuredClone(SNAPSHOT));
    },
  });

  const db = fakeDb();
  // ⚠️ await 없이 40개를 먼저 띄운다 — 하나씩 await 하면 스탬피드가 아니다.
  const pending = Array.from({ length: 40 }, () => cache.get(db, VERSION, "https://core.invalid/ctx"));
  assert.equal(fetches, 1, `진행 중 fetch 가 공유되지 않았다 (fetches=${fetches})`);
  release!();
  const all = await Promise.all(pending);

  assert.equal(fetches, 1, `40 동시 요청이 fetch 를 ${fetches}회 냈다 — single-flight 가 깨졌다`);
  for (const s of all) {
    assert.equal(s.contextVersion, VERSION);
    // 같은 스냅샷 **객체**를 받아야 한다. 복제본이면 40벌이 힙에 남는다(14 MB × 40).
    assert.equal(s, all[0], "호출자마다 다른 스냅샷 인스턴스를 받았다");
  }
  assert.equal(cache.stats.misses, 1, "미스가 1회여야 한다");
  assert.equal(cache.stats.coalesced, 39, `합류 카운터가 39 가 아니다: ${cache.stats.coalesced}`);
});

test("진행 중 fetch 가 실패하면 **다음 호출이 다시 시도한다** — 실패를 캐시하지 않는다", async () => {
  let fetches = 0;
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 8,
    maxBytes: 100_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("boom: upstream down");
      return envelope(structuredClone(SNAPSHOT));
    },
  });
  const db = fakeDb();

  await assert.rejects(() => cache.get(db, VERSION, "https://core.invalid/ctx"), /boom: upstream down/);
  // 실패 Promise 가 map 에 남아 있으면 여기서 같은 예외가 **fetch 없이** 재생된다.
  const snap = await cache.get(db, VERSION, "https://core.invalid/ctx");
  assert.equal(snap.contextVersion, VERSION);
  assert.equal(fetches, 2, `재시도가 업스트림에 닿지 않았다 (fetches=${fetches})`);
  assert.equal(cache.stats.fetchErrors, 1);
});

test("동시 요청 전부가 실패해도 대기자 모두가 예외를 받는다 (삼켜지는 호출자 0)", async () => {
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 4,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  const db = fakeDb();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => cache.get(db, VERSION, "https://core.invalid/ctx")),
  );
  assert.equal(results.filter((r) => r.status === "rejected").length, 8, "일부 호출자가 조용히 성공했다");
});

test("서로 다른 contextVersion 은 서로를 막지 않는다 — single-flight 키가 버전이다", async () => {
  let fetches = 0;
  const other = "33333333-3333-4333-8333-333333333333:beefbeefbeefbeef";
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 8,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    // 봉투의 `version` 은 **요청한 버전과 같아야** 한다 — 코어가 다른 값을 주면 종결이다(D-5).
    fetchImpl: async (ref) => {
      fetches += 1;
      return envelope(structuredClone(SNAPSHOT), ref.endsWith("/b") ? other : VERSION);
    },
  });
  const db = fakeDb();
  await Promise.all([cache.get(db, VERSION, "https://core.invalid/a"), cache.get(db, other, "https://core.invalid/b")]);
  assert.equal(fetches, 2, "다른 버전이 하나로 합쳐졌다 — 그러면 한쪽이 틀린 스냅샷을 쓴다");
});

// ── 2차 캐시 적재 실패는 **무음이 아니다** ──────────────────────────────────────

test("2차 캐시 적재가 실패하면 카운터 + warn 으로 표면화한다 (분석은 계속 돈다)", async () => {
  const { log, lines } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 4,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: true,
    log,
    fetchImpl: async () => envelope(structuredClone(SNAPSHOT)),
  });
  const db = fakeDb({
    onInsert: () => {
      // 라이브에서 실제로 났던 모양: uuid 가 아닌 접두사를 uuid 컬럼에 넣어 트랜잭션이 죽는다.
      throw new Error('invalid input syntax for type uuid: "unscoped"');
    },
  });

  const snap = await cache.get(db, VERSION, "https://core.invalid/ctx");
  assert.equal(snap.contextVersion, VERSION, "적재 실패가 분석을 죽였다 — 안전한 실패 방향이 아니다");
  assert.equal(cache.stats.storeErrors, 1, "storeErrors 카운터가 안 올랐다");

  const warn = lines.find((l) => l.event === "analysis_lane.context_cache_store_failed");
  assert.ok(warn, `적재 실패가 조용히 지나갔다 — 지문이 '적중률 0' 밖에 안 남는다 (events=${lines.map((l) => l.event).join(",")})`);
  assert.equal(warn.level, "warn");
  assert.equal(warn.fields.contextVersion, VERSION);
  assert.match(String(warn.fields.message), /invalid input syntax for type uuid/);
});

test("적재가 성공하는 정상 경로에서는 storeErrors 가 0 이고 경고도 없다 (모수 확인)", async () => {
  const { log, lines } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 4,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: true,
    log,
    fetchImpl: async () => envelope(structuredClone(SNAPSHOT)),
  });
  const db = fakeDb();
  await cache.get(db, VERSION, "https://core.invalid/ctx");
  assert.equal(db.inserts, 1, "2차 캐시에 적재하지 않았다");
  assert.equal(cache.stats.storeErrors, 0);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.context_cache_store_failed").length, 0);
});

// ── ① accept-encoding — 실제 소켓으로 본다 ─────────────────────────────────────

async function listen(handler: (ae: string) => { encoding: string | null; body: Buffer }): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const srv: Server = createServer((req, res) => {
    const ae = String(req.headers["accept-encoding"] ?? "");
    seen.push(ae);
    const { encoding, body } = handler(ae);
    res.setHeader("content-type", "application/json");
    if (encoding) res.setHeader("content-encoding", encoding);
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/api/internal/analysis-context/x/y/z`,
    seen,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("컨텍스트 fetch 는 `accept-encoding: gzip` 을 **명시**하고, gzip 응답을 투명하게 해제한다", async () => {
  // 이 테스트가 지키는 사실 두 개:
  //   ⓐ 나가는 헤더가 정확히 `gzip` 이다 → origin 이 brotli 를 고르지 않는다(37.5s 회귀 차단).
  //   ⓑ 명시해도 undici 가 자동 해제를 계속 한다 → 수동 해제 코드를 들일 필요가 없다.
  //      ⓑ는 런타임 버전에 달린 사실이라 CI(node 20)에서 매번 확인해야 한다.
  // 소켓에 나가는 것은 **봉투**이고, 로그·LRU 가 세는 `bytes` 는 **snapshot 기준**이다
  // (2차 캐시에 넣는 것이 snapshot 이므로 두 경로의 기준이 같아야 한다 — context-cache.ts 주석).
  const snapshotBytes = Buffer.byteLength(JSON.stringify(SNAPSHOT), "utf8");
  const payload = Buffer.from(JSON.stringify({ version: VERSION, snapshot: SNAPSHOT }), "utf8");
  assert.ok(payload.byteLength > snapshotBytes, "봉투가 snapshot 보다 커야 두 기준의 차이가 실제로 검사된다");
  const srv = await listen((ae) => {
    // origin 흉내: br 을 받아들인다고 하면 br 을 고른다(라이브 코어의 동작).
    if (/\bbr\b/.test(ae)) return { encoding: "br", body: Buffer.from("brotli-should-not-happen") };
    if (/\bgzip\b/.test(ae)) return { encoding: "gzip", body: gzipSync(payload) };
    return { encoding: null, body: payload };
  });
  try {
    const { log, lines } = capturingLog();
    const cache = new ContextCache({
      maxEntries: 2,
      maxBytes: 10_000_000,
      fetchTimeoutMs: 5_000,
      dbCacheEnabled: false,
      log,
      // ⚠️ fetchImpl 을 **주지 않는다** — 실제 `#fetch` 경로를 타야 헤더가 소켓에 나간다.
    });
    const snap = await cache.get(fakeDb(), VERSION, srv.url);

    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0], CONTEXT_ACCEPT_ENCODING, `origin 이 받은 accept-encoding 이 gzip 이 아니다: ${JSON.stringify(srv.seen[0])}`);
    assert.doesNotMatch(String(srv.seen[0]), /\bbr\b/, "br 이 남아 있다 — 라이브 37.5초 경로가 되살아난다");
    assert.deepEqual(snap.catalog, SNAPSHOT.catalog, "gzip 응답이 해제되지 않았다");
    assert.deepEqual(snap.trackedAugmentTargets, []);

    // 버전당 1회 관측 로그 — 타임아웃이 났을 때 '느린 코어'와 '큰 스냅샷'을 구분할 근거다.
    const fetched = lines.filter((l) => l.event === "analysis_lane.context_fetched");
    assert.equal(fetched.length, 1, `context_fetched 가 ${fetched.length}회 — 버전당 1회여야 한다`);
    assert.equal(fetched[0]!.fields.contextVersion, VERSION);
    assert.equal(fetched[0]!.fields.bytes, snapshotBytes, "바이트 기준이 snapshot 이 아니다(봉투를 쟀다)");
    assert.equal(typeof fetched[0]!.fields.fetchMs, "number");
    assert.equal(fetched[0]!.fields.timeoutMs, 5_000);

    // 1차 적중은 다시 fetch 하지 않는다(로그도 안 는다).
    await cache.get(fakeDb(), VERSION, srv.url);
    assert.equal(srv.seen.length, 1, "1차 캐시 적중이 소켓을 다시 열었다");
    assert.equal(lines.filter((l) => l.event === "analysis_lane.context_fetched").length, 1);
  } finally {
    await srv.close();
  }
});

test("http 오류 응답은 예외로 올라온다 — 빈 스냅샷으로 조용히 분석하지 않는다", async () => {
  const srv = await listen(() => ({ encoding: null, body: Buffer.from("nope") }));
  try {
    const failing = createServer((_req, res) => {
      res.statusCode = 404;
      res.end("hidden");
    });
    await new Promise<void>((r) => failing.listen(0, "127.0.0.1", () => r()));
    const addr = failing.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const cache = new ContextCache({
      maxEntries: 2,
      maxBytes: 1_000_000,
      fetchTimeoutMs: 5_000,
      dbCacheEnabled: false,
      log: capturingLog().log,
    });
    // 코어는 토큰이 틀리면 라우트를 **404 로 숨긴다** — 그 404 가 빈 카탈로그로 접히면 안 된다.
    await assert.rejects(() => cache.get(fakeDb(), VERSION, `http://127.0.0.1:${port}/ctx`), /context fetch failed: http 404/);
    await new Promise<void>((r) => failing.close(() => r()));
  } finally {
    await srv.close();
  }
});

// ── D-5: 코어 GET 응답은 **봉투**다 ────────────────────────────────────────────
//
//   `{ version, snapshot: {catalog, rels, grouping, trackedAugmentTargets} }`
//   (코어 `app/api/internal/analysis-context/[workspaceId]/[projectId]/[version]/route.ts:98~109`)

/** INSERT 파라미터까지 잡는 DB 대역 — "2차 캐시에 **무엇이** 들어갔나" 를 보기 위해서다. */
function capturingDb(): Queryable & { inserts: unknown[][] } {
  const db = {
    inserts: [] as unknown[][],
    async query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]> {
      if (text.includes("INSERT INTO analysis_contexts")) {
        db.inserts.push([...(params ?? [])]);
        return [] as T[];
      }
      return [] as T[];
    },
  };
  return db;
}

test("코어 200 봉투를 벗겨 4키 스냅샷을 만든다 (미러 픽스처로 먹인다)", async () => {
  const { log, lines } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => ({ status: 200, body: structuredClone(ENVELOPE_200) }),
  });

  const snap = await cache.get(fakeDb(), FIXTURE_VERSION, "https://core.invalid/ctx");
  assert.equal(snap.contextVersion, FIXTURE_VERSION);
  // 4키가 **최상위**에 있어야 한다 — 초판은 봉투를 그대로 넘겨 `missing key: catalog` 로 죽었다.
  for (const k of ["catalog", "rels", "grouping", "trackedAugmentTargets"] as const) {
    assert.ok(k in snap, `스냅샷에 ${k} 가 없다 — 봉투를 안 벗겼다`);
  }
  assert.equal("version" in snap, false, "봉투의 version 이 스냅샷에 섞여 들어왔다");
  assert.equal("snapshot" in snap, false, "봉투가 통째로 스냅샷 자리에 들어갔다");
  assert.equal(cache.stats.invalid, 0);
  assert.equal(lines.filter((l) => l.event === "analysis_lane.context_fetched").length, 1);
});

test("옛 형태(4키 최상위)는 **거부**한다 — 계약은 하나여야 한다", async () => {
  const { log, lines } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    // 봉투 이전의 모양. 이것을 폴백으로 받아 주면 계약이 둘이 되고, 코어가 어느 쪽을 보내는지
    // 아무도 모르게 된다(D-5 가 바로 그 상태였다 — 다만 방향이 반대였을 뿐).
    fetchImpl: async () => ({ status: 200, body: structuredClone(SNAPSHOT) }),
  });

  await assert.rejects(
    () => cache.get(fakeDb(), VERSION, "https://core.invalid/ctx"),
    /is not the \{version,snapshot\} envelope/,
  );
  assert.equal(cache.stats.invalid, 1);

  // **관측 공백의 수정**: 파싱이 죽어도 "fetch 는 됐다" 가 보여야 한다(라이브에서는
  // `context_fetched` 0건만 남아 fetch 성공 여부를 로그로 판단할 수 없었다).
  const warn = lines.find((l) => l.event === "analysis_lane.context_invalid");
  assert.ok(warn, `context_invalid 가 없다 (events=${lines.map((l) => l.event).join(",")})`);
  assert.equal(warn.level, "warn");
  assert.equal(warn.fields.contextVersion, VERSION);
  assert.equal(warn.fields.httpStatus, 200);
  assert.deepEqual(warn.fields.topLevelKeys, ["catalog", "rels", "grouping", "trackedAugmentTargets"]);
  assert.equal(warn.fields.bytes, Buffer.byteLength(JSON.stringify(SNAPSHOT), "utf8"));
  // 200 이므로 `context_fetched` 는 안 뜬다(파싱 성공 후에만 뜬다) — 두 로그의 역할이 갈린다.
  assert.equal(lines.filter((l) => l.event === "analysis_lane.context_fetched").length, 0);
});

test("`context_invalid` 는 **키 이름만** 싣는다 — 값은 워크스페이스 전체 카탈로그다", async () => {
  const { log, lines } = capturingLog();
  const secret = "SECRET-BRAND-NAME-DO-NOT-LOG";
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => ({ status: 200, body: { catalog: [{ canonical: secret }], oops: 1 } }),
  });
  await assert.rejects(() => cache.get(fakeDb(), VERSION, "https://core.invalid/ctx"));
  const warn = lines.find((l) => l.event === "analysis_lane.context_invalid");
  assert.ok(warn);
  assert.deepEqual(warn.fields.topLevelKeys, ["catalog", "oops"]);
  assert.doesNotMatch(JSON.stringify(warn), new RegExp(secret), "로그 한 줄에 스냅샷 **내용**이 실렸다");
});

test("코어 409 version_mismatch 는 **permanent 로 종결**된다 (재시도가 같은 답을 받는다)", async () => {
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    fetchImpl: async () => ({ status: 409, body: structuredClone(BODY_409) }),
  });

  const err = await cache.get(fakeDb(), VERSION, "https://core.invalid/ctx").then(
    () => null,
    (e: unknown) => e,
  );
  // ① 분류가 **정산 등급을 결정한다** — `replyForError` ① 이 이 클래스만 permanent 로 보낸다.
  assert.ok(err instanceof AnalysisContractError, `409 가 계약 오류로 올라오지 않았다: ${String(err)}`);
  assert.ok(err.message.startsWith(`${CONTEXT_VERSION_MISMATCH}:`), `사유 접두사가 없다: ${err.message}`);
  assert.match(err.message, new RegExp(`requested=${VERSION}`));
  // ② `currentVersion` 이 사유에 있어야 코어가 **무엇으로 재발행하면 되는지** 알 수 있다.
  assert.match(err.message, new RegExp(String(BODY_409.currentVersion)));

  const rep = replyForError({
    ticketId: "11111111-1111-4111-8111-111111111111",
    traceId: "44444444-4444-4444-8444-444444444444",
    analysisVersion: "2026-09-13",
    attempt: 1,
    error: err,
  });
  assert.equal(rep.status, "failed");
  assert.equal(rep.terminalReason, "permanent");
  assert.equal(rep.deferred, null);
  // 512 절단에 표식·두 버전이 먹히면 안 된다 — 그래서 메시지 **앞**에 둔다.
  assert.ok(String(rep.failureReason).startsWith(`${CONTEXT_VERSION_MISMATCH}:`));
  assert.match(String(rep.failureReason), new RegExp(String(BODY_409.currentVersion)));
  assert.ok(String(rep.failureReason).length <= 512);
});

test("200 인데 봉투의 version 이 다르면 종결이다 — 틀린 컨텍스트를 요청 버전으로 캐시하지 않는다", async () => {
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    // 코어가 409 를 내야 하는 상황인데 200 으로 답한 경우(코어 결함). 조용히 통과하면 그
    // 프로세스는 수명 내내 **틀린 스냅샷**으로 분석한다.
    fetchImpl: async () => envelope(structuredClone(SNAPSHOT), FIXTURE_VERSION),
  });
  const err = await cache.get(fakeDb(), VERSION, "https://core.invalid/ctx").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AnalysisContractError);
  assert.ok(err.message.startsWith(`${CONTEXT_VERSION_MISMATCH}:`));
  assert.match(err.message, new RegExp(`requested=${VERSION}`));
  assert.match(err.message, new RegExp(`current=${FIXTURE_VERSION}`));
  assert.equal(cache.stats.invalid, 1, "봉투 검사 실패는 invalid 로 센다");
});

test("404 는 **재시도한다**(deferred/transient) — 설정 결함은 사람이 고치면 같은 티켓이 성공한다", async () => {
  const { log } = capturingLog();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: false,
    log,
    // 코어는 토큰 불일치·id 형식 오류를 전부 404 로 숨긴다(route.ts:69~79).
    fetchImpl: async () => ({ status: 404, body: { error: { code: "not_found" } } }),
  });
  const err = await cache.get(fakeDb(), VERSION, "https://core.invalid/ctx").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof AnalysisContractError), "404 를 종결로 올리면 코어가 재발행하지 않아 그 턴이 사라진다");
  assert.match(err.message, /context fetch failed: http 404/);

  const rep = replyForError({
    ticketId: "11111111-1111-4111-8111-111111111111",
    traceId: "44444444-4444-4444-8444-444444444444",
    analysisVersion: "2026-09-13",
    attempt: 1,
    error: err,
  });
  assert.equal(rep.status, "deferred");
  assert.equal(rep.deferred?.failureClass, "transient");
  assert.equal(rep.terminalReason, null);
});

test("2차 캐시에는 **snapshot 만** 저장한다 (마이그레이션 0004 의 payload 모양)", async () => {
  const { log } = capturingLog();
  const db = capturingDb();
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: true,
    log,
    fetchImpl: async () => ({ status: 200, body: structuredClone(ENVELOPE_200) }),
  });
  await cache.get(db, FIXTURE_VERSION, "https://core.invalid/ctx");

  assert.equal(db.inserts.length, 1, "2차 캐시에 적재하지 않았다");
  const [version, , payload, bytes] = db.inserts[0]!;
  assert.equal(version, FIXTURE_VERSION);
  const stored = payload as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["catalog", "grouping", "rels", "trackedAugmentTargets"],
    "봉투가 그대로 들어갔다 — 0004 주석(payload = 4키)과 어긋난다",
  );
  // `payload_bytes` 기준도 **snapshot** 이다(봉투 아님). 2차 적중이 이 값을 그대로 LRU 에 넘긴다.
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(ENVELOPE_200.snapshot), "utf8"));
});

test("2차 캐시 적중은 봉투를 기대하지 않는다 — 저장한 모양 그대로 되읽는다", async () => {
  const { log } = capturingLog();
  const snapshot = structuredClone(ENVELOPE_200.snapshot) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  const cache = new ContextCache({
    maxEntries: 2,
    maxBytes: 10_000_000,
    fetchTimeoutMs: 5_000,
    dbCacheEnabled: true,
    log,
    fetchImpl: async () => {
      throw new Error("2차 적중인데 코어로 샜다");
    },
  });
  const db = fakeDb({ hit: { payload: snapshot, payload_bytes: bytes } });
  const snap = await cache.get(db, FIXTURE_VERSION, "https://core.invalid/ctx");
  assert.equal(snap.contextVersion, FIXTURE_VERSION);
  assert.deepEqual(snap.catalog, (ENVELOPE_200.snapshot as { catalog: unknown }).catalog);
  assert.equal(cache.stats.hitsDb, 1);
  assert.equal(cache.stats.invalid, 0);
});
