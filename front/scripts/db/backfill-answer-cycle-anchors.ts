/**
 * 답변 단위 회차 앵커 전수 테이블 백필 (migration 0077).
 *
 *   npm run db:backfill:answer-anchors                     # **dry-run (기본)** — 쓰기 0
 *   npm run db:backfill:answer-anchors -- --apply          # 실제 백필
 *   npm run db:backfill:answer-anchors -- --apply --answers=5000 --runs=100 --sleep-ms=300
 *   npm run db:backfill:answer-anchors -- --apply --recompute   # 전수 재계산(R1 뒤집기)
 *   npm run db:backfill:answer-anchors -- --apply --limit=20    # 시범 구간(회차 20개)만
 *   npm run db:backfill:answer-anchors -- --apply --no-reassign  # 전수 재배정 생략
 *
 * ── 작업 단위는 run 이 아니라 **회차**다 (B-1) ──────────────────────────────
 * `refresh_answer_cycle_anchors` 가 받은 run 을 회차 전체로 넓혀 쓸 수 있기 때문에,
 * 배치가 회차를 자르면 rowcount 상한이 거짓으로 터진다. (0078 부터 확장은 회차 해소
 * 결과가 달라졌을 때만 일어나지만, 백필은 **첫 계산**이라 사실상 매번 넓어진다 —
 * 회차를 자르지 않는 규칙은 그대로 필요하다.) 구성 규칙·근거는
 * `answer-cycle-anchors-batching.ts` 에 있다(그 모듈이 테스트 대상이다).
 *   · 배치 상한 = 누적 **답변 수**(`--answers`, 기본 20,000) + 보조로 run 수(`--runs`, 기본 200)
 *   · 회차 하나가 상한보다 커도 **쪼개지 않는다** — 자기 배치를 혼자 쓴다
 *   · `--limit` 은 이제 **회차 수** 상한이다(부분 실행 = 재개 가능, 아래 A-2)
 *
 * ── 기본이 dry-run 인 이유 ───────────────────────────────────────────────────
 * 프리뷰와 프로덕션이 **같은 미러 DB** 를 본다. 적용·백필은 제품 책임자 승인 뒤다
 * (스펙 §6-4). 그래서 플래그가 없으면 이 스크립트는 읽기 전용 트랜잭션 안에서
 * `scripts/db/answer-cycle-anchors-dryrun.sql` 만 실행한다 — 예상 행 수·출처별
 * 분포·NULL 수를 내고 끝난다.
 *
 * ── 무엇을 쓰는가 ───────────────────────────────────────────────────────────
 * `scope_answer_cycle_anchors` 와 회차 귀속 매핑 표 `scope_cycle_rounds` 둘이다.
 * 산술·우선순위·귀속 규칙은 DB 함수(`refresh_answer_cycle_anchors` ·
 * `hmg_assign_cycle_rounds` · `hmg_propagate_cycle_rounds`)가 쥔다 — 이 스크립트는
 * run 목록을 나눠 그 함수를 부를 뿐 SQL 을 한 벌 더 갖지 않는다(정의가 두 벌이 되면
 * 미러 싱크가 만드는 행과 백필이 만드는 행이 갈린다).
 *
 * **원본은 한 컬럼도 건드리지 않는다.** 2026-07-21 Scope measured_at 오염 사고에서
 * 이 미러가 원본 복구 소스였다 — 미러를 오염시키면 복구 수단이 사라진다.
 * 0053 과 달리 이 경로는 `scope_answers.measured_at` 을 **접지 않는다**.
 *
 * ── 대량 쓰기 안전수칙(사내 운영 규칙) ─────────────────────────────────────
 *   · 사전 행수 SELECT — 시작 전 전체/미충전 run·답변 수를 찍는다
 *   · fingerprint 한정 — 미충전 job 이 있는 run 만 처리(재개 = 같은 명령 재실행)
 *   · 재개는 **DB 재조회** — 스냅샷 파일이 아니다(중단 시점을 몰라도 잔여만 이어받는다)
 *   · rowcount 단언 — 배치마다 함수 반환 행수가 기대치와 **같은지** 본다(상·하한 양쪽)
 *   · 부하 격리 — 배치마다 새 트랜잭션 + SET LOCAL 타임아웃 + 배치 사이 sleep
 *
 * ── Supavisor ───────────────────────────────────────────────────────────────
 * 풀러가 startup 파라미터(postgres.js `connection` 옵션)를 **버린다**. 그래서
 * 읽기 전용·타임아웃은 접속 뒤 `SET` / `SET LOCAL` 로 걸고, 쓰기 트랜잭션은
 * 앞선 세션에서 새어 들어올 수 있는 read-only GUC 를 `SET TRANSACTION READ WRITE`
 * 로 명시적으로 덮는다(2026-09-14 실증).
 */
import fs from "node:fs";
import postgres from "postgres";
import { mirrorCacheRevalidateNotice } from "./mirror-cache-notice";
import { anchorRootProjectIdOrThrow } from "@/lib/scope/anchor-root";
import {
  DRYRUN_SQL_PATH,
  splitDryRunStatements,
} from "./answer-cycle-anchors-dryrun-split";
import {
  type BatchPlan,
  type CycleRow,
  WORKLIST_SQL,
  planBatches,
} from "./answer-cycle-anchors-batching";

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
/** 기본은 **읽기 전용**. `--apply` 가 있어야 쓴다. */
const APPLY = argv.includes("--apply");
/** 이미 채워진 run 까지 다시 계산한다(R1 타임존 뒤집기 등). */
const RECOMPUTE = argv.includes("--recompute");
/** 배치 누적 **답변 수** 상한 — 배치 크기를 정하는 1차 축이다. */
const ANSWERS_PER_BATCH = flag("answers", 20_000);
/** 배치 run 수 상한(보조) — uuid 배열 파라미터가 무한정 커지지 않게. */
const RUNS_PER_BATCH = flag("runs", 200);
const SLEEP_MS = flag("sleep-ms", 200);
/** 이번 실행에서 처리할 **회차** 수 상한. 넘으면 부분 실행(재개 가능)이다. */
const LIMIT_CYCLES = flag("limit", Number.MAX_SAFE_INTEGER);
const STATEMENT_TIMEOUT = "10min";
const LOCK_TIMEOUT = "5s";
/** 같은 배치가 이만큼 연달아 실패하면 중단한다 — 무한 재시도 루프 방지. */
const MAX_BATCH_RETRIES = 5;
/**
 * 마지막 **전수 재배정 패스**를 건너뛴다.
 *
 * 왜 그 패스가 필요한가: 정규 요일 귀속은 "정규 요일 회차를 먼저 전부 앉힌 뒤 비정규를
 * anchor_date 이른 순으로" 배정한다. 백필은 run 을 배치로 나눠 돌기 때문에 그 2단계를
 * 배치 경계 너머로 지킬 수 없다 — 비정규 회차가 먼저 자리를 잡고 나중에 온 정규 요일
 * 회차와 합쳐지는, 순서만 달랐으면 안 생겼을 자리가 만들어진다. 그래서 배치가 끝난 뒤
 * 대상 프로젝트의 배정을 **지우고 한 번에 다시** 앉힌다.
 *
 * 이 패스는 **첫 백필**(매핑 표가 비어 있었다) 또는 `--recompute` 일 때만 돈다.
 * 그 밖에는 과거 배정을 흔들지 않는다는 규율이 우선이라 돌지 않는다 — 필요하면
 * 운영자 경로(`npm run db:reassign:cycle-rounds`)를 명시적으로 부른다.
 *
 * **`--limit` 으로 부분 실행하면 이 패스는 돌지 않는다**(A-2). 처리하지 못한 회차가
 * 남은 상태에서 도는 "전수" 패스는 전수가 아니라서, 다음 실행이 들여오는 회차와
 * 합쳐지면 결국 증분 배정과 같은 순서 artifact 를 남긴다. 그래서 부분 실행은
 * 그 사실을 시작·끝·검증 세 곳에 찍고 패스를 건너뛴다 — 완주 뒤 운영자 재배정으로
 * 한 번에 회복한다.
 */
const NO_REASSIGN = argv.includes("--no-reassign");

/**
 * 표면 판정의 'standard' 근거 — 해소 정본은 `lib/scope/anchor-root.ts` 한 곳이다(N-4).
 * 미러 싱크·생성기·이 스크립트가 같은 값을 봐야 같은 run 의 표면이 갈리지 않는다.
 */
const ROOT_PROJECT_ID = anchorRootProjectIdOrThrow();

const conn = postgres(DATABASE_URL, { prepare: false, connect_timeout: 15 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");

/** 작업 단위는 회차다 — 정의·구성 규칙은 `answer-cycle-anchors-batching.ts`. */

/** 0077 적용 여부 — 테이블 2개 + 함수 15개가 한 파일에서 함께 생긴다. */
async function assertMigrationApplied(): Promise<void> {
  const [t] = await conn<{ present: boolean }[]>`
    SELECT to_regclass('public.scope_answer_cycle_anchors') IS NOT NULL AS present`;
  if (!t?.present) {
    throw new Error("scope_answer_cycle_anchors 가 없다 — 먼저 적용: npm run db:apply -- 0077");
  }
  const [rt] = await conn<{ present: boolean }[]>`
    SELECT to_regclass('public.scope_cycle_rounds') IS NOT NULL AS present`;
  if (!rt?.present) {
    throw new Error("scope_cycle_rounds(귀속 매핑 표)가 없다 — 0077 을 최신본으로 재적용할 것");
  }
  const [f] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('hmg_anchor_timezone', 'hmg_anchor_date', 'hmg_anchor_today',
                       'hmg_anchor_utc_midnight', 'hmg_anchor_week', 'hmg_anchor_month',
                       'hmg_anchor_default_engines',
                       'hmg_anchor_is_pinned', 'hmg_anchor_keep_existing', 'hmg_anchor_view_date',
                       'hmg_round_canonical_dow', 'hmg_round_prev_canonical',
                       'hmg_round_next_canonical', 'hmg_round_date_of',
                       'hmg_assign_cycle_rounds', 'hmg_propagate_cycle_rounds',
                       'refresh_answer_cycle_anchors')`;
  if ((f?.n ?? 0) !== 17) {
    throw new Error(`0077 의 SQL 함수가 ${f?.n ?? 0}/17 개만 있다 — 0077 재적용 필요`);
  }
  // 시그니처까지 본다 — B4 수리로 인자가 둘이 됐다. 옛 1인자 함수만 있는 DB 에서
  // 아래 호출은 42883 으로 죽는데, 그 실패가 배치 재시도 루프로 위장되면 안 된다.
  const [sig] = await conn<{ ok: boolean }[]>`
    SELECT to_regprocedure('public.refresh_answer_cycle_anchors(uuid[], uuid)') IS NOT NULL AS ok`;
  if (!sig?.ok) {
    throw new Error(
      "refresh_answer_cycle_anchors(uuid[], uuid) 가 없다 — 0077 을 최신본으로 재적용할 것",
    );
  }
  // ── N-15: **테이블**도 최신판인지 본다 ──────────────────────────────────────
  // 함수는 `CREATE OR REPLACE` 라 재적용으로 갱신되지만 **테이블은 아니다**
  // (DDL 이 `to_regclass` 가드 안에 있다). 이전 판이 적용된 DB 에 이 파일을 재적용해도
  // 신설 컬럼이 안 붙어서 백필이 42703(`round_date` 없음)으로 죽는다.
  // 함수만 보는 종전 검사는 그 상태를 통과시켰다.
  const cols = await conn<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'scope_answer_cycle_anchors'`;
  const have = new Set(cols.map((c) => c.column_name));
  const required = ["measured_at_orig", "is_default_engine", "ledger_view_anchor_date", "round_date"];
  const missing = required.filter((c) => !have.has(c));
  if (missing.length) {
    throw new Error(
      `scope_answer_cycle_anchors 에 컬럼이 없다: ${missing.join(", ")} — ` +
        "이전 판 0077 이 적용된 DB 다. 테이블 DDL 은 재적용으로 갱신되지 않으므로 " +
        "테이블을 DROP 후 재적용하거나 ALTER 로 컬럼을 맞춰야 한다(승인 필요).",
    );
  }
  // 어휘가 **좁아진** 쪽도 본다 — 이전 판은 source 에 `fleet_align` 을 허용했고 그
  // 값으로 쓰인 행이 남아 있으면 고정 판정(`hmg_anchor_is_pinned`)이 이제 false 라
  // 재계산이 그 행을 덮는다. 남아 있으면 백필 전에 정리해야 한다.
  const [legacy] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scope_answer_cycle_anchors WHERE source = 'fleet_align'`;
  if ((legacy?.n ?? 0) > 0) {
    throw new Error(
      `source='fleet_align' 행이 ${legacy?.n}건 남아 있다 — 정규 요일 귀속으로 대체돼 ` +
        "사라진 어휘다. 그 행들을 먼저 처리할 것(승인 필요).",
    );
  }
}

/** dry-run: 읽기 전용 트랜잭션에서 예상치만 낸다. 쓰기가 한 줄도 없다. */
async function dryRun(): Promise<void> {
  const statements = splitDryRunStatements(fs.readFileSync(DRYRUN_SQL_PATH, "utf8"));
  const r: Record<string, string | number> = {};
  let gate: Array<Record<string, string | number>> = [];
  // 문장마다 **새 트랜잭션**이다 — 하나가 타임아웃으로 죽어도 나머지 지표는 나온다.
  for (const st of statements) {
    const t0 = Date.now();
    try {
      const rows = (await conn.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        // 읽기 전용이 **실제로** 걸렸는지 단언한다 — 쓰기를 시도해서 확인하지 않는다.
        const [ro] = (await tx.unsafe("SHOW transaction_read_only")) as unknown as Array<{
          transaction_read_only: string;
        }>;
        if (ro?.transaction_read_only !== "on") {
          throw new Error("읽기 전용 트랜잭션이 걸리지 않았다 — 중단");
        }
        return tx.unsafe(st.sql);
      })) as unknown as Array<Record<string, string | number>>;
      if (!rows?.[0]) throw new Error("행을 돌려주지 않았다");
      if (st.name === "S3_gate") {
        gate = rows; // 표면별 여러 행
      } else {
        Object.assign(r, rows[0]);
      }
      console.log(`[dry-run] ${st.name} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`[dry-run] ${st.name} 실패: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }
  const n = (k: string) => Number(r[k] ?? 0);
  const ok = (v: number) => (v === 0 ? " ✅" : " ⚠️");
  const completed = n("completed_answers");
  const out = n("rows_out");
  console.log(`\n[dry-run] ${DRYRUN_SQL_PATH} · 읽기 전용 · 문장 ${statements.length}개\n`);
  console.log("S1 전수 (completed = rows_out + run행없음 + project_id NULL + 출처없음)");
  console.log(`   completed 답변        ${fmt(completed)}`);
  console.log(`   산출 행(rows_out)     ${fmt(out)}`);
  console.log(`   제외: run 행 없음     ${fmt(n("no_run_row"))}`);
  console.log(`   제외: project_id NULL ${fmt(n("excluded_null_project"))}`);
  console.log(
    `   제외: 출처 없음       ${fmt(n("no_source"))}` +
      `${n("no_source") === 0 ? " ✅" : " ⚠️ (0 이 아니면 --apply 가 시작 전에 중단된다 — BLOCK-3)"}`,
  );
  const diff =
    completed - out - n("no_run_row") - n("excluded_null_project") - n("no_source");
  console.log(`   차이(0 이어야 한다)   ${fmt(diff)}${ok(diff)}`);
  console.log("   출처별");
  for (const k of ["src_registry", "src_ledger", "src_run", "src_fallback_measured"]) {
    console.log(`     ${k.replace("src_", "").padEnd(18)} ${fmt(n(k))}`);
  }
  console.log("   surface 별");
  for (const k of ["sf_standard", "sf_website", "sf_project"]) {
    console.log(`     ${k.replace("sf_", "").padEnd(18)} ${fmt(n(k))}`);
  }
  console.log(`     미분류 (기대 0)     ${fmt(n("sf_unclassified"))}${ok(n("sf_unclassified"))}`);
  console.log("\nS2 0053 레지스트리 (R1 = KST 이관)");
  console.log(`   레지스트리 행            ${fmt(n("registry_rows"))}`);
  console.log(`   테이블에 들어갈 행       ${fmt(n("registry_in_table"))}`);
  console.log(`   고아(completed 답변 없음) ${fmt(n("registry_orphans"))}`);
  console.log(`   KST 로 이관된 행          ${fmt(n("registry_shifted"))}  ← 0053 UTC 날짜와 하루 다른 행(정상)`);
  console.log(`   회차 못 찾아 UTC 유지     ${fmt(n("registry_utc_kept"))}  ← reason 표식, 감사 대상`);
  console.log(`   접기 원복 (기대 0)       ${fmt(n("registry_unfolded"))}${ok(n("registry_unfolded"))}`);
  console.log(`   자동 경로와 다른 행(참고) ${fmt(n("registry_vs_auto"))}`);
  console.log(`   자동 앵커 자체가 없음     ${fmt(n("registry_no_auto_anchor"))}`);
  console.log("\nS3 노출 게이트 (표면별)");
  for (const g of gate) {
    const v = (k: string) => fmt(Number(g[k] ?? 0));
    console.log(`   ${String(g.surface).padEnd(16)} 행 ${v("rows_out")}`);
    console.log(
      `     원장 노출일 없음 ${v("ledger_view_missing")}` +
        ` = 회차 없음 ${v("view_null_no_cycle")} + 회차 미발행 ${v("view_null_cycle_unpublished")}`,
    );
    console.log(`     실제 비노출 ${v("view_null")} · 미래 ${v("view_future")} · 측정일≠앵커일 ${v("measured_ne_anchor")}`);
  }
  console.log("\nS4 회차 (앵커는 **회차 단위로 정하고 답변이 상속**한다 — 스펙 §3.1)");
  console.log(`   회차 수                  ${fmt(n("cycles"))}`);
  console.log(
    `   출처별  registry ${fmt(n("cycles_registry"))} · ledger ${fmt(n("cycles_ledger"))}` +
      ` · run ${fmt(n("cycles_run"))} · fallback ${fmt(n("cycles_fallback"))}`,
  );
  console.log(
    `   회차 안 레지스트리 불일치 ${fmt(n("cycle_registry_split"))}${ok(n("cycle_registry_split"))}` +
      "  ← 0 이 아니면 가장 이른 날짜로 접히고 감사가 표면화",
  );
  console.log(
    `   답변 단위였다면 갈렸을 회차 ${fmt(n("cycle_answer_unit_split"))}` +
      "  ← 회차 단위 상속이 고치는 크기(참고)",
  );
  console.log("   레지스트리 이관 분류 (합 = registry 회차 수)");
  console.log(`     자기 회차 KST 일자와 같음 ${fmt(n("reg_same_own_cycle"))}`);
  console.log(`     다른 회차로 이동          ${fmt(n("reg_moved_other_cycle"))}`);
  console.log(
    `     회차 못 찾아 원래 날짜 유지 ${fmt(n("reg_utc_kept"))}` +
      `${n("reg_utc_kept") === 0 ? " ✅" : " ⚠️ (감사 대상)"}`,
  );
  console.log(
    `     앵커 없는 단독 회차       ${fmt(n("reg_solo_no_anchor"))}` +
      "  ← cycle_anchor_at NULL. 자기 앵커가 없어 위 셋으로 못 가른다",
  );
  const clsSum =
    n("reg_same_own_cycle") + n("reg_moved_other_cycle") + n("reg_utc_kept") + n("reg_solo_no_anchor");
  console.log(
    `     분류 합 vs registry 회차  ${fmt(clsSum)} / ${fmt(n("cycles_registry"))}` +
      `${clsSum === n("cycles_registry") ? " ✅" : " ⚠️"}`,
  );
  console.log(
    `   (프로젝트, KST 주) 앵커 둘 이상 ${fmt(n("project_week_split"))}${ok(n("project_week_split"))}` +
      "  ← 스펙 §3.1 말미: 한 주에 앵커 날짜는 하나여야 한다",
  );
  console.log(
    `     표면별  standard ${fmt(n("project_week_split_standard"))}` +
      ` · website ${fmt(n("project_week_split_website"))}` +
      ` · project ${fmt(n("project_week_split_project"))}`,
  );
  console.log(
    `     기본 타겟 회차만 ${fmt(n("project_week_split_default_engine"))}` +
      "  ← 옵트인 엔진(DeepSeek) 단발 측정이 만든 분할을 뺀 수",
  );
  console.log("\nS5 정규 요일 귀속 **1차 근사** (글로벌=월 · 웹사이트=금, KST)");
  console.log(`   회차 수                  ${fmt(n("round_cycles"))}`);
  console.log(
    `   정규 요일 그대로          ${fmt(n("round_canonical"))}` +
      ` · 정규 요일 없음(project) ${fmt(n("round_project"))}`,
  );
  console.log(
    `   정규 요일이 아닌 회차     ${fmt(n("round_offday"))}` +
      `  (글로벌 ${fmt(n("round_offday_standard"))} · 웹사이트 ${fmt(n("round_offday_website"))})`,
  );
  console.log("   basis 추정");
  console.log(`     앞 자리만 빔(prev_empty) ${fmt(n("est_prev_empty"))}`);
  console.log(`     뒤 자리만 빔(next_empty) ${fmt(n("est_next_empty"))}`);
  console.log(`     둘 다 빔(nearest)        ${fmt(n("est_nearest"))}`);
  console.log(
    `     둘 다 참(merged)         ${fmt(n("est_merged"))}` +
      `  (웹사이트 ${fmt(n("est_merged_website"))} · 글로벌 ${fmt(n("est_merged_standard"))})`,
  );
  console.log(`   합쳐진 자리 추정          ${fmt(n("est_merged_seats"))}`);
  console.log(
    `   이동 방향  앞으로 ${fmt(n("est_move_back"))} · 뒤로 ${fmt(n("est_move_fwd"))}` +
      ` · 최대 ${fmt(n("est_move_max"))}일`,
  );
  console.log(
    `   추정 불확실 조합          ${fmt(n("est_collisions"))}` +
      `${n("est_collisions") === 0 ? " ✅ (근사 = 실제)" : " ⚠️ (비정규끼리 자리 경합 — 차례 배정이 결과를 바꾼다)"}`,
  );
  console.log("\n[dry-run] 쓰기 0건. 실제 백필은 `-- --apply` (제품 책임자 승인 후).\n");
}

/**
 * 모수 분해 — **dry-run S1 과 같은 정의**여야 한다(BLOCK-4).
 *
 *   completed = rows_out + excluded_null_project + no_run_row + no_source
 *
 * 종전 `verify()` 는 `still_missing`(scope_runs 조인 없음)을 `excluded_null_project`
 * (조인 후 project_id NULL)와 비교해, **`scope_runs` 행이 없는 completed 답변**이
 * 하나라도 있으면 영구히 ⚠️ 를 찍었다. 그 항을 따로 세어 등식을 닫는다.
 */
type Census = {
  completed: number;
  no_run_row: number;
  excluded_null_project: number;
  no_source: number;
  in_scope: number;
};

const CENSUS_SQL = `
  WITH a AS (
    SELECT x.job_id, x.measured_at, r.run_id AS r_run, r.project_id, r.cycle_anchor_at AS run_anchor
      FROM scope_answers x
      LEFT JOIN scope_runs r ON r.run_id = x.run_id
     WHERE x.status = 'completed'
  ), src AS (
    SELECT a.*,
           reg.job_id AS reg_job,
           cyc.cycle_anchor_at AS ledger_anchor
      FROM a
      LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = a.r_run
      LEFT JOIN summary_cycles cyc ON cyc.cycle_id = scr.cycle_id
  )
  SELECT count(*)::int                                                   AS completed,
         count(*) FILTER (WHERE r_run IS NULL)::int                      AS no_run_row,
         count(*) FILTER (WHERE r_run IS NOT NULL AND project_id IS NULL)::int
                                                                          AS excluded_null_project,
         count(*) FILTER (WHERE r_run IS NOT NULL AND project_id IS NOT NULL
                            AND reg_job IS NULL AND ledger_anchor IS NULL
                            AND run_anchor IS NULL AND measured_at IS NULL)::int
                                                                          AS no_source,
         count(*) FILTER (WHERE r_run IS NOT NULL AND project_id IS NOT NULL
                            AND (reg_job IS NOT NULL OR ledger_anchor IS NOT NULL
                                 OR run_anchor IS NOT NULL OR measured_at IS NOT NULL))::int
                                                                          AS in_scope
    FROM src`;

async function census(): Promise<Census> {
  const rows = (await conn.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return tx.unsafe(CENSUS_SQL);
  })) as unknown as Census[];
  const c = rows?.[0];
  if (!c) throw new Error("모수 집계가 행을 돌려주지 않았다");
  return c;
}

/**
 * BLOCK-3 선행 게이트 — 네 출처가 모두 없는 답변은 `WHERE source IS NOT NULL` 이
 * 버리므로 그 배치가 **영원히** 기대치에 못 미친다. 시작 전에 목록과 함께 끊는다.
 */
async function assertNoSourceGate(c: Census): Promise<void> {
  if (c.no_source === 0) return;
  const sample = await conn<{ job_id: string; run_id: string }[]>`
    SELECT a.job_id::text AS job_id, a.run_id::text AS run_id
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = a.run_id
      LEFT JOIN summary_cycles cyc ON cyc.cycle_id = scr.cycle_id
     WHERE a.status = 'completed' AND r.project_id IS NOT NULL
       AND reg.job_id IS NULL AND cyc.cycle_anchor_at IS NULL
       AND r.cycle_anchor_at IS NULL AND a.measured_at IS NULL
     ORDER BY a.run_id LIMIT 20`;
  console.error(`\n✗ 출처가 하나도 없는 completed 답변 ${fmt(c.no_source)}건 — 백필을 시작하지 않는다.`);
  console.error("  (네 출처 registry·ledger·run·measured_at 이 전부 NULL 이라 테이블에 들어갈 수 없다.)");
  console.error(`  예시 최대 20건 (job_id / run_id):`);
  for (const r of sample) console.error(`    ${r.job_id}  ${r.run_id}`);
  throw new Error(
    "no_source > 0 — 먼저 그 답변들의 measured_at·run 앵커를 회수하거나 범위에서 제외할 것",
  );
}

/**
 * **배치 후 상태 단언**(BLOCK-1) — "쓴 행 수" 가 아니라 "배치가 끝난 뒤 상태가 맞는가".
 *
 * rowcount 는 쓸 수 없다: `ON CONFLICT DO UPDATE … WHERE (… IS DISTINCT FROM …)` 가
 * **값이 안 바뀐 행을 rowcount 에서 뺀다**. 그래서
 *   · `--recompute` 를 이미 올바른 테이블에 돌리면 rowcount ≈ 0 → 첫 배치에서 중단
 *   · 백필 중 20분 주기 미러 cron 이 같은 job 을 먼저 만들어도 중단
 * 둘 다 "정상인데 멈추는" 실패였다.
 *
 * 대신 이 배치의 **대상 job 이 전부 테이블에 있고 파생 키가 자기 anchor_date 와
 * 맞는가**를 본다. 누락(`missing`)도 불일치(`inconsistent`)도 0 이어야 한다.
 * 대상에서 `no_source` 행은 뺀다(위 게이트가 0 을 보장하지만 술어를 여기에도 둔다).
 */
type BatchState = { target_jobs: number; expected_jobs: number; no_source: number; missing: number; inconsistent: number };

async function batchState(ids: string[]): Promise<BatchState> {
  const rows = (await conn.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return tx<BatchState[]>`
  WITH tgt AS (
    SELECT a.job_id, a.measured_at, r.cycle_anchor_at AS run_anchor,
           reg.job_id AS reg_job, cyc.cycle_anchor_at AS ledger_anchor
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = a.run_id
      LEFT JOIN summary_cycles cyc ON cyc.cycle_id = scr.cycle_id
     WHERE a.run_id = ANY(${ids}::uuid[]) AND a.status = 'completed' AND r.project_id IS NOT NULL
  ), expected AS (
    SELECT job_id FROM tgt
     WHERE reg_job IS NOT NULL OR ledger_anchor IS NOT NULL
        OR run_anchor IS NOT NULL OR measured_at IS NOT NULL
  )
  SELECT (SELECT count(*) FROM tgt)::int                                  AS target_jobs,
         (SELECT count(*) FROM expected)::int                             AS expected_jobs,
         ((SELECT count(*) FROM tgt) - (SELECT count(*) FROM expected))::int AS no_source,
         (SELECT count(*) FROM expected e
           WHERE NOT EXISTS (SELECT 1 FROM scope_answer_cycle_anchors c
                              WHERE c.job_id = e.job_id))::int            AS missing,
         -- 파생 키는 **귀속 날짜(round_date) 기준**이고, round_date 자신은 매핑 표와
         -- 같아야 한다. anchor_at -> anchor_date 만 실제 앵커 축이다.
         (SELECT count(*) FROM scope_answer_cycle_anchors c
            JOIN expected e ON e.job_id = c.job_id
            LEFT JOIN scope_cycle_rounds m
              ON m.project_id = c.project_id AND m.anchor_date = c.anchor_date
           WHERE m.round_date IS NULL
              OR c.round_date   IS DISTINCT FROM m.round_date
              OR c.anchor_week  IS DISTINCT FROM hmg_anchor_week(c.round_date)
              OR c.anchor_month IS DISTINCT FROM hmg_anchor_month(c.round_date)
              OR hmg_anchor_date(c.anchor_at) IS DISTINCT FROM c.anchor_date)::int AS inconsistent`;
  })) as unknown as BatchState[];
  const r = rows?.[0];
  if (!r) throw new Error("배치 상태 조회가 행을 돌려주지 않았다");
  return r;
}

/**
 * 처리 대상 **회차** 목록 — **DB 재조회**가 재개 경로다(스냅샷 파일 없음).
 *
 * SQL 은 배치 모듈이 쥔다(`WORKLIST_SQL`): 회차 키의 정의가 0077 의 확장 키와 같아야
 * 하므로 한 곳에만 둔다. 재개는 `pending > 0` 필터가 담당한다 — 이미 채워진 회차는
 * 다음 실행에서 빠진다.
 */
async function loadWorklist(): Promise<CycleRow[]> {
  const rows = (await conn.unsafe(WORKLIST_SQL)) as unknown as CycleRow[];
  return RECOMPUTE ? rows : rows.filter((r) => r.pending > 0);
}

async function apply(): Promise<void> {
  await assertMigrationApplied();

  // ── 사전 모수 + BLOCK-3 게이트 ────────────────────────────────────────────
  const c = await census();
  console.log("모수 분해 (completed = 테이블 대상 + run행없음 + project_id NULL + 출처없음)");
  console.log(`  completed 답변            ${fmt(c.completed)}`);
  console.log(`  테이블 대상(in_scope)     ${fmt(c.in_scope)}`);
  console.log(`  제외: scope_runs 행 없음  ${fmt(c.no_run_row)}`);
  console.log(`  제외: project_id NULL     ${fmt(c.excluded_null_project)}`);
  console.log(`  제외: 출처 없음           ${fmt(c.no_source)}`);
  const diff = c.completed - c.in_scope - c.no_run_row - c.excluded_null_project - c.no_source;
  console.log(`  차이(0 이어야 한다)       ${fmt(diff)}${diff === 0 ? " ✅" : " ⚠️"}`);
  if (diff !== 0) throw new Error("모수 분해가 안 맞는다 — 중단(집계 술어 점검)");
  await assertNoSourceGate(c);

  // ── 사전 행수 (대량 쓰기 안전수칙) ────────────────────────────────────────
  const t0 = Date.now();
  const work = await loadWorklist();
  const pendingAnswers = work.reduce((s, r) => s + r.pending, 0);
  const totalAnswers = work.reduce((s, r) => s + r.total, 0);
  const totalRuns = work.reduce((s, r) => s + r.run_ids.length, 0);
  if (!ROOT_PROJECT_ID) {
    console.warn(
      "⚠️ SCOPE_ROOT_PROJECT_ID 가 없다 — 표면 'standard' 판정이 원장 출력 폴백으로 돈다(B4).",
    );
  }
  console.log(
    `모수: 대상 회차 ${fmt(work.length)}개 · run ${fmt(totalRuns)}개` +
      ` · 미충전 답변 ${fmt(pendingAnswers)}` +
      ` · 그 회차들의 completed 답변 ${fmt(totalAnswers)}` +
      ` (사전 집계 ${((Date.now() - t0) / 1000).toFixed(1)}s${RECOMPUTE ? " · --recompute" : ""})`,
  );
  if (work.length === 0) {
    console.log("✅ 처리할 회차가 없다 — 할 일이 없다.");
    return;
  }

  const targets = work.slice(0, LIMIT_CYCLES);
  const partial = targets.length < work.length;
  const plan = planBatches(targets, {
    maxAnswers: ANSWERS_PER_BATCH,
    maxRuns: RUNS_PER_BATCH,
  });
  const targetAnswers = targets.reduce((s, r) => s + r.total, 0);
  const targetRuns = targets.reduce((s, r) => s + r.run_ids.length, 0);
  const biggest = targets.reduce((m, r) => Math.max(m, r.total), 0);
  console.log(
    `배치 구성: 회차 ${fmt(targets.length)}개 · run ${fmt(targetRuns)}개` +
      ` · 답변 ${fmt(targetAnswers)}건 → 배치 ${fmt(plan.length)}개` +
      ` (상한 답변 ${fmt(ANSWERS_PER_BATCH)}/배치 · run ${fmt(RUNS_PER_BATCH)}/배치` +
      ` · 최대 회차 ${fmt(biggest)}답변 — 회차는 쪼개지 않는다)`,
  );
  if (partial) {
    // A-2: 부분 실행이라는 사실을 **시작·끝·검증** 세 곳에 찍는다. 종전에는
    // 전수 재배정 패스가 조용히 빠지고 콘솔에도 그 흔적이 남지 않았다.
    console.log(
      `⏸ 부분 실행 — --limit=${fmt(LIMIT_CYCLES)} 로 회차 ${fmt(targets.length)}/${fmt(work.length)} 만 처리한다.` +
        "\n   · 전수 재배정 패스는 **돌지 않는다** → 귀속 날짜가 도착 순서에 의존한 상태로 남는다." +
        "\n   · 재개: 같은 명령을 다시 (남은 회차만 재조회된다)" +
        "\n   · 완주 뒤 전수 정합 회복: npm run db:reassign:cycle-rounds -- --all --apply",
    );
  }

  // 첫 백필인가 — 전수 재배정 패스를 돌지 말지의 판정 축이다.
  const [rz] = await conn<{ n: number }[]>`SELECT count(*)::int AS n FROM scope_cycle_rounds`;
  const roundsEmptyAtStart = (rz?.n ?? 0) === 0;

  let written = 0;
  let batches = 0;
  let retries = 0;
  let doneCycles = 0;
  const start = Date.now();
  for (let i = 0; i < plan.length; i += 1) {
    const batch: BatchPlan = plan[i];
    const ids = batch.ids;
    // 배치가 회차를 자르지 않으므로 확장 집합이 배치를 벗어나지 않는다 → 이 cap 은
    // 함수가 쓸 수 있는 행의 진짜 상한이다(B-1).
    const cap = batch.answers;
    let n = 0;
    try {
      const res = (await conn.begin(async (tx) => {
        // Supavisor 트랜잭션 풀에서 새어 들어온 read-only GUC 를 명시적으로 덮는다.
        await tx.unsafe("SET TRANSACTION READ WRITE");
        await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        return tx<{ n: string }[]>`
          SELECT refresh_answer_cycle_anchors(
                   ${ids}::uuid[], ${ROOT_PROJECT_ID}::uuid)::bigint AS n`;
      })) as unknown as Array<{ n: string | number }>;
      n = Number(res?.[0]?.n ?? 0);
      retries = 0;
    } catch (e) {
      // 타임아웃·락 경합 등 — 이 배치만 버리고 재시도한다(함수는 멱등이다).
      console.error(`  ! 배치 실패(run ${ids[0]}…): ${e instanceof Error ? e.message : e}`);
      retries += 1;
      if (retries > MAX_BATCH_RETRIES) {
        throw new Error(
          `같은 배치가 ${MAX_BATCH_RETRIES}회 연속 실패했다 — 중단(재개: 같은 명령 재실행)`,
        );
      }
      console.error(`    5s 후 같은 배치를 재시도 ${retries}/${MAX_BATCH_RETRIES} (멱등)`);
      await sleep(5_000);
      i -= 1; // 같은 배치를 다시
      continue;
    }
    // ── 단언 (BLOCK-1) ─────────────────────────────────────────────────────
    // ① 상한만 rowcount 로 본다 — 한정 조건이 깨져 배치 **밖** 행을 쓰는 것은
    //    rowcount 로만 보인다.
    if (n > cap) {
      throw new Error(
        `rowcount 이상: 배치의 completed 답변 ${fmt(cap)} < 기록 ${fmt(n)} — 중단(한정 조건 점검).` +
          " 배치는 회차를 통째로 담으므로 회차 확장으로는 이 수가 넘을 수 없다",
      );
    }
    // ② 하한은 **배치 후 상태**로 본다. rowcount 하한을 쓰면 정상인데 멈춘다:
    //    `ON CONFLICT … WHERE (… IS DISTINCT FROM …)` 가 값이 안 바뀐 행을 rowcount
    //    에서 빼기 때문에, `--recompute` 를 이미 맞는 테이블에 돌리거나 미러 cron 이
    //    먼저 같은 job 을 만들면 `n` 이 0 에 가까워진다.
    const st = await batchState(ids);
    if (st.missing > 0 || st.inconsistent > 0) {
      throw new Error(
        `배치 상태 이상: 대상 ${fmt(st.expected_jobs)}건 중 누락 ${fmt(st.missing)}` +
          ` · 파생 키 불일치 ${fmt(st.inconsistent)} — 중단(한정 조건·산식 점검)`,
      );
    }
    if (st.no_source > 0) {
      // 게이트를 통과했는데 배치에서 나왔다 = 백필 도중 상태가 바뀌었다는 뜻이다.
      console.warn(
        `  ⚠️ 이 배치에 출처 없는 답변 ${fmt(st.no_source)}건 — 기대 집합에서 뺐다(감사 대상).`,
      );
    }
    written += n;
    batches += 1;
    doneCycles += batch.cycles.length;
    const elapsed = (Date.now() - start) / 1000;
    const rate = doneCycles / Math.max(elapsed, 0.001);
    const eta = rate > 0 ? (targets.length - doneCycles) / rate : 0;
    console.log(
      `  batch#${batches} 회차 ${fmt(batch.cycles.length)} · run ${fmt(ids.length)}` +
        ` · 상한 ${fmt(cap)} · 기록 ${fmt(n)}행` +
        ` (누적 회차 ${fmt(doneCycles)}/${fmt(targets.length)} · 행 ${fmt(written)}` +
        ` · ${rate.toFixed(1)} 회차/s · ETA ${Math.round(eta)}s)`,
    );
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  // ── 3단계: 전수 재배정 패스 (배치 경계가 깨뜨리는 2단계 규칙 회수) ─────────
  let reassigned = false;
  if (NO_REASSIGN) {
    console.log("\n⏭ --no-reassign — 전수 재배정 패스를 건너뛴다(증분 배정 상태 그대로).");
  } else if (partial) {
    console.log(
      `\n⏭ 부분 실행(--limit=${fmt(LIMIT_CYCLES)}) — 전수 재배정 패스를 건너뛴다.` +
        "\n  남은 회차가 있는 상태의 '전수' 패스는 전수가 아니다(A-2). 완주 뒤 한 번에:" +
        "\n    npm run db:reassign:cycle-rounds -- --all --apply",
    );
  } else if (!roundsEmptyAtStart && !RECOMPUTE) {
    console.log(
      "\nℹ 매핑 표에 이미 배정이 있고 --recompute 도 아니다 — 과거 배정을 흔들지 않기 위해" +
        "\n  전수 재배정 패스를 돌지 않는다. 순서를 다시 잡아야 하면:" +
        "\n    npm run db:reassign:cycle-rounds -- --all            (dry-run)",
    );
  } else {
    await reassignAll(targets.flatMap((r) => r.run_ids));
    reassigned = true;
  }

  await verify(written, batches, start, {
    partial,
    doneCycles: targets.length,
    totalCycles: work.length,
    reassigned,
  });
}

/**
 * 전수 재배정 패스 — 대상 run 들이 속한 **프로젝트 전체**의 배정을 지우고 다시 앉힌다.
 *
 * 한 트랜잭션이다. 배정 함수가 프로젝트 단위 advisory lock 을 잡으므로, 같은 시각에
 * 도는 미러 싱크의 증분 배정과 같은 빈 자리를 다투지 않는다.
 */
async function reassignAll(runIds: string[]): Promise<void> {
  const projects = (
    await conn<{ project_id: string }[]>`
      SELECT DISTINCT project_id::text AS project_id
        FROM scope_answer_cycle_anchors
       WHERE run_id = ANY(${runIds}::uuid[]) AND project_id IS NOT NULL
       ORDER BY 1`
  ).map((r) => r.project_id);
  if (projects.length === 0) {
    console.log("\n전수 재배정: 대상 프로젝트가 없다 — 건너뛴다.");
    return;
  }
  const t0 = Date.now();
  const res = (await conn.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ WRITE");
    await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const del = await tx`
      DELETE FROM scope_cycle_rounds WHERE project_id = ANY(${projects}::uuid[])`;
    const [a] = (await tx`
      SELECT hmg_assign_cycle_rounds(NULL::uuid[], ${projects}::uuid[])::bigint AS n`) as unknown as Array<{
      n: string;
    }>;
    const [m] = (await tx`
      SELECT hmg_propagate_cycle_rounds(NULL::uuid[], ${projects}::uuid[])::bigint AS n`) as unknown as Array<{
      n: string;
    }>;
    // 단언 — 대상 프로젝트의 모든 회차가 매핑을 가져야 한다.
    const [u] = (await tx`
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT c.project_id, c.anchor_date FROM scope_answer_cycle_anchors c
         WHERE c.project_id = ANY(${projects}::uuid[])
      ) s
       WHERE NOT EXISTS (SELECT 1 FROM scope_cycle_rounds m
                          WHERE m.project_id = s.project_id AND m.anchor_date = s.anchor_date)`) as unknown as Array<{
      n: number;
    }>;
    if (Number(u?.n ?? 0) > 0) {
      throw new Error(`전수 재배정 후에도 매핑 없는 회차 ${fmt(Number(u?.n))}개 — 롤백`);
    }
    return { deleted: del.count ?? 0, assigned: Number(a?.n ?? 0), moved: Number(m?.n ?? 0) };
  })) as unknown as { deleted: number; assigned: number; moved: number };
  console.log(
    `\n전수 재배정: 프로젝트 ${fmt(projects.length)}개 · 지움 ${fmt(res.deleted)}` +
      ` · 배정 ${fmt(res.assigned)} · 답변 전파 ${fmt(res.moved)}행` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

/**
 * 이번 실행이 전수였는가 부분이었는가 — 검증 출력이 이 둘을 **구분해야** 한다(A-2).
 * 부분 실행은 잔여가 남아 있는 것이 정상이므로 "차이 ≠ 0" 이 결함 신호가 아니다.
 */
type RunScope = {
  partial: boolean;
  doneCycles: number;
  totalCycles: number;
  reassigned: boolean;
};

/** 전수 대조 (스펙 §6-3 수용 기준). 읽기만 한다. */
async function verify(
  written: number,
  batches: number,
  start: number,
  scope: RunScope,
): Promise<void> {
  // BLOCK-4: 분해의 정의는 `census()` 한 곳이다 — dry-run S1 과 같은 술어를 쓴다.
  const c = await census();
  const rows = (await conn.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return tx.unsafe(`
      SELECT (SELECT count(*) FROM scope_answer_cycle_anchors)                      AS rows_out,
             -- R1 이관 후: registry 행의 anchor_date 는 0053 의 UTC 날짜와 **같을 수도
             -- 다를 수도** 있다(회차 시각을 찾아 KST 로 다시 잘랐으면 하루 밀린다).
             (SELECT count(*) FROM scope_answer_cycle_anchors c
                JOIN scope_answer_anchors r USING (job_id)
               WHERE c.source = 'registry'
                 AND c.anchor_date IS DISTINCT FROM r.anchor)                       AS registry_shifted,
             (SELECT count(*) FROM scope_answer_cycle_anchors
               WHERE source = 'registry'
                 AND reason LIKE '%[anchor-tz:utc-date-kept]%')                     AS registry_utc_kept,
             (SELECT count(*) FROM scope_answer_cycle_anchors c
               WHERE NOT EXISTS (SELECT 1 FROM scope_answers a
                                  WHERE a.job_id = c.job_id))                       AS orphans,
             (SELECT count(*) FROM scope_cycle_rounds)                              AS round_rows,
             -- 귀속 날짜가 그 표면의 정규 요일이 아닌 회차. project 표면은 제외한다.
             (SELECT count(*) FROM scope_cycle_rounds
               WHERE hmg_round_canonical_dow(surface) IS NOT NULL
                 AND EXTRACT(ISODOW FROM round_date)::int
                     <> hmg_round_canonical_dow(surface))                           AS off_canonical,
             -- 답변 행의 복사본이 매핑과 어긋난 수.
             (SELECT count(*) FROM scope_answer_cycle_anchors c
                LEFT JOIN scope_cycle_rounds m
                  ON m.project_id = c.project_id AND m.anchor_date = c.anchor_date
               WHERE m.round_date IS NULL
                  OR c.round_date IS DISTINCT FROM m.round_date)                    AS round_drift,
             -- 한 자리에 둘 이상 앉은 회차(= 합쳐진 자리)의 회차 수.
             (SELECT coalesce(sum(k), 0) FROM (
                SELECT count(*) AS k FROM scope_cycle_rounds
                 GROUP BY project_id, round_date HAVING count(*) > 1) s)            AS merged_cycles
    `);
  })) as unknown as Array<Record<string, string | number>>;
  const r = rows?.[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    scope.partial
      ? `\n⏸ 부분 실행으로 끝났다 — 회차 ${fmt(scope.doneCycles)}/${fmt(scope.totalCycles)}` +
          ` · 기록 ${fmt(written)}행 / ${batches} 배치 · ${secs}s`
      : `\n✅ 기록 ${fmt(written)}행 / ${batches} 배치 · ${secs}s`,
  );
  console.log(
    `  상태: ${scope.partial ? "미완주 (잔여 회차 남음)" : "완주"}` +
      ` · 전수 재배정 패스 ${scope.reassigned ? "실행함" : "미실행"}`,
  );
  if (scope.partial) {
    console.log(
      "  ⚠️ 아래 전수 대조는 **아직 다 쓰지 않은 상태**를 잰다 — 차이가 0 이 아닌 것이 정상이다." +
        "\n     같은 명령을 반복해 완주시킨 뒤, 마지막에" +
        " npm run db:reassign:cycle-rounds -- --all --apply",
    );
  }
  console.log("\n── 전수 대조 (스펙 §6-3) ──────────────────────────────────────");
  console.log("  completed = 테이블 행 + run행없음 + project_id NULL + 출처없음");
  console.log(`  completed 답변            ${fmt(c.completed)}`);
  console.log(`  테이블 행(rows_out)       ${fmt(n("rows_out"))}`);
  console.log(`  제외: scope_runs 행 없음  ${fmt(c.no_run_row)}`);
  console.log(`  제외: project_id NULL     ${fmt(c.excluded_null_project)}`);
  console.log(`  제외: 출처 없음           ${fmt(c.no_source)}`);
  // 고아(답변이 사라진 앵커 행)는 테이블 행 수에 포함되지만 completed 에는 없다 —
  // 그래서 등식에서 빼고 따로 센다.
  const balance =
    c.completed - (n("rows_out") - n("orphans")) - c.no_run_row - c.excluded_null_project - c.no_source;
  console.log(
    scope.partial
      ? `  차이(잔여 — 부분 실행)    ${fmt(balance)}` +
          `${balance === 0 ? " ✅ (잔여 없음)" : " ⏸ (정상 — 같은 명령으로 이어서)"}`
      : `  차이(0 이어야 한다)       ${fmt(balance)}` +
          `${balance === 0 ? " ✅" : " ⚠️ (같은 명령을 한 번 더)"}`,
  );
  console.log(`  고아(답변 없는 앵커 행)   ${fmt(n("orphans"))}  ← 지우지 않는다(스펙 §4 · 고정 출처)`);
  console.log(`  0053 → KST 이관된 행      ${fmt(n("registry_shifted"))}  ← UTC 날짜와 하루 다른 행(정상)`);
  console.log(`  회차 못 찾아 UTC 유지     ${fmt(n("registry_utc_kept"))}  ← reason 표식, 감사 대상`);
  console.log("\n── 정규 요일 귀속 ─────────────────────────────────────────────");
  console.log(`  배정된 회차               ${fmt(n("round_rows"))}`);
  console.log(
    `  정규 요일 아닌 귀속 날짜  ${fmt(n("off_canonical"))}` +
      `${n("off_canonical") === 0 ? " ✅" : " ⚠️ (배정 규칙 위반 — 감사 SQL 확인)"}`,
  );
  console.log(
    `  답변 복사본 불일치        ${fmt(n("round_drift"))}` +
      `${n("round_drift") === 0 ? " ✅" : " ⚠️ (전파 누락)"}`,
  );
  console.log(`  합쳐진 자리의 회차        ${fmt(n("merged_cycles"))}`);
  console.log("\n  표면/basis 분포:");
  const basis = await conn<{ surface: string; basis: string; n: string }[]>`
    SELECT surface, basis, count(*)::text AS n FROM scope_cycle_rounds
     GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
  for (const b of basis) {
    console.log(`    ${`${b.surface}/${b.basis}`.padEnd(24)} ${fmt(Number(b.n))}`);
  }
  console.log("\n  앵커 대비 이동 일수 (0 = 앵커가 이미 정규 요일):");
  const move = await conn<{ d: string; n: string }[]>`
    SELECT (round_date - anchor_date)::text AS d, count(*)::text AS n
      FROM scope_cycle_rounds GROUP BY 1 ORDER BY 1::int`;
  for (const m of move) console.log(`    ${m.d.padStart(5)}일  ${fmt(Number(m.n))}`);
  console.log("\n  출처별:");
  const dist = await conn<{ source: string; n: string }[]>`
    SELECT source, count(*)::text AS n FROM scope_answer_cycle_anchors GROUP BY 1 ORDER BY 2 DESC`;
  for (const d of dist) console.log(`    ${d.source.padEnd(20)} ${fmt(Number(d.n))}`);
}

async function main() {
  if (!APPLY) {
    if (RECOMPUTE) {
      console.log("ℹ --recompute 는 --apply 와 함께 쓴다. 이번 실행은 dry-run 이다.");
    }
    await dryRun();
    return;
  }
  console.log("⚠️ --apply — 실제 쓰기 모드. 대상 테이블은 scope_answer_cycle_anchors 하나다.");
  await apply();
  // 2026-09-27(hmg-geo PR #297 검증 C2): 이미 노출 중인 회차의 답변 행 재계산은 회차
  // 지문이 못 본다 — 무효화 명령을 안내한다.
  console.log(mirrorCacheRevalidateNotice("앵커 행 백필·재계산"));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => conn.end());
