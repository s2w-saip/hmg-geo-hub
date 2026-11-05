"""The renewal Overview's 근거 drawer (2026-11-05, D-12 step 3, the user's '본 프로젝트에 개발 시작' on the fixed
mockup (f9c0fcd docs/design/ui/market-heatmap-mockup.html, removed once built), S급 조건 4): a number of the 시장별 현황 table opens the answers
behind it. The two tabs are the KPI's own split of the market's representative answers (the answers the cell counts):
the answers in its numerator and the rest of its denominator (gold_reader.answers.split_where). Each row carries the
answer's own marks for that KPI and an excerpt around Gold's first occurrence of 당사; a row opens the original
answer view. The sample line (num / den) is the table row's own counts (overview/geo, renewal view).

Request: the route's search params as `ctx.params` (the page's filters + market=<country> repeated (a region row
sends its countries) + kpi + side (num | rest) + cursor), as the mention drilldowns take them.
Answer: {"status", "body"}: 200 {items, total, nextCursor, counts?} (counts = both tabs' answers, first page only);
400 {error} for a bad request. A backend failure is raised for the route to relay.
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from bff import api
from bff.gold_reader.answers import SPLIT_KPIS
from bff.screens import screen
from bff.screens.mention_drilldown import highlight_terms, provider_label, relay, reply, route_params
from bff.screens.overview import common_params, global_filters

EVIDENCE_PAGE = 50
EVIDENCE_SIDES = ("num", "rest")
#: the most countries one request names (a region row sends its countries; the largest region has 20)
EVIDENCE_MARKETS_MAX = 80
#: the excerpt: the text before and after 당사's first occurrence, else the answer's opening
EXCERPT_BEFORE, EXCERPT_AFTER, EXCERPT_LEAD = 70, 200, 260
#: how far a cut end looks for a space to stop at
EXCERPT_SNAP = 24

_COUNTRY = re.compile(r"[A-Z]{2}", re.ASCII)
# ChatGPT's private-use spans in a few bodies: an entity (shown as its name, the second field) or a citation (dropped)
_ENTITY = re.compile(r'\ue200entity\ue202\["[^"]*","([^"]*)"[^\ue201]*\ue201')
_PRIVATE = re.compile(r"\ue200[^\ue201]*\ue201|[\ue200-\ue2ff]")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARKUP = re.compile(r"[*`#>|]+")
_SPACE = re.compile(r"\s+")


def plain(s: str) -> str:
    """Excerpt text: ChatGPT's entity spans as their name, markdown links as their text, markup marks and runs of white
    space as one space."""
    return _SPACE.sub(" ", _MARKUP.sub(" ", _LINK.sub(r"\1", _PRIVATE.sub("", _ENTITY.sub(r"\1", s)))))


def entity_span(body: str, start: int, end: int) -> tuple[int, int] | None:
    """The ChatGPT entity span the occurrence sits in (Gold's offsets land on the name inside it), else None."""
    opened = body.rfind("\ue200", 0, start + 1)
    if opened < 0 or not body.startswith("\ue200entity\ue202", opened) or "\ue201" in body[opened:end]:
        return None
    closed = body.find("\ue201", end)
    return (opened, closed + 1) if closed >= 0 else None


def kst_iso(value: Any) -> Any:
    """An ISO instant in Asia/Seoul (the service's day: the answer view prints its first ten characters)."""
    if not isinstance(value, str):
        return value
    try:
        return datetime.fromisoformat(value).astimezone(ZoneInfo("Asia/Seoul")).isoformat()
    except ValueError:
        return value


def excerpt_of(body: str | None, occurrence: dict | None) -> dict | None:
    """{before, mark, after, cutStart, cutEnd}: the text around 당사's first occurrence (mark = Gold's surface text),
    or the answer's opening with no mark. None without a body."""
    if not body:
        return None
    if occurrence is None:
        head = plain(body[:EXCERPT_LEAD]).strip()
        return {"before": head, "mark": None, "after": "", "cutStart": False, "cutEnd": len(body) > EXCERPT_LEAD}
    start, end = occurrence["start"], occurrence["end"]
    # inside an entity span the mark stands for the span (its name), the span's markup left out
    left, right = entity_span(body, start, end) or (start, end)
    a, z = max(0, left - EXCERPT_BEFORE), min(len(body), right + EXCERPT_AFTER)
    # a cut word is left out where the text has spaces (a cut in Japanese or Chinese stays where it falls)
    if a > 0 and (gap := _SPACE.search(body, a, min(left, a + EXCERPT_SNAP))):
        a = gap.end()
    if z < len(body) and (gap := max((m.start() for m in _SPACE.finditer(body, max(right, z - EXCERPT_SNAP), z)), default=None)):
        z = gap
    return {"before": plain(body[a:left]).lstrip(), "mark": body[start:end], "after": plain(body[right:z]).rstrip(),
            "cutStart": a > 0, "cutEnd": z < len(body)}


def evidence_row(it: dict) -> dict:
    """An answers item (marks + excerpt) -> the drawer row, with the answer view's reference (its 당사 terms lit)."""
    marks = it["marks"]
    own = it["mentions"]["own"]["count"]
    terms = list(it.get("own_terms") or [])
    engine = provider_label(it["engine"])
    measured = kst_iso(it["measured_at"])
    return {"id": it["id"], "prompt": it["prompt"]["text"], "engine": engine, "country": it["country"], "lang": it["lang"],
            "measuredAt": measured, "ownMentions": own, "brandMentions": it["mentions"]["total"],
            "rank": marks["rank"], "sentiment": marks["sentiment"], "citations": marks["citations"],
            "excerpt": excerpt_of(it.get("answer_text"), it.get("own_occurrence")),
            "answer": {"jobId": it["id"], "provider": engine, "region": it["country"], "mentionCount": own,
                       "position": marks["rank"], "highlights": {"brand": terms, "model": []}, "measuredAt": measured,
                       "runs": 1, "highlightTerms": highlight_terms(terms, [])}}


def page_total(res: dict) -> int:
    return int(((res.get("meta") or {}).get("page") or {}).get("total") or 0)


@screen("overview/market-evidence")
async def market_evidence(q) -> dict:
    p = route_params(q)
    kpi, side = p.get("kpi"), p.get("side") or "num"
    markets = sorted({v.strip().upper() for k, v in p.pairs if k == "market"})
    cursor = p.get("cursor") or "0"
    if (kpi not in SPLIT_KPIS or side not in EVIDENCE_SIDES or not markets or len(markets) > EVIDENCE_MARKETS_MAX
            or not all(_COUNTRY.fullmatch(c) for c in markets) or not cursor.isdigit()):
        return reply(400, {"error": "invalid market evidence request"})
    # the table's read (overview/geo: the card's release, the page's filters) on the market's countries; the read
    # stays inside the account's scope (access.clamp)
    base: dict[str, Any] = {**common_params(global_filters(p.sp()), "global"), "country": markets, "card": True, "rep": True}
    reads = [api.get("answers", {**base, "split": f"{kpi}:{side}", "marks": True, "excerpt": True, "order": "prompt",
                                 "limit": EVIDENCE_PAGE, "cursor": int(cursor)})]
    if cursor == "0":
        reads.append(api.get("answers", {**base, "split": f"{kpi}:{'rest' if side == 'num' else 'num'}", "limit": 0}))
    try:
        res = await asyncio.gather(*reads)
    except HTTPException as exc:
        if exc.status_code == 422:
            return reply(400, {"error": "invalid market evidence request"})
        return relay(exc)
    page = res[0]
    total = page_total(page)
    body: dict[str, Any] = {"items": [evidence_row(it) for it in page["data"]["items"]], "total": total,
                            "nextCursor": ((page.get("meta") or {}).get("page") or {}).get("next_cursor")}
    if len(res) > 1:
        other = page_total(res[1])
        body["counts"] = {"num": total, "rest": other} if side == "num" else {"num": other, "rest": total}
    return reply(200, body)
