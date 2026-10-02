"""WU-12 답변분석 경로 셀 대표(현행 프로필 rep_round_date_cell, DB-v2.19 P109·P110): 재투영(fill-v219-rep.sql)·원장 숨김 훅. 커밋하는 시험이라 일회 DB(fresh_db).

시나리오: 픽스처 회차 11(09-14) 셀(prompt 01·chatgpt·US, 대표 job 9 = 09-14 05:00)을 같은 자리(round_date)의 회차 9911 로 복제하고 더 이른 측정 J9'(04:00)을
둔다. 회차 셀 규칙(전환 전 stg 상태)이면 두 회차 셀 대표가 둘 다 대표(J9'·job 9), 답변분석 규칙(round_date 셀)이면 job 9 하나.
  ① fill-v219-rep.sql: 드라이런 = 규칙과 다른 is_rep 1(J9'), 커밋 = J9' 내려감·단언 통과, 두 번째 실행 = 부모 갱신 0(멱등)
  ② 운영 숨김(handle_cycle_admin hide citations, 회차 11) → 원장 투영 훅(_reselect_changed_seats)이 그 자리를 다시 고른다:
     언급 대표 = job 9 그대로, 인용 계열 대표 = J9'(인용 숨김 회차 11 이 후보에서 빠짐) → 보정 표 rd.rep_cit_delta = {J9'}, 단언 통과.
     숨김 해제 → 보정 행이 사라진다.
"""
from __future__ import annotations

import pathlib
import uuid

import asyncpg

from app.core.config import set_settings
from ingest.common.db import LoaderDB
from ingest.cycles.ledger.service import handle_cycle_admin
from ingest.project.apply.tests.test_equivalence import _ctx
from ingest.project.apply.tests.test_incr_parity import PROFILE, _on
from tests.dbforward import run_psql_file
from tests.support import needs_db

BACK = pathlib.Path(__file__).resolve().parents[4]
FILL_REP = BACK / "migration" / "fill-v219-rep.sql"
J9 = uuid.UUID("90000000-0000-4000-8000-000000000009")
J9B = uuid.UUID("90000000-0000-4000-8000-0000000099b8")
CLONE = f"""
INSERT INTO rd.cycle SELECT (jsonb_populate_record(NULL::rd.cycle, to_jsonb(c) || jsonb_build_object(
    'cyc_key', 9911, 'cycle_id', '00000000-0000-4000-8000-000000009911'))).* FROM rd.cycle c WHERE c.cyc_key = 11;
INSERT INTO rd.job SELECT (jsonb_populate_record(NULL::rd.job, to_jsonb(j) || jsonb_build_object(
    'answer_key', 999002, 'job_id', '{J9B}', 'cyc_key', 9911, 'measured_at', '2026-09-14T04:00:00+00:00'))).* FROM rd.job j WHERE j.job_id = '{J9}';
"""


async def _state(c: asyncpg.Connection) -> tuple[dict, set]:
    reps = dict(await c.fetch("SELECT j.job_id, a.is_rep FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key WHERE j.job_id = ANY($1::uuid[])",
                              [J9, J9B]))
    delta = {r[0] for r in await c.fetch("SELECT j.job_id FROM rd.rep_cit_delta d JOIN rd.job j ON j.answer_key = d.answer_key")}
    return reps, delta


@needs_db
async def test_fill_v219_rep_and_ledger_hide_hook(settings, fresh_db):
    assert PROFILE.rep_round_date_cell
    c = await asyncpg.connect(fresh_db)
    try:
        await run_psql_file(c, FILL_REP, {"commit": "1"})                              # 픽스처 전체를 먼저 답변분석 규칙으로(기준선)
        async with c.transaction():
            await c.execute(CLONE)
            cols = await c.fetchval("SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute "
                                    "WHERE attrelid = 'rd.answer'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
            await c.execute(f"""INSERT INTO rd.answer ({cols}) SELECT {cols} FROM (
                SELECT (jsonb_populate_record(NULL::rd.answer, to_jsonb(a) || jsonb_build_object('answer_key', 999002, 'cyc_key', 9911, 'is_rep', true))).*
                  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key WHERE j.job_id = '{J9}') x""")
        assert await _state(c) == ({J9: True, J9B: True}, set())                        # 전환 전: 회차 셀마다 대표

        # ① 재투영
        dry = await run_psql_file(c, FILL_REP, {})
        head = dry[1][0]
        assert (head["is_rep_differs"], head["delta_cit_expected"], head["delta_cit_rows_now"]) == (1, 0, 0)
        assert await _state(c) == ({J9: True, J9B: True}, set())                        # 드라이런은 쓰지 않는다
        notes: list[str] = []
        c.add_log_listener(lambda _c, m: notes.append(m.message))
        await run_psql_file(c, FILL_REP, {"commit": "1", "full_assert": "1"})
        assert any(m.startswith("fill-v219-rep 끝") for m in notes)
        assert await _state(c) == ({J9: True, J9B: False}, set())                       # 답변분석 = 자리 셀 최신 job 9
        notes.clear()
        await run_psql_file(c, FILL_REP, {"commit": "1"})
        assert [m for m in notes if m.startswith("fill-v219-rep 끝")][-1].endswith(", 부모 갱신 0, 자식 갱신 0")
        cyc11 = await c.fetchval("SELECT cycle_id FROM rd.cycle WHERE cyc_key = 11")
    finally:
        await c.close()

    # ② 원장 숨김 훅(적재 롤 + 프로필 켬, 운영 요청 경로)
    _on(settings)
    try:
        for op, want in ((("hide", "citations"), ({J9: True, J9B: False}, {J9B})), (("unhide", None), ({J9: True, J9B: False}, set()))):
            ld = await LoaderDB(fresh_db, role="loader").connect()
            try:
                async with ld.transaction():
                    ctx = await _ctx(ld)
                    await handle_cycle_admin(ld, ctx, {"cycle_id": str(cyc11), "op": op[0], "hidden_scope": op[1], "reason": "operator"})
                    assert ctx.rd_changed and 1 in ctx.surfaces                         # 같은 트랜잭션 finalize 가 세대를 올린다
            finally:
                await ld.close()
            c = await asyncpg.connect(fresh_db)
            try:
                assert await _state(c) == want, op
                assert await c.fetchval("SELECT rd.assert_rep_seat(NULL, NULL, NULL, NULL)") > 0
            finally:
                await c.close()
    finally:
        set_settings(settings)
