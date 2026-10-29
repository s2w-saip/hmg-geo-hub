"""Gold-backed /v1 readers. Missing source capabilities are explicit errors."""
from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader import acr, advanced, answers, catalog, citations, compare, drilldown, insights, metrics, projects
from bff.gold_reader.context import Context
from bff.gold_reader.db import connection

METRICS = {"filters/options": metrics.options, "filters/dates": metrics.dates,
           "kpi/summary": metrics.summary, "kpi/engines": metrics.engines,
           "mentions/brands": metrics.brands, "trend": metrics.trend}


async def read(path: str, q: QueryParams) -> dict:
    """One Gold /v1 GET in one read-only transaction on the pinned release."""
    async with connection() as conn:
        ctx = await Context.create(conn, q)
        if path in METRICS:
            return await METRICS[path](ctx)
        if path == "source":
            return {"data": {"source": "gold", "read_only": True, "release": ctx.release}, "meta": ctx.meta()}
        return await dispatch(path, ctx)


async def dispatch(path, ctx):
    handlers = {"citations/domains": citations.domains, "citations/sources": citations.sources,
                "citations/targets": citations.targets, "funnel/acr": acr.read, "funnel/acr/territory": acr.territory,
                "prompts": catalog.prompts, "kpi/unmeasured-prompts": catalog.unmeasured,
                "answers": answers.listing, "geo": advanced.geo, "mentions/types": advanced.types,
                "kpi/compare": compare.read, "mentions/prompts": drilldown.mention_prompts,
                "citations/prompts": drilldown.citation_prompts, "citations/sources/tone": drilldown.tone}
    if path == "gold/projects":
        return await projects.listing(ctx)
    if path == "gold/keywords":
        return await insights.keywords(ctx)
    if path == "gold/social":
        return await insights.social(ctx)
    if path.startswith("gold/projects/"):
        return await projects.detail(ctx, path.split("/", 2)[2])
    if path in handlers:
        return await handlers[path](ctx)
    if path.startswith("answers/"):
        return await answers.detail(ctx, path.split("/", 1)[1])
    if path.startswith("citations/domains/"):
        return await drilldown.domain(ctx, path.split("/", 2)[2])
    raise HTTPException(503, "This capability is not supplied by the Gold source")
