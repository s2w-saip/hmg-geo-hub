"""The judgments on gold_db's rows (adapter ①'s side of data_server.metrics.judgments).

The brand and citation rows hold no answer-level input, so a population is held as the keys of the answers it leaves out: the rule runs once per set
of builds (0.3 s on global) and every read of any table leaves those keys out. The per-answer sums upstream kept on answer_fact (mentions, sentiment,
positions, citations) come from the rows themselves; on every round they equal those columns (2026-11-06).

A read never joins answers to per-answer sums: those groups are estimated at one row, and the nested loop that plans took a project read from 0.04 s to
23 s. It counts each side on its own (per_answer + merge), or reads the answers' keys first and binds them (mention_keys, citation_keys).
Goes with gold_reader once the OBT is read."""
from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Sequence
from typing import Any, NamedTuple

from data_server.hub_stores import input_db
from data_server.metrics import judgments as j

#: answer_fact holds finished runs only ('completed' on all of them, three surfaces, 2026-11-06). f = answer_fact, p = dim_prompt, rc = the region's dim_country
COLUMNS = j.AnswerColumns(run_finished="true", region="nullif(rc.code,'')",
                          measured_at="(SELECT jm.measured_at FROM gold.job_index jm WHERE jm.answer_key=f.answer_key)",
                          in_standard_catalog="p.in_root_catalog_all", is_korean="p.is_korean", prompt_regions="p.regions",
                          market_hidden="coalesce(rc.hidden_standard,false)", is_acr="f.is_acr", acr_iteration="f.acr_iter_rank",
                          analysis_state="f.analysis_state", representative="f.is_rep")
OFFICIAL_HMG = "officialHmg"
#: inputs apply at once (decision 2026-11-06): read again after this long, so a burst of reads asks once
INPUT_SECONDS = 5


class Populations(NamedTuple):
    """Answer keys each population leaves out, the brand keys of the non-competitors, and what comes from the input store."""
    not_eligible: list[int] = []
    not_citation_monitoring: list[int] = []
    not_monitoring: list[int] = []
    older_acr: list[int] = []
    non_competitor: list[int] = []
    bare_only: list[int] = []
    excluded_brands: frozenset[str] = frozenset()
    #: what the values depend on from the input store: the registered URLs (a round's values), and those with the excluded roles (a kept result)
    registered_digest: str = ""
    inputs_digest: str = ""


class Inputs(NamedTuple):
    registered: dict[str, list[str]] = {}
    excluded: dict[str, str] = {}
    registered_digest: str = ""
    inputs_digest: str = ""
    #: a project's 추적 URL, where it registered any
    tracked: dict[str, list[str]] = {}
    #: the URL a website prompt names, as URLs are compared
    prompt_targets: dict[str, str] = {}


_memo: dict[tuple, Populations] = {}
_inputs: tuple[float, Inputs] | None = None
_owned: dict[tuple, list[int]] = {}


async def read_inputs() -> Inputs:
    """The sites' registered URLs and the roster's excluded entities. No input store (a test, a tool): nothing registered or excluded."""
    global _inputs
    if not input_db.configured():
        return Inputs()
    now = time.monotonic()
    if _inputs is None or now - _inputs[0] >= INPUT_SECONDS:
        async with input_db.connection() as conn:
            sites = await conn.fetch("""SELECT m.project_id::text AS id,p.definition->>'surface' AS surface,m.owned_urls,m.tracked_urls,m.web_units::text AS units
                FROM catalog.current_measurement m JOIN catalog.current_project p USING(project_id) WHERE p.definition->>'surface' IN ('2','3')""")
            roles = await conn.fetch("SELECT entity_id::text AS id,rep_name FROM catalog.entity_role WHERE role='excluded' AND status='active'")
            targets = await conn.fetch("SELECT prompt_id::text AS id,definition->>'target_url' AS url FROM catalog.current_prompt WHERE definition->>'target_url' IS NOT NULL")
        registered = {r["id"]: sorted(j.registered_urls(r["owned_urls"], json.loads(r["units"]) if r["units"] else [])) for r in sites}
        # a project without a registered URL keeps its rows' mark, and is left out so the digest moves only when one registers
        kinds = {r["id"]: r["surface"] for r in sites}
        registered = {k: v for k, v in registered.items() if kinds[k] == "2" or v}
        tracked = {r["id"]: sorted(j.tracked_urls(r["tracked_urls"])) for r in sites if r["surface"] == "3" and r["tracked_urls"]}
        prompt_targets = {r["id"]: j.normal_url(r["url"]) for r in targets if j.normal_url(r["url"])}
        excluded = {r["id"]: r["rep_name"] for r in roles}
        signed = {"registered": registered, **({"tracked": tracked} if tracked else {})} if tracked else registered
        one = hashlib.sha256(json.dumps(signed, sort_keys=True).encode()).hexdigest()[:12]
        both = hashlib.sha256(f"{one}:{json.dumps(excluded, sort_keys=True, ensure_ascii=False)}".encode()).hexdigest()[:12]
        _inputs = (now, Inputs(registered, excluded, one, both, tracked, prompt_targets))
    return _inputs[1]


async def _excluded_names(conn: Any, excluded: dict[str, str]) -> frozenset[str]:
    """A rank row is named by its brand: the excluded entity's brand name, its roster name when Gold has no row for it (legacy rankName ?? name)."""
    if not excluded:
        return frozenset()
    names = {r["entity_id"]: r["name"] for r in await conn.fetch(
        """SELECT e.entity_id::text AS entity_id,b.name FROM gold.dim_entity e JOIN gold.dim_brand b USING(brand_key)
           WHERE e.entity_id::text=ANY($1::text[])""", list(excluded))}
    return frozenset(n.strip() for n in (names.get(k) or rep for k, rep in excluded.items()) if n and n.strip())


async def populations(conn: Any, surface: int, builds: list[int]) -> Populations:
    """Fixed per set of builds, and scanning for them would cost every read."""
    key = (surface, tuple(sorted(builds)))
    if key not in _memo:
        if len(_memo) >= 8:
            _memo.clear()
        is_global = surface == 1
        c = COLUMNS
        row = await conn.fetchrow(f"""SELECT coalesce(array_agg(f.answer_key) FILTER(WHERE NOT {j.eligible(c, is_global=is_global)}),'{{}}') AS not_eligible,
            coalesce(array_agg(f.answer_key) FILTER(WHERE NOT {j.citation_monitoring(c, is_global=is_global)}),'{{}}') AS not_citation_monitoring,
            coalesce(array_agg(f.answer_key) FILTER(WHERE NOT {j.monitoring(c, is_global=is_global)}),'{{}}') AS not_monitoring,
            coalesce(array_agg(DISTINCT f.answer_key) FILTER(WHERE {j.older_acr_run(c, is_global=is_global)}),'{{}}') AS older_acr
            FROM gold.answer_fact f JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
            LEFT JOIN gold.dim_country rc ON rc.geo_key=f.region_geo_key WHERE f.build_id=ANY($1::bigint[])""", list(key[1]))
        brands = await conn.fetch("SELECT brand_key,lower(btrim(name)) AS name FROM gold.dim_brand WHERE name IS NOT NULL")
        _memo[key] = Populations(list(row["not_eligible"]), list(row["not_citation_monitoring"]), list(row["not_monitoring"]), list(row["older_acr"]),
                                 [r["brand_key"] for r in brands if r["name"] in j.NON_COMPETITOR_BRANDS and r["name"] not in j.BARE_ONLY_NON_COMPETITORS],
                                 [r["brand_key"] for r in brands if r["name"] in j.BARE_ONLY_NON_COMPETITORS])
    inputs = await read_inputs()
    return _memo[key]._replace(excluded_brands=await _excluded_names(conn, inputs.excluded), registered_digest=inputs.registered_digest,
                               inputs_digest=inputs.inputs_digest)


async def _project_keys(ctx: Any) -> dict[str, int]:
    return {r["id"]: r["project_key"] for r in await ctx.conn.fetch(
        f"SELECT project_key,coalesce(project_id,scope_project_id,site_id)::text AS id FROM gold.dim_project WHERE surface={int(ctx.sf)}")}


async def _prefix_keys(ctx: Any, pairs: list[tuple[int, str]]) -> list[int]:
    """(site, URL) of every citation of a site's rows at or under one of its addresses. By host first: comparing every URL with every site's addresses took 6 s. Two statements: a
    join on a CTE of the matching URLs is planned for one row, and looped over every citation of the project for each URL (over 2 minutes for one registered project, 2026-11-07)."""
    matching = await ctx.conn.fetch(f"""WITH r AS (SELECT * FROM unnest($1::int[],$2::text[]) AS t(project_key,prefix)),
        h AS (SELECT DISTINCT split_part(prefix,'/',1) AS host FROM r),
        u AS MATERIALIZED (SELECT url_key,{j.normal_url_sql('coalesce(url_norm,url)')} AS n FROM gold.dim_url
              WHERE regexp_replace(lower(host),'^www\\.','') IN (SELECT host FROM h))
        SELECT r.project_key,u.url_key FROM u JOIN r ON split_part(u.n,'/',1)=split_part(r.prefix,'/',1) AND (u.n=r.prefix OR starts_with(u.n,r.prefix||'/'))""",
                                    [k for k, _ in pairs], [u for _, u in pairs])
    if not matching:
        return []
    rows = await ctx.conn.fetch("""SELECT DISTINCT f.project_key::bigint*4294967296+f.url_key AS k FROM gold.citation_fact f
        JOIN unnest($1::int[],$2::bigint[]) AS o(project_key,url_key) ON o.project_key=f.project_key AND o.url_key=f.url_key
        WHERE f.build_id=ANY($3::bigint[]) AND f.surface=$4""", [r["project_key"] for r in matching], [r["url_key"] for r in matching], ctx.builds.get("fact", []), ctx.sf)
    return [r["k"] for r in rows]


async def owned_url_keys(ctx: Any) -> list[int]:
    """(site, URL) of every citation under what the site registered, once per registered list and builds."""
    inputs = await read_inputs()
    key = ("owned", ctx.sf, inputs.registered_digest, tuple(sorted(ctx.builds.get("fact", []))))
    if key not in _owned:
        if len(_owned) >= 8:
            _owned.clear()
        sites = await _project_keys(ctx)
        _owned[key] = await _prefix_keys(ctx, [(sites[site], url) for site, urls in inputs.registered.items() if site in sites for url in urls])
    return _owned[key]


async def own_url(ctx: Any, b: Any, alias: str = "f") -> str:
    """자사 URL 인용 on a citation row (decisions D-25, 2026-11-07): what the site or project registered (judgments.registered_urls). A project with no registered URL keeps its
    rows' mark: the rule would make it 0 % (0 of 130 had any on 2026-11-06). Global: its rows' mark."""
    mark = f"{alias}.loc_owned"
    if ctx.sf == 1:
        return mark
    bound = b.__dict__.setdefault("own_url", {})
    if "sql" not in bound:
        registered = (await read_inputs()).registered
        sites = await _project_keys(ctx) if ctx.sf == 3 and registered else {}
        mine = [sites[site] for site in registered if site in sites]
        if ctx.sf == 3 and not mine:
            bound["sql"] = mark
        else:
            keys = await owned_url_keys(ctx)
            rule = f"({alias}.project_key::bigint*4294967296+{alias}.url_key) IN (SELECT unnest({b.bind(keys, 'bigint[]')}))" if keys else "FALSE"
            bound["sql"] = rule if ctx.sf == 2 else f"(CASE WHEN {alias}.project_key=ANY({b.bind(mine, 'int[]')}) THEN {rule} ELSE {mark} END)"
    return bound["sql"]


async def target_url_keys(ctx: Any) -> list[int]:
    """(prompt, URL) of every website citation of the URL its prompt names, once per builds."""
    inputs = await read_inputs()
    if not inputs.prompt_targets:
        return []
    key = ("target", tuple(sorted(ctx.builds.get("fact", []))), len(inputs.prompt_targets))
    if key not in _owned:
        if len(_owned) >= 8:
            _owned.clear()
        prompts = {r["id"]: r["prompt_key"] for r in await ctx.conn.fetch("SELECT prompt_key,prompt_id::text AS id FROM gold.dim_prompt WHERE prompt_id::text=ANY($1::text[])", list(inputs.prompt_targets))}
        pairs = [(prompts[p], url) for p, url in inputs.prompt_targets.items() if p in prompts]
        rows = await ctx.conn.fetch(f"""WITH r AS (SELECT * FROM unnest($1::int[],$2::text[]) AS t(prompt_key,url)),
            h AS (SELECT DISTINCT split_part(url,'/',1) AS host FROM r),
            u AS MATERIALIZED (SELECT url_key,{j.normal_url_sql('coalesce(url_norm,url)')} AS n FROM gold.dim_url WHERE regexp_replace(lower(host),'^www\\.','') IN (SELECT host FROM h))
            SELECT DISTINCT f.prompt_key::bigint*4294967296+f.url_key AS k FROM gold.citation_fact f JOIN r USING(prompt_key) JOIN u ON u.url_key=f.url_key AND u.n=r.url
            WHERE f.build_id=ANY($3::bigint[]) AND f.surface=2""", [k for k, _ in pairs], [u for _, u in pairs], ctx.builds.get("fact", []))
        _owned[key] = [r["k"] for r in rows]
    return _owned[key]


async def target_url(ctx: Any, b: Any, alias: str = "f") -> str:
    """타겟 URL 인용 on a citation row (judgments.is_target). Website: the URL the prompt names. Project: its 추적 URL where it registered any, its rows' mark until then (0 of 130
    had any on 2026-11-07). Global: its rows' mark, which is never set."""
    mark = f"{alias}.tgt_hit"
    if ctx.sf == 1:
        return mark
    bound = b.__dict__.setdefault("target_url", {})
    if "sql" not in bound:
        inputs = await read_inputs()
        if ctx.sf == 2:
            keys = await target_url_keys(ctx)
            bound["sql"] = f"({alias}.prompt_key::bigint*4294967296+{alias}.url_key) IN (SELECT unnest({b.bind(keys, 'bigint[]')}))" if keys else "FALSE"
        else:
            sites = await _project_keys(ctx) if inputs.tracked else {}
            mine = {sites[site]: urls for site, urls in inputs.tracked.items() if site in sites}
            if not mine:
                bound["sql"] = mark
            else:
                cache = ("tracked", inputs.registered_digest, tuple(sorted(ctx.builds.get("fact", []))))
                if cache not in _owned:
                    _owned[cache] = await _prefix_keys(ctx, [(k, u) for k, urls in mine.items() for u in urls])
                keys = _owned[cache]
                rule = f"({alias}.project_key::bigint*4294967296+{alias}.url_key) IN (SELECT unnest({b.bind(keys, 'bigint[]')}))" if keys else "FALSE"
                bound["sql"] = f"(CASE WHEN {alias}.project_key=ANY({b.bind(list(mine), 'int[]')}) THEN {rule} ELSE {mark} END)"
    return bound["sql"]


def official(alias: str) -> str:
    return (f"{alias}.source_key IN (SELECT so.source_key FROM gold.dim_source so JOIN gold.dim_category ca USING(category_key) "
            f"WHERE ca.slug='{OFFICIAL_HMG}')")


def mention_columns(ctx: Any, b: Any, alias: str = "x") -> str:
    """An answer's sums over its brand rows: all competitive mentions (ment_total), and 당사's by the perspective."""
    own = f"({alias}.own_bit & {b.bind(ctx.bits)})<>0"
    every = f"{alias}.s_pos+{alias}.s_neu+{alias}.s_neg+{alias}.s_mix"
    return f"""coalesce(sum({alias}.mention_count) FILTER(WHERE {ctx.competitive(b, alias)}),0)::bigint AS total,
        coalesce(sum({alias}.mention_count) FILTER(WHERE {own}),0)::bigint AS own_m,
        coalesce(sum({alias}.s_pos) FILTER(WHERE {own}),0)::bigint AS sent_pos,coalesce(sum({alias}.s_neg) FILTER(WHERE {own}),0)::bigint AS sent_neg,
        coalesce(sum({every}) FILTER(WHERE {own}),0)::bigint AS sent_all,
        min(nullif({alias}.first_pos,0)) FILTER(WHERE {own}) AS fp,min(nullif({alias}.rk,0)) FILTER(WHERE {own}) AS rk,coalesce(bool_or({own}),false) AS tracked"""


def mentions_of_row(ctx: Any, b: Any, alias: str = "f") -> str:
    """The sums for the rows of a page: its brand rows by the answer's full key."""
    return (f"LEFT JOIN LATERAL (SELECT {mention_columns(ctx, b)} FROM gold.answer_brand_fact x WHERE "
            f"(x.build_id,x.surface,x.round_date,x.answer_key)=({alias}.build_id,{alias}.surface,{alias}.round_date,{alias}.answer_key)) m ON true")


async def citation_columns(ctx: Any, b: Any, alias: str = "x") -> str:
    own, target = await own_url(ctx, b, alias), await target_url(ctx, b, alias)
    return f"""count(*)::bigint AS n_all,count(*) FILTER(WHERE {alias}.source_key<>0)::bigint AS n,count(*) FILTER(WHERE {official(alias)})::bigint AS official,
        count(*) FILTER(WHERE {target})::bigint AS target,count(*) FILTER(WHERE {own})::bigint AS owned,
        count(*) FILTER(WHERE {own} OR {target})::bigint AS owned_or_target"""


async def citations_of_row(ctx: Any, b: Any, alias: str = "f") -> str:
    return (f"LEFT JOIN LATERAL (SELECT {await citation_columns(ctx, b)} FROM gold.citation_fact x WHERE "
            f"(x.build_id,x.surface,x.round_date,x.answer_key)=({alias}.build_id,{alias}.surface,{alias}.round_date,{alias}.answer_key)) cs ON true")


class MentionKeys(NamedTuple):
    """The answers of the read's rounds, by what their brand rows hold for 당사."""
    tracked: list[int]
    mentioned: list[int]
    positive: list[int]
    with_sentiment: list[int]
    leans_positive: list[int]
    leans_negative: list[int]
    first: list[int]
    later: list[int]


async def mention_keys(ctx: Any, *, measure_family: str = "mentions") -> MentionKeys:
    from data_server.gold_reader.context import SQL
    b = SQL()
    where = ctx.predicate(b, "x", family="fact", measure_family=measure_family)
    marks = {"tracked": "m.tracked", "mentioned": "m.total>0", "positive": "m.sent_pos>0", "with_sentiment": "m.sent_all>0",
             "leans_positive": "m.sent_pos>m.sent_neg", "leans_negative": "m.sent_neg>m.sent_pos", "first": "m.fp=1", "later": "m.fp>=2"}
    keys = ",".join(f"coalesce(array_agg(m.answer_key) FILTER(WHERE {mark}),'{{}}') AS {name}" for name, mark in marks.items())
    row = await ctx.conn.fetchrow(f"""SELECT {keys} FROM (SELECT x.answer_key,{mention_columns(ctx, b)}
        FROM gold.answer_brand_fact x WHERE {where} GROUP BY x.answer_key) m""", *b.args)
    return MentionKeys(*(list(row[name]) for name in marks))


class CitationKeys(NamedTuple):
    official: list[int]
    hosted: list[int]


async def citation_keys(ctx: Any) -> CitationKeys:
    from data_server.gold_reader.context import SQL
    b = SQL()
    where = ctx.predicate(b, "x", family="fact")
    row = await ctx.conn.fetchrow(f"""SELECT coalesce(array_agg(DISTINCT x.answer_key) FILTER(WHERE {official('x')}),'{{}}') AS official,
        coalesce(array_agg(DISTINCT x.answer_key) FILTER(WHERE x.source_key<>0),'{{}}') AS hosted FROM gold.citation_fact x WHERE {where}""", *b.args)
    return CitationKeys(list(row["official"]), list(row["hosted"]))


def in_keys(b: Any, alias: str, keys: list[int]) -> str:
    """The answer's key is among `keys`: hashed, whichever table the row is in."""
    return f"{alias}.answer_key IN (SELECT unnest({b.bind(keys, 'bigint[]')}))" if keys else "FALSE"


def merge(rows: list[dict], others: list[dict], group: Sequence[str], columns: Sequence[str]) -> list[dict]:
    """The other side's `columns` onto each group's row; a group it has no row for counts 0."""
    by_key = {tuple(r[g] for g in group): r for r in others}
    for row in rows:
        other = by_key.get(tuple(row[g] for g in group), {})
        row.update({c: other.get(c, 0) for c in columns})
    return rows
