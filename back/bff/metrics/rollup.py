"""The rollup job (SSOT shared/project-architecture.md 5 · 6, T5.3, D-18): for each surface whose live snapshot or definition version moved,
run the first screens' builders (first_screens). What they count goes to Gold's metric rows, round by round (metrics.gold_rows; a round
already current is not counted again), and the lists they read whole to gold.first_screen_read. Then the cache DB rows of other snapshots
go. Run by manage.py rollup, with the rollup role's connection; the API only reads what it wrote. A read that fails is kept as failed:
until a later run succeeds, that value is counted at query time as the last resort (serving)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time

# Before bff's modules read them: a rollup counts everything once, without the limits of a page's read.
os.environ["HGH_SCREEN_READ_TIMEOUT_MS"] = "600000"
os.environ["HGH_GOLD_STATEMENT_TIMEOUT_MS"] = "600000"
os.environ["HGH_GOLD_COMMAND_TIMEOUT_S"] = "620"
os.environ["HGH_GOLD_IDLE_TX_TIMEOUT_MS"] = "660000"
os.environ["HGH_SILVER_STATEMENT_TIMEOUT_MS"] = "600000"
os.environ["HGH_SILVER_COMMAND_TIMEOUT_S"] = "620"

import asyncpg  # noqa: E402
from starlette.datastructures import QueryParams  # noqa: E402

from bff import api, screens  # noqa: E402
from bff.app import app  # noqa: E402
from bff.gold_reader.context import Context  # noqa: E402
from bff.gold_reader.db import connection  # noqa: E402
from bff.hub_stores import cache_db  # noqa: E402
from bff.metrics import compute, first_screens, gold_rows, serving  # noqa: E402
from bff.metrics.catalog import DEFINITION_VERSION  # noqa: E402

log = logging.getLogger("hgh.rollup")

SURFACES = ("global", "website", "project")
RUN_LOCK = 617427431      # one rollup at a time
PROJECTS_AT_ONCE = 4
UPSERT = """INSERT INTO gold.first_screen_read(read_key,surface,path,query,snapshot_id,definition_version,result,error)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    ON CONFLICT(read_key) DO UPDATE SET surface=EXCLUDED.surface,snapshot_id=EXCLUDED.snapshot_id,definition_version=EXCLUDED.definition_version,
        result=EXCLUDED.result,error=EXCLUDED.error,computed_at=now()"""


async def project_ids() -> list[str]:
    """The ids the project pages use, read past Gold and the cache: an older run's kept list is not ready by now."""
    return [str(p["id"]) for p in (await api.read("gold/projects", api.query()))["data"]["items"]]


async def _build(name: str, q: dict[str, str], problems: list[str]) -> None:
    """One builder; a part that fails is recorded by its read and the run goes on."""
    try:
        await screens.build(name, QueryParams(q))
    except Exception as error:  # noqa: BLE001 - one screen part, recorded; the others are still computed
        problems.append(f"{name} {q}: {type(error).__name__}: {getattr(error, 'detail', None) or error}"[:300])


def _keeper(writer: asyncpg.Connection, snapshots: dict[str, str], lock: asyncio.Lock):
    """Writes a read with its own surface's snapshot: a builder of one surface may read another's (the filter options of Global)."""

    async def keep(surface: str, path: str, query: str, text: str | None, error: str | None) -> None:
        async with lock:   # one connection
            await writer.execute(UPSERT, serving.read_key(f"{path}?{query}"), surface, path, query, snapshots[surface], DEFINITION_VERSION, text, error)
    return keep


async def _surface(writer: asyncpg.Connection, surface: str, snapshots: dict[str, str], ids: list[str]) -> dict:
    snapshot = snapshots[surface]
    run_id = await writer.fetchval("INSERT INTO gold.rollup_run(surface,snapshot_id,definition_version) VALUES($1,$2,$3) RETURNING run_id",
                                   surface, snapshot, DEFINITION_VERSION)
    rows = gold_rows.RowRecorder(writer)
    recording = serving.Recording(_keeper(writer, snapshots, rows.lock))   # one connection, one lock
    problems: list[str] = []
    started = time.perf_counter()
    token, rows_token = serving.start_recording(recording), gold_rows.start_recording(rows)
    try:
        calls = list(first_screens.calls_of(surface, ids))
        if surface == "project":
            gate = asyncio.Semaphore(PROJECTS_AT_ONCE)

            async def bounded(name: str, q: dict[str, str]) -> None:
                async with gate:
                    await _build(name, q, problems)
            await asyncio.gather(*(bounded(name, q) for name, q in calls))
        else:
            for name, q in calls:
                await _build(name, q, problems)
        if surface == "global":
            await _acr_rows(problems)
    finally:
        gold_rows.stop_recording(rows_token)
        serving.stop_recording(token)
    failed = recording.failed + rows.failed
    status = "failed" if failed or problems else "done"   # a run with a problem runs again next time
    await writer.execute("UPDATE gold.rollup_run SET finished_at=now(),status=$2,reads=$3,failed=$4,note=$5 WHERE run_id=$1", run_id, status,
                         len(recording.seen), failed, "\n".join(problems[:20]) or None)
    return {"surface": surface, "snapshot": snapshot, "status": status, "reads": len(recording.seen), "rows_written": rows.written, "failed": failed, "builders": len(calls),
            "seconds": round(time.perf_counter() - started, 1), "problems": problems[:5]}


async def _acr_rows(problems: list[str]) -> None:
    """The ACR metrics' rows of every round, for SQL review and the metrics API. The ACR screen's sheets are lists, kept whole."""
    try:
        async with connection() as conn:
            ctx = await Context.create(conn, QueryParams({"surface": "global"}))
            for day in ctx.dates:
                ctx.selected_dates = [day]
                source = gold_rows.metric_source(ctx)
                await compute.acr_values(source)
                await source.acr_model_counts()
                await source.acr_duel_counts()
    except Exception as error:  # noqa: BLE001 - recorded; the screens' values are done
        problems.append(f"acr rows: {type(error).__name__}: {error}"[:300])


async def _refresh_left_behind(writer: asyncpg.Connection, snapshots: dict[str, str]) -> int:
    """A read of a surface that did not run, kept by a builder of one that did not move either: it would stay late, so it is read now."""
    rows = await writer.fetch("SELECT surface,path,query,snapshot_id,definition_version FROM gold.first_screen_read")
    # the reads that now come from metric rows have no kept answer
    await writer.execute("DELETE FROM gold.first_screen_read WHERE path=ANY($1::text[])", list(serving.ROW_READS))
    rows = [r for r in rows if r["path"] not in serving.ROW_READS]
    late = [r for r in rows if (r["snapshot_id"], r["definition_version"]) != (snapshots[r["surface"]], DEFINITION_VERSION)]
    token = serving.start_recording(serving.Recording(_keeper(writer, snapshots, asyncio.Lock())))
    try:
        for r in late:
            try:
                await api.get(r["path"], QueryParams(r["query"]).multi_items())
            except Exception:  # noqa: BLE001 - kept as failed by the recording
                log.warning("Left-behind read failed: %s", r["path"], exc_info=True)
    finally:
        serving.stop_recording(token)
    return len(late)


async def main(config: dict) -> dict:
    """config: dsn (the rollup role), surfaces (default all), force (run although nothing moved)."""
    out = []
    async with app.router.lifespan_context(app):
        writer = await asyncpg.connect(config["dsn"], statement_cache_size=0, server_settings={"application_name": "hmg-geo-hub-rollup"})
        try:
            if not await writer.fetchval("SELECT pg_try_advisory_lock($1)", RUN_LOCK):
                return {"skipped": "another rollup is running"}
            job_started = await writer.fetchval("SELECT now()")
            snapshots = {surface: await serving.current_snapshot(surface) for surface in SURFACES}
            ran = []
            for surface in config.get("surfaces") or SURFACES:
                last = await writer.fetchrow("""SELECT snapshot_id,definition_version,status FROM gold.rollup_run
                    WHERE surface=$1 AND status<>'running' ORDER BY run_id DESC LIMIT 1""", surface)
                if (not config.get("force") and last is not None and last["status"] == "done"
                        and (last["snapshot_id"], last["definition_version"]) == (snapshots[surface], DEFINITION_VERSION)):
                    out.append({"surface": surface, "snapshot": snapshots[surface], "status": "unchanged"})
                    continue
                out.append(await _surface(writer, surface, snapshots, await project_ids() if surface == "project" else []))
                ran.append(surface)
            # the reads no screen makes any more: of a surface that ran, not written by this job
            removed = await writer.execute("DELETE FROM gold.first_screen_read WHERE surface=ANY($1::text[]) AND computed_at<$2", ran, job_started)
            await writer.execute("DELETE FROM gold.metric_row WHERE definition_version<>$1", DEFINITION_VERSION)
            await writer.execute("DELETE FROM gold.metric_call WHERE definition_version<>$1", DEFINITION_VERSION)
            refreshed = await _refresh_left_behind(writer, snapshots)
            purged = await cache_db.purge_other_snapshots(list(snapshots.values()))
            return {"runs": out, "removed": int(removed.split()[-1]), "refreshed": refreshed, "cache_rows_purged": purged, "definition_version": DEFINITION_VERSION}
        finally:
            await writer.close()


def run(config: dict) -> None:
    print(json.dumps(asyncio.run(main(config)), ensure_ascii=False))
