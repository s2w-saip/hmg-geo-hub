-- 커스텀 태그를 텍스트 단일 타입으로 단순화 (2026-07-08 결정) — select/bool
-- 타입·옵션 목록 관리가 실사용 대비 과한 복잡도라 판단, 프롬프트당 자유 텍스트
-- 값 하나로 축소. prompt_custom_field_values.value는 그대로 유지(기존 "true"/
-- "false" bool 값도 유효한 텍스트라 데이터 손실 없음).

ALTER TABLE "project_custom_fields" DROP COLUMN IF EXISTS "type";
ALTER TABLE "project_custom_fields" DROP COLUMN IF EXISTS "options";
