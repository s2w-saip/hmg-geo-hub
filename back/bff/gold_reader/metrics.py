"""API view models calculated from the pinned Gold cells and facts."""
from __future__ import annotations

import copy
import os
import time
from collections import defaultdict
from datetime import timedelta
from fastapi import HTTPException

from bff.gold_reader.context import AXES, BRAND_NAMES, Context, SQL, envelope, flag, limit, rank_avg, ratio, values

COUNTS = ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all",
          "rank_sum", "ranked", "top1", "top3", "fp_sum", "fp_n", "multi_answers", "multi_mentions",
          "gap_answers", "gap_base", "cit_total", "cit_total_all", "cit_m05", "cit_target", "cit_owned", "cit_owned_c",
          "t_mention", "t_recommendation", "t_comparison", "t_definition", "t_final_choice")
TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")


async def counts(ctx: Context, *, group: str | None = None, family: str = "mentions") -> list[dict]:
    b = SQL()
    where = ctx.predicate(b, population=family, perspective=True)
    group_columns = {"engine": "f.engine_key", "country": "f.geo_key", "date": "f.round_date",
                     "prompt": "f.prompt_key", "date_engine": "f.round_date,f.engine_key"}
    keys = group_columns.get(group or "", "")
    sums = ",".join(f"coalesce(sum(f.{col}),0)::bigint AS {col}" for col in COUNTS)
    # This is a distinct count over cells, never a sum of per-day distinct counts.
    sql = f"""SELECT {keys + ',' if keys else ''}{sums},
        count(DISTINCT f.prompt_key) FILTER(WHERE f.has_measured)::int AS measured_prompts,
        count(DISTINCT f.prompt_key) FILTER(WHERE f.has_mention)::int AS mentioned_prompts
        FROM gold.kpi_cell f WHERE {where} {('GROUP BY ' + keys) if keys else ''}"""
    return [dict(r) for r in await ctx.conn.fetch(sql, *b.args)]


def metric_values(c: dict) -> dict:
    return {"visibility": ratio(c.get("tracked"), c.get("answers")),
            "share_of_voice": ratio(c.get("own_mentions"), c.get("total_mentions")),
            "sentiment": ratio(c.get("sent_pos"), c.get("sent_all")),
            "position": rank_avg(c.get("rank_sum"), c.get("ranked")),
            "citation_share": ratio(c.get("cit_m05"), c.get("cit_total")),
            "target_url_rate": ratio(c.get("cit_target"), c.get("cit_total")),
            "owned_url_rate": ratio(c.get("cit_owned"), c.get("cit_total")),
            "citation_accuracy": ratio(c.get("cit_target"), c.get("cit_owned"))}


async def summary(ctx: Context) -> dict:
    mention = (await counts(ctx))[0]
    citation = (await counts(ctx, family="citations"))[0]
    data = metric_values({**mention, **{k: v for k, v in citation.items() if k.startswith("cit_")}})
    suppressed = {}
    if ctx.sf == 1:
        for key in ("target_url_rate", "owned_url_rate", "citation_accuracy"):
            data[key] = None
            suppressed[key] = "not_website_surface"
    else:
        # Answer-level rates and prompt-level counts are separate Gold measurements.
        b = SQL()
        where = ctx.predicate(b)
        rows = await ctx.conn.fetchrow(f"""SELECT
            count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible AND f.any_target)::int AS target,
            count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible AND f.any_owned)::int AS owned,
            count(DISTINCT f.prompt_key) FILTER(WHERE f.eligible)::int AS measured,
            sum(f.url_den)::bigint AS url_den,sum(f.tgt_hits)::bigint AS tgt_hits,
            sum(f.own_url_hits)::bigint AS own_hits,sum(f.tgt_own_hits)::bigint AS tgt_own_hits
            FROM gold.url_prompt_cell f WHERE {where} AND f.population_key=4""", *b.args)
        data.update(target_url_rate=ratio(rows["tgt_hits"], rows["url_den"]),
                    owned_url_rate=ratio(rows["own_hits"], rows["url_den"]),
                    citation_accuracy=ratio(rows["tgt_own_hits"], rows["own_hits"]))
    # Applied prompts belong to the catalog even when they have never been measured. Counting them reads the
    # whole catalog (12k rows, ~1 s on the global card), so only when ?parts= asks for them (none = all, B089).
    applied = None
    parts = values(ctx.q, "parts")
    if not parts or "applied" in parts:
        from bff.gold_reader.catalog import prompts
        applied = (await prompts(ctx))["meta"]["page"]["total"]
    by_funnel = None
    if flag(ctx.q, "by_funnel"):
        b = SQL()
        where = ctx.predicate(b, family="fact") + " AND f.std_in"
        by_funnel = [dict(r) for r in await ctx.conn.fetch(f"""SELECT t.code AS funnel,count(DISTINCT f.prompt_key)::int AS measured_prompts
            FROM gold.answer_fact f JOIN gold.dim_prompt p USING(prompt_key) LEFT JOIN gold.dim_taxon t ON t.taxon_key=p.funnel_key
            WHERE {where} GROUP BY t.code ORDER BY t.code IS NULL,measured_prompts DESC,t.code""", *b.args)]
    data.update(url_prompts={"measured_prompts": rows["measured"], "target_prompts": rows["target"], "owned_prompts": rows["owned"]} if ctx.sf == 2 else None,
                params={"answers": mention["answers"], "measured_prompts": mention["measured_prompts"],
                        "applied_prompts": applied,
                        "prompts_without_brand": mention["measured_prompts"]-mention["mentioned_prompts"] if ctx.selected_dates else None,
                        "measured_by_funnel": by_funnel},
                analysis_gap={"gap_answers": citation["gap_answers"], "base_answers": citation["gap_base"]})
    if not ctx.selected_dates:
        suppressed["*"] = "no_snapshot"
    return envelope(ctx, data, suppressed=suppressed)


ENGINE_MAP = {"answers": "answers", "tracked": "tracked", "multi": "multi_answers", "top1": "top1", "top3": "top3",
              "rank_sum": "rank_sum", "ranked": "ranked", "total_mentions": "total_mentions", "tracked_mentions": "own_mentions",
              "sent_mentions": "sent_all", "positive_mentions": "sent_pos", "negative_mentions": "sent_neg",
              "cit_total": "cit_total", "cit_owned": "cit_m05"}


async def engines(ctx: Context) -> dict:
    codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
    citation = {r["engine_key"]:r for r in await counts(ctx, group="engine", family="citations")}
    rows = [{"engine": codes[r["engine_key"]], **{k: (citation.get(r["engine_key"], {}).get(v, 0) if k.startswith("cit_") else r[v]) for k, v in ENGINE_MAP.items()}}
            for r in await counts(ctx, group="engine")]
    total = {k: sum(r[k] for r in rows) for k in ENGINE_MAP}
    consistency = {}
    for key, num, den in (("visibility", "tracked", "answers"), ("share_of_voice", "tracked_mentions", "total_mentions"),
                          ("sentiment", "positive_mentions", "sent_mentions"), ("position", "rank_sum", "ranked"),
                          ("citation_share", "cit_owned", "cit_total")):
        nums = [r[num] / r[den] for r in rows if r[den]]
        consistency[key] = round(100 * min(nums) / max(nums), 1) if len(nums) >= 2 and max(nums) else None
    return envelope(ctx, {"rows": sorted(rows, key=lambda r: r["engine"]), "total": total, "engine_consistency": consistency})


async def brand_rows(ctx: Context, *, by_date: bool = False, by_country: bool = False,
                     brand_keys: list[str] | None = None) -> list[dict]:
    b = SQL()
    where = ctx.predicate(b, population="mentions")
    if brand_keys:
        # compared as text, as the ?brand_key= values come
        where += f" AND f.brand_key::text=ANY({b.bind(brand_keys, 'text[]')})"
    keys = "f.round_date," if by_date else "f.geo_key," if by_country else ""
    # Aggregate per brand_key, then join the names to the result: grouping by the name too sorted every cell
    # by its text under the collation (0.6 of the 1.1 s on the Overview's brand rows). brand_key decides
    # the name and own_bit, so the groups are the same.
    rows = await ctx.conn.fetch(f"""WITH a AS (SELECT {keys}f.brand_key,
        sum(f.mention_count)::bigint AS mentions,sum(f.answers_present)::bigint AS answers,
        sum(f.rank_sum)::bigint AS rank_sum,sum(f.ranked)::bigint AS ranked,
        sum(f.s_pos)::bigint AS positive,sum(f.s_neu)::bigint AS neutral,
        sum(f.s_mix)::bigint AS mixed,sum(f.s_neg)::bigint AS negative,
        sum(f.multi_answers)::bigint AS multi_answers,sum(f.multi_mentions)::bigint AS multi_mentions,
        count(DISTINCT f.prompt_key) FILTER(WHERE f.has_brand)::int AS prompts,
        count(DISTINCT f.prompt_key) FILTER(WHERE f.has_multi)::int AS multi_prompts,
        {','.join(f'sum(f.t_{t})::bigint AS t_{t}' for t in TYPES)}
        FROM gold.brand_cell f WHERE {where} AND f.competitive GROUP BY {keys}f.brand_key)
        SELECT a.*,d.name,d.own_bit FROM a JOIN gold.dim_brand d USING(brand_key)
        ORDER BY a.mentions DESC,d.name""", *b.args)
    return [dict(r) for r in rows]


async def brands(ctx: Context) -> dict:
    c = (await counts(ctx))[0]
    rows = await brand_rows(ctx)
    own_detail = [r for r in rows if r["own_bit"] & ctx.bits]
    own = {"brand_key": own_detail[0]["brand_key"] if len(ctx.own_names) == 1 and own_detail else None,
           "name": ctx.label, "is_own": True, "rank": 0, "mentions": c["own_mentions"],
           "exposure": ratio(c["tracked"], c["answers"]), "share": ratio(c["own_mentions"], c["total_mentions"]),
           "avg_rank": rank_avg(c["rank_sum"], c["ranked"]),
           "sentiment": {k: sum(r[k] for r in own_detail) for k in ("positive", "neutral", "mixed", "negative")},
           "is_hmg_own": True, "prompts": c["mentioned_prompts"],
           "multi": {"answers": c["multi_answers"], "mentions": c["multi_mentions"], "prompts": 0},
           "types": {t: sum(r[f"t_{t}"] for r in own_detail) for t in TYPES}}
    # Multi-prompt counts are not additive; calculate them over the same cell population.
    b = SQL()
    where = ctx.predicate(b, population="mentions", perspective=True)
    own["multi"]["prompts"] = await ctx.conn.fetchval(f"SELECT count(DISTINCT f.prompt_key)::int FROM gold.kpi_cell f WHERE {where} AND f.has_multi", *b.args)
    items = [own]
    for r in rows:
        if r["own_bit"] & ctx.bits:
            continue
        items.append({"brand_key": r["brand_key"], "name": r["name"], "is_own": False, "rank": 0,
                      "mentions": r["mentions"], "exposure": ratio(r["answers"], c["answers"]),
                      "share": ratio(r["mentions"], c["total_mentions"]), "avg_rank": rank_avg(r["rank_sum"], r["ranked"]),
                      "sentiment": {k: r[k] for k in ("positive", "neutral", "mixed", "negative")},
                      "is_hmg_own": bool(r["own_bit"]), "prompts": r["prompts"],
                      "multi": {"answers": r["multi_answers"], "mentions": r["multi_mentions"], "prompts": r["multi_prompts"]},
                      "types": {t: r[f"t_{t}"] for t in TYPES}})
    items.sort(key=lambda r: (-r["mentions"], r["name"]))
    for i, row in enumerate(items, 1):
        row["rank"] = i
    top_n = min(10000, max(0, int(ctx.q.get("top_n", "10"))))
    chosen = items if flag(ctx.q, "full") else [r for r in items if r["is_own"] or r["rank"] <= top_n]
    return envelope(ctx, {"totals": {"answers": c["answers"], "mentions_total": c["total_mentions"], "brand_count": len(items)},
                          "own": {"vp_label": ctx.label, "brands": ctx.own_names, **{k: own[k] for k in ("rank", "mentions", "exposure", "share", "avg_rank")}},
                          "brands": chosen, "types_total": {t: sum(r["types"][t] for r in items) for t in TYPES},
                          "by_engine": None, "truncated": False})


async def trend(ctx: Context) -> dict:
    # A trend with no explicit range spans the published calendar, rather than a fabricated window.
    if not ctx.q.get("from") and not ctx.q.get("to"):
        ctx.selected_dates = ctx.dates[:]
    bucket = ctx.q.get("bucket", "cycle")
    dimension = ctx.q.get("dimension", "none")
    wanted = values(ctx.q, "metrics") or ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]
    if len(wanted) == 1 and "," in wanted[0]:
        wanted = wanted[0].split(",")
    def bucket_key(day):
        if bucket == "month":
            return day.replace(day=1).isoformat()
        if bucket == "week":
            return (day - timedelta(days=day.weekday())).isoformat()
        return day.isoformat()
    buckets = sorted({bucket_key(d) for d in ctx.selected_dates})
    bucket_rows = [{"key": key, "round_dates": [d.isoformat() for d in ctx.selected_dates if bucket_key(d) == key], "measured_days": None} for key in buckets]
    if dimension in {"source", "category"}:
        b = SQL()
        where = ctx.predicate(b, population="citations", perspective=True)
        if values(ctx.q,"source"):
            where += f" AND c.slug=ANY({b.bind(values(ctx.q,'source'),'text[]')})"
        rows = await ctx.conn.fetch(f"""SELECT f.round_date,s.skey,s.domain,c.slug,c.name AS category,
            sum(f.citations)::bigint AS citations FROM gold.citation_cell f JOIN gold.dim_source s USING(source_key)
            LEFT JOIN gold.dim_category c ON c.category_key=f.category_key WHERE {where}
            GROUP BY f.round_date,s.skey,s.domain,c.slug,c.name""", *b.args)
        def citation_series(dim, top):
            grouped, totals, labels, key_totals = defaultdict(int), defaultdict(int), {}, defaultdict(int)
            for r in rows:
                day = bucket_key(r["round_date"])
                key = r["skey"] if dim == "source" else r["slug"]
                totals[day] += r["citations"]
                if key is not None:
                    grouped[(day,key)] += r["citations"]
                    key_totals[key] += r["citations"]
                    labels[key] = (r["domain"] or r["skey"]) if dim == "source" else r["category"]
            # Rank by each key's total over all buckets, summed once: re-summing the (bucket, key)
            # cells per key was sources × cells (8 of the 10 s of the Citation source trend).
            keys = sorted(labels, key=lambda k:(-key_totals[k],k))[:top]
            return [{"metric": "source_share" if dim=="source" else "category_share", "kind":"ratio", "key":key,
                "label":labels[key], "points":[{"bucket":day,"ratio":ratio(grouped.get((day,key),0),totals.get(day,0)),
                "gap":not totals.get(day),"gap_reason":"no_answer" if not totals.get(day) else None} for day in buckets]} for key in keys]
        top = min(50,max(1,int(ctx.q.get("top",ctx.q.get("top_n","10")))))
        dims = []
        for spec in values(ctx.q,"dims"):
            dim = spec.split(":",1)[0].split("@",1)[0]
            if dim not in {"source","category"}:
                raise HTTPException(422,"Unsupported citation trend dimension")
            n = min(50,max(1,int(spec.rsplit("@",1)[1]))) if "@" in spec else top
            dims.append({"dimension":dim,"series":citation_series(dim,n),"meta":ctx.meta()})
        return envelope(ctx,{"bucket":bucket,"dimension":dimension,"own_label":ctx.label,"buckets":bucket_rows,
            "series":citation_series(dimension,top),"dims":dims or None})
    if dimension == "brand":
        return envelope(ctx, {"bucket": bucket, "dimension": dimension, "own_label": ctx.label, "buckets": bucket_rows,
                              "series": await brand_series(ctx, wanted, buckets, bucket_key), "dims": None})
    groups: dict[tuple[str, str | None], dict] = {}
    engine_codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
    grouping = "date_engine" if dimension == "engine" else "date"
    source_rows = await counts(ctx, group=grouping)
    cite_rows = await counts(ctx, group=grouping, family="citations")
    for row in source_rows:
        key = bucket_key(row["round_date"])
        dim = engine_codes.get(row.get("engine_key")) if dimension == "engine" else None
        target = groups.setdefault((key, dim), {k: 0 for k in COUNTS})
        for col in COUNTS:
            if not col.startswith("cit_"):
                target[col] += row[col]
    for row in cite_rows:
        key = bucket_key(row["round_date"])
        dim = engine_codes.get(row.get("engine_key")) if dimension == "engine" else None
        target = groups.setdefault((key, dim), {k: 0 for k in COUNTS})
        for col in COUNTS:
            if col.startswith("cit_"):
                target[col] += row[col]
    buckets = sorted({bucket_key(d) for d in ctx.selected_dates})
    series = []
    dims = sorted({d for _, d in groups}, key=lambda x: x or "")
    for dim in dims:
        for metric in wanted:
            points = []
            for key in buckets:
                c = groups.get((key, dim))
                val = metric_values(c).get(metric) if c else None
                points.append({"bucket": key, "rank" if metric == "position" else "ratio": val,
                               "gap": c is None, "gap_reason": "no_answer" if c is None else None,
                               "origin": "report" if ctx.card else "live", "negative": c["sent_neg"] if c and metric == "sentiment" else None})
            series.append({"metric": metric, "kind": "rank" if metric == "position" else "ratio", "key": dim,
                           "label": dim or ctx.label, "points": points})
    return envelope(ctx, {"bucket": bucket, "dimension": dimension, "own_label": ctx.label,
                          "buckets": bucket_rows,
                          "series": series, "dims": None})


async def brand_series(ctx: Context, wanted: list[str], buckets: list[str], bucket_key) -> list[dict]:
    """Brand histories must use brand cells; never duplicate the own-brand series as a rival. Only the
    asked brands are read, and the date totals are one scan of the mention cells (the Overview brand
    trend read every brand and three cell scans, two of them for series it then dropped: 5.4 s)."""
    rows = await brand_rows(ctx, by_date=True, brand_keys=values(ctx.q, "brand_key"))
    names = sorted({r["name"] for r in rows}, key=lambda n: -sum(r["mentions"] for r in rows if r["name"] == n))[:int(ctx.q.get("top_n", "10"))]
    totals = {}
    for row in await counts(ctx, group="date"):
        total = totals.setdefault(bucket_key(row["round_date"]), dict.fromkeys(COUNTS, 0))
        for column in COUNTS:
            total[column] += row[column]
    series = []
    for name in names:
        for metric in wanted:
            points = []
            for key in buckets:
                rs = [r for r in rows if r["name"] == name and bucket_key(r["round_date"]) == key]
                total = totals.get(key, {})
                n = sum(r["mentions"] for r in rs)
                v = ratio(n, total.get("total_mentions")) if metric == "share_of_voice" else ratio(sum(r["answers"] for r in rs), total.get("answers")) if metric == "visibility" else rank_avg(sum(r["rank_sum"] for r in rs), sum(r["ranked"] for r in rs)) if metric == "position" else ratio(sum(r["positive"] for r in rs), sum(r["positive"] + r["negative"] + r["neutral"] + r["mixed"] for r in rs)) if metric == "sentiment" else None
                points.append({"bucket": key, "rank" if metric == "position" else "ratio": v, "gap": not rs})
            first = next(r for r in rows if r["name"] == name)
            series.append({"metric": metric, "kind": "rank" if metric == "position" else "ratio", "key": name,
                           "label": name, "brand_key": first["brand_key"], "is_own": bool(first["own_bit"] & ctx.bits), "points": points})
    return series


async def dates(ctx: Context) -> dict:
    first = min(ctx.dates) if ctx.dates else None
    last = max(ctx.dates) if ctx.dates else None
    presets = []
    if first and last:
        for key, days in (("weekly", 7), ("biweekly", 14), ("monthly", 30), ("yearly", 365)):
            presets.append({"preset": key, "from": max(first, last - timedelta(days=days - 1)).isoformat(), "to": last.isoformat()})
    return envelope(ctx, {"surface": ctx.surface, "latest_round_date": last, "first_measured_date": first,
                          "dates": ctx.dates[:400], "dates_truncated": len(ctx.dates) > 400, "presets": presets})


# Filter options read no period: the same release builds, Gold data_version and query (less the period) give
# the same data, so it is kept across requests (the one result cache; docs/architecture "필터 옵션 캐시").
# data_version does not move when Gold reloads a copy, so the age bounds what such a read could leave.
OPTIONS_MAX_AGE_S = int(os.environ.get("HGH_FILTER_OPTIONS_CACHE_S", "600"))
OPTIONS_CACHE_SIZE = 256
PERIOD_PARAMS = ("from", "to", "cycle_offset")
_options_cache: dict[tuple, tuple[float, dict]] = {}


async def gold_versions(ctx: Context) -> tuple:
    return tuple((r["scope"], r["version"]) for r in await ctx.conn.fetch("SELECT scope,version FROM gold.data_version ORDER BY scope"))


async def options(ctx: Context) -> dict:
    versions = await gold_versions(ctx)
    key = (tuple(sorted((family, tuple(sorted(builds))) for family, builds in ctx.builds.items())), versions,
           tuple(sorted((k, v) for k, v in ctx.q.multi_items() if k not in PERIOD_PARAMS)))
    kept = _options_cache.get(key)
    if kept and time.monotonic() - kept[0] < OPTIONS_MAX_AGE_S:
        return envelope(ctx, copy.deepcopy(kept[1]))
    data, consistent = await options_data(ctx)
    # Gold reloads its tables one by one: a read that saw mixed generations is answered but not kept.
    if consistent and OPTIONS_MAX_AGE_S > 0 and await gold_versions(ctx) == versions:
        _options_cache.pop(key, None)
        if len(_options_cache) >= OPTIONS_CACHE_SIZE:
            _options_cache.pop(next(iter(_options_cache)))
        _options_cache[key] = (time.monotonic(), copy.deepcopy(data))
    return envelope(ctx, data)


async def options_data(ctx: Context) -> tuple[dict, bool]:
    """The options and whether the read was consistent: something to answer from, and no key without its
    dimension row (the sign of a table read from another generation, as in hub_storage/sync_catalog.py)."""
    b = SQL()
    where = ctx.predicate(b, family="fact", dates=False, dimensions=False, taxonomy=False)
    # Distinct keys over the facts first, codes joined to those few rows (the text DISTINCT sorted every fact).
    # Left joins so a key with no dimension row shows (orphan); the inner join's rows are the kept ones.
    found = await ctx.conn.fetch(f"""WITH k AS (SELECT DISTINCT f.bgrp,f.geo_key,f.lang_key,f.engine_key FROM gold.answer_fact f WHERE {where})
        SELECT DISTINCT k.bgrp,c.code AS country,c.kind,r.code AS area,l.code AS lang,e.code AS engine,e.is_default,
            c.geo_key IS NOT NULL AND l.lang_key IS NOT NULL AND e.engine_key IS NOT NULL AND c.hidden_standard IS FALSE AS kept,
            (k.geo_key IS NOT NULL AND c.geo_key IS NULL) OR (k.lang_key IS NOT NULL AND l.lang_key IS NULL)
            OR (k.engine_key IS NOT NULL AND e.engine_key IS NULL) OR (c.region_key IS NOT NULL AND r.region_key IS NULL) AS orphan
        FROM k LEFT JOIN gold.dim_country c ON c.geo_key=k.geo_key LEFT JOIN gold.dim_lang l ON l.lang_key=k.lang_key
        LEFT JOIN gold.dim_engine e ON e.engine_key=k.engine_key LEFT JOIN gold.dim_region r ON r.region_key=c.region_key""", *b.args)
    rows = [r for r in found if r["kept"]]
    consistent = bool(rows) and not any(r["orphan"] for r in found)
    geo = sorted({(name, r["country"], r["lang"].lower() if r["lang"] else None)
                  for r in rows for bit, name in BRAND_NAMES.items() if r["bgrp"] & bit}, key=lambda t: tuple(v or "" for v in t))
    catalog = None
    if ctx.sf != 2 and not flag(ctx.q, "geo_only"):
        taxa = await ctx.conn.fetch("""SELECT t.*,p.code AS parent_code,t.parent_key IS NOT NULL AND p.taxon_key IS NULL AS orphan
            FROM gold.dim_taxon t LEFT JOIN gold.dim_taxon p ON p.taxon_key=t.parent_key""")
        catalog = {axis: [{"code": r["code"], "parent_code": r["parent_code"]} for r in taxa if r["axis"] == ("presence" if axis == "brand_presence" else axis)] for axis in AXES}
        # Actual catalog combinations, not a Cartesian product of taxonomy values.
        b = SQL()
        build = b.bind(ctx.builds.get("fact", []), "bigint[]")
        # Distinct taxon keys over the catalog first (280k entries -> ~460), codes joined after; ordered as the
        # text DISTINCT's sort returned them. The orphan flag is one value over all rows, so DISTINCT keeps its rows.
        joins = " ".join(f"LEFT JOIN gold.dim_taxon {axis} ON {axis}.taxon_key=k.{col}" for axis, col in AXES.items())
        orphan = " OR ".join(f"(k.{col} IS NOT NULL AND {axis}.taxon_key IS NULL)" for axis, col in AXES.items())
        combinations = await ctx.conn.fetch(f"""WITH k AS (SELECT DISTINCT ce.brand_bit,{','.join(f'ce.{col}' for col in AXES.values())}
            FROM gold.catalog_entry ce WHERE ce.build_id=ANY({build}) AND (ce.brand_bit & {b.bind(ctx.bits | 8)})<>0)
            SELECT DISTINCT k.brand_bit,{','.join(f'{a}.code AS {a}' for a in AXES)},bool_or({orphan}) OVER () AS orphan FROM k {joins}
            ORDER BY k.brand_bit,{','.join(AXES)}""", *b.args)
        catalog["rows"] = [{"brand": BRAND_NAMES.get(r["brand_bit"]), **{a: r[a] for a in AXES}} for r in combinations]
        consistent = consistent and bool(taxa) and not any(r["orphan"] for r in (*taxa, *combinations))
        if ctx.sf == 3:
            joins = " ".join(f"LEFT JOIN gold.dim_taxon {axis} ON {axis}.taxon_key=p.{col}" for axis,col in AXES.items())
            orphan = " OR ".join(f"(p.{col} IS NOT NULL AND {axis}.taxon_key IS NULL)" for axis, col in AXES.items())
            combinations = await ctx.conn.fetch(f"""SELECT DISTINCT {','.join(f'{a}.code AS {a}' for a in AXES)},bool_or({orphan}) OVER () AS orphan
                FROM gold.dim_prompt p {joins} WHERE p.project_key=$1""",ctx.project_key)
            catalog["rows"] = [{"brand":None,**{a: r[a] for a in AXES}} for r in combinations]
            consistent = consistent and not any(r["orphan"] for r in combinations)
            for axis in AXES:
                present = {r[axis] for r in combinations if r[axis] is not None}
                catalog[axis] = [r for r in catalog[axis] if r["code"] in present]
        consistent = consistent and bool(catalog["rows"])
    custom_fields = None
    if ctx.sf == 3 and not flag(ctx.q,"geo_only"):
        custom_fields = [dict(r) for r in await ctx.conn.fetch("""SELECT cf.field_id,cf.label,
            coalesce(array_agg(DISTINCT v.value ORDER BY v.value) FILTER(WHERE v.value IS NOT NULL),'{}') AS values
            FROM gold.dim_custom_field cf LEFT JOIN gold.prompt_custom_value v USING(field_id)
            WHERE cf.project_key=$1 AND NOT cf.archived GROUP BY cf.field_id,cf.label ORDER BY cf.label,cf.field_id""",ctx.project_key)]
    source_categories = None
    if "source_categories" in values(ctx.q,"include"):
        b = SQL()
        where = ctx.predicate(b,population="citations",perspective=True,dates=False,dimensions=False,taxonomy=False)
        found = await ctx.conn.fetch(f"""SELECT DISTINCT c.slug,c.name,c.ord,c.category_key IS NOT NULL AS kept,
            f.category_key IS NOT NULL AND c.category_key IS NULL AS orphan
            FROM gold.citation_cell f LEFT JOIN gold.dim_category c ON c.category_key=f.category_key WHERE {where} ORDER BY c.ord,c.slug""",*b.args)
        source_categories = [{"slug": r["slug"], "name": r["name"], "ord": r["ord"]} for r in found if r["kept"]]
        consistent = consistent and not any(r["orphan"] for r in found)
    return {"geo_matrix": [{"brand": b, "region": c, "lang": l} for b, c, l in geo],
            "regions": [{"code": c, "area": next(r["area"] for r in rows if r["country"] == c), "kind": next(r["kind"] for r in rows if r["country"] == c)} for c in sorted({r["country"] for r in rows})],
            "languages": sorted({r["lang"].lower() for r in rows if r["lang"]}),
            "engines": [{"code": code, "is_default": next(r["is_default"] for r in rows if r["engine"] == code)} for code in sorted({r["engine"] for r in rows})],
            "catalog": catalog, "source_categories": source_categories, "custom_fields": custom_fields}, consistent
