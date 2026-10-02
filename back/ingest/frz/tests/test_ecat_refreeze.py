"""엔티티 버전 반영 ↔ 동결 층 재동결(ecat_engine 머리 주석 재동결 절, 제품 결정 27·31·32).

발행 회차(픽스처 10·11 global, 21 website)를 실제 생성기(frz.freeze_cycle, S2)로 동결한 뒤 반영한다. 기준일 2026-09-12(E5 시험과 같다):
노출 = 10, 미노출 = 11·21.
  ① 'all' 반영 → 동결 회차 3개 재동결: 카드 뷰 = 셀 답변의 rd 값(새 버전), 미리보기 카드 후 값 = 실제 카드 값, 감사 원장·진행 기록.
     되돌리기('all', origin rollback) → 다시 재동결: 카드 값 = 반영 전 카드 값.
  ② '미노출만' 반영 → 동결 회차(11·21)가 범위에 있어도 재동결하지 않는다(세대 그대로·보관 유지·카드 뷰 불변).
  ③ 재동결 청크 실패 → 반영 failed, 커밋된 청크 회차만 새 세대(나머지 = 옛 세대·보관 값), 재개 → 남은 회차만 재동결해 applied.
  ④ 반영 실패 → 포기 → 범위 회차를 반영 전 버전으로 되돌린 뒤 재동결: 카드 값 = 반영 전 카드 값, 카드 = rd.
카드 값 = 카드 경로가 읽는 frz.card_answer 의 KPI 입력 합(ecat_engine.kpi_sql = app.core.measure 모수·자사 열, 회차 × 국가 × 엔진).
  ⑤(be/int4 상호작용) 현행 프로필 brand_card_fold 켬: 재동결이 새 세대의 운영 summary 접기도 다시 한다(S2 발행 생성과 같은 결과,
     frz.keep_fold DB-v2.28 불변식 통과). 공존 답변의 'fold' 보관은 카드 = rd 대조에서 빼고, 접기가 빠진 공존 답변이 없음을 따로 본다.
전부 롤백 트랜잭션(복제본 불변).
"""
from __future__ import annotations

import json

import asyncpg
import pytest

from ingest.frz import fold as FD
from ingest.frz.freeze import freeze_published
from ingest.frz.tests.support import kept, view_rows
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처: 기준일 고정·재스캔 준비 끔)
    ACTOR,
    PRODUCT_OWNER,
    _apply_row,
    _approve,
    _engine_env,
    _op,
    _preview_json,
    _request,
    _setup,
)
from ingest.testkit import bulk_seed
from tests.support import DB_URL, TEST_NAME_KEY, needs_db

pytestmark = needs_db

FROZEN = (10, 11, 21)
DROP = "'{load_id,ecat_ver,rule_ver,is_rep,bgrp}'::text[]"
CARD_ROWS = f"SELECT (to_jsonb(x) - {DROP})::text FROM frz.card_answer x WHERE x.cyc_key = $1 ORDER BY 1"
# 카드 뷰가 고르는 셀(활성 세대·in_full_cycle 프롬프트)의 지금 rd 행 = 보관이 없을 때 카드가 읽을 값
LIVE_ROWS = f"""
SELECT (to_jsonb(x) - {DROP})::text FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'
  JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle
  JOIN rd.answer x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key
 WHERE c.cyc_key = $1 ORDER BY 1"""


async def _freeze(c: asyncpg.Connection) -> dict[int, int]:
    ids = [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle WHERE status = 'published' ORDER BY cyc_key")]
    out = await freeze_published(c, ids)
    assert not out["failed"] and len(out["frozen"]) == len(FROZEN), out
    return await _gens(c)


async def _gens(c: asyncpg.Connection) -> dict[int, int]:
    return {int(r[0]): int(r[1]) for r in await c.fetch("SELECT cyc_key, gen_key FROM frz.generation WHERE state = 'active' ORDER BY 1")}


async def _card_kpi(c: asyncpg.Connection) -> dict:
    return {ee._grp(r): ee._vals(r) for r in await c.fetch(ee.kpi_sql("frz.card_answer", "a.cyc_key = ANY($1::int4[])"), list(FROZEN))}


# 활성 세대의 운영 summary 접기 보관 답변(현행 프로필 brand_card_fold, DB-v2.27·v2.28): 카드 값이 rd 와 다른 것이 정상인 답변
FOLD_KEYS = """SELECT p.answer_key FROM frz.kept p JOIN frz.generation g ON g.gen_key = p.gen_key AND g.state = 'active'
                WHERE g.cyc_key = $1 AND p.src = 'fold'"""
CARD_BRAND = """SELECT (to_jsonb(x) - 'load_id')::text FROM frz.card_answer_brand x
                 WHERE x.cyc_key = ANY($1::int4[]) ORDER BY 1"""


async def _card_is_live(c: asyncpg.Connection, cycles) -> None:
    """카드 뷰 = 셀 답변의 지금 rd 값(보관 해제). 접기 켬이면 'fold' 보관 답변은 빼고, 활성 세대에 접기가 빠진 공존 답변이 없음을 본다
    (재동결이 접기를 다시 하지 않으면 공존 답변이 rd 값 그대로 남아 여기서 걸린다)."""
    for k in cycles:
        fk = {int(r[0]) for r in await c.fetch(FOLD_KEYS, k)}
        card = [r[0] for r in await c.fetch(CARD_ROWS, k) if json.loads(r[0])["answer_key"] not in fk]
        live = [r[0] for r in await c.fetch(LIVE_ROWS, k) if json.loads(r[0])["answer_key"] not in fk]
        assert card and card == live, f"회차 {k}: 카드 뷰 ≠ 셀 답변의 지금 rd 값"
        if FD.enabled():
            g = int(await c.fetchval("SELECT gen_key FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", k))
            assert await FD.compute(c, await FD.candidates(c, g)) == [], f"회차 {k}: 재동결 세대에 접기가 빠진 공존 답변"
        else:
            assert not fk, f"회차 {k}: 끔인데 fold 보관"


async def _audit(c: asyncpg.Connection, aid: int) -> list[dict]:
    rows = await c.fetch("SELECT detail FROM app.ecat_audit_log WHERE action = 'apply.refreeze' AND apply_id = $1 ORDER BY audit_id", aid)
    return [json.loads(r[0]) if isinstance(r[0], str) else r[0] for r in rows]


async def _by(c: asyncpg.Connection, gen: int) -> tuple[str | None, str | None]:
    j = await c.fetchval("SELECT judgment FROM frz.generation WHERE gen_key = $1", gen)
    j = json.loads(j) if isinstance(j, str) else j
    return j.get("ecat_apply"), j.get("ecat_phase")


async def _rollback_version(c: asyncpg.Connection) -> int:
    v3 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) "
                          "VALUES (1, 'v1 로 되돌림', '시험', 'rollback', $1) RETURNING ver", ACTOR)
    await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                    note, updated_by, updated_at)
                       SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                         FROM app.ecat_entity WHERE ver = 1""", v3)
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = 1", v3)
    return int(v3)


async def test_apply_all_refreezes_frozen_cycles_then_rollback_restores(monkeypatch):
    monkeypatch.setenv("HGH_ECAT_REFREEZE_CHUNK", "2")
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        g0 = await _freeze(c)
        card0 = await _card_kpi(c)

        aid = await _request(c, v2, "all")
        assert [o.status for o in await _op(c, aid, "preview")] == ["applied"]
        pv = await _preview_json(c, aid)
        rf = pv["refreeze"]
        assert rf["applies"] and rf["count"] == 3 and rf["exposed"] == 1 and "노출 회차 1개 재동결" in rf["note"], rf
        assert {x["cyc_key"]: x["gen_key"] for x in rf["cycles"]} == g0
        card_rows = [r for r in pv["kpi"] if "card" in r]
        assert any(r["card"]["before"] != r["card"]["after"] for r in card_rows), "픽스처 v2 가 동결 회차 카드 값을 바꾸지 않는다(시험 전제)"

        await _approve(c, aid, PRODUCT_OWNER)
        steps = await _op(c, aid, "apply")
        assert steps[-1].status == "applied" and (await _apply_row(c, aid))["status"] == "applied", steps
        g1 = await _gens(c)
        assert set(g1) == set(g0) and all(g1[k] != g0[k] for k in g0), (g0, g1)
        assert [await _by(c, g1[k]) for k in g1] == [(str(aid), "apply")] * 3
        assert await c.fetchval("SELECT count(*) FROM frz.generation WHERE gen_key = ANY($1::int4[]) AND state = 'retired'", list(g0.values())) == 3
        await _card_is_live(c, FROZEN)                                   # 카드 = 실시간(새 버전 rd 값)
        card1 = await _card_kpi(c)
        for r in card_rows:                                              # 미리보기 카드 후 값 = 실제 재동결 뒤 카드 값
            g = (r["cyc_key"], r["geo_key"], r["engine_key"])
            assert ee.kpi_rows(card1.get(g, [0] * len(ee.KPI_METRICS))) == r["card"]["after"], g
            assert ee.kpi_rows(card0.get(g, [0] * len(ee.KPI_METRICS))) == r["card"]["before"], g
        au = await _audit(c, aid)
        assert len(au) == 2 and au[-1]["done"] == au[-1]["total"] == 3, au                   # 청크 2 → 감사 2행
        assert {int(k): (v["from_gen"], v["to_gen"]) for a in au for k, v in a["cycles"].items()} == {k: (g0[k], g1[k]) for k in g0}
        prog = (await _preview_json(c, aid))["refreeze_progress"]["apply"]
        assert prog["done"] == prog["total"] == 3 and set(prog["cycles"]) == {str(k) for k in FROZEN}
        assert await kept(c) == {} or not await c.fetchval("SELECT count(*) FROM frz.kept WHERE gen_key = ANY($1::int4[]) AND src <> 'seat'",
                                                           list(g1.values()))

        # 되돌리기('all', origin rollback = v1 내용) → 다시 재동결: 카드 = 반영 전 카드 값
        v3 = await _rollback_version(c)
        rid = await _request(c, v3, "all")
        assert [o.status for o in await _op(c, rid, "preview")] == ["applied"]
        assert (await _preview_json(c, rid))["refreeze"]["count"] == 3
        await _approve(c, rid, PRODUCT_OWNER)
        assert (await _op(c, rid, "apply"))[-1].status == "applied"
        assert (await _apply_row(c, aid))["status"] == "rolled_back"
        g2 = await _gens(c)
        assert [await _by(c, g2[k]) for k in g2] == [(str(rid), "apply")] * 3
        await _card_is_live(c, FROZEN)
        assert await _card_kpi(c) == card0, "되돌린 뒤 카드 값 = 반영 전 카드 값"
    finally:
        await tr.rollback()
        await c.close()


async def test_unexposed_scope_keeps_frozen_cycles():
    """'미노출만' 범위: 동결 회차 11·21 이 범위에 있어도 재동결하지 않는다(세대 그대로, 보관 = 동결 시점 값, 카드 뷰 불변, 감사 없음)."""
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        g0 = await _freeze(c)
        v0 = await view_rows(c)
        card0 = await _card_kpi(c)
        aid = await _request(c, v2, "unexposed")
        await _op(c, aid, "preview")
        pv = await _preview_json(c, aid)
        assert set(pv["cycles"]["exposed_in_scope"]) == set() and {11, 21} <= set((await _apply_row(c, aid))["cycle_keys"])
        assert pv["refreeze"]["applies"] is False and pv["refreeze"]["count"] == 0 and "미노출만" in pv["refreeze"]["note"]
        assert not [r for r in pv["kpi"] if "card" in r]
        await _approve(c, aid, ACTOR)
        assert (await _op(c, aid, "apply"))[-1].status == "applied"
        assert await _gens(c) == g0, "미노출만 범위는 동결 세대를 건드리지 않는다"
        k = await kept(c)
        held = {int(r[0]) for r in await c.fetch("SELECT DISTINCT c.cyc_key FROM frz.kept p JOIN frz.cell c ON c.gen_key = p.gen_key "
                                                    "AND c.answer_key = p.answer_key")}
        assert k and held <= {11, 21} and held, (k, held)                  # 바뀐 동결 답변은 보관(옛 값)으로 남는다
        assert await view_rows(c) == v0 and await _card_kpi(c) == card0
        assert await _audit(c, aid) == []
        assert "refreeze_progress" not in (await _preview_json(c, aid))
    finally:
        await tr.rollback()
        await c.close()


async def test_refreeze_failure_leaves_apply_failed_then_resume(monkeypatch):
    """재동결 청크(1회차씩) 두 번째 실패: 반영 failed(applied 아님), 회차 10 만 새 세대, 11·21 = 옛 세대(보관 값). 재개 → 남은 2개만 재동결."""
    monkeypatch.setenv("HGH_ECAT_REFREEZE_CHUNK", "1")
    real = ee._regenerate
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 재동결 실패")
        return await real(*a, **k)

    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        g0 = await _freeze(c)
        v0 = await view_rows(c)
        aid = await _request(c, v2, "all")
        await _op(c, aid, "preview")
        await _approve(c, aid, PRODUCT_OWNER)
        monkeypatch.setattr(ee, "_regenerate", flaky)
        steps = await _op(c, aid, "apply")
        monkeypatch.setattr(ee, "_regenerate", real)
        assert [o.status for o in steps][-1] == "failed" and (await _apply_row(c, aid))["status"] == "failed", steps
        g1 = await _gens(c)
        assert g1[10] != g0[10] and g1[11] == g0[11] and g1[21] == g0[21], (g0, g1)
        await _card_is_live(c, [10])
        held = await c.fetch(CARD_ROWS, 11), await c.fetch(CARD_ROWS, 21)
        assert [r[0] for r in held[0]] != [r[0] for r in await c.fetch(LIVE_ROWS, 11)] or \
               [r[0] for r in held[1]] != [r[0] for r in await c.fetch(LIVE_ROWS, 21)], "옛 세대 회차는 보관 값(반영 전)"
        v1 = await view_rows(c)
        assert {t: [r for r in v1[t] if '"cyc_key": 10' not in r] for t in v1} == {t: [r for r in v0[t] if '"cyc_key": 10' not in r]
                                                                                   for t in v0}
        assert [list(a["cycles"]) for a in await _audit(c, aid)] == [["10"]]
        prog = (await _preview_json(c, aid))["refreeze_progress"]["apply"]
        assert (prog["done"], prog["total"]) == (1, 3)

        steps = await _op(c, aid, "resume")
        assert steps[-1].status == "applied" and (await _apply_row(c, aid))["status"] == "applied", steps
        g2 = await _gens(c)
        assert g2[10] == g1[10] and g2[11] != g0[11] and g2[21] != g0[21]       # 재개는 남은 회차만
        await _card_is_live(c, FROZEN)
        assert sorted(k for a in await _audit(c, aid) for k in a["cycles"]) == ["10", "11", "21"]
    finally:
        await tr.rollback()
        await c.close()


async def test_abandon_refreezes_scope_cycles_at_prior_version(monkeypatch):
    """반영이 투영 청크에서 실패(재동결 전) → 포기: 범위 회차를 반영 전 버전으로 되돌려 투영한 뒤 단계 'abandon' 재동결. 카드 = rd = 반영 전 카드 값."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    real = ee.project
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 청크 실패")
        return await real(*a, **k)

    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        g0 = await _freeze(c)
        card0 = await _card_kpi(c)
        aid = await _request(c, v2, "all")
        await _op(c, aid, "preview")
        await _approve(c, aid, PRODUCT_OWNER)
        monkeypatch.setattr(ee, "project", flaky)
        assert [o.status for o in await _op(c, aid, "apply")][-1] == "failed"
        monkeypatch.setattr(ee, "project", real)
        assert await _gens(c) == g0                                       # 재동결 전 실패: 세대 그대로
        done = await _op(c, aid, "abandon")
        assert done[-1].status == "applied" and (await _apply_row(c, aid))["status"] == "rejected", done
        g1 = await _gens(c)
        assert all(g1[k] != g0[k] for k in g0) and [await _by(c, g1[k]) for k in g0] == [(str(aid), "abandon")] * 3, (g0, g1)
        await _card_is_live(c, FROZEN)
        assert await _card_kpi(c) == card0, "포기 뒤 카드 값 = 반영 전 카드 값"
        assert [a["phase"] for a in await _audit(c, aid)] == ["abandon"]
    finally:
        await tr.rollback()
        await c.close()


# ⑤ be/int4 상호작용: 현행 프로필 brand_card_fold(be/int3-smartfold, DB-v2.27·v2.28) 켬에서 재동결이 운영 summary 접기를 다시 한다
FOLD_ON = "cell_rep,rep_pick_latest_first,catalog_incl_deleted,web_registered_only,freeze_at_publish,display_name_latin,brand_card_fold"
PICK_BASIS = "SELECT cyc_key, fleet_visible, gap_ratio, gap_src, ops_status FROM rd.cycle_pick_basis ORDER BY cyc_key"
FOLD_KEPT = """SELECT g.cyc_key, p.answer_key FROM frz.kept p JOIN frz.generation g ON g.gen_key = p.gen_key AND g.state = 'active'
                WHERE p.src = 'fold' ORDER BY 1, 2"""


async def _fold_kept(c: asyncpg.Connection) -> list[tuple[int, int]]:
    return [(int(r[0]), int(r[1])) for r in await c.fetch(FOLD_KEPT)]


@pytest.mark.legacy_profile(FOLD_ON)
async def test_refreeze_refolds_with_brand_card_fold(monkeypatch):
    """접기 켬: 발행 생성(S2 freeze_published)이 공존 답변을 접어 보관한 동결 회차를 'all' 반영 → 되돌리기로 두 번 재동결한다.
    매 재동결 세대에 접기가 빠진 공존 답변이 없고(_card_is_live), 진행 기록에 회차별 접기 결과가 남으며, 되돌린 뒤(v1 내용) 'fold' 보관
    답변·카드 answer_brand 행·카드 KPI 가 발행 생성 때와 같다(재동결 접기 = S2 접기, keep_fold P144 불변식 통과). 접기 없는 재동결이면
    되돌린 뒤 공존 답변이 rd 값(접히지 않음)으로 남아 마지막 두 단언이 실패한다."""
    monkeypatch.setenv("HGH_ECAT_REFREEZE_CHUNK", "2")
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        if not TEST_NAME_KEY:                    # 끔 투영 복제본: 표시 브랜드 키가 섞이지 않게 먼저 이 프로필로 전량 투영(test_fold 와 같다)
            await bulk_seed(c)
            await c.execute("DISCARD TEMP")      # 소유자가 만든 시드 임시 표·뷰(_meff 등)를 지워 반영(loader 롤)이 다시 만들 수 있게
        v2, _ = await _setup(c)
        g0 = await _freeze(c)
        f0 = await _fold_kept(c)
        assert f0, "시험 전제: 픽스처 공존 답변(답변 2: 비경쟁 Smart + Smart 로 롤업되는 경쟁 Smart Fortwo)이 발행 생성 때 접힌다"
        brand0 = [r[0] for r in await c.fetch(CARD_BRAND, list(FROZEN))]
        card0 = await _card_kpi(c)
        pb0 = await c.fetch(PICK_BASIS)
        await _card_is_live(c, FROZEN)

        aid = await _request(c, v2, "all")
        assert [o.status for o in await _op(c, aid, "preview")] == ["applied"]
        assert "접기" in (await _preview_json(c, aid))["refreeze"]["approx"]
        await _approve(c, aid, PRODUCT_OWNER)
        assert (await _op(c, aid, "apply"))[-1].status == "applied"
        g1 = await _gens(c)
        assert all(g1[k] != g0[k] for k in g0)
        await _card_is_live(c, FROZEN)                                   # 새 버전 세대: 접기가 빠진 공존 답변 없음
        prog = (await _preview_json(c, aid))["refreeze_progress"]["apply"]
        assert all(set(v["fold"]) == {"candidates", "kept"} for v in prog["cycles"].values()), prog

        v3 = await _rollback_version(c)
        rid = await _request(c, v3, "all")
        await _op(c, rid, "preview")
        await _approve(c, rid, PRODUCT_OWNER)
        assert (await _op(c, rid, "apply"))[-1].status == "applied"
        g2 = await _gens(c)
        assert all(g2[k] not in (g0[k], g1[k]) for k in g0)
        await _card_is_live(c, FROZEN)
        assert await _fold_kept(c) == f0, "되돌린 뒤 접힌 답변 = 발행 생성 때"
        for k, ak in f0:
            rc = json.loads(await c.fetchval("SELECT row_counts::text FROM frz.generation WHERE gen_key = $1", g2[k]))
            assert rc.get("kept_fold", 0) >= 1, (k, ak, rc)
        assert [r[0] for r in await c.fetch(CARD_BRAND, list(FROZEN))] == brand0, "카드 answer_brand = 발행 생성 접기"
        assert await _card_kpi(c) == card0
        # 창 판정 생성 대기 구멍(DB-v2.30 core.cycles.pick_holes = 닫힘 ∧ 갭 ∧ 활성 세대 없음): 재동결은 발행 회차의 세대를 한 트랜잭션에서
        # 바꿔 끼울 뿐이라 활성 세대 있는 회차 집합·판정 기초(rd.cycle_pick_basis)가 그대로다
        assert set(g2) == set(g0) and await c.fetch(PICK_BASIS) == pb0
    finally:
        await tr.rollback()
        await c.close()
