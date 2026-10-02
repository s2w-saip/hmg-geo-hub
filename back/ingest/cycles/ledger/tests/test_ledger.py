"""IG-3 회차 원장: 좌석 배정(R02)·귀속·재평가(R01·R08)·운영 요청 처리.

모든 쓰기는 loader 롤 트랜잭션 안이고 끝에 롤백한다. 기대값은 손계산(날짜 산술)과 bulk 시드 대조(앵커 고정·드롭).
"""
from __future__ import annotations

import datetime as dt
import uuid

import asyncpg
import pytest

from ingest.common.db import LoadContext, LoaderDB, current_rule_ver
from ingest.cycles.ledger import service as L
from ingest.project.apply.service import reproject
from ingest.testkit import EQ_TABLES, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, needs_db

from .gate_support import gate_catalog

ROOT = uuid.UUID("a0000000-0000-4000-8000-000000000001")
SITE = uuid.UUID("a0000000-0000-4000-8000-000000000002")
CUST = uuid.UUID("a0000000-0000-4000-8000-000000000003")
C12 = uuid.UUID("f0000000-0000-4000-8000-000000000012")
C11 = uuid.UUID("f0000000-0000-4000-8000-000000000011")
C21 = uuid.UUID("f0000000-0000-4000-8000-000000000021")


def test_canonical_neighbours():
    """hmg_round_prev/next_canonical 자가검증 값(0077:395-402)과 같다."""
    assert L.prev_canonical(dt.date(2026, 9, 17), 5) == dt.date(2026, 9, 11)
    assert L.next_canonical(dt.date(2026, 9, 17), 5) == dt.date(2026, 9, 18)
    assert L.prev_canonical(dt.date(2026, 9, 18), 5) == dt.date(2026, 9, 11)
    assert L.next_canonical(dt.date(2026, 9, 18), 5) == dt.date(2026, 9, 25)
    assert L.prev_canonical(dt.date(2026, 9, 14), 1) == dt.date(2026, 9, 7)
    assert L.canonical_dow("global") == 1 and L.canonical_dow("website") == 5 and L.canonical_dow("project") is None


class _Tx:
    """loader 롤 연결 + 롤백 트랜잭션."""

    async def __aenter__(self) -> tuple[asyncpg.Connection, LoadContext]:
        self.c = await LoaderDB(DB_URL, role="loader").connect()
        self.tr = self.c.transaction()
        await self.tr.start()
        rv = await current_rule_ver(self.c)
        lid = await self.c.fetchval("INSERT INTO ing.load (kind, rule_ver) VALUES ('cycle_admin', $1) RETURNING load_id", rv)
        return self.c, LoadContext(load_id=int(lid), kind="cycle_admin", rule_ver=rv)

    async def __aexit__(self, *exc) -> None:
        await self.tr.rollback()
        await self.c.close()


@needs_db
async def test_seat_assignment_rules():
    async with _Tx() as (c, _):
        # 정규 요일(글로벌 월)
        assert await L.assign_seat(c, ROOT, "global", dt.date(2026, 9, 28)) == (dt.date(2026, 9, 28), "canonical")
        # 수요일 09-23: 앞 자리 09-21 은 회차 12 가 차지, 뒤 자리 09-28 은 방금 앉음 → 둘 다 참 → 가까운 쪽(앞 2일) 합침
        assert await L.assign_seat(c, ROOT, "global", dt.date(2026, 9, 23)) == (dt.date(2026, 9, 21), "merged")
        # 금요일 10-02: 앞 09-28 참·뒤 10-05 빈 → next_empty
        assert await L.assign_seat(c, ROOT, "global", dt.date(2026, 10, 2)) == (dt.date(2026, 10, 5), "next_empty")
        # 웹사이트(금) 목 10-08: 앞 10-02·뒤 10-09 모두 빈 → 가까운 뒤(1일) nearest
        assert await L.assign_seat(c, SITE, "website", dt.date(2026, 10, 8)) == (dt.date(2026, 10, 9), "nearest")
        # 웹사이트 월 09-21: 앞 09-18 은 회차 21, 뒤 09-25 빈 → next_empty
        assert await L.assign_seat(c, SITE, "website", dt.date(2026, 9, 21)) == (dt.date(2026, 9, 25), "next_empty")
        # 과거 배정은 재계산하지 않는다(매핑 있으면 그대로)
        assert await L.assign_seat(c, ROOT, "global", dt.date(2026, 9, 23)) == (dt.date(2026, 9, 21), "merged")
        # 프로젝트 표면은 정규 요일이 없다
        assert await L.assign_seat(c, CUST, "project", dt.date(2026, 9, 23)) == (dt.date(2026, 9, 23), "project")


async def _run(c: asyncpg.Connection, rid: str, pid: uuid.UUID, *, anchor: str | None, started: str | None, measured: str | None = None,
               status: str = "completed") -> uuid.UUID:
    run_id = uuid.UUID(rid)
    await c.execute("""INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at)
                       VALUES ($1, $2, '2026-09-01', $3, 1, $4, $5)""", run_id, pid, status,
                    dt.datetime.fromisoformat(started) if started else None, dt.datetime.fromisoformat(anchor) if anchor else None)
    if measured:
        jid = uuid.uuid4()
        k = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
        await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, content_hash, load_id)
                           VALUES ('2026-09-01', $1, $2, $3, 'b0000000-0000-4000-8000-000000000031', 'chatgpt', 'US', 'completed', $4, '\\x00', 1)""",
                        jid, k, run_id, dt.datetime.fromisoformat(measured))
    return run_id


@needs_db
async def test_attribute_existing_late_derived_and_new():
    async with _Tx() as (c, ctx):
        r_open = await _run(c, "e1000000-0000-4000-8000-000000000001", ROOT, anchor="2026-09-21T00:30:00+00:00", started="2026-09-21T03:00:00+00:00")
        r_late = await _run(c, "e1000000-0000-4000-8000-000000000002", ROOT, anchor="2026-09-14T00:30:00+00:00", started="2026-09-22T00:00:00+00:00")
        r_new = await _run(c, "e1000000-0000-4000-8000-000000000003", ROOT, anchor="2026-09-28T00:30:00+00:00", started="2026-09-28T00:30:00+00:00")
        d1 = await _run(c, "e1000000-0000-4000-8000-000000000004", CUST, anchor=None, started="2026-09-24T01:00:00+00:00",
                        measured="2026-09-24T02:00:00+00:00")
        d2 = await _run(c, "e1000000-0000-4000-8000-000000000005", CUST, anchor=None, started="2026-09-24T05:00:00+00:00",
                        measured="2026-09-24T06:00:00+00:00")
        touched = await L.attribute(c, ctx, [r_open, r_late, r_new, d1, d2])
        got = {r["run_id"]: (r["cycle_id"], r["attributed_by"]) for r in await c.fetch(
            "SELECT run_id, cycle_id, attributed_by FROM ing.cycle_run WHERE run_id = ANY($1::uuid[])", [r_open, r_late, r_new, d1, d2])}
        assert got[r_open] == (C12, "scope")
        assert got[r_late] == (C11, "late")                                         # 발행 회차에 늦게 붙음
        assert await c.fetchval("SELECT stale_since IS NOT NULL FROM ing.cycle WHERE cycle_id = $1", C11)
        new = await c.fetchrow("SELECT * FROM ing.cycle WHERE cycle_id = $1", got[r_new][0])
        assert (new["anchor_source"], new["anchor_date"], new["round_date"], new["status"], new["origin"]) == \
            ("scope", dt.date(2026, 9, 28), dt.date(2026, 9, 28), "open", "loader")
        assert got[d1][0] == got[d2][0] and got[d1][1] == "derived"                 # 같은 KST 측정일 파생 회차 하나
        dc = await c.fetchrow("SELECT * FROM ing.cycle WHERE cycle_id = $1", got[d1][0])
        assert dc["anchor_source"] == "derived" and dc["cycle_anchor_at"] == dt.datetime(2026, 9, 24, 2, tzinfo=dt.UTC)
        assert dc["round_date"] == dt.date(2026, 9, 24)                             # 프로젝트 표면 = 앵커 날짜
        assert touched == {C12, C11, got[r_new][0], got[d1][0]}
        # 결정론적 cycle_id(seed-20 §7-4 와 같은 재료)
        assert got[r_new][0] == await c.fetchval(
            "SELECT md5('derived|' || $1::text || '|' || (extract(epoch FROM $2::timestamptz) * 1000000)::bigint::text)::uuid",
            str(ROOT), dt.datetime(2026, 9, 28, 0, 30, tzinfo=dt.UTC))


@needs_db
async def test_reevaluate_close_arms_and_publish():
    now = dt.datetime(2026, 10, 10, tzinfo=dt.UTC)
    async with _Tx() as (c, ctx):
        # (a) 다음 앵커 ∧ 멤버: 회차 12(09-21) 뒤에 새 회차(09-28)를 연다
        r = await _run(c, "e1000000-0000-4000-8000-000000000011", ROOT, anchor="2026-09-28T00:30:00+00:00", started="2026-09-28T00:30:00+00:00")
        await L.attribute(c, ctx, [r])
        c28 = await c.fetchval("SELECT cycle_id FROM ing.cycle_run WHERE run_id = $1", r)
        # (b) 100% ∧ 정온: 프로젝트 가상 회차 31(셀 1/1 완료, 멤버 run 31 started 09-20 = 36h 밖) → 닫힘 → 프로젝트는 바로 노출
        # 정온 미충족(started NULL) 회차: 새 run 은 started_at 을 비운다
        rn = await _run(c, "e1000000-0000-4000-8000-000000000012", SITE, anchor="2026-10-09T00:30:00+00:00", started=None)
        await L.attribute(c, ctx, [rn])
        cnull = await c.fetchval("SELECT cycle_id FROM ing.cycle_run WHERE run_id = $1", rn)
        f31 = uuid.UUID("f0000000-0000-4000-8000-000000000031")
        out = await L.reevaluate(c, ctx, [C12, c28, f31, cnull], now=now)
        st = {r["cycle_id"]: r for r in await c.fetch("SELECT * FROM ing.cycle WHERE cycle_id = ANY($1::uuid[])", [C12, c28, f31, cnull])}
        assert st[C12]["status"] == "closed" and st[C12]["closed_by"] == "next_anchor"
        assert st[C12]["closed_at"] == dt.datetime(2026, 9, 28, 0, 30, tzinfo=dt.UTC)
        assert st[c28]["status"] == "closed" and st[c28]["closed_by"] == "recheck_window"
        assert st[f31]["status"] == "published" and st[f31]["closed_by"] == "complete"
        assert st[f31]["view_anchor_at"] == dt.datetime(2026, 9, 20, 15, tzinfo=dt.UTC)    # (09-20 + 1) KST 자정
        assert st[cnull]["status"] == "open"                                        # started_at NULL 이면 닫지 않는다
        # 회차 12: 결손 비율(완료 2 중 결손 2 → 0) < 0.95 → 발행 안 함(R08). 카운터는 소속 run 답변으로 다시 셈
        assert st[C12]["completed_answers"] == 2 and st[C12]["gap_answers"] == 2 and st[C12]["analysis_done_ratio"] == 0
        assert C12 in out["closed"] and f31 in out["published"] and C12 not in out["published"]
        rc = await c.fetchrow("SELECT status, servable, view_date FROM rd.cycle WHERE cycle_id = $1", C12)
        assert (rc["status"], rc["servable"]) == (1, False)
        # 창 판정 기초(DB-v2.30): 투영과 같은 트랜잭션에서 판정 갭 = 허브 카운터 round(2 / 2) = 1(현행 isGeneratorSkipped 면제 쪽)
        pb_sql = ("SELECT p.gap_ratio, p.gap_src, p.fleet_visible FROM rd.cycle_pick_basis p JOIN rd.cycle r ON r.cyc_key = p.cyc_key "
                  "WHERE r.cycle_id = $1")
        assert tuple(await c.fetchrow(pb_sql, C12)) == (1, "hub", True)
        # R08 충족: 결손 0 으로 만들면 분석 비율은 통과. 발행 게이트(DB-v2.14): 이관 회차 12 는 계획이 없어 재평가가 backfill 계획을 만들었는데
        # 픽스처 카탈로그의 created_at 이 앵커(09-21)보다 늦어 계획이 비었다 → blocked. 카탈로그를 앵커 전 등록·시장 US 로 두고 계획을 다시 만든 뒤
        # 빠진 유닛을 봉인하면 발행 + 노출일 = 앵커 + 2일(글로벌) KST 자정
        await c.execute("UPDATE ing.answer SET n_mentions = 1 WHERE run_id = 'e0000000-0000-4000-8000-000000000005'")
        out = await L.reevaluate(c, ctx, [C12], now=now)
        g12 = await c.fetchrow("SELECT plan_source, plan_units, verdict, quiet FROM ing.cycle_gate WHERE cycle_id = $1", C12)
        assert tuple(await c.fetchrow(pb_sql, C12)) == (0, "hub", True)              # 결손 0 = 생성 대기(닫힘 ∧ 갭 ≤ 0.05) = 현행 구멍 쪽
        assert (g12["plan_source"], g12["plan_units"], g12["verdict"], g12["quiet"]) == ("backfill", 0, "blocked", False)
        assert await c.fetchval("SELECT status FROM ing.cycle WHERE cycle_id = $1", C12) == "closed"
        await gate_catalog(c)
        await c.execute("DELETE FROM ing.cycle_gate WHERE cycle_id = $1", C12)
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C12), "op": "seal", "reason": "test seal"}, change_id=7)
        out = await L.reevaluate(c, ctx, [C12], now=now)
        row = await c.fetchrow("SELECT status, view_anchor_at, analysis_done_ratio FROM ing.cycle WHERE cycle_id = $1", C12)
        assert row["status"] == "published" and row["analysis_done_ratio"] == 1
        assert row["view_anchor_at"] == dt.datetime(2026, 9, 22, 15, tzinfo=dt.UTC)
        rc = await c.fetchrow("SELECT status, servable, view_date FROM rd.cycle WHERE cycle_id = $1", C12)
        assert (rc["status"], rc["servable"], rc["view_date"]) == (2, True, dt.date(2026, 9, 23))


@needs_db
async def test_cycle_admin_ops_and_bad_payload():
    async with _Tx() as (c, ctx):
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C11), "op": "hide", "hidden_scope": "citations", "reason": "collection_error"})
        r = await c.fetchrow("SELECT hidden_scope, hidden_reason FROM rd.cycle WHERE cycle_id = $1", C11)
        assert (r["hidden_scope"], r["hidden_reason"]) == (2, 1)
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C11), "op": "unhide"})
        assert await c.fetchval("SELECT hidden_scope FROM rd.cycle WHERE cycle_id = $1", C11) == 0
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C11), "op": "set_view_date", "view_date": "2026-09-30"})
        assert await c.fetchval("SELECT view_date FROM rd.cycle WHERE cycle_id = $1", C11) == dt.date(2026, 9, 30)
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C12), "op": "close"})
        assert await c.fetchval("SELECT closed_by FROM ing.cycle WHERE cycle_id = $1", C12) == "operator"
        assert ctx.rd_changed and 1 in ctx.surfaces
        for bad in ({"op": "hide"}, {"cycle_id": str(C11), "op": "explode"}, {"cycle_id": str(uuid.uuid4()), "op": "close"},
                    {"cycle_id": str(C11), "op": "hide", "hidden_scope": "everything"}, {"cycle_id": str(C11), "op": "set_view_date"}):
            with pytest.raises(L.BadRequest):
                await L.handle_cycle_admin(c, ctx, bad)


@needs_db
async def test_report_publication_replaces_round():
    async with _Tx() as (c, ctx):
        # 09-18 발행을 새 판으로 교체(file_seq 101 값 변경·102 삭제): 옛 판 superseded, 새 판 active
        await c.execute("RESET ROLE")
        new_id = uuid.UUID("c9000000-0000-4000-8000-0000000000aa")
        await c.execute("UPDATE app.report_publication SET status = 'superseded', superseded_by = $1 WHERE id = 'c9000000-0000-4000-8000-000000000001'", new_id)
        await c.execute("""INSERT INTO app.report_publication (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version, status)
                           VALUES ($1, 'rep-0918-v2', 'website', 'all', 'v2', '2026-09-18', 'z.xlsx', 'f00d', 'v', 'active')""", new_id)
        await c.execute("""INSERT INTO app.report_site_fact (publication_id, file_seq, brand, country_code, lang_code, in_headline_pool, target_hit_prompts,
                           measured_prompts, owned_prompts, owned_prompts_den, raw) VALUES ($1, 101, 'Kia', 'DE', 'de', true, 9, 10, 9, 10, '{}')""", new_id)
        await c.execute("SET ROLE loader")
        n = await L.handle_report_publication(c, ctx, [new_id], None)
        rows = await c.fetch("SELECT file_seq, pub_id, target_hit_prompts FROM rd.report_unit_value WHERE round_date = '2026-09-18' ORDER BY file_seq")
        assert n == 1 and [(r["file_seq"], r["pub_id"], r["target_hit_prompts"]) for r in rows] == [(101, new_id, 9)]
        assert await c.fetchval("SELECT count(*) FROM rd.report_unit_value WHERE round_date = '2026-09-25'") == 1   # 다른 회차 불변
        with pytest.raises(L.BadRequest):
            await L.handle_report_publication(c, ctx, [], {})


async def _bulk_ref(sql: str) -> dict:
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(sql)
        await bulk_seed(c)
        s = await snapshot(c, EQ_TABLES)
        await tr.rollback()
        return s
    finally:
        await c.close()


@needs_db
@pytest.mark.parametrize("case", ["pin", "drop", "restore"])
async def test_pin_drop_reproject_equals_bulk(case):
    """앵커 고정·드롭(ing 레지스트리) → IG-2 재투영 = 같은 레지스트리로 돌린 bulk 시드."""
    j5 = "90000000-0000-4000-8000-000000000005"
    j14 = "90000000-0000-4000-8000-000000000014"
    reg = {
        # 레지스트리 행은 운영 요청 처리기(handle_anchor_pin·handle_answer_drop)가 쓰는 값과 같게(origin 'operator'): 현행 프로필
        # resub_phantom_exclude 에서 운영자 pin 은 hub pin 규칙을 유지하므로 origin 이 다르면 bulk 기준값이 다른 회차를 고른다
        "pin": f"INSERT INTO ing.answer_anchor_pin (job_id, anchor, reason, origin) VALUES ('{j5}', '2026-09-07', 'op', 'operator')",
        "drop": f"INSERT INTO ing.answer_drop (job_id, reason, origin) VALUES ('{j5}', 'op', 'operator')",
        "restore": f"DELETE FROM ing.answer_drop WHERE job_id = '{j14}'",
    }[case]
    ref = await _bulk_ref(reg)
    async with _Tx() as (c, ctx):
        if case == "pin":
            runs = await L.handle_anchor_pin(c, ctx, {"job_id": j5, "anchor": "2026-09-07", "reason": "op"}, None)
            await reproject(c, ctx, [], extra_runs=runs)
        elif case == "drop":
            keys = await L.handle_answer_drop(c, ctx, {"job_id": j5, "reason": "op"}, None)
            await reproject(c, ctx, keys)
        else:
            keys = await L.handle_answer_drop(c, ctx, {"job_id": j14, "op": "restore"}, None)
            await reproject(c, ctx, keys)
        got = await snapshot(c, EQ_TABLES)
        d = diff(ref, got)
        referenced = await referenced_extras(c, d)
    assert not strict_diff(d), strict_diff(d)
    assert not referenced
    if case == "pin":   # run 1 코호트 전체가 09-07 회차로 이동(현행 cyc_reg 코호트 규칙)
        moved = [r for r in got["rd.job"] if str(r[1]).startswith("90000000-0000-4000-8000-0000000000") and r[2] == uuid.UUID("e0000000-0000-4000-8000-000000000001")]
        assert moved and all(r[4] == uuid.UUID("f0000000-0000-4000-8000-000000000010") for r in moved)
