-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.28 · frz.keep_fold 입력 불변식 강화(현행 프로필 brand_card_fold, be/int3-smartfold 검증 결함 D1, 2026-10-02)
-- 적용 순서: DB-v2.27 뒤 1회(트랜잭션 1개). 합본 DB-v2.28.sql = DB-v2.27.sql + 이 파일(바이트 연결). 함수 본문 교체(CREATE OR REPLACE)만:
--   소유자(hmg_owner)·SECURITY DEFINER·실행 권한(loader·migrator)은 그대로 유지되고 사후 단언이 확인한다. 표·열 변경 없음.
-- 근거: 56dc4161 독립 검증(notes/hgh-impl/wu12/v-smartfold oracle_probe.py abuse). DB-v2.27 은 (답변, 브랜드 키)별 합만 rd 와 대조해
--   loader 롤이 rd 와 모순되는 행을 보관시킬 수 있었다: 공존 아닌 답변의 경쟁 행을 비경쟁으로 뒤집기, 경쟁사 own_bit 오염, 순위 전부 7,
--   롤업 수 > 엔티티 행(frz.keep_answer_brand 는 LIKE 라 rd 의 CHECK 가 없다).
--
-- P144 frz.keep_fold 불변식(rd 에서 파생, 하나라도 어기면 예외 = 쓰기 전 거부, 부분 쓰기 없음):
--   I1 대상 답변 = rd 기준 공존 답변(같은 답변·같은 표시 브랜드 키에 경쟁·비경쟁 rd 행)
--   I2 행 범위: 측정값 ≥ 0, 엔티티 행 ≥ 1, 1 ≤ 롤업 수 ≤ 엔티티 행, 순위 ≥ 0, 키 0 순위 0 (DB-v2.27: 비경쟁 순위 0·빈 값·중복)
--   I3 own_bit = rd 의 (답변, 키) max(own_bit)                                 (DB-v2.27: 키 집합·(답변, 키)별 언급·엔티티 행·감성·유형 합 = rd)
--   I4 공존 아닌 키는 rd 행과 같다(순위는 0 여부만 같고 값은 접힌 키 때문에 밀릴 수 있다)
--   I5 공존 키는 비경쟁 → 경쟁 방향으로만 옮긴다: 경쟁 행 존재, 경쟁 언급·엔티티 행 ≥ rd, 비경쟁 ≤ rd, max(rd 롤업 수) ≤ Σ 롤업 수 ≤ Σ rd 롤업 수,
--      rd 경쟁 행이 순위면 접힌 경쟁 행도 순위
--   I6 순위 = rank() 구조(1 부터, 동률 같은 값, 다음 건너뜀), I7 공존 아닌 키 쌍의 순서·동률 = rd, 공존 키는 공존 아닌 키보다 뒤로 가지 않는다
--   접은 결과에서만 달라질 수 있는 열 = competitive·공존 키의 언급·엔티티 행·롤업 수 배분·순위 값. 나머지는 rd 와 같아야 한다.
-- 락: 함수 교체(카탈로그)만. lock_timeout 30s.
-- 적용 절차(stg·prod): 이 패치 1회(DB-v2.27 뒤). 이미 만든 fold 보관은 그대로 유효하다(규칙 불변, 입력 검증만 강화).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regprocedure('frz.keep_fold(int4, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.27(frz.keep_fold) 가 먼저 적용돼야 한다';
  END IF;
  IF position('I7 순위 순서' in pg_get_functiondef('frz.keep_fold(int4, jsonb)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'DB-v2.28 keep_fold 불변식 이미 적용됨';
  END IF;
END $v$;

-- ── P144 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION frz.keep_fold(p_gen int4, p_rows jsonb) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE ks int4[]; n_bad int; st text;
BEGIN
  SELECT state INTO st FROM frz.generation WHERE gen_key = p_gen;
  IF st IS NULL OR st NOT IN ('building', 'active') THEN
    RAISE EXCEPTION 'frz.keep_fold: 세대 % 이(가) building·active 가 아니다', p_gen;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;
  DROP TABLE IF EXISTS _frz_fold_in;
  CREATE TEMP TABLE _frz_fold_in ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(p_rows) AS r(answer_key int4, brand_key int4, competitive bool, own_bit int2, entity_rows int2, rid_n int2,
                                                 mention_count int2, rk int2, s_pos int2, s_neu int2, s_neg int2, s_mix int2, t_mention int2,
                                                 t_recommendation int2, t_comparison int2, t_definition int2, t_final_choice int2);
  IF EXISTS (SELECT 1 FROM _frz_fold_in WHERE answer_key IS NULL OR brand_key IS NULL OR competitive IS NULL OR own_bit IS NULL
                OR entity_rows IS NULL OR rid_n IS NULL OR mention_count IS NULL OR rk IS NULL OR s_pos IS NULL OR s_neu IS NULL OR s_neg IS NULL
                OR s_mix IS NULL OR t_mention IS NULL OR t_recommendation IS NULL OR t_comparison IS NULL OR t_definition IS NULL
                OR t_final_choice IS NULL OR (NOT competitive AND rk <> 0)) THEN
    RAISE EXCEPTION 'frz.keep_fold: 입력 행에 빈 값 또는 비경쟁 행 순위가 있다';
  END IF;
  IF EXISTS (SELECT 1 FROM _frz_fold_in GROUP BY answer_key, brand_key, competitive HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'frz.keep_fold: (답변, 브랜드 키, 경쟁) 중복 행';
  END IF;
  SELECT array_agg(DISTINCT answer_key ORDER BY answer_key) INTO ks FROM _frz_fold_in;
  -- 셀·보관 상태
  SELECT count(*) INTO n_bad FROM unnest(ks) k
   WHERE NOT EXISTS (SELECT 1 FROM frz.cell c WHERE c.gen_key = p_gen AND c.answer_key = k)
      OR EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = p_gen AND p.answer_key = k AND p.src <> 'seat')
      OR NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = k);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: 세대 % 의 셀이 아니거나 이미 seat 밖 출처로 보관된 답변 %개', p_gen, n_bad;
  END IF;
  -- 합 대조: 접기는 (답변, 브랜드 키) 안에서 행을 다시 나눌 뿐이다 → 브랜드 키 집합·언급·엔티티 행·감성·유형 합이 지금 rd 행과 같아야 한다
  WITH i AS (
    SELECT answer_key, brand_key, sum(mention_count) AS m, sum(entity_rows) AS e, sum(s_pos) AS sp, sum(s_neu) AS sn, sum(s_neg) AS sg,
           sum(s_mix) AS sx, sum(t_mention) AS t1, sum(t_recommendation) AS t2, sum(t_comparison) AS t3, sum(t_definition) AS t4,
           sum(t_final_choice) AS t5
      FROM _frz_fold_in GROUP BY 1, 2),
  r AS (
    SELECT b.answer_key, b.brand_key, sum(b.mention_count) AS m, sum(b.entity_rows) AS e, sum(b.s_pos) AS sp, sum(b.s_neu) AS sn,
           sum(b.s_neg) AS sg, sum(b.s_mix) AS sx, sum(b.t_mention) AS t1, sum(b.t_recommendation) AS t2, sum(b.t_comparison) AS t3,
           sum(b.t_definition) AS t4, sum(b.t_final_choice) AS t5
      FROM rd.job j JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
     WHERE j.answer_key = ANY (ks)
     GROUP BY 1, 2)
  SELECT count(*) INTO n_bad FROM ((SELECT * FROM i EXCEPT SELECT * FROM r) UNION ALL (SELECT * FROM r EXCEPT SELECT * FROM i)) d;
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: 접힌 행의 (답변, 브랜드 키) 합이 지금 rd 행과 다르다(% 행): rd 가 지금 규칙과 갈렸다(재투영 필요)', n_bad;
  END IF;
  -- ── DB-v2.28 P144 불변식(rd 에서 파생, 위반이면 예외 = 쓰기 전) ─────────────────────────────────────────────────────────────────────────
  -- rd 기준 행(rd.job 위치). 접기가 바꿀 수 있는 것: 공존 브랜드 키(rd 에 경쟁·비경쟁 행이 함께)의 경쟁 플래그별 언급·엔티티 행·롤업 수 배분, 순위.
  -- rd 와 같아야 하는 것: 브랜드 키 집합·(답변, 키)별 합(위), own_bit, 공존 아닌 키의 행 전체(순위의 값만 예외, 순서는 보존).
  DROP TABLE IF EXISTS _frz_fold_rd;
  CREATE TEMP TABLE _frz_fold_rd ON COMMIT DROP AS
  SELECT b.answer_key, b.brand_key, b.competitive, b.own_bit, b.entity_rows, b.rid_n, b.mention_count, b.rk, b.s_pos, b.s_neu, b.s_neg, b.s_mix,
         b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice,
         (b.brand_key <> 0 AND EXISTS (SELECT 1 FROM rd.answer_brand o WHERE o.surface = b.surface AND o.round_date = b.round_date
                                         AND o.answer_key = b.answer_key AND o.brand_key = b.brand_key AND o.competitive <> b.competitive)) AS coex
    FROM rd.job j JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
   WHERE j.answer_key = ANY (ks);
  -- I1 대상 = rd 기준 공존 답변(같은 답변·같은 표시 브랜드 키에 경쟁·비경쟁 rd 행)
  SELECT count(*) INTO n_bad FROM unnest(ks) k WHERE NOT EXISTS (SELECT 1 FROM _frz_fold_rd r WHERE r.answer_key = k AND r.coex);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I1 공존 답변이 아닌 답변 %개(접기는 공존 답변만 바꾼다)', n_bad;
  END IF;
  -- I2 행 단위 범위: 측정값 0 이상, 엔티티 행 1 이상, 1 ≤ 롤업 수 ≤ 엔티티 행, 순위 0 이상, 브랜드 키 0 은 순위 0
  IF EXISTS (SELECT 1 FROM _frz_fold_in WHERE entity_rows < 1 OR rid_n < 1 OR rid_n > entity_rows OR rk < 0 OR (brand_key = 0 AND rk <> 0)
                OR least(mention_count, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice) < 0) THEN
    RAISE EXCEPTION 'frz.keep_fold: I2 행 범위 위반(측정값 음수·엔티티 행 0·롤업 수 > 엔티티 행·순위 음수·키 0 순위)';
  END IF;
  -- I3 own_bit = rd 의 (답변, 키) max(own_bit)(표시 브랜드 키의 당사 비트는 차원 값이라 접기와 무관)
  SELECT count(*) INTO n_bad FROM _frz_fold_in i
   WHERE i.own_bit IS DISTINCT FROM (SELECT max(r.own_bit) FROM _frz_fold_rd r WHERE r.answer_key = i.answer_key AND r.brand_key = i.brand_key);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I3 own_bit 가 rd 와 다른 행 %개', n_bad;
  END IF;
  -- I4 공존 아닌 키: 접기 대상이 아니라 행이 rd 와 같아야 한다(순위 값만 다를 수 있고 0 여부는 같다)
  WITH d AS (SELECT DISTINCT answer_key, brand_key FROM _frz_fold_rd WHERE NOT coex),
  x AS ((SELECT i.answer_key, i.brand_key, i.competitive, i.own_bit, i.entity_rows, i.rid_n, i.mention_count, (i.rk > 0) AS ranked, i.s_pos, i.s_neu,
                i.s_neg, i.s_mix, i.t_mention, i.t_recommendation, i.t_comparison, i.t_definition, i.t_final_choice
           FROM _frz_fold_in i JOIN d USING (answer_key, brand_key)
         EXCEPT ALL
         SELECT r.answer_key, r.brand_key, r.competitive, r.own_bit, r.entity_rows, r.rid_n, r.mention_count, (r.rk > 0), r.s_pos, r.s_neu,
                r.s_neg, r.s_mix, r.t_mention, r.t_recommendation, r.t_comparison, r.t_definition, r.t_final_choice
           FROM _frz_fold_rd r JOIN d USING (answer_key, brand_key))
        UNION ALL
        (SELECT r.answer_key, r.brand_key, r.competitive, r.own_bit, r.entity_rows, r.rid_n, r.mention_count, (r.rk > 0), r.s_pos, r.s_neu,
                r.s_neg, r.s_mix, r.t_mention, r.t_recommendation, r.t_comparison, r.t_definition, r.t_final_choice
           FROM _frz_fold_rd r JOIN d USING (answer_key, brand_key)
         EXCEPT ALL
         SELECT i.answer_key, i.brand_key, i.competitive, i.own_bit, i.entity_rows, i.rid_n, i.mention_count, (i.rk > 0), i.s_pos, i.s_neu,
                i.s_neg, i.s_mix, i.t_mention, i.t_recommendation, i.t_comparison, i.t_definition, i.t_final_choice
           FROM _frz_fold_in i JOIN d USING (answer_key, brand_key)))
  SELECT count(*) INTO n_bad FROM x;
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I4 공존 아닌 브랜드 키의 행이 rd 와 다르다(% 행)', n_bad;
  END IF;
  -- I5 공존 키: 접기는 비경쟁 언급을 경쟁 그룹으로 옮기기만 한다(반대 없음) → 경쟁 행 있음, 경쟁 언급·엔티티 행 ≥ rd 경쟁, 비경쟁 ≤ rd 비경쟁,
  --    롤업 수 합은 max(rd 롤업 수) 이상 Σ rd 롤업 수 이하(같은 롤업이 두 행에 나뉘어 있던 것이 한 행으로 모인다), rd 경쟁 행이 순위면 접힌 경쟁 행도 순위
  WITH k AS (SELECT answer_key, brand_key,
                    sum(mention_count) FILTER (WHERE competitive) AS rc_m, sum(mention_count) FILTER (WHERE NOT competitive) AS rn_m,
                    sum(entity_rows) FILTER (WHERE competitive) AS rc_e, sum(entity_rows) FILTER (WHERE NOT competitive) AS rn_e,
                    max(rid_n) AS r_maxrid, sum(rid_n) AS r_sumrid, bool_or(competitive AND rk > 0) AS rc_ranked
               FROM _frz_fold_rd WHERE coex GROUP BY 1, 2),
  f AS (SELECT answer_key, brand_key, bool_or(competitive) AS has_c,
               coalesce(sum(mention_count) FILTER (WHERE competitive), 0) AS fc_m, coalesce(sum(mention_count) FILTER (WHERE NOT competitive), 0) AS fn_m,
               coalesce(sum(entity_rows) FILTER (WHERE competitive), 0) AS fc_e, coalesce(sum(entity_rows) FILTER (WHERE NOT competitive), 0) AS fn_e,
               sum(rid_n) AS f_sumrid, bool_or(competitive AND rk > 0) AS fc_ranked
          FROM _frz_fold_in GROUP BY 1, 2)
  SELECT count(*) INTO n_bad FROM k JOIN f USING (answer_key, brand_key)
   WHERE NOT f.has_c OR f.fc_m < k.rc_m OR f.fn_m > k.rn_m OR f.fc_e < k.rc_e OR f.fn_e > k.rn_e
      OR f.f_sumrid < k.r_maxrid OR f.f_sumrid > k.r_sumrid OR (k.rc_ranked AND NOT f.fc_ranked);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I5 공존 브랜드 키 접기 방향 위반 % 키(경쟁 → 비경쟁 이동·롤업 수·순위 소실)', n_bad;
  END IF;
  -- I6 순위 = rank() 구조(답변 안 경쟁 순위 행: rk = 1 + 더 작은 rk 를 가진 행 수, 동률 같은 값·다음 건너뜀)
  SELECT count(*) INTO n_bad FROM _frz_fold_in i
   WHERE i.competitive AND i.rk > 0
     AND i.rk <> 1 + (SELECT count(*) FROM _frz_fold_in o WHERE o.answer_key = i.answer_key AND o.competitive AND o.rk > 0 AND o.rk < i.rk);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I6 순위가 rank() 구조가 아닌 행 %개', n_bad;
  END IF;
  -- I7 순서 보존: 공존 아닌 두 키의 순서·동률은 rd 와 같고(위치 tp 불변), 공존 키는 공존 아닌 키보다 뒤로 가지 않는다(tp 는 내려가기만 한다)
  WITH ri AS (SELECT answer_key, brand_key, rk, coex FROM _frz_fold_rd WHERE competitive AND rk > 0),
  fi AS (SELECT answer_key, brand_key, rk FROM _frz_fold_in WHERE competitive AND rk > 0),
  p AS (SELECT a.answer_key, a.coex AS ac, b.coex AS bc, a.rk AS ra, b.rk AS rb, fa.rk AS fa, fb.rk AS fb
          FROM ri a JOIN ri b ON b.answer_key = a.answer_key AND b.brand_key <> a.brand_key
          JOIN fi fa ON fa.answer_key = a.answer_key AND fa.brand_key = a.brand_key
          JOIN fi fb ON fb.answer_key = b.answer_key AND fb.brand_key = b.brand_key)
  SELECT count(*) INTO n_bad FROM p
   WHERE (NOT ac AND NOT bc AND sign(fa - fb) <> sign(ra - rb))
      OR (ac AND NOT bc AND ((ra <= rb AND fa > fb) OR (ra < rb AND fa >= fb)));
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'frz.keep_fold: I7 순위 순서가 rd 와 모순되는 쌍 %개', n_bad;
  END IF;
  -- seat 보관은 접힌 행으로 바꾼다(위치 = rd.job, 뷰 좌석은 셀 값)
  DELETE FROM frz.keep_answer WHERE gen_key = p_gen AND answer_key = ANY (ks);
  DELETE FROM frz.keep_answer_brand WHERE gen_key = p_gen AND answer_key = ANY (ks);
  DELETE FROM frz.keep_citation WHERE gen_key = p_gen AND answer_key = ANY (ks);
  UPDATE frz.kept SET src = 'fold', kept_at = now(), txid = pg_current_xact_id() WHERE gen_key = p_gen AND answer_key = ANY (ks) AND src = 'seat';
  INSERT INTO frz.kept (gen_key, answer_key, src) SELECT p_gen, k, 'fold' FROM unnest(ks) k ON CONFLICT (gen_key, answer_key) DO NOTHING;
  -- 답변 행: 당사 요약 열 = 접힌 행에서(적재기 ingest.project.apply queries._ig_own·seed-40 §5 _own 과 같은 식)
  WITH o AS (
    SELECT answer_key,
           coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0)::int2 AS own_mask,
           coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0)::int2 AS own_rk_h,
           coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0)::int2 AS own_rk_k,
           coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0)::int2 AS own_rk_g,
           coalesce(sum(mention_count) FILTER (WHERE competitive), 0)::int2 AS ment_total,
           coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0)::int2 AS ment_h,
           coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0)::int2 AS ment_k,
           coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0)::int2 AS ment_g,
           coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_pos_h,
           coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_pos_k,
           coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_pos_g,
           coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_neg_h,
           coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_neg_k,
           coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_neg_g,
           coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_all_h,
           coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_all_k,
           coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_all_g,
           coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0)::int2 AS t_own
      FROM _frz_fold_in GROUP BY answer_key)
  INSERT INTO frz.keep_answer
  SELECT (jsonb_populate_record(NULL::frz.keep_answer, to_jsonb(a) || (to_jsonb(o) - 'answer_key') || jsonb_build_object('gen_key', p_gen))).*
    FROM o JOIN rd.job j ON j.answer_key = o.answer_key
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key;
  -- 브랜드 행: 그 답변 rd 행 하나의 차원 열(답변 단위로 같다) + 접힌 측정값
  INSERT INTO frz.keep_answer_brand
  SELECT (jsonb_populate_record(NULL::frz.keep_answer_brand, t.tmpl || (to_jsonb(i) - 'answer_key') || jsonb_build_object('gen_key', p_gen))).*
    FROM _frz_fold_in i
    JOIN LATERAL (SELECT to_jsonb(b) AS tmpl FROM rd.job j
                    JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
                   WHERE j.answer_key = i.answer_key ORDER BY b.brand_key, b.competitive LIMIT 1) t ON true;
  INSERT INTO frz.keep_citation
  SELECT x.*, p_gen FROM rd.job j JOIN rd.citation x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
   WHERE j.answer_key = ANY (ks);
  IF (SELECT count(*) FROM frz.keep_answer WHERE gen_key = p_gen AND answer_key = ANY (ks)) <> cardinality(ks) THEN
    RAISE EXCEPTION 'frz.keep_fold: 보관 답변 행 수가 답변 수와 다르다(rd.answer 없음)';
  END IF;
  PERFORM frz.assert_generation(p_gen);           -- 셀마다 답변 행 1개(보관 갈래) 다시 단언
  UPDATE frz.generation SET row_counts = coalesce(row_counts, '{}'::jsonb)
                                         || jsonb_build_object('kept_fold', (SELECT count(*) FROM frz.kept WHERE gen_key = p_gen AND src = 'fold'))
   WHERE gen_key = p_gen;
  DROP TABLE _frz_fold_in;
  DROP TABLE _frz_fold_rd;
  RETURN cardinality(ks);
END $f$;

COMMENT ON FUNCTION frz.keep_fold(int4, jsonb) IS
  '동결 세대에 운영 summary 접기 행 보관(src fold): 셀 답변의 접힌 answer_brand 행(ingest.frz.fold 계산)을 rd 와 대조(합·불변식 I1~I7)한 뒤 '
  'keep_answer(당사 요약 열 재계산)·keep_answer_brand·keep_citation 에 넣는다. seat 보관은 대체, 그 밖 출처 보관은 거부. 반환 = 보관 답변 수. '
  'DB-v2.27 P142 · DB-v2.28 P144';

DO $v$ BEGIN
  IF NOT has_function_privilege('loader', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR NOT has_function_privilege('migrator', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR has_function_privilege('api_ro', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'frz.keep_fold(int4, jsonb)'::regprocedure)
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'frz.keep_fold(int4, jsonb)'::regprocedure)) <> 'hmg_owner'
     OR position('I7 순위 순서' in pg_get_functiondef('frz.keep_fold(int4, jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'P144 실패: keep_fold 본문·소유자·권한';
  END IF;
END $v$;

COMMIT;
