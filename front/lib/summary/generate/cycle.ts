/**
 * 생성기 코어 — 회차 원장(`summary_cycles`)과 generation(`summary_generations`) 문장.
 *
 * 전부 **SQL 을 만들어 돌려주기만** 한다(실행은 표면 어댑터). 문장을 한 곳에 모으는 이유는
 * 두 표면이 문자 그대로 같은 원장 문장을 쓰기 때문이다 — 한쪽만 고치는 결함을 없앤다.
 */
import { sql, type SQL } from "drizzle-orm";
import type { GenerationKeys, GenerationTimings, SummarySurface } from "./types";

/**
 * 회차 원장 upsert (§2-6). `UNIQUE(project_id, cycle_anchor_at)` 이라 재실행은 재사용이다.
 * `anchor_source='operator'` — 이 경로는 사람이 회차를 지정해 여는 자리다(관제 자동 열기는
 * `lib/db/repositories/summary-cycles.ts` 소유).
 */
export function upsertCycleSql(args: {
  surface: SummarySurface;
  projectId: string;
  cycleAnchorAt: string;
  cycleWeek: string;
  version: string;
}): SQL {
  return sql`
    INSERT INTO summary_cycles
      (surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, fleet_visible, generator_version)
    VALUES (${args.surface}, ${args.projectId}::uuid, ${args.cycleAnchorAt}::timestamptz, ${args.cycleWeek}::date,
            'operator', 'open', true, ${args.version})
    ON CONFLICT (project_id, cycle_anchor_at)
      DO UPDATE SET surface = EXCLUDED.surface, cycle_week = EXCLUDED.cycle_week
    RETURNING cycle_id
  `;
}

/**
 * generation 행 생성(`loading`) — 판정 입력 스냅샷을 함께 굳힌다(§7-8).
 * 재생성이 "최신 명부로의 재해석" 이 되지 않도록, 이 네 jsonb 가 그 회차의 판정 입력 정본이다.
 */
export function insertGenerationSql(args: {
  cycleId: string;
  version: string;
  rosterSnapshot: unknown;
  baseUniverse: unknown;
  targetUniverse: unknown;
  noiseSnapshot: unknown;
}): SQL {
  return sql`
    INSERT INTO summary_generations
      (cycle_id, generator_version, status, roster_snapshot, base_universe, target_universe, noise_snapshot)
    VALUES (${args.cycleId}::uuid, ${args.version}, 'loading',
      ${JSON.stringify(args.rosterSnapshot)}::jsonb,
      ${JSON.stringify(args.baseUniverse)}::jsonb,
      ${JSON.stringify(args.targetUniverse)}::jsonb,
      ${JSON.stringify(args.noiseSnapshot)}::jsonb)
    RETURNING generation_id
  `;
}

/**
 * 회차 카운터를 **관측값에서** 채운다(§2-1: expected 는 사전 산식이 아니라 관측값).
 * 글로벌 경로 — 관측을 이미 한 번 돌려 값으로 들고 있다.
 *
 * ⚠️ `closed_by`·`closed_at`·`analysis_gate` 는 **COALESCE 로 보존한다**(2026-09-10 수리).
 * 종전 구현은 셋을 무조건 `'operator'`/`now()`/`'override'` 로 덮어써, 관제(T6)가
 * `next_anchor`·`complete`·`recheck_window` 로 닫아 둔 **종결 출처를 첫 생성이 지웠다**
 * (라이브 96 회차가 전부 `operator`/`override` 인 것이 그 지문이다). 생성은 회차를 닫는
 * 행위가 아니라 이미 닫힌 회차를 읽는 행위다 — 닫은 주체를 생성기가 자칭하면 안 된다.
 * 아직 아무도 안 닫은 회차(레거시 스크립트가 직접 연 경우)에서만 `operator` 가 들어간다.
 */
export function updateCycleCountersFromValuesSql(args: {
  cycleId: string;
  version: string;
  measuredFrom: string | null;
  measuredTo: string | null;
  expectedUnits: number;
  completedUnits: number;
  analysisGapRatio: string;
}): SQL {
  return sql`
      UPDATE summary_cycles SET
        status = 'generating',
        closed_by = COALESCE(closed_by, 'operator'), closed_at = COALESCE(closed_at, now()),
        measured_from = ${args.measuredFrom}::timestamptz, measured_to = ${args.measuredTo}::timestamptz,
        expected_units = ${args.expectedUnits}, completed_units = ${args.completedUnits},
        sealed_units = ${args.expectedUnits - args.completedUnits},
        completion_ratio = ${
          args.expectedUnits > 0
            ? (args.completedUnits / args.expectedUnits).toFixed(5)
            : null
        },
        analysis_gap_ratio = ${args.analysisGapRatio},
        analysis_gate = COALESCE(analysis_gate, 'override'), generator_version = ${args.version}
      WHERE cycle_id = ${args.cycleId}::uuid
    `;
}

/**
 * 회차 카운터를 **한 문장 안에서** 센다. 웹사이트 경로 — 프로젝트당 run 집합이 작아
 * 관측을 따로 돌리지 않고 적재 문장과 같은 창(`runIds`)에서 계산한다.
 * `jobsCte`(= `jb`)는 굳혀 둔 `summary_cycle_jobs` 를 읽는 CTE 여야 한다.
 *
 * ⚠️ 종결 출처 보존은 `updateCycleCountersFromValuesSql` 과 같다 — 그 머리 주석 참고.
 * 여기서는 UPDATE 별칭이 `c` 라 `COALESCE(c.closed_by, …)` 로 옛 값을 읽는다.
 */
export function updateCycleCountersFromWindowSql(args: {
  cycleId: string;
  version: string;
  jobsCte: SQL;
  runIds: string[];
}): SQL {
  return sql`
      WITH ${args.jobsCte},
      all_ans AS (SELECT a.* FROM scope_answers a WHERE a.run_id = ANY(${sql.param(args.runIds)}::uuid[])),
      s AS (
        SELECT count(DISTINCT (prompt_id, target, region))::int AS expected_units,
               count(DISTINCT (prompt_id, target, region)) FILTER (WHERE status = 'completed')::int AS completed_units,
               min(measured_at) AS measured_from, max(measured_at) AS measured_to
        FROM all_ans
      ),
      g AS (
        SELECT count(*)::int AS sealed_jobs,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM scope_mentions m WHERE m.job_id = jb.job_id)
                                  AND NOT EXISTS (SELECT 1 FROM scope_citations c WHERE c.job_id = jb.job_id))::int AS gap_jobs
        FROM jb
      )
      UPDATE summary_cycles c SET
        status = 'generating',
        closed_by = COALESCE(c.closed_by, 'operator'), closed_at = COALESCE(c.closed_at, now()),
        measured_from = s.measured_from, measured_to = s.measured_to,
        expected_units = s.expected_units, completed_units = s.completed_units,
        sealed_units = s.expected_units - s.completed_units,
        completion_ratio = CASE WHEN s.expected_units > 0
          THEN round((s.completed_units::numeric / s.expected_units), 5) END,
        analysis_gap_ratio = CASE WHEN g.sealed_jobs > 0
          THEN round((g.gap_jobs::numeric / g.sealed_jobs), 5) END,
        analysis_gate = COALESCE(c.analysis_gate, 'override'), generator_version = ${args.version}
      FROM s, g WHERE c.cycle_id = ${args.cycleId}::uuid
    `;
}

/** 이 generation 이 적재한 표별 행수. `row_counts` 의 원천이자 재생성 동치 판정의 근거. */
export function rowCountsSql(generationId: string): SQL {
  return sql`
      SELECT
        (SELECT count(*) FROM summary_cycle_jobs       WHERE generation_id = ${generationId}::uuid)::int AS cycle_jobs,
        (SELECT count(*) FROM summary_answers          WHERE generation_id = ${generationId}::uuid)::int AS answers,
        (SELECT count(*) FROM summary_brand_mentions   WHERE generation_id = ${generationId}::uuid)::int AS brand_mentions,
        (SELECT count(*) FROM summary_domain_citations WHERE generation_id = ${generationId}::uuid)::int AS domain_citations,
        (SELECT count(*) FROM summary_target_hits      WHERE generation_id = ${generationId}::uuid)::int AS target_hits,
        (SELECT count(*) FROM summary_prompt_dim       WHERE generation_id = ${generationId}::uuid)::int AS prompt_dim
    `;
}

export function markGenerationReadySql(generationId: string, rowCounts: unknown): SQL {
  return sql`
      UPDATE summary_generations SET status = 'ready', row_counts = ${JSON.stringify(rowCounts)}::jsonb
      WHERE generation_id = ${generationId}::uuid
    `;
}

/**
 * 표별 소요를 `summary_generations.timings` 에 기록한다(0064).
 * **컬럼 프로브 가드가 호출부의 책임이다** — 0064 미적용 DB 에서 이 문장을 쏘면 42703.
 */
/**
 * `timings` **병합** — 기존 키를 보존하고 patch 만 덮는다(백필이 `refold_*` 를 얹는 자리).
 * 통째로 덮으면 그 generation 이 원래 얼마나 걸렸는지가 사라진다 — 재접기는 생성이 아니라
 * 덧칠이므로 원래 기록을 지울 이유가 없다.
 */
export function mergeGenerationTimingsSql(
  generationId: string,
  patch: GenerationTimings,
): SQL {
  return sql`
      UPDATE summary_generations
        SET timings = COALESCE(timings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      WHERE generation_id = ${generationId}::uuid
    `;
}

export function updateGenerationTimingsSql(
  generationId: string,
  timings: GenerationTimings,
): SQL {
  return sql`
      UPDATE summary_generations SET timings = ${JSON.stringify(timings)}::jsonb
      WHERE generation_id = ${generationId}::uuid
    `;
}

/**
 * 실패 시 회차 상태 복원 — **`generating` 고착 탈출**(2026-09-10 수리).
 *
 * 카운터 UPDATE 는 `status='generating'` 을 먼저 올린다. 그 뒤 적재·스왑에서 실패하면
 * 회차가 `generating` 에 남는데, `--pending` 은 `status='closed'` 만 뽑으므로 **그 회차는
 * 영영 다시 생성되지 않는다**(관제도 닫힌 회차를 다시 닫지 않는다). 사람이 SQL 로
 * 되돌리기 전까지 화면에 안 올라온다 — 조용한 영구 결손이다.
 *
 * 되돌릴 값이 둘인 이유: 재생성은 `published` 회차를 `generating` 으로 올린다.
 * 그때 실패하면 `closed` 로 내리는 것이 오히려 회차를 화면에서 내리는 회귀가 된다 —
 * 활성 generation 이 남아 있으면 `published` 로, 없으면 `closed` 로 돌린다.
 * `status='generating'` 술어가 있어 스왑까지 성공한 뒤의 실패(정리 단계)는 건드리지 않는다.
 *
 * ⚠️ `generator_version` 도 함께 되돌린다(2026-09-10 수리). 카운터 UPDATE 가 **스왑 tx 밖에서**
 * 먼저 새 버전을 박기 때문에, 실패하면 회차가 "구 generation 이 활성인데 버전은 새 릴리스"인
 * 모순 상태로 남는다 — 그 행만 보고는 어느 코드가 지금 화면의 수를 만들었는지 알 수 없다.
 * 활성 generation 이 있으면 **그 generation 의 버전**으로 되돌리고, 없으면 그대로 둔다.
 */
export function restoreCycleStatusOnFailureSql(cycleId: string): SQL {
  return sql`
      UPDATE summary_cycles c
        SET status = CASE WHEN c.active_generation_id IS NOT NULL THEN 'published' ELSE 'closed' END,
            generator_version = COALESCE(
              (SELECT g.generator_version FROM summary_generations g
                WHERE g.generation_id = c.active_generation_id),
              c.generator_version)
      WHERE c.cycle_id = ${cycleId}::uuid AND c.status = 'generating'
    `;
}

export function markGenerationFailedSql(generationId: string, error: string): SQL {
  return sql`
      UPDATE summary_generations SET status = 'failed', finished_at = now(), error = ${error}
      WHERE generation_id = ${generationId}::uuid
    `;
}

/** 회차 run 멤버십을 굳힌다 — `synced_at` 지문을 함께 적어 스왑에서 다시 본다(§7-3). */
export function upsertCycleRunsSql(cycleId: string, runIds: string[]): SQL {
  return sql`
          INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by, synced_at_seen)
          SELECT ${cycleId}::uuid, r.run_id, 'operator', r.synced_at
          FROM scope_runs r WHERE r.run_id = ANY(${sql.param(runIds)}::uuid[])
          ON CONFLICT (run_id) DO UPDATE
            SET cycle_id = EXCLUDED.cycle_id, attributed_by = EXCLUDED.attributed_by,
                synced_at_seen = EXCLUDED.synced_at_seen
        `;
}

export type CycleRow = {
  cycle_id: string;
  surface: SummarySurface;
  project_id: string;
  cycle_anchor_at: string;
  cycle_week: string;
  status: string;
  active_generation_id: string | null;
  analysis_gap_ratio: string | null;
  view_anchor_at: string | null;
};

/** 스테일 `generating` 회수 창 — 이 시간 안에 시작한 `loading` generation 이 있으면 진행 중으로 본다. */
export const STALE_GENERATING_AFTER = "2 hours";

/**
 * T9 `--pending` 술어 — 종결됐고, 활성 generation 이 없고, 분석 갭이 임계 이하인 회차.
 *
 * `analysis_gap_ratio IS NULL` 은 **뽑지 않는다**(SQL 3값 논리 그대로). 갭을 모르는 회차를
 * 생성하면 미러 분석 미싱크(§8-1 지문)를 그대로 화면에 올리게 된다 — 모르면 안 만드는 쪽이
 * 손실이 작다. 관제(A1)가 회차를 닫을 때 이 값을 채운다.
 *
 * **스테일 `generating` 회수**(2026-09-10): 러너가 카운터 UPDATE 이후 하드 크래시(프로세스
 * 강제 종료·박스 재부팅)로 죽으면 `restoreCycleStatusOnFailureSql` 이 돌 기회조차 없어 회차가
 * `generating` 에 남는다. 그 회차를 다시 뽑는다. 판정을 `updated_at` 으로 못 하는 이유는
 * **`summary_cycles` 에 그 컬럼이 없기 때문**이고(0059 DDL), `closed_at` 은 이제 관제 값을
 * 보존하므로 시각 근거가 되지 않는다. 대신 **진행 중 generation 의 유무**로 본다 —
 * `loading` 이 최근 창 안에 시작돼 있으면 다른 러너가 지금 만들고 있는 것이므로 뽑지 않는다
 * (동시 러너 이중 생성 차단이 덤으로 따라온다). `active_generation_id IS NULL` 은 그대로 걸어,
 * 이미 노출 중인 회차를 재생성으로 끌어오지 않는다(그건 운영자의 `--cycle` 몫).
 *
 * `limit` 은 **행이 아니라 회차 묶음 수**다 — `groupBy` 참고.
 */
export function pendingCyclesSql(args: {
  surface: SummarySurface;
  gapMax: number;
  limit: number;
}): SQL {
  // 묶음 기준: 글로벌은 회차 앵커, 웹사이트는 주(함대 95 프로젝트가 한 주를 공유한다).
  const groupBy = sql.raw(args.surface === "website" ? "cycle_week" : "cycle_anchor_at");
  const cols = sql`cycle_id::text AS cycle_id, surface, project_id::text AS project_id,
           cycle_anchor_at::text AS cycle_anchor_at, cycle_week::text AS cycle_week, status,
           active_generation_id::text AS active_generation_id,
           analysis_gap_ratio::text AS analysis_gap_ratio, view_anchor_at::text AS view_anchor_at`;
  return sql`
    WITH cand AS (
      SELECT ${cols}, ${groupBy} AS grp
      FROM summary_cycles c
      WHERE surface = ${args.surface}
        AND active_generation_id IS NULL
        AND analysis_gap_ratio <= ${String(args.gapMax)}::numeric
        AND (
          status = 'closed'
          OR (status = 'generating' AND NOT EXISTS (
                SELECT 1 FROM summary_generations g
                WHERE g.cycle_id = c.cycle_id AND g.status = 'loading'
                  AND g.started_at > now() - ${STALE_GENERATING_AFTER}::interval
              ))
        )
    ),
    picked AS (SELECT DISTINCT grp FROM cand ORDER BY grp LIMIT ${args.limit})
    SELECT cycle_id, surface, project_id, cycle_anchor_at, cycle_week, status,
           active_generation_id, analysis_gap_ratio, view_anchor_at
    FROM cand WHERE grp IN (SELECT grp FROM picked)
    ORDER BY cycle_anchor_at, project_id
  `;
}

export function cycleByIdSql(cycleId: string): SQL {
  return sql`
    SELECT cycle_id::text AS cycle_id, surface, project_id::text AS project_id,
           cycle_anchor_at::text AS cycle_anchor_at, cycle_week::text AS cycle_week, status,
           active_generation_id::text AS active_generation_id,
           analysis_gap_ratio::text AS analysis_gap_ratio, view_anchor_at::text AS view_anchor_at
    FROM summary_cycles WHERE cycle_id = ${cycleId}::uuid
  `;
}

/** 회차에 굳혀 둔 run 목록(관제가 귀속한 것). 생성기는 이 집합만 본다. */
export function cycleRunIdsSql(cycleId: string): SQL {
  return sql`
    SELECT r.run_id::text AS run_id
    FROM summary_cycle_runs cr JOIN scope_runs r ON r.run_id = cr.run_id
    WHERE cr.cycle_id = ${cycleId}::uuid
    ORDER BY r.started_at
  `;
}

/** 직전 활성 generation 의 판정 입력 스냅샷 — `--reinterpret` 없이 재생성할 때 재사용한다(§7-8). */
export function activeGenerationSnapshotSql(cycleId: string): SQL {
  return sql`
    SELECT generation_id::text AS generation_id, generator_version,
           roster_snapshot, base_universe, target_universe, noise_snapshot
    FROM summary_generations
    WHERE cycle_id = ${cycleId}::uuid AND status = 'active'
    ORDER BY finished_at DESC NULLS LAST, started_at DESC
    LIMIT 1
  `;
}

export type GenerationKeysOf = GenerationKeys;
