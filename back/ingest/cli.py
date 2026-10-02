"""수동·백필·한 틱 실행 CLI(HTTP 수동 트리거·크론 비밀 대체, 현행 ?force=1&maxRuns app/api/cron/sync-mirror/route.ts:326 계승).

  python -m ingest.cli sync [--project <scope_project_uuid>] [--force] [--max-runs N]   pull 패스 1회
  python -m ingest.cli tick [--daily]                                                   cycles_tick 1회(daily = 파티션 선생성 포함)
  python -m ingest.cli queue [--limit N]                                                judgment_change 소비 1회
  python -m ingest.cli outbox [--limit N]                                               Scope 아웃박스 드레인 1회
  python -m ingest.cli dfs [--limit N]                                                  dfs_fetch 빠른 경로 1회
  python -m ingest.cli watch                                                            감시 1회(별도 스케줄 6시간)
  python -m ingest.cli ecat-scan [--surface ID ...|--ver N] [--full] [--chunk N] [--max-chunks N]
                                                                                        허브 추가 표면 재스캔(ing.hub_match, 재개 가능,
                                                                                        진행 로그 = stderr JSON 줄, ingest.ecat.scan)
  python -m ingest.cli frz-import-ops [--cycle UUID ...] [--limit N] [--force] [--commit]
                                                                                        운영 summary 활성 세대 → 동결 층(frz) 이관(결정 32).
                                                                                        드라이런 기본(회차마다 같은 단언 후 롤백). migrator 롤
                                                                                        (HGH_INGEST_DB_ROLE), 입력 = mig_src.frz_ops_*(export.py --frz)
출력은 요약 JSON 한 줄(비밀값·URL 없음). 종료 코드 0 성공, 1 실패 항목 있음, 2 사용법 오류.
설정은 env 만(HGH_INGEST_DB_URL·HGH_SCOPE_API_URL·HGH_SCOPE_API_KEY …, ingest.common.config). 키를 argv 로 받지 않는다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from typing import Any


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m ingest.cli", description="HMG-GEO-HUB 적재 워커 수동 실행")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync", help="pull 패스 1회")
    s.add_argument("--project", type=uuid.UUID, default=None, help="Scope 프로젝트 uuid(생략 = 로테이션 다음 1개)")
    s.add_argument("--force", action="store_true", help="R12 워터마크 무시(해시 동일이면 쓰기 0)")
    s.add_argument("--max-runs", type=int, default=None, help="이번 패스 run 상한(force 재pull 호출량 제한)")
    t = sub.add_parser("tick", help="cycles_tick 1회")
    t.add_argument("--daily", action="store_true", help="파티션 선생성 포함")
    for name in ("queue", "outbox", "dfs"):
        x = sub.add_parser(name)
        x.add_argument("--limit", type=int, default=50)
    sub.add_parser("watch", help="감시 1회")
    e = sub.add_parser("ecat-scan", help="허브 추가 표면 재스캔(생략 = 활성·초안 버전의 add 표면)")
    g = e.add_mutually_exclusive_group()
    g.add_argument("--surface", type=int, action="append", default=None, help="app.ecat_surface_def.surface_id(여러 번)")
    g.add_argument("--ver", type=int, default=None, help="이 버전의 add 표면 전부")
    e.add_argument("--full", action="store_true", help="이미 끝난 표면도 처음부터(기본 = 처음이면 전체, 아니면 따라잡기)")
    e.add_argument("--chunk", type=int, default=2000, help="트랜잭션당 답변 수")
    e.add_argument("--max-chunks", type=int, default=None, help="전체 스캔을 청크 N개 뒤 멈춘다(다시 부르면 이어받는다)")
    f = sub.add_parser("frz-import-ops", help="운영 summary 활성 세대 → frz 이관(드라이런 기본)")
    f.add_argument("--cycle", type=uuid.UUID, action="append", default=None, help="운영 cycle_id(여러 번, 생략 = 추출된 전체)")
    f.add_argument("--limit", type=int, default=None, help="회차 수 상한(앞에서부터)")
    f.add_argument("--force", action="store_true", help="같은 운영 세대가 이미 활성이어도 다시 만든다")
    f.add_argument("--commit", action="store_true", help="적재(기본 = 드라이런: 회차마다 단언 뒤 롤백)")
    return p


def _summary(obj: Any) -> Any:
    from dataclasses import asdict, is_dataclass
    if is_dataclass(obj):
        return {k: _summary(v) for k, v in asdict(obj).items()}
    if isinstance(obj, list):
        return [_summary(x) for x in obj]
    if isinstance(obj, dict):
        return {str(k): _summary(v) for k, v in obj.items()}
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


async def run(argv: list[str], *, db: Any = None, source: Any = None, dfs: Any = None, alerts: Any = None) -> tuple[int, Any]:
    """테스트는 db·source·dfs·alerts 를 주입한다. 반환 = (종료 코드, 요약)."""
    try:
        a = parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 2), None
    from ingest.common.db import LoaderDB
    db = db or LoaderDB.from_settings()
    if a.cmd == "sync":
        if a.max_runs is not None and a.max_runs < 1:
            return 2, {"error": "--max-runs 는 1 이상"}
        from ingest.pull.sync.service import run_pass
        from ingest.pull.sync.source import source_from_settings
        rep = await run_pass(db, source or source_from_settings(), project=a.project, force=a.force, max_runs=a.max_runs, alerts=alerts)
        bad = rep.error is not None or any(r.status == "failed" for r in rep.runs)
        return (1 if bad else 0), _summary(rep)
    if a.cmd == "tick":
        from ingest.cycles.workers.service import cycles_tick
        return 0, _summary(await cycles_tick(db, daily=a.daily))
    if a.cmd == "queue":
        from ingest.cycles.workers.service import run_queue
        out = await run_queue(db, limit=a.limit)
        return (1 if any(o.status == "failed" for o in out) else 0), _summary(out)
    if a.cmd == "outbox":
        from ingest.cycles.workers.service import run_outbox
        from ingest.pull.sync.source import source_from_settings
        out = await run_outbox(db, source or source_from_settings(), limit=a.limit)
        return (1 if any(o.status == "failed" for o in out) else 0), _summary(out)
    if a.cmd == "dfs":
        from ingest.cycles.workers.service import run_dfs
        if dfs is None:
            from ingest.common.config import get_ingest_settings
            from ingest.cycles.workers.dfs import HttpDfsSource
            s = get_ingest_settings()
            if not (s.dfs_api_url and s.dfs_login and s.dfs_password):
                return 2, {"error": "HGH_DFS_API_URL·HGH_DFS_LOGIN·HGH_DFS_PASSWORD 미설정"}
            dfs = HttpDfsSource(s.dfs_api_url, s.dfs_login.get_secret_value(), s.dfs_password.get_secret_value())
        out = await run_dfs(db, dfs, limit=a.limit)
        return (1 if any(o.status == "failed" for o in out) else 0), _summary(out)
    if a.cmd == "ecat-scan":
        from ingest.ecat.scan import ScanInputError, scan
        try:
            rep = await scan(db, surface_ids=a.surface, ver=a.ver, full=a.full, chunk=a.chunk, max_chunks=a.max_chunks,
                             on_progress=lambda p: print(json.dumps(p, ensure_ascii=False, default=str), file=sys.stderr, flush=True))
        except ScanInputError as e:
            return 2, {"error": str(e)}
        return 0, _summary(rep)
    if a.cmd == "frz-import-ops":
        if a.limit is not None and a.limit < 1:
            return 2, {"error": "--limit 는 1 이상"}
        from ingest.frz.ops_import import run as frz_run
        async with db.session() as conn:
            rep = await frz_run(conn, cycles=a.cycle, commit=a.commit, force=a.force, limit=a.limit)
        bad = [c for c in rep.cycles if c["status"] not in ("committed", "dry_run_ok", "already_current")]
        return (1 if bad else 0), {**rep.summary(), "failed": bad[:50]}
    from ingest.cycles.watch.service import watch
    rep = await watch(db, alerts=alerts)
    return (1 if rep.severity >= 2 else 0), {"severity": rep.severity, **_summary(rep)}


def main(argv: list[str] | None = None) -> int:
    from ingest.common.config import install_worker_settings

    install_worker_settings()                  # core 설정을 워커 용도로(API 인증 키 필수 검증 없음)
    code, summary = asyncio.run(run(list(sys.argv[1:] if argv is None else argv)))
    if summary is not None:
        print(json.dumps(summary, ensure_ascii=False, default=str))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
