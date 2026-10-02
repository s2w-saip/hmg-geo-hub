"""GET /v1/funnel/acr website 국가 옵션(data.options.countries) 현대 N 계정 회귀(동기화 S1 통합, BE-C 고지 1 해소).

현대 N 계정(국가 = HYUNDAI-N)의 website 스코프 국가는 브랜드 가상 코드뿐이다. 종전 acr_options 는 그 가상 코드로 셀 geo 축을 걸어
(가상 코드는 답변 국가가 아니다) 옵션이 0행이었다. 현행(hmg-geo 2670a16) websiteScopeCountryCondition 과 데이터 경로(core.filters BE-8 ③)처럼
DataScope.site_allowed 로 고른 사이트의 국가로 푼다. 사이트는 데이터와 같은 선택(ms.project_keys) 안에서만 보므로 넓어지지 않는다.

준비(n_site_acr.pgsql, 롤백 전용): website 회차 09-18(노출 09-19), 셀마다 chatgpt·en·유효 2.
| 사이트 | 브랜드(비트)     | 사이트 국가 | 셀(국가)   |
| 90     | Hyundai N (16)   | KR          | 9201 KR    |
| 93     | Hyundai N (16)   | DE          | 9202 DE    |
| 91     | Hyundai (1)      | US          | 9203 US    |
| 94     | Hyundai (1)      | KR          | 9204 KR    |
"""
from __future__ import annotations

import pathlib
import uuid
from datetime import date

from tests.support import ADMIN, SYSTEM, Rows, Sql, load_named_sql, needs_db, staged

URL = "/v1/funnel/acr"
M = load_named_sql(pathlib.Path(__file__).with_name("n_site_acr.pgsql"))
D18 = date(2026, 9, 18)
SITES = [(90, 16, "KR", 9901, 9201), (93, 16, "DE", 9903, 9202), (91, 1, "US", 9902, 9203), (94, 1, "KR", 9904, 9204)]


def _acct(countries: list[str]) -> dict:
    uid = uuid.uuid4()
    return {"user_id": uid, "email": f"t-acrn-{uid.hex[:8]}@example.test", "role": "hq", "operator": "none", "scope_all": False,
            "scope_brands": ["Hyundai"], "scope_regions": [], "scope_countries": countries, "menu_groups": None, "status": "active"}


def _steps() -> list:
    out: list = []
    for pk, bit, cc, cyc, cell in SITES:
        out += [Sql(M["site_ins"], (pk, uuid.uuid4(), uuid.uuid4(), bit, cc)),
                Sql(M["site_cycle_ins"], (cyc, uuid.uuid4(), pk, D18)),
                Sql(M["cell_ins"], (cell, cyc, pk, bit, cc, D18))]
    return out


@needs_db
async def test_n_account_website_acr_country_options(client_as):
    """현대 N 계정: 옵션 = 현대 N 사이트 셀 국가(DE·KR), 데이터 셀 수 2(현대 N 사이트만). 현대 본사 사이트 셀(US)로 넓어지지 않는다.
    요청 country=HYUNDAI-N 도 같은 옵션(요청으로 좁히지 않음). 가상 코드 없는 계정(현대 KR·현대 브랜드만·관리자)은 종전 그대로."""
    n, kr, hy = _acct(["HYUNDAI-N"]), _acct(["KR"]), _acct([])
    got = {}
    async with staged(*_steps(), Rows("app.user_account", [n, kr, hy]), actor=SYSTEM):
        for who, uid, extra in (("n", n["user_id"], {}), ("n_req", n["user_id"], {"country": "HYUNDAI-N"}),
                                ("kr", kr["user_id"], {}), ("hq", hy["user_id"], {}), ("admin", ADMIN, {})):
            async with client_as(uid) as c:
                r = await c.get(URL, params={"surface": "website", **extra})
            assert r.status_code == 200, (who, r.text)
            d = r.json()["data"]
            got[who] = (d["options"]["countries"], d["totals"]["prompt_runs"])
    assert got["n"] == (["DE", "KR"], 2), got
    assert got["n_req"] == (["DE", "KR"], 2), got
    assert "US" not in got["n"][0] and "HYUNDAI-N" not in got["n"][0]
    assert got["kr"] == (["KR"], 1), got                       # 현대 KR 계정 = 본사 KR 사이트 셀만(현대 N KR 사이트 아님)
    assert got["hq"] == (["KR", "US"], 2), got                  # 현대 브랜드만(국가 무제한) = 본사 사이트 셀
    assert got["admin"][0] == ["DE", "KR", "US"], got


@needs_db
async def test_option_scope_countries_equal_data_axis():
    """순수 판정(격자 10계정, 합성 사이트 N_SITES): 옵션 geo 축 = 요청 없는 데이터 답변 국가 축(ctx.countries). 가상 코드 없는 계정은 스코프
    국가 그대로(종전), 가상 코드 계정은 가상 코드를 싣지 않고 선택 사이트(ctx.project_keys) 국가 ∪ 스코프 실 코드."""
    from app.core.auth import principal_from_row
    from app.core.filters import CommonFilters, FilterSupport, resolve_read_context
    from app.features.analytics.funnel.acr.service import option_scope_countries
    from tests.core.test_sync_s1_auth import SITE_ACCOUNTS, _refs_with_n_sites, _row

    refs, by_key = await _refs_with_n_sites()
    sup = FilterSupport.of(website=("brand", "country"))
    for name, brands, regions, countries, all_ in SITE_ACCOUNTS:
        p = principal_from_row(_row("admin" if all_ else "hq", all_, brands, regions, countries, None))
        ctx = await resolve_read_context(None, p, CommonFilters(surface="website"), support=sup, refs=refs, surface_gate=False)
        got = option_scope_countries(ctx, ctx.measure())
        assert got == ctx.countries, (name, got, ctx.countries)
        if not ctx.scope.virtual_brand_bits(refs):
            assert got == ctx.scope.countries, name
        else:
            site_cc = {by_key[k][1].upper() for k in ctx.project_keys if k in by_key}
            assert "HYUNDAI-N" not in (got or ()) and set(got or ()) <= site_cc | set(ctx.scope.countries or ()), name
