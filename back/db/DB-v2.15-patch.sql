-- ============================================================================
-- hmg-geo 재설계 DB-v2.15 보완 패치 (PostgreSQL 17, 2026-10-01) · 현행 값 재현 되돌림(제품 결정 19·23~25)이 쓸 열을 한 번에
-- 적용 순서: DB-v2.14.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.15.sql = DB-v2.14.sql + 이 파일.
-- 근거: notes/hgh-impl/revert-to-current-plan-20261001.md 5·7절(DDL 4건), perf-citations-r2-20261001.md 수정안 B(카테고리별 인용 수 13열).
--
-- 추가형: 기존 열·값·권한·함수 불변. 기존 표 ALTER 는 이 패치 한 번으로 모은다(표마다 ALTER 문장 1개).
--   새 열은 전부 NULL 허용·기본값 없음이다(메타데이터만 바뀜, 표 재작성·검증 스캔 없음). NULL = "아직 채우지 않음"이고, 기존 적재기(apply.project
--   INSERT_ANSWER·seed-40·seed-30·DIM_PROMPT_*)는 새 열을 모르므로 새 행도 NULL 로 들어간다. 그래서 이 패치 뒤에도 현 동작·현 적재가 그대로다.
--   값을 쓰는 곳은 채우기(back/migration/fill-v215.sql, 아래 함수)뿐이고, 적재기가 새 열을 쓰게 하는 것은 그 열을 읽는 WU 가 한다(아래 표).
--
-- P85 자식 표 대표 사본 is_rep bool NOT NULL DEFAULT false: rd.answer_brand·rd.answer_stance·rd.citation (A1 셀 대표, WU-2)
--     값 = 부모 rd.answer.is_rep 사본(계획서 5.1: 불리언 술어만으로 자식 표를 대표로 좁힌다. 세미조인 대안은 언급 화면 성능 위험 중).
--     상수 기본값 열이라 메타데이터만 바뀐다(PG11+ fast default, 표 재작성·검증 스캔 없음). 패치 직후 기존 자식 행은 전부 false(= 미채움과
--     같다) → back/migration/fill-v215-rep.sql 이 부모 값을 복사하고 단언한다(대표 행만 true 로 바뀌는 UPDATE). 그 전에는 cell_rep 을 켜지 않는다
--     (켜면 자식 표 모수가 0). NULL 을 두지 않는 이유: 대표 판정은 이진값이고, 새로 넣는 행이 기본값으로 들어와도 적재 트랜잭션 안에서
--     전파(rd.propagate_answer_gates)가 부모 값으로 맞춘다(아래). NOT NULL 로 가는 CHECK → VALIDATE → SET NOT NULL(ACCESS EXCLUSIVE)이 필요 없다.
--     대표 선정 규칙(WU-2, 현행 프로필 rep_pick_latest_first):
--       latest_first = 셀(surface, cyc_key, prompt, engine, geo) 서빙 답변 중 rd.job.measured_at DESC NULLS FIRST, job_id 1건을 먼저 굳히고
--                      그 답변이 elig_nc(P89) 가 아니면 셀 대표 없음(hmg-geo 2670a16 surface-global.ts:464-478·surface-website.ts:307-317 + 조회 게이트
--                      summary-trend-aggregates.ts:674-700. 글로벌 동률은 현행이 비결정이라 웹과 같은 job_id 오름차순으로 고정)
--       hub(기본)    = 셀 elig 후보 안 measured_at DESC NULLS LAST, answer_key DESC 1건(R05, 적재 REP_UPDATE·seed-40 §4)
--     hub 규칙은 is_rep ⇒ elig, 현행 규칙은 is_rep ⇒ elig_nc(카탈로그 무관, P89. 현행 선정은 카탈로그를 보지 않고 카탈로그는 조회 때 건다,
--     WU-4 병합 2026-10-01). 규칙 함수 rd.rep_expected 가 단일 정본이고, 적재기 REP_UPDATE 는 같은 식을 셀 임시 표에 쓴다(시험이 대조).
--     대표 선정 규칙 자체(현행 = 완료 측정 최신 1건을 먼저 굳힘, hub = elig 후보 안 최신)는 WU-2 가 정한다 → 여기서는 채우지 않는다.
--     전파: rd.propagate_answer_gates 를 이 패치에서 다시 만든다(is_rep 복사 + 사본 동치 단언에 추가, 나머지 본문은 DB-v2.13 과 같다).
--     적재기는 REP_UPDATE 가 뒤집은 다른 답변 키도 전파 대상에 넣는다(ingest.project.apply). seed-40 은 자식 INSERT 에 부모 값을 쓴다.
-- P86 rd.answer 인용 수 확장 14열 int2 NULL(G21A WU-5 + 인용 성능 수정안 B):
--     cit_n_all  = 답변의 모든 인용 원소 수(호스트 없는 인용 source_key = 0 포함). 현행 ⑤ 분모·GEO 국가 분모 정의(집계층, 호스트 무관).
--     cit_c1..cit_c13 = 호스트 있는 인용(source_key <> 0) 중 출처 차원 카테고리(rd.dim_source.category_key = app.citation_category 코드표 키
--                 1..13, fixture·seed-10 이 13 초과를 지운다)가 k 인 수. cit_off(P71)와 같은 "반영된 카테고리" 기준(오버라이드는 재판정 뒤).
--     CHECK(행 불변식, NULL 이면 통과): 14열은 전부 NULL 이거나 전부 값(answer_cit_ext_pair), cit_n_all ≥ cit_n ∧ 각 cit_c ≥ 0
--           (answer_cit_ext_bounds), Σ cit_c1..13 = cit_n(answer_cit_ext_cat_sum). cit_n 은 INSERT 로만 쓰인다(제자리 UPDATE 없음: 적재기·
--           seed-40 = INSERT, 재판정 = apply.project 재투영) → 채운 행의 cit_n 이 뒤에 혼자 바뀌어 CHECK 가 깨지는 경로가 없다.
-- P87 rd.answer.region_geo_key int2 NULL (GEOAX, WU-7): 답변 region(ing.answer.region)의 rd.dim_country geo_key(대소문자 무시, 없으면 0).
--     geo_key 는 웹사이트에서 사이트 국가 우선이라(적재 FACT_SRC) 현행 웹사이트 국가 경쟁 축(scope-aggregates.ts:7424 a.region)과 다르다.
--     global·project 는 적재 식이 같아 geo_key 와 같다: CHECK answer_region_geo_same(surface = 2 ∨ NULL ∨ region_geo_key = geo_key).
-- P88 rd.dim_prompt.cat_mask_all int2 NULL·in_root_catalog_all bool NULL (A41, WU-4): cat_mask·in_root_catalog(seed-30 §6·적재 DIM_PROMPT_*)와
--     같은 식에서 소프트 삭제 행(app.prompt.deleted_at)을 빼지 않은 값(현행 생성기 CAT_CTE surface-global.ts:117-135 는 삭제 행 브랜드를 넣는다).
--     CHECK: 둘이 함께 NULL(dim_prompt_cat_all_pair), 카탈로그 밖이면 비트 0(dim_prompt_cat_all_empty). "cat_mask_all ⊇ cat_mask" 는 확정
--     불변식이지만 CHECK 로 걸지 않는다: 지금 적재기(DIM_PROMPT_REFRESH)가 cat_mask 만 제자리 UPDATE 하므로 채운 뒤 카탈로그에 브랜드가 늘면
--     CHECK 가 적재를 깬다. 채우기 함수가 채운 시점에 단언하고, WU-4 가 적재기를 고친 뒤 CHECK 로 올린다.
--
-- 함수(전부 호출자 권한, 소유자 hmg_owner, 실행 = loader·migrator. api_ro 없음)
--   rd.answer_cit_ext(int4[])      답변 키 집합의 cit_n·cit_n_all·cit_c1..13 재계산(rd.citation 자식 합). NULL = 전체(무겁다)
--   rd.answer_region_geo(int4[])   답변 키 집합의 region_geo_key 재계산(rd.job → ing.answer_key_map → ing.answer.region → rd.dim_country)
--   rd.fill_answer_v215(int4[])    P86·P87 15열을 한 UPDATE 로 채움(값이 다른 행만, 서빙 답변만, 키 필수). 반환 = 갱신 행 수
--   rd.assert_answer_v215(int4[])  채운 행(cit_n_all NOT NULL)의 15열 = 재계산, 위반 시 예외. NULL = 채운 행 전부. 반환 = 검사 행 수
--   rd.fill_prompt_catalog_all()   P88 두 열 채움(전 행, 소형 표) + 채운 시점 ⊇ 단언. 반환 = 갱신 행 수
--   rd.fill_child_is_rep(int4[])   P85 자식 is_rep = 부모 사본(값이 다른 행만, 키 필수). 반환 = 갱신 행 수(fill-v215-rep.sql)
--   rd.rep_expected(int4[], bool)  P85 회차 키 집합(NULL = 전체)의 서빙 답변마다 대표 여부(규칙 = 둘째 인자 latest_first). 읽기 전용
--   rd.reselect_rep(int4[], bool)  P85 회차 키 집합의 rd.answer.is_rep 을 규칙대로 다시 고른다(값이 다른 행만, 키 필수). 자식은 안 건드린다
--   rd.assert_rep(int4[], bool)    P85 단언: is_rep ⇒ elig, 셀당 대표 ≤ 1, 자식 사본 = 부모, (둘째 인자가 NULL 이 아니면) 부모 = 규칙.
--                                  반환 = 검사한 답변 수. 대표의 acr_in 거짓(ACR 반복 동률 경계)은 예외가 아니라 NOTICE 로 센다
--   rd.propagate_answer_gates(int4[])  DB-v2.13 본문 + is_rep 사본(CREATE OR REPLACE, 소유자·권한 유지)
--   카테고리 키는 1..13 고정 열이라 app.citation_category 에 그 밖 키가 있으면 이 패치·채우기가 멈춘다(열 추가가 필요하다는 뜻).
--
-- 누가 언제 쓰나(열 → 읽는 WU, 적재기가 쓰게 바꿀 WU)
--   is_rep(자식)      WU-2(A1)         적재 = WU-2(전파·seed-40)
--   cit_n_all         WU-5(G21A)       적재 = WU-5(INSERT_ANSWER·seed-40·rd.assert_answer_cit_counts 확장 또는 assert_answer_v215 편입)
--   cit_c1..13        WU-5(인용 성능 B) 적재 = WU-5(같은 자리) + citation_override 재투영을 "유효 카테고리 변경" 전체로 확장
--   region_geo_key    WU-7(GEOAX)      적재 = WU-7
--   cat_mask_all 등   WU-4(A41)        적재 = WU-4(DIM_PROMPT_INSERT·REFRESH·seed-30)
--
-- 락: 한 트랜잭션에서 rd.answer·answer_brand·answer_stance·citation(파티션 전부)과 rd.dim_prompt 에 ACCESS EXCLUSIVE 를 잠깐 잡는다.
--   ADD COLUMN(NULL, 기본값 없음)은 메타데이터만, rd.answer CHECK 는 NOT VALID 로 붙여 검증 스캔이 없다(새 행·갱신 행만 검사).
--   검증(VALIDATE CONSTRAINT = SHARE UPDATE EXCLUSIVE, 읽기·쓰기 안 막음)은 채우기 끝에서 한다(fill-v215.sql). rd.dim_prompt 는 소형이라
--   검증된 CHECK 로 바로 붙인다(ms 단위 스캔). lock_timeout 30s: 긴 읽기 트랜잭션이 잡고 있으면 실패하고 아무것도 바뀌지 않는다(재시도).
--   적용 창에는 API·데우기·적재를 멈춘다(여러 표를 같은 트랜잭션에서 잠그므로 읽기와 잠금 순서가 엇갈리면 교착 감지로 한쪽이 죽는다).
--
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② 채우기 psql -f back/migration/fill-v215.sql(드라이런) → -v commit=1
--   (끝에 VALIDATE CONSTRAINT) ②' 대표 채우기 psql -f back/migration/fill-v215-rep.sql(드라이런) → -v commit=1(P85 자식 is_rep, 적재 워커 정지·
--   WU-2 코드 배포 뒤) ③ migrator 로 SELECT app.result_cache_invalidate();(rd.answer 는 데이터 버전 추적 표가 아니다. 새 열을 읽는
--   코드가 없어 응답은 안 바뀌지만 대역 밖 쓰기 규약대로). 배포 순서 제약 없음: 이 패치를 모르는 코드도 그대로 돈다(옛 적재기는 자식 is_rep 을
--   모르지만 새 전파 함수가 부모 사본을 쓴다. 옛 적재기가 뒤집은 다른 답변의 자식만 어긋나고 ②' 와 rd.assert_rep 이 잡는다).
-- 결과 캐시: rd.dim_prompt 는 추적 표라 채우기 UPDATE 가 데이터 버전을 올린다(rcache.tg_bump). 규약: D8 예외 ②(답변 1:1 판정 열, G-25·P71 과 같다).
-- 새 btree 없음(HOT 유지: 채우기 UPDATE 대상 열을 색인에 넣지 않는다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('ing.cycle_gate') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.14 가 먼저 적용돼야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname IN ('cit_n_all', 'region_geo_key') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.dim_prompt'::regclass AND attname = 'cat_mask_all' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('rd.answer_brand'::regclass, 'rd.answer_stance'::regclass, 'rd.citation'::regclass)
                  AND attname = 'is_rep' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 이미 적용됨(rd.answer.cit_n_all·region_geo_key, rd.dim_prompt.cat_mask_all, 자식 is_rep 중 하나 존재)';
  END IF;
  -- 카테고리 열은 1..13 고정(빈 DB 합본 적용 때는 코드표 행이 아직 없다: 있을 때만 검사)
  IF EXISTS (SELECT 1 FROM app.citation_category WHERE category_key NOT BETWEEN 1 AND 13) THEN
    RAISE EXCEPTION 'app.citation_category 에 1..13 밖 키가 있다: cit_c 열 추가가 먼저 필요하다';
  END IF;
END $v$;

-- ── P85 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer_brand ADD COLUMN is_rep bool NOT NULL DEFAULT false;
ALTER TABLE rd.answer_stance ADD COLUMN is_rep bool NOT NULL DEFAULT false;
ALTER TABLE rd.citation ADD COLUMN is_rep bool NOT NULL DEFAULT false;
COMMENT ON COLUMN rd.answer_brand.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';
COMMENT ON COLUMN rd.answer_stance.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';
COMMENT ON COLUMN rd.citation.is_rep IS
  '부모 rd.answer.is_rep 사본(A1 셀 대표, WU-2). rd.propagate_answer_gates 로만 갱신(패치 직후 false = 미채움, fill-v215-rep.sql). DB-v2.15 P85';

-- ── P86·P87 (rd.answer 는 ALTER 한 문장: 열 15개 + CHECK 4개, NOT VALID = 검증 스캔 없음) ──────────────
ALTER TABLE rd.answer
  ADD COLUMN cit_n_all int2, ADD COLUMN cit_c1 int2, ADD COLUMN cit_c2 int2, ADD COLUMN cit_c3 int2, ADD COLUMN cit_c4 int2,
  ADD COLUMN cit_c5 int2, ADD COLUMN cit_c6 int2, ADD COLUMN cit_c7 int2, ADD COLUMN cit_c8 int2, ADD COLUMN cit_c9 int2,
  ADD COLUMN cit_c10 int2, ADD COLUMN cit_c11 int2, ADD COLUMN cit_c12 int2, ADD COLUMN cit_c13 int2,
  ADD COLUMN region_geo_key int2,
  ADD CONSTRAINT answer_cit_ext_pair CHECK (num_nulls(cit_n_all, cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9,
                                                      cit_c10, cit_c11, cit_c12, cit_c13) IN (0, 14)) NOT VALID,
  ADD CONSTRAINT answer_cit_ext_bounds CHECK (cit_n_all >= cit_n
                                              AND least(cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9, cit_c10,
                                                        cit_c11, cit_c12, cit_c13) >= 0) NOT VALID,
  ADD CONSTRAINT answer_cit_ext_cat_sum CHECK (cit_c1 + cit_c2 + cit_c3 + cit_c4 + cit_c5 + cit_c6 + cit_c7 + cit_c8 + cit_c9 + cit_c10
                                               + cit_c11 + cit_c12 + cit_c13 = cit_n) NOT VALID,
  ADD CONSTRAINT answer_region_geo_same CHECK (surface = 2 OR region_geo_key IS NULL OR region_geo_key = geo_key) NOT VALID;
COMMENT ON COLUMN rd.answer.cit_n_all IS
  '모든 인용 원소 수(호스트 없는 인용 source_key = 0 포함). 현행 ⑤ 분모·GEO 국가 분모(G21A, WU-5). NULL = 아직 채우지 않음. DB-v2.15 P86';
COMMENT ON COLUMN rd.answer.cit_c1 IS
  '호스트 있는 인용 중 출처 카테고리 키 1 인 수(cit_c1..cit_c13 = app.citation_category 1..13, 합 = cit_n). 인용 성능 수정안 B. DB-v2.15 P86';
COMMENT ON COLUMN rd.answer.region_geo_key IS
  '답변 region(ing.answer.region)의 rd.dim_country geo_key(없으면 0). 웹사이트 국가 경쟁 현행 축(GEOAX, WU-7). global·project 는 geo_key 와 같다. DB-v2.15 P87';

-- ── P88 (소형 표: 검증된 CHECK) ───────────────────────────────────────────────
ALTER TABLE rd.dim_prompt
  ADD COLUMN cat_mask_all int2, ADD COLUMN in_root_catalog_all bool,
  ADD CONSTRAINT dim_prompt_cat_all_pair CHECK ((cat_mask_all IS NULL) = (in_root_catalog_all IS NULL)),
  ADD CONSTRAINT dim_prompt_cat_all_empty CHECK (in_root_catalog_all OR cat_mask_all = 0);
COMMENT ON COLUMN rd.dim_prompt.cat_mask_all IS
  'cat_mask 와 같은 식에서 소프트 삭제 루트 카탈로그 행을 빼지 않은 브랜드 비트 OR(A41, WU-4). NULL = 아직 채우지 않음. DB-v2.15 P88';
COMMENT ON COLUMN rd.dim_prompt.in_root_catalog_all IS
  'in_root_catalog 와 같은 식에서 소프트 삭제 행을 빼지 않은 값(A41, WU-4). NULL = 아직 채우지 않음. DB-v2.15 P88';

-- ── P89~P90 열·CHECK(WU-4 A41·G20. 설명·함수는 아래 "P89~P90" 구간) ────────────────────────
ALTER TABLE rd.answer
  ADD COLUMN elig_nc bool, ADD COLUMN std_in_nc bool, ADD COLUMN cit_in_nc bool,
  ADD CONSTRAINT answer_nc_pair CHECK (num_nulls(elig_nc, std_in_nc, cit_in_nc) IN (0, 3)) NOT VALID,
  ADD CONSTRAINT answer_nc_rule CHECK (elig_nc IS NULL OR (
        cit_in_nc = (elig_nc AND NOT (is_acr AND acr_iter_rank > 1))
    AND std_in_nc = (cit_in_nc AND analysis_state < 2)
    AND (NOT elig OR elig_nc)
    AND (surface = 1 OR elig_nc = elig))) NOT VALID;
ALTER TABLE rd.answer_brand
  ADD COLUMN std_in_nc bool, ADD COLUMN rid_n int2,
  ADD CONSTRAINT answer_brand_rid_n CHECK (rid_n IS NULL OR rid_n BETWEEN 1 AND entity_rows) NOT VALID;
ALTER TABLE rd.answer_stance ADD COLUMN std_in_nc bool;
ALTER TABLE rd.citation ADD COLUMN cit_in_nc bool;
ALTER TABLE rd.dim_prompt
  ADD CONSTRAINT dim_prompt_cat_all_sup CHECK (cat_mask_all IS NULL OR ((cat_mask_all & cat_mask) = cat_mask AND (in_root_catalog_all OR NOT in_root_catalog)));
COMMENT ON COLUMN rd.answer.elig_nc IS
  'elig 에서 루트 카탈로그 소속(in_root_catalog) 항만 뺀 값(카탈로그 무관 게이트). A41 모수 열·현행 대표 규칙(rep_pick_latest_first) 게이트. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer.std_in_nc IS
  'std_in 에서 루트 카탈로그 소속 항만 뺀 언급 모수(elig_nc ∧ acr_in ∧ 분석 있음). A41 현행 프로필(카탈로그 = 삭제 행 포함 세미조인)용. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer.cit_in_nc IS
  'cit_in 에서 루트 카탈로그 소속 항만 뺀 인용 모수(elig_nc ∧ acr_in). A41 현행 프로필용. NULL = 아직 채우지 않음. DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_brand.std_in_nc IS '부모 rd.answer.std_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_stance.std_in_nc IS '부모 rd.answer.std_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.citation.cit_in_nc IS '부모 rd.answer.cit_in_nc 사본(A41). DB-v2.15 P89';
COMMENT ON COLUMN rd.answer_brand.rid_n IS
  '이 행 언급들의 서로 다른 롤업 id(J1 rid) 수. G20 현행 노출 답변 수 = sum(rid_n)(fold.ts:468,486). NULL = 아직 채우지 않음. DB-v2.15 P89';


-- ── 함수: 재계산 ──────────────────────────────────────────────────────────────
-- 위치는 rd.job(answer_key PK)에서 파티션 좌표를 얻어 등치 조인(rd.answer_cit_counts·propagate_answer_gates 와 같은 이유).
CREATE FUNCTION rd.answer_cit_ext(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, cit_n int, cit_n_all int,
               cit_c1 int, cit_c2 int, cit_c3 int, cit_c4 int, cit_c5 int, cit_c6 int, cit_c7 int, cit_c8 int, cit_c9 int, cit_c10 int,
               cit_c11 int, cit_c12 int, cit_c13 int)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT c.surface, c.round_date, c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int, count(*)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int
  FROM rd.citation c
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 WHERE p_keys IS NULL
 GROUP BY c.surface, c.round_date, c.answer_key
UNION ALL
SELECT c.surface, c.round_date, c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int, count(*)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int, count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int
  FROM rd.job j
  JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 WHERE p_keys IS NOT NULL AND j.answer_key = ANY (p_keys) AND j.served
 GROUP BY c.surface, c.round_date, c.answer_key
$f$;

CREATE FUNCTION rd.answer_region_geo(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, region_geo_key int2)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT j.surface, j.round_date, j.answer_key, coalesce(g.geo_key, 0::int2)
  FROM rd.job j
  JOIN ing.answer_key_map m ON m.job_id = j.job_id
  JOIN ing.answer ia ON ia.run_month = m.run_month AND ia.job_id = j.job_id
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(ia.region)
 WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
$f$;

-- ── 함수: 채우기·단언 ────────────────────────────────────────────────────────
CREATE FUNCTION rd.fill_answer_v215(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_answer_v215: 키 배열 필수(배치로 나눠 부른다, back/migration/fill-v215.sql)';
  END IF;
  UPDATE rd.answer a
     SET cit_n_all = coalesce(x.cit_n_all, 0)::int2,
         cit_c1 = coalesce(x.cit_c1, 0)::int2, cit_c2 = coalesce(x.cit_c2, 0)::int2, cit_c3 = coalesce(x.cit_c3, 0)::int2,
         cit_c4 = coalesce(x.cit_c4, 0)::int2, cit_c5 = coalesce(x.cit_c5, 0)::int2, cit_c6 = coalesce(x.cit_c6, 0)::int2,
         cit_c7 = coalesce(x.cit_c7, 0)::int2, cit_c8 = coalesce(x.cit_c8, 0)::int2, cit_c9 = coalesce(x.cit_c9, 0)::int2,
         cit_c10 = coalesce(x.cit_c10, 0)::int2, cit_c11 = coalesce(x.cit_c11, 0)::int2, cit_c12 = coalesce(x.cit_c12, 0)::int2,
         cit_c13 = coalesce(x.cit_c13, 0)::int2,
         region_geo_key = g.region_geo_key
    FROM rd.job j
    JOIN rd.answer_region_geo(p_keys) g ON g.answer_key = j.answer_key
    LEFT JOIN rd.answer_cit_ext(p_keys) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND j.served
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11,
          a.cit_c12, a.cit_c13, a.region_geo_key)
         IS DISTINCT FROM
         (coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2, coalesce(x.cit_c3, 0)::int2,
          coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2, coalesce(x.cit_c7, 0)::int2,
          coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2, coalesce(x.cit_c11, 0)::int2,
          coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2, g.region_geo_key);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 서빙 답변인데 ing.answer 가 없어 region 을 못 풀면(적재 원장 불일치) 조용히 NULL 로 남기지 않는다
  IF EXISTS (SELECT 1 FROM rd.job j
               JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
              WHERE j.answer_key = ANY (p_keys) AND j.served AND (a.cit_n_all IS NULL OR a.region_geo_key IS NULL)) THEN
    RAISE EXCEPTION 'rd.fill_answer_v215: 채우지 못한 서빙 답변이 있다(ing.answer_key_map·ing.answer 누락)';
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_answer_v215(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE
           (a.cit_n, a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10,
            a.cit_c11, a.cit_c12, a.cit_c13, a.region_geo_key)
           IS DISTINCT FROM
           (coalesce(x.cit_n, 0)::int2, coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2,
            coalesce(x.cit_c3, 0)::int2, coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2,
            coalesce(x.cit_c7, 0)::int2, coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2,
            coalesce(x.cit_c11, 0)::int2, coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2, g.region_geo_key))
    INTO n, v
    FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    LEFT JOIN rd.answer_region_geo(p_keys) g ON g.answer_key = j.answer_key
    LEFT JOIN rd.answer_cit_ext(p_keys) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
     AND a.cit_n_all IS NOT NULL;
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.answer DB-v2.15 열(cit_n_all·cit_c1..13·region_geo_key) ≠ 재계산: % 답변', v;
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.fill_prompt_catalog_all() RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int;
BEGIN
  -- seed-30 §6·적재 DIM_PROMPT_*(cat_bits·in_root_catalog)와 같은 식, deleted_at 술어만 없다
  WITH root_cat AS (SELECT p.scope_prompt_id, p.brand_code FROM app.prompt p
                      JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                     WHERE p.scope_prompt_id IS NOT NULL),
  cat_bits AS (SELECT c.scope_prompt_id, bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS m
                 FROM root_cat c LEFT JOIN app.brand b ON b.brand_code = c.brand_code
                 CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u GROUP BY 1),
  nv AS (SELECT d.prompt_key, coalesce(cb.m, 0)::int2 AS m, cb.scope_prompt_id IS NOT NULL AS r
           FROM rd.dim_prompt d LEFT JOIN cat_bits cb ON cb.scope_prompt_id = d.prompt_id)
  UPDATE rd.dim_prompt d SET cat_mask_all = nv.m, in_root_catalog_all = nv.r
    FROM nv WHERE nv.prompt_key = d.prompt_key AND (d.cat_mask_all, d.in_root_catalog_all) IS DISTINCT FROM (nv.m, nv.r);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 채운 시점 단언: 삭제 포함 집합 ⊇ 비삭제 집합(cat_mask·in_root_catalog 가 최신 판정일 때 성립. 어긋나면 dim_prompt 재판정 누락)
  SELECT count(*) INTO v FROM rd.dim_prompt
   WHERE cat_mask_all IS NULL OR (cat_mask_all & cat_mask) <> cat_mask OR (in_root_catalog AND NOT in_root_catalog_all);
  IF v <> 0 THEN
    RAISE EXCEPTION 'rd.dim_prompt cat_mask_all ⊉ cat_mask 또는 미채움: % 행(재판정 누락 가능)', v;
  END IF;
  RETURN n;
END $f$;

CREATE FUNCTION rd.fill_child_is_rep(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
-- 부모 rd.answer.is_rep 을 자식 사본으로 복사(값이 다른 행만). 1회 채우기(fill-v215-rep.sql)·재선정 뒤 복사용. 적재는 propagate_answer_gates.
DECLARE n int := 0; m int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_child_is_rep: 키 배열 필수';
  END IF;
  UPDATE rd.answer_brand c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.is_rep IS DISTINCT FROM a.is_rep;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END $f$;

-- 대표 규칙 단일 정본(P85). 회차 키로 좁혀 rd.cycle 에서 파티션 좌표(surface, round_date)를 얻어 등치 조인한다(leaf 가지치기).
CREATE FUNCTION rd.rep_expected(p_cyc_keys int4[], p_latest_first bool)
RETURNS TABLE (surface int2, round_date date, answer_key int4, rep bool)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT x.surface, x.round_date, x.answer_key,
       (CASE WHEN p_latest_first THEN x.elig_nc ELSE x.elig END) AND (CASE WHEN p_latest_first THEN x.rn_all ELSE x.rn_elig END) = 1
  FROM (SELECT a.surface, a.round_date, a.answer_key, a.elig, a.elig_nc,
               row_number() OVER (PARTITION BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
                                  ORDER BY j.measured_at DESC NULLS FIRST, j.job_id) AS rn_all,
               row_number() OVER (PARTITION BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, a.elig
                                  ORDER BY j.measured_at DESC NULLS LAST, a.answer_key DESC) AS rn_elig
          FROM rd.cycle c
          JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
          JOIN rd.job j ON j.answer_key = a.answer_key
         WHERE p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) x
$f$;

CREATE FUNCTION rd.reselect_rep(p_cyc_keys int4[], p_latest_first bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
-- 회차 전체 셀의 부모 대표를 규칙대로 다시 고른다(값이 다른 행만). 자식 사본은 호출자가 rd.fill_child_is_rep 로 맞춘다(fill-v215-rep.sql).
DECLARE n int;
BEGIN
  IF p_cyc_keys IS NULL OR p_latest_first IS NULL THEN
    RAISE EXCEPTION 'rd.reselect_rep: 회차 키 배열·규칙 필수';
  END IF;
  -- 현행 규칙의 게이트 = elig_nc(P89). 미채움(NULL)이면 대표가 NULL 로 계산돼 조용히 어긋나므로 먼저 멈춘다(fill-v215.sql §P89 먼저)
  IF p_latest_first AND EXISTS (SELECT 1 FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date
                                   AND a.cyc_key = c.cyc_key WHERE c.cyc_key = ANY (p_cyc_keys) AND a.elig_nc IS NULL) THEN
    RAISE EXCEPTION 'rd.reselect_rep: 현행 규칙은 rd.answer.elig_nc 가 채워져 있어야 한다(fill-v215.sql §P89 먼저)';
  END IF;
  UPDATE rd.answer a SET is_rep = e.rep
    FROM rd.rep_expected(p_cyc_keys, p_latest_first) e
   WHERE a.surface = e.surface AND a.round_date = e.round_date AND a.answer_key = e.answer_key AND a.is_rep IS DISTINCT FROM e.rep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_rep(p_cyc_keys int4[], p_latest_first bool) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v_rule int := 0; v_elig int; v_multi int; v_child int; v_acr int;
BEGIN
  -- is_rep ⇒ 게이트: hub 규칙 = elig, 현행 규칙 = 카탈로그 무관 elig_nc(P89, WU-4). 규칙을 모르면(NULL) 둘 다 함의하는 elig_nc(미채움이면 elig)
  SELECT count(*), count(*) FILTER (WHERE a.is_rep AND NOT (CASE WHEN p_latest_first IS FALSE THEN a.elig ELSE coalesce(a.elig_nc, a.elig) END)),
         count(*) FILTER (WHERE a.is_rep AND NOT a.acr_in)
    INTO n, v_elig, v_acr
    FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
   WHERE p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys);
  SELECT count(*) INTO v_multi FROM (
    SELECT 1 FROM rd.cycle c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.cyc_key = c.cyc_key
     WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND a.is_rep
     GROUP BY a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key HAVING count(*) > 1) m;
  IF p_latest_first IS NOT NULL THEN
    SELECT count(*) INTO v_rule FROM rd.rep_expected(p_cyc_keys, p_latest_first) e
      JOIN rd.answer a ON a.surface = e.surface AND a.round_date = e.round_date AND a.answer_key = e.answer_key
     WHERE a.is_rep IS DISTINCT FROM e.rep;
  END IF;
  SELECT (SELECT count(*) FROM rd.cycle c JOIN rd.answer_brand x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM rd.cycle c JOIN rd.answer_stance x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
       + (SELECT count(*) FROM rd.cycle c JOIN rd.citation x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
            JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
           WHERE (p_cyc_keys IS NULL OR c.cyc_key = ANY (p_cyc_keys)) AND x.is_rep IS DISTINCT FROM a.is_rep)
    INTO v_child;
  IF v_elig <> 0 OR v_multi <> 0 OR v_rule <> 0 OR v_child <> 0 THEN
    RAISE EXCEPTION 'rd 대표(is_rep) 단언 실패: 게이트(elig·현행 elig_nc) 아님 %, 셀당 둘 이상 %, 규칙 불일치 %, 자식 사본 불일치 %', v_elig, v_multi, v_rule, v_child;
  END IF;
  IF v_acr <> 0 THEN
    RAISE NOTICE 'rd.assert_rep: ACR 반복 순번 > 1 인 대표 % 건(동률 경계. cell_rep 에서 acr_iter_unfolded 를 끈 조합만 영향)', v_acr;
  END IF;
  RETURN n;
END $f$;

-- 게이트 전파(DB-v2.13 본문 그대로 + is_rep 사본·단언). 적재기(ingest.project.apply)가 5만 청크로 부른다.
CREATE OR REPLACE FUNCTION rd.propagate_answer_gates(p_keys int4[]) RETURNS int LANGUAGE plpgsql AS $f$
-- 답변 위치는 rd.job(answer_key PK)에서 파티션 좌표(surface, round_date)를 얻어 등치 조인으로 찾는다.
-- rd.answer 를 answer_key = ANY 로 직접 찾으면 파티션 키가 없어 모든 leaf 의 PK 인덱스를 끝까지 훑는다
-- (2026-09-27 스모크: 24만 행 12 leaf 4.5ms vs rd.job 경유 0.028ms, 행 수에 비례).
DECLARE n int := 0; m int;
BEGIN
  -- 위치 단언: served 인 job 은 같은 좌표의 rd.answer 가 있어야 한다. 없으면 아래 조인이 조용히 0건이 된다.
  IF EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = ANY(p_keys) AND j.served
               AND NOT EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key))
  THEN RAISE EXCEPTION 'rd.job ↔ rd.answer 위치 불일치: 재투영 누락'; END IF;
  UPDATE rd.answer_brand c SET std_in = a.std_in, elig = a.elig, dflt = a.dflt, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.elig, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in = a.std_in, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.std_in, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in = a.cit_in, gap = a.gap, dflt = a.dflt, cyc_key = a.cyc_key, is_rep = a.is_rep
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY(p_keys)
     AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND (c.cit_in, c.gap, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key, a.is_rep);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.job j SET cyc_key = a.cyc_key, analysis_code = a.analysis_state
    FROM rd.answer a WHERE j.answer_key = ANY(p_keys)
     AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
     AND (j.cyc_key, j.analysis_code) IS DISTINCT FROM (a.cyc_key, a.analysis_state);
  -- 게이트 동치 단언(불변식 ①): 위반 시 롤백
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys)
                AND (c.std_in, c.elig, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key, a.is_rep))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys) AND (c.std_in, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.std_in, a.cyc_key, a.is_rep))
  OR EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
               JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
              WHERE j.answer_key = ANY(p_keys)
                AND (c.cit_in, c.gap, c.dflt, c.cyc_key, c.is_rep) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key, a.is_rep))
  THEN RAISE EXCEPTION 'rd 게이트 사본 불일치: 전파 누락'; END IF;
  RETURN n;
END $f$;

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER FUNCTION rd.answer_cit_ext(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.answer_region_geo(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_answer_v215(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_v215(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_prompt_catalog_all() OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_child_is_rep(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.rep_expected(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.reselect_rep(int4[], bool) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_rep(int4[], bool) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_cit_ext(int4[]), rd.answer_region_geo(int4[]), rd.fill_answer_v215(int4[]), rd.assert_answer_v215(int4[]),
  rd.fill_prompt_catalog_all(), rd.fill_child_is_rep(int4[]), rd.rep_expected(int4[], bool), rd.reselect_rep(int4[], bool),
  rd.assert_rep(int4[], bool) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_cit_ext(int4[]), rd.answer_region_geo(int4[]), rd.fill_answer_v215(int4[]), rd.assert_answer_v215(int4[]),
  rd.fill_prompt_catalog_all(), rd.fill_child_is_rep(int4[]), rd.rep_expected(int4[], bool), rd.reselect_rep(int4[], bool),
  rd.assert_rep(int4[], bool) TO loader, migrator;

-- ── 사후 단언(구조만: 값은 fill-v215.sql 이 채우고 배치마다 단언한다) ───────────────────
DO $v$
DECLARE bad text;
BEGIN
  -- 새 열: 형·NULL 허용·기본값 없음(P85 is_rep 만 NOT NULL·기본값 false), 파티션 leaf 까지 전파
  SELECT string_agg(format('%s.%s', t.r::text, x.col), ', ') INTO bad
    FROM (VALUES ('rd.answer'::regclass, 'cit_n_all', 'int2'),
                 ('rd.answer'::regclass, 'cit_c1', 'int2'), ('rd.answer'::regclass, 'cit_c13', 'int2'),
                 ('rd.answer'::regclass, 'region_geo_key', 'int2'), ('rd.dim_prompt'::regclass, 'cat_mask_all', 'int2'),
                 ('rd.dim_prompt'::regclass, 'in_root_catalog_all', 'bool')) AS x(r, col, typ)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = x.col AND NOT a.attisdropped
                      AND a.atttypid = x.typ::regtype AND NOT a.attnotnull AND NOT a.atthasdef);
  SELECT concat_ws(', ', bad, string_agg(format('%s.is_rep', t.r::text), ', ')) INTO bad
    FROM (VALUES ('rd.answer_brand'::regclass), ('rd.answer_stance'::regclass), ('rd.citation'::regclass)) AS x(r)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = t.r AND a.attname = 'is_rep' AND NOT a.attisdropped AND a.atttypid = 'bool'::regtype
                        AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false');
  bad := nullif(bad, '');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'P85~P88 실패: 열 형·NULL·기본값·전파: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname ~ '^cit_c([1-9]|1[0-3])$' AND NOT attisdropped) <> 13 THEN
    RAISE EXCEPTION 'P86 실패: cit_c1..cit_c13 13열';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass
        AND conname IN ('answer_cit_ext_pair', 'answer_cit_ext_bounds', 'answer_cit_ext_cat_sum', 'answer_region_geo_same')) <> 4
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.dim_prompt'::regclass
           AND conname IN ('dim_prompt_cat_all_pair', 'dim_prompt_cat_all_empty') AND convalidated) <> 2 THEN
    RAISE EXCEPTION 'P86~P88 실패: CHECK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_cit_ext(int4[])'::regprocedure, 'rd.answer_region_geo(int4[])'::regprocedure,
               'rd.fill_answer_v215(int4[])'::regprocedure, 'rd.assert_answer_v215(int4[])'::regprocedure,
               'rd.fill_prompt_catalog_all()'::regprocedure, 'rd.fill_child_is_rep(int4[])'::regprocedure,
               'rd.rep_expected(int4[], bool)'::regprocedure, 'rd.reselect_rep(int4[], bool)'::regprocedure,
               'rd.assert_rep(int4[], bool)'::regprocedure)
              AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.assert_rep(int4[], bool)', 'execute')
     OR has_function_privilege('api_ro', 'rd.reselect_rep(int4[], bool)', 'execute')
     OR NOT has_function_privilege('loader', 'rd.fill_answer_v215(int4[])', 'execute')
     OR NOT has_function_privilege('migrator', 'rd.assert_answer_v215(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_cit_ext(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P85~P88 실패: 함수 소유자·실행 권한';
  END IF;
  -- 함수가 컴파일되고 빈 키에 0 을 낸다(쓰기 없음)
  PERFORM rd.fill_answer_v215(ARRAY[]::int4[]);
  PERFORM rd.assert_answer_v215(ARRAY[]::int4[]);
  PERFORM rd.fill_child_is_rep(ARRAY[]::int4[]);
  PERFORM rd.reselect_rep(ARRAY[]::int4[], true);
  PERFORM rd.assert_rep(ARRAY[]::int4[], true);
  PERFORM rd.propagate_answer_gates(ARRAY[]::int4[]);
  PERFORM 1 FROM rd.answer_cit_ext(ARRAY[]::int4[]);
END $v$;

-- ════════════════════════════════════════════════════════════════════════════
-- P89~P90 (WU-4, 2026-10-01: A41 catalog_incl_deleted · G20 brand_exposure_per_alias). 위 P85~P88 과 독립 구간(WU-2 는 P85 를 고친다).
--   같은 트랜잭션·같은 규약: 새 열은 NULL 허용·기본값 없음(메타데이터만), rd 사실 표 CHECK 는 NOT VALID(새 행·갱신 행만 검사),
--   값은 적재기(apply.project INSERT_*·seed-40)가 새 행부터 쓰고 기존 행은 fill-v215.sql §P89 가 채운 뒤 VALIDATE 한다.
--
-- P89 사실 표 모수 열(A41): 카탈로그 게이트를 뺀 모수 = "elig_nc"(elig 식에서 루트 카탈로그 소속 in_root_catalog 항만 뺀 것) 기반.
--     현행(surface-global.ts:117-135 CAT_CTE)은 소프트 삭제 카탈로그 행을 거르지 않아, 전부 삭제된 프롬프트(stg 103개, 2026-08-18 삭제,
--     답변 9,304건 = 07~08월 회차)도 in_root_catalog = 1 로 모수에 남는다. hub elig 는 비삭제 카탈로그만 보므로 그 답변이 elig = false 로
--     굳는다(읽기 술어만으로는 되살릴 수 없다: elig 의 다른 항(run 상태·숨김 시장·한국어 비-KR·태그 시장)이 행마다 다르다).
--     그래서 카탈로그 항만 뺀 모수를 열로 두고, 카탈로그 게이트는 조회 때 rd.dim_prompt.cat_mask_all 세미조인(core.measure.catalog_all_pred)이 건다.
--     카탈로그 변경(삭제·복구)은 이 열을 바꾸지 않는다(카탈로그 비의존) → 재판정 없이 dim_prompt 두 열만 맞으면 된다.
--       rd.answer.elig_nc    = elig 식에서 카탈로그 항만 뺀 값(현행 대표 규칙 rep_pick_latest_first 의 게이트이기도 하다: P85 rd.rep_expected)
--       rd.answer.std_in_nc  = elig_nc ∧ acr_in ∧ analysis_state < 2   (std_in 과 같은 식, elig → elig_nc)
--       rd.answer.cit_in_nc  = elig_nc ∧ acr_in                        (cit_in 과 같은 식)
--       자식 사본: answer_brand.std_in_nc · answer_stance.std_in_nc · citation.cit_in_nc = 부모 값(적재 때 같은 원천에서 쓴다)
--     website·project 는 elig 에 카탈로그 항이 없어 *_nc = std_in·cit_in(CHECK). elig ⇒ elig_nc(CHECK).
-- P89 rd.answer_brand.rid_n int2 (G20): 행(답변, 표시 브랜드, 경쟁 여부)에 모인 언급 행들의 서로 다른 롤업 id(J1 rid = 접두 교정 → 별칭 접기 →
--     원 롤업, canonRollupSql) 수. 현행 집계층 노출 답변 수(fold.ts:468,486 count(DISTINCT job_id) 를 (brand_id, brand_name) 별로 → 리더가
--     표시명으로 합산)를 재현하는 가중치: 노출 = sum(rid_n). 1 ≤ rid_n ≤ entity_rows(CHECK).
-- P90 rd.dim_prompt ⊇ CHECK(dim_prompt_cat_all_sup): cat_mask_all ⊇ cat_mask, in_root_catalog ⇒ in_root_catalog_all. P88 이 적재기 수정
--     뒤로 미뤘던 불변식이다(WU-4 가 DIM_PROMPT·DIM_PROMPT_REFRESH·seed-30 을 두 열 함께 쓰게 고쳤다). 소형 표라 검증된 CHECK.
--
-- 함수(호출자 권한, 소유자 hmg_owner, 실행 = loader·migrator)
--   rd.answer_elig_nc(int4[])   답변 키 집합(NULL = 전 서빙 답변)의 elig_nc 재계산(rd.job + ing.answer·ing.run + rd.dim_prompt·dim_country).
--                               식 = apply.project FACT_SRC·seed-40 §4 elig 에서 in_root_catalog 항만 뺀 것(세 곳이 같은 식: 단언이 대조한다)
--   rd.fill_answer_nc(int4[])   P89 모수 열 채움(부모 → 자식 사본, 값이 다른 행만). 키 필수. 반환 = 갱신 행 수
--   rd.assert_answer_nc(int4[]) 채운 행(std_in_nc NOT NULL)의 부모 = 재계산·자식 = 부모, 위반 시 예외. NULL = 채운 행 전부. 반환 = 검사 답변 수
--   rid_n 은 표기 쌍(seed-3x-common §6 _bn_pair, 세션 pg_temp)이 있어야 계산된다 → 함수 없이 fill-v215.sql §P89 가 시드 공용 파일을 올려 채운다.
-- ════════════════════════════════════════════════════════════════════════════
-- P89~P90 의 열·CHECK DDL 은 위(P88 뒤)에 있다: P85 규칙 함수 rd.rep_expected 가 rd.answer.elig_nc 를 읽어 함수 생성 전에 열이 있어야 한다.

CREATE FUNCTION rd.answer_elig_nc(p_keys int4[])
RETURNS TABLE (surface int2, round_date date, answer_key int4, elig_nc bool)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
SELECT j.surface, j.round_date, j.answer_key,
       (r.status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              NOT (coalesce(g.hidden_standard, false)
                   OR (ia.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (ia.region <> 'KR' AND coalesce(p.is_korean, false)
                                AND (ia.measured_at IS NULL OR ia.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR p.regions IS NULL OR cardinality(p.regions) = 0)), false)
              AND (p.regions IS NULL OR cardinality(p.regions) = 0 OR coalesce(ia.region = ANY (p.regions), false)))))
  FROM rd.job j
  JOIN ing.answer_key_map m ON m.job_id = j.job_id
  JOIN ing.answer ia ON ia.run_month = m.run_month AND ia.job_id = j.job_id
  JOIN ing.run r ON r.run_id = ia.run_id
  LEFT JOIN rd.dim_prompt p ON p.prompt_key = j.prompt_key AND j.prompt_key <> 0
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(ia.region)
 WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys))
$f$;

CREATE FUNCTION rd.fill_answer_nc(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int := 0; m int;
BEGIN
  IF p_keys IS NULL THEN
    RAISE EXCEPTION 'rd.fill_answer_nc: 키 배열 필수(배치로 나눠 부른다, back/migration/fill-v215.sql §P89)';
  END IF;
  UPDATE rd.answer a
     SET elig_nc = x.elig_nc,
         std_in_nc = (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2),
         cit_in_nc = (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1))
    FROM rd.answer_elig_nc(p_keys) x
   WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key
     AND (a.elig_nc, a.std_in_nc, a.cit_in_nc) IS DISTINCT FROM
         (x.elig_nc, (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2), (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1)));
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
              WHERE j.answer_key = ANY (p_keys) AND j.served AND a.elig_nc IS NULL) THEN
    RAISE EXCEPTION 'rd.fill_answer_nc: 채우지 못한 서빙 답변이 있다(ing.answer_key_map·ing.answer·ing.run 누락)';
  END IF;
  UPDATE rd.answer_brand c SET std_in_nc = a.std_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.answer_stance c SET std_in_nc = a.std_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE rd.citation c SET cit_in_nc = a.cit_in_nc
    FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.answer_key = ANY (p_keys) AND c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
     AND c.cit_in_nc IS DISTINCT FROM a.cit_in_nc;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END $f$;

CREATE FUNCTION rd.assert_answer_nc(p_keys int4[]) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
DECLARE n int; v int; c1 int; c2 int; c3 int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE (a.elig_nc, a.std_in_nc, a.cit_in_nc) IS DISTINCT FROM
           (x.elig_nc, (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1) AND a.analysis_state < 2), (x.elig_nc AND NOT (a.is_acr AND a.acr_iter_rank > 1))))
    INTO n, v
    FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    LEFT JOIN rd.answer_elig_nc(p_keys) x ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.elig_nc IS NOT NULL;
  SELECT count(*) INTO c1 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.answer_brand c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  SELECT count(*) INTO c2 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.answer_stance c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.std_in_nc IS DISTINCT FROM a.std_in_nc;
  SELECT count(*) INTO c3 FROM rd.job j
    JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
    JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE j.served AND (p_keys IS NULL OR j.answer_key = ANY (p_keys)) AND a.std_in_nc IS NOT NULL AND c.cit_in_nc IS DISTINCT FROM a.cit_in_nc;
  IF v <> 0 OR c1 <> 0 OR c2 <> 0 OR c3 <> 0 THEN
    RAISE EXCEPTION 'rd.answer elig_nc·std_in_nc·cit_in_nc ≠ 재계산 % 답변, 자식 사본 불일치 answer_brand % · answer_stance % · citation %', v, c1, c2, c3;
  END IF;
  RETURN n;
END $f$;

ALTER FUNCTION rd.answer_elig_nc(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.fill_answer_nc(int4[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_answer_nc(int4[]) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION rd.answer_elig_nc(int4[]), rd.fill_answer_nc(int4[]), rd.assert_answer_nc(int4[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.answer_elig_nc(int4[]), rd.fill_answer_nc(int4[]), rd.assert_answer_nc(int4[]) TO loader, migrator;

DO $v$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', t.r::text, x.col), ', ') INTO bad
    FROM (VALUES ('rd.answer'::regclass, 'elig_nc', 'bool'), ('rd.answer'::regclass, 'std_in_nc', 'bool'), ('rd.answer'::regclass, 'cit_in_nc', 'bool'),
                 ('rd.answer_brand'::regclass, 'std_in_nc', 'bool'), ('rd.answer_brand'::regclass, 'rid_n', 'int2'),
                 ('rd.answer_stance'::regclass, 'std_in_nc', 'bool'), ('rd.citation'::regclass, 'cit_in_nc', 'bool')) AS x(r, col, typ)
    CROSS JOIN LATERAL (SELECT x.r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = x.r
                        UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
                         WHERE i1.inhparent = x.r) t(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = x.col AND NOT a.attisdropped
                      AND a.atttypid = x.typ::regtype AND NOT a.attnotnull AND NOT a.atthasdef);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'P89 실패: 열 형·NULL·기본값·전파: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname IN ('answer_nc_pair', 'answer_nc_rule')) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.answer_brand'::regclass AND conname = 'answer_brand_rid_n')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.dim_prompt'::regclass AND conname = 'dim_prompt_cat_all_sup' AND convalidated) THEN
    RAISE EXCEPTION 'P89~P90 실패: CHECK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('rd.answer_elig_nc(int4[])'::regprocedure, 'rd.fill_answer_nc(int4[])'::regprocedure,
               'rd.assert_answer_nc(int4[])'::regprocedure) AND pg_get_userbyid(proowner) <> 'hmg_owner')
     OR NOT has_function_privilege('loader', 'rd.fill_answer_nc(int4[])', 'execute')
     OR NOT has_function_privilege('migrator', 'rd.assert_answer_nc(int4[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.answer_elig_nc(int4[])', 'execute') THEN
    RAISE EXCEPTION 'P89 실패: 함수 소유자·실행 권한';
  END IF;
  PERFORM rd.fill_answer_nc(ARRAY[]::int4[]);
  PERFORM rd.assert_answer_nc(ARRAY[]::int4[]);
END $v$;

COMMIT;
