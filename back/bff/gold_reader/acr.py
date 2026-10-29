"""ACR numerators and denominators come from published Gold ACR builds."""
from __future__ import annotations

from collections import defaultdict
from copy import copy

from fastapi import HTTPException

from bff.gold_reader.context import Context, SQL, envelope, flag, ratio

TREND_CYCLES = 12
CELL_JOINS = """JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key JOIN gold.dim_engine e ON e.engine_key=f.engine_key
        JOIN gold.dim_country c ON c.geo_key=f.geo_key JOIN gold.dim_lang l ON l.lang_key=f.lang_key"""
# one row order for a sheet, whichever read builds it (funnel/acr or funnel/acr/territory)
CELL_ORDER = "ORDER BY f.round_date,f.acr_cell_key"
# Gold's no-brand key "(이름 없음)": the winner of the repetitions without a single pick and a shortlist entry its
# entity facts never pick (asked upstream, 2026-10-29) — no rival in the head-to-head, its wins are no pick
NO_BRAND = 0


def cell_where(ctx: Context, b: SQL) -> str:
    where = ctx.predicate(b, family="acr") + " AND f.acr_in"
    return where + " AND f.is_rep" if ctx.card else where


def sheet_groups(cells: list[dict]) -> list:
    """The 분포 sheets (country × engine) with their cells by prompt, the sheets with the most prompts first."""
    groups: dict = {}
    for c in cells:
        groups.setdefault((c["country"], c["engine"]), {}).setdefault(c["prompt_id"], []).append(c)
    return sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0][0] or "", kv[0][1]))


async def level1_rows(ctx: Context, keys: list) -> dict:
    """The brand (level-1) entity rows of these cells, by cell."""
    rows_by_cell = defaultdict(list)
    if keys:
        for r in await ctx.conn.fetch("""SELECT f.acr_cell_key,f.level,f.choice,f.appearance,f.own_bit,b.name AS brand FROM gold.acr_entity_fact f
            LEFT JOIN gold.dim_brand b USING(brand_key)
            WHERE f.build_id=ANY($1::bigint[]) AND f.acr_cell_key=ANY($2::int[]) AND f.keep AND f.level=1""", ctx.builds.get("acr", []), keys):
            rows_by_cell[r["acr_cell_key"]].append(dict(r))
    return rows_by_cell


def own_sums(rows, key) -> dict:
    """Σ own choice and Σ own appearance per (country, engine, prompt) of level-1 rows with a brand: `key(row)` gives
    the row's triple, None to skip it."""
    out: dict = defaultdict(lambda: [0, 0])
    for r in rows:
        k = key(r)
        if k is not None:
            out[k][0] += r["choice"] or 0
            out[k][1] += r["appearance"] or 0
    return out


async def head_to_head(ctx: Context, where: str, args: list) -> dict:
    """결선 맞대결 (2026-10-29): per engine and rival, the repetitions whose shortlist holds 당사 and the rival, and
    how many 당사 and the rival won. acr_iter_fact keeps about one repetition per cell, so this is a sample of the
    repetitions (`sample`, said on the card)."""
    rows = await ctx.conn.fetch(f"""WITH c AS (SELECT f.build_id,f.acr_cell_key,e.code AS engine FROM gold.acr_cell_fact f
              JOIN gold.dim_engine e ON e.engine_key=f.engine_key WHERE {where}),
          it AS (SELECT c.engine,i.build_id,i.acr_cell_key,i.iter_no,w.name AS winner,coalesce((w.own_bit & {ctx.bits})<>0,false) AS own_won
              FROM c JOIN gold.acr_iter_fact i ON i.build_id=c.build_id AND i.acr_cell_key=c.acr_cell_key
              LEFT JOIN gold.dim_brand w ON w.brand_key=i.winner_brand_key AND w.brand_key<>{NO_BRAND}),
          sl AS (SELECT DISTINCT s.build_id,s.acr_cell_key,s.iter_no,b.name,(b.own_bit & {ctx.bits})<>0 AS own
              FROM c JOIN gold.acr_iter_shortlist s ON s.build_id=c.build_id AND s.acr_cell_key=c.acr_cell_key AND s.level=1
              JOIN gold.dim_brand b ON b.brand_key=s.brand_key AND b.brand_key<>{NO_BRAND} AND coalesce(b.name,'')<>'')
        SELECT it.engine,r.name AS brand,count(*) AS iterations,count(*) FILTER (WHERE it.own_won) AS own_wins,
          count(*) FILTER (WHERE it.winner=r.name) AS rival_wins
        FROM it JOIN sl r ON r.build_id=it.build_id AND r.acr_cell_key=it.acr_cell_key AND r.iter_no=it.iter_no AND NOT r.own
        WHERE EXISTS (SELECT 1 FROM sl o WHERE o.build_id=it.build_id AND o.acr_cell_key=it.acr_cell_key AND o.iter_no=it.iter_no AND o.own)
        GROUP BY 1,2""", *args)
    sample = await ctx.conn.fetchrow(f"""SELECT count(*) AS iterations,count(DISTINCT (i.build_id,i.acr_cell_key)) AS cells
        FROM gold.acr_cell_fact f JOIN gold.acr_iter_fact i ON i.build_id=f.build_id AND i.acr_cell_key=f.acr_cell_key
        WHERE {where}""", *args)
    return {"sample": {"iterations": sample["iterations"], "cells": sample["cells"]},
            "rows": [{"engine": r["engine"], "brand": r["brand"], "iterations": r["iterations"], "own_wins": r["own_wins"],
                      "rival_wins": r["rival_wins"]} for r in sorted(rows, key=lambda r: (r["engine"], -r["iterations"], r["brand"]))]}


def territory_sheets(ctx: Context, sheets: list, rows_by_cell: dict, with_rows, own: dict) -> list[dict]:
    """The 분포 sheets of `sheet_groups`; every sheet carries its row count and its rows when `with_rows(index)`. A row
    is a prompt: its cells in the read window summed (a round's re-measurements and a period's rounds; 2026-10-29: one
    question showed once per cell, up to 20 rows). Every sheet also counts 당사's state in its rows from `own`
    (`own_sums`), as the 분포 rows read it — picked (Σ own choice > 0), listed (a candidate never picked: Σ own
    appearance > 0) or absent — for the renewal page's 후보 → 선택 전환 card (2026-10-29)."""
    out = []
    for i, ((country, engine), prompts) in enumerate(sheets):
        states = {"pick": 0, "listed": 0, "absent": 0}
        for prompt_id in prompts:
            choice, appearance = own.get((country, engine, prompt_id), (0, 0))
            states["pick" if choice > 0 else "listed" if appearance > 0 else "absent"] += 1
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
        out.append({"country": country, "engine": engine, "row_count": len(prompts), "states": states, "rows": rows})
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
    """{round_date: Σvalid_acr} and the level-1 picks per round and brand over `days`, aggregated in the database
    (picks only, summed per brand key before the names join: 0.33 → 0.18 s, 2026-10-29)."""
    tctx = copy(ctx)
    tctx.selected_dates = days
    b = SQL()
    where = tctx.predicate(b, family="acr") + " AND f.acr_in" + (" AND f.is_rep" if ctx.card else "")
    den = {r["round_date"]: r["den"] for r in await ctx.conn.fetch(f"""SELECT f.round_date,sum(f.valid_acr)::bigint AS den
        FROM gold.acr_cell_fact f WHERE {where} GROUP BY f.round_date""", *b.args)}
    picks = [dict(r) for r in await ctx.conn.fetch(f"""SELECT t.round_date,br.name AS brand,coalesce(br.own_bit,0) AS own_bit,t.choice
        FROM (SELECT f.round_date,e.brand_key,sum(e.choice)::bigint AS choice
              FROM gold.acr_cell_fact f JOIN gold.acr_entity_fact e ON e.build_id=f.build_id AND e.acr_cell_key=f.acr_cell_key
              WHERE {where} AND e.keep AND e.level=1 AND e.choice>0 GROUP BY 1,2) t
        JOIN gold.dim_brand br ON br.brand_key=t.brand_key""", *b.args)]
    return den, picks


async def read(ctx: Context) -> dict:
    # territory_rows=first: only the first sheet carries its rows (the renewal page reads the others one at a time
    # from funnel/acr/territory; all sheets' rows were 94% of its answer, 2026-10-29)
    territory_rows = ctx.q.get("territory_rows", "all")
    if territory_rows not in ("all", "first"):
        raise HTTPException(422, "territory_rows must be all or first")
    b = SQL()
    where = cell_where(ctx, b)
    cells = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.acr_cell_key,f.prompt_key,f.engine_key,f.geo_key,f.valid_acr,p.prompt_id,
        p.text AS prompt_text,e.code AS engine,c.code AS country,l.code AS lang FROM gold.acr_cell_fact f {CELL_JOINS}
        WHERE {where} {CELL_ORDER}""", *b.args)]
    totals = {"prompt_runs": len(cells), "prompts": len({r["prompt_key"] for r in cells}),
              "iterations": sum(r["valid_acr"] or 0 for r in cells), "engines": sorted({r["engine"] for r in cells}),
              "catalog_acr_prompts": None}
    # The brand, 당사, battle, model and sheet state figures are summed in the database, the brands per prompt, engine
    # and country (2026-10-29: the read fetched every entity row of its cells, 130k in a snapshot and 660k in a month)
    entities = """gold.acr_cell_fact f JOIN gold.acr_entity_fact x ON x.build_id=f.build_id AND x.acr_cell_key=f.acr_cell_key AND x.keep"""
    pairs, own_cells, model_rows = [], 0, []
    if cells:
        pairs = [dict(r) for r in await ctx.conn.fetch(f"""SELECT f.prompt_key,f.engine_key,f.geo_key,br.name AS brand,
            bool_or((x.own_bit & {ctx.bits})<>0) AS is_ours,coalesce(sum(x.choice),0)::bigint AS choice,
            coalesce(sum(x.appearance),0)::bigint AS appearance,count(DISTINCT x.acr_cell_key) FILTER (WHERE x.appearance<>0) AS cells
            FROM {entities} AND x.level=1 JOIN gold.dim_brand br ON br.brand_key=x.brand_key
            WHERE {where} AND coalesce(br.name,'')<>'' GROUP BY 1,2,3,4""", *b.args)]
        own_cells = await ctx.conn.fetchval(f"""SELECT count(DISTINCT x.acr_cell_key) FROM {entities} AND x.level=1
            AND (x.own_bit & {ctx.bits})<>0 AND x.appearance<>0 WHERE {where}""", *b.args)
        model_rows = [dict(r) for r in await ctx.conn.fetch(f"""SELECT x.entity_key,en.rep_name AS model,parent.name AS parent_brand,
            coalesce(bit_or(parent.own_bit),0) AS own_bit,coalesce(sum(x.choice),0)::bigint AS choice,
            coalesce(sum(f.valid_acr),0)::bigint AS den,count(*) AS cells
            FROM {entities} AND x.level=2 AND x.appearance<>0 JOIN gold.dim_entity en ON en.entity_key=x.entity_key
            LEFT JOIN gold.dim_brand parent ON parent.brand_key=x.parent_brand_key
            WHERE {where} AND coalesce(en.rep_name,'')<>'' GROUP BY 1,2,3""", *b.args)]
    brand_groups: dict = {}
    for r in pairs:
        g = brand_groups.setdefault(r["brand"], {"brand": r["brand"], "is_ours": r["is_ours"], "choice": 0, "appearance": 0, "cells": 0})
        g["choice"] += r["choice"]
        g["appearance"] += r["appearance"]
        g["cells"] += r["cells"]
    brands = []
    for r in brand_groups.values():
        brands.append({"brand": r["brand"], "is_ours": r["is_ours"], "choice": r["choice"], "appearance": r["appearance"],
                       "cells": r["cells"], "choice_share": ratio(r["choice"], totals["iterations"]),
                       "coverage": ratio(r["cells"], totals["prompt_runs"])})
    brands.sort(key=lambda r: (-r["choice"], -r["appearance"], r["brand"]))
    # 당사 = every own brand of the perspective, wherever the page shows it (the total, its brands, its standing
    # and its trend), beyond the brand table's top (2026-10-29 metric review R1: Genesis was left out).
    own_rows = [r for r in brands if r["is_ours"]]
    own_choice = sum(r["choice"] for r in own_rows)
    chosen_rivals = [r for r in brands if not r["is_ours"] and r["choice"]]
    own = {"choice": own_choice, "appearance": sum(r["appearance"] for r in own_rows), "cells": own_cells,
           "choice_share": ratio(own_choice, totals["iterations"]), "coverage": ratio(own_cells, totals["prompt_runs"]),
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
    # a battle row per prompt with a pick, a cell per engine, in the order of their first cells (CELL_ORDER)
    prompt_of = {c["prompt_key"]: c["prompt_id"] for c in cells}
    engine_of = {c["engine_key"]: c["engine"] for c in cells}
    country_of = {c["geo_key"]: c["country"] for c in cells}
    first: dict = {}
    for i, c in enumerate(cells):
        first.setdefault((c["prompt_id"], c["engine"]), i)
        first.setdefault(c["prompt_id"], c)
    battle_groups = defaultdict(lambda: defaultdict(int))
    for r in pairs:
        if r["choice"]:
            battle_groups[(prompt_of[r["prompt_key"]], engine_of[r["engine_key"]])][r["brand"]] += r["choice"]
    battle = {}
    for prompt, engine in sorted(battle_groups, key=lambda k: first[k]):
        choices = battle_groups[(prompt, engine)]
        winner = sorted(choices, key=lambda n: (-choices[n], n))[0]
        row = battle.setdefault(prompt, {"prompt_id": str(prompt), "prompt_text": first[prompt]["prompt_text"], "cells": []})
        row["cells"].append({"engine": engine, "winner_brand": winner,
                             "winner_is_ours": brand_groups[winner]["is_ours"], "choice": choices[winner]})
    # A model's conversion (the contract's AcrModelRow): its final picks over the repetitions of the cells it was a
    # candidate in, from every repetition's level-2 row; the models picked at least once, best first, model_limit of
    # them (2026-10-29 metric review R5: one representative repetition per cell, ~1/10 of the picks, every model).
    chosen_models = sorted((m for m in model_rows if m["choice"] > 0 and m["den"] > 0),
                           key=lambda m: (-m["choice"] / m["den"], -m["choice"], m["model"], m["parent_brand"] or "", m["entity_key"]))
    models = [{"brand": m["parent_brand"], "model": m["model"], "is_ours": bool(m["own_bit"] & ctx.bits),
               "conversion": ratio(m["choice"], m["den"]), "cells": m["cells"], "top1": m["choice"]}
              for m in chosen_models[:max(1, min(50, int(ctx.q.get("model_limit", "12"))))]]
    sheets = sheet_groups(cells)
    with_rows = (lambda i: True) if territory_rows == "all" else (lambda i: i == 0)
    rows_by_cell = await level1_rows(ctx, [c["acr_cell_key"] for i, (_, prompts) in enumerate(sheets) if with_rows(i)
                                           for prompt_cells in prompts.values() for c in prompt_cells])
    own_by_prompt = own_sums(pairs, lambda r: (country_of[r["geo_key"]], engine_of[r["engine_key"]], prompt_of[r["prompt_key"]])
                             if r["is_ours"] else None)
    # 결선 맞대결 on request (the renewal page): one more statement over the repetitions
    duels = await head_to_head(ctx, where, b.args) if cells and flag(ctx.q, "include_head_to_head") else None
    return envelope(ctx, {"totals": totals, "brands": top, "own": own,
                          "trend": {"series_brands": [r["brand"] for r in top], "buckets": trend},
                          "battle": list(battle.values()), "model_conversion": models,
                          "territory": territory_sheets(ctx, sheets, rows_by_cell, with_rows, own_by_prompt), "head_to_head": duels,
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
    rows_by_cell = await level1_rows(ctx, [c["acr_cell_key"] for c in cells])
    cell_of = {c["acr_cell_key"]: c for c in cells}
    own = own_sums((r for rs in rows_by_cell.values() for r in rs),
                   lambda r: (cell_of[r["acr_cell_key"]]["country"], cell_of[r["acr_cell_key"]]["engine"], cell_of[r["acr_cell_key"]]["prompt_id"])
                   if r["brand"] and r["own_bit"] & ctx.bits else None)
    sheets = territory_sheets(ctx, sheet_groups(cells), rows_by_cell, lambda i: True, own)
    return envelope(ctx, {"sheet": sheets[0] if sheets else None})
