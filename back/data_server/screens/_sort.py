"""Sorting with the browser's semantics, so orders computed here match the old client sorts.

- `locale_compare(a, b)`: String.prototype.localeCompare under ICU (ko-KR, the screens' locale).
- `code_unit_compare(a, b)`: the default JS `<` / Array.prototype.sort() on strings (UTF-16 units).
- `table_orders(rows, sorters)`: the precomputed row orders of a sortable table (hooks/use-sortable-table):
  null values always last, strings by localeCompare, numbers by difference, stable ties.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from functools import cmp_to_key
from typing import Any

import icu

_COLLATOR = icu.Collator.createInstance(icu.Locale("ko_KR"))


def locale_compare(a: str, b: str) -> int:
    return _COLLATOR.compare(a, b)


def _utf16(s: str) -> bytes:
    return s.encode("utf-16-be")


def code_unit_compare(a: str, b: str) -> int:
    ua, ub = _utf16(a), _utf16(b)
    return (ua > ub) - (ua < ub)


def code_unit_key(s: str) -> bytes:
    """Sort key for JS default string order (`[...xs].sort()`)."""
    return _utf16(s)


def sign(x: float) -> int:
    return (x > 0) - (x < 0)


def sortable_compare(av: Any, bv: Any, direction: int) -> int:
    """The comparator of hooks/use-sortable-table.ts."""
    if av is None or bv is None:
        return 0 if av is None and bv is None else (1 if av is None else -1)
    if isinstance(av, str) and isinstance(bv, str):
        return direction * locale_compare(av, bv)
    return direction * sign(av - bv)


def order(values: Sequence[Any], direction: int) -> list[int]:
    idx = list(range(len(values)))
    return sorted(idx, key=cmp_to_key(lambda i, j: sortable_compare(values[i], values[j], direction)))


def table_orders(rows: Sequence[Any], sorters: dict[str, Callable[[Any], Any]]) -> dict[str, dict[str, list[int]]]:
    """For every sortable column: the row indices in ascending and descending order."""
    out: dict[str, dict[str, list[int]]] = {}
    for key, fn in sorters.items():
        values = [fn(r) for r in rows]
        out[key] = {"asc": order(values, 1), "desc": order(values, -1)}
    return out


def sort_by(items: Sequence[Any], cmp: Callable[[Any, Any], int]) -> list[Any]:
    """Array.prototype.sort with a comparator (stable)."""
    return sorted(items, key=cmp_to_key(cmp))
