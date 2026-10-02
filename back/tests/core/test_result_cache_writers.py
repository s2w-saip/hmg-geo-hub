"""결과 캐시 누락 방지(쓰기 쪽, DB 없음): rd 에 쓰는 모든 문장의 대상 표·위치를 소스에서 모아(tests/core/rcache_writers.py) 분류를 강제한다.

- 세대만으로 덮는 표(GENERATION_ONLY)에 쓰는 위치는 전부 FINALIZE_WRITERS(파일·기호 허용 목록, 근거 = 같은 트랜잭션 finalize 로 세대 +1)에
  있어야 한다. 새 쓰기 위치가 생기면 여기서 멈춘다(트리거 카운터 표 TRACKED 는 요구에서 빠진다: 어느 경로로 바뀌어도 버전이 오른다).
- 그 SQL 상수를 참조하는 함수 = WRITER_FUNCS 뿐, WRITER_FUNCS 의 호출 사슬(ingest 안)은 finalize 를 부르는 적재 트랜잭션 함수에서 끝난다.
- 그 밖에 쓰이는 rd 표는 TRACKED·세대 원천·NOT_CACHED(캐시 대상이 읽지 않음, 조회 쪽 시험이 겹침 0 을 단언) 중 하나여야 한다.
- 음성 시험: 새 함수가 rd.answer 에 쓰면·분류를 빼면·finalize 없는 호출 사슬이 생기면 잡는다.
"""
from __future__ import annotations

import pathlib
import textwrap

import pytest

from tests.core import rcache_writers as w


def _classify(writes: list[w.Write], tracked: frozenset[str]) -> tuple[list[w.Write], list[w.Write]]:
    """(분류 안 된 세대 전용 쓰기, 어느 분류에도 없는 표 쓰기)."""
    unclassified = [x for x in writes if x.table in w.GENERATION_ONLY and (x.path, x.symbol) not in w.FINALIZE_WRITERS]
    unknown = [x for x in writes if x.table not in w.GENERATION_ONLY and x.table not in tracked and x.table not in w.GENERATION_SOURCE
               and x.table not in w.NOT_CACHED]
    return unclassified, unknown


def test_rd_write_locations_are_classified():
    writes = w.collect()
    tracked = w.tracked_tables()
    assert len(writes) > 40 and {x.via for x in writes} >= {"sql", "regex", "fn:rd.propagate_answer_gates"}
    unclassified, unknown = _classify(writes, tracked)
    assert unclassified == [], "세대 전용 표에 분류 안 된 쓰기 위치(같은 트랜잭션 finalize 근거를 FINALIZE_WRITERS 에 적거나 표를 P67 트리거로): " + \
        "; ".join(f"{x.table} {x.path}:{x.symbol}:{x.line}" for x in unclassified)
    assert unknown == [], "분류 없는 rd 표 쓰기: " + "; ".join(f"{x.table} {x.path}:{x.symbol}" for x in unknown)
    used = {(x.path, x.symbol) for x in writes if x.table in w.GENERATION_ONLY}
    assert set(w.FINALIZE_WRITERS) == used, ("죽은 분류", sorted(set(w.FINALIZE_WRITERS) - used))
    src = [x for x in writes if x.table in w.GENERATION_SOURCE]
    assert {(x.path, x.symbol) for x in src} == {("ingest/common/db.py", "finalize")}      # 세대는 finalize 만 올린다
    assert not (set(w.GENERATION_ONLY) & tracked) and not (set(w.NOT_CACHED) & tracked)
    assert all(t.startswith(("app.", "rd.", "frz.")) for t in tracked) and len(tracked) == 26 + 3 + 1 + 1 + 1 + 1    # + DB-v2.16(WU-7) 3표 + DB-v2.20 1표 + DB-v2.21 frz.generation + DB-v2.25 엔티티 합계 + DB-v2.30 창 판정 기초


def test_generation_writers_only_run_inside_finalize_transactions():
    """세대 전용 쓰기 상수는 WRITER_FUNCS 만 참조하고, 그 함수들의 호출 사슬은 finalize 를 부르는 적재 트랜잭션 함수에서 끝난다."""
    consts = {s for (_, s) in w.FINALIZE_WRITERS if s.isupper()}
    users = w.const_users(consts)
    stray = {c: sorted(u - w.WRITER_FUNCS) for c, u in users.items() if u - w.WRITER_FUNCS}
    assert stray == {}, stray
    assert all(users[c] for c in consts), [c for c in consts if not users[c]]
    fn_writers = {(p, s) for (p, s) in w.FINALIZE_WRITERS if not s.isupper()}
    assert fn_writers <= w.WRITER_FUNCS
    assert all(w.calls_finalize(k) for k in w.FINALIZE_CALLERS), [k for k in w.FINALIZE_CALLERS if not w.calls_finalize(k)]
    assert w.unfinalized_paths(set(w.WRITER_FUNCS), set(w.FINALIZE_CALLERS)) == []


def test_db_function_writes_are_seen():
    fns = w.db_function_writes()
    assert fns["propagate_answer_gates"] >= {"rd.job", "rd.citation"}
    assert "today_kst" not in fns


# ── 음성 시험 ────────────────────────────────────────────────────────────────
def _fake_repo(tmp: pathlib.Path, files: dict[str, str]) -> pathlib.Path:
    for rel, body in files.items():
        f = tmp / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(textwrap.dedent(body), encoding="utf-8")
    return tmp


def test_scanner_catches_new_unclassified_writer(tmp_path):
    base = _fake_repo(tmp_path, {
        "ingest/x/queries.py": '''
            FIX = "UPDATE rd.answer a SET is_rep = true WHERE a.answer_key = $1"
            ''',
        "ingest/x/service.py": '''
            async def backfill(conn):
                await conn.execute("DELETE FROM rd.citation WHERE answer_key = ANY($1)", [])
                await conn.execute(f"INSERT INTO rd.{'job'} SELECT 1")
                await conn.execute("SELECT rd.propagate_answer_gates($1)", [])
                await conn.copy_records_to_table("answer_brand", records=[], schema_name="rd")
            ''',
        "ingest/x/tests/test_y.py": '''
            SQL = "DELETE FROM rd.answer"
            ''',
    })
    writes = w.collect(base=base, roots=("ingest",))
    got = {(x.table, x.path, x.symbol, x.via.split(":")[0]) for x in writes}
    assert ("rd.answer", "ingest/x/queries.py", "FIX", "sql") in got
    assert ("rd.citation", "ingest/x/service.py", "backfill", "sql") in got
    assert ("rd.job", "ingest/x/service.py", "backfill", "fn") in got                     # DB 함수 경유
    assert ("rd.answer_brand", "ingest/x/service.py", "backfill", "copy") in got
    assert not any(x.path.endswith("test_y.py") for x in writes)                          # 시험 코드 제외
    unclassified, _ = _classify(writes, frozenset())
    assert {(x.path, x.symbol) for x in unclassified} >= {("ingest/x/queries.py", "FIX"), ("ingest/x/service.py", "backfill")}


def test_classification_removal_is_caught(monkeypatch):
    key = ("ingest/project/apply/queries.py", "INSERT_JOB")
    monkeypatch.delitem(w.FINALIZE_WRITERS, key)
    with pytest.raises(AssertionError, match="INSERT_JOB"):
        test_rd_write_locations_are_classified()


def test_unfinalized_call_chain_is_caught(tmp_path):
    base = _fake_repo(tmp_path, {
        "ingest/a/service.py": '''
            async def project(conn):
                pass
            async def load(conn):
                await project(conn)
                await finalize(conn, None)
            async def cli_repair(conn):
                await project(conn)
            ''',
    })
    writers = {("ingest/a/service.py", "project")}
    ok = {("ingest/a/service.py", "load")}
    assert w.calls_finalize(("ingest/a/service.py", "load"), base=base)
    assert w.unfinalized_paths(writers, ok, base=base) == [["ingest/a/service.py:project", "ingest/a/service.py:cli_repair"]]
