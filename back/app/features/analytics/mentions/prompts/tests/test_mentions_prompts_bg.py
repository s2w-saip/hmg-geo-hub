"""GET /v1/mentions/prompts 값 갭 보강(BG-17 이름·당사 드릴다운, BG-18 하이라이트 표기) 테스트.

기대값은 합성 픽스처 손 계산(back/tests/fixtures/fixture-10-data.sql). 글로벌 스냅샷(회차 11) 경쟁·std_in answer_brand 행:
  k1(p1·chatgpt·US): Hyundai 4(own 1, rk 2)·Toyota 3(rk 1) · k2(p1·gemini·US): Kia 2(own 2, rk 1)·smart 1 · k12(p3·chatgpt·US): Hyundai 1(rk 1)
현대 관점(bgrp 5·8): own → [p1: 4, p3: 1] 합 5. admin(관점 1·2·4): own → [p1: 4 + 2 = 6, p3: 1] 합 7, own_brand_code=Kia → [p1: 2].
기아 US 관점(bgrp 8 = k12 만): 당사(Kia) 행 없음 → 빈 목록.
언급 원본(ing.mention, rd.v_answer_mention_raw)과 엔티티 정본 브랜드(rd.dim_entity → rd.dim_brand_name):
  k1: Hyundai(Brand, 정본 Hyundai) · Toyota(Brand, Toyota) · TOYOTA(Brand, Toyota) · Apple(Brand) · Hyundai Creta(Product, 정본 Hyundai,
      롤업 = Tata 엔티티) · safety(Feature, 롤업 없음)
  k2: 기아(Brand, 정본 Kia) · Smart Fortwo(Product, 정본 smart, 롤업 = smart 엔티티) · smart(Brand)
  k12: Hyundai(Brand)
"""
from __future__ import annotations

import uuid

import pytest

from app.features.analytics.mentions.brands.tests.mentions_testkit import GLOBAL_SNAPSHOT, brand_keys, cycle_row
from app.features.analytics.mentions.prompts.service import build_terms
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, TEST_NAME_KEY, Rows, Update, needs_db, raw_fetch, stage, staged

pytestmark = needs_db
URL = "/v1/mentions/prompts"
P1 = "b0000000-0000-4000-8000-000000000001"
P3 = "b0000000-0000-4000-8000-000000000003"
J1 = "90000000-0000-4000-8000-000000000001"
J2 = "90000000-0000-4000-8000-000000000002"
J12 = "90000000-0000-4000-8000-000000000012"


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _items(d):
    return [(i["prompt_id"], i["count"]) for i in d["items"]]


def _terms(d):
    return {a["job_id"]: a["terms"] for i in d["items"] for a in i["answers"]}


# ── BG-17 이름으로 드릴다운 ──────────────────────────────────────────────────
async def test_mention_brand_equals_brand_key(client_as, ro):
    k = await brand_keys(ro, ["Toyota", "Kia"])
    by_key = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=k["Toyota"])).json()
    # 표기 일치 우선, 없으면 대소문자 무시 일치. 끔: 'TOYOTA' 도 Toyota 행(bare 소문자 하나). 현행 프로필 NAME: 'TOYOTA' 는 자기 행(운영 생성기처럼
    # 표기별 표시 브랜드)이라 표기 일치로 그 행, 'toyota' 는 대소문자 무시 후보 둘('Toyota'·'TOYOTA') 중 키가 작은 행
    for name in ("Toyota", "toyota") if TEST_NAME_KEY else ("Toyota", "toyota", "TOYOTA"):
        r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand=name)
        assert r.status_code == 200, r.text
        if name == "toyota" and TEST_NAME_KEY:
            k2 = await brand_keys(ro, ["Toyota", "TOYOTA"])
            pick = min(k2.items(), key=lambda kv: kv[1])
            want = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=pick[1])).json()
            assert r.json()["data"] == want["data"] and r.json()["data"]["target"] == {"brand_key": pick[1], "name": pick[0], "signal": None}
            continue
        assert r.json()["data"] == by_key["data"] and r.json()["data"]["target"] == {"brand_key": k["Toyota"], "name": "Toyota", "signal": None}
    if TEST_NAME_KEY:
        up = (await brand_keys(ro, ["TOYOTA"]))["TOYOTA"]
        r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="TOYOTA")
        assert r.status_code == 200 and r.json()["data"]["target"] == {"brand_key": up, "name": "TOYOTA", "signal": None}, r.text
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Kia")).json()["data"]
    assert _items(d) == [(P1, 2)] and d["total"] == 2                     # 형제 HMG 브랜드도 이름으로 드릴다운(경쟁 행)
    r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Nope Motors")
    assert r.status_code == 404 and r.json()["error"]["code"] == "brand_not_found"


async def test_mention_brand_filters_and_scope(client_as):
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Toyota", engine="gemini")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                            # 필터 적용(Toyota 는 chatgpt k1 에만)
    d = (await _get(client_as, KIA_US, surface="global", mode="brand", mention_brand="Toyota")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                            # 기아 US 모수(k12) 밖: 누출 없음


# ── BG-17 당사 행 드릴다운 ───────────────────────────────────────────────────
async def test_own_mode_values(client_as, ro):
    k = await brand_keys(ro, ["Hyundai"])
    r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["target"] == {"brand_key": None, "name": "Hyundai", "signal": None, "own": True}
    assert _items(d) == [(P1, 4), (P3, 1)] and d["total"] == 5
    by_key = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=k["Hyundai"])).json()["data"]
    assert d["items"] == by_key["items"]                                    # 단일 관점: 당사 행 = 그 브랜드 행
    async with client_as(HQ_HYUNDAI) as c:
        m1 = (await c.get("/v1/mentions/brands", params={"surface": "global"})).json()["data"]
    assert d["total"] == m1["own"]["mentions"]                              # 불변식: 당사 드릴다운 합 = M-1 당사 언급


async def test_own_mode_multi_viewpoint_and_code(client_as):
    d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true")).json()["data"]
    assert d["target"] == {"brand_key": None, "name": "HMG", "signal": None, "own": True}
    assert _items(d) == [(P1, 6), (P3, 1)] and d["total"] == 7
    p1 = d["items"][0]
    assert sorted((a["job_id"], a["engine"], a["value"], a["position"]) for a in p1["answers"]) == [
        (J1, "chatgpt", 4, 2), (J2, "gemini", 2, 1)]
    d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code="Kia")).json()["data"]
    assert d["target"] == {"brand_key": None, "name": "Kia", "signal": None, "own": True, "own_brand_code": "Kia"}
    assert _items(d) == [(P1, 2)] and d["total"] == 2
    # split_own 행과 같은 합(M-1 split_own 의 Kia 행 언급)
    async with client_as(ADMIN) as c:
        m1 = (await c.get("/v1/mentions/brands", params={"surface": "global", "split_own": "true"})).json()["data"]
    assert {b["own_brand_code"]: b["mentions"] for b in m1["brands"] if b["is_own"]} == {"Hyundai": 5, "Kia": 2, "Genesis": 0}
    for code, total in (("Hyundai", 5), ("Genesis", 0)):
        d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code=code)).json()["data"]
        assert d["total"] == total, code


async def test_own_brand_code_only_split_keys(client_as):
    """D-3 회귀(a): own_brand_code 는 split_own 행 키만 받는다. ADMIN 행 키는 Hyundai·Kia·Genesis 라 'Hyundai N'(관점 안 하위 브랜드)은
    예전처럼 비트 1(Hyundai) 값 8·이름표 'Hyundai N' 으로 답하지 않고 빈 목록이다. 단일 관점(가른 행 없음)도 빈 목록, 브랜드 코드가 아니면 422."""
    async with client_as(ADMIN) as c:
        m1 = (await c.get("/v1/mentions/brands", params={"surface": "global", "split_own": "true"})).json()["data"]
    keys = [b["own_brand_code"] for b in m1["brands"] if b["is_own"]]
    assert sorted(keys) == ["Genesis", "Hyundai", "Kia"]
    for code in keys:                                                      # 행 키는 전부 받는다
        r = await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code=code)
        assert r.status_code == 200 and r.json()["data"]["target"]["own_brand_code"] == code
    d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code="Hyundai N")).json()["data"]
    assert d["items"] == [] and d["total"] == 0 and d["target"]["own_brand_code"] == "Hyundai N"
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true", own_brand_code="Hyundai")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                            # 단일 관점: split 행 키 없음
    r = await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code="Nope")
    assert r.status_code == 422


@pytest.mark.parametrize("extra", [{"own": "true"}, {"mention_brand": "Kia"}, {"own": "true", "own_brand_code": "Kia"}])
async def test_signal_mode_rejects_brand_targets(client_as, extra):
    """D-3 회귀(b): mode=signal 에 own·mention_brand 가 오면 조용히 무시하지 않고 422."""
    r = await _get(client_as, ADMIN, surface="global", mode="signal", signal="positive", **extra)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (extra, r.text)
    assert (await _get(client_as, ADMIN, surface="global", mode="signal", signal="positive")).status_code == 200


async def test_own_mode_scope_and_filters(client_as):
    d = (await _get(client_as, KIA_US, surface="global", mode="brand", own="true")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                            # 기아 US 모수(k12)에 당사 행 없음(k2 기아 행은 모수 밖)
    d = (await _get(client_as, KIA_US, surface="global", mode="brand", own="true", own_brand_code="Hyundai")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                            # 관점 밖 코드 = 빈 목록(형제 당사 행 누출 없음)
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true", engine="gemini")).json()["data"]
    assert d["items"] == []                                                # 필터 적용(현대 당사 행은 chatgpt 에만)
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true", **{"from": "2025-01-01", "to": "2025-01-31"})).json()
    assert d["data"]["items"] == [] and d["meta"]["cycles"] == []


async def test_own_mode_excludes_non_competitive_rows(client_as):
    """당사 타깃은 경쟁 행(competitive)만 센다: k12 에 같은 당사 브랜드의 비경쟁 행(언급 5)을 롤백 준비로 더해도 [p1: 4, p3: 1] 그대로."""
    async with staged() as conn:
        cyc = await cycle_row(conn, 1, GLOBAL_SNAPSHOT)
        row = dict((await raw_fetch(conn, "SELECT * FROM rd.answer_brand WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) "
                                          "AND answer_key = 12 AND competitive", GLOBAL_SNAPSHOT, [cyc.cyc_key]))[0])
        await stage(conn, Rows("rd.answer_brand", [{**row, "competitive": False, "rk": 0, "mention_count": 5}]))
        d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true")).json()["data"]
        assert _items(d) == [(P1, 4), (P3, 1)] and d["total"] == 5


@pytest.mark.parametrize("params", [
    {"mode": "brand"},                                                     # 타깃 없음
    {"mode": "brand", "brand_key": 1, "own": "true"},                      # 타깃 둘
    {"mode": "brand", "brand_key": 1, "mention_brand": "Kia"},
    {"mode": "brand", "mention_brand": "Kia", "own": "true"},
    {"mode": "brand", "brand_key": 1, "own_brand_code": "Kia"},            # own_brand_code 는 own=true 와만
    {"mode": "signal", "signal": "positive", "own_brand_code": "Kia"},
    {"mode": "signal", "signal": "positive", "own": "true"}, {"mode": "signal", "signal": "positive", "mention_brand": "Kia"},
    {"mode": "brand", "mention_brand": ""}, {"mode": "brand", "mention_brand": "a\x01"}, {"mode": "brand", "mention_brand": "x" * 101},
    {"mode": "brand", "own": "true", "own_brand_code": "Nope"},            # 모르는 브랜드 코드
    {"mode": "brand", "own": "maybe"}, {"mode": "brand", "brand_key": 1, "terms": "nope"},
    {"mode": "brand", "brand_key": 1, "terms": "true", "limit": 201},  # 필드 상한(limit ≤ 200, answers_limit ≤ 50)
    {"mode": "brand", "brand_key": 1, "terms": "true", "answers_limit": 51}])
async def test_bad_params_422(client_as, params):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (params, r.text)


# ── BG-18 하이라이트 표기 ────────────────────────────────────────────────────
async def test_terms_brand_targets(client_as):
    assert "terms" not in (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Toyota")).json()[
        "data"]["items"][0]["answers"][0]                                  # 요청하지 않으면 필드 없음
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Toyota", terms="true")).json()["data"]
    assert _terms(d) == {J1: {"brand": ["Toyota", "TOYOTA"], "model": []}}          # 정본 Toyota 로 접히는 두 표기
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="smart", terms="true")).json()["data"]
    assert _terms(d) == {J2: {"brand": ["smart"], "model": ["Smart Fortwo"]}}       # 롤업 = smart 엔티티인 모델
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Kia", terms="true")).json()["data"]
    assert _terms(d) == {J2: {"brand": ["Kia", "기아"], "model": []}}               # 별칭 표기(정본 Kia)
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Hyundai", terms="true")).json()["data"]
    # Hyundai Creta(정본 Hyundai, 롤업 = Tata)는 롤업이 Hyundai 가 아니라 모델 표기가 아니다(현행 highlightTermsForBrand 와 같다, 검증 D3)
    assert _terms(d) == {J1: {"brand": ["Hyundai"], "model": []}, J12: {"brand": ["Hyundai"], "model": []}}


async def test_terms_with_adapter_page_size(client_as, monkeypatch):
    """어댑터 브랜드 드릴다운 요청(limit 200 × answers_limit 50, terms=true)은 받는다 — 언급 원본 뷰는 TERMS_MAX_REFS 씩
    나눠 읽고, 배치 크기와 무관하게 같은 표기가 나온다(종전 422 회귀, 2026-10-14)."""
    from app.features.analytics.mentions.prompts import schemas as prompt_schemas
    q = dict(surface="global", mode="brand", mention_brand="Hyundai", terms="true", limit=200, answers_limit=50)
    r = await _get(client_as, HQ_HYUNDAI, **q)
    assert r.status_code == 200, r.text
    whole = _terms(r.json()["data"])
    assert whole == {J1: {"brand": ["Hyundai"], "model": []}, J12: {"brand": ["Hyundai"], "model": []}}
    monkeypatch.setattr(prompt_schemas, "TERMS_MAX_REFS", 1)            # 답변 하나씩 나눠 읽어도 같다
    assert _terms((await _get(client_as, HQ_HYUNDAI, **q)).json()["data"]) == whole


async def test_terms_own_and_signal_targets(client_as):
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", own="true", terms="true")).json()["data"]
    assert _terms(d) == {J1: {"brand": ["Hyundai"], "model": []}, J12: {"brand": ["Hyundai"], "model": []}}
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="signal", signal="positive", terms="true")).json()["data"]
    assert _terms(d) == {J1: {"brand": ["Hyundai"], "model": []}, J12: {"brand": ["Hyundai"], "model": []}}
    d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true", own_brand_code="Kia", terms="true")).json()["data"]
    assert _terms(d) == {J2: {"brand": ["Kia", "기아"], "model": []}}


async def test_terms_own_seeds_only_present_brands(client_as):
    """D-4 회귀: 다중 관점 당사·신호 타깃의 씨앗(관점 코드 Hyundai·Kia·Genesis·Hyundai N)은 그 답변에 정본 브랜드로 나온 것만 넣는다.
    예전에는 J1 brand 가 ['Hyundai', 'Kia', 'Genesis', 'Hyundai N'] 로 답변에 없는 표기가 상한 8칸 중 4칸을 먼저 차지했다."""
    want = {J1: {"brand": ["Hyundai"], "model": []}, J2: {"brand": ["Kia", "기아"], "model": []},
            J12: {"brand": ["Hyundai"], "model": []}}
    d = (await _get(client_as, ADMIN, surface="global", mode="brand", own="true", terms="true")).json()["data"]
    assert _terms(d) == want
    d = (await _get(client_as, ADMIN, surface="global", mode="signal", signal="positive", terms="true")).json()["data"]
    assert _terms(d) == want                                               # 당사 s_pos: k1 Hyundai·k2 Kia·k12 Hyundai


async def test_terms_surfaces_from_mention_raw(client_as):
    """표면 표기(ing.mention.surfaces)는 픽스처에 없어 롤백 준비로 넣는다: k1 Toyota(ord 2) = ['Toyota', 'toyota', ' x'],
    Hyundai Creta(ord 5) = ['Creta', 'TOYOTA']. 기대(행 순서 = ord, 행마다 표시명 → 표면 표기): Toyota 타깃 brand = Toyota(ord 2 표시명) →
    toyota(ord 2 표면, ' x' 는 2자 미만 제외) → TOYOTA(ord 3 표시명). Hyundai 타깃 model = [](Creta 는 롤업이 Tata 라 현행과 같이 칠하지
    않는다, 검증 D3. 롤업 연결 모델 표기는 smart 타깃의 Smart Fortwo 로 본다)."""
    steps = [Update("ing.mention", {"job_id": uuid.UUID(J1), "ord": 2}, {"surfaces": ["Toyota", "toyota", " x"]}),
             Update("ing.mention", {"job_id": uuid.UUID(J1), "ord": 5}, {"surfaces": ["Creta", "TOYOTA"]})]
    async with staged(*steps):
        d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Toyota", terms="true")).json()["data"]
        assert _terms(d) == {J1: {"brand": ["Toyota", "toyota", "TOYOTA"], "model": []}}
        d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", mention_brand="Hyundai", terms="true")).json()["data"]
        assert _terms(d)[J1] == {"brand": ["Hyundai"], "model": []}


def test_build_terms_rules():
    """규칙 단위 시험: 2자 미만 제외·중복 제거·brand 우선(모델에서 뺀다)·롤업 id 연결·상한."""
    rows = [
        {"entity_type": "Brand", "display_name": "Acme", "surfaces": ["ACME", "a"], "entity_id": "e1", "e_bk": 7, "e_own": 0},
        {"entity_type": "Product", "display_name": "Acme One", "surfaces": ["Acme", "One X"], "entity_id": "e2", "rollup_id": "e1"},
        {"entity_type": "Product", "display_name": "Other", "surfaces": [], "entity_id": "e3", "rollup_id": "e9", "r_bk": 8},
        {"entity_type": "Brand", "display_name": "Acme", "surfaces": [], "entity_id": "e4", "e_bk": None},
    ]
    t = build_terms(rows, brand_key=7, name="Acme", bits=(), seeds=["Acme"])
    assert t.brand == ["Acme", "ACME"] and t.model == ["Acme One", "One X"]
    many = [{"entity_type": "Brand", "display_name": f"N{i:02d}", "surfaces": [], "entity_id": f"b{i}", "e_bk": 7} for i in range(20)]
    many += [{"entity_type": "Product", "display_name": f"M{i:02d}", "surfaces": [], "entity_id": f"m{i}", "rollup_id": "b0"} for i in range(40)]
    t = build_terms(many, brand_key=7, name=None, bits=(), seeds=[])
    assert len(t.brand) == 8 and len(t.model) == 24
    assert build_terms([], brand_key=None, name=None, bits=(1,), seeds=["Hyundai", "N"]).model_dump() == {"brand": ["Hyundai"], "model": []}
    # seeds_if_present: 타깃 Brand 행 정본 이름(e_name)에 있는 씨앗만. 없는 씨앗은 상한을 먹지 않는다(D-4)
    own_rows = [{"entity_type": "Brand", "display_name": f"H{i:02d}", "surfaces": [], "entity_id": f"h{i}", "e_bk": 1, "e_own": 1,
                 "e_name": "Hyundai"} for i in range(7)]
    t = build_terms(own_rows, brand_key=None, name=None, bits=(1, 2), seeds=["Hyundai", "Kia", "Genesis", "Hyundai N"], seeds_if_present=True)
    assert t.brand == ["Hyundai"] + [f"H{i:02d}" for i in range(7)]
    t = build_terms(own_rows, brand_key=None, name=None, bits=(1, 2), seeds=["Hyundai", "Kia", "Genesis", "Hyundai N"])
    assert t.brand[:4] == ["Hyundai", "Kia", "Genesis", "Hyundai N"] and len(t.brand) == 8           # 옛 동작(비교용): 4칸 선점
