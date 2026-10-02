import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

// 컬럼 존재 여부 프로브 — "마이그레이션 선/후 배포" 양쪽에서 코드가 살아남게 한다.
//
// 이 리포는 마이그레이션을 제품 책임자가 손으로 적용하고(`npm run db:apply`), 코드는
// 머지 즉시 무인 배포된다. 즉 **배포가 적용보다 앞설 수 있고 그 반대도 된다.**
// 컬럼을 무조건 참조하면 앞선 쪽이 500 을 낸다.
//
// 판정은 **쓰기 전에 확정한다**(2026-09-10). 종전에는 동기 판정(`columnKnownAvailable`)
// 이 "미확인이면 폴백"으로 그냥 진행하고 백그라운드 프로브를 띄웠는데, 그 결과
// **프로세스의 첫 호출만 다른 술어**를 만들었다. 라이브 실측(글로벌 루트 무필터):
//   첫 호출  answers 36,308 · mentions 536,428  (regions 스코핑 절 통째 누락 +
//            한국어 판정이 `sp.text ~ '[가-힣]'` 폴백)
//   이후     answers 37,568 · mentions 566,485  (+3.5% / +5.6%)
// Vercel 콜드 람다마다 이 "첫 호출"이 생기고 그 값이 `mirrorCache`(unstable_cache,
// MIRROR_CACHE_TTL 7,200s = 2시간)에 굳어 고객 숫자가 콜드/웜에 따라 흔들렸다. 폴백은 **컬럼이 실제로 없을 때의
// 장애 회피**지 "아직 안 물어봤을 때의 기본값"이 아니다.
//
// 동기 판정을 읽는 곳(2026-09-10 전수):
//   · 미러 **읽기** — lib/db/repositories/scope-aggregates.ts (is_korean·regions·url_norm)
//   · 미러 **쓰기** — lib/db/repositories/scope-mirror.ts::citationValues (url_norm).
//     쓰기 쪽은 폴백이 "값이 같은 다른 식"이 아니라 **컬럼을 안 채우는 것**이라, 콜드
//     프로세스(= cron 첫 run)가 url_norm/url_host/url_base_norm 을 NULL 로 적재했다
//     (라이브 scope_citations 3,236,313 행 중 NULL 3,629 = 0.11%). 읽기는 coalesce 로
//     동치지만 폴백이 없는 소비자(qa-review 의 url_host 표시)는 그대로 빈칸이 된다.
//   · 사실표 읽기 — lib/summary/read/presence.ts (presence_set). 소비 리더는 이미
//     진입점마다 `await presenceSetColumnAvailable()` 을 한다(감사 결과 누락 0).
//   · 집계층 읽기 — lib/db/repositories/summary-trend-aggregates.ts (comp_rank_sum, 0069).
//     진입점이 하나뿐이라(`readTrendAggregates`) 거기서 `await ensureColumnAvailability()`
//     를 한다 — `buildTrendStatements` 는 동기라 그 앞에서 확정돼 있어야 한다.
//   · CLI — scripts/summary/global-predicates.ts. 러너 4개가 시작할 때 `columnAvailable`
//     을 await 하므로 무해하지만, **앱 밖에도 동기 소비자가 있다**는 사실은 남긴다.
//
// 그래서 계약이 둘이다:
//   ① 동기 판정을 읽는 SQL 빌더의 호출부는 **먼저 `ensureColumnAvailability()` 를
//      await 한다**(사실표 리더가 이미 쓰던 자세 — summary-*-aggregates.ts 의
//      `await presenceSetColumnAvailable()`). 진입점 계약은 소스 대조 테스트가 지킨다
//      (scope-aggregates.column-availability.test.ts).
//   ② 동기 API 가 읽을 수 있는 (테이블, 컬럼)은 아래 `SYNC_PROBED_COLUMNS` 에만 있다.
//      타입이 그 쌍만 받으므로 **등록하지 않은 컬럼은 컴파일되지 않는다** — 새 동기
//      소비자가 ensure 의 사각지대로 새로 생기는 경로를 막는다.
//
// 검토하고 기각한 대안(2026-09-10):
//   · **부팅 훅**(`instrumentation.ts::register`)에서 미리 프로브 — 빌드가 깨진다.
//     middleware 가 있어 instrumentation 은 edge 런타임용으로도 번들되는데, 이 모듈이
//     `postgres` 드라이버를 끌고 들어가 `Module not found: perf_hooks` 로 `next build`
//     가 실패했다(실측. `process.env.NEXT_RUNTIME` 가드로 감싼 동적 import 도 동일).
//     얻는 것은 콜드 스타트 왕복 1회 선점뿐이라 위험이 값보다 크다.
//   · **빌드 상수로 굳히기**(런타임 프로브 제거) — 판정 흔들림은 사라지지만 "적용 전
//     배포"에서 42703 장애가 그대로 돌아온다. 0046·0052 때 이 내성을 만든 이유가 그것이라,
//     적용 순서 규율(db:apply → 배포)에 장애 회피를 의존시키지 않는다.
//
// 2026-08-30(H3)에 scope_prompts 의 is_korean·regions 용으로 컬럼명 일반화가
// 있었고, 2026-09-03(0052) 에 scope_citations.url_norm 이 같은 내성을 필요로
// 하면서 **테이블까지 일반화**해 이 모듈로 뽑았다. 프로브 로직이 두 벌로
// 갈라지면 한쪽만 고치는 결함이 생긴다 — 이 리포가 이미 겪은 형태다. 그래서
// 프로브 쿼리 형태도 한 벌(컬럼당 1회)로 유지하고, `ensureColumnAvailability` 는
// 그 한 벌을 여러 키에 대해 부를 뿐이다.

/**
 * **동기** 판정(`columnKnownAvailable`)이 읽는 전체 목록 = `ensureColumnAvailability`
 * 가 확정하는 전체 목록. 비동기 판정(`columnAvailable`)은 호출부가 이미 await 하므로
 * 여기 없어도 된다 — 콜드 스타트에 프로브를 늘리지 않으려고 일부러 좁게 유지한다.
 */
export const SYNC_PROBED_COLUMNS = [
  ["scope_prompts", "is_korean"], // 0046 — 한국어 프롬프트 판정 (미러 표준 경로)
  ["scope_prompts", "regions"], // 0048 — 프롬프트-지역 스코핑 (미러 표준 경로)
  ["scope_citations", "url_norm"], // 0052 — 인용 URL 정규화 (미러 인용 경로)
  ["summary_answers", "presence_set"], // 0061 — 사실표 brandPresence (요약 리더)
  // 0069 — 집계층 브랜드 표의 **답변 안 경쟁 순위**(S1 경쟁사 행 avgPosition).
  // 짝인 `comp_ranked_answers` 는 같은 ALTER 로 함께 붙으므로 하나만 묻는다
  // (0069 블록 ① — 두 컬럼이 한 tx 다. 프로브 왕복을 늘리지 않는다).
  ["summary_trend_brands", "comp_rank_sum"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

type SyncProbedColumn = (typeof SYNC_PROBED_COLUMNS)[number];

const state = new Map<string, { value: boolean; expiresAt: number }>();
const inflight = new Map<string, Promise<boolean>>();
const warnedUnresolved = new Set<string>();
/** 진행 중인 배치 프로브(`ensureColumnAvailability`) — 동시 호출의 중복 발사를 막는다. */
let inflightBatch: Promise<void> | null = null;
/** 컬럼 **부재**가 확정된 뒤 재확인 주기 — 재배포 없이 db:apply 를 따라잡는 값. */
const PROBE_RETRY_MS = 60_000;
/**
 * 프로브 **자체가 실패**했을 때의 재시도 주기. 부재 확정과 같은 값을 쓰면 일시적
 * 실패 하나가 폴백 술어를 60초 동안 굳혀 캐시까지 오염시킨다 — 판정 불가는 판정이
 * 아니므로 짧게 잡고 다음 요청이 다시 묻게 한다.
 */
const PROBE_ERROR_RETRY_MS = 2_000;

const keyOf = (table: string, column: string) => `${table}.${column}`;

/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export function resetColumnAvailabilityForTests(): void {
  state.clear();
  inflight.clear();
  warnedUnresolved.clear();
  inflightBatch = null;
}

/** 테스트 전용 — DB 없이 판정값을 고정한다(컬럼 있는 경로의 SQL 형태 검증용). */
export function setColumnAvailabilityForTests(
  table: string,
  column: string,
  value: boolean,
): void {
  state.set(keyOf(table, column), {
    value,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * 여러 (테이블, 컬럼)을 **한 왕복**으로 묻는다. 낱개 프로브(`runColumnProbe`)와 같은
 * 술어(`pg_attribute` + `to_regclass`)를 쓰되 VALUES 목록으로 펼칠 뿐이다 — 판정 규칙이
 * 두 벌로 갈라지지 않게. 테이블이 없으면 `to_regclass` 가 NULL 이라 조인이 안 붙고
 * 그 키는 부재로 확정된다(낱개와 동일).
 */
async function runBatchProbe(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const now = Date.now();
  try {
    for (const [table] of pairs) {
      // 낱개 프로브와 같은 자세 — 값은 코드 상수뿐이지만 식별자 형태를 먼저 검사한다.
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table: ${table}`);
    }
    const values = sql.join(
      pairs.map(([table, column]) => sql`(${table}::text, ${column}::text)`),
      sql`, `,
    );
    const rows = (await getDb().execute(sql`
      SELECT c.tbl AS tbl, c.col AS col
      FROM (VALUES ${values}) AS c(tbl, col)
      JOIN pg_attribute a
        ON a.attrelid = to_regclass('public.' || c.tbl)
       AND a.attname::text = c.col
       AND NOT a.attisdropped
    `)) as unknown as Array<{ tbl: string; col: string }>;
    const present = new Set(rows.map((r) => keyOf(r.tbl, r.col)));
    for (const [table, column] of pairs) {
      const key = keyOf(table, column);
      state.set(key, { value: present.has(key), expiresAt: now + PROBE_RETRY_MS });
    }
  } catch {
    // 낱개 경로와 같은 규칙 — 판정 불가는 짧게만 기억한다(위 상수 주석).
    for (const [table, column] of pairs) {
      state.set(keyOf(table, column), {
        value: false,
        expiresAt: now + PROBE_ERROR_RETRY_MS,
      });
    }
  }
}

/**
 * 테스트 전용 — 동기 판정 **전체**를 확정 상태로 만든다(= 프로브가 이미 끝난 웜 프로세스).
 * 개별 `setColumnAvailabilityForTests` 를 나열하는 대신 이걸 쓰면, 나중에
 * `SYNC_PROBED_COLUMNS` 에 키가 늘어도 테스트가 다시 깨지지 않는다.
 */
export function resolveColumnAvailabilityForTests(value = true): void {
  for (const [table, column] of SYNC_PROBED_COLUMNS) {
    setColumnAvailabilityForTests(table, column, value);
  }
}

async function runColumnProbe(table: string, column: string): Promise<boolean> {
  const key = keyOf(table, column);
  const now = Date.now();
  try {
    // 테이블명은 바인드가 아니라 리터럴로 넣는다 — 이 프로브의 **바인드 파라미터는
    // 컬럼명 하나뿐**이어야 한다(형태 계약: korean/region-tag 술어 테스트가 프로브
    // 쿼리의 문자열 파라미터로 어느 컬럼을 묻는지 식별한다). 값은 코드 상수뿐이지만
    // 주입을 원천 차단하려고 식별자 형태를 먼저 검사한다.
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table: ${table}`);
    const rows = (await getDb().execute(sql`
      SELECT 1 AS ok FROM pg_attribute
      WHERE attrelid = to_regclass(${sql.raw(`'public.${table}'`)})
        AND attname = ${column} AND NOT attisdropped
    `)) as unknown as Array<unknown>;
    const present = rows.length > 0;
    state.set(key, { value: present, expiresAt: now + PROBE_RETRY_MS });
    return present;
  } catch {
    // 판정 불가 → 안전한 쪽(컬럼 미사용)으로 두되 **짧게**만 기억한다(위 상수 주석).
    state.set(key, { value: false, expiresAt: now + PROBE_ERROR_RETRY_MS });
    return false;
  } finally {
    inflight.delete(key);
  }
}

/**
 * SQL 빌더(동기)가 읽는 판정값. **호출 전에 `ensureColumnAvailability()` 가 await 돼
 * 있어야 한다** — 그때는 이 함수가 확정값을 그대로 돌려준다.
 *
 * 미확정 상태로 불리면 종전처럼 폴백(false)을 내고 백그라운드 프로브를 띄우지만,
 * 그건 **결함 신호**다(첫 호출만 다른 술어 = 다른 숫자). 그래서 키마다 한 번 경고를
 * 남긴다 — 등록되지 않은 새 진입점이 생기면 로그에 이름이 찍힌다.
 */
export function columnKnownAvailable(...[table, column]: SyncProbedColumn): boolean {
  const key = keyOf(table, column);
  const now = Date.now();
  const cached = state.get(key);
  if (cached?.value === true) return true;
  const stale = !cached || cached.expiresAt <= now;
  if (stale && !warnedUnresolved.has(key)) {
    warnedUnresolved.add(key);
    console.warn(
      `[column-availability] ${key}: 판정 전에 동기 SQL 빌더가 호출됐다 — 이번 호출만 ` +
        `폴백 술어로 나간다. 그 진입점에 \`await ensureColumnAvailability()\` 를 추가하라.`,
    );
  }
  if (stale && !inflight.has(key)) {
    const probe = runColumnProbe(table, column);
    inflight.set(key, probe);
    // 플로팅 프로미스 방지 — 실패해도 요청에 영향 없다.
    void probe.catch(() => undefined);
  }
  return false;
}

/**
 * 동기 판정 전부를 **확정**한다. SQL 을 만들기 전에 한 번 await 하면 그 프로세스의
 * 첫 호출도 이후 호출과 같은 술어를 낸다(이 모듈 머리 주석의 계약 ①).
 *
 * · 확정된 true 는 영구 캐시라 두 번째 호출부터 쿼리가 없다(이미 resolved 된 프로미스 하나).
 * · 부재·실패는 TTL 이 지나면 다시 묻는다 — 재배포 없이 db:apply 를 따라잡는 성질 유지.
 * · 절대 throw 하지 않는다 — 프로브 실패가 화면 장애가 되지는 않게(대신 폴백이 굳지
 *   않도록 위 `PROBE_ERROR_RETRY_MS` 로 짧게 잊는다).
 * · **한 문장으로 묶어 묻는다.** 키마다 따로 물으면 왕복이 4회이고, 병렬로 묶으면
 *   이번엔 콜드 풀에 커넥션이 4개 동시에 열린다. 실측(2026-09-10, 랩톱→Supavisor,
 *   커넥션 웜업 후 3회 반복): **배치 274/355/274 ms** · 낱개 4회 병렬 1,171→275→287 ms
 *   (첫 회가 느린 것이 커넥션 3개 추가 수립분) · 낱개 4회 순차 1,060/1,193/1,164 ms.
 *   즉 콜드에서 4.3배다. 이 리포는 풀러 CONNECT_TIMEOUT 이력이 있어(lib/db/index.ts
 *   주석) 콜드에 커넥션을 더 여는 것 자체가 위험이기도 하다. 판정 **로직**은 여전히
 *   한 벌이다(같은 pg_attribute 술어 — 묶음이냐 낱개냐만 다르다).
 * · 동시에 여러 진입점이 불러도 발사는 1회다(`inflightBatch`).
 */
export async function ensureColumnAvailability(): Promise<void> {
  const now = Date.now();
  const pending = SYNC_PROBED_COLUMNS.filter(([table, column]) => {
    const cached = state.get(keyOf(table, column));
    // true 는 영구(컬럼은 사라지지 않는다) — 나머지는 만료됐을 때만 다시 묻는다.
    return !cached || (cached.value !== true && cached.expiresAt <= now);
  });
  if (pending.length === 0) return;

  // 동기 경로가 이미 쏜 낱개 프로브가 있으면 그것을 기다린다(중복 발사 금지).
  const waits: Array<Promise<unknown>> = [];
  const toProbe: Array<readonly [string, string]> = [];
  for (const [table, column] of pending) {
    const existing = inflight.get(keyOf(table, column));
    if (existing) waits.push(existing);
    else toProbe.push([table, column]);
  }
  if (toProbe.length > 0) {
    // 이미 도는 배치가 있으면 거기에 합류한다 — 그 배치가 이 키를 안 물었더라도
    // 다음 호출이 다시 채운다(판정은 언제나 재시도 가능한 상태로만 남는다).
    inflightBatch ??= runBatchProbe(toProbe).finally(() => {
      inflightBatch = null;
    });
    waits.push(inflightBatch);
  }
  await Promise.all(waits);
}

/**
 * 같은 판정의 **await 가능한** 형태. 호출부가 이미 async 이면 이쪽을 쓴다 —
 * 동기 판정은 첫 호출이 무조건 false 라서, **드물게 도는 경로**(런당 1회인 미러
 * 재싱크 같은)에서는 "첫 번째가 항상 폴백"이 곧 결손이 된다. 캐시·inflight 는
 * 동기 경로와 공유하므로 프로세스당 프로브는 그대로 1회다.
 */
export async function columnAvailable(table: string, column: string): Promise<boolean> {
  const key = keyOf(table, column);
  const cached = state.get(key);
  if (cached?.value === true) return true;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = inflight.get(key);
  if (existing) return existing;
  const probe = runColumnProbe(table, column);
  inflight.set(key, probe);
  return probe;
}

/**
 * 0053 의 회차 앵커 레지스트리를 쓸 수 있는가. 테이블·인덱스·`scope_anchor_fold()`
 * 함수가 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다(0052 와 동일 자세).
 * 테이블이 아예 없으면 `to_regclass` 가 NULL 이라 프로브는 false 를 돌려준다.
 */
export function anchorRegistryAvailable(): Promise<boolean> {
  return columnAvailable("scope_answer_anchors", "anchor");
}

/**
 * 0077 의 **답변 단위 회차 앵커 전수 테이블**을 쓸 수 있는가. 테이블·인덱스와
 * `refresh_answer_cycle_anchors()`·`hmg_anchor_*()` 함수가 한 마이그레이션에서 함께
 * 생기므로 대표 컬럼 하나만 본다(0052~0054 와 같은 자세).
 *
 * 없으면:
 *   · 쓰기 — 미러 싱크가 앵커 행을 **만들지 않는다**(0 건 통과, 에러 아님). 적용 후
 *     백필(`npm run db:backfill:answer-anchors -- --apply`)이 그 창을 회수한다.
 *   · 읽기 — `listSelectableAnchorDates` 가 **빈 목록**을 돌려준다. 달력은 종전대로
 *     동작해야 하며(비활성 날짜 없음), 조용히 다른 시계로 대체하지 않는다
 *     (`answerStancesAvailable` 주석이 경계하는 "조용한 회귀"와 같은 규율).
 */
export function answerCycleAnchorsAvailable(): Promise<boolean> {
  // ⚠️ **가장 최근 판에만 있는 컬럼**을 본다(N-15). 종전에는 `anchor_date` 를 봤는데,
  // 그 컬럼은 0077 의 **모든 판**에 있어서 이전 판 테이블이 적용된 DB 를 그대로
  // 통과시켰다. 테이블 DDL 은 `to_regclass` 가드 안이라 재적용으로 컬럼이 늘지
  // 않으므로, 그 DB 에서 `refresh_answer_cycle_anchors` 는 42703 으로 죽고 **그 run 의
  // 미러 싱크가 통째로 롤백**된다.
  //
  // `round_date`(정규 요일 귀속)가 이번 판에서 처음 생긴 NOT NULL 컬럼이다 —
  // 판이 올라가면 이 이름도 함께 올린다(`measured_at_orig` 에서 옮겨 왔다).
  return columnAvailable("scope_answer_cycle_anchors", "round_date");
}

/**
 * 0054 의 답변 드롭 레지스트리를 쓸 수 있는가. 테이블과 `scope_answer_drop_apply()`
 * 함수가 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다(0053 과 동일 자세).
 */
export function dropRegistryAvailable(): Promise<boolean> {
  return columnAvailable("scope_answer_drops", "reason");
}

/**
 * 0052 의 인용 URL 정규화 컬럼이 쓸 수 있는가. 세 컬럼과 세 SQL 함수는 같은
 * 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다 — 부분 적용된 상태는
 * 이 리포의 적용 경로(파일 = 한 트랜잭션)에서 만들어질 수 없다.
 */
export function citationNormColumnsAvailable(): boolean {
  return columnKnownAvailable("scope_citations", "url_norm");
}

/**
 * 0070 의 **회차 원장 숨김**(`summary_cycles.hidden_reason` / `hidden_at`)을 쓸 수 있는가.
 * 두 컬럼과 CHECK 제약이 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다
 * (0052~0054 와 같은 자세). 이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이
 * 따로 적용하므로 **코드가 컬럼 없는 DB 에 먼저 갈 수 있다**(그 반대도).
 *
 * 없으면 숨김은 **아무 일도 하지 않는다** — 리더 술어에서 절이 빠지고, 회차 픽은
 * 종전 술어 그대로이며, 갭 슬롯 목록은 빈 배열이다. 즉 0070 적용 전 배포는 현행
 * 화면과 **바이트 동일**하다(그 성질을 테스트가 고정한다).
 */
export function hiddenCycleColumnsAvailable(): Promise<boolean> {
  return columnAvailable("summary_cycles", "hidden_reason");
}

/**
 * 0071 의 **숨김 범위**(`summary_cycles.hidden_scope`)를 쓸 수 있는가.
 *
 * ⚠️ 0070 프로브(`hiddenCycleColumnsAvailable`)에 컬럼을 **더하지 않는다.** 더하면
 * "0070 은 적용됐는데 0071 은 아직" 인 배포에서 숨김 기능 자체가 통째로 꺼져
 * 8/24 골짜기가 화면에 돌아온다(= 0070 이전 상태로의 조용한 회귀). 두 마이그레이션은
 * 따로 적용되므로 프로브도 따로 둔다.
 *
 * 교차 배포 4상태 — 전부 안전해야 한다:
 *   0070 ✗ / 0071 ✗ → 숨김 없음(0070 이전 화면)
 *   0070 ✓ / 0071 ✗ → **회차 전체 숨김**(0071 이전 화면) ← 이 프로브가 false
 *   0070 ✓ / 0071 ✓ + 구 코드 → hidden_scope 무시 = 회차 전체 숨김
 *   0070 ✓ / 0071 ✓ + 신 코드 → 계열 분리(인용만 숨김)
 */
export function hiddenCycleScopeAvailable(): Promise<boolean> {
  return columnAvailable("summary_cycles", "hidden_scope");
}

/**
 * 0061 의 발생 단위 언급 미러(scope_mention_occurrences)를 쓸 수 있는가. 머지 = 배포라
 * 테이블보다 코드가 먼저 갈 수 있다 — 없으면 답변 모달은 밑줄 없이 종전대로 그린다.
 */
export function mentionOccurrencesAvailable(): Promise<boolean> {
  return columnAvailable("scope_mention_occurrences", "sentiment");
}

/**
 * 0072 의 **답변 단위 브랜드 스탠스 미러**(scope_answer_stances)를 쓸 수 있는가.
 * 0061 프로브(`mentionOccurrencesAvailable`)와 같은 자세 — 머지 = 무인 배포라 코드가
 * 테이블보다 먼저 갈 수 있다.
 *
 * 없으면:
 *   · 쓰기 — 미러 싱크가 스탠스를 **삭제도 삽입도 하지 않는다**(0 건 통과, 에러 아님).
 *   · 읽기 — 답변 모달은 스탠스 태그 없이 종전대로, 우호도 탭은 스탠스 카드가
 *     "측정 대기" 문구로 떨어진다. **발생 감성으로 조용히 대체하지 않는다**
 *     (위 `hiddenCycleScopeAvailable` 주석이 경계하는 "조용한 회귀"와 같은 규율).
 */
export function answerStancesAvailable(): Promise<boolean> {
  return columnAvailable("scope_answer_stances", "stance");
}

/**
 * 0082 의 **증분 읽기 워터마크**(scope_sync_watermarks)를 쓸 수 있는가. 0061·0072 프로브와
 * 같은 자세 — 코드가 표보다 먼저 배포될 수 있다.
 *
 * 없으면 미러 싱크는 **종전 전량 읽기**로 돌고 워터마크를 읽지도 쓰지도 않는다
 * (lib/scope/mirror/sync.ts 의 loadSyncWatermarks → null). 즉 0082 적용 전 배포는
 * 종전 크론과 동작이 같다.
 */
export function syncWatermarksAvailable(): Promise<boolean> {
  return columnAvailable("scope_sync_watermarks", "runs_floor_snapshot_at");
}
