-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.23 (PostgreSQL 17, 2026-10-01) · 카드 경로 동결 층 S3: 카드 읽기 뷰(제품 결정 31·32)
-- 번호: P124~P125. 적용 순서: DB-v2.22 뒤 1회(트랜잭션 1개). 합본 DB-v2.23.sql = DB-v2.22.sql + 이 파일(바이트 연결).
-- 근거: card-snapshot-design.md 12.7(S3)·12.10. 카드 요청(core.card_routes) ∧ 현행 프로필 freeze_at_publish 이면 core.facts 가 이 뷰 이름을 낸다.
--
-- P124 카드 읽기 뷰 frz.card_answer·card_answer_brand·card_citation(rd 와 같은 열·순서)
--      = 동결 회차(활성 세대 있음): S1 동결 읽기(셀 대표·보관 행·좌석·is_rep 참)와 같은 행 중 프롬프트 축 in_full_cycle 인 셀,
--        글로벌은 bgrp 를 동결 카탈로그 비트(frz.prompt.cat_mask = 현행 summary_prompt_dim.catalog_brands, 삭제 행 포함)로 바꿔 낸다
--      ∪ 비동결 회차(활성 세대 없음): rd 행 그대로(현행 미러 폴백의 허브 대응, 회차 단위).
--      현행 근거: 카드·기간 비교 집계 게이트 summary-trend-aggregates.ts:674-720 trendWhere(in_full_cycle = 1, 카탈로그 = catalog_brands &&),
--      스냅샷 카드 summary-global-aggregates.ts:159.
-- P125 추이 격자 뷰 frz.grid_answer·grid_answer_brand·grid_citation: 위와 같고 in_full_cycle 게이트만 없다(현행 X.trendGrid 글로벌 추이,
--      summary-global-trend-read.ts:257-290 → trendWhere :700 "추이 격자에서는 in_full_cycle 하나만 빠진다").
--      ⚠️ 뷰 열 목록은 이 DB 의 rd 카탈로그에서 만든다. rd 열을 더하는 뒤 패치는 frz 보관 표·S1 뷰와 함께 이 뷰들도 다시 만든다(frz.assert_shape 확장).
-- 락: 새 뷰뿐(표 생성·ALTER 없음).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regprocedure('frz.freeze_cycle(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.22(frz.freeze_cycle) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('frz.card_answer') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.23 이미 적용됨(frz.card_answer 존재)';
  END IF;
END $v$;

-- ── P124·P125 ────────────────────────────────────────────────────────────────
-- 동결 갈래는 S1 뷰(frz.answer 등)를 다시 감싸지 않고 셀·세대·프롬프트 축을 한 번만 조인한다(세대 조인 중복 제거):
--   rd 갈래 = 셀 좌석의 rd 행(그 세대 보관 없음), 보관 갈래 = 그 세대 frz.keep_*(좌석은 셀 값), 두 갈래 모두 is_rep 참·글로벌 bgrp = 동결 카탈로그 비트.
DO $v$
DECLARE t text; kind text; rd_cols text; kp_cols text; live_cols text; gate text;
BEGIN
  FOREACH kind IN ARRAY '{card,grid}'::text[] LOOP
    gate := CASE kind WHEN 'card' THEN ' AND q.in_full_cycle' ELSE '' END;
    FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
      -- 좌석 열(surface·round_date·cyc_key·answer_key)은 셀 값으로 낸다(rd 행과 같은 값): 읽기 술어(cyc_key = ANY 등)가 셀 색인으로 내려간다
      SELECT string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep'
                                       WHEN 'bgrp' THEN 'CASE WHEN c.surface = 1 THEN q.cat_mask ELSE x.bgrp END AS bgrp'
                                       WHEN 'surface' THEN 'c.surface' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                       WHEN 'answer_key' THEN 'c.answer_key'
                                       ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
             string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date' WHEN 'cyc_key' THEN 'c.cyc_key'
                                       WHEN 'surface' THEN 'c.surface' WHEN 'answer_key' THEN 'c.answer_key'
                                       WHEN 'bgrp' THEN 'CASE WHEN c.surface = 1 THEN q.cat_mask ELSE k.bgrp END AS bgrp'
                                       ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
             string_agg('r.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO rd_cols, kp_cols, live_cols
        FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
      EXECUTE format(
        'CREATE VIEW frz.%1$I AS '
        'SELECT %2$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
        'JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key%5$s '
        'JOIN rd.%4$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key '
        'WHERE NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) '
        'UNION ALL '
        'SELECT %3$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
        'JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key%5$s '
        'JOIN frz.%6$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key '
        'UNION ALL '
        'SELECT %7$s FROM rd.%4$I r '
        'WHERE NOT EXISTS (SELECT 1 FROM frz.generation g WHERE g.cyc_key = r.cyc_key AND g.state = ''active'')',
        kind || '_' || t, rd_cols, kp_cols, t, gate, 'keep_' || t, live_cols);
      EXECUTE format('COMMENT ON VIEW frz.%I IS %L', kind || '_' || t,
                     format('카드 경로 %s 읽기(rd.%s 와 같은 열): 동결 회차 = 셀 대표 rd 행(보관 없음) ∪ 보관 행%s(is_rep 참, 좌석 = 셀, 글로벌 bgrp = 동결 카탈로그 비트) '
                            '∪ 비동결 회차 = rd 행. DB-v2.23 %s',
                            CASE kind WHEN 'card' THEN '' ELSE '추이 격자 ' END, t,
                            CASE kind WHEN 'card' THEN ', in_full_cycle 셀만' ELSE '' END,
                            CASE kind WHEN 'card' THEN 'P124' ELSE 'P125' END));
      EXECUTE format('ALTER VIEW frz.%I OWNER TO hmg_owner', kind || '_' || t);
      EXECUTE format('GRANT SELECT ON frz.%I TO api_ro, admin_long, loader, migrator', kind || '_' || t);
    END LOOP;
  END LOOP;
END $v$;

-- 모양 단언 확장: 카드·격자 뷰 열 이름·형·순서 = rd 열(DB-v2.21 판의 나머지 단언 = 보관 표 + gen_key·rd 사실 표 frz 트리거 없음·하위 파티션 쓰기 권한 없음 그대로)
CREATE OR REPLACE FUNCTION frz.assert_shape() RETURNS int
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
DECLARE t text; v text; a text; b text; n int := 0; bad text;
BEGIN
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO a
      FROM pg_attribute WHERE attrelid = format('rd.%I', t)::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO b
      FROM pg_attribute WHERE attrelid = format('frz.keep_%s', t)::regclass AND attnum > 0 AND NOT attisdropped;
    IF b IS DISTINCT FROM a || ',gen_key:integer' THEN
      RAISE EXCEPTION 'frz.assert_shape: rd.% 열과 frz.keep_%(+gen_key) 열이 다르다(rd 열을 더한 패치는 frz 보관 표·뷰를 같이 갱신)', t, t;
    END IF;
    FOREACH v IN ARRAY ARRAY[format('frz.%s', t), format('frz.card_%s', t), format('frz.grid_%s', t)] LOOP
      SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO b
        FROM pg_attribute WHERE attrelid = v::regclass AND attnum > 0 AND NOT attisdropped;
      IF a IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'frz.assert_shape: rd.% 열과 % 열이 다르다(rd 열을 더한 패치는 frz 보관 표·뷰를 같이 갱신)', t, v;
      END IF;
    END LOOP;
    n := n + 1;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'frz%'
               AND tgrelid IN ('rd.answer'::regclass, 'rd.answer_brand'::regclass, 'rd.citation'::regclass)) THEN
    RAISE EXCEPTION 'frz.assert_shape: rd 사실 표에 frz 트리거가 있다(보관은 명시 관문 frz.keep_rewrite·keep_settle)';
  END IF;
  SELECT string_agg(p.relid::regclass::text, ', ') INTO bad
    FROM unnest('{rd.answer,rd.answer_brand,rd.answer_stance,rd.citation}'::regclass[]) r(root)
    CROSS JOIN LATERAL pg_partition_tree(r.root) p
   WHERE p.level > 0 AND (has_table_privilege('loader', p.relid, 'INSERT') OR has_table_privilege('loader', p.relid, 'UPDATE')
                          OR has_table_privilege('loader', p.relid, 'DELETE') OR has_table_privilege('loader', p.relid, 'TRUNCATE')
                          OR has_table_privilege('migrator', p.relid, 'INSERT') OR has_table_privilege('migrator', p.relid, 'UPDATE')
                          OR has_table_privilege('migrator', p.relid, 'DELETE') OR has_table_privilege('migrator', p.relid, 'TRUNCATE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'frz.assert_shape: rd 사실 표 하위 파티션에 loader·migrator 쓰기 권한이 있다: %', bad;
  END IF;
  RETURN n;
END $f$;
ALTER FUNCTION frz.assert_shape() OWNER TO hmg_owner;

DO $v$ BEGIN
  PERFORM frz.assert_shape();
  IF NOT has_table_privilege('api_ro', 'frz.card_answer', 'select') OR has_table_privilege('api_ro', 'frz.card_answer', 'insert')
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'frz.grid_citation'::regclass)) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P124~P125 실패: 소유자·권한';
  END IF;
END $v$;

COMMIT;
