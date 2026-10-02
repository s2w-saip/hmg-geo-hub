"""WU-2 셀 대표(A1)·ACR 반복(A15)·분석 결손(A16) 현행 프로필 DB 시험(합성 픽스처, 롤백 전용 또는 일회 DB).

  1. 대표 규칙 정본 rd.rep_expected = 파이썬 독립 계산(두 규칙: hub = elig 후보 안 최신, latest_first = 셀 최신을 먼저 굳히고 카탈로그 무관 elig_nc(P89) 가 아니면 없음).
     경계(셀 최신이 elig 아님)에서 hub 는 이전 elig 답변, latest_first 는 대표 없음
  2. 적재기 REP_UPDATE(두 규칙) = rd.reselect_rep = rd.rep_expected, 전파(rd.propagate_answer_gates)가 자식 is_rep 을 복사하고 rd.assert_rep 가
     자식 사본 불일치·셀당 대표 둘·규칙 불일치·elig 아닌 대표를 잡는다
  3. 변성 대조(엔드포인트): cell_rep 켜짐(원 상태) = OFF(대표 아닌 답변 elig 거짓 + 전파): 실제 화면 호출(warm_calls.json 34개) + 기간·답변 목록·
     언급 프롬프트·인용 유형·톤·비교·미측정 호출, 표면 global·website·project. 응답 data 가 같아야 한다(기능 파일 15개의 술어 전환 확인)
  4. 현행(cell_rep ∧ A15 ∧ A16) 모수: 답변 수 = OFF(대표만 elig) 의 결손 포함 모수(gap_base), 언급 합 = 같은 상태의 언급 합
  5. seed-40(-v rep_latest_first 0·1) 이 자식 is_rep 을 부모 사본으로 쓰고 rd.assert_rep 를 통과한다
  (채우기 SQL back/migration/fill-v215-rep.sql 시험은 일회 DB 픽스처가 있는 ingest/project/apply/tests/test_fill_v215_rep.py)
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
from datetime import date

import asyncpg
import pytest

from app.core import profile as P
from app.core.config import set_settings
from app.core.measure import brand_rows, fetch_counts
from ingest.project.apply import queries as q
from ingest.testkit import bulk_seed
from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, TODAY, Sql, load_named_sql, needs_db, staged

HERE = pathlib.Path(__file__).resolve().parent
BACK = HERE.parents[1]
PREP = load_named_sql(HERE / "cell_rep.pgsql")
WARM = json.loads((BACK / "app" / "tools" / "warm_calls.json").read_text(encoding="utf-8"))

_ROWS = """SELECT a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, a.answer_key, a.elig, a.elig_nc, j.measured_at, j.job_id
             FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key"""


def _oracle(rows, latest_first: bool) -> dict[int, bool]:
    """파이썬 독립 계산(SQL 창 함수 없이). uuid 정렬 = PostgreSQL uuid 바이트 순 = 소문자 16진 문자열 순."""
    cells: dict[tuple, list] = {}
    for r in rows:
        cells.setdefault((r["surface"], r["cyc_key"], r["prompt_key"], r["engine_key"], r["geo_key"]), []).append(r)
    out = {r["answer_key"]: False for r in rows}
    for rs in cells.values():
        if latest_first:
            nulls = [r for r in rs if r["measured_at"] is None]
            pool = nulls or rs                                              # DESC NULLS FIRST
            top = max(r["measured_at"] for r in pool) if not nulls else None
            cand = [r for r in pool if r["measured_at"] == top]
            pick = min(cand, key=lambda r: str(r["job_id"]))                # job_id 오름차순
            if pick["elig_nc"]:                                             # 현행 게이트 = 카탈로그 무관 elig_nc(P89, WU-4)
                out[pick["answer_key"]] = True
        else:
            el = [r for r in rs if r["elig"]]
            if not el:
                continue
            dated = [r for r in el if r["measured_at"] is not None]
            pool = dated or el                                              # DESC NULLS LAST
            top = max(r["measured_at"] for r in dated) if dated else None
            cand = [r for r in pool if r["measured_at"] == top]
            out[max(cand, key=lambda r: r["answer_key"])["answer_key"]] = True
    return out


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def _raises(c: asyncpg.Connection, match: str, sql: str, *args) -> None:
    """저장점 안에서 기대 예외(바깥 트랜잭션을 중단시키지 않는다)."""
    sp = c.transaction()
    await sp.start()
    try:
        with pytest.raises(asyncpg.RaiseError, match=match):
            await c.fetchval(sql, *args)
    finally:
        await sp.rollback()


# ════════════════════════════════════════════════════════════════════════════
# 1·2. 규칙 정본·적재기·재선정·전파·단언
# ════════════════════════════════════════════════════════════════════════════
@needs_db
@pytest.mark.parametrize("latest_first", [False, True])
async def test_rule_oracle_rep_update_reselect_and_assert(latest_first):
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        moved = [r[0] for r in await c.fetch(PREP["boundary_latest_non_elig"])]
        assert len(moved) == 1                                             # 경계 셀 1개(셀 최신 = 옛 대표를 elig 거짓으로)
        rows = await c.fetch(_ROWS)
        want = _oracle(rows, latest_first)
        exp = {r["answer_key"]: r["rep"] for r in await c.fetch("SELECT answer_key, rep FROM rd.rep_expected(NULL, $1)", latest_first)}
        assert exp == want
        bc = next(r for r in rows if r["answer_key"] == moved[0])
        cell = [r["answer_key"] for r in rows if (r["surface"], r["cyc_key"], r["prompt_key"], r["engine_key"], r["geo_key"])
                == (bc["surface"], bc["cyc_key"], bc["prompt_key"], bc["engine_key"], bc["geo_key"])]
        reps = [k for k in cell if want[k]]
        assert reps == [] if latest_first else (len(reps) == 1 and reps[0] != moved[0])   # hub = 이전 elig 답변, 현행 = 대표 없음

        # 적재기 문장(셀 임시 표 전체)
        await c.execute("CREATE TEMP TABLE _ig_cellu AS SELECT DISTINCT surface, round_date, cyc_key, prompt_key, engine_key, geo_key FROM rd.answer;"
                        "CREATE TEMP TABLE _ig_s (answer_key int4)")
        flips = await c.fetch(q.REP_UPDATE_LATEST_FIRST if latest_first else q.REP_UPDATE)
        assert flips and not any(f["own"] for f in flips)
        got = {r[0]: r[1] for r in await c.fetch("SELECT answer_key, is_rep FROM rd.answer")}
        assert got == want
        assert await c.fetchval("SELECT rd.reselect_rep(ARRAY(SELECT cyc_key FROM rd.cycle), $1)", latest_first) == 0   # 같은 규칙 = 0행
        assert await c.fetchval("SELECT rd.reselect_rep(ARRAY(SELECT cyc_key FROM rd.cycle), $1)", not latest_first) > 0 # 다른 규칙은 경계 셀을 바꾼다
        assert await c.fetchval("SELECT rd.reselect_rep(ARRAY(SELECT cyc_key FROM rd.cycle), $1)", latest_first) > 0

        # 자식 사본: 전파(뒤집힌 키 포함) 뒤 통과. 규칙을 모르는 단언(NULL)도 구조 불변식은 본다
        await c.fetchval(PREP["propagate_all"])
        n = await c.fetchval("SELECT count(*) FROM rd.answer")
        assert await c.fetchval("SELECT rd.assert_rep(NULL, $1)", latest_first) == n
        assert await c.fetchval("SELECT rd.assert_rep(NULL, NULL)") == n
        await _raises(c, "규칙 불일치 [1-9]", "SELECT rd.assert_rep(NULL, $1)", not latest_first)
        for t in ("rd.answer_brand", "rd.answer_stance", "rd.citation"):
            assert await c.fetchval(f"""SELECT count(*) FROM {t} x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date
                                          AND a.answer_key = x.answer_key WHERE x.is_rep IS DISTINCT FROM a.is_rep""") == 0, t
            assert await c.fetchval(f"SELECT count(*) FILTER (WHERE is_rep) FROM {t}") > 0, t          # 비어 있지 않은 대조

        # 단언이 잡는 것: 자식 사본 불일치, 셀당 대표 둘
        sp = c.transaction()
        await sp.start()
        await c.execute("""UPDATE rd.citation SET is_rep = NOT is_rep WHERE (surface, round_date, answer_key, ord) =
                             (SELECT surface, round_date, answer_key, ord FROM rd.citation ORDER BY answer_key, ord LIMIT 1)""")
        await _raises(c, "자식 사본 불일치 1", "SELECT rd.assert_rep(NULL, NULL)")
        await sp.rollback()
        sp = c.transaction()
        await sp.start()
        await c.execute("""UPDATE rd.answer a SET is_rep = true FROM (SELECT answer_key FROM rd.answer WHERE NOT is_rep AND elig
                             AND (surface, cyc_key, prompt_key, engine_key, geo_key) IN (SELECT surface, cyc_key, prompt_key, engine_key, geo_key
                                                                                         FROM rd.answer WHERE is_rep) LIMIT 1) x
                            WHERE a.answer_key = x.answer_key""")
        await _raises(c, "셀당 둘 이상 1", "SELECT rd.assert_rep(NULL, NULL)")
        await sp.rollback()
    finally:
        await tr.rollback()
        await c.close()


# ════════════════════════════════════════════════════════════════════════════
# 3. 엔드포인트 변성 대조: cell_rep(원 상태) = OFF(대표 아닌 답변 elig 거짓)
# ════════════════════════════════════════════════════════════════════════════
def _calls() -> list[tuple[str, dict]]:
    calls = [(c["path"], c["params"]) for c in WARM["calls"]]
    period = {"from": "2026-09-01", "to": "2026-09-30"}
    extra = [
        ("/v1/kpi/summary", {"surface": "global", **period}),
        ("/v1/kpi/engines", {"surface": "global", "part": "all", **period}),
        ("/v1/mentions/brands", {"surface": "global", "top_n": "20", "sort": "mentions", "include": ["multi", "prompts", "types"], **period}),
        ("/v1/mentions/types", {"surface": "global", **period}),
        ("/v1/mentions/prompts", {"surface": "global", "mode": "signal", "signal": "mention"}),
        ("/v1/mentions/prompts", {"surface": "global", "mode": "brand", "own": "true", **period}),
        ("/v1/citations/domains", {"surface": "global", "limit": "50", **period}),
        ("/v1/citations/sources", {"surface": "global", **period}),
        ("/v1/citations/sources/types", {"surface": "global"}),
        ("/v1/citations/sources/tone", {"surface": "global", "tone": "positive"}),
        ("/v1/citations/prompts", {"surface": "global", "owned": "false", "limit": "20"}),
        ("/v1/citations/prompts", {"surface": "global", "owned": "true", "limit": "20", **period}),
        ("/v1/answers", {"surface": "global", **period}),
        ("/v1/answers", {"surface": "global", "include_gap": "true"}),
        ("/v1/geo", {"surface": "global", **period}),
        ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none",
                       "metrics": ["visibility", "share_of_voice", "sentiment", "position", "citation_share"], **period}),
        ("/v1/kpi/compare", {"surface": "global"}),
        ("/v1/kpi/unmeasured-prompts", {"surface": "global"}),
        ("/v1/kpi/summary", {"surface": "project", "project_id": str(CUST_PROJECT)}),
        ("/v1/mentions/brands", {"surface": "project", "project_id": str(CUST_PROJECT), "top_n": "20", "sort": "mentions"}),
        ("/v1/citations/domains", {"surface": "project", "project_id": str(CUST_PROJECT), "limit": "20"}),
    ]
    return calls + extra


async def _collect(client_as, uid) -> dict[str, tuple[int, object]]:
    out: dict[str, tuple[int, object]] = {}
    async with client_as(uid) as cl:
        for i, (path, params) in enumerate(_calls()):
            r = await cl.get(path, params=params)
            body = r.json()
            out[f"{i}:{path}?{json.dumps(params, sort_keys=True)}"] = (r.status_code, body.get("data") if r.status_code == 200 else body)
    return out


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI])
async def test_endpoints_cell_rep_equals_off_on_rep_only_state(client_as, settings, uid):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "cell_rep"}))
        async with staged(Sql(PREP["fill_children"])):
            on = await _collect(client_as, uid)
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        async with staged(Sql(PREP["deelig_non_reps"]), Sql(PREP["propagate_all"])):
            ref = await _collect(client_as, uid)
        async with staged():
            base = await _collect(client_as, uid)                           # 원 상태 OFF(허브 정의): 차이가 실제로 있는지(비어 있지 않은 대조)
    finally:
        set_settings(settings)
    assert on.keys() == ref.keys()
    ok = [k for k in on if on[k][0] == 200]
    bad = {k: v for k, v in on.items() if v[0] != 200}
    assert len(ok) >= 40 if uid == ADMIN else len(ok) >= 30, bad                # HQ_HYUNDAI 는 웹사이트 메뉴 권한이 없다(403 menu_forbidden)
    odd = {k: (v[0], json.dumps(v[1], ensure_ascii=False)[:300]) for k, v in bad.items()
           if not (v[0] == 403 and "menu_forbidden" in json.dumps(v[1], ensure_ascii=False))}
    assert not odd, odd
    diff = {k: (on[k], ref[k]) for k in on if on[k] != ref[k]}
    assert not diff, json.dumps({k: [str(a)[:400], str(b)[:400]] for k, (a, b) in list(diff.items())[:3]}, ensure_ascii=False)
    assert sum(on[k] != base[k] for k in on) > 0                             # 픽스처에 비대표 답변이 있어 허브 정의와 값이 다르다


# ════════════════════════════════════════════════════════════════════════════
# 4. 현행 모수(cell_rep ∧ A15 ∧ A16): 결손·ACR 반복 대표도 모수, 언급 0
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_current_population_counts_gap_and_acr_reps(settings):
    from tests.core.test_db import ctx_for

    cur = P.LegacyProfile(cell_rep=True, acr_iter_unfolded=True, gap_in_population=True)
    rep_only = P.LegacyProfile(cell_rep=True)
    parts = ("mentions", "gap", "citations", "prompts", "rank_detail")
    periods = [{}, {"from_": date(2026, 9, 1), "to": date(2026, 9, 30)}]
    async with staged(Sql(PREP["fill_children"])) as conn:
        got = {}
        for i, kw in enumerate(periods):
            c = await ctx_for(conn, HQ_HYUNDAI, surface="global", **kw)
            w = await c.window(conn, today=TODAY)
            ms = c.measure()
            got[i] = [(await fetch_counts(conn, dataclasses.replace(ms, profile=pf), w, parts=parts, group_by=("engine",)))
                      for pf in (cur, rep_only)]
            got[f"b{i}"] = [await brand_rows(conn, dataclasses.replace(ms, profile=pf), w) for pf in (cur, P.OFF)]
    async with staged(Sql(PREP["deelig_non_reps"]), Sql(PREP["propagate_all"])) as conn:
        ref = {}
        for i, kw in enumerate(periods):
            c = await ctx_for(conn, HQ_HYUNDAI, surface="global", **kw)
            w = await c.window(conn, today=TODAY)
            ref[i] = await fetch_counts(conn, c.measure(), w, parts=parts, group_by=("engine",))
    for i in range(len(periods)):
        cur_rows = {r["engine_key"]: r for r in got[i][0]}
        rep_rows = {r["engine_key"]: r for r in got[i][1]}
        off_rows = {r["engine_key"]: r for r in ref[i]}
        assert cur_rows.keys() == off_rows.keys() and cur_rows
        for e, r in cur_rows.items():
            o = off_rows[e]
            assert r["answers"] == o["gap_base"], (i, e)                    # 결손 대표 포함 = 대표 ∧ cit_in 수
            for k in ("tracked", "own_mentions", "total_mentions", "rank_sum", "ranked", "cit_total", "cit_owned", "cit_target"):
                assert r[k] == o[k], (i, e, k)                               # 결손 답변은 언급·인용 0
            assert rep_rows[e]["answers"] == o["answers"], (i, e)            # cell_rep 만 = 대표 ∧ std_in
        assert sum(r["answers"] for r in cur_rows.values()) > sum(r["answers"] for r in rep_rows.values())   # 픽스처 결손 대표가 모수에 든다
    assert got["b0"][0] != got["b0"][1] or got["b1"][0] != got["b1"][1]     # 경쟁 행도 모수가 바뀐다


def test_switch_requires_cell_rep():
    for name in ("acr_iter_unfolded", "gap_in_population"):
        with pytest.raises(ValueError, match="cell_rep"):
            P.parse_profile(name)
        assert P.parse_profile(f"cell_rep,{name}").on == ("cell_rep", name)


# ════════════════════════════════════════════════════════════════════════════
# 5. seed-40: 자식 is_rep = 부모, 두 규칙
# ════════════════════════════════════════════════════════════════════════════
@needs_db
@pytest.mark.parametrize("latest_first", [False, True])
async def test_seed40_writes_child_is_rep(latest_first):
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        await bulk_seed(c, rep_latest_first=latest_first, rep_round_date_cell=False)   # 이 시험 = 회차 셀 두 규칙(답변분석 자리 규칙은 test_rep_seat)
        n = await c.fetchval("SELECT count(*) FROM rd.answer")
        assert await c.fetchval("SELECT rd.assert_rep(NULL, $1)", latest_first) == n > 0
        assert await c.fetchval("SELECT count(*) FILTER (WHERE is_rep) FROM rd.citation") > 0
    finally:
        await tr.rollback()
        await c.close()
