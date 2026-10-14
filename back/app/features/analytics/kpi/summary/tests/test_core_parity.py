"""이 라운드가 core 에 더한 조각(추가형)의 정합 테스트.

- core.measure.applied_prompt_keys_sql: 행 수 = applied_prompts_sql 카운트(표면·필터별).
- core.measure.measured_prompt_where: count(DISTINCT prompt_key) = fetch_counts(parts 'prompts') measured_prompts.
- core.filters depth4 축: 지원 선언한 엔드포인트만 적용, 선언 없는 FilterSupport 는 meta.ignored_filters 표식(검증 D2: 선언 밖 축 계약).
- K-1 parts[](B089): 빠진 부분의 문장(측정 프롬프트 count DISTINCT·적용 프롬프트·URL 인용률)·열(A16)을 건너뛰고, 남는 값·meta 는 기본 호출과 같다.
"""
from __future__ import annotations

import copy

import pytest

from app.core.db import fetch_all, fetch_val
from app.core.filters import KPI_SUPPORT, TAXONOMY_AXES, CommonFilters, FilterSupport, resolve_read_context
from app.core.measure import applied_prompt_keys_sql, applied_prompts_sql, fetch_counts, measured_prompt_where
from app.core.sqlb import Binder
from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.seed import seeded_rounds, web_unhidden  # noqa: F401  (픽스처 등록)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, TODAY, needs_db, principal

pytestmark = needs_db

CASES = [
    (HQ_HYUNDAI, {"surface": "global"}),
    (HQ_HYUNDAI, {"surface": "global", "funnel": ["F2"]}),
    (HQ_HYUNDAI, {"surface": "global", "lang": ["en"], "country": ["US"]}),
    (KIA_US, {"surface": "global"}),
    (ADMIN, {"surface": "website"}),
    (ADMIN, {"surface": "website", "lang": ["de"]}),
    (ADMIN, {"surface": "project", "project_id": str(CUST_PROJECT)}),
    (ADMIN, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"}),
]


async def _ctx(ro, uid, params, support=KPI_SUPPORT):
    return await resolve_read_context(ro, await principal(ro, uid), CommonFilters.model_validate(params), support=support)


async def test_applied_and_measured_sets_match_counts(ro):
    for uid, params in CASES:
        ctx = await _ctx(ro, uid, params)
        ms = ctx.measure()
        win = await ctx.window(ro, today=TODAY)
        q = applied_prompts_sql(ms)
        want_applied = int(await fetch_val(ro, q.text, q.params) or 0)
        b = Binder("t")
        keys = await fetch_all(ro, applied_prompt_keys_sql(ms, b), b.params)
        assert len(keys) == len({r["prompt_key"] for r in keys}) == want_applied, params
        want_measured = (await fetch_counts(ro, ms, win, parts=("prompts",)))[0]["measured_prompts"]
        b2 = Binder("t")
        n = await fetch_val(ro, f"SELECT count(DISTINCT a.prompt_key) FROM rd.answer a WHERE {' AND '.join(measured_prompt_where(ms, win, 'a', b2))}",
                            b2.params)
        assert int(n or 0) == want_measured, params


async def test_depth4_declaration_gate(ro):
    no_d4 = FilterSupport.of(global_=("brand", "period", *TAXONOMY_AXES))            # 선언 없음: 적용하지 않고 무시 표식(검증 D2)
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]}, support=no_d4)
    assert c.prompt_keys is None and c.ignored_filters == ("depth4",) and c.dropped_filters == {}
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global"}, support=no_d4)               # 안 주면 표식 없음
    assert c.ignored_filters == ()
    web_only = FilterSupport.of(global_=("brand",), website=("depth4",))               # 다른 표면에 선언: 이 표면에서는 무시 표식
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]}, support=web_only)
    assert c.ignored_filters == ("depth4",) and c.prompt_keys is None
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]})           # KPI_SUPPORT: 적용, 카탈로그에 없는 값 = dropped·빈 집합
    assert c.dropped_filters == {"depth4": ("ZZZ",)} and c.prompt_keys == ()


# ── K-1 parts[](B089) ─────────────────────────────────────────────────────────
URL_METRIC_KEYS = ("target_url_rate", "owned_url_rate", "citation_accuracy")
SUBSETS = [("urls",), ("gap", "measured", "urls"), ("applied",), ("measured",), ("gap",)]
PARTS_CASES = [
    (HQ_HYUNDAI, {"surface": "global"}),
    (HQ_HYUNDAI, {"surface": "global", "cycle_offset": 1}),
    (HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"}),
    (ADMIN, {"surface": "website"}),
    (ADMIN, {"surface": "project", "project_id": str(CUST_PROJECT)}),
    (ADMIN, {"surface": "project", "project_id": str(CUST_PROJECT), "by_funnel": "true"}),
]


@pytest.fixture
def today_at():
    """회차 노출 기준일 고정(test_summary.py 와 같은 TODAY)."""
    from app.main import app

    app.dependency_overrides[kpi_today] = lambda: TODAY
    yield
    app.dependency_overrides.pop(kpi_today, None)


@pytest.fixture
def spy(monkeypatch):
    """service 이름공간의 문장 함수를 감싸 부른 core part·문장을 적는다(값은 원래 함수 그대로)."""
    from app.features.analytics.kpi.summary import service as S

    log: dict[str, list] = {"parts": [], "calls": []}
    fc, pc, ur, uh = S.fetch_counts, S.prompt_counts, S.url_rates, S.url_hits_uncovered

    async def fetch_counts_(conn, ms, win, **kw):
        log["parts"].append(tuple(kw.get("parts", ())))
        return await fc(conn, ms, win, **kw)

    async def prompt_counts_(*a, **kw):
        log["calls"].append("applied")
        return await pc(*a, **kw)

    async def url_rates_(*a, **kw):
        log["calls"].append("url_rates")
        return await ur(*a, **kw)

    async def url_hits_uncovered_(*a, **kw):
        log["calls"].append("url_hits_uncovered")
        return await uh(*a, **kw)

    monkeypatch.setattr(S, "fetch_counts", fetch_counts_)
    monkeypatch.setattr(S, "prompt_counts", prompt_counts_)
    monkeypatch.setattr(S, "url_rates", url_rates_)
    monkeypatch.setattr(S, "url_hits_uncovered", url_hits_uncovered_)
    return log


async def _k1(client_as, uid, params):
    async with client_as(uid) as c:
        r = await c.get("/v1/kpi/summary", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _without(full: dict, parts: tuple[str, ...]) -> dict:
    """기본 응답에서 빠진 부분만 null·표식 없음으로 바꾼 기대값(표면 밖 not_website_surface 표식은 그대로)."""
    d = copy.deepcopy(full)
    data, meta = d["data"], d["meta"]
    sup = meta["suppressed"]
    if "measured" not in parts:
        data["params"]["measured_prompts"] = data["params"]["prompts_without_brand"] = None
        sup.pop("prompts_without_brand", None)
    if "applied" not in parts:
        data["params"]["applied_prompts"] = None
    if "gap" not in parts:
        data["analysis_gap"] = None
        sup.pop("analysis_gap", None)
    if "urls" not in parts and meta["surface"] in ("website", "project"):
        for k in (*URL_METRIC_KEYS, "url_prompts"):
            data[k] = None
        for k in URL_METRIC_KEYS:
            sup.pop(k, None)
        if meta["surface"] == "website":
            sup.pop("url_prompts", None)
        meta["source"] = None
    return d


async def _check_parts(client_as, spy, uid, params):
    full = await _k1(client_as, uid, params)
    assert await _k1(client_as, uid, {**params, "parts": ["applied", "gap", "measured", "urls"]}) == full, params   # 전부 = 생략(종전)
    for sub in SUBSETS:
        spy["parts"].clear()
        spy["calls"].clear()
        got = await _k1(client_as, uid, {**params, "parts": list(sub)})
        assert got == _without(full, sub), (params, sub)
        assert len(spy["parts"]) == 1, spy                                       # 카드 스캔은 한 번(core part 만 좁힌다)
        main = spy["parts"][0]
        assert ("prompts" in main) == ("measured" in sub) and ("gap" in main) == ("gap" in sub), (params, sub, main)
        if "urls" not in sub:                                                    # URL 인용률 계열 문장 전부 생략
            assert not {"urls", "url_prompts"} & set(main) and not {"url_rates", "url_hits_uncovered"} & set(spy["calls"]), (params, sub)
        assert ("applied" in spy["calls"]) == ("applied" in sub), (params, sub)  # 적용 프롬프트 문장


@pytest.mark.parametrize(("uid", "params"), PARTS_CASES)
async def test_summary_parts_skip_unrequested_statements(client_as, today_at, spy, uid, params):
    """B089: parts 를 주면 빠진 부분의 문장·열만 건너뛰고 남는 data·meta 는 기본 호출(전부)과 같다."""
    await _check_parts(client_as, spy, uid, params)


@pytest.mark.usefixtures("web_unhidden")
async def test_summary_parts_website_published_values(client_as, today_at, spy):
    """웹사이트 R09 발행값 경로(url_rates report·발행 표식 문장): urls 를 빼면 그 문장이 없고 meta.source 가 null, 나머지는 같다."""
    await _check_parts(client_as, spy, ADMIN, {"surface": "website"})
    full = await _k1(client_as, ADMIN, {"surface": "website"})
    assert full["meta"]["source"]["url_rates"] == "report"                       # 이 경로를 실제로 탔다


@pytest.mark.usefixtures("seeded_rounds")
async def test_summary_parts_hidden_marks(client_as, today_at, spy):
    """언급 숨김 창: gap·measured 를 빼면 analysis_gap·prompts_without_brand hidden 표식도 없다(나머지 표식은 같다)."""
    params = {"surface": "global", "from": "2026-09-03", "to": "2026-09-03"}
    full = await _k1(client_as, HQ_HYUNDAI, params)
    assert full["meta"]["suppressed"]["analysis_gap"] == "hidden"
    await _check_parts(client_as, spy, HQ_HYUNDAI, params)


async def test_summary_parts_bad_value_422(client_as, today_at):
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/kpi/summary", params={"surface": "global", "parts": "bogus"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"
