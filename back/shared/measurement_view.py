"""A project's measurement settings as the Project › Setting screen shows them: pure code both servers use."""
from __future__ import annotations

import json

CURRENT_SQL = """SELECT m.*,p.definition AS project_definition FROM catalog.current_project p
    LEFT JOIN catalog.current_measurement m ON m.project_id=p.project_id WHERE p.project_id=$1"""


OPTIONS_SQL = """SELECT family,item_key,definition FROM catalog.reference_source
    WHERE family IN ('engine','country','brand_bit') AND status='active' ORDER BY family,item_key"""


def options_of(rows) -> dict:
    """What the form offers: the reference values the store holds."""
    out = {"brands": [], "countries": [], "engines": []}
    for r in rows:
        d = json.loads(r["definition"]) if isinstance(r["definition"], str) else r["definition"]
        name = {"brand_bit": "brands", "country": "countries", "engine": "engines"}[r["family"]]
        out[name].append(d.get("code") or r["item_key"])
    return {k: sorted(v) for k, v in out.items()}


def loaded(value):
    return json.loads(value) if isinstance(value, str) else (value if value is not None else [])


def view(row) -> dict:
    """A stored version for the screen; version 0 is a project with none."""
    if row is None or row["version"] is None:
        return {"version": 0, "brands": [], "countries": [], "engines": [], "cadence": None, "acrRepeats": None, "webUnits": [],
                "ownedUrls": [], "trackedUrls": [], "trackedTargets": [], "origin": None, "recordedAt": None}
    return {"version": row["version"], "brands": list(row["brands"]), "countries": list(row["countries"]), "engines": list(row["engines"]),
            "cadence": row["cadence"], "acrRepeats": row["acr_repeats"],
            "webUnits": [{"fileSeq": u.get("file_seq"), "langCodes": u.get("lang_codes") or [], "base": u.get("base")} for u in loaded(row["web_units"])],
            "ownedUrls": list(row["owned_urls"]), "trackedUrls": list(row["tracked_urls"]), "trackedTargets": loaded(row["tracked_targets"]),
            "origin": row["origin"], "recordedAt": row["recorded_at"]}
