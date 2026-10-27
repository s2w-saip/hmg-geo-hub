"""ACR numerators and denominators come from published Gold ACR builds."""
from __future__ import annotations

from collections import defaultdict

from bff.gold_reader.context import Context, SQL, envelope, ratio


async def read(ctx: Context) -> dict:
    b = SQL()
    where = ctx.predicate(b, family="acr") + " AND f.acr_in"
    if ctx.card:
        where += " AND f.is_rep"
    cells = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.*,p.prompt_id,p.text AS prompt_text,e.code AS engine,
        c.code AS country,l.code AS lang FROM gold.acr_cell_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
        JOIN gold.dim_engine e ON e.engine_key=f.engine_key JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key
        WHERE {where}""", *b.args)]
    keys = [r["acr_cell_key"] for r in cells]
    totals = {"prompt_runs": len(cells), "prompts": len({r["prompt_key"] for r in cells}),
              "iterations": sum(r["valid_acr"] or 0 for r in cells), "engines": sorted({r["engine"] for r in cells}),
              "catalog_acr_prompts": None}
    rows = [dict(r) for r in await ctx.conn.fetch("""SELECT f.*,b.name AS brand,e.rep_name AS model,
        parent.name AS parent_brand FROM gold.acr_entity_fact f
        LEFT JOIN gold.dim_brand b USING(brand_key) LEFT JOIN gold.dim_entity e USING(entity_key)
        LEFT JOIN gold.dim_brand parent ON parent.brand_key=f.parent_brand_key
        WHERE f.build_id=ANY($1::bigint[]) AND f.acr_cell_key=ANY($2::int[]) AND f.keep""", ctx.builds.get("acr", []), keys)]
    by_key = {r["acr_cell_key"]: r for r in cells}
    rows_by_cell = defaultdict(list)
    for r in rows:
        rows_by_cell[r["acr_cell_key"]].append(r)
    brand_groups = {}
    for r in rows:
        if r["level"] != 1 or not r["brand"]:
            continue
        target = brand_groups.setdefault(r["brand"], {"brand": r["brand"], "is_ours": bool(r["own_bit"] & ctx.bits),
                                                     "choice": 0, "appearance": 0, "cells_set": set()})
        target["choice"] += r["choice"] or 0
        target["appearance"] += r["appearance"] or 0
        if r["appearance"]:
            target["cells_set"].add(r["acr_cell_key"])
    brands = []
    for r in brand_groups.values():
        brands.append({"brand": r["brand"], "is_ours": r["is_ours"], "choice": r["choice"], "appearance": r["appearance"],
                       "cells": len(r["cells_set"]), "choice_share": ratio(r["choice"], totals["iterations"]),
                       "coverage": ratio(len(r["cells_set"]), totals["prompt_runs"])})
    brands.sort(key=lambda r: (-r["choice"], -r["appearance"], r["brand"]))
    own_rows = [r for r in brands if r["is_ours"]]
    own_cells = {r["acr_cell_key"] for r in rows if r["level"] == 1 and r["own_bit"] & ctx.bits and r["appearance"]}
    own_choice = sum(r["choice"] for r in own_rows)
    own = {"choice": own_choice, "appearance": sum(r["appearance"] for r in own_rows), "cells": len(own_cells),
           "choice_share": ratio(own_choice, totals["iterations"]), "coverage": ratio(len(own_cells), totals["prompt_runs"])} if cells else None
    trend = []
    top = brands[:max(1, min(100, int(ctx.q.get("top_brands", "10"))))]
    for day in sorted({r["round_date"] for r in cells}):
        day_keys = {r["acr_cell_key"] for r in cells if r["round_date"] == day}
        trend.append({"round_date": day, "gap": False, "den": sum(r["valid_acr"] or 0 for r in cells if r["round_date"] == day),
                      "series": [{"brand": brand["brand"], "num": sum(r["choice"] or 0 for r in rows if r["level"] == 1 and r["brand"] == brand["brand"] and r["acr_cell_key"] in day_keys)} for brand in top]})
    battle_groups = defaultdict(lambda: defaultdict(int))
    for r in rows:
        if r["level"] == 1 and r["brand"] and r["choice"]:
            c = by_key[r["acr_cell_key"]]
            battle_groups[(c["prompt_id"], c["engine"])][r["brand"]] += r["choice"]
    battle = {}
    for (prompt, engine), choices in battle_groups.items():
        winner = sorted(choices, key=lambda n: (-choices[n], n))[0]
        c = next(r for r in cells if r["prompt_id"] == prompt)
        row = battle.setdefault(prompt, {"prompt_id": str(prompt), "prompt_text": c["prompt_text"], "cells": []})
        row["cells"].append({"engine": engine, "winner_brand": winner,
                             "winner_is_ours": brand_groups[winner]["is_ours"], "choice": choices[winner]})
    # Conversion uses iteration shortlist appearances, not mention counts.
    shortlist = await ctx.conn.fetch("""SELECT s.entity_key,e.rep_name AS model,b.name AS brand,
        coalesce(b.own_bit,0) AS own_bit,count(*)::int AS appearances,
        count(*) FILTER(WHERE s.is_choice)::int AS chosen,count(DISTINCT s.acr_cell_key)::int AS cells
        FROM gold.acr_iter_shortlist s JOIN gold.dim_entity e USING(entity_key)
        LEFT JOIN gold.dim_brand b ON b.brand_key=s.parent_brand_key
        WHERE s.build_id=ANY($1::bigint[]) AND s.acr_cell_key=ANY($2::int[]) AND s.level=2
        GROUP BY s.entity_key,e.rep_name,b.name,b.own_bit ORDER BY chosen DESC,appearances DESC,e.rep_name""", ctx.builds.get("acr", []), keys)
    models = [{"brand": r["brand"], "model": r["model"], "is_ours": bool(r["own_bit"] & ctx.bits),
               "conversion": ratio(r["chosen"], r["appearances"]), "cells": r["cells"], "top1": r["chosen"]} for r in shortlist]
    territory_groups = {}
    for c in cells:
        key = (c["country"], c["engine"])
        sheet = territory_groups.setdefault(key, {"country": c["country"], "engine": c["engine"], "rows": []})
        entries = [{"brand": r["brand"], "choice": r["choice"], "is_ours": bool(r["own_bit"] & ctx.bits)}
                   for r in rows_by_cell[c["acr_cell_key"]] if r["level"] == 1 and r["brand"]]
        sheet["rows"].append({"prompt_id": str(c["prompt_id"]), "prompt_text": c["prompt_text"],
                              "valid_acr": c["valid_acr"], "entries": entries})
    return envelope(ctx, {"totals": totals, "brands": top, "own": own,
                          "trend": {"series_brands": [r["brand"] for r in top], "buckets": trend},
                          "battle": list(battle.values()), "model_conversion": models,
                          "territory": list(territory_groups.values()),
                          "options": {"langs": sorted({r["lang"].lower() for r in cells if r["lang"]}),
                                      "countries": sorted({r["country"] for r in cells if r["country"]})}})
