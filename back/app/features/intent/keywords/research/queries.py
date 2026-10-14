"""intent.keywords.research 읽기 SQL(SQLAlchemy Core text). rd·app 만(ext.dfs_call 은 적재기 전용이라 읽지 않는다).

rd.kw_* 는 파티션 표가 아니다(측정 사실 표 아님): 가지치기 술어 대신 (kw_key, location_code, language_code) 로 정확히 좁히고
최신 호출은 kw_serp_latest·kw_suggestion_latest 인덱스로 1건만 찾는다. term 은 DB 정본 app.term_norm 값(core.kw.db_term_norms)으로 = 비교.
"""
from __future__ import annotations

# term_norm 배열 → kw_key (rd.dim_keyword UNIQUE(term_norm))
KW_KEYS = """
SELECT kw_key, term, term_norm FROM rd.dim_keyword WHERE term_norm = ANY(CAST(:norms AS text[]))
"""

# 최근 12개월 검색량(내림차순 12행 → 앱에서 시간순으로 뒤집는다)
TREND = """
SELECT v.month, v.search_volume, v.competition_index, v.cpc, v.observed_at
  FROM rd.kw_volume_monthly v
 WHERE v.kw_key = :kw AND v.location_code = :loc AND v.language_code = :lang
 ORDER BY v.month DESC
 LIMIT 12
"""

# 최신 SERP 호출 1건의 행 + 행별 최신 gen 초안(LATERAL 1행: gen 이 여러 개여도 행이 늘지 않는다)
SERP_LATEST = """
WITH latest AS (
  SELECT s.call_id FROM rd.kw_serp s
   WHERE s.kw_key = :kw AND s.location_code = :loc AND s.language_code = :lang
   ORDER BY s.call_id DESC LIMIT 1)
SELECT s.call_id, s.rank, s.url, s.domain, s.title, s.snippet, s.observed_at, d.prompt, d.model, d.gen
  FROM latest JOIN rd.kw_serp s ON s.call_id = latest.call_id
  LEFT JOIN LATERAL (SELECT k.prompt, k.model, k.gen FROM app.kw_prompt_draft k
                      WHERE k.serp_call_id = s.call_id AND k.rank = s.rank ORDER BY k.gen DESC LIMIT 1) d ON true
 ORDER BY s.rank
 LIMIT :limit
"""

# 최신 연관어 호출 1건의 행(seed 포함 여부는 앱에서 가른다). 행 수 ≤ 30(적재 상한). observed_at = 그 호출 관측 시각(DB-v2.6 P43)
SUGGEST_LATEST = """
WITH latest AS (
  SELECT g.call_id FROM rd.kw_suggestion g
   WHERE g.seed_kw_key = :kw AND g.location_code = :loc AND g.language_code = :lang
   ORDER BY g.call_id DESC LIMIT 1)
SELECT g.call_id, g.pos, g.is_seed, g.search_volume, g.intent, g.observed_at, g.total_count, k.term
  FROM latest JOIN rd.kw_suggestion g ON g.call_id = latest.call_id
  JOIN rd.dim_keyword k ON k.kw_key = g.kw_key
 ORDER BY g.pos
"""

# lookup 용 다건: seed kw_key 마다 최신 연관어 호출 1건의 행(SUGGEST_LATEST 와 같은 행)을 한 문장으로. seed_kw 로 앱에서 가른다.
# 최신 호출 찾기는 seed 마다 LATERAL 1건(kw_suggestion_latest 인덱스, SUGGEST_LATEST 의 latest CTE 와 같은 조건·정렬).
SUGGEST_LATEST_MANY = """
SELECT x.kw AS seed_kw, g.call_id, g.pos, g.is_seed, g.search_volume, g.intent, g.observed_at, g.total_count, k.term
  FROM unnest(CAST(:kws AS int4[])) AS x(kw)
  JOIN LATERAL (SELECT l.call_id FROM rd.kw_suggestion l
                 WHERE l.seed_kw_key = x.kw AND l.location_code = :loc AND l.language_code = :lang
                 ORDER BY l.call_id DESC LIMIT 1) latest ON true
  JOIN rd.kw_suggestion g ON g.call_id = latest.call_id
  JOIN rd.dim_keyword k ON k.kw_key = g.kw_key
 ORDER BY x.kw, g.pos
"""

# 신선도 판정용: term 별 최신 관측 시각. fetches 가 "신선하면 skip" 에 쓴다.
# volume_at·serp_at = insight(검색량·SERP), related_at = 최신 연관어 호출, search_at = seed 행을 포함한 최신 연관어 호출(search 는
# include_seed 라 seed 없는 related 호출로는 채워지지 않는다). 연관어 두 값은 kw_suggestion_latest 인덱스 순서로 1행씩.
LATEST_OBSERVED = """
SELECT k.term_norm,
       (SELECT max(v.observed_at) FROM rd.kw_volume_monthly v
         WHERE v.kw_key = k.kw_key AND v.location_code = :loc AND v.language_code = :lang) AS volume_at,
       (SELECT s.observed_at FROM rd.kw_serp s
         WHERE s.kw_key = k.kw_key AND s.location_code = :loc AND s.language_code = :lang
         ORDER BY s.call_id DESC LIMIT 1) AS serp_at,
       (SELECT g.observed_at FROM rd.kw_suggestion g
         WHERE g.seed_kw_key = k.kw_key AND g.location_code = :loc AND g.language_code = :lang
         ORDER BY g.call_id DESC LIMIT 1) AS related_at,
       (SELECT g.observed_at FROM rd.kw_suggestion g
         WHERE g.seed_kw_key = k.kw_key AND g.location_code = :loc AND g.language_code = :lang AND g.is_seed
         ORDER BY g.call_id DESC LIMIT 1) AS search_at
  FROM rd.dim_keyword k
 WHERE k.term_norm = ANY(CAST(:norms AS text[]))
"""

# 프로젝트 추적 키워드(프로젝트 경로 권한: 국가·SERP 를 그 프로젝트에 묶는다, 검증 D5). country_code NULL = 프로젝트 국가
PROJECT_TRACKED = """
SELECT term, term_norm, country_code FROM app.project_tracked_keyword WHERE project_id = :pid
"""

# 표준 열람자용 표준 키워드 목록(BG-41, app.standard_keyword 만: 사실 표 아님, 소규모 원천 표).
# enabled 만. 브랜드 스코프: brand_code NULL(공통)은 누구에게나, 그 밖은 계정 스코프 브랜드 안(scope_all = 제약 없음).
# narrow(요청 brand 중 볼 수 있는 값)가 있으면 그 브랜드 + 공통만.
# term 합치기(수정 라운드 검증 D4): 같은 term 이 공통과 브랜드 행으로 겹치면 화면 탭(label = term)이 둘이 된다. 가시 행을 app.term_norm(term) 으로
# 묶어 한 항목으로 준다. 대표 행 = 그 묶음에서 created_at DESC, keyword_id ASC 첫 행(keyword_id·term·created_at 은 대표 값),
# keyword_ids = 묶음 전 행(같은 정렬), brand_codes = 묶음의 브랜드(NULL = 공통, 앞에 둔다), updated_at = 묶음 최댓값.
# 정렬 = 대표 행 created_at DESC, 동률 keyword_id ASC(관리 목록과 같은 순서 규칙).
# 키셋 커서(수정 라운드 검증 D2): (c_at, c_id) = 직전 페이지 마지막 항목의 대표 값. 정렬 방향이 섞여 있어(DESC, ASC) 행 값 비교 대신 풀어 쓴다.
# total = 커서·LIMIT 과 무관한 필터 전체 항목 수(묶음 수). 커서 뒤가 비어도 total 을 잃지 않게 LEFT JOIN LATERAL 로 한 행을 남긴다
# (그때 keyword_id 는 NULL, 서비스가 걸러 낸다). 한 페이지 상한은 service.MAX_STANDARD_KEYWORDS.
STANDARD_KEYWORDS = """
WITH base AS (
  SELECT k.keyword_id, k.term, app.term_norm(k.term) AS n, k.source_type, k.brand_code, k.created_at, k.updated_at
    FROM app.standard_keyword k
   WHERE k.enabled AND k.source_type = :source_type
     AND (CAST(:scope_all AS bool) OR k.brand_code IS NULL OR k.brand_code = ANY(CAST(:scope_brands AS text[])))
     AND (CAST(:narrow AS text[]) IS NULL OR k.brand_code IS NULL OR k.brand_code = ANY(CAST(:narrow AS text[])))
), grp AS (
  SELECT (array_agg(b.keyword_id ORDER BY b.created_at DESC, b.keyword_id))[1] AS keyword_id,
         (array_agg(b.term ORDER BY b.created_at DESC, b.keyword_id))[1] AS term,
         max(b.created_at) AS created_at,
         max(b.updated_at) AS updated_at,
         array_agg(b.keyword_id ORDER BY b.created_at DESC, b.keyword_id) AS keyword_ids,
         array_agg(DISTINCT b.brand_code ORDER BY b.brand_code NULLS FIRST) AS brand_codes,
         min(b.source_type) AS source_type
    FROM base b
   GROUP BY b.n
)
SELECT p.keyword_id, p.keyword_ids, p.term, p.source_type, p.brand_codes, p.created_at, p.updated_at, t.total
  FROM (SELECT count(*) AS total FROM grp) t
  LEFT JOIN LATERAL (
    SELECT g.* FROM grp g
     WHERE CAST(:c_at AS timestamptz) IS NULL
        OR g.created_at < CAST(:c_at AS timestamptz)
        OR (g.created_at = CAST(:c_at AS timestamptz) AND g.keyword_id > CAST(:c_id AS uuid))
     ORDER BY g.created_at DESC, g.keyword_id
     LIMIT :limit
  ) p ON true
 ORDER BY p.created_at DESC, p.keyword_id
"""
