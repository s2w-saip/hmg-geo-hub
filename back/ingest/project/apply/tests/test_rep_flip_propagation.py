"""WU-2 셀 대표 이동의 자식 사본 전파(DB-v2.15 P85): 1차 적재 답변(J91, 언급·인용 자식 있음)이 2차 적재(J93 만, 같은 R05 셀의 더 늦은 측정)로
대표를 잃으면, J91 은 2차 적재 대상이 아니어도(재투영 없음) 자식 is_rep 이 false 로 따라가야 한다(REP_UPDATE 가 뒤집은 다른 답변 키 전파).
두 규칙(hub·현행 rep_pick_latest_first = 적재기 활성 프로필) 모두 결과 = 같은 입력의 bulk 시드(seed-40 -v rep_latest_first). 롤백 전용.
"""
from __future__ import annotations

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import parse_profile
from ingest.common.db import LoaderDB
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_equivalence import J91, J93, SYNTH_1, TABLES, _ctx, _keys, _report
from ingest.testkit import bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, keep_name_projection, needs_db

# SYNTH_2 에서 J93 만(표시 이름·URL 전역 판정에 걸리지 않는 입력: J91 은 2차 적재에서 재투영되지 않는다)
SYNTH_J93 = f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{J93}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, 'e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'perplexity', 'XK',
       'completed', TIMESTAMPTZ '2026-09-21 05:00+00', 'completed', 0, 0, '\\x02', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{J93}';
"""

_CHILD_REPS = """
SELECT 'brand' AS t, x.is_rep FROM rd.job j JOIN rd.answer_brand x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
 WHERE j.job_id = $1
UNION ALL
SELECT 'citation', x.is_rep FROM rd.job j JOIN rd.citation x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
 WHERE j.job_id = $1"""


def _spec(latest_first: bool) -> str:
    """고정 프로필(대표 규칙) + 복제본의 NAME 투영(표시 브랜드 키는 복제본 차원 그대로라 적재기도 같은 이름 규칙이어야 한다, be/int3-name2)."""
    return keep_name_projection("rep_pick_latest_first" if latest_first else "off")


async def _bulk(latest_first: bool) -> dict:
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(SYNTH_1)
        await c.execute(SYNTH_J93)
        await bulk_seed(c, profile=parse_profile(_spec(latest_first)))
        snap = await snapshot(c, TABLES)
        await tr.rollback()
        return snap
    finally:
        await c.close()


@needs_db
@pytest.mark.parametrize("latest_first", [False, True])
async def test_rep_flip_of_other_answer_propagates_child_is_rep(settings, latest_first):
    ref = await _bulk(latest_first)
    try:
        set_settings(settings.model_copy(update={"legacy_profile": _spec(latest_first)}))
        db = LoaderDB(DB_URL, role="loader")
        c = await db.connect()
        try:
            tr = c.transaction()
            await tr.start()
            await c.execute(SYNTH_1)
            # 기존 행을 활성 규칙으로 맞춘다(운영 절차 = fill-v215-rep.sql 의 reselect_rep + 자식 복사). 복제본은 hub 규칙으로 시드됐고,
            # 현행 규칙 게이트(elig_nc, DB-v2.15 P89 WU-4)는 카탈로그 밖 프롬프트 셀(픽스처 k6)에서 hub 와 대표가 달라 적재 밖 셀까지 bulk 와 맞춘다
            await c.fetchval("SELECT rd.reselect_rep(ARRAY(SELECT cyc_key FROM rd.cycle), $1)", latest_first)
            await c.fetchval("SELECT rd.fill_child_is_rep(ARRAY(SELECT answer_key FROM rd.job WHERE served))")
            ctx = await _ctx(c)
            async with c.transaction():
                await apply(c, ctx, await _keys(c, "a.job_id = $1", J91))
            before = await c.fetch(_CHILD_REPS, J91)
            await c.execute(SYNTH_J93)
            async with c.transaction():
                r2 = await apply(c, ctx, await _keys(c, "a.job_id = $1", J93))
            after = await c.fetch(_CHILD_REPS, J91)
            n = await c.fetchval("SELECT rd.assert_rep(NULL, $1)", latest_first)
            got = await snapshot(c, TABLES)
            loose = diff(ref, got)
            referenced = await referenced_extras(c, loose)
            await tr.rollback()
        finally:
            await c.close()
    finally:
        set_settings(settings)
    assert {r["t"] for r in before} == {"brand", "citation"} and all(r["is_rep"] for r in before)      # 1차: J91 = 셀 대표, 자식도 true
    assert r2.answers == 1 and r2.impacted_by_names == 0 and r2.impacted_by_urls == 0 and r2.rep_flips == 1   # J91 은 재투영되지 않았다
    assert len(after) == len(before) and not any(r["is_rep"] for r in after)                         # 뒤집힌 다른 답변의 자식 사본
    assert n > 0
    # rd.dim_prompt 의 SPX(SYNTH_1 의 ing.prompt, 이 입력에서는 참조 답변 없음)는 bulk 만 투영한다(원래 시험은 J92 가 참조): 차원 1행 제외
    d = {k: v for k, v in strict_diff(loose).items() if k != "rd.dim_prompt"}
    assert not d, _report(d)
    assert not referenced
