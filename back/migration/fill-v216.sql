-- ============================================================================
-- 1회 채우기: DB-v2.16 P91~P93(WEBREG16 웹 보고서 유닛 게이트, WU-7). 이 파일은 back/migration/gen_fill_v216.py 가 만든다(손으로 고치지 않는다).
-- 원천: front/scripts/reports/report-spec.json sha256 3a7522ff7233eec7… (109행) · 제외 유닛 = 운영 summary_settings.website_excluded_fs [71, 94, 97].
-- 무엇을: ① app.website_report_unit = 명세 행(값이 다른 행만, 명세에 없는 ix 는 지운다) ② app.website_report_excluded = 제외 유닛
--   ③ rd.refresh_web_report_prompt(NULL)(웹 프롬프트 전체, 바뀐 행만) ④ rd.assert_web_report_prompt().
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT). 롤 = migrator(app 두 표 쓰기 권한은 DB-v2.16).
--   psql -X -v ON_ERROR_STOP=1 -f fill-v216.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v216.sql
-- 뒤처리 없음: 세 표가 결과 캐시 추적 표라 바뀐 행이 있으면 데이터 버전이 오른다. 스위치 web_registered_only 를 켜기 전에 돌린다.
-- 규모: 웹 프롬프트 약 1.3만·명세 109행, 전체 판정 약 35ms(stg hmg_r2 2026-10-01 EXPLAIN ANALYZE). 출력 = 개수만.
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '10min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regprocedure('rd.refresh_web_report_prompt(int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.16 가 먼저 적용돼야 한다(rd.refresh_web_report_prompt 없음)';
  END IF;
END $v$;
CREATE TEMP TABLE _v216_unit (ix int2 PRIMARY KEY, brand_code text, country_code text, lang_code text, url_like text, url_not_like text,
                              spec_fs int) ON COMMIT DROP;
INSERT INTO _v216_unit VALUES
  (0, 'Hyundai', 'MX', 'es', NULL, NULL, 1),
  (1, 'Hyundai', 'US', 'en', NULL, NULL, 2),
  (2, 'Hyundai', 'CA', 'en', NULL, NULL, 3),
  (3, 'Hyundai', 'CA', 'fr', NULL, NULL, 4),
  (4, 'Hyundai', 'KR', 'ko', NULL, 'hyundai-n.com%', 5),
  (5, 'Hyundai', 'IN', 'en', NULL, NULL, 6),
  (6, 'Hyundai', 'JP', 'ja', NULL, NULL, 7),
  (7, 'Hyundai', 'CN', 'zh', NULL, NULL, 8),
  (8, 'Hyundai', 'AU', 'en', NULL, NULL, 9),
  (9, 'Hyundai', 'NL', 'nl', NULL, NULL, 11),
  (10, 'Hyundai', 'NO', 'no', NULL, NULL, 12),
  (11, 'Hyundai', 'EU', 'en', NULL, NULL, 14),
  (12, 'Hyundai', 'DE', 'de', NULL, NULL, 15),
  (13, 'Hyundai', 'SE', 'sv', NULL, NULL, 22),
  (14, 'Hyundai', 'ES', 'es', NULL, NULL, 23),
  (15, 'Hyundai', 'SK', 'sk', NULL, NULL, 24),
  (16, 'Hyundai', 'GB', 'en', NULL, NULL, 27),
  (17, 'Hyundai', 'IT', 'it', NULL, NULL, 29),
  (18, 'Hyundai', 'CZ', 'cs', NULL, NULL, 30),
  (19, 'Hyundai', 'TR', 'tr', NULL, NULL, 32),
  (20, 'Hyundai', 'PL', 'pl', NULL, NULL, 34),
  (21, 'Hyundai', 'FR', 'fr', NULL, NULL, 35),
  (22, 'Hyundai', 'CL', 'es', NULL, NULL, 38),
  (23, 'Hyundai', 'BR', 'pt', NULL, NULL, 39),
  (24, 'Hyundai N', 'KR', 'ko', NULL, NULL, 40),
  (25, 'Hyundai N', 'worldwide', 'en', NULL, NULL, 41),
  (26, 'Hyundai', 'worldwide', 'en', NULL, 'hyundai-n.com%', 41),
  (27, 'Hyundai', 'worldwide', 'ko', NULL, 'hyundai-n.com%', 42),
  (28, 'Genesis', 'CA', 'en', NULL, NULL, 45),
  (29, 'Genesis', 'CA', 'fr', NULL, NULL, 46),
  (30, 'Genesis', 'KR', 'ko', NULL, NULL, 47),
  (31, 'Genesis', 'MIDDLEEAST', 'ar', NULL, NULL, 48),
  (32, 'Genesis', 'CN', 'zh', NULL, NULL, 49),
  (33, 'Genesis', 'AU', 'en', NULL, NULL, 50),
  (34, 'Genesis', 'DE', 'de', NULL, NULL, 51),
  (35, 'Genesis', 'GB', 'en', NULL, NULL, 52),
  (36, 'Genesis', 'IT', 'it', NULL, NULL, 53),
  (37, 'Genesis', 'CH', 'fr', NULL, NULL, 54),
  (38, 'Genesis', 'worldwide', 'en', NULL, NULL, 56),
  (39, 'Kia', 'MX', 'es', NULL, NULL, 59),
  (40, 'Kia', 'US', 'en', NULL, NULL, 60),
  (41, 'Kia', 'US', 'es', NULL, NULL, 61),
  (42, 'Kia', 'CA', 'en', NULL, NULL, 63),
  (43, 'Kia', 'CA', 'fr', NULL, NULL, 64),
  (44, 'Kia', 'TW', 'zh', NULL, NULL, 65),
  (45, 'Kia', 'KR', 'ko', NULL, NULL, 66),
  (46, 'Kia', 'IN', 'en', NULL, NULL, 69),
  (47, 'Kia', 'ID', 'id', NULL, NULL, 70),
  (48, 'Kia', 'CN', 'zh', NULL, NULL, 71),
  (49, 'Kia', 'TH', 'th', NULL, NULL, 72),
  (50, 'Kia', 'AU', 'en', NULL, NULL, 73),
  (51, 'Kia', 'GR', 'el', NULL, 'kia.com/eu%', 74),
  (52, 'Kia', 'NL', 'nl', NULL, NULL, 75),
  (53, 'Kia', 'NO', 'no', NULL, NULL, 76),
  (54, 'Kia', 'DK', 'da', NULL, NULL, 77),
  (55, 'Kia', 'DE', 'de', NULL, NULL, 78),
  (56, 'Kia', 'SE', 'sv', NULL, NULL, 86),
  (57, 'Kia', 'ES', 'es', NULL, NULL, 87),
  (58, 'Kia', 'SK', 'sk', NULL, NULL, 88),
  (59, 'Kia', 'EE', 'et', NULL, NULL, 91),
  (60, 'Kia', 'GB', 'en', NULL, NULL, 92),
  (61, 'Kia', 'UA', 'uk', NULL, NULL, 94),
  (62, 'Kia', 'IT', 'it', NULL, NULL, 95),
  (63, 'Kia', 'CZ', 'cs', NULL, NULL, 96),
  (64, 'Kia', 'KZ', 'ru', NULL, NULL, 97),
  (65, 'Kia', 'TR', 'tr', NULL, NULL, 99),
  (66, 'Kia', 'PL', 'pl', NULL, NULL, 101),
  (67, 'Kia', 'FR', 'fr', NULL, NULL, 102),
  (68, 'Kia', 'FI', 'fi', NULL, NULL, 103),
  (69, 'Kia', 'HU', 'hu', NULL, NULL, 104),
  (70, 'Kia', 'IL', 'he', NULL, NULL, 106),
  (71, 'Kia', 'worldwide', 'ko', NULL, NULL, 107),
  (72, 'Kia', 'worldwide', 'en', NULL, NULL, 108),
  (73, 'Hyundai', 'CPO', 'ko', NULL, NULL, 109),
  (74, 'Genesis', 'BH', 'en', NULL, NULL, 110),
  (75, 'Genesis', 'KW', 'en', NULL, NULL, 111),
  (76, 'Genesis', 'OM', 'en', NULL, NULL, 112),
  (77, 'Genesis', 'QA', 'en', NULL, NULL, 113),
  (78, 'Genesis', 'SA-Dammam', 'en', 'genesis.com/sa-dammam%', NULL, 114),
  (79, 'Genesis', 'MIDDLEEAST', 'en', NULL, NULL, 115),
  (80, 'Genesis', 'SA-Jeddah', 'en', 'genesis.com/sa-jeddah%', NULL, 116),
  (81, 'Genesis', 'SA-Riyadh', 'en', 'genesis.com/sa-riyadh%', NULL, 117),
  (82, 'Genesis', 'AE', 'en', NULL, NULL, 118),
  (83, 'Hyundai', 'ID', 'en', NULL, NULL, 119),
  (84, 'Hyundai', 'ID', 'id', NULL, NULL, 120),
  (85, 'Hyundai', 'MY', 'en', NULL, NULL, 121),
  (86, 'Hyundai', 'TH', 'en', NULL, NULL, 122),
  (87, 'Hyundai', 'TH', 'th', NULL, NULL, 123),
  (88, 'Hyundai', 'PH', 'en', NULL, NULL, 124),
  (89, 'Hyundai', 'PE', 'es', NULL, NULL, 125),
  (90, 'Hyundai', 'PR', 'es', NULL, NULL, 126),
  (91, 'Hyundai', 'CO', 'es', NULL, NULL, 127),
  (92, 'Hyundai', 'MIDDLEEAST', 'en', NULL, NULL, 128),
  (93, 'Hyundai', 'MIDDLEEAST', 'ar', NULL, NULL, 129),
  (94, 'Hyundai', 'SA', 'ar', NULL, NULL, 130),
  (95, 'Hyundai', 'SA', 'en', NULL, NULL, 131),
  (96, 'Kia', 'AT', 'de', NULL, NULL, 132),
  (97, 'Kia', 'BE', 'fr', NULL, NULL, 133),
  (98, 'Kia', 'IE', 'en', NULL, NULL, 134),
  (99, 'Kia', 'IS', 'is', NULL, NULL, 135),
  (100, 'Kia', 'MT', 'en', NULL, NULL, 136),
  (101, 'Kia', 'MY', 'en', NULL, NULL, 137),
  (102, 'Kia', 'VN', 'vi', NULL, NULL, 138),
  (103, 'Genesis', 'FR', 'fr', NULL, NULL, 139),
  (104, 'Genesis', 'NL', 'nl', NULL, NULL, 140),
  (105, 'Kia', 'BE', 'nl', NULL, NULL, 141),
  (106, 'Kia', 'SG', 'en', NULL, NULL, 142),
  (107, 'Hyundai', 'CN-BJ', 'zh', NULL, NULL, 143),
  (108, 'Kia', 'PH', 'en', NULL, NULL, 144);
CREATE TEMP TABLE _v216_excl (file_seq int PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _v216_excl VALUES (71), (94), (97);
SELECT 'unit_upsert' AS step, count(*) AS n FROM _v216_unit s LEFT JOIN app.website_report_unit u ON u.ix = s.ix
 WHERE (u.brand_code, u.country_code, u.lang_code, u.url_like, u.url_not_like, u.spec_fs)
       IS DISTINCT FROM (s.brand_code, s.country_code, s.lang_code, s.url_like, s.url_not_like, s.spec_fs)
UNION ALL SELECT 'unit_delete', count(*) FROM app.website_report_unit u WHERE NOT EXISTS (SELECT 1 FROM _v216_unit s WHERE s.ix = u.ix)
UNION ALL SELECT 'excluded_insert', count(*) FROM _v216_excl x WHERE NOT EXISTS (SELECT 1 FROM app.website_report_excluded e WHERE e.file_seq = x.file_seq)
UNION ALL SELECT 'excluded_delete', count(*) FROM app.website_report_excluded e WHERE NOT EXISTS (SELECT 1 FROM _v216_excl x WHERE x.file_seq = e.file_seq);
INSERT INTO app.website_report_unit AS u (ix, brand_code, country_code, lang_code, url_like, url_not_like, spec_fs)
SELECT * FROM _v216_unit
ON CONFLICT (ix) DO UPDATE SET brand_code = EXCLUDED.brand_code, country_code = EXCLUDED.country_code, lang_code = EXCLUDED.lang_code,
       url_like = EXCLUDED.url_like, url_not_like = EXCLUDED.url_not_like, spec_fs = EXCLUDED.spec_fs
 WHERE (u.brand_code, u.country_code, u.lang_code, u.url_like, u.url_not_like, u.spec_fs)
       IS DISTINCT FROM (EXCLUDED.brand_code, EXCLUDED.country_code, EXCLUDED.lang_code, EXCLUDED.url_like, EXCLUDED.url_not_like, EXCLUDED.spec_fs);
DELETE FROM app.website_report_unit u WHERE NOT EXISTS (SELECT 1 FROM _v216_unit s WHERE s.ix = u.ix);
INSERT INTO app.website_report_excluded (file_seq) SELECT file_seq FROM _v216_excl ON CONFLICT (file_seq) DO NOTHING;
DELETE FROM app.website_report_excluded e WHERE NOT EXISTS (SELECT 1 FROM _v216_excl x WHERE x.file_seq = e.file_seq);
SELECT 'prompt_refresh' AS step, rd.refresh_web_report_prompt(NULL) AS n;
SELECT 'prompt_assert' AS step, rd.assert_web_report_prompt() AS n;
SELECT 'prompt_excluded' AS step, count(*) AS n FROM rd.web_report_prompt w JOIN app.website_report_excluded e ON e.file_seq = w.report_fs;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
