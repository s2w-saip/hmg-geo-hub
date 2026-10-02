-- 엔티티 레지스트리(자사 명부) — "누가 자사인가"의 전사(워크스페이스) 공통 정의.
-- 2026-07-03 결정: 경쟁사는 태깅하지 않는다 — "언급된 브랜드 − 자사 = 경쟁사"가
-- 결정론적이므로 명부에는 자사(own)만 등재한다. 'excluded'는 향후 노이즈 엔티티
-- 제외용 예약 (집계 소비는 후속 배선).
-- 시드 = 기존 하드코딩(lib/scope/hmg-brands.ts)과 동일한 scope 고정 entity_id 3사.
-- 명부가 비면 코드가 시드로 폴백하므로 적용 전에도 동작이 변하지 않는다.

CREATE TABLE IF NOT EXISTS "entity_registry" (
  "entity_id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "role" text NOT NULL DEFAULT 'own' CHECK ("role" IN ('own', 'excluded')),
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "entity_registry" ("entity_id", "name", "role") VALUES
  ('00000000-0000-0000-0000-000000000301', 'Hyundai', 'own'),
  ('00000000-0000-0000-0000-000000000302', 'Kia', 'own'),
  ('00000000-0000-0000-0000-000000000304', 'Genesis', 'own')
ON CONFLICT ("entity_id") DO NOTHING;
