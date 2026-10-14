"""admin.integrations.ga4 통합 테스트(로컬 개발 DB, GA4 Data API 는 가짜 어댑터).

합성 픽스처에는 GA4 데이터가 없다. 이벤트 집계 검증용 rd.ga4_* 행은 테스트가 소유자 접속 COPY 로 시드한다(적재기 대역.
기능 코드는 rd 를 쓰지 않는다). 정적 가드(G6)가 테스트 파일의 rd DELETE 도 막아 지울 수 없으므로, 시드 키를 KST 날짜로 고정하고
이미 있으면 다시 넣지 않는다(검증 D6: 같은 날 재실행은 rd 행을 늘리지 않는다. 날짜가 바뀌면 한 벌 추가. rd 정리 헬퍼는 tests/support(core 소유) 소관이라 ad-ops R8 처분 = 보류, 날짜 고정 시드 유지).
손 계산: purchase_* = 오늘-1 5건 + 오늘-10 7건 = 12(오늘-120 의 100건은 90일 창 밖), sign_up_* = 오늘-5 3건,
report 1(트래픽) 행의 999 는 이벤트 보고서가 아니라 빠진다.
"""
from __future__ import annotations

import asyncio
import json
import random
from datetime import timedelta

import asyncpg
import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr

from app.core.config import Settings
from app.core.db import get_db
from app.features.admin.integrations.ga4.adapters import Ga4AccessError, GoogleGa4Access, get_ga4_access
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

BASE = "/v1/admin/ga4/properties"


class FakeGa4:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.ro_at_call: list[int] = []                     # 호출 시점 api_ro 대여 수(R2: Detached 면 0)
        self.fail: str | None = None

    async def check_access(self, property_id: str) -> None:
        self.calls.append(property_id)
        self.ro_at_call.append(get_db().engine("api_ro").pool.checkedout())
        if self.fail:
            raise Ga4AccessError(self.fail)  # type: ignore[arg-type]


@pytest_asyncio.fixture(loop_scope="session")
async def env(seeded):
    from app.main import app

    fake = FakeGa4()
    app.dependency_overrides[get_ga4_access] = lambda: fake
    c = await asyncpg.connect(DB_URL)
    day = await c.fetchval("SELECT rd.today_kst()")
    pids = [str(random.randint(10 ** 11, 10 ** 12 - 1)) for _ in range(4)]
    pids[2] = _seed_pid(day)                                                   # rd 시드 대상(날짜 고정 키)
    await _clean_app(c, pids)                                                  # 이전 실행이 중간에 죽어 남긴 app 행
    try:
        yield {"fake": fake, "owner": c, "pids": pids, "app": app}
    finally:
        app.dependency_overrides.pop(get_ga4_access, None)
        await _clean_app(c, pids)
        await c.close()


async def _clean_app(c, pids: list[str]) -> None:
    await c.execute("DELETE FROM app.project WHERE ga4_property_id = ANY($1::text[])", pids)
    await c.execute("DELETE FROM app.ga4_tracked_event WHERE property_id = ANY($1::text[])", pids)
    await c.execute("DELETE FROM app.ga4_property WHERE property_id = ANY($1::text[])", pids)
    await c.execute("DELETE FROM app.judgment_change WHERE kind IN ('ga4_property', 'ga4_tracked_event') "
                    "AND subject_texts && $1::text[]", pids)


def _seed_pid(day) -> str:
    """KST 날짜 고정 속성 id(12자리 숫자: 9 + YYYYMMDD + 001). 무작위 id(10^11~10^12-1)와 겹치지 않는다."""
    return f"9{day:%Y%m%d}001"


def _seed_names(day) -> dict[str, str]:
    return {"purchase": f"purchase_s{day:%Y%m%d}", "signup": f"sign_up_s{day:%Y%m%d}"}


async def _seed_rows(owner, pid: str) -> dict[str, str]:
    """rd.ga4_dim_property·ga4_dim_value·ga4_row 시드(COPY). 같은 날 이미 시드했으면 다시 넣지 않는다(검증 D6 멱등)."""
    today = await owner.fetchval("SELECT rd.today_kst()")
    assert pid == _seed_pid(today), "시드 키는 오늘(KST) 날짜 고정 id 여야 한다"
    names = _seed_names(today)
    if await owner.fetchval("SELECT count(*) FROM rd.ga4_dim_property WHERE property_id = $1", pid):
        return names
    pk = await owner.fetchval("SELECT coalesce(max(prop_key), 0) + 1 FROM rd.ga4_dim_property")
    vk = await owner.fetchval("SELECT coalesce(max(value_key), 0) + 1 FROM rd.ga4_dim_value WHERE kind = 'event'")
    await owner.copy_records_to_table("ga4_dim_property", schema_name="rd", columns=["prop_key", "property_id", "status", "source", "conv_basis"],
                                      records=[(pk, pid, "active", "registry", 2)])
    await owner.copy_records_to_table("ga4_dim_value", schema_name="rd", columns=["kind", "value_key", "value"],
                                      records=[("event", vk, names["purchase"]), ("event", vk + 1, names["signup"])])
    rows = [(1, vk, 5), (10, vk, 7), (120, vk, 100), (5, vk + 1, 3)]
    for d in {today - timedelta(days=x) for x, _, _ in rows}:
        await owner.execute("SELECT rd.ensure_month_leaf('rd.ga4_row'::regclass, $1)", d)
    cols = ["prop_key", "date", "report", "channel_key", "source_key", "device_key", "nvr_key", "page_key", "event_key", "is_ai",
            "engine_key", "is_conv", "event_count"]
    recs = [(pk, today - timedelta(days=x), 3, 0, 0, 0, 0, 0, ek, False, 0, False, n) for x, ek, n in rows]
    recs.append((pk, today - timedelta(days=1), 1, 0, 0, 0, 0, 0, 0, False, 0, False, 999))
    await owner.copy_records_to_table("ga4_row", schema_name="rd", columns=cols, records=recs)
    return names


@needs_db
async def test_auth_gates(client_as, env):
    pid = env["pids"][0]
    async with client_as(None) as c:
        assert (await c.get(BASE)).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for r in (await c.get(BASE), await c.put(f"{BASE}/{pid}", json={"brand_code": "Kia", "country_code": "DE"}),
                      await c.delete(f"{BASE}/{pid}"), await c.get(f"{BASE}/{pid}/events"),
                      await c.put(f"{BASE}/{pid}/events", json={"event_names": ["x"]})):
                assert r.status_code == 403, (uid, r.text)
    assert await env["owner"].fetchval("SELECT count(*) FROM app.ga4_property WHERE property_id = $1", pid) == 0


@needs_db
async def test_property_crud(client_as, env):
    p1, p2 = env["pids"][:2]
    fake, own = env["fake"], env["owner"]
    async with client_as(ADMIN) as c:
        r = await c.put(f"{BASE}/{p1}", json={"brand_code": "Kia", "country_code": "de"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["property"]["status"] == "pending_grant" and d["property"]["country_code"] == "DE" and d["verified"] is None
        assert d["propagation"] == "pending" and d["property"]["loaded"] is False and fake.calls == []
        pl = json.loads(await own.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", d["change_id"]))
        assert pl["old"] is None and pl["new"] == {"brand_code": "Kia", "country_code": "DE", "status": "pending_grant"}
        # 같은 시장 다른 속성 → 409, 저장 없음
        r = await c.put(f"{BASE}/{p2}", json={"brand_code": "Kia", "country_code": "DE"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "market_taken"
        assert r.json()["error"]["details"] == {"property_id": p1}
        # 대기 요청이 있으면 같은 속성 재요청 409(롤백) → 적재기 반영을 가정해 상태를 applied 로
        r = await c.put(f"{BASE}/{p1}", json={"brand_code": "Kia", "country_code": "DE", "verify": True})
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pending" and fake.calls == []   # 외부 확인 전에 거절
        assert await own.fetchval("SELECT status FROM app.ga4_property WHERE property_id = $1", p1) == "pending_grant"
        await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE subject_texts = ARRAY[$1]::text[]", p1)
        # verify 성공 → active
        r = await c.put(f"{BASE}/{p1}", json={"brand_code": "Kia", "country_code": "DE", "verify": True})
        assert r.status_code == 200 and r.json()["data"]["property"]["status"] == "active" and r.json()["data"]["verified"] is True
        assert fake.calls == [p1] and fake.ro_at_call == [0]          # ad-ops R2: GA4 확인 중 요청 api_ro 커넥션 없음
        await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE subject_texts = ARRAY[$1]::text[]", p1)
        # 같은 값 재저장 → 요청 없음(상태 유지)
        r = await c.put(f"{BASE}/{p1}", json={"brand_code": "Kia", "country_code": "DE"})
        assert r.json()["data"]["change_id"] is None and r.json()["data"]["property"]["status"] == "active"
        # verify 실패 종류별: 저장하지 않는다
        for kind, st, code in (("denied", 422, "ga4_verify_failed"), ("upstream", 502, "upstream_ga4"), ("unconfigured", 503, "ga4_unconfigured")):
            fake.fail = kind
            r = await c.put(f"{BASE}/{p2}", json={"brand_code": "Genesis", "country_code": "KR", "verify": True})
            assert (r.status_code, r.json()["error"]["code"]) == (st, code)
        fake.fail = None
        assert await own.fetchval("SELECT count(*) FROM app.ga4_property WHERE property_id = $1", p2) == 0
        # 미매핑 등록, 검증 오류
        r = await c.put(f"{BASE}/{p2}", json={})
        assert r.status_code == 200 and r.json()["data"]["property"]["status"] == "unmapped"
        for path, body in ((p2, {"brand_code": "Kia"}), (p2, {"brand_code": "Kia", "country_code": "DEU"}), ("12a", {}),
                           (p2, {"brand_code": "Nope", "country_code": "KR", "x": 1})):
            assert (await c.put(f"{BASE}/{path}", json=body)).status_code == 422, (path, body)
        await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE subject_texts = ARRAY[$1]::text[]", p2)
        r = await c.put(f"{BASE}/{p2}", json={"brand_code": "Nope", "country_code": "KR"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_brand"
        # 목록: 필터 전후, 프로젝트 직접 지정 표시
        await own.execute("INSERT INTO app.project (kind, name, country_code, created_by, ga4_property_id) VALUES ('customer', 't-ga4', 'DE', $1, $2)",
                          ADMIN, p1)
        r = await c.get(BASE, params={"brand_code": "Kia", "country_code": "de", "surface": "global"})
        items = [i for i in r.json()["data"]["items"] if i["property_id"] in env["pids"]]
        assert [i["property_id"] for i in items] == [p1] and items[0]["project_overrides"][0]["name"] == "t-ga4"
        assert r.json()["meta"]["ignored_filters"] == ["surface"]
        r = await c.get(BASE, params={"status": "unmapped"})
        assert p2 in [i["property_id"] for i in r.json()["data"]["items"]] and p1 not in [i["property_id"] for i in r.json()["data"]["items"]]
        # 삭제
        await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE subject_texts = ARRAY[$1]::text[]", p1)
        await own.execute("INSERT INTO app.ga4_tracked_event (property_id, event_name) VALUES ($1, 'purchase')", p1)
        r = await c.delete(f"{BASE}/{p1}")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["removed_tracked_events"], d["project_overrides"], d["propagation"]) == (1, 1, "pending")
        pl = json.loads(await own.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", d["change_id"]))
        assert pl["op"] == "delete" and pl["old"]["tracked_events"] == ["purchase"]
        assert (await c.delete(f"{BASE}/{p1}")).status_code == 404


@needs_db
async def test_r7_market_unique_race(client_as, env):
    """ad-ops R7 회귀(DB-v2.6 P45 ga4_property_market_uq): 사전 조회를 통과한 동시 요청(다른 속성·같은 시장)은 DB 유일 위반으로
    409 market_taken(제약 이름 포함). 다른 연결이 같은 시장 행을 커밋 전에 쥔 상태라 PUT 의 사전 조회는 통과하고 INSERT 가 유일 인덱스에서
    기다린다 → 그 연결이 커밋하면 23505. 저장·요청 행은 남지 않는다(롤백)."""
    own = env["owner"]
    pa, pb = (str(random.randint(10 ** 11, 10 ** 12 - 1)) for _ in range(2))
    other = await asyncpg.connect(DB_URL)
    tx = other.transaction()
    await tx.start()
    done = False
    try:
        await other.execute("INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) "
                            "VALUES ($1, 'Genesis', 'NZ', 'pending_grant')", pa)
        async with client_as(ADMIN) as c:
            task = asyncio.create_task(c.put(f"{BASE}/{pb}", json={"brand_code": "Genesis", "country_code": "NZ"}))
            for _ in range(100):                                       # PUT 이 유일 인덱스 대기에 들어갈 때까지(최대 5초)
                if await own.fetchval("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                                      "AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO app.ga4_property%'"):
                    break
                await asyncio.sleep(0.05)
            else:
                pytest.fail("PUT 이 유일 인덱스 대기에 들어가지 않았다")
            await tx.commit()
            done = True
            r = await task
        assert r.status_code == 409 and r.json()["error"]["code"] == "market_taken", r.text
        assert r.json()["error"]["details"] is None                              # 제약 이름 비노출(검증 m-3), 의미는 코드 market_taken
        assert await own.fetchval("SELECT count(*) FROM app.ga4_property WHERE property_id = $1", pb) == 0
        assert await own.fetchval("SELECT count(*) FROM app.judgment_change WHERE subject_texts = ARRAY[$1]::text[]", pb) == 0
        # 순차 요청은 사전 조회가 잡는다(상대 속성 id 를 알려 준다)
        async with client_as(ADMIN) as c:
            r = await c.put(f"{BASE}/{pb}", json={"brand_code": "Genesis", "country_code": "NZ"})
        assert r.status_code == 409 and r.json()["error"]["details"] == {"property_id": pa}
    finally:
        if not done:
            await tx.rollback()
        await _clean_app(own, [pa, pb])
        await other.close()


@needs_db
async def test_r2_detached_put_gate(client_as, env):
    """ad-ops R2: Detached 로 바꾼 PUT 속성도 라우터 게이트와 같은 판정·코드(admin 메뉴 없는 admin = 403 menu_forbidden)."""
    from tests.support import Sql, Update, staged

    pid = env["pids"][3]
    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))      # 계정 쓰기 = 감사 트리거 행위자 필수(롤백 전용 준비)
    menu_std = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})
    async with staged(actor, menu_std), client_as(ADMIN) as c:
        for r in (await c.put(f"{BASE}/{pid}", json={}), await c.get(BASE)):
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", r.text
    assert env["fake"].calls == []
    assert await env["owner"].fetchval("SELECT count(*) FROM app.ga4_property WHERE property_id = $1", pid) == 0


@needs_db
async def test_b072_registry_fields_and_minimal_put(client_as, env):
    """B072: GET fields=registry 는 화면 표 열만(같은 행·순서·값, 추적 수·적재 투영·직접 지정·대기 요청은 null, 그 문장 없음).
    PUT return=minimal 은 쓰기·판정 요청이 같고 응답 property 재조회(LIST·PENDING·DIMS)만 생략. 기본값은 종전(full)."""
    from tests.core.rcache_calls import Stmts

    p1, p2 = env["pids"][:2]
    own = env["owner"]
    async with client_as(ADMIN) as c:
        with Stmts() as st_min:
            rm = await c.put(f"{BASE}/{p1}", params={"return": "minimal"}, json={"brand_code": "Kia", "country_code": "de"})
        with Stmts() as st_full:
            rf = await c.put(f"{BASE}/{p2}", json={"brand_code": "Genesis", "country_code": "KR"})
        assert rm.status_code == 200 and rf.status_code == 200, (rm.text, rf.text)
        dm, df = rm.json()["data"], rf.json()["data"]
        assert dm["property"] is None and df["property"]["property_id"] == p2 and df["property"]["tracked_events"] == 0
        assert (dm["verified"], dm["propagation"], dm["pending_market_cleared"]) == (df["verified"], df["propagation"], False) == (None, "pending", False)
        pl = json.loads(await own.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", dm["change_id"]))
        assert pl["old"] is None and pl["new"] == {"brand_code": "Kia", "country_code": "DE", "status": "pending_grant"}
        assert await own.fetchval("SELECT status FROM app.ga4_property WHERE property_id = $1", p1) == "pending_grant"
        assert not any("json_agg" in q or "rd.ga4_dim_property" in q for q in st_min.seen)
        assert sum("FROM app.judgment_change j" in q for q in st_min.seen) == 1                     # 외부 확인 전 대기 검사만
        assert any("json_agg" in q for q in st_full.seen) and any("rd.ga4_dim_property" in q for q in st_full.seen)
        assert sum("FROM app.judgment_change j" in q for q in st_full.seen) == 2
        # 목록: registry 는 같은 행·순서·화면 열 값
        full = (await c.get(BASE)).json()["data"]["items"]
        with Stmts() as st_reg:
            rr = await c.get(BASE, params={"fields": "registry"})
        assert rr.status_code == 200 and rr.json()["meta"]["ignored_filters"] == []
        reg = rr.json()["data"]["items"]
        keep = ("property_id", "brand_code", "country_code", "status", "verified_at", "updated_by", "updated_by_email", "updated_at")
        assert [{k: i[k] for k in keep} for i in reg] == [{k: i[k] for k in keep} for i in full]
        assert {p1, p2} <= {i["property_id"] for i in reg}
        assert all((i["tracked_events"], i["loaded"], i["conv_basis"], i["project_overrides"], i["pending"]) == (None,) * 5 for i in reg)
        assert not any("json_agg" in q or "rd.ga4_dim_property" in q or "app.judgment_change" in q for q in st_reg.seen)
        # 필터도 같은 행
        rk = (await c.get(BASE, params={"fields": "registry", "brand_code": "Kia", "country_code": "de"})).json()["data"]["items"]
        assert [i["property_id"] for i in rk if i["property_id"] in env["pids"]] == [p1]
        for bad in ({"fields": "all"},):
            assert (await c.get(BASE, params=bad)).status_code == 422
        assert (await c.put(f"{BASE}/{p1}", params={"return": "none"}, json={})).status_code == 422


@needs_db
async def test_events(client_as, env):
    pid = env["pids"][2]
    own = env["owner"]
    async with client_as(ADMIN) as c:
        assert (await c.get(f"{BASE}/{pid}/events")).status_code == 404
        assert (await c.put(f"{BASE}/{pid}/events", json={"event_names": []})).status_code == 404
        assert (await c.put(f"{BASE}/{pid}", json={"brand_code": "Hyundai", "country_code": "US"})).status_code == 200
        # 적재 전: 빈 목록, loaded 거짓(rd 시드가 없는 무작위 속성)
        fresh = env["pids"][3]
        assert (await c.put(f"{BASE}/{fresh}", json={})).status_code == 200
        r = await c.get(f"{BASE}/{fresh}/events")
        assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["data"]["loaded"] is False
        names = await _seed_rows(own, pid)
        r = await c.get(f"{BASE}/{pid}/events")
        d = r.json()["data"]
        assert d["loaded"] is True and d["conv_basis"] == "tracked_events"
        assert [(i["event_name"], i["count"], i["tracked"]) for i in d["items"]] == [(names["purchase"], 12, False), (names["signup"], 3, False)]
        # 추적 교체(필터 전후: 추적 우선 정렬로 바뀐다)
        r = await c.put(f"{BASE}/{pid}/events", json={"event_names": [names["signup"], " custom_evt ", "custom_evt"]})
        assert r.status_code == 200 and r.json()["data"]["event_names"] == sorted(["custom_evt", names["signup"]])
        cid = r.json()["data"]["change_id"]
        pl = json.loads(await own.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", cid))
        assert pl["old"] == [] and pl["new"] == sorted(["custom_evt", names["signup"]])
        r = await c.get(f"{BASE}/{pid}/events")
        assert [(i["event_name"], i["count"], i["tracked"]) for i in r.json()["data"]["items"]] == \
            [(names["signup"], 3, True), ("custom_evt", 0, True), (names["purchase"], 12, False)]
        # 같은 집합 → 요청 없음, 다른 집합인데 대기 요청 있으면 409(롤백)
        r = await c.put(f"{BASE}/{pid}/events", json={"event_names": ["custom_evt", names["signup"]]})
        assert r.json()["data"]["propagation"] == "none"
        r = await c.put(f"{BASE}/{pid}/events", json={"event_names": []})
        assert r.status_code == 409 and await own.fetchval("SELECT count(*) FROM app.ga4_tracked_event WHERE property_id = $1", pid) == 2
        for bad in ({"event_names": ["1bad"]}, {"event_names": ["a" * 41]}, {"event_names": ["x"] * 101}, {}):
            assert (await c.put(f"{BASE}/{pid}/events", json=bad)).status_code == 422, bad
        # 목록의 적재 투영 표시
        r = await c.get(BASE, params={"brand_code": "Hyundai", "country_code": "US"})
        it = next(i for i in r.json()["data"]["items"] if i["property_id"] == pid)
        assert it["loaded"] is True and it["tracked_events"] == 2 and it["conv_basis"] == "tracked_events"
        assert [p["kind"] for p in it["pending"]] == ["ga4_property", "ga4_tracked_event"]


@needs_db
async def test_d6_rd_seed_idempotent(env):
    """검증 D6 회귀: 같은 DB 복제본에서 시드를 반복해도 rd.ga4_* 행이 늘지 않는다."""
    own, pid = env["owner"], env["pids"][2]

    async def counts() -> tuple[int, int, int]:
        return (await own.fetchval("SELECT count(*) FROM rd.ga4_dim_property"),
                await own.fetchval("SELECT count(*) FROM rd.ga4_dim_value WHERE kind = 'event'"),
                await own.fetchval("SELECT count(*) FROM rd.ga4_row WHERE date >= rd.today_kst() - 200"))

    await _seed_rows(own, pid)
    before = await counts()
    for _ in range(2):
        await _seed_rows(own, pid)
    assert await counts() == before
    assert await own.fetchval("SELECT count(*) FROM rd.ga4_dim_property WHERE property_id = $1", pid) == 1


# ── 실제 어댑터(네트워크 없이 httpx.MockTransport). 설정은 core.config.Settings(R1: 기능 설정 모델 폐기) ──
def _sa() -> Settings:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    return Settings(env="test", ga4_credentials_json=SecretStr(json.dumps({"client_email": "sa@x.iam", "private_key": pem,
                                                                            "token_uri": "https://oauth2.example/token"})))


async def test_google_adapter():
    seen = []

    def ok(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url)))
        if "token" in req.url.path:
            assert b"jwt-bearer" in req.content
            return httpx.Response(200, json={"access_token": "tok"})
        assert req.headers["authorization"] == "Bearer tok" and json.loads(req.content)["limit"] == 1
        return httpx.Response(200, json={"rows": []})

    s = _sa()
    await GoogleGa4Access(s, transport=httpx.MockTransport(ok)).check_access("123")
    assert seen[-1] == ("POST", "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport")
    for status, kind in ((403, "denied"), (500, "upstream")):
        def h(req, status=status):
            return httpx.Response(200, json={"access_token": "t"}) if "token" in req.url.path else httpx.Response(status)
        with pytest.raises(Ga4AccessError) as ei:
            await GoogleGa4Access(s, transport=httpx.MockTransport(h)).check_access("123")
        assert ei.value.kind == kind
    with pytest.raises(Ga4AccessError) as ei:
        GoogleGa4Access(Settings(env="test", ga4_credentials_json=SecretStr("not json")))
    assert ei.value.kind == "unconfigured"
    with pytest.raises(Ga4AccessError) as ei:
        GoogleGa4Access(Settings(env="test"))                                 # 미설정
    assert ei.value.kind == "unconfigured"
    assert "private" not in repr(GoogleGa4Access(s)) and "PRIVATE KEY" not in repr(s)
