-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.24 (PostgreSQL 17, 2026-10-01) · 카드 경로 동결 층 S4: 웹 경로·택소노미 축·브랜드 표시명·창 판정(제품 결정 25·31·32)
-- 번호: P126~P131. 적용 순서: DB-v2.23 뒤 1회(트랜잭션 1개). 합본 DB-v2.24.sql = DB-v2.23.sql + 이 파일(바이트 연결).
-- 근거: card-snapshot-design.md 12.11(S4). 현행 = hmg-geo 2670a16.
--
-- P126 카드·격자 뷰(frz.card_*·frz.grid_*)에서 비동결 회차 rd 갈래를 뺀다(CREATE OR REPLACE, 열 같음). frz.cell 좌석 열 확장 통계(계획 추정).
--      S4 부터 카드 요청은 창 판정(core.cycles.frz_judge)으로 창 회차가 전부 동결일 때만 이 뷰를 읽고, 세대 없는 회차(구멍)가 창에 있으면 요청 전체를
--      비카드(현행 미러 폴백 대응, lib/summary/read/cycle-set.ts:336-357·400-401)로 내린다. 그래서 뷰는 동결 갈래(셀 rd 행 ∪ 보관 행)만 둔다.
-- P127 frz.cell_web: 웹 셀의 생성 시점 판정 = 보고 유닛 소속(report_fs) · 유닛 자사 인용(unit_owned) · 유닛 flat 타겟 인용(unit_target)
--      · 자사·타겟 URL 인용률 job 플래그(url_registered·url_owned_hit·url_target_hit, 운영 summary_url_hits, 없으면 NULL = rd 열).
--      현행: surface-website.ts:805-835 summary_answers(report_fs·unit_owned·unit_target, ut = 같은 유닛 전 프롬프트 타겟 flat),
--      :883-895 summary_url_hits(0081), 리더 summary-website-aggregates.ts:1164-1180(⑥ = sum(unit_owned)·sum(unit_owned ∧ unit_target)),
--      :1240-1268(URL 인용률 프롬프트 기준). 읽기 = frz.card_web(활성 세대), 웹 카드 읽기 뷰 frz.card_answer_w·card_answer_brand_w·
--      card_citation_w(카드 뷰 열 + 판정 6열: 유닛 게이트·⑥·URL 률이 행 열이라 FILTER 마다 반조인하지 않는다).
-- P128 frz.prompt_axis: 회차 × 프롬프트 택소노미 축(현행 summary_prompt_dim 의미): funnel_catalog·list_type·depth1~3 = 카탈로그 행 중 최근 수정 행 값,
--      presence_set = 행별 해석 존재값 집합(surface-global.ts:119-135 루트 카탈로그 삭제 행 포함, surface-website.ts:906-918 전 프로젝트 삭제 행 제외).
--      읽기 술어 = 현행 trendWhere(summary-trend-aggregates.ts:741-753: funnel_catalog·list_type·depth1 등호, presence_set && 한쪽 선택만). 읽기 = frz.card_axis.
-- P129 frz.brand_name: 세대별 브랜드 표시명(현행 summary_brand_mentions.brand_name 생성 시점). 세대 셀 답변의 브랜드 키 + 당사 행. 읽기 = frz.card_brand_name.
-- P130 생성기: frz.bake_hub(gen) = 허브 세대의 P127~P129 굽기(웹 = 허브 유닛 판정과 같은 식, 그때 rd 값), frz._bake_names(gen) 분리(이관기도 부른다).
--      frz.freeze_cycle 을 다시 만든다(DB-v2.22 본문 + 활성화 직전 bake_hub, row_counts 에 s4 카운트).
-- P131 권한 · 사후 단언. 이미 활성인 이관(ops) 세대가 있으면 실패한다(웹 플래그는 추출 입력이 있어야 굽는다 → 이관기 --force 재실행 순서).
-- 락: 새 표·뷰·함수, 기존 뷰 CREATE OR REPLACE(frz 뷰, 읽는 쪽 짧은 ACCESS EXCLUSIVE). rd·ing 표 ALTER 없음.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('frz.card_answer') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.23(frz.card_answer) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('frz.cell_web') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.24 이미 적용됨(frz.cell_web 존재)';
  END IF;
  IF EXISTS (SELECT 1 FROM frz.generation WHERE state = 'active' AND source = 'ops') THEN
    RAISE EXCEPTION 'DB-v2.24: 활성 이관(ops) 세대가 있다. 패치 뒤 frz-import-ops --force 로 다시 이관해야 웹 플래그·축이 생긴다(먼저 패치, 그다음 이관)';
  END IF;
END $v$;

-- ── P126 ─────────────────────────────────────────────────────────────────────
DO $v$
DECLARE t text; kind text; rd_cols text; kp_cols text; gate text;
BEGIN
  FOREACH kind IN ARRAY '{card,grid}'::text[] LOOP
    gate := CASE kind WHEN 'card' THEN ' AND q.in_full_cycle' ELSE '' END;
    FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
      SELECT string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep'
                                       WHEN 'bgrp' THEN 'CASE WHEN c.surface = 1 THEN q.cat_mask ELSE x.bgrp END AS bgrp'
                                       WHEN 'surface' THEN 'c.surface' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                       WHEN 'answer_key' THEN 'c.answer_key'
                                       ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
             string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                       WHEN 'surface' THEN 'c.surface' WHEN 'answer_key' THEN 'c.answer_key'
                                       WHEN 'bgrp' THEN 'CASE WHEN c.surface = 1 THEN q.cat_mask ELSE k.bgrp END AS bgrp'
                                       ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
        INTO rd_cols, kp_cols
        FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
      EXECUTE format(
        'CREATE OR REPLACE VIEW frz.%1$I AS '
        'SELECT %2$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
        'JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key%5$s '
        'JOIN rd.%4$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key '
        'WHERE NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) '
        'UNION ALL '
        'SELECT %3$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
        'JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key%5$s '
        'JOIN frz.%6$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key',
        kind || '_' || t, rd_cols, kp_cols, t, gate, 'keep_' || t);
      EXECUTE format('COMMENT ON VIEW frz.%I IS %L', kind || '_' || t,
                     format('카드 경로 %s 읽기(rd.%s 와 같은 열): 동결 회차(활성 세대)만 = 셀 대표 rd 행(보관 없음) ∪ 보관 행%s(is_rep 참, 좌석 = 셀, '
                            '글로벌 bgrp = 동결 카탈로그 비트). 세대 없는 회차가 창에 있으면 요청 전체가 비카드(core.cycles.frz_judge). DB-v2.23 %s · DB-v2.24 P126',
                            CASE kind WHEN 'card' THEN '' ELSE '추이 격자 ' END, t,
                            CASE kind WHEN 'card' THEN ', in_full_cycle 셀만' ELSE '' END,
                            CASE kind WHEN 'card' THEN 'P124' ELSE 'P125' END));
    END LOOP;
  END LOOP;
END $v$;

-- 셀 좌석 열 확장 통계(지연): 카드 뷰가 셀 색인 (surface, cyc_key, round_date)로 회차 셀을 고를 때 세 열이 서로 종속인데 기본 추정은 곱이라
-- 글로벌 회차 셀(4.7만)을 4천으로 낮게 보고 직렬 중첩 루프를 고른다(로컬 운영 규모 합성 요약 카드 108ms → 이 통계 뒤 병렬 44ms). 새 통계 객체(표 ALTER 아님)
CREATE STATISTICS frz.cell_seat_stats (dependencies, mcv, ndistinct) ON surface, cyc_key, round_date FROM frz.cell;
ALTER STATISTICS frz.cell_seat_stats OWNER TO hmg_owner;
ANALYZE frz.cell;

-- ── P127 ─────────────────────────────────────────────────────────────────────
CREATE TABLE frz.cell_web (
  gen_key int4 NOT NULL,
  answer_key int4 NOT NULL,
  cyc_key int4 NOT NULL,
  report_fs int4,
  unit_owned boolean NOT NULL,
  unit_target boolean NOT NULL,
  url_registered boolean,
  url_owned_hit boolean,
  url_target_hit boolean,
  PRIMARY KEY (gen_key, answer_key),
  FOREIGN KEY (gen_key, answer_key) REFERENCES frz.cell (gen_key, answer_key) ON DELETE CASCADE);   -- frz.release 가 셀을 지우면 같이
CREATE INDEX cell_web_cyc_idx ON frz.cell_web (cyc_key, answer_key) INCLUDE (report_fs, unit_owned, unit_target);
COMMENT ON TABLE frz.cell_web IS
  '웹 셀(answer_key)의 생성 시점 판정: report_fs(보고 유닛 file_seq, NULL = 유닛 밖)·unit_owned(유닛 자사 인용)·unit_target(같은 유닛 전 프롬프트 '
  '타겟 URL 인용, flat)·url_*(자사·타겟 URL 인용률 job 플래그, 운영 summary_url_hits. NULL = 없음 → rd 열). 현행 summary_answers·summary_url_hits. DB-v2.24 P127';
CREATE VIEW frz.card_web AS
SELECT w.cyc_key, w.answer_key, w.report_fs, w.unit_owned, w.unit_target, w.url_registered, w.url_owned_hit, w.url_target_hit
  FROM frz.cell_web w JOIN frz.generation g ON g.gen_key = w.gen_key AND g.state = 'active';
COMMENT ON VIEW frz.card_web IS '활성 동결 세대의 웹 셀 판정(frz.cell_web). DB-v2.24 P127';

-- 웹 카드 읽기 뷰(rd 열 + 웹 셀 판정 열 6개): 동결 읽기의 website 문장이 card_* 대신 읽는다(core.facts.CARD_WEB). 유닛 게이트·⑥·URL 인용률 플래그가
-- 행 열이라 FILTER 마다 반복되는 반조인(해시 서브플랜)이 없다. unit_in = 생성 시점 보고 유닛 소속 ∧ 제외 유닛 아님(제외는 현행도 조회 시점).
-- 웹은 프롬프트 축을 조인하지 않는다: 웹 in_full_cycle 은 참뿐(현행 surface-website.ts:9·404·925-938, S2 생성기·이관기가 지킨다: bake_hub·이관 단언)
-- 이고 bgrp 는 rd 값 그대로라 카드 뷰의 frz.prompt 조인이 웹 행에는 할 일이 없다(지연: 셀마다 색인 탐침 13만 회를 없앤다).
DO $v$
DECLARE t text; rd_cols text; kp_cols text; wcols text;
BEGIN
  wcols := '(w.report_fs IS NOT NULL AND w.report_fs <> ALL (ARRAY(SELECT e.file_seq FROM app.website_report_excluded e))) AS unit_in, '
           'coalesce(w.unit_owned, false) AS unit_owned, coalesce(w.unit_target, false) AS unit_target, '
           'w.url_registered, w.url_owned_hit, w.url_target_hit';
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'answer_key' THEN 'c.answer_key'
                                     ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
           string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                     WHEN 'surface' THEN 'c.surface' WHEN 'answer_key' THEN 'c.answer_key'
                                     ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
      INTO rd_cols, kp_cols
      FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    EXECUTE format(
      'CREATE VIEW frz.%1$I AS '
      'SELECT %2$s, %5$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' AND g.surface = 2 '
      'JOIN rd.%4$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key '
      'LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key '
      'WHERE c.surface = 2 AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) '
      'UNION ALL '
      'SELECT %3$s, %5$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' AND g.surface = 2 '
      'JOIN frz.%6$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key '
      'LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key '
      'WHERE c.surface = 2',
      'card_' || t || '_w', rd_cols, kp_cols, t, wcols, 'keep_' || t);
    EXECUTE format('COMMENT ON VIEW frz.%I IS %L', 'card_' || t || '_w',
                   format('웹 카드 읽기(rd.%s 열 + 웹 셀 판정 unit_in·unit_owned·unit_target·url_registered·url_owned_hit·url_target_hit): 동결 웹 회차 = '
                          '셀 대표 rd 행(그 세대 보관 없음) ∪ 그 세대 보관 행(is_rep 참, 좌석 = 셀). 웹 in_full_cycle 은 참뿐이라 프롬프트 축을 조인하지 않는다. '
                          'DB-v2.24 P127', t));
  END LOOP;
END $v$;

-- ── P128 ─────────────────────────────────────────────────────────────────────
CREATE TABLE frz.prompt_axis (
  gen_key int4 NOT NULL,
  prompt_key int4 NOT NULL,
  cyc_key int4 NOT NULL,
  funnel_key int2,
  presence_keys int2[] NOT NULL DEFAULT '{}',
  list_type_key int2,
  depth1_key int2,
  depth2_key int2,
  depth3_key int2,
  PRIMARY KEY (gen_key, prompt_key),
  FOREIGN KEY (gen_key, prompt_key) REFERENCES frz.prompt (gen_key, prompt_key) ON DELETE CASCADE);
CREATE INDEX prompt_axis_cyc_idx ON frz.prompt_axis (cyc_key, prompt_key);
COMMENT ON TABLE frz.prompt_axis IS
  '회차 × 프롬프트 택소노미 축(현행 summary_prompt_dim): funnel(funnel_catalog)·list_type·depth1~3 = 카탈로그 행 중 최근 수정 행 값의 rd.dim_taxon 키, '
  'presence_keys = 행별 해석 존재값(presence_set) 키 집합. 키 없는 코드는 NULL(필터와 맞지 않는다). DB-v2.24 P128';
CREATE VIEW frz.card_axis AS
SELECT x.cyc_key, x.prompt_key, x.funnel_key, x.presence_keys, x.list_type_key, x.depth1_key, x.depth2_key, x.depth3_key
  FROM frz.prompt_axis x JOIN frz.generation g ON g.gen_key = x.gen_key AND g.state = 'active';
COMMENT ON VIEW frz.card_axis IS '활성 동결 세대의 택소노미 축(frz.prompt_axis). DB-v2.24 P128';

-- ── P129 ─────────────────────────────────────────────────────────────────────
CREATE TABLE frz.brand_name (
  gen_key int4 NOT NULL REFERENCES frz.generation (gen_key),
  brand_key int4 NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (gen_key, brand_key));
COMMENT ON TABLE frz.brand_name IS
  '세대별 브랜드 표시명(현행 summary_brand_mentions.brand_name 의 생성 시점 값). 세대 셀 답변의 브랜드 키 ∪ 당사 행(kind 1). DB-v2.24 P129';
CREATE VIEW frz.card_brand_name AS
SELECT g.cyc_key, n.brand_key, n.name FROM frz.brand_name n JOIN frz.generation g ON g.gen_key = n.gen_key AND g.state = 'active';
COMMENT ON VIEW frz.card_brand_name IS '활성 동결 세대의 브랜드 표시명(frz.brand_name). DB-v2.24 P129';

-- ── P130 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION frz._bake_names(p_gen int4) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE n int;
BEGIN
  INSERT INTO frz.brand_name (gen_key, brand_key, name)
  SELECT p_gen, b.brand_key, b.name FROM rd.dim_brand_name b
   WHERE b.kind = 1
      OR b.brand_key IN (SELECT ab.brand_key FROM frz.cell c JOIN rd.job j ON j.answer_key = c.answer_key
                           JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date AND ab.answer_key = j.answer_key
                          WHERE c.gen_key = p_gen);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;
COMMENT ON FUNCTION frz._bake_names(int4) IS
  '세대 브랜드 표시명 굽기: 셀 답변(위치 = rd.job, 굽는 시점 rd 값)의 브랜드 키와 당사 행의 rd.dim_brand_name.name. 반환 = 행 수. DB-v2.24 P130';

CREATE FUNCTION frz.bake_hub(p_gen int4) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE gr record; n_web int := 0; n_axis int; n_names int; n_unit int := 0; n_tgt int := 0; nl text := current_setting('enable_nestloop');
BEGIN
  SELECT g.gen_key, g.cyc_key, g.surface INTO gr FROM frz.generation g WHERE g.gen_key = p_gen;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'frz.bake_hub: 세대 % 없음', p_gen;
  END IF;
  IF gr.surface = 2 THEN
    -- 웹 셀 판정(허브 유닛 경로와 같은 식, 굽는 시점 rd 값): report_fs = rd.web_report_prompt, unit_owned = rd.answer.own_url_cited,
    -- unit_target = 답변 인용 URL 정규형 ∈ (답변 프로젝트, 같은 report_fs) 유닛 전 프롬프트의 타겟(rd.dim_prompt.targets, flat)
    -- 행마다 상관 EXISTS(인용 색인 탐침 + 유닛 타겟 배열) = 셀 수에 선형이다. 막 넣은 셀은 통계에 없어 계획기가 세대 셀을 1행으로 보므로
    -- 집합 조인으로 쓰면 중첩 루프가 셀 수 제곱이 된다(로컬 합성 웹 회차 1만 셀: 2분 넘게, 이 형태 0.4초)
    WITH tga AS MATERIALIZED (                            -- (프로젝트, report_fs) 유닛의 전 프롬프트 타겟 정규형 배열(flat)
      SELECT d.project_key, w2.report_fs, array_agg(DISTINCT t.n) AS arr
        FROM rd.web_report_prompt w2 JOIN rd.dim_prompt d ON d.prompt_key = w2.prompt_key CROSS JOIN LATERAL unnest(d.targets) t(n)
       WHERE d.surface = 2
       GROUP BY 1, 2)
    INSERT INTO frz.cell_web (gen_key, answer_key, cyc_key, report_fs, unit_owned, unit_target)
    SELECT c.gen_key, c.answer_key, c.cyc_key, wr.report_fs, coalesce(x.own_url_cited, false),
           wr.report_fs IS NOT NULL AND EXISTS (
             SELECT 1 FROM tga JOIN rd.citation ct ON ct.surface = j.surface AND ct.round_date = j.round_date AND ct.answer_key = j.answer_key
               JOIN rd.dim_url u ON u.url_key = ct.url_key
              WHERE tga.project_key = x.project_key AND tga.report_fs = wr.report_fs AND u.url_norm = ANY (tga.arr))
      FROM frz.cell c
      JOIN rd.job j ON j.answer_key = c.answer_key
      LEFT JOIN rd.answer x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
      LEFT JOIN rd.web_report_prompt wr ON wr.prompt_key = c.prompt_key
     WHERE c.gen_key = p_gen;
    GET DIAGNOSTICS n_web = ROW_COUNT;
    SELECT count(*) FILTER (WHERE report_fs IS NOT NULL), count(*) FILTER (WHERE unit_target) INTO n_unit, n_tgt
      FROM frz.cell_web WHERE gen_key = p_gen;
    IF n_web <> (SELECT count(*) FROM frz.cell WHERE gen_key = p_gen) THEN
      RAISE EXCEPTION 'frz.bake_hub: 웹 셀 판정 수 % 가 셀 수와 다르다(rd.job 없는 셀)', n_web;
    END IF;
    IF EXISTS (SELECT 1 FROM frz.prompt WHERE gen_key = p_gen AND NOT in_full_cycle) THEN
      RAISE EXCEPTION 'frz.bake_hub: 웹 세대 % 에 in_full_cycle 거짓 프롬프트(웹 카드 읽기 뷰는 웹 in_full_cycle 참을 전제한다)', p_gen;
    END IF;
  END IF;
  -- 택소노미 축(현행 summary_prompt_dim cat CTE): 글로벌 = 루트 카탈로그 행(삭제 포함), 웹 = 전 프로젝트 행(삭제 제외). 최근 수정 행 값(동률 prompt_id)
  -- 집합 조인(카탈로그 집계 ⋈ 세대 프롬프트 축)이라 해시 조인으로 고정한다: 막 넣은 축 행을 계획기가 1행으로 보면 집계를 행마다 다시 훑는다
  PERFORM set_config('enable_nestloop', 'off', true);
  WITH cat AS MATERIALIZED (
    SELECT p.scope_prompt_id AS pid,
           (array_agg(p.funnel_stage ORDER BY p.updated_at DESC, p.prompt_id))[1] AS funnel,
           (array_agg(p.list_type    ORDER BY p.updated_at DESC, p.prompt_id))[1] AS list_type,
           (array_agg(p.depth1       ORDER BY p.updated_at DESC, p.prompt_id))[1] AS depth1,
           (array_agg(p.depth2       ORDER BY p.updated_at DESC, p.prompt_id))[1] AS depth2,
           (array_agg(p.depth3       ORDER BY p.updated_at DESC, p.prompt_id))[1] AS depth3,
           array_agg(DISTINCT pr.res) FILTER (WHERE pr.res IS NOT NULL) AS pres
      FROM app.prompt p
      LEFT JOIN app.brand bb ON bb.brand_code = p.brand_code
      CROSS JOIN LATERAL (SELECT coalesce(p.brand_presence, CASE WHEN bb.is_umbrella THEN 'unbranded'
                                                                 WHEN p.brand_code IS NOT NULL THEN 'branded' END) AS res) pr
     WHERE p.scope_prompt_id IS NOT NULL
       AND CASE WHEN gr.surface = 1 THEN p.project_id IN (SELECT project_id FROM app.project WHERE kind = 'standard_root')
                ELSE p.deleted_at IS NULL END
     GROUP BY 1)
  INSERT INTO frz.prompt_axis (gen_key, prompt_key, cyc_key, funnel_key, presence_keys, list_type_key, depth1_key, depth2_key, depth3_key)
  SELECT q.gen_key, q.prompt_key, q.cyc_key, tf.taxon_key,
         coalesce((SELECT array_agg(t.taxon_key ORDER BY t.taxon_key) FROM rd.dim_taxon t
                    WHERE t.axis = 'presence' AND t.parent_key IS NULL AND t.code = ANY (cat.pres)), '{}'),
         tl.taxon_key, t1.taxon_key, t2.taxon_key, t3.taxon_key
    FROM frz.prompt q
    LEFT JOIN rd.dim_prompt d ON d.prompt_key = q.prompt_key
    LEFT JOIN cat ON cat.pid = d.prompt_id
    LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = cat.funnel AND tf.parent_key IS NULL
    LEFT JOIN rd.dim_taxon tl ON tl.axis = 'list_type' AND tl.code = cat.list_type AND tl.parent_key IS NULL
    LEFT JOIN rd.dim_taxon t1 ON t1.axis = 'depth1' AND t1.code = cat.depth1 AND t1.parent_key IS NULL
    LEFT JOIN rd.dim_taxon t2 ON t2.axis = 'depth2' AND t2.code = cat.depth2 AND t2.parent_key IS NOT DISTINCT FROM t1.taxon_key
    LEFT JOIN rd.dim_taxon t3 ON t3.axis = 'depth3' AND t3.code = cat.depth3 AND t3.parent_key IS NOT DISTINCT FROM t2.taxon_key
   WHERE q.gen_key = p_gen;
  GET DIAGNOSTICS n_axis = ROW_COUNT;
  PERFORM set_config('enable_nestloop', nl, true);
  n_names := frz._bake_names(p_gen);
  RETURN jsonb_build_object('web_cells', n_web, 'web_unit_cells', n_unit, 'web_target_cells', n_tgt, 'axis_prompts', n_axis, 'brand_names', n_names);
END $f$;
COMMENT ON FUNCTION frz.bake_hub(int4) IS
  '허브 세대(S2 생성기)의 S4 판정 굽기: 웹 셀 판정(frz.cell_web)·택소노미 축(frz.prompt_axis)·브랜드 표시명(frz.brand_name). '
  '활성화 전(building)에 frz.freeze_cycle 이 부른다. 반환 = 카운트. DB-v2.24 P130';

CREATE OR REPLACE FUNCTION frz.freeze_cycle(p_cycle uuid, p_judgment jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE c record; g int4; n_cell int; n_dup int; n_seat int; n_prompt int; n_fc_fail int; st jsonb; s4 jsonb; t0 timestamptz := clock_timestamp();
BEGIN
  SELECT i.cycle_id, i.cyc_key, i.surface AS surf, i.scope_project_id, i.status, rc.surface, rc.round_date
    INTO c FROM ing.cycle i JOIN rd.cycle rc ON rc.cyc_key = i.cyc_key WHERE i.cycle_id = p_cycle;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'frz.freeze_cycle: 회차 % 없음(ing.cycle·rd.cycle)', p_cycle;
  END IF;
  IF c.surf NOT IN ('global', 'website') OR c.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'surface_or_status', 'surface', c.surf, 'cycle_status', c.status);
  END IF;
  SELECT gen_key INTO g FROM frz.generation WHERE cyc_key = c.cyc_key AND state = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already', 'gen_key', g);
  END IF;

  INSERT INTO frz.generation (cyc_key, surface, source, judgment)
  VALUES (c.cyc_key, c.surface, 'hub',
          coalesce(p_judgment, '{}'::jsonb) || jsonb_build_object(
            'cycle_id', c.cycle_id,
            'ecat_active_ver', (SELECT ver FROM app.ecat_version WHERE status = 'active'),
            'ecat_cycle_pin', (SELECT ecat_ver FROM rd.cycle WHERE cyc_key = c.cyc_key),
            'rule_ver', (SELECT max(rule_ver) FROM app.rule_set),
            'surface_generation', (SELECT generation FROM rd.surface_generation WHERE surface = c.surface),
            'max_load_id', (SELECT max(load_id) FROM ing.load WHERE status = 'committed')))
  RETURNING gen_key INTO g;

  -- 셀 집합: 회차 run 의 서빙 답변에서 셀당 1건(미러 시각 DESC NULLS FIRST, job_id). 같은 답변이 두 셀에 들면(웹 사이트 조인 갈래) 앞 셀만
  CREATE TEMP TABLE _frz_cand ON COMMIT DROP AS
  SELECT DISTINCT ON (a.prompt_id, a.target, ck.cell_country)
         j.answer_key, j.prompt_key, j.engine_key, j.geo_key
    FROM ing.cycle_run cr
    JOIN ing.answer a ON a.run_id = cr.run_id AND a.status = 'completed'
    JOIN rd.job j ON j.job_id = a.job_id AND j.served
    LEFT JOIN ing.answer_mirror_time mt ON mt.job_id = a.job_id
    LEFT JOIN ing.answer_anchor_pin pin ON pin.job_id = a.job_id
    LEFT JOIN app.website_prompt wp ON c.surf = 'website' AND wp.scope_prompt_id = a.prompt_id
    LEFT JOIN app.website_site ws ON ws.site_id = wp.site_id AND ws.scope_project_id = c.scope_project_id
    CROSS JOIN LATERAL (SELECT CASE WHEN c.surf = 'website' THEN coalesce(ws.country_code, a.region) ELSE a.region END AS cell_country) ck
   WHERE cr.cycle_id = c.cycle_id
     AND (c.surf = 'website' OR (a.prompt_id IS NOT NULL AND a.region IS NOT NULL))
   ORDER BY a.prompt_id, a.target, ck.cell_country, rd.rep_order_at(a.measured_at, mt.measured_at, pin.anchor) DESC NULLS FIRST, a.job_id;
  INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
  SELECT DISTINCT ON (answer_key) g, answer_key, c.surface, c.cyc_key, c.round_date, prompt_key, engine_key, geo_key FROM _frz_cand ORDER BY answer_key;
  GET DIAGNOSTICS n_cell = ROW_COUNT;
  n_dup := (SELECT count(*) FROM _frz_cand) - n_cell;
  DROP TABLE _frz_cand;

  n_seat := frz._keep_seat(g);

  -- 프롬프트 축(셀 프롬프트만)
  INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, expected_cells, window_cells, in_root_catalog, catalog_deleted, cat_mask,
                          funnel_key, presence_key, list_type_key, depth1_key, depth2_key, depth3_key, regions, is_korean, report_fs, src)
  SELECT g, nc.prompt_key, c.cyc_key,
         CASE WHEN c.surf = 'website' THEN true ELSE coalesce(fc.in_full_cycle, false) END,
         CASE WHEN c.surf = 'website' THEN NULL ELSE fc.expected_cells END,
         CASE WHEN c.surf = 'website' THEN nc.cells ELSE coalesce(fc.window_cells, nc.cells) END,
         coalesce(d.in_root_catalog_all, d.in_root_catalog, false),
         coalesce(d.in_root_catalog_all AND NOT d.in_root_catalog, false),
         coalesce(CASE WHEN c.surf = 'website' THEN d.cat_mask ELSE coalesce(d.cat_mask_all, d.cat_mask) END, 0),
         coalesce(d.funnel_key, 0), ce.presence_key, ce.list_type_key, ce.depth1_key, ce.depth2_key, ce.depth3_key,
         d.regions, d.is_korean, wr.report_fs,
         jsonb_strip_nulls(jsonb_build_object('catalog_entries', ce.entries, 'cat_mask_live', d.cat_mask, 'in_root_catalog_live', d.in_root_catalog,
                                              'prompt_id', d.prompt_id))
    FROM (SELECT prompt_key, count(*)::int AS cells FROM frz.cell WHERE gen_key = g GROUP BY 1) nc
    LEFT JOIN rd.dim_prompt d ON d.prompt_key = nc.prompt_key                 -- prompt_id 없는 웹 답변(키 0)도 축 행을 둔다
    LEFT JOIN ing.full_cycle_expected(c.cycle_id) fc ON fc.prompt_id = d.prompt_id
    LEFT JOIN rd.web_report_prompt wr ON c.surf = 'website' AND wr.prompt_key = nc.prompt_key
    LEFT JOIN LATERAL (
      SELECT min(e.presence_key) AS presence_key, min(e.list_type_key) AS list_type_key, min(e.depth1_key) AS depth1_key,
             min(e.depth2_key) AS depth2_key, min(e.depth3_key) AS depth3_key,
             jsonb_agg(jsonb_build_object('brand_bit', e.brand_bit, 'presence', e.presence_key, 'funnel', e.funnel_key, 'list_type', e.list_type_key,
                                          'depth1', e.depth1_key, 'depth2', e.depth2_key, 'depth3', e.depth3_key, 'kind', e.kind)
                       ORDER BY e.catalog_row_id) AS entries
        FROM rd.catalog_entry e WHERE e.prompt_key = nc.prompt_key) ce ON true;
  GET DIAGNOSTICS n_prompt = ROW_COUNT;
  n_fc_fail := (SELECT count(*) FROM frz.prompt WHERE gen_key = g AND NOT in_full_cycle);

  s4 := frz.bake_hub(g);                     -- S4(DB-v2.24): 웹 셀 판정·택소노미 축·브랜드 표시명
  PERFORM frz.activate(g);
  st := frz.assert_generation(g);
  UPDATE frz.generation
     SET row_counts = jsonb_build_object('cells', n_cell, 'dup_answer_cells', n_dup, 'kept_seat', n_seat, 'prompts', n_prompt,
                                         'prompts_not_full_cycle', n_fc_fail) || jsonb_build_object('s4', s4),
         verify = jsonb_build_object('structure', st, 'ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000))
   WHERE gen_key = g;
  RETURN jsonb_build_object('status', 'frozen', 'gen_key', g, 'cells', n_cell, 'dup_answer_cells', n_dup, 'kept_seat', n_seat, 'prompts', n_prompt,
                            'prompts_not_full_cycle', n_fc_fail, 's4', s4, 'ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000));
END $f$;

COMMENT ON FUNCTION frz.freeze_cycle(uuid, jsonb) IS
  '발행 회차(global·website)의 동결 세대 생성: 셀 집합(미러 시각 셀 대표)·좌석 보관·프롬프트 축(in_full_cycle 포함)·판정 입력 포인터 → '
  'S4 판정 굽기(frz.bake_hub) → 활성화 → 구조 단언. 활성 세대가 있으면 할 일 없음(멱등). 호출자 트랜잭션 안(원장 발행). DB-v2.22 P122 · DB-v2.24 P130';

-- ── P131 ─────────────────────────────────────────────────────────────────────
-- 활성 허브 세대(이 패치 전에 생성)는 지금 굽는다(로컬·시험 DB. stg·운영은 이 패치 전에 세대가 없다)
DO $v$
DECLARE g int4;
BEGIN
  FOR g IN SELECT gen_key FROM frz.generation WHERE state = 'active' AND source = 'hub' ORDER BY gen_key LOOP
    PERFORM frz.bake_hub(g);
  END LOOP;
END $v$;

ALTER TABLE frz.cell_web OWNER TO hmg_owner;
ALTER TABLE frz.prompt_axis OWNER TO hmg_owner;
ALTER TABLE frz.brand_name OWNER TO hmg_owner;
ALTER VIEW frz.card_web OWNER TO hmg_owner;
ALTER VIEW frz.card_answer_w OWNER TO hmg_owner;
ALTER VIEW frz.card_answer_brand_w OWNER TO hmg_owner;
ALTER VIEW frz.card_citation_w OWNER TO hmg_owner;
ALTER VIEW frz.card_axis OWNER TO hmg_owner;
ALTER VIEW frz.card_brand_name OWNER TO hmg_owner;
ALTER FUNCTION frz._bake_names(int4) OWNER TO hmg_owner;
ALTER FUNCTION frz.bake_hub(int4) OWNER TO hmg_owner;
ALTER FUNCTION frz.freeze_cycle(uuid, jsonb) OWNER TO hmg_owner;
REVOKE ALL ON FUNCTION frz._bake_names(int4), frz.bake_hub(int4) FROM PUBLIC;
GRANT SELECT ON frz.cell_web, frz.prompt_axis, frz.brand_name, frz.card_web, frz.card_axis, frz.card_brand_name,
                frz.card_answer_w, frz.card_answer_brand_w, frz.card_citation_w
  TO api_ro, admin_long, loader, migrator;
GRANT INSERT, DELETE ON frz.cell_web, frz.prompt_axis, frz.brand_name TO migrator;
GRANT EXECUTE ON FUNCTION frz._bake_names(int4) TO migrator;
GRANT EXECUTE ON FUNCTION frz.bake_hub(int4) TO loader, migrator;

DO $v$ BEGIN
  PERFORM frz.assert_shape();
  IF NOT has_table_privilege('api_ro', 'frz.card_web', 'select') OR has_table_privilege('api_ro', 'frz.cell_web', 'insert')
     OR has_table_privilege('loader', 'frz.cell_web', 'insert')
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'frz.card_axis'::regclass)) <> 'hmg_owner'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'frz.bake_hub(int4)'::regprocedure) THEN
    RAISE EXCEPTION 'P131 실패: 소유자·권한';
  END IF;
  IF (SELECT (length(d) - length(replace(d, 'UNION ALL', ''))) / 9 FROM pg_get_viewdef('frz.card_answer'::regclass) d) <> 1 THEN
    RAISE EXCEPTION 'P126 실패: 카드 뷰에 비동결 갈래가 남았다';
  END IF;
  -- 웹 카드 읽기 뷰 열 = rd 열 + 웹 셀 판정 6열(이름·순서)
  IF EXISTS (SELECT 1 FROM unnest('{answer,answer_brand,citation}'::text[]) t
              WHERE (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
                      WHERE attrelid = format('frz.card_%s_w', t)::regclass AND attnum > 0 AND NOT attisdropped)
                IS DISTINCT FROM (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
                                   WHERE attrelid = format('rd.%s', t)::regclass AND attnum > 0 AND NOT attisdropped)
                                 || ',unit_in,unit_owned,unit_target,url_registered,url_owned_hit,url_target_hit') THEN
    RAISE EXCEPTION 'P127 실패: 웹 카드 읽기 뷰 열이 rd 열 + 웹 판정 6열이 아니다';
  END IF;
END $v$;

COMMIT;
