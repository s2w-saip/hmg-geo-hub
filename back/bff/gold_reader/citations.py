"""Citation readers use the fact build associated with the pinned release."""
from __future__ import annotations

from bff.gold_reader.context import Context, SQL, envelope, flag, limit, ratio, values
from bff.gold_reader.metrics import TYPES


def predicate(ctx: Context, b: SQL, *, alias: str = "f") -> str:
    where = ctx.predicate(b, alias, family="fact", measure_family="citations") + f" AND {alias}.cit_in"
    if ctx.card:
        where += f" AND {alias}.is_rep"
    if values(ctx.q, "source"):
        where += f" AND {alias}.source_key IN (SELECT s.source_key FROM gold.dim_source s JOIN gold.dim_category d USING(category_key) WHERE d.slug=ANY({b.bind(values(ctx.q, 'source'), 'text[]')}))"
    return where


def category(row: dict) -> dict | None:
    return {"category_key": row["category_key"], "slug": row["slug"], "name": row["category_name"]} if row.get("category_key") is not None else None


async def domains(ctx: Context) -> dict:
    b = SQL()
    where = predicate(ctx, b)
    owned = f"f.owner_key IN (SELECT owner_key FROM gold.dim_owned_base WHERE (brand_bit & {b.bind(ctx.bits)})<>0)" if ctx.sf == 1 else "f.loc_owned"
    # Aggregate the facts per source_key, then join the source dims to the ~26k result rows: the
    # distinct counts sort the fact rows by a 4-byte key instead of the source's text columns
    # (2.9 s -> 1.35 s on the global card). source_key and skey are both unique in dim_source, so
    # the groups are the per-source groups as before.
    rows = await ctx.conn.fetch(f"""WITH a AS (SELECT f.source_key,
        count(*)::int AS citations,count(DISTINCT f.answer_key)::int AS answers,
        count(DISTINCT f.prompt_key)::int AS prompts,
        count(*) FILTER(WHERE {owned})::int AS owned,
        bool_or(f.tgt_hit) AS target
        FROM gold.citation_fact f WHERE {where} GROUP BY f.source_key)
        SELECT s.skey,s.domain,s.is_social,s.owned_brand_bit,s.competitor_brand_key,
        c.category_key,c.slug,c.name AS category_name,br.name AS competitor_brand,
        a.citations,a.answers,a.prompts,a.owned,a.target
        FROM a JOIN gold.dim_source s USING(source_key)
        LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
        LEFT JOIN gold.dim_brand br ON br.brand_key=s.competitor_brand_key
        ORDER BY a.citations DESC,s.skey""", *b.args)
    total = sum(r["citations"] for r in rows)
    b = SQL()
    where = ctx.predicate(b, family="fact", measure_family="citations") + " AND f.cit_in" + (" AND f.is_rep" if ctx.card else "")
    answer_den = await ctx.conn.fetchval(f"SELECT count(DISTINCT f.answer_key)::int FROM gold.answer_fact f WHERE {where}", *b.args)
    items = []
    for rank, row in enumerate(rows, 1):
        r = dict(row)
        items.append({"skey": r["skey"], "domain": r["domain"] or r["skey"], "is_social": r["is_social"],
                      "category": category(r), "citations": r["citations"], "share": ratio(r["citations"], total),
                      "citing_answers": r["answers"], "coverage": ratio(r["answers"], answer_den), "own_citations": r["owned"],
                      "is_own": r["owned"] > 0, "is_target": bool(r["target"]),
                      "competitor_brand": r["competitor_brand"], "citing_prompts": r["prompts"], "rank": rank})
    competitors = {}
    for r in rows:
        if r["competitor_brand"]:
            item = competitors.setdefault(r["competitor_brand"], {"brand": r["competitor_brand"], "citations": 0, "sources": 0})
            item["citations"] += r["citations"]
            item["sources"] += 1
    selected = items
    q = ctx.q.get("q", "").strip().lower()
    if q:
        selected = [r for r in selected if q in r["domain"].lower()]
    if flag(ctx.q, "own_only"):
        selected = [r for r in selected if r["is_own"]]
    page_limit = limit(ctx.q)
    offset = int(ctx.q.get("cursor") or "0")
    page = {"limit": page_limit, "total": len(selected), "next_cursor": str(offset + page_limit) if offset + page_limit < len(selected) else None}
    return envelope(ctx, {"summary": {"total_citations": total, "unique_sources": len(items),
                                       "own_share": ratio(sum(r["own_citations"] for r in items), total), "answers_den": answer_den},
                          "items": selected[offset:offset + page_limit], "competitor_totals": sorted(competitors.values(), key=lambda r: -r["citations"]),
                          "competitor_sources": [r for r in items if r["competitor_brand"]] if flag(ctx.q, "competitor_sources") else None}, page=page)


async def sources(ctx: Context) -> dict:
    b = SQL()
    where = predicate(ctx, b)
    rows = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.engine_key,c.category_key,c.slug,c.name AS category_name,
        count(*)::int AS citations FROM gold.citation_fact f JOIN gold.dim_source s USING(source_key)
        JOIN gold.dim_category c ON c.category_key=s.category_key WHERE {where}
        GROUP BY f.engine_key,c.category_key,c.slug,c.name ORDER BY citations DESC""", *b.args)]
    total = sum(r["citations"] for r in rows)
    groups = {}
    for row in rows:
        key = row["category_key"]
        r = groups.setdefault(key, {"category": category(row), "citations": 0})
        r["citations"] += row["citations"]
    categories = [{**r, "share": ratio(r["citations"], total)} for r in sorted(groups.values(), key=lambda r: -r["citations"])]
    codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
    by_engine = [{"engine": codes[key], "total": sum(r["citations"] for r in rows if r["engine_key"] == key),
                  "categories": [{"category_key": r["category_key"], "citations": r["citations"]} for r in rows if r["engine_key"] == key]}
                 for key in sorted({r["engine_key"] for r in rows})]
    if not flag(ctx.q,"include_tone",True) and not flag(ctx.q,"include_types",True):
        return envelope(ctx, {"total_citations": total, "categories": categories, "by_engine": by_engine,
            "tone": {key:{"urls":0,"citations":0,"answers":0} for key in ("positive","negative")}, "types": []})
    # Tone and type attribution are stored on citation cells, so no text is classified at query time.
    b = SQL()
    where = ctx.predicate(b, population="citations", perspective=True)
    cells = await ctx.conn.fetch(f"""SELECT f.category_key,coalesce(sum(cit_pos),0)::bigint AS positive,
        coalesce(sum(cit_neg),0)::bigint AS negative,
        {','.join(f'coalesce(sum(cit_t_{t}),0)::bigint AS t_{t}' for t in TYPES)}
        FROM gold.citation_cell f WHERE {where} GROUP BY f.category_key""", *b.args)
    # Tile URL/answer distinct counts are derived from facts, not citation occurrence sums.
    b = SQL()
    where = predicate(ctx, b)
    positive = "+".join(f"coalesce(a.sent_pos_{s},0)" for bit,s in ((1,"h"),(2,"k"),(4,"g")) if ctx.bits & bit)
    negative = "+".join(f"coalesce(a.sent_neg_{s},0)" for bit,s in ((1,"h"),(2,"k"),(4,"g")) if ctx.bits & bit)
    tone_rows = await ctx.conn.fetch(f"""SELECT
        CASE WHEN ({positive}) > ({negative}) THEN 'positive' ELSE 'negative' END AS tone,
        count(*)::int AS citations,count(DISTINCT f.url_key)::int AS urls,count(DISTINCT f.answer_key)::int AS answers
        FROM gold.citation_fact f JOIN gold.answer_fact a ON (a.build_id,a.surface,a.round_date,a.answer_key)=(f.build_id,f.surface,f.round_date,f.answer_key)
        WHERE {where} AND ({positive})<>({negative}) GROUP BY tone""", *b.args)
    tone = {key: {"urls": 0, "citations": 0, "answers": 0} for key in ("positive", "negative")}
    for r in tone_rows:
        tone[r["tone"]] = {k: r[k] for k in ("urls", "citations", "answers")}
    return envelope(ctx, {"total_citations": total, "categories": categories, "by_engine": by_engine,
                          "tone": tone, "types": [{"type": t, "total": sum(c[f"t_{t}"] for c in cells),
                            "categories": [{"category_key": c["category_key"], "citations": c[f"t_{t}"]} for c in cells if c[f"t_{t}"]]} for t in TYPES]})


async def targets(ctx: Context) -> dict:
    from bff.gold_reader.metrics import summary
    measured = (await summary(ctx))["data"]
    b = SQL()
    where = predicate(ctx, b)
    rows = await ctx.conn.fetch(f"""SELECT u.url,u.title,u.domain,count(*)::int AS citations,
        count(DISTINCT f.prompt_key)::int AS prompts,count(DISTINCT f.answer_key)::int AS answers
        FROM gold.citation_fact f JOIN gold.dim_url u USING(url_key) WHERE {where} AND f.tgt_hit
        GROUP BY u.url,u.title,u.domain ORDER BY citations DESC,u.url LIMIT {b.bind(limit(ctx.q))}""", *b.args)
    return envelope(ctx, {"measured": (measured.get("target_url_rate") or {}).get("den", 0),
        "target": measured.get("target_url_rate"), "owned": measured.get("owned_url_rate"), "items": [dict(r) for r in rows]})
