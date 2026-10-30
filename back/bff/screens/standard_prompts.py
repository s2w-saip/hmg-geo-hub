"""/standard/prompts (Global prompts, the original page and the renewal page): one page of the read-only
catalog list with its filter options, the page header's collection period, the export rows and the
change-history feed.

Ports: back/app catalog/prompts screen.py catalog_screen (the list's filters, facets, columns, order and
paging, read-only row fields), lib/standards/prompt-markets.ts (market codes),
lib/hgh/adapters/catalog.ts standardCollectionPeriodApi / listGlobalAuditApi,
lib/hgh/prompt-timeline.ts fetchPromptTimelineApi and the history tab's period/event filter and bulk
grouping (audit-history-view.tsx).

Brand presence and measurement kind are Gold's values only (renewal audit 13-1 · 13-2, 2026-10-31): the original's
presence_effective (no value -> 미포함 for the umbrella brand, 포함 for any other) and the 'single' default for an
empty kind made up a value Gold does not hold (rule 5). An empty one stays empty ('—'), and the filter offers it as
'값 없음' (NONE) when the scope has such a row. On 2026-10-31 Gold has none (renewal audit U8)."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import icu
from fastapi import HTTPException

from bff import api
from bff.screens import screen, split_context
from bff.screens._filters import load_filter_dates
from bff.screens._js import js_str

AXES = ("listType", "depth1", "depth2", "depth3", "depth4", "funnel", "presence", "kind", "market", "lang", "status")
# Axes matched by equality on one row field.
FIELDS = {"listType": "listType", "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4",
          "funnel": "funnelStage", "kind": "kind", "lang": "lang"}
SORTS = ("text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "kind", "market",
         "lang", "status", "tracked")
PAGE_LIMIT_MAX = 500            # one page with the filter options (the former screen's bound)
READ_LIMIT = 20000              # one /v1/prompts page holds the whole global catalog
VALUE_MAX = 5000
UMBRELLA_BRAND = "HMG"
PRESENCES = ("branded", "unbranded")
KINDS = ("acr", "single")
NONE = "none"                   # the filter pick of the rows Gold left without a presence / kind
GEO_PSEUDO = ("x:WW", "x:EU", "x:ME")
HISTORY_LIMIT = 500
TIMELINE_LIMIT = 100
TIMELINE_FROM = "2000-01-01"    # the legacy timeline had no window: from/to always sent
COLLATORS = {"ko": icu.Collator.createInstance(icu.Locale("ko")), "en": icu.Collator.createInstance(icu.Locale("en"))}


def one(sp: dict, key: str) -> str | None:
    v = sp.get(key)
    return v[0] if isinstance(v, list) else v


# ═══ market codes and brand presence (lib/standards/prompt-markets.ts, lib/scope/brand-presence.ts) ═══════

def normalize_market(raw: str) -> str | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    return f"x:{trimmed[2:].upper()}" if trimmed.lower().startswith("x:") else trimmed.upper()


def split_markets(regions: list[str] | None) -> dict[str, list[str]]:
    """Real countries and `x:` pseudo codes, each normalized, unique and sorted (empty both = unset = "전체")."""
    real: set[str] = set()
    pseudo: set[str] = set()
    for raw in regions or []:
        code = normalize_market(raw) if isinstance(raw, str) else None
        if code:
            (pseudo if code.startswith("x:") else real).add(code)
    return {"real": sorted(real), "pseudo": sorted(pseudo)}


def catalog_row(item: dict) -> dict:
    """A Gold catalog item as the list row. scopePromptId stays null for a prompt with no answers in the
    current builds (the row's 측정 상태); presence, common and markets are what the row badges show.
    presence and kind are Gold's values (None when Gold has none, or a code the list has no label for)."""
    brand = item.get("brand_code")
    measured = bool(item.get("measured"))
    presence, kind = item.get("brand_presence"), item.get("kind")
    return {"id": item["prompt_id"], "text": item.get("text") or "", "brand": brand,
            "brandPresence": presence, "listType": item.get("list_type"),
            "depth1": item.get("depth1"), "depth2": item.get("depth2"), "depth3": item.get("depth3"),
            "depth4": item.get("depth4"), "funnelStage": item.get("funnel_stage"), "kind": kind if kind in KINDS else None,
            "lang": item.get("lang"), "regions": item.get("regions"),
            "scopePromptId": item.get("scope_prompt_id") if measured else None,
            "presence": presence if presence in PRESENCES else None,
            "common": brand is None or brand == UMBRELLA_BRAND,
            "markets": split_markets(item.get("regions"))}


async def catalog_rows() -> list[dict]:
    """The global catalog inside the account's scope: api.get clamps the read to the account's brands and countries,
    and the reader keeps the prompts of those brands (+ the umbrella) whose target markets hold a scope country or no
    real country (renewal audit 13-3, the original API's B1 rule). An administrator or an HQ account reads every market."""
    items: list[dict] = []
    cursor: str | None = "0"
    while cursor is not None:
        res = await api.get("prompts", {"surface": "global", "card": "true", "limit": READ_LIMIT, "cursor": cursor})
        items.extend(res["data"]["items"])
        cursor = ((res.get("meta") or {}).get("page") or {}).get("next_cursor") or None
    return [catalog_row(i) for i in items]


# ═══ request ═════════════════════════════════════════════════════════════════════════════════════════════

def invalid(message: str) -> HTTPException:
    return HTTPException(422, message)


def read_filters(sp: dict, prefix: str) -> dict[str, str]:
    out = {}
    for axis in AXES:
        v = one(sp, f"{prefix}{axis}")
        if v is not None and len(v) > VALUE_MAX:
            raise invalid("Invalid catalog filters")
        out[axis] = v or "all"
    return out


def read_int(raw: str | None, default: int) -> int:
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise invalid("Invalid catalog page query") from None


def read_query(sp: dict, paged: bool = True) -> dict:
    """f.<axis> = applied filters, d.<axis> = the draft the options cascade on, ml.<code> = market labels
    (the order of a market sort), search, sort, asc, page (1-based), limit, collation."""
    search = one(sp, "search") or ""
    sort = one(sp, "sort") or "depth1"
    collation = one(sp, "collation") or "en"
    page, limit = read_int(one(sp, "page"), 1), read_int(one(sp, "limit"), 50)
    if (sort not in SORTS or collation not in COLLATORS or len(search) > VALUE_MAX
            or (paged and not (1 <= limit <= PAGE_LIMIT_MAX and 1 <= page <= 10_000_000))):
        raise invalid("Invalid catalog page query")
    labels = {k[3:]: one(sp, k) for k in sp if k.startswith("ml.")}
    return {"filters": read_filters(sp, "f."), "draft": read_filters(sp, "d."), "search": search, "sort": sort,
            "asc": one(sp, "asc") != "false", "page": page, "limit": limit, "collation": collation, "labels": labels}


# ═══ filters, options, order (catalog_screen) ═══════════════════════════════════════════════════════════

def matches(row: dict, f: dict[str, str], search: str) -> bool:
    for axis, field in FIELDS.items():
        if f[axis] != "all" and row[field] != (None if axis == "kind" and f[axis] == NONE else f[axis]):
            return False
    if f["presence"] != "all" and row["presence"] != (None if f["presence"] == NONE else f["presence"]):
        return False
    if f["status"] in ("measured", "tracked") and row["scopePromptId"] is None:
        return False
    if f["status"] in ("unmeasured", "untracked") and row["scopePromptId"] is not None:
        return False
    if f["market"] != "all":
        target = normalize_market(f["market"])
        if target is None or target not in row["markets"]["real"] + row["markets"]["pseudo"]:
            return False
    needle = search.strip().lower()
    return not needle or needle in row["text"].lower()


def facets(rows: list[dict], draft: dict[str, str]) -> dict[str, list[str]]:
    """Options over the whole scope: depth options narrow by the draft's parent picks (listType > depth1 >
    depth2 > depth3); the other axes do not. Market: real countries, then the geographic pseudo codes;
    marketSort = every code (the labels a market sort needs). Presence and kind: their fixed values, and
    NONE ('값 없음') when a row of the scope has no Gold value."""
    out: dict[str, list[str]] = {}
    parents: list[tuple[str, str]] = []
    for key in ("listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang"):
        field = FIELDS[key]
        scoped = [r for r in rows if all(r[f] == v for f, v in parents)] if parents and key.startswith("depth") else rows
        out[key] = sorted({r[field] for r in scoped if r[field]})
        if key in ("listType", "depth1", "depth2", "depth3") and draft[key] != "all":
            parents.append((field, draft[key]))
    codes = {c for r in rows for c in r["markets"]["real"] + r["markets"]["pseudo"]}
    out["market"] = sorted(c for c in codes if not c.startswith("x:")) + sorted(c for c in codes if c in GEO_PSEUDO)
    out["marketSort"] = sorted(codes)
    out["presence"] = [*PRESENCES, *([NONE] if any(r["presence"] is None for r in rows) else [])]
    out["kind"] = [*KINDS, *([NONE] if any(r["kind"] is None for r in rows) else [])]
    return out


def columns(rows: list[dict]) -> list[str]:
    """Taxonomy columns with a value in at least one row of the scope."""
    return [k for k in ("listType", "depth1", "depth2", "depth3", "depth4") if any(r[FIELDS[k]] for r in rows)]


def first_market(row: dict) -> str | None:
    m = row["markets"]
    return (m["real"] or m["pseudo"] or [None])[0]


def ordered(rows: list[dict], q: dict) -> list[dict]:
    """The list order: the sort key under the ICU collation of the viewer's language (missing taxonomy
    values as '~'), then depth1, depth2, depth3, the text's first 256 characters and the id ascending."""
    key = COLLATORS[q["collation"]].getSortKey

    def nullable(v: str | None) -> tuple:
        return (1, b"") if v is None else (0, key(v))

    labels = q["labels"]

    def market(r: dict) -> bytes:
        code = first_market(r)
        if code is None:
            return key("~")
        label = labels.get(code)
        return key(label if label is not None else code)

    primary = {
        "text": lambda r: key(r["text"]),
        "brand": lambda r: key(r["brand"] or ""),
        "presence": lambda r: key(r["presence"] or "~"),
        # an empty kind apart from single, where the other sorts put an empty value ('~' comes before letters in ICU)
        "kind": lambda r: {"single": 0, "acr": 1}.get(r["kind"], -1),
        "status": lambda r: r["scopePromptId"] is not None,
        "tracked": lambda r: r["scopePromptId"] is not None,
        "market": market,
        **{k: (lambda f: lambda r: key(r[f] or "~"))(FIELDS[k]) for k in ("listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang")},
    }[q["sort"]]
    ties = sorted(rows, key=lambda r: (nullable(r["depth1"]), nullable(r["depth2"]), nullable(r["depth3"]), key(r["text"][:256]), r["id"]))
    return sorted(ties, key=primary, reverse=not q["asc"])  # stable: equal keys keep the tie order


def listing(rows: list[dict], q: dict) -> tuple[list[dict], dict]:
    """(filtered rows in list order, the options and columns of the scope)."""
    filtered = [r for r in rows if matches(r, q["filters"], q["search"])]
    return ordered(filtered, q), {"count": len(rows), "facets": facets(rows, q["draft"]), "columns": columns(rows)}


# ═══ screens ═════════════════════════════════════════════════════════════════════════════════════════════

@screen("catalog/prompts-page")
async def prompts_page(q) -> dict:
    """One page of the list, its totals and pager labels, and the filter options."""
    _, sp = split_context(q)
    req = read_query(sp)
    rows, meta = listing(await catalog_rows(), req)
    total, limit = len(rows), req["limit"]
    offset = min((req["page"] - 1) * limit, max(0, (total - 1) // limit * limit))
    page_rows = rows[offset:offset + limit]
    return {"rows": page_rows, "total": total, **meta, "offset": offset, "limit": limit, "collation": req["collation"],
            "page": offset // limit + 1, "pages": max(1, math.ceil(total / limit)),
            "rangeFrom": 0 if total == 0 else offset + 1, "rangeTo": offset + len(page_rows)}


@screen("catalog/prompts-export")
async def prompts_export(q) -> dict:
    """Every row of the list for the same picks, in list order, and the columns the sheet carries."""
    _, sp = split_context(q)
    req = read_query(sp, paged=False)
    rows, meta = listing(await catalog_rows(), req)
    return {"rows": rows, "columns": meta["columns"]}


@screen("catalog/prompts-header")
async def prompts_header(q) -> dict:
    """The page header's collection period (first measured day ~ latest round day)."""
    dates = await load_filter_dates("global")
    start, end = dates.get("firstMeasuredDate"), dates.get("latestAnchorDay")
    return {"period": {"from": start, "to": end} if start and end else None}


def text_of(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    return js_str(v) if isinstance(v, (int, float)) else str(v)


def audit_view(r: dict) -> dict:
    """A /v1/prompts/history row as the history views read it (toAuditView)."""
    changes = {field: {"old": text_of((pair or {}).get("old")), "new": text_of((pair or {}).get("new"))}
               for field, pair in (r.get("changes") or {}).items()}
    return {"id": str(r["audit_id"]), "promptId": r.get("prompt_id"), "actorId": r.get("actor_id"),
            "actorType": r.get("actor_type"), "eventType": r.get("event_type"), "changes": changes,
            "batchId": r.get("batch_id"), "createdAt": r.get("created_at"), "actorEmail": r.get("actor_email"),
            "promptText": r.get("prompt_text"), "promptBrand": r.get("prompt_brand")}


def instant(raw: str) -> datetime:
    t = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def batch_groups(rows: list[dict]) -> list[dict]:
    """Consecutive rows of one bulk batch fold into one group (rows come newest first)."""
    out: list[dict] = []
    for row in rows:
        last = out[-1] if out else None
        if row["batchId"] and last and last["batchId"] == row["batchId"]:
            last["rows"].append(row)
        else:
            out.append({"key": row["id"], "batchId": row["batchId"], "rows": [row]})
    return out


@screen("catalog/prompts-timeline")
async def prompts_timeline(q) -> dict:
    """One prompt's change timeline (the row's 이력 button): the latest 100, newest first, no window
    (lib/hgh/prompt-timeline.ts fetchPromptTimelineApi). available = false as for the history tab."""
    _, sp = split_context(q)
    prompt_id = one(sp, "prompt_id")
    if not prompt_id or len(prompt_id) > 200:
        raise invalid("Invalid prompt id")
    today = datetime.now(ZoneInfo("Asia/Seoul")).date().isoformat()
    try:
        res = await api.get("prompts/history", {"surface": "global", "prompt_id": prompt_id, "from": TIMELINE_FROM,
                                                "to": today, "limit": TIMELINE_LIMIT})
    except HTTPException as exc:
        if exc.status_code == 503:
            return {"available": False, "rows": []}
        raise
    return {"available": True, "rows": [audit_view(r) for r in res["data"]["items"]]}


@screen("catalog/prompts-history")
async def prompts_history(q) -> dict:
    """The 변경 이력 tab: the latest changes in the last 30 or 90 days, one event type or all, in bulk
    groups. available = false when the connected source does not supply the change history."""
    _, sp = split_context(q)
    days = 30 if one(sp, "days") == "30" else 90
    event = one(sp, "event") or "all"
    try:
        res = await api.get("prompts/history", {"surface": "global", "limit": HISTORY_LIMIT})
    except HTTPException as exc:
        if exc.status_code == 503:
            return {"available": False, "shown": 0, "groups": []}
        raise
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = [v for v in (audit_view(r) for r in res["data"]["items"])
            if v["createdAt"] and instant(v["createdAt"]) >= since and (event == "all" or v["eventType"] == event)]
    return {"available": True, "shown": len(rows), "groups": batch_groups(rows)}
