"""E2 DB 부분(ing.hub_match): 재스캔 멱등·재개·따라잡기, 코드포인트 오프셋, ACR 1턴 제외, Scope 발생 겹침 제거, 적재 훅, leaf 준비.

커밋하는 경로라 일회 DB(fresh_db)에서 돈다. 쓰기는 loader 롤(LoaderDB(role='loader')), 준비·검증은 소유자 연결.
합성 본문만 쓴다(고객 데이터 없음). 기대값은 본문 문자열에서 손으로 센 오프셋이다.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import uuid

import asyncpg
import pytest

from ingest.common.alerts import MemoryAlertSink
from ingest.common.config import IngestSettings
from ingest.common.db import LoaderDB
from ingest.cycles.workers.service import ensure_partitions
from ingest.ecat import rematch as rm
from ingest.ecat.scan import ScanInputError, scan
from ingest.pull.sync.service import run_pass
from ingest.pull.sync.source import FakeScopeSource
from ingest.testkit import make_job, mention
from tests.support import needs_db

ACTOR = uuid.UUID("00000000-0000-4000-8000-00000000e2e2")
E_EPIT = uuid.UUID("e2000000-0000-4000-8000-000000000001")
E_KONA = uuid.UUID("e2000000-0000-4000-8000-000000000002")
E_GEN = uuid.UUID("e2000000-0000-4000-8000-000000000003")
E_BMW = uuid.UUID("e2000000-0000-4000-8000-000000000004")
E_TOY = uuid.UUID("e2000000-0000-4000-8000-000000000005")
SEP = dt.date(2026, 9, 1)
JUN = dt.date(2026, 6, 1)
RUN = uuid.UUID("e2000000-0000-4000-8000-0000000000aa")
PRUN = uuid.UUID("e2000000-0000-4000-8000-0000000000bb")


def J(n: int) -> uuid.UUID:
    return uuid.UUID(f"e2e20000-0000-4000-8000-{n:012d}")


# (job 번호, 월, ACR 여부, 본문). 오프셋 기대값은 각 시험에서 본문으로 계산해 단언한다.
BODIES: list[tuple[int, dt.date, bool, str]] = [
    (1, SEP, False, "Epit, un marchio. Il prodotto è percepito come affidabile. EPIT again."),
    (2, SEP, False, "😀𠀀 Kona é Kona! 𝐀 KONA-N"),                      # 서로게이트 쌍(아스트랄) 3개 + NFD 결합 부호 뒤
    (3, SEP, False, "제네시스 GV80 과 근제네시스, BMW X5 and BMW i4"),
    (4, SEP, True, "ACR 2턴 본문: Kona 와 Epit 를 고르겠다."),                   # ACR: 저장 본문 = 2턴
    (5, JUN, False, "June answer about Kona and BMW and Toyota."),             # 6월: 발생 행 없음
    (6, SEP, False, "nothing to see here"),
    (7, SEP, False, "Kona Kona Kona"),
    (8, JUN, False, "Epit only"),
]
SURFACES = [("Epit", E_EPIT), ("Kona", E_KONA), ("제네시스", E_GEN), ("BMW", E_BMW)]


def _hash(text: str) -> bytes:
    return hashlib.sha256(text.encode()).digest()


async def _connect(url: str) -> asyncpg.Connection:
    return await asyncpg.connect(url)


async def _setup(url: str, bodies=BODIES) -> dict[str, int]:
    """초안 버전 1개 + add 표면 4개 + 합성 답변. 반환 = {표면: surface_id}."""
    c = await _connect(url)
    try:
        for m in (JUN, SEP):
            for t in ("ing.answer", "ing.mention", "ing.mention_occurrence"):
                await c.execute("SELECT rd.ensure_month_leaf($1::regclass, $2::date)", t, m)
        lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, status, finished_at) VALUES ('seed', 1, 'committed', now()) RETURNING load_id")
        ver = await c.fetchval("INSERT INTO app.ecat_version (title, created_by) VALUES ('e2 시험 초안', $1) RETURNING ver", ACTOR)
        sid: dict[str, int] = {}
        for s, e in SURFACES:
            sid[s] = await c.fetchval("""INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by)
                                          VALUES ($1, $2, lower($2), $3) RETURNING surface_id""", e, s, ACTOR)
            await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'add')", ver, sid[s])
        for n, m, acr, text in bodies:
            await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, prompt_run_id, answer_text,
                                                       content_hash, load_id)
                               VALUES ($1, $2, $3, $4, 'chatgpt', 'completed', $5, $6, $7, $8)""",
                            m, J(n), 990000 + n, RUN, PRUN if acr else None, text, _hash(text), lid)
        return sid
    finally:
        await c.close()


async def _rows(url: str, sql: str = """SELECT surface_id, run_month, job_id, turn_index, entity_id, n_occ, first_start, starts, ends,
                                                answer_hash FROM ing.hub_match ORDER BY 1, 2, 3, 4""", *args) -> list[tuple]:
    c = await _connect(url)
    try:
        return [tuple(r) for r in await c.fetch(sql, *args)]
    finally:
        await c.close()


def _db(url: str) -> LoaderDB:
    return LoaderDB(url, role="loader")


@needs_db
async def test_full_scan_idempotent_and_catchup_noop(fresh_db):
    sid = await _setup(fresh_db)
    db = _db(fresh_db)
    r1 = await scan(db)                                        # 기본 = 활성·초안 add 표면, 처음이라 전체 스캔 + 따라잡기
    assert r1.status == "done" and r1.full_surfaces == sorted(sid.values()) and r1.answers_scanned == len(BODIES)
    a = await _rows(fresh_db)
    assert len(a) == r1.rows_written > 0
    r2 = await scan(db, full=True)                             # 같은 입력 전체 재스캔 = 같은 행(load_id 제외)
    assert await _rows(fresh_db) == a and r2.rows_written == len(a)
    r3 = await scan(db)                                        # 바뀐 본문 없음 → 따라잡기만, 대상 0
    assert r3.full_surfaces == [] and r3.answers_scanned == 0 and await _rows(fresh_db) == a
    st = await _rows(fresh_db, "SELECT surface_id, scanned_to_load_id IS NOT NULL, hits FROM ing.hub_match_scan ORDER BY 1")
    hits = {s: sum(1 for x in a if x[0] == s) for s in sid.values()}
    assert st == [(s, True, hits[s]) for s in sorted(sid.values())]
    # 스캔 load 는 전부 committed(kind rebuild, scope_ref.source ecat_scan)
    lds = await _rows(fresh_db, "SELECT status FROM ing.load WHERE kind = 'rebuild' AND scope_ref->>'source' = 'ecat_scan'")
    assert lds and all(x == ("committed",) for x in lds)


@needs_db
async def test_resume_after_pause_equals_one_shot(fresh_db):
    await _setup(fresh_db)
    db = _db(fresh_db)
    p = await scan(db, chunk=3, max_chunks=1)                  # 청크 1개(답변 3개) 뒤 중단
    assert p.status == "partial" and p.answers_scanned == 3
    mid = await _rows(fresh_db, "SELECT scope_ref->'cursor', status FROM ing.load WHERE load_id = $1", p.load_ids[0])
    assert mid[0][1] == "running" and mid[0][0] is not None
    assert await _rows(fresh_db, "SELECT count(*) FROM ing.hub_match_scan WHERE scanned_to_load_id IS NULL") == [(4,)]
    p2 = await scan(db, chunk=3, max_chunks=1)                 # 이어받아 한 청크 더
    assert p2.status == "partial" and p2.load_ids[0] == p.load_ids[0] and p2.resumed_from == json.loads(mid[0][0])
    done = await scan(db, chunk=3)                             # 끝까지
    assert done.status == "done" and done.load_ids[0] == p.load_ids[0]
    assert p.answers_scanned + p2.answers_scanned + done.answers_scanned == len(BODIES)
    resumed = await _rows(fresh_db)
    await scan(db, full=True, chunk=1000)                      # 한 번에 전체
    assert await _rows(fresh_db) == resumed


@needs_db
async def test_offsets_are_codepoints_and_acr_turn(fresh_db):
    sid = await _setup(fresh_db)
    await scan(_db(fresh_db))
    # DB 단언: 모든 발생에서 substr(본문, s+1, e-s)(PostgreSQL = 코드포인트)이 표면과 대소문자 무시로 같다
    bad = await _rows(fresh_db, """
        SELECT h.surface_id, h.job_id, i FROM ing.hub_match h JOIN ing.answer a ON a.run_month = h.run_month AND a.job_id = h.job_id
          JOIN app.ecat_surface_def d ON d.surface_id = h.surface_id, generate_subscripts(h.starts, 1) i
         WHERE lower(substr(a.answer_text, h.starts[i] + 1, h.ends[i] - h.starts[i])) <> lower(d.surface)
            OR h.first_start <> h.starts[1] OR h.n_occ <> cardinality(h.starts)""")
    assert bad == []
    kona = {x[2]: x for x in await _rows(fresh_db) if x[0] == sid["Kona"]}
    text2 = BODIES[1][3]
    # BODIES[1]: 코드포인트 오프셋 3·11·19(UTF-16 이면 5·13·22: 앞의 아스트랄 글자마다 1 씩 밀림)
    assert kona[J(2)][7] == [3, 11, 19] and kona[J(2)][8] == [7, 15, 23]
    assert [text2[s:e] for s, e in zip(kona[J(2)][7], kona[J(2)][8], strict=True)] == ["Kona", "Kona", "KONA"]
    u16 = [len(text2[:s].encode("utf-16-le")) // 2 for s in kona[J(2)][7]]
    assert u16 == [5, 13, 22]                                  # 두 척도가 실제로 갈리는 본문이다(이 픽스처가 의미 있다)
    # ACR 답변(prompt_run_id 있음): 행은 턴 2 뿐, 단일 턴은 턴 1 뿐. ACR 1턴 행은 어디에도 없다
    turns = await _rows(fresh_db, """SELECT a.prompt_run_id IS NOT NULL, h.turn_index, count(*) FROM ing.hub_match h
                                      JOIN ing.answer a ON a.run_month = h.run_month AND a.job_id = h.job_id GROUP BY 1, 2 ORDER BY 1, 2""")
    assert [(acr, t) for acr, t, _ in turns] == [(False, 1), (True, 2)]
    # 단어 경계: percepito 안의 epit 불일치, 근제네시스(앞 글자 한글) 불일치
    epit = {x[2]: x[7] for x in await _rows(fresh_db) if x[0] == sid["Epit"]}
    assert epit[J(1)] == [0, BODIES[0][3].index("EPIT")]
    gen = [x for x in await _rows(fresh_db) if x[0] == sid["제네시스"]]
    assert [(x[2], x[7]) for x in gen] == [(J(3), [0])]


@needs_db
async def test_catchup_rescans_changed_bodies_only(fresh_db):
    sid = await _setup(fresh_db)
    db = _db(fresh_db)
    await scan(db)
    wm0 = (await _rows(fresh_db, "SELECT min(scanned_to_load_id) FROM ing.hub_match_scan"))[0][0]
    c = await _connect(fresh_db)
    try:                                                       # 적재가 본문을 바꾼 것처럼: 새 load 가 답변 2개를 고침(하나는 본문 삭제)
        lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, status, finished_at) VALUES ('run', 1, 'committed', now()) RETURNING load_id")
        new6 = "now Kona appears, and BMW"
        await c.execute("UPDATE ing.answer SET answer_text = $2, content_hash = $3, load_id = $4 WHERE job_id = $1", J(6), new6, _hash(new6), lid)
        await c.execute("UPDATE ing.answer SET answer_text = NULL, content_hash = $2, load_id = $3 WHERE job_id = $1", J(7), _hash("x"), lid)
    finally:
        await c.close()
    before = await _rows(fresh_db)
    r = await scan(db)
    assert r.full_surfaces == [] and r.answers_scanned == 1 and r.watermark >= lid > wm0
    after = await _rows(fresh_db)
    assert [x for x in after if x[2] not in (J(6), J(7))] == [x for x in before if x[2] not in (J(6), J(7))]
    assert [x[2] for x in after if x[2] == J(7)] == []         # 본문이 사라진 답변의 옛 행 삭제
    j6 = sorted((x[0], x[7]) for x in after if x[2] == J(6))
    assert j6 == sorted([(sid["Kona"], [4]), (sid["BMW"], [22])])
    # 따라잡기 결과 = 처음부터 전체 스캔 결과
    await scan(db, full=True)
    assert await _rows(fresh_db) == after


@needs_db
async def test_rematch_respects_scope_occurrences(fresh_db):
    sid = await _setup(fresh_db)
    db = _db(fresh_db)
    await scan(db)
    c = await _connect(fresh_db)
    try:
        t3 = BODIES[2][3]
        b1 = t3.index("BMW")
        # 9월 답변 3: Scope 가 첫 BMW(같은 엔티티)와 GV80(제네시스 롤업, 다른 엔티티)을 이미 잡음 → 첫 BMW 는 겹침, 둘째 BMW 만 더함
        await c.execute("""INSERT INTO ing.mention (run_month, job_id, ord, entity_id, mention_count) VALUES
                           ($1, $2, 1, $3, 1), ($1, $2, 2, $4, 1)""", SEP, J(3), E_BMW, E_TOY)
        await c.execute("""INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, turn_index, source_start, source_end,
                                                              surface_text, sentiment)
                           VALUES ($1, $2, 1, $3, 1, $4, $5, 'BMW', 'neutral'), ($1, $2, 2, $6, 1, 5, 9, 'GV80', 'neutral')""",
                        SEP, J(3), E_BMW, b1, b1 + 3, E_TOY)
        # 9월 답변 1: Scope 가 "EPIT"(끝쪽)을 다른 엔티티(Toyota)로 잡음 → 그 구간의 허브 Epit 발생은 겹침으로 빠짐
        e2 = BODIES[0][3].index("EPIT")
        await c.execute("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, mention_count) VALUES ($1, $2, 1, $3, 1)", SEP, J(1), E_TOY)
        await c.execute("""INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, turn_index, source_start, source_end,
                                                              surface_text, sentiment) VALUES ($1, $2, 1, $3, 1, $4, $5, 'EPIT', 'neutral')""",
                        SEP, J(1), E_TOY, e2, e2 + 4)
        # 6월 답변 5: 발생 행 없음(6~8월). Scope 언급 BMW 있음 → 존재만 인정(개수 불변), Kona 는 새 언급이지만 위치 모름
        await c.execute("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, mention_count) VALUES ($1, $2, 1, $3, 1)", JUN, J(5), E_BMW)
    finally:
        await c.close()
    lc = await db.connect()
    try:
        async with lc.transaction():
            rows = await rm.rematch_rows(lc, sorted(sid.values()))
            n = await rm.materialize_rematch(lc, sorted(sid.values()))
            tmp = await lc.fetch("SELECT job_id, entity_id, is_new, mention_count, starts FROM _ecat_rematch ORDER BY 1, 2")
    finally:
        await lc.close()
    got = {(r.job_id, r.mention.entity_id): r for r in rows}
    assert n == len(rows) == len(tmp)
    bmw3 = got[(J(3), E_BMW)]
    assert (bmw3.mention.is_new, bmw3.mention.mention_count, bmw3.mention.starts) == (False, 1, (t3.index("BMW", b1 + 1),))
    g3 = got[(J(3), E_GEN)]                                    # 제네시스(0) 는 Scope GV80(5..9) 와 안 겹침 → 새 언급, 위치 = 첫 발생 순위 1
    assert g3.mention.is_new and g3.positions_known and g3.mention.avg_position == 1.0 and g3.mention.sentiment_known is False
    ep1 = got[(J(1), E_EPIT)]
    assert ep1.mention.starts == (0,) and ep1.mention.mention_count == 1   # 끝쪽 EPIT 은 Scope 발생과 겹쳐 빠짐
    assert (J(5), E_BMW) not in got                            # 6월: 발생 없는 Scope 언급 = 존재만(개수 불변)
    k5 = got[(J(5), E_KONA)]
    assert k5.mention.is_new and not k5.positions_known and k5.mention.avg_position is None
    k4 = got[(J(4), E_KONA)]                                   # ACR 답변: 턴 2 로만 나온다
    assert k4.turn_index == 2
    assert all(r.turn_index == (2 if r.job_id == J(4) else 1) for r in rows)
    assert all(r.mention.sentiment_positive == r.mention.sentiment_negative == 0 for r in rows)


@needs_db
async def test_cli_and_input_errors(fresh_db):
    from ingest.cli import run

    sid = await _setup(fresh_db)
    db = _db(fresh_db)
    code, summary = await run(["ecat-scan", "--surface", str(sid["Kona"]), "--chunk", "4"], db=db)
    assert code == 0 and summary["status"] == "done" and summary["full_surfaces"] == [sid["Kona"]] and summary["answers_scanned"] == len(BODIES)
    code, summary = await run(["ecat-scan", "--surface", "999999"], db=db)
    assert code == 2 and "999999" in summary["error"]
    c = await _connect(fresh_db)
    try:
        g = await c.fetchval("""INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by)
                                VALUES (NULL, 'Plus', 'plus', $1) RETURNING surface_id""", ACTOR)
    finally:
        await c.close()
    with pytest.raises(ScanInputError):
        await scan(db, surface_ids=[g])


@needs_db
async def test_ensure_partitions_creates_hub_match_leaf(fresh_db):
    c = await _connect(fresh_db)
    try:
        await c.execute("SET ROLE loader")
        async with c.transaction():
            await ensure_partitions(c, dt.date(2027, 3, 15), ahead=0)
        assert await c.fetchval("SELECT to_regclass('ing.hub_match_202703')::text") == "ing.hub_match_202703"
    finally:
        await c.close()


# ── 적재 훅: pull 패스 = 새 답변·해시 변경 답변만 스캔 ────────────────────────
ROOT = "a0000000-0000-4000-8000-000000000001"
SP1 = "b0000000-0000-4000-8000-000000000001"
HY = "00000000-0000-0000-0000-000000000301"
R77 = "e0000000-0000-4000-8000-000000000077"
NOW = dt.datetime(2026, 9, 28, 6, 0, tzinfo=dt.UTC)


def _src(text: str) -> FakeScopeSource:
    job = make_job(str(J(101)), SP1, "chatgpt", "US", measured_at="2026-09-28T01:00:00Z", answer_text=text,
                   mentions=[mention(HY, "Hyundai", avg=1.0)])
    job2 = make_job(str(J(102)), SP1, "gemini", "US", measured_at="2026-09-28T01:05:00Z", answer_text="Kona only here",
                    mentions=[mention(HY, "Hyundai", avg=1.0)])
    return FakeScopeSource(
        projects={ROOT: {"project_id": ROOT, "regions": ["US", "KR"]}},
        prompts={ROOT: [{"prompt_id": SP1, "text": "best suv", "lang": "EN", "kind": "single", "updated_at": "2026-09-01T00:00:00Z"}]},
        runs={ROOT: [{"measurement_run_id": R77, "status": "completed", "total_jobs": 2, "targets": ["chatgpt", "gemini"], "regions": ["US"],
                      "started_at": "2026-09-28T00:30:00Z", "completed_at": "2026-09-28T02:10:00Z",
                      "cycle_anchor_at": "2026-09-28T00:30:00Z", "trigger": "schedule"}]},
        jobs={R77: [job, job2]}, page_size=5)


@needs_db
async def test_load_hook_scans_new_and_changed_answers(fresh_db):
    sid = await _setup(fresh_db, bodies=[])
    db = _db(fresh_db)
    rep = await run_pass(db, _src("Kona and BMW. Epit!"), project=ROOT, now=NOW, settings=IngestSettings(), alerts=MemoryAlertSink())
    assert [r.status for r in rep.runs] == ["committed"]
    lid1 = rep.runs[0].load_id
    q = "SELECT surface_id, job_id, starts, load_id FROM ing.hub_match ORDER BY 1, 2"
    got = await _rows(fresh_db, q)
    assert got == sorted([(sid["Kona"], J(101), [0], lid1), (sid["BMW"], J(101), [9], lid1), (sid["Epit"], J(101), [14], lid1),
                          (sid["Kona"], J(102), [0], lid1)])
    # 본문이 바뀐 답변(101)만 다시 스캔: 102 행은 load_id 그대로
    rep2 = await run_pass(db, _src("BMW, then Kona"), project=ROOT, now=NOW, settings=IngestSettings(), alerts=MemoryAlertSink(),
                          force=True)
    lid2 = rep2.runs[0].load_id
    assert rep2.runs[0].jobs_changed == 1 and lid2 != lid1
    assert await _rows(fresh_db, q) == sorted([(sid["BMW"], J(101), [0], lid2), (sid["Kona"], J(101), [10], lid2),
                                                (sid["Kona"], J(102), [0], lid1)])
    # 훅 결과 = 같은 본문을 CLI 로 전체 스캔한 결과(load_id 제외)
    before = await _rows(fresh_db)
    await scan(db, full=True)
    assert await _rows(fresh_db) == before
