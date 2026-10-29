-- 0069 — 집계층 `summary_trend_brands` 에 **답변 안 경쟁 순위** 2컬럼 (PR④-b).
--
-- 한 줄: 카드 ④(당사 우선노출도)와 그 **바로 아래 경쟁사 행**이 같은 축을 쓰게 만든다.
--
-- ⚠️⚠️ 적용 절차 (0067 D1 과 **같은 함정** — 이 파일만 적용하고 끝내면 값이 안 나온다):
--   두 컬럼은 집계층 규약대로 `NOT NULL DEFAULT 0` 이라, 적용 순간 **기존 309,037행**
--   (실측 2026-09-10: 글로벌 241,069 · 웹사이트 67,968 · 회차 631개)이 전부 **0** 이 된다.
--   0 은 "순위가 없었다" 와 구분되지 않는다 — 리더는 `comp_ranked_answers > 0` 일 때만
--   나누므로 화면에는 **에러가 아니라 빈칸(—)** 으로 나온다. 그래서 눈에 안 띈다.
--   → 해소는 타입이 아니라 **절차**다. 적용 직후 반드시 두 표면을 각각 refold:
--
--   ⓪ refold **전에** 접기 SELECT 를 1회 돌려 값부터 본다(쓰기 없음 · 회차 하나면 충분):
--
--       npx tsx --env-file=.env.local scripts/summary/fold-dryrun.ts \
--         --surface=global --cycle=74eca7fb-6ec8-4810-ba8f-123e1bd57f12
--
--      왜 먼저 보나: refold 는 **덮어쓰기**라 값이 틀린 채로 돌면 되돌릴 것이 회차 전량이다.
--      dry-run 은 같은 SELECT 를 INSERT 없이 돌려 두 칸이 실제로 채워지는지(그리고 PK 중복
--      0 인지)를 먼저 보여 준다. 나오는 경쟁 순위는 아래 정본표의 "경쟁 순위" 열과 같은
--      스코프다 — Hyundai ≈ 3.3469 가 그 회차의 기대값이다.
--
--   ① 그 다음 두 표면을 각각 refold:
--
--       npm run summary:generate -- --surface=global  --refold --all-published --yes
--       npm run summary:generate -- --surface=website --refold --all-published --yes
--
--   세 플래그가 **전부** 필요하다(0067 헤더에 근거가 있다): `--surface` 가 없으면 usage 로
--   즉시 종료하고(generate-cycle.ts:246), `--yes` 가 없으면 `APPLY=false` → DRY-RUN 이라
--   아무것도 안 덮인다. 하나라도 빠지면 이 절차 자체가 조용한 no-op 이 된다.
--
--   확인: SELECT count(*) FROM summary_trend_brands WHERE comp_ranked_answers > 0;
--         비교 모수 = `ranked_answers > 0` 인 **309,037행**(실측 = 전 행). 성공하면 그와
--         같은 자릿수의 양수가 나온다. **0 이면 refold 가 안 돈 것**이다.
--
--   ⚠️ `--refold` 는 **세부층을 건드리지 않는다** — 경쟁 순위는 `summary_brand_mentions`
--      안에서 job 창 함수로 전부 계산되므로(fold.ts 의 `bp`→`rk`) 세부층 재생성이 필요 없다.
--      즉 이 마이그레이션에 딸린 백필은 **없고**, 대량 UPDATE 도 없다.
--
-- 화면 영향: 이 두 컬럼을 읽는 유일한 소비자는 `S1.competitors`(PR④ B1) 이고, 그 키는
--   `SUMMARY_SCREEN_OPT_IN` 이라 **`read_screens` 에 이름을 적기 전에는 꺼져 있다**.
--   즉 적용~refold 사이의 창에도 고객 화면은 미러 경로 그대로다.
--   리더는 컬럼 부재까지 견딘다(`SYNC_PROBED_COLUMNS` 의 `summary_trend_brands.comp_rank_sum`
--   프로브 → 없으면 상수 0 을 SELECT) — **적용보다 배포가 먼저여도 42703 이 안 난다.**
--
-- 규약 (0065·0066·0067 과 동일):
--   · 멱등 — 재실행 안전. `IF NOT EXISTS` 금지(no-op 이어도 락을 먼저 잡는다) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → `CONCURRENTLY` 불가.
--   · additive-only — 이 파일에 DROP 은 **하나도 없다**. 기존 컬럼도 타입도 안 바꾼다.
--   · `summary_*` 계열이라 `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0068 과 같은 자세).
--   · 번호 — 0068 은 `0068_summary_trend_s1_cover_idx.sql`(PR④ A2)이 선점했다(확인함:
--     `git ls-tree b3da5f3 lib/db/migrations/`). 그래서 이 파일은 0069 다.
--
-- ── 왜 새 컬럼인가 (기존 `rank_sum` 을 못 쓰는 이유) ─────────────────────────
-- `summary_trend_brands.rank_sum` 은 **본문 텍스트 내 서수**(`first_rank`)의 합이고,
-- `summary_trend_own.rank_sum` 은 **답변 안 경쟁 순위**(표시명 접기 → `rank()`)의 합이다.
-- 같은 이름이지만 다른 양이다(fold.ts 머리 주석이 정본).
--
-- ⭐ **두 축 실측 대조표의 정본은 여기다** — 다른 파일(`screens.ts`·`fold.ts`·
--    `summary-global-aggregates.ts`)은 이 표를 참조만 하고 숫자를 복사하지 않는다.
--    복사본 셋이 서로 다른 값을 들고 있던 것이 PR④-b 검증자 F4 다.
--
--   기준(2026-09-11 재현): 글로벌 회차 `74eca7fb` · gen `3c875d32` ·
--   **접기(fold) 스코프** = 세부층 `summary_brand_mentions` 전수 · `is_competitor = 1`
--   AND `first_rank IS NOT NULL` · **numeric 누적**. 조회 게이트(`in_root_catalog`·
--   `in_tagged_region`·`in_full_cycle`·`run_status`·숨김국가)는 **걸지 않는다** —
--   이 표의 목적은 "같은 행집합 위에서 두 정의를 비교"하는 것이기 때문이다.
--   ⚠️ 리더가 화면에 내는 값은 그 게이트가 걸린 값이라 소수 둘째 자리부터 다르다
--      (실측 Hyundai 경쟁 3.3469 → 게이트 후 3.3566). 화면 값과 이 표를 등호로 잇지 마라.
--
--   | 브랜드 | 서수(rank_sum/ranked_answers) | 경쟁 순위(comp_rank_sum/comp_ranked_answers) |
--   | Hyundai       | 16.4041 | 3.3469 |
--   | Kia           | 17.3410 | 3.6253 |
--   | Genesis       | 18.3362 | 3.5407 |
--   | Tesla         | 18.9899 | 3.9765 |
--   | Toyota        | 19.5979 | 4.1950 |
--   | BMW           | 23.2787 | 5.2305 |
--   | Mercedes-Benz | 23.8676 | 5.4067 |
--
-- 오른쪽이 미러(`scope-aggregates.ts:3362-3371`)와 일치한다. 카드 ④는 **2.6**(경쟁 순위 축)
-- 이므로, 경쟁사 행에 왼쪽을 쓰면 같은 카드 안에서 2.6 옆에 19+ 가 선다.
-- `rank_sum` 을 **덮어쓰지 않는 이유**: GEO 위젯(`summary-global-aggregates.ts::toGeoKpi`
-- 의 `posSum`/`posCnt`)이 그 정의를 소비한다. 덮으면 그 위젯이 조용히 바뀐다.
--
-- ── 타입·락·소요 ─────────────────────────────────────────────────────────────
--   `comp_rank_sum real` — `rank_sum` 과 같은 타입. 순위 합이라 정수지만 `real` 로 두어
--     기존 열과 형을 맞춘다(리더가 `double precision` 으로 합산). **단 NOT NULL 이다** —
--     `rank_sum` 은 0059 에서 nullable 이었지만(순위 없는 브랜드 = NULL), 새 컬럼은
--     접기가 항상 값을 넣으므로(`COALESCE(sum(...), 0)`) 집계층 규약(0065)을 따른다.
--   `comp_ranked_answers int` — `ranked_answers` 와 같은 타입·같은 NOT NULL.
--
--   락 (2026-09-10 실측): `summary_trend_brands` 는 **파티션이 아니다**(자식 0). 단일 표
--   **309,037행 · 힙 167 MB · 인덱스 포함 449 MB**.
--   `ADD COLUMN <type> NOT NULL DEFAULT <상수>` 는 PG 11+ 에서 **메타데이터 전용** —
--   기본값이 volatile 이 아니므로 테이블을 다시 쓰지 않는다(`pg_attribute.atthasmissing`
--   경로). 따라서 167 MB 를 재기록하지 않고 **밀리초**다.
--   ⚠️ 그래도 `ACCESS EXCLUSIVE` 는 **읽기까지 막는다** — 생성 러너·S1 조회가 도는 중이면
--      그동안 대기한다. `lock_timeout='3s'` 가 대기 상한을 준다. 못 잡으면 파일 전체가
--      깨끗이 중단된다(재시도 가능 — 이 파일은 멱등이다).

SET LOCAL lock_timeout = '3s';

-- ── ⓪ 트랜잭션 블록 가드 (0065·0066·0067 과 동일) ────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
-- 그 상태로 449 MB 표에 ACCESS EXCLUSIVE 를 걸면 무한 대기다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0069: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ① summary_trend_brands.comp_rank_sum / comp_ranked_answers ───────────────
-- 컬럼마다 카탈로그 선확인 → ALTER (0067 과 같은 형태). 한 tx 안이라 두 번째 ALTER 는
-- 이미 잡은 ACCESS EXCLUSIVE 를 재사용한다 — 락을 두 번 기다리지 않는다.
DO $do$
BEGIN
  IF to_regclass('public.summary_trend_brands') IS NULL THEN
    RAISE EXCEPTION '0069: summary_trend_brands 가 없다 — 0059 를 먼저 적용할 것';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_trend_brands'::regclass
      AND attname = 'comp_rank_sum' AND attnum > 0 AND NOT attisdropped
  ) THEN
    -- 집계층 규약(0065·0067)대로 NOT NULL DEFAULT 0 — 접기가 항상 값을 넣는다.
    EXECUTE 'ALTER TABLE public.summary_trend_brands ADD COLUMN comp_rank_sum real NOT NULL DEFAULT 0';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_trend_brands'::regclass
      AND attname = 'comp_ranked_answers' AND attnum > 0 AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE public.summary_trend_brands ADD COLUMN comp_ranked_answers int NOT NULL DEFAULT 0';
  END IF;
END
$do$;

COMMENT ON COLUMN summary_trend_brands.comp_rank_sum IS
  '답변 안 **경쟁 순위** 합 — (job, 표시명)으로 접은 min(first_rank) 위에 rank() OVER (PARTITION BY job_id ORDER BY tp) 를 매기고 그 순위를 더한 값. summary_trend_own.rank_sum(카드 ④)과 **같은 축**이고, 같은 표의 rank_sum(본문 텍스트 내 서수 first_rank 합)과는 **다른 양**이다. 순위 그레인이 표시명이라 한 표시명에 brand_id 가 여럿이면 접기가 min(brand_id) 대표 행 하나에만 싣는다(이중 계상 방지) — 소비는 반드시 brand_name 롤업으로 할 것. 소비자: S1.competitors 의 avgPosition = comp_rank_sum / comp_ranked_answers.';

COMMENT ON COLUMN summary_trend_brands.comp_ranked_answers IS
  'comp_rank_sum 의 분모 — 그 브랜드(표시명)가 순위를 받은 답변 수. 미러 posagg.pos_cnt 와 같은 정의. ranked_answers(브랜드 행 기준 개수)와 달리 표시명당 답변 1회만 센다.';

-- ── ② ACL ────────────────────────────────────────────────────────────────────
-- 새 표·함수를 만들지 않았다(컬럼 2개뿐) — 컬럼 추가는 표 ACL 을 바꾸지 않는다.
-- 그래도 0059·0064~0067 관례대로 한 번 더 닫는다. 이 표는 파티션이 아니라 자식이 없다
-- (실측: pg_inherits 자식 0) — 그래서 0067 의 자식 순회가 여기엔 없다.
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON public.summary_trend_brands FROM PUBLIC, anon, authenticated';
END
$do$;

-- ── ③ 적용 후 (백필 없음 — refold 가 전부다) ────────────────────────────────
--   대량 UPDATE 가 **없다**. 이 값은 세부층에서 계산되는 파생값이라 원천이 이미 있고,
--   집계층은 언제든 재생성된다. 그래서 절차는 위 헤더의 refold 두 줄이 전부다.
--
--   refold 뒤 정합 확인 (읽기 전용 — 회차 하나로 충분하다):
--   SELECT sum(comp_rank_sum)::numeric / NULLIF(sum(comp_ranked_answers), 0) AS avg_comp_rank
--   FROM summary_trend_brands b
--   JOIN summary_cycles c ON c.cycle_id = b.cycle_id AND c.active_generation_id = b.generation_id
--   WHERE c.cycle_id::text LIKE '74eca7fb%' AND b.is_competitor = 1 AND b.brand_name = 'Hyundai';
--   -- 기대: **≈ 3.3469** (위 정본표의 경쟁 순위 열 — 이 쿼리의 스코프가 정확히 그 접기
--   --   스코프다. 2026-09-11 재현: 같은 형태의 서수판이 표의 16.4041 을 그대로 낸다.)
--   -- ⚠️ **3.35 반올림 경계 바로 아래**라 소수 첫째 자리로 자르면 3.3 이다. 종전 헤더가
--   --    적어 둔 "3.4" 는 미러 표기(반올림 후 경계를 넘은 값)를 옮긴 것이라 틀렸다 —
--   --    0 이 아니라 **3.3 대**가 나오면 성공이고, 판정은 자릿수로 하지 마라.
--
--   통계: `ADD COLUMN … DEFAULT` 는 통계를 만들지 않지만 이 두 컬럼은 **술어에 안 쓰인다**
--   (리더는 SELECT 목록에서 sum 할 뿐이다). 그래서 0067 D4 같은 ANALYZE 강제는 없다.
--   refold 의 INSERT 가 autovacuum 을 유발하므로 그대로 둔다.

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 락 가드를 함께 넣을 것 — DROP COLUMN 도 ACCESS EXCLUSIVE 다.
--   ⚠️ 순서 — **코드를 먼저 되돌리고** 컬럼을 지운다. 반대로 하면 리더의 동기 프로브가
--      TTL(60s) 안에는 아직 "있다"로 굳어 있어 그 사이 요청이 42703 을 받는다.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE summary_trend_brands DROP COLUMN comp_rank_sum, DROP COLUMN comp_ranked_answers;
--   COMMIT;
--   -- 되돌린 뒤 경쟁사 행 avgPosition 은 다시 **미러 폴백**(S1.competitors 를 끄면 된다).
