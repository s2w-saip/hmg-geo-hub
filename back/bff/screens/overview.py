"""Overview dashboards: /dashboard (global), /website and /renewal/dashboard.

Ports the API branch of the three pages and everything their components computed:
  lib/hgh/adapters/dashboard.ts       loaders, calls, toLiveGeo / marketOf / geoMetrics,
                                      toSourceSlices, toDashboardKpis, loadCompetitorSources
  dashboard/_data/live.ts              getLiveGeo empty-state rule, the card Δ / sparkline trend
  dashboard/page.tsx                   section reads, period shape and label context
  dashboard/_components/overview-kpi-cards.tsx   card state, period block, Δ, sparklines, competitor rows
  dashboard/_components/summary-tiles(-deferred-deltas).tsx   tile groups, state, tone, period chip,
                                      suppression caption, the deferred Δ / badge merge
  dashboard/_components/geo-overview.tsx, geo-map.tsx   metric values, rival fallback, country order and
                                      groups, map bindings (numeric codes, RHQ countries), colour domain
  dashboard/_components/live-trend-chart.tsx   chart rows (label day, gap per family), available series
  website/page.tsx + website/_data/live.ts     website sections (no single active brand -> empty GEO)
  renewal/dashboard/page.tsx + _components/overview-body.tsx, overview-model.ts
                                      own label, compare title, standing, brand matrix, bar widths

Screens (one per Suspense section; `ctx.surface` = global | website where both pages share one):
  overview/as-of             header pill / as-of chip          {asOf}
  overview/filters           filter bar props                  OverviewFilters / WebsiteFilters props
  overview/cards             KPI cards (global, renewal)       {state, cards, compareTitle}
  overview/card-trend        card Δ + sparklines (deferred)    {degraded, cards, count}
  overview/card-competitors  card competitor rows (deferred)   {degraded, rows, standing?}
  overview/geo               GEO section (global, renewal)     {geo, degraded}
  overview/brand-matrix      renewal brand x KPI table         {rows, cols, degraded?} | null
  website/summary            website tiles                     {state, tiles}
  website/summary-deferred   website tiles with Δ and badge    {tiles}
  website/trend              website KPI trend chart           {trend}
  website/composition        website source composition        {sources, topics, degraded}
  website/geo                website GEO map + snapshot        {show, degraded, geo}
  website/engines            renewal per-engine values         {engines, consistency, extremes, widest, degraded}
  website/brands             renewal per-brand tiles (admin)   {brands} | {brands: None}

Failure rules (the old degrade registry is gone; the payload says what the page used to read from it):
a transient failure (5xx, timeout, database error) of a read that used to degrade empties that part
and is reported in the payload (`degraded`, `state`); a 4xx is raised so the page keeps its error path.
Context keys: ctx.surface, ctx.locale (country order), ctx.admin (website brand axis), ctx.view
(renewal), ctx.today (test seam: the KST day used by the period labels; default today in KST).
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

import asyncpg
import icu
from fastapi import HTTPException

from bff import api
from bff.access import reader_scope
from bff.screens import screen, split_context
from bff.screens._compare import fetch_period_compare_api
from bff.screens._competitors import (
    brand_key, candidate_brand_keys, competitor_row, to_competitor_brand_values, to_competitor_citation_domains,
)
from bff.screens._convert import as_of_date, pct1_or_null, pct1_or_zero, rank_avg
from bff.screens._filters import (
    fetch_filter_dates, filter_dates_view, load_panel_options, load_website_prompt_options, read_standard_filters,
)
from bff.screens._js import is_num, js_round
from bff.screens._period import kst_today, label_key_of, period_caption, period_chip, resolve_request_compare_period_shape
from bff.screens._query import RHQ_REGION_COUNTRIES, UMBRELLA_BRAND, analysis_query, to_api_params
from bff.screens._summary import (
    DASHBOARD_SUMMARY_PARTS, apply_competitor_sov_from_brands, apply_engine_consistency, consistency, fetch_kpi_summary,
    overview_card_state, summary_is_empty, to_mirror_kpis, to_url_rate_kpis,
)
from bff.screens._trend import (
    OVERVIEW_TREND_METRICS, apply_trend_deltas, fetch_trend, spark_points, spark_y_domain, sparkline_trend,
    to_brand_trend_result, to_first_position_result, to_live_trend, trend_gap_applies,
)

# ── constants (front master data and call shapes) ───────────────────────────

OVERVIEW_KPI_KEYS = ("visibility", "shareOfVoice", "sentiment", "position", "citationShare")
# components/dash/period-delta-metrics.ts KPI_KEY_TO_COMPARE_METRIC (None = out of the compare contract)
# the AI 인용 점유율 card too (2026-10-29 metric review R3: it alone showed the round Δ in period mode)
KPI_KEY_TO_COMPARE_METRIC = {"visibility": "visibility", "shareOfVoice": "share", "sentiment": "favorability",
                             "position": "position", "citationShare": "citationShare"}
OVERVIEW_COMPARE_METRICS = ["visibility", "share", "favorability", "position", "citationShare"]
CARD_BRANDS_TOP_N = 20
SOURCE_TOP_N = 7
BRAND_TREND_TOP = 1
BADGE_ENGINE_PARTS = ["citation", "sov"]
WEBSITE_OVERVIEW_TREND_METRICS = (*OVERVIEW_TREND_METRICS, "citation_accuracy")
# dashboard/_data/model.ts KPI_DEFINITIONS: (key, category, unit, betterIs)
KPI_DEFINITIONS = (
    ("visibility", "content", "percent", "higher"),
    ("shareOfVoice", "content", "percent", "higher"),
    ("sentiment", "content", "percent", "higher"),
    ("position", "content", "rank", "lower"),
    ("ownedUrlRate", "source", "percent", "higher"),
    ("targetUrlRate", "source", "percent", "higher"),
    ("citationShare", "source", "percent", "higher"),
    ("citationAccuracy", "source", "percent", "higher"),
    ("trafficConversion", "conversion", "percent", "higher"),
)
TILE_CATEGORIES = ("content", "source", "conversion")
# live-trend-chart.tsx TREND_SERIES order
TREND_SERIES_KEYS = ("visibility", "shareOfVoice", "sentiment", "citationShare", "citationAccuracy", "position")
# overview-filters.tsx OVERVIEW_DIMENSION_GROUPS
OVERVIEW_DIMENSION_GROUPS = ("geography", "language", "engine", "time", "promptContext", "brandPresence", "listType",
                             "depth1", "depth2", "depth3", "depth4")
WEBSITE_GROUPS = ("geography", "language", "engine", "time")
COMPETITOR_LABELS = ("standardMentions", "brandTrend", "firstPosition", "standardCitationDomains")
OWN_LABEL = "HMG"  # the reader session (scope all): lib ourLabelOf(null)

# lib/rhq/_data/rhq-map.json: brand -> its region ids (definition order)
_RHQ_BRAND_PREFIX = {"Hyundai": "hyundai-", "Kia": "kia-", "Genesis": "genesis-"}


def rhq_region_ids_for_brand(brand: str) -> list[str]:
    prefix = _RHQ_BRAND_PREFIX.get(brand)
    return [rid for rid in RHQ_REGION_COUNTRIES if rid.startswith(prefix)] if prefix else []


def countries_for_rhq(region_id: str) -> list[str]:
    return list(RHQ_REGION_COUNTRIES.get(region_id, ()))


# lib/geo-catalog/country-numeric.ts GEO_COUNTRY_NUMERIC (ISO alpha-2 -> world-atlas numeric id)
GEO_COUNTRY_NUMERIC = dict(pair.split(":") for pair in (
    "AD:020 AE:784 AF:004 AG:028 AI:660 AL:008 AM:051 AO:024 AQ:010 AR:032 AS:016 AT:040 AU:036 AW:533 AX:248 "
    "AZ:031 BA:070 BB:052 BD:050 BE:056 BF:854 BG:100 BH:048 BI:108 BJ:204 BL:652 BM:060 BN:096 BO:068 BQ:535 "
    "BR:076 BS:044 BT:064 BV:074 BW:072 BY:112 BZ:084 CA:124 CC:166 CD:180 CF:140 CG:178 CH:756 CI:384 CK:184 "
    "CL:152 CM:120 CN:156 CO:170 CR:188 CU:192 CV:132 CW:531 CX:162 CY:196 CZ:203 DE:276 DJ:262 DK:208 DM:212 "
    "DO:214 DZ:012 EC:218 EE:233 EG:818 EH:732 ER:232 ES:724 ET:231 FI:246 FJ:242 FK:238 FM:583 FO:234 FR:250 "
    "GA:266 GB:826 GD:308 GE:268 GF:254 GG:831 GH:288 GI:292 GL:304 GM:270 GN:324 GP:312 GQ:226 GR:300 GS:239 "
    "GT:320 GU:316 GW:624 GY:328 HK:344 HM:334 HN:340 HR:191 HT:332 HU:348 ID:360 IE:372 IL:376 IM:833 IN:356 "
    "IO:086 IQ:368 IR:364 IS:352 IT:380 JE:832 JM:388 JO:400 JP:392 KE:404 KG:417 KH:116 KI:296 KM:174 KN:659 "
    "KP:408 KR:410 KW:414 KY:136 KZ:398 LA:418 LB:422 LC:662 LI:438 LK:144 LR:430 LS:426 LT:440 LU:442 LV:428 "
    "LY:434 MA:504 MC:492 MD:498 ME:499 MF:663 MG:450 MH:584 MK:807 ML:466 MM:104 MN:496 MO:446 MP:580 MQ:474 "
    "MR:478 MS:500 MT:470 MU:480 MV:462 MW:454 MX:484 MY:458 MZ:508 NA:516 NC:540 NE:562 NF:574 NG:566 NI:558 "
    "NL:528 NO:578 NP:524 NR:520 NU:570 NZ:554 OM:512 PA:591 PE:604 PF:258 PG:598 PH:608 PK:586 PL:616 PM:666 "
    "PN:612 PR:630 PS:275 PT:620 PW:585 PY:600 QA:634 RE:638 RO:642 RS:688 RU:643 RW:646 SA:682 SB:090 SC:690 "
    "SD:729 SE:752 SG:702 SH:654 SI:705 SJ:744 SK:703 SL:694 SM:674 SN:686 SO:706 SR:740 SS:728 ST:678 SV:222 "
    "SX:534 SY:760 SZ:748 TC:796 TD:148 TF:260 TG:768 TH:764 TJ:762 TK:772 TL:626 TM:795 TN:788 TO:776 TR:792 "
    "TT:780 TV:798 TW:158 TZ:834 UA:804 UG:800 UM:581 US:840 UY:858 UZ:860 VA:336 VC:670 VE:862 VG:092 VI:850 "
    "VN:704 VU:548 WF:876 WS:882 YE:887 YT:175 ZA:710 ZM:894 ZW:716 "
).split())

# lib/geo-catalog/pseudo-country.ts PSEUDO_COUNTRIES labels
PSEUDO_COUNTRY_LABELS = {
    "SA-Dammam": ("사우디 아라비아 - 담맘", "Saudi Arabia - Dammam"),
    "SA-Jeddah": ("사우디 아라비아 - 제다", "Saudi Arabia - Jeddah"),
    "SA-Riyadh": ("사우디 아라비아 - 리야드", "Saudi Arabia - Riyadh"),
    "CN-BJ": ("중국-베이징", "China-Beijing"),
}

# ── failures ────────────────────────────────────────────────────────────────


def is_transient(exc: BaseException) -> bool:
    """A transient read failure (the front's isTransientApiFailure in process): 5xx, timeout, database or
    connection error. A 4xx (filters, access) is not."""
    if isinstance(exc, HTTPException):
        return exc.status_code >= 500
    return isinstance(exc, (asyncpg.PostgresError, asyncpg.InterfaceError, TimeoutError, OSError))


async def or_none_on_transient(aw):
    try:
        return await aw
    except Exception as exc:  # noqa: BLE001 - 4xx and programming errors are raised again
        if is_transient(exc):
            return None
        raise


# ── request context ─────────────────────────────────────────────────────────


def today_of(ctx: dict) -> str:
    return ctx.get("today") or kst_today()


def global_filters(sp: dict) -> dict:
    """readStandardFilters(sp, session scope): the reader session sees every scope."""
    return read_standard_filters(sp, reader_scope())


def website_filters(sp: dict, admin: bool) -> dict:
    """website/page.tsx: the visible axes only (brand for admins), ?geography= as websiteCountry."""
    groups = [*WEBSITE_GROUPS, *(["brand"] if admin else [])]
    raw = read_standard_filters(sp, reader_scope(), groups, "website")
    out = {k: v for k, v in raw.items() if k != "region"}
    if raw.get("region") is not None:
        out["websiteCountry"] = raw["region"]
    return out


def surface_of(ctx: dict) -> str:
    surface = ctx.get("surface", "global")
    if surface not in ("global", "website"):
        raise HTTPException(422, "Unknown surface")
    return surface


def filters_for(surface: str, sp: dict, ctx: dict) -> dict:
    return website_filters(sp, ctx.get("admin") == "true") if surface == "website" else global_filters(sp)


def common_params(filters: dict, surface: str) -> dict:
    return to_api_params(analysis_query(filters, {"surface": surface, "scope": reader_scope()}))


def period_context(filters: dict, today: str) -> tuple[dict, int | None, dict]:
    """The compare shape (anchor axis), its days and the label context of the cards (page.tsx)."""
    shape = resolve_request_compare_period_shape(filters.get("dateFrom"), filters.get("dateTo"))
    cur_lo = None
    if shape.get("weeks"):
        cur_lo = shape["weeks"]["cur"]["lo"]
    elif shape.get("months"):
        cur_lo = shape["months"]["cur"]["lo"]
    else:
        cur_lo = filters.get("dateFrom")
    label_ctx = {"kind": shape["kind"], "curLo": cur_lo, "todayKst": today}
    return shape, shape.get("days"), label_ctx


# ── reads (lib/hgh/adapters/dashboard.ts) ───────────────────────────────────


async def fetch_dashboard_summary(common: dict, surface: str) -> dict:
    return await fetch_kpi_summary(common, {"surface": surface, "card": True, "parts": DASHBOARD_SUMMARY_PARTS})


async def fetch_card_brands(common: dict, surface: str) -> dict:
    extra: dict = {"top_n": CARD_BRANDS_TOP_N, "sort": "mentions", "include": ["hmg"], "card": True}
    if surface != "global":
        extra["include_sentiment"] = False
    return await api.get("mentions/brands", {**common, **extra})


async def fetch_dashboard_domains(common: dict, surface: str, limit: int, competitor_sources: bool = False) -> dict:
    extra: dict = {"limit": limit}
    if "from" not in common and "to" not in common:
        extra["card"] = True
    extra["host_fold"] = True
    extra["include_den"] = False
    extra["include_competitor_totals"] = False
    if competitor_sources:
        extra["competitor_sources"] = True
    return await api.get("citations/domains", {**common, **extra})


async def fetch_engine_rows(common: dict, surface: str) -> dict:
    extra: dict = {"parts": list(BADGE_ENGINE_PARTS)}
    if surface == "website":
        extra["card"] = True
    return await api.get("kpi/engines", {**common, **extra})


async def fetch_geo(common: dict) -> dict:
    return await api.get("geo", {**common, "card": True})


async def load_live_trend(common: dict, surface: str, metrics, unit: str) -> dict | None:
    res = await fetch_trend(common, {"surface": surface, "bucket": "cycle", "metrics": list(metrics),
                                     "measuredDays": False, "card": True})
    if not res["data"]["buckets"]:
        return None
    return to_live_trend(res["data"], {"unit": unit})


def to_dashboard_kpis(summary: dict, brands: dict | None, url_rates: bool = False) -> list[dict] | None:
    """toDashboardKpis / loadLiveDashboard: ①~⑤ (+ the website URL-rate cards) with KPI #16."""
    data, meta = summary["data"], summary["meta"]
    if summary_is_empty(data, meta):
        return None
    cards = to_mirror_kpis(data, meta)
    if url_rates:
        u = to_url_rate_kpis(data, meta)
        if u:
            copy = {"copyVariant": "api"} if u["unit"] == "measurement" else {}
            cards.extend([{**u["ownedUrlRate"], **copy}, {**u["targetUrlRate"], **copy}, u["citationAccuracy"]])
    if brands is None:
        return cards
    sov = data.get("share_of_voice")
    own = sov.get("num") if isinstance(sov, dict) else None
    return apply_competitor_sov_from_brands(cards, own if own is not None else 0, brands["brands"])


async def load_live_kpis(common: dict, surface: str) -> tuple[str, list[dict] | None]:
    """getLiveDashboard / getLiveWebsiteDashboard: ("ok", kpis), ("empty", None), or ("degraded", None)
    when the summary failed transiently (the old degrade label standardAggregates / websiteAggregates)."""
    try:
        summary, brands = await asyncio.gather(fetch_dashboard_summary(common, surface),
                                               or_none_on_transient(fetch_card_brands(common, surface)))
    except Exception as exc:  # noqa: BLE001
        if is_transient(exc):
            return "degraded", None
        raise
    kpis = to_dashboard_kpis(summary, brands["data"] if brands else None, surface == "website")
    return ("ok", kpis) if kpis is not None else ("empty", None)


async def load_competitor_sources(common: dict, surface: str) -> tuple[dict, list[str]]:
    """loadCompetitorSources: brand rows, the candidates' brand trend and the official competitor domains.
    A transient failure empties that part and names its old degrade label."""
    degraded: list[str] = []

    async def guard(labels: list[str], aw):
        try:
            return await aw
        except Exception as exc:  # noqa: BLE001
            if not is_transient(exc):
                raise
            degraded.extend(labels)
            return None

    brands_res = await guard(["standardMentions"], fetch_card_brands(common, surface))
    brands = to_competitor_brand_values(brands_res["data"]["brands"]) if brands_res else []
    keys = candidate_brand_keys(brands)
    trend, domains = await asyncio.gather(
        guard(["brandTrend", "firstPosition"], fetch_trend(common, {
            "surface": surface, "bucket": "cycle", "dimension": "brand",
            "metrics": ["visibility", "share_of_voice", "position"], "top": BRAND_TREND_TOP, "brandKeys": keys,
            "measuredDays": False, "card": True})),
        guard(["standardCitationDomains"], fetch_dashboard_domains(common, surface, 0, competitor_sources=True)),
    )
    src = {
        "brands": brands,
        "brandTrend": to_brand_trend_result(trend["data"]) if trend else None,
        "firstPosition": to_first_position_result(trend["data"]) if trend else None,
        "citationDomains": to_competitor_citation_domains(domains["data"]) if domains else None,
        "citationTotal": (domains["data"]["summary"]["own_share"]["den"]
                          if domains and domains["data"].get("competitor_sources") is not None else None),
    }
    # the old labels in COMPETITOR_LABELS order, once each
    return src, [label for label in COMPETITOR_LABELS if label in degraded]


# ── period compare view (PeriodDeltaSlot + PeriodDeltaBlock) ────────────────


def select_period_result(compare: list[dict] | None, metric: str | None) -> dict | None:
    if not compare or not metric:
        return None
    return next((r for r in compare if r.get("metric") == metric), None)


def caption_ctx(days: int | None, label_ctx: dict) -> dict:
    """`{ days: days ?? 0, ...labelCtx }`."""
    return {"days": days if days is not None else 0, **label_ctx}


def window_label(r: dict) -> dict:
    params = {}
    if "cyclesCur" in r:
        params["curCycles"] = r["cyclesCur"]
    if "cyclesPrev" in r:
        params["prevCycles"] = r["cyclesPrev"]
    return {"key": "window", "params": params}


def compare_label(r: dict, days: int | None, label_ctx: dict) -> dict:
    """What the Δ compares against: the preset label, else the round-count wording."""
    preset = label_key_of(caption_ctx(days, label_ctx))
    return {"key": f"label.{preset}", "params": {}} if preset else window_label(r)


def period_block(r: dict, days: int | None, label_ctx: dict) -> dict:
    return {"chip": period_chip({"metric": r["metric"], "delta": r.get("delta")}),
            "label": compare_label(r, days, label_ctx),
            "caption": period_caption(r, caption_ctx(days, label_ctx))}


# ── overview cards ──────────────────────────────────────────────────────────


def overview_cards(kpis: list[dict], compare: list[dict] | None, days: int | None, label_ctx: dict) -> list[dict]:
    """The five cards in OVERVIEW_KPI_KEYS order: value / pending (overviewCardState) and the period block
    when the compare answered for the card's metric (never on a pending card)."""
    by_key = {k["key"]: k for k in kpis}
    out = []
    for key in OVERVIEW_KPI_KEYS:
        state = overview_card_state(by_key.get(key))
        r = select_period_result(compare, None if state["pending"] else KPI_KEY_TO_COMPARE_METRIC.get(key))
        out.append({"key": key, "value": state["value"], "pending": state["pending"],
                    "period": period_block(r, days, label_ctx) if r else None})
    return out


def compare_title(compare: list[dict] | None, days: int | None, label_ctx: dict) -> dict | None:
    """Renewal KPI header: what Δ compares against (None = the trend wording "직전 회차 대비")."""
    sample = compare[0] if compare else None
    return compare_label(sample, days, label_ctx) if sample else None


# ── trend: card Δ and sparklines ────────────────────────────────────────────


def format_as_of_date(value: str) -> str:
    """lib/as-of-date formatAsOfDate: a YYYY-MM-DD stays, an instant becomes its KST day."""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value, re.ASCII):
        return value
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value[:10]
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (t.astimezone(timezone.utc) + timedelta(hours=9)).strftime("%Y-%m-%d")


def trend_bucket_displays(points: list[dict]) -> dict[str, dict]:
    """trendBucketDisplays: key -> {day, time}; a KST day shared by two keys shows the anchor's KST time."""
    out: dict[str, dict] = {}
    keys_by_day: dict[str, dict] = {}
    for p in points:
        key = p["bucketStart"]
        if key in out:
            continue
        day = format_as_of_date(p["cycleAnchorAt"]) if p.get("cycleAnchorAt") else key
        out[key] = {"day": day, "time": None}
        keys_by_day.setdefault(day, {})[key] = None
    for p in points:
        d = out.get(p["bucketStart"])
        if not d or d["time"] is not None or not p.get("cycleAnchorAt"):
            continue
        if len(keys_by_day.get(d["day"], {})) < 2:
            continue
        try:
            t = datetime.fromisoformat(p["cycleAnchorAt"].replace("Z", "+00:00"))
        except ValueError:
            continue
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        d["time"] = (t.astimezone(timezone.utc) + timedelta(hours=9)).strftime("%H:%M")
    return out


def spark_view(trend: dict | None, key: str) -> dict:
    """One card's sparkline: the last points (value, WoW, gap of this card's family), each with its axis
    display, the y domain and whether any value is drawn (else the empty box)."""
    points = spark_points(trend, key)
    displays = trend_bucket_displays(points)
    return {"points": [{**p, "display": displays[p["bucketStart"]]} for p in points],
            "domain": spark_y_domain(points, key == "position"),
            "hasValue": any(p.get("value") is not None for p in points)}


def card_trend_view(trend: dict | None, degraded: bool) -> dict:
    """overview/card-trend: per card the Δ of the last two valued rounds (applyTrendDeltas; shown on a
    card that is not pending) and the sparkline (sparklineTrend: the last 5 points)."""
    applied = apply_trend_deltas([{"key": k, "delta": None, "direction": "flat"} for k in OVERVIEW_KPI_KEYS], trend)
    spark = sparkline_trend(trend)
    cards = {k["key"]: {"delta": k["delta"], "spark": spark_view(spark, k["key"])} for k in applied}
    return {"degraded": degraded, "cards": cards, "count": len(spark_points(spark, "visibility"))}


# ── GEO (toLiveGeo + the map / table derivations) ──────────────────────────


def _mirror_pct(r: Any) -> float | None:
    return pct1_or_zero(r) if isinstance(r, dict) and is_num(r.get("den")) and r["den"] > 0 else None


def geo_metrics(own: dict, rival: dict | None) -> dict:
    def r(pick):
        return {"name": rival["brand"], "value": pick(rival["metrics"])} if rival else None
    return {
        "visibility": {"ours": _mirror_pct(own.get("visibility")), "rival": r(lambda m: _mirror_pct(m.get("visibility")))},
        "shareOfVoice": {"ours": _mirror_pct(own.get("share_of_voice")),
                         "rival": r(lambda m: _mirror_pct(m.get("share_of_voice")))},
        "sentiment": {"ours": _mirror_pct(own.get("sentiment")), "rival": r(lambda m: _mirror_pct(m.get("sentiment")))},
        "position": {"ours": rank_avg(own.get("position")), "rival": r(lambda m: rank_avg(m.get("position")))},
        "citationShare": {"ours": _mirror_pct(own.get("citation_share")), "rival": None},
    }


def market_of(row: dict) -> dict:
    """marketOf: one /v1/geo row -> MarketCompetition (with metrics, answers, noMentions)."""
    top_own, top_rival = row.get("top_own_brand"), row.get("top_rival")
    sov = row["own"].get("share_of_voice")
    out = {
        "hmgSov": pct1_or_zero(sov),
        "hmgRank": row["rank"]["our"],
        "fieldSize": row["rank"]["field_size"],
        "topBrand": {"name": top_own["brand"], "sov": pct1_or_zero(top_own["share_of_voice"])} if top_own else None,
        "topRival": ({"name": top_rival["brand"], "sov": pct1_or_zero(top_rival["metrics"]["share_of_voice"])}
                     if top_rival else None),
        "metrics": geo_metrics(row["own"], top_rival),
        "answers": row["answers"],
    }
    if not (isinstance(sov, dict) and is_num(sov.get("den")) and sov["den"] > 0):
        out["noMentions"] = True
    return out


def metric_value(m: dict, key: str) -> float | None:
    """overview-metrics.ts metricValue."""
    metrics = m.get("metrics")
    if key == "shareOfVoice" and not metrics:
        return m["hmgSov"]
    return ((metrics or {}).get(key) or {}).get("ours")


def rival_of(m: dict, key: str) -> dict | None:
    """geo-overview.tsx RivalCell / geo-map.tsx tooltip: the KPI's rival, else the SoV top rival."""
    rival = ((m.get("metrics") or {}).get(key) or {}).get("rival")
    if rival is not None:
        return rival
    if key == "shareOfVoice" and m.get("topRival"):
        return {"name": m["topRival"]["name"], "value": m["topRival"]["sov"]}
    return None


def with_row_view(m: dict, own_label: str) -> dict:
    """Per row: each KPI's value and rival (table, map colour, tooltip) and whether the tooltip shows the
    lead brand (it differs from the own label)."""
    m["values"] = {k: metric_value(m, k) for k in OVERVIEW_KPI_KEYS}
    m["rivals"] = {k: rival_of(m, k) for k in OVERVIEW_KPI_KEYS}
    m["showLead"] = bool(m.get("topBrand")) and m["topBrand"]["name"] != own_label
    return m


@lru_cache(maxsize=8)
def collator(locale: str):
    """ICU collation of the page locale (String#localeCompare in that locale)."""
    return icu.Collator.createInstance(icu.Locale(locale or "ko"))


def country_name(code: str | None, locale: str) -> str:
    """lib/geo-catalog countryName: pseudo codes first, then the CLDR region name (Intl.DisplayNames);
    a code Intl rejects comes back as given."""
    if not code:
        return ""
    pseudo = PSEUDO_COUNTRY_LABELS.get(code.strip(_JS_WS))
    if pseudo:
        return pseudo[0] if locale.lower().startswith("ko") else pseudo[1]
    normalized = code.strip(_JS_WS).upper()
    if not re.fullmatch(r"[A-Z]{2}|[0-9]{3}", normalized, re.ASCII):
        return code
    return icu.Locale("", normalized).getDisplayCountry(icu.Locale(locale or "ko"))


_JS_WS = "\t\n\u000b\u000c\r              " \
         "    　﻿"


def geo_view(live: dict, locale: str) -> dict:
    """LiveGeo + what the GEO components derived from it: row values / rivals / lead flag, the map
    bindings (country numeric id; region rows = their RHQ countries, else their own countries), the
    country menu (sorted by the localized name, grouped by region in market order) and the country-level
    colour domain per KPI (the map without a country pick)."""
    own_label = live["ourLabel"]
    for m in live["markets"]:
        with_row_view(m, own_label)
        rhq = countries_for_rhq(m["region"])
        m["numerics"] = [GEO_COUNTRY_NUMERIC[c] for c in (rhq or [c["code"] for c in m["countries"]])
                         if c in GEO_COUNTRY_NUMERIC]
        for c in m["countries"]:
            with_row_view(c, own_label)
            c["numeric"] = GEO_COUNTRY_NUMERIC.get(c["code"])
    coll = collator(locale)
    names = {c["code"]: country_name(c["code"], locale) for m in live["markets"] for c in m["countries"]}
    countries = [{"code": c["code"]} for m in live["markets"] for c in m["countries"]]
    countries = sorted(countries, key=lambda c: coll.getSortKey(names[c["code"]]))
    region_of: dict[str, str] = {}
    for m in live["markets"]:
        for c in m["countries"]:
            region_of[c["code"]] = m["region"]
    groups = [{"region": m["region"], "codes": [c["code"] for c in countries if region_of.get(c["code"]) == m["region"]]}
              for m in live["markets"]]
    live["countryOrder"] = [c["code"] for c in countries]
    live["countryGroups"] = [g for g in groups if g["codes"]]
    by_numeric: dict[str, dict] = {}
    for m in live["markets"]:
        for c in m["countries"]:
            if c["numeric"]:
                by_numeric[c["numeric"]] = c
    domains = {}
    for k in OVERVIEW_KPI_KEYS:
        vals = [c["values"][k] for c in by_numeric.values() if c["values"][k] is not None]
        domains[k] = [min(vals), max(vals)] if vals else None
    live["domains"] = domains
    return live


def to_live_geo(data: dict) -> dict:
    """toLiveGeo: the backend already rolled up and sorted (region ids and country order as sent)."""
    markets = []
    for m in data["markets"]:
        markets.append({"region": m["region_id"], **market_of(m),
                        "countries": [{"code": c["code"], **market_of(c)} for c in m["countries"]]})
    return {"markets": markets, "pending": list(data["pending"]), "ourLabel": data["own_label"]}


def empty_geo(active_brand: str | None) -> dict:
    """buildGeo with no rows: no markets; with an active brand its RHQ regions are all "측정 예정"."""
    return {"markets": [], "pending": rhq_region_ids_for_brand(active_brand) if active_brand else [],
            "ourLabel": OWN_LABEL}


def active_brand_of(filters: dict) -> str | None:
    """activeBrandFor(reader scope, filters): one URL brand, else none."""
    brand = filters.get("brand")
    return brand[0] if brand and len(brand) == 1 else None


# ── tiles (website SummaryTiles) ───────────────────────────────────────────


def goodness(direction: str, better_is: str) -> str:
    if direction == "flat":
        return "flat"
    if better_is == "higher":
        return "good" if direction == "up" else "bad"
    return "good" if direction == "down" else "bad"


_TILE_FIELDS = ("coverage", "sparkline", "ratio", "competitorSov", "provenance", "copyVariant")


def tile_view(key: str, unit: str, better_is: str, s: dict, compare: list[dict] | None) -> dict:
    if unit == "count":
        value = s.get("value")
        state = {"value": value, "pending": value is None, "delta": None if value is None else s.get("delta")}
    else:
        state = overview_card_state(s)
    r = select_period_result(compare, None if state["pending"] else KPI_KEY_TO_COMPARE_METRIC.get(key))
    out = {"key": key, "unit": unit, "value": state["value"], "pending": state["pending"], "delta": state["delta"],
           "direction": s.get("direction"), "tone": goodness(s.get("direction"), better_is),
           "period": period_chip({"metric": r["metric"], "delta": r.get("delta")}) if r else None}
    if not state["pending"] and s.get("engineConsistency") is not None:
        out["engineConsistency"] = s["engineConsistency"]
    for f in _TILE_FIELDS:
        if s.get(f) is not None:
            out[f] = s[f]
    return out


def tiles_view(items: list[dict], compare: list[dict] | None, days: int | None, label_ctx: dict) -> dict:
    """SummaryTiles: categories with their tiles (KPI_DEFINITIONS order, absent KPIs skipped), and the
    suppression caption of the first suppressed compare result."""
    item_map = {i["key"]: i for i in items}
    groups = []
    for cat in TILE_CATEGORIES:
        tiles = [tile_view(key, unit, better, item_map[key], compare)
                 for key, c, unit, better in KPI_DEFINITIONS if c == cat and key in item_map]
        if tiles:
            groups.append({"category": cat, "tiles": tiles})
    first = next((r for r in compare or [] if r.get("suppressed") and r.get("reason")), None)
    return {"groups": groups,
            "suppressionCaption": period_caption(first, caption_ctx(days, label_ctx)) if first else None}


# ── trend chart (LiveTrendChart) ───────────────────────────────────────────


def trend_chart_view(trend: dict) -> dict:
    """Chart rows (x label day = round date on the anchor axis, values, the gap marker as each gap family
    reads it) and the series that have a value somewhere."""
    rows = []
    for p in trend["points"]:
        gap = p.get("gap")
        rows.append({"key": p["bucketStart"],
                     "day": p["roundDate"] if p.get("roundDate") is not None else p["bucketStart"],
                     "values": p["values"], "measuredDays": p["measuredDays"], "answers": p["answers"],
                     "gap": {"mention": gap if trend_gap_applies(gap, "mention") else None,
                             "citation": gap if trend_gap_applies(gap, "citation") else None}})
    available = [k for k in TREND_SERIES_KEYS if any(is_num(p["values"].get(k)) for p in trend["points"])]
    return {"rows": rows, "availableSeries": available}


# ── composition ─────────────────────────────────────────────────────────────


def to_source_slices(data: dict, top_n: int = SOURCE_TOP_N) -> list[dict]:
    total = data["summary"]["own_share"]["den"]
    head = [{"domain": d["domain"], "citations": d["citations"], "share": pct1_or_zero(d.get("share")),
             "isOurs": d["is_own"]} for d in data["items"][:top_n]]
    used = 0
    for d in head:
        used = used + d["citations"]
    rest = total - used
    if rest > 0:
        head.append({"domain": "", "citations": rest, "share": pct1_or_zero({"num": rest, "den": total}),
                     "isOurs": False})
    return head


# ── renewal: standing and brand matrix (overview-model.ts) ─────────────────


def _better_first(key: str, a: float, b: float) -> float:
    return a - b if key == "position" else b - a


def standing(key: str, own: float | None, rivals: list[dict]) -> dict | None:
    if own is None:
        return None
    vals = [r["value"] for r in rivals if r.get("value") is not None]
    if not vals:
        return None
    return {"rank": 1 + sum(1 for v in vals if _better_first(key, v, own) < 0), "count": len(vals) + 1}


def bar_width(key: str, v: float | None, mx: float | None) -> float:
    if v is None or mx is None or mx <= 0:
        return 0
    if key == "position":
        return max(6, (1 - (v - 1) / mx) * 100)
    return max(2, (v / mx) * 100)


def delta_mark(key: str, d: float | None) -> dict | None:
    """The table Δ: rounded to one decimal, 0 = flat, else good / bad by the KPI's direction."""
    if d is None:
        return None
    r = js_round(d * 10) / 10
    if r == 0:
        return {"r": 0, "tone": "flat"}
    good = r < 0 if key == "position" else r > 0
    return {"r": r, "tone": "good" if good else "bad"}


def brand_matrix(own: dict, rivals: dict) -> dict:
    """brandMatrix: 당사 then every KPI's compared competitors (first appearance, brandKey match); per
    column the best value, the bar scale (max) and 당사's standing; per cell the bar width, best flag and Δ."""
    order: list[str] = []
    names: dict[str, str] = {}
    for k in OVERVIEW_KPI_KEYS:
        for m in rivals[k]:
            bk = brand_key(m["brand"])
            if bk in names:
                continue
            names[bk] = m["brand"]
            order.append(bk)
    rows = [{"name": own["label"], "own": True,
             "cells": {k: {"value": own["values"][k], "delta": own["deltas"][k]} for k in OVERVIEW_KPI_KEYS}}]
    for bk in order:
        cells = {}
        for k in OVERVIEW_KPI_KEYS:
            m = next((x for x in rivals[k] if brand_key(x["brand"]) == bk), None)
            cells[k] = {"value": m["value"], "delta": m.get("delta")} if m else None
        rows.append({"name": names.get(bk, bk), "own": False, "cells": cells})
    cols = []
    for k in OVERVIEW_KPI_KEYS:
        vals = [r["cells"][k]["value"] for r in rows if r["cells"][k] is not None and r["cells"][k]["value"] is not None]
        best = (min(vals) if k == "position" else max(vals)) if vals else None
        mx = max(vals) if vals else None
        cols.append({"key": k, "best": best, "max": mx, "standing": standing(k, own["values"][k], rivals[k])})
    for r in rows:
        for c in cols:
            cell = r["cells"][c["key"]]
            if cell is None:
                continue
            v = cell["value"]
            cell["bar"] = bar_width(c["key"], v, c["max"])
            cell["best"] = v is not None and v == c["best"]
            cell["deltaMark"] = delta_mark(c["key"], cell["delta"])
    return {"rows": rows, "cols": cols}


def own_label_of(filters: dict) -> str:
    """Renewal own row label: the URL brands without the HMG umbrella, else HMG."""
    own = [b for b in (filters.get("brand") or []) if b != UMBRELLA_BRAND]
    return ", ".join(own) if own else UMBRELLA_BRAND


# ═══ screens ════════════════════════════════════════════════════════════════


@screen("overview/as-of")
async def as_of(q) -> dict:
    """The header pill (global, renewal) and the website as-of chip: meta.as_of of the card summary;
    a transient failure shows no date."""
    ctx, sp = split_context(q)
    surface = surface_of(ctx)
    common = common_params(filters_for(surface, sp, ctx), surface)
    res = await or_none_on_transient(fetch_dashboard_summary(common, surface))
    return {"asOf": as_of_date(res["meta"]) if res else None}


@screen("overview/filters")
async def filter_bar(q) -> dict:
    """The filter bar props: panel options (period window, applied brands) and the calendar (a transient
    dates failure leaves the calendar free, as before). Global also gets the panel's axes (no measured
    language -> no language axis)."""
    ctx, sp = split_context(q)
    surface = surface_of(ctx)
    filters = filters_for(surface, sp, ctx)
    options, dates = await asyncio.gather(
        load_panel_options({"surface": surface, "projectId": None, "dateFrom": filters.get("dateFrom"),
                            "dateTo": filters.get("dateTo"), "geoOnly": False, "scope": reader_scope(),
                            "filters": filters}),
        or_none_on_transient(fetch_filter_dates(surface, None, "all")),
    )
    view = filter_dates_view(dates) if dates else None
    out: dict = {}
    if "catalogRows" in options:
        out["catalogRows"] = options["catalogRows"]
    out["geographyOptions"] = options["geographyOptions"]
    out["languageOptions"] = options["languageOptions"]
    out["optionMatrix"] = options["optionMatrix"]
    out["collectionStartDay"] = view["collectionStartDay"] if view else None
    out["latestAnchorDay"] = view["latestAnchorDay"] if view else None
    if view and view["selectableDates"] is not None:
        out["selectableDates"] = view["selectableDates"]
    if surface == "global":
        langs = options["languageOptions"]
        out["onlyGroups"] = [g for g in OVERVIEW_DIMENSION_GROUPS if langs or g != "language"]
    return out


@screen("overview/cards")
async def cards(q) -> dict:
    """The five KPI cards (global dashboard, renewal KPI row). state: ok | empty (no answers) | degraded
    (the summary failed transiently). The period compare (closed ?time= only) gives each card its chip,
    label and caption; a transient compare failure keeps the trend Δ."""
    ctx, sp = split_context(q)
    filters = global_filters(sp)
    common = common_params(filters, "global")
    shape, days, label_ctx = period_context(filters, today_of(ctx))
    (state, kpis), compare = await asyncio.gather(
        load_live_kpis(common, "global"),
        or_none_on_transient(fetch_period_compare_api(filters, common, {
            "surface": "global", "kind": shape["kind"], "metrics": OVERVIEW_COMPARE_METRICS})),
    )
    if kpis is None:
        return {"state": state}
    return {"state": "ok", "cards": overview_cards(kpis, compare, days, label_ctx),
            "compareTitle": compare_title(compare, days, label_ctx)}


@screen("overview/card-trend")
async def card_trend(q) -> dict:
    """The deferred card Δ and sparklines from the round trend (bucket=cycle, one call for both). A
    transient failure: no Δ, empty sparklines and the trend notice (old label standardTrend:day)."""
    _ctx, sp = split_context(q)
    common = common_params(global_filters(sp), "global")
    try:
        trend = await load_live_trend(common, "global", OVERVIEW_TREND_METRICS, "day")
    except Exception as exc:  # noqa: BLE001
        if not is_transient(exc):
            raise
        return card_trend_view(None, True)
    return card_trend_view(trend, False)


async def own_card_values(common: dict, surface: str) -> dict | None:
    summary = await or_none_on_transient(fetch_dashboard_summary(common, surface))
    if not summary or summary_is_empty(summary["data"], summary["meta"]):
        return None
    by_key = {k["key"]: k for k in to_mirror_kpis(summary["data"], summary["meta"])}
    return {k: overview_card_state(by_key.get(k))["value"] for k in OVERVIEW_KPI_KEYS}


@screen("overview/card-competitors")
async def card_competitors(q) -> dict:
    """The deferred competitor row of every card (value-ordered minis with their Δ; citation share =
    the domains Gold files as official competitor, folded to the brand Gold gives them). `degraded` = the old labels of the parts that failed
    transiently. ctx.view=renewal adds 당사's standing among each card's competitors."""
    ctx, sp = split_context(q)
    common = common_params(global_filters(sp), "global")
    if ctx.get("view") == "renewal":
        (src, degraded), own = await asyncio.gather(load_competitor_sources(common, "global"),
                                                    own_card_values(common, "global"))
    else:
        src, degraded = await load_competitor_sources(common, "global")
        own = None
    rows = {k: competitor_row(src, k) for k in OVERVIEW_KPI_KEYS}
    out: dict = {"degraded": degraded, "rows": rows}
    if ctx.get("view") == "renewal":
        out["standing"] = {k: standing(k, own[k] if own else None, rows[k]) for k in OVERVIEW_KPI_KEYS}
    return out


@screen("overview/geo")
async def geo(q) -> dict:
    """GEO section of the global dashboard and the renewal market card: nothing when the summary is empty
    (or failed transiently); a transient /v1/geo failure -> degraded (old label standardGeoCompetition)."""
    ctx, sp = split_context(q)
    common = common_params(global_filters(sp), "global")
    # The markets read leaves with the summary instead of after it (1.9 s later); its outcome counts only
    # when the summary has answers.
    summary, markets = await asyncio.gather(or_none_on_transient(fetch_dashboard_summary(common, "global")),
                                            fetch_geo(common), return_exceptions=True)
    if isinstance(summary, BaseException):
        raise summary
    if not summary or summary_is_empty(summary["data"], summary["meta"]):
        return {"geo": None, "degraded": False}
    if isinstance(markets, BaseException):
        if not is_transient(markets):
            raise markets
        return {"geo": None, "degraded": True}
    return {"geo": geo_view(to_live_geo(markets["data"]), ctx.get("locale", "ko")), "degraded": False}


TREND_DEGRADE_LABEL = "standardTrend:day"  # the old degrade label of the round trend (card Δ)


@screen("overview/brand-matrix")
async def brand_matrix_screen(q) -> dict | None:
    """Renewal brand x KPI table: 당사 (card values, trend Δ) and every card's compared competitors.
    None when the summary is empty (the card shows the empty state); a failed summary is raised (the page
    shows the table's failure). `degraded` = the old labels of the parts that failed transiently — the
    competitor reads (COMPETITOR_LABELS order), then the trend — present only when one did (2026-10-29 metric
    review ⚠️ Overview #32: a failed competitor read read as "no competitor value")."""
    _ctx, sp = split_context(q)
    filters = global_filters(sp)
    common = common_params(filters, "global")
    trend_failed = False

    async def trend_or_none():
        nonlocal trend_failed
        try:
            return await load_live_trend(common, "global", OVERVIEW_TREND_METRICS, "day")
        except Exception as exc:  # noqa: BLE001
            if not is_transient(exc):
                raise
            trend_failed = True
            return None

    summary, trend, (src, degraded) = await asyncio.gather(
        fetch_dashboard_summary(common, "global"), trend_or_none(), load_competitor_sources(common, "global"))
    if summary_is_empty(summary["data"], summary["meta"]):
        return None
    kpis = to_mirror_kpis(summary["data"], summary["meta"])
    by_key = {k["key"]: k for k in kpis}
    applied = {k["key"]: k for k in apply_trend_deltas(kpis, trend)}
    own = {"label": own_label_of(filters),
           "values": {k: overview_card_state(by_key.get(k))["value"] for k in OVERVIEW_KPI_KEYS},
           "deltas": {k: overview_card_state(applied.get(k))["delta"] for k in OVERVIEW_KPI_KEYS}}
    out = brand_matrix(own, {k: competitor_row(src, k) for k in OVERVIEW_KPI_KEYS})
    failed = [*degraded, *([TREND_DEGRADE_LABEL] if trend_failed else [])]
    if failed:
        out["degraded"] = failed
    return out


# ── website ─────────────────────────────────────────────────────────────────


async def website_tiles(ctx: dict, sp: dict, deferred: bool) -> dict:
    filters = website_filters(sp, ctx.get("admin") == "true")
    common = common_params(filters, "website")
    state, kpis = await load_live_kpis(common, "website")
    if kpis is None:
        return {"state": state}
    if deferred:
        kpis = await deferred_kpis(kpis, common)
    shape, days, label_ctx = period_context(filters, today_of(ctx))
    compare = await or_none_on_transient(fetch_period_compare_api(filters, common, {
        "surface": "website", "kind": shape["kind"], "metrics": OVERVIEW_COMPARE_METRICS}))
    return {"state": "ok", "tiles": tiles_view(kpis, compare, days, label_ctx)}


async def deferred_kpis(items: list[dict], common: dict) -> list[dict]:
    """website/page.tsx: the engine badge (a transient engines failure = no badge, a 4xx is raised)
    and the trend Δ (any trend failure = no Δ), merged onto the cards."""
    async def engines():
        res = await or_none_on_transient(fetch_engine_rows(common, "website"))
        return [engine_row(r) for r in res["data"]["rows"]] if res else []

    async def trend():
        try:
            return await load_live_trend(common, "website", WEBSITE_OVERVIEW_TREND_METRICS, "week")
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, HTTPException) or is_transient(exc):
                return None
            raise

    rows, tr = await asyncio.gather(engines(), trend())
    with_badge = apply_engine_consistency(items, rows)
    return apply_trend_deltas(with_badge, tr) if tr else with_badge


def engine_row(r: dict) -> dict:
    """toEngineRow: EngineItem -> SubKpiEngineRow (avgPosition = rank_sum / ranked)."""
    def n0(v):
        return v if v is not None else 0
    ranked = n0(r.get("ranked"))
    return {"engine": r.get("engine"), "answers": n0(r.get("answers")), "tracked": n0(r.get("tracked")),
            "multi": n0(r.get("multi")), "top1": n0(r.get("top1")), "top3": n0(r.get("top3")),
            "avgPosition": n0(r.get("rank_sum")) / ranked if ranked > 0 else None,
            "totalMentions": n0(r.get("total_mentions")), "trackedMentions": n0(r.get("tracked_mentions")),
            "sentMentions": n0(r.get("sent_mentions")), "positiveMentions": n0(r.get("positive_mentions")),
            "negativeMentions": n0(r.get("negative_mentions")), "citTotal": n0(r.get("cit_total")),
            "citOwned": n0(r.get("cit_owned"))}


@screen("website/summary")
async def website_summary(q) -> dict:
    """Website tiles at card speed: state ok | empty | degraded (old label websiteAggregates)."""
    ctx, sp = split_context(q)
    return await website_tiles(ctx, sp, False)


@screen("website/summary-deferred")
async def website_summary_deferred(q) -> dict:
    """The same tiles with the engine consistency badge and the trend Δ merged in."""
    ctx, sp = split_context(q)
    return await website_tiles(ctx, sp, True)


@screen("website/trend")
async def website_trend(q) -> dict:
    """KPI trend chart: None (the "accruing" box) without at least two points. Failures are raised."""
    ctx, sp = split_context(q)
    common = common_params(website_filters(sp, ctx.get("admin") == "true"), "website")
    trend = await load_live_trend(common, "website", WEBSITE_OVERVIEW_TREND_METRICS, "week")
    return {"trend": trend_chart_view(trend) if trend and len(trend["points"]) >= 2 else None}


@screen("website/composition")
async def website_composition(q) -> dict:
    """Source composition (top 7 domains + 기타; topics are not drawn on the website). A transient
    failure empties it and degrades (old label websiteSourceComposition)."""
    ctx, sp = split_context(q)
    common = common_params(website_filters(sp, ctx.get("admin") == "true"), "website")
    try:
        data = (await fetch_dashboard_domains(common, "website", SOURCE_TOP_N))["data"]
    except Exception as exc:  # noqa: BLE001
        if not is_transient(exc):
            raise
        return {"topics": [], "sources": [], "degraded": True}
    return {"topics": [], "sources": to_source_slices(data), "degraded": False}


# ── website: engines and brands side by side (renewal Website Overview, 2026-10-30) ─────────────────
# The breakdowns lay out Gold values the page already reads: the engine rows behind the 엔진 간 일관성 badge
# (kpi/engines) and the tiles read with one brand each. Best / worst follow each KPI's direction only.

ENGINE_KPI_KEYS = ("visibility", "shareOfVoice", "sentiment", "position", "citationShare")


def engine_ratios(r: dict) -> dict:
    """One kpi/engines row's KPI ratios: the pairs apply_engine_consistency takes min / max of (via engine_row)."""
    def n0(k):
        return r.get(k) if r.get(k) is not None else 0
    return {"visibility": {"num": n0("tracked"), "den": n0("answers")},
            "shareOfVoice": {"num": n0("tracked_mentions"), "den": n0("total_mentions")},
            "sentiment": {"num": n0("positive_mentions"), "den": n0("sent_mentions")},
            "position": {"sum": n0("rank_sum"), "count": n0("ranked")},
            "citationShare": {"num": n0("cit_owned"), "den": n0("cit_total")}}


def engines_view(rows: list[dict]) -> dict:
    """Per engine: answers and the five values (one decimal, rank = average); per KPI the badge's consistency,
    the best and the worst engine (exact values compared, first one kept on a tie); the widest = the KPI of
    the lowest consistency."""
    engines, exact_of = [], {}
    for r in rows:
        ratios = engine_ratios(r)
        values = {k: (rank_avg(ratios[k]) if k == "position" else pct1_or_null(ratios[k])) for k in ENGINE_KPI_KEYS}
        exact_of[r["engine"]] = {k: (ratios[k]["sum"] / ratios[k]["count"] if ratios[k]["count"] else None) if k == "position"
                                 else (ratios[k]["num"] / ratios[k]["den"] if ratios[k]["den"] else None) for k in ENGINE_KPI_KEYS}
        engines.append({"engine": r["engine"], "answers": ratios["visibility"]["den"], "values": values, "ratios": ratios})
    cons, extremes = {}, {}
    for k in ENGINE_KPI_KEYS:
        measured = [(e["engine"], exact_of[e["engine"]][k], e["values"][k]) for e in engines if exact_of[e["engine"]][k] is not None]
        c = consistency([x for _, x, _ in measured])
        if c is not None:
            cons[k] = c
        if len(measured) >= 2:
            ordered = sorted(measured, key=lambda m: m[1], reverse=k != "position")
            best, worst = ordered[0], ordered[-1]
            extremes[k] = {"best": {"engine": best[0], "value": best[2]}, "worst": {"engine": worst[0], "value": worst[2]}}
    widest = min(cons, key=lambda k: cons[k]) if cons else None
    return {"engines": engines, "consistency": cons, "extremes": extremes, "widest": widest}


@screen("website/engines")
async def website_engines(q) -> dict:
    """엔진별 비교: the engine rows of the badge (kpi/engines, card) as values. A transient failure -> degraded."""
    ctx, sp = split_context(q)
    common = common_params(website_filters(sp, ctx.get("admin") == "true"), "website")
    try:
        res = await fetch_engine_rows(common, "website")
    except Exception as exc:  # noqa: BLE001
        if not is_transient(exc):
            raise
        return {"engines": [], "consistency": {}, "extremes": {}, "widest": None, "degraded": True}
    return {**engines_view(res["data"]["rows"]), "degraded": False}


def brand_cells(view: dict) -> dict:
    """One brand's tiles keyed by KPI (value, unit, Δ, tone, period chip as website/summary-deferred sends them)."""
    if view["state"] != "ok":
        return {}
    keep = ("unit", "value", "pending", "delta", "direction", "tone", "period")
    return {t["key"]: {f: t.get(f) for f in keep} for g in view["tiles"]["groups"] for t in g["tiles"]}


@screen("website/brands")
async def website_brands(q) -> dict:
    """HMG 브랜드별 비교: for an administrator without a brand pick, each website brand's tiles (the
    summary-deferred tiles read with that brand), and per KPI the best brands (the shown values by the KPI's
    direction, every brand on a tie) and the bar widths of the column. None for the other accounts and with a
    brand pick."""
    ctx, sp = split_context(q)
    if ctx.get("admin") != "true" or website_filters(sp, True).get("brand"):
        return {"brands": None}
    names = (await load_website_prompt_options())["brandOptions"]
    views = await asyncio.gather(*(website_tiles(ctx, {**sp, "brand": name}, True) for name in names))
    rows = [{"brand": name, "state": v["state"], "cells": brand_cells(v)} for name, v in zip(names, views)]
    for key, _cat, _unit, better in KPI_DEFINITIONS:
        cells = [r["cells"][key] for r in rows if key in r["cells"]]
        values = [c["value"] for c in cells if c["value"] is not None and not c["pending"]]
        mx = max(values) if values else None
        best = (min if better == "lower" else max)(values) if values else None
        for c in cells:
            v = None if c["pending"] else c["value"]
            c["bar"] = bar_width(key, v, mx)
            c["best"] = v is not None and v == best
    return {"brands": rows}


@screen("website/geo")
async def website_geo(q) -> dict:
    """Website GEO: shown only when the cards have data. No single active brand -> the empty shape without
    a /v1/geo call; a transient /v1/geo failure -> degraded (old label websiteGeoCompetition)."""
    ctx, sp = split_context(q)
    filters = website_filters(sp, ctx.get("admin") == "true")
    common = common_params(filters, "website")
    active = active_brand_of(filters)

    async def geo_read() -> tuple[dict, bool]:
        if not active:
            return empty_geo(None), False
        try:
            return to_live_geo((await fetch_geo(common))["data"]), False
        except Exception as exc:  # noqa: BLE001
            if not is_transient(exc):
                raise
            return empty_geo(active), True

    (state, _kpis), (live, degraded) = await asyncio.gather(load_live_kpis(common, "website"), geo_read())
    if state != "ok":
        return {"show": False}
    return {"show": True, "degraded": degraded, "geo": geo_view(live, ctx.get("locale", "ko"))}

