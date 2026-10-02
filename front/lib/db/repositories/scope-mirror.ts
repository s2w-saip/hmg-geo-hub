import "server-only";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { RUN_RECHECK_WINDOW_DAYS } from "@/lib/scope/mirror/recheck-window";
import type { ScopeMirrorProgressTx } from "./scope-mirror-progress";
import { runAnchorRefreshIsolated } from "./scope-answer-anchors";
import {
  anchorRegistryAvailable,
  answerCycleAnchorsAvailable,
  answerStancesAvailable,
  citationNormColumnsAvailable,
  dropRegistryAvailable,
  ensureColumnAvailability,
  mentionOccurrencesAvailable,
  syncWatermarksAvailable,
} from "@/lib/db/column-availability";
// 글로벌 루트 프로젝트 id 의 **정본**. 여기서 env 를 다시 읽지 않는다(사본 금지) —
// 0077 의 표면 판정이 모든 writer 와 같은 값을 봐야 'standard' 가 갈리지 않는다(B4·N-4).
import { resolveAnchorRootProjectId } from "@/lib/scope/anchor-root";

/**
 * 미러 동기화 경로의 루트 id 해소 (N-14).
 *
 * env 가 **설정돼 있는데 형식이 틀리면** 싱크를 죽이지 않는다(싱크가 멈추면 미러
 * 전체가 뒤처진다). 대신 **앵커 재계산만 건너뛰고** 표식을 남긴다 — 잘못된 표면으로
 * 행을 기록하는 것보다 그 창에 행을 안 만드는 쪽이 낫고, env 를 고친 뒤 재싱크나
 * 백필이 회수한다. env 미설정(`unset`)은 종전 그대로 null 폴백이다.
 */
function anchorRootForMirror(): { projectId: string | null; usable: boolean } {
  const r = resolveAnchorRootProjectId();
  if (r.kind === "malformed") {
    console.error(
      "[mirror] SCOPE_ROOT_PROJECT_ID 가 uuid 형식이 아니다 — 이 싱크에서 회차 앵커 재계산을 건너뛴다(표면 오분류 방지). env 를 고친 뒤 재싱크·백필이 회수한다.",
    );
    return { projectId: null, usable: false };
  }
  return { projectId: r.projectId, usable: true };
}
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
  scopeSyncWatermarks,
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

// 답변 단위 회차 앵커 재계산 (migration 0077) — **같은 트랜잭션의 맨 마지막**
// (`scope_runs` upsert 뒤. 이유는 `writeMirrorChunk` 말미 주석).
//
// 0053 이 `measured_at` 을 물리적으로 접는다면, 이것은 접지 않고 **앵커를 따로 적는다**.
// 그래서 기간 술어가 `measured_at` 의 두 의미(측정 시각 / 접힌 앵커)에 기대지 않아도 된다.
//
// ⚠️ 산술·우선순위(registry → ledger → run → fallback_measured)의 정본은 **DB 함수
// `refresh_answer_cycle_anchors()` 하나**다. TS 로 한 벌 더 계산하지 않는다 — 0052
// citation_url_norm·0053 scope_anchor_fold 와 같은 이유로, 두 벌이 갈리는 순간 같은
// 답변이 싱크 경로마다 다른 회차 날짜를 받는다. 백필 스크립트도 같은 함수를 부른다.
//
// run 단위로 좁히는 이유는 `anchorReapplySql` 과 같다 — 방금 이 트랜잭션이 넣은 행
// 집합과 정확히 같고(`delete … where run_id = …` 와 짝), `scope_answers_run_idx` 를 탄다.
// 멱등: 값이 안 바뀐 행은 `ON CONFLICT … WHERE … IS DISTINCT FROM` 가드가 0행으로 막는다.
//
// ⚠️ **hot path 다** — 드레인 중에는 한 회차의 run 이 차례로 들어오고(실측 최대 1,304개
// · 답변 56,383건) 이 호출이 그때마다 싱크 트랜잭션 안에서 돈다. 0077 은 매번 회차 전체를
// 다시 조인·집계했고, 0078 이 그것을 **회차 해소 결과가 달라졌을 때만**으로 바꿨다
// (평소 호출의 작업량 = 이 run 의 답변 수 + 회차 수준 조회). 여기서 run 을 묶어 넘기거나
// 회차 단위로 바꾸지 말 것 — 좁은 경로의 전제가 "받은 run = 방금 쓴 run" 이다.
//
// 두 번째 인자 = **글로벌(표준) 루트 프로젝트 id**(B4). DB 함수는 앱의 env 를 읽을 수
// 없으므로 호출부가 `anchorRootProjectId()` 를 넘긴다 — 넘기지 않으면 표면 판정이
// "원장에 global 회차가 이미 있는가" 폴백으로 떨어지고, 원장이 아직 그 프로젝트의
// 회차를 열지 않은 창에서 글로벌 답변이 'project' 로 분류돼 노출 게이트를 우회한다.
export function answerCycleAnchorRefreshSql(runId: string, rootProjectId: string | null) {
  return sql`select refresh_answer_cycle_anchors(array[${runId}::uuid], ${rootProjectId}::uuid)`;
}

// ACR 롤업 upsert 의 DO UPDATE 절 — PK 두 컬럼을 뺀 **전 컬럼**을 excluded 로 덮는다
// (measured_at 포함 — 그 run 에서 본 job measured_at, 즉 마지막 writer 의 값. 미러에
// 이미 있던 날짜와 섞지 않는다: 섞으면 코어 정정을 못 따라가는 래칫이 된다).
// 컬럼 목록을 손으로 적지 않는 이유: 스키마에 컬럼이 추가될 때 여기만 빠지면
// 동시 쓰기에서 그 컬럼만 옛 값으로 남는 조용한 불일치가 된다.
const ACR_ROLLUP_CONFLICT_SET = Object.fromEntries(
  Object.entries(getTableColumns(scopeAcrRollups))
    .filter(([key]) => key !== "promptRunId" && key !== "entityId")
    .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
);

/**
 * ACR 동시 경합 잔여 정리 술어 — 청크의 prompt_run 중 이번 배치 행에 없는
 * (prompt_run_id, entity_id). `inArray` 로 prompt_run 을 먼저 좁혀 pkey 선두 컬럼을
 * 타게 한다(jsonb 조인만으로 좁히면 통계가 없을 때 전체 Seq Scan + Hash Join 으로 계획됐다).
 * `pairs` = `[[prompt_run_id, entity_id], …]` JSON 한 값(바인드 파라미터 상한 회피).
 */
export function acrResidualWhere(ids: string[], pairs: string) {
  return and(
    inArray(scopeAcrRollups.promptRunId, ids),
    sql`NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${pairs}::jsonb) k
       WHERE (k->>0)::uuid = ${scopeAcrRollups.promptRunId}
         AND (k->>1)::uuid = ${scopeAcrRollups.entityId}
    )`,
  );
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
// 값은 리프 모듈이 정본이다(미러 싱크의 floor 판정과 공유) — 여기서는 re-export 만.
export { RUN_RECHECK_WINDOW_DAYS };

export interface MirrorWriteCapabilities {
  anchors: boolean;
  drops: boolean;
  occAvailable: boolean;
  stances: boolean;
  /** 0077 — 답변 단위 회차 앵커 전수 테이블(`scope_answer_cycle_anchors`). */
  cycleAnchors: boolean;
  /**
   * 0077 표면 판정의 'standard' 근거 — 글로벌(표준) 루트 프로젝트 id(B4).
   * 앱이 쓰는 정본(`lib/scope/anchor-root.ts::anchorRootProjectId`)과 **같은 값**이다.
   * mock 모드·env 미설정이면 null 이고, 그때 DB 함수는 원장 출력 폴백 + NOTICE 다.
   */
  rootProjectId: string | null;
}

/** Resolve schema support before opening the checkpoint transaction. */
export async function prepareMirrorWrite(): Promise<MirrorWriteCapabilities> {
  await ensureColumnAvailability();
  return {
    anchors: await anchorRegistryAvailable(),
    drops: await dropRegistryAvailable(),
    occAvailable: await mentionOccurrencesAvailable(),
    stances: await answerStancesAvailable(),
    cycleAnchors: (await answerCycleAnchorsAvailable()) && anchorRootForMirror().usable,
    rootProjectId: anchorRootForMirror().projectId,
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
  const { anchors, drops, occAvailable, stances: stanceAvailable, cycleAnchors, rootProjectId } =
    capabilities;
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
  // 다른 run 에 걸친 prompt_run 은 insert 직전의 prompt_run 단위 delete 가 맡는다.
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
  // ⚠️ 롤업은 **prompt_run 단위로도** 교체한다(2026-09-28 루트 싱크 23505 정지).
  // ACR prompt_run 의 반복 중 실패분이 manual run 으로 재측정되면 한 prompt_run 이
  // 여러 run 에 걸친다(코어 실측: 9/21 회차 3,131 중 262). 위의 runId delete 는
  // **다른 run 이 쥔 같은 prompt_run 행**을 못 지우므로 PK(prompt_run_id, entity_id)
  // 23505 → run 트랜잭션 통째 롤백 → 워터마크 미생성 → 그 프로젝트 싱크 영구 정지였다.
  // scope 는 같은 prompt_run 의 모든 job 에 prompt_run 전체 기준 acr_summary 를 주므로
  // (sync.ts collectAcrPromptRuns) 나중에 쓴 run 의 스냅샷이 이기는 것이 의미상 맞다.
  // append(대량/슬라이스 ACR 청크)에서도 같은 충돌이 나므로 append 여부와 무관하게 돈다.
  // delete 청크 이유는 위 jobIds delete 와 같다(바인드 파라미터 상한).
  const promptRunIds = [...new Set(acrRollups.map((r) => r.promptRunId))];
  for (const ids of chunk(promptRunIds)) {
    await tx.delete(scopeAcrRollups).where(inArray(scopeAcrRollups.promptRunId, ids));
  }
  // 날짜: 롤업 measured_at 은 **종전대로 그 run 에서 본 job measured_at**(마지막 writer).
  // ⚠️ 알려진 한계 — 여러 run 에 걸친 prompt_run 은 싱크 순서에 따라 measured_at 이
  // 원 run / 재측정 run 의 job 시각 사이에서 바뀔 수 있다. 코어 실측(2026-09-28, 루트
  // 30일): 걸친 prompt_run 693개 모두 같은 회차 앵커 안(회차 간 0) — 영향은 같은 회차
  // 안의 기간 경계·일 버킷에 한정된다. ⚠️ "회차 간 0" 은 **코드 가드가 아니라 그날의
  // 코어 실측**이다 — 회차를 넘긴 재측정이 생기면 날짜가 회차 사이를 오갈 수 있다.
  // 근본 조치 = 롤업에 cycle_anchor_at 컬럼을 추가해 기간·버킷은 앵커, 최신 선택은
  // measured_at 으로 분리(마이그레이션, 별건).
  // 같은 이유로 run_id 도 마지막 writer 를 따른다 — run_id 로 롤업을 찾는 곳은 소유
  // run 을 따라 옮겨간다: QA 콘솔 답변 화면의 ACR 블록(qa-review.ts 의 `run_id =
  // <답변의 run>` 4축 근사 연결)은 prompt_run 을 재측정 run 이 가져가면 원 run 답변에서
  // 비고 재측정 run 답변에 뜬다. 추이의 숨김 회차 제외(excludeHiddenCycleRuns(x.run_id))도 같다.
  // 기각한 대안(같은 날 검증): ① 기존 행과 LEAST 로 고정 — 소유 run 재싱크 시 풀리고,
  // 코어 날짜 정정을 못 따라가는 래칫. ② measured_at 을 run 회차 앵커로 치환 — 같은 셀·
  // 같은 앵커의 prompt_run 이 2개 이상인 셀이 16,793 중 838(5%)이라 셀별 최신 선택
  // (DISTINCT ON … measured_at DESC)이 동률로 비결정적이 된다.
  const rollupRows = acrRollups;
  // 동시 쓰기(A1): 두 트랜잭션이 같은 prompt_run 을 동시에 쓰면 READ COMMITTED 에서
  // 각자의 delete 가 상대의 미커밋 insert 를 못 보므로, 늦게 insert 하는 쪽이 여전히
  // 23505 로 죽는다. ON CONFLICT 로 흡수한다 — 전 컬럼·run_id 모두 나중 writer.
  for (const c of chunk(rollupRows))
    await tx.insert(scopeAcrRollups).values(c).onConflictDoUpdate({
      target: [scopeAcrRollups.promptRunId, scopeAcrRollups.entityId],
      set: ACR_ROLLUP_CONFLICT_SET,
    });
  // 동시 경합 잔여 정리(A1): 위 delete 가 못 본 상대 스냅샷 전용 엔티티 행이 남으면
  // 한 prompt_run 이 두 run_id·두 날짜로 갈린다. upsert 직후 같은 tx 에서 이번 배치의
  // prompt_run 중 **이번 배치 행에 없는** (prompt_run_id, entity_id) 를 지운다.
  // 파라미터 상한 때문에 쌍 목록은 jsonb 한 값으로 넘긴다(prompt_run 청크 단위).
  // 순차 경로에서는 위 prompt_run delete 가 이미 비웠으므로 **항상 0행** — 순수 오버헤드라
  // prompt_run IN 술어로 pkey(prompt_run_id 선두)를 타게 한다(acrResidualWhere).
  if (promptRunIds.length) {
    const entitiesByPr = new Map<string, string[]>();
    for (const r of rollupRows) {
      const list = entitiesByPr.get(r.promptRunId);
      if (list) list.push(r.entityId);
      else entitiesByPr.set(r.promptRunId, [r.entityId]);
    }
    for (const ids of chunk(promptRunIds)) {
      const pairs = JSON.stringify(ids.flatMap((id) => (entitiesByPr.get(id) ?? []).map((e) => [id, e])));
      await tx.delete(scopeAcrRollups).where(acrResidualWhere(ids, pairs));
    }
  }
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

  // ── 회차 앵커 전수 테이블(0077) 재계산 — **맨 마지막** ──────────────────────
  //
  // ⚠️ `scope_runs` upsert **뒤**여야 한다. 이 재계산은 `JOIN scope_runs r` 로
  // `r.project_id`(표면 판정)와 `r.cycle_anchor_at`(우선순위 3) 를 읽는데,
  //   · 처음 미러되는 run 은 위 upsert 전에는 `scope_runs` 에 **행이 아예 없다**
  //     (scope_answers.run_id 에 FK 가 없어 삽입은 성공한다) → INNER JOIN 이
  //     전부 떨어져 그 run 의 앵커 행이 **한 줄도 안 생긴다.**
  //   · 이미 있는 run 이라도 이번 싱크가 `cycle_anchor_at` 을 갱신하면, 앞에서
  //     부를 경우 **옛 앵커**를 읽는다.
  // 드롭 재적용(`dropReapplySql`)보다도 뒤라, 드롭된 job 은 이 시점에 이미
  // `scope_answers` 에서 빠져 있어 앵커 행이 새로 생기지 않는다.
  //
  // ⚠️ **run 당 한 번만** 부른다(B11). 이 함수는 청크가 아니라 `run_id = ANY($1)` 로
  // run 전체를 다시 훑으므로, 청크마다 부르면 같은 run 을 페이지 수만큼 재계산한다
  // (대량 run 은 페이지 50개 = 50회). 판정:
  //   · `replaceRun` — `finalize` 를 넘기지 않는다(undefined). 단발 호출이라 이
  //     호출이 곧 run 전체다 → **답변이 0건이어도** 한 번 돈다(N-3).
  //     `!options.append` 경로가 바로 위에서 그 run 의 `scope_answers` 를 전부 지우므로,
  //     0건 재동기화는 "답변이 사라진 run" 이다. 재계산을 건너뛰면 그 run 의 낡은 앵커
  //     행이 남고 B8 삭제도 안 돈다 — 감사 ⑥/⑦ 이 사후에 표면화할 뿐이었다.
  //   · 대량 미러(`bulk-run.ts`) — 적재 청크는 **전부** `finalize:false`(첫 페이지는
  //     `append:false, reset:true` 라 append 로는 가릴 수 없다) → 건너뛴다.
  //     verify 단계의 `finalize:true`(빈 배열) 한 번에서만 돈다.
  //
  // 판정 신호를 `finalize` 로 잡은 것은 위 `scope_runs` upsert 와 **같은 신호**이기
  // 때문이다 — 재계산은 그 upsert 가 도는 패스에서만 돌아야 한다(JOIN 의존).
  const isRunFinalPass = options.finalize !== false;
  if (cycleAnchors && isRunFinalPass) {
    // **savepoint 로 격리한다**(검증 D3). 이 전파가 던지면 종전에는 그 run 의 미러
    // 싱크가 통째로 롤백됐다 — 앵커 재계산 실패가 답변·언급·인용·ACR 적재를 함께
    // 잃게 만드는 형태다. 축은 옵트인이라 앵커 행이 없어도 화면은 종전 축으로 돈다.
    // 누락 회수 경로는 `runAnchorRefreshIsolated` 머리 주석 참조(감사 ⑥/⑦ + 재호출).
    await runAnchorRefreshIsolated(
      tx,
      "mirror-sync",
      run.runId,
      answerCycleAnchorRefreshSql(run.runId, rootProjectId),
    );
  }
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
   * 증분 읽기 워터마크 전량 (scope_sync_watermarks, migration 0082).
   *
   * **`null` = 기능 비활성**(표 미적용). 빈 맵과 구분한다 — 빈 맵은 "표는 있는데 아직
   * 아무 프로젝트도 워터마크가 없다"(첫 패스)이고, 그때는 전량 읽기 후 워터마크를
   * **세운다.** null 이면 읽지도 쓰지도 않는다(종전 동작). 판정 규칙은
   * lib/scope/mirror/sync.ts 의 planPromptRead · computeRunFloor.
   *
   * 행 수 = 싱크 대상 프로젝트 수(~200)라 패스당 1회 전량 조회로 충분하다.
   */
  async syncWatermarks(): Promise<Map<
    string,
    {
      promptsSyncedThrough: Date | null;
      promptsResume: { cursor: string; from: Date | null; startedAt: Date } | null;
      runsFloorRunIds: string[] | null;
      runsFloorSnapshotAt: Date | null;
    }
  > | null> {
    if (!(await syncWatermarksAvailable())) return null;
    const db = getDb();
    const rows = await db
      .select({
        projectId: scopeSyncWatermarks.projectId,
        promptsSyncedThrough: scopeSyncWatermarks.promptsSyncedThrough,
        resumeCursor: scopeSyncWatermarks.promptsResumeCursor,
        resumeFrom: scopeSyncWatermarks.promptsResumeFrom,
        resumeStartedAt: scopeSyncWatermarks.promptsResumeStartedAt,
        runsFloorRunIds: scopeSyncWatermarks.runsFloorRunIds,
        runsFloorSnapshotAt: scopeSyncWatermarks.runsFloorSnapshotAt,
      })
      .from(scopeSyncWatermarks);
    const d = (v: Date | string | null) => (v ? new Date(v) : null);
    return new Map(
      rows.map((r) => [
        r.projectId,
        {
          promptsSyncedThrough: d(r.promptsSyncedThrough),
          // 셋이 한 묶음 — 커서와 창 시작 시각이 둘 다 있어야 이어 읽기가 성립한다.
          promptsResume:
            r.resumeCursor && r.resumeStartedAt
              ? { cursor: r.resumeCursor, from: d(r.resumeFrom), startedAt: new Date(r.resumeStartedAt) }
              : null,
          runsFloorRunIds: r.runsFloorRunIds?.length ? r.runsFloorRunIds : null,
          runsFloorSnapshotAt: d(r.runsFloorSnapshotAt),
        },
      ]),
    );
  },

  /**
   * 프롬프트 창을 **끝까지** 읽었다 — 워터마크 전진 + 이어 읽기 상태 비움.
   *
   * 워터마크는 **단조**다(`GREATEST(기존, 새 값)`). 크론과 전체 대조가 겹쳐 돌면 늦게 끝난
   * 쪽이 더 이른 시각을 들고 올 수 있는데, 앞선 쪽의 전진을 되돌릴 이유가 없다.
   * 이어 읽기 상태를 함께 비우는 이유: 끝까지 읽은 창은 그 상태가 가리키던 창을 포함하거나
   * (같은 창의 마지막 조각) 그보다 넓다(전체 대조의 전량 읽기) — sync.ts planPromptRead 주석.
   * 호출부는 upsertPrompts 가 **성공한 뒤에만** 부른다.
   */
  async recordPromptWatermark(projectId: string, syncedThrough: Date): Promise<void> {
    const db = getDb();
    const through = syncedThrough.toISOString();
    const cleared = { promptsResumeCursor: null, promptsResumeFrom: null, promptsResumeStartedAt: null };
    await db
      .insert(scopeSyncWatermarks)
      .values({ projectId, promptsSyncedThrough: syncedThrough, ...cleared, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: scopeSyncWatermarks.projectId,
        set: {
          // ⚠️ JS Date 를 raw sql 에 직접 바인딩하지 않는다 — ISO + 명시 캐스트
          // (mirroredRunStates 의 2026-08-29 2차 회귀 주석과 같은 이유).
          promptsSyncedThrough: sql`GREATEST(${scopeSyncWatermarks.promptsSyncedThrough}, ${through}::timestamptz)`,
          ...cleared,
          updatedAt: new Date(),
        },
      });
  },

  /**
   * 프롬프트 창을 한 틱 상한에서 끊었다 — 다음 틱이 이어 읽을 지점을 남긴다.
   * 워터마크는 건드리지 않는다(창을 다 읽기 전에는 "여기까지 읽었다"가 거짓이다).
   */
  async recordPromptResume(
    projectId: string,
    resume: { cursor: string; from: Date | null; startedAt: Date },
  ): Promise<void> {
    const db = getDb();
    const set = {
      promptsResumeCursor: resume.cursor,
      promptsResumeFrom: resume.from,
      promptsResumeStartedAt: resume.startedAt,
      updatedAt: new Date(),
    };
    await db
      .insert(scopeSyncWatermarks)
      .values({ projectId, ...set })
      .onConflictDoUpdate({ target: scopeSyncWatermarks.projectId, set });
  },

  /** 이어 읽기 상태만 비운다(커서가 더는 유효하지 않을 때 — 다음 틱은 워터마크 창부터). */
  async clearPromptResume(projectId: string): Promise<void> {
    const db = getDb();
    await db
      .update(scopeSyncWatermarks)
      .set({ promptsResumeCursor: null, promptsResumeFrom: null, promptsResumeStartedAt: null, updatedAt: new Date() })
      .where(eq(scopeSyncWatermarks.projectId, projectId));
  },

  /**
   * run 목록 정착 경계(floor 앵커) 기록 — **더 새 스냅샷일 때만** 덮어쓴다.
   *
   * floor 는 단조가 아니다(오래된 run 이 다시 열리면 내려가야 한다). 그래서 "마지막 쓰기 승"
   * 이었는데, 그러면 목록을 **먼저** 읽고 **늦게** 끝난 긴 패스(전체 대조)가 그 사이 크론이
   * 붙잡아 둔 floor 를 자기의 낡은 목록 기준으로 올려 버린다(검증 V3 재현). 비교 기준은
   * 각 패스의 **목록 읽기 시작 시각**이다 — 더 늦게 목록을 본 쪽이 더 새 사실을 안다.
   * 값이 바뀌지 않아도 호출부는 매 패스 쓴다(스냅샷 시각을 갱신해야 낡은 쓰기를 막는다).
   * `floorRunIds = null` 은 "조기 종료 금지"(다음 패스는 목록 전량)다.
   */
  async recordRunFloor(
    projectId: string,
    floorRunIds: string[] | null,
    snapshotAt: Date,
  ): Promise<boolean> {
    const db = getDb();
    const snap = snapshotAt.toISOString();
    const rows = await db
      .insert(scopeSyncWatermarks)
      .values({ projectId, runsFloorRunIds: floorRunIds, runsFloorSnapshotAt: snapshotAt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: scopeSyncWatermarks.projectId,
        set: { runsFloorRunIds: floorRunIds, runsFloorSnapshotAt: snapshotAt, updatedAt: new Date() },
        setWhere: sql`${scopeSyncWatermarks.runsFloorSnapshotAt} IS NULL OR ${scopeSyncWatermarks.runsFloorSnapshotAt} < ${snap}::timestamptz`,
      })
      .returning({ projectId: scopeSyncWatermarks.projectId });
    return rows.length > 0;
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
    const anchorRoot = anchorRootForMirror();
    const cycleAnchors = (await answerCycleAnchorsAvailable()) && anchorRoot.usable;
    const rootProjectId = anchorRoot.projectId;
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
        occurrences, stances,
        { anchors, drops, occAvailable, stances: stanceAvailable, cycleAnchors, rootProjectId });
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
