"""Citation readers use the fact build associated with the pinned release."""
from __future__ import annotations

from bff.gold_reader.context import Context, SQL, brand_key_of, envelope, flag, limit, ratio, values
from bff.gold_reader.metrics import TYPES

OFFICIAL_COMPETITOR = "officialCompetitor"
DOMAIN_SORTS = ("citations", "share", "coverage", "prompts", "skey")


def display_pct(r: dict) -> float:
    """A share as the table shows it: percent rounded to 0.1, halves up (the contract's sort key)."""
    from math import floor
    v = 1000 * r["num"] / r["den"] if r["den"] else 0
    return floor(v + 0.5) / 10


def select_domains(ctx: Context, items: list[dict]) -> list[dict]:
    """The rows of a domains read (contract BG-20/21; 2026-10-29 metric review R4: the reader ignored the
    pick, sort and skey). competitor = only these 공식(경쟁사) sources, other categories kept, ranks renumbered;
    q = skey contains q (ranks kept); skey = only these sources; then the sort (ties by rank)."""
    picks = set(values(ctx.q, "competitor"))
    if picks:
        items = [r for r in items if (r["category"] or {}).get("slug") != OFFICIAL_COMPETITOR or r["skey"] in picks]
        items = [{**r, "rank": i} for i, r in enumerate(items, 1)]
    q = (ctx.q.get("q") or "").strip().lower()
    if q:
        items = [r for r in items if q in r["skey"].lower()]
    if flag(ctx.q, "own_only"):
        items = [r for r in items if r["is_own"]]
    skeys = set(values(ctx.q, "skey"))
    if skeys:
        items = [r for r in items if r["skey"] in skeys]
    sort = ctx.q.get("sort") or "citations"
    if sort not in DOMAIN_SORTS:
        sort = "citations"
    desc = (ctx.q.get("dir") or ("asc" if sort == "skey" else "desc")) == "desc"
    if sort == "skey":
        return sorted(items, key=lambda r: (r["skey"], r["rank"]), reverse=desc)
    value = {"citations": lambda r: r["citations"], "prompts": lambda r: r["citing_prompts"],
             "share": lambda r: display_pct(r["share"]), "coverage": lambda r: display_pct(r["coverage"])}[sort]
    return sorted(items, key=lambda r: (-value(r) if desc else value(r), r["rank"]))


def predicate(ctx: Context, b: SQL, *, alias: str = "f") -> str:
    where = ctx.predicate(b, alias, family="fact", measure_family="citations") + f" AND {alias}.cit_in"
    if ctx.card:
        where += f" AND {alias}.is_rep"
    if values(ctx.q, "source"):
        where += f" AND {alias}.source_key IN (SELECT s.source_key FROM gold.dim_source s JOIN gold.dim_category d USING(category_key) WHERE d.slug=ANY({b.bind(values(ctx.q, 'source'), 'text[]')}))"
    if ctx.mention:
        where += " AND " + mentioned(ctx, b, alias)
    return where


async def mention_target(ctx: Context) -> bool:
    """The Mention brand row's 인용 출처 tab (2026-10-31 renewal audit 7-2: the reader ignored the target, so every row
    listed every citation of the filter). mention_brand = a display name (the contract: only the citations of answers
    where that brand is mentioned), mention_own=true = 당사 of the perspective (the 당사 row, whose label HMG is no Gold
    brand). Sets ctx.mention for predicate(); False for a name Gold does not know (the original API: an empty result,
    the name in meta.dropped_filters)."""
    if flag(ctx.q, "mention_own"):
        ctx.mention = ("own", None)
        return True
    name = (ctx.q.get("mention_brand") or "").strip()
    if not name:
        return True
    key = await brand_key_of(ctx.conn, name)
    if key is None:
        return False
    ctx.mention = ("brand", key)
    return True


def mentioned(ctx: Context, b: SQL, alias: str = "f") -> str:
    """The answer (same build, surface, round and answer key) holds a mention row of ctx.mention as the brand row's
    prompts tab counts it (drilldown.mention_prompts: std_in, competitive, mentioned; 당사 = an own brand of the
    perspective). The pkey of answer_brand_fact leads with those keys."""
    kind, key = ctx.mention
    who = (f"ab.brand_key={b.bind(key)}" if kind == "brand"
           else f"ab.brand_key IN (SELECT brand_key FROM gold.dim_brand WHERE (own_bit & {b.bind(ctx.bits)})<>0)")
    return (f"EXISTS(SELECT 1 FROM gold.answer_brand_fact ab WHERE (ab.build_id,ab.surface,ab.round_date,ab.answer_key)="
            f"({alias}.build_id,{alias}.surface,{alias}.round_date,{alias}.answer_key) "
            f"AND ab.std_in AND ab.competitive AND ab.mention_count>0 AND {who})")


def unknown_brand(ctx: Context, out: dict) -> dict:
    """A read of a brand Gold does not know: the empty shape and the name in meta.dropped_filters (the original API)."""
    out["meta"]["dropped_filters"] = {"mention_brand": [ctx.q.get("mention_brand")]}
    return out


async def owned_bases(ctx: Context) -> list[int]:
    """The global 허용 배열 (gold.dim_owned_base comment): the bases (both kinds) whose brand_bit is in the perspective
    (every base when it has none) → narrowed to the requested countries' geo_code → to the requested languages; a
    step whose result is empty does not narrow. owner_key 0 is the 자사 아님 row (2026-10-31: the reader took every
    base of the perspective, so a country or language filter counted other markets' own sites as 자사)."""
    if ctx.owned_bases is None:
        rows = await ctx.conn.fetch("SELECT owner_key,brand_bit,geo_code,language FROM gold.dim_owned_base WHERE owner_key<>0")
        allowed = [r for r in rows if r["brand_bit"] & ctx.bits] or rows
        for column, axis in (("geo_code", "country"), ("language", "lang")):
            picked = {v.lower() for v in values(ctx.q, axis)}
            if picked:
                allowed = [r for r in allowed if (r[column] or "").lower() in picked] or allowed
        ctx.owned_bases = sorted(r["owner_key"] for r in allowed)
    return ctx.owned_bases


async def own_citation(ctx: Context, b: SQL, alias: str = "f") -> str:
    """A 자사 citation, by surface as Gold defines it (gold.citation_cell): global = owner_key = ANY(허용 배열), website =
    loc_owned ∨ tgt_hit, project = loc_owned."""
    if ctx.sf == 1:
        return f"{alias}.owner_key=ANY({b.bind(await owned_bases(ctx), 'smallint[]')})"
    return f"({alias}.loc_owned OR {alias}.tgt_hit)" if ctx.sf == 2 else f"{alias}.loc_owned"


def category(row: dict) -> dict | None:
    return {"category_key": row["category_key"], "slug": row["slug"], "name": row["category_name"]} if row.get("category_key") is not None else None


async def domains(ctx: Context) -> dict:
    if not await mention_target(ctx):
        return unknown_brand(ctx, envelope(ctx, {"summary": {"total_citations": 0, "unique_sources": 0, "own_share": ratio(0, 0), "answers_den": 0},
                                                 "items": [], "competitor_totals": [], "competitor_sources": [] if flag(ctx.q, "competitor_sources") else None},
                                           page={"limit": limit(ctx.q), "total": 0, "next_cursor": None}))
    b = SQL()
    where = predicate(ctx, b)
    owned = await own_citation(ctx, b)
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
    if ctx.mention:  # coverage: of the answers where the brand is mentioned (the original API's answers_den_sql)
        where += " AND " + mentioned(ctx, b)
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
    selected = select_domains(ctx, items)
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
    # per engine x source, once: the category totals (per engine too) and each category's top sources over
    # every source (2026-10-29 metric review R4: the tooltip took them from the domain table's first page)
    per_source = [dict(r) for r in await ctx.conn.fetch(f"""WITH a AS (SELECT f.engine_key,f.source_key,count(*)::int AS citations
        FROM gold.citation_fact f WHERE {where} GROUP BY f.engine_key,f.source_key)
        SELECT a.engine_key,a.citations,s.skey,coalesce(s.domain,s.skey) AS domain,c.category_key,c.slug,c.name AS category_name
        FROM a JOIN gold.dim_source s USING(source_key) JOIN gold.dim_category c ON c.category_key=s.category_key""", *b.args)]
    by_engine_category: dict = {}
    by_source: dict = {}
    for r in per_source:
        key = (r["engine_key"], r["category_key"])
        row = by_engine_category.setdefault(key, {**{k: r[k] for k in ("engine_key", "category_key", "slug", "category_name")}, "citations": 0})
        row["citations"] += r["citations"]
        src = by_source.setdefault(r["skey"], {"skey": r["skey"], "domain": r["domain"], "category_key": r["category_key"], "citations": 0})
        src["citations"] += r["citations"]
    rows = sorted(by_engine_category.values(), key=lambda r: -r["citations"])
    total = sum(r["citations"] for r in rows)
    tops: dict = {}
    for src in sorted(by_source.values(), key=lambda s: (-s["citations"], s["skey"])):
        top = tops.setdefault(src["category_key"], [])
        if len(top) < 3:
            top.append({"skey": src["skey"], "domain": src["domain"], "citations": src["citations"]})
    groups = {}
    for row in rows:
        key = row["category_key"]
        r = groups.setdefault(key, {"category": category(row), "citations": 0, "top_sources": tops.get(key, [])})
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
    if values(ctx.q, "source"):
        # the 출처 filter narrows the type matrix too (it read every category: R4)
        where += f" AND f.category_key IN (SELECT category_key FROM gold.dim_category WHERE slug=ANY({b.bind(values(ctx.q, 'source'), 'text[]')}))"
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
