"""접근 감사 배치 쓰기(core.write.AccessAuditWriter): 일시 DB 오류 뒤 버퍼 유지·백오프 재시도.

- 일시 오류(연결 실패 등)로 실패한 배치는 버퍼 앞에 되돌려(순서 유지) 다음 flush 에서 적재된다(이전: 로그만 남기고 유실).
- 버리는 것은 둘뿐: 되돌린 뒤 max_buffer 를 넘는 최신분, 다시 써도 같은 데이터·제약 오류(SQLSTATE 22·23) 배치(이전과 같은 유실).
- 실패 뒤 _run 은 batch 도달 신호에 깨지 않고 백오프(flush_s × 2^n, retry_max_s 상한)를 지킨다(장애 중 재시도 폭주 없음).
정상 경로(한 번에 적재)는 tests/core/test_db.py::test_access_audit_writer 가 그대로 덮는다.
"""
from __future__ import annotations

import asyncio
import uuid

from app.core import write
from app.core.db import fetch_val
from app.core.write import AccessAuditWriter
from tests.support import HQ_HYUNDAI, needs_db, principal


class _FlakyDb:
    """get_db() 대역: 처음 fail 번의 transaction() 은 일시 오류(연결 실패)를 던지고, 그 뒤는 실제 DB 로 넘긴다(real 이 없으면 계속 실패)."""

    def __init__(self, real=None, *, fail: int = 10**9, during=None):
        self.real, self.fail, self.during, self.calls = real, fail, during, 0

    def transaction(self, role: str):
        self.calls += 1
        if self.calls <= self.fail:
            if self.during is not None:          # 쓰기가 진행 중일 때 들어온 기록(요청 경로)을 흉내 낸다
                self.during()
            raise ConnectionRefusedError("db down")
        return self.real.transaction(role)


def _rec(w: AccessAuditWriter, target: str, role: str = "hq") -> None:
    w.record_actor(HQ_HYUNDAI, role, "data_access", "answer_body", target=target, request_id=uuid.uuid4())


async def _count(database, marker: str) -> int:
    async with database.read("admin_long") as c:
        return await fetch_val(c, "SELECT count(*) FROM app.access_audit_log WHERE target LIKE :m", {"m": f"{marker}%"})


@needs_db
async def test_transient_failure_keeps_buffer_then_retry_writes(database, monkeypatch):
    async with database.read("api_ro") as c:
        p = await principal(c, HQ_HYUNDAI)
    marker = str(uuid.uuid4())
    w = AccessAuditWriter(batch=2)
    for i in range(3):
        w.record(p, "data_access", "answer_body", target=f"{marker}:{i}")
    flaky = _FlakyDb(write.get_db(), fail=1)
    monkeypatch.setattr(write, "get_db", lambda: flaky)

    assert await w.flush() == 0                                      # 일시 오류: 이번 flush 는 멈춘다
    assert [e.target for e in w.pending()] == [f"{marker}:{i}" for i in range(3)]   # 버퍼 유지·순서 유지
    assert (w.written, w.dropped, w.failures) == (0, 0, 1)
    assert w.retry_delay() == w.flush_s * 2                          # 다음 시도는 백오프 뒤
    assert await _count(database, marker) == 0

    assert await w.flush() == 3                                      # 재시도로 전부 적재
    assert (w.written, w.dropped, w.failures, w.pending()) == (3, 0, 0, ())
    assert await _count(database, marker) == 3


async def test_requeue_over_cap_drops_only_newest(monkeypatch):
    w = AccessAuditWriter(batch=2, max_buffer=3)
    for t in ("a", "b", "c"):
        _rec(w, t)
    _rec(w, "x")                                                     # 상한 도달 뒤 새 기록은 종전대로 버린다
    assert w.dropped == 1
    flaky = _FlakyDb(during=lambda: (_rec(w, "d"), _rec(w, "e")))    # 쓰는 동안 2건 더 들어온다(버퍼 [c, d, e])
    monkeypatch.setattr(write, "get_db", lambda: flaky)

    assert await w.flush() == 0
    assert [e.target for e in w.pending()] == ["a", "b", "c"]        # 되돌린 배치(오래된 것)를 지키고 상한 넘는 최신분만 버린다
    assert (w.dropped, w.failures) == (1 + 2, 1)


@needs_db
async def test_data_error_batch_is_dropped_and_rest_written(database):
    marker = str(uuid.uuid4())
    w = AccessAuditWriter(batch=1)
    _rec(w, f"{marker}:ok1")
    _rec(w, f"{marker}:bad", role="not_a_role")                      # app.user_role 캐스트 실패(SQLSTATE 22P02): 다시 써도 같다
    _rec(w, f"{marker}:ok2")

    assert await w.flush() == 2
    assert (w.written, w.dropped, w.failures, w.pending()) == (2, 1, 0, ())   # 독 배치가 뒤 배치를 막지 않는다
    assert await _count(database, marker) == 2


def test_retry_delay_backoff_is_capped():
    w = AccessAuditWriter(flush_s=2.0, retry_max_s=60.0)
    seq = []
    for n in range(8):
        w.failures = n
        seq.append(w.retry_delay())
    assert seq == [2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0]


async def test_run_loop_backs_off_instead_of_hammering(monkeypatch):
    """DB 가 계속 실패하는 동안 batch 도달 신호가 쏟아져도 시도 횟수는 백오프로 묶이고, 기록은 버퍼에 남는다."""
    flaky = _FlakyDb()
    monkeypatch.setattr(write, "get_db", lambda: flaky)
    w = AccessAuditWriter(flush_s=0.01, batch=1, retry_max_s=0.05)
    w.start()
    recorded = 0
    for _ in range(80):                                              # 0.4초 동안 5ms 마다 1건(매번 batch 도달 → wake)
        _rec(w, "t")
        recorded += 1
        await asyncio.sleep(0.005)
    await w.stop()
    # 백오프 없이 wake 마다 재시도하면 ~80회. 0.02·0.04·0.05·0.05… 백오프면 0.4초에 10회 안팎(+ 정지 시 2회)
    assert 2 <= flaky.calls <= 20, flaky.calls
    assert len(w.pending()) == recorded and w.dropped == 0 and w.written == 0
