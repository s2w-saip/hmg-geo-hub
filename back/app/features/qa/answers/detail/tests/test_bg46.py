"""BG-46(값 갭 보강): 검수 상세 인용 url_norm·url_base_norm, ACR 셀 acr_cell_key.

기대값은 소유자 접속 독립 SQL(구현과 다른 경로: 표면·회차 술어 없이 answer_key 로만 rd.citation ⋈ rd.dim_url)과 손계산이다.
비서빙 job 인용은 rd.dim_url 에 있는 URL 이면 저장값(검증 BG46-NONSERVED), 없으면 원문 url 에 적재기 식을 적용한 값(검증 D-01).
answer.run_id·region·prompt_run_id·ACR 셀 prompt_run_id 는 DB-v2.9 P63(rd.v_answer_body 끝 열·rd.v_acr_cell_run)으로 core 8라운드에 반영:
기대값은 소유자 접속으로 그 뷰를 직접 읽는다(기능 코드·시험은 ing 를 참조하지 않는다: SQL 가드 G3). 뷰 = ing 원천 대조는 core 시험
tests/core/test_db_v29.py::test_qa_views_match_ing_p63 이 한다.
"""
from __future__ import annotations

import pathlib
import re
import uuid

import asyncpg
import pytest

from app.core.urls import normalize_url_base_for_match, normalize_url_for_match
from app.features.qa.answers.list.tests.qa_support import db_exec, db_rows, db_val, job_id_of, new_session, qa_client, use_qa_scope
from tests.support import DB_URL, load_named_sql, needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]
SQL = load_named_sql(pathlib.Path(__file__).with_name("bg46.pgsql"))
BACK = pathlib.Path(__file__).resolve().parents[6]


async def _detail(client_as, answer_key: int):
    rv = await new_session("검수자")
    async with qa_client(client_as, rv) as c:
        return await c.get(f"/v1/qa/answers/{await job_id_of(answer_key)}")


async def _want_urls(answer_key: int) -> dict[int, tuple[str | None, str | None]]:
    """구현과 다른 경로: 회차는 rd.cycle 전체, 날짜는 넓은 범위(구현은 이 job 의 cyc_key·round_date 등치)."""
    surface = await db_val("SELECT surface FROM rd.job WHERE answer_key = $1", answer_key)
    cycles = [int(r["cyc_key"]) for r in await db_rows("SELECT cyc_key FROM rd.cycle")]
    rows = await db_rows("SELECT c.ord, u.url_norm, u.url_base_norm FROM rd.citation c JOIN rd.dim_url u ON u.url_key = c.url_key "
                         "WHERE c.surface = $1 AND c.round_date BETWEEN '2000-01-01' AND '2100-12-31' AND c.cyc_key = ANY($2::int4[]) "
                         "AND c.answer_key = $3", surface, cycles, answer_key)
    return {int(r["ord"]): (r["url_norm"], r["url_base_norm"]) for r in rows}


@pytest.mark.parametrize("answer_key", [1, 5, 21, 22, 31])          # global 2·website 2·project 1(인용 있는 서빙 답변 전부)
async def test_citation_url_norm_matches_dim_url(client_as, answer_key):
    r = await _detail(client_as, answer_key)
    assert r.status_code == 200, r.text
    cits = r.json()["data"]["citations"]
    want = await _want_urls(answer_key)
    assert want and len(cits) == len(want)
    assert {c["ord"]: (c["url_norm"], c["url_base_norm"]) for c in cits} == want


async def test_citation_url_norm_hand_values(client_as):
    cits = {c["ord"]: c for c in (await _detail(client_as, 1)).json()["data"]["citations"]}
    # 손계산(픽스처 URL): 추적 파라미터·www 제거, 쿼리 있는 홈은 base 가 호스트만
    assert (cits[1]["url"], cits[1]["url_norm"], cits[1]["url_base_norm"]) == (
        "https://www.hyundai.com/au/en/cars/suv?utm_source=x", "hyundai.com/au/en/cars/suv", "hyundai.com/au/en/cars/suv")
    assert (cits[9]["url_norm"], cits[9]["url_base_norm"]) == ("hyundaiusa.com/?x=1", "hyundaiusa.com")
    assert cits[1]["target_key"].endswith(":1") and cits[6]["override_category"] == "newsMedia"   # 기존 필드 그대로


async def _loader_norms(urls: list[str | None]) -> list[tuple[str | None, str | None]]:
    """적재기 정본 식(seed-3x-common.sql §1 pg_temp.cit_norm·cit_base_norm)을 한 접속에서 만들어 urls 에 적용한다(구현과 다른 경로)."""
    common = (BACK / "migration" / "seed" / "seed-3x-common.sql").read_text(encoding="utf-8")
    fns = [re.search(rf"CREATE OR REPLACE FUNCTION pg_temp\.{n}\(text\).*?\$f\$;", common, re.S) for n in ("cit_norm", "cit_base_norm")]
    assert all(fns)
    c = await asyncpg.connect(DB_URL)
    try:
        for f in fns:
            await c.execute(f.group(0))
        rows = await c.fetch("SELECT pg_temp.cit_norm(u), pg_temp.cit_base_norm(u) FROM unnest($1::text[]) WITH ORDINALITY x(u, i) ORDER BY i", urls)
    finally:
        await c.close()
    return [(r[0], r[1]) for r in rows]


async def test_nonserved_job_citations_url_norm_from_raw_url(client_as):
    """검증 D-01 재현: 비서빙(드롭) job 은 rd.citation 행이 없다. 예전에는 url_norm·url_base_norm 이 null(화면 빈 값 표시)이었고, 현행 미러는
    전 job 에 값이 있었다. 이제 원문 url 에 적재기 식을 적용한 값이 나온다(URL 없음·빈 문자열은 null)."""
    jid = await job_id_of(14)
    assert await db_val("SELECT served FROM rd.job WHERE answer_key = 14") is False
    await db_exec(SQL["nonserved_citation_insert"], jid)
    try:
        r = await _detail(client_as, 14)
        raw = [(int(x["ord"]), x["url"]) for x in await db_rows(SQL["nonserved_citation_urls"], jid)]
    finally:
        await db_exec(SQL["nonserved_citation_delete"], jid)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["answer"]["served"] is False and d["answer"]["dropped"] is True
    got = {c["ord"]: (c["url"], c["url_norm"], c["url_base_norm"]) for c in d["citations"]}
    assert sorted(got) == [1, 2, 3, 4]
    # 손계산
    assert got[1] == ("https://www.drop.test/a?utm_source=x", "drop.test/a", "drop.test/a")
    assert got[2][1:] == ("drop.test/b/?q=1", "drop.test/b")
    assert got[3] == (None, None, None) and got[4][1:] == (None, None)
    # 적재기 SQL 과 글자 단위로 같다(URL 이 있는 행)
    with_url = [(o, u) for o, u in raw if u]
    want = await _loader_norms([u for _, u in with_url])
    assert [got[o][1:] for o, _ in with_url] == want


async def test_nonserved_citation_known_url_uses_dim_url(client_as):
    """검증 BG46-NONSERVED 재현: 비서빙(드롭) job 에 rd.dim_url 에 이미 있는 URL 로 인용(ord 99)을 더하면 예전에는 url_norm 이 null 이었다.
    이제 원문 url 의 url_hash(sha256) 로 rd.dim_url 을 찾아 적재기가 저장한 값을 그대로 싣는다(기대값 = 소유자 접속으로 읽은 dim_url 행)."""
    known = (await db_rows("SELECT url, url_norm, url_base_norm FROM rd.dim_url WHERE url_key <> 0 AND url IS NOT NULL "
                           "AND url_norm IS NOT NULL AND url_hash = sha256(convert_to(url, 'UTF8')) ORDER BY url_key LIMIT 1"))[0]
    jid = await job_id_of(14)
    await db_exec(SQL["nonserved_citation_insert_one"], jid, 99, known["url"])
    try:
        r = await _detail(client_as, 14)
    finally:
        await db_exec(SQL["nonserved_citation_delete_one"], jid, 99)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["answer"]["served"] is False
    got = {c["ord"]: c for c in d["citations"]}
    assert (got[99]["url"], got[99]["url_norm"], got[99]["url_base_norm"]) == (known["url"], known["url_norm"], known["url_base_norm"])


async def test_nonserved_citation_dim_url_wins_over_python_norm(client_as):
    """BG46-NONSERVED 우선순위: dim_url 에 있는 URL 은 파이썬 식이 아니라 저장값을 쓴다. R3(NBSP trim 차이) 입력으로 두 값이 갈리게 해서
    API 가 적재기 값(dim_url)을 냈음을 확인한다. dim_url 에 없는 같은 모양의 URL 은 파이썬 식(2순위)으로 채워진다."""
    url = "\u00a0https://www.nbsp.test/p/"
    (loader_norm, loader_base), = await _loader_norms([url])
    assert loader_norm != normalize_url_for_match(url)                     # 두 경로가 실제로 갈리는 입력(R3)
    other = "\u00a0https://www.nbsp.test/q/"                                # dim_url 에 없는 URL
    uk = await db_val(SQL["dim_url_insert"], url, loader_norm, loader_base)
    jid = await job_id_of(14)
    await db_exec(SQL["nonserved_citation_insert_one"], jid, 97, url)
    await db_exec(SQL["nonserved_citation_insert_one"], jid, 98, other)
    try:
        r = await _detail(client_as, 14)
    finally:
        for o in (97, 98):
            await db_exec(SQL["nonserved_citation_delete_one"], jid, o)
        await db_exec(SQL["dim_url_delete"], uk)
    assert r.status_code == 200, r.text
    got = {c["ord"]: c for c in r.json()["data"]["citations"]}
    assert (got[97]["url_norm"], got[97]["url_base_norm"]) == (loader_norm, loader_base)
    assert (got[98]["url_norm"], got[98]["url_base_norm"]) == (normalize_url_for_match(other), normalize_url_base_for_match(other))


GOLDEN_BASE_URLS = ["https://www.Kia.com/us/en/ev9?utm_source=x&a=1#top", "http://hyundai.com/?gclid=abc", "  https://B.com/path///  ",
                    "www.d.com/q?_ga=1", "https://e.com/p#frag?x=1/", "https://f.com/a/?b#c/", "\x0bhttps://www.g.com/\f",
                    "HTTPS://WWW.I.COM", "https://", "ftp://www.j.com/x/", "https://www.www.k.com/"]
# 비ASCII 공백(NBSP)은 cit_base_norm 과만 대조한다: core.urls.normalize_url_for_match 의 trim 은 JS trim(유니코드 공백)이라
# 적재기 cit_norm(POSIX \s)과 여기서 갈린다(core 정합 요청 CORE-REQUESTS/bg-qa-platform.md R3). cit_base_norm 은 btrim 6문자 집합이라 같다.
NBSP_URLS = ["\u00a0https://h.com/", "https://h2.com/p\u00a0"]


async def test_url_base_norm_matches_loader_sql():
    """core.urls.normalize_url_base_for_match == pg_temp.cit_base_norm, normalize_url_for_match == pg_temp.cit_norm(비서빙 인용 채움 경로)."""
    want = await _loader_norms(GOLDEN_BASE_URLS)
    assert [(normalize_url_for_match(u), normalize_url_base_for_match(u)) for u in GOLDEN_BASE_URLS] == want
    assert [normalize_url_base_for_match(u) for u in NBSP_URLS] == [b for _, b in await _loader_norms(NBSP_URLS)]
    assert normalize_url_base_for_match(None) is None


async def test_citations_empty_job(client_as):
    d = (await _detail(client_as, 2)).json()["data"]                   # 서빙이지만 인용 0건
    assert d["citations"] == []


async def test_acr_cell_key(client_as):
    cells = (await _detail(client_as, 10)).json()["data"]["acr"]
    want = [int(r["acr_cell_key"]) for r in await db_rows(
        "SELECT cj.acr_cell_key FROM rd.acr_cell_job cj JOIN rd.acr_cell c USING (acr_cell_key) WHERE cj.answer_key = 10 "
        "ORDER BY c.round_date, cj.acr_cell_key")]
    assert [c["acr_cell_key"] for c in cells] == want == [501]
    assert (cells[0]["planned"], cells[0]["valid_turn1"], cells[0]["valid_acr"]) == (3, 3, 2)   # 기존 필드 그대로


async def test_scope_and_bad_param(client_as):
    """서버 검수 범위 밖 job 은 새 필드 포함 아무것도 내지 않는다(404), 잘못된 id 는 422."""
    rv = await new_session("검수자")
    async with qa_client(client_as, rv) as c:
        use_qa_scope(surfaces=("global",))
        r = await c.get(f"/v1/qa/answers/{await job_id_of(21)}")
        assert r.status_code == 404 and "citations" not in r.text
        assert (await c.get("/v1/qa/answers/not-a-uuid")).status_code == 422
        assert (await c.get(f"/v1/qa/answers/{uuid.uuid4()}")).status_code == 404


@pytest.mark.parametrize("answer_key", [1, 10, 21, 31])
async def test_head_run_region_prompt_run_from_ing(client_as, answer_key):
    """R1: 답변 머리 run_id·region·prompt_run_id = rd.v_answer_body 값(소유자 접속, 구현은 qa_gate). 원문 행은 답변마다 1개."""
    d = (await _detail(client_as, answer_key)).json()["data"]["answer"]
    want = await db_rows("SELECT run_id, region, prompt_run_id FROM rd.v_answer_body WHERE answer_key = $1", answer_key)
    assert len(want) == 1
    w = want[0]
    assert (d["run_id"], d["region"], d["prompt_run_id"]) == (str(w["run_id"]), w["region"],
                                                             str(w["prompt_run_id"]) if w["prompt_run_id"] else None)


async def test_acr_cell_prompt_run_id(client_as):
    """R2: ACR 셀 prompt_run_id = rd.v_acr_cell_run(셀 키 발급처 ing.acr_prompt_run 의 뷰) 값."""
    cells = (await _detail(client_as, 10)).json()["data"]["acr"]
    want = {int(r["acr_cell_key"]): str(r["prompt_run_id"]) for r in await db_rows(
        "SELECT acr_cell_key, prompt_run_id FROM rd.v_acr_cell_run WHERE acr_cell_key = ANY($1::int4[])", [c["acr_cell_key"] for c in cells])}
    assert [(c["acr_cell_key"], c["prompt_run_id"]) for c in cells] == [(k, want.get(k)) for k in (c["acr_cell_key"] for c in cells)]
    assert all(c["prompt_run_id"] for c in cells)
