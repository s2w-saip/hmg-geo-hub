-- 자국어 표기 알리아스 entity 7행을 레지스트리에 등재 — 코드 시드(hmg-brands.ts
-- SEED_ROSTER/HMG_BRAND_ALIAS_ENTITY_IDS)와 레지스트리의 드리프트 해소.
-- 배경(2026-08-06 고객 피드백 #6): 레지스트리에 정본 3행만 있으면 시드 폴백이
-- 꺼지고(roster 비어있지 않음) rollupCanonicalPairs 도 빈 배열이 되어, 알리아스
-- entity_id('제네시스' 등)가 당사 판정·표기 병합에서 빠져 경쟁사로 집계됐다.
-- PR#40 시점의 등재는 수동 DB 작업이라 환경 간 재현이 안 됐다 — 여기서 고정.
-- name 은 SEED_ROSTER 규약대로 정본 브랜드명 (trackedRosterFor 의 brand 필터
-- 교집합과 rollupCanonicalPairs 의 이름 해석이 이 값을 전제).

INSERT INTO "entity_registry" ("entity_id", "name", "role") VALUES
  ('e0348d5f-afe4-48e6-aa99-1dee566f2822', 'Hyundai', 'own'),  -- 현대자동차
  ('c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45', 'Hyundai', 'own'),  -- هيونداي
  ('65eabd79-6138-4851-8b58-8a9b0261b517', 'Hyundai', 'own'),  -- יונדאי
  ('ed4b8012-4a73-4174-9b43-4cb696934b25', 'Kia', 'own'),      -- 기아
  ('53a1ac82-6346-477d-9fb7-31d78b9248fa', 'Kia', 'own'),      -- كيا
  ('e21f66ad-9a28-46ab-8436-78ead06bd8f9', 'Kia', 'own'),      -- קיה
  ('fd2f4a33-8f9b-4a46-bfd0-62133d162d28', 'Genesis', 'own')   -- 제네시스
ON CONFLICT ("entity_id") DO NOTHING;
