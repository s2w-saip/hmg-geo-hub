"""발행 때 동결 세대 생성(S2, DB-v2.22 frz.freeze_cycle·regenerate, ingest.frz.freeze) 시험. 합성 픽스처 위, 롤백 트랜잭션(loader 롤).

현행 규칙 대조(독립 구현, 파이썬):
  셀 집합  ref_cells: 회차 run 의 completed·서빙(삭제 아님) 답변, 글로벌은 prompt·region 있는 것, 셀 = (prompt, target, region | 웹 사이트 country
           우선), 정렬 = 미러 시각(미러 예외값 > 앵커 핀 접기 > 원본) DESC NULLS FIRST, job_id. 근거 2670a16 surface-global.ts:466-478,
           surface-website.ts:296-317·725-732, 0053 scope_anchor_fold(scope-mirror.ts:56-58·101-127), 미러 삭제 제외 bulk-run.ts:125.
  in_full_cycle  ref_full_cycle(18a12559 test_full_cycle_freeze.reference 그대로): global-predicates.ts:110-169·:70-113, 3값 논리.
시나리오 = 09-28 글로벌 회차(18a12559 시나리오 + 셀 대표 갈래: 최신·NULL 시각·앵커 핀·미러 예외·동률·삭제·실패·region 없음).
"""
from __future__ import annotations

import ast
import datetime as dt
import inspect
import json
import pathlib
import uuid

import asyncpg
import pytest

from ingest.cycles.ledger import service as L
from ingest.cycles.ledger.tests.gate_support import ROOT, gate_catalog
from ingest.cycles.ledger.tests.test_ledger import _run, _Tx
from ingest.frz import freeze as F
from ingest.project.apply.service import apply
from tests.support import needs_db

NOW = dt.datetime(2026, 10, 10, tzinfo=dt.UTC)
CUTOFF = dt.datetime(2026, 8, 19, tzinfo=dt.UTC)
P = {n: uuid.UUID(f"b9000000-0000-4000-8000-0000000000{n:02d}") for n in range(1, 8)}
SITE_PROJ = uuid.UUID("a0000000-0000-4000-8000-000000000002")
TS = lambda s: dt.datetime.fromisoformat(s).replace(tzinfo=dt.UTC)  # noqa: E731
BACK = pathlib.Path(__file__).resolve().parents[3]


# ── 현행 규칙의 독립 구현 ────────────────────────────────────────────────────
def _and3(*v):
    return False if any(x is False for x in v) else (None if any(x is None for x in v) else True)


def _or3(*v):
    return True if any(x is True for x in v) else (None if any(x is None for x in v) else False)


def _not3(v):
    return None if v is None else (not v)


def _ne(a, b):
    return None if a is None or b is None else a != b


def ref_full_cycle(answers, prompts, mem: set, root) -> dict:
    """18a12559 reference 그대로. answers: (prompt_id, target, region, measured_at, status, run_id, run_status, scope_project_id)."""
    kor = {p for p, text, _ in prompts if text is not None and any("가" <= ch <= "힣" for ch in text)}
    tagged = {p for p, _, regs in prompts if regs is not None and len(regs) > 0}
    pairs = {(p, r) for p, _, regs in prompts if regs for r in regs}
    cells: dict = {}
    for pid, tgt, reg, mat, st, run, rst, proj in answers:
        if proj != root or rst not in ("completed", "partial_failed") or st != "completed":
            continue
        kor_excl = _and3(_ne(reg, "KR"), pid is not None, (pid in kor) if pid is not None else None,
                         _or3(mat is None, (mat < CUTOFF) if mat is not None else None, (pid not in tagged) if pid is not None else None))
        if _not3(kor_excl) is not True:
            continue
        tag_ok = _or3(pid is None, (pid not in tagged) if pid is not None else None,
                      None if reg is None or pid is None else (pid, reg) in pairs)
        if tag_ok is not True:
            continue
        c = cells.setdefault((pid, tgt, reg), {"w": False, "first": None, "wlast": None})
        inm = run in mem
        c["w"] = c["w"] or inm
        if mat is not None:
            c["first"] = mat if c["first"] is None else min(c["first"], mat)
            if inm:
                c["wlast"] = mat if c["wlast"] is None else max(c["wlast"], mat)
    active = {(t, r) for (_, t, r), c in cells.items() if c["w"] and r is not None}
    lasts = [c["wlast"] for c in cells.values() if c["wlast"] is not None]
    gmax = max(lasts) if lasts else None
    out: dict = {}
    by: dict = {}
    for (pid, t, r), c in cells.items():
        by.setdefault(pid, []).append((t, r, c))
    for pid, cs in by.items():
        exp = sum(1 for t, r, c in cs if r is not None and (t, r) in active
                  and (c["w"] or c["first"] is None or gmax is None or c["first"] <= gmax))
        win = sum(1 for _, _, c in cs if c["w"])
        if pid is not None and win > 0:
            out[pid] = (win >= exp, exp, win)
    return out


def _mirror_time(ts, mirror_at, pin):
    """현행 미러 measured_at: 미러 예외값 > 앵커 핀 접기(UTC 날짜를 핀 날짜로 당긴다) > 원본."""
    if mirror_at is not None:
        return mirror_at
    if pin is not None and ts is not None:
        return ts - dt.timedelta(days=(ts.astimezone(dt.UTC).date() - pin).days)
    return ts


def ref_cells(rows, surface: str) -> set:
    """rows: (job_id, prompt_id, target, region, site_country, measured_at, mirror_at, pin, status, served). 반환 = 셀 대표 job_id 집합."""
    best: dict = {}
    for job, pid, tgt, reg, site_c, mat, mirror_at, pin, st, served in rows:
        if st != "completed" or not served:
            continue
        if surface == "global" and (pid is None or reg is None):
            continue
        country = (site_c if site_c is not None else reg) if surface == "website" else reg
        key = (pid, tgt, country)
        t = _mirror_time(mat, mirror_at, pin)
        # DESC NULLS FIRST, job_id ASC: 정렬 키가 작은 것이 이긴다
        k = (0 if t is None else 1, dt.datetime.max.replace(tzinfo=dt.UTC) - t if t is not None else dt.timedelta(0), str(job))
        if key not in best or k < best[key][0]:
            best[key] = (k, job)
    return {j for _, j in best.values()}


async def _cell_inputs(c, cid) -> tuple[list, str]:
    surf = await c.fetchval("SELECT surface FROM ing.cycle WHERE cycle_id = $1", cid)
    rows = [tuple(r) for r in await c.fetch("""
        SELECT a.job_id, a.prompt_id, a.target, a.region, ws.country_code, a.measured_at, mt.measured_at, pin.anchor, a.status,
               coalesce(j.served, false)
          FROM ing.cycle_run cr JOIN ing.answer a ON a.run_id = cr.run_id
          JOIN ing.cycle cy ON cy.cycle_id = cr.cycle_id
          LEFT JOIN rd.job j ON j.job_id = a.job_id
          LEFT JOIN ing.answer_mirror_time mt ON mt.job_id = a.job_id
          LEFT JOIN ing.answer_anchor_pin pin ON pin.job_id = a.job_id
          LEFT JOIN app.website_prompt wp ON cy.surface = 'website' AND wp.scope_prompt_id = a.prompt_id
          LEFT JOIN app.website_site ws ON ws.site_id = wp.site_id AND ws.scope_project_id = cy.scope_project_id
         WHERE cr.cycle_id = $1""", cid)]
    return rows, surf


async def _fc_inputs(c, cid):
    answers = [tuple(r) for r in await c.fetch(
        "SELECT a.prompt_id, a.target, a.region, a.measured_at, a.status, a.run_id, r.status, r.scope_project_id "
        "FROM ing.answer a JOIN ing.run r ON r.run_id = a.run_id")]
    prompts = [tuple(r) for r in await c.fetch("SELECT scope_prompt_id, text, regions FROM ing.prompt")]
    mem = {r[0] for r in await c.fetch("SELECT run_id FROM ing.cycle_run WHERE cycle_id = $1", cid)}
    root = await c.fetchval("SELECT scope_project_id FROM ing.cycle WHERE cycle_id = $1", cid)
    return answers, prompts, mem, root


async def _frozen_jobs(c, cyc_key) -> set:
    return {r[0] for r in await c.fetch(
        "SELECT j.job_id FROM frz.cell x JOIN frz.generation g ON g.gen_key = x.gen_key AND g.state = 'active' "
        "JOIN rd.job j ON j.answer_key = x.answer_key WHERE x.cyc_key = $1", cyc_key)}


async def _frozen_fc(c, cyc_key) -> dict:
    return {r["prompt_id"]: (r["in_full_cycle"], r["expected_cells"], r["window_cells"]) for r in await c.fetch(
        "SELECT d.prompt_id, p.in_full_cycle, p.expected_cells, p.window_cells FROM frz.prompt p JOIN frz.generation g ON g.gen_key = p.gen_key "
        "AND g.state = 'active' JOIN rd.dim_prompt d ON d.prompt_key = p.prompt_key WHERE p.cyc_key = $1", cyc_key)}


# ── 시나리오(09-28 글로벌 회차) ──────────────────────────────────────────────
async def _ans(c, run, prompt, target, region, at: str | None, status: str = "completed", job: uuid.UUID | None = None) -> uuid.UUID:
    jid = job or uuid.uuid4()
    k = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, content_hash, load_id)
                       VALUES ('2026-09-01', $1, $2, $3, $4, $5, $6, $7, $8, '\\x00', 1)""",
                    jid, k, run, prompt, target, region, status, TS(at) if at else None)
    return jid


async def _scenario(c, ctx) -> tuple[uuid.UUID, dict]:
    """이력 run(08-03) + 이번 회차 run(앵커 09-28) + 늦은 run(10-05) + 실패 run. 반환 = (회차 id, 갈래별 job)."""
    await c.executemany("INSERT INTO ing.prompt (scope_prompt_id, scope_project_id, text, regions) VALUES ($1, $2, $3, $4)",
                        [(P[1], ROOT, "best suv", None), (P[2], ROOT, "best sedan", None), (P[3], ROOT, "best ev", None),
                         (P[4], ROOT, "최고의 SUV", None), (P[5], ROOT, "tagged us", ["US"]), (P[6], ROOT, "fail run", None),
                         (P[7], SITE_PROJ, "other project", None)])
    old = await _run(c, "e9000000-0000-4000-8000-000000000001", ROOT, anchor="2026-08-03T00:30:00+00:00", started="2026-08-03T00:30:00+00:00")
    await L.attribute(c, ctx, [old])
    for p in (P[1], P[2]):
        for t in ("chatgpt", "gemini"):
            await _ans(c, old, p, t, "US", "2026-08-03T01:00:00")
    await _ans(c, old, P[4], "chatgpt", "US", "2026-08-03T01:00:00")
    await _ans(c, old, P[5], "chatgpt", "GB", "2026-08-03T01:00:00")
    cur = await _run(c, "e9000000-0000-4000-8000-000000000002", ROOT, anchor="2026-09-28T00:30:00+00:00", started="2026-09-28T00:30:00+00:00")
    await L.attribute(c, ctx, [cur])
    cid = await c.fetchval("SELECT cycle_id FROM ing.cycle_run WHERE run_id = $1", cur)
    j: dict = {}
    # 셀 대표 갈래
    await _ans(c, cur, P[1], "chatgpt", "US", "2026-09-28T01:00:00")
    j["latest"] = await _ans(c, cur, P[1], "chatgpt", "US", "2026-09-28T03:00:00")                 # 최신이 이긴다
    await _ans(c, cur, P[1], "gemini", "US", "2026-09-28T01:00:00")
    j["null_first"] = await _ans(c, cur, P[1], "gemini", "US", None)                                # NULL 시각이 먼저(DESC NULLS FIRST)
    j["pin_loses"] = await _ans(c, cur, P[2], "chatgpt", "US", "2026-09-28T05:00:00")               # 핀(09-27)으로 접히면 09-27 05:00
    j["pin_winner"] = await _ans(c, cur, P[2], "chatgpt", "US", "2026-09-28T01:00:00")
    j["mirror_override"] = await _ans(c, cur, P[3], "chatgpt", "US", "2026-09-28T01:00:00")         # 미러 예외값 09-29 → 이긴다
    await _ans(c, cur, P[3], "chatgpt", "US", "2026-09-28T02:00:00")
    t1, t2 = uuid.UUID("99000000-0000-4000-8000-000000000001"), uuid.UUID("99000000-0000-4000-8000-000000000002")
    await _ans(c, cur, P[5], "chatgpt", "US", "2026-09-28T01:00:00", job=t2)
    j["tie_min_job"] = await _ans(c, cur, P[5], "chatgpt", "US", "2026-09-28T01:00:00", job=t1)    # 동률 → 작은 job_id
    j["drop_older"] = await _ans(c, cur, P[4], "chatgpt", "KR", "2026-09-28T01:00:00")
    j["dropped"] = await _ans(c, cur, P[4], "chatgpt", "KR", "2026-09-28T04:00:00")                 # 최신이지만 삭제
    await _ans(c, cur, P[4], "chatgpt", "US", "2026-09-28T01:00:00")
    j["failed_status"] = await _ans(c, cur, P[7], "gemini", "US", "2026-09-28T06:00:00", status="failed")
    await _ans(c, cur, P[7], "chatgpt", "US", "2026-09-28T01:00:00")
    j["no_region"] = await _ans(c, cur, P[1], "chatgpt", None, "2026-09-28T07:00:00")               # 글로벌: region 없으면 제외
    await c.execute("INSERT INTO ing.answer_anchor_pin (job_id, anchor, reason) VALUES ($1, '2026-09-27', '시험')", j["pin_loses"])
    await c.execute("RESET ROLE")
    await c.execute("INSERT INTO ing.answer_mirror_time (job_id, measured_at) VALUES ($1, '2026-09-29 00:00+00')", j["mirror_override"])
    await c.execute("SET ROLE loader")
    await c.execute("INSERT INTO ing.answer_drop (job_id, reason) VALUES ($1, '시험')", j["dropped"])
    late = await _run(c, "e9000000-0000-4000-8000-000000000003", ROOT, anchor="2026-10-05T00:30:00+00:00", started="2026-10-05T00:30:00+00:00")
    await L.attribute(c, ctx, [late])
    await _ans(c, late, P[3], "gemini", "US", "2026-10-05T01:00:00")
    bad = await _run(c, "e9000000-0000-4000-8000-000000000004", ROOT, anchor="2026-09-28T00:30:00+00:00", started="2026-09-28T03:00:00+00:00")
    await c.execute("UPDATE ing.run SET status = 'failed' WHERE run_id = $1", bad)
    await c.execute("INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ($1, $2, 'scope')", bad, cid)
    await _ans(c, bad, P[6], "chatgpt", "US", "2026-09-28T03:00:00")
    await c.execute("SELECT rd.ensure_leaf(1::int2, '2026-08-01'::date), rd.ensure_leaf(1::int2, '2026-10-01'::date)")
    await L.project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT DISTINCT cycle_id FROM ing.cycle_run WHERE run_id = ANY($1::uuid[])",
                                                                  [old, cur, late, bad])])
    keys = [r[0] for r in await c.fetch("SELECT answer_key FROM ing.answer WHERE run_id = ANY($1::uuid[])", [old, cur, late, bad])]
    await apply(c, ctx, keys)
    return cid, j


async def _publish(c, ctx, cid) -> dict:
    await gate_catalog(c)
    await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "force_publish", "reason": "시험: 발행 시점 동결"})
    rv = await L.reevaluate(c, ctx, [cid], now=NOW)
    assert cid in rv["published"]
    if rv["moved_runs"]:
        await apply(c, ctx, [], extra_runs=rv["moved_runs"])
    return await F.freeze_published(c, rv["published"])


@needs_db
async def test_publish_freezes_cells_and_full_cycle_by_current_rules():
    async with _Tx() as (c, ctx):
        cid, j = await _scenario(c, ctx)
        out = await _publish(c, ctx, cid)
        assert len(out["frozen"]) == 1 and out["failed"] == [], out
        key = await c.fetchval("SELECT cyc_key FROM ing.cycle WHERE cycle_id = $1", cid)
        rows, surf = await _cell_inputs(c, cid)
        want = ref_cells(rows, surf)
        got = await _frozen_jobs(c, key)
        assert got == want
        assert {j["latest"], j["null_first"], j["pin_winner"], j["mirror_override"], j["tie_min_job"], j["drop_older"]} <= got
        assert not ({j["pin_loses"], j["dropped"], j["failed_status"], j["no_region"]} & got)
        fc_ref = ref_full_cycle(*await _fc_inputs(c, cid))
        fc_got = await _frozen_fc(c, key)
        assert {p: v for p, v in fc_got.items() if p in fc_ref} == {p: fc_ref[p] for p in fc_got if p in fc_ref}
        assert fc_got[P[1]][0] is True and fc_got[P[2]] == (False, 2, 1)
        assert set(fc_got) == {r[0] for r in await c.fetch("SELECT DISTINCT a.prompt_id FROM ing.answer a JOIN rd.job x ON x.job_id = a.job_id "
                                                           "WHERE x.answer_key IN (SELECT answer_key FROM frz.cell WHERE cyc_key = $1)", key)}
        g = await c.fetchrow("SELECT gen_key, source, judgment, row_counts, verify FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", key)
        jd = json.loads(g["judgment"])
        assert g["source"] == "hub" and jd["cycle_id"] == str(cid) and "rule_ver" in jd and "profile_on" in jd
        assert json.loads(g["row_counts"])["cells"] == len(want)
        # 동결 뷰 = rd 셀 행(보관 없음), is_rep 은 셀 기준 참
        assert await c.fetchval("SELECT count(*) FROM frz.answer WHERE surface = 1 AND cyc_key = $1 AND is_rep", key) == len(want)
        await c.execute("RESET ROLE")                                                    # 구조 단언 함수는 migrator·소유자 전용
        assert json.loads(await c.fetchval("SELECT frz.assert_generation($1)::text", g["gen_key"]))["from_rd"] == len(want)
        await c.execute("SET ROLE loader")


@needs_db
async def test_late_data_does_not_change_frozen_and_regenerate_reinterprets():
    async with _Tx() as (c, ctx):
        cid, j = await _scenario(c, ctx)
        await _publish(c, ctx, cid)
        key = await c.fetchval("SELECT cyc_key FROM ing.cycle WHERE cycle_id = $1", cid)
        jobs0, fc0 = await _frozen_jobs(c, key), await _frozen_fc(c, key)
        g0 = await c.fetchval("SELECT gen_key FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", key)
        run = await c.fetchval("SELECT run_id FROM ing.cycle_run WHERE cycle_id = $1 AND run_id = 'e9000000-0000-4000-8000-000000000002'", cid)
        late_best = await _ans(c, run, P[1], "chatgpt", "US", "2026-09-29T09:00:00")                # 발행 뒤 도착: 같은 셀의 더 최신
        await _ans(c, run, P[2], "gemini", "US", "2026-09-29T01:00:00")                               # P2 의 빠진 셀이 채워짐
        await apply(c, ctx, [r[0] for r in await c.fetch("SELECT answer_key FROM ing.answer WHERE run_id = $1", run)])
        assert (await F.freeze_published(c, [cid]))["already"], "발행 회차를 다시 보아도 활성 세대가 있으면 그대로(멱등)"
        assert await _frozen_jobs(c, key) == jobs0 and await _frozen_fc(c, key) == fc0
        # 재해석 없는 재생성·사유 없음 거부
        for bad in ({"reinterpret": False, "reason": "x"}, {"reinterpret": True, "reason": " "}, {"reason": "x"}):
            with pytest.raises(L.BadRequest):
                await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "regenerate", **bad})
        await L.handle_cycle_admin(c, ctx, {"cycle_id": str(cid), "op": "regenerate", "reinterpret": True, "reason": "시험: 늦은 데이터 반영"})
        assert await c.fetchval("SELECT state FROM frz.generation WHERE gen_key = $1", g0) == "retired"
        jobs1, fc1 = await _frozen_jobs(c, key), await _frozen_fc(c, key)
        rows, surf = await _cell_inputs(c, cid)
        assert jobs1 == ref_cells(rows, surf) and late_best in jobs1 and j["latest"] not in jobs1
        assert fc1[P[2]][0] is True and fc0[P[2]][0] is False
        jd = json.loads(await c.fetchval("SELECT judgment FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", key))
        assert jd["regenerate_reason"] == "시험: 늦은 데이터 반영"


@needs_db
async def test_fixture_published_cycles_global_and_website():
    """픽스처 발행 회차(글로벌 10·11, 웹 21): 셀 = 독립 구현, 웹은 in_full_cycle 참 고정·window = 셀 수·report_fs = 유닛 소속."""
    async with _Tx() as (c, ctx):
        for k in (10, 11, 21):
            cid = await c.fetchval("SELECT cycle_id FROM ing.cycle WHERE cyc_key = $1", k)
            r = json.loads(await c.fetchval(F.FREEZE, cid, "{}"))
            assert r["status"] == "frozen", r
            rows, surf = await _cell_inputs(c, cid)
            assert await _frozen_jobs(c, k) == ref_cells(rows, surf), k
        web = await c.fetch("SELECT in_full_cycle, expected_cells, window_cells, report_fs, prompt_key FROM frz.prompt WHERE cyc_key = 21")
        assert web and all(w["in_full_cycle"] and w["expected_cells"] is None for w in web)
        n = {r[0]: r[1] for r in await c.fetch("SELECT prompt_key, count(*) FROM frz.cell WHERE cyc_key = 21 GROUP BY 1")}
        assert {w["prompt_key"]: w["window_cells"] for w in web} == n
        wr = {r[0]: r[1] for r in await c.fetch("SELECT prompt_key, report_fs FROM rd.web_report_prompt")}
        assert all(w["report_fs"] == wr.get(w["prompt_key"]) for w in web)
        assert await c.fetchval("SELECT count(*) FROM ing.full_cycle_expected((SELECT cycle_id FROM ing.cycle WHERE cyc_key = 21))") == 0
        # 프로젝트·미발행 회차는 건너뜀
        for k in (12, 31):
            cid = await c.fetchval("SELECT cycle_id FROM ing.cycle WHERE cyc_key = $1", k)
            assert json.loads(await c.fetchval(F.FREEZE, cid, "{}"))["status"] == "skipped"


@needs_db
async def test_freeze_failure_rolls_back_only_the_generation():
    """생성 실패(회차에 이미 building 세대 = 유일 색인 위반)는 세이브포인트로 그 회차만 되돌리고 발행은 유지한다."""
    async with _Tx() as (c, ctx):
        cid, _ = await _scenario(c, ctx)
        key = await c.fetchval("SELECT cyc_key FROM ing.cycle WHERE cycle_id = $1", cid)
        await c.execute("RESET ROLE")
        await c.execute("INSERT INTO frz.generation (cyc_key, surface, source) VALUES ($1, 1, 'hub')", key)
        await c.execute("SET ROLE loader")
        out = await _publish(c, ctx, cid)
        assert out["frozen"] == [] and len(out["failed"]) == 1
        assert await c.fetchval("SELECT status FROM ing.cycle WHERE cycle_id = $1", cid) == "published"
        assert await c.fetchval("SELECT count(*) FROM frz.cell WHERE cyc_key = $1", key) == 0
        assert await c.fetchval("SELECT count(*) FROM frz.generation WHERE cyc_key = $1", key) == 1     # 미리 넣은 building 하나뿐


@needs_db
async def test_queue_force_publish_path_freezes():
    """큐 경로(process_change cycle_admin force_publish → 재평가 → 발행 → 동결)."""
    from ingest.common.db import LoaderDB
    from ingest.cycles.workers.service import process_change

    async with _Tx() as (c, ctx):
        cid, _ = await _scenario(c, ctx)
        await gate_catalog(c)
        await c.execute("RESET ROLE")
        chg = await c.fetchval("INSERT INTO app.judgment_change (kind, payload, requested_by) VALUES ('cycle_admin', $1::jsonb, NULL) "
                               "RETURNING change_id", json.dumps({"cycle_id": str(cid), "op": "force_publish", "reason": "시험"}))
        await c.execute("SET ROLE loader")
        o = await process_change(LoaderDB("postgresql://unused"), c, change_id=chg)
        assert o.status == "applied", o
        key = await c.fetchval("SELECT cyc_key FROM ing.cycle WHERE cycle_id = $1", cid)
        assert await c.fetchval("SELECT count(*) FROM frz.generation WHERE cyc_key = $1 AND state = 'active' AND source = 'hub'", key) == 1


def test_every_reevaluate_caller_freezes_published():
    """원장 재평가(발행)를 부르는 적재 함수는 같은 함수에서 freeze_published 를 부른다(정적)."""
    hits = []
    for path in sorted((BACK / "ingest").rglob("*.py")):
        if "/tests/" in str(path) or path.name == "service.py" and path.parent.name == "ledger":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.AsyncFunctionDef, ast.FunctionDef)):
                src = ast.get_source_segment(path.read_text(encoding="utf-8"), fn) or ""
                if "ledger.reevaluate(" in src:
                    hits.append((path.name, fn.name, "freeze_published(" in src))
    assert len(hits) >= 3 and all(ok for *_, ok in hits), hits
    assert inspect.iscoroutinefunction(F.freeze_published)


def test_contract_regenerate_requires_reason_and_reinterpret():
    from pydantic import ValidationError

    from app.core.contracts import CycleAdmin

    cid = uuid.uuid4()
    assert CycleAdmin(cycle_id=cid, op="regenerate", reason="r", reinterpret=True).reinterpret is True
    for bad in ({"reason": "r"}, {"reason": "r", "reinterpret": False}, {"reinterpret": True}):
        with pytest.raises(ValidationError):
            CycleAdmin(cycle_id=cid, op="regenerate", **bad)
    with pytest.raises(ValidationError):
        CycleAdmin(cycle_id=cid, op="hide", hidden_scope="all", reinterpret=True)
    assert asyncpg is not None
