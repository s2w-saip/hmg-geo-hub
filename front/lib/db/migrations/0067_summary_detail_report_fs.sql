-- 0067 — PR③ 위생: 세부층 `report_fs` · 집계층 `own_negative` (인덱스 정리는 **하지 않는다**).
--
-- 세 항목을 받았고, 실측 뒤 **둘만 남았다**. 셋째(인덱스 DROP)는 전제가 재실측에서
-- 뒤집혔다 — 블록 ③ 참조. 근거 없는 DROP 을 하지 않는 것이 이 파일의 결론이다.
--
-- ⚠️⚠️ 적용 절차 (D1 — 이 파일만 적용하고 끝내면 값이 틀린다):
--   `own_negative` 는 집계층 규약대로 `NOT NULL DEFAULT 0` 이라, 적용 순간 **기존
--   25,808행**(실측: 글로벌 24,808 · 웹사이트 1,000)이 전부 **조용한 0** 이 된다.
--   `report_fs` 에는 그 위험 때문에 DEFAULT 를 안 붙였는데(머리 주석 ⓑ), 집계층은
--   세부층과 달리 **언제든 재생성되는 파생 데이터**라 같은 처방을 쓸 수 없다
--   (NULL 로 두면 리더가 매번 COALESCE 를 해야 하고 가산성 단언이 흐려진다).
--   → 해소는 타입이 아니라 **절차**다. 적용 직후 반드시:
--
--       npm run summary:generate -- --surface=global  --refold --all-published --yes
--       npm run summary:generate -- --surface=website --refold --all-published --yes
--
--   ⚠️ 세 플래그가 **전부** 필요하다(2026-09-10 코드 확인):
--     · `--surface=global|website` 없으면 usage 로 즉시 종료한다(generate-cycle.ts:246).
--       표면을 한 번에 둘 다 도는 형태가 없어서 **두 번 돌린다**.
--     · `--yes` 없으면 `APPLY=false` → **DRY-RUN(쓰기 없음)** 이다(:96, :366).
--     하나라도 빠지면 이 절차 자체가 조용히 no-op 이 되고, 막으려던 "조용한 0" 이 그대로 남는다.
--
--   `--refold` 는 **세부층을 건드리지 않고** 집계층 4표만 재생성한다 — 그 순간
--   `own_negative` 가 실값으로 덮인다. 이것을 안 돌리면 Sub-KPI negativeMentions 가
--   화면에서 조용히 0 으로 나온다(에러도 빈 값도 아니라 눈에 안 띈다).
--   확인: `SELECT count(*) FROM summary_trend_own WHERE own_negative > 0;`
--         비교 모수 = `own_signals > 0` 인 **13,617행**(실측). 성공하면 그와 같은 자릿수의
--         양수가 나온다. **0 이면 refold 가 안 돈 것**이다(플래그를 다시 확인할 것).
--
-- 규약 (0065·0066 과 동일):
--   · 멱등 — 재실행 안전. `IF NOT EXISTS` 금지(no-op 이어도 락을 먼저 잡는다) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → `CONCURRENTLY` 불가.
--   · additive-only — 이 파일은 DROP 이 **하나도 없다**(0066 의 PK 재작성 같은 예외 없음).
--   · `summary_*` 계열이라 `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0066 과 같은 자세).
--
-- ── ① `summary_domain_citations.report_fs` — 왜 (T7 실측) ────────────────────
-- 웹사이트 2단 enrich(§3-4 19, 집계층 top-N → 세부층 보강)가 유닛 게이트를 걸려고
-- `summary_answers` 로 **job 세미조인**을 남긴다 — 148.9 ms(기준 130 ms 초과).
-- 인용표가 `report_fs` 를 직접 갖고 있으면 그 조인이 사라진다.
--
-- **타입은 `int` NULL 이다 — 0066 집계층의 `int NOT NULL DEFAULT 0` 과 다르다.** 이유 둘:
--   ⓐ 세부층 정본 `summary_answers.report_fs` 가 `integer NULL` 이다(2026-09-10 실측:
--      웹사이트 20,058행 중 NULL 64 · distinct 109 · 값 1~144, 글로벌은 전량 NULL).
--      세부층끼리 규약이 달라지면 접기의 `COALESCE(report_fs, 0)`(fold.ts) 가 두 뜻을 갖는다.
--   ⓑ `NOT NULL DEFAULT 0` 으로 붙이면 **기존 150,729행이 조용히 0 이 된다**. 웹사이트
--      54,760행은 실제 값이 있어야 하므로 그건 틀린 값이다. NULL 로 두면 "아직 백필 안 됨"
--      이 **관측 가능**하다 — 백필 진행을 `WHERE report_fs IS NULL` 로 셀 수 있다.
--   집계층으로 접힐 때는 0066 규약대로 `COALESCE(…, 0)` 이므로 값 의미는 그대로다.
--
-- 락·소요 (2026-09-10 실측): `summary_domain_citations` = 파티션 부모 · 자식 **8개** ·
--   **150,729행 · 134 MB**(전량 `summary_domain_citations_20260831` 한 자식).
--   `ADD COLUMN <type>` (DEFAULT 없음)은 PG 11+ 에서 **메타데이터 전용** — 테이블을 다시
--   쓰지 않는다. 부모에 걸면 자식 8개까지 재귀하며 각각 ACCESS EXCLUSIVE 를 잡지만
--   **카탈로그 갱신뿐이라 밀리초**다. `lock_timeout='3s'` 가 대기 상한을 준다.
--   ⚠️ 그래도 ACCESS EXCLUSIVE 는 **읽기까지 막는다** — 생성 러너·조회가 도는 중이면 그동안
--      대기한다. 락을 못 잡으면 파일 전체가 깨끗이 중단된다(재시도 가능).
--
-- 새 주 파티션은 자동으로 물려받는다: 0064 의 `summary_ensure_week_partitions()` 는
--   `CREATE TABLE %I PARTITION OF %I FOR VALUES …` 로 만든다 — **컬럼 목록을 적지 않으므로**
--   부모의 컬럼을 그대로 받는다. 그 함수는 고칠 것이 없다(확인함: 0064 블록 ②).
--
-- 기존 행 백필은 **이 파일에 넣지 않는다**(DDL 과 대량 DML 을 한 tx 에 섞지 않는다).
--   대상 규모(실측): 전체 150,729행 = 글로벌 95,969(**백필 대상 아님** — 정본이 NULL)
--   + 웹사이트 **54,760**행. `(cycle_week, cycle_id, generation_id, job_id)` 로
--   `summary_answers` 와 **150,729/150,729 전부 조인된다**(실측). 활성 generation 외의
--   잔재 행은 없다(쌍 96개 = 회차 96개). 백필 SQL 은 아래 "백필" 절 참조.

SET LOCAL lock_timeout = '3s';

-- ── ⓪ 트랜잭션 블록 가드 (0065·0066 과 동일) ─────────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
-- 그 상태로 134 MB 파티션 부모에 ACCESS EXCLUSIVE 를 걸면 무한 대기다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0067: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ① summary_domain_citations.report_fs (세부층, NULL 허용) ─────────────────
DO $do$
BEGIN
  IF to_regclass('public.summary_domain_citations') IS NULL THEN
    RAISE EXCEPTION '0067: summary_domain_citations 가 없다 — 0059 를 먼저 적용할 것';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_domain_citations'::regclass
      AND attname = 'report_fs' AND attnum > 0 AND NOT attisdropped
  ) THEN
    -- DEFAULT 를 붙이지 않는다 — 붙이면 기존 웹사이트 54,760행이 틀린 0 으로 굳는다(머리 주석 ⓑ).
    EXECUTE 'ALTER TABLE public.summary_domain_citations ADD COLUMN report_fs int';
  END IF;
END
$do$;

COMMENT ON COLUMN summary_domain_citations.report_fs IS
  '보고서 유닛 게이트 — 그 job 의 summary_answers.report_fs 를 생성 시각에 굳힌 값. 웹사이트에서만 값이 있고 글로벌은 NULL(정본이 NULL 이다). NULL 은 "미부여" 또는 "미백필" 둘 다를 뜻하므로, 백필 진행은 WHERE report_fs IS NULL 로 센다. 집계층으로 접힐 때는 0066 규약대로 COALESCE(…, 0). 이 컬럼이 있어야 웹사이트 2단 enrich 가 summary_answers job 세미조인을 안 남긴다(T7: 148.9 ms).';

-- ── ② summary_trend_own.own_negative (집계층 측정 컬럼, 키 아님) ─────────────
-- 왜 (T5 실측): Sub-KPI 의 `negativeMentions` 를 내려고 리더가 `engineBrand` 축을 우회해
-- 쓰고 있다. `own_positive`·`own_signals` 와 같은 갈래(`ob`→`pb`)에서 한 번에 접히는 값이라
-- 집계층에 굳히면 그 우회가 사라진다. `own_signals` = pos+neu+neg+mixed 이므로
-- `own_negative` 는 그 부분합이다 — 가산 가능하고 그룹 간 SUM 이 성립한다.
-- 키가 아니므로 PK 는 바꾸지 않는다(0066 의 19/19/20/18 그대로).
-- ⚠️ 기존 25,808행은 DEFAULT 0 으로 굳는다 — 적용 직후 **두 표면 각각**
--      `npm run summary:generate -- --surface=<global|website> --refold --all-published --yes`
--    로 덮어야 한다(머리 주석 "적용 절차"). `--surface`·`--yes` 가 빠지면 각각 usage 종료·
--    DRY-RUN 이라 아무것도 안 덮인다. `report_fs` 와 달리 NULL 을 못 쓰는 이유도 거기 있다.
DO $do$
BEGIN
  IF to_regclass('public.summary_trend_own') IS NULL THEN
    RAISE EXCEPTION '0067: summary_trend_own 이 없다 — 0059 를 먼저 적용할 것';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_trend_own'::regclass
      AND attname = 'own_negative' AND attnum > 0 AND NOT attisdropped
  ) THEN
    -- 집계층은 0065·0066 규약대로 NOT NULL DEFAULT 0 (접기가 항상 값을 넣는다).
    EXECUTE 'ALTER TABLE public.summary_trend_own ADD COLUMN own_negative int NOT NULL DEFAULT 0';
  END IF;
END
$do$;

COMMENT ON COLUMN summary_trend_own.own_negative IS
  'Sub-KPI negativeMentions 분자 — 키 그룹 안 당사 브랜드 행의 negative 합. own_signals(= positive+neutral+negative+mixed)의 부분합이라 그룹 간 SUM 가산. 접기는 own_positive 와 같은 pb 갈래에서 낸다(fold.ts).';

-- ── ③ 인덱스 정리 — **하지 않는다** (전제가 재실측에서 뒤집혔다) ─────────────
-- 받은 근거: `summary_trend_answers_cb`·`summary_trend_brands_cb`(gin, 합 4 MB) 가
--   `idx_scan = 0`, 그리고 0059 `*_pick` 은 "플래너가 한 번도 안 고름".
-- 2026-09-10 재실측(`pg_stat_user_indexes`, `pg_stat_database.stats_reset IS NULL`
-- = 카운터가 DB 기동 이래 누적이고 한 번도 리셋된 적 없다):
--
--   표        인덱스        idx_scan   크기        판정
--   answers   _cb                  3   696 kB     **쓰인다**
--   brands    _cb                 23  3312 kB     **쓰인다**
--   answers   _pick               49   416 kB     쓰인다
--   brands    _pick              175  1728 kB     쓰인다
--   domains   _pick              208  1120 kB     쓰인다
--   own       _pick              182   368 kB     쓰인다
--
-- 넷 다 0 이 아니다. 이전 관측(`_cb` 0)은 그 플랜이 아직 안 돌았을 때의 스냅샷이었고,
-- `*_pick` 은 T4 라운드 4 이후 own 문장이 실제로 고른다(0067 조사 커밋의 A/B 실측:
-- 회차 술어를 상수로 편 형태에서 own 이 `summary_trend_own_pick` 을 골라 11.4 ms).
--
-- 절감도 작다: 집계층 4표 총 **407 MB**(인덱스 229 MB) 중 `_cb` 2개는 **4 MB = 1.0%**,
-- `*_pick` 4개까지 더해도 **7.6 MB = 1.9%** 다. 연 19 GB 추정에서 유의미하지 않다.
-- 반면 잘못 지우면 그 플랜이 `*_pkey`(brands 104 MB · domains 70 MB)로 떨어진다 —
-- 이 리포가 방금 값을 치른 그 회귀다.
-- → **이득 1.9% · 위험 비대칭 → DROP 하지 않는다.** 이 리포의 규율 "성능 수정은 EXPLAIN
--    근거 없이 배포 금지" 는 인덱스 **제거**에도 똑같이 적용된다.
--    재판정 조건: 기간 모드(회차 N개) 실측 뒤, `idx_scan` 이 리셋 이후로도 0 일 때.

-- ── ④ ACL ────────────────────────────────────────────────────────────────────
-- 새 표·함수를 만들지 않았다(컬럼 2개뿐) — 컬럼 추가는 표 ACL 을 바꾸지 않는다.
-- 그래도 0059·0064·0065·0066 관례대로 한 번 더 닫는다. 파티션 자식은 부모 ACL 을
-- 상속하지 않으므로 인용표는 **자식까지** 훑는다(0064 의 교훈).
DO $do$
DECLARE r record;
BEGIN
  EXECUTE 'REVOKE ALL ON public.summary_trend_own FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON public.summary_domain_citations FROM PUBLIC, anon, authenticated';
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.summary_domain_citations'::regclass
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', r.relname);
  END LOOP;
END
$do$;

-- ── 백필 (참고 — **이 파일 밖에서, 제품 책임자 승인 배치로**) ───────────────────────
--   대상: 웹사이트 54,760행(글로벌 95,969행은 정본이 NULL 이라 대상이 아니다).
--   전 행이 `summary_answers` 와 조인된다(실측 150,729/150,729).
--   ⚠️ 대량 UPDATE 안전수칙: 사전 행수 SELECT · 파티션 한정 · 백업 확인.
--      한 파티션(`_20260831`)뿐이라 한 문장으로 끝나지만, 주가 늘면 파티션별로 쪼갠다.
--
--   -- 사전 확인 (기대값과 다르면 멈춘다)
--   SELECT count(*) FROM summary_domain_citations WHERE report_fs IS NULL;   -- 150,729
--   SELECT count(*) FROM summary_domain_citations d
--     JOIN summary_answers a USING (cycle_week, cycle_id, generation_id, job_id)
--    WHERE a.report_fs IS NOT NULL;                                          -- 54,578 (= 갱신 대상)
--
--   -- 백필 — 주(cycle_week)별로 쪼개 **파티션 프루닝**을 살린다. 현재 주는 하나뿐이지만
--   -- (실측: `2026-08-31` 150,729행 전량) 주가 늘면 이 형태 그대로 반복하면 된다.
--   -- 한 문장에 한 파티션 → 락 구간이 짧고, 중단돼도 이미 끝난 주는 다시 안 돈다.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   UPDATE summary_domain_citations d SET report_fs = a.report_fs
--   FROM summary_answers a
--   WHERE d.cycle_week = DATE '2026-08-31' AND a.cycle_week = DATE '2026-08-31'  -- ← 프루닝 술어(양쪽)
--     AND a.cycle_id = d.cycle_id AND a.generation_id = d.generation_id
--     AND a.job_id = d.job_id
--     AND a.report_fs IS NOT NULL                    -- 글로벌(전량 NULL)은 건드리지 않는다
--     AND d.report_fs IS DISTINCT FROM a.report_fs;  -- 멱등 — 재실행하면 0행
--   -- ⚠️ rowcount 단언: psql 이 찍는 `UPDATE n` 이 **54578** 이어야 한다.
--   --    (54,760 웹사이트 인용 행 − 182. 182 = 세부층 report_fs 가 NULL 인 답변 64건에
--   --     매달린 인용 행 수, 2026-09-10 실측.) 다르면 ROLLBACK 하고 원인을 먼저 본다.
--   COMMIT;
--
--   -- 백필 직후 **반드시** (D4): 통계가 "report_fs 전량 NULL" 로 남아 있으면 T7 의 2단
--   -- enrich 술어(`report_fs = ANY(…)`)를 플래너가 0행으로 추정해 플랜이 무너진다.
--   -- 컬럼을 새로 채웠으므로 autovacuum 을 기다리지 않는다.
--   ANALYZE summary_domain_citations;
--
--   -- 사후 확인 (웹사이트 회차만)
--   SELECT count(*) FROM summary_domain_citations d
--   JOIN summary_cycles c ON c.cycle_id = d.cycle_id
--   WHERE c.surface = 'website' AND d.report_fs IS NULL;   -- **182** 여야 한다
--                                                          -- (정본이 NULL 인 답변 64건 몫)
--   SELECT count(*) FROM pg_stats
--    WHERE tablename = 'summary_domain_citations' AND attname = 'report_fs';  -- > 0 (통계 존재)
--
--   대안: 그 회차를 **재생성**하면 새 generation 이 값을 갖고 태어난다(러너 `--refold` 는
--   세부층을 안 건드리므로 재생성이어야 한다). 회차 96개를 다 돌릴 비용 대비
--   위 UPDATE 한 문장이 싸다 — 판단은 제품 책임자 몫.

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 락 가드를 함께 넣을 것 — DROP COLUMN 도 ACCESS EXCLUSIVE 다(파티션 자식 8개 포함).
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE summary_domain_citations DROP COLUMN report_fs;
--   ALTER TABLE summary_trend_own        DROP COLUMN own_negative;
--   -- 블록 ③ 은 아무것도 안 했으므로 되돌릴 것이 없다.
--   -- (만약 나중에 인덱스를 지웠다면 되돌리는 DDL 은 이것이다 — 0059/0065 원문)
--   -- CREATE INDEX summary_trend_answers_cb ON summary_trend_answers USING gin (catalog_brands);
--   -- CREATE INDEX summary_trend_brands_cb  ON summary_trend_brands  USING gin (catalog_brands);
--   -- CREATE INDEX summary_trend_answers_pick ON summary_trend_answers (surface, project_id, cycle_anchor_at);
--   -- CREATE INDEX summary_trend_brands_pick  ON summary_trend_brands  (surface, project_id, cycle_anchor_at);
--   -- CREATE INDEX summary_trend_domains_pick ON summary_trend_domains (surface, project_id, cycle_anchor_at);
--   -- CREATE INDEX summary_trend_own_pick     ON summary_trend_own     (surface, project_id, own_variant, cycle_anchor_at);
