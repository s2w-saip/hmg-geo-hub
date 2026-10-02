"""ACR 순수 함수 단위 테스트(DB 불필요)."""
from __future__ import annotations

import dataclasses
from datetime import date
from types import SimpleNamespace

from app.core.codes import Country
from app.core.cycles import CycleRow, build_window
from app.core.measure import MeasureScope
from app.core.sqlb import Binder
from app.features.analytics.funnel.acr.queries import cells_cte
from app.features.analytics.funnel.acr.service import hidden_countries, langs_scope, trend_window


def test_trend_window_pure():
    rows = [CycleRow(1, 1, date(2026, 8, d), 0) for d in (3, 10, 17)] + [CycleRow(4, 1, date(2026, 8, 24), 3),
                                                                          CycleRow(5, 1, date(2026, 8, 31), 0)]
    cand = build_window(surface="global", mode="cumulative", rows=rows, lo=date(2000, 1, 1), hi=date(2026, 8, 31),
                        generation=1, project_keys=(1,))
    snap = build_window(surface="global", mode="snapshot", rows=[rows[-1]], lo=date(2026, 8, 31), hi=date(2026, 8, 31),
                        generation=1, project_keys=(1,))
    tw = trend_window(snap, cand, 2)
    assert tw.round_dates == (date(2026, 8, 17), date(2026, 8, 31))          # 언급 숨김(3) 회차 08-24 는 건너뛴다
    assert tw.where("c", "mentions", Binder())[1].startswith("c.round_date BETWEEN")
    assert trend_window(snap, cand, 12).round_dates == (date(2026, 8, 3), date(2026, 8, 10), date(2026, 8, 17), date(2026, 8, 31))



def test_cells_cte_default_engines_and_three_predicates():
    """엔진 축이 없으면 core scope_where(dflt_column=False) 가 기본 엔진 키(ms.default_engine_keys)로 건다(acr_cell 에 dflt 없음)."""
    ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1, 8), default_engine_keys=(1, 2))
    win = build_window(surface="global", mode="snapshot", rows=[CycleRow(11, 1, date(2026, 9, 14), 0)], lo=date(2026, 9, 14),
                       hi=date(2026, 9, 14), generation=1, project_keys=(1,))
    for m, want in ((ms, [1, 2]), (dataclasses.replace(ms, engine_keys=(3,)), [3]), (dataclasses.replace(ms, engine_keys=()), [])):
        b = Binder()
        t = cells_cte(m, win, b)
        for frag in ("c.surface = ", "c.round_date = ", "c.cyc_key = ANY(", "c.engine_key = ANY(", "c.bgrp = ANY(", "c.acr_in"):
            assert frag in t
        assert "dflt" not in t and want in b.params.values()


def test_langs_scope_drops_engine_lang_taxonomy_d5():
    """검증 D5: 언어 옵션은 현행 listMeasuredAcrLanguages 처럼 스코프 브랜드·국가·기간만 건다. 엔진은 전 엔진(기본 엔진 한정 없음),
    lang·택소노미·커스텀(prompt_keys)은 뺀다. 브랜드(bgrps)·국가(geo_keys)·프로젝트는 그대로 둔다."""
    refs = SimpleNamespace(engines={"chatgpt": (1, True), "gemini": (2, True), "deepseek": (3, False), "": (0, False)})
    ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1, 8), geo_keys=(7,), lang_keys=(2,), engine_keys=(3,),
                      prompt_keys=(11, 12), default_engine_keys=(1, 2))
    got = langs_scope(ms, refs)   # type: ignore[arg-type]
    assert (got.engine_keys, got.lang_keys, got.prompt_keys) == ((0, 1, 2, 3), None, None)
    assert (got.bgrps, got.geo_keys, got.project_keys) == ((1, 8), (7,), (1,))
    assert langs_scope(dataclasses.replace(ms, engine_keys=None), refs).engine_keys == (0, 1, 2, 3)   # type: ignore[arg-type]


def test_hidden_countries_by_surface_d2():
    """검증 D2: 국가 옵션 숨김 = global 은 rd.dim_country.hidden_standard, website 는 app.hidden_market('website'), project 는 없음
    (/v1/filters/options build_matrix 와 같은 규칙)."""
    cs = {c.code: c for c in (Country(1, "ID", "iso", None, None, True), Country(2, "KR", "iso", None, None, False),
                              Country(3, "US", "iso", None, None, False))}
    refs = SimpleNamespace(countries=cs, hidden_markets={"website": frozenset({"KR"}), "global": frozenset({"US"})})
    assert hidden_countries(SimpleNamespace(surface="global", refs=refs)) == {"ID"}          # type: ignore[arg-type]
    assert hidden_countries(SimpleNamespace(surface="website", refs=refs)) == {"KR"}         # type: ignore[arg-type]
    assert hidden_countries(SimpleNamespace(surface="project", refs=refs)) == frozenset()    # type: ignore[arg-type]
