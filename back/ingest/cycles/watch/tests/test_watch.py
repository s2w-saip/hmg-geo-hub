"""감시 태스크: 하트비트·적재 적체·노출 지체·발행 대기·실패 적재·큐 이상 → 등급·목적지별 경보. 일회 DB(fresh_db)."""
from __future__ import annotations

import datetime as dt

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.watch.service import watch
from tests.support import needs_db

NOW = dt.datetime(2026, 9, 28, 6, 0, tzinfo=dt.UTC)


async def _x(url: str, sql: str) -> None:
    c = await asyncpg.connect(url)
    try:
        await c.execute(sql)
    finally:
        await c.close()


@needs_db
async def test_watch_findings_and_sinks(fresh_db):
    await _x(fresh_db, f"""
      UPDATE ing.sync_cursor SET last_attempt_at = '{(NOW - dt.timedelta(hours=3)).isoformat()}';
      UPDATE ing.run SET sync_state = 'blocked' WHERE run_id = 'e0000000-0000-4000-8000-000000000002';
      UPDATE ing.run SET analysis_pending = 2, analysis_recheck_until = '2026-09-20' WHERE run_id = 'e0000000-0000-4000-8000-000000000001';
      UPDATE ing.cycle SET status = 'closed', closed_by = 'complete', closed_at = '2026-09-27 00:00+00' WHERE cyc_key = 12;
      INSERT INTO ing.load (kind, rule_ver, status, started_at) SELECT 'run', 1, 'failed', '{(NOW - dt.timedelta(hours=1)).isoformat()}' FROM generate_series(1, 3);
      SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', false);
      INSERT INTO app.judgment_change (kind, requested_by, requested_at, status) VALUES
        ('owned_base', app.actor(), '{(NOW - dt.timedelta(hours=2)).isoformat()}', 'failed'),
        ('hidden_market', app.actor(), '{(NOW - dt.timedelta(hours=2)).isoformat()}', 'pending');""")
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink)
    got = {(f.check, f.severity, f.sink) for f in rep.findings}
    assert ("heartbeat", 2, "live") in got
    assert ("ingest_backlog", 2, "live") in got                                   # blocked 있음 → 긴급
    assert ("publish_backlog", 1, "code") in got                                  # 회차 12 닫힌 뒤 6시간 넘게 미발행
    assert ("load_failures", 1, "code") in got
    assert ("queue", 1, "code") in got and ("queue", 1, "live") in got
    # 노출 지체: 회차 12(09-21 + 2일 + 48h = 09-24 15:00Z 경과, 미발행) → 글로벌 1회차
    vl = [f for f in rep.findings if f.check == "view_lag"]
    assert [(f.detail["surface"], f.detail["cycles"]) for f in vl] == [("global", 1)]
    assert rep.severity == 2 and len(sink.sent) == len(rep.findings)
    assert set(rep.checked) == {"heartbeat", "ingest_backlog", "view_lag", "publish_backlog", "load_failures", "queue", "projection_gap",
                                "publish_gate", "review_fill"}
    assert sink.severities == [f.severity for f in rep.findings]                 # 등급이 싱크(Slack 색)까지 간다


@needs_db
async def test_watch_clean_state_is_quiet(fresh_db):
    await _x(fresh_db, f"""UPDATE ing.sync_cursor SET last_attempt_at = '{(NOW - dt.timedelta(minutes=5)).isoformat()}';
                           UPDATE app.judgment_change SET status = 'applied' WHERE status = 'pending';
                           UPDATE ing.cycle SET status = 'published', closed_by = 'next_anchor', closed_at = '2026-09-28 00:00+00',
                                  view_anchor_at = '2026-09-22 15:00+00' WHERE cyc_key = 12""")
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink)
    assert rep.findings == [] and rep.severity == 0 and sink.sent == []
