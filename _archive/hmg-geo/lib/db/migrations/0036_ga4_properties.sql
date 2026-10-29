-- GA4 연동 레지스트리 (WBS 1.2.2, 2026-07-23)
--
-- brand × country → GA4 property_id 매핑을 코드/env(lib/ga4/property-map MAP)에서
-- DB로 이관한다. 온보딩 = 배포가 아니라 데이터 입력(admin UI). 설계: docs/ga4-
-- connection-permission-design.md.
--
-- 속성ID는 비밀이 아니다(비밀은 OAuth 자격뿐) → 평문 저장 무방.
-- 전환 안전: resolveProperty는 DB 우선 + 기존 env MAP 폴백 → 라이브(Kia/IT) 무중단.
--   (DB에 행이 없으면 env로 폴백, admin이 등록하면 DB가 이김.)
-- 마이그 번호: 0035는 wbs/fe-4.1.5-project-labeling가 선점 → GA는 0036.
-- 멱등: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS.

CREATE TABLE IF NOT EXISTS ga4_properties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand         text NOT NULL,
  country_code  text NOT NULL,          -- ISO alpha-2 (property-map MAP.country와 동일)
  property_id   text,                   -- GA4 Data API 속성ID (null = 속성ID 미확정)
  status        text NOT NULL DEFAULT 'pending_grant', -- active | pending_grant | unmapped
  granted_at    timestamptz,            -- 우리 계정에 뷰어 권한 부여된 시각
  verified_at   timestamptz,            -- probe read로 실제 접근 검증된 시각
  created_by    uuid NOT NULL,          -- = profiles.id (no FK — schema 이식성 방침)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ga4_properties_brand_country_idx
  ON ga4_properties (brand, country_code);

ALTER TABLE ga4_properties DROP CONSTRAINT IF EXISTS ga4_properties_status_check;
ALTER TABLE ga4_properties ADD CONSTRAINT ga4_properties_status_check
  CHECK (status IN ('active', 'pending_grant', 'unmapped'));
