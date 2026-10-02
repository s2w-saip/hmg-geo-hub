"""동결 층 answer_brand 운영 summary 접기(현행 프로필 brand_card_fold, DB-v2.27 frz.keep_fold, ingest.frz.fold) 시험. 합성 픽스처, 롤백 트랜잭션.

패턴(stg 2026-10-02 글로벌 3 회차 실패와 같은 모양): 한 답변에 bare-only 비경쟁 Brand 'smart'(맨 이름, 비경쟁)와 그 브랜드로 롤업되는 경쟁 Product
'Smart Fortwo'(bare-only 되살림) + 당사 '기아'(Kia 롤업). 픽스처 답변 2 가 그대로 그 모양이다(fixture-10-data.sql _m k=2). 뒤집힘 시나리오는
비경쟁 Brand 위치를 0.5 로 당긴다(운영 8907690a: 비경쟁 Smart 50.33 이 경쟁 Smart Fortwo 72.33 보다 앞이라 Smart 7 · Škoda 8).

운영 규칙의 독립 구현(파이썬 ref_ops_rows, 2670a16 lib/summary/generate/load.ts:78-98·fold.ts:319-323·492-509):
  언급 → (롤업 id, 표시 브랜드) 그룹, is_competitor = any(pass), 언급 = 합, first_rank = min(avg_position)(pass 무관), 경쟁 순위 = 경쟁 그룹을 표시
  브랜드로 묶은 min(first_rank) 의 rank()(동률 같은 순위, 다음 건너뜀). pass = bare 가 비경쟁 명부에 없거나, bare-only 이름이면 자기 표기가
  되살리기 패턴에 맞음(non-competitor-brands.ts BARE_ONLY, fixture-00-rules smart '^[ws]*smart[^[:alnum:]]').
"""
from __future__ import annotations

import json
import re
import uuid

import asyncpg
import pytest

from ingest.frz import fold as FD
from ingest.frz import freeze as F
from ingest.frz.tests.fold_oracle import HCOLS, answer_cols, oracle, rows_of
from ingest.frz.tests.support import freeze, kept
from ingest.project.apply.service import reproject
from ingest.project.apply.tests.test_equivalence import _ctx
from ingest.testkit import bulk_seed
from tests.support import DB_URL, TEST_NAME_KEY, needs_db

pytestmark = needs_db
GLOBAL_CYC = 11
A2 = 2
J2 = uuid.UUID("90000000-0000-4000-8000-000000000002")
SMART_ROLLUP = uuid.UUID("71000000-0000-4000-8000-000000000006")
BASE = "cell_rep,rep_pick_latest_first,catalog_incl_deleted,web_registered_only,freeze_at_publish,display_name_latin"
ON = BASE + ",brand_card_fold"
COLS = "brand_key, competitive, own_bit, entity_rows, rid_n, mention_count, rk"


def ref_ops_rows(mentions: list[dict]) -> dict[tuple[int, bool], dict]:
    """운영 세부층 접기 → 허브 행 모양((브랜드 키, 경쟁) → 측정값). mentions: rid·brand_key·pass·mc·avg."""
    grp: dict[tuple, dict] = {}
    for m in mentions:
        g = grp.setdefault((m["rid"], m["brand_key"]), {"comp": False, "mc": 0, "fr": None, "n": 0})
        g["comp"] = g["comp"] or m["pass"]
        g["mc"] += m["mc"]
        g["n"] += 1
        if m["avg"] is not None:
            g["fr"] = m["avg"] if g["fr"] is None else min(g["fr"], m["avg"])
    rows: dict[tuple[int, bool], dict] = {}
    for (rid, bk), g in grp.items():
        r = rows.setdefault((bk, g["comp"]), {"mention_count": 0, "entity_rows": 0, "rids": set(), "tp": None})
        r["mention_count"] += g["mc"]
        r["entity_rows"] += g["n"]
        r["rids"].add(rid)
        if g["fr"] is not None:
            r["tp"] = g["fr"] if r["tp"] is None else min(r["tp"], g["fr"])
    ranked = sorted(((r["tp"], bk) for (bk, comp), r in rows.items() if comp and bk != 0 and r["tp"] is not None))
    rk = {bk: 1 + sum(1 for t, _ in ranked if t < tp) for tp, bk in ranked}
    return {(bk, comp): {"mention_count": r["mention_count"], "entity_rows": r["entity_rows"], "rid_n": len(r["rids"]),
                         "rk": rk.get(bk, 0) if comp else 0} for (bk, comp), r in rows.items()}


async def _conn() -> tuple[asyncpg.Connection, asyncpg.transaction.Transaction]:
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    return c, tr


async def _as_loader(c: asyncpg.Connection, fn):
    """적재 경로(loader 롤). 세션 복제본이 끔 투영이라 _setup 이 bulk 시드(소유자)를 돈 연결이면 그 임시 표(_meff·_alias_map 등)를 loader 가
    다시 만들 수 없어 소유자로 돈다(권한 확인은 NAME 투영 세션 = 켬 실행에서)."""
    if not TEST_NAME_KEY:
        return await fn()
    await c.execute("SET ROLE loader")
    try:
        return await fn()
    finally:
        await c.execute("RESET ROLE")


async def _setup(c: asyncpg.Connection, flip: bool) -> None:
    """rd 를 활성 프로필(시험 표식, 이름 규칙 NAME 켬)로 다시 투영한다: 세션 복제본이 끔 투영이면 표시 브랜드 키가 섞이므로 먼저 bulk 시드로 전량,
    이어서 답변 2 를 적재기 경로(reproject)로 한 번 더. flip 이면 비경쟁 Brand 'smart' 위치를 경쟁 언급들보다 앞(0.5)으로."""
    if flip:
        await c.execute("UPDATE ing.mention SET avg_position = 0.5 WHERE job_id = $1 AND entity_type = 'Brand' AND brand_rollup_entity_id = $2",
                        J2, SMART_ROLLUP)
    if not TEST_NAME_KEY:
        await bulk_seed(c)
    ctx = await _ctx(c)
    await _as_loader(c, lambda: reproject(c, ctx, [A2]))


async def _ref(c: asyncpg.Connection) -> dict[tuple[int, bool], dict]:
    """답변 2 의 운영 접기 기대값(독립 구현). 브랜드 키는 rd 행에서(표시 브랜드 이름 규칙은 NAME 시험 몫): 비경쟁 행의 키 = Smart, 당사 행 = Kia."""
    rd = [dict(r) for r in await c.fetch(f"SELECT {COLS} FROM rd.answer_brand WHERE answer_key = $1", A2)]
    smart = {r["brand_key"] for r in rd if not r["competitive"]}
    kia = {r["brand_key"] for r in rd if r["own_bit"]}
    assert len(smart) == 1 and len(kia) == 1, rd
    smart_k, kia_k = smart.pop(), kia.pop()
    pat = re.compile(r"^[\s　﻿]*smart[^0-9a-z]", re.I)      # fixture-00-rules smart bare_only_pattern(POSIX [:alnum:] 의 ASCII 부분)
    ms = []
    for m in await c.fetch("SELECT display_name, brand_rollup_entity_id, mention_count, avg_position FROM ing.mention "
                           "WHERE job_id = $1 AND brand_rollup_entity_id IS NOT NULL", J2):
        is_smart = m["brand_rollup_entity_id"] == SMART_ROLLUP
        ms.append({"rid": m["brand_rollup_entity_id"], "brand_key": smart_k if is_smart else kia_k,
                   "pass": bool(pat.match(m["display_name"])) if is_smart else True,    # kia 는 비경쟁 명부 밖
                   "mc": int(m["mention_count"]), "avg": m["avg_position"]})
    return ref_ops_rows(ms)


async def _keep_rows(c: asyncpg.Connection, view: str = "frz.keep_answer_brand") -> dict[tuple[int, bool], dict]:
    return {(int(r["brand_key"]), r["competitive"]): {k: int(r[k]) for k in ("mention_count", "entity_rows", "rid_n", "rk")}
            for r in await c.fetch(f"SELECT {COLS} FROM {view} WHERE answer_key = $1", A2)}


@pytest.mark.legacy_profile(ON)
async def test_fold_flips_rank_and_matches_ops_rule():
    """켬 + 뒤집힘: 접힌 1행(경쟁, 언급 합 2, 롤업 1, 순위 1 = 비경쟁 위치 0.5), 당사 Kia 순위 2, 답변 분모 3 → 4. rd·미러 행은 그대로(Smart 2행)."""
    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        rd_before = await c.fetch(f"SELECT {COLS} FROM rd.answer_brand WHERE answer_key = $1 ORDER BY 1, 2", A2)
        rd_answer = await c.fetchrow("SELECT ment_total, ment_k, own_rk_k FROM rd.answer WHERE answer_key = $1", A2)
        assert len(rd_before) == 3 and (rd_answer["ment_total"], rd_answer["ment_k"], rd_answer["own_rk_k"]) == (3, 2, 1)
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        res = await _as_loader(c, lambda: FD.keep_generation(c, g))
        assert res == {"candidates": 1, "kept": 1}
        assert await kept(c) == {A2: "fold"}, "공존 답변만 보관(공존 아닌 셀은 0)"
        ref = await _ref(c)
        got = await _keep_rows(c)
        assert got == ref, (got, ref)
        smart = [v for (bk, comp), v in got.items() if v["rid_n"] == 1 and v["entity_rows"] == 2]
        assert len(got) == 2 and smart == [{"mention_count": 2, "entity_rows": 2, "rid_n": 1, "rk": 1}]
        assert sorted(v["rk"] for v in got.values()) == [1, 2]                         # 운영: Smart 1(0.5) · Kia 2(1.0) = 뒤집힘
        a = await c.fetchrow("SELECT ment_total, ment_k, own_rk_k, own_mask FROM frz.keep_answer WHERE answer_key = $1", A2)
        assert (a["ment_total"], a["ment_k"], a["own_rk_k"]) == (4, 2, 2)              # 카드 분모 = 접힌 경쟁 행 언급 합(운영 comp_mentions)
        # 카드·격자 읽기 뷰 = 접힌 행, rd 는 그대로
        assert await _keep_rows(c, "frz.card_answer_brand") == ref and await _keep_rows(c, "frz.grid_answer_brand") == ref
        assert await c.fetchval("SELECT ment_total FROM frz.card_answer WHERE answer_key = $1", A2) == 4
        assert await c.fetch(f"SELECT {COLS} FROM rd.answer_brand WHERE answer_key = $1 ORDER BY 1, 2", A2) == rd_before
        assert json.loads(await c.fetchval("SELECT row_counts::text FROM frz.generation WHERE gen_key = $1", g))["kept_fold"] == 1
        # 다시 불러도 할 일 없음(이미 fold 보관 = 후보 아님), 관문 다시 쓰기는 fold 보관을 덮지 않는다
        assert await _as_loader(c, lambda: FD.keep_generation(c, g)) == {"candidates": 0, "kept": 0}
        assert await _as_loader(c, lambda: c.fetchval("SELECT frz.keep_rewrite($1::int4[], 'apply')", [A2])) == 0
        assert await _keep_rows(c) == ref
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.legacy_profile(ON)
async def test_fold_without_flip_merges_rows_keeps_rank():
    """켬 + 픽스처 그대로(비경쟁 3.0 이 경쟁 2.0 뒤): 행은 접히지만(언급 2·롤업 1) 순위는 그대로(Smart 2), 분모 4."""
    c, tr = await _conn()
    try:
        await _setup(c, flip=False)
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        assert (await _as_loader(c, lambda: FD.keep_generation(c, g)))["kept"] == 1
        got, ref = await _keep_rows(c), await _ref(c)
        assert got == ref and sorted(v["rk"] for v in got.values()) == [1, 2]
        assert {v["mention_count"] for v in got.values()} == {2} and len(got) == 2
        assert await c.fetchval("SELECT own_rk_k FROM frz.keep_answer WHERE answer_key = $1", A2) == 1
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.legacy_profile(BASE)
async def test_switch_off_keeps_nothing():
    """끔: 같은 시나리오에서 보관 0, 카드 뷰 = rd 행(Smart 2행, 분모 3) = 지금 동작."""
    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        assert await FD.keep_generation(c, g) == {"candidates": 0, "kept": 0}
        assert await kept(c) == {}
        rd = await c.fetch(f"SELECT {COLS} FROM rd.answer_brand WHERE answer_key = $1 ORDER BY 1, 2", A2)
        assert await c.fetch(f"SELECT {COLS} FROM frz.card_answer_brand WHERE answer_key = $1 ORDER BY 1, 2", A2) == rd and len(rd) == 3
        assert await c.fetchval("SELECT ment_total FROM frz.card_answer WHERE answer_key = $1", A2) == 3
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.legacy_profile(ON)
async def test_publish_and_regenerate_paths_fold():
    """S2 발행(freeze_published)·재생성(regenerate) 경로가 접기를 부른다(loader 롤)."""
    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        cid = await c.fetchval("SELECT cycle_id FROM ing.cycle WHERE cyc_key = $1", GLOBAL_CYC)
        if not await c.fetchval("SELECT EXISTS (SELECT 1 FROM rd.job j JOIN ing.cycle_run cr ON cr.run_id = (SELECT run_id FROM ing.answer "
                                "WHERE job_id = j.job_id) WHERE j.answer_key = $1 AND cr.cycle_id = $2)", A2, cid):
            pytest.skip("픽스처 답변 2 가 회차 11 run 이 아니다")
        out = await _as_loader(c, lambda: F.freeze_published(c, [cid]))
        assert not out["failed"], out
        fr = out["frozen"][0]
        if await c.fetchval("SELECT count(*) FROM frz.cell WHERE gen_key = $1 AND answer_key = $2", fr["gen_key"], A2) == 0:
            pytest.skip("발행 생성기 셀에 답변 2 가 없다")
        assert fr["fold"] == {"candidates": 1, "kept": 1} and await kept(c) == {A2: "fold"}
        ref = await _ref(c)
        assert await _keep_rows(c) == ref
        r = await _as_loader(c, lambda: F.regenerate(c, cid, "시험: 접기 재생성"))
        assert r["status"] == "frozen" and r["fold"]["kept"] == 1 and await _keep_rows(c) == ref
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.legacy_profile(ON)
async def test_drift_and_bad_rows_are_refused():
    """rd 가 지금 규칙과 갈리면(재투영 전 언급 변경) 접지 않는다(FoldDrift). 보관 함수는 합이 rd 와 다른 행·셀 밖 답변을 거부한다."""
    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        await c.execute("UPDATE ing.mention SET mention_count = mention_count + 1 WHERE job_id = $1 AND brand_rollup_entity_id = $2", J2, SMART_ROLLUP)
        with pytest.raises(FD.FoldDrift):
            await FD.keep_generation(c, g)
        await c.execute("UPDATE ing.mention SET mention_count = mention_count - 1 WHERE job_id = $1 AND brand_rollup_entity_id = $2", J2, SMART_ROLLUP)
        rows = await FD.compute(c, [A2])
        assert rows and {r["answer_key"] for r in rows} == {A2}
        bad = [dict(r, mention_count=r["mention_count"] + 1) if i == 0 else r for i, r in enumerate(rows)]
        if TEST_NAME_KEY:
            await c.execute("SET ROLE loader")                  # 보관 함수 실행 권한(loader)도 함께 본다. 저장점 밖에서 걸어 되돌림에 안 풀린다
        try:
            for payload, msg in ((bad, "합이 지금 rd"), ([dict(rows[0], answer_key=999999)], "셀이 아니")):
                with pytest.raises(asyncpg.RaiseError, match=msg):
                    async with c.transaction():                 # 저장점: 예외로 되돌린다
                        await c.fetchval(FD.KEEP, g, json.dumps(payload))
        finally:
            if TEST_NAME_KEY:
                await c.execute("RESET ROLE")
        assert await kept(c) == {}
    finally:
        await tr.rollback()
        await c.close()


@pytest.mark.legacy_profile(ON)
async def test_ops_import_folds_and_checks_comp_mentions():
    """S1 이관: 공존 답변을 접어 보관(src fold), all_mentions 단언은 접기 전 값(Σ ment_total − 접기 차)으로, 선택 입력 comp_mentions(운영 카드 분모)는
    Σ ment_total 그대로 대조한다. 운영 comp 값을 1 틀리게 하면 그 회차는 실패한다."""
    from ingest.frz.ops_import import run
    from ingest.frz.tests.ops_synth import make_ops

    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        assert await c.fetchval("SELECT comp_mentions - (SELECT all_mentions FROM mig_src.frz_ops_sum_cycle WHERE generation_id = $1) "
                                "FROM mig_src.frz_ops_sum_comp WHERE generation_id = $1", gen) == 1      # 합성 운영: 접기가 분모를 1 늘린다(3 → 4)

        async def _imp(**kw):
            await _drop_session_rules(c)
            return (await _as_role(c, "migrator", lambda: run(c, **kw))).cycles[0]

        r = await _imp(commit=False)
        assert r["status"] == "dry_run_ok" and r["fails"] == [], (r["fails"], r.get("fold"))
        assert r["fold"] == {"candidates": 1, "kept": 1, "ops_delta": 0, "ment_delta": 1, "comp": "checked"} and r["counts"]["kept_fold"] == 1
        await c.execute("UPDATE mig_src.frz_ops_sum_comp SET comp_mentions = comp_mentions - 1 WHERE generation_id = $1", gen)
        r = await _imp(commit=False)
        assert r["status"] == "assert_failed" and any(f.startswith("answers.comp_mentions hub=") for f in r["fails"]), r["fails"]
        await c.execute("UPDATE mig_src.frz_ops_sum_comp SET comp_mentions = comp_mentions + 1 WHERE generation_id = $1", gen)
        r = await _imp(commit=True)
        assert r["status"] == "committed", r["fails"]
        assert (await kept(c)).get(A2) == "fold" and await _keep_rows(c) == await _ref(c)
        assert cyc is not None
    finally:
        await tr.rollback()
        await c.close()


async def _as_role(c: asyncpg.Connection, role: str, fn):
    """이관기 롤(migrator). 끔 투영 세션이면 _setup 의 bulk 시드(소유자) 임시 표 때문에 소유자로 돈다(_as_loader 와 같은 이유)."""
    if not TEST_NAME_KEY:
        return await fn()
    await c.execute(f"SET ROLE {role}")
    try:
        return await fn()
    finally:
        await c.execute("RESET ROLE")


async def _drop_session_rules(c: asyncpg.Connection) -> None:
    """한 연결에서 롤을 바꿔 가며(적재 loader → 합성 소유자 → 이관 migrator) 규칙 세션 임시 객체를 만들면 다음 롤이 다시 만들 수 없다(소유자 다름).
    운영은 롤마다 연결이 따로라 생기지 않는 시험 전용 정리: 기대 상태 표(_exp_*) 밖 임시 표·뷰·함수를 소유자(슈퍼유저)로 지운다."""
    for r in await c.fetch("SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace = pg_my_temp_schema() AND c.relkind IN ('r', 'v') "
                           "AND left(c.relname, 5) <> '_exp_'"):
        await c.execute(f"DROP {'VIEW' if r['relkind'] == 'v' else 'TABLE'} IF EXISTS pg_temp.{r['relname']} CASCADE")
    for r in await c.fetch("SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = pg_my_temp_schema()"):
        await c.execute(f"DROP FUNCTION IF EXISTS {r['f']} CASCADE")



# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 D3: 독립 오라클(fold_oracle, 검증자 oracle_probe.py 규칙)과 11 시나리오. 카드 뷰 = 오라클, 답변 열 = 오라클, rd 불변, 보관 규칙
# ════════════════════════════════════════════════════════════════════════════
_X = "71000000-0000-4000-8000-0000000000aa"
_INS = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, "
        "type_mention) VALUES ('2026-09-01', $J, 4, '{e}', '{d}', 'Brand', 1, {p}, '{e}', 1)")
SCN = {
    "S0_base": [],
    "S1_flip": ["UPDATE ing.mention SET avg_position = 0.5 WHERE job_id = $J AND ord = 3"],
    "S2_tie": ["UPDATE ing.mention SET avg_position = 1.0 WHERE job_id = $J AND ord = 3"],
    "S3_null_nc": ["UPDATE ing.mention SET avg_position = NULL WHERE job_id = $J AND ord = 3"],
    "S4_null_all": ["UPDATE ing.mention SET avg_position = NULL WHERE job_id = $J AND ord IN (2, 3)"],
    "S5_two_rollups": ["INSERT INTO app.brand_display_alias (alias, canonical_name) VALUES ('Smart Automobile', 'smart')",
                       _INS.format(e=_X, d="Smart Automobile", p="0.7")],
    "S6_noncomp_only": ["DELETE FROM ing.mention WHERE job_id = $J AND ord = 2"],
    "S7_comp_only": ["UPDATE ing.mention SET display_name = 'Smart EQ' WHERE job_id = $J AND ord = 3"],
    "S8_multi_brand": ["UPDATE ing.mention SET avg_position = 0.5 WHERE job_id = $J AND ord = 3",
                       _INS.format(e="71000000-0000-4000-8000-000000000001", d="Toyota", p="0.8")],
    "S9_split_group": [_INS.format(e=_X, d="smart", p="0.3")],
    "S10_flip_sent": ["UPDATE ing.mention SET avg_position = 0.5, sentiment_negative = 2, type_recommendation = 3, mention_count = 4 "
                      "WHERE job_id = $J AND ord = 3"],
}


async def _scenario(c: asyncpg.Connection, stmts: list[str]) -> None:
    if not TEST_NAME_KEY:
        await bulk_seed(c)
    for s in stmts:
        await c.execute(s.replace("$J", f"'{J2}'"))
    ctx = await _ctx(c)
    await _as_loader(c, lambda: reproject(c, ctx, [A2]))


@pytest.mark.legacy_profile(ON)
@pytest.mark.parametrize("name", list(SCN))
async def test_oracle_scenarios(name):
    """시나리오마다: 카드 뷰 answer_brand = 오라클, 카드 답변 분모·당사 열 = 오라클, rd 행 전체 불변, 보관 = (공존 ∧ 오라클 ≠ rd) 일 때만 답변 2."""
    c, tr = await _conn()
    try:
        await _scenario(c, SCN[name])
        exp = await oracle(c, J2)
        rd0 = await rows_of(c, "rd", A2)
        all0 = [r[0] for r in await c.fetch("SELECT (to_jsonb(b) - 'load_id')::text FROM rd.answer_brand b ORDER BY 1")]
        coex = any((bk, True) in rd0 and (bk, False) in rd0 for (bk, _) in rd0 if bk != 0)
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        await _as_loader(c, lambda: FD.keep_generation(c, g))
        kp = await kept(c)
        assert await rows_of(c, "card", A2) == exp, name
        a = dict(await c.fetchrow("SELECT * FROM frz.card_answer WHERE answer_key = $1", A2))
        assert {k: a[k] for k in answer_cols(exp)} == answer_cols(exp), name
        assert await rows_of(c, "rd", A2) == rd0 and [r[0] for r in await c.fetch(
            "SELECT (to_jsonb(b) - 'load_id')::text FROM rd.answer_brand b ORDER BY 1")] == all0, "rd 는 그대로"
        assert set(kp) <= {A2} and (A2 in kp) == (coex and exp != rd0), (name, kp, coex)
    finally:
        await tr.rollback()
        await c.close()


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 D1: frz.keep_fold 가 rd 와 모순되는 행을 받지 않는다(DB-v2.28 P144 I1~I7). 검증자 abuse 4종 + 순서·방향 위반
# ════════════════════════════════════════════════════════════════════════════
async def _rd_rows(c: asyncpg.Connection, k: int) -> list[dict]:
    return [dict(r) for r in await c.fetch(
        f"SELECT j.answer_key, {HCOLS} FROM rd.job j JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date "
        "AND b.answer_key = j.answer_key WHERE j.answer_key = $1 ORDER BY brand_key, competitive", k)]


def _abuse(name: str, base: dict[int, list[dict]], folded: list[dict]) -> tuple[int, list[dict]]:
    """검증자 oracle_probe.abuse_probe 의 변조 4종(P1~P4) + 방향·순서 변조(P5·P6). 반환 = (답변, 넘길 행)."""
    if name == "P1_noncoexist_flip_competitive":           # 공존 아닌 답변: 경쟁 행 하나를 비경쟁으로(합은 그대로)
        k = next(k for k, rows in base.items() if k != A2 and any(r["competitive"] and r["brand_key"] != 0 for r in rows))
        mod = [dict(r) for r in base[k]]
        v = next(r for r in mod if r["competitive"] and r["brand_key"] != 0)
        v["competitive"], v["rk"] = False, 0
        ranked = sorted([r for r in mod if r["competitive"] and r["rk"] > 0], key=lambda r: r["rk"])
        for i, r in enumerate(ranked):
            r["rk"] = i + 1
        return k, mod
    mod = [dict(r) for r in folded]
    if name == "P2_own_bit_forged":                         # 경쟁사 행에 당사 비트
        next(r for r in mod if r["own_bit"] == 0)["own_bit"] = 2
    elif name == "P3_rank_forged":                          # 경쟁 순위 전부 7
        for r in mod:
            if r["competitive"] and r["rk"] > 0:
                r["rk"] = 7
    elif name == "P4_rid_n_gt_entity_rows":
        mod[0]["rid_n"] = mod[0]["entity_rows"] + 5
    elif name == "P5_comp_to_noncomp_direction":            # 공존 키의 경쟁 언급을 비경쟁으로 옮긴다(접기 반대 방향, 합 그대로)
        bk = next(r["brand_key"] for r in base[A2] if not r["competitive"] and r["brand_key"] != 0)
        mod = [dict(r) for r in base[A2]]
        c_ = next(r for r in mod if r["brand_key"] == bk and r["competitive"])
        n_ = next(r for r in mod if r["brand_key"] == bk and not r["competitive"])
        for f in ("mention_count", "entity_rows", "t_mention"):
            n_[f] += c_[f]
        c_.update(mention_count=0, t_mention=0)
        n_["entity_rows"] -= 1
        c_["entity_rows"] = 1
    elif name == "P6_order_swapped":                        # 공존 아닌 두 키(Toyota 0.8·Kia 1.0)의 순서를 뒤집는다(위치 불변이라 rd 순서와 모순)
        nc = {r["brand_key"] for r in base[A2] if r["brand_key"] != 0} - {r["brand_key"] for r in base[A2] if not r["competitive"]}
        pair = sorted([r for r in mod if r["competitive"] and r["rk"] > 0 and r["brand_key"] in nc], key=lambda r: r["rk"])[:2]
        assert len(pair) == 2, mod
        pair[0]["rk"], pair[1]["rk"] = pair[1]["rk"], pair[0]["rk"]
    return A2, mod


@pytest.mark.legacy_profile(ON)
@pytest.mark.parametrize("name", ["P1_noncoexist_flip_competitive", "P2_own_bit_forged", "P3_rank_forged", "P4_rid_n_gt_entity_rows",
                                  "P5_comp_to_noncomp_direction", "P6_order_swapped"])
async def test_keep_fold_rejects_abuse(name):
    """loader 롤로 rd 와 모순되는 행을 넘기면 예외(부분 쓰기 없음: 보관 표시·보관 행 0). 같은 답변의 정상 접기 행은 받는다.
    시나리오 = S8(뒤집힘 + 공존 아닌 경쟁 키 둘: Toyota 0.8·Kia 1.0). 공존 키의 순위 값 자체는 rd 에서 정할 수 없다(접힌 위치 tp 가 rd 에 없다):
    I7 은 rd 에서 파생 가능한 순서(공존 아닌 키끼리, 공존 키가 뒤로 가지 않음)만 강제한다."""
    c, tr = await _conn()
    try:
        await _scenario(c, SCN["S8_multi_brand"])
        g = (await freeze(c, [GLOBAL_CYC]))[GLOBAL_CYC]
        base = {int(k): await _rd_rows(c, int(k)) for (k,) in await c.fetch("SELECT answer_key FROM frz.cell WHERE gen_key = $1", g)}
        folded = [{"answer_key": A2, "brand_key": bk, "competitive": comp, **v} for (bk, comp), v in (await oracle(c, J2)).items()]
        k, mod = _abuse(name, base, folded)
        if TEST_NAME_KEY:
            await c.execute("SET ROLE loader")
        try:
            with pytest.raises(asyncpg.RaiseError, match="frz.keep_fold"):
                async with c.transaction():
                    await c.fetchval(FD.KEEP, g, json.dumps(mod))
            assert await c.fetchval("SELECT count(*) FROM frz.kept WHERE gen_key = $1", g) == 0
            assert await c.fetchval("SELECT count(*) FROM frz.keep_answer_brand WHERE gen_key = $1", g) == 0
            assert await c.fetchval(FD.KEEP, g, json.dumps(folded)) == 1          # 정상 접기 행(오라클)은 받는다
        finally:
            if TEST_NAME_KEY:
                await c.execute("RESET ROLE")
        assert await rows_of(c, "keep", A2) == await oracle(c, J2)
    finally:
        await tr.rollback()
        await c.close()


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 D2: S1 이관에서 바뀐 답변(ops 보관)이 공존 답변이면 운영 행은 이미 접힌 값이라 all_mentions 보정에 넣는다(ops_delta).
# 공존 아닌 ops 보관 답변의 차이는 보정하지 않는다(실제 운영 변경을 가리지 않는다)
# ════════════════════════════════════════════════════════════════════════════
@pytest.mark.legacy_profile(ON)
async def test_ops_import_changed_coexist_answer_all_mentions():
    from ingest.frz.ops_import import run
    from ingest.frz.tests.ops_synth import make_ops, write_sums

    c, tr = await _conn()
    try:
        await _setup(c, flip=True)
        cyc, gen = await make_ops(c, GLOBAL_CYC)                       # 기대 상태 = 오라클 접힘(답변 2: 분모 4, 운영 all_mentions 3)
        ex = await oracle(c, J2)
        rd_ment = int(await c.fetchval("SELECT ment_total FROM rd.answer WHERE answer_key = $1", A2))
        assert answer_cols(ex)["ment_total"] == rd_ment + 1
        # 답변 2 가 생성 뒤 바뀐 답변(ops 보관): 운영 세부층 행 = 접힌 행(순위는 서수로 재현), 운영 all_mentions = 언급 행 단위(= rd 값)
        await c.execute("INSERT INTO mig_src.frz_ops_changed SELECT cycle_id, generation_id, job_id, run_id, now(), now(), true, false "
                        "FROM mig_src.frz_ops_cell WHERE generation_id = $1 AND job_id = $2", gen, J2)
        await c.execute("""INSERT INTO mig_src.frz_ops_answer SELECT o.cycle_id, o.generation_id, o.job_id, o.prompt_id, o.engine, o.country,
                           'completed', 1, 1, 1, 1, $3, coalesce(a.cit_n_all, 0), 1, NULL, NULL, NULL
                           FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id JOIN rd.answer a ON a.answer_key = j.answer_key
                           WHERE o.generation_id = $1 AND o.job_id = $2""", gen, J2, rd_ment)
        for (bk, comp), v in ex.items():
            name = await c.fetchval("SELECT name FROM rd.dim_brand_name WHERE brand_key = $1", bk)
            await c.execute("INSERT INTO mig_src.frz_ops_brand VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, "
                            "$15, $16)", cyc, gen, J2, name, int(comp), v["mention_count"], float(v["rk"]) if comp and v["rk"] > 0 else None,
                            v["s_pos"], v["s_neu"], v["s_neg"], v["s_mix"], v["t_mention"], v["t_recommendation"], v["t_comparison"],
                            v["t_definition"], v["t_final_choice"])
        await write_sums(c, cyc, gen)

        async def _imp():
            await _drop_session_rules(c)
            return (await _as_role(c, "migrator", lambda: run(c, commit=False))).cycles[0]

        r = await _imp()
        assert r["status"] == "dry_run_ok" and r["fails"] == [], (r["fails"], r.get("fold"))
        assert r["counts"]["kept_ops"] == 1 and r["counts"]["kept_fold"] == 0 and r["fold"]["ops_delta"] == 1
        # 실제 운영 변경은 가리지 않는다: 같은 답변의 운영 all_mentions 를 1 틀리게(운영 합은 그대로) 하면 실패로 드러난다
        await c.execute("UPDATE mig_src.frz_ops_answer SET all_mentions = all_mentions - 1 WHERE generation_id = $1 AND job_id = $2", gen, J2)
        r = await _imp()
        assert r["status"] == "assert_failed" and any(f.startswith("answers.all_mentions") for f in r["fails"]), r["fails"]
    finally:
        await tr.rollback()
        await c.close()
