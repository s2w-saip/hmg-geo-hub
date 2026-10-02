-- 계정별 메뉴 그룹 화이트리스트 (좁히기 전용, 2026-07-31 · migration 0039)
--
-- 메뉴 접근은 기존엔 role 로 고정 매핑됐다(route-policy). 이 컬럼으로 계정마다
-- 그 role 이 허용한 그룹 안에서 **축소**만 할 수 있다(예: hq 계정을 프로젝트
-- 메뉴만 보이게). NULL = 제한 없음(role 기본값) — 기존 계정 전부 무영향.
-- route-policy 가 role 허용 그룹과 교집합하므로 role 보다 넓게는 절대 못 준다
-- (권한 상승 방지). 값 = 'standard' | 'website' | 'project' | 'admin'.
-- 멱등: IF NOT EXISTS.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS menu_groups text[];
