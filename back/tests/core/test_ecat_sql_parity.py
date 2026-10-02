"""E1 투영 SQL 쌍둥이 = 파이썬 정본(app.core.ecat) 대조.

- pg_temp.ecat_norm(원문 표면)  = text.normalize_surface   (차단 표면 비교: 언급 표면 배열·발생 원문 ↔ ecat_surface_def.surface_norm)
- pg_temp.ecat_resolve(…)       = matcher.resolve_overlaps (재매칭 발생 겹침 제거, Scope 발생 구간 occupied 포함)
두 함수는 seed-3x-common §10 에 있고 bulk 시드(seed-40 §5)와 적재기(seed-4x-ecat.sql)가 같은 것을 쓴다.
"""
from __future__ import annotations

import random
import unicodedata
import uuid

import asyncpg
import pytest

from app.core.ecat.matcher import Hit, resolve_overlaps
from app.core.ecat.text import normalize_surface
from ingest.common.rules import ensure_session_rules
from tests.support import DB_URL, needs_db

SURFACES = [
    "BMW", "ＢＭＷ", "Straße", "STRASSE", "ẞ", "ΣΑΣ", "σας", "Citroën", "Citroën", "Hyundai  Motor", " N ", "n", "N Line",
    "현대", "현대차", "现代", "ﬁat", "İstanbul", "KIA　EV6", "　Genesis\t", "Epit", "EPIT", "e-pit", "Škoda", "SKODA", "GV80",
    "Ioniq\n5", "ｶﾞｿﾘﾝ", "ﾍﾟｲ", "Mercedes-Benz", "Hyundai N", "CR‑V", "ǅemal", "Ǆ", "Ω", "ﬀ", "Tesla™", "①", "ガソリン",
]


@needs_db
async def test_ecat_norm_matches_python_normalize_surface():
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await ensure_session_rules(c)
        got = dict(await c.fetch("SELECT s, pg_temp.ecat_norm(s) FROM unnest($1::text[]) s", SURFACES))
        await tr.rollback()
    finally:
        await c.close()
    want = {s: unicodedata.normalize("NFC", normalize_surface(s)) for s in SURFACES}     # 비교는 양쪽 NFC(seed-3x-common §10 주석)
    bad = {s: (got[s], want[s]) for s in SURFACES if got[s] != want[s]}
    assert not bad, bad
    assert got["ｶﾞｿﾘﾝ"] == got["ガソリン"] == "ガソリン" and got["EPIT"] == "epit" and got["ＢＭＷ"] == "bmw"


def _cases(n: int, seed: int = 20261001) -> list[tuple[list[Hit], list[tuple[int, int]]]]:
    rnd = random.Random(seed)
    ents = [uuid.UUID(int=i + 1) for i in range(4)]
    out = []
    for _ in range(n):
        hits: dict[tuple[int, int, int], Hit] = {}
        for _ in range(rnd.randint(1, 9)):
            s = rnd.randint(0, 40)
            e = s + rnd.randint(1, 8)
            sid = rnd.randint(1, 6)
            hits[(s, e, sid)] = Hit(s, e, sid, ents[(sid - 1) % len(ents)] if rnd.random() < 0.7 else rnd.choice(ents))
        # 완전히 같은 구간 다른 표면(같은·다른 엔티티)을 섞는다
        if hits and rnd.random() < 0.5:
            h = rnd.choice(list(hits.values()))
            sid = 7 + rnd.randint(0, 2)
            hits[(h.start, h.end, sid)] = Hit(h.start, h.end, sid, rnd.choice([h.entity_id, *ents]))
        occ = [(o, o + rnd.randint(1, 6)) for o in (rnd.randint(0, 45) for _ in range(rnd.randint(0, 3)))]
        out.append((list(hits.values()), occ))
    return out


@needs_db
async def test_ecat_resolve_matches_python_resolve_overlaps():
    cases = _cases(400)
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await ensure_session_rules(c)
        bad = []
        for hits, occ in cases:
            idx = await c.fetch("SELECT k FROM pg_temp.ecat_resolve($1::int[], $2::int[], $3::int[], $4::uuid[], $5::int[], $6::int[]) k",
                                [h.start for h in hits], [h.end for h in hits], [h.surface_id for h in hits], [h.entity_id for h in hits],
                                [o[0] for o in occ] or None, [o[1] for o in occ] or None)
            got = sorted((hits[r[0] - 1].start, hits[r[0] - 1].end, hits[r[0] - 1].surface_id) for r in idx)
            want = sorted((h.start, h.end, h.surface_id) for h in resolve_overlaps(hits, occ))
            if got != want:
                bad.append((hits, occ, got, want))
        await tr.rollback()
    finally:
        await c.close()
    assert not bad, bad[:3]
    assert len(cases) == 400


@pytest.mark.parametrize("hits,occ,want", [
    ([Hit(0, 5, 1, "a"), Hit(0, 5, 2, "b"), Hit(0, 5, 3, "a")], [], [(0, 5, 1), (0, 5, 2)]),     # 같은 구간: 다른 엔티티만 함께
    ([Hit(0, 9, 1, "a"), Hit(0, 5, 2, "b"), Hit(4, 7, 3, "c")], [], [(0, 9, 1)]),                  # 긴 것 우선, 겹침 버림
    ([Hit(0, 5, 1, "a"), Hit(6, 9, 2, "b")], [(4, 6)], [(6, 9, 2)]),                               # Scope 발생과 겹치면 버림(끝 배타)
])
def test_resolve_overlaps_reference_cases(hits, occ, want):
    """SQL 대조의 기준(파이썬 정본) 자체가 설계 규칙대로인지 손 계산 3건."""
    assert sorted((h.start, h.end, h.surface_id) for h in resolve_overlaps(hits, occ)) == want
