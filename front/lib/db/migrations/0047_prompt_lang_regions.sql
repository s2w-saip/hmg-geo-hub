-- 글로벌 프롬프트 다국어 라운드 (2026-08-28): 카탈로그에 언어·시장 축 도입.
--
-- 배경: 번역 시트 3종(Hyundai 292×19 · Kia 208×26 · Genesis 151×8 = 12,164행)을
-- 표준 카탈로그의 정본으로 적재하면서, 종전의 "한글 정규식으로 KO/EN 을 판별"
-- 하던 휴리스틱이 44개 언어에서는 성립하지 않게 됐다. 언어는 컬럼으로 저장한다.
--
--   lang    : ISO 639-1 대문자 시트 코드 (EN·KO·ES·AR·… — 번역 시트 탭 이름과 동일)
--   regions : 그 언어가 담당하는 시장 코드 배열. 실국가는 ISO 3166-1 alpha-2,
--             비국가 사이트 슬롯은 `x:` 네임스페이스 의사코드(x:WW=Worldwide ·
--             x:EU=Europe Region · x:ME=Middle East(Region) · x:NBRAND=N brand ·
--             x:CPO=CPO). 접두사는 ISO 충돌 회피용이다 — 접두사 없는 `ME` 는
--             몬테네그로(country-numeric.ts ME=499), `EU` 는 ISO 예약코드라
--             scope_answers.region 에 조인하는 순간 조용히 다른 시장이 된다.
--             NULL = 미지정(상속) — H1~H6 플랜의 로컬 정본 컬럼과 같은 시맨틱.
--
-- 운영 DB 에는 2026-08-28 Supabase SQL Editor 로 선적용됐다(0044 와 같은 회수 패턴).
-- 순수 additive ALTER — 테이블 리라이트 없음.
--
-- 적용: npm run db:apply -- 0047

ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "lang" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "regions" text[];
