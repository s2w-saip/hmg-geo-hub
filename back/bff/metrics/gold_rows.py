"""Adapter ③: Gold's metric rows (gold.metric_row, D-18), the first screens' values, one row per dimension combination of a round, with its
base counts and metric values (SSOT shared/project-architecture.md 6: 필터 없는 초기 화면의 지표 값을 회차마다). It answers a data source's
calls from the rows the rollup job wrote, so a first screen and a filtered read are one calculation on another source.

A read with a filter (LIVE_PARAMS) is counted from the snapshot and cached (serving). Otherwise each call:
- was never computed for this scope: counted from the snapshot, as a filtered read;
- is current for the rounds asked: answered from the rows;
- is late for a round (another snapshot or definition version, or failed): that value is not shown, never counted at query time. A
  read of one round answers 503; a trend leaves the round out as a gap (ctx.late_rounds), so a republished old round blanks only itself.

The rollup job records through RecordingSource: what a builder asks is counted, split by round and written; a round that is already
current is not counted again."""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from contextvars import ContextVar, Token
from datetime import date
from typing import Any

from fastapi import HTTPException

from bff.gold_reader.context import Context, values
from bff.hub_stores import metrics_db
from bff.metrics import compute
from bff.metrics.catalog import CITATION_MONITORING, DEFINITION_VERSION, MONITORING, REPRESENTATIVE, URL_MEASURED
from bff.metrics.gold_current import GoldCurrentSource

#: a condition the first screens never set: the read is a filtered one, counted from the snapshot and cached (SSOT)
LIVE_PARAMS = ("country", "lang", "from", "to", "funnel", "list_type", "depth1", "depth2", "depth3", "depth4", "source", "mention_brand", "mention_own")
#: the first screens' own conditions, part of a row's scope
SCOPE_PARAMS = ("engine", "brand_presence")
#: calls whose rows carry their round without a round group
ROUND_COLUMN = frozenset({"source_round_counts"})
ROUND_GROUP = "round_date"
SCALAR = "_value"

_recorder: ContextVar[RowRecorder | None] = ContextVar("hgh_row_recorder", default=None)
_usage: ContextVar[dict | None] = ContextVar("hgh_live_usage", default=None)


def track_usage(usage: dict) -> Token:
    """serving: `usage["live"]` turns True when a call of this read was counted from the snapshot, so its answer is cached."""
    return _usage.set(usage)


def stop_tracking(token: Token) -> None:
    _usage.reset(token)


def _mark_live() -> None:
    usage = _usage.get()
    if usage is not None:
        usage["live"] = True


def scope_of(ctx: Context) -> str | None:
    """The rows' scope of a read, None for a filtered read."""
    q = ctx.q
    if any(q.get(k) for k in LIVE_PARAMS) or any(k.startswith("cf.") for k in q):
        return None
    parts = [f"bits={ctx.bits}"]
    for key in SCOPE_PARAMS:
        picked = sorted({v.lower() for v in values(q, key)})
        if picked:
            parts.append(f"{key}={','.join(picked)}")
    return ";".join(parts)


def round_snapshot(ctx: Context, day: date) -> str:
    """A round's snapshot until Silver's pointer (T9): the Gold builds that publish it. A new build of one round moves that round only."""
    builds = sorted(b for b, d in ctx.build_dates.items() if d == day)
    # website's 자사 URL counts depend on what the sites registered: a change makes every round of it late until the rollup counts it again
    registered = ctx.populations.registered_digest if ctx.sf == 2 else ""
    return "gold-builds:" + hashlib.sha256(f"{','.join(map(str, builds))}:{registered}".encode()).hexdigest()[:16]


def call_key(name: str, args: Sequence, kwargs: Mapping[str, Any]) -> str:
    """The call a row answers. brand_keys is no part of it: every brand is kept, and the pick is applied when reading."""
    parts = [name]
    for a in args:
        parts.append(",".join(map(str, a)) if isinstance(a, (list, tuple)) else str(a))
    for k, v in sorted(kwargs.items()):
        if k != "brand_keys" and v not in (False, None, (), []):
            parts.append(f"{k}={','.join(map(str, v)) if isinstance(v, (list, tuple)) else v}")
    return "|".join(parts)


def _by_round(name: str, args: Sequence, kwargs: Mapping[str, Any]) -> bool:
    group = kwargs.get("group") or next((a for a in args if isinstance(a, (list, tuple))), ())
    return name in ROUND_COLUMN or ROUND_GROUP in group


def _project(ctx: Context) -> int:
    return ctx.project_key or 0


def _row(stored: Mapping[str, Any], *, with_round: bool) -> dict:
    row = {**stored["dims"], **stored["counts"]}
    if with_round:
        row[ROUND_GROUP] = stored["round_date"]
    return row


def _assemble(stored: list[dict], kwargs: Mapping[str, Any], with_round: bool, several_rounds: bool) -> Any:
    rows = [_row(r, with_round=with_round) for r in stored]
    if len(rows) == 1 and SCALAR in rows[0]:
        return rows[0][SCALAR]
    picked = kwargs.get("brand_keys")
    if picked:
        wanted = {str(k) for k in picked}
        rows = [r for r in rows if str(r.get("brand_key")) in wanted]
    if several_rounds and rows and "mentions" in rows[0]:
        rows.sort(key=lambda r: (-(r["mentions"] or 0), r.get("name") or ""))
    return rows


class GoldRowsSource:
    """Answers a data source's calls from Gold's rows; `live` counts what was never computed for this scope."""

    def __init__(self, live: GoldCurrentSource, scope: str) -> None:
        self.live, self.scope = live, scope
        self.ctx = live.ctx
        self.surface, self.snapshot_id = live.surface, live.snapshot_id

    def for_rounds(self, rounds: Sequence[date]) -> GoldRowsSource:
        return type(self)(self.live.for_rounds(rounds), self.scope)

    def __getattr__(self, name: str) -> Callable:
        method = getattr(self.live, name)

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await self._answer(name, method, args, kwargs)
        return call

    def _current(self, day: date, state: Mapping[str, Any] | None) -> bool:
        return (state is not None and state["error"] is None and state["definition_version"] == DEFINITION_VERSION
                and state["snapshot_id"] == round_snapshot(self.ctx, day))

    async def _answer(self, name: str, method: Callable, args: tuple, kwargs: dict) -> Any:
        rounds = list(self.ctx.selected_dates)
        by_round = _by_round(name, args, kwargs)
        if not rounds or (len(rounds) > 1 and not by_round):   # no round, or a sum over rounds: no row holds it
            _mark_live()
            await self.ctx.load_catalog()
            return await method(*args, **kwargs)
        call = call_key(name, args, kwargs)
        states = await metrics_db.call_states(self.surface, _project(self.ctx), call, self.scope)
        if not states:   # never computed for this scope, or the store cannot be read
            _mark_live()
            await self.ctx.load_catalog()
            return await method(*args, **kwargs)
        ready = [d for d in rounds if self._current(d, states.get(d))]
        if len(ready) < len(rounds) and (not by_round or not ready):
            raise HTTPException(503, "The pre-computed values of this screen are not ready")
        self.ctx.late_rounds = {*self.ctx.late_rounds, *(d for d in rounds if d not in ready)}
        stored = await metrics_db.metric_rows(self.surface, _project(self.ctx), call, self.scope, ready)
        return _assemble(stored, kwargs, by_round, len(ready) > 1)


class RowRecorder:
    """One rollup's writes: rows in a transaction per call and round, on the job's one connection."""

    def __init__(self, writer: Any) -> None:
        self.writer = writer
        self.lock = asyncio.Lock()
        self.calls: dict[tuple, asyncio.Lock] = {}
        self.failed = 0
        self.written = 0

    def call_lock(self, key: tuple) -> asyncio.Lock:
        return self.calls.setdefault(key, asyncio.Lock())

    async def states(self, surface: str, project: int, call: str, scope: str) -> dict[date, dict]:
        async with self.lock:
            rows = await self.writer.fetch("""SELECT round_date,snapshot_id,definition_version,error FROM gold.metric_call
                WHERE surface=$1 AND project_key=$2 AND call=$3 AND scope=$4""", surface, project, call, scope)
        return {r["round_date"]: dict(r) for r in rows}

    async def rows(self, surface: str, project: int, call: str, scope: str, rounds: list[date]) -> list[dict]:
        async with self.lock:
            rows = await self.writer.fetch("""SELECT round_date,dims::text AS dims,counts::text AS counts FROM gold.metric_row
                WHERE surface=$1 AND project_key=$2 AND call=$3 AND scope=$4 AND round_date=ANY($5::date[]) ORDER BY round_date,ord""",
                surface, project, call, scope, rounds)
        return [{"round_date": r["round_date"], "dims": json.loads(r["dims"]), "counts": json.loads(r["counts"])} for r in rows]

    async def write(self, surface: str, project: int, call: str, scope: str, day: date, snapshot: str, rows: list[tuple], error: str | None = None) -> None:
        async with self.lock, self.writer.transaction():
            await self.writer.execute("DELETE FROM gold.metric_row WHERE surface=$1 AND project_key=$2 AND round_date=$3 AND call=$4 AND scope=$5",
                                      surface, project, day, call, scope)
            if rows:
                await self.writer.copy_records_to_table(
                    "metric_row", schema_name="gold",
                    columns=("surface", "project_key", "round_date", "call", "scope", "ord", "dims", "counts", "metrics", "snapshot_id", "definition_version"),
                    records=[(surface, project, day, call, scope, i, dims, counts, metrics, snapshot, DEFINITION_VERSION)
                             for i, (dims, counts, metrics) in enumerate(rows)])
            await self.writer.execute("""INSERT INTO gold.metric_call(surface,project_key,round_date,call,scope,snapshot_id,definition_version,row_count,error)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT(surface,project_key,round_date,call,scope) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
                    definition_version=EXCLUDED.definition_version,row_count=EXCLUDED.row_count,error=EXCLUDED.error,computed_at=now()""",
                surface, project, day, call, scope, snapshot, DEFINITION_VERSION, len(rows), error)
        self.written += len(rows)


def _dims_and_counts(row: Mapping[str, Any], group: Sequence[str]) -> tuple[dict, dict]:
    dims = {k: row[k] for k in group if k != ROUND_GROUP and k in row}
    return dims, {k: v for k, v in row.items() if k != ROUND_GROUP and k not in dims}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


class RecordingSource(GoldRowsSource):
    """The rollup's data source: what a builder asks is counted from the snapshot for the rounds not yet current, written, and read back."""

    async def _answer(self, name: str, method: Callable, args: tuple, kwargs: dict) -> Any:
        rounds = list(self.ctx.selected_dates)
        by_round = _by_round(name, args, kwargs)
        await self.ctx.load_catalog()
        if not rounds or (len(rounds) > 1 and not by_round):
            return await method(*args, **kwargs)
        recorder = _recorder.get()
        project, call = _project(self.ctx), call_key(name, args, kwargs)
        async with recorder.call_lock((self.surface, project, call, self.scope)):
            states = await recorder.states(self.surface, project, call, self.scope)
            stale = [d for d in rounds if not self._current(d, states.get(d))]
            if stale:
                await self._count(recorder, name, call, args, kwargs, stale, by_round, project)
            stored = await recorder.rows(self.surface, project, call, self.scope, rounds)
        return _assemble(stored, kwargs, by_round, len(rounds) > 1)

    async def _count(self, recorder: RowRecorder, name: str, call: str, args: tuple, kwargs: dict, stale: list[date], by_round: bool, project: int) -> None:
        live = self.live.for_rounds(stale)
        count_kwargs = {k: v for k, v in kwargs.items() if k != "brand_keys"}
        try:
            result = await getattr(live, name)(*args, **count_kwargs)
        except Exception as error:
            recorder.failed += 1
            for day in stale:
                await recorder.write(self.surface, project, call, self.scope, day, round_snapshot(self.ctx, day), [], f"{type(error).__name__}: {getattr(error, 'detail', error)}"[:300])
            raise
        group = kwargs.get("group") or next((a for a in args if isinstance(a, (list, tuple))), ())
        rows = result if isinstance(result, list) else [{SCALAR: result}]
        by_day: dict[date, list[dict]] = {d: [] for d in stale}
        for row in rows:
            by_day[row[ROUND_GROUP] if by_round else stale[0]].append(row)
        for day, day_rows in by_day.items():
            metrics = await row_metrics(self, name, args, day, day_rows, group)
            encoded = [(_json(dims), _json(counts), _json(values_)) for (dims, counts), values_ in
                       zip((_dims_and_counts(r, group) for r in day_rows), metrics, strict=True)]
            await recorder.write(self.surface, project, call, self.scope, day, round_snapshot(self.ctx, day), encoded)


async def row_metrics(source: GoldRowsSource, name: str, args: tuple, day: date, rows: list[dict], group: Sequence[str]) -> list[dict]:
    """The metric values kept beside a row's counts, for SQL review and the metrics API. The screens calculate from the counts, with the
    same functions (compute), so the two cannot part."""
    population = args[0] if args and isinstance(args[0], str) else None
    if name == "answer_counts" and population == MONITORING:
        return [compute.values_of("언급", {REPRESENTATIVE: {"tracked": r["rep_tracked"], "answers": r["rep_answers"]}, MONITORING: r}) for r in rows]
    if name == "citation_counts":
        return [compute.values_of("인용", {CITATION_MONITORING: r}) for r in rows]
    if name == "url_counts":
        return [compute.values_of("인용", {URL_MEASURED: r}) for r in rows]
    if name == "domain_rows":
        total = sum(r["citations"] for r in rows)
        return [{"source_share": compute.of("source_share", r["citations"], total)} for r in rows]
    if name == "brand_counts" and population == MONITORING:
        return await _brand_rows_metrics(source, day, rows, group)
    if name == "acr_brand_counts":
        totals = (await source.for_rounds([day]).acr_totals())[0]
        return [{"top1_acr": compute.of("top1_acr", r["choice"], totals["iterations"]), "candidate_rate": compute.of("candidate_rate", r["appeared_cells"], totals["cells"])}
                for r in rows]
    return [{} for _ in rows]


async def _brand_rows_metrics(source: GoldRowsSource, day: date, rows: list[dict], group: Sequence[str]) -> list[dict]:
    keys = tuple(k for k in group if k != ROUND_GROUP)
    totals = {tuple(t[k] for k in keys): t for t in await source.for_rounds([day]).answer_counts(MONITORING, keys)}
    out = []
    for r in rows:
        t = totals.get(tuple(r[k] for k in keys), {})
        out.append(compute.brand_metrics(rep_answers=r["rep_answers"], answers=t.get("rep_answers"), mentions=r["mentions"], total_mentions=t.get("total_mentions"),
                                         positive=r["s_pos"], sentiments=sum(r[k] for k in ("s_pos", "s_neu", "s_neg", "s_mix")), rank_sum=r["rank_sum"], ranked=r["ranked"]))
    return out


def start_recording(recorder: RowRecorder) -> Token:
    return _recorder.set(recorder)


def stop_recording(token: Token) -> None:
    _recorder.reset(token)


def metric_source(ctx: Context) -> Any:
    """The data source of a /v1 read: Gold's rows for what a first screen reads, the snapshot for a filtered read. HGH_METRIC_SOURCE=silver: every read is counted on the OBT
    (adapter ②); the rows and the cache come with the manifest's signals (T9.3)."""
    from bff.metrics import silver_obt  # it reads through gold_current during the move
    if silver_obt.enabled():
        _mark_live()
        return silver_obt.ObtForContext(ctx)
    live = GoldCurrentSource(ctx)
    scope = scope_of(ctx)
    if scope is None:
        _mark_live()
        return live
    if _recorder.get() is not None:
        return RecordingSource(live, scope)
    if metrics_db.configured():
        return GoldRowsSource(live, scope)
    return live
