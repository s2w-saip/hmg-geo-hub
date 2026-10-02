"""WU-5 성능: A41(catalog_incl_deleted) 카탈로그 술어의 보정 집합 형(사실 표 bgrp + Refs.cat_diff) = 세미조인 형(정의) 값 시험.

test_wu4_switches 의 전부 삭제·부분 삭제 준비(롤백 전용)에서 같은 스코프를 두 형으로 읽어 모든 빌더 값(카운트·브랜드 행·인용 원소)이 같은지 본다.
보정 집합은 load_refs 가 프로필이 켜졌을 때 읽는 것과 같은 SQL(core.codes._CAT_DIFF_SQL)로 채운다. 삭제 뒤에는 집합이 비지 않아(P1) 보정 항을 탄다.
"""
from __future__ import annotations

import dataclasses
import json
import uuid
from typing import Any

from app.core import measure as M
from app.core.codes import _CAT_DIFF_SQL
from app.core.config import set_settings
from tests.core.test_wu4_switches import A41, ACTOR, P1, _reseed, _scope
from tests.support import ADMIN, HQ_HYUNDAI, needs_db, raw_fetch, stage, staged

pytestmark = needs_db


async def _cat_diff(conn: Any) -> tuple[tuple[int, int | None], ...]:
    raw = (await raw_fetch(conn, _CAT_DIFF_SQL))[0]
    d = next(iter(raw.values()))
    d = json.loads(d) if isinstance(d, str) else d
    return tuple((int(k), None if m is None else int(m)) for k, m in d)


async def _both(conn: Any, uid: uuid.UUID, **kw) -> tuple[dict, dict, tuple]:
    from app.core.db import fetch_all

    ms, w = await _scope(conn, uid, A41, **kw)
    cd = await _cat_diff(conn)
    out = []
    for m in (dataclasses.replace(ms, cat_diff=None), dataclasses.replace(ms, cat_diff=cd)):
        counts = await M.fetch_counts(conn, m, w, parts=M.ALL_PARTS, group_by=("round_date",))
        brands = sorted(tuple(sorted(r.items())) for r in await M.brand_rows(conn, m, w))
        s = M.citation_counts_sql(m, w, group_by=("source",))
        cit = sorted(tuple(sorted(r.items())) for r in await fetch_all(conn, s.text, s.params))
        out.append({"counts": counts, "brands": brands, "cit": cit})
    return out[0], out[1], cd


async def test_correction_set_equals_semijoin_full_delete(seeded):
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND deleted_at IS NULL"))
        semi, corr, cd = await _both(conn, HQ_HYUNDAI)
        assert cd and semi == corr and semi["counts"][0]["answers"] > 0


async def test_correction_set_equals_semijoin_partial_delete(seeded):
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND brand_code = 'Genesis'"))
        for bit in (1, 4):
            semi, corr, cd = await _both(conn, ADMIN, own_bit=bit)
            assert cd and semi == corr, bit


async def test_load_refs_fills_cat_diff_only_when_on(settings, seeded):
    from app.core.codes import load_refs

    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND deleted_at IS NULL"))
        assert (await load_refs(conn)).cat_diff is None
        set_settings(settings.model_copy(update={"legacy_profile": "catalog_incl_deleted"}))
        try:
            assert (await load_refs(conn)).cat_diff == await _cat_diff(conn)
        finally:
            set_settings(settings)
