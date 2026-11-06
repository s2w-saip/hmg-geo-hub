"""Gold-backed /v1 readers. Missing source capabilities are explicit errors."""
from fastapi import HTTPException
from starlette.datastructures import QueryParams

from data_server.gold_reader import acr, advanced, answers, catalog, citations, compare, drilldown, insights, metrics, projects, week_notes
from data_server.gold_reader.context import Context
from data_server.gold_reader.db import connection
from data_server.hub_stores import metrics_db
from data_server.metrics.gold_rows import scope_of
from data_server.metrics.serving import ROW_READS

METRICS = {"filters/options": metrics.options, "filters/dates": metrics.dates,
           "kpi/summary": metrics.summary, "kpi/engines": metrics.engines,
           "mentions/brands": metrics.brands, "trend": metrics.trend}


async def read(path: str, q: QueryParams) -> dict:
    """One Gold /v1 GET in one read-only transaction on the pinned release."""
    async with connection() as conn:
        # gold/projects · keywords · social read no global or website round: the service week leaves them out
        row_read = path in ROW_READS
        ctx = await Context.create(conn, q, capped=not path.startswith("gold/"), lazy_catalog=row_read)
        if row_read and (not metrics_db.configured() or scope_of(ctx) is None):
            await ctx.load_catalog()
        if path in METRICS:
            return await METRICS[path](ctx)
        if path == "source":
            return {"data": {"source": "gold", "read_only": True, "release": ctx.release}, "meta": ctx.meta()}
        return await dispatch(path, ctx)


async def dispatch(path, ctx):
    handlers = {"citations/domains": citations.domains, "citations/sources": citations.sources,
                "citations/targets": citations.targets, "funnel/acr": acr.read, "funnel/acr/territory": acr.territory, "funnel/acr/coverage": acr.coverage,
                "prompts": catalog.prompts, "kpi/unmeasured-prompts": catalog.unmeasured,
                "answers": answers.listing, "geo": advanced.geo, "mentions/types": advanced.types,
                "kpi/compare": compare.read, "mentions/prompts": drilldown.mention_prompts,
                "mentions/missing-prompts": drilldown.missing_prompts,
                "mentions/market-gaps": drilldown.market_gaps,
                "citations/prompts": drilldown.citation_prompts, "citations/sources/tone": drilldown.tone,
                "cycles/week-notes": week_notes.read}
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
