"""analytics.answers.list(GET /v1/answers) 테스트.

기대값은 합성 픽스처(tests/fixtures/fixture-10-data.sql → seed-40)를 손으로 푼 것이다(구현 SQL 복붙 금지).
  global 회차 10(09-07, 노출)·11(09-14, 노출)·12(09-21, 비서빙). 함대 스냅샷 = 11.
  회차 11 std_in ∧ dflt ∧ bgrp≠0 = k1(bgrp5·chatgpt·US)·k2(bgrp5·gemini·US)·k12(bgrp8·chatgpt·US, ACR 1회차).
  회차 11 cit_in 추가분 = k4(bgrp1·KR·gap)·k9(bgrp5·US·분석 실패 gap). k8 은 deepseek(비기본).
  회차 10 은 std_in 0건, cit_in = k16·k17(bgrp5)·k18(bgrp8·gemini).
  answer_brand(std_in): k1 = Toyota(경쟁 3회 rk1, 중립1·부정1)·Hyundai(4회 rk2, 긍정3·중립1)·Apple(비경쟁 1),
                        k2 = Kia(2회 rk1, 긍정1·혼합1)·smart(비경쟁 1 + 경쟁 1 rk2), k12 = Hyundai(1 rk1 긍정1).
  citation(cit_in): k1 = reddit.com 2건(커뮤니티) 외 8건, k5 = bmwusa.com(cit_in 거짓).
  website 회차 21(09-18, 인용 숨김): k21·k22(Kia DE 사이트). project 회차 31(09-20): k31(고객 프로젝트 Hyundai US).
job_id = 90000000-0000-4000-8000-{answer_key 12자리}.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest

from app.core.cycles import CycleRow, build_window
from app.features.analytics.answers.list.queries import like_pattern, normalize_domain
from app.features.analytics.answers.list.service import family_hidden_reason, page_window
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

URL = "/v1/answers"


def jid(k: int) -> str:
    return str(uuid.UUID(f"90000000-0000-4000-8000-{k:012d}"))


def ids(r) -> list[str]:
    return [x["id"] for x in r.json()["data"]["items"]]


# ════════════════════════════════════════════════════════════════════════════
# 순수 함수
# ════════════════════════════════════════════════════════════════════════════
def test_like_pattern_escapes_wildcards():
    assert like_pattern("50%_off\\x") == "%50\\%\\_off\\\\x%"


def test_normalize_domain():
    assert normalize_domain("  WWW.Reddit.com. ") == "reddit.com"
    assert normalize_domain("kia.de") == "kia.de"


def _win(dates: list[date], lo: date, hi: date):
    rows = [CycleRow(100 + i, 1, d, 0) for i, d in enumerate(dates)]
    return build_window(surface="global", mode="cumulative", rows=rows, lo=lo, hi=hi, generation=1, project_keys=(1,))


def test_page_window_slices_92_days_and_skips_empty_ranges():
    d = [date(2026, 1, 5), date(2026, 5, 1), date(2026, 9, 14)]
    w = _win(d, date(2026, 1, 1), date(2026, 9, 30))
    fam = set(w.cyc_keys("row"))
    lo, hi, keys, more = page_window(w, fam, None, slice_days=92)
    assert hi == date(2026, 9, 14) and lo == date(2026, 9, 14) - timedelta(days=91) and keys == (102,) and more
    # 경계 커서(창 상한 = lo - 1일) → 다음 창은 빈 날짜 구간을 건너뛰어 05-01 회차에서 시작
    lo2, hi2, keys2, more2 = page_window(w, fam, lo - timedelta(days=1), slice_days=92)
    assert hi2 == date(2026, 5, 1) and keys2 == (101,) and more2
    lo3, hi3, keys3, more3 = page_window(w, fam, lo2 - timedelta(days=1), slice_days=92)
    assert (hi3, keys3, more3) == (date(2026, 1, 5), (100,), False) and lo3 == date(2026, 1, 1)
    assert page_window(w, fam, lo3 - timedelta(days=1), slice_days=92) is None
    # 창 전체(collapse=cell·스냅샷)
    assert page_window(w, fam, None, slice_days=None)[2] == (100, 101, 102)


# ════════════════════════════════════════════════════════════════════════════
# 권한
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_unauthenticated_and_suspended_401(client_as):
    async with client_as(None) as c:
        assert (await c.get(URL, params={"surface": "global"})).status_code == 401
    async with client_as(SUSPENDED) as c:
        r = await c.get(URL, params={"surface": "global"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


@needs_db
async def test_surface_route_gate(client_as):
    async with client_as(VENDOR) as c:                   # vendor = 표준·웹사이트 경로 밖(route-policy)
        r = await c.get(URL, params={"surface": "global"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    async with client_as(HQ_HYUNDAI) as c:               # 메뉴 그룹 {standard, project}
        r = await c.get(URL, params={"surface": "website"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"


@needs_db
async def test_global_scope_brand_and_country(client_as):
    async with client_as(ADMIN) as c:
        admin = await c.get(URL, params={"surface": "global"})
    async with client_as(HQ_HYUNDAI) as c:
        hq = await c.get(URL, params={"surface": "global"})
    async with client_as(KIA_US) as c:                   # 관점 Kia → bgrp {2,8 포함 마스크}: bgrp5(1|4) 답변 제외
        kia_us = await c.get(URL, params={"surface": "global"})
    async with client_as(KIA_EU) as c:                   # 권역 → DE 등, US 답변 전부 밖
        kia_eu = await c.get(URL, params={"surface": "global"})
    assert ids(admin) == [jid(12), jid(2), jid(1)]
    assert ids(hq) == [jid(12), jid(2), jid(1)]
    assert ids(kia_us) == [jid(12)]
    assert ids(kia_eu) == []
    # 스코프 밖 국가를 요청해도 넓어지지 않는다(dropped)
    async with client_as(KIA_US) as c:
        r = await c.get(URL, params={"surface": "global", "country": ["KR"], "include_gap": "true"})
    assert ids(r) == [] and r.json()["meta"]["dropped_filters"] == {"country": ["KR"]}


@needs_db
async def test_project_membership_and_scope(client_as):
    p = {"surface": "project", "project_id": str(CUST_PROJECT)}
    async with client_as(VENDOR) as c:                   # 활성 멤버
        r = await c.get(URL, params=p)
    assert r.status_code == 200 and ids(r) == [jid(31)]
    async with client_as(HQ_HYUNDAI) as c:               # 비멤버지만 스코프 안(Hyundai·US)
        assert ids(await c.get(URL, params=p)) == [jid(31)]
    async with client_as(KIA_US) as c:                   # 스코프 밖 = 404(존재 은폐)
        assert (await c.get(URL, params=p)).status_code == 404
    async with client_as(VENDOR) as c:
        r = await c.get(URL, params={"surface": "project"})
    assert r.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# 응답 형태·모드·필터
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_snapshot_shape(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "global"})
    assert r.status_code == 200
    body = r.json()
    meta, items = body["meta"], body["data"]["items"]
    assert meta["mode"] == "snapshot" and meta["as_of"] == "2026-09-14" and meta["cycles"] == ["2026-09-14"]
    assert meta["surface"] == "global" and meta["generation"] == 1
    assert meta["page"] == {"next_cursor": None, "limit": 50, "total": None, "window_from": "2026-09-14", "window_to": "2026-09-14"}
    assert "window" not in body["data"]                                          # 창 경계는 meta.page(core Page)
    k1 = next(x for x in items if x["id"] == jid(1))
    assert k1["prompt"]["text"] == "best suv" and k1["engine"] == "chatgpt" and k1["country"] == "US" and k1["lang"] == "en"
    assert k1["mentions"] == {"total": 7, "own": {"count": 4, "rank": 2}}            # 관점 3사: ment_h 4, own_rk_h 2
    assert k1["citations"] == {"has_cit": True, "tgt_cited": False, "own_url_cited": False}
    assert k1["gap"] is False and k1["is_rep"] is False and k1["runs"] is None and k1["matched_brand"] is None
    assert "answer_key" not in k1 and "cyc_key" not in k1
    k2 = next(x for x in items if x["id"] == jid(2))
    assert k2["mentions"]["own"] == {"count": 2, "rank": 1}                          # 관점 3사: ment_k 2, own_rk_k 1
    async with client_as(HQ_HYUNDAI) as c:               # 관점 Hyundai 만: k2 의 Kia 언급은 당사가 아니다
        r = await c.get(URL, params={"surface": "global"})
    k2h = next(x for x in r.json()["data"]["items"] if x["id"] == jid(2))
    assert k2h["mentions"]["own"] == {"count": 0, "rank": None}


@needs_db
async def test_include_gap_and_cumulative_period(client_as, ro):
    async with client_as(ADMIN) as c:
        gap = await c.get(URL, params={"surface": "global", "include_gap": "true"})
        cum = await c.get(URL, params={"surface": "global", "include_gap": "true", "from": "2026-09-01", "to": "2026-09-30"})
    assert ids(gap) == [jid(12), jid(9), jid(4), jid(2), jid(1)]
    k4 = next(x for x in gap.json()["data"]["items"] if x["id"] == jid(4))
    assert k4["gap"] is True and k4["mentions"] is None and k4["country"] == "KR"
    assert ids(cum) == [jid(k) for k in (12, 9, 4, 2, 1, 18, 17, 16)]
    assert cum.json()["meta"]["mode"] == "cumulative" and cum.json()["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    # 독립 SQL 대조: 노출 회차(10·11)의 cit_in ∧ 기본 엔진 ∧ bgrp≠0 답변 수
    from app.core.db import fetch_val
    n = await fetch_val(ro, """
        SELECT count(*) FROM rd.answer a
         WHERE a.surface = 1 AND a.round_date BETWEEN DATE '2026-09-01' AND DATE '2026-09-30' AND a.cyc_key = ANY('{10,11}')
           AND a.cit_in AND a.dflt AND a.bgrp > 0""")
    assert n == len(ids(cum))


@needs_db
async def test_common_filters_change_values(client_as):
    async with client_as(ADMIN) as c:
        eng = await c.get(URL, params={"surface": "global", "engine": ["gemini"]})
        deep = await c.get(URL, params={"surface": "global", "engine": ["deepseek"], "include_gap": "true"})
        kr = await c.get(URL, params={"surface": "global", "country": ["KR"], "include_gap": "true"})
        bad = await c.get(URL, params={"surface": "global", "country": ["ZZ"]})
        ign = await c.get(URL, params={"surface": "global", "lang": ["en"]})
        fun = await c.get(URL, params={"surface": "global", "funnel": ["nope"]})
    assert ids(eng) == [jid(2)]
    assert ids(deep) == [jid(8)]                          # 엔진 지정 시 dflt 대신 engine_key
    assert ids(kr) == [jid(4)]
    assert ids(bad) == [] and bad.json()["meta"]["dropped_filters"] == {"country": ["ZZ"]}
    assert ids(ign) == [jid(12), jid(2), jid(1)] and ign.json()["meta"]["ignored_filters"] == ["lang"]
    assert ids(fun) == [] and fun.json()["meta"]["dropped_filters"] == {"funnel": ["nope"]}


@needs_db
async def test_mention_brand_and_signal(client_as):
    async with client_as(ADMIN) as c:
        toy = await c.get(URL, params={"surface": "global", "mention_brand": "Toyota"})
        smart = await c.get(URL, params={"surface": "global", "mention_brand": "smart"})
        kia = await c.get(URL, params={"surface": "global", "mention_brand": "kia"})      # bare(소문자) 일치
        nope = await c.get(URL, params={"surface": "global", "mention_brand": "NoSuchBrand"})
        pos = await c.get(URL, params={"surface": "global", "signal": "positive"})
        neg = await c.get(URL, params={"surface": "global", "signal": "negative"})
        mix = await c.get(URL, params={"surface": "global", "signal": "mixed"})
    assert ids(toy) == [jid(1)]
    assert toy.json()["data"]["items"][0]["matched_brand"] == {
        "name": "Toyota", "mention_count": 3, "rank": 1, "sentiment": {"pos": 0, "neu": 1, "neg": 1, "mix": 0},
        "types": {"mention": 3, "recommendation": 0, "comparison": 0, "definition": 0, "final_choice": 0}}
    mb = smart.json()["data"]["items"][0]["matched_brand"]
    assert ids(smart) == [jid(2)] and mb["mention_count"] == 2 and mb["rank"] == 2      # 비경쟁 1 + 경쟁 1(rk2) 합산
    assert ids(kia) == [jid(2)]                                                          # k3 은 std_in 거짓
    assert ids(nope) == [] and nope.json()["meta"]["dropped_filters"] == {"mention_brand": ["NoSuchBrand"]}
    assert ids(pos) == [jid(12), jid(2), jid(1)]
    assert ids(neg) == []                                   # 당사 행에 부정 없음(Toyota 부정은 경쟁사)
    assert ids(mix) == [jid(2)]
    async with client_as(HQ_HYUNDAI) as c:                 # 관점 Hyundai: Kia 혼합은 당사 신호가 아니다
        assert ids(await c.get(URL, params={"surface": "global", "signal": "mixed"})) == []


@needs_db
async def test_domain_and_source(client_as):
    async with client_as(ADMIN) as c:
        red = await c.get(URL, params={"surface": "global", "domain": "WWW.reddit.com"})
        bmw = await c.get(URL, params={"surface": "global", "domain": "bmwusa.com", "include_gap": "true"})
        unk = await c.get(URL, params={"surface": "global", "domain": "unknown.example"})
        com = await c.get(URL, params={"surface": "global", "source": ["communityForums"]})
        comp = await c.get(URL, params={"surface": "global", "source": ["officialCompetitor"], "include_gap": "true"})
    assert ids(red) == [jid(1)]
    assert red.json()["data"]["items"][0]["matched_domain"] == {"domain": "reddit.com", "citations": 2}
    assert ids(bmw) == []                                   # 인용 모수 cit_in 거짓
    assert ids(unk) == [] and unk.json()["meta"]["dropped_filters"] == {"domain": ["unknown.example"]}
    assert ids(com) == [jid(1)]
    assert ids(comp) == []


@needs_db
async def test_prompt_id_q_and_collapse(client_as):
    p1 = "b0000000-0000-4000-8000-000000000001"
    async with client_as(ADMIN) as c:
        acr = await c.get(URL, params={"surface": "global", "prompt_id": "b0000000-0000-4000-8000-000000000003", "include_gap": "true"})
        q = await c.get(URL, params={"surface": "global", "q": "SUV"})
        pct = await c.get(URL, params={"surface": "global", "q": "%%"})
        cell = await c.get(URL, params={"surface": "global", "prompt_id": p1, "include_gap": "true", "collapse": "cell"})
        none = await c.get(URL, params={"surface": "global", "prompt_id": p1, "include_gap": "true"})
        other = await c.get(URL, params={"surface": "global", "prompt_id": "b0000000-0000-4000-8000-000000000021"})
    assert ids(acr) == [jid(12)]                           # ACR 2·3회차는 cit_in 도 거짓(A15)
    assert ids(q) == [jid(2), jid(1)]                       # 'best suv'(대소문자 무시), '현대 SUV 추천'(k3)은 std_in 거짓
    assert ids(pct) == []                                   # % 는 리터럴
    assert ids(none) == [jid(9), jid(2), jid(1)]
    assert ids(cell) == [jid(9), jid(2)]                    # (chatgpt, US) 셀 최신 = k9(05:00), runs 2
    assert [x["runs"] for x in cell.json()["data"]["items"]] == [2, 1]
    assert ids(other) == [] and other.json()["meta"]["dropped_filters"] == {"prompt_id": ["b0000000-0000-4000-8000-000000000021"]}


@needs_db
async def test_website_hidden_citations(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "website"})
        dom = await c.get(URL, params={"surface": "website", "domain": "kia.com"})
    assert ids(r) == [jid(22), jid(21)]
    assert all(x["citations"] is None for x in r.json()["data"]["items"])
    assert r.json()["meta"]["suppressed"] == {"citations": "hidden"}
    k21 = next(x for x in r.json()["data"]["items"] if x["id"] == jid(21))
    assert k21["mentions"] == {"total": 1, "own": {"count": 1, "rank": 1}} and k21["country"] == "DE" and k21["lang"] == "de"
    assert ids(dom) == [] and dom.json()["meta"]["suppressed"] == {"citations": "hidden"}
    async with client_as(KIA_US) as c:                    # 사이트 국가 DE 는 스코프(US) 밖 → 회차 없음
        r = await c.get(URL, params={"surface": "website"})
    assert ids(r) == [] and r.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"}


# ════════════════════════════════════════════════════════════════════════════
# 페이지네이션·검증
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_keyset_pagination(client_as):
    base = {"surface": "global", "include_gap": "true", "from": "2026-09-01", "to": "2026-09-30", "limit": 3}
    got, cursor, pages = [], None, 0
    async with client_as(ADMIN) as c:
        while True:
            r = await c.get(URL, params=base | ({"cursor": cursor} if cursor else {}))
            assert r.status_code == 200
            got += ids(r)
            pages += 1
            cursor = r.json()["meta"]["page"]["next_cursor"]
            if not cursor:
                break
        # 다른 필터로 커서 재사용 = 422, 변조 = 422
        first = await c.get(URL, params=base)
        cur = first.json()["meta"]["page"]["next_cursor"]
        wrong = await c.get(URL, params=base | {"engine": ["gemini"], "cursor": cur})
        junk = await c.get(URL, params=base | {"cursor": "not-a-cursor"})
    assert got == [jid(k) for k in (12, 9, 4, 2, 1, 18, 17, 16)] and pages == 3
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "cursor_invalid"
    assert junk.status_code == 422 and junk.json()["error"]["code"] == "cursor_invalid"


@needs_db
@pytest.mark.parametrize("params", [
    {"surface": "nope"},
    {"surface": "global", "limit": 0},
    {"surface": "global", "limit": 201},
    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},
    {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"},
    {"surface": "global", "q": "a"},
    {"surface": "global", "signal": "bogus"},
    {"surface": "global", "collapse": "cell"},
    {"surface": "global", "prompt_id": "not-a-uuid"},
    {"surface": "global", "mention_brand": "a\x01b"},
    {"surface": "global", "include_gap": "maybe"},
])
async def test_invalid_params_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


@needs_db
async def test_empty_period(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "global", "from": "2025-01-01", "to": "2025-01-31"})
    assert r.status_code == 200 and ids(r) == [] and r.json()["meta"]["page"]["next_cursor"] is None
    assert r.json()["meta"]["mode"] == "cumulative" and "window_from" not in r.json()["meta"]["page"]


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(197bd92 판정 D3·D4)
# ════════════════════════════════════════════════════════════════════════════
@pytest.fixture
def cycle_hidden(monkeypatch):
    """창 해석 결과에서 특정 회차의 hidden_scope 만 바꿔 준다(기간 모드 전용). 기능 트리는 rd 쓰기가 금지(G6)라
    DB 를 고치지 않고 core 가 돌려준 회차 행을 core.build_window 로 다시 접는다(계열 키 계산은 core 그대로)."""
    import dataclasses

    from app.core.filters import ReadContext
    orig = ReadContext.window
    state: dict[int, int] = {}

    async def fake(self, conn, **kw):
        w = await orig(self, conn, **kw)
        if not state:
            return w
        rows = [dataclasses.replace(r, hidden_scope=state.get(r.cyc_key, r.hidden_scope)) for r in w.cycles]
        return build_window(surface=w.surface, mode=w.mode, rows=rows, lo=w.lo, hi=w.hi, generation=w.generation,
                            project_keys=self.project_keys, project_ids=self.project_ids)
    monkeypatch.setattr(ReadContext, "window", fake)
    return state


def test_family_hidden_reason_partial():
    """D4: 계열 술어로 창의 회차가 일부만 빠지면 'partial_hidden', 전부면 'hidden'(core Window.hidden 코드), 없으면 None."""
    def win(hs):
        rows = [CycleRow(100 + i, 1, date(2026, 9, 1 + 7 * i), h) for i, h in enumerate(hs)]
        return build_window(surface="global", mode="cumulative", rows=rows, lo=date(2026, 9, 1), hi=date(2026, 9, 30),
                            generation=1, project_keys=(1,))
    assert family_hidden_reason(win([0, 3]), "mentions") == "partial_hidden"
    assert family_hidden_reason(win([3, 3]), "mentions") == "hidden"
    assert family_hidden_reason(win([0, 0]), "mentions") is None
    assert family_hidden_reason(win([0, 3]), "citations") is None          # 3 은 언급 계열만 숨긴다(Q18)
    assert family_hidden_reason(win([2, 0]), "citations") == "partial_hidden"
    assert family_hidden_reason(win([1]), "mentions") is None              # 전체 숨김(1)은 행 계열에서 이미 빠진다
    assert family_hidden_reason(win([]), "mentions") is None


@needs_db
async def test_period_partial_mentions_hidden_is_disclosed(client_as, cycle_hidden):
    """D4 재현: 기간 모드 + 언급 술어에서 회차 11 만 언급 숨김(3)이면 그 회차 행이 빠지고 meta.suppressed 에 partial_hidden 이 선다."""
    period = {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"}
    async with client_as(ADMIN) as c:
        base = await c.get(URL, params=period | {"mention_brand": "Toyota"})
    assert ids(base) == [jid(1)] and base.json()["meta"]["suppressed"] == {}
    cycle_hidden[11] = 3
    async with client_as(ADMIN) as c:
        hid = await c.get(URL, params=period | {"mention_brand": "Toyota"})
        sig = await c.get(URL, params=period | {"signal": "positive"})
        plain = await c.get(URL, params=period)
    assert ids(hid) == [] and hid.json()["meta"]["suppressed"] == {"mentions": "partial_hidden"}
    assert ids(sig) == [] and sig.json()["meta"]["suppressed"] == {"mentions": "partial_hidden"}
    # 술어가 없으면 행은 남고 그 회차 행의 mentions 만 null + 'hidden'(행 단위 억제)
    assert jid(1) in ids(plain) and plain.json()["meta"]["suppressed"] == {"mentions": "hidden"}
    assert all(x["mentions"] is None for x in plain.json()["data"]["items"] if x["round_date"] == "2026-09-14")


def test_surface_route_table_is_core():
    """D3 → core 이관: 표면 경로 표는 core.auth(SURFACE_ROLES·SURFACE_MENU) 한 벌이다. 목록·상세 어디에도 복사본이 없다."""
    from app.core import auth
    from app.features.analytics.answers.detail import service as detail_service
    from app.features.analytics.answers.list import service as list_service
    assert detail_service.surface_denial is auth.surface_denial
    for mod in (detail_service, list_service):
        assert not hasattr(mod, "_SURFACE_ROUTE") and not hasattr(mod, "surface_route_allowed")
