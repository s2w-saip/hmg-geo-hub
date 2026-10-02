-- 0056: 제네시스 사우디 웹사이트를 도시별 사이트 3곳(담맘·제다·리야드)으로 분리.
-- 적용: npm run db:apply -- 0056   (제품 책임자 실행. drizzle-kit migrate 금지)
--
-- ── 왜 ────────────────────────────────────────────────────────────────────────
-- genesis.com/sa-{dammam,jeddah,riyadh} 는 각각 따로 측정하는 사이트(파일 114·116·117,
-- 69·93·84 프롬프트)인데 2026-07-27 시드가 `website_sites (Genesis, SA)` 한 행으로
-- 합쳤다. website 표면의 국가 필터·계정 스코프는 사이트 단위라 도시를 고를 수 없었고,
-- 계정 genesis-sa-{dammam,jeddah,riyadh} 셋이 전부 같은 데이터를 봤다(2026-09-05 제품 책임자 제보).
-- 베이징현대(CN-BJ)가 이미 쓰는 방식 그대로 의사 국가코드로 나눈다.
--
-- ── 재측정 없음 ───────────────────────────────────────────────────────────────
-- scope 프로젝트(88cc02dc-…)는 셋이 **공유**한다. 필터 술어(scope-aggregates::websiteCountry)
-- 는 website_prompts → website_sites.country_code 로 프롬프트 단위에서 갈라지므로
-- 기존 답변 8,288건(114: 2,315 / 116: 3,180 / 117: 2,793)이 그대로 도시별로 나뉜다.
-- 코드 쪽은 프로젝트 id 중복 제거(getProjectIdsForScope 등)로 공유를 받아들인다.
--
-- ── 멱등 ─────────────────────────────────────────────────────────────────────
-- 재실행 시 이미 옮긴 행은 조건에 안 걸린다. 적용기(apply-migration.ts)가 파일 전체를 한
-- 트랜잭션으로 돌리므로 마지막 DO 블록이 결과를 단언한다 —
-- 프롬프트 69/93/84 가 아니면 예외로 롤백된다.


-- 1. 제다·리야드 사이트 행 생성(기존 SA 행과 같은 scope 프로젝트 공유)
INSERT INTO website_sites (brand, country_code, scope_project_id)
SELECT 'Genesis', c.code, s.scope_project_id
FROM (VALUES ('SA-Jeddah'), ('SA-Riyadh')) AS c(code)
JOIN website_sites s ON s.brand = 'Genesis' AND s.country_code IN ('SA', 'SA-Dammam')
ON CONFLICT (brand, country_code) DO NOTHING;

-- 2. 파일 116(제다)·117(리야드) 프롬프트를 새 사이트로 이동
UPDATE website_prompts wp
SET site_id = dst.id, updated_at = now()
FROM website_sites src, website_sites dst
WHERE wp.site_id = src.id
  AND src.brand = 'Genesis' AND src.country_code IN ('SA', 'SA-Dammam')
  AND dst.brand = 'Genesis'
  AND dst.country_code = CASE wp.file_seq WHEN 116 THEN 'SA-Jeddah' WHEN 117 THEN 'SA-Riyadh' END;

-- 3. 남은 SA 행(담맘, 파일 114)의 코드를 SA-Dammam 으로
UPDATE website_sites
SET country_code = 'SA-Dammam', updated_at = now()
WHERE brand = 'Genesis' AND country_code = 'SA'
  AND NOT EXISTS (SELECT 1 FROM website_sites x WHERE x.brand = 'Genesis' AND x.country_code = 'SA-Dammam');

-- 4. 도시 계정 스코프 — 베이징현대 계정(['CN-BJ','CN'])과 같은 꼴. 모국 SA 를 남겨
--    표준 표면(scope_answers.region = 'SA')이 계속 보이게 한다.
UPDATE profiles
SET countries = ARRAY['SA-' || initcap(split_part(split_part(email, '@', 1), '-', 3)), 'SA']
WHERE split_part(email, '@', 1) IN ('genesis-sa-dammam', 'genesis-sa-jeddah', 'genesis-sa-riyadh')
  AND NOT (countries @> ARRAY['SA-' || initcap(split_part(split_part(email, '@', 1), '-', 3))]);

-- 5. 단언
DO $$
DECLARE
  n_dammam int; n_jeddah int; n_riyadh int; n_sa int; n_proj int;
BEGIN
  SELECT count(*) INTO n_dammam FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
   WHERE ws.brand = 'Genesis' AND ws.country_code = 'SA-Dammam';
  SELECT count(*) INTO n_jeddah FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
   WHERE ws.brand = 'Genesis' AND ws.country_code = 'SA-Jeddah';
  SELECT count(*) INTO n_riyadh FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
   WHERE ws.brand = 'Genesis' AND ws.country_code = 'SA-Riyadh';
  SELECT count(*) INTO n_sa FROM website_sites WHERE brand = 'Genesis' AND country_code = 'SA';
  SELECT count(DISTINCT scope_project_id) INTO n_proj FROM website_sites
   WHERE brand = 'Genesis' AND country_code IN ('SA-Dammam', 'SA-Jeddah', 'SA-Riyadh');
  IF n_dammam <> 69 OR n_jeddah <> 93 OR n_riyadh <> 84 OR n_sa <> 0 OR n_proj <> 1 THEN
    RAISE EXCEPTION '0056 assertion failed: dammam=% jeddah=% riyadh=% sa_rows=% projects=%',
      n_dammam, n_jeddah, n_riyadh, n_sa, n_proj;
  END IF;
END $$;

