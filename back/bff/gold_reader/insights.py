"""Read the supplied keyword and social observations without inventing app registrations."""
from fastapi import HTTPException

from bff.gold_reader.context import SQL, envelope, limit


def offset(q):
    try:
        return max(0, int(q.get("cursor") or 0))
    except ValueError:
        raise HTTPException(422, "Invalid cursor") from None


async def keywords(ctx):
    tab = ctx.q.get("tab", "volume")
    if tab not in {"volume", "serp", "suggestions"}:
        raise HTTPException(422, "Unknown keyword tab")
    b = SQL()
    parts = ["true"]
    if ctx.q.get("q"):
        parts.append(f"k.term ILIKE {b.bind('%' + ctx.q['q'] + '%')}")
    for param, col in (("location", "location_code"), ("language", "language_code")):
        if ctx.q.get(param):
            value = ctx.q[param]
            if param == "location":
                try:
                    value = int(value)
                except ValueError:
                    raise HTTPException(422, "Invalid location") from None
            parts.append(f"v.{col}={b.bind(value)}")
    where = " AND ".join(parts)
    size, skip = limit(ctx.q, 50, 200), offset(ctx.q)
    if tab == "volume":
        base = f"""SELECT * FROM (
        SELECT DISTINCT ON(v.kw_key,v.location_code,v.language_code) k.term,v.*
        FROM gold.kw_volume_monthly v JOIN gold.dim_keyword k USING(kw_key)
        WHERE {where} ORDER BY v.kw_key,v.location_code,v.language_code,v.month DESC,v.observed_at DESC) latest"""
        order = "search_volume DESC NULLS LAST,term,location_code,language_code"
    else:
        table = "kw_serp" if tab == "serp" else "kw_suggestion"
        grain = "kw_key" if tab == "serp" else "seed_kw_key"
        base = f"""WITH calls AS (SELECT DISTINCT ON({grain},location_code,language_code)
            {grain},location_code,language_code,call_id FROM gold.{table}
            ORDER BY {grain},location_code,language_code,observed_at DESC,call_id DESC)
            SELECT k.term,v.* FROM gold.{table} v JOIN calls USING({grain},location_code,language_code,call_id)
            JOIN gold.dim_keyword k ON k.kw_key=v.kw_key WHERE {where}"""
        order = "term,location_code,language_code," + ("rank" if tab == "serp" else "pos")
    total = await ctx.conn.fetchval(f"SELECT count(*)::int FROM ({base}) x", *b.args)
    rows = await ctx.conn.fetch(f"SELECT * FROM ({base}) x ORDER BY {order} LIMIT {b.bind(size)} OFFSET {b.bind(skip)}", *b.args)
    data = {"tab": tab, "items": [dict(r) for r in rows], "history": [], "serp": [], "suggestions": [],
            "registered_keywords": None, "project_mapping": None}
    # Detail is scoped to the selected keyword + market; never combine different locations/languages.
    if ctx.q.get("keyword"):
        try:
            key = int(ctx.q["keyword"])
        except ValueError:
            raise HTTPException(422, "Invalid keyword") from None
        location = int(ctx.q["location"]) if ctx.q.get("location") else None
        language = ctx.q.get("language") or None
        args = (key, location, language)
        data["history"] = [dict(r) for r in await ctx.conn.fetch("""SELECT k.term,v.* FROM gold.kw_volume_monthly v
            JOIN gold.dim_keyword k USING(kw_key) WHERE v.kw_key=$1 AND ($2::int IS NULL OR location_code=$2)
            AND ($3::text IS NULL OR language_code=$3) ORDER BY month DESC,observed_at DESC LIMIT 1000""", *args)]
        # The latest collection per market is one SERP/suggestion observation, not a sum of old calls.
        data["serp"] = [dict(r) for r in await ctx.conn.fetch("""WITH latest AS (
            SELECT DISTINCT ON(location_code,language_code) call_id,location_code,language_code FROM gold.kw_serp
            WHERE kw_key=$1 AND ($2::int IS NULL OR location_code=$2) AND ($3::text IS NULL OR language_code=$3)
            ORDER BY location_code,language_code,observed_at DESC,call_id DESC)
            SELECT s.* FROM gold.kw_serp s JOIN latest USING(call_id,location_code,language_code)
            WHERE s.kw_key=$1 ORDER BY s.location_code,s.language_code,s.rank LIMIT 1000""", *args)]
        data["suggestions"] = [dict(r) for r in await ctx.conn.fetch("""WITH latest AS (
            SELECT DISTINCT ON(location_code,language_code) call_id,location_code,language_code FROM gold.kw_suggestion
            WHERE seed_kw_key=$1 AND ($2::int IS NULL OR location_code=$2) AND ($3::text IS NULL OR language_code=$3)
            ORDER BY location_code,language_code,observed_at DESC,call_id DESC)
            SELECT k.term,s.* FROM gold.kw_suggestion s JOIN latest USING(call_id,location_code,language_code)
            JOIN gold.dim_keyword k USING(kw_key) WHERE s.seed_kw_key=$1 ORDER BY s.pos LIMIT 1000""", *args)]
    data["markets"] = [dict(r) for r in await ctx.conn.fetch("""SELECT location_code,language_code FROM gold.kw_volume_monthly
        UNION SELECT location_code,language_code FROM gold.kw_serp UNION SELECT location_code,language_code FROM gold.kw_suggestion
        ORDER BY location_code,language_code""")]
    return envelope(ctx, data, page={"total": total, "limit": size,
        "next_cursor": str(skip + size) if skip + size < total else None})


async def social(ctx):
    q, conn = ctx.q, ctx.conn
    snapshots = [dict(r) for r in await conn.fetch("SELECT * FROM gold.ctx_snapshot ORDER BY is_active DESC,taken_at DESC,snapshot_id DESC")]
    snap = next((r for r in snapshots if str(r["snapshot_id"]) == q.get("snapshot")), None) if q.get("snapshot") else next(iter(snapshots), None)
    if q.get("snapshot") and snap is None:
        raise HTTPException(404, "Snapshot not present in Gold")
    if snap is None:
        return envelope(ctx, {"snapshot": None, "snapshots": [], "stats": {}, "items": [], "detail": None})
    sid = snap["snapshot_id"]
    stats = dict(await conn.fetchrow("""SELECT count(*)::int AS entities,
        count(*) FILTER(WHERE type='ConsumerContext')::int AS contexts,
        count(*) FILTER(WHERE type='ConsumerRequirement')::int AS requirements FROM gold.ctx_entity WHERE snapshot_id=$1""", sid))
    for name, table in (("combinations", "ctx_combination"), ("relations", "ctx_drive"), ("evidence", "ctx_evidence"),
                        ("claims", "ctx_claim"), ("research_runs", "ctx_research_run")):
        stats[name] = await conn.fetchval(f"SELECT count(*)::int FROM gold.{table} WHERE snapshot_id=$1", sid)
    tab = q.get("tab", "contexts")
    size, skip = limit(q, 50, 200), offset(q)
    b = SQL()
    where = [f"f.snapshot_id={b.bind(sid)}"]
    search = q.get("q", "").strip()
    if tab in ("contexts", "requirements"):
        where.append(f"f.type={b.bind('ConsumerContext' if tab == 'contexts' else 'ConsumerRequirement')}")
        if search:
            where.append(f"f.canonical_name ILIKE {b.bind('%'+search+'%')}")
        base = "gold.ctx_entity f LEFT JOIN gold.ctx_group g ON (g.snapshot_id,g.group_id)=(f.snapshot_id,f.group_id)"
        select = "f.*,g.name AS group_name,g.description AS group_description"
        order = "f.mention_count DESC NULLS LAST,f.canonical_name,f.id"
    elif tab == "combinations":
        base = "gold.ctx_combination f LEFT JOIN gold.ctx_entity a ON (a.snapshot_id,a.id)=(f.snapshot_id,f.cond_a) LEFT JOIN gold.ctx_entity z ON (z.snapshot_id,z.id)=(f.snapshot_id,f.cond_b)"
        select, order = "f.*,a.canonical_name AS condition_a,z.canonical_name AS condition_b", "f.co_count DESC NULLS LAST,f.combo_id"
        if search:
            where.append(f"concat_ws(' ',f.description,a.canonical_name,z.canonical_name) ILIKE {b.bind('%'+search+'%')}")
    elif tab == "relations":
        base = "gold.ctx_drive f JOIN gold.ctx_entity a ON (a.snapshot_id,a.id)=(f.snapshot_id,f.context_id) JOIN gold.ctx_entity z ON (z.snapshot_id,z.id)=(f.snapshot_id,f.requirement_id)"
        select, order = "f.*,a.canonical_name AS context,z.canonical_name AS requirement", "f.strength_score DESC NULLS LAST,f.context_id,f.requirement_id"
        if search:
            where.append(f"concat_ws(' ',a.canonical_name,z.canonical_name) ILIKE {b.bind('%'+search+'%')}")
    elif tab == "research":
        base, select, order = "gold.ctx_research_run f", "f.*", "f.run_id"
        if search:
            where.append(f"f.keyword ILIKE {b.bind('%'+search+'%')}")
    else:
        raise HTTPException(422, "Unknown social tab")
    clause = " AND ".join(where)
    total = await conn.fetchval(f"SELECT count(*)::int FROM {base} WHERE {clause}", *b.args)
    items = [dict(r) for r in await conn.fetch(f"SELECT {select} FROM {base} WHERE {clause} ORDER BY {order} LIMIT {b.bind(size)} OFFSET {b.bind(skip)}", *b.args)]
    detail = None
    if q.get("entity"):
        entity = await conn.fetchrow("SELECT * FROM gold.ctx_entity WHERE snapshot_id=$1 AND id::text=$2", sid, q["entity"])
        if not entity:
            raise HTTPException(404, "Entity not present in snapshot")
        detail = {"entity": dict(entity)}
        for key, sql in {
            "evidence": "SELECT * FROM gold.ctx_evidence WHERE snapshot_id=$1 AND entity_id::text=$2 ORDER BY rank NULLS LAST,id LIMIT 500",
            "domains": "SELECT * FROM gold.ctx_domain WHERE snapshot_id=$1 AND entity_id::text=$2 ORDER BY n DESC,host",
            "claims": "SELECT * FROM gold.ctx_claim WHERE snapshot_id=$1 AND entity_id::text=$2",
            "claim_quotes": "SELECT * FROM gold.ctx_claim_quote WHERE snapshot_id=$1 AND entity_id::text=$2 ORDER BY seq",
            "related": "SELECT r.* FROM gold.ctx_entity e JOIN gold.ctx_entity r ON r.snapshot_id=e.snapshot_id AND r.id=ANY(e.related_ids) WHERE e.snapshot_id=$1 AND e.id::text=$2 ORDER BY r.mention_count DESC NULLS LAST",
        }.items():
            detail[key] = [dict(r) for r in await conn.fetch(sql, sid, q["entity"])]
    if q.get("combination"):
        detail = {"combination_evidence": [dict(r) for r in await conn.fetch("""SELECT * FROM gold.ctx_combination_evidence
            WHERE snapshot_id=$1 AND combo_id=$2 ORDER BY seq""", sid, q["combination"])]}
    if q.get("run"):
        exists = await conn.fetchval("SELECT EXISTS(SELECT 1 FROM gold.ctx_research_run WHERE snapshot_id=$1 AND run_id::text=$2)", sid, q["run"])
        if not exists:
            raise HTTPException(404, "Research not present in snapshot")
        detail = {key: [dict(r) for r in await conn.fetch(f"SELECT * FROM gold.ctx_research_{table} WHERE run_id::text=$1 ORDER BY {order}", q["run"])]
                  for key, table, order in (("waves", "wave", "wave_no"), ("workers", "worker", "wave_no,worker_id"), ("logs", "log", "seq"))}
    return envelope(ctx, {"snapshot": snap, "snapshots": snapshots, "stats": stats, "tab": tab, "items": items,
        "detail": detail, "generated_prompts": None}, page={"total": total, "limit": size,
        "next_cursor": str(skip + size) if skip + size < total else None})
