"""BG CORE-REQUESTS 처분(core 8라운드) 중 core 쪽 반영 확인: split_own 행 키 한 정의(bg-mentions-answers R2·bg-trend-geo R4),
카탈로그 depth4 선언 유지(bg-kpi-filters R3). DDL 요청(known_diff·뷰·열)은 test_db_v29."""
from __future__ import annotations

import inspect
from types import SimpleNamespace

from app.core import measure
from app.core.filters import DEPTH4_AXIS
from app.features.analytics.mentions.brands import common as mentions_common
from app.features.analytics.trend.series import service as trend_service
from app.features.catalog.prompts.catalog.service import CATALOG_SUPPORT
from tests.support import ADMIN, needs_db, raw_fetch, staged


class _Refs:
    def __init__(self, m: dict[int, str]):
        self.m = m

    def brand_code_of_bit(self, bit: int) -> str | None:
        return self.m.get(bit)


def test_split_own_label_single_definition():
    refs = _Refs({1: "Hyundai", 2: "Kia", 4: "Genesis"})
    assert [measure.split_own_label(refs, b) for b in (1, 2, 4, 8)] == ["Hyundai", "Kia", "Genesis", "8"]   # type: ignore[arg-type]
    ctx = SimpleNamespace(refs=refs)
    assert [mentions_common.own_brand_code_of_bit(ctx, b) for b in (1, 2, 8)] == ["Hyundai", "Kia", "8"]    # type: ignore[arg-type]
    # 두 기능 모두 core 정의를 부른다(식을 각자 두지 않는다)
    assert "split_own_label(" in inspect.getsource(mentions_common.own_brand_code_of_bit)
    src = inspect.getsource(trend_service._own_parts)
    assert "split_own_label(" in src and "brand_code_of_bit" not in src


def test_catalog_declares_depth4_on_global():
    """bg-kpi-filters R3: 카탈로그 /v1/prompts 는 global 에서 자체 술어로 depth4 를 적용하므로 지원 축으로 선언해야 'ignored' 로 적히지 않는다."""
    assert DEPTH4_AXIS in CATALOG_SUPPORT.for_surface("global")


@needs_db
async def test_null_brand_catalog_prompt_is_common_row_on_data_axis(seeded):
    """fe-u4 요청 5 → core 10라운드 현행 맞춤: 무브랜드(NULL)·HMG 카탈로그 프롬프트는 엄브렐러 비트(Q11)로 공통 행이고, 필터가 없으면 데이터 축에
    남지만 brand[] 로 좁히면 빠진다(현행 brand 정확 일치). 기능별 대조는 tests/core/test_brand_common.py."""
    from app.core.auth import load_principal
    from app.core.filters import KPI_SUPPORT, CommonFilters, resolve_read_context

    async with staged() as conn:
        rows = await raw_fetch(conn, "SELECT coalesce(p.brand_code, '') AS b, ce.brand_bit, dp.cat_mask, "
                                     "(SELECT array_agg(DISTINCT a.bgrp) FROM rd.answer a WHERE a.surface = 1 AND a.prompt_key = dp.prompt_key) AS bgrps "
                                     "FROM app.prompt p JOIN rd.catalog_entry ce ON ce.catalog_row_id = p.prompt_id "
                                     "JOIN rd.dim_prompt dp ON dp.prompt_key = ce.prompt_key WHERE dp.surface = 1")
        umb = (await raw_fetch(conn, "SELECT brand_bit FROM app.brand WHERE is_umbrella"))[0]["brand_bit"]
        p = await load_principal(conn, ADMIN)
        kia = await resolve_read_context(conn, p, CommonFilters(surface="global", brand=["Kia"]), support=KPI_SUPPORT)
        none = await resolve_read_context(conn, p, CommonFilters(surface="global"), support=KPI_SUPPORT)
    by = {r["b"]: r for r in rows}
    assert by[""]["brand_bit"] == by["HMG"]["brand_bit"] == umb and by[""]["cat_mask"] == umb     # 무브랜드 = 엄브렐러 비트(Q11)
    common = set(by[""]["bgrps"]) | set(by["HMG"]["bgrps"])
    assert common <= set(none.bgrps or ()) and not common & set(kia.bgrps or ())
    assert set(by["Kia"]["bgrps"]) <= set(kia.bgrps or ()) and 1 not in set(kia.bgrps or ()) and 4 not in set(kia.bgrps or ())
