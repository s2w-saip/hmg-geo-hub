-- ============================================================================
-- seed-4x-ecat.sql : 엔티티 버전 오버레이의 언급 보정(E1, DB-v2.17). bulk 시드(seed-40 §5)와 적재기(ingest.project.apply FACT_SRC)가
--   같은 파일을 쓴다(적재기는 ingest.common.rules.ecat_overlay_sql 로 읽는다). psql 메타 명령 없음, 영구 객체 없음(pg_temp 만).
-- 입력  _ecat_in(answer_key, run_month, job_id, ecat_ver, content_hash, body_turn) = 투영할 완료 답변과 그 답변의 버전.
--       §4 규칙 표(_ecat_blk·_ecat_add·_ecat_hent) · §10 함수(ecat_norm·ecat_resolve).
-- 출력  _ecat_madj(answer_key, ord, dropm, cnt, s_*, t_*)   Scope 언급 1행의 보정 값(dropm = 뺌, 나머지 = 보정 뒤 최종 값). 행 없음 = 원본 그대로
--       _ecat_hnew(answer_key, entity_id, disp, rollup, ovr, cnt, avg_position)  재매칭 새 언급(감성 미상 = 감성 4종 0, 유형 type_mention 만)
-- 규칙(설계 1-2 표)
--   차단  언급에 발생 행이 있으면(9월 이후 적재분) 차단 표면 발생만 빼고 개수·감성을 다시 센다(발생이 전부 차단이면 언급을 뺀다).
--         유형 5종은 발생 단위 값이 없어 그대로 두되 새 개수를 넘지 않게 자른다. 발생 행이 없으면(6~8월) 표면 배열이 전부 차단일 때만 빼고
--         일부면 그대로 둔다(근사). 표면 비교 = 원문 표면의 ecat_norm = surface_norm, 엔티티 한정 차단은 그 엔티티(와 그리로 병합되는 원본)의 언급만.
--   추가  ing.hub_match(켜진 add 표면, 본문 해시 = 지금 content_hash) → 본문 턴의 Scope 발생과 겹치는 발생을 빼고 겹침 제거(ecat_resolve)
--         → 엔티티별: Scope 언급이 없으면 새 언급, 있고 그 턴 발생이 있으면 Scope 언급에 개수를 더함(위치 불변), 있는데 그 턴 발생이
--         없으면 존재만 인정(더하지 않음). 새 언급 위치 = 그 턴에 Scope 발생이 있고 job 의 모든 Scope 언급 엔티티가 그 턴 발생을 가질 때
--         1 + (첫 발생이 더 앞인 다른 엔티티 수), 아니면 NULL. matcher.build_rematch_mentions·ingest.ecat.rematch(E2)와 같은 규칙.
--         더할 대상 Scope 언급이 차단으로 빠졌으면 새 언급(위치 NULL)으로 넣는다. 제거 엔티티(_ecat_hent.removed)는 재매칭하지 않는다.
-- 비용: 차단·추가 표면이 없으면(v1·legacy) 모든 문장이 맨 위 한 번 거르기(One-Time Filter)로 원천을 읽지 않는다.
-- ============================================================================

-- ── A. 차단 표면의 원문 표기(서로 다른 원문 표면 단위로 1회 정규화) ─────────────────────────────
DROP TABLE IF EXISTS _ecat_braw;
CREATE TEMP TABLE _ecat_braw AS
WITH ins AS (SELECT i.* FROM _ecat_in i WHERE i.ecat_ver IN (SELECT ver FROM _ecat_blk)),
raws AS (
  SELECT DISTINCT u AS raw FROM ins i JOIN ing.mention m ON m.run_month = i.run_month AND m.job_id = i.job_id
         CROSS JOIN LATERAL unnest(m.surfaces) u
  UNION
  SELECT DISTINCT o.surface_text FROM ins i JOIN ing.mention_occurrence o ON o.run_month = i.run_month AND o.job_id = i.job_id),
n AS (SELECT raw, pg_temp.ecat_norm(raw) AS norm FROM raws WHERE raw IS NOT NULL)
SELECT DISTINCT b.ver, b.entity_id, n.raw FROM n JOIN _ecat_blk b ON b.surface_norm = n.norm
 WHERE (SELECT EXISTS (SELECT 1 FROM _ecat_blk));
CREATE INDEX ON _ecat_braw USING hash (raw);   -- 원문 표면(Scope 문자열, 길이 보장 없음): btree 2,704 바이트 상한을 피해 해시 색인(be/int3-longkey)
ANALYZE _ecat_braw;

-- ── B. 차단된 Scope 발생(답변 × 엔티티)
DROP TABLE IF EXISTS _ecat_bocc;
CREATE TEMP TABLE _ecat_bocc AS
SELECT i.answer_key, o.entity_id, count(*)::int AS n_blk,
       count(*) FILTER (WHERE o.sentiment = 'positive')::int AS b_pos, count(*) FILTER (WHERE o.sentiment = 'neutral')::int AS b_neu,
       count(*) FILTER (WHERE o.sentiment = 'negative')::int AS b_neg, count(*) FILTER (WHERE o.sentiment = 'mixed')::int AS b_mix
  FROM _ecat_in i JOIN ing.mention_occurrence o ON o.run_month = i.run_month AND o.job_id = i.job_id
 WHERE EXISTS (SELECT 1 FROM _ecat_braw b WHERE b.raw = o.surface_text AND b.ver = i.ecat_ver AND (b.entity_id IS NULL OR b.entity_id = o.entity_id))
   AND (SELECT EXISTS (SELECT 1 FROM _ecat_braw))
 GROUP BY 1, 2;
CREATE UNIQUE INDEX ON _ecat_bocc (answer_key, entity_id);

-- ── C. 차단 후보 언급(표면 배열 또는 발생에 차단 표면이 있는 언급) + 그 언급의 발생 수
DROP TABLE IF EXISTS _ecat_mb;
CREATE TEMP TABLE _ecat_mb AS
SELECT i.answer_key, m.run_month, m.job_id, m.ord, m.entity_id, m.mention_count,
       m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed,
       m.type_mention, m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice,
       coalesce(bo.n_blk, 0) AS n_blk, coalesce(bo.b_pos, 0) AS b_pos, coalesce(bo.b_neu, 0) AS b_neu,
       coalesce(bo.b_neg, 0) AS b_neg, coalesce(bo.b_mix, 0) AS b_mix,
       coalesce(cardinality(m.surfaces) > 0 AND NOT EXISTS (
         SELECT 1 FROM unnest(m.surfaces) u
          WHERE NOT EXISTS (SELECT 1 FROM _ecat_braw b WHERE b.raw = u AND b.ver = i.ecat_ver AND (b.entity_id IS NULL OR b.entity_id = m.entity_id))),
         false) AS surf_all,
       (SELECT count(*) FROM ing.mention_occurrence o WHERE o.run_month = m.run_month AND o.job_id = m.job_id AND o.entity_id = m.entity_id)::int AS occ_n
  FROM _ecat_in i JOIN ing.mention m ON m.run_month = i.run_month AND m.job_id = i.job_id
  LEFT JOIN _ecat_bocc bo ON bo.answer_key = i.answer_key AND bo.entity_id = m.entity_id
 WHERE (bo.answer_key IS NOT NULL
        OR EXISTS (SELECT 1 FROM unnest(m.surfaces) u JOIN _ecat_braw b ON b.raw = u
                    WHERE b.ver = i.ecat_ver AND (b.entity_id IS NULL OR b.entity_id = m.entity_id)))
   AND (SELECT EXISTS (SELECT 1 FROM _ecat_braw));

-- ── D. 차단 보정 → _ecat_madj
DROP TABLE IF EXISTS _ecat_madj;
CREATE TEMP TABLE _ecat_madj AS
WITH d AS (
  SELECT x.*, CASE WHEN x.occ_n > 0 THEN x.n_blk >= x.occ_n ELSE x.surf_all END AS dropm,
         greatest(x.mention_count - x.n_blk, x.occ_n - x.n_blk, 0) AS cnt
    FROM _ecat_mb x
   WHERE (x.occ_n > 0 AND x.n_blk > 0) OR (x.occ_n = 0 AND x.surf_all))
SELECT d.answer_key, d.ord, d.dropm, d.cnt,
       greatest(d.sentiment_positive - d.b_pos, 0) AS s_pos, greatest(d.sentiment_neutral - d.b_neu, 0) AS s_neu,
       greatest(d.sentiment_negative - d.b_neg, 0) AS s_neg, greatest(d.sentiment_mixed - d.b_mix, 0) AS s_mix,
       least(d.type_mention, d.cnt) AS t_mention, least(d.type_recommendation, d.cnt) AS t_recommendation,
       least(d.type_comparison, d.cnt) AS t_comparison, least(d.type_definition, d.cnt) AS t_definition,
       least(d.type_final_choice, d.cnt) AS t_final_choice, false AS hub_added
  FROM d;
CREATE UNIQUE INDEX ON _ecat_madj (answer_key, ord);

-- ── E. 재매칭(추가 표면) ────────────────────────────────────────────────────────
-- E1 켠 add 표면의 유효 스캔 행(스캔 당시 본문 해시 = 지금 본문 해시, 답변 버전이 켠 표면, 제거 엔티티 아님)
DROP TABLE IF EXISTS _ecat_hm;
CREATE TEMP TABLE _ecat_hm AS
SELECT i.answer_key, i.run_month, i.job_id, i.ecat_ver AS ver, i.body_turn, h.turn_index, h.surface_id, h.entity_id, h.starts, h.ends
  FROM _ecat_in i
  JOIN _ecat_add a ON a.ver = i.ecat_ver
  JOIN ing.hub_match h ON h.surface_id = a.surface_id AND h.run_month = i.run_month AND h.job_id = i.job_id AND h.answer_hash = i.content_hash
  JOIN _ecat_hent he ON he.ver = i.ecat_ver AND he.entity_id = h.entity_id AND NOT he.removed
 WHERE (SELECT EXISTS (SELECT 1 FROM _ecat_add));
-- E2 턴별 Scope 발생(턴 번호 NULL 은 단일 턴 답변이면 본문 턴 1 로 본다: E2 rematch 와 같음)
DROP TABLE IF EXISTS _ecat_hocc;
CREATE TEMP TABLE _ecat_hocc AS
SELECT j.answer_key, t.turn, o.entity_id, o.source_start, o.source_end
  FROM (SELECT DISTINCT answer_key, run_month, job_id, body_turn FROM _ecat_hm) j
  JOIN ing.mention_occurrence o ON o.run_month = j.run_month AND o.job_id = j.job_id
  CROSS JOIN LATERAL (SELECT coalesce(o.turn_index, CASE WHEN j.body_turn = 1 THEN 1 END)::int2 AS turn) t
 WHERE t.turn IS NOT NULL;
-- E3 겹침 제거(턴마다 1회) → 남은 발생
DROP TABLE IF EXISTS _ecat_hk;
CREATE TEMP TABLE _ecat_hk AS
WITH hits AS (
  SELECT hm.answer_key, hm.turn_index, hm.surface_id, hm.entity_id, u.s, u.e
    FROM _ecat_hm hm CROSS JOIN LATERAL unnest(hm.starts, hm.ends) AS u(s, e)),
g AS (
  SELECT answer_key, turn_index, array_agg(s ORDER BY s, e, surface_id) AS hs, array_agg(e ORDER BY s, e, surface_id) AS he,
         array_agg(surface_id ORDER BY s, e, surface_id) AS hsid, array_agg(entity_id ORDER BY s, e, surface_id) AS hent
    FROM hits GROUP BY 1, 2),
occ AS (SELECT answer_key, turn, array_agg(source_start) AS os, array_agg(source_end) AS oe FROM _ecat_hocc GROUP BY 1, 2)
SELECT g.answer_key, g.turn_index, g.hent[k] AS entity_id, g.hs[k] AS s
  FROM g LEFT JOIN occ ON occ.answer_key = g.answer_key AND occ.turn = g.turn_index
  CROSS JOIN LATERAL pg_temp.ecat_resolve(g.hs, g.he, g.hsid, g.hent, occ.os, occ.oe) AS k;
-- E4 엔티티별 재매칭 언급(턴 × 엔티티). scope = job 의 Scope 언급 엔티티 ∪ 그 턴 발생 엔티티, first = 그 턴 첫 발생(NULL = 위치 모름).
--    새 언급 위치 = 1 + (그 턴에서 첫 발생이 더 앞인 다른 엔티티 수: 첫 발생 있는 Scope 엔티티 ∪ 새 엔티티) = 그 목록의 rank().
--    위치 판정(rank_ok) = 그 턴에 Scope 발생이 있고(positions_known) 모든 Scope 언급 엔티티의 첫 발생이 있다.
DROP TABLE IF EXISTS _ecat_hent1;
CREATE TEMP TABLE _ecat_hent1 AS
SELECT k.answer_key, k.turn_index, k.entity_id, count(*)::int AS n, min(k.s) AS first_start FROM _ecat_hk k GROUP BY 1, 2, 3;
CREATE UNIQUE INDEX ON _ecat_hent1 (answer_key, turn_index, entity_id);
DROP TABLE IF EXISTS _ecat_hscope;
CREATE TEMP TABLE _ecat_hscope AS
WITH turns AS (SELECT DISTINCT e.answer_key, e.turn_index, hm.run_month, hm.job_id
                 FROM _ecat_hent1 e JOIN (SELECT DISTINCT answer_key, run_month, job_id FROM _ecat_hm) hm ON hm.answer_key = e.answer_key),
sf AS (SELECT answer_key, turn, entity_id, min(source_start) AS first_start FROM _ecat_hocc GROUP BY 1, 2, 3),
ents AS (SELECT t.answer_key, t.turn_index, m.entity_id FROM turns t JOIN ing.mention m ON m.run_month = t.run_month AND m.job_id = t.job_id
         UNION
         SELECT t.answer_key, t.turn_index, sf.entity_id FROM turns t JOIN sf ON sf.answer_key = t.answer_key AND sf.turn = t.turn_index)
SELECT e.answer_key, e.turn_index, e.entity_id, sf.first_start
  FROM ents e LEFT JOIN sf ON sf.answer_key = e.answer_key AND sf.turn = e.turn_index AND sf.entity_id = e.entity_id;
CREATE UNIQUE INDEX ON _ecat_hscope (answer_key, turn_index, entity_id);
ANALYZE _ecat_hent1, _ecat_hscope;
DROP TABLE IF EXISTS _ecat_hr;
CREATE TEMP TABLE _ecat_hr AS
WITH tk AS (
  SELECT answer_key, turn_index, bool_or(first_start IS NOT NULL) AND bool_and(first_start IS NOT NULL) AS rank_ok
    FROM _ecat_hscope GROUP BY 1, 2),
r AS (
  SELECT e.*, s.entity_id IS NOT NULL AS in_scope, s.first_start AS scope_first
    FROM _ecat_hent1 e LEFT JOIN _ecat_hscope s ON s.answer_key = e.answer_key AND s.turn_index = e.turn_index AND s.entity_id = e.entity_id),
pos AS (   -- 순위 목록: 첫 발생 있는 Scope 엔티티 ∪ 새 엔티티
  SELECT answer_key, turn_index, entity_id, false AS is_new,
         rank() OVER (PARTITION BY answer_key, turn_index ORDER BY first_start) AS rk
    FROM (SELECT answer_key, turn_index, entity_id, first_start FROM _ecat_hscope WHERE first_start IS NOT NULL
          UNION ALL SELECT answer_key, turn_index, entity_id, first_start FROM r WHERE NOT in_scope) x)
SELECT r.answer_key, r.turn_index, r.entity_id, NOT r.in_scope AS is_new, r.n, r.first_start,
       CASE WHEN NOT r.in_scope AND coalesce(tk.rank_ok, false) THEN p.rk::real END AS avg_position
  FROM r LEFT JOIN tk ON tk.answer_key = r.answer_key AND tk.turn_index = r.turn_index
  LEFT JOIN pos p ON p.answer_key = r.answer_key AND p.turn_index = r.turn_index AND p.entity_id = r.entity_id AND NOT r.in_scope
 WHERE NOT r.in_scope OR r.scope_first IS NOT NULL;
-- E5 Scope 언급에 더하기(is_new 거짓). 대상 = 그 엔티티의 첫 Scope 언급 행(ord 최소).
DROP TABLE IF EXISTS _ecat_hinc;
CREATE TEMP TABLE _ecat_hinc AS
SELECT x.answer_key, x.entity_id, m.ord, x.n
  FROM (SELECT answer_key, entity_id, sum(n)::int AS n FROM _ecat_hr WHERE NOT is_new GROUP BY 1, 2) x
  JOIN _ecat_in i ON i.answer_key = x.answer_key
  CROSS JOIN LATERAL (SELECT m.ord FROM ing.mention m WHERE m.run_month = i.run_month AND m.job_id = i.job_id AND m.entity_id = x.entity_id
                       ORDER BY m.ord LIMIT 1) m;
--    차단 보정이 있는 행이면 그 위에 더한다(빠진 행은 E6 이 새 언급으로 돌린다), 없는 행이면 원본 값 + 개수로 새 보정 행.
UPDATE _ecat_madj j SET cnt = j.cnt + h.n, t_mention = j.t_mention + h.n, hub_added = true
  FROM _ecat_hinc h WHERE h.answer_key = j.answer_key AND h.ord = j.ord AND NOT j.dropm;
INSERT INTO _ecat_madj (answer_key, ord, dropm, cnt, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison,
                        t_definition, t_final_choice, hub_added)
SELECT h.answer_key, m.ord, false, m.mention_count + h.n, m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed,
       m.type_mention + h.n, m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice, true
  FROM _ecat_hinc h JOIN _ecat_in i ON i.answer_key = h.answer_key
  JOIN ing.mention m ON m.run_month = i.run_month AND m.job_id = i.job_id AND m.ord = h.ord
 WHERE NOT EXISTS (SELECT 1 FROM _ecat_madj j WHERE j.answer_key = h.answer_key AND j.ord = h.ord);
-- E6 새 언급: 재매칭 새 엔티티 ∪ 더할 대상 Scope 언급이 차단으로 빠진 엔티티(위치 NULL)
DROP TABLE IF EXISTS _ecat_hnew;
CREATE TEMP TABLE _ecat_hnew AS
SELECT x.answer_key, x.entity_id, h.disp, h.rollup, h.ovr, x.n AS cnt, x.avg_position
  FROM (SELECT r.answer_key, r.entity_id, sum(r.n)::int AS n, min(r.avg_position) AS avg_position FROM _ecat_hr r WHERE r.is_new GROUP BY 1, 2
        UNION ALL
        SELECT h.answer_key, h.entity_id, h.n, NULL::real FROM _ecat_hinc h
          JOIN _ecat_madj j ON j.answer_key = h.answer_key AND j.ord = h.ord AND j.dropm) x
  JOIN _ecat_in i ON i.answer_key = x.answer_key
  JOIN _ecat_hent h ON h.ver = i.ecat_ver AND h.entity_id = x.entity_id;
CREATE UNIQUE INDEX ON _ecat_hnew (answer_key, entity_id);
ANALYZE _ecat_madj, _ecat_hnew;
