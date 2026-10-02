"""GET /v1/prompts/history(P-2) 통합 테스트. 합성 행은 catalog/tests/seed.py(카탈로그와 공유), 기대값은 손계산 또는 독립 SQL.

감사 행: 공용 픽스처 루트 created 7건(템플릿 적재 시각) + seed INSERT created 9건(G1..G9) + 명시 A1(2026-06-01 10:00 KST, G5 meta_updated)·
A2(2026-09-21 00:30 KST = 09-20 15:30Z, G1 text_updated)·A3(하드 삭제 프롬프트 deleted, app.prompt 행 없음). 고객 프로젝트 created 1건은 제외 대상.
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
import pytest_asyncio

from app.core.db import get_db
from app.core.write import get_audit_writer
from app.features.catalog.prompts.catalog.tests import seed as S
from app.features.catalog.prompts.history import queries as HQ
from app.features.catalog.prompts.history.schemas import HISTORY_COLUMNS
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
G = S.gid
KST = ZoneInfo("Asia/Seoul")


@pytest_asyncio.fixture(scope="module", loop_scope="session", autouse=True)
async def _seed(seeded):
    await S.seed()


def _since() -> datetime:
    d = datetime.now(KST).date() - timedelta(days=90)
    return datetime(d.year, d.month, d.day, tzinfo=KST)


async def expected(extra: str = "true", *args) -> list[int]:
    """독립 SQL: 루트 프로젝트 · 기본 90일(KST) · 정렬 created_at DESC, audit_id DESC. extra = 손으로 쓴 스코프 술어(별칭 p)."""
    rows = await S.q(
        "SELECT l.audit_id FROM app.prompt_audit_log l LEFT JOIN app.prompt p ON p.prompt_id = l.prompt_id "
        f"WHERE l.project_id = $1 AND l.created_at >= $2 AND ({extra}) ORDER BY l.created_at DESC, l.audit_id DESC",
        uuid.UUID(S.ROOT), _since(), *args)
    return [r["audit_id"] for r in rows]


def aids(body) -> list[int]:
    return [x["audit_id"] for x in body["data"]["items"]]


async def _all(c, params) -> tuple[list[int], int]:
    out, cur, pages = [], None, 0
    while True:
        r = await c.get("/v1/prompts/history", params={**params, **({"cursor": cur} if cur else {})})
        assert r.status_code == 200, r.text
        b = r.json()
        out += aids(b)
        pages += 1
        cur = b["meta"]["page"]["next_cursor"]
        if not cur:
            return out, pages


async def test_admin_default_window_and_shape(client_as):
    exp = await expected()
    assert S.A3 in exp and S.A2 in exp and S.A1 not in exp                                  # A1 은 90일 밖
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts/history")
    assert r.status_code == 200, r.text
    b = r.json()
    assert aids(b) == exp
    m = b["meta"]
    assert (m["mode"], m["surface"], m["cycles"], m["generation"], m["page"]["limit"]) == ("audit", "global", [], None, 500)
    a2 = next(x for x in b["data"]["items"] if x["audit_id"] == S.A2)
    assert a2 == {"audit_id": S.A2, "prompt_id": str(G(1)), "prompt_text": "kr market suv", "prompt_brand": "Hyundai",
                  "event_type": "text_updated", "changes": {"text": {"old": "kr suv", "new": "kr market suv"}},
                  "actor_id": str(ADMIN), "actor_type": "user", "actor_email": "t-admin@example.test", "batch_id": None,
                  "created_at": "2026-09-20T15:30:00Z"}
    a3 = next(x for x in b["data"]["items"] if x["audit_id"] == S.A3)
    assert (a3["prompt_text"], a3["prompt_brand"]) == (None, None)                         # 하드 삭제 = app.prompt 행 없음(admin 만)


async def test_scope_brand_and_market(client_as):
    hy = await expected("p.prompt_id IS NOT NULL AND (p.brand_code IS NULL OR p.brand_code IN ('Hyundai', 'HMG'))")
    async with client_as(HQ_HYUNDAI) as c:
        b = (await c.get("/v1/prompts/history")).json()
    assert aids(b) == hy and S.A3 not in hy and S.A2 in hy
    assert {x["prompt_brand"] for x in b["data"]["items"]} <= {None, "Hyundai", "HMG"}
    async with client_as(KIA_US) as c:
        us = (await c.get("/v1/prompts/history")).json()
    got = {uuid.UUID(x["prompt_id"]) for x in us["data"]["items"]}
    # 손계산(카탈로그 B1 과 같은 가시 집합 + 삭제 행 us only 계열 없음): common·acr·us only(Kia, NULL)·deleted row(Kia, NULL, soft-delete 도 이력은 보인다)
    assert got == {uuid.UUID("c1000000-0000-4000-8000-000000000002"), uuid.UUID("c1000000-0000-4000-8000-000000000003"),
                   uuid.UUID("c1000000-0000-4000-8000-000000000005"), uuid.UUID("c1000000-0000-4000-8000-000000000006"),
                   G(2), G(3), G(4), G(7), G(8)}
    async with client_as(KIA_EU) as c:
        eu = (await c.get("/v1/prompts/history")).json()
    assert G(5) in {uuid.UUID(x["prompt_id"]) for x in eu["data"]["items"]} and G(2) not in {uuid.UUID(x["prompt_id"]) for x in eu["data"]["items"]}


async def test_prompt_timeline_and_scope(client_as):
    async with client_as(ADMIN) as c:
        b = (await c.get("/v1/prompts/history", params={"prompt_id": str(G(1))})).json()
        purged = (await c.get("/v1/prompts/history", params={"prompt_id": str(S.PURGED)})).json()
    assert [x["event_type"] for x in b["data"]["items"]] == ["created", "text_updated"]      # created(오늘) > A2(09-20Z)
    assert b["meta"]["page"]["limit"] == 100
    assert aids(purged) == [S.A3]
    async with client_as(HQ_HYUNDAI) as c:
        out = (await c.get("/v1/prompts/history", params={"prompt_id": str(G(5))})).json()         # Kia 프롬프트 = 스코프 밖
        gone = (await c.get("/v1/prompts/history", params={"prompt_id": str(S.PURGED)})).json()
    assert out["data"]["items"] == [] and out["meta"]["dropped_filters"] == {"prompt_id": [str(G(5))]}
    assert gone["data"]["items"] == [] and gone["meta"]["dropped_filters"] == {"prompt_id": [str(S.PURGED)]}
    async with client_as(KIA_US) as c:
        de = (await c.get("/v1/prompts/history", params={"prompt_id": str(G(5))})).json()           # 시장 DE = 스코프 밖
    assert de["data"]["items"] == [] and "prompt_id" in de["meta"]["dropped_filters"]


async def test_filters_change_values(client_as):
    async with client_as(ADMIN) as c:
        async def got(**params):
            r = await c.get("/v1/prompts/history", params=params)
            assert r.status_code == 200, r.text
            return r.json()
        assert aids(await got(event_type="text_updated")) == [S.A2]
        assert set(aids(await got(event_type=["deleted", "text_updated"]))) == {S.A2, S.A3}
        assert aids(await got(**{"from": "2026-09-21", "to": "2026-09-21"})) == [S.A2]          # KST 달력일(UTC 로는 09-20)
        assert aids(await got(**{"from": "2026-09-20", "to": "2026-09-20"})) == []
        assert aids(await got(**{"from": "2026-05-01", "to": "2026-06-30"})) == [S.A1]
        de = await got(country="DE")
        assert {x["prompt_id"] for x in de["data"]["items"]} == {str(G(5))} and S.A3 not in aids(de)
        kia = await got(brand="Kia")
        assert aids(kia) == await expected("p.prompt_id IS NOT NULL AND (p.brand_code IS NULL OR p.brand_code IN ('Kia', 'HMG'))")
        ign = await got(engine="chatgpt", lang="en", depth1="D1", project_id=str(uuid.uuid4()))
        assert ign["meta"]["ignored_filters"] == ["depth1", "engine", "lang", "project_id"] and aids(ign) == await expected()
        assert (await got(event_type="restored"))["data"]["items"] == []


async def test_keyset_paging(client_as):
    exp = await expected()
    async with client_as(ADMIN) as c:
        got, pages = await _all(c, {"limit": 5})
    assert got == exp and pages == -(-len(exp) // 5) and len(set(got)) == len(got)


async def test_route_gates_and_validation(client_as):
    async with client_as(VENDOR) as c:
        r = await c.get("/v1/prompts/history")
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    async with client_as(S.WEBSITE_USER) as c:
        assert (await c.get("/v1/prompts/history")).status_code == 403
    async with client_as(None) as c:
        assert (await c.get("/v1/prompts/history")).status_code == 401
    async with client_as(SUSPENDED) as c:
        assert (await c.get("/v1/prompts/history")).status_code == 401
    async with client_as(ADMIN) as c:
        for params in ({"surface": "website"}, {"surface": "project"}, {"event_type": "bogus"}, {"limit": 0}, {"limit": 501},
                       {"from": "2026-09-02", "to": "2026-09-01"}, {"prompt_id": "not-a-uuid"}, {"cursor": "garbage"}, {"format": "xlsx"}):
            r = await c.get("/v1/prompts/history", params=params)
            assert r.status_code == 422, (params, r.text)
        b = (await c.get("/v1/prompts/history", params={"limit": 2})).json()
        r = await c.get("/v1/prompts/history", params={"limit": 2, "event_type": "created", "cursor": b["meta"]["page"]["next_cursor"]})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


async def test_csv_export_audit_and_truncation(client_as, monkeypatch):
    await get_audit_writer().flush()
    async with get_db().read("admin_long") as c:
        from app.core.db import fetch_val
        before = int(await fetch_val(c, "SELECT count(*) FROM app.access_audit_log WHERE actor_id = :a AND action = :x",
                                     {"a": HQ_HYUNDAI, "x": "catalog.prompts.history.export"}))
    exp = await expected("p.prompt_id IS NOT NULL AND (p.brand_code IS NULL OR p.brand_code IN ('Hyundai', 'HMG'))")
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/prompts/history", params={"format": "csv"})
        assert r.status_code == 200 and r.content.startswith(b"\xef\xbb\xbf") and "x-export-truncated" not in r.headers
        rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
        assert list(rows[0]) == list(HISTORY_COLUMNS) and [int(x["audit_id"]) for x in rows] == exp
        a2 = next(x for x in rows if int(x["audit_id"]) == S.A2)
        assert a2["changes"] == '{"text": {"new": "kr market suv", "old": "kr suv"}}'
        monkeypatch.setattr(HQ, "EXPORT_MAX_ROWS", 3)
        r = await c.get("/v1/prompts/history", params={"format": "csv"})
        assert r.headers.get("x-export-truncated") == "true" and r.content.decode("utf-8-sig").count("\r\n") == 4
    await get_audit_writer().flush()
    async with get_db().read("admin_long") as c:
        after = int(await fetch_val(c, "SELECT count(*) FROM app.access_audit_log WHERE actor_id = :a AND action = :x",
                                    {"a": HQ_HYUNDAI, "x": "catalog.prompts.history.export"}))
    assert after == before + 2


@pytest.mark.parametrize("account", [KIA_US, KIA_EU])
async def test_scope_never_widens_with_filters(client_as, account):
    """요청 필터는 스코프를 넓히지 못한다: 필터 결과 ⊆ 무필터 결과."""
    async with client_as(account) as c:
        base = set(aids((await c.get("/v1/prompts/history")).json()))
        for params in ({"brand": "Hyundai"}, {"country": "KR"}, {"brand": "Kia", "country": "US"}):
            assert set(aids((await c.get("/v1/prompts/history", params=params)).json())) <= base


@pytest.mark.parametrize("fmt", ["json", "csv"])
@pytest.mark.parametrize("frm,to", [
    ("0001-01-01", "9999-12-31"), ("9999-12-30", "9999-12-31"), ("0001-01-01", "0001-01-02"),
    ("2026-01-01", "9999-12-31"), ("1999-12-31", "2026-01-01"), ("2026-01-01", "2101-01-01"),
])
async def test_extreme_dates_422_not_500(client_as, fmt, frm, to):
    """검증 D2 회귀: 운영 범위(2000-01-01~2100-12-31) 밖 from/to 는 422. 이전엔 경계 계산 OverflowError·asyncpg 0년
    인코딩으로 500 이었고, json 은 커서가 없는데 422 cursor_invalid 로 오진했다.
    #12 로 기능 field_validator 를 core CommonFilters 범위 검사(DATE_MIN~DATE_MAX, 같은 범위)로 대체: 모델 검증이라 details.loc 끝이
    필드 이름(from·to)이 아니다(이전 기대에서 바뀐 이유). 대신 메시지로 범위 오류임을 확인한다."""
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts/history", params={"from": frm, "to": to, "format": fmt})
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "unprocessable" and any("2000-01-01~2100-12-31" in (d["msg"] or "") for d in err["details"]), err


async def test_date_range_edges_ok(client_as):
    """운영 범위 양 끝은 200(to 다음날 계산이 넘치지 않는다)."""
    async with client_as(ADMIN) as c:
        for fmt in ("json", "csv"):
            r = await c.get("/v1/prompts/history", params={"from": "2000-01-01", "to": "2100-12-31", "format": fmt})
            assert r.status_code == 200, r.text
        b = (await c.get("/v1/prompts/history", params={"from": "2000-01-01", "to": "2100-12-31"})).json()
    exp = await S.q("SELECT count(*) AS n FROM app.prompt_audit_log WHERE project_id = $1", uuid.UUID(S.ROOT))
    assert len(b["data"]["items"]) == exp[0]["n"]
