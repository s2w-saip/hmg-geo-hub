"""WU-5 인용 판정 투영 스위치(현행 프로필 cit_hostless_per_row·web_owned_target_base) + DB-v2.15 P86 열(cit_n_all·cit_c1..13) 적재 시험.

같은 ing 입력에서 증분 적재(apply, 적재기 활성 프로필) = bulk 시드(seed-40 psql 변수 cit_row_host·web_tgt_base)를 두 설정(끔·켬)에서 확인하고,
합성 행으로 스위치 효과를 값으로 확인한다(현행 정의 근거는 core.profile SWITCHES 설명). 모든 쓰기는 트랜잭션 안이고 끝에 롤백한다.

합성 입력(고객 데이터 아님, 템플릿 웹사이트 답변 J21 = 유닛 101 kia.com/de, 유닛 타겟 base = kia.com/de/modelle/ev9·shop.kia.de/angebote):
  ord 4  https://shop.kia.de/angebote?media=x  도메인 kia.de   → 쿼리 붙은 타겟 호스트 인용(OWN4): 끔 = 자사 아님(tracked NORM 불일치),
                                                               켬 = 자사(base NORM = 유닛 타겟 base)
  ord 5  같은 URL                               도메인 NULL     → G21A: 끔 = URL 최빈 도메인 kia.de 출처(cit_n·도메인 목록), 켬 = 호스트 없는 인용
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import OFF, parse_profile
from ingest.common.db import LoaderDB
from ingest.cycles.ledger.service import handle_report_publication, project_cycles
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_equivalence import TABLES, _ctx, _keys, _report
from ingest.testkit import WIPE_FACTS, WIPE_ING_DIMS, bulk_seed, diff, snapshot
from tests.support import DB_URL, needs_db

J21 = uuid.UUID("90000000-0000-4000-8000-000000000021")
U = "https://shop.kia.de/angebote?media=x"
SYNTH = f"""
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label)
SELECT m.run_month, m.job_id, v.ord, '{U}', 'shop.kia.de', v.dom
  FROM ing.answer_key_map m CROSS JOIN (VALUES (4, 'kia.de'), (5, NULL)) v(ord, dom)
 WHERE m.job_id = '{J21}';
"""
ROWS = """
SELECT c.ord, c.source_key, c.loc_owned, a.cit_n, a.cit_n_all, a.cit_loc_tgt,
       a.cit_c1 + a.cit_c2 + a.cit_c3 + a.cit_c4 + a.cit_c5 + a.cit_c6 + a.cit_c7 + a.cit_c8 + a.cit_c9 + a.cit_c10 + a.cit_c11 + a.cit_c12
         + a.cit_c13 AS cit_c_sum
  FROM rd.job j JOIN rd.citation c ON c.surface = j.surface AND c.round_date = j.round_date AND c.answer_key = j.answer_key
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.job_id = $1 ORDER BY c.ord"""
SPEC = {False: "off", True: "cit_hostless_per_row,web_owned_target_base"}


async def _bulk(on: bool) -> tuple[dict, list]:
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(SYNTH)
        await bulk_seed(c, profile=parse_profile(SPEC[on]))       # 적재기 쪽과 같은 프로필(세션 프로필 무관)
        snap = await snapshot(c, TABLES)
        rows = [dict(r) for r in await c.fetch(ROWS, J21)]
        await tr.rollback()
        return snap, rows
    finally:
        await c.close()


async def _replay(settings, on: bool) -> tuple[dict, list]:
    set_settings(settings.model_copy(update={"legacy_profile": SPEC[on]}))
    try:
        db = LoaderDB(DB_URL, role="loader")
        c = await db.connect()
        try:
            tr = c.transaction()
            await tr.start()
            await c.execute(SYNTH)
            await c.execute(WIPE_FACTS)
            await c.execute(WIPE_ING_DIMS)
            ctx = await _ctx(c)
            async with c.transaction():
                await project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle")])
            for (run_id,) in await c.fetch("SELECT run_id FROM ing.run ORDER BY started_at, run_id"):
                async with c.transaction():
                    await apply(c, ctx, await _keys(c, "a.run_id = $1", run_id))
            async with c.transaction():
                await handle_report_publication(c, ctx, [r[0] for r in await c.fetch("SELECT id FROM app.report_publication")], None)
            got = await snapshot(c, TABLES)
            rows = [dict(r) for r in await c.fetch(ROWS, J21)]
            await tr.rollback()
            return got, rows
        finally:
            await c.close()
    finally:
        set_settings(settings)


@needs_db
@pytest.mark.parametrize("on", [False, True])
async def test_loader_equals_bulk_with_switches(settings, on):
    ref, ref_rows = await _bulk(on)
    got, rows = await _replay(settings, on)
    d = diff(ref, got)
    assert not d, _report(d)
    host = lambda rs: [{**r, "source_key": r["source_key"] != 0} for r in rs]     # noqa: E731 (정수 키는 발급 순서가 달라 자연 키 비교는 snapshot 이 한다)
    assert host(rows) == host(ref_rows)
    by = {r["ord"]: r for r in rows}
    a = rows[0]
    # 답변 열: cit_n_all = 모든 원소, Σ cit_c = cit_n(호스트 있는 인용), 템플릿 3행 + 합성 2행
    assert a["cit_n_all"] == 5 and a["cit_c_sum"] == a["cit_n"]
    if on:
        assert by[5]["source_key"] == 0 and by[4]["source_key"] != 0          # G21A: 행 자신의 도메인 NULL → 호스트 없는 인용
        assert a["cit_n"] == 4
        assert by[4]["loc_owned"] and by[5]["loc_owned"]                       # OWN4: base NORM ∈ 유닛 타겟 base
    else:
        assert by[5]["source_key"] == by[4]["source_key"] != 0                 # 허브 기본: URL 최빈 도메인 출처
        assert a["cit_n"] == 5
        assert not by[4]["loc_owned"] and not by[5]["loc_owned"]               # 허브 기본: tracked NORM(쿼리 보존) ∉ turls
    # 자사 인용 수(웹사이트 ⑤ 분자)는 호스트 있는 인용만: 켬 = 템플릿 자사 + ord 4
    assert a["cit_loc_tgt"] == sum(1 for r in rows if r["loc_owned"] and r["source_key"] != 0)


@needs_db
async def test_reproject_tool_switches_existing_rows(settings):
    """전환 도구(wu5_reproject): 끔 상태로 적재된 행(bulk 끔) → 켬 프로필로 대상 답변만 재투영 → bulk 켬과 같다. 두 번째 실행은 대상 수만 같고 값 불변."""
    from ingest.project.apply import wu5_reproject as tool

    ref_on, _ = await _bulk(True)
    set_settings(settings.model_copy(update={"legacy_profile": SPEC[True]}))
    try:
        c = await asyncpg.connect(DB_URL)          # 슈퍼유저 한 트랜잭션(bulk 가 만든 pg_temp 표를 적재 경로가 이어 쓴다. loader 권한은 위 증분 시험이 본다)
        try:
            tr = c.transaction()
            await tr.start()
            await c.execute(SYNTH)
            await bulk_seed(c, profile=OFF)        # 끔(허브 기본) 규칙으로 적재된 상태
            dry = await tool.run(c, commit=False)
            assert dry == {"cit_hostless_per_row": 1, "web_owned_target_base": 1, "answers": 1}   # 합성 행이 J21 한 답변
            out = await tool.run(c, commit=True)
            assert out["reprojected"] == 1
            # 실제 변경 행 수(전후 대조): ord 4·5 자사 판정(OWN4) 2행, ord 5 호스트 없는 인용 전환(G21A) 1행, 답변 인용 수 열 1답변
            assert (out["citations_loc_owned_changed"], out["citations_hostless_flipped"], out["citations_added_or_removed"],
                    out["answers_changed"]) == (2, 1, 0, 1)
            assert out["citations_changed"] == 2 and out["citations_source_changed"] == 1
            got = await snapshot(c, TABLES)
            again = await tool.run(c, commit=True)
            assert again["reprojected"] == 1 and diff(got, await snapshot(c, TABLES)) == {}
            assert again["citations_changed"] == 0 and again["answers_changed"] == 0           # 멱등: 같은 프로필 두 번째 = 변경 0
            await tr.rollback()
        finally:
            await c.close()
    finally:
        set_settings(settings)
    d = diff(ref_on, got)
    assert not d, _report(d)


def test_main_installs_worker_settings(monkeypatch):
    """진입점은 ingest.cli 와 같이 워커 설정을 설치한다(stg 2026-10-01: 미설치로 API 설정 검증이 HGH_JWKS_URL 을 요구해 크래시)."""
    import sys

    from ingest.common import config as cfg
    from ingest.project.apply import wu5_reproject as tool

    calls: list[str] = []
    monkeypatch.setattr(cfg, "install_worker_settings", lambda: calls.append("install"))

    async def fake_main(commit: bool) -> dict:
        calls.append(f"main:{commit}")
        return {}

    monkeypatch.setattr(tool, "_main", fake_main)
    monkeypatch.setattr(sys, "argv", ["wu5_reproject", "--commit"])
    tool.main()
    assert calls == ["install", "main:True"]
