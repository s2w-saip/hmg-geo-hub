"""감시 투영 공백(동기화 S1 BE-10, 현행 hmg-geo #327 2d310ec 감시 ④ 의 hub 적재 경로판): 순수 판정·채움 계획 + 일회 DB(fresh_db).

합성 픽스처: 글로벌 run 01(회차 11) 답변 1·2 = 프롬프트 01, 웹사이트 run 21 답변 21, 프로젝트 run 31 답변 31. 답변 13(running)·14(드롭)은
원래 rd.answer 가 없다(공백이 아니다). 공백은 rd.answer(또는 rd.job 과 함께)를 지워 만들고, 경과는 그 답변을 쓴 적재(ing.load)의 끝 시각으로 준다.
"""
from __future__ import annotations

import datetime as dt
import json
import uuid

import asyncpg
import pytest

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.watch import service as ws
from ingest.cycles.watch.service import FILL_SOURCE, judge_projection_gap, plan_fill, watch
from tests.support import needs_db

NOW = dt.datetime(2026, 9, 28, 6, 0, tzinfo=dt.UTC)
P01 = uuid.UUID("b0000000-0000-4000-8000-000000000001")
P21 = uuid.UUID("b0000000-0000-4000-8000-000000000021")
P31 = uuid.UUID("b0000000-0000-4000-8000-000000000031")
QUIET = f"""UPDATE ing.sync_cursor SET last_attempt_at = '{(NOW - dt.timedelta(minutes=5)).isoformat()}';
            UPDATE app.judgment_change SET status = 'applied' WHERE status = 'pending';
            UPDATE ing.cycle SET status = 'published', closed_by = 'next_anchor', closed_at = '2026-09-28 00:00+00',
                   view_anchor_at = '2026-09-22 15:00+00' WHERE cyc_key = 12;"""


# ── 순수 판정 ───────────────────────────────────────────────────────────────
def row(surface="project", project="p1", answers=1, aged=None, *, cycle="c1", prompt=P31, load=NOW - dt.timedelta(hours=2),
        anchor=dt.datetime(2026, 9, 20, tzinfo=dt.UTC), name=None):
    return {"surface": surface, "scope_project_id": project, "project_name": name, "answers": answers,
            "aged": answers if aged is None else aged, "cycle_ref": cycle, "prompt_id": prompt, "oldest_load_at": load, "anchor_at": anchor}


def test_judge_empty_and_fresh_only_are_pass():
    assert judge_projection_gap([], NOW).severity == 0
    v = judge_projection_gap([row(answers=3, aged=0)], NOW)
    assert (v.severity, v.answers, v.fresh, v.cycles) == (0, 0, 3, 0)


@pytest.mark.parametrize(("rows", "sev"), [
    ([row(answers=5)], 1),                                                        # project 표면 소규모·24시간 미만 = 주의
    ([row(answers=999), row(project="p2", answers=0, aged=0)], 1),
    ([row(answers=1_000)], 2),                                                    # 답변 1,000 이상
    ([row(answers=600), row(project="p2", answers=400)], 2),                     # 합으로 1,000
    ([row(load=NOW - dt.timedelta(hours=24))], 2),                               # 적재 뒤 24시간 이상
    ([row(load=NOW - dt.timedelta(hours=23, minutes=59))], 1),
    ([row(surface="global")], 2), ([row(surface="website")], 2),                 # 함대 화면 표면
    ([row(surface="unattributed")], 1),
])
def test_judge_severity_matches_current_rule(rows, sev):
    assert judge_projection_gap(rows, NOW).severity == sev


def test_judge_groups_cycles_top_and_oldest():
    rows = [row("global", "g", 2, cycle="c11", anchor=dt.datetime(2026, 9, 14, tzinfo=dt.UTC)),
            row("global", "g", 3, cycle="c12", anchor=dt.datetime(2026, 9, 21, tzinfo=dt.UTC)),
            row("global", "g", 1, cycle="c12"),
            row("project", "p", 4, 1, cycle="run:x", load=NOW - dt.timedelta(hours=30))]
    v = judge_projection_gap(rows, NOW)
    assert (v.answers, v.fresh, v.cycles, v.by_surface) == (7, 3, 3, {"global": 6, "project": 1})
    assert [t["scope_project_id"] for t in v.top] == ["g", "p"] and v.top[0]["cycles"] == 2
    assert v.oldest["anchor_at"] == dt.datetime(2026, 9, 14, tzinfo=dt.UTC) and v.oldest_age_hours == 30


def test_plan_fill_cap_order_and_skips():
    a, b, c, d = (uuid.UUID(int=i) for i in (1, 2, 3, 4))
    rows = [row(prompt=a, answers=2, load=NOW - dt.timedelta(hours=1)), row(prompt=b, answers=1, load=NOW - dt.timedelta(hours=9)),
            row(prompt=c, answers=1, load=NOW - dt.timedelta(hours=5)), row(prompt=d, answers=1, load=NOW - dt.timedelta(hours=3)),
            row(prompt=None, answers=4)]
    p = plan_fill(rows, {a: 3000, b: 6000, c: 2500, d: 2600}, cap=5000)
    # 오래된 순 b(6,000 > cap: 건너뜀) → c(2,500) → d(2,600: 합 5,100 > cap, 미룸) → a(3,000: 합 5,500, 미룸)
    assert p.prompts == [c] and (p.estimated, p.gap_answers, p.deferred, p.unfillable) == (2500, 1, 2, 4)
    assert [x["prompt_id"] for x in p.too_large] == [str(b)]
    assert plan_fill(rows, {}, cap=5000).prompts == sorted([a, b, c, d], key=str)     # 예상 = 공백 수(미투영뿐)


# ── 일회 DB ─────────────────────────────────────────────────────────────────
async def _x(url: str, sql: str) -> None:
    c = await asyncpg.connect(url)
    try:
        await c.execute(sql)
    finally:
        await c.close()


async def _val(url: str, sql: str, *args):
    c = await asyncpg.connect(url)
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


def _gap_sql(keys: list[int], *, age: dt.timedelta, drop_job: tuple[int, ...] = ()) -> str:
    """keys 답변을 age 전에 끝난 적재가 쓴 것으로 두고 rd.answer 를 지운다. drop_job 은 한 번도 투영되지 않은 상태(rd.job·자식 행도 없음)."""
    ks = ",".join(map(str, keys))
    js = ",".join(map(str, drop_job)) or "NULL"
    return f"""
      WITH l AS (INSERT INTO ing.load (kind, rule_ver, status, started_at, finished_at)
                 VALUES ('run', 1, 'committed', '{(NOW - age - dt.timedelta(minutes=1)).isoformat()}', '{(NOW - age).isoformat()}') RETURNING load_id)
      UPDATE ing.answer a SET load_id = l.load_id FROM l WHERE a.answer_key IN ({ks});
      DELETE FROM rd.answer WHERE answer_key IN ({ks});
      DELETE FROM rd.answer_brand WHERE answer_key IN ({js});
      DELETE FROM rd.answer_stance WHERE answer_key IN ({js});
      DELETE FROM rd.citation WHERE answer_key IN ({js});
      DELETE FROM rd.job WHERE answer_key IN ({js});"""


def _gap_findings(rep):
    return [f for f in rep.findings if f.check == "projection_gap"]


async def _fills(url: str) -> int:
    return int(await _val(url, "SELECT count(*) FROM app.judgment_change WHERE kind = 'scope_prompt' AND payload->>'source' = $1", FILL_SOURCE))


@needs_db
async def test_clean_fixture_has_no_gap_even_with_running_and_dropped(fresh_db):
    """완료 아님(13 running)·드롭(14)은 rd.answer 가 없어도 공백이 아니다. 경보·채움 요청 없음."""
    await _x(fresh_db, QUIET)
    assert await _val(fresh_db, "SELECT count(*) FROM rd.answer WHERE answer_key IN (13, 14)") == 0
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink)
    assert "projection_gap" in rep.checked and rep.findings == [] and sink.sent == []
    assert rep.info["projection_gap"] == {"checked": True, "answers": 0, "fresh": 0, "cycles": 0, "by_surface": {}, "severity": 0,
                                          "saturated": False}
    assert await _fills(fresh_db) == 0 and rep.sink == "memory"


@needs_db
async def test_gap_alerts_once_requests_fill_dedupes_and_queue_repairs(fresh_db):
    """글로벌 1·2(2는 rd.job 까지 없음)·웹사이트 21 공백(2시간) → 긴급 1건(표면 묶음), scope_prompt 재투영 요청 1건.
    다음 실행은 요청을 겹쳐 넣지 않는다(대기 중). 큐 처리 뒤 rd.answer 가 지우기 전과 같게 돌아오고 감시는 조용하다."""
    await _x(fresh_db, QUIET)
    before = await _val(fresh_db, "SELECT jsonb_agg(to_jsonb(x) - 'load_id' ORDER BY answer_key) FROM rd.answer x WHERE answer_key IN (1, 2, 21)")
    await _x(fresh_db, _gap_sql([1, 2, 21], age=dt.timedelta(hours=2), drop_job=(2,)))
    db = LoaderDB(fresh_db, role="loader")
    sink = MemoryAlertSink()
    rep = await watch(db, now=NOW, alerts=sink)
    gap = _gap_findings(rep)
    assert len(gap) == 1 and (gap[0].severity, gap[0].sink) == (2, "live")
    d = gap[0].detail
    assert (d["answers"], d["cycles"], d["by_surface"]) == (3, 2, {"global": 2, "website": 1})
    assert d["fill"]["status"] == "requested" and d["fill"]["prompts"] == 2 and d["fill"]["gap_answers"] == 3
    msgs = [(k, m, s) for (k, m, _), s in zip(sink.sent, sink.severities, strict=True) if "projection_gap" in m]
    assert len(msgs) == 1 and msgs[0][0] == "live" and msgs[0][2] == 2
    row = await _val(fresh_db, "SELECT jsonb_build_object('s', subject_uuids, 'st', status, 'p', payload) FROM app.judgment_change "
                               "WHERE change_id = $1", d["fill"]["change_id"])
    row = json.loads(row)
    assert sorted(row["s"]) == sorted([str(P01), str(P21)]) and row["st"] == "pending" and row["p"]["source"] == FILL_SOURCE

    rep2 = await watch(db, now=NOW, alerts=MemoryAlertSink())                     # 6시간 스케줄의 다음 실행: 경보는 다시, 요청은 겹치지 않는다
    assert _gap_findings(rep2)[0].detail["fill"] == {**d["fill"], "status": "pending"}
    assert await _fills(fresh_db) == 1

    from ingest.cycles.workers.service import run_queue
    out = await run_queue(db, limit=10)
    assert [(o.kind, o.status) for o in out] == [("scope_prompt", "applied")], out
    after = await _val(fresh_db, "SELECT jsonb_agg(to_jsonb(x) - 'load_id' ORDER BY answer_key) FROM rd.answer x WHERE answer_key IN (1, 2, 21)")
    assert after == before
    rep3 = await watch(db, now=NOW, alerts=(s3 := MemoryAlertSink()))
    assert _gap_findings(rep3) == [] and rep3.info["projection_gap"]["answers"] == 0 and s3.sent == []


@needs_db
@pytest.mark.parametrize(("age", "sev"), [
    (dt.timedelta(minutes=59), 0),                     # 유예 안: 경보 없음(채움은 요청)
    (dt.timedelta(hours=1), 0),                        # 경계: 현행 synced_at < now() - 1h 와 같이 엄격 비교
    (dt.timedelta(hours=1, seconds=1), 1),             # project 표면 소규모 = 주의
    (dt.timedelta(hours=24), 2),                       # 적재 뒤 24시간 = 긴급
])
async def test_project_gap_grace_boundary_and_severity(fresh_db, age, sev):
    await _x(fresh_db, QUIET + _gap_sql([31], age=age))
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink)
    gap = _gap_findings(rep)
    info = rep.info["projection_gap"]
    assert info["severity"] == sev and info["fill"]["status"] == "requested"
    if sev == 0:
        assert gap == [] and sink.sent == [] and info["fresh"] == 1
    else:
        assert len(gap) == 1 and gap[0].severity == sev and gap[0].detail["by_surface"] == {"project": 1}
        assert sink.severities == [sev]


@needs_db
async def test_fill_off_and_unavailable_check_do_not_alert(fresh_db, monkeypatch):
    """fill_gaps=False 면 큐에 쓰지 않는다. 판정 문장이 실패하면(판정 불가) 경보 없이 보고에만 남고 다른 점검은 그대로 돈다."""
    await _x(fresh_db, QUIET + _gap_sql([31], age=dt.timedelta(hours=3)))
    db = LoaderDB(fresh_db, role="loader")
    rep = await watch(db, now=NOW, alerts=MemoryAlertSink(), fill_gaps=False)
    assert _gap_findings(rep)[0].detail["fill"] == {"status": "off"} and await _fills(fresh_db) == 0
    monkeypatch.setattr(ws, "PROJECTION_GAP", "SELECT * FROM ing.no_such_table")
    sink = MemoryAlertSink()
    rep = await watch(db, now=NOW, alerts=sink)
    assert _gap_findings(rep) == [] and sink.sent == [] and rep.info["projection_gap"]["checked"] is False
    assert set(rep.checked) >= {"heartbeat", "queue", "projection_gap"}


def test_checks_selection_and_settings():
    from ingest.common.config import load_ingest_settings
    assert ws.resolve_checks(None) == frozenset(ws.CHECKS) and ws.resolve_checks([" projection_gap ", ""]) == {"projection_gap"}
    with pytest.raises(ValueError, match="no_such"):
        ws.resolve_checks(["projection_gap", "no_such"])
    s = load_ingest_settings({"HGH_WATCH_CHECKS": "projection_gap, queue", "HGH_WATCH_FILL": "0"})
    assert (s.watch_checks, s.watch_fill) == (("projection_gap", "queue"), False)
    s = load_ingest_settings({})
    assert (s.watch_checks, s.watch_fill) == ((), True)


@needs_db
async def test_only_projection_gap_skips_other_checks(fresh_db):
    """pull 워커가 없는 환경(stg): HGH_WATCH_CHECKS=projection_gap 이면 하트비트(늘 긴급)가 울지 않는다."""
    await _x(fresh_db, _gap_sql([31], age=dt.timedelta(hours=3)))                   # QUIET 없음: 하트비트·큐 대기가 걸리는 상태
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink, checks=["projection_gap"])
    assert rep.checked == ["projection_gap"] and [f.check for f in rep.findings] == ["projection_gap"] and sink.severities == [1]
