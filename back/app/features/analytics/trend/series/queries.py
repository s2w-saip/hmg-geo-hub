"""analytics.trend.series 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

사실 표(rd.answer·answer_brand·citation) 지표 집계는 app.core.measure 빌더(fetch_counts·brand_rows·citation_counts·url_rates)가
Window.where 3술어와 함께 만든다. 이 파일에는 차원·원장 속성 조회와, core 지표 빌더에 없는 추이 전용 보조 집계(BG 보강·성능 A1~A3)만 둔다.
보조 집계도 술어는 core 빌더(Window.where 3술어 + core.measure.scope_where)만 쓰고, 버킷 식은 core.measure.GROUPS 화이트리스트에서 고른다.
- own_split_counts_sql(A3): D13 split_own 비트별 당사 합계를 rd.answer 한 번 스캔(비트마다 FILTER 열). 비트별 fetch_counts(parts mentions)와 같은 식.
- mix_counts_sql(A2): dimension source·category 의 (버킷, 출처) 접기·출처 차원 조인·순위 후보 좁히기(술어 = core.measure.citation_where).
- type_counts_sql(BG-07): rd.answer_brand 당사 행(own_bit = ANY(관점 비트) ∧ std_in ∧ competitive)을 답변 단위로 접어 버킷 × 유형 5종의
  "그 유형 신호가 있는 당사 답변 수". 술어는 GET /v1/mentions/types(M-2 types_sql)의 당사 행과 같다.
- measured_days_sql(BG-10): 버킷 답변(cit_in, 계열 합집합 회차)의 rd.job.measured_at KST 고유 일수. rd.job 은 사실 표가 아닌 job 색인
  (answer_key PK)이라 같은 좌표(surface·round_date·cyc_key)로 범위를 좁혀 job_round_idx 를 쓰게 한다.
"""
from __future__ import annotations

from collections.abc import Sequence

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import (
    CATEGORY_EXPR,
    GROUPS,
    OVERRIDE_JOIN,
    MeasureScope,
    citation_population,
    citation_where,
    mention_population,
    own_cols,
    scope_where,
)
from app.core.sqlb import Binder, Sql

# 유형 5종(응답 순서 고정, 현행 MENTION_TYPE_KEYS) → rd.answer_brand 열
TYPE_COLS: dict[str, str] = {"mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
                             "definition": "t_definition", "final_choice": "t_final_choice"}
MEASURED_TZ = "Asia/Seoul"            # 측정 일수의 날짜 경계(KST)


def _bucket(group: str, alias: str) -> tuple[str, str]:
    """core.measure.GROUPS 의 버킷 식(round_date·week·month) → (결과 열 이름, 식)."""
    if group not in ("round_date", "week", "month"):
        raise ValueError(f"허용되지 않은 버킷: {group}")
    name, expr = GROUPS[group]
    return name, expr.format(a=alias)


def type_counts_sql(ms: MeasureScope, win: Window, group: str) -> Sql:
    """버킷 × 유형: 유형 신호(t_x > 0)가 있는 당사 답변 수(a0~a4). 언급 계열 회차만(Window.where 'mentions')."""
    b = Binder("y")
    name, expr = _bucket(group, "b")
    w = (win.where("b", "mentions", b) + scope_where(ms, "b", b)
         + [mention_population(ms, "b", "brand"), "b.competitive", f"b.own_bit = ANY({b.ints(ms.own_bits)})"])
    inner = [f"{expr} AS bk", "b.answer_key"] + [f"bool_or(b.{c} > 0) AS a{i}" for i, c in enumerate(TYPE_COLS.values())]
    outer = [f"pa.bk AS {name}"] + [f"count(*) FILTER (WHERE pa.a{i}) AS a{i}" for i in range(len(TYPE_COLS))]
    t = (f"WITH pa AS (\n  SELECT {', '.join(inner)}\n    FROM {fact_tables(ms).answer_brand} b\n   WHERE {' AND '.join(w)}\n"
         "   GROUP BY 1, b.round_date, b.answer_key)\n"
         f"SELECT {', '.join(outer)}\n  FROM pa\n GROUP BY 1")
    return b.sql(t)


def measured_days_sql(ms: MeasureScope, win: Window, group: str, families: Sequence[str]) -> Sql:
    """버킷별 측정 일수: 버킷 답변(families 회차 합집합 ∧ cit_in ∧ 필터 축)의 measured_at KST 날짜 고유 수.
    성능(A1, 2026-09-30 stg 조사): count(DISTINCT 날짜) 는 병렬 집계를 막아 조인 결과 15만 행을 Gather Merge·정렬로 모았다.
    (버킷, KST 날짜) 로 먼저 묶고(병렬 부분 집계 가능) 바깥에서 날짜 수를 센다. measured_at NULL 은 안쪽에서 NULL 날짜 그룹이 되므로
    바깥은 count(day)(NULL 제외) = count(DISTINCT) 와 같은 값이다. 결과 행(버킷 집합)도 같다(안쪽 그룹이 있는 버킷 = 조인 행이 있는 버킷)."""
    b = Binder("d")
    name, expr = _bucket(group, "a")
    keys = win.union_keys(*families)
    w = win.where("a", "row", b, keys=keys) + scope_where(ms, "a", b) + [citation_population(ms, "a")]
    jw = [f"j.surface = {b.v(win.sf, 'int2')}", f"j.cyc_key = ANY({b.ints(keys, 'int4')})", "j.served"]
    if win.lo is not None and win.hi is not None:
        jw.append(f"j.round_date BETWEEN {b.date(win.lo)} AND {b.date(win.hi)}")
    t = (f"SELECT d.{name}, count(d.day) AS measured_days\n"
         f"  FROM (SELECT {expr} AS {name}, (j.measured_at AT TIME ZONE {b.v(MEASURED_TZ, 'text')})::date AS day\n"
         f"          FROM {fact_tables(ms).answer} a\n"
         "          JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date\n"
         f"         WHERE {' AND '.join(w + jw)}\n"
         "         GROUP BY 1, 2) d\n"
         " GROUP BY 1")
    return b.sql(t)


# D13 split_own 비트별 당사 합계(A3): core.measure.fetch_counts(parts=('mentions',)) 를 비트마다 부르던 N 번 스캔을 rd.answer 한 번으로.
# 식·WHERE 는 plan_counts 'mentions'(언급 계열만 요청 = 분리 없음: WHERE 창 3술어(언급 회차) ∧ 필터 축 ∧ cit_in, 값 = std_in FILTER,
# 당사 열 = core.measure.own_cols) 와 같고 비트 i 의 열에 접미 i 를 붙인다. 필터 축(scope_where)은 own_bits·owner 를 쓰지 않으므로
# split_own_scopes 의 비트별 스코프와 WHERE 가 같다. 비트 식은 FILTER 안에서만.
SPLIT_KEYS = ("tracked", "own_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked")


def own_split_counts_sql(ms: MeasureScope, win: Window, group: str, bits: Sequence[int]) -> Sql:
    """버킷별 answers·total_mentions(공유) + 비트 i 마다 SPLIT_KEYS{i}. 결과를 비트별 fetch_counts 행으로 푸는 것은 호출자."""
    b = Binder("s")
    a = "a"
    name, expr = _bucket(group, a)
    w = win.where(a, "row", b, keys=win.union_keys("mentions")) + scope_where(ms, a, b) + [citation_population(ms, a)]
    mg = mention_population(ms, a)
    cols = [f"{expr} AS {name}", f"count(*) FILTER (WHERE {mg}) AS answers",
            f"coalesce(sum({a}.ment_total) FILTER (WHERE {mg}), 0) AS total_mentions"]
    for i, bit in enumerate(bits):
        oc = own_cols((bit,), a)
        cols += [f"count(*) FILTER (WHERE {mg} AND ({a}.own_mask & {oc.mask}) <> 0) AS tracked{i}",
                 f"coalesce(sum({oc.ment}) FILTER (WHERE {mg}), 0) AS own_mentions{i}",
                 f"coalesce(sum({oc.sent_pos}) FILTER (WHERE {mg}), 0) AS sent_pos{i}",
                 f"coalesce(sum({oc.sent_neg}) FILTER (WHERE {mg}), 0) AS sent_neg{i}",
                 f"coalesce(sum({oc.sent_all}) FILTER (WHERE {mg}), 0) AS sent_all{i}",
                 f"coalesce(sum({oc.rank}) FILTER (WHERE {mg} AND {oc.ranked}), 0) AS rank_sum{i}",
                 f"count(*) FILTER (WHERE {mg} AND {oc.ranked}) AS ranked{i}"]
    t = f"SELECT {', '.join(cols)}\n  FROM {fact_tables(ms).answer} {a}\n WHERE {' AND '.join(w)}\n GROUP BY 1"
    return b.sql(t)


# 경쟁 브랜드 표시 이름(brand_rows 결과의 brand_key 와 BG-11 요청 brand_key[]). own_bit 는 요청 키가 관점 브랜드인지,
# kind(0 이름 없음·1 자사·2 경쟁·3 비경쟁, 적재 규칙 ingest/project/apply/queries.py) 는 비경쟁 브랜드인지 가르는 데 쓴다(검증 V2)
BRAND_NAMES_SQL = """
SELECT b.brand_key, b.name, b.own_bit, b.kind
  FROM rd.dim_brand_name b
 WHERE b.brand_key = ANY(CAST(:keys AS int4[]))
"""
BRAND_KIND_NON_COMPETITOR = 3

# D13 split_own 당사 계열의 brand_key(검증 V1): 관점 brand_code 와 같은 이름의 표시 브랜드. GET /v1/mentions/brands 당사 행
# (brand_names_sql: name = 관점 brand_code)과 같은 조회 규칙이라 두 그룹의 당사 행을 brand_key 로 잇는다. 없으면 null
OWN_BRAND_KEYS_SQL = """
SELECT b.brand_key, b.name
  FROM rd.dim_brand_name b
 WHERE b.name = ANY(CAST(:names AS text[]))
"""

# dimension source·category(M09·M10) 구성비 집계(A2). 예전에는 core.measure.citation_counts(group_by=(버킷, source)) 결과(창의
# (버킷, 출처) 전부, stg 7.4만 행)를 앱으로 받아 출처 라벨·카테고리를 붙이고 파이썬에서 합산·전체 출처 순위(lc_key 2.4만 번)를 냈다.
# 이제 한 문장에서 (버킷, 출처) 로 접은 뒤(per) 두 부분을 낸다: part 0 = 버킷 전체 인용 수(출처 차원에 없는 출처 포함, 예전
# bucket_total 과 같은 모집단), part 1 = 차원 값별 버킷 인용 수. 술어는 core.measure.citation_where(인용 계열 창 3술어 + 필터 축 +
# cit_in + 호스트 있는 인용 + source[] 세미조인) 그대로다.
# - category: part 1 = (버킷, 유효 카테고리 CATEGORY_EXPR) 합. 출처 차원에 없는 출처는 빠진다(예전 src.get() is None → 건너뜀과 같다).
# - source: part 1 = 순위 후보 출처의 (버킷, 출처) 행 + skey·domain. 후보 = 창 합계가 top 번째로 큰 합계(중복 포함, 출처 차원에 있는
#   출처만) 이상인 출처. 합계가 그보다 작은 출처는 (합계 내림차순, lc_key) 순위에서 top 안에 들 수 없으므로 순위·결과가 같고,
#   경계 동률은 후보에 전부 남아 파이썬 rank_brand_items(lc_key, 정본)가 가른다. 출처가 top 개보다 적으면 cut 이 비어 전부 후보다.
# per 는 두 번 읽혀 한 번만 계산된다(CTE 두 번 참조 = 물리화).
def mix_counts_sql(ms: MeasureScope, win: Window, group: str, dimension: str, top: int) -> Sql:
    if dimension not in ("source", "category"):
        raise ValueError(f"허용되지 않은 구성비 차원: {dimension}")
    b = Binder("x")
    _, expr = _bucket(group, "c")
    per = (f"per AS (\n  SELECT {expr} AS bk, c.source_key, count(*) AS n\n    FROM {fact_tables(ms).citation} c\n"
           f"   WHERE {' AND '.join(citation_where(ms, win, 'c', b))}\n   GROUP BY 1, 2)")
    head = "SELECT 0 AS part, p.bk, NULL::int4 AS dkey, sum(p.n)::int8 AS n, NULL::text AS skey, NULL::text AS domain\n  FROM per p GROUP BY p.bk"
    if dimension == "category":
        t = (f"WITH {per}\n{head}\nUNION ALL\n"
             f"SELECT 1, p.bk, ({CATEGORY_EXPR})::int4, sum(p.n)::int8, NULL::text, NULL::text\n"
             f"  FROM per p JOIN rd.dim_source ds ON ds.source_key = p.source_key {OVERRIDE_JOIN}\n"
             " GROUP BY p.bk, 3")
        return b.sql(t)
    t = (f"WITH {per},\n"
         "tot AS (\n  SELECT p.source_key, sum(p.n) AS t\n    FROM per p JOIN rd.dim_source ds ON ds.source_key = p.source_key\n"
         "   GROUP BY p.source_key),\n"
         f"cut AS (\n  SELECT tot.t FROM tot ORDER BY tot.t DESC LIMIT 1 OFFSET {b.v(max(int(top), 1) - 1, 'int8')})\n"
         f"{head}\nUNION ALL\n"
         "SELECT 1, p.bk, p.source_key, p.n, ds.skey, ds.domain\n"
         "  FROM per p JOIN tot ON tot.source_key = p.source_key JOIN rd.dim_source ds ON ds.source_key = p.source_key\n"
         " WHERE tot.t >= coalesce((SELECT cut.t FROM cut), 0)")
    return b.sql(t)

