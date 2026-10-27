"""Mention drilldowns: the browser-side fetches of the mention screens (brand row prompts, brand row
citation sources and one source's detail, the signal dialog's prompts, the answer modal's body).

Ports of front/lib/hgh/adapters/drilldown.ts and answers.ts with the four route handlers
front/app/api/scope/{brand-mention-prompts,brand-citations,signal-prompts,answer}/route.ts (the
local read-only branch: session = the database reader, scope {all: true}, source api), plus the
client computations of mentions-drilldown.tsx (prompt table orders, best rank, TOP 3 badge),
answer-modal.tsx (stance turn groups, own/competitor split, model chip labels, citation labels, the
link fallback list) and markdown-answer.tsx (highlight term list, sentiment sentence text).

Request: the route's search params, either as `ctx.params` = JSON [[key, value], ...] (the route
sends exactly what it received: repeated keys, empty values) or as plain query params.
Answer: {"status": <the route status>, "body": <the route JSON>}. A backend failure the route
relayed through hghErrorResponse is raised (HTTPException) so the route relays it the same way.

Route semantics kept: `q.get(k)` = the first value of k; the filter reader saw the LAST value of a
repeated key (`q.forEach((v, k) => sp[k] = v)`).
"""
from __future__ import annotations

import ipaddress
import json
import math
import re
from typing import Any
from urllib.parse import unquote_to_bytes

from fastapi import HTTPException

from bff import api
from bff.screens import screen, split_context
from bff.screens._convert import pct1_or_zero
from bff.screens._filters import load_project_gate, read_project_custom_field_filters_raw, read_standard_filters
from bff.screens._query import CITATION_CATEGORY_SLUGS, READER_SCOPE, analysis_query, is_uuid, js_trim, to_api_params, url_brands, url_countries
from bff.screens._sort import locale_compare, sort_by, table_orders

DRILLDOWN_LIST_LIMIT = 2000
BRAND_ANSWERS_LIMIT = 50
SIGNAL_PROMPTS_LIMIT = 50
SIGNAL_ANSWERS_LIMIT = 6
DETAIL_LIMITS = {"urls_limit": 10, "prompts_limit": 100, "answers_limit": 20}
SKEY_MAX = 512
TOP_RANK_THRESHOLD = 3
SIGNAL_KEYS = ("positive", "neutral", "mixed", "negative", "mention", "recommendation", "comparison", "definition", "final_choice")
# The analysis axes the website mention page shows (brand prompts / citations routes), and the
# signal route's list (no source axis).
WEBSITE_GROUPS = ("geography", "language", "engine", "time", "source", "brand")
SIGNAL_WEBSITE_GROUPS = ("geography", "language", "engine", "time", "brand")
UNAUTHORIZED = {"error": "unauthorized"}

# lib/scope/result-adapter.ts TARGET_LABEL / providerLabel
TARGET_LABEL = {"chatgpt": "ChatGPT", "gemini": "Gemini", "deepseek": "DeepSeek", "perplexity": "Perplexity",
                "claude": "Claude", "claude-web": "Claude", "claude-sonnet": "Claude", "claude-opus": "Claude"}
CATEGORY_LABEL_BY_SLUG = {slug: label for label, slug in CITATION_CATEGORY_SLUGS.items()}
_MISSING = object()


# ── request ──────────────────────────────────────────────────────────────────

class RouteParams:
    """The route's URLSearchParams: ordered (key, value) pairs."""

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs = pairs

    def get(self, key: str) -> str | None:
        """URLSearchParams#get: the first value, None when absent."""
        return next((v for k, v in self.pairs if k == key), None)

    def sp(self) -> dict[str, str]:
        """`q.forEach((v, k) => sp[k] = v)`: one string per key, the last value wins."""
        out: dict[str, str] = {}
        for k, v in self.pairs:
            out[k] = v
        return out


def route_params(q) -> RouteParams:
    ctx, _ = split_context(q)
    if "params" in ctx:
        try:
            raw = json.loads(ctx["params"])
            pairs = [(str(k), str(v)) for k, v in raw]
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "ctx.params must be a JSON list of [key, value] pairs") from exc
        return RouteParams(pairs)
    return RouteParams([(k, v) for k, v in q.multi_items() if not k.startswith("ctx.")])


def reply(status: int, body: Any) -> dict:
    return {"status": status, "body": body}


def drilldown_target(p: RouteParams) -> dict | None:
    """drilldownTarget: projectId -> project (a non-uuid id -> None), surface=website -> website, else global."""
    project_id = p.get("projectId")
    if project_id is not None:
        return {"surface": "project", "projectId": project_id} if is_uuid(project_id) else None
    return {"surface": "website" if p.get("surface") == "website" else "global"}


async def drilldown_gate(target: dict) -> int | None:
    """drilldownGate for the local reader: the place gate always passes (canReadAnalysis of the
    local_reader role with every menu group); a project needs the project gate (fetchProjectGate:
    shared/project-gate). None = open, else the route status (404; a 403 of the gate read is the
    code "invalid_value" in Gold, errorKindOf -> "permission" -> 404). Other failures are raised."""
    if target["surface"] != "project":
        return None
    try:
        project = await load_project_gate(target["projectId"])
    except HTTPException as exc:
        if exc.status_code == 403:
            return 404
        raise
    return None if project else 404


def drill_query(p: RouteParams, target: dict, website_groups: tuple[str, ...] | None) -> dict:
    """The route's readStandardFilters (+ project custom fields) -> analysisQuery {query, cf}."""
    sp = p.sp()
    surface = target["surface"]
    if surface == "project":
        filters = read_standard_filters(sp)
        ctx = {"surface": surface, "projectId": target["projectId"], "scope": None,
               "customFields": read_project_custom_field_filters_raw(sp)}
    else:
        website = surface == "website"
        filters = read_standard_filters(sp, READER_SCOPE, website_groups if website else None, "website" if website else "standard")
        ctx = {"surface": surface, "scope": READER_SCOPE}
    return analysis_query(filters, ctx)


def relay(exc: HTTPException) -> dict:
    """A backend failure the route did not map: 401 -> 401 {error: "unauthorized"}; anything else
    is raised so the route answers it with hghErrorResponse."""
    if exc.status_code == 401:
        return reply(401, UNAUTHORIZED)
    raise exc


# ── conversions (drilldown.ts) ───────────────────────────────────────────────

def provider_label(code: Any) -> Any:
    return TARGET_LABEL.get(code, code) if isinstance(code, str) else code


def engine_labels(codes: Any) -> list[str]:
    """Engine codes -> display labels, deduped in first-seen order (claude-web / claude-sonnet -> Claude)."""
    out: list[str] = []
    for c in codes or []:
        if not c:
            continue
        label = provider_label(c)
        if label not in out:
            out.append(label)
    return out


def utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def highlight_terms(brand_terms: list[str], model_terms: list[str]) -> list[dict]:
    """markdown-answer.tsx makeHighlightPlugin's term list: trimmed, lowercased surfaces of 2+ UTF-16
    units, model terms first then brand terms (a brand surface takes the brand colour but keeps its
    first position), longest first (stable). A surface of 3 units or less carries its original-case
    forms (`forms`, only an exact-case hit paints)."""
    kind: dict[str, str] = {}
    short: dict[str, list[str]] = {}

    def add(raw: str, k: str) -> None:
        t = js_trim(raw)
        lc = t.lower()
        if utf16_len(lc) < 2:
            return
        kind[lc] = k
        if utf16_len(lc) <= 3:
            forms = short.setdefault(lc, [])
            if t not in forms:
                forms.append(t)

    for t in model_terms:
        add(t, "model")
    for t in brand_terms:
        add(t, "brand")
    terms = sorted(kind, key=lambda s: -utf16_len(s))
    return [{"term": lc, "kind": kind[lc], **({"forms": short[lc]} if lc in short else {})} for lc in terms]


def to_mention_answer(a: dict, mode: str) -> dict:
    """M-3 AnswerRef -> MentionAnswerLive (+ highlightTerms); signal mode keeps the bare legacy reference."""
    if mode == "signal":
        return {"jobId": a.get("job_id"), "provider": provider_label(a.get("engine")), "region": a.get("region"),
                "mentionCount": a.get("value"), "position": None, "highlights": {"brand": [], "model": []},
                "measuredAt": None, "runs": 1, "highlightTerms": []}
    terms = a.get("terms") or {}
    brand = list(terms.get("brand") or [])
    model = list(terms.get("model") or [])
    runs = a.get("runs")
    return {"jobId": a.get("job_id"), "provider": provider_label(a.get("engine")), "region": a.get("region"),
            "mentionCount": a.get("value"), "position": a.get("position"), "highlights": {"brand": brand, "model": model},
            "measuredAt": a.get("measured_at"), "runs": runs if runs is not None else 1,
            "highlightTerms": highlight_terms(brand, model)}


def prompt_best_rank(answers: list[dict]) -> float | int | None:
    """_data/prompt-rank.ts promptBestRank: the smallest positive answer position, None without one."""
    best = None
    for a in answers or []:
        pos = a.get("position")
        if pos is None or pos <= 0:
            continue
        if best is None or pos < best:
            best = pos
    return best


def to_mentions_prompt(item: dict, mode: str) -> dict:
    """M-3 PromptItem -> MentionsPromptLive (brand mode adds bestRank / topRank for the rank column)."""
    text = item.get("prompt_text")
    funnel = item.get("funnel_code")
    out = {"id": item.get("prompt_id"), "promptText": text if text is not None else "", "mentions": item.get("count"),
           "share": pct1_or_zero(item.get("share")), "funnelStage": funnel,
           "providers": engine_labels(item.get("providers")),
           "answers": [to_mention_answer(a, mode) for a in item.get("answers") or []]}
    if mode == "brand":
        best = prompt_best_rank(out["answers"])
        out["bestRank"] = best
        out["topRank"] = best is not None and best <= TOP_RANK_THRESHOLD
    return out


def prompt_orders(rows: list[dict]) -> dict:
    """mentions-drilldown.tsx PromptsTable sorters (useSortableTable): text and funnel by
    localeCompare, no rank = +Infinity (last ascending, first descending), numbers by difference."""
    return table_orders(rows, {
        "prompt": lambda r: r["promptText"],
        "rank": lambda r: r["bestRank"] if r.get("bestRank") is not None else math.inf,
        "mentions": lambda r: r["mentions"],
        "share": lambda r: r["share"],
        "funnel": lambda r: r["funnelStage"] if r["funnelStage"] is not None else "",
        "providers": lambda r: len(r["providers"]),
    })


def domain_orders(rows: list[dict]) -> dict:
    """citation-domain-table.tsx column sorts (domain by localeCompare, numbers by difference)."""
    return table_orders(rows, {k: (lambda r, k=k: r[k]) for k in ("domain", "citations", "share", "prompts", "coverageRate")})


def cut_total(total: Any, shown: int) -> int | None:
    """A total worth reporting: the count before the cap, only when it is larger than what was read."""
    return total if isinstance(total, (int, float)) and not isinstance(total, bool) and total > shown else None


def page_total(res: dict) -> Any:
    page = (res.get("meta") or {}).get("page")
    return page.get("total") if isinstance(page, dict) else None


def category_label(c: Any) -> Any:
    """Category of a source row in the legacy vocabulary; unknown slug -> the API name (absent -> _MISSING)."""
    if not c:
        return None
    label = CATEGORY_LABEL_BY_SLUG.get(c.get("slug"))
    if label is not None:
        return label
    return c.get("name", _MISSING)


def to_citation_domain(r: dict) -> dict:
    """C-1 DomainRow -> CitationDomainLive (urls / promptList load when the row opens)."""
    prompts = r.get("citing_prompts")
    out = {"domain": r.get("skey"), "citations": r.get("citations"), "share": pct1_or_zero(r.get("share")),
           "prompts": prompts if prompts is not None else 0, "coverageRate": pct1_or_zero(r.get("coverage")),
           "urls": [], "promptList": [], "isOurs": r.get("is_own"), "category": category_label(r.get("category")),
           "subcategory": None, "skey": r.get("skey")}
    if out["category"] is _MISSING:
        del out["category"]
    return out


def display_citation_url(url: str) -> str:
    """lib/url-display.ts displayCitationUrl: scheme and fragment (from the first '#') dropped."""
    no_scheme = re.sub(r"\Ahttps?://", "", url)
    cut = no_scheme.find("#")
    return no_scheme if cut == -1 else no_scheme[:cut]


def _by_citations_desc(xs: list[dict]) -> list[dict]:
    return sort_by(list(xs), lambda a, b: (b["citations"] > a["citations"]) - (b["citations"] < a["citations"]))


def to_domain_drilldown(d: dict) -> dict:
    """C-1 detail -> the row's URL list and prompt list (legacy buildCitationDomains shapes)."""
    urls = []
    for u in _by_citations_desc(d.get("urls") or []):
        text = u.get("prompt_text")
        urls.append({"url": u.get("url"), "title": u.get("title") or display_citation_url(u.get("url")),
                     "count": u.get("citations"), "aiProvider": ", ".join(engine_labels(u.get("engines"))),
                     "promptText": text if text is not None else "", "country": u.get("country")})
    prompts = []
    for p in _by_citations_desc(d.get("prompts") or []):
        text = p.get("text")
        prompts.append({"id": p.get("prompt_id"), "promptText": text if text is not None else "", "funnelStage": p.get("funnel"),
                        "citations": p.get("citations"), "ownedCitations": p.get("own_citations"),
                        "providers": engine_labels(p.get("engines")),
                        # providerLabel(a.engine ?? "")
                        "answers": [{"jobId": a.get("job_id"), "provider": provider_label(a.get("engine") if a.get("engine") is not None else ""),
                                     "region": a.get("country"),
                                     "mentionCount": a.get("citations"), "position": None, "highlights": {"brand": [], "model": []},
                                     "measuredAt": None, "runs": 1, "highlightTerms": []} for a in p.get("answers") or []]})
    out: dict[str, Any] = {"urls": urls, "promptList": prompts}
    url_total = cut_total(d.get("url_total"), len(d.get("urls") or []))
    prompt_total = cut_total(d.get("prompt_total"), len(d.get("prompts") or []))
    if url_total is not None:
        out["urlTotal"] = url_total
    if prompt_total is not None:
        out["promptTotal"] = prompt_total
    return out


# ── answers.ts + the modal's computations ────────────────────────────────────

_ISO_INSTANT = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}(?::?\d{2})?))?", re.A)


def iso_instant(v: Any) -> Any:
    """answers.ts isoInstant: `new Date(v).toISOString()` (ms, Z) for the forms Gold sends (a date, or a
    date-time with Z / an offset; fractions are truncated to ms); anything else is returned as is."""
    if not v:
        return None
    if not isinstance(v, str):
        return v
    m = _ISO_INSTANT.fullmatch(v)
    if not m:
        return v
    from datetime import datetime, timedelta, timezone
    year, month, day, hh, mi, ss, frac, off = m.groups()
    try:
        if hh is None:
            dt = datetime(int(year), int(month), int(day), tzinfo=timezone.utc)
        else:
            ms = int((frac or "0")[:3].ljust(3, "0"))
            if off in ("Z", "z"):
                tz = timezone.utc
            else:
                sign = -1 if off[0] == "-" else 1
                digits = off[1:].replace(":", "")
                tz = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0)))
            dt = datetime(int(year), int(month), int(day), int(hh), int(mi), int(ss or 0), ms * 1000, tzinfo=tz)
        dt = dt.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return v
    return f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{dt.microsecond // 1000:03d}Z"


def _js_slice(s: str, start: Any, end: Any) -> str:
    """Array.from(s).slice(start, end).join("") for integer (or null) bounds."""
    n = len(s)

    def idx(v: Any, default: int) -> int:
        if v is _MISSING:
            return default
        i = 0 if v is None else int(v)
        return max(0, n + i) if i < 0 else min(i, n)

    a, b = idx(start, 0), idx(end, n)
    return s[a:b] if a < b else ""


def model_chip_label(m: dict) -> str:
    """answer-modal.tsx MentionStats: the rolled-up brand prefixed unless the model name already holds it."""
    name, brand = m.get("name"), m.get("brand")
    return f"{brand} {name}" if brand and brand.lower() not in name.lower() else name


def citation_label(c: dict) -> Any:
    """answer-modal.tsx AnswerCitations: title, else domain, else the display URL (a row without URL: title or domain)."""
    if c.get("url"):
        return c.get("title") or c.get("domain") or display_citation_url(c["url"])
    return c.get("title") or c.get("domain")


# answer-modal.tsx extractSources (the fallback source list when Gold has no citations for the job).
_JS_WS_CLASS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_MD_LINK = re.compile(r"\]\((https?://[^" + _JS_WS_CLASS + r")]+)\)")
_BARE_URL = re.compile(r"(https?://[^" + _JS_WS_CLASS + r")<>\]]+)")
_TRAILING_PUNCT = re.compile(r"[.,;)]+\Z")
SOURCES_LIMIT = 12


def extract_sources(text: str) -> list[dict]:
    """Markdown link targets, then bare URLs (trailing . , ; ) dropped), deduped in that order, the
    first 12 with their host (WHATWG hostname without a leading "www."; the URL itself when it does
    not parse)."""
    urls: dict[str, None] = {}
    for m in _MD_LINK.finditer(text):
        urls[m.group(1)] = None
    for m in _BARE_URL.finditer(text):
        urls[_TRAILING_PUNCT.sub("", m.group(1))] = None
    out = []
    for url in list(urls)[:SOURCES_LIMIT]:
        host = whatwg_hostname(url)
        out.append({"url": url, "host": url if host is None else re.sub(r"\Awww\.", "", host)})
    return out


_FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|%") | {chr(c) for c in range(0x01, 0x20)} | {"\x7f"}


def _ipv4_number(part: str) -> int | None:
    if part == "":
        return None
    base = 10
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        part, base = part[2:], 16
    elif len(part) >= 2 and part[0] == "0":
        part, base = part[1:], 8
    if part == "":
        return 0
    digits = {10: "0123456789", 8: "01234567", 16: "0123456789abcdefABCDEF"}[base]
    if any(ch not in digits for ch in part):
        return None
    return int(part, base)


def _ends_in_number(host: str) -> bool:
    parts = host.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last and all(ch in "0123456789" for ch in last):
        return True
    return _ipv4_number(last) is not None and last[:2] in ("0x", "0X")


def _ipv4(host: str) -> str | None:
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return None
    nums = []
    for part in parts:
        n = _ipv4_number(part)
        if n is None:
            return None
        nums.append(n)
    if any(n > 255 for n in nums[:-1]) or nums[-1] >= 256 ** (5 - len(nums)):
        return None
    value = nums[-1]
    for i, n in enumerate(nums[:-1]):
        value += n * 256 ** (3 - i)
    return ".".join(str((value >> s) & 255) for s in (24, 16, 8, 0))


def whatwg_hostname(url: str) -> str | None:
    """`new URL(url).hostname` for an http(s) URL (the scheme is already lowercase); None when the URL
    does not parse. Non-ASCII hosts use Python's IDNA 2003 codec (WHATWG uses UTS46): rare cases
    such as "ß" differ."""
    m = re.match(r"https?:", url)
    if not m:
        return None
    rest = url[m.end():].lstrip("/\\")
    end = next((i for i, ch in enumerate(rest) if ch in "/\\?#"), len(rest))
    authority = rest[:end]
    at = authority.rfind("@")
    hostport = authority[at + 1:] if at >= 0 else authority
    if hostport.startswith("["):
        close = hostport.find("]")
        if close < 0:
            return None
        host, port = hostport[:close + 1], hostport[close + 1:]
        if port and not port.startswith(":"):
            return None
        port = port[1:]
    else:
        colon = hostport.find(":")
        host, port = (hostport, "") if colon < 0 else (hostport[:colon], hostport[colon + 1:])
    if port and (not port.isascii() or not port.isdigit() or int(port) > 65535):
        return None
    if host == "":
        return None
    if host.startswith("["):
        try:
            return f"[{ipaddress.IPv6Address(host[1:-1]).compressed}]"
        except ValueError:
            return None
    try:
        domain = unquote_to_bytes(host).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
    try:
        ascii_domain = domain.lower() if domain.isascii() else ".".join(
            lbl.encode("idna").decode("ascii") if lbl else "" for lbl in re.split("[.。．｡]", domain))
    except UnicodeError:
        return None
    ascii_domain = ascii_domain.lower()
    if ascii_domain == "" or any(ch in _FORBIDDEN_HOST for ch in ascii_domain):
        return None
    if _ends_in_number(ascii_domain):
        return _ipv4(ascii_domain)
    return ascii_domain


def to_mirror_answer_detail(d: dict) -> dict:
    """AnswerDetail -> MirrorAnswerDetail (answers.ts) plus the modal's precomputed fields:
    citations[].label / showDomain, ownBrandMentions / competitorBrandMentions, modelMentions[].label,
    sources (link fallback when there are no citations), sentiment.spans[].text (the sentence the
    underline looks for), stanceGroups (stances by turn, turns ascending)."""
    body = d.get("body") or {}
    text = body.get("answer_text")
    if not body.get("available") or not text:
        return {"available": False}

    def by_count(xs: list[dict]) -> list[dict]:
        return sort_by(xs, lambda a, b: (b["count"] > a["count"]) - (b["count"] < a["count"]))

    citations = sort_by(list(d.get("citations") or []), lambda a, b: (a["ord"] > b["ord"]) - (a["ord"] < b["ord"]))
    brands = by_count([{"name": b.get("name"), "count": b.get("mention_count"), "tracked": b.get("own")}
                       for b in (d.get("mentions") or {}).get("brands") or []])
    models = by_count([{"name": m.get("name"), "count": m.get("mention_count"), "brand": m.get("parent_brand")}
                       for m in (d.get("mentions") or {}).get("models") or []])
    out: dict[str, Any] = {
        "available": True,
        "answerText": text,
        "measuredAt": iso_instant((d.get("header") or {}).get("measured_at")),
        "citations": [{"url": c.get("url"), "domain": c.get("domain"), "title": c.get("title"), "category": c.get("category")}
                      for c in citations],
        "brandMentions": brands,
        "modelMentions": [{**m, "label": model_chip_label(m)} for m in models],
    }
    for c in out["citations"]:
        c["label"] = citation_label(c)
        c["showDomain"] = bool(c["domain"] and c["title"])
    out["ownBrandMentions"] = [b for b in brands if b["tracked"]]
    out["competitorBrandMentions"] = [b for b in brands if not b["tracked"]]
    out["sources"] = extract_sources(text) if not out["citations"] else []
    sentiment = d.get("sentiment") or {}
    spans = sentiment.get("spans") or []
    skipped = sentiment.get("skipped") or 0
    if spans or skipped > 0:
        out["sentiment"] = {"spans": [{
            "start": s.get("start"), "end": s.get("end"), "sentiment": s.get("sentiment"),
            "evidence": [{"brandName": e.get("brand_name"), "sentiment": e.get("sentiment"), "assertion": e.get("assertion"),
                          "descriptors": list(e.get("descriptors") or []), "criteria": list(e.get("criteria") or []),
                          "contextSnippet": e.get("context_snippet")} for e in s.get("evidence") or []],
            "text": js_trim(_js_slice(text, s.get("start", _MISSING), s.get("end", _MISSING))),
        } for s in spans], "skipped": skipped}
    stances = [{"turnIndex": s.get("turn_index"), "entityId": s.get("entity_id"), "brand": s.get("brand"), "tracked": s.get("own"),
                "stance": s.get("stance"), "confidence": s.get("confidence"), "evidenceText": s.get("evidence_text"),
                "evidenceMatch": s.get("evidence_match"), "reason": s.get("reason")} for s in d.get("stances") or []]

    def stance_cmp(a: dict, b: dict) -> int:
        if a["turnIndex"] != b["turnIndex"]:
            return (a["turnIndex"] > b["turnIndex"]) - (a["turnIndex"] < b["turnIndex"])
        if a["tracked"] == b["tracked"]:
            return locale_compare(a["brand"], b["brand"])
        return -1 if a["tracked"] else 1

    stances = sort_by(stances, stance_cmp)
    if stances:
        out["stances"] = stances
        turns = sorted(dict.fromkeys(s["turnIndex"] for s in stances))
        out["stanceGroups"] = [{"turnIndex": t, "stances": [s for s in stances if s["turnIndex"] == t]} for t in turns]
    return out


# ── screens ──────────────────────────────────────────────────────────────────

@screen("mention/drill-brand-prompts")
async def brand_prompts(q) -> dict:
    """/api/scope/brand-mention-prompts: the prompts tab of a brand row (M-3 mode=brand, one request
    of up to 2,000 prompts). Body {prompts, total?, orders}: rows carry bestRank / topRank, answers
    carry highlightTerms; `orders` = the table's column orders (useOrderedTable)."""
    p = route_params(q)
    brand = p.get("mentionBrand")
    if not brand:
        return reply(400, {"error": "mentionBrand required"})
    target = drilldown_target(p)
    if target is None:
        return reply(404, {"prompts": []})
    try:
        blocked = await drilldown_gate(target)
    except HTTPException as exc:
        return relay(exc)
    if blocked:
        return reply(blocked, {"prompts": []})
    params = drill_query(p, target, WEBSITE_GROUPS)
    own_code = p.get("ownCode")
    target_params: dict[str, Any] = ({"own": True, **({"own_brand_code": own_code} if own_code else {})}
                                     if p.get("own") == "1" else {"mention_brand": brand})
    try:
        res = await api.get("mentions/prompts", to_api_params(params, {
            "mode": "brand", **target_params, "terms": True, "limit": DRILLDOWN_LIST_LIMIT, "answers_limit": BRAND_ANSWERS_LIMIT}))
    except HTTPException as exc:
        if exc.status_code == 404:
            return reply(200, {"prompts": [], "orders": prompt_orders([])})
        if exc.status_code == 403:
            return reply(403, {"prompts": []})
        if exc.status_code == 422:
            return reply(400, {"prompts": []})
        return relay(exc)
    prompts = [to_mentions_prompt(i, "brand") for i in res["data"]["items"]]
    body: dict[str, Any] = {"prompts": prompts}
    total = cut_total(page_total(res), len(prompts))
    if total is not None:
        body["total"] = total
    body["orders"] = prompt_orders(prompts)
    return reply(200, body)


@screen("mention/drill-signal-prompts")
async def signal_prompts(q) -> dict:
    """/api/scope/signal-prompts: the signal dialog (M-3 mode=signal, top 50 prompts with 6 answer
    references, lite). Body {prompts, total?}; 404 / 403 -> {prompts: []}; 422 -> 400."""
    p = route_params(q)
    signal = p.get("signal")
    if not signal or signal not in SIGNAL_KEYS:
        return reply(400, {"error": "valid signal required"})
    target = drilldown_target(p)
    if target is None:
        return reply(404, {"prompts": []})
    try:
        blocked = await drilldown_gate(target)
    except HTTPException as exc:
        return relay(exc)
    if blocked:
        return reply(blocked, {"prompts": []})
    params = drill_query(p, target, SIGNAL_WEBSITE_GROUPS)
    try:
        res = await api.get("mentions/prompts", to_api_params(params, {
            "mode": "signal", "signal": signal, "limit": SIGNAL_PROMPTS_LIMIT, "answers_limit": SIGNAL_ANSWERS_LIMIT, "lite": True}))
    except HTTPException as exc:
        if exc.status_code in (404, 403):
            return reply(200, {"prompts": []})
        if exc.status_code == 422:
            return reply(400, {"prompts": []})
        return relay(exc)
    prompts = [to_mentions_prompt(i, "signal") for i in res["data"]["items"]]
    total = cut_total(page_total(res), len(prompts))
    return reply(200, {"prompts": prompts, "total": total} if total is not None else {"prompts": prompts})


@screen("mention/drill-brand-citations")
async def brand_citations(q) -> dict:
    """/api/scope/brand-citations: the citation sources tab of a brand row (C-1 mention_brand, up to
    2,000 sources; body {domains, total?, orders}) and, with &skey=, one source's detail ({urls,
    promptList, urlTotal?, promptTotal?}). 404 -> the empty shape (200); 403 -> 403 and 422 -> 400
    with the empty shape."""
    p = route_params(q)
    brand = p.get("mentionBrand")
    if not brand:
        return reply(400, {"error": "mentionBrand required"})
    skey = p.get("skey")
    if skey is not None and (skey == "" or utf16_len(skey) > SKEY_MAX):
        return reply(400, {"error": "invalid skey"})
    target = drilldown_target(p)
    if target is None:
        return reply(404, {"domains": []})
    empty = {"urls": [], "promptList": []} if skey is not None else {"domains": []}
    try:
        blocked = await drilldown_gate(target)
    except HTTPException as exc:
        return relay(exc)
    if blocked:
        return reply(blocked, empty)
    params = drill_query(p, target, WEBSITE_GROUPS)
    try:
        if skey is not None:
            res = await api.get(f"citations/domains/{skey}", to_api_params(params, {"mention_brand": brand, **DETAIL_LIMITS}))
            return reply(200, to_domain_drilldown(res["data"]))
        res = await api.get("citations/domains", to_api_params(params, {
            "mention_brand": brand, "limit": DRILLDOWN_LIST_LIMIT, "include_competitor_totals": False}))
    except HTTPException as exc:
        if exc.status_code == 404:
            return reply(200, empty if skey is not None else {"domains": [], "orders": domain_orders([])})
        if exc.status_code == 403:
            return reply(403, empty)
        if exc.status_code == 422:
            return reply(400, empty)
        return relay(exc)
    domains = [to_citation_domain(r) for r in res["data"]["items"]]
    body: dict[str, Any] = {"domains": domains}
    total = cut_total(page_total(res), len(domains))
    if total is not None:
        body["total"] = total
    body["orders"] = domain_orders(domains)
    return reply(200, body)


@screen("mention/drill-answer")
async def answer(q) -> dict:
    """/api/scope/answer: the answer modal's body (AN-2, lite) gated like the legacy reader: project ->
    project_id + the URL countries (no profile scope); global -> the URL brand and countries;
    website -> the URL brand only. 404 / 403 / 422 -> {available: false}."""
    p = route_params(q)
    job_id = p.get("jobId")
    if not job_id:
        return reply(400, {"error": "jobId required"})
    target = drilldown_target(p)
    if target is None:
        return reply(404, {"available": False})
    try:
        blocked = await drilldown_gate(target)
    except HTTPException as exc:
        return relay(exc)
    if blocked:
        return reply(blocked, {"available": False})
    surface = target["surface"]
    scope = None if surface == "project" else READER_SCOPE
    filters = read_standard_filters(p.sp(), scope, None, "website" if surface == "website" else "standard")
    query: dict[str, Any] = {"surface": surface, "lite": True}
    if surface == "project":
        query["project_id"] = target["projectId"]
        countries = url_countries(filters.get("region"), scope)
        if countries:
            query["gate_country"] = countries
    else:
        brands = url_brands(filters.get("brand"), scope)
        if brands:
            query["brand"] = brands
            query["gate_brand"] = brands
        if surface == "global":
            countries = url_countries(filters.get("region"), scope)
            if countries:
                query["gate_country"] = countries
    try:
        res = await api.get(f"answers/{job_id}", query)
    except HTTPException as exc:
        if exc.status_code in (404, 403, 422):
            return reply(200, {"available": False})
        return relay(exc)
    return reply(200, to_mirror_answer_detail(res["data"]))
