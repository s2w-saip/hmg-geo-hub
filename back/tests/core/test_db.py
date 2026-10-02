"""core DB 통합 테스트(로컬 개발 DB hmg_core, 합성 픽스처). 기대값은 fixture-10-data 손 계산(아래 주석)과 check-expected.sql 과 같은 근거.

픽스처 글로벌 스냅샷(기준일 2026-09-27): 회차 11(round_date 2026-09-14, 노출 09-16). 12 는 open(비서빙), 10 은 09-07.
  회차 11 서빙 답변: k1(US·bgrp 5·std) k2(US·5·std) k4(KR·1·gap 2) k9(US·5·state 3) k12(US·8·ACR 최신·std)
                     k3·k5·k6·k7·k15(elig 거짓) k8(deepseek·기본 엔진 밖) k10·k11(ACR 반복·cit_in 거짓)
  현대 관점(bgrp & 9 ≠ 0): std = k1·k2·k12, 노출(own_mask&1) = k1·k12, 언급 4+0+1 / 7+3+1, 긍정 3+0+1 / 4+0+1, 순위 2+1 / 2,
    결손 모수(cit_in) k1·k2·k4·k9·k12 = 5, 결손 k4·k9 = 2, 인용 cit_n 9(k1), 자사 H = 2(1.1 AU·1.9 US)
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

import pytest
from fastapi import APIRouter, FastAPI, Query
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core import errors
from app.core.auth import (
    QA_COOKIE,
    CurrentUser,
    DataScope,
    QaConn,
    QaUser,
    check_qa_password,
    new_qa_session,
    require_menu_group,
    require_role,
    resolve_project,
    sign_qa_cookie,
    verify_qa_cookie,
)
from app.core.codes import load_refs
from app.core.cycles import CycleRow, build_window, resolve_window
from app.core.db import RoConn, fetch_all, fetch_one, fetch_val, get_db
from app.core.envelope import Envelope, build_meta
from app.core.errors import install_error_handlers
from app.core.filters import KPI_SUPPORT, CommonFilters, FilterSupport, resolve_read_context
from app.core.measure import (
    MeasureScope,
    allowed_owner_keys,
    brand_rows,
    citation_counts,
    fetch_counts,
    prompt_counts,
    rank_brand_items,
    url_rates,
)
from app.core.write import AccessAuditWriter, RwConn, WriteAccepted, enqueue_change, enqueue_scope
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SUSPENDED,
    TODAY,
    VENDOR,
    needs_db,
    principal,
)

pytestmark = needs_db
L = date(2026, 9, 14)


def cf(**kw) -> CommonFilters:
    if "from_" in kw:
        kw["from"] = kw.pop("from_")
    return CommonFilters.model_validate(kw)


async def ctx_for(conn, uid, support=KPI_SUPPORT, **kw):
    p = await principal(conn, uid)
    return await resolve_read_context(conn, p, cf(**kw), support=support)


# ── 세션 규약 ─────────────────────────────────────────────────────────────────
async def test_ro_session_role_readonly_and_no_leak(database):
    async with database.read("api_ro") as c:
        r = await fetch_one(c, "SELECT current_user AS u, current_setting('transaction_read_only') AS ro, "
                               "current_setting('statement_timeout') AS t, current_setting('jit') AS j, "
                               "current_setting('transaction_isolation') AS iso")
        assert r == {"u": "api_ro", "ro": "on", "t": "5s", "j": "off", "iso": "repeatable read"}
        with pytest.raises(Exception) as e:
            await c.execute(text("INSERT INTO app.rule_param (key, value) VALUES ('x', '1')"))
        assert "read-only" in str(e.value) or "permission" in str(e.value)
    # 같은 풀 커넥션에 세션 값이 남지 않는다(set_config(true) 만)
    async with database.engine("api_ro").connect() as raw:
        r = (await raw.execute(text("SELECT current_user, current_setting('statement_timeout')"))).first()
        assert r[0] != "api_ro" and r[1] == "0"
    async with database.read("admin_long") as c:
        assert await fetch_val(c, "SELECT current_setting('statement_timeout')") == "30s"


async def test_rw_actor_and_ing_denied(database):
    async with database.write(ADMIN) as c:
        assert await fetch_val(c, "SELECT app.actor()") == ADMIN
        assert await fetch_val(c, "SELECT current_user") == "api_rw"
    with pytest.raises(DBAPIError):
        async with database.write(ADMIN) as c:
            await c.execute(text("SELECT count(*) FROM rd.answer"),          # api_rw 는 rd 권한 없음(A17). 가드 예외로 권한만 시험
                            execution_options={"hgh_sql_guard": False})


# ── 창(resolve_window) ───────────────────────────────────────────────────────
async def test_window_snapshot_offset_range(ro):
    w = await resolve_window(ro, surface="global", project_keys=(1,), date_from=None, date_to=None, today=TODAY)
    assert (w.mode, w.lo, w.hi, w.cyc_keys("mentions")) == ("snapshot", L, L, (11,))
    w1 = await resolve_window(ro, surface="global", project_keys=(1,), date_from=None, date_to=None, offset=1, today=TODAY)
    assert (w1.lo, w1.cyc_keys("row")) == (date(2026, 9, 7), (10,))
    early = await resolve_window(ro, surface="global", project_keys=(1,), date_from=None, date_to=None, today=date(2026, 9, 15))
    assert early.lo == date(2026, 9, 7)                               # 11 은 노출일(09-16) 전
    none = await resolve_window(ro, surface="global", project_keys=(1,), date_from=None, date_to=None, offset=1,
                                today=date(2026, 9, 15))
    assert none.empty and none.lo is None
    rng = await resolve_window(ro, surface="global", project_keys=(1,), date_from=date(2026, 9, 1), date_to=date(2026, 9, 30), today=TODAY)
    assert (rng.mode, rng.cyc_keys("mentions"), rng.round_dates) == ("cumulative", (10, 11), (date(2026, 9, 7), L))
    web = await resolve_window(ro, surface="website", project_keys=(2,), date_from=None, date_to=None, today=TODAY)
    assert web.cyc_keys("mentions") == (21,) and web.cyc_keys("citations") == () and web.hidden("citations")
    prj = await resolve_window(ro, surface="project", project_keys=(3,), date_from=None, date_to=None, today=TODAY)
    assert prj.lo == date(2026, 9, 20) and prj.cyc_keys("citations") == (31,)
    miss = await resolve_window(ro, surface="website", project_keys=(2, 99), date_from=None, date_to=None, today=TODAY)
    assert miss.missing_project_keys == (99,)
    with pytest.raises(ValueError):
        await resolve_window(ro, surface="global", project_keys=(1,), date_from=date(2026, 9, 1), date_to=None)


# ── 읽기 문맥 ─────────────────────────────────────────────────────────────────
async def test_read_context_scope_and_filters(ro):
    c = await ctx_for(ro, HQ_HYUNDAI, surface="global", brand=["Kia"], country=["us", "ZZ"], source=["news"], engine=["gemini", "nope"])
    assert c.own_bits == (1,) and c.own_brands == ("Hyundai",) and c.project_keys == (1,)
    assert c.dropped_filters == {"brand": ("Kia",), "country": ("ZZ",), "engine": ("nope",)}
    us = c.refs.geo_key("US")
    assert c.ignored_filters == ("source",) and c.engine_keys == (2,) and c.countries == ("US",) and c.geo_keys == (us,)   # 글로벌 lang 은 지원 축(BG-01)
    assert c.bgrps is not None and 5 in c.bgrps and 8 in c.bgrps and 2 not in c.bgrps and 16 not in c.bgrps
    assert c.owner is not None and c.owner.mode == "country1" and c.owner.own_bits == (1,)
    a = await ctx_for(ro, ADMIN, surface="global")
    assert a.own_bits == (1, 2, 4) and a.owner.mode == "brand" and a.countries is None and a.geo_keys is None
    k = await ctx_for(ro, KIA_US, surface="global")
    assert k.countries == ("US",) and k.geo_keys == (us,) and k.own_bits == (2,) and k.owner.mode == "country1"
    assert set(k.owner.keys) >= {59, 60, 61} and 76 not in k.owner.keys
    k2 = await ctx_for(ro, KIA_US, surface="global", country=["DE"])      # 스코프 밖 국가만 → 빈 집합(fail-closed)
    assert k2.dropped_filters == {"country": ("DE",)} and k2.geo_keys == ()
    eu = await ctx_for(ro, KIA_EU, surface="website")
    assert eu.project_keys == (2,) and eu.bgrps == (2,) and "DE" in (eu.countries or ())
    v = await ctx_for(ro, KIA_EU, surface="website", country=["HYUNDAI-N"])  # 가상 코드는 bgrp 로(기아 관점과 교집합 없음)
    assert v.project_keys == ()
    # D-vendor: vendor 는 표준·웹사이트 경로 밖(route-policy.ts:26-35) → 403 role_forbidden. '무제한'(추가 결정)은 데이터 스코프만
    for sf in ("global", "website"):
        with pytest.raises(errors.ApiError) as ei:
            await ctx_for(ro, VENDOR, surface=sf)
        assert ei.value.status == 403 and ei.value.code == "role_forbidden"
    vs = DataScope.of(await principal(ro, VENDOR), await load_refs(ro))
    assert vs.brands is None and vs.countries is None                     # 브랜드 스코프 빈 vendor 의 데이터 스코프 = 무제한
    t = await ctx_for(ro, HQ_HYUNDAI, surface="global", funnel=["F1", "ZZ"])
    assert t.prompt_keys == (1, 3, 4) and t.dropped_filters == {"funnel": ("ZZ",)}
    per = await ctx_for(ro, HQ_HYUNDAI, surface="global", from_=date(2026, 9, 1), to=date(2026, 9, 30))
    assert (per.date_from, per.date_to) == (date(2026, 9, 1), date(2026, 9, 30))
    nosup = FilterSupport.of(global_=("country",))
    n = await ctx_for(ro, HQ_HYUNDAI, support=nosup, surface="global", from_=date(2026, 9, 1), to=date(2026, 9, 30), engine=["gemini"])
    assert n.date_from is None and n.engine_keys is None and n.ignored_filters == ("engine", "period")


async def test_project_access_levels(ro, refs):
    hq = await principal(ro, HQ_HYUNDAI)
    acc = await resolve_project(ro, hq, refs, CUST_PROJECT)             # 비멤버지만 스코프 안(브랜드 Hyundai·US)
    assert acc.project_keys == (3,) and acc.member_role is None
    with pytest.raises(errors.ApiError) as e:
        await resolve_project(ro, hq, refs, CUST_PROJECT, "owner")
    assert e.value.status == 403
    with pytest.raises(errors.ApiError) as e:
        await resolve_project(ro, await principal(ro, KIA_US), refs, CUST_PROJECT)
    assert e.value.status == 404                                         # 스코프 밖 = 존재 은폐
    vd = await principal(ro, VENDOR)
    assert (await resolve_project(ro, vd, refs, CUST_PROJECT)).member_role == "viewer"
    with pytest.raises(errors.ApiError) as e:
        await resolve_project(ro, vd, refs, CUST_PROJECT, "operate")    # vendor = operator none
    assert e.value.status == 403
    with pytest.raises(errors.ApiError) as e:
        await resolve_project(ro, await principal(ro, ADMIN), refs, uuid.UUID("c0000000-0000-4000-8000-000000000001"))
    assert e.value.status == 404                                         # standard_root 는 프로젝트 API 밖
    assert (await resolve_project(ro, await principal(ro, ADMIN), refs, CUST_PROJECT, "owner_and_operate")).project_id == CUST_PROJECT


# ── 지표: 손 계산 기대값 ───────────────────────────────────────────────────────
async def counts(ro, uid, parts=("mentions", "gap", "urls", "citations", "prompts", "rank_detail"), group_by=(), **kw):
    c = await ctx_for(ro, uid, **kw)
    w = await c.window(ro, today=TODAY)
    return c, w, await fetch_counts(ro, c.measure(), w, parts=parts, group_by=group_by)


async def test_global_snapshot_hyundai(ro):
    c, w, rows = await counts(ro, HQ_HYUNDAI, surface="global")
    r = rows[0]
    assert {k: r[k] for k in ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all",
                              "rank_sum", "ranked", "gap_base", "gap_answers", "cit_total", "cit_owned", "cit_target",
                              "measured_prompts", "mentioned_prompts", "multi", "top1", "top3")} == {
        "answers": 3, "tracked": 2, "own_mentions": 5, "total_mentions": 11, "sent_pos": 4, "sent_neg": 0, "sent_all": 5,
        "rank_sum": 3, "ranked": 2, "gap_base": 5, "gap_answers": 2, "cit_total": 9, "cit_owned": 2, "cit_target": 0,
        "measured_prompts": 2, "mentioned_prompts": 2, "multi": 1, "top1": 1, "top3": 2}


async def test_global_snapshot_admin_and_kia(ro):
    _, _, rows = await counts(ro, ADMIN, surface="global", parts=("mentions", "citations"))
    r = rows[0]
    assert (r["answers"], r["tracked"], r["own_mentions"], r["sent_pos"], r["sent_all"], r["rank_sum"], r["ranked"], r["cit_owned"]) == \
        (3, 3, 7, 5, 7, 4, 3, 3)                                         # HMG = 3사 순위 중 0 을 뺀 최솟값(k2 = 기아 1)
    _, _, rows = await counts(ro, KIA_US, surface="global", parts=("mentions", "gap", "citations"))
    r = rows[0]
    assert (r["answers"], r["tracked"], r["total_mentions"], r["gap_base"], r["cit_total"]) == (1, 0, 1, 1, 0)


async def test_global_engine_taxonomy_and_groups(ro):
    _, _, rows = await counts(ro, HQ_HYUNDAI, surface="global", engine=["gemini"], parts=("mentions",))
    assert rows[0]["answers"] == 1                                       # k2 만
    _, _, rows = await counts(ro, HQ_HYUNDAI, surface="global", funnel=["F2"], parts=("mentions",))
    assert rows[0]["answers"] == 0
    _, _, rows = await counts(ro, HQ_HYUNDAI, surface="global", parts=("mentions", "citations"), group_by=("engine",))
    by = {r["engine_key"]: r for r in rows}
    assert by[1]["answers"] == 2 and by[2]["answers"] == 1 and by[1]["cit_total"] == 9
    _, _, total = await counts(ro, HQ_HYUNDAI, surface="global", parts=("mentions", "citations"))
    assert sum(r["answers"] for r in rows) == total[0]["answers"] and sum(r["cit_owned"] for r in rows) == total[0]["cit_owned"]  # D6
    c = await ctx_for(ro, HQ_HYUNDAI, surface="global", from_=date(2026, 9, 1), to=date(2026, 9, 30))
    w = await c.window(ro, today=TODAY)
    rows = await fetch_counts(ro, c.measure(), w, parts=("mentions", "gap"), group_by=("round_date",))
    by = {r["round_date"]: r for r in rows}
    assert by[L]["answers"] == 3 and by[date(2026, 9, 7)]["answers"] == 0 and by[date(2026, 9, 7)]["gap_base"] == 3   # k16·k17·k18(pin 코호트)
    split = await fetch_counts(ro, c.measure(), w, parts=("mentions",), split_at=L)
    assert {r["win"]: r["answers"] for r in split} == {"cur": 3, "prev": 0}


async def test_global_owner_modes_equal_citation_scan(ro, refs):
    """G-25 핵심: 답변 열 경로(brand·country1·countryN) = rd.citation 원소 스캔(own_expr) — 같은 창·필터."""
    cases = [dict(surface="global"), dict(surface="global", country=["US"]), dict(surface="global", country=["US", "AU"]),
             dict(surface="global", country=["KR", "US"]), dict(surface="global", country=["ZZ", "US", "DE"])]
    seen = set()
    for uid in (HQ_HYUNDAI, ADMIN):
        for kw in cases:
            c = await ctx_for(ro, uid, **kw)
            w = await c.window(ro, today=TODAY)
            ms = c.measure()
            a = (await fetch_counts(ro, ms, w, parts=("citations",)))[0]
            s = (await citation_counts(ro, ms, w))[0]
            assert (a["cit_total"], a["cit_owned"], a["cit_target"]) == (s["cit_total"], s["cit_owned"], s["cit_target"]), (uid, kw, ms.owner)
            seen.add(ms.owner.mode)
    assert seen == {"brand", "country1", "countryN"}
    c = await ctx_for(ro, HQ_HYUNDAI, surface="global", country=["US"])
    w = await c.window(ro, today=TODAY)
    assert (await fetch_counts(ro, c.measure(), w, parts=("citations",)))[0]["cit_owned"] == 1     # 1.9 US 만(1.1 AU 제외)
    c = await ctx_for(ro, HQ_HYUNDAI, surface="global", country=["US", "AU"])
    w = await c.window(ro, today=TODAY)
    assert (await fetch_counts(ro, c.measure(), w, parts=("citations",)))[0]["cit_owned"] == 2     # 교차 국가(AU 베이스) 포함
    # 언어로 좁힌 허용 배열(scan 경로): 기능이 lang 을 지원한다고 가정한 문맥
    own_bit_of = {"Hyundai": 1, "Kia": 2, "Genesis": 4}
    for langs, expect in ((["en"], 2), (["fr"], None)):
        owner = allowed_owner_keys(refs.owned_bases, {"Hyundai"}, own_bit_of, None, langs)
        ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=c.bgrps, owner=owner)
        a = (await fetch_counts(ro, ms, w, parts=("citations",)))[0]
        s = (await citation_counts(ro, ms, w))[0]
        assert a["cit_owned"] == s["cit_owned"]
        if expect is not None:
            assert owner.mode == "scan" and a["cit_owned"] == expect


def _core3(x: dict) -> dict:
    return {k: x[k] for k in ("target", "owned", "origin")}


async def test_website_and_project(ro):
    c, w, rows = await counts(ro, KIA_EU, surface="website", parts=("mentions", "citations", "urls"))
    r = rows[0]
    assert (r["answers"], r["tracked"], r["own_mentions"], r["sent_all"], r["rank_sum"], r["ranked"]) == (2, 1, 1, 1, 1, 1)
    assert w.hidden("citations") and (r["cit_total"], r["url_den"]) == (0, 0)   # 회차 21 인용 숨김
    shown = build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 18),
                         hi=date(2026, 9, 18), generation=1, project_keys=(2,))
    r = (await fetch_counts(ro, c.measure(), shown, parts=("citations", "urls")))[0]
    assert (r["cit_total"], r["cit_owned"], r["cit_target"], r["url_den"], r["tgt_hits"], r["own_url_hits"]) == (4, 3, 2, 2, 2, 2)
    s = (await citation_counts(ro, c.measure(), shown))[0]
    assert (s["cit_total"], s["cit_owned"], s["cit_target"]) == (4, 3, 2)
    # R09 발행값: 사이트 스코프(web_unit 프로젝트)·국가·브랜드 안 유닛만 합친다(101 + 102). 301(FR, 웹 유닛 없음)·401(Hyundai) 제외
    rates = await url_rates(ro, c.measure(), shown, brands=["Kia"], countries=None, langs=None)
    assert _core3(rates[None]) == {"target": (10, 15), "owned": (12, 15), "origin": "report"}
    assert rates[None]["publications"] == ["rep-0918"] and rates[None]["reason"] is None and not rates[None]["headline_pool_applied"]
    assert rates[None]["accuracy"] == (2, 2)                                                 # 정확도 = 라이브(타겟 ∧ 자사 / 자사)
    other = await url_rates(ro, c.measure(), shown, brands=["Hyundai"], countries=None, langs=None)
    assert other[None]["origin"] == "live" and other[None]["reason"] == "no_publication"      # 401 은 이 스코프 밖 유닛
    assert other[None]["publications"] == []
    it_only = MeasureScope(**{**c.measure().__dict__, "geo_keys": (c.refs.geo_key("IT"),)})   # 허용 국가(IT) 밖 발행값은 합치지 않는다
    assert (await url_rates(ro, it_only, shown, brands=["Kia"], countries=None, langs=None))[None]["origin"] == "live"
    live = await url_rates(ro, MeasureScope(**{**c.measure().__dict__, "engine_keys": (1,)}), shown, brands=["Kia"],
                           countries=None, langs=None)
    assert live[None]["origin"] == "live" and live[None]["reason"] == "engine_axis"          # 엔진 필터 = 발행값 미지원 축
    byr = await url_rates(ro, c.measure(), shown, brands=["Kia"], countries=["DE"], langs=["de"], by_round=True)
    assert _core3(byr[date(2026, 9, 18)]) == {"target": (10, 15), "owned": (12, 15), "origin": "report"}
    # D-R09: 회차 하나를 고른 기간(from = to)은 스냅샷처럼 발행값, 회차 둘 이상 기간 누적은 라이브(period_range)
    one = build_window(surface="website", mode="cumulative", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 18),
                       hi=date(2026, 9, 18), generation=1, project_keys=(2,))
    assert (await url_rates(ro, c.measure(), one, brands=["Kia"], countries=None, langs=None))[None]["origin"] == "report"
    rng = build_window(surface="website", mode="cumulative", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 1),
                       hi=date(2026, 9, 30), generation=1, project_keys=(2,))
    rr = (await url_rates(ro, c.measure(), rng, brands=["Kia"], countries=None, langs=None))[None]
    assert rr["origin"] == "live" and rr["reason"] == "period_range"
    with pytest.raises(TypeError):
        await url_rates(ro, c.measure(), shown, brands=["Kia"])                               # countries·langs 필수(기본값 없음)
    p, pw, prow = await counts(ro, VENDOR, surface="project", project_id=CUST_PROJECT, parts=("mentions", "citations", "urls"))
    r = prow[0]
    assert pw.lo == date(2026, 9, 20) and p.bgrps is None
    assert (r["answers"], r["tracked"], r["cit_total"], r["cit_owned"], r["cit_target"]) == (1, 0, 4, 3, 1)
    # D-url-denominator: 프로젝트 M06·M07 분모 = cit_in 답변 전체(web_reg 게이트 없음, Q5). k31 = 타겟·자사 URL 인용
    assert (r["url_den"], r["tgt_hits"], r["own_url_hits"], r["tgt_own_hits"]) == (1, 1, 1, 1)
    pr = (await url_rates(ro, p.measure(), pw, brands=list(p.own_brands), countries=p.countries, langs=p.langs))[None]
    assert pr["target"] == (1, 1) and pr["owned"] == (1, 1) and pr["origin"] == "live" and pr["reason"] == "not_website"


async def test_brand_rows_and_applied_prompts(ro):
    c = await ctx_for(ro, HQ_HYUNDAI, surface="global")
    w = await c.window(ro, today=TODAY)
    comp = await brand_rows(ro, c.measure(), w)
    names = {r["brand_key"]: r["name"] for r in await fetch_all(ro, "SELECT brand_key, name FROM rd.dim_brand_name")}
    got = {names[r["brand_key"]]: (r["mentions"], r["exposure_answers"], r["rank_sum"], r["ranked"]) for r in comp}
    assert got == {"Toyota": (3, 1, 1, 1), "Kia": (2, 1, 1, 1), "smart": (1, 1, 2, 1)}       # 형제 HMG(Kia) 는 경쟁 행에 남는다
    own = (await fetch_counts(ro, c.measure(), w, parts=("mentions",)))[0]
    items = [{"name": n, "mentions": m[0]} for n, m in got.items()] + [{"name": "Hyundai", "mentions": own["own_mentions"]}]
    assert [i["name"] for i in rank_brand_items(items)] == ["Hyundai", "Toyota", "Kia", "smart"]
    assert await prompt_counts(ro, c.measure()) == 4
    assert await prompt_counts(ro, (await ctx_for(ro, KIA_US, surface="global")).measure()) == 3
    assert await prompt_counts(ro, (await ctx_for(ro, KIA_EU, surface="website")).measure()) == 3
    assert await prompt_counts(ro, (await ctx_for(ro, VENDOR, surface="project", project_id=CUST_PROJECT)).measure()) == 1


# ── 쓰기 ─────────────────────────────────────────────────────────────────────
async def test_enqueue_change_scope_and_audit(database):
    subj = [uuid.uuid4()]
    async with database.write(ADMIN) as c:
        cid = await enqueue_change(c, "owned_base", subject_uuids=subj, payload={"op": "update"})
        with pytest.raises(errors.ApiError) as e:
            await enqueue_change(c, "owned_base", subject_uuids=subj, payload={"op": "update"})
        assert e.value.status == 409 and e.value.code == "duplicate_pending"
        with pytest.raises(ValueError):
            await enqueue_change(c, "catalog", subject_uuids=subj)
        with pytest.raises(ValueError):
            await enqueue_change(c, "cycle_admin")
        agg = uuid.uuid4()
        o1 = await enqueue_scope(c, "project", agg, "update", {"project_id": str(agg), "v": 1})
        o2 = await enqueue_scope(c, "project", agg, "update", {"project_id": str(agg), "v": 2})
        assert o1 == o2
    async with database.read("admin_long") as c:
        r = await fetch_one(c, "SELECT kind, requested_by, status FROM app.judgment_change WHERE change_id = :i", {"i": cid})
        assert r == {"kind": "owned_base", "requested_by": ADMIN, "status": "pending"}
        assert await fetch_val(c, "SELECT payload->>'v' FROM app.scope_outbox WHERE outbox_id = :i", {"i": o1}) == "2"


async def test_access_audit_writer(database):
    async with database.read("api_ro") as c:
        p = await principal(c, HQ_HYUNDAI)
    w = AccessAuditWriter(flush_s=0.05, batch=2)
    marker = str(uuid.uuid4())
    w.start()
    w.record(p, "data_access", "answer_body", target=marker)
    w.record(p, "download", "csv", target=marker, detail={"rows": 3})
    w.record(p, "scope_call", "run", target=marker)
    with pytest.raises(ValueError):
        w.record(p, "api_read", "x")  # type: ignore[arg-type]
    await w.stop()
    assert w.written == 3 and w.dropped == 0
    async with database.read("admin_long") as c:
        assert await fetch_val(c, "SELECT count(*) FROM app.access_audit_log WHERE target = :m AND actor_id = :a",
                               {"m": marker, "a": HQ_HYUNDAI}) == 3


# ── HTTP 의존성 체인(JWT → 계정 → 같은 api_ro 트랜잭션 → 문맥 → 지표 → 봉투) ─────────────────
def _app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    r = APIRouter()

    @r.get("/t/kpi")
    async def kpi(p: CurrentUser, conn: RoConn, filters: Annotated[CommonFilters, Query()]) -> Envelope[dict]:
        ctx = await resolve_read_context(conn, p, filters, support=KPI_SUPPORT)
        win = await ctx.window(conn, today=TODAY)
        rows = await fetch_counts(conn, ctx.measure(), win, parts=("mentions", "citations"))
        checked_out = get_db().engine("api_ro").pool.checkedout()       # 계정 조회·지표가 한 커넥션을 공유(의존성 캐시)
        return Envelope[dict](data={**rows[0], "ro_checked_out": checked_out}, meta=build_meta(mode=win.mode, window=win, ctx=ctx))

    @r.post("/t/change")
    async def change(p: CurrentUser, conn: RwConn) -> WriteAccepted:
        cid = await enqueue_change(conn, "rule_param", subject_texts=[f"t-{uuid.uuid4()}"], payload={"op": "update"})
        return WriteAccepted(change_id=cid, propagation="pending")

    @r.get("/t/qa")
    async def qa(reviewer: QaUser, conn: QaConn) -> dict:
        return {"name": reviewer.name, "role": await fetch_val(conn, "SELECT current_user"),
                "jobs": await fetch_val(conn, "SELECT count(*) FROM rd.job")}

    @r.get("/t/admin", dependencies=[require_role("admin")])
    async def admin_only() -> dict:
        return {"ok": True}

    @r.get("/t/admin-menu", dependencies=[require_menu_group("admin")])
    async def admin_menu() -> dict:
        return {"ok": True}

    app.include_router(r)
    return app


async def test_http_chain(database, token):
    app = _app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as cl:
        r = await cl.get("/t/kpi", params={"surface": "global"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"
        r = await cl.get("/t/kpi", params={"surface": "global"}, headers={"Authorization": "Bearer abc.def.ghi"})
        assert r.status_code == 401
        r = await cl.get("/t/kpi", params={"surface": "global"}, headers={"Authorization": f"Bearer {token(HQ_HYUNDAI, exp_in=-60)}"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "token_expired"
        r = await cl.get("/t/kpi", params={"surface": "global"}, headers={"Authorization": f"Bearer {token(HQ_HYUNDAI, aud='x')}"})
        assert r.status_code == 401
        r = await cl.get("/t/kpi", params={"surface": "global"}, headers={"Authorization": f"Bearer {token(SUSPENDED)}"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
        h = {"Authorization": f"Bearer {token(HQ_HYUNDAI)}"}
        r = await cl.get("/t/kpi", params={"surface": "global", "country": ["US", "ZZ"], "lang": "en"}, headers=h)
        assert r.status_code == 200, r.text
        b = r.json()
        assert (b["data"]["answers"], b["data"]["cit_total"], b["data"]["cit_owned"]) == (3, 9, 1)
        assert b["meta"]["cycles"] == ["2026-09-14"] and b["meta"]["dropped_filters"] == {"country": ["ZZ"]}
        assert b["meta"]["ignored_filters"] == [] and b["meta"]["mode"] == "snapshot"      # 글로벌 lang 은 지원 축(BG-01): US·en 답변 = 같은 값
        assert "cyc_key" not in r.text and b["data"]["ro_checked_out"] == 1
        r = await cl.post("/t/change", headers=h)
        assert r.status_code == 200 and r.json()["propagation"] == "pending"
        async with database.read("admin_long") as c:                       # 응답 전에 COMMIT 됐다(scope='function')
            assert await fetch_val(c, "SELECT requested_by FROM app.judgment_change WHERE change_id = :i",
                                   {"i": r.json()["change_id"]}) == HQ_HYUNDAI
        r = await cl.get("/t/kpi", params={"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}, headers=h)
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"      # from > to(한쪽만은 이제 허용: fe-u1 요청 5)
        r = await cl.get("/t/kpi", params={"surface": "nope"}, headers=h)
        assert r.status_code == 422
        r = await cl.get("/t/kpi", params={"surface": "project"}, headers=h)
        assert r.status_code == 422                                            # project_id 필수
        # 검수 게이트(Q17)
        r = await cl.get("/t/qa")
        assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
        cookie = sign_qa_cookie(new_qa_session("검수자A"))
        r = await cl.get("/t/qa", cookies={QA_COOKIE: cookie})
        assert r.status_code == 200 and r.json() == {"name": "검수자A", "role": "qa_gate", "jobs": 21}
        # 역할·메뉴 게이트(좁히기 전용)
        assert (await cl.get("/t/admin", headers=h)).status_code == 403
        assert (await cl.get("/t/admin", headers={"Authorization": f"Bearer {token(ADMIN)}"})).status_code == 200
        assert (await cl.get("/t/admin-menu", headers=h)).json()["error"]["code"] == "menu_forbidden"   # menu_groups {standard,project}
        assert (await cl.get("/t/admin-menu", headers={"Authorization": f"Bearer {token(KIA_US)}"})).status_code == 200  # NULL = 무제한
        r = await cl.get("/t/qa", cookies={QA_COOKIE: cookie[:-2] + "xx"})
        assert r.status_code == 401


def test_qa_cookie_rules():
    s = new_qa_session("A")
    ck = sign_qa_cookie(s)
    assert verify_qa_cookie(ck).name == "A"
    assert verify_qa_cookie(ck, now=s.issued_at + 12 * 3600 + 5) is None          # 하드 만료 12시간
    assert verify_qa_cookie("a.b.c") is None and verify_qa_cookie(None) is None
    assert check_qa_password("pw-test") and not check_qa_password("pw-tesx") and not check_qa_password("")
