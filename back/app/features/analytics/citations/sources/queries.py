"""analytics.citations.sources 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

/sources 문장 2개(모듈-인용 §2 C-2, 요청당 ≤ 3). 성능 R2(2026-10-01): 같은 회차 인용을 문장 3개가 각각 전량 처리하던 구조를
인용 1회 스캔(카테고리·유형) + 톤 있는 답변만 스캔(톤)으로 바꿨다. 결과는 종전 문장 3개와 같다(tests/test_sources_equiv.py).
1. sources_sql(카테고리·엔진×카테고리·유형): 당사 언급 유형 플래그(jt, 답변 단위)를 rd.citation 에 LEFT JOIN 하고 (engine_key, source_key)
   로 한 번 접으며 count(*) 와 유형 5종 FILTER 를 같이 센다 → 출처 차원(오버라이드 반영 유효 카테고리) → GROUPING SETS
   ((카테고리), (엔진, 카테고리), ()). 유형 = 카테고리 단독 행(grp 2)의 t_* 열. source[] 는 출처로 접은 뒤 유효 카테고리로 거른다
   (카테고리가 출처 키에 종속이라 원소 필터와 같다).
2. tone_sql(톤 타일): 관점 톤(core.measure.tone_expr)이 있는 답변만 먼저 고르고(동률·둘 다 0 은 어느 쪽도 아니라 버린다) 그 인용을
   (톤, url_key) 로 해시 집계 → url 수 = 그룹 수, 인용 수 = 그룹 합. count(DISTINCT) 없음(병렬 집계).
   답변 수 = 인용이 있는 톤 답변 수: source[] 가 없으면 rd.answer.cit_n > 0(호스트 있는 인용 수, G-25 = 이 문장의 인용 모수와 같은 식)으로
   rd.answer 만 센다. source[] 가 있으면 cit_n 이 출처 무관 합이라 같은 조인을 GROUPING SETS ((톤, url), (톤, 답변)) 로 한 번에 접는다
   (선택 출처 인용만 남아 작고, 인용을 두 번 읽지 않는다).
/sources/types(types_sql)는 유형만 필요해 jt 내부 조인 한 문장을 유지한다(jt 식은 _type_flags 공용).

선택 파라미터(P12 B098, 기본 = 종전 값):
- include_types=false: 답변 열 문장(sources_ans_sql types='none')·원소 폴백(sources_sql with_types=False)이 유형 열(65열·jt)을 만들지 않는다.
- include_tone=false: tone_sql 을 돌리지 않는다.
- 톤 답변 수(출처 축 없음): tone_sql 의 답변 CTE(n)가 답변 열 문장과 같은 술어(창 + 필터 축 + cit_in ∧ cit_n > 0)로 rd.answer 를 한 번 더
  읽던 것을 답변 열 문장의 FILTER 두 열(sources_ans_sql pos_answers·neg_answers)로 옮긴다(tone_sql answers=False). 값은 같다
  (tests/test_sources_equiv.py::test_tone_answers_from_sources_ans_equal_tone_sql). rd.answer 스캔 3 → 2.
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.filters import ReadContext
from app.core.measure import (
    CATEGORY_EXPR,
    OVERRIDE_JOIN,
    MeasureScope,
    citation_population,
    citation_where,
    mention_population,
    scope_where,
    source_where,
    tone_expr,
)
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.shared import FAMILY

TYPE_COLS = {"mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
             "definition": "t_definition", "final_choice": "t_final_choice"}


def _cat_filter(ctx: ReadContext, b: Binder) -> str:
    if ctx.source_category_keys is None:
        return ""
    return f"\n   WHERE {CATEGORY_EXPR} = ANY({b.ints(ctx.source_category_keys)})"


def _type_flags(ctx: ReadContext, ms: MeasureScope, win: Window, b: Binder) -> str:
    """현행 aggregateCitationTypeCategoriesFromMirror(scope-aggregates.ts:11270) 이관: 당사 언급 답변의 유형 신호(답변 단위 bool_or).
    당사 = 관점 브랜드 비트(own_bit = ANY, M-1 과 같은 관점 규칙), 언급 모수 = std_in. 반환 = CTE 본문 'jt AS (…)'."""
    ab_where = win.where("ab", FAMILY, b) + scope_where(ms, "ab", b) + [mention_population(ms, "ab", "brand"), f"ab.own_bit = ANY({b.ints(ctx.own_bits)})"]
    flags = ",\n         ".join(f"bool_or(ab.{col} > 0) AS {col}" for col in TYPE_COLS.values())
    return f"""jt AS (
  SELECT ab.answer_key,
         {flags}
    FROM {fact_tables(ms).answer_brand} ab
   WHERE {' AND '.join(ab_where)}
   GROUP BY ab.answer_key)"""


def sources_sql(ctx: ReadContext, win: Window, *, with_types: bool = True) -> Sql:
    """카테고리 분포·엔진×카테고리·유형×카테고리를 인용 1회 스캔으로. 행 = GROUPING(engine_key, category_key) grp 3(전체)·2(카테고리)·
    0(엔진×카테고리). citations = 인용 수, t_* = 그 유형 신호가 있는 당사 언급 답변의 인용 수(유형 간 중복 계상).
    with_types=False(include_types=false): 유형 플래그(jt)·t_* 열 없이 카테고리·엔진×카테고리만(행·citations 는 같다)."""
    ms = ctx.measure()
    b = Binder("k")
    if not with_types:
        txt = f"""
WITH g AS (
  SELECT c.engine_key, c.source_key, count(*) AS n
    FROM {fact_tables(ms).citation} c
   WHERE {' AND '.join(citation_where(ms, win, "c", b))}
   GROUP BY c.engine_key, c.source_key),
e AS (
  SELECT g.engine_key, {CATEGORY_EXPR} AS category_key, g.n
    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
    {OVERRIDE_JOIN}{_cat_filter(ctx, b)})
SELECT e.engine_key, e.category_key, coalesce(sum(e.n), 0) AS citations,
       GROUPING(e.engine_key, e.category_key) AS grp
  FROM e
 GROUP BY GROUPING SETS ((e.category_key), (e.engine_key, e.category_key), ())
"""
        return b.sql(txt)
    counts = ",\n         ".join(f"count(*) FILTER (WHERE jt.{col}) AS {col}" for col in TYPE_COLS.values())
    cols = ", ".join(f"g.{col}" for col in TYPE_COLS.values())
    sums = ", ".join(f"coalesce(sum(e.{col}), 0) AS {col}" for col in TYPE_COLS.values())
    txt = f"""
WITH {_type_flags(ctx, ms, win, b)},
g AS (
  SELECT c.engine_key, c.source_key, count(*) AS n,
         {counts}
    FROM {fact_tables(ms).citation} c LEFT JOIN jt ON jt.answer_key = c.answer_key
   WHERE {' AND '.join(citation_where(ms, win, "c", b))}
   GROUP BY c.engine_key, c.source_key),
e AS (
  SELECT g.engine_key, {CATEGORY_EXPR} AS category_key, g.n, {cols}
    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
    {OVERRIDE_JOIN}{_cat_filter(ctx, b)})
SELECT e.engine_key, e.category_key, coalesce(sum(e.n), 0) AS citations, {sums},
       GROUPING(e.engine_key, e.category_key) AS grp
  FROM e
 GROUP BY GROUPING SETS ((e.category_key), (e.engine_key, e.category_key), ())
"""
    return b.sql(txt)


# ── 답변 열 경로(인용 성능 수정안 B, DB-v2.15 P86 cit_c1..13, WU-5) ─────────────────────────────────────────────
# 카테고리·엔진×카테고리·유형×카테고리를 rd.citation 원소가 아니라 rd.answer 답변당 카테고리별 인용 수 열의 합으로 낸다. 결과는 sources_sql 과 같다:
#   rd.citation 의 게이트·축 열(cit_in·is_rep·dflt·bgrp·project·geo·lang·prompt·engine·cyc)은 부모 답변 사본(전파 함수 대상)이라 같은 술어가
#   같은 답변을 고르고, cit_c<k> = 그 답변의 호스트 있는 인용 중 반영된 출처 카테고리(rd.dim_source.category_key) k 인 수(단언 ASSERT_CIT_EXT)다.
#   카테고리가 출처 키에 종속이라 source[] 는 열 선택과 같다. 유형 = 유형 신호 답변(jt)의 열 합(원소 경로의 count FILTER (jt.t_*) 와 같은 값).
# 쓰지 못하는 두 경우(결과에 표시 열을 같이 낸다 → 서비스가 원소 경로 sources_sql 로 되돌린다):
#   unfilled    모수 답변 중 cit_c 가 NULL(DB-v2.15 채우기·적재기 반영 전 행)이면서 호스트 있는 인용이 있는 답변 수
#   ovr_pending 운영자 오버라이드가 아직 재판정(judgment_change 'citation_override')에 반영되지 않은 출처 수: 조회 식은 오버라이드를 즉시
#               반영하는데(CATEGORY_EXPR) 열은 반영된 카테고리 기준이다
# 성능: stg hmg_r2 9/28 무필터 sources_sql 448ms(OFF)·1,008ms(현행 프로필 catalog_incl_deleted: rd.citation 96만 행에 dim_prompt 세미조인이
#   붙어 병렬 계획을 잃음) → 답변 4.7만 행 합(수치는 WU-5 보고).
CAT_KEYS = tuple(range(1, 14))       # app.citation_category 1..13 = cit_c1..cit_c13(DB-v2.15 P86 CHECK·패치 가드)


# ── 유형 플래그 답변 열(DB-v2.18 P105 rd.answer.t_own) ─────────────────────────────────────────────────────────
# t_own 비트 5b+i: b = 당사 비트 위치(own_bit 1·2·4 → 0·1·2), i = TYPE_COLS 순서(mention·recommendation·comparison·definition·final_choice).
# 값 = 그 답변의 rd.answer_brand own_bit = b 행 중 t_<i> > 0 이 있는가(DB rd.t_own_bits, 적재기 _ig_own·seed-40 _own 이 같은 식).
# 종전 jt(_type_flags: answer_brand ⋈ own_bit = ANY(관점) ∧ 언급 모수(table 'brand'), bool_or(t_x > 0))와 같은 값:
#   관점 S 의 유형 i 플래그 = (t_own & OR_{b∈S} 1 << (5b+i)) <> 0 ∧ 언급 모수. 언급 모수는 mention_population(ms, "a", "brand") 를 답변 별칭에
#   건다: 그 식이 읽는 열(is_rep·std_in·std_in_nc·prompt_key)은 answer_brand 에서 부모 rd.answer 사본(rd.propagate_answer_gates)이라 답변 쪽 값이
#   행 쪽 값과 같다. 창·필터 축도 같은 사본이라 바깥 답변 술어(aw)가 그대로 jt 의 술어다.
# 쓰지 못하는 경우: 모수 답변 중 t_own NULL(DB-v2.18 채우기 전 행) → t_unfilled > 0 → 서비스가 jt 경로로 다시 센다(값 같음).
#   관점 비트가 1·2·4 밖이면(현재 없음: MeasureScope.own_bits ⊆ (1,2,4)) 처음부터 jt 경로.
T_OWN_SHIFT = {1: 0, 2: 5, 4: 10}


def t_own_mask(own_bits: tuple[int, ...] | list[int], type_index: int) -> int:
    """관점 비트 집합의 유형 type_index(TYPE_COLS 순서) 비트 마스크."""
    m = 0
    for bit in own_bits:
        m |= 1 << (T_OWN_SHIFT[bit] + type_index)
    return m


def t_own_usable(ctx: ReadContext) -> bool:
    """답변 열 t_own 으로 유형 플래그를 낼 수 있는 관점인가(관점 비트가 전부 1·2·4)."""
    return bool(ctx.own_bits) and all(x in T_OWN_SHIFT for x in ctx.own_bits)


def sources_ans_sql(ctx: ReadContext, win: Window, *, types: str = "col") -> Sql:
    """엔진별 한 행: n<k>(카테고리 k 인용 수)·<유형>_<k>(그 유형 신호 답변의 카테고리 k 인용 수)·unfilled·ovr_pending·t_unfilled·
    pos_answers·neg_answers. fold_ans_rows 가 sources_sql 과 같은 모양의 행(engine_key, category_key, citations, t_*, grp)으로 접는다.
    types = 'col'(유형 플래그 = 답변 열 t_own, DB-v2.18) | 'jt'(종전: rd.answer_brand 를 답변별로 접은 jt) | 'none'(include_types=false:
    유형 열 없음). 두 경로 결과 동치(tests/test_t_own_path.py). 'jt'·'none' 의 t_unfilled 는 항상 0.
    pos_answers·neg_answers(B098): 같은 스캔에서 센 관점 톤 답변 수(core.measure.tone_expr ∧ cit_n > 0). tone_sql 의 답변 CTE(n)와 같은
    술어·같은 값이라 출처 축이 없으면 tone_sql(answers=False)과 짝으로 쓴다(tone_answers_of). 관점 비트가 없으면 0(톤 판정 불가)."""
    if types not in ("col", "jt", "none"):
        raise ValueError(f"types 는 col|jt|none: {types}")
    ms = ctx.measure()
    b = Binder("s")
    aw = win.where("a", FAMILY, b) + scope_where(ms, "a", b) + [citation_population(ms, "a")]
    cols = [f"coalesce(sum(a.cit_c{k}), 0) AS n{k}" for k in CAT_KEYS]
    if types == "col":
        mp = mention_population(ms, "a", "brand")
        cols += [f"coalesce(sum(a.cit_c{k}) FILTER (WHERE {mp} AND (a.t_own & {t_own_mask(ctx.own_bits, i)}) <> 0), 0) AS {tc}_{k}"
                 for i, tc in enumerate(TYPE_COLS.values()) for k in CAT_KEYS]
    elif types == "jt":
        cols += [f"coalesce(sum(a.cit_c{k}) FILTER (WHERE jt.{tc}), 0) AS {tc}_{k}" for tc in TYPE_COLS.values() for k in CAT_KEYS]
    cols += ["count(*) FILTER (WHERE a.cit_n > 0 AND a.cit_c1 IS NULL) AS unfilled",
             "(SELECT count(*) FROM app.citation_domain_override o JOIN rd.dim_source ds ON ds.skey = o.domain"
             " WHERE o.category_key IS NOT NULL AND o.category_key <> ds.category_key) AS ovr_pending",
             "count(*) FILTER (WHERE a.t_own IS NULL) AS t_unfilled" if types == "col" else "0 AS t_unfilled"]
    if ctx.own_bits:
        pos, neg = tone_expr(ctx.own_bits, "a")
        cols += [f"count(*) FILTER (WHERE {pos}) AS pos_answers", f"count(*) FILTER (WHERE {neg}) AS neg_answers"]
    else:
        cols += ["0 AS pos_answers", "0 AS neg_answers"]
    sel = ",\n       ".join(cols)
    if types != "jt":
        txt = f"""
SELECT a.engine_key,
       {sel}
  FROM {fact_tables(ms).answer} a
 WHERE {' AND '.join(aw)} AND a.cit_n > 0
 GROUP BY a.engine_key
"""
    else:
        txt = f"""
WITH {_type_flags(ctx, ms, win, b)}
SELECT a.engine_key,
       {sel}
  FROM {fact_tables(ms).answer} a LEFT JOIN jt ON jt.answer_key = a.answer_key
 WHERE {' AND '.join(aw)} AND a.cit_n > 0
 GROUP BY a.engine_key
"""
    return b.sql(txt)


def t_own_unfilled(rows: list[dict]) -> bool:
    """답변 열 경로(types='col') 결과에 t_own 미채움 모수 답변이 있나(있으면 jt 경로로 다시 센다)."""
    return any(int(r["t_unfilled"] or 0) > 0 for r in rows)


def ans_path_usable(rows: list[dict]) -> bool:
    """답변 열 경로 결과를 쓸 수 있나(미채움 답변·미반영 오버라이드가 없다). 행이 없으면(모수 답변 0) 쓸 수 있다."""
    return all(int(r["unfilled"] or 0) == 0 and int(r["ovr_pending"] or 0) == 0 for r in rows)


def tone_answers_of(rows: list[dict]) -> dict[str, int]:
    """sources_ans_sql 엔진별 행 → 톤 타일 답변 수(엔진 합). 답변은 엔진 하나에만 속해 엔진 합 = 전체 답변 수다.
    답변 열 경로를 못 써 원소 경로로 되돌려도(ans_path_usable 거짓) 이 값은 쓴다: 답변 단위 술어(cit_n > 0)라 cit_c 채움·오버라이드와 무관하다."""
    return {"pos_answers": sum(int(r["pos_answers"] or 0) for r in rows),
            "neg_answers": sum(int(r["neg_answers"] or 0) for r in rows)}


def fold_ans_rows(rows: list[dict], cat_keys: tuple[int, ...] | None) -> list[dict]:
    """sources_ans_sql 행 → sources_sql 과 같은 행(GROUPING grp 0 = 엔진×카테고리, 2 = 카테고리, 3 = 전체). 0 인 조합은 원소 경로처럼 행이 없다.
    cat_keys = source[] 로 고른 카테고리(None = 전부). 유형 열이 없는 결과(types='none')는 t_* 가 0 이다(호출자가 쓰지 않는다)."""
    keys = CAT_KEYS if cat_keys is None else tuple(k for k in CAT_KEYS if k in set(cat_keys))
    tcols = tuple(TYPE_COLS.values())
    out: list[dict] = []
    cat: dict[int, dict] = {}
    for r in rows:
        for k in keys:
            n = int(r[f"n{k}"] or 0)
            if n == 0:
                continue
            e = {"engine_key": r["engine_key"], "category_key": k, "citations": n, "grp": 0}
            for tc in tcols:
                e[tc] = int(r.get(f"{tc}_{k}") or 0)
            out.append(e)
            c = cat.setdefault(k, {"engine_key": None, "category_key": k, "citations": 0, "grp": 2, **{tc: 0 for tc in tcols}})
            c["citations"] += n
            for tc in tcols:
                c[tc] += e[tc]
    out.extend(cat[k] for k in sorted(cat))
    tot = {"engine_key": None, "category_key": None, "citations": sum(c["citations"] for c in cat.values()), "grp": 3,
           **{tc: sum(c[tc] for c in cat.values()) for tc in tcols}}
    out.append(tot)
    return out


def tone_sql(ctx: ReadContext, win: Window, *, answers: bool = True) -> Sql:
    """톤 타일 한 행(pos_urls·pos_citations·pos_answers·neg_*). 모집단 = 종전 rd.citation ⋈ rd.answer(citation_where + 같은 창) 과 같다:
    답변 쪽 술어(창 + 필터 축 + cit_in)는 rd.citation 게이트·축 열이 답변 사본(전파 함수 대상)이라 인용 쪽과 같은 답변을 고른다.
    answers=False(B098, 출처 축 없을 때): 답변 CTE(n)를 빼고 url·인용 4열만 낸다. 답변 수는 sources_ans_sql 이 같은 술어로 센다
    (pos_answers·neg_answers). 출처 축이 있으면 답변 수가 같은 인용 조인 안에서 접히므로 answers 와 무관하게 6열이다."""
    ms = ctx.measure()
    b = Binder("t")
    pos, neg = tone_expr(ctx.own_bits, "a")

    def answer_where() -> str:    # 창 3술어 + 필터 축 + 인용 모수(부분 식마다 바인드를 새로 받는다)
        return " AND ".join(win.where("a", FAMILY, b) + scope_where(ms, "a", b) + [citation_population(ms, "a")])

    head = f"""
WITH ta AS (
  SELECT a.answer_key, {pos} AS pos
    FROM {fact_tables(ms).answer} a
   WHERE {answer_where()} AND ({pos} OR {neg})),"""
    # 인용 쪽은 창 3술어 + 호스트 + 출처 축만 건다: 게이트·필터 축(cit_in·is_rep·bgrp·카탈로그 세미조인·국가·엔진…)은 rd.citation 에서 부모 답변
    # 사본이라 ta(같은 술어로 고른 답변)와의 조인이 이미 건다. 종전처럼 인용 쪽에도 되풀이하면 현행 프로필 catalog_incl_deleted 의
    # dim_prompt 세미조인이 인용 행마다 붙는다(stg 9/28 브랜드 현대 26.7만 번 dim_prompt 조회, 톤 문장 194 → 317ms, WU-5).
    cw = " AND ".join(win.where("c", FAMILY, b) + ["c.source_key <> 0"] + source_where(ms, "c", b))
    if ms.source_category_keys is None and not answers:
        txt = f"""{head}
u AS (
  SELECT ta.pos, c.url_key, count(*) AS n
    FROM {fact_tables(ms).citation} c JOIN ta ON ta.answer_key = c.answer_key
   WHERE {cw}
   GROUP BY ta.pos, c.url_key)
SELECT count(*) FILTER (WHERE u.pos) AS pos_urls, coalesce(sum(u.n) FILTER (WHERE u.pos), 0) AS pos_citations,
       count(*) FILTER (WHERE NOT u.pos) AS neg_urls, coalesce(sum(u.n) FILTER (WHERE NOT u.pos), 0) AS neg_citations
  FROM u
"""
    elif ms.source_category_keys is None:
        txt = f"""{head}
u AS (
  SELECT ta.pos, c.url_key, count(*) AS n
    FROM {fact_tables(ms).citation} c JOIN ta ON ta.answer_key = c.answer_key
   WHERE {cw}
   GROUP BY ta.pos, c.url_key),
t AS (
  SELECT count(*) FILTER (WHERE u.pos) AS pos_urls, coalesce(sum(u.n) FILTER (WHERE u.pos), 0) AS pos_citations,
         count(*) FILTER (WHERE NOT u.pos) AS neg_urls, coalesce(sum(u.n) FILTER (WHERE NOT u.pos), 0) AS neg_citations
    FROM u),
n AS (
  SELECT count(*) FILTER (WHERE {pos} AND a.cit_n > 0) AS pos_answers,
         count(*) FILTER (WHERE {neg} AND a.cit_n > 0) AS neg_answers
    FROM {fact_tables(ms).answer} a
   WHERE {answer_where()})
SELECT t.pos_urls, t.pos_citations, n.pos_answers, t.neg_urls, t.neg_citations, n.neg_answers
  FROM t CROSS JOIN n
"""
    else:
        # source[]: 선택 출처 인용만 남아 작다. 같은 조인 한 번에서 (톤, url)·(톤, 답변) 두 묶음을 같이 접는다(gs 1 = url 묶음, 2 = 답변 묶음)
        txt = f"""{head}
u AS (
  SELECT ta.pos, count(*) AS n, GROUPING(c.url_key, c.answer_key) AS gs
    FROM {fact_tables(ms).citation} c JOIN ta ON ta.answer_key = c.answer_key
   WHERE {cw}
   GROUP BY GROUPING SETS ((ta.pos, c.url_key), (ta.pos, c.answer_key)))
SELECT count(*) FILTER (WHERE u.pos AND u.gs = 1) AS pos_urls,
       coalesce(sum(u.n) FILTER (WHERE u.pos AND u.gs = 1), 0) AS pos_citations,
       count(*) FILTER (WHERE u.pos AND u.gs = 2) AS pos_answers,
       count(*) FILTER (WHERE NOT u.pos AND u.gs = 1) AS neg_urls,
       coalesce(sum(u.n) FILTER (WHERE NOT u.pos AND u.gs = 1), 0) AS neg_citations,
       count(*) FILTER (WHERE NOT u.pos AND u.gs = 2) AS neg_answers
  FROM u
"""
    return b.sql(txt)


def types_sql(ctx: ReadContext, win: Window) -> Sql:
    """/sources/types 전용(유형만): jt ⋈ rd.citation 을 출처로 접고 유형 5종 × 카테고리. /sources 는 sources_sql 의 grp 2 행을 쓴다."""
    ms = ctx.measure()
    b = Binder("y")
    counts = ",\n         ".join(f"count(*) FILTER (WHERE jt.{col}) AS {col}" for col in TYPE_COLS.values())
    sums = ", ".join(f"sum(g.{col}) AS {col}" for col in TYPE_COLS.values())
    txt = f"""
WITH {_type_flags(ctx, ms, win, b)},
g AS (
  SELECT c.source_key,
         {counts}
    FROM {fact_tables(ms).citation} c JOIN jt ON jt.answer_key = c.answer_key
   WHERE {' AND '.join(citation_where(ms, win, "c", b))}
   GROUP BY c.source_key)
SELECT {CATEGORY_EXPR} AS category_key, {sums}
  FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
  {OVERRIDE_JOIN}{_cat_filter(ctx, b)}
 GROUP BY 1
"""
    return b.sql(txt)
