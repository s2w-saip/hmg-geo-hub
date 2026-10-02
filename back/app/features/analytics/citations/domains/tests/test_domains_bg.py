"""BG 보강(bg-citations) 회귀: /v1/citations/domains 의 BG-20(경쟁사 옵션·skey[] 선택)·BG-21(검색·정렬)·BG-24(인용 프롬프트 수)·
BG-22(/v1/citations/domains/export).

준비(롤백 전용): prompts/tests/staged.pgsql @global(글로벌 회차 14 = 새 스냅샷) + domains/tests/bg.pgsql 조각.
회차 14 기본 엔진·cit_in 인용(템플릿 k1 원소 복사, ord 1 hyundai.com · 2·4 reddit.com · 3 linkedin 공식 소셜 · 6 example.org ·
7 caranddriver.com · 8 foo-bar.xyz · 9 hyundaiusa.com):
  9101 PA{1,2,3} · 9102 PB{2,3,4} · 9103 PC{9,2,3} · 9104 PE{5 호스트 없음} · PD 9111{1,2} 9112{2,3} 9113{3,4} 9114{6} 9115{7} 9116{8}
  9117{2} 9118{3} 9119{4} 9120{6}   (9105 deepseek = 기본 엔진 밖, 9106 elig 거짓 = cit_in 밖)
손 계산: reddit 인용 9·답변 8·프롬프트 4(PA PB PC PD) · linkedin 6·6·4 · hyundai.com 2·2·2 · example.org 2·2·1 · hyundaiusa 1·1·1 ·
caranddriver 1·1·1 · foo-bar 1·1·1 → 합 22, 출처 7, 커버리지 분모(cit_in 답변) 14.
기대값은 같은 트랜잭션에서 rd.citation 원소를 직접 센 독립 SQL(기능 SQL 의 두 단계 접기와 다른 경로)로 만든다.
"""
from __future__ import annotations

import csv
import io
import math
import pathlib
import zipfile
from typing import Any

import pytest

from app.features.analytics.citations.domains import queries as domains_queries
from app.features.analytics.citations.domains import service as domains_service
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, SUSPENDED, VENDOR, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db
URL = "/v1/citations/domains"
EXPORT = "/v1/citations/domains/export"
G = {"surface": "global"}
BG = load_named_sql(pathlib.Path(__file__).with_name("bg.pgsql"))
HQ_BGRPS = [m for m in range(1, 32) if m & 9]           # 현대 관점 모집단 비트(Hyundai 1 | HMG 8)

# 독립 기대값: 회차 14(스냅샷) 기본 엔진·cit_in·호스트 있는 인용을 출처(유효 카테고리 = 오버라이드 우선)별로 직접 센다
EXPECT_SQL = """
SELECT ds.skey, count(*) AS citations, count(DISTINCT c.prompt_key) AS prompts, count(DISTINCT c.answer_key) AS answers,
       coalesce(o.category_key, ds.category_key) AS category_key
  FROM rd.citation c JOIN rd.dim_source ds ON ds.source_key = c.source_key
  LEFT JOIN app.citation_domain_override o ON o.domain = ds.skey
 WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND c.cit_in AND c.source_key <> 0 AND c.dflt
   AND c.bgrp = ANY($1::int2[])
 GROUP BY ds.skey, coalesce(o.category_key, ds.category_key)
"""
DEN_SQL = """
SELECT count(*) AS n FROM rd.answer a
 WHERE a.surface = 1 AND a.round_date = '2026-09-23' AND a.cyc_key = ANY(ARRAY[14]) AND a.cit_in AND a.dflt AND a.bgrp = ANY($1::int2[])
"""
# share·coverage 는 현행 표가 비교하는 표시값(pctOf 반올림 천분율, 검증 D3)
SORT_FIELD = {"citations": "citations", "share": "share_pm", "coverage": "coverage_pm", "prompts": "prompts"}
RAW_FIELD = {"citations": "citations", "share": "citations", "coverage": "answers", "prompts": "prompts"}


def front_pm(n: int, d: int) -> int:
    """현행 pctOf(Math.round(n/d*1000)/10) 의 천분율 정수(JS Math.round = floor(x + 0.5), 부동소수 나눗셈 그대로)."""
    return math.floor(n / d * 1000 + 0.5) if d > 0 else 0


def add_pm(by: dict[str, dict[str, Any]], den: int) -> None:
    total = sum(w["citations"] for w in by.values())
    for w in by.values():
        w["share_pm"], w["coverage_pm"] = front_pm(w["citations"], total), front_pm(w["answers"], den)


def steps(*names: str) -> list[Sql]:
    return [Sql(PROMPT_SQL["global"]), Sql(BG["src_first"])] + [Sql(BG[n]) for n in names]


async def get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


async def expected(conn) -> tuple[dict[str, dict[str, Any]], int]:
    rows = await raw_fetch(conn, EXPECT_SQL, HQ_BGRPS)
    by = {r["skey"]: {k: int(v) for k, v in r.items() if k != "skey"} for r in rows}
    for i, k in enumerate(sorted(by, key=lambda k: (-by[k]["citations"], k)), 1):
        by[k]["rank"] = i
    den = int((await raw_fetch(conn, DEN_SQL, HQ_BGRPS))[0]["n"])
    add_pm(by, den)
    return by, den


def expected_order(want: dict[str, dict[str, Any]], sort: str, direction: str | None, fields: dict[str, str] = SORT_FIELD) -> list[str]:
    """현행 표 정렬 규칙의 파이썬 재현: 인용 순 배열을 기준 키로 안정 정렬(동률 = 인용 순위 rank), skey 는 문자열 순.
    share·coverage 의 기준 키는 표시값(반올림 천분율). fields=RAW_FIELD 는 원시 수 정렬(검증 D3 이전 동작, 대조용)."""
    d = direction or ("asc" if sort == "skey" else "desc")
    if sort == "skey":
        return sorted(want, reverse=(d == "desc"))
    f = fields[sort]
    return sorted(want, key=lambda k: ((-want[k][f]) if d == "desc" else want[k][f], want[k]["rank"]))


async def pages(client_as, uid, limit: int, **params) -> tuple[list[dict], set[int]]:
    items: list[dict] = []
    totals: set[int] = set()
    cursor = None
    for _ in range(30):
        b = (await get(client_as, uid, limit=limit, **params, **({"cursor": cursor} if cursor else {}))).json()
        items += b["data"]["items"]
        totals.add(b["meta"]["page"]["total"])
        cursor = b["meta"]["page"]["next_cursor"]
        if not cursor:
            return items, totals
    raise AssertionError("페이지가 끝나지 않음")


# ── BG-24 인용 프롬프트 수 · 인용 순위 rank ─────────────────────────────────────────────
async def test_bg24_citing_prompts_and_rank(client_as):
    async with staged(*steps()) as conn:
        want, den = await expected(conn)
        assert (want["reddit.com"]["citations"], want["reddit.com"]["prompts"], want["reddit.com"]["answers"]) == (9, 4, 8)   # 손 계산
        assert (want["example.org"]["prompts"], want["hyundai.com"]["prompts"], den) == (1, 2, 14)
        b = (await get(client_as, HQ_HYUNDAI, **G)).json()
        assert b["meta"]["cycles"] == ["2026-09-23"]
        assert b["data"]["summary"]["total_citations"] == sum(w["citations"] for w in want.values()) == 22
        got = {i["skey"]: i for i in b["data"]["items"]}
        assert set(got) == set(want)
        for k, w in want.items():
            i = got[k]
            assert (i["citations"], i["citing_prompts"], i["citing_answers"], i["rank"]) == (w["citations"], w["prompts"], w["answers"], w["rank"]), k
            assert i["coverage"] == {"num": w["answers"], "den": den}
        assert [i["rank"] for i in b["data"]["items"]] == list(range(1, 8))                     # 기본 정렬 = 인용 순위
        # 엔진 필터(9105 deepseek PF{1,2}): 필터가 새 열에도 같은 모집단으로 걸린다
        ds = (await get(client_as, HQ_HYUNDAI, **G, engine="deepseek")).json()["data"]["items"]
        assert {(i["skey"], i["citations"], i["citing_prompts"], i["rank"]) for i in ds} == {("hyundai.com", 1, 1, 1), ("reddit.com", 1, 1, 2)}


async def test_bg24_fixture_surfaces_without_staging(client_as):
    """준비 없는 픽스처: 글로벌 k1(프롬프트 1개) → 전 출처 1, 프로젝트 k31 → example.com·hyundaiusa.com 각 1."""
    g = (await get(client_as, ADMIN, **G)).json()["data"]["items"]
    assert g and all(i["citing_prompts"] == 1 for i in g)
    p = (await get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))).json()["data"]["items"]
    assert {(i["skey"], i["citing_prompts"], i["rank"]) for i in p} == {("example.com", 1, 1), ("hyundaiusa.com", 1, 2)}


# ── BG-21 정렬 ──────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("sort,direction", [("citations", None), ("citations", "asc"), ("share", None), ("coverage", None),
                                            ("coverage", "asc"), ("prompts", None), ("prompts", "asc"), ("skey", None), ("skey", "desc")])
async def test_bg21_sort_orders_and_keyset(client_as, sort, direction):
    async with staged(*steps()) as conn:
        want, _ = await expected(conn)
        params = {**G, "sort": sort} | ({"dir": direction} if direction else {})
        full = (await get(client_as, HQ_HYUNDAI, **params)).json()
        assert [i["skey"] for i in full["data"]["items"]] == expected_order(want, sort, direction), (sort, direction)
        seen, totals = await pages(client_as, HQ_HYUNDAI, 2, **params)                        # 키셋 페이지 이어 붙이기 = 전체
        assert [i["skey"] for i in seen] == [i["skey"] for i in full["data"]["items"]] and totals == {7}


async def test_bg21_sort_cursor_bound_to_sort(client_as):
    async with staged(*steps()):
        first = (await get(client_as, HQ_HYUNDAI, **G, sort="prompts", limit=2)).json()["meta"]["page"]["next_cursor"]
        r = await get(client_as, HQ_HYUNDAI, **G, sort="coverage", limit=2, cursor=first)       # 다른 정렬로 재사용
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        base = (await get(client_as, HQ_HYUNDAI, **G, limit=2)).json()["meta"]["page"]["next_cursor"]
        r = await get(client_as, HQ_HYUNDAI, **G, limit=2, cursor=base, q="a")                   # 검색어가 다르면 필터 해시가 다르다
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        r = await get(client_as, HQ_HYUNDAI, **G, limit=2, cursor=base, sort="citations", dir="desc")   # 기본과 같은 정렬 = 같은 커서
        assert r.status_code == 200 and len(r.json()["data"]["items"]) == 2


# ── BG-21 검색 ──────────────────────────────────────────────────────────────────────
async def test_bg21_search_narrows_rows_only(client_as):
    async with staged(*steps()) as conn:
        want, den = await expected(conn)
        base = (await get(client_as, HQ_HYUNDAI, **G)).json()
        r = (await get(client_as, HQ_HYUNDAI, **G, q="HYUNDAI")).json()                         # 대소문자 무시 부분 일치(skey)
        exp = [k for k in expected_order(want, "citations", None) if "hyundai" in k]
        assert [i["skey"] for i in r["data"]["items"]] == exp == ["linkedin.com/hyundai-motor-group", "hyundai.com", "hyundaiusa.com"]
        assert r["meta"]["page"]["total"] == 3
        assert r["data"]["summary"] == base["data"]["summary"]                                   # 요약·분모는 전체 모집단
        assert r["data"]["competitor_totals"] == base["data"]["competitor_totals"]
        by = {i["skey"]: i for i in r["data"]["items"]}
        assert by["hyundai.com"]["rank"] == want["hyundai.com"]["rank"] and by["hyundai.com"]["share"] == {"num": 2, "den": 22}
        for lit in ("%", "_", "\\"):                                                              # 와일드카드는 글자 그대로
            x = (await get(client_as, HQ_HYUNDAI, **G, q=lit)).json()
            assert x["data"]["items"] == [] and x["meta"]["page"]["total"] == 0, lit
        s = (await get(client_as, HQ_HYUNDAI, **G, q="hyundai", sort="skey", limit=2)).json()     # 검색 + 정렬 + 키셋
        assert [i["skey"] for i in s["data"]["items"]] == ["hyundai.com", "hyundaiusa.com"] and s["meta"]["page"]["next_cursor"]
        assert den == base["data"]["summary"]["answers_den"]


# ── BG-20 경쟁사 옵션·선택 ────────────────────────────────────────────────────────────
async def test_bg20_competitor_sources_and_skey_selection(client_as):
    async with staged(*steps("competitor")) as conn:
        want, _ = await expected(conn)
        comp_keys = sorted((k for k, w in want.items() if w["category_key"] == 2), key=lambda k: (-want[k]["citations"], k))
        assert comp_keys == ["reddit.com", "caranddriver.com", "foo-bar.xyz"]                    # 오버라이드로만 경쟁사인 reddit 포함
        b = (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true")).json()["data"]
        assert [(x["skey"], x["citations"], x["brand"]) for x in b["competitor_sources"]] == \
            [("reddit.com", 9, None), ("caranddriver.com", 1, "BMW"), ("foo-bar.xyz", 1, None)]
        assert b["competitor_totals"] == [{"brand": "BMW", "citations": 1, "sources": 1}]
        assert (await get(client_as, HQ_HYUNDAI, **G)).json()["data"]["competitor_sources"] is None   # 요청 없으면 싣지 않는다
        # q·skey 와 무관(옵션 목록), 출처 카테고리 필터와는 같은 모집단
        assert len((await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true", q="zzz")).json()["data"]["competitor_sources"]) == 3
        assert (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true", source="officialHmg")).json()["data"]["competitor_sources"] == []
        # 선택(skey[]): 고른 출처 행만, 요약·share 분모는 전체
        sel = (await get(client_as, HQ_HYUNDAI, **G, skey=["caranddriver.com", "foo-bar.xyz", "no-such.example"])).json()
        assert [i["skey"] for i in sel["data"]["items"]] == ["caranddriver.com", "foo-bar.xyz"] and sel["meta"]["page"]["total"] == 2
        assert sel["data"]["summary"]["total_citations"] == 22 and sel["data"]["items"][0]["share"] == {"num": 1, "den": 22}
        assert sum(i["citations"] for i in sel["data"]["items"]) == want["caranddriver.com"]["citations"] + want["foo-bar.xyz"]["citations"]
        # 스코프 밖 계정: 옵션·행 모두 0(누출 없음)
        k = (await get(client_as, KIA_US, **G, competitor_sources="true", skey=["reddit.com"])).json()["data"]
        assert k["items"] == [] and k["competitor_sources"] == [] and k["summary"]["total_citations"] == 0


async def test_bg20_empty_window_competitor_sources(client_as):
    r = (await get(client_as, ADMIN, **G, competitor_sources="true", **{"from": "2025-01-01", "to": "2025-01-31"})).json()
    assert r["data"]["competitor_sources"] == [] and r["data"]["items"] == []


# ── 잘못된 파라미터 422 ──────────────────────────────────────────────────────────────
@pytest.mark.parametrize("extra", [{"sort": "domain"}, {"dir": "up"}, {"q": "a\x00b"}, {"q": "x" * 201}, {"skey": "a\x01"},
                                   {"skey": [f"s{i}.com" for i in range(101)]}, {"competitor_sources": "maybe"}])
async def test_bg_invalid_params_422(client_as, extra):
    r = await get(client_as, ADMIN, **G, **extra)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (extra, r.text)


# ── BG-22 내보내기 ─────────────────────────────────────────────────────────────────────
def _csv(body: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))


async def test_bg22_export_csv_matches_list(client_as):
    async with staged(*steps("competitor")) as conn:
        want, den = await expected(conn)
        r = await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", sort="prompts")
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/csv") and r.headers["cache-control"] == "no-store"
        assert "citation-sources-" in r.headers["content-disposition"] and "x-export-truncated" not in r.headers
        rows = _csv(r.content)
        assert rows[0] == ["#", "도메인", "카테고리", "인용 수", "점유율", "프롬프트", "커버리지"]
        order = expected_order(want, "prompts", None)
        assert [x[1] for x in rows[1:]] == order
        total = sum(w["citations"] for w in want.values())
        ko = {1: "공식 (HMG)", 2: "공식 (경쟁사)", 4: "자동차 미디어", 5: "뉴스·미디어", 6: "커뮤니티·포럼", 13: "기타"}
        for x in rows[1:]:
            w = want[x[1]]
            assert x == [str(w["rank"]), x[1], ko[w["category_key"]], str(w["citations"]), f"{round(1000 * w['citations'] / total) / 10}",
                         str(w["prompts"]), f"{round(1000 * w['answers'] / den) / 10}"], x
        en = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", locale="en", q="reddit")).content)
        assert en[0] == ["#", "Domain", "Category", "Citations", "Share %", "Prompts", "Coverage Rate"]
        assert en[1:] == [["1", "reddit.com", "Official (Competitor)", "9", "40.9", "4", "57.1"]]              # 9/22 = 40.9 · 8/14 = 57.1
        sel = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", skey=["foo-bar.xyz"])).content)
        assert [x[1] for x in sel[1:]] == ["foo-bar.xyz"]


async def test_bg22_export_xlsx_route_and_truncation(client_as, monkeypatch):
    async with staged(*steps()):
        r = await get(client_as, HQ_HYUNDAI, EXPORT, **G)                                       # 기본 xlsx(드릴다운 경로에 먹히지 않는다)
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            sheet = next(n for n in z.namelist() if n.startswith("xl/worksheets/"))
            xml = z.read(sheet).decode("utf-8")
        assert "reddit.com" in xml and "linkedin.com/hyundai-motor-group" in xml
        monkeypatch.setattr(domains_service, "EXPORT_MAX_ROWS", 2)
        t = await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv")
        assert t.headers["x-export-truncated"] == "true" and [x[1] for x in _csv(t.content)[1:]] == ["reddit.com", "linkedin.com/hyundai-motor-group"]


async def test_bg22_export_auth_scope_and_422(client_as):
    assert (await get(client_as, None, EXPORT, **G)).status_code == 401
    assert (await get(client_as, SUSPENDED, EXPORT, **G)).status_code == 401
    r = await get(client_as, VENDOR, EXPORT, **G)                                               # 표면 게이트(vendor 는 global 불가)
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    k = await get(client_as, KIA_US, EXPORT, **G, format="csv")                                 # 스코프 밖 모집단: 헤더만
    assert k.status_code == 200 and len(_csv(k.content)) == 1
    empty = await get(client_as, ADMIN, EXPORT, **G, format="csv", **{"from": "2025-01-01", "to": "2025-01-31"})
    assert empty.status_code == 200 and len(_csv(empty.content)) == 1
    for bad in ({"format": "pdf"}, {"locale": "fr"}, {"sort": "nope"}, {"limit": 1, "surface": "nope"}, {"from": "2026-09-02", "to": "2026-09-01"}):
        r = await get(client_as, ADMIN, EXPORT, **{**G, **bad})
        assert r.status_code == 422, (bad, r.text)


# ── 검증 수정 D1: 표면별 '#' 규칙(rank = 검색 전, match_rank = 검색 뒤) ─────────────────────────────
def front_view_rows(want: dict[str, dict[str, Any]], q: str, sort: str, direction: str | None) -> list[tuple[int, str]]:
    """현행 citations-view.tsx:277-280(웹사이트·프로젝트) 재현: 인용 순 배열 → 검색 → 번호(i+1) → 안정 정렬."""
    base = [k for k in sorted(want, key=lambda k: (-want[k]["citations"], k)) if q.lower() in k.lower()]
    num = {k: i for i, k in enumerate(base, 1)}
    order = [k for k in expected_order(want, sort, direction) if k in num]
    return [(num[k], k) for k in order]


async def test_d1_match_rank_after_search(client_as):
    """재현(검증 D1): q=com 이면 rank 는 [1,2,4,5,7](전체 순위), 현행 웹사이트·프로젝트 표 '#' 는 검색 뒤 1..5 다."""
    async with staged(*steps()) as conn:
        want, _ = await expected(conn)
        b = (await get(client_as, HQ_HYUNDAI, **G, q="com")).json()["data"]["items"]
        assert [i["rank"] for i in b] == [1, 2, 4, 5, 7]                                       # 표준 표 '#'(검색 전 번호) 그대로
        assert [i["match_rank"] for i in b] == [1, 2, 3, 4, 5]
        assert [(i["match_rank"], i["skey"]) for i in b] == front_view_rows(want, "com", "citations", None)
        for sort, d in (("prompts", None), ("skey", "desc"), ("coverage", "asc")):          # 기본이 아닌 정렬: 번호는 정렬과 무관
            items, _ = await pages(client_as, HQ_HYUNDAI, 2, **G, q="com", sort=sort, **({"dir": d} if d else {}))
            assert [(i["match_rank"], i["skey"]) for i in items] == front_view_rows(want, "com", sort, d), (sort, d)
        full = (await get(client_as, HQ_HYUNDAI, **G)).json()["data"]["items"]              # 검색 없으면 두 번호가 같다
        assert all(i["rank"] == i["match_rank"] for i in full)
        sel = (await get(client_as, HQ_HYUNDAI, **G, skey=["hyundaiusa.com", "reddit.com"])).json()["data"]["items"]
        assert [(i["skey"], i["rank"], i["match_rank"]) for i in sel] == [("reddit.com", 1, 1), ("hyundaiusa.com", 7, 2)]


async def test_d1_export_rank_basis(client_as):
    """재현(검증 D1): export q=com csv '#' 가 1,2,4,5,7 이었다. global 표면 기본은 표준 표 규칙(검색 전), match 는 검색 뒤 번호."""
    async with staged(*steps()) as conn:
        want, _ = await expected(conn)
        g = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", q="com")).content)[1:]
        assert [x[0] for x in g] == ["1", "2", "4", "5", "7"]                                   # 표준 표(citations-standard-view:559-560)
        m = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", q="com", sort="prompts", rank_basis="match")).content)[1:]
        assert [(int(x[0]), x[1]) for x in m] == front_view_rows(want, "com", "prompts", None)
        assert [x[0] for x in m] != [x[0] for x in g]
        gg = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", q="com", rank_basis="global")).content)[1:]
        assert gg == g
    # 프로젝트 표면 기본 = match(citations-view 규칙): example.com 3 · hyundaiusa.com 1 → q=hyundai 면 rank 2, '#' 1
    pj = {"surface": "project", "project_id": str(CUST_PROJECT)}
    lst = (await get(client_as, VENDOR, **pj, q="hyundai")).json()["data"]["items"]
    assert [(i["skey"], i["rank"], i["match_rank"]) for i in lst] == [("hyundaiusa.com", 2, 1)]
    x = _csv((await get(client_as, VENDOR, EXPORT, **pj, format="csv", q="hyundai")).content)[1:]
    assert [(r[0], r[1]) for r in x] == [("1", "hyundaiusa.com")]
    y = _csv((await get(client_as, VENDOR, EXPORT, **pj, format="csv", q="hyundai", rank_basis="global")).content)[1:]
    assert [(r[0], r[1]) for r in y] == [("2", "hyundaiusa.com")]


# ── 검증 수정 D2: 표준 표 경쟁사 선택(applyCompetitorPick) · 상위 100 ──────────────────────────────
def front_standard_rows(want: dict[str, dict[str, Any]], picked: set[str], q: str, sort: str, direction: str | None,
                        limit: int) -> list[tuple[int, str]]:
    """현행 citations-standard-view.tsx:559-567 재현: 인용 순 배열 → applyCompetitorPick → 번호 → 검색 → 안정 정렬 → 상위 limit."""
    ordered = sorted(want, key=lambda k: (-want[k]["citations"], k))
    base = [k for k in ordered if not picked or want[k]["category_key"] != 2 or k in picked]
    num = {k: i for i, k in enumerate(base, 1)}
    order = [k for k in expected_order(want, sort, direction) if k in num and q.lower() in k.lower()]
    return [(num[k], k) for k in order][:limit]


async def test_d2_competitor_pick_list_and_export(client_as):
    """재현(검증 D2): 경쟁사 선택 시 현행 표·파일은 비경쟁 행 전부 + 고른 경쟁 행, 선택 뒤 번호, 상위 100.
    API skey[] 는 고른 행만, 안 주면 다른 경쟁 행까지 담고 번호는 전체 순위였다."""
    async with staged(*steps("competitor")) as conn:
        want, _ = await expected(conn)
        picked = {"caranddriver.com"}
        base = (await get(client_as, HQ_HYUNDAI, **G)).json()["data"]
        r = (await get(client_as, HQ_HYUNDAI, **G, competitor=sorted(picked))).json()
        items = r["data"]["items"]
        assert [(i["rank"], i["skey"]) for i in items] == front_standard_rows(want, picked, "", "citations", None, 100)
        assert "reddit.com" not in {i["skey"] for i in items} and "foo-bar.xyz" not in {i["skey"] for i in items}
        assert r["meta"]["page"]["total"] == 5
        assert r["data"]["summary"] == base["summary"] and r["data"]["competitor_totals"] == base["competitor_totals"]
        assert {i["skey"]: i["share"] for i in items}["caranddriver.com"] == {"num": 1, "den": 22}   # 분모는 전체 모집단
        # 검색 + 정렬 + 선택: rank = 선택 뒤·검색 전 번호(표준), match_rank = 선택·검색 뒤 번호
        for q_, sort, d in (("com", "citations", None), ("o", "prompts", None), ("", "skey", "desc"), ("hyundai", "coverage", "asc")):
            got, _ = await pages(client_as, HQ_HYUNDAI, 2, **G, competitor=sorted(picked), sort=sort,
                                 **({"q": q_} if q_ else {}), **({"dir": d} if d else {}))
            assert [(i["rank"], i["skey"]) for i in got] == front_standard_rows(want, picked, q_, sort, d, 100), (q_, sort, d)
        # 내보내기: 표준 화면 규칙(global 표면 기본 '#' = rank) + max_rows(현행 상위 100, 여기선 3 으로 자름 확인)
        csv_rows = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", competitor=sorted(picked), q="o", sort="prompts")).content)[1:]
        assert [(int(x[0]), x[1]) for x in csv_rows] == front_standard_rows(want, picked, "o", "prompts", None, 100)
        cut = await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", competitor=sorted(picked), max_rows=3)
        assert [(int(x[0]), x[1]) for x in _csv(cut.content)[1:]] == front_standard_rows(want, picked, "", "citations", None, 3)
        assert "x-export-truncated" not in cut.headers                                          # 요청한 max_rows 로 자른 것은 표시하지 않는다
        # 공식(경쟁사) 행이 아닌 skey 를 고르면 경쟁 행만 전부 빠진다(현행: picked 비어 있지 않으면 공식(경쟁사) 중 고른 것만)
        other = (await get(client_as, HQ_HYUNDAI, **G, competitor=["hyundai.com"])).json()["data"]["items"]
        assert [(i["rank"], i["skey"]) for i in other] == front_standard_rows(want, {"hyundai.com"}, "", "citations", None, 100)
        # 선택이 바뀌면 커서 필터 해시가 달라진다
        c1 = (await get(client_as, HQ_HYUNDAI, **G, limit=2, competitor=sorted(picked))).json()["meta"]["page"]["next_cursor"]
        bad = await get(client_as, HQ_HYUNDAI, **G, limit=2, cursor=c1)
        assert bad.status_code == 422 and bad.json()["error"]["code"] == "cursor_invalid"


async def test_d2_competitor_pick_without_competitor_category(client_as):
    """공식(경쟁사) 행이 없는 모집단(준비 없는 기본 staged): 선택해도 거를 행이 없다(현행 applyCompetitorPick 과 같다)."""
    async with staged(*steps()):
        a = (await get(client_as, HQ_HYUNDAI, **G)).json()["data"]["items"]
        b = (await get(client_as, HQ_HYUNDAI, **G, competitor=["caranddriver.com"])).json()["data"]["items"]
        assert a == b


@pytest.mark.parametrize("extra", [{"competitor": "a\x01"}, {"competitor": [f"s{i}.com" for i in range(101)]}, {"rank_basis": "page"},
                                   {"max_rows": 0}, {"max_rows": 5001}, {"max_rows": "x"}])
async def test_d1_d2_export_invalid_params_422(client_as, extra):
    r = await get(client_as, ADMIN, EXPORT, **G, **extra)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (extra, r.text)


# ── 검증 수정 D3: 점유율·커버리지 정렬 = 표시값(반올림 퍼센트) 기준 ─────────────────────────────────
async def test_d3_share_sort_by_display_percent(client_as):
    """재현(검증 D3): 표시 점유율이 같은(49.5%) caranddriver 1,001 · foo-bar 1,002 를 share 오름차순으로 정렬하면 원시 수 정렬은
    caranddriver → foo-bar, 현행 표(pctOf 비교 + 안정 정렬)는 인용 순위대로 foo-bar → caranddriver 다."""
    async with staged(*steps("share_tie")) as conn:
        want, _ = await expected(conn)
        assert (want["caranddriver.com"]["citations"], want["foo-bar.xyz"]["citations"]) == (1001, 1002)
        assert want["caranddriver.com"]["share_pm"] == want["foo-bar.xyz"]["share_pm"] == 495                     # 둘 다 49.5%
        exp = expected_order(want, "share", "asc")
        assert exp != expected_order(want, "share", "asc", RAW_FIELD)                                            # 원시 수 정렬과 갈리는 자료
        assert exp[-2:] == ["foo-bar.xyz", "caranddriver.com"]
        for d in ("asc", "desc", None):
            items, totals = await pages(client_as, HQ_HYUNDAI, 2, **G, sort="share", **({"dir": d} if d else {}))
            assert [i["skey"] for i in items] == expected_order(want, "share", d) and totals == {7}, d
        # 표시값도 같다(현행 toFixed(1)): 목록 share 비율과 내보내기 점유율 열
        by = {i["skey"]: i for i in (await get(client_as, HQ_HYUNDAI, **G)).json()["data"]["items"]}
        assert by["foo-bar.xyz"]["share"] == {"num": 1002, "den": 2023} and by["caranddriver.com"]["share"] == {"num": 1001, "den": 2023}
        x = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", sort="share", dir="asc")).content)[1:]
        assert [r[1] for r in x] == exp and [r[4] for r in x[-2:]] == ["49.5", "49.5"]
        # 이전 빌드의 원시 수 커서(sort 'share:asc')는 받지 않는다: 정렬 식별자가 share_pm 으로 바뀌었다
        assert domains_queries.sort_spec("share", "asc").cursor_sort == "share_pm:asc"
        assert domains_queries.sort_spec("coverage", None).cursor_sort == "coverage_pm:desc"


@pytest.mark.parametrize("den", [10_000, 100_000])
async def test_d3_coverage_sort_by_display_percent(client_as, monkeypatch, den):
    """재현(검증 D3): 커버리지 분모가 크면 citing_answers 가 달라도 표시값이 같다(분모 1만: reddit 8·linkedin 6 → 둘 다 0.1%,
    나머지 2·1 → 0.0%). 분모는 커버리지 분모 질의를 상수로 바꿔 만든다(목록 coverage.den 도 같은 값)."""
    from app.core.sqlb import Sql as QSql
    monkeypatch.setattr(domains_queries, "answers_den_sql", lambda *a, **k: QSql(f"SELECT {den}::int8 AS answers"))
    async with staged(*steps()) as conn:
        want, _ = await expected(conn)
        add_pm(want, den)
        for d in ("asc", "desc"):
            exp = expected_order(want, "coverage", d)
            if d == "asc":
                assert exp != expected_order(want, "coverage", d, RAW_FIELD)                                     # 원시 수 정렬과 갈린다
            items, _ = await pages(client_as, HQ_HYUNDAI, 2, **G, sort="coverage", dir=d)
            assert [i["skey"] for i in items] == exp, (den, d)
            assert all(i["coverage"]["den"] == den for i in items)
            x = _csv((await get(client_as, HQ_HYUNDAI, EXPORT, **G, format="csv", sort="coverage", dir=d)).content)[1:]
            assert [r[1] for r in x] == exp


# ── 검증 수정 D4: limit=0 에서도 meta.page.total = 좁힌 행 수 ──────────────────────────────────────
async def test_d4_limit0_total_narrowed(client_as):
    """재현(검증 D4): limit=0&q=reddit 의 meta.page.total 이 전체 출처 수 7 이었다(설명: q·skey 는 total 을 좁힌다)."""
    async with staged(*steps("competitor")):
        base = (await get(client_as, HQ_HYUNDAI, **G, limit=0)).json()
        assert base["meta"]["page"]["total"] == 7 and base["data"]["items"] == []                               # 좁힘 없으면 전체 출처 수(이전과 같다)
        cases = ({"q": "reddit"}, {"q": "zzz"}, {"skey": ["reddit.com", "hyundai.com", "no-such.example"]},
                 {"competitor": ["caranddriver.com"]}, {"q": "com", "competitor": ["caranddriver.com"]})
        for extra in cases:
            z = (await get(client_as, HQ_HYUNDAI, **G, limit=0, **extra)).json()
            full = (await get(client_as, HQ_HYUNDAI, **G, limit=200, **extra)).json()
            assert z["data"]["items"] == [] and z["meta"]["page"]["total"] == full["meta"]["page"]["total"] == len(full["data"]["items"]), extra
            assert z["data"]["summary"] == base["data"]["summary"] and z["data"]["competitor_totals"] == base["data"]["competitor_totals"]
        assert (await get(client_as, HQ_HYUNDAI, **G, limit=0, q="reddit")).json()["meta"]["page"]["total"] == 1


# ── 검증 수정 D5: skey[]·competitor[] 순서·중복은 커서 해시에 영향 없음 ─────────────────────────────
async def test_d5_cursor_hash_set_params_order_insensitive(client_as):
    """재현(검증 D5): limit=1&skey=reddit.com&skey=hyundai.com 의 next_cursor 로 skey 순서만 바꿔 요청하면 422 cursor_invalid 였다."""
    async with staged(*steps("competitor")):
        first = (await get(client_as, HQ_HYUNDAI, **G, limit=1, skey=["reddit.com", "hyundai.com"])).json()
        assert [i["skey"] for i in first["data"]["items"]] == ["reddit.com"]
        cur = first["meta"]["page"]["next_cursor"]
        for skeys in (["hyundai.com", "reddit.com"], ["hyundai.com", "reddit.com", "reddit.com"]):
            r = await get(client_as, HQ_HYUNDAI, **G, limit=1, skey=skeys, cursor=cur)
            assert r.status_code == 200, (skeys, r.text)
            assert [i["skey"] for i in r.json()["data"]["items"]] == ["hyundai.com"] and r.json()["meta"]["page"]["next_cursor"] is None
        c1 = (await get(client_as, HQ_HYUNDAI, **G, limit=2, competitor=["caranddriver.com", "foo-bar.xyz"])).json()["meta"]["page"]["next_cursor"]
        r = await get(client_as, HQ_HYUNDAI, **G, limit=2, competitor=["foo-bar.xyz", "caranddriver.com"], cursor=c1)
        assert r.status_code == 200, r.text
        # 집합이 다르면 여전히 다른 해시
        r = await get(client_as, HQ_HYUNDAI, **G, limit=1, skey=["reddit.com"], cursor=cur)
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


# ── core 9 U7-2: 경쟁사 출처 상한 5000 + meta.truncated ───────────────────────────
async def test_competitor_sources_cap_and_meta_truncated_u72(client_as, monkeypatch):
    """competitor_sources=true 응답은 meta.truncated.competitor_sources(상한에 걸렸는가)를 싣는다. 요청하지 않으면 키가 없다.
    상한 5000(stg 단일 프로젝트 최대 900). 쿼리는 상한 + 1 행을 읽어 잘림을 판정한다: 상한을 2 로 줄이면 3개 중 2개 + true."""
    assert domains_service.COMPETITOR_SOURCES_MAX == 5000
    async with staged(*steps("competitor")):
        body = (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true")).json()
        assert body["meta"]["truncated"] == {"competitor_sources": False} and len(body["data"]["competitor_sources"]) == 3
        assert "truncated" not in (await get(client_as, HQ_HYUNDAI, **G)).json()["meta"]
        empty = (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true", mention_brand="No Such Brand")).json()
        assert empty["data"]["competitor_sources"] == [] and empty["meta"]["truncated"] == {"competitor_sources": False}
        monkeypatch.setattr(domains_service, "COMPETITOR_SOURCES_MAX", 2)
        body = (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true")).json()
        assert [x["skey"] for x in body["data"]["competitor_sources"]] == ["reddit.com", "caranddriver.com"]
        assert body["meta"]["truncated"] == {"competitor_sources": True}
        monkeypatch.setattr(domains_service, "COMPETITOR_SOURCES_MAX", 3)                  # 정확히 상한 = 잘림 아님
        body = (await get(client_as, HQ_HYUNDAI, **G, competitor_sources="true")).json()
        assert len(body["data"]["competitor_sources"]) == 3 and body["meta"]["truncated"] == {"competitor_sources": False}
