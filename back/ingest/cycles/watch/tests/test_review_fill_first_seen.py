"""검토 대기함 "새 표면" = 처음 관측(검증 반례 CE9 회귀) + 첫 가동 기준선. 일회 DB(fresh_db). Slack 실제 발송 없음(MemoryAlertSink).

  1) 30일 전에 관측된 기존 표면(Hyundai 'Hyundai')이 감시 창 안에 다시 나와도 큐·경보하지 않는다. 대소문자만 다른 원문('HYUNDAI')도
     정규형이 같으면 기존 표면이다. 같은 창의 진짜 새 표면(Hyundai 'Ioniq Z')은 그대로 큐·경보(자사)된다.
  2) 첫 가동(창 앞 답변이 하나도 없음 = 과거 이력 없음): 창의 모든 표면·엔티티가 새로 보이지만 기준선으로 보고 큐·경보하지 않는다.
"""
from __future__ import annotations

import datetime as dt
import uuid

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.watch.service import watch
from tests.support import needs_db

NOW = dt.datetime(2026, 10, 10, 6, 0, tzinfo=dt.UTC)
HYUNDAI = uuid.UUID("00000000-0000-0000-0000-000000000301")   # app.brand.canonical_entity_id(is_hmg_own)


async def _answer(c: asyncpg.Connection, at: dt.datetime, entity_id: uuid.UUID, surfaces: list[str]) -> None:
    lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, started_at, status) VALUES ('run', 1, $1, 'committed') RETURNING load_id", at)
    jid = uuid.uuid4()
    ak = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, measured_at, n_mentions, content_hash,
                                              first_seen_at, load_id)
                       VALUES ('2026-09-01', $1, $2, $3, 'chatgpt', 'completed', $4, 1, '\\x00', $4, $5)""", jid, ak, uuid.uuid4(), at, lid)
    await c.execute("""INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, surfaces, type_mention)
                       VALUES ('2026-09-01', $1, 1, $2, 'Hyundai', 'Brand', 1, $3, 1)""", jid, entity_id, surfaces)


async def _review(url: str) -> list[dict]:
    c = await asyncpg.connect(url)
    try:
        return [dict(r) for r in await c.fetch("SELECT kind, entity_id, surface_norm, n_mentions, alerted_at FROM app.ecat_review "
                                               "ORDER BY kind, surface_norm NULLS FIRST")]
    finally:
        await c.close()


@needs_db
async def test_established_surface_reobserved_is_not_new(fresh_db):
    c = await asyncpg.connect(fresh_db)
    try:
        async with c.transaction():
            await _answer(c, NOW - dt.timedelta(days=30), HYUNDAI, ["Hyundai"])          # 기존 표면(창 앞 관측)
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, ["Hyundai"])          # 창 안 재관측
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, ["HYUNDAI"])          # 원문만 다름(정규형 같음)
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, ["Ioniq Z"])          # 진짜 새 표면(자사)
    finally:
        await c.close()
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=sink, checks=["review_fill"])
    rows = await _review(fresh_db)
    surf = {r["surface_norm"]: r for r in rows if r["kind"] == "new_surface"}
    assert "hyundai" not in surf, "오래된 기존 표면 'Hyundai' 가 새 표면으로 큐·경보됐다"
    assert set(surf) == {"ioniq z"} and surf["ioniq z"]["alerted_at"] is not None, rows
    assert rep.info["review_fill"]["new_surface"] == 1 and rep.info["review_fill"]["alerted"] == 1
    msg = sink.sent[0][1] if len(sink.sent) == 1 else ""
    assert "표면 'Ioniq Z'" in msg and "표면 'Hyundai'" not in msg and "표면 'HYUNDAI'" not in msg, sink.sent


@needs_db
async def test_first_run_without_history_is_baseline(fresh_db):
    """창 앞 답변이 없는 기준일(2000-01-01): 픽스처 전부가 창 안(first_seen_at > 창 시작)이라 과거 이력이 없다 → 기준선, 큐·경보 0."""
    now = dt.datetime(2000, 1, 1, 6, 0, tzinfo=dt.UTC)
    sink = MemoryAlertSink()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=now, alerts=sink, checks=["review_fill"])
    assert rep.info["review_fill"] == {"checked": True, "baseline": True, "new_entity": 0, "new_entity_saturated": False, "new_surface": 0,
                                       "new_surface_saturated": False, "alerted": 0}
    assert rep.findings == [] and sink.sent == [] and await _review(fresh_db) == []


@needs_db
async def test_undetermined_run_does_not_advance_window(fresh_db, monkeypatch):
    """검증 반례 N3: 판정이 시간 초과(판정 불가)면 창(judged_to)이 전진하지 않고 판정 불가 수가 남는다(경보 없음). 다음 실행이 같은 답변을
    다시 판정해 새 표면을 잡는다. 이미 대기 중인 새 표면은 뒤 창에서 다시 나오면 카운트를 누적하고 재경보하지 않는다."""
    import ingest.cycles.watch.service as svc
    c = await asyncpg.connect(fresh_db)
    try:
        async with c.transaction():
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, ["Ioniq Z"])
    finally:
        await c.close()
    db = LoaderDB(fresh_db, role="loader")
    slow = svc.WINDOW_CANDIDATES.replace("FROM _rf_w w\n", "FROM _rf_w w CROSS JOIN (SELECT pg_sleep(2)) z\n")
    assert slow != svc.WINDOW_CANDIDATES
    monkeypatch.setattr(svc, "WINDOW_CANDIDATES", slow)
    monkeypatch.setattr(svc, "REVIEW_TIMEOUT", "1s")
    sink1 = MemoryAlertSink()
    rep1 = await watch(db, now=NOW, alerts=sink1, checks=["review_fill"])
    monkeypatch.undo()
    rows1 = await _review(fresh_db)
    c = await asyncpg.connect(fresh_db)
    try:
        st1 = dict(await c.fetchrow("SELECT judged_to, fail_count, last_error FROM ing.review_fill_state"))
    finally:
        await c.close()

    later = NOW + dt.timedelta(hours=6)
    sink2 = MemoryAlertSink()
    rep2 = await watch(db, now=later, alerts=sink2, checks=["review_fill"])
    rows2 = await _review(fresh_db)

    c = await asyncpg.connect(fresh_db)
    try:
        async with c.transaction():
            await _answer(c, later + dt.timedelta(hours=1), HYUNDAI, ["IONIQ Z"])
        st2 = dict(await c.fetchrow("SELECT judged_to, fail_count FROM ing.review_fill_state"))
    finally:
        await c.close()
    sink3 = MemoryAlertSink()
    await watch(db, now=later + dt.timedelta(hours=6), alerts=sink3, checks=["review_fill"])
    rows3 = await _review(fresh_db)

    info1 = rep1.info["review_fill"]
    assert info1["checked"] is False and info1["reason"] == "QueryCanceledError" and info1["fail_count"] == 1, info1
    assert info1["unjudged_from"] == (NOW - dt.timedelta(hours=6)).isoformat() and sink1.sent == [] and rows1 == []
    assert st1["judged_to"] == NOW - dt.timedelta(hours=6) and st1["fail_count"] == 1 and st1["last_error"].startswith("QueryCanceledError")
    assert rep2.info["review_fill"]["new_surface"] == 1 and len(sink2.sent) == 1, rep2.info
    assert [(r["surface_norm"], r["n_mentions"]) for r in rows2 if r["kind"] == "new_surface"] == [("ioniq z", 1)]
    assert st2 == {"judged_to": later, "fail_count": 0}
    assert [(r["surface_norm"], r["n_mentions"]) for r in rows3 if r["kind"] == "new_surface"] == [("ioniq z", 2)] and sink3.sent == []


@needs_db
async def test_failed_window_is_rejudged_next_run(fresh_db):
    """행동 시험(구현 무관): 첫 실행이 판정 불가(loader 가 app.brand 를 못 읽게 한 권한 오류)로 끝나면, 6시간 뒤 실행이 그 창의 새 표면을
    잡는다. 고정 6시간 창이면 첫 창의 답변이 두 번째 실행의 창 밖(이력)이 되어 영영 잡히지 않는다(N3)."""
    c = await asyncpg.connect(fresh_db)
    try:
        async with c.transaction():
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, ["Ioniq Q"])
        await c.execute("REVOKE SELECT ON app.brand FROM loader")
    finally:
        await c.close()
    db = LoaderDB(fresh_db, role="loader")
    rep1 = await watch(db, now=NOW, alerts=MemoryAlertSink(), checks=["review_fill"])
    c = await asyncpg.connect(fresh_db)
    try:
        await c.execute("GRANT SELECT ON app.brand TO loader")
    finally:
        await c.close()
    sink = MemoryAlertSink()
    rep2 = await watch(db, now=NOW + dt.timedelta(hours=6), alerts=sink, checks=["review_fill"])
    rows = await _review(fresh_db)
    assert rep1.info["review_fill"]["checked"] is False, rep1.info
    assert rep2.info["review_fill"]["checked"] is True, rep2.info
    assert "ioniq q" in {r["surface_norm"] for r in rows if r["kind"] == "new_surface"}, rows
    assert len(sink.sent) == 1


async def _late_answer(c: asyncpg.Connection, started: dt.datetime, surfaces: list[str], *, load_id: int | None = None) -> int:
    """적재 트랜잭션이 started 에 시작해(first_seen_at = 트랜잭션 시작) 나중에 커밋된 답변. load_id 를 주면 그 running 적재를 커밋으로 닫는다."""
    if load_id is None:
        load_id = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, started_at, status) VALUES ('run', 1, $1, 'committed') RETURNING load_id",
                                   started)
    else:
        await c.execute("UPDATE ing.load SET status = 'committed' WHERE load_id = $1", load_id)
    jid = uuid.uuid4()
    ak = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, measured_at, n_mentions, content_hash,
                                              first_seen_at, load_id)
                       VALUES ('2026-09-01', $1, $2, $3, 'chatgpt', 'completed', $4, 1, '\\x00', $4, $5)""", jid, ak, uuid.uuid4(), started, load_id)
    await c.execute("""INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, surfaces, type_mention)
                       VALUES ('2026-09-01', $1, 1, $2, 'Hyundai', 'Brand', 1, $3, 1)""", jid, HYUNDAI, surfaces)
    return int(load_id)


@needs_db
async def test_late_committed_load_is_judged_in_next_window(fresh_db):
    """검증 반례 N5(CE17): 판정(T0+3h)보다 먼저 시작(T0+2h30m)했지만 판정 뒤에 커밋된 적재의 새 표면 = 다음 판정 창에서 큐·원장에 오른다.
    (a) 판정 때 그 적재가 아직 보이지 않음(검증자 재현 모양: 커밋 뒤에 행이 생긴다) (b) 판정 때 running 으로 보임(실제 open_load 모양:
    워터마크가 그 앞에서 멈춘다)."""
    db = LoaderDB(fresh_db, role="loader")
    t0 = NOW
    await watch(db, now=t0, alerts=MemoryAlertSink(), checks=["review_fill"])               # 기준선 + 첫 판정
    c = await asyncpg.connect(fresh_db)
    try:
        running = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, started_at, status) VALUES ('run', 1, $1, 'running') RETURNING load_id",
                                   t0 + dt.timedelta(hours=2, minutes=40))
    finally:
        await c.close()
    await watch(db, now=t0 + dt.timedelta(hours=3), alerts=MemoryAlertSink(), checks=["review_fill"])
    c = await asyncpg.connect(fresh_db)
    try:
        judged_mid = await c.fetchval("SELECT judged_load_id FROM ing.review_fill_state")
        async with c.transaction():
            await _late_answer(c, t0 + dt.timedelta(hours=2, minutes=30), ["Zeta Beta"])                       # (a)
            await _late_answer(c, t0 + dt.timedelta(hours=2, minutes=40), ["Zeta Gamma"], load_id=running)    # (b)
    finally:
        await c.close()
    sink = MemoryAlertSink()
    rep = await watch(db, now=t0 + dt.timedelta(hours=9), alerts=sink, checks=["review_fill"])
    rows = await _review(fresh_db)
    c = await asyncpg.connect(fresh_db)
    try:
        seen = {r[0] for r in await c.fetch("SELECT surface_norm FROM ing.surface_seen WHERE surface_norm LIKE 'zeta %'")}
    finally:
        await c.close()
    assert judged_mid < running, (judged_mid, running)                                        # running 적재 앞에서 멈췄다
    surf = {r["surface_norm"] for r in rows if r["kind"] == "new_surface"}
    assert {"zeta beta", "zeta gamma"} <= surf, rows
    assert seen == {"zeta beta", "zeta gamma"} and rep.info["review_fill"]["new_surface"] == 2 and len(sink.sent) == 1, rep.info


@needs_db
async def test_stale_running_load_is_carried_and_judged_when_committed(fresh_db, monkeypatch):
    """검증 반례 N6(CE19 4): 24시간 넘게 running 인 적재(pull 스테이지 재개 run)는 워터마크를 묶지 않지만 이월 목록에 남는다. 그 적재가
    나중에 커밋되면 다음 판정이 그 답변을 따로 판정하고 목록에서 지운다. 판정 실패면 목록 유지(N3), failed 로 닫힌 적재는 지운다,
    이월 판정은 한 번만 센다."""
    import ingest.cycles.watch.service as svc
    db = LoaderDB(fresh_db, role="loader")
    await watch(db, now=NOW, alerts=MemoryAlertSink(), checks=["review_fill"])                    # 기준선
    c = await asyncpg.connect(fresh_db)
    try:
        open_ = "INSERT INTO ing.load (kind, rule_ver, started_at, status) VALUES ('run', 1, $1, 'running') RETURNING load_id"
        l3 = await c.fetchval(open_, NOW - dt.timedelta(hours=30))                                 # 재시도·백오프로 하루 넘게 도는 run
        l5 = await c.fetchval(open_, NOW - dt.timedelta(hours=40))                                 # 결국 실패로 닫힐 run
        async with c.transaction():
            await _late_answer(c, NOW + dt.timedelta(hours=1), ["Zeta Four"])
    finally:
        await c.close()
    rep1 = await watch(db, now=NOW + dt.timedelta(hours=2), alerts=MemoryAlertSink(), checks=["review_fill"])
    c = await asyncpg.connect(fresh_db)
    try:
        st1 = dict(await c.fetchrow("SELECT judged_load_id, carry_load_ids FROM ing.review_fill_state"))
        async with c.transaction():
            await _late_answer(c, NOW + dt.timedelta(hours=3), ["Zeta Three"], load_id=l3)         # 재개된 run 커밋
            await c.execute("UPDATE ing.load SET status = 'failed' WHERE load_id = $1", l5)
    finally:
        await c.close()
    slow = svc.WINDOW_CANDIDATES.replace("FROM _rf_w w\n", "FROM _rf_w w CROSS JOIN (SELECT pg_sleep(2)) z\n")
    monkeypatch.setattr(svc, "WINDOW_CANDIDATES", slow)
    monkeypatch.setattr(svc, "REVIEW_TIMEOUT", "1s")
    rep2 = await watch(db, now=NOW + dt.timedelta(hours=4), alerts=MemoryAlertSink(), checks=["review_fill"])
    monkeypatch.undo()
    c = await asyncpg.connect(fresh_db)
    try:
        st2 = list(await c.fetchval("SELECT carry_load_ids FROM ing.review_fill_state"))
    finally:
        await c.close()
    sink = MemoryAlertSink()
    rep3 = await watch(db, now=NOW + dt.timedelta(hours=5), alerts=sink, checks=["review_fill"])
    rep4 = await watch(db, now=NOW + dt.timedelta(hours=6), alerts=MemoryAlertSink(), checks=["review_fill"])
    rows = {r["surface_norm"]: r["n_mentions"] for r in await _review(fresh_db) if r["kind"] == "new_surface"}
    c = await asyncpg.connect(fresh_db)
    try:
        st3 = list(await c.fetchval("SELECT carry_load_ids FROM ing.review_fill_state"))
    finally:
        await c.close()
    info1 = rep1.info["review_fill"]
    assert st1["judged_load_id"] > l5 and sorted(st1["carry_load_ids"]) == sorted([l3, l5]), st1            # 워터마크는 넘어가고 이월에 남음
    assert info1["carry_skipped"] == 2 and info1["carry"] == 2 and info1["stale_running"] == 2, info1
    assert rep2.info["review_fill"]["checked"] is False and rep2.info["review_fill"]["carry"] == 2 and sorted(st2) == sorted([l3, l5])
    info3 = rep3.info["review_fill"]
    assert info3["carry_judged"] == 1 and info3["carry"] == 0 and st3 == [], (info3, st3)                    # l3 판정·l5(failed) 지움
    assert rows.get("zeta three") == 1 and rows.get("zeta four") == 1 and len(sink.sent) == 1, rows
    assert "carry" not in rep4.info["review_fill"]                                                          # 이월 판정은 한 번
