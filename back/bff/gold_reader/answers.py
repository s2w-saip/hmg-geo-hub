"""Real answer bodies, citations, occurrences, and drill-down lists."""
from __future__ import annotations

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader.context import Context, SQL, envelope, flag, limit


async def listing(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="fact") + " AND f.std_in"
    for param, expression in (("prompt_id", "p.prompt_id::text"), ("job_id", "j.job_id::text")):
        if ctx.q.get(param):
            where += f" AND {expression}={b.bind(ctx.q[param])}"
    if ctx.q.get("brand_key"):
        where += f" AND EXISTS(SELECT 1 FROM gold.answer_brand_fact ab WHERE (ab.build_id,ab.answer_key)=(f.build_id,f.answer_key) AND ab.brand_key={b.bind(int(ctx.q['brand_key']))})"
    if ctx.q.get("q"):
        where += f" AND p.text ILIKE {b.bind('%' + ctx.q['q'] + '%')}"
    page_limit = limit(ctx.q)
    offset = max(0, int(ctx.q.get("cursor") or "0"))
    total = await ctx.conn.fetchval(f"SELECT count(*)::int FROM gold.answer_fact f JOIN gold.dim_prompt p USING(prompt_key) JOIN gold.job_index j USING(answer_key) WHERE {where}", *b.args)
    rows = await ctx.conn.fetch(f"""SELECT f.*,j.job_id,j.measured_at,p.prompt_id,p.text,e.code AS engine,
        c.code AS country,l.code AS lang FROM gold.answer_fact f JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key
        WHERE {where} ORDER BY f.round_date DESC,f.answer_key DESC LIMIT {b.bind(page_limit)} OFFSET {b.bind(offset)}""", *b.args)
    items = []
    for r in rows:
        own = sum(r[col] or 0 for bit, col in ((1, "ment_h"), (2, "ment_k"), (4, "ment_g")) if ctx.bits & bit)
        items.append({"id": str(r["job_id"]), "round_date": r["round_date"], "anchor_date": r["anchor_date"] or r["round_date"],
                      "measured_at": r["measured_at"], "prompt": {"prompt_id": str(r["prompt_id"]), "text": r["text"]},
                      "engine": r["engine"], "country": r["country"], "lang": (r["lang"] or "").lower() or None,
                      "is_rep": bool(r["is_rep"]), "is_acr": bool(r["is_acr"]), "acr_iter_rank": r["acr_iter_rank"] or 0,
                      "gap": bool(r["gap"]), "mentions": {"total": r["ment_total"] or 0, "own": {"count": own, "present": own > 0}},
                      "citations": {"has_cit": bool(r["has_cit"]), "tgt_cited": bool(r["tgt_cited"]), "own_url_cited": bool(r["own_url_cited"])}})
    return envelope(ctx, {"items": items}, page={"limit": page_limit, "total": total, "next_cursor": str(offset + page_limit) if offset + page_limit < total else None})


async def detail(ctx: Context, job_id: str) -> dict:
    job = await ctx.conn.fetchrow("SELECT * FROM gold.job_index WHERE job_id::text=$1", job_id)
    if job is None:
        raise HTTPException(404, "Answer not present in Gold")
    if job["surface"] != ctx.sf or (job["surface"] == 3 and job["project_key"] != ctx.project_key):
        project = await ctx.conn.fetchrow("SELECT * FROM gold.dim_project WHERE project_key=$1", job["project_key"])
        params = [(k, v) for k, v in ctx.q.multi_items() if k not in {"surface", "project_id", "card"}]
        params.append(("surface", {1: "global", 2: "website", 3: "project"}[job["surface"]]))
        if job["surface"] == 3:
            params.append(("project_id", str(project["project_id"] or project["scope_project_id"])))
        ctx = await Context.create(ctx.conn, QueryParams(params))
    row = await ctx.conn.fetchrow("""SELECT f.*,j.job_id,j.measured_at,p.prompt_id,p.text,p.kind,
        e.code AS engine,c.code AS country,l.code AS lang,cy.cycle_id,b.answer_text,b.model_slug
        FROM gold.answer_fact f JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key
        LEFT JOIN gold.dim_cycle cy ON cy.cyc_key=f.cyc_key LEFT JOIN gold.answer_body b USING(answer_key)
        WHERE f.answer_key=$1 AND f.build_id=ANY($2::bigint[]) LIMIT 1""", job["answer_key"], ctx.builds.get("fact", []))
    if row is None:
        raise HTTPException(404, "Answer is not in the active Gold release")
    mentions = await ctx.conn.fetch("""SELECT m.*,br.name AS parent_brand,br.own_bit,
        ab.rk AS brand_rank FROM gold.answer_mention_raw m
        LEFT JOIN gold.dim_entity e ON e.entity_key=m.entity_key
        LEFT JOIN gold.dim_brand br ON br.brand_key=e.brand_key
        LEFT JOIN gold.answer_brand_fact ab ON ab.answer_key=m.answer_key AND ab.brand_key=e.brand_key AND ab.build_id=$2
        WHERE m.answer_key=$1 ORDER BY m.ord""", row["answer_key"], row["build_id"])
    stances = await ctx.conn.fetch("SELECT * FROM gold.answer_stance_raw WHERE answer_key=$1 ORDER BY turn_index,entity_id", row["answer_key"])
    citations = await ctx.conn.fetch("""SELECT f.ord,u.url,u.title,u.domain,c.name AS category,f.loc_owned,f.tgt_hit
        FROM gold.citation_fact f LEFT JOIN gold.dim_url u USING(url_key)
        LEFT JOIN gold.dim_source s ON s.source_key=f.source_key LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
        WHERE f.answer_key=$1 AND f.build_id=$2 ORDER BY f.ord""", row["answer_key"], row["build_id"])
    data = {"id": job_id, "header": {"surface": ctx.surface, "cycle_id": str(row["cycle_id"]) if row["cycle_id"] else None,
        "round_date": row["round_date"], "anchor_date": row["anchor_date"], "measured_at": row["measured_at"],
        "engine": row["engine"], "country": row["country"], "lang": (row["lang"] or "").lower() or None,
        "prompt": {"prompt_id": str(row["prompt_id"]), "text": row["text"], "kind": row["kind"]},
        "catalog": None, "analysis_state": row["analysis_state"] or 0, "gap": bool(row["gap"]),
        "is_acr": bool(row["is_acr"]), "is_rep": row["is_rep"], "acr_iter_rank": row["acr_iter_rank"], "model_slug": row["model_slug"]},
        "body": {"available": row["answer_text"] is not None, "answer_text": row["answer_text"]},
        "mentions": {"brands": [], "models": []}, "sentiment": {"spans": [], "skipped": 0}, "stances": [],
        "citations": [{"ord": c["ord"], "url": c["url"], "title": c["title"], "domain": c["domain"],
                       "category": c["category"], "owned": c["loc_owned"], "target_hit": c["tgt_hit"]} for c in citations]}
    for m in mentions:
        entry = {"name": m["display_name"] or "", "mention_count": m["mention_count"] or 0}
        if m["entity_type"] == "Brand":
            entry.update(rank=m["brand_rank"] or None, own=bool((m["own_bit"] or 0) & ctx.bits))
            data["mentions"]["brands"].append(entry)
        elif m["entity_type"] == "Model":
            entry.update(avg_position=m["avg_position"], parent_brand=m["parent_brand"])
            data["mentions"]["models"].append(entry)
    for s in stances:
        body, evidence = row["answer_text"], s["evidence_text"]
        start, end = s["evidence_start"], s["evidence_end"]
        match = "unavailable"
        if body is not None and evidence and start is not None and end is not None:
            match = "verified" if 0 <= start <= end <= len(body) and body[start:end] == evidence else "mismatch"
        data["stances"].append({"turn_index": s["turn_index"], "entity_id": str(s["entity_id"]),
            "brand": s["brand_label"] or "", "own": (s["brand_label"] or "").lower() in {n.lower() for n in ctx.own_names},
            "stance": s["stance"], "confidence": s["confidence"], "evidence_text": evidence,
            "evidence_match": match, "reason": s["reason"]})
    occurrences = await ctx.conn.fetch("""SELECT o.*,b.name AS brand FROM gold.answer_occurrence o
        LEFT JOIN gold.dim_entity e ON e.entity_id=o.entity_id LEFT JOIN gold.dim_brand b ON b.brand_key=e.brand_key
        WHERE o.answer_key=$1 ORDER BY o.source_start,o.source_end,o.ord""", row["answer_key"])
    spans = {}
    for o in occurrences:
        start,end,body = o["source_start"],o["source_end"],row["answer_text"]
        # Never make up offsets or highlight an unrelated part of a body.
        if body is None or start is None or end is None or not 0<=start<end<=len(body) or o["sentiment"] not in {"positive","negative","mixed","neutral"} or (o["surface_text"] and body[start:end]!=o["surface_text"]):
            data["sentiment"]["skipped"] += 1
            continue
        key = (start,end,o["sentiment"])
        span = spans.setdefault(key,{"start":start,"end":end,"sentiment":o["sentiment"],"evidence":[]})
        span["evidence"].append({"brand_name":o["brand"],"sentiment":o["sentiment"],"assertion":o["assertion"],
            "descriptors":o["descriptors"] or [],"criteria":o["criteria"] or [],"context_snippet":o["context_snippet"]})
    data["sentiment"]["spans"] = list(spans.values())
    return envelope(ctx, data)
