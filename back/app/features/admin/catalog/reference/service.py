"""admin.catalog.reference 업무 규칙. 시장 어휘 정규화는 admin.catalog.prompts.service 와 같은 함수를 쓴다(편집 검증과 화면이 갈리지 않게)."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.db import fetch_all
from app.features.admin.catalog.prompts.service import root_dim
from app.features.admin.catalog.reference import queries as q
from app.features.admin.catalog.reference.schemas import Market, MarketData, TaxonomyData, TaxonomyRow


async def taxonomy(ro: AsyncConnection) -> TaxonomyData:
    rows = await fetch_all(ro, q.TAXONOMY_SQL)
    fs = await fetch_all(ro, q.FUNNEL_SQL)
    return TaxonomyData(items=[TaxonomyRow(**r) for r in rows], funnel_stages=[r["funnel_stage"] for r in fs])


async def markets(ro: AsyncConnection) -> MarketData:
    _, vocab = await root_dim(ro)
    items = [Market(code=c, pseudo=c.startswith("x:")) for c in (vocab or [])]
    return MarketData(items=items, bounded=vocab is not None)
