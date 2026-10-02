-- options(F-1) 회귀 테스트용 준비 문장(소유자 실행, API 문장 아님). test_options.py 가 "-- name:" 단위로 읽어 core 롤백 전용 준비
-- (tests.support.staged)로 실행한다. 준비 SQL 은 데이터 파일로 둔다(back/tests/README.md 6절). 블록이 끝나면 ROLLBACK.

-- name: actor
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);

-- name: answer_ins
-- $1 round_date · $2 answer_key · $3 cyc_key · $4 run_key · $5 prompt_key · $6 surface · $7 project_key · $8 engine_key
-- $9 국가 코드 · $10 언어 코드 · $11 cat_mask · $12 bgrp
INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key,
                       geo_key, lang_key, cat_mask, bgrp, anchor_src, analysis_state, elig, dflt, rule_ver, load_id)
VALUES ($1::date, $2, $1::date, $3, $4, $5, $6, $7, $8,
        (SELECT geo_key FROM rd.dim_country WHERE code = $9), (SELECT lang_key FROM rd.dim_lang WHERE code = $10),
        $11, $12, 2, 0, true, true, 1, 3);

-- name: hide_cycle_11
UPDATE rd.cycle SET hidden_scope = $1::int2, hidden_reason = CASE WHEN $1::int2 = 0 THEN 0 ELSE 1 END WHERE cyc_key = 11;

-- name: site_ins
-- $1 project_key · $2 scope_project_id · $3 site_id · $4 site_brand_bit · $5 사이트 국가 코드
INSERT INTO rd.dim_project (project_key, scope_project_id, surface, is_root, project_id, site_id, site_brand_bit, site_geo_key)
VALUES ($1, $2, 2, false, NULL, $3, $4, (SELECT geo_key FROM rd.dim_country WHERE code = $5));

-- name: site_cycle_ins
-- $1 cyc_key · $2 cycle_id · $3 project_key · $4 round_date(노출 = 다음 날, 숨김 없음)
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable,
                      view_date, hidden_scope, generation)
VALUES ($1, $2, 2, $3, true, $4::date, $4::date, 2, true, $4::date + 1, 0, 1);

-- name: site_citation_ins
-- 사이트 91(Hyundai US) 답변 9102 의 인용 1건: source_key 4 = newsMedia
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key,
                         geo_key, lang_key, bgrp, scope_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
VALUES ('2026-09-18', 9102, 1, 4, 902, 8, 2, 1, 91, 2, (SELECT geo_key FROM rd.dim_country WHERE code = 'US'),
        (SELECT lang_key FROM rd.dim_lang WHERE code = 'en'), 1, 1, true, false, true, false, false, true, 1);

-- name: website_hidden_us
INSERT INTO app.hidden_market (surface, country_code, reason) VALUES ('website', 'US', 'test');

-- name: ensure_neighbour_leaves
SELECT rd.ensure_leaf(1::int2, DATE '2026-08-01'), rd.ensure_leaf(1::int2, DATE '2026-10-01');

-- name: depth4_marks
-- BG-03: 루트 카탈로그 행 c1..01(현대 best suv, depth3 없음)·c1..11(제네시스 같은 프롬프트)·고객 프로젝트 프롬프트에 depth4 를 단다(actor 필요).
UPDATE app.prompt SET depth4 = 'D4x' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000001';
UPDATE app.prompt SET depth4 = 'D4g' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000011';
UPDATE app.prompt SET depth4 = 'P4' WHERE prompt_id = 'c3000000-0000-4000-8000-000000000031';

-- name: legacy_job_ins
-- 현행 프로필 filter_options(WU-8): 글로벌 rd.job 1행(루트 프로젝트 1, 회차 11·09-14). $1 answer_key · $2 국가 코드 · $3 status_code
-- · $4 bgrp(cat_mask) · $5 engine_key. prompt_key 1(루트 카탈로그, en)·run_key 1·load_id 3 은 픽스처 k1 과 같다(rd.answer 행은 만들지 않는다).
INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key,
                    geo_key, lang_key, bgrp, status_code, analysis_code, dropped, served, load_id)
VALUES ($1, gen_random_uuid(), 1, 1, 11, DATE '2026-09-14', TIMESTAMPTZ '2026-09-14 03:00:00+00', 1, 1, $5,
        (SELECT geo_key FROM rd.dim_country WHERE code = $2), (SELECT lang_key FROM rd.dim_prompt WHERE prompt_key = 1),
        $4, $3, 0, false, false, 3);

-- name: legacy_site_ins
-- 등록 사이트(측정 이력 없음). $1 site_id · $2 brand_code · $3 country_code
INSERT INTO app.website_site (site_id, brand_code, country_code) VALUES ($1, $2, $3);

-- name: legacy_site_prompt_ins
-- $1 site_id · $2 lang_code · $3 seq_no
INSERT INTO app.website_prompt (site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text)
VALUES ($1, 900, 'example.test', $2, $3, 'https://example.test/', 'wu8 prompt');
