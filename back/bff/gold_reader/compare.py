"""Compare real Gold measurements and cycle ledgers with the existing KPI rules."""
from copy import copy
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from bff.gold_reader import compare_logic as logic
from bff.gold_reader.context import envelope, values
from bff.gold_reader.metrics import COUNTS, counts, metric_values


async def read(ctx):
    kind = ctx.q.get("kind", "window")
    if kind not in {"window", "calendarMonth", "calendarWeek", "cycle"}:
        raise HTTPException(422, "Unknown comparison kind")
    end = date.fromisoformat(ctx.q["to"]) if ctx.q.get("to") else max(ctx.dates) if ctx.dates else None
    window = None
    try:
        if end:
            start = date.fromisoformat(ctx.q["from"]) if ctx.q.get("from") else None
            if kind == "cycle":
                latest = ctx.dates[0] if ctx.dates else None
                window = logic.cycle_windows(latest, ctx.dates[1] if len(ctx.dates) > 1 else None) if latest else None
            elif start:
                window = logic.range_windows(kind, start, end)
            elif kind == "window":
                days = int(ctx.q.get("days", "30"))
                if days not in {7, 14, 30, 365}:
                    raise ValueError()
                window = logic.resolve_windows(end, days)
            elif kind == "calendarMonth":
                window = logic.calendar_months_of(end)
            else:
                window = logic.calendar_weeks_of(end)
            if window is None:
                raise ValueError()
    except (ValueError, OverflowError):
        raise HTTPException(422, "Invalid comparison period") from None
    metrics = list(dict.fromkeys(values(ctx.q, "metrics"))) or list(logic.METRICS)
    if any(m not in logic.METRIC_FAMILY for m in metrics):
        raise HTTPException(422, "Unknown comparison metric")
    sums = {lab: dict.fromkeys(COUNTS, 0) for lab in ("prev", "cur", "before")}
    # answers of the citation population: the per-answer citation rate divides within one population
    # (2026-10-29 metric review R3: the mention population's answers made the month line ▲70.0 % for +52.9 %)
    cit_base = dict.fromkeys(sums, 0)
    ledgers = {(lab, family): logic.Ledger() for lab in sums for family in ("mention", "citation")}
    first = {"mention": None, "citation": None}
    scan_ctx = copy(ctx)
    scan_ctx.selected_dates = [d for d in ctx.dates if window and window.label_of(d)]
    for family, population in (("mention", "mentions"), ("citation", "citations")):
        cycles = await ctx.conn.fetch("""SELECT c.*,EXISTS(SELECT 1 FROM gold.release_item ri
            WHERE ri.release_id=$4 AND ri.family='fact' AND ri.state='ready'
              AND ri.slice_key='cyc:'||c.cyc_key::text) AS in_release
            FROM gold.dim_cycle c WHERE c.surface=$1
              AND ($2::smallint IS NULL OR c.project_key=$2)
              AND (c.view_date IS NULL OR c.view_date<=$3::date)
              AND (c.servable OR c.status<>0)""", ctx.sf, ctx.project_key,
              datetime.now(ZoneInfo("Asia/Seoul")).date(), ctx.release["release_id"])
        published = {lab: set() for lab in sums}
        for c in cycles:
            if c["hidden_scope"] in ((1, 3) if family == "mention" else (1, 2)):
                continue
            pub = c["servable"] and c["in_release"]
            day = c["round_date"]
            if pub and (first[family] is None or day < first[family]):
                first[family] = day
            lab = window.label_of(day) if window else None
            if lab:
                ledger = ledgers[(lab, family)]
                planned = c["expected_units"] or 0
                ledger.planned_units += planned
                if pub:
                    published[lab].add(day)
                else:
                    ledger.missing_units += planned
        for lab in sums:
            ledgers[(lab, family)].published_cycles = len(published[lab])
            ledgers[(lab, family)].first_published = first[family]
        for row in await counts(scan_ctx, group="date", family=population):
            lab = window.label_of(row["round_date"])
            for key in COUNTS:
                if key.startswith("cit_") == (family == "citation"):
                    sums[lab][key] += row[key]
            if family == "citation":
                cit_base[lab] += row["gap_base"]
            if row["answers" if family == "mention" else "cit_total"] > 0:
                ledgers[(lab, family)].data_cycles += 1
    items, suppressed = [], {}
    def pairs(row, base):
        return {**metric_values(row), "mentions_per_answer": {"num": row["own_mentions"], "den": row["answers"]},
                "citations_per_answer": {"num": row["cit_total"], "den": base}}
    prev, cur = pairs(sums["prev"], cit_base["prev"]), pairs(sums["cur"], cit_base["cur"])
    for metric in metrics:
        family, unit = logic.METRIC_FAMILY[metric], logic.METRIC_UNIT[metric]
        lp, lc = ledgers[("prev", family)], ledgers[("cur", family)]
        reason = logic.suppression_of(window, lp, lc, before=ledgers[("before", family)]) if window else "no_prev"
        p, c = prev[metric], cur[metric]
        if metric == "position":
            p, c = p or {"sum": 0, "count": 0}, c or {"sum": 0, "count": 0}
        def pair(v):
            return (v["sum"], v["count"]) if v and "sum" in v else (v["num"], v["den"]) if v else (0, 0)
        items.append({"metric": metric, "family": family, "unit": unit, "prev": p, "cur": c,
            "delta": None if reason else logic.delta_of(unit, pair(p), pair(c)),
            "suppressed": bool(reason), "reason": reason, "cycles_prev": lp.published_cycles,
            "cycles_cur": lc.published_cycles, "planned_prev": lp.planned_units, "planned_cur": lc.planned_units,
            "missing_share_prev": lp.missing_share, "missing_share_cur": lc.missing_share})
        if reason:
            suppressed[metric] = reason
    result = envelope(scan_ctx, items, mode="cumulative", suppressed=suppressed)
    def span(s):
        return {"lo": s.lo, "hi": s.hi} if s else None
    result["meta"]["source"]["ledger"] = "fleet"
    result["meta"]["compare"] = {"kind": kind, "windows": {"prev": span(window.prev), "cur": span(window.cur),
        "before": span(window.before)} if window else None, "first_published": first["mention"],
        "first_published_citation": first["citation"]}
    return result
