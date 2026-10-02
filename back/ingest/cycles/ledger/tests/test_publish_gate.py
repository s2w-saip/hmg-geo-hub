"""원장 발행 게이트(DB-v2.14, 제품 결정 16~18): 개설 시점 계획 · 100% 발행 · 미달 보류(알림 후보) · 봉인 · 강제 발행 · project 무변화 ·
이관 과거 회차 무변화 · 도중 비활성 제외 · 구조적 불가 조합 제외 · backfill 계획(앵커 뒤 등록 제외·quiet).

모든 쓰기는 loader 롤 트랜잭션 안이고 끝에 롤백한다. 기대값은 gate_support 머리 주석의 손계산(루트 10유닛·사이트 6유닛).
"""
from __future__ import annotations

import datetime as dt
import pathlib
import uuid

import asyncpg
import pytest

from app.core.contracts import check_change
from ingest.cycles.ledger import service as L
from tests.support import DB_URL, needs_db

from .gate_support import ROOT, add_answer, as_owner, gate_catalog, sp
from .test_ledger import C11, _run, _Tx

NOW = dt.datetime(2026, 10, 10, tzinfo=dt.UTC)
ROOT_UNITS = {(sp(n), t, "US") for n in (1, 2, 3, 4, 6) for t in ("chatgpt", "gemini")}
F31 = uuid.UUID("f0000000-0000-4000-8000-000000000031")
C10 = uuid.UUID("f0000000-0000-4000-8000-000000000010")


async def _open(c, ctx, rid: str, anchor: str, pid: uuid.UUID = ROOT) -> tuple[uuid.UUID, uuid.UUID]:
    """새 앵커 run → attribute(회차 개설 = 계획 'open'). started = 앵커(정온 36h 는 NOW 기준 지났다)."""
    run = await _run(c, rid, pid, anchor=anchor, started=anchor)
    await L.attribute(c, ctx, [run])
    return run, await c.fetchval("SELECT cycle_id FROM ing.cycle_run WHERE run_id = $1", run)


async def _gate(c, cid):
    return await c.fetchrow("SELECT * FROM ing.cycle_gate WHERE cycle_id = $1", cid)


async def _status(c, cid) -> str:
    return await c.fetchval("SELECT status FROM ing.cycle WHERE cycle_id = $1", cid)


DB = pathlib.Path(__file__).resolve().parents[4] / "db"


def test_merged_ddl_is_previous_plus_patch():
    """합본 DB-v2.14.sql = DB-v2.13.sql + DB-v2.14-patch.sql(바이트), 기존 버전들과 같은 방식."""
    assert (DB / "DB-v2.14.sql").read_bytes() == (DB / "DB-v2.13.sql").read_bytes() + (DB / "DB-v2.14-patch.sql").read_bytes()


@needs_db
async def test_patch_reapply_rejected():
    c = await asyncpg.connect(DB_URL)
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.14 이미 적용됨"):
            await c.execute((DB / "DB-v2.14-patch.sql").read_text(encoding="utf-8"))
    finally:
        await c.close()


def test_contract_requires_reason():
    """계약(생산자·소비자 한 벌): seal·force_publish 는 사유 필수, units 는 seal 에만."""
    cid = str(uuid.uuid4())
    for bad in ({"cycle_id": cid, "op": "seal"}, {"cycle_id": cid, "op": "force_publish", "reason": "  "},
                {"cycle_id": cid, "op": "close", "units": []}):
        with pytest.raises(ValueError):
            check_change("cycle_admin", bad)
    check_change("cycle_admin", {"cycle_id": cid, "op": "seal", "reason": "Scope 발송 누락",
                                 "units": [{"prompt_id": str(uuid.uuid4()), "target": "chatgpt", "region": "US"}]})
    check_change("cycle_admin", {"cycle_id": cid, "op": "force_publish", "reason": "운영 판단"})


def test_summary_helper_is_pure():
    from ingest.cycles.watch.service import summarize_missing
    got = summarize_missing([{"prompt_id": sp(1), "target": "gemini", "region": "US"}, {"prompt_id": sp(2), "target": "gemini", "region": "US"},
                             {"prompt_id": sp(3), "target": "chatgpt", "region": "KR"}], sample=2)
    assert got["units"] == 3 and got["by_engine_region"][0] == {"target": "gemini", "region": "US", "units": 2}
    assert len(got["sample"]) == 2 and got["sample"][0]["prompt_id"] == str(sp(1))



@needs_db
async def test_plan_at_open_and_full_completion_publishes():
    """100% 발행: 개설 시점 계획 = 현재 카탈로그 10유닛, 전부 완료 ∧ 분석 비율 1 → 발행."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        run, cid = await _open(c, ctx, "e2000000-0000-4000-8000-000000000001", "2026-09-28T00:30:00+00:00")
        g = await _gate(c, cid)
        assert (g["plan_source"], g["plan_units"], g["verdict"], g["quiet"]) == ("open", 10, None, False)
        plan = {(r["prompt_id"], r["target"], r["region"]) for r in await c.fetch("SELECT * FROM ing.cycle_unit WHERE cycle_id = $1", cid)}
        assert plan == ROOT_UNITS
        for p, t, r in sorted(ROOT_UNITS):
            await add_answer(c, run, p, t, r)
        out = await L.reevaluate(c, ctx, [cid], now=NOW)
        g = await _gate(c, cid)
        assert (g["active_units"], g["done_units"], g["missing_units"], g["verdict"]) == (10, 10, 0, "pass")
        assert cid in out["published"] and await _status(c, cid) == "published"
        # 발행 뒤 동결: 카탈로그가 바뀌어도 게이트를 다시 쓰지 않는다
        await as_owner(c, "UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = $1", sp(6))
        await L.reevaluate(c, ctx, [cid], now=NOW)
        assert (await _gate(c, cid))["active_units"] == 10


@needs_db
async def test_partial_blocks_then_seal_publishes():
    """99.x%: 1유닛 미완료 → 닫혀도 발행 보류(blocked, 알림 후보). 봉인(빠진 유닛 전부) → 발행. 봉인 사유·요청자·change_id 기록."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        run, cid = await _open(c, ctx, "e2000000-0000-4000-8000-000000000002", "2026-09-28T00:30:00+00:00")
        units = sorted(ROOT_UNITS)
        for p, t, r in units[:-1]:
            await add_answer(c, run, p, t, r)
        await add_answer(c, run, *units[-1], status="failed")         # 답변 행은 있지만 미완료
        out = await L.reevaluate(c, ctx, [cid], now=NOW)
        assert cid in out["closed"] and cid not in out["published"] and await _status(c, cid) == "closed"
        # 현행 answer 기반 기대 유닛도 10(행이 있으므로) → 완료 9/10 = 90%: 분석 비율(1.0)만 보던 옛 R08 이면 발행됐다
        assert await c.fetchval("SELECT (expected_units, completed_units, analysis_done_ratio)::text FROM ing.cycle WHERE cycle_id = $1",
                                cid) == "(10,9,1.00000)"
        g = await _gate(c, cid)
        assert (g["active_units"], g["done_units"], g["missing_units"], g["verdict"], g["alerted_at"], g["quiet"]) == (10, 9, 1, "blocked", None, False)
        assert [tuple(m) for m in await L.missing_units(c, cid)] == [units[-1]]
        # 봉인: 사유 없으면 거절, 계획 밖 유닛 지정 거절
        with pytest.raises(L.BadRequest):
            await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "seal"})
        with pytest.raises(L.BadRequest):
            await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "seal", "reason": "x",
                                                "units": [{"prompt_id": str(sp(7)), "target": "chatgpt", "region": "US"}]})
        actor = uuid.UUID("11111111-0000-4000-8000-000000000001")
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "seal", "reason": "Scope 발송 누락 확인"}, change_id=42, requested_by=actor)
        s = await c.fetchrow("SELECT seal_reason, seal_change_id, sealed_by FROM ing.cycle_unit WHERE cycle_id = $1 AND sealed_at IS NOT NULL", cid)
        assert (s["seal_reason"], s["seal_change_id"], s["sealed_by"]) == ("Scope 발송 누락 확인", 42, actor)
        out = await L.reevaluate(c, ctx, [cid], now=NOW)
        g = await _gate(c, cid)
        assert (g["active_units"], g["done_units"], g["sealed_units"], g["missing_units"], g["verdict"]) == (9, 9, 1, 0, "pass")
        assert cid in out["published"]


@needs_db
async def test_explicit_unit_seal_and_force_publish():
    """지정 유닛 봉인은 그 유닛만. 강제 발행: 사유 없으면 거절, 열린 회차는 운영자 마감 뒤 발행(분석 비율·완료율 무관), 감사 열 기록."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        run, cid = await _open(c, ctx, "e2000000-0000-4000-8000-000000000003", "2026-09-28T00:30:00+00:00")
        await add_answer(c, run, sp(1), "chatgpt", "US", n_mentions=0)            # 결손 답변 1건: 분석 비율 0
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "seal", "reason": "지정",
                                            "units": [{"prompt_id": str(sp(2)), "target": "gemini", "region": "US"}]})
        assert await c.fetchval("SELECT count(*) FROM ing.cycle_unit WHERE cycle_id = $1 AND sealed_at IS NOT NULL", cid) == 1
        for bad in ({"cycle_id": str(cid), "op": "force_publish"}, {"cycle_id": str(cid), "op": "force_publish", "reason": " "}):
            with pytest.raises(L.BadRequest):
                await L.handle_cycle_admin(c, ctx, bad)
        assert await _status(c, cid) == "open"
        actor = uuid.UUID("11111111-0000-4000-8000-000000000001")
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "force_publish", "reason": "고객 보고 일정"}, change_id=43,
                                   requested_by=actor)
        out = await L.reevaluate(c, ctx, [cid], now=dt.datetime(2026, 9, 28, 3, tzinfo=dt.UTC))
        row = await c.fetchrow("SELECT status, closed_by FROM ing.cycle WHERE cycle_id = $1", cid)
        g = await _gate(c, cid)
        assert (row["status"], row["closed_by"]) == ("published", "operator") and cid in out["published"]
        assert (g["verdict"], g["forced_reason"], g["forced_by"], g["force_change_id"], g["missing_units"]) == ("forced", "고객 보고 일정", actor, 43, 8)
        assert g["forced_at"] is not None
        # 발행 뒤에는 봉인·강제 발행 요청을 받지 않는다
        with pytest.raises(L.BadRequest):
            await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "seal", "reason": "x"})


@needs_db
async def test_project_surface_and_migrated_past_cycles_unchanged():
    """project 표면은 닫히면 바로 노출(게이트 없음), 이관 발행 회차(origin summary_cycles)는 상태·게이트 불변."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        st = ("SELECT cycle_id, status, closed_by, closed_at, published_at, view_anchor_at, expected_units, completed_units, stale_since"
              " FROM ing.cycle WHERE cycle_id = ANY($1::uuid[]) ORDER BY cycle_id")
        before = [tuple(r) for r in await c.fetch(st, [C10, C11])]
        out = await L.reevaluate(c, ctx, [F31, C10, C11], now=NOW)
        assert F31 in out["published"] and await _status(c, F31) == "published"
        assert await c.fetchval("SELECT count(*) FROM ing.cycle_gate WHERE cycle_id = ANY($1::uuid[])", [F31, C10, C11]) == 0
        assert await c.fetchval("SELECT count(*) FROM ing.cycle_unit WHERE cycle_id = ANY($1::uuid[])", [F31, C10, C11]) == 0
        assert [tuple(r) for r in await c.fetch(st, [C10, C11])] == before     # 상태·발행·노출·동결 유닛 불변(카운터 재계산은 현행 그대로)
        assert [r[1] for r in before] == ["published", "published"]
        for op in ("seal", "force_publish"):
            with pytest.raises(L.BadRequest):
                await L.handle_cycle_admin(c, ctx, {"cycle_id": str(F31), "op": op, "reason": "x"})          # project 는 대상 아님
            with pytest.raises(L.BadRequest):
                await L.handle_cycle_admin(c, ctx, {"cycle_id": str(C11), "op": op, "reason": "x"})          # 이미 발행


@needs_db
async def test_deactivated_midcycle_and_unmeasurable_excluded():
    """도중 비활성(프롬프트 삭제·시장 제외)과 구조적 불가 조합(rule_param unmeasurable_units)은 분모에서 빠진다."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        await as_owner(c, """INSERT INTO app.rule_param (key, value) VALUES ('unmeasurable_units', '[{"target": "Gemini", "region": "us"}]')
                             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""")
        run, cid = await _open(c, ctx, "e2000000-0000-4000-8000-000000000004", "2026-09-28T00:30:00+00:00")
        plan = {(r["prompt_id"], r["target"], r["region"]) for r in await c.fetch("SELECT * FROM ing.cycle_unit WHERE cycle_id = $1", cid)}
        assert plan == {u for u in ROOT_UNITS if u[1] == "chatgpt"}               # 개설 시점에 불가 조합은 계획에 없다
        # 도중: 프롬프트 06 삭제, 프롬프트 04 시장을 KR 로(US 제외). 남은 활성 = 01·02·03 chatgpt US
        await as_owner(c, "UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = $1", sp(6))
        await c.execute("UPDATE ing.prompt SET regions = '{KR}' WHERE scope_prompt_id = $1", sp(4))
        for n in (1, 2, 3):
            await add_answer(c, run, sp(n), "chatgpt", "US")
        out = await L.reevaluate(c, ctx, [cid], now=NOW)
        g = await _gate(c, cid)
        assert (g["plan_units"], g["withdrawn_units"], g["active_units"], g["done_units"], g["verdict"]) == (5, 2, 3, 3, "pass")
        assert cid in out["published"]
        # 개설 뒤에 불가 조합을 더하면(설정 변경) 그 유닛도 도중 제외로 빠진다
        await as_owner(c, """UPDATE app.rule_param SET value = '[{"target": "chatgpt", "region": "US"}]' WHERE key = 'unmeasurable_units'""")
        assert await c.fetchval("SELECT count(*) FROM ing.active_units($1) WHERE target = 'chatgpt' AND region = 'US'", ROOT) == 0
        assert await c.fetchval("SELECT count(*) FROM ing.active_units($1) WHERE target = 'gemini' AND region = 'US'", ROOT) == 3


@needs_db
async def test_backfill_plan_excludes_later_listed_and_marks_quiet():
    """계획 없는 이관 회차: 재평가가 backfill 계획을 만든다. 앵커 뒤에 카탈로그에 들어온 프롬프트는 빼고, 이미 닫혀 있던 이관 회차는 quiet."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        await as_owner(c, "UPDATE app.prompt SET created_at = '2026-09-25' WHERE scope_prompt_id = $1", sp(6))    # 회차 12(09-21) 뒤 등록
        c12 = uuid.UUID("f0000000-0000-4000-8000-000000000012")
        out = await L.reevaluate(c, ctx, [c12], now=dt.datetime(2026, 9, 21, 6, tzinfo=dt.UTC))   # 아직 열린 채(정온 전)
        assert c12 in out["planned"]
        g = await _gate(c, c12)
        assert (g["plan_source"], g["plan_units"], g["quiet"], g["alerted_at"]) == ("backfill", 8, False, None)
        assert await c.fetchval("SELECT count(*) FROM ing.cycle_unit WHERE cycle_id = $1 AND prompt_id = $2", c12, sp(6)) == 0
        # 웹사이트 이관 회차가 이미 닫혀 있었다면 quiet(알림·감시 제외): 회차 21 을 닫힘으로 되돌려 본다
        c21 = uuid.UUID("f0000000-0000-4000-8000-000000000021")
        await c.execute("UPDATE ing.cycle SET status = 'closed', published_at = NULL, view_anchor_at = NULL WHERE cycle_id = $1", c21)
        await L.reevaluate(c, ctx, [c21], now=NOW)
        g = await _gate(c, c21)
        assert (g["plan_source"], g["plan_units"], g["quiet"]) == ("backfill", 6, True) and g["alerted_at"] is not None
        # 두 번째 재평가: 새 계획 없음, 판정 값 불변이면 게이트를 쓰지 않는다(틱 무변화 판정)
        out = await L.reevaluate(c, ctx, [c21], now=NOW)
        assert out["planned"] == [] and out["gate"] == []
        assert out["published"] == []


@needs_db
async def test_scope_disabled_prompt_excluded_at_open_and_midcycle():
    """Scope 에서 꺼 둔 프롬프트(ing.prompt.enabled = false, DB-v2.14 P84 제품 결정 21)는 개설 시점 계획에 들어가지 않고, 회차 도중 꺼지면
    '계획 ∩ 현재 활성' 규칙으로 도중 제외된다. NULL(모름)은 활성으로 센다. 카탈로그(app.prompt)는 그대로다."""
    async with _Tx() as (c, ctx):
        await gate_catalog(c)
        await c.execute("UPDATE ing.prompt SET enabled = false WHERE scope_prompt_id = $1", sp(1))       # 개설 전에 꺼짐
        await c.execute("UPDATE ing.prompt SET enabled = true WHERE scope_prompt_id = $1", sp(2))        # 명시 활성, 나머지 NULL
        run, cid = await _open(c, ctx, "e2000000-0000-4000-8000-000000000005", "2026-09-28T00:30:00+00:00")
        plan = {(r["prompt_id"], r["target"], r["region"]) for r in await c.fetch("SELECT * FROM ing.cycle_unit WHERE cycle_id = $1", cid)}
        assert plan == {u for u in ROOT_UNITS if u[0] != sp(1)} and len(plan) == 8
        assert await c.fetchval("SELECT count(*) FROM app.prompt WHERE scope_prompt_id = $1 AND deleted_at IS NULL", sp(1)) == 2   # 카탈로그 불변
        # 도중: 프롬프트 06 이 Scope 에서 꺼진다(측정 안 됨). 나머지 01 제외 6유닛(02·03·04 × 2엔진)만 완료
        await c.execute("UPDATE ing.prompt SET enabled = false WHERE scope_prompt_id = $1", sp(6))
        for n in (2, 3, 4):
            for t in ("chatgpt", "gemini"):
                await add_answer(c, run, sp(n), t, "US")
        out = await L.reevaluate(c, ctx, [cid], now=NOW)
        g = await _gate(c, cid)
        assert (g["plan_units"], g["withdrawn_units"], g["active_units"], g["done_units"], g["missing_units"], g["verdict"]) == \
            (8, 2, 6, 6, 0, "pass")
        assert cid in out["published"]
