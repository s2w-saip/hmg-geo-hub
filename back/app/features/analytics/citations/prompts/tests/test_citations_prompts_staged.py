"""GET /v1/citations/prompts(C-3) 검증 결함 회귀(D4·D6). 추가 합성 행 = staged.pgsql(@global), 창 주입 없이 실제 rd.cycle 경로.

추가 행(글로벌, 템플릿 k1 의 인용 원소 복사: ord 1·9 = 현대 자사, 5 = 호스트 없음, 나머지 비자사)
- 회차 13(09-22, 인용 숨김 2) · 14(09-23, 언급 숨김 3 → 인용 계열 포함, 새 스냅샷) · 15(09-24, 노출일 미래)
- 회차 14: PA{1,2,3}=3 자사 · PB{2,3,4}=3 미인용 · PC{9,2,3}=3 자사(PA 와 동률) · PD 10답변 13건 자사(2건×3 + 1건×7, job_id 는 answer_key 역순)
          · PE 호스트 없음만(버킷 밖) · PF deepseek 2건 자사(기본 엔진 밖) · PG elig 거짓(cit_in 밖)
- 회차 13: PH 4건 자사(숨김 → 밖) · 회차 15: PI 5건 자사(미래 → 밖)
기대값은 구현(rd.answer 답변 열 G-25)과 독립인 rd.citation 원소 스캔을 같은 테스트 안에서 계산해 대조한다.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.features.analytics.citations.prompts.tests.staged_db import owner_fetch, staged
from tests.support import HQ_HYUNDAI, needs_db

pytestmark = needs_db
URL = "/v1/citations/prompts"
SP1 = "b0000000-0000-4000-8000-000000000001"
PA, PB, PC, PD, PE, PF, PG, PH, PI = (f"c3a00000-0000-4000-8000-00000000000{i}" for i in range(1, 10))
HQ_BGRPS = [m for m in range(1, 32) if m & 9]           # 현대 관점 모집단 비트(Hyundai 1 | HMG 8)

# 독립 기대값: 노출 회차(servable ∧ view_date ≤ 오늘(KST) ∧ 인용 숨김 {1,2} 아님)를 먼저 고르고, 그 회차들의 인용 원소 스캔
CYCLES = """
SELECT array_agg(cyc_key ORDER BY cyc_key) AS ks FROM rd.cycle
 WHERE surface = 1 AND project_key = 1 AND servable AND view_date <= (now() AT TIME ZONE 'Asia/Seoul')::date
   AND hidden_scope NOT IN (1, 2) AND round_date BETWEEN $1 AND $2
"""
SCAN = """
SELECT dp.prompt_id::text AS pid, count(*) AS cites,
       bool_or(c.owner_key = ANY(SELECT o.owner_key FROM app.owned_base o WHERE o.brand_code = 'Hyundai')) AS owned,
       array_agg(DISTINCT e.code ORDER BY e.code) AS providers
  FROM rd.citation c JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key JOIN rd.dim_engine e ON e.engine_key = c.engine_key
 WHERE c.surface = 1 AND c.round_date BETWEEN $1 AND $2 AND c.cyc_key = ANY($5::int4[])
   AND c.cit_in AND c.source_key <> 0 AND c.bgrp = ANY($3::int2[]) AND (CASE WHEN $4::text IS NULL THEN c.dflt ELSE e.code = $4 END)
 GROUP BY dp.prompt_id
"""


async def expected(lo: date, hi: date, *, owned: bool, engine: str | None = None) -> list[tuple[str, int, list[str]]]:
    cks = (await owner_fetch(CYCLES, lo, hi))[0]["ks"] or []
    rows = await owner_fetch(SCAN, lo, hi, HQ_BGRPS, engine, cks)
    sel = [(r["pid"], int(r["cites"]), list(r["providers"])) for r in rows if r["owned"] == owned]
    return sorted(sel, key=lambda t: (-t[1], t[0]))


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def all_pages(client_as, limit: int, **params) -> tuple[list[dict], set[int]]:
    """limit 단위 키셋 페이지를 끝까지 이어 붙인다(페이지마다 total 을 모은다)."""
    items: list[dict] = []
    totals: set[int] = set()
    cursor = None
    for _ in range(50):
        r = await get(client_as, HQ_HYUNDAI, limit=limit, **params, **({"cursor": cursor} if cursor else {}))
        assert r.status_code == 200, r.text
        body = r.json()
        items += body["data"]["items"]
        totals.add(body["meta"]["page"]["total"])
        cursor = body["meta"]["page"]["next_cursor"]
        if cursor is None:
            return items, totals
    raise AssertionError("페이지가 끝나지 않음")


# ── D6: 여러 프롬프트 정렬·동률·키셋(HTTP), 표본 상한·동률 순서 ────────────────────
async def test_snapshot_order_ties_and_keyset_over_http(client_as):
    async with staged("global"):
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true")
        body = r.json()
        assert r.status_code == 200, r.text
        # 스냅샷 = 회차 14(언급 숨김 3 은 인용 계열에 보인다). 회차 15(09-24)는 노출일 미래라 스냅샷이 아니다
        assert body["meta"]["cycles"] == ["2026-09-23"] and body["meta"]["suppressed"] == {}
        d = date(2026, 9, 23)
        want = await expected(d, d, owned=True)
        assert [(i["prompt_id"], i["citations"], i["providers"]) for i in body["data"]["items"]] == want
        assert [t[0] for t in want] == [PD, PA, PC]                       # 손 계산: 13 · 3(PA) · 3(PC), 동률은 prompt_id 순
        assert body["data"]["counts"] == {"owned": 3, "uncited": 1}
        for limit in (1, 2):                                              # 동률 경계(PA→PC)를 가로지르는 키셋
            items, totals = await all_pages(client_as, limit, surface="global", owned="true")
            assert [i["prompt_id"] for i in items] == [PD, PA, PC] and totals == {3}, limit
        un = await get(client_as, HQ_HYUNDAI, surface="global", owned="false")
        assert [(i["prompt_id"], i["citations"]) for i in un.json()["data"]["items"]] == [(t[0], t[1]) for t in await expected(d, d, owned=False)]
        assert [i["prompt_id"] for i in un.json()["data"]["items"]] == [PB]


async def test_answer_sample_cap_and_job_id_tie_order(client_as):
    async with staged("global"):
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", limit=1)
        row = r.json()["data"]["items"][0]
        assert row["prompt_id"] == PD and row["citations"] == 13
        # 독립 기대값: 인용 원소를 답변별로 세어 인용 수 내림차순·job_id 오름차순 상위 8
        want = await owner_fetch("""
            SELECT j.job_id::text AS job_id, count(*) AS n
              FROM rd.citation c JOIN rd.job j ON j.answer_key = c.answer_key
             WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND c.prompt_key = 9104
               AND c.cit_in AND c.dflt AND c.source_key <> 0
             GROUP BY j.job_id ORDER BY n DESC, j.job_id LIMIT 8""")
        got = [(a["job_id"], a["citations_in_answer"]) for a in row["answers"]]
        assert got == [(w["job_id"], int(w["n"])) for w in want]
        assert len(got) == 8                                              # 답변 10건 중 상한 8
        # 동률(인용 2건) 안에서 job_id 오름차순 = answer_key 역순(9113·9112·9111)
        assert [g[0][-2:] for g in got[:3]] == ["97", "98", "99"] and [g[1] for g in got] == [2, 2, 2, 1, 1, 1, 1, 1]
        assert {a["provider"] for a in row["answers"]} == {"chatgpt"} and {a["region"] for a in row["answers"]} == {"US"}


# ── D6: 실제 창 경로의 숨김 {1,2} 배제·숨김 3 포함·미래 노출일 배제 ───────────────
async def test_cumulative_hidden_scopes_and_future_view_date(client_as):
    async with staged("global"):
        lo, hi = date(2026, 9, 1), date(2026, 9, 30)
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", **{"from": lo.isoformat(), "to": hi.isoformat()})
        body = r.json()
        assert body["meta"]["mode"] == "cumulative"
        got = [(i["prompt_id"], i["citations"], i["providers"]) for i in body["data"]["items"]]
        assert got == await expected(lo, hi, owned=True)
        ids = [g[0] for g in got]
        assert ids == [PD, SP1, PA, PC]                                  # 회차 10·11·14. 13(숨김 2)의 PH·15(미래)의 PI 없음
        assert PH not in r.text and PI not in r.text
        # 숨김 2 회차 하나만 고른 기간 = 인용 계열 억제, 미래 회차 하나만 = 회차 없음
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", **{"from": "2026-09-22", "to": "2026-09-22"})
        assert r.json()["data"]["items"] == [] and r.json()["meta"]["suppressed"] == {"citations": "hidden"}
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", **{"from": "2026-09-24", "to": "2026-09-24"})
        assert r.json()["data"]["items"] == [] and r.json()["data"]["counts"] == {"owned": 0, "uncited": 0}


async def test_engine_axis_and_excluded_answers(client_as):
    async with staged("global"):
        d = date(2026, 9, 23)
        r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", engine="deepseek")
        assert [(i["prompt_id"], i["citations"], i["providers"]) for i in r.json()["data"]["items"]] == \
            await expected(d, d, owned=True, engine="deepseek") == [(PF, 2, ["deepseek"])]
        for owned in ("true", "false"):                                   # 호스트 없는 인용뿐인 PE·cit_in 거짓 PG 는 어느 버킷에도 없다
            r = await get(client_as, HQ_HYUNDAI, surface="global", owned=owned)
            assert PE not in r.text and PG not in r.text and PF not in r.text


# ── D4: 검색어 제어 문자 = 422 unprocessable field q(커서 오류로 보고하지 않는다) ──────
@pytest.mark.parametrize("q", ["\x00", "a\x00b", "a\x01b", "tab\there", "x\x7f"])
async def test_q_control_chars_rejected_as_q(client_as, q):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", q=q)
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "unprocessable" and err["details"] == {"field": "q"}


async def test_q_plain_text_still_works(client_as):
    r = await get(client_as, HQ_HYUNDAI, surface="global", owned="true", q="  best  ")
    assert r.status_code == 200 and r.json()["meta"]["page"]["total"] == 1       # 앞뒤 공백만 걷는다
