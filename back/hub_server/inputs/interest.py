"""Seed keywords and community sources on the renewal Admin › 고객 관심 데이터 관리 screen (2026-11-02).

What people decide to collect is the HUB's (docs/handoff/admin-todo.md, decisions A · E and '기준값 편집 공통 구조'); what
was collected is Gold's, and it is shown next to the HUB's rows without being rewritten. `state` only compares the two:
- keyword: applied (Gold's seed rows hold every HUB condition) · pending (not yet) · upstream (Gold's seed the HUB does
  not have) · None (a stopped keyword: Gold's seed rows are past collections, nothing to compare).
- source: observed (the host is in Gold's active social snapshot) · unseen (it is not) · upstream (a corpus host no HUB
  source has). Gold has no list of sources and nothing reads the HUB's until the pipeline agrees to, so this says what the
  corpus holds, not that a source was applied. A source is compared by its exact host, without www.

Writes use hmg_interest_editor (HGH_INTEREST_EDITOR_DB_URL), which can write the two lists and their history and call
their publishing functions, nothing else. Every write runs under the catalog lock (617427413), records an event row and
publishes the active rows (interest_keyword / interest_source, source hub_edit) when they changed. Rows are never
deleted: stopping is status=stopped. Gold is read before the lock, never under it."""
from __future__ import annotations

import json
import os
import re
import unicodedata
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server.inputs.catalog_editor import refused
from hub_server.inputs.source_lists import as_json, events_view, history_sql, publish, record
from hub_server.inputs.source_overrides import CONTROL, KEY_MAX, invalid, reading
from shared.account import Principal
from shared.input_common import BRANDS, LOCK_SQL, CATALOG_LOCK, LOCK_TIMEOUT

TERM_MAX = 99                # DataForSEO takes under 100 characters (core.kw.sanitize)

TERM_REFUSED = re.compile(r"[()\[\]{},\x00-\x1f\x7f]")  # what DataForSEO refuses (core.kw.sanitize), and control characters

CONDITIONS_MAX = 40

NOTE_MAX = 500

URL_MAX = 500

LOCATION = re.compile(r"[1-9][0-9]{3,6}")

LANGUAGE = re.compile(r"[a-z]{2,3}(-[A-Za-z]{2,4})?")

SOURCE_TYPES = ("google_keyword", "community_voc")

CHANNELS = ("news", "pr", "social", "community")

KEYWORD_COLUMNS = "term_norm,term,conditions,source_types,brands,note,status,origin,created_at,updated_at,updated_by"

SOURCE_COLUMNS = "source_key,url,channel,brands,note,status,created_at,updated_at,updated_by"

NORM_SQL = "SELECT catalog.interest_term_norm($1)"

class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location_code: int
    language_code: str = Field(max_length=16)

class KeywordSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str = Field(max_length=TERM_MAX + 100)
    conditions: list[Condition] = Field(max_length=CONDITIONS_MAX + 1)
    sourceTypes: list[str] = Field(max_length=4)
    brands: list[str] = Field(default_factory=list, max_length=8)
    note: str | None = Field(default=None, max_length=NOTE_MAX + 20)

class KeywordKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str = Field(max_length=TERM_MAX + 100)

class SourceSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(max_length=URL_MAX + 20)
    channel: str = Field(max_length=16)
    brands: list[str] = Field(default_factory=list, max_length=8)
    note: str | None = Field(default=None, max_length=NOTE_MAX + 20)

class SourceKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(max_length=URL_MAX + 20)

def clean_term(value: str) -> str:
    """A new keyword as DataForSEO takes it: NFC, one line, whitespace folded, nothing it refuses (a refusal, not a rewrite)."""
    term = re.sub(r"[ \t 　]+", " ", unicodedata.normalize("NFC", value or "").strip())
    if not 1 <= len(term) <= TERM_MAX or TERM_REFUSED.search(term):
        raise invalid(f"A keyword of 1 to {TERM_MAX} characters, without brackets or commas", "term")
    return term

def clean_conditions(conditions: list[Condition]) -> list[dict]:
    """The collection conditions in one order, each once."""
    out = set()
    for i, c in enumerate(conditions):
        language = c.language_code.strip()
        if not LOCATION.fullmatch(str(c.location_code)) or not LANGUAGE.fullmatch(language):
            raise invalid(f"Condition {i + 1}: a DataForSEO location code and a language code", f"conditions.{i}")
        out.add((c.location_code, language))
    if not 1 <= len(out) <= CONDITIONS_MAX:
        raise invalid(f"A keyword has 1 to {CONDITIONS_MAX} collection conditions", "conditions")
    return [{"location_code": loc, "language_code": lang} for loc, lang in sorted(out)]

def clean_source_types(values: list[str]) -> list[str]:
    if not values or any(v not in SOURCE_TYPES for v in values):
        raise invalid("At least one of the keyword sources", "sourceTypes")
    return [t for t in SOURCE_TYPES if t in values]

def clean_brands(values: list[str]) -> list[str]:
    """The brands in one order; none = common to every brand."""
    if any(v not in BRANDS for v in values):
        raise invalid("A brand is one of the HMG brands", "brands")
    return [b for b in BRANDS if b in values]

def clean_note(value: str | None) -> str | None:
    note = (value or "").strip()
    if len(note) > NOTE_MAX or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", note):
        raise invalid(f"A note of up to {NOTE_MAX} characters", "note")
    return note or None

def source_key(value: str) -> tuple[str, str]:
    """(the URL as entered, the key): a domain or a URL; the key is lower case, without scheme, leading www., query,
    fragment and trailing slash."""
    url = (value or "").strip()
    key = re.sub(r"^[a-z][a-z0-9+.-]*://", "", url.lower())
    key = re.split(r"[?#]", key)[0].rstrip("/")
    key = re.sub(r"^www\.", "", key)
    host = key.split("/")[0]
    if not 3 <= len(key) <= KEY_MAX or len(url) > URL_MAX or "." not in host.strip(".") or CONTROL.search(url):
        raise invalid("A source is a domain or a URL such as bobaedream.co.kr", "url")
    return url, key

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_INTEREST_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-interest", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Customer-interest editing is not configured (HGH_INTEREST_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute(LOCK_SQL, CATALOG_LOCK)
        except asyncpg.LockNotAvailableError:
            raise HTTPException(503, "The Gold import is writing the catalog; try again shortly") from None
        yield conn

async def keyword_history(term: str | None) -> dict:
    async with reading() as conn:
        key = await conn.fetchval(NORM_SQL, term) if term else None
        events = await (conn.fetch(history_sql("interest_keyword", "WHERE term_norm=$1"), key) if key
                        else conn.fetch(history_sql("interest_keyword", "")))
    return {"term": key, "history": await events_view(events, "term_norm")}

def keyword_row(row) -> dict:
    return {"term": row["term"], "termNorm": row["term_norm"], "conditions": as_json(row["conditions"]),
            "sourceTypes": list(row["source_types"]), "brands": list(row["brands"]), "note": row["note"], "status": row["status"],
            "origin": row["origin"], "updatedAt": row["updated_at"]}

async def set_keyword(body: KeywordSet, actor: Principal) -> dict:
    """Add a keyword, or change one's conditions, sources, brands and note (its term and status stay). The same values
    change nothing."""
    term = clean_term(body.term)
    new = {"conditions": clean_conditions(body.conditions), "source_types": clean_source_types(body.sourceTypes),
           "brands": clean_brands(body.brands), "note": clean_note(body.note)}
    published = None
    async with writing() as conn:
        key = await conn.fetchval(NORM_SQL, term)
        row = await conn.fetchrow(f"SELECT {KEYWORD_COLUMNS} FROM catalog.interest_keyword WHERE term_norm=$1", key)
        if row is None:
            await conn.execute("""INSERT INTO catalog.interest_keyword(term_norm,term,conditions,source_types,brands,note,origin,updated_by)
                VALUES($1,$2,$3::jsonb,$4,$5,$6,'hub',$7)""", key, term, json.dumps(new["conditions"]), new["source_types"], new["brands"],
                               new["note"], actor.user_id)
            published = await publish(conn, "publish_interest_keywords")
            await record(conn, "interest_keyword", ("term_norm",), (key,), actor, "add", {k: [None, v] for k, v in new.items() if v}, published)
        else:
            before = {"conditions": as_json(row["conditions"]), "source_types": list(row["source_types"]), "brands": list(row["brands"]),
                      "note": row["note"]}
            changes = {k: [before[k], v] for k, v in new.items() if before[k] != v}
            if changes:
                await conn.execute("""UPDATE catalog.interest_keyword SET conditions=$2::jsonb,source_types=$3,brands=$4,note=$5,
                    updated_at=now(),updated_by=$6 WHERE term_norm=$1""", key, json.dumps(new["conditions"]), new["source_types"], new["brands"],
                                   new["note"], actor.user_id)
                published = await publish(conn, "publish_interest_keywords")
                await record(conn, "interest_keyword", ("term_norm",), (key,), actor, "set", changes, published)
        row = await conn.fetchrow(f"SELECT {KEYWORD_COLUMNS} FROM catalog.interest_keyword WHERE term_norm=$1", key)
    return {"term": row["term"], "keyword": keyword_row(row), "published": published}

async def set_keyword_status(body: KeywordKey, stop: bool, actor: Principal) -> dict:
    """Stop a keyword (it leaves the published list) or resume it. The same status changes nothing."""
    want = "stopped" if stop else "active"
    published = None
    async with writing() as conn:
        key = await conn.fetchval(NORM_SQL, body.term)
        row = await conn.fetchrow(f"SELECT {KEYWORD_COLUMNS} FROM catalog.interest_keyword WHERE term_norm=$1", key)
        if row is None:
            raise refused(404, "not_found", "The HUB has no such keyword")
        if row["status"] != want:
            await conn.execute("UPDATE catalog.interest_keyword SET status=$2,updated_at=now(),updated_by=$3 WHERE term_norm=$1",
                               key, want, actor.user_id)
            published = await publish(conn, "publish_interest_keywords")
            await record(conn, "interest_keyword", ("term_norm",), (key,), actor, "stop" if stop else "resume",
                         {"status": [row["status"], want]}, published)
        row = await conn.fetchrow(f"SELECT {KEYWORD_COLUMNS} FROM catalog.interest_keyword WHERE term_norm=$1", key)
    return {"term": row["term"], "keyword": keyword_row(row), "published": published}

async def source_history(url: str | None) -> dict:
    key = source_key(url)[1] if url else None
    async with reading() as conn:
        events = await (conn.fetch(history_sql("interest_source", "WHERE source_key=$1"), key) if key
                        else conn.fetch(history_sql("interest_source", "")))
    return {"key": key, "history": await events_view(events, "source_key")}

def source_row(row) -> dict:
    return {"key": row["source_key"], "url": row["url"], "channel": row["channel"], "brands": list(row["brands"]), "note": row["note"],
            "status": row["status"], "updatedAt": row["updated_at"]}

async def set_source(body: SourceSet, actor: Principal) -> dict:
    """Add a source, or change one's channel, brands and note (its URL and status stay). The same values change nothing."""
    url, key = source_key(body.url)
    if body.channel not in CHANNELS:
        raise invalid("The channel is one of news, pr, social, community", "channel")
    new = {"channel": body.channel, "brands": clean_brands(body.brands), "note": clean_note(body.note)}
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {SOURCE_COLUMNS} FROM catalog.interest_source WHERE source_key=$1", key)
        if row is None:
            await conn.execute("""INSERT INTO catalog.interest_source(source_key,url,channel,brands,note,updated_by) VALUES($1,$2,$3,$4,$5,$6)""",
                               key, url, new["channel"], new["brands"], new["note"], actor.user_id)
            published = await publish(conn, "publish_interest_sources")
            await record(conn, "interest_source", ("source_key",), (key,), actor, "add", {k: [None, v] for k, v in new.items() if v}, published)
        else:
            before = {"channel": row["channel"], "brands": list(row["brands"]), "note": row["note"]}
            changes = {k: [before[k], v] for k, v in new.items() if before[k] != v}
            if changes:
                await conn.execute("""UPDATE catalog.interest_source SET channel=$2,brands=$3,note=$4,updated_at=now(),updated_by=$5
                    WHERE source_key=$1""", key, new["channel"], new["brands"], new["note"], actor.user_id)
                published = await publish(conn, "publish_interest_sources")
                await record(conn, "interest_source", ("source_key",), (key,), actor, "set", changes, published)
        row = await conn.fetchrow(f"SELECT {SOURCE_COLUMNS} FROM catalog.interest_source WHERE source_key=$1", key)
    return {"key": key, "source": source_row(row), "published": published}

async def set_source_status(body: SourceKey, stop: bool, actor: Principal) -> dict:
    """Stop a source (it leaves the published list) or resume it. The same status changes nothing."""
    key = source_key(body.url)[1]
    want = "stopped" if stop else "active"
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {SOURCE_COLUMNS} FROM catalog.interest_source WHERE source_key=$1", key)
        if row is None:
            raise refused(404, "not_found", "The HUB has no such source")
        if row["status"] != want:
            await conn.execute("UPDATE catalog.interest_source SET status=$2,updated_at=now(),updated_by=$3 WHERE source_key=$1",
                               key, want, actor.user_id)
            published = await publish(conn, "publish_interest_sources")
            await record(conn, "interest_source", ("source_key",), (key,), actor, "stop" if stop else "resume",
                         {"status": [row["status"], want]}, published)
        row = await conn.fetchrow(f"SELECT {SOURCE_COLUMNS} FROM catalog.interest_source WHERE source_key=$1", key)
    return {"key": key, "source": source_row(row), "published": published}
