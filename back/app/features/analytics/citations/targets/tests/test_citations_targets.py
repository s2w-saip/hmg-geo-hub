"""GET /v1/citations/targets(C-4) 테스트. DB = 로컬 개발 DB 복제본(합성 픽스처 fixture-10-data.sql).

손 계산 근거
- 웹사이트 Kia DE 사이트(회차 21 · round_date 2026-09-18): 웹 등록 cit_in 답변 k21(chatgpt·SP21 타겟 인용)·k22(gemini·SP23 타겟 인용).
  두 답변 모두 tgt_cited·own_url_cited → 라이브 측정 2, 타겟 2, 자사 2. 픽스처 회차 21 은 인용 숨김(hidden_scope citations).
- 발행값(R09, 2026-09-18 rep-0918): Kia DE 사이트 웹 유닛 101(타겟 7/10, 자사 8/10) + 102(3/5, 4/5) = 타겟 10/15, 자사 12/15.
  301(Kia FR, 웹 유닛 없음)·401(Hyundai DE) 은 스코프·관점 밖이라 합치지 않는다.
- 프로젝트 k31: tgt_cited·own_url_cited 참(Q5), 분모 = cit_in 답변 전체(web_reg 게이트 없음, D-url-denominator) → 측정 1, 타겟 1/1, 자사 1/1.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.cycles import CycleRow, build_window
from app.core.db import fetch_one
from app.features.analytics.citations.targets import service
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
URL = "/v1/citations/targets"
RD = date(2026, 9, 18)


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


@pytest.fixture
def shown(monkeypatch):
    """창 해석만 주입: 픽스처 회차 21 의 인용 숨김을 푼 창(스냅샷 또는 누적)."""
    def use(mode: str = "snapshot"):
        async def win(ctx, conn):
            lo, hi = (RD, RD) if mode == "snapshot" else (date(2026, 9, 1), date(2026, 9, 30))
            return build_window(surface="website", mode=mode, rows=[CycleRow(21, 2, RD, 0)], lo=lo, hi=hi, generation=1,
                                project_keys=ctx.project_keys)
        monkeypatch.setattr(service, "window_for", win)
    return use


# ── 정상 응답(숨김 해제 창) ─────────────────────────────────────────────────────
async def test_snapshot_uses_publication_values(client_as, shown):
    shown()
    r = await get(client_as, KIA_EU, surface="website")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["data"] == {"measured": 15, "target": {"num": 10, "den": 15}, "owned": {"num": 12, "den": 15}}
    m = b["meta"]
    # BG-26 손 계산: rep-0918 의 Kia 유닛 중 사이트 프로젝트 웹 유닛은 101·102(301 = FR 웹 유닛 없음, 401 = Hyundai) → 사이트 2, 전부 풀
    assert m["source"] == {"origin": "report", "publication_slugs": ["rep-0918"],
                           "publications": [{"slug": "rep-0918", "cycle_label": None, "cycle_label_en": None, "round_date": "2026-09-18",
                                             "site_count": 2, "headline_pool_applied": False, "manifest_verified": False}]}
    assert (m["surface"], m["mode"], m["as_of"], m["cycles"], m["suppressed"]) == ("website", "snapshot", "2026-09-18", ["2026-09-18"], {})
    # 발행 축(국가·언어)만 켜면 발행값 유지
    for extra in ({"country": "DE"}, {"lang": "de"}, {"brand": "Kia"}):
        r = await get(client_as, KIA_EU, surface="website", **extra)
        assert r.json()["meta"]["source"]["origin"] == "report" and r.json()["data"]["measured"] == 15, extra


async def test_live_when_engine_filter_or_cumulative(client_as, shown, ro):
    shown()
    r = await get(client_as, KIA_EU, surface="website", engine="chatgpt")          # 엔진 = 발행값 미지원 축 → 라이브
    assert r.json()["data"] == {"measured": 1, "target": {"num": 1, "den": 1}, "owned": {"num": 1, "den": 1}}
    assert r.json()["meta"]["source"] == {"origin": "live", "reason": "engine_axis"}                    # 검증 D5
    r = await get(client_as, KIA_EU, surface="website", engine=["chatgpt", "gemini"])
    assert r.json()["data"] == {"measured": 2, "target": {"num": 2, "den": 2}, "owned": {"num": 2, "den": 2}}
    # 독립 SQL(손으로 쓴 rd.answer 불리언 집계)과 대조
    x = await fetch_one(ro, """
        SELECT count(*) AS den, count(*) FILTER (WHERE a.tgt_cited) AS t, count(*) FILTER (WHERE a.own_url_cited) AS o
          FROM rd.answer a
         WHERE a.surface = 2 AND a.round_date = CAST(:d AS date) AND a.cyc_key = ANY(CAST(:ck AS int4[]))
           AND a.web_reg AND a.cit_in AND a.engine_key = ANY(CAST(:e AS int2[]))""", {"d": RD, "ck": [21], "e": [1, 2]})
    assert (x["den"], x["t"], x["o"]) == (2, 2, 2)
    shown("cumulative")
    r = await get(client_as, KIA_EU, surface="website", **{"from": "2026-09-01", "to": "2026-09-30"})
    assert r.json()["meta"]["mode"] == "cumulative"                                                       # 기간 누적은 라이브만(단위 혼합 방지)
    assert r.json()["meta"]["source"] == {"origin": "live", "reason": "period_range"}
    assert r.json()["data"] == {"measured": 2, "target": {"num": 2, "den": 2}, "owned": {"num": 2, "den": 2}}


async def test_filter_changes_values(client_as, shown):
    shown()
    r = await get(client_as, KIA_EU, surface="website", engine="deepseek")        # 기본 밖 엔진: 답변 없음
    b = r.json()
    assert b["data"] == {"measured": 0, "target": None, "owned": None}
    assert b["meta"]["suppressed"] == {"target_url_rate": "no_measurement", "owned_url_rate": "no_measurement"}
    r = await get(client_as, KIA_EU, surface="website", lang="xx")                # 알 수 없는 언어 = 버림 + 빈 집합
    assert r.json()["meta"]["dropped_filters"] == {"lang": ["xx"]} and r.json()["data"]["measured"] == 0


# ── 억제·빈 결과 ─────────────────────────────────────────────────────────────
async def test_hidden_cycle_suppressed(client_as):
    r = await get(client_as, KIA_EU, surface="website")                           # 픽스처 그대로: 회차 21 인용 숨김
    assert r.status_code == 200
    assert r.json()["data"] == {"measured": 0, "target": None, "owned": None}
    assert r.json()["meta"]["suppressed"] == {"target_url_rate": "hidden", "owned_url_rate": "hidden"}
    assert r.json()["meta"]["source"] is None


async def test_source_filter_declared_and_suppressed(client_as, shown):
    shown()
    r = await get(client_as, KIA_EU, surface="website", source="news", funnel="F1")
    m = r.json()["meta"]
    assert m["ignored_filters"] == ["funnel", "source"]
    assert m["suppressed"] == {"target_url_rate": "source_filter", "owned_url_rate": "source_filter"}


async def test_empty_snapshot(client_as):
    r = await get(client_as, ADMIN, surface="website", brand="Hyundai")           # 현대 사이트 없음(현대 관점)
    assert r.status_code == 200 and r.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"}
    assert r.json()["data"] == {"measured": 0, "target": None, "owned": None}
    r = await get(client_as, HQ_HYUNDAI, surface="website")                       # core 표면 게이트: 메뉴 {standard, project}
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"


# ── 표면 ─────────────────────────────────────────────────────────────────────
async def test_global_surface_unsupported(client_as):
    r = await get(client_as, ADMIN, surface="global")
    assert r.status_code == 422 and r.json()["error"]["code"] == "surface_unsupported"


async def test_project_surface_filled(client_as):
    for uid in (VENDOR, HQ_HYUNDAI):
        r = await get(client_as, uid, surface="project", project_id=str(CUST_PROJECT))
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["data"] == {"measured": 1, "target": {"num": 1, "den": 1}, "owned": {"num": 1, "den": 1}}
        assert b["meta"]["suppressed"] == {} and b["meta"]["source"] == {"origin": "live", "reason": "not_website"}
        assert b["meta"]["cycles"] == ["2026-09-20"]
    r = await get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))
    assert r.status_code == 404                                                   # 비멤버·스코프 밖 = 404


# ── 권한·스코프 ──────────────────────────────────────────────────────────────
async def test_auth_required(client_as):
    r = await get(client_as, None, surface="website")
    assert r.status_code == 401
    r = await get(client_as, SUSPENDED, surface="website")
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


async def test_scope_no_leak(client_as, shown):
    shown()
    # 기아 US 계정: Kia DE 사이트는 국가 스코프 밖 → 라이브·발행값 모두 0(발행값도 사이트 스코프로 한정)
    r = await get(client_as, KIA_US, surface="website")
    b = r.json()
    assert b["data"] == {"measured": 0, "target": None, "owned": None}
    assert b["meta"]["source"] == {"origin": "live", "reason": "no_publication"}
    # 기아 EU 계정이 스코프 밖 국가·브랜드를 요청하면 버리고(dropped) 빈 집합
    r = await get(client_as, KIA_EU, surface="website", country="US", brand="Hyundai")
    b = r.json()
    assert b["meta"]["dropped_filters"] == {"brand": ["Hyundai"], "country": ["US"]}
    assert b["data"]["measured"] == 0
    # 현대 관점 전사 계정: Kia 사이트 발행값(Kia 브랜드 유닛)은 섞이지 않는다
    r = await get(client_as, ADMIN, surface="website", brand="Hyundai")
    assert r.json()["data"]["measured"] == 0


# ── 잘못된 파라미터 422 ───────────────────────────────────────────────────────
@pytest.mark.parametrize("params", [
    {},                                                          # surface 필수
    {"surface": "moon"},
    {"surface": "website", "from": "2026-09-02", "to": "2026-09-01"},
    {"surface": "website", "from": "2026-09-30", "to": "2026-09-01"},
    {"surface": "website", "country": "\x01"},
    {"surface": "project"},                                      # project_id 필수
])
async def test_bad_params_422(client_as, params):
    r = await get(client_as, KIA_EU, **params)
    assert r.status_code == 422, (params, r.text)
