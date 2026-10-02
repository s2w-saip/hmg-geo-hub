-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.32 · 동결 카드 읽기 뷰 계획 안정화(be/int3-frzperf 2026-10-02)
-- 적용 순서: DB-v2.31 뒤 1회(트랜잭션 1개). 합본 DB-v2.32.sql = DB-v2.31.sql + 이 파일(바이트 연결). 가번호 DB-vNEXT-frz-perf
--   PF1~PF3 → P153~P155(be/int4 통합). 뷰 본문 교체(CREATE OR REPLACE VIEW)뿐: 열 이름·형·순서·소유자·권한 그대로, 표·색인·데이터 변경 없음.
-- 근거: stg hmg_r2(백엔드 56dc4161, 활성 세대 924) 동결 카드 경로 cache-miss 서버 ms citations/domains 약 2.0~2.1초 = 실시간 경로의 3~9배.
--   EXPLAIN (ANALYZE, BUFFERS)(notes/hgh-impl/wu12/be-int3-frzperf/cap-*.txt): 카드 뷰의 셀 → 세대(active) → 프롬프트(in_full_cycle) →
--   rd 좌석 4열 조인 → bgrp CASE 술어의 선택도가 곱해져 행 추정이 무너진다(글로벌 9/28 인용 4 대 959,176, 웹 9/25 6 대 341,030).
--   그 결과 (1) 보관 반조인(NOT EXISTS frz.kept)과 세대 조인이 셀이 아니라 rd 행마다 붙는다(글로벌 보관 탐침 959,176회, 웹 세대 탐침 341,030회
--   + 보관 Materialize 비교 409만 회), (2) 웹은 직렬 계획, (3) 정렬 집계. 통계는 신선하다(frz.cell·prompt 자동 분석 10-02, 세대 924 전부 active).
-- 바꾸는 것(값 동치: 같은 입력에서 전후 행 다중집합 동일, stg 읽기 전용 해시 대조 카드 8경로 frz 문장 17개 SAME·응답 10경로 해시 동일, 로컬 시험 tests/core/test_frz_perf_views.py):
--   ① 세대 조인 → 셀 스캔 필터 `(c.gen_key = ANY (SELECT … state = 'active')) IS TRUE`. IS TRUE 는 반조인 끌어올림을 막아 해시 부분계획
--      (세대 924행)으로 셀 스캔에 붙인다(반조인으로 두면 계획기가 세대부터 셀 PK 를 훑는 계획을 골라 버퍼 715만, stg 실측). 세대 열은 뷰가 내지
--      않으므로 조인과 같다(gen_key 는 PK, frz.cell.gen_key FK·NOT NULL 이라 ANY 가 NULL 이 되지 않는다 = IS TRUE 와 WHERE 참이 같다).
--   ② 보관 반조인 → `(c.gen_key, c.answer_key) NOT IN (SELECT gen_key, answer_key FROM frz.kept)` 해시 부분계획(셀 스캔 필터). 두 열 모두
--      NOT NULL(frz.cell PK·frz.kept PK)이라 NOT EXISTS 와 같다. 해시 가능 한도 = hash_mem(work_mem 64MB × 2) ≈ 보관 300만 행: 넘으면 계획기가
--      해시를 버리고 행마다 보관을 훑는다(지금 12행, 상한 = 활성 셀 수 47만). 보관이 100만 행을 넘기 전에 이 술어를 다시 본다.
--   ③ 카드(글로벌) 뷰 rd 갈래를 표면으로 둘로 나눈다: surface = 1 갈래는 bgrp = q.cat_mask(동결 카탈로그 비트), 그 밖은 x.bgrp. 원래
--      CASE WHEN c.surface = 1 THEN q.cat_mask ELSE x.bgrp END 와 같은 값(surface NOT NULL). 읽기 술어 bgrp = ANY(…) 가 프롬프트 축 열에
--      바로 걸려 통계로 추정된다(CASE 식은 기본 선택도). 보관 갈래는 작아서 CASE 그대로.
--   ④ 웹 카드 뷰(card_*_w) rd 갈래의 좌석 열(surface·round_date·cyc_key·answer_key)을 rd 행 값으로 낸다. 조인 조건이 네 열 등치라 셀 값과
--      같다. 읽기 술어(cyc_key = ANY·round_date)가 rd 파티션 범위로 바로 내려간다(웹 문장 버퍼 17.4만 → 8.1만).
--   격자 뷰(frz.grid_*)는 이 패치에서 바꾸지 않는다(추이 정합 작업 be/int3-frztrend 범위. 같은 변형이 그대로 적용된다).
-- 효과(stg 읽기 전용, 뷰 본문을 부분 질의로 인라인한 같은 문장, 3회 실행 ms): citations/domains 주 문장 글로벌 1,787 → 774, 웹 1,950 → 358
--   (+ 앱 쪽 접기 g0 재사용 analytics.citations.domains), kpi/compare 글로벌 735 → 485·웹 367 → 271, mentions/brands 글로벌 브랜드 문장 330 → 160.
-- P153 카드 뷰 frz.card_answer·card_answer_brand·card_citation 본문 교체.
-- P154 웹 카드 뷰 frz.card_answer_w·card_answer_brand_w·card_citation_w 본문 교체.
-- P155 사후 단언(frz.assert_shape = 뷰 열 = rd 열, 소유자 hmg_owner, api_ro SELECT 권한, 표식).
-- 락: 뷰 정의 교체에 그 뷰의 ACCESS EXCLUSIVE 를 잠깐(읽기 요청이 뷰를 읽는 중이면 대기). lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치 ② 결과 캐시 무효화(값은 같지만 관례대로) ③ 카드 경로 지연 측정.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('frz.card_answer_w') IS NULL OR NOT has_table_privilege('loader', 'app.ecat_audit_log', 'insert') THEN
    RAISE EXCEPTION 'DB-v2.31(loader app.ecat_audit_log INSERT, DB-v2.24 frz.card_answer_w 포함) 이 먼저 적용돼야 한다';
  END IF;
  IF position('DB-v2.32' in coalesce(obj_description('frz.card_citation'::regclass, 'pg_class'), '')) > 0 THEN
    RAISE EXCEPTION 'DB-v2.32 이미 적용됨(frz.card_citation 주석 표식)';
  END IF;
END $v$;

-- ── P153 ─────────────────────────────────────────────────────────────────────
-- 카드 뷰: 셀 필터(활성 세대·보관 없음)는 셀 스캔에 붙는 해시 부분계획, rd 갈래는 표면별 두 갈래(bgrp 원천이 다르다), 보관 갈래는 그대로(작다).
DO $v$
DECLARE t text; rd1 text; rd2 text; kp text; act text; nk text; rd_from text;
BEGIN
  act := '(c.gen_key = ANY (SELECT g.gen_key FROM frz.generation g WHERE g.state = ''active'')) IS TRUE';
  nk := '(c.gen_key, c.answer_key) NOT IN (SELECT p.gen_key, p.answer_key FROM frz.kept p)';
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'bgrp' THEN 'q.cat_mask AS bgrp'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'answer_key' THEN 'c.answer_key'
                                     ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
           string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'answer_key' THEN 'c.answer_key'
                                     ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
           string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'answer_key' THEN 'c.answer_key'
                                     WHEN 'bgrp' THEN 'CASE WHEN c.surface = 1 THEN q.cat_mask ELSE k.bgrp END AS bgrp'
                                     ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
      INTO rd1, rd2, kp
      FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    rd_from := format('FROM frz.cell c JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle '
                      'JOIN rd.%1$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key ', t);
    EXECUTE format(
      'CREATE OR REPLACE VIEW frz.%1$I AS '
      'SELECT %2$s %4$s WHERE c.surface = 1 AND %6$s AND %7$s '
      'UNION ALL '
      'SELECT %3$s %4$s WHERE c.surface <> 1 AND %6$s AND %7$s '
      'UNION ALL '
      'SELECT %5$s FROM frz.cell c JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle '
      'JOIN frz.%8$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key WHERE %6$s',
      'card_' || t, rd1, rd2, rd_from, kp, act, nk, 'keep_' || t);
    EXECUTE format('COMMENT ON VIEW frz.%I IS %L', 'card_' || t,
                   format('카드 경로 읽기(rd.%s 와 같은 열): 동결 회차(활성 세대)만 = 셀 대표 rd 행(그 세대 보관 없음) ∪ 보관 행, in_full_cycle 셀만(is_rep 참, '
                          '좌석 = 셀, 글로벌 bgrp = 동결 카탈로그 비트). 세대·보관 판정은 셀 스캔 해시 필터, rd 갈래는 표면별. 세대 없는 회차가 창에 있으면 '
                          '요청 전체가 비카드(core.cycles.frz_judge). DB-v2.23 P124 · DB-v2.24 P126 · DB-v2.32 P153', t));
  END LOOP;
END $v$;

-- ── P154 ─────────────────────────────────────────────────────────────────────
-- 웹 카드 뷰: 셀 필터는 P153 과 같은 해시 부분계획(세대는 웹 세대만, 원래 조인 조건 g.surface = 2 그대로). rd 갈래 좌석 열 = rd 행 값(조인 등치라
-- 셀 값과 같다). 웹 셀 판정 열·보관 갈래는 DB-v2.24 P127 그대로.
DO $v$
DECLARE t text; rd_cols text; kp_cols text; wcols text; act text; nk text;
BEGIN
  wcols := '(w.report_fs IS NOT NULL AND w.report_fs <> ALL (ARRAY(SELECT e.file_seq FROM app.website_report_excluded e))) AS unit_in, '
           'coalesce(w.unit_owned, false) AS unit_owned, coalesce(w.unit_target, false) AS unit_target, '
           'w.url_registered, w.url_owned_hit, w.url_target_hit';
  act := '(c.gen_key = ANY (SELECT g.gen_key FROM frz.generation g WHERE g.state = ''active'' AND g.surface = 2)) IS TRUE';
  nk := '(c.gen_key, c.answer_key) NOT IN (SELECT p.gen_key, p.answer_key FROM frz.kept p)';
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
           string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'answer_key' THEN 'c.answer_key'
                                     ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
      INTO rd_cols, kp_cols
      FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    EXECUTE format(
      'CREATE OR REPLACE VIEW frz.%1$I AS '
      'SELECT %2$s, %5$s FROM frz.cell c '
      'JOIN rd.%4$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key '
      'LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key '
      'WHERE c.surface = 2 AND %7$s AND %8$s '
      'UNION ALL '
      'SELECT %3$s, %5$s FROM frz.cell c JOIN frz.%6$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key '
      'LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key '
      'WHERE c.surface = 2 AND %7$s',
      'card_' || t || '_w', rd_cols, kp_cols, t, wcols, 'keep_' || t, act, nk);
    EXECUTE format('COMMENT ON VIEW frz.%I IS %L', 'card_' || t || '_w',
                   format('웹 카드 읽기(rd.%s 열 + 웹 셀 판정 unit_in·unit_owned·unit_target·url_registered·url_owned_hit·url_target_hit): 동결 웹 회차 = '
                          '셀 대표 rd 행(그 세대 보관 없음, 좌석 열 = rd 행 = 셀) ∪ 그 세대 보관 행(is_rep 참, 좌석 = 셀). 세대·보관 판정은 셀 스캔 해시 필터. '
                          '웹 in_full_cycle 은 참뿐이라 프롬프트 축을 조인하지 않는다. DB-v2.24 P127 · DB-v2.32 P154', t));
  END LOOP;
END $v$;

-- ── P155 ─────────────────────────────────────────────────────────────────────
DO $v$
DECLARE v text;
BEGIN
  PERFORM frz.assert_shape();
  FOREACH v IN ARRAY '{card_answer,card_answer_brand,card_citation,card_answer_w,card_answer_brand_w,card_citation_w}'::text[] LOOP
    IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = format('frz.%I', v)::regclass)) <> 'hmg_owner'
       OR NOT has_table_privilege('api_ro', format('frz.%I', v), 'select')
       OR position('DB-v2.32' in coalesce(obj_description(format('frz.%I', v)::regclass, 'pg_class'), '')) = 0 THEN
      RAISE EXCEPTION 'P155 실패: frz.% 소유자·권한·표식', v;
    END IF;
  END LOOP;
END $v$;

COMMIT;
