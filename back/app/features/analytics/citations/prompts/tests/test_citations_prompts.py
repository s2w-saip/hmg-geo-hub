"""GET /v1/citations/prompts(C-3) 테스트. DB = 로컬 개발 DB 복제본(합성 픽스처 fixture-10-data.sql).

손 계산 근거(fixture-10-data.sql, 글로벌 스냅샷 = 회차 11 · round_date 2026-09-14)
- 인용 있는 cit_in 답변: k1 뿐(US·chatgpt·bgrp 5 = 현대|제네시스·프롬프트 SP1 'best suv'·퍼널 F1).
  k1 인용 10건 중 호스트 있는 것 9건(ord 5 'not a url' 제외). k5(DE·bmwusa) 는 elig 거짓이라 cit_in 거짓.
  k1 자사(owner_key): ord1 = 9(hyundai.com/au/en, Hyundai AU) · ord9 = 193(hyundaiusa.com root_home, Hyundai US) ·
  ord10 = 103(worldwide.kia.com/en, Kia 국가 없음). 제네시스 베이스 인용 0.
  → 현대 관점: SP1 자사 버킷(인용 9). 제네시스 관점: SP1 미인용 버킷. 국가 KR: 인용 답변 없음.
- 프로젝트(CUST_PROJECT, 회차 31 · 2026-09-20): k31(US·chatgpt·SP31 'cust q'·퍼널 F9) 인용 4, loc_owned 3 → 자사.
- 웹사이트(Kia DE, 회차 21 · 2026-09-18): 픽스처 회차가 인용 숨김(hidden_scope citations) → HTTP 는 억제.
  숨김을 푼 창(hidden 0)을 주입하면 k21(SP21 'ev9?', chatgpt, 인용 3, loc_owned∨tgt_hit 2)·k22(SP23 'sub?', gemini, 인용 1, 자사 1).
"""
from __future__ import annotations

import contextlib
from collections.abc import Iterator
from dataclasses import replace
from datetime import date

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app.core import errors
from app.core.cycles import CycleRow, build_window
from app.core.db import fetch_all
from app.core.filters import CommonFilters, resolve_read_context
from app.features.analytics.citations.prompts import service
from app.features.analytics.citations.prompts.tests import staged_db
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db, principal

pytestmark = needs_db
URL = "/v1/citations/prompts"
SP1 = "b0000000-0000-4000-8000-000000000001"
SP21 = "b0000000-0000-4000-8000-000000000021"
SP23 = "b0000000-0000-4000-8000-000000000023"
SP31 = "b0000000-0000-4000-8000-000000000031"
JOB1 = "90000000-0000-4000-8000-000000000001"
JOB21 = "90000000-0000-4000-8000-000000000021"
JOB22 = "90000000-0000-4000-8000-000000000022"
JOB31 = "90000000-0000-4000-8000-000000000031"


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


# ── 정상 응답 형태 ─────────────────────────────────────────────────────────────
async def test_global_owned_bucket_shape(client_as):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["data"]["counts"] == {"owned": 1, "uncited": 0}
    assert body["data"]["items"] == [{
        "prompt_id": SP1, "text": "best suv", "funnel": "F1", "citations": 9, "providers": ["chatgpt"],
        "answers": [{"job_id": JOB1, "provider": "chatgpt", "region": "US", "citations_in_answer": 9}]}]
    m = body["meta"]
    assert (m["surface"], m["mode"], m["as_of"], m["cycles"]) == ("global", "snapshot", "2026-09-14", ["2026-09-14"])
    assert m["page"] == {"next_cursor": None, "limit": 50, "total": 1}
    assert m["ignored_filters"] == [] and m["dropped_filters"] == {} and m["suppressed"] == {}
    # 내부 정수 키가 응답 어디에도 없다
    assert "prompt_key" not in r.text and "answer_key" not in r.text and "engine_key" not in r.text


async def test_global_uncited_bucket_other_viewpoint(client_as):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="false")
    assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["page"]["total"] == 0
    # 제네시스 관점: 같은 프롬프트가 인용은 있으나 제네시스 자사 0 → 미인용 버킷
    r = await get(client_as, ADMIN, surface="global", owned="false", brand="Genesis")
    d = r.json()["data"]
    assert d["counts"] == {"owned": 0, "uncited": 1}
    assert [(i["prompt_id"], i["citations"]) for i in d["items"]] == [(SP1, 9)]
    r = await get(client_as, ADMIN, surface="global", owned="true", brand="Genesis")
    assert r.json()["data"]["items"] == []


async def test_global_matches_independent_citation_scan(ro, refs):
    """구현(rd.answer 답변 열 G-25)과 독립인 rd.citation 원소 스캔(손으로 쓴 SQL)으로 프롬프트별 인용 수·자사 여부를 대조."""
    rows = await fetch_all(ro, """
        SELECT dp.prompt_id::text AS pid, count(*) AS cites,
               bool_or(c.owner_key = ANY(CAST(:own AS int2[]))) AS owned
          FROM rd.citation c JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key
         WHERE c.surface = 1 AND c.round_date = CAST(:d AS date) AND c.cyc_key = ANY(CAST(:ck AS int4[]))
           AND c.cit_in AND c.source_key <> 0 AND c.dflt AND c.bgrp = ANY(CAST(:bg AS int2[]))
         GROUP BY dp.prompt_id""",
        {"own": [o.owner_key for o in refs.owned_bases if o.brand_code == "Hyundai"], "d": date(2026, 9, 14), "ck": [11],
         "bg": [m for m in range(1, 32) if m & 9]})
    assert [(r["pid"], r["cites"], r["owned"]) for r in rows] == [(SP1, 9, True)]


# ── 필터 적용 전후 ───────────────────────────────────────────────────────────
@pytest.mark.parametrize(("params", "counts"), [
    ({}, {"owned": 1, "uncited": 0}),
    ({"country": "KR"}, {"owned": 0, "uncited": 0}),                  # k1 은 US
    ({"country": "US"}, {"owned": 1, "uncited": 0}),                  # country1: 1.9 US(root_home) 자사
    ({"country": ["KR", "US"]}, {"owned": 1, "uncited": 0}),          # countryN: 교차 국가 원소 조인 경로
    ({"engine": "gemini"}, {"owned": 0, "uncited": 0}),               # k1 은 chatgpt
    ({"engine": ["chatgpt", "gemini"]}, {"owned": 1, "uncited": 0}),
    ({"funnel": "F2"}, {"owned": 0, "uncited": 0}),                   # SP1 은 F1
    ({"funnel": "F1"}, {"owned": 1, "uncited": 0}),
    ({"from": "2026-09-01", "to": "2026-09-30"}, {"owned": 1, "uncited": 0}),   # 회차 10·11 누적(10 은 인용 0)
    ({"from": "2026-09-01", "to": "2026-09-10"}, {"owned": 0, "uncited": 0}),   # 회차 10 만
])
async def test_global_filters(client_as, params, counts):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", **params)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["counts"] == counts, params
    assert len(r.json()["data"]["items"]) == counts["owned"]


async def test_admin_country_n_cross_path(client_as):
    """전사 관점 US·AU: k1 은 교차 국가 자사(cit_own_x > 0) 답변이라 원소 조인(cross)으로 센다 → 자사(9 AU·193 US)."""
    r = await get(client_as, ADMIN, surface="global", owned="true", country=["US", "AU"])
    assert r.json()["data"]["counts"] == {"owned": 1, "uncited": 0}
    r = await get(client_as, ADMIN, surface="global", owned="false", country=["US", "KR"], brand="Genesis")
    assert r.json()["data"]["counts"] == {"owned": 0, "uncited": 1}


async def test_unsupported_axes_are_declared_not_silent(client_as):
    """BG-01 이전에는 글로벌 lang[] 이 ignored_filters 였다. 이제 지원 축이라 적용된다(k1 = en, k4 = ko 인용 없음).
    지원 밖 축(글로벌 cf.*)은 여전히 ignored_filters 로 드러난다."""
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", lang="en")
    m = r.json()["meta"]
    assert m["ignored_filters"] == []
    assert r.json()["data"]["counts"] == {"owned": 1, "uncited": 0}
    ko = (await get(client_as, HQ_HYUNDAI, surface="global", owned="true", lang="ko")).json()
    assert ko["meta"]["ignored_filters"] == [] and ko["data"]["counts"] == {"owned": 0, "uncited": 0} and ko["data"]["items"] == []
    cf = (await get(client_as, HQ_HYUNDAI, surface="global", owned="true", **{"cf.00000000-0000-4000-8000-000000000001": "x"})).json()
    assert cf["meta"]["ignored_filters"] == ["custom"]


async def test_source_axis(client_as):
    """source[](core R1): 출처 카테고리 축은 인용 원소에 걸린다. 'best suv'(답변 k1·k2 인용 9) 중 officialHmg 4건은 자사 버킷,
    other 1건·communityForums 2건은 자사 인용이 없어 미인용 버킷으로 옮겨 간다. 답변 표본의 인용 수도 그 출처 인용만.
    알 수 없는 slug 는 dropped 이고 축이 비어 결과 0(fail-closed)."""
    r = (await get(client_as, HQ_HYUNDAI, surface="global", owned="true", source="officialHmg")).json()
    assert r["data"]["counts"] == {"owned": 1, "uncited": 0} and r["meta"]["ignored_filters"] == []
    assert [(i["citations"], [a["citations_in_answer"] for a in i["answers"]]) for i in r["data"]["items"]] == [(4, [4])]
    u = (await get(client_as, HQ_HYUNDAI, surface="global", owned="false", source=["other", "communityForums"])).json()
    assert u["data"]["counts"] == {"owned": 0, "uncited": 1} and [i["citations"] for i in u["data"]["items"]] == [3]
    x = (await get(client_as, HQ_HYUNDAI, surface="global", owned="true", source="news")).json()
    assert x["data"]["counts"] == {"owned": 0, "uncited": 0} and x["meta"]["dropped_filters"] == {"source": ["news"]}


async def test_search_q(client_as):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", q="SUV")
    assert r.json()["meta"]["page"]["total"] == 1 and len(r.json()["data"]["items"]) == 1
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", q="zzz")
    assert r.json()["meta"]["page"]["total"] == 0 and r.json()["data"]["items"] == []
    assert r.json()["data"]["counts"] == {"owned": 1, "uncited": 0}             # 탭 카운트는 q 와 무관
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", q="best%")
    assert r.json()["meta"]["page"]["total"] == 0                                # % 는 글자 그대로


# ── 권한·스코프 ──────────────────────────────────────────────────────────────
async def test_auth_required(client_as):
    r = await get(client_as, None, surface="global", owned="true")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"
    r = await get(client_as, SUSPENDED, surface="global", owned="true")
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


async def test_scope_no_leak(client_as):
    # 기아 US 계정: 현대·제네시스 카탈로그(bgrp 5) 답변은 모수 밖
    r = await get(client_as, KIA_US, surface="global", owned="true")
    assert r.json()["data"]["counts"] == {"owned": 0, "uncited": 0}
    r = await get(client_as, KIA_US, surface="global", owned="false", brand="Hyundai", country="DE")
    d, m = r.json()["data"], r.json()["meta"]
    assert d["counts"] == {"owned": 0, "uncited": 0} and d["items"] == []
    assert m["dropped_filters"] == {"brand": ["Hyundai"], "country": ["DE"]}
    # 고객 프로젝트: 비멤버·스코프 밖 = 404(IDOR 은폐)
    r = await get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT), owned="true")
    assert r.status_code == 404
    # 웹사이트: 스코프 안 사이트가 없는 기아 US 계정 = 빈 결과(스코프 밖 사이트 누출 없음)
    r = await get(client_as, KIA_US, surface="website", owned="true")
    assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"}
    # 표면 경로 게이트(core): 메뉴 {standard, project} 인 현대 HQ 의 website = 403 menu_forbidden, vendor 의 global = role_forbidden
    r = await get(client_as, HQ_HYUNDAI, surface="website", owned="true")
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    r = await get(client_as, VENDOR, surface="global", owned="true")
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"


async def test_project_surface(client_as):
    for uid in (VENDOR, HQ_HYUNDAI, ADMIN):         # 활성 멤버 · 비멤버 스코프 안 · admin
        r = await get(client_as, uid, surface="project", project_id=str(CUST_PROJECT), owned="true")
        assert r.status_code == 200, (uid, r.text)
        d = r.json()["data"]
        assert d["counts"] == {"owned": 1, "uncited": 0}
        assert d["items"] == [{"prompt_id": SP31, "text": "cust q", "funnel": "F9", "citations": 4, "providers": ["chatgpt"],
                               "answers": [{"job_id": JOB31, "provider": "chatgpt", "region": "US", "citations_in_answer": 4}]}]
    r = await get(client_as, VENDOR, surface="project", owned="true")
    assert r.status_code == 422                                                   # project_id 필수


async def test_website_hidden_citations_suppressed(client_as):
    r = await get(client_as, KIA_EU, surface="website", owned="true")
    assert r.status_code == 200
    assert r.json()["data"] == {"items": [], "counts": {"owned": 0, "uncited": 0}}
    assert r.json()["meta"]["suppressed"] == {"citations": "hidden"} and r.json()["meta"]["cycles"] == ["2026-09-18"]


# ── 잘못된 파라미터 422 ───────────────────────────────────────────────────────
@pytest.mark.parametrize("params", [
    {"surface": "global"},                                       # owned 필수
    {"surface": "global", "owned": "maybe"},
    {"surface": "global", "owned": "true", "limit": 0},
    {"surface": "global", "owned": "true", "limit": 201},
    {"surface": "global", "owned": "true", "from": "2026-09-02", "to": "2026-09-01"},    # from > to(한쪽 기간은 fe-u1 요청 5 로 허용)
    {"surface": "mars", "owned": "true"},
    {"surface": "global", "owned": "true", "q": "x" * 201},
    {"surface": "global", "owned": "true", "cursor": "not-a-cursor"},
])
async def test_bad_params_422(client_as, params):
    r = await get(client_as, HQ_HYUNDAI, **params)
    assert r.status_code == 422, (params, r.text)
    assert r.json()["error"]["code"] in ("unprocessable", "cursor_invalid")


# ── 숨김을 푼 웹사이트 창(서비스 직접 호출): 값·페이지네이션·커서 ─────────────────────
async def _website_ctx(ro, uid=KIA_EU, **kw):
    p = await principal(ro, uid)
    f = CommonFilters.model_validate({"surface": "website", **kw})
    ctx = await resolve_read_context(ro, p, f, support=service.SUPPORT)
    shown = build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 18),
                         hi=date(2026, 9, 18), generation=1, project_keys=ctx.project_keys)
    return f, ctx, shown


def _req(f, owned=True, q=None, limit=50, cursor=None):
    return service.PageRequest(owned=owned, q=q, limit=limit, cursor=cursor, fh=service.request_hash(f, owned, q, {}))


async def test_website_values_and_keyset_pagination(ro):
    f, ctx, win = await _website_ctx(ro)
    full = await service.list_prompts(ro, ctx, win, _req(f))
    assert full.data.counts.model_dump() == {"owned": 2, "uncited": 0}
    assert [(str(i.prompt_id), i.citations, i.providers, [(str(a.job_id), a.region, a.citations_in_answer) for a in i.answers])
            for i in full.data.items] == [(SP21, 3, ["chatgpt"], [(JOB21, "DE", 3)]), (SP23, 1, ["gemini"], [(JOB22, "DE", 1)])]
    p1 = await service.list_prompts(ro, ctx, win, _req(f, limit=1))
    assert [str(i.prompt_id) for i in p1.data.items] == [SP21] and p1.meta.page.next_cursor and p1.meta.page.total == 2
    p2 = await service.list_prompts(ro, ctx, win, _req(f, limit=1, cursor=p1.meta.page.next_cursor))
    assert [str(i.prompt_id) for i in p2.data.items] == [SP23] and p2.meta.page.next_cursor is None
    # 다른 버킷·검색어로 커서 재사용 = 422, 세대가 바뀐 창 = 409
    with pytest.raises(errors.ApiError) as e:
        await service.list_prompts(ro, ctx, win, _req(f, owned=False, limit=1, cursor=p1.meta.page.next_cursor))
    assert (e.value.status, e.value.code) == (422, "cursor_invalid")
    with pytest.raises(errors.ApiError) as e:
        await service.list_prompts(ro, ctx, replace(win, generation=2), _req(f, limit=1, cursor=p1.meta.page.next_cursor))
    assert (e.value.status, e.value.code) == (409, "cursor_stale")
    none = await service.list_prompts(ro, ctx, win, _req(f, owned=False))
    assert none.data.items == [] and none.data.counts.owned == 2


async def test_website_filters_service(ro):
    f, ctx, win = await _website_ctx(ro, engine=["gemini"])
    r = await service.list_prompts(ro, ctx, win, _req(f))
    assert [(str(i.prompt_id), i.citations) for i in r.data.items] == [(SP23, 1)]
    f, ctx, win = await _website_ctx(ro, lang=["fr"])
    r = await service.list_prompts(ro, ctx, win, _req(f))
    assert r.data.counts.model_dump() == {"owned": 0, "uncited": 0}                # 두 답변 모두 de
    f, ctx, win = await _website_ctx(ro, lang=["de"])
    r = await service.list_prompts(ro, ctx, win, _req(f))
    assert r.data.counts.owned == 2
    f, ctx, win = await _website_ctx(ro)
    r = await service.list_prompts(ro, ctx, win, _req(f, q="sub"))
    assert [str(i.prompt_id) for i in r.data.items] == [SP23] and r.meta.page.total == 1


async def test_http_website_with_shown_window(client_as, monkeypatch):
    """라우터 경로 전체(인증·스코프·봉투)에서 숨김을 푼 창: 창 해석만 주입한다."""
    async def shown(ctx, conn):
        return build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 18),
                            hi=date(2026, 9, 18), generation=1, project_keys=ctx.project_keys)
    monkeypatch.setattr(service, "window_for", shown)
    r = await get(client_as, KIA_EU, surface="website", owned="true", limit=1)
    body = r.json()
    assert [i["prompt_id"] for i in body["data"]["items"]] == [SP21] and body["meta"]["page"]["total"] == 2
    r2 = await get(client_as, KIA_EU, surface="website", owned="true", limit=1, cursor=body["meta"]["page"]["next_cursor"])
    assert [i["prompt_id"] for i in r2.json()["data"]["items"]] == [SP23] and r2.json()["meta"]["page"]["next_cursor"] is None
    # 기아 US 계정은 DE 사이트가 스코프 밖 → 빈 결과
    r = await get(client_as, KIA_US, surface="website", owned="true")
    assert r.json()["data"]["items"] == []


# ── P12 B099 선택 파라미터: include_refs·fields·both_buckets(기본 = 종전 응답) ─────────────────
@contextlib.contextmanager
def _recorded() -> Iterator[list[str]]:
    """이 블록에서 실행된 SQL 문장(모든 엔진)."""
    seen: list[str] = []

    def before(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        seen.append(statement)
    event.listen(Engine, "before_cursor_execute", before)
    try:
        yield seen
    finally:
        event.remove(Engine, "before_cursor_execute", before)


async def _rec(client_as, uid, **params) -> tuple[dict, list[str]]:
    async with client_as(uid) as c:
        with _recorded() as seen:
            r = await c.get(URL, params=params)
    assert r.status_code == 200, r.text
    return r.json(), list(seen)


def _stmts(seen: list[str]) -> dict[str, int]:
    """bucket = 문장 1(버킷·페이지), refs = 문장 2(답변 표본), agg = 엔진 array_agg, taxon = 퍼널 조인."""
    return {"bucket": sum("AS n_owned" in s for s in seen), "refs": sum("row_number() OVER (PARTITION BY s.prompt_key" in s for s in seen),
            "agg": sum("array_agg(pe.engine_key" in s for s in seen), "taxon": sum("rd.dim_taxon t" in s for s in seen)}


P12_CASES = [(HQ_HYUNDAI, {"surface": "global"}), (ADMIN, {"surface": "global", "brand": "Genesis"}),
             (ADMIN, {"surface": "global", "country": ["US", "AU"]}), (HQ_HYUNDAI, {"surface": "global", "source": "officialHmg"}),
             (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)}),
             (HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})]


async def test_p12_include_refs_and_fields_skip_only_their_parts(client_as):
    """include_refs=false: 답변 표본 문장 없음·answers = [], fields=text: array_agg·퍼널 조인 없음·funnel null·providers [].
    나머지(정렬·citations·counts·meta)는 기본 호출과 같다. 기본 응답에는 other_bucket 키가 없다."""
    async with staged_db.staged("global"):
        seen_rows = 0
        for uid, f in P12_CASES:
            for owned in ("true", "false"):
                base, s_base = await _rec(client_as, uid, owned=owned, **f)
                assert "other_bucket" not in base["data"]
                norefs, s_nr = await _rec(client_as, uid, owned=owned, include_refs="false", **f)
                text, s_tx = await _rec(client_as, uid, owned=owned, fields="text", **f)
                both_off, s_bo = await _rec(client_as, uid, owned=owned, fields="text", include_refs="false", **f)
                items = base["data"]["items"]
                seen_rows += len(items)
                assert norefs["data"] == {**base["data"], "items": [{**i, "answers": []} for i in items]} and norefs["meta"] == base["meta"]
                assert text["data"] == {**base["data"], "items": [{**i, "funnel": None, "providers": []} for i in items]}
                assert text["meta"] == base["meta"]
                assert both_off["data"]["items"] == [{**i, "funnel": None, "providers": [], "answers": []} for i in items]
                assert both_off["data"]["counts"] == base["data"]["counts"] and both_off["meta"] == base["meta"]
                d = {k: _stmts(v) for k, v in (("base", s_base), ("nr", s_nr), ("tx", s_tx), ("bo", s_bo))}
                assert d["base"]["refs"] == (1 if items else 0) and d["nr"]["refs"] == 0 and d["bo"]["refs"] == 0, (f, d)
                if d["base"]["bucket"]:
                    assert d["base"]["agg"] == d["base"]["taxon"] == 1 and d["tx"]["agg"] == d["tx"]["taxon"] == 0, (f, d)
                    assert len(s_nr) == len(s_base) - (1 if items else 0) and len(s_tx) == len(s_base), f
        assert seen_rows >= 8


async def test_p12_both_buckets_equals_two_calls(client_as):
    """both_buckets=true: items·counts·meta = owned 호출 그대로, other_bucket = 반대 버킷 호출의 items(같은 limit·q·include_refs·fields).
    문장 1·2 가 한 번씩(두 호출이면 두 번씩)."""
    async with staged_db.staged("global"):
        checked = 0
        for uid, f in P12_CASES:
            for owned, other in (("true", "false"), ("false", "true")):
                for extra in ({"limit": 1}, {"limit": 2}, {"limit": 5}, {"limit": 5, "q": "p"}, {"limit": 2, "include_refs": "false"},
                              {"limit": 50, "fields": "text"}):
                    one, s_one = await _rec(client_as, uid, owned=owned, **extra, **f)
                    two, s_two = await _rec(client_as, uid, owned=other, **extra, **f)
                    both, s_both = await _rec(client_as, uid, owned=owned, both_buckets="true", **extra, **f)
                    assert both["meta"] == one["meta"], (f, extra)
                    assert both["data"] == {**one["data"], "other_bucket": two["data"]["items"]}, (f, extra)
                    if _stmts(s_one)["bucket"]:                                    # 한 호출 = 문장 1 하나 + 답변 표본 문장 하나 이하
                        assert _stmts(s_both)["bucket"] == 1 and _stmts(s_both)["refs"] <= 1, (f, extra)
                        assert len(s_both) - len(s_one) <= 1 and len(s_both) < len(s_one) + len(s_two), (f, extra)
                    checked += bool(one["data"]["items"] and two["data"]["items"])
        assert checked >= 4                                                    # 두 버킷 모두 행이 있는 대조(빈 대조 아님)
    # 인용 숨김 창·회차 없는 창: other_bucket = [](요청했을 때만 키가 있다)
    r = await get(client_as, KIA_EU, surface="website", owned="true", both_buckets="true")
    assert r.json()["data"] == {"items": [], "counts": {"owned": 0, "uncited": 0}, "other_bucket": []}


@pytest.mark.parametrize("params", [
    {"surface": "global", "owned": "true", "both_buckets": "true", "cursor": "abc"},     # 커서는 한 버킷의 페이지
    {"surface": "global", "owned": "true", "fields": "all,text"},
    {"surface": "global", "owned": "true", "fields": "funnel"},
    {"surface": "global", "owned": "true", "include_refs": "maybe"},
])
async def test_p12_bad_params_422(client_as, params):
    r = await get(client_as, HQ_HYUNDAI, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (params, r.text)
