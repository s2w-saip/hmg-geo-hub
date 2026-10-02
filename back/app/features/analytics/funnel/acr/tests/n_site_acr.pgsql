-- acr website 현대 N 계정 국가 옵션 회귀(test_acr_n_site_options.py) 준비 문장(소유자 실행, API 문장 아님). "-- name:" 단위로 읽어
-- core 롤백 전용 준비(tests.support.staged)로 실행한다. 사이트 90~94·회차 9901~9904·셀 9201~9204 만 쓴다(픽스처·다른 시험과 겹치지 않음).

-- name: site_ins
-- $1 project_key · $2 scope_project_id · $3 site_id · $4 site_brand_bit · $5 사이트 국가 코드
INSERT INTO rd.dim_project (project_key, scope_project_id, surface, is_root, project_id, site_id, site_brand_bit, site_geo_key)
VALUES ($1, $2, 2, false, NULL, $3, $4, (SELECT geo_key FROM rd.dim_country WHERE code = $5));

-- name: site_cycle_ins
-- $1 cyc_key · $2 cycle_id · $3 project_key · $4 round_date(노출 = 다음 날, 숨김 없음)
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable,
                      view_date, hidden_scope, generation)
VALUES ($1, $2, 2, $3, true, $4::date, $4::date, 2, true, $4::date + 1, 0, 1);

-- name: cell_ins
-- $1 acr_cell_key · $2 cyc_key · $3 project_key · $4 bgrp(사이트 브랜드 비트) · $5 셀 국가 코드 · $6 round_date. 엔진 chatgpt(기본)·언어 en·유효 2
INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
VALUES ($1, $6::date, $2, 8, 2, $4, $3, (SELECT engine_key FROM rd.dim_engine WHERE code = 'chatgpt'),
        (SELECT geo_key FROM rd.dim_country WHERE code = $5), (SELECT lang_key FROM rd.dim_lang WHERE code = 'en'), 0,
        2, 2, 2, 2, 0, 0, 0, 0, 0, true, true, $6::date, 1);
