"""Period resolution and the period-compare rules (port of the front's pure period modules).

Sources, kept bit for bit (same branches, same date arithmetic, same float expressions):
  lib/kpi/period-compare.ts          day helpers, policy constants, computeCompare and its suppression
  lib/kpi/calendar-month-window.ts   calendar month windows (resolvePeriodCompareShape)
  lib/kpi/period-compare-week.ts     calendar weeks, regular round weekday (resolveComparePeriodShape)
  lib/period/compare-shape.ts        resolveRequestComparePeriodShape (the API source = anchor axis on)
  lib/kpi/period-compare-view.ts     chips, captions, label keys (message keys + params only)
  components/dash/selectable-dates.ts kstToday

Dates are `YYYY-MM-DD` strings. The JS helpers they replace use two different calendars and both are
reproduced: `Date.UTC(y, m, d)` (years 0..99 mean 1900..1999, month/day overflow rolls over) and
`new Date("<day>T00:00:00Z")` (ISO parse: month 1..12, day 1..31 rolling into the next month, no
1900 rule). "Today" is always a parameter; the default is now in Asia/Seoul.

Functions that threw in TS raise ValueError here.
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from bff.screens._js import js_round, to_fixed

# ── JS calendar arithmetic ─────────────────────────────────────────────────

_EPOCH_ORD = date(1970, 1, 1).toordinal()
_CYCLE_DAYS = 146097  # days in 400 Gregorian years
MS_PER_DAY = 86_400_000


def _civil_days(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 of (y, m 1..12, day d counted from the 1st, any integer)."""
    shift = 0
    if y < 1 or y > 9999:
        k = (y - 2000) // 400
        y -= 400 * k
        shift = _CYCLE_DAYS * k
    return date(y, m, 1).toordinal() - _EPOCH_ORD + (d - 1) + shift


def _civil_from_days(n: int) -> tuple[int, int, int]:
    k = n // _CYCLE_DAYS
    dt = date.fromordinal(_EPOCH_ORD + n - _CYCLE_DAYS * k)
    return dt.year + 400 * k, dt.month, dt.day


def date_utc_days(y: int, m0: int, d: int = 1) -> int:
    """`Date.UTC(y, m0, d)` in days: years 0..99 are 1900..1999, months and days roll over."""
    if 0 <= y <= 99:
        y += 1900
    y += m0 // 12
    m0 %= 12
    return _civil_days(y, m0 + 1, d)


def iso_of_days(n: int) -> str:
    """`new Date(n days).toISOString().slice(0, 10)` (extended years as JS writes them)."""
    y, m, d = _civil_from_days(n)
    ys = f"{y:04d}" if 0 <= y <= 9999 else ("+" if y > 0 else "-") + f"{abs(y):06d}"
    return f"{ys}-{m:02d}-{d:02d}"[:10]


_ISO_PARSE = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)


def iso_parse_days(day: Any) -> int | None:
    """`Date.parse(`${day}T00:00:00Z`)` in days for the YYYY-MM-DD shape, None for NaN."""
    if not isinstance(day, str):
        return None
    g = _ISO_PARSE.fullmatch(day)
    if not g:
        return None
    y, m, d = int(g[1]), int(g[2]), int(g[3])
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    return _civil_days(y, m, d)


def utc_day_of_week(n: int) -> int:
    """`getUTCDay()` (0 = Sunday) of a day number."""
    return (n + 4) % 7


def _js_number(s: str) -> float:
    """Number(s) for the short digit strings these modules slice out of dates."""
    t = s.strip()
    if t == "":
        return 0
    try:
        return int(t, 10) if re.fullmatch(r"[+-]?\d+", t, re.ASCII) else float(t)
    except ValueError:
        return math.nan


# ── KST today ──────────────────────────────────────────────────────────────

KST_OFFSET = timedelta(hours=9)


def _instant(now: Any) -> datetime:
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    if isinstance(now, (int, float)) and not isinstance(now, bool):
        return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=now)
    return datetime.fromisoformat(str(now).replace("Z", "+00:00"))


def kst_today(now: Any = None) -> str:
    """KST date of an instant (kstToday: shift +9 h, read the UTC fields). Default: now.

    `now`: None, an aware datetime, epoch milliseconds or an ISO instant string."""
    if now is None:
        t = datetime.now(ZoneInfo("Asia/Seoul"))
    else:
        t = _instant(now).astimezone(timezone.utc) + KST_OFFSET
    return f"{t.year}-{t.month:02d}-{t.day:02d}"


# ── lib/kpi/period-compare.ts ──────────────────────────────────────────────

DAY_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\Z", re.ASCII)


def is_day(v: Any) -> bool:
    return isinstance(v, str) and DAY_RE.match(v) is not None


def assert_day(v: Any, label: str = "day") -> str:
    if not is_day(v):
        raise ValueError(f"invalid {label}: {v}")
    return v


def _day_to_days(d: str) -> int:
    return date_utc_days(int(d[0:4]), int(d[5:7]) - 1, int(d[8:10]))


def add_days(d: str, n: int) -> str:
    """Day offset (addDays): Date.UTC arithmetic on a validated day."""
    return iso_of_days(_day_to_days(assert_day(d)) + int(n))


def diff_days(from_: str, to: str) -> int:
    return _day_to_days(assert_day(to)) - _day_to_days(assert_day(from_))


COMPARE_METRIC_UNITS = {"visibility": "pp", "share": "pp", "favorability": "pp", "position": "rank",
                        "mentionsPerAnswer": "pct", "citationsPerAnswer": "pct"}
COMPARE_METRIC_FAMILY = {"visibility": "mention", "share": "mention", "favorability": "mention",
                         "position": "mention", "mentionsPerAnswer": "mention", "citationsPerAnswer": "citation"}
SUPPRESSION_PRECEDENCE = ("unsupported", "no_prev", "no_data", "missing_share", "start_window", "start_month")
MISSING_SHARE_MAX = 0.3
MISSING_SHARE_MIN_WINDOW_DAYS = 30
PERIOD_COMPARE_EPOCH = "2026-09-08"
START_MONTH_FIRST_WEEK_LAST_DAY = 7
CALENDAR_WEEK_DAYS = 7


def _is_integer(n: Any) -> bool:
    if isinstance(n, bool):
        return False
    if isinstance(n, int):
        return True
    return isinstance(n, float) and math.isfinite(n) and n.is_integer()


def period_compare_applies(cur_hi: str, epoch: str = PERIOD_COMPARE_EPOCH) -> bool:
    return assert_day(cur_hi, "curHi") >= assert_day(epoch, "epoch")


def grace_days(days: Any) -> int:
    if not _is_integer(days) or days < 1:
        raise ValueError(f"invalid window length: {days}")
    return math.ceil(days / 4)


def window_length(w: dict) -> int:
    return diff_days(w["lo"], w["hi"]) + 1


def resolve_windows(end_day: str, days: Any) -> dict:
    e = assert_day(end_day, "endDay")
    if not _is_integer(days) or days < 1:
        raise ValueError(f"invalid window length: {days}")
    days = int(days)
    return {"cur": {"lo": add_days(e, -(days - 1)), "hi": e},
            "prev": {"lo": add_days(e, -(2 * days - 1)), "hi": add_days(e, -days)}}


def clamp_window_lo(w: dict, min_day: str | None = None) -> dict:
    if not min_day:
        return w
    mn = assert_day(min_day, "minDay")
    return {"lo": mn, "hi": w["hi"]} if mn > w["lo"] and mn <= w["hi"] else w


def window_key(w: dict) -> str:
    return f"{w['lo']}..{w['hi']}"


def windows_from_range(from_: str, to: str) -> dict:
    lo = assert_day(from_, "from")
    hi = assert_day(to, "to")
    days = diff_days(lo, hi) + 1
    if days < 1:
        raise ValueError(f"range must be ascending: {lo}..{hi}")
    return {"days": days, **resolve_windows(hi, days)}


def _gt0(v: Any) -> bool:
    """JS `v > 0` for JSON values (null/undefined/strings never pass here)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def missing_share(ledger: dict) -> float:
    if not _gt0(ledger.get("plannedUnits")):
        return 0
    return ledger["missingUnits"] / ledger["plannedUnits"]


def missing_share_known(ledger: dict) -> bool:
    known = ledger.get("plannedKnown")
    return known if known is not None else _gt0(ledger.get("plannedUnits"))


def applies_missing_share(opts: dict) -> bool:
    if opts["kind"] in ("calendarMonth", "calendarWeek"):
        return True
    return opts["days"] >= MISSING_SHARE_MIN_WINDOW_DAYS


def judge_start_window(a: dict) -> bool:
    f = a.get("firstPublishedAnchor")
    if not f:
        return False
    return f > add_days(a["prevLo"], grace_days(a["days"]))


def judge_start_month(a: dict) -> bool:
    if a["beforeDataCycles"] > 0:
        return False
    f = a.get("firstPublishedAnchor")
    if not f:
        return False
    if f < a["prevLo"] or f > a["prevHi"]:
        return False
    n = _js_number(f[8:10])
    return not math.isnan(n) and n > START_MONTH_FIRST_WEEK_LAST_DAY


def compare_suppression_of(prev: dict, cur: dict, opts: dict) -> str | None:
    """period-compare.ts suppressionOf: the winning reason or None."""
    days = opts.get("days")
    if days is None:
        days = window_length({"lo": cur["lo"], "hi": cur["hi"]})
    hit: set[str] = set()
    if opts.get("unsupported") is True:
        hit.add("unsupported")
    if prev["ledger"]["publishedCycles"] <= 0:
        hit.add("no_prev")
    if prev["ledger"]["dataCycles"] <= 0 or cur["ledger"]["dataCycles"] <= 0:
        hit.add("no_data")
    if applies_missing_share({"kind": opts["kind"], "days": days}):
        def over(ledger: dict) -> bool:
            return missing_share_known(ledger) and missing_share(ledger) >= MISSING_SHARE_MAX
        if over(prev["ledger"]) or over(cur["ledger"]):
            hit.add("missing_share")
    if opts["kind"] in ("window", "calendarWeek"):
        if judge_start_window({"firstPublishedAnchor": prev["ledger"].get("firstPublishedAnchor"), "prevLo": prev["lo"],
                               "days": CALENDAR_WEEK_DAYS if opts["kind"] == "calendarWeek" else days}):
            hit.add("start_window")
    elif judge_start_month({"firstPublishedAnchor": prev["ledger"].get("firstPublishedAnchor"), "prevLo": prev["lo"],
                            "prevHi": prev["hi"],
                            "beforeDataCycles": ((opts.get("before") or {}).get("ledger") or {}).get("dataCycles") or 0}):
        hit.add("start_month")
    return next((r for r in SUPPRESSION_PRECEDENCE if r in hit), None)


def compare_ratio(m: dict | None) -> float | None:
    if not m:
        return None
    if not _gt0(m.get("denominator")):
        return None
    return m["numerator"] / m["denominator"]


def compare_delta_of(unit: str | None, prev: float | None, cur: float | None) -> float | None:
    if prev is None or cur is None:
        return None
    if unit == "pp":
        return (cur - prev) * 100
    if unit == "rank":
        return cur - prev
    if prev == 0:
        return None
    return ((cur - prev) / prev) * 100


def compute_compare(prev: dict, cur: dict, opts: dict) -> list[dict]:
    reason = compare_suppression_of(prev, cur, opts)
    suppressed = reason is not None
    out = []
    for metric in opts["metrics"]:
        unit = COMPARE_METRIC_UNITS.get(metric)
        p = compare_ratio(prev["measures"].get(metric))
        c = compare_ratio(cur["measures"].get(metric))
        row = {"metric": metric}
        if unit is not None:
            row["unit"] = unit
        row.update({"prev": p, "cur": c, "delta": None if suppressed else compare_delta_of(unit, p, c),
                    "suppressed": suppressed, "reason": reason,
                    "cyclesPrev": prev["ledger"]["publishedCycles"], "cyclesCur": cur["ledger"]["publishedCycles"],
                    "plannedPrev": prev["ledger"]["plannedUnits"], "plannedCur": cur["ledger"]["plannedUnits"],
                    "missingSharePrev": missing_share(prev["ledger"]), "missingShareCur": missing_share(cur["ledger"])})
        out.append(row)
    return out


# ── lib/kpi/calendar-month-window.ts ───────────────────────────────────────

_PARSE_DAY = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\Z", re.ASCII)


def _pad2(n: int) -> str:
    return str(n).rjust(2, "0")


def month_window(y: int, m: int) -> dict:
    """First and last day of month m of year y (m outside 1..12 rolls the year)."""
    yy = y + (m - 1) // 12
    mm = (m - 1) % 12 + 1
    last = _civil_from_days(date_utc_days(yy, mm, 0))[2]
    return {"lo": f"{yy}-{_pad2(mm)}-01", "hi": f"{yy}-{_pad2(mm)}-{_pad2(last)}"}


def parse_day(day: Any) -> dict | None:
    g = _PARSE_DAY.match(day) if isinstance(day, str) else None
    if not g:
        return None
    y, m, d = int(g[1]), int(g[2]), int(g[3])
    if m < 1 or m > 12 or d < 1 or d > 31:
        return None
    return {"y": y, "m": m, "d": d}


def resolve_calendar_months(from_: str | None, to: str | None) -> dict | None:
    if not from_ or not to:
        return None
    lo, hi = parse_day(from_), parse_day(to)
    if not lo or not hi:
        return None
    if lo["d"] != 1:
        return None
    if lo["y"] != hi["y"] or lo["m"] != hi["m"]:
        return None
    cur = month_window(lo["y"], lo["m"])
    if to > cur["hi"]:
        return None
    return {"cur": {"lo": cur["lo"], "hi": to}, "prev": month_window(lo["y"], lo["m"] - 1),
            "before": month_window(lo["y"], lo["m"] - 2)}


def selected_window_days(from_: str | None, to: str | None) -> int | None:
    if not from_ or not to:
        return None
    lo, hi = iso_parse_days(from_), iso_parse_days(to)
    if lo is None or hi is None or hi < lo:
        return None
    return hi - lo + 1


def resolve_period_compare_shape(from_: str | None, to: str | None) -> dict:
    months = resolve_calendar_months(from_, to)
    days = selected_window_days(from_, to)
    return {"kind": "calendarMonth", "months": months, "days": days} if months else {"kind": "window", "days": days}


# ── lib/kpi/period-compare-week.ts ─────────────────────────────────────────

REGULAR_ROUND_DOW = {"global": 1, "website": 5}


def iso_dow_of(day: str) -> int:
    n = iso_parse_days(assert_day(day, "day"))
    return (utc_day_of_week(n) + 6) % 7 + 1


def week_monday_of(day: str) -> str:
    return add_days(assert_day(day, "day"), -(iso_dow_of(day) - 1))


def week_window_of(monday: str) -> dict:
    lo = assert_day(monday, "monday")
    return {"lo": lo, "hi": add_days(lo, CALENDAR_WEEK_DAYS - 1)}


def regular_round_date_of(surface: str, day: str) -> str:
    return add_days(week_monday_of(day), REGULAR_ROUND_DOW[surface] - 1)


def resolve_calendar_weeks(from_: str | None, to: str | None) -> dict | None:
    if not from_ or not to:
        return None
    try:
        lo = assert_day(from_, "from")
        hi = assert_day(to, "to")
    except ValueError:
        return None
    if hi < lo:
        return None
    if iso_dow_of(lo) != 1:
        return None
    week = week_window_of(lo)
    if hi > week["hi"]:
        return None
    prev_monday = add_days(lo, -CALENDAR_WEEK_DAYS)
    return {"cur": {"lo": lo, "hi": hi}, "prev": week_window_of(prev_monday),
            "before": week_window_of(add_days(prev_monday, -CALENDAR_WEEK_DAYS))}


def _safe_days(from_: str, to: str) -> int | None:
    try:
        n = diff_days(assert_day(from_, "from"), assert_day(to, "to")) + 1
    except ValueError:
        return None
    return n if n >= 1 else None


def resolve_compare_period_shape(from_: str | None, to: str | None) -> dict:
    """Month first, then calendar week, then window (resolveComparePeriodShape)."""
    days = _safe_days(from_, to) if from_ and to else None
    months = resolve_calendar_months(from_, to)
    if months:
        return {"kind": "calendarMonth", "months": months, "days": days}
    weeks = resolve_calendar_weeks(from_, to)
    if weeks:
        return {"kind": "calendarWeek", "weeks": weeks, "days": days}
    return {"kind": "window", "days": days}


def resolve_request_compare_period_shape(from_: str | None, to: str | None, axis_on: bool = True) -> dict:
    """lib/period/compare-shape.ts: an API-sourced screen is always on the anchor axis (month ->
    week -> window); axis_on=False is the legacy month -> window shape."""
    return resolve_compare_period_shape(from_, to) if axis_on else resolve_period_compare_shape(from_, to)


# ── lib/kpi/period-compare-view.ts ─────────────────────────────────────────

SUPPRESSED_GLYPH = "―"
PERIOD_PRESET_DAYS = {"weekly": 7, "biweekly": 14, "monthly": 30, "yearly": 365}
YEAR_WINDOW_MIN_DAYS = 365
PERIOD_CHIP_ORDER = ("visibility", "share", "favorability", "position", "mentionsPerAnswer", "citationsPerAnswer")
_INVERTED = {"position"}
_MISSING = object()


def is_year_scale_window(days: Any) -> bool:
    return isinstance(days, (int, float)) and not isinstance(days, bool) and days >= YEAR_WINDOW_MIN_DAYS


def period_preset_key_of(days: Any) -> str | None:
    if is_year_scale_window(days):
        return "yearly"
    if not isinstance(days, (int, float)) or isinstance(days, bool):
        return None
    return next((k for k, v in PERIOD_PRESET_DAYS.items() if v == days), None)


def _collected_pct(share: float) -> int:
    return js_round((1 - share) * 100)


def period_caption(r: dict, ctx: dict) -> dict:
    """Result -> caption message {key, params} (periodCaption)."""
    reason = r.get("reason")
    if reason == "unsupported":
        return {"key": "reason.unsupported", "params": {}}
    if reason == "no_prev":
        if ctx.get("kind") == "calendarWeek":
            return {"key": "reason.noPrevWeek", "params": {}}
        if ctx.get("kind") == "calendarMonth":
            return {"key": "reason.noPrevMonth", "params": {}}
        if is_year_scale_window(ctx.get("days")):
            return {"key": "reason.noPrevYear", "params": {}}
        params = {"days": ctx["days"]} if "days" in ctx else {}
        return {"key": "reason.noPrevWindow", "params": params}
    if reason == "no_data":
        cur_data = ctx.get("curDataCycles")
        if cur_data is None:
            cur_data = (ctx.get("curLedger") or {}).get("dataCycles")
        if cur_data is None:
            cur_data = 0
        return {"key": "reason.noDataCur", "params": {}} if cur_data <= 0 else {"key": "reason.noDataPrev", "params": {}}
    if reason == "missing_share":
        prev_share = r.get("missingSharePrev")
        if prev_share is None:
            prev_share = missing_share(ctx["prevLedger"]) if ctx.get("prevLedger") else 1
        cur_share = r.get("missingShareCur")
        if cur_share is None:
            cur_share = missing_share(ctx["curLedger"]) if ctx.get("curLedger") else None
        share = prev_share if prev_share >= MISSING_SHARE_MAX else (cur_share if cur_share is not None else prev_share)
        return {"key": "reason.missingShare", "params": {"pct": _collected_pct(share)}}
    if reason == "start_window":
        return {"key": "reason.startWindow", "params": {}}
    if reason == "start_month":
        return {"key": "reason.startMonth", "params": {}}
    params = {}
    if "cyclesPrev" in r:
        params["prevCycles"] = r["cyclesPrev"]
    if "cyclesCur" in r:
        params["curCycles"] = r["cyclesCur"]
    return {"key": "window", "params": params}


def period_chip(m: dict) -> dict:
    """{metric, delta} -> chip input: magnitude rounded sign-symmetrically, direction = better or worse."""
    metric = m["metric"]
    unit = COMPARE_METRIC_UNITS.get(metric)
    head = {"key": metric}
    if unit is not None:
        head["unit"] = unit
    delta = m.get("delta")
    if delta is None:
        return {**head, "suppressed": True, "value": None, "direction": "flat"}
    magnitude = js_round(abs(delta) * 10) / 10
    rounded = 0 if magnitude == 0 else (magnitude if delta > 0 else -magnitude)
    better = -rounded if metric in _INVERTED else rounded
    return {**head, "suppressed": False, "value": magnitude,
            "direction": "up" if better > 0 else "down" if better < 0 else "flat"}


def period_chip_text(chip: dict) -> str:
    if chip.get("suppressed") or chip.get("value") is None:
        return SUPPRESSED_GLYPH
    n = to_fixed(chip["value"], 1)
    if chip.get("unit") == "pp":
        return f"{n}pp"
    if chip.get("unit") == "pct":
        return f"{n}%"
    return n


def to_period_delta_view(results: list[dict], ctx: dict) -> dict:
    """CompareResult[] + label/caption context -> {days, presetKey, caption, chips} (toPeriodDeltaView)."""
    by = {r["metric"]: r for r in results}
    order = [k for k in PERIOD_CHIP_ORDER if k in by]
    chips = [period_chip({"metric": k, "delta": by[k].get("delta")}) for k in order]
    head = results[0] if results else None
    none_comparable = len(chips) > 0 and all(c["suppressed"] for c in chips)
    if head is None:
        caption = {"key": "reason.unsupported", "params": {}}
    elif head.get("reason", _MISSING) is None and none_comparable:
        caption = {"key": "reason.unsupported", "params": {}}
    else:
        caption = period_caption(head, ctx)
    out: dict = {}
    if "days" in ctx:
        out["days"] = ctx["days"]
    out.update({"presetKey": label_key_of(ctx), "caption": caption, "chips": chips})
    return out


def label_key_of(ctx: dict) -> str | None:
    if ctx.get("kind") == "calendarWeek":
        return week_label_key_of(ctx.get("curLo"), ctx.get("todayKst"))
    if ctx.get("kind") == "calendarMonth":
        return month_label_key_of(ctx.get("curLo"), ctx.get("todayKst"))
    return period_preset_key_of(ctx.get("days"))


_YMD = re.compile(r"^\d{4}-\d{2}-\d{2}\Z", re.ASCII)


def month_label_key_of(cur_lo: str | None, today_kst: str | None) -> str | None:
    def ym(d: str | None) -> str | None:
        return d[:7] if d and isinstance(d, str) and _YMD.match(d) else None
    cur, now = ym(cur_lo), ym(today_kst)
    if not cur or not now:
        return period_preset_key_of(0)
    if cur == now:
        return "thisMonth"
    y, m = (int(x) for x in now.split("-"))
    prev = f"{y - 1}-12" if m == 1 else f"{y}-{str(m - 1).rjust(2, '0')}"
    return "lastMonth" if cur == prev else None


def week_label_key_of(cur_lo: str | None, today_kst: str | None) -> str | None:
    if not cur_lo or not today_kst:
        return "thisWeek"

    def monday(d: str) -> str | None:
        g = _PARSE_DAY.match(d)
        if not g:
            return None
        t = date_utc_days(int(g[1]), int(g[2]) - 1, int(g[3]))
        dow = (utc_day_of_week(t) + 6) % 7
        return iso_of_days(t - dow)

    cur, now = monday(cur_lo), monday(today_kst)
    if not cur or not now:
        return "thisWeek"
    if cur == now:
        return "thisWeek"
    n = iso_parse_days(now)
    if n is None:
        raise ValueError(f"invalid date: {now}")
    return "lastWeek" if cur == iso_of_days(n - 7) else None
