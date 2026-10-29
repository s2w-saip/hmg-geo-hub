"""Geography, mention types, and period comparisons from Gold facts/cells."""
from __future__ import annotations

from collections import defaultdict

from bff.gold_reader.context import BRAND_NAMES, Context, SQL, envelope, flag, rank_avg, ratio
from bff.gold_reader.metrics import COUNTS, TYPES, brand_rows, counts, metric_values

#: the sentiment matrix keys and their answer_brand_fact columns, in response order
SENTIMENTS = (("positive", "s_pos"), ("neutral", "s_neu"), ("negative", "s_neg"), ("mixed", "s_mix"))


async def geo(ctx: Context) -> dict:
    cs = await counts(ctx, group="country", prompts=False)
    citations = {r["geo_key"]: r for r in await counts(ctx, group="country", family="citations", prompts=False)}
    for c in cs:
        c.update({k: v for k, v in citations.get(c["geo_key"], {}).items() if k.startswith("cit_")})
    bs = await brand_rows(ctx, by_country=True, extras=frozenset())
    dimensions = {r["geo_key"]: dict(r) for r in await ctx.conn.fetch("""SELECT c.*,r.code AS area
        FROM gold.dim_country c LEFT JOIN gold.dim_region r USING(region_key)""")}
    def row_metrics(c):
        return {k: v for k, v in metric_values(c).items() if k in {"visibility", "share_of_voice", "sentiment", "position", "citation_share"}}
    def rival_view(r, total):
        return {"brand": r["name"], "metrics": {"visibility": ratio(r["answers"], total["answers"]),
                "share_of_voice": ratio(r["mentions"], total["total_mentions"]),
                "sentiment": ratio(r["positive"], sum(r[k] for k in ("positive", "negative", "neutral", "mixed"))),
                "position": rank_avg(r["rank_sum"], r["ranked"]), "citation_share": None}}
    regions = defaultdict(list)
    for c in cs:
        dim = dimensions[c["geo_key"]]
        rivals = [r for r in bs if r["geo_key"] == c["geo_key"] and not r["own_bit"]]
        ours = [r for r in bs if r["geo_key"] == c["geo_key"] and r["own_bit"] & ctx.bits]
        rivals.sort(key=lambda r: (-r["mentions"], r["name"]))
        ours.sort(key=lambda r: (-r["mentions"], r["name"]))
        row = {"code": dim["code"], "answers": c["answers"], "own": row_metrics(c),
               "rank": {"our": 1 + sum(r["mentions"] > c["own_mentions"] for r in rivals), "field_size": len(rivals) + 1},
               "top_own_brand": {"brand": ours[0]["name"], "share_of_voice": ratio(ours[0]["mentions"], c["total_mentions"])} if ours else None,
               "top_rival": rival_view(rivals[0], c) if rivals else None}
        regions[dim["area"] or ""].append((row, c))
    markets = []
    region_totals = {}
    for region, rows in sorted(regions.items()):
        total = {col: sum(c[col] for _, c in rows) for col in COUNTS}
        region_totals[region] = total
        countries = [r for r, _ in rows]
        markets.append({"region_id": region, "region_label": region, "country_count": len(rows),
                        "answers": total["answers"], "own": row_metrics(total),
                        "rank": None,
                        "top_own_brand": None, "top_rival": None, "countries": countries})
    # Region ranking needs region-wide brand sums, not averages of country ranks.
    for market in markets:
        country_keys = {k for k, d in dimensions.items() if (d["area"] or "") == market["region_id"]}
        rivals = {}
        own = defaultdict(int)
        for r in bs:
            if r["geo_key"] in country_keys:
                if not r["own_bit"]:
                    rival = rivals.setdefault(r["name"], {"name": r["name"], **dict.fromkeys(("mentions", "answers", "positive", "negative", "neutral", "mixed", "rank_sum", "ranked"), 0)})
                    for key in ("mentions", "answers", "positive", "negative", "neutral", "mixed", "rank_sum", "ranked"):
                        rival[key] += r[key]
                elif r["own_bit"] & ctx.bits:
                    own[r["name"]] += r["mentions"]
        mention_total = market["own"]["share_of_voice"]["den"]
        own_mentions = market["own"]["share_of_voice"]["num"]
        market["rank"] = {"our": 1 + sum(r["mentions"] > own_mentions for r in rivals.values()), "field_size": len(rivals) + 1}
        if own:
            name = max(own, key=own.get)
            market["top_own_brand"] = {"brand": name, "share_of_voice": ratio(own[name], mention_total)}
        if rivals:
            rival = max(rivals.values(), key=lambda r: r["mentions"])
            market["top_rival"] = rival_view(rival, region_totals[market["region_id"]])
    return envelope(ctx, {"active_brand": ctx.label, "own_label": ctx.label, "markets": markets, "pending": []})


async def types(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="fact") + " AND f.std_in AND f.competitive"
    if ctx.card:
        where += " AND f.is_rep"
    # Per side (own = the brand's own_bit meets the block's bits) and type, over the rows that carry the type
    # (t > 0): the mentions, the rows, the distinct answers and the rows' sentiment sums. Summed in the database,
    # per answer first so an answer counts once a side: fetching the rows (~1M on a month) and walking them
    # per type took 2.7 s, 1.7 s of it on the event loop every other screen waits on.
    bits_ref = f"${len(b.args) + 1}::int"
    inner, outer = [], []
    for t in TYPES:
        hit = f"f.t_{t}>0"
        inner += [f"sum(f.t_{t}) FILTER(WHERE {hit}) AS m_{t}", f"count(*) FILTER(WHERE {hit}) AS n_{t}",
                  *(f"sum(f.{col}) FILTER(WHERE {hit}) AS {col}_{t}" for _, col in SENTIMENTS)]
        outer += [f"coalesce(sum(g.m_{t}),0)::bigint AS m_{t}", f"coalesce(sum(g.n_{t}),0)::bigint AS n_{t}",
                  f"count(*) FILTER(WHERE g.n_{t}>0)::int AS a_{t}",
                  *(f"coalesce(sum(g.{col}_{t}),0)::bigint AS {col}_{t}" for _, col in SENTIMENTS)]
    sides_sql = f"""WITH g AS (SELECT f.answer_key,(br.own_bit & {bits_ref})<>0 AS own,{','.join(inner)}
        FROM gold.answer_brand_fact f JOIN gold.dim_brand br USING(brand_key) WHERE {where} GROUP BY 1,2)
        SELECT g.own,{','.join(outer)} FROM g GROUP BY g.own"""
    fact_args = b.args
    total = (await counts(ctx, prompts=False))[0]["answers"]
    stance_rows = None
    if flag(ctx.q, "include_stance", True) and not ctx.card:
        b = SQL()
        where = ctx.predicate(b, family="fact") + " AND f.std_in"
        stance_rows = await ctx.conn.fetch(f"""SELECT s.own_bit,s.stance,count(*)::int AS n
            FROM gold.answer_fact f JOIN gold.answer_stance_fact s
            ON (s.build_id,s.surface,s.round_date,s.answer_key)=(f.build_id,f.surface,f.round_date,f.answer_key)
            WHERE {where} AND s.first_turn AND s.std_in GROUP BY s.own_bit,s.stance""", *b.args)
    async def block(bits):
        sides = {r["own"]: r for r in await ctx.conn.fetch(sides_sql, *fact_args, bits)}
        def v(own, key):
            return sides[own][key] if own in sides else 0
        by_type, matrix = [], []
        for t in TYPES:
            own_mentions, other_mentions = v(True, f"m_{t}"), v(False, f"m_{t}")
            own_answers, other_answers = v(True, f"a_{t}"), v(False, f"a_{t}")
            by_type.append({"type": t, "own_mentions": own_mentions, "other_mentions": other_mentions,
                "own_answers": own_answers, "other_answers": other_answers, "own_exposure": ratio(own_answers,total),
                "other_exposure": ratio(other_answers,total), "own_share": ratio(own_mentions,own_mentions+other_mentions)})
            for label, own_sides in (("own",(True,)),("all",(True,False))):
                matrix.append({"type":t,"scope":label,"rows":sum(v(s, f"n_{t}") for s in own_sides),
                    **{name:sum(v(s, f"{col}_{t}") for s in own_sides) for name, col in SENTIMENTS}})
        stance = None
        if stance_rows is not None:
            stance = {name:sum(r["n"] for r in stance_rows if r["own_bit"] & bits and r["stance"]==i)
                for i,name in ((1,"positive"),(2,"neutral"),(3,"mixed"),(4,"negative"))}
            stance["pairs"] = sum(stance.values())
        return {"by_type":by_type,"sentiment_matrix":matrix,"stance":stance}
    split = None
    if flag(ctx.q,"split_own"):
        split = [{"own_brand_code":name,**await block(bit)} for bit,name in BRAND_NAMES.items() if bit & ctx.bits] if len(ctx.own_names)>1 else []
    return envelope(ctx,{"answers_total":total,**await block(ctx.bits),"by_own_brand":split})
