"""Project prompts and their custom tags on the renewal Project › Prompt screen (2026-11-03).

What a project measures is decided by people, so it is the HUB's (docs/handoff/admin-todo.md, decisions A and '프로젝트
프롬프트 적재'): catalog.prompt / prompt_version (one revision per change, exported in change_seq order by ext.prompts) and the
project's tag columns in its definition (custom_fields), each prompt's tag values in its own (custom_values). A change is one more
revision with recorded_by. Rows are never deleted: a delete is status=archived and can be restored.

Statuses, as the original page had them where the HUB can hold them: draft (added here, not sent for measurement; the text
and language can change only now), active (measured or to be), paused (measurement stop asked), archived (deleted), removed
(left the measured catalog before the import stopped, read only). Sending drafts to Scope (the original 실행) waits for the Scope path (D-7 ③);
nothing here calls Scope. Gold is never written: the screen compares the HUB values with Gold's (screens/project_dashboard).

Writes use hmg_project_editor (HGH_PROJECT_EDITOR_DB_URL): INSERT of prompts and of prompt / project revisions of project-
surface catalogs only, each naming its account (data-012). Every write runs under the catalog lock (617427413), so revisions
take change_seq in commit order."""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server.inputs.catalog_editor import CATALOG_LOCK, LOCK_TIMEOUT, definition_of, digest, encoded, reading, refused
from shared.account import Principal
from shared.project_prompt_views import LANGUAGES_SQL, PROJECT_SQL, PROMPTS_SQL, fields_of, language_of, prompt_view, status_of



TEXT_MAX = 4000      # the original's prompt length cap

LINES_MAX = 1000     # prompts one manual add takes (the original's cap)

LABEL_MAX = 100      # tag name (the original's cap)

VALUE_MAX = 500      # tag value (the original's cap)

BULK_MAX = 1000      # prompts one tag write takes (the original's cap)

HISTORY_LIMIT = 100

# the original's reserved tag names (fixed classification axes), compared in lower case
RESERVED_LABELS = frozenset(("brand", "category", "prompttype", "브랜드", "카테고리"))

LIVE = ("draft", "active", "paused")   # statuses whose values can change

KINDS = ("single", "acr")

CONTROL = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")

# the event a revision is, from the status before → after (history())
ACTIONS = {("active", "paused"): "paused", ("paused", "active"): "resumed", ("draft", "active"): "activated"}

PROMPT_SQL = """SELECT p.prompt_id,p.project_id,p.origin,p.registered_at,p.version,p.text,p.definition,p.recorded_at,
        EXISTS(SELECT 1 FROM catalog.prompt_version h WHERE h.prompt_id=p.prompt_id AND h.recorded_by IS NOT NULL) AS hub_edited
    FROM catalog.current_prompt p WHERE p.prompt_id=$1"""

VERSIONS_SQL = """SELECT version,text,definition,recorded_at,recorded_by,recorded_by_login,recorded_by_name FROM catalog.prompt_version
    WHERE prompt_id=$1 ORDER BY version DESC LIMIT $2"""

INSERT_PROMPT_SQL = "INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES($1,$2,'hub')"

INSERT_REVISION_SQL = """INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by,recorded_by_login,recorded_by_name)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)"""

INSERT_PROJECT_REVISION_SQL = """INSERT INTO catalog.project_version(project_id,version,definition,sha256,recorded_by)
    VALUES($1,$2,$3::jsonb,$4,$5)"""

class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")

class PromptAdd(Model):
    """The original's manual add: one prompt per line, blank lines ignored, every one a draft."""
    text: str = Field(min_length=1, max_length=LINES_MAX * (TEXT_MAX + 2))

class PromptEdit(Model):
    expectedVersion: int = Field(ge=1)
    text: str | None = Field(None, max_length=TEXT_MAX * 2)
    kind: Literal["single", "acr"] | None = None
    language: str | None = Field(None, max_length=20)

class VersionRef(Model):
    expectedVersion: int = Field(ge=1)

class TagSet(Model):
    promptIds: list[UUID] = Field(min_length=1, max_length=BULK_MAX)
    fieldId: str = Field(min_length=1, max_length=64)
    #: None or "" clears the value
    value: str | None = Field(None, max_length=VALUE_MAX * 2)

class FieldAdd(Model):
    label: str = Field(min_length=1, max_length=LABEL_MAX * 2)

def clean_line(value: str, what: str, limit: int) -> str:
    """One line of text as stored: trimmed, no control characters, at most `limit` characters."""
    value = value.strip()
    if not value:
        raise refused(422, "invalid_value", f"{what} is required", {"fields": [what]})
    if CONTROL.search(value):
        raise refused(422, "invalid_value", f"{what} must be one line without control characters", {"fields": [what]})
    if len(value) > limit:
        raise refused(422, "invalid_value", f"{what} is longer than {limit} characters", {"fields": [what]})
    return value

def split_lines(text: str) -> list[str]:
    """The manual add's prompts: one per non-blank line, in order, each line once."""
    lines, seen = [], set()
    for raw in text.splitlines():
        if not raw.strip():
            continue
        line = clean_line(raw, "text", TEXT_MAX)
        if line not in seen:
            seen.add(line)
            lines.append(line)
    if not lines:
        raise refused(422, "invalid_value", "Write at least one prompt", {"fields": ["text"]})
    if len(lines) > LINES_MAX:
        raise refused(422, "invalid_value", f"At most {LINES_MAX} prompts at once", {"fields": ["text"]})
    return lines

def snapshot(text: str, definition: dict) -> dict:
    """The values a revision shows in the history."""
    custom = definition.get("custom_values") if isinstance(definition.get("custom_values"), dict) else {}
    return {"text": text, "kind": definition.get("kind") or None, "lang": language_of(definition), "status": status_of(definition),
            "custom": dict(custom)}

def history(rows: list) -> list[dict]:
    """Revisions oldest → newest as events newest first: created · updated · paused · resumed · archived · restored ·
    removed, with the changed values (old → new; a tag as `tag:<field id>`). A Gold revision that changed only Gold's own
    keys lists no change."""
    events, previous = [], None
    for r in rows:
        current = snapshot(r["text"], definition_of(r))
        if previous is None:
            event, changes = "created", {}
        else:
            changes = {k: {"old": previous[k], "new": current[k]} for k in ("text", "kind", "lang") if previous[k] != current[k]}
            for field in sorted(set(previous["custom"]) | set(current["custom"])):
                old, new = previous["custom"].get(field), current["custom"].get(field)
                if old != new:
                    changes[f"tag:{field}"] = {"old": old, "new": new}
            before, after = previous["status"], current["status"]
            event = ("updated" if before == after else after if after in ("archived", "removed")
                     else "restored" if before in ("archived", "removed") else ACTIONS.get((before, after), "updated"))
        events.append({"version": r["version"], "event": event, "changes": changes, "recordedAt": r["recorded_at"],
                       "recordedBy": str(r["recorded_by"]) if r["recorded_by"] else None, "actor": {"login": r["recorded_by_login"], "displayName": r["recorded_by_name"]} if r.get("recorded_by_login") else None})
        previous = current
    return events[::-1]

def restored_status(rows: list, origin: str) -> str:
    """The status an archived prompt goes back to: the last one before it was archived (newest revision first), else draft
    for a prompt added here and active for one Gold measured."""
    for r in rows:
        status = status_of(definition_of(r))
        if status in LIVE:
            return status
    return "draft" if origin == "hub" else "active"

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_PROJECT_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-project-editor", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

def editing() -> bool:
    return _pool is not None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Project prompt editing is not configured (HGH_PROJECT_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute("SELECT pg_advisory_xact_lock($1)", CATALOG_LOCK)
        except asyncpg.LockNotAvailableError:
            raise HTTPException(503, "Another edit is writing the catalog; try again shortly") from None
        yield conn

async def project_row(conn, project_id: UUID):
    row = await conn.fetchrow(PROJECT_SQL, project_id)
    if row is None or definition_of(row).get("surface") != 3:
        raise HTTPException(404, "Project not in the HUB catalog")
    return row

async def prompt_row(conn, project_id: UUID, prompt_id: UUID):
    row = await conn.fetchrow(PROMPT_SQL, prompt_id)
    if row is None or row["project_id"] != project_id:
        raise HTTPException(404, "Prompt not found in this project")
    return row

def version_conflict(current: int) -> HTTPException:
    return refused(409, "version_conflict", "The prompt was changed after you opened it; reload it", {"currentVersion": current})

async def record(conn, prompt_id: UUID, version: int, text: str, definition: dict, actor: Principal) -> None:
    try:
        await conn.execute(INSERT_REVISION_SQL, prompt_id, version, text, encoded(definition), digest(text, definition), actor.user_id, actor.login, actor.display_name)
    except asyncpg.UniqueViolationError:
        raise version_conflict(version - 1) from None

async def prompt_history(project_id: UUID, prompt_id: UUID) -> dict:
    async with reading() as conn:
        row = await prompt_row(conn, project_id, prompt_id)
        versions = await conn.fetch(VERSIONS_SQL, prompt_id, HISTORY_LIMIT + 1)
    # one revision more than shown: the oldest shown one is compared with it
    events = history(list(reversed(versions)))[:HISTORY_LIMIT]
    return {"item": prompt_view(row), "history": events}

async def add(project_id: UUID, body: PromptAdd, actor: Principal) -> dict:
    """Drafts, one per line. A line that is already a live prompt of the project (same text) is skipped, not added twice."""
    lines = split_lines(body.text)
    async with writing() as conn:
        await project_row(conn, project_id)
        live = {r["text"] for r in await conn.fetch(PROMPTS_SQL, project_id) if status_of(definition_of(r)) in LIVE}
        created, skipped = [], [line for line in lines if line in live]
        definition = {"surface": 3, "kind": "single", "language": None, "status": "draft"}
        for line in (line for line in lines if line not in live):
            prompt_id = uuid4()
            await conn.execute(INSERT_PROMPT_SQL, prompt_id, project_id)
            await record(conn, prompt_id, 1, line, definition, actor)
            created.append(str(prompt_id))
    return {"created": created, "skipped": skipped}

async def update(project_id: UUID, prompt_id: UUID, body: PromptEdit, actor: Principal) -> dict:
    """The original's edit: text and language of a draft only; the measurement kind of any live prompt."""
    async with writing() as conn:
        row = await prompt_row(conn, project_id, prompt_id)
        if row["version"] != body.expectedVersion:
            raise version_conflict(row["version"])
        definition, text = definition_of(row), row["text"]
        status = status_of(definition)
        if status not in LIVE:
            raise refused(409, "not_editable", "Restore the prompt before editing it", {"status": status})
        sent = body.model_fields_set
        if ("text" in sent and body.text is not None and body.text.strip() != text) or (
                "language" in sent and (body.language or "").strip().lower() != (language_of(definition) or "")):
            if status != "draft":
                raise refused(409, "not_draft", "Only a draft's text and language can change", {"status": status})
        if "text" in sent and body.text is not None:
            text = clean_line(body.text, "text", TEXT_MAX)
            if text != row["text"] and await conn.fetchval(
                    """SELECT 1 FROM catalog.current_prompt WHERE project_id=$1 AND text=$2 AND prompt_id<>$3
                       AND coalesce(definition->>'status','active')=ANY($4::text[])""", project_id, text, prompt_id, list(LIVE)):
                raise refused(409, "duplicate", "Another live prompt of this project has this text")
        if "language" in sent:
            language = (body.language or "").strip().lower() or None
            if language and language not in {r["item_key"] for r in await conn.fetch(LANGUAGES_SQL)}:
                raise refused(422, "unknown_code", "Use a language code Gold knows", {"fields": ["language"]})
            definition = {**definition, "language": language}
        if "kind" in sent and body.kind is not None:
            definition = {**definition, "kind": body.kind}
        if digest(text, definition) == digest(row["text"], definition_of(row)):
            return {"item": prompt_view(row), "changed": False}
        await record(conn, prompt_id, row["version"] + 1, text, definition, actor)
        row = await conn.fetchrow(PROMPT_SQL, prompt_id)
    return {"item": prompt_view(row), "changed": True}

# action → (statuses it applies to, the status after; None = the one before the archive)
LIFECYCLE = {"pause": (("active",), "paused"), "resume": (("paused",), "active"),
             "archive": (LIVE, "archived"), "restore": (("archived",), None)}

async def lifecycle(project_id: UUID, prompt_id: UUID, action: str, body: VersionRef, actor: Principal) -> dict:
    if action not in LIFECYCLE:
        raise HTTPException(404, "Unknown action")
    allowed, after = LIFECYCLE[action]
    async with writing() as conn:
        row = await prompt_row(conn, project_id, prompt_id)
        if row["version"] != body.expectedVersion:
            raise version_conflict(row["version"])
        definition = definition_of(row)
        status = status_of(definition)
        if status not in allowed:
            raise refused(409, "invalid_status", f"{action} does not apply to a {status} prompt", {"status": status})
        if after is None:
            after = restored_status(await conn.fetch(VERSIONS_SQL, prompt_id, HISTORY_LIMIT), row["origin"])
            if await conn.fetchval("""SELECT 1 FROM catalog.current_prompt WHERE project_id=$1 AND text=$2 AND prompt_id<>$3
                    AND coalesce(definition->>'status','active')=ANY($4::text[])""", project_id, row["text"], prompt_id, list(LIVE)):
                raise refused(409, "duplicate", "Another live prompt of this project has this text")
        await record(conn, prompt_id, row["version"] + 1, row["text"], {**definition, "status": after}, actor)
        row = await conn.fetchrow(PROMPT_SQL, prompt_id)
    return {"item": prompt_view(row), "changed": True}

async def set_tags(project_id: UUID, body: TagSet, actor: Principal) -> dict:
    """One tag value on many prompts (the original's cell edit and bulk apply), or clears it. Prompts that already have the
    value are left as they are; deleted ones are refused."""
    value = clean_line(body.value, "value", VALUE_MAX) if (body.value or "").strip() else None
    ids = list(dict.fromkeys(body.promptIds))
    async with writing() as conn:
        project = await project_row(conn, project_id)
        if body.fieldId not in {f["id"] for f in fields_of(definition_of(project))}:
            raise HTTPException(404, "Tag not found in this project")
        rows = await conn.fetch("""SELECT p.prompt_id,p.version,p.text,p.definition FROM catalog.current_prompt p
            WHERE p.project_id=$1 AND p.prompt_id=ANY($2::uuid[])""", project_id, ids)
        if len(rows) != len(ids):
            raise HTTPException(404, "A prompt is not in this project")
        frozen = [str(r["prompt_id"]) for r in rows if status_of(definition_of(r)) not in LIVE]
        if frozen:
            raise refused(409, "not_editable", "Deleted prompts keep their tags; restore them first", {"promptIds": frozen})
        changed = []
        for r in rows:
            definition = definition_of(r)
            custom = dict(definition.get("custom_values") or {})
            if custom.get(body.fieldId) == value:
                continue
            if value is None:
                custom.pop(body.fieldId, None)
            else:
                custom[body.fieldId] = value
            definition = {k: v for k, v in definition.items() if k != "custom_values"} | ({"custom_values": custom} if custom else {})
            await record(conn, r["prompt_id"], r["version"] + 1, r["text"], definition, actor)
            changed.append(str(r["prompt_id"]))
    return {"changed": changed, "unchanged": len(ids) - len(changed)}

async def record_project(conn, project, definition: dict, actor: Principal) -> None:
    try:
        await conn.execute(INSERT_PROJECT_REVISION_SQL, project["project_id"], project["version"] + 1, encoded(definition),
                           digest(None, definition), actor.user_id)
    except asyncpg.UniqueViolationError:
        raise refused(409, "version_conflict", "The project was changed meanwhile; reload it") from None

def stored_fields(definition: dict) -> list[dict]:
    return list(definition.get("custom_fields") or []) if isinstance(definition.get("custom_fields"), list) else []

async def add_field(project_id: UUID, body: FieldAdd, actor: Principal) -> dict:
    """A tag column (text values). The original's rules: a name at most LABEL_MAX long, not a reserved axis name, not the name
    of another column of the project in any case (archived ones included)."""
    label = clean_line(body.label, "label", LABEL_MAX)
    if label.lower() in RESERVED_LABELS:
        raise refused(422, "reserved_label", "This name is a fixed classification axis", {"fields": ["label"]})
    async with writing() as conn:
        project = await project_row(conn, project_id)
        definition = definition_of(project)
        fields = stored_fields(definition)
        if any(str(f.get("label", "")).lower() == label.lower() for f in fields):
            raise refused(409, "duplicate", "The project already has a tag with this name")
        field = {"field_id": str(uuid4()), "label": label, "archived": False, "created_at": str(datetime.now(UTC))}
        definition = {**definition, "custom_fields": sorted([*fields, field], key=lambda f: str(f["field_id"]))}
        await record_project(conn, project, definition, actor)
    return {"field": {"id": field["field_id"], "label": label, "archived": False, "createdAt": field["created_at"]}}

async def set_field_archived(project_id: UUID, field_id: str, archived: bool, actor: Principal) -> dict:
    """Archive (hidden from the columns and, once Gold has it, from the filters) or restore a tag column. Its values stay."""
    async with writing() as conn:
        project = await project_row(conn, project_id)
        definition = definition_of(project)
        fields = stored_fields(definition)
        target = next((f for f in fields if str(f.get("field_id")) == field_id), None)
        if target is None:
            raise HTTPException(404, "Tag not found in this project")
        if bool(target.get("archived")) == archived:
            return {"changed": False}
        definition = {**definition, "custom_fields": [{**f, "archived": archived} if f is target else f for f in fields]}
        await record_project(conn, project, definition, actor)
    return {"changed": True}
