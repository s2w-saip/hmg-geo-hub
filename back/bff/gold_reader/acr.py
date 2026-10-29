"""ACR numerators and denominators come from published Gold ACR builds."""
from __future__ import annotations

from collections import defaultdict
from copy import copy

from bff.gold_reader.context import Context, SQL, envelope, ratio

TREND_CYCLES = 12


def trend_dates(ctx: Context) -> list:
    """The trend's rounds: the period's in period mode, else the last trend_cycles ACR rounds up to the
    snapshot (the contract's trend_cycles; 2026-10-29 metric review R5: a snapshot read its one round, so the
    page had one trend point and no Δ)."""
    if ctx.q.get("from") or ctx.q.get("to") or not ctx.selected_dates:
        return sorted(ctx.selected_dates)
    acr_days = {ctx.build_dates[b] for b in ctx.builds.get("acr", []) if b in ctx.build_dates}
    end = max(ctx.selected_dates)
    days = sorted(d for d in ctx.dates if d <= end and d in acr_days)
    n = max(1, min(104, int(ctx.q.get("trend_cycles", str(TREND_CYCLES)))))
    return days[-n:]


async def trend_rows(ctx: Context, days: list) -> tuple[dict, list[dict]]:
    """{round_date: Σvalid_acr} and the level-1 picks per round and brand over `days`, aggregated in the database."""
    tctx = copy(ctx)
    tctx.selected_dates = days
    b = SQL()
    where = tctx.predicate(b, family="acr") + " AND f.acr_in" + (" AND f.is_rep" if ctx.card else "")
    den = {r["round_date"]: r["den"] for r in await ctx.conn.fetch(f"""SELECT f.round_date,sum(f.valid_acr)::bigint AS den
        FROM gold.acr_cell_fact f WHERE {where} GROUP BY f.round_date""", *b.args)}
    picks = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.round_date,br.name AS brand,coalesce(br.own_bit,0) AS own_bit,
        sum(e.choice)::bigint AS choice
        FROM gold.acr_cell_fact f JOIN gold.acr_entity_fact e ON e.build_id=f.build_id AND e.acr_cell_key=f.acr_cell_key
        JOIN gold.dim_brand br ON br.brand_key=e.brand_key
        WHERE {where} AND e.keep AND e.level=1 GROUP BY f.round_date,br.name,br.own_bit""", *b.args)]
    return den, picks


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
        parent.name AS parent_brand,parent.own_bit AS parent_own_bit FROM gold.acr_entity_fact f
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
    # 당사 = every own brand of the perspective, wherever the page shows it (the total, its brands, its standing
    # and its trend), beyond the brand table's top (2026-10-29 metric review R1: Genesis was left out).
    own_rows = [r for r in brands if r["is_ours"]]
    own_cells = {r["acr_cell_key"] for r in rows if r["level"] == 1 and r["own_bit"] & ctx.bits and r["appearance"]}
    own_choice = sum(r["choice"] for r in own_rows)
    chosen_rivals = [r for r in brands if not r["is_ours"] and r["choice"]]
    own = {"choice": own_choice, "appearance": sum(r["appearance"] for r in own_rows), "cells": len(own_cells),
           "choice_share": ratio(own_choice, totals["iterations"]), "coverage": ratio(len(own_cells), totals["prompt_runs"]),
           "brands": [r["brand"] for r in own_rows],
           "rank": 1 + len([r for r in chosen_rivals if r["choice"] > own_choice]), "ranked_brands": len(chosen_rivals) + 1} if cells else None
    trend = []
    top = brands[:max(1, min(100, int(ctx.q.get("top_brands", "12"))))]
    den, picks = await trend_rows(ctx, trend_dates(ctx)) if cells else ({}, [])
    for day in sorted(den):
        day_picks = [r for r in picks if r["round_date"] == day]
        trend.append({"round_date": day, "gap": False, "den": den[day],
                      "own": sum(r["choice"] or 0 for r in day_picks if r["own_bit"] & ctx.bits),
                      "series": [{"brand": brand["brand"], "num": sum(r["choice"] or 0 for r in day_picks if r["brand"] == brand["brand"])} for brand in top]})
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
    # A model's conversion (the contract's AcrModelRow): its final picks over the repetitions of the cells it was a
    # candidate in, from every repetition's level-2 row; the models picked at least once, best first, model_limit of
    # them (2026-10-29 metric review R5: one representative repetition per cell, ~1/10 of the picks, every model).
    by_model: dict = {}
    for r in rows:
        if r["level"] != 2 or not r["model"] or not r["appearance"]:
            continue
        m = by_model.setdefault((r["entity_key"], r["parent_brand"]), {"brand": r["parent_brand"], "model": r["model"],
                                                                       "own_bit": r["parent_own_bit"] or 0, "choice": 0, "den": 0, "cells": 0})
        m["choice"] += r["choice"] or 0
        m["den"] += by_key[r["acr_cell_key"]]["valid_acr"] or 0
        m["cells"] += 1
    chosen_models = sorted((m for m in by_model.values() if m["choice"] > 0 and m["den"] > 0),
                           key=lambda m: (-m["choice"] / m["den"], -m["choice"], m["model"]))[:max(1, min(50, int(ctx.q.get("model_limit", "12"))))]
    models = [{"brand": m["brand"], "model": m["model"], "is_ours": bool(m["own_bit"] & ctx.bits),
               "conversion": ratio(m["choice"], m["den"]), "cells": m["cells"], "top1": m["choice"]} for m in chosen_models]
    territory_groups = {}
    for c in cells:
        key = (c["country"], c["engine"])
        sheet = territory_groups.setdefault(key, {"country": c["country"], "engine": c["engine"], "rows": []})
        # the sheet's bar and its 최빈 column read the brands most picked first (R5: in read order, with unpicked ones first)
        entries = sorted(({"brand": r["brand"], "choice": r["choice"], "is_ours": bool(r["own_bit"] & ctx.bits)}
                          for r in rows_by_cell[c["acr_cell_key"]] if r["level"] == 1 and r["brand"]),
                         key=lambda e: (-(e["choice"] or 0), e["brand"]))
        sheet["rows"].append({"prompt_id": str(c["prompt_id"]), "prompt_text": c["prompt_text"],
                              "valid_acr": c["valid_acr"], "entries": entries})
    return envelope(ctx, {"totals": totals, "brands": top, "own": own,
                          "trend": {"series_brands": [r["brand"] for r in top], "buckets": trend},
                          "battle": list(battle.values()), "model_conversion": models,
                          # sheets with the most rows first (the page's "행이 많은 순")
                          "territory": sorted(territory_groups.values(), key=lambda s: (-len(s["rows"]), s["country"] or "", s["engine"])),
                          "options": {"langs": sorted({r["lang"].lower() for r in cells if r["lang"]}),
                                      "countries": sorted({r["country"] for r in cells if r["country"]})}})
