"""E4 미리보기·E5 반영·되돌리기 수용 기준(설계 hmg-entity-management-versioning-design-20261001.md 3절·8절 E4·E5, 제품 결정 26~29).

E4 1. 미리보기 KPI 값 = 실제 반영 뒤 rd 에서 같은 SQL(ecat_engine.kpi_sql·brand_sql)로 센 값(그룹 전부 차이 0, 미리보기에 없는 그룹은 전후 같음)
   2. 미리보기 실행 뒤 rd 전 표 md5 불변(사실·차원·회차·세대)
E5 3. unexposed 반영 뒤 노출 회차 rd 행 md5 불변, 노출 회차는 이전 버전에 고정, 범위 회차 rd.answer.ecat_ver 전수 = 새 버전
   4. 반영(청크) 결과 = 같은 활성 버전·고정의 전량 bulk 시드(행 단위)
   5. 반영 → 되돌리기 뒤 사실 표 md5(ecat_ver·load_id 밖) = 반영 전, 되돌린 반영 rolled_back
   6. 미리보기 뒤 원천 변경(영향 답변 재적재) → ECAT_PREVIEW_STALE(큐 행 failed, 반영 previewed), 무관한 새 적재는 통과
   7. 동시 반영 ECAT_APPLY_RUNNING(엔진 = 큐 대기, DB = 부분 유일 색인), 노출 회차 포함인데 승인자 밖 → ECAT_EXPOSED_REQUIRES_APPROVAL
   8. 청크 실패 → failed(대기 표시가 rd 에 남음) → op resume 로 이어받아 applied = 한 번에 반영한 것과 같다. 세대 +1
큐 경로(process_change)는 loader 롤(SET ROLE)로 돌려 새 객체 권한도 확인한다. 전부 롤백(복제본 불변).
"""
from __future__ import annotations

import datetime as dt
import json
import uuid

import asyncpg
import pytest

from ingest.common.db import LoaderDB
from ingest.cycles.workers.service import process_change
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_ecat_overlay import (
    ACTOR,
    J1,
    J2,
    J3,
    JA,
    JB,
    KIA_KO,
    _all_keys,
    _as_loader,
    _brands,
    _make_v2,
    _stage_v1,
    rx_cycle,
)
from ingest.testkit import EQ_TABLES, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, needs_db

PRODUCT_OWNER = uuid.UUID("7e000000-0000-4000-8000-0000000000f1")
# 노출 판정 기준일. E1 합성 run(JA~JD)은 회차 10(round 09-07, view 09-09)에 귀속된다(R02 좌석). 09-12 = 회차 10 만 노출,
# 11(view 09-16: J1~J3)·21(09-19)·31(09-21)·12(미발행)는 미노출 → 미노출 범위 = J1~J3 쪽 편집(제거·병합·관계), 노출 = JA~JD 쪽(차단·재매칭)
TODAY = dt.date(2026, 9, 12)
EXPOSED = [10]


def unexposed_work() -> int:
    """비노출 범위(회차 11·12·21·31) 작업 답변 수: J1·J2·J3(회차 11) + RX 4답변(JA·JB·JC·JD)이 비노출 회차 12 에 귀속되면 4 더
    (현행 프로필 resub_phantom_exclude, rx_cycle). hub 규칙이면 RX 는 노출 회차 10 이라 3."""
    return 3 + (4 if rx_cycle() != 10 else 0)
FACTS = ("rd.job", "rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation", "rd.acr_cell", "rd.acr_choice")


@pytest.fixture(autouse=True)
def _engine_env(monkeypatch):
    async def no_scan(db, payload):             # 재스캔은 E2 시험 몫: 여기서는 _make_v2 가 ing.hub_match 를 직접 쓴다(같은 트랜잭션)
        return None
    monkeypatch.setattr(ee, "prepare", no_scan)
    monkeypatch.setattr(ee, "TODAY_OVERRIDE", TODAY)


DB = LoaderDB("postgresql://unused")            # process_change 는 db.tx(conn) 만 쓴다(재스캔 준비는 위에서 막았다)


async def _setup(c: asyncpg.Connection, *, draft: bool = True) -> tuple[int, int]:
    """v1 이관 + v1 전량 투영 → 초안 v2(E1 픽스처 편집). 반환 (v2, load_id)."""
    ctx = await _stage_v1(c)
    await c.execute("SELECT app.ecat_cutover_v1($1, 'E5 시험')", ACTOR)
    keys = await _all_keys(c)
    await _as_loader(c, lambda: apply(c, ctx, keys))
    # 픽스처 언급 적재의 엔티티 합계 차분(DB-v2.25 P133)을 반영해 둔다: 실제 적재는 finalize 가 하므로, 미리보기 전후 rd 비교에 섞이지 않게
    await c.fetchval("SELECT rd.flush_entity_mention_total()")
    await c.execute("INSERT INTO app.rule_param (key, value) VALUES ('ecat_approvers', $1::jsonb)", json.dumps([str(PRODUCT_OWNER)]))
    return await _make_v2(c, ctx, activate=not draft), ctx.load_id


async def _request(c: asyncpg.Connection, ver: int, scope: str, from_round: dt.date | None = None) -> int:
    """E6 가 하는 요청(api_rw): 활성 버전 기준 반영 행."""
    return int(await c.fetchval(
        "INSERT INTO app.ecat_apply (kind, ver, from_ver, scope_kind, from_round_date, requested_by, reason) "
        "VALUES ('entity_version', $1, (SELECT ver FROM app.ecat_version WHERE status = 'active'), $2, $3, $4, '시험') RETURNING apply_id",
        ver, scope, from_round, ACTOR))


async def _enqueue(c: asyncpg.Connection, apply_id: int, op: str) -> int:
    return int(await c.fetchval("INSERT INTO app.judgment_change (kind, payload, requested_by) VALUES ('entity_version', $1::jsonb, $2) "
                                "RETURNING change_id", json.dumps({"apply_id": apply_id, "op": op}), ACTOR))


async def _approve(c: asyncpg.Connection, apply_id: int, who: uuid.UUID) -> None:
    await c.execute("UPDATE app.ecat_apply SET status = 'approved', approved_by = $2, approved_at = now() WHERE apply_id = $1", apply_id, who)


async def _run(c: asyncpg.Connection, cid: int, limit: int = 500) -> list:
    """큐 한 행을 끝날 때까지(progress 면 다시) loader 롤로 처리."""
    out = []
    for _ in range(limit):
        await c.execute("SET ROLE loader")
        try:
            o = await process_change(DB, c, change_id=cid)
        finally:
            await c.execute("RESET ROLE")
        out.append(o)
        if o is None or o.status != "progress":
            break
    return out


async def _op(c: asyncpg.Connection, apply_id: int, op: str) -> list:
    return await _run(c, await _enqueue(c, apply_id, op))


async def _apply_row(c: asyncpg.Connection, apply_id: int) -> asyncpg.Record:
    return await c.fetchrow("SELECT * FROM app.ecat_apply WHERE apply_id = $1", apply_id)


async def _preview_json(c: asyncpg.Connection, apply_id: int) -> dict:
    v = await c.fetchval("SELECT preview FROM app.ecat_apply WHERE apply_id = $1", apply_id)
    return json.loads(v) if isinstance(v, str) else v


async def _md5(c: asyncpg.Connection, tables, drop=("load_id",), where: str = "true") -> dict[str, str]:
    out = {}
    for t in tables:
        rm = "".join(f" - '{x}'" for x in drop)
        out[t] = await c.fetchval(f"SELECT md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) FROM "
                                  f"(SELECT (to_jsonb(t){rm})::text AS x FROM {t} t WHERE {where}) q")
    return out


async def _exposed_md5(c: asyncpg.Connection) -> dict[str, str]:
    """노출 회차(EXPOSED)에 속한 사실 행 md5(load_id 밖). rd.acr_choice 는 회차 열이 없어 acr_cell 로 거른다."""
    cyc = "ARRAY[" + ",".join(map(str, EXPOSED)) + "]::int4[]"
    out = await _md5(c, [t for t in FACTS if t != "rd.acr_choice"], where=f"cyc_key = ANY({cyc})")
    out.update(await _md5(c, ["rd.acr_choice"], where=f"acr_cell_key IN (SELECT acr_cell_key FROM rd.acr_cell WHERE cyc_key = ANY({cyc}))"))
    return out


async def _rd_all_md5(c: asyncpg.Connection) -> dict[str, str]:
    """rd 스키마 전 표(파티션 부모 기준, 모든 열) md5: 미리보기가 rd 를 한 행도 바꾸지 않았는지."""
    ts = [r[0] for r in await c.fetch("""SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                          WHERE n.nspname = 'rd' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1""")]
    return await _md5(c, ts, drop=())


async def _kpi_all(c: asyncpg.Connection) -> dict[tuple, list[int]]:
    return {(int(r[0]), int(r[1]), int(r[2])): [int(r[m]) for m in ee.KPI_METRICS] for r in await c.fetch(ee.kpi_sql("rd.answer", "true"))}


async def _brand_totals(c: asyncpg.Connection, cycles: list[int], bares: list[str]) -> dict[str, tuple[int, int]]:
    sql = ("SELECT d.bare, x.mentions, x.answers FROM (" + ee.brand_sql("rd.answer_brand", "b.cyc_key = ANY($1::int4[])") +
           ") x JOIN rd.dim_brand_name d ON d.brand_key = x.brand_key WHERE d.bare = ANY($2::text[])")
    return {r[0]: (int(r[1]), int(r[2])) for r in await c.fetch(sql, cycles, bares)}


def _assert_preview_equals(pv: dict, before: dict, after: dict) -> int:
    """미리보기 행 전·후 = 반영 전·후 rd 값, 미리보기에 없는 그룹은 전후 같음. 반환 = 대조한 미리보기 그룹 수."""
    seen = set()
    for row in pv["kpi"]:
        g = (row["cyc_key"], row["geo_key"], row["engine_key"])
        seen.add(g)
        assert row["before"] == ee.kpi_rows(before.get(g, [0] * len(ee.KPI_METRICS))), (g, "before")
        assert row["after"] == ee.kpi_rows(after.get(g, [0] * len(ee.KPI_METRICS))), (g, "after")
    for g in set(before) | set(after):
        if g not in seen:
            assert before.get(g) == after.get(g), (g, "미리보기에 없는 그룹이 바뀌었다")
    return len(seen)


async def _bulk_equal(c: asyncpg.Connection) -> None:
    got = await snapshot(c, EQ_TABLES)
    sp = c.transaction()
    await sp.start()
    await bulk_seed(c)
    ref = await snapshot(c, EQ_TABLES)
    await sp.rollback()
    d = diff(ref, got)
    assert not strict_diff(d) and not await referenced_extras(c, d), d


# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_unexposed_preview_equals_apply_rd_unchanged_and_exposed_frozen():
    """수용 기준 1·2·3·4·8(세대): 미노출 범위(회차 11·12·21·31), 노출 회차 10 은 v1 고정.
    RX(JA~JD) 회차는 프로필별(rx_cycle): hub = 노출 회차 10(v1 고정 대상, 손 계산 행 불변 확인), 현행 프로필 resub_phantom_exclude = 비노출
    회차 12(반영 대상). 현행 프로필에서는 RX 에 걸린 손 계산(hyundai 언급 증감·JA 행 불변·추가 표본 0)을 빼고 J2 만 걸리는 kia·smart 증감과
    프로필 무관 대조(미리보기 = 반영 rd, 노출 회차 rd md5 불변·v1 고정, bulk)로 본다."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        aid = await _request(c, v2, "unexposed")
        md_rd0 = await _rd_all_md5(c)
        kpi0 = await _kpi_all(c)
        exp0 = await _exposed_md5(c)
        ja0 = await _brands(c, JA)
        gen0 = dict(await c.fetch("SELECT surface, generation FROM rd.surface_generation"))

        outs = await _op(c, aid, "preview")
        assert [o.status for o in outs] == ["applied"], outs
        assert await _rd_all_md5(c) == md_rd0, "미리보기가 rd 를 바꿨다"
        pv = await _preview_json(c, aid)
        ap = await _apply_row(c, aid)
        assert ap["status"] == "previewed" and ap["preview_set_md5"] is not None and list(ap["cycle_keys"]) == [11, 12, 21, 31]
        assert pv["requires_approval"] is False and pv["cycles"]["exposed_in_scope"] == [] and pv["cycles"]["pin_to_active"] == EXPOSED
        imp = pv["impact"]
        n_ux = unexposed_work()
        assert (imp["work_answers"], imp["impacted_answers"], imp["changed_answers"], imp["gating_drift"]) == (n_ux, n_ux, n_ux, 0), imp
        hub_rx = rx_cycle() == 10
        assert pv["kpi"] and all(r["cyc_key"] in ({11} if hub_rx else {11, 12}) and not r["exposed"] for r in pv["kpi"])
        bares = {b["bare"]: b for b in pv["brands"]}
        # J2 Smart Fortwo → Kia(관계): smart 경쟁 −1·kia +1, J1 Creta 롤업(Tata 제거) 상실로 hyundai −1(언급 모수 = 활성 프로필 술어)
        if hub_rx:
            assert {k.lower(): v["delta_mentions"] for k, v in bares.items() if k.lower() in ("hyundai", "kia", "smart")} == \
                {"hyundai": -1, "kia": 1, "smart": -1}
        else:                                       # RX(JA·JC 의 Hyundai·Ioniq·N 편집)도 범위라 hyundai 는 bulk 대조로만 본다
            # 미리보기 brands 의 bare = 표시 브랜드 키(현행 프로필 NAME 은 정본 표시명 그대로 'Kia')라 소문자로 접어 본다
            assert {k.lower(): v["delta_mentions"] for k, v in bares.items() if k.lower() in ("kia", "smart")} == {"kia": 1, "smart": -1}
        cand = sorted({*bares, "hyundai", "kia", "smart", "tata", "toyota", "apple", "genesis"})
        tot0 = await _brand_totals(c, [11, 12, 21, 31], cand)
        if hub_rx:
            assert pv["samples"]["added"] == [] and {s["change"] for s in pv["samples"]["removed"]} <= {"remove"}   # 범위 밖(회차 10) 차단·재매칭은 표본에 없다
        else:
            assert {s["change"] for s in pv["samples"]["added"]} <= {"add"} and {s["change"] for s in pv["samples"]["removed"]} <= {"remove", "block"}

        await _approve(c, aid, ACTOR)                                                                 # 미노출만 = 요청자 자체 승인
        outs = await _op(c, aid, "apply")
        assert outs[-1].status == "applied", outs
        ap = await _apply_row(c, aid)
        assert ap["status"] == "applied" and ap["started_at"] and ap["finished_at"] and ap["load_id"] and ap["affected_answers"] == n_ux
        kpi1 = await _kpi_all(c)
        assert _assert_preview_equals(pv, kpi0, kpi1) == len(pv["kpi"]) > 0
        tot = await _brand_totals(c, [11, 12, 21, 31], cand)
        for b in pv["brands"]:                                       # 미리보기 브랜드 전·후 = 반영 전·후 rd(범위 회차 경쟁 행 합)
            assert (b["before_mentions"], b["before_answers"]) == tot0.get(b["bare"], (0, 0)), b
            assert (b["after_mentions"], b["after_answers"]) == tot.get(b["bare"], (0, 0)), b
        assert {k for k in cand if tot0.get(k, (0, 0)) != tot.get(k, (0, 0))} <= set(bares)          # rd 로 바뀐 브랜드는 미리보기에 있다
        # 노출 회차: rd 행 불변 + v1 고정, 범위 회차 ecat_ver 전수 = v2
        assert await _exposed_md5(c) == exp0 and (not hub_rx or await _brands(c, JA) == ja0)
        assert dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle")) == {10: 1, 11: None, 12: None, 21: None, 31: None}
        vers = {r[0]: r[1] for r in await c.fetch("SELECT cyc_key, array_agg(DISTINCT ecat_ver) FROM rd.answer GROUP BY 1")}
        assert vers[10] == [1] and all(v == [v2] for k, v in vers.items() if k != 10), vers
        assert await _brands(c, J1) == {("hyundai", True): (1, 1, 1, 3, 2, 2, 1, 0, 0, 3), ("toyota", True): (0, 2, 1, 3, 1, 0, 1, 1, 0, 3)}
        gen1 = dict(await c.fetch("SELECT surface, generation FROM rd.surface_generation"))
        assert gen1.get(1, 0) > gen0.get(1, 0)                                                         # 결과 캐시 세대 +1
        assert await c.fetchval("SELECT status FROM app.ecat_version WHERE ver = $1", v2) == "active"
        jc = await c.fetch("SELECT status FROM app.judgment_change WHERE kind = 'entity_version' ORDER BY change_id")
        assert [r[0] for r in jc] == ["applied", "applied"]
        await _bulk_equal(c)                                                                           # 청크 반영 = 전량 bulk(v2 활성·고정 보존)
        await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_all_scope_approval_then_rollback_restores_rd(monkeypatch):
    """수용 기준 1·4·5·7(승인): 전 기간(노출 회차 10 포함) → 승인자 밖 거절 → 제품 책임자 승인 반영(청크 여러 개) → 되돌리기. 표본(추가·제거)."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "2")
    monkeypatch.setenv("HGH_ECAT_STAMP_CHUNK", "5")
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        facts0 = await _md5(c, FACTS, drop=("load_id", "ecat_ver"))
        kpi0 = await _kpi_all(c)
        aid = await _request(c, v2, "all")
        assert [o.status for o in await _op(c, aid, "preview")] == ["applied"]
        pv = await _preview_json(c, aid)
        assert pv["requires_approval"] is True and pv["cycles"]["exposed_in_scope"] == EXPOSED
        assert {r["cyc_key"] for r in pv["kpi"]} == {11, rx_cycle()}                                  # RX 회차 = 프로필별(rx_cycle)
        assert {r["cyc_key"] for r in pv["kpi"] if r["exposed"]} == ({10} if rx_cycle() == 10 else set())
        assert pv["impact"]["work_answers"] == 7 and pv["approx"]["no_occurrence_answers"] >= 1   # JC(8월 모양, 발생 없음)
        smp = pv["samples"]
        assert {s["change"] for s in smp["added"]} == {"add"} and len(smp["added"]) >= 3
        for s in smp["added"]:                                       # 강조 구간 = 본문의 그 표면(위치 기반)
            assert s["context"][s["highlight"][0]:s["highlight"][1]] == s["surface"] and not s["approx"]
        assert "Polestar" in {s["surface"] for s in smp["added"]}
        rem = {(s["change"], s["surface"]) for s in smp["removed"]}
        assert ("block", "Epit") in rem and ("block", "N") in rem, rem
        blk = next(s for s in smp["removed"] if s["surface"] == "Epit")
        assert blk["context"][blk["highlight"][0]:blk["highlight"][1]] == "Epit"

        await _approve(c, aid, ACTOR)                                                                  # 승인자 목록 밖
        outs = await _op(c, aid, "apply")
        assert outs[-1].status == "failed" and "ECAT_EXPOSED_REQUIRES_APPROVAL" in outs[-1].error
        assert (await _apply_row(c, aid))["status"] == "previewed"
        assert await c.fetchval("SELECT count(*) FROM rd.cycle WHERE ecat_ver IS NOT NULL") == 0       # 아무것도 안 바뀜

        await _approve(c, aid, PRODUCT_OWNER)
        outs = await _op(c, aid, "apply")
        assert outs[-1].status == "applied" and sum(o.status == "progress" for o in outs) >= 3, [o.status for o in outs]
        kpi1 = await _kpi_all(c)
        _assert_preview_equals(pv, kpi0, kpi1)
        assert dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle")) == {10: v2, 11: None, 12: None, 21: None, 31: None}
        assert set(await c.fetchval("SELECT array_agg(DISTINCT ecat_ver) FROM rd.answer")) == {v2}
        assert (await _brands(c, JA))[("polestar", True)] == (0, 1, 1, 1, 3, 0, 0, 0, 0, 1)         # E1 손 계산 행(v2)
        assert await _brands(c, JB) == {}
        await _bulk_equal(c)

        # 되돌리기: E6 가 v1 내용의 새 초안(origin rollback)을 만들고 되돌릴 반영과 같은 범위로 요청한다
        v3 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) "
                              "VALUES (1, 'v1 로 되돌림', '시험', 'rollback', $1) RETURNING ver", ACTOR)
        await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                        note, updated_by, updated_at)
                           SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                             FROM app.ecat_entity WHERE ver = 1""", v3)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = 1", v3)
        rid = await _request(c, v3, "all")
        assert [o.status for o in await _op(c, rid, "preview")] == ["applied"]
        rpv = await _preview_json(c, rid)
        assert rpv["impact"]["work_answers"] == pv["impact"]["work_answers"] and list(rpv["impact"]["by_version"]) == [str(v2)]
        await _approve(c, rid, PRODUCT_OWNER)
        assert (await _op(c, rid, "apply"))[-1].status == "applied"
        assert await _md5(c, FACTS, drop=("load_id", "ecat_ver")) == facts0, "되돌리기 뒤 사실 표가 반영 전과 다르다"
        assert set(await c.fetchval("SELECT array_agg(DISTINCT ecat_ver) FROM rd.answer")) == {v3}
        _assert_preview_equals(rpv, kpi1, await _kpi_all(c))
        assert (await _apply_row(c, aid))["status"] == "rolled_back" and (await _apply_row(c, rid))["status"] == "applied"
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_stale_preview_and_concurrent_apply(monkeypatch):
    """수용 기준 6·7: 미리보기 뒤 원천 변경 → ECAT_PREVIEW_STALE, 무관한 새 load 는 통과, 동시 반영 ECAT_APPLY_RUNNING."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        aid = await _request(c, v2, "unexposed")
        await _op(c, aid, "preview")
        await _approve(c, aid, ACTOR)
        await c.execute("INSERT INTO ing.load (kind, rule_ver, status) VALUES ('run', 1, 'committed')")   # 무관한 새 커밋 load
        sp = c.transaction()
        await sp.start()
        # 원천 변경: 작업 답변 J1 이 다시 적재됐다(새 load 가 행을 다시 씀)
        lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, status) VALUES ('run', 1, 'committed') RETURNING load_id")
        await c.execute("UPDATE ing.answer SET load_id = $2 WHERE job_id = $1", J1, lid)
        outs = await _op(c, aid, "apply")
        assert outs[-1].status == "failed" and outs[-1].error.startswith("ECAT_PREVIEW_STALE"), outs
        ap = await _apply_row(c, aid)
        assert ap["status"] == "previewed" and ap["error"].startswith("ECAT_PREVIEW_STALE")
        assert await c.fetchval("SELECT status FROM app.ecat_version WHERE ver = $1", v2) == "draft"      # 활성화 전 거절
        await sp.rollback()
        # 미리보기 뒤 초안 내용 편집(load 는 그대로) → 버전 내용 지문이 달라 거절
        sp = c.transaction()
        await sp.start()
        await c.execute("UPDATE app.ecat_entity SET role = 'removed' WHERE ver = $1 AND entity_id = $2", v2, KIA_KO)
        outs = await _op(c, aid, "apply")
        assert outs[-1].status == "failed" and outs[-1].error.startswith("ECAT_PREVIEW_STALE"), outs
        await sp.rollback()

        # 원천 그대로면 통과(무관한 load 뒤): 청크 1 이라 첫 처리 뒤 running 으로 남는다
        cid = await _enqueue(c, aid, "apply")
        await c.execute("SET ROLE loader")
        try:
            first = await process_change(DB, c, change_id=cid)
        finally:
            await c.execute("RESET ROLE")
        assert first.status == "progress" and (await _apply_row(c, aid))["status"] == "running"
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver = $1", -v2) == unexposed_work() - 1   # 대기 표시(재개 원장)
        # 동시 반영: 두 번째 요청은 엔진이 대기시키고(큐 deferred), DB 는 running 두 행을 거부한다
        bid = await _request(c, v2, "unexposed")
        outs = await _op(c, bid, "preview")
        assert outs[-1].status == "deferred" and "ECAT_APPLY_RUNNING" in outs[-1].error
        sp = c.transaction()
        await sp.start()
        await c.execute("UPDATE app.ecat_apply SET status = 'previewed' WHERE apply_id = $1", bid)
        await _approve(c, bid, ACTOR)
        with pytest.raises(asyncpg.UniqueViolationError, match="ecat_apply_one_running"):
            await c.execute("UPDATE app.ecat_apply SET status = 'running', started_at = now() WHERE apply_id = $1", bid)
        await sp.rollback()
        outs = await _run(c, cid)                                                                          # 첫 반영을 끝까지
        assert outs[-1].status == "applied"
        await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_chunk_failure_then_resume(monkeypatch):
    """수용 기준 8: 청크 실패 → failed(대기 표시 남음, 다른 요청 대기) → resume → applied, 결과 = bulk."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    real = ee.project
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 청크 실패")
        return await real(*a, **k)

    monkeypatch.setattr(ee, "project", flaky)
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        aid = await _request(c, v2, "unexposed")
        await _op(c, aid, "preview")
        await _approve(c, aid, ACTOR)
        outs = await _op(c, aid, "apply")
        assert [o.status for o in outs] == ["progress", "failed"], outs
        ap = await _apply_row(c, aid)
        assert ap["status"] == "failed" and "시험 주입" in ap["error"]
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver = $1", -v2) == unexposed_work() - 1   # 청크 1개 처리
        other = await _request(c, v2, "unexposed")
        assert (await _op(c, other, "preview"))[-1].status == "deferred"                               # 실패 반영이 있으면 대기
        outs = await _op(c, aid, "resume")
        assert outs[-1].status == "applied", outs
        assert (await _apply_row(c, aid))["status"] == "applied"
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver < 0") == 0
        for j in (J1, J2, J3):
            assert ("tata", True) not in await _brands(c, j)
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_from_round_scope_and_deterministic_fingerprint(monkeypatch):
    """from_round(09-14 부터): 기준일 09-20 이면 노출 = 10·11·21 → 범위 = 11·21(노출) + 12·31(미노출), 10 은 v1 고정. 지문 결정성."""
    monkeypatch.setattr(ee, "TODAY_OVERRIDE", dt.date(2026, 9, 20))
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        aid = await _request(c, v2, "from_round", dt.date(2026, 9, 14))
        await _op(c, aid, "preview")
        ap1 = await _apply_row(c, aid)
        await _op(c, aid, "preview")
        ap2 = await _apply_row(c, aid)
        assert bytes(ap1["preview_set_md5"]) == bytes(ap2["preview_set_md5"]) and list(ap2["cycle_keys"]) == [11, 12, 21, 31]
        pv = await _preview_json(c, aid)
        assert pv["requires_approval"] is True and pv["cycles"]["exposed_in_scope"] == [11, 21] and pv["cycles"]["pin_to_active"] == [10]
        kpi0 = await _kpi_all(c)
        await _approve(c, aid, PRODUCT_OWNER)
        assert (await _op(c, aid, "apply"))[-1].status == "applied"
        _assert_preview_equals(pv, kpi0, await _kpi_all(c))
        assert dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle")) == {10: 1, 11: v2, 21: v2, 12: None, 31: None}
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()



@needs_db
async def test_scan_failure_fails_only_that_request(monkeypatch):
    """미리보기 전 재스캔 실패 → 그 요청만 failed(ECAT_SCAN_FAILED, 반영은 draft 그대로 + 오류 문구), 큐 처리는 예외 없이 끝난다."""
    async def broken(db, payload):
        raise RuntimeError("시험 주입: 스캔 실패")
    monkeypatch.setattr(ee, "prepare", broken)
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        aid = await _request(c, v2, "unexposed")
        outs = await _op(c, aid, "preview")
        assert outs[-1].status == "failed" and outs[-1].error.startswith("ECAT_SCAN_FAILED"), outs
        ap = await _apply_row(c, aid)
        assert ap["status"] == "draft" and ap["error"].startswith("ECAT_SCAN_FAILED") and ap["preview"] is None
        await tr.rollback()
    finally:
        await c.close()
