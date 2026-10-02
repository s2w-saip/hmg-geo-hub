-- 0078 **롤백** SQL — 읽고 이해한 뒤에만 돌린다. `db:apply` 로 돌리지 않는다.
--
--   psql "$DATABASE_URL" -f scripts/db/0078-rollback.sql
--
-- 무엇을 되돌리나: 마이그레이션 0078(조건부 회차 확장 + 원장 앵커 선택 규칙)의
-- **스키마와 함수**를 0077 판으로 되돌린다. 한 트랜잭션이라 중간에 실패하면 전부 롤백된다.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ⚠️ SQL 만으로 끝나지 않는다 — **코드 되돌림 3건이 함께 가야 한다**
-- ══════════════════════════════════════════════════════════════════════════════
--
--  ① `scripts/db/answer-cycle-anchors-audit.sql` 을 **0078 이전 판(`88383fe`)으로
--     되돌린다.** 현재 판의 점검 ⑮⑯ 은 `hmg_cycle_key()`·`scope_cycle_anchor_state`·
--     `scope_cycle_registry_runs` 를 읽는다. DB 만 롤백하면 그 이름들이 사라져
--     **야간 감사 한 문장이 통째로 42883 으로 죽는다**(감사가 조용히 멈춘다 = 최악).
--         git show 88383fe:scripts/db/answer-cycle-anchors-audit.sql > scripts/db/answer-cycle-anchors-audit.sql
--     `ledger_anchor_drift` 도 그 판의 정의(행의 cycle_id 기준)로 돌아간다 — 0077 의
--     `min()` 선택 규칙과 짝이 맞는 정의다.
--     같은 이유로 `scripts/db/answer-cycle-anchors-dryrun.sql` 의 `cyc_led` 3곳도
--     `min(ledger_anchor_at)` 판으로 되돌려야 dry-run 예측이 실제와 맞는다.
--
--  ② `lib/db/schema.ts` 에서 0078·0079 등재를 되돌린다 — `scopeCycleAnchorState`·
--     `scopeCycleRegistryRuns` 두 표와 `scope_runs` 의 `scope_runs_project_cycle_idx`
--     인덱스 선언. 안 되돌리면 `npm run db:drift` 가 그 셋을 `1_MISSING_IN_DB` 로
--     보고한다(기준선이 `schema.ts` 다 — docs/development-guide.md 의 드리프트 절차).
--         git show 88383fe:lib/db/schema.ts > lib/db/schema.ts
--     ⚠️ 그 뒤 `88383fe` 이후 schema.ts 에 들어간 **다른** 변경이 있으면 함께 날아간다.
--     되돌리기 전에 `git diff 88383fe..HEAD -- lib/db/schema.ts` 로 범위를 확인할 것.
--
--  ③ `lib/db/migrations/meta/_journal.json` 에서 `idx: 67`(0078) 항목을 지운다.
--     0079(인덱스)를 함께 되돌린다면 `idx: 68` 도 지우고(②의 schema.ts 인덱스 선언도)
--     `DROP INDEX CONCURRENTLY scope_runs_project_cycle_idx;` 를 트랜잭션 **밖**에서
--     따로 돌린다(이 파일에는 넣지 않았다 — CONCURRENTLY 는 트랜잭션 안에서 금지다).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 되돌리지 **못하는 것**: 스키마는 가역, 값은 비가역
-- ══════════════════════════════════════════════════════════════════════════════
-- 0078 이 이미 다시 쓴 값(원장 혼재 6회차의 `anchor_at`·`anchor_date`)은 그대로 남는다.
-- 0077 의 `min()` 규칙으로 되돌리려면 이 파일을 돌린 **뒤** 그 회차들을 다시 refresh 해야
-- 한다(대상 run 목록: `scripts/db/answer-cycle-anchors-ledger-split-runs.sql`).
--
-- ⚠️ 아래 두 함수 본문은 **0077 파일에서 그대로 복사한 것**이다. 손으로 고치지 마라 —
-- `lib/db/migrations/0078_answer_cycle_anchor_hot_path.pglite.test.ts` 가 0077 파일의
-- 같은 문장과 **문자 단위로 대조**하므로, 한쪽만 바뀌면 테스트가 깨진다.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── (1) 0077 판 함수로 되돌린다 ──────────────────────────────────────────────
-- 시그니처가 같으므로 `CREATE OR REPLACE` 로 덮인다. `to_regprocedure` 단언·capability
-- 프로브·기존 REVOKE 가 전부 유지된다.
-- ⚠️ 이 단계를 건너뛰고 (2)~(4)만 돌리면, 남아 있는 0078 본문이 사라진 함수·표를 불러
--    미러 싱크 전부가 42883/42P01 로 죽는다.

-- >>> 0077:refresh_answer_cycle_anchors BEGIN (자동 대조 대상)
-- ── 앵커 재계산 (쓰기의 **유일한** 경로, 스펙 §4) ────────────────────────────
--
-- 이 테이블은 **수기로 고치지 않는다.** 앵커 이동 시 갱신 지점이 코어·미러·원장에
-- 이 테이블까지 넷이 되므로, 손으로 한 곳만 고치면 유령 회차가 생긴다
-- (사내 운영 규칙(adhoc-measurement) 11번 · 2026-09-11 Kia/MT 실증).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 앵커는 **회차 단위로 정하고 답변이 상속한다** (스펙 §3.1, 제품 확정 2026-09-19)
-- ══════════════════════════════════════════════════════════════════════════════
-- 회차 = 같은 프로젝트에서 같은 `scope_runs.cycle_anchor_at` 을 가진 run 들의 묶음.
-- 회차의 앵커를 **한 번** 정하고 그 회차의 모든 완료 답변이 그 값을 받는다.
--
-- 왜 답변 단위가 아닌가: 0053 레지스트리는 **날짜를 옮겨야 했던 답변만** 등록한다
-- (앵커 당일 측정분은 미등록이 정상. 부분 등록 회차 288개). 답변마다 "레지스트리 있으면
-- 그것, 없으면 run 앵커"를 적용하면 **한 회차가 쪼개진다** — 실측: Kia Mexico 는 run 17개가
-- 앵커 07-09 22:55Z 를 공유하는데 7/11~12 측정 187건만 7/10 으로 등록돼 있어 7/9(11문항)와
-- 7/10(99문항)으로 갈렸다. 같은 형태가 7개 회차·답변 791건 더 있다.
--
-- 회차 앵커 우선순위:
--   1) registry          — 회차 답변 중 **하나라도** `scope_answer_anchors` 에 있으면
--                          회차 전체가 그 `anchor`. 레지스트리는 UTC 날짜만 갖고 있어
--                          KST 이관 규칙(§9 말미)을 **회차 단위로** 탄다.
--                          ⚠️ 실측으로 회차 안 레지스트리 앵커 불일치는 0(회차 996 중
--                          레지스트리가 붙은 411)이지만, 코드는 불일치를 가정하고
--                          **가장 이른 날짜**를 결정적으로 고른다. 그런 회차는 감사
--                          SQL 의 `cycle_registry_split` 이 표면화한다.
--   2) ledger            — 회차 run 들에 귀속된 `summary_cycles.cycle_anchor_at`(가장 이른 것)
--   3) run               — 회차 키 자신(`scope_runs.cycle_anchor_at`)
--   4) fallback_measured — 위 셋이 다 없으면 그 회차 답변의 **가장 이른** `measured_at`
--                          (앵커가 어디에도 없는 run 10개·답변 415건. R4 두 프로젝트)
--
-- `cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못하므로 **run 단독**으로 취급한다
-- (회차 키에 run_id 를 섞어 다른 NULL run 과 뭉치지 않게 한다).
--
-- ── 범위 확장: 받은 run 이 아니라 그 run 이 속한 **회차 전체**를 재계산한다 ──────
-- 회차는 run 여러 개에 걸친다. `run_ids` 만 계산하면 나중에 한 run 에만 레지스트리가
-- 붙었을 때 회차의 나머지 답변이 따라오지 않는다. 그래서 먼저 `v_runs` 로 넓힌다.
--
-- ⚠️ **0053 에 행을 추가·삭제하는 수작업 접기 절차 뒤에 반드시 부른다**
-- (`docs/measured-at-anchor-registry.md`). 그 job 의 run 하나만 넘기면 되고, 이 함수가
-- 같은 회차의 나머지 run 을 알아서 끌어온다:
--     SELECT refresh_answer_cycle_anchors(
--              ARRAY(SELECT DISTINCT a.run_id FROM scope_answers a
--                     WHERE a.job_id = ANY(<손댄 job_id 들>))::uuid[],
--              '<SCOPE_ROOT_PROJECT_ID>'::uuid);
-- 부르지 않으면 회차의 나머지 답변이 옛 앵커를 든 채 남고, 야간 감사의
-- `cycle_anchor_split` 이 그 회차를 표면화한다.
--
-- 원장(0059)이 없는 DB 에서도 돌아야 하므로 조인을 동적으로 만든다 — plpgsql 은
-- 본문의 테이블을 실행 시점에 해석하므로, 정적으로 쓰면 그 환경에서 싱크가 죽는다.
--
-- ── 인자 `p_root_project_id` (B4 수리) ────────────────────────────────────────
-- 표면 판정의 'standard' 근거를 **앱이 쓰는 정본과 같은 값**으로 받는다. 종전에는
-- "원장에 그 프로젝트의 global 회차가 이미 있는가" 라는 **원장의 출력**에 기대고 있어서,
-- 원장이 아직 그 프로젝트의 global 회차를 열지 않은 창에서는 글로벌 답변이 'project'
-- 로 떨어지고 → 그 표면은 결정 ⑫ 로 anchor+1 일에 열리므로 **게이트를 우회**했다.
--
-- SQL 함수는 앱의 env 를 읽을 수 없으므로 호출부가 넘긴다:
--   · 미러 싱크  `scope-mirror.ts::prepareMirrorWrite` 가 `anchorRootProjectId()`
--   · 백필       `scripts/db/backfill-answer-cycle-anchors.ts`
--   · 원장 전파  `summary-cycles.ts`·`swap.ts` 의 전파 호출
-- **기본값을 두지 않는다** — 인자를 빠뜨린 호출은 컴파일/실행 시점에 바로 드러나야 한다.
--
-- NULL 이 오면 종전처럼 원장 기준으로 폴백하되 `RAISE NOTICE` 로 그 사실을 드러낸다
-- (mock 모드·env 미설정 환경이 여기 해당한다).
CREATE OR REPLACE FUNCTION refresh_answer_cycle_anchors(run_ids uuid[], p_root_project_id uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ledger    text;
  v_global    text;
  v_cycutc    text;
  v_deleted   bigint := 0;
  v_rows      bigint := 0;
  v_runs      uuid[];
  v_assigned  bigint := 0;
  v_moved     bigint := 0;
  v_bad       bigint := 0;
BEGIN
  IF run_ids IS NULL OR cardinality(run_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- ── 회차 전체로 범위를 넓힌다 ──────────────────────────────────────────────
  -- 상관 서브쿼리를 쓰지 않는다(프로덕션 미러에서 같은 날 statement_timeout 3회).
  -- 회차 키(프로젝트, cycle_anchor_at)를 먼저 한 번 뽑고 평 조인으로 확장한다.
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

  -- ⚠️ `v_runs` 가 비어도 **조기 반환하지 않는다.** 아래 동적 SQL 은 plpgsql 의 지연
  -- 검증 대상이라(본문 문자열은 CREATE 시점에 파싱되지 않는다) **첫 호출에서만** 타입·
  -- 함수 부재가 드러난다. 실제로 `min(uuid)` 부재가 그렇게 터졌다. 행이 0이어도 PG 는
  -- 문장을 파싱·계획하므로, 이 경로를 항상 태워야 적용 시점 스모크(아래 $smoketest$)가
  -- 의미를 갖는다. 빈 배열이면 모든 CTE 가 0행이라 쓰기도 0이다.
  IF cardinality(v_runs) > cardinality(run_ids) THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 상속으로 run %개 → %개로 넓혔다(같은 프로젝트·같은 cycle_anchor_at).',
      cardinality(run_ids), cardinality(v_runs);
  END IF;

  IF to_regclass('public.summary_cycle_runs') IS NOT NULL
     AND to_regclass('public.summary_cycles') IS NOT NULL THEN
    v_ledger := $q$
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = rr.run_id
      LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
    $q$;
    -- 0053 이관(R1 말미)의 대조 축. 레지스트리는 **UTC 날짜만** 갖고 있어 KST 날짜로
    -- 옮기려면 앵커 **시각**이 필요하다. 회차를 날짜로 접어 두고 **평 조인**한다
    -- (종전에는 답변 행마다 도는 상관 스칼라 서브쿼리였다 — 회차 단위가 되면서
    --  평가 횟수가 답변 수에서 회차 수로 줄었다).
    v_cycutc := $q$
      SELECT project_id,
             (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
             hmg_anchor_date(cycle_anchor_at)                  AS kst_date,
             cycle_anchor_at
        FROM summary_cycles
    $q$;
    -- "이 프로젝트는 글로벌(표준) 루트인가".
    --   ① 인자가 있으면 **그 값이 정본**이다(앱의 `anchorRootProjectId()` 와 같은 값).
    --   ② NULL 이면 폴백: 원장이 그 프로젝트의 회차를 'global' 로 부르는가
    --      (`summary-cycles.ts::surfaceExpr` 이 같은 env 로 판정해 기록해 둔 출력).
    v_global := $q$CASE WHEN $2 IS NOT NULL THEN rr.project_id = $2
                        ELSE EXISTS (SELECT 1 FROM summary_cycles g
                                      WHERE g.project_id = rr.project_id AND g.surface = 'global')
                   END$q$;
  ELSE
    -- 원장 없는 환경: 같은 형태의 빈 관계로 대체한다(우선순위 2가 항상 비어 있을 뿐).
    v_ledger := $q$
      LEFT JOIN (SELECT NULL::uuid AS run_id, NULL::uuid AS cycle_id) scr ON false
      LEFT JOIN (SELECT NULL::uuid AS cycle_id,
                        NULL::timestamptz AS cycle_anchor_at,
                        NULL::timestamptz AS view_anchor_at) cyc ON false
    $q$;
    -- 원장이 없으면 0053 의 UTC 날짜를 KST 로 옮길 근거도 없다 → 전부 표식 대상.
    v_cycutc := $q$SELECT NULL::uuid AS project_id, NULL::date AS utc_date,
                          NULL::date AS kst_date,
                          NULL::timestamptz AS cycle_anchor_at WHERE false$q$;
    -- ⚠️ 원장 없는 환경에서도 **인자가 있으면 standard 를 만든다**(B4 수리). 인자가
    -- NULL 이면 루트를 알아볼 근거가 없으므로 한 행도 만들지 않는다.
    v_global := $q$($2 IS NOT NULL AND rr.project_id = $2)$q$;
  END IF;

  -- 폴백으로 떨어졌다는 사실을 드러낸다(반환값은 rowcount 라 여기에 실을 수 없다).
  IF p_root_project_id IS NULL THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: p_root_project_id 가 NULL — 표면 standard 판정이 원장 출력 폴백으로 돈다(B4). 호출부가 anchorRootProjectId() 를 넘기는지 확인할 것.';
  END IF;

  EXECUTE format($q$
    WITH cyc_key AS (
      %3$s
    ), cyc_utc AS (
      -- ① 정본 규칙(§9 말미): 같은 프로젝트에서 **UTC 일자**가 그 날짜인 회차.
      --    같은 날짜에 회차가 둘이면 `min(cycle_anchor_at)` = 이른 쪽(결정론적).
      SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), cyc_kst AS (
      -- ② 폴백: UTC 일자로 못 찾았을 때만 **KST 일자**로 한 번 더 본다.
      --    실측 1건(Kia Mexico: run 앵커 07-09 22:55Z, 레지스트리 07-10)이 여기 걸린다 —
      --    ① 로는 못 찾아 원래 날짜를 유지하게 되는데, 그 값은 마침 자기 회차의 KST
      --    일자와 같다. ② 를 두면 "회차 못 찾음" 표식이 그 회차에 잘못 붙지 않는다.
      --    ① 을 먼저 보므로 캠페인처럼 **다른 회차를 가리키는** 이관은 그대로 유지된다.
      SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), run_ctx AS (
      -- run 단위 사실을 한 번만 해소한다(답변마다 6-way 조인을 하지 않는다).
      SELECT rr.run_id,
             rr.project_id,
             rr.cycle_anchor_at,
             -- 회차 키. `cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못하므로
             -- run_id 를 섞어 **run 단독**으로 가른다(다른 NULL run 과 뭉치지 않게).
             rr.project_id::text || '|' ||
               COALESCE(rr.cycle_anchor_at::text, 'run:' || rr.run_id::text) AS cycle_key,
             -- 표면 판정 = run 의 소속 프로젝트. 순서: website → standard → project.
             --
             -- ⚠️ standard 를 project **앞에** 둔다. 글로벌 루트 프로젝트('HMG Standard
             -- (root catalog)')는 `projects` 테이블에도 한 행으로 있어서, projects 를 먼저
             -- 보면 글로벌 답변 전량이 'project' 로 떨어진다(2026-09-19 dry-run 실측:
             -- sf_standard 0 · sf_project 277,260 → 바로잡으면 standard 254,223 ·
             -- website 220,027 · project 23,037). `ELSE 'standard'` 로는 루트를 못 잡는다.
             --
             -- ELSE 는 'project' 다(원장 `surfaceExpr` 의 ELSE 와 같다). 어디에도 안 걸린
             -- 프로젝트를 'standard' 로 접으면 정체 모를 답변이 **글로벌 고객 화면**에 섞인다.
             --
             -- ⚠️ 조인이 아니라 EXISTS 다: `scope_project_id` 에는 UNIQUE 가 없어서, 조인으로
             -- 쓰면 중복 1건이 run 행을 복제하고 아래 upsert 가 "ON CONFLICT DO UPDATE
             -- command cannot affect row a second time" 으로 **싱크 트랜잭션을 통째로 죽인다.**
             CASE WHEN EXISTS (SELECT 1 FROM website_sites ws
                                WHERE ws.scope_project_id = rr.project_id::text) THEN 'website'
                  WHEN %2$s THEN 'standard'
                  ELSE 'project' END            AS surface,
             scr.cycle_id                       AS cycle_id,
             cyc.cycle_anchor_at                AS ledger_anchor_at,
             cyc.view_anchor_at                 AS ledger_view_anchor_at
        FROM scope_runs rr
        %1$s
       WHERE rr.run_id = ANY($1)
         AND rr.project_id IS NOT NULL
    ), ans AS (
      SELECT a.job_id, a.run_id, a.target, a.measured_at,
             rc.project_id, rc.cycle_key, rc.cycle_anchor_at, rc.surface,
             rc.cycle_id, rc.ledger_view_anchor_at,
             reg.anchor                 AS reg_anchor,
             reg.source_measured_at     AS reg_source_measured_at,
             reg.reason                 AS reg_reason
        FROM scope_answers a
        JOIN run_ctx rc ON rc.run_id = a.run_id
        LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
       WHERE a.status = 'completed'
    ), cyc_reg AS (
      -- 회차별 레지스트리 앵커. 불일치가 있으면 **가장 이른 날짜**를 고른다(결정적).
      SELECT cycle_key,
             min(reg_anchor)                  AS reg_anchor,
             count(DISTINCT reg_anchor)::int  AS reg_variants
        FROM ans WHERE reg_anchor IS NOT NULL
       GROUP BY cycle_key
    ), cyc_led AS (
      -- 회차별 원장 앵커. 회차 run 들이 서로 다른 원장 회차에 귀속됐으면 이른 쪽.
      SELECT cycle_key,
             min(ledger_anchor_at)                 AS ledger_anchor_at,
             count(DISTINCT ledger_anchor_at)::int AS ledger_variants
        FROM run_ctx WHERE ledger_anchor_at IS NOT NULL
       GROUP BY cycle_key
    ), cyc_base AS (
      -- ⚠️ `min(project_id)` 를 쓰지 않는다 — **이 DB 에 `min(uuid)` 집계가 없다**
      -- (대상 DB PostgreSQL 17.6 에서 `pg_aggregate` 실측 0건. 상위 버전 지원 여부는
      --  확인하지 않았으므로 '이 DB 에 없다' 까지만 사실로 적는다).
      -- 그대로 두면 첫 호출에서 `42883 function min(uuid) does not exist` 로 죽는다.
      -- `project_id` 는 `cycle_key` 안에 이미 들어 있어 회차 안에서 상수이므로
      -- **GROUP BY 키로 빼면** 집계가 필요 없다(함수 의존이라 그룹이 쪼개지지 않는다).
      SELECT cycle_key,
             project_id,
             min(cycle_anchor_at) AS run_anchor_at,
             min(measured_at)     AS fallback_at
        FROM ans GROUP BY cycle_key, project_id
    ), cyc_res AS (
      SELECT b.cycle_key,
             b.project_id,
             r.reg_anchor, r.reg_variants, l.ledger_variants,
             CASE WHEN r.reg_anchor      IS NOT NULL THEN 'registry'
                  WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
                  WHEN b.run_anchor_at   IS NOT NULL THEN 'run'
                  WHEN b.fallback_at     IS NOT NULL THEN 'fallback_measured'
             END AS source,
             -- 앵커 시각 원문. registry 는 **UTC 날짜**뿐이라(0053) 그 날짜에 해당하는
             -- 회차 시각을 찾아 쓰고, 못 찾으면 그 날짜의 앵커 타임존 자정으로 되살린다 —
             -- 어느 쪽이든 hmg_anchor_date(anchor_at) = anchor_date 가 유지된다.
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(u.cycle_anchor_at, k.cycle_anchor_at,
                                  (r.reg_anchor::timestamp AT TIME ZONE hmg_anchor_timezone()))
                  WHEN l.ledger_anchor_at IS NOT NULL THEN l.ledger_anchor_at
                  WHEN b.run_anchor_at    IS NOT NULL THEN b.run_anchor_at
                  ELSE b.fallback_at END AS anchor_at,
             -- 0053 이관(R1 말미): 회차를 찾았으면 그 시각을 **KST 로 다시 잘라** 쓴다.
             -- 못 찾았으면 원래 UTC 날짜를 그대로 두되 아래 reason 에 표식을 남긴다.
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(hmg_anchor_date(u.cycle_anchor_at),
                                  hmg_anchor_date(k.cycle_anchor_at), r.reg_anchor)
                  WHEN l.ledger_anchor_at IS NOT NULL THEN hmg_anchor_date(l.ledger_anchor_at)
                  WHEN b.run_anchor_at    IS NOT NULL THEN hmg_anchor_date(b.run_anchor_at)
                  ELSE hmg_anchor_date(b.fallback_at) END AS anchor_date,
             (r.reg_anchor IS NOT NULL
              AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL) AS reg_utc_kept
        FROM cyc_base b
        LEFT JOIN cyc_reg r ON r.cycle_key = b.cycle_key
        LEFT JOIN cyc_led l ON l.cycle_key = b.cycle_key
        LEFT JOIN cyc_utc u ON u.project_id = b.project_id AND u.d = r.reg_anchor
        LEFT JOIN cyc_kst k ON k.project_id = b.project_id AND k.d = r.reg_anchor
    ), cyc_map AS (
      -- 귀속 날짜를 **회차 단위로 한 번만** 조회한다(답변마다 부르지 않는다).
      -- 아직 배정되지 않은 새 회차는 `anchor_date` 가 잠정값으로 들어오고, 아래
      -- 배정 -> 전파 단계가 같은 트랜잭션에서 고친 뒤 일치를 단언한다.
      SELECT c.*, hmg_round_date_of(c.project_id, c.anchor_date) AS round_date
        FROM cyc_res c
    )
    INSERT INTO scope_answer_cycle_anchors AS t (
      job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week,
      anchor_month, measured_at_orig, is_default_engine,
      round_date, view_anchor_date, ledger_view_anchor_date,
      cycle_id, source, source_measured_at, reason, updated_at
    )
    SELECT a.job_id, a.run_id, a.project_id, a.surface, c.anchor_at, c.anchor_date,
           -- 주·월은 **귀속 날짜 기준**이다(스펙 §9 "귀속").
           hmg_anchor_week(c.round_date),
           hmg_anchor_month(c.round_date),
           -- 대표 답변 정렬 키(§2-16). 접기 **이전** 원본 시각이 정본이고, 없으면
           -- 현재 measured_at, 그것도 NULL 이면 회차 앵커 시각(컬럼이 NOT NULL 이다).
           COALESCE(a.reg_source_measured_at, a.measured_at, c.anchor_at),
           -- 기본 타겟 여부(§2-17). 목록은 `hmg_anchor_default_engines()` 한 곳.
           (a.target = ANY(hmg_anchor_default_engines())),
           -- 귀속 날짜. 매핑이 있으면 그 값, 없으면 `anchor_date` 잠정값이다.
           c.round_date,
           -- ── 노출 게이트 (스펙 §3.3 + §9 "노출" 행) ────────────────────────
           -- 산식의 정본은 **`hmg_anchor_view_date()` 한 곳**이다(위 함수 주석에 ①②).
           -- 여기서 CASE 를 한 벌 더 쓰면 `ON CONFLICT` 의 보존 경로와 갈린다(N-1).
           --
           -- ⚠️ 이것은 **시간 게이트만**이다. 숨김(0070 `hidden_reason`·0071
           -- `hidden_scope`)은 이 테이블에 복사하지 않는다(R3) — 리더가 `cycle_id` 로
           -- 원장을 조인해 따로 AND 한다(`scope-answer-anchors.ts::anchorNotHiddenSql`).
           --
           -- ⚠️ 결정 ⑪(비어 있는 view_anchor 를 앵커 날짜로 채움)은 **철회됐다**.
           hmg_anchor_view_date(a.surface, c.anchor_date,
                                hmg_anchor_date(a.ledger_view_anchor_at)),
           hmg_anchor_date(a.ledger_view_anchor_at),
           a.cycle_id, c.source,
           -- 접기 이전 원본 measured_at 은 0053 seed 에서만 온다(스펙 §3 컬럼 주석).
           a.reg_source_measured_at,
           -- 0053 이관 표식: 회차를 못 찾아 **UTC 날짜를 그대로 유지한** 회차의 답변에
           -- reason 접미로 드러낸다(감사 SQL 이 이 문자열을 센다).
           CASE WHEN c.reg_utc_kept
                  THEN COALESCE(a.reg_reason || ' ', '') || '[anchor-tz:utc-date-kept]'
                ELSE a.reg_reason END,
           now()
      FROM ans a JOIN cyc_map c ON c.cycle_key = a.cycle_key
     WHERE c.source IS NOT NULL
    ON CONFLICT (job_id) DO UPDATE SET
      run_id      = EXCLUDED.run_id,
      project_id  = EXCLUDED.project_id,
      surface     = EXCLUDED.surface,
      -- 보존 가드는 `hmg_anchor_keep_existing` 한 곳에서 판정한다(BLOCK-2②).
      anchor_at   = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_at   ELSE EXCLUDED.anchor_at   END,
      anchor_date = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_date ELSE EXCLUDED.anchor_date END,
      -- 귀속 날짜와 그 파생 키. 보존 경로는 **보존된 anchor_date** 의 자리를 쓴다
      -- (노출일이 N-1 에서 그랬던 것과 같은 이유 — 앵커가 보존됐는데 파생만 새 앵커
      --  기준으로 계산되면 한 행 안에서 축이 갈린다).
      round_date  = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_round_date_of(t.project_id, t.anchor_date)
                         ELSE EXCLUDED.round_date END,
      anchor_week = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_week(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_week END,
      anchor_month= CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_month(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_month END,
      -- 대표 정렬 키·엔진 구분은 **답변 단위 사실**이라 보존 가드 밖이다(앵커가 아니다).
      measured_at_orig  = EXCLUDED.measured_at_orig,
      is_default_engine = EXCLUDED.is_default_engine,
      source      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source      ELSE EXCLUDED.source      END,
      source_measured_at = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source_measured_at ELSE EXCLUDED.source_measured_at END,
      reason      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.reason      ELSE EXCLUDED.reason      END,
      -- N-1: 노출일은 **보존된 anchor_date 기준**으로 다시 계산한다. 종전에는
      -- `EXCLUDED.view_anchor_date` 를 그대로 받아, 접기로 날짜가 보존된 project 표면
      -- 행의 노출일만 자동 앵커 +1일이 되어 자기 anchor_date 와 어긋났다.
      view_anchor_date = CASE
        WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
          THEN hmg_anchor_view_date(
                 EXCLUDED.surface, t.anchor_date, EXCLUDED.ledger_view_anchor_date)
        ELSE EXCLUDED.view_anchor_date END,
      ledger_view_anchor_date = EXCLUDED.ledger_view_anchor_date,
      cycle_id    = EXCLUDED.cycle_id,
      updated_at  = now()
    -- 변경 감지 — 값이 실제로 달라진 행만 쓴다(멱등).
    -- ⚠️ `view_anchor_date` 는 위에서 t 기준으로 재계산되므로 EXCLUDED 와 직접 비교하면
    --    보존 행에서 매번 "바뀐 것처럼" 보인다. 그래서 원장 입력(`ledger_view_anchor_date`)
    --    을 비교 축으로 쓴다. 산식이 시간에 의존하지 않으므로(⑪ 철회) 그 축과
    --    `surface`·`anchor_date` 만 보면 노출일 변화를 전부 잡는다(N-12 구조적 차단).
    WHERE (t.run_id, t.project_id, t.surface, t.ledger_view_anchor_date, t.cycle_id,
           t.measured_at_orig, t.is_default_engine)
            IS DISTINCT FROM
          (EXCLUDED.run_id, EXCLUDED.project_id, EXCLUDED.surface,
           EXCLUDED.ledger_view_anchor_date, EXCLUDED.cycle_id,
           EXCLUDED.measured_at_orig, EXCLUDED.is_default_engine)
       -- N-2: 주·월도 감지 대상이다. 빠져 있으면 주·월 산식만 바뀐 경우
       -- `--recompute` 로도 갱신되지 않는다(감사 ⑧ 은 잡지만 고칠 수단이 없다).
       OR (NOT hmg_anchor_keep_existing(t.source, EXCLUDED.source)
           AND (t.anchor_at, t.anchor_date, t.anchor_week, t.anchor_month,
                t.source, t.source_measured_at, t.reason)
                 IS DISTINCT FROM
               (EXCLUDED.anchor_at, EXCLUDED.anchor_date, EXCLUDED.anchor_week,
                EXCLUDED.anchor_month, EXCLUDED.source,
                EXCLUDED.source_measured_at, EXCLUDED.reason))
  $q$, v_ledger, v_global, v_cycutc) USING v_runs, p_root_project_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- 귀속 배정은 삭제 뒤에 돌린다(아래). 종전의 함대 대표일 패스
  -- (`hmg_refresh_fleet_round_dates`, 최빈값 규칙)는 정규 요일 귀속으로
  -- **대체돼 삭제**됐다 — 그 패스가 가졌던 B5(떠난 주 미재계산)도 함께 사라졌다.

  -- ── 삭제·원복 전파 (B8) ────────────────────────────────────────────────────
  -- upsert 는 "지금 completed 인 답변"만 본다. 그래서 **사라진 쪽**은 스스로 정리되지
  -- 않는다: 상태가 completed 에서 벗어난 job, 0054 드롭이 미러에서 뺀 job, 0053 행을
  -- 지우는 방식의 접기 원복이 그렇다. 그 행들이 남으면 전수 계약이 위에서 깨진다
  -- (테이블 행 수 > completed 답변 수).
  --
  -- 정책(스펙 §9): **자동 삭제는 이 범위에서만** 한다 —
  --   · 범위 = 방금 재계산한 run 들(= 회차 전체로 넓힌 `v_runs`)
  --   · 대상 = 더 이상 completed 가 아닌 job 의 행
  --   · **고정(pinned) 출처는 지우지 않는다** — `registry`(0053 수작업 접기)는
  --     사람이 정한 값이라 자동으로 지우면 복구 근거가 사라진다
  --     (0053·0054 와 같은 규율). 대신 감사 SQL(`answer-cycle-anchors-audit.sql`)이
  --     고아로 표면화한다.
  DELETE FROM scope_answer_cycle_anchors t
   WHERE t.run_id = ANY(v_runs)
     AND NOT hmg_anchor_is_pinned(t.source)
     AND NOT EXISTS (SELECT 1 FROM scope_answers a
                      WHERE a.job_id = t.job_id AND a.status = 'completed');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: completed 에서 벗어났거나 드롭된 job 의 비고정(pinned 아님) 앵커 행 %건을 지웠다(B8).', v_deleted;
  END IF;

  -- ── 정규 요일 귀속: 배정 → 전파 → 단언 ────────────────────────────────────
  -- 삭제 **뒤**에 돈다. 먼저 배정하면 방금 사라질 회차에 자리를 내주게 된다.
  --
  -- 배정은 **미배정 회차만** 새로 앉힌다(과거 값 안정성). 전파는 값이 실제로 다른
  -- 행만 쓰므로 정상 상태에서 0행이다.
  v_assigned := hmg_assign_cycle_rounds(v_runs, NULL);
  v_moved    := hmg_propagate_cycle_rounds(v_runs, NULL);
  IF v_assigned > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 %개를 정규 요일 자리에 새로 배정했다(답변 %행에 전파).',
      v_assigned, v_moved;
  END IF;

  -- 잠정값이 밖으로 새지 않는지 **같은 트랜잭션에서** 못박는다. upsert 는 매핑이
  -- 없는 새 회차에 `anchor_date` 를 잠정으로 넣으므로, 배정·전파가 하나라도 빠지면
  -- 기간 술어가 귀속 날짜가 아닌 값을 본다(화면만 봐서는 안 보이는 형태다).
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
$fn$;
-- <<< 0077:refresh_answer_cycle_anchors END

-- `hmg_propagate_cycle_rounds` 도 0078 이 교체했다(회차 상태 표까지 함께 맞추도록).
-- 상태 표가 사라지므로 0077 판으로 되돌려야 한다.
-- >>> 0077:hmg_propagate_cycle_rounds BEGIN (자동 대조 대상)
-- == 매핑 -> 답변 행 **전파** ================================================
--
-- `round_date` 와 그 파생 키(`anchor_week`/`anchor_month`)를 매핑 표에서 복사한다.
-- 값이 실제로 다른 행만 쓴다(멱등, 정상 상태에서 0행).
--
-- 범위 인자는 배정 함수와 같은 규칙이다 - run 축(증분) 또는 project 축(전수).
CREATE OR REPLACE FUNCTION hmg_propagate_cycle_rounds(p_run_ids uuid[], p_project_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_n bigint := 0;
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
  ELSE
    RAISE EXCEPTION 'hmg_propagate_cycle_rounds: p_run_ids 와 p_project_ids 가 둘 다 NULL 이다';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;
-- <<< 0077:hmg_propagate_cycle_rounds END

-- ── (2) 0078 전용 함수 제거. (1) 이후여야 의존이 없다 ───────────────────────
DROP FUNCTION IF EXISTS hmg_sync_cycle_anchor_state(uuid[], uuid);
DROP FUNCTION IF EXISTS hmg_prune_cycle_registry_runs(text[]);
DROP FUNCTION IF EXISTS hmg_refresh_cycle_registry_runs(uuid[]);

-- ── (3) 상태·요약 표 제거 ───────────────────────────────────────────────────
-- `scope_answer_cycle_anchors`·`scope_cycle_rounds` 는 건드리지 않는다
-- (0078 은 그 두 표의 스키마도 행도 바꾸지 않았다).
DROP TABLE IF EXISTS scope_cycle_anchor_state;
DROP TABLE IF EXISTS scope_cycle_registry_runs;

-- ── (4) 회차 키 함수는 (3) 뒤에 지운다 ──────────────────────────────────────
DROP FUNCTION IF EXISTS hmg_cycle_key(uuid, timestamptz, uuid);

-- ── (5) 되돌림 확인 (읽기 전용, 같은 트랜잭션에서) ──────────────────────────
DO $rb$
BEGIN
  IF to_regprocedure('public.refresh_answer_cycle_anchors(uuid[], uuid)') IS NULL THEN
    RAISE EXCEPTION '롤백 실패: refresh_answer_cycle_anchors 가 없다 — (1) 붙여넣기 누락';
  END IF;
  IF to_regprocedure('public.hmg_propagate_cycle_rounds(uuid[], uuid[])') IS NULL THEN
    RAISE EXCEPTION '롤백 실패: hmg_propagate_cycle_rounds 가 없다';
  END IF;
  IF to_regclass('public.scope_cycle_anchor_state') IS NOT NULL
     OR to_regclass('public.scope_cycle_registry_runs') IS NOT NULL THEN
    RAISE EXCEPTION '롤백 실패: 0078 표가 남아 있다';
  END IF;
  IF to_regprocedure('public.hmg_cycle_key(uuid, timestamptz, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '롤백 실패: hmg_cycle_key 가 남아 있다';
  END IF;
  -- 0077 스모크와 같은 호출(없는 run → 0행). 0078 본문이 남아 있으면 여기서 죽는다.
  IF (SELECT refresh_answer_cycle_anchors(
        ARRAY['00000000-0000-0000-0000-000000000000'::uuid], NULL)) <> 0 THEN
    RAISE EXCEPTION '롤백 실패: 0077 스모크가 0행이 아니다';
  END IF;
END
$rb$;

COMMIT;
