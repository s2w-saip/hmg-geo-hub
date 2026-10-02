"""DB-v2.19 P107 ing.answer_mirror_time·P108 rd.rep_order_at(현행 카드 셀 대표 정렬 시각, 동결 스냅샷 층이 쓴다: 제품 결정 31) 채우기 시험.
커밋하는 시험이라 일회 DB(fresh_db). rd.answer.is_rep 에는 쓰지 않는다(is_rep = 답변분석 경로 규칙: tests/core/test_rep_seat.py).

  ① 핀 접기 식: 픽스처 핀(job 17, 앵커 09-07)·새 핀(JR 역할 = job 9, 앵커 09-13)이 있는 답변은 미러 값 = 원본을 날짜만 앵커로 접은 값
  ② fill-v219.sql: mig_src 미러 사본(핀 접기 값, job 9 만 그 식으로 재현되지 않는 값)에서 예외만 채우고(드라이런은 쓰지 않는다) 단언·멱등.
  ③ 채운 뒤 rd.answer.is_rep 은 그대로(미러 시각 배선 없음).
"""
from __future__ import annotations

import pathlib
import uuid

import asyncpg

from tests.dbforward import run_psql_file
from tests.support import needs_db

BACK = pathlib.Path(__file__).resolve().parents[4]
FILL_V219 = BACK / "migration" / "fill-v219.sql"
J9 = uuid.UUID("90000000-0000-4000-8000-000000000009")


@needs_db
async def test_fill_v219_inserts_only_exceptions(fresh_db):
    c = await asyncpg.connect(fresh_db)
    try:
        await c.execute(f"""INSERT INTO ing.answer_anchor_pin (job_id, anchor, reason) VALUES ('{J9}', DATE '2026-09-13', 'test: 현행 미러 접기')""")
        reps0 = await c.fetch("SELECT answer_key, is_rep FROM rd.answer ORDER BY 1")
        # 미러 사본 흉내 = 현행 미러 정의(핀이 있으면 날짜만 앵커로 접은 값, 아니면 원본). job 9 만 그 식으로 재현되지 않는 값(예외)
        await c.execute("""CREATE SCHEMA IF NOT EXISTS mig_src;
                           CREATE TABLE mig_src.scope_answers AS
                           SELECT a.job_id, rd.rep_order_at(a.measured_at, NULL, p.anchor) AS measured_at
                             FROM ing.answer a LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id""")
        await c.execute("UPDATE mig_src.scope_answers SET measured_at = TIMESTAMPTZ '2026-09-16 00:00+00' WHERE job_id = $1", J9)
        folded = await c.fetchval("""SELECT count(*) FROM ing.answer a JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
                                      WHERE rd.rep_order_at(a.measured_at, NULL, p.anchor) IS DISTINCT FROM a.measured_at""")
        assert folded >= 2                                                                    # job 17(픽스처 핀)·job 9
        dry = await run_psql_file(c, FILL_V219, {})
        head = dry[0][0]
        assert (head["mirror_differs"], head["by_pin_fold"], head["outside_pins"], head["exceptions"], head["already"]) == (folded, folded - 1, 0, 1, 0)
        assert await c.fetchval("SELECT count(*) FROM ing.answer_mirror_time") == 0          # 드라이런은 쓰지 않는다
        out = await run_psql_file(c, FILL_V219, {"commit": "1"})
        assert out[-1][0]["mirror_time_rows"] == 1 and await c.fetchval("SELECT job_id FROM ing.answer_mirror_time") == J9
        out = await run_psql_file(c, FILL_V219, {"commit": "1"})                             # 멱등
        assert out[-1][0]["mirror_time_rows"] == 1
        # 정렬 시각 = 예외 > 핀 접기 > 원본(스냅샷 층이 쓰는 식), is_rep 은 그대로
        got = await c.fetchval("""SELECT rd.rep_order_at(a.measured_at, t.measured_at, p.anchor) FROM ing.answer a
                                    LEFT JOIN ing.answer_mirror_time t ON t.job_id = a.job_id LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
                                   WHERE a.job_id = $1""", J9)
        assert got.isoformat().startswith("2026-09-16T00:00:00")
        assert await c.fetch("SELECT answer_key, is_rep FROM rd.answer ORDER BY 1") == reps0
    finally:
        await c.close()
