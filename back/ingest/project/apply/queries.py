"""ingest.project.apply 투영 SQL(loader 쓰기 경로. API 읽기 SQL 이 아니라 ing·rd 를 직접 읽고 쓴다: A17 적재 모듈 예외).

모든 판정식은 bulk 시드(back/migration/seed/seed-30-dims.sql·seed-40-facts.sql)의 같은 절을 답변 키 집합(_ig_s)으로 좁힌 것이다.
식을 바꾸면 시드와 동치가 깨진다: 동치 테스트(tests/test_equivalence.py)가 행 단위로 대조한다. 절 번호는 시드 파일의 절이다.

임시 표(트랜잭션 로컬, ON COMMIT DROP)
  _ig_s0   바뀐 job(내용 해시가 바뀌었거나 새 job) 답변 키. 전역 판정 영향 감지는 이 집합으로만 한다.
  _ig_s    다시 투영할 답변 키 = _ig_s0 ∪ 이름·URL 판정 영향 답변 ∪ 회차 귀속이 바뀐 run 의 job ∪ ACR run-셀 형제
  _ig_jobs _ig_s 의 ing.answer 행
"""
import re

# ── 0. 집합 ─────────────────────────────────────────────────────────────────
MAKE_S0 = """
DROP TABLE IF EXISTS _ig_s0;
CREATE TEMP TABLE _ig_s0 (answer_key int4 PRIMARY KEY) ON COMMIT DROP;
DROP TABLE IF EXISTS _ig_s;
CREATE TEMP TABLE _ig_s (answer_key int4 PRIMARY KEY) ON COMMIT DROP;
DROP TABLE IF EXISTS _ig_pr_extra;
CREATE TEMP TABLE _ig_pr_extra (prompt_run_id uuid PRIMARY KEY) ON COMMIT DROP;
DROP TABLE IF EXISTS _ig_xruns;
CREATE TEMP TABLE _ig_xruns (run_id uuid PRIMARY KEY) ON COMMIT DROP;
DROP TABLE IF EXISTS _ig_xprompts;
CREATE TEMP TABLE _ig_xprompts (prompt_id uuid PRIMARY KEY) ON COMMIT DROP;
DROP TABLE IF EXISTS _ig_xents;
CREATE TEMP TABLE _ig_xents (entity_id uuid PRIMARY KEY) ON COMMIT DROP;
"""
ADD_XRUNS = "INSERT INTO _ig_xruns SELECT DISTINCT r FROM unnest($1::uuid[]) r WHERE r IS NOT NULL ON CONFLICT DO NOTHING"
ADD_XPROMPTS = "INSERT INTO _ig_xprompts SELECT DISTINCT r FROM unnest($1::uuid[]) r WHERE r IS NOT NULL ON CONFLICT DO NOTHING"
ADD_XENTS = "INSERT INTO _ig_xents SELECT DISTINCT r FROM unnest($1::uuid[]) r WHERE r IS NOT NULL ON CONFLICT DO NOTHING"
FILL_S0 = "INSERT INTO _ig_s0 SELECT DISTINCT k FROM unnest($1::int4[]) k WHERE k IS NOT NULL ON CONFLICT DO NOTHING"
S_FROM_S0 = "INSERT INTO _ig_s SELECT answer_key FROM _ig_s0 ON CONFLICT DO NOTHING"
ADD_S = "INSERT INTO _ig_s SELECT DISTINCT k FROM unnest($1::int4[]) k WHERE k IS NOT NULL ON CONFLICT DO NOTHING"
ADD_PR = "INSERT INTO _ig_pr_extra SELECT DISTINCT p FROM unnest($1::uuid[]) p WHERE p IS NOT NULL ON CONFLICT DO NOTHING"

# 옛 자식 행 스냅샷(재pull 로 인용·언급이 줄어드는 방향의 전역 판정 복귀, 검증 결함 D2·D6).
#   적재기가 바뀐 job 의 ing 자식 행을 지우기 전에(sync CHILDREN) capture_prior 로 채운다. 트랜잭션 로컬, project() 가 소비하고 비운다.
#   _ig_prior_url   바뀐 job 이 인용하던 URL(최빈 host·도메인·제목 재계산 대상, 인용이 0 이 된 URL 은 dim_url 정리). 키 = url_hash
#                   (= rd.dim_url.url_hash = sha256(url)). URL 원문에 btree 키를 걸면 2,704 바이트 상한을 넘는 인용 URL(stg 4차 3,160 바이트)이
#                   적재 트랜잭션 전체를 실패시킨다(bulk seed-30 §11 _u 도 해시 키 + url hash 색인)
#   _ig_prior_ent   바뀐 job 의 언급·스탠스 엔티티 ∪ 다시 쓰는 ACR prompt-run 의 옛 롤업 엔티티(dim_entity 재계산 대상,
#                   행이 0 이 된 엔티티는 dim_entity 정리). 롤업 쪽은 capture_prior_acr 가 채운다(sync _write_acr 가 지우기 직전)
#   _ig_prior_name  바뀐 job 의 Brand 언급 엔티티의 옛 대표 표기(전 행 기준, 지우기 전 값)
PRIOR_MAKE = """
CREATE TEMP TABLE IF NOT EXISTS _ig_prior_url (url_hash bytea PRIMARY KEY, url text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE IF NOT EXISTS _ig_prior_ent (entity_id uuid PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE IF NOT EXISTS _ig_prior_name (entity_id uuid PRIMARY KEY, brand text) ON COMMIT DROP;
"""
PRIOR_URLS = """
INSERT INTO _ig_prior_url (url_hash, url)
SELECT DISTINCT sha256(convert_to(c.url, 'UTF8')), c.url FROM ing.answer_key_map k JOIN ing.citation c ON c.run_month = k.run_month AND c.job_id = k.job_id
 WHERE k.answer_key = ANY($1::int4[]) AND c.url IS NOT NULL
ON CONFLICT DO NOTHING
"""
PRIOR_ENTS = """
INSERT INTO _ig_prior_ent
SELECT DISTINCT e FROM (
  SELECT m.entity_id AS e FROM ing.answer_key_map k JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = k.job_id
   WHERE k.answer_key = ANY($1::int4[])
  UNION SELECT s.entity_id FROM ing.answer_key_map k JOIN ing.answer_stance s ON s.run_month = k.run_month AND s.job_id = k.job_id
   WHERE k.answer_key = ANY($1::int4[])) x
 WHERE e IS NOT NULL
ON CONFLICT DO NOTHING
"""
# 다시 쓰는 ACR prompt-run 의 옛 롤업 엔티티(결함 N1). 대상 prompt-run 은 옛 source_job_ids 로 추정하지 않고 _write_acr 가 실제로 다시 쓰는
# 목록(이번 load 스테이지 payload 중 job_ids 가 바뀐 job 과 겹치는 것)을 그대로 받는다: 반복 job 이 새로 붙어 롤업이 바뀌면
# 옛 source_job_ids 에 바뀐 job 이 없어도 롤업 행이 지워진다.
PRIOR_ACR_ENTS = """
INSERT INTO _ig_prior_ent
SELECT DISTINCT r.entity_id FROM ing.acr_rollup_row r WHERE r.prompt_run_id = ANY($1::uuid[]) AND r.entity_id IS NOT NULL
ON CONFLICT DO NOTHING
"""
# 대표 표기 선택 규칙은 PAIRS 의 _ig_names 와 같다(라틴 우선·사전순, 그 엔티티의 전 Brand 언급). 먼저 잡은 값(더 옛 상태)을 유지한다.
PRIOR_NAMES = """
INSERT INTO _ig_prior_name (entity_id, brand)
SELECT DISTINCT ON (entity_id) entity_id, display_name
  FROM (SELECT DISTINCT m.entity_id, m.display_name FROM ing.mention m
         WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
           AND m.entity_id IN (SELECT m2.entity_id FROM ing.answer_key_map k
                                 JOIN ing.mention m2 ON m2.run_month = k.run_month AND m2.job_id = k.job_id
                                WHERE k.answer_key = ANY($1::int4[]) AND m2.entity_type = 'Brand' AND m2.display_name IS NOT NULL)
         UNION SELECT b.entity_id, b.display_name FROM ing.entity_brand_name b
          WHERE current_setting('hgh.legacy_name', true) = '1'
            AND b.entity_id IN (SELECT m2.entity_id FROM ing.answer_key_map k
                                  JOIN ing.mention m2 ON m2.run_month = k.run_month AND m2.job_id = k.job_id
                                 WHERE k.answer_key = ANY($1::int4[]) AND m2.entity_type = 'Brand' AND m2.display_name IS NOT NULL)) x
 ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC, display_name/*name_coll*/
ON CONFLICT DO NOTHING
"""
PRIOR_CLEAR = "TRUNCATE _ig_prior_url, _ig_prior_ent, _ig_prior_name"

# 회차 귀속(R02) 코호트: 바뀐 job 의 run 과 같은 (프로젝트, run 앵커) 코호트의 run 전부를 다시 판정한다.
# seed-40 §2 _run_c 와 같은 식(코호트 범위만 좁힘). cohort 문자열은 TimeZone UTC 세션에서 만든다(시드와 같음).
# 현행 프로필 resub_phantom_exclude(RESUB, WU-3b, 투영 스위치): 끝의 UPDATE 가 답변 회차를 run 의 원장 멤버십(ing.cycle_run)으로 되돌린다.
#   현행 앵커 표 scope_answer_cycle_anchors.cycle_id = summary_cycle_runs.cycle_id(0078 refresh_answer_cycle_anchors run_ctx :821-845, run 수준 값), 사실표 생성기도(cycle.ts:316-323)
#   회차의 멤버 run 만 읽는다. 코호트 규칙(pin → 원장 선택)은 앵커 날짜(anchor_src·좌석 근거)에만 쓰인다. stg hmg_r2 2026-10-01 전수:
#   앵커 표 행이 있는 답변 전부에서 cycle_id = run 멤버십, 허브 코호트 회차와 다른 답변 13,853건(pin 13,814 + 재제출 유령 회차 39).
#   예외: 코호트에 운영자 pin(origin 'operator', 이관 뒤 관리 API)이 있고 그 pin 이 회차로 풀리면 허브 pin 규칙을 유지한다(관리 동작 보존).
#   표식 /*attrib_member*/false 는 runc_sql 이 프로필에 따라 true 로 바꾼다(시드는 psql 변수 attrib_member, 같은 값이어야 한다).
ATTRIB_MARK = "/*attrib_member*/false"
RUNC = """
DROP TABLE IF EXISTS _ig_runc;
CREATE TEMP TABLE _ig_runc ON COMMIT DROP AS
WITH seed_runs AS (
  SELECT DISTINCT a.run_id FROM ing.answer_key_map k JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
   WHERE k.answer_key IN (SELECT answer_key FROM _ig_s)
  UNION SELECT run_id FROM ing.acr_prompt_run WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr_extra)
  UNION SELECT run_id FROM _ig_xruns),
r AS (
  SELECT x.run_id, x.run_key, x.scope_project_id, x.status, x.cycle_anchor_at,
         x.scope_project_id::text || '|' || coalesce(x.cycle_anchor_at::text, 'run:' || x.run_id::text) AS cohort
    FROM ing.run x
   WHERE x.run_id IN (SELECT run_id FROM seed_runs)
      OR (x.cycle_anchor_at IS NOT NULL AND (x.scope_project_id, x.cycle_anchor_at) IN
            (SELECT y.scope_project_id, y.cycle_anchor_at FROM ing.run y WHERE y.run_id IN (SELECT run_id FROM seed_runs) AND y.cycle_anchor_at IS NOT NULL))),
coh_grp AS (
  SELECT r.cohort, c.cyc_key, c.origin, c.anchor_source, c.cycle_anchor_at,
         count(DISTINCT r.run_id) AS runs,
         bool_or(c.cycle_anchor_at IS NOT DISTINCT FROM r.cycle_anchor_at) AS matches_run
    FROM r JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle c ON c.cycle_id = cr.cycle_id
   GROUP BY r.cohort, c.cyc_key, c.origin, c.anchor_source, c.cycle_anchor_at),
coh AS (
  SELECT DISTINCT ON (g.cohort) g.cohort, g.cyc_key, g.origin, g.anchor_source
    FROM coh_grp g
   ORDER BY g.cohort, (g.origin = 'summary_cycles') DESC, g.matches_run DESC, g.runs DESC, g.cycle_anchor_at, g.cyc_key),
pin AS (
  SELECT r.cohort, r.scope_project_id, min(p.anchor) AS pin_anchor, bool_or(p.origin = 'operator') AS op_pin
    FROM r JOIN ing.answer a ON a.run_id = r.run_id AND a.status = 'completed'
    JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
   GROUP BY r.cohort, r.scope_project_id),
pc AS (
  SELECT pin.cohort, pin.pin_anchor, pin.op_pin, coalesce(
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id AND c.origin = 'summary_cycles'
               AND (c.cycle_anchor_at AT TIME ZONE 'UTC')::date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1),
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id AND c.origin = 'summary_cycles'
               AND c.anchor_date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1),
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id
               AND c.anchor_date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1)) AS pin_cyc
    FROM pin)
SELECT r.run_id, r.run_key, r.scope_project_id, r.status AS run_status,
       coalesce(pc.pin_cyc, coh.cyc_key) AS cyc_key,
       (CASE WHEN pc.pin_cyc IS NOT NULL THEN 1
             WHEN coh.origin = 'summary_cycles' THEN 2
             WHEN coh.anchor_source = 'scope' THEN 3
             WHEN coh.anchor_source = 'derived' THEN 4
             WHEN coh.anchor_source = 'operator' THEN 5 END)::int2 AS anchor_src,
       (pc.pin_anchor IS NOT NULL AND pc.pin_cyc IS NULL) AS pin_unresolved,
       (coalesce(pc.op_pin, false) AND pc.pin_cyc IS NOT NULL) AS op_pin_kept
  FROM r LEFT JOIN coh ON coh.cohort = r.cohort LEFT JOIN pc ON pc.cohort = r.cohort;
CREATE UNIQUE INDEX ON _ig_runc (run_id);
UPDATE _ig_runc rc SET cyc_key = m.cyc_key
  FROM ing.cycle_run cr JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE /*attrib_member*/false AND cr.run_id = rc.run_id AND NOT rc.op_pin_kept AND rc.cyc_key IS DISTINCT FROM m.cyc_key;
"""


def runc_sql(profile=None) -> str:
    """RUNC 를 프로필(기본 = 적재기 활성 프로필)에 맞춘 문장. resub_phantom_exclude 가 켜지면 표식 조건을 참으로(답변 회차 = run 원장 멤버십)."""
    from app.core.profile import active_profile

    p = profile if profile is not None else active_profile()
    return RUNC.replace(ATTRIB_MARK, "/*attrib_member*/true") if p.resub_phantom_exclude else RUNC
RUNC_UNATTRIBUTED = "SELECT count(*) FROM _ig_runc WHERE cyc_key IS NULL"
RUNC_PIN_UNRESOLVED = "SELECT count(*) FROM _ig_runc WHERE pin_unresolved"
# 투영된 job 의 회차·anchor_src 가 새 판정과 다른 run(좌석·귀속 이동) → 그 run 의 job 전부를 다시 투영
RUNC_MOVED_KEYS = """
SELECT j.answer_key FROM rd.job j JOIN _ig_runc rc ON rc.run_key = j.run_key
 WHERE j.cyc_key IS DISTINCT FROM rc.cyc_key
    OR EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
                AND a.anchor_src IS DISTINCT FROM rc.anchor_src)
"""
# ACR run-셀 형제(acr_iter_rank 는 run-셀 안 순번: R13·A15)
SIBLING_KEYS = """
SELECT DISTINCT k2.answer_key
  FROM _ig_s s JOIN ing.answer_key_map k ON k.answer_key = s.answer_key
  JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
  JOIN ing.answer b ON b.run_id = a.run_id AND b.prompt_id IS NOT DISTINCT FROM a.prompt_id AND b.target = a.target
                   AND b.region IS NOT DISTINCT FROM a.region
  JOIN ing.answer_key_map k2 ON k2.job_id = b.job_id
 WHERE NOT EXISTS (SELECT 1 FROM _ig_s x WHERE x.answer_key = k2.answer_key)
"""

JOBS = """
DROP TABLE IF EXISTS _ig_jobs;
CREATE TEMP TABLE _ig_jobs ON COMMIT DROP AS
SELECT a.answer_key, a.job_id, a.run_month, a.run_id, a.prompt_id, a.target, a.region, a.status, a.measured_at,
       a.analysis_status, a.n_mentions, a.n_citations
  FROM _ig_s s JOIN ing.answer_key_map k ON k.answer_key = s.answer_key
  JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id;
CREATE UNIQUE INDEX ON _ig_jobs (answer_key);
CREATE INDEX ON _ig_jobs (run_month, job_id);
ANALYZE _ig_jobs;
"""
# 바뀐 job(_ig_s0) 만
JOBS0 = """
DROP TABLE IF EXISTS _ig_jobs0;
CREATE TEMP TABLE _ig_jobs0 ON COMMIT DROP AS SELECT j.* FROM _ig_jobs j WHERE j.answer_key IN (SELECT answer_key FROM _ig_s0);
CREATE INDEX ON _ig_jobs0 (run_month, job_id);
"""
# 이 적재가 다룰 ACR prompt-run: _ig_s run 의 prompt-run ∪ 이름 영향 prompt-run
ACR_SCOPE = """
DROP TABLE IF EXISTS _ig_pr;
CREATE TEMP TABLE _ig_pr ON COMMIT DROP AS
SELECT prompt_run_id FROM ing.acr_prompt_run WHERE run_id IN (SELECT run_id FROM _ig_jobs UNION SELECT run_id FROM _ig_xruns)
UNION SELECT prompt_run_id FROM _ig_pr_extra;
CREATE UNIQUE INDEX ON _ig_pr (prompt_run_id);
"""

# ── 1. 차원(수동 int2 키: max+1, NS_DIM 잠금 아래. 재번호 금지) ─────────────────
DIM_ENGINE = """
WITH dflt AS (SELECT jsonb_array_elements_text(value) AS code FROM app.rule_param WHERE key = 'default_engines'),
e AS (SELECT DISTINCT target AS code FROM _ig_jobs
      UNION SELECT target FROM ing.acr_prompt_run WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr))
INSERT INTO rd.dim_engine (engine_key, code, is_default)
SELECT ((SELECT coalesce(max(engine_key), 0) FROM rd.dim_engine) + row_number() OVER (ORDER BY e.code))::int2, e.code,
       e.code IN (SELECT code FROM dflt)
  FROM e WHERE coalesce(e.code, '') <> '' AND NOT EXISTS (SELECT 1 FROM rd.dim_engine d WHERE d.code = e.code)
"""
# seed-30 §2 와 같은 kind·권역·숨김 판정. 코드 원천은 이 적재의 답변 region·ACR region·웹사이트 프롬프트 사이트 국가
COUNTRY_CODES = """
SELECT DISTINCT region AS code FROM _ig_jobs WHERE region IS NOT NULL
UNION SELECT region FROM ing.acr_prompt_run WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr) AND region IS NOT NULL
UNION SELECT w.country_code FROM _wp_pick w WHERE w.scope_prompt_id IN (SELECT prompt_id FROM _ig_jobs)
"""
# app 유래 국가 코드(seed-30 §2 원천 중 app 쪽): 프로젝트 등록·웹사이트 카탈로그 재판정 때
APP_COUNTRY_CODES = """
SELECT country_code FROM app.website_site UNION SELECT geo_code FROM app.owned_base WHERE geo_code IS NOT NULL
UNION SELECT country_code FROM app.rhq_region_country UNION SELECT country_code FROM app.hidden_market UNION SELECT country_code FROM app.project
UNION SELECT code FROM _r_virtual_geo
"""
# 대소문자만 다른 코드는 같은 국가다(core.codes 조회는 upper 키, 중복이면 load_refs 가 거부해 전 요청이 500: 검증 관찰).
# 정본 표기 = 적재 순서와 무관한 규칙(검증 F1): 그 upper 묶음의 변형(이번 입력 ∪ 기존 행 ∪ 지금 app 원천의 같은 묶음 표기, 검증 F3) 중 CANON_ORDER 최선.
#   app 원천 표기를 늘 후보에 넣으므로 app 이 바뀐 뒤 어느 경로로 적재해도 bulk(app 원천 전부를 본다)와 같다. app 변경 재판정(hidden_market·
#   owned_base·프로젝트 설정)도 APP 병합을 돌려 답변이 오기 전의 기존 행 표기까지 맞춘다(rejudge).
#   CANON_ORDER = 정확히 같은 표기가 있는 app 원천의 권위 순위(웹사이트 사이트 1 → 가상 브랜드 코드 2 → RHQ 국가 3 → 프로젝트 4 → owned base 5
#   → 숨김 시장 6 → 없음 7, 웹사이트 사이트 표기가 front 리터럴 정본) → 대문자 표기 → 코드(COLLATE "C") 오름차순. 원천끼리 표기가 갈려도 동률이 없다.
#   키가 변형 자신과 app 원천만의 함수라 '최선' 은 결합법칙을 만족한다: best(best(A) ∪ B) = best(A ∪ B). 기존 행은 이전 입력들의 best 이므로
#   몇 번에 나눠 어떤 순서로 적재해도 결과 = 전체 입력을 한 번에 본 bulk(seed-30 §2, 같은 CANON_ORDER). 전제: 두 적재 사이 app 원천 불변.
# 기존 행의 표기가 새 승자와 다르면 code·kind·region_key·virtual_brand_bit 를 고쳐 쓴다(geo_key 유지: rd.dim_country 를 참조하는 FK 는 없고
# 사실 행은 geo_key 로만 잇는다). hidden_standard 는 upper 비교라 표기와 무관하고 기존 행은 재판정 HIDDEN_REFRESH 가 소유한다(바뀐 geo 의
# 답변을 다시 투영해야 하므로 여기서 조용히 고치지 않는다). 조회 조인·숨김 시장·가상 코드 판정도 전부 upper 등치(검증 F2).
# DB 는 rd.dim_country (upper(code)) 유일 색인(DB-v2.10 P65)으로 중복을 막는다.
CANON_ORDER = """CASE WHEN EXISTS (SELECT 1 FROM app.website_site w WHERE w.country_code = {x}) THEN 1
                  WHEN EXISTS (SELECT 1 FROM _r_virtual_geo v WHERE v.code = {x}) THEN 2
                  WHEN EXISTS (SELECT 1 FROM app.rhq_region_country r WHERE r.country_code = {x}) THEN 3
                  WHEN EXISTS (SELECT 1 FROM app.project p WHERE p.country_code = {x}) THEN 4
                  WHEN EXISTS (SELECT 1 FROM app.owned_base o WHERE o.geo_code = {x}) THEN 5
                  WHEN EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.country_code = {x}) THEN 6 ELSE 7 END,
             ({x} = upper({x})) DESC, {x} COLLATE "C"
"""
DIM_COUNTRY = """
WITH c AS (SELECT DISTINCT x AS code FROM unnest($1::text[]) x WHERE coalesce(x, '') <> ''),
cand AS (SELECT code FROM c
         UNION SELECT d.code FROM rd.dim_country d WHERE d.code <> '' AND upper(d.code) IN (SELECT upper(code) FROM c)
         UNION SELECT a.code FROM (""" + APP_COUNTRY_CODES.replace("SELECT country_code FROM app.website_site", "SELECT country_code AS code FROM app.website_site", 1) + """) a
                WHERE coalesce(a.code, '') <> '' AND upper(a.code) IN (SELECT upper(code) FROM c)),
win AS (SELECT DISTINCT ON (upper(x.code)) x.code FROM cand x ORDER BY upper(x.code), """ + CANON_ORDER.format(x="x.code") + """),
attr AS (
  SELECT w.code, ir.region,
         CASE WHEN v.code IS NOT NULL THEN 'virtual_brand' WHEN w.code ~ '^[A-Z]{2}$' THEN 'iso' ELSE 'pseudo' END AS kind,
         vb.brand_bit AS vbit,
         EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global' AND upper(h.country_code) = upper(w.code)) AS hid
    FROM win w
    LEFT JOIN _r_virtual_geo v ON upper(v.code) = upper(w.code)
    LEFT JOIN app.brand vb ON vb.brand_code = v.brand_code
    LEFT JOIN _r_iso_region ir ON ir.iso = CASE WHEN w.code ~ '^[A-Z]{2}(-|$)' THEN left(w.code, 2) END),
reg AS (
  INSERT INTO rd.dim_region (region_key, code)
  SELECT ((SELECT coalesce(max(region_key), 0) FROM rd.dim_region) + row_number() OVER (ORDER BY r.region))::int2, r.region
    FROM (SELECT DISTINCT a.region FROM attr a
           WHERE a.region IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rd.dim_region g WHERE g.code = a.region)) r
  RETURNING region_key, code),
upd AS (
  UPDATE rd.dim_country d
     SET code = a.code, kind = a.kind, region_key = coalesce(rg.region_key, ng.region_key), virtual_brand_bit = a.vbit
    FROM attr a
    LEFT JOIN rd.dim_region rg ON rg.code = a.region
    LEFT JOIN reg ng ON ng.code = a.region
   WHERE upper(d.code) = upper(a.code) AND d.code <> a.code
  RETURNING d.geo_key)
INSERT INTO rd.dim_country (geo_key, code, region_key, kind, virtual_brand_bit, hidden_standard)
SELECT ((SELECT coalesce(max(geo_key), 0) FROM rd.dim_country) + row_number() OVER (ORDER BY a.code COLLATE "C"))::int2, a.code,
       coalesce(rg.region_key, ng.region_key), a.kind, a.vbit, a.hid
  FROM attr a
  LEFT JOIN rd.dim_region rg ON rg.code = a.region
  LEFT JOIN reg ng ON ng.code = a.region
 WHERE NOT EXISTS (SELECT 1 FROM rd.dim_country d WHERE upper(d.code) = upper(a.code))
"""
NEW_PROMPTS = """
DROP TABLE IF EXISTS _ig_np;
CREATE TEMP TABLE _ig_np ON COMMIT DROP AS
SELECT DISTINCT x.prompt_id FROM (
  SELECT prompt_id FROM _ig_jobs WHERE prompt_id IS NOT NULL
  UNION SELECT prompt_id FROM ing.acr_prompt_run WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr) AND prompt_id IS NOT NULL
  UNION SELECT prompt_id FROM _ig_xprompts) x
 WHERE NOT EXISTS (SELECT 1 FROM rd.dim_prompt p WHERE p.prompt_id = x.prompt_id);
"""
DIM_LANG = """
WITH l AS (
  SELECT lower(lang) AS code FROM ing.prompt WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np) AND coalesce(lang, '') <> ''
  UNION SELECT lower(lang_code) FROM app.website_prompt WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np) AND coalesce(lang_code, '') <> ''
  UNION SELECT lower(lang) FROM app.prompt WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np) AND coalesce(lang, '') <> '')
INSERT INTO rd.dim_lang (lang_key, code)
SELECT ((SELECT coalesce(max(lang_key), 0) FROM rd.dim_lang) + row_number() OVER (ORDER BY l.code))::int2, l.code
  FROM l WHERE NOT EXISTS (SELECT 1 FROM rd.dim_lang d WHERE d.code = l.code)
"""
# seed-30 §4: 표면 = 커서 → 원장 회차 → 규칙(웹사이트 사이트 → 표준 루트 → project). $1 = scope project id 목록(없는 것만 발급)
DIM_PROJECT = """
WITH k AS (SELECT DISTINCT unnest($1::uuid[]) AS scope_project_id),
nk AS (SELECT k.scope_project_id FROM k WHERE k.scope_project_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM rd.dim_project d WHERE d.scope_project_id = k.scope_project_id)),
s AS (
  SELECT nk.scope_project_id,
         coalesce(sc.surface,
                  (SELECT c.surface FROM ing.cycle c WHERE c.scope_project_id = nk.scope_project_id ORDER BY c.cycle_anchor_at DESC LIMIT 1),
                  CASE WHEN EXISTS (SELECT 1 FROM app.website_site w WHERE w.scope_project_id = nk.scope_project_id) THEN 'website'
                       WHEN EXISTS (SELECT 1 FROM app.project p WHERE p.scope_project_id = nk.scope_project_id AND p.kind = 'standard_root') THEN 'global'
                       ELSE 'project' END) AS surface_txt,
         sc.regions
    FROM nk LEFT JOIN ing.sync_cursor sc ON sc.scope_project_id = nk.scope_project_id)
INSERT INTO rd.dim_project (project_key, scope_project_id, surface, is_root, project_id, site_id, site_brand_bit, site_geo_key, regions)
SELECT ((SELECT coalesce(max(project_key), 0) FROM rd.dim_project) + row_number() OVER (ORDER BY sf, s.scope_project_id))::int2,
       s.scope_project_id, sf,
       (sf = 1 AND coalesce(p.kind = 'standard_root', false)), p.project_id, w.site_id,
       coalesce(wb.brand_bit, 0), coalesce(g.geo_key, 0), s.regions
  FROM s
  CROSS JOIN LATERAL (SELECT (CASE s.surface_txt WHEN 'global' THEN 1 WHEN 'website' THEN 2 ELSE 3 END)::int2 AS sf) x
  LEFT JOIN app.project p ON p.scope_project_id = s.scope_project_id
  LEFT JOIN app.website_site w ON w.scope_project_id = s.scope_project_id
  LEFT JOIN app.brand wb ON wb.brand_code = w.brand_code
  LEFT JOIN rd.dim_country g ON upper(g.code) = upper(w.country_code)
"""
# seed-30 §7 을 새 프롬프트(_ig_np)로 좁힘. unit_key 는 이미 투영된 rd.web_unit 에서 찾는다(웹사이트 카탈로그 변경은 'website_catalog' 재판정).
DIM_PROMPT = """
WITH by_ans AS (
  SELECT DISTINCT ON (a.prompt_id) a.prompt_id, r.scope_project_id
    FROM ing.answer a JOIN ing.run r ON r.run_id = a.run_id WHERE a.prompt_id IN (SELECT prompt_id FROM _ig_np)
   GROUP BY 1, 2 ORDER BY a.prompt_id, count(*) DESC, r.scope_project_id),
by_app AS (
  SELECT DISTINCT ON (p.scope_prompt_id) p.scope_prompt_id, pr.scope_project_id
    FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id
   WHERE p.scope_prompt_id IN (SELECT prompt_id FROM _ig_np) AND pr.scope_project_id IS NOT NULL
   ORDER BY p.scope_prompt_id, (p.deleted_at IS NOT NULL), (pr.kind <> 'standard_root'), p.updated_at DESC),
pp AS (
  SELECT i.prompt_id, coalesce(ip.scope_project_id, ba.scope_project_id, wpk.site_scope_project_id, bp.scope_project_id) AS scope_project_id
    FROM _ig_np i
    LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = i.prompt_id
    LEFT JOIN by_ans ba ON ba.prompt_id = i.prompt_id
    LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = i.prompt_id
    LEFT JOIN by_app bp ON bp.scope_prompt_id = i.prompt_id),
app_kind AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, kind, text FROM app.prompt
              WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np) ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC),
app_lang AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, lang FROM app.prompt
              WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np) AND coalesce(lang, '') <> ''
              ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC),
acr_pids AS (SELECT DISTINCT prompt_id FROM ing.acr_prompt_run WHERE prompt_id IN (SELECT prompt_id FROM _ig_np)),
funnel AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, funnel_stage FROM app.prompt
            WHERE scope_prompt_id IN (SELECT prompt_id FROM _ig_np)
            ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), (coalesce(funnel_stage, '') = ''), updated_at DESC),
root_cat AS (SELECT p.* FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
              WHERE p.scope_prompt_id IN (SELECT prompt_id FROM _ig_np)),
-- cat_mask·in_root_catalog = 비삭제 행만, cat_mask_all·in_root_catalog_all = 삭제 행 포함(DB-v2.15 P88, A41 현행 CAT_CTE). 한 집계로 둘 다
cat_bits AS (SELECT c.scope_prompt_id,
                    bit_or(coalesce(b.brand_bit, u.brand_bit)) FILTER (WHERE c.deleted_at IS NULL)::int2 AS cat_mask,
                    bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS cat_mask_all
               FROM root_cat c LEFT JOIN app.brand b ON b.brand_code = c.brand_code
               CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u GROUP BY 1),
unit_of AS (
  SELECT DISTINCT ON (wp.scope_prompt_id) wp.scope_prompt_id, wu.unit_key
    FROM app.website_prompt wp JOIN app.website_site s ON s.site_id = wp.site_id
    LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = wp.scope_prompt_id
    JOIN rd.dim_project dp ON dp.scope_project_id = coalesce(s.scope_project_id, ip.scope_project_id)
    JOIN rd.web_unit wu ON wu.project_key = dp.project_key AND wu.file_seq = wp.file_seq AND wu.base IS NOT NULL
   WHERE wp.scope_prompt_id IN (SELECT prompt_id FROM _ig_np)
   ORDER BY wp.scope_prompt_id, wu.base, wp.file_seq, wp.site_id)
INSERT INTO rd.dim_prompt (prompt_id, surface, project_key, kind, text, lang_key, cat_mask, in_root_catalog, funnel_key,
                           unit_key, targets, web_reg, regions, is_korean, rule_ver, cat_mask_all, in_root_catalog_all)
SELECT pp.prompt_id, dp.surface, dp.project_key,
       coalesce(CASE WHEN ip.kind IN ('single', 'acr') THEN ip.kind END, ak.kind, CASE WHEN ap.prompt_id IS NOT NULL THEN 'acr' END, 'single'),
       coalesce(ip.text, ak.text, (SELECT w.prompt_text FROM app.website_prompt w WHERE w.scope_prompt_id = pp.prompt_id
                                    ORDER BY w.file_seq, w.site_id LIMIT 1)),
       coalesce(l.lang_key, 0), coalesce(cb.cat_mask, 0), cb.cat_mask IS NOT NULL, coalesce(tf.taxon_key, 0), uo.unit_key,
       coalesce((SELECT array_agg(DISTINCT n ORDER BY n) FROM (
                  SELECT nullif(pg_temp.cit_norm(coalesce(w.target_url, '')), '') AS n FROM app.website_prompt w
                   WHERE w.scope_prompt_id = pp.prompt_id) t WHERE n IS NOT NULL), '{}'),
       EXISTS (SELECT 1 FROM app.website_prompt w WHERE w.scope_prompt_id = pp.prompt_id),
       ip.regions, coalesce(ip.text ~ '[가-힣]', false), $1, coalesce(cb.cat_mask_all, 0), cb.scope_prompt_id IS NOT NULL
  FROM pp
  JOIN rd.dim_project dp ON dp.scope_project_id = pp.scope_project_id
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = pp.prompt_id
  LEFT JOIN app_kind ak ON ak.scope_prompt_id = pp.prompt_id
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = pp.prompt_id
  LEFT JOIN app_lang al ON al.scope_prompt_id = pp.prompt_id
  LEFT JOIN rd.dim_lang l ON l.code = CASE WHEN dp.surface = 2 THEN wpk.lang_code ELSE lower(coalesce(nullif(ip.lang, ''), al.lang)) END
  LEFT JOIN acr_pids ap ON ap.prompt_id = pp.prompt_id
  LEFT JOIN cat_bits cb ON cb.scope_prompt_id = pp.prompt_id
  LEFT JOIN funnel fu ON fu.scope_prompt_id = pp.prompt_id
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = fu.funnel_stage
  LEFT JOIN unit_of uo ON uo.scope_prompt_id = pp.prompt_id
 ORDER BY dp.surface, dp.project_key, pp.prompt_id
"""
# 기존 dim_prompt 재판정(Scope 프롬프트 속성·카탈로그 변경: 'scope_prompt'·'catalog'·'prompt_kind'·'website_catalog')
#   = 위와 같은 식으로 계산해 UPDATE. _ig_rp(prompt_id) 가 대상.
DIM_PROMPT_REFRESH = """
WITH ids AS (SELECT prompt_id FROM _ig_rp),
app_kind AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, kind, text FROM app.prompt
              WHERE scope_prompt_id IN (SELECT prompt_id FROM ids) ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC),
app_lang AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, lang FROM app.prompt
              WHERE scope_prompt_id IN (SELECT prompt_id FROM ids) AND coalesce(lang, '') <> ''
              ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), updated_at DESC),
acr_pids AS (SELECT DISTINCT prompt_id FROM ing.acr_prompt_run WHERE prompt_id IN (SELECT prompt_id FROM ids)),
funnel AS (SELECT DISTINCT ON (scope_prompt_id) scope_prompt_id, funnel_stage FROM app.prompt
            WHERE scope_prompt_id IN (SELECT prompt_id FROM ids)
            ORDER BY scope_prompt_id, (deleted_at IS NOT NULL), (coalesce(funnel_stage, '') = ''), updated_at DESC),
root_cat AS (SELECT p.* FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
              WHERE p.scope_prompt_id IN (SELECT prompt_id FROM ids)),
cat_bits AS (SELECT c.scope_prompt_id,
                    bit_or(coalesce(b.brand_bit, u.brand_bit)) FILTER (WHERE c.deleted_at IS NULL)::int2 AS cat_mask,
                    bit_or(coalesce(b.brand_bit, u.brand_bit))::int2 AS cat_mask_all
               FROM root_cat c LEFT JOIN app.brand b ON b.brand_code = c.brand_code
               CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u GROUP BY 1),
unit_of AS (
  SELECT DISTINCT ON (wp.scope_prompt_id) wp.scope_prompt_id, wu.unit_key
    FROM app.website_prompt wp JOIN app.website_site s ON s.site_id = wp.site_id
    LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = wp.scope_prompt_id
    JOIN rd.dim_project dp ON dp.scope_project_id = coalesce(s.scope_project_id, ip.scope_project_id)
    JOIN rd.web_unit wu ON wu.project_key = dp.project_key AND wu.file_seq = wp.file_seq AND wu.base IS NOT NULL
   WHERE wp.scope_prompt_id IN (SELECT prompt_id FROM ids)
   ORDER BY wp.scope_prompt_id, wu.base, wp.file_seq, wp.site_id),
nv AS (
  SELECT d.prompt_key,
         coalesce(CASE WHEN ip.kind IN ('single', 'acr') THEN ip.kind END, ak.kind, CASE WHEN ap.prompt_id IS NOT NULL THEN 'acr' END, 'single') AS kind,
         coalesce(ip.text, ak.text, (SELECT w.prompt_text FROM app.website_prompt w WHERE w.scope_prompt_id = d.prompt_id
                                      ORDER BY w.file_seq, w.site_id LIMIT 1)) AS text,
         coalesce(l.lang_key, 0)::int2 AS lang_key, coalesce(cb.cat_mask, 0)::int2 AS cat_mask, cb.cat_mask IS NOT NULL AS in_root_catalog,
         coalesce(cb.cat_mask_all, 0)::int2 AS cat_mask_all, cb.scope_prompt_id IS NOT NULL AS in_root_catalog_all,
         coalesce(tf.taxon_key, 0)::int2 AS funnel_key, uo.unit_key,
         coalesce((SELECT array_agg(DISTINCT n ORDER BY n) FROM (
                    SELECT nullif(pg_temp.cit_norm(coalesce(w.target_url, '')), '') AS n FROM app.website_prompt w
                     WHERE w.scope_prompt_id = d.prompt_id) t WHERE n IS NOT NULL), '{}') AS targets,
         EXISTS (SELECT 1 FROM app.website_prompt w WHERE w.scope_prompt_id = d.prompt_id) AS web_reg,
         ip.regions, coalesce(ip.text ~ '[가-힣]', false) AS is_korean
    FROM rd.dim_prompt d
    LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = d.prompt_id
    LEFT JOIN app_kind ak ON ak.scope_prompt_id = d.prompt_id
    LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = d.prompt_id
    LEFT JOIN app_lang al ON al.scope_prompt_id = d.prompt_id
    LEFT JOIN rd.dim_lang l ON l.code = CASE WHEN d.surface = 2 THEN wpk.lang_code ELSE lower(coalesce(nullif(ip.lang, ''), al.lang)) END
    LEFT JOIN acr_pids ap ON ap.prompt_id = d.prompt_id
    LEFT JOIN cat_bits cb ON cb.scope_prompt_id = d.prompt_id
    LEFT JOIN funnel fu ON fu.scope_prompt_id = d.prompt_id
    LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = fu.funnel_stage
    LEFT JOIN unit_of uo ON uo.scope_prompt_id = d.prompt_id
   WHERE d.prompt_id IN (SELECT prompt_id FROM ids))
UPDATE rd.dim_prompt d SET kind = nv.kind, text = nv.text, lang_key = nv.lang_key, cat_mask = nv.cat_mask, in_root_catalog = nv.in_root_catalog,
       funnel_key = nv.funnel_key, unit_key = nv.unit_key, targets = nv.targets, web_reg = nv.web_reg, regions = nv.regions,
       is_korean = nv.is_korean, rule_ver = $1, cat_mask_all = nv.cat_mask_all, in_root_catalog_all = nv.in_root_catalog_all
  FROM nv WHERE d.prompt_key = nv.prompt_key
   AND (d.kind, d.text, d.lang_key, d.cat_mask, d.in_root_catalog, d.funnel_key, d.unit_key, d.targets, d.web_reg, d.regions, d.is_korean,
        d.cat_mask_all, d.in_root_catalog_all)
       IS DISTINCT FROM (nv.kind, nv.text, nv.lang_key, nv.cat_mask, nv.in_root_catalog, nv.funnel_key, nv.unit_key, nv.targets, nv.web_reg,
                         nv.regions, nv.is_korean, nv.cat_mask_all, nv.in_root_catalog_all)
RETURNING d.prompt_key
"""

# ── 2. 표기 쌍(seed-3x-common §5·6 을 범위로 좁힘) ─────────────────────────────
# 원천 쌍: 이 적재 답변의 언급·스탠스, ACR 롤업 행, 차원을 다시 계산할 엔티티(_ig_ent_ids)의 전 언급·스탠스
ENT_IDS = """
DROP TABLE IF EXISTS _ig_ent_ids;
CREATE TEMP TABLE _ig_ent_ids ON COMMIT DROP AS
SELECT DISTINCT entity_id FROM (
  SELECT m.entity_id FROM ing.mention m JOIN _ig_jobs0 j ON j.run_month = m.run_month AND j.job_id = m.job_id
  UNION SELECT s.entity_id FROM ing.answer_stance s JOIN _ig_jobs0 j ON j.run_month = s.run_month AND j.job_id = s.job_id
  UNION SELECT r.entity_id FROM ing.acr_rollup_row r WHERE r.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)
  UNION SELECT entity_id FROM _ig_xents
  UNION SELECT entity_id FROM _ig_prior_ent) x
 WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX ON _ig_ent_ids (entity_id);
ANALYZE _ig_ent_ids;
"""
# 엔티티 버전(E1, seed-3x-common §6 과 같은 원천): 원본 쌍 × 버전(_ecat_vset) ∪ 관계 덮어쓰기 쌍(ovr, 덮어쓴 모 브랜드) ∪ 재매칭 언급 쌍(_ecat_hent).
#   legacy·v1 은 버전 1벌·덮어쓰기 0 이라 도입 전 표와 같다.
PAIR_SRC = """
DROP TABLE IF EXISTS _ig_psrc;
CREATE TEMP TABLE _ig_psrc ON COMMIT DROP AS
WITH raw AS (
  SELECT DISTINCT disp, rollup FROM (
    SELECT m.display_name AS disp, m.brand_rollup_entity_id AS rollup FROM ing.mention m
      JOIN _ig_jobs j ON j.run_month = m.run_month AND j.job_id = m.job_id WHERE m.brand_rollup_entity_id IS NOT NULL
    UNION SELECT s.brand_label, s.entity_id FROM ing.answer_stance s JOIN _ig_jobs j ON j.run_month = s.run_month AND j.job_id = s.job_id
    UNION SELECT entity_name, entity_id FROM ing.acr_rollup_row WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)
    UNION SELECT entity_name, brand_rollup_entity_id FROM ing.acr_rollup_row
           WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr) AND brand_rollup_entity_id IS NOT NULL
    UNION SELECT m.display_name, m.brand_rollup_entity_id FROM ing.mention m
           WHERE m.entity_id IN (SELECT entity_id FROM _ig_ent_ids) AND m.brand_rollup_entity_id IS NOT NULL
    UNION SELECT s.brand_label, s.entity_id FROM ing.answer_stance s WHERE s.entity_id IN (SELECT entity_id FROM _ig_ent_ids)) x),
ovr AS (
  SELECT x.ver, m.display_name AS disp, x.parent AS rollup FROM ing.mention m
    JOIN _ig_jobs j ON j.run_month = m.run_month AND j.job_id = m.job_id JOIN _ecat_x x ON x.entity_id = m.entity_id AND x.parent IS NOT NULL
  UNION SELECT x.ver, m.display_name, x.parent FROM ing.mention m JOIN _ecat_x x ON x.entity_id = m.entity_id AND x.parent IS NOT NULL
         WHERE m.entity_id IN (SELECT entity_id FROM _ig_ent_ids)
  UNION SELECT x.ver, a.entity_name, x.parent FROM ing.acr_rollup_row a JOIN _ecat_x x ON x.entity_id = a.entity_id AND x.parent IS NOT NULL
         WHERE a.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr))
SELECT v.ver, r.disp, r.rollup, false AS ovr FROM raw r CROSS JOIN _ecat_vset v
UNION SELECT ver, disp, rollup, true FROM ovr
UNION SELECT ver, disp, rollup, ovr FROM _ecat_hent WHERE rollup IS NOT NULL;
"""
# rid(J1) → 대표 표기(names) → 표시명(J2)·bare·경쟁(J3). names 는 필요한 엔티티만, 그 엔티티의 전 Brand 언급에서(시드와 같은 전역 값)
PAIRS = """
DROP TABLE IF EXISTS _ig_pfx;
CREATE TEMP TABLE _ig_pfx ON COMMIT DROP AS
SELECT d.disp, pg_temp.hmg_prefix_id(d.disp) AS pfx_id FROM (SELECT DISTINCT disp FROM _ig_psrc WHERE disp IS NOT NULL) d;
DROP TABLE IF EXISTS _ig_rid;
CREATE TEMP TABLE _ig_rid ON COMMIT DROP AS
SELECT s.ver, s.disp, s.rollup, s.ovr,
       CASE WHEN s.ovr THEN coalesce(am.canon_id, s.rollup) ELSE coalesce(p.pfx_id, am.canon_id, s.rollup) END AS rid
  FROM _ig_psrc s LEFT JOIN _ig_pfx p ON p.disp = s.disp LEFT JOIN _alias_map am ON am.ver = s.ver AND am.alias_id = s.rollup;
DROP TABLE IF EXISTS _ig_nid;
CREATE TEMP TABLE _ig_nid ON COMMIT DROP AS
SELECT DISTINCT e AS entity_id FROM (
  SELECT rid AS e FROM _ig_rid
  UNION SELECT entity_id FROM ing.acr_rollup_row WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)
  UNION SELECT brand_rollup_entity_id FROM ing.acr_rollup_row WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)
  UNION SELECT parent FROM _ecat_x WHERE parent IS NOT NULL
  UNION SELECT entity_id FROM _ig_ent_ids) x WHERE e IS NOT NULL;
CREATE UNIQUE INDEX ON _ig_nid (entity_id);
DROP TABLE IF EXISTS _ig_names;
CREATE TEMP TABLE _ig_names ON COMMIT DROP AS
SELECT DISTINCT ON (entity_id) entity_id, display_name AS brand
  FROM (SELECT DISTINCT m.entity_id, m.display_name FROM ing.mention m
         WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL AND m.entity_id IN (SELECT entity_id FROM _ig_nid)
         UNION SELECT b.entity_id, b.display_name FROM ing.entity_brand_name b
          WHERE current_setting('hgh.legacy_name', true) = '1' AND b.entity_id IN (SELECT entity_id FROM _ig_nid)) m
 ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC, display_name/*name_coll*/;
CREATE UNIQUE INDEX ON _ig_names (entity_id);
DROP TABLE IF EXISTS _ig_pairs;
CREATE TEMP TABLE _ig_pairs ON COMMIT DROP AS
WITH n AS (
  SELECT r.*, pg_temp.canon_brand(coalesce(nm.brand, r.disp)) AS name
    FROM _ig_rid r LEFT JOIN _ig_names nm ON nm.entity_id = r.rid),
b AS (SELECT n.*, coalesce(pg_temp.name_key(n.name), '') AS bare FROM n)
SELECT b.ver, b.disp, b.rollup, b.ovr, b.rid, b.name, b.bare, coalesce(ro.bit, 0::int2) AS rid_bit,
       pg_temp.brand_competitive(lower(pg_temp.js_trim(b.bare)), b.disp) AS competitive,
       coalesce(b.disp, '') AS dkey, (b.disp IS NULL) AS dnull
  FROM b LEFT JOIN _roster ro ON ro.ver = b.ver AND ro.entity_id = b.rid;
-- 표시명 키는 md5 로 접어 색인한다(값 비교·조인은 원문 dkey): Scope 표시명은 길이 보장이 없어 원문 btree 키는 2,704 바이트 상한을 넘을 수 있다
-- (be/int3-longkey, 검증 D''. 같은 유형 = _ig_prior_url). seed-3x-common §6 _bn_pair 와 같은 규칙
CREATE UNIQUE INDEX ON _ig_pairs (ver, md5(dkey), dnull, rollup, ovr);
CREATE INDEX ON _ig_pairs USING hash (dkey);                    -- 원문 등치 조회(해시 색인은 키 길이 상한 없음)
ANALYZE _ig_pairs, _ig_names;
"""
# seed-3x-common §8 을 _ig_pr 로 좁힘
# 엔티티 버전(E1): 버전마다 한 벌(ver). 제거 엔티티 행 dropped, 관계 덮어쓰기 = 롤업을 모 브랜드로·parent_name 을 비움(모 브랜드 표기 names),
#   롤업 대상 제거면 롤업·parent_name 을 비움. 사실 행은 prompt-run 버전(_ig_acr.ecat_ver)의 행으로 붙는다(seed-3x-common §8 과 같은 식).
ACR_NM = """
DROP TABLE IF EXISTS _ig_acr_nm;
CREATE TEMP TABLE _ig_acr_nm ON COMMIT DROP AS
WITH x0 AS (
  SELECT v.ver, a.prompt_run_id, a.entity_id, a.rollup_level, a.entity_name, a.parent_name, a.brand_rollup_entity_id AS rollup_raw,
         xe.parent, coalesce(xe.removed, false) AS dropped, coalesce(a.entity_name, n.brand) AS nm
    FROM ing.acr_rollup_row a CROSS JOIN _ecat_vset v
    LEFT JOIN _ecat_x xe ON xe.ver = v.ver AND xe.entity_id = a.entity_id
    LEFT JOIN _ig_names n ON n.entity_id = a.entity_id
   WHERE a.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)),
x AS (
  SELECT x0.ver, x0.prompt_run_id, x0.entity_id, x0.rollup_level, x0.entity_name, x0.dropped, x0.nm, (x0.parent IS NOT NULL) AS ovr,
         CASE WHEN rx.entity_id IS NOT NULL THEN NULL ELSE coalesce(x0.parent, x0.rollup_raw) END AS brand_rollup_entity_id,
         CASE WHEN rx.entity_id IS NOT NULL OR x0.parent IS NOT NULL THEN NULL ELSE x0.parent_name END AS parent_name
    FROM x0 LEFT JOIN _ecat_x rx ON rx.ver = x0.ver AND rx.entity_id = coalesce(x0.parent, x0.rollup_raw) AND rx.removed),
rid AS (
  SELECT x.*, bp.rid
    FROM x LEFT JOIN _ig_pairs bp ON bp.ver = x.ver AND bp.dkey = coalesce(x.entity_name, '') AND bp.dnull = (x.entity_name IS NULL)
                                 AND bp.rollup = x.brand_rollup_entity_id AND bp.ovr = x.ovr)
SELECT r.ver, r.prompt_run_id, r.entity_id, r.rollup_level, r.dropped,
       coalesce(pg_temp.brand_bare(r.nm), '') AS bare,
       pg_temp.canon_brand(r.nm) AS canon_name,
       coalesce(pg_temp.brand_bare(coalesce(r.parent_name, pn.brand)), '') AS parent_bare,
       pg_temp.canon_brand(coalesce(r.parent_name, pn.brand)) AS parent_canon,
       pg_temp.brand_competitive(lower(pg_temp.js_trim(r.nm)), r.entity_name) AS keep,
       greatest(coalesce(ro1.bit, 0), coalesce(ro2.bit, 0))::int2 AS own_bit
  FROM rid r
  LEFT JOIN _ig_names pn ON pn.entity_id = r.brand_rollup_entity_id
  LEFT JOIN _roster ro1 ON ro1.ver = r.ver AND ro1.entity_id = r.rid
  LEFT JOIN _roster ro2 ON ro2.ver = r.ver AND ro2.entity_id = r.entity_id;
CREATE UNIQUE INDEX ON _ig_acr_nm (ver, prompt_run_id, entity_id, rollup_level);
"""

# ── 표기 정렬 콜레이션(현행 프로필 NAME = display_name_latin, WU-4) ───────────────────────────────
# 롤업 대표 표기 규칙(라틴 우선 → 사전순)의 "사전순"은 DB 콜레이션을 탄다. 현행 ROLLUP_NAMES(scope-aggregates.ts:238-254)는 운영 Supabase
# 기본 콜레이션(ICU en-US)으로 돌고, hub stg(libc en_US.UTF-8)와 순서가 다르다('KG모빌리티' 대 'KGM'). 대표 표기를 고르는 네 문장(PRIOR_NAMES·
# PAIRS _ig_names·NAME_CHANGED cur·old_x)이 표식 /*name_coll*/ 을 갖고, 실행 직전 name_sql 이 프로필에 따라 콜레이션 절로 바꾼다.
# seed-3x-common §5 _names 는 psql 변수 legacy_name(1 = 같은 콜레이션)로 같은 규칙을 탄다(투영 스위치: 적재기와 시드가 같은 값이어야 한다).
NAME_COLL_MARK = "/*name_coll*/"


def name_sql(sql: str, profile=None) -> str:
    """표식 /*name_coll*/ 을 프로필(기본 = 활성 프로필)의 콜레이션 절로 바꾼 SQL. 꺼짐이면 표식만 지운다(도입 전 문장과 같다)."""
    from app.core.profile import active_profile, name_collation

    return sql.replace(NAME_COLL_MARK, name_collation(profile if profile is not None else active_profile()))


# ── 3. 전역 판정 영향 감지(바뀐 job _ig_s0 기준) ─────────────────────────────
# 대표 표기(names) 가 바뀐 엔티티: _ig_s0 의 Brand 언급 엔티티 중, 새 값(전 행)과 옛 값(_ig_s0 job 제외 행)의 bare 가 다른 것.
#   bare 가 같으면(대소문자·별칭만 다름) 사실 행 brand_key·competitive 가 바뀌지 않으므로 영향 없음.
#   후보 = 바뀐 job 의 새 Brand 언급 엔티티 ∪ 옛 Brand 언급 엔티티(_ig_prior_name: 재pull 로 언급이 빠진 방향, 결함 D2).
#   옛 값 = 스냅샷이 있으면 그 값(지우기 전 전 행 기준), 없으면(바뀐 job 이 옛 Brand 언급을 갖지 않았다) 바뀐 job 을 뺀 행 기준 = 옛 전 행 기준.
#   새 값 = 현재 전 행 기준(언급이 모두 빠졌으면 NULL → 다른 값으로 본다).
NAME_CHANGED = """
WITH e0 AS (SELECT DISTINCT m.entity_id FROM ing.mention m JOIN _ig_jobs0 j ON j.run_month = m.run_month AND j.job_id = m.job_id
             WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
             UNION SELECT b.entity_id FROM ing.entity_brand_name b WHERE current_setting('hgh.legacy_name', true) = '1' AND b.first_job IN (SELECT job_id FROM _ig_jobs0)),
e AS (SELECT entity_id FROM e0 UNION SELECT entity_id FROM _ig_prior_name),
cur AS (
  SELECT DISTINCT ON (entity_id) entity_id, display_name AS brand
    FROM (SELECT DISTINCT m.entity_id, m.display_name FROM ing.mention m
           WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL AND m.entity_id IN (SELECT entity_id FROM e)
           UNION SELECT b.entity_id, b.display_name FROM ing.entity_brand_name b WHERE current_setting('hgh.legacy_name', true) = '1' AND b.entity_id IN (SELECT entity_id FROM e)) x
   ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC, display_name/*name_coll*/),
old_x AS (
  SELECT DISTINCT ON (entity_id) entity_id, display_name AS brand
    FROM (SELECT DISTINCT m.entity_id, m.display_name FROM ing.mention m
           WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
             AND m.entity_id IN (SELECT entity_id FROM e0 WHERE entity_id NOT IN (SELECT entity_id FROM _ig_prior_name))
             AND NOT EXISTS (SELECT 1 FROM _ig_jobs0 j WHERE j.run_month = m.run_month AND j.job_id = m.job_id)
           UNION SELECT b.entity_id, b.display_name FROM ing.entity_brand_name b
            WHERE current_setting('hgh.legacy_name', true) = '1' AND b.entity_id IN (SELECT entity_id FROM e0 WHERE entity_id NOT IN (SELECT entity_id FROM _ig_prior_name))
              AND b.first_job NOT IN (SELECT job_id FROM _ig_jobs0)) x
   ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC, display_name/*name_coll*/),
old AS (SELECT entity_id, brand FROM _ig_prior_name UNION ALL SELECT entity_id, brand FROM old_x)
SELECT e.entity_id
  FROM e LEFT JOIN cur n ON n.entity_id = e.entity_id LEFT JOIN old o ON o.entity_id = e.entity_id
 WHERE o.brand IS NULL OR n.brand IS NULL OR pg_temp.brand_bare(o.brand) IS DISTINCT FROM pg_temp.brand_bare(n.brand)
"""
# 그 엔티티로 rid 가 풀리는 표기 쌍을 가진 기존 답변(이미 투영된 served job): 롤업·별칭·스탠스 엔티티 + (정본 3사면) 접두 교정 표기
NAME_IMPACT_KEYS = """
WITH e AS (SELECT unnest($1::uuid[]) AS entity_id),
ids AS (SELECT entity_id FROM e UNION SELECT alias_id FROM _alias_map WHERE canon_id IN (SELECT entity_id FROM e)),
jobs AS (
  SELECT m.job_id FROM ing.mention m WHERE m.brand_rollup_entity_id IN (SELECT entity_id FROM ids)
  UNION SELECT s.job_id FROM ing.answer_stance s WHERE s.entity_id IN (SELECT entity_id FROM ids)
  UNION SELECT m.job_id FROM ing.mention m
         WHERE EXISTS (SELECT 1 FROM app.brand b WHERE b.canonical_entity_id IN (SELECT entity_id FROM e))
           AND m.display_name IS NOT NULL AND m.brand_rollup_entity_id IS NOT NULL
           AND pg_temp.hmg_prefix_id(m.display_name) IN (SELECT entity_id FROM e))
SELECT j.answer_key FROM rd.job j WHERE j.job_id IN (SELECT job_id FROM jobs)
   AND NOT EXISTS (SELECT 1 FROM _ig_s x WHERE x.answer_key = j.answer_key)
"""
# 대표 표기가 바뀐 엔티티로 rid 가 풀리는 행을 가진 엔티티(차원 brand_key·rep_name 재계산 대상)
NAME_IMPACT_ENTS = """
WITH e AS (SELECT unnest($1::uuid[]) AS entity_id),
ids AS (SELECT entity_id FROM e UNION SELECT alias_id FROM _alias_map WHERE canon_id IN (SELECT entity_id FROM e))
SELECT DISTINCT entity_id FROM (
  SELECT m.entity_id FROM ing.mention m WHERE m.brand_rollup_entity_id IN (SELECT entity_id FROM ids)
  UNION SELECT s.entity_id FROM ing.answer_stance s WHERE s.entity_id IN (SELECT entity_id FROM ids)) x
"""
NAME_IMPACT_PR = """
SELECT DISTINCT prompt_run_id FROM ing.acr_rollup_row
 WHERE entity_id = ANY($1::uuid[]) OR brand_rollup_entity_id = ANY($1::uuid[])
    OR brand_rollup_entity_id IN (SELECT alias_id FROM _alias_map WHERE canon_id = ANY($1::uuid[]))
"""

# ── 4. URL·출처 차원(seed-30 §11 을 이 적재의 URL 로 좁힘. 최빈 host·도메인·제목은 그 URL 의 전 인용 행에서) ──
URLS = """
DROP TABLE IF EXISTS _ig_cu;
CREATE TEMP TABLE _ig_cu ON COMMIT DROP AS
WITH u AS (SELECT DISTINCT c.url FROM ing.citation c JOIN _ig_jobs0 j ON j.run_month = c.run_month AND j.job_id = c.job_id WHERE c.url IS NOT NULL
           UNION SELECT url FROM _ig_prior_url)
SELECT url, host, nullif(regexp_replace(lower(pg_temp.js_trim(domain_label)), '^www\\.', ''), '') AS dom, title, count(*) AS n
  FROM ing.citation WHERE url IN (SELECT url FROM u) GROUP BY 1, 2, 3, 4;
DROP TABLE IF EXISTS _ig_u;
CREATE TEMP TABLE _ig_u ON COMMIT DROP AS
WITH h AS (SELECT DISTINCT ON (url) url, host FROM (SELECT url, host, sum(n) AS n FROM _ig_cu WHERE host IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, host),
     d AS (SELECT DISTINCT ON (url) url, dom FROM (SELECT url, dom, sum(n) AS n FROM _ig_cu WHERE dom IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, dom),
     t AS (SELECT DISTINCT ON (url) url, title FROM (SELECT url, title, sum(n) AS n FROM _ig_cu WHERE title IS NOT NULL GROUP BY 1, 2) x ORDER BY url, n DESC, title),
     v AS (SELECT DISTINCT url FROM _ig_cu)
SELECT v.url, sha256(convert_to(v.url, 'UTF8')) AS url_hash, pg_temp.cit_norm(v.url) AS url_norm, pg_temp.cit_base_norm(v.url) AS url_base_norm,
       coalesce(h.host, split_part(pg_temp.cit_norm(v.url), '/', 1)) AS host, d.dom AS domain, t.title
  FROM v LEFT JOIN h ON h.url = v.url LEFT JOIN d ON d.url = v.url LEFT JOIN t ON t.url = v.url;
ALTER TABLE _ig_u ADD COLUMN skey text, ADD COLUMN owner_key int2;
UPDATE _ig_u SET skey = CASE WHEN domain IN (SELECT domain FROM _r_social) THEN pg_temp.group_key(domain, url) ELSE domain END;
UPDATE _ig_u SET owner_key = pg_temp.owner_key_of(url_base_norm) WHERE coalesce(url_base_norm, '') <> '';
CREATE UNIQUE INDEX ON _ig_u (url_hash);
"""
# 새 출처 그룹 키(seed-30 §11 출처 차원). 기존 키의 domain 은 유지(대표 도메인은 첫 발급 값).
DIM_SOURCE = """
WITH s0 AS (SELECT DISTINCT ON (skey) skey, domain, (skey <> domain) AS is_social FROM _ig_u WHERE coalesce(skey, '') <> ''
             AND NOT EXISTS (SELECT 1 FROM rd.dim_source x WHERE x.skey = _ig_u.skey) ORDER BY skey, domain),
s1 AS (SELECT s0.*, lower(pg_temp.js_trim(regexp_replace(lower(pg_temp.js_trim(skey)), '^www\\.', ''))) AS d FROM s0),
s2 AS (SELECT s1.*, pg_temp.owned_brand_of(s1.d) AS owned_brand, c.cat, c.src AS cat_src FROM s1 CROSS JOIN LATERAL pg_temp.category_of(s1.skey) c),
s3 AS (SELECT s2.*, CASE WHEN s2.cat = 'Official (Competitor)' THEN pg_temp.competitor_brand_of(s2.domain) END AS comp_brand FROM s2)
INSERT INTO rd.dim_source (skey, domain, is_social, category_key, category_src, owned_brand_bit, competitor_brand_key, rule_ver)
SELECT s.skey, s.domain, s.is_social, cc.category_key, s.cat_src, coalesce(ob.brand_bit, 0), bn.brand_key, $1
  FROM s3 s
  JOIN app.citation_category cc ON cc.name = s.cat
  LEFT JOIN app.brand ob ON ob.brand_code = s.owned_brand
  LEFT JOIN rd.dim_brand_name bn ON bn.bare = pg_temp.brand_bare(s.comp_brand)
 ORDER BY s.skey
"""
# 기존 URL 중 출처·자사 항목이 바뀐 것(그 URL 인용을 가진 다른 답변이 영향). dim_url 갱신 전에 읽는다
URL_CHANGED_KEYS = """
SELECT DISTINCT j.answer_key
  FROM _ig_u u JOIN rd.dim_url d ON d.url_hash = u.url_hash
  LEFT JOIN rd.dim_source s ON s.skey = u.skey AND u.skey <> ''
  JOIN rd.citation c ON c.url_key = d.url_key
  JOIN rd.job j ON j.surface = c.surface AND j.round_date = c.round_date AND j.answer_key = c.answer_key
 WHERE (d.source_key, d.owner_key) IS DISTINCT FROM (coalesce(s.source_key, 0), u.owner_key)
   AND NOT EXISTS (SELECT 1 FROM _ig_s x WHERE x.answer_key = j.answer_key)
"""
DIM_URL = """
WITH nv AS (SELECT u.*, coalesce(s.source_key, 0) AS source_key FROM _ig_u u LEFT JOIN rd.dim_source s ON s.skey = u.skey AND u.skey <> ''),
upd AS (
  UPDATE rd.dim_url d SET url_norm = nv.url_norm, url_base_norm = nv.url_base_norm, host = nv.host, domain = nv.domain,
         source_key = nv.source_key, owner_key = nv.owner_key, title = nv.title, rule_ver = $1
    FROM nv WHERE d.url_hash = nv.url_hash
     AND (d.url_norm, d.url_base_norm, d.host, d.domain, d.source_key, d.owner_key, d.title)
         IS DISTINCT FROM (nv.url_norm, nv.url_base_norm, nv.host, nv.domain, nv.source_key, nv.owner_key, nv.title)
  RETURNING d.url_key)
INSERT INTO rd.dim_url (url_hash, url, url_norm, url_base_norm, host, domain, source_key, owner_key, title, rule_ver)
SELECT nv.url_hash, nv.url, nv.url_norm, nv.url_base_norm, nv.host, nv.domain, nv.source_key, nv.owner_key, nv.title, $1
  FROM nv WHERE NOT EXISTS (SELECT 1 FROM rd.dim_url d WHERE d.url_hash = nv.url_hash)
 ORDER BY nv.url_hash
"""

# ── 5. 표시 브랜드·엔티티 차원 ───────────────────────────────────────────────
# seed-30 §9: 새 bare 만 발급(대표 표기 = 정본 표기 → 이 적재 언급 행 수 → 라틴 → 사전순). 기존 행의 대표 표기는 유지(첫 발급 값).
DIM_BRAND = """
WITH w AS (
  SELECT p.name, p.bare, sum(m.n) AS w
    FROM (SELECT m.display_name, m.brand_rollup_entity_id, count(*) AS n FROM ing.mention m
            JOIN _ig_jobs j ON j.run_month = m.run_month AND j.job_id = m.job_id
           WHERE m.brand_rollup_entity_id IS NOT NULL GROUP BY 1, 2) m
    JOIN _ig_pairs p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                    AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
   WHERE p.bare <> '' GROUP BY 1, 2),
cand AS (
  SELECT name, bare FROM _ig_pairs WHERE bare <> ''
  UNION SELECT canon_name, bare FROM _ig_acr_nm WHERE bare <> ''
  UNION SELECT parent_canon, parent_bare FROM _ig_acr_nm WHERE parent_bare <> ''
  UNION SELECT pg_temp.canon_brand(brand_name), pg_temp.brand_bare(brand_name) FROM app.competitor_domain_token),
canon_names AS (SELECT brand_code AS n FROM app.brand UNION SELECT canonical_name FROM app.brand_display_alias
                UNION SELECT brand_name FROM app.competitor_domain_token),
pick AS (
  SELECT DISTINCT ON (c.bare) c.bare, c.name
    FROM (SELECT DISTINCT name, bare FROM cand WHERE bare <> '') c
    LEFT JOIN w ON w.name = c.name AND w.bare = c.bare
   WHERE NOT EXISTS (SELECT 1 FROM rd.dim_brand_name b WHERE b.bare = c.bare OR b.name = c.name)   -- 이름 UNIQUE(NAME 전환 혼합 상태 방어, 꺼짐은 같은 뜻)
   ORDER BY c.bare, (c.name IN (SELECT n FROM canon_names)) DESC, coalesce(w.w, 0) DESC, (c.name ~ '^[A-Za-z]') DESC, c.name),
own AS (
  SELECT lower(b.brand_code) AS bare, (CASE WHEN b.brand_bit IN (1, 2, 4) THEN b.brand_bit ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bit
    FROM app.brand b LEFT JOIN app.brand pb ON pb.brand_code = b.parent_brand_code
   WHERE b.is_hmg_own AND NOT b.is_umbrella)
INSERT INTO rd.dim_brand_name (name, bare, kind, own_bit)
SELECT p.name, p.bare, (CASE WHEN coalesce(o.bit, 0) <> 0 THEN 1 WHEN nc.name IS NOT NULL THEN 3 ELSE 2 END)::int2, coalesce(o.bit, 0::int2)
  FROM pick p LEFT JOIN own o ON o.bare = lower(pg_temp.js_trim(p.bare)) LEFT JOIN app.non_competitor_name nc ON nc.name = lower(pg_temp.js_trim(p.bare))
 ORDER BY 3 = 1 DESC, 4, p.bare
"""
# 규칙 재판정(brand_rule·entity·competitor_token)에서 기존 표시 브랜드의 대표 표기를 다시 고른다(같은 선택 규칙, 범위 = 이번 재투영 답변).
REPICK_NAMES = """
WITH w AS (
  SELECT p.name, p.bare, sum(m.n) AS w
    FROM (SELECT m.display_name, m.brand_rollup_entity_id, count(*) AS n FROM ing.mention m
            JOIN _ig_jobs j ON j.run_month = m.run_month AND j.job_id = m.job_id
           WHERE m.brand_rollup_entity_id IS NOT NULL GROUP BY 1, 2) m
    JOIN _ig_pairs p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                    AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
   WHERE p.bare <> '' GROUP BY 1, 2),
cand AS (
  SELECT name, bare FROM _ig_pairs WHERE bare <> ''
  UNION SELECT canon_name, bare FROM _ig_acr_nm WHERE bare <> ''
  UNION SELECT parent_canon, parent_bare FROM _ig_acr_nm WHERE parent_bare <> ''
  UNION SELECT pg_temp.canon_brand(brand_name), pg_temp.brand_bare(brand_name) FROM app.competitor_domain_token),
canon_names AS (SELECT brand_code AS n FROM app.brand UNION SELECT canonical_name FROM app.brand_display_alias
                UNION SELECT brand_name FROM app.competitor_domain_token),
pick AS (
  SELECT DISTINCT ON (c.bare) c.bare, c.name
    FROM (SELECT DISTINCT name, bare FROM cand WHERE bare <> '') c
    LEFT JOIN w ON w.name = c.name AND w.bare = c.bare
   ORDER BY c.bare, (c.name IN (SELECT n FROM canon_names)) DESC, coalesce(w.w, 0) DESC, (c.name ~ '^[A-Za-z]') DESC, c.name)
UPDATE rd.dim_brand_name d SET name = p.name FROM pick p WHERE d.bare = p.bare AND d.name IS DISTINCT FROM p.name
   AND NOT EXISTS (SELECT 1 FROM rd.dim_brand_name x WHERE x.name = p.name AND x.bare <> p.bare)
RETURNING d.brand_key
"""

# seed-30 §10 을 _ig_ent_ids 로 좁힘(전 행 기준 최빈이라 그 엔티티의 모든 언급·스탠스·ACR 행을 읽는다)
DIM_ENTITY = """
DROP TABLE IF EXISTS _ig_ent;
CREATE TEMP TABLE _ig_ent ON COMMIT DROP AS
WITH m AS (SELECT entity_id, entity_type, display_name, brand_rollup_entity_id, count(*) AS n
             FROM ing.mention WHERE entity_id IN (SELECT entity_id FROM _ig_ent_ids) GROUP BY 1, 2, 3, 4),
st AS (SELECT entity_id, brand_label, count(*) AS n FROM ing.answer_stance WHERE entity_id IN (SELECT entity_id FROM _ig_ent_ids) GROUP BY 1, 2),
ac AS (SELECT entity_id, entity_type, entity_name, count(*) AS n FROM ing.acr_rollup_row
        WHERE entity_id IN (SELECT entity_id FROM _ig_ent_ids) GROUP BY 1, 2, 3),
ty AS (SELECT DISTINCT ON (entity_id) entity_id, entity_type FROM (
         SELECT entity_id, entity_type, sum(n) AS n, 1 AS pri FROM m WHERE entity_type IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, entity_type, sum(n), 2 FROM ac WHERE entity_type IS NOT NULL GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, entity_type),
nm AS (SELECT DISTINCT ON (entity_id) entity_id, nm FROM (
         SELECT entity_id, display_name AS nm, sum(n) AS n, 1 AS pri FROM m WHERE display_name IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, brand_label, sum(n), 2 FROM st WHERE brand_label IS NOT NULL GROUP BY 1, 2
         UNION ALL SELECT entity_id, entity_name, sum(n), 3 FROM ac WHERE entity_name IS NOT NULL GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, nm),
bk AS (SELECT DISTINCT ON (entity_id) entity_id, bare FROM (
         SELECT m.entity_id, p.bare, sum(m.n) AS n, 1 AS pri FROM m
           JOIN _ig_pairs p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                           AND p.dkey = coalesce(m.display_name, '') AND p.dnull = (m.display_name IS NULL) AND p.rollup = m.brand_rollup_entity_id
          WHERE m.brand_rollup_entity_id IS NOT NULL AND p.bare <> '' GROUP BY 1, 2
         UNION ALL
         SELECT st.entity_id, p.bare, sum(st.n), 2 FROM st
           JOIN _ig_pairs p ON p.ver = (SELECT dv FROM _ecat_cfg) AND NOT p.ovr
                           AND p.dkey = coalesce(st.brand_label, '') AND p.dnull = (st.brand_label IS NULL) AND p.rollup = st.entity_id
          WHERE p.bare <> '' GROUP BY 1, 2) x
        ORDER BY entity_id, pri, n DESC, bare),
ids AS (SELECT entity_id FROM m UNION SELECT entity_id FROM st UNION SELECT entity_id FROM ac)
SELECT i.entity_id, ty.entity_type, coalesce(n.brand, nm.nm) AS rep_name, bk.bare
  FROM ids i
  LEFT JOIN ty ON ty.entity_id = i.entity_id
  LEFT JOIN _ig_names n ON n.entity_id = i.entity_id
  LEFT JOIN nm ON nm.entity_id = i.entity_id
  LEFT JOIN bk ON bk.entity_id = i.entity_id;
WITH nv AS (SELECT e.entity_id, e.entity_type, e.rep_name, b.brand_key, r.role
              FROM _ig_ent e LEFT JOIN rd.dim_brand_name b ON b.bare = e.bare LEFT JOIN app.entity_registry r ON r.entity_id = e.entity_id)
UPDATE rd.dim_entity d SET entity_type = nv.entity_type, rep_name = nv.rep_name, brand_key = nv.brand_key, registry_role = nv.role
  FROM nv WHERE d.entity_id = nv.entity_id
   AND (d.entity_type, d.rep_name, d.brand_key, d.registry_role) IS DISTINCT FROM (nv.entity_type, nv.rep_name, nv.brand_key, nv.role);
INSERT INTO rd.dim_entity (entity_id, entity_type, rep_name, brand_key, registry_role)
SELECT e.entity_id, e.entity_type, e.rep_name, b.brand_key, r.role
  FROM _ig_ent e LEFT JOIN rd.dim_brand_name b ON b.bare = e.bare LEFT JOIN app.entity_registry r ON r.entity_id = e.entity_id
 WHERE NOT EXISTS (SELECT 1 FROM rd.dim_entity d WHERE d.entity_id = e.entity_id)
 ORDER BY e.entity_id;
"""

# ── 6. 사실 원천(seed-40 §3~§6 을 _ig_s 로 좁힘) ───────────────────────────────
# 글로벌 한국어 비-KR 제외(동기화 S1 BE-1, hmg-geo 2670a16 #302 태그 우선): 한국어 ∧ region ≠ 'KR' ∧ (태그 없음 ∨ 측정이 태깅 도입
#   2026-08-19T00:00Z 이전 ∨ measured_at NULL) 일 때만 뺀다. 태그 있음 ∧ 태깅 이후는 태그 술어(region ∈ p_regions)가 판정한다.
#   경계 상수 = hmg-geo lib/scope/region-tagging.ts:17 REGION_TAGGING_CUTOFF_ISO. ACR_PREP(acr_in)·seed-40 §4·§9 가 같은 식이다.
FACT_SRC = """
DROP TABLE IF EXISTS _ig_job;
CREATE TEMP TABLE _ig_job ON COMMIT DROP AS
SELECT a.answer_key, a.job_id, a.run_month, a.run_id, a.prompt_id, a.target, a.region, a.status, a.measured_at,
       a.analysis_status, a.n_mentions, a.n_citations,
       rc.run_key, rc.run_status, rc.cyc_key, rc.anchor_src, c.round_date, c.anchor_date,
       dp.surface, dp.project_key,
       coalesce(pr.prompt_key, 0) AS prompt_key, coalesce(pr.kind, 'single') AS kind, coalesce(pr.cat_mask, 0::int2) AS cat_mask,
       coalesce(pr.lang_key, 0::int2) AS lang_key, coalesce(pr.in_root_catalog, false) AS in_root_catalog,
       coalesce(pr.is_korean, false) AS is_korean, pr.regions AS p_regions, coalesce(pr.web_reg, false) AS p_web_reg,
       pr.unit_key, coalesce(pr.targets, '{}') AS targets,
       coalesce(e.engine_key, 0::int2) AS engine_key, coalesce(e.is_default, false) AS dflt,
       (CASE WHEN dp.surface = 2 THEN coalesce(ws.geo_key, nullif(dp.site_geo_key, 0), gr.geo_key, 0)
             ELSE coalesce(gr.geo_key, 0) END)::int2 AS geo_key,
       coalesce(gr.hidden_standard, false) AS region_hidden,
       -- region_geo_key(DB-v2.15 P87, WU-7 GEOAX): 답변 region 의 geo_key(사이트 국가 우선 없이). 정본 rd.answer_region_geo·seed-40 §3 과 같은 식
       coalesce(gr.geo_key, 0)::int2 AS region_geo_key,
       (CASE dp.surface WHEN 1 THEN coalesce(pr.cat_mask, 0)
                        WHEN 2 THEN coalesce(wb.brand_bit, nullif(dp.site_brand_bit, 0), 0)
                        ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bgrp,
       (CASE WHEN a.status = 'completed' THEN 0
             WHEN a.status IN ('pending', 'running', 'queued', 'processing', 'in_progress') THEN 1
             WHEN a.status IN ('failed', 'error', 'timeout') THEN 2 ELSE 3 END)::int2 AS status_code,
       EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = a.job_id) AS dropped,
       coalesce(CASE WHEN NOT cfg.force THEN c.ecat_ver::int4 END, cfg.dv) AS ecat_ver   -- 답변 버전(E1): 회차 고정 → 기준 버전
  FROM _ig_jobs a
  CROSS JOIN _ecat_cfg cfg
  JOIN _ig_runc rc ON rc.run_id = a.run_id
  JOIN rd.cycle c ON c.cyc_key = rc.cyc_key
  JOIN rd.dim_project dp ON dp.scope_project_id = rc.scope_project_id
  LEFT JOIN rd.dim_prompt pr ON pr.prompt_id = a.prompt_id
  LEFT JOIN rd.dim_engine e ON e.code = a.target
  LEFT JOIN rd.dim_country gr ON upper(gr.code) = upper(a.region)
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = a.prompt_id AND dp.surface = 2
  LEFT JOIN rd.dim_country ws ON upper(ws.code) = upper(wpk.country_code)
  LEFT JOIN app.brand wb ON wb.brand_code = wpk.brand_code
  LEFT JOIN app.project pj ON pj.project_id = dp.project_id AND dp.surface = 3
  LEFT JOIN app.brand pb ON pb.brand_code = pj.brand_code;
CREATE UNIQUE INDEX ON _ig_job (answer_key);

DROP TABLE IF EXISTS _ig_ans;
CREATE TEMP TABLE _ig_ans ON COMMIT DROP AS
SELECT j.*,
       (j.run_status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              j.in_root_catalog
              AND NOT (j.region_hidden OR (j.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (j.region <> 'KR' AND j.is_korean
                                AND (j.measured_at IS NULL OR j.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR j.p_regions IS NULL OR cardinality(j.p_regions) = 0)), false)
              AND (j.p_regions IS NULL OR cardinality(j.p_regions) = 0 OR coalesce(j.region = ANY (j.p_regions), false))))) AS elig,
       -- elig_nc(DB-v2.15 P89, A41): 위 elig 에서 루트 카탈로그 소속(in_root_catalog) 항만 뺀 식. rd.answer_elig_nc·seed-40 §4 와 같다
       (j.run_status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              NOT (j.region_hidden OR (j.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (j.region <> 'KR' AND j.is_korean
                                AND (j.measured_at IS NULL OR j.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR j.p_regions IS NULL OR cardinality(j.p_regions) = 0)), false)
              AND (j.p_regions IS NULL OR cardinality(j.p_regions) = 0 OR coalesce(j.region = ANY (j.p_regions), false))))) AS elig_nc,
       (j.kind = 'acr') AS is_acr,
       (CASE WHEN j.analysis_status IN ('completed', 'partial') THEN CASE WHEN j.n_mentions > 0 THEN 0 ELSE 1 END
             WHEN j.analysis_status = 'pending' THEN 2
             WHEN j.analysis_status IN ('failed', 'skipped') THEN 3
             WHEN j.n_mentions > 0 THEN 0 WHEN j.n_citations > 0 THEN 1 ELSE 2 END)::int2 AS analysis_state,
       (j.surface = 2 AND j.p_web_reg) AS web_reg
  FROM _ig_job j WHERE j.status_code = 0 AND NOT j.dropped;
CREATE UNIQUE INDEX ON _ig_ans (answer_key);
ALTER TABLE _ig_ans ADD COLUMN acr_iter_rank int2 NOT NULL DEFAULT 1;
UPDATE _ig_ans a SET acr_iter_rank = x.rk
  FROM (SELECT answer_key, row_number() OVER (PARTITION BY run_key, prompt_key, engine_key, coalesce(region, '')
                                              ORDER BY measured_at DESC NULLS LAST, answer_key DESC)::int2 AS rk
          FROM _ig_ans WHERE is_acr) x
 WHERE x.answer_key = a.answer_key;
ALTER TABLE _ig_ans ADD COLUMN acr_in bool, ADD COLUMN gap bool, ADD COLUMN std_in bool, ADD COLUMN cit_in bool,
                    ADD COLUMN std_in_nc bool, ADD COLUMN cit_in_nc bool;
UPDATE _ig_ans SET acr_in = NOT (is_acr AND acr_iter_rank > 1), gap = analysis_state >= 2,
                   std_in = elig AND NOT (is_acr AND acr_iter_rank > 1) AND analysis_state < 2,
                   cit_in = elig AND NOT (is_acr AND acr_iter_rank > 1),
                   std_in_nc = elig_nc AND NOT (is_acr AND acr_iter_rank > 1) AND analysis_state < 2,
                   cit_in_nc = elig_nc AND NOT (is_acr AND acr_iter_rank > 1);
ANALYZE _ig_ans;
-- 자사 접두·인용 판정(_ig_pprefix·_ig_psib·_ig_cr·_ig_citf·_ig_citc): 엔티티 버전 오버레이(ECAT_IN → FACT_MR)와 무관해 FACT_SRC 에 둔다.
-- 현행 프로필 인용 투영 스위치 표식(row_src·web_tgt 주석 쌍)이 여기 있어야 service 의 fact_src_sql(FACT_SRC) 이 바꾼다(be/ecat-int 통합:
-- 엔티티 분할로 FACT_MR 에 남았을 때 표식이 조용히 무시돼 G21A·OWN4 가 증분 적재에서 꺼진 채 돌았다)
DROP TABLE IF EXISTS _ig_pprefix;
CREATE TEMP TABLE _ig_pprefix ON COMMIT DROP AS
WITH pj AS (SELECT dp.project_key, p.project_id, p.domain, p.brand_code, p.country_code
              FROM rd.dim_project dp JOIN app.project p ON p.project_id = dp.project_id
             WHERE dp.surface = 3 AND dp.project_key IN (SELECT DISTINCT project_key FROM _ig_ans WHERE surface = 3)),
cfg AS (SELECT pj.project_key, pob.base_norm AS prefix FROM pj JOIN app.project_owned_base pob ON pob.project_id = pj.project_id)
SELECT DISTINCT project_key, prefix FROM (
  SELECT project_key, prefix FROM cfg
  UNION ALL SELECT pj.project_key, pg_temp.owned_prefix(pj.domain) FROM pj
   WHERE NOT EXISTS (SELECT 1 FROM cfg WHERE cfg.project_key = pj.project_key)
  UNION ALL SELECT pj.project_key, o.prefix FROM pj JOIN app.owned_base o
    ON o.kind = 'base' AND o.brand_code = pj.brand_code AND o.geo_code = pj.country_code) x
 WHERE coalesce(prefix, '') <> '';
DROP TABLE IF EXISTS _ig_psib;
CREATE TEMP TABLE _ig_psib ON COMMIT DROP AS
SELECT DISTINCT p.project_key, o.prefix AS q
  FROM _ig_pprefix p JOIN app.owned_base o ON o.kind = 'base' AND length(o.prefix) > length(p.prefix) AND starts_with(o.prefix, p.prefix || '/')
 WHERE NOT EXISTS (SELECT 1 FROM _ig_pprefix s WHERE s.project_key = p.project_key AND s.prefix = o.prefix);

DROP TABLE IF EXISTS _ig_cr;
CREATE TEMP TABLE _ig_cr ON COMMIT DROP AS
SELECT s.answer_key, s.surface, s.round_date, s.cyc_key, s.prompt_key, s.project_key, s.engine_key, s.geo_key, s.lang_key, s.bgrp,
       s.unit_key, s.targets, s.cit_in, s.gap, s.dflt, s.cit_in_nc,
       c.ord, coalesce(u.url_key, 0) AS url_key, /*row_src*/coalesce(u.source_key, 0)/*row_src_end*/ AS source_key, coalesce(u.owner_key, 0)::int2 AS owner_key,
       u.url_norm, u.url_base_norm
  FROM _ig_ans s
  JOIN ing.citation c ON c.run_month = s.run_month AND c.job_id = s.job_id
  LEFT JOIN rd.dim_url u ON c.url IS NOT NULL AND u.url_hash = sha256(convert_to(c.url, 'UTF8'));
ALTER TABLE _ig_cr ADD COLUMN loc_owned bool NOT NULL DEFAULT false, ADD COLUMN tgt_hit bool NOT NULL DEFAULT false,
                   ADD COLUMN src_first bool NOT NULL DEFAULT false, ADD COLUMN scope_key int2 NOT NULL DEFAULT 0;
UPDATE _ig_cr c SET
  loc_owned = coalesce(
      (split_part(c.url_base_norm, '/', 1) = split_part(w.base, '/', 1)
       AND (((c.url_base_norm = w.base OR starts_with(c.url_base_norm, w.base || '/') OR c.url_base_norm = w.base || '.html')
             AND NOT EXISTS (SELECT 1 FROM unnest(w.sibs) q
                              WHERE c.url_base_norm = q OR starts_with(c.url_base_norm, q || '/') OR c.url_base_norm = q || '.html'))
            OR (w.home_host IS NOT NULL AND rtrim(split_part(c.url_base_norm, '?', 1), '/') = w.home_host)))
      OR /*web_tgt*/(coalesce(c.url_norm, '') <> '' AND c.url_norm = ANY (w.turls))/*web_tgt_end*/, false),
  scope_key = w.unit_key
  FROM rd.web_unit w
 WHERE c.surface = 2 AND w.unit_key = c.unit_key AND w.base IS NOT NULL;
UPDATE _ig_cr c SET scope_key = coalesce(c.unit_key, 0) WHERE c.surface = 2 AND c.scope_key = 0;
UPDATE _ig_cr c SET tgt_hit = coalesce(c.url_norm, '') <> '' AND c.url_norm = ANY (c.targets) WHERE c.surface = 2;
UPDATE _ig_cr c SET
  loc_owned = coalesce(
      split_part(c.url_base_norm, '/', 1) IN (SELECT split_part(p.prefix, '/', 1) FROM _ig_pprefix p WHERE p.project_key = c.project_key)
      AND ((EXISTS (SELECT 1 FROM _ig_pprefix p WHERE p.project_key = c.project_key
                     AND (c.url_base_norm = p.prefix OR starts_with(c.url_base_norm, p.prefix || '/') OR c.url_base_norm = p.prefix || '.html'))
            AND NOT EXISTS (SELECT 1 FROM _ig_psib q WHERE q.project_key = c.project_key
                     AND (c.url_base_norm = q.q OR starts_with(c.url_base_norm, q.q || '/') OR c.url_base_norm = q.q || '.html')))
           OR rtrim(split_part(c.url_base_norm, '?', 1), '/') IN (
                SELECT split_part(p.prefix, '/', 1) FROM _ig_pprefix p WHERE p.project_key = c.project_key
                   AND split_part(p.prefix, '/', 1) NOT IN (SELECT host FROM _r_shared_host))), false),
  tgt_hit = coalesce(c.url_norm, '') <> '' AND EXISTS (
      SELECT 1 FROM app.project_tracked_url t JOIN rd.dim_project dp ON dp.project_id = t.project_id
       WHERE dp.project_key = c.project_key AND t.url_norm = c.url_norm),
  scope_key = c.project_key
 WHERE c.surface = 3;
UPDATE _ig_cr c SET scope_key = c.project_key WHERE c.surface = 1;
UPDATE _ig_cr c SET src_first = true
  FROM (SELECT answer_key, ord, row_number() OVER (PARTITION BY answer_key, source_key ORDER BY ord) AS rn FROM _ig_cr) x
 WHERE x.answer_key = c.answer_key AND x.ord = c.ord AND x.rn = 1;
CREATE UNIQUE INDEX ON _ig_cr (answer_key, ord);

DROP TABLE IF EXISTS _ig_citf;
CREATE TEMP TABLE _ig_citf ON COMMIT DROP AS
SELECT answer_key, bool_or(source_key <> 0) AS has_cit,
       coalesce(bool_or(tgt_hit) FILTER (WHERE source_key <> 0), false) AS tgt_cited,
       coalesce(bool_or(loc_owned OR tgt_hit) FILTER (WHERE source_key <> 0), false) AS own_url_cited
  FROM _ig_cr GROUP BY answer_key;
CREATE UNIQUE INDEX ON _ig_citf (answer_key);

-- 답변당 인용 수 열(G-25 11열 + DB-v2.13 cit_off = 출처 카테고리 Official (HMG), 글로벌 ⑤ 분자). seed-40 §6 _citc 와 같은 식,
-- 정본 rd.answer_cit_counts 와 apply.project 끝 rd.assert_answer_cit_counts(엄격)가 같은 트랜잭션에서 대조한다.
-- DB-v2.15 P86(WU-5): cit_n_all = 모든 인용 원소(호스트 없는 인용 포함, 현행 ⑤ 분모 G21A), cit_c<k> = 호스트 있는 인용 중 출처 차원 카테고리 k
-- 인 수(인용 성능 수정안 B, 합 = cit_n). 정본 rd.answer_cit_ext 와 ASSERT_CIT_EXT 가 같은 트랜잭션에서 대조한다. 종전 11열은 FILTER 로 옮겼을
-- 뿐 값이 같다(호스트 없는 인용만 가진 답변은 종전 행 없음 → coalesce 0, 지금은 행이 있고 값 0).
DROP TABLE IF EXISTS _ig_citc;
CREATE TEMP TABLE _ig_citc ON COMMIT DROP AS
SELECT c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int2 AS cit_n,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 1)::int2 AS cit_own_h,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 2)::int2 AS cit_own_k,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 4)::int2 AS cit_own_g,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 1 AND ob.geo = upper(g.code))::int2 AS cit_own_hc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 2 AND ob.geo = upper(g.code))::int2 AS cit_own_kc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 4 AND ob.geo = upper(g.code))::int2 AS cit_own_gc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int2 AS cit_own_x,
       count(*) FILTER (WHERE c.source_key <> 0 AND c.loc_owned)::int2 AS cit_loc,
       count(*) FILTER (WHERE c.source_key <> 0 AND c.tgt_hit)::int2 AS cit_tgt,
       count(*) FILTER (WHERE c.source_key <> 0 AND (c.loc_owned OR c.tgt_hit))::int2 AS cit_loc_tgt,
       count(*) FILTER (WHERE c.source_key <> 0
                          AND s.category_key = (SELECT cc.category_key FROM app.citation_category cc WHERE cc.name = 'Official (HMG)'))::int2
         AS cit_off,
       count(*)::int2 AS cit_n_all,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int2 AS cit_c1,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int2 AS cit_c2,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int2 AS cit_c3,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int2 AS cit_c4,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int2 AS cit_c5,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int2 AS cit_c6,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int2 AS cit_c7,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int2 AS cit_c8,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int2 AS cit_c9,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int2 AS cit_c10,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int2 AS cit_c11,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int2 AS cit_c12,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int2 AS cit_c13
  FROM _ig_cr c
  LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
               FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
  LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 GROUP BY c.answer_key;
CREATE UNIQUE INDEX ON _ig_citc (answer_key);
"""
# 엔티티 버전 오버레이 입력(E1): 차단·추가 표면이 있을 때만 행이 있다(없으면 seed-4x-ecat.sql 의 모든 문장이 원천을 읽지 않는다).
#   service.project 가 FACT_SRC → ECAT_IN → rules.ecat_overlay_sql() → FACT_MR 순으로 돈다.
ECAT_IN = """
DROP TABLE IF EXISTS _ecat_in;
CREATE TEMP TABLE _ecat_in ON COMMIT DROP AS
SELECT s.answer_key, s.run_month, s.job_id, s.ecat_ver, a.content_hash,
       (CASE WHEN a.prompt_run_id IS NOT NULL THEN 2 ELSE 1 END)::int2 AS body_turn
  FROM _ig_ans s JOIN ing.answer a ON a.run_month = s.run_month AND a.job_id = s.job_id
 WHERE (SELECT EXISTS (SELECT 1 FROM _ecat_blk) OR EXISTS (SELECT 1 FROM _ecat_add));
CREATE UNIQUE INDEX ON _ecat_in (answer_key);
ANALYZE _ecat_in;
"""
# 유효 언급(seed-40 §5-0 _meff 와 같은 식, 적용 순서: 제거 → 관계 덮어쓰기 → 롤업 대상 제거 → 차단·재매칭 보정 → 병합은 쌍 rid 에서)
FACT_MR = """
DROP TABLE IF EXISTS _ig_mr;
CREATE TEMP TABLE _ig_mr ON COMMIT DROP AS
WITH em AS (
  SELECT s.answer_key, s.ecat_ver AS ver, m.display_name AS disp, (xe.parent IS NOT NULL) AS ovr,
         CASE WHEN xr.entity_id IS NOT NULL THEN NULL ELSE coalesce(xe.parent, m.brand_rollup_entity_id) END AS rollup,
         coalesce(j.cnt, m.mention_count) AS mention_count,
         coalesce(j.s_pos, m.sentiment_positive) AS sentiment_positive, coalesce(j.s_neu, m.sentiment_neutral) AS sentiment_neutral,
         coalesce(j.s_neg, m.sentiment_negative) AS sentiment_negative, coalesce(j.s_mix, m.sentiment_mixed) AS sentiment_mixed,
         coalesce(j.t_mention, m.type_mention) AS type_mention, coalesce(j.t_recommendation, m.type_recommendation) AS type_recommendation,
         coalesce(j.t_comparison, m.type_comparison) AS type_comparison, coalesce(j.t_definition, m.type_definition) AS type_definition,
         coalesce(j.t_final_choice, m.type_final_choice) AS type_final_choice, m.avg_position
    FROM _ig_ans s
    JOIN ing.mention m ON m.run_month = s.run_month AND m.job_id = s.job_id
    LEFT JOIN _ecat_x xe ON xe.ver = s.ecat_ver AND xe.entity_id = m.entity_id
    LEFT JOIN _ecat_x xr ON xr.ver = s.ecat_ver AND xr.entity_id = coalesce(xe.parent, m.brand_rollup_entity_id) AND xr.removed
    LEFT JOIN _ecat_madj j ON j.answer_key = s.answer_key AND j.ord = m.ord
   WHERE NOT coalesce(xe.removed, false) AND NOT coalesce(j.dropm, false)
  UNION ALL
  SELECT h.answer_key, s.ecat_ver, h.disp, h.ovr, h.rollup, h.cnt, 0, 0, 0, 0, h.cnt, 0, 0, 0, 0, h.avg_position
    FROM _ecat_hnew h JOIN _ig_ans s ON s.answer_key = h.answer_key)
SELECT e.answer_key, b.brand_key, p.competitive, b.own_bit, p.rid_bit, p.rid,
       e.mention_count, e.sentiment_positive, e.sentiment_neutral, e.sentiment_negative, e.sentiment_mixed,
       e.type_mention, e.type_recommendation, e.type_comparison, e.type_definition, e.type_final_choice, e.avg_position
  FROM em e
  JOIN _ig_pairs p ON p.ver = e.ver AND p.dkey = coalesce(e.disp, '') AND p.dnull = (e.disp IS NULL) AND p.rollup = e.rollup AND p.ovr = e.ovr
  JOIN rd.dim_brand_name b ON b.bare = p.bare
 WHERE e.rollup IS NOT NULL;
DROP TABLE IF EXISTS _ig_ab;
CREATE TEMP TABLE _ig_ab ON COMMIT DROP AS
SELECT answer_key, brand_key, competitive, max(own_bit)::int2 AS own_bit,
       count(*)::int2 AS entity_rows, count(DISTINCT rid)::int2 AS rid_n, sum(mention_count)::int2 AS mention_count,
       sum(sentiment_positive)::int2 AS s_pos, sum(sentiment_neutral)::int2 AS s_neu,
       sum(sentiment_negative)::int2 AS s_neg, sum(sentiment_mixed)::int2 AS s_mix,
       sum(type_mention)::int2 AS t_mention, sum(type_recommendation)::int2 AS t_recommendation, sum(type_comparison)::int2 AS t_comparison,
       sum(type_definition)::int2 AS t_definition, sum(type_final_choice)::int2 AS t_final_choice,
       min(avg_position) AS tp
  FROM _ig_mr GROUP BY answer_key, brand_key, competitive;
ALTER TABLE _ig_ab ADD COLUMN rk int2 NOT NULL DEFAULT 0;
UPDATE _ig_ab a SET rk = x.rk
  FROM (SELECT answer_key, brand_key, rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk
          FROM _ig_ab WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL) x
 WHERE x.answer_key = a.answer_key AND x.brand_key = a.brand_key AND a.competitive;
CREATE UNIQUE INDEX ON _ig_ab (answer_key, brand_key, competitive);

DROP TABLE IF EXISTS _ig_own;
CREATE TEMP TABLE _ig_own ON COMMIT DROP AS
SELECT answer_key,
       coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0)::int2 AS own_mask,
       coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0)::int2 AS own_rk_h,
       coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0)::int2 AS own_rk_k,
       coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0)::int2 AS own_rk_g,
       coalesce(sum(mention_count) FILTER (WHERE competitive), 0)::int2 AS ment_total,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0)::int2 AS ment_h,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0)::int2 AS ment_k,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0)::int2 AS ment_g,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_pos_h,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_pos_k,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_pos_g,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_neg_h,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_neg_k,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_neg_g,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_all_h,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_all_k,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_all_g,
       -- DB-v2.18 P105 당사 언급 유형 마스크(비트 5b+i, 정본 rd.answer_t_own = 같은 함수 rd.t_own_bits 의 bit_or)
       coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0)::int2 AS t_own
  FROM _ig_ab GROUP BY answer_key;
CREATE UNIQUE INDEX ON _ig_own (answer_key);

"""
JOB_UNMATCHED = "SELECT count(*) FROM _ig_jobs j WHERE NOT EXISTS (SELECT 1 FROM _ig_job x WHERE x.answer_key = j.answer_key)"

# ── 7. 옛 위치·셀 기록 → 삭제 ───────────────────────────────────────────────
OLD_COORDS = """
DROP TABLE IF EXISTS _ig_old;
CREATE TEMP TABLE _ig_old ON COMMIT DROP AS
SELECT j.answer_key, j.surface, j.round_date, j.served FROM rd.job j WHERE j.answer_key IN (SELECT answer_key FROM _ig_s);
CREATE UNIQUE INDEX ON _ig_old (answer_key);
DROP TABLE IF EXISTS _ig_cells;
CREATE TEMP TABLE _ig_cells (surface int2, round_date date, cyc_key int4, prompt_key int4, engine_key int2, geo_key int2) ON COMMIT DROP;
INSERT INTO _ig_cells
SELECT DISTINCT a.surface, a.round_date, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
  FROM _ig_old o JOIN rd.answer a ON a.surface = o.surface AND a.round_date = o.round_date AND a.answer_key = o.answer_key
 WHERE o.served;
"""
DELETE_OLD = """
DELETE FROM rd.answer_brand c USING _ig_old o WHERE c.surface = o.surface AND c.round_date = o.round_date AND c.answer_key = o.answer_key;
DELETE FROM rd.answer_stance c USING _ig_old o WHERE c.surface = o.surface AND c.round_date = o.round_date AND c.answer_key = o.answer_key;
DELETE FROM rd.citation c USING _ig_old o WHERE c.surface = o.surface AND c.round_date = o.round_date AND c.answer_key = o.answer_key;
DELETE FROM rd.answer c USING _ig_old o WHERE c.surface = o.surface AND c.round_date = o.round_date AND c.answer_key = o.answer_key;
DELETE FROM rd.job j WHERE j.answer_key IN (SELECT answer_key FROM _ig_old);
"""
# 재pull 로 인용·언급이 모두 빠진 URL·엔티티(스냅샷 대상 중 ing 원천 행 0): bulk 시드(seed-30 §10·§11 = 전 ing 행에서 발급)에는 없는 행이라
# 지운다(결함 D2·D6). 지우는 시점엔 영향 답변을 이미 다시 넣었으므로 사실 행 참조가 없다(동치 테스트가 참조 0 을 함께 확인).
URL_ORPHANS_DELETE = """
DELETE FROM rd.dim_url d USING _ig_prior_url p
 WHERE d.url_key <> 0 AND d.url_hash = p.url_hash
   AND NOT EXISTS (SELECT 1 FROM ing.citation c WHERE c.url = p.url)
RETURNING d.url_key
"""
ENTITY_ORPHANS_DELETE = """
DELETE FROM rd.dim_entity d USING _ig_prior_ent p
 WHERE d.entity_id = p.entity_id
   AND NOT EXISTS (SELECT 1 FROM ing.mention m WHERE m.entity_id = p.entity_id)
   AND NOT EXISTS (SELECT 1 FROM ing.answer_stance s WHERE s.entity_id = p.entity_id)
   AND NOT EXISTS (SELECT 1 FROM ing.acr_rollup_row r WHERE r.entity_id = p.entity_id)
"""
# ── 인용 판정 투영 스위치(현행 프로필 G21A cit_hostless_per_row·OWN4 web_owned_target_base, WU-5) ─────────────────────────
# FACT_SRC 의 표식을 실행 직전 fact_src_sql 이 프로필에 따라 바꾼다(꺼짐 = 표식만 지움 = 도입 전 문장과 같다). seed-40 §6 은 psql 변수
# cit_row_host·web_tgt_base 로 같은 규칙을 탄다(투영 스위치: 적재기와 시드가 같은 값이어야 증분 = bulk).
#   /*row_src*/…/*row_src_end*/  cit_hostless_per_row: 인용 행 자신의 도메인(ing.citation.domain_label = 현행 scope_citations.domain)이
#       NULL·빈 문자열이면 호스트 없는 인용(source_key 0). 현행 그룹 키 COALESCE(lower(domain), '') = '' 인 행이 도메인 목록에서 빠지고
#       ⑤ 분모에만 든다(citation-group-key.ts:57·context.ts:205-231). 허브 기본 = URL 단위 최빈 도메인(rd.dim_url.source_key).
#   /*web_tgt*/…/*web_tgt_end*/  web_owned_target_base: 웹사이트 loc_owned 의 타겟 항 = 인용 base NORM ∈ 유닛 타겟 base NORM
#       (현행 unitOwnedSql surface-website.ts:244-256, turl_base = citation_url_base_norm(target_url)). 허브 기본 = tracked NORM ∈ rd.web_unit.turls.
#       유닛 경계(사이트 × file_seq·프로젝트 매핑)는 허브 rd.web_unit 그대로다(타겟 비교 키만 바꾼다).
ROW_SRC_ON = "CASE WHEN coalesce(c.domain_label, '') = '' THEN 0 ELSE coalesce(u.source_key, 0) END"
# 유닛 타겟 base NORM = rd.web_unit.turls(tracked NORM = pg_temp.cit_norm(target_url), 유닛 매핑·Scope 등록 프롬프트는 허브 유닛 그대로)에서
# 쿼리를 떼고 끝 슬래시를 지운 값. cit_norm 이 스킴·www·프래그먼트를 이미 지웠으므로 pg_temp.cit_base_norm(target_url) 과 같다
# (둘 다 lower·스킴·www 1회·'?'·'#' 앞·끝 '/' 제거. 다른 경우 = 'www.www.' 이중 접두 같은 병적 URL 뿐).
WEB_TGT_ON = ("(coalesce(c.url_base_norm, '') <> ''\n"
              "          AND c.url_base_norm = ANY (ARRAY(SELECT rtrim(split_part(t, '?', 1), '/') FROM unnest(w.turls) t)))")
_MARK = re.compile(r"/\*(row_src|web_tgt)\*/(.*?)/\*\1_end\*/", re.S)


def fact_src_sql(sql: str, profile=None) -> str:
    """FACT_SRC 표식을 프로필(기본 = 활성 프로필)에 따라 바꾼 SQL. 꺼짐이면 표식만 지운다(도입 전 문장과 같다)."""
    from app.core.profile import active_profile

    prof = profile if profile is not None else active_profile()

    def sub(m: re.Match) -> str:
        if m.group(1) == "row_src":
            return ROW_SRC_ON if prof.cit_hostless_per_row else m.group(2)
        return WEB_TGT_ON if prof.web_owned_target_base else m.group(2)

    return _MARK.sub(sub, sql)

RUN_PROJECTS = "SELECT DISTINCT scope_project_id FROM ing.run WHERE run_id IN (SELECT DISTINCT run_id FROM _ig_jobs)"
LEAVES = "SELECT DISTINCT surface, date_trunc('month', round_date)::date AS m FROM _ig_ans ORDER BY 1, 2"

# ── 8. 삽입(seed-40 §7). load_id·rule_ver 는 이 적재 값 ─────────────────────────
INSERT_JOB = """
INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key,
                    lang_key, bgrp, status_code, analysis_code, dropped, served, load_id)
SELECT j.answer_key, j.job_id, j.run_key, j.prompt_key, j.cyc_key, j.round_date, j.measured_at, j.surface, j.project_key, j.engine_key,
       j.geo_key, j.lang_key, j.bgrp, j.status_code, coalesce(a.analysis_state, 0), j.dropped, (j.status_code = 0 AND NOT j.dropped), $1
  FROM _ig_job j LEFT JOIN _ig_ans a ON a.answer_key = j.answer_key
"""
INSERT_ANSWER = """
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state,
                       own_mask, own_rk_h, own_rk_k, own_rk_g, ment_total, ment_h, ment_k, ment_g,
                       sent_pos_h, sent_pos_k, sent_pos_g, sent_neg_h, sent_neg_k, sent_neg_g, sent_all_h, sent_all_k, sent_all_g, t_own,
                       elig, dflt, is_acr, is_rep, web_reg, has_cit, tgt_cited, own_url_cited, rule_ver, load_id,
                       cit_n, cit_own_h, cit_own_k, cit_own_g, cit_own_hc, cit_own_kc, cit_own_gc, cit_own_x, cit_loc, cit_tgt, cit_loc_tgt,
                       cit_off, elig_nc, std_in_nc, cit_in_nc,
                       cit_n_all, cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9, cit_c10, cit_c11, cit_c12, cit_c13, ecat_ver,
                       region_geo_key)
SELECT a.round_date, a.answer_key, a.anchor_date, a.cyc_key, a.run_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.cat_mask, a.bgrp, a.anchor_src, a.acr_iter_rank, a.analysis_state,
       coalesce(o.own_mask, 0), coalesce(o.own_rk_h, 0), coalesce(o.own_rk_k, 0), coalesce(o.own_rk_g, 0),
       coalesce(o.ment_total, 0), coalesce(o.ment_h, 0), coalesce(o.ment_k, 0), coalesce(o.ment_g, 0),
       coalesce(o.sent_pos_h, 0), coalesce(o.sent_pos_k, 0), coalesce(o.sent_pos_g, 0),
       coalesce(o.sent_neg_h, 0), coalesce(o.sent_neg_k, 0), coalesce(o.sent_neg_g, 0),
       coalesce(o.sent_all_h, 0), coalesce(o.sent_all_k, 0), coalesce(o.sent_all_g, 0), coalesce(o.t_own, 0),
       a.elig, a.dflt, a.is_acr, false, a.web_reg,
       coalesce(f.has_cit, false), coalesce(f.tgt_cited, false), coalesce(f.own_url_cited, false), $1, $2,
       coalesce(t.cit_n, 0), coalesce(t.cit_own_h, 0), coalesce(t.cit_own_k, 0), coalesce(t.cit_own_g, 0),
       coalesce(t.cit_own_hc, 0), coalesce(t.cit_own_kc, 0), coalesce(t.cit_own_gc, 0), coalesce(t.cit_own_x, 0),
       coalesce(t.cit_loc, 0), coalesce(t.cit_tgt, 0), coalesce(t.cit_loc_tgt, 0), coalesce(t.cit_off, 0), a.elig_nc, a.std_in_nc, a.cit_in_nc,
       coalesce(t.cit_n_all, 0), coalesce(t.cit_c1, 0), coalesce(t.cit_c2, 0), coalesce(t.cit_c3, 0), coalesce(t.cit_c4, 0), coalesce(t.cit_c5, 0), coalesce(t.cit_c6, 0), coalesce(t.cit_c7, 0), coalesce(t.cit_c8, 0), coalesce(t.cit_c9, 0), coalesce(t.cit_c10, 0), coalesce(t.cit_c11, 0), coalesce(t.cit_c12, 0), coalesce(t.cit_c13, 0),
       a.ecat_ver::int2, a.region_geo_key
  FROM _ig_ans a LEFT JOIN _ig_own o ON o.answer_key = a.answer_key LEFT JOIN _ig_citf f ON f.answer_key = a.answer_key
  LEFT JOIN _ig_citc t ON t.answer_key = a.answer_key
"""
INSERT_BRAND = """
INSERT INTO rd.answer_brand (round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key, bgrp,
                             own_bit, entity_rows, mention_count, rk, s_pos, s_neu, s_neg, s_mix,
                             t_mention, t_recommendation, t_comparison, t_definition, t_final_choice,
                             competitive, std_in, elig, dflt, rule_ver, std_in_nc, rid_n, is_rep)
SELECT a.round_date, b.answer_key, b.brand_key, a.cyc_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key, a.lang_key, a.bgrp,
       b.own_bit, b.entity_rows, b.mention_count, b.rk, b.s_pos, b.s_neu, b.s_neg, b.s_mix,
       b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice,
       b.competitive, a.std_in, a.elig, a.dflt, $1, a.std_in_nc, b.rid_n, a.is_rep
  FROM _ig_ab b JOIN _ig_ans a ON a.answer_key = b.answer_key
"""
INSERT_STANCE = """
INSERT INTO rd.answer_stance (round_date, answer_key, entity_key, brand_key, surface, turn_index, own_bit, stance, first_turn, std_in, cyc_key,
                              std_in_nc, is_rep)
SELECT a.round_date, a.answer_key, e.entity_key, coalesce(b.brand_key, 0), a.surface, st.turn_index, coalesce(b.own_bit, 0),
       (CASE st.stance WHEN 'positive' THEN 1 WHEN 'neutral' THEN 2 WHEN 'mixed' THEN 3 WHEN 'negative' THEN 4 END)::int2,
       st.turn_index = min(st.turn_index) OVER (PARTITION BY a.answer_key, st.entity_id),
       a.std_in, a.cyc_key, a.std_in_nc, a.is_rep
  FROM _ig_ans a
  JOIN ing.answer_stance st ON st.run_month = a.run_month AND st.job_id = a.job_id
  JOIN rd.dim_entity e ON e.entity_id = st.entity_id
  LEFT JOIN _ecat_x xs ON xs.ver = a.ecat_ver AND xs.entity_id = st.entity_id AND xs.removed      -- E1: 제거 엔티티 스탠스 제외
  LEFT JOIN _ig_pairs p ON p.ver = a.ecat_ver AND NOT p.ovr
                       AND p.dkey = coalesce(st.brand_label, '') AND p.dnull = (st.brand_label IS NULL) AND p.rollup = st.entity_id
  LEFT JOIN rd.dim_brand_name b ON b.bare = p.bare
 WHERE xs.entity_id IS NULL
"""
INSERT_CITATION = """
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver, cit_in_nc, is_rep)
SELECT c.round_date, c.answer_key, c.url_key, c.source_key, c.cyc_key, c.prompt_key, c.surface, c.ord, c.project_key, c.engine_key, c.geo_key,
       c.lang_key, c.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt, c.loc_owned, c.tgt_hit, c.src_first, $1, c.cit_in_nc, a.is_rep
  FROM _ig_cr c JOIN _ig_ans a ON a.answer_key = c.answer_key
"""

# ── 9. R05 대표(is_rep) 셀 재선정: 새 셀 ∪ 옛 셀. 셀 = (surface, round_date, cyc, prompt, engine, geo) ─────────
#   순서(DB-v2.15 P85, WU-2): rd.job·rd.answer 삽입 → 셀 재선정 → REP_STAGE → 자식 삽입(is_rep = 부모 최종값). 재선정은 rd.answer·rd.job 만 읽는다.
REP_CELLS = """
INSERT INTO _ig_cells SELECT DISTINCT surface, round_date, cyc_key, prompt_key, engine_key, geo_key FROM _ig_ans;
DROP TABLE IF EXISTS _ig_cellu;
CREATE TEMP TABLE _ig_cellu ON COMMIT DROP AS SELECT DISTINCT * FROM _ig_cells;
"""
# 규칙 둘(현행 프로필 rep_pick_latest_first = 적재기 활성 프로필, core.profile. 정본 = DB 함수 rd.rep_expected(DB-v2.15 P85), 시험이 대조한다).
# 적재 함수 service.project 가 고른다(결과 캐시 쓰기 분류 tests/core/rcache_writers.py 에 두 상수 등록).
#   REP_UPDATE               hub(기본): 셀 elig 후보 안 measured_at DESC NULLS LAST, answer_key DESC 1건
#   REP_UPDATE_LATEST_FIRST  현행: 셀 서빙 답변 전부에서 measured_at DESC NULLS FIRST, job_id 1건을 먼저 굳히고 elig_nc 가 아니면 대표 없음
#   REP_UPDATE_SEAT          현행 답변분석 경로(rep_round_date_cell, WU-12, 위 둘보다 우선): is_rep = round_date 셀 규칙(원본 시각), 인용 계열은 rd.rep_cit_delta 보정
#                            (게이트 = 카탈로그 무관 elig_nc, DB-v2.15 P89: 현행 선정은 카탈로그를 보지 않고 카탈로그는 조회 때 건다. WU-4 A41)
# 대표 재선정 뒤 이 적재 답변의 최종 is_rep 을 투영 임시 표로(자식 INSERT 가 부모 사본을 바로 쓴다: 같은 입력 재적재 = 전파 0행)
REP_STAGE = """
ALTER TABLE _ig_ans ADD COLUMN IF NOT EXISTS is_rep bool;
UPDATE _ig_ans s SET is_rep = a.is_rep
  FROM rd.answer a WHERE a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key;
"""
REP_UPDATE = """
WITH c AS (SELECT a.surface, a.round_date, a.answer_key, a.is_rep, a.elig, j.measured_at, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
             FROM _ig_cellu u
             JOIN rd.answer a ON a.surface = u.surface AND a.round_date = u.round_date AND a.cyc_key = u.cyc_key
                             AND a.prompt_key = u.prompt_key AND a.engine_key = u.engine_key AND a.geo_key = u.geo_key
             JOIN rd.job j ON j.answer_key = a.answer_key),
r AS (SELECT c.surface, c.round_date, c.answer_key, c.is_rep,
             (c.elig AND row_number() OVER (PARTITION BY c.surface, c.cyc_key, c.prompt_key, c.engine_key, c.geo_key, c.elig
                                            ORDER BY c.measured_at DESC NULLS LAST, c.answer_key DESC) = 1) AS rep
        FROM c)
UPDATE rd.answer a SET is_rep = r.rep
  FROM r WHERE a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key AND a.is_rep IS DISTINCT FROM r.rep
RETURNING a.answer_key, r.answer_key IN (SELECT answer_key FROM _ig_s) AS own
"""
REP_UPDATE_LATEST_FIRST = """
WITH c AS (SELECT a.surface, a.round_date, a.answer_key, a.is_rep, a.elig_nc, j.measured_at, j.job_id, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
             FROM _ig_cellu u
             JOIN rd.answer a ON a.surface = u.surface AND a.round_date = u.round_date AND a.cyc_key = u.cyc_key
                             AND a.prompt_key = u.prompt_key AND a.engine_key = u.engine_key AND a.geo_key = u.geo_key
             JOIN rd.job j ON j.answer_key = a.answer_key),
r AS (SELECT c.surface, c.round_date, c.answer_key, c.is_rep,
             (c.elig_nc AND row_number() OVER (PARTITION BY c.surface, c.cyc_key, c.prompt_key, c.engine_key, c.geo_key
                                               ORDER BY c.measured_at DESC NULLS FIRST, c.job_id) = 1) AS rep
        FROM c)
UPDATE rd.answer a SET is_rep = r.rep
  FROM r WHERE a.surface = r.surface AND a.round_date = r.round_date AND a.answer_key = r.answer_key AND a.is_rep IS DISTINCT FROM r.rep
RETURNING a.answer_key, r.answer_key IN (SELECT answer_key FROM _ig_s) AS own
"""
# 답변분석 경로 셀 대표(현행 프로필 rep_round_date_cell, DB-v2.19 P110, WU-12): 이 적재의 셀(새 ∪ 옛)이 속한 (표면, round_date, 프롬프트, 엔진) 범위를
# rd.reselect_rep_seat 로 다시 고른다(is_rep = 답변분석 규칙, 보정 표 rd.rep_cit_delta = 인용 계열). 범위가 비면 빈 배열(NULL 이면 함수가 전체 범위로 읽는다: 막는다).
REP_UPDATE_SEAT = """
WITH x AS (SELECT DISTINCT surface, round_date, prompt_key, engine_key FROM _ig_cellu),
s AS (SELECT coalesce(array_agg(surface), ARRAY[]::int2[]) AS sf, coalesce(array_agg(round_date), ARRAY[]::date[]) AS rd,
             coalesce(array_agg(prompt_key), ARRAY[]::int4[]) AS pk, coalesce(array_agg(engine_key), ARRAY[]::int2[]) AS ek FROM x)
SELECT f.answer_key, f.answer_key IN (SELECT answer_key FROM _ig_s) AS own
  FROM s CROSS JOIN LATERAL rd.reselect_rep_seat(s.sf, s.rd, s.pk, s.ek) f
"""

# ── 10. 불변식(seed-40 §8 ④·⑤·⑥·⑦·⑧ 을 _ig_s 로 좁힘) ────────────────────────
SERVED_KEYS = "SELECT answer_key FROM rd.job WHERE answer_key IN (SELECT answer_key FROM _ig_s) AND served ORDER BY answer_key"
ASSERT_OWN = """
SELECT count(*) FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
  LEFT JOIN (SELECT c.surface, c.round_date, c.answer_key,
                    coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0) AS own_mask,
                    coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0) AS rk_h,
                    coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0) AS rk_k,
                    coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0) AS rk_g,
                    coalesce(sum(mention_count) FILTER (WHERE competitive), 0) AS mt,
                    coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0) AS mh,
                    coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0) AS mk,
                    coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0) AS mg,
                    coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0) AS ph, coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0) AS pk,
                    coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0) AS pg,
                    coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0) AS nh, coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0) AS nk,
                    coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0) AS ng,
                    coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0) AS ah,
                    coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0) AS ak,
                    coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0) AS ag,
                    coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0) AS tw
               FROM rd.job jj JOIN rd.answer_brand c ON c.surface = jj.surface AND c.round_date = jj.round_date AND c.answer_key = jj.answer_key
              WHERE jj.answer_key IN (SELECT answer_key FROM _ig_s) GROUP BY 1, 2, 3) b
    ON b.surface = a.surface AND b.round_date = a.round_date AND b.answer_key = a.answer_key
 WHERE j.answer_key IN (SELECT answer_key FROM _ig_s)
   AND (a.own_mask, a.own_rk_h, a.own_rk_k, a.own_rk_g, a.ment_total, a.ment_h, a.ment_k, a.ment_g,
        a.sent_pos_h, a.sent_pos_k, a.sent_pos_g, a.sent_neg_h, a.sent_neg_k, a.sent_neg_g, a.sent_all_h, a.sent_all_k, a.sent_all_g, a.t_own)
       IS DISTINCT FROM
       (coalesce(b.own_mask, 0), coalesce(b.rk_h, 0), coalesce(b.rk_k, 0), coalesce(b.rk_g, 0), coalesce(b.mt, 0), coalesce(b.mh, 0),
        coalesce(b.mk, 0), coalesce(b.mg, 0), coalesce(b.ph, 0), coalesce(b.pk, 0), coalesce(b.pg, 0), coalesce(b.nh, 0), coalesce(b.nk, 0),
        coalesce(b.ng, 0), coalesce(b.ah, 0), coalesce(b.ak, 0), coalesce(b.ag, 0), coalesce(b.tw, 0))
"""
# DB-v2.15 P86(WU-5): 이 적재가 쓴 cit_n_all·cit_c1..13 = 정본 재계산(rd.answer_cit_ext, 자식 rd.citation 합). 위반 행 수(0 이어야 한다)
ASSERT_CIT_EXT = """
SELECT count(*) FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
  LEFT JOIN rd.answer_cit_ext($1::int4[]) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
 WHERE j.answer_key = ANY ($1::int4[]) AND j.served
   AND (a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11, a.cit_c12, a.cit_c13)
       IS DISTINCT FROM
       (coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2, coalesce(x.cit_c3, 0)::int2, coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2, coalesce(x.cit_c7, 0)::int2, coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2, coalesce(x.cit_c11, 0)::int2, coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2)
"""
# DB-v2.15 P87(WU-7): 이 적재가 쓴 region_geo_key = 정본 재계산(rd.answer_region_geo). 위반 행 수(0 이어야 한다). NULL 도 위반이다
#   (적재가 열을 빠뜨리면 rd.assert_answer_v215 가 뒤에 깨진다: stg 2026-10-01 재투영 17,488 답변 NULL 사례)
ASSERT_REGION_GEO = """
SELECT count(*) FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
  LEFT JOIN rd.answer_region_geo($1::int4[]) g ON g.surface = j.surface AND g.round_date = j.round_date AND g.answer_key = j.answer_key
 WHERE j.answer_key = ANY ($1::int4[]) AND j.served AND a.region_geo_key IS DISTINCT FROM g.region_geo_key
"""
ASSERT_GRAIN = """
SELECT (SELECT count(*) FROM ing.citation c JOIN _ig_ans a ON a.run_month = c.run_month AND a.job_id = c.job_id)
     - (SELECT count(*) FROM rd.job j JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
         WHERE j.answer_key IN (SELECT answer_key FROM _ig_s)) AS cit_diff,
       (SELECT count(*) FROM ing.answer_stance c JOIN _ig_ans a ON a.run_month = c.run_month AND a.job_id = c.job_id
         WHERE NOT EXISTS (SELECT 1 FROM _ecat_x x WHERE x.ver = a.ecat_ver AND x.entity_id = c.entity_id AND x.removed))
     - (SELECT count(*) FROM rd.job j JOIN rd.answer_stance c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
         WHERE j.answer_key IN (SELECT answer_key FROM _ig_s)) AS st_diff
"""
CHILD_COUNTS = """
SELECT (SELECT count(*) FROM _ig_ab) + (SELECT count(*) FROM _ig_cr)
     + (SELECT count(*) FROM ing.answer_stance st JOIN _ig_ans a ON a.run_month = st.run_month AND a.job_id = st.job_id
         WHERE NOT EXISTS (SELECT 1 FROM _ecat_x x WHERE x.ver = a.ecat_ver AND x.entity_id = st.entity_id AND x.removed)) AS n,
       (SELECT count(*) FROM _ig_ans) AS answers
"""

# ── 11. ACR(seed-40 §9 를 _ig_pr 로 좁힘) ────────────────────────────────────
ACR_DELETE = """
DELETE FROM rd.acr_choice WHERE acr_cell_key IN (SELECT p.acr_cell_key FROM ing.acr_prompt_run p WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr));
DELETE FROM rd.acr_cell_job WHERE acr_cell_key IN (SELECT p.acr_cell_key FROM ing.acr_prompt_run p WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr));
DROP TABLE IF EXISTS _ig_acr_old;
CREATE TEMP TABLE _ig_acr_old ON COMMIT DROP AS
SELECT c.surface, c.cyc_key, c.prompt_key, c.engine_key, c.geo_key FROM rd.acr_cell c
 WHERE c.acr_cell_key IN (SELECT p.acr_cell_key FROM ing.acr_prompt_run p WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr));
DELETE FROM rd.acr_cell WHERE acr_cell_key IN (SELECT p.acr_cell_key FROM ing.acr_prompt_run p WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr));
"""
ACR_RUNC_MISSING = """
SELECT count(*) FROM ing.acr_prompt_run p WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)
   AND NOT EXISTS (SELECT 1 FROM _ig_runc rc WHERE rc.run_id = p.run_id)
"""
ACR_PREP = """
DROP TABLE IF EXISTS _ig_acr;
CREATE TEMP TABLE _ig_acr ON COMMIT DROP AS
SELECT p.acr_cell_key, p.prompt_run_id, p.run_id, p.target, p.region, p.measured_at, p.planned_iterations, p.valid_turn1_iterations,
       p.valid_acr_iterations, p.co_single_entity, p.co_conditional_multiple, p.co_generic_category, p.co_resolved_off_shortlist,
       p.co_unresolved_choice, p.co_none, p.source_job_ids,
       rc.cyc_key, c.round_date, c.anchor_date, dp.surface, dp.project_key, rc.run_status,
       coalesce(pr.prompt_key, 0) AS prompt_key, coalesce(pr.kind, 'single') AS kind, coalesce(pr.cat_mask, 0::int2) AS cat_mask,
       coalesce(pr.lang_key, 0::int2) AS lang_key, coalesce(pr.in_root_catalog, false) AS in_root_catalog, coalesce(pr.is_korean, false) AS is_korean,
       pr.regions AS p_regions, coalesce(e.engine_key, 0::int2) AS engine_key,
       (CASE WHEN dp.surface = 2 THEN coalesce(ws.geo_key, nullif(dp.site_geo_key, 0), gr.geo_key, 0) ELSE coalesce(gr.geo_key, 0) END)::int2 AS geo_key,
       coalesce(gr.hidden_standard, false) AS region_hidden,
       (CASE dp.surface WHEN 1 THEN coalesce(pr.cat_mask, 0) WHEN 2 THEN coalesce(wb.brand_bit, nullif(dp.site_brand_bit, 0), 0)
                        ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bgrp,
       coalesce(CASE WHEN NOT cfg.force THEN c.ecat_ver::int4 END, cfg.dv) AS ecat_ver   -- E1: prompt-run 버전 = run 회차 고정 → 기준 버전
  FROM ing.acr_prompt_run p
  CROSS JOIN _ecat_cfg cfg
  JOIN _ig_runc rc ON rc.run_id = p.run_id
  JOIN rd.cycle c ON c.cyc_key = rc.cyc_key
  JOIN rd.dim_project dp ON dp.project_key = c.project_key
  LEFT JOIN rd.dim_prompt pr ON pr.prompt_id = p.prompt_id
  LEFT JOIN rd.dim_engine e ON e.code = p.target
  LEFT JOIN rd.dim_country gr ON upper(gr.code) = upper(p.region)
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = p.prompt_id AND dp.surface = 2
  LEFT JOIN rd.dim_country ws ON upper(ws.code) = upper(wpk.country_code)
  LEFT JOIN app.brand wb ON wb.brand_code = wpk.brand_code
  LEFT JOIN app.project pj ON pj.project_id = dp.project_id AND dp.surface = 3
  LEFT JOIN app.brand pb ON pb.brand_code = pj.brand_code
 WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr);
ALTER TABLE _ig_acr ADD COLUMN acr_in bool;
UPDATE _ig_acr SET acr_in =
  run_status IN ('completed', 'partial_failed') AND kind = 'acr'
  AND (surface <> 1 OR (in_root_catalog
       AND NOT (region_hidden OR (region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
       AND coalesce(NOT (region <> 'KR' AND is_korean
                         AND (measured_at IS NULL OR measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                              OR p_regions IS NULL OR cardinality(p_regions) = 0)), false)
       AND (p_regions IS NULL OR cardinality(p_regions) = 0 OR coalesce(region = ANY (p_regions), false))));
"""
ACR_INSERT_CELL = """
INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
SELECT acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
       planned_iterations, valid_turn1_iterations, valid_acr_iterations, co_single_entity, co_conditional_multiple, co_generic_category,
       co_resolved_off_shortlist, co_unresolved_choice, co_none, false, acr_in,
       coalesce((measured_at AT TIME ZONE 'Asia/Seoul')::date, anchor_date), $1
  FROM _ig_acr
"""
ACR_INSERT_REST = """
INSERT INTO rd.acr_cell_job (answer_key, acr_cell_key)
SELECT DISTINCT k.answer_key, a.acr_cell_key
  FROM _ig_acr a CROSS JOIN LATERAL unnest(a.source_job_ids) sj(job_id) JOIN ing.answer_key_map k ON k.job_id = sj.job_id;
INSERT INTO rd.acr_choice (acr_cell_key, entity_key, brand_key, parent_brand_key, level, own_bit, name_own,
                           appearance, choice, cond_choice, off_shortlist, unresolved, generic, keep)
SELECT p.acr_cell_key, e.entity_key,
       CASE WHEN r.rollup_level = 'brand' THEN coalesce(b.brand_key, 0) ELSE 0 END,
       CASE WHEN r.rollup_level = 'product' THEN coalesce(pb.brand_key, 0) ELSE 0 END,
       (CASE r.rollup_level WHEN 'brand' THEN 1 WHEN 'product' THEN 2 ELSE 3 END)::int2,
       n.own_bit,
       (CASE WHEN r.rollup_level = 'brand' THEN coalesce(b.own_bit, 0) WHEN r.rollup_level = 'product' THEN coalesce(pb.own_bit, 0) ELSE 0 END)::int2,
       r.appearance_count, r.choice_count, r.conditional_choice_count, r.off_shortlist_choice_count, r.unresolved_choice_count,
       r.generic_choice_count, n.keep
  FROM ing.acr_rollup_row r
  JOIN ing.acr_prompt_run p ON p.prompt_run_id = r.prompt_run_id
  JOIN _ig_acr ax ON ax.prompt_run_id = r.prompt_run_id
  JOIN rd.dim_entity e ON e.entity_id = r.entity_id
  JOIN _ig_acr_nm n ON n.ver = ax.ecat_ver AND n.prompt_run_id = r.prompt_run_id AND n.entity_id = r.entity_id AND n.rollup_level = r.rollup_level
  LEFT JOIN rd.dim_brand_name b ON b.bare = n.bare AND n.bare <> ''
  LEFT JOIN rd.dim_brand_name pb ON pb.bare = n.parent_bare AND n.parent_bare <> ''
 WHERE r.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr) AND NOT n.dropped;
"""
# ACR 셀 대표(회차 내부 (cyc, prompt, engine, geo), acr_in 후보, measured_at DESC, acr_cell_key DESC): 새 셀 ∪ 옛 셀 제자리 재선정
ACR_REP = """
WITH cells AS (SELECT DISTINCT surface, cyc_key, prompt_key, engine_key, geo_key FROM _ig_acr
               UNION SELECT surface, cyc_key, prompt_key, engine_key, geo_key FROM _ig_acr_old),
c AS (SELECT a.acr_cell_key, a.is_rep, a.acr_in, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, p.measured_at
        FROM rd.acr_cell a JOIN cells x ON x.surface = a.surface AND x.cyc_key = a.cyc_key AND x.prompt_key = a.prompt_key
                                      AND x.engine_key = a.engine_key AND x.geo_key = a.geo_key
        JOIN ing.acr_prompt_run p ON p.acr_cell_key = a.acr_cell_key),
r AS (SELECT c.acr_cell_key, c.is_rep,
             (c.acr_in AND row_number() OVER (PARTITION BY c.cyc_key, c.prompt_key, c.engine_key, c.geo_key, c.acr_in
                                              ORDER BY c.measured_at DESC NULLS LAST, c.acr_cell_key DESC) = 1) AS rep FROM c)
UPDATE rd.acr_cell a SET is_rep = r.rep FROM r WHERE a.acr_cell_key = r.acr_cell_key AND a.is_rep IS DISTINCT FROM r.rep
"""
ACR_ASSERT = """
SELECT (SELECT count(*) FROM _ig_pr) - (SELECT count(*) FROM rd.acr_cell c JOIN ing.acr_prompt_run p ON p.acr_cell_key = c.acr_cell_key
                                         WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)) AS cell_diff,
       (SELECT count(*) FROM ing.acr_rollup_row r JOIN _ig_acr ax ON ax.prompt_run_id = r.prompt_run_id
         WHERE NOT EXISTS (SELECT 1 FROM _ecat_x x WHERE x.ver = ax.ecat_ver AND x.entity_id = r.entity_id AND x.removed))
     - (SELECT count(*) FROM rd.acr_choice c JOIN ing.acr_prompt_run p ON p.acr_cell_key = c.acr_cell_key
         WHERE p.prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr)) AS choice_diff
"""
TOUCHED_SURFACES = "SELECT DISTINCT surface FROM (SELECT surface FROM _ig_job UNION SELECT surface FROM _ig_old) x"
ACR_SURFACES = "SELECT DISTINCT surface FROM (SELECT surface FROM _ig_acr UNION SELECT surface FROM _ig_acr_old) x"
