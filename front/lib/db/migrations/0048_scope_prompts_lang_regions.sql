-- scope_prompts.lang · scope_prompts.regions — 언어·시장 축을 미러에 도입 (H1).
--
-- 배경: 로컬 카탈로그는 0047 에서 `prompts.lang`·`prompts.regions` 를 가졌지만
-- **미러**(`scope_prompts`)는 여전히 `prompt_id·text·funnel_stage·is_korean` 4개뿐이라,
-- 집계가 "이 프롬프트가 어느 시장을 겨냥하는가"를 알 방법이 `text ~ '[가-힣]'`
-- 휴리스틱(`is_korean`)밖에 없었다. 44개 언어 라운드(12,164행)에서 그 휴리스틱은
-- 성립하지 않는다 — KO 가 아닌 43개 언어가 전부 "한글 아님"으로 뭉개진다.
--
-- scope 서버는 prompts 응답에 두 필드를 **이미 싣고 있다**(2026-08-29 라이브 API 확인:
-- 표준 루트 12,012행 중 regions 11,909 · lang 11,902 충전). 뒤처져 있던 것은
-- 클라이언트 계약 타입과 미러 스키마다. 이 마이그레이션은 그 그릇을 만든다.
--
--   lang    : ISO 639-1 대문자 시트 코드 (EN·KO·ES·AR·… — 번역 시트 탭 이름과 동일).
--   regions : 그 프롬프트가 담당하는 시장 코드 배열. 실국가는 ISO 3166-1 alpha-2,
--             비국가 사이트 슬롯은 `x:` 네임스페이스 의사코드(x:WW=Worldwide ·
--             x:EU=Europe Region · x:ME=Middle East(Region) · x:NBRAND=N brand ·
--             x:CPO=CPO). 접두사는 ISO 충돌 회피용이다 — 접두사 없는 `ME` 는
--             몬테네그로, `EU` 는 ISO 예약코드라 `scope_answers.region` 에 조인하는
--             순간 조용히 다른 시장이 된다. 0047 헤더와 같은 어휘다.
--
-- NULL = 미지정(상속). 기본값 없음 — 기존 16,110행은 전량 NULL 로 남고, 미러 싱크
-- (`lib/scope/mirror/sync.ts` → `scope-mirror.ts::upsertPrompts`)가 다음 패스부터
-- scope 응답값으로 채운다. 정본은 scope 이고 이 표는 읽기 전용 사본이다.
--
-- ⚠️ **is_korean(0046)을 걷어내지 않는다.** 집계 술어
-- (`scope-aggregates.ts::koreanNonKrExclusion`)가 아직 그것을 쓰고, 술어 교체(H3)의
-- 머지 게이트는 "이 컬럼들이 실측으로 충전됐는가"다. 순서를 뒤집으면 술어가
-- 무제외로 퇴화하거나(regions 전량 NULL) 반대로 전량 탈락한다 —
-- 표준 화면 전체 공백 사고 전력 2회(PR #74 의 208/208 탈락 포함).
--
-- 순수 additive·nullable·기본값 없음 → 테이블 리라이트 없음.
-- ⚠️ 그래도 `ADD COLUMN IF NOT EXISTS` 는 **no-op 이어도 ACCESS EXCLUSIVE 를 먼저
--    잡는다**(0045/0046 헤더의 797초 대기 실증). 그래서 카탈로그 선확인 DO 블록으로
--    "이미 있으면 락을 잡지 않고 통과"하게 감싼다.
--
-- 적용: npm run db:apply -- 0048

DO $$
BEGIN
  IF to_regclass('public.scope_prompts') IS NULL THEN
    RETURN; -- 테이블 미생성 환경(신규 부트스트랩 순서) — 다음 실행에서 처리
  END IF;
  IF (
    SELECT count(*) FROM pg_attribute
    WHERE attrelid = 'public.scope_prompts'::regclass
      AND attname IN ('lang', 'regions')
      AND NOT attisdropped
  ) = 2 THEN
    RETURN; -- 이미 적용됨 (out-of-band 선적용 포함) — 락 잡지 않고 통과
  END IF;

  ALTER TABLE public.scope_prompts ADD COLUMN IF NOT EXISTS lang text;
  ALTER TABLE public.scope_prompts ADD COLUMN IF NOT EXISTS regions text[];
END $$;
