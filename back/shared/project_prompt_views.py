"""A project's prompts as the Project › Prompt screen shows them: pure code both servers use."""
from __future__ import annotations

from shared.prompt_revisions import definition_of

STATUSES = ("draft", "active", "paused", "archived", "removed")
PROJECT_SQL = """SELECT project_id,origin,version,definition,recorded_at FROM catalog.current_project WHERE project_id=$1"""


PROMPTS_SQL = """SELECT p.prompt_id,p.origin,p.registered_at,p.version,p.text,p.definition,p.recorded_at,
        EXISTS(SELECT 1 FROM catalog.prompt_version h WHERE h.prompt_id=p.prompt_id AND h.recorded_by IS NOT NULL) AS hub_edited
    FROM catalog.current_prompt p WHERE p.project_id=$1 ORDER BY p.registered_at,p.prompt_id"""


LANGUAGES_SQL = "SELECT item_key FROM catalog.current_reference WHERE family='language'"


def status_of(definition: dict) -> str:
    status = definition.get("status")
    return status if status in STATUSES else "active"


def language_of(definition: dict) -> str | None:
    return (definition.get("language") or "").lower() or None


def fields_of(definition: dict) -> list[dict]:
    """The project's tag columns in Gold's order (created_at, field_id), archived ones included."""
    fields = definition.get("custom_fields") if isinstance(definition.get("custom_fields"), list) else []
    return sorted(({"id": str(f["field_id"]), "label": f["label"], "archived": bool(f.get("archived")),
                    "createdAt": f.get("created_at")} for f in fields), key=lambda f: (str(f["createdAt"] or ""), f["id"]))


def prompt_view(row) -> dict:
    d = definition_of(row)
    custom = d.get("custom_values") if isinstance(d.get("custom_values"), dict) else {}
    return {"id": str(row["prompt_id"]), "origin": row["origin"], "version": row["version"], "text": row["text"],
            "kind": d.get("kind") or None, "lang": language_of(d), "status": status_of(d), "custom": dict(custom),
            "hubEdited": bool(row["hub_edited"]), "recordedAt": row["recorded_at"], "registeredAt": row["registered_at"]}
