-- ============================================================================
-- hmg-geo 재설계 DB-v2.19 보완 패치 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 WU-12(답변분석 경로 셀 대표: is_rep = round_date 셀 규칙)
-- 적용 순서: DB-v2.18(rd.answer.t_own, be/perf-v218) 뒤 1회(트랜잭션 1개). 합본 DB-v2.19.sql = DB-v2.18.sql + 이 파일.
--   P 번호 = DB-v2.18(P105·P106) 다음 P107~P110(be/int2 재번호 2026-10-01: wu12-period 가번호 P106~P109 를 +1).
--   이 패치는 v2.18 객체를 읽지도 쓰지도 않는다(순서만 v2.18 뒤). 선행 조건은 v2.18 적용(rd.answer.t_own)까지 확인한다.
-- 근거: 제품 결정 19·25(현행 값 완전 재현)·31(카드·추이 생성 시점 동결 = 별도 스냅샷 층 frz, 카드 셀 대표 포함 → 이 패치는 답변분석 경로만).
--
-- 현행(hmg-geo 2670a16)에는 셀 대표 규칙이 둘이다
--   카드·추이(집계층 사실표, surface-global.ts:464-478·surface-website.ts:296-317) = 회차 셀 최신, 정렬 = 미러 시각: 스냅샷 층(결정 31)이 맡는다.
--   답변분석(미러 앵커 축, 기간·스냅샷 공통) = scope-aggregates.ts:1820-1851 anchorRoundCellAnswerIdsSubquery + cell-snapshot.ts:104-115:
--     round_date 마다 셀(프롬프트, 엔진, 답변 region) 1건, 후보 = 완료 답변 ∧ 완료 run ∧ 지역 스코핑 ∧ 기간 술어(노출·숨김 계열·원장 서빙·기본 엔진),
--     정렬 = 접기 전 원본 시각(measured_at_orig) DESC, job_id DESC. 숨김 계열이 후보 술어 안이라 인용 숨김 회차가 있으면 인용 계열과 언급 계열의
--     대표가 다를 수 있다. 허브 rd.job.measured_at 은 원본이다(seed-20-ing.sql:136-146, 적재 ingest/pull/sync/stage.py:80).
--   stg hmg_r2 실측(2026-10-01, 읽기 전용): 허브 is_rep(회차 셀) 대 답변분석 규칙 = 글로벌 7,998(08-24 자리: 회차 413 대표가 같은 셀의 회차 551 에 밀림)·웹 247.
--     인용 계열 보정 = 글로벌 7,998·웹 0(같은 08-24 자리: 회차 551 이 인용 숨김이라 인용 계열 대표는 회차 413 에 남는다, 자리 1개).
--
-- P107 ing.answer_mirror_time·P108 rd.rep_order_at(72e73583 그대로 유지, 메인 지시 2026-10-01): 현행 미러 measured_at = 원본을 앵커 핀으로 접은 값
--      (scope-mirror.ts:56-58·101-127, 0053 scope_anchor_fold:59), 그 식으로 재현되지 않는 이관 답변 166행(stg)만 예외 표. 쓰임 = 동결 스냅샷 층
--      (제품 결정 31, card-snapshot-design.md 9장)이 발행 때 카드 셀 대표를 고르는 정렬 시각. rd.answer.is_rep·rd.rep_expected·reselect_rep 에는
--      쓰지 않는다(72e73583 의 P109 세 인자 판·스위치 rep_mirror_time 배선은 이 패치에서 뺐다: is_rep 은 답변분석 경로 규칙이고 원본 시각으로 고른다).
--      채우기: seed-20 §7-1'(새 이관)·back/migration/fill-v219.sql(이미 적재된 DB). 적재기는 쓰지 않는다(이후 답변은 핀 접기 식으로 계산된다).
-- P109 rd.rep_cit_delta  인용 계열 보정 표: 답변분석 인용 계열 대표(인용 숨김 회차를 후보에서 뺀 round_date 셀)가 is_rep 과 다른 답변 키만.
--      조회(api_ro)가 읽는다: 답변분석 경로 인용 모수 = is_rep XOR 소속(core.measure.citation_population, 현행 프로필 rep_round_date_cell).
--      표 신설 이유: rd.answer 는 월 파티션 핫 표라 ALTER 금지(추가형). 행이 드물어(자리 1개) 표 하나 LEFT 판정이 싸다.
-- P110 rd.rep_rules·rd.reselect_rep_seat·rd.assert_rep_seat  규칙 단일 정본(범위 = (표면, round_date[, 프롬프트, 엔진]) 묶음, p_surf NULL = 전체)
--      rep_rules         범위 답변마다 rep_ana(= is_rep, 답변분석 언급)·rep_ana_c(답변분석 인용). 읽기 전용
--      reselect_rep_seat is_rep := rep_ana(값이 다른 행만), 범위 답변의 보정 행을 기대값으로 교체. 반환 = is_rep 이 바뀐 답변 키(자식 사본 전파용)
--      assert_rep_seat   is_rep = rep_ana · 보정 표 = 기대값 · is_rep ⇒ elig_nc · 자식 사본 = 부모(범위 안), 위반 시 예외. 반환 = 범위 답변 수
--      서빙 아님·전체 숨김 회차(후보 밖)의 답변은 종전 회차 셀 규칙(P85 latest_first: 원본 시각 DESC NULLS FIRST, job_id, elig_nc 게이트)을 유지한다
--      (창 후보가 되지 않아 값에는 영향이 없고, QA·답변 목록의 대표 표시만 종전과 같다).
-- 결과 캐시: 보정 표는 적재·재투영이 rd.answer.is_rep 과 같은 트랜잭션에서 바꾼다(적재·원장 = 세대 +1, 재투영 = fill-v219-rep.sql 의 result_cache_invalidate).
-- 락: 새 표·새 함수뿐. 기존 표 ALTER·기존 함수 변경 없음. lock_timeout 30s.
-- 적용 절차(stg·prod): ① 이 패치 ② 스위치 rep_round_date_cell 을 적재 워커와 같은 값으로 켜고 재투영 psql -f back/migration/fill-v219-rep.sql(드라이런)
--      → -v commit=1 (자리마다 reselect_rep_seat + 자식 전파 + 단언, 끝에 result_cache_invalidate). 켜지 않으면 응답은 그대로다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regprocedure('rd.rep_expected(int4[], bool)') IS NULL OR to_regclass('app.ecat_version') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 't_own' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15(rd.rep_expected)·DB-v2.17(app.ecat_version)·DB-v2.18(rd.answer.t_own) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.rep_cit_delta') IS NOT NULL OR to_regclass('ing.answer_mirror_time') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.19 이미 적용됨(rd.rep_cit_delta·ing.answer_mirror_time 존재)';
  END IF;
END $v$;

-- ── P107 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.answer_mirror_time (
  job_id uuid PRIMARY KEY,
  measured_at timestamptz NOT NULL,                       -- 현행 미러 scope_answers.measured_at. rd.rep_order_at(원본, NULL, 핀) 과 다를 때만 행
  origin text NOT NULL DEFAULT 'mirror_seed' CHECK (origin IN ('mirror_seed', 'fill')),
  recorded_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE ing.answer_mirror_time IS
  '현행(hmg-geo 2670a16) 미러 measured_at 중 계산식(원본 + 앵커 핀 접기, rd.rep_order_at)으로 재현되지 않는 이관 답변의 값(예외). '
  '동결 스냅샷 층(결정 31)의 카드 셀 대표 정렬 시각(rd.answer.is_rep 에는 쓰지 않는다). 이관분만(seed-20 §7·fill-v219.sql), 적재기는 쓰지 않는다. DB-v2.19 P107';
ALTER TABLE ing.answer_mirror_time OWNER TO hmg_owner;
GRANT SELECT ON ing.answer_mirror_time TO loader, loader_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ing.answer_mirror_time TO migrator;

-- ── P108 ─────────────────────────────────────────────────────────────────────
-- STABLE(IMMUTABLE 아님): timestamptz AT TIME ZONE text 는 PG 에서 STABLE 이다(0053 scope_anchor_fold 와 같은 이유). 색인식으로 쓰지 않는다.
CREATE FUNCTION rd.rep_order_at(p_ts timestamptz, p_mirror_at timestamptz, p_pin_anchor date) RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $f$
SELECT CASE WHEN p_mirror_at IS NOT NULL THEN p_mirror_at
            WHEN p_pin_anchor IS NOT NULL AND p_ts IS NOT NULL
              THEN p_ts - (((p_ts AT TIME ZONE 'UTC')::date - p_pin_anchor) * INTERVAL '1 day')
            ELSE p_ts END
$f$;
COMMENT ON FUNCTION rd.rep_order_at(timestamptz, timestamptz, date) IS
  '현행 카드 셀 대표 정렬 시각(동결 스냅샷 층이 발행 때 쓴다, is_rep 아님): 미러 값(ing.answer_mirror_time) > 앵커 핀 접기(0053 scope_anchor_fold 식, ing.answer_anchor_pin) > 원본. DB-v2.19 P108';

-- ── P109 ─────────────────────────────────────────────────────────────────────
CREATE TABLE rd.rep_cit_delta (
  answer_key int4 PRIMARY KEY,
  surface int2 NOT NULL,
  round_date date NOT NULL);
CREATE INDEX rep_cit_delta_seat_idx ON rd.rep_cit_delta (surface, round_date);   -- 조회 술어가 보정 자리(round_date) 배열을 InitPlan 으로 읽는다(core.measure.rep_term)
COMMENT ON TABLE rd.rep_cit_delta IS
  '인용 계열 셀 대표 보정: 답변분석 인용 계열 대표(인용 숨김 회차를 후보에서 뺀 round_date 셀)가 is_rep(답변분석 언급 규칙)과 다른 답변 키. '
  '답변분석 경로 인용 모수 = is_rep XOR 소속(현행 프로필 rep_round_date_cell). 쓰기 = rd.reselect_rep_seat 만. DB-v2.19 P109';
ALTER TABLE rd.rep_cit_delta OWNER TO hmg_owner;
GRANT SELECT ON rd.rep_cit_delta TO api_ro, loader_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON rd.rep_cit_delta TO loader, migrator;

-- ── P110 ─────────────────────────────────────────────────────────────────────
-- 범위 = unnest(p_surf, p_round, p_prompt, p_engine) 행마다 (표면, round_date[, 프롬프트[, 엔진]]) 묶음(NULL 칸 = 그 축 전부). p_surf NULL = 전체.
-- 자리 셀(표면·round_date·프롬프트·엔진·답변 region)과 회차 셀(회차·프롬프트·엔진·국가)은 둘 다 (표면, round_date, 프롬프트, 엔진) 안에 들므로
-- 범위가 그 단위면 창 함수 분할이 잘리지 않는다.
CREATE FUNCTION rd.rep_rules(p_surf int2[], p_round date[], p_prompt int4[], p_engine int2[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, cyc_key int4, rep_ana bool, rep_ana_c bool)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
WITH s AS (SELECT DISTINCT t.surf, t.rd, t.pk, t.ek FROM unnest(p_surf, p_round, p_prompt, p_engine) AS t(surf, rd, pk, ek)),
a0 AS (
  SELECT a.surface, a.round_date, a.answer_key, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, a.region_geo_key, a.elig_nc
    FROM rd.answer a WHERE p_surf IS NULL
  UNION ALL
  SELECT DISTINCT a.surface, a.round_date, a.answer_key, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, a.region_geo_key, a.elig_nc
    FROM s JOIN rd.answer a ON a.surface = s.surf AND a.round_date = s.rd
                           AND (s.pk IS NULL OR a.prompt_key = s.pk) AND (s.ek IS NULL OR a.engine_key = s.ek)
   WHERE p_surf IS NOT NULL),
b AS (
  SELECT a0.*, j.measured_at, j.job_id,
         (c.servable AND c.hidden_scope NOT IN (1, 3)) AS tier_m,          -- 답변분석 언급 후보 회차(숨김 all·mentions 제외)
         (c.servable AND c.hidden_scope NOT IN (1, 2)) AS tier_c           -- 답변분석 인용 후보 회차(숨김 all·citations 제외)
    FROM a0
    JOIN rd.job j ON j.answer_key = a0.answer_key
    JOIN rd.cycle c ON c.cyc_key = a0.cyc_key),
x AS (
  SELECT b.*,
         b.elig_nc AND row_number() OVER (PARTITION BY b.surface, b.cyc_key, b.prompt_key, b.engine_key, b.geo_key
                                          ORDER BY b.measured_at DESC NULLS FIRST, b.job_id) = 1 AS rep_cyc,
         (b.tier_m AND b.elig_nc) AND row_number() OVER (PARTITION BY b.surface, b.round_date, b.prompt_key, b.engine_key, b.region_geo_key,
                                                                     (b.tier_m AND b.elig_nc)
                                                        ORDER BY b.measured_at DESC NULLS FIRST, b.job_id DESC) = 1 AS rep_sm,
         (b.tier_c AND b.elig_nc) AND row_number() OVER (PARTITION BY b.surface, b.round_date, b.prompt_key, b.engine_key, b.region_geo_key,
                                                                     (b.tier_c AND b.elig_nc)
                                                        ORDER BY b.measured_at DESC NULLS FIRST, b.job_id DESC) = 1 AS rep_sc
    FROM b)
SELECT x.surface, x.round_date, x.answer_key, x.cyc_key,
       CASE WHEN x.tier_m THEN x.rep_sm ELSE x.rep_cyc END,
       CASE WHEN x.tier_c THEN x.rep_sc WHEN x.tier_m THEN x.rep_sm ELSE x.rep_cyc END
  FROM x
$f$;

CREATE FUNCTION rd.reselect_rep_seat(p_surf int2[], p_round date[], p_prompt int4[], p_engine int2[])
RETURNS TABLE (answer_key int4)
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
-- is_rep := rep_ana(값이 다른 행만), 범위 답변의 보정 행을 기대값으로 교체. 반환 = is_rep 이 바뀐 답변 키(호출자가 자식 사본을 맞춘다:
-- 적재기 rd.propagate_answer_gates, 재투영 rd.fill_child_is_rep).
BEGIN
  DROP TABLE IF EXISTS pg_temp._rep_rr;
  CREATE TEMP TABLE _rep_rr ON COMMIT DROP AS SELECT * FROM rd.rep_rules(p_surf, p_round, p_prompt, p_engine);
  -- 게이트 elig_nc(P89) 미채움이면 규칙이 NULL 을 내 조용히 어긋난다: 먼저 멈춘다(fill-v215.sql §P89 먼저)
  IF EXISTS (SELECT 1 FROM pg_temp._rep_rr r WHERE r.rep_ana IS NULL OR r.rep_ana_c IS NULL) THEN
    RAISE EXCEPTION 'rd.reselect_rep_seat: rd.answer.elig_nc 가 채워져 있어야 한다(fill-v215.sql §P89 먼저)';
  END IF;
  DELETE FROM rd.rep_cit_delta d USING pg_temp._rep_rr r WHERE d.answer_key = r.answer_key;
  INSERT INTO rd.rep_cit_delta (answer_key, surface, round_date)
  SELECT r.answer_key, r.surface, r.round_date FROM pg_temp._rep_rr r WHERE r.rep_ana_c IS DISTINCT FROM r.rep_ana;
  RETURN QUERY
    UPDATE rd.answer a SET is_rep = r.rep_ana
      FROM pg_temp._rep_rr r
     WHERE a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key AND a.is_rep IS DISTINCT FROM r.rep_ana
    RETURNING a.answer_key;
  DROP TABLE IF EXISTS pg_temp._rep_rr;
END $f$;

CREATE FUNCTION rd.assert_rep_seat(p_surf int2[], p_round date[], p_prompt int4[], p_engine int2[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v_rule int; v_delta int; v_stale int := 0; v_elig int; v_child int;
BEGIN
  DROP TABLE IF EXISTS pg_temp._rep_ar;
  CREATE TEMP TABLE _rep_ar ON COMMIT DROP AS SELECT * FROM rd.rep_rules(p_surf, p_round, p_prompt, p_engine);
  SELECT count(*), count(*) FILTER (WHERE a.is_rep IS DISTINCT FROM r.rep_ana), count(*) FILTER (WHERE a.is_rep AND NOT a.elig_nc)
    INTO n, v_rule, v_elig
    FROM pg_temp._rep_ar r JOIN rd.answer a ON a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key;
  SELECT count(*) INTO v_delta FROM (
    (SELECT r.answer_key FROM pg_temp._rep_ar r WHERE r.rep_ana_c IS DISTINCT FROM r.rep_ana
     EXCEPT ALL
     SELECT d.answer_key FROM rd.rep_cit_delta d JOIN pg_temp._rep_ar r ON r.answer_key = d.answer_key)
    UNION ALL
    (SELECT d.answer_key FROM rd.rep_cit_delta d JOIN pg_temp._rep_ar r ON r.answer_key = d.answer_key
     EXCEPT ALL
     SELECT r.answer_key FROM pg_temp._rep_ar r WHERE r.rep_ana_c IS DISTINCT FROM r.rep_ana)) m;
  IF p_surf IS NULL THEN                                    -- 전체 범위: 답변이 없는 보정 행(재pull 로 사라진 답변)
    SELECT count(*) INTO v_stale FROM rd.rep_cit_delta d WHERE NOT EXISTS (SELECT 1 FROM pg_temp._rep_ar r WHERE r.answer_key = d.answer_key);
  END IF;
  SELECT (SELECT count(*) FROM pg_temp._rep_ar r JOIN rd.answer a ON a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key
            JOIN rd.answer_brand x ON x.surface = r.surface AND x.round_date = r.round_date AND x.answer_key = r.answer_key
           WHERE x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM pg_temp._rep_ar r JOIN rd.answer a ON a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key
            JOIN rd.answer_stance x ON x.surface = r.surface AND x.round_date = r.round_date AND x.answer_key = r.answer_key
           WHERE x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM pg_temp._rep_ar r JOIN rd.answer a ON a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key
            JOIN rd.citation x ON x.surface = r.surface AND x.round_date = r.round_date AND x.answer_key = r.answer_key
           WHERE x.is_rep IS DISTINCT FROM a.is_rep)
    INTO v_child;
  DROP TABLE IF EXISTS pg_temp._rep_ar;
  IF v_rule <> 0 OR v_delta <> 0 OR v_stale <> 0 OR v_elig <> 0 OR v_child <> 0 THEN
    RAISE EXCEPTION 'rd 셀 대표(자리 규칙) 단언 실패: 규칙 불일치 %, 보정 표 불일치 %, 답변 없는 보정 행 %, elig_nc 아닌 대표 %, 자식 사본 불일치 %',
      v_rule, v_delta, v_stale, v_elig, v_child;
  END IF;
  RETURN n;
END $f$;

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER FUNCTION rd.rep_order_at(timestamptz, timestamptz, date) OWNER TO hmg_owner;
GRANT EXECUTE ON FUNCTION rd.rep_order_at(timestamptz, timestamptz, date) TO loader, migrator;
ALTER FUNCTION rd.rep_rules(int2[], date[], int4[], int2[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.reselect_rep_seat(int2[], date[], int4[], int2[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_rep_seat(int2[], date[], int4[], int2[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.rep_rules(int2[], date[], int4[], int2[]), rd.reselect_rep_seat(int2[], date[], int4[], int2[]),
  rd.assert_rep_seat(int2[], date[], int4[], int2[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.rep_rules(int2[], date[], int4[], int2[]), rd.reselect_rep_seat(int2[], date[], int4[], int2[]),
  rd.assert_rep_seat(int2[], date[], int4[], int2[]) TO loader, migrator;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.rep_rules(int2[], date[], int4[], int2[])'::regprocedure,
               'rd.reselect_rep_seat(int2[], date[], int4[], int2[])'::regprocedure,
               'rd.assert_rep_seat(int2[], date[], int4[], int2[])'::regprocedure) AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'rd.rep_cit_delta'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('api_ro', 'rd.rep_cit_delta', 'select')
     OR has_table_privilege('api_ro', 'rd.rep_cit_delta', 'insert')
     OR NOT has_table_privilege('loader', 'rd.rep_cit_delta', 'insert')
     OR NOT has_function_privilege('loader', 'rd.reselect_rep_seat(int2[], date[], int4[], int2[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.reselect_rep_seat(int2[], date[], int4[], int2[])', 'execute') THEN
    RAISE EXCEPTION 'P109~P110 실패: 소유자·권한';
  END IF;
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'rd.rep_order_at(timestamptz, timestamptz, date)'::regprocedure)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.answer_mirror_time'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('loader', 'ing.answer_mirror_time', 'select')
     OR has_table_privilege('loader', 'ing.answer_mirror_time', 'insert')
     OR has_table_privilege('api_ro', 'ing.answer_mirror_time', 'select') THEN
    RAISE EXCEPTION 'P107~P108 실패: 소유자·권한';
  END IF;
  -- 접기 식 = 0053 scope_anchor_fold(시각 보존, 날짜만 앵커로)
  IF rd.rep_order_at(TIMESTAMPTZ '2026-09-01 00:32:15+00', NULL, DATE '2026-08-31') <> TIMESTAMPTZ '2026-08-31 00:32:15+00'
     OR rd.rep_order_at(TIMESTAMPTZ '2026-09-01 00:32:15+00', TIMESTAMPTZ '2026-08-30 01:00+00', DATE '2026-08-31') <> TIMESTAMPTZ '2026-08-30 01:00+00'
     OR rd.rep_order_at(TIMESTAMPTZ '2026-09-01 00:32:15+00', NULL, NULL) <> TIMESTAMPTZ '2026-09-01 00:32:15+00'
     OR rd.rep_order_at(NULL, NULL, DATE '2026-08-31') IS NOT NULL THEN
    RAISE EXCEPTION 'P108 실패: rd.rep_order_at 식';
  END IF;
  PERFORM rd.reselect_rep_seat(ARRAY[]::int2[], ARRAY[]::date[], ARRAY[]::int4[], ARRAY[]::int2[]);
  PERFORM rd.assert_rep_seat(ARRAY[]::int2[], ARRAY[]::date[], ARRAY[]::int4[], ARRAY[]::int2[]);
END $v$;

COMMIT;
