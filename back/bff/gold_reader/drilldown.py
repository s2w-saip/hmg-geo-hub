"""Bound, paginated drill-downs into the same published Gold facts."""
from __future__ import annotations

from collections import defaultdict

from fastapi import HTTPException

from bff.gold_reader.citations import category, mention_target, own_citation, predicate as citation_predicate, unknown_brand
from bff.gold_reader.context import Context, SQL, brand_key_of, envelope, flag, limit
from bff.metrics.formulas import rate
from bff.metrics.gold_judged import in_keys, mention_keys


async def mention_prompts(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="fact") + f" AND {ctx.monitoring(b)} AND {ctx.competitive(b)}"
    brand_key = ctx.q.get("brand_key")
    signal = ctx.q.get("signal", "mention")
    mention_brand = (ctx.q.get("mention_brand") or "").strip()
    if not brand_key and mention_brand and ctx.q.get("mode", "brand") == "brand":
        # the contract's display-name target (2026-10-31 renewal audit 7-2: ignored, so own defaulted to true and every
        # brand row listed 당사's prompts); a name Gold does not know is the original API's 404 brand_not_found
        key = await brand_key_of(ctx.conn, mention_brand)
        if key is None:
            raise HTTPException(404, "brand_not_found")
        brand_key = str(key)
    columns = {"positive": "s_pos", "negative": "s_neg", "neutral": "s_neu", "mixed": "s_mix",
               "mention": "t_mention", "recommendation": "t_recommendation", "comparison": "t_comparison",
               "definition": "t_definition", "final_choice": "t_final_choice"}
    value_col = columns.get(signal, "mention_count") if ctx.q.get("mode") == "signal" else "mention_count"
    if brand_key:
        where += f" AND f.brand_key={b.bind(int(brand_key))}"
    elif ctx.q.get("own", "true") == "true":
        where += f" AND (br.own_bit & {b.bind(ctx.bits)})<>0"
    where += f" AND f.{value_col}>0"
    total = await ctx.conn.fetchval(f"SELECT coalesce(sum(f.{value_col}),0)::bigint FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key) WHERE {where}", *b.args)
    page_limit, offset = limit(ctx.q), max(0, int(ctx.q.get("cursor") or 0))
    base_args = b.args.copy()
    rows = await ctx.conn.fetch(f"""SELECT p.prompt_key,p.prompt_id,p.text,ft.code AS funnel,
        sum(f.{value_col})::bigint AS count,count(*) OVER()::int AS total_rows
        FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key)
        JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key LEFT JOIN gold.dim_taxon ft ON ft.taxon_key=p.funnel_key
        WHERE {where} GROUP BY p.prompt_key,p.prompt_id,p.text,ft.code
        ORDER BY count DESC,p.prompt_id LIMIT {b.bind(page_limit)} OFFSET {b.bind(offset)}""", *b.args)
    keys = [r["prompt_key"] for r in rows]
    b.args = base_args
    answer_rows = await ctx.conn.fetch(f"""SELECT f.prompt_key,j.job_id,e.code AS engine,c.code AS region,
        sum(f.{value_col})::bigint AS value,min(nullif(f.first_pos,0)) AS position,j.measured_at
        FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key) JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key JOIN gold.dim_country c ON c.geo_key=f.geo_key
        WHERE {where} AND f.prompt_key=ANY({b.bind(keys, 'int[]')})
        GROUP BY f.prompt_key,j.job_id,e.code,c.code,j.measured_at ORDER BY f.prompt_key,j.measured_at DESC NULLS LAST""", *b.args)
    refs = defaultdict(list)
    for r in answer_rows:
        refs[r["prompt_key"]].append({"job_id": str(r["job_id"]), "engine": r["engine"], "region": r["region"],
                                      "value": r["value"], "position": r["position"], "measured_at": r["measured_at"], "runs": None})
    items = [{"prompt_id": str(r["prompt_id"]), "prompt_text": r["text"], "funnel_code": r["funnel"],
              "count": r["count"], "share": rate(r["count"], total),
              "providers": sorted({a["engine"] for a in refs[r["prompt_key"]]}), "answers": refs[r["prompt_key"]][:50]} for r in rows]
    return envelope(ctx, {"mode": ctx.q.get("mode", "brand"), "target": {"brand_key": int(brand_key) if brand_key else None,
                     "name": ctx.label if not brand_key else await ctx.conn.fetchval("SELECT name FROM gold.dim_brand WHERE brand_key=$1", int(brand_key)),
                     "signal": signal if ctx.q.get("mode") == "signal" else None}, "total": total, "items": items},
                    page={"limit": page_limit, "total": rows[0]["total_rows"] if rows else 0,
                          "next_cursor": str(offset + page_limit) if rows and offset + page_limit < rows[0]["total_rows"] else None})


async def market_gaps(ctx: Context) -> dict:
    """Per country, what the renewal Website Mention's market table shows beside the rates (2026-11-02): the 미언급
    prompts (as missing_prompts, those whose answers hold other brands apart) and the answers that name no brand at all
    (no competitive mention). The last holds answers the AI named no brand in and answers Gold's analysis came back
    empty for, which Gold does not tell apart (upstream D8). None without a snapshot or period, as the counts."""
    if not ctx.selected_dates:
        return envelope(ctx, {"items": []}, suppressed={"*": "no_snapshot"})
    b = SQL()
    answer_where = ctx.predicate(b, alias="a", family="fact") + f" AND {ctx.monitoring(b, 'a')}"
    keys = await mention_keys(ctx)
    rows = await ctx.conn.fetch(f"""WITH ans AS MATERIALIZED (SELECT a.geo_key,a.prompt_key,{in_keys(b, 'a', keys.mentioned)} AS named,
            {in_keys(b, 'a', keys.tracked)} AS own FROM gold.answer_fact a WHERE {answer_where}),
        said AS (SELECT geo_key,prompt_key,bool_or(named) AS named,bool_or(own) AS own FROM ans GROUP BY geo_key,prompt_key),
        empty AS (SELECT geo_key,count(*)::int AS n FROM ans WHERE NOT named GROUP BY geo_key)
        SELECT c.code,count(s.prompt_key) FILTER(WHERE NOT s.own)::int AS missing,count(s.prompt_key) FILTER(WHERE NOT s.own AND s.named)::int AS with_brands,
            coalesce(e.n,0)::int AS answers_no_brand
        FROM said s JOIN gold.dim_country c USING(geo_key) LEFT JOIN empty e USING(geo_key)
        GROUP BY c.code,e.n""", *b.args)
    return envelope(ctx, {"items": [{"country": r["code"], "missing": r["missing"], "with_brands": r["with_brands"],
                                     "answers_no_brand": r["answers_no_brand"]} for r in rows]})


async def missing_prompts(ctx: Context) -> dict:
    """The measured prompts where 당사 is in no answer: the members of the summary's params.prompts_without_brand
    (measured − mentioned prompts of the same kpi_cell rows, population and perspective), 2026-10-30 for the renewal
    Website Mention's 미언급 프롬프트 list. Each carries its target page, its answers in the window, the brand mentions
    those answers hold (the brands the AI named instead) and its latest answer
    references; the prompts with the most brand mentions first. None without a snapshot or period, as the count.
    ?partial: the prompts 당사 is in on one engine and not on another instead (2026-11-02: the count leaves them out,
    though the page is missing there too), with the engines that left it out."""
    page_limit, offset = limit(ctx.q), max(0, int(ctx.q.get("cursor") or 0))
    if not ctx.selected_dates:
        return envelope(ctx, {"items": []}, suppressed={"*": "no_snapshot"}, page={"limit": page_limit, "total": 0, "next_cursor": None})
    b = SQL()
    answers = await mention_keys(ctx)
    own = in_keys(b, "f", answers.tracked)
    cell_where = ctx.predicate(b, family="fact") + f" AND {ctx.monitoring(b)}"
    answer_where = ctx.predicate(b, alias="a", family="fact") + f" AND {ctx.monitoring(b, 'a')}"
    named_where = ctx.predicate(b, alias="x", family="fact") + f" AND {ctx.monitoring(b, 'x')} AND {ctx.competitive(b, 'x')}"
    cells = f"""FROM gold.answer_fact f JOIN gold.dim_engine e USING(engine_key) WHERE {cell_where} GROUP BY f.prompt_key"""
    left_out = f"""HAVING bool_or({own})
        AND count(DISTINCT f.engine_key)>count(DISTINCT f.engine_key) FILTER(WHERE {own})"""
    having = left_out if flag(ctx.q, "partial") else f"HAVING NOT bool_or({own})"
    rows = await ctx.conn.fetch(f"""WITH miss AS (SELECT f.prompt_key,
            array_agg(DISTINCT e.code) AS measured_engines,
            array_agg(DISTINCT e.code) FILTER(WHERE {own}) AS mentioned_engines {cells} {having}),
        sums AS (SELECT a.prompt_key,count(*)::int AS answers
            FROM gold.answer_fact a WHERE {answer_where} AND a.prompt_key IN (SELECT prompt_key FROM miss) GROUP BY a.prompt_key),
        named AS (SELECT x.prompt_key,sum(x.mention_count)::bigint AS brand_mentions
            FROM gold.answer_brand_fact x WHERE {named_where} AND x.prompt_key IN (SELECT prompt_key FROM miss) GROUP BY x.prompt_key)
        SELECT p.prompt_key,p.prompt_id,p.text,p.targets[1] AS target,miss.measured_engines,miss.mentioned_engines,
            ft.code AS funnel,coalesce(s.answers,0) AS answers,
            coalesce(n.brand_mentions,0) AS brand_mentions,count(*) OVER()::int AS total_rows,
            count(*) FILTER(WHERE coalesce(n.brand_mentions,0)>0) OVER()::int AS with_brand_rows
        FROM miss JOIN gold.dim_prompt p USING(prompt_key) LEFT JOIN sums s USING(prompt_key) LEFT JOIN named n USING(prompt_key)
        LEFT JOIN gold.dim_taxon ft ON ft.taxon_key=p.funnel_key
        ORDER BY brand_mentions DESC,p.text,p.prompt_id LIMIT {b.bind(page_limit)} OFFSET {b.bind(offset)}""", *b.args)
    keys = [r["prompt_key"] for r in rows]
    answers_limit = min(50, max(1, int(ctx.q.get("answers_limit") or 6)))
    a = SQL()
    where = ctx.predicate(a, family="fact") + f" AND {ctx.monitoring(a)}"
    answer_rows = await ctx.conn.fetch(f"""SELECT f.prompt_key,j.job_id,e.code AS engine,c.code AS region,j.measured_at
        FROM gold.answer_fact f JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key JOIN gold.dim_country c ON c.geo_key=f.geo_key
        WHERE {where} AND f.prompt_key=ANY({a.bind(keys, 'int[]')})
        ORDER BY f.prompt_key,j.measured_at DESC NULLS LAST,j.job_id""", *a.args)
    refs = defaultdict(list)
    for r in answer_rows:
        refs[r["prompt_key"]].append({"job_id": str(r["job_id"]), "engine": r["engine"], "region": r["region"],
                                      "measured_at": r["measured_at"]})
    items = [{"prompt_id": str(r["prompt_id"]), "prompt_text": r["text"], "funnel_code": r["funnel"],
              "target_url": r["target"], "answers_total": r["answers"], "brand_mentions": r["brand_mentions"],
              "missing_engines": sorted(set(r["measured_engines"] or ()) - set(r["mentioned_engines"] or ())),
              "providers": sorted({x["engine"] for x in refs[r["prompt_key"]]}),
              "answers": refs[r["prompt_key"]][:answers_limit]} for r in rows]
    total = rows[0]["total_rows"] if rows else 0
    # the segments over every member, not the loaded page (a list cut at its limit drops the no-brand prompts first)
    with_brands = rows[0]["with_brand_rows"] if rows else 0
    c = SQL()
    own = in_keys(c, "f", answers.tracked)
    partial = await ctx.conn.fetch(f"""SELECT count(*)::int AS n FROM (SELECT 1
        FROM gold.answer_fact f WHERE {ctx.predicate(c, family="fact")} AND {ctx.monitoring(c)} GROUP BY f.prompt_key
        HAVING bool_or({own}) AND count(DISTINCT f.engine_key)>count(DISTINCT f.engine_key) FILTER(WHERE {own})) x""", *c.args)
    return envelope(ctx, {"items": items, "counts": {"with_brands": with_brands, "no_brands": total - with_brands, "partial": partial[0]["n"]}},
                    page={"limit": page_limit, "total": total,
                          "next_cursor": str(offset + page_limit) if offset + page_limit < total else None})

async def citation_prompts(ctx: Context) -> dict:
    b = SQL()
    where = citation_predicate(ctx, b)
    base_args = b.args.copy()
    owned = await own_citation(ctx, b)
    # Count per (prompt_key, engine), then per prompt_key, then join the names to the counted rows: grouping every
    # citation by its prompt's text and the engines' DISTINCT sorted 2.2 M rows (4.6 -> 1.6 s over 09-21..10-05).
    # prompt_key is dim_prompt's key and decides prompt_id, text and funnel, every cited prompt_key is in
    # dim_prompt (checked on every active fact build, 2026-10-30) and an engine has one code, so the groups,
    # their counts, engines and order are the same.
    rows = await ctx.conn.fetch(f"""WITH pe AS (SELECT f.prompt_key,f.engine_key,
          count(*)::int AS citations,count(*) FILTER(WHERE {owned})::int AS own_citations
          FROM gold.citation_fact f WHERE {where} GROUP BY f.prompt_key,f.engine_key),
        g AS (SELECT pe.prompt_key,sum(pe.citations)::int AS citations,sum(pe.own_citations)::int AS own_citations,
          array_agg(e.code ORDER BY e.code) AS providers
          FROM pe JOIN gold.dim_engine e ON e.engine_key=pe.engine_key GROUP BY pe.prompt_key)
        SELECT p.prompt_id,p.text,ft.code AS funnel,g.prompt_key,g.citations,g.own_citations,g.providers
        FROM g JOIN gold.dim_prompt p ON p.prompt_key=g.prompt_key LEFT JOIN gold.dim_taxon ft ON ft.taxon_key=p.funnel_key
        ORDER BY g.citations DESC,p.prompt_id""", *b.args)
    # Only cited prompts: 자사 미인용 = a citation (hosted) and no 자사 one (gold.citation_cell); a measured prompt
    # without any citation is in neither bucket.
    rows = [dict(r) for r in rows]
    if ctx.q.get("q"):
        rows = [r for r in rows if ctx.q["q"].lower() in r["text"].lower()]
    bucket = ctx.q.get("bucket", "owned" if flag(ctx.q,"owned",True) else "uncited")
    selected = [r for r in rows if (r["own_citations"] > 0) == (bucket == "owned")]
    page_limit, offset = limit(ctx.q), max(0, int(ctx.q.get("cursor") or 0))
    chosen = selected[offset:offset + page_limit]
    refs = defaultdict(list)
    if flag(ctx.q, "include_refs", True) and chosen:
        b.args = base_args
        rs = await ctx.conn.fetch(f"""SELECT f.prompt_key,j.job_id,e.code AS provider,c.code AS region,count(*)::int AS citations_in_answer
            FROM gold.citation_fact f JOIN gold.job_index j USING(answer_key)
            JOIN gold.dim_engine e ON e.engine_key=f.engine_key JOIN gold.dim_country c ON c.geo_key=f.geo_key
            WHERE {where} AND f.prompt_key=ANY({b.bind([r['prompt_key'] for r in chosen], 'int[]')})
            GROUP BY f.prompt_key,j.job_id,e.code,c.code ORDER BY f.prompt_key,j.job_id""", *b.args)
        for r in rs:
            refs[r["prompt_key"]].append({"job_id": str(r["job_id"]), "provider": r["provider"], "region": r["region"], "citations_in_answer": r["citations_in_answer"]})
    def item(r):
        return {"prompt_id": str(r["prompt_id"]), "text": r["text"], "funnel": r["funnel"], "citations": r["citations"],
                "providers": r["providers"], "answers": refs[r["prompt_key"]][:50]}
    data = {"items": [item(r) for r in chosen], "counts": {"owned": sum(r["own_citations"] > 0 for r in rows), "uncited": sum(r["own_citations"] == 0 for r in rows)}}
    if flag(ctx.q, "both_buckets"):
        data["other_bucket"] = [item(r) for r in rows if (r["own_citations"] > 0) != (bucket == "owned")][:page_limit]
    return envelope(ctx, data, page={"limit": page_limit, "total": len(selected), "next_cursor": str(offset + page_limit) if offset + page_limit < len(selected) else None})


DISPLAY_URL = "regexp_replace(regexp_replace(u.url,'^[A-Za-z][A-Za-z0-9+.-]*://',''),'#.*$','')"


def like(q: str) -> str:
    """q as a literal ILIKE pattern (wildcards taken as written)."""
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def tone(ctx: Context) -> dict:
    """URLs (or sources, group_by=source) cited by answers of one tone, paged, searchable, with the two tabs'
    counts (with_counts) — the contract's /v1/citations/sources/tone (2026-10-29 metric review R4: the reader
    returned the first page of URLs only: no counts, no next page, no search, no grouping by source). One pass
    groups the citations per URL (or source) with both tones' counts; the names join the grouped rows only."""
    b = SQL()
    where = citation_predicate(ctx, b)
    keys = await mention_keys(ctx, measure_family="citations")
    is_pos, is_neg = in_keys(b, "f", keys.leans_positive), in_keys(b, "f", keys.leans_negative)
    chosen = "neg" if ctx.q.get("tone") == "negative" else "pos"
    by_source = ctx.q.get("group_by") == "source"
    # A page is Gold's url_norm: its utm and #:~:text= variants are one row, shown by the shortest spelling.
    key = "f.source_key" if by_source else "coalesce(u.url_norm,u.url)"
    q = (ctx.q.get("q") or "").strip()
    search = f" AND {'s.skey' if by_source else DISPLAY_URL.replace('u.url', 't.url')} ILIKE {b.bind(like(q))}" if q else ""
    with_counts = flag(ctx.q, "with_counts") and not by_source
    page_limit, offset = limit(ctx.q), max(0, int(ctx.q.get("cursor") or 0))
    names = ("s.skey,s.domain" if by_source else "t.url,t.title,s.skey,s.domain") + ",c.category_key,c.slug,c.name AS category_name"
    # A URL page without a search names only the URLs that can be on it: those cited at least as often as the
    # page's last row (ties are ordered by URL, so all of them). Every grouped URL has its dim_url / dim_source
    # rows, so the total is the grouped URLs of the tone. Joining every URL to sort it took 1.4 of A's 2.6 s.
    top = not by_source and not q and page_limit > 0
    total = f"(SELECT count(*) FROM t WHERE {chosen}>0)::int" if top else "count(*) OVER()::int"
    cut = (f" AND t.{chosen}>=coalesce((SELECT {chosen} FROM t WHERE {chosen}>0 ORDER BY {chosen} DESC "
           f"OFFSET {b.bind(offset + page_limit - 1)} LIMIT 1),0)") if top else ""
    spelling = "" if by_source else ",(array_agg(u.url ORDER BY length(u.url),u.url))[1] AS url,min(u.title) AS title"
    url_join = "" if by_source else "JOIN gold.dim_url u ON u.url_key=f.url_key"
    rows = await ctx.conn.fetch(f"""WITH t AS (SELECT {key} AS k,min(f.source_key) AS source_key{spelling},
            count(*) FILTER(WHERE {is_pos})::int AS pos,count(*) FILTER(WHERE {is_neg})::int AS neg,
            array_agg(DISTINCT f.engine_key) FILTER(WHERE {is_pos if chosen == 'pos' else is_neg}) AS engine_keys
          FROM gold.citation_fact f
          {url_join}
          WHERE {where} AND ({is_pos} OR {is_neg}) GROUP BY {key})
        SELECT {names},t.{chosen} AS citations,t.engine_keys,{total} AS total
          {",(SELECT count(*) FROM t WHERE pos>0)::int AS n_pos,(SELECT count(*) FROM t WHERE neg>0)::int AS n_neg" if with_counts else ""}
        FROM t JOIN gold.dim_source s ON s.source_key=t.source_key
          LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
        WHERE t.{chosen}>0{search}{cut}
        ORDER BY t.{chosen} DESC,{'s.skey' if by_source else 't.url'}
        LIMIT {b.bind(page_limit)} OFFSET {b.bind(offset)}""", *b.args)
    counts = None
    if flag(ctx.q, "with_counts"):
        if with_counts and rows:
            counts = {"positive": rows[0]["n_pos"], "negative": rows[0]["n_neg"]}
        else:
            # source mode, or a page past the end: the distinct URLs of each tone, read on their own
            b2 = SQL()
            where2 = citation_predicate(ctx, b2)
            is_pos2, is_neg2 = in_keys(b2, "f", keys.leans_positive), in_keys(b2, "f", keys.leans_negative)
            row = await ctx.conn.fetchrow(f"""SELECT count(DISTINCT coalesce(u.url_norm,u.url)) FILTER(WHERE {is_pos2})::int AS positive,
                count(DISTINCT coalesce(u.url_norm,u.url)) FILTER(WHERE {is_neg2})::int AS negative
                FROM gold.citation_fact f
                JOIN gold.dim_url u ON u.url_key=f.url_key
                WHERE {where2}""", *b2.args)
            counts = {"positive": row["positive"], "negative": row["negative"]}
    codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT engine_key,code FROM gold.dim_engine")} if rows else {}
    items = []
    for r in rows:
        engines = sorted(codes[k] for k in (r["engine_keys"] or []))
        items.append({"key": r["skey"] if by_source else r["url"], "display": r["skey"] if by_source else r["url"],
                      "url": None if by_source else r["url"], "title": None if by_source else r["title"], "skey": r["skey"],
                      "domain": r["domain"], "citations": r["citations"], "engines": engines, "category": category(dict(r)),
                      "prompt_text": None})
    total = rows[0]["total"] if rows else 0
    return envelope(ctx, {"items": items, "counts": counts},
                    page={"limit": page_limit, "total": total,
                          "next_cursor": str(offset + page_limit) if offset + page_limit < total else None})


async def domain(ctx: Context, skey: str) -> dict:
    source = await ctx.conn.fetchrow("""SELECT s.*,c.slug,c.name AS category_name,b.name AS competitor_brand
        FROM gold.dim_source s LEFT JOIN gold.dim_category c USING(category_key)
        LEFT JOIN gold.dim_brand b ON b.brand_key=s.competitor_brand_key WHERE s.skey=$1""", skey)
    if not source:
        raise HTTPException(404, "Source not present in Gold")
    if not await mention_target(ctx):  # the brand row's source detail (citations.mention_target)
        return unknown_brand(ctx, envelope(ctx, {"source": {"skey": skey, "domain": source["domain"], "is_social": source["is_social"],
                                                            "category": category(dict(source)), "competitor_brand": source["competitor_brand"]},
                                                 "citations": 0, "own_citations": 0, "urls": [], "prompts": [], "url_total": 0, "prompt_total": 0}))
    b = SQL()
    where = citation_predicate(ctx, b) + f" AND f.source_key={b.bind(source['source_key'])}"
    # country: the URL's owned base (dim_url.owner_key) country, null for a URL that is no own base
    rows = await ctx.conn.fetch(f"""SELECT (array_agg(u.url ORDER BY length(u.url),u.url))[1] AS url,min(u.title) AS title,count(*)::int AS citations,array_agg(DISTINCT e.code ORDER BY e.code) AS engines,
        nullif(o.geo_code,'') AS country
        FROM gold.citation_fact f JOIN gold.dim_url u ON u.url_key=f.url_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        LEFT JOIN gold.dim_owned_base o ON o.owner_key=u.owner_key
        WHERE {where} GROUP BY coalesce(u.url_norm,u.url),o.geo_code ORDER BY citations DESC,url""", *b.args)
    own = await own_citation(ctx, b)
    totals = await ctx.conn.fetchrow(f"""SELECT count(*)::int AS citations,count(*) FILTER(WHERE {own})::int AS owned
        FROM gold.citation_fact f WHERE {where}""", *b.args)
    # Keep the source predicate's arguments apart from the ownership-only bind above.
    b = SQL()
    where = citation_predicate(ctx, b) + f" AND f.source_key={b.bind(source['source_key'])}"
    owned = await own_citation(ctx, b)
    prompts = await ctx.conn.fetch(f"""SELECT p.prompt_id::text AS prompt_id,p.text,t.code AS funnel,count(*)::int AS citations,
        count(*) FILTER(WHERE {owned})::int AS own_citations,
        array_agg(DISTINCT e.code ORDER BY e.code) AS engines
        FROM gold.citation_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
        LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key WHERE {where}
        GROUP BY p.prompt_id,p.text,t.code ORDER BY citations DESC,p.prompt_id""", *b.args)
    b = SQL()
    where = citation_predicate(ctx,b) + f" AND f.source_key={b.bind(source['source_key'])}"
    selected_prompts = prompts[:limit(ctx.q,12)]
    refs = await ctx.conn.fetch(f"""SELECT p.prompt_id::text AS prompt_id,j.job_id::text AS job_id,e.code AS engine,c.code AS country,count(*)::int AS citations
        FROM gold.citation_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
        JOIN gold.job_index j ON j.answer_key=f.answer_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        LEFT JOIN gold.dim_country c ON c.geo_key=f.geo_key
        WHERE {where} AND p.prompt_id::text=ANY({b.bind([r['prompt_id'] for r in selected_prompts],'text[]')})
        GROUP BY p.prompt_id,j.job_id,e.code,c.code ORDER BY citations DESC,j.job_id""",*b.args)
    return envelope(ctx, {"source": {"skey": skey, "domain": source["domain"], "is_social": source["is_social"],
                    "category": category(dict(source)), "competitor_brand": source["competitor_brand"]},
                    "citations": totals["citations"], "own_citations": totals["owned"],
                    "urls": [dict(r) for r in rows[:limit(ctx.q, 100)]],
                    "prompts": [{**dict(r),"answers":[{k:a[k] for k in ('job_id','engine','country','citations')} for a in refs if a['prompt_id']==r['prompt_id']][:8]} for r in selected_prompts],
                    "url_total": len(rows), "prompt_total": len(prompts)})
