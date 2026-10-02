-- ============================================================================
-- 1회 보정(stg·이미 적재된 DB): 동기화 S1 BE-A(hmg-geo 7639b9e..2670a16) 판정 규칙 표 반영 + 재판정 요청 (2026-09-30). **작성만, 실행은 메인 결정 뒤**.
--   A. BE-2(#302 ①) 표준 숨김 국가 비움: app.hidden_market ('global','ID') 삭제 → judgment_change 'hidden_market'(subject_texts {ID}).
--      재판정 = rd.dim_country.hidden_standard 해제 + 글로벌 ID 답변·region 없음 답변·ID ACR prompt-run 재투영(rejudge.py hidden_market).
--   B. BE-3(#313) 자사 base 접두 5건 국가 경로로: app.owned_base.prefix **제자리 UPDATE**(owner_key 보존. rd.dim_url.owner_key 가 FK 로
--      참조하므로 시드 재실행 = 새 키 + 옛 행 DELETE 는 막힌다) → judgment_change 'owned_base'(subject_texts = 새 접두).
--      재판정 = rd.dim_url.owner_key 전량 재판정(OWNER_REFRESH) + 바뀐 URL 을 인용한 답변 재투영(cit_own_* 재계산, 프로젝트 자사 접두 폴백 포함).
--   C. BE-1(#302 ③) 한국어 비-KR 태그 우선: 새 규칙이 저장값(거짓)을 참으로 바꾸는 표면 1 답변(elig)·ACR prompt-run(acr_in)의 프롬프트를
--      judgment_change 'scope_prompt'(subject_uuids)로 요청한다. 대상 = 한국어 ∧ 태그 있음 ∧ region ≠ 'KR' ∧ measured_at ≥ 2026-08-19T00:00Z
--      ∧ region ∈ 태그 ∧ 카탈로그 ∧ 숨김 국가 아님(A 반영 뒤) ∧ run completed·partial_failed ∧ 지금 저장값 거짓. 규칙이 푸는 방향뿐이라
--      참 → 거짓 대상은 없다. 묶음당 rd.job ≤ :batch_jobs(기본 50000, 적재기 escalate 상한 20만 아래).
--   D. 규칙 세트: seed-10 §6 과 **같은 13개 지문 식**(시험이 두 파일의 블록이 같음을 단언)을 지금 app 표로 계산해 같은 지문 행이 없으면
--      새 app.rule_set 행(= rule_ver 올림, 재판정이 쓰는 ctx.rule_ver). 이 뒤 2670a16 생성 시드를 다시 돌려도 같은 지문이면 재사용된다.
-- 실측(2026-09-30 stg 읽기 전용 s1bea-probe1): A 대상 1행(global ID), 글로벌 ID job 5,131(서빙 5,122·새 elig 추정 4,707), region 없는 글로벌 job 0,
--   ID ACR prompt-run 222. B 대상 5행(owner_key 30·71·91·95·129), 새 접두 행 0, 소유가 바뀌는 URL 7,220(전부 종전 소유 없음),
--   그 URL 을 인용한 답변 s1 1,018·s2 7,388·s3 240. C 한국어 프롬프트 630개 전부 태그 {KR} → 대상 0. rule_set 1행(rule_ver 1).
-- 선행: back 배포(동기화 S1 BE-1 queries.py) + 워커 재기동. 먼저 돌리면 C 요청을 옛 규칙이 처리해 효과 없이 applied 로 끝난다(A·B 는 규칙이
--   데이터라 순서 무관). 멱등: 다시 돌리면 A·B 0행·요청 0, C 는 저장값이 새 규칙과 같거나 대기 중 scope_prompt 요청이 있는 프롬프트를 뺀다,
--   D 는 같은 지문이면 재사용. 트랜잭션 1개, 행위자 = 시스템(이관 시드) 5eed…0001, actor_type system. 출력 = 개수·코드·키(PII·본문 없음).
--
-- 사용(드라이런이 기본: 끝에서 ROLLBACK):
--   psql -X -v ON_ERROR_STOP=1 -f fix-sync-s1-rules.sql                                                           # 드라이런, 대상·개수 확인
--   psql -X -v ON_ERROR_STOP=1 -v expect_be2=1 -v expect_be3=5 -v expect_be1=0 -v commit=1 -f fix-sync-s1-rules.sql   # 드라이런과 같을 때만 COMMIT
-- 뒤처리: 요청은 적재기 큐 소비(python -m ingest.cli queue, 한 행 = 한 트랜잭션)가 처리한다. stg 는 2026-09-30 기준 적재 워커·타이머가
--   없고(ing.load 이력 = seed·rebuild 뿐) 수동 1회 실행이 필요하다. 상태는 app.judgment_change(status applied·failed·escalated_rebuild).
--   결과 캐시: 추적 표(app.hidden_market·app.owned_base·rd.dim_*) 카운터·judgment_change 최대 id·세대(finalize)로 버전이 오르지만,
--   대역 밖 SQL 뒤 절차(DECISIONS-API '결과 캐시' 운영)대로 COMMIT 뒤 migrator 로 `SELECT app.result_cache_invalidate();`. 확인 쿼리는 파일 끝 주석.
-- ============================================================================
\if :{?expect_be1}
\else
\set expect_be1 -1
\endif
\if :{?expect_be2}
\else
\set expect_be2 -1
\endif
\if :{?expect_be3}
\else
\set expect_be3 -1
\endif
\if :{?batch_jobs}
\else
\set batch_jobs 50000
\endif
\set QUIET on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '10min';
SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001';
SET LOCAL app.actor_type = 'system';
SELECT set_config('fix.expect_be1', :'expect_be1', true) AS e1, set_config('fix.expect_be2', :'expect_be2', true) AS e2,
       set_config('fix.expect_be3', :'expect_be3', true) AS e3, set_config('fix.batch_jobs', :'batch_jobs', true) AS bj \gset fix_
\set QUIET off

DO $a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.user_account WHERE user_id = '5eed0000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION '시스템 사용자(5eed…0001) 없음: seed-10 이 먼저 적재돼야 한다';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.rule_set) THEN RAISE EXCEPTION 'app.rule_set 비어 있음'; END IF;
  IF current_setting('fix.batch_jobs')::int < 1 THEN RAISE EXCEPTION 'batch_jobs 는 1 이상'; END IF;
END $a$;

CREATE TEMP TABLE _pre ON COMMIT DROP AS
SELECT (SELECT count(*) FROM app.owned_base) AS ob, (SELECT array_agg(owner_key ORDER BY owner_key) FROM app.owned_base) AS ob_keys,
       (SELECT coalesce(max(change_id), 0) FROM app.judgment_change) AS jc, (SELECT max(rule_ver) FROM app.rule_set) AS rv;

-- ── A. BE-2: 표준 숨김 국가 ID 해제 ─────────────────────────────────────────────
CREATE TEMP TABLE _be2 ON COMMIT DROP AS
WITH d AS (DELETE FROM app.hidden_market WHERE surface = 'global' AND upper(country_code) = 'ID' RETURNING surface, country_code)
SELECT * FROM d;
SELECT 'be2_deleted', surface, country_code FROM _be2 ORDER BY 2, 3;

-- ── B. BE-3: 자사 base 접두 제자리 UPDATE ──────────────────────────────────────
CREATE TEMP TABLE _fix (old text PRIMARY KEY, new text NOT NULL UNIQUE) ON COMMIT DROP;
INSERT INTO _fix VALUES ('kia.com/au/en', 'kia.com/au'), ('kia.com/it/it', 'kia.com/it'), ('kia.com/tr/anasayfa', 'kia.com/tr'),
                        ('kia.com/my/en', 'kia.com/my'), ('hyundai.com/cz/cz', 'hyundai.com/cz');
CREATE TEMP TABLE _be3_state ON COMMIT DROP AS
SELECT f.old, f.new, o1.owner_key AS old_key, o2.owner_key AS new_key, o1.host AS old_host
  FROM _fix f
  LEFT JOIN app.owned_base o1 ON o1.kind = 'base' AND o1.prefix = f.old
  LEFT JOIN app.owned_base o2 ON o2.kind = 'base' AND o2.prefix = f.new;
SELECT 'be3_state', old, new, coalesce(old_key::text, '-') AS old_key, coalesce(new_key::text, '-') AS new_key FROM _be3_state ORDER BY old;
DO $a$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM _be3_state WHERE old_key IS NOT NULL AND new_key IS NOT NULL;
  IF v > 0 THEN RAISE EXCEPTION 'BE-3 옛·새 접두 행이 둘 다 있다 %건(수동 확인: 시드를 옛 행 위에 다시 돌렸는가)', v; END IF;
  SELECT count(*) INTO v FROM _be3_state WHERE old_key IS NULL AND new_key IS NULL;
  IF v > 0 THEN RAISE EXCEPTION 'BE-3 옛·새 접두 행이 둘 다 없다 %건(카탈로그가 예상과 다름)', v; END IF;
  SELECT count(*) INTO v FROM _be3_state WHERE old_key IS NOT NULL AND old_host IS DISTINCT FROM split_part(new, '/', 1);
  IF v > 0 THEN RAISE EXCEPTION 'BE-3 호스트가 바뀌는 접두 %건', v; END IF;
END $a$;
CREATE TEMP TABLE _be3 ON COMMIT DROP AS
WITH up AS (UPDATE app.owned_base o SET prefix = f.new FROM _fix f WHERE o.kind = 'base' AND o.prefix = f.old
             RETURNING o.owner_key, f.old, o.prefix AS new)
SELECT * FROM up;
SELECT 'be3_updated', owner_key, old, new FROM _be3 ORDER BY owner_key;
-- 참고: 새 접두 아래에 더 긴 base 가 있으면(형제 분리) 그 base 가 우선한다(owner_key_of 최장 일치)
SELECT 'be3_longer_bases_under_new', f.new, count(o.*) FROM _fix f
  LEFT JOIN app.owned_base o ON o.kind = 'base' AND starts_with(o.prefix, f.new || '/') GROUP BY f.new ORDER BY f.new;

-- ── C. BE-1: 새 규칙이 참으로 바꾸는 한국어 비-KR 셀의 프롬프트 ─────────────────
CREATE TEMP TABLE _be1_ans ON COMMIT DROP AS
SELECT dp.prompt_id, j.answer_key
  FROM rd.job j
  JOIN rd.dim_prompt dp ON dp.prompt_key = j.prompt_key AND dp.is_korean AND cardinality(dp.regions) > 0 AND dp.in_root_catalog
  JOIN rd.answer ra ON ra.surface = j.surface AND ra.round_date = j.round_date AND ra.answer_key = j.answer_key AND NOT ra.elig
  JOIN ing.answer_key_map km ON km.answer_key = j.answer_key
  JOIN ing.answer x ON x.run_month = km.run_month AND x.job_id = km.job_id
  JOIN ing.run r ON r.run_id = x.run_id
 WHERE j.surface = 1 AND x.region <> 'KR' AND x.measured_at >= TIMESTAMPTZ '2026-08-19 00:00:00+00' AND x.region = ANY (dp.regions)
   AND r.status IN ('completed', 'partial_failed')
   AND NOT EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global' AND upper(h.country_code) = upper(x.region));
CREATE TEMP TABLE _be1_acr ON COMMIT DROP AS
SELECT dp.prompt_id, p.prompt_run_id
  FROM ing.acr_prompt_run p
  JOIN rd.acr_cell c ON c.acr_cell_key = p.acr_cell_key AND c.surface = 1 AND NOT c.acr_in
  JOIN rd.dim_prompt dp ON dp.prompt_id = p.prompt_id AND dp.kind = 'acr' AND dp.is_korean AND cardinality(dp.regions) > 0 AND dp.in_root_catalog
  JOIN ing.run r ON r.run_id = p.run_id
 WHERE p.region <> 'KR' AND p.measured_at >= TIMESTAMPTZ '2026-08-19 00:00:00+00' AND p.region = ANY (dp.regions)
   AND r.status IN ('completed', 'partial_failed')
   AND NOT EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global' AND upper(h.country_code) = upper(p.region));
CREATE TEMP TABLE _be1 ON COMMIT DROP AS
WITH p AS (SELECT prompt_id FROM _be1_ans UNION SELECT prompt_id FROM _be1_acr),
q AS (SELECT p.prompt_id, (SELECT count(*) FROM rd.job j JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key WHERE d.prompt_id = p.prompt_id) AS jobs
        FROM p
       WHERE NOT EXISTS (SELECT 1 FROM app.judgment_change c WHERE c.kind = 'scope_prompt' AND c.status IN ('pending', 'running')
                          AND p.prompt_id = ANY (c.subject_uuids)))
SELECT q.prompt_id, q.jobs,
       (((sum(greatest(q.jobs, 1)) OVER (ORDER BY q.prompt_id))::bigint - 1) / current_setting('fix.batch_jobs')::bigint)::int AS batch
  FROM q;
SELECT 'be1_targets(answers,acr_runs,prompts,batches,jobs_to_reproject)', (SELECT count(*) FROM _be1_ans), (SELECT count(*) FROM _be1_acr),
       (SELECT count(*) FROM _be1), (SELECT count(DISTINCT batch) FROM _be1), (SELECT coalesce(sum(jobs), 0) FROM _be1);

-- ── 재판정 요청 ────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _jc ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO app.judgment_change (kind, subject_uuids, subject_texts, payload, requested_by)
  SELECT 'hidden_market', NULL::uuid[], ARRAY['ID']::text[], jsonb_build_object('source', 'fix-sync-s1-rules', 'item', 'BE-2'), app.actor()
   WHERE EXISTS (SELECT 1 FROM _be2)
  UNION ALL
  SELECT 'owned_base', NULL::uuid[], (SELECT array_agg(new ORDER BY new) FROM _be3), jsonb_build_object('source', 'fix-sync-s1-rules', 'item', 'BE-3'), app.actor()
   WHERE EXISTS (SELECT 1 FROM _be3)
  UNION ALL
  SELECT 'scope_prompt', array_agg(prompt_id ORDER BY prompt_id), NULL::text[],
         jsonb_build_object('source', 'fix-sync-s1-rules', 'item', 'BE-1', 'batch', batch, 'jobs', sum(jobs)), app.actor()
    FROM _be1 GROUP BY batch
  RETURNING change_id, kind)
SELECT * FROM ins;
SELECT 'jc_enqueued', kind, count(*), min(change_id), max(change_id) FROM _jc GROUP BY kind ORDER BY kind;

-- ── D. 규칙 세트(seed-10 §6 과 같은 지문 식) ─────────────────────────────────────
CREATE TEMP TABLE _fp ON COMMIT DROP AS SELECT jsonb_build_object(
  'psl', '4430d16c91611b3b5c8b961f7bdc91d5e0b606b0f44cbc065c882228d1dd2d51', 'social', 'fdf15d4278acbd3dbaf70579b49babda407e7f1f300a750da5e8ae95c2d4a9c5', 'category_seed', 'f8b3f609b9a7299d6fe2d7876d19948bf3a29f2c3b1ee348517c35bbfbd79538',
  'owned_base', (SELECT md5(coalesce(string_agg(concat_ws('|', owner_key, kind, prefix, host, brand_code, geo_code, language), E'\n' ORDER BY owner_key), '')) FROM app.owned_base),
  'brand_prefix', (SELECT md5(coalesce(string_agg(concat_ws('|', brand_code, prefix, eval_order), E'\n' ORDER BY eval_order), '')) FROM app.brand_name_prefix),
  'brand_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias, canonical_name), E'\n' ORDER BY alias COLLATE "C"), '')) FROM app.brand_display_alias),
  'non_competitor', (SELECT md5(coalesce(string_agg(concat_ws('|', name, bare_only_pattern), E'\n' ORDER BY name COLLATE "C"), '')) FROM app.non_competitor_name),
  'competitor_token', (SELECT md5(coalesce(string_agg(concat_ws('|', token, brand_name), E'\n' ORDER BY token COLLATE "C"), '')) FROM app.competitor_domain_token),
  'entity_registry', (SELECT md5(coalesce(string_agg(concat_ws('|', entity_id, name, role, brand_code), E'\n' ORDER BY entity_id), '')) FROM app.entity_registry),
  'entity_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias_entity_id, canon_entity_id), E'\n' ORDER BY alias_entity_id), '')) FROM app.entity_alias),
  'hidden_market', (SELECT md5(coalesce(string_agg(concat_ws('|', surface, country_code), E'\n' ORDER BY surface, country_code), '')) FROM app.hidden_market),
  'rule_param', (SELECT md5(coalesce(string_agg(concat_ws('|', key, value::text), E'\n' ORDER BY key COLLATE "C"), '')) FROM app.rule_param),
  'website_catalog', (SELECT md5(coalesce((SELECT string_agg(concat_ws('|', site_id, brand_code, country_code, scope_project_id), E'\n' ORDER BY site_id) FROM app.website_site), '')
                        || coalesce((SELECT string_agg(concat_ws('|', website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, owned_base_url, scope_prompt_id), E'\n' ORDER BY website_prompt_id) FROM app.website_prompt), '')))
) AS fp;
SELECT 'fp_keys_changed_vs_last', coalesce(string_agg(k, ',' ORDER BY k), '-')
  FROM _fp, jsonb_object_keys(_fp.fp) k
 WHERE _fp.fp -> k IS DISTINCT FROM (SELECT r.fingerprints -> k FROM app.rule_set r ORDER BY r.rule_ver DESC LIMIT 1);
CREATE TEMP TABLE _rs ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO app.rule_set (fingerprints, note, created_by, applied_at)
  SELECT fp, 'fix-sync-s1-rules: 동기화 S1 BE-A(hmg-geo 2670a16) BE-1 한국어 비-KR 태그 우선 · BE-2 ID 숨김 해제 · BE-3 자사 base 5건',
         '5eed0000-0000-4000-8000-000000000001', now() FROM _fp
   WHERE NOT EXISTS (SELECT 1 FROM app.rule_set r WHERE r.fingerprints = (SELECT fp FROM _fp))
  RETURNING rule_ver)
SELECT * FROM ins;
SELECT 'rule_ver', (SELECT rv FROM _pre) AS before, (SELECT max(rule_ver) FROM app.rule_set) AS after,
       CASE WHEN EXISTS (SELECT 1 FROM _rs) THEN 'new' ELSE 'reused' END AS how;

-- ── 단언(실패 = 예외 = 전체 롤백) ─────────────────────────────────────────────
DO $a$ DECLARE
  pre record; n2 bigint; n3 bigint; n1 bigint; nb bigint; njc bigint; v bigint; keys int2[];
  e1 int := current_setting('fix.expect_be1')::int; e2 int := current_setting('fix.expect_be2')::int; e3 int := current_setting('fix.expect_be3')::int;
BEGIN
  SELECT * INTO pre FROM _pre;
  SELECT count(*) INTO n2 FROM _be2;  SELECT count(*) INTO n3 FROM _be3;  SELECT count(*) INTO n1 FROM _be1;
  SELECT count(DISTINCT batch) INTO nb FROM _be1;  SELECT count(*) INTO njc FROM _jc;
  IF e2 >= 0 AND n2 <> e2 THEN RAISE EXCEPTION 'BE-2 삭제 % <> 기대 %(드라이런과 다름)', n2, e2; END IF;
  IF e3 >= 0 AND n3 <> e3 THEN RAISE EXCEPTION 'BE-3 갱신 % <> 기대 %(드라이런과 다름)', n3, e3; END IF;
  IF e1 >= 0 AND n1 <> e1 THEN RAISE EXCEPTION 'BE-1 프롬프트 % <> 기대 %(드라이런과 다름)', n1, e1; END IF;
  IF n3 <> (SELECT count(*) FROM _be3_state WHERE old_key IS NOT NULL) THEN RAISE EXCEPTION 'BE-3 갱신 % <> 옛 접두 행 수', n3; END IF;
  -- 사후 상태: 숨김 ID 없음, 옛 접두 없음·새 접두 5행, owned_base 행·키 집합 불변(FK 안전)
  SELECT count(*) INTO v FROM app.hidden_market WHERE surface = 'global' AND upper(country_code) = 'ID';
  IF v <> 0 THEN RAISE EXCEPTION 'BE-2 뒤 숨김 ID 남음 %', v; END IF;
  SELECT count(*) INTO v FROM app.owned_base o JOIN _fix f ON f.old = o.prefix WHERE o.kind = 'base';
  IF v <> 0 THEN RAISE EXCEPTION 'BE-3 뒤 옛 접두 남음 %', v; END IF;
  SELECT count(*) INTO v FROM app.owned_base o JOIN _fix f ON f.new = o.prefix WHERE o.kind = 'base';
  IF v <> (SELECT count(*) FROM _fix) THEN RAISE EXCEPTION 'BE-3 뒤 새 접두 % <> %', v, (SELECT count(*) FROM _fix); END IF;
  SELECT array_agg(owner_key ORDER BY owner_key) INTO keys FROM app.owned_base;
  IF (SELECT count(*) FROM app.owned_base) <> pre.ob OR keys IS DISTINCT FROM pre.ob_keys THEN RAISE EXCEPTION 'app.owned_base 행·키 집합이 바뀜'; END IF;
  -- 요청 = (A 있으면 1) + (B 있으면 1) + C 묶음 수, 모두 이번 트랜잭션 행
  IF njc <> (n2 > 0)::int + (n3 > 0)::int + nb THEN RAISE EXCEPTION '재판정 요청 % <> 기대 %', njc, (n2 > 0)::int + (n3 > 0)::int + nb; END IF;
  SELECT count(*) INTO v FROM app.judgment_change WHERE change_id > pre.jc;
  IF v <> njc THEN RAISE EXCEPTION '이번 트랜잭션 밖 요청이 섞임 % <> %', v, njc; END IF;
  -- 규칙 세트: 지금 지문 행이 정확히 1개, 최신 rule_ver 가 그 행
  SELECT count(*) INTO v FROM app.rule_set r, _fp WHERE r.fingerprints = _fp.fp;
  IF v <> 1 THEN RAISE EXCEPTION 'rule_set 지문 행 %', v; END IF;
  IF EXISTS (SELECT 1 FROM _rs) AND (SELECT rule_ver FROM _rs) <> (SELECT max(rule_ver) FROM app.rule_set) THEN
    RAISE EXCEPTION '새 rule_set 이 최신이 아님';
  END IF;
  RAISE NOTICE 'FIX_OK be2=% be3=% be1_prompts=% be1_batches=% jc=% rule_ver=%→%', n2, n3, n1, nb, njc, pre.rv, (SELECT max(rule_ver) FROM app.rule_set);
END $a$;
SELECT 'result', (SELECT count(*) FROM _be2) AS be2_deleted, (SELECT count(*) FROM _be3) AS be3_updated, (SELECT count(*) FROM _be1) AS be1_prompts,
       (SELECT count(*) FROM _jc) AS jc_enqueued, (SELECT max(rule_ver) FROM app.rule_set) AS rule_ver;

\if :{?commit}
COMMIT;
SELECT 'mode', 'COMMIT';
\else
ROLLBACK;
SELECT 'mode', 'ROLLBACK(드라이런)';
\endif

-- 확인(COMMIT·큐 처리 뒤, 읽기 전용):
--   SELECT kind, status, count(*), max(error) FROM app.judgment_change WHERE payload->>'source' = 'fix-sync-s1-rules' GROUP BY 1, 2;
--   SELECT code, hidden_standard FROM rd.dim_country WHERE upper(code) = 'ID';                                   -- false
--   SELECT count(*) FILTER (WHERE a.elig) FROM rd.answer a JOIN rd.dim_country g ON g.geo_key = a.geo_key
--    WHERE a.surface = 1 AND upper(g.code) = 'ID';                                                               -- 새 elig(실측 추정 4,707 근방)
--   SELECT u.owner_key, count(*) FROM rd.dim_url u WHERE u.owner_key IN (30, 71, 91, 95, 129) GROUP BY 1;       -- 소유 URL 이 늘었다(stg 키)
--   escalated_rebuild 가 나오면: 그 요청의 subject 를 나눠(C 는 batch_jobs 를 줄여 다시 드라이런) 다시 넣거나 leaf 재구축(bulk seed-40)으로 넘긴다.
