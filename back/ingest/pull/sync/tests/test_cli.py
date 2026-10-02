"""CLI(python -m ingest.cli …): 인자 해석·종료 코드·요약 JSON. 원천·DB 는 주입(가짜 Scope, 일회 DB)."""
from __future__ import annotations

import json

from ingest import cli
from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.workers.dfs import FakeDfsSource
from tests.support import needs_db

from .test_pull import R10, ROOT, _source


async def test_cli_usage_errors():
    assert (await cli.run([]))[0] == 2
    assert (await cli.run(["sync", "--project", "not-a-uuid"]))[0] == 2
    assert (await cli.run(["nope"]))[0] == 2


@needs_db
async def test_cli_sync_force_max_runs_and_other_commands(fresh_db):
    db = LoaderDB(fresh_db, role="loader")
    src = _source()
    code, summary = await cli.run(["sync", "--project", ROOT], db=db, source=src)
    assert code == 0 and summary["error"] is None
    assert [(r["run_id"], r["status"]) for r in summary["runs"]] == [(R10, "committed")]
    json.dumps(summary)                                                    # 요약은 JSON 직렬화 가능(비밀값 없음)
    code, summary = await cli.run(["sync", "--project", ROOT, "--force", "--max-runs", "1"], db=db, source=src)
    assert code == 0 and len(summary["runs"]) == 1                        # force 재pull 호출량 상한
    assert (await cli.run(["sync", "--max-runs", "0"], db=db, source=src))[0] == 2
    code, summary = await cli.run(["tick", "--daily"], db=db)
    assert code == 0 and summary["leaves_created"] >= 0
    code, summary = await cli.run(["queue", "--limit", "5"], db=db)
    assert code == 0 and isinstance(summary, list)
    code, summary = await cli.run(["dfs"], db=db, dfs=FakeDfsSource())
    assert code == 0 and summary == []
    sink = MemoryAlertSink()
    code, summary = await cli.run(["watch"], db=db, alerts=sink)
    assert summary["severity"] in (0, 1, 2) and code == (1 if summary["severity"] >= 2 else 0)
