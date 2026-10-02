-- ============================================================================
-- seed-10-app.sql : mig_src(현행 미러 원본 스테이지) → app.* 이관 + 판정 규칙 정본 시드
-- 생성: seed/gen_seed10.py (현행 코드 hmg-geo 2670a16 상수를 tsx 로 import 해 덤프, 손으로 옮겨 적지 않음. 동기화 S1: 7639b9e 덤프의
--   코드 유래 키 owned·root_home·shared_hosts·hidden_regions 를 dump-owned.ts 로 2670a16 에서 다시 뽑았고, 나머지 키의 원천 파일은 두 커밋에서 같다)
-- 재실행 가능: 트랜잭션 1개. 데이터 표는 TRUNCATE 후 INSERT…SELECT, rd 가 FK 로 참조하는 규칙 표
--   (app.brand·app.citation_category·app.owned_base)와 app.user_account 는 UPSERT(키 보존).
-- 트리거 결정: app.prompt 의 prompt_catalog_change(AFTER INSERT) 는 이관 동안 끈다.
--   이유: 시드는 사용자 편집이 아니다. 켜 두면 행마다 prompt_audit_log 'created' 합성 이력(이관한 실제 이력과 중복)과
--   judgment_change('catalog') 요청이 수천 건 생겨 적재기가 이미 시드한 카탈로그를 전부 재판정하게 된다.
--   그 밖의 트리거(app.project AFTER UPDATE, 감사 append-only)는 INSERT·TRUNCATE 에 반응하지 않으므로 그대로 둔다.
--   행위자 GUC(app.actor_id = 시스템 사용자, app.actor_type = system)는 안전망으로 함께 건다.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
\set VERBOSITY terse
\timing on
\ir seed-00-fn.sql
BEGIN;
SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = 0;
SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001';
SET LOCAL app.actor_type = 'system';

-- ── 0. 시스템 사용자(합성 1행) ────────────────────────────────────────────
-- profiles 는 이관 대상이 아니다. FK 가 요구하는 자리(app.project.created_by 등)만 이 사용자로 채운다.
-- FK 없는 uuid 열(prompt.created_by·updated_by, 감사 로그 actor_id 등)은 원본 값을 그대로 보존한다(추후 profiles 이관 시 연결).
-- status 'suspended': 로그인 계정이 아니라 귀속 전용임을 표시. .invalid 도메인(RFC 2606)이라 실제 메일 소유자가 없다.
INSERT INTO app.user_account (user_id, email, display_name, role, operator, scope_all, status)
VALUES ('5eed0000-0000-4000-8000-000000000001', 'system+mirror-seed@hmg-geo.invalid', '시스템(이관 시드)', 'admin', 'none', true, 'suspended')
ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role,
  operator = EXCLUDED.operator, scope_all = EXCLUDED.scope_all, status = EXCLUDED.status;

-- ── 1. rd 가 FK 로 참조하는 규칙 표: UPSERT(키 보존) ─────────────────────────
-- 1-1. app.brand : HMG_BRANDS lib/scope/hmg-brands.ts:22, 합성 고정 UUID hmg-brands.ts:25-29,
--      비트 = DB-v2.1.sql:12 (1 H, 2 K, 4 G, 8 HMG, 16 Hyundai N), 엄브렐러 HMG = lib/scope/brand-presence.ts:17,
--      Hyundai N 사이트 = lib/scope/website-virtual-geo.ts:4·24(website_sites.brand='Hyundai N'), 부모 = Hyundai(DB-앱-도메인 설계).
--      is_hmg_own = 당사 3사 + N (DB-앱-도메인.json app.brand 절). HMG 는 엄브렐러라 false.
INSERT INTO app.brand (brand_code, brand_bit, is_umbrella, is_hmg_own, parent_brand_code, canonical_entity_id, sort_order) VALUES
  ('Hyundai', 1, false, true, NULL, '00000000-0000-0000-0000-000000000301'::uuid, 1),
  ('Kia', 2, false, true, NULL, '00000000-0000-0000-0000-000000000302'::uuid, 2),
  ('Genesis', 4, false, true, NULL, '00000000-0000-0000-0000-000000000304'::uuid, 3),
  ('HMG', 8, true, false, NULL, NULL, 4),
  ('Hyundai N', 16, false, true, 'Hyundai', NULL, 5)
ON CONFLICT (brand_code) DO UPDATE SET brand_bit = EXCLUDED.brand_bit, is_umbrella = EXCLUDED.is_umbrella, is_hmg_own = EXCLUDED.is_hmg_own,
  parent_brand_code = EXCLUDED.parent_brand_code, canonical_entity_id = EXCLUDED.canonical_entity_id, sort_order = EXCLUDED.sort_order;
DELETE FROM app.brand WHERE brand_code NOT IN ('Hyundai', 'Kia', 'Genesis', 'HMG', 'Hyundai N');

-- 1-2. app.citation_category : CITATION_CATEGORIES lib/citation-categorizer/taxonomy.ts:10, 슬러그 :59. 키 = 코드 배열 순번(1..13).
INSERT INTO app.citation_category (category_key, name, slug, ord) VALUES
  (1, 'Official (HMG)', 'officialHmg', 1),
  (2, 'Official (Competitor)', 'officialCompetitor', 2),
  (3, 'Dealer & Marketplace', 'dealerMarketplace', 3),
  (4, 'Automotive Media', 'automotiveMedia', 4),
  (5, 'News & Media', 'newsMedia', 5),
  (6, 'Community & Forums', 'communityForums', 6),
  (7, 'Social & Video', 'socialVideo', 7),
  (8, 'Blogs & Reviews', 'blogsReviews', 8),
  (9, 'Wiki & Reference', 'wikiReference', 9),
  (10, 'Government & Public', 'governmentPublic', 10),
  (11, 'Award & Certification', 'awardCertification', 11),
  (12, 'Academic & Research', 'academicResearch', 12),
  (13, 'Other', 'other', 13)
ON CONFLICT (category_key) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, ord = EXCLUDED.ord;
DELETE FROM app.citation_category WHERE category_key > 13;

-- 1-3. app.owned_base : GEO_OWNED_BASES lib/geo-catalog/owned.ts:227 (EXCLUDED_OWNED_DOMAINS :42, OWNED_BASE_URL_FIXES :83,
--      ownedBasePrefixFromUrl :157 적용 후 값), 170행 = kind 'base'. OWNED_BASE_URL_FIXES 7건 중 5건(kia.com/au·it·tr·my, hyundai.com/cz)은
--      2670a16(#313)에서 국가 경로로 줄었다(동기화 S1 BE-3). 옛 접두 행이 있는 DB 에서 이 시드를 다시 돌리면 새 키 + 옛 행 DELETE 가 되어
--      rd.dim_url.owner_key FK 에 막힌다 → 이미 적재된 DB 는 back/migration/fix-sync-s1-rules.sql(제자리 UPDATE, 키 보존)을 먼저 돌린다.
--      kind 'root_home' = 사이트 루트 홈 규칙(isSiteRootHome :181, SHARED_GLOBAL_HOSTS :173 제외): 공유 글로벌 호스트가 아닌
--      호스트마다 1행, prefix = 호스트, 귀속 브랜드·국가·언어 = ownedBaseEntryForUrl('https://'+host) 결과(같은 호스트의 가장 짧은 base, :244-247).
--      geo_code = geoCountryCode(e.country)(lib/geo-catalog/index.ts), 카탈로그에 ISO 가 없으면 NULL.
--      owner_key: 기존 (kind, prefix) 행은 키 보존, 새 행만 max+1 부터(rd.dim_url.owner_key FK 보호). 0 은 '없음' 예약이라 쓰지 않는다.
CREATE TEMP TABLE _ob (kind text, prefix text, host text, brand_code text, geo_code text, language text, ord int) ON COMMIT DROP;
INSERT INTO _ob VALUES
  ('base', 'hyundai.com.mx', 'hyundai.com.mx', 'Hyundai', 'MX', 'es', 0),
  ('base', 'hyundaiusa.com/us/en', 'hyundaiusa.com', 'Hyundai', 'US', 'en', 1),
  ('base', 'hyundaicanada.com', 'hyundaicanada.com', 'Hyundai', 'CA', 'en', 2),
  ('base', 'hyundaicanada.com/fr', 'hyundaicanada.com', 'Hyundai', 'CA', 'fr', 3),
  ('base', 'hyundai.com/kr/ko', 'hyundai.com', 'Hyundai', 'KR', 'ko', 4),
  ('base', 'hyundai.com/in/en', 'hyundai.com', 'Hyundai', 'IN', 'en', 5),
  ('base', 'hyundai.com/jp', 'hyundai.com', 'Hyundai', 'JP', 'ja', 6),
  ('base', 'hyundai.com.cn', 'hyundai.com.cn', 'Hyundai', 'CN', 'zh', 7),
  ('base', 'hyundai.com/au/en', 'hyundai.com', 'Hyundai', 'AU', 'en', 8),
  ('base', 'hyundai.gr', 'hyundai.gr', 'Hyundai', 'GR', 'el', 9),
  ('base', 'hyundai.com/nl/nl', 'hyundai.com', 'Hyundai', 'NL', 'nl', 10),
  ('base', 'hyundai.com/no/no', 'hyundai.com', 'Hyundai', 'NO', 'no', 11),
  ('base', 'hyundai.dk', 'hyundai.dk', 'Hyundai', 'DK', 'da', 12),
  ('base', 'hyundai.com/eu/en', 'hyundai.com', 'Hyundai', 'DE', 'en', 13),
  ('base', 'hyundai.com/de/de', 'hyundai.com', 'Hyundai', 'DE', 'de', 14),
  ('base', 'hyundai.lv', 'hyundai.lv', 'Hyundai', 'LV', 'lv', 15),
  ('base', 'hyundai.ru', 'hyundai.ru', 'Hyundai', 'RU', 'ru', 16),
  ('base', 'hyundai.lt', 'hyundai.lt', 'Hyundai', 'LT', 'lt', 17),
  ('base', 'hyundai.ba', 'hyundai.ba', 'Hyundai', 'BA', 'bs', 18),
  ('base', 'hyundai.bg', 'hyundai.bg', 'Hyundai', 'BG', 'bg', 19),
  ('base', 'hyundai.rs', 'hyundai.rs', 'Hyundai', 'RS', 'sr', 20),
  ('base', 'hyundai.com/se/sv', 'hyundai.com', 'Hyundai', 'SE', 'sv', 21),
  ('base', 'hyundai.com/es/es', 'hyundai.com', 'Hyundai', 'ES', 'es', 22),
  ('base', 'hyundai.com/sk/sk', 'hyundai.com', 'Hyundai', 'SK', 'sk', 23),
  ('base', 'hyundai.si', 'hyundai.si', 'Hyundai', 'SI', 'sl', 24),
  ('base', 'hyundai.ee', 'hyundai.ee', 'Hyundai', 'EE', 'et', 25),
  ('base', 'hyundai.com/uk/en', 'hyundai.com', 'Hyundai', 'GB', 'en', 26),
  ('base', 'hyundai.com.ua', 'hyundai.com.ua', 'Hyundai', 'UA', 'uk', 27),
  ('base', 'hyundai.com/it/it', 'hyundai.com', 'Hyundai', 'IT', 'it', 28),
  ('base', 'hyundai.com/cz', 'hyundai.com', 'Hyundai', 'CZ', 'cs', 29),
  ('base', 'hyundai.hr', 'hyundai.hr', 'Hyundai', 'HR', 'hr', 30),
  ('base', 'hyundai.com/tr/tr', 'hyundai.com', 'Hyundai', 'TR', 'tr', 31),
  ('base', 'hyundai.pt', 'hyundai.pt', 'Hyundai', 'PT', 'pt', 32),
  ('base', 'hyundai.com/pl/pl', 'hyundai.com', 'Hyundai', 'PL', 'pl', 33),
  ('base', 'hyundai.com/fr/fr', 'hyundai.com', 'Hyundai', 'FR', 'fr', 34),
  ('base', 'hyundai.fi', 'hyundai.fi', 'Hyundai', 'FI', 'fi', 35),
  ('base', 'hyundai.hu', 'hyundai.hu', 'Hyundai', 'HU', 'hu', 36),
  ('base', 'hyundai.cl', 'hyundai.cl', 'Hyundai', 'CL', 'es', 37),
  ('base', 'hyundai.com.br', 'hyundai.com.br', 'Hyundai', 'BR', 'pt', 38),
  ('base', 'hyundai-n.com/ko', 'hyundai-n.com', 'Hyundai', NULL, 'ko', 39),
  ('base', 'hyundai-n.com', 'hyundai-n.com', 'Hyundai', NULL, 'en', 40),
  ('base', 'hyundai.com/worldwide/ko', 'hyundai.com', 'Hyundai', NULL, 'ko', 41),
  ('base', 'hyundai.com/worldwide/en', 'hyundai.com', 'Hyundai', NULL, 'en', 42),
  ('base', 'genesis.com/us/en', 'genesis.com', 'Genesis', 'US', 'en', 43),
  ('base', 'genesis.com/ca/en', 'genesis.com', 'Genesis', 'CA', 'en', 44),
  ('base', 'genesis.com/ca/fr', 'genesis.com', 'Genesis', 'CA', 'fr', 45),
  ('base', 'genesis.com/kr/ko', 'genesis.com', 'Genesis', 'KR', 'ko', 46),
  ('base', 'genesis.com/middleeast/ar', 'genesis.com', 'Genesis', 'AE', 'ar', 47),
  ('base', 'genesis.com.cn/zh', 'genesis.com.cn', 'Genesis', 'CN', 'zh', 48),
  ('base', 'genesis.com/au/en', 'genesis.com', 'Genesis', 'AU', 'en', 49),
  ('base', 'genesis.com/de/de', 'genesis.com', 'Genesis', 'DE', 'de', 50),
  ('base', 'genesis.com/uk/en', 'genesis.com', 'Genesis', 'GB', 'en', 51),
  ('base', 'genesis.com/it/it', 'genesis.com', 'Genesis', 'IT', 'it', 52),
  ('base', 'genesis.com/ch/fr', 'genesis.com', 'Genesis', 'FR', 'fr', 53),
  ('base', 'genesis.com/ru/ru', 'genesis.com', 'Genesis', 'RU', 'ru', 54),
  ('base', 'genesis.com/worldwide/en', 'genesis.com', 'Genesis', NULL, 'en', 55),
  ('base', 'kia.cl', 'kia.cl', 'Kia', 'CL', 'es', 56),
  ('base', 'kia.com/mx', 'kia.com', 'Kia', 'MX', 'es', 57),
  ('base', 'kia.com/us/en', 'kia.com', 'Kia', 'US', 'en', 58),
  ('base', 'kia.com/us/es', 'kia.com', 'Kia', 'US', 'es', 59),
  ('base', 'kia.com/us/ko', 'kia.com', 'Kia', 'US', 'ko', 60),
  ('base', 'kia.ca', 'kia.ca', 'Kia', 'CA', 'en', 61),
  ('base', 'kia.ca/fr', 'kia.ca', 'Kia', 'CA', 'fr', 62),
  ('base', 'kia.com/tw', 'kia.com', 'Kia', 'TW', 'zh', 63),
  ('base', 'kia.com/kr', 'kia.com', 'Kia', 'KR', 'ko', 64),
  ('base', 'kia.com.mm', 'kia.com.mm', 'Kia', 'MM', 'en', 65),
  ('base', 'kia.com/jp/ja', 'kia.com', 'Kia', 'JP', 'ja', 66),
  ('base', 'kia.com/in', 'kia.com', 'Kia', 'IN', 'en', 67),
  ('base', 'kia.com/id/id', 'kia.com', 'Kia', 'ID', 'id', 68),
  ('base', 'kia.com/th/th', 'kia.com', 'Kia', 'TH', 'th', 69),
  ('base', 'kia.com/au', 'kia.com', 'Kia', 'AU', 'en', 70),
  ('base', 'kia.com/gr', 'kia.com', 'Kia', 'GR', 'el', 71),
  ('base', 'kia.com/nl', 'kia.com', 'Kia', 'NL', 'nl', 72),
  ('base', 'kia.com/no', 'kia.com', 'Kia', 'NO', 'no', 73),
  ('base', 'kia.com/dk', 'kia.com', 'Kia', 'DK', 'da', 74),
  ('base', 'kia.com/de', 'kia.com', 'Kia', 'DE', 'de', 75),
  ('base', 'kia.lv', 'kia.lv', 'Kia', 'LV', 'lv', 76),
  ('base', 'kia.ru', 'kia.ru', 'Kia', 'RU', 'ru', 77),
  ('base', 'kia.ro', 'kia.ro', 'Kia', 'RO', 'ro', 78),
  ('base', 'kia.lt', 'kia.lt', 'Kia', 'LT', 'lt', 79),
  ('base', 'kia.ba', 'kia.ba', 'Kia', 'BA', 'bs', 80),
  ('base', 'kia.bg', 'kia.bg', 'Kia', 'BG', 'bg', 81),
  ('base', 'kia.rs', 'kia.rs', 'Kia', 'RS', 'sr', 82),
  ('base', 'kia.com/se', 'kia.com', 'Kia', 'SE', 'sv', 83),
  ('base', 'kia.com/es', 'kia.com', 'Kia', 'ES', 'es', 84),
  ('base', 'kia.com/sk', 'kia.com', 'Kia', 'SK', 'sk', 85),
  ('base', 'kia.si', 'kia.si', 'Kia', 'SI', 'sl', 86),
  ('base', 'kia.ee', 'kia.ee', 'Kia', 'EE', 'et', 87),
  ('base', 'kia.com/uk', 'kia.com', 'Kia', 'GB', 'en', 88),
  ('base', 'kia.com/ua', 'kia.com', 'Kia', 'UA', 'uk', 89),
  ('base', 'kia.com/it', 'kia.com', 'Kia', 'IT', 'it', 90),
  ('base', 'kia.com/cz', 'kia.com', 'Kia', 'CZ', 'cs', 91),
  ('base', 'kia.com.kz', 'kia.com.kz', 'Kia', 'KZ', 'ru', 92),
  ('base', 'kia.hr', 'kia.hr', 'Kia', 'HR', 'hr', 93),
  ('base', 'kia.com/tr', 'kia.com', 'Kia', 'TR', 'tr', 94),
  ('base', 'kia.pt', 'kia.pt', 'Kia', 'PT', 'pt', 95),
  ('base', 'kia.com/pl', 'kia.com', 'Kia', 'PL', 'pl', 96),
  ('base', 'kia.com/fr', 'kia.com', 'Kia', 'FR', 'fr', 97),
  ('base', 'kia.com/fi', 'kia.com', 'Kia', 'FI', 'fi', 98),
  ('base', 'kia.com/hu', 'kia.com', 'Kia', 'HU', 'hu', 99),
  ('base', 'kia-israel.co.il', 'kia-israel.co.il', 'Kia', 'IL', 'he', 100),
  ('base', 'worldwide.kia.com/ko', 'worldwide.kia.com', 'Kia', NULL, 'en', 101),
  ('base', 'worldwide.kia.com/en', 'worldwide.kia.com', 'Kia', NULL, 'en', 102),
  ('base', 'hyundai.com/pacific/en', 'hyundai.com', 'Hyundai', 'AS', 'en', 103),
  ('base', 'hyundai.com/hk/zh', 'hyundai.com', 'Hyundai', 'HK', 'zh', 104),
  ('base', 'hyundai.com/id/en', 'hyundai.com', 'Hyundai', 'ID', 'en', 105),
  ('base', 'hyundai.com/la/en', 'hyundai.com', 'Hyundai', 'LA', 'en', 106),
  ('base', 'hyundai.com/my/en', 'hyundai.com', 'Hyundai', 'MY', 'en', 107),
  ('base', 'hyundai.com/ph/en', 'hyundai.com', 'Hyundai', 'PH', 'en', 108),
  ('base', 'hyundai.com/th/th', 'hyundai.com', 'Hyundai', 'TH', 'th', 109),
  ('base', 'hyundai.com/be/nl', 'hyundai.com', 'Hyundai', 'BE', 'nl', 110),
  ('base', 'hyundai.com/lu', 'hyundai.com', 'Hyundai', 'LU', 'fr', 111),
  ('base', 'hyundai.com/ch/de', 'hyundai.com', 'Hyundai', 'CH', 'de', 112),
  ('base', 'hyundai.com/uz/uz', 'hyundai.com', 'Hyundai', 'UZ', 'uz', 113),
  ('base', 'hyundai.com/bh/en', 'hyundai.com', 'Hyundai', 'BH', 'en', 114),
  ('base', 'hyundai.com/kw/en', 'hyundai.com', 'Hyundai', 'KW', 'en', 115),
  ('base', 'hyundai.com/lb/en', 'hyundai.com', 'Hyundai', 'LB', 'en', 116),
  ('base', 'hyundai.com/africa/en', 'hyundai.com', 'Hyundai', 'AO', 'en', 117),
  ('base', 'hyundai.com/canarias/es', 'hyundai.com', 'Hyundai', 'ES', 'es', 118),
  ('base', 'hyundai.com/et/en', 'hyundai.com', 'Hyundai', 'ET', 'en', 119),
  ('base', 'hyundai.com/ma/fr', 'hyundai.com', 'Hyundai', 'MA', 'fr', 120),
  ('base', 'hyundai.com/ng/en', 'hyundai.com', 'Hyundai', 'NG', 'en', 121),
  ('base', 'hyundai.com/csa/en', 'hyundai.com', 'Hyundai', 'AG', 'en', 122),
  ('base', 'hyundai.com/gd/en', 'hyundai.com', 'Hyundai', 'GD', 'en', 123),
  ('base', 'kia.com/bn', 'kia.com', 'Kia', 'BN', 'en', 124),
  ('base', 'kia.com/fj', 'kia.com', 'Kia', 'FJ', 'en', 125),
  ('base', 'kia.com/hk/zh', 'kia.com', 'Kia', 'HK', 'zh', 126),
  ('base', 'kia.com/la', 'kia.com', 'Kia', 'LA', 'en', 127),
  ('base', 'kia.com/my', 'kia.com', 'Kia', 'MY', 'en', 128),
  ('base', 'kia.com/mn', 'kia.com', 'Kia', 'MN', 'mn', 129),
  ('base', 'kia.com/sg', 'kia.com', 'Kia', 'SG', 'en', 130),
  ('base', 'kia.com/at', 'kia.com', 'Kia', 'AT', 'de', 131),
  ('base', 'kia.com/be/nl', 'kia.com', 'Kia', 'BE', 'nl', 132),
  ('base', 'kia.com/is', 'kia.com', 'Kia', 'IS', 'is', 133),
  ('base', 'kia.com/ie', 'kia.com', 'Kia', 'IE', 'en', 134),
  ('base', 'kia.com/lu', 'kia.com', 'Kia', 'LU', 'fr', 135),
  ('base', 'kia.com/mt', 'kia.com', 'Kia', 'MT', 'en', 136),
  ('base', 'kia.com/az', 'kia.com', 'Kia', 'AZ', 'az', 137),
  ('base', 'kia.com/eu', 'kia.com', 'Kia', NULL, 'en', 138),
  ('base', 'kia.com/ge', 'kia.com', 'Kia', 'GE', 'ka', 139),
  ('base', 'kia.com/kw', 'kia.com', 'Kia', 'KW', 'en', 140),
  ('base', 'kia.com/lb', 'kia.com', 'Kia', 'LB', 'en', 141),
  ('base', 'kia.com/om/ar', 'kia.com', 'Kia', 'OM', 'ar', 142),
  ('base', 'kia.com/aljabr/ar', 'kia.com', 'Kia', 'SA', 'ar', 143),
  ('base', 'kia.com/nmc/ar', 'kia.com', 'Kia', 'SA', 'ar', 144),
  ('base', 'kia.com/mu', 'kia.com', 'Kia', 'MU', 'en', 145),
  ('base', 'kia.com/sd/ar', 'kia.com', 'Kia', 'SD', 'ar', 146),
  ('base', 'kia.com/aw', 'kia.com', 'Kia', 'AW', 'en', 147),
  ('base', 'kia.com/dm', 'kia.com', 'Kia', 'DM', 'en', 148),
  ('base', 'kia.com/cr', 'kia.com', 'Kia', 'CR', 'es', 149),
  ('base', 'kia.com/ec', 'kia.com', 'Kia', 'EC', 'es', 150),
  ('base', 'kia.com/hn', 'kia.com', 'Kia', 'HN', 'es', 151),
  ('base', 'kia.com/pe', 'kia.com', 'Kia', 'PE', 'es', 152),
  ('base', 'kia.com/pr', 'kia.com', 'Kia', 'PR', 'es', 153),
  ('base', 'genesis.com/kz/ru', 'genesis.com', 'Genesis', 'KZ', 'ru', 154),
  ('base', 'genesis.com/id/en', 'genesis.com', 'Genesis', 'ID', 'en', 155),
  ('base', 'genesis.com/middleeast/en', 'genesis.com', 'Genesis', NULL, 'en', 156),
  ('base', 'genesis.com/bh/en', 'genesis.com', 'Genesis', 'BH', 'en', 157),
  ('base', 'genesis.com/kw/en', 'genesis.com', 'Genesis', 'KW', 'en', 158),
  ('base', 'genesis.com/om/en', 'genesis.com', 'Genesis', 'OM', 'en', 159),
  ('base', 'genesis.com/qa/en', 'genesis.com', 'Genesis', 'QA', 'en', 160),
  ('base', 'genesis.com/sa-dammam/ar', 'genesis.com', 'Genesis', 'SA', 'ar', 161),
  ('base', 'genesis.com/sa-jeddah/ar', 'genesis.com', 'Genesis', 'SA', 'ar', 162),
  ('base', 'genesis.com/sa-riyadh/ar', 'genesis.com', 'Genesis', 'SA', 'ar', 163),
  ('base', 'genesis.com/ae/en', 'genesis.com', 'Genesis', 'AE', 'en', 164),
  ('base', 'genesis.com/ch/de', 'genesis.com', 'Genesis', 'CH', 'de', 165),
  ('base', 'genesis.com/nl/nl', 'genesis.com', 'Genesis', 'NL', 'nl', 166),
  ('base', 'genesis.com/es/es', 'genesis.com', 'Genesis', 'ES', 'es', 167),
  ('base', 'genesis.com/mu/en', 'genesis.com', 'Genesis', 'MU', 'en', 168),
  ('base', 'genesis.com/eg/en', 'genesis.com', 'Genesis', 'EG', 'en', 169),
  ('root_home', 'genesis.com.cn', 'genesis.com.cn', 'Genesis', 'CN', 'zh', 170),
  ('root_home', 'hyundai-n.com', 'hyundai-n.com', 'Hyundai', NULL, 'en', 171),
  ('root_home', 'hyundai.ba', 'hyundai.ba', 'Hyundai', 'BA', 'bs', 172),
  ('root_home', 'hyundai.bg', 'hyundai.bg', 'Hyundai', 'BG', 'bg', 173),
  ('root_home', 'hyundai.cl', 'hyundai.cl', 'Hyundai', 'CL', 'es', 174),
  ('root_home', 'hyundai.com.br', 'hyundai.com.br', 'Hyundai', 'BR', 'pt', 175),
  ('root_home', 'hyundai.com.cn', 'hyundai.com.cn', 'Hyundai', 'CN', 'zh', 176),
  ('root_home', 'hyundai.com.mx', 'hyundai.com.mx', 'Hyundai', 'MX', 'es', 177),
  ('root_home', 'hyundai.com.ua', 'hyundai.com.ua', 'Hyundai', 'UA', 'uk', 178),
  ('root_home', 'hyundai.dk', 'hyundai.dk', 'Hyundai', 'DK', 'da', 179),
  ('root_home', 'hyundai.ee', 'hyundai.ee', 'Hyundai', 'EE', 'et', 180),
  ('root_home', 'hyundai.fi', 'hyundai.fi', 'Hyundai', 'FI', 'fi', 181),
  ('root_home', 'hyundai.gr', 'hyundai.gr', 'Hyundai', 'GR', 'el', 182),
  ('root_home', 'hyundai.hr', 'hyundai.hr', 'Hyundai', 'HR', 'hr', 183),
  ('root_home', 'hyundai.hu', 'hyundai.hu', 'Hyundai', 'HU', 'hu', 184),
  ('root_home', 'hyundai.lt', 'hyundai.lt', 'Hyundai', 'LT', 'lt', 185),
  ('root_home', 'hyundai.lv', 'hyundai.lv', 'Hyundai', 'LV', 'lv', 186),
  ('root_home', 'hyundai.pt', 'hyundai.pt', 'Hyundai', 'PT', 'pt', 187),
  ('root_home', 'hyundai.rs', 'hyundai.rs', 'Hyundai', 'RS', 'sr', 188),
  ('root_home', 'hyundai.ru', 'hyundai.ru', 'Hyundai', 'RU', 'ru', 189),
  ('root_home', 'hyundai.si', 'hyundai.si', 'Hyundai', 'SI', 'sl', 190),
  ('root_home', 'hyundaicanada.com', 'hyundaicanada.com', 'Hyundai', 'CA', 'en', 191),
  ('root_home', 'hyundaiusa.com', 'hyundaiusa.com', 'Hyundai', 'US', 'en', 192),
  ('root_home', 'kia-israel.co.il', 'kia-israel.co.il', 'Kia', 'IL', 'he', 193),
  ('root_home', 'kia.ba', 'kia.ba', 'Kia', 'BA', 'bs', 194),
  ('root_home', 'kia.bg', 'kia.bg', 'Kia', 'BG', 'bg', 195),
  ('root_home', 'kia.ca', 'kia.ca', 'Kia', 'CA', 'en', 196),
  ('root_home', 'kia.cl', 'kia.cl', 'Kia', 'CL', 'es', 197),
  ('root_home', 'kia.com.kz', 'kia.com.kz', 'Kia', 'KZ', 'ru', 198),
  ('root_home', 'kia.com.mm', 'kia.com.mm', 'Kia', 'MM', 'en', 199),
  ('root_home', 'kia.ee', 'kia.ee', 'Kia', 'EE', 'et', 200),
  ('root_home', 'kia.hr', 'kia.hr', 'Kia', 'HR', 'hr', 201),
  ('root_home', 'kia.lt', 'kia.lt', 'Kia', 'LT', 'lt', 202),
  ('root_home', 'kia.lv', 'kia.lv', 'Kia', 'LV', 'lv', 203),
  ('root_home', 'kia.pt', 'kia.pt', 'Kia', 'PT', 'pt', 204),
  ('root_home', 'kia.ro', 'kia.ro', 'Kia', 'RO', 'ro', 205),
  ('root_home', 'kia.rs', 'kia.rs', 'Kia', 'RS', 'sr', 206),
  ('root_home', 'kia.ru', 'kia.ru', 'Kia', 'RU', 'ru', 207),
  ('root_home', 'kia.si', 'kia.si', 'Kia', 'SI', 'sl', 208),
  ('root_home', 'worldwide.kia.com', 'worldwide.kia.com', 'Kia', NULL, 'en', 209);
WITH mx AS (SELECT coalesce(max(owner_key), 0) AS m FROM app.owned_base),
     src AS (SELECT s.*, o.owner_key AS old_key FROM _ob s LEFT JOIN app.owned_base o ON o.kind = s.kind AND o.prefix = s.prefix),
     keyed AS (SELECT src.*, coalesce(old_key, (SELECT m FROM mx) + row_number() OVER (PARTITION BY old_key IS NULL ORDER BY ord)) AS k FROM src)
INSERT INTO app.owned_base (owner_key, kind, prefix, host, brand_code, geo_code, language)
SELECT k::int2, kind, prefix, host, brand_code, geo_code, language FROM keyed
ON CONFLICT (owner_key) DO UPDATE SET host = EXCLUDED.host, brand_code = EXCLUDED.brand_code, geo_code = EXCLUDED.geo_code, language = EXCLUDED.language;
DELETE FROM app.owned_base o WHERE NOT EXISTS (SELECT 1 FROM _ob s WHERE s.kind = o.kind AND s.prefix = o.prefix);

-- ── 2. 데이터·규칙 표 비우기(재실행) ───────────────────────────────────────
-- app.qa_*·app.judgment_change·app.scope_outbox·app.access_audit_log·app.permission_audit_log·app.kw_prompt_draft 는
-- 이 시드의 대상이 아니므로 건드리지 않는다. app.project_member·app.ctx_generated_prompt 는 app.project 를 FK 로 참조해
-- TRUNCATE 목록에 함께 넣지만 채우지 않는다(원천 없음·user_account 부재).
TRUNCATE app.prompt_custom_field_value, app.prompt_audit_log, app.member_audit_log, app.project_tracked_brand, app.project_tracked_competitor, app.project_tracked_vehicle, app.project_tracked_keyword, app.project_owned_base, app.project_tracked_url, app.project_engine_history, app.project_custom_field, app.prompt, app.prompt_candidate, app.project_member, app.project, app.website_prompt, app.website_site, app.standard_keyword, app.standard_source, app.ga4_tracked_event, app.ga4_market_pending, app.ga4_property, app.report_site_engine_fact, app.report_site_fact, app.report_publication, app.citation_domain_override, app.entity_registry, app.entity_alias, app.hidden_market, app.brand_name_prefix, app.brand_display_alias, app.non_competitor_name, app.competitor_domain_token, app.rule_param, app.ctx_generated_prompt RESTART IDENTITY;
ALTER TABLE app.prompt DISABLE TRIGGER prompt_catalog_change;

-- ── 3. 판정 규칙 표(현행 코드 상수) ─────────────────────────────────────────
-- 3-1. app.brand_name_prefix : HMG_BRAND_NAME_PREFIXES lib/scope/hmg-brands.ts:63. eval_order = 전역 평가 순서
--      (객체 키 순서 Genesis → Hyundai → Kia, 브랜드 안에서는 배열 순서. hmgBrandPrefixEntries :72).
INSERT INTO app.brand_name_prefix (brand_code, prefix, eval_order) VALUES
  ('Genesis', 'Genesis', 1),
  ('Genesis', '제네시스', 2),
  ('Genesis', 'جينيسيس', 3),
  ('Hyundai', 'Hyundai', 4),
  ('Hyundai', '현대자동차', 5),
  ('Hyundai', '현대차', 6),
  ('Hyundai', '현대', 7),
  ('Hyundai', 'هيونداي', 8),
  ('Hyundai', 'יונדאי', 9),
  ('Kia', 'Kia', 10),
  ('Kia', '기아', 11),
  ('Kia', 'كيا', 12),
  ('Kia', 'קיה', 13);

-- 3-2. app.brand_display_alias : BRAND_DISPLAY_ALIAS_ENTRIES lib/scope/brand-display-aliases.ts:77
--      = HMG_BRAND_NAME_ALIASES(hmg-brands.ts:117) + COMPETITOR_DISPLAY_ALIASES(brand-display-aliases.ts:14).
INSERT INTO app.brand_display_alias (alias, canonical_name) VALUES
  ('기아', 'Kia'),
  ('현대', 'Hyundai'),
  ('현대차', 'Hyundai'),
  ('현대자동차', 'Hyundai'),
  ('제네시스', 'Genesis'),
  ('هيونداي', 'Hyundai'),
  ('كيا', 'Kia'),
  ('جينيسيس', 'Genesis'),
  ('יונדאי', 'Hyundai'),
  ('קיה', 'Kia'),
  ('폭스바겐', 'Volkswagen'),
  ('메르세데스-벤츠', 'Mercedes-Benz'),
  ('메르세데즈-벤츠', 'Mercedes-Benz'),
  ('메르세데스-AMG', 'Mercedes-AMG'),
  ('هوندا', 'Honda'),
  ('마쓰다', 'Mazda'),
  ('르노', 'Renault'),
  ('טויוטה', 'Toyota'),
  ('미니', 'MINI'),
  ('Mini', 'MINI'),
  ('링컨', 'Lincoln'),
  ('링크앤코', 'Lynk & Co'),
  ('대우', 'Daewoo'),
  ('Skoda', 'Škoda'),
  ('테슬라', 'Tesla'),
  ('루시드', 'Lucid'),
  ('تويوتا', 'Toyota'),
  ('奔驰', 'Mercedes-Benz'),
  ('宝马', 'BMW'),
  ('نيسان', 'Nissan'),
  ('KG 모빌리티', 'KG Mobility'),
  ('זיקר', 'Zeekr'),
  ('מרצדס', 'Mercedes-Benz'),
  ('שברולט', 'Chevrolet'),
  ('ב.מ.וו', 'BMW'),
  ('엑스펑', 'XPeng'),
  ('피닌파리나', 'Pininfarina'),
  ('Xpeng', 'XPeng');

-- 3-3. app.non_competitor_name : NON_COMPETITOR_BRANDS lib/scope/non-competitor-brands.ts:213 (소문자, Set 중복 제거 후 158개).
--      bare_only_pattern = BARE_ONLY_NON_COMPETITOR_PATTERNS :275 의 POSIX 패턴(선행 트림 클래스 POSIX_LEADING_TRIM 포함).
INSERT INTO app.non_competitor_name (name, bare_only_pattern) VALUES
  ('/drive', NULL),
  ('a-premium', NULL),
  ('across', NULL),
  ('acsi', NULL),
  ('advanced', NULL),
  ('alcantara', NULL),
  ('alliance', NULL),
  ('amazon prime', NULL),
  ('app store', NULL),
  ('apple', NULL),
  ('arka', NULL),
  ('australia', NULL),
  ('automotive manufacturer', NULL),
  ('automotive repair shop', NULL),
  ('bank', NULL),
  ('bolt', '^[	
                  　﻿]*bolt[^[:alnum:]]'),
  ('canada', NULL),
  ('century', '^[	
                  　﻿]*century[^[:alnum:]]'),
  ('charger', '^[	
                  　﻿]*charger[^[:alnum:]]'),
  ('china', NULL),
  ('city', '^[	
                  　﻿]*city[^[:alnum:]]'),
  ('clever', NULL),
  ('comp cams', NULL),
  ('contact', NULL),
  ('credit union', NULL),
  ('crown', '^[	
                  　﻿]*crown[^[:alnum:]]'),
  ('cruise', '^[	
                  　﻿]*cruise[^[:alnum:]]'),
  ('dealership', NULL),
  ('destination mazda', NULL),
  ('digit insurance', NULL),
  ('dollar rent a car', NULL),
  ('drift', NULL),
  ('dual electronics', '^[	
                  　﻿]*dual electronics[^[:alnum:]]'),
  ('edge', '^[	
                  　﻿]*edge[^[:alnum:]]'),
  ('element', '^[	
                  　﻿]*element[^[:alnum:]]'),
  ('ergo', NULL),
  ('españa', NULL),
  ('ethos car care', NULL),
  ('event tires', NULL),
  ('evs tuning', NULL),
  ('fahren', NULL),
  ('falcon', '^[	
                  　﻿]*falcon[^[:alnum:]]'),
  ('fastback', '^[	
                  　﻿]*fastback[^[:alnum:]]'),
  ('fila', NULL),
  ('fit', '^[	
                  　﻿]*fit[^[:alnum:]]'),
  ('five', NULL),
  ('flat', NULL),
  ('focus', '^[	
                  　﻿]*focus[^[:alnum:]]'),
  ('form lighting', NULL),
  ('game', NULL),
  ('german automotive industry', NULL),
  ('german luxury car brands', NULL),
  ('germany', NULL),
  ('global pet foods', NULL),
  ('golf', '^[	
                  　﻿]*golf[^[:alnum:]]'),
  ('google', NULL),
  ('gran turismo', NULL),
  ('gravity', '^[	
                  　﻿]*gravity[^[:alnum:]]'),
  ('green filter', NULL),
  ('guest', NULL),
  ('impact', NULL),
  ('index', NULL),
  ('integra', '^[	
                  　﻿]*integra[^[:alnum:]]'),
  ('international', '^[	
                  　﻿]*international[^[:alnum:]]'),
  ('is', '^[	
                  　﻿]*is[^[:alnum:]]'),
  ('italian automotive brands', NULL),
  ('jd power', NULL),
  ('king george/kingsway dealership', NULL),
  ('kobalt', NULL),
  ('legacy', '^[	
                  　﻿]*legacy[^[:alnum:]]'),
  ('lightning', '^[	
                  　﻿]*lightning[^[:alnum:]]'),
  ('link ecu', NULL),
  ('local dealership', NULL),
  ('march performance', NULL),
  ('mark''s', NULL),
  ('mass', NULL),
  ('maximum', NULL),
  ('microsoft surface', NULL),
  ('miles', NULL),
  ('mobile.de', NULL),
  ('modern', NULL),
  ('more than', NULL),
  ('motion', NULL),
  ('motor trend', NULL),
  ('one', '^[	
                  　﻿]*one[^[:alnum:]]'),
  ('option', NULL),
  ('original equipment manufacturer', NULL),
  ('pace american', NULL),
  ('particular', NULL),
  ('peak', NULL),
  ('pilot', '^[	
                  　﻿]*pilot[^[:alnum:]]'),
  ('plus', NULL),
  ('point s', NULL),
  ('power performance', NULL),
  ('powerful', NULL),
  ('punch', '^[	
                  　﻿]*punch[^[:alnum:]]'),
  ('race', NULL),
  ('reach', NULL),
  ('real', NULL),
  ('record', NULL),
  ('reliance', NULL),
  ('retailer', NULL),
  ('rise', NULL),
  ('samsung', NULL),
  ('security', NULL),
  ('sharp', NULL),
  ('silence', NULL),
  ('smart', '^[	
                  　﻿]*smart[^[:alnum:]]'),
  ('specialist', NULL),
  ('specialized', NULL),
  ('stack', NULL),
  ('stance wheels', NULL),
  ('status', NULL),
  ('sure', NULL),
  ('target', NULL),
  ('third party', NULL),
  ('torque', NULL),
  ('transit', '^[	
                  　﻿]*transit[^[:alnum:]]'),
  ('urban', NULL),
  ('usa', NULL),
  ('vanguard', NULL),
  ('victory', NULL),
  ('vision', '^[	
                  　﻿]*vision[^[:alnum:]]'),
  ('volt', '^[	
                  　﻿]*volt[^[:alnum:]]'),
  ('wahl', NULL),
  ('wedge performance', NULL),
  ('western motorsports', NULL),
  ('winners', NULL),
  ('wise', NULL),
  ('고가 브랜드', NULL),
  ('국내 배터리 제조사', NULL),
  ('국토교통부', NULL),
  ('대만 모터사이클 산업', NULL),
  ('독3사', NULL),
  ('독립 정비소', NULL),
  ('독일 자동차 브랜드', NULL),
  ('레카로', NULL),
  ('말레이시아', NULL),
  ('보배드림', NULL),
  ('사설 정비소', NULL),
  ('삼성전자', NULL),
  ('세나', NULL),
  ('순정부품', NULL),
  ('아우디 공식 딜러', NULL),
  ('온라인샵', NULL),
  ('요코하마', NULL),
  ('일본 럭셔리 자동차 브랜드', NULL),
  ('자동차 동호회', NULL),
  ('자동차리콜센터', NULL),
  ('저가 브랜드', NULL),
  ('중고차 플랫폼', NULL),
  ('차지비', NULL),
  ('카센터', NULL),
  ('카카오', NULL),
  ('캐피탈사', NULL),
  ('테인', NULL),
  ('파파존스', NULL),
  ('프랑스 자동차 제조사', NULL);

-- 3-4. app.competitor_domain_token : TOKEN_TO_BRAND lib/citation-categorizer/competitor-brand.ts:8-24.
--      접두 매칭 제외 규칙(2자 이하·AMBIGUOUS_PREFIX :26 은 정확 일치만)은 표에 열이 없어 rule_param 'competitor_token_exact_only' 로 둔다.
INSERT INTO app.competitor_domain_token (token, brand_name) VALUES
  ('toyota', 'Toyota'),
  ('lexus', 'Lexus'),
  ('daihatsu', 'Daihatsu'),
  ('honda', 'Honda'),
  ('acura', 'Acura'),
  ('nissan', 'Nissan'),
  ('infiniti', 'Infiniti'),
  ('mazda', 'Mazda'),
  ('subaru', 'Subaru'),
  ('mitsubishi', 'Mitsubishi'),
  ('suzuki', 'Suzuki'),
  ('isuzu', 'Isuzu'),
  ('bmw', 'BMW'),
  ('mini', 'MINI'),
  ('mercedes-benz', 'Mercedes-Benz'),
  ('mercedes', 'Mercedes-Benz'),
  ('mbusa', 'Mercedes-Benz'),
  ('maybach', 'Mercedes-Benz'),
  ('audi', 'Audi'),
  ('volkswagen', 'Volkswagen'),
  ('vw', 'Volkswagen'),
  ('porsche', 'Porsche'),
  ('tesla', 'Tesla'),
  ('ford', 'Ford'),
  ('lincoln', 'Lincoln'),
  ('chevrolet', 'Chevrolet'),
  ('chevy', 'Chevrolet'),
  ('gmc', 'GMC'),
  ('cadillac', 'Cadillac'),
  ('buick', 'Buick'),
  ('jeep', 'Jeep'),
  ('dodge', 'Dodge'),
  ('ram', 'Ram'),
  ('chrysler', 'Chrysler'),
  ('volvo', 'Volvo'),
  ('polestar', 'Polestar'),
  ('byd', 'BYD'),
  ('geely', 'Geely'),
  ('chery', 'Chery'),
  ('mg', 'MG'),
  ('skoda', 'Škoda'),
  ('seat', 'SEAT'),
  ('cupra', 'CUPRA'),
  ('renault', 'Renault'),
  ('dacia', 'Dacia'),
  ('peugeot', 'Peugeot'),
  ('citroen', 'Citroën'),
  ('opel', 'Opel'),
  ('fiat', 'Fiat'),
  ('alfa-romeo', 'Alfa Romeo'),
  ('alfaromeo', 'Alfa Romeo'),
  ('ferrari', 'Ferrari'),
  ('lamborghini', 'Lamborghini'),
  ('maserati', 'Maserati'),
  ('bentley', 'Bentley'),
  ('rolls-royce', 'Rolls-Royce'),
  ('rollsroyce', 'Rolls-Royce'),
  ('land-rover', 'Land Rover'),
  ('landrover', 'Land Rover'),
  ('jaguar', 'Jaguar'),
  ('aston-martin', 'Aston Martin'),
  ('astonmartin', 'Aston Martin'),
  ('lucid', 'Lucid'),
  ('rivian', 'Rivian'),
  ('tata', 'Tata'),
  ('mahindra', 'Mahindra'),
  ('vinfast', 'VinFast'),
  ('nio', 'NIO'),
  ('xpeng', 'XPeng'),
  ('zeekr', 'Zeekr'),
  ('lynkco', 'Lynk & Co'),
  ('smart', 'smart');

-- 3-5. app.entity_alias : HMG_BRAND_ALIAS_ENTITY_IDS lib/scope/hmg-brands.ts:35 (표기 변형 id → 정본 id :25)
INSERT INTO app.entity_alias (alias_entity_id, canon_entity_id) VALUES
  ('e0348d5f-afe4-48e6-aa99-1dee566f2822'::uuid, '00000000-0000-0000-0000-000000000301'::uuid),
  ('c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45'::uuid, '00000000-0000-0000-0000-000000000301'::uuid),
  ('65eabd79-6138-4851-8b58-8a9b0261b517'::uuid, '00000000-0000-0000-0000-000000000301'::uuid),
  ('ed4b8012-4a73-4174-9b43-4cb696934b25'::uuid, '00000000-0000-0000-0000-000000000302'::uuid),
  ('53a1ac82-6346-477d-9fb7-31d78b9248fa'::uuid, '00000000-0000-0000-0000-000000000302'::uuid),
  ('e21f66ad-9a28-46ab-8436-78ead06bd8f9'::uuid, '00000000-0000-0000-0000-000000000302'::uuid),
  ('fd2f4a33-8f9b-4a46-bfd0-62133d162d28'::uuid, '00000000-0000-0000-0000-000000000304'::uuid);

-- 3-6. app.rhq_region·rhq_region_country : lib/rhq/_data/rhq-map.json (lib/rhq/index.ts:13). label = labels.ko.
--      재적재 = UPSERT + 원천에서 사라진 행만 DELETE(TRUNCATE 금지: DB-v2.4 rhq 가드가 계정 참조 권역·국가의 삭제·TRUNCATE 를 막는다).
CREATE TEMP TABLE _rr (region_id text, brand_code text, label text) ON COMMIT DROP;
INSERT INTO _rr VALUES
  ('hyundai-europe', 'Hyundai', '유럽'),
  ('hyundai-asia-pacific', 'Hyundai', '아시아 & 태평양'),
  ('hyundai-latin-america', 'Hyundai', '중남미'),
  ('hyundai-africa', 'Hyundai', '아프리카'),
  ('hyundai-middle-east', 'Hyundai', '중동'),
  ('hyundai-north-america', 'Hyundai', '북아메리카'),
  ('kia-asia-pacific', 'Kia', '아시아 & 태평양'),
  ('kia-western-europe', 'Kia', 'Europe(W)'),
  ('kia-eastern-europe', 'Kia', 'Europe(E)'),
  ('kia-middle-east', 'Kia', '중동'),
  ('kia-africa', 'Kia', '아프리카'),
  ('kia-north-america', 'Kia', '북아메리카'),
  ('kia-central-south-america', 'Kia', '중남미'),
  ('genesis-asia-pacific', 'Genesis', '아시아 & 태평양'),
  ('genesis-middle-east', 'Genesis', '중동'),
  ('genesis-north-america', 'Genesis', '북아메리카'),
  ('genesis-europe', 'Genesis', '유럽'),
  ('genesis-africa', 'Genesis', '아프리카');
CREATE TEMP TABLE _rc (region_id text, country_code text) ON COMMIT DROP;
INSERT INTO _rc VALUES
  ('hyundai-europe', 'AL'),
  ('hyundai-europe', 'AM'),
  ('hyundai-europe', 'AT'),
  ('hyundai-europe', 'AZ'),
  ('hyundai-europe', 'BY'),
  ('hyundai-europe', 'BE'),
  ('hyundai-europe', 'BA'),
  ('hyundai-europe', 'BG'),
  ('hyundai-europe', 'HR'),
  ('hyundai-europe', 'CY'),
  ('hyundai-europe', 'CZ'),
  ('hyundai-europe', 'DK'),
  ('hyundai-europe', 'EE'),
  ('hyundai-europe', 'FI'),
  ('hyundai-europe', 'FR'),
  ('hyundai-europe', 'GE'),
  ('hyundai-europe', 'DE'),
  ('hyundai-europe', 'GR'),
  ('hyundai-europe', 'HU'),
  ('hyundai-europe', 'IS'),
  ('hyundai-europe', 'IE'),
  ('hyundai-europe', 'IT'),
  ('hyundai-europe', 'KZ'),
  ('hyundai-europe', 'KG'),
  ('hyundai-europe', 'LV'),
  ('hyundai-europe', 'LT'),
  ('hyundai-europe', 'LU'),
  ('hyundai-europe', 'MK'),
  ('hyundai-europe', 'MT'),
  ('hyundai-europe', 'MD'),
  ('hyundai-europe', 'NL'),
  ('hyundai-europe', 'NO'),
  ('hyundai-europe', 'PL'),
  ('hyundai-europe', 'PT'),
  ('hyundai-europe', 'RO'),
  ('hyundai-europe', 'RU'),
  ('hyundai-europe', 'RS'),
  ('hyundai-europe', 'SK'),
  ('hyundai-europe', 'SI'),
  ('hyundai-europe', 'ES'),
  ('hyundai-europe', 'SE'),
  ('hyundai-europe', 'CH'),
  ('hyundai-europe', 'TJ'),
  ('hyundai-europe', 'TM'),
  ('hyundai-europe', 'TR'),
  ('hyundai-europe', 'GB'),
  ('hyundai-europe', 'UA'),
  ('hyundai-europe', 'UZ'),
  ('hyundai-asia-pacific', 'AS'),
  ('hyundai-asia-pacific', 'AU'),
  ('hyundai-asia-pacific', 'BD'),
  ('hyundai-asia-pacific', 'BT'),
  ('hyundai-asia-pacific', 'BN'),
  ('hyundai-asia-pacific', 'KH'),
  ('hyundai-asia-pacific', 'CN'),
  ('hyundai-asia-pacific', 'TL'),
  ('hyundai-asia-pacific', 'FM'),
  ('hyundai-asia-pacific', 'FJ'),
  ('hyundai-asia-pacific', 'PF'),
  ('hyundai-asia-pacific', 'GU'),
  ('hyundai-asia-pacific', 'HK'),
  ('hyundai-asia-pacific', 'IN'),
  ('hyundai-asia-pacific', 'ID'),
  ('hyundai-asia-pacific', 'JP'),
  ('hyundai-asia-pacific', 'KR'),
  ('hyundai-asia-pacific', 'LA'),
  ('hyundai-asia-pacific', 'MO'),
  ('hyundai-asia-pacific', 'MY'),
  ('hyundai-asia-pacific', 'MH'),
  ('hyundai-asia-pacific', 'MN'),
  ('hyundai-asia-pacific', 'MM'),
  ('hyundai-asia-pacific', 'NP'),
  ('hyundai-asia-pacific', 'NC'),
  ('hyundai-asia-pacific', 'NZ'),
  ('hyundai-asia-pacific', 'PH'),
  ('hyundai-asia-pacific', 'MP'),
  ('hyundai-asia-pacific', 'SG'),
  ('hyundai-asia-pacific', 'SB'),
  ('hyundai-asia-pacific', 'LK'),
  ('hyundai-asia-pacific', 'TH'),
  ('hyundai-asia-pacific', 'TO'),
  ('hyundai-asia-pacific', 'VU'),
  ('hyundai-asia-pacific', 'VN'),
  ('hyundai-asia-pacific', 'WS'),
  ('hyundai-latin-america', 'AG'),
  ('hyundai-latin-america', 'AR'),
  ('hyundai-latin-america', 'AW'),
  ('hyundai-latin-america', 'BS'),
  ('hyundai-latin-america', 'BB'),
  ('hyundai-latin-america', 'BM'),
  ('hyundai-latin-america', 'BO'),
  ('hyundai-latin-america', 'BR'),
  ('hyundai-latin-america', 'KY'),
  ('hyundai-latin-america', 'CL'),
  ('hyundai-latin-america', 'CO'),
  ('hyundai-latin-america', 'CR'),
  ('hyundai-latin-america', 'CU'),
  ('hyundai-latin-america', 'CW'),
  ('hyundai-latin-america', 'DO'),
  ('hyundai-latin-america', 'EC'),
  ('hyundai-latin-america', 'SV'),
  ('hyundai-latin-america', 'GF'),
  ('hyundai-latin-america', 'GD'),
  ('hyundai-latin-america', 'GP'),
  ('hyundai-latin-america', 'GT'),
  ('hyundai-latin-america', 'GY'),
  ('hyundai-latin-america', 'HT'),
  ('hyundai-latin-america', 'HN'),
  ('hyundai-latin-america', 'JM'),
  ('hyundai-latin-america', 'MQ'),
  ('hyundai-latin-america', 'NI'),
  ('hyundai-latin-america', 'PA'),
  ('hyundai-latin-america', 'PY'),
  ('hyundai-latin-america', 'PE'),
  ('hyundai-latin-america', 'PR'),
  ('hyundai-latin-america', 'KN'),
  ('hyundai-latin-america', 'LC'),
  ('hyundai-latin-america', 'MF'),
  ('hyundai-latin-america', 'VC'),
  ('hyundai-latin-america', 'SR'),
  ('hyundai-latin-america', 'TT'),
  ('hyundai-latin-america', 'UY'),
  ('hyundai-latin-america', 'VE'),
  ('hyundai-africa', 'DZ'),
  ('hyundai-africa', 'AO'),
  ('hyundai-africa', 'BJ'),
  ('hyundai-africa', 'BF'),
  ('hyundai-africa', 'CM'),
  ('hyundai-africa', 'CF'),
  ('hyundai-africa', 'TD'),
  ('hyundai-africa', 'CG'),
  ('hyundai-africa', 'CD'),
  ('hyundai-africa', 'DJ'),
  ('hyundai-africa', 'EG'),
  ('hyundai-africa', 'ET'),
  ('hyundai-africa', 'GM'),
  ('hyundai-africa', 'GH'),
  ('hyundai-africa', 'GN'),
  ('hyundai-africa', 'GW'),
  ('hyundai-africa', 'CI'),
  ('hyundai-africa', 'KE'),
  ('hyundai-africa', 'LR'),
  ('hyundai-africa', 'LY'),
  ('hyundai-africa', 'MG'),
  ('hyundai-africa', 'ML'),
  ('hyundai-africa', 'MR'),
  ('hyundai-africa', 'MU'),
  ('hyundai-africa', 'MA'),
  ('hyundai-africa', 'MZ'),
  ('hyundai-africa', 'NE'),
  ('hyundai-africa', 'NG'),
  ('hyundai-africa', 'RE'),
  ('hyundai-africa', 'RW'),
  ('hyundai-africa', 'SN'),
  ('hyundai-africa', 'SC'),
  ('hyundai-africa', 'SL'),
  ('hyundai-africa', 'ZA'),
  ('hyundai-africa', 'SD'),
  ('hyundai-africa', 'TG'),
  ('hyundai-africa', 'TN'),
  ('hyundai-africa', 'ZM'),
  ('hyundai-africa', 'ZW'),
  ('hyundai-middle-east', 'AF'),
  ('hyundai-middle-east', 'BH'),
  ('hyundai-middle-east', 'IQ'),
  ('hyundai-middle-east', 'IL'),
  ('hyundai-middle-east', 'JO'),
  ('hyundai-middle-east', 'KW'),
  ('hyundai-middle-east', 'LB'),
  ('hyundai-middle-east', 'OM'),
  ('hyundai-middle-east', 'PK'),
  ('hyundai-middle-east', 'PS'),
  ('hyundai-middle-east', 'QA'),
  ('hyundai-middle-east', 'SA'),
  ('hyundai-middle-east', 'AE'),
  ('hyundai-middle-east', 'YE'),
  ('hyundai-north-america', 'CA'),
  ('hyundai-north-america', 'MX'),
  ('hyundai-north-america', 'US'),
  ('kia-asia-pacific', 'AU'),
  ('kia-asia-pacific', 'BD'),
  ('kia-asia-pacific', 'BT'),
  ('kia-asia-pacific', 'BN'),
  ('kia-asia-pacific', 'KH'),
  ('kia-asia-pacific', 'CN'),
  ('kia-asia-pacific', 'FJ'),
  ('kia-asia-pacific', 'HK'),
  ('kia-asia-pacific', 'IN'),
  ('kia-asia-pacific', 'ID'),
  ('kia-asia-pacific', 'JP'),
  ('kia-asia-pacific', 'KR'),
  ('kia-asia-pacific', 'LA'),
  ('kia-asia-pacific', 'MO'),
  ('kia-asia-pacific', 'MY'),
  ('kia-asia-pacific', 'MN'),
  ('kia-asia-pacific', 'MM'),
  ('kia-asia-pacific', 'NP'),
  ('kia-asia-pacific', 'NZ'),
  ('kia-asia-pacific', 'PK'),
  ('kia-asia-pacific', 'PH'),
  ('kia-asia-pacific', 'SG'),
  ('kia-asia-pacific', 'LK'),
  ('kia-asia-pacific', 'TW'),
  ('kia-asia-pacific', 'TH'),
  ('kia-asia-pacific', 'VN'),
  ('kia-asia-pacific', 'SB'),
  ('kia-western-europe', 'AT'),
  ('kia-western-europe', 'BE'),
  ('kia-western-europe', 'CZ'),
  ('kia-western-europe', 'DK'),
  ('kia-western-europe', 'FI'),
  ('kia-western-europe', 'FR'),
  ('kia-western-europe', 'DE'),
  ('kia-western-europe', 'GR'),
  ('kia-western-europe', 'HU'),
  ('kia-western-europe', 'IS'),
  ('kia-western-europe', 'IE'),
  ('kia-western-europe', 'IT'),
  ('kia-western-europe', 'LU'),
  ('kia-western-europe', 'MT'),
  ('kia-western-europe', 'NL'),
  ('kia-western-europe', 'NO'),
  ('kia-western-europe', 'PL'),
  ('kia-western-europe', 'SK'),
  ('kia-western-europe', 'PT'),
  ('kia-western-europe', 'ES'),
  ('kia-western-europe', 'SE'),
  ('kia-western-europe', 'CH'),
  ('kia-western-europe', 'GB'),
  ('kia-eastern-europe', 'AM'),
  ('kia-eastern-europe', 'AZ'),
  ('kia-eastern-europe', 'BY'),
  ('kia-eastern-europe', 'BA'),
  ('kia-eastern-europe', 'BG'),
  ('kia-eastern-europe', 'HR'),
  ('kia-eastern-europe', 'CY'),
  ('kia-eastern-europe', 'EE'),
  ('kia-eastern-europe', 'GE'),
  ('kia-eastern-europe', 'KZ'),
  ('kia-eastern-europe', 'XK'),
  ('kia-eastern-europe', 'KG'),
  ('kia-eastern-europe', 'LV'),
  ('kia-eastern-europe', 'LT'),
  ('kia-eastern-europe', 'MD'),
  ('kia-eastern-europe', 'ME'),
  ('kia-eastern-europe', 'RO'),
  ('kia-eastern-europe', 'RU'),
  ('kia-eastern-europe', 'RS'),
  ('kia-eastern-europe', 'SI'),
  ('kia-eastern-europe', 'TR'),
  ('kia-eastern-europe', 'UA'),
  ('kia-eastern-europe', 'UZ'),
  ('kia-eastern-europe', 'TJ'),
  ('kia-middle-east', 'BH'),
  ('kia-middle-east', 'IL'),
  ('kia-middle-east', 'JO'),
  ('kia-middle-east', 'KW'),
  ('kia-middle-east', 'LB'),
  ('kia-middle-east', 'IQ'),
  ('kia-middle-east', 'OM'),
  ('kia-middle-east', 'PS'),
  ('kia-middle-east', 'QA'),
  ('kia-middle-east', 'SA'),
  ('kia-middle-east', 'AE'),
  ('kia-middle-east', 'YE'),
  ('kia-middle-east', 'SY'),
  ('kia-africa', 'DZ'),
  ('kia-africa', 'AO'),
  ('kia-africa', 'CM'),
  ('kia-africa', 'EG'),
  ('kia-africa', 'CI'),
  ('kia-africa', 'KE'),
  ('kia-africa', 'MU'),
  ('kia-africa', 'MA'),
  ('kia-africa', 'RE'),
  ('kia-africa', 'SC'),
  ('kia-africa', 'ZA'),
  ('kia-africa', 'SD'),
  ('kia-africa', 'TN'),
  ('kia-africa', 'GH'),
  ('kia-africa', 'LY'),
  ('kia-north-america', 'CA'),
  ('kia-north-america', 'US'),
  ('kia-central-south-america', 'AR'),
  ('kia-central-south-america', 'AW'),
  ('kia-central-south-america', 'BZ'),
  ('kia-central-south-america', 'BO'),
  ('kia-central-south-america', 'BR'),
  ('kia-central-south-america', 'DM'),
  ('kia-central-south-america', 'KY'),
  ('kia-central-south-america', 'CL'),
  ('kia-central-south-america', 'CR'),
  ('kia-central-south-america', 'CW'),
  ('kia-central-south-america', 'CO'),
  ('kia-central-south-america', 'EC'),
  ('kia-central-south-america', 'SV'),
  ('kia-central-south-america', 'GT'),
  ('kia-central-south-america', 'HN'),
  ('kia-central-south-america', 'JM'),
  ('kia-central-south-america', 'MQ'),
  ('kia-central-south-america', 'MX'),
  ('kia-central-south-america', 'NI'),
  ('kia-central-south-america', 'PA'),
  ('kia-central-south-america', 'PY'),
  ('kia-central-south-america', 'PE'),
  ('kia-central-south-america', 'PR'),
  ('kia-central-south-america', 'TT'),
  ('kia-central-south-america', 'UY'),
  ('genesis-asia-pacific', 'KR'),
  ('genesis-asia-pacific', 'AU'),
  ('genesis-asia-pacific', 'CN'),
  ('genesis-asia-pacific', 'KZ'),
  ('genesis-asia-pacific', 'ID'),
  ('genesis-middle-east', 'BH'),
  ('genesis-middle-east', 'KW'),
  ('genesis-middle-east', 'OM'),
  ('genesis-middle-east', 'QA'),
  ('genesis-middle-east', 'SA'),
  ('genesis-middle-east', 'AE'),
  ('genesis-middle-east', 'IL'),
  ('genesis-north-america', 'CA'),
  ('genesis-north-america', 'US'),
  ('genesis-north-america', 'PR'),
  ('genesis-europe', 'DE'),
  ('genesis-europe', 'GB'),
  ('genesis-europe', 'CH'),
  ('genesis-europe', 'RU'),
  ('genesis-europe', 'NL'),
  ('genesis-europe', 'ES'),
  ('genesis-europe', 'IT'),
  ('genesis-europe', 'FR'),
  ('genesis-africa', 'MU'),
  ('genesis-africa', 'EG'),
  ('genesis-africa', 'TN');
DELETE FROM app.rhq_region_country c WHERE NOT EXISTS (SELECT 1 FROM _rc s WHERE s.region_id = c.region_id AND s.country_code = c.country_code);
DELETE FROM app.rhq_region r WHERE NOT EXISTS (SELECT 1 FROM _rr s WHERE s.region_id = r.region_id);
INSERT INTO app.rhq_region (region_id, brand_code, label) SELECT region_id, brand_code, label FROM _rr
ON CONFLICT (region_id) DO UPDATE SET brand_code = EXCLUDED.brand_code, label = EXCLUDED.label
 WHERE (app.rhq_region.brand_code, app.rhq_region.label) IS DISTINCT FROM (EXCLUDED.brand_code, EXCLUDED.label);
INSERT INTO app.rhq_region_country (region_id, country_code) SELECT region_id, country_code FROM _rc ON CONFLICT DO NOTHING;

-- 3-7. app.hidden_market : HIDDEN_STANDARD_REGIONS lib/scope/hidden-regions.ts:31 (표준=글로벌 표면만). hmg-geo 2670a16(#302)이 ID 숨김을
--      해제해 빈 배열이다(동기화 S1 BE-2). 배열이 비면 행이 없다(위 TRUNCATE 로 비운 채 둔다).

-- 3-8. app.rule_param
--   default_engines        lib/scope/engines.ts:37 DEFAULT_AI_ENGINES (0077 hmg_anchor_default_engines 와 대조)
--   analysis_publish_ratio 0.95  DB-v2.1.sql:64·337 (R08, G-05)
--   view_delay_days        2     DB-v2.1.sql:64 시드 키 (현행 글로벌 VIEW_ANCHOR_DELAY lib/summary/generate/types.ts:34)
--   view_delay_days_by_surface  현행 표면별 값: global 2 (types.ts:34), website 1 (types.ts:35), project 1 (0077 hmg_anchor_view_date ② :262)
--   run_recheck_days       3     lib/db/repositories/scope-mirror.ts:201 RUN_RECHECK_WINDOW_DAYS
--   analysis_recheck_days  7     DECISIONS.md G-05 (분석 재확인 창 7일)
--   cycle_complete_quiet_hours 36 lib/db/repositories/summary-cycles.ts:1019 DEFAULT_COMPLETE_QUIET_HOURS (R01 완주 정온)
--   competitor_token_exact_only  lib/citation-categorizer/competitor-brand.ts:26·41 (2자 이하 토큰도 정확 일치만)
INSERT INTO app.rule_param (key, value) VALUES
  ('default_engines', '["chatgpt", "gemini"]'::jsonb),
  ('analysis_publish_ratio', '0.95'::jsonb),
  ('view_delay_days', '2'::jsonb),
  ('view_delay_days_by_surface', '{"global": 2, "website": 1, "project": 1}'::jsonb),
  ('run_recheck_days', '3'::jsonb),
  ('analysis_recheck_days', '7'::jsonb),
  ('cycle_complete_quiet_hours', '36'::jsonb),
  ('competitor_token_exact_only', '{"max_len_exact": 2, "tokens": ["mg", "ram", "nio", "byd", "seat", "mini", "smart", "tata", "ford"]}'::jsonb);

-- ── 4. 앱 데이터 표(mig_src → app, 1:1 매핑) ────────────────────────────────
-- 원칙: 원본 값 보존. FK 가 요구하는 자리만 시스템 사용자로 채운다. FK·CHECK 를 못 맞추는 행은 버리고 검증 표에 사유로 남긴다.

-- 4-1. app.project ← projects. kind: 표준 루트 카탈로그 = STANDARD_ROOT_PROJECT_ID(lib/db/repositories/standards.ts:26-27),
--      나머지 customer. created_by 는 FK(app.user_account) 라 시스템 사용자. projects.language 는 대상 열 없음(버림).
INSERT INTO app.project (project_id, kind, name, description, domain, brand_code, country_code, scope_project_id,
                         ga4_property_id, ai_engines, created_by, created_at, updated_at)
SELECT p.id,
       CASE WHEN p.id = '26751906-c175-485c-9e69-29fc68d0fdbb' THEN 'standard_root' ELSE 'customer' END,
       p.name, p.description, nullif(p.domain, ''), b.brand_code, p.country, p.scope_project_id,
       nullif(p.ga4_property_id, ''), p.ai_engines, current_setting('app.actor_id')::uuid, p.created_at, p.updated_at
  FROM mig_src.projects p LEFT JOIN app.brand b ON b.brand_code = p.brand;
-- 표준 루트의 scope project = 글로벌 루트(SCOPE_ROOT_PROJECT_ID, scripts/db/export-standard-answers.ts:22). 비어 있으면 채운다.
UPDATE app.project SET scope_project_id = 'be28fe15-c743-4a88-abb8-182b25602812'
 WHERE kind = 'standard_root' AND scope_project_id IS NULL;

-- 4-2. app.prompt_candidate ← prompt_candidates
INSERT INTO app.prompt_candidate (candidate_id, project_id, source, source_keyword, text, created_at)
SELECT c.id, c.project_id, c.source::text, c.source_keyword, c.text, c.created_at
  FROM mig_src.prompt_candidates c JOIN app.project p ON p.project_id = c.project_id;

-- 4-3. app.prompt ← prompts. 소속 프로젝트가 없는 행(원본에 FK 없음, 삭제된 프로젝트의 초안)은 FK 때문에 제외.
--      lang 은 CHECK (lang = upper(lang)) 라 upper. 없는 후보 id 는 NULL. needs_reanalysis 는 대상 열 없음(버림).
--      created_by·updated_by 는 FK 없는 열이라 원본 보존.
INSERT INTO app.prompt (prompt_id, project_id, candidate_id, text, prompt_type, category, brand_code, brand_presence,
                        list_type, depth1, depth2, depth3, depth4, funnel_stage, kind, lang, regions, scope_prompt_id,
                        status, created_by, created_at, updated_by, updated_at, deleted_at)
SELECT p.id, p.project_id, c.candidate_id, p.text, p.prompt_type::text, p.category, b.brand_code, p.brand_presence,
       p.list_type, p.depth1, p.depth2, p.depth3, p.depth4, p.funnel_stage, p.kind, upper(nullif(p.lang, '')), p.regions,
       p.scope_prompt_id, p.status::text, p.created_by, p.created_at, p.updated_by, p.updated_at, p.deleted_at
  FROM mig_src.prompts p
  JOIN app.project pr ON pr.project_id = p.project_id
  LEFT JOIN app.prompt_candidate c ON c.candidate_id = p.candidate_id
  LEFT JOIN app.brand b ON b.brand_code = p.brand;

-- 4-4. 사용자 정의 필드
INSERT INTO app.project_custom_field (field_id, project_id, label, archived, created_by, created_at)
SELECT f.id, f.project_id, f.label, f.archived, f.created_by, f.created_at
  FROM mig_src.project_custom_fields f JOIN app.project p ON p.project_id = f.project_id;
INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value)
SELECT pr.project_id, v.prompt_id, v.field_id, v.value
  FROM mig_src.prompt_custom_field_values v
  JOIN app.prompt pr ON pr.prompt_id = v.prompt_id
  JOIN app.project_custom_field f ON f.field_id = v.field_id AND f.project_id = pr.project_id;

-- 4-5. 엔진 이력(history_id 는 IDENTITY, changed_at 순으로 발급)
INSERT INTO app.project_engine_history (project_id, engines, changed_by, changed_at)
SELECT h.project_id, h.engines, h.changed_by, h.changed_at
  FROM mig_src.project_engine_history h JOIN app.project p ON p.project_id = h.project_id
 ORDER BY h.changed_at, h.id;

-- 4-6. 프로젝트 자사 base: base_norm = ownedBasePrefixFromUrl(base_url)(현행 서버가 판정에 쓰는 값, lib/scope/server.ts:881-883).
--      (project_id, base_norm) 충돌은 가장 먼저 만든 행을 남긴다. 정규화 결과가 빈 값이면 현행도 버리므로(filter(Boolean)) 제외.
INSERT INTO app.project_owned_base (project_id, base_url, base_norm, label, created_by, created_at)
SELECT DISTINCT ON (o.project_id, n.norm) o.project_id, o.base_url, n.norm, o.label, o.created_by, o.created_at
  FROM mig_src.project_owned_bases o
  JOIN app.project p ON p.project_id = o.project_id
  CROSS JOIN LATERAL (SELECT pg_temp.owned_prefix(o.base_url) AS norm) n
 WHERE n.norm <> ''
 ORDER BY o.project_id, n.norm, o.created_at, o.id;

-- 4-7. 프로젝트 타겟 URL: url_norm = normalizeUrlForMatch(url)(lib/scope/url-match.ts:29). 충돌은 먼저 만든 행.
INSERT INTO app.project_tracked_url (project_id, url, url_norm, label, created_by, created_at)
SELECT DISTINCT ON (u.project_id, n.norm) u.project_id, u.url, n.norm, u.label, u.created_by, u.created_at
  FROM mig_src.project_tracked_urls u
  JOIN app.project p ON p.project_id = u.project_id
  CROSS JOIN LATERAL (SELECT pg_temp.norm_match(u.url) AS norm) n
 WHERE n.norm <> ''
 ORDER BY u.project_id, n.norm, u.created_at, u.id;

-- 4-8. tracked_* (aliases NULL → '{}' : 대상 열 NOT NULL DEFAULT '{}')
INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases, created_at)
SELECT DISTINCT ON (t.project_id, t.canonical_name) t.project_id, t.canonical_name, coalesce(t.aliases, '{}'), t.created_at
  FROM mig_src.tracked_brands t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.canonical_name, t.created_at;
INSERT INTO app.project_tracked_competitor (project_id, brand_name, aliases, notes, is_target, created_at)
SELECT DISTINCT ON (t.project_id, t.brand_name) t.project_id, t.brand_name, coalesce(t.aliases, '{}'), t.notes, t.is_target, t.created_at
  FROM mig_src.tracked_competitors t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.brand_name, t.created_at;
-- 4-8b. 경쟁사 별칭 ∪ 같은 이름 tracked_brand 별칭(core 9 U9-5). 현행 설정 화면은 경쟁사 별칭 자리에 같은 이름(canonical_name =
--       brand_name)의 tracked_brands 별칭을 보여 줬다(setting/page.tsx:99-103). 이관은 두 표를 따로 옮겨 그 별칭이 API 에서 빠졌다.
--       규칙(core shared.clean_aliases 와 같게): 경쟁사 별칭은 원래 순서 그대로 두고, tracked_brand 별칭 중 앞뒤 공백을 뗀 값이 비지 않고
--       정본 이름(brand_name)과 다르며 경쟁사 별칭(공백 뗀 값)에 없는 것만 tracked_brand 순서대로 덧붙인다(중복 제거, 대소문자 구분).
--       재실행 안전(덧붙일 것이 없으면 갱신 0). 같은 식이 back/migration/fix-u95-competitor-aliases.sql(운영 1회 보정)에 있다.
UPDATE app.project_tracked_competitor c
   SET aliases = c.aliases || x.add
  FROM (SELECT c2.project_id, c2.brand_name,
               ARRAY(SELECT d.a FROM (SELECT DISTINCT ON (t.a) t.a, t.ord
                                        FROM (SELECT regexp_replace(u.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS a, u.ord
                                                FROM unnest(b.aliases) WITH ORDINALITY AS u(v, ord)) t
                                       WHERE t.a <> '' AND t.a <> c2.brand_name
                                         AND NOT EXISTS (SELECT 1 FROM unnest(c2.aliases) AS e(v)
                                                          WHERE regexp_replace(e.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') = t.a)
                                       ORDER BY t.a, t.ord) d
                     ORDER BY d.ord) AS add
          FROM app.project_tracked_competitor c2
          JOIN app.project_tracked_brand b ON b.project_id = c2.project_id AND b.canonical_name = c2.brand_name) x
 WHERE c.project_id = x.project_id AND c.brand_name = x.brand_name AND cardinality(x.add) > 0;
INSERT INTO app.project_tracked_vehicle (project_id, brand, model, segment, aliases, created_at)
SELECT DISTINCT ON (t.project_id, t.brand, t.model) t.project_id, t.brand, t.model, t.segment, coalesce(t.aliases, '{}'), t.created_at
  FROM mig_src.tracked_vehicles t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.brand, t.model, t.created_at;
INSERT INTO app.project_tracked_keyword (keyword_id, project_id, term, country_code, created_at)
SELECT DISTINCT ON (t.project_id, t.term, t.country) t.id, t.project_id, t.term, t.country, t.created_at
  FROM mig_src.tracked_keywords t JOIN app.project p ON p.project_id = t.project_id
 ORDER BY t.project_id, t.term, t.country, t.created_at;

-- 4-9. 웹사이트 카탈로그(scope_project_id·scope_prompt_id 는 원본이 text 라 uuid 로 캐스트)
--      ⚠️ 설계 충돌: app.website_site.scope_project_id 는 UNIQUE 인데 현행은 한 scope project 를 여러 사이트가 공유한다
--      (제네시스 사우디 도시 사이트 SA-Dammam·SA-Jeddah·SA-Riyadh = scope project 1개, 0056_genesis_sa_city_sites).
--      공유 그룹에서 가장 먼저 만든 사이트만 scope_project_id 를 갖고 나머지는 NULL 로 둔다(사이트·유닛 구분은 website_prompt.file_seq 가
--      전역 유일이라 보존된다). 검증 표에 건수를 남긴다.
INSERT INTO app.website_site (site_id, brand_code, country_code, scope_project_id, created_at, updated_at)
SELECT s.id, s.brand, s.country_code,
       CASE WHEN row_number() OVER (PARTITION BY s.scope_project_id ORDER BY s.created_at, s.id) = 1
            THEN nullif(s.scope_project_id, '')::uuid END,
       s.created_at, s.updated_at
  FROM mig_src.website_sites s;
INSERT INTO app.website_prompt (website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text,
                                owned_base_url, scope_prompt_id, created_at, updated_at)
SELECT w.id, w.site_id, w.file_seq, w.domain, w.lang_code, w.seq_no, w.target_url, w.prompt_text,
       w.owned_base_url, nullif(w.scope_prompt_id, '')::uuid, w.created_at, w.updated_at
  FROM mig_src.website_prompts w JOIN app.website_site s ON s.site_id = w.site_id;

-- 4-10. 표준 키워드·출처(standard_prompts 는 대상 표가 없다: 카탈로그 정본은 표준 루트 프로젝트의 app.prompt)
INSERT INTO app.standard_keyword (keyword_id, term, source_type, brand_code, enabled, notes, created_by, created_at, updated_at)
SELECT k.id, k.term, k.source_type::text, b.brand_code, k.enabled, k.notes, k.created_by, k.created_at, k.updated_at
  FROM mig_src.standard_keywords k LEFT JOIN app.brand b ON b.brand_code = k.brand;
INSERT INTO app.standard_source (source_id, url, channel, brand_code, enabled, notes, created_by, created_at, updated_at)
SELECT s.id, s.url, s.channel::text, b.brand_code, s.enabled, s.notes, s.created_by, s.created_at, s.updated_at
  FROM mig_src.standard_sources s LEFT JOIN app.brand b ON b.brand_code = s.brand;

-- 4-11. GA4 (property_id 가 PK 라 원본의 property_id NULL 행은 app.ga4_market_pending 으로, DB-v2.9 P60·P61)
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status, verified_at, updated_by, updated_at)
SELECT DISTINCT ON (g.property_id) g.property_id, b.brand_code, g.country_code, g.status, g.verified_at, g.created_by, g.updated_at
  FROM mig_src.ga4_properties g LEFT JOIN app.brand b ON b.brand_code = g.brand
 WHERE g.property_id IS NOT NULL AND g.property_id <> ''
 ORDER BY g.property_id, g.updated_at DESC;
-- 속성 없는 시장(현행 브랜드·국가만 먼저 등록한 행). 알 수 없는 브랜드·ISO 2자 밖 국가·이미 속성이 매핑된 시장은 버린다.
INSERT INTO app.ga4_market_pending (brand_code, country_code, updated_by, updated_at)
SELECT DISTINCT ON (b.brand_code, upper(btrim(g.country_code))) b.brand_code, upper(btrim(g.country_code)), g.created_by, g.updated_at
  FROM mig_src.ga4_properties g JOIN app.brand b ON b.brand_code = g.brand
 WHERE (g.property_id IS NULL OR g.property_id = '') AND upper(btrim(g.country_code)) ~ '^[A-Z]{2}$'
   AND NOT EXISTS (SELECT 1 FROM app.ga4_property p WHERE p.brand_code = b.brand_code AND p.country_code = upper(btrim(g.country_code)))
 ORDER BY b.brand_code, upper(btrim(g.country_code)), g.updated_at DESC;
INSERT INTO app.ga4_tracked_event (property_id, event_name, updated_by, updated_at)
SELECT e.property_id, e.event_name, e.created_by, e.created_at
  FROM mig_src.ga4_tracked_events e JOIN app.ga4_property p ON p.property_id = e.property_id;

-- 4-12. 발행 리포트(0080 과 1:1, lib/db/schema.ts:1676·1721·1758)
INSERT INTO app.report_publication (id, slug, surface, brand_scope, volume, version, title, cycle_label, cycle_label_en, round_date,
  prev_round_date, asof_cur, asof_prev, published_on, engines, excluded_fs, bench_n, bench_n_all, src_cite, source_filename,
  source_sha256, manifest_verified, verify_note, sb_data_version, status, superseded_by, ingested_at)
SELECT id, slug, surface, brand_scope, volume, version, title, cycle_label, cycle_label_en, round_date,
  prev_round_date, asof_cur, asof_prev, published_on, engines, excluded_fs, bench_n, bench_n_all, src_cite, source_filename,
  source_sha256, manifest_verified, verify_note, sb_data_version, status, superseded_by, ingested_at
  FROM mig_src.report_publications;
INSERT INTO app.report_site_fact (publication_id, file_seq, brand, country_code, country_name, region_label, lang_code, lang_label,
  agency_status, in_headline_pool, target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, owned_answers,
  monitored_answers, prompts, answers, prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, raw)
SELECT publication_id, file_seq, brand, country_code, country_name, region_label, lang_code, lang_label,
  agency_status, in_headline_pool, target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den, owned_answers,
  monitored_answers, prompts, answers, prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, raw
  FROM mig_src.report_site_facts;
INSERT INTO app.report_site_engine_fact (publication_id, file_seq, engine, target_hit_prompts, prev_target_hit_prompts)
SELECT publication_id, file_seq, engine, target_hit_prompts, prev_target_hit_prompts FROM mig_src.report_site_engine_facts;

-- 4-13. 인용 출처 오버라이드: 도메인은 CHECK(소문자·www 없음)에 맞춰 정규화, 카테고리 이름 → category_key(택소노미 표).
INSERT INTO app.citation_domain_override (domain, category_key, note, updated_by, updated_at)
SELECT DISTINCT ON (d.dom) d.dom, c.category_key, o.note, o.updated_by, o.updated_at
  FROM mig_src.citation_domain_overrides o
  CROSS JOIN LATERAL (SELECT regexp_replace(lower(btrim(o.domain)), '^www\.', '') AS dom) d
  JOIN app.citation_category c ON c.name = o.category
 ORDER BY d.dom, o.updated_at DESC;

-- 4-14. 엔티티 레지스트리: own 행의 brand_code = resolveHmgBrandName(name)(lib/scope/hmg-brands.ts:132-137:
--       3사 정확 일치 → 대소문자 무시 → HMG 표기 알리아스). 해소 못 한 own 행은 CHECK 가 막아 시드 전체가 실패한다(조용히 버리지 않음).
INSERT INTO app.entity_registry (entity_id, name, role, brand_code, updated_by, updated_at)
SELECT e.entity_id, e.name, e.role,
       CASE WHEN e.role = 'own' THEN coalesce(
         (SELECT b.brand_code FROM app.brand b WHERE b.brand_code IN ('Hyundai', 'Kia', 'Genesis') AND b.brand_code = e.name),
         (SELECT b.brand_code FROM app.brand b WHERE b.brand_code IN ('Hyundai', 'Kia', 'Genesis') AND lower(b.brand_code) = lower(btrim(e.name))),
         (SELECT a.canonical_name FROM app.brand_display_alias a
           WHERE a.alias = btrim(e.name) AND a.canonical_name IN ('Hyundai', 'Kia', 'Genesis'))) END,
       e.updated_by, e.updated_at
  FROM mig_src.entity_registry e;
-- 명부에 own 행이 하나도 없으면 현행은 SEED_ROSTER(hmg-brands.ts:145-148)로 폴백한다. 같은 의미를 행으로 둔다.
INSERT INTO app.entity_registry (entity_id, name, role, brand_code)
SELECT v.id::uuid, v.name, 'own', v.name
  FROM (VALUES ('00000000-0000-0000-0000-000000000301', 'Hyundai'), ('00000000-0000-0000-0000-000000000302', 'Kia'),
               ('00000000-0000-0000-0000-000000000304', 'Genesis'),
               ('e0348d5f-afe4-48e6-aa99-1dee566f2822', 'Hyundai'), ('c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45', 'Hyundai'),
               ('65eabd79-6138-4851-8b58-8a9b0261b517', 'Hyundai'), ('ed4b8012-4a73-4174-9b43-4cb696934b25', 'Kia'),
               ('53a1ac82-6346-477d-9fb7-31d78b9248fa', 'Kia'), ('e21f66ad-9a28-46ab-8436-78ead06bd8f9', 'Kia'),
               ('fd2f4a33-8f9b-4a46-bfd0-62133d162d28', 'Genesis')) v(id, name)
 WHERE NOT EXISTS (SELECT 1 FROM app.entity_registry WHERE role = 'own')
ON CONFLICT (entity_id) DO NOTHING;

-- 4-15. 감사 원장(append-only, 원본 그대로. audit_id 는 IDENTITY 로 created_at 순 발급)
INSERT INTO app.prompt_audit_log (prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id, created_at)
SELECT prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id, created_at
  FROM mig_src.prompt_audit_logs ORDER BY created_at, id;
INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action, context, created_at)
SELECT project_id, actor_id, target_user_id, action::text, context, created_at
  FROM mig_src.member_audit_logs ORDER BY created_at, id;

-- ── 5. 앱 표 단언 ───────────────────────────────────────────────────────────
DO $a$ DECLARE v int; BEGIN
  SELECT count(*) INTO v FROM app.project WHERE kind = 'standard_root' AND scope_project_id IS NOT NULL;
  IF v <> 1 THEN RAISE EXCEPTION '표준 루트 프로젝트 %', v; END IF;
  SELECT count(*) INTO v FROM app.entity_registry WHERE role = 'own' AND brand_code IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION 'own 레지스트리 brand_code 미해소 %', v; END IF;
END $a$;


-- ── 6. 규칙 세트 지문(13개). 같은 지문이 이미 있으면 그 rule_ver 를 재사용, 없으면 새 버전 ─────────
--   파일 지문(sha256): psl = lib/public-suffix/data.ts, social = lib/citation-categorizer/official-social.ts,
--   category_seed = sha256(seed.json ‖ rules.ts ‖ taxonomy.ts 각 sha256). 나머지는 표 내용 md5(갱신 시각·행위자 열 제외, C 정렬).
CREATE TEMP TABLE _fp ON COMMIT DROP AS SELECT jsonb_build_object(
  'psl', '4430d16c91611b3b5c8b961f7bdc91d5e0b606b0f44cbc065c882228d1dd2d51', 'social', 'fdf15d4278acbd3dbaf70579b49babda407e7f1f300a750da5e8ae95c2d4a9c5', 'category_seed', 'f8b3f609b9a7299d6fe2d7876d19948bf3a29f2c3b1ee348517c35bbfbd79538',
  'owned_base', (SELECT md5(coalesce(string_agg(concat_ws('|', owner_key, kind, prefix, host, brand_code, geo_code, language), E'\n' ORDER BY owner_key), '')) FROM app.owned_base),
  'brand_prefix', (SELECT md5(coalesce(string_agg(concat_ws('|', brand_code, prefix, eval_order), E'\n' ORDER BY eval_order), '')) FROM app.brand_name_prefix),
  'brand_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias, canonical_name), E'\n' ORDER BY alias COLLATE "C"), '')) FROM app.brand_display_alias),
  'non_competitor', (SELECT md5(coalesce(string_agg(concat_ws('|', name, bare_only_pattern), E'\n' ORDER BY name COLLATE "C"), '')) FROM app.non_competitor_name),
  'competitor_token', (SELECT md5(coalesce(string_agg(concat_ws('|', token, brand_name), E'\n' ORDER BY token COLLATE "C"), '')) FROM app.competitor_domain_token),
  'entity_registry', (SELECT md5(coalesce(string_agg(concat_ws('|', entity_id, name, role, brand_code), E'\n' ORDER BY entity_id), '')) FROM app.entity_registry),
  'entity_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias_entity_id, canon_entity_id), E'\n' ORDER BY alias_entity_id), '')) FROM app.entity_alias),
  'hidden_market', (SELECT md5(coalesce(string_agg(concat_ws('|', surface, country_code), E'\n' ORDER BY surface, country_code), '')) FROM app.hidden_market),
  'rule_param', (SELECT md5(coalesce(string_agg(concat_ws('|', key, value::text), E'\n' ORDER BY key COLLATE "C"), '')) FROM app.rule_param),
  'website_catalog', (SELECT md5(coalesce((SELECT string_agg(concat_ws('|', site_id, brand_code, country_code, scope_project_id), E'\n' ORDER BY site_id) FROM app.website_site), '')
                        || coalesce((SELECT string_agg(concat_ws('|', website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, owned_base_url, scope_prompt_id), E'\n' ORDER BY website_prompt_id) FROM app.website_prompt), '')))
) AS fp;
INSERT INTO app.rule_set (fingerprints, note, created_by, applied_at)
SELECT fp, 'mirror_seed: 현행 코드 hmg-geo 2670a16 상수 + mig_src 앱 표', '5eed0000-0000-4000-8000-000000000001', now() FROM _fp
 WHERE NOT EXISTS (SELECT 1 FROM app.rule_set r WHERE r.fingerprints = (SELECT fp FROM _fp));

ALTER TABLE app.prompt ENABLE TRIGGER prompt_catalog_change;

-- ── 7. 단언 ────────────────────────────────────────────────────────────────
DO $a$ DECLARE v int; BEGIN
  SELECT count(*) INTO v FROM app.brand;               IF v <> 5   THEN RAISE EXCEPTION 'app.brand %', v; END IF;
  SELECT count(*) INTO v FROM app.citation_category;   IF v <> 13  THEN RAISE EXCEPTION 'app.citation_category %', v; END IF;
  SELECT count(*) INTO v FROM app.owned_base;          IF v <> 210 THEN RAISE EXCEPTION 'app.owned_base %', v; END IF;
  SELECT count(*) INTO v FROM app.non_competitor_name; IF v <> 158 THEN RAISE EXCEPTION 'non_competitor %', v; END IF;
  SELECT count(*) INTO v FROM app.hidden_market;       IF v <> 0 THEN RAISE EXCEPTION 'app.hidden_market %', v; END IF;
  SELECT count(*) INTO v FROM pg_trigger WHERE tgname = 'prompt_catalog_change' AND tgenabled = 'O';
  IF v <> 1 THEN RAISE EXCEPTION 'prompt_catalog_change 트리거 재활성화 실패'; END IF;
  SELECT count(*) INTO v FROM app.rule_set r, _fp WHERE r.fingerprints = _fp.fp; IF v <> 1 THEN RAISE EXCEPTION 'rule_set 지문 %', v; END IF;
END $a$;
COMMIT;

-- 결과 요약(트랜잭션 밖, 읽기)
SELECT 'rule_ver' AS k, max(rule_ver)::text AS v FROM app.rule_set
UNION ALL SELECT 'rule_set_rows', count(*)::text FROM app.rule_set;
