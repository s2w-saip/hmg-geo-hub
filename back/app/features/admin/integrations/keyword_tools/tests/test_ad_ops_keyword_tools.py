"""admin.integrations.keyword_tools 통합 테스트(로컬 개발 DB, LLM 은 가짜 core.llm 클라이언트, DataForSEO 는 호출하지 않는다).

합성 픽스처에는 키워드 데이터가 없다. rd.dim_keyword·rd.kw_volume_monthly 는 테스트가 소유자 접속 COPY 로 시드한다(적재기 대역.
기능 코드는 rd 를 쓰지 않는다). 정적 가드(G6)가 테스트 파일의 rd DELETE 도 막아 지울 수 없으므로 term 을 KST 날짜로 고정하고
이미 있으면 다시 넣지 않는다(검증 D6: 같은 날 재실행은 rd 행을 늘리지 않는다. 날짜가 바뀌면 한 벌 추가. rd 정리 헬퍼는 tests/support(core 소유) 소관이라 ad-ops R8 처분 = 보류, 날짜 고정 시드 유지). 손 계산: KR(2410·ko) alpha = 최신 월 1000(1일 전 관측, 신선)·전월 800,
beta = 50(10일 전 관측, 7일 초과 = 오래됨), gamma = 없음.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import asyncpg
import httpx
import pytest_asyncio
from pydantic import SecretStr

from app.core.config import Settings
from app.core.db import get_db
from app.core.kw import PRESETS, sanitize, term_norm
from app.core.llm import LlmError, OpenRouterClient, get_llm
from app.features.admin.integrations.keyword_tools.service import LLM_TIMEOUT_S, attach_volume
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

BASE = "/v1/admin/keyword-tools"


class FakeLlm:
    """core.llm.LlmClient 가짜. 호출마다 (timeout_s, 그 시점 api_ro 대여 수)를 남긴다(R1 상한 180초 유지·R2 커넥션 반납 회귀)."""
    model = "fake"

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.calls: list[tuple[float | None, int]] = []
        self.fail_on: str | None = None
        self.keywords: list[str] = []
        self.bad = False

    async def complete_json(self, prompt, schema, *, temperature, max_tokens, timeout_s=None):
        self.prompts.append(prompt)
        self.calls.append((timeout_s, get_db().engine("api_ro").pool.checkedout()))
        if self.bad:
            return {"questions": [{"originalInput": "x"}]}
        if self.fail_on is not None and (self.fail_on == "*" or self.fail_on in prompt):
            raise LlmError("upstream")
        if "keywords" in schema["properties"]:
            return {"keywords": self.keywords}
        body = prompt.split("items):\n", 1)[1].split("\n\nIMPORTANT", 1)[0]          # "Input list (N items):" 뒤 번호 목록만
        items = [line.split(". ", 1)[1] for line in body.splitlines() if ". " in line]
        return {"questions": [{"originalInput": i, "question": f"{i}?", "searchIntent": "informational"} for i in items]}


@pytest_asyncio.fixture(loop_scope="session")
async def env(seeded):
    """LLM 은 core.llm.get_llm 을 가짜로 덮는다(테스트 Settings 에 openrouter_api_key 없음 = 덮지 않으면 503 llm_unavailable)."""
    from app.main import app

    fake = FakeLlm()
    app.dependency_overrides[get_llm] = lambda: fake
    c = await asyncpg.connect(DB_URL)
    t, m1, m2 = await _seed(c)
    sfx = t["alpha"].split()[0]
    await c.execute("DELETE FROM app.judgment_change WHERE kind = 'dfs_fetch' AND payload->>'terms' LIKE $1", f"%{sfx}%")  # 이전 실행 잔여
    try:
        yield {"fake": fake, "owner": c, "t": t, "m1": m1, "m2": m2, "app": app}
    finally:
        app.dependency_overrides.pop(get_llm, None)
        await c.execute("DELETE FROM app.judgment_change WHERE kind = 'dfs_fetch' AND payload->>'terms' LIKE $1", f"%{sfx}%")
        await c.close()


async def _seed(c) -> tuple[dict[str, str], date, date]:
    """KST 날짜 고정 term 시드. 같은 날 이미 있으면 넣지 않는다(검증 D6 멱등). 월·관측 시각은 날짜에서 정해 재실행에도 같은 값."""
    day = await c.fetchval("SELECT rd.today_kst()")
    sfx = f"t-kw-s{day:%Y%m%d}"
    t = {k: f"{sfx} {k}" for k in ("alpha", "beta", "gamma")}
    m1 = (day.replace(day=1) - timedelta(days=1)).replace(day=1)
    m2 = (m1 - timedelta(days=1)).replace(day=1)
    if await c.fetchval("SELECT count(*) FROM rd.dim_keyword WHERE term_norm = $1", t["alpha"]):
        return t, m1, m2
    now = await c.fetchval("SELECT now()")
    await c.copy_records_to_table("dim_keyword", schema_name="rd", columns=["term", "term_norm"],
                                  records=[(t["alpha"], t["alpha"]), (t["beta"], t["beta"])])
    keys = {r["term_norm"]: r["kw_key"] for r in await c.fetch("SELECT term_norm, kw_key FROM rd.dim_keyword WHERE term_norm = ANY($1)",
                                                                [t["alpha"], t["beta"]])}
    # 관측 시각: alpha 는 1일 전(같은 날 재실행에도 7일 이내 = 신선), beta 는 10일 전(오래됨)
    # competition(BG-40, DB-v2.9 P62): alpha 최신 월 HIGH·이전 월 LOW(응답은 최신 월 값), beta 는 적재 전 행처럼 NULL
    recs = [(keys[t["alpha"]], 2410, "ko", m1, 1000, 12, 0.5, 1, now - timedelta(days=1), "HIGH"),
            (keys[t["alpha"]], 2410, "ko", m2, 800, 10, 0.4, 1, now - timedelta(days=1), "LOW"),
            (keys[t["beta"]], 2410, "ko", m1, 50, 3, None, 1, now - timedelta(days=10), None)]
    await c.copy_records_to_table("kw_volume_monthly", schema_name="rd", records=recs,
                                  columns=["kw_key", "location_code", "language_code", "month", "search_volume", "competition_index", "cpc",
                                           "call_id", "observed_at", "competition"])
    return t, m1, m2


async def _dfs(owner, t) -> list[dict]:
    rows = await owner.fetch("SELECT change_id, subject_texts, payload FROM app.judgment_change WHERE kind = 'dfs_fetch' "
                             "AND payload->>'terms' LIKE $1 ORDER BY change_id", f"%{t['alpha'].split()[0]}%")
    return [{"change_id": r["change_id"], "subject": r["subject_texts"], "payload": json.loads(r["payload"])} for r in rows]


@needs_db
async def test_auth_gates(client_as, env):
    async with client_as(None) as c:
        assert (await c.post(f"{BASE}/volume", json={"keywords": ["a"]})).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for path, body in (("volume", {"keywords": [env["t"]["gamma"]]}), ("to-prompt", {"keywords": ["a"]}),
                               ("prompt-to-volume", {"prompt_text": "x"})):
                r = await c.post(f"{BASE}/{path}", json=body)
                assert r.status_code == 403, (uid, path)
    assert env["fake"].prompts == [] and await _dfs(env["owner"], env["t"]) == []


@needs_db
async def test_volume_lookup_and_fetch_queue(client_as, env):
    t, own = env["t"], env["owner"]
    async with client_as(ADMIN) as c:
        r = await c.post(f"{BASE}/volume", json={"keywords": [f"  {t['alpha'].upper()} ", t["beta"], t["gamma"], t["alpha"]]})
        assert r.status_code == 202, r.text
        d = r.json()["data"]
        assert (d["location_code"], d["language_code"]) == (2410, "ko")
        ks = {k["term_norm"]: k for k in d["keywords"]}
        assert [k["term_norm"] for k in d["keywords"]] == [t["alpha"], t["beta"]]              # 검색량 DESC
        a = ks[t["alpha"]]
        assert (a["search_volume"], a["freshness"], a["month"], a["cpc"]) == (1000, "fresh", env["m1"].isoformat(), 0.5)
        assert (a["competition"], ks[t["beta"]]["competition"]) == ("HIGH", None)             # BG-40: 최신 월 행의 라벨
        assert [(m["month"], m["search_volume"]) for m in a["monthly_searches"]] == [(env["m1"].isoformat(), 1000), (env["m2"].isoformat(), 800)]
        assert ks[t["beta"]]["freshness"] == "stale" and d["missing"] == [t["gamma"]]
        assert d["summary"] == {"requested": 3, "found": 2, "total_search_volume": 1050, "avg_search_volume": 525}
        assert d["fetch"]["status"] == "queued" and d["fetch"]["terms"] == sorted([t["beta"], t["gamma"]])
        q = await _dfs(own, t)
        assert len(q) == 1 and q[0]["change_id"] == d["fetch"]["change_id"]
        # 기대 변경 이유: core.contracts dfs_fetch 계약(6라운드, IN-1 과 한 벌) = payload {fetch, terms(원문), …}, 주체 = 정렬된 term_norm
        # (예전 endpoint 키·'search_volume:<loc>:<lang>' 접두 주체 폐기)
        assert q[0]["payload"] == {"fetch": "volume", "terms": sorted([t["beta"], t["gamma"]]), "location_code": 2410,
                                   "language_code": "ko", "requested_via": "admin.keyword_tools.volume"}
        assert q[0]["subject"] == sorted([t["beta"], t["gamma"]])
        # 같은 요청 → 새 행 없이 대기 중인 change_id
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["gamma"], t["beta"]]})
        assert r.status_code == 202 and r.json()["data"]["fetch"] == {"status": "pending", "change_id": q[0]["change_id"],
                                                                     "terms": sorted([t["beta"], t["gamma"]]),
                                                                     "pending_terms": sorted([t["beta"], t["gamma"]]),
                                                                     "pending_change_ids": [q[0]["change_id"]]}
        assert len(await _dfs(own, t)) == 1
        # 모두 신선 → 200, 요청 없음 / force → 요청
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["alpha"]]})
        assert r.status_code == 200 and r.json()["data"]["fetch"] == {"status": "fresh", "change_id": None, "terms": [],
                                                                     "pending_terms": [], "pending_change_ids": []}
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["alpha"]], "force": True})
        assert r.status_code == 202 and r.json()["data"]["fetch"]["terms"] == [t["alpha"]]
        # 지역 바꾸면(필터 전후) 수집 값이 없다
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["alpha"]], "country": "us"})
        d = r.json()["data"]
        assert (d["location_code"], d["language_code"], d["keywords"], d["missing"]) == (2840, "en", [], [t["alpha"]])
        assert len(await _dfs(own, t)) == 3
        for body, code in (({"keywords": ["()", " , "]}, "no_keywords"), ({"keywords": ["a"], "country": "zz"}, "unknown_location"),
                           ({"keywords": ["a"], "location_code": 9999}, "unknown_location"), ({"keywords": []}, "unprocessable"),
                           ({"keywords": ["a"], "x": 1}, "unprocessable")):
            r = await c.post(f"{BASE}/volume", json=body)
            assert r.status_code == 422 and r.json()["error"]["code"] == code, body


@needs_db
async def test_d4_language_code_and_term_dedupe(client_as, env):
    """검증 D4 회귀: 형식 오류 언어는 422(유료 수집 요청에 실리지 않음), dedupe 는 term 단위(부분 겹침도 중복 수집하지 않음)."""
    t, own = env["t"], env["owner"]
    async with client_as(ADMIN) as c:
        for lang in ("a:b:c", "xx", "ko-KR", "en "):
            body = {"keywords": [t["gamma"]], "language_code": lang}
            r = await c.post(f"{BASE}/volume", json=body)
            if lang == "en ":                                               # 앞뒤 공백은 걷고 프리셋 언어로 인정
                assert r.status_code == 202 and r.json()["data"]["language_code"] == "en", r.text
                continue
            assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_language", (lang, r.text)
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["gamma"]], "country": "cn", "language_code": "ZH-cn"})
        assert r.status_code == 202 and r.json()["data"]["language_code"] == "zh-CN"
        q = await _dfs(own, t)
        # 지역·언어는 주체가 아니라 payload 에 있다(core.contracts dfs_fetch: 주체 = term_norm 만)
        assert [(x["payload"]["location_code"], x["payload"]["language_code"], x["subject"]) for x in q] == \
            [(2410, "en", [t["gamma"]]), (2156, "zh-CN", [t["gamma"]])]
        assert all(":" not in x["payload"]["language_code"] for x in q)
        # term 단위 dedupe: [beta, gamma] 대기 중에 [gamma] 만 → 새 요청 없음
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["beta"], t["gamma"]]})
        c1 = r.json()["data"]["fetch"]["change_id"]
        assert r.status_code == 202 and r.json()["data"]["fetch"]["status"] == "queued"
        n = len(await _dfs(own, t))
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["gamma"]]})
        f = r.json()["data"]["fetch"]
        assert (f["status"], f["change_id"], f["terms"], f["pending_terms"]) == ("pending", c1, [t["gamma"]], [t["gamma"]])
        assert len(await _dfs(own, t)) == n
        # 부분 겹침: [alpha(force), gamma] → alpha 만 새로 요청, gamma 는 기존 c1
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["alpha"], t["gamma"]], "force": True})
        f = r.json()["data"]["fetch"]
        assert (f["status"], f["terms"], f["pending_terms"], f["pending_change_ids"]) == ("queued", [t["alpha"]], [t["gamma"]], [c1])
        q = await _dfs(own, t)
        assert len(q) == n + 1 and q[-1]["subject"] == [t["alpha"]] and q[-1]["payload"]["terms"] == [t["alpha"]]
        # 기존 요청이 처리되면(applied) 다시 요청할 수 있다
        await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE change_id = $1", c1)
        r = await c.post(f"{BASE}/volume", json={"keywords": [t["gamma"]]})
        assert r.json()["data"]["fetch"]["status"] == "queued" and r.json()["data"]["fetch"]["change_id"] != c1


@needs_db
async def test_d6_rd_seed_idempotent(env):
    """검증 D6 회귀: 같은 DB 복제본에서 시드를 반복해도 rd.dim_keyword·rd.kw_volume_monthly 행이 늘지 않는다."""
    own = env["owner"]

    async def counts() -> tuple[int, int]:
        return (await own.fetchval("SELECT count(*) FROM rd.dim_keyword"), await own.fetchval("SELECT count(*) FROM rd.kw_volume_monthly"))

    before = await counts()
    for _ in range(2):
        t, m1, _m2 = await _seed(own)
        assert t == env["t"] and m1 == env["m1"]
    assert await counts() == before


@needs_db
async def test_to_prompt(client_as, env):
    fake = env["fake"]
    async with client_as(ADMIN) as c:
        r = await c.post(f"{BASE}/to-prompt", json={"keywords": ["electric car", "[a,b]-Title - Desc"],
                                                     "keyword_volume_map": {"Electric Car": 100, "a": 5, "b": 7}})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert [(q["original_input"], q["volume"], q["search_intent"]) for q in d["questions"]] == \
            [("electric car", 100, "informational"), ("[a,b]-Title - Desc", 12, "informational")]
        assert d["total_questions"] == 2 and d["source_keywords"] == 2 and "Generate EXACTLY 2 questions" in fake.prompts[-1]
        # 25개 초과 → 10개씩 배치(3개), 한 배치 실패는 빼고 계속
        fake.prompts.clear()
        fake.fail_on = "k15"
        r = await c.post(f"{BASE}/to-prompt", json={"keywords": [f"k{i:02d}" for i in range(30)]})
        d = r.json()["data"]
        assert r.status_code == 200 and len(fake.prompts) == 3 and d["failed_batches"] == 1 and d["total_questions"] == 20
        assert all(q["volume"] is None for q in d["questions"])
        fake.fail_on = "*"
        r = await c.post(f"{BASE}/to-prompt", json={"keywords": [f"k{i:02d}" for i in range(30)]})
        # 오류 코드 통일(메인 결정, core.llm): upstream_llm → llm_failed(502)
        assert r.status_code == 502 and r.json()["error"]["code"] == "llm_failed"
        fake.fail_on, fake.bad = None, True
        assert (await c.post(f"{BASE}/to-prompt", json={"keywords": ["a"]})).status_code == 502
        fake.bad = False
        for body in ({"keywords": []}, {"keywords": ["a"], "max_questions": 0}, {"keywords": ["a"] * 501}):
            assert (await c.post(f"{BASE}/to-prompt", json=body)).status_code == 422
        # max_questions 로 자르기
        r = await c.post(f"{BASE}/to-prompt", json={"keywords": ["a", "b", "c"], "max_questions": 2})
        assert [q["original_input"] for q in r.json()["data"]["questions"]] == ["a", "b"]
        env["app"].dependency_overrides.pop(get_llm, None)                  # 설정 없는 실제 의존성(core.llm.UnavailableLlm)
        r = await c.post(f"{BASE}/to-prompt", json={"keywords": ["a"]})
        # 오류 코드 통일(메인 결정, core.llm): llm_unconfigured → llm_unavailable(503)
        assert r.status_code == 503 and r.json()["error"]["code"] == "llm_unavailable"


@needs_db
async def test_prompt_to_volume(client_as, env):
    fake, t = env["fake"], env["t"]
    async with client_as(ADMIN) as c:
        fake.keywords = [t["alpha"]]
        r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "전기차 추천해줘"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["volume"] == 1000 and d["keywords"] == [t["alpha"]] and d["fetch"]["status"] == "fresh"
        assert "User Prompt: 전기차 추천해줘" in fake.prompts[-1]
        fake.keywords = [t["beta"], t["gamma"]]
        r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "x"})
        d = r.json()["data"]
        assert r.status_code == 202 and d["volume"] == 50 and d["fetch"]["status"] in ("queued", "pending")
        fake.keywords = []
        r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "x"})
        assert r.status_code == 200 and r.json()["data"]["volume"] is None and r.json()["data"]["volumes"] == []
        fake.fail_on = "*"
        r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "x"})
        assert r.status_code == 502 and r.json()["error"]["code"] == "llm_failed"          # core.llm 코드(예전 upstream_llm)
        fake.fail_on = None
        assert (await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": ""})).status_code == 422


def test_keyword_helpers():
    assert sanitize("  (전기차), 추천\n가격 ") == "전기차 추천 가격" and sanitize("x" * 100) == "" and sanitize("()") == ""
    assert term_norm(" 가B ") == "가b"                         # NFD → NFC → trim → lower
    assert len(PRESETS) == 29 and len({p.location_code for p in PRESETS.values()}) == 29          # core.kw.PRESETS 는 dict(id → Preset)
    assert attach_volume("[A, b]-T - D", {"a": 1, "B": 2}) == 3 and attach_volume("x", {"y": 1}) is None and attach_volume("x", None) is None


@needs_db
async def test_r2_llm_calls_hold_no_ro_connection(client_as, env):
    """ad-ops R1·R2 회귀: LLM 호출 시점에 요청 api_ro 커넥션 0(CurrentUserDetached), 호출 상한은 현행 3분(timeout_s 180)."""
    fake, t = env["fake"], env["t"]
    fake.calls.clear()
    fake.keywords = [t["alpha"]]
    async with client_as(ADMIN) as c:
        assert (await c.post(f"{BASE}/to-prompt", json={"keywords": ["a"]})).status_code == 200
        r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "x"})
        assert r.status_code == 200 and r.json()["data"]["volume"] == 1000          # 호출 뒤 RoSession 으로 읽은 값
    assert fake.calls == [(LLM_TIMEOUT_S, 0), (LLM_TIMEOUT_S, 0)] and LLM_TIMEOUT_S == 180


@needs_db
async def test_r2_detached_gate_same_codes(client_as, env):
    """Detached 게이트(to-prompt·prompt-to-volume)도 라우터 게이트(volume)와 같은 판정·코드: 비 admin = admin_only,
    admin 메뉴 없는 admin = menu_forbidden. LLM 을 부르지 않는다."""
    from tests.support import Sql, Update, staged

    paths = (("volume", {"keywords": ["a"]}), ("to-prompt", {"keywords": ["a"]}), ("prompt-to-volume", {"prompt_text": "x"}))
    for uid in (HQ_HYUNDAI, KIA_US):
        async with client_as(uid) as c:
            for path, body in paths:
                r = await c.post(f"{BASE}/{path}", json=body)
                assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", (uid, path, r.text)
    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))      # 계정 쓰기 = 감사 트리거 행위자 필수(롤백 전용 준비)
    menu_std = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})
    async with staged(actor, menu_std), client_as(ADMIN) as c:
        for path, body in paths:
            r = await c.post(f"{BASE}/{path}", json=body)
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", (path, r.text)
    assert env["fake"].prompts == []


@needs_db
async def test_core_llm_client_wiring(client_as, seeded):
    """기능 LLM 어댑터 폐기(R1) 뒤 실제 core.llm.OpenRouterClient 로 도는지: URL = base + /chat/completions, 호출 상한 180초,
    구조화 출력 strict. 네트워크 없이 httpx.MockTransport(설정은 core.config.Settings)."""
    from app.main import app

    seen: list[httpx.Request] = []

    def ok(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"keywords": []})}}]})

    s = Settings(env="test", openrouter_api_key=SecretStr("or-key"))
    app.dependency_overrides[get_llm] = lambda: OpenRouterClient(s, transport=httpx.MockTransport(ok))
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(f"{BASE}/prompt-to-volume", json={"prompt_text": "x"})
    finally:
        app.dependency_overrides.pop(get_llm, None)
    assert r.status_code == 200 and r.json()["data"]["keywords"] == [], r.text
    req = seen[0]
    body = json.loads(req.content)
    assert str(req.url) == "https://openrouter.ai/api/v1/chat/completions" and req.headers["authorization"] == "Bearer or-key"
    assert body["model"] == "google/gemini-2.5-flash" and body["max_tokens"] == 200 and body["response_format"]["json_schema"]["strict"] is True
    assert req.extensions["timeout"]["read"] == 180
    assert "or-key" not in repr(OpenRouterClient(s))
