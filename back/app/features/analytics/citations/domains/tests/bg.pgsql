-- BG 보강(bg-citations) 회귀 시험용 추가 합성 준비(고객 데이터 아님). tests.support.staged 로 소유자가 실행하고 블록 끝에 ROLLBACK.
-- prompts/tests/staged.pgsql @global(글로벌 회차 14 = 새 스냅샷, 프롬프트 PA~PI) 뒤에 얹어 쓴다. '-- name: x' 로 나눠 load_named_sql 로 읽는다.

-- name: src_first
-- @global 은 인용 원소를 템플릿 k1 에서 복사해 src_first(답변 안 그 출처의 첫 인용)가 복사본 답변 기준으로 맞지 않는다(9113{3,4} 의
-- reddit ord4 는 그 답변의 첫 reddit 인용인데 거짓으로 복사됨). 적재 규약대로 (답변, 출처) 안 최소 ord 만 참으로 다시 맞춘다.
UPDATE rd.citation c SET src_first = (c.ord = m.first_ord)
  FROM (SELECT answer_key, source_key, min(ord) AS first_ord FROM rd.citation
         WHERE surface = 1 AND round_date BETWEEN '2026-09-22' AND '2026-09-24' AND answer_key BETWEEN 9101 AND 9199
         GROUP BY answer_key, source_key) m
 WHERE c.surface = 1 AND c.round_date BETWEEN '2026-09-22' AND '2026-09-24' AND c.answer_key = m.answer_key AND c.source_key = m.source_key;

-- name: competitor
-- BG-20: caranddriver.com = 공식(경쟁사) + 경쟁 브랜드 BMW(9), foo-bar.xyz = 공식(경쟁사) 브랜드 없음(적재기 판정),
-- reddit.com = 운영자 오버라이드로만 공식(경쟁사)(적재 카테고리 커뮤니티 6 과 달라 경쟁사 표시 없음, EFFECTIVE_COMPETITOR).
UPDATE rd.dim_source SET category_key = 2, competitor_brand_key = 9 WHERE skey = 'caranddriver.com';
UPDATE rd.dim_source SET category_key = 2, competitor_brand_key = NULL WHERE skey = 'foo-bar.xyz';
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
INSERT INTO app.citation_domain_override (domain, category_key, note) VALUES ('reddit.com', 2, 'bg-citations test');

-- name: lang_ko
-- BG-01: 회차 14 의 PD 답변(9111~9120)을 ko 로 바꾼다(답변·인용 원소·잡의 lang_key 를 함께, 적재 사본 규약).
UPDATE rd.answer SET lang_key = (SELECT lang_key FROM rd.dim_lang WHERE code = 'ko')
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key BETWEEN 9111 AND 9120;
UPDATE rd.citation SET lang_key = (SELECT lang_key FROM rd.dim_lang WHERE code = 'ko')
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key BETWEEN 9111 AND 9120;
UPDATE rd.job SET lang_key = (SELECT lang_key FROM rd.dim_lang WHERE code = 'ko')
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key BETWEEN 9111 AND 9120;

-- name: tone_negative
-- BG-27: @global 답변은 감정 열을 복사하지 않아(기본 0) 톤이 없다. 현대 관점 답변 톤을 직접 둔다(core tone_expr = 당사 감정 열 비교):
--   긍정 = 9101·9102·9103(PA·PB·PC) · 9105(deepseek PF) (sent_pos_h 3 > sent_neg_h 0)
--   부정 = 9114·9120(PD 의 example.org 인용 답변) (sent_neg_h 2 > sent_pos_h 0)
UPDATE rd.answer SET sent_pos_h = 3, sent_neg_h = 0
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key IN (9101, 9102, 9103, 9105);
UPDATE rd.answer SET sent_pos_h = 0, sent_neg_h = 2
 WHERE surface = 1 AND round_date = '2026-09-23' AND answer_key IN (9114, 9120);

-- name: share_tie
-- 검증 D3: 표시 점유율이 같은데 원시 인용 수가 다른 두 출처. caranddriver.com(9115 ord 7) 1,000건 · foo-bar.xyz(9116 ord 8) 1,001건을
-- 같은 답변에 ord 1000~ 로 복사한다(src_first 거짓: 답변 수·커버리지는 그대로). 합 2,023 → caranddriver 1,001 = 49.48%, foo-bar 1,002
-- = 49.53% → 표시값 둘 다 49.5%. 원시 수 오름차순은 caranddriver → foo-bar, 현행(표시값 동률 → 인용 순위)은 foo-bar(rank 1) → caranddriver.
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver)
SELECT c.round_date, c.answer_key, c.url_key, c.source_key, c.cyc_key, c.prompt_key, c.surface, (x.base + g)::int2, c.project_key, c.engine_key,
       c.geo_key, c.lang_key, c.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt, c.loc_owned, c.tgt_hit, false, c.rule_ver
  FROM (VALUES (9115, 7, 1000, 1000), (9116, 8, 3000, 1001)) x(answer_key, ord, base, n)
  JOIN rd.citation c ON c.surface = 1 AND c.round_date = '2026-09-23' AND c.answer_key = x.answer_key AND c.ord = x.ord
  CROSS JOIN LATERAL generate_series(0, x.n - 1) g;

-- name: host_row
-- WU-12 도메인 접기 시험: 공식 소셜 계정 출처(linkedin.com/hyundai-motor-group, 템플릿 source 10, 답변 1 ord 3)와 같은 도메인의 일반 출처
-- 'linkedin.com'(도메인 대표 행)을 차원에 두고 같은 답변에 그 출처 인용 1건(ord 900, 계정 인용 행 복사)을 더한다.
INSERT INTO rd.dim_source (skey, domain, is_social, category_key, category_src, owned_brand_bit, rule_ver)
SELECT 'linkedin.com', 'linkedin.com', false, 7, 5, 0, rule_ver FROM rd.dim_source WHERE source_key = 10;
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver, cit_in_nc, is_rep)
SELECT c.round_date, c.answer_key, c.url_key, (SELECT source_key FROM rd.dim_source WHERE skey = 'linkedin.com'), c.cyc_key, c.prompt_key,
       c.surface, 900, c.project_key, c.engine_key, c.geo_key, c.lang_key, c.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt,
       c.loc_owned, c.tgt_hit, true, c.rule_ver, c.cit_in_nc, c.is_rep
  FROM rd.citation c WHERE c.surface = 1 AND c.round_date = '2026-09-14' AND c.answer_key = 1 AND c.ord = 3;
