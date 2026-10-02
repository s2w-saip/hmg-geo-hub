"""analytics.kpi.compare 읽기 SQL. 측정 합계는 core 빌더가 낸다.

측정 합계는 core.measure.fetch_counts(group_by cycle), 스캔 창은 core.cycles.resolve_window, 누락 비중(Q2) 원장은
core.cycles.ledger_rows(계열별), 전 이력 첫 발행은 core.cycles.first_published(계열 필수)가 낸다(술어 재구현 금지).

cit_answers_sql(BG-05 답변당 인용 수 분모 보조): 인용 계열 회차 중 언급 계열에서 숨긴 회차(hidden_scope 3)는 fetch_counts 의
gap_base(언급 계열 FILTER)에 잡히지 않는다. 그 회차만 cit_in 답변 수를 센다. WHERE 는 core 빌더(Window.where 인용 계열 + keys,
measure.scope_where)로만 만든다(사실 표 3술어·필터 축 동일, fact_guard 통과).
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, citation_population, scope_where
from app.core.sqlb import Binder, Sql


def cit_answers_sql(ms: MeasureScope, win: Window, keys: tuple[int, ...]) -> Sql:
    """회차(cyc_key)별 cit_in 답변 수(인용 계열 모수). keys = 인용 계열 회차 중 언급 계열 밖 회차."""
    b = Binder("n")
    where = win.where("a", "citations", b, keys=keys) + scope_where(ms, "a", b) + [citation_population(ms, "a")]
    return b.sql(f"SELECT a.cyc_key, count(*) AS cit_answers FROM {fact_tables(ms).answer} a WHERE {' AND '.join(where)} GROUP BY 1")
