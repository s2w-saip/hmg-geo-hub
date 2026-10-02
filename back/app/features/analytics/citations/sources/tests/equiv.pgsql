-- /sources 성능 R2 동치 시험(test_sources_equiv.py) 추가 합성 준비(고객 데이터 아님). tests.support.staged 로 소유자가 실행하고 블록 끝에 ROLLBACK.
-- prompts/tests/staged.pgsql @global + domains/tests/bg.pgsql @share_tie 뒤에 얹는다. '-- name: x' 로 나눠 load_named_sql 로 읽는다.

-- name: tone_dup
-- share_tie 가 같은 URL 인용을 1,000·1,001건 더한 답변 9115(caranddriver)·9116(foo-bar)에 톤을 둔다: 9115 부정, 9116 긍정(현대 관점).
-- 톤 답변 안 (답변, url) 중복 → url 수(그룹 수)와 인용 수(그룹 합)가 크게 갈린다(종전 count(DISTINCT url) 대 count(*) 와 같은 값이어야 한다).
UPDATE rd.answer SET sent_pos_h = 0, sent_neg_h = 2
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key = 9115;
UPDATE rd.answer SET sent_pos_h = 3, sent_neg_h = 0
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key = 9116;

-- name: refresh_cit_ext
-- 인용 성능 수정안 B(WU-5) 답변 열 경로 시험: 앞선 준비가 rd.citation·rd.dim_source 를 직접 바꿨으므로(적재기 재투영 없음) 답변 인용 수 열
-- cit_n·cit_n_all·cit_c1..13 을 정본 재계산(rd.answer_cit_ext)으로 다시 맞춘다 = 적재기 재투영(apply.project)과 같은 값.
UPDATE rd.answer a SET cit_n = coalesce(x.cit_n, 0)::int2,
       cit_n_all = coalesce(x.cit_n_all, 0)::int2,
       cit_c1 = coalesce(x.cit_c1, 0)::int2,
       cit_c2 = coalesce(x.cit_c2, 0)::int2,
       cit_c3 = coalesce(x.cit_c3, 0)::int2,
       cit_c4 = coalesce(x.cit_c4, 0)::int2,
       cit_c5 = coalesce(x.cit_c5, 0)::int2,
       cit_c6 = coalesce(x.cit_c6, 0)::int2,
       cit_c7 = coalesce(x.cit_c7, 0)::int2,
       cit_c8 = coalesce(x.cit_c8, 0)::int2,
       cit_c9 = coalesce(x.cit_c9, 0)::int2,
       cit_c10 = coalesce(x.cit_c10, 0)::int2,
       cit_c11 = coalesce(x.cit_c11, 0)::int2,
       cit_c12 = coalesce(x.cit_c12, 0)::int2,
       cit_c13 = coalesce(x.cit_c13, 0)::int2
  FROM rd.answer a2
  LEFT JOIN rd.answer_cit_ext(NULL) x ON x.surface = a2.surface AND x.round_date = a2.round_date AND x.answer_key = a2.answer_key
 WHERE a.surface = a2.surface AND a.round_date = a2.round_date AND a.answer_key = a2.answer_key;

-- name: reflect_override
-- bg.pgsql @competitor 의 오버라이드(reddit.com → 2)를 재판정이 반영한 상태(rd.dim_source.category_key = 오버라이드). refresh_cit_ext 앞에 둔다.
UPDATE rd.dim_source SET category_key = 2 WHERE skey = 'reddit.com';

-- name: profile_cols
-- 현행 프로필(셀 대표·삭제 포함 카탈로그) 동치 시험용: 준비가 복사한 행의 DB-v2.15 열을 채운다(규칙 정확성이 아니라 사본 일관성만 필요).
-- 삭제 포함 카탈로그 = 현재 카탈로그(이 준비에는 삭제 행 없음), 셀 대표 = elig 답변(부모), 자식 사본 = 부모 값(전파 함수와 같은 규약).
UPDATE rd.dim_prompt SET cat_mask_all = cat_mask, in_root_catalog_all = in_root_catalog
 WHERE (cat_mask_all, in_root_catalog_all) IS DISTINCT FROM (cat_mask, in_root_catalog);
UPDATE rd.answer SET is_rep = elig WHERE surface = 1 AND is_rep IS DISTINCT FROM elig;
UPDATE rd.citation c SET is_rep = a.is_rep FROM rd.answer a
 WHERE c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key AND c.surface = 1 AND c.is_rep IS DISTINCT FROM a.is_rep;
UPDATE rd.answer_brand c SET is_rep = a.is_rep FROM rd.answer a
 WHERE c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key AND c.surface = 1 AND c.is_rep IS DISTINCT FROM a.is_rep;

-- name: null_cit_ext
-- 미채움 답변(DB-v2.15 채우기·새 적재기 반영 전 행)을 흉내: 인용 있는 답변의 cit_n_all·cit_c1..13 을 NULL 로(CHECK answer_cit_ext_pair = 전부 NULL).
UPDATE rd.answer SET cit_c1 = NULL, cit_c2 = NULL, cit_c3 = NULL, cit_c4 = NULL, cit_c5 = NULL, cit_c6 = NULL, cit_c7 = NULL, cit_c8 = NULL,
       cit_c9 = NULL, cit_c10 = NULL, cit_c11 = NULL, cit_c12 = NULL, cit_c13 = NULL, cit_n_all = NULL
 WHERE cit_n > 0;
