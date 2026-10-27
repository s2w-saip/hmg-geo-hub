"""Bound, paginated drill-downs into the same published Gold facts."""
from __future__ import annotations

from collections import defaultdict

from fastapi import HTTPException

from bff.gold_reader.citations import category, predicate as citation_predicate
from bff.gold_reader.context import Context, SQL, envelope, flag, limit, ratio, values


async def mention_prompts(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="fact") + " AND f.std_in AND f.competitive"
    if ctx.card:
        where += " AND f.is_rep"
    brand_key = ctx.q.get("brand_key")
    signal = ctx.q.get("signal", "mention")
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
        sum(f.{value_col})::bigint AS value,min(nullif(f.rk,0)) AS position,j.measured_at
        FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key) JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key JOIN gold.dim_country c ON c.geo_key=f.geo_key
        WHERE {where} AND f.prompt_key=ANY({b.bind(keys, 'int[]')})
        GROUP BY f.prompt_key,j.job_id,e.code,c.code,j.measured_at ORDER BY f.prompt_key,j.measured_at DESC NULLS LAST""", *b.args)
    refs = defaultdict(list)
    for r in answer_rows:
        refs[r["prompt_key"]].append({"job_id": str(r["job_id"]), "engine": r["engine"], "region": r["region"],
                                      "value": r["value"], "position": r["position"], "measured_at": r["measured_at"], "runs": None})
    items = [{"prompt_id": str(r["prompt_id"]), "prompt_text": r["text"], "funnel_code": r["funnel"],
              "count": r["count"], "share": ratio(r["count"], total),
              "providers": sorted({a["engine"] for a in refs[r["prompt_key"]]}), "answers": refs[r["prompt_key"]][:50]} for r in rows]
    return envelope(ctx, {"mode": ctx.q.get("mode", "brand"), "target": {"brand_key": int(brand_key) if brand_key else None,
                     "name": ctx.label if not brand_key else await ctx.conn.fetchval("SELECT name FROM gold.dim_brand WHERE brand_key=$1", int(brand_key)),
                     "signal": signal if ctx.q.get("mode") == "signal" else None}, "total": total, "items": items},
                    page={"limit": page_limit, "total": rows[0]["total_rows"] if rows else 0,
                          "next_cursor": str(offset + page_limit) if rows and offset + page_limit < rows[0]["total_rows"] else None})


async def citation_prompts(ctx: Context) -> dict:
    b = SQL()
    where = citation_predicate(ctx, b)
    base_args = b.args.copy()
    owned = f"f.owner_key IN (SELECT owner_key FROM gold.dim_owned_base WHERE (brand_bit & {b.bind(ctx.bits)})<>0)" if ctx.sf == 1 else "f.loc_owned"
    rows = await ctx.conn.fetch(f"""SELECT p.prompt_id,p.text,ft.code AS funnel,f.prompt_key,
        count(*)::int AS citations,count(*) FILTER(WHERE {owned})::int AS own_citations,
        array_agg(DISTINCT e.code ORDER BY e.code) AS providers
        FROM gold.citation_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key LEFT JOIN gold.dim_taxon ft ON ft.taxon_key=p.funnel_key
        WHERE {where} GROUP BY p.prompt_id,p.text,ft.code,f.prompt_key ORDER BY citations DESC,p.prompt_id""", *b.args)
    rows = [dict(r) for r in rows]
    if not values(ctx.q,"source"):
        b2 = SQL()
        measured_where = ctx.predicate(b2,family="fact",measure_family="citations") + " AND f.cit_in" + (" AND f.is_rep" if ctx.card else "")
        measured = await ctx.conn.fetch(f"""SELECT DISTINCT p.prompt_key,p.prompt_id,p.text,t.code AS funnel
            FROM gold.answer_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
            LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key WHERE {measured_where}""",*b2.args)
        existing = {r["prompt_key"] for r in rows}
        rows += [{**dict(r),"citations":0,"own_citations":0,"providers":[]} for r in measured if r["prompt_key"] not in existing]
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


async def tone(ctx: Context) -> dict:
    b = SQL()
    where = citation_predicate(ctx, b)
    positive = "+".join("a." + col for bit, col in ((1, "sent_pos_h"), (2, "sent_pos_k"), (4, "sent_pos_g")) if ctx.bits & bit)
    negative = "+".join("a." + col for bit, col in ((1, "sent_neg_h"), (2, "sent_neg_k"), (4, "sent_neg_g")) if ctx.bits & bit)
    chosen = f"({negative})>({positive})" if ctx.q.get("tone") == "negative" else f"({positive})>({negative})"
    rows = await ctx.conn.fetch(f"""SELECT u.url,u.title,s.skey,s.domain,c.category_key,c.slug,c.name AS category_name,
        count(*)::int AS citations,array_agg(DISTINCT e.code ORDER BY e.code) AS engines,count(*) OVER()::int AS total
        FROM gold.citation_fact f JOIN gold.answer_fact a ON (a.build_id,a.answer_key)=(f.build_id,f.answer_key)
        JOIN gold.dim_url u ON u.url_key=f.url_key JOIN gold.dim_source s ON s.source_key=f.source_key
        LEFT JOIN gold.dim_category c ON c.category_key=s.category_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        WHERE {where} AND {chosen}
        GROUP BY u.url,u.title,s.skey,s.domain,c.category_key,c.slug,c.name ORDER BY citations DESC,u.url
        LIMIT {b.bind(limit(ctx.q))} OFFSET {b.bind(max(0, int(ctx.q.get('cursor') or 0)))}""", *b.args)
    items = [{"key": r["url"], "display": r["url"], "url": r["url"], "title": r["title"], "skey": r["skey"],
              "domain": r["domain"], "citations": r["citations"], "engines": r["engines"], "category": category(dict(r)), "prompt_text": None} for r in rows]
    return envelope(ctx, {"items": items}, page={"limit": limit(ctx.q), "total": rows[0]["total"] if rows else 0, "next_cursor": None})


async def domain(ctx: Context, skey: str) -> dict:
    source = await ctx.conn.fetchrow("""SELECT s.*,c.slug,c.name AS category_name,b.name AS competitor_brand
        FROM gold.dim_source s LEFT JOIN gold.dim_category c USING(category_key)
        LEFT JOIN gold.dim_brand b ON b.brand_key=s.competitor_brand_key WHERE s.skey=$1""", skey)
    if not source:
        raise HTTPException(404, "Source not present in Gold")
    b = SQL()
    where = citation_predicate(ctx, b) + f" AND f.source_key={b.bind(source['source_key'])}"
    rows = await ctx.conn.fetch(f"""SELECT u.url,u.title,count(*)::int AS citations,array_agg(DISTINCT e.code ORDER BY e.code) AS engines
        FROM gold.citation_fact f JOIN gold.dim_url u ON u.url_key=f.url_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        WHERE {where} GROUP BY u.url,u.title ORDER BY citations DESC,u.url""", *b.args)
    own = f"f.owner_key IN (SELECT owner_key FROM gold.dim_owned_base WHERE (brand_bit & {b.bind(ctx.bits)})<>0)" if ctx.sf == 1 else "f.loc_owned"
    totals = await ctx.conn.fetchrow(f"""SELECT count(*)::int AS citations,count(*) FILTER(WHERE {own})::int AS owned
        FROM gold.citation_fact f WHERE {where}""", *b.args)
    # Keep the source predicate's arguments apart from the ownership-only bind above.
    b = SQL()
    where = citation_predicate(ctx, b) + f" AND f.source_key={b.bind(source['source_key'])}"
    owned = f"f.owner_key IN (SELECT owner_key FROM gold.dim_owned_base WHERE (brand_bit & {b.bind(ctx.bits)})<>0)" if ctx.sf == 1 else "f.loc_owned"
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
