"""ingest.cycles.ledger SQL(loader 쓰기 경로: ing.cycle·cycle_round·cycle_run 원장과 rd.cycle 투영).

식의 근거
  회차 투영      seed-40 §1(rd.cycle = ing.cycle 1:1, servable·view_date·hidden 코드·Q2 카운터 1:1)
  귀속·파생 회차 seed-20 §7-4(run 앵커 → (프로젝트, 앵커) 회차, 앵커 없음 → 같은 KST 측정일 파생 회차, project 표면 = derived)
  좌석(R02)      현행 hmg_assign_cycle_rounds(0077_scope_answer_cycle_anchors.sql:673): 정규 요일(global 월·website 금·project 없음),
                 비정규는 앞·뒤 자리 점유로 prev_empty / next_empty / nearest / merged
  카운터         seed-20 §7-6(셀 (prompt_id, target, region) 수, 완료 답변, 결손 = 언급·인용 모두 없음)
  종결(R01)      현행 summary-cycles.ts:1232-1258 3팔: 다음 앵커 ∧ 멤버 run 존재 / 100% ∧ 멤버 run started_at 모두 정온(36h) 밖 /
                 멤버 run started_at 모두 재확인 창(3일) 밖. started_at NULL 이면 닫지 않는다.
  발행(R08)      closed ∧ analysis_done_ratio ≥ analysis_publish_ratio → published, view_anchor_at = (anchor_date + 표면 지연) KST 자정.
                 global·website 는 발행 게이트(DB-v2.14, 제품 결정 16~18)를 더한다: 게이트 pass(활성 유닛 100% 완료) ∧ 비율, 또는 forced.
  게이트         분모 = 회차 계획(ing.cycle_unit, 개설 시점 ing.active_units 스냅샷) ∩ 현재 ing.active_units(도중 비활성 제외) − 봉인.
                 완료 = 그 유닛에 회차 run 의 completed 답변이 있음(COUNTERS 와 같은 완료 술어). pass = 빠짐 0 ∧ (활성 > 0 ∨ 봉인 > 0).
"""

PROJECT_CYCLES = """
WITH src AS (
  SELECT c.cyc_key, c.cycle_id, sf.s AS surface, dp.project_key, c.anchor_source <> 'derived' AS ledger_backed, c.round_date, c.anchor_date,
         (CASE c.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 WHEN 'published' THEN 2 WHEN 'stale' THEN 3 END)::int2 AS status,
         CASE WHEN sf.s = 3 THEN true ELSE c.status = 'published' AND c.fleet_visible END AS servable,
         coalesce((c.view_anchor_at AT TIME ZONE 'Asia/Seoul')::date,
                  CASE WHEN sf.s = 3 THEN c.anchor_date + coalesce((SELECT (value ->> 'project')::int FROM app.rule_param
                                                                     WHERE key = 'view_delay_days_by_surface'), 1) END) AS view_date,
         (CASE c.hidden_scope WHEN 'all' THEN 1 WHEN 'citations' THEN 2 WHEN 'mentions' THEN 3 ELSE 0 END)::int2 AS hidden_scope,
         c.generation,
         (CASE c.hidden_reason WHEN 'collection_error' THEN 1 WHEN 'operator' THEN 2 ELSE 0 END)::int2 AS hidden_reason,
         c.expected_units, c.completed_units, c.completed_answers, c.gap_answers
    FROM ing.cycle c
    CROSS JOIN LATERAL (SELECT (CASE c.surface WHEN 'global' THEN 1 WHEN 'website' THEN 2 ELSE 3 END)::int2 AS s) sf
    JOIN rd.dim_project dp ON dp.scope_project_id = c.scope_project_id
   WHERE c.cycle_id = ANY($1::uuid[]))
INSERT INTO rd.cycle AS r (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date,
                           hidden_scope, generation, hidden_reason, expected_units, completed_units, completed_answers, gap_answers)
SELECT cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date,
       hidden_scope, generation, hidden_reason, expected_units, completed_units, completed_answers, gap_answers FROM src
ON CONFLICT (cyc_key) DO UPDATE SET
  cycle_id = EXCLUDED.cycle_id, surface = EXCLUDED.surface, project_key = EXCLUDED.project_key, ledger_backed = EXCLUDED.ledger_backed,
  round_date = EXCLUDED.round_date, anchor_date = EXCLUDED.anchor_date, status = EXCLUDED.status, servable = EXCLUDED.servable,
  view_date = EXCLUDED.view_date, hidden_scope = EXCLUDED.hidden_scope, hidden_reason = EXCLUDED.hidden_reason,
  expected_units = EXCLUDED.expected_units, completed_units = EXCLUDED.completed_units, completed_answers = EXCLUDED.completed_answers,
  gap_answers = EXCLUDED.gap_answers
WHERE (r.cycle_id, r.surface, r.project_key, r.ledger_backed, r.round_date, r.anchor_date, r.status, r.servable, r.view_date,
       r.hidden_scope, r.hidden_reason, r.expected_units, r.completed_units, r.completed_answers, r.gap_answers)
      IS DISTINCT FROM
      (EXCLUDED.cycle_id, EXCLUDED.surface, EXCLUDED.project_key, EXCLUDED.ledger_backed, EXCLUDED.round_date, EXCLUDED.anchor_date,
       EXCLUDED.status, EXCLUDED.servable, EXCLUDED.view_date, EXCLUDED.hidden_scope, EXCLUDED.hidden_reason, EXCLUDED.expected_units,
       EXCLUDED.completed_units, EXCLUDED.completed_answers, EXCLUDED.gap_answers)
RETURNING r.cyc_key, r.cycle_id, r.surface
"""
# 창 판정용 함대 가시·판정 갭(DB-v2.30 P150): 투영한 회차가 속한 (표면, 프로젝트, 주) 묶음을 다시 계산(현행 cycleFleetSql 순위가 묶음 단위)
REFRESH_PICK_BASIS = "SELECT rd.refresh_cycle_pick_basis($1::uuid[])"
# 투영 전 round_date(좌석 이동 감지: 사실 행이 다른 leaf 로 옮겨야 한다)
CYCLE_ROUND_BEFORE = "SELECT cyc_key, round_date FROM rd.cycle WHERE cycle_id = ANY($1::uuid[])"
# 경로별 셀 대표(현행 프로필 rep_round_date_cell, WU-12): 답변분석 대표의 후보 = 서빙 ∧ 숨김 아님 회차라 이 값이 바뀌면 그 자리(옛·새 round_date)를
# 다시 고른다(rd.reselect_rep_seat, DB-v2.19 P110). 반환 = is_rep 이 바뀐 답변 키(자식 사본은 rd.propagate_answer_gates)
CYCLE_SEAT_STATE = "SELECT cyc_key, surface, round_date, servable, hidden_scope FROM rd.cycle WHERE cycle_id = ANY($1::uuid[])"
SEAT_RESELECT = """
SELECT f.answer_key FROM rd.reselect_rep_seat($1::int2[], $2::date[], ARRAY[]::int4[], ARRAY[]::int2[]) f   -- unnest 가 빈 배열을 NULL 로 채운다 = 자리 전체
"""

# ── 귀속 ──
UNATTRIBUTED_RUNS = """
SELECT r.run_id, r.scope_project_id, r.cycle_anchor_at, r.started_at,
       coalesce(sc.surface, (SELECT c.surface FROM ing.cycle c WHERE c.scope_project_id = r.scope_project_id ORDER BY c.cycle_anchor_at DESC LIMIT 1),
                CASE WHEN EXISTS (SELECT 1 FROM app.website_site w WHERE w.scope_project_id = r.scope_project_id) THEN 'website'
                     WHEN EXISTS (SELECT 1 FROM app.project p WHERE p.scope_project_id = r.scope_project_id AND p.kind = 'standard_root') THEN 'global'
                     ELSE 'project' END) AS surface,
       coalesce((SELECT min(a.measured_at) FROM ing.answer a WHERE a.run_id = r.run_id), r.started_at) AS first_at
  FROM ing.run r LEFT JOIN ing.sync_cursor sc ON sc.scope_project_id = r.scope_project_id
 WHERE r.run_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM ing.cycle_run cr WHERE cr.run_id = r.run_id)
 ORDER BY r.scope_project_id, r.started_at NULLS LAST, r.run_id
"""
FIND_CYCLE = "SELECT cycle_id, status, origin, anchor_source FROM ing.cycle WHERE scope_project_id = $1 AND cycle_anchor_at = $2"
# 앵커 없는 run: 같은 프로젝트·같은 KST 측정일의 파생 회차(앵커 없는 run 묶음)
FIND_DERIVED = """
SELECT cycle_id, status, origin, anchor_source, cycle_anchor_at FROM ing.cycle
 WHERE scope_project_id = $1 AND anchor_source = 'derived' AND anchor_date = ($2::timestamptz AT TIME ZONE 'Asia/Seoul')::date
 ORDER BY cycle_anchor_at LIMIT 1
"""
SEAT_OF = "SELECT round_date, basis FROM ing.cycle_round WHERE scope_project_id = $1 AND anchor_date = $2"
SEAT_TAKEN = """
SELECT EXISTS (SELECT 1 FROM ing.cycle_round WHERE scope_project_id = $1 AND round_date = $2)
    OR EXISTS (SELECT 1 FROM ing.cycle WHERE scope_project_id = $1 AND round_date = $2)
"""
INSERT_SEAT = """
INSERT INTO ing.cycle_round (scope_project_id, anchor_date, surface, round_date, basis) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (scope_project_id, anchor_date) DO NOTHING
"""
INSERT_CYCLE = """
INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, generation, origin, updated_at)
VALUES (md5('derived|' || $1::uuid::text || '|' || (extract(epoch FROM $2::timestamptz) * 1000000)::bigint::text)::uuid,
        $3, $1::uuid, $2::timestamptz, $4, ($2::timestamptz AT TIME ZONE 'Asia/Seoul')::date, $5, 'open', 1, 'loader', now())
ON CONFLICT (scope_project_id, cycle_anchor_at) DO NOTHING
RETURNING cycle_id
"""
INSERT_CYCLE_RUN = """
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING
"""
MARK_STALE = "UPDATE ing.cycle SET stale_since = coalesce(stale_since, now()), updated_at = now() WHERE cycle_id = $1 AND status = 'published'"

# ── 재평가: 카운터 → 종결 → 발행 ──
# 원장 이관 회차(origin summary_cycles)의 기대·완료 유닛은 동결값 보존(P6), 적재기 회차는 매번 다시 센다.
COUNTERS = """
WITH s AS (
  SELECT cr.cycle_id,
         count(DISTINCT (a.prompt_id, a.target, a.region)) AS expected_units,
         count(DISTINCT (a.prompt_id, a.target, a.region)) FILTER (WHERE a.status = 'completed') AS completed_units,
         count(*) FILTER (WHERE a.status = 'completed') AS completed_answers,
         count(*) FILTER (WHERE a.status = 'completed' AND a.n_mentions = 0 AND a.n_citations = 0) AS gap_answers
    FROM ing.cycle_run cr JOIN ing.answer a ON a.run_id = cr.run_id
   WHERE cr.cycle_id = ANY($1::uuid[])
   GROUP BY cr.cycle_id)
UPDATE ing.cycle c SET
  expected_units = CASE WHEN c.origin = 'summary_cycles' THEN coalesce(c.expected_units, s.expected_units) ELSE s.expected_units END,
  completed_units = CASE WHEN c.origin = 'summary_cycles' THEN coalesce(c.completed_units, s.completed_units) ELSE s.completed_units END,
  completed_answers = s.completed_answers, gap_answers = s.gap_answers, updated_at = now()
  FROM s WHERE s.cycle_id = c.cycle_id
   AND (c.expected_units, c.completed_units, c.completed_answers, c.gap_answers) IS DISTINCT FROM
       (CASE WHEN c.origin = 'summary_cycles' THEN coalesce(c.expected_units, s.expected_units) ELSE s.expected_units END,
        CASE WHEN c.origin = 'summary_cycles' THEN coalesce(c.completed_units, s.completed_units) ELSE s.completed_units END,
        s.completed_answers, s.gap_answers)
RETURNING c.cycle_id
"""
# R01 3팔. $2 = now, $3 = 정온 시간(h), $4 = 재확인 일수
CLOSE_OPEN = """
WITH o AS (
  SELECT c.cycle_id, c.scope_project_id, c.cycle_anchor_at, c.expected_units, c.completed_units,
         EXISTS (SELECT 1 FROM ing.cycle_run cr WHERE cr.cycle_id = c.cycle_id) AS has_mem,
         (SELECT min(n.cycle_anchor_at) FROM ing.cycle n WHERE n.scope_project_id = c.scope_project_id AND n.cycle_anchor_at > c.cycle_anchor_at) AS next_at,
         (SELECT bool_and(r.started_at IS NOT NULL AND r.started_at < $2::timestamptz - make_interval(hours => $3))
            FROM ing.cycle_run cr JOIN ing.run r ON r.run_id = cr.run_id WHERE cr.cycle_id = c.cycle_id) AS quiet,
         (SELECT bool_and(r.started_at IS NOT NULL AND r.started_at < $2::timestamptz - make_interval(days => $4))
            FROM ing.cycle_run cr JOIN ing.run r ON r.run_id = cr.run_id WHERE cr.cycle_id = c.cycle_id) AS past_window,
         (SELECT max(r.started_at) FROM ing.cycle_run cr JOIN ing.run r ON r.run_id = cr.run_id WHERE cr.cycle_id = c.cycle_id) AS last_start
    FROM ing.cycle c WHERE c.status = 'open' AND c.cycle_id = ANY($1::uuid[])),
j AS (
  SELECT o.*, CASE WHEN o.next_at IS NOT NULL AND o.has_mem THEN 'next_anchor'
                   WHEN coalesce(o.expected_units, 0) > 0 AND coalesce(o.completed_units, 0) >= coalesce(o.expected_units, 0) AND coalesce(o.quiet, false)
                        THEN 'complete'
                   WHEN o.has_mem AND coalesce(o.past_window, false) THEN 'recheck_window' END AS cb
    FROM o)
UPDATE ing.cycle c SET status = 'closed', closed_by = j.cb,
       closed_at = CASE j.cb WHEN 'next_anchor' THEN j.next_at WHEN 'recheck_window' THEN j.last_start + make_interval(days => $4) ELSE $2::timestamptz END,
       updated_at = now()
  FROM j WHERE j.cycle_id = c.cycle_id AND j.cb IS NOT NULL
RETURNING c.cycle_id, c.closed_by
"""
# R08: 닫힌 회차 → 발행. 파생(anchor_source derived) 비-project 회차는 현행 규칙 ③(비노출)이라 발행하지 않는다.
#   project 표면은 분석 비율과 무관하게 닫히면 노출(현행 0077 hmg_anchor_view_date ②, seed-20 §7-5).
PUBLISH = """
WITH d AS (SELECT coalesce((SELECT (value #>> '{}')::numeric FROM app.rule_param WHERE key = 'analysis_publish_ratio'), 0.95) AS ratio),
dl AS (SELECT (SELECT value FROM app.rule_param WHERE key = 'view_delay_days_by_surface') AS by_s,
              coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'view_delay_days'), 2) AS dflt)
UPDATE ing.cycle c SET status = 'published', published_at = $2::timestamptz,
       view_anchor_at = coalesce(c.view_anchor_at,
                                 ((c.anchor_date + coalesce((dl.by_s ->> c.surface)::int, dl.dflt))::timestamp AT TIME ZONE 'Asia/Seoul')),
       updated_at = now()
  FROM d, dl
 WHERE c.status = 'closed' AND c.cycle_id = ANY($1::uuid[])
   AND (c.surface = 'project'
        OR (c.anchor_source <> 'derived'
            AND (EXISTS (SELECT 1 FROM ing.cycle_gate g WHERE g.cycle_id = c.cycle_id AND g.verdict = 'forced')
                 OR (c.analysis_done_ratio IS NOT NULL AND c.analysis_done_ratio >= d.ratio
                     AND EXISTS (SELECT 1 FROM ing.cycle_gate g WHERE g.cycle_id = c.cycle_id AND g.verdict = 'pass')))))
RETURNING c.cycle_id
"""

# ── 발행 게이트(DB-v2.14 P81~P83) ──
# 게이트 대상 = global·website ∧ 비파생 ∧ 미발행(open·closed). 이미 발행·stale 회차(이관분 포함)는 건드리지 않는다.
GATED = "c.surface IN ('global', 'website') AND c.anchor_source <> 'derived' AND c.status IN ('open', 'closed')"
# 계획 만들기: 계획(게이트 행)이 없는 대상 회차만. $2 = 'open'(개설 시점) | 'backfill'(이관·배포 창 회차: 앵커 뒤 카탈로그 등록분 제외),
# $3 = now. backfill 로 만드는 이관 회차가 이미 닫혀 있으면 quiet(운영이 발행하지 않은 잔여: 알림·감시 제외, alerted_at 채움).
ENSURE_PLAN = f"""
WITH g AS (
  SELECT c.cycle_id, c.scope_project_id, c.cycle_anchor_at, c.status, c.origin FROM ing.cycle c
   WHERE c.cycle_id = ANY($1::uuid[]) AND {GATED}
     AND NOT EXISTS (SELECT 1 FROM ing.cycle_gate x WHERE x.cycle_id = c.cycle_id)),
u AS (
  INSERT INTO ing.cycle_unit (cycle_id, prompt_id, target, region)
  SELECT g.cycle_id, a.prompt_id, a.target, a.region FROM g CROSS JOIN LATERAL ing.active_units(g.scope_project_id) a
   WHERE $2::text = 'open' OR a.listed_at IS NULL OR a.listed_at <= g.cycle_anchor_at
  ON CONFLICT DO NOTHING
  RETURNING cycle_id),
n AS (SELECT cycle_id, count(*)::int AS k FROM u GROUP BY 1)
INSERT INTO ing.cycle_gate (cycle_id, plan_source, planned_at, plan_units, quiet, alerted_at)
SELECT g.cycle_id, $2::text, $3::timestamptz, coalesce(n.k, 0), q.quiet, CASE WHEN q.quiet THEN $3::timestamptz END
  FROM g LEFT JOIN n USING (cycle_id)
  CROSS JOIN LATERAL (SELECT ($2::text = 'backfill' AND g.origin = 'summary_cycles' AND g.status = 'closed') AS quiet) q
ON CONFLICT (cycle_id) DO NOTHING
RETURNING cycle_id
"""
# 판정: 값이 바뀔 때만 쓴다(틱 무변화 판정 유지). forced 는 유지. $2 = now
GATE_EVAL = """
WITH g AS (
  SELECT c.cycle_id, c.scope_project_id FROM ing.cycle c JOIN ing.cycle_gate cg ON cg.cycle_id = c.cycle_id
   WHERE c.cycle_id = ANY($1::uuid[]) AND c.status IN ('open', 'closed')),
act AS (SELECT g.cycle_id, a.prompt_id, a.target, a.region FROM g CROSS JOIN LATERAL ing.active_units(g.scope_project_id) a),
fin AS (
  SELECT DISTINCT cr.cycle_id, a.prompt_id, a.target, a.region FROM ing.cycle_run cr JOIN ing.answer a ON a.run_id = cr.run_id
   WHERE cr.cycle_id IN (SELECT cycle_id FROM g) AND a.status = 'completed'),
per AS (
  SELECT g.cycle_id,
         count(cu.prompt_id)::int AS plan_units,
         count(cu.prompt_id) FILTER (WHERE cu.sealed_at IS NOT NULL)::int AS sealed,
         count(cu.prompt_id) FILTER (WHERE cu.sealed_at IS NULL AND act.prompt_id IS NULL)::int AS withdrawn,
         count(cu.prompt_id) FILTER (WHERE cu.sealed_at IS NULL AND act.prompt_id IS NOT NULL)::int AS active,
         count(cu.prompt_id) FILTER (WHERE cu.sealed_at IS NULL AND act.prompt_id IS NOT NULL AND f.prompt_id IS NOT NULL)::int AS done
    FROM g
    LEFT JOIN ing.cycle_unit cu ON cu.cycle_id = g.cycle_id
    LEFT JOIN act ON act.cycle_id = cu.cycle_id AND act.prompt_id = cu.prompt_id AND act.target = cu.target AND act.region = cu.region
    LEFT JOIN fin f ON f.cycle_id = cu.cycle_id AND f.prompt_id = cu.prompt_id AND f.target = cu.target AND f.region = cu.region
   GROUP BY g.cycle_id),
v AS (
  SELECT per.*, per.active - per.done AS missing,
         CASE WHEN per.active - per.done = 0 AND (per.active > 0 OR per.sealed > 0) THEN 'pass' ELSE 'blocked' END AS verdict
    FROM per)
UPDATE ing.cycle_gate cg SET plan_units = v.plan_units, active_units = v.active, done_units = v.done, sealed_units = v.sealed,
       withdrawn_units = v.withdrawn, missing_units = v.missing,
       verdict = CASE WHEN cg.verdict = 'forced' THEN 'forced' ELSE v.verdict END, evaluated_at = $2::timestamptz
  FROM v WHERE cg.cycle_id = v.cycle_id
   AND (cg.plan_units, cg.active_units, cg.done_units, cg.sealed_units, cg.withdrawn_units, cg.missing_units, cg.verdict)
       IS DISTINCT FROM (v.plan_units, v.active, v.done, v.sealed, v.withdrawn, v.missing,
                         CASE WHEN cg.verdict = 'forced' THEN 'forced' ELSE v.verdict END)
RETURNING cg.cycle_id, cg.verdict
"""
# 빠진 유닛(계획 ∩ 현재 활성 − 봉인 − 완료). 봉인(전부)·감시 알림이 쓴다. $1 = cycle_id
MISSING_UNITS = """
WITH c AS (SELECT cycle_id, scope_project_id FROM ing.cycle WHERE cycle_id = $1),
act AS (SELECT a.prompt_id, a.target, a.region FROM c CROSS JOIN LATERAL ing.active_units(c.scope_project_id) a)
SELECT cu.prompt_id, cu.target, cu.region FROM ing.cycle_unit cu
  JOIN act ON act.prompt_id = cu.prompt_id AND act.target = cu.target AND act.region = cu.region
 WHERE cu.cycle_id = $1 AND cu.sealed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM ing.cycle_run cr JOIN ing.answer x ON x.run_id = cr.run_id
                    WHERE cr.cycle_id = cu.cycle_id AND x.status = 'completed'
                      AND x.prompt_id = cu.prompt_id AND x.target = cu.target AND x.region = cu.region)
 ORDER BY cu.target, cu.region, cu.prompt_id
"""
# 봉인: $1 cycle, $2 prompt_id[], $3 target[], $4 region[], $5 사유, $6 change_id, $7 요청자. 이미 봉인된 유닛은 그대로(첫 사유 유지)
SEAL_UNITS = """
UPDATE ing.cycle_unit cu SET sealed_at = now(), seal_reason = $5, seal_change_id = $6, sealed_by = $7
  FROM unnest($2::uuid[], $3::text[], $4::text[]) AS s(prompt_id, target, region)
 WHERE cu.cycle_id = $1 AND cu.prompt_id = s.prompt_id AND cu.target = s.target AND cu.region = s.region AND cu.sealed_at IS NULL
RETURNING cu.prompt_id
"""
PLAN_HAS = """
SELECT count(*) FROM unnest($2::uuid[], $3::text[], $4::text[]) AS s(prompt_id, target, region)
 WHERE NOT EXISTS (SELECT 1 FROM ing.cycle_unit cu WHERE cu.cycle_id = $1 AND cu.prompt_id = s.prompt_id AND cu.target = s.target AND cu.region = s.region)
"""
FORCE_GATE = """
UPDATE ing.cycle_gate SET verdict = 'forced', forced_at = now(), forced_reason = $2, forced_by = $3, force_change_id = $4
 WHERE cycle_id = $1 AND verdict IS DISTINCT FROM 'forced' RETURNING cycle_id
"""
CYCLE_GATE_OF = """
SELECT c.cycle_id, c.status, c.surface, c.anchor_source, g.verdict FROM ing.cycle c LEFT JOIN ing.cycle_gate g ON g.cycle_id = c.cycle_id
 WHERE c.cycle_id = $1
"""
CYCLES_OF_RUNS = "SELECT DISTINCT cycle_id FROM ing.cycle_run WHERE run_id = ANY($1::uuid[])"
RUNS_OF_CYCLES = "SELECT run_id FROM ing.cycle_run WHERE cycle_id = ANY($1::uuid[])"
# 시간만 흘러 판정이 바뀔 수 있는 회차(틱): 열린 회차, 발행 대기(닫힘), 노출일이 오늘인 발행 회차
TICK_CANDIDATES = """
SELECT cycle_id FROM ing.cycle WHERE status IN ('open', 'closed')
UNION SELECT cycle_id FROM ing.cycle c WHERE c.status = 'published' AND c.view_anchor_at IS NOT NULL
   AND (c.view_anchor_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN rd.today_kst() - 1 AND rd.today_kst()
"""

# ── 운영 요청(cycle_admin) ──
ADMIN_HIDE = """
UPDATE ing.cycle SET hidden_scope = $2, hidden_reason = $3, hidden_at = now(), updated_at = now()
 WHERE cycle_id = $1 AND (hidden_scope, hidden_reason) IS DISTINCT FROM ($2, $3) RETURNING cycle_id
"""
ADMIN_UNHIDE = """
UPDATE ing.cycle SET hidden_scope = NULL, hidden_reason = NULL, hidden_at = NULL, updated_at = now()
 WHERE cycle_id = $1 AND hidden_scope IS NOT NULL RETURNING cycle_id
"""
ADMIN_CLOSE = """
UPDATE ing.cycle SET status = 'closed', closed_by = 'operator', closed_at = now(), updated_at = now()
 WHERE cycle_id = $1 AND status = 'open' RETURNING cycle_id
"""
ADMIN_VIEW_DATE = """
UPDATE ing.cycle SET view_anchor_at = ($2::date::timestamp AT TIME ZONE 'Asia/Seoul'), updated_at = now()
 WHERE cycle_id = $1 AND view_anchor_at IS DISTINCT FROM ($2::date::timestamp AT TIME ZONE 'Asia/Seoul') RETURNING cycle_id
"""
CYCLE_EXISTS = "SELECT cycle_id, status FROM ing.cycle WHERE cycle_id = $1"

# ── 발행값(report_publication, seed-40 §10 을 해당 round_date 로 좁힘) ──
REPORT_DATES = """
SELECT DISTINCT d FROM (SELECT round_date AS d FROM app.report_publication WHERE id = ANY($1::uuid[])
                        UNION SELECT round_date FROM rd.report_unit_value WHERE pub_id = ANY($1::uuid[])) x WHERE d IS NOT NULL
"""
REPORT_DELETE = "DELETE FROM rd.report_unit_value WHERE round_date = ANY($1::date[])"
REPORT_INSERT = """
INSERT INTO rd.report_unit_value (round_date, file_seq, cyc_key, pub_id, brand, country_code, lang_code, in_headline_pool,
                                  target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den,
                                  prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, load_id)
SELECT DISTINCT ON (p.round_date, f.file_seq) p.round_date, f.file_seq,
       (SELECT c.cyc_key FROM rd.web_unit w JOIN rd.cycle c ON c.project_key = w.project_key AND c.surface = 2 AND c.round_date = p.round_date
         WHERE w.file_seq = f.file_seq ORDER BY c.cyc_key LIMIT 1),
       p.id, f.brand, f.country_code, f.lang_code, f.in_headline_pool, f.target_hit_prompts, f.measured_prompts, f.owned_prompts, f.owned_prompts_den,
       f.prev_target_hit_prompts, f.prev_measured_prompts, f.prev_owned_prompts, f.prev_owned_prompts_den, $2
  FROM app.report_publication p JOIN app.report_site_fact f ON f.publication_id = p.id
 WHERE p.status = 'active' AND p.round_date = ANY($1::date[])
 ORDER BY p.round_date, f.file_seq, p.published_on DESC NULLS LAST, p.ingested_at DESC, p.id
"""
REPORT_DROPPED = """
SELECT count(*) - (SELECT count(*) FROM rd.report_unit_value WHERE round_date = ANY($1::date[]))
  FROM app.report_publication p JOIN app.report_site_fact f ON f.publication_id = p.id WHERE p.status = 'active' AND p.round_date = ANY($1::date[])
"""

# ── 앵커 고정·드롭(ing 레지스트리) ──
JOB_OF = """
SELECT a.job_id, a.run_id, a.measured_at, k.answer_key FROM ing.answer_key_map k JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
 WHERE k.job_id = $1
"""
PIN_UPSERT = """
INSERT INTO ing.answer_anchor_pin (job_id, anchor, source_measured_at, reason, origin, change_id) VALUES ($1, $2, $3, $4, 'operator', $5)
ON CONFLICT (job_id) DO UPDATE SET anchor = EXCLUDED.anchor, source_measured_at = EXCLUDED.source_measured_at, reason = EXCLUDED.reason,
       origin = EXCLUDED.origin, change_id = EXCLUDED.change_id, pinned_at = now()
"""
PIN_DELETE = "DELETE FROM ing.answer_anchor_pin WHERE job_id = $1"
DROP_UPSERT = """
INSERT INTO ing.answer_drop (job_id, source_measured_at, reason, origin, change_id) VALUES ($1, $2, $3, 'operator', $4)
ON CONFLICT (job_id) DO UPDATE SET reason = EXCLUDED.reason, origin = EXCLUDED.origin, change_id = EXCLUDED.change_id, dropped_at = now()
"""
DROP_DELETE = "DELETE FROM ing.answer_drop WHERE job_id = $1"
