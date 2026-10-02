/**
 * 회차 **정규 요일 귀속 재배정** (운영자 전용, migration 0077).
 *
 *   npm run db:reassign:cycle-rounds -- --all                         # dry-run (기본)
 *   npm run db:reassign:cycle-rounds -- --all --apply
 *   npm run db:reassign:cycle-rounds -- --projects=<uuid,uuid>
 *   npm run db:reassign:cycle-rounds -- --projects=<uuid> --from=2026-07-01 --to=2026-08-31
 *   npm run db:reassign:cycle-rounds -- --all --chunk=10               # 락 보유 시간 단축
 *   npm run db:reassign:cycle-rounds -- --all --lock-timeout=1s --statement-timeout=1min
 *
 * ── 왜 이 경로가 따로 있는가 ────────────────────────────────────────────────
 * 정규 요일 귀속의 기본 규율은 **과거 배정을 재계산하지 않는다**는 것이다(과거 값
 * 안정성). `hmg_assign_cycle_rounds` 는 미배정 회차만 새로 앉히고, 새 회차가 들어와도
 * 이미 앉은 회차는 움직이지 않는다.
 *
 * 그래서 다시 앉혀야 하는 경우는 **운영자가 명시적으로 부를 때뿐**이다:
 *   · 0053 수작업 접기로 회차의 `anchor_date` 자체가 옮겨졌다(옛 자리가 고아로 남는다)
 *   · 정규 요일 상수(`hmg_round_canonical_dow`)를 바꿨다
 *   · 배정 중간에 끊겨 차례 배정의 순서가 꼬였다(백필 도중 사고)
 *
 * ── 무엇을 쓰는가 ───────────────────────────────────────────────────────────
 * `scope_cycle_rounds`(매핑)와 `scope_answer_cycle_anchors` 의 귀속 파생 3컬럼
 * (`round_date`·`anchor_week`·`anchor_month`)뿐이다. **앵커 값(`anchor_at`·
 * `anchor_date`)과 코어·미러·회차 원장은 한 컬럼도 건드리지 않는다** — 앵커 이동을
 * 퍼뜨리면 관제가 유령 회차를 연다(사내 운영 규칙(adhoc-measurement) 11번).
 *
 * ── dry-run 의 성격 (읽기 전용이 **아니다**) ────────────────────────────────
 * 배정은 차례 배정이라 순수 SQL 로 흉내 낼 수 없다. 그래서 dry-run 도 **쓰기
 * 트랜잭션 안에서 실제 재배정을 돌린 뒤 ROLLBACK** 한다 — 결과는 정확하고 디스크에는
 * 아무것도 남지 않는다. 규칙 구현을 두 벌로 만들지 않기 위한 선택이다.
 *
 * **그 사이 잡는 락이 미러 싱크를 막는다**(A-4). 트랜잭션이 도는 동안
 *   ① 대상 프로젝트 전부의 `pg_advisory_xact_lock`(배정 함수가 잡는다)
 *   ② `scope_cycle_rounds` 대상 행의 삭제 락
 *   ③ 전파 함수가 바꾸는 앵커 행의 갱신 락(전수면 수십만 행 규모)
 * 를 쥐고, 같은 시각 미러 싱크의 `refresh_answer_cycle_anchors` 는 같은 advisory
 * 키에서 대기한다. 그래서 이 스크립트는
 *   · 실행 전에 그 사실을 **경고로 찍고**
 *   · dry-run 기본 타임아웃을 짧게 걸고(`--lock-timeout` 기본 2s · `--statement-timeout` 기본 2min)
 *   · `--all` dry-run 을 **프로젝트 청크마다 별도 트랜잭션**으로 돌려(기본 25개)
 *     한 번에 쥐는 락과 보유 시간을 줄인다.
 * `--apply` 는 원자성이 우선이라 **한 트랜잭션**을 유지한다(청크를 쓰지 않는다) —
 * 미러 cron 이 쉬는 창에서 돌릴 것.
 *
 * ── 대량 쓰기 안전수칙(사내 운영 규칙) ─────────────────────────────────────
 *   · 사전 행수 SELECT — 대상 회차·답변 수를 먼저 찍는다
 *   · fingerprint 한정 — `--projects`(또는 `--all`) + 선택적 `--from/--to`
 *   · rowcount 단언 — 재배정 후 대상 회차가 **전부** 매핑을 갖는지 본다
 *   · 단일 트랜잭션 + SET LOCAL 타임아웃
 */
import postgres from "postgres";
import { mirrorCacheRevalidateNotice } from "./mirror-cache-notice";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL not set — .env.local 확인");
  process.exit(1);
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
const opt = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const asDate = (name: string): string | null => {
  const v = opt(name);
  if (v === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${name} 값이 날짜 형태가 아니다: ${v}`);
  return v;
};
const PROJECTS = (opt("projects") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const p of PROJECTS) {
  if (!/^[0-9a-fA-F-]{36}$/.test(p)) throw new Error(`--projects 값이 uuid 가 아니다: ${p}`);
}
if (!ALL && PROJECTS.length === 0) {
  throw new Error("대상이 없다 — `--projects=<uuid,…>` 또는 `--all` 중 하나를 준다");
}
if (ALL && PROJECTS.length > 0) {
  throw new Error("`--all` 과 `--projects` 를 함께 줄 수 없다");
}
const FROM = asDate("from");
const TO = asDate("to");
if (FROM && TO && FROM > TO) throw new Error("--from 이 --to 보다 늦다");

/** PG interval 리터럴만 받는다 — 문자열이 그대로 `SET LOCAL` 에 들어간다. */
const asTimeout = (name: string, dflt: string): string => {
  const v = opt(name);
  if (v === null) return dflt;
  if (!/^\d+(ms|s|min)$/.test(v)) {
    throw new Error(`--${name} 값이 잘못됐다: ${v} (예: 500ms · 2s · 5min)`);
  }
  return v;
};
/**
 * 기본값이 dry-run 과 apply 에서 다르다(A-4). dry-run 은 어차피 롤백하므로 락을
 * 오래 기다릴 이유가 없다 — 빨리 포기하고 운영자에게 "지금은 창이 아니다" 를 알린다.
 */
const STATEMENT_TIMEOUT = asTimeout("statement-timeout", APPLY ? "10min" : "2min");
const LOCK_TIMEOUT = asTimeout("lock-timeout", APPLY ? "5s" : "2s");
/** dry-run `--all` 을 몇 개 프로젝트씩 나눠 돌 것인가(락 보유 시간 단축). */
const CHUNK = (() => {
  const v = opt("chunk");
  if (v === null) return 25;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--chunk 값이 잘못됐다: ${v}`);
  return Math.floor(n);
})();

const conn = postgres(DATABASE_URL, { prepare: false, connect_timeout: 15 });
const fmt = (n: number | string) => Number(n).toLocaleString("en-US");

/** dry-run 롤백을 강제하는 표식 — 실제 오류와 구분한다. */
const ROLLBACK_MARK = "__dry_run_rollback__";

type MapRow = {
  project_id: string;
  anchor_date: string;
  surface: string;
  round_date: string;
  basis: string;
};

async function main(): Promise<void> {
  // 0077 적용 여부 — 매핑 표와 배정 함수가 한 파일에서 함께 생긴다.
  const [t] = await conn<{ present: boolean }[]>`
    SELECT to_regclass('public.scope_cycle_rounds') IS NOT NULL AS present`;
  if (!t?.present) {
    throw new Error("scope_cycle_rounds 가 없다 — 먼저 적용: npm run db:apply -- 0077");
  }
  const [f] = await conn<{ ok: boolean }[]>`
    SELECT to_regprocedure('public.hmg_assign_cycle_rounds(uuid[], uuid[])') IS NOT NULL
       AND to_regprocedure('public.hmg_propagate_cycle_rounds(uuid[], uuid[])') IS NOT NULL AS ok`;
  if (!f?.ok) {
    throw new Error("hmg_assign_cycle_rounds / hmg_propagate_cycle_rounds 가 없다 — 0077 재적용 필요");
  }

  // 대상 프로젝트 확정. `--all` 은 앵커 행이 있는 프로젝트 전부다.
  const projects = ALL
    ? (
        await conn<{ project_id: string }[]>`
          SELECT DISTINCT project_id::text AS project_id
            FROM scope_answer_cycle_anchors WHERE project_id IS NOT NULL ORDER BY 1`
      ).map((r) => r.project_id)
    : PROJECTS;
  if (projects.length === 0) {
    console.log("대상 프로젝트가 없다 — 할 일이 없다.");
    return;
  }

  console.log(
    `대상 프로젝트 ${fmt(projects.length)}개` +
      `${FROM || TO ? ` · anchor_date ${FROM ?? "…"} ~ ${TO ?? "…"}` : " · 전 기간"}` +
      `${APPLY ? " · --apply" : " · dry-run (끝에서 ROLLBACK)"}`,
  );

  // ── A-4: dry-run 도 락을 잡는다. 돌기 전에 그 사실을 알린다. ────────────────
  const passes = APPLY ? [projects] : chunk(projects, CHUNK);
  if (!APPLY) {
    console.log(
      "\n⚠️ dry-run 은 읽기 전용이 아니다 — 쓰기 트랜잭션에서 실제 재배정을 돌린 뒤 롤백한다.",
    );
    console.log(
      "   그 사이 대상 프로젝트의 advisory lock · 매핑 행 삭제 락 · 앵커 행 갱신 락을 쥐고,",
    );
    console.log(
      "   같은 시각 미러 싱크(refresh_answer_cycle_anchors)는 같은 advisory 키에서 대기한다.",
    );
    console.log(
      `   이번 실행: lock_timeout=${LOCK_TIMEOUT} · statement_timeout=${STATEMENT_TIMEOUT}` +
        ` · 트랜잭션 ${fmt(passes.length)}개 (프로젝트 ${fmt(CHUNK)}개씩)`,
    );
    console.log(
      "   미러 cron 이 도는 시간대는 피하고, 규모만 보려면 --projects= 로 좁힐 것.\n",
    );
  } else if (projects.length > CHUNK) {
    console.log(
      `\n⚠️ --apply 는 원자성을 위해 **한 트랜잭션**이다 — 프로젝트 ${fmt(projects.length)}개의 락을` +
        " 끝까지 쥔다.\n   미러 cron 이 쉬는 창에서 돌릴 것(--projects= 로 나누면 창을 짧게 쓸 수 있다).\n",
    );
  }

  const acc: PassResult = { before: [], after: [], deleted: 0, assigned: 0, movedRows: 0 };
  for (const [i, pass] of passes.entries()) {
    if (passes.length > 1) {
      console.log(`  pass ${i + 1}/${passes.length} · 프로젝트 ${fmt(pass.length)}개`);
    }
    const r = await runPass(pass);
    acc.before.push(...r.before);
    acc.after.push(...r.after);
    acc.deleted += r.deleted;
    acc.assigned += r.assigned;
    acc.movedRows += r.movedRows;
  }

  report(acc.before, acc.after, acc);
  console.log(
    APPLY
      ? "\n✅ 적용됐다. 감사 SQL 로 확인: scripts/db/answer-cycle-anchors-audit.sql\n"
      : "\nℹ dry-run — 트랜잭션을 롤백했다. 디스크는 무변경이다. 적용은 `-- --apply`.\n",
  );
}

type PassResult = {
  before: MapRow[];
  after: MapRow[];
  deleted: number;
  assigned: number;
  movedRows: number;
};

/**
 * 한 트랜잭션 = 프로젝트 묶음 하나. `--apply` 면 커밋, dry-run 이면 끝에서 롤백한다.
 * dry-run 을 여러 패스로 나누는 것이 안전한 이유: 배정·전파가 **프로젝트 단위**이고
 * (advisory 키도 프로젝트별) 프로젝트끼리 자리를 다투지 않는다 — 나눠 돌아도 결과가
 * 같고, 한 번에 쥐는 락과 보유 시간만 줄어든다.
 */
async function runPass(projects: string[]): Promise<PassResult> {
  let before: MapRow[] = [];
  let after: MapRow[] = [];
  let assigned = 0;
  let deleted = 0;
  let movedRows = 0;

  try {
    await conn.begin(async (tx) => {
      // Supavisor 트랜잭션 풀에서 새어 들어온 read-only GUC 를 명시적으로 덮는다.
      await tx.unsafe("SET TRANSACTION READ WRITE");
      await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

      before = (await tx<MapRow[]>`
        SELECT project_id::text AS project_id, anchor_date::text AS anchor_date,
               surface, round_date::text AS round_date, basis
          FROM scope_cycle_rounds
         WHERE project_id = ANY(${projects}::uuid[])
           AND (${FROM}::date IS NULL OR anchor_date >= ${FROM}::date)
           AND (${TO}::date   IS NULL OR anchor_date <= ${TO}::date)`) as unknown as MapRow[];

      // ① 대상 구간의 배정을 지운다. 구간 밖 자리는 그대로 남아 점유로 작동한다.
      const del = await tx`
        DELETE FROM scope_cycle_rounds
         WHERE project_id = ANY(${projects}::uuid[])
           AND (${FROM}::date IS NULL OR anchor_date >= ${FROM}::date)
           AND (${TO}::date   IS NULL OR anchor_date <= ${TO}::date)`;
      deleted = del.count ?? 0;

      // ② 규칙대로 다시 앉힌다(정의는 DB 함수 하나뿐 — 여기 사본을 두지 않는다).
      const [a] = (await tx`
        SELECT hmg_assign_cycle_rounds(NULL::uuid[], ${projects}::uuid[])::bigint AS n`) as unknown as Array<{
        n: string;
      }>;
      assigned = Number(a?.n ?? 0);

      // ③ 답변 행에 전파한다(값이 실제로 다른 행만).
      const [m] = (await tx`
        SELECT hmg_propagate_cycle_rounds(NULL::uuid[], ${projects}::uuid[])::bigint AS n`) as unknown as Array<{
        n: string;
      }>;
      movedRows = Number(m?.n ?? 0);

      // ④ 단언 — 대상 프로젝트의 모든 회차가 매핑을 가져야 한다.
      const [u] = (await tx`
        SELECT count(*)::int AS n FROM (
          SELECT DISTINCT c.project_id, c.anchor_date
            FROM scope_answer_cycle_anchors c
           WHERE c.project_id = ANY(${projects}::uuid[])
        ) s
         WHERE NOT EXISTS (SELECT 1 FROM scope_cycle_rounds m
                            WHERE m.project_id = s.project_id AND m.anchor_date = s.anchor_date)`) as unknown as Array<{
        n: number;
      }>;
      const unmapped = Number(u?.n ?? 0);
      if (unmapped > 0) {
        throw new Error(`재배정 후에도 매핑이 없는 회차가 ${fmt(unmapped)}개 — 중단(롤백)`);
      }

      after = (await tx<MapRow[]>`
        SELECT project_id::text AS project_id, anchor_date::text AS anchor_date,
               surface, round_date::text AS round_date, basis
          FROM scope_cycle_rounds
         WHERE project_id = ANY(${projects}::uuid[])
           AND (${FROM}::date IS NULL OR anchor_date >= ${FROM}::date)
           AND (${TO}::date   IS NULL OR anchor_date <= ${TO}::date)`) as unknown as MapRow[];

      if (!APPLY) throw new Error(ROLLBACK_MARK);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== ROLLBACK_MARK) throw e;
  }
  // 매핑 누락 단언은 트랜잭션 **안에서** 던진다(롤백). 여기까지 왔으면 0 이다.
  return { before, after, deleted, assigned, movedRows };
}

/** 프로젝트 목록을 크기 n 묶음으로 자른다(dry-run 의 락 보유 시간 단축). */
function chunk(xs: string[], n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function report(
  before: MapRow[],
  after: MapRow[],
  n: { deleted: number; assigned: number; movedRows: number },
): void {
  const key = (r: MapRow) => `${r.project_id}|${r.anchor_date}`;
  const prev = new Map(before.map((r) => [key(r), r]));
  let same = 0;
  let moved = 0;
  let fresh = 0;
  const dist = new Map<number, number>();
  const basisAfter = new Map<string, number>();
  for (const r of after) {
    basisAfter.set(`${r.surface}/${r.basis}`, (basisAfter.get(`${r.surface}/${r.basis}`) ?? 0) + 1);
    const p = prev.get(key(r));
    if (!p) {
      fresh += 1;
    } else if (p.round_date === r.round_date) {
      same += 1;
    } else {
      moved += 1;
    }
    // 귀속이 앵커에서 며칠 움직였는가(부호 있음).
    const days = Math.round(
      (Date.parse(`${r.round_date}T00:00:00Z`) - Date.parse(`${r.anchor_date}T00:00:00Z`)) / 86_400_000,
    );
    dist.set(days, (dist.get(days) ?? 0) + 1);
  }
  // 한 자리에 둘 이상 앉은 회차(= 합쳐진 자리).
  const seat = new Map<string, number>();
  for (const r of after) {
    const k = `${r.project_id}|${r.round_date}`;
    seat.set(k, (seat.get(k) ?? 0) + 1);
  }
  const mergedSeats = [...seat.values()].filter((v) => v > 1).length;
  const mergedCycles = [...seat.values()].filter((v) => v > 1).reduce((s, v) => s + v, 0);

  console.log("\n── 재배정 결과 ────────────────────────────────────────────────");
  console.log(`  지운 배정            ${fmt(n.deleted)}`);
  console.log(`  새로 앉힌 회차       ${fmt(n.assigned)}`);
  console.log(`  답변 행 전파         ${fmt(n.movedRows)}`);
  console.log(`  대상 회차            ${fmt(after.length)}`);
  console.log(`    귀속 날짜 그대로   ${fmt(same)}`);
  console.log(`    귀속 날짜 바뀜     ${fmt(moved)}`);
  console.log(`    이번에 처음 배정   ${fmt(fresh)}`);
  console.log(`  합쳐진 자리          ${fmt(mergedSeats)} (회차 ${fmt(mergedCycles)}개)`);
  console.log("\n  표면/basis 분포");
  for (const [k, v] of [...basisAfter.entries()].sort()) {
    console.log(`    ${k.padEnd(24)} ${fmt(v)}`);
  }
  console.log("\n  앵커 대비 이동 일수 (0 = 앵커가 이미 정규 요일)");
  for (const [d, v] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(d >= 0 ? `+${d}` : d).padStart(5)}일  ${fmt(v)}`);
  }
  // 2026-09-27(hmg-geo PR #297 검증 G1): state 행이 없는 회차의 귀속 날짜 이동은 회차
  // 지문이 못 본다 — 커밋한 실행이면 무효화 명령을 안내한다.
  if (APPLY && (n.assigned > 0 || n.movedRows > 0 || n.deleted > 0)) {
    console.log(mirrorCacheRevalidateNotice("귀속 날짜 재배정"));
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => conn.end({ timeout: 5 }));
