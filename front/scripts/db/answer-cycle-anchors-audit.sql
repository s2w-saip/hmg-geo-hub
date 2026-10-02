-- 0077 앵커 테이블 **야간 정합 감사** — 읽기 전용. 쓰기·DDL 이 한 줄도 없다.
--
-- 왜: 원장 → 앵커 테이블 전파는 DB 트리거가 아니라 **코드 경로의 명시 호출**이다
-- (스펙 §9 "전파"). 호출을 빠뜨린 경로가 새로 생기면 조용히 어긋나므로, 그것을
-- 사람이 아니라 감사가 잡는다. 이 파일이 그 감사의 정본 쿼리다.
--
-- ⚠️ 스케줄·알림 배선은 **이번 범위 밖**이다. 붙일 때의 규약:
--   · 목적지는 **GitHub Issue** — "사람이 코드를 고쳐야 해소된다"에 해당한다
--     (사내 운영 규칙(alert-routing): 코드·빌드 = GitHub Issue / 라이브 = Slack, 2026-09-25 잔디에서 전환).
--   · 등급은 이 리포 관례 `0=PASS / 1=주의 / 2=긴급`. 아래 `severity` 열이 그 값이다.
--   · 감사 자신이 안 도는 사각지대는 다른 스케줄에 한 줄로 교차감시한다
--     (scope 리포 `ontology-health.yml` 헤더가 선례).
--
-- 실행 (읽기 전용 보장은 세션에서 건다 — Supavisor 가 startup 파라미터를 버린다):
--   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '5min';
--   \i scripts/db/answer-cycle-anchors-audit.sql
--   COMMIT;
--
-- ⚠️ **0078 이 적용된 DB 를 전제한다** — `hmg_cycle_key()`·`scope_cycle_anchor_state`·
-- `scope_cycle_registry_runs` 를 읽는다(⑮⑯). 0077 만 적용된 DB 에서는 그 이름들이 없어
-- 문장 전체가 죽으므로, 0078 적용 전에는 돌리지 않는다.
--
-- 한 문장이다. 결과는 점검 항목마다 한 행:
--   check      점검 이름
--   n          어긋난 행/건 수 (0 이 정상)
--   severity   0 PASS · 1 주의 · 2 긴급
--   note       무엇을 뜻하는지 / 어디를 고쳐야 하는지

WITH
-- ① 원장 노출일 ≠ 테이블 노출일. **전파 누락의 1차 지문.**
--    `view_anchor_at` 을 쓰는 경로는 `swap.ts::publishCycleSql` 하나뿐이므로,
--    여기가 0 이 아니면 그 스왑 트랜잭션의 전파 호출이 빠졌거나 실패한 것이다.
view_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN summary_cycles y ON y.cycle_id = c.cycle_id
   WHERE y.view_anchor_at IS NOT NULL
     AND c.view_anchor_date IS DISTINCT FROM hmg_anchor_date(y.view_anchor_at)
),
-- ②-0 회차가 고른 원장 앵커 (0078 의 선택 규칙과 **같은 식**이어야 한다).
--     ① 원장 앵커가 그 회차의 scope_runs.cycle_anchor_at 과 같은 원장 회차
--     ② 없으면 그 회차에서 run 수가 가장 많은 원장 회차
--     ③ 동수면 이른 앵커
--     회차 키는 dry-run 과 **같은 인라인 식**이다. `hmg_cycle_key` 를 쓸 수도 있지만
--     (이 감사는 0078 전제다 — 머리말 참조) dry-run 의 같은 규칙 사본과 문자 단위로
--     대조할 수 있게 표기를 맞춘다. 이 CTE 안에서 양쪽이 같은 식이라 조인은 성립한다.
ledger_pick AS (
  SELECT DISTINCT ON (cycle_key) cycle_key, ledger_anchor_at
    FROM (
      SELECT r.project_id::text || '|' ||
               COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
             y.cycle_anchor_at AS ledger_anchor_at,
             count(*) AS runs,
             bool_or(y.cycle_anchor_at IS NOT DISTINCT FROM r.cycle_anchor_at) AS matches_run
        FROM scope_runs r
        JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
        JOIN summary_cycles     y   ON y.cycle_id = scr.cycle_id
       WHERE r.project_id IS NOT NULL AND y.cycle_anchor_at IS NOT NULL
       GROUP BY 1, 2
    ) g
   ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
),
-- ② 원장 회차 앵커 ≠ 테이블 앵커 (ledger 출처 행만).
--    ⚠️ 비교 대상은 **그 행의 `cycle_id` 가 붙은 원장 회차가 아니라** 회차가 고른
--    원장 앵커다(회차 단위 상속). 한 회차가 원장 회차 둘에 걸치면 일부 run 의
--    `cycle_id` 는 안 고른 쪽을 가리키는 것이 **정상**이고, 옛 정의는 그것을
--    긴급으로 울었다(2026-09-20 실측 1,704행).
--    registry 출처 행은 의도적으로 다르므로(수작업 접기) 여기서도 뺀다.
ledger_anchor_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN scope_runs r ON r.run_id = c.run_id
    JOIN ledger_pick p
      ON p.cycle_key = r.project_id::text || '|' ||
                       COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text)
   WHERE c.source = 'ledger'
     AND c.anchor_date IS DISTINCT FROM hmg_anchor_date(p.ledger_anchor_at)
),
-- ②' 한 회차(프로젝트 + cycle_anchor_at)의 run 이 **원장 회차 둘 이상**에 걸친다.
--     결함은 아니다 — 재제출 run 이 새 원장 회차에 붙으면 생긴다. 다만 이 상태에서
--     앵커 선택 규칙이 어느 쪽을 골랐는지가 값에 직접 영향을 주므로 규모를 드러낸다.
--     0 이 아니면 위 `ledger_anchor_drift` 의 정의가 그만큼 중요해진다는 뜻이다.
cycle_ledger_split AS (
  SELECT count(*) AS n FROM (
    SELECT r.project_id, r.cycle_anchor_at
      FROM scope_runs r
      JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
      JOIN summary_cycles     y   ON y.cycle_id = scr.cycle_id
     WHERE r.project_id IS NOT NULL
       AND r.cycle_anchor_at IS NOT NULL
       AND y.cycle_anchor_at IS NOT NULL
     GROUP BY 1, 2
    HAVING count(DISTINCT y.cycle_anchor_at) > 1
  ) s
),
-- ③ 귀속 불일치 — 원장이 그 run 을 다른 회차에 붙였는데 테이블은 옛 회차를 가리킨다.
--    `upsertCycleRunsSql` 의 재귀속(ON CONFLICT DO UPDATE SET cycle_id) 경로가 전파를
--    빠뜨리면 여기가 뜬다.
attribution_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN scope_answers a ON a.job_id = c.job_id
    LEFT JOIN summary_cycle_runs r ON r.run_id = a.run_id
   WHERE c.cycle_id IS DISTINCT FROM r.cycle_id
),
-- ④ run 앵커 불일치 (run 출처 행만) — 미러 재싱크가 `cycle_anchor_at` 을 갱신했는데
--    앵커 행이 따라오지 않은 경우. 정상 경로라면 재싱크가 같은 tx 에서 재계산한다.
run_anchor_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN scope_runs r ON r.run_id = c.run_id
   WHERE c.source = 'run'
     AND r.cycle_anchor_at IS NOT NULL
     AND c.anchor_date IS DISTINCT FROM hmg_anchor_date(r.cycle_anchor_at)
),
-- ⑤ 누락 — completed·project_id NOT NULL 인데 앵커 행이 없다(전수 계약 위반).
--    백필 미완 또는 싱크 경로의 전파 누락.
missing AS (
  SELECT count(*) AS n
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
   WHERE a.status = 'completed'
     AND r.project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM scope_answer_cycle_anchors c WHERE c.job_id = a.job_id)
),
-- ⑥ 고아 — 답변이 사라졌는데 앵커 행이 남아 있다.
--    `refresh` 가 비고정 행은 스스로 지우므로(B8), 여기 남는 것은 사실상
--    **고정(pinned) 행**(registry = 0053 수작업 접기)이다.
--    지우지 않고 표면화만 한다(자동 삭제하면 복구 근거가 사라진다 — 0053·0054 규율).
orphans AS (
  SELECT count(*) FILTER (WHERE hmg_anchor_is_pinned(c.source)) AS registry_n,
         count(*) AS n
    FROM scope_answer_cycle_anchors c
   WHERE NOT EXISTS (SELECT 1 FROM scope_answers a WHERE a.job_id = c.job_id)
),
-- ⑦ 상태 이탈 — 답변은 있는데 더 이상 completed 가 아닌데 앵커 행이 남아 있다(B8).
--    비고정 행은 `refresh` 가 그 run 을 다시 돌 때 지운다. 그래도 남아 있으면
--    그 run 이 한 번도 재싱크되지 않았다는 뜻이다.
stale_status AS (
  SELECT count(*) FILTER (WHERE NOT hmg_anchor_is_pinned(c.source)) AS non_registry_n,
         count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN scope_answers a ON a.job_id = c.job_id
   WHERE a.status <> 'completed'
),
-- ⑧ 파생 키 불일치. 축이 둘이라는 점에 주의한다:
--      · `anchor_date` 는 **실제 앵커**(anchor_at)의 KST 일자여야 하고,
--      · `anchor_week`·`anchor_month` 는 **귀속 날짜**(round_date) 기준이어야 한다.
--    타임존을 뒤집고 `--recompute` 를 안 돌렸을 때의 지문이다.
derived_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
   WHERE c.anchor_week IS DISTINCT FROM hmg_anchor_week(c.round_date)
      OR c.anchor_month IS DISTINCT FROM hmg_anchor_month(c.round_date)
      OR hmg_anchor_date(c.anchor_at) IS DISTINCT FROM c.anchor_date
),
-- ⑧' 0053 이관 미완 — 회차를 못 찾아 UTC 날짜를 그대로 유지한 registry 행(R1 말미).
--    reason 표식으로 센다. 회차 원장이 나중에 그 날짜를 열면 재계산으로 해소된다.
registry_utc_kept AS (
  SELECT count(*) AS n FROM scope_answer_cycle_anchors
   WHERE source = 'registry' AND reason LIKE '%[anchor-tz:utc-date-kept]%'
),
-- ⑧'' 노출일 정합 — `view_anchor_date` 가 자기 `anchor_date`·원장 값과 맞는가(N-1).
--    보존 가드로 anchor_date 가 고정된 행의 노출일만 자동 앵커 기준으로 계산되면 여기가 뜬다.
--    산식이 시간에 의존하지 않으므로(결정 ⑪ 채움 분기 철회) 이 대조는 전 행에 유효하다.
view_date_drift AS (
  SELECT count(*) AS n FROM scope_answer_cycle_anchors c
   WHERE c.view_anchor_date IS DISTINCT FROM
         hmg_anchor_view_date(c.surface, c.anchor_date, c.ledger_view_anchor_date)
),
-- (8b) 회차 안 앵커 불일치 - **회차 단위 상속의 핵심 불변식**(스펙 3.1).
--    같은 (프로젝트, cycle_anchor_at) run 묶음의 답변이 서로 다른 anchor_date 를 갖는다면
--    전파 호출이 빠졌거나(수작업 접기 뒤 refresh 미호출) 상속 구현이 깨진 것이다.
--    고정 출처(registry = 0053 수작업 접기)로 **의도적으로** 다른 행은 뺀다.
cycle_anchor_split AS (
  SELECT count(*) AS n FROM (
    SELECT c.project_id, r.cycle_anchor_at
      FROM scope_answer_cycle_anchors c
      JOIN scope_runs r ON r.run_id = c.run_id
     WHERE r.cycle_anchor_at IS NOT NULL
       AND NOT hmg_anchor_is_pinned(c.source)
     GROUP BY 1, 2
    HAVING count(DISTINCT c.anchor_date) > 1
  ) s
),
-- (8c) 한 (프로젝트, KST 주)에 **귀속 날짜**가 둘 이상.
--    정규 요일이 있는 표면에서는 구조적으로 0 이어야 한다 — 한 ISO 주에 그 요일은
--    하루뿐이고 `anchor_week` 가 곧 `hmg_anchor_week(round_date)` 이기 때문이다.
--    0 이 아니면 배정이나 전파가 깨졌다는 뜻이다(project 표면은 정규 요일이 없어 뺀다).
project_week_split AS (
  SELECT count(*) AS n FROM (
    SELECT project_id, anchor_week FROM scope_answer_cycle_anchors
     WHERE hmg_round_canonical_dow(surface) IS NOT NULL
     GROUP BY 1, 2 HAVING count(DISTINCT round_date) > 1
  ) s
),
-- ⑨ 귀속 날짜가 **정규 요일이 아니다**(project 표면 제외). 배정 규칙 위반.
off_canonical AS (
  SELECT count(*) AS n FROM scope_cycle_rounds
   WHERE hmg_round_canonical_dow(surface) IS NOT NULL
     AND EXTRACT(ISODOW FROM round_date)::int <> hmg_round_canonical_dow(surface)
),
-- ⑩ 매핑 표 ↔ 답변 테이블의 귀속 날짜 불일치(복사본 드리프트).
--    답변 행은 매핑의 사본이다 — 전파가 빠지면 기간 술어가 옛 자리를 본다.
round_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    LEFT JOIN scope_cycle_rounds m
      ON m.project_id = c.project_id AND m.anchor_date = c.anchor_date
   WHERE m.round_date IS NULL OR c.round_date IS DISTINCT FROM m.round_date
),
-- ⑪ 합쳐진 자리 — 한 (프로젝트, 귀속 날짜)에 회차가 둘 이상.
--    **결함이 아니다**(규칙이 허용한다). 규모를 보기 위한 지표이므로 등급은 0 이다.
merged_seats AS (
  SELECT count(*) AS seats, coalesce(sum(k), 0) AS cycles FROM (
    SELECT count(*) AS k FROM scope_cycle_rounds
     GROUP BY project_id, round_date HAVING count(*) > 1
  ) s
),
-- ⑫ 고아 자리 — 답변이 한 건도 없는 배정. 0053 접기로 회차의 anchor_date 가 옮겨가면
--    옛 자리가 여기 남고, 그 자리가 **점유로 계속 작동해** 새 배정을 밀어낸다.
--    자동으로 지우지 않는다(과거 값 안정성) — 운영자 재배정 경로로 정리한다.
orphan_rounds AS (
  SELECT count(*) AS n FROM scope_cycle_rounds m
   WHERE NOT EXISTS (SELECT 1 FROM scope_answer_cycle_anchors c
                      WHERE c.project_id = m.project_id AND c.anchor_date = m.anchor_date)
),
-- ⑬ 합쳐진 자리 안에서 **노출일이 갈리는** 자리 수.
--    설계 판단: 자리 단위로 노출일을 합치지 않는다(가장 늦은 날로 묶으면 1~8건짜리
--    잔여 회차가 200건+ 본 회차를 통째로 가린다). 대신 갈린 자리를 여기서 드러낸다 —
--    그 자리는 한 날짜로 보이지만 답변 일부가 아직 안 나온다.
merged_view_split AS (
  SELECT count(*) AS n FROM (
    SELECT c.project_id, c.round_date
      FROM scope_answer_cycle_anchors c
     GROUP BY 1, 2
    HAVING count(DISTINCT c.anchor_date) > 1
       AND count(DISTINCT coalesce(c.view_anchor_date::text, 'null')) > 1
  ) s
),
-- ⑭ 표면별 basis 분포. 결함이 아니라 **지표**다(등급 0) — 규칙이 실제로 어떻게
--    적용됐는지 한눈에 본다. `merged` 가 늘면 자리 경합이 늘었다는 뜻이다.
basis_dist AS (
  SELECT surface, basis, count(*) AS n FROM scope_cycle_rounds GROUP BY 1, 2
),
-- ⑮ 0078 회차 상태 ↔ 답변 행 불일치.
--    0078 의 조건부 확장은 상태 표를 "지금 적용된 회차 값"으로 믿는다. 둘이 갈리면
--    좁은 경로가 "안 바뀌었다"고 오판하므로 **긴급**이다. 고정 출처(registry)는
--    자동 값과 의도적으로 다르므로 뺀다.
--    회수: 그 회차의 run 하나로 refresh 를 부르면 회차 전체가 다시 쓰인다.
cycle_state_drift AS (
  SELECT count(*) AS n
    FROM scope_answer_cycle_anchors c
    JOIN scope_runs r ON r.run_id = c.run_id
    JOIN scope_cycle_anchor_state st
      ON st.cycle_key = hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id)
   WHERE NOT hmg_anchor_is_pinned(c.source)
     AND (c.surface, c.anchor_date, c.source, c.round_date)
           IS DISTINCT FROM (st.surface, st.anchor_date, st.source, st.round_date)
),
-- ⑰ **INVALID 인덱스** — `CREATE INDEX CONCURRENTLY` 가 실패하고 남긴 잔해.
--    마이그레이션의 `to_regclass` 선확인 DO 블록은 이름만 보므로 INVALID 도 "있다"로
--    통과시킨다(0079 가 그 형태다 — 이미 적용돼 본문을 고칠 수 없다). 플래너는 INVALID
--    인덱스를 쓰지 않으므로 "적용은 됐는데 성능 수리는 안 된" 상태가 조용히 남는다.
--    대상 집합의 정의는 `scripts/db/check-index-validity.sql` 과 **같아야 한다**.
invalid_index AS (
  SELECT count(*) AS n
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = ic.relnamespace
   WHERE ns.nspname = 'public'
     AND NOT (i.indisvalid AND i.indisready AND i.indislive)
     AND (tc.relname IN ('scope_answer_cycle_anchors', 'scope_cycle_rounds',
                         'scope_cycle_anchor_state', 'scope_cycle_registry_runs')
          OR ic.relname = 'scope_runs_project_cycle_idx')
),
-- ⑯-0 라이브 0053 을 run 단위로 한 번만 접는다. **상관 서브쿼리를 쓰지 않는다** —
--     이 계열은 상관 스칼라 서브쿼리로 프로덕션 미러에서 statement_timeout 을 세 번 냈다.
registry_live AS (
  SELECT a.run_id,
         min(reg.anchor)  AS reg_anchor_min,
         max(reg.anchor)  AS reg_anchor_max,
         count(*)::int    AS reg_rows
    FROM scope_answers a
    JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
    JOIN scope_runs r ON r.run_id = a.run_id
   WHERE a.status = 'completed' AND reg.anchor IS NOT NULL AND r.project_id IS NOT NULL
   GROUP BY a.run_id
),
-- ⑯ 0078 run 단위 레지스트리 요약 ↔ 실제 0053 불일치.
--    0053 을 손댄 뒤 **그 job 의 run** 을 refresh 에 넘기지 않으면 여기가 뜬다
--    (0077 파일 머리 주석의 계약. 0078 에서는 그 계약이 값에 직접 영향을 준다).
--
--    ⚠️ **행 수만 보면 안 된다.** 0053 의 `anchor` **값만 정정**하는 편집(행 수 불변)이
--    가장 흔한 형태이고, 그것이야말로 회차 앵커를 통째로 옮긴다. 그래서 요약의
--    `reg_anchor_min`/`reg_anchor_max` 까지 라이브와 대조한다.
--
--    ⚠️ 아직 0078 이 한 번도 돌지 않은 회차는 대상이 아니다(부트스트랩 중 오탐 방지) —
--    회차 상태가 있는 회차만 본다.
registry_summary_drift AS (
  SELECT count(*) AS n FROM (
    -- (a) 요약 ≠ 라이브 (행 수 **또는** 앵커 값)
    SELECT g.run_id
      FROM scope_cycle_registry_runs g
      LEFT JOIN registry_live l ON l.run_id = g.run_id
     WHERE (g.reg_rows, g.reg_anchor_min, g.reg_anchor_max)
             IS DISTINCT FROM
           (l.reg_rows, l.reg_anchor_min, l.reg_anchor_max)
    UNION
    -- (b) 실제로는 레지스트리가 붙었는데 요약에 없다
    SELECT l.run_id
      FROM registry_live l
      JOIN scope_runs r ON r.run_id = l.run_id
     WHERE EXISTS (SELECT 1 FROM scope_cycle_anchor_state st
                    WHERE st.cycle_key = hmg_cycle_key(r.project_id, r.cycle_anchor_at, r.run_id))
       AND NOT EXISTS (SELECT 1 FROM scope_cycle_registry_runs g WHERE g.run_id = l.run_id)
  ) s
)
SELECT * FROM (
  SELECT 'view_anchor_drift'        AS "check", n, CASE WHEN n > 0 THEN 2 ELSE 0 END AS severity,
         '원장 view_anchor_at ≠ 테이블 view_anchor_date. swap.ts 전파 누락 — 고객 화면이 회차를 놓치거나 일찍 연다' AS note FROM view_drift
  UNION ALL
  SELECT 'ledger_anchor_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '회차가 고른 원장 cycle_anchor_at ≠ 테이블 anchor_date (ledger 출처). 기간 필터가 회차를 다른 날짜로 센다' FROM ledger_anchor_drift
  UNION ALL
  SELECT 'cycle_ledger_split', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         '한 회차(프로젝트 + cycle_anchor_at)의 run 이 원장 회차 둘 이상에 걸친다. 결함은 아니나 앵커 선택 규칙(run 앵커 일치 → run 수 최다 → 이른 앵커)이 값에 직접 영향을 준다' FROM cycle_ledger_split
  UNION ALL
  SELECT 'attribution_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '원장 귀속 ≠ 테이블 cycle_id. 재귀속(upsertCycleRunsSql) 경로의 전파 누락 — 숨김 게이트가 엉뚱한 회차를 본다' FROM attribution_drift
  UNION ALL
  SELECT 'run_anchor_drift', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         'scope_runs.cycle_anchor_at ≠ 테이블 anchor_date (run 출처). 그 run 재싱크로 회수된다' FROM run_anchor_drift
  UNION ALL
  SELECT 'missing_rows', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         'completed·project_id NOT NULL 인데 앵커 행이 없다 — 전수 계약 위반(백필 미완 또는 싱크 전파 누락)' FROM missing
  UNION ALL
  SELECT 'orphan_rows', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         '답변이 없는 앵커 행. 자동 삭제하지 않는다 — registry 보정 행이면 수작업 접기의 기록이다' FROM orphans
  UNION ALL
  SELECT 'orphan_rows_pinned', registry_n, 0,
         '위 고아 중 고정 출처(registry — 보존 대상). orphan_rows 와 같으면 정상이다' FROM orphans
  UNION ALL
  SELECT 'stale_status_rows', non_registry_n, CASE WHEN non_registry_n > 0 THEN 1 ELSE 0 END,
         'completed 가 아닌 답변의 비고정 앵커 행. 그 run 재싱크가 지운다(B8)' FROM stale_status
  UNION ALL
  SELECT 'derived_key_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         'anchor_week/month/at 이 anchor_date 와 어긋난다 — 타임존 변경 후 --recompute 미실행' FROM derived_drift
  UNION ALL
  SELECT 'view_date_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         'view_anchor_date 가 자기 anchor_date·원장 값에서 나오지 않는다(N-1). 보존 경로의 재계산 누락' FROM view_date_drift
  UNION ALL
  SELECT 'cycle_anchor_split', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '같은 회차(프로젝트 + cycle_anchor_at)의 답변이 서로 다른 anchor_date 를 갖는다 - 회차 단위 상속이 깨졌다(전파 누락 가능)' FROM cycle_anchor_split
  UNION ALL
  SELECT 'project_week_split', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '한 (프로젝트, KST 주)에 귀속 날짜가 둘 이상 - 정규 요일 표면에서는 구조적으로 불가능하다(배정·전파 결함)' FROM project_week_split
  UNION ALL
  SELECT 'registry_utc_date_kept', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         '0053 이관 미완: UTC 일자가 그 날짜인 회차를 못 찾아 원래 날짜를 유지한 registry 행' FROM registry_utc_kept
  UNION ALL
  SELECT 'off_canonical_round_date', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '귀속 날짜가 그 표면의 정규 요일이 아니다(글로벌=월·웹사이트=금). 배정 규칙 위반' FROM off_canonical
  UNION ALL
  SELECT 'round_date_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '매핑 표 ≠ 답변 테이블의 round_date. 전파 누락 — 기간 술어가 옛 자리를 본다' FROM round_drift
  UNION ALL
  SELECT 'merged_seats', seats, 0,
         '한 자리에 회차가 둘 이상 합쳐진 자리 수(규칙이 허용한다. 지표일 뿐 결함이 아니다)' FROM merged_seats
  UNION ALL
  SELECT 'merged_seat_cycles', cycles, 0,
         '위 자리들에 앉은 회차 수' FROM merged_seats
  UNION ALL
  SELECT 'orphan_round_rows', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         '답변이 없는 배정(고아 자리). 점유로 계속 작동해 새 배정을 밀어낸다 — db:reassign:cycle-rounds 로 정리' FROM orphan_rounds
  UNION ALL
  SELECT 'merged_seat_view_split', n, CASE WHEN n > 0 THEN 1 ELSE 0 END,
         '합쳐진 자리 안에서 노출일이 갈린다 - 그 날짜는 보이는데 답변 일부가 아직 안 나온다(설계상 허용, 규모 확인용)' FROM merged_view_split
  UNION ALL
  SELECT 'basis/' || surface || '/' || basis, n, 0,
         '표면별 귀속 basis 분포(지표. canonical=정규 요일 당일, merged=자리 합침)' FROM basis_dist
  UNION ALL
  SELECT 'cycle_state_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '0078 회차 상태 ≠ 답변 행(surface·anchor_date·source·round_date). 조건부 확장이 "안 바뀌었다"고 오판한다 — 그 회차의 run 으로 refresh 재호출' FROM cycle_state_drift
  UNION ALL
  SELECT 'registry_summary_drift', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '0078 run 단위 레지스트리 요약 ≠ 실제 0053(행 수 또는 앵커 값). 수작업 접기·값 정정 뒤 그 job 의 run 을 refresh 에 안 넘겼다 — 그 run 으로 재호출하면 회수된다' FROM registry_summary_drift
  UNION ALL
  SELECT 'invalid_index', n, CASE WHEN n > 0 THEN 2 ELSE 0 END,
         '인덱스가 INVALID 다(CONCURRENTLY 빌드 잔해). 마이그레이션의 이름 선확인 블록은 이것도 있다로 통과시키고 플래너는 쓰지 않는다 — scripts/db/check-index-validity.sql 의 지시대로 재생성할 것' FROM invalid_index
) t
-- ⚠️ `check` 는 PostgreSQL 의 **예약어**다. 별칭 자리(`AS check`)는 허용되지만
-- `ORDER BY check` 처럼 **컬럼 참조**로 쓰면 syntax error 다. 그래서 둘 다 따옴표로 묶는다.
ORDER BY severity DESC, "check";
