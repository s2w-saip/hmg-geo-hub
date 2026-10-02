-- 0066 — 집계층 키 확장: `report_fs` · `presence_set` (PR② T15).
--
-- 왜 (T4 리더 빌더 실측 → 2026-09-10 본 파일에서 재확인):
--   · **웹사이트 S4~S6 기본 경로가 100% 폴백**이다. 유닛 게이트 `report_fs` 가 집계층 키에
--     없어서 리더가 게이트를 적용할 수 없다(함대 20,058 답변 중 528행 = 2.63% 가 제외 대상).
--   · **글로벌은 branded 모수의 21.4% 를 놓친다.** 0061 의 any-match 정본은
--     `presence_set text[]` 인데 집계층 키에는 낡은 스칼라 `brand_presence_resolved` 만 있다.
--     실측: `bpr IS NULL` 인데 `presence_set = {branded}` 인 행이 **15,888**, `{branded,unbranded}`
--     가 264 — 스칼라만 보면 이 행들이 branded 집계에서 통째로 빠진다.
--
-- 키 증가 실측 (2026-09-10, 라이브 읽기 전용):
--   | 표면 | 그레인 | 기존 | +report_fs | +presence_set | 증가 |
--   | 웹사이트 | 답변(depth3 포함) | 248 | **250** | 250 | **+0.81%** |
--   | 글로벌  | 답변 depth1      | 6,136 | 6,136 | **6,202** | **+1.08%** |
--   `report_fs` 는 웹사이트에서 `(project, country, lang)` 에 사실상 함수 종속이고,
--   글로벌에서는 전량 NULL→0 이라 그레인을 늘리지 않는다. `presence_set` 은 distinct 4
--   (`{branded}`·`{unbranded}`·`{}`·`{branded,unbranded}`) 라 증가가 작다.
--   **`depth2`/`depth3` 는 넣지 않는다** (D11 — v4.1 §5-3 그대로).
--
-- ── 두 컬럼의 규약 (세부층 실측에서 유도) ────────────────────────────────────
--   `report_fs`   세부층 `summary_answers.report_fs` = **integer NULL**.
--                 웹사이트 20,058행 중 NULL **64** · distinct **109**(값 범위 1~144),
--                 글로벌 77,496행은 **전량 NULL**.
--                 → 집계층은 `int NOT NULL DEFAULT 0`, 접힘 규약 **`COALESCE(report_fs, 0)`**.
--                 ⚠️ 0 을 sentinel 로 쓸 수 있는 근거: `report_fs = 0` 인 행이 **실측 0건**이다
--                    (값이 1부터 시작한다). 따라서 "미부여(NULL)" 와 실값이 충돌하지 않는다.
--                    앞으로 0 을 실값으로 쓰기 시작하면 이 규약이 깨진다 — 그때는 sentinel 을
--                    -1 로 옮기거나 NULL 을 그대로 두는 판본이 필요하다.
--   `presence_set` 세부층 `summary_answers.presence_set` = **text[] NOT NULL DEFAULT '{}'**.
--                 → 집계층도 같은 타입·같은 기본값. **변환 없이 그대로 복사**한다.
--                 `summary_brand_mentions`·`summary_domain_citations` **에도 이미 있다**(실측)
--                 — 그쪽 접기는 조인이 필요 없다.
--
-- ── 접기(T2)·리더(T4) 에 넘기는 계약 ─────────────────────────────────────────
--   [T2 접기]
--     · `presence_set` — 3표(`summary_answers`·`_brand_mentions`·`_domain_citations`) 전부
--       같은 이름·같은 타입으로 갖고 있다. **그대로 GROUP BY 키에 넣는다.**
--     · `report_fs` — **`summary_answers` 에만 있다**(실측: brand_mentions·domain_citations
--       에는 없다). 따라서 `trend_brands`·`trend_domains` 접기는
--       `JOIN summary_answers a USING (cycle_week, cycle_id, generation_id, job_id)` 로
--       끌어와야 한다. ⚠️ 이 조인은 **같은 파티션·같은 generation 안**이고 job 1:1 이라
--       PR② §0-2 가 없애려는 그 조인(`summary_brand_mentions × summary_answers` 필터 조인)
--       과 성질이 다르다 — 생성 시각에 **한 번만** 돈다. 조회 경로에는 남지 않는다.
--     · 두 컬럼 모두 `trend_own` 에서도 키다 — job 단위 서브쿼리의 GROUP BY 에 포함할 것.
--     · `unit_owned_citations`(블록 ①-b) — `summary_domain_citations` 에만 있다.
--       도메인 접기에서 `sum(COALESCE(unit_owned_citations, 0))` 로 접는다.
--   [T4 리더]
--     · `unitFlags` → `report_fs` 술어. 글로벌은 전량 0 이므로 게이트가 무발화해야 한다
--       (`report_fs = 0` 을 "미부여" 로 읽을 것 — 위 sentinel 규약).
--     · 웹사이트 ⑤ 분자·`is_ours` → `trend_domains.unit_owned_citations`.
--       세부층 리더의 `sum(unit_owned_citations)`·`bool_or(unit_owned_citations > 0)`
--       (`lib/db/repositories/summary-website-aggregates.ts` `ownedCitationsSum`·
--       `ownedDomainAgg`, 둘 다 `scope.unitFlags` 게이트)가 집계층에서는 각각
--       `sum(...)` 과 **`sum(...) > 0`** 이 된다 — 값이 음수가 아니므로 동치다(블록 ①-b 실측).
--     · `brandPresence` → `presence_set` **any-match**(`&&`) 술어. 스칼라
--       `brand_presence_resolved` 를 쓰던 자리를 갈아끼운다. 두 컬럼이 당분간 공존하지만
--       **정본은 `presence_set`** 이다(0061).
--
-- ⚠️⚠️ 적용 순서 (0065 와의 상호작용 — 반드시 읽을 것):
--   0065 의 블록 ⓪ 은 "집계층 4표 = 0행" 을 단언한다. **2026-09-10 현재 그 전제가 깨져 있다** —
--   T2 접기 시험 실행이 웹사이트 회차 1개(anchor 2026-09-04, generation active)의 결과를
--   남겼다: answers 2 · brands 51 · domains 60 · own 2 = **115행**.
--   → **0065 를 적용하기 전에 이 4표를 먼저 비워야 한다.** 이 파일의 블록 ⓪-b 와 같은
--     TRUNCATE 한 줄이면 된다. 순서: `TRUNCATE 4표` → `db:apply 0065` → `db:apply 0066`.
--   비우는 것이 안전한 이유는 아래 블록 ⓪-b 주석과 같다(파생 데이터·화면 미소비).
--
-- 규약 (0065 와 동일 + 한 가지 예외):
--   · 멱등 — 재실행 안전. `IF NOT EXISTS` 금지(락을 먼저 잡는다) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션 → `CONCURRENTLY` 불가.
--   · `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0065 와 같은 out-of-band 자세).
--   · **예외: additive-only 를 벗어난다.** PK 를 재작성하므로 `DROP CONSTRAINT` 가 있다.
--     기존 테이블 ALTER 금지(0007 prod 장애)의 취지는 "데이터를 잃거나 되돌릴 수 없는 변경"
--     인데, 집계층은 **세부층에서 언제든 재생성되는 파생 데이터**이고 아직 화면이 소비하지
--     않는다. 그래서 TRUNCATE → PK 재작성이 안전하다. 그 전제가 이 파일의 근거 전부다.

SET LOCAL lock_timeout = '3s';

-- ── ⓪-a 트랜잭션 블록 가드 (0065 와 동일) ────────────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0066: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ⓪-b 집계층 4표 비우기 ────────────────────────────────────────────────────
-- PK 에 컬럼을 넣으려면 기존 행이 새 키로 유일해야 한다. 새 컬럼은 DEFAULT 로 채워지므로
-- 유일성은 보존되지만, **기존 행의 두 컬럼 값이 전부 기본값(0·'{}')이라 틀린 값**이다 —
-- 세부층의 실제 `report_fs`·`presence_set` 이 아니라 "모름" 이 굳어 버린다.
-- 그 상태로 리더가 게이트를 걸면 조용히 틀린 화면이 나온다. 그래서 채우지 않고 **버린다**.
--
-- 버려도 되는 이유(2026-09-10 실측):
--   · 집계층은 세부층에서 결정되는 **파생 데이터**다. 생성 러너를 그 회차에 다시 돌리면
--     `(cycle_id, generation_id)` 가 같은 행이 그대로 복원된다.
--   · **아직 어떤 화면도 집계층을 읽지 않는다** — 읽기 전환은 T5~T7(PR② 그룹 B)이고,
--     현재 전 표면이 미러/세부층 경로로 서빙된다.
--   · 현재 내용물은 T2 접기 시험 실행 결과 115행뿐(웹사이트 회차 1개).
-- TRUNCATE 는 트랜잭션 안에서 롤백 가능하고, 4표 합계 115행이라 즉시 끝난다.
-- ACCESS EXCLUSIVE 를 잡지만 대상이 24 kB 짜리 빈 표들이다.
TRUNCATE TABLE summary_trend_answers, summary_trend_brands,
               summary_trend_domains, summary_trend_own;

-- ── ① 두 컬럼 추가 (4표 공통) ────────────────────────────────────────────────
-- 타입·기본값은 세부층 실측에서 유도했다(머리 주석 "두 컬럼의 규약").
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_trend_answers','summary_trend_brands',
                           'summary_trend_domains','summary_trend_own'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION '0066: %(가) 없다 — 0059 를 먼저 적용할 것', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = format('public.%I', t)::regclass
        AND attname = 'report_fs' AND attnum > 0 AND NOT attisdropped
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN report_fs int NOT NULL DEFAULT 0', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = format('public.%I', t)::regclass
        AND attname = 'presence_set' AND attnum > 0 AND NOT attisdropped
    ) THEN
      EXECUTE format($q$ALTER TABLE public.%I ADD COLUMN presence_set text[] NOT NULL DEFAULT '{}'$q$, t);
    END IF;
  END LOOP;
END
$do$;

COMMENT ON COLUMN summary_trend_answers.report_fs IS
  '유닛 게이트 — 세부층 summary_answers.report_fs 를 COALESCE(…,0) 로 접은 값. 0 = 미부여(글로벌은 전량 0). 실값은 1부터라 0 이 sentinel 로 안전하다(2026-09-10 실측).';
COMMENT ON COLUMN summary_trend_answers.presence_set IS
  '브랜드 프레즌스 any-match 정본(0061). 조회 술어는 `&&`. 낡은 스칼라 brand_presence_resolved 와 당분간 공존하지만 정본은 이쪽이다.';
COMMENT ON COLUMN summary_trend_brands.report_fs IS
  '유닛 게이트. ⚠️ summary_brand_mentions 에는 이 컬럼이 없다 — 접기가 summary_answers 를 job_id 로 조인해 가져온다(생성 1회, 조회 경로 아님).';
COMMENT ON COLUMN summary_trend_brands.presence_set IS
  '브랜드 프레즌스 any-match 정본(0061). summary_brand_mentions 에 같은 컬럼이 있어 조인 없이 접힌다.';
COMMENT ON COLUMN summary_trend_domains.report_fs IS
  '유닛 게이트. ⚠️ summary_domain_citations 에는 없다 — 접기가 summary_answers 를 job_id 로 조인한다.';
COMMENT ON COLUMN summary_trend_domains.presence_set IS
  '브랜드 프레즌스 any-match 정본(0061). summary_domain_citations 에 같은 컬럼이 있어 조인 없이 접힌다.';
COMMENT ON COLUMN summary_trend_own.report_fs IS
  '유닛 게이트. job 단위 서브쿼리의 GROUP BY 에 포함할 것.';
COMMENT ON COLUMN summary_trend_own.presence_set IS
  '브랜드 프레즌스 any-match 정본(0061). job 단위 서브쿼리의 GROUP BY 에 포함할 것.';

-- ── ①-b `summary_trend_domains.unit_owned_citations` (측정 컬럼 — 키 아님) ────
-- 왜: **웹사이트 ⑤ 의 정본 분자**가 세부층 `summary_domain_citations.unit_owned_citations`
-- (유닛 자기 base 기준 — 조회 스코프와 무관)인데 도메인 접기에 이 값이 없다. 오늘 웹사이트
-- 리더의 도메인 `is_ours` 도 같은 컬럼을 본다(`summary-website-aggregates.ts`
-- `ownedDomainAgg` = `bool_or(unit_owned_citations > 0)`). 이게 없으면 집계층에서
-- 웹사이트 ⑤ 와 인용표 `is_ours` 를 **정확히 낼 수 없다**.
--
-- 실측 (2026-09-10, `summary_domain_citations`):
--   · 타입 **integer NULL**. 이 컬럼을 가진 세부층 표는 여기 하나뿐이다.
--   · 웹사이트 54,760행 — NULL **0** · `> 0` 인 행 **11,906** · max **58**.
--   · 글로벌 95,969행 — **전량 NULL**(웹사이트 전용 개념이다).
--   · 전체 min **0** · 음수 **0건** · `unit_owned_citations > citations` **0건**.
--     → 음수가 없으므로 `bool_or(x > 0)` 은 집계층에서 **`sum(x) > 0`** 과 동치다.
--       (T4 가 `is_ours` 를 그렇게 옮겨도 값이 바뀌지 않는다는 근거.)
--
-- 접힘 규약: `sum(COALESCE(unit_owned_citations, 0))` → 글로벌은 전부 0 이 된다.
-- 키가 아니므로 PK 는 바꾸지 않는다(그레인 무영향).
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_trend_domains'::regclass
      AND attname = 'unit_owned_citations' AND attnum > 0 AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE public.summary_trend_domains ADD COLUMN unit_owned_citations int NOT NULL DEFAULT 0';
  END IF;
END
$do$;

COMMENT ON COLUMN summary_trend_domains.unit_owned_citations IS
  '웹사이트 ⑤ 분자·인용표 is_ours 의 정본 — 유닛 자기 base 기준 인용 수(조회 스코프 무관). 세부층 summary_domain_citations.unit_owned_citations 를 sum(COALESCE(…,0)) 로 접은 값. **웹사이트에서만 의미가 있고 글로벌은 전량 0** 이다(세부층이 글로벌 전 행 NULL). 음수가 없으므로 is_ours = (이 값 > 0).';

-- ── ② PK 재작성 ──────────────────────────────────────────────────────────────
-- 새 컬럼을 키에 넣지 않으면 접기가 서로 다른 `report_fs`·`presence_set` 을 한 행으로
-- 뭉개고, 리더는 그 축으로 필터할 수 없다. 그래서 **PK 자체를 다시 쓴다.**
-- 배치: `presence_set` 은 의미가 같은 `brand_presence_resolved` **바로 뒤**,
--       `report_fs` 는 답변 속성 블록의 끝인 `run_status` **바로 뒤**(표별 꼬리 앞).
--       PK 의 선두 `(cycle_id, generation_id)` 는 건드리지 않는다 — 정리 DELETE 가 쓰는
--       접두사다(0065 블록 ③).
-- 멱등: `presence_set` 이 이미 PK 에 있으면 건너뛴다.
DO $do$
DECLARE
  r       record;
  in_pk   boolean;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('summary_trend_answers',
       'cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, depth2, depth3, in_root_catalog, in_tagged_region, in_full_cycle, run_status, report_fs'),
      ('summary_trend_brands',
       'cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status, report_fs, brand_id, brand_name'),
      ('summary_trend_domains',
       'cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status, report_fs, group_key, matched_base, base_norm_null'),
      ('summary_trend_own',
       'cycle_id, generation_id, country, lang, engine, catalog_brands, funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, in_root_catalog, in_tagged_region, in_full_cycle, run_status, report_fs, own_variant')
    ) AS v(tbl, pk)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
      WHERE i.indrelid = format('public.%I', r.tbl)::regclass
        AND i.indisprimary
        AND a.attname = 'presence_set'
    ) INTO in_pk;

    IF NOT in_pk THEN
      -- 제약 이름은 0059 가 만든 기본 이름(`<표>_pkey`) 이다. 다르면 여기서 크게 실패한다 —
      -- 조용히 넘어가는 것보다 낫다(단일 tx 라 아무것도 남지 않는다).
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.tbl || '_pkey');
      EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (%s)', r.tbl, r.pk);
    END IF;
  END LOOP;
END
$do$;

-- ── ②-b PK 형태 단언 ─────────────────────────────────────────────────────────
-- 재작성이 실제로 일어났는지, 컬럼 수가 기대와 같은지 마이그레이션이 스스로 확인한다.
-- 기대: answers 17→19 · brands 17→19 · domains 18→20 · own 16→18 (2026-09-10 pg_index 실측 기준).
DO $do$
DECLARE
  r     record;
  ncols int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('summary_trend_answers', 19), ('summary_trend_brands', 19),
      ('summary_trend_domains', 20), ('summary_trend_own',    18)
    ) AS v(tbl, want)
  LOOP
    SELECT array_length(i.indkey::int2[], 1) INTO ncols
    FROM pg_index i
    WHERE i.indrelid = format('public.%I', r.tbl)::regclass AND i.indisprimary;

    IF ncols IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '0066: %의 PK 컬럼 수가 %여야 하는데 %다', r.tbl, r.want, ncols;
    END IF;
    -- 두 컬럼이 정말 키에 들어갔는지도 이름으로 확인한다(개수만 보면 자리 바꿔치기를 놓친다).
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
      WHERE i.indrelid = format('public.%I', r.tbl)::regclass AND i.indisprimary
        AND a.attname = 'report_fs'
    ) THEN
      RAISE EXCEPTION '0066: %의 PK 에 report_fs 가 없다', r.tbl;
    END IF;
  END LOOP;
END
$do$;

-- ── ③ 인덱스 — **추가하지 않는다** (근거를 남긴다) ───────────────────────────
-- 0065 의 `*_read`(surface, cycle_anchor_at, project_id, country, engine)·`*_cb`(gin
-- catalog_brands)·`*_gen`(cycle_id, generation_id)를 그대로 쓴다. 두 컬럼을 얹지 않는 이유:
--   · `report_fs` — `*_read` 에 붙이면 범위 조건(`cycle_anchor_at`) **뒤**라 경계로 못 쓰고
--     in-index 필터가 될 뿐이다. 그 이득이 있으려면 그레인이 커야 하는데, 이 컬럼이 발화하는
--     웹사이트 표면의 답변 그레인은 **250행**(실측)이다. 인덱스 폭·쓰기 증폭만 는다.
--   · `presence_set text[]` — 조회가 `&&`(any-match) 라 btree 로는 못 탄다. gin 을 만들 수는
--     있으나 **distinct 가 4개**(`{branded}` 43% · `{unbranded}` 36% · `{}` 21% · 혼재 0.7%)
--     로 선택도가 없다 — 플래너가 쓰지 않거나 써도 손해다.
--   · 그리고 지금은 표가 비어 있어 **EXPLAIN 근거를 만들 수 없다**. 이 리포의 규율은
--     "성능 수정은 EXPLAIN 근거 없이 배포 금지" 다(0064 블록 ③ 과 같은 자세).
-- → 필요 판정은 **T4 가 실데이터로** 한다. 필요해지면 별도 파일에서 CONCURRENTLY 로.

-- ── ④ 통계 갱신 · ACL ────────────────────────────────────────────────────────
-- 0062 의 `st_summary_trend_*_cyc_gen` 확장 통계는 (cycle_id, generation_id) 대상이라
-- 이 변경으로 무효화되지 않는다. 다만 TRUNCATE·PK 재작성 뒤라 통계가 낡았으므로
-- 4표만 ANALYZE 한다(비어 있어 즉시 끝난다 — 60표 전수 함수는 부르지 않는다).
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['summary_trend_answers','summary_trend_brands',
                           'summary_trend_domains','summary_trend_own'] LOOP
    EXECUTE format('ANALYZE public.%I', t);
    -- 새 표·함수는 만들지 않았지만(컬럼·PK 뿐) 0059·0064·0065 관례대로 한 번 더 닫는다.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END
$do$;

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 락 가드를 함께 넣을 것 — PK 재작성은 ACCESS EXCLUSIVE 다.
--   ⚠️ 되돌리면 집계층은 다시 **비워야 한다**(옛 PK 로는 새 데이터가 유일하지 않을 수 있다).
--   SET LOCAL lock_timeout = '3s';
--   TRUNCATE TABLE summary_trend_answers, summary_trend_brands,
--                  summary_trend_domains, summary_trend_own;
--   ALTER TABLE summary_trend_answers DROP CONSTRAINT summary_trend_answers_pkey,
--     ADD PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands,
--       funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1, depth2,
--       depth3, in_root_catalog, in_tagged_region, in_full_cycle, run_status);
--   ALTER TABLE summary_trend_brands DROP CONSTRAINT summary_trend_brands_pkey,
--     ADD PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands,
--       funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
--       in_root_catalog, in_tagged_region, in_full_cycle, run_status, brand_id, brand_name);
--   ALTER TABLE summary_trend_domains DROP CONSTRAINT summary_trend_domains_pkey,
--     ADD PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands,
--       funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
--       in_root_catalog, in_tagged_region, in_full_cycle, run_status, group_key,
--       matched_base, base_norm_null);
--   ALTER TABLE summary_trend_own DROP CONSTRAINT summary_trend_own_pkey,
--     ADD PRIMARY KEY (cycle_id, generation_id, country, lang, engine, catalog_brands,
--       funnel_catalog, funnel_scope, brand_presence_resolved, list_type, depth1,
--       in_root_catalog, in_tagged_region, in_full_cycle, run_status, own_variant);
--   ALTER TABLE summary_trend_domains  DROP COLUMN unit_owned_citations;   -- 블록 ①-b
--   ALTER TABLE summary_trend_answers  DROP COLUMN report_fs, DROP COLUMN presence_set;
--   ALTER TABLE summary_trend_brands   DROP COLUMN report_fs, DROP COLUMN presence_set;
--   ALTER TABLE summary_trend_domains  DROP COLUMN report_fs, DROP COLUMN presence_set;
--   ALTER TABLE summary_trend_own      DROP COLUMN report_fs, DROP COLUMN presence_set;
