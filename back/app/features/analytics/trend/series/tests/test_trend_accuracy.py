"""T-1 citation_accuracy(인용 정확도, WU-9 표시 정합): 현행 웹사이트 추이 ⑥ 선과 같은 정의(회차별 타겟∧자사 답변 ÷ 자사 URL 인용 답변,
항상 라이브, 발행값 아님: front website/_data/live.ts:246-272, summary-website-aggregates.ts:1570-1650). 요청할 때만 낸다(기본 목록 불변).

픽스처 웹사이트 회차 21(09-18, Kia DE 사이트)은 인용 숨김이라 staged(unhide=[21])로 연다. 그 회차는 R09 발행 회차라 M06·M07 은 발행값
(origin=report, 10/15·12/15)이고, 인용 정확도는 같은 회차의 라이브 답변 쌍이어야 한다(예전 어댑터 = M06 분자 ÷ M07 분자 = 10/12 는 틀린 원천).
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import ApiError
from app.features.analytics.trend.series import service
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, scalar_rows, staged
from app.features.analytics.trend.series.tests.test_trend import D18, _get, point, ratio, series
from tests.support import CUST_PROJECT, KIA_EU, VENDOR, needs_db

LIVE_ACC_SQL = """
SELECT count(*) FILTER (WHERE a.web_reg AND a.own_url_cited) AS own,
       count(*) FILTER (WHERE a.web_reg AND a.own_url_cited AND a.tgt_cited) AS tgt_own
  FROM rd.answer a
 WHERE a.surface = 2 AND a.round_date = :rd AND a.cyc_key = ANY(CAST(:ks AS int4[])) AND a.dflt AND a.cit_in AND a.bgrp = 2
"""


def test_parse_metrics_opt_in_only():
    assert [m.code for m in service.parse_metrics([], "website", "none")] == ["M01", "M02", "M03", "M04", "M05", "M06", "M07"]
    assert [m.code for m in service.parse_metrics(["M01", "citation_accuracy"], "website", "none")] == ["M01", "ACC"]
    assert [m.code for m in service.parse_metrics(["ACC"], "project", "engine")] == ["ACC"]
    for surface, dim in (("global", "none"), ("website", "brand")):
        with pytest.raises(ApiError) as e:
            service.parse_metrics(["citation_accuracy"], surface, dim)
        assert e.value.code == "metric_not_supported"


@needs_db
async def test_website_accuracy_is_live_pair_on_published_round(client_as):
    params = {"surface": "website", "metrics": ["M06", "M07", "citation_accuracy"]}
    async with staged(Stage(unhide=[21])) as conn:
        cyc = await _get(client_as, KIA_EU, params)
        wk = await _get(client_as, KIA_EU, {**params, "bucket": "week"})
        base = await _get(client_as, KIA_EU, {"surface": "website"})
        e = (await scalar_rows(conn, LIVE_ACC_SQL, rd=D18, ks=[21]))[0]
    acc = point(series(cyc, "citation_accuracy"), D18)
    assert ratio(acc) == (e["tgt_own"], e["own"]) and e["own"] > 0 and acc["origin"] is None and not acc["gap"]
    assert series(cyc, "citation_accuracy")["code"] == "ACC"
    assert point(series(cyc, "target_url_rate"), D18)["origin"] == "report"          # 같은 회차 M06 은 발행값
    assert ratio(point(series(cyc, "target_url_rate"), D18)) == (10, 15) != ratio(acc)
    assert ratio(point(series(wk, "citation_accuracy"), date(2026, 9, 14))) == ratio(acc)   # 주 버킷도 라이브(회차 하나)
    assert "citation_accuracy" not in {s["metric"] for s in base["data"]["series"]}      # 기본 요청 불변


@needs_db
async def test_accuracy_week_bucket_sums_live_rounds_and_hidden_gap(client_as):
    kia_de_site_pk = 2
    params = {"surface": "website", "bucket": "week", "from": "2026-09-14", "to": "2026-09-20", "metrics": ["citation_accuracy"]}
    async with staged(Stage(unhide=[21], cycles=[NewCycle(902, date(2026, 9, 16), surface=2, project_key=kia_de_site_pk, copy_from=21)])) as conn:
        wk = await _get(client_as, KIA_EU, params)
        a = (await scalar_rows(conn, LIVE_ACC_SQL, rd=D18, ks=[21]))[0]
        b = (await scalar_rows(conn, LIVE_ACC_SQL, rd=date(2026, 9, 16), ks=[902]))[0]
    assert ratio(point(series(wk, "citation_accuracy"), date(2026, 9, 14))) == (a["tgt_own"] + b["tgt_own"], a["own"] + b["own"])
    hidden = await _get(client_as, KIA_EU, {"surface": "website", "metrics": ["citation_accuracy"]})     # 회차 21 인용 숨김(픽스처 그대로)
    p = point(series(hidden, "citation_accuracy"), D18)
    assert p["gap"] and p["gap_reason"] == "hidden" and hidden["meta"]["suppressed"]["citation_accuracy"] == "hidden"


@needs_db
async def test_project_accuracy_request(client_as):
    b = await _get(client_as, VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT), "metrics": ["citation_accuracy"]})
    assert [s["metric"] for s in b["data"]["series"]] == ["citation_accuracy"]
