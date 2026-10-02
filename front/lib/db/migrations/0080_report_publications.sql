-- 0080 — 발행 리포트 사실표 3개 (report_publications · report_site_facts ·
--        report_site_engine_facts). "발행 회차는 발행값을 읽는다" 의 저장층.
-- 적용: npm run db:apply -- 0080   (제품 책임자 실행. drizzle-kit migrate 금지)
-- 정본 스펙: workspace notes/hmg-anchor-table/website-citation-parity/
--            SPEC-report-ground-truth.md
--
-- ── 왜 새 표인가 ─────────────────────────────────────────────────────────────
-- 고객 결정(제품 책임자 2026-09-20): "리포트는 절대 진실이어야 한다. 대시보드를 고쳐야
-- 한다." 산식과 모집단을 똑같이 맞추는 것만으로는 이것이 성립하지 않는다 — 추출기는
-- 한 시점의 스냅샷이고 대시보드는 같은 미러를 라이브로 읽는다. 늦게 도착한 답변 한
-- 건, 재분석 한 건이 곧바로 값을 가른다(실측: Kia GR 분모 78 → 100 · Genesis UK
-- 분자 +2 · CPO 분자 3 → 5). 정확 일치 되돌리기(2026-09-20)로 **규칙** 차이는
-- 없앴지만 **시점** 차이는 산식으로 막을 수 없다.
--
-- 그래서 고객이 실제로 본 숫자 — 발행된 HTML 안 `<script id="sb-data">` 의 정수 쌍 —
-- 을 그대로 적재하고, 발행 회차는 그것을 읽는다. 값이 라이브에서 파생되지 않으므로
-- 흔들릴 원인이 구조적으로 없다.
--
-- ⚠️ `summary_*` 사실표를 정본으로 쓰지 않는 이유: 그것은 **재생성되는 파생물**이다
-- (0067 이 적용 후 `--refold --all-published` 를 절차로 요구한다). 발행 시점과 생성
-- 시점이 다르면 같은 회차라도 값이 다르다. 대조군으로만 쓴다.
--
-- ── additive-only ────────────────────────────────────────────────────────────
-- 신규 테이블 3개뿐. 기존 테이블 ALTER 없음(0007 prod 장애 교훈). 기존 표를 읽지도
-- 않는다 — 이 표들은 `file_seq`(= website_prompts.file_seq) 로만 대시보드와 만난다.
-- FK 를 두지 않는 것도 같은 계열의 규율이다(0053·0054·0077): 미러 재싱크의 run 단위
-- delete+insert 가 발행값을 지우면 안 된다. 발행값은 미러의 수명과 무관하다.
--
-- ── 멱등 ─────────────────────────────────────────────────────────────────────
-- 전부 신규 객체라 `CREATE TABLE IF NOT EXISTS` 가 맞다 — 존재하지 않는 객체에는
-- 잡을 락이 없다(0072 와 같은 판단. 기존 테이블 ALTER 의 IF NOT EXISTS 금지 규율과
-- 혼동하지 말 것). 재적용은 no-op 이고 pglite 테스트가 2회 적용으로 이를 단언한다.

SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- 트랜잭션 밖에서 적용되면 `SET LOCAL` 이 조용히 무효가 된다(경고만). 0070~0072 와
-- 같은 가드로 **적용 경로 자체를 단언**한다(npm run db:apply 는 항상 tx 안이다).
DO $guard$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN
    RAISE EXCEPTION '0080: 트랜잭션 블록 밖에서 적용 중 — npm run db:apply -- 0080 로 적용할 것';
  END IF;
END
$guard$;--> statement-breakpoint

-- ── ① 발행물 원장 ────────────────────────────────────────────────────────────
--
-- 발행물 1건 = 1행. `source_sha256` 이 그 발행물의 신원이다 — 같은 해시의 재적재는
-- no-op 이고, 다른 해시가 같은 자리로 들어오면 앞의 행을 `superseded` 로 내린다.
--
-- ⚠️ `round_date` 는 **측정일이 아니라 회차 라벨**이다. 발행물 안에서 둘이 다르다:
--    `asOf.cur` = 2026-09-10 (추출 시점) · `asOf.curLabel` = 2026-09-11 (회차).
--    대시보드의 website 회차 축(`round_date`, 금요일 · 0077)과 맞는 쪽은 후자다.
--    측정일은 감사용으로 `asof_cur` 에 따로 싣는다.
CREATE TABLE IF NOT EXISTS "report_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- 사람이 읽는 식별자. 'vol2-v3.0-global-20260915'.
  "slug" text NOT NULL,
  -- 'website' 만 쓴다. 다른 표면의 발행물이 생기면 여기로 갈라진다.
  "surface" text NOT NULL,
  -- 'Global' | 'Hyundai' | 'Kia' | 'Genesis'. NOT NULL 이다 — nullable 이면 아래
  -- 부분 유니크 인덱스에서 NULL 끼리 서로 다른 것으로 취급돼 중복 active 가 생긴다.
  "brand_scope" text NOT NULL,
  "volume" text,
  "version" text NOT NULL,
  "title" text,
  -- 회차 라벨 원문(ko/en). 화면이 다시 포맷하면 측정일과 회차가 섞인다 — 그대로 쓴다.
  "cycle_label" text,
  "cycle_label_en" text,
  -- 회차 귀속 날짜(= sb-data asOf.curLabel). 리더의 조인 키다.
  "round_date" date NOT NULL,
  "prev_round_date" date,
  -- 추출 시점(sb-data asOf.cur / asOf.prev). 회차 라벨과 다르다.
  "asof_cur" date,
  "asof_prev" date,
  -- 발행일(sb-data asof, 소문자 키).
  "published_on" date,
  "engines" text[],
  -- 고객 요청으로 리포트에서 통째로 빠진 유닛(sb-data excluded[]). 그 유닛은
  -- report_site_facts 에 **행 자체가 없다** — 여기 기록은 "왜 없는가" 의 근거다.
  "excluded_fs" integer[],
  -- 헤드라인 평균의 모수 / 전체 모수(sb-data bench.n / bench.nAll). 104 / 105.
  "bench_n" integer,
  "bench_n_all" integer,
  "src_cite" text,
  "source_filename" text NOT NULL,
  "source_sha256" text NOT NULL,
  -- 검수 매니페스트(docs/data/.verify-manifest.json)에 같은 해시가 있었는가.
  -- 소급 적재분은 false 다(제품 결정 J-4: 화면 표식은 같게, 기록만 구분).
  "manifest_verified" boolean DEFAULT false NOT NULL,
  "verify_note" text,
  -- 파서가 인식한 sb-data 형식. 구버전(v2.4 = k5·c5 만 있고 co·o6 가 없다)은
  -- 이번 판이 거부하므로 현재 값은 'vol2' 하나뿐이다.
  "sb_data_version" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "superseded_by" uuid,
  "ingested_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "report_publications_status_ck"
    CHECK ("status" IN ('active', 'superseded', 'rolled_back')),
  CONSTRAINT "report_publications_bench_ck"
    CHECK ("bench_n" IS NULL OR "bench_n_all" IS NULL OR "bench_n" <= "bench_n_all")
);--> statement-breakpoint

-- slug 는 전역 유일. 같은 발행물을 두 자리에 적재하는 것을 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS "report_publications_slug_uq"
  ON "report_publications" ("slug");--> statement-breakpoint

-- **리더의 안전장치.** (표면, 회차, 브랜드 범위) 당 active 는 최대 1행이다. 이것이
-- 없으면 정정 발행이 앞 행을 안 내렸을 때 리더가 두 발행물 중 하나를 임의로 골라
-- 조용히 다른 숫자를 낸다.
CREATE UNIQUE INDEX IF NOT EXISTS "report_publications_active_uq"
  ON "report_publications" ("surface", "round_date", "brand_scope")
  WHERE "status" = 'active';--> statement-breakpoint

-- 멱등 재적재 판정(같은 해시가 이미 있는가).
CREATE INDEX IF NOT EXISTS "report_publications_sha_idx"
  ON "report_publications" ("source_sha256");--> statement-breakpoint

-- ── ② 사이트(유닛) 단위 정수 쌍 ─────────────────────────────────────────────
--
-- 입도는 `file_seq`(= sb-data sites[].u = website_prompts.file_seq)다. 언어·URL 로
-- 갈린 서브셋 유닛(fs 5 의 urlNotLike 등 7개)도 이 입도에서 **자동으로 정확**하다.
--
-- ⚠️ **백분율을 저장하지 않는다.** 동일성은 정수 쌍에 건다. 리포트 안에 f1·f2 두
-- 표기가 공존하고 카드는 toFixed(1) 이라, 실수로 비교하면 반올림이 다른 오차를 가린다.
CREATE TABLE IF NOT EXISTS "report_site_facts" (
  "publication_id" uuid NOT NULL,
  "file_seq" integer NOT NULL,
  -- sb-data sites[].b. dash.brand 는 GLOBAL-N 2개(fs 40·41)에서 null 이라 쓰지 않는다.
  "brand" text NOT NULL,
  -- sb-data sites[].dash.geo. 가상 지역 코드(CPO·worldwide·CN-BJ·SA-Riyadh 등)가
  -- 섞여 있고 그것이 정상이다 — 대시보드 website 지역 축과 같은 어휘다.
  "country_code" text,
  "country_name" text,
  -- sb-data sites[].r. '중남미'·'WW' 같은 **HMG 운영 어휘**다. 표에는 그대로 싣고
  -- 화면이 의미를 해석하지 않는다(정렬·대조 키로만 쓴다).
  "region_label" text,
  -- lang_code = dash.lang(소문자, website_prompts.lang_code 와 같은 축)
  -- lang_label = sites[].l(대문자 표기). 둘 다 두는 이유는 조인 축과 표기가 다르기 때문.
  "lang_code" text,
  "lang_label" text,
  -- sb-data sites[].s. '완료'·'진행중'·'논의중'·'무응답'. 에이전시 진행관리 어휘이고
  -- 라이브 회차에는 대응 개념이 없다. 제품 결정 J-2 로 **화면에는 노출하지 않는다** —
  -- 대조 스크립트가 '완료 13개 = 641/966' 을 재현하는 데만 쓴다.
  "agency_status" text,
  -- **헤드라인 평균 모수에 드는가.** 리포트의 표지 숫자(bench.g6 = curAvg.k6 = 58.53)
  -- 는 105개가 아니라 104개 평균이고, 빠지는 1개가 CPO(u=109)다.
  -- ⚠️ 이 값은 코드에 하드코딩하지 않는다 — 적재기가 발행물 데이터에서 역산한다
  --    (Σ 검산으로 "어느 유닛을 빼야 curAvg 4종이 동시에 재현되는가" 를 푼다.
  --     실측 후보는 유일했다. 도출 절차는 lib/reports/sb-data.ts 머리 주석).
  "in_headline_pool" boolean DEFAULT true NOT NULL,
  -- c6 = [타겟 인용 프롬프트, 측정 프롬프트]
  "target_hit_prompts" integer NOT NULL,
  "measured_prompts" integer NOT NULL,
  -- co = [자사 인용 프롬프트, 측정 프롬프트]. 분모는 c6 와 같다(둘 다 np).
  "owned_prompts" integer NOT NULL,
  "owned_prompts_den" integer NOT NULL,
  -- cs = [자사 인용 답변, 모니터 답변]. 답변 기준(분모 = na = np × 2).
  "owned_answers" integer,
  "monitored_answers" integer,
  "prompts" integer,
  "answers" integer,
  -- q6 / qo = 직전 회차의 같은 쌍. 증감을 **발행값끼리** 빼기 위한 것이다 —
  -- 한쪽은 발행값 한쪽은 라이브로 섞어 빼면 증감이 시점 차이를 흡수해 버린다.
  "prev_target_hit_prompts" integer,
  "prev_measured_prompts" integer,
  "prev_owned_prompts" integer,
  "prev_owned_prompts_den" integer,
  -- 그 사이트의 sb-data 원본. 감사·소급용이고 리더는 읽지 않는다.
  "raw" jsonb NOT NULL,
  CONSTRAINT "report_site_facts_pk" PRIMARY KEY ("publication_id", "file_seq"),
  -- 분자 > 분모는 리포트 자체가 깨졌다는 뜻이다. 적재기도 같은 검산을 하지만
  -- 표에도 건다 — 손으로 INSERT 하는 경로가 생겨도 막히게.
  CONSTRAINT "report_site_facts_target_ck"
    CHECK ("target_hit_prompts" >= 0 AND "target_hit_prompts" <= "measured_prompts"),
  CONSTRAINT "report_site_facts_owned_ck"
    CHECK ("owned_prompts" >= 0 AND "owned_prompts" <= "owned_prompts_den")
);--> statement-breakpoint

-- 유닛 하나의 회차별 이력(대조 스크립트·드릴다운). PK 접두사가 publication_id 라
-- 그 축의 조회는 PK 가 덮는다 — 이 인덱스는 반대 방향 전용이다.
CREATE INDEX IF NOT EXISTS "report_site_facts_fs_idx"
  ON "report_site_facts" ("file_seq");--> statement-breakpoint

-- ── ③ 엔진별 분자 ───────────────────────────────────────────────────────────
--
-- ⚠️ **분모가 없다.** sb-data 의 `eng`/`engPrev` 는 엔진별 타겟 인용 프롬프트 수만
-- 담는다. 게다가 실측상 Σeng ≠ c6[0] 이 105개 중 97개다(fs 001: chatgpt 47 +
-- gemini 43 = 90 vs c6[0] = 66) — 한 프롬프트를 두 엔진이 함께 인용하면 양쪽에
-- 세어지기 때문이다. 즉 **합집합도 분할도 아니다.**
--
-- 그래서 엔진 필터는 발행값으로 답할 수 없다(`na = np × 2` 가정은 엔진 실패 시 깨지고,
-- 분자마저 중복 계상이다). 리더는 엔진 축이 켜지면 라이브로 폴백하고 표식을 바꾼다.
-- 이 표를 두는 이유는 그 판정의 **근거를 감사할 수 있게** 남기기 위해서다.
CREATE TABLE IF NOT EXISTS "report_site_engine_facts" (
  "publication_id" uuid NOT NULL,
  "file_seq" integer NOT NULL,
  "engine" text NOT NULL,
  "target_hit_prompts" integer NOT NULL,
  "prev_target_hit_prompts" integer,
  CONSTRAINT "report_site_engine_facts_pk"
    PRIMARY KEY ("publication_id", "file_seq", "engine")
);--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0033·0042·0043·0053·0072·0077 선례와 동일): 신규 테이블은
-- scripts/db/lockdown.sql 재실행 전까지 anon/authenticated 가드가 없다. 적용 후 확인:
--   SELECT has_table_privilege('anon','public.report_publications','SELECT');      -- expect false
--   SELECT has_table_privilege('anon','public.report_site_facts','SELECT');        -- expect false
--   SELECT has_table_privilege('anon','public.report_site_engine_facts','SELECT'); -- expect false
REVOKE ALL ON "report_publications" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "report_site_facts" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "report_site_engine_facts" FROM PUBLIC, anon, authenticated;
