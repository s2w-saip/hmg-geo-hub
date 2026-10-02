"""발행 게이트 커밋 경로(일회 DB): 틱이 닫은 회차의 게이트 blocked → 감시 publish_gate 알림(회차당 1회, 빠진 유닛 분포·표본) →
운영 요청 큐(cycle_admin seal·force_publish, 사유 없는 요청은 계약 위반 failed) → 강제 발행. Slack 실제 발송 없음(MemoryAlertSink)."""
from __future__ import annotations

import datetime as dt
import uuid

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoadContext, LoaderDB, current_rule_ver
from ingest.cycles.ledger import service as L
from ingest.cycles.ledger.tests.gate_support import ROOT, add_answer, sp
from ingest.cycles.watch.service import watch
from ingest.cycles.workers.service import cycles_tick, run_queue
from tests.support import needs_db

NOW = dt.datetime(2026, 10, 10, 6, 0, tzinfo=dt.UTC)
ACTOR = "5eed0000-0000-4000-8000-000000000001"
C12 = uuid.UUID("f0000000-0000-4000-8000-000000000012")
RUN = uuid.UUID("e3000000-0000-4000-8000-000000000001")


async def _q(url: str, sql: str, *a):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *a)
    finally:
        await c.close()


async def _setup(url: str) -> uuid.UUID:
    """카탈로그(루트 10유닛, gate_support 와 같은 준비)를 커밋하고, 새 글로벌 회차(09-28)를 열어 10유닛 중 9개만 완료로 적재한다."""
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            await c.execute("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE status = 'pending'")
            await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true), set_config('app.actor_type', 'system', true)")
            await c.execute("UPDATE app.prompt SET created_at = '2026-09-01' WHERE project_id = 'c0000000-0000-4000-8000-000000000001'")
            await c.execute("UPDATE ing.sync_cursor SET regions = '{US}' WHERE scope_project_id = $1", ROOT)
            await c.execute("SET LOCAL ROLE loader")
            rv = await current_rule_ver(c)
            lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver) VALUES ('cycle_admin', $1) RETURNING load_id", rv)
            ctx = LoadContext(load_id=int(lid), kind="cycle_admin", rule_ver=rv)
            await c.execute("""INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at)
                               VALUES ($1, $2, '2026-09-01', 'completed', 10, '2026-09-28 00:30+00', '2026-09-28 00:30+00')""", RUN, ROOT)
            await L.attribute(c, ctx, [RUN])
            units = sorted((sp(n), t) for n in (1, 2, 3, 4, 6) for t in ("chatgpt", "gemini"))
            for p, t in units[:-1]:
                await add_answer(c, RUN, p, t, "US")
            return await c.fetchval("SELECT cycle_id FROM ing.cycle_run WHERE run_id = $1", RUN)
    finally:
        await c.close()


@needs_db
async def test_gate_alert_once_then_queue_seal_and_force(fresh_db):
    cid = await _setup(fresh_db)
    db = LoaderDB(fresh_db, role="loader")
    rep = await cycles_tick(db, now=NOW)
    # 새 회차: 재확인 창(3일) 밖 → 닫힘, 9/10 → blocked. 이관 회차 12(열려 있었다): backfill 계획 10유닛(카탈로그 등록 09-01 < 앵커 09-21),
    # 다음 앵커(09-28) ∧ 멤버 → 닫힘, 완료 2/10 → blocked. 둘 다 quiet 아님(계획은 닫히기 전에 만들었다)
    f31 = uuid.UUID("f0000000-0000-4000-8000-000000000031")
    assert cid in rep.closed and C12 in rep.closed and C12 in rep.planned
    assert rep.published == [f31]                                  # project 표면(가상 회차 31)만 현행처럼 닫히자마자 발행
    g = {r["cycle_id"]: r for r in await _q(fresh_db, "SELECT * FROM ing.cycle_gate WHERE cycle_id = ANY($1::uuid[])", [cid, C12])}
    assert (g[cid]["plan_source"], g[cid]["active_units"], g[cid]["done_units"], g[cid]["verdict"]) == ("open", 10, 9, "blocked")
    assert (g[C12]["plan_source"], g[C12]["quiet"], g[C12]["verdict"]) == ("backfill", False, "blocked")

    sink = MemoryAlertSink()
    wr = await watch(db, now=NOW, alerts=sink, checks=["publish_gate", "publish_backlog"])
    pg = [f for f in wr.findings if f.check == "publish_gate"]
    assert len(pg) == 1 and (pg[0].severity, pg[0].sink) == (2, "live")                  # 글로벌 포함 → 긴급
    assert [f.check for f in wr.findings] == ["publish_gate"]                              # blocked 회차는 발행 대기(code)로 겹쳐 알리지 않는다
    by = {x["cycle_id"]: x for x in pg[0].detail["cycles"]}
    assert set(by) == {str(cid), str(C12)}
    m = by[str(cid)]["missing"]
    assert m["units"] == 1 and m["by_engine_region"] == [{"target": "gemini", "region": "US", "units": 1}]
    assert m["sample"] == [{"prompt_id": str(sp(6)), "target": "gemini", "region": "US"}]
    assert "봉인" in pg[0].message and "강제 발행" in pg[0].message and len(sink.sent) == 1
    # 회차당 1회: 두 번째 실행은 새 알림 없음(미해결 수만 보고)
    wr2 = await watch(db, now=NOW + dt.timedelta(hours=6), alerts=MemoryAlertSink(), checks=["publish_gate"])
    assert wr2.findings == [] and wr2.info["publish_gate"] == {"checked": True, "new": 0, "unresolved": 2}

    # 운영 요청: 새 회차 강제 발행(사유 없음 → 계약 위반 failed, 사유 있음 → 발행), 회차 12 봉인(게이트 pass, 분석 비율 0 → 발행 안 함)
    c = await asyncpg.connect(fresh_db)
    try:
        await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', false)")
        await c.execute("""INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by) VALUES
            ('cycle_admin', ARRAY[$1::uuid], jsonb_build_object('cycle_id', $1::text, 'op', 'force_publish'), app.actor()),
            ('cycle_admin', ARRAY[$1::uuid], jsonb_build_object('cycle_id', $1::text, 'op', 'force_publish', 'reason', '고객 보고 일정'), app.actor()),
            ('cycle_admin', ARRAY[$2::uuid], jsonb_build_object('cycle_id', $2::text, 'op', 'seal', 'reason', '발송 누락 확인'), app.actor())""",
                        str(cid), str(C12))
    finally:
        await c.close()
    out = await run_queue(db, kinds=("cycle_admin",))
    assert [o.status for o in out] == ["failed", "applied", "applied"], out
    st = {r["cycle_id"]: r for r in await _q(fresh_db, """
        SELECT c.cycle_id, c.status, g.verdict, g.forced_reason, g.forced_by, g.force_change_id, g.sealed_units, g.missing_units
          FROM ing.cycle c JOIN ing.cycle_gate g USING (cycle_id) WHERE c.cycle_id = ANY($1::uuid[])""", [cid, C12])}
    assert (st[cid]["status"], st[cid]["verdict"], st[cid]["forced_reason"], str(st[cid]["forced_by"])) == ("published", "forced", "고객 보고 일정", ACTOR)
    assert st[cid]["force_change_id"] == out[1].change_id
    assert (st[C12]["status"], st[C12]["verdict"], st[C12]["sealed_units"], st[C12]["missing_units"]) == ("closed", "pass", 8, 0)
    assert tuple((await _q(fresh_db, "SELECT status, servable FROM rd.cycle WHERE cycle_id = $1", cid))[0]) == (2, True)
