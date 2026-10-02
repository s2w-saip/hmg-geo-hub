-- 0077: 답변 단위 회차 앵커 전수 테이블 — 기간 필터·추이 축·달력·MoM 을 한 시계로.
-- 적용: npm run db:apply -- 0077   (제품 책임자 실행. drizzle-kit migrate 금지)
-- 정본 스펙: internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md
--
-- ── 왜 ────────────────────────────────────────────────────────────────────────
-- 기간 필터가 화면마다 다른 컬럼에 걸려 있다(스펙 §1.1): 스냅샷은 `scope_runs.started_at`,
-- 누적·추이·KPI·ACR 은 `scope_answers.measured_at`, 집계 사실표는 `cycle_anchor_at` 의
-- UTC 일자. 최근 60일 completed 392,415건 실측으로 이 셋이 어긋난다 —
-- 측정일≠앵커일 26.6% · run 시작일≠앵커일 42.6% · 측정 주≠앵커 주 8.7%.
-- 앵커 출처도 이미 셋이다(0053 레지스트리 / summary_cycles 원장 / scope_runs).
--
-- 그래서 **답변 1건 = 1행**의 전수 테이블 하나를 두고, 모든 기간 술어가 이 테이블의
-- `anchor_date` 하나만 보게 만든다(제품 확정 결정 2·3·6).
--
-- ── 회차의 **정규 요일 귀속** (제품 확정 2026-09-19 밤) ──────────────────────
-- 기간 필터·달력·주 버킷의 키는 실제 앵커 날짜가 아니라 **귀속 날짜**(`round_date`)다.
-- 회차를 그 표면의 정규 요일 자리에 앉힌다: **글로벌(standard) = 월요일 · 웹사이트 =
-- 금요일 (KST)**. 프로젝트 표면은 정규 요일이 없어 `round_date = anchor_date` 다.
-- `anchor_date`(실제 KST 일자)는 **기록용으로 유지**한다 — 두 값이 다른 것이 정상이다.
--
-- 배정은 회차 단위 정보라 답변 테이블이 아니라 **작은 매핑 표**(`scope_cycle_rounds`,
-- 회차 약 1,000행)가 갖고, 답변 행은 그 값을 복사한다. 기간 술어가 답변 테이블의
-- `(round_date, job_id)` 인덱스를 타게 하기 위해서다.
--
-- 규칙은 `hmg_assign_cycle_rounds` 본문 주석이 정본이고, 요약은:
--   · anchor_date 가 정규 요일이면 그 날짜(basis `canonical`)
--   · 아니면 그 프로젝트의 **앞 자리**(직전 정규 요일)와 **뒤 자리**(직후 정규 요일)를
--     보고 빈 자리 우선 → 둘 다 비면 가까운 쪽 → 둘 다 차 있으면 가까운 쪽에 **합친다**
--   · 같은 프로젝트의 비정규 회차는 anchor_date 이른 순으로 **차례** 배정
--   · **배정은 저장하고 과거 배정은 재계산하지 않는다**(과거 값 안정성).
--     미배정 회차만 새로 앉힌다. 다시 앉히는 것은 운영자 경로뿐
--     (`scripts/db/reassign-cycle-rounds.ts`, 기본 dry-run).
--
-- 이 규칙이 종전의 website 주별 정렬 백필(`align-website-anchor-weeks.ts`,
-- `source='fleet_align'`)을 **대체한다** — 그 스크립트와 어휘는 이 판에서 제거됐다.
--
-- ── additive-only ─────────────────────────────────────────────────────────────
-- 신규 테이블 2개 + 신규 함수 15개. 기존 테이블 ALTER 없음(0007 prod 장애 교훈).
-- `scope_answer_anchors`(0053)·`_bak_anchor_fold` 는 **읽기만** 한다 — 지우지도
-- 바꾸지도 않는다(8/25·09-01 접기의 원본 measured_at 정본이자 이 테이블의 seed 출처).
--
-- ── `IF NOT EXISTS` 락 함정 회피 ──────────────────────────────────────────────
-- `CREATE … IF NOT EXISTS` 는 **no-op 이어도 락을 먼저 잡는다**(실측 797초 대기·
-- 44세션 적체). 그래서 DDL 은 전부 `to_regclass`·`pg_class` 카탈로그 선확인 DO 블록
-- 안에 둔다 — 이미 있으면 락을 **아예 요청하지 않는다**.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ✅ 결정 R1 확정(제품 책임자 2026-09-19 저녁, 4렌즈 코드리뷰 이후) — 날짜 키는 **KST**
-- ══════════════════════════════════════════════════════════════════════════════
-- 원칙: **DB 저장은 UTC, 화면 표시는 KST.** 앵커 시각 원문(`anchor_at`)은 timestamptz
-- 그대로 UTC 로 저장하고, 거기서 파생되는 **날짜 키**(`anchor_date`·`anchor_week`·
-- `anchor_month`)와 노출 판정의 "오늘"은 `Asia/Seoul` 에서 자른다. 달력·측정 기준일
-- pill·기간 술어·주 버킷·MoM 월이 전부 같은 키를 본다(스펙 §9 R1).
--
-- 같은 날 오후의 'UTC 일자' 확정을 뒤집은 것이다. 감수 사항: 이미 나간 발행본의
-- 회차명은 UTC 일자였으므로 회차 1,033 중 209개(20.2%)는 대시보드 날짜가 발행본보다
-- 하루 뒤로 보인다. run 의 35.2%(9,893/28,078)가 UTC 날짜와 KST 날짜가 다르다.
--
-- 뒤집는 지점은 아래 `hmg_anchor_timezone()` 함수 본문 **한 줄뿐**이다:
--
--   CREATE OR REPLACE FUNCTION hmg_anchor_timezone() RETURNS text
--   LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT 'UTC'::text $fn$;
--
-- 그 한 문장을 실행한 뒤 `npm run db:backfill:answer-anchors -- --apply --recompute`
-- 로 전수 재계산하면 끝이다. 타임존 문자열이 이 파일의 **다른 어디에도 나오지 않는**
-- 것이 이 설계의 전제이고, 리포 전체로도 이 상수의 사본은 dry-run SQL 의 prelude 한
-- 줄뿐이다 — 두 벌이 되는 순간 같은 답변이 경로마다 다른 날짜를 받는다
-- (0052 citation_url_norm·0053 scope_anchor_fold 와 같은 규율).
--
-- ⚠️ 노출(결정 ⑪·⑫)·표면 판정(B4)·0053 이관(R1 말미)의 구현 위치는 아래
-- `refresh_answer_cycle_anchors` 본문 주석에 각각 표시돼 있다. 숨김(R3)은 이 테이블에
-- 복사하지 않는다 — 리더가 `cycle_id` 로 원장을 조인한다(`scope-answer-anchors.ts`).

-- 락 대기 상한. 이 파일은 전부 신규 객체라 기존 테이블 락을 잡지 않지만,
-- 카탈로그 선확인이 실패한 경우에도 대기가 길어지지 않게 끊는다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── 날짜 산술의 정본 (DB 함수. TS 로 한 벌 더 만들지 않는다) ─────────────────

-- R1 의 **유일한** 상수 자리. 이 함수 하나를 바꾸면 anchor_date·anchor_week·
-- anchor_month·view_anchor_date·노출 게이트(`hmg_anchor_today`)가 함께 옮겨간다.
CREATE OR REPLACE FUNCTION hmg_anchor_timezone()
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT 'Asia/Seoul'::text
$fn$;--> statement-breakpoint

-- 앵커 시각 → 회차 날짜. 앵커 시각은 자정이 아니다(상위 22:35Z·01:10Z·22:25Z…)
-- 이므로 **어느 타임존에서 자르느냐가 값을 바꾼다**. 그 선택이 위 한 곳에 있다.
--
-- STABLE(IMMUTABLE 아님): `timestamptz AT TIME ZONE text` 는 런타임 tzdata 에
-- 의존하므로 PG 에서 STABLE 이다(0053 `scope_anchor_fold` 와 같은 이유).
-- 인덱스식으로 쓰지 않는다 — 값은 컬럼으로 저장한다.
CREATE OR REPLACE FUNCTION hmg_anchor_date(ts timestamptz)
RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE STRICT AS $fn$
  SELECT (ts AT TIME ZONE hmg_anchor_timezone())::date
$fn$;--> statement-breakpoint

-- "지금" 의 회차 날짜 — 노출 게이트(`view_anchor_date <= 오늘`)가 쓴다.
-- `current_date` 는 **세션 타임존**을 따른다(서버는 UTC 라 KST 자정~09:00 구간에서
-- 하루 어긋난다). 게이트는 앵커 날짜와 **같은 함수**로 자른다
-- (스펙 §3.3 의 "current_date(같은 타임존)" 이 이 함수다).
CREATE OR REPLACE FUNCTION hmg_anchor_today()
RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT hmg_anchor_date(now())
$fn$;--> statement-breakpoint

-- 0053 이관 **전용** — 어떤 date 의 **UTC 자정**(timestamptz).
--
-- 왜 이 함수가 따로 있나: `scope_answer_anchors`(0053)의 `anchor` 는 **UTC 날짜**다.
-- R1 으로 이 테이블의 날짜 키가 KST 가 됐으므로, 레지스트리 날짜를 그대로 쓰면 같은
-- 회차가 경로마다 하루 어긋난다. 그래서 "UTC 일자가 그 날짜인 회차"를 찾아 그 회차의
-- **시각**을 가져다 KST 로 다시 자른다(스펙 §9 R1 말미). 그 탐색의 경계값이 이 함수다.
--
-- `AT TIME ZONE INTERVAL '0'` 을 쓰는 이유는 **존 이름을 두 벌로 만들지 않기 위해서**다
-- (R1 의 상수는 `hmg_anchor_timezone()` 한 곳뿐이다). 오프셋 0 = UTC 는 tzdata 와
-- 무관한 산술이라 IMMUTABLE 이고, 그래서 아래 탐색이 `(project_id, cycle_anchor_at)`
-- 인덱스를 탄다(`hmg_anchor_utc_date(...) = anchor` 로 쓰면 못 탄다).
--
-- ⚠️ 현재 **호출처는 자가검증뿐이다**(C-3). 실제 탐색(`cyc_utc`)은 같은 산술
-- `(cycle_anchor_at AT TIME ZONE INTERVAL '0')::date` 를 인라인으로 쓴다. 남겨 두는
-- 이유는 자가검증이 그 경계값 산술을 못박기 때문이고, 위 문단은 "이 산술이 왜
-- IMMUTABLE 이어야 하는가" 의 설명으로 읽을 것 — 이 함수를 부르는 탐색은 없다.
CREATE OR REPLACE FUNCTION hmg_anchor_utc_midnight(d date)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
  SELECT (d::timestamp AT TIME ZONE INTERVAL '0')
$fn$;--> statement-breakpoint

-- 회차 날짜 → 그 주의 **월요일**. `date_trunc('week', …)` 은 PG 에서 ISO 월요일이다.
CREATE OR REPLACE FUNCTION hmg_anchor_week(d date)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
  SELECT (date_trunc('week', d::timestamp))::date
$fn$;--> statement-breakpoint

-- 회차 날짜 → **MoM 귀속 월의 1일** = `anchor_date`(KST)의 **달력 월**(스펙 §9 "월 귀속").
--
-- ⚠️ 스펙 초안의 "그 주 목요일이 속한 달"(ISO 주차 귀속) 규칙은 **철회됐다**. 이유는
-- 화면·기간 비교 계층이 전부 달력 월이기 때문이다 — `lib/kpi/calendar-month-window.ts`
-- 의 `monthWindow`/`resolveCalendarMonths`, `lib/kpi/period-compare.ts::judgeStartMonth`,
-- 기간 프리셋(`dimension-filter-panel.tsx` 의 thisMonth·lastMonth). 목요일 규칙을 두면
-- 8/31(월) 회차가 앵커 테이블에서는 9월인데 "지난달(8/1~8/31)" 프리셋 창에는 들어와
-- 같은 회차가 양쪽에서 세어지거나 어느 쪽에서도 안 세어진다.
-- 실측(스펙 §9): 지금까지 UTC 와 KST 로 월이 갈리는 회차는 0.
CREATE OR REPLACE FUNCTION hmg_anchor_month(d date)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
  SELECT (date_trunc('month', d::timestamp))::date
$fn$;--> statement-breakpoint

-- ── 회차 정규 요일 (귀속 규칙의 **유일한** 상수 자리) ────────────────────────
--
-- 글로벌 프롬프트(standard) = **월요일**, 웹사이트 = **금요일**, 프로젝트 = 없음.
-- ISO 요일 번호(1=월 … 7=일)로 돌려준다 — `EXTRACT(ISODOW …)` 와 같은 축이다.
-- NULL = "이 표면에는 정규 요일이 없다" → 귀속 날짜 = `anchor_date` 그대로.
--
-- 요일을 바꿔야 하면 **이 함수 하나**를 CREATE OR REPLACE 하고 운영자 재배정 경로
-- (`scripts/db/reassign-cycle-rounds.ts`)를 돌린다. 값을 다른 SQL·TS 에 또 적지 않는다.
CREATE OR REPLACE FUNCTION hmg_round_canonical_dow(p_surface text)
RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE p_surface WHEN 'standard' THEN 1 WHEN 'website' THEN 5 END
$fn$;--> statement-breakpoint

-- d **이전**(strictly before)의 가장 가까운 정규 요일 날짜 = "앞 자리".
-- d 자신이 정규 요일이면 7일 전이 나온다(자기 자리는 앞 자리가 아니다).
--
-- `%` 의 음수 함정 회피: `EXTRACT(ISODOW)` 도 `p_dow` 도 1..7 이라 차이는 -6..6 이고,
-- +6 을 더해 0..12 로 올린 뒤 나머지를 취하므로 피연산자가 음수가 되지 않는다
-- (PostgreSQL 의 `%` 는 0 쪽으로 자르므로 `(-1) % 7 = -1` 이다).
CREATE OR REPLACE FUNCTION hmg_round_prev_canonical(d date, p_dow int)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
  SELECT d - ((((EXTRACT(ISODOW FROM d)::int - p_dow) + 6) % 7) + 1)
$fn$;--> statement-breakpoint

-- d **이후**(strictly after)의 가장 가까운 정규 요일 날짜 = "뒤 자리".
CREATE OR REPLACE FUNCTION hmg_round_next_canonical(d date, p_dow int)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
  SELECT d + ((((p_dow - EXTRACT(ISODOW FROM d)::int) + 6) % 7) + 1)
$fn$;--> statement-breakpoint

-- ── 기본 측정 엔진 (스펙 §2-17 · 인계 §1 엔진 범위) ─────────────────────────
--
-- **정본은 TS 상수 `lib/scope/engines.ts:37 DEFAULT_AI_ENGINES` 다.** 값은
-- `scope_answers.target` 토큰과 같은 어휘이고(engines.ts 머리 주석: scope 의 schedule
-- `targets` · `TargetCode` zod enum · 미러 `scope_answers.target` 이 한 토큰), 그 파일의
-- `AI_ENGINE_IDS` 가 전체 어휘(chatgpt·gemini·deepseek)다.
--
-- SQL 은 TS 상수를 읽을 수 없어 값을 **여기 한 번만** 적고, 단위 테스트
-- (`0077…sql.test.ts`)가 두 목록을 **대조**해 드리프트를 막는다. 목록을 다른 SQL 에
-- 또 적지 않는다 — 필요하면 이 함수를 부른다.
--
-- 왜 필요한가: website 의 DeepSeek 파일럿 200건·3프로젝트가 8/18·8/21 회차 앵커를
-- 물고 들어와 있다(2026-08-22 파일럿). 현대 베이징 8/21 회차 실측 — 전 엔진 타겟 48·
-- 자사 53 → ChatGPT+Gemini 만 40·52. 옵트인 엔진의 단발 측정을 회차 값에서 가르는 축이다.
CREATE OR REPLACE FUNCTION hmg_anchor_default_engines()
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT ARRAY['chatgpt', 'gemini']::text[]
$fn$;--> statement-breakpoint

-- ── 고정(pinned) 출처 판정 — **사람이 정한 값은 자동 경로가 덮지도 지우지도 않는다** ──
--
-- 지금 해당하는 출처는 **하나뿐**이다:
--   · `registry`  0053 수작업 접기(`scope_answer_anchors`)에서 온 행
--
-- ⚠️ 종전에는 `fleet_align`(website 주별 공통 앵커 정렬 보정)이 함께 고정 출처였다.
-- 그 정렬은 **정규 요일 귀속 규칙으로 대체**되어 어휘·스크립트와 함께 제거됐다
-- (귀속은 앵커를 옮기지 않고 `round_date` 를 따로 두므로 보정 행 자체가 필요 없다).
-- 목록을 함수 한 곳에 둔 이유는 그대로다 — 고정 판정이 upsert·DELETE·감사 셋에서
-- 쓰이므로 리터럴이 흩어지면 한 곳만 늘어난다.
CREATE OR REPLACE FUNCTION hmg_anchor_is_pinned(src text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT src IN ('registry')
$fn$;--> statement-breakpoint

-- upsert 보존 가드 — "표에 있는 값을 그대로 둘 것인가".
--   · `registry`     → 보존. 단 들어오는 값도 `registry` 면 갱신한다(0053 정정 전파)
--   · 그 외          → 항상 EXCLUDED 로 갱신
CREATE OR REPLACE FUNCTION hmg_anchor_keep_existing(t_source text, new_source text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT hmg_anchor_is_pinned(t_source)
     AND NOT (t_source = 'registry' AND new_source = 'registry')
$fn$;--> statement-breakpoint

-- 노출일 산식 — **정의는 여기 한 곳**이다(스펙 §3.3 + §9 "노출").
--
-- insert 경로와 `ON CONFLICT` 경로가 각각 CASE 를 한 벌씩 갖고 있으면, 보존 가드로
-- `anchor_date` 가 옛 값으로 남은 행의 노출일만 **새 앵커 기준**으로 계산되는 어긋남이
-- 생긴다(N-1: 접기로 날짜가 보존된 project 표면 행의 노출일이 자동 앵커 +1일이 됐다).
-- 그래서 두 경로가 같은 함수를 부르고, 보존 경로는 **보존된 anchor_date** 를 넘긴다.
--
-- ⚠️ 분기는 **둘뿐**이다. 종전의 ③ "이미 공개된 과거 회차의 view_anchor NULL 을 앵커
-- 날짜로 채운다"(결정 ⑪)는 **뒤집혔다**(제품 책임자 2026-09-19 19:36, 스펙 §9 "노출" 행):
-- 비어 있는 회차 209개는 채우지 않고 NULL = 비노출 규칙 그대로 간다. 실측상 그 209개는
-- 전부 `closed`/`open`·활성 세대 없음이라 그 분기는 0회차를 구제했다.
--
-- 분기가 둘만 남으면서 이 함수는 **시간에 의존하지 않는다**(`hmg_anchor_today()` 를
-- 부르지 않는다). 그래서 노출일은 (surface, anchor_date, ledger_view_date)의 순수
-- 함수이고, 그 셋이 전부 아래 upsert 의 변경 감지 튜플에 들어 있으므로 "시간이 지나야
-- 값이 바뀌는데 감지가 못 잡는" 형태(N-12)가 구조적으로 생기지 않는다.
CREATE OR REPLACE FUNCTION hmg_anchor_view_date(
  p_surface           text,
  p_anchor_date       date,
  p_ledger_view_date  date
)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    -- ① 원장이 노출일을 찍었으면 그것이 정본(V-1 `swap.ts::publishCycleSql`).
    --    앵커 날짜와 무관한 값이라 보존 경로에서도 그대로 쓴다.
    WHEN p_ledger_view_date IS NOT NULL THEN p_ledger_view_date
    -- ② 결정 ⑫ — 프로젝트 표면은 집계층·회차 원장이 없다. **앵커 +1일**.
    --    R4: fallback_measured 두 프로젝트도 제외 목록 없이 이 규칙을 그대로 탄다.
    WHEN p_surface = 'project' THEN p_anchor_date + 1
    -- ③ 그 외는 NULL = 비노출.
  END
$fn$;--> statement-breakpoint

-- ── 날짜 산술 자가검증 (적용 시점에 DB 가 직접 확인한다) ─────────────────────
-- 단위 테스트는 DB 없이 돌기 때문에 이 산술을 **실행**으로 확인할 수 없다.
-- 그래서 검산을 마이그레이션 안에 넣는다 — 틀리면 적용 자체가 실패한다.
-- (단위 테스트는 이 케이스들이 파일에 존재하는지를 고정한다.)
DO $selftest$
DECLARE
  -- 타임존 **이름**을 다시 적지 않는다(R1 의 상수는 한 곳뿐이다). 대신 "지금 설정된
  -- 존의 오프셋이 +09:00 인가"를 계산으로 묻는다 — 아래 ① 의 기대값은 그때만 유효하다.
  -- 2026-08-31 15:30Z + 9h = 2026-09-01 00:30 (KST). 한국은 서머타임이 없어 연중 고정이다.
  v_kst boolean := (TIMESTAMPTZ '2026-08-31 15:30:00+00' AT TIME ZONE hmg_anchor_timezone())
                   = TIMESTAMP '2026-09-01 00:30:00';
BEGIN
  IF v_kst THEN
    -- ① 22:35Z 는 KST 로 **다음 날** 07:35 이다(앵커 시각 상위 분포의 실제 값).
    --    2026-09-10 22:35Z → KST 2026-09-11 07:35 → 2026-09-11.
    IF hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00') <> DATE '2026-09-11' THEN
      RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_date(2026-09-10 22:35Z) = % (기대 2026-09-11)',
        hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00');
    END IF;
    -- KST 자정 경계를 양방향으로 잡는다(= 14:59:59Z / 15:00:00Z).
    IF hmg_anchor_date(TIMESTAMPTZ '2026-08-31 14:59:59+00') <> DATE '2026-08-31'
       OR hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:00:00+00') <> DATE '2026-09-01' THEN
      RAISE EXCEPTION '0077 자가검증 실패: KST 자정 경계가 어긋난다';
    END IF;
    -- 시각 → 날짜 → 주 → 월 **사슬 전체** 두 벌.
    --   ⓐ 2026-08-31 15:30Z → KST 09-01(화) → 주 08-31(월) → 달력 월 **9월**.
    IF hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00') <> DATE '2026-09-01'
       OR hmg_anchor_week(hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00')) <> DATE '2026-08-31'
       OR hmg_anchor_month(hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00')) <> DATE '2026-09-01' THEN
      RAISE EXCEPTION '0077 자가검증 실패: 2026-08-31 15:30Z 의 날짜·주·월 사슬이 KST 기준이 아니다';
    END IF;
    --   ⓑ 2026-09-10 22:35Z → KST 09-11(금) → 주 09-07(월) → 달력 월 9월.
    IF hmg_anchor_week(hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00')) <> DATE '2026-09-07'
       OR hmg_anchor_month(hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00')) <> DATE '2026-09-01' THEN
      RAISE EXCEPTION '0077 자가검증 실패: 2026-09-10 22:35Z 의 주·월 귀속이 어긋난다';
    END IF;
  END IF;
  -- ①' 0053 이관용 UTC 자정 — 오프셋 0 산술이라 앵커 타임존과 무관하게 항상 참이다.
  IF hmg_anchor_utc_midnight(DATE '2026-09-01') <> TIMESTAMPTZ '2026-09-01 00:00:00+00'
     OR hmg_anchor_utc_midnight(DATE '2026-09-02') <> TIMESTAMPTZ '2026-09-02 00:00:00+00' THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_utc_midnight 가 UTC 자정이 아니다';
  END IF;
  -- (b) 보존 가드 진리표 — registry 는 registry -> registry 만 갱신, 그 외는 전부 갱신.
  --     `fleet_align` 은 정규 요일 귀속으로 대체되어 어휘에서 사라졌다.
  IF NOT hmg_anchor_keep_existing('registry', 'ledger')
     OR NOT hmg_anchor_keep_existing('registry', 'run')
     OR hmg_anchor_keep_existing('registry', 'registry')
     OR hmg_anchor_keep_existing('ledger', 'run')
     OR hmg_anchor_keep_existing('run', 'registry') THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_keep_existing 진리표가 어긋난다';
  END IF;
  IF NOT hmg_anchor_is_pinned('registry')
     OR hmg_anchor_is_pinned('fleet_align')
     OR hmg_anchor_is_pinned('ledger') OR hmg_anchor_is_pinned('run')
     OR hmg_anchor_is_pinned('fallback_measured') THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_is_pinned 가 고정 출처를 잘못 가른다';
  END IF;
  -- (c) 노출일 산식 — 1)원장 2)project +1일 3)그 외 NULL. 결정 11 채움 분기는 없다.
  IF hmg_anchor_view_date('standard', DATE '2026-01-05', DATE '2026-01-09') <> DATE '2026-01-09'
     OR hmg_anchor_view_date('project', DATE '2026-01-05', NULL) <> DATE '2026-01-06'
     OR hmg_anchor_view_date('project', DATE '2026-01-05', DATE '2026-01-09') <> DATE '2026-01-09'
     OR hmg_anchor_view_date('standard', DATE '2026-01-05', NULL) IS NOT NULL
     OR hmg_anchor_view_date('website', DATE '2026-01-05', NULL) IS NOT NULL THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_view_date 의 분기가 어긋난다';
  END IF;
  -- 시간에 의존하지 않는다 — 같은 입력은 오늘도 내일도 같은 값이다(N-12 구조적 차단).
  IF hmg_anchor_view_date('standard', hmg_anchor_today() + 30, NULL) IS NOT NULL
     OR hmg_anchor_view_date('standard', hmg_anchor_today() - 30, NULL) IS NOT NULL THEN
    RAISE EXCEPTION '0077 자가검증 실패: 원장 노출일 없는 비-project 표면이 열린다';
  END IF;
  -- (d) 회차 상속 시나리오의 날짜 산술 (전부 손계산 리터럴. KST = UTC+9 고정).
  --     (a) Kia Mexico: 회차 앵커 2026-07-09 22:55Z → KST 07-10 07:55 → 2026-07-10.
  --         레지스트리 UTC 날짜는 07-10 인데 그 회차의 UTC 일자는 07-09 라 (1) 로는
  --         못 찾고 (2) KST 폴백이 같은 회차를 집어 같은 값이 된다.
  IF hmg_anchor_date(TIMESTAMPTZ '2026-07-09 22:55:00+00') <> DATE '2026-07-10'
     OR (TIMESTAMPTZ '2026-07-09 22:55:00+00' AT TIME ZONE INTERVAL '0')::date <> DATE '2026-07-09' THEN
    RAISE EXCEPTION '0077 자가검증 실패: (a) 07-09 22:55Z 의 KST/UTC 일자가 어긋난다';
  END IF;
  --     (b) 레지스트리 없는 회차: 2026-07-16 22:35Z → KST 07-17 07:35 → 2026-07-17.
  IF hmg_anchor_date(TIMESTAMPTZ '2026-07-16 22:35:00+00') <> DATE '2026-07-17' THEN
    RAISE EXCEPTION '0077 자가검증 실패: (b) 07-16 22:35Z 가 KST 07-17 이 아니다';
  END IF;
  --     (c) 7/27~8/5 캠페인: 8/1 앵커 회차의 레지스트리가 7/27 을 가리킨다.
  --         7/27 회차 앵커 2026-07-27 01:10Z → UTC 일자 07-27(= 레지스트리 날짜, (1) 성립)
  --         → KST 일자도 07-27 → 8/1 회차 답변 전체가 2026-07-27 로 합쳐진다.
  IF hmg_anchor_date(TIMESTAMPTZ '2026-07-27 01:10:00+00') <> DATE '2026-07-27'
     OR (TIMESTAMPTZ '2026-07-27 01:10:00+00' AT TIME ZONE INTERVAL '0')::date <> DATE '2026-07-27' THEN
    RAISE EXCEPTION '0077 자가검증 실패: (c) 캠페인 7/27 회차의 날짜 대조축이 어긋난다';
  END IF;
  --     8/1 회차 자신의 앵커(2026-08-01 01:10Z → KST 08-01)와 다른 날짜로 간다는 것이 요점이다.
  IF hmg_anchor_date(TIMESTAMPTZ '2026-08-01 01:10:00+00') = DATE '2026-07-27' THEN
    RAISE EXCEPTION '0077 자가검증 실패: (c) 캠페인 이관이 무의미하다(두 회차 날짜가 같다)';
  END IF;
  -- (e) 기본 측정 엔진 목록. 정본은 lib/scope/engines.ts DEFAULT_AI_ENGINES 이고
  --     단위 테스트가 두 목록을 대조한다. 여기서는 어휘가 뒤집히지 않았는지만 본다.
  IF NOT ('chatgpt' = ANY(hmg_anchor_default_engines()))
     OR NOT ('gemini' = ANY(hmg_anchor_default_engines()))
     OR 'deepseek' = ANY(hmg_anchor_default_engines())
     OR array_length(hmg_anchor_default_engines(), 1) <> 2 THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_default_engines 가 ChatGPT·Gemini 둘이 아니다';
  END IF;
  -- (2) 주 = 월요일. (타임존과 무관한 date 산술이라 가드 밖이다.)
  IF hmg_anchor_week(DATE '2026-09-01') <> DATE '2026-08-31'
     OR hmg_anchor_week(DATE '2026-08-31') <> DATE '2026-08-31'
     OR hmg_anchor_week(DATE '2026-09-06') <> DATE '2026-08-31' THEN
    RAISE EXCEPTION '0077 자가검증 실패: hmg_anchor_week 가 ISO 월요일이 아니다';
  END IF;
  -- ③ 월 귀속 = **달력 월**(스펙 §9). 2026-08-31(월)은 주로는 9월 1주차지만 **8월**이다 —
  --    철회된 목요일 규칙이 남아 있으면 여기서 2026-09-01 이 나와 적용이 멈춘다.
  IF hmg_anchor_month(DATE '2026-08-31') <> DATE '2026-08-01' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 2026-08-31 의 귀속 월이 % (기대 2026-08-01 = 달력 월)',
      hmg_anchor_month(DATE '2026-08-31');
  END IF;
  -- 반대쪽 경계: 2026-09-01(화)은 9월, 2026-08-03(월)은 8월.
  IF hmg_anchor_month(DATE '2026-09-01') <> DATE '2026-09-01'
     OR hmg_anchor_month(DATE '2026-08-03') <> DATE '2026-08-01' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 달력 월 귀속이 어긋난다';
  END IF;

  -- ── (f) 회차 정규 요일 귀속의 날짜 산술 (전부 손계산 리터럴) ────────────────
  -- ⓐ 표면별 정규 요일 상수.
  IF hmg_round_canonical_dow('standard') <> 1
     OR hmg_round_canonical_dow('website') <> 5
     OR hmg_round_canonical_dow('project') IS NOT NULL THEN
    RAISE EXCEPTION '0077 자가검증 실패: 정규 요일이 글로벌=월(1)·웹사이트=금(5)·프로젝트=없음 이 아니다';
  END IF;
  -- ⓑ 앞 자리·뒤 자리. 2026-09-17 은 목, 09-11 과 09-18 이 그 앞뒤 금요일이다.
  IF hmg_round_prev_canonical(DATE '2026-09-17', 5) <> DATE '2026-09-11'
     OR hmg_round_next_canonical(DATE '2026-09-17', 5) <> DATE '2026-09-18' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 2026-09-17(목)의 앞·뒤 금요일 자리가 어긋난다';
  END IF;
  -- ⓒ **자기 자리는 앞 자리가 아니다** — 정규 요일 당일이면 7일 밖으로 나간다.
  IF hmg_round_prev_canonical(DATE '2026-09-18', 5) <> DATE '2026-09-11'
     OR hmg_round_next_canonical(DATE '2026-09-18', 5) <> DATE '2026-09-25'
     OR hmg_round_prev_canonical(DATE '2026-09-14', 1) <> DATE '2026-09-07'
     OR hmg_round_next_canonical(DATE '2026-09-14', 1) <> DATE '2026-09-21' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 정규 요일 당일의 앞·뒤 자리가 자기 날짜를 가리킨다';
  END IF;
  -- ⓓ 글로벌(월요일) 축. 2026-09-08 은 화요일 → 앞 09-07 · 뒤 09-14.
  IF hmg_round_prev_canonical(DATE '2026-09-08', 1) <> DATE '2026-09-07'
     OR hmg_round_next_canonical(DATE '2026-09-08', 1) <> DATE '2026-09-14'
     OR hmg_round_prev_canonical(DATE '2026-08-25', 1) <> DATE '2026-08-24' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 글로벌 월요일 축의 앞·뒤 자리가 어긋난다';
  END IF;
  -- ⓔ 토·일 경계(테스트 시나리오 (c)). 07-11 토 · 07-12 일 → 앞 07-10 금 · 뒤 07-17 금.
  IF hmg_round_prev_canonical(DATE '2026-07-11', 5) <> DATE '2026-07-10'
     OR hmg_round_next_canonical(DATE '2026-07-11', 5) <> DATE '2026-07-17'
     OR hmg_round_prev_canonical(DATE '2026-07-12', 5) <> DATE '2026-07-10'
     OR hmg_round_next_canonical(DATE '2026-07-12', 5) <> DATE '2026-07-17' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 주말 앵커의 앞·뒤 금요일 자리가 어긋난다';
  END IF;
  -- ⓕ **앞·뒤 거리의 합은 항상 7** 이다. 7 은 홀수라 두 거리가 같아질 수 없다 —
  --    "가까운 쪽" 판정에 동률이 원리적으로 없다는 근거이므로 산술로 못박는다.
  IF (DATE '2026-09-17' - hmg_round_prev_canonical(DATE '2026-09-17', 5))
     + (hmg_round_next_canonical(DATE '2026-09-17', 5) - DATE '2026-09-17') <> 7
     OR (DATE '2026-08-03' - hmg_round_prev_canonical(DATE '2026-08-03', 5))
        + (hmg_round_next_canonical(DATE '2026-08-03', 5) - DATE '2026-08-03') <> 7 THEN
    RAISE EXCEPTION '0077 자가검증 실패: 앞·뒤 자리 거리의 합이 7 이 아니다';
  END IF;
  -- ⓖ 귀속으로 **달이 바뀌는** 경계(테스트 시나리오 (f)). 웹사이트 2026-08-03(월)의
  --    앞 자리는 07-31(금) → 월 귀속이 **7월**이다. 뒤 자리 08-07 이면 8월이다.
  IF hmg_round_prev_canonical(DATE '2026-08-03', 5) <> DATE '2026-07-31'
     OR hmg_anchor_month(hmg_round_prev_canonical(DATE '2026-08-03', 5)) <> DATE '2026-07-01'
     OR hmg_round_next_canonical(DATE '2026-08-03', 5) <> DATE '2026-08-07'
     OR hmg_anchor_month(hmg_round_next_canonical(DATE '2026-08-03', 5)) <> DATE '2026-08-01' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 달을 넘는 귀속의 월 계산이 어긋난다';
  END IF;
  --    반대로 2026-10-01(목)의 뒤 자리 10-02(금)은 **같은 달**이다.
  IF hmg_round_next_canonical(DATE '2026-10-01', 5) <> DATE '2026-10-02'
     OR hmg_anchor_month(DATE '2026-10-02') <> DATE '2026-10-01' THEN
    RAISE EXCEPTION '0077 자가검증 실패: 2026-10-01 의 뒤 자리·월 귀속이 어긋난다';
  END IF;
END
$selftest$;--> statement-breakpoint

-- ── 테이블 ───────────────────────────────────────────────────────────────────
-- 카탈로그 선확인: 이미 있으면 `CREATE TABLE IF NOT EXISTS` 조차 부르지 않는다.
DO $ddl$
BEGIN
  IF to_regclass('public.scope_answer_cycle_anchors') IS NULL THEN
    CREATE TABLE scope_answer_cycle_anchors (
      -- scope_answers.job_id. **FK 를 두지 않는다** — `replaceRun` 의 run 단위
      -- delete+insert 가 cascade 로 앵커를 지우면 안 된다(0053·0054 와 같은 논리).
      -- 실측 전제: seed 이후 재동기화된 125,475행이 job_id 로 그대로 조인된다(스펙 §1.5).
      job_id             uuid PRIMARY KEY,
      run_id             uuid NOT NULL,
      -- ⚠️ 스펙 §3 은 NOT NULL 이지만 `scope_runs.project_id` 가 **nullable** 이다
      -- (컬럼 신설 이전에 미러된 레거시 run). NOT NULL 로 두면 그 답변들이 테이블에서
      -- 통째로 빠져 확정 결정 3(전수 = 완료 답변마다 1행)이 깨진다. 전수를 이기는
      -- 제약은 두지 않는다 — 실측 0 이 확인되면 후속 마이그레이션에서 승격한다.
      -- dry-run SQL 의 지표 ⑦ 이 이 값을 센다.
      project_id         uuid,
      -- 'standard' | 'website' | 'project'. 판정 규칙은 run 의 소속 프로젝트다
      -- (website → 원장이 'global' 로 부르는 프로젝트 = standard → 그 외 project).
      -- qa-review.ts::RUN_SURFACE_CTE 와는 **다르다** — 그쪽은 projects 를 먼저 봐서
      -- 글로벌 루트를 'project' 로 부른다. ⚠️ `summary_cycles.surface`
      -- 는 standard 를 'global' 로 부른다 — 이 테이블은 스펙 §3 의 표기를 따른다.
      surface            text NOT NULL,
      anchor_at          timestamptz NOT NULL,
      -- **실제** 앵커 시각의 KST 일자. 기록용이다 — 기간 술어·달력·주·월은 아래
      -- `round_date`(정규 요일 귀속)를 본다. 둘이 다른 것이 정상이다.
      anchor_date        date NOT NULL,
      -- 주·월 버킷은 **귀속 날짜 기준**이다("보이는 것과 귀속이 같아야 한다").
      anchor_week        date NOT NULL,
      anchor_month       date NOT NULL,
      -- 대표 답변 정렬 키(스펙 §2-16 · §3). 회차 안 같은 (질문, 엔진, 지역)이 여러
      -- 건이면 이 값이 **최신인 1건**이 대표다. 접힌 `measured_at` 으로 정렬하면
      -- 시:분만 비교하게 된다(Genesis NL 7/27 회차에서 선택 방식에 따라 인용 점유율이
      -- 10.33%~19.92% 로 갈렸다). 리더 전환은 이번 범위 밖이고 컬럼만 둔다.
      -- 값 = COALESCE(0053.source_measured_at, scope_answers.measured_at, anchor_at).
      -- 마지막 폴백은 `measured_at` 이 nullable 이라 필요하다(그때는 회차 앵커 시각).
      measured_at_orig   timestamptz NOT NULL,
      -- 엔진이 기본 타겟(ChatGPT·Gemini)인가. 정본은 `hmg_anchor_default_engines()`.
      is_default_engine  boolean NOT NULL,
      -- **귀속 날짜** = 이 답변의 회차가 앉은 정규 요일 자리(스펙 §9 "귀속").
      -- 기간 필터·달력·주 버킷·MoM 이 보는 **유일한 날짜 키**다. 값의 정본은
      -- 매핑 표 `scope_cycle_rounds` 이고 이 컬럼은 그 복사본이다 — 기간 술어가
      -- 답변 테이블의 `(round_date, job_id)` 인덱스를 타게 하기 위해서다.
      -- 복사본이 어긋나면 감사 SQL 의 `round_date_drift` 가 긴급으로 잡는다.
      round_date         date NOT NULL,
      view_anchor_date   date,
      -- 원장이 찍은 노출일(`summary_cycles.view_anchor_at` 의 KST 일자). 컬럼으로 두는
      -- 이유는 upsert 의 보존 경로가 노출일을 **보존된 anchor_date** 로 다시 계산할 때
      -- "원장 값이 있었는가" 를 알아야 하기 때문이다(N-1). 감사에도 쓴다.
      ledger_view_anchor_date date,
      cycle_id           uuid,
      source             text NOT NULL,
      source_measured_at timestamptz,
      reason             text,
      assigned_at        timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scope_answer_cycle_anchors_surface_ck
        CHECK (surface IN ('standard', 'website', 'project')),
      CONSTRAINT scope_answer_cycle_anchors_source_ck
        CHECK (source IN ('registry', 'ledger', 'run', 'fallback_measured'))
    );
  END IF;
END
$ddl$;--> statement-breakpoint

-- ── 회차 → 귀속 날짜 **매핑 표** (배정의 정본) ───────────────────────────────
--
-- 회차 = (프로젝트, 최종 `anchor_date`). 0053 레지스트리로 합쳐진 회차는 이미 같은
-- `anchor_date` 를 쓰므로 여기서도 **한 행**이다. 규모는 회차 수(실측 약 1,000)다.
--
-- 왜 답변 테이블이 아니라 별도 표인가: 배정은 회차 단위 정보이고 **차례 배정**이라
-- 절차적이다. 작은 표에 두면 자리 점유 조회가 인덱스 한 번이고, 답변 테이블은 그
-- 값을 복사만 한다(기간 술어가 `(round_date, job_id)` 인덱스를 탄다).
--
-- ⚠️ **과거 배정은 재계산하지 않는다.** `hmg_assign_cycle_rounds` 는 미배정 회차만
-- 새로 앉힌다. 다시 앉히는 유일한 경로는 운영자 스크립트
-- (`scripts/db/reassign-cycle-rounds.ts`, 기본 dry-run)다.
--
-- ⚠️ FK 를 두지 않는다 — 답변 행은 `replaceRun` 의 run 단위 delete+insert 로 사라졌다
-- 돌아오는데, 그때 배정까지 지워지면 같은 회차가 다른 자리에 앉을 수 있다.
-- 답변이 사라진 배정(고아 자리)은 감사 SQL 이 표면화하고 자동으로 지우지 않는다.
DO $ddl_rounds$
BEGIN
  IF to_regclass('public.scope_cycle_rounds') IS NULL THEN
    CREATE TABLE scope_cycle_rounds (
      project_id  uuid NOT NULL,
      -- 회차의 실제 앵커 날짜(KST). 답변 테이블의 `anchor_date` 와 같은 축이다.
      anchor_date date NOT NULL,
      surface     text NOT NULL,
      -- 귀속 날짜. 정규 요일이 있는 표면이면 그 요일의 날짜다.
      round_date  date NOT NULL,
      -- 어떤 규칙으로 이 자리에 앉았는가.
      --   canonical  앵커 날짜가 이미 정규 요일
      --   prev_empty 앞 자리만 비어 있었다
      --   next_empty 뒤 자리만 비어 있었다
      --   nearest    둘 다 비어 가까운 쪽으로
      --   merged     둘 다 차 있어 가까운 쪽 회차에 합쳤다
      --   project    정규 요일이 없는 표면(= anchor_date 그대로)
      basis       text NOT NULL,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scope_cycle_rounds_pk PRIMARY KEY (project_id, anchor_date),
      CONSTRAINT scope_cycle_rounds_surface_ck
        CHECK (surface IN ('standard', 'website', 'project')),
      CONSTRAINT scope_cycle_rounds_basis_ck
        CHECK (basis IN ('canonical', 'prev_empty', 'next_empty', 'nearest', 'merged', 'project'))
    );
  END IF;
END
$ddl_rounds$;--> statement-breakpoint

DO $idx_rounds$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.scope_cycle_rounds') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT * FROM (VALUES
      -- 자리 점유 조회(`이 프로젝트에 이 날짜로 귀속된 회차가 있는가`) — 배정의 핫 경로.
      ('scope_cycle_rounds_seat_idx',  '(project_id, round_date)'),
      -- 감사·통계(표면별 귀속 날짜 분포).
      ('scope_cycle_rounds_round_idx', '(surface, round_date)')
    ) AS t(name, cols)
  LOOP
    IF to_regclass('public.' || r.name) IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON scope_cycle_rounds %s', r.name, r.cols);
    END IF;
  END LOOP;
END
$idx_rounds$;--> statement-breakpoint

REVOKE ALL ON "scope_cycle_rounds" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- 회차 → 귀속 날짜 조회. **매핑이 아직 없으면 `anchor_date` 그대로**다.
--
-- 이 폴백이 있어야 `refresh_answer_cycle_anchors` 의 upsert 가 NOT NULL 컬럼을 채울 수
-- 있다(새 회차는 upsert 뒤에 배정된다). 배정 직후 전파가 값을 맞추고, 같은 트랜잭션
-- 끝에서 `round_date` 가 매핑과 일치하는지 단언하므로 잠정값이 밖으로 새지 않는다.
CREATE OR REPLACE FUNCTION hmg_round_date_of(p_project_id uuid, p_anchor_date date)
RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(
    (SELECT m.round_date FROM scope_cycle_rounds m
      WHERE m.project_id = p_project_id AND m.anchor_date = p_anchor_date),
    p_anchor_date)
$fn$;--> statement-breakpoint

-- 인덱스도 같은 자세 — `pg_class` 에 이름이 있으면 CREATE 를 부르지 않는다.
DO $idx$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.scope_answer_cycle_anchors') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT * FROM (VALUES
      -- 기간 술어의 주 경로(`round_date BETWEEN :from AND :to`) — **귀속 날짜** 축이다.
      ('scope_answer_cycle_anchors_round_idx', '(round_date, job_id)'),
      -- 달력 목록(표면별 선택 가능한 귀속 날짜).
      ('scope_answer_cycle_anchors_surface_round_idx', '(surface, round_date)'),
      -- 매핑 표 조인(`project_id, anchor_date`) · 전파 · 감사.
      ('scope_answer_cycle_anchors_project_date_idx', '(project_id, anchor_date)'),
      -- 미러 재싱크가 방금 넣은 run 의 행을 되찾는 경로(배정·전파도 이 축을 쓴다).
      ('scope_answer_cycle_anchors_run_idx', '(run_id)'),
      -- 주 버킷(추이).
      ('scope_answer_cycle_anchors_week_idx', '(anchor_week)'),
      -- 회차 → 답변 역방향 조회. 쓰는 곳: MoM·WoW 비교가 회차 ↔ 귀속 날짜 대응을
      -- `cycle_id` 로 묶어 읽는 경로(인덱스가 없어 전 이력 조회를 근사로 대체했다) ·
      -- 감사 SQL 의 원장 조인(`summary_cycles y ON y.cycle_id = c.cycle_id`,
      -- 원장이 약 1,000행이라 이쪽으로 파고드는 nested loop 가 자연스럽다) ·
      -- 재귀속 드리프트 점검.
      --
      -- **부분 인덱스로 둔다.** 쓰임이 전부 `cycle_id = <uuid>` 동등 조회이고 그 술어가
      -- `IS NOT NULL` 을 함의하므로 부분 인덱스가 그 조회에 전부 쓰인다. 반면 NULL 행
      -- (회차가 없는 project 표면 — dry-run 실측 23,037행 + 회차에 안 붙은 run)은 이
      -- 축의 조회 대상이 **절대** 아닌데, PostgreSQL btree 는 NULL 도 저장하므로 통
      -- 인덱스는 그만큼을 쓸모없이 싣는다.
      ('scope_answer_cycle_anchors_cycle_idx', '(cycle_id) WHERE cycle_id IS NOT NULL'),
      -- 대표 답변 선택(§2-16)의 후보 인덱스. 대표는 **귀속 날짜 단위**로 고른다
      -- (합쳐진 자리는 한 회차로 보므로 두 앵커 날짜의 답변이 같은 셀을 다툰다).
      -- 리더가 아직 없으므로 `DISTINCT ON` 정렬을 그대로 태우는 좁은 형태로만 둔다 —
      -- 실제 셀 키(prompt_id·target·region)는 `scope_answers` 쪽이다.
      -- 리더 전환(C 단계) 때 EXPLAIN 으로 모양을 확정할 것.
      ('scope_answer_cycle_anchors_rep_idx', '(project_id, round_date, measured_at_orig DESC)')
    ) AS t(name, cols)
  LOOP
    IF to_regclass('public.' || r.name) IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON scope_answer_cycle_anchors %s', r.name, r.cols);
    END IF;
  END LOOP;
END
$idx$;--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0033·0042·0043·0053 선례와 동일): 신규 테이블은
-- lockdown.sql 재실행 전까지 anon/authenticated 가드가 없다. 적용 후 확인:
--   SELECT has_table_privilege('anon','public.scope_answer_cycle_anchors','SELECT'); -- expect false
REVOKE ALL ON "scope_answer_cycle_anchors" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- == 회차 -> 귀속 날짜 **배정** (정규 요일 귀속의 정본 구현) ==================
--
-- 규칙(제품 확정 2026-09-19 밤). 전부 KST 축이고, 자리는 프로젝트별로 센다.
--
--   1) 표면의 정규 요일이 없으면(project) 귀속 날짜 = anchor_date. basis 'project'.
--   2) anchor_date 가 정규 요일이면 귀속 날짜 = 그 날짜. basis 'canonical'.
--   3) 아니면 그 프로젝트의 **앞 자리**(직전 정규 요일)와 **뒤 자리**(직후 정규 요일)를
--      본다. "자리가 찼다" = 그 프로젝트에 그 날짜로 귀속된 회차가 이미 있다.
--        - 한쪽만 비어 있으면 그 빈 자리            basis 'prev_empty' / 'next_empty'
--        - 둘 다 비어 있으면 가까운 쪽              basis 'nearest'
--        - 둘 다 차 있으면 가까운 쪽 회차에 **합친다** basis 'merged'
--      => **빈 자리가 "가까운 쪽"보다 우선한다.** 이 순서가 규칙의 핵심이다.
--   4) 같은 프로젝트의 비정규 회차는 anchor_date **이른 순으로 차례** 배정한다.
--      정규 요일 회차를 먼저 전부 앉힌 뒤(1 단계) 비정규를 돌린다(2 단계).
--
-- 동률이 없는 이유: 앞 거리 + 뒤 거리 = **7**(홀수)이라 두 거리가 같아질 수 없다.
-- 자가검증 블록이 이 항등식을 산술로 못박는다. 그래도 코드는 동률이면 **앞쪽**을
-- 고르도록 `<=` 로 결정론을 박아 둔다.
--
-- **과거 배정은 재계산하지 않는다**(과거 값 안정성). 이 함수는 매핑이 없는 회차만
-- 새로 앉힌다. 새 회차가 들어와도 이미 앉은 회차는 움직이지 않는다.
-- 다시 앉히는 경로는 운영자 스크립트 하나뿐이다(scripts/db/reassign-cycle-rounds.ts).
--
-- 범위 인자는 **둘 중 하나만** 준다:
--   - p_run_ids     증분 경로(미러 싱크). 후보를 그 run 들의 답변 행으로 좁힌다.
--                   `scope_answer_cycle_anchors_run_idx` 를 탄다.
--   - p_project_ids 전수 경로(백필/재배정). 프로젝트의 모든 회차를 본다.
-- 술어를 OR 로 합치지 않고 **동적 SQL 로 갈라 쓰는** 이유는 플랜 때문이다 —
-- `($1 IS NULL OR ...)` 형태는 인덱스를 못 타는 일반 플랜이 될 수 있다.
--
-- 동시성: 같은 프로젝트의 회차를 두 트랜잭션이 동시에 배정하면 **같은 빈 자리를**
-- 다툰다(자리 점유 판정이 서로를 못 본다). 그래서 후보에 걸린 프로젝트를 오름차순으로
-- 먼저 전부 `pg_advisory_xact_lock` 으로 잡는다 - 오름차순 고정이 교착을 막는다.
-- 락은 트랜잭션 끝에 자동으로 풀린다.
CREATE OR REPLACE FUNCTION hmg_assign_cycle_rounds(p_run_ids uuid[], p_project_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_where      text;
  v_proj       uuid;
  v_c          record;
  v_dow        int;
  v_prev       date;
  v_next       date;
  v_prev_taken boolean;
  v_next_taken boolean;
  v_round      date;
  v_basis      text;
  v_n          bigint := 0;
  v_k          bigint := 0;
BEGIN
  IF p_run_ids IS NOT NULL THEN
    v_where := 'c.run_id = ANY($1)';
  ELSIF p_project_ids IS NOT NULL THEN
    v_where := 'c.project_id = ANY($2)';
  ELSE
    RAISE EXCEPTION 'hmg_assign_cycle_rounds: p_run_ids 와 p_project_ids 가 둘 다 NULL 이다';
  END IF;

  -- (0) 프로젝트 잠금. 오름차순으로 전부 먼저 잡는다(교착 회피).
  FOR v_proj IN EXECUTE format($q$
        SELECT DISTINCT c.project_id
          FROM scope_answer_cycle_anchors c
         WHERE %s AND c.project_id IS NOT NULL
         ORDER BY 1
      $q$, v_where) USING p_run_ids, p_project_ids
  LOOP
    PERFORM pg_advisory_xact_lock(8077, hashtext(v_proj::text));
  END LOOP;

  -- (1) 정규 요일 회차(와 정규 요일이 없는 project 표면)를 자기 날짜에 앉힌다.
  --     자리 충돌이 없다: 자리 = 자기 anchor_date 이고 회차 키가 (프로젝트, anchor_date)다.
  --     이미 합쳐진 자리와 겹칠 수는 있다 - 그때도 규칙대로 자기 날짜를 쓴다.
  EXECUTE format($q$
    INSERT INTO scope_cycle_rounds (project_id, surface, anchor_date, round_date, basis)
    SELECT x.project_id, x.surface, x.anchor_date, x.anchor_date,
           CASE WHEN hmg_round_canonical_dow(x.surface) IS NULL
                THEN 'project' ELSE 'canonical' END
      FROM (SELECT DISTINCT c.project_id, c.surface, c.anchor_date
              FROM scope_answer_cycle_anchors c
             WHERE %s AND c.project_id IS NOT NULL) x
     WHERE hmg_round_canonical_dow(x.surface) IS NULL
        OR EXTRACT(ISODOW FROM x.anchor_date)::int = hmg_round_canonical_dow(x.surface)
    ON CONFLICT (project_id, anchor_date) DO NOTHING
  $q$, v_where) USING p_run_ids, p_project_ids;
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  -- (2) 비정규 회차를 (프로젝트, anchor_date 이른 순)으로 차례 배정한다.
  --     커서는 여는 시점의 스냅샷이라 루프 안 INSERT 를 다시 읽지 않지만, 후보는
  --     DISTINCT 라 같은 회차가 두 번 나오지 않는다. **자리 점유 판정은 별도 문장**
  --     이므로 직전 반복이 앉힌 자리를 제대로 본다 - 차례 배정이 성립하는 지점이다.
  FOR v_c IN EXECUTE format($q$
        SELECT DISTINCT c.project_id, c.surface, c.anchor_date
          FROM scope_answer_cycle_anchors c
         WHERE %s AND c.project_id IS NOT NULL
           AND hmg_round_canonical_dow(c.surface) IS NOT NULL
           AND EXTRACT(ISODOW FROM c.anchor_date)::int <> hmg_round_canonical_dow(c.surface)
           AND NOT EXISTS (SELECT 1 FROM scope_cycle_rounds m
                            WHERE m.project_id = c.project_id
                              AND m.anchor_date = c.anchor_date)
         ORDER BY 1, 3
      $q$, v_where) USING p_run_ids, p_project_ids
  LOOP
    v_dow  := hmg_round_canonical_dow(v_c.surface);
    v_prev := hmg_round_prev_canonical(v_c.anchor_date, v_dow);
    v_next := hmg_round_next_canonical(v_c.anchor_date, v_dow);
    SELECT EXISTS (SELECT 1 FROM scope_cycle_rounds m
                    WHERE m.project_id = v_c.project_id AND m.round_date = v_prev)
      INTO v_prev_taken;
    SELECT EXISTS (SELECT 1 FROM scope_cycle_rounds m
                    WHERE m.project_id = v_c.project_id AND m.round_date = v_next)
      INTO v_next_taken;
    IF NOT v_prev_taken AND v_next_taken THEN
      v_round := v_prev; v_basis := 'prev_empty';
    ELSIF v_prev_taken AND NOT v_next_taken THEN
      v_round := v_next; v_basis := 'next_empty';
    ELSE
      -- 둘 다 비었거나(nearest) 둘 다 찼다(merged). 어느 쪽이든 **가까운 쪽**이다.
      IF (v_c.anchor_date - v_prev) <= (v_next - v_c.anchor_date) THEN
        v_round := v_prev;
      ELSE
        v_round := v_next;
      END IF;
      v_basis := CASE WHEN v_prev_taken THEN 'merged' ELSE 'nearest' END;
    END IF;
    INSERT INTO scope_cycle_rounds (project_id, surface, anchor_date, round_date, basis)
    VALUES (v_c.project_id, v_c.surface, v_c.anchor_date, v_round, v_basis)
    ON CONFLICT (project_id, anchor_date) DO NOTHING;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  END LOOP;

  RETURN v_n;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_assign_cycle_rounds(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- == 매핑 -> 답변 행 **전파** ================================================
--
-- `round_date` 와 그 파생 키(`anchor_week`/`anchor_month`)를 매핑 표에서 복사한다.
-- 값이 실제로 다른 행만 쓴다(멱등, 정상 상태에서 0행).
--
-- 범위 인자는 배정 함수와 같은 규칙이다 - run 축(증분) 또는 project 축(전수).
CREATE OR REPLACE FUNCTION hmg_propagate_cycle_rounds(p_run_ids uuid[], p_project_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_n bigint := 0;
BEGIN
  IF p_run_ids IS NOT NULL THEN
    UPDATE scope_answer_cycle_anchors t
       SET round_date   = m.round_date,
           anchor_week  = hmg_anchor_week(m.round_date),
           anchor_month = hmg_anchor_month(m.round_date),
           updated_at   = now()
      FROM scope_cycle_rounds m
     WHERE t.run_id = ANY(p_run_ids)
       AND m.project_id = t.project_id
       AND m.anchor_date = t.anchor_date
       AND (t.round_date, t.anchor_week, t.anchor_month)
             IS DISTINCT FROM
           (m.round_date, hmg_anchor_week(m.round_date), hmg_anchor_month(m.round_date));
  ELSIF p_project_ids IS NOT NULL THEN
    UPDATE scope_answer_cycle_anchors t
       SET round_date   = m.round_date,
           anchor_week  = hmg_anchor_week(m.round_date),
           anchor_month = hmg_anchor_month(m.round_date),
           updated_at   = now()
      FROM scope_cycle_rounds m
     WHERE t.project_id = ANY(p_project_ids)
       AND m.project_id = t.project_id
       AND m.anchor_date = t.anchor_date
       AND (t.round_date, t.anchor_week, t.anchor_month)
             IS DISTINCT FROM
           (m.round_date, hmg_anchor_week(m.round_date), hmg_anchor_month(m.round_date));
  ELSE
    RAISE EXCEPTION 'hmg_propagate_cycle_rounds: p_run_ids 와 p_project_ids 가 둘 다 NULL 이다';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hmg_propagate_cycle_rounds(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 앵커 재계산 (쓰기의 **유일한** 경로, 스펙 §4) ────────────────────────────
--
-- 이 테이블은 **수기로 고치지 않는다.** 앵커 이동 시 갱신 지점이 코어·미러·원장에
-- 이 테이블까지 넷이 되므로, 손으로 한 곳만 고치면 유령 회차가 생긴다
-- (사내 운영 규칙(adhoc-measurement) 11번 · 2026-09-11 Kia/MT 실증).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 앵커는 **회차 단위로 정하고 답변이 상속한다** (스펙 §3.1, 제품 확정 2026-09-19)
-- ══════════════════════════════════════════════════════════════════════════════
-- 회차 = 같은 프로젝트에서 같은 `scope_runs.cycle_anchor_at` 을 가진 run 들의 묶음.
-- 회차의 앵커를 **한 번** 정하고 그 회차의 모든 완료 답변이 그 값을 받는다.
--
-- 왜 답변 단위가 아닌가: 0053 레지스트리는 **날짜를 옮겨야 했던 답변만** 등록한다
-- (앵커 당일 측정분은 미등록이 정상. 부분 등록 회차 288개). 답변마다 "레지스트리 있으면
-- 그것, 없으면 run 앵커"를 적용하면 **한 회차가 쪼개진다** — 실측: Kia Mexico 는 run 17개가
-- 앵커 07-09 22:55Z 를 공유하는데 7/11~12 측정 187건만 7/10 으로 등록돼 있어 7/9(11문항)와
-- 7/10(99문항)으로 갈렸다. 같은 형태가 7개 회차·답변 791건 더 있다.
--
-- 회차 앵커 우선순위:
--   1) registry          — 회차 답변 중 **하나라도** `scope_answer_anchors` 에 있으면
--                          회차 전체가 그 `anchor`. 레지스트리는 UTC 날짜만 갖고 있어
--                          KST 이관 규칙(§9 말미)을 **회차 단위로** 탄다.
--                          ⚠️ 실측으로 회차 안 레지스트리 앵커 불일치는 0(회차 996 중
--                          레지스트리가 붙은 411)이지만, 코드는 불일치를 가정하고
--                          **가장 이른 날짜**를 결정적으로 고른다. 그런 회차는 감사
--                          SQL 의 `cycle_registry_split` 이 표면화한다.
--   2) ledger            — 회차 run 들에 귀속된 `summary_cycles.cycle_anchor_at`(가장 이른 것)
--   3) run               — 회차 키 자신(`scope_runs.cycle_anchor_at`)
--   4) fallback_measured — 위 셋이 다 없으면 그 회차 답변의 **가장 이른** `measured_at`
--                          (앵커가 어디에도 없는 run 10개·답변 415건. R4 두 프로젝트)
--
-- `cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못하므로 **run 단독**으로 취급한다
-- (회차 키에 run_id 를 섞어 다른 NULL run 과 뭉치지 않게 한다).
--
-- ── 범위 확장: 받은 run 이 아니라 그 run 이 속한 **회차 전체**를 재계산한다 ──────
-- 회차는 run 여러 개에 걸친다. `run_ids` 만 계산하면 나중에 한 run 에만 레지스트리가
-- 붙었을 때 회차의 나머지 답변이 따라오지 않는다. 그래서 먼저 `v_runs` 로 넓힌다.
--
-- ⚠️ **0053 에 행을 추가·삭제하는 수작업 접기 절차 뒤에 반드시 부른다**
-- (`docs/measured-at-anchor-registry.md`). 그 job 의 run 하나만 넘기면 되고, 이 함수가
-- 같은 회차의 나머지 run 을 알아서 끌어온다:
--     SELECT refresh_answer_cycle_anchors(
--              ARRAY(SELECT DISTINCT a.run_id FROM scope_answers a
--                     WHERE a.job_id = ANY(<손댄 job_id 들>))::uuid[],
--              '<SCOPE_ROOT_PROJECT_ID>'::uuid);
-- 부르지 않으면 회차의 나머지 답변이 옛 앵커를 든 채 남고, 야간 감사의
-- `cycle_anchor_split` 이 그 회차를 표면화한다.
--
-- 원장(0059)이 없는 DB 에서도 돌아야 하므로 조인을 동적으로 만든다 — plpgsql 은
-- 본문의 테이블을 실행 시점에 해석하므로, 정적으로 쓰면 그 환경에서 싱크가 죽는다.
--
-- ── 인자 `p_root_project_id` (B4 수리) ────────────────────────────────────────
-- 표면 판정의 'standard' 근거를 **앱이 쓰는 정본과 같은 값**으로 받는다. 종전에는
-- "원장에 그 프로젝트의 global 회차가 이미 있는가" 라는 **원장의 출력**에 기대고 있어서,
-- 원장이 아직 그 프로젝트의 global 회차를 열지 않은 창에서는 글로벌 답변이 'project'
-- 로 떨어지고 → 그 표면은 결정 ⑫ 로 anchor+1 일에 열리므로 **게이트를 우회**했다.
--
-- SQL 함수는 앱의 env 를 읽을 수 없으므로 호출부가 넘긴다:
--   · 미러 싱크  `scope-mirror.ts::prepareMirrorWrite` 가 `anchorRootProjectId()`
--   · 백필       `scripts/db/backfill-answer-cycle-anchors.ts`
--   · 원장 전파  `summary-cycles.ts`·`swap.ts` 의 전파 호출
-- **기본값을 두지 않는다** — 인자를 빠뜨린 호출은 컴파일/실행 시점에 바로 드러나야 한다.
--
-- NULL 이 오면 종전처럼 원장 기준으로 폴백하되 `RAISE NOTICE` 로 그 사실을 드러낸다
-- (mock 모드·env 미설정 환경이 여기 해당한다).
CREATE OR REPLACE FUNCTION refresh_answer_cycle_anchors(run_ids uuid[], p_root_project_id uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ledger    text;
  v_global    text;
  v_cycutc    text;
  v_deleted   bigint := 0;
  v_rows      bigint := 0;
  v_runs      uuid[];
  v_assigned  bigint := 0;
  v_moved     bigint := 0;
  v_bad       bigint := 0;
BEGIN
  IF run_ids IS NULL OR cardinality(run_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- ── 회차 전체로 범위를 넓힌다 ──────────────────────────────────────────────
  -- 상관 서브쿼리를 쓰지 않는다(프로덕션 미러에서 같은 날 statement_timeout 3회).
  -- 회차 키(프로젝트, cycle_anchor_at)를 먼저 한 번 뽑고 평 조인으로 확장한다.
  WITH seed AS (
    SELECT DISTINCT r.project_id, r.cycle_anchor_at
      FROM scope_runs r
     WHERE r.run_id = ANY(run_ids)
       AND r.project_id IS NOT NULL
       AND r.cycle_anchor_at IS NOT NULL
  ), expanded AS (
    SELECT r.run_id FROM scope_runs r
     WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL
    UNION
    SELECT r.run_id FROM scope_runs r
      JOIN seed s ON s.project_id = r.project_id
                 AND r.cycle_anchor_at = s.cycle_anchor_at
     WHERE r.project_id IS NOT NULL
  )
  SELECT coalesce(array_agg(run_id), ARRAY[]::uuid[]) INTO v_runs FROM expanded;

  -- ⚠️ `v_runs` 가 비어도 **조기 반환하지 않는다.** 아래 동적 SQL 은 plpgsql 의 지연
  -- 검증 대상이라(본문 문자열은 CREATE 시점에 파싱되지 않는다) **첫 호출에서만** 타입·
  -- 함수 부재가 드러난다. 실제로 `min(uuid)` 부재가 그렇게 터졌다. 행이 0이어도 PG 는
  -- 문장을 파싱·계획하므로, 이 경로를 항상 태워야 적용 시점 스모크(아래 $smoketest$)가
  -- 의미를 갖는다. 빈 배열이면 모든 CTE 가 0행이라 쓰기도 0이다.
  IF cardinality(v_runs) > cardinality(run_ids) THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 상속으로 run %개 → %개로 넓혔다(같은 프로젝트·같은 cycle_anchor_at).',
      cardinality(run_ids), cardinality(v_runs);
  END IF;

  IF to_regclass('public.summary_cycle_runs') IS NOT NULL
     AND to_regclass('public.summary_cycles') IS NOT NULL THEN
    v_ledger := $q$
      LEFT JOIN summary_cycle_runs scr ON scr.run_id = rr.run_id
      LEFT JOIN summary_cycles     cyc ON cyc.cycle_id = scr.cycle_id
    $q$;
    -- 0053 이관(R1 말미)의 대조 축. 레지스트리는 **UTC 날짜만** 갖고 있어 KST 날짜로
    -- 옮기려면 앵커 **시각**이 필요하다. 회차를 날짜로 접어 두고 **평 조인**한다
    -- (종전에는 답변 행마다 도는 상관 스칼라 서브쿼리였다 — 회차 단위가 되면서
    --  평가 횟수가 답변 수에서 회차 수로 줄었다).
    v_cycutc := $q$
      SELECT project_id,
             (cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date,
             hmg_anchor_date(cycle_anchor_at)                  AS kst_date,
             cycle_anchor_at
        FROM summary_cycles
    $q$;
    -- "이 프로젝트는 글로벌(표준) 루트인가".
    --   ① 인자가 있으면 **그 값이 정본**이다(앱의 `anchorRootProjectId()` 와 같은 값).
    --   ② NULL 이면 폴백: 원장이 그 프로젝트의 회차를 'global' 로 부르는가
    --      (`summary-cycles.ts::surfaceExpr` 이 같은 env 로 판정해 기록해 둔 출력).
    v_global := $q$CASE WHEN $2 IS NOT NULL THEN rr.project_id = $2
                        ELSE EXISTS (SELECT 1 FROM summary_cycles g
                                      WHERE g.project_id = rr.project_id AND g.surface = 'global')
                   END$q$;
  ELSE
    -- 원장 없는 환경: 같은 형태의 빈 관계로 대체한다(우선순위 2가 항상 비어 있을 뿐).
    v_ledger := $q$
      LEFT JOIN (SELECT NULL::uuid AS run_id, NULL::uuid AS cycle_id) scr ON false
      LEFT JOIN (SELECT NULL::uuid AS cycle_id,
                        NULL::timestamptz AS cycle_anchor_at,
                        NULL::timestamptz AS view_anchor_at) cyc ON false
    $q$;
    -- 원장이 없으면 0053 의 UTC 날짜를 KST 로 옮길 근거도 없다 → 전부 표식 대상.
    v_cycutc := $q$SELECT NULL::uuid AS project_id, NULL::date AS utc_date,
                          NULL::date AS kst_date,
                          NULL::timestamptz AS cycle_anchor_at WHERE false$q$;
    -- ⚠️ 원장 없는 환경에서도 **인자가 있으면 standard 를 만든다**(B4 수리). 인자가
    -- NULL 이면 루트를 알아볼 근거가 없으므로 한 행도 만들지 않는다.
    v_global := $q$($2 IS NOT NULL AND rr.project_id = $2)$q$;
  END IF;

  -- 폴백으로 떨어졌다는 사실을 드러낸다(반환값은 rowcount 라 여기에 실을 수 없다).
  IF p_root_project_id IS NULL THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: p_root_project_id 가 NULL — 표면 standard 판정이 원장 출력 폴백으로 돈다(B4). 호출부가 anchorRootProjectId() 를 넘기는지 확인할 것.';
  END IF;

  EXECUTE format($q$
    WITH cyc_key AS (
      %3$s
    ), cyc_utc AS (
      -- ① 정본 규칙(§9 말미): 같은 프로젝트에서 **UTC 일자**가 그 날짜인 회차.
      --    같은 날짜에 회차가 둘이면 `min(cycle_anchor_at)` = 이른 쪽(결정론적).
      SELECT project_id, utc_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), cyc_kst AS (
      -- ② 폴백: UTC 일자로 못 찾았을 때만 **KST 일자**로 한 번 더 본다.
      --    실측 1건(Kia Mexico: run 앵커 07-09 22:55Z, 레지스트리 07-10)이 여기 걸린다 —
      --    ① 로는 못 찾아 원래 날짜를 유지하게 되는데, 그 값은 마침 자기 회차의 KST
      --    일자와 같다. ② 를 두면 "회차 못 찾음" 표식이 그 회차에 잘못 붙지 않는다.
      --    ① 을 먼저 보므로 캠페인처럼 **다른 회차를 가리키는** 이관은 그대로 유지된다.
      SELECT project_id, kst_date AS d, min(cycle_anchor_at) AS cycle_anchor_at
        FROM cyc_key GROUP BY 1, 2
    ), run_ctx AS (
      -- run 단위 사실을 한 번만 해소한다(답변마다 6-way 조인을 하지 않는다).
      SELECT rr.run_id,
             rr.project_id,
             rr.cycle_anchor_at,
             -- 회차 키. `cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못하므로
             -- run_id 를 섞어 **run 단독**으로 가른다(다른 NULL run 과 뭉치지 않게).
             rr.project_id::text || '|' ||
               COALESCE(rr.cycle_anchor_at::text, 'run:' || rr.run_id::text) AS cycle_key,
             -- 표면 판정 = run 의 소속 프로젝트. 순서: website → standard → project.
             --
             -- ⚠️ standard 를 project **앞에** 둔다. 글로벌 루트 프로젝트('HMG Standard
             -- (root catalog)')는 `projects` 테이블에도 한 행으로 있어서, projects 를 먼저
             -- 보면 글로벌 답변 전량이 'project' 로 떨어진다(2026-09-19 dry-run 실측:
             -- sf_standard 0 · sf_project 277,260 → 바로잡으면 standard 254,223 ·
             -- website 220,027 · project 23,037). `ELSE 'standard'` 로는 루트를 못 잡는다.
             --
             -- ELSE 는 'project' 다(원장 `surfaceExpr` 의 ELSE 와 같다). 어디에도 안 걸린
             -- 프로젝트를 'standard' 로 접으면 정체 모를 답변이 **글로벌 고객 화면**에 섞인다.
             --
             -- ⚠️ 조인이 아니라 EXISTS 다: `scope_project_id` 에는 UNIQUE 가 없어서, 조인으로
             -- 쓰면 중복 1건이 run 행을 복제하고 아래 upsert 가 "ON CONFLICT DO UPDATE
             -- command cannot affect row a second time" 으로 **싱크 트랜잭션을 통째로 죽인다.**
             CASE WHEN EXISTS (SELECT 1 FROM website_sites ws
                                WHERE ws.scope_project_id = rr.project_id::text) THEN 'website'
                  WHEN %2$s THEN 'standard'
                  ELSE 'project' END            AS surface,
             scr.cycle_id                       AS cycle_id,
             cyc.cycle_anchor_at                AS ledger_anchor_at,
             cyc.view_anchor_at                 AS ledger_view_anchor_at
        FROM scope_runs rr
        %1$s
       WHERE rr.run_id = ANY($1)
         AND rr.project_id IS NOT NULL
    ), ans AS (
      SELECT a.job_id, a.run_id, a.target, a.measured_at,
             rc.project_id, rc.cycle_key, rc.cycle_anchor_at, rc.surface,
             rc.cycle_id, rc.ledger_view_anchor_at,
             reg.anchor                 AS reg_anchor,
             reg.source_measured_at     AS reg_source_measured_at,
             reg.reason                 AS reg_reason
        FROM scope_answers a
        JOIN run_ctx rc ON rc.run_id = a.run_id
        LEFT JOIN scope_answer_anchors reg ON reg.job_id = a.job_id
       WHERE a.status = 'completed'
    ), cyc_reg AS (
      -- 회차별 레지스트리 앵커. 불일치가 있으면 **가장 이른 날짜**를 고른다(결정적).
      SELECT cycle_key,
             min(reg_anchor)                  AS reg_anchor,
             count(DISTINCT reg_anchor)::int  AS reg_variants
        FROM ans WHERE reg_anchor IS NOT NULL
       GROUP BY cycle_key
    ), cyc_led AS (
      -- 회차별 원장 앵커. 회차 run 들이 서로 다른 원장 회차에 귀속됐으면 이른 쪽.
      SELECT cycle_key,
             min(ledger_anchor_at)                 AS ledger_anchor_at,
             count(DISTINCT ledger_anchor_at)::int AS ledger_variants
        FROM run_ctx WHERE ledger_anchor_at IS NOT NULL
       GROUP BY cycle_key
    ), cyc_base AS (
      -- ⚠️ `min(project_id)` 를 쓰지 않는다 — **이 DB 에 `min(uuid)` 집계가 없다**
      -- (대상 DB PostgreSQL 17.6 에서 `pg_aggregate` 실측 0건. 상위 버전 지원 여부는
      --  확인하지 않았으므로 '이 DB 에 없다' 까지만 사실로 적는다).
      -- 그대로 두면 첫 호출에서 `42883 function min(uuid) does not exist` 로 죽는다.
      -- `project_id` 는 `cycle_key` 안에 이미 들어 있어 회차 안에서 상수이므로
      -- **GROUP BY 키로 빼면** 집계가 필요 없다(함수 의존이라 그룹이 쪼개지지 않는다).
      SELECT cycle_key,
             project_id,
             min(cycle_anchor_at) AS run_anchor_at,
             min(measured_at)     AS fallback_at
        FROM ans GROUP BY cycle_key, project_id
    ), cyc_res AS (
      SELECT b.cycle_key,
             b.project_id,
             r.reg_anchor, r.reg_variants, l.ledger_variants,
             CASE WHEN r.reg_anchor      IS NOT NULL THEN 'registry'
                  WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'
                  WHEN b.run_anchor_at   IS NOT NULL THEN 'run'
                  WHEN b.fallback_at     IS NOT NULL THEN 'fallback_measured'
             END AS source,
             -- 앵커 시각 원문. registry 는 **UTC 날짜**뿐이라(0053) 그 날짜에 해당하는
             -- 회차 시각을 찾아 쓰고, 못 찾으면 그 날짜의 앵커 타임존 자정으로 되살린다 —
             -- 어느 쪽이든 hmg_anchor_date(anchor_at) = anchor_date 가 유지된다.
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(u.cycle_anchor_at, k.cycle_anchor_at,
                                  (r.reg_anchor::timestamp AT TIME ZONE hmg_anchor_timezone()))
                  WHEN l.ledger_anchor_at IS NOT NULL THEN l.ledger_anchor_at
                  WHEN b.run_anchor_at    IS NOT NULL THEN b.run_anchor_at
                  ELSE b.fallback_at END AS anchor_at,
             -- 0053 이관(R1 말미): 회차를 찾았으면 그 시각을 **KST 로 다시 잘라** 쓴다.
             -- 못 찾았으면 원래 UTC 날짜를 그대로 두되 아래 reason 에 표식을 남긴다.
             CASE WHEN r.reg_anchor       IS NOT NULL
                    THEN COALESCE(hmg_anchor_date(u.cycle_anchor_at),
                                  hmg_anchor_date(k.cycle_anchor_at), r.reg_anchor)
                  WHEN l.ledger_anchor_at IS NOT NULL THEN hmg_anchor_date(l.ledger_anchor_at)
                  WHEN b.run_anchor_at    IS NOT NULL THEN hmg_anchor_date(b.run_anchor_at)
                  ELSE hmg_anchor_date(b.fallback_at) END AS anchor_date,
             (r.reg_anchor IS NOT NULL
              AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL) AS reg_utc_kept
        FROM cyc_base b
        LEFT JOIN cyc_reg r ON r.cycle_key = b.cycle_key
        LEFT JOIN cyc_led l ON l.cycle_key = b.cycle_key
        LEFT JOIN cyc_utc u ON u.project_id = b.project_id AND u.d = r.reg_anchor
        LEFT JOIN cyc_kst k ON k.project_id = b.project_id AND k.d = r.reg_anchor
    ), cyc_map AS (
      -- 귀속 날짜를 **회차 단위로 한 번만** 조회한다(답변마다 부르지 않는다).
      -- 아직 배정되지 않은 새 회차는 `anchor_date` 가 잠정값으로 들어오고, 아래
      -- 배정 -> 전파 단계가 같은 트랜잭션에서 고친 뒤 일치를 단언한다.
      SELECT c.*, hmg_round_date_of(c.project_id, c.anchor_date) AS round_date
        FROM cyc_res c
    )
    INSERT INTO scope_answer_cycle_anchors AS t (
      job_id, run_id, project_id, surface, anchor_at, anchor_date, anchor_week,
      anchor_month, measured_at_orig, is_default_engine,
      round_date, view_anchor_date, ledger_view_anchor_date,
      cycle_id, source, source_measured_at, reason, updated_at
    )
    SELECT a.job_id, a.run_id, a.project_id, a.surface, c.anchor_at, c.anchor_date,
           -- 주·월은 **귀속 날짜 기준**이다(스펙 §9 "귀속").
           hmg_anchor_week(c.round_date),
           hmg_anchor_month(c.round_date),
           -- 대표 답변 정렬 키(§2-16). 접기 **이전** 원본 시각이 정본이고, 없으면
           -- 현재 measured_at, 그것도 NULL 이면 회차 앵커 시각(컬럼이 NOT NULL 이다).
           COALESCE(a.reg_source_measured_at, a.measured_at, c.anchor_at),
           -- 기본 타겟 여부(§2-17). 목록은 `hmg_anchor_default_engines()` 한 곳.
           (a.target = ANY(hmg_anchor_default_engines())),
           -- 귀속 날짜. 매핑이 있으면 그 값, 없으면 `anchor_date` 잠정값이다.
           c.round_date,
           -- ── 노출 게이트 (스펙 §3.3 + §9 "노출" 행) ────────────────────────
           -- 산식의 정본은 **`hmg_anchor_view_date()` 한 곳**이다(위 함수 주석에 ①②).
           -- 여기서 CASE 를 한 벌 더 쓰면 `ON CONFLICT` 의 보존 경로와 갈린다(N-1).
           --
           -- ⚠️ 이것은 **시간 게이트만**이다. 숨김(0070 `hidden_reason`·0071
           -- `hidden_scope`)은 이 테이블에 복사하지 않는다(R3) — 리더가 `cycle_id` 로
           -- 원장을 조인해 따로 AND 한다(`scope-answer-anchors.ts::anchorNotHiddenSql`).
           --
           -- ⚠️ 결정 ⑪(비어 있는 view_anchor 를 앵커 날짜로 채움)은 **철회됐다**.
           hmg_anchor_view_date(a.surface, c.anchor_date,
                                hmg_anchor_date(a.ledger_view_anchor_at)),
           hmg_anchor_date(a.ledger_view_anchor_at),
           a.cycle_id, c.source,
           -- 접기 이전 원본 measured_at 은 0053 seed 에서만 온다(스펙 §3 컬럼 주석).
           a.reg_source_measured_at,
           -- 0053 이관 표식: 회차를 못 찾아 **UTC 날짜를 그대로 유지한** 회차의 답변에
           -- reason 접미로 드러낸다(감사 SQL 이 이 문자열을 센다).
           CASE WHEN c.reg_utc_kept
                  THEN COALESCE(a.reg_reason || ' ', '') || '[anchor-tz:utc-date-kept]'
                ELSE a.reg_reason END,
           now()
      FROM ans a JOIN cyc_map c ON c.cycle_key = a.cycle_key
     WHERE c.source IS NOT NULL
    ON CONFLICT (job_id) DO UPDATE SET
      run_id      = EXCLUDED.run_id,
      project_id  = EXCLUDED.project_id,
      surface     = EXCLUDED.surface,
      -- 보존 가드는 `hmg_anchor_keep_existing` 한 곳에서 판정한다(BLOCK-2②).
      anchor_at   = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_at   ELSE EXCLUDED.anchor_at   END,
      anchor_date = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.anchor_date ELSE EXCLUDED.anchor_date END,
      -- 귀속 날짜와 그 파생 키. 보존 경로는 **보존된 anchor_date** 의 자리를 쓴다
      -- (노출일이 N-1 에서 그랬던 것과 같은 이유 — 앵커가 보존됐는데 파생만 새 앵커
      --  기준으로 계산되면 한 행 안에서 축이 갈린다).
      round_date  = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_round_date_of(t.project_id, t.anchor_date)
                         ELSE EXCLUDED.round_date END,
      anchor_week = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_week(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_week END,
      anchor_month= CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN hmg_anchor_month(hmg_round_date_of(t.project_id, t.anchor_date))
                         ELSE EXCLUDED.anchor_month END,
      -- 대표 정렬 키·엔진 구분은 **답변 단위 사실**이라 보존 가드 밖이다(앵커가 아니다).
      measured_at_orig  = EXCLUDED.measured_at_orig,
      is_default_engine = EXCLUDED.is_default_engine,
      source      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source      ELSE EXCLUDED.source      END,
      source_measured_at = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.source_measured_at ELSE EXCLUDED.source_measured_at END,
      reason      = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
                         THEN t.reason      ELSE EXCLUDED.reason      END,
      -- N-1: 노출일은 **보존된 anchor_date 기준**으로 다시 계산한다. 종전에는
      -- `EXCLUDED.view_anchor_date` 를 그대로 받아, 접기로 날짜가 보존된 project 표면
      -- 행의 노출일만 자동 앵커 +1일이 되어 자기 anchor_date 와 어긋났다.
      view_anchor_date = CASE
        WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source)
          THEN hmg_anchor_view_date(
                 EXCLUDED.surface, t.anchor_date, EXCLUDED.ledger_view_anchor_date)
        ELSE EXCLUDED.view_anchor_date END,
      ledger_view_anchor_date = EXCLUDED.ledger_view_anchor_date,
      cycle_id    = EXCLUDED.cycle_id,
      updated_at  = now()
    -- 변경 감지 — 값이 실제로 달라진 행만 쓴다(멱등).
    -- ⚠️ `view_anchor_date` 는 위에서 t 기준으로 재계산되므로 EXCLUDED 와 직접 비교하면
    --    보존 행에서 매번 "바뀐 것처럼" 보인다. 그래서 원장 입력(`ledger_view_anchor_date`)
    --    을 비교 축으로 쓴다. 산식이 시간에 의존하지 않으므로(⑪ 철회) 그 축과
    --    `surface`·`anchor_date` 만 보면 노출일 변화를 전부 잡는다(N-12 구조적 차단).
    WHERE (t.run_id, t.project_id, t.surface, t.ledger_view_anchor_date, t.cycle_id,
           t.measured_at_orig, t.is_default_engine)
            IS DISTINCT FROM
          (EXCLUDED.run_id, EXCLUDED.project_id, EXCLUDED.surface,
           EXCLUDED.ledger_view_anchor_date, EXCLUDED.cycle_id,
           EXCLUDED.measured_at_orig, EXCLUDED.is_default_engine)
       -- N-2: 주·월도 감지 대상이다. 빠져 있으면 주·월 산식만 바뀐 경우
       -- `--recompute` 로도 갱신되지 않는다(감사 ⑧ 은 잡지만 고칠 수단이 없다).
       OR (NOT hmg_anchor_keep_existing(t.source, EXCLUDED.source)
           AND (t.anchor_at, t.anchor_date, t.anchor_week, t.anchor_month,
                t.source, t.source_measured_at, t.reason)
                 IS DISTINCT FROM
               (EXCLUDED.anchor_at, EXCLUDED.anchor_date, EXCLUDED.anchor_week,
                EXCLUDED.anchor_month, EXCLUDED.source,
                EXCLUDED.source_measured_at, EXCLUDED.reason))
  $q$, v_ledger, v_global, v_cycutc) USING v_runs, p_root_project_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- 귀속 배정은 삭제 뒤에 돌린다(아래). 종전의 함대 대표일 패스
  -- (`hmg_refresh_fleet_round_dates`, 최빈값 규칙)는 정규 요일 귀속으로
  -- **대체돼 삭제**됐다 — 그 패스가 가졌던 B5(떠난 주 미재계산)도 함께 사라졌다.

  -- ── 삭제·원복 전파 (B8) ────────────────────────────────────────────────────
  -- upsert 는 "지금 completed 인 답변"만 본다. 그래서 **사라진 쪽**은 스스로 정리되지
  -- 않는다: 상태가 completed 에서 벗어난 job, 0054 드롭이 미러에서 뺀 job, 0053 행을
  -- 지우는 방식의 접기 원복이 그렇다. 그 행들이 남으면 전수 계약이 위에서 깨진다
  -- (테이블 행 수 > completed 답변 수).
  --
  -- 정책(스펙 §9): **자동 삭제는 이 범위에서만** 한다 —
  --   · 범위 = 방금 재계산한 run 들(= 회차 전체로 넓힌 `v_runs`)
  --   · 대상 = 더 이상 completed 가 아닌 job 의 행
  --   · **고정(pinned) 출처는 지우지 않는다** — `registry`(0053 수작업 접기)는
  --     사람이 정한 값이라 자동으로 지우면 복구 근거가 사라진다
  --     (0053·0054 와 같은 규율). 대신 감사 SQL(`answer-cycle-anchors-audit.sql`)이
  --     고아로 표면화한다.
  DELETE FROM scope_answer_cycle_anchors t
   WHERE t.run_id = ANY(v_runs)
     AND NOT hmg_anchor_is_pinned(t.source)
     AND NOT EXISTS (SELECT 1 FROM scope_answers a
                      WHERE a.job_id = t.job_id AND a.status = 'completed');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: completed 에서 벗어났거나 드롭된 job 의 비고정(pinned 아님) 앵커 행 %건을 지웠다(B8).', v_deleted;
  END IF;

  -- ── 정규 요일 귀속: 배정 → 전파 → 단언 ────────────────────────────────────
  -- 삭제 **뒤**에 돈다. 먼저 배정하면 방금 사라질 회차에 자리를 내주게 된다.
  --
  -- 배정은 **미배정 회차만** 새로 앉힌다(과거 값 안정성). 전파는 값이 실제로 다른
  -- 행만 쓰므로 정상 상태에서 0행이다.
  v_assigned := hmg_assign_cycle_rounds(v_runs, NULL);
  v_moved    := hmg_propagate_cycle_rounds(v_runs, NULL);
  IF v_assigned > 0 THEN
    RAISE NOTICE 'refresh_answer_cycle_anchors: 회차 %개를 정규 요일 자리에 새로 배정했다(답변 %행에 전파).',
      v_assigned, v_moved;
  END IF;

  -- 잠정값이 밖으로 새지 않는지 **같은 트랜잭션에서** 못박는다. upsert 는 매핑이
  -- 없는 새 회차에 `anchor_date` 를 잠정으로 넣으므로, 배정·전파가 하나라도 빠지면
  -- 기간 술어가 귀속 날짜가 아닌 값을 본다(화면만 봐서는 안 보이는 형태다).
  SELECT count(*) INTO v_bad
    FROM scope_answer_cycle_anchors t
    LEFT JOIN scope_cycle_rounds m
      ON m.project_id = t.project_id AND m.anchor_date = t.anchor_date
   WHERE t.run_id = ANY(v_runs)
     AND (m.round_date IS NULL
          OR t.round_date   IS DISTINCT FROM m.round_date
          OR t.anchor_week  IS DISTINCT FROM hmg_anchor_week(m.round_date)
          OR t.anchor_month IS DISTINCT FROM hmg_anchor_month(m.round_date));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'refresh_answer_cycle_anchors: 귀속 날짜가 매핑과 어긋난 행이 %건 남았다 (배정·전파 점검)', v_bad;
  END IF;

  RETURN v_rows;
END
$fn$;--> statement-breakpoint
-- ── 적용 시점 **스모크 호출** (plpgsql 지연 검증 대비) ───────────────────────
--
-- 왜 필요한가: plpgsql 함수 본문의 `EXECUTE format($q$ ... $q$)` 문자열은 **CREATE 시점에
-- 파싱되지 않는다.** 타입·연산자·집계 부재는 **첫 호출**에서야 드러난다. 실제로
-- `min(uuid)` 가 그렇게 터졌다(PostgreSQL 17.6 에는 uuid min/max 집계가 없다 —
-- `pg_aggregate` 실측 0건. 상위 버전 지원 여부는 미확인). 단위 테스트는 DB 없이 돌기 때문에
-- 이 종류를 원리적으로 못 잡는다.
--
-- 그래서 **존재하지 않는 run id 하나**로 함수를 한 번 부른다. 행은 0이지만 PG 는
-- 문장을 파싱·계획하므로 동적 SQL 전체(확장 질의 · CTE 7개 · INSERT · ON CONFLICT ·
-- DELETE)가 검사된다. 귀속 배정·전파 함수도 이 호출로 함께 타서 같은 종류의 지연
-- 검증 구멍이 남지 않는다. 쓰기는 0건이고, 이 파일은 `apply-migration.ts` 가 한
-- 트랜잭션으로 감싸므로 실패하면 전부 롤백된다.
--
-- 미러 표가 아직 없는 환경(신규 구축 중)에서는 건너뛴다 — 그 환경에서 적용을 막는 것이
-- 목적이 아니다(README 의 구축 순서: scope-mirror.sql → 마이그레이션).
DO $smoketest$
DECLARE
  v_n bigint;
BEGIN
  IF to_regclass('public.scope_answers')        IS NULL
     OR to_regclass('public.scope_runs')        IS NULL
     OR to_regclass('public.scope_answer_anchors') IS NULL
     OR to_regclass('public.website_sites')     IS NULL THEN
    RAISE NOTICE '0077 스모크 건너뜀: 미러 표가 아직 없다(신규 환경). 첫 싱크에서 검증된다.';
    RETURN;
  END IF;
  -- 존재하지 않는 run. 확장·CTE·INSERT·DELETE 가 전부 0행으로 돌아야 한다.
  SELECT refresh_answer_cycle_anchors(
           ARRAY['00000000-0000-0000-0000-000000000000'::uuid], NULL) INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 스모크 실패: 없는 run 으로 % 행을 썼다', v_n;
  END IF;
  IF (SELECT count(*) FROM scope_answer_cycle_anchors) <> 0
     AND to_regclass('public.scope_answer_cycle_anchors') IS NOT NULL THEN
    NULL; -- 기존 행이 있는 것은 정상(재적용). 스모크는 반환값만 본다.
  END IF;
END
$smoketest$;--> statement-breakpoint

REVOKE ALL ON FUNCTION refresh_answer_cycle_anchors(uuid[], uuid) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_timezone() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_date(timestamptz) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_today() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_utc_midnight(date) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_default_engines() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_is_pinned(text) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_keep_existing(text, text) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_view_date(text, date, date) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_week(date) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_anchor_month(date) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_round_canonical_dow(text) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_round_prev_canonical(date, int) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_round_next_canonical(date, int) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON FUNCTION hmg_round_date_of(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── 적용 후 검증 (읽기 전용) ─────────────────────────────────────────────────
-- 백필 **전** 예상치는 scripts/db/answer-cycle-anchors-dryrun.sql 이 낸다.
-- 백필 **후** 정합 감사는 scripts/db/answer-cycle-anchors-audit.sql 한 문장이 전부
-- 대신한다(불일치 4종 + 누락 + 고아 + 상태 이탈 + 파생 키 + 귀속 정합).
-- 아래는 그중 눈으로 먼저 볼 것들이다.
--
--   -- 1) 전수 분해 — **네 항**이다(BLOCK-4). 백필 스크립트의 census() 와 같은 술어.
--   --    completed = 테이블 행 + scope_runs 행 없음 + project_id NULL + 출처 없음
--   --    (고아 = 답변이 사라진 앵커 행은 테이블 행에 있고 completed 에는 없으니 따로 센다)
--   SELECT (SELECT count(*) FROM scope_answers WHERE status = 'completed') AS completed,
--          (SELECT count(*) FROM scope_answer_cycle_anchors)               AS rows;
--   -- 2) anchor_date NULL = 0 (컬럼이 NOT NULL 이라 구조적으로 0)
--   -- 3) 출처별 행 수 — registry / ledger / run / fallback_measured
--   SELECT source, count(*) FROM scope_answer_cycle_anchors GROUP BY 1 ORDER BY 2 DESC;
--   -- 4) 0053 → KST 이관 결과. ⚠️ **0 이 기대값이 아니다**(R1). 회차 시각을 찾아 KST 로
--   --    다시 자른 행은 0053 의 UTC 날짜와 하루 다르다 — 이 수는 "이관된 행" 을 뜻한다.
--   SELECT count(*) AS registry_shifted FROM scope_answer_cycle_anchors c
--     JOIN scope_answer_anchors r USING (job_id)
--    WHERE c.source = 'registry' AND c.anchor_date IS DISTINCT FROM r.anchor;
--   -- 4') 회차를 못 찾아 UTC 날짜를 그대로 유지한 행 — 감사 대상(적을수록 좋다).
--   SELECT count(*) AS registry_utc_kept FROM scope_answer_cycle_anchors
--    WHERE source = 'registry' AND reason LIKE '%[anchor-tz:utc-date-kept]%';
--   -- 5) 고아(스펙 §4 — 지우지 않고 표면화만. 고정 출처는 자동 삭제 대상이 아니다)
--   SELECT count(*) FROM scope_answer_cycle_anchors c
--    WHERE NOT EXISTS (SELECT 1 FROM scope_answers a WHERE a.job_id = c.job_id);
--   -- 6) 귀속 분포 — 표면별 basis. `merged` 가 한 자리에 합쳋 수다.
--   SELECT surface, basis, count(*) FROM scope_cycle_rounds GROUP BY 1, 2 ORDER BY 1, 3 DESC;
--   -- 7) 정규 요일이 아닌 귀속 날짜 (project 표면 제외). **0 이어야 한다.**
--   SELECT count(*) FROM scope_cycle_rounds
--    WHERE hmg_round_canonical_dow(surface) IS NOT NULL
--      AND EXTRACT(ISODOW FROM round_date)::int <> hmg_round_canonical_dow(surface);
--
-- ── R1 을 UTC 로 되돌려야 할 때 (지금 기본 = **KST**) ────────────────────────
--   1) hmg_anchor_timezone() 본문을 'UTC' 로 CREATE OR REPLACE
--      (scripts/db/answer-cycle-anchors-dryrun.sql 의 prelude zone 상수도 함께 — 그 둘뿐이다)
--   2) npm run db:backfill:answer-anchors -- --apply --recompute   (전수 재계산)
--   3) 감사 SQL 의 `derived_key_drift` 가 0 인지 확인(주·월·anchor_at 이 새 축으로 따라왔는가)
--   4) 이 파일의 $selftest$ 오프셋 가드는 **+09:00 검사**다 — UTC 로 되돌리면 그 블록의
--      기대값을 UTC 기준으로 새로 넣는다(가드가 false 가 되어 조용히 건너뛰지 않게).
--   5) 0053 이관(`v_regcycle`)은 UTC 축에서는 항등이 되므로 `registry_shifted` 가 0 으로 돌아온다.
