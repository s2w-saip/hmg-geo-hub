"""보관 관문(DB-v2.21 P117, 설계 12.11) 경로별 시험: 동결된 답변의 rd 사실 행이 관문을 지나 다시 쓰이면 다시 쓰기 직전 값 한 벌만
(세대, 답변) 단위로 frz.keep_* 에 남고, 동결 읽기 뷰(frz.answer·answer_brand·citation)는 그대로다. 같은 값으로 다시 쓰면 보관이 정리된다.
경로 = 관문 함수 직접(_write_facts 와 같은 순서) · 적재기 재pull(apply) · 재투영(reproject) · 재판정(rejudge) · WU-5 재투영 도구 ·
bulk 재구축(seed-30·40) · 재생성 해제(frz.release). 엔titi 반영·되돌리기·포기는 test_keep_ecat.py.
검증 반례(be/frz-s1 검증): P1 관문 밖 다표 문장은 보관하지 않는다(문서화된 경계), P2 리프 직접 쓰기는 권한 오류, P12 세대마다 따로 보관.
전부 롤백 트랜잭션(복제본 불변). 쓰기 경로는 loader 롤(SET ROLE)로 돌려 관문의 SECURITY DEFINER 권한도 확인한다.
"""
from __future__ import annotations

import asyncpg
import pytest

from app.core.profile import OFF
from ingest.frz.tests.support import freeze, frozen_keys, frz_counts, job_of, keep_rows_of, kept, kept_pairs, rd_rows_of, view_rows
from ingest.project.apply.service import apply, reproject
from ingest.project.apply.tests.test_ecat_overlay import _as_loader
from ingest.project.apply.tests.test_equivalence import _ctx, _keys
from ingest.testkit import bulk_seed
from tests.support import DB_URL, needs_db

pytestmark = needs_db
GLOBAL_CYC, WEB_CYC = 11, 21


async def _conn() -> tuple[asyncpg.Connection, asyncpg.transaction.Transaction]:
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    return c, tr


async def _brand_answer(c: asyncpg.Connection) -> int:
    """브랜드 행이 있는 동결 답변 하나(가장 작은 키)."""
    return int(await c.fetchval("SELECT min(c.answer_key) FROM frz.cell c WHERE EXISTS (SELECT 1 FROM rd.answer_brand b "
                                "WHERE b.surface = c.surface AND b.round_date = c.round_date AND b.answer_key = c.answer_key AND b.mention_count > 0)"))


async def _gated(c: asyncpg.Connection, keys: list[int], *stmts: str) -> tuple[int, int]:
    """관문을 지나는 다시 쓰기(_write_facts 와 같은 순서, loader 롤): keep_rewrite → 문장 → keep_settle. 반환 = (보관, 정리)."""
    await c.execute("SET ROLE loader")
    try:
        n = int(await c.fetchval("SELECT frz.keep_rewrite($1::int4[], 'apply')", keys))
        for s in stmts:
            await c.execute(s, keys[0]) if "$1" in s else await c.execute(s)
        m = int(await c.fetchval("SELECT frz.keep_settle($1::int4[], 'apply')", keys))
    finally:
        await c.execute("RESET ROLE")
    return n, m


def _restrict(before: dict[str, list[str]], keys: list[int]) -> dict[str, list[str]]:
    """앞서 찍은 rd 행 중 그 답변 것만(jsonb answer_key 로 거른다)."""
    import json
    return {t: [r for r in rows if json.loads(r)["answer_key"] in keys] for t, rows in before.items()}


async def test_gate_keeps_first_value_only():
    """관문: 같은 값·대표만 바뀐 다시 쓰기는 보관 정리, 값이 바뀌면 첫 값만(두 번째·세 번째 변경은 무시), 삭제·파티션 이동도 직전 값. 뷰 불변."""
    c, tr = await _conn()
    try:
        await freeze(c, [GLOBAL_CYC, WEB_CYC])
        v0 = await view_rows(c)
        assert v0["answer"] and v0["answer_brand"]
        keys = await frozen_keys(c)
        before = await rd_rows_of(c, keys)

        n, m = await _gated(c, keys, "UPDATE rd.answer SET is_rep = NOT is_rep, load_id = load_id + 1 WHERE answer_key = ANY($1::int4[])"
                            .replace("$1::int4[]", "ARRAY" + str(keys)))
        assert n == len(keys) and m == n and await kept(c) == {}, "대표·적재 번호만 바뀐 다시 쓰기는 보관이 정리된다"
        assert await view_rows(c) == v0

        ak = await _brand_answer(c)
        n, m = await _gated(c, [ak], "UPDATE rd.answer_brand SET mention_count = mention_count + 1 WHERE answer_key = $1")
        assert (n, m) == (1, 0) and await kept(c) == {ak: "apply"}
        assert await _gated(c, [ak], "UPDATE rd.answer SET ment_total = ment_total + 1 WHERE answer_key = $1") == (0, 0)   # 두 번째
        await _gated(c, [ak], "UPDATE rd.answer_brand SET mention_count = mention_count + 5 WHERE answer_key = $1")      # 세 번째
        assert await keep_rows_of(c, [ak]) == _restrict(before, [ak]), "보관 = 첫 변경 직전 값(이후 변경은 반영하지 않는다)"
        assert await view_rows(c) == v0

        other = [k for k in keys if k != ak][0]
        await _gated(c, [other], "DELETE FROM rd.answer WHERE answer_key = $1")
        assert (await kept(c))[other] == "apply" and await keep_rows_of(c, [other]) == _restrict(before, [other])
        assert await view_rows(c) == v0, "답변이 rd 에서 사라져도 동결 뷰는 보관 행으로 같은 값"

        third = [k for k in keys if k not in (ak, other)][0]
        await c.execute("SELECT rd.ensure_leaf(1::int2, '2026-08-01'::date)")
        await _gated(c, [third], "UPDATE rd.answer SET round_date = round_date - 20 WHERE answer_key = $1")
        assert (await kept(c))[third] == "apply", "좌석(파티션) 이동은 셀 좌석에 rd 행이 없어져 값이 다르다 = 보관 유지"
        assert await view_rows(c) == v0
    finally:
        await tr.rollback()
        await c.close()


async def test_outside_gate_is_not_kept_documented_boundary():
    """P1(문서화된 경계): 관문 밖 쓰기(직접 SQL·한 문장 다표 데이터 변경 CTE)는 보관하지 않는다. 적재 코드에 그런 쓰기가 없음은 정적 가드
    (tests/core/test_frz_keep_gate.py), API 는 SQL 경계 가드 G6 이 막는다. 동결 셀이 없으면 관문도 할 일 없음."""
    c, tr = await _conn()
    try:
        assert await c.fetchval("SELECT frz.keep_rewrite(ARRAY(SELECT answer_key FROM rd.answer), 'apply')") == 0   # 동결 셀 없음
        await freeze(c, [GLOBAL_CYC])
        ak = await _brand_answer(c)
        await c.execute("SET ROLE loader")
        await c.execute("""WITH d1 AS (DELETE FROM rd.citation WHERE answer_key = $1 RETURNING 1),
                                d2 AS (DELETE FROM rd.answer_brand WHERE answer_key = $1 RETURNING 1)
                           DELETE FROM rd.answer WHERE answer_key = $1""", ak)
        await c.execute("RESET ROLE")
        assert await kept(c) == {}, "관문 밖 다표 문장은 보관하지 않는다(경계)"
        assert await c.fetchval("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'frz%' "
                                "AND tgrelid IN ('rd.answer'::regclass, 'rd.answer_brand'::regclass, 'rd.citation'::regclass)") == 0
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.parametrize("role", ["loader", "migrator"])
async def test_leaf_partition_dml_denied(role):
    """P2: rd 사실 표 하위 파티션(표면 파티션·월 리프, rd.ensure_leaf 가 새로 만든 리프 포함) 직접 쓰기는 권한 오류. 루트로는 쓴다."""
    c, tr = await _conn()
    try:
        await c.execute("SELECT rd.ensure_leaf(1::int2, '2027-01-01'::date)")
        ak = int(await c.fetchval("SELECT min(answer_key) FROM rd.answer WHERE surface = 1"))
        await c.execute(f"SET ROLE {role}")
        try:
            assert await c.execute("UPDATE rd.answer SET ment_total = ment_total WHERE answer_key = $1", ak) == "UPDATE 1"
            for leaf in ("rd.answer_g", "rd.answer_g_202609", "rd.answer_brand_g_202609", "rd.citation_g_202609", "rd.answer_g_202701",
                         "rd.citation_w"):
                for sql in (f"UPDATE {leaf} SET round_date = round_date WHERE false", f"DELETE FROM {leaf} WHERE false",
                            f"TRUNCATE {leaf}"):
                    with pytest.raises(asyncpg.InsufficientPrivilegeError):
                        async with c.transaction():
                            await c.execute(sql)
        finally:
            await c.execute("RESET ROLE")
        assert await c.fetchval("SELECT frz.assert_shape()") == 3
    finally:
        await tr.rollback()
        await c.close()


async def test_keep_is_per_generation():
    """P12: 같은 답변을 셀로 가진 세대가 둘이면 보관도 세대마다다. 변경 뒤에 동결한 세대는 그때 rd 값(옛 보관 값이 아니다)을 읽고,
    그 뒤 변경에서는 자기 보관(자기 동결 시점 값)을 갖는다."""
    c, tr = await _conn()
    try:
        g1 = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        ak = await _brand_answer(c)
        mt0 = int(await c.fetchval("SELECT ment_total FROM rd.answer WHERE answer_key = $1", ak))
        await _gated(c, [ak], "UPDATE rd.answer SET ment_total = ment_total + 5 WHERE answer_key = $1")
        g2 = await c.fetchval("INSERT INTO frz.generation (cyc_key, surface, source) VALUES (12, 1, 'hub') RETURNING gen_key")
        await c.execute("INSERT INTO frz.cell SELECT $1, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key "
                        "FROM frz.cell WHERE answer_key = $2 AND gen_key = $3", g2, ak, g1)
        await c.execute("INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, in_root_catalog, catalog_deleted, cat_mask) "
                        "SELECT $1, prompt_key, cyc_key, in_full_cycle, in_root_catalog, catalog_deleted, cat_mask FROM frz.prompt "
                        "WHERE gen_key = $2 AND prompt_key = (SELECT prompt_key FROM frz.cell WHERE gen_key = $2 AND answer_key = $3)", g2, g1, ak)
        await c.execute("SELECT frz.activate($1)", g2)
        q = "SELECT ment_total FROM frz.answer WHERE answer_key = $1 ORDER BY 1"          # 뷰 = 세대 셀마다 한 행
        kq = "SELECT gen_key, ment_total FROM frz.keep_answer WHERE answer_key = $1 ORDER BY 1"
        assert [r[0] for r in await c.fetch(q, ak)] == [mt0, mt0 + 5], "뒤 세대는 동결 시점 rd 값(앞 세대 보관 값이 아니다)"
        assert [tuple(r) for r in await c.fetch(kq, ak)] == [(g1, mt0)]
        await _gated(c, [ak], "UPDATE rd.answer SET ment_total = ment_total + 7 WHERE answer_key = $1")
        assert await kept_pairs(c) == {(g1, ak): "apply", (g2, ak): "apply"}
        assert [tuple(r) for r in await c.fetch(kq, ak)] == [(g1, mt0), (g2, mt0 + 5)], "보관은 세대마다 자기 동결 시점 값"
        assert [r[0] for r in await c.fetch(q, ak)] == [mt0, mt0 + 5], "각 세대 = 자기 동결 시점 값(rd 지금 값 아님)"
        rel = await c.fetchval("SELECT frz.release($1, '세대 단위 해제 시험')::text", g2)
        assert '"kept_released": 1' in rel and await kept_pairs(c) == {(g1, ak): "apply"}, "해제는 그 세대 보관만 지운다"
    finally:
        await tr.rollback()
        await c.close()


async def test_loader_repull_keeps_generation_values():
    """적재기 재pull(apply): 동결 답변의 ing 언급 값이 바뀌어 다시 적재되면 rd 는 새 값, 동결 뷰는 옛 값, 두 번째 재적재도 첫 값 유지."""
    c, tr = await _conn()
    try:
        await freeze(c, [GLOBAL_CYC])
        v0 = await view_rows(c)
        ak = await _brand_answer(c)
        job = await job_of(c, ak)
        before = await rd_rows_of(c, [ak])
        ctx = await _ctx(c)
        await c.execute("UPDATE ing.mention SET mention_count = mention_count + 3 WHERE job_id = $1 AND ord = "
                        "(SELECT min(ord) FROM ing.mention WHERE job_id = $1 AND brand_rollup_entity_id IS NOT NULL)", job)
        keys = await _keys(c, "a.job_id = $1", job)
        res = await _as_loader(c, lambda: apply(c, ctx, keys))
        assert (await kept(c)).get(ak) == "apply" and res.frz_kept >= 1
        assert await rd_rows_of(c, [ak]) != before, "전제: 재적재로 rd 값이 바뀌었다"
        assert await keep_rows_of(c, [ak]) == before
        assert await view_rows(c) == v0
        await c.execute("UPDATE ing.mention SET mention_count = mention_count + 4 WHERE job_id = $1", job)
        await _as_loader(c, lambda: apply(c, ctx, keys))
        assert await keep_rows_of(c, [ak]) == before, "두 번째 변경 뒤에도 첫 값"
        assert await view_rows(c) == v0
    finally:
        await tr.rollback()
        await c.close()


async def test_reproject_and_rejudge_paths():
    """재투영(service.reproject = WU-5 도구·재판정이 쓰는 경로)·재판정(rejudge catalog): 관문이 다시 쓰는 동결 답변을 보관했다가, 값이 같으므로
    같은 트랜잭션 끝에서 정리한다(보관 0). 동결 뷰 불변."""
    from ingest.project.apply.rejudge import rejudge

    c, tr = await _conn()
    try:
        await freeze(c, [GLOBAL_CYC, WEB_CYC])
        v0 = await view_rows(c)
        g_keys = [int(r[0]) for r in await c.fetch("SELECT answer_key FROM frz.cell WHERE cyc_key = $1", GLOBAL_CYC)]
        ctx = await _ctx(c)
        res = await _as_loader(c, lambda: reproject(c, ctx, g_keys))
        assert res.frz_kept >= len(g_keys) and res.frz_settled == res.frz_kept, (res.frz_kept, res.frz_settled)
        assert await kept(c) == {} and await view_rows(c) == v0, "같은 값 재투영은 관문 안에서 정리된다"

        pid = await c.fetchval("SELECT d.prompt_id FROM frz.cell c JOIN rd.dim_prompt d ON d.prompt_key = c.prompt_key "
                               "WHERE c.cyc_key = $1 ORDER BY c.answer_key LIMIT 1", WEB_CYC)
        w_keys = {int(r[0]) for r in await c.fetch("SELECT c.answer_key FROM frz.cell c JOIN rd.dim_prompt d ON d.prompt_key = c.prompt_key "
                                                   "WHERE d.prompt_id = $1", pid)}
        res2 = await _as_loader(c, lambda: rejudge(c, ctx, "catalog", subject_uuids=[pid]))
        assert w_keys and res2.frz_kept >= len(w_keys) and res2.frz_settled == res2.frz_kept, "catalog 재판정이 관문을 지났다"
        assert await kept(c) == {} and await view_rows(c) == v0
    finally:
        await tr.rollback()
        await c.close()


async def test_wu5_reproject_tool_path():
    """WU-5 재투영 도구(wu5_reproject.run commit): 끔으로 적재된 동결 답변을 켬 프로필로 다시 쓰면 값이 바뀌므로 관문 보관이 남는다(src apply).
    대상 = 합성 G21A 인용(test_wu5_projection SYNTH). 슈퍼유저 한 트랜잭션(bulk 가 만든 pg_temp 표를 적재 경로가 이어 쓴다)."""
    from app.core.config import get_settings, set_settings
    from ingest.project.apply import wu5_reproject
    from ingest.project.apply.tests.test_wu5_projection import J21, SPEC, SYNTH

    c, tr = await _conn()
    settings = get_settings()
    try:
        await c.execute(SYNTH)
        await bulk_seed(c, profile=OFF)                                                         # 끔(허브 기본)으로 적재된 상태, 동결 전
        ak = int(await c.fetchval("SELECT answer_key FROM rd.job WHERE job_id = $1", J21))
        cyc = int(await c.fetchval("SELECT cyc_key FROM rd.answer WHERE answer_key = $1", ak))
        await c.execute("UPDATE rd.answer SET is_rep = true WHERE answer_key = $1", ak)        # 동결 셀에 들도록(대표만 = 장부 열)
        await freeze(c, [cyc])
        v0 = await view_rows(c)
        before = await rd_rows_of(c, [ak])
        set_settings(settings.model_copy(update={"legacy_profile": SPEC[True]}))
        out = await wu5_reproject.run(c, commit=True)
        assert out["reprojected"] == 1, out
        assert (await kept(c)).get(ak) == "apply", out
        assert await keep_rows_of(c, [ak]) == before and await rd_rows_of(c, [ak]) != before
        assert await view_rows(c) == v0
    finally:
        set_settings(settings)
        await tr.rollback()
        await c.close()


async def test_bulk_rebuild_keeps_then_settles():
    """bulk 재구축(seed-30·40): 비우기 직전 동결 답변 전부를 보관하고(src bulk), seed-40 끝 frz.keep_settle(NULL, 'bulk') 가 같은 값을 정리한다.
    원천(ing)이 바뀌어 재구축 값이 달라진 답변만 옛 값으로 남는다. 동결 뷰 불변. 이관 명시 모드(frz_no_keep)는 보관하지 않는다."""
    c, tr = await _conn()
    try:
        await freeze(c, [GLOBAL_CYC, WEB_CYC])
        ak = await _brand_answer(c)
        before = await rd_rows_of(c, [ak])
        v0 = await view_rows(c)
        await c.execute("UPDATE ing.mention SET mention_count = mention_count + 2 WHERE job_id = $1", await job_of(c, ak))
        await bulk_seed(c, profile=OFF)
        assert await kept(c) == {ak: "bulk"}, "재구축 뒤에는 값이 달라진 답변만 남는다(나머지는 같은 값 = 정리)"
        assert await keep_rows_of(c, [ak]) == before and await rd_rows_of(c, [ak]) != before
        assert await view_rows(c) == v0
        assert (await frz_counts(c))["cells"] > 0
        sp = c.transaction()
        await sp.start()
        await c.execute("SELECT frz.release(gen_key, '이관 모드 시험') FROM frz.generation WHERE state = 'active'")
        await freeze(c, [GLOBAL_CYC])
        await bulk_seed(c, profile=OFF, frz_keep=False)                                        # 이관 명시 모드: 보관 안 함
        assert await kept(c) == {}
        await sp.rollback()
    finally:
        await tr.rollback()
        await c.close()


async def test_release_clears_keep_and_refreeze_takes_current():
    """재생성 해제(frz.release): 그 세대의 보관을 지우고, 새 세대는 지금 값을 동결한다. 해제는 사유 필수·두 번 불가."""
    c, tr = await _conn()
    try:
        gens = await freeze(c, [GLOBAL_CYC])
        ak = await _brand_answer(c)
        await _gated(c, [ak], "UPDATE rd.answer_brand SET mention_count = mention_count + 2 WHERE answer_key = $1")
        assert set(await kept(c)) == {ak}
        with pytest.raises(asyncpg.RaiseError):
            async with c.transaction():
                await c.execute("SELECT frz.release($1, '')", gens[GLOBAL_CYC])
        out = await c.fetchval("SELECT frz.release($1, '재해석 시험')::text", gens[GLOBAL_CYC])
        assert '"kept_released": 1' in out
        assert await kept(c) == {} and (await frz_counts(c))["keep_brand"] == 0
        with pytest.raises(asyncpg.RaiseError):
            async with c.transaction():
                await c.execute("SELECT frz.release($1, '두 번')", gens[GLOBAL_CYC])
        await freeze(c, [GLOBAL_CYC])
        cur = await rd_rows_of(c, [ak])
        rows = [r[0] for r in await c.fetch(
            "SELECT (to_jsonb(x) - '{is_rep,load_id,ecat_ver,rule_ver}'::text[])::text FROM frz.answer_brand x WHERE answer_key = $1 ORDER BY 1", ak)]
        assert rows == cur["answer_brand"], "새 세대 = 지금 값"
        assert await c.fetchval("SELECT count(*) FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", GLOBAL_CYC) == 1
        with pytest.raises((asyncpg.UniqueViolationError, asyncpg.CheckViolationError)):
            async with c.transaction():
                await c.execute("UPDATE frz.generation SET state = 'active', activated_at = now() WHERE gen_key = $1", gens[GLOBAL_CYC])
    finally:
        await tr.rollback()
        await c.close()


async def test_shape_and_gate_noop_without_cells():
    """모양 단언(보관 표 = rd 열 + gen_key·뷰 열 = rd 열·rd frz 트리거 없음·리프 쓰기 권한 없음) 통과, 동결 셀이 없으면 관문도 쓰기 없음."""
    c, tr = await _conn()
    try:
        assert await c.fetchval("SELECT frz.assert_shape()") == 3
        keys = [int(r[0]) for r in await c.fetch("SELECT answer_key FROM rd.answer")]
        assert await _gated(c, keys, "UPDATE rd.answer_brand SET mention_count = mention_count + 1") == (0, 0)
        assert await frz_counts(c) == {"gens": 0, "active": 0, "cells": 0, "prompts": 0, "kept": 0, "keep_answer": 0, "keep_brand": 0,
                                       "keep_citation": 0}
    finally:
        await tr.rollback()
        await c.close()
