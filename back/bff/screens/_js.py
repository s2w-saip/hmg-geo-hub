"""JavaScript number semantics, so values computed here match what the front used to compute."""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def is_num(v: Any) -> bool:
    """typeof v === "number" && Number.isFinite(v)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def js_round(x: float) -> int | float:
    """Math.round: halves go toward +Infinity (Math.round(-2.5) === -2)."""
    if not math.isfinite(x):
        return x
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def to_fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: the exact binary value, rounded half away from zero."""
    if not math.isfinite(x):
        return "NaN" if math.isnan(x) else ("Infinity" if x > 0 else "-Infinity")
    q = Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    s = format(q, "f")
    return s


def js_str(x: Any) -> str:
    """String(number) for finite numbers in the usual range."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Infinity" if x > 0 else "-Infinity"
        if x == int(x) and abs(x) < 1e21:
            return str(int(x))
        r = repr(x)
        if "e" in r:
            mant, exp = r.split("e")
            sign = "-" if exp.startswith("-") else "+"
            return f"{mant}e{sign}{exp.lstrip('+-').lstrip('0') or '0'}"
        return r
    return str(x)


def num(v: Any) -> float | int | None:
    """Number(v) for JSON values; None for null/undefined or non-numbers."""
    return v if is_num(v) else None


def ratio_value(r: Any) -> float | None:
    """{num, den} -> num/den, null when den is 0 or the ratio is absent."""
    if not isinstance(r, dict):
        return None
    n, d = r.get("num"), r.get("den")
    return n / d if is_num(n) and is_num(d) and d != 0 else None


def rank_value(r: Any) -> float | None:
    """{sum, count} -> sum/count, null when absent."""
    if not isinstance(r, dict):
        return None
    s, c = r.get("sum"), r.get("count")
    return s / c if is_num(s) and is_num(c) and c != 0 else None


def js_number(v: Any) -> float | int:
    """Number(v) for URL/JSON values: undefined/null -> per caller, "" -> 0, arrays via toString, else NaN."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, (list, tuple)):
        if not v:
            return 0
        if len(v) == 1:
            return js_number(v[0] if not isinstance(v[0], (list, tuple)) else ",".join(map(str, v[0])))
        return math.nan
    s = str(v).strip()
    if s == "":
        return 0
    try:
        if s.lower().startswith(("0x", "0o", "0b")):
            return int(s, 0)
        if s in ("Infinity", "+Infinity"):
            return math.inf
        if s == "-Infinity":
            return -math.inf
        if any(c not in "0123456789+-.eE" for c in s) or "inf" in s.lower() or "nan" in s.lower():
            return math.nan
        f = float(s)
        return int(f) if f.is_integer() and "e" not in s.lower() and "." not in s else f
    except ValueError:
        return math.nan


_JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def js_parse_int(s: Any) -> int | float:
    """Number.parseInt(String(s), 10): leading JS whitespace, optional sign, ASCII digits; else NaN."""
    text = str(s).lstrip(_JS_WS)
    sign = 1
    if text[:1] in "+-" and text:
        sign = -1 if text[0] == "-" else 1
        text = text[1:]
    digits = ""
    for ch in text:
        if "0" <= ch <= "9":
            digits += ch
        else:
            break
    if not digits:
        return math.nan
    n = sign * int(digits)
    return n if abs(n) <= 2 ** 53 else float(n)  # a JS number: exact integers only up to 2^53
