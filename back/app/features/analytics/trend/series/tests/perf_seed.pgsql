-- 성능 라운드(A1~A3) 동치 테스트 준비(소유자, 롤백 전용). 회차 복사(9101~9104, 회차 11 복사)는 test_perf_equiv 가 staged.NewCycle 로 먼저 넣는다.
-- 1) rd.job: 복사 회차 답변마다 측정 시각을 여러 KST 날짜로 흩는다(UTC 07·15·23시 = KST 16시·다음날 0시·다음날 8시), 일부 NULL, 일부 비서빙.
INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key,
                    lang_key, bgrp, status_code, analysis_code, dropped, served, load_id)
SELECT a.answer_key, gen_random_uuid(), a.run_key, a.prompt_key, a.cyc_key, a.round_date,
       CASE WHEN a.answer_key % 7 = 0 THEN NULL
            ELSE (a.round_date + (a.answer_key % 4) * interval '1 day' + ((a.answer_key % 3) * 8 + 7) * interval '1 hour') AT TIME ZONE 'UTC' END,
       a.surface, a.project_key, a.engine_key, a.geo_key, a.lang_key, a.bgrp,
       CASE WHEN a.answer_key % 11 = 0 THEN 2 ELSE 0 END, 0, false, a.answer_key % 11 <> 0, 1
  FROM rd.answer a
 WHERE a.cyc_key IN (9101, 9102, 9103, 9104)
   AND NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = a.answer_key);

-- 2) 순위 경계 동률용 출처(lc_key 1·2·3차 키, 밑줄·숫자·대소문자·악센트, 같은 도메인 두 키) + 출처 차원에 없는 출처(9999)
INSERT INTO rd.dim_source (source_key, skey, domain, is_social, category_key, category_src, owned_brand_bit, competitor_brand_key, rule_ver) VALUES
 (9201, 'reddit-alt.test', 'Reddit.com', false, 6, 1, 0, NULL, 1),
 (9202, 'reddit-acc.test', 'réddit.com', false, 6, 1, 0, NULL, 1),
 (9203, 'under.test', '_under.com', false, 8, 1, 0, NULL, 1),
 (9204, 'num.test', '1num.com', false, 8, 1, 0, NULL, 1),
 (9205, 'zeta.test', 'Zeta.com', false, 9, 1, 0, NULL, 1),
 (9206, 'alpha1.test', 'alpha.com', false, 9, 1, 0, NULL, 1),
 (9207, 'alpha2.test', 'ALPHA.com', false, 10, 1, 0, NULL, 1),
 (9208, 'alpha3.test', 'Älpha.com', false, 10, 1, 0, NULL, 1),
 (9209, 'dup1.test', 'dup.com', false, 12, 1, 0, NULL, 1),
 (9210, 'dup2.test', 'dup.com', false, 12, 1, 0, NULL, 1);

-- 3) 운영자 카테고리 오버라이드(유효 카테고리 = 오버라이드 우선): reddit.com 6 → 5, zeta.test 9 → 3
INSERT INTO app.citation_domain_override (domain, category_key) VALUES ('reddit.com', 5), ('zeta.test', 3);

-- 4) 새 출처 인용: 복사 회차의 인용 모수 답변(첫 행)을 틀로 (회차, 출처, 개수)만큼. ord 는 100 부터 답변 안에서 유일.
--    창 합계: Reddit.com 8·réddit.com 8(= reddit.com 8 동률), _under·1num·Zeta·alpha·ALPHA·Älpha 4(= 기존 출처 4 동률), dup 2·1, 9999 20.
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
SELECT t.round_date, t.answer_key, t.url_key, v.source_key, t.cyc_key, t.prompt_key, t.surface,
       99 + row_number() OVER (PARTITION BY t.answer_key ORDER BY v.source_key, g.n),
       t.project_key, t.engine_key, t.geo_key, t.lang_key, t.bgrp, t.scope_key, t.owner_key, t.cit_in, t.gap, t.dflt, t.loc_owned, t.tgt_hit,
       t.src_first, t.rule_ver
  FROM (VALUES (9201, 9104, 5), (9201, 9103, 3), (9202, 9104, 8), (9203, 9104, 4), (9204, 9103, 4), (9205, 9104, 2), (9205, 9102, 2),
               (9206, 9104, 4), (9207, 9104, 4), (9208, 9104, 4), (9209, 9104, 2), (9210, 9104, 1), (9999, 9104, 20)) v(source_key, cyc, n)
  JOIN LATERAL (SELECT c.* FROM rd.citation c WHERE c.surface = 1 AND c.cyc_key = v.cyc AND c.cit_in ORDER BY c.answer_key, c.ord LIMIT 1) t ON true
  CROSS JOIN LATERAL generate_series(1, v.n) g(n);
