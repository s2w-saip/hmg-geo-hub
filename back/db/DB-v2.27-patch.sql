-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.27 · 동결 층 answer_brand 운영 summary 접기(현행 프로필 brand_card_fold, be/int3-smartfold 2026-10-02)
-- 적용 순서: DB-v2.26 뒤 1회(트랜잭션 1개). 합본 DB-v2.27.sql = DB-v2.26.sql + 이 파일(바이트 연결). 새 함수 1개 + frz.kept 출처 CHECK 교체.
-- 근거: stg 동결 이관 드라이런(22280d7f, 924 회차) 글로벌 3 회차 실패(r2/frz-fail3-b4c-20261002). 운영 미러 읽기 전용 실측(2026-10-02):
--   활성 세대 924 회차 중 summary_trend_own.comp_mentions ≠ summary_trend_answers.all_mentions 인 회차 = 정확히 그 3 회차(차 6·1·3), 나머지 921 = 0.
--
-- 운영 규칙(hmg-geo 2670a16): 세부층 summary_brand_mentions 는 언급을 (job, 롤업 id, 표시명)으로 접는다(lib/summary/generate/load.ts:78-98).
--   is_competitor = 그룹 bool_or(pass)(:89, pass = 언급 행마다 bare-only 되살리기를 자기 표기로 판정 context.ts:143-144),
--   mentions = 그룹 전 언급 합(:90), first_rank = 그룹 전 언급 min(avg_position)(:91, 비경쟁 언급 포함).
--   경쟁 순위 = is_competitor = 1 ∧ first_rank 있는 행을 표시명으로 묶어 min(first_rank) 의 rank()(fold.ts:319-323·492-509).
--   카드 점유율 분모 = is_competitor = 1 행 언급 합(summary-global-aggregates.ts:524-530, trend_own.comp_mentions fold.ts:752-765).
-- 허브 rd.answer_brand 는 언급 행 단위 경쟁 판정으로 행을 나눈다 = 운영 미러 화면 규칙(scope-aggregates.ts:3338-3349)이라 rd 는 그대로 둔다.
--   같은 답변·같은 표시 브랜드에 경쟁·비경쟁 행이 공존하고(같은 롤업 id 그룹이 섞임) 접기 결과가 rd 와 다른 답변만, 동결 세대에 보관 출처
--   'fold' 로 접힌 행을 보관한다(결정 32: 사실 표 사본 없음, 바뀐 답변만 보관). 접기 계산은 적재기 투영 원천(ingest.frz.fold: stage 의 _ig_mr,
--   이름·경쟁·롤업 규칙 한 벌)이 하고, 이 함수는 받은 행을 rd 와 맞춰 본 뒤 보관한다(rd 를 쓰는 롤에 frz 쓰기 권한을 주지 않는다, P117 과 같은 자세).
--
-- P141 frz.kept.src CHECK 에 'fold' 추가(접기 보관). 표는 (세대, 답변)당 1행이라 작다(stg 활성 세대 0, 운영 이관 예상 보관 수백 행).
-- P142 frz.keep_fold(세대, 행 jsonb) → 보관한 답변 수. 입력 = 접힌 answer_brand 측정값 행(answer_key·brand_key·competitive·own_bit·entity_rows·
--      rid_n·mention_count·rk·s_*·t_*). 단언(위반이면 예외): 세대가 building·active, 답변이 그 세대 셀, 보관 없음 또는 seat 보관(rd 를 옮긴 좌석
--      보관은 접힌 행으로 바꾼다), 답변마다 브랜드 키 집합과 (답변, 브랜드 키)별 언급·엔티티 행·감성·유형 합이 지금 rd 행(rd.job 위치)과 같다
--      (접기는 행을 다시 나눌 뿐 합을 바꾸지 않는다). 보관 = keep_answer(rd 행, 당사 요약 열은 접힌 행에서 적재기 _ig_own 과 같은 식으로),
--      keep_answer_brand(접힌 행 + 그 답변 rd 행의 차원 열), keep_citation(rd 행 그대로). 끝에 frz.assert_generation 과 row_counts.kept_fold.
-- P143 소유자·권한(hmg_owner, SECURITY DEFINER, loader·migrator 실행) · 사후 단언.
-- 락: frz.kept 의 CHECK 교체에 ACCESS EXCLUSIVE 를 잠깐(작은 표, 검증 스캔 포함). lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치 ② 프로필에 brand_card_fold(freeze_at_publish·display_name_latin 필수) ③ 동결 세대 이관·재생성.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('ing.entity_brand_name') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.26(ing.entity_brand_name) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('frz.keep_fold(int4, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.27 동결 층 접기 보관 이미 적용됨(frz.keep_fold 존재)';
  END IF;
END $v$;

-- ── P141 ──────────────────────────────────────────────────────────────────────
ALTER TABLE frz.kept DROP CONSTRAINT kept_src_check;
ALTER TABLE frz.kept ADD CONSTRAINT kept_src_check CHECK (src IN ('apply', 'bulk', 'ops', 'seat', 'fold'));
COMMENT ON COLUMN frz.kept.src IS
  '보관 출처: apply·bulk = 관문(다시 쓰기 직전 값), ops = 이관(운영 세부층 변환), seat = 좌석 이동, fold = 운영 summary 접기(DB-v2.27 P141~P142)';

-- ── P142 ──────────────────────────────────────────────────────────────────────
CREATE FUNCTION frz.keep_fold(p_gen int4, p_rows jsonb) RETURNS int
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
  RETURN cardinality(ks);
END $f$;
COMMENT ON FUNCTION frz.keep_fold(int4, jsonb) IS
  '동결 세대에 운영 summary 접기 행 보관(src fold): 셀 답변의 접힌 answer_brand 행(ingest.frz.fold 계산)을 rd 합과 대조한 뒤 keep_answer(당사 요약 '
  '열 재계산)·keep_answer_brand·keep_citation 에 넣는다. seat 보관은 대체, 그 밖 출처 보관은 거부. 반환 = 보관 답변 수. DB-v2.27 P142';

-- ── P143 ──────────────────────────────────────────────────────────────────────
ALTER FUNCTION frz.keep_fold(int4, jsonb) OWNER TO hmg_owner;
REVOKE ALL ON FUNCTION frz.keep_fold(int4, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION frz.keep_fold(int4, jsonb) TO loader, migrator;

DO $v$ BEGIN
  IF NOT has_function_privilege('loader', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR NOT has_function_privilege('migrator', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR has_function_privilege('api_ro', 'frz.keep_fold(int4, jsonb)', 'execute')
     OR has_table_privilege('loader', 'frz.kept', 'insert')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'frz.keep_fold(int4, jsonb)'::regprocedure)
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'frz.keep_fold(int4, jsonb)'::regprocedure)) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P142~P143 실패: 소유자·권한';
  END IF;
  IF position('''fold''' in coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                       WHERE conrelid = 'frz.kept'::regclass AND conname = 'kept_src_check'), '')) = 0 THEN
    RAISE EXCEPTION 'P141 실패: frz.kept 출처 CHECK';
  END IF;
  PERFORM frz.assert_shape();
END $v$;

COMMIT;
