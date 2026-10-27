"""Replay golden cases recorded from the front (front/test/bff-golden/tape.ts).

A case = {screen, query, tape, output}. The screen builder runs with bff.api.get answered from
the tape only (an unrecorded call fails the case), and its result must equal the front's output:
same keys (a missing key differs from null), numbers compared by value (1 == 1.0), lists in order.
"""
from __future__ import annotations

import gzip
import json
import math
from pathlib import Path
from typing import Any
from unittest import mock

GOLDEN = Path(__file__).parent / "golden"


def tape_key(path: str, query: list[tuple[str, str]]) -> str:
    pairs = sorted(((k, v, i) for i, (k, v) in enumerate(query)), key=lambda t: (t[0].encode("utf-16-be"), t[2]))
    return json.dumps([path, [[k, v] for k, v, _ in pairs]], ensure_ascii=False, separators=(",", ":"))


class Tape:
    def __init__(self, entries: list[dict]) -> None:
        self.entries = {tape_key(e["path"], [tuple(p) for p in e["query"]]): e for e in entries}
        self.used: set[str] = set()

    async def get(self, path: str, params: Any = None) -> dict:
        from bff.api import query
        q = query(params)
        key = tape_key(path, list(q.multi_items()))
        entry = self.entries.get(key)
        if entry is None:
            raise AssertionError(f"call not on tape: {key}")
        self.used.add(key)
        if entry["status"] >= 400:
            from fastapi import HTTPException
            body = entry["body"] if isinstance(entry["body"], dict) else {}
            raise HTTPException(entry["status"], (body.get("error") or {}).get("message", "error"))
        return json.loads(json.dumps(entry["body"]))


def case_files(root: Path = GOLDEN, family: str = "*") -> list[Path]:
    """Golden case files (stored gzipped as <name>.json.gz; plain .json is read too)."""
    return sorted([*root.glob(f"{family}/*.json"), *root.glob(f"{family}/*.json.gz")])


def cases(family: str) -> list[Path]:
    return case_files(GOLDEN, family)


def load(path: Path) -> dict:
    if path.name.endswith(".gz"):
        return json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
    return json.loads(path.read_text(encoding="utf-8"))


def diff(expected: Any, actual: Any, at: str = "$") -> list[str]:
    """Differences between the front's JSON and ours; empty when equal."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return [] if expected is actual else [f"{at}: {expected!r} != {actual!r}"]
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if expected == actual or (isinstance(expected, float) and isinstance(actual, float) and math.isnan(expected) and math.isnan(actual)):
            return []
        return [f"{at}: {expected!r} != {actual!r}"]
    if isinstance(expected, dict) and isinstance(actual, dict):
        out = []
        for k in expected.keys() - actual.keys():
            out.append(f"{at}.{k}: missing (expected {json.dumps(expected[k], ensure_ascii=False)[:80]})")
        for k in actual.keys() - expected.keys():
            out.append(f"{at}.{k}: unexpected {json.dumps(actual[k], ensure_ascii=False)[:80]}")
        for k in expected.keys() & actual.keys():
            out += diff(expected[k], actual[k], f"{at}.{k}")
        return out
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{at}: length {len(expected)} != {len(actual)}"] + diff(expected[:min(len(expected), len(actual))], actual[:min(len(expected), len(actual))], at)
        out = []
        for i, (e, a) in enumerate(zip(expected, actual)):
            out += diff(e, a, f"{at}[{i}]")
        return out
    return [] if expected == actual else [f"{at}: {expected!r} != {actual!r}"]


async def run_fn_case(case: dict) -> list[str]:
    """Function golden: call module:function with each recorded args list; compare outputs."""
    import importlib
    import inspect
    module, name = case["fn"].split(":")
    fn = getattr(importlib.import_module(module), name)
    out = []
    for i, call in enumerate(case["calls"]):
        result = fn(*json.loads(json.dumps(call["args"])))
        if inspect.isawaitable(result):
            result = await result
        problems = diff(call["output"], json.loads(json.dumps(result, ensure_ascii=False)), f"call[{i}]")
        if problems:
            out += [f"args={json.dumps(call['args'], ensure_ascii=False)[:160]}"] + problems[:4]
            if len(out) > 12:
                break
    return out


async def run_case(path: Path) -> list[str]:
    """Build the case's screen from its tape (or call the function); return the differences (empty = equal)."""
    from starlette.datastructures import QueryParams
    from bff import screens
    case = load(path)
    if "fn" in case:
        return await run_fn_case(case)
    tape = Tape(case["tape"])
    q = QueryParams([(k, v) for k, vs in case["query"].items() for v in (vs if isinstance(vs, list) else [vs])])
    with mock.patch("bff.api.get", tape.get):
        actual = await screens.build(case["screen"], q)
    actual = json.loads(json.dumps(actual, ensure_ascii=False))
    return diff(case["output"], actual)
