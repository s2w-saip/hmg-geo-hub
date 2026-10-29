-- 프롬프트 "브랜드 유무" 축 분리 (2026-07-22).
--
-- 지금까지 브랜드 포함 여부는 `brand` 컬럼 하나로 유추했다
-- (lib/scope/brand-presence.ts::brandPresenceOf — brand='HMG'면 unbranded).
-- 그런데 `brand`(어느 브랜드 카탈로그 소속인가)와 "브랜드 유무"(프롬프트 문구에
-- 브랜드명이 들어가는가)는 서로 다른 축이다. 예: Genesis 카탈로그 521개 중 355개는
-- 문구가 브랜드 무관(Generic)이다. 한 컬럼이 두 축을 겸직하다 보니 root 카탈로그
-- (brand = Genesis/Hyundai/Kia, HMG 0건)에서는 전 행이 'branded'로 판정돼
-- "브랜드 무관" 필터가 항상 0건인 죽은 필터였다.
--
-- 값은 3사 표준 프롬프트 framework 엑셀의 `brand 유무`(Hyundai 파일은 `브랜드 유무`)
-- 컬럼에서 적재한다 — O=branded / X=unbranded.
-- scripts/db/backfill-prompt-brand-presence.ts 참조.
--
-- nullable: website_prompts 등 이 축이 없는 카탈로그와, 아직 값이 확정되지 않은
-- 행은 null로 남는다. 필터는 다른 카탈로그 축과 동일하게 null을 제외 처리한다.
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS brand_presence text;

ALTER TABLE prompts DROP CONSTRAINT IF EXISTS prompts_brand_presence_check;
ALTER TABLE prompts ADD CONSTRAINT prompts_brand_presence_check
  CHECK (brand_presence IS NULL OR brand_presence IN ('branded', 'unbranded'));

-- 표준 프롬프트 화면의 필터가 이 축으로 좁힌다(프로젝트 루트 한정 조회).
CREATE INDEX IF NOT EXISTS prompts_project_brand_presence_idx
  ON prompts (project_id, brand_presence);
