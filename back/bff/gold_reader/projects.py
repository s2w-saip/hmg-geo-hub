"""Project identities and measurements supplied by Gold; no invented app metadata."""
from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader.context import Context, envelope


async def listing(ctx):
    # Gold has no project name, brand or country (dim_project is ids only): a project is told apart by the
    # countries, engines and languages it was measured in and its first prompt (2026-11-03, renewal Project list).
    rows = await ctx.conn.fetch("""WITH jobs AS (
        SELECT j.project_key,count(*) FILTER(WHERE j.served)::int AS answers,max(j.measured_at) AS last_measured,
            array_agg(DISTINCT c.code ORDER BY c.code) FILTER(WHERE j.served AND c.code<>'') AS countries,
            array_agg(DISTINCT e.code ORDER BY e.code) FILTER(WHERE j.served AND e.code<>'') AS engines
        FROM gold.job_index j LEFT JOIN gold.dim_country c USING(geo_key) LEFT JOIN gold.dim_engine e USING(engine_key)
        WHERE j.surface=3 GROUP BY j.project_key),
        prompts AS (SELECT p.project_key,count(*)::int AS prompts,
            array_agg(DISTINCT l.code ORDER BY l.code) FILTER(WHERE l.code<>'') AS languages,
            (array_agg(p.text ORDER BY p.prompt_key))[1] AS first_prompt
            FROM gold.dim_prompt p LEFT JOIN gold.dim_lang l USING(lang_key) WHERE p.surface=3 GROUP BY p.project_key),
        cycles AS (SELECT project_key,count(*)::int AS rounds FROM gold.dim_cycle WHERE surface=3 GROUP BY project_key),
        fields AS (SELECT project_key,count(*)::int AS custom_fields FROM gold.dim_custom_field GROUP BY project_key)
        SELECT d.project_key,coalesce(d.project_id,d.scope_project_id) AS id,d.scope_project_id,d.regions,
            coalesce(p.prompts,0) AS prompts,coalesce(j.answers,0) AS answers,j.last_measured,
            coalesce(j.countries,'{}') AS countries,coalesce(j.engines,'{}') AS engines,
            coalesce(p.languages,'{}') AS languages,coalesce(c.rounds,0) AS rounds,
            coalesce(f.custom_fields,0) AS custom_fields,p.first_prompt
        FROM gold.dim_project d LEFT JOIN jobs j USING(project_key) LEFT JOIN prompts p USING(project_key)
            LEFT JOIN cycles c USING(project_key) LEFT JOIN fields f USING(project_key)
        WHERE d.surface=3 AND coalesce(d.project_id,d.scope_project_id) IS NOT NULL
        ORDER BY j.last_measured DESC NULLS LAST,d.project_key""")
    return envelope(ctx, {"items": [dict(r) for r in rows]})


async def detail(ctx, project_id):
    project = await ctx.conn.fetchrow("""SELECT * FROM gold.dim_project
        WHERE surface=3 AND (project_id::text=$1 OR scope_project_id::text=$1) ORDER BY project_key LIMIT 1""", project_id)
    if not project:
        raise HTTPException(404, "Project not present in Gold")
    if ctx.q.get("view") == "gate":
        return envelope(ctx,{"project":dict(project),"prompts":[]})
    params = [(k, v) for k, v in ctx.q.multi_items() if k not in {"surface", "project_id", "card"}]
    params += [("surface", "project"), ("project_id", project_id)]
    ctx = await Context.create(ctx.conn, QueryParams(params))
    prompts = await ctx.conn.fetch("""WITH jobs AS (
        SELECT prompt_key,count(*) FILTER(WHERE served)::int AS answers,max(measured_at) AS last_measured
        FROM gold.job_index WHERE project_key=$1 GROUP BY prompt_key)
        SELECT p.prompt_id,p.text,p.kind,l.code AS lang,p.regions,p.targets,t.code AS funnel,coalesce(j.answers,0) AS answers,j.last_measured
        FROM gold.dim_prompt p LEFT JOIN gold.dim_lang l USING(lang_key) LEFT JOIN jobs j USING(prompt_key)
        LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
        WHERE p.project_key=$1 ORDER BY p.prompt_key LIMIT 1000""", project["project_key"])
    return envelope(ctx, {"project": dict(project), "prompts": [dict(r) for r in prompts]})
