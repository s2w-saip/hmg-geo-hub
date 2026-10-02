-- 0078: 미러 동기화 hot path 수리 — 회차 확장을 **조건부**로 + 원장 앵커 선택 규칙 교정.
-- 적용: npm run db:apply -- 0078   (제품 책임자 실행. drizzle-kit migrate 금지)
-- 정본 스펙: internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md
--
-- ⚠️ 0077 은 이미 프로덕션 미러(PostgreSQL 17.6)에 적용됐다. 그래서 그 파일은 고치지
-- 않고, 함수 교체는 전부 이 파일의 `CREATE OR REPLACE FUNCTION` 으로 한다.
-- 시그니처는 **그대로**다(`refresh_answer_cycle_anchors(uuid[], uuid)`) — 바꾸면 기존
-- `to_regprocedure` 단언과 capability 프로브가 깨지고 REVOKE 를 다시 걸어야 한다.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 결함 A — 회차 전체 재계산이 미러 싱크의 run 마다 돈다 (성능)
-- ══════════════════════════════════════════════════════════════════════════════
-- 0077 의 `refresh_answer_cycle_anchors(run_ids, root)` 는 받은 run 을 **회차 전체**
-- (같은 `project_id` + 같은 `scope_runs.cycle_anchor_at`)로 넓혀 재계산한다(회차 단위
-- 앵커 상속, 스펙 §3.1). 미러 `replaceRun` 은 run 하나마다 이것을 부른다.
--
-- 프로덕션 미러 실측: 최대 회차 = 답변 **56,383건 · run 1,304개**(글로벌 회차),
-- 2만 건 넘는 회차 3개, run 200개 넘는 회차 13개. 글로벌 회차 드레인 중에는 run 1,304개가
-- 차례로 들어오는데 매번 5.6만 행을 다시 조인·집계한다(변경 감지 덕에 쓰기는 0이어도
-- **계산은 매번 돈다**). 회차당 누적 비용이 run 수 × 회차 크기이고, 이 호출은 싱크
-- 트랜잭션 안이라 프로젝트 advisory lock 보유 시간까지 함께 길어진다.
--
-- ── 고치는 방법: 회차 해소 결과를 **저장**하고, 달라질 때만 넓힌다 ────────────
-- 회차의 해소 결과(출처·앵커 시각·`anchor_date`·귀속 `round_date`·표면·원장 노출일)는
-- **회차 수준 값**이라 답변 수와 무관하다. 그 값을 `scope_cycle_anchor_state` 에 한 행
-- 으로 두고, 매 호출은
--   ① 받은 run 의 레지스트리 요약만 갱신하고(좁다)
--   ② 회차 수준 값을 **싸게** 다시 구해 저장값과 대조한 뒤
--   ③ 달라졌을 때만 회차 전체로 넓힌다
-- 로 간다. 평소 호출의 작업량은 "받은 run 의 답변 수 + 회차 수준 조회"에 비례하고
-- **회차의 답변 수에 비례하지 않는다**.
--
-- ── 왜 표를 새로 만드나 (구조 선택) ──────────────────────────────────────────
-- 기존 매핑 표 `scope_cycle_rounds` 를 확장하지 않는다. 그 표의 키는
-- `(project_id, anchor_date)` 인데 **회차의 `anchor_date` 자체가 움직이는 값**이다
-- (레지스트리가 붙으면 회차 앵커가 다른 날짜로 옮겨간다). 즉 "회차"를 가리키는 안정적인
-- 키가 아니다. 또 `merged` 규칙상 한 자리에 회차가 둘 이상 앉을 수 있어 1:1도 아니다.
-- 그래서 회차 키(`hmg_cycle_key`)로 잡는 **작은 상태 표**를 따로 둔다(회차 약 1,000행).
--
-- ── 레지스트리(0053)를 매번 5.6만 행 훑지 않기 ───────────────────────────────
-- 회차 앵커 우선순위 1위는 "회차 답변 중 **하나라도** 0053 에 있으면" 이다. 이것을
-- 회차 전체 답변 조인으로 구하면 결국 5.6만 행을 훑게 된다(0053 자체도 156,759행이라
-- 반대 방향 전수 스캔도 답이 아니다). 그래서 **run 단위 요약표**
-- `scope_cycle_registry_runs` 를 둔다 — 레지스트리가 붙은 run 만 한 행씩 갖는 좁은 표라
-- 회차 수준 집계가 `cycle_key` 인덱스 하나로 끝나고, 레지스트리가 없는 회차는 0행이다.
-- 요약은 "그 run 이 재계산 대상일 때" 갱신하므로, 0053 을 손댄 뒤 **그 job 의 run 을
-- 넘긴다**는 0077 의 기존 계약(파일 머리 주석 "0053 에 행을 추가·삭제하는 수작업 접기
-- 절차 뒤에 반드시 부른다")이 그대로 정확성의 전제가 된다. 요약 갱신은 추가뿐 아니라
-- **삭제(레지스트리가 사라진 run 의 행 제거)** 도 하므로 원복 경로도 잡힌다.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 결함 B — 한 회차가 원장 회차 둘에 걸치면 `min()` 이 유령 회차를 고른다 (정확성)
-- ══════════════════════════════════════════════════════════════════════════════
-- 실측(2026-09-20, 전수 백필·재배정 후 감사 SQL): `ledger_anchor_drift` 1,704행(긴급).
-- 전부 website 6개 프로젝트, run 앵커 `2026-09-18 00:00Z` 회차다. 그 회차의 run 대부분
-- (9~15개)은 원장 회차 `cycle_anchor_at = 2026-09-18 00:00Z` 에 붙어 있고, 09-19 에
-- 재제출된 run 1~4개만 **09-19 에 생성된 유령 회차**(옛 스케줄 앵커 `2026-09-17 03:40Z`
-- 대)에 붙어 있다. 0077 의 `cyc_led` 가 `min(ledger_anchor_at)` 이라 회차 전체가 이른
-- 쪽인 09-17 을 받았다. `round_date` 는 어느 쪽이든 09-18(금)이라 기간 키는 멀쩡하지만
-- `anchor_at`·`anchor_date` 기록이 틀리고 감사가 매일 긴급으로 운다.
--
-- ── 새 선택 규칙 (이 파일과 dry-run·감사 SQL 이 같은 규칙을 쓴다) ────────────
--   ① 원장 앵커가 그 회차의 `scope_runs.cycle_anchor_at` 과 **같은** 원장 회차
--   ② 없으면 그 회차에서 **run 수가 가장 많은** 원장 회차
--   ③ 동수면 **이른** 앵커 (min 과 같아져 종전 동작으로 수렴한다)
-- `min(uuid)` 를 쓰지 않고 상관 서브쿼리도 쓰지 않는다 — `GROUP BY` 후 `DISTINCT ON` 이다.
--
-- ── 이미 쓰인 6회차의 회수 경로 ──────────────────────────────────────────────
-- ⚠️ **그 회차에 속한 run** 하나를 넘겨야 한다. "그 프로젝트의 run 아무거나" 가 아니다 —
-- 확장 seed 는 `SELECT DISTINCT project_id, cycle_anchor_at FROM scope_runs
-- WHERE run_id = ANY(run_ids)` 라 **넘긴 run 이 속한 회차만** 넓어진다. 같은 프로젝트의
-- 다른 회차 run 을 넘기면 대상 회차는 그대로 남는다.
-- 회차마다 run 하나를 뽑는 읽기 전용 목록 쿼리를 따로 뒀다:
--   `scripts/db/answer-cycle-anchors-ledger-split-runs.sql`
-- 그 run 으로 `refresh_answer_cycle_anchors` 를 부르면 회차 수준 값(`anchor_at`·
-- `anchor_date`)이 저장값과 달라지므로 **자동으로 회차 전체로 넓혀** 다시 쓴다.
-- 고정(pinned) 출처(`registry`)는 `hmg_anchor_keep_existing` 가드가 그대로 막으므로
-- 수작업 접기 값은 건드리지 않는다.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 알려진 한계 (독립 검증 2026-09-20 에서 "고치지 않고 남긴다"로 판정한 것)
-- ══════════════════════════════════════════════════════════════════════════════
--
-- L1 (W3) **자가치유 범위가 좁아졌다.** 0077 은 회차의 **어느** run 으로 불려도 회차
--    전체를 다시 썼다. 0078 의 좁은 경로에서는 세 가지가 함께 좁아진다:
--      · B8 삭제 범위(`t.run_id = ANY(v_runs)`) — refresh 를 안 거친 경로로 답변이
--        사라지면 형제 run 싱크가 더 이상 치우지 않는다. 감사 ⑥/⑦ 이 표면화한다.
--      · 귀속 단언 `v_bad` 범위 — 넘어온 run 밖의 불일치를 트랜잭션에서 막지 않는다.
--        감사 ⑩ `round_date_drift` 가 대신 잡는다.
--      · 산식 함수(`hmg_anchor_week`/`month`/`view_date`/`default_engines`) 교체 시의
--        회차 전파. 이제 `npm run db:backfill:answer-anchors -- --apply --recompute`
--        전수 재계산이 **필수**다(형제 run 싱크로 따라오지 않는다).
--    왜 안 고치나: 셋 다 "좁게 도는 것" 자체가 이 마이그레이션의 목적이고, 회차 전체를
--    다시 훑는 순간 5.6만 행 비용이 돌아온다. 대체 수단(감사 + --recompute)이 있다.
--
-- L2 (W9) **writer 마다 `p_root_project_id` 가 다르면 `surface` 가 플래핑한다.**
--    서로 다른 값이 번갈아 들어오면 대조 튜플의 `surface` 가 매번 뒤집혀 **호출마다
--    확장**이 된다(값은 그때그때 옳지만 비용이 0077 로 돌아간다).
--    현행 코드는 해소가 `lib/scope/anchor-root.ts` 한 곳으로 모여 있어 같은 프로세스
--    안에서는 갈리지 않는다. 남은 위험은 **env 가 다른 실행 환경**(로컬 `.env.local` 로
--    도는 백필 vs 앱). 적용 전에 백필 실행 환경의 `SCOPE_ROOT_PROJECT_ID` 가 앱 env 와
--    같은지 확인할 것. 지문은 `scope_cycle_anchor_state.expanded_count` 가 그 회차의
--    run 수만큼 늘어나는 것이다(정상은 한 자릿수).
--
-- L3 (W1 잔여) **0053 값 정정의 부분 반영.** `hmg_prune_cycle_registry_runs` 는 run 이
--    레지스트리를 **통째로** 잃은 경우만 잡는다. 한 run 안에서 일부 행의 `anchor` 만
--    바뀌는 정정은 그 run 을 넘겨야 반영된다(0077 머리 주석의 계약). 감사
--    `registry_summary_drift` 가 이제 행 수뿐 아니라 **앵커 값(min/max)** 까지 대조해
--    그 잔여를 긴급으로 드러낸다.
--
-- L5 (W7 잔여) **`hmg_prune_cycle_registry_runs` 는 회차의 레지스트리 보유 run 마다
--    `EXISTS` 를 돈다.** 그래서 평소 호출의 비용에 "그 회차에서 0053 이 붙은 run 수" 항이
--    하나 남는다. 수작업 접기가 없는 회차는 요약 행이 0개라 **아무 일도 하지 않으므로**
--    가장 큰 회차(글로벌 드레인)에서는 무료다. 접기가 많은 회차에서만 비용이 생긴다.
--    안 없애는 이유: 이 청소가 0077 의 "어느 run 으로 불려도 회차가 스스로 낫는다" 성질을
--    레지스트리 **소거**에 한해 지켜 주는 유일한 자리다(계약 위반 호출 대비). 없애면
--    L3 의 잔여가 소거까지 넓어진다. 실측이 필요하면 감사의 `registry_summary_drift` 가
--    0인 상태에서 이 함수만 떼고 비교할 것.
--
-- L4 **답변 0건 회차에도 상태 행이 생긴다.** 0077 은 `ans`(completed 답변)에서 회차를
--    만들어 답변 0건 회차에는 아무것도 안 남겼다. 0078 의 `cyc_ids` 는 `scope_runs`
--    에서 나오므로 상태 표에 한 행(`source='run'`)이 생긴다. 답변 행에는 영향이 없고
--    (`ans` 가 비어 INSERT 0행) 감사도 답변 행 쪽에서 조인하므로 오탐이 없다.
--
-- ── additive-only ─────────────────────────────────────────────────────────────
-- 신규 테이블 2개 + 신규 함수 3개 + 기존 함수 1개 교체. 기존 테이블 ALTER 없음.
-- `scope_answer_cycle_anchors`·`scope_cycle_rounds` 의 **기존 행은 건드리지 않는다** —
-- 0077 백필이 만든 행과 매핑을 그대로 받아들이고, 재계산이 같은 값을 내면 변경 감지
-- 가드가 0행으로 막는다. 그래서 이 파일은 백필 **전에 적용하든 후에 적용하든** 안전하다
-- (후에 적용하면 회차마다 **첫 호출 한 번**이 상태 표를 채우느라 넓어지고, 그 다음부터
--  좁은 경로로 간다).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── 회차 키 (저장 가능한 형태) ───────────────────────────────────────────────
--
-- 0077 은 `project_id::text || '|' || COALESCE(cycle_anchor_at::text, 'run:'||run_id)`
-- 를 **한 문장 안에서만** 썼다. 그 형태를 표에 저장하면 안 된다 — `timestamptz::text`
-- 는 **세션 TimeZone·DateStyle 을 따르므로** 세션이 달라지면 같은 회차가 다른 키를 갖는다.
-- 그래서 타임존과 무관한 **epoch 마이크로초**로 적는다.
--
-- STABLE 인 이유: `EXTRACT(EPOCH FROM timestamptz)` 가 PG 에서 STABLE 로 표시돼 있다
-- (값 자체는 타임존과 무관하다 — 그것이 이 함수를 쓰는 이유다). 인덱스식으로 쓰지 않는다.
CREATE OR REPLACE FUNCTION hmg_cycle_key(
  p_project_id      uuid,
  p_cycle_anchor_at timestamptz,
  p_run_id          uuid
)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT p_project_id::text || '|' ||
         COALESCE((EXTRACT(EPOCH FROM p_cycle_anchor_at) * 1000000)::bigint::text,
                  'run:' || p_run_id::text)
$fn$;--> statement-breakpoint

-- ── 회차 수준 해소 결과 (조건부 확장의 판정 근거) ────────────────────────────
--
-- 한 회차 = 한 행. `refresh_answer_cycle_anchors` 가 쓰기의 유일한 경로다.
-- **이 표를 손으로 고치지 않는다** — 고치면 조건부 확장이 "안 바뀌었다"고 오판한다.
-- 값이 의심되면 그 회차의 run 으로 refresh 를 부르면 된다(감사 SQL 이 불일치를 잡는다).
--
-- FK 를 두지 않는다 — 답변 행은 `replaceRun` 의 run 단위 delete+insert 로 사라졌다
-- 돌아오는데, 그때 회차 상태까지 지워지면 다음 호출이 통째로 넓어진다(0053·0054 와 같은 논리).
DO $ddl_state$
BEGIN
  IF to_regclass('public.scope_cycle_anchor_state') IS NULL THEN
    CREATE TABLE scope_cycle_anchor_state (
      -- `hmg_cycle_key(project_id, cycle_anchor_at, run_id)`.
      cycle_key            text PRIMARY KEY,
      project_id           uuid NOT NULL,
      -- 회차 키의 원재료. `cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못하므로
      -- `solo_run_id` 로 단독 회차가 된다(0077 의 `cycle_key` 와 같은 규칙).
      run_cycle_anchor_at  timestamptz,
      solo_run_id          uuid,
      -- ── 여기부터가 **조건부 확장의 대조 대상**이다(아래 upsert 의 WHERE 와 같은 튜플) ──
      surface              text NOT NULL,
      source               text NOT NULL,
      anchor_at            timestamptz NOT NULL,
      anchor_date          date NOT NULL,
      round_date           date NOT NULL,
      reg_utc_kept         boolean NOT NULL DEFAULT false,
      -- 원장이 찍은 노출일의 회차 수준 요약. 회차 run 들이 서로 다른 노출일을 물면
      -- variants 가 1을 넘고, 그 변화가 곧 "회차의 노출일이 달라졌다" 이다.
      ledger_view_date     date,
      ledger_view_variants int NOT NULL DEFAULT 0,
      -- ── 아래는 진단용(대조 대상 아님) ────────────────────────────────────
      reg_anchor           date,
      reg_split            boolean NOT NULL DEFAULT false,
      ledger_anchor_at     timestamptz,
      ledger_variants      int NOT NULL DEFAULT 0,
      -- 이 회차를 몇 번 **넓혀서** 재계산했는가. 평소 호출이 좁게 도는지의 실측 근거이고,
      -- 테스트가 "확장이 일어나지 않았다" 를 이 값으로 단언한다.
      expanded_count       bigint NOT NULL DEFAULT 0,
      last_expanded_at     timestamptz,
      refreshed_at         timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scope_cycle_anchor_state_surface_ck
        CHECK (surface IN ('standard', 'website', 'project')),
      CONSTRAINT scope_cycle_anchor_state_source_ck
        CHECK (source IN ('registry', 'ledger', 'run', 'fallback_measured'))
    );
  END IF;
END
$ddl_state$;--> statement-breakpoint

DO $idx_state$
BEGIN
  IF to_regclass('public.scope_cycle_anchor_state') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.scope_cycle_anchor_state_project_date_idx') IS NULL THEN
    CREATE INDEX scope_cycle_anchor_state_project_date_idx
      ON scope_cycle_anchor_state (project_id, anchor_date);
  END IF;
END
$idx_state$;--> statement-breakpoint

REVOKE ALL ON "scope_cycle_anchor_state" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── run 단위 레지스트리 요약 (회차 수준 레지스트리 판정을 O(1) 로 만드는 표) ──
--
-- **레지스트리가 붙은 run 만** 한 행씩 갖는다. 회차 수준 판정은
-- `WHERE cycle_key = …` 인덱스 조회 하나이고, 레지스트리가 없는 회차는 0행이라
-- 조회가 즉시 끝난다.
--
-- 왜 답변 단위가 아닌가: 0053 은 156,759행이고 회차 하나가 답변 5.6만 건이다. 둘 중
-- 어느 쪽으로 조인해도 회차 크기에 비례한다. run 단위(회차당 최대 1,304행, 레지스트리가
-- 붙은 run 만이면 훨씬 적다)가 유일하게 답변 수와 끊어지는 입도다.
DO $ddl_reg$
BEGIN
  IF to_regclass('public.scope_cycle_registry_runs') IS NULL THEN
    CREATE TABLE scope_cycle_registry_runs (
      run_id         uuid PRIMARY KEY,
      cycle_key      text NOT NULL,
      project_id     uuid NOT NULL,
      -- 이 run 의 completed 답변에 붙은 0053 `anchor` 의 최소·최대.
      -- 회차 수준에서 min(min) <> max(max) 이면 "회차 안 레지스트리 앵커가 갈렸다" 이고,
      -- 감사 SQL 의 `cycle_registry_split` 과 같은 신호다.
      reg_anchor_min date NOT NULL,
      reg_anchor_max date NOT NULL,
      reg_rows       int  NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END
$ddl_reg$;--> statement-breakpoint

DO $idx_reg$
BEGIN
  IF to_regclass('public.scope_cycle_registry_runs') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.scope_cycle_registry_runs_cycle_idx') IS NULL THEN
    CREATE INDEX scope_cycle_registry_runs_cycle_idx
      ON scope_cycle_registry_runs (cycle_key);
  END IF;
END
$idx_reg$;--> statement-breakpoint

REVOKE ALL ON "scope_cycle_registry_runs" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── run 단위 레지스트리 요약 갱신 ────────────────────────────────────────────
--
-- 받은 run 에 대해서만 돈다(`scope_answers_run_idx` → `scope_answer_anchors` PK).
-- **삭제 경로가 핵심이다** — 레지스트리가 사라진 run 의 요약 행을 지워야 "회차에서
-- 레지스트리가 없어졌다" 가 회차 수준에서 보인다(0053 접기 원복).
CREATE OR REPLACE FUNCTION hmg_refresh_cycle_registry_runs(p_run_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ins bigint := 0;
  v_del bigint := 0;
BEGIN
  IF p_run_ids IS NULL OR cardinality(p_run_ids) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO scope_cycle_registry_runs AS g
    (run_id, cycle_key, project_id, reg_anchor_min, reg_anchor_max, reg_rows, updated_at)
  SELECT a.run_id,
         hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id),
         r.project_id,
         min(reg.anchor), max(reg.anchor), count(*)::int, now()
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
   WHERE a.run_id = ANY(p_run_ids)
     AND a.status = 'completed'
     AND r.project_id IS NOT NULL
     AND reg.anchor IS NOT NULL
   GROUP BY a.run_id, r.project_id, r.cycle_anchor_at, r.run_id
  ON CONFLICT (run_id) DO UPDATE SET
    cycle_key      = EXCLUDED.cycle_key,
    project_id     = EXCLUDED.project_id,
    reg_anchor_min = EXCLUDED.reg_anchor_min,
    reg_anchor_max = EXCLUDED.reg_anchor_max,
    reg_rows       = EXCLUDED.reg_rows,
    updated_at     = now()
  WHERE (g.cycle_key, g.reg_anchor_min, g.reg_anchor_max, g.reg_rows)
          IS DISTINCT FROM
        (EXCLUDED.cycle_key, EXCLUDED.reg_anchor_min, EXCLUDED.reg_anchor_max, EXCLUDED.reg_rows);
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  DELETE FROM scope_cycle_registry_runs g
   WHERE g.run_id = ANY(p_run_ids)
     AND NOT EXISTS (
           SELECT 1 FROM scope_answers a
             JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
            WHERE a.run_id = g.run_id AND a.status = 'completed' AND reg.anchor IS NOT NULL);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  RETURN v_ins + v_del;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_refresh_cycle_registry_runs(uuid[]) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 회차 단위 **소거 청소** (레지스트리 원복이 어느 run 으로 불려도 보이게) ──
--
-- 왜 따로 있나: 위 갱신은 **받은 run** 만 본다. 0053 을 손댄 뒤 그 job 의 run 을 넘기라는
-- 계약(0077 파일 머리 주석)을 지키면 그것으로 충분하지만, 계약이 깨진 호출에서는 회차가
-- "아직 레지스트리가 있다"고 오판한다. 0077 은 매번 회차 전체를 다시 훑었으므로 그 경우에도
-- 스스로 나았다 — 그 성질을 잃지 않으려고 이 청소를 둔다.
--
-- 비용: 회차의 **레지스트리 보유 run** 마다 `EXISTS` 조기 종료 한 번이다. 수작업 접기가
-- 없는 회차는 요약 행이 0개라 **아무 일도 하지 않는다**(큰 회차의 평소 경로가 여기다).
-- ⚠️ 부분 변경(run 이 레지스트리를 일부만 잃어 min 이 바뀌는 경우)은 잡지 않는다.
-- 실측상 회차 안 레지스트리 앵커 불일치는 0이고, 감사 SQL 의 `registry_summary_drift` 가
-- 그 잔여를 표면화한다.
CREATE OR REPLACE FUNCTION hmg_prune_cycle_registry_runs(p_cycle_keys text[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_n bigint := 0;
BEGIN
  IF p_cycle_keys IS NULL OR cardinality(p_cycle_keys) = 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM scope_cycle_registry_runs g
   WHERE g.cycle_key = ANY(p_cycle_keys)
     AND NOT EXISTS (
           SELECT 1 FROM scope_answers a
             JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
            WHERE a.run_id = g.run_id AND a.status = 'completed' AND reg.anchor IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_prune_cycle_registry_runs(text[]) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 매핑 → 답변 행 **전파** (0077 판 교체) — 상태 표까지 한 문장 뒤에서 맞춘다 ──
--
-- 0077 판은 답변 행의 `round_date`·주·월만 옮겼다. 0078 이 회차 상태 표를 들이면서
-- **운영자 재배정이 상태 표를 낡게 만드는 경로**가 생긴다:
--   `db:reassign:cycle-rounds` 와 백필 3단계 `reassignAll` 은 `scope_cycle_rounds` 를
--   지우고 다시 앉힌 뒤 이 함수로 답변 행만 옮긴다. `refresh_answer_cycle_anchors` 를
--   부르지 않으므로 상태 표의 `round_date` 는 옛 값으로 남는다.
--   → 감사 `cycle_state_drift` 가 **긴급으로 영구히** 운다(재배정 대상은 보통 과거
--     회차라 다시 싱크되지 않아 자가치유되지 않는다).
--
-- 호출부에 한 문장을 더 붙이는 대신 **이 함수 안에서** 맞춘다 — 호출부가 셋이고
-- (미러 재계산·운영자 재배정·백필) 앞으로 늘 수 있는데, 빠뜨리면 조용히 긴급 경보가
-- 된다. "빠뜨릴 수 없는 구조"가 이 계열의 규율이다.
--
-- 반환값은 **종전과 같다**(답변 행 수). 재배정 스크립트가 그 수를 `movedRows` 로
-- 보고하므로 의미를 바꾸지 않는다. 상태 표 갱신 수는 NOTICE 로만 드러낸다.
--
-- 범위 인자는 종전과 같다 — run 축(증분) 또는 project 축(전수).
CREATE OR REPLACE FUNCTION hmg_propagate_cycle_rounds(p_run_ids uuid[], p_project_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_n bigint := 0;
  v_s bigint := 0;
BEGIN
  IF p_run_ids IS NOT NULL THEN
    UPDATE scope_answer_cycle_anchors t
       SET round_date   = m.round_date,
           anchor_week  = hmg_anchor_week(m.round_date),
           anchor_month = hmg_anchor_month(m.round_date),
           updated_at   = now()
      FROM scope_cycle_rounds m
     WHERE t.run_id = ANY(p_run_ids)
       AND m.project_id = t.project_id
       AND m.anchor_date = t.anchor_date
       AND (t.round_date, t.anchor_week, t.anchor_month)
             IS DISTINCT FROM
           (m.round_date, hmg_anchor_week(m.round_date), hmg_anchor_month(m.round_date));
    GET DIAGNOSTICS v_n = ROW_COUNT;

    UPDATE scope_cycle_anchor_state s
       SET round_date = hmg_round_date_of(s.project_id, s.anchor_date),
           updated_at = now()
     WHERE s.cycle_key IN (
             SELECT hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)
               FROM scope_runs r
              WHERE r.run_id = ANY(p_run_ids) AND r.project_id IS NOT NULL)
       AND s.round_date IS DISTINCT FROM hmg_round_date_of(s.project_id, s.anchor_date);
    GET DIAGNOSTICS v_s = ROW_COUNT;

  ELSIF p_project_ids IS NOT NULL THEN
    UPDATE scope_answer_cycle_anchors t
       SET round_date   = m.round_date,
           anchor_week  = hmg_anchor_week(m.round_date),
           anchor_month = hmg_anchor_month(m.round_date),
           updated_at   = now()
      FROM scope_cycle_rounds m
     WHERE t.project_id = ANY(p_project_ids)
       AND m.project_id = t.project_id
       AND m.anchor_date = t.anchor_date
       AND (t.round_date, t.anchor_week, t.anchor_month)
             IS DISTINCT FROM
           (m.round_date, hmg_anchor_week(m.round_date), hmg_anchor_month(m.round_date));
    GET DIAGNOSTICS v_n = ROW_COUNT;

    UPDATE scope_cycle_anchor_state s
       SET round_date = hmg_round_date_of(s.project_id, s.anchor_date),
           updated_at = now()
     WHERE s.project_id = ANY(p_project_ids)
       AND s.round_date IS DISTINCT FROM hmg_round_date_of(s.project_id, s.anchor_date);
    GET DIAGNOSTICS v_s = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'hmg_propagate_cycle_rounds: p_run_ids 와 p_project_ids 가 둘 다 NULL 이다';
  END IF;

  IF v_s > 0 THEN
    RAISE NOTICE 'hmg_propagate_cycle_rounds: 회차 상태 %건의 귀속 날짜를 함께 맞췄다(cycle_state_drift 방지).', v_s;
  END IF;
  RETURN v_n;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_propagate_cycle_rounds(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 회차 수준 해소 + 상태 저장 ───────────────────────────────────────────────
--
-- 받은 run 들이 속한 **회차**의 해소 결과를 다시 구해 `scope_cycle_anchor_state` 에
-- upsert 하고, **값이 실제로 달라진 회차 키**를 돌려준다. 그 목록이 비어 있으면 호출부는
-- 회차를 넓히지 않아도 된다(= 이 마이그레이션의 요점).
--
-- 비용: 회차의 **답변**을 훑지 않는다.
--   · 레지스트리 = `scope_cycle_registry_runs` 의 cycle_key 집계 (없으면 0행)
--   · 원장       = 회차의 run 수만큼(`summary_cycle_runs` PK 조회)
--   · run 앵커   = 회차 키 자신 (O(1))
--   · fallback   = `cycle_anchor_at` 이 NULL 인 **단독 회차**에서만. 단독 회차는 run 이
--                  하나라 그 run 의 답변만 본다(= 받은 run 의 답변 수).
--     ⚠️ 이것이 성립하는 이유: `fallback_measured` 는 레지스트리·원장·run 앵커가 모두
--     없을 때만 쓰이는데, run 앵커가 없다는 것은 `cycle_anchor_at IS NULL` 이고 그런 run 은
--     회차 키에 자기 run_id 가 섞여 **단독 회차**가 된다(0077 의 같은 규칙).
--
-- 원장(0059)이 없는 DB 에서도 돌아야 하므로 조인을 동적으로 만든다(0077 과 같은 이유).
CREATE OR REPLACE FUNCTION hmg_sync_cycle_anchor_state(
  p_run_ids uuid[],
  p_root_project_id uuid,
  OUT changed_keys text[],
  OUT all_keys text[]
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ledger text;
  v_global text;
  v_cycutc text;
BEGIN
  changed_keys := ARRAY[]::text[];
  all_keys     := ARRAY[]::text[];
  IF p_run_ids IS NULL OR cardinality(p_run_ids) = 0 THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)),
                  ARRAY[]::text[])
    INTO all_keys
    FROM scope_runs r
   WHERE r.run_id = ANY(p_run_ids) AND r.project_id IS NOT NULL;

  IF to_regclass('public.summary_cycle_runs') IS NOT NULL
     AND to_regclass('public.summary_cycles') IS NOT NULL THEN
    -- 회차의 run 마다 그 run 이 붙은 원장 회차(앵커·노출일)를 한 줄로 편다.
    v_ledger := $q$
      SELECT cr.cycle_key,
             cr.cycle_anchor_at                AS run_anchor_at,
             cyc.cycle_anchor_at               AS ledger_anchor_at,
             hmg_anchor_date(cyc.view_anchor_at) AS ledger_view_date
        FROM cyc_runs cr
        JOIN summary_cycle_runs scr ON scr.run_id = cr.run_id
        JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
    $q$;
    -- ⚠️ 두 가지로 좁힌다(W7-2). 종전에는 호출마다 `summary_cycles` **전수**를 두 벌로
    -- 집계했다 — 이 CTE 는 0053 레지스트리 날짜(UTC)를 KST 로 옮길 때만 쓰이는데,
    -- 레지스트리가 없는 회차(대부분)에서는 조인 결과가 0행인데도 해시가 만들어졌다.
    --   ① 호출 대상 프로젝트로 한정 (`u.project_id = c.project_id` 로만 쓰이므로 동치)
    --   ② `EXISTS (SELECT 1 FROM reg)` — 이 배치에 레지스트리가 하나도 없으면
    --      상관 없는 uncorrelated 서브쿼리라 PG 가 **One-Time Filter** 로 접어
    --      스캔 자체를 건너뛴다. `u.d = r.reg_anchor` 의 우변이 전부 NULL 이라
    --      어차피 한 행도 매칭되지 않으므로 결과는 동치다.
    v_cycutc := $q$
      SELECT y.project_id,
             (y.cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
             hmg_anchor_date(y.cycle_anchor_at)                  AS kst_date,
             y.cycle_anchor_at
        FROM summary_cycles y
       WHERE y.project_id IN (SELECT project_id FROM cyc_ids)
         AND EXISTS (SELECT 1 FROM reg)
    $q$;
    v_global := $q$CASE WHEN $2 IS NOT NULL THEN c.project_id = $2
                        ELSE EXISTS (SELECT 1 FROM summary_cycles g
                                      WHERE g.project_id = c.project_id AND g.surface = 'global')
                   END$q$;
  ELSE
    v_ledger := $q$SELECT NULL::text AS cycle_key, NULL::timestamptz AS run_anchor_at,
                          NULL::timestamptz AS ledger_anchor_at, NULL::date AS ledger_view_date
                    WHERE false$q$;
    v_cycutc := $q$SELECT NULL::uuid AS project_id, NULL::date AS utc_date,
                          NULL::date AS kst_date, NULL::timestamptz AS cycle_anchor_at
                    WHERE false$q$;
    v_global := $q$($2 IS NOT NULL AND c.project_id = $2)$q$;
  END IF;

  -- ⚠️ plpgsql `EXECUTE` 의 어순은 `INTO` 가 `USING` **앞**이다. 뒤집으면 파싱 에러다.
  EXECUTE format($q$
    WITH cyc_ids AS (
      SELECT DISTINCT
             r.project_id,
             r.cycle_anchor_at,
             CASE WHEN r.cycle_anchor_at IS NULL THEN r.run_id END AS solo_run_id,
             hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id) AS cycle_key
        FROM scope_runs r
       WHERE r.run_id = ANY($1) AND r.project_id IS NOT NULL
    ), cyc_runs AS (
      -- 회차의 run 전부. 0077 의 `seed`/`expanded` 와 같은 확장이고, 같은 인덱스를 탄다.
      SELECT c.cycle_key, c.project_id, c.cycle_anchor_at, r.run_id
        FROM cyc_ids c
        JOIN scope_runs r ON r.project_id = c.project_id
                         AND r.cycle_anchor_at = c.cycle_anchor_at
       WHERE c.solo_run_id IS NULL
      UNION ALL
      SELECT c.cycle_key, c.project_id, c.cycle_anchor_at, c.solo_run_id
        FROM cyc_ids c
       WHERE c.solo_run_id IS NOT NULL
    ), reg AS (
      -- 회차 수준 레지스트리 = 좁은 요약표의 cycle_key 집계 **한 번**.
      -- ⚠️ `cyc_key` **앞**에 둔다 — 그쪽이 "이 배치에 레지스트리가 있는가" 를
      --    One-Time Filter 로 쓰기 때문이다(W7-2).
      SELECT g.cycle_key,
             min(g.reg_anchor_min) AS reg_anchor,
             (min(g.reg_anchor_min) IS DISTINCT FROM max(g.reg_anchor_max)) AS reg_split
        FROM scope_cycle_registry_runs g
        JOIN (SELECT DISTINCT cycle_key FROM cyc_ids) k ON k.cycle_key = g.cycle_key
       GROUP BY 1
    ), cyc_key AS (
      %3$s
    ), cyc_utc AS (
      SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), cyc_kst AS (
      SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), led_runs AS (
      %1$s
    ), led_grp AS (
      -- 원장 회차별 run 수 + "그 원장 앵커가 회차의 run 앵커와 같은가".
      -- `bool_or` 안에서는 그룹 밖 컬럼(run_anchor_at)을 참조해도 된다(집계 인자다).
      SELECT cycle_key, ledger_anchor_at,
             count(*) AS runs,
             bool_or(ledger_anchor_at IS NOT DISTINCT FROM run_anchor_at) AS matches_run
        FROM led_runs
       WHERE ledger_anchor_at IS NOT NULL
       GROUP BY 1, 2
    ), led AS (
      -- 결함 B 의 선택 규칙: ① run 앵커 일치 ② run 수 최다 ③ 이른 앵커.
      SELECT DISTINCT ON (cycle_key) cycle_key, ledger_anchor_at
        FROM led_grp
       ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
    ), led_stat AS (
      SELECT cycle_key,
             count(DISTINCT ledger_anchor_at)::int  AS ledger_variants,
             min(ledger_view_date)                  AS ledger_view_date,
             count(DISTINCT ledger_view_date)::int  AS ledger_view_variants
        FROM led_runs GROUP BY 1
    ), solo AS (
      -- 단독 회차(cycle_anchor_at NULL)에서만 쓰이는 폴백. run 하나의 답변만 본다.
      SELECT c.cycle_key, min(a.measured_at) AS fallback_at
        FROM cyc_ids c
        JOIN scope_answers a ON a.run_id = c.solo_run_id AND a.status = 'completed'
       WHERE c.solo_run_id IS NOT NULL
       GROUP BY 1
    ), res AS (
      SELECT c.cycle_key, c.project_id, c.cycle_anchor_at AS c_cycle_anchor_at, c.solo_run_id,
             -- 표면 판정 = 회차의 소속 프로젝트. 순서·근거는 0077 과 같다
             -- (website → standard(루트 인자) → project. ELSE 를 standard 로 접지 않는다).
             CASE WHEN EXISTS (SELECT 1 FROM website_sites ws
                                WHERE ws.scope_project_id = c.project_id::text) THEN 'website'
                  WHEN %2$s THEN 'standard'
                  ELSE 'project' END AS surface,
             CASE WHEN r.reg_anchor       IS NOT NULL THEN 'registry'
                  WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
                  WHEN c.cycle_anchor_at  IS NOT NULL THEN 'run'
                  WHEN s.fallback_at      IS NOT NULL THEN 'fallback_measured'
             END AS source,
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(u.cycle_anchor_at, k.cycle_anchor_at,
                                  (r.reg_anchor::timestamp AT TIME ZONE hmg_anchor_timezone()))
                  WHEN l.ledger_anchor_at IS NOT NULL THEN l.ledger_anchor_at
                  WHEN c.cycle_anchor_at  IS NOT NULL THEN c.cycle_anchor_at
                  ELSE s.fallback_at END AS anchor_at,
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(hmg_anchor_date(u.cycle_anchor_at),
                                  hmg_anchor_date(k.cycle_anchor_at), r.reg_anchor)
                  WHEN l.ledger_anchor_at IS NOT NULL THEN hmg_anchor_date(l.ledger_anchor_at)
                  WHEN c.cycle_anchor_at  IS NOT NULL THEN hmg_anchor_date(c.cycle_anchor_at)
                  ELSE hmg_anchor_date(s.fallback_at) END AS anchor_date,
             (r.reg_anchor IS NOT NULL
              AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL) AS reg_utc_kept,
             r.reg_anchor,
             COALESCE(r.reg_split, false)         AS reg_split,
             l.ledger_anchor_at,
             COALESCE(ls.ledger_variants, 0)      AS ledger_variants,
             ls.ledger_view_date,
             COALESCE(ls.ledger_view_variants, 0) AS ledger_view_variants
        FROM cyc_ids c
        LEFT JOIN reg      r  ON r.cycle_key  = c.cycle_key
        LEFT JOIN led      l  ON l.cycle_key  = c.cycle_key
        LEFT JOIN led_stat ls ON ls.cycle_key = c.cycle_key
        LEFT JOIN solo     s  ON s.cycle_key  = c.cycle_key
        LEFT JOIN cyc_utc  u  ON u.project_id = c.project_id AND u.d = r.reg_anchor
        LEFT JOIN cyc_kst  k  ON k.project_id = c.project_id AND k.d = r.reg_anchor
    ), final AS (
      -- 귀속 날짜는 매핑 표가 정본이고, 매핑이 아직 없는 새 회차는 `anchor_date` 가
      -- 잠정값이다(0077 과 같다). 호출부가 배정·전파 뒤에 이 값을 고친다.
      SELECT res.*, hmg_round_date_of(res.project_id, res.anchor_date) AS round_date
        FROM res WHERE res.source IS NOT NULL
    ), ins AS (
      INSERT INTO scope_cycle_anchor_state AS st (
        cycle_key, project_id, run_cycle_anchor_at, solo_run_id, surface, source,
        anchor_at, anchor_date, round_date, reg_utc_kept,
        ledger_view_date, ledger_view_variants,
        reg_anchor, reg_split, ledger_anchor_at, ledger_variants,
        refreshed_at, updated_at)
      SELECT cycle_key, project_id, c_cycle_anchor_at, solo_run_id, surface, source,
             anchor_at, anchor_date, round_date, reg_utc_kept,
             ledger_view_date, ledger_view_variants,
             reg_anchor, reg_split, ledger_anchor_at, ledger_variants,
             now(), now()
        FROM final
      ON CONFLICT (cycle_key) DO UPDATE SET
        project_id           = EXCLUDED.project_id,
        run_cycle_anchor_at  = EXCLUDED.run_cycle_anchor_at,
        solo_run_id          = EXCLUDED.solo_run_id,
        surface              = EXCLUDED.surface,
        source               = EXCLUDED.source,
        anchor_at            = EXCLUDED.anchor_at,
        anchor_date          = EXCLUDED.anchor_date,
        round_date           = EXCLUDED.round_date,
        reg_utc_kept         = EXCLUDED.reg_utc_kept,
        ledger_view_date     = EXCLUDED.ledger_view_date,
        ledger_view_variants = EXCLUDED.ledger_view_variants,
        reg_anchor           = EXCLUDED.reg_anchor,
        reg_split            = EXCLUDED.reg_split,
        ledger_anchor_at     = EXCLUDED.ledger_anchor_at,
        ledger_variants      = EXCLUDED.ledger_variants,
        refreshed_at         = now(),
        updated_at           = now()
      -- ⚠️ **이 튜플이 조건부 확장의 계약이다.** 여기 없는 값이 답변 행에 들어가면
      -- 그 변화는 회차 전체에 전파되지 않는다. 답변 행의 회차 유래 값은
      -- surface·anchor_at·anchor_date·round_date(+주·월)·source·reason 표식
      -- (reg_utc_kept)·노출일(surface·anchor_date·원장 노출일의 순수 함수)뿐이고
      -- 전부 여기 들어 있다. 진단 컬럼(reg_*·ledger_anchor_at·ledger_variants)은
      -- 답변 행에 안 들어가므로 뺀다 — 넣으면 무해한 변화가 매번 확장을 부른다.
      WHERE (st.surface, st.source, st.anchor_at, st.anchor_date, st.round_date,
             st.reg_utc_kept, st.ledger_view_date, st.ledger_view_variants)
              IS DISTINCT FROM
            (EXCLUDED.surface, EXCLUDED.source, EXCLUDED.anchor_at, EXCLUDED.anchor_date,
             EXCLUDED.round_date, EXCLUDED.reg_utc_kept, EXCLUDED.ledger_view_date,
             EXCLUDED.ledger_view_variants)
      RETURNING st.cycle_key
    )
    SELECT COALESCE(array_agg(cycle_key), ARRAY[]::text[]) FROM ins
  $q$, v_ledger, v_global, v_cycutc)
  INTO changed_keys
  USING p_run_ids, p_root_project_id;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_sync_cycle_anchor_state(uuid[], uuid) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 앵커 재계산 (쓰기의 **유일한** 경로, 스펙 §4) — 0077 판 교체 ─────────────
--
-- 시그니처·반환값(쓰기 행 수)·부수효과(삭제·배정·전파·단언)는 0077 과 **같다**.
-- 달라진 것은 두 가지뿐이다:
--   ① 회차 수준 값을 `scope_cycle_anchor_state` 에서 받아 쓰고, 그 값이 달라졌을 때만
--      회차 전체로 넓힌다(결함 A).
--   ② 원장 출처 앵커를 `min()` 이 아니라 ①run 앵커 일치 ②run 수 최다 ③이른 앵커로
--      고른다(결함 B). 선택은 `hmg_sync_cycle_anchor_state` 안에 있다.
--
-- ── 동치성 (왜 좁게 써도 결과가 같은가) ──────────────────────────────────────
-- 답변 행의 값은 (회차 수준 값) × (그 답변·그 run 의 값)으로 갈린다.
--   · 회차 수준 = surface·anchor_at·anchor_date·round_date·source·reg_utc_kept·
--     원장 노출일 요약 → 전부 상태 표에 있고, 달라지면 **확장**한다.
--   · run/답변 수준 = cycle_id·원장 노출일(그 run 것)·measured_at_orig·is_default_engine·
--     source_measured_at·reason → 그 run 이 재계산 대상일 때만 바뀐다. 미러 재싱크는
--     그 run 을 넘기고, 원장 전파(`refreshAnchorsForCycleSql`)는 그 원장 회차의 run 을
--     전부 넘긴다. 즉 바뀐 run 은 항상 `run_ids` 에 들어 있다.
-- 삭제(B8)도 같은 논리다 — 답변이 completed 에서 벗어나는 것은 그 run 의 재싱크뿐이다.
--
-- ── 확장은 배치 단위로 판정한다 ──────────────────────────────────────────────
-- `run_ids` 가 회차 여럿에 걸쳐 있고 그중 하나만 달라졌으면 **그 배치의 회차 전부**를
-- 넓힌다(보수적). 실제 호출은 run 하나(미러) 또는 회차 하나(백필)라 차이가 없다.
CREATE OR REPLACE FUNCTION refresh_answer_cycle_anchors(run_ids uuid[], p_root_project_id uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ledger    text;
  v_deleted   bigint := 0;
  v_rows      bigint := 0;
  v_runs      uuid[];
  v_keys      text[];
  v_changed   text[];
  v_proj      uuid;
  v_assigned  bigint := 0;
  v_moved     bigint := 0;
  v_bad       bigint := 0;
BEGIN
  IF run_ids IS NULL OR cardinality(run_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- 폴백으로 떨어졌다는 사실을 드러낸다(반환값은 rowcount 라 여기에 실을 수 없다).
  IF p_root_project_id IS NULL THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: p_root_project_id 가 NULL — 표면 standard 판정이 원장 출력 폴백으로 돈다(B4). 호출부가 anchorRootProjectId() 를 넘기는지 확인할 것.';
  END IF;

  -- ── 0) 프로젝트 잠금 — **행 락을 잡기 전에, 오름차순으로** ─────────────────
  --
  -- 0077 은 같은 락(`8077`, 프로젝트 해시)을 `hmg_assign_cycle_rounds` 안에서 **나중에**
  -- 잡았다. 0078 이 그 앞에 두 가지 행 락(레지스트리 요약 행 · 회차 상태 행)을 추가하면서
  -- 순서가 엇갈릴 창이 생긴다:
  --   TX_A: 상태행(C) 잠금 → 확장 → 요약행(R_b) 요구
  --   TX_B: 요약행(R_b) 잠금 → 상태행(C) 요구            → 40P01
  -- 같은 프로젝트의 서로 다른 run 이 동시에 싱크되고 **양쪽 run 에 0053 행이 있을 때**만
  -- 성립하지만, 락 획득을 여기로 끌어올리면 창 자체가 사라진다.
  --
  -- ⚠️ 새 락이 아니다 — `hmg_assign_cycle_rounds` 가 **어차피 잡던 같은 키**를 더 일찍
  -- 잡을 뿐이다(advisory 락은 같은 트랜잭션에서 재획득이 무해하다). 즉 직렬화 범위는
  -- 0077 과 같고 보유 시작 시점만 몇 문장 앞당겨진다.
  -- 오름차순 고정이 여러 프로젝트를 한 배치로 받는 호출(백필)에서 교착을 막는다.
  FOR v_proj IN
    SELECT DISTINCT r.project_id
      FROM scope_runs r
     WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(8077, hashtext(v_proj::text));
  END LOOP;

  -- ── 1) 받은 run 의 레지스트리 요약 (좁다 — 받은 run 의 답변 수에 비례) ──────
  PERFORM hmg_refresh_cycle_registry_runs(run_ids);

  -- 회차 키를 먼저 잡아 요약 소거 청소에 쓴다.
  SELECT coalesce(array_agg(DISTINCT hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)),
                  ARRAY[]::text[])
    INTO v_keys
    FROM scope_runs r
   WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL;

  -- 레지스트리를 통째로 잃은 run 의 요약을 회차 단위로 치운다(계약 위반 호출 대비).
  PERFORM hmg_prune_cycle_registry_runs(v_keys);

  -- ── 2) 회차 수준 해소 결과를 다시 구해 상태 표와 대조 ──────────────────────
  SELECT s.changed_keys, s.all_keys INTO v_changed, v_keys
    FROM hmg_sync_cycle_anchor_state(run_ids, p_root_project_id) s;

  IF cardinality(v_changed) > 0 THEN
    -- ── 3a) 회차 전체로 넓힌다 (0077 의 seed/expanded 와 같은 확장) ───────────
    -- 상관 서브쿼리를 쓰지 않는다(프로덕션 미러에서 같은 날 statement_timeout 3회).
    WITH seed AS (
      SELECT DISTINCT r.project_id, r.cycle_anchor_at
        FROM scope_runs r
       WHERE r.run_id = ANY(run_ids)
         AND r.project_id IS NOT NULL
         AND r.cycle_anchor_at IS NOT NULL
    ), expanded AS (
      SELECT r.run_id FROM scope_runs r
       WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL
      UNION
      SELECT r.run_id FROM scope_runs r
        JOIN seed s ON s.project_id = r.project_id
                   AND r.cycle_anchor_at = s.cycle_anchor_at
       WHERE r.project_id IS NOT NULL
    )
    SELECT coalesce(array_agg(run_id), ARRAY[]::uuid[]) INTO v_runs FROM expanded;

    -- 넓힌 run 의 레지스트리 요약까지 채운 뒤 회차 값을 **다시** 해소한다.
    -- (첫 호출처럼 상태 표가 비어 있던 경우, 회차의 다른 run 에 붙은 레지스트리가
    --  여기서 비로소 요약에 들어온다.)
    PERFORM hmg_refresh_cycle_registry_runs(v_runs);
    SELECT s.all_keys INTO v_keys
      FROM hmg_sync_cycle_anchor_state(v_runs, p_root_project_id) s;

    UPDATE scope_cycle_anchor_state
       SET expanded_count = expanded_count + 1, last_expanded_at = now()
     WHERE cycle_key = ANY(v_keys);

    IF cardinality(v_runs) > cardinality(run_ids) THEN
      RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 해소 결과가 달라져 run %개 → %개로 넓혔다(같은 프로젝트·같은 cycle_anchor_at).',
        cardinality(run_ids), cardinality(v_runs);
    END IF;
  ELSE
    -- ── 3b) 평소 경로 — 받은 run 만. 회차 크기와 무관하다. ────────────────────
    SELECT coalesce(array_agg(r.run_id), ARRAY[]::uuid[]) INTO v_runs
      FROM scope_runs r
     WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL;
  END IF;

  IF to_regclass('public.summary_cycle_runs') IS NOT NULL
     AND to_regclass('public.summary_cycles') IS NOT NULL THEN
    v_ledger := $q$
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = rr.run_id
      LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
    $q$;
  ELSE
    v_ledger := $q$
      LEFT JOIN (SELECT NULL::uuid AS run_id, NULL::uuid AS cycle_id) scr ON false
      LEFT JOIN (SELECT NULL::uuid AS cycle_id,
                        NULL::timestamptz AS view_anchor_at) cyc ON false
    $q$;
  END IF;

  -- ⚠️ `v_runs` 가 비어도 **조기 반환하지 않는다.** 아래 동적 SQL 은 plpgsql 의 지연
  -- 검증 대상이라(본문 문자열은 CREATE 시점에 파싱되지 않는다) **첫 호출에서만** 타입·
  -- 함수 부재가 드러난다. 실제로 `min(uuid)` 부재가 그렇게 터졌다. 행이 0이어도 PG 는
  -- 문장을 파싱·계획하므로, 이 경로를 항상 태워야 적용 시점 스모크가 의미를 갖는다.
  EXECUTE format($q$
    WITH run_ctx AS (
      -- run 단위 사실만 해소한다. 회차 수준 값은 상태 표에서 조인한다.
      -- ⚠️ 표면 판정이 여기서 사라진 이유: surface 는 project_id 의 함수라 회차 안에서
      -- 상수이고, 회차 수준 값으로 상태 표가 쥔다(0077 의 EXISTS 순서 주석과 같은 규칙).
      SELECT rr.run_id,
             rr.project_id,
             hmg_cycle_key(rr.project_id, rr.cycle_anchor_at, rr.run_id) AS cycle_key,
             scr.cycle_id           AS cycle_id,
             cyc.view_anchor_at     AS ledger_view_anchor_at
        FROM scope_runs rr
        %1$s
       WHERE rr.run_id = ANY($1)
         AND rr.project_id IS NOT NULL
    ), ans AS (
      SELECT a.job_id, a.run_id, a.target, a.measured_at,
             rc.project_id, rc.cycle_key, rc.cycle_id, rc.ledger_view_anchor_at,
             reg.source_measured_at AS reg_source_measured_at,
             reg.reason             AS reg_reason
        FROM scope_answers a
        JOIN run_ctx rc ON rc.run_id = a.run_id
        LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
       WHERE a.status = 'completed'
    )
    INSERT INTO scope_answer_cycle_anchors AS t (
      job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week,
      anchor_month, measured_at_orig, is_default_engine,
      round_date, view_anchor_date, ledger_view_anchor_date,
      cycle_id, source, source_measured_at, reason, updated_at
    )
    SELECT a.job_id, a.run_id, a.project_id, c.surface, c.anchor_at, c.anchor_date,
           -- 주·월은 **귀속 날짜 기준**이다(스펙 §9 "귀속").
           hmg_anchor_week(c.round_date),
           hmg_anchor_month(c.round_date),
           -- 대표 답변 정렬 키(§2-16).
           COALESCE(a.reg_source_measured_at, a.measured_at, c.anchor_at),
           -- 기본 타겟 여부(§2-17). 목록은 `hmg_anchor_default_engines()` 한 곳.
           (a.target = ANY(hmg_anchor_default_engines())),
           c.round_date,
           -- 노출 게이트 — 산식의 정본은 `hmg_anchor_view_date()` 한 곳이다(시간 게이트만).
           hmg_anchor_view_date(c.surface, c.anchor_date,
                                hmg_anchor_date(a.ledger_view_anchor_at)),
           hmg_anchor_date(a.ledger_view_anchor_at),
           a.cycle_id, c.source,
           a.reg_source_measured_at,
           CASE WHEN c.reg_utc_kept
                  THEN COALESCE(a.reg_reason || ' ', '') || '[anchor-tz:utc-date-kept]'
                ELSE a.reg_reason END,
           now()
      FROM ans a JOIN scope_cycle_anchor_state c ON c.cycle_key = a.cycle_key
    ON CONFLICT (job_id) DO UPDATE SET
      run_id      = EXCLUDED.run_id,
      project_id  = EXCLUDED.project_id,
      surface     = EXCLUDED.surface,
      anchor_at   = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_at   ELSE EXCLUDED.anchor_at   END,
      anchor_date = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_date ELSE EXCLUDED.anchor_date END,
      round_date  = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_round_date_of(t.project_id, t.anchor_date)
                         ELSE EXCLUDED.round_date END,
      anchor_week = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_week(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_week END,
      anchor_month= CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_month(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_month END,
      measured_at_orig  = EXCLUDED.measured_at_orig,
      is_default_engine = EXCLUDED.is_default_engine,
      source      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source      ELSE EXCLUDED.source      END,
      source_measured_at = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source_measured_at ELSE EXCLUDED.source_measured_at END,
      reason      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.reason      ELSE EXCLUDED.reason      END,
      view_anchor_date = CASE
        WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
          THEN hmg_anchor_view_date(
                 EXCLUDED.surface, t.anchor_date, EXCLUDED.ledger_view_anchor_date)
        ELSE EXCLUDED.view_anchor_date END,
      ledger_view_anchor_date = EXCLUDED.ledger_view_anchor_date,
      cycle_id    = EXCLUDED.cycle_id,
      updated_at  = now()
    WHERE (t.run_id, t.project_id, t.surface, t.ledger_view_anchor_date, t.cycle_id,
           t.measured_at_orig, t.is_default_engine)
            IS DISTINCT FROM
          (EXCLUDED.run_id, EXCLUDED.project_id, EXCLUDED.surface,
           EXCLUDED.ledger_view_anchor_date, EXCLUDED.cycle_id,
           EXCLUDED.measured_at_orig, EXCLUDED.is_default_engine)
       OR (NOT hmg_anchor_keep_existing(t.source, EXCLUDED.source)
           AND (t.anchor_at, t.anchor_date, t.anchor_week, t.anchor_month,
                t.source, t.source_measured_at, t.reason)
                 IS DISTINCT FROM
               (EXCLUDED.anchor_at, EXCLUDED.anchor_date, EXCLUDED.anchor_week,
                EXCLUDED.anchor_month, EXCLUDED.source,
                EXCLUDED.source_measured_at, EXCLUDED.reason))
  $q$, v_ledger) USING v_runs;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- ── 삭제·원복 전파 (B8) — 0077 과 같다 ────────────────────────────────────
  DELETE FROM scope_answer_cycle_anchors t
   WHERE t.run_id = ANY(v_runs)
     AND NOT hmg_anchor_is_pinned(t.source)
     AND NOT EXISTS (SELECT 1 FROM scope_answers a
                      WHERE a.job_id = t.job_id AND a.status = 'completed');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: completed 에서 벗어났거나 드롭된 job 의 비고정(pinned 아님) 앵커 행 %건을 지웠다(B8).', v_deleted;
  END IF;

  -- ── 정규 요일 귀속: 배정 → 전파 → 단언 (0077 과 같다) ─────────────────────
  v_assigned := hmg_assign_cycle_rounds(v_runs, NULL);
  v_moved    := hmg_propagate_cycle_rounds(v_runs, NULL);
  IF v_assigned > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 %개를 정규 요일 자리에 새로 배정했다(답변 %행에 전파).',
      v_assigned, v_moved;
  END IF;

  -- ⚠️ 상태 표의 귀속 날짜는 **`hmg_propagate_cycle_rounds` 가 맞춘다**(위 한 줄).
  -- 여기서 한 번 더 쓰지 않는다 — 같은 문장을 두 곳에 두면 운영자 재배정 경로(그
  -- 함수만 부르는 경로)와 갈린다. 그 함수가 빠뜨릴 수 없는 자리다.

  -- 잠정값이 밖으로 새지 않는지 **같은 트랜잭션에서** 못박는다(0077 과 같다).
  SELECT count(*) INTO v_bad
    FROM scope_answer_cycle_anchors t
    LEFT JOIN scope_cycle_rounds m
      ON m.project_id = t.project_id AND m.anchor_date = t.anchor_date
   WHERE t.run_id = ANY(v_runs)
     AND (m.round_date IS NULL
          OR t.round_date   IS DISTINCT FROM m.round_date
          OR t.anchor_week  IS DISTINCT FROM hmg_anchor_week(m.round_date)
          OR t.anchor_month IS DISTINCT FROM hmg_anchor_month(m.round_date));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'refresh_answer_cycle_anchors: 귀속 날짜가 매핑과 어긋난 행이 %건 남았다 (배정·전파 점검)', v_bad;
  END IF;

  RETURN v_rows;
END
$fn$;--> statement-breakpoint

-- ── 자가검증 (적용 시점에 DB 가 직접 확인한다) ───────────────────────────────
-- 단위 테스트는 DB 없이 돌기 때문에 이 성질들을 **실행**으로 확인할 수 없다.
DO $selftest$
DECLARE
  v_tz  text := current_setting('TimeZone');
  v_p   uuid := '00000000-0000-0000-0000-0000000000aa';
  v_r   uuid := '00000000-0000-0000-0000-0000000000bb';
  v_k1  text;
  v_k2  text;
BEGIN
  -- ① 회차 키는 **세션 타임존과 무관**해야 한다. 0077 의 `cycle_anchor_at::text` 를
  --    그대로 저장했다면 여기서 갈린다(저장 키가 세션마다 달라져 상태 조회가 전부 미스).
  SET LOCAL TimeZone = 'UTC';
  v_k1 := hmg_cycle_key(v_p, TIMESTAMPTZ '2026-09-18 00:00:00+00', v_r);
  SET LOCAL TimeZone = 'Asia/Seoul';
  v_k2 := hmg_cycle_key(v_p, TIMESTAMPTZ '2026-09-18 00:00:00+00', v_r);
  EXECUTE format('SET LOCAL TimeZone = %L', v_tz);
  IF v_k1 IS DISTINCT FROM v_k2 THEN
    RAISE EXCEPTION '0078 자가검증 실패: hmg_cycle_key 가 세션 타임존에 따라 달라진다 (% vs %)', v_k1, v_k2;
  END IF;
  -- ② 같은 회차 시각은 같은 키, 다른 시각은 다른 키. 1초 차이도 갈려야 한다.
  IF hmg_cycle_key(v_p, TIMESTAMPTZ '2026-09-18 00:00:00+00', v_r)
     = hmg_cycle_key(v_p, TIMESTAMPTZ '2026-09-18 00:00:01+00', v_r) THEN
    RAISE EXCEPTION '0078 자가검증 실패: 1초 다른 회차 앵커가 같은 키를 받는다';
  END IF;
  -- ③ `cycle_anchor_at` 이 NULL 이면 **run 단독** 회차다 — run 이 다르면 키도 달라야 한다.
  IF hmg_cycle_key(v_p, NULL, v_r) = hmg_cycle_key(v_p, NULL, v_p) THEN
    RAISE EXCEPTION '0078 자가검증 실패: 앵커 없는 run 들이 한 회차로 뭉친다';
  END IF;
  IF hmg_cycle_key(v_p, NULL, v_r) NOT LIKE '%run:%' THEN
    RAISE EXCEPTION '0078 자가검증 실패: 단독 회차 키에 run 표식이 없다';
  END IF;
  -- ④ 프로젝트가 다르면 같은 앵커라도 다른 회차다(자리 점유는 프로젝트 단위).
  IF hmg_cycle_key(v_p, TIMESTAMPTZ '2026-09-18 00:00:00+00', v_r)
     = hmg_cycle_key(v_r, TIMESTAMPTZ '2026-09-18 00:00:00+00', v_r) THEN
    RAISE EXCEPTION '0078 자가검증 실패: 프로젝트가 달라도 같은 회차 키가 나온다';
  END IF;
END
$selftest$;--> statement-breakpoint

-- ── 적용 시점 **스모크 호출** (plpgsql 지연 검증 대비) ───────────────────────
--
-- 0077 과 같은 이유다: `EXECUTE format($q$ … $q$)` 문자열은 CREATE 시점에 파싱되지
-- 않으므로 타입·함수 부재가 **첫 호출**에서야 드러난다. 존재하지 않는 run id 하나로
-- 한 번 부르면 신규 함수 3개와 동적 SQL 전체(확장 질의 · CTE 11개 · INSERT ·
-- ON CONFLICT · DELETE)가 전부 검사된다. 쓰기는 0건이다.
DO $smoketest$
DECLARE
  v_n bigint;
  v_changed text[];
  v_all text[];
BEGIN
  IF to_regclass('public.scope_answers')            IS NULL
     OR to_regclass('public.scope_runs')            IS NULL
     OR to_regclass('public.scope_answer_anchors')  IS NULL
     OR to_regclass('public.website_sites')         IS NULL THEN
    RAISE NOTICE '0078 스모크 건너뜀: 미러 표가 아직 없다(신규 환경). 첫 싱크에서 검증된다.';
    RETURN;
  END IF;
  -- 존재하지 않는 run. 확장·CTE·INSERT·DELETE 가 전부 0행으로 돌아야 한다.
  -- plpgsql 은 **실행된 적 없는** 정적 SQL 도 파싱하지 않는다 — 조기 반환에 가려
  -- DELETE 가 한 번도 안 도는 일이 없게 여기서 직접 태운다.
  IF hmg_refresh_cycle_registry_runs(
       ARRAY['00000000-0000-0000-0000-000000000000'::uuid]) <> 0
     OR hmg_prune_cycle_registry_runs(ARRAY['0078-smoke-no-such-cycle']) <> 0 THEN
    RAISE EXCEPTION '0078 스모크 실패: 없는 run·회차로 레지스트리 요약이 움직였다';
  END IF;
  SELECT s.changed_keys, s.all_keys INTO v_changed, v_all
    FROM hmg_sync_cycle_anchor_state(
           ARRAY['00000000-0000-0000-0000-000000000000'::uuid], NULL) s;
  IF cardinality(v_changed) <> 0 OR cardinality(v_all) <> 0 THEN
    RAISE EXCEPTION '0078 스모크 실패: 없는 run 으로 회차 상태가 잡혔다';
  END IF;
  SELECT refresh_answer_cycle_anchors(
           ARRAY['00000000-0000-0000-0000-000000000000'::uuid], NULL) INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 스모크 실패: 없는 run 으로 % 행을 썼다', v_n;
  END IF;
END
$smoketest$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_cycle_key(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION refresh_answer_cycle_anchors(uuid[], uuid) FROM PUBLIC, anon, authenticated;

-- ── 적용 후 검증 (읽기 전용) ─────────────────────────────────────────────────
--   -- 1) 결함 B 회수 확인 — 감사 SQL 의 ledger_anchor_drift 가 0 으로 돌아왔는가.
--   --    돌아오지 않았으면 그 프로젝트의 run 하나로 refresh 를 부르면 회차가 넓혀진다.
--   -- 2) 한 회차가 원장 회차 둘 이상에 걸치는 규모(감사 SQL `cycle_ledger_split`, 주의 등급).
--   -- 3) 조건부 확장이 실제로 좁게 도는가 — 드레인 한 회차 기준:
--   SELECT cycle_key, expanded_count, last_expanded_at, refreshed_at
--     FROM scope_cycle_anchor_state ORDER BY expanded_count DESC LIMIT 20;
--   --    기대: 회차당 expanded_count 가 **한 자릿수**(백필 후 첫 호출 1 + 실제 변화분).
--   --    회차의 run 수만큼 늘고 있으면 조건부 판정이 매번 "달라졌다" 를 내고 있는 것이다.
--   -- 4) 상태 표 ↔ 답변 행 대조(전수, 읽기 전용):
--   SELECT count(*) FROM scope_answer_cycle_anchors c
--     JOIN scope_runs r ON r.run_id = c.run_id
--     JOIN scope_cycle_anchor_state s
--       ON s.cycle_key = hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)
--    WHERE NOT hmg_anchor_is_pinned(c.source)
--      AND (c.anchor_date, c.surface, c.source) IS DISTINCT FROM (s.anchor_date, s.surface, s.source);
--   --    기대 0. 0 이 아니면 그 회차의 run 으로 refresh 를 부르면 회수된다.
