/**
 * scope_citations 인용 URL 정규화 컬럼 백필 (migration 0052).
 *
 *   npm run db:backfill:citation-norm -- --dry-run     # 읽기 전용 (모수 + EXPLAIN)
 *   npm run db:backfill:citation-norm                  # 실행
 *   npm run db:backfill:citation-norm -- --batch=50000 --sleep-ms=100
 *   npm run db:backfill:citation-norm -- --limit=100000  # 시범 구간만
 *
 * 무엇을 하는가: `url_norm IS NULL` 인 행에 대해서만
 *   url_norm      = citation_url_norm(url)
 *   url_host      = citation_url_host(url)
 *   url_base_norm = citation_url_base_norm(url)
 * 을 채운다. **원본 컬럼(url·domain·title·ref_index·category)은 읽기만 한다.**
 * 2026-07-21 Scope measured_at 오염 사고에서 이 미러가 원본 복구 소스였다 —
 * 미러 원본을 건드리는 순간 복구 수단이 사라진다. 그래서 백업이 필요 없다:
 * 세 컬럼은 url 에서 결정되는 파생값이고, 잘못되면 NULL 로 되돌려 다시 돌리면 된다.
 *
 * 대량 UPDATE 안전수칙(사내 운영 규칙):
 *   · 사전 행수 SELECT — 시작 전에 전체/미충전 행수를 찍고 확인 후 진행
 *   · fingerprint 한정 — WHERE url_norm IS NULL (이미 채운 행은 절대 다시 안 쓴다)
 *   · 재개 가능 — id 커서. 죽어도 같은 명령을 다시 돌리면 남은 것만 이어받는다
 *   · rowcount 단언 — 배치마다 실제 갱신 행수를 로그로 남기고 배치 크기 초과 시 중단
 *   · 부하 격리 — lock_timeout / statement_timeout 설정 + 배치 사이 sleep
 *
 * 락: 행 단위 UPDATE 라 테이블 락을 잡지 않는다. 미러 sync 는 run 단위로
 * DELETE+INSERT 하므로, 같은 행을 동시에 만지면 배치가 잠깐 기다렸다가
 * lock_timeout 에 걸려 그 배치만 실패한다 → 재실행이 이어받는다(멱등).
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL not set — .env.local 확인");
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name: string, dflt: number): number => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = Number(hit.split("=")[1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} 값이 잘못됐다: ${hit}`);
  return Math.floor(v);
};
const DRY_RUN = argv.includes("--dry-run");
const BATCH = flag("batch", 20_000);
const SLEEP_MS = flag("sleep-ms", 200);
const LIMIT = flag("limit", Number.MAX_SAFE_INTEGER);
// 배치 하나가 이 시간을 넘기면 끊는다 — 크론과 겹쳤을 때 무한 대기를 막는다.
const STATEMENT_TIMEOUT = "5min";
const LOCK_TIMEOUT = "5s";

const conn = postgres(DATABASE_URL, { prepare: false, connect_timeout: 15 });

/**
 * 배치 1개의 UPDATE. 정규화 사슬을 **행당 정확히 2회**(tracked 1 + base 1) 만
 * 평가한다 — url_host 를 `citation_url_host(url)` 로 쓰면 그 안에서
 * citation_url_norm 이 한 번 더 돈다(프로덕션 실측 tracked 사슬 = 20.7μs/행,
 * 294만행이면 그 한 번이 통째로 60초다). 서브쿼리에서 한 번 계산해 되쓴다.
 *
 * `url IS NOT NULL` 이 붙은 이유: url 이 NULL 인 행은 정규화 결과도 NULL 이라
 * 채워도 `url_norm IS NULL` 을 벗어나지 못한다 — 그대로 두면 "남은 미충전"이
 * 영원히 0 이 되지 않아 운영자가 무한히 재실행하게 된다(현재 프로덕션 실측
 * url NULL = 0 행이지만, 미러 스키마상 nullable 이다).
 *
 * `WHERE url_norm IS NULL` 이 fingerprint 이자 재개 키다. UPDATE 대상은
 * 서브쿼리가 고른 id 집합으로 한정되고, SET 은 새 컬럼 3개뿐이다 —
 * 원본 컬럼은 이 문장 어디에도 없다.
 */
function batchUpdateSql(cursorArg: number | string, limitArg: number | string): string {
  return `UPDATE scope_citations c
             SET url_norm = s.n,
                 url_host = split_part(s.n, '/', 1),
                 url_base_norm = s.b
            FROM (SELECT id,
                         citation_url_norm(url) AS n,
                         citation_url_base_norm(url) AS b
                    FROM scope_citations
                   WHERE id > ${cursorArg} AND url_norm IS NULL
                     AND url IS NOT NULL
                   ORDER BY id LIMIT ${limitArg}) s
           WHERE c.id = s.id
       RETURNING c.id`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString("en-US");

async function main() {
  // ── 전제 확인 ───────────────────────────────────────────────────────────
  const [cols] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_attribute
    WHERE attrelid = to_regclass('public.scope_citations')
      AND attname IN ('url_norm', 'url_host', 'url_base_norm')
      AND NOT attisdropped`;
  if ((cols?.n ?? 0) !== 3) {
    console.error(
      `✗ scope_citations 에 정규화 컬럼이 ${cols?.n ?? 0}/3 개만 있다 — 먼저 적용: npm run db:apply -- 0052`,
    );
    process.exit(1);
  }
  const [fns] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_proc
    WHERE proname IN ('citation_url_norm', 'citation_url_base_norm', 'citation_url_host')
      AND pronamespace = 'public'::regnamespace`;
  if ((fns?.n ?? 0) !== 3) {
    console.error(`✗ 정규화 SQL 함수가 ${fns?.n ?? 0}/3 개만 있다 — 0052 재적용 필요`);
    process.exit(1);
  }

  // ── 사전 행수 (대량 UPDATE 안전수칙) ────────────────────────────────────
  const t0 = Date.now();
  const [pre] = await conn<{ total: number; pending: number; max_id: number | null }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE url_norm IS NULL AND url IS NOT NULL)::int AS pending,
           max(id)::int AS max_id
    FROM scope_citations`;
  const total = pre?.total ?? 0;
  const pending = pre?.pending ?? 0;
  console.log(`모수: 전체 ${fmt(total)}행 · 미충전 ${fmt(pending)}행 · max(id)=${fmt(pre?.max_id ?? 0)}`);
  console.log(`   (사전 집계 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (pending === 0) {
    console.log("✅ 미충전 행 없음 — 할 일이 없다.");
    return;
  }

  if (DRY_RUN) {
    // 읽기 전용: 배치 1개의 플랜만 뜬다 (EXPLAIN, ANALYZE 아님 — 실행하지 않는다).
    const plan = await conn.unsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN ${batchUpdateSql(0, BATCH)}`,
    );
    console.log("\n[dry-run] 배치 1개 플랜 (EXPLAIN — 실행 없음):");
    for (const r of plan) console.log("  " + r["QUERY PLAN"]);
    const batches = Math.ceil(Math.min(pending, LIMIT) / BATCH);
    console.log(`\n[dry-run] 예상 배치 수: ${fmt(batches)} (batch=${fmt(BATCH)}, sleep=${SLEEP_MS}ms)`);
    console.log("[dry-run] 쓰기 없음. 실제 실행은 --dry-run 없이.");
    return;
  }

  await conn.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
  await conn.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);

  // ── 배치 루프 (id 커서 = 재개 키) ───────────────────────────────────────
  // 커서 아래는 이미 처리됐으므로 `id > cursor AND url_norm IS NULL` 은 PK
  // 인덱스로 즉시 다음 배치를 찾는다. 중단 후 같은 명령을 다시 돌리면
  // cursor=0 에서 시작해도 채워진 행을 건너뛰며 남은 것만 이어받는다.
  let cursor = 0;
  let done = 0;
  let batches = 0;
  const start = Date.now();
  for (;;) {
    if (done >= LIMIT) {
      console.log(`⏸ --limit=${fmt(LIMIT)} 도달 — 중단(재개 가능).`);
      break;
    }
    const size = Math.min(BATCH, LIMIT - done);
    let rows: { id: number }[];
    try {
      rows = await conn.unsafe<{ id: number }[]>(batchUpdateSql("$1", "$2"), [
        cursor,
        size,
      ]);
    } catch (e) {
      // lock_timeout / statement_timeout 등 — 이 배치만 버리고 재시도한다.
      console.error(`  ! 배치 실패(커서 ${fmt(cursor)}): ${e instanceof Error ? e.message : e}`);
      console.error("    5s 후 같은 커서로 재시도 (멱등 — 이미 채운 행은 건너뛴다)");
      await sleep(5_000);
      continue;
    }
    if (rows.length === 0) break;
    // rowcount 단언 — 한정 조건이 깨져 배치 밖 행이 갱신되는 일은 없어야 한다.
    if (rows.length > size) {
      throw new Error(`rowcount 이상: 요청 ${size} < 갱신 ${rows.length} — 중단`);
    }
    done += rows.length;
    batches += 1;
    cursor = rows.reduce((m, r) => (r.id > m ? r.id : m), cursor);
    const elapsed = (Date.now() - start) / 1000;
    const rate = done / Math.max(elapsed, 0.001);
    const remain = Math.max(Math.min(pending, LIMIT) - done, 0);
    const eta = rate > 0 ? remain / rate : 0;
    console.log(
      `  batch#${batches} +${fmt(rows.length)} (누적 ${fmt(done)}/${fmt(Math.min(pending, LIMIT))}` +
        ` · ${((100 * done) / Math.max(Math.min(pending, LIMIT), 1)).toFixed(1)}%` +
        ` · ${Math.round(rate)}행/s · ETA ${Math.round(eta)}s · cursor=${fmt(cursor)})`,
    );
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  const [post] = await conn<{ pending: number }[]>`
    SELECT count(*) FILTER (WHERE url_norm IS NULL AND url IS NOT NULL)::int AS pending
    FROM scope_citations`;
  console.log(
    `\n✅ 갱신 ${fmt(done)}행 / ${batches} 배치 · ${((Date.now() - start) / 1000).toFixed(1)}s` +
      ` · 남은 미충전 ${fmt(post?.pending ?? -1)}행`,
  );
  if ((post?.pending ?? 0) > 0) {
    console.log("   (0 이 아니면 sync 가 그 사이 넣은 신규 행이다 — 같은 명령을 한 번 더 돌린다)");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => conn.end());
