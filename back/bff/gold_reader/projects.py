"""Project identities and measurements supplied by Gold; no invented app metadata."""
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader.context import SQL, Context, envelope, values


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
    if ctx.q.get("view") == "prompts":
        return await prompt_list(ctx)
    prompts = await ctx.conn.fetch("""WITH jobs AS (
        SELECT prompt_key,count(*) FILTER(WHERE served)::int AS answers,max(measured_at) AS last_measured
        FROM gold.job_index WHERE project_key=$1 GROUP BY prompt_key)
        SELECT p.prompt_id,p.text,p.kind,l.code AS lang,p.regions,p.targets,t.code AS funnel,coalesce(j.answers,0) AS answers,j.last_measured
        FROM gold.dim_prompt p LEFT JOIN gold.dim_lang l USING(lang_key) LEFT JOIN jobs j USING(prompt_key)
        LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
        WHERE p.project_key=$1 ORDER BY p.prompt_key LIMIT 1000""", project["project_key"])
    return envelope(ctx, {"project": dict(project), "prompts": [dict(r) for r in prompts]})


async def prompt_list(ctx: Context) -> dict:
    """The renewal Project › Prompt list (2026-11-03, P4): the project's prompts (dim_prompt, in_project_catalog) with
    their custom tag values (prompt_custom_value) and what was measured of each in the lens — answers by engine, rounds,
    countries, first and last round (served jobs of the rounds Gold serves, as the website list counts them). Country,
    engine and period are the lens: they choose the answers a row counts and never drop a row (a project prompt has no
    country of its own, Gold's regions are empty). The fields are the project's tag columns, unarchived, in Gold's
    order (created_at, field_id)."""
    b = SQL()
    dated = ctx.q.get("from") or ctx.q.get("to")
    lens = [f"j.project_key={b.bind(ctx.project_key, 'smallint')}", "j.surface=3", "j.served",
            f"j.round_date=ANY({b.bind(ctx.selected_dates if dated else ctx.dates, 'date[]')})", "cy.servable",
            "coalesce(cy.hidden_scope,0)<>1",
            f"(cy.view_date IS NULL OR cy.view_date<={b.bind(datetime.now(ZoneInfo('Asia/Seoul')).date(), 'date')})"]
    if values(ctx.q, "engine"):
        lens.append(f"lower(e.code)=ANY({b.bind([v.lower() for v in values(ctx.q, 'engine')], 'text[]')})")
    if values(ctx.q, "country"):
        lens.append(f"c.code=ANY({b.bind([v.upper() for v in values(ctx.q, 'country')], 'text[]')})")
    rows = await ctx.conn.fetch(f"""WITH j AS MATERIALIZED (
            SELECT j.prompt_key,j.round_date,e.code AS engine,c.code AS country
            FROM gold.job_index j JOIN gold.dim_engine e ON e.engine_key=j.engine_key
            LEFT JOIN gold.dim_country c ON c.geo_key=j.geo_key JOIN gold.dim_cycle cy ON cy.cyc_key=j.cyc_key
            WHERE {' AND '.join(lens)}),
        stats AS (SELECT prompt_key,count(*)::int AS answers,min(round_date) AS first_measured,max(round_date) AS last_measured,
            array_agg(DISTINCT round_date) AS rounds,array_agg(DISTINCT country) FILTER(WHERE country<>'') AS countries
            FROM j GROUP BY 1),
        eng AS (SELECT prompt_key,array_agg(engine) AS engines,array_agg(n) AS engine_answers
            FROM (SELECT prompt_key,engine,count(*)::int AS n FROM j GROUP BY 1,2) x GROUP BY 1),
        vals AS (SELECT v.prompt_key,array_agg(v.field_id::text) AS field_ids,array_agg(v.value) AS field_values
            FROM gold.prompt_custom_value v JOIN gold.dim_prompt q ON q.prompt_key=v.prompt_key
            WHERE q.project_key={b.bind(ctx.project_key, 'smallint')} GROUP BY 1)
        SELECT p.prompt_id,p.text,p.kind,l.code AS lang,t.code AS funnel,p.regions,p.targets,
            coalesce(stats.answers,0) AS answers,stats.first_measured,stats.last_measured,stats.rounds,stats.countries,
            eng.engines,eng.engine_answers,vals.field_ids,vals.field_values
        FROM gold.dim_prompt p LEFT JOIN gold.dim_lang l USING(lang_key) LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
        LEFT JOIN stats USING(prompt_key) LEFT JOIN eng USING(prompt_key) LEFT JOIN vals USING(prompt_key)
        WHERE p.project_key={b.bind(ctx.project_key, 'smallint')} AND p.surface=3 AND p.in_project_catalog
        ORDER BY p.prompt_key""", *b.args)
    fields = await ctx.conn.fetch("""SELECT field_id::text AS field_id,label FROM gold.dim_custom_field
        WHERE project_key=$1 AND NOT archived ORDER BY created_at,field_id""", ctx.project_key)
    items = []
    for r in rows:
        engines = sorted(zip(r["engines"] or [], r["engine_answers"] or []))
        items.append({"prompt_id": r["prompt_id"], "text": r["text"], "kind": r["kind"], "lang": (r["lang"] or "").lower() or None,
                      "funnel": r["funnel"], "regions": r["regions"], "targets": r["targets"] or [], "answers": r["answers"],
                      "first_measured": r["first_measured"], "last_measured": r["last_measured"],
                      "rounds": sorted(r["rounds"] or []), "countries": sorted(r["countries"] or []),
                      "engine_answers": dict(engines),
                      "custom": dict(zip(r["field_ids"] or [], r["field_values"] or []))})
    return envelope(ctx, {"items": items, "fields": [dict(f) for f in fields],
                          "rounds": sorted(ctx.selected_dates if dated else ctx.dates)})
