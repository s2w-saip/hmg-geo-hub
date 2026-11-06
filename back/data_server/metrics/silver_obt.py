"""Adapter ②: the base counts from the Silver OBT's operational snapshots (silver_contract.answer_analysis · acr_rollup, public snapshots only), with what the
service holds itself (input_db: the prompts' definitions, the markets, the brands, the roster). It reads contract columns only, never `ext`: until the
pipeline's connection details arrive the virtual OBT stands in for it, and only the connection changes.

An answer's rows are JSON arrays, unfolded in the query: one global round (47 thousand answers, 660 thousand rollup rows) in about 1.5 s.

The judgments are data_server.metrics.judgments, on the columns of OBT_COLUMNS. What the contract has no column for, and how it is worked out here:
 - 완료 = s1_normalize_answer_status 'completed'. ACR = the prompt's kind (both equal on every answer of the rounds checked, 2026-11-06).
 - ACR 반복 번호 = the answer's place by measured_at in its run · prompt · engine · country · language. Global 2026-10-05: 26 of 3,962 ACR answers differ from the number
   the old store kept, as the contract has no ACR bundle on an answer. Moves to the column if the real OBT has one.
 - 대표 답변 = formulas.representative, in SQL.
 - 당사 = the brand's own_bit in the brand reference, or the entity's 'own' role on the roster.
 - 시장 = country; on website the site's country, as country there is where the answer was measured from.
 - 한국어 프롬프트 = Hangul in its text (equal to the store's flag on all 28,750 prompts, 2026-11-06).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import re
from collections.abc import Mapping, Sequence
from copy import copy
from dataclasses import replace
from datetime import date
from typing import Any, NamedTuple

from data_server.gold_reader.context import SQL, values
from data_server.hub_stores import input_db, silver_db
from data_server.metrics import judgments as j
from data_server.metrics.catalog import CITATION_MONITORING, MONITORING, REPRESENTATIVE, SENTIMENTS, TYPES
from data_server.metrics.gold_current import GoldCurrentSource

SEMANTICS = {"s_pos": "sentiment_positive", "s_neu": "sentiment_neutral", "s_neg": "sentiment_negative", "s_mix": "sentiment_mixed",
             **{f"t_{t}": f"type_{t}" for t in TYPES}}
OBT_COLUMNS = j.AnswerColumns(run_finished="true", region="x.country", measured_at="x.measured_at", in_standard_catalog="p.in_root",
                              is_korean="p.is_korean", prompt_regions="p.regions", market_hidden="x.country=ANY({hidden})",
                              is_acr="p.is_acr", acr_iteration="x.acr_iter", analysis_state="x.analysis_state", representative="x.last_measured")
GROUPS = {"round": "a.round_date", "engine": "a.engine", "country": "a.market", "prompt": "a.prompt_id"}
CELL_GROUPS = {"round": "cell.round_date", "engine": "cell.engine", "country": "cell.country", "prompt": "cell.prompt_id"}
OFFICIAL_HMG = "officialHmg"
STANCE_CODES = "WHEN 'positive' THEN 1 WHEN 'neutral' THEN 2 WHEN 'mixed' THEN 3 WHEN 'negative' THEN 4"  # the readers' codes
SURFACE = {"global": 1, "website": 2, "project": 3}
HANGUL = re.compile("[가-힣]")


class Binder:
    """Positional parameters of one statement."""

    def __init__(self) -> None:
        self.args: list[Any] = []

    def __call__(self, value: Any, cast: str = "") -> str:
        self.args.append(value)
        return f"${len(self.args)}{'::' + cast if cast else ''}"


class Scope(NamedTuple):
    """What a read is bound to. Codes as the screens send them; an empty tuple does not narrow."""
    surface: str
    rounds: tuple[date, ...]
    bits: int
    projects: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    langs: tuple[str, ...] = ()
    engines: tuple[str, ...] = ()
    #: the catalog picks (funnel, topic...), as prompt ids. None = no pick
    prompts: tuple[str, ...] | None = None
    #: 관점 is by brand on website (the site's brand), by catalog on global
    brand_picked: bool = False
    #: one operating snapshot (the load job reads them one by one). None = every public one of the rounds
    snapshot: str | None = None


class Inputs(NamedTuple):
    """From input_db, once per read."""
    prompt_ids: list[str]
    funnel: list[str | None]
    #: (prompt, brand bit) of the catalog rows marked branded
    branded: list[tuple[str, int]]
    in_root: list[bool]
    is_korean: list[bool]
    regions: list[str]
    is_acr: list[bool]
    web_reg: list[bool]
    brand_group: list[int]
    hidden_markets: list[str]
    #: lower-cased brand name -> own_bit
    own_names: dict[str, int]
    #: entity -> own_bit, the roster's 'own' entities
    own_entities: dict[str, int]
    #: site -> (country, brand bit)
    sites: dict[str, tuple[str | None, int]]
    #: category name as the extraction writes it -> slug
    categories: dict[str, str]
    #: site or project -> what it registered (judgments.registered_urls); a project with nothing registered is not here
    registered: dict[str, list[str]]
    #: the roster's 'excluded' entities
    excluded_entities: list[str]
    #: project -> its 추적 URL (judgments.tracked_urls), where it registered any
    tracked: dict[str, list[str]] = {}
    #: prompt -> the URL it names, as URLs are compared (website)
    prompt_targets: dict[str, str] = {}


def with_past_catalogs(inputs: Inputs, rows: Sequence[Mapping[str, Any]]) -> Inputs:
    """A prompt later taken out of the standard catalog still counts in the rounds it was measured in. The service's definitions hold today's catalog; gold_db holds what
    it was, for the prompts where the two differ (115 on global, 2026-11-06)."""
    past = {r["id"]: r for r in rows}
    return inputs._replace(in_root=[past[p]["in_root_catalog_all"] if p in past else v for p, v in zip(inputs.prompt_ids, inputs.in_root)],
                           brand_group=[(past[p]["cat_mask_all"] or 0) if p in past else v for p, v in zip(inputs.prompt_ids, inputs.brand_group)])


async def read_inputs(conn: Any) -> Inputs:
    """conn = input_db."""
    rows = await conn.fetch("SELECT prompt_id::text AS id,text,definition::text AS d FROM catalog.current_prompt")
    columns: tuple[list, ...] = ([], [], [], [], [], [], [], [], [])
    for r in rows:
        d = json.loads(r["d"])
        group = 0
        branded: list[tuple[str, int]] = []
        for entry in d.get("catalogs") or []:
            group |= entry.get("brand_bit") or 0
            if (entry.get("brand_presence") or "").lower() == "branded":
                branded.append((r["id"], entry.get("brand_bit") or 0))
        columns[2].extend(branded)
        values = (r["id"], d.get("funnel"), None, bool(d.get("in_root_catalog")), HANGUL.search(r["text"] or "") is not None, ",".join(d.get("regions") or []),
                  d.get("kind") == "acr", bool(d.get("web_reg")), group)
        for index, (column, value) in enumerate(zip(columns, values)):
            if index != 2:
                column.append(value)
    hidden = [r["item_key"] for r in await conn.fetch(
        "SELECT item_key FROM catalog.reference_source WHERE family='country' AND status='active' AND (definition->>'hidden_standard')::boolean")]
    names = {r["bare"]: r["bit"] for r in await conn.fetch(
        "SELECT lower(definition->>'bare') AS bare,(definition->>'own_bit')::int AS bit FROM catalog.reference_source WHERE family='brand' AND status='active'")}
    entities = {r["id"]: names.get((r["brand"] or "").strip().lower(), 0) for r in await conn.fetch(
        "SELECT entity_id::text AS id,brand FROM catalog.entity_role WHERE role='own' AND status='active'")}
    sites = {r["id"]: (r["country"], r["bit"] or 0) for r in await conn.fetch(
        "SELECT project_id::text AS id,definition->>'country' AS country,(definition->>'site_brand_bit')::int AS bit FROM catalog.current_project WHERE definition->>'surface'='2'")}
    categories = {r["name"]: r["code"] for r in await conn.fetch("SELECT code,name_en AS name FROM catalog.source_code WHERE kind='category'")}
    # the OBT names a project by its scope id (ObtForContext._scope), and a website by the id the input store has
    measured = await conn.fetch("""SELECT CASE WHEN p.definition->>'surface'='3' THEN coalesce(p.definition->>'scope_project_id',m.project_id::text) ELSE m.project_id::text END AS id,
           p.definition->>'surface' AS surface,m.owned_urls,m.tracked_urls,m.web_units::text AS units FROM catalog.current_measurement m
           JOIN catalog.current_project p USING(project_id) WHERE p.definition->>'surface' IN ('2','3')""")
    registered = {r["id"]: sorted(j.registered_urls(r["owned_urls"], json.loads(r["units"]) if r["units"] else [])) for r in measured}
    registered = {k: v for k, v in registered.items() if k in sites or v}
    tracked = {r["id"]: sorted(j.tracked_urls(r["tracked_urls"])) for r in measured if r["surface"] == "3" and r["tracked_urls"]}
    prompt_targets = {r["id"]: j.normal_url(r["url"]) for r in await conn.fetch(
        "SELECT prompt_id::text AS id,definition->>'target_url' AS url FROM catalog.current_prompt WHERE definition->>'target_url' IS NOT NULL") if j.normal_url(r["url"])}
    excluded = [r["id"] for r in await conn.fetch("SELECT entity_id::text AS id FROM catalog.entity_role WHERE role='excluded' AND status='active'")]
    return Inputs(*columns, hidden, names, entities, sites, categories, registered, excluded, tracked, prompt_targets)


def merge(rows: list[dict], others: list[dict], group: Sequence[str], columns: Sequence[str]) -> list[dict]:
    by_key = {tuple(r[g] for g in group): r for r in others}
    for row in rows:
        other = by_key.get(tuple(row[g] for g in group), {})
        row.update({c: other.get(c, 0) for c in columns})
    return rows


def _select(group: Sequence[str], alias: str = "a") -> str:
    return "".join(f"{GROUPS[g].replace('a.', alias + '.')} AS {g}," for g in group)


def _group_by(group: Sequence[str], *more: str, alias: str = "a") -> str:
    keys = [GROUPS[g].replace("a.", alias + ".") for g in group] + list(more)
    return f"GROUP BY {','.join(keys)}" if keys else ""


class SilverObtSource:
    def __init__(self, conn: Any, scope: Scope, inputs: Inputs) -> None:
        self.conn, self.scope, self.inputs = conn, scope, inputs
        self.surface = scope.surface
        self.snapshot_id = ""

    def for_rounds(self, rounds: Sequence[date]) -> SilverObtSource:
        return SilverObtSource(self.conn, self.scope._replace(rounds=tuple(sorted(rounds))), self.inputs)

    async def snapshot(self) -> str:
        """The public snapshots this read counts: their ids are the values' snapshot id."""
        rows = await self.conn.fetch("""SELECT DISTINCT r.run_key::text AS k FROM silver_contract.current_run r JOIN silver_contract.answer_analysis a USING(run_key)
            WHERE r.surface=$1 AND a.s1_normalize_round_date=ANY($2::date[]) ORDER BY 1""", self.surface, list(self.scope.rounds))
        self.snapshot_id = "silver:" + ",".join(r["k"] for r in rows)
        return self.snapshot_id

    def _answers(self, b: Binder, json_columns: Sequence[str] = (), *, every_answer: bool = False) -> str:
        """CTEs p, x, a: a = the scope's finished answers, judged. Older ACR runs are out of every read (SSOT: one per cell).
        every_answer (the load job): nothing is left out here, as the reads leave out their own."""
        i, s = self.inputs, self.scope
        is_global = s.surface == "global"
        hidden = b(i.hidden_markets, "text[]") if is_global else "'{}'::text[]"  # only global's rule reads it, and a parameter no one reads has no type
        columns = replace(OBT_COLUMNS, market_hidden=OBT_COLUMNS.market_hidden.format(hidden=hidden))
        filters = [f"y.surface={b(s.surface)}", f"y.s1_normalize_round_date=ANY({b(list(s.rounds), 'date[]')})", "y.s1_normalize_answer_status='completed'"]
        if s.snapshot:
            filters.append(f"y.run_key={b(s.snapshot, 'uuid')}")
        if s.projects:
            filters.append(f"y.project_id::text=ANY({b(list(s.projects), 'text[]')})")
        if s.engines:
            filters.append(f"lower(y.engine)=ANY({b([v.lower() for v in s.engines], 'text[]')})")
        if s.langs:
            filters.append(f"lower(y.lang)=ANY({b([v.lower() for v in s.langs], 'text[]')})")
        if s.prompts is not None:
            filters.append(f"y.prompt_id::text=ANY({b(list(s.prompts), 'text[]')})")
        market = "x.country"
        joins = ""
        outer = []
        if s.surface == "website":
            ids = list(i.sites)
            joins = (f" LEFT JOIN unnest({b(ids, 'text[]')},{b([i.sites[k][0] for k in ids], 'text[]')},{b([i.sites[k][1] for k in ids], 'int[]')}) "
                     "AS site(id,country,bit) ON site.id=x.project_id::text")
            market = "coalesce(site.country,x.country)"
            if s.brand_picked:
                outer.append(f"(site.bit & {b(s.bits)})<>0")
        elif is_global:
            if not every_answer:
                outer.append(f"(p.brand_group & {b(s.bits | 8)})<>0")
            if s.countries:
                filters.append(f"lower(y.country)=ANY({b([v.lower() for v in s.countries], 'text[]')})")
        if s.countries and not is_global:
            outer.append(f"lower({market})=ANY({b([v.lower() for v in s.countries], 'text[]')})")
        extra = "".join(f",y.{c}" for c in json_columns)
        prompts = (f"unnest({b(i.prompt_ids, 'text[]')},{b(i.funnel, 'text[]')},{b(i.in_root, 'boolean[]')},{b(i.is_korean, 'boolean[]')},{b(i.regions, 'text[]')},"
                   f"{b(i.is_acr, 'boolean[]')},{b(i.web_reg, 'boolean[]')},{b(i.brand_group, 'int[]')}) AS t(id,funnel,in_root,is_korean,regions,is_acr,web_reg,brand_group)")
        elig = j.eligible(columns, is_global=is_global)
        monitoring = j.monitoring(columns, is_global=is_global)
        citation = j.citation_monitoring(columns, is_global=is_global)
        older = j.older_acr_run(columns, is_global=is_global)
        where = "TRUE" if every_answer else " AND ".join([f"NOT {older}", *outer])
        return f"""p AS MATERIALIZED (SELECT id AS prompt_id,funnel,in_root,is_korean,CASE WHEN regions='' THEN NULL ELSE string_to_array(regions,',') END AS regions,is_acr,web_reg,brand_group FROM {prompts}),
            x AS MATERIALIZED (SELECT y.answer_key,y.prompt_id::text AS prompt_id,y.project_id,y.engine,y.country,y.lang,y.measured_at,y.analysis_state,y.s1_normalize_round_date AS round_date{extra},
                row_number() OVER (PARTITION BY y.run_id,y.prompt_id,y.engine,y.country,y.lang ORDER BY y.measured_at,y.answer_key) AS acr_iter,
                row_number() OVER (PARTITION BY y.cycle_id,y.prompt_id,y.engine,y.country,y.lang ORDER BY y.measured_at DESC,y.answer_key)=1 AS last_measured
                FROM silver_contract.answer_analysis y WHERE {' AND '.join(filters)}),
            a AS MATERIALIZED (SELECT x.*,{market} AS market,p.web_reg,p.funnel,{elig} AS eligible,{citation} AS citation_monitoring,{monitoring} AS monitoring,
                ({monitoring} AND x.last_measured) AS representative
                FROM x JOIN p ON p.prompt_id=x.prompt_id{joins} WHERE {where})"""

    @staticmethod
    def _gate(population: str) -> str:
        return {MONITORING: "a.monitoring", REPRESENTATIVE: "a.representative", CITATION_MONITORING: "a.citation_monitoring"}[population]

    def _rows_of_brands(self, b: Binder, rollups: Mapping[str, str] | None = None) -> str:
        """CTEs m, br after `a`: one row per answer and brand, as legacy folds them (ingest/frz/fold.py): a mention's brand is the extraction's, the sums over the brand's
        rollup rows, rk = the competing brands' rank by the lowest average position, first_pos = their rank by the first mention in the text.
        rollups (the load job): the rollup entities' names, found over more answers than this read's."""
        i = self.inputs
        names = sorted(n for n in j.NON_COMPETITOR_BRANDS if n not in j.BARE_ONLY_NON_COMPETITORS)
        bare = sorted(j.BARE_ONLY_NON_COMPETITORS)
        sems = ",".join(f"{column} int" for column in SEMANTICS.values())
        sums = ",".join(f"coalesce(sum(m.{col}),0)::bigint AS {key}" for key, col in SEMANTICS.items())
        own_names, own_entities = list(i.own_names), list(i.own_entities)
        return f"""m0 AS MATERIALIZED (SELECT a.answer_key,o.brand,o.brand_rollup_entity_id AS rollup,o.entity_id,o.mention_count,o.avg_position,o.surfaces,{','.join(f's.{c}' for c in SEMANTICS.values())}
                FROM a CROSS JOIN LATERAL jsonb_to_recordset(a.s2_mention_rollups) o(entity_id text,brand text,brand_rollup_entity_id text,mention_count int,avg_position float8,surfaces jsonb)
                LEFT JOIN LATERAL jsonb_to_recordset(a.s3_semantics_rollups) s(entity_id text,{sems}) ON s.entity_id=o.entity_id
                WHERE jsonb_typeof(a.s2_mention_rollups)='array'),
            rollup AS MATERIALIZED ({f"SELECT * FROM unnest({b(list(rollups), 'text[]')},{b(list(rollups.values()), 'text[]')}) AS t(entity_id,brand)" if rollups is not None
                else "SELECT DISTINCT ON (entity_id) entity_id,brand FROM m0 WHERE entity_id=rollup AND coalesce(btrim(brand),'')<>'' ORDER BY entity_id,brand"}),
            m AS MATERIALIZED (SELECT m0.answer_key,coalesce(r.brand,m0.brand) AS name,lower(btrim(coalesce(r.brand,m0.brand))) AS bare,m0.entity_id,m0.mention_count,m0.avg_position,m0.surfaces,{','.join(f'm0.{c}' for c in SEMANTICS.values())}
                FROM m0 LEFT JOIN rollup r ON r.entity_id=m0.rollup WHERE coalesce(btrim(coalesce(r.brand,m0.brand)),'')<>'' AND coalesce(r.brand,m0.brand)<>'(이름 없음)'),
            oc AS MATERIALIZED (SELECT a.answer_key,q.entity_id,min(ARRAY[coalesce(q.turn_index,0),coalesce(q.source_start,2147483647),coalesce(q.analysis_index,0)]) AS first_at
                FROM a CROSS JOIN LATERAL jsonb_to_recordset(a.s2_mention_occurrences) q(entity_id text,turn_index int,source_start int,analysis_index int)
                WHERE jsonb_typeof(a.s2_mention_occurrences)='array' GROUP BY 1,2),
            f AS (SELECT m.answer_key,m.name,
                bool_or(NOT (m.bare=ANY({b(names, 'text[]')}) OR (m.bare=ANY({b(bare, 'text[]')}) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(m.surfaces,'[]')) t(v) WHERE lower(btrim(t.v))<>m.bare)))) AS competitive,
                bit_or(coalesce(n.bit,0) | coalesce(e.bit,0)) AS own_bit,coalesce(sum(m.mention_count),0)::bigint AS mention_count,{sums},min(m.avg_position) AS tp,min(oc.first_at) AS first_at
                FROM m LEFT JOIN unnest({b(own_names, 'text[]')},{b([i.own_names[k] for k in own_names], 'int[]')}) AS n(bare,bit) ON n.bare=m.bare
                LEFT JOIN unnest({b(own_entities, 'text[]')},{b([i.own_entities[k] for k in own_entities], 'int[]')}) AS e(id,bit) ON e.id=m.entity_id
                LEFT JOIN oc ON oc.answer_key=m.answer_key AND oc.entity_id=m.entity_id GROUP BY 1,2),
            br AS MATERIALIZED (SELECT f.*,CASE WHEN f.competitive AND f.tp IS NOT NULL THEN rank() OVER (PARTITION BY f.answer_key,(f.competitive AND f.tp IS NOT NULL) ORDER BY f.tp) END AS rk,
                CASE WHEN f.competitive AND f.first_at IS NOT NULL THEN rank() OVER (PARTITION BY f.answer_key,(f.competitive AND f.first_at IS NOT NULL) ORDER BY f.first_at) END AS first_pos FROM f)"""

    MENTIONS = ("s2_mention_rollups", "s3_semantics_rollups", "s2_mention_occurrences")

    async def _fetch(self, sql: str, args: list) -> list[dict]:
        return [dict(r) for r in await self.conn.fetch(sql, *args)]

    # ── 언급 ──

    async def answer_counts(self, population: str, group: Sequence[str] = (), *, prompts: bool = False) -> list[dict]:
        gate = self._gate(population)
        b = Binder()
        distinct = ",count(DISTINCT a.prompt_id)::bigint AS measured_prompts" if prompts else ""
        rows = await self._fetch(f"""WITH {self._answers(b)} SELECT {_select(group)}count(*)::bigint AS answers,count(*) FILTER(WHERE a.last_measured)::bigint AS rep_answers{distinct}
            FROM a WHERE {gate} {_group_by(group)}""", b.args)
        b = Binder()
        answers = self._answers(b, self.MENTIONS)
        brands = self._rows_of_brands(b)
        own = f"(br.own_bit & {b(self.scope.bits)})<>0"
        every = "br.s_pos+br.s_neu+br.s_neg+br.s_mix"
        keys = "".join(f"pa.{g}," for g in group)
        distinct = """,count(DISTINCT pa.prompt_id) FILTER(WHERE pa.tracked)::bigint AS mentioned_prompts,
            count(DISTINCT pa.prompt_id) FILTER(WHERE pa.own_m>=2)::bigint AS multi_prompts""" if prompts else ""
        sums = await self._fetch(f"""WITH {answers},{brands},
            pa AS (SELECT {_select(group)}a.answer_key,a.prompt_id,a.last_measured,
                coalesce(sum(br.mention_count) FILTER(WHERE br.competitive),0)::bigint AS total,
                coalesce(sum(br.mention_count) FILTER(WHERE {own}),0)::bigint AS own_m,
                coalesce(sum(br.s_pos) FILTER(WHERE {own}),0)::bigint AS sent_pos,coalesce(sum(br.s_neg) FILTER(WHERE {own}),0)::bigint AS sent_neg,
                coalesce(sum({every}) FILTER(WHERE {own}),0)::bigint AS sent_all,
                min(br.first_pos) FILTER(WHERE {own}) AS fp,min(br.rk) FILTER(WHERE {own}) AS rk,coalesce(bool_or({own}),false) AS tracked
                FROM a JOIN br ON br.answer_key=a.answer_key WHERE {gate} {_group_by(group, 'a.answer_key', 'a.prompt_id', 'a.last_measured')})
            SELECT {keys}count(*) FILTER(WHERE pa.tracked)::bigint AS tracked,count(*) FILTER(WHERE pa.last_measured AND pa.tracked)::bigint AS rep_tracked,
            coalesce(sum(pa.own_m),0)::bigint AS own_mentions,coalesce(sum(pa.total),0)::bigint AS total_mentions,
            coalesce(sum(pa.sent_pos),0)::bigint AS sent_pos,coalesce(sum(pa.sent_neg),0)::bigint AS sent_neg,coalesce(sum(pa.sent_all),0)::bigint AS sent_all,
            coalesce(sum(pa.fp),0)::bigint AS rank_sum,count(pa.fp)::bigint AS ranked,
            count(*) FILTER(WHERE pa.fp=1)::bigint AS top1,count(*) FILTER(WHERE pa.fp<=3)::bigint AS top3,
            coalesce(sum(pa.rk),0)::bigint AS rk_sum,count(pa.rk)::bigint AS rk_count,
            count(*) FILTER(WHERE pa.own_m>=2)::bigint AS multi_answers,
            coalesce(sum(pa.own_m) FILTER(WHERE pa.own_m>=2),0)::bigint AS multi_mentions{distinct}
            FROM pa {('GROUP BY ' + keys.rstrip(',')) if group else ''}""", b.args)
        columns = ["tracked", "rep_tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked", "top1", "top3",
                   "rk_sum", "rk_count", "multi_answers", "multi_mentions", *(("mentioned_prompts", "multi_prompts") if prompts else ())]
        return merge(rows, sums, group, columns)

    async def own_brand_counts(self, population: str, group: Sequence[str] = ()) -> list[dict]:
        gate = self._gate(population)
        b = Binder()
        answers = self._answers(b, self.MENTIONS)
        brands = self._rows_of_brands(b)
        picks = ",".join(f"count(DISTINCT a.answer_key) FILTER(WHERE br.t_{t}>0)::bigint AS t_{t}" for t in TYPES)
        signals = ",".join(f"coalesce(sum(br.t_{t}),0)::bigint AS signals_{t}" for t in TYPES)
        sentiments = ",".join(f"coalesce(sum(br.{k}),0)::bigint AS {k}" for k in SENTIMENTS)
        return await self._fetch(f"""WITH {answers},{brands} SELECT {_select(group)}{picks},{signals},{sentiments}
            FROM a JOIN br ON br.answer_key=a.answer_key WHERE {gate} AND (br.own_bit & {b(self.scope.bits)})<>0 {_group_by(group)}""", b.args)

    async def brand_counts(self, population: str, group: Sequence[str] = (), *, prompts: bool = False, brand_keys: Sequence[str] | None = None) -> list[dict]:
        """Every competing brand's row. A brand has no number in the OBT, so brand_key is its name."""
        gate = self._gate(population)
        b = Binder()
        answers = self._answers(b, self.MENTIONS)
        brands = self._rows_of_brands(b)
        pick = f" AND br.name=ANY({b(list(brand_keys), 'text[]')})" if brand_keys else ""
        distinct = """,count(DISTINCT a.prompt_id)::bigint AS prompts,count(DISTINCT a.prompt_id) FILTER(WHERE br.mention_count>=2)::bigint AS multi_prompts""" if prompts else ""
        signals = ",".join(f"coalesce(sum(br.t_{t}),0)::bigint AS signals_{t}" for t in TYPES)
        sentiments = ",".join(f"coalesce(sum(br.{k}),0)::bigint AS {k}" for k in SENTIMENTS)
        return await self._fetch(f"""WITH {answers},{brands} SELECT {_select(group)}br.name AS brand_key,br.name,bit_or(br.own_bit) AS own_bit,(bit_or(br.own_bit) & {b(self.scope.bits)})<>0 AS is_own,
            coalesce(sum(br.mention_count),0)::bigint AS mentions,count(*)::bigint AS answers,count(*) FILTER(WHERE a.last_measured)::bigint AS rep_answers,
            coalesce(sum(br.first_pos),0)::bigint AS rank_sum,count(br.first_pos)::bigint AS ranked,
            coalesce(sum(br.rk),0)::bigint AS rk_sum,count(br.rk)::bigint AS rk_count,
            count(*) FILTER(WHERE br.mention_count>=2)::bigint AS multi_answers,coalesce(sum(br.mention_count) FILTER(WHERE br.mention_count>=2),0)::bigint AS multi_mentions,
            {signals},{sentiments}{distinct}
            FROM a JOIN br ON br.answer_key=a.answer_key WHERE {gate} AND br.competitive{pick} {_group_by(group, 'br.name')} ORDER BY mentions DESC,br.name""", b.args)

    async def own_multi_prompts(self, group: Sequence[str] = ()) -> list[dict]:
        rows = await self.answer_counts(MONITORING, group, prompts=True)
        return [{**{g: r[g] for g in group}, "multi_prompts": r["multi_prompts"]} for r in rows]

    async def type_counts(self, population: str) -> list[dict]:
        """Per side (own / rival) and type, over the rows that carry the type."""
        return await self._type_rows(self._gate(population), self.scope.bits, sums=SENTIMENTS, rows=False)

    async def type_sides(self, bits: int) -> list[dict]:
        return await self._type_rows("a.monitoring", bits, sums=("s_pos", "s_neu", "s_neg", "s_mix"), rows=True)

    async def _type_rows(self, gate: str, bits: int, *, sums: Sequence[str], rows: bool) -> list[dict]:
        b = Binder()
        answers = self._answers(b, self.MENTIONS)
        brands = self._rows_of_brands(b)
        inner, outer = [], []
        for t in TYPES:
            hit = f"br.t_{t}>0"
            inner += [f"sum(br.t_{t}) FILTER(WHERE {hit}) AS m_{t}", f"count(*) FILTER(WHERE {hit}) AS n_{t}", *(f"sum(br.{k}) FILTER(WHERE {hit}) AS {k}_{t}" for k in sums)]
            outer += [f"coalesce(sum(g.m_{t}),0)::bigint AS m_{t}", f"count(*) FILTER(WHERE g.n_{t}>0)::int AS a_{t}", *(f"coalesce(sum(g.{k}_{t}),0)::bigint AS {k}_{t}" for k in sums)]
            if rows:
                outer.append(f"coalesce(sum(g.n_{t}),0)::bigint AS n_{t}")
        return await self._fetch(f"""WITH {answers},{brands},g AS (SELECT a.answer_key,(br.own_bit & {b(bits, 'int')})<>0 AS own,{','.join(inner)}
            FROM a JOIN br ON br.answer_key=a.answer_key WHERE {gate} AND br.competitive GROUP BY 1,2)
            SELECT g.own,{','.join(outer)} FROM g GROUP BY g.own""", b.args)

    # ── 인용 ──

    CITATIONS = ("s1_normalize_citations", "s2_citation_judgments")

    def _rows_of_citations(self, b: Binder) -> str:
        """CTE c after `a`: one row per citation of a citation monitoring answer, with the extraction's judgment."""
        i = self.inputs
        names = list(i.categories)
        return f"""c AS MATERIALIZED (SELECT a.answer_key,a.prompt_id,a.project_id,a.round_date,a.engine,a.market,a.last_measured,a.analysis_state,q.url_norm,q.url,
                d.group_key AS skey,d.domain,d.category,cat.slug,d.is_owned,d.matched_brand,d.matched_base_url,d.loc_owned,coalesce(d.tgt_hit,false) AS tgt_hit
                FROM a CROSS JOIN LATERAL jsonb_to_recordset(a.s1_normalize_citations) q(citation_seq int,url text,url_norm text)
                LEFT JOIN LATERAL jsonb_to_recordset(a.s2_citation_judgments) d(citation_seq int,group_key text,domain text,category text,is_owned boolean,matched_brand text,matched_base_url text,loc_owned boolean,tgt_hit boolean)
                ON d.citation_seq=q.citation_seq
                LEFT JOIN unnest({b(names, 'text[]')},{b([i.categories[k] for k in names], 'text[]')}) AS cat(name,slug) ON cat.name=d.category
                WHERE a.citation_monitoring AND jsonb_typeof(a.s1_normalize_citations)='array')"""

    def _owned(self, b: Binder, alias: str = "c") -> str:
        """자사 URL 인용. Website: what the site registered, only (judgments.registered_urls). Project: the same, for a project that registered any (D-25, 2026-11-07);
        the extraction's mark for one that has not, which the rule would make 0 %.
        Global: a matched base of the perspective's brands (every base when it has none); is_owned alone also holds rows no base matched on the stand-in."""
        if self.surface in ("website", "project"):
            mark = f"coalesce({alias}.loc_owned,false)"
            mine = {k: v for k, v in self.inputs.registered.items() if (k in self.inputs.sites) == (self.surface == "website")}
            if self.surface == "project" and not mine:
                return mark
            pairs = [(site, url) for site, urls in mine.items() for url in urls]
            url = j.normal_url_sql(f"coalesce({alias}.url_norm,{alias}.url)")
            rule = (f"EXISTS(SELECT 1 FROM unnest({b([k for k, _ in pairs], 'text[]')},{b([u for _, u in pairs], 'text[]')}) AS r(site,url) "
                    f"WHERE r.site={alias}.project_id::text AND ({url}=r.url OR starts_with({url},r.url||'/')))")
            return rule if self.surface == "website" else f"(CASE WHEN {alias}.project_id::text=ANY({b(list(mine), 'text[]')}) THEN {rule} ELSE {mark} END)"
        codes = [name for name, bit in self.inputs.own_names.items() if bit & self.scope.bits]
        return f"(coalesce({alias}.is_owned,false) AND {alias}.matched_base_url IS NOT NULL AND lower({alias}.matched_brand)=ANY({b(codes or list(self.inputs.own_names), 'text[]')}))"

    def _target(self, b: Binder, alias: str = "c") -> str:
        """타겟 URL 인용 (judgments.is_target). Website: the URL the prompt names. Project: its 추적 URL where it registered any, the extraction's mark until then. Global: the mark."""
        mark = f"coalesce({alias}.tgt_hit,false)"
        url = j.normal_url_sql(f"coalesce({alias}.url_norm,{alias}.url)")
        if self.surface == "website":
            targets = self.inputs.prompt_targets
            return f"({alias}.prompt_id::text,{url}) IN (SELECT r.prompt,r.url FROM unnest({b(list(targets), 'text[]')},{b(list(targets.values()), 'text[]')}) AS r(prompt,url))"
        if self.surface == "project" and self.inputs.tracked:
            pairs = [(k, u) for k, urls in self.inputs.tracked.items() for u in urls]
            rule = (f"EXISTS(SELECT 1 FROM unnest({b([k for k, _ in pairs], 'text[]')},{b([u for _, u in pairs], 'text[]')}) AS r(project,url) "
                    f"WHERE r.project={alias}.project_id::text AND ({url}=r.url OR starts_with({url},r.url||'/')))")
            return f"(CASE WHEN {alias}.project_id::text=ANY({b(list(self.inputs.tracked), 'text[]')}) THEN {rule} ELSE {mark} END)"
        return mark

    async def citation_counts(self, group: Sequence[str] = (), *, owned: bool = True) -> list[dict]:
        b = Binder()
        rows = await self._fetch(f"""WITH {self._answers(b)} SELECT {_select(group)}count(*)::bigint AS base_answers,count(*) FILTER(WHERE a.analysis_state>=2)::bigint AS gap_answers
            FROM a WHERE a.citation_monitoring {_group_by(group)}""", b.args)
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        own, target = self._owned(b), self._target(b)
        marked = own if self.surface in ("website", "project") else "coalesce(c.loc_owned,false)"
        by = "".join(f"{GROUPS[g].replace('a.', 'c.')} AS {g}," for g in group)
        grouping = f"GROUP BY {','.join(GROUPS[g].replace('a.', 'c.') for g in group)}" if group else ""
        cited = await self._fetch(f"""WITH {answers},{cites} SELECT {by}count(*) FILTER(WHERE c.skey IS NOT NULL)::bigint AS citations,count(*)::bigint AS citations_all,
            count(*) FILTER(WHERE c.slug='{OFFICIAL_HMG}')::bigint AS official,count(*) FILTER(WHERE {target})::bigint AS target,
            count(*) FILTER(WHERE {own})::bigint AS owned,count(*) FILTER(WHERE {marked} OR {target})::bigint AS owned_or_target
            FROM c {grouping}""", b.args)
        return merge(rows, cited, group, ("citations", "citations_all", "official", "target", "owned", "owned_or_target"))

    async def category_counts(self, group: Sequence[str] = ()) -> list[dict]:
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        by = "".join(f"{GROUPS[g].replace('a.', 'c.')} AS {g}," for g in group)
        keys = "".join(f"{GROUPS[g].replace('a.', 'c.')}," for g in group)
        return await self._fetch(f"""WITH {answers},{cites} SELECT {by}c.slug,c.category AS name,count(*)::bigint AS citations FROM c WHERE c.skey IS NOT NULL
            GROUP BY {keys}c.slug,c.category""", b.args)

    async def source_counts(self) -> list[dict]:
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        own, target = self._owned(b), self._target(b)
        return await self._fetch(f"""WITH {answers},{cites} SELECT c.skey,coalesce(min(c.domain),c.skey) AS domain,c.slug,min(c.category) AS category,
            count(*)::bigint AS citations,count(DISTINCT c.answer_key)::bigint AS answers,count(DISTINCT c.prompt_id)::bigint AS prompts,
            count(*) FILTER(WHERE {own})::bigint AS owned,bool_or({target}) AS target
            FROM c WHERE c.skey IS NOT NULL GROUP BY c.skey,c.slug ORDER BY citations DESC,c.skey""", b.args)

    async def source_engine_counts(self) -> list[dict]:
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        return await self._fetch(f"""WITH {answers},{cites} SELECT c.engine,c.skey,coalesce(min(c.domain),c.skey) AS domain,c.slug,min(c.category) AS category_name,count(*)::int AS citations
            FROM c WHERE c.skey IS NOT NULL GROUP BY c.engine,c.skey,c.slug""", b.args)

    async def source_round_counts(self, categories: Sequence[str] | None = None) -> list[dict]:
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        pick = f" AND c.slug=ANY({b(list(categories), 'text[]')})" if categories else ""
        return await self._fetch(f"""WITH {answers},{cites} SELECT c.round_date,c.skey,min(c.domain) AS domain,c.slug,min(c.category) AS category,count(*)::bigint AS citations
            FROM c WHERE c.skey IS NOT NULL{pick} GROUP BY c.round_date,c.skey,c.slug""", b.args)

    async def prompt_citation_counts(self) -> dict:
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        cites = self._rows_of_citations(b)
        own = self._owned(b)
        rows = await self._fetch(f"""WITH {answers},{cites},q AS (SELECT c.prompt_id,count(*) FILTER(WHERE c.skey IS NOT NULL) AS hosted,count(*) FILTER(WHERE {own}) AS own FROM c GROUP BY 1)
            SELECT count(*) FILTER(WHERE q.hosted>0)::bigint AS cited_prompts,count(*) FILTER(WHERE q.own>0)::bigint AS own_cited_prompts,
            count(*) FILTER(WHERE q.hosted>0 AND q.own=0)::bigint AS uncited_prompts FROM q""", b.args)
        return rows[0]

    async def funnel_prompt_counts(self) -> list[dict]:
        """측정 프롬프트 per funnel stage."""
        b = Binder()
        return await self._fetch(f"""WITH {self._answers(b)} SELECT a.funnel,count(DISTINCT a.prompt_id)::int AS measured_prompts FROM a WHERE a.monitoring
            GROUP BY a.funnel ORDER BY a.funnel IS NULL,measured_prompts DESC,a.funnel""", b.args)

    async def branded_answers(self) -> list[dict]:
        """Per market, the representative answers of the prompts the catalog marks branded for the perspective."""
        wanted = sorted({k for k, bit in self.inputs.branded if bit & (self.scope.bits | 8)})
        b = Binder()
        return await self._fetch(f"""WITH {self._answers(b)} SELECT a.market AS country,count(*)::bigint AS answers FROM a
            WHERE a.representative AND a.prompt_id=ANY({b(wanted, 'text[]')}) GROUP BY a.market""", b.args)

    async def domain_answers(self) -> int:
        b = Binder()
        rows = await self._fetch(f"WITH {self._answers(b)} SELECT count(*)::int AS n FROM a WHERE a.citation_monitoring", b.args)
        return rows[0]["n"]

    async def stance_counts(self) -> list[dict]:
        """태도: the first turn's stances of the monitoring answers; own_bit by the roster and the brand's name."""
        i = self.inputs
        b = Binder()
        names, entities = list(i.own_names), list(i.own_entities)
        return await self._fetch(f"""WITH {self._answers(b, ('s3_stance_stances',))},
            s AS (SELECT o.stance,bit_or(coalesce(n.bit,0)|coalesce(e.bit,0)) OVER (PARTITION BY a.answer_key,o.entity_id) AS own_bit FROM a
                CROSS JOIN LATERAL jsonb_to_recordset(a.s3_stance_stances) o(entity_id text,brand_label text,stance text,turn_index int)
                LEFT JOIN unnest({b(names, 'text[]')},{b([i.own_names[k] for k in names], 'int[]')}) AS n(bare,bit) ON n.bare=lower(btrim(o.brand_label))
                LEFT JOIN unnest({b(entities, 'text[]')},{b([i.own_entities[k] for k in entities], 'int[]')}) AS e(id,bit) ON e.id=o.entity_id
                WHERE a.monitoring AND jsonb_typeof(a.s3_stance_stances)='array' AND o.turn_index=1)
            SELECT s.own_bit,CASE s.stance {STANCE_CODES} END AS stance,count(*)::int AS n FROM s GROUP BY 1,2""", b.args)

    async def url_counts(self, group: Sequence[str] = ()) -> list[dict]:
        """자사 · 타겟 URL 인용률 (gold_current.url_counts): website = the registered prompts, the answers representative; project = every eligible answer."""
        website = self.surface == "website"
        scope = "a.web_reg" if website else "a.eligible"
        b = Binder()
        rows = await self._fetch(f"WITH {self._answers(b)} SELECT {_select(group)}count(DISTINCT a.prompt_id)::bigint AS url_prompts FROM a WHERE {scope} {_group_by(group)}", b.args)
        b = Binder()
        answers = self._answers(b, self.CITATIONS)
        own, target = self._owned(b, "d"), self._target(b, "d")
        keys = "".join(f"pa.{g}," for g in group)
        rep = "pa.last_measured AND " if website else ""
        cited = await self._fetch(f"""WITH {answers},
            d AS (SELECT {_select(group)}a.answer_key,a.prompt_id,a.project_id,a.last_measured,q.url,q.url_norm,j2.loc_owned,j2.is_owned,j2.matched_brand,j2.matched_base_url,coalesce(j2.tgt_hit,false) AS tgt_hit
                FROM a CROSS JOIN LATERAL jsonb_to_recordset(a.s1_normalize_citations) q(citation_seq int,url text,url_norm text)
                LEFT JOIN LATERAL jsonb_to_recordset(a.s2_citation_judgments) j2(citation_seq int,loc_owned boolean,is_owned boolean,matched_brand text,matched_base_url text,tgt_hit boolean) ON j2.citation_seq=q.citation_seq
                WHERE {scope} AND jsonb_typeof(a.s1_normalize_citations)='array'),
            pa AS (SELECT {''.join(f'd.{g},' for g in group)}d.answer_key,d.prompt_id,d.last_measured,count(*) FILTER(WHERE {own}) AS owned,count(*) FILTER(WHERE {target}) AS target,
                count(*) FILTER(WHERE {own} OR {target}) AS owned_or_target FROM d GROUP BY {''.join(f'd.{g},' for g in group)}d.answer_key,d.prompt_id,d.last_measured)
            SELECT {keys}count(DISTINCT pa.prompt_id) FILTER(WHERE pa.owned>0)::bigint AS url_own_prompts,count(DISTINCT pa.prompt_id) FILTER(WHERE pa.target>0)::bigint AS url_target_prompts,
            count(*) FILTER(WHERE {rep}pa.owned_or_target>0)::bigint AS url_own_answers,count(*) FILTER(WHERE {rep}pa.owned_or_target>0 AND pa.target>0)::bigint AS url_target_answers
            FROM pa {('GROUP BY ' + keys.rstrip(',')) if group else ''}""", b.args)
        return merge(rows, cited, group, ("url_own_prompts", "url_target_prompts", "url_own_answers", "url_target_answers"))

    async def tone_counts(self) -> dict:
        """The answers where 당사's sentiment leans positive or negative: their distinct URLs, citations and answers."""
        b = Binder()
        answers = self._answers(b, (*self.MENTIONS, *self.CITATIONS))
        brands = self._rows_of_brands(b)
        cites = self._rows_of_citations(b)
        own = f"(br.own_bit & {b(self.scope.bits)})<>0"
        rows = await self._fetch(f"""WITH {answers},{brands},{cites},
            l AS (SELECT br.answer_key,CASE WHEN sum(br.s_pos)>sum(br.s_neg) THEN 'positive' WHEN sum(br.s_neg)>sum(br.s_pos) THEN 'negative' END AS tone FROM br WHERE {own} GROUP BY 1)
            SELECT l.tone,count(*)::bigint AS citations,count(DISTINCT coalesce(c.url_norm,c.url))::bigint AS urls,count(DISTINCT c.answer_key)::bigint AS answers
            FROM c JOIN l ON l.answer_key=c.answer_key WHERE l.tone IS NOT NULL GROUP BY 1""", b.args)
        tone = {k: {"urls": 0, "citations": 0, "answers": 0} for k in ("positive", "negative")}
        for r in rows:
            tone[r["tone"]] = {k: r[k] for k in ("urls", "citations", "answers")}
        return tone

    async def type_category_counts(self, categories: Sequence[str] | None = None) -> list[dict]:
        """Per category, the citations of the answers where 당사 has each type."""
        b = Binder()
        answers = self._answers(b, (*self.MENTIONS, *self.CITATIONS))
        brands = self._rows_of_brands(b)
        cites = self._rows_of_citations(b)
        pick = f" AND c.slug=ANY({b(list(categories), 'text[]')})" if categories else ""
        marks = ",".join(f"bool_or(br.t_{t}>0) AS t_{x}" for x, t in enumerate(TYPES))
        counts = ",".join(f"count(*) FILTER(WHERE t.t_{x})::bigint AS t_{TYPES[x]}" for x in range(len(TYPES)))
        return await self._fetch(f"""WITH {answers},{brands},{cites},
            t AS (SELECT br.answer_key,{marks} FROM br WHERE (br.own_bit & {b(self.scope.bits)})<>0 GROUP BY 1)
            SELECT c.slug,c.category AS name,{counts} FROM c JOIN t ON t.answer_key=c.answer_key WHERE c.skey IS NOT NULL{pick} GROUP BY c.slug,c.category""", b.args)

    # ── ACR ──

    ACR_LEVEL = "brand"

    def _cells(self, b: Binder, *, judged: bool = False) -> str:
        """CTEs: one row per ACR cell (SSOT 셀 = 프롬프트 × 엔진 × 국가) of the scope's rounds: the bundle measured last in the cycle, of a finished run, of a prompt the rule keeps.
        run_status settles what the old store's flag held (the stand-in has no value, read as finished); the round comes from the manifest.
        judged (the load job): every bundle stays in `cell`, with the rule's answer as acr_in."""
        s, i = self.scope, self.inputs
        is_global = s.surface == "global"
        hidden = b(i.hidden_markets, "text[]") if is_global else "'{}'::text[]"
        columns = replace(OBT_COLUMNS, market_hidden=OBT_COLUMNS.market_hidden.format(hidden=hidden), run_finished="coalesce(x.run_status,'completed')='completed'", is_acr="true", acr_iteration="1", analysis_state="0")
        filters = [f"y.surface={b(s.surface)}"]
        if s.projects:
            filters.append(f"y.project_id::text=ANY({b(list(s.projects), 'text[]')})")
        if s.engines:
            filters.append(f"lower(y.engine)=ANY({b([v.lower() for v in s.engines], 'text[]')})")
        if s.countries:
            filters.append(f"lower(y.country)=ANY({b([v.lower() for v in s.countries], 'text[]')})")
        if s.prompts is not None:
            filters.append(f"y.prompt_id::text=ANY({b(list(s.prompts), 'text[]')})")
        prompts = (f"unnest({b(i.prompt_ids, 'text[]')},{b(i.in_root, 'boolean[]')},{b(i.is_korean, 'boolean[]')},{b(i.regions, 'text[]')},{b(i.brand_group, 'int[]')}) "
                   "AS t(id,in_root,is_korean,regions,brand_group)")
        keep = f"AND (p.brand_group & {b(s.bits | 8)})<>0" if is_global and not judged else ""
        one = f"AND m.snapshot_id={b(s.snapshot, 'uuid')}" if s.snapshot else ""
        cell = (f"SELECT x.*,{j.eligible(columns, is_global=is_global)} AS acr_in FROM x JOIN p ON p.prompt_id=x.prompt_id" if judged
                else f"SELECT x.* FROM x JOIN p ON p.prompt_id=x.prompt_id WHERE x.last_measured AND {j.eligible(columns, is_global=is_global)} {keep}")
        return f"""run AS MATERIALIZED (SELECT m.snapshot_id AS run_key,m.round_date FROM ops.snapshot_manifest m JOIN ops.cycle k USING(cycle_id)
                WHERE m.status='public' AND k.surface={b(s.surface)} AND m.round_date=ANY({b(list(s.rounds), 'date[]')}) {one}),
            p AS MATERIALIZED (SELECT id AS prompt_id,in_root,is_korean,CASE WHEN regions='' THEN NULL ELSE string_to_array(regions,',') END AS regions,brand_group FROM {prompts}),
            x AS MATERIALIZED (SELECT y.prompt_run_id,y.prompt_id::text AS prompt_id,y.engine,y.country,y.lang,y.measured_at,y.run_status,y.s3_acr_valid_acr_iterations AS valid_acr,y.s3_acr_entities,run.round_date,
                row_number() OVER (PARTITION BY y.cycle_id,y.prompt_id,y.engine,y.country,y.lang ORDER BY y.measured_at DESC,y.prompt_run_id)=1 AS last_measured
                FROM silver_contract.acr_rollup y JOIN run USING(run_key) WHERE {' AND '.join(filters)}),
            cell AS MATERIALIZED ({cell})"""

    @staticmethod
    def _cell_select(group: Sequence[str]) -> str:
        return "".join(f"{CELL_GROUPS[g]} AS {g}," for g in group)

    @staticmethod
    def _cell_group_by(group: Sequence[str], *more: str) -> str:
        keys = [CELL_GROUPS[g] for g in group] + list(more)
        return f"GROUP BY {','.join(keys)}" if keys else ""

    def _cell_brands(self, b: Binder) -> str:
        """CTE e: a cell's brand rows, without the names the ranks leave out and the roster's excluded entities (what the old store's keep held)."""
        i = self.inputs
        names, entities = list(i.own_names), list(i.own_entities)
        return f"""e AS MATERIALIZED (SELECT cell.prompt_run_id,cell.round_date,cell.prompt_id,cell.engine,cell.country,o.brand,o.choice_count,o.appearance_count,coalesce(n.bit,0)|coalesce(r.bit,0) AS own_bit
                FROM cell CROSS JOIN LATERAL jsonb_to_recordset(cell.s3_acr_entities) o(entity_id text,brand text,rollup_level text,choice_count int,appearance_count int)
                LEFT JOIN unnest({b(names, 'text[]')},{b([i.own_names[k] for k in names], 'int[]')}) AS n(bare,bit) ON n.bare=lower(btrim(o.brand))
                LEFT JOIN unnest({b(entities, 'text[]')},{b([i.own_entities[k] for k in entities], 'int[]')}) AS r(id,bit) ON r.id=o.entity_id
                WHERE o.rollup_level='{self.ACR_LEVEL}' AND coalesce(btrim(o.brand),'')<>'' AND o.brand<>'(이름 없음)' AND NOT lower(btrim(o.brand))=ANY({b(sorted(j.NON_COMPETITOR_BRANDS), 'text[]')}) AND NOT o.entity_id=ANY({b(i.excluded_entities, 'text[]')}))"""

    async def acr_totals(self, group: Sequence[str] = ()) -> list[dict]:
        b = Binder()
        return await self._fetch(f"""WITH {self._cells(b)} SELECT {self._cell_select(group)}count(*)::bigint AS cells,coalesce(sum(cell.valid_acr),0)::bigint AS iterations,
            count(DISTINCT cell.prompt_id)::bigint AS acr_prompts,count(DISTINCT cell.engine)::bigint AS engines FROM cell {self._cell_group_by(group)}""", b.args)

    async def acr_brand_counts(self, group: Sequence[str] = ()) -> list[dict]:
        b = Binder()
        cells = self._cells(b)
        brands = self._cell_brands(b)
        keys = [CELL_GROUPS[g].replace("cell.", "e.") for g in group]
        selected = "".join(f"{k} AS {g}," for k, g in zip(keys, group))
        return await self._fetch(f"""WITH {cells},{brands} SELECT {selected}e.brand,bool_or((e.own_bit & {b(self.scope.bits)})<>0) AS is_own,bool_or(e.own_bit<>0) AS is_hmg,
            coalesce(sum(e.choice_count),0)::bigint AS choice,coalesce(sum(e.appearance_count),0)::bigint AS appearance,
            count(DISTINCT e.prompt_run_id) FILTER(WHERE e.appearance_count<>0)::bigint AS appeared_cells FROM e GROUP BY {','.join([*keys, 'e.brand'])}""", b.args)

    async def acr_own_cells(self) -> int:
        b = Binder()
        cells = self._cells(b)
        brands = self._cell_brands(b)
        rows = await self._fetch(f"""WITH {cells},{brands} SELECT count(DISTINCT e.prompt_run_id)::int AS n FROM e WHERE (e.own_bit & {b(self.scope.bits)})<>0 AND e.appearance_count<>0""", b.args)
        return rows[0]["n"]

    async def acr_pair_counts(self) -> list[dict]:
        return await self.acr_brand_counts(("prompt", "engine", "country"))


#: What the contract cannot answer, read from gold_db until the real OBT or the service's inputs hold it. Nothing is estimated.
#: domain_rows · source_counts · rival_citations: a source's is_social, owned brand and competitor brand (no contract field).
#: applied_prompts: the catalog read's own rule (Context). source_categories: over every round. acr_model_counts: a model's name (no contract field).
#: acr_duel_counts: an iteration's winner and shortlist (no contract field).
LEFT_ON_GOLD = frozenset({"domain_rows", "source_counts", "rival_citations", "applied_prompts", "source_categories", "acr_model_counts", "acr_duel_counts"})
#: Gold's key names (gold_reader's /v1 reads) -> the adapter's codes
GOLD_KEYS = {"round_date": "round", "engine_key": "engine", "geo_key": "country", "prompt_key": "prompt"}
_CACHE_SECONDS = 5
_cached: tuple[float, Inputs] | None = None
_public: dict[str, tuple[float, dict[date, str]]] = {}
_loaded: dict[str, tuple[float, dict[date, str]]] = {}


def enabled() -> bool:
    """HGH_METRIC_SOURCE=silver: the base counts come from the OBT. Set beside HGH_SILVER_DB_URL in .env.silver.local; a machine without them counts on gold_db."""
    return os.environ.get("HGH_METRIC_SOURCE", "").strip().lower() == "silver"


async def loaded_snapshots(conn: Any, surface: str) -> dict[date, str]:
    """The operating snapshots in the query tables, by round: what a kept value's snapshot id is made of when the reads count on those tables. conn = gold_db. Read at most every few seconds."""
    kept = _loaded.get(surface)
    now = time.monotonic()
    if kept is None or now - kept[0] >= _CACHE_SECONDS:
        rows = []
        if await conn.fetchval("SELECT to_regclass('gold.silver_load') IS NOT NULL"):
            rows = await conn.fetch("SELECT round_date,string_agg(snapshot_id::text,',' ORDER BY snapshot_id::text) AS ids FROM gold.silver_load WHERE surface=$1 GROUP BY 1", surface)
        kept = _loaded[surface] = (now, {r["round_date"]: r["ids"] for r in rows})
    return kept[1]


async def public_snapshots(surface: str) -> dict[date, str]:
    """The manifest's operating snapshots of a surface, by round: what a kept value's snapshot id is made of (T9.3). Read at most every few seconds."""
    kept = _public.get(surface)
    now = time.monotonic()
    if kept is None or now - kept[0] >= _CACHE_SECONDS:
        async with silver_db.connection() as conn:
            rows = await conn.fetch("""SELECT m.round_date,string_agg(m.snapshot_id::text,',' ORDER BY m.snapshot_id::text) AS ids
                FROM ops.snapshot_manifest m JOIN ops.cycle k USING(cycle_id) WHERE m.status='public' AND k.surface=$1 GROUP BY 1""", surface)
        kept = _public[surface] = (now, {r["round_date"]: r["ids"] for r in rows})
    return kept[1]


async def current_inputs(gold: Any) -> Inputs:
    """gold = the read's connection to gold_db."""
    global _cached
    now = time.monotonic()
    if _cached is None or now - _cached[0] >= _CACHE_SECONDS:
        async with input_db.connection() as conn:
            inputs = await read_inputs(conn)
        # on the read's own connection: asking the pool for another while every read holds one waits for ever
        past = await gold.fetch("""SELECT prompt_id::text AS id,in_root_catalog_all,cat_mask_all FROM gold.dim_prompt
            WHERE surface=1 AND (cat_mask_all,in_root_catalog_all) IS DISTINCT FROM (cat_mask,in_root_catalog)""")
        _cached = (now, with_past_catalogs(inputs, past))
    return _cached[1]


class ObtForContext:
    """A /v1 read's Context on adapter ②: the scope comes from it, and rows answer in Gold's keys as well, as gold_reader and the screens read them. Goes with gold_reader at T12."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.surface = ctx.surface
        self.snapshot_id = "silver"
        self.gold = GoldCurrentSource(ctx)

    def for_rounds(self, rounds: Sequence[date]) -> ObtForContext:
        ctx = copy(self.ctx)
        ctx.selected_dates = sorted(rounds)
        return type(self)(ctx)

    def _outside(self) -> bool:
        """A drill by a mentioned brand or a custom field has no scope here yet."""
        return bool(getattr(self.ctx, "mention", None)) or any(k.startswith("cf.") or k == "source" for k in self.ctx.q)

    async def _scope(self) -> Scope:
        ctx = self.ctx
        conn = ctx.conn
        await ctx.load_catalog()
        project = []
        if ctx.project_key is not None:
            project = [await conn.fetchval("SELECT coalesce(scope_project_id,project_id)::text FROM gold.dim_project WHERE project_key=$1", ctx.project_key)]
        prompts = None
        if ctx.catalog_prompts is not None:
            prompts = tuple(r["id"] for r in await conn.fetch("SELECT prompt_id::text AS id FROM gold.dim_prompt WHERE prompt_key=ANY($1::int[])", list(ctx.catalog_prompts)))
        elif ctx.sf == 3:  # a project's taxonomy picks are on its prompts, not on the standard catalog
            b = SQL()
            if picks := ctx.taxon_where(b, "p"):
                prompts = tuple(r["id"] for r in await conn.fetch(f"SELECT p.prompt_id::text AS id FROM gold.dim_prompt p WHERE p.project_key={b.bind(ctx.project_key, 'smallint')} AND {' AND '.join(picks)}", *b.args))
        return Scope(ctx.surface, tuple(ctx.selected_dates), ctx.bits, tuple(project), tuple(values(ctx.q, "country")), tuple(values(ctx.q, "lang")), tuple(values(ctx.q, "engine")),
                     prompts, bool(values(ctx.q, "brand")))

    async def _keys(self, rows: list[dict]) -> list[dict]:
        """Gold's keys on the rows: engine_key · geo_key · prompt_key · round_date · a brand's number · a category's number."""
        conn = self.ctx.conn
        sample = rows[0] if rows else {}
        engines = {r["code"]: r["engine_key"] for r in await conn.fetch("SELECT code,engine_key FROM gold.dim_engine")} if "engine" in sample else {}
        markets = {r["code"]: r["geo_key"] for r in await conn.fetch("SELECT code,geo_key FROM gold.dim_country")} if "country" in sample else {}
        prompts = {r["id"]: r["prompt_key"] for r in await conn.fetch("SELECT prompt_id::text AS id,prompt_key FROM gold.dim_prompt WHERE prompt_id::text=ANY($1::text[])", sorted({r["prompt"] for r in rows}))} if "prompt" in sample else {}
        brands = {r["name"]: r["brand_key"] for r in await conn.fetch("SELECT name,brand_key FROM gold.dim_brand WHERE name IS NOT NULL")} if "brand_key" in sample else {}
        categories = {r["slug"]: r["category_key"] for r in await conn.fetch("SELECT slug,category_key FROM gold.dim_category")} if "slug" in sample else {}
        for r in rows:
            if "round" in r:
                r["round_date"] = r["round"]
            if "engine" in r:
                r["engine_key"] = engines.get(r["engine"])
            if "country" in r:
                r["geo_key"] = markets.get(r["country"])
            if "prompt" in r:
                r["prompt_key"] = prompts.get(r["prompt"])
            if "brand_key" in r:
                r["brand_key"] = brands.get(r["brand_key"], r["brand_key"])
            if "slug" in r:
                r["category_key"] = categories.get(r["slug"])
        return rows

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__") or not hasattr(SilverObtSource, name) and name not in LEFT_ON_GOLD:
            raise AttributeError(name)

        async def call(*args: Any, **kwargs: Any) -> Any:
            if name in LEFT_ON_GOLD or self._outside():
                return await getattr(self.gold, name)(*args, **kwargs)
            args = tuple(tuple(GOLD_KEYS.get(g, g) for g in a) if isinstance(a, (list, tuple)) and name != "source_round_counts" and name != "type_category_counts" else a for a in args)
            if kwargs.get("group"):
                kwargs["group"] = tuple(GOLD_KEYS.get(g, g) for g in kwargs["group"])
            if kwargs.get("brand_keys"):
                wanted = [str(k) for k in kwargs["brand_keys"]]
                kwargs["brand_keys"] = [r["name"] for r in await self.ctx.conn.fetch("SELECT name FROM gold.dim_brand WHERE brand_key::text=ANY($1::text[])", wanted)] or wanted
            inputs = await current_inputs(self.ctx.conn)
            scope = await self._scope()
            group = kwargs.get("group") or next((a for a in args if isinstance(a, tuple)), ())
            # a call by round is counted round by round, side by side up to the pool's size: a round's query does not grow with the others
            parts = [(day,) for day in scope.rounds] if "round" in group and len(scope.rounds) > 1 else [scope.rounds]

            async def count(rounds: tuple) -> Any:
                async with silver_db.connection() as conn:
                    return await getattr(SilverObtSource(conn, scope._replace(rounds=rounds), inputs), name)(*args, **kwargs)
            counted = await asyncio.gather(*(count(rounds) for rounds in parts))
            out = counted[0] if len(counted) == 1 else [row for rows in counted for row in rows]
            return await self._keys(out) if isinstance(out, list) else out
        return call
