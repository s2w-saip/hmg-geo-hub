-- 합성 픽스처(fixture-10-data.sql) 에 대한 손 계산 기대값 대조. 출력: 케이스별 PASS/FAIL + 불일치 상세.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DROP TABLE IF EXISTS _res;
CREATE TEMP TABLE _res (grp text, case_name text, ok bool, detail text);

-- ── 답변(rd.answer) ─────────────────────────────────────────────────────────
-- (k, case, cyc, round_date, elig, dflt, is_acr, iter, state, is_rep, std_in, cit_in, own_mask, rk_h, rk_k, ment_total, ment_h, ment_k,
--  sent_pos_h, sent_pos_k, sent_all_h, sent_all_k, web_reg, has_cit, tgt_cited, own_url_cited, bgrp, anchor_src, cat_mask, geo, lang)
CREATE TEMP TABLE _ea (k int, c text, cyc int, rd date, elig bool, dflt bool, is_acr bool, iter int, st int, rep bool, std bool, cit bool,
  om int, rkh int, rkk int, mt int, mh int, mk int, sph int, spk int, sah int, sak int, web bool, hc bool, tc bool, oc bool, bg int, asrc int,
  cm int, geo text, lang text);
INSERT INTO _ea VALUES
 ( 1,'롤업·별칭·비경쟁·순위(글로벌 기본)',11,'2026-09-14',true ,true ,false,1,0,false,true ,true ,1,2,0,7,4,0,3,0,4,0,false,true ,false,false,5,2,5,'US','en'),
 ( 2,'엔티티 별칭 기아·bare-only 비경쟁'  ,11,'2026-09-14',true ,true ,false,1,0,true ,true ,true ,2,0,1,3,0,2,0,1,0,2,false,false,false,false,5,2,5,'US','en'),
 ( 3,'R07 한국어 프롬프트 비KR 제외'      ,11,'2026-09-14',false,true ,false,1,0,false,false,false,2,0,1,2,0,1,0,1,0,1,false,false,false,false,1,2,1,'US','ko'),
 ( 4,'A16 분석 미도착(대용식) gap'        ,11,'2026-09-14',true ,true ,false,1,2,true ,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,1,2,1,'KR','ko'),
 ( 5,'R07 태그 시장 밖·A16 인용만=1'      ,11,'2026-09-14',false,true ,false,1,1,false,false,false,0,0,0,0,0,0,0,0,0,0,false,true ,false,false,2,2,2,'DE','en'),
 ( 6,'R07 카탈로그 밖'                    ,11,'2026-09-14',false,true ,false,1,2,false,false,false,0,0,0,0,0,0,0,0,0,0,false,false,false,false,0,2,0,'US','en'),
 ( 7,'R07 숨김 국가 ID'                   ,11,'2026-09-14',false,true ,false,1,2,false,false,false,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,2,5,'ID','en'),
 ( 8,'기본 엔진 밖 deepseek'              ,11,'2026-09-14',true ,false,false,1,2,true ,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,2,5,'US','en'),
 ( 9,'A16 분석 실패=3·R05 재측정 대표'     ,11,'2026-09-14',true ,true ,false,1,3,true ,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,2,5,'US','en'),
 (10,'R13 ACR 반복 3번째'                 ,11,'2026-09-14',true ,true ,true ,3,2,false,false,false,0,0,0,0,0,0,0,0,0,0,false,false,false,false,8,2,8,'US','en'),
 (11,'R13 ACR 반복 2번째'                 ,11,'2026-09-14',true ,true ,true ,2,2,false,false,false,0,0,0,0,0,0,0,0,0,0,false,false,false,false,8,2,8,'US','en'),
 (12,'R13 ACR 반복 1번째(최신)'           ,11,'2026-09-14',true ,true ,true ,1,0,true ,true ,true ,1,1,0,1,1,0,1,0,1,0,false,false,false,false,8,2,8,'US','en'),
 (15,'R07 run 실패'                       ,11,'2026-09-14',false,true ,false,1,2,false,false,false,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,2,5,'US','en'),
 (16,'R05 같은 셀 더 늦은 답(a17)에 밀림'  ,10,'2026-09-07',true ,true ,false,1,2,false,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,2,5,'US','en'),
 (17,'R02 pin → 원장 UTC 날짜 회차'       ,10,'2026-09-07',true ,true ,false,1,2,true ,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,5,1,5,'US','en'),
 (18,'R02 pin 코호트 전파·공통 프롬프트'   ,10,'2026-09-07',true ,true ,false,1,2,true ,false,true ,0,0,0,0,0,0,0,0,0,0,false,false,false,false,8,1,8,'US','en'),
 (21,'웹 타겟·유닛 자사·형제 제외'        ,21,'2026-09-18',true ,true ,false,1,0,true ,true ,true ,2,0,1,1,0,1,0,0,0,1,true ,true ,true ,true ,2,2,0,'DE','de'),
 (22,'웹 두번째 유닛 타겟'                 ,21,'2026-09-18',true ,true ,false,1,1,true ,true ,true ,0,0,0,0,0,0,0,0,0,0,true ,true ,true ,true ,2,2,0,'DE','de'),
 (31,'프로젝트 자사·추적 URL·루트 홈'      ,31,'2026-09-20',true ,true ,false,1,1,true ,true ,true ,0,0,0,0,0,0,0,0,0,0,false,true ,true ,true ,1,4,0,'US','en');
INSERT INTO _res
SELECT 'answer', e.k || ' ' || e.c,
       a.answer_key IS NOT NULL AND (a.cyc_key, a.round_date, a.elig, a.dflt, a.is_acr, a.acr_iter_rank, a.analysis_state, a.is_rep, a.std_in, a.cit_in,
        a.own_mask, a.own_rk_h, a.own_rk_k, a.ment_total, a.ment_h, a.ment_k, a.sent_pos_h, a.sent_pos_k, a.sent_all_h, a.sent_all_k,
        a.web_reg, a.has_cit, a.tgt_cited, a.own_url_cited, a.bgrp, a.anchor_src, a.cat_mask, g.code, l.code)
       IS NOT DISTINCT FROM
       (e.cyc, e.rd, e.elig, e.dflt, e.is_acr, e.iter::int2, e.st::int2, e.rep, e.std, e.cit, e.om::int2, e.rkh::int2, e.rkk::int2, e.mt::int2,
        e.mh::int2, e.mk::int2, e.sph::int2, e.spk::int2, e.sah::int2, e.sak::int2, e.web, e.hc, e.tc, e.oc, e.bg::int2, e.asrc::int2, e.cm::int2,
        e.geo, e.lang),
       format('actual=(cyc %s, %s, elig %s, dflt %s, acr %s, it %s, st %s, rep %s, std %s, cit %s, om %s, rk %s/%s, mt %s mh %s mk %s, sp %s/%s, sa %s/%s, web %s, hc %s tc %s oc %s, bg %s, src %s, cm %s, geo %s, lang %s)',
              a.cyc_key, a.round_date, a.elig, a.dflt, a.is_acr, a.acr_iter_rank, a.analysis_state, a.is_rep, a.std_in, a.cit_in, a.own_mask,
              a.own_rk_h, a.own_rk_k, a.ment_total, a.ment_h, a.ment_k, a.sent_pos_h, a.sent_pos_k, a.sent_all_h, a.sent_all_k, a.web_reg,
              a.has_cit, a.tgt_cited, a.own_url_cited, a.bgrp, a.anchor_src, a.cat_mask, g.code, l.code)
  FROM _ea e LEFT JOIN rd.answer a ON a.answer_key = e.k
  LEFT JOIN rd.dim_country g ON g.geo_key = a.geo_key LEFT JOIN rd.dim_lang l ON l.lang_key = a.lang_key;
INSERT INTO _res SELECT 'answer', '서빙 답변 수 = 19(완료·비드롭)', (SELECT count(*) FROM rd.answer) = 19, (SELECT count(*) FROM rd.answer)::text;

-- ── rd.job(비완료·드롭 포함 G-24) ─────────────────────────────────────────
INSERT INTO _res
SELECT 'job', x.c, (j.status_code, j.dropped, j.served, j.analysis_code) IS NOT DISTINCT FROM (x.sc::int2, x.dr, x.sv, x.ac::int2),
       format('actual=(%s,%s,%s,%s)', j.status_code, j.dropped, j.served, j.analysis_code)
  FROM (VALUES (13, '13 비완료(running) → status_code 1·미서빙', 1, false, false, 0),
               (14, '14 드롭 레지스트리 → dropped·미서빙', 0, true, false, 0),
               ( 9, '9 서빙 job analysis_code = analysis_state(3)', 0, false, true, 3)) x(k, c, sc, dr, sv, ac)
  LEFT JOIN rd.job j ON j.answer_key = x.k;

-- ── rd.answer_brand(G-01) ──────────────────────────────────────────────────
-- (k, case, bare, competitive, own_bit, entity_rows, mention_count, rk, s_pos)
INSERT INTO _res
SELECT 'answer_brand', x.c,
       b.answer_key IS NOT NULL AND (b.own_bit, b.entity_rows, b.mention_count, b.rk, b.s_pos) IS NOT DISTINCT FROM (x.ob::int2, x.er::int2, x.mc::int2, x.rk::int2, x.sp::int2),
       format('actual=(own %s, rows %s, mc %s, rk %s, pos %s)', b.own_bit, b.entity_rows, b.mention_count, b.rk, b.s_pos)
  FROM (VALUES
    (1, '1 Hyundai: Creta(롤업 Tata) 접두 교정 합류, rk 2', 'hyundai', true, 1, 2, 4, 2, 3),
    (1, '1 Toyota: Toyota+TOYOTA bare 병합, rk 1', 'toyota', true, 0, 2, 3, 1, 0),
    (1, '1 Apple: 비경쟁 → competitive false, rk 0', 'apple', false, 0, 1, 1, 0, 0),
    (2, '2 Kia: 엔티티 별칭(기아 id → 정본) 자사 K', 'kia', true, 2, 1, 2, 1, 1),
    (2, '2 smart 경쟁: Smart Fortwo bare-only 되살림, rk 2', 'smart', true, 0, 1, 1, 2, 0),
    (2, '2 smart 비경쟁: 브랜드 표기 자체는 제외', 'smart', false, 0, 1, 1, 0, 0),
    (3, '3 Kia rk 1(elig 거짓이어도 자식 행 존재)', 'kia', true, 2, 1, 1, 1, 1),
    (12, '12 ACR 최신 반복 Hyundai rk 1', 'hyundai', true, 1, 1, 1, 1, 1)) x(k, c, bare, comp, ob, er, mc, rk, sp)
  LEFT JOIN rd.dim_brand_name n ON n.bare = x.bare
  LEFT JOIN rd.answer_brand b ON b.answer_key = x.k AND b.brand_key = n.brand_key AND b.competitive = x.comp;
INSERT INTO _res SELECT 'answer_brand', 'Feature(롤업 NULL) 행 미적재·총 10행', (SELECT count(*) FROM rd.answer_brand) = 10, (SELECT count(*) FROM rd.answer_brand)::text;
INSERT INTO _res SELECT 'dim_brand_name', '대소문자 변형 한 키(TOYOTA→Toyota 대표)', (SELECT name FROM rd.dim_brand_name WHERE bare = 'toyota') = 'Toyota',
       (SELECT name FROM rd.dim_brand_name WHERE bare = 'toyota');
INSERT INTO _res SELECT 'dim_brand_name', 'kind: hyundai 1·kia 1·apple 3·smart 3·tata 2',
       (SELECT array_agg(kind ORDER BY bare) FROM rd.dim_brand_name WHERE bare IN ('hyundai', 'kia', 'apple', 'smart', 'tata')) = '{3,1,1,3,2}'::int2[],
       (SELECT array_agg(bare || ':' || kind ORDER BY bare)::text FROM rd.dim_brand_name WHERE bare IN ('hyundai', 'kia', 'apple', 'smart', 'tata'));

-- ── rd.answer_stance ───────────────────────────────────────────────────────
INSERT INTO _res
SELECT 'answer_stance', x.c, s.answer_key IS NOT NULL AND (s.first_turn, s.own_bit, s.stance) IS NOT DISTINCT FROM (x.ft, x.ob::int2, x.st::int2),
       format('actual=(first %s, own %s, stance %s)', s.first_turn, s.own_bit, s.stance)
  FROM (VALUES (1, '00000000-0000-0000-0000-000000000301'::uuid, 0, '1 Hyundai 턴0 = first_turn, 긍정', true, 1, 1),
               (1, '00000000-0000-0000-0000-000000000301'::uuid, 1, '1 Hyundai 턴1(ACR 후속) first_turn 거짓', false, 1, 4),
               (1, '71000000-0000-4000-8000-000000000001'::uuid, 0, '1 Toyota 경쟁 중립', true, 0, 2),
               (2, 'ed4b8012-4a73-4174-9b43-4cb696934b25'::uuid, 0, '2 기아(별칭 id·표기 접두) → 자사 K, 혼합', true, 2, 3)) x(k, e, t, c, ft, ob, st)
  LEFT JOIN rd.dim_entity de ON de.entity_id = x.e
  LEFT JOIN rd.answer_stance s ON s.answer_key = x.k AND s.entity_key = de.entity_key AND s.turn_index = x.t;

-- ── rd.citation ────────────────────────────────────────────────────────────
-- (k, ord, case, skey, category, category_src, owner_prefix, loc, tgt, src_first)
INSERT INTO _res
SELECT 'citation', x.c,
       r.answer_key IS NOT NULL AND (coalesce(s.skey, ''), cc.name, s.category_src, coalesce(o.prefix, ''), r.loc_owned, r.tgt_hit, r.src_first)
         IS NOT DISTINCT FROM (x.skey, x.cat, x.csrc::int2, x.opfx, x.loc, x.tgt, x.sf),
       format('actual=(%s, %s, src %s, owner %s, loc %s, tgt %s, first %s)', s.skey, cc.name, s.category_src, o.prefix, r.loc_owned, r.tgt_hit, r.src_first)
  FROM (VALUES
    (1, 1, '1.1 공식 도메인(owned) + 최장 접두 owner', 'hyundai.com', 'Official (HMG)', 3, 'hyundai.com/au/en', false, false, true),
    (1, 2, '1.2 seed.json 커뮤니티', 'reddit.com', 'Community & Forums', 4, '', false, false, true),
    (1, 3, '1.3 공식 소셜 계정 키(경계 없는 매처)', 'linkedin.com/hyundai-motor-group', 'Official (HMG)', 2, '', false, false, true),
    (1, 4, '1.4 같은 출처 두번째 → src_first 거짓', 'reddit.com', 'Community & Forums', 4, '', false, false, false),
    (1, 5, '1.5 호스트 없는 인용 → source_key 0', '', 'Other', 6, '', false, false, true),
    (1, 6, '1.6 운영자 오버라이드', 'example.org', 'News & Media', 1, '', false, false, true),
    (1, 7, '1.7 seed.json 매체', 'caranddriver.com', 'Automotive Media', 4, '', false, false, true),
    (1, 8, '1.8 미분류 → Other', 'foo-bar.xyz', 'Other', 6, '', false, false, true),
    (1, 9, '1.9 사이트 루트 홈 → root_home owner', 'hyundaiusa.com', 'Official (HMG)', 3, 'hyundaiusa.com', false, false, true),
    (1, 10, '1.10 국가 없는 카탈로그 base(worldwide.kia.com/en) → Kia owner', 'kia.com', 'Official (HMG)', 3, 'worldwide.kia.com/en', false, false, true),
    (5, 1, '5.1 경쟁사 공식(규칙)', 'bmwusa.com', 'Official (Competitor)', 5, '', false, false, true),
    (21, 1, '21.1 타겟 일치(트래킹 파라미터 제거) + 유닛 base', 'kia.com', 'Official (HMG)', 3, 'kia.com/de', true, true, true),
    (21, 2, '21.2 선언 형제(kia.com/de/sub) → 자사 제외', 'kia.com', 'Official (HMG)', 3, 'kia.com/de', false, false, false),
    (21, 3, '21.3 유닛 타겟 집합(turls) → 자사, 자기 타겟 아님', 'kia.de', 'Official (HMG)', 5, '', true, false, true),
    (22, 1, '22.1 두번째 유닛 base·타겟', 'kia.com', 'Official (HMG)', 3, 'kia.com/de', true, true, true),
    (31, 1, '31.1 프로젝트 설정 base 접두', 'example.com', 'Other', 6, '', true, false, true),
    (31, 2, '31.2 프로젝트 추적 URL(트래킹 제거)', 'example.com', 'Other', 6, '', false, true, false),
    (31, 3, '31.3 프로젝트 루트 홈', 'example.com', 'Other', 6, '', true, false, false),
    (31, 4, '31.4 프로젝트 카탈로그 brand×country base', 'hyundaiusa.com', 'Official (HMG)', 3, 'hyundaiusa.com/us/en', true, false, true)
  ) x(k, o, c, skey, cat, csrc, opfx, loc, tgt, sf)
  LEFT JOIN rd.citation r ON r.answer_key = x.k AND r.ord = x.o
  LEFT JOIN rd.dim_source s ON s.source_key = r.source_key
  LEFT JOIN app.citation_category cc ON cc.category_key = s.category_key
  LEFT JOIN app.owned_base o ON o.owner_key = nullif(r.owner_key, 0);
INSERT INTO _res SELECT 'citation', 'bmwusa.com 경쟁사 브랜드 = BMW(토큰 접두)',
       (SELECT b.name FROM rd.dim_source s JOIN rd.dim_brand_name b ON b.brand_key = s.competitor_brand_key WHERE s.skey = 'bmwusa.com') = 'BMW', NULL;
INSERT INTO _res SELECT 'citation', 'scope_key: global=루트 project, website=unit, project=project',
       (SELECT bool_and(CASE r.surface WHEN 1 THEN r.scope_key = r.project_key WHEN 2 THEN r.scope_key = (SELECT p.unit_key FROM rd.dim_prompt p WHERE p.prompt_key = r.prompt_key)
                             ELSE r.scope_key = r.project_key END) FROM rd.citation r), NULL;

-- ── G-25 rd.answer 인용 수 열(DB-v2.2) ────────────────────────────────────────
-- 손 계산 근거: 호스트 있는 인용만(source_key <> 0), owner 브랜드·국가 = app.owned_base, 답변 국가 = rd.dim_country.
-- (k, case, cit_n, own_h, own_k, own_g, own_hc, own_kc, own_gc, own_x, loc, tgt, loc_tgt)
INSERT INTO _res
SELECT 'answer_cit', x.c,
       a.answer_key IS NOT NULL AND (a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g, a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x,
                                     a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
         IS NOT DISTINCT FROM (x.n::int2, x.h::int2, x.k2::int2, x.g::int2, x.hc::int2, x.kc::int2, x.gc::int2, x.cx::int2, x.lo::int2, x.tg::int2, x.lt::int2),
       format('actual=(n %s, own %s/%s/%s, c %s/%s/%s, x %s, loc %s, tgt %s, lt %s)', a.cit_n, a.cit_own_h, a.cit_own_k, a.cit_own_g,
              a.cit_own_hc, a.cit_own_kc, a.cit_own_gc, a.cit_own_x, a.cit_loc, a.cit_tgt, a.cit_loc_tgt)
  FROM (VALUES
    (1, '1 글로벌 US: 호스트 9(1.5 제외), 자사 H 2(1.1 AU·1.9 US)·K 1(1.10 국가 없음), 국가 일치 H 1, 교차 1(AU)', 9, 2, 1, 0, 1, 0, 0, 1, 0, 0, 0),
    (2, '2 인용 없음 → 전 열 0', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    (5, '5 경쟁사 공식 1건 → cit_n 1·자사 0(elig 거짓이어도 열은 채움)', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    (21, '21 웹 DE: kia.com/de 2건 국가 일치, loc 2(21.1·21.3)·tgt 1·loc∪tgt 2', 3, 0, 2, 0, 0, 2, 0, 0, 2, 1, 2),
    (22, '22 웹 DE: kia.com/de 1건, loc·tgt 같은 행', 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1),
    (31, '31 프로젝트 US: 카탈로그 base H 1(국가 일치), loc 3·tgt 1·loc∪tgt 4', 4, 1, 0, 0, 1, 0, 0, 0, 3, 1, 4)
  ) x(k, c, n, h, k2, g, hc, kc, gc, cx, lo, tg, lt)
  LEFT JOIN rd.answer a ON a.answer_key = x.k;
INSERT INTO _res SELECT 'answer_cit', '전수 단언 rd.assert_answer_cit_counts(NULL) = 서빙 답변 19',
       rd.assert_answer_cit_counts(NULL) = 19, NULL;
INSERT INTO _res SELECT 'answer_cit', '열 합 = 자식 호스트 인용 행 수(18) · owner 3사 행 수(5)',
       (SELECT (sum(cit_n), sum(cit_own_h + cit_own_k + cit_own_g)) FROM rd.answer)
         = (SELECT (count(*) FILTER (WHERE source_key <> 0), count(*) FILTER (WHERE source_key <> 0 AND owner_key <> 0)) FROM rd.citation)
       AND (SELECT sum(cit_n) FROM rd.answer) = 18,
       (SELECT format('%s/%s', sum(cit_n), sum(cit_own_h + cit_own_k + cit_own_g)) FROM rd.answer);
-- 음성 시험(쓰기는 예외 블록 안에서 되돌린다): CHECK 위반과 단언 위반이 실제로 막히는가
DO $n$ DECLARE ok_chk bool := false; ok_ass bool := false; BEGIN
  BEGIN
    UPDATE rd.answer SET cit_n = 0 WHERE answer_key = 1;              -- has_cit = true 인데 cit_n 0 → answer_cit_flags 위반
  EXCEPTION WHEN check_violation THEN ok_chk := true; END;
  BEGIN
    UPDATE rd.answer SET cit_own_x = 0 WHERE answer_key = 1;          -- CHECK 는 통과(0 ≤ 교차 상한), 자식 합과 불일치
    PERFORM rd.assert_answer_cit_counts(ARRAY[1]);
    RAISE EXCEPTION 'no_error';
  EXCEPTION WHEN raise_exception THEN ok_ass := SQLERRM LIKE '%G-25 불변식%'; END;
  INSERT INTO _res VALUES ('answer_cit', '음성: answer_cit_flags CHECK 가 불리언 불일치를 막음', ok_chk, NULL),
                          ('answer_cit', '음성: 단언 함수가 자식 합 불일치를 잡음(쓰기 되돌림)', ok_ass, NULL);
END $n$;
INSERT INTO _res SELECT 'answer_cit', '음성 시험 뒤 원값 유지(answer 1 cit_own_x = 1, cit_n = 9)',
       (SELECT (cit_own_x, cit_n) FROM rd.answer WHERE answer_key = 1) = (1::int2, 9::int2), NULL;
-- DB-v2.13 cit_off(글로벌 ⑤ 분자, 동기화 S1 BE-B): 열 합 = 출처 카테고리 Official (HMG) 자식 호스트 인용 행 수(9: k1 4 = hyundai.com·
-- hyundaiusa.com·kia.com·공식 소셜 linkedin, k21 3 = kia.com 2·kia.de, k22 1, k31 1 = hyundaiusa.com), 단언이 cit_off 불일치를 잡는다
INSERT INTO _res SELECT 'answer_cit', 'cit_off 합 = 공식(HMG) 카테고리 자식 호스트 인용 행 수(9, answer 1 = 4)',
       (SELECT sum(cit_off) FROM rd.answer)
         = (SELECT count(*) FROM rd.citation c JOIN rd.dim_source s ON s.source_key = c.source_key
              JOIN app.citation_category cc ON cc.category_key = s.category_key WHERE c.source_key <> 0 AND cc.name = 'Official (HMG)')
       AND (SELECT sum(cit_off) FROM rd.answer) = 9 AND (SELECT cit_off FROM rd.answer WHERE answer_key = 1) = 4,
       (SELECT format('%s', sum(cit_off)) FROM rd.answer);
DO $n$ DECLARE ok_ass bool := false; BEGIN
  BEGIN
    UPDATE rd.answer SET cit_off = 3 WHERE answer_key = 1;            -- CHECK 는 통과(0 ≤ cit_off ≤ cit_n), 자식 합과 불일치
    PERFORM rd.assert_answer_cit_counts(ARRAY[1]);
    RAISE EXCEPTION 'no_error';
  EXCEPTION WHEN raise_exception THEN ok_ass := SQLERRM LIKE '%G-25 불변식%'; END;
  INSERT INTO _res VALUES ('answer_cit', '음성: 단언 함수가 cit_off 불일치를 잡음(쓰기 되돌림, DB-v2.13)', ok_ass, NULL);
END $n$;

-- ── rd.cycle ───────────────────────────────────────────────────────────────
INSERT INTO _res
SELECT 'cycle', x.c, (c.status, c.servable, c.view_date, c.hidden_scope, c.hidden_reason, c.ledger_backed, c.gap_answers)
       IS NOT DISTINCT FROM (x.st::int2, x.sv, x.vd, x.hs::int2, x.hr::int2, x.lb, x.ga),
       format('actual=(%s,%s,%s,%s,%s,%s,%s)', c.status, c.servable, c.view_date, c.hidden_scope, c.hidden_reason, c.ledger_backed, c.gap_answers)
  FROM (VALUES (10, '10 발행 → servable, view = KST 날짜', 2, true, '2026-09-09'::date, 0, 0, true, 0),
               (11, '11 발행 + Q2 카운터 1:1', 2, true, '2026-09-16'::date, 0, 0, true, 3),
               (12, '12 open → 비서빙, view NULL', 0, false, NULL, 0, 0, true, NULL),
               (21, '21 인용 숨김(운영자) 코드', 2, true, '2026-09-19'::date, 2, 2, true, 0),
               (31, '31 프로젝트 가상 회차: 항상 servable, 앵커+1', 0, true, '2026-09-21'::date, 0, 0, false, NULL)) x(k, c, st, sv, vd, hs, hr, lb, ga)
  LEFT JOIN rd.cycle c ON c.cyc_key = x.k;

-- ── rd.dim_prompt·catalog_entry ────────────────────────────────────────────
INSERT INTO _res
SELECT 'dim_prompt', x.c, (p.in_root_catalog, p.cat_mask, p.kind, p.is_korean, p.web_reg, coalesce(w.file_seq, 0), t.code)
       IS NOT DISTINCT FROM (x.irc, x.cm::int2, x.kind, x.kor, x.web, x.fs, x.fun),
       format('actual=(%s,%s,%s,%s,%s,%s,%s)', p.in_root_catalog, p.cat_mask, p.kind, p.is_korean, p.web_reg, w.file_seq, t.code)
  FROM (VALUES ('b0000000-0000-4000-8000-000000000001'::uuid, 'SP1 카탈로그 두 행 비트 OR(1|4)', true, 5, 'single', false, false, 0, 'F1'),
               ('b0000000-0000-4000-8000-000000000002'::uuid, 'SP2 브랜드 없음 → 엄브렐러 비트(Q11)', true, 8, 'single', false, false, 0, 'F2'),
               ('b0000000-0000-4000-8000-000000000003'::uuid, 'SP3 ACR kind·HMG 엄브렐러', true, 8, 'acr', false, false, 0, 'F1'),
               ('b0000000-0000-4000-8000-000000000004'::uuid, 'SP4 한국어 판별', true, 1, 'single', true, false, 0, 'F1'),
               ('b0000000-0000-4000-8000-000000000005'::uuid, 'SP5 소프트삭제 카탈로그 행 → 카탈로그 밖(A4)', false, 0, 'single', false, false, 0, 'F1'),
               ('b0000000-0000-4000-8000-000000000021'::uuid, 'SW1 유닛 101·웹 등록', false, 0, 'single', false, true, 101, NULL),
               ('b0000000-0000-4000-8000-000000000023'::uuid, 'SW3 유닛 102', false, 0, 'single', false, true, 102, NULL)) x(pid, c, irc, cm, kind, kor, web, fs, fun)
  LEFT JOIN rd.dim_prompt p ON p.prompt_id = x.pid
  LEFT JOIN rd.web_unit w ON w.unit_key = p.unit_key
  LEFT JOIN rd.dim_taxon t ON t.taxon_key = p.funnel_key AND p.funnel_key <> 0;
INSERT INTO _res SELECT 'catalog_entry', '비삭제 루트 카탈로그 6행(삭제 1행 제외), brand_bit NULL→8',
       (SELECT count(*) FROM rd.catalog_entry) = 6 AND (SELECT brand_bit FROM rd.catalog_entry WHERE catalog_row_id = 'c1000000-0000-4000-8000-000000000002') = 8,
       (SELECT count(*) FROM rd.catalog_entry)::text;
INSERT INTO _res SELECT 'web_unit', '101: decl base kia.com/de, 형제 kia.com/de/sub, 공유 호스트 → home NULL, turls 2',
       (SELECT (base, base_src, sibs, home_host, cardinality(turls)) IS NOT DISTINCT FROM ('kia.com/de', 'decl', '{kia.com/de/sub}'::text[], NULL::text, 2)
          FROM rd.web_unit WHERE file_seq = 101), NULL;

-- ── ACR ────────────────────────────────────────────────────────────────────
INSERT INTO _res SELECT 'acr', 'acr_cell 501: 회차 11·acr_in·is_rep·측정일 KST',
       (SELECT (cyc_key, acr_in, is_rep, measured_date, valid_acr) IS NOT DISTINCT FROM (11, true, true, '2026-09-14'::date, 2::int2) FROM rd.acr_cell WHERE acr_cell_key = 501),
       (SELECT format('%s,%s,%s,%s', cyc_key, acr_in, is_rep, measured_date) FROM rd.acr_cell WHERE acr_cell_key = 501);
INSERT INTO _res SELECT 'acr', 'acr_cell_job: source_job_ids 3개 → answer_key 10·11·12',
       (SELECT array_agg(answer_key ORDER BY answer_key) FROM rd.acr_cell_job WHERE acr_cell_key = 501) = '{10,11,12}', NULL;
INSERT INTO _res
SELECT 'acr', x.c, (ch.own_bit, ch.name_own, ch.keep, b.bare) IS NOT DISTINCT FROM (x.ob::int2, x.no::int2, x.keep, x.bare),
       format('actual=(%s,%s,%s,%s)', ch.own_bit, ch.name_own, ch.keep, b.bare)
  FROM (VALUES ('00000000-0000-0000-0000-000000000301'::uuid, 'choice Hyundai 자사(acrIsOurs)', 1, 1, true, 'hyundai'),
               ('71000000-0000-4000-8000-000000000001'::uuid, 'choice Toyota 경쟁', 0, 0, true, 'toyota'),
               ('71000000-0000-4000-8000-000000000003'::uuid, 'choice Apple keep 거짓(비경쟁)', 0, 0, false, 'apple')) x(e, c, ob, no, keep, bare)
  JOIN rd.dim_entity de ON de.entity_id = x.e
  LEFT JOIN rd.acr_choice ch ON ch.acr_cell_key = 501 AND ch.entity_key = de.entity_key AND ch.level = 1
  LEFT JOIN rd.dim_brand_name b ON b.brand_key = ch.brand_key;

-- ── 발행값 ─────────────────────────────────────────────────────────────────
INSERT INTO _res SELECT 'report_unit_value', '(2026-09-18, 101) → website 회차 21',
       (SELECT cyc_key FROM rd.report_unit_value WHERE round_date = '2026-09-18' AND file_seq = 101) = 21, NULL;
INSERT INTO _res SELECT 'report_unit_value', '발행 유닛 4행(101·102 웹 유닛 있음 → 회차 21, 301 FR·401 Hyundai 웹 유닛 없음 → 회차 NULL)',
       (SELECT array_agg(file_seq::text || ':' || coalesce(cyc_key::text, '-') ORDER BY file_seq) FROM rd.report_unit_value WHERE round_date = '2026-09-18')
         = '{101:21,102:21,301:-,401:-}'::text[],
       (SELECT array_agg(file_seq::text || ':' || coalesce(cyc_key::text, '-') ORDER BY file_seq)::text FROM rd.report_unit_value WHERE round_date = '2026-09-18');
INSERT INTO _res SELECT 'report_unit_value', '2026-09-25 발행: 가상 지역 SA-Dammam 국가 코드 원표기 보존·dim_country 에 pseudo 로 존재',
       (SELECT (v.country_code, g.kind) FROM rd.report_unit_value v JOIN rd.dim_country g ON upper(g.code) = upper(v.country_code)
         WHERE v.round_date = '2026-09-25' AND v.file_seq = 102) = ('SA-Dammam'::text, 'pseudo'::text), NULL;

SELECT grp, case_name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, CASE WHEN ok THEN NULL ELSE detail END AS detail
  FROM _res ORDER BY ok, grp, case_name;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok OR ok IS NULL) AS fail, count(*) AS total FROM _res;
