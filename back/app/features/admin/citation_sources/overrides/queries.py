"""admin.citation_sources.overrides 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

후보(candidates)만 사실 표(rd.citation)를 읽는다. 그 술어 3개(surface·round_date·cyc_key)는 core.cycles.Window.where 가 만든
조각을 {where} 자리에 넣는다(인용 계열 창, 숨김 {1,2} 배제). 나머지는 app 설정 표 조회다.
"""

CATEGORIES_SQL = "SELECT category_key, name, slug, ord FROM app.citation_category ORDER BY ord, category_key"

# 목록: (updated_at, domain) DESC 키셋. {keyset} = core.pagination.keyset_predicate 조각 또는 true
LIST_SQL = """
SELECT o.domain, o.category_key, cc.name, cc.slug, o.note, o.updated_by, u.email::text AS updated_by_email, o.updated_at
  FROM app.citation_domain_override o
  JOIN app.citation_category cc ON cc.category_key = o.category_key
  LEFT JOIN app.user_account u ON u.user_id = o.updated_by
 WHERE {keyset}
 ORDER BY o.updated_at DESC, o.domain DESC
 LIMIT CAST(:lim AS int4)
"""

# 기간 안 인용 가중치(호스트 있는 인용 = source_key <> 0, 인용 모수 = cit_in) → 도메인·분류 단위. {where} = Window.where("c", "citations")
WEIGHTED_CTE = """
w AS (
  SELECT c.source_key, count(*)::int AS citations
    FROM rd.citation c
   WHERE {where} AND c.cit_in AND c.source_key <> 0
   GROUP BY c.source_key),
d AS (
  SELECT ds.domain, ds.category_key, ds.category_src, sum(w.citations)::int AS citations
    FROM w JOIN rd.dim_source ds ON ds.source_key = w.source_key
   GROUP BY ds.domain, ds.category_key, ds.category_src)"""

# 창이 비었을 때(노출 회차 없음): 사실 표를 읽지 않고 오버라이드 도메인만
EMPTY_CTE = """
d AS (SELECT CAST(NULL AS text) AS domain, CAST(NULL AS int2) AS category_key, CAST(NULL AS int2) AS category_src, 0 AS citations
       WHERE false)"""

# 상위 N(인용 수 DESC, 도메인 ASC) ∪ 오버라이드 도메인 전부(0건이어도, 현행 buildCurationRows 계승). category[] 는 순위 전에 좁힌다.
# shadows_owned(BG-42, 현행 overrideShadowsOwned source.ts:44-50): 오버라이드가 있고 그 도메인이 당사 공식 도메인(ownedBrandOf)이면 참.
#   ownedBrandOf(owned.ts:108) = 도메인(소문자·www. 제거)이 당사 등록 도메인과 같거나 '.등록 도메인' 으로 끝남(서브도메인 포함).
#   서픽스 일치는 "등록 도메인이 도메인의 점 단위 접미 후보 중 하나"와 같다. 후보 sx.sfx = 'a.b.hyundai.com' →
#   {a.b.hyundai.com, b.hyundai.com, hyundai.com, com}(string_to_array 의 i 번째 조각부터 이어 붙임). 그래서 notkia.com·kia.com.evil.io
#   같은 문자열 우연 일치는 거짓이다. 등호 조회라 rd.dim_source 는 유일 인덱스 dim_source_skey_key 를 탄다(N1, 아래).
#   당사 등록 도메인 원천 두 가지를 OR 로 본다:
#     ① app.owned_base kind 'base' 의 host(GEO_OWNED_BASES, EXCLUDED_OWNED_DOMAINS 반영 후). 서로 다른 host 43개 = 규칙 목록
#        GEO_OWNED_DOMAINS 42개(seed-3x-rules.sql _r_owned_domain) + worldwide.kia.com(kia.com 의 서브도메인이라 판정 결과를 늘리지 않음).
#        인용 적재 이력이 없는 당사 도메인(예: genesis.com)도 이것으로 판정된다. 표가 작아(210행, kind 'base' 170행) 정규화(소문자·www. 제거) 후 비교한다.
#     ② rd.dim_source 비소셜 행 중 owned_brand_bit ≠ 0(적재기가 규칙 owned_brand_of 로 선계산). owned_base 와 규칙 목록이 어긋나도
#        적재기가 당사로 본 도메인은 놓치지 않게 하는 보강이다.
#   N1(2차 검증, 6f0eefb): ② 를 right(domain, len(skey)+1) 로 비교하면 owned_brand_bit 인덱스가 없어 오버라이드 행마다 dim_source 전체를
#   훑었다(합성 30만 행 × 오버라이드 300 에서 2.8s, 부하 시 7~9s, api_ro statement_timeout 5s 초과). 접미 후보 등호(skey = ANY)로 바꿔
#   행당 인덱스 조회 ≤ 라벨 수가 됐다. 판정 결과(서픽스·적재 이력 없는 당사 도메인)는 같다.
#   접미 후보는 LATERAL 에서 오버라이드 행만 만든다(출력 행 ≤ limit + 오버라이드 수, 오버라이드 없는 행은 NULL → CASE 거짓).
CANDIDATES_SQL = """
WITH {cte},
j AS (
  SELECT coalesce(d.domain, o.domain) AS domain, coalesce(d.citations, 0) AS citations,
         coalesce(d.category_key, o.category_key) AS category_key, coalesce(d.category_src, CAST(1 AS int2)) AS category_src,
         d.domain IS NOT NULL AS in_dim_source, o.domain IS NOT NULL AS has_override,
         o.category_key AS ov_category_key, o.note AS ov_note, o.updated_by AS ov_updated_by, o.updated_at AS ov_updated_at
    FROM d FULL JOIN app.citation_domain_override o ON o.domain = d.domain),
r AS (
  SELECT j.*, cc.name, cc.slug, row_number() OVER (ORDER BY j.citations DESC, j.domain, j.category_key) AS rn
    FROM j JOIN app.citation_category cc ON cc.category_key = j.category_key
   WHERE CAST(:cats AS int2[]) IS NULL OR j.category_key = ANY(CAST(:cats AS int2[])))
SELECT r.domain, r.citations, r.category_key, r.name, r.slug, r.category_src, r.in_dim_source, r.has_override,
       r.ov_category_key, oc.name AS ov_name, oc.slug AS ov_slug, r.ov_note, r.ov_updated_by, r.ov_updated_at,
       CASE WHEN r.has_override
            THEN EXISTS (SELECT 1 FROM app.owned_base ob
                          WHERE ob.kind = 'base' AND regexp_replace(lower(ob.host), '^www\\.', '') = ANY(sx.sfx))
              OR EXISTS (SELECT 1 FROM rd.dim_source so
                          WHERE so.skey = ANY(sx.sfx) AND so.owned_brand_bit <> 0 AND NOT so.is_social)
            ELSE false END AS shadows_owned
  FROM r LEFT JOIN app.citation_category oc ON oc.category_key = r.ov_category_key
  LEFT JOIN LATERAL (
    SELECT ARRAY(SELECT t.s FROM (SELECT array_to_string(p.a[i:], '.') AS s FROM generate_subscripts(p.a, 1) AS i) t
                  WHERE t.s <> '') AS sfx
      FROM (SELECT string_to_array(r.domain, '.') AS a) p
     WHERE r.has_override) sx ON true
 WHERE r.rn <= CAST(:lim AS int4) OR r.has_override
 ORDER BY r.citations DESC, r.domain, r.category_key
"""

# ── 쓰기(api_rw, app 만) ──
CATEGORY_BY_KEY_SQL = "SELECT category_key, name, slug FROM app.citation_category WHERE category_key = CAST(:k AS int2)"
CATEGORY_BY_LABEL_SQL = """
SELECT category_key, name, slug FROM app.citation_category WHERE slug = :v OR name = :v ORDER BY (slug = :v) DESC, category_key LIMIT 1
"""
OLD_SQL = "SELECT domain, category_key, note FROM app.citation_domain_override WHERE domain = :d FOR UPDATE"
UPSERT_SQL = """
INSERT INTO app.citation_domain_override (domain, category_key, note, updated_by, updated_at)
VALUES (:d, CAST(:k AS int2), :note, app.actor(), now())
ON CONFLICT (domain) DO UPDATE SET category_key = EXCLUDED.category_key, note = EXCLUDED.note,
                                   updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
RETURNING domain, category_key, note, updated_by, updated_at
"""
DELETE_SQL = "DELETE FROM app.citation_domain_override WHERE domain = :d RETURNING domain, category_key, note"
