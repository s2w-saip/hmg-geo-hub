"""API view models: the /v1 reads' shapes over the metric layer's counts (data_server.metrics, 2026-11-06 T7). Nothing here reads
upstream's precomputed cells: the definitions are the BFF's."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from fastapi import HTTPException

from data_server.gold_reader.context import AXES, BRAND_NAMES, Context, SQL, envelope, flag, values
from data_server.metrics import compute
from data_server.metrics.catalog import MONITORING
from data_server.metrics.formulas import engine_consistency
from data_server.metrics.gold_rows import metric_source

# answers · tracked are 대표 답변's, the AI 노출률's denominator and numerator; answers_mon the monitoring answers every other
# 언급 지표 divides by (SSOT 공통 조건, D-15). rank_sum · ranked · top1 · top3 are the text order (SSOT, D-16).
COUNTS = ("answers", "tracked", "answers_mon", "tracked_mon", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all",
          "rank_sum", "ranked", "top1", "top3", "fp_sum", "fp_n", "multi_answers", "multi_mentions",
          "gap_answers", "gap_base", "cit_total", "cit_total_all", "cit_m05", "cit_target", "cit_owned", "cit_owned_c",
          "t_mention", "t_recommendation", "t_comparison", "t_definition", "t_final_choice")
TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")


GROUP_KEYS = {"": (), "engine": ("engine_key",), "country": ("geo_key",), "date": ("round_date",), "prompt": ("prompt_key",),
              "date_engine": ("round_date", "engine_key")}


def _sorted(rows: list[dict], keys: tuple[str, ...]) -> list[dict]:
    """Rows in key order: the geography lists its countries in it."""
    return sorted(rows, key=lambda r: tuple((r[k] is None, r[k]) for k in keys))


def _mention_row(r: dict, keys: tuple[str, ...]) -> dict:
    return {**dict.fromkeys(COUNTS, 0), **{k: r[k] for k in keys}, "answers": r["rep_answers"], "tracked": r["rep_tracked"], "answers_mon": r["answers"], "tracked_mon": r["tracked"],
            **{k: r[k] for k in ("own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked", "top1", "top3",
                                 "multi_answers", "multi_mentions")},
            "fp_sum": r["rank_sum"], "fp_n": r["ranked"], **{k: r[k] for k in ("measured_prompts", "mentioned_prompts") if k in r}}


def _citation_row(r: dict, keys: tuple[str, ...], surface: int) -> dict:
    return {**dict.fromkeys(COUNTS, 0), **{k: r[k] for k in keys}, "gap_answers": r["gap_answers"], "gap_base": r["base_answers"],
            "cit_total": r["citations"], "cit_total_all": r["citations_all"], "cit_m05": compute.citation_numerator(surface, r),
            "cit_target": r["target"], "cit_owned": r["owned"]}


async def counts(ctx: Context, *, group: str | None = None, family: str = "mentions", prompts: bool = True,
                 types: bool = False, owned: bool = False) -> list[dict]:
    """The COUNTS sums per group; with `prompts`, also measured_prompts / mentioned_prompts (distinct counts sort every row:
    a caller that reads only the sums passes prompts=False), with `types` the t_<type> answers (the brand rows' scan), with
    `owned` global's 자사 URL citations (the citation rows' scan; the other surfaces have them on the answers)."""
    keys, source = GROUP_KEYS[group or ""], metric_source(ctx)
    if family == "citations":
        return _sorted([_citation_row(r, keys, ctx.sf) for r in await source.citation_counts(keys, owned=owned)], keys)
    rows = [_mention_row(r, keys) for r in await source.answer_counts(MONITORING, keys, prompts=prompts)]
    if types:
        by_key = {tuple(r[k] for k in keys): r for r in await source.own_brand_counts(MONITORING, keys)}
        for row in rows:
            own = by_key.get(tuple(row[k] for k in keys), {})
            row.update({f"t_{t}": own.get(f"t_{t}", 0) for t in TYPES})
    return _sorted(rows, keys)


metric_values = compute.answer_values


URL_METRICS = ("target_url_rate", "owned_url_rate", "citation_accuracy")

url_metric_values = compute.url_rates


async def url_cells(ctx: Context, bucket_rows: list[dict], engine_codes: dict | None) -> tuple[dict, dict]:
    """The trend's URL counts per (bucket, None) and, with `engine_codes`, per (bucket, engine code). A distinct prompt
    count does not add over rounds or engines, so a bucket of several rounds is counted on its own rounds."""
    source = metric_source(ctx)
    totals, by_engine = {}, {}
    if all(len(b["round_dates"]) == 1 for b in bucket_rows):
        bucket_of = {b["round_dates"][0]: b["key"] for b in bucket_rows}
        for r in await source.url_counts(("round_date",)):
            totals[(bucket_of[r["round_date"].isoformat()], None)] = r
        if engine_codes is not None:
            for r in await source.url_counts(("round_date", "engine_key")):
                by_engine[(bucket_of[r["round_date"].isoformat()], engine_codes.get(r["engine_key"]))] = r
    else:
        for b in bucket_rows:
            rounds = source.for_rounds([date.fromisoformat(d) for d in b["round_dates"]])
            totals[(b["key"], None)] = (await rounds.url_counts())[0]
            if engine_codes is not None:
                for r in await rounds.url_counts(("engine_key",)):
                    by_engine[(b["key"], engine_codes.get(r["engine_key"]))] = r
    return totals, by_engine if engine_codes is not None else totals


async def summary(ctx: Context) -> dict:
    mention = (await counts(ctx))[0]
    citation = (await counts(ctx, family="citations", prompts=False))[0]
    rows = None
    data = metric_values({**mention, **{k: v for k, v in citation.items() if k.startswith("cit_")}})
    suppressed = {}
    if ctx.sf == 1:
        for key in ("target_url_rate", "owned_url_rate", "citation_accuracy"):
            data[key] = None
            suppressed[key] = "not_website_surface"
    else:
        rows = (await metric_source(ctx).url_counts())[0]
        data.update(url_metric_values(rows))
    # Applied prompts belong to the catalog even when they have never been measured. Counting them reads the
    # whole catalog (12k rows, ~1 s on the global card), so only when ?parts= asks for them (none = all, B089).
    applied = None
    parts = values(ctx.q, "parts")
    if not parts or "applied" in parts:
        applied = await metric_source(ctx).applied_prompts()
    by_funnel = None
    if flag(ctx.q, "by_funnel"):
        by_funnel = await metric_source(ctx).funnel_prompt_counts()
    data.update(url_prompts={"measured_prompts": rows["url_prompts"], "target_prompts": rows["url_target_prompts"], "owned_prompts": rows["url_own_prompts"]} if rows else None,
                params={"answers": mention["answers"], "measured_prompts": mention["measured_prompts"],
                        "applied_prompts": applied,
                        "prompts_without_brand": mention["measured_prompts"]-mention["mentioned_prompts"] if ctx.selected_dates else None,
                        "measured_by_funnel": by_funnel},
                analysis_gap={"gap_answers": citation["gap_answers"], "base_answers": citation["gap_base"]})
    if not ctx.selected_dates:
        suppressed["*"] = "no_snapshot"
    return envelope(ctx, data, suppressed=suppressed)


ENGINE_MAP = {"answers": "answers", "tracked": "tracked", "tracked_mon": "tracked_mon", "multi": "multi_answers", "top1": "top1", "top3": "top3",
              "rank_sum": "rank_sum", "ranked": "ranked", "total_mentions": "total_mentions", "tracked_mentions": "own_mentions",
              "sent_mentions": "sent_all", "positive_mentions": "sent_pos", "negative_mentions": "sent_neg",
              "cit_total": "cit_total", "cit_owned": "cit_m05"}


async def engines(ctx: Context) -> dict:
    codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
    citation = {r["engine_key"]:r for r in await counts(ctx, group="engine", family="citations", prompts=False)}
    rows = [{"engine": codes[r["engine_key"]], **{k: (citation.get(r["engine_key"], {}).get(v, 0) if k.startswith("cit_") else r[v]) for k, v in ENGINE_MAP.items()}}
            for r in await counts(ctx, group="engine", prompts=False)]
    total = {k: sum(r[k] for r in rows) for k in ENGINE_MAP}
    consistency = {}
    for key, num, den in (("visibility", "tracked", "answers"), ("share_of_voice", "tracked_mentions", "total_mentions"),
                          ("sentiment", "positive_mentions", "sent_mentions"), ("position", "rank_sum", "ranked"),
                          ("citation_share", "cit_owned", "cit_total")):
        value = engine_consistency(r[num] / r[den] for r in rows if r[den])
        consistency[key] = None if value is None else round(value, 1)
    return envelope(ctx, {"rows": sorted(rows, key=lambda r: r["engine"]), "total": total, "engine_consistency": consistency})


#: brand_rows() column groups past the sums: prompts (distinct prompts), multi (multi-mention sums + distinct
#: prompts), types (the five type sums). The distinct counts sort every cell and spill to disk (work_mem 4MB).
EXTRAS = frozenset({"prompts", "multi", "types"})


async def brand_rows(ctx: Context, *, by_date: bool = False, by_country: bool = False, by_engine: bool = False,
                     brand_keys: list[str] | None = None, extras: frozenset[str] = EXTRAS) -> list[dict]:
    """Per brand (and key): the sums and the `extras` column groups. The brand trend and the geography read the
    sums only (the 14-round brand trend 1.95 -> 0.95 s); mentions/brands reads what its ?include= asks for."""
    keys = ("round_date",) if by_date else ("geo_key",) if by_country else ("engine_key",) if by_engine else ()
    rows = await metric_source(ctx).brand_counts(MONITORING, keys, prompts=bool(extras & {"prompts", "multi"}), brand_keys=brand_keys)
    return [{**{k: r[k] for k in keys}, "brand_key": r["brand_key"], "name": r["name"], "own_bit": r["own_bit"], "mentions": r["mentions"],
             "answers": r["rep_answers"], "rank_sum": r["rank_sum"], "ranked": r["ranked"], "positive": r["s_pos"], "neutral": r["s_neu"],
             "mixed": r["s_mix"], "negative": r["s_neg"], "multi_answers": r["multi_answers"], "multi_mentions": r["multi_mentions"],
             "prompts": r.get("prompts"), "multi_prompts": r.get("multi_prompts"), **{f"t_{t}": r[f"signals_{t}"] for t in TYPES}} for r in rows]


def _brand_values(r: dict, c: dict) -> dict:
    """A brand row's values on the read's answers and mentions `c`."""
    return compute.brand_metrics(rep_answers=r["answers"], answers=c.get("answers"), mentions=r["mentions"], total_mentions=c.get("total_mentions"),
                                 positive=r["positive"], sentiments=sum(r[k] for k in ("positive", "negative", "neutral", "mixed")),
                                 rank_sum=r["rank_sum"], ranked=r["ranked"])


def brand_row_item(c: dict, r: dict, include: frozenset[str]) -> dict:
    """One brand cell row as a brand item, on the perspective's answers and mentions `c` (a rival row; with
    split_own also one own brand's row)."""
    v = _brand_values(r, c)
    item = {"brand_key": r["brand_key"], "name": r["name"], "is_own": False, "rank": 0,
            "mentions": r["mentions"], "exposure": v["exposure"], "share": v["share"], "avg_rank": v["priority"],
            "sentiment": {k: r[k] for k in ("positive", "neutral", "mixed", "negative")}}
    if "hmg" in include:
        item["is_hmg_own"] = bool(r["own_bit"])
    if "prompts" in include:
        item["prompts"] = r["prompts"]
    if "multi" in include:
        item["multi"] = {"answers": r["multi_answers"], "mentions": r["multi_mentions"], "prompts": r["multi_prompts"]}
    if "types" in include:
        item["types"] = {t: r[f"t_{t}"] for t in TYPES}
    return item


def brand_items(ctx: Context, c: dict, rows: list[dict], own_multi_prompts: int | None, include: frozenset[str],
                split_own: bool = False) -> list[dict]:
    """당사 (the perspective's counts `c`) + every rival row, ranked by mentions (당사 counted in the rank). The row
    fields the contract leaves to ?include= (is_hmg_own, prompts, multi, types) are sent only when asked for.
    `split_own` (contract D13, a perspective of two or more brands): 당사 is one row per perspective brand instead,
    keyed own_brand_code in bit order, each its brand cell counted as a rival row is (Gold has one brand per own bit,
    gold.dim_brand 2026-11-05: Hyundai 1 · Kia 2 · Genesis 4)."""
    own_detail = [r for r in rows if r["own_bit"] & ctx.bits]
    if split_own and len(ctx.own_names) > 1:
        items = []
        for bit, code in BRAND_NAMES.items():
            if bit & ctx.bits:
                cell = next((r for r in own_detail if r["own_bit"] == bit), None)
                cell = cell or {"brand_key": None, "name": code, "own_bit": bit, "prompts": 0, "multi_answers": 0,
                                "multi_mentions": 0, "multi_prompts": 0,
                                **dict.fromkeys(("mentions", "answers", "rank_sum", "ranked", "positive", "neutral",
                                                 "mixed", "negative", *(f"t_{t}" for t in TYPES)), 0)}
                items.append({**brand_row_item(c, cell, include), "is_own": True, "own_brand_code": code})
    else:
        v = compute.answer_values(c)
        own = {"brand_key": own_detail[0]["brand_key"] if len(ctx.own_names) == 1 and own_detail else None,
               "name": ctx.label, "is_own": True, "rank": 0, "mentions": c["own_mentions"],
               "exposure": v["visibility"], "share": v["share_of_voice"], "avg_rank": v["position"],
               "sentiment": {k: sum(r[k] for r in own_detail) for k in ("positive", "neutral", "mixed", "negative")}}
        if "hmg" in include:
            own["is_hmg_own"] = True
        if "prompts" in include:
            own["prompts"] = c["mentioned_prompts"]
        if "multi" in include:
            own["multi"] = {"answers": c["multi_answers"], "mentions": c["multi_mentions"], "prompts": own_multi_prompts}
        if "types" in include:
            own["types"] = {t: sum(r[f"t_{t}"] for r in own_detail) for t in TYPES}
        items = [own]
    items += [brand_row_item(c, r, include) for r in rows if not r["own_bit"] & ctx.bits and not ctx.excluded(r["name"])]
    items.sort(key=lambda r: (-r["mentions"], r["name"]))
    for i, row in enumerate(items, 1):
        row["rank"] = i
    return items


def excluded_rows(ctx: Context, rows: list[dict]) -> list[dict]:
    """The roster's excluded brands among `rows`: out of the ranks, still in the totals (고유 브랜드 수, 유형 합계)."""
    return [r for r in rows if not r["own_bit"] & ctx.bits and ctx.excluded(r["name"])]


async def multi_prompts(ctx: Context, by_engine: bool = False):
    """Multi-prompt counts are not additive; calculated over the same answers."""
    source = metric_source(ctx)
    if not by_engine:
        return (await source.own_multi_prompts())[0]["multi_prompts"]
    return {r["engine_key"]: r["multi_prompts"] for r in await source.own_multi_prompts(("engine_key",))}


async def brands(ctx: Context) -> dict:
    top_n = min(10000, max(0, int(ctx.q.get("top_n", "10"))))
    # The contract's ?include= (prompts, multi, types, hmg): the row fields asked for, and only their reads. A prompt
    # or multi count is a distinct count over every cell (the month's engine read: 1.7 of its 2.8 s).
    include = frozenset(v.strip() for raw in values(ctx.q, "include") for v in raw.split(",") if v.strip())
    extras = EXTRAS & include

    def chosen_of(items: list[dict]) -> list[dict]:
        return items if flag(ctx.q, "full") else [r for r in items if r["is_own"] or r["rank"] <= top_n]

    by_engine = None
    if ctx.q.get("group_by") == "engine":
        # 당사 + the rivals within top_n of each engine, counted on that engine's answers (the contract's
        # BG-16; 2026-10-29 metric review R4: by_engine was never sent, so the engine cards had no rival average)
        codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
        per_engine = {r["engine_key"]: r for r in await counts(ctx, group="engine", prompts="prompts" in include)}
        engine_rows = await brand_rows(ctx, by_engine=True, extras=extras)
        engine_multi = await multi_prompts(ctx, by_engine=True) if "multi" in include else {}
        by_engine = []
        for key, ec in sorted(per_engine.items(), key=lambda kv: codes[kv[0]]):
            if not ec["answers"]:
                continue
            of_engine = [r for r in engine_rows if r["engine_key"] == key]
            items = brand_items(ctx, ec, of_engine, engine_multi.get(key, 0), include, split_own=flag(ctx.q, "split_own"))
            by_engine.append({"engine": codes[key], "totals": {"answers": ec["answers"], "answers_mon": ec["answers_mon"], "mentions_total": ec["total_mentions"],
                                                               "brand_count": len(items) + len(excluded_rows(ctx, of_engine))},
                              "brands": chosen_of(items), "truncated": False})
    if by_engine is not None and flag(ctx.q, "engine_only"):
        # The contract's engine_only: the whole window is not read and answers as an empty one (zeros, the
        # 당사 row only); by_engine is the same. Reading it anyway took 2.4 of the 5.2 s of a month's engine read.
        c, rows, multi = {**dict.fromkeys(COUNTS, 0), "measured_prompts": 0, "mentioned_prompts": 0}, [], 0
    else:
        c = (await counts(ctx, prompts="prompts" in include))[0]
        rows = await brand_rows(ctx, extras=extras)
        multi = await multi_prompts(ctx) if "multi" in include else None
    merged = brand_items(ctx, c, rows, multi, include)
    # the own block is the perspective's 당사 (its rank among the merged rows) whether or not the rows are split
    own = merged[[r["is_own"] for r in merged].index(True)]
    items = brand_items(ctx, c, rows, multi, include, split_own=True) if flag(ctx.q, "split_own") else merged
    data = {"totals": {"answers": c["answers"], "answers_mon": c["answers_mon"], "mentions_total": c["total_mentions"], "brand_count": len(items) + len(excluded_rows(ctx, rows))},
            "own": {"vp_label": ctx.label, "brands": ctx.own_names, **{k: own[k] for k in ("rank", "mentions", "exposure", "share", "avg_rank")}},
            "brands": chosen_of(items)}
    if "types" in include:
        data["types_total"] = {t: sum(r["types"][t] for r in items) + sum(r[f"t_{t}"] for r in excluded_rows(ctx, rows)) for t in TYPES}
    return envelope(ctx, {**data, "by_engine": by_engine, "truncated": False})


def gap_reason_of(ctx: Context, key: str, buckets_of: dict) -> str:
    """Why a bucket has no value: its pre-computed values are late and the last resort failed too (shown as a gap), or nothing was answered."""
    return "not_ready" if any(d in ctx.late_rounds for d in buckets_of.get(key, ())) else "no_answer"


DEFAULT_TREND_METRICS = ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]


async def trend(ctx: Context) -> dict:
    """A trend with no explicit range spans the published calendar from the scope's first measured round on (the
    contract's first_measured_date), rather than a fabricated window."""
    explicit = bool(ctx.q.get("from") or ctx.q.get("to"))
    out = await _trend(ctx)
    if not explicit:
        from_first_measured(out["data"])
    return out


def from_first_measured(data: dict) -> None:
    """Leave out the rounds before the first one any series measured. The calendar holds rounds the scope never
    measured (on 2026-10-29 the global surface's 06-08..06-29: servable, ready facts, no standard-scope cells), and
    every trend drew them as empty rounds first. A gap after the first measured round stays."""
    series = data["series"] + [s for d in data.get("dims") or [] for s in d["series"]]
    measured = [p["bucket"] for s in series for p in s["points"] if not p["gap"]]
    if not measured:
        return
    first = min(measured)
    data["buckets"] = [b for b in data["buckets"] if b["key"] >= first]
    for s in series:
        s["points"] = [p for p in s["points"] if p["bucket"] >= first]


async def _trend(ctx: Context) -> dict:
    if not ctx.q.get("from") and not ctx.q.get("to"):
        ctx.selected_dates = ctx.dates[:]
    bucket = ctx.q.get("bucket", "cycle")
    dimension = ctx.q.get("dimension", "none")
    wanted = values(ctx.q, "metrics") or DEFAULT_TREND_METRICS
    if len(wanted) == 1 and "," in wanted[0]:
        wanted = wanted[0].split(",")
    def bucket_key(day):
        if bucket == "month":
            return day.replace(day=1).isoformat()
        if bucket == "week":
            return (day - timedelta(days=day.weekday())).isoformat()
        return day.isoformat()
    buckets = sorted({bucket_key(d) for d in ctx.selected_dates})
    buckets_of = {key: [d for d in ctx.selected_dates if bucket_key(d) == key] for key in buckets}
    bucket_rows = [{"key": key, "round_dates": [d.isoformat() for d in ctx.selected_dates if bucket_key(d) == key], "measured_days": None} for key in buckets]
    if dimension in {"source", "category"}:
        rows = await metric_source(ctx).source_round_counts(values(ctx.q, "source"))
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
                "label":labels[key], "points":[{"bucket":day,"ratio":compute.of("source_share" if dim=="source" else "category_share",grouped.get((day,key),0),totals.get(day,0)),
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
    # dims (contract P12 B101): the dimensions answered with this one, each as if asked alone. The mention trend
    # answers none, engine and type; all of them come from the same cells (none = the engines summed).
    specs: list[tuple[str, list[str]]] = []
    for spec in values(ctx.q, "dims"):
        dim, _, mets = spec.split("@", 1)[0].partition(":")
        if dim not in {"none", "engine", "type"} or dim in {dimension, *(d for d, _ in specs)}:
            raise HTTPException(422, "Unsupported or repeated trend dims dimension")
        specs.append((dim, [m for m in mets.split(",") if m] or DEFAULT_TREND_METRICS))
    groups: dict[tuple[str, str | None], dict] = {}
    engine_codes = {r["engine_key"]: r["code"] for r in await ctx.conn.fetch("SELECT * FROM gold.dim_engine")}
    grouping = "date_engine" if "engine" in {dimension, *(d for d, _ in specs)} else "date"
    asked = {*wanted, *(m for _, ms in specs for m in ms)}
    source_rows = await counts(ctx, group=grouping, prompts=False, types="type" in {dimension, *(d for d, _ in specs)})
    cite_rows = await counts(ctx, group=grouping, family="citations", prompts=False, owned=bool(asked & set(URL_METRICS)))
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
    by_bucket = groups
    if grouping == "date_engine":
        by_bucket = {}
        for (key, _), c in groups.items():
            target = by_bucket.setdefault((key, None), {k: 0 for k in COUNTS})
            for col in COUNTS:
                target[col] += c[col]
    # The URL rates of the website and project surfaces, as on the cards (summary). Read only when a URL rate is asked.
    url_groups: dict[tuple[str, str | None], dict] = {}
    url_by_bucket: dict[tuple[str, str | None], dict] = {}
    if ctx.sf != 1 and asked & set(URL_METRICS):
        url_by_bucket, url_groups = await url_cells(ctx, bucket_rows, engine_codes if dimension == "engine" else None)

    def plain_series(cells: dict, url_cells: dict, metrics: list[str]) -> list[dict]:
        series = []
        for dim in sorted({d for _, d in cells}, key=lambda x: x or ""):
            for metric in metrics:
                points = []
                for key in buckets:
                    c = cells.get((key, dim))
                    if ctx.sf != 1 and metric in URL_METRICS:
                        u = url_cells.get((key, dim))
                        val = url_metric_values(u)[metric] if c and u else None
                    else:
                        val = metric_values(c).get(metric) if c else None
                    points.append({"bucket": key, "rank" if metric == "position" else "ratio": val,
                                   "gap": c is None, "gap_reason": gap_reason_of(ctx, key, buckets_of) if c is None else None,
                                   "origin": "live", "negative": c["sent_neg"] if c and metric == "sentiment" else None})
                series.append({"metric": metric, "kind": "rank" if metric == "position" else "ratio", "key": dim,
                               "label": dim or ctx.label, "points": points})
        return series

    def type_series() -> list[dict]:
        # M08 type_exposure: the cells' t_<type> are the own answers with that type signal (mentions/types own_answers)
        series = []
        for t in TYPES:
            points = []
            for key in buckets:
                c = by_bucket.get((key, None))
                points.append({"bucket": key, "ratio": compute.type_exposure(t, c[f"t_{t}"], c["answers_mon"]) if c else None,
                               "gap": c is None, "gap_reason": gap_reason_of(ctx, key, buckets_of) if c is None else None,
                               "origin": "live"})
            series.append({"metric": "type_exposure", "kind": "ratio", "key": t, "label": t, "points": points})
        return series

    def series_of(dim: str, metrics: list[str]) -> list[dict]:
        if dim == "type":
            return type_series()
        return plain_series(*((groups, url_groups) if dim == "engine" else (by_bucket, url_by_bucket)), metrics)

    return envelope(ctx, {"bucket": bucket, "dimension": dimension, "own_label": ctx.label,
                          "buckets": bucket_rows,
                          "series": series_of(dimension, wanted),
                          "dims": [{"dimension": d, "series": series_of(d, m), "meta": ctx.meta()} for d, m in specs] or None})


#: the API's metric names -> brand_metrics'
BRAND_METRICS = {"visibility": "exposure", "share_of_voice": "share", "sentiment": "favorability", "position": "priority"}


async def brand_series(ctx: Context, wanted: list[str], buckets: list[str], bucket_key) -> list[dict]:
    """Brand histories must use brand cells; never duplicate the own-brand series as a rival. Only the
    asked brands are read, and the date totals are one scan of the mention cells (the Overview brand
    trend read every brand and three cell scans, two of them for series it then dropped: 5.4 s).
    The own series is the perspective's (the date totals, as brands() and the cards), one per metric:
    its brands are never rivals, and the top counts rivals only (2026-10-29 metric review R1)."""
    rows = await brand_rows(ctx, by_date=True, brand_keys=values(ctx.q, "brand_key"), extras=frozenset())
    own_rows = [r for r in rows if r["own_bit"] & ctx.bits]
    rivals = [r for r in rows if not r["own_bit"] & ctx.bits and not ctx.excluded(r["name"])]
    # One pass to index the rows by name and bucket: filtering every row per name, metric and bucket was
    # names x rows (0.3 s on 14 rounds).
    rival_mentions: dict[str, int] = defaultdict(int)
    for r in rivals:
        rival_mentions[r["name"]] += r["mentions"]
    # ties by name: a set's order differs per process, so tied rivals changed between runs
    names = sorted({r["name"] for r in rivals}, key=lambda n: (-rival_mentions[n], n))[:int(ctx.q.get("top_n", "10"))]
    # ?pin_top_rival (2026-10-30): also the snapshot's top rival, the original screens' auto compare brand (the rival
    # with the largest share on the latest round, mention_surfaces.comparison_of), which the round total can leave
    # outside the top. Marked `pinned`, so the readers of "the top N" (averages, rank charts) can leave it out. A
    # period's rows are the period's, whose top rival leads the top already.
    pinned = None
    if flag(ctx.q, "pin_top_rival") and not (ctx.q.get("from") or ctx.q.get("to")) and ctx.selected_dates:
        latest = max(ctx.selected_dates)
        last: dict[str, int] = defaultdict(int)
        for r in rivals:
            if r["round_date"] == latest:
                last[r["name"]] += r["mentions"]
        top = min(last, key=lambda n: (-last[n], n)) if last else None
        if top is not None and top not in names:
            pinned = top
            names.append(top)
    first_of: dict[str, dict] = {}
    cells: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        first_of.setdefault(r["name"], r)
        cells[(r["name"], bucket_key(r["round_date"]))].append(r)
    totals = {}
    for row in await counts(ctx, group="date", prompts=False):
        total = totals.setdefault(bucket_key(row["round_date"]), dict.fromkeys(COUNTS, 0))
        for column in COUNTS:
            total[column] += row[column]
    series = []
    if own_rows:
        own_key = own_rows[0]["brand_key"] if len(ctx.own_names) == 1 else None
        for metric in wanted:
            points = []
            for key in buckets:
                c = totals.get(key)
                points.append({"bucket": key, "rank" if metric == "position" else "ratio": metric_values(c).get(metric) if c else None,
                               "gap": c is None})
            series.append({"metric": metric, "kind": "rank" if metric == "position" else "ratio", "key": ctx.label,
                           "label": ctx.label, "brand_key": own_key, "is_own": True, "points": points})
    for name in names:
        for metric in wanted:
            points = []
            for key in buckets:
                rs = cells.get((name, key), [])
                total = totals.get(key, {})
                n = sum(r["mentions"] for r in rs)
                v = compute.brand_metrics(rep_answers=sum(r["answers"] for r in rs), answers=total.get("answers"), mentions=n, total_mentions=total.get("total_mentions"),
                                          positive=sum(r["positive"] for r in rs), sentiments=sum(r["positive"] + r["negative"] + r["neutral"] + r["mixed"] for r in rs),
                                          rank_sum=sum(r["rank_sum"] for r in rs), ranked=sum(r["ranked"] for r in rs)).get(BRAND_METRICS.get(metric))
                points.append({"bucket": key, "rank" if metric == "position" else "ratio": v, "gap": not rs})
            first = first_of[name]
            series.append({"metric": metric, "kind": "rank" if metric == "position" else "ratio", "key": name,
                           "label": name, "brand_key": first["brand_key"], "is_own": bool(first["own_bit"] & ctx.bits), "points": points,
                           **({"pinned": True} if name == pinned else {})})
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


async def options(ctx: Context) -> dict:
    data, _ = await options_data(ctx)
    return envelope(ctx, data)


async def options_data(ctx: Context) -> tuple[dict, bool]:
    """The options and whether the read was consistent: something to answer from, and no key without its
    dimension row (the sign of a table read from another generation)."""
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
        source_categories = [{"slug": r["slug"], "name": r["name"], "ord": r["ord"]} for r in await metric_source(ctx).source_categories()]
    return {"geo_matrix": [{"brand": b, "region": c, "lang": l} for b, c, l in geo],
            "regions": [{"code": c, "area": next(r["area"] for r in rows if r["country"] == c), "kind": next(r["kind"] for r in rows if r["country"] == c)} for c in sorted({r["country"] for r in rows})],
            "languages": sorted({r["lang"].lower() for r in rows if r["lang"]}),
            "engines": [{"code": code, "is_default": next(r["is_default"] for r in rows if r["engine"] == code)} for code in sorted({r["engine"] for r in rows})],
            "catalog": catalog, "source_categories": source_categories, "custom_fields": custom_fields}, consistent
