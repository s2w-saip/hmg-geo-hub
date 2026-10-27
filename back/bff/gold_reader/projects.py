"""Project identities and measurements supplied by Gold; no invented app metadata."""
from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader.context import Context, envelope


async def listing(ctx):
    rows = await ctx.conn.fetch("""WITH jobs AS (
        SELECT project_key,count(*) FILTER(WHERE served)::int AS answers,max(measured_at) AS last_measured
        FROM gold.job_index WHERE surface=3 GROUP BY project_key),
        prompts AS (SELECT project_key,count(*)::int AS prompts FROM gold.dim_prompt WHERE surface=3 GROUP BY project_key)
        SELECT d.project_key,coalesce(d.project_id,d.scope_project_id) AS id,d.scope_project_id,d.regions,
            coalesce(p.prompts,0) AS prompts,coalesce(j.answers,0) AS answers,j.last_measured
        FROM gold.dim_project d LEFT JOIN jobs j USING(project_key) LEFT JOIN prompts p USING(project_key)
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
