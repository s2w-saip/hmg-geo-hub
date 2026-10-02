"""analytics.kpi.summary(K-1) 테스트. 로컬 개발 DB 합성 픽스처(back/tests/fixtures/fixture-10-data.sql) 기준.

손 계산(글로벌 회차 11 · 2026-09-14 스냅샷, HQ_HYUNDAI 관점 = 현대 비트 1, 모수 bgrp & (1|8) ≠ 0, 기본 엔진):
  std_in 답변 = k1(bgrp5, chatgpt) · k2(bgrp5, gemini) · k12(bgrp8)                      → answers 3
  own_mask & 1 : k1 1 · k2 2 · k12 1                                                  → tracked 2   (M01 2/3)
  ment_h 4+0+1 = 5 · ment_total 7+3+1 = 11                                             → M02 5/11
  sent_pos_h 3+0+1 = 4 · sent_all_h 4+0+1 = 5                                          → M03 4/5
  own_rk_h 2·0·1 → 순위 합 3, 순위 있는 답변 2                                            → M04 3/2
  cit_in(기본 엔진) k1·k2·k4·k9·k12 의 cit_n 9 · 현대 자사 cit_own_h 2(국가 좁힘 없음)       → M05 2/9
  gap: 같은 cit_in 5건 중 k4·k9 gap                                                    → A16 2/5
  측정 프롬프트 = {1, 3}                                                               → 2
기간 누적(09-01~09-30)은 회차 10(k16·k17·k18: 전부 gap·cit_in, std_in 아님)을 더해 A16 5/8, 나머지는 회차 10 의 당사 열 합이 더해진다.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.db import fetch_val
from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.seed import seeded_rounds, web_unhidden  # noqa: F401  (픽스처 등록)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, TODAY, VENDOR, WEBSITE_KIA, needs_db

URL = "/v1/kpi/summary"
pytestmark = needs_db


@pytest.fixture
def today_at():
    """회차 노출 기준일 고정(app.dependency_overrides). 기본 TODAY, 호출해 다른 날로 바꾼다."""
    from app.main import app

    def set_(d: date = TODAY) -> None:
        app.dependency_overrides[kpi_today] = lambda: d
    set_()
    yield set_
    app.dependency_overrides.pop(kpi_today, None)


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def test_global_snapshot_hand_computed(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global")
    assert r.status_code == 200, r.text
    b = r.json()
    d, m = b["data"], b["meta"]
    assert d["visibility"] == {"num": 2, "den": 3}
    assert d["share_of_voice"] == {"num": 5, "den": 11}
    assert d["sentiment"] == {"num": 4, "den": 5}
    assert d["position"] == {"sum": 3, "count": 2}
    assert d["citation_share"] == {"num": 4, "den": 9}        # k1 공식(HMG) 4 = hyundai.com·hyundaiusa.com·kia.com(공식 도메인) + linkedin.com/hyundai-motor-group(공식 소셜), 관점 무관(동기화 S1 BE-4)
    assert d["params"]["answers"] == 3 and d["params"]["measured_prompts"] == 2
    assert d["analysis_gap"] == {"gap_answers": 2, "base_answers": 5}
    assert d["target_url_rate"] is None and d["owned_url_rate"] is None and d["citation_accuracy"] is None
    assert d["params"]["prompts_without_brand"] == 0           # BG-06: 측정 {1, 3} 모두 현대 언급(k1·k12 own_mask 1)
    assert d["params"]["measured_by_funnel"] is None           # BG-08 은 by_funnel=true 일 때만
    assert m["mode"] == "snapshot" and m["as_of"] == "2026-09-14" and m["cycles"] == ["2026-09-14"]
    assert m["suppressed"] == {k: "not_website_surface" for k in ("target_url_rate", "owned_url_rate", "citation_accuracy", "url_prompts")}
    assert "cyc_key" not in r.text and "geo_key" not in r.text           # 내부 정수 키 비노출


async def test_applied_prompts_independent_count(client_as, today_at, ro):
    """M12 적용 프롬프트 수 = 현대·엄브렐러 비트 카탈로그 항목의 서로 다른 프롬프트(측정 무관). 독립 SQL 로 기대값."""
    want = await fetch_val(ro, "SELECT count(DISTINCT prompt_key) FROM rd.catalog_entry WHERE prompt_key IS NOT NULL AND brand_bit IN (1, 8)")
    r = await get(client_as, HQ_HYUNDAI, surface="global")
    assert r.json()["data"]["params"]["applied_prompts"] == want and want > 0


async def test_cycle_offset_previous_round(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", cycle_offset=1)
    b = r.json()
    assert b["meta"]["as_of"] == "2026-09-07" and b["meta"]["mode"] == "snapshot"
    # 회차 10 은 모두 gap(std_in 아님): 언급 계열 분모 0 → no_data, A16 = 현대 모수 cit_in 2건(k16·k17) + 엄브렐러(k18)
    assert b["data"]["visibility"] is None and b["meta"]["suppressed"]["visibility"] == "no_data"
    assert b["data"]["analysis_gap"] == {"gap_answers": 3, "base_answers": 3}


async def test_cumulative_period(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-01", "to": "2026-09-30"})
    b = r.json()
    assert b["meta"]["mode"] == "cumulative" and b["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert b["data"]["params"]["answers"] == 3                       # 회차 10 은 std_in 0 건
    assert b["data"]["analysis_gap"] == {"gap_answers": 5, "base_answers": 8}
    # 기간 모드에서 cycle_offset 1 은 조용히 버리지 않는다
    r2 = await get(client_as, HQ_HYUNDAI, surface="global", cycle_offset=1, **{"from": "2026-09-01", "to": "2026-09-30"})
    assert r2.json()["meta"]["ignored_filters"] == ["cycle_offset"]
    assert r2.json()["data"] == b["data"]


async def test_filters_change_values(client_as, today_at):
    base = (await get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]
    gem = (await get(client_as, HQ_HYUNDAI, surface="global", engine="gemini")).json()
    # gemini 는 k2 하나: 현대 미등장(own_mask 2)
    assert gem["data"]["visibility"] == {"num": 0, "den": 1} and gem["data"] != base
    kr = (await get(client_as, HQ_HYUNDAI, surface="global", country="KR")).json()
    assert kr["data"]["visibility"] is None and kr["meta"]["suppressed"]["visibility"] == "no_data"   # KR k4 는 gap
    assert kr["data"]["analysis_gap"] == {"gap_answers": 1, "base_answers": 1}


async def test_unsupported_axis_is_declared(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", lang="en", source="news")
    assert r.status_code == 200
    assert r.json()["meta"]["ignored_filters"] == ["source"]          # 글로벌 source 는 지원 축 아님, lang 은 지원(BG-01, KPI_SUPPORT)


async def test_scope_no_leak_country_account(client_as, today_at):
    """KIA_US(기아·US): 모수 bgrp & (2|8), US 만. DE·KR 값이 섞이지 않고, 스코프 밖 국가는 버려진다(fail-closed)."""
    r = await get(client_as, KIA_US, surface="global")
    d = r.json()["data"]
    assert d["visibility"] == {"num": 0, "den": 1}           # US 의 기아 모수 std_in = k12(엄브렐러) 1건, 기아 미등장
    de = (await get(client_as, KIA_US, surface="global", country="DE")).json()
    assert de["meta"]["dropped_filters"] == {"country": ["DE"]}
    assert de["data"]["params"]["answers"] == 0 and de["data"]["citation_share"] is None


async def test_website_hidden_citations_and_prompts_without_brand(client_as, today_at):
    r = await get(client_as, ADMIN, surface="website")
    b = r.json()
    assert r.status_code == 200 and b["meta"]["as_of"] == "2026-09-18"
    # 회차 21 = 인용 숨김(hidden_scope 2): 인용 계열 전부 hidden, 언급 계열은 정상
    for k in ("citation_share", "target_url_rate", "owned_url_rate", "citation_accuracy"):
        assert b["data"][k] is None and b["meta"]["suppressed"][k] == "hidden"
    assert b["data"]["visibility"] == {"num": 1, "den": 2}   # k21 own_mask 2(기아) 등장, k22 미등장
    assert b["data"]["params"]["prompts_without_brand"] == 1  # 측정 프롬프트 2 중 관점 브랜드 언급 1


async def test_project_surface_member_and_visibility(client_as, today_at):
    r = await get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
    b = r.json()
    assert r.status_code == 200 and b["meta"]["surface"] == "project" and b["meta"]["as_of"] == "2026-09-20"
    assert b["data"]["visibility"] == {"num": 0, "den": 1} and b["data"]["citation_share"] == {"num": 3, "den": 4}   # k31 cit_loc 3/4
    assert b["meta"]["source"] == {"url_rates": "live", "reason": "not_website", "publications": [], "round_date": None, "site_count": None, "publication_details": [], "cycle_label": None, "cycle_label_en": None}   # 프로젝트 = 라이브(R09 웹사이트 전용)
    # 비멤버 스코프 밖(기아 계정의 현대 US 프로젝트) = 404(IDOR 은폐), 멤버십 없어도 스코프 안(HQ 현대) = 열람
    assert (await get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))).status_code == 404
    assert (await get(client_as, KIA_EU, surface="project", project_id=str(CUST_PROJECT))).status_code == 404
    assert (await get(client_as, HQ_HYUNDAI, surface="project", project_id=str(CUST_PROJECT))).status_code == 200


async def test_auth_and_menu_gates(client_as, today_at):
    assert (await get(client_as, None, surface="global")).status_code == 401
    r = await get(client_as, SUSPENDED, surface="global")
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
    # core 표면 경로 게이트(route-policy.ts:26-35): vendor 는 표준·웹사이트 밖, website 역할은 웹사이트만(D-vendor)
    for uid, sf in ((VENDOR, "global"), (VENDOR, "website"), (WEBSITE_KIA, "global"), (WEBSITE_KIA, "project")):
        r = await get(client_as, uid, surface=sf, **({"project_id": str(CUST_PROJECT)} if sf == "project" else {}))
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden", (uid, sf)
    r = await get(client_as, HQ_HYUNDAI, surface="website")            # 역할은 되지만 메뉴 {standard, project}
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    assert (await get(client_as, WEBSITE_KIA, surface="website")).status_code == 200


async def test_invalid_params_422(client_as, today_at):
    for params in ({"surface": "global", "cycle_offset": 2}, {"surface": "nope"}, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},
                   {"surface": "project"}, {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"}):
        r = await get(client_as, HQ_HYUNDAI, **params)
        assert r.status_code == 422, params
        assert r.json()["error"]["code"] == "unprocessable"


async def test_empty_results(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2025-01-01", "to": "2025-01-31"})
    b = r.json()
    assert b["meta"]["cycles"] == [] and b["data"]["params"]["answers"] == 0
    assert all(b["data"][k] is None for k in ("visibility", "share_of_voice", "sentiment", "position", "citation_share"))
    today_at(date(2026, 9, 1))                                          # 노출 회차 없음
    b = (await get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert b["meta"]["suppressed"]["*"] == "no_active_snapshot" and b["meta"]["as_of"] is None


# ── 검증 결함 회귀(D3·M5·M6) ────────────────────────────────────────────────
URL_KEYS = ("target_url_rate", "owned_url_rate", "citation_accuracy")


async def test_project_url_rates_filled(client_as, today_at):
    """Q5·D-url-denominator: 프로젝트 M06·M07 분모 = cit_in 답변 전체(web_reg 게이트 없음). k31(web_reg 거짓, tgt_cited·own_url_cited 참)
    → M06 1/1 · M07 1/1 · 인용 정확도 1/1(타겟 ∧ 자사 / 자사). 발행값(R09)은 웹사이트 전용이라 라이브(reason not_website)."""
    for uid in (ADMIN, VENDOR):
        b = (await get(client_as, uid, surface="project", project_id=str(CUST_PROJECT))).json()
        for k in URL_KEYS:
            assert b["data"][k] == {"num": 1, "den": 1} and k not in b["meta"]["suppressed"], (uid, k)
        assert b["meta"]["source"] == {"url_rates": "live", "reason": "not_website", "publications": [], "round_date": None, "site_count": None, "publication_details": [], "cycle_label": None, "cycle_label_en": None}


@pytest.mark.usefixtures("web_unhidden")
async def test_website_r09_published_values_fold(client_as, today_at):
    """M5: 웹사이트 회차 21(09-18)의 인용 숨김을 풀면 스냅샷 M06·M07 은 R09 발행값(유닛 101·102, 기아 DE)으로 접힌다.
    발행값: 타겟 7+3 / 측정 10+5 = 10/15, 자사 8+4 / 10+5 = 12/15. 유닛 301(웹 유닛 없음)·401(웹 유닛 없음)은 제외.
    인용 정확도는 발행 회차에서도 라이브(타겟 ∧ 자사 / 자사, 현행 summaryWebsiteCitationAccuracy): k21·k22 = 2/2."""
    b = (await get(client_as, ADMIN, surface="website")).json()
    assert b["data"]["target_url_rate"] == {"num": 10, "den": 15} and b["data"]["owned_url_rate"] == {"num": 12, "den": 15}
    assert b["data"]["citation_accuracy"] == {"num": 2, "den": 2}
    assert b["meta"]["source"] == {"url_rates": "report", "reason": None, "publications": ["rep-0918"],   # + BG-26 표식(추가형)
                                   "round_date": "2026-09-18", "site_count": 2,
                                   "publication_details": [{"slug": "rep-0918", "cycle_label": None, "cycle_label_en": None,
                                                            "round_date": "2026-09-18"}],
                                   "cycle_label": None, "cycle_label_en": None}                        # 명명 스키마 SummarySource(fe-u4 요청 1)
    assert not any(k in b["meta"]["suppressed"] for k in URL_KEYS)
    e = (await get(client_as, ADMIN, surface="website", engine="chatgpt")).json()          # 엔진 필터 = 라이브(k21) + 표식
    assert e["data"]["target_url_rate"] == {"num": 1, "den": 1} and e["data"]["owned_url_rate"] == {"num": 1, "den": 1}
    assert e["meta"]["source"] == {"url_rates": "live", "reason": "engine_axis", "publications": [], "round_date": None, "site_count": None, "publication_details": [], "cycle_label": None, "cycle_label_en": None}
    one = (await get(client_as, ADMIN, surface="website", **{"from": "2026-09-18", "to": "2026-09-18"})).json()   # D-R09: 회차 하나 = 발행값
    assert one["data"]["target_url_rate"] == {"num": 10, "den": 15} and one["meta"]["source"]["url_rates"] == "report"
    rng = (await get(client_as, ADMIN, surface="website", **{"from": "2026-09-01", "to": "2026-09-30"})).json()
    assert rng["meta"]["source"]["url_rates"] == "live" and rng["meta"]["source"]["reason"] == "period_range"


@pytest.mark.usefixtures("seeded_rounds")
async def test_analysis_gap_hidden_when_mentions_hidden(client_as, today_at):
    """M6(1): 09-03 은 언급 숨김 회차 41 뿐이라 A16 쌍이 {0,0} 이다. 결손 0 으로 읽히지 않게 hidden 을 적는다. 인용은 보인다."""
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-03", "to": "2026-09-03"})).json()
    assert b["data"]["analysis_gap"] == {"gap_answers": 0, "base_answers": 0}
    assert b["meta"]["suppressed"]["analysis_gap"] == "hidden" and b["meta"]["suppressed"]["visibility"] == "hidden"
    assert b["data"]["citation_share"] == {"num": 4, "den": 9} and "citation_share" not in b["meta"]["suppressed"]   # 4101 = k1 열 복사(공식 4)
    n = (await get(client_as, HQ_HYUNDAI, surface="global")).json()                         # 평소(언급 보임)에는 표식 없음
    assert "analysis_gap" not in n["meta"]["suppressed"]


async def test_website_empty_snapshot_prompts_without_brand_null(client_as, today_at):
    """M6(2): 노출 회차 없는 웹사이트 스냅샷은 prompts_without_brand 가 0 이 아니라 null(no_data)."""
    today_at(date(2026, 9, 1))
    b = (await get(client_as, ADMIN, surface="website")).json()
    assert b["meta"]["suppressed"]["*"] == "no_active_snapshot"
    assert b["data"]["params"]["prompts_without_brand"] is None and b["meta"]["suppressed"]["prompts_without_brand"] == "no_data"


def test_summary_source_named_schema_and_label_order():
    """fe-u4 요청 1·2: meta.source = 명명 스키마 SummarySource(OpenAPI), 발행물 순서 = round_date 내림차순 → slug, 라벨 한 쌍 = 첫 원소."""
    from datetime import date

    from app.features.analytics.kpi.summary.service import _source
    from app.main import app

    spec = app.openapi()
    comps = spec["components"]["schemas"]
    assert {"SummarySource", "SummaryMeta", "PublicationDetail", "SummaryResponse"} <= set(comps)
    assert comps["SummaryMeta"]["properties"]["source"]["anyOf"][0]["$ref"].endswith("/SummarySource")
    ok = spec["paths"]["/v1/kpi/summary"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert ok["$ref"].endswith("/SummaryResponse")
    s = _source({"url_rates": "report", "reason": None, "publications": ["b-slug", "a-slug", "c-old"],
                 "round_date": date(2026, 9, 18), "site_count": 3,
                 "publication_details": [{"slug": "b-slug", "cycle_label": "B", "cycle_label_en": "B-en", "round_date": date(2026, 9, 18)},
                                         {"slug": "c-old", "cycle_label": "C", "cycle_label_en": None, "round_date": date(2026, 9, 11)},
                                         {"slug": "a-slug", "cycle_label": "A", "cycle_label_en": "A-en", "round_date": date(2026, 9, 18)}]})
    assert s is not None
    assert [d.slug for d in s.publication_details] == ["a-slug", "b-slug", "c-old"] == s.publications
    assert (s.cycle_label, s.cycle_label_en) == ("A", "A-en")
    assert _source(None) is None
