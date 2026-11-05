"""Real answer bodies, citations, occurrences, and drill-down lists."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.gold_reader.context import BRAND_NAMES, Context, SQL, envelope, flag, limit

# The own columns of gold.answer_fact per own bit (Hyundai 1 · Kia 2 · Genesis 4).
_BIT_SUFFIX = {1: "h", 2: "k", 4: "g"}
SPLIT_KPIS = ("visibility", "shareOfVoice", "sentiment", "position", "citationShare")


def _own_sum(column: str, bits: int) -> str:
    return "(" + "+".join(f"coalesce(f.{column}_{_BIT_SUFFIX[b]},0)" for b in BRAND_NAMES if bits & b) + ")"


def _own_rank(bits: int) -> str:
    """당사's first rank in the answer: the lowest own brand rank (0 = not ranked), as the cells' position counts it."""
    return "least(" + ",".join(f"nullif(f.own_rk_{_BIT_SUFFIX[b]},0)" for b in BRAND_NAMES if bits & b) + ")"


def split_where(kpi: str, side: str, bits: int) -> str:
    """?split=<kpi>:<num|rest> (the 근거 drawer, ss-overview.html 4-2): the answers in a KPI's numerator, or the rest of
    its denominator. 노출률 · 점유율: 당사 mentioned / not (점유율's rest: only rivals mentioned); 우호도: a positive own
    signal / signals but none positive; 우선 노출도: 당사 first / 2nd or later; 인용 점유율: an official (HMG) citation /
    citations but none of them. `bits` is the context's own bits (an int, never request text)."""
    own = f"(f.own_mask & {int(bits)})<>0"
    num = side == "num"
    if kpi == "visibility":
        return own if num else f"NOT {own}"
    if kpi == "shareOfVoice":
        return own if num else f"f.ment_total>0 AND NOT {own}"
    if kpi == "sentiment":
        pos, every = _own_sum("sent_pos", bits), _own_sum("sent_all", bits)
        return f"{pos}>0" if num else f"{every}>0 AND {pos}=0"
    if kpi == "position":
        return f"{_own_rank(bits)}=1" if num else f"{_own_rank(bits)}>=2"
    if kpi == "citationShare":
        return "f.cit_off>0" if num else "f.cit_off=0 AND f.cit_n>0"
    raise HTTPException(422, "Unknown split KPI")


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
    # the 근거 drawer (2026-11-05 D-12 step 3): the cards' representative answers, a KPI's split, prompt order, the own
    # marks of each row and the answer text (for the excerpt); none of them changes the other callers' lists
    if flag(ctx.q, "rep"):
        where += " AND f.is_rep"
    if ctx.q.get("split"):
        kpi, _, side = ctx.q["split"].partition(":")
        if kpi not in SPLIT_KPIS or side not in ("num", "rest"):
            raise HTTPException(422, "split must be <kpi>:<num|rest>")
        where += " AND " + split_where(kpi, side, ctx.bits)
    marks, excerpt = flag(ctx.q, "marks"), flag(ctx.q, "excerpt")
    # prompt order: the same prompt's answers side by side (ICU, Gold's en_US.utf8 leaves Hangul unordered)
    by_prompt = ctx.q.get("order") == "prompt"
    order = 'p.text COLLATE "und-x-icu",e.code,c.code,f.answer_key' if by_prompt else "f.round_date DESC,f.answer_key DESC"
    page_limit = limit(ctx.q)
    offset = max(0, int(ctx.q.get("cursor") or "0"))
    total = await ctx.conn.fetchval(f"SELECT count(*)::int FROM gold.answer_fact f JOIN gold.dim_prompt p USING(prompt_key) JOIN gold.job_index j USING(answer_key) WHERE {where}", *b.args)
    mark_cols = (f",{_own_rank(ctx.bits)} AS own_rank,{_own_sum('sent_pos', ctx.bits)} AS own_pos,"
                 f"{_own_sum('sent_neg', ctx.bits)} AS own_neg,{_own_sum('sent_all', ctx.bits)} AS own_sent") if marks else ""
    # the excerpt: the body and Gold's first occurrence of 당사 in it (answer_occurrence offsets); an occurrence whose
    # offsets do not land on its surface text in the body is passed over, as the answer view drops it
    own_occ = ("FROM gold.answer_occurrence o JOIN gold.dim_entity en ON en.entity_id=o.entity_id JOIN gold.dim_brand ob"
               f" ON ob.brand_key=en.brand_key WHERE o.answer_key=f.answer_key AND (ob.own_bit & {int(ctx.bits)})<>0")
    body_col, body_join = ((",bd.answer_text,occ.source_start AS own_at,occ.source_end AS own_end,"
                            f"ARRAY(SELECT DISTINCT o.surface_text {own_occ} AND o.surface_text<>'') AS own_terms"),
                           (" LEFT JOIN gold.answer_body bd ON bd.answer_key=f.answer_key LEFT JOIN LATERAL (SELECT o.source_start,"
                            f"o.source_end {own_occ} AND o.source_start>=0 AND o.source_end>o.source_start"
                            " AND substr(bd.answer_text,o.source_start+1,o.source_end-o.source_start)=o.surface_text"
                            " ORDER BY o.source_start,o.ord LIMIT 1) occ ON true")) if excerpt else ("", "")
    page = f"""SELECT f.*,j.job_id,j.measured_at,p.prompt_id,p.text,e.code AS engine,
        c.code AS country,l.code AS lang{mark_cols} FROM gold.answer_fact f JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key
        WHERE {where} ORDER BY {order} LIMIT {b.bind(page_limit)} OFFSET {b.bind(offset)}"""
    # the body and the occurrences are read for the page's rows only (joined before the sort they took 14 s)
    if excerpt:
        outer = 'f.text COLLATE "und-x-icu",f.engine,f.country,f.answer_key' if by_prompt else "f.round_date DESC,f.answer_key DESC"
        page = f"WITH pg AS MATERIALIZED ({page}) SELECT f.*{body_col} FROM pg f{body_join} ORDER BY {outer}"
    rows = await ctx.conn.fetch(page, *b.args)
    items = []
    for r in rows:
        own = sum(r[col] or 0 for bit, col in ((1, "ment_h"), (2, "ment_k"), (4, "ment_g")) if ctx.bits & bit)
        items.append({"id": str(r["job_id"]), "round_date": r["round_date"], "anchor_date": r["anchor_date"] or r["round_date"],
                      "measured_at": r["measured_at"], "prompt": {"prompt_id": str(r["prompt_id"]), "text": r["text"]},
                      "engine": r["engine"], "country": r["country"], "lang": (r["lang"] or "").lower() or None,
                      "is_rep": bool(r["is_rep"]), "is_acr": bool(r["is_acr"]), "acr_iter_rank": r["acr_iter_rank"] or 0,
                      "gap": bool(r["gap"]), "mentions": {"total": r["ment_total"] or 0, "own": {"count": own, "present": own > 0}},
                      "citations": {"has_cit": bool(r["has_cit"]), "tgt_cited": bool(r["tgt_cited"]), "own_url_cited": bool(r["own_url_cited"])}})
        if marks:
            items[-1]["marks"] = {"rank": r["own_rank"], "sentiment": {"positive": r["own_pos"], "negative": r["own_neg"], "all": r["own_sent"]},
                                  "citations": {"official": r["cit_off"] or 0, "all": r["cit_n"] or 0}}
        if excerpt:
            items[-1]["answer_text"] = r["answer_text"]
            items[-1]["own_occurrence"] = {"start": r["own_at"], "end": r["own_end"]} if r["own_at"] is not None else None
            items[-1]["own_terms"] = sorted(r["own_terms"] or [])
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
    if ctx.week is not None and job["round_date"] is not None and job["round_date"] > ctx.week.end:
        raise HTTPException(404, "Answer is after the service week")
    # the cycle gates of the lists (Context.predicate, the calendar's hidden_scope): a link opens no answer they hide
    row = await ctx.conn.fetchrow("""SELECT f.*,j.job_id,j.measured_at,p.prompt_id,p.text,p.kind,
        e.code AS engine,c.code AS country,l.code AS lang,cy.cycle_id,b.answer_text,b.model_slug
        FROM gold.answer_fact f JOIN gold.job_index j USING(answer_key)
        JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key
        JOIN gold.dim_cycle cy ON cy.cyc_key=f.cyc_key LEFT JOIN gold.answer_body b USING(answer_key)
        WHERE f.answer_key=$1 AND f.build_id=ANY($2::bigint[])
          AND cy.servable AND coalesce(cy.hidden_scope,0)<>1 AND (cy.view_date IS NULL OR cy.view_date<=$3::date) LIMIT 1""",
        job["answer_key"], ctx.builds.get("fact", []), datetime.now(ZoneInfo("Asia/Seoul")).date())
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
