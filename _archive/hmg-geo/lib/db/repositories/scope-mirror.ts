import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { ScopeMirrorProgressTx } from "./scope-mirror-progress";
import {
  anchorRegistryAvailable,
  answerStancesAvailable,
  citationNormColumnsAvailable,
  dropRegistryAvailable,
  ensureColumnAvailability,
  mentionOccurrencesAvailable,
} from "@/lib/db/column-availability";
import {
  scopeRuns,
  scopeAnswers,
  scopeMentions,
  scopeMentionOccurrences,
  scopeAnswerStances,
  scopeCitations,
  scopePrompts,
  scopeAcrRollups,
  scopeSyncCursors,
  scopeMirrorProgress,
} from "@/lib/db/schema";

// Write side of the scope mirror. Callers: lib/scope/mirror/sync.ts (run
// replication) and the prompt-lifecycle actions (promptImpact /
// deletePromptData — 완전 삭제 캐스케이드의 미러 구간).
// A run is mirrored atomically: its prior answers/mentions/citations are wiped
// and reinserted, so a re-sync is idempotent. The terminal-status run set is the
// sync watermark — but terminal is NOT immutable (see mirroredRunStates).
//
// ⚠️ "재삽입" = **미러 행 위의 파생 가공은 전부 날아간다.** 그래서 파생값은
// 이 트랜잭션 안에서 매번 다시 만들어져야 한다: 인용 URL 정규화 컬럼은
// citationValues() 로, 회차 앵커 measured_at 은 anchorReapplySql() 로.
// 이 규칙을 어기고 "한 번 UPDATE 하고 끝"으로 처리한 것이 2026-08-31 앵커
// 원복 사고(18,890행)다.

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];
export type MirrorAnswer = Insert<typeof scopeAnswers>;
export type MirrorMention = Insert<typeof scopeMentions>;
export type MirrorMentionOccurrence = Insert<typeof scopeMentionOccurrences>;
export type MirrorAnswerStance = Insert<typeof scopeAnswerStances>;
export type MirrorCitation = Insert<typeof scopeCitations>;
export type MirrorRun = Omit<Insert<typeof scopeRuns>, "syncedAt">;
export type MirrorPrompt = Insert<typeof scopePrompts>;
export type MirrorAcrRollup = Insert<typeof scopeAcrRollups>;

// 인용 URL 정규화 컬럼(0052) 충전 — **저장 시점에 1회**.
// 값은 앱에서 계산해 넣지 않는다. 정규화 정의의 정본은 마이그레이션이 만든
// IMMUTABLE SQL 함수 하나뿐이고(citation_url_norm/…_base_norm/…_host), 삽입·
// 백필·읽기 폴백이 전부 그 함수를 부른다 — TS 로 한 벌 더 계산하면 두 벌이
// 갈라진 순간 "저장된 값 ≠ 폴백이 계산한 값" 이 되어 같은 URL 이 행마다 다른
// 판정을 받는다(추적이 매우 어려운 형태).
//
// 컬럼·함수가 아직 없는 상태(= 배포가 db:apply 보다 앞선 창)에서는 종전 컬럼만
// 넣는다. 그 창에 들어온 행은 url_norm 이 NULL 로 남고, 읽기는 폴백 식으로
// 정확히 같은 값을 계산하며, 백필(`WHERE url_norm IS NULL`)이 나중에 회수한다.
//
// ⚠️ 미러는 run 단위 replace 멱등이라 **재동기화가 곧 재계산**이다 — 정규화
// 규칙이 바뀌면 이 경로가 새 값으로 덮고, 안 바뀐 과거 run 은 백필이 맡는다.
export function citationValues(rows: MirrorCitation[]) {
  if (!citationNormColumnsAvailable()) return rows;
  return rows.map((r) => ({
    ...r,
    urlNorm: sql`citation_url_norm(${r.url ?? null}::text)`,
    urlHost: sql`citation_url_host(${r.url ?? null}::text)`,
    urlBaseNorm: sql`citation_url_base_norm(${r.url ?? null}::text)`,
  }));
}

// 회차 앵커 재적용 (migration 0053) — **삽입 직후 같은 트랜잭션 안에서** 돈다.
//
// 미러의 measured_at 은 회차 앵커를 가리켜야 하는데(schema.ts::scopeAnswerAnchors),
// 그 접기는 지금까지 미러 행 위에서만 이뤄졌다. run 단위 delete+insert 인 이 함수는
// scope 원본값을 다시 써넣으므로 **재싱크가 곧 접기의 소멸**이었다 — 2026-08-31
// 회수 재싱크가 18,890행을 되돌린 것이 그 실증이다(RCA §9).
//
// 그래서 접기를 "한 번 실행한 UPDATE" 가 아니라 **레지스트리 + 매 삽입 후 재적용**
// 으로 바꾼다. 이 문장이 있는 한 몇 번을 재싱크해도 앵커로 수렴한다(멱등 — 이미
// 앵커면 `<>` 술어가 0행을 잡는다).
//
// ⚠️ 날짜 산술의 정본은 **DB 함수 `scope_anchor_fold()` 하나**다. TS 로 한 벌 더
// 계산하지 않는다 — 0052 의 citation_url_norm 과 같은 이유로, 두 벌이 갈리는 순간
// "저장된 값 ≠ 재적용이 계산한 값" 이 되어 같은 답변이 싱크마다 다른 날짜를 받는다.
// 수동 접기 절차도 같은 함수를 쓴다 — docs/measured-at-anchor-registry.md.
//
// run_id 로 좁히는 이유: 방금 이 트랜잭션이 넣은 행 집합과 정확히 같고
// (`delete … where run_id = ...` 와 짝), scope_answers_run_idx 를 탄다.
export function anchorReapplySql(runId: string) {
  return sql`
    update scope_answers a
       set measured_at = scope_anchor_fold(a.measured_at, r.anchor)
      from scope_answer_anchors r
     where a.job_id = r.job_id
       and a.run_id = ${runId}::uuid
       and a.measured_at is not null
       and (a.measured_at at time zone 'UTC')::date is distinct from r.anchor
  `;
}

// 답변 드롭 재적용 (migration 0054) — **모든 삽입이 끝난 뒤 같은 트랜잭션 안에서** 돈다.
//
// 앵커 레지스트리의 쌍둥이(schema.ts::scopeAnswerDrops). 같은 주에 같은 사이트가 두 번
// 측정된 중복 회차는 접기로 해결되지 않고 **제외**해야 하는데, 미러 행을 한 번 DELETE
// 하는 것으로 끝내면 `replaceRun` 의 delete+insert 가 그 run 을 다시 훑을 때 되살아난다.
// 그래서 드롭도 레지스트리 + 매 삽입 후 재적용이다.
//
// ⚠️ 삭제 범위·순서의 정본은 **DB 함수 `scope_answer_drop_apply()` 하나**다
// (citations → mentions → answers, run 으로 좁힘). TS 로 세 테이블 delete 를 한 벌 더
// 쓰지 않는다 — 수동 드롭 절차도 같은 함수를 부르므로, 두 벌이 갈리는 순간 어느
// 경로로 지웠느냐에 따라 mentions 만 남는 식의 고아가 생긴다.
//
// 삽입 **뒤**에 도는 이유: mentions·citations 는 answers 와 별도 배열로 들어오므로
// answers 삽입 직후에 지우면 그 뒤 삽입되는 mentions·citations 가 고아로 남는다.
// run_id 로 좁히는 이유는 anchorReapplySql 과 같다(방금 넣은 행 집합과 정확히 같은 범위).
export function dropReapplySql(runId: string) {
  return sql`select scope_answer_drop_apply(${runId}::uuid)`;
}

function chunk<T>(rows: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// Run statuses scope reports as finished. Only these count as "synced" for the
// watermark — a run mirrored while still queued/running is re-pulled every pass
// until it reaches a terminal state, so the mirror can never freeze a partial
// in-flight snapshot (2026-07-02 incident: 658 runs watermarked while in-flight
// left ~25k completed answers permanently missing from the mirror).
//
// ⚠️ terminal ≠ immutable. scope's measurement_runs table has no status column —
// a run's status is DERIVED from its jobs, and the ticket model recovers jobs
// long after the run first reported failed/partial_failed (a ticket the core
// gave up on is completed by the module later, and the answer lands then).
// 2026-08-28 실증: run 79952453 was mirrored `failed` (0/10) at 12:42 KST and
// scope held 10/10 completed by 21:18 — the mirror never looked again, so the
// customer surface showed 61% failure against a true 13%.
// Hence the watermark below is conditional, not a plain status test.
const TERMINAL_RUN_STATUSES = ["completed", "failed", "partial_failed"];

// How long a terminal run stays re-checkable. 2026-08-28 실측에서 회수는 같은 날
// (실패 12~15시 → 회수 21시대)에 끝났다. 창을 넓게 잡으면 **영구 실패한 run 이
// 창 내내 매 패스 재조회되어** 싱크 시간예산(SYNC_BUDGET_MS)을 갉아먹고 뒷순번
// 프로젝트가 굶는다(2026-08-20 실측 사례와 같은 실패 모드). 3일 + 패스당 상한의
// 조합으로 회수는 잡고 예산은 지킨다.
export const RUN_RECHECK_WINDOW_DAYS = 3;

export interface MirrorWriteCapabilities {
  anchors: boolean;
  drops: boolean;
  occAvailable: boolean;
  stances: boolean;
}

/** Resolve schema support before opening the checkpoint transaction. */
export async function prepareMirrorWrite(): Promise<MirrorWriteCapabilities> {
  await ensureColumnAvailability();
  return {
    anchors: await anchorRegistryAvailable(),
    drops: await dropRegistryAvailable(),
    occAvailable: await mentionOccurrencesAvailable(),
    stances: await answerStancesAvailable(),
  };
}

/** The progress repository must hold its run lock and revision for this write. */
export async function writeMirrorChunk(
  tx: ScopeMirrorProgressTx,
  run: MirrorRun,
  answers: MirrorAnswer[],
  mentions: MirrorMention[],
  citations: MirrorCitation[],
  acrRollups: MirrorAcrRollup[],
  occurrences: MirrorMentionOccurrence[],
  stances: MirrorAnswerStance[],
  capabilities: MirrorWriteCapabilities,
  options: { append?: boolean; finalize?: boolean; reset?: boolean } = {},
): Promise<void> {
  const { anchors, drops, occAvailable, stances: stanceAvailable } = capabilities;
  const jobIds = answers.map((a) => a.jobId);
  if (jobIds.length) {
    // ⚠️ delete 도 **청크한다.** `inArray` 는 id 하나당 바인드 파라미터 하나라
    // jobIds 가 길면 postgres.js 의 파라미터 상한(65,534)을 넘겨
    // `MAX_PARAMETERS_EXCEEDED` 로 트랜잭션이 통째로 깨진다. insert 쪽은
    // 처음부터 chunk() 를 거쳤는데 delete 만 빠져 있었다 — 지금까지 안 터진
    // 것은 run 당 job 이 작아서였을 뿐이고, 대형 run 회복(MIRROR_JOB_MAX_PAGES
    // 상향)에서는 정확히 이 경로가 먼저 터진다(2026-09-13 리뷰 지적).
    for (const ids of chunk(jobIds)) {
      await tx.delete(scopeCitations).where(inArray(scopeCitations.jobId, ids));
      await tx.delete(scopeMentions).where(inArray(scopeMentions.jobId, ids));
      // 발생 미러(0061)도 job 단위 wipe. 테이블이 없는 창에서는 건너뛴다.
      if (occAvailable) {
        await tx.delete(scopeMentionOccurrences).where(inArray(scopeMentionOccurrences.jobId, ids));
      }
      if (stanceAvailable) {
        await tx.delete(scopeAnswerStances).where(inArray(scopeAnswerStances.jobId, ids));
      }
    }
  }
  if (options.reset) {
    for (const table of [scopeCitations, scopeMentions, ...(occAvailable ? [scopeMentionOccurrences] : []), ...(stanceAvailable ? [scopeAnswerStances] : [])]) {
      await tx.delete(table).where(sql`${table.jobId} IN (SELECT job_id FROM scope_answers WHERE run_id = ${run.runId}::uuid)`);
    }
  }
  if (!options.append) await tx.delete(scopeAnswers).where(eq(scopeAnswers.runId, run.runId));
  else if (jobIds.length) {
    for (const ids of chunk(jobIds)) await tx.delete(scopeAnswers).where(inArray(scopeAnswers.jobId, ids));
  }
  // ACR 롤업은 run 단위로 wipe+재삽입 (rollup은 job이 아니라 prompt-run
  // 키라서 jobIds가 아닌 runId로 지운다 — answers와 동일한 idempotent 규칙).
  if (!options.append) await tx.delete(scopeAcrRollups).where(eq(scopeAcrRollups.runId, run.runId));
  for (const c of chunk(answers)) await tx.insert(scopeAnswers).values(c);
  // 앵커 재적용은 answers 삽입 **직후**여야 한다. 뒤로 밀면 그 사이에 나가는
  // 어떤 읽기도 원본 날짜를 본다(같은 트랜잭션 안이라 외부에는 안 보이지만,
  // 순서를 규칙으로 못박아 두어야 나중에 문장이 재배치되며 조용히 깨지지 않는다).
  if (anchors && answers.length) await tx.execute(anchorReapplySql(run.runId));
  for (const c of chunk(mentions)) await tx.insert(scopeMentions).values(c);
  if (occAvailable) {
    for (const c of chunk(occurrences)) await tx.insert(scopeMentionOccurrences).values(c);
  }
  if (stanceAvailable) {
    for (const c of chunk(stances)) await tx.insert(scopeAnswerStances).values(c);
  }
  for (const c of chunk(citations))
    await tx.insert(scopeCitations).values(citationValues(c));
  for (const c of chunk(acrRollups)) await tx.insert(scopeAcrRollups).values(c);
  // 드롭 재적용은 answers·mentions·citations 삽입이 **모두 끝난 뒤**여야 한다 —
  // 앞당기면 뒤에 삽입되는 mentions·citations 가 고아로 남는다(dropReapplySql 주석).
  // ⚠️ scope_answer_drop_apply() 는 citations→mentions→answers 만 지운다 —
  // 발생 테이블(scope_mention_occurrences)은 이 DB 함수가 아직 모른다. 드롭된
  // job 의 발생 행이 고아로 남을 수 있다는 뜻이다(읽기 경로가 scope_answers 를
  // 먼저 조회하므로 화면에는 나타나지 않는다). 갱신은 별도 마이그레이션(0062)으로 미룬다.
  if (drops && answers.length) await tx.execute(dropReapplySql(run.runId));
  if (options.finalize !== false) await tx
    .insert(scopeRuns)
    .values({ ...run, syncedAt: new Date() })
    .onConflictDoUpdate({
      target: scopeRuns.runId,
      set: {
        projectId: run.projectId,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        totalJobs: run.totalJobs,
        // scope 가 아직 안 내려주면 undefined → 기존 값 유지(덮어쓰지 않는다).
        ...(run.cycleAnchorAt !== undefined ? { cycleAnchorAt: run.cycleAnchorAt } : {}),
        syncedAt: new Date(),
      },
    });
}

/** Serialize legacy writes with checkpoints even when discovery is paused. */
async function assertNoBulkWrite(tx: ScopeMirrorProgressTx, runId: string): Promise<void> {
  // The schema probe is in the same transaction as the guard. Actual DB errors
  // propagate; they must not be interpreted as "no progress table".
  const rows = await tx.execute(sql`SELECT to_regclass('public.scope_mirror_progress') AS name`);
  if (!(rows as unknown as Array<{ name: string | null }> | undefined)?.[0]?.name) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 73451))`);
  const active = await tx.select({ runId: scopeMirrorProgress.runId }).from(scopeMirrorProgress)
    .where(sql`${scopeMirrorProgress.runId} = ${runId}::uuid AND ${scopeMirrorProgress.phase} <> 'complete'`).limit(1);
  if (active.length) throw new Error("Run has unfinished bulk mirror progress");
}

export const scopeMirrorRepository = {
  // 프로젝트별 마지막 동기화 시각 — 싱크 순회의 oldest-first 로테이션 입력
  // (sync.ts::orderSyncTargets). 한 번도 동기화 안 된 프로젝트는 맵에 없다(최우선).
  async lastSyncedByProject(): Promise<Map<string, Date>> {
    const db = getDb();
    const rows = await db
      .select({
        projectId: scopeRuns.projectId,
        last: sql<Date>`max(${scopeRuns.syncedAt})`,
      })
      .from(scopeRuns)
      .groupBy(scopeRuns.projectId);
    const m = new Map<string, Date>();
    for (const r of rows) {
      if (r.projectId && r.last) m.set(r.projectId, new Date(r.last));
    }
    return m;
  },

  // 프로젝트별 마지막 **시도** 시각 (scope_sync_cursors, migration 0043) —
  // 로테이션의 진짜 정렬 키. lastSyncedByProject()는 "마지막 쓰기"라서 무작업
  // 프로젝트를 앞순번에 고착시킨다(sync.ts::orderSyncTargets 주석 참조).
  async lastAttemptByProject(): Promise<Map<string, Date>> {
    const db = getDb();
    const rows = await db
      .select({
        projectId: scopeSyncCursors.projectId,
        last: scopeSyncCursors.lastAttemptAt,
      })
      .from(scopeSyncCursors);
    const m = new Map<string, Date>();
    for (const r of rows) {
      if (r.projectId && r.last) m.set(r.projectId, new Date(r.last));
    }
    return m;
  },

  /**
   * 시도 **시작**만 표시한다 — `last_attempt_at` 만 건드리고 `last_error` 는 그대로 둔다.
   *
   * ── 왜 별도 메서드인가 (2026-09-13) ──────────────────────────────────────
   * 하드킬 대비로 커서를 작업 **전**에 찍는데(sync.ts 의 선기록), 그때
   * `recordSyncAttempt(pid, null)` 을 쓰면 `last_error` 가 NULL 로 덮인다.
   * 그러면 **그 패스가 하드킬당했을 때 직전 실패 사유가 사라진다** — 이번 사고를
   * 잡아낸 단서가 정확히 루트 커서에 남아 있던 `scope_acr_rollups` insert 실패였다.
   * 선기록이 그 단서를 지우면 같은 사고를 다음엔 못 잡는다.
   *
   * 결과(성공=NULL 로 해소 / 실패=사유 기록)는 작업이 끝난 뒤
   * `recordSyncAttempt` 가 한 번 더 덮어쓴다.
   */
  async markSyncAttemptStarted(projectId: string): Promise<void> {
    const db = getDb();
    const now = new Date();
    await db
      .insert(scopeSyncCursors)
      .values({ projectId, lastAttemptAt: now })
      .onConflictDoUpdate({
        target: scopeSyncCursors.projectId,
        // ⚠️ lastError 를 **넣지 않는다.** 넣으면 직전 진단 단서가 날아간다.
        set: { lastAttemptAt: now },
      });
  },

  // 한 프로젝트의 시도를 기록한다 — 성공·실패·무작업 모두. 이 upsert가 빠지면
  // 그 프로젝트는 다음 패스에서도 같은 앞순번을 점유해 로테이션이 멈춘다.
  // `error: null` 은 **해소**를 뜻한다(성공 시 직전 사유를 지운다) — 그래서
  // 선기록에는 이 메서드를 쓰면 안 된다. markSyncAttemptStarted 참조.
  async recordSyncAttempt(projectId: string, error: string | null): Promise<void> {
    const db = getDb();
    const now = new Date();
    await db
      .insert(scopeSyncCursors)
      .values({ projectId, lastAttemptAt: now, lastError: error })
      .onConflictDoUpdate({
        target: scopeSyncCursors.projectId,
        set: { lastAttemptAt: now, lastError: error },
      });
  },

  /**
   * Watermark input: for every terminal run already mirrored, the status we
   * recorded and whether it still holds an unresolved (non-completed) answer.
   *
   * The caller skips a run only when BOTH hold:
   *  - the status scope reports now matches what we mirrored, and
   *  - nothing about the run can still change — either every answer is already
   *    completed, or the run is older than RUN_RECHECK_WINDOW_DAYS.
   *
   * Both signals are needed. Status alone misses a partial_failed run where one
   * of two failures recovers (status stays partial_failed); "has unresolved"
   * alone misses a run whose answers were all mirrored completed but whose
   * status we stored stale. Neither costs an extra scope call — the run list is
   * fetched every pass anyway.
   */
  async mirroredRunStates(runId?: string): Promise<
    Map<
      string,
      {
        status: string | null;
        hasUnresolved: boolean;
        recheckable: boolean;
        syncedAt: Date | null;
      }
    >
  > {
    const db = getDb();
    const cutoff = new Date(Date.now() - RUN_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        runId: scopeRuns.runId,
        status: scopeRuns.status,
        // ⚠️ 컬럼 객체 보간(`${scopeAnswers.runId}`)을 쓰지 않는다 — drizzle 이 이
        // 상관 서브쿼리 안에서 **테이블 한정 없이** 렌더해 `where "run_id" = "run_id"`
        // 가 되고 쿼리 전체가 죽는다(2026-08-29 프로덕션 회귀: 모든 프로젝트 sync
        // 실패). 물리 테이블명으로 명시 한정하고, 불리언 식은 괄호로 감싼다.
        hasUnresolved: sql<boolean>`exists (
          select 1 from scope_answers a
          where a.run_id = scope_runs.run_id
            and a.status is distinct from 'completed'
        )`,
        // ⚠️ JS `Date` 를 raw sql 파라미터로 바인딩하지 않는다 — 컬럼 매퍼가 없어
        // `Wed Aug 26 2026 13:44:35 GMT+0000 (Coordinated Universal Time)` 로
        // 직렬화되고 Postgres 가 `invalid input syntax for type timestamp with
        // time zone` 으로 거절한다(2026-08-29 2차 회귀). ISO 문자열 + 명시 캐스트.
        recheckable: sql<boolean>`(scope_runs.started_at is null or scope_runs.started_at >= ${cutoff.toISOString()}::timestamptz)`,
        // 강제 재싱크 워터마크(`?resyncBefore=`)의 입력. **이 맵에 얹는** 이유는
        // 같은 행을 두 번 읽지 않기 위해서다.
        // ⚠️ "추가 쿼리 0" 은 **비-force 경로에서만** 참이다 — 그 경로는 이 맵을
        // 어차피 매 패스 조회한다. `force + resyncBefore` 는 종전에 force 가
        // **건너뛰던** 이 조회를 새로 지불한다(`loadMirroredRunStates` 참조).
        // 재싱크 캠페인은 패스를 많이 돌리는 게 목적이라 그 비용이 누적되므로,
        // 호출을 프로젝트 루프 밖으로 1회 호이스트해 상수로 묶었다.
        syncedAt: scopeRuns.syncedAt,
      })
      .from(scopeRuns)
      .where(and(inArray(scopeRuns.status, TERMINAL_RUN_STATUSES),
        runId ? eq(scopeRuns.runId, runId) : undefined));
    return new Map(
      rows.map((r) => [
        r.runId,
        {
          status: r.status,
          hasUnresolved: r.hasUnresolved,
          recheckable: r.recheckable,
          syncedAt: r.syncedAt,
        },
      ]),
    );
  },

  // Replace one run's slice of the mirror in a single transaction.
  async replaceRun(
    run: MirrorRun,
    answers: MirrorAnswer[],
    mentions: MirrorMention[],
    citations: MirrorCitation[],
    acrRollups: MirrorAcrRollup[] = [],
    occurrences: MirrorMentionOccurrence[] = [],
    // 답변 단위 브랜드 스탠스(0072). 코어가 아직 `?include=stances` 를 모르면 항상
    // 빈 배열로 온다 — 그 경우 delete 만 돌아 종전 상태가 유지된다(에러 아님).
    stances: MirrorAnswerStance[] = [],
  ): Promise<void> {
    const db = getDb();
    // 트랜잭션 **밖에서** 판정한다 — 프로브는 pg_attribute 읽기라 같은 트랜잭션에
    // 넣을 이유가 없고, 넣으면 별도 커넥션을 트랜잭션 중에 쓰게 된다.
    //
    // ⚠️ 동기 판정(citationValues → citationNormColumnsAvailable)도 여기서 확정한다.
    // 읽기 경로의 폴백은 "값이 같은 다른 식"이지만 **쓰기 폴백은 컬럼을 안 채우는 것**
    // 이라, 미확정 상태로 들어오면 그 run 의 인용이 url_norm/url_host/url_base_norm
    // NULL 로 적재된다. cron 은 콜드 프로세스로 뜨므로 그 첫 run 이 매번 여기 걸렸다
    // (라이브 실측 2026-09-10: scope_citations 3,236,313 행 중 NULL 3,629 = 0.11%).
    // 백필이 회수하긴 하지만, 애초에 안 비게 하는 것이 이 한 줄의 값이다.
    await ensureColumnAvailability();
    const anchors = await anchorRegistryAvailable();
    const drops = await dropRegistryAvailable();
    const occAvailable = await mentionOccurrencesAvailable();
    const stanceAvailable = await answerStancesAvailable();
    if (!stanceAvailable && stances.length) {
      // 테이블 없는 창(코드가 db:apply 보다 앞선 배포)에서 스탠스가 이미 오고 있다는
      // 사실만 남긴다 — 다음 재싱크가 회수하므로 실패시키지 않는다.
      console.warn(
        `[mirror] scope_answer_stances 미적용 — run=${run.runId} 스탠스 ${stances.length}행 보류(0072 적용 후 재싱크로 회수).`,
      );
    }
    await db.transaction(async (tx) => {
      await assertNoBulkWrite(tx, run.runId);
      await writeMirrorChunk(tx, run, answers, mentions, citations, acrRollups,
        occurrences, stances, { anchors, drops, occAvailable, stances: stanceAvailable });
    });
  },

  // 완전 삭제 확인 팝업의 영향 미리보기 — 이 scope 프롬프트에 쌓인 측정 이력 수.
  // mentions/citations는 answers(job_id)를 경유해서만 프롬프트에 귀속된다.
  async promptImpact(
    promptId: string,
  ): Promise<{ answers: number; mentions: number; citations: number }> {
    const db = getDb();
    const [a] = await db
      .select({ n: sql<number>`count(*)` })
      .from(scopeAnswers)
      .where(eq(scopeAnswers.promptId, promptId));
    const [m] = await db
      .select({ n: sql<number>`count(*)` })
      .from(scopeMentions)
      .innerJoin(scopeAnswers, eq(scopeAnswers.jobId, scopeMentions.jobId))
      .where(eq(scopeAnswers.promptId, promptId));
    const [c] = await db
      .select({ n: sql<number>`count(*)` })
      .from(scopeCitations)
      .innerJoin(scopeAnswers, eq(scopeAnswers.jobId, scopeCitations.jobId))
      .where(eq(scopeAnswers.promptId, promptId));
    return {
      answers: Number(a?.n ?? 0),
      mentions: Number(m?.n ?? 0),
      citations: Number(c?.n ?? 0),
    };
  },

  // 완전 삭제 캐스케이드의 미러 구간 — 한 scope 프롬프트의 이력 전량을 FK 역순
  // (mentions/citations → acr rollups → answers → prompts)으로 지운다. 호출
  // 전제: scope 쪽 측정이 먼저 중단되어 있어야 한다(아니면 다음 run이 다시
  // 채운다). scope_runs는 남긴다 — terminal 워터마크가 유지되어야 sync가 지운
  // 답변을 재수입하지 않는다(run 행 자체는 다른 프롬프트들의 슬라이스도 대표).
  async deletePromptData(promptId: string): Promise<void> {
    const db = getDb();
    const stanceAvailable = await answerStancesAvailable();
    await db.transaction(async (tx) => {
      const jobs = await tx
        .select({ jobId: scopeAnswers.jobId })
        .from(scopeAnswers)
        .where(eq(scopeAnswers.promptId, promptId));
      const jobIds = jobs.map((j) => j.jobId);
      if (jobIds.length) {
        await tx.delete(scopeMentions).where(inArray(scopeMentions.jobId, jobIds));
        await tx.delete(scopeCitations).where(inArray(scopeCitations.jobId, jobIds));
        // 스탠스(0072)도 같은 캐스케이드에 넣는다 — 빼면 프롬프트 완전 삭제 후
        // answers 없는 스탠스 행이 고아로 남는다(발생 테이블이 겪고 있는 형태).
        if (stanceAvailable) {
          await tx.delete(scopeAnswerStances).where(inArray(scopeAnswerStances.jobId, jobIds));
        }
      }
      await tx.delete(scopeAcrRollups).where(eq(scopeAcrRollups.promptId, promptId));
      await tx.delete(scopeAnswers).where(eq(scopeAnswers.promptId, promptId));
      await tx.delete(scopePrompts).where(eq(scopePrompts.promptId, promptId));
    });
  },

  async upsertPrompts(prompts: MirrorPrompt[]): Promise<void> {
    if (!prompts.length) return;
    const db = getDb();
    for (const c of chunk(prompts)) {
      await db
        .insert(scopePrompts)
        .values(c)
        .onConflictDoUpdate({
          target: scopePrompts.promptId,
          set: {
            text: sql`excluded.text`,
            funnelStage: sql`excluded.funnel_stage`,
            // 언어·시장 (migration 0048). scope 가 정본이므로 매 패스 **덮어쓴다** —
            // scope 에서 지워지면 미러도 NULL 이 돼야 한다(COALESCE 로 옛 값을
            // 붙들면 미러가 조용히 낡는다). is_korean 은 GENERATED 라 여기 없다.
            lang: sql`excluded.lang`,
            regions: sql`excluded.regions`,
          },
        });
    }
  },
};
