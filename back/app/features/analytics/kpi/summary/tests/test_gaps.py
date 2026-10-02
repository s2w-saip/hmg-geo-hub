"""KPI 값 갭 보강(BG-01·03·04·06·08·26) 테스트. 로컬 개발 DB 합성 픽스처(back/tests/fixtures/fixture-10-data.sql) 기준.

손 계산(글로벌 회차 11 · 09-14 스냅샷, 기본 엔진)
  답변 언어: std_in k1·k2·k12 = en, k4(KR, gap·cit_in) = ko, k3(US, cit_in 아님) = ko.
  HQ_HYUNDAI 적용(카탈로그 비트 1|8) = 프롬프트 {1, 2, 3, 4}, 측정(std_in) = {1, 3} → 미측정 {2 common q, 4 현대 SUV 추천}.
  KIA_US 적용(비트 2|8) = {2, 3, 6}, 측정(US·bgrp&(2|8)) = {3}(k12) → 미측정 {2 common q, 6 us only}. 현대 행(1·4)은 보이지 않는다.
  웹사이트(ADMIN) 적용(web_reg) = {8, 9, 10}, 측정 = {8, 10} → 미측정 {9 deals?}. 프로젝트 적용 {11} = 측정 {11} → 빈 목록.
기대값은 구현 SQL 을 복사하지 않고 원시 행을 읽어 파이썬으로 센다(비트 판정도 파이썬).
"""
from __future__ import annotations

import pathlib
from datetime import date

import pytest

from app.core.db import fetch_all
from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.seed import seeded_rounds  # noqa: F401  (픽스처 등록)
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_US,
    SUSPENDED,
    TODAY,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    load_named_sql,
    needs_db,
    raw_fetch,
    staged,
)

SUMMARY = "/v1/kpi/summary"
UNMEASURED = "/v1/kpi/unmeasured-prompts"
ENGINES = "/v1/kpi/engines"
COMPARE = "/v1/kpi/compare"
BLOCKS = load_named_sql(pathlib.Path(__file__).with_name("gaps.pgsql"))
pytestmark = needs_db


@pytest.fixture
def today_at():
    from app.main import app

    def set_(d: date = TODAY) -> None:
        app.dependency_overrides[kpi_today] = lambda: d
    set_()
    yield set_
    app.dependency_overrides.pop(kpi_today, None)


async def get(client_as, uid, url, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


async def _global_rows(ro, cyc: int = 11) -> list[dict]:
    """글로벌 회차 원시 답변 행(기대값 독립 계산용: 구현 빌더를 거치지 않는다)."""
    return await fetch_all(ro, "SELECT a.answer_key, a.prompt_key, a.bgrp, a.dflt, a.std_in, a.cit_in, a.gap, a.own_mask, a.ment_h, "
                               "a.ment_total, a.cit_n, g.code AS geo, l.code AS lang FROM rd.answer a "
                               "JOIN rd.dim_country g ON g.geo_key = a.geo_key JOIN rd.dim_lang l ON l.lang_key = a.lang_key "
                               "WHERE a.surface = 1 AND a.round_date = '2026-09-14' AND a.cyc_key = ANY(CAST(:c AS int4[]))", {"c": [cyc]})


# ── BG-01: 글로벌 lang[] 적용(KPI_SUPPORT) ────────────────────────────────────
async def test_bg01_global_lang_applies_to_summary(client_as, today_at, ro):
    rows = [r for r in await _global_rows(ro) if r["dflt"] and (r["bgrp"] & 9)]
    ko = [r for r in rows if r["lang"] == "ko" and r["cit_in"]]
    en_std = [r for r in rows if r["lang"] == "en" and r["std_in"] and r["cit_in"]]
    r = await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", lang="ko")
    b = r.json()
    assert r.status_code == 200 and b["meta"]["ignored_filters"] == []
    assert b["data"]["params"]["answers"] == sum(1 for x in ko if x["std_in"]) == 0
    assert b["data"]["visibility"] is None and b["meta"]["suppressed"]["visibility"] == "no_data"
    assert b["data"]["analysis_gap"] == {"gap_answers": sum(1 for x in ko if x["gap"]), "base_answers": len(ko)} == {"gap_answers": 1, "base_answers": 1}
    en = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", lang="EN")).json()      # 대소문자 무관(소문자 코드)
    assert en["data"]["params"]["answers"] == len(en_std) == 3
    assert en["data"]["visibility"] == {"num": sum(1 for x in en_std if x["own_mask"] & 1), "den": 3}
    assert en["data"]["share_of_voice"] == {"num": sum(x["ment_h"] for x in en_std), "den": sum(x["ment_total"] for x in en_std)}
    # 글로벌 M05 분자 = 출처 카테고리 Official (HMG)(동기화 S1 BE-4). 언어 축은 원소 스캔(core scan 경로)으로 모수만 좁힌다: k1(en) 공식 4 / 호스트 9
    assert en["data"]["citation_share"] == {"num": 4, "den": 9}
    bad = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", lang="xx")).json()
    assert bad["meta"]["dropped_filters"] == {"lang": ["xx"]} and bad["data"]["params"]["answers"] == 0     # fail-closed


async def test_bg01_global_lang_engines_and_compare(client_as, today_at):
    e = (await get(client_as, HQ_HYUNDAI, ENGINES, surface="global", lang="ko")).json()
    assert e["meta"]["ignored_filters"] == [] and e["data"]["total"]["answers"] == 0
    e2 = (await get(client_as, HQ_HYUNDAI, ENGINES, surface="global", lang="en")).json()
    s = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", lang="en")).json()
    assert e2["data"]["total"]["answers"] == s["data"]["params"]["answers"] == 3                  # D6: 같은 빌더
    assert e2["data"]["total"]["cit_total"] == s["data"]["citation_share"]["den"]
    c = (await get(client_as, HQ_HYUNDAI, COMPARE, surface="global", kind="cycle", lang="ko")).json()
    assert c["meta"]["ignored_filters"] == []
    assert next(i for i in c["data"] if i["metric"] == "visibility")["cur"] == {"num": 0, "den": 0}


# ── BG-06: prompts_without_brand 세 표면 ─────────────────────────────────────
async def test_bg06_prompts_without_brand_all_surfaces(client_as, today_at, ro):
    for uid, cc, bits in ((HQ_HYUNDAI, None, 9), (KIA_US, "US", 10)):
        own = 1 if uid == HQ_HYUNDAI else 2
        rows = [r for r in await _global_rows(ro) if r["dflt"] and r["std_in"] and r["cit_in"] and (r["bgrp"] & bits)
                and (cc is None or r["geo"] == cc)]
        measured = {r["prompt_key"] for r in rows}
        mentioned = {r["prompt_key"] for r in rows if r["own_mask"] & own}
        b = (await get(client_as, uid, SUMMARY, surface="global")).json()
        assert b["data"]["params"]["prompts_without_brand"] == len(measured - mentioned), uid
        assert "prompts_without_brand" not in b["meta"]["suppressed"]
    assert (await get(client_as, KIA_US, SUMMARY, surface="global")).json()["data"]["params"]["prompts_without_brand"] == 1
    p = (await get(client_as, VENDOR, SUMMARY, surface="project", project_id=str(CUST_PROJECT))).json()
    assert p["data"]["params"]["prompts_without_brand"] == 1          # k31 프롬프트 11, 현대 미언급(own_mask 0)
    today_at(date(2026, 9, 1))                                          # 노출 회차 없음 = null(0 이 아니다)
    e = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global")).json()
    assert e["data"]["params"]["prompts_without_brand"] is None and e["meta"]["suppressed"]["prompts_without_brand"] == "no_data"


@pytest.mark.usefixtures("seeded_rounds")
async def test_bg06_hidden_mentions(client_as, today_at):
    b = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", by_funnel="true", **{"from": "2026-09-03", "to": "2026-09-03"})).json()
    assert b["data"]["params"]["prompts_without_brand"] is None and b["meta"]["suppressed"]["prompts_without_brand"] == "hidden"
    assert b["data"]["params"]["measured_by_funnel"] == [] and b["meta"]["suppressed"]["measured_by_funnel"] == "hidden"


# ── BG-08: 퍼널 주제별 측정 프롬프트 수 ─────────────────────────────────────
async def test_bg08_measured_by_funnel(client_as, today_at, ro):
    taxa = {r["taxon_key"]: r["code"] for r in await fetch_all(ro, "SELECT taxon_key, code FROM rd.dim_taxon WHERE axis = 'funnel'")}
    fk = {r["prompt_key"]: r["funnel_key"] for r in await fetch_all(ro, "SELECT prompt_key, funnel_key FROM rd.dim_prompt")}
    rows = [r for r in await _global_rows(ro) if r["dflt"] and r["std_in"] and r["cit_in"] and (r["bgrp"] & 9)]
    want: dict = {}
    for pk in {r["prompt_key"] for r in rows}:
        want[taxa.get(fk[pk])] = want.get(taxa.get(fk[pk]), 0) + 1
    b = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", by_funnel="true")).json()
    got = b["data"]["params"]["measured_by_funnel"]
    assert {x["funnel"]: x["measured_prompts"] for x in got} == want == {"F1": 2}
    assert sum(x["measured_prompts"] for x in got) == b["data"]["params"]["measured_prompts"]           # 합 = 카드 측정 수
    w = (await get(client_as, ADMIN, SUMMARY, surface="website", by_funnel="true")).json()
    assert w["data"]["params"]["measured_by_funnel"] == [{"funnel": None, "measured_prompts": 2}]      # 웹 프롬프트 퍼널 0 = 미분류
    p = (await get(client_as, VENDOR, SUMMARY, surface="project", project_id=str(CUST_PROJECT), by_funnel="true")).json()
    assert p["data"]["params"]["measured_by_funnel"] == [{"funnel": "F9", "measured_prompts": 1}]
    kr = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", country="KR", by_funnel="true")).json()
    assert kr["data"]["params"]["measured_by_funnel"] == []                                           # 필터 적용: KR std_in 없음
    today_at(date(2026, 9, 1))
    assert (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", by_funnel="true")).json()["data"]["params"]["measured_by_funnel"] == []


# ── BG-04: 미측정 프롬프트 목록 ─────────────────────────────────────────────
async def _unmeasured_expected(ro, bits: int, cc: str | None) -> list[int]:
    ce = await fetch_all(ro, "SELECT prompt_key, brand_bit FROM rd.catalog_entry WHERE prompt_key IS NOT NULL")
    applied = {r["prompt_key"] for r in ce if r["brand_bit"] & bits}
    measured = {r["prompt_key"] for r in await _global_rows(ro)
                if r["dflt"] and r["std_in"] and r["cit_in"] and (r["bgrp"] & bits) and (cc is None or r["geo"] == cc)}
    return sorted(applied - measured)


async def test_bg04_global_unmeasured_matches_card(client_as, today_at, ro):
    r = await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global")
    assert r.status_code == 200, r.text
    b = r.json()
    card = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global")).json()["data"]["params"]
    want = await _unmeasured_expected(ro, 9, None)
    assert b["meta"]["page"]["total"] == len(want) == card["applied_prompts"] - card["measured_prompts"] == 2   # 카드 = 목록
    assert [i["text"] for i in b["data"]["items"]] == ["common q", "현대 SUV 추천"]          # list_type·depth1·text 순
    first = b["data"]["items"][0]
    assert first == {"prompt_id": "c1000000-0000-4000-8000-000000000002", "scope_prompt_id": "b0000000-0000-4000-8000-000000000002",
                     "text": "common q", "list_type": "L1", "depth1": "D1", "depth2": "D2b", "funnel_stage": "F2"}
    assert b["meta"]["mode"] == "snapshot" and b["meta"]["as_of"] == "2026-09-14" and b["meta"]["page"]["limit"] == 200
    one = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", limit=1)).json()
    assert len(one["data"]["items"]) == 1 and one["meta"]["page"]["total"] == 2                        # 상한은 행만 자른다


async def test_bg04_scope_no_leak_and_filters(client_as, today_at, ro):
    k = (await get(client_as, KIA_US, UNMEASURED, surface="global")).json()
    want = await _unmeasured_expected(ro, 10, "US")
    assert k["meta"]["page"]["total"] == len(want) == 2
    assert [i["text"] for i in k["data"]["items"]] == ["common q", "us only"]
    assert not {"best suv", "현대 SUV 추천"} & {i["text"] for i in k["data"]["items"]}                # 현대 카탈로그 행 누출 0
    kr = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", country="KR")).json()
    assert kr["meta"]["page"]["total"] == 4                                                               # KR std_in 없음 → 적용 전부
    f2 = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", funnel="F2")).json()
    assert [i["text"] for i in f2["data"]["items"]] == ["common q"]                                       # 택소노미 = 적용 집합도 좁힌다
    w = (await get(client_as, ADMIN, UNMEASURED, surface="website")).json()
    assert [(i["text"], i["list_type"]) for i in w["data"]["items"]] == [("deals?", None)]
    assert w["data"]["items"][0]["prompt_id"] == w["data"]["items"][0]["scope_prompt_id"] == "b0000000-0000-4000-8000-000000000022"
    p = (await get(client_as, VENDOR, UNMEASURED, surface="project", project_id=str(CUST_PROJECT))).json()
    assert p["data"]["items"] == [] and p["meta"]["page"]["total"] == 0                                 # 빈 결과


async def test_bg04_empty_windows_gates_and_422(client_as, today_at):
    per = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", **{"from": "2025-01-01", "to": "2025-01-31"})).json()
    assert per["meta"]["mode"] == "cumulative" and per["meta"]["page"]["total"] == 4                    # 측정 0 = 적용 전부(카드 적용 − 0)
    today_at(date(2026, 9, 1))
    s = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global")).json()
    assert s["meta"]["suppressed"] == {"*": "no_active_snapshot"} and s["data"]["items"] == []
    assert (await get(client_as, None, UNMEASURED, surface="global")).status_code == 401
    assert (await get(client_as, SUSPENDED, UNMEASURED, surface="global")).status_code == 401
    for uid, sf in ((VENDOR, "global"), (WEBSITE_KIA, "global")):
        r = await get(client_as, uid, UNMEASURED, surface=sf)
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    assert (await get(client_as, KIA_US, UNMEASURED, surface="project", project_id=str(CUST_PROJECT))).status_code == 404
    for params in ({"surface": "global", "limit": 0}, {"surface": "global", "limit": 201}, {"surface": "nope"},
                   {"surface": "project"}, {"surface": "global", "cycle_offset": 2}, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}):
        r = await get(client_as, HQ_HYUNDAI, UNMEASURED, **params)
        assert r.status_code == 422, params


@pytest.mark.usefixtures("seeded_rounds")
async def test_bg04_hidden_mentions_window(client_as, today_at):
    b = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", **{"from": "2026-09-03", "to": "2026-09-03"})).json()
    assert b["meta"]["suppressed"] == {"items": "hidden"} and b["data"]["items"] == []


# ── BG-03: depth4 축(KPI 적용·dropped) ──────────────────────────────────────
async def test_bg03_depth4_axis_global_and_project(client_as, today_at):
    async with staged(Sql(BLOCKS["depth4_marks"]), actor=ADMIN) as conn:
        want = await raw_fetch(conn, "SELECT DISTINCT ce.prompt_key FROM rd.catalog_entry ce JOIN app.prompt p "
                                     "ON p.prompt_id = ce.catalog_row_id WHERE p.depth4 = 'D4x'")
        assert [r["prompt_key"] for r in want] == [1]
        b = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="D4x")).json()
        assert b["meta"]["ignored_filters"] == [] and b["meta"]["dropped_filters"] == {}
        assert b["data"]["params"]["answers"] == 2 and b["data"]["visibility"] == {"num": 1, "den": 2}   # 프롬프트 1 = k1·k2
        assert b["data"]["params"]["applied_prompts"] == 1
        u = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", depth4="D4y")).json()
        assert [i["text"] for i in u["data"]["items"]] == ["현대 SUV 추천"]
        d = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4=["D4x", "ZZZ"])).json()
        assert d["meta"]["dropped_filters"] == {"depth4": ["ZZZ"]} and d["data"]["params"]["answers"] == 2
        z = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="ZZZ")).json()
        assert z["data"]["params"]["answers"] == 0 and z["data"]["params"]["applied_prompts"] == 0      # 전부 버려짐 = 빈 집합
        both = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="D4x", depth2="D2b")).json()
        assert both["data"]["params"]["applied_prompts"] == 0                                           # 같은 카탈로그 행 조건(AND)
        p = (await get(client_as, VENDOR, SUMMARY, surface="project", project_id=str(CUST_PROJECT), depth4="P4")).json()
        assert p["data"]["params"]["answers"] == 1 and p["meta"]["ignored_filters"] == []
        p0 = (await get(client_as, VENDOR, SUMMARY, surface="project", project_id=str(CUST_PROJECT), depth4="nope")).json()
        assert p0["data"]["params"]["answers"] == 0
        w = (await get(client_as, ADMIN, SUMMARY, surface="website", depth4="D4x")).json()
        assert w["meta"]["ignored_filters"] == ["depth4"]                                               # 웹사이트는 지원 축 밖
    r = await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="x" * 101)
    assert r.status_code == 422


# ── BG-26: 발행 회차 표식 ───────────────────────────────────────────────────
async def test_bg26_publication_marks(client_as, today_at):
    async with staged(Sql(BLOCKS["pub_labels"])) as conn:
        want = await raw_fetch(conn, "SELECT count(*) AS n FROM rd.report_unit_value v WHERE v.round_date = '2026-09-18' AND v.brand = 'Kia' "
                                     "AND v.file_seq IN (SELECT file_seq FROM rd.web_unit WHERE project_key = 2)")
        b = (await get(client_as, ADMIN, SUMMARY, surface="website")).json()
        src = b["meta"]["source"]
        assert src["url_rates"] == "report" and src["publications"] == ["rep-0918"]
        assert src["round_date"] == "2026-09-18" and src["site_count"] == want[0]["n"] == 2
        assert src["publication_details"] == [{"slug": "rep-0918", "cycle_label": "9월 3주차", "cycle_label_en": "Sep W3",
                                               "round_date": "2026-09-18"}]
        assert (src["cycle_label"], src["cycle_label_en"]) == ("9월 3주차", "Sep W3")          # 헤드라인 라벨 한 쌍 = 첫 원소(fe-u4 요청 2)
        live = (await get(client_as, ADMIN, SUMMARY, surface="website", engine="chatgpt")).json()["meta"]["source"]
        assert live == {"url_rates": "live", "reason": "engine_axis", "publications": [], "round_date": None, "site_count": None, "publication_details": [], "cycle_label": None, "cycle_label_en": None}   # 라이브면 표식 null
    async with staged(Sql(BLOCKS["pub_labels"]), Sql(BLOCKS["pool_one"])):
        b = (await get(client_as, ADMIN, SUMMARY, surface="website")).json()
        assert b["meta"]["source"]["site_count"] == 1                                                  # 헤드라인 풀 규칙 뒤 유닛 수
        assert b["data"]["target_url_rate"] == {"num": 7, "den": 10}                                   # 유닛 101 만(값과 같은 모수)
