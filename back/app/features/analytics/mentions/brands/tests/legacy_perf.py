"""성능 라운드 A4(2026-09-30) 이전 brand_extras_sql 사본: 동치 테스트(test_perf_equiv)의 기준. de720bb 식 그대로. 요청 경로에서 쓰지 않는다."""
from __future__ import annotations

from app.core.cycles import Window
from app.core.measure import MeasureScope, scope_where
from app.core.sqlb import Binder, Sql
from app.features.analytics.mentions.brands.queries import TYPE_COLS


def brand_extras_sql(ms: MeasureScope, win: Window) -> Sql:
    b = Binder("x")
    w = win.where("b", "mentions", b) + scope_where(ms, "b", b) + ["b.std_in", "b.competitive"]
    multi = "b.mention_count >= 2"
    cols = ["b.brand_key", "b.own_bit", "count(DISTINCT b.prompt_key) AS prompts",
            f"count(*) FILTER (WHERE {multi}) AS multi_answers",
            f"coalesce(sum(b.mention_count) FILTER (WHERE {multi}), 0) AS multi_mentions",
            f"count(DISTINCT b.prompt_key) FILTER (WHERE {multi}) AS multi_prompts"]
    cols += [f"coalesce(sum(b.{c}), 0) AS {k}" for k, c in TYPE_COLS.items()]
    t = f"SELECT {', '.join(cols)}\n  FROM rd.answer_brand b\n WHERE {' AND '.join(w)}\n GROUP BY b.brand_key, b.own_bit"
    return b.sql(t)
