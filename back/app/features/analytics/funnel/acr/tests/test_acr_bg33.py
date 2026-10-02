"""GET /v1/funnel/acr data.options(BG-33: ACR 모집단 언어·국가 옵션) 통합 테스트.

기대값은 conftest 표·공용 셀 501·bg_acr.pgsql 에서 손으로 계산했다.
  기본(관리자 스냅샷 회차 11, 기본 엔진 chatgpt·gemini, acr_in): 501 US en · 9101 KR en · 9102 US en (+ 조각 9107 KR ko).
  9103(deepseek US en) 은 기본 엔진 밖, 9105(DE de) 는 acr_in 거짓, 9104 는 회차 10, 9106 은 비서빙 회차 12.
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

import pytest

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, Sql, needs_db, savepoint, stage

URL = "/v1/funnel/acr"
pytestmark = [needs_db, pytest.mark.usefixtures("acr_seed")]

_SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "bg_acr.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    _SQL[_name.strip()] = _body.strip()


@asynccontextmanager
async def _ko(conn):
    async with savepoint(conn):
        await stage(conn, Sql(_SQL["ko_cell"]))
        yield conn


@asynccontextmanager
async def _staged(conn, *names):
    async with savepoint(conn):
        await stage(conn, *(Sql(_SQL[n]) for n in names))
        yield conn


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _opt(r):
    o = r.json()["data"]["options"]
    return o["langs"], o["countries"]


async def test_bg33_options_base(client_as):
    r = await _get(client_as, ADMIN, surface="global")
    assert r.status_code == 200, r.text
    assert _opt(r) == (["en"], ["KR", "US"])


@pytest.mark.parametrize(("uid", "params", "runs", "langs", "countries"), [
    (ADMIN, {}, 4, ["en", "ko"], ["KR", "US"]),
    (ADMIN, {"lang": "ko"}, 1, ["en", "ko"], ["KR"]),                   # 자기 축(lang) 은 옵션에 걸지 않는다
    (ADMIN, {"lang": "de"}, 0, ["en", "ko"], []),                       # 데이터가 비어도 다른 언어 옵션은 남는다(9105 는 acr_in 거짓)
    (ADMIN, {"country": "US"}, 2, ["en"], ["KR", "US"]),                # 국가 옵션은 요청 국가가 아니라 스코프로
    (ADMIN, {"engine": "deepseek"}, 1, ["en", "ko"], ["US"]),           # 엔진 축: 국가 옵션에는 적용, 언어 옵션에는 없음(검증 D5)
    (ADMIN, {"list_type": "L1"}, 2, ["en", "ko"], ["KR", "US"]),        # 택소노미 축(9101·9102 만 L1): 언어 옵션에는 없음(검증 D5)
    (ADMIN, {"from": "2026-09-01", "to": "2026-09-30"}, 5, ["en", "ko"], ["KR", "US"]),   # 기간 = 회차 10·11
    (HQ_HYUNDAI, {}, 3, ["en", "ko"], ["KR", "US"]),                    # Kia 셀 9102 제외, 501·9101·9107
    (KIA_US, {}, 2, ["en"], ["US"]),                                    # 국가 스코프 US: KR(9101·9107) 누출 없음
    (KIA_US, {"country": "KR"}, 0, [], ["US"]),                         # 스코프 밖 요청은 버려지고 국가 옵션은 스코프 그대로
])
async def test_bg33_options_follow_population(client_as, acr_seed, uid, params, runs, langs, countries):
    async with _ko(acr_seed):
        r = await _get(client_as, uid, surface="global", **params)
        assert r.status_code == 200, r.text
        assert r.json()["data"]["totals"]["prompt_runs"] == runs
        assert _opt(r) == (langs, countries)


async def test_bg33_options_empty_when_window_empty_or_pending(client_as, acr_seed):
    async with _ko(acr_seed):
        r = await _get(client_as, ADMIN, **{"surface": "global", "from": "2026-10-01", "to": "2026-10-31"})
        assert r.status_code == 200 and _opt(r) == ([], [])
        r = await _get(client_as, ADMIN, surface="website")
        assert r.json()["meta"]["suppressed"] == {"*": "source_pending"} and _opt(r) == ([], [])
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        assert r.status_code == 200 and _opt(r) == ([], [])


# ── 검증 D2: 국가 옵션은 숨김 표준 국가(ID)를 뺀다(현행 listMeasuredRegions(..., true)·/v1/filters/options regions 와 같다) ──
async def test_d2_options_countries_exclude_hidden_standard(client_as, acr_seed):
    async with _staged(acr_seed, "hidden_cell"):
        r = await _get(client_as, ADMIN, surface="global")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["totals"]["prompt_runs"] == 4                    # 데이터 셀 선택은 그대로(9108 포함)
        assert _opt(r) == (["en"], ["KR", "US"])                                  # ID 없음
        async with client_as(ADMIN) as c:
            fo = await c.get("/v1/filters/options", params={"surface": "global"})
        assert fo.status_code == 200 and "ID" not in [x["code"] for x in fo.json()["data"]["regions"]]


# ── 검증 D5: 언어 옵션은 엔진·택소노미 축을 걸지 않는다(현행 listMeasuredAcrLanguages 는 스코프 브랜드·국가·기간만) ──
@pytest.mark.parametrize(("params", "runs", "langs"), [
    ({}, 4, ["de", "en", "ko"]),                    # deepseek 에서만 측정된 de 도 옵션(데이터는 기본 엔진이라 9109 미포함)
    ({"engine": "deepseek"}, 2, ["de", "en", "ko"]),
    ({"engine": "gemini"}, 1, ["de", "en", "ko"]),
    ({"list_type": "L1"}, 2, ["de", "en", "ko"]),
    ({"country": "KR"}, 2, ["en", "ko"]),           # 국가 축은 현행처럼 언어 옵션에 건다
])
async def test_d5_langs_ignore_engine_and_taxonomy(client_as, acr_seed, params, runs, langs):
    async with _staged(acr_seed, "ko_cell", "ds_de_cell"):
        r = await _get(client_as, ADMIN, surface="global", **params)
        assert r.status_code == 200, r.text
        assert r.json()["data"]["totals"]["prompt_runs"] == runs
        assert _opt(r)[0] == langs
