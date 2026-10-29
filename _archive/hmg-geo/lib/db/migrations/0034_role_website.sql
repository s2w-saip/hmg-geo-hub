-- 웹사이트 전용 열람 역할 추가 (2026-07-22 피드백: [글로벌X, 웹O, 프로젝트X])
--
-- 왜: 본인 공식 사이트 대시보드만 확인하는 계정이 필요하다. 역할은 메뉴(라우트)
-- 만 결정하고 데이터 범위는 기존 역할과 동일하게 프로필 scope(brand/region/
-- country)가 결정한다 — lib/auth/route-policy.ts(WEBSITE_VIEWERS)와
-- lib/auth/types.ts::Role 에 'website' 로 배선됨.
--
-- ALTER TYPE ... ADD VALUE 는 IF NOT EXISTS 로 idempotent (재실행 안전).
-- 적용: npm run db:apply -- 0034
--   (2026-07-23 DB 적용 완료 — 당시 파일명 0033이었으나 BFF 감사로그 0033과
--    번호가 겹쳐 0034로 재번호. idempotent라 번호 변경에 DB 영향 없음.)

ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'website';
