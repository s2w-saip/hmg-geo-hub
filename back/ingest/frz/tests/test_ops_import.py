"""운영 세대 이관 적재기(ingest.frz.ops_import) 시험: 드라이런 무쓰기, 회차 원자 교체·멱등·재생성, 축 합 단언 변이(틀린 기준값을 잡는다),
바뀐 답변 변환(운영 세부층 → 허브 행, 순위·당사 열 재계산을 손 계산과 대조), 좌석 이동 보관, 변환 실패 목록.
합성 운영 입력 = ops_synth(허브 픽스처 회차를 운영 세대처럼). 전부 롤백 트랜잭션(복제본 불변). 적재기는 migrator 롤(SET ROLE)로 돈다.
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest

from ingest.frz.ops_import import _axis_failures, _load_failures, run
from ingest.frz.tests.ops_synth import make_ops, write_sums
from ingest.frz.tests.support import frz_counts, kept, view_rows
from tests.support import DB_URL, needs_db

GLOBAL_CYC, WEB_CYC = 11, 21


async def _conn() -> tuple[asyncpg.Connection, asyncpg.transaction.Transaction]:
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    return c, tr


async def _run(c: asyncpg.Connection, **kw):
    await c.execute("SET ROLE migrator")
    try:
        return await run(c, **kw)
    finally:
        await c.execute("RESET ROLE")


def _one(rep) -> dict:
    assert len(rep.cycles) == 1, rep.cycles
    return rep.cycles[0]


# ── 순수 함수 ────────────────────────────────────────────────────────────────
def test_axis_failures_pure():
    ans = {"cells": 5, "cells_ifc": 5, "all_mentions": 10, "all_citations": 7, "has_any_brand": 3, "domain_citations": 7, "cit_n_all_null": 0}
    ops = dict(ans)
    brands = {"ops_only": 0, "hub_only": 0, "mentions_diff": 0, "answers_diff": 0, "comp_rank_sum_diff": 0, "comp_ranked_diff": 0, "rid_n_null": 0}
    own = [{"own_variant": "ALL", "bits": 3, **{f"{p}_{k}": 1 for p in ("o", "h") for k in ("tracked", "mentions", "positive", "negative",
                                                                                         "signals")}}]
    assert _axis_failures(ans, ops, brands, own) == []
    assert _axis_failures(ans, {**ops, "all_mentions": 11}, brands, own) == ["answers.all_mentions hub=10 ops=11"]
    assert _axis_failures(ans, None, brands, own) == ["ops_sum_missing"]
    assert _axis_failures({**ans, "cit_n_all_null": 2}, ops, brands, own) == ["answers.cit_n_all_null 2"]
    assert _axis_failures(ans, ops, {**brands, "mentions_diff": 1}, own) == ["brands.mentions_diff 1"]
    assert _axis_failures(ans, ops, brands, [{**own[0], "h_signals": 2}]) == ["own.ALL.signals hub=2 ops=1"]
    assert _axis_failures(ans, ops, brands, [{**own[0], "bits": None}]) == ["own.ALL variant_unmapped"]
    cf = {"job_unmapped": 0, "answer_missing": 1, "surface_mismatch": 0, "dup_answers": 0}
    assert _load_failures(cf, {"prompt_unmapped_with_cells": 0}, {"citations_differ": 2, "brand_unmapped": 0}) == \
        ["cells.answer_missing 1", "ops.citations_differ 2"]


# ── DB ──────────────────────────────────────────────────────────────────────
@needs_db
async def test_dry_run_commit_idempotent_and_regenerate():
    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        r = _one(await _run(c, commit=False))
        assert r["status"] == "dry_run_ok" and r["fails"] == [], r
        assert (await frz_counts(c))["gens"] == 0, "드라이런은 쓰지 않는다"
        n_cells = await c.fetchval("SELECT count(*) FROM mig_src.frz_ops_cell WHERE generation_id = $1", gen)
        assert r["counts"]["cells"] == n_cells and r["counts"]["prompts"] >= 1

        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed", r
        g1 = r["gen_key"]
        st = await c.fetchrow("SELECT state, source, ops_generation_id, judgment, verify FROM frz.generation WHERE gen_key = $1", g1)
        assert (st["state"], st["source"], st["ops_generation_id"]) == ("active", "ops", gen)
        assert json.loads(st["judgment"])["roster_md5"] and json.loads(st["verify"])["fails"] == []
        assert await c.fetchval("SELECT roster_snapshot IS NOT NULL FROM frz.ops_judgment WHERE gen_key = $1", g1)
        v1 = await view_rows(c)
        assert len(v1["answer"]) == n_cells

        r = _one(await _run(c, commit=True))
        assert r["status"] == "already_current" and r["gen_key"] == g1, "같은 운영 세대 재실행 = 할 일 없음(멱등)"
        r = _one(await _run(c, commit=True, force=True))
        assert r["status"] == "committed" and r["gen_key"] != g1 and r["released"]["gen_key"] == g1
        assert await c.fetchval("SELECT state FROM frz.generation WHERE gen_key = $1", g1) == "retired"
        assert await view_rows(c) == v1, "같은 입력 재생성 = 같은 동결 값"

        # 운영 재생성(새 세대 id): 옛 활성 세대 해제 → 새 세대
        gen2 = uuid.uuid4()
        for t in ("frz_ops_marker", "frz_ops_cell", "frz_ops_prompt", "frz_ops_sum_cycle", "frz_ops_sum_brand", "frz_ops_sum_own",
                  "frz_ops_sum_brand_x", "frz_ops_sum_own_x", "frz_ops_sum_comp"):
            col = "active_generation_id" if t == "frz_ops_marker" else "generation_id"
            await c.execute(f"UPDATE mig_src.{t} SET {col} = $1 WHERE {col} = $2", gen2, gen)
        await c.execute("UPDATE mig_src.frz_ops_generation SET generation_id = $1 WHERE generation_id = $2", gen2, gen)
        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed" and r["released"] is not None
        assert await c.fetchval("SELECT count(*) FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", GLOBAL_CYC) == 1
        assert await c.fetchval("SELECT ops_generation_id FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", GLOBAL_CYC) == gen2
        assert cyc is not None
    finally:
        await tr.rollback()
        await c.close()


MUTATIONS = [
    ("cells", "UPDATE mig_src.frz_ops_sum_cycle SET cells = cells + 1", "answers.cells"),
    ("all_mentions", "UPDATE mig_src.frz_ops_sum_cycle SET all_mentions = all_mentions + 1", "answers.all_mentions"),
    ("all_citations", "UPDATE mig_src.frz_ops_sum_cycle SET all_citations = all_citations - 1", "answers.all_citations"),
    ("has_any_brand", "UPDATE mig_src.frz_ops_sum_cycle SET has_any_brand = has_any_brand + 1", "answers.has_any_brand"),
    ("domain", "UPDATE mig_src.frz_ops_sum_cycle SET domain_citations = domain_citations + 1", "answers.domain_citations"),
    ("ifc", "UPDATE mig_src.frz_ops_prompt SET in_full_cycle = 0 WHERE prompt_id = (SELECT min(prompt_id::text)::uuid FROM mig_src.frz_ops_prompt)",
     "answers.cells_ifc"),
    ("brand_mentions", "UPDATE mig_src.frz_ops_sum_brand SET mentions = mentions + 1 WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand)",
     "brands.mentions_diff"),
    ("brand_answers", "UPDATE mig_src.frz_ops_sum_brand SET answers = answers + 1 WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand)",
     "brands.answers_diff"),
    ("brand_rank", "UPDATE mig_src.frz_ops_sum_brand SET comp_rank_sum = comp_rank_sum + 1 "
     "WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand WHERE comp_ranked_answers > 0)", "brands.comp_rank_sum_diff"),
    ("brand_ops_only", "INSERT INTO mig_src.frz_ops_sum_brand SELECT cycle_id, generation_id, 'zz-only-in-ops', 1, 1, 0, 0 "
     "FROM mig_src.frz_ops_sum_cycle", "brands.ops_only"),
    ("own_mentions", "UPDATE mig_src.frz_ops_sum_own SET own_mentions = own_mentions + 1 WHERE own_variant = 'ALL'", "own.ALL.mentions"),
    ("own_tracked", "UPDATE mig_src.frz_ops_sum_own SET tracked_answers = tracked_answers + 1 WHERE own_variant <> 'ALL'", ".tracked"),
    ("own_variant", "INSERT INTO mig_src.frz_ops_sum_own SELECT cycle_id, generation_id, 'ZZ-unknown', 0, 0, 0, 0, 0 FROM mig_src.frz_ops_sum_cycle",
     "own.ZZ-unknown variant_unmapped"),
    # S4b 보강 단언(선택 입력 frz_ops_sum_brand_x·own_x)
    ("brand_neutral", "UPDATE mig_src.frz_ops_sum_brand_x SET neutral = neutral + 1 WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand_x)",
     "brands_x.neutral_diff"),
    ("brand_mixed", "UPDATE mig_src.frz_ops_sum_brand_x SET mixed = mixed + 1 WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand_x)",
     "brands_x.mixed_diff"),
    ("brand_types", "UPDATE mig_src.frz_ops_sum_brand_x SET type_comparison = type_comparison + 1 "
     "WHERE brand_name = (SELECT min(brand_name) FROM mig_src.frz_ops_sum_brand_x)", "brands_x.types_diff"),
    ("own_rank", "UPDATE mig_src.frz_ops_sum_own_x SET rank_sum = rank_sum + 1 WHERE own_variant = 'ALL'", "own_x.ALL rank_multi_differ"),
    ("own_multi", "UPDATE mig_src.frz_ops_sum_own_x SET multi_answers = multi_answers + 1 WHERE own_variant = 'ALL'", "own_x.ALL rank_multi_differ"),
    ("cell_missing", "UPDATE mig_src.frz_ops_cell SET job_id = '00000000-0000-4000-8000-0000000000ff' "
     "WHERE job_id = (SELECT min(job_id::text)::uuid FROM mig_src.frz_ops_cell)", "cells.job_unmapped"),
]


@needs_db
@pytest.mark.parametrize("name,sql,expect", MUTATIONS, ids=[m[0] for m in MUTATIONS])
async def test_mutated_reference_is_caught_and_rolled_back(name, sql, expect):
    """기준값(운영 축 합)·입력을 하나씩 틀리게 하면 그 회차는 assert_failed, frz 는 아무것도 안 남는다(원자)."""
    c, tr = await _conn()
    try:
        await make_ops(c, GLOBAL_CYC)
        assert _one(await _run(c, commit=False))["status"] == "dry_run_ok"
        await c.execute(sql)
        r = _one(await _run(c, commit=True))
        assert r["status"] == "assert_failed" and any(expect in f for f in r["fails"]), (name, r.get("fails"))
        assert await frz_counts(c) == {"gens": 0, "active": 0, "cells": 0, "prompts": 0, "kept": 0, "keep_answer": 0, "keep_brand": 0,
                                       "keep_citation": 0}
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_extra_assertions_are_optional():
    """S4b 보강 단언 입력(frz_ops_sum_brand_x·own_x)이 없으면 건너뛰고(결과 extra_verify = skipped) 있으면 대조한다(checked)."""
    c, tr = await _conn()
    try:
        await make_ops(c, GLOBAL_CYC)
        r = _one(await _run(c, commit=False))
        assert r["status"] == "dry_run_ok" and r["extra_verify"] == "checked", r
        await c.execute("DROP TABLE mig_src.frz_ops_sum_brand_x, mig_src.frz_ops_sum_own_x")
        r = _one(await _run(c, commit=False))
        assert r["status"] == "dry_run_ok" and r["extra_verify"] == "skipped", r
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_failed_cycle_keeps_previous_generation():
    """재생성 실패(단언 실패)면 옛 활성 세대·보관이 그대로다(해제·새 세대가 한 트랜잭션)."""
    c, tr = await _conn()
    try:
        await make_ops(c, GLOBAL_CYC)
        g1 = _one(await _run(c, commit=True))["gen_key"]
        v1 = await view_rows(c)
        await c.execute("UPDATE mig_src.frz_ops_sum_cycle SET cells = cells + 1")
        r = _one(await _run(c, commit=True, force=True))
        assert r["status"] == "assert_failed"
        assert await c.fetchval("SELECT state FROM frz.generation WHERE gen_key = $1", g1) == "active"
        assert await view_rows(c) == v1
    finally:
        await tr.rollback()
        await c.close()


def _expected_brand_rows(ops: list[dict], hub0: list[dict]) -> list[dict]:
    """손 계산(이관기와 독립): 운영 행 → (브랜드 키, competitive) 그룹, 답변 안 경쟁 순위 = 최소 서수의 rank()(동률 같은 순위·건너뜀)."""
    g: dict[tuple, dict] = {}
    for o in ops:
        k = (o["brand_key"], o["is_competitor"] == 1)
        d = g.setdefault(k, {"brand_key": k[0], "competitive": k[1], "own_bit": o["own_bit"], "mention_count": 0, "tp": None, "ids": set(),
                             "n": 0})
        d["mention_count"] += o["mentions"]
        d["n"] += 1
        d["ids"].add(o["brand_id"])
        if o["first_rank"] is not None:
            d["tp"] = o["first_rank"] if d["tp"] is None else min(d["tp"], o["first_rank"])
    rows = list(g.values())
    ranked = sorted([r for r in rows if r["competitive"] and r["brand_key"] != 0 and r["tp"] is not None], key=lambda r: r["tp"])
    for r in rows:
        r["rk"] = 0
    for r in ranked:
        r["rk"] = 1 + sum(1 for x in ranked if x["tp"] < r["tp"])
    return [{"brand_key": r["brand_key"], "competitive": r["competitive"], "own_bit": r["own_bit"], "mention_count": r["mention_count"],
             "rk": r["rk"], "entity_rows": r["n"], "rid_n": len(r["ids"])} for r in rows] + hub0


@needs_db
async def test_changed_answer_converted_from_ops_rows():
    """바뀐 답변: 운영 세부층 행(생성 시점 값)이 지금 rd 와 다르면 그 값으로 보관한다. 브랜드 행 그룹·순위(동률)·당사 열을 손 계산과 대조,
    축 합은 손 계산 기대 상태에서 센 값이고 단언을 통과한다(운영 행 = 지금 값이면 보관 없음은 아래 시험)."""
    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        cells = [dict(r) for r in await c.fetch(
            "SELECT o.job_id, j.answer_key FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id WHERE o.generation_id = $1 "
            "ORDER BY j.answer_key", gen)]
        x = cells[0]
        names = [dict(r) for r in await c.fetch("SELECT brand_key, name, own_bit FROM rd.dim_brand_name WHERE brand_key <> 0 ORDER BY brand_key")]
        own = [n for n in names if n["own_bit"]][0]
        comp = [n for n in names if not n["own_bit"]][:3]
        assert len(comp) == 3, names
        bid = [uuid.uuid4() for _ in range(6)]
        # 운영 행(생성 시점): 당사 1.0 · 경쟁 A 1.0(동률) · 경쟁 B 3.0 · 경쟁 C 순위 없음 · 경쟁 A 의 두 번째 롤업 id(같은 이름) · 비경쟁 표시 B 0.5
        ops = [
            {"brand_id": bid[0], **own, "is_competitor": 1, "mentions": 4, "first_rank": 1.0},
            {"brand_id": bid[1], **comp[0], "is_competitor": 1, "mentions": 2, "first_rank": 1.0},
            {"brand_id": bid[2], **comp[1], "is_competitor": 1, "mentions": 1, "first_rank": 3.0},
            {"brand_id": bid[3], **comp[2], "is_competitor": 1, "mentions": 5, "first_rank": None},
            {"brand_id": bid[4], **comp[0], "is_competitor": 1, "mentions": 1, "first_rank": 2.0},
            {"brand_id": bid[5], **comp[1], "is_competitor": 0, "mentions": 7, "first_rank": 0.5},
        ]
        hub_cit = await c.fetchval("SELECT cit_n_all FROM rd.answer WHERE answer_key = $1", x["answer_key"])
        for job in (x["job_id"],):
            await c.execute("INSERT INTO mig_src.frz_ops_changed SELECT cycle_id, generation_id, job_id, run_id, now(), now(), true, false "
                            "FROM mig_src.frz_ops_cell WHERE generation_id = $1 AND job_id = $2", gen, job)
            await c.execute("""INSERT INTO mig_src.frz_ops_answer SELECT o.cycle_id, o.generation_id, o.job_id, o.prompt_id, o.engine, o.country,
                               'completed', 1, 1, 1, 1, 0, coalesce(a.cit_n_all, 0), 1, NULL, NULL, NULL
                               FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id JOIN rd.answer a ON a.answer_key = j.answer_key
                               WHERE o.generation_id = $1 AND o.job_id = $2""", gen, job)
        for o in ops:
            await c.execute("INSERT INTO mig_src.frz_ops_brand VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0, 0, 0, $7, 0, 0, 0, 0)",
                            cyc, gen, x["job_id"], o["brand_id"], o["name"], o["is_competitor"], o["mentions"], o["first_rank"])
        hub0 = [dict(r) | {"rid_n": r["rid_n"]} for r in await c.fetch(
            "SELECT brand_key, competitive, own_bit, mention_count, rk, entity_rows, rid_n FROM rd.answer_brand "
            "WHERE answer_key = $1 AND brand_key = 0", x["answer_key"])]
        exp = _expected_brand_rows(ops, hub0)
        # 감정·유형 합(S4b 보강 단언 대상): 운영 행을 (브랜드 키, 경쟁) 그룹으로 더한 값(위 행 = 긍정 1 · type_mention = 언급 수)
        grp: dict[tuple[int, bool], dict[str, int]] = {}
        for o in ops:
            g = grp.setdefault((int(o["brand_key"]), o["is_competitor"] == 1), {"s_pos": 0, "t_mention": 0})
            g["s_pos"] += 1
            g["t_mention"] += o["mentions"]
        exp_x = [{**e, **grp.get((e["brand_key"], e["competitive"]), {"s_pos": 0, "t_mention": 0})} for e in exp]
        # 기대 상태(손 계산)로 축 합 다시 쓰기: x 의 브랜드 행·당사 열만 바뀐다
        await c.execute("DELETE FROM _exp_ab WHERE answer_key = $1", x["answer_key"])
        await c.execute("""INSERT INTO _exp_ab (round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                                                bgrp, own_bit, entity_rows, mention_count, rk, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation,
                                                t_comparison, t_definition, t_final_choice, competitive, std_in, elig, dflt, rule_ver, is_rep,
                                                std_in_nc, rid_n)
                           SELECT a.round_date, a.answer_key, e.brand_key, a.cyc_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key,
                                  a.lang_key, a.bgrp, e.own_bit, e.entity_rows, e.mention_count, e.rk, e.s_pos, 0, 0, 0, e.t_mention, 0, 0, 0, 0,
                                  e.competitive, a.std_in, a.elig, a.dflt, a.rule_ver, a.is_rep, a.std_in_nc, e.rid_n
                             FROM _exp_a a CROSS JOIN jsonb_to_recordset($2::jsonb) e(brand_key int4, competitive bool, own_bit int2, mention_count int2,
                                                                                      rk int2, entity_rows int2, rid_n int2, s_pos int2, t_mention int2)
                            WHERE a.answer_key = $1""", x["answer_key"], json.dumps(exp_x))
        own_bit = own["own_bit"]
        ment_own = sum(e["mention_count"] for e in exp if e["competitive"] and e["own_bit"] == own_bit)
        ment_total = sum(e["mention_count"] for e in exp if e["competitive"])
        rk_own = min([e["rk"] for e in exp if e["own_bit"] == own_bit and e["rk"] > 0] or [0])
        col = {1: "h", 2: "k", 4: "g"}[own_bit]
        sets = {f"{p}_{b}": "0" for p in ("ment", "own_rk", "sent_pos", "sent_neg", "sent_all") for b in "hkg"}
        sets.update({f"ment_{col}": "$4", f"own_rk_{col}": "$5", f"sent_pos_{col}": "1", f"sent_all_{col}": "1"})
        await c.execute("UPDATE _exp_a SET am = NULL, own_mask = $2, ment_total = $3, " + ", ".join(f"{k} = {v}" for k, v in sets.items())
                        + " WHERE answer_key = $1", x["answer_key"], own_bit, ment_total, ment_own, rk_own)
        await write_sums(c, cyc, gen)
        # 운영 all_mentions(summary_answers, 언급 행 단위) = 이 합성 운영 행의 경쟁 언급 합(합성 행에는 롤업 그룹 안 경쟁·비경쟁 섞임이 없다)
        await c.execute("UPDATE mig_src.frz_ops_answer SET all_mentions = $3 WHERE generation_id = $1 AND job_id = $2", gen, x["job_id"], ment_total)

        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed", r.get("fails")
        k = await kept(c)
        assert k.get(x["answer_key"]) == "ops"
        got = {(int(b["brand_key"]), b["competitive"]): dict(b) for b in await c.fetch(
            "SELECT brand_key, competitive, own_bit, mention_count, rk, entity_rows, rid_n FROM frz.keep_answer_brand WHERE answer_key = $1",
            x["answer_key"])}
        assert got == {(e["brand_key"], e["competitive"]): e for e in exp}
        assert got[(comp[0]["brand_key"], True)]["rk"] == 1 and got[(own["brand_key"], True)]["rk"] == 1      # 동률 1.0 → 둘 다 1
        assert got[(comp[1]["brand_key"], True)]["rk"] == 3 and got[(comp[2]["brand_key"], True)]["rk"] == 0   # 건너뜀·순위 없음
        assert got[(comp[0]["brand_key"], True)]["rid_n"] == 2 and got[(comp[1]["brand_key"], False)]["rk"] == 0
        a = await c.fetchrow(f"SELECT own_mask, ment_total, ment_{col} AS m, own_rk_{col} AS rk, t_own FROM frz.keep_answer WHERE answer_key = $1",
                             x["answer_key"])
        assert (a["own_mask"], a["ment_total"], a["m"], a["rk"]) == (own_bit, ment_total, ment_own, rk_own)
        assert a["t_own"] == await c.fetchval("SELECT rd.t_own_bits($1::int2, 4::int2, 0::int2, 0::int2, 0::int2, 0::int2)", own_bit)
        assert await c.fetchval("SELECT count(*) FROM frz.keep_citation WHERE answer_key = $1", x["answer_key"]) == \
            await c.fetchval("SELECT count(*) FROM rd.citation WHERE answer_key = $1", x["answer_key"])
        assert hub_cit is not None
        fv = await c.fetchval("SELECT ment_total FROM frz.answer WHERE answer_key = $1", x["answer_key"])
        assert fv == ment_total and await c.fetchval("SELECT ment_total FROM rd.answer WHERE answer_key = $1", x["answer_key"]) != ment_total
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_unmapped_brand_and_citation_change_fail_the_cycle():
    """변환 실패: 허브에 없는 브랜드 이름(새 브랜드 키) · 운영 인용 수 ≠ 허브 → 회차 적재 안 함, 이름은 보고에 남긴다."""
    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        job = await c.fetchval("SELECT min(job_id::text)::uuid FROM mig_src.frz_ops_cell WHERE generation_id = $1", gen)
        await c.execute("INSERT INTO mig_src.frz_ops_changed SELECT cycle_id, generation_id, job_id, run_id, now(), now(), true, false "
                        "FROM mig_src.frz_ops_cell WHERE generation_id = $1 AND job_id = $2", gen, job)
        await c.execute("""INSERT INTO mig_src.frz_ops_answer SELECT o.cycle_id, o.generation_id, o.job_id, o.prompt_id, o.engine, o.country,
                           'completed', 1, 1, 1, 1, 0, coalesce(a.cit_n_all, 0) + 1, 1, NULL, NULL, NULL
                           FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id JOIN rd.answer a ON a.answer_key = j.answer_key
                           WHERE o.generation_id = $1 AND o.job_id = $2""", gen, job)
        await c.execute("INSERT INTO mig_src.frz_ops_brand VALUES ($1, $2, $3, gen_random_uuid(), 'Brand-Not-In-Hub', 1, 1, 1.0, 0, 0, 0, 0, 1, 0, 0, 0, 0)",
                        cyc, gen, job)
        r = _one(await _run(c, commit=True))
        assert r["status"] == "assert_failed"
        assert "ops.citations_differ 1" in r["fails"] and "ops.brand_unmapped 1" in r["fails"], r["fails"]
        assert r["brand_unmapped_names"] == ["Brand-Not-In-Hub"]
        assert (await frz_counts(c))["gens"] == 0
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_seat_moved_answer_is_kept_and_served_at_frozen_seat():
    """허브 rd 좌석(회차·round_date)이 운영 회차와 다른 셀 답변: 지금 rd 행을 보관(seat)하고 동결 뷰는 운영 회차 좌석으로 낸다."""
    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        # 다른 회차(10) 대표 답변 하나를 이 운영 회차 셀에 더한다(운영 귀속 ≠ 허브 귀속)
        mv = await c.fetchrow("SELECT a.answer_key, j.job_id FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key "
                              "WHERE a.cyc_key = 10 AND a.is_rep ORDER BY a.answer_key LIMIT 1")
        await c.execute("""INSERT INTO mig_src.frz_ops_cell SELECT $1, $2, '2026-09-14', j.job_id, r.run_id, d.prompt_id, e.code, g.code, now()
                           FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key
                           JOIN rd.dim_engine e ON e.engine_key = j.engine_key JOIN rd.dim_country g ON g.geo_key = j.geo_key WHERE j.job_id = $3""",
                        cyc, gen, mv["job_id"])
        await c.execute("""INSERT INTO mig_src.frz_ops_prompt SELECT $1, $2, d.prompt_id, i.scope_project_id, NULL, '{}', NULL, NULL, NULL, '{}', NULL,
                           NULL, NULL, NULL, NULL, 0, 1, NULL, 0, 1, 1, 1, NULL, NULL, NULL, NULL
                           FROM rd.job j JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key JOIN ing.cycle i ON i.cycle_id = $1
                           WHERE j.job_id = $3 ON CONFLICT DO NOTHING""", cyc, gen, mv["job_id"])
        # 기대 상태: 그 답변 행이 좌석만 바뀌어 더해진다
        seat = await c.fetchrow("SELECT round_date FROM rd.cycle WHERE cyc_key = $1", GLOBAL_CYC)
        for t in ("a", "ab", "c"):
            src = {"a": "rd.answer", "ab": "rd.answer_brand", "c": "rd.citation"}[t]
            await c.execute(f"INSERT INTO _exp_{t} SELECT * FROM {src} WHERE answer_key = $1", mv["answer_key"])
            await c.execute(f"UPDATE _exp_{t} SET cyc_key = $2, round_date = $3 WHERE answer_key = $1", mv["answer_key"], GLOBAL_CYC,
                            seat["round_date"])
        await write_sums(c, cyc, gen)
        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed", r.get("fails")
        assert r["cells"]["seat_moved"] >= 1 and (await kept(c)).get(mv["answer_key"]) == "seat"
        row = await c.fetchrow("SELECT cyc_key, round_date, is_rep FROM frz.answer WHERE answer_key = $1", mv["answer_key"])
        assert (row["cyc_key"], row["round_date"], row["is_rep"]) == (GLOBAL_CYC, seat["round_date"], True)
        assert await c.fetchval("SELECT cyc_key FROM rd.answer WHERE answer_key = $1", mv["answer_key"]) == 10
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_regenerated_during_export_is_skipped_and_inputs_checked():
    c, tr = await _conn()
    try:
        await make_ops(c, GLOBAL_CYC)
        await c.execute("UPDATE mig_src.frz_ops_marker SET active_generation_id = gen_random_uuid() WHERE phase = 'end'")
        r = _one(await _run(c, commit=True))
        assert r["status"] == "regenerated_during_export" and (await frz_counts(c))["gens"] == 0
        await c.execute("DROP TABLE mig_src.frz_ops_sum_own")
        with pytest.raises(RuntimeError, match="frz_ops_sum_own"):
            await _run(c, commit=False)
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_website_cycle_and_cli_entry(monkeypatch):
    """웹사이트 회차도 같은 경로로 통과. CLI 진입점(ingest.cli frz-import-ops)은 워커 설정을 설치하고 드라이런이 기본이다."""
    from ingest import cli

    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, WEB_CYC)
        # S4 택소노미 축 = 운영 원값(frz.prompt.src): 프롬프트 하나에 퍼널·존재·목록·depth 를 준다
        pid = await c.fetchval("SELECT prompt_id FROM mig_src.frz_ops_prompt WHERE generation_id = $1 ORDER BY prompt_id LIMIT 1", gen)
        await c.execute("UPDATE mig_src.frz_ops_prompt SET funnel_catalog = 'F2', presence_set = '{branded,unbranded}', list_type = 'L2', "
                        "depth1 = 'D1', depth2 = 'D2b' WHERE generation_id = $1 AND prompt_id = $2", gen, pid)
        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed", r.get("fails")
        # S4 웹 셀 판정 = 운영 플래그 그대로(허브 판정 아님), 웹 셀 전부
        got = {row["job_id"]: tuple(row)[1:] for row in await c.fetch(
            "SELECT j.job_id, w.report_fs, w.unit_owned, w.unit_target, w.url_registered, w.url_owned_hit, w.url_target_hit "
            "FROM frz.card_web w JOIN rd.job j ON j.answer_key = w.answer_key")}
        want = {row["job_id"]: (row["report_fs"], row["unit_owned"] == 1, row["unit_target"] == 1, row["url_registered"], row["url_owned_hit"],
                                row["url_target_hit"]) for row in await c.fetch("SELECT * FROM mig_src.frz_ops_web WHERE generation_id = $1", gen)}
        assert got == want and len(got) == await c.fetchval("SELECT count(*) FROM frz.cell c JOIN frz.generation g USING (gen_key) "
                                                             "WHERE g.state = 'active' AND g.surface = 2")
        ax = await c.fetchrow("""SELECT f.code AS funnel, ARRAY(SELECT t.code FROM rd.dim_taxon t WHERE t.taxon_key = ANY(x.presence_keys) ORDER BY 1) AS pres,
                                        l.code AS list_type, d1.code AS d1, d2.code AS d2
                                   FROM frz.card_axis x JOIN rd.dim_prompt p ON p.prompt_key = x.prompt_key
                                   LEFT JOIN rd.dim_taxon f ON f.taxon_key = x.funnel_key LEFT JOIN rd.dim_taxon l ON l.taxon_key = x.list_type_key
                                   LEFT JOIN rd.dim_taxon d1 ON d1.taxon_key = x.depth1_key LEFT JOIN rd.dim_taxon d2 ON d2.taxon_key = x.depth2_key
                                  WHERE p.prompt_id = $1""", pid)
        assert dict(ax) == {"funnel": "F2", "pres": ["branded", "unbranded"], "list_type": "L2", "d1": "D1", "d2": "D2b"}
        # S4b URL 인용률 커버리지 = 운영 summary_url_hit_generations(합성: 웹 세대 있음)
        assert await c.fetchval("SELECT judgment ->> 'url_hits_covered' FROM frz.generation WHERE state = 'active' AND surface = 2") == "true"
        assert await c.fetchval("SELECT count(*) FROM frz.card_brand_name n JOIN rd.dim_brand_name b USING (brand_key) "
                                "WHERE n.name = b.name AND b.kind = 1") >= 1
        # 웹 플래그가 빠진 셀이 있으면 그 회차는 실패(조용히 유닛 밖으로 세지 않는다)
        await c.execute("DELETE FROM mig_src.frz_ops_web WHERE generation_id = $1 AND job_id = "
                        "(SELECT min(job_id::text)::uuid FROM mig_src.frz_ops_web WHERE generation_id = $1)", gen)
        r2 = _one(await _run(c, commit=False, force=True))
        assert r2["status"] == "assert_failed" and "web.cells_without_flags 1" in r2["fails"], r2.get("fails")
        # 커버리지 행이 없으면 덮이지 않은 세대(현행 URL 인용률 2종 미러)
        await c.execute("DELETE FROM mig_src.frz_ops_url_cov")
        await c.execute("INSERT INTO mig_src.frz_ops_web SELECT o.cycle_id, o.generation_id, o.job_id, NULL, 0, 0, NULL, NULL, NULL "
                        "FROM mig_src.frz_ops_cell o WHERE o.generation_id = $1 AND NOT EXISTS "
                        "(SELECT 1 FROM mig_src.frz_ops_web w WHERE w.generation_id = o.generation_id AND w.job_id = o.job_id)", gen)
        r3 = _one(await _run(c, commit=True, force=True))
        assert r3["status"] == "committed", r3.get("fails")
        assert await c.fetchval("SELECT judgment ->> 'url_hits_covered' FROM frz.generation WHERE state = 'active' AND surface = 2") == "false"
    finally:
        await tr.rollback()
        await c.close()
    p = cli.parser()
    a = p.parse_args(["frz-import-ops", "--limit", "3"])
    assert (a.cmd, a.commit, a.force, a.limit, a.cycle) == ("frz-import-ops", False, False, 3, None)
    code, out = await cli.run(["frz-import-ops", "--limit", "0"], db=object())
    assert code == 2 and "limit" in out["error"]


@needs_db
async def test_changed_answer_equal_to_hub_is_not_kept():
    """바뀐 답변 후보라도 운영 행을 허브 모양으로 바꾼 값이 지금 rd 와 같으면 보관하지 않는다(순위는 서수 = 지금 rk 로 재현)."""
    c, tr = await _conn()
    try:
        cyc, gen = await make_ops(c, GLOBAL_CYC)
        x = await c.fetchrow(
            "SELECT o.job_id, j.answer_key FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id WHERE o.generation_id = $1 "
            "AND EXISTS (SELECT 1 FROM rd.answer_brand b WHERE b.answer_key = j.answer_key AND b.brand_key <> 0) "
            "AND NOT EXISTS (SELECT 1 FROM rd.answer_brand b WHERE b.answer_key = j.answer_key AND (b.rid_n <> 1 OR b.entity_rows <> 1)) "
            "AND NOT EXISTS (SELECT 1 FROM rd.answer_brand b WHERE b.answer_key = j.answer_key AND NOT b.competitive AND b.brand_key <> 0) "
            "ORDER BY j.answer_key LIMIT 1", gen)
        assert x is not None
        await c.execute("INSERT INTO mig_src.frz_ops_changed SELECT cycle_id, generation_id, job_id, run_id, now(), now(), true, false "
                        "FROM mig_src.frz_ops_cell WHERE generation_id = $1 AND job_id = $2", gen, x["job_id"])
        await c.execute("""INSERT INTO mig_src.frz_ops_answer SELECT o.cycle_id, o.generation_id, o.job_id, o.prompt_id, o.engine, o.country,
                           'completed', 1, 1, 1, 1, 0, coalesce(a.cit_n_all, 0), 1, NULL, NULL, NULL
                           FROM mig_src.frz_ops_cell o JOIN rd.job j ON j.job_id = o.job_id JOIN rd.answer a ON a.answer_key = j.answer_key
                           WHERE o.generation_id = $1 AND o.job_id = $2""", gen, x["job_id"])
        await c.execute("""INSERT INTO mig_src.frz_ops_brand
                           SELECT $1, $2, $3, gen_random_uuid(), n.name, b.competitive::int, b.mention_count,
                                  CASE WHEN b.competitive AND b.rk > 0 THEN b.rk::real END, b.s_pos, b.s_neu, b.s_neg, b.s_mix,
                                  b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice
                             FROM rd.answer_brand b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
                            WHERE b.answer_key = $4 AND b.brand_key <> 0""", cyc, gen, x["job_id"], x["answer_key"])
        r = _one(await _run(c, commit=True))
        assert r["status"] == "committed" and r["ops"]["changed"] == 1 and r["ops_differ"] == 0, r
        # 보관 없음(brand_card_fold 켬이면 공존 답변의 접기 보관 fold 는 이 시험의 대상 밖이라 뺀다: 대상 답변은 공존이 아니다)
        assert {k: v for k, v in (await kept(c)).items() if v != "fold"} == {} and x["answer_key"] not in await kept(c)
    finally:
        await tr.rollback()
        await c.close()
