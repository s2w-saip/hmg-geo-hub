"""Geography, mention types, and period comparisons from Gold facts/cells."""
from __future__ import annotations

from collections import defaultdict

from bff.gold_reader.context import BRAND_NAMES, Context, envelope, flag
from bff.gold_reader.metrics import COUNTS, TYPES, _brand_values, brand_rows, counts, metric_values
from bff.metrics import compute
from bff.metrics.formulas import rate
from bff.metrics.gold_rows import metric_source

#: the sentiment matrix keys and their answer_brand_fact columns, in response order
SENTIMENTS = (("positive", "s_pos"), ("neutral", "s_neu"), ("negative", "s_neg"), ("mixed", "s_mix"))


async def branded_answers(ctx: Context) -> dict[int, int]:
    """?branded_share (the renewal market table, 2026-11-05 D-12): per country, the answers of the prompts the
    brand_presence=branded pick selects, within the read's own population."""
    return {r["geo_key"]: r["answers"] for r in await metric_source(ctx).branded_answers()}


async def geo(ctx: Context) -> dict:
    cs = await counts(ctx, group="country", prompts=False)
    branded = await branded_answers(ctx) if flag(ctx.q, "branded_share") else None
    citations = {r["geo_key"]: r for r in await counts(ctx, group="country", family="citations", prompts=False)}
    for c in cs:
        c.update({k: v for k, v in citations.get(c["geo_key"], {}).items() if k.startswith("cit_")})
    bs = await brand_rows(ctx, by_country=True, extras=frozenset())
    dimensions = {r["geo_key"]: dict(r) for r in await ctx.conn.fetch("""SELECT c.*,r.code AS area
        FROM gold.dim_country c LEFT JOIN gold.dim_region r USING(region_key)""")}
    # Each competitor's official sources per country, the sources the card's competitor citation share counts.
    rival_cited = defaultdict(int)
    for r in await metric_source(ctx).rival_citations():
        rival_cited[(r["geo_key"], r["name"])] = r["citations"]
    def row_metrics(c):
        return {k: v for k, v in metric_values(c).items() if k in {"visibility", "share_of_voice", "sentiment", "position", "citation_share"}}
    def rival_view(r, total, cited):
        v = _brand_values(r, total)
        return {"brand": r["name"], "metrics": {"visibility": v["exposure"], "share_of_voice": v["share"], "sentiment": v["favorability"], "position": v["priority"],
                                                "citation_share": compute.of("citation_share_global", cited, total["cit_total"])}}
    regions = defaultdict(list)
    for c in cs:
        dim = dimensions[c["geo_key"]]
        rivals = [r for r in bs if r["geo_key"] == c["geo_key"] and not r["own_bit"] and not ctx.excluded(r["name"])]
        ours = [r for r in bs if r["geo_key"] == c["geo_key"] and r["own_bit"] & ctx.bits]
        rivals.sort(key=lambda r: (-r["mentions"], r["name"]))
        ours.sort(key=lambda r: (-r["mentions"], r["name"]))
        row = {"code": dim["code"], "answers": c["answers"], "own": row_metrics(c),
               "rank": {"our": 1 + sum(r["mentions"] > c["own_mentions"] for r in rivals), "field_size": len(rivals) + 1},
               "top_own_brand": {"brand": ours[0]["name"], "share_of_voice": compute.of("share", ours[0]["mentions"], c["total_mentions"])} if ours else None,
               "top_rival": rival_view(rivals[0], c, rival_cited[(c["geo_key"], rivals[0]["name"])]) if rivals else None}
        if branded is not None:
            row["branded_answers"] = branded.get(c["geo_key"], 0)
        regions[dim["area"] or ""].append((row, c))
    markets = []
    region_totals = {}
    for region, rows in sorted(regions.items()):
        total = {col: sum(c[col] for _, c in rows) for col in COUNTS}
        region_totals[region] = total
        countries = [r for r, _ in rows]
        markets.append({"region_id": region, "region_label": region, "country_count": len(rows),
                        "answers": total["answers"], "own": row_metrics(total),
                        **({"branded_answers": sum(r["branded_answers"] for r in countries)} if branded is not None else {}),
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
                    if ctx.excluded(r["name"]):
                        continue
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
            market["top_own_brand"] = {"brand": name, "share_of_voice": compute.of("share", own[name], mention_total)}
        if rivals:
            rival = max(rivals.values(), key=lambda r: r["mentions"])
            market["top_rival"] = rival_view(rival, region_totals[market["region_id"]],
                                             sum(rival_cited[(k, rival["name"])] for k in country_keys))
    return envelope(ctx, {"active_brand": ctx.label, "own_label": ctx.label, "markets": markets, "pending": []})


async def types(ctx: Context) -> dict:
    source = metric_source(ctx)
    total = (await counts(ctx, prompts=False))[0]["answers_mon"]
    stance_rows = await source.stance_counts() if flag(ctx.q, "include_stance", True) else None
    async def block(bits):
        sides = {r["own"]: r for r in await source.type_sides(bits)}
        def v(own, key):
            return sides[own][key] if own in sides else 0
        by_type, matrix = [], []
        for t in TYPES:
            own_mentions, other_mentions = v(True, f"m_{t}"), v(False, f"m_{t}")
            own_answers, other_answers = v(True, f"a_{t}"), v(False, f"a_{t}")
            by_type.append({"type": t, "own_mentions": own_mentions, "other_mentions": other_mentions,
                "own_answers": own_answers, "other_answers": other_answers, "own_exposure": compute.type_exposure(t,own_answers,total),
                "other_exposure": compute.type_exposure(t,other_answers,total), "own_share": rate(own_mentions,own_mentions+other_mentions)})
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
