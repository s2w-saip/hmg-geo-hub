"""What the hub server's input editing and the data server's input lists share: small pure pieces, no database."""
from __future__ import annotations

import json
import re
import uuid

from fastapi import HTTPException

from shared.errors import refused

CATALOG_LOCK = 617427413   # the catalog writers' lock: one catalog writer at a time
LOCK_TIMEOUT = "5s"        # a write waits this long for another writer, then 503
LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"
BRANDS = ("Hyundai", "Kia", "Genesis")


# gold.dim_source.category_src -> the layer that decided the category (Gold ERD: 1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other)
LAYERS = {1: "override", 2: "social", 3: "owned", 4: "seed", 5: "rule", 6: "fallback"}


KEY_MAX = 300
CONTROL = re.compile(r"[\s\x00-\x1f\x7f]")


def invalid(message: str, *fields: str) -> HTTPException:
    return refused(422, "invalid_value", message, {"fields": list(fields)})


def published_view(row) -> dict | None:
    if row is None:
        return None
    return {"version": row["version"], "items": row["item_count"], "changeSeq": row["change_seq"], "recordedAt": row["recorded_at"]}


def as_json(value):
    return json.loads(value) if isinstance(value, str) else value


def code_row(row, gold: dict | None = None, compare: bool = False) -> dict:
    view = {"code": row["code"], "number": row["number"], "nameEn": row["name_en"], "nameKo": row["name_ko"],
            "ord": row["ord"], "description": row["description"], "updatedAt": row["updated_at"]}
    if compare:
        g = (gold or {}).get(row["code"])
        view["gold"] = {"name": g["name"], "ord": g["ord"]} if g else None
        view["state"] = "applied" if g and g["name"] == row["name_en"] and g["ord"] == row["ord"] else "pending"
    return view


def published_sql(family: str) -> str:
    return f"""SELECT version,item_count,change_seq,recorded_at FROM catalog.current_reference_set WHERE family='{family}'"""


def host_of(key: str) -> str:
    return key.split("/")[0]


def entity_key(value: str | None) -> uuid.UUID:
    try:
        return uuid.UUID(value or "")
    except ValueError:
        raise invalid("An entity is its Gold entity_id", "entityId") from None


def entity_role_view(row) -> dict | None:
    if row is None:
        return None
    return {"role": row["role"], "brand": row["brand"], "note": row["note"], "status": row["status"], "origin": row["origin"],
            "updatedAt": row["updated_at"]}


def gold_own_brand(gold) -> str | None:
    """The own brand Gold has for the entity: its display brand when that is an own brand (the family `entity`'s rule)."""
    return gold["brand"] if gold and gold["kind"] == 1 else None


def override_view(row) -> dict | None:
    if row is None:
        return None
    return {"category": row["category"], "note": row["note"], "status": row["status"], "origin": row["origin"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}
