-- 0065 — 집계층(추이층) 스키마 개정 (PR② T1).
--
-- 정본 플랜: (내부 설계 문서)
--   §3-2 `summary_trend_own` = KPI 엔진(확장 7컬럼) · §4-2 인덱스·확장 통계 · §9 T1 수용 기준.
--
-- 무엇을 왜:
-- 0059 의 `summary_trend_own` 은 ①·③·④·Sub-KPI 만 갖는다. ②·⑤ 의 **분모**(경쟁 브랜드
-- 총언급 · 전체 인용)가 없어서, 카드 하나를 그리려고 12만행 브랜드 표와 7만행 도메인
-- 표를 또 읽어야 한다. 분모 4개를 같은 행에 넣으면 카드 전체가 답변 키 그레인 한 번
-- 스캔(글로벌 ≈6,100행)으로 끝난다. 이 파일은 그 컬럼과 조회 인덱스만 만든다 —
-- **접기 SQL 은 T2**(`lib/summary/generate/fold.ts`), **리더는 T4** 다.
--
-- 규약 (0064 와 동일):
--   · additive-only — DROP 없음. 0059 의 `summary_trend_*_pick` 인덱스는 **남긴다**
--     (플랜 §4-2: "옛것은 남긴다, 제거는 다음 PR"). 플래너가 둘 중 고를 수 있게 둔다.
--   · 멱등 — 재실행이 안전해야 한다(이 리포의 적용 경로는 손으로 도는 db:apply 다).
--   · **`IF NOT EXISTS` 를 믿지 않는다.** no-op 이어도 락을 **먼저** 잡는다
--     (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` 797초 대기·44세션 적체 실증).
--     그래서 카탈로그를 먼저 보고, 진짜 필요할 때만 DDL 을 낸다.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → `CONCURRENTLY` 는 불가.
--   · `summary_*` 계열이라 `schema.ts` 에 반영하지 않고 `meta/_journal.json` 에도 넣지
--     않는다 — 0059·0060·0062·0063·0064 와 같은 자세다(그 표들은 drizzle 스키마 밖의
--     out-of-band 자산이고, `db:drift` 는 "DB 에만 있는 테이블" 로 참고 출력만 낸다:
--     `scripts/db/drift-check.mjs` 의 `extraTables` 는 diffs 에 안 들어간다).
--
-- ⚠️ 락 범위 (2026-09-10 라이브 실측):
--   · 집계층 4표는 **전부 count(*) = 0 · 24 kB · 파티션 아님(relkind='r', pg_inherits 자식 0)**.
--     그래서 ①~③ 의 ALTER·CREATE INDEX 는 전부 빈 표 DDL 이고 `CONCURRENTLY` 가 무의미하다.
--     블록 ⓪ 이 그 전제를 **단언**한다 — 비어 있지 않으면 파일 전체가 중단된다.
-- ⚠️ 적용 순서 (W4): 블록 ⓪ 이 "집계층 4표 = 0행" 을 단언하므로, **T2 접기 데이터가
--    들어간 뒤에는 이 파일을 재실행할 수 없다**(멱등이 그 시점에 깨진다 — 의도된 설계다).
--    → **T2 배포보다 먼저 적용할 것.** 순서가 뒤집혔다면 CONCURRENTLY 판본으로 다시 짠다.
--
-- ⚠️ 미증명 항목 (W8): 블록 ③ 의 generation 정리 인덱스 4개는 **이득이 증명되지 않았다** —
--    PK 선두가 이미 (cycle_id, generation_id) 라 seq scan 이 아니고, 차이는 인덱스 폭뿐이다.
--    표가 비어 있어 지금은 EXPLAIN 근거를 만들 수 없다. **T4 가 실데이터로 재판정**하고,
--    불리하면(쓰기 증폭 > 정리 DELETE 이득) DROP 한다. 그때까지 잠정 유지.
--
--   · **④ 만 예외다.** `summary_brand_mentions` 는 파티션 부모(자식 8개) · **315,174행 ·
--     300 MB** 로 **비어 있지 않다**. 여기의 `CREATE INDEX` 는 부모와 자식 8개에 SHARE 락을
--     잡고(= 읽기 허용·**쓰기 차단**) 인덱스를 실제로 빌드한다. 생성 러너가 도는 중이면
--     충돌한다. 플랜 §4-2 는 이 인덱스를 "빈 표" 인덱스들과 한 블록에 묶어 놨지만
--     **실측상 성질이 다르다** — 적용 시점을 생성 러너 밖으로 잡을 것.

SET LOCAL lock_timeout = '3s';

-- ── ⓪-a 트랜잭션 블록 가드 ───────────────────────────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 **WARNING(25P01) 만 내고 조용히 무시된다** — 값은 0(무제한)으로
-- 남는다(2026-09-10 실측: tx 안 '3s' / tx 밖 '0'). 그 상태로 블록 ④ 가 300 MB 파티션
-- 부모에 락을 걸면 **무한 대기**한다. 적용 경로는 한 파일 = 한 tx 인 `npm run db:apply` 뿐이니,
-- 그 전제가 깨진 채로 도는 것을 여기서 막는다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0065: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ⓪ 전제 단언: 집계층 4표가 비어 있는가 ────────────────────────────────────
-- 이 파일의 모든 DDL 은 "빈 표라 락이 무의미하다" 를 근거로 CONCURRENTLY 를 쓰지 않는다.
-- 그 전제가 깨진 채로 적용되면 (예: T2 접기가 이미 돌았다면) 300 MB 짜리 표에
-- ACCESS EXCLUSIVE/SHARE 를 걸게 된다. 전제를 코드로 잠근다.
DO $do$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_trend_answers','summary_trend_brands',
                           'summary_trend_domains','summary_trend_own'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION '0065: %(가) 없다 — 0059 를 먼저 적용할 것', t;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION '0065: %(에) 이미 %행이 있다 — 이 파일은 빈 표를 전제로 CONCURRENTLY 없이 인덱스를 만든다. 적용 전에 집계층을 비우거나 CONCURRENTLY 판본으로 다시 짤 것', t, n;
    END IF;
  END LOOP;
END
$do$;

-- ── ① summary_trend_own 확장 7컬럼 (플랜 §3-2) ───────────────────────────────
-- ②·⑤ 의 분자·분모를 같은 행에 굳혀 카드 전체를 한 표 한 스캔으로 만든다.
-- `$sel`(소유 도메인 base 집합)은 (브랜드 변형, country, lang) 의 함수이고 그 셋이 전부
-- 키에 있으므로 **키 그룹 안에서 상수** → `own_citations` 를 생성 시각에 굳힐 수 있다.
-- ⚠️ `DEFAULT 0` 은 플랜 §3-2 DDL 그대로다. 접기(T2)가 컬럼을 빠뜨려도 조용히 0 이
--    되는 마스킹 위험이 있다 — T2 수용 기준 ②(집계층 SUM = 세부층 SUM)가 그 감시다.
DO $do$
DECLARE
  c    text;
  cols text[] := ARRAY['comp_mentions','all_citations','own_citations',
                       'own_fallback_citations','tile_own_mentions','citing_answers',
                       'prompts_measured'];
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.summary_trend_own'::regclass
        AND attname = c AND attnum > 0 AND NOT attisdropped
    ) THEN
      EXECUTE format('ALTER TABLE public.summary_trend_own ADD COLUMN %I int NOT NULL DEFAULT 0', c);
    END IF;
  END LOOP;
END
$do$;

COMMENT ON COLUMN summary_trend_own.comp_mentions IS
  '② 분모 — 키 그룹 안 is_competitor=1 브랜드의 총언급 합. 그룹 간 SUM 가산.';
COMMENT ON COLUMN summary_trend_own.all_citations IS
  '⑤ 분모 — 키 그룹 안 전체 인용 수(domain NULL 포함). trend_answers.all_citations 와 같은 정의.';
COMMENT ON COLUMN summary_trend_own.own_citations IS
  '⑤ 분자 — matched_base ∈ $sel(own_variant, country, lang) 인 인용 수. $sel 이 키 상수라 생성 시각에 굳힌다(플랜 §3-2).';
COMMENT ON COLUMN summary_trend_own.own_fallback_citations IS
  '⑤ 분자 폴백분 — base_norm_null=1 이면서 domain 이 소유 서픽스와 맞는 인용 수. 분자는 own_citations + 이 값.';
COMMENT ON COLUMN summary_trend_own.tile_own_mentions IS
  '② 타일 분자 — 표시명(brand_name) 그룹으로 접어 굳힌 당사 언급. 조회 시 bool_or 를 재현하면 그룹 간 가산이 깨지므로 생성 시각에 접는다(플랜 §3-4 3, 혼재 669/228,654 = 0.29%).';
COMMENT ON COLUMN summary_trend_own.citing_answers IS
  '인용이 1건 이상인 job 수. 키 그룹이 job 을 분할하므로 그룹 간 SUM 가산.';
COMMENT ON COLUMN summary_trend_own.prompts_measured IS
  '⚠️ 키 그룹 안 DISTINCT prompt 수. prompt 는 (engine,country) 그룹을 가로지르므로 **그룹 간 SUM 은 이중 계상이다** — 감사·단일 그룹 조회 전용. 화면의 프롬프트 수는 세부층 summary_answers 에서 온다(플랜 §3-4 16).';

-- ── ② 조회 인덱스 6개 (플랜 §4-2) ────────────────────────────────────────────
-- 집계층 조회는 `cycle_anchor_at ∈ [from,to]` 로 **회차 집합**을 고른 뒤 필터한다.
-- 0059 의 `*_pick` 은 `(surface, project_id, cycle_anchor_at)` 3컬럼이라(own 만
-- `(surface, project_id, own_variant, cycle_anchor_at)` **4컬럼**) 범위 조건이 마지막에
-- 온다. 새 인덱스는 `cycle_anchor_at` 을 앞으로 당긴다.
-- ⚠️ 트레이드오프를 적어 둔다: 글로벌 표면은 `project_id` 가 등치(단일 프로젝트)라
--    `(surface, project_id, cycle_anchor_at, …)` 가 이론상 더 낫고, 웹사이트 표면은
--    함대 95 프로젝트라 `project_id` 가 다치(多値)여서 플랜의 순서가 낫다. **둘 다 남기고**
--    (0059 `*_pick` 미제거) 플래너에게 맡긴다. 실측 판정은 데이터가 찬 뒤 T4 몫이다.
--    지금은 표가 비어 있어 EXPLAIN 근거를 만들 수 없다 — 근거 없는 제거를 하지 않는다.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('summary_trend_answers_read', 'CREATE INDEX summary_trend_answers_read ON public.summary_trend_answers (surface, cycle_anchor_at, project_id, country, engine)'),
      ('summary_trend_brands_read',  'CREATE INDEX summary_trend_brands_read  ON public.summary_trend_brands  (surface, cycle_anchor_at, project_id, country, engine)'),
      ('summary_trend_domains_read', 'CREATE INDEX summary_trend_domains_read ON public.summary_trend_domains (surface, cycle_anchor_at, project_id, country, engine)'),
      ('summary_trend_own_read',     'CREATE INDEX summary_trend_own_read     ON public.summary_trend_own     (surface, own_variant, cycle_anchor_at, project_id)'),
      -- catalog_brands 는 PK 안에 있지만 조회는 `&&`(any-match) 라 btree 가 안 먹는다 → gin.
      -- 플랜 §4-2 는 answers·brands 둘만 지정한다. domains·own 은 `*_read` 로 좁힌 뒤의
      -- 필터로 처리되며, 필요 판정은 실데이터에서 T4 가 한다(여기서 넓히지 않는다).
      ('summary_trend_answers_cb',   'CREATE INDEX summary_trend_answers_cb ON public.summary_trend_answers USING gin (catalog_brands)'),
      ('summary_trend_brands_cb',    'CREATE INDEX summary_trend_brands_cb  ON public.summary_trend_brands  USING gin (catalog_brands)')
    ) AS v(idx, ddl)
  LOOP
    IF to_regclass(format('public.%I', r.idx)) IS NULL THEN
      EXECUTE r.ddl;
    END IF;
  END LOOP;
END
$do$;

-- ── ③ generation 정리 인덱스 4개 (플랜 §4-2 · §5-1) ──────────────────────────
-- 두 군데가 쓴다:
--   (a) 접기 재실행 멱등 — `DELETE … WHERE cycle_id=$c AND generation_id=$g` (§5-1)
--   (b) 옛 generation 정리 — `DELETE … WHERE cycle_id=$c AND generation_id <> $active`
-- 세부층은 파티션 DROP 으로 지워지지만 집계층은 파티션이 아니라 DELETE 다.
-- ⚠️ 플랜 §5-1 은 "선두 인덱스가 없으면 seq scan" 이라고 쓰지만, **PK 가 이미
--    (cycle_id, generation_id, …) 로 시작한다**(실측: `summary_trend_own_pkey`).
--    따라서 seq scan 은 아니다 — 이 인덱스의 실이득은 **폭**이다. PK 는 표마다
--    answers 17 · brands 17 · domains 18 · own **16** 컬럼이고(2026-09-10 pg_index 실측)
--    전부 `catalog_brands text[]` 를 포함해 엔트리가 넓다. 좁은 2컬럼 인덱스가 정리
--    DELETE 의 스캔 비용을 낮춘다.
--    ⚠️ 다만 **이득은 아직 미증명이다**(머리 주석 W8) — 표가 비어 있어 EXPLAIN 근거를
--    만들 수 없다. T4 가 실데이터로 재판정하고 불리하면 DROP 한다.
-- 이름을 루프로 조립하지 않고 리터럴로 적는다 — 인덱스 이름은 grep 으로 찾아지는 것이
-- 정본이다(운영 중 `DROP INDEX` 를 손으로 칠 사람이 이 파일을 읽는다).
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('summary_trend_answers_gen', 'CREATE INDEX summary_trend_answers_gen ON public.summary_trend_answers (cycle_id, generation_id)'),
      ('summary_trend_brands_gen',  'CREATE INDEX summary_trend_brands_gen  ON public.summary_trend_brands  (cycle_id, generation_id)'),
      ('summary_trend_domains_gen', 'CREATE INDEX summary_trend_domains_gen ON public.summary_trend_domains (cycle_id, generation_id)'),
      ('summary_trend_own_gen',     'CREATE INDEX summary_trend_own_gen     ON public.summary_trend_own     (cycle_id, generation_id)')
    ) AS v(idx, ddl)
  LOOP
    IF to_regclass(format('public.%I', r.idx)) IS NULL THEN
      EXECUTE r.ddl;
    END IF;
  END LOOP;
END
$do$;

-- ── ④ E4 세부층 폴백 인덱스 — ⚠️ 이 파일에서 유일하게 "비어 있지 않은" 표 ──────
-- E4 = admin 이 브랜드를 임의 조합으로 고를 때. `own_variant` 밖이라 집계층으로 못 덮고,
-- 세부층 두 문장(브랜드 / 답변)을 **조인 없이** 각각 집계해 오늘의 3.9 s 조인을 대체한다.
-- 0059 의 `summary_brand_id_idx` = `(cycle_id, generation_id, brand_id)` 에 국가 축을 붙인다.
--
-- 실측(2026-09-10): `summary_brand_mentions` = 파티션 부모 · 자식 8개 · 315,174행 · 300 MB
-- (전부 `summary_brand_mentions_20260831` 한 파티션에 있다). 부모에 인덱스를 만들면
-- 자식 8개에 각각 실제 빌드가 돈다 — **SHARE 락(읽기 허용·쓰기 차단)** 이 빌드 내내 걸린다.
-- 소요는 315k행 · maintenance_work_mem 1 GB 기준 수 초대(이론)이고 DB statement_timeout
-- 120 s 안이지만, **생성 러너(요약 적재)가 도는 중이면 그 러너가 대기한다.**
-- 적용 창을 생성 러너 밖으로 잡을 것. (플랜 §4-2 는 이것을 빈 표 인덱스들과 같은 블록에
-- 두었으나 실측상 성질이 다르다 — 코드가 이긴다.)
DO $do$
BEGIN
  IF to_regclass('public.summary_brand_mentions') IS NULL THEN
    RAISE NOTICE '0065: summary_brand_mentions 없음 — ④ 건너뜀';
  ELSIF to_regclass('public.summary_brand_own_idx') IS NULL THEN
    EXECUTE 'CREATE INDEX summary_brand_own_idx ON public.summary_brand_mentions (cycle_id, generation_id, brand_id, country)';
  END IF;
END
$do$;

-- ── ⑤ 확장 통계 — 만들지 않고 "있는지 단언" 한다 ─────────────────────────────
-- ⚠️ 플랜 §4-2 는 `summary_trend_*_cg` 라는 **새 통계 객체**를 만들라고 쓴다. 실측하면
--    이미 있다 — 0062 의 `summary_ensure_cycle_gen_stats()` 가 `summary_*` 중
--    cycle_id·generation_id 를 **둘 다 가진 표 전부**를 훑기 때문에, 집계층 4표도 그때
--    함께 잡혔다: `st_summary_trend_{answers,brands,domains,own}_cyc_gen`
--    (stxkind = d,f,m = dependencies·ndistinct·mcv — 플랜이 요구한 d,f 의 상위집합).
--    같은 컬럼쌍에 두 번째 객체를 만들면 ANALYZE 비용만 늘고 이득이 없다.
--    → **0062 의 이름 규약을 그대로 쓴다**(그래야 그 함수가 계속 멱등하다).
--       빠진 것만 만들고, 4표를 ANALYZE 한 뒤, 4개가 다 있는지 단언한다(T1 수용 기준 ④).
--    ANALYZE 대상을 집계층 4표로 한정한 이유: `summary_ensure_cycle_gen_stats()` 를
--    부르면 summary_* 60개 전부에 ANALYZE 가 돈다(0064 머리 주석) — 마이그레이션 tx
--    안에서 낼 비용이 아니다. 4표는 비어 있어 ANALYZE 가 즉시 끝난다.
DO $do$
DECLARE
  t    text;
  nm   text;
  have int;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_trend_answers','summary_trend_brands',
                           'summary_trend_domains','summary_trend_own'] LOOP
    nm := left('st_' || t || '_cyc_gen', 63);
    IF NOT EXISTS (
      SELECT 1 FROM pg_statistic_ext e JOIN pg_namespace n ON n.oid = e.stxnamespace
      WHERE n.nspname = 'public' AND e.stxname = nm
    ) THEN
      EXECUTE format('CREATE STATISTICS public.%I (dependencies, ndistinct, mcv) ON cycle_id, generation_id FROM public.%I', nm, t);
    END IF;
    EXECUTE format('ANALYZE public.%I', t);
  END LOOP;

  SELECT count(*) INTO have
  FROM pg_statistic_ext e JOIN pg_namespace n ON n.oid = e.stxnamespace
  WHERE n.nspname = 'public'
    AND e.stxname = ANY (ARRAY['st_summary_trend_answers_cyc_gen','st_summary_trend_brands_cyc_gen',
                               'st_summary_trend_domains_cyc_gen','st_summary_trend_own_cyc_gen']);
  IF have <> 4 THEN
    RAISE EXCEPTION '0065: 집계층 확장 통계가 4개여야 하는데 %개다', have;
  END IF;
END
$do$;

-- ── ⑥ ACL ────────────────────────────────────────────────────────────────────
-- 이 파일은 새 **표·함수**를 만들지 않는다(컬럼·인덱스·통계뿐). 컬럼 추가는 표 ACL 을
-- 바꾸지 않고 인덱스·통계 객체에는 ACL 이 없다 — 즉 새로 열리는 표면이 없다.
-- 그래도 0059·0064 관례대로 집계층 4표에 REVOKE 를 한 번 더 건다(멱등·무비용).
-- 나중에 도는 일괄 REVOKE 에 기대면 그 사이에 노출 창이 열린다는 것이 0064 의 교훈이다.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_trend_answers','summary_trend_brands',
                           'summary_trend_domains','summary_trend_own'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END
$do$;

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 첫 줄에 락 가드를 함께 넣을 것 — `DROP INDEX summary_brand_own_idx` 는 파티션
--      부모와 자식 8개에 **ACCESS EXCLUSIVE**(읽기까지 차단)를 잡는다. 적용보다 더 세다.
--   SET LOCAL lock_timeout = '3s';
--   DROP INDEX IF EXISTS summary_brand_own_idx;                 -- ④ (파티션 부모 → 자식 8개 함께)
--   DROP INDEX IF EXISTS summary_trend_answers_read, summary_trend_brands_read,
--                        summary_trend_domains_read, summary_trend_own_read,
--                        summary_trend_answers_cb, summary_trend_brands_cb,
--                        summary_trend_answers_gen, summary_trend_brands_gen,
--                        summary_trend_domains_gen, summary_trend_own_gen;
--   ALTER TABLE summary_trend_own
--     DROP COLUMN IF EXISTS comp_mentions, DROP COLUMN IF EXISTS all_citations,
--     DROP COLUMN IF EXISTS own_citations, DROP COLUMN IF EXISTS own_fallback_citations,
--     DROP COLUMN IF EXISTS tile_own_mentions, DROP COLUMN IF EXISTS citing_answers,
--     DROP COLUMN IF EXISTS prompts_measured;
--   -- ⑤ 의 통계 객체: **0062 가 이미 만들어 둔 환경이면 되돌리지 않는다**(라이브 2026-09-10
--   --    실측이 그 경우다 — 0065 는 아무것도 만들지 않고 존재만 단언했다).
--   --    반대로 0062 가 안 돈 환경(0065 가 직접 만든 경우)이라면 함께 되돌린다:
--   --      DROP STATISTICS IF EXISTS st_summary_trend_answers_cyc_gen, st_summary_trend_brands_cyc_gen,
--   --                                st_summary_trend_domains_cyc_gen, st_summary_trend_own_cyc_gen;
