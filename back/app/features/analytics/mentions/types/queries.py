"""analytics.mentions.types 읽기 SQL(rd 만). 술어는 core 빌더(Window.where 3술어 + core.measure.scope_where)만 쓴다.

- types_sql: rd.answer_brand 1회 스캔. (round_date, answer_key, 당사 여부)로 먼저 접은 뒤(답변 수 = 접힌 행 수) 당사/비교 두 행으로 집계.
  당사 = own_bit = ANY(관점 비트), 비교 = 그 밖의 경쟁 행(competitive, 모듈-언급 §2.5). 유형·감성 열은 화이트리스트(TYPE_COLS)만.
- stance_sql: A3 스탠스(rd.answer_stance ⋈ rd.answer 등치). 두 사실 표 모두 창 3술어(surface·round_date·cyc_key, 언급 계열)를 건다
  (DB-v2.5 P42: rd.answer_stance.cyc_key = rd.answer.cyc_key 사본, 게이트 전파 대상. an-mentions R1 해소).
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, mention_population, scope_where
from app.core.sqlb import Binder, Sql

# 유형 5종(응답 순서 고정) → rd.answer_brand 열
TYPE_COLS: dict[str, str] = {"mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
                             "definition": "t_definition", "final_choice": "t_final_choice"}
# 감성 4계열 → rd.answer_brand 열
SENT_COLS: dict[str, str] = {"positive": "s_pos", "neutral": "s_neu", "mixed": "s_mix", "negative": "s_neg"}


def types_sql(ms: MeasureScope, win: Window) -> Sql:
    b = Binder("t")
    w = win.where("b", "mentions", b) + scope_where(ms, "b", b) + [mention_population(ms, "b", "brand"), "b.competitive"]
    inner = ["b.round_date", "b.answer_key", f"(b.own_bit = ANY({b.ints(ms.own_bits)})) AS own"]
    outer = ["pa.own"]
    for i, col in enumerate(TYPE_COLS.values()):
        hit = f"b.{col} > 0"
        inner += [f"sum(b.{col}) AS n{i}", f"bool_or({hit}) AS a{i}", f"count(*) FILTER (WHERE {hit}) AS r{i}"]
        outer += [f"coalesce(sum(pa.n{i}), 0) AS n{i}", f"count(*) FILTER (WHERE pa.a{i}) AS a{i}", f"coalesce(sum(pa.r{i}), 0) AS r{i}"]
        for j, sc in enumerate(SENT_COLS.values()):
            inner.append(f"sum(b.{sc}) FILTER (WHERE {hit}) AS s{i}_{j}")
            outer.append(f"coalesce(sum(pa.s{i}_{j}), 0) AS s{i}_{j}")
    t = (f"WITH pa AS (\n  SELECT {', '.join(inner)}\n    FROM {fact_tables(ms).answer_brand} b\n   WHERE {' AND '.join(w)}\n"
         "   GROUP BY b.round_date, b.answer_key, 3)\n"
         f"SELECT {', '.join(outer)}\n  FROM pa\n GROUP BY pa.own")
    return b.sql(t)


def stance_sql(ms: MeasureScope, win: Window) -> Sql:
    """A3: 당사(own_bit = ANY(관점 비트)) 대표 턴(first_turn) 스탠스 4계열 수. 필터 축은 rd.answer 쪽에 건다(스탠스 표에 축 사본 없음).
    두 표 모두 창 3술어(언급 계열: 언급 숨김 회차 제외)를 건다."""
    b = Binder("s")
    w = (win.where("s", "mentions", b) + win.where("a", "mentions", b) + scope_where(ms, "a", b)
         + [mention_population(ms, "a"), "s.first_turn", mention_population(ms, "s", "stance"), f"s.own_bit = ANY({b.ints(ms.own_bits)})"])
    t = (f"SELECT s.stance, count(*) AS n\n  FROM {fact_tables(ms).answer_stance} s\n"
         f"  JOIN {fact_tables(ms).answer} a ON a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key\n"
         f" WHERE {' AND '.join(w)}\n GROUP BY s.stance")
    return b.sql(t)
