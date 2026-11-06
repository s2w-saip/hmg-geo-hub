"""조회용 테이블 적재 잡 (T9.7, docs/handoff/query-tables-scope.md).

Each operating snapshot in the manifest goes into gold_db's query tables once: facts under the cycle's builds, raw rows by answer, new keys in the dimensions. One snapshot is
one transaction, so a read sees a cycle's old rows or its new ones. A snapshot that moves replaces its cycle's rows; the rest stays.

It reads contract columns only, through the same SQL as the Silver adapter where a value is judged (data_server.metrics.silver_obt), so the two count alike. What the contract
has no column for keeps the value already here and stays empty on a new row, never estimated: a source's owned and competitor marks, a product's name, an ACR iteration's winner.
The judgments it stores are the rules' answers at load time (is_rep, acr_in, an ACR brand row's keep). Inputs reach these tables when this job runs: dim_prompt follows the input store row by
row, and a change that the stored judgments rest on (inputs_digest) loads every cycle again. What a read judges itself (registered URLs, excluded names) still applies at once."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

import asyncpg

from data_server.metrics import judgments as j
from data_server.metrics.silver_obt import HANGUL, Binder, Inputs, Scope, SilverObtSource, read_inputs, with_past_catalogs

log = logging.getLogger("hgh.query_load")

SURFACES = {"global": 1, "website": 2, "project": 3}
LEVELS = {"brand": 1, "model": 2, "company": 3}
STANCES = {"positive": 1, "neutral": 2, "mixed": 3, "negative": 4}
CATEGORY_SOURCES = {"override": 1, "official_social": 2, "owned_domain": 3, "seed": 4, "rule": 5, "default": 6}
NO_NAME = "(이름 없음)"
LOCK = 617427431  # one load at a time
#: all perspectives: the load keeps every answer, a read picks its brands
EVERY_BIT = 15
BATCH = 2000

ANSWER_FACT = ("build_id", "surface", "round_date", "answer_key", "cyc_key", "prompt_key", "project_key", "engine_key", "geo_key", "lang_key", "bgrp", "anchor_date", "anchor_src",
               "region_geo_key", "acr_iter_rank", "analysis_state", "dflt", "is_acr", "is_rep", "web_reg", "gap", "rule_ver")
BRAND_FACT = ("build_id", "surface", "round_date", "answer_key", "brand_key", "competitive", "cyc_key", "prompt_key", "project_key", "engine_key", "geo_key", "lang_key", "bgrp", "own_bit",
              "mention_count", "rk", "first_pos", "s_pos", "s_neu", "s_neg", "s_mix", "t_mention", "t_recommendation", "t_comparison", "t_definition", "t_final_choice", "is_rep", "rule_ver")
CITATION_FACT = ("build_id", "surface", "round_date", "answer_key", "ord", "url_key", "source_key", "cyc_key", "prompt_key", "project_key", "engine_key", "geo_key", "lang_key", "bgrp",
                 "owner_key", "gap", "is_rep", "loc_owned", "tgt_hit", "rule_ver")
STANCE_FACT = ("build_id", "surface", "round_date", "answer_key", "turn_index", "entity_key", "brand_key", "cyc_key", "own_bit", "stance", "first_turn", "is_rep")
JOB_INDEX = ("answer_key", "job_id", "cyc_key", "prompt_key", "project_key", "engine_key", "geo_key", "lang_key", "bgrp", "surface", "round_date", "measured_at", "status_code", "analysis_code",
             "dropped", "served", "last_build_id")
BODY = ("answer_key", "job_id", "run_id", "surface", "project_key", "geo_key", "bgrp", "answer_text", "model_slug", "measured_at", "status", "analysis_status", "region")
MENTION_RAW = ("answer_key", "ord", "surface", "project_key", "geo_key", "bgrp", "entity_id", "entity_key", "registry_role", "entity_type", "display_name", "mention_count", "avg_position",
               "brand_rollup_entity_id", "surfaces", "sentiment_positive", "sentiment_neutral", "sentiment_negative", "sentiment_mixed", "type_mention", "type_recommendation", "type_comparison",
               "type_definition", "type_final_choice")
OCCURRENCE = ("answer_key", "ord", "surface", "project_key", "geo_key", "bgrp", "entity_id", "turn_index", "source_start", "source_end", "surface_text", "sentiment", "mention_role", "assertion",
              "context_snippet", "descriptors", "criteria")
STANCE_RAW = ("answer_key", "turn_index", "entity_id", "surface", "project_key", "geo_key", "bgrp", "brand_label", "stance", "confidence", "evidence_text", "evidence_start", "evidence_end", "reason")
ACR_CELL = ("build_id", "acr_cell_key", "surface", "cyc_key", "prompt_key", "project_key", "engine_key", "geo_key", "lang_key", "bgrp", "round_date", "measured_date", "planned", "valid_turn1",
            "valid_acr", "co_single", "co_conditional", "co_generic", "co_off_shortlist", "co_unresolved", "co_none", "is_rep", "acr_in", "rule_ver")
ACR_ENTITY = ("build_id", "acr_cell_key", "level", "entity_key", "brand_key", "parent_brand_key", "own_bit", "appearance", "choice", "cond_choice", "off_shortlist", "unresolved", "generic", "keep")

ALL_ANSWERS = """SELECT answer_key::text AS id,prompt_id::text AS prompt_id,project_id::text AS project_id,run_id,engine,country,lang,measured_at,model_slug,s1_normalize_answer_status AS status,
    s1_normalize_is_dropped AS dropped,s1_normalize_anchor_date AS anchor_date,s1_normalize_round_date AS round_date,s1_normalize_view_anchor_date AS view_date,
    s1_normalize_is_default_engine AS dflt,s1_normalize_anchor_source AS anchor_src,analysis_state,analysis_label
    FROM silver_contract.answer_analysis WHERE run_key=$1"""
ROLLUP_NAMES = """SELECT DISTINCT ON (o.entity_id) o.entity_id,o.brand FROM silver_contract.answer_analysis y
    CROSS JOIN LATERAL jsonb_to_recordset(y.s2_mention_rollups) o(entity_id text,brand text,brand_rollup_entity_id text)
    WHERE y.surface=$1 AND y.s1_normalize_round_date=$2 AND y.s1_normalize_answer_status='completed' AND jsonb_typeof(y.s2_mention_rollups)='array'
    AND o.entity_id=o.brand_rollup_entity_id AND coalesce(btrim(o.brand),'')<>'' ORDER BY o.entity_id,o.brand"""
MIRROR_CYCLES = """UPDATE gold.dim_cycle SET status=CASE WHEN cycle_id=ANY($1::uuid[]) THEN 0 ELSE 3 END,servable=false
    WHERE NOT cycle_id=ANY($2::uuid[]) AND (status IS DISTINCT FROM CASE WHEN cycle_id=ANY($1::uuid[]) THEN 0 ELSE 3 END OR servable)"""
ANSWER_JSON = """SELECT answer_key::text AS id,answer_text,s1_normalize_citations AS citations,s2_mention_rollups AS rollups,s2_mention_occurrences AS occurrences,s2_citation_judgments AS judgments,
    s3_semantics_rollups AS semantics,s3_semantics_occurrences AS semantic_occurrences,s3_stance_stances AS stances FROM silver_contract.answer_analysis WHERE run_key=$1"""
ACR_ROWS = """SELECT prompt_run_id::text AS id,prompt_id::text AS prompt_id,project_id::text AS project_id,engine,country,lang,measured_at,s3_acr_planned_iterations AS planned,
    s3_acr_valid_turn1_iterations AS valid_turn1,s3_acr_valid_acr_iterations AS valid_acr,s3_acr_co_single_entity AS co_single,s3_acr_co_conditional_multiple AS co_conditional,
    s3_acr_co_generic_category AS co_generic,s3_acr_co_resolved_off_shortlist AS co_off_shortlist,s3_acr_co_unresolved_choice AS co_unresolved,s3_acr_co_none AS co_none,
    s3_acr_entities AS entities FROM silver_contract.acr_rollup WHERE run_key=$1"""
MANIFEST = """SELECT m.snapshot_id::text AS snapshot_id,m.cycle_id::text AS cycle_id,m.round_date,m.rule_version,k.surface FROM ops.snapshot_manifest m JOIN ops.cycle k USING(cycle_id)
    WHERE m.status='public' ORDER BY m.round_date,m.cycle_id"""


def sha(url: str) -> str:
    """dim_url.url_hash, as legacy keys a URL (sha256 of its text)."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def array(value: Any) -> list:
    """A contract JSON column as a list ('[]' for what holds none)."""
    data = json.loads(value) if isinstance(value, str) else value
    return data if isinstance(data, list) else []


def number(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def inputs_digest(inputs: Inputs) -> str:
    """What the stored judgments and groups rest on: a change loads every cycle again. Not the registered URLs or a prompt's funnel, which a read takes as they are."""
    held = (inputs.prompt_ids, inputs.in_root, inputs.is_korean, inputs.regions, inputs.is_acr, inputs.web_reg, inputs.brand_group, sorted(inputs.hidden_markets), sorted(inputs.own_names.items()),
            sorted(inputs.own_entities.items()), sorted(inputs.sites.items(), key=lambda kv: kv[0]), sorted(inputs.excluded_entities))
    return hashlib.sha256(json.dumps(held, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:16]


def taxon_keys(d: Mapping[str, Any], taxons: Mapping[tuple, int]) -> dict[str, int | None]:
    """A definition's taxonomy as keys. A depth's code means something under its parent only."""
    depth1 = taxons.get(("depth1", d.get("depth1"), None))
    depth2 = taxons.get(("depth2", d.get("depth2"), depth1))
    depth3 = taxons.get(("depth3", d.get("depth3"), depth2))
    return {"funnel_key": taxons.get(("funnel", d.get("funnel"), None)), "presence_key": taxons.get(("presence", d.get("brand_presence"), None)),
            "list_type_key": taxons.get(("list_type", d.get("list_type"), None)), "depth1_key": depth1, "depth2_key": depth2, "depth3_key": depth3, "depth4_key": None}


def catalog_rows(prompts: Iterable[Mapping[str, Any]], keys: Mapping[str, int], taxons: Mapping[tuple, int]) -> list[tuple]:
    """catalog_entry of a new fact build: every catalog row of the input store (a build holds all of them: 12,164 on every Global build, equal to the store's, 2026-11-07)."""
    rows = []
    for p in prompts:
        key = keys.get(p["id"])
        for e in p["catalogs"]:
            t = taxon_keys(e, taxons)
            if key is not None and e.get("catalog_row_id"):
                rows.append((e["catalog_row_id"], key, e.get("brand_bit"), e.get("kind"), t["presence_key"], t["funnel_key"], t["list_type_key"], t["depth1_key"], t["depth2_key"], t["depth3_key"], None))
    return rows


def prompt_values(text: str | None, d: Mapping[str, Any], langs: Mapping[str, int], taxons: Mapping[tuple, int]) -> dict[str, Any]:
    """dim_prompt's values from a prompt's definition (checked on all 28,750 prompts: equal, 2026-11-07). A website prompt's target is its target_url, as URLs are compared."""
    target = d.get("target_url")
    return {"text": text, "kind": d.get("kind"), "lang_key": langs.get((d.get("language") or "").lower(), 0), **taxon_keys(d, taxons), "in_project_catalog": bool(d.get("in_project_catalog")),
            "in_root_catalog": bool(d.get("in_root_catalog")), "web_reg": bool(d.get("web_reg")), "regions": d.get("regions") or None, "targets": [j.normal_url(target)] if target else None,
            "is_korean": HANGUL.search(text or "") is not None, "cat_mask": sum({e.get("brand_bit") or 0 for e in d.get("catalogs") or []}) if d.get("catalogs") else 0}


async def sync_prompts(gold: Any, source: Any, rule: str | None) -> dict[str, int]:
    """dim_prompt from the input store: a new prompt gets a key, a changed one its new values. What a prompt once was in the catalog stays (cat_mask_all, in_root_catalog_all)."""
    langs = {(r["code"] or "").lower(): r["lang_key"] for r in await gold.fetch("SELECT code,lang_key FROM gold.dim_lang")}
    taxons = {(r["axis"], r["code"], r["parent_key"]): r["taxon_key"] for r in await gold.fetch("SELECT axis,code,parent_key,taxon_key FROM gold.dim_taxon")}
    projects = {r["id"]: r["project_key"] for r in await gold.fetch("SELECT scope_project_id::text AS id,project_key FROM gold.dim_project WHERE scope_project_id IS NOT NULL")}
    old = {r["id"]: r for r in await gold.fetch("SELECT prompt_id::text AS id,* FROM gold.dim_prompt WHERE prompt_id IS NOT NULL")}
    next_key = await gold.fetchval("SELECT coalesce(max(prompt_key),0) FROM gold.dim_prompt")
    counts = {"new_prompts": 0, "changed_prompts": 0, "unknown_project": 0}
    for r in await source.fetch("SELECT prompt_id::text AS id,project_id::text AS project,text,definition::text AS d FROM catalog.current_prompt"):
        d = json.loads(r["d"])
        want = prompt_values(r["text"], d, langs, taxons)
        have = old.get(r["id"])
        if have is None:
            project = projects.get(r["project"])
            if project is None:
                counts["unknown_project"] += 1
                continue
            next_key += 1
            await gold.execute("""INSERT INTO gold.dim_prompt(prompt_key,prompt_id,surface,kind,project_key,text,lang_key,funnel_key,presence_key,list_type_key,depth1_key,depth2_key,depth3_key,depth4_key,
                in_project_catalog,cat_mask,cat_mask_all,in_root_catalog,in_root_catalog_all,web_reg,regions,targets,is_korean,rule_ver) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$17,$18,$19,$20,$21,$22)""",
                               next_key, r["id"], d.get("surface"), want["kind"], project, want["text"], want["lang_key"], want["funnel_key"], want["presence_key"], want["list_type_key"], want["depth1_key"],
                               want["depth2_key"], want["depth3_key"], want["depth4_key"], want["in_project_catalog"], want["cat_mask"], want["in_root_catalog"], want["web_reg"], want["regions"], want["targets"], want["is_korean"], rule)
            counts["new_prompts"] += 1
            continue
        changed = {k: v for k, v in want.items() if not same_value(k, have[k], v)}
        changed.pop("depth4_key", None)
        if changed:
            sets = ",".join(f"{k}=${i}" for i, k in enumerate(changed, 2))
            await gold.execute(f"UPDATE gold.dim_prompt SET {sets},cat_mask_all=coalesce(cat_mask_all,0)|coalesce(cat_mask,0),in_root_catalog_all=coalesce(in_root_catalog_all,false) OR coalesce(in_root_catalog,false) WHERE prompt_key=$1",
                               have["prompt_key"], *changed.values())
            counts["changed_prompts"] += 1
    return counts


def same_value(column: str, have: Any, want: Any) -> bool:
    """A prompt's regions are a set, and an empty list is no list."""
    if column == "regions":
        return sorted(have or []) == sorted(want or [])
    if column == "targets":
        return (have or None) == (want or None)
    return have == want


def owner_of(candidates: Sequence[tuple[int, str | None]], url_owner: int | None, country: str | None, market: str | None) -> int:
    """The owned base a citation matched. One address can be the base of several markets: the extraction's country says which, else what the URL already holds, else the answer's market."""
    if not candidates:
        return 0
    for owner, geo in candidates:
        if country and geo == country:
            return owner
    if url_owner and any(owner == url_owner for owner, _ in candidates):
        return url_owner
    for owner, geo in candidates:
        if market and geo == market:
            return owner
    return candidates[0][0]


def status_code(status: str | None) -> int:
    """job_index.status_code: legacy's 0 = finished, 2 = failed. A finished answer is served."""
    return 0 if status == "completed" else 2


@dataclass
class Snapshot:
    snapshot_id: str
    cycle_id: str
    round_date: date
    rule_version: str | None
    surface: str


@dataclass
class Dims:
    """Keys of the dimensions, read once. A new key takes the next free number; only this job writes them (LOCK)."""
    engines: dict[str, int] = field(default_factory=dict)
    countries: dict[str, int] = field(default_factory=dict)
    langs: dict[str, int] = field(default_factory=dict)
    prompts: dict[str, tuple[int, int]] = field(default_factory=dict)
    projects: dict[str, int] = field(default_factory=dict)
    brands: dict[str, int] = field(default_factory=dict)
    bares: dict[str, int] = field(default_factory=dict)
    entities: dict[str, tuple[int, int | None, str | None, str | None]] = field(default_factory=dict)
    sources: dict[str, int] = field(default_factory=dict)
    categories: dict[str, int] = field(default_factory=dict)
    owners: dict[tuple[str | None, str | None], list[tuple[int, str | None]]] = field(default_factory=dict)
    next_keys: dict[str, int] = field(default_factory=dict)
    new_brands: list[tuple] = field(default_factory=list)
    new_entities: list[tuple] = field(default_factory=list)
    new_sources: list[tuple] = field(default_factory=list)

    def take(self, name: str) -> int:
        self.next_keys[name] += 1
        return self.next_keys[name]

    def brand(self, name: str | None, own_bit: int, day: date) -> int | None:
        """The brand's key by its name, a new row for a name not seen. '(이름 없음)' is key 0."""
        clean = (name or "").strip()
        if not clean:
            return None
        if clean == NO_NAME:
            return 0
        bare = clean.lower()
        key = self.brands.get(clean, self.bares.get(bare))
        if key is None:
            key = self.take("brand")
            kind = 1 if own_bit else (3 if bare in j.NON_COMPETITOR_BRANDS else 2)
            self.new_brands.append((key, clean, bare, kind, own_bit, day))
            self.brands[clean], self.bares[bare] = key, key
        return key

    def known_brand(self, name: str | None) -> int | None:
        clean = (name or "").strip()
        return self.brands.get(clean, self.bares.get(clean.lower())) if clean else None

    def entity(self, entity_id: str | None, entity_type: str | None, brand: str | None, role: str | None, own_names: Mapping[str, int], day: date) -> int | None:
        """The entity's key; a new one takes its brand and, when it is a brand itself, that name. A product's name is not in the contract and stays empty."""
        if not entity_id:
            return None
        known = self.entities.get(entity_id)
        if known:
            return known[0]
        key = self.take("entity")
        clean = (brand or "").strip()
        brand_key = self.brand(clean, own_names.get(clean.lower(), 0), day) if clean else None
        name = clean if entity_type == "Brand" and clean and clean != NO_NAME else None
        self.new_entities.append((key, entity_id, entity_type, role, name, brand_key))
        self.entities[entity_id] = (key, brand_key, role, name)
        return key

    def source(self, skey: str | None, domain: str | None, category: str | None, method: str | None, rule: str | None) -> int:
        """The source's key by its group key. is_social is legacy's rule (back/ingest/project/apply/queries.py DIM_SOURCE). Its owned and competitor marks are not in the contract."""
        if not skey:
            return 0
        key = self.sources.get(skey)
        if key is None:
            key = self.take("source")
            self.new_sources.append((key, skey, domain, skey != domain, self.categories.get(category or "", self.categories.get("", 13)), CATEGORY_SOURCES.get(method or "", 6), 0, None, rule))
            self.sources[skey] = key
        return key


async def read_dims(gold: Any) -> Dims:
    d = Dims()
    d.engines = {r["code"].lower(): r["engine_key"] for r in await gold.fetch("SELECT code,engine_key FROM gold.dim_engine")}
    d.countries = {r["code"]: r["geo_key"] for r in await gold.fetch("SELECT code,geo_key FROM gold.dim_country")}
    d.langs = {(r["code"] or "").upper(): r["lang_key"] for r in await gold.fetch("SELECT code,lang_key FROM gold.dim_lang")}
    d.prompts = {r["id"]: (r["prompt_key"], r["project_key"]) for r in await gold.fetch("SELECT prompt_id::text AS id,prompt_key,project_key FROM gold.dim_prompt")}
    d.projects = {r["id"]: r["project_key"] for r in await gold.fetch("SELECT scope_project_id::text AS id,project_key FROM gold.dim_project WHERE scope_project_id IS NOT NULL")}
    for r in await gold.fetch("SELECT brand_key,name,bare FROM gold.dim_brand"):
        if r["name"]:
            d.brands[r["name"]] = r["brand_key"]
        if r["bare"]:
            d.bares[r["bare"]] = r["brand_key"]
    d.entities = {r["id"]: (r["entity_key"], r["brand_key"], r["registry_role"], r["rep_name"]) for r in await gold.fetch("SELECT entity_id::text AS id,entity_key,brand_key,registry_role,rep_name FROM gold.dim_entity WHERE entity_id IS NOT NULL")}
    d.sources = {r["skey"]: r["source_key"] for r in await gold.fetch("SELECT skey,source_key FROM gold.dim_source WHERE skey<>''")}
    d.categories = {r["name"]: r["category_key"] for r in await gold.fetch("SELECT name,category_key FROM gold.dim_category")}
    for r in await gold.fetch("SELECT owner_key,brand_code,prefix,geo_code FROM gold.dim_owned_base WHERE prefix IS NOT NULL ORDER BY owner_key"):
        d.owners.setdefault((r["brand_code"], r["prefix"]), []).append((r["owner_key"], r["geo_code"]))
    row = await gold.fetchrow("""SELECT (SELECT coalesce(max(brand_key),0) FROM gold.dim_brand) AS brand,(SELECT coalesce(max(entity_key),0) FROM gold.dim_entity) AS entity,
        (SELECT coalesce(max(source_key),0) FROM gold.dim_source) AS source,(SELECT coalesce(max(url_key),0) FROM gold.dim_url) AS url,
        (SELECT coalesce(max(answer_key),0) FROM gold.job_index) AS answer,(SELECT coalesce(max(acr_cell_key),0) FROM gold.acr_cell_run) AS cell,
        (SELECT coalesce(max(cyc_key),0) FROM gold.dim_cycle) AS cycle,(SELECT coalesce(max(build_id),0) FROM gold.build) AS build""")
    d.next_keys = dict(row)
    return d


async def flush_dims(gold: Any, d: Dims) -> None:
    if d.new_brands:
        await gold.copy_records_to_table("dim_brand", schema_name="gold", columns=("brand_key", "name", "bare", "kind", "own_bit", "first_seen"), records=d.new_brands)
        d.new_brands = []
    if d.new_entities:
        await gold.copy_records_to_table("dim_entity", schema_name="gold", columns=("entity_key", "entity_id", "entity_type", "registry_role", "rep_name", "brand_key"), records=d.new_entities)
        d.new_entities = []
    if d.new_sources:
        await gold.copy_records_to_table("dim_source", schema_name="gold", columns=("source_key", "skey", "domain", "is_social", "category_key", "category_src", "owned_brand_bit", "competitor_brand_key", "rule_ver"),
                                         records=d.new_sources)
        d.new_sources = []


CATALOG_ENTRY = ("catalog_row_id", "prompt_key", "brand_bit", "kind", "presence_key", "funnel_key", "list_type_key", "depth1_key", "depth2_key", "depth3_key", "depth4_key", "build_id")


async def builds_of(gold: Any, d: Dims, surface: str, cyc_key: int, snapshot: Snapshot, catalog: Sequence[tuple] = ()) -> dict[str, int]:
    """The cycle's fact and ACR builds in the live release: its own again (what stays on them, the ACR iterations, stays with it), new ones for a new cycle."""
    release = await gold.fetchval("SELECT release_id FROM gold.active_release WHERE scope=$1 AND read_mode='live'", surface)
    if release is None:
        raise RuntimeError(f"No live release for {surface}")
    slice_key = f"cyc:{cyc_key}"
    out = {}
    for family in ("fact", "acr"):
        build = await gold.fetchval("SELECT build_id FROM gold.release_item WHERE release_id=$1 AND family=$2 AND slice_key=$3", release, family, slice_key)
        if build is None:
            build = d.take("build")
            await gold.execute("INSERT INTO gold.build(build_id,family,slice_key,rule_ver,status,started_at) VALUES($1,$2,$3,$4,'validated',now())", build, family, slice_key, snapshot.rule_version)
            await gold.execute("INSERT INTO gold.release_item(release_id,family,slice_key,build_id,state) VALUES($1,$2,$3,$4,'ready')", release, family, slice_key, build)
            if family == "fact" and surface == "global" and catalog:
                await gold.copy_records_to_table("catalog_entry", schema_name="gold", columns=CATALOG_ENTRY, records=[(*row, build) for row in catalog])
        await gold.execute("UPDATE gold.build SET input_snapshot=$2,finished_at=now() WHERE build_id=$1", build, snapshot.snapshot_id)
        out[family] = build
    return out


async def cycle_key(gold: Any, d: Dims, snap: Snapshot, answers: Sequence[Mapping[str, Any]], project_key: int | None) -> int:
    """dim_cycle: a public snapshot is what the screens serve (SSOT 운영 반영), so the old flags that hid a cycle no longer apply (decision '옛 값이 숨긴 회차도 센다')."""
    anchors = [a["anchor_date"] for a in answers if a["anchor_date"]]
    anchor = min(anchors) if anchors else None
    key = await gold.fetchval("""UPDATE gold.dim_cycle SET status=2,servable=true,hidden_scope=NULL,hidden_reason=NULL,round_date=$2,anchor_date=coalesce($3,anchor_date),view_date=NULL
        WHERE cycle_id=$1 RETURNING cyc_key""", snap.cycle_id, snap.round_date, anchor)
    if key is None:
        key = d.take("cycle")
        await gold.execute("""INSERT INTO gold.dim_cycle(cyc_key,cycle_id,surface,project_key,round_date,anchor_date,status,servable) VALUES($1,$2,$3,$4,$5,$6,2,true)""",
                           key, snap.cycle_id, SURFACES[snap.surface], project_key, snap.round_date, anchor)
    return key


class Loader:
    def __init__(self, gold: Any, silver: Any, inputs: Inputs, dims: Dims, digest: str = "", catalog: Sequence[tuple] = ()) -> None:
        self.gold, self.silver, self.inputs, self.d, self.digest, self.catalog = gold, silver, inputs, dims, digest, catalog
        self.index = {p: i for i, p in enumerate(inputs.prompt_ids)}
        self.rollups: dict[tuple[str, date], dict[str, str]] = {}

    async def rollup_names(self, surface: str, day: date) -> dict[str, str]:
        """A rollup entity's name over the whole round: one site's snapshot may hold a product and not its brand's own row, and the two must fold alike."""
        key = (surface, day)
        if key not in self.rollups:
            self.rollups = {key: {r["entity_id"]: r["brand"] for r in await self.silver.fetch(ROLLUP_NAMES, surface, day)}, **{k: v for k, v in self.rollups.items() if k[1] == day}}
        return self.rollups[key]

    def bgrp(self, surface: str, prompt_id: str, project_id: str | None) -> int:
        """Global: the prompt's catalog brands. Website: the site's brand."""
        if surface == "global":
            i = self.index.get(prompt_id)
            return self.inputs.brand_group[i] if i is not None else 0
        if surface == "website":
            return self.inputs.sites.get(project_id or "", (None, 0))[1]
        return 0

    def market(self, surface: str, project_id: str | None, country: str | None) -> str | None:
        """The answer's market: on website the site's country, as country there is where it was measured from (the Silver adapter's)."""
        return (self.inputs.sites.get(project_id or "", (None, 0))[0] or country) if surface == "website" else country

    def role(self, entity_id: str) -> str | None:
        return "own" if entity_id in self.inputs.own_entities else "excluded" if entity_id in self._excluded else None

    @property
    def _excluded(self) -> frozenset[str]:
        if not hasattr(self, "_excluded_set"):
            self._excluded_set = frozenset(self.inputs.excluded_entities)
        return self._excluded_set

    def own_bit(self, name: str | None, entity_id: str | None) -> int:
        return self.inputs.own_names.get((name or "").strip().lower(), 0) | self.inputs.own_entities.get(entity_id or "", 0)

    async def url_keys(self, seen: Mapping[str, tuple]) -> dict[str, tuple[int, int | None]]:
        """Keys and owners of a batch's URLs: known ones by hash, new rows for the rest."""
        found = {r["url_hash"]: (r["url_key"], r["owner_key"]) for r in await self.gold.fetch("SELECT url_hash,url_key,owner_key FROM gold.dim_url WHERE url_hash=ANY($1::text[])", list(seen))}
        fresh = []
        for digest, row in seen.items():
            if digest not in found:
                found[digest] = (self.d.take("url"), row[-2])
                fresh.append((found[digest][0], digest, *row))
        if fresh:
            await flush_dims(self.gold, self.d)
            await self.gold.copy_records_to_table("dim_url", schema_name="gold", columns=("url_key", "url_hash", "url", "title", "url_norm", "url_base_norm", "host", "domain", "source_key", "owner_key", "rule_ver"), records=fresh)
        return found

    async def load(self, snap: Snapshot) -> dict[str, int]:
        d, gold, silver, surface = self.d, self.gold, self.silver, snap.surface
        counts = dict.fromkeys(("answers", "brands", "citations", "stances", "mentions", "occurrences", "cells", "skipped"), 0)
        answers = await silver.fetch(ALL_ANSWERS, snap.snapshot_id)
        scope = Scope(surface, (snap.round_date,), EVERY_BIT, snapshot=snap.snapshot_id)
        source = SilverObtSource(silver, scope, self.inputs)
        b = Binder()
        judged = {r["id"]: r for r in await silver.fetch(f"""WITH {source._answers(b, every_answer=True)}
            SELECT a.answer_key::text AS id,a.acr_iter,a.last_measured,a.eligible,a.web_reg,p.is_acr FROM a JOIN p USING(prompt_id)""", *b.args)}
        first = next((a for a in answers if a["prompt_id"] in d.prompts), None)
        project_key = d.projects.get(answers[0]["project_id"]) if answers else None
        async with gold.transaction():
            cyc = await cycle_key(gold, d, snap, answers, project_key if project_key is not None else (d.prompts[first["prompt_id"]][1] if first else None))
            builds = await builds_of(gold, d, surface, cyc, snap, self.catalog)
            ids = [a["id"] for a in answers]
            keys = {r["id"]: r["answer_key"] for r in await gold.fetch("SELECT job_id::text AS id,answer_key FROM gold.job_index WHERE job_id=ANY($1::uuid[])", ids)}
            for i in ids:
                if i not in keys:
                    keys[i] = d.take("answer")
            old = [r["answer_key"] for r in await gold.fetch("SELECT answer_key FROM gold.job_index WHERE cyc_key=$1", cyc)]
            touched = sorted({*old, *keys.values()})
            names = {(r["answer_key"], r["id"]): r["display_name"] for r in await gold.fetch(
                "SELECT answer_key,entity_id::text AS id,display_name FROM gold.answer_mention_raw WHERE answer_key=ANY($1::int[]) AND display_name IS NOT NULL", touched)}
            await gold.execute("DELETE FROM gold.answer_fact WHERE build_id=$1", builds["fact"])
            await gold.execute("DELETE FROM gold.answer_brand_fact WHERE build_id=$1", builds["fact"])
            await gold.execute("DELETE FROM gold.citation_fact WHERE build_id=$1", builds["fact"])
            await gold.execute("DELETE FROM gold.answer_stance_fact WHERE build_id=$1", builds["fact"])
            for table in ("job_index", "answer_body", "answer_mention_raw", "answer_occurrence", "answer_stance_raw"):
                await gold.execute(f"DELETE FROM gold.{table} WHERE answer_key=ANY($1::int[])", touched)
            info: dict[str, tuple] = {}
            jobs, bodies, facts = [], [], []
            sf = SURFACES[surface]
            for a in answers:
                key = keys[a["id"]]
                prompt = d.prompts.get(a["prompt_id"])
                if prompt is None:
                    counts["skipped"] += 1
                    continue
                prompt_key = prompt[0]
                project = d.projects.get(a["project_id"], prompt[1])
                market = self.market(surface, a["project_id"], a["country"])
                geo = d.countries.get(market or "", 0)
                lang = d.langs.get((a["lang"] or "").upper(), 0)
                engine = d.engines.get((a["engine"] or "").lower())
                group = self.bgrp(surface, a["prompt_id"], a["project_id"])
                finished = a["status"] == "completed"
                jobs.append((key, a["id"], cyc, prompt_key, project, engine, geo, lang, group, sf, a["round_date"], a["measured_at"], status_code(a["status"]),
                             a["analysis_label"] if finished else None, bool(a["dropped"]), finished and not a["dropped"], builds["fact"]))
                judge = judged.get(a["id"])
                # 대표 답변: the cell's last measured answer, none when that one is not eligible (decision '대표 답변은 레거시를 따른다')
                representative = bool(judge and judge["last_measured"] and judge["eligible"])
                info[a["id"]] = (key, prompt_key, project, engine, geo, lang, group, a["round_date"], representative, j.analysis_gap(a["analysis_state"]), market)
                bodies.append((key, a["id"], a["run_id"], sf, project, geo, group, None, a["model_slug"], a["measured_at"], a["status"], a["analysis_label"], a["country"]))
                if judge:
                    counts["answers"] += 1
                    facts.append((builds["fact"], sf, a["round_date"], key, cyc, prompt_key, project, engine, geo, lang, group, a["anchor_date"], a["anchor_src"],
                                  d.countries.get(a["country"] or "", 0), judge["acr_iter"], a["analysis_state"], a["dflt"], judge["is_acr"], representative, judge["web_reg"],
                                  j.analysis_gap(a["analysis_state"]), snap.rule_version))
            await gold.copy_records_to_table("job_index", schema_name="gold", columns=JOB_INDEX, records=jobs)
            await gold.copy_records_to_table("answer_fact", schema_name="gold", columns=ANSWER_FACT, records=facts)
            await self._rows(snap, cyc, builds["fact"], info, names, bodies, counts)
            await self._brands(snap, cyc, builds["fact"], info, counts)
            await self._acr(snap, cyc, builds["acr"], counts)
            await gold.execute("""INSERT INTO gold.silver_load(cycle_id,snapshot_id,surface,round_date,answers,cells,inputs_digest) VALUES($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT(cycle_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,round_date=EXCLUDED.round_date,answers=EXCLUDED.answers,cells=EXCLUDED.cells,inputs_digest=EXCLUDED.inputs_digest,loaded_at=now()""",
                               snap.cycle_id, snap.snapshot_id, surface, snap.round_date, counts["answers"], counts["cells"], self.digest)
        return counts

    async def _rows(self, snap: Snapshot, cyc: int, build: int, info: Mapping[str, tuple], names: Mapping, bodies: list[tuple], counts: dict[str, int]) -> None:
        """The answers' JSON, batch by batch: raw rows, citations, stances."""
        d, gold, silver = self.d, self.gold, self.silver
        sf = SURFACES[snap.surface]
        by_id = {b[1]: b for b in bodies}
        async with silver.transaction(readonly=True):
            batch: list[Any] = []
            async for row in silver.cursor(ANSWER_JSON, snap.snapshot_id, prefetch=200):
                batch.append(row)
                if len(batch) >= BATCH:
                    await self._batch(snap, cyc, build, sf, batch, info, names, by_id, counts)
                    batch = []
            if batch:
                await self._batch(snap, cyc, build, sf, batch, info, names, by_id, counts)

    async def _batch(self, snap: Snapshot, cyc: int, build: int, sf: int, batch: Sequence[Mapping[str, Any]], info: Mapping[str, tuple], names: Mapping, by_id: Mapping[str, tuple], counts: dict[str, int]) -> None:
        d, gold = self.d, self.gold
        day = snap.round_date
        bodies, mentions, occurrences, stance_raw, stance_fact, citation_rows, urls = [], [], [], [], [], [], {}
        for row in batch:
            known = info.get(row["id"])
            if known is None:
                continue
            key, prompt, project, engine, geo, lang, group, round_date, is_rep, gap, market = known
            body = by_id[row["id"]]
            bodies.append((*body[:7], row["answer_text"], *body[8:]))
            semantics = {s.get("entity_id"): s for s in array(row["semantics"])}
            for index, m in enumerate(array(row["rollups"]), 1):
                entity_id = m.get("entity_id")
                entity = d.entity(entity_id, m.get("entity_type"), m.get("brand"), self.role(entity_id or ""), self.inputs.own_names, day)
                s = semantics.get(entity_id, {})
                held = d.entities.get(entity_id or "")
                mentions.append((key, index, sf, project, geo, group, entity_id, entity, held[2] if held else None, m.get("entity_type"), names.get((key, entity_id)), m.get("mention_count"),
                                 number(m.get("avg_position")), m.get("brand_rollup_entity_id"), m.get("surfaces") if isinstance(m.get("surfaces"), list) else None,
                                 s.get("sentiment_positive"), s.get("sentiment_neutral"), s.get("sentiment_negative"), s.get("sentiment_mixed"), s.get("type_mention"), s.get("type_recommendation"),
                                 s.get("type_comparison"), s.get("type_definition"), s.get("type_final_choice")))
            feelings = {s.get("analysis_index"): s.get("sentiment") for s in array(row["semantic_occurrences"])}
            for o in array(row["occurrences"]):
                occurrences.append((key, o.get("occurrence_seq"), sf, project, geo, group, o.get("entity_id"), o.get("turn_index"), o.get("source_start"), o.get("source_end"), o.get("surface_text"),
                                    feelings.get(o.get("analysis_index")), o.get("mention_role"), o.get("assertion"), o.get("context_snippet"), o.get("descriptors"), o.get("criteria")))
            for s in array(row["stances"]):
                entity_id = s.get("entity_id")
                if not entity_id:
                    continue
                entity = d.entity(entity_id, None, s.get("brand_label"), self.role(entity_id), self.inputs.own_names, day)
                stance_raw.append((key, s.get("turn_index"), entity_id, sf, project, geo, group, s.get("brand_label"), s.get("stance"), number(s.get("confidence")), s.get("evidence_text"),
                                   s.get("evidence_start"), s.get("evidence_end"), s.get("reason")))
                if body[10] == "completed":
                    stance_fact.append((build, sf, round_date, key, s.get("turn_index"), entity, d.entities[entity_id][1] or d.known_brand(s.get("brand_label")), cyc, self.own_bit(s.get("brand_label"), entity_id), STANCES.get(s.get("stance") or ""),
                                        s.get("turn_index") == 1, is_rep))
            if body[10] != "completed":
                continue
            judgments = {x.get("citation_seq"): x for x in array(row["judgments"])}
            for c in array(row["citations"]):
                seq, url = c.get("citation_seq"), c.get("url")
                x = judgments.get(seq, {})
                source = d.source(x.get("group_key"), x.get("domain") or c.get("domain"), x.get("category"), x.get("category_method"), snap.rule_version)
                candidates = d.owners.get((x.get("matched_brand"), x.get("matched_base_url")), []) if x.get("matched_base_url") else []
                owner = owner_of(candidates, None, x.get("matched_base_country"), market) if candidates else None
                digest = sha(url) if url else None
                if digest and digest not in urls:
                    urls[digest] = (url, c.get("title"), c.get("url_norm") or x.get("url_norm"), c.get("url_base_norm"), c.get("host"), c.get("domain"), source, owner, snap.rule_version)
                citation_rows.append((digest, build, sf, round_date, key, seq, source, cyc, prompt, project, engine, geo, lang, group, gap, is_rep, x.get("loc_owned"), bool(x.get("tgt_hit")), candidates, x.get("matched_base_country"), market))
                counts["citations"] += 1
        await flush_dims(gold, d)
        url_keys = await self.url_keys(urls) if urls else {}
        await gold.copy_records_to_table("answer_body", schema_name="gold", columns=BODY, records=bodies)
        await gold.copy_records_to_table("answer_mention_raw", schema_name="gold", columns=MENTION_RAW, records=mentions)
        await gold.copy_records_to_table("answer_occurrence", schema_name="gold", columns=OCCURRENCE, records=occurrences)
        await gold.copy_records_to_table("answer_stance_raw", schema_name="gold", columns=STANCE_RAW, records=stance_raw)
        await gold.copy_records_to_table("answer_stance_fact", schema_name="gold", columns=STANCE_FACT, records=stance_fact)
        await gold.copy_records_to_table("citation_fact", schema_name="gold", columns=CITATION_FACT, records=[
            (r[1], r[2], r[3], r[4], r[5], url_keys.get(r[0], (0, None))[0], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], owner_of(r[18], url_keys.get(r[0], (0, None))[1], r[19], r[20]), r[14], r[15], r[16], r[17], snap.rule_version)
            for r in citation_rows])
        counts["mentions"] += len(mentions)
        counts["occurrences"] += len(occurrences)
        counts["stances"] += len(stance_fact)

    async def _brands(self, snap: Snapshot, cyc: int, build: int, info: Mapping[str, tuple], counts: dict[str, int]) -> None:
        """The brand rows, folded as the Silver adapter folds them: the same SQL."""
        d, gold, silver = self.d, self.gold, self.silver
        sf = SURFACES[snap.surface]
        source = SilverObtSource(silver, Scope(snap.surface, (snap.round_date,), EVERY_BIT, snapshot=snap.snapshot_id), self.inputs)
        b = Binder()
        answers = source._answers(b, source.MENTIONS, every_answer=True)
        rows = source._rows_of_brands(b, await self.rollup_names(snap.surface, snap.round_date))
        sums = "br.s_pos,br.s_neu,br.s_neg,br.s_mix,br.t_mention,br.t_recommendation,br.t_comparison,br.t_definition,br.t_final_choice"
        out = await silver.fetch(f"WITH {answers},{rows} SELECT br.answer_key::text AS id,br.name,br.competitive,br.own_bit,br.mention_count,br.rk,br.first_pos,{sums} FROM br", *b.args)
        records = []
        for r in out:
            known = info.get(r["id"])
            if known is None:
                continue
            key, prompt, project, engine, geo, lang, group, round_date, is_rep, _, _ = known
            brand = d.brand(r["name"], r["own_bit"] or 0, snap.round_date)
            records.append((build, sf, round_date, key, brand, bool(r["competitive"]), cyc, prompt, project, engine, geo, lang, group, r["own_bit"], r["mention_count"], r["rk"] or 0, r["first_pos"] or 0,
                            r["s_pos"], r["s_neu"], r["s_neg"], r["s_mix"], r["t_mention"], r["t_recommendation"], r["t_comparison"], r["t_definition"], r["t_final_choice"], is_rep, snap.rule_version))
        await flush_dims(gold, d)
        await gold.copy_records_to_table("answer_brand_fact", schema_name="gold", columns=BRAND_FACT, records=records)
        counts["brands"] += len(records)

    async def _acr(self, snap: Snapshot, cyc: int, build: int, counts: dict[str, int]) -> None:
        """The ACR cells. keep is legacy's: a brand row by its name and the roster (as the adapter reads), a model row by its own name (queries.py brand_competitive)."""
        d, gold, silver = self.d, self.gold, self.silver
        sf = SURFACES[snap.surface]
        rows = await silver.fetch(ACR_ROWS, snap.snapshot_id)
        await gold.execute("DELETE FROM gold.acr_entity_fact WHERE build_id=$1", build)
        await gold.execute("DELETE FROM gold.acr_cell_fact WHERE build_id=$1", build)
        if not rows:
            return
        source = SilverObtSource(silver, Scope(snap.surface, (snap.round_date,), EVERY_BIT, snapshot=snap.snapshot_id), self.inputs)
        b = Binder()
        judged = {r["id"]: r for r in await silver.fetch(f"WITH {source._cells(b, judged=True)} SELECT cell.prompt_run_id::text AS id,cell.last_measured,cell.acr_in FROM cell", *b.args)}
        cells = {r["id"]: r["acr_cell_key"] for r in await gold.fetch("SELECT prompt_run_id::text AS id,acr_cell_key FROM gold.acr_cell_run WHERE prompt_run_id=ANY($1::uuid[])", [r["id"] for r in rows])}
        fresh = []
        for r in rows:
            if r["id"] not in cells:
                cells[r["id"]] = d.take("cell")
                fresh.append((cells[r["id"]], r["id"]))
        if fresh:
            await gold.copy_records_to_table("acr_cell_run", schema_name="gold", columns=("acr_cell_key", "prompt_run_id"), records=fresh)
        facts, entities = [], []
        excluded = self._excluded
        for r in rows:
            prompt = d.prompts.get(r["prompt_id"])
            judge = judged.get(r["id"])
            if prompt is None or judge is None:
                counts["skipped"] += 1
                continue
            cell = cells[r["id"]]
            group = self.bgrp(snap.surface, r["prompt_id"], r["project_id"])
            project = d.projects.get(r["project_id"], prompt[1])
            facts.append((build, cell, sf, cyc, prompt[0], project, d.engines.get((r["engine"] or "").lower()), d.countries.get(r["country"] or "", 0), d.langs.get((r["lang"] or "").upper(), 0), group,
                          snap.round_date, r["measured_at"].date() if r["measured_at"] else None, r["planned"], r["valid_turn1"], r["valid_acr"], r["co_single"], r["co_conditional"], r["co_generic"],
                          r["co_off_shortlist"], r["co_unresolved"], r["co_none"], bool(judge["last_measured"] and judge["acr_in"]), bool(judge["acr_in"]), snap.rule_version))
            counts["cells"] += 1
            for e in array(r["entities"]):
                level = LEVELS.get(e.get("rollup_level"))
                entity_id = e.get("entity_id")
                if level is None or not entity_id:
                    continue
                entity = d.entity(entity_id, e.get("entity_type"), e.get("brand"), self.role(entity_id), self.inputs.own_names, snap.round_date)
                brand, parent = (e.get("brand") or "").strip(), (e.get("parent_brand") or "").strip()
                name = brand if level == 1 else (parent or brand)
                own = self.own_bit(name, entity_id)
                brand_key = d.brand(brand, own if level == 1 else 0, snap.round_date)
                parent_key = d.brand(parent, self.own_bit(parent, None), snap.round_date) if parent else None
                model = (d.entities[entity_id][3] or "").strip().lower()
                keep = (bool(name) and name != NO_NAME and name.lower() not in j.NON_COMPETITOR_BRANDS and entity_id not in excluded) if level == 1 else model not in j.NON_COMPETITOR_BRANDS
                entities.append((build, cell, level, entity, brand_key, parent_key, own, e.get("appearance_count"), e.get("choice_count"), e.get("conditional_choice_count"), e.get("off_shortlist_choice_count"),
                                 e.get("unresolved_choice_count"), e.get("generic_choice_count"), keep))
        await flush_dims(gold, d)
        await gold.copy_records_to_table("acr_cell_fact", schema_name="gold", columns=ACR_CELL, records=facts)
        await gold.copy_records_to_table("acr_entity_fact", schema_name="gold", columns=ACR_ENTITY, records=entities)


async def refresh_entity_totals(gold: Any) -> None:
    """Admin › 엔티티: the entities' numbers over every answer (legacy rd.refresh_entity_mention_total), and the names each was seen under, by month."""
    async with gold.transaction():
        await gold.execute("DELETE FROM gold.entity_mention_total")
        await gold.execute("""INSERT INTO gold.entity_mention_total(entity_id,answers,mentions,updated_at)
            SELECT entity_id,count(DISTINCT answer_key),coalesce(sum(mention_count),0),now() FROM gold.answer_mention_raw WHERE entity_id IS NOT NULL GROUP BY 1""")
        await gold.execute("DELETE FROM gold.entity_mention_surface")
        await gold.execute("""INSERT INTO gold.entity_mention_surface(entity_id,run_month,surface,brand_rollup_entity_id,display_name)
            SELECT DISTINCT m.entity_id,date_trunc('month',j.measured_at)::date,t.surface,m.brand_rollup_entity_id,m.display_name
            FROM gold.answer_mention_raw m JOIN gold.job_index j USING(answer_key) CROSS JOIN LATERAL unnest(m.surfaces) AS t(surface) WHERE m.entity_id IS NOT NULL""")


def to_load(public: Iterable[Mapping[str, Any]], loaded: Mapping[str, tuple[str, str]], digest: str, surfaces: Sequence[str] | None = None, rounds: Sequence[date] | None = None) -> list[Snapshot]:
    """The operating snapshots not yet here: a new cycle, one whose snapshot moved, or one loaded on other inputs."""
    return [Snapshot(r["snapshot_id"], r["cycle_id"], r["round_date"], r["rule_version"], r["surface"]) for r in public
            if loaded.get(r["cycle_id"]) != (r["snapshot_id"], digest) and (not surfaces or r["surface"] in surfaces) and (not rounds or r["round_date"] in rounds)]


async def _run(config: Mapping[str, Any]) -> dict:
    started = time.time()
    gold = await asyncpg.connect(config["dsn"], timeout=10, server_settings={"application_name": "hmg-geo-hub-query-load", "statement_timeout": "0", "synchronous_commit": "off", "work_mem": "128MB"})
    silver = await asyncpg.connect(os.environ["HGH_SILVER_DB_URL"], timeout=10, server_settings={"application_name": "hmg-geo-hub-query-load", "statement_timeout": "0", "default_transaction_read_only": "on", "work_mem": "256MB"})
    source = await asyncpg.connect(os.environ["HGH_INPUT_DB_URL"], timeout=10)
    out: dict[str, Any] = {"loaded": 0, "failed": [], "totals": {}}
    try:
        if not await gold.fetchval("SELECT pg_try_advisory_lock($1)", LOCK):
            return {**out, "status": "busy"}
        out.update(await sync_prompts(gold, source, None))
        inputs = await read_inputs(source)
        past = await gold.fetch("""SELECT prompt_id::text AS id,in_root_catalog_all,cat_mask_all FROM gold.dim_prompt
            WHERE surface=1 AND (cat_mask_all,in_root_catalog_all) IS DISTINCT FROM (cat_mask,in_root_catalog)""")
        inputs = with_past_catalogs(inputs, past)
        digest = inputs_digest(inputs)
        dims = await read_dims(gold)
        public = await silver.fetch(MANIFEST)
        loaded = {r["id"]: (r["snapshot_id"], r["inputs_digest"]) for r in await gold.fetch("SELECT cycle_id::text AS id,snapshot_id::text AS snapshot_id,inputs_digest FROM gold.silver_load")}
        rounds = [date.fromisoformat(d) for d in config.get("rounds") or []]
        todo = to_load(public, loaded, digest, config.get("surfaces"), rounds)
        if config.get("limit"):
            todo = todo[:int(config["limit"])]
        taxons = {(r["axis"], r["code"], r["parent_key"]): r["taxon_key"] for r in await gold.fetch("SELECT axis,code,parent_key,taxon_key FROM gold.dim_taxon")}
        prompts = [{"id": r["id"], "catalogs": json.loads(r["catalogs"])} for r in await source.fetch(
            "SELECT prompt_id::text AS id,definition->'catalogs' AS catalogs FROM catalog.current_prompt WHERE definition->>'surface'='1' AND jsonb_typeof(definition->'catalogs')='array'")]
        loader = Loader(gold, silver, inputs, dims, digest, catalog_rows(prompts, {k: v[0] for k, v in dims.prompts.items()}, taxons))
        for i, snap in enumerate(todo, 1):
            begun = time.time()
            counts = await loader.load(snap)
            out["loaded"] += 1
            for k, v in counts.items():
                out["totals"][k] = out["totals"].get(k, 0) + v
            print(json.dumps({"n": f"{i}/{len(todo)}", "surface": snap.surface, "round": snap.round_date.isoformat(), "s": round(time.time() - begun, 1), **counts}), flush=True)
        if not config.get("rounds") and not config.get("limit"):
            states = await silver.fetch("SELECT cycle_id::text AS id,bool_or(status='public') AS public,bool_or(status IN ('loading','ready')) AS owed FROM ops.snapshot_manifest GROUP BY 1")
            await gold.execute(MIRROR_CYCLES, [r["id"] for r in states if r["owed"] and not r["public"]], [r["id"] for r in states if r["public"]])
        if out["loaded"]:
            for surface in {s.surface for s in todo}:
                await gold.execute("UPDATE gold.active_release SET version=version+1,updated_at=now(),as_of=(SELECT max(round_date) FROM gold.silver_load WHERE surface=$1) WHERE scope=$1 AND read_mode='live'", surface)
            if not config.get("rounds") and not config.get("limit"):
                await refresh_entity_totals(gold)
        out["status"] = "done"
        out["seconds"] = round(time.time() - started, 1)
        return out
    finally:
        await gold.close()
        await silver.close()
        await source.close()


def run(config: Mapping[str, Any]) -> None:
    print(json.dumps(asyncio.run(_run(config)), ensure_ascii=False))
