"""analytics.mentions.brands 읽기 SQL(rd 만). 당사 합계는 core.measure.fetch_counts(rd.answer 당사 열, G-03),
경쟁 행은 core.measure.brand_rows(QUERY-FIXES M-1) 를 그대로 쓰고, 이 파일은 그 둘이 내지 않는 조각만 둔다.

- own_sentiment_sql: 당사 행 감성 4계열. rd.answer 는 sent_pos·sent_neg·sent_all 만 있어 중립·혼합을 나눌 수 없으므로
  rd.answer_brand 당사 행(competitive ∧ own_bit = ANY(관점 비트))의 s_* 를 합한다. 술어는 core 빌더(Window.where·scope_where)만 쓴다.
- brand_names_sql: 표시 이름(rd.dim_brand_name) 점 조회. 당사 행 brand_key 는 관점 brand_code 와 같은 이름으로 찾는다. own_bit 는 HMG 표식(BG-15).
- brand_extras_sql(BG-12·13·14): rd.answer_brand 경쟁 행(competitive ∧ std_in)을 (brand_key, own_bit)로 접어 등장 프롬프트 수·복수 언급
  3값·유형 5종. 경쟁 행 PK 가 (답변, 브랜드, competitive) 라 한 행 = (답변 × 브랜드) 이고 mention_count 가 그 답변의 브랜드 언급 수다.
- own_extras_sql(BG-12·13 당사): rd.answer 당사 열(core.measure.own_cols, G-03)로 관점 묶음마다 등장 프롬프트 수·복수 언급 3값.
  당사 행 언급·노출이 rd.answer 당사 열에서 오므로(fetch_counts) 같은 원천을 쓴다(복수 언급 답변 수 = K-1 engines multi 와 같은 식).
- own_counts_sql(D13 split_own, 검증 D7): 관점 전체와 비트별 당사 합계를 rd.answer 1회 스캔으로(fetch_counts parts=mentions 와 같은 식).
"""
from __future__ import annotations

from collections.abc import Sequence

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, citation_population, mention_population, own_cols, scope_where
from app.core.sqlb import Binder, Sql

# 유형 5종(응답 순서 고정) → rd.answer_brand 열(analytics.mentions.types 와 같은 화이트리스트)
TYPE_COLS: dict[str, str] = {"mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
                             "definition": "t_definition", "final_choice": "t_final_choice"}


def own_sentiment_sql(ms: MeasureScope, win: Window, *, by_bit: bool = False, by_engine: bool = False) -> Sql:
    """당사 행 감성 4계열. by_bit = 당사 비트별(split_own), by_engine = 엔진별(group_by=engine). 둘 다 거짓이면 한 행(종전)."""
    b = Binder("o")
    w = (win.where("b", "mentions", b) + scope_where(ms, "b", b)
         + [mention_population(ms, "b", "brand"), "b.competitive", f"b.own_bit = ANY({b.ints(ms.own_bits)})"])
    keys = (["b.own_bit"] if by_bit else []) + (["b.engine_key"] if by_engine else [])
    t = (f"SELECT {''.join(k + ', ' for k in keys)}coalesce(sum(b.s_pos), 0) AS s_pos, coalesce(sum(b.s_neu), 0) AS s_neu,\n"
         "       coalesce(sum(b.s_neg), 0) AS s_neg, coalesce(sum(b.s_mix), 0) AS s_mix, coalesce(sum(b.mention_count), 0) AS mentions\n"
         f"  FROM {fact_tables(ms).answer_brand} b\n WHERE {' AND '.join(w)}")
    if keys:
        t += "\n GROUP BY " + ", ".join(keys)
    return b.sql(t)


def brand_extras_sql(ms: MeasureScope, win: Window) -> Sql:
    """경쟁 행 전 브랜드(당사 포함)의 등장 프롬프트 수·복수 언급 3값·유형 5종. 당사/경쟁 구분은 호출자가 own_bit 로 한다.
    성능(A4, 2026-09-30 stg 조사): count(DISTINCT prompt_key) 두 개가 병렬 집계를 막아 27만 행 정렬(Buffers 18.7만)이 됐다.
    (brand_key, own_bit, prompt_key) 로 먼저 접고(병렬 해시 집계) 바깥에서 센다. 값이 같은 이유:
    prompts = 안쪽 그룹 수(prompt_key NOT NULL), multi_prompts = 복수 언급 행이 있는 안쪽 그룹 수, 나머지는 가산(합의 합).
    바깥 합은 int8 로 되돌린다(안쪽 sum(int2) = int8, 그 합 numeric → 예전 열 형 int8 유지)."""
    b = Binder("x")
    w = win.where("b", "mentions", b) + scope_where(ms, "b", b) + [mention_population(ms, "b", "brand"), "b.competitive"]
    multi = "b.mention_count >= 2"
    inner = ["b.brand_key", "b.own_bit", "b.prompt_key", f"count(*) FILTER (WHERE {multi}) AS ma",
             f"sum(b.mention_count) FILTER (WHERE {multi}) AS mm"]
    inner += [f"sum(b.{c}) AS {k}" for k, c in TYPE_COLS.items()]
    cols = ["p.brand_key", "p.own_bit", "count(*) AS prompts", "coalesce(sum(p.ma), 0)::int8 AS multi_answers",
            "coalesce(sum(p.mm), 0)::int8 AS multi_mentions", "count(*) FILTER (WHERE p.ma > 0) AS multi_prompts"]
    cols += [f"coalesce(sum(p.{k}), 0)::int8 AS {k}" for k in TYPE_COLS]
    t = (f"SELECT {', '.join(cols)}\n"
         f"  FROM (SELECT {', '.join(inner)}\n          FROM {fact_tables(ms).answer_brand} b\n         WHERE {' AND '.join(w)}\n"
         "         GROUP BY b.brand_key, b.own_bit, b.prompt_key) p\n"
         " GROUP BY p.brand_key, p.own_bit")
    return b.sql(t)


def own_extras_sql(ms: MeasureScope, win: Window, groups: Sequence[Sequence[int]]) -> Sql:
    """rd.answer 1회 스캔으로 관점 묶음(groups[i] = 당사 비트 묶음)마다 p{i}(등장 프롬프트)·ma{i}·mm{i}·mp{i}(복수 언급 답변·언급·프롬프트).
    등장 = 그 묶음 당사 열 노출(own_mask), 복수 = 그 묶음 당사 언급 합 ≥ 2(core.measure.own_cols). 비트 식은 FILTER 안에서만."""
    b = Binder("w")
    w = win.where("a", "mentions", b) + scope_where(ms, "a", b) + [mention_population(ms, "a")]
    cols: list[str] = []
    for i, bits in enumerate(groups):
        oc = own_cols(bits, "a")
        hit, multi = f"(a.own_mask & {oc.mask}) <> 0", f"{oc.ment} >= 2"
        cols += [f"count(DISTINCT a.prompt_key) FILTER (WHERE {hit}) AS p{i}", f"count(*) FILTER (WHERE {multi}) AS ma{i}",
                 f"coalesce(sum({oc.ment}) FILTER (WHERE {multi}), 0) AS mm{i}",
                 f"count(DISTINCT a.prompt_key) FILTER (WHERE {multi}) AS mp{i}"]
    t = f"SELECT {', '.join(cols)}\n  FROM {fact_tables(ms).answer} a\n WHERE {' AND '.join(w)}"
    return b.sql(t)


OWN_COUNT_KEYS = ("tracked", "own_mentions", "rank_sum", "ranked")


def own_counts_sql(ms: MeasureScope, win: Window, groups: Sequence[Sequence[int]], *, by_engine: bool = False) -> Sql:
    """split_own 당사 합계(검증 D7): rd.answer 1회 스캔으로 답변 수·전체 언급과 관점 묶음(groups[i])마다 tracked{i}·own_mentions{i}·
    rank_sum{i}·ranked{i}. groups[0] = 관점 전체(합친 당사), 뒤 = 비트 하나씩. 식은 core.measure.plan_counts parts=mentions 와 같다
    (WHERE = 창(언급 회차)·필터 축·cit_in, 값 = std_in FILTER, 당사 열 = core.measure.own_cols). 비트 식은 FILTER 안에서만.
    by_engine = 엔진별(engine_key). fetch_counts 를 비트마다 부르던 N 번 스캔을 한 번으로 줄인다."""
    b = Binder("s")
    a = "a"
    w = win.where(a, "row", b, keys=win.union_keys("mentions")) + scope_where(ms, a, b) + [citation_population(ms, a)]
    mg = mention_population(ms, a)
    cols = [f"count(*) FILTER (WHERE {mg}) AS answers", f"coalesce(sum({a}.ment_total) FILTER (WHERE {mg}), 0) AS total_mentions"]
    for i, bits in enumerate(groups):
        oc = own_cols(bits, a)
        cols += [f"count(*) FILTER (WHERE {mg} AND ({a}.own_mask & {oc.mask}) <> 0) AS tracked{i}",
                 f"coalesce(sum({oc.ment}) FILTER (WHERE {mg}), 0) AS own_mentions{i}",
                 f"coalesce(sum({oc.rank}) FILTER (WHERE {mg} AND {oc.ranked}), 0) AS rank_sum{i}",
                 f"count(*) FILTER (WHERE {mg} AND {oc.ranked}) AS ranked{i}"]
    sel = [f"{a}.engine_key AS engine_key"] if by_engine else []
    t = f"SELECT {', '.join(sel + cols)}\n  FROM {fact_tables(ms).answer} {a}\n WHERE {' AND '.join(w)}"
    if by_engine:
        t += "\n GROUP BY 1"
    return b.sql(t)


def brand_names_sql(keys: Sequence[int], names: Sequence[str]) -> Sql:
    b = Binder("n")
    t = ("SELECT brand_key, name, own_bit FROM rd.dim_brand_name "
         f"WHERE brand_key = ANY({b.ints(keys, 'int4')}) OR name = ANY({b.v(sorted(set(names)), 'text[]')})")
    return b.sql(t)
