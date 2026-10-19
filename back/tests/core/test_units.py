"""core 단위 테스트(DB 없음): sqlb·codes·config·errors·envelope·pagination·cycles(build_window)·measure(순수 빌더)."""
from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core import errors
from app.core.codes import HIDDEN_EXCLUDE, Brand, OwnedBase, Refs, brand_masks, parse_refs
from app.core.config import Settings, load_settings
from app.core.cycles import CycleRow, build_window
from app.core.envelope import Envelope, Meta, Ratio, build_meta, ratio_or_none
from app.core.measure import (
    CountsPlan,
    MeasureScope,
    OwnerScope,
    allowed_owner_keys,
    applied_prompts_sql,
    citation_counts_sql,
    competitor_rows_sql,
    fold_url_rates,
    lc_key,
    merge_counts,
    own_cols,
    plan_counts,
    rank_brand_items,
    ratios,
    tone_expr,
)
from app.core.pagination import Cursor, clamp_limit, decode_cursor, encode_cursor, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder, Sql, render_literals


# ── sqlb ─────────────────────────────────────────────────────────────────────
def test_binder_and_render():
    b = Binder("p")
    t = f"x = ANY({b.ints([3, 1, 3], 'int2')}) AND d = {b.date(date(2026, 9, 14))} AND s = {b.v("a'b")} AND t::date IS NOT NULL"
    q = b.sql(t)
    assert q.params == {"p0": [1, 3], "p1": date(2026, 9, 14), "p2": "a'b"}
    assert render_literals(q) == "x = ANY(CAST('{1,3}' AS int2[])) AND d = CAST('2026-09-14' AS date) AND s = 'a''b' AND t::date IS NOT NULL"
    with pytest.raises(ValueError):
        render_literals(Sql("x = :a", {"a": ["x", 1]}))


def test_brand_masks():
    assert brand_masks(1 | 8, 31) == [m for m in range(1, 32) if m & 9]
    assert 16 not in brand_masks(1 | 8, 31)
    assert brand_masks(2, 7) == [2, 3, 6, 7]


def _refs() -> Refs:
    return parse_refs({
        "brands": [{"code": "Hyundai", "bit": 1, "umb": False, "parent": None, "ord": 1},
                   {"code": "Kia", "bit": 2, "umb": False, "parent": None, "ord": 2},
                   {"code": "Genesis", "bit": 4, "umb": False, "parent": None, "ord": 3},
                   {"code": "HMG", "bit": 8, "umb": True, "parent": None, "ord": 4},
                   {"code": "Hyundai N", "bit": 16, "umb": False, "parent": "Hyundai", "ord": 5}],
        "owned": [], "engines": [{"k": 1, "code": "chatgpt", "d": True}], "countries": [{"k": 174, "code": "us", "kind": "iso", "r": None, "vb": None, "h": False}],
        "langs": [{"k": 2, "code": "EN"}], "rhq": [{"id": "kia-europe", "brand": "Kia", "cc": ["DE", "FR"]}], "cats": [], "projects": []})


def test_refs_parse_and_fold():
    r = _refs()
    assert r.umbrella_bit == 8 and r.bit_universe == 31
    assert r.own_bit_of("Hyundai N") == 1 and r.own_bit_of("HMG") is None and r.own_bit_of("Kia") == 2
    assert r.countries["US"].geo_key == 174 and r.langs["en"] == 2
    assert r.region_countries(["kia-europe"]) == ["DE", "FR"]
    assert [b.code for b in r.real_brands] == ["Hyundai", "Kia", "Genesis", "Hyundai N"]


# ── config ───────────────────────────────────────────────────────────────────
def test_config_secrets_not_printed():
    fake_url = "postgresql://u:" + "SECRETPW" + "@h/db"          # 가짜 값(스캐너 오탐 방지로 나눠 씀)
    s = load_settings({"HGH_ENV": "test", "HGH_DB_URL": fake_url, "HGH_QA_PASSWORD": "qa-SECRET"})
    assert "SECRETPW" not in repr(s) and "SECRETPW" not in str(s) and "qa-SECRET" not in repr(s)
    assert "SECRETPW" not in s.model_dump_json()
    assert s.url_for("api_ro").get_secret_value().endswith("/db")


def test_config_prod_requires_jwks_and_qa_secret():
    with pytest.raises(ValueError):
        load_settings({"HGH_ENV": "prod"})
    with pytest.raises(ValueError):
        load_settings({"HGH_ENV": "stg", "HGH_JWKS_URL": "https://x/jwks", "HGH_QA_ENABLED": "1"})
    s = load_settings({"HGH_ENV": "stg", "HGH_JWKS_URL": "https://x/jwks", "HGH_JWT_ISSUER": "https://x/auth/v1",
                       "HGH_DB_URL_API_RO": "postgresql://ro@h/db"})
    assert s.url_for("api_ro") is not None and s.url_for("api_rw") is None
    assert not load_settings({"HGH_ENV": "local", "HGH_DB_ASSUME_ROLE": "0"}).db_assume_role


# ── errors·envelope ──────────────────────────────────────────────────────────
def test_error_handlers_shape():
    app = FastAPI()
    errors.install_error_handlers(app)

    @app.get("/boom")
    async def boom(kind: str = Query(...)):
        if kind == "api":
            raise errors.conflict("lock_held", "잠김", {"held_by": "x"})
        raise RuntimeError("secret detail must not leak")

    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/boom", params={"kind": "api"})
    assert r.status_code == 409 and r.json() == {"error": {"code": "lock_held", "message": "잠김", "details": {"held_by": "x"}}}
    r = c.get("/boom")
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"
    r = c.get("/boom", params={"kind": "x"})
    assert r.status_code == 500 and "secret" not in r.text and r.json()["error"]["code"] == "internal"
    r = c.get("/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_envelope_meta():
    w = build_window(surface="global", mode="snapshot", rows=[CycleRow(11, 1, date(2026, 9, 14), 0)], lo=date(2026, 9, 14),
                     hi=date(2026, 9, 14), generation=3, project_keys=(1,))
    m = build_meta(mode="snapshot", window=w, suppressed={"citation_share": "hidden"})
    assert m.cycles == [date(2026, 9, 14)] and m.generation == 3 and m.surface == "global" and m.as_of == date(2026, 9, 14)
    e = Envelope[Ratio](data=Ratio(num=1, den=2), meta=m).model_dump(mode="json")
    assert e["data"] == {"num": 1, "den": 2} and e["meta"]["suppressed"] == {"citation_share": "hidden"}
    assert ratio_or_none(1, 0) is None
    assert "cyc_key" not in Meta.model_json_schema()["properties"]


# ── pagination ───────────────────────────────────────────────────────────────
def test_cursor_roundtrip_and_errors():
    fh = filter_hash({"surface": "global", "country": ["US"]})
    tok = encode_cursor(Cursor(sort="measured_at", dir="desc", key=(date(2026, 9, 14), 42), fh=fh, g=7))
    c = decode_cursor(tok, sort="measured_at", dir="desc", fh=fh, types=("date", "int4"), generation=7)
    assert c is not None and c.key == (date(2026, 9, 14), 42)
    assert decode_cursor(None, sort="x", dir="asc", fh=fh, types=("int4",)) is None
    with pytest.raises(errors.ApiError) as e:
        decode_cursor(tok, sort="measured_at", dir="desc", fh=filter_hash({"surface": "website"}), types=("date", "int4"), generation=7)
    assert e.value.status == 422 and e.value.code == "cursor_invalid"
    with pytest.raises(errors.ApiError) as e:
        decode_cursor(tok, sort="measured_at", dir="desc", fh=fh, types=("date", "int4"), generation=8)
    assert e.value.status == 409 and e.value.code == "cursor_stale"
    with pytest.raises(errors.ApiError) as e:
        decode_cursor("not-base64!!", sort="measured_at", dir="desc", fh=fh, types=("date", "int4"))
    assert e.value.code == "cursor_invalid"
    b = Binder()
    assert keyset_predicate(["a.x", "a.k"], "desc", c, b) == "(a.x, a.k) < (:p0, :p1)"
    page, nxt = keyset_page([1, 2, 3], 2, lambda r: (r,), sort="s", dir="asc", fh=fh)
    assert page == [1, 2] and decode_cursor(nxt, sort="s", dir="asc", fh=fh, types=("int4",)).key == (2,)
    with pytest.raises(errors.ApiError):
        clamp_limit(0)


# ── cycles(순수) ─────────────────────────────────────────────────────────────
def test_build_window_hidden_families():
    rows = [CycleRow(21, 2, date(2026, 9, 18), 2), CycleRow(22, 3, date(2026, 9, 18), 0), CycleRow(23, 4, date(2026, 9, 18), 1)]
    w = build_window(surface="website", mode="snapshot", rows=rows, lo=date(2026, 9, 18), hi=date(2026, 9, 18), generation=1,
                     project_keys=(2, 3, 4, 5), project_ids={5: "site-5"})
    assert w.cyc_keys("mentions") == (21, 22) and w.cyc_keys("citations") == (22,) and w.cyc_keys("row") == (21, 22)
    assert w.missing_project_keys == (4, 5) and w.missing_project_ids == ("site-5",)
    b = Binder()
    assert w.where("a", "citations", b)[1] == "a.round_date = CAST(:p1 AS date)"
    hid = build_window(surface="website", mode="snapshot", rows=[rows[0]], lo=date(2026, 9, 18), hi=date(2026, 9, 18), generation=1,
                       project_keys=(2,))
    assert hid.hidden("citations") and not hid.hidden("mentions")
    empty = build_window(surface="global", mode="snapshot", rows=[], lo=None, hi=None, generation=1, project_keys=(1,))
    assert empty.empty and empty.where("a", "mentions", Binder()) == ["false"]
    assert HIDDEN_EXCLUDE["mentions"] == {1, 3}


# ── measure(순수) ────────────────────────────────────────────────────────────
BASES = [OwnedBase(1, "base", "hyundaiusa.com/us/en", "Hyundai", "US", "en"), OwnedBase(2, "base", "hyundai.com/au/en", "Hyundai", "AU", "en"),
         OwnedBase(3, "base", "hyundaicanada.com/fr", "Hyundai", "CA", "fr"), OwnedBase(4, "base", "kia.com/de", "Kia", "DE", "de"),
         OwnedBase(5, "base", "worldwide.kia.com/en", "Kia", None, "en")]
OWN = {"Hyundai": 1, "Kia": 2, "Genesis": 4}


def test_allowed_owner_keys_rules():
    s = allowed_owner_keys(BASES, {"Hyundai"}, OWN, None, None)
    assert s.keys == (1, 2, 3) and s.mode == "brand" and s.own_bits == (1,)
    s = allowed_owner_keys(BASES, {"Hyundai"}, OWN, ["us"], None)
    assert s.keys == (1,) and s.mode == "country1"
    s = allowed_owner_keys(BASES, {"Hyundai"}, OWN, ["US", "AU"], None)
    assert s.keys == (1, 2) and s.mode == "countryN"
    s = allowed_owner_keys(BASES, {"Hyundai"}, OWN, ["ZZ"], None)        # 좁힌 결과가 비면 안 좁힘
    assert s.keys == (1, 2, 3) and s.mode == "brand"
    s = allowed_owner_keys(BASES, {"Hyundai"}, OWN, ["CA"], ["fr"])      # 국가 → 언어 순서로 좁힘
    assert s.keys == (3,) and s.mode == "scan"
    s = allowed_owner_keys(BASES, {"Genesis"}, OWN, None, None)           # 베이스 없는 관점 → 전체(공집합 방지)
    assert s.keys == (1, 2, 3, 4, 5) and s.own_bits == (1, 2)
    s = allowed_owner_keys(BASES, {"Hyundai", "Kia"}, OWN, None, None)
    assert s.own_bits == (1, 2)


def test_own_cols_and_tone():
    one = own_cols([2])
    assert one.mask == 2 and one.ment == "(a.ment_k)" and one.rank == "a.own_rk_k" and one.ranked == "a.own_rk_k > 0"
    hmg = own_cols([4, 1, 2])
    assert hmg.mask == 7 and hmg.rank == "LEAST(NULLIF(a.own_rk_h, 0), NULLIF(a.own_rk_k, 0), NULLIF(a.own_rk_g, 0))"
    with pytest.raises(ValueError):
        own_cols([8])
    pos, neg = tone_expr([1])
    assert pos == "((a.sent_pos_h) > (a.sent_neg_h))" and neg == "((a.sent_neg_h) > (a.sent_pos_h))"


def _win(hidden: int = 0, sf: str = "global") -> object:
    return build_window(surface=sf, mode="snapshot", rows=[CycleRow(11, 1, date(2026, 9, 14), hidden)], lo=date(2026, 9, 14),
                        hi=date(2026, 9, 14), generation=1, project_keys=(1,))


def _ms(mode_countries=None, langs=None, sf=1) -> MeasureScope:
    owner = allowed_owner_keys(BASES, {"Hyundai"}, OWN, mode_countries, langs) if sf == 1 else None
    return MeasureScope(sf=sf, project_keys=(1,), own_bits=(1,), bgrps=(1, 8, 9), pop_bits=(1, 8), owner=owner)


def test_plan_counts_modes():
    p = plan_counts(_ms(), _win())
    assert [r for r, _ in p.statements] == ["main"]
    t = p.statements[0][1].text
    assert "FROM rd.answer a" in t and "rd.citation" not in t and "a.cit_own_h" in t and "a.cit_in" in t
    assert "a.surface = CAST(" in t and "a.round_date = CAST(" in t and "a.cyc_key = ANY(" in t and "a.dflt" in t
    assert "a.own_mask & 1" in t.replace("(", "").replace(")", "")
    assert "cit_own_hc" in plan_counts(_ms(["US"]), _win()).statements[0][1].text
    pn = plan_counts(_ms(["US", "AU"]), _win())
    assert [r for r, _ in pn.statements] == ["main", "cross"]
    assert "a.cit_own_x = 0" in pn.statements[0][1].text and "a.cit_own_x > 0" in pn.statements[1][1].text
    assert "c.owner_key = ANY(" in pn.statements[1][1].text and "c.round_date = CAST(" in pn.statements[1][1].text
    ps = plan_counts(_ms(["CA"], ["fr"]), _win())
    assert [r for r, _ in ps.statements] == ["main", "scan"] and "cit_total" not in ps.statements[0][1].text
    # countryN + 출처 축: scan 이 교차 국가 자사까지 정확히 세므로 cross 를 내지 않는다(같이 내면 출처 밖 자사가 이중으로 더해진다)
    pns = plan_counts(replace(_ms(["US", "AU"]), source_category_keys=(6,)), _win())
    assert [r for r, _ in pns.statements] == ["main", "scan"]
    pw = plan_counts(MeasureScope(sf=2, project_keys=(2,), own_bits=(2,), bgrps=(2,)), _win(sf="website"), parts=("citations",))
    assert "a.cit_loc_tgt" in pw.statements[0][1].text
    pp = plan_counts(MeasureScope(sf=3, project_keys=(3,), own_bits=(1,), bgrps=None), _win(sf="project"), parts=("citations",))
    assert "sum(a.cit_loc)" in pp.statements[0][1].text and "a.bgrp" not in pp.statements[0][1].text
    with pytest.raises(ValueError):
        plan_counts(_ms(), _win(), group_by=("bogus",))
    with pytest.raises(ValueError):
        plan_counts(MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1,)), _win(), parts=("citations",))
    with pytest.raises(ValueError):
        plan_counts(_ms(), _win(), parts=("nope",))


def test_plan_counts_family_split():
    rows = [CycleRow(11, 1, date(2026, 9, 14), 0), CycleRow(12, 2, date(2026, 9, 14), 2)]
    w = build_window(surface="global", mode="snapshot", rows=rows, lo=date(2026, 9, 14), hi=date(2026, 9, 14), generation=1,
                     project_keys=(1, 2))
    t = plan_counts(_ms(), w).statements[0][1]
    # 계열 키가 다르면 WHERE 는 합집합, FILTER 로 계열 분리
    assert t.params["m2"] == [11, 12] or [11, 12] in t.params.values()
    assert "FILTER (WHERE a.std_in AND a.cyc_key = ANY(" in t.text


def test_merge_counts():
    plan = CountsPlan(group_names=("round_date",), statements=[("main", Sql("")), ("cross", Sql(""))], parts=("citations",))
    main = [{"round_date": date(2026, 9, 7), "cit_total": 5, "cit_owned": 1, "cit_target": 0, "cit_m05": 3},
            {"round_date": date(2026, 9, 14), "cit_total": 9, "cit_owned": 0, "cit_target": 0, "cit_m05": 4}]
    cross = [{"round_date": date(2026, 9, 14), "cit_cross": 2}]
    out = merge_counts(plan, [main, cross])
    # cross(교차 국가 자사 원소)는 cit_owned 만 보정한다. 글로벌 M05 분자 cit_m05(공식(HMG) 카테고리 답변 열)는 국가로 좁히지 않아 보정이 없다
    assert out == [{"round_date": date(2026, 9, 7), "cit_total": 5, "cit_owned": 1, "cit_target": 0, "cit_m05": 3},
                   {"round_date": date(2026, 9, 14), "cit_total": 9, "cit_owned": 2, "cit_target": 0, "cit_m05": 4}]
    assert ratios(out[1])["citation_share"] == (4, 9)                  # 분자 = cit_m05(cit_owned 가 아님, 동기화 S1 BE-B)
    with pytest.raises(KeyError):
        ratios({"cit_total": 9, "cit_owned": 2})                         # 분자 열 없이 손으로 합친 행은 조용히 넘어가지 않는다
    empty = merge_counts(CountsPlan(group_names=(), statements=[("main", Sql(""))], parts=("mentions",)), [[]])
    assert empty[0]["answers"] == 0 and empty[0]["ranked"] == 0


def test_citation_and_brand_sql_shapes():
    q = citation_counts_sql(_ms(["US"]), _win(), group_by=("source",))
    assert "FROM rd.citation c" in q.text and "c.source_key <> 0" in q.text and "c.cit_in" in q.text and "c.owner_key = ANY(" in q.text
    q = competitor_rows_sql(_ms(), _win())
    assert "NOT (b.own_bit = ANY(" in q.text and "b.competitive" in q.text and "LIMIT" not in q.text and "own_bit = 0" not in q.text
    q = applied_prompts_sql(_ms())
    assert "rd.catalog_entry" in q.text and q.params["a0"] == [1, 8]


def test_rank_and_url_fold():
    items = [{"name": "Toyota", "mentions": 3}, {"name": "Hyundai", "mentions": 5}, {"name": "kia", "mentions": 2},
             {"name": "Kia", "mentions": 2}, {"name": "Ábc", "mentions": 2}]
    ranked = rank_brand_items(items)
    assert [i["name"] for i in ranked] == ["Hyundai", "Toyota", "Ábc", "kia", "Kia"] and ranked[0]["rank"] == 1
    assert lc_key("a") < lc_key("B")
    w = _win(sf="website")
    live = [{"round_date": date(2026, 9, 14), "tgt_hits": 1, "own_url_hits": 2, "url_den": 4, "tgt_own_hits": 1}]
    rep = [{"round_date": date(2026, 9, 14), "target_hit": 7, "measured": 10, "owned": 8, "owned_den": 10, "slugs": ["r1"],
            "pool_applied": True}]
    assert fold_url_rates(w, live, rep, by_round=True, r09=None)[date(2026, 9, 14)]["origin"] == "report"
    x = fold_url_rates(w, live, rep, by_round=True, r09="engine_axis")[date(2026, 9, 14)]
    assert x["target"] == (1, 4) and x["reason"] == "engine_axis" and x["accuracy"] == (1, 2)
    card = fold_url_rates(w, live, rep, by_round=False, r09=None)[None]
    assert card == {"target": (7, 10), "owned": (8, 10), "origin": "report", "reason": None, "publications": ["r1"],
                    "headline_pool_applied": True, "accuracy": (1, 2),     # 정확도는 발행 회차에서도 라이브(현행 summaryWebsiteCitationAccuracy)
                    "prompts": (10, 7, 8)}                                  # 결정 6: 발행값 프롬프트 단위 (측정, 타겟, 자사)
    nopub = fold_url_rates(w, [{"tgt_hits": 1, "own_url_hits": 2, "url_den": 4, "tgt_own_hits": 1}], [], by_round=False, r09=None)[None]
    assert nopub["origin"] == "live" and nopub["reason"] == "no_publication" and nopub["accuracy"] == (1, 2)
    assert nopub["prompts"] is None                                          # url_prompts part 없이 센 라이브 = 프롬프트 단위 없음
    live_p = [{"tgt_hits": 1, "own_url_hits": 2, "url_den": 4, "tgt_own_hits": 1,
               "url_measured_prompts": 3, "url_target_prompts": 1, "url_owned_prompts": 2}]
    assert fold_url_rates(w, live_p, [], by_round=False, r09=None)[None]["prompts"] == (3, 1, 2)


def test_owner_scope_mode_matrix():
    assert OwnerScope((1,), (1,), None, False, False).mode == "brand"
    assert OwnerScope((1,), (1,), ("US",), True, False).mode == "country1"
    assert OwnerScope((1,), (1,), ("US", "AU"), True, False).mode == "countryN"
    assert OwnerScope((1,), (1,), ("US",), True, True).mode == "scan"


def test_settings_repr_for_pools():
    s = Settings(env="test", db_url=SecretStr("postgresql://x:y@h/d"))
    assert "y@h" not in repr(s)
    assert Brand("HMG", 8, True, None, 4).is_umbrella
