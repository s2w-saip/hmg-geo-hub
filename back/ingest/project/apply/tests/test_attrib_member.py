"""WU-3b 현행 프로필 resub_phantom_exclude(RESUB, 투영 스위치): 답변 회차 = run 원장 멤버십(ing.cycle_run).

현행 앵커 표 cycle_id 는 run 의 summary_cycle_runs 회차이고(0078 refresh_answer_cycle_anchors run_ctx :821-845) 사실표 생성기도 멤버 run 만
읽는다(lib/summary/generate/cycle.ts:316-323). 허브 코호트 규칙(pin → 원장 선택)은 그 회차를 바꾸지 않는다. 합성 입력(고객 데이터 아님):
  ① 픽스처 pin(job 17, run 5 = 원장 09-21 회차 12 멤버, pin 09-07): hub = pin 회차 10, 현행 = 멤버 회차 12
  ② 재제출 유령 회차: run RP 는 run 21 과 같은 코호트(웹 프로젝트, 앵커 09-18 00:30)인데 원장이 모르는 앵커로 연 회차 Y(09-17 03:40,
     closed·함대 비노출)의 멤버. hub = 코호트 선택 회차 21(앵커 일치), 현행 = Y
  ③ 운영자 pin(origin 'operator', 이관 뒤 관리 API): 켜져 있어도 hub pin 규칙 유지(관리 동작 보존)
증분 경로(적재기 활성 프로필) = bulk 시드(seed-40 -v attrib_member) 행 단위 동일, 스위치를 켠 뒤 재투영(stg 절차의 본체) = 켠 bulk. 롤백 전용.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import OFF, LegacyProfile, parse_profile
from ingest.common.db import LoaderDB
from ingest.cycles.ledger.service import handle_report_publication, project_cycles
from ingest.project.apply import queries as Q
from ingest.project.apply.service import apply, reproject
from ingest.project.apply.tests.test_equivalence import TABLES, _ctx, _keys, _report
from ingest.testkit import WIPE_FACTS, WIPE_ING_DIMS, bulk_seed, diff, snapshot
from tests.support import DB_URL, needs_db

RUN5 = uuid.UUID("e0000000-0000-4000-8000-000000000005")
RUN21 = uuid.UUID("e0000000-0000-4000-8000-000000000021")
RP = uuid.UUID("e0000000-0000-4000-8000-0000000000a1")          # 재제출 run(원장 유령 회차 Y 멤버)
CY = uuid.UUID("f0000000-0000-4000-8000-0000000000a1")          # 원장 유령 회차(앵커 09-17 03:40, closed, 함대 비노출)
JP = uuid.UUID("90000000-0000-4000-8000-0000000000a1")
J17 = uuid.UUID("90000000-0000-4000-8000-000000000017")
C10, C12, C21 = (uuid.UUID(f"f0000000-0000-4000-8000-0000000000{n}") for n in ("10", "12", "21"))

SYNTH_PHANTOM = f"""
INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, closed_by, closed_at,
                       fleet_visible, origin)
VALUES ('{CY}', 'website', 'a0000000-0000-4000-8000-000000000002', '2026-09-17 03:40+00', 'scope', '2026-09-17', '2026-09-17', 'closed',
        'next_anchor', '2026-09-18 00:30+00', false, 'summary_cycles');
INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state)
VALUES ('{RP}', 'a0000000-0000-4000-8000-000000000002', '2026-09-01', 'completed', 1, '2026-09-19 01:00+00', '2026-09-18 00:30+00', 'loaded');
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ('{RP}', '{CY}', 'scope');
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{JP}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations,
                        content_hash, load_id)
SELECT '2026-09-01', '{JP}', k.answer_key, '{RP}', 'b0000000-0000-4000-8000-000000000022', 'chatgpt', 'DE', 'completed', '2026-09-19 01:30+00',
       'completed', 0, 0, '\\x03', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{JP}';
"""
OPERATOR_PIN = f"UPDATE ing.answer_anchor_pin SET origin = 'operator' WHERE job_id = '{J17}'"

_CYC_OF_RUNS = """
SELECT r.run_id, c.cycle_id, a.anchor_src, a.round_date = c.round_date AS seat_ok
  FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key JOIN ing.run r ON r.run_key = a.run_key
 WHERE r.run_id = ANY($1::uuid[])"""


async def _bulk(extra: list[str], attrib_member: bool) -> tuple[dict, dict]:
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        for s in extra:
            await c.execute(s)
        await bulk_seed(c, profile=parse_profile("resub_phantom_exclude" if attrib_member else "off"))
        snap = await snapshot(c, TABLES)
        cyc = await _cyc_of(c)
        await tr.rollback()
        return snap, cyc
    finally:
        await c.close()


async def _cyc_of(c: asyncpg.Connection) -> dict:
    """run → {(cycle_id, anchor_src)}(서빙 답변 기준). 좌석 불변식(답변 round_date = 회차 round_date)도 함께 단언한다."""
    out: dict = {}
    for r in await c.fetch(_CYC_OF_RUNS, [RUN5, RUN21, RP]):
        assert r["seat_ok"]
        out.setdefault(r["run_id"], set()).add((r["cycle_id"], r["anchor_src"]))
    return out


def test_runc_sql_marker():
    off, on = Q.runc_sql(LegacyProfile()), Q.runc_sql(LegacyProfile(resub_phantom_exclude=True))
    assert Q.RUNC.count(Q.ATTRIB_MARK) == 1 and off == Q.RUNC
    assert Q.ATTRIB_MARK not in on and on.count("/*attrib_member*/true") == 1
    assert on.replace("/*attrib_member*/true", Q.ATTRIB_MARK) == off


@needs_db
@pytest.mark.parametrize("operator", [False, True])
async def test_bulk_attribution_rule(operator):
    """손계산 기대값: 꺼짐 = hub 코호트 규칙, 켜짐 = 멤버십(운영자 pin 코호트만 pin 회차 유지). anchor_src 는 두 규칙 모두 코호트 출처."""
    extra = [SYNTH_PHANTOM] + ([OPERATOR_PIN] if operator else [])
    _, off = await _bulk(extra, False)
    _, on = await _bulk(extra, True)
    assert off[RUN5] == {(C10, 1)} and off[RP] == {(C21, 2)} and off[RUN21] == {(C21, 2)}
    assert on[RUN5] == ({(C10, 1)} if operator else {(C12, 1)})
    assert on[RP] == {(CY, 2)} and on[RUN21] == {(C21, 2)}


@needs_db
@pytest.mark.parametrize("operator", [False, True])
async def test_replay_under_switch_equals_bulk(settings, operator):
    """rd 사실 표·ing 유래 차원을 비우고 run 을 시작 순서대로 증분 적재(적재기 프로필 켜짐) → 켠 bulk 와 행 단위 동일."""
    extra = [SYNTH_PHANTOM] + ([OPERATOR_PIN] if operator else [])
    ref, _ = await _bulk(extra, True)
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "resub_phantom_exclude"}))
        db = LoaderDB(DB_URL, role="loader")
        c = await db.connect()
        try:
            tr = c.transaction()
            await tr.start()
            for s in extra:
                await c.execute(s)
            await c.execute(WIPE_FACTS)
            await c.execute(WIPE_ING_DIMS)
            ctx = await _ctx(c)
            async with c.transaction():
                await project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle")])
            for (run_id,) in await c.fetch("SELECT run_id FROM ing.run ORDER BY started_at, run_id"):
                async with c.transaction():
                    await apply(c, ctx, await _keys(c, "a.run_id = $1", run_id))
            async with c.transaction():
                await handle_report_publication(c, ctx, [r[0] for r in await c.fetch("SELECT id FROM app.report_publication")], None)
            got = await snapshot(c, TABLES)
            await tr.rollback()
        finally:
            await c.close()
    finally:
        set_settings(settings)
    d = diff(ref, got)
    assert not d, _report(d)


@needs_db
async def test_toggle_then_reproject_equals_bulk(settings):
    """stg 절차의 본체: hub 규칙으로 투영된 상태에서 적재기 프로필을 켜고 멤버십이 다른 run 만 재투영 → 켠 bulk 와 행 단위 동일.
    대상 run 은 reproject-attrib-member.py 의 선정 술어(rd.job 회차 ≠ 멤버십)로 고른다."""
    ref, _ = await _bulk([SYNTH_PHANTOM], True)
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(SYNTH_PHANTOM)
        await bulk_seed(c, profile=OFF)                        # 꺼짐(hub 규칙) 상태
        runs = [r[0] for r in await c.fetch(ATTRIB_RUNS)]
        assert sorted(runs) == sorted([RUN5, RP])
        try:
            set_settings(settings.model_copy(update={"legacy_profile": "resub_phantom_exclude"}))
            ctx = await _ctx(c)
            async with c.transaction():
                res = await reproject(c, ctx, [], extra_runs=runs)
        finally:
            set_settings(settings)
        assert res.answers == 3 and await c.fetchval(ATTRIB_LEFT) == 0            # run 5(job 17·18) + RP(JP)
        got = await snapshot(c, TABLES)
        await tr.rollback()
    finally:
        await c.close()
    d = diff(ref, got)
    assert not d, _report(d)


# reproject-attrib-member.py 와 같은 술어(시험이 대조): 투영된 답변 회차가 멤버십과 다른 run(운영자 pin 이 회차로 풀린 코호트는 RUNC 가 판정)
ATTRIB_RUNS = """
SELECT DISTINCT r.run_id FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key
  JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE j.cyc_key IS DISTINCT FROM m.cyc_key"""
ATTRIB_LEFT = """
SELECT count(*) FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key
  JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE j.cyc_key IS DISTINCT FROM m.cyc_key
   AND NOT EXISTS (SELECT 1 FROM ing.answer a JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
                    WHERE a.run_id = r.run_id AND p.origin = 'operator')"""
