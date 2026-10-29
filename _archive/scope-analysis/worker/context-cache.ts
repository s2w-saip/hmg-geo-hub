// 분석 컨텍스트 스냅샷 캐시 — 3층.
//
//     프로세스 LRU (1차)  →  lane PG `analysis_contexts` (2차)  →  코어 GET `ref` (3차)
//
// ── 왜 참조 + 캐시인가 (스펙 §4.5)
//
//   투영(LLM 프롬프트에 들어가는 축약본)은 최악 ~141 KB 라 매 티켓에 직접 실어도 인그레스 2 MB
//   안이다. 참조로 가는 이유는 **대역폭**이다: 300/min × 141 KB ≈ 42 MB/min 이고 그 내용은 회차
//   내내 사실상 같은 바이트다. 참조 + 버전 캐시면 전송이 **버전당 1회**로 준다.
//
// ── 무효화가 TTL 이 아니다
//
//   `contextVersion` 은 **내용 해시**(`<projectId>:<sha256(canonical JSON)[:16]>`)다. 네 소스
//   (`catalog`·`rels`·`grouping`·`trackedAugmentTargets`) 중 무엇이 바뀌어도 버전이 바뀐다.
//   그래서 구 P2 의 "TTL + 60초 3문장 무효화 프로브" 가 통째로 불필요하다 — "묶음 규칙을 바꾼
//   직후 최대 10분간 옛 규칙" 같은 창이 존재하지 않는다.
//   **stale 판정은 코어가 한다**: lane 은 티켓에 실린 버전을 그대로 쓰고, 캐시에 없으면 가져온다.
//   무효화 = 코어가 현재 해시로 티켓을 재발행하는 것.
//
// ⚠️ 스냅샷 원본 바이트는 더 이상 미측정이 아니다(§14-1 해소, 2026-09-13 라이브 실측):
//    코어 `GET /api/internal/analysis-context/{ws}/{project}/{version}` 이 200 으로 돌려주는
//    JSON 이 **14.4 MB**(gzip 3.4 MB, 그 중 `catalog` 8.4 MB)이고 로컬에서 3.0s 걸렸다.
//    `contextCacheMaxBytes` 기본 256 MB 는 그 크기의 항목 ~18개를 담는다는 뜻이다.
//
// ── 이 파일이 라이브를 죽인 자리 (2026-09-13) — 원인은 **둘**이고 순서가 중요하다
//
//   증상: `analysis_lane.turn_failed TimeoutError("The operation was aborted due to timeout")`
//         **5분에 93건** → 전부 deferred → attempt 소진 종결.
//
//   ① **1차 원인은 brotli 다**(`#httpFetch` 주석에 실측). undici 기본 `accept-encoding` 이
//      `gzip, deflate, br` 이라 코어 origin 이 14.4 MB 를 brotli 로 압축했고 **단건 fetch 가
//      37.5초**였다 — `contextFetchTimeoutMs` 20s 를 **혼자서** 넘긴다(워커 로그: `worker_start`
//      → 20.5초 뒤 `turn_failed`). `accept-encoding: gzip` 을 명시하면 같은 응답이 3.0초다.
//
//   ② **스탬피드는 그 위의 증폭이다.** 워커는 `ANALYSIS_WORKER_UNIT_CONCURRENCY=40` 으로
//      같은 `contextVersion` 의 티켓 40개를 동시에 처리하는데, 초판 `get()` 에는 진행 중 fetch 를
//      공유하는 장치가 없어 1·2차 캐시가 빈 상태에서 40개가 **각자** 14 MB 를 받아 각자
//      `JSON.parse` 했다. (동시 8건 gzip 이 각 3.5초인 것으로 보아 코어 쪽 경합은 아니다 —
//      대역폭·단일 스레드 parse 를 40으로 나누는 lane 쪽 문제다.)
//
//   그래서 버전 단위 single-flight 를 둔다: 진행 중이면 **그 Promise 를 공유**하고, 실패하면
//   공유 Promise 를 지워 다음 호출이 다시 시도한다(실패를 캐시하면 그 버전이 프로세스 수명 내내
//   같은 예외를 재생한다). 2차(DB) 조회도 같은 single-flight 안이다 — 밖에 두면 40개가 같은
//   `UPDATE … RETURNING payload` 로 14 MB 행을 40번 끌어온다.
//   ①을 고쳤으니 ②는 안 고쳐도 되는 것 아니냐 — **아니다.** ①은 "한 번이 3초"로 만들 뿐이고
//   그 3초를 40배로 쓰는 것은 그대로다. 상한 60s 상향도 같은 층의 방어선이다(셋 다 유지).
//
// ── 두 번째로 라이브를 죽인 자리 (2026-09-13 05:41Z, D-5) — **봉투를 안 벗겼다**
//
//   지문: `analysis_lane.turn_failed` **104건/6분**,
//         `errorMessage: "context snapshot <version> missing key: catalog"`, 전부 deferred.
//         같은 창에 `analysis_lane.context_fetched` **0건**.
//   배제: 2차 캐시 오염이 아니다 — lane RDS `analysis_contexts` 를 직접 센 결과 **0행**이었다.
//         즉 코어에서 **방금 받은 200 본문**이 그대로 `parseSnapshot` 에 들어가 거부됐다.
//   원인: 코어 라우트는 **봉투**로 답한다 —
//         `{ version, snapshot: {catalog, rels, grouping, trackedAugmentTargets} }`
//         (코어 `app/api/internal/analysis-context/[workspaceId]/[projectId]/[version]/route.ts:98~109`).
//         lane 은 본문 **최상위**에서 4키를 찾았다. = 계약 드리프트(#7 D-1 과 같은 부류).
//
//   그래서 이 파일이 계약을 **세 층에서 하나로** 잡는다:
//     · 3차(코어 wire) = **봉투만** 받는다. 옛 4키 최상위 형태는 거부한다 — "둘 다 받는다" 는
//       계약이 둘이라는 뜻이고, 그러면 어느 쪽이 맞는지 아무도 모르게 된다.
//     · 2차(lane PG `analysis_contexts.payload`) = **snapshot 만** 저장한다(0004 주석과 일치).
//       봉투를 통째로 넣으면 DB 적중 경로와 코어 경로가 서로 다른 모양을 보게 된다.
//     · 버전 불일치는 **종결**이다(409 든 200 봉투의 version 불일치든) — 요청한 버전은 이제
//       존재하지 않으므로 재시도가 같은 답을 받는다. 코어가 새 버전으로 재발행해야 한다.
//
//   관측 공백도 같이 메운다: 초판은 `parseSnapshot` 을 `context_fetched` **앞**에서 돌려서,
//   파싱이 죽으면 "fetch 는 성공했다" 는 사실이 로그에 한 줄도 안 남았다(그래서 라이브에서
//   `context_fetched` 0건만 보였다). 이제 200 인데 계약을 못 통과하면
//   `analysis_lane.context_invalid`(warn)가 **최상위 키 이름만** 들고 뜬다.
import { AnalysisContractError, type AnalysisContextSnapshot, type LaneLogger } from "./engine.ts";
import { fromJsonb, one, type Queryable } from "../app/db.ts";
import { log as defaultLog } from "../app/log.ts";
import { parseContextVersionProjectId } from "../contracts/index.ts";
import { internalAuthHeaders } from "./internal-token.ts";

export interface ContextCacheStats {
  entries: number;
  bytes: number;
  hitsProcess: number;
  hitsDb: number;
  misses: number;
  fetchErrors: number;
  /** 진행 중 적재에 올라탄 호출 수 = single-flight 가 실제로 막은 중복 fetch 수. */
  coalesced: number;
  /** 2차 캐시 적재 실패(무음이던 자리). 0 이 아니면 적중률이 조용히 떨어지고 있다. */
  storeErrors: number;
  /**
   * **200 을 받았는데 계약을 못 통과한** 응답 수(D-5 의 지문). 0 이 아니면 코어↔lane 계약이
   * 갈린 것이다 — `fetchErrors`(전송·상태 실패)와 축이 다르므로 따로 센다.
   */
  invalid: number;
}

interface Entry {
  snapshot: AnalysisContextSnapshot;
  bytes: number;
}

export interface ContextCacheOptions {
  maxEntries: number;
  maxBytes: number;
  fetchTimeoutMs: number;
  dbCacheEnabled: boolean;
  /**
   * 코어 컨텍스트 GET 의 `x-scope-internal-token`. 코어 라우트는 이 값이 없거나 틀리면
   * **404** 로 라우트를 숨긴다(시크릿 미설정 시 통과 경로는 없다 — 이 응답이 워크스페이스
   * 전체 카탈로그이기 때문이다). 근거: `worker/internal-token.ts`.
   * ⚠️ 3차(코어) 미스에만 쓰인다. 1·2차 캐시 적중은 코어에 닿지 않는다.
   */
  internalToken?: string | null;
  /**
   * 테스트·대체 전송용. 기본은 실 HTTP.
   *
   * ⚠️ **상태를 함께 돌려준다**(D-5). 본문만 돌려주던 초판으로는 409 `version_mismatch` 를
   *    테스트가 재현할 수 없었다 — 상태 분기가 소켓 뒤에만 있었기 때문이다. 계약이
   *    `{status, body}` 인 덕에 `contracts/fixtures/core-mirror/analysis-context.*.json` 을
   *    그대로 먹여 정산 등급까지 볼 수 있다.
   */
  fetchImpl?: (ref: string, signal: AbortSignal) => Promise<ContextFetchResult>;
  /** 기본은 프로세스 로거. 테스트가 조용한 로거를 끼울 수 있게 주입 가능하게 둔다. */
  log?: LaneLogger;
}

/** 코어 컨텍스트 GET 의 응답 — 상태 + 본문. 본문은 **200·409 에서만** 읽는다(`#httpFetch`). */
export interface ContextFetchResult {
  status: number;
  body: unknown;
}

/**
 * 컨텍스트 GET 이 보내는 `accept-encoding`. **`br` 를 넣지 않는다** — 이유는 `#httpFetch` 주석
 * (brotli 37.5s vs gzip 3.0s 실측). 상수로 빼 둔 것은 테스트가 같은 값을 단언하기 위해서다.
 */
export const CONTEXT_ACCEPT_ENCODING = "gzip";

/**
 * 버전 불일치 사유의 **기계 판독 접두사**. `replyForError` ① 이 이 메시지를 그대로
 * `failureReason` 으로 싣고 `terminalReason: "permanent"` 로 종결한다(`worker/main.ts:136~144`).
 */
export const CONTEXT_VERSION_MISMATCH = "context_version_mismatch";

/**
 * 요청한 버전을 코어가 줄 수 없다 → **종결(permanent)**. 코어가 현재 해시로 재발행하는 것이
 * 유일한 진행 경로이므로 같은 티켓을 다시 돌리는 것은 실비만 쓴다.
 *
 * ⚠️ 표식과 두 버전을 **맨 앞에** 둔다 — `failureReason` 은 `.max(512)` 라 뒤에 붙이면 잘려
 *    사라진다(`worker/main.ts` `minimalFailureReply` 의 같은 흉터). 두 버전 합쳐 ~110자다.
 */
function versionMismatchError(requested: string, current: unknown, via: string): AnalysisContractError {
  const cur = typeof current === "string" && current.length > 0 ? current.slice(0, 128) : "unknown";
  return new AnalysisContractError(
    `${CONTEXT_VERSION_MISMATCH}: requested=${requested.slice(0, 128)} current=${cur} (${via}) — ` +
      `코어가 현재 버전으로 티켓을 재발행해야 한다`,
  );
}

/**
 * 로그·에러 메시지에 쓰는 **키 이름만**. 값은 절대 싣지 않는다(`app/log.ts` 머리말: 시크릿·
 * 답변 본문 금지). 키가 폭주하는 본문을 받아도 로그 한 줄이 깨지지 않게 20개·64자로 자른다.
 */
export function topLevelKeys(value: unknown): string[] {
  if (Array.isArray(value)) return ["<array>"];
  if (value === null) return ["<null>"];
  if (typeof value !== "object") return [`<${typeof value}>`];
  return Object.keys(value as Record<string, unknown>)
    .slice(0, 20)
    .map((k) => k.slice(0, 64));
}

/** 바이트 수 — 순환 참조·undefined 로 재는 데 실패하면 **-1**(미측정)이다. 0 과 구분한다. */
function safeByteLength(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? Buffer.byteLength(s, "utf8") : -1;
  } catch {
    return -1;
  }
}

/**
 * 코어 200 본문 → 스냅샷. **봉투만 받는다.**
 *
 * 코어 계약(route.ts:98~109): `{ version: string, snapshot: {catalog, rels, grouping,
 * trackedAugmentTargets} }`. 옛 형태(4키 최상위)를 폴백으로 받아 주지 않는 이유는 D-5 의
 * 교훈 그대로다 — 둘 다 받으면 **계약이 둘**이 되고, 코어가 어느 쪽을 보내고 있는지 로그로
 * 구분할 수 없게 된다. 하나만 받고 아니면 거부한다.
 *
 * `version` 이 요청과 다르면 **조용히 통과시키지 않는다**: 그 응답을 요청 버전으로 캐시하면
 * 그 프로세스는 수명 내내 **틀린 컨텍스트로 분석**한다(코어 route.ts 머리말의 409 가 막으려는
 * 바로 그 사고를 lane 쪽에서 다시 막는 층이다).
 */
export function unwrapContextEnvelope(contextVersion: string, body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`context response ${contextVersion} is not an object (got ${topLevelKeys(body).join(",")})`);
  }
  const b = body as Record<string, unknown>;
  if (!("version" in b) || !("snapshot" in b)) {
    // 옛 4키 최상위 형태가 여기로 떨어진다 — 키 이름은 계약 소속이라 로그에 남겨도 된다.
    throw new Error(
      `context response ${contextVersion} is not the {version,snapshot} envelope ` +
        `(top-level keys: ${topLevelKeys(b).join(",")})`,
    );
  }
  if (typeof b.version !== "string" || b.version.length === 0) {
    throw new Error(`context response ${contextVersion} envelope has a non-string version`);
  }
  if (b.version !== contextVersion) throw versionMismatchError(contextVersion, b.version, "200 envelope");
  return b.snapshot;
}

function parseSnapshot(contextVersion: string, payload: unknown): AnalysisContextSnapshot {
  if (payload === null || typeof payload !== "object") {
    throw new Error(`context snapshot ${contextVersion} is not an object`);
  }
  const p = payload as Record<string, unknown>;
  // 네 키가 전부 있어야 한다. 하나라도 빠지면 **조용히 품질이 떨어지는** 분석이 된다 —
  // 예컨대 `grouping` 이 없으면 롤업 판정이 통째로 달라지는데 예외는 안 난다.
  for (const k of ["catalog", "rels", "grouping", "trackedAugmentTargets"] as const) {
    if (!(k in p)) throw new Error(`context snapshot ${contextVersion} missing key: ${k}`);
  }
  // ⚠️ `entityNames` 가 들어 있으면 경계가 샌 것이다 — 그것은 persist 전용이라 lane 에 올 수 없다.
  if ("entityNames" in p) {
    throw new Error(`context snapshot ${contextVersion} carries entityNames (persist-only; boundary leak)`);
  }
  return {
    contextVersion,
    catalog: p.catalog,
    rels: p.rels,
    grouping: p.grouping,
    trackedAugmentTargets: p.trackedAugmentTargets,
  };
}

export class ContextCache {
  #map = new Map<string, Entry>(); // Map 의 삽입 순서 = LRU 순서(적중 시 삭제 후 재삽입)
  #bytes = 0;
  #stats = { hitsProcess: 0, hitsDb: 0, misses: 0, fetchErrors: 0, coalesced: 0, storeErrors: 0, invalid: 0 };
  /** 진행 중 적재(2차 조회 + 3차 fetch). 키는 `contextVersion` — 버전이 곧 내용 해시다. */
  #inflight = new Map<string, Promise<AnalysisContextSnapshot>>();

  constructor(private readonly opts: ContextCacheOptions) {}

  get stats(): ContextCacheStats {
    return { entries: this.#map.size, bytes: this.#bytes, ...this.#stats };
  }

  async get(db: Queryable, contextVersion: string, ref: string): Promise<AnalysisContextSnapshot> {
    const hit = this.#map.get(contextVersion);
    if (hit) {
      this.#map.delete(contextVersion);
      this.#map.set(contextVersion, hit);
      this.#stats.hitsProcess += 1;
      return hit.snapshot;
    }

    // ── single-flight. 여기가 40 동시 티켓이 14 MB 를 40번 받던 자리다.
    const inflight = this.#inflight.get(contextVersion);
    if (inflight) {
      this.#stats.coalesced += 1;
      return inflight;
    }
    // ⚠️ `finally` 를 **등록 전에** 붙인다 — 그래야 map 에 들어가는 Promise 와 호출자가 받는
    //    Promise 가 같은 객체다. 성공분은 이미 `#map` 에 있으니(다음 호출은 1차 적중) 지워도 되고,
    //    실패분은 **반드시** 지워야 한다: 남기면 그 버전이 프로세스 수명 내내 같은 예외를 재생한다.
    //    settle → finally(삭제) → 대기자 resume 순서라, 깨어난 호출자가 죽은 항목을 볼 수 없다.
    const loading = this.#load(db, contextVersion, ref).finally(() => {
      this.#inflight.delete(contextVersion);
    });
    this.#inflight.set(contextVersion, loading);
    return loading;
  }

  async #load(db: Queryable, contextVersion: string, ref: string): Promise<AnalysisContextSnapshot> {
    if (this.opts.dbCacheEnabled) {
      const row = one(
        await db.query<{ payload: unknown; payload_bytes: string | number }>(
          `UPDATE analysis_contexts SET last_used_at = now(), use_count = use_count + 1
            WHERE context_version = $1
            RETURNING payload, payload_bytes`,
          [contextVersion],
        ),
      );
      if (row) {
        // ⚠️ `fromJsonb` — 이중 인코딩 기간에 적재된 2차 캐시 행은 jsonb **문자열 스칼라**라
        //    `parseSnapshot` 이 "is not an object" 로 던진다. 그 예외는 여기서 삼켜지지 않아
        //    티켓을 통째로 죽인다(`app/db.ts` jsonb 바인딩 규약).
        // ⚠️ 여기는 **봉투를 벗기지 않는다** — 2차 캐시 행은 `snapshot` 만 들고 있다(0004).
        //    이 경로에 `unwrapContextEnvelope` 를 붙이면 적재한 행을 전부 스스로 거부한다.
        const snapshot = parseSnapshot(contextVersion, fromJsonb(row.payload));
        this.#put(contextVersion, snapshot, Number(row.payload_bytes));
        this.#stats.hitsDb += 1;
        return snapshot;
      }
    }

    this.#stats.misses += 1;
    const log = this.opts.log ?? defaultLog;
    let body: unknown;
    const startedAt = Date.now();
    try {
      body = await this.#fetch(contextVersion, ref);
    } catch (e) {
      this.#stats.fetchErrors += 1;
      throw e;
    }
    const fetchMs = Date.now() - startedAt;

    // ── 200 을 받았다. 여기서부터 죽으면 **"fetch 는 됐다" 가 로그에 남아야 한다**(D-5 관측 공백).
    let payload: unknown;
    let snapshot: AnalysisContextSnapshot;
    let bytes: number;
    try {
      payload = unwrapContextEnvelope(contextVersion, body);
      snapshot = parseSnapshot(contextVersion, payload);
      // ⚠️ 바이트 기준은 **snapshot** 이다(봉투 아님). 2차 캐시에 넣는 것도 snapshot 이고
      //    2차 적중 경로는 그때 적은 `payload_bytes` 를 그대로 `#put` 에 넘기므로, 기준이
      //    갈리면 같은 버전이 경로에 따라 다른 크기로 계상돼 LRU 상한이 흔들린다.
      bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch (e) {
      this.#stats.invalid += 1;
      // ⚠️ **키 이름만** 남긴다 — 값은 워크스페이스 전체 카탈로그다(app/log.ts 머리말).
      log.warn("analysis_lane.context_invalid", {
        contextVersion,
        httpStatus: 200,
        topLevelKeys: topLevelKeys(body),
        bytes: safeByteLength(body),
        fetchMs,
        message: (e instanceof Error ? e.message : String(e)).slice(0, 512),
      });
      throw e;
    }
    // **버전당 1회**다(single-flight + 1차 LRU). 14 MB 급 전송이므로 크기·소요를 남기지 않으면
    // 타임아웃이 났을 때 "느린 코어"와 "큰 스냅샷"을 구분할 근거가 로그에 없다.
    // ⚠️ 스냅샷 내용은 절대 싣지 않는다(app/log.ts 머리말) — 크기와 소요만.
    log.info("analysis_lane.context_fetched", { contextVersion, bytes, fetchMs, timeoutMs: this.opts.fetchTimeoutMs });
    this.#put(contextVersion, snapshot, bytes);

    if (this.opts.dbCacheEnabled) {
      // 2차 캐시 적재는 **분석을 막지 않는다** — 실패해도 이번 티켓은 이미 스냅샷을 들고 있다.
      try {
        // ⚠️ 접두사가 uuid 가 아닐 수 있다(bare query_run = `unscoped:<hash>`, 코어
        //    `context-snapshot.ts:100`). 그대로 uuid 컬럼에 넣으면 INSERT 가 매번 죽고,
        //    그 실패는 아래 catch 가 삼켜 **조용한 적중률 0** 이 된다.
        const projectId = parseContextVersionProjectId(contextVersion);
        await db.query(
          `INSERT INTO analysis_contexts (context_version, project_id, payload, payload_bytes)
           VALUES ($1,$2,$3::jsonb,$4)
           ON CONFLICT (context_version) DO UPDATE SET last_used_at = now(), use_count = analysis_contexts.use_count + 1`,
          // ⚠️ payload 는 **객체 그대로**. `JSON.stringify` 하면 postgres.js 가 한 번 더
          //    직렬화해 jsonb 문자열 스칼라가 된다(`app/db.ts` jsonb 바인딩 규약).
          //    바로 위 `bytes` 의 `JSON.stringify` 는 **바이트 수 계산**이라 별개다.
          // ⚠️ 그리고 그 `payload` 는 **봉투가 아니라 snapshot** 이다 — 0004 주석이
          //    `{catalog, rels, grouping, trackedAugmentTargets}` 라고 못박은 그 모양이고,
          //    2차 적중 경로(`parseSnapshot` 직행)가 그것을 전제한다. `payload_bytes` 도 같은 기준.
          [contextVersion, projectId, payload, bytes],
        );
      } catch (e) {
        // 적재 실패는 적중률만 떨어뜨린다 — 안전한 실패 방향이다. **다만 조용하면 안 된다**:
        // 초판의 `catch {}` 는 uuid 캐스팅 실패 같은 상시 결함을 **적중률 0** 으로만 드러냈고,
        // 그 지문은 "왜 매번 코어에 가지?" 밖에 없었다(이 파일 위쪽 `parseContextVersionProjectId`
        // 주석이 그 사고다). 카운터 + warn 으로 표면화한다 — 분석은 계속 돈다.
        this.#stats.storeErrors += 1;
        (this.opts.log ?? defaultLog).warn("analysis_lane.context_cache_store_failed", {
          contextVersion,
          bytes,
          message: (e instanceof Error ? e.message : String(e)).slice(0, 512),
        });
      }
    }
    return snapshot;
  }

  /**
   * **상태 게이트.** 여기를 지나는 것은 200 본문뿐이다 — 상태별 판정(409 종결 / 그 외 전송
   * 실패)이 한 곳에 모여 있어야 `fetchImpl`(테스트·픽스처)과 실 소켓이 같은 규칙을 탄다.
   * 실제 헤더·본문 읽기는 `#httpFetch` 가 한다.
   */
  async #fetch(contextVersion: string, ref: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.opts.fetchTimeoutMs);
    const res = this.opts.fetchImpl ? await this.opts.fetchImpl(ref, signal) : await this.#httpFetch(ref, signal);

    // ── 409 = 코어가 **명시적으로** "그 버전은 이제 없다" 고 답한 것(route.ts:85~97).
    //    재시도는 같은 409 를 받는다 — attempt 를 태우지 말고 1회로 종결하고, 사유에
    //    `currentVersion` 을 실어 코어가 무엇으로 재발행하면 되는지 남긴다.
    if (res.status === 409) {
      const b = res.body !== null && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
      throw versionMismatchError(contextVersion, b.currentVersion, "core 409");
    }
    // ⚠️ 404 는 **재시도한다**(deferred/transient). 코어는 토큰 불일치·id 형식 오류를 전부 404
    //    로 숨기므로(route.ts:69~79) 이것은 대개 **설정 결함**인데, 설정 결함은 사람이 고치면
    //    같은 티켓이 성공하는 종류다. `permanent` 은 "재시도가 무의미"라는 뜻이고 그것을 달면
    //    코어가 재발행하지 않아 그 턴의 분석이 조용히 사라진다. 같은 방향의 선례가 이미 있다:
    //    같은 토큰을 쓰는 lane→코어 콜백도 404 를 배달 실패로 재시도한다(`internal-token.ts:55~58`).
    //    3회 소진 후의 `cap_exhausted` 는 계약상 "코어가 재발행하면 성공할 수 있다" 다 —
    //    이 상황에 정확히 맞는 신호다(contracts/v1.ts:82).
    if (res.status !== 200) throw new Error(`context fetch failed: http ${res.status}`);
    return res.body;
  }

  /**
   * ── ⚠️ `accept-encoding: gzip` 을 **명시한다.** 이 한 줄이 결함 1 의 1차 원인이었다.
   *
   * Node 내장 `fetch`(undici)는 `accept-encoding` 을 안 주면 자기 기본값을 싣는데 그 값이
   * **런타임 빌드마다 다르다** — 2026-09-13 실측: 라이브 런타임은 `gzip, deflate, br`,
   * 로컬 node v26.8.1 은 `gzip, deflate`. 코어 origin 은 `br` 이 있으면 brotli 로 압축하고,
   * 14.4 MB JSON 을 brotli 로 미는 데 **37.5초**가 걸린다(wire 2.6 MB). 같은 응답이
   * `gzip` 이면 **3.0초**(3.4 MB), `identity` 면 3.2초다. 즉 초판은 **단건 fetch 하나만으로
   * 20s 상한을 넘겼고**(워커 로그: `worker_start` → 20.5초 뒤 `turn_failed`), 40 동시 티켓의
   * 스탬피드는 그 위에 얹힌 증폭이었다. 동시 8건 gzip 이 각 3.5초인 것이 "코어 경합이
   * 아니다"의 근거다.
   *
   * 명시해도 **자동 압축 해제는 유지된다**(2026-09-13 실측: 루프백 gzip 서버에 명시 헤더로
   * 요청 → `res.json()` 정상). 즉 잃는 것이 없고, 얻는 것은 "wire 인코딩이 undici 버전에
   * 좌우되지 않는다" 는 결정성이다. 이 두 사실은 주장이 아니라 `tests/context-cache.test.ts`
   * 가 CI 런타임(node 20)에서 매번 재확인한다.
   *
   * ⚠️ br 을 다시 받고 싶으면 **코어 origin 의 brotli 품질을 먼저 낮춰라.** 여기서 헤더만
   *    되돌리면 같은 37.5초로 돌아간다.
   */
  async #httpFetch(ref: string, signal: AbortSignal): Promise<ContextFetchResult> {
    const res = await fetch(ref, {
      signal,
      headers: {
        accept: "application/json",
        "accept-encoding": CONTEXT_ACCEPT_ENCODING,
        ...internalAuthHeaders(this.opts.internalToken ?? null),
      },
    });
    // 본문은 **200·409 에서만** 읽는다. 404/503 본문은 쓰이지 않고(에러 페이지일 수 있다)
    // 14 MB 급 엔드포인트에서 쓸모없는 바디를 끝까지 당길 이유가 없다.
    // ⚠️ 다만 **명시적으로 버린다** — 읽지도 버리지도 않으면 undici 가 그 연결을 회수하지 못해
    //    지속 장애(전량 503 등)에서 소켓이 샌다.
    if (res.status !== 200 && res.status !== 409) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null };
    }
    // 200 인데 JSON 이 아니면 `null` 로 떨어뜨린다 — 봉투 검사가 `context_invalid` 로 잡는다
    // (여기서 던지면 "전송 실패"로 뭉개져 fetch 가 성공했다는 사실이 다시 사라진다).
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  #put(key: string, snapshot: AnalysisContextSnapshot, bytes: number): void {
    const prev = this.#map.get(key);
    if (prev) this.#bytes -= prev.bytes;
    this.#map.delete(key);
    this.#map.set(key, { snapshot, bytes });
    this.#bytes += bytes;
    this.#evict();
  }

  #evict(): void {
    while ((this.#map.size > this.opts.maxEntries || this.#bytes > this.opts.maxBytes) && this.#map.size > 1) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      const e = this.#map.get(oldest.value);
      this.#map.delete(oldest.value);
      if (e) this.#bytes -= e.bytes;
    }
  }
}

/**
 * 2차 캐시 LRU 절단. **용량 회수일 뿐 무효화가 아니다** — 지워도 다음 미스가 코어에서 다시
 * 가져온다(정확성이 아니라 적중률만 떨어진다 = 안전한 실패 방향).
 *
 * ⚠️ **초판은 호출자가 0 이었다**(D6). 즉 `analysis_contexts` 는 무효화도 TTL 도 절단도 없이
 *    자라기만 했다 — 행 하나가 스냅샷 **14.4 MB**(§14-1 실측)이므로 프로젝트·버전이 바뀔 때마다
 *    수십 GB 단위로 붙는다. 지금은 워커 주기 루프가 부른다(`worker/main.ts` maintenanceOnce).
 *
 * ⚠️ `maxDelete` 로 **한 번에 지우는 양을 막는다.** 방치돼 커진 테이블을 한 트랜잭션에서 통째로
 *    지우면 그 트랜잭션이 길어지고(WAL·잠금) 그동안 워커는 리스를 못 집는다 — 스윕 LIMIT(B7)과
 *    같은 이유다. 남은 것은 다음 주기가 가져간다.
 */
export async function trimContextTable(db: Queryable, keepRows: number, maxDelete = 100): Promise<number> {
  const rows = await db.query<{ context_version: string }>(
    `DELETE FROM analysis_contexts
      WHERE context_version IN (
        SELECT context_version FROM analysis_contexts
         ORDER BY last_used_at DESC OFFSET $1 LIMIT $2)
      RETURNING context_version`,
    [Math.max(0, Math.trunc(keepRows)), Math.max(1, Math.trunc(maxDelete))],
  );
  return rows.length;
}
