"""A prompt's revisions as the Global prompts screens show them: pure code both servers use. The hub server edits the prompts and shows one prompt's history, the data server builds
the history screen."""
from __future__ import annotations

import json
import re

# API field -> definition key (the keys sync_catalog.py records for Gold prompts)
LABELS = {"funnel": "funnel", "brandPresence": "brand_presence", "listType": "list_type",
          "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4"}


CONTROL = re.compile(r"[\x00-\x1f\x7f]")


GLOBAL_PROJECT_SQL = """SELECT project_id FROM catalog.current_project
    WHERE definition->>'surface'='1' AND definition->>'is_root'='true' AND coalesce(definition->>'status','active')<>'removed'"""


# The Global catalog's revisions with the one before each, newest first: the change history the Global prompts screen shows.
HISTORY_ROWS_SQL = """SELECT v.prompt_id,v.version,v.text,v.definition,v.recorded_at,v.recorded_by,v.recorded_by_login,v.recorded_by_name,
        w.version AS prev_version,w.text AS prev_text,w.definition AS prev_definition
    FROM catalog.prompt_version v JOIN catalog.prompt p USING(prompt_id)
    LEFT JOIN catalog.prompt_version w ON w.prompt_id=v.prompt_id AND w.version=v.version-1
    WHERE p.project_id=$1 AND ($2::uuid IS NULL OR v.prompt_id=$2) AND ($4::timestamptz IS NULL OR v.recorded_at>=$4)
    ORDER BY v.recorded_at DESC,v.prompt_id LIMIT $3"""


def normalize_region(raw: str) -> str | None:
    """Same codes as the Global prompts screen (screens/standard_prompts.normalize_market): KR, x:WW."""
    value = raw.strip()
    if not value:
        return None
    return f"x:{value[2:].upper()}" if value.lower().startswith("x:") else value.upper()


def encoded(value) -> str:
    """The same canonical JSON as hub_storage/sync_catalog.py, so HUB and Gold revisions hash alike."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def definition_of(row) -> dict:
    value = row["definition"]
    return json.loads(value) if isinstance(value, str) else dict(value)


def status_of(definition: dict) -> str:
    status = definition.get("status")
    return status if status in ("archived", "removed") else "active"


def snapshot(text: str, definition: dict) -> dict:
    """The fields the screen shows and edits, from a stored text + definition (Gold or HUB)."""
    regions = definition.get("regions")
    catalogs = definition.get("catalogs")
    first_row = catalogs[0] if isinstance(catalogs, list) and catalogs else {}
    return {"text": text, "kind": definition.get("kind") or None, "language": definition.get("language") or None,
            "regions": sorted({r for r in (normalize_region(str(x)) for x in regions) if r}) if isinstance(regions, list) else [],
            **{api: definition.get(key) or first_row.get(key) or None for api, key in LABELS.items()}, "status": status_of(definition)}


def history(rows: list) -> list[dict]:
    """Revisions oldest -> newest as events newest first: created / updated / archived / restored, with the
    changed fields (old -> new). A Gold revision that changed only fields this screen does not show has
    no changes listed."""
    events, previous = [], None
    for r in rows:
        current = snapshot(r["text"], definition_of(r))
        if previous is None:
            event, changes = "created", {}
        else:
            changes = {k: {"old": previous[k], "new": v} for k, v in current.items() if k != "status" and previous[k] != v}
            status = current["status"]
            event = "updated" if previous["status"] == status else status if status in ("archived", "removed") else "restored"
        events.append({"version": r["version"], "event": event, "changes": changes, "recordedAt": r["recorded_at"],
                       "recordedBy": str(r["recorded_by"]) if r["recorded_by"] else None, "actor": {"login": r["recorded_by_login"], "displayName": r["recorded_by_name"]} if r.get("recorded_by_login") else None})
        previous = current
    return events[::-1]


def audit_event(event: str, changes: dict) -> str:
    """history()'s event -> the audit event the Global prompts history names."""
    if event == "updated":
        return "text_updated" if "text" in changes else "meta_updated"
    return {"created": "created", "archived": "enabled_changed", "removed": "deleted", "restored": "restored"}[event]


def audit_row(row) -> dict:
    """One revision as a history row. A Gold import writes a run's revisions in one transaction, one recorded_at: one batch."""
    before = [{"text": row["prev_text"], "definition": row["prev_definition"], "version": row["prev_version"],
               "recorded_at": None, "recorded_by": None}] if row["prev_version"] is not None else []
    event = history([*before, row])[0]
    changes = {field: {side: ", ".join(v) if isinstance(v, list) else v for side, v in pair.items()} for field, pair in event["changes"].items()}
    actor = event["recordedBy"]
    return {"audit_id": f"{row['prompt_id']}:{row['version']}", "prompt_id": str(row["prompt_id"]), "actor_id": actor,
            "actor_type": "user" if actor else "system", "event_type": audit_event(event["event"], changes), "changes": changes,
            "batch_id": None if actor else row["recorded_at"].isoformat(), "created_at": row["recorded_at"].isoformat(),
            "actor_email": row["recorded_by_login"] if actor else None, "prompt_text": row["text"], "prompt_brand": None}
