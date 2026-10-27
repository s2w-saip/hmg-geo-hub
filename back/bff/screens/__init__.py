"""Screen view models: the BFF layer. One builder per screen section, served at /v1/screens/<name>.

Builders compose the /v1 reads in-process (bff.api.get) and do every calculation the screen
shows, so the front only fetches the result and renders it."""
from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException
from starlette.datastructures import QueryParams

Builder = Callable[[QueryParams], Awaitable[Any]]
REGISTRY: dict[str, Builder] = {}


def screen(name: str) -> Callable[[Builder], Builder]:
    def register(fn: Builder) -> Builder:
        if name in REGISTRY:
            raise RuntimeError(f"Duplicate screen {name}")
        REGISTRY[name] = fn
        return fn
    return register


CONTEXT_PREFIX = "ctx."


def split_context(q: QueryParams) -> tuple[dict[str, str], dict[str, str | list[str]]]:
    """A screen request = route context (`ctx.surface`, `ctx.project_id`, `ctx.locale`, ...) plus the
    page's URL search params passed through untouched, shaped like Next's searchParams
    (one value -> str, repeated key -> list)."""
    ctx: dict[str, str] = {}
    sp: dict[str, str | list[str]] = {}
    for key in dict.fromkeys(q.keys()):
        values = q.getlist(key)
        if key.startswith(CONTEXT_PREFIX):
            ctx[key[len(CONTEXT_PREFIX):]] = values[-1]
        else:
            sp[key] = values[0] if len(values) == 1 else values
    return ctx, sp


_loaded = False


def _load() -> None:
    """Import every public screen module once (they register themselves)."""
    global _loaded
    for module in pkgutil.iter_modules(__path__):
        if not module.name.startswith("_"):
            importlib.import_module(f"{__name__}.{module.name}")
    _loaded = True


async def build(name: str, q: QueryParams) -> Any:
    if not _loaded:
        _load()
    builder = REGISTRY.get(name)
    if builder is None:
        raise HTTPException(404, f"Unknown screen: {name}")
    return await builder(q)
