"""ACR numerators and denominators come from published Gold ACR builds."""
from __future__ import annotations

from collections import defaultdict
from copy import copy

from fastapi import HTTPException

from bff.gold_reader.context import Context, SQL, envelope, ratio

TREND_CYCLES = 12
CELL_JOINS = """JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key"""
# one row order for a sheet, whichever read builds it (funnel/acr or funnel/acr/territory)
CELL_ORDER = "ORDER BY f.round_date,f.acr_cell_key"


def cell_where(ctx: Context, b: SQL) -> str:
    where = ctx.predicate(b, family="acr") + " AND f.acr_in"
    return where + " AND f.is_rep" if ctx.card else where


def territory_sheets(ctx: Context, cells: list[dict], rows_by_cell: dict, with_rows) -> list[dict]:
    """The 분포 sheets (country × engine), the sheets with the most rows first; every sheet carries its row count,
    and its rows when `with_rows(index)`. A row is a prompt: its cells in the read window summed (a round's
    re-measurements and a period's rounds; 2026-10-29: one question showed once per cell, up to 20 rows)."""
    groups: dict = {}
    for c in cells:
        groups.setdefault((c["country"], c["engine"]), {}).setdefault(c["prompt_id"], []).append(c)
    ordered = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0][0] or "", kv[0][1]))
    out = []
    for i, ((country, engine), prompts) in enumerate(ordered):
        rows = []
        for prompt_id, prompt_cells in prompts.items() if with_rows(i) else ():
            by_brand: dict = {}
            for c in prompt_cells:
                for r in rows_by_cell[c["acr_cell_key"]]:
                    if r["level"] != 1 or not r["brand"]:
                        continue
                    e = by_brand.setdefault(r["brand"], {"brand": r["brand"], "choice": 0, "appearance": 0, "is_ours": bool(r["own_bit"] & ctx.bits)})
                    e["choice"] += r["choice"] or 0
                    e["appearance"] += r["appearance"] or 0
            # the sheet's bar and its 최빈 column read the brands most picked first (R5)
            rows.append({"prompt_id": str(prompt_id), "prompt_text": prompt_cells[0]["prompt_text"],
                         "valid_acr": sum(c["valid_acr"] or 0 for c in prompt_cells), "cells": len(prompt_cells),
                         "entries": sorted(by_brand.values(), key=lambda e: (-e["choice"], e["brand"]))})
        out.append({"country": country, "engine": engine, "row_count": len(prompts), "rows": rows})
    return out


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
    # territory_rows=first: only the first sheet carries its rows (the renewal page reads the others one at a time
    # from funnel/acr/territory; all sheets' rows were 94% of its answer, 2026-10-29)
    territory_rows = ctx.q.get("territory_rows", "all")
    if territory_rows not in ("all", "first"):
        raise HTTPException(422, "territory_rows must be all or first")
    b = SQL()
    where = cell_where(ctx, b)
    cells = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.*,p.prompt_id,p.text AS prompt_text,e.code AS engine,
        c.code AS country,l.code AS lang FROM gold.acr_cell_fact f {CELL_JOINS}
        WHERE {where} {CELL_ORDER}""", *b.args)]
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
    return envelope(ctx, {"totals": totals, "brands": top, "own": own,
                          "trend": {"series_brands": [r["brand"] for r in top], "buckets": trend},
                          "battle": list(battle.values()), "model_conversion": models,
                          "territory": territory_sheets(ctx, cells, rows_by_cell, lambda i: territory_rows == "all" or i == 0),
                          "options": {"langs": sorted({r["lang"].lower() for r in cells if r["lang"]}),
                                      "countries": sorted({r["country"] for r in cells if r["country"]})}})


async def territory(ctx: Context) -> dict:
    """funnel/acr/territory: the one 분포 sheet sheet_country × sheet_engine (sheet_country empty = the cells of no
    country) under the read's filters, as funnel/acr builds it; null when the filters leave it no cell."""
    engine = ctx.q.get("sheet_engine")
    if not engine:
        raise HTTPException(422, "sheet_engine is required")
    b = SQL()
    where = cell_where(ctx, b) + f" AND e.code={b.bind(engine)} AND c.code IS NOT DISTINCT FROM {b.bind(ctx.q.get('sheet_country') or None, 'text')}"
    cells = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.acr_cell_key,f.valid_acr,p.prompt_id,p.text AS prompt_text,
        e.code AS engine,c.code AS country FROM gold.acr_cell_fact f {CELL_JOINS}
        WHERE {where} {CELL_ORDER}""", *b.args)]
    rows_by_cell = defaultdict(list)
    if cells:
        for r in await ctx.conn.fetch("""SELECT f.acr_cell_key,f.level,f.choice,f.appearance,f.own_bit,b.name AS brand FROM gold.acr_entity_fact f
            LEFT JOIN gold.dim_brand b USING(brand_key)
            WHERE f.build_id=ANY($1::bigint[]) AND f.acr_cell_key=ANY($2::int[]) AND f.keep AND f.level=1""",
                ctx.builds.get("acr", []), [c["acr_cell_key"] for c in cells]):
            rows_by_cell[r["acr_cell_key"]].append(dict(r))
    sheets = territory_sheets(ctx, cells, rows_by_cell, lambda i: True)
    return envelope(ctx, {"sheet": sheets[0] if sheets else None})
