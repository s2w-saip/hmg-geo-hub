"""/v1/citations/sources 유형 플래그 답변 열 경로(DB-v2.18 P105 rd.answer.t_own) 동치 시험.

1. t_own 경로 = 종전 jt 경로(바이트): /sources·/sources/types, 필터 4종(없음·brand=Hyundai·국가 1개·다회차 기간) × 계정 2개(관리자·현대 hq),
   프로필 끔·현행(IMPLEMENTED 20개, settings 직접 주입) 둘 다. jt 경로는 q.t_own_usable 을 거짓으로 바꿔 강제한다.
   어느 경로를 탔는지 sources_ans_sql 호출을 기록해 확인한다(대조가 같은 경로끼리가 아니다).
2. 미채움 폴백: 모수 답변 일부의 t_own 을 NULL 로 되돌리면 col → jt 로 다시 세고 값은 같다.
3. 열 값 = 정본: 픽스처 전 서빙 답변 t_own = rd.answer_brand 에서 독립 식(시험 안 CASE, rd.t_own_bits 를 쓰지 않음)으로 센 값, 0 아닌 행 있음.
4. 비트 배치: 조회 core(t_own_mask) = DB rd.t_own_bits(관점 비트 × 유형 15칸 전부).
준비: test_sources_equiv 와 같은 rich 준비(다회차·톤·언어·톤 중복) + 준비가 직접 넣은 답변까지 rd.fill_answer_t_own 으로 채움.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from app.core.config import set_settings
from app.core.profile import IMPLEMENTED, SWITCHES
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from app.features.analytics.citations.sources import queries as q
from tests.support import ADMIN, HQ_HYUNDAI, load_named_sql, needs_db, raw_fetch, staged
from tests.support import Sql as StageSql

pytestmark = needs_db
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
EQ = load_named_sql(pathlib.Path(__file__).with_name("equiv.pgsql"))
TO = load_named_sql(pathlib.Path(__file__).with_name("t_own.pgsql"))
FILL = StageSql(TO["fill"])
REP_TYPED = StageSql(TO["rep_typed"])            # cell_rep 프로필에서도 유형 값이 비지 않게(t_own.pgsql 주석)
STEPS = (StageSql(PROMPT_SQL["global"]), StageSql(BG["src_first"]), StageSql(BG["tone_negative"]), StageSql(BG["lang_ko"]),
         StageSql(BG["share_tie"]), StageSql(EQ["tone_dup"]), FILL, REP_TYPED)
FILTERS: tuple[dict[str, Any], ...] = ({}, {"brand": "Hyundai"}, {"country": "US"}, {"from": "2026-08-01", "to": "2026-09-30"})
CURRENT20 = ",".join(n for n in SWITCHES if n in IMPLEMENTED)
TYPE_NAMES = tuple(q.TYPE_COLS)


async def _bodies(client_as, uid) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    async with client_as(uid) as c:
        for path in ("/v1/citations/sources", "/v1/citations/sources/types"):
            for f in FILTERS:
                r = await c.get(path, params={"surface": "global", **f})
                out[f"{path} {f}"] = r.status_code.to_bytes(2, "big") + r.content
    return out


def _recorder(monkeypatch, seen: list[str]) -> None:
    real = q.sources_ans_sql

    def rec(ctx, win, *, types="col"):
        seen.append(types)
        return real(ctx, win, types=types)

    monkeypatch.setattr(q, "sources_ans_sql", rec)


# 프로필: 끔 · 언급 모수(table 'brand')가 갈리는 cell_rep 단독(is_rep ∧ std_in)·cell_rep+gap(is_rep 만) · 현행 20개.
# 현행 20개는 이 준비에서 글로벌 인용 모수가 0 이라(준비가 직접 넣은 회차 14 답변의 A41 모수 열·카탈로그 열이 시드 값과 다르다) 바이트 동치만 보고
# 비어 있지 않음 단언은 앞 세 프로필이 맡는다.
PROFILES = [("off", True), ("cell_rep", True), ("cell_rep,gap_in_population", True), (CURRENT20, False)]


@pytest.mark.parametrize(("profile", "nonempty"), PROFILES, ids=["off", "cell_rep", "cell_rep_gap", "current20"])
async def test_t_own_path_equals_jt(client_as, settings, monkeypatch, profile, nonempty):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": profile}))
        async with staged(*STEPS) as conn:
            null_n = (await raw_fetch(conn, TO["served_null"]))[0]["n"]
            assert null_n == 0
            col_seen: list[str] = []
            with monkeypatch.context() as m:
                _recorder(m, col_seen)
                col = {uid: await _bodies(client_as, uid) for uid in (ADMIN, HQ_HYUNDAI)}
            jt_seen: list[str] = []
            with monkeypatch.context() as m:
                _recorder(m, jt_seen)
                m.setattr(q, "t_own_usable", lambda ctx: False)
                jt = {uid: await _bodies(client_as, uid) for uid in (ADMIN, HQ_HYUNDAI)}
    finally:
        set_settings(settings)
    assert col_seen and set(col_seen) == {"col"} and jt_seen and set(jt_seen) == {"jt"}
    for uid in (ADMIN, HQ_HYUNDAI):
        diff = [k for k in col[uid] if col[uid][k] != jt[uid][k]]
        assert not diff, (profile, uid, diff)
        assert all(v[:2] == (200).to_bytes(2, "big") for v in col[uid].values())
    # 비어 있지 않은 대조: 유형 합이 0 이 아닌 /sources 응답이 있다(필터가 값을 가른다)
    totals = [tuple(t["total"] for t in json.loads(v[2:])["data"]["types"]) for k, v in col[ADMIN].items()
              if k.startswith("/v1/citations/sources {")]
    if nonempty:
        assert any(any(t) for t in totals) and len(set(totals)) > 1, totals


async def test_unfilled_falls_back_to_jt(client_as, monkeypatch):
    unfill = StageSql(TO["unfill"])
    async with staged(*STEPS, unfill) as conn:
        assert (await raw_fetch(conn, TO["all_null"]))[0]["n"] == 3
        seen: list[str] = []
        with monkeypatch.context() as m:
            _recorder(m, seen)
            got = await _bodies(client_as, ADMIN)
        with monkeypatch.context() as m:
            m.setattr(q, "t_own_usable", lambda ctx: False)
            want = await _bodies(client_as, ADMIN)
    assert "col" in seen and "jt" in seen                                  # 미채움 → col 뒤 jt 로 다시 셌다
    assert got == want


async def test_t_own_matches_independent_recompute():
    async with staged(*STEPS, role=None) as conn:
        rows = await raw_fetch(conn, TO["expect"])
        n = (await raw_fetch(conn, TO["assert_all"]))[0]["n"]
    bad = [r for r in rows if r["t_own"] != r["want"]]
    assert not bad, bad[:5]
    assert n == len(rows) > 0
    assert sum(1 for r in rows if r["want"]) > 0                         # 0 아닌 마스크가 있다(빈 대조 아님)
    assert len({r["want"] for r in rows}) > 2                            # 여러 모양


async def test_bit_layout_matches_db():
    sql = TO["bits"]
    async with staged(role=None) as conn:
        for bit in (1, 2, 4):
            for i in range(len(TYPE_NAMES)):
                args = [0] * 5
                args[i] = 3
                v = (await raw_fetch(conn, sql, bit, *args))[0]["v"]
                assert v == q.t_own_mask((bit,), i), (bit, TYPE_NAMES[i])
        assert (await raw_fetch(conn, sql, 16, 1, 1, 1, 1, 1))[0]["v"] is None
    assert q.t_own_mask((1, 2, 4), 0) == 1 | 32 | 1024
