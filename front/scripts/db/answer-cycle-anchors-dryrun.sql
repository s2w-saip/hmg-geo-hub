-- 0077 백필 dry-run — **읽기 전용**. 쓰기·DDL 이 한 줄도 없다.
--
-- 무엇: `scope_answer_cycle_anchors` 가 아직 없어도, 백필이 만들 결과를 CTE 로 그대로
-- 계산해 스펙 §6-3 수용 기준의 예상치를 낸다. 테이블·`hmg_anchor_*()` 함수가 없는
-- 상태에서 돌 수 있도록 **같은 산술을 이 파일 안에 인라인**했다.
--
-- ── prelude 1개 + 문장 5개 ───────────────────────────────────────────────────
-- Supabase MCP(읽기 전용, statement_timeout 약 2분)에서 돌 수 있게 나눴다. 문장 경계는
-- `-- @@statement <이름>` 줄이다(백필 스크립트가 이 줄로 자른다).
--
-- ⚠️ 맨 앞의 `-- @@prelude` 블록은 **문장이 아니라 공통 머리**다. 백필 스크립트가 매
-- 문장 앞에 붙여 실행하고, 사람이 SQL Editor 에 붙여넣을 때도 **prelude + 고른 문장**을
-- 함께 붙여넣는다. 이렇게 두는 이유는 하나뿐이다 — 타임존 상수를 **이 파일에 한 번만**
-- 적기 위해서다(종전에는 문장마다 한 벌씩 총 2벌이었다. B12).
--
--   S1 coverage  전수(completed 대비 산출 행)·제외분·출처별·surface 별 (**회차 단위 상속**)
--   S2 registry  0053 레지스트리 정합(KST 이관 결과·고아) + 접기 원복 여부
--   S3 gate      **표면별 한 행.** 노출 게이트(view_null 을 '회차 없음' / '회차는 있는데
--                view_anchor_at 없음' 으로 분해 · 미래) + 측정일≠앵커일
--   S4 cycles    **회차 입도.** 회차 수·출처별·회차 안 레지스트리 불일치(기대 0)·
--                답변 단위였다면 갈렸을 회차 수·레지스트리 이관 분류 3종·
--                (프로젝트, KST 주) 안 앵커 날짜 둘 이상(기대 0)
--   S5 rounds    **정규 요일 귀속의 1차 근사.** 정규 요일 회차 수·비정규 회차 수(표면별)·
--                basis 분포 추정·합쳐진 자리 추정·이동 일수. ⚠️ 비정규 회차끼리의 자리
--                경합(`est_collisions`)은 차례 배정이라 SQL 로 못 흉내 낸다 — 그 수가
--                0 이 아니면 이 분포는 추정이고 정확한 값은 적용 후에 나온다.
--
-- ── 무겁지 않게 만든 방법 ────────────────────────────────────────────────────
-- 표면·원장 앵커·run 앵커·view_anchor 는 **run 단위 사실**이다. 그래서 먼저 run 을
-- 한 번만 해소하고(`run_ctx`, 약 2.8만 행) 답변(수십만 행)에는 그 결과 하나만 조인한다.
-- 답변마다 6-way 조인을 하지 않는다. 상관 서브쿼리는 없다 — 스칼라 집계도 전부
-- 같은 패스의 `count(*) FILTER` 다(같은 DB 에서 CTE 를 반복 스캔하는 상관 서브쿼리가
-- 57014 로 취소된 전례가 있다). S2 는 레지스트리(약 15만 행)에서 출발해 더 작다.
--
-- ── 타임존 (결정 R1 = KST, 제품 책임자 2026-09-19 저녁) ────────────────────────────
-- 이 파일의 zone 상수는 **prelude 의 `tz` CTE 한 곳**뿐이고, 마이그레이션 0077 의
-- `hmg_anchor_timezone()` 과 같은 값이어야 한다(단위 테스트가 이 둘을 대조해 고정한다).
-- 뒤집으려면 그 한 줄 + 0077 함수 한 줄, 둘만 바꾼다.
--
-- 왜 `hmg_anchor_date()` 를 부르지 않고 산술을 인라인했는가: 이 SQL 은 **0077 적용 전**
-- 예상치를 내는 용도라 그 함수가 아직 없을 수 있다. 그래서 같은 산술을 여기 한 번 적는다.
--
-- ⚠️ 읽기 전용 보장은 세션에서 건다(Supavisor 가 startup 파라미터를 버린다):
--      BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '2min';
--      <문장>
--      COMMIT;
--
-- ── 읽는 법 (스펙 §6-3) ──────────────────────────────────────────────────────
--   S1  completed_answers = rows_out + no_run_row + excluded_null_project + no_source
--       (백필 `verify()`·`census()` 와 **같은 분해**여야 한다 — BLOCK-4)
--       no_run_row             `scope_runs` 에 행이 없는 completed 답변(미러 고아).
--                              INNER JOIN 으로 묶으면 이 항이 모수에서 통째로 사라진다.
--       excluded_null_project  `scope_runs.project_id` NULL 이라 빠지는 답변.
--                              0 이면 0077 의 project_id 를 NOT NULL 로 승격할 수 있다.
--       no_source              네 출처가 모두 없는 답변(= measured_at 까지 NULL).
--                              **0 이 아니면 `--apply` 가 시작 전에 중단된다**(BLOCK-3 게이트).
--   S2  R1(KST) 이관 — 0053 의 `anchor` 는 **UTC 날짜**이고 새 `anchor_date` 는 KST 다.
--       registry_shifted       **0 이 기대값이 아니다.** 같은 프로젝트에서 UTC 일자가 그
--                              날짜인 회차를 찾아 그 시각을 KST 로 다시 자른 결과, 0053 의
--                              날짜와 하루 달라진 행 수다(스펙 §9 R1 말미 = 이관된 행).
--       registry_utc_kept      회차를 못 찾아 UTC 날짜를 **그대로 유지한** 행. 0077 이
--                              reason 에 `[anchor-tz:utc-date-kept]` 표식을 남긴다 —
--                              감사 대상이므로 적을수록 좋다.
--       registry_orphans       0053 에는 있는데 completed 답변이 없는 job(드롭·미완료). 참고.
--       registry_unfolded      **기대 0.** 미러 `measured_at` 의 UTC 일자 ≠ `anchor` —
--                              재싱크가 접기를 되돌린 흔적(2026-08-31 사고의 지문).
--                              0053 접기가 UTC 축이라 이 대조도 UTC 로 한다(KST 아님).
--       registry_vs_auto       참고. 레지스트리가 없었다면 받았을 날짜(원장→run)와 다른 행.
--                              스펙 §1.4 의 "의도적으로 다른 행 24,650" 과 같은 축의 수다.
--       sf_unclassified        **기대 0.** website·원장 global·projects 어디에도 없는 프로젝트.
--
-- ⚠️ 표면 'standard' 판정의 근거가 이 SQL 과 0077 함수에서 **다를 수 있다**(B4).
--    0077 의 `refresh_answer_cycle_anchors(run_ids, p_root_project_id)` 는 인자로 받은
--    루트 프로젝트 id 를 정본으로 쓰고, 인자가 NULL 일 때만 "원장에 global 회차가
--    있는가" 폴백으로 떨어진다. 이 SQL 은 독립 실행(SQL Editor 붙여넣기)이 전제라
--    env 를 읽을 수 없으므로 **항상 폴백 쪽**이다. 두 결과가 갈리면 그 차이는
--    "원장이 아직 그 프로젝트의 global 회차를 열지 않았다" 를 뜻한다 — 그 경우
--    실제 백필 결과(인자 있음)가 맞고, 이 dry-run 의 sf_standard 가 과소다.
--   S3  표면별 한 행.
--       ledger_view_missing = view_null_no_cycle + view_null_cycle_unpublished  (원장 사실만)
--         no_cycle 은 run 이 회차에 귀속되지 않은 것, cycle_unpublished 는 회차는 있는데
--         `view_anchor_at` 이 아직 안 찍힌 것이다.
--       view_null 은 그중 **실제로 비노출이 되는** 수다 — 결정 ⑫ 로 project 표면은
--         anchor+1 일이 들어가므로 0 이어야 한다. 결정 ⑪(채움)은 철회돼 분기가 없다.
--       2026-09-19 운영 담당 실측(원장 기준 분해): standard 32,479·website 3,441 전부
--         cycle_unpublished, project 23,037 중 no_cycle 418·cycle_unpublished 22,619.

-- @@prelude
-- 이 파일의 **유일한** 타임존 상수(R1 = KST). 문장마다 앞에 붙는다.
-- S1 은 날짜 산술이 없어 `tz` 를 안 쓰지만, prelude 를 문장별로 가르면 상수가 다시
-- 두 벌이 되므로 그대로 둔다(참조되지 않는 CTE 는 평가되지 않는다).
WITH tz AS (SELECT 'Asia/Seoul'::text AS zone),
-- 기본 측정 엔진(ChatGPT·Gemini). 정본은 `lib/scope/engines.ts DEFAULT_AI_ENGINES` 이고
-- 0077 의 사본은 `hmg_anchor_default_engines()` 다. 이 SQL 은 **적용 전**에 돌아야 해서
-- 그 함수를 부를 수 없으므로 여기 한 벌을 둔다(단위 테스트가 세 곳을 대조한다).
de AS (SELECT ARRAY['chatgpt', 'gemini']::text[] AS engines),
-- 회차 **정규 요일**(글로벌=월요일 1 · 웹사이트=금요일 5, ISO 요일 번호). 정본은 0077 의
-- `hmg_round_canonical_dow()` 이고, 같은 이유(적용 전에 돌아야 한다)로 여기 한 벌을 둔다.
-- 프로젝트 표면은 정규 요일이 없어 이 표에 없다(LEFT JOIN 이 NULL 을 준다).
cw AS (SELECT * FROM (VALUES ('standard', 1), ('website', 5)) AS v(surface, dow))

-- @@statement S1_coverage
, cyc_key AS (
  -- 회차를 **날짜 두 축**으로 접어 둔다(0053 이관 대조용). 0077 의 cyc_utc/cyc_kst 와 같다.
  SELECT project_id,
         (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
         (cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date AS kst_date,
         cycle_anchor_at
    FROM summary_cycles
), cyc_utc AS (
  SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), cyc_kst AS (
  SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), run_ctx AS (
  SELECT r.run_id,
         r.project_id,
         -- **회차 키**(스펙 §3.1) = 프로젝트 + cycle_anchor_at. NULL 이면 run 단독.
         r.project_id::text || '|' ||
           COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
         -- 표면 판정 = run 의 소속 프로젝트(qa-review.ts::RUN_SURFACE_CTE 와 같은 규칙).
         -- `scope_project_id` 에 UNIQUE 가 없어 그냥 조인하면 중복 1건이 행을 복제한다 —
         -- 그래서 DISTINCT 로 접은 집합에 조인한다(0077 의 함수는 같은 이유로 EXISTS 다).
         -- 순서: website → standard(원장이 'global' 로 부르는 프로젝트) → project.
         -- 글로벌 루트는 `projects` 에도 한 행이 있어 projects 를 먼저 보면 전량 'project'
         -- 로 떨어진다(2026-09-19 실측 sf_standard 0). 0077 의 함수와 같은 순서다.
         -- 함수는 마지막을 ELSE 'project' 로 접지만, 여기서는 **projects 에도 없는** 행을
         -- NULL 로 남겨 `sf_unclassified` 로 센다(기대 0).
         CASE WHEN ws.scope_project_id IS NOT NULL THEN 'website'
              WHEN gl.project_id       IS NOT NULL THEN 'standard'
              WHEN p.scope_project_id  IS NOT NULL THEN 'project'
         END                                      AS surface,
         cyc.cycle_anchor_at                      AS ledger_anchor_at,
         r.cycle_anchor_at                        AS run_anchor_at
    FROM scope_runs r
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM website_sites
                WHERE scope_project_id IS NOT NULL) ws ON ws.scope_project_id = r.project_id::text
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM projects
                WHERE scope_project_id IS NOT NULL) p  ON p.scope_project_id  = r.project_id
    LEFT JOIN (SELECT DISTINCT project_id FROM summary_cycles
                WHERE surface = 'global') gl ON gl.project_id = r.project_id
    LEFT JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
    LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
), ans AS (
  -- ⚠️ **LEFT JOIN** 이다(BLOCK-4). INNER 로 묶으면 `scope_runs` 에 행이 없는 completed
  -- 답변이 `completed_answers` 에서 통째로 빠져, 백필 `verify()` 의 분해와 모수가
  -- 달라진다. 그 답변은 `no_run_row` 로 따로 센다.
  SELECT (rc.run_id IS NOT NULL) AS has_run,
         rc.project_id, rc.surface, rc.cycle_key, rc.run_anchor_at,
         a.measured_at, reg.anchor AS reg_anchor
    FROM scope_answers a
    LEFT JOIN run_ctx rc ON rc.run_id = a.run_id
    LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
   WHERE a.status = 'completed'
), cyc_reg AS (
  -- 회차별 레지스트리 앵커(가장 이른 값) + 회차 안 변이 수.
  SELECT cycle_key, min(reg_anchor) AS reg_anchor, count(DISTINCT reg_anchor)::int AS reg_variants
    FROM ans WHERE reg_anchor IS NOT NULL AND cycle_key IS NOT NULL AND project_id IS NOT NULL
   GROUP BY cycle_key
), cyc_led AS (
  -- 원장 출처 앵커 선택(0078). **min 이 아니다** — 한 회차의 run 이 원장 회차 둘에
  -- 걸치면 min 은 09-19 에 생성된 **유령 회차**(옛 스케줄 앵커)를 고른다
  -- (2026-09-20 실측: website 6개 프로젝트·1,704행이 그래서 09-17 로 기록됐다).
  --   ① 원장 앵커가 그 회차의 scope_runs.cycle_anchor_at 과 **같은** 원장 회차
  --   ② 없으면 그 회차에서 **run 수가 가장 많은** 원장 회차
  --   ③ 동수면 **이른** 앵커 (= 종전 min 으로 수렴)
  -- `bool_or` 안에서는 그룹 밖 컬럼(run_anchor_at)을 참조해도 된다(집계 인자다).
  SELECT DISTINCT ON (cycle_key) cycle_key, ledger_anchor_at
    FROM (
      SELECT cycle_key, ledger_anchor_at, count(*) AS runs,
             bool_or(ledger_anchor_at IS NOT DISTINCT FROM run_anchor_at) AS matches_run
        FROM run_ctx
       WHERE ledger_anchor_at IS NOT NULL AND project_id IS NOT NULL
       GROUP BY 1, 2
    ) g
   ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
), cyc_base AS (
  -- ⚠️ `min(project_id)` 금지 — 이 DB 에 `min(uuid)` 집계가 없다(PostgreSQL 17.6).
  -- project_id 는 cycle_key 안에 들어 있어 회차 안 상수이므로 GROUP BY 키로 뺀다.
  SELECT cycle_key, project_id,
         min(run_anchor_at) AS run_anchor_at, min(measured_at) AS fallback_at
    FROM ans WHERE cycle_key IS NOT NULL AND project_id IS NOT NULL
   GROUP BY cycle_key, project_id
), cyc_res AS (
  -- **회차 단위 상속**(스펙 §3.1). 0077 의 cyc_res 와 같은 우선순위·같은 이관 규칙이다.
  SELECT b.cycle_key, b.project_id, r.reg_anchor, r.reg_variants, b.run_anchor_at,
         CASE WHEN r.reg_anchor       IS NOT NULL THEN 'registry'
              WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
              WHEN b.run_anchor_at    IS NOT NULL THEN 'run'
              WHEN b.fallback_at      IS NOT NULL THEN 'fallback_measured'
         END AS source,
         CASE WHEN r.reg_anchor IS NOT NULL
                THEN COALESCE((u.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              (k.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              r.reg_anchor)
              WHEN l.ledger_anchor_at IS NOT NULL
                THEN (l.ledger_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              WHEN b.run_anchor_at IS NOT NULL
                THEN (b.run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              ELSE (b.fallback_at AT TIME ZONE (SELECT zone FROM tz))::date
         END AS anchor_date,
         (r.reg_anchor IS NOT NULL AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL)
           AS reg_utc_kept,
         COALESCE(u.cycle_anchor_at, k.cycle_anchor_at) AS reg_target_at
    FROM cyc_base b
    LEFT JOIN cyc_reg r ON r.cycle_key = b.cycle_key
    LEFT JOIN cyc_led l ON l.cycle_key = b.cycle_key
    LEFT JOIN cyc_utc u ON u.project_id = b.project_id AND u.d = r.reg_anchor
    LEFT JOIN cyc_kst k ON k.project_id = b.project_id AND k.d = r.reg_anchor
), resolved AS (
  SELECT a.has_run, a.project_id, a.surface, c.source
    FROM ans a LEFT JOIN cyc_res c ON c.cycle_key = a.cycle_key
)
SELECT
  count(*)                                                        AS completed_answers,
  count(*) FILTER (WHERE source IS NOT NULL)                      AS rows_out,
  -- 분해 네 항: rows_out + no_run_row + excluded_null_project + no_source = completed
  count(*) FILTER (WHERE NOT has_run)                             AS no_run_row,
  count(*) FILTER (WHERE has_run AND project_id IS NULL)          AS excluded_null_project,
  count(*) FILTER (WHERE has_run AND project_id IS NOT NULL AND source IS NULL) AS no_source,
  count(*) FILTER (WHERE source = 'registry')                     AS src_registry,
  count(*) FILTER (WHERE source = 'ledger')                       AS src_ledger,
  count(*) FILTER (WHERE source = 'run')                          AS src_run,
  count(*) FILTER (WHERE source = 'fallback_measured')            AS src_fallback_measured,
  count(*) FILTER (WHERE source IS NOT NULL AND surface = 'standard') AS sf_standard,
  count(*) FILTER (WHERE source IS NOT NULL AND surface = 'website')  AS sf_website,
  count(*) FILTER (WHERE source IS NOT NULL AND surface = 'project')  AS sf_project,
  -- 기대 0. website·원장 global·projects 어디에도 없는 프로젝트의 답변.
  -- (0077 의 함수는 이 행들을 'project' 로 접는다 — 0 이 아니면 그 수만큼 project 가 는다.)
  count(*) FILTER (WHERE source IS NOT NULL AND surface IS NULL)      AS sf_unclassified
FROM resolved;

-- @@statement S2_registry
, cyc_utc AS (
  -- 회차를 **UTC 일자**로 접은 소집합. `AT TIME ZONE INTERVAL '0'` = 오프셋 0 산술이라
  -- 앵커 타임존 상수(prelude 의 tz)와 무관하다 — 0053 이 UTC 날짜를 쓰기 때문에 필요한
  -- 대조 축이고, 0077 의 `hmg_anchor_utc_midnight` 과 같은 의미다.
  SELECT project_id,
         (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
         min(cycle_anchor_at) AS cycle_anchor_at
    FROM summary_cycles
   GROUP BY 1, 2
),
reg AS (
  SELECT g.job_id,
         g.anchor,
         a.job_id                AS answer_job_id,
         a.measured_at,
         r.project_id,
         cyc.cycle_anchor_at     AS ledger_anchor_at,
         r.cycle_anchor_at       AS run_anchor_at,
         rc.cycle_anchor_at      AS reg_cycle_anchor_at,
         tz.zone
    FROM scope_answer_anchors g
    CROSS JOIN tz
    LEFT JOIN scope_answers a        ON a.job_id = g.job_id AND a.status = 'completed'
    LEFT JOIN scope_runs r           ON r.run_id = a.run_id
    LEFT JOIN summary_cycle_runs scr ON scr.run_id = a.run_id
    LEFT JOIN summary_cycles cyc     ON cyc.cycle_id = scr.cycle_id
    -- 0053 이관 대조용 회차 시각. 0077 의 v_regcycle 과 **같은 회차**를 고른다
    -- (프로젝트 + UTC 일자, 같은 날 둘이면 이른 쪽). 여기서는 상관 서브쿼리·LATERAL
    -- 대신 회차(약 1,033행)를 먼저 접어 평 조인한다 — 레지스트리 15만 행에 대해
    -- 행마다 재평가하지 않기 위해서다.
    LEFT JOIN cyc_utc rc ON rc.project_id = r.project_id AND rc.utc_date = g.anchor
),
calc AS (
  SELECT reg.*,
         (answer_job_id IS NOT NULL AND project_id IS NOT NULL) AS in_table,
         -- 백필이 이 행에 줄 anchor_date (R1 이관, 스펙 §9 말미).
         -- 0053 의 `anchor` 는 **UTC 날짜**다. 같은 프로젝트에서 UTC 일자가 그 날짜인
         -- 회차의 시각을 찾아 KST 로 다시 자르고, 못 찾으면 원래 날짜를 유지한다.
         COALESCE((reg_cycle_anchor_at AT TIME ZONE zone)::date, anchor) AS anchor_date,
         -- 레지스트리가 **없었다면** 받았을 날짜(원장 → run).
         (COALESCE(ledger_anchor_at, run_anchor_at) AT TIME ZONE zone)::date AS auto_date
    FROM reg
)
SELECT
  count(*)                                                        AS registry_rows,
  count(*) FILTER (WHERE in_table)                                AS registry_in_table,
  count(*) FILTER (WHERE NOT in_table)                            AS registry_orphans,
  -- R1 이관으로 **0 이 기대값이 아니다** — 회차 시각을 찾아 KST 로 다시 자른 행은
  -- 0053 의 UTC 날짜와 하루 다를 수 있다. 이 수는 "이관된 행" 을 뜻한다.
  count(*) FILTER (WHERE in_table AND anchor_date IS DISTINCT FROM anchor) AS registry_shifted,
  -- 회차를 못 찾아 UTC 날짜를 그대로 유지한 행(reason 표식 대상). 적을수록 좋다.
  count(*) FILTER (WHERE in_table AND reg_cycle_anchor_at IS NULL)         AS registry_utc_kept,
  -- 기대 0. 접기가 재싱크에 되돌려진 행.
  -- ⚠️ 이 대조는 **UTC 축**이다. 0053 의 접기(`scope_anchor_fold`)가 measured_at 의
  -- UTC 일자를 `anchor`(UTC date)로 맞추므로, KST 로 자르면 축이 섞여 오탐이 난다.
  count(*) FILTER (WHERE in_table AND measured_at IS NOT NULL
                     AND (measured_at AT TIME ZONE INTERVAL '0')::date IS DISTINCT FROM anchor)
                                                                  AS registry_unfolded,
  -- 참고(같은 축). 수작업 접기가 자동 경로와 의도적으로 다른 행.
  count(*) FILTER (WHERE in_table AND auto_date IS NOT NULL
                     AND auto_date IS DISTINCT FROM anchor)       AS registry_vs_auto,
  count(*) FILTER (WHERE in_table AND auto_date IS NULL)          AS registry_no_auto_anchor
FROM calc;

-- @@statement S3_gate
, cyc_utc AS (
  -- S2 와 같은 대조 축 — 0053 의 UTC 날짜에 해당하는 회차 시각(N-5).
  SELECT project_id,
         (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
         min(cycle_anchor_at) AS cycle_anchor_at
    FROM summary_cycles
   GROUP BY 1, 2
),
run_ctx AS (
  SELECT r.run_id,
         r.project_id,
         -- 순서: website → standard(원장이 'global' 로 부르는 프로젝트) → project.
         -- 글로벌 루트는 `projects` 에도 한 행이 있어 projects 를 먼저 보면 전량 'project'
         -- 로 떨어진다(2026-09-19 실측 sf_standard 0). 0077 의 함수와 같은 순서다.
         -- 함수는 마지막을 ELSE 'project' 로 접지만, 여기서는 **projects 에도 없는** 행을
         -- NULL 로 남겨 `sf_unclassified` 로 센다(기대 0).
         CASE WHEN ws.scope_project_id IS NOT NULL THEN 'website'
              WHEN gl.project_id       IS NOT NULL THEN 'standard'
              WHEN p.scope_project_id  IS NOT NULL THEN 'project'
         END                                      AS surface,
         cyc.cycle_anchor_at                      AS ledger_anchor_at,
         cyc.view_anchor_at                       AS ledger_view_anchor_at,
         (scr.run_id IS NOT NULL)                 AS has_cycle,
         r.cycle_anchor_at                        AS run_anchor_at
    FROM scope_runs r
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM website_sites
                WHERE scope_project_id IS NOT NULL) ws ON ws.scope_project_id = r.project_id::text
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM projects
                WHERE scope_project_id IS NOT NULL) p  ON p.scope_project_id  = r.project_id
    LEFT JOIN (SELECT DISTINCT project_id FROM summary_cycles
                WHERE surface = 'global') gl ON gl.project_id = r.project_id
    LEFT JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
    LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
   WHERE r.project_id IS NOT NULL
),
resolved AS (
  SELECT rc.surface,
         rc.has_cycle,
         rc.ledger_view_anchor_at,
         a.measured_at,
         tz.zone,
         (reg.job_id IS NULL AND rc.ledger_anchor_at IS NULL AND rc.run_anchor_at IS NULL) AS is_fallback,
         -- hmg_anchor_date() 의 인라인판.
         -- ⚠️ registry 행도 **R1 이관을 거친다**(N-5). 0053 의 `anchor` 는 UTC 날짜라
         --    그대로 쓰면 S2·구현과 축이 달라져 이 문장의 노출일·측정일 대조가
         --    registry 행(약 30%)에서 최대 하루 어긋난다.
         COALESCE((rcu.cycle_anchor_at AT TIME ZONE tz.zone)::date,
                  reg.anchor,
                  (COALESCE(rc.ledger_anchor_at, rc.run_anchor_at, a.measured_at)
                     AT TIME ZONE tz.zone)::date) AS anchor_date
    FROM scope_answers a
    JOIN run_ctx rc ON rc.run_id = a.run_id
    CROSS JOIN tz
    LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
    LEFT JOIN cyc_utc rcu ON rcu.project_id = rc.project_id AND rcu.utc_date = reg.anchor
   WHERE a.status = 'completed'
),
final AS (
  SELECT r.*,
         -- 노출 게이트 (스펙 §3.3 + §9 "노출" 행 — 0077 의 CASE 와 같은 순서·같은 식)
         CASE WHEN r.ledger_view_anchor_at IS NOT NULL
                THEN (r.ledger_view_anchor_at AT TIME ZONE r.zone)::date
              -- 결정 ⑫: 프로젝트 표면은 앵커 **+1일**.
              -- 미분류는 0077 의 함수에서 'project' 로 접히므로 게이트도 그렇게 본다.
              -- R4: fallback_measured 도 별도 분기 없이 이 표면 규칙을 그대로 탄다.
              WHEN COALESCE(r.surface, 'project') = 'project' THEN r.anchor_date + 1
              -- ⚠️ 결정 ⑪(채움)은 **철회됐다** — 그 외는 NULL = 비노출.
         END AS view_anchor_date
    FROM resolved r
   WHERE r.anchor_date IS NOT NULL
)
SELECT
  -- 표면별 한 행. NULL 표면은 S1 의 sf_unclassified 와 같은 행들이다(함수에서는 project).
  COALESCE(surface, '(unclassified)')                             AS surface,
  count(*)                                                        AS rows_out,
  -- ① 원장 사실만(D3·D4 와 무관): 원장에서 노출일을 못 얻는 답변과 그 두 원인.
  --    조치가 다르다 — no_cycle 은 귀속 누락, cycle_unpublished 는 회차 미발행.
  count(*) FILTER (WHERE ledger_view_anchor_at IS NULL)                    AS ledger_view_missing,
  count(*) FILTER (WHERE ledger_view_anchor_at IS NULL AND NOT has_cycle)  AS view_null_no_cycle,
  count(*) FILTER (WHERE ledger_view_anchor_at IS NULL AND has_cycle)      AS view_null_cycle_unpublished,
  -- ② 실제 비노출(= 테이블의 view_anchor_date NULL). ① 에서 결정 ⑫(project 표면 +1일)로
  --    구제된 행만 빠진다(결정 ⑪ 채움 분기는 철회됐다).
  count(*) FILTER (WHERE view_anchor_date IS NULL)                AS view_null,
  count(*) FILTER (WHERE view_anchor_date > (now() AT TIME ZONE zone)::date) AS view_future,
  -- 참고: 측정일과 앵커일이 갈리는 수(스펙 §1.2 의 26.6% 재확인)
  count(*) FILTER (WHERE measured_at IS NOT NULL
                     AND (measured_at AT TIME ZONE zone)::date
                         IS DISTINCT FROM anchor_date)            AS measured_ne_anchor
FROM final
GROUP BY 1
ORDER BY 1;

-- @@statement S4_cycles
-- **회차 단위 지표**(스펙 §3.1). S1 과 같은 CTE 를 회차 입도에서 집계한다.
-- 상관 서브쿼리 없음 — 회차를 한 번 계산하고 조인·GROUP BY 로만 센다.
, cyc_key AS (
  SELECT project_id,
         (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
         (cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date AS kst_date,
         cycle_anchor_at
    FROM summary_cycles
), cyc_utc AS (
  SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), cyc_kst AS (
  SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), run_ctx AS (
  SELECT r.run_id, r.project_id,
         r.project_id::text || '|' ||
           COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
         -- 표면 판정 — S1 과 같은 순서(website → standard → project).
         CASE WHEN ws.scope_project_id IS NOT NULL THEN 'website'
              WHEN gl.project_id       IS NOT NULL THEN 'standard'
              ELSE 'project'
         END                                      AS surface,
         r.cycle_anchor_at                        AS run_anchor_at,
         cyc.cycle_anchor_at                      AS ledger_anchor_at
    FROM scope_runs r
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM website_sites
                WHERE scope_project_id IS NOT NULL) ws ON ws.scope_project_id = r.project_id::text
    LEFT JOIN (SELECT DISTINCT project_id FROM summary_cycles
                WHERE surface = 'global') gl ON gl.project_id = r.project_id
    LEFT JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
    LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
   WHERE r.project_id IS NOT NULL
), ans AS (
  SELECT rc.project_id, rc.cycle_key, rc.run_anchor_at, rc.surface,
         a.measured_at, reg.anchor AS reg_anchor,
         -- ⚠️ `ANY((SELECT engines FROM de))` 로 쓰면 안 된다 — `ANY` 에 **서브쿼리**를
         -- 주면 배열이 펼쳐지지 않고 서브쿼리의 **행 값**(text[])과 비교돼
         -- `42883 operator does not exist: text = text[]` 로 문장이 통째로 죽는다
         -- (2026-09-19 프로덕션 미러 실측: S4·S5 전멸). 상수 CTE 는 1행이므로
         -- `CROSS JOIN de` 로 평 조인해 **배열 컬럼 자체**를 `ANY()` 에 넘긴다.
         (a.target = ANY(de.engines)) AS is_default_engine,
         -- **답변 단위 비교용**: 레지스트리 날짜도 회차 이관 규칙(① UTC → ② KST)을
         -- 태워 KST 축으로 옮긴다. 이걸 안 하면 UTC 날짜와 KST 날짜를 섞어 세게 된다.
         COALESCE((au.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                  (ak.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                  reg.anchor) AS reg_kst_date
    FROM scope_answers a
    JOIN run_ctx rc ON rc.run_id = a.run_id
    CROSS JOIN de
    LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
    LEFT JOIN cyc_utc au ON au.project_id = rc.project_id AND au.d = reg.anchor
    LEFT JOIN cyc_kst ak ON ak.project_id = rc.project_id AND ak.d = reg.anchor
   WHERE a.status = 'completed'
), cyc_reg AS (
  SELECT cycle_key, min(reg_anchor) AS reg_anchor, count(DISTINCT reg_anchor)::int AS reg_variants
    FROM ans WHERE reg_anchor IS NOT NULL GROUP BY cycle_key
), cyc_led AS (
  -- 원장 출처 앵커 선택(0078). **min 이 아니다** — 한 회차의 run 이 원장 회차 둘에
  -- 걸치면 min 은 09-19 에 생성된 **유령 회차**(옛 스케줄 앵커)를 고른다
  -- (2026-09-20 실측: website 6개 프로젝트·1,704행이 그래서 09-17 로 기록됐다).
  --   ① 원장 앵커가 그 회차의 scope_runs.cycle_anchor_at 과 **같은** 원장 회차
  --   ② 없으면 그 회차에서 **run 수가 가장 많은** 원장 회차
  --   ③ 동수면 **이른** 앵커 (= 종전 min 으로 수렴)
  -- `bool_or` 안에서는 그룹 밖 컬럼(run_anchor_at)을 참조해도 된다(집계 인자다).
  SELECT DISTINCT ON (cycle_key) cycle_key, ledger_anchor_at
    FROM (
      SELECT cycle_key, ledger_anchor_at, count(*) AS runs,
             bool_or(ledger_anchor_at IS NOT DISTINCT FROM run_anchor_at) AS matches_run
        FROM run_ctx
       WHERE ledger_anchor_at IS NOT NULL
       GROUP BY 1, 2
    ) g
   ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
), cyc_base AS (
  -- ⚠️ `min(project_id)` 금지 — 이 DB 에 `min(uuid)` 집계가 없다(PostgreSQL 17.6).
  SELECT cycle_key, project_id, surface,
         min(run_anchor_at) AS run_anchor_at, min(measured_at) AS fallback_at,
         -- 회차에 기본 타겟(ChatGPT·Gemini) 답변이 하나라도 있는가(엔진 범위 축).
         bool_or(is_default_engine) AS has_default_engine,
         count(*)::int              AS answers
    FROM ans GROUP BY cycle_key, project_id, surface
), answer_unit AS (
  -- **참고**: 답변 단위로 계산했다면(옛 규칙) 회차가 몇 개나 갈렸을지.
  -- 레지스트리는 "날짜를 옮겨야 했던 답변만" 등록하므로 부분 등록 회차가 쪼개졌다.
  --
  -- ⚠️ **양쪽을 같은 축(KST)으로 센다.** 종전에는 레지스트리 원본 날짜(UTC)와 run 앵커의
  -- KST 일자를 섞어 세서, R1(KST) 아래에서는 의미가 없는 수(실측 88)가 나왔다. 이제
  -- 레지스트리 날짜도 회차 이관 규칙을 태운 `reg_kst_date` 를 쓴다.
  SELECT cycle_key,
         count(DISTINCT COALESCE(reg_kst_date,
                                 (run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date))::int
           AS answer_unit_dates
    FROM ans GROUP BY cycle_key
), cyc_res AS (
  SELECT b.cycle_key, b.project_id, b.surface, b.has_default_engine, b.answers,
         -- ⚠️ 아래 최종 SELECT 의 레지스트리 이관 분류가 `run_anchor_at IS NOT NULL` 을
         -- 본다 — 여기서 빠뜨리면 `42703 column "run_anchor_at" does not exist` 다.
         b.run_anchor_at,
         r.reg_anchor, COALESCE(r.reg_variants, 0) AS reg_variants, au.answer_unit_dates,
         CASE WHEN r.reg_anchor       IS NOT NULL THEN 'registry'
              WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
              WHEN b.run_anchor_at    IS NOT NULL THEN 'run'
              WHEN b.fallback_at      IS NOT NULL THEN 'fallback_measured'
         END AS source,
         CASE WHEN r.reg_anchor IS NOT NULL
                THEN COALESCE((u.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              (k.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              r.reg_anchor)
              WHEN l.ledger_anchor_at IS NOT NULL
                THEN (l.ledger_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              WHEN b.run_anchor_at IS NOT NULL
                THEN (b.run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              ELSE (b.fallback_at AT TIME ZONE (SELECT zone FROM tz))::date
         END AS anchor_date,
         -- 그 회차 **자신의** 앵커 KST 일자(이관 분류의 기준선).
         (b.run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date AS own_kst_date,
         (r.reg_anchor IS NOT NULL AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL)
           AS reg_utc_kept
    FROM cyc_base b
    LEFT JOIN cyc_reg r  ON r.cycle_key = b.cycle_key
    LEFT JOIN cyc_led l  ON l.cycle_key = b.cycle_key
    LEFT JOIN answer_unit au ON au.cycle_key = b.cycle_key
    LEFT JOIN cyc_utc u  ON u.project_id = b.project_id AND u.d = r.reg_anchor
    LEFT JOIN cyc_kst k  ON k.project_id = b.project_id AND k.d = r.reg_anchor
), wk AS (
  -- (프로젝트, KST 주) 안에 앵커 날짜가 둘 이상 남는 조합. **표면별**로 가른다.
  SELECT project_id, surface, (date_trunc('week', anchor_date::timestamp))::date AS anchor_week,
         count(DISTINCT anchor_date)::int AS dates
    FROM cyc_res WHERE anchor_date IS NOT NULL
   GROUP BY 1, 2, 3
), wk_de AS (
  -- 같은 것을 **기본 타겟 답변이 있는 회차만**으로. DeepSeek 전용 회차(08-18 Genesis/CN·
  -- Hyundai/CN)처럼 옵트인 엔진 단발 측정이 만든 분할이 여기서 빠진다.
  SELECT project_id, surface, (date_trunc('week', anchor_date::timestamp))::date AS anchor_week,
         count(DISTINCT anchor_date)::int AS dates
    FROM cyc_res WHERE anchor_date IS NOT NULL AND has_default_engine
   GROUP BY 1, 2, 3
)
SELECT
  (SELECT count(*) FROM cyc_res)                                          AS cycles,
  (SELECT count(*) FROM cyc_res WHERE source = 'registry')                AS cycles_registry,
  (SELECT count(*) FROM cyc_res WHERE source = 'ledger')                  AS cycles_ledger,
  (SELECT count(*) FROM cyc_res WHERE source = 'run')                     AS cycles_run,
  (SELECT count(*) FROM cyc_res WHERE source = 'fallback_measured')       AS cycles_fallback,
  -- **기대 0.** 회차 안 레지스트리 앵커가 엇갈린 회차(실측 0). 0 이 아니면 그 회차는
  -- 가장 이른 날짜로 접히고 감사 SQL 의 `cycle_registry_split` 이 표면화한다.
  (SELECT count(*) FROM cyc_res WHERE reg_variants > 1)                   AS cycle_registry_split,
  -- 참고: 답변 단위로 계산했다면 갈렸을 회차 수(실측 7). 회차 단위 상속이 고치는 크기.
  (SELECT count(*) FROM cyc_res WHERE answer_unit_dates > 1)              AS cycle_answer_unit_split,
  -- ── 레지스트리 이관 분류 (스펙 §9 말미) ───────────────────────────────────
  --   same_own      이관 결과가 **그 회차 자신의** 앵커 KST 일자와 같다(실측 385+1)
  --   moved_other   **다른 회차**로 옮겨 간다(실측 25. 7/27 캠페인 24 + Genesis MIDDLEEAST 1)
  --   utc_kept      UTC·KST 어느 축으로도 회차를 못 찾아 원래 날짜 유지(감사 대상)
  --   ⚠️ `cycle_anchor_at` NULL 인 **단독 회차**는 자기 앵커가 없어 위 셋으로 가를 수
  --      없다(`own_kst_date` 가 NULL 이라 전부 "이동"으로 보였다. 실측 13). 따로 센다.
  (SELECT count(*) FROM cyc_res
    WHERE source = 'registry' AND run_anchor_at IS NOT NULL
      AND NOT reg_utc_kept AND anchor_date = own_kst_date)                AS reg_same_own_cycle,
  (SELECT count(*) FROM cyc_res
    WHERE source = 'registry' AND run_anchor_at IS NOT NULL
      AND NOT reg_utc_kept AND anchor_date IS DISTINCT FROM own_kst_date) AS reg_moved_other_cycle,
  (SELECT count(*) FROM cyc_res
    WHERE source = 'registry' AND run_anchor_at IS NOT NULL AND reg_utc_kept) AS reg_utc_kept,
  (SELECT count(*) FROM cyc_res
    WHERE source = 'registry' AND run_anchor_at IS NULL)                  AS reg_solo_no_anchor,
  -- **기대 0.** 한 (프로젝트, KST 주)에 앵커 날짜가 하나여야 한다(스펙 §3.1 말미).
  (SELECT count(*) FROM wk WHERE dates > 1)                               AS project_week_split,
  (SELECT count(*) FROM wk WHERE dates > 1 AND surface = 'standard')      AS project_week_split_standard,
  (SELECT count(*) FROM wk WHERE dates > 1 AND surface = 'website')       AS project_week_split_website,
  (SELECT count(*) FROM wk WHERE dates > 1 AND surface = 'project')       AS project_week_split_project,
  -- 기본 타겟 답변이 있는 회차만 — 옵트인 엔진 단발 측정이 만든 분할을 뺀 수.
  (SELECT count(*) FROM wk_de WHERE dates > 1)                            AS project_week_split_default_engine;

-- @@statement S5_rounds
-- **정규 요일 귀속의 1차 근사.** S4 와 같은 회차 체인 위에 자리 배정을 얹는다.
-- 상관 서브쿼리 없음 — 자리 점유는 평 조인(`taken`)으로만 본다.
--
-- ⚠️ 이 값은 **추정**이다. 실제 배정은 비정규 회차를 anchor_date 이른 순으로 차례
-- 배정하므로, 비정규끼리 같은 자리를 노리면(`est_collisions`) 결과가 달라진다.
-- 정확한 분포는 0077 적용 후 `npm run db:reassign:cycle-rounds -- --all`(dry-run)이 낸다.
, cyc_key AS (
  SELECT project_id,
         (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
         (cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date AS kst_date,
         cycle_anchor_at
    FROM summary_cycles
), cyc_utc AS (
  SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), cyc_kst AS (
  SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
    FROM cyc_key GROUP BY 1, 2
), run_ctx AS (
  SELECT r.run_id, r.project_id,
         r.project_id::text || '|' ||
           COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
         -- 표면 판정 — S1 과 같은 순서(website → standard → project).
         CASE WHEN ws.scope_project_id IS NOT NULL THEN 'website'
              WHEN gl.project_id       IS NOT NULL THEN 'standard'
              ELSE 'project'
         END                                      AS surface,
         r.cycle_anchor_at                        AS run_anchor_at,
         cyc.cycle_anchor_at                      AS ledger_anchor_at
    FROM scope_runs r
    LEFT JOIN (SELECT DISTINCT scope_project_id FROM website_sites
                WHERE scope_project_id IS NOT NULL) ws ON ws.scope_project_id = r.project_id::text
    LEFT JOIN (SELECT DISTINCT project_id FROM summary_cycles
                WHERE surface = 'global') gl ON gl.project_id = r.project_id
    LEFT JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
    LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
   WHERE r.project_id IS NOT NULL
), ans AS (
  SELECT rc.project_id, rc.cycle_key, rc.run_anchor_at, rc.surface,
         a.measured_at, reg.anchor AS reg_anchor,
         -- ⚠️ `ANY((SELECT engines FROM de))` 로 쓰면 안 된다 — `ANY` 에 **서브쿼리**를
         -- 주면 배열이 펼쳐지지 않고 서브쿼리의 **행 값**(text[])과 비교돼
         -- `42883 operator does not exist: text = text[]` 로 문장이 통째로 죽는다
         -- (2026-09-19 프로덕션 미러 실측: S4·S5 전멸). 상수 CTE 는 1행이므로
         -- `CROSS JOIN de` 로 평 조인해 **배열 컬럼 자체**를 `ANY()` 에 넘긴다.
         (a.target = ANY(de.engines)) AS is_default_engine,
         -- **답변 단위 비교용**: 레지스트리 날짜도 회차 이관 규칙(① UTC → ② KST)을
         -- 태워 KST 축으로 옮긴다. 이걸 안 하면 UTC 날짜와 KST 날짜를 섞어 세게 된다.
         COALESCE((au.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                  (ak.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                  reg.anchor) AS reg_kst_date
    FROM scope_answers a
    JOIN run_ctx rc ON rc.run_id = a.run_id
    CROSS JOIN de
    LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
    LEFT JOIN cyc_utc au ON au.project_id = rc.project_id AND au.d = reg.anchor
    LEFT JOIN cyc_kst ak ON ak.project_id = rc.project_id AND ak.d = reg.anchor
   WHERE a.status = 'completed'
), cyc_reg AS (
  SELECT cycle_key, min(reg_anchor) AS reg_anchor, count(DISTINCT reg_anchor)::int AS reg_variants
    FROM ans WHERE reg_anchor IS NOT NULL GROUP BY cycle_key
), cyc_led AS (
  -- 원장 출처 앵커 선택(0078). **min 이 아니다** — 한 회차의 run 이 원장 회차 둘에
  -- 걸치면 min 은 09-19 에 생성된 **유령 회차**(옛 스케줄 앵커)를 고른다
  -- (2026-09-20 실측: website 6개 프로젝트·1,704행이 그래서 09-17 로 기록됐다).
  --   ① 원장 앵커가 그 회차의 scope_runs.cycle_anchor_at 과 **같은** 원장 회차
  --   ② 없으면 그 회차에서 **run 수가 가장 많은** 원장 회차
  --   ③ 동수면 **이른** 앵커 (= 종전 min 으로 수렴)
  -- `bool_or` 안에서는 그룹 밖 컬럼(run_anchor_at)을 참조해도 된다(집계 인자다).
  SELECT DISTINCT ON (cycle_key) cycle_key, ledger_anchor_at
    FROM (
      SELECT cycle_key, ledger_anchor_at, count(*) AS runs,
             bool_or(ledger_anchor_at IS NOT DISTINCT FROM run_anchor_at) AS matches_run
        FROM run_ctx
       WHERE ledger_anchor_at IS NOT NULL
       GROUP BY 1, 2
    ) g
   ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
), cyc_base AS (
  -- ⚠️ `min(project_id)` 금지 — 이 DB 에 `min(uuid)` 집계가 없다(PostgreSQL 17.6).
  SELECT cycle_key, project_id, surface,
         min(run_anchor_at) AS run_anchor_at, min(measured_at) AS fallback_at,
         -- 회차에 기본 타겟(ChatGPT·Gemini) 답변이 하나라도 있는가(엔진 범위 축).
         bool_or(is_default_engine) AS has_default_engine,
         count(*)::int              AS answers
    FROM ans GROUP BY cycle_key, project_id, surface
), answer_unit AS (
  -- **참고**: 답변 단위로 계산했다면(옛 규칙) 회차가 몇 개나 갈렸을지.
  -- 레지스트리는 "날짜를 옮겨야 했던 답변만" 등록하므로 부분 등록 회차가 쪼개졌다.
  --
  -- ⚠️ **양쪽을 같은 축(KST)으로 센다.** 종전에는 레지스트리 원본 날짜(UTC)와 run 앵커의
  -- KST 일자를 섞어 세서, R1(KST) 아래에서는 의미가 없는 수(실측 88)가 나왔다. 이제
  -- 레지스트리 날짜도 회차 이관 규칙을 태운 `reg_kst_date` 를 쓴다.
  SELECT cycle_key,
         count(DISTINCT COALESCE(reg_kst_date,
                                 (run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date))::int
           AS answer_unit_dates
    FROM ans GROUP BY cycle_key
), cyc_res AS (
  SELECT b.cycle_key, b.project_id, b.surface, b.has_default_engine, b.answers,
         -- ⚠️ 아래 최종 SELECT 의 레지스트리 이관 분류가 `run_anchor_at IS NOT NULL` 을
         -- 본다 — 여기서 빠뜨리면 `42703 column "run_anchor_at" does not exist` 다.
         b.run_anchor_at,
         r.reg_anchor, COALESCE(r.reg_variants, 0) AS reg_variants, au.answer_unit_dates,
         CASE WHEN r.reg_anchor       IS NOT NULL THEN 'registry'
              WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
              WHEN b.run_anchor_at    IS NOT NULL THEN 'run'
              WHEN b.fallback_at      IS NOT NULL THEN 'fallback_measured'
         END AS source,
         CASE WHEN r.reg_anchor IS NOT NULL
                THEN COALESCE((u.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              (k.cycle_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date,
                              r.reg_anchor)
              WHEN l.ledger_anchor_at IS NOT NULL
                THEN (l.ledger_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              WHEN b.run_anchor_at IS NOT NULL
                THEN (b.run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date
              ELSE (b.fallback_at AT TIME ZONE (SELECT zone FROM tz))::date
         END AS anchor_date,
         -- 그 회차 **자신의** 앵커 KST 일자(이관 분류의 기준선).
         (b.run_anchor_at AT TIME ZONE (SELECT zone FROM tz))::date AS own_kst_date,
         (r.reg_anchor IS NOT NULL AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL)
           AS reg_utc_kept
    FROM cyc_base b
    LEFT JOIN cyc_reg r  ON r.cycle_key = b.cycle_key
    LEFT JOIN cyc_led l  ON l.cycle_key = b.cycle_key
    LEFT JOIN answer_unit au ON au.cycle_key = b.cycle_key
    LEFT JOIN cyc_utc u  ON u.project_id = b.project_id AND u.d = r.reg_anchor
    LEFT JOIN cyc_kst k  ON k.project_id = b.project_id AND k.d = r.reg_anchor
), cyc AS (
  -- 회차 한 행 = (프로젝트, 표면, 최종 anchor_date). 여기에 정규 요일을 붙인다.
  --
  -- ⚠️ `DISTINCT` 가 필요하다(C-2). `cyc_res` 의 키는 **회차 키**(project + cycle_anchor_at)
  -- 인데, 레지스트리 이관으로 서로 다른 두 회차가 **같은 anchor_date 로 접히는** 경우가
  -- 있다(7/27 캠페인 24 프로젝트). 배정의 실제 키는 (project, anchor_date) 이므로 그때
  -- 여기서 행이 둘로 남으면 `round_cycles`·`est_*` 가 부풀고 `est_collisions` 에 자기
  -- 자신과의 가짜 충돌이 잡힌다. 실제 배정 결과는 영향이 없고 **보고 숫자만** 어긋난다.
  SELECT DISTINCT c.project_id, c.surface, c.anchor_date,
         w.dow,
         EXTRACT(ISODOW FROM c.anchor_date)::int AS adow
    FROM cyc_res c
    LEFT JOIN cw w ON w.surface = c.surface
   WHERE c.anchor_date IS NOT NULL
), seats AS (
  -- 앞 자리·뒤 자리. 0077 의 `hmg_round_prev/next_canonical` 과 **같은 산술**이다
  -- (이 SQL 은 적용 전에 돌아야 해서 함수를 부를 수 없다). 사본이라 어긋날 수 있으므로
  -- `answer-cycle-anchors-sql.pglite.test.ts` 가 이 두 식을 **파일에서 뽑아** 함수와
  -- 실행으로 대조한다(2026 전체 날짜 × 정규 요일 7가지 = 2,555 조합, 변이 검출 포함).
  SELECT project_id, surface, anchor_date, dow, adow,
         (dow IS NULL)                        AS no_canonical,
         (dow IS NOT NULL AND adow = dow)     AS is_canonical,
         anchor_date - ((((adow - dow) + 6) % 7) + 1) AS prev_seat,
         anchor_date + ((((dow - adow) + 6) % 7) + 1) AS next_seat
    FROM cyc
), taken AS (
  -- ⚠️ **1차 근사다.** 정규 요일 회차(와 정규 요일이 없는 project 표면)가 먼저 차지하는
  -- 자리만 센다. 실제 배정은 비정규 회차끼리도 차례로 자리를 채우므로, 그 경합이 있는
  -- 조합에서는 결과가 달라질 수 있다 — 그 규모를 아래 `est_collisions` 로 따로 낸다.
  SELECT DISTINCT project_id, anchor_date AS seat
    FROM seats WHERE is_canonical OR no_canonical
), est AS (
  SELECT s.*,
         (tp.seat IS NOT NULL) AS prev_taken,
         (tn.seat IS NOT NULL) AS next_taken
    FROM seats s
    LEFT JOIN taken tp ON tp.project_id = s.project_id AND tp.seat = s.prev_seat
    LEFT JOIN taken tn ON tn.project_id = s.project_id AND tn.seat = s.next_seat
   WHERE NOT s.is_canonical AND NOT s.no_canonical
), est2 AS (
  -- 규칙: 빈 자리 우선 -> 둘 다 비면 가까운 쪽 -> 둘 다 차면 가까운 쪽에 합친다.
  SELECT e.project_id, e.surface, e.anchor_date, e.prev_seat, e.next_seat,
         CASE WHEN NOT prev_taken AND     next_taken THEN 'prev_empty'
              WHEN     prev_taken AND NOT next_taken THEN 'next_empty'
              WHEN NOT prev_taken AND NOT next_taken THEN 'nearest'
              ELSE 'merged' END AS basis,
         CASE WHEN NOT prev_taken AND     next_taken THEN e.prev_seat
              WHEN     prev_taken AND NOT next_taken THEN e.next_seat
              WHEN (e.anchor_date - e.prev_seat) <= (e.next_seat - e.anchor_date) THEN e.prev_seat
              ELSE e.next_seat END AS round_date
    FROM est e
), all_seats AS (
  -- 1차 근사의 최종 자리 배치(정규 요일 회차 + 추정된 비정규 회차).
  SELECT project_id, anchor_date AS round_date FROM seats WHERE is_canonical OR no_canonical
  UNION ALL
  SELECT project_id, round_date FROM est2
)
SELECT
  (SELECT count(*) FROM cyc)                                              AS round_cycles,
  (SELECT count(*) FROM seats WHERE is_canonical)                         AS round_canonical,
  (SELECT count(*) FROM seats WHERE no_canonical)                         AS round_project,
  (SELECT count(*) FROM seats WHERE NOT is_canonical AND NOT no_canonical) AS round_offday,
  (SELECT count(*) FROM seats
    WHERE NOT is_canonical AND NOT no_canonical AND surface = 'standard') AS round_offday_standard,
  (SELECT count(*) FROM seats
    WHERE NOT is_canonical AND NOT no_canonical AND surface = 'website')  AS round_offday_website,
  -- ── 1차 근사 basis 분포 ───────────────────────────────────────────────────
  (SELECT count(*) FROM est2 WHERE basis = 'prev_empty')                  AS est_prev_empty,
  (SELECT count(*) FROM est2 WHERE basis = 'next_empty')                  AS est_next_empty,
  (SELECT count(*) FROM est2 WHERE basis = 'nearest')                     AS est_nearest,
  (SELECT count(*) FROM est2 WHERE basis = 'merged')                      AS est_merged,
  (SELECT count(*) FROM est2 WHERE basis = 'merged' AND surface = 'website')  AS est_merged_website,
  (SELECT count(*) FROM est2 WHERE basis = 'merged' AND surface = 'standard') AS est_merged_standard,
  -- 한 자리에 둘 이상 앉는 자리 수(합쳐진 자리).
  (SELECT count(*) FROM (SELECT project_id, round_date FROM all_seats
                          GROUP BY 1, 2 HAVING count(*) > 1) s)           AS est_merged_seats,
  -- ⚠️ **추정의 불확실 구간**: 비정규 회차 둘 이상이 같은 자리를 노리는 조합 수.
  -- 그 조합에서는 차례 배정(이른 회차 우선)이 결과를 바꿀 수 있다. 0 이면 이 1차 근사가
  -- 실제 배정과 같다. 정확한 분포는 적용 후 `db:reassign:cycle-rounds`(dry-run)가 낸다.
  (SELECT count(*) FROM (SELECT project_id, round_date FROM est2
                          GROUP BY 1, 2 HAVING count(*) > 1) s)           AS est_collisions,
  -- 앵커 대비 이동 방향·최대 폭(일).
  (SELECT count(*) FROM est2 WHERE round_date < anchor_date)              AS est_move_back,
  (SELECT count(*) FROM est2 WHERE round_date > anchor_date)              AS est_move_fwd,
  (SELECT coalesce(max(abs(round_date - anchor_date)), 0) FROM est2)      AS est_move_max;
