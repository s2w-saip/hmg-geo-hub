/**
 * 생성기 코어 — generation 스왑(§7-1 원자 전환 + §7-3 낙관 검사)과 옛 generation 정리.
 *
 * 두 표면이 문자 그대로 같은 스왑을 쓴다. 여기 한 벌만 두는 이유가 그것이다 —
 * 스왑은 "화면이 어느 generation 을 보는가" 를 바꾸는 유일한 지점이라 두 벌이면 위험하다.
 */
import { sql, type SQL } from "drizzle-orm";
import { bulkGenerationDrift } from "@/lib/db/repositories/scope-mirror-bulk-cycles";
// 원장 → 앵커 테이블 전파(스펙 §4 · B2). `view_anchor_at` 을 쓰는 곳은 이 파일뿐이다.
import {
  answerCycleAnchorsWritable,
  refreshAnchorsForCycleSql,
  runAnchorRefreshIsolated,
} from "@/lib/db/repositories/scope-answer-anchors";
// 표면 판정의 'standard' 근거(B4·N-4) — 해소 정본 한 곳을 읽어 DB 함수에 넘긴다.
import { anchorRootProjectIdOrThrow } from "@/lib/scope/anchor-root";
import type { GeneratorRuntime } from "./context";
import { num } from "./context";
import type { FoldBatch } from "./fold";
import {
  DETAIL_TABLES,
  VIEW_ANCHOR_DELAY,
  type GenerationKeys,
  type SummarySurface,
} from "./types";

/**
 * tx1 스냅샷 이후 미러가 움직였는지 본다.
 *
 * `FOR SHARE` 는 집계와 함께 못 쓴다 → 잠금은 평 SELECT(CTE)에서 잡고 비교만 바깥에서.
 * 잠금이 스왑 커밋까지 `replaceRun` 의 `scope_runs` upsert 를 막아 검사·전환 사이 창을 닫는다.
 */
export function driftCheckSql(cycleId: string): SQL {
  return sql`
        WITH locked AS (
          SELECT r.run_id, r.synced_at FROM scope_runs r
          WHERE r.run_id IN (SELECT run_id FROM summary_cycle_runs WHERE cycle_id = ${cycleId}::uuid)
          FOR SHARE
        )
        SELECT count(*)::int AS drift
        FROM locked l JOIN summary_cycle_runs cr ON cr.run_id = l.run_id
        WHERE cr.cycle_id = ${cycleId}::uuid AND l.synced_at IS DISTINCT FROM cr.synced_at_seen
      `;
}

export function retireOtherGenerationsSql(cycleId: string, generationId: string): SQL {
  return sql`
        UPDATE summary_generations SET status = 'retired'
        WHERE cycle_id = ${cycleId}::uuid AND generation_id <> ${generationId}::uuid AND status <> 'failed'
      `;
}

export function activateGenerationSql(generationId: string): SQL {
  return sql`
        UPDATE summary_generations SET status = 'active', finished_at = now()
        WHERE generation_id = ${generationId}::uuid
      `;
}

/**
 * 노출 지연(V-1) 표면 상수 — **정의는 `./types` 한 곳**이고 여기서는 재수출만 한다.
 * 미러 폴백 리더(`scope-aggregates.ts::excludeHiddenCycleRuns`)가 같은 상수를 읽어야 하는데
 * `swap.ts` 를 직접 import 하면 `swap → context → scope-aggregates` 런타임 순환이 생긴다.
 * 상세 근거는 `types.ts::VIEW_ANCHOR_DELAY` 머리 주석.
 */
export { VIEW_ANCHOR_DELAY } from "./types";

/**
 * 회차를 노출로 전환한다.
 *
 * ⚠️ 뷰 앵커 규칙 **V-1**(제품 확정 2026-09-10):
 * `view_anchor_at = GREATEST(cycle_anchor_at + 표면 지연, 첫 스왑 시각)`.
 * 세 시각의 의미가 서로 다르다 — `measured_at` = 측정 **시작** 시각,
 * `cycle_anchor_at` = 고객이 기대하는 **측정일**, `view_anchor_at` = 고객이 기대하는
 * **값이 보이는 날짜**(= 서빙 허용 시점). 읽기 게이트(V-2)가 이 값을 `<= now()` 로 본다
 * (`lib/db/repositories/summary-cycles.ts::cycleViewableSql`).
 *
 * ⚠️ `COALESCE(view_anchor_at, …)` — **노출일은 첫 스왑에서만 정한다.**
 * 종전 구현은 `= now()` 라 재생성할 때마다 노출일이 그날로 밀렸다(설계 v4.1 §7-1 은 처음부터
 * COALESCE 다 — 구현이 어긋나 있었다). `cycle_anchor_at`(회차를 연 날)과 `view_anchor_at`
 * (노출 시작)의 분리가 P3 의 전제라, 밀리면 화면의 "측정 기준일" 이 재생성일로 바뀐다.
 * 웹사이트 표면에 retired generation 이 609개(재생성 다수) 있으므로 소급 영향은 별도 확인 대상.
 *
 * `GREATEST` 의 두 번째 항이 `now()` 인 이유: 지연이 이미 지난 회차(늦게 생성된 과거 회차)를
 * **과거 시각으로 찍어 즉시 노출**하기 위해서다. 그것이 오늘의 동작이고, 라이브 96회차가
 * 전부 `<= now()` 인 이유이기도 하다.
 */
export function publishCycleSql(
  cycleId: string,
  generationId: string,
  surface: SummarySurface,
): SQL {
  // interval 리터럴은 표면 상수(위 표)에서만 온다 — 사용자 입력 경로가 없다.
  const delay = sql.raw(`interval '${VIEW_ANCHOR_DELAY[surface]}'`);
  return sql`
        UPDATE summary_cycles SET active_generation_id = ${generationId}::uuid,
          view_anchor_at = COALESCE(view_anchor_at, GREATEST(cycle_anchor_at + ${delay}, now())),
          status = 'published', stale_since = NULL
        WHERE cycle_id = ${cycleId}::uuid
      `;
}

/** 스왑이 지문 불일치로 접혔을 때의 실패 마킹 — 사유가 리터럴이라 별도 문장이다. */
export function markDriftFailedSql(generationId: string): SQL {
  return sql`
        UPDATE summary_generations SET status = 'failed', finished_at = now(),
          error = 'synced_at drift between tx1 snapshot and swap'
        WHERE generation_id = ${generationId}::uuid
      `;
}

/** 옛 generation 세부층 정리(§7-1 — 커밋 후, 급하지 않음). */
export function purgeOldGenerationRowsSql(keys: GenerationKeys): SQL[] {
  return DETAIL_TABLES.map(
    (t) => sql`
        DELETE FROM ${sql.raw(t)}
        WHERE cycle_week = ${keys.cycleWeek}::date AND cycle_id = ${keys.cycleId}::uuid
          AND generation_id <> ${keys.generationId}::uuid
      `,
  );
}

/**
 * 스왑에 얹는 집계층 접기(PR② T2). `fold.ts::foldBatches` 가 만든다.
 *
 * 왜 스왑 tx 안인가: 집계층은 파티션이 아니라 실패해도 자동으로 치워지지 않는다. 스왑
 * 밖에서 넣으면 스왑이 접혔을 때(지문 drift·오류) **어느 generation 것도 아닌 집계층 행**이
 * 남고, 다음 리더가 그것을 읽는다. 한 tx 로 묶으면 롤백이 그 창을 아예 없앤다
 * (T2 수용 기준 ⑤). 대가는 `driftCheckSql` 의 `FOR SHARE` 가 접기 소요만큼 길게 잡혀
 * 그 회차 run 의 미러 upsert(`replaceRun`)를 막는 것이다 — 접기 소요(§8 M5)가 곧 그 창이다.
 */
export type FoldPlan = {
  batches: FoldBatch[];
  /** 스왑 tx 의 `SET LOCAL statement_timeout`. 접기가 DB 기본값에 잘리지 않게 명시한다. */
  statementTimeout?: string;
  /** 스왑 tx 의 `SET LOCAL work_mem`. 근거는 `fold.ts::FOLD_WORK_MEM` 주석(정렬 스필 실측). */
  workMem?: string;
};

/**
 * 스왑 tx 한 벌 — 지문이 어긋나면 아무것도 바꾸지 않고 `false`.
 * 호출부는 `false` 를 받으면 `markDriftFailedSql` 로 generation 을 접는다.
 *
 * 순서: (GUC) → drift 검사 → retire → **접기** → activate → publish.
 * 접기를 retire 뒤에 두는 것은 플랜 §5-1("옛 generation 정리 DELETE 를
 * `retireOtherGenerationsSql` 뒤에")을 그대로 따른 것이다.
 */
export async function swapGeneration(
  rt: Pick<GeneratorRuntime, "db" | "time">,
  cycleId: string,
  generationId: string,
  surface: SummarySurface,
  fold?: FoldPlan,
): Promise<boolean> {
  // 프로브는 트랜잭션 **밖에서** 확정한다(column-availability 계약 ①).
  // 0077 미적용 배포에서는 false 가 되어 스왑이 종전과 바이트 동일하게 돈다.
  const anchorsWritable = await answerCycleAnchorsWritable();
  // ⚠️ 루트 해소는 **쓸 때만** 부른다(검증 D13). 종전에는 `anchorsWritable` 과 무관하게
  //    무조건 평가해서, `SCOPE_ROOT_PROJECT_ID` 가 형식 오류면 **0077 미적용 환경에서도**
  //    요약 생성이 죽었다(종전에는 안 죽던 경로다). 그 throw 도 아래 격리 안이 아니라
  //    여기서 막는 것이 맞다 — 격리는 트랜잭션 안의 DB 실패용이고, 이건 env 문제라
  //    쓰기를 아예 시작하지 않는 것이 정답이다.
  const rootProjectId = anchorsWritable ? anchorRootProjectIdOrThrow() : null;
  return rt.db.transaction(async (tx) => {
    if (fold?.statementTimeout) {
      await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${fold.statementTimeout}'`)}`);
    }
    if (fold?.workMem) {
      await tx.execute(sql`SET LOCAL work_mem = ${sql.raw(`'${fold.workMem}'`)}`);
    }
    if (await bulkGenerationDrift(tx, cycleId, generationId)) return false;
    const drift = (await tx.execute(driftCheckSql(cycleId))) as unknown as Array<{
      drift: number;
    }>;
    if (num(drift[0]?.drift) > 0) return false;
    await tx.execute(retireOtherGenerationsSql(cycleId, generationId));
    for (const batch of fold?.batches ?? []) {
      await rt.time(batch.key, async () => {
        for (const stmt of batch.statements) await tx.execute(stmt);
      });
    }
    await tx.execute(activateGenerationSql(generationId));
    await tx.execute(publishCycleSql(cycleId, generationId, surface));
    // ── 원장 → 앵커 테이블 전파 (스펙 §4 · B2) ─────────────────────────────
    // `view_anchor_at` 을 쓰는 코드 경로는 리포 전체에서 이 한 줄뿐이다. 그래서
    // 앵커 테이블의 `view_anchor_date` 가 움직이는 시점도 정확히 여기다 — 전파가
    // 없으면 회차를 발행해도 그 run 이 우연히 재싱크될 때까지 NULL(비노출)로 남는다.
    // **같은 트랜잭션**이라 스왑이 접히면 전파도 함께 없던 일이 된다.
    // **savepoint 로 격리한다**(검증 D2·D3). 이 호출은 회차의 run 을 **전부** 넘기므로
    // 0078 판정이 사실상 항상 "회차 전체 확장"이다(최대 회차 run 1,348 · 답변 약 5.6만).
    // 메인 실측: 회차 전체 refresh 1,481ms · run 1개 25ms — 시간 위험 자체는 낮아서
    // 호출 범위는 그대로 두고 격리만 한다. 격리가 없으면 `fold.statementTimeout` 을
    // 공유하는 이 문장이 상한에 걸릴 때 **회차 발행 전체가 롤백**된다.
    //
    // 격리로 잃는 것: "스왑이 접히면 전파도 함께 없던 일이 된다" 는 대칭성. 되찾는
    // 경로는 감사(`view_anchor_drift` 긴급)와 재호출이다 — 전파만 빠진 회차는
    // `view_anchor_date` 가 NULL(비노출)로 남으므로 **틀린 값이 아니라 안 보이는 값**이다.
    if (anchorsWritable) {
      await runAnchorRefreshIsolated(
        tx,
        "cycle-publish",
        cycleId,
        refreshAnchorsForCycleSql(cycleId, rootProjectId),
      );
    }
    return true;
  });
}

/** 스왑 성공 후 옛 generation 행을 지운다. */
export async function purgeOldGenerationRows(
  rt: Pick<GeneratorRuntime, "exec">,
  keys: GenerationKeys,
): Promise<void> {
  for (const stmt of purgeOldGenerationRowsSql(keys)) await rt.exec(stmt);
}
