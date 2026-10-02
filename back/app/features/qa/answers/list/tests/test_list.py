"""qa.answers.list: 목록·진행률·이웃·필터 옵션. 기대값은 소유자 접속의 독립 SQL(rd.job 직접)·손계산."""
from __future__ import annotations

import base64
import json
import uuid
from datetime import date

import pytest

from app.core.auth import QaReviewer, sign_qa_cookie
from app.core.config import set_settings
from app.features.qa.answers.list.tests.qa_support import db_exec, db_rows, db_val, job_id_of, new_session, qa_client, use_qa_scope
from tests.support import ADMIN, HQ_HYUNDAI, needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]
ORDER = "ORDER BY measured_at DESC NULLS LAST, answer_key DESC"


async def expected(where: str = "true", *args) -> list[str]:
    return [str(r["job_id"]) for r in await db_rows(f"SELECT job_id FROM rd.job WHERE {where} {ORDER}", *args)]


def ids(r) -> list[str]:
    return [x["job_id"] for x in r.json()["data"]["items"]]


async def reviewer(name: str = "검수자A") -> QaReviewer:
    return await new_session(name)


# ── 인증 게이트(Q17) ──
async def test_gate_rejects_missing_tampered_and_jwt(client_as):
    async with qa_client(client_as, None) as c:
        r = await c.get("/v1/qa/answers")
    assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    async with qa_client(client_as, None, bearer=ADMIN) as c:          # 일반 계정 JWT(admin 포함)로는 QA 경로가 열리지 않는다
        r = await c.get("/v1/qa/answers")
    assert r.status_code == 401
    rv = await reviewer()
    async with qa_client(client_as, None) as c:
        payload, sig = sign_qa_cookie(rv).split(".")
        forged = base64.urlsafe_b64encode(json.dumps({"sessionId": rv.session_id, "name": "남의이름", "issuedAt": 1}).encode()).rstrip(b"=")
        c.cookies.set("raw_data_qa", forged.decode() + "." + sig)
        r = await c.get("/v1/qa/answers")
    assert r.status_code == 401


async def test_kill_switch_closes_all(client_as, settings):
    rv = await reviewer()
    set_settings(settings.model_copy(update={"qa_enabled": False}))
    try:
        async with qa_client(client_as, rv) as c:
            r = await c.get("/v1/qa/answers")
    finally:
        set_settings(settings)
    assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"


# ── 목록 ──
async def test_list_shape_order_and_counts(client_as):
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params={"limit": 200})
    assert r.status_code == 200
    body = r.json()
    assert ids(r) == await expected()                                      # 모집단 = rd.job 전체(비완료·드롭 포함, G-24)
    assert body["meta"]["mode"] == "qa" and body["meta"]["page"]["next_cursor"] is None
    assert body["meta"]["suppressed"] == {}                  # qa R1(DB-v2.6 P47) 반영: qa_gate 가 app.brand 를 읽어 가릴 값이 없다
    rows = {x["job_id"]: x for x in body["data"]["items"]}
    j1, j13, j14 = str(await job_id_of(1)), str(await job_id_of(13)), str(await job_id_of(14))
    assert rows[j1]["mention_count"] == await db_val("SELECT count(*) FROM rd.v_answer_mention_raw WHERE answer_key = 1") == 6
    assert rows[j1]["citation_count"] == await db_val("SELECT count(*) FROM rd.v_answer_citation_raw WHERE answer_key = 1") == 10
    assert rows[j1]["surface"] == "global" and rows[j1]["country"] == "US" and rows[j1]["engine"] == "chatgpt" and rows[j1]["lang"] == "en"
    assert rows[j1]["prompt_text"] == "best suv" and rows[j1]["brand"] == ["Hyundai", "Genesis"]   # qa R1: bgrp 5 = Hyundai 1 | Genesis 4
    assert rows[j1]["review_status"] == "unreviewed" and rows[j1]["lock"] is None and rows[j1]["note_count"] == 0
    assert rows[j13]["job_status"] == "in_progress" and rows[j13]["measured_at"] is None and ids(r)[-1] == j13   # NULLS LAST
    assert rows[j14]["dropped"] is True and rows[j14]["job_status"] == "completed"
    web = [x for x in body["data"]["items"] if x["surface"] == "website"]
    assert {x["country"] for x in web} == {"DE"}


async def test_pagination_two_segment_keyset(client_as):
    rv = await reviewer()
    want = await expected()
    got, cursor, pages = [], None, 0
    async with qa_client(client_as, rv) as c:
        while True:
            params = {"limit": 4, **({"cursor": cursor} if cursor else {})}
            r = await c.get("/v1/qa/answers", params=params)
            assert r.status_code == 200, r.text
            got += ids(r)
            pages += 1
            cursor = r.json()["meta"]["page"]["next_cursor"]
            if not cursor:
                break
        assert got == want and pages == 6                                    # 21행 / 4 = 6쪽, 마지막 쪽이 NULL 구간(job 13)을 포함
        r = await c.get("/v1/qa/answers", params={"limit": 4, "cursor": "not-a-cursor"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        first = (await c.get("/v1/qa/answers", params={"limit": 4})).json()["meta"]["page"]["next_cursor"]
        r = await c.get("/v1/qa/answers", params={"limit": 4, "cursor": first, "engine": "gemini"})   # 다른 필터로 재사용
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


async def test_filters_change_results(client_as):
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        async def get(**p):
            r = await c.get("/v1/qa/answers", params={"limit": 200, **p})
            assert r.status_code == 200, r.text
            return r
        assert ids(await get(surface="website")) == await expected("surface = 2")
        assert ids(await get(surface=["website", "project"])) == await expected("surface IN (2, 3)")
        assert ids(await get(engine="gemini")) == await expected("engine_key = (SELECT engine_key FROM rd.dim_engine WHERE code = 'gemini')")
        assert ids(await get(country="kr")) == [str(await job_id_of(4))]          # 대소문자 무시
        assert ids(await get(lang="ko")) == await expected("lang_key = (SELECT lang_key FROM rd.dim_lang WHERE code = 'ko')")
        # 측정 시각 KST 날짜: 2026-09-21 01:00Z = 09-21 10:00 KST(17·18), 09-20 06:00Z = 09-20 15:00 KST(31) 는 제외
        assert set(ids(await get(**{"from": "2026-09-21", "to": "2026-09-21"}))) == {str(await job_id_of(17)), str(await job_id_of(18))}
        assert ids(await get(q="SUV")) == await expected("prompt_key IN (SELECT prompt_key FROM rd.dim_prompt WHERE text ILIKE '%suv%')")
        assert ids(await get(q="현대")) == await expected("prompt_key = 4")
        assert ids(await get(q="%")) == []                                         # LIKE 메타 문자는 글자 그대로
        nm = await get(no_mentions="true")
        assert ids(nm) == await expected("answer_key NOT IN (SELECT answer_key FROM rd.v_answer_mention_raw)")
        r = await get(country=["ZZ"])
        assert ids(r) == [] and r.json()["meta"]["dropped_filters"] == {"country": ["ZZ"]}      # 준 축이 전부 버려지면 빈 결과
        r = await get(funnel="awareness", depth1="x")
        assert r.json()["meta"]["ignored_filters"] == ["depth1", "funnel"] and len(ids(r)) == 21
        r = await get(brand="Kia")                     # qa R1(DB-v2.6 P47) 반영: 브랜드 필터가 적용된다(손계산: Kia 비트 2 = job 5·21·22)
        assert set(ids(r)) == {str(await job_id_of(k)) for k in (5, 21, 22)} and r.json()["meta"]["ignored_filters"] == []
        r = await get(own_brand="Hyundai")                                          # core.ignored_axes: 공통 축 own_brand 도 드러낸다
        assert r.json()["meta"]["ignored_filters"] == ["own_brand"] and len(ids(r)) == 21


async def test_review_state_notes_reviewer_filters(client_as):
    rv = await reviewer("검수자B")
    j1, j2, j3 = (await job_id_of(1), await job_id_of(2), await job_id_of(3))
    await db_exec("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'ok', '갑'), ($2, 'issue', '을')", j1, j2)
    await db_exec("INSERT INTO app.qa_review_note (job_id, target_kind, body, reviewer_name) VALUES ($1, 'answer', 'x', '갑')", j3)
    async with qa_client(client_as, rv) as c:
        async def get(**p):
            return ids(await c.get("/v1/qa/answers", params={"limit": 200, **p}))
        assert await get(state="issue") == [str(j2)]
        assert set(await get(state=["ok", "issue"])) == {str(j1), str(j2)}
        assert len(await get(state="unreviewed")) == 19
        assert set(await get(state=["unreviewed", "issue"])) == set(await expected()) - {str(j1)}
        assert await get(reviewer="갑") == [str(j1)]
        assert await get(has_notes="true") == [str(j3)]
        r = await c.get("/v1/qa/answers", params={"state": "ok", "limit": 200})
        row = r.json()["data"]["items"][0]
        assert row["review_status"] == "ok" and row["reviewer_name"] == "갑"


async def test_brand_coords_and_filter(client_as):
    """qa R1(DB-v2.6 P47): 권한 부여 문맥 없이 기본 상태에서 브랜드 좌표·필터가 채워진다(예전 test_brand_with_grant 의 GRANT·REVOKE 제거)."""
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params={"brand": "Kia", "limit": 200})
        assert r.status_code == 200
        # 손계산: Kia 비트 2 를 가진 bgrp(job 5·21·22 = 2)
        assert set(ids(r)) == {str(await job_id_of(k)) for k in (5, 21, 22)} and r.json()["meta"]["suppressed"] == {}
        r = await c.get("/v1/qa/answers", params={"limit": 200})
        rows = {x["job_id"]: x for x in r.json()["data"]["items"]}
        assert rows[str(await job_id_of(1))]["brand"] == ["Hyundai", "Genesis"]      # bgrp 5 = 1|4
        assert rows[str(await job_id_of(10))]["brand"] == ["HMG"]                    # 공통(엄브렐러 8)
        assert rows[str(await job_id_of(6))]["brand"] == []                          # 카탈로그 밖(bgrp 0)
        r = await c.get("/v1/qa/answers", params={"brand": ["Nope"], "limit": 200})
        assert ids(r) == [] and r.json()["meta"]["dropped_filters"] == {"brand": ["Nope"]}


async def test_server_scope_fixed(client_as):
    rv = await reviewer()
    use_qa_scope(surfaces=("website",))                                        # qa R3: 범위는 core.config qa_surfaces·qa_since
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params={"limit": 200})
        assert ids(r) == await expected("surface = 2")
        r = await c.get("/v1/qa/answers", params={"surface": "global"})           # 요청으로 넓힐 수 없다
        assert ids(r) == [] and r.json()["meta"]["dropped_filters"] == {"surface": ["global"]}
        r = await c.get(f"/v1/qa/answers/{await job_id_of(1)}/neighbors")
        assert r.status_code == 404
    use_qa_scope(since=date(2026, 9, 18))
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params={"limit": 200})
        assert ids(r) == await expected("round_date >= '2026-09-18'")


# ── 진행률 ──
async def test_progress_scoped_and_total(client_as):
    rv = await reviewer()
    j = [await job_id_of(k) for k in (1, 2, 5)]
    await db_exec("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'ok', 'a'), ($2, 'issue', 'a'), "
                  "($3, 'issue', 'a')", *j)
    await db_exec("INSERT INTO app.qa_review_note (job_id, target_kind, body, reviewer_name) VALUES ($1, 'answer', 'x', 'a'), "
                  "($1, 'meta', 'y', 'a')", j[1])
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers/progress", params={"engine": "gemini"})
    assert r.status_code == 200
    d = r.json()["data"]
    gem = await db_val("SELECT count(*) FROM rd.job WHERE engine_key = 2")
    assert d["scoped"] == {"total": gem, "reviewed": 2, "issues": 2, "notes": 1}     # job 2·5 가 gemini
    assert d["total"] == {"total": 21, "reviewed": 3, "issues": 2, "notes": 1}


async def test_progress_empty_filter(client_as):
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers/progress", params={"engine": "nope"})
    assert r.json()["data"]["scoped"] == {"total": 0, "reviewed": 0, "issues": 0, "notes": 0}
    assert r.json()["meta"]["dropped_filters"] == {"engine": ["nope"]}


# ── 이웃 ──
async def test_neighbors_follow_list_order(client_as):
    rv = await reviewer()
    order = await expected()
    async with qa_client(client_as, rv) as c:
        for i in (0, 5, len(order) - 2, len(order) - 1):                          # 첫 행·중간·비NULL 마지막·NULL 구간(job 13)
            r = await c.get(f"/v1/qa/answers/{order[i]}/neighbors")
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["prev"] == (order[i - 1] if i > 0 else None)
            assert d["next"] == (order[i + 1] if i + 1 < len(order) else None)
        web = await expected("surface = 2")
        r = await c.get(f"/v1/qa/answers/{web[0]}/neighbors", params={"surface": "website"})
        assert r.json()["data"] == {"prev": None, "next": web[1]}
        r = await c.get(f"/v1/qa/answers/{uuid.uuid4()}/neighbors")
        assert r.status_code == 404
        r = await c.get("/v1/qa/answers/not-a-uuid/neighbors")
        assert r.status_code == 422


# ── 필터 옵션 ──
async def test_filter_options(client_as):
    rv = await reviewer()
    await db_exec("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'ok', '나'), ($2, 'ok', '가')",
                  await job_id_of(1), await job_id_of(2))
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/filters")
        d = r.json()["data"]
        assert d["engine"] == ["chatgpt", "deepseek", "gemini"] and d["lang"] == ["de", "en", "ko"]
        assert {"US", "KR", "SA-Dammam", "HYUNDAI-N"} <= set(d["country"]) and "" not in d["country"]
        assert d["reviewer"] == ["가", "나"] and d["surface"] == ["global", "website", "project"]
        # qa R1(DB-v2.6 P47): 브랜드 옵션 = app.brand sort_order 순(픽스처 1~5), 가림 없음
        assert d["brand"] == ["Hyundai", "Kia", "Genesis", "HMG", "Hyundai N"] and r.json()["meta"]["suppressed"] == {}
    use_qa_scope(surfaces=("website", "global"))                                # qa R3: 표면 옵션 = 설정 표면(코드 순)
    async with qa_client(client_as, rv) as c:
        assert (await c.get("/v1/qa/filters")).json()["data"]["surface"] == ["global", "website"]


# ── 잘못된 파라미터 ──
@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 201}, {"state": "bad"}, {"surface": "x"},
                                    {"from": "2026-09-02", "to": "2026-09-01"}, {"q": "x" * 201}, {"reviewer": "a\x01"}])
async def test_invalid_params_422(client_as, params):
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


async def test_hq_jwt_with_cookie_uses_cookie_identity(client_as):
    """JWT 는 QA 경로에서 의미가 없다: 쿠키가 있으면 쿠키 신원, 없으면 401(위 테스트)."""
    rv = await reviewer()
    async with qa_client(client_as, rv, bearer=HQ_HYUNDAI) as c:
        r = await c.get("/v1/qa/answers", params={"limit": 1})
    assert r.status_code == 200


# ── D4: 공통 필터의 project_id·cf.* 는 조용히 무시하지 않는다 ──
async def test_d4_project_id_and_custom_fields_are_reported(client_as):
    rv = await reviewer()
    pid, fid = str(uuid.uuid4()), str(uuid.uuid4())
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/answers", params={"limit": 200, "project_id": pid})
        assert r.status_code == 200 and len(ids(r)) == 21
        assert "project_id" in r.json()["meta"]["ignored_filters"]
        r = await c.get("/v1/qa/answers", params={"limit": 200, f"cf.{fid}": "x"})
        assert r.status_code == 200 and len(ids(r)) == 21 and "custom" in r.json()["meta"]["ignored_filters"]
        r = await c.get("/v1/qa/answers", params={"cf.bad": "x"})                          # core.parse_custom_fields 와 같게 422
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"
        r = await c.get("/v1/qa/answers/progress", params={f"cf.{fid}": "x", "project_id": pid})
        assert r.status_code == 200 and {"custom", "project_id"} <= set(r.json()["meta"]["ignored_filters"])
        r = await c.get("/v1/qa/notes", params={f"cf.{fid}": "x"})
        assert r.status_code == 200 and "custom" in r.json()["meta"]["ignored_filters"]
        r = await c.get("/v1/qa/answers", params={"limit": 200})                           # 안 주면 드러내지 않는다
        assert r.json()["meta"]["ignored_filters"] == []


# ── D5: q 는 앞뒤 공백을 다듬고, 비면 필터 없음(현행 filters.ts) ──
async def test_d5_q_trimmed(client_as):
    rv = await reviewer()
    async with qa_client(client_as, rv) as c:
        async def get(q):
            r = await c.get("/v1/qa/answers", params={"limit": 200, "q": q})
            assert r.status_code == 200, r.text
            return ids(r)
        assert await get("   ") == await expected()                                      # 이전: 0행
        spaced, plain = await get(" best suv "), await get("best suv")
        assert spaced == plain and len(plain) > 0                                          # 이전: 0행 대 10행


# ── D7: 검수자 옵션은 서버 검수 범위 안 판정자만 ──
async def test_d7_reviewer_options_scoped(client_as):
    rv = await reviewer()
    await db_exec("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'ok', 'alice'), ($2, 'ok', 'bob'),"
                  " ($3, 'ok', 'carol')", await job_id_of(22), await job_id_of(1), await job_id_of(16))
    use_qa_scope(surfaces=("global",), since=date(2026, 9, 14))                        # website 22·09-07 회차 16 은 범위 밖
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/filters")
    assert r.status_code == 200 and r.json()["data"]["reviewer"] == ["bob"]
    use_qa_scope()
    async with qa_client(client_as, rv) as c:
        assert (await c.get("/v1/qa/filters")).json()["data"]["reviewer"] == ["alice", "bob", "carol"]
