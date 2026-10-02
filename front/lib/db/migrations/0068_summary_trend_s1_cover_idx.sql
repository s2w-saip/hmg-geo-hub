-- 0068 (PR④ A2) — S1 카드 read 커버링 인덱스 2개. **값은 바뀌지 않는다**(인덱스만).
--
-- ⚠️⚠️ 적용 절차 (0045·0050 과 동일 규약 — 이 파일만 db:apply 하면 락에 걸린다)
--   `CREATE INDEX` 는 `IF NOT EXISTS` 든 아니든 **ACCESS EXCLUSIVE 를 먼저 잡는다**
--   (0045 실측: no-op 인데 797초 대기). 그리고 `db:apply` 는 파일 전체를 한 트랜잭션으로
--   감싸므로(scripts/db/apply-migration.ts) `CONCURRENTLY` 를 이 파일에 넣을 수 없다.
--   → 프로덕션에는 **아래 두 문장을 손으로, 트랜잭션 밖에서, 하나씩 직렬로** 먼저 돌린다.
--     (CONCURRENTLY 는 같은 표에 동시 두 개를 못 돈다 — 반드시 하나 끝내고 다음.)
--
--       -- ① brands (프로덕션 실적용 2026-09-10 08:46Z · 온라인 · 쓰기 차단 없음 · 30 MB)
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS summary_trend_brands_s1_cover
--         ON public.summary_trend_brands
--            (surface, cycle_id, generation_id, project_id, brand_name, country)
--         INCLUDE (cycle_anchor_at, engine, brand_id,
--                  run_status, is_competitor, in_root_catalog, in_tagged_region, in_full_cycle,
--                  mentions, answers, rank_sum, ranked_answers, top3_answers,
--                  positive, neutral, negative, mixed,
--                  type_mention, type_recommendation, type_comparison,
--                  type_definition, type_final_choice)
--         WHERE is_competitor = 1 AND in_root_catalog = 1 AND in_tagged_region = 1
--           AND in_full_cycle = 1 AND run_status IN ('completed', 'partial_failed');
--
--       -- ② domains **v2** (①이 끝난 뒤. 프로덕션 실적용 2026-09-10 · 4.2 s · 25 MB)
--       CREATE INDEX CONCURRENTLY summary_trend_domains_s1_cover_v2
--         ON public.summary_trend_domains
--            (surface, cycle_id, generation_id, project_id, country, engine, group_key, domain)
--         INCLUDE (cycle_anchor_at, matched_base, base_norm_null,
--                  run_status, in_root_catalog, in_tagged_region, in_full_cycle,
--                  citations, citing_answers)
--         WHERE in_root_catalog = 1 AND in_tagged_region = 1 AND in_full_cycle = 1
--           AND run_status IN ('completed', 'partial_failed');
--       -- ⚠️ 부분 술어(WHERE)를 빠뜨리면 **다른 인덱스**가 된다. 아래 DO 블록의
--       --    `$ddl$ … $ddl$` 본문이 정본이고 이 요약과 문자 그대로 같아야 한다.
--
--       -- ③ 통계. **필수** — 새 인덱스는 통계 없이 태어나고, 부분 인덱스는 플래너가
--       --    reltuples 로 선택도를 잡는다. 안 돌리면 플래너가 이 인덱스를 안 고를 수 있다.
--       ANALYZE public.summary_trend_brands;
--       ANALYZE public.summary_trend_domains;
--
--   그 다음 `npm run db:apply -- 0068` 을 돌리면 아래 DO 블록이 카탈로그를 **먼저 확인**하고
--   락 없이 통과한다. (새 환경 구축에서는 DO 블록이 실제로 만든다 — 그때는 표가 비어 있다.)
--
--   ⚠️ `CREATE INDEX CONCURRENTLY` 가 실패하면 **INVALID 인덱스가 남는다**. 그러면
--      `DROP INDEX CONCURRENTLY <이름>;` 로 지우고 다시 만든다. 아래 DO 블록은
--      `to_regclass` 로만 존재를 보므로 INVALID 도 "있다"로 본다 — 적용 전에
--      `SELECT indisvalid FROM pg_index WHERE indexrelid = 'summary_trend_brands_s1_cover'::regclass;`
--      로 유효성까지 확인할 것.
--
-- ── 왜 domains 만 `_v2` 인가 (2026-09-10 실측 · 이 파일의 개정 사유) ──────────
-- 초판(b3da5f3)의 domains 인덱스는 키가
--   `(surface, cycle_id, generation_id, project_id, country, group_key, domain)`
-- 이고 `engine` 이 **키에도 INCLUDE 에도 없었다**. 그 결과 두 가지가 동시에 났다:
--   ① `engine` 필터가 인덱스에서 판정되지 않아 **행마다 heap 을 되짚었다**
--      (Index Only Scan → 그냥 Index Scan). 필터 조합에서 shared hit 248 → **4,951**.
--   ② 인용 화면의 `(engine, group_key)` 문장(`summary-citation-read.ts::
--      trendEngineCategorySql`)은 무필터에서 **3,409 → 68,013 buffers**, 75.9 → 91.1 ms
--      로 **느려지기까지** 했다. 카드 3문장만 보던 초판 근거가 놓친 경로다.
-- v2 는 `engine` 을 **키 6번째**(country 다음)에 넣는다. 두 컬럼이 연속 경계가 되어
-- 스캔 범위 자체가 줄고(한 회차 72,327 튜플 → country=KR,US 5,291 → +chatgpt 2,414),
-- heap 되짚기가 사라진다. domains 문장의 집계는 전부 hash(`MixedAggregate` Hash Key)라
-- 키 뒤쪽 순서로 정렬 이득을 만들 것이 없다 — 그 자리를 필터에 쓰는 것이 순이득이다.
--
-- ⚠️ 초판 domains 인덱스(`summary_trend_domains_s1_cover`)는 **프로덕션에서만** 존재했고
--    2026-09-10 에 `DROP INDEX CONCURRENTLY`(183 ms) 로 제거했다. 이 파일은 아직 어느
--    환경에도 `db:apply` 된 적이 없으므로(브랜치 미머지) 다른 환경에는 애초에 없다 —
--    그래서 이 파일에 DROP 문을 넣지 않는다(additive-only 유지).
--
-- ── brands 는 초판 그대로 둔다 (문서화된 트레이드) ───────────────────────────
-- brands 는 **세 경로가 서로 다른 선두 컬럼을 원한다**. 한 인덱스로 둘 다 만족시킬 수
-- 없다(PostgreSQL **17.6** — btree skip scan 은 18부터):
--
--   경로                                   원하는 경계 컬럼   현재 키(brand_name 5번째)
--   카드 필터(region+engine)               country, engine    ✗ 범위 미축소 (2,410 buf)
--   B2 브랜드 시계열(`brand_name = ANY`)   brand_name         ✓ 21,236 튜플 → 701 buf
--   카드 무필터                            없음(전 범위)      2,410 buf
--
-- 비경계 증거(2026-09-10): 필터 조합의 shared hit 2,410 이 **무필터와 완전히 같다** —
-- `country = ANY` 가 Index Cond 에 찍혀도 스캔 범위를 전혀 줄이지 않는다는 뜻이다.
-- 경계 증거: `brand_name = ANY(top-4)` 는 **13회차**인데 701 buffers 로 끝난다.
--
-- 키를 `(… project_id, country, engine, brand_name)` 로 바꾸면 카드 필터는 좋아지지만
-- B2 가 부분 인덱스 전량(135,695 튜플 ≈ 3,840 페이지)을 훑게 된다 — **기각**했다.
-- brands 인덱스를 2개 병존시키는 안도 주간 증가 예산(≤40 MB/주, 현재 15~30)을 깨서 기각.
-- 남는 비용은 **카드 필터 조합 brands 16.9 → 38.0 ms(+21 ms)** 하나이고, 같은 인덱스가
-- 무필터를 233 → 165 ms(−68 ms) 로 줄인다. wall 기준 순이득이라 트레이드로 받는다.
--
-- ── 실측 매트릭스 (프로덕션 · EXPLAIN ANALYZE BUFFERS · warm 3회 중앙값) ─────
-- 대상 = 집계층 리더가 실제로 내보내는 문장 18개(리더 코드에서 생성 — 카드 6문장은
-- 검증자 기준선과 바이트 동일). 회차 74eca7fb(2026-08-31 앵커, generation 3c875d32,
-- project be28fe15), 기간 모드는 최근 13회차, 필터 조합은 `region=KR,US` + `engine=chatgpt`.
--
--   문장                        0068 이전         초판(v1)            v2
--   ─────────────────────────── ───────────────── ─────────────────── ─────────────────
--   [무필터]
--   card_domains                178.6 ms /  3,409 153.0 ms /  1,513   153.1 ms /  1,595
--   series_domains(13회차)      369.5 ms /  9,112 273.2 ms /  2,939   275.8 ms /  3,094
--   s3_domains                  161.9 ms /  3,409 136.9 ms /  1,513   138.4 ms /  1,595
--   s3_enginecat                 75.9 ms /  3,409  91.1 ms / 68,013    56.0 ms /  1,595
--   [region=KR,US + engine=chatgpt]
--   card_domains                 11.2 ms /    248  11.2 ms /  4,951     9.1 ms /     62
--   series_domains(13회차)       76.8 ms /  6,407  62.8 ms / 26,996    44.1 ms /    480
--   s3_domains                   10.7 ms /    248  10.8 ms /  4,951     8.4 ms /     62
--   s3_enginecat                  8.3 ms /    248   5.1 ms /  4,951     1.8 ms /     62
--
--   v2 는 8문장 전부 `Index Only Scan using summary_trend_domains_s1_cover_v2`,
--   **Heap Fetches 0**. 무필터는 초판의 이득을 그대로 유지하고(+82 buf 는 engine 열 폭),
--   필터 조합은 0068 이전보다도 buffers 가 4배 작다(248 → 62).
--
--   brands(변경 없음, 대조군): 무필터 card 233 ms / 5,879 → **165.4 ms / 2,410**,
--   필터 card 16.9 ms / 421 → **38.0 ms / 2,410**, B2 13회차 **36.4 ms / 701**(불변).
--
-- ⚠️ **PR④ 플랜의 전제 하나를 정정한다.** 플랜 §1-5 는 "`summary_trend_brands` PK 스캔
--    (233 MB)" 을 카드의 장대로 지목했지만, 실측 플랜에서 **카드 read 는 PK 를 타지 않는다**
--    (PK idx_scan = brands 239 · domains 2,102, DB 기동 이래 누적). 카드가 쓰는 것은
--    0059 `*_pick` + 0065 `*_gen` 의 BitmapAnd 이고, 비용은 인덱스가 아니라 그 뒤의
--    **Bitmap Heap Scan**(brands 5,647 blk · domains 3,223 blk)이다. 그래서 이 파일은
--    PK 를 대신하는 것이 아니라 **heap 되짚기를 없앤다**. PK 형태(대리키)는 PR⑤ 몫이고,
--    이 파일은 PK 를 건드리지 않는다.
--
-- brands 한 문장이 heap 에서 44 MB(Bitmap Heap 5,647 blk)를 끌어오는데 실제로 쓰는 컬럼은
-- 22개뿐이다(heap 튜플은 40컬럼 · 평균 540 B). 커버링 인덱스로 Index Only Scan 이 되면
-- 같은 행을 ~180 B 짜리 인덱스 튜플에서 읽는다 — 실측 5,879 → **2,410 블록**(−59%).
--
-- ── 열 순서 근거 ─────────────────────────────────────────────────────────────
--   surface                       … 리더가 `surface = $1` 을 **파라미터**로 보낸다. 키에 없으면
--                                   Index Cond 가 아니라 Filter 가 되고, 컬럼이 인덱스에
--                                   아예 없으면 Index Only Scan 자체가 성립하지 않는다.
--   cycle_id, generation_id       … 스냅샷 read 의 등치 술어이자 가장 선택적인 쌍
--                                   (0065 `*_gen` 이 이 순서라 플래너가 이미 선호한다).
--                                   기간 모드(회차 13개)에서는 ANY×ANY 로 들어온다.
--   project_id                    … `= ANY($n)`. 글로벌은 1개, 웹사이트는 함대라 다치.
--   brands 의 brand_name, country … `GROUPING SETS ((brand_name), (country, brand_name))` 의
--                                   축이자, **B2 2단 조회의 경계 컬럼**이다(`brand_name = ANY`).
--                                   ⚠️ 정렬 이득은 **실현되지 않았다** — after 플랜에서도
--                                   플래너는 HashAggregate(3,529 kB)를 골랐다. 이 자리를
--                                   지키는 이유는 정렬이 아니라 B2 의 경계다(위 트레이드 절).
--   domains 의 country, engine    … **필터 두 축을 연속 경계로.** v2 의 개정 핵심이다.
--                                   `country <> ALL('{ID}')` 는 비등치라 경계가 안 되지만
--                                   `country = ANY($n)`(지역 필터)와 `engine = ANY($n)` 은 된다.
--   domains 의 group_key, domain  … 도메인 문장의 GROUPING SETS 축. 집계가 hash 라 순서
--                                   자체는 무상관이고, 커버(Index Only) 목적으로 키에 둔다.
--   INCLUDE                       … 술어에도 경계에도 안 쓰이고 **출력에만** 쓰이는 열.
--                                   키에 넣으면 인덱스가 넓어지고 정렬 규칙만 늘어난다.
--
-- ── 부분 인덱스 술어와 "보험" INCLUDE ────────────────────────────────────────
-- 술어는 리더가 **리터럴로** 내보내는 게이트만 담았다(summary-trend-aggregates.ts
-- `trendWhere`: `run_status IN ('completed','partial_failed')` · `in_root_catalog = 1` ·
-- `in_tagged_region = 1` · `in_full_cycle = 1`, 그리고 brands 는 `is_competitor = 1`).
-- 파라미터로 나가는 술어(`surface`·`project_id`·`cycle_*`·`cycle_anchor_at`)는 술어에
-- **넣지 않았다** — 플래너가 `Param` 을 상수로 접기 전에 부분 인덱스 함의를 판정하면
-- 인덱스가 통째로 안 쓰이기 때문이다. 그 위험을 설계에서 뺐다.
--
-- 실측(2026-09-10): 이 술어를 만족하는 행은 brands 135,695 · domains 137,916 이고
-- **둘 다 100% 글로벌**이다(웹사이트 0행 — 웹사이트 경로는 `trendWhere` 의 else 갈래라
-- 세 게이트를 아예 안 건다). 즉 술어만으로 이미 "글로벌 전용" 인덱스다.
--
-- 그럼에도 게이트 컬럼(`run_status`·`is_competitor`·`in_*`)을 INCLUDE 에 **다시** 실었다.
-- 보험이다: 만에 하나 플래너가 부분 술어 함의를 증명하지 못해 그 qual 이 남더라도,
-- 컬럼이 인덱스 안에 있으면 Index Only Scan 이 그대로 성립한다. 값은 어차피 술어가
-- 걸러 둔 것이라 필터가 한 번 더 돌아도 결과가 같다. 비용은 brands +16 B/행(≈2.2 MB).
--
-- ── 크기 (프로덕션 실측) ─────────────────────────────────────────────────────
--   brands  `_s1_cover`     135,695행 → **30 MB**
--   domains `_s1_cover_v2`  137,916행 → **25 MB** (초판 23 MB + `engine` 평균 7.58 B)
--   합 **55 MB** (현재 summary_trend_* 인덱스 합 612 MB 대비 +9%).
--
--   주간 증가 — 글로벌 완전 회차 하나가 통째로 접히면(2026-08-31 실측)
--   brands 86,218행 × 210 B ≈ 18.1 MB + domains 72,327행 × 183 B ≈ 13.2 MB
--   = **≈ 31 MB / 완전 회차 1개**. 실측 케이던스는 주당 회차 1개(그중 완전 회차는
--   2주에 1개꼴 — 2026-08-31 86,218행 vs 2026-08-18 25,916행)라 **≈ 16~31 MB/주**다.
--   수용 기준 ≤40 MB/주 안이지만 **여유가 크지 않다** — 회차 모수가 지금의 1.3배가 되면
--   상한에 닿는다. 그 완충은 PR⑤ 0068b(PK 대리키, 집계층 PK 586 MB 회수)가 준다.
--   ⚠️ brands 인덱스를 하나 더 늘리는 안이 기각된 것도 이 예산 때문이다.
--
--   btree 한계 확인(2026-09-10 실측): 인덱스 튜플 최댓값 brands **208 B** · domains **190 B**
--   (페이지 1/3 = 2,712 B 한계에서 한참 아래 — 빌드 중 "index row size exceeds" 로 죽을 일이 없다).
--   컬럼 수는 brands **28개**(키 6 + INCLUDE 22) · domains **17개**(키 8 + INCLUDE 9) —
--   btree 상한 **32개**에 대해 brands 는 여유 4개뿐이다. 컬럼을 더 실으려면 이 한계를 먼저 볼 것.
--
--   ⚠️ 쓰기 증폭: 접기(fold) INSERT 가 인덱스 2개를 더 갱신한다. 실측 기준선
--   `INSERT INTO summary_trend_brands …` calls 1,166 · mean 52.3 ms(pg_stat_statements).
--   부분 인덱스라 게이트 밖 행은 갱신 대상이 아니지만, 완전 회차의 접기는 느려진다.
--   생성 러너의 소요를 적용 후 한 번 대조할 것.
--
-- ── 검증 (적용 직후 반드시) ──────────────────────────────────────────────────
--   EXPLAIN (ANALYZE, BUFFERS) <카드 domains 문장 전개형>;
--     기대: `Index Only Scan using summary_trend_domains_s1_cover_v2`, `Heap Fetches: 0`,
--           필터 조합에서 shared hit 가 **세 자리**(62 실측)로 떨어진다.
--   플래너가 여전히 BitmapAnd 를 고르면 이 인덱스는 이득이 없다 —
--   되돌리기는 `DROP INDEX CONCURRENTLY summary_trend_domains_s1_cover_v2;` 한 줄이고
--   **데이터·값에는 아무 영향이 없다**(읽기 경로만 바뀐다).
--
-- 규약 (0065·0066·0067 과 동일):
--   · 멱등 — 재실행 안전. `IF NOT EXISTS` 금지(no-op 이어도 락을 먼저 잡는다) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → 파일 안에서는 `CONCURRENTLY` 불가.
--   · additive-only — DROP·TRUNCATE·UPDATE 가 실행 경로에 하나도 없다. PK 미변경.
--   · `summary_*` 계열이라 `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0067 과 같은 자세).
--   · 표는 파티션이 **아니다**(0059: `summary_trend_*` 는 PARTITION BY 없음) — 자식 재귀 없음.

SET LOCAL lock_timeout = '3s';

-- ── ⓪ 트랜잭션 블록 가드 (0065·0066·0067 과 동일) ────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
-- 그 상태로 168 MB 표에 ACCESS EXCLUSIVE 를 걸면 무한 대기다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0068: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ① summary_trend_brands_s1_cover ──────────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public.summary_trend_brands') IS NULL THEN
    RAISE EXCEPTION '0068: summary_trend_brands 가 없다 — 0059 를 먼저 적용할 것';
  END IF;
  IF to_regclass('public.summary_trend_brands_s1_cover') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX summary_trend_brands_s1_cover
        ON public.summary_trend_brands
           (surface, cycle_id, generation_id, project_id, brand_name, country)
        INCLUDE (cycle_anchor_at, engine, brand_id,
                 run_status, is_competitor, in_root_catalog, in_tagged_region, in_full_cycle,
                 mentions, answers, rank_sum, ranked_answers, top3_answers,
                 positive, neutral, negative, mixed,
                 type_mention, type_recommendation, type_comparison,
                 type_definition, type_final_choice)
        WHERE is_competitor = 1 AND in_root_catalog = 1 AND in_tagged_region = 1
          AND in_full_cycle = 1 AND run_status IN ('completed', 'partial_failed')
    $ddl$;
  END IF;
END
$do$;

COMMENT ON INDEX summary_trend_brands_s1_cover IS
  'S1 카드 read(summaryGlobalS1FromTrend → trendBrandsSql)의 Index Only Scan 용 커버링 인덱스. 부분 술어는 리더가 리터럴로 내보내는 게이트만 담는다(파라미터 술어를 넣으면 부분 인덱스 함의가 깨질 수 있다). 게이트 컬럼을 INCLUDE 에 중복으로 실은 것은 함의 증명 실패 시에도 index-only 를 유지하려는 보험이다. 키 끝의 (brand_name, country) 는 정렬이 아니라 B2 2단 조회(brand_name = ANY(top-N))의 경계를 지키기 위한 것이다 — 정렬 이득은 실측에서 실현되지 않았고(플래너가 HashAggregate 선택), 이 자리를 country·engine 에 내주면 필터 조합은 좋아지지만 B2 가 부분 인덱스 전량을 훑는다. 그 트레이드로 카드 필터 조합에 +21 ms 가 남아 있다(무필터 −68 ms). 값에는 영향이 없다 — 플래너가 안 고르면 인덱스를 지우기만 하면 종전 경로(0059 *_pick + 0065 *_gen)로 돌아간다.';

-- ── ② summary_trend_domains_s1_cover_v2 ──────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public.summary_trend_domains') IS NULL THEN
    RAISE EXCEPTION '0068: summary_trend_domains 가 없다 — 0059 를 먼저 적용할 것';
  END IF;
  IF to_regclass('public.summary_trend_domains_s1_cover_v2') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX summary_trend_domains_s1_cover_v2
        ON public.summary_trend_domains
           (surface, cycle_id, generation_id, project_id, country, engine, group_key, domain)
        INCLUDE (cycle_anchor_at, matched_base, base_norm_null,
                 run_status, in_root_catalog, in_tagged_region, in_full_cycle,
                 citations, citing_answers)
        WHERE in_root_catalog = 1 AND in_tagged_region = 1 AND in_full_cycle = 1
          AND run_status IN ('completed', 'partial_failed')
    $ddl$;
  END IF;
END
$do$;

COMMENT ON INDEX summary_trend_domains_s1_cover_v2 IS
  'S1 카드 read(trendDomainsSql) + 인용 화면(summaryGlobalCitationsFromTrend, trendEngineCategorySql) + 기간 회차 축(readGlobalTrendCore)의 Index Only Scan 용 커버링 인덱스. ⑤ 분자 판정에 쓰이는 matched_base·base_norm_null·domain 을 함께 실어 heap 되짚기를 없앤다(unit_owned_citations 는 웹사이트 전용이고 이 부분 술어에 웹사이트 행이 0건이라 뺐다). 초판(_s1_cover, 이름에 v2 가 없던 것)과의 차이는 engine 이 키 6번째로 들어온 것 하나다 — 초판은 engine 이 인덱스에 아예 없어 필터 조합에서 행마다 heap 을 되짚었고(shared hit 248 → 4,951) engine×category 문장은 3,409 → 68,013 buffers 로 오히려 느려졌다. domains 문장의 집계는 전부 hash 라 키 뒤쪽 순서에 정렬 이득이 없으므로 그 자리를 필터 경계에 쓴다. 값에는 영향이 없다.';

-- ── ③ 통계 ───────────────────────────────────────────────────────────────────
-- 새 인덱스는 통계 없이 태어난다. 부분 인덱스는 플래너가 reltuples 로 선택도를 잡으므로
-- ANALYZE 를 안 돌리면 인덱스를 만들어 놓고도 안 고를 수 있다.
-- (out-of-band 로 CONCURRENTLY 를 먼저 돌린 경우엔 그쪽 절차 ③ 에서 이미 돌았다 —
--  여기서 한 번 더 도는 것은 무해하다. 두 표뿐이라 60표 전수 함수는 부르지 않는다.)
ANALYZE public.summary_trend_brands;
ANALYZE public.summary_trend_domains;

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   인덱스뿐이라 되돌려도 값이 안 바뀐다. 온라인으로 지운다(ACCESS EXCLUSIVE 회피):
--     DROP INDEX CONCURRENTLY IF EXISTS summary_trend_brands_s1_cover;
--     DROP INDEX CONCURRENTLY IF EXISTS summary_trend_domains_s1_cover_v2;
--     ANALYZE public.summary_trend_brands;
--     ANALYZE public.summary_trend_domains;
--   ⚠️ `DROP INDEX CONCURRENTLY` 도 트랜잭션 안에서는 못 돈다 — 손으로, 하나씩.
--   되돌리면 읽기 경로는 0059 `*_pick` + 0065 `*_gen` BitmapAnd 로 그대로 돌아간다.
