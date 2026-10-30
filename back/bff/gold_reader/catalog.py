"""Read-only prompt catalogs; identities and taxonomy are taken from Gold."""
from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from bff.gold_reader.context import AXES, BRAND_NAMES, Context, SQL, envelope, limit, values

# Website list order (the screen's sort keys, website_prompts.py SORT_API): empty values last, ties by prompt id.
# Text sorts by the Unicode root collation: Gold's default (glibc en_US.utf8) leaves Hangul unordered.
ICU = 'COLLATE "und-x-icu"'
WEBSITE_SORT = {"prompt": f"p.text {ICU}", "country": f"c.code {ICU}", "lang": f"lower(l.code) {ICU}",
                "target_url": f"p.targets[1] {ICU}", "answers": "coalesce(stats.answers,0)", "last_measured": "stats.last_measured",
                "first_measured": "stats.first_measured", "rounds": "coalesce(cardinality(stats.rounds),0)",
                "brand": f"CASE dp.site_brand_bit {' '.join(f'WHEN {bit} THEN {name!r}' for bit, name in BRAND_NAMES.items())} END {ICU}"}



def target_host(target: str) -> str:
    """The host of a website target. Gold's targets carry no scheme ("kia.com/de/…") and may hold "//" in the path
    ("kia.ro//informatii-legale/…"), so only a real scheme is read as one; otherwise the target is a network location."""
    return urlsplit(target if re.match(r"^[a-z][a-z0-9+.-]*://", target, re.I) else "//" + target).netloc

def like_pattern(text: str) -> str:
    """`%text%` with LIKE's own characters taken literally."""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def prompts(ctx: Context) -> dict:
    b = SQL()
    if ctx.sf == 1:
        joins = " ".join(f"LEFT JOIN gold.dim_taxon {a} ON {a}.taxon_key=ce.{c}" for a, c in AXES.items())
        where = [f"ce.build_id=ANY({b.bind(ctx.builds.get('fact', []), 'bigint[]')})", f"(ce.brand_bit & {b.bind(ctx.bits | 8)})<>0"]
        for axis in AXES:
            if values(ctx.q, axis):
                where.append(f"{axis}.code=ANY({b.bind(values(ctx.q, axis), 'text[]')})")
        if ctx.q.get("q"):
            where.append(f"p.text ILIKE {b.bind('%' + ctx.q['q'] + '%')}")
        rows = await ctx.conn.fetch(f"""WITH measured AS (
            SELECT DISTINCT prompt_key FROM gold.answer_fact WHERE build_id=ANY($1::bigint[]) AND std_in)
            SELECT DISTINCT ON(ce.catalog_row_id) ce.catalog_row_id,ce.brand_bit,ce.kind,
            p.prompt_id,p.text,l.code AS lang,p.regions,{','.join(f'{a}.code AS {a}' for a in AXES)},
            (m.prompt_key IS NOT NULL) AS measured
            FROM gold.catalog_entry ce JOIN gold.dim_prompt p USING(prompt_key)
            LEFT JOIN measured m ON m.prompt_key=p.prompt_key
            LEFT JOIN gold.dim_lang l USING(lang_key) {joins}
            WHERE {' AND '.join(where)} ORDER BY ce.catalog_row_id,ce.build_id DESC""", *b.args)
        items = [{"prompt_id": r["catalog_row_id"], "scope_prompt_id": r["prompt_id"], "text": r["text"], "kind": r["kind"],
                  "measured": r["measured"], "brand_code": {**BRAND_NAMES, 8: "HMG"}.get(r["brand_bit"]),
                  "brand_presence": r["brand_presence"], "brand_presence_effective": r["brand_presence"],
                  "prompt_type": r["kind"], "category": r["depth1"], "list_type": r["list_type"],
                  "depth1": r["depth1"], "depth2": r["depth2"], "depth3": r["depth3"], "depth4": r["depth4"],
                  "funnel_stage": r["funnel"], "lang": r["lang"].lower() if r["lang"] else None, "regions": r["regions"]} for r in rows]
    elif ctx.sf == 2:
        parts = ["p.surface=2", "p.web_reg"]
        if values(ctx.q, "brand"):
            parts.append(f"(dp.site_brand_bit & {b.bind(ctx.bits)})<>0")
        if values(ctx.q, "country"):
            parts.append(f"c.code=ANY({b.bind(values(ctx.q, 'country'), 'text[]')})")
        if values(ctx.q, "lang"):
            parts.append(f"lower(l.code)=ANY({b.bind([v.lower() for v in values(ctx.q, 'lang')], 'text[]')})")
        # the Website Prompts screen sends `search` (its former API's name); /v1/prompts callers `q`
        search = (ctx.q.get("search") or ctx.q.get("q") or "").strip()
        if search:
            pattern = b.bind(like_pattern(search))
            parts.append(f"(p.text ILIKE {pattern} OR coalesce(p.targets[1],'') ILIKE {pattern})")
        # Engine and period are a lens: they choose the answers a row counts and never drop a row. Only the
        # rounds Gold serves count (the cycle's servable · hidden_scope · view_date, as the analysis screens).
        dated = ctx.q.get("from") or ctx.q.get("to")
        lens = [f"j.round_date=ANY({b.bind(ctx.selected_dates if dated else ctx.dates, 'date[]')})", "cy.servable",
                "coalesce(cy.hidden_scope,0)<>1",
                f"(cy.view_date IS NULL OR cy.view_date<={b.bind(datetime.now(ZoneInfo('Asia/Seoul')).date(), 'date')})"]
        if values(ctx.q, "engine"):
            lens.append(f"lower(e.code)=ANY({b.bind([v.lower() for v in values(ctx.q, 'engine')], 'text[]')})")
        sort = WEBSITE_SORT.get(ctx.q.get("sort") or "")
        order = f"{sort} {'ASC' if ctx.q.get('dir') == 'asc' else 'DESC'} NULLS LAST,p.prompt_id" if sort else "p.prompt_id"
        # Per prompt: its answers by engine and the rounds it was measured in (served jobs in the lens).
        # MATERIALIZED: once, not under a nested loop (country + language picked: 8.5 s, with the lens > 15 s)
        listed = f"""FROM gold.dim_prompt p JOIN gold.dim_project dp USING(project_key)
            LEFT JOIN gold.dim_country c ON c.geo_key=dp.site_geo_key LEFT JOIN gold.dim_lang l USING(lang_key)
            WHERE {' AND '.join(parts)}"""
        served = f"""FROM gold.job_index j JOIN gold.dim_engine e ON e.engine_key=j.engine_key JOIN gold.dim_cycle cy ON cy.cyc_key=j.cyc_key
            WHERE j.surface=2 AND j.served AND {' AND '.join(lens)} AND j.prompt_key IN (SELECT p.prompt_key {listed})"""
        rows = await ctx.conn.fetch(f"""WITH r AS MATERIALIZED (
            SELECT prompt_key,sum(n)::int AS answers,max(round_date) AS last_measured,min(round_date) AS first_measured,
                array_agg(round_date) AS rounds
            FROM (SELECT j.prompt_key,j.round_date,count(*) AS n {served} GROUP BY 1,2) d GROUP BY 1),
            x AS MATERIALIZED (
            SELECT prompt_key,array_agg(code) AS engines,array_agg(n) AS engine_answers
            FROM (SELECT j.prompt_key,e.code,count(*)::int AS n {served} GROUP BY 1,2) d GROUP BY 1),
            stats AS (SELECT * FROM r JOIN x USING(prompt_key))
            SELECT p.*,c.code AS country,l.code AS lang,dp.site_brand_bit,
            coalesce(stats.answers,0) AS answers,stats.last_measured,stats.first_measured,stats.rounds,stats.engines,stats.engine_answers
            {listed.replace("WHERE", "LEFT JOIN stats ON stats.prompt_key=p.prompt_key WHERE", 1)} ORDER BY {order}""", *b.args)
        items = []
        for r in rows:
            target = r["targets"][0] if r["targets"] else ""
            # gathered unordered (an ordered aggregate sorted 225k rows: +0.3 s on the whole list)
            engines = sorted(zip(r["engines"] or [], r["engine_answers"] or []))
            items.append({"website_prompt_id": r["prompt_id"], "scope_prompt_id": r["prompt_id"], "prompt_text": r["text"],
                          "brand_code": BRAND_NAMES.get(r["site_brand_bit"], ""), "country_code": r["country"] or "",
                          "lang_code": (r["lang"] or "").lower(), "target_url": target,
                          "domain": target_host(target),
                          "owned_base_url": None, "measured": bool(r["answers"]), "answers": r["answers"],
                          "last_measured": r["last_measured"], "engines": [code for code, _ in engines],
                          "first_measured": r["first_measured"], "rounds": sorted(r["rounds"] or []),
                          "engine_answers": dict(engines)})
    else:
        rows = await ctx.conn.fetch("SELECT * FROM gold.dim_prompt WHERE project_key=$1 ORDER BY prompt_id", ctx.project_key)
        items = [dict(r) for r in rows]
    # The catalog is read whole either way; the cap admits the full global catalog (12,164 rows) in one page
    # for the Global prompts screen, which filters, counts and sorts it in one pass.
    page_limit = limit(ctx.q, 100, 20000)
    offset = max(0, int(ctx.q.get("cursor") or "0"))
    return envelope(ctx, {"items": items[offset:offset + page_limit]}, mode="catalog",
                    page={"limit": page_limit, "total": len(items), "next_cursor": str(offset + page_limit) if offset + page_limit < len(items) else None})


async def unmeasured(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="fact")
    rows = await ctx.conn.fetch(f"""SELECT p.prompt_id,p.text FROM gold.dim_prompt p
        WHERE p.surface={b.bind(ctx.sf)} AND p.in_root_catalog
        AND NOT EXISTS(SELECT 1 FROM gold.answer_fact f WHERE {where} AND f.prompt_key=p.prompt_key)
        ORDER BY p.prompt_id LIMIT 200""", *b.args)
    return envelope(ctx, {"items": [dict(r) for r in rows]}, page={"limit": 200, "next_cursor": None})
