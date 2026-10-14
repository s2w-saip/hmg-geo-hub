"""admin.interest.sources 통합 테스트(로컬 개발 DB 복제본 ad_content). 픽스처엔 표준 소스가 없어(0행) 테스트가 만든 행만 쓴다.
DB 가 실행 간 유지되므로 각 테스트는 uuid 표식 url 으로 자기 행만 걸러 본다."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

U = "/v1/admin/interest/sources"
pytestmark = needs_db


async def _val(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


@pytest.mark.parametrize("uid,status", [(ADMIN, 200), (HQ_HYUNDAI, 403), (KIA_US, 403), (VENDOR, 403), (KIA_EU, 403),
                                        (SUSPENDED, 401), (None, 401)])
async def test_access(client_as, uid, status):
    async with client_as(uid) as c:
        r = await c.get(U)
    assert r.status_code == status


async def test_list_menu_gate(client_as):
    """B068: 목록 GET 은 legacy 페이지 게이트(route-policy /admin = group admin)와 같게 메뉴 그룹 admin 도 본다(롤백 전용 준비).
    admin 메뉴 없는 admin = 403 menu_forbidden, admin 메뉴 admin = 200. 쓰기는 legacy 액션처럼 role 만(본문 검증 422 까지 간다, 쓰지 않음)."""
    from tests.support import Sql, Update, staged

    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))      # 계정 쓰기 = 감사 트리거 행위자 필수
    async with staged(actor, Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})), client_as(ADMIN) as c:
        r = await c.get(U)
        w = await c.post(U, json={})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden" and "items" not in r.text
    assert w.status_code == 422
    async with staged(actor, Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["admin"]})), client_as(ADMIN) as c:
        r = await c.get(U)
    assert r.status_code == 200 and "items" in r.json()["data"]


async def test_non_admin_cannot_write(client_as):
    tag = uuid.uuid4().hex[:8]
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.post(U, json={"url": f"hq-{tag}", "channel": "news"})
    assert r.status_code == 403
    assert await _val("SELECT count(*) FROM app.standard_source WHERE url = $1", f"hq-{tag}") == 0


async def test_crud_and_filters(client_as):
    tag = uuid.uuid4().hex[:8]
    jc = await _val("SELECT coalesce(max(change_id), 0) FROM app.judgment_change")
    async with client_as(ADMIN) as c:
        empty = await c.get(U, params={"q": tag})
        a = await c.post(U, json={"url": f"  https://a.example/{tag} ", "channel": "news", "brand_code": "Kia", "notes": " n "})
        b = await c.post(U, json={"url": f"https://b.example/{tag}", "channel": "social", "enabled": False})
        assert a.status_code == 201 and b.status_code == 201, a.text
        allr = await c.get(U, params={"q": tag})
        voc = await c.get(U, params={"q": tag, "channel": "social"})
        kia = await c.get(U, params={"q": tag, "brand": "Kia", "country": "US"})
        on = await c.get(U, params={"q": tag, "enabled": "true"})
    assert empty.status_code == 200 and empty.json()["data"]["items"] == []
    ka = a.json()["data"]
    assert ka["url"] == f"https://a.example/{tag}" and ka["notes"] == "n" and ka["brand_code"] == "Kia" and ka["created_by"] == str(ADMIN)
    assert [i["url"] for i in allr.json()["data"]["items"]] == [f"https://a.example/{tag}", f"https://b.example/{tag}"]    # channel asc(news < social)
    assert [i["url"] for i in voc.json()["data"]["items"]] == [f"https://b.example/{tag}"]
    assert [i["url"] for i in kia.json()["data"]["items"]] == [f"https://a.example/{tag}"]
    assert kia.json()["meta"]["ignored_filters"] == ["country"]
    assert [i["url"] for i in on.json()["data"]["items"]] == [f"https://a.example/{tag}"]
    kid = ka["source_id"]
    async with client_as(ADMIN) as c:
        p = await c.patch(f"{U}/{kid}", json={"enabled": False, "brand_code": None, "notes": "  "})
        pn = await c.patch(f"{U}/{kid}", json={"url": None})
        pe = await c.patch(f"{U}/{kid}", json={})
        pb = await c.patch(f"{U}/{kid}", json={"brand_code": "Nope"})
        p404 = await c.patch(f"{U}/{uuid.uuid4()}", json={"enabled": True})
        d = await c.delete(f"{U}/{kid}")
        d404 = await c.delete(f"{U}/{kid}")
    pd = p.json()["data"]
    assert p.status_code == 200 and pd["enabled"] is False and pd["brand_code"] is None and pd["notes"] is None
    assert pd["updated_at"] >= ka["updated_at"]
    assert pn.status_code == 422 and pe.status_code == 422
    assert pb.status_code == 422 and pb.json()["error"]["code"] == "unknown_brand"
    assert p404.status_code == 404
    assert d.status_code == 200 and d.json()["data"] == {"source_id": kid, "deleted": True} and d404.status_code == 404
    assert await _val("SELECT count(*) FROM app.standard_source WHERE source_id = $1", uuid.UUID(kid)) == 0
    # 판정 입력 아님: 재판정 요청 없음. 같은 DB 복제본의 다른 쓰기와 섞이지 않게 이 테스트의 행(id·tag)을 가리키는 요청만 센다.
    assert await _val("SELECT count(*) FROM app.judgment_change WHERE change_id > $1 AND (payload::text LIKE $2 OR payload::text LIKE $3 "
                      "OR $4::uuid = ANY(coalesce(subject_uuids, '{}')))", jc, f"%{kid}%", f"%{tag}%", uuid.UUID(kid)) == 0


@pytest.mark.parametrize("body,code", [({"url": "x", "channel": "tv"}, "unprocessable"),
                                       ({"url": "x", "channel": "news", "brand_code": "Nope"}, "unknown_brand"),
                                       ({"url": "   ", "channel": "news"}, "unprocessable"),
                                       ({"url": "x", "channel": "news", "extra": 1}, "unprocessable"),
                                       ({"url": "a\nb", "channel": "news"}, "unprocessable"),          # R3: 한 줄 값 PgLine
                                       ({"url": "x", "channel": "news", "notes": "a\x00b"}, "unprocessable")])   # R3: 메모 PgText(NUL)
async def test_create_422_writes_nothing(client_as, body, code):
    before = await _val("SELECT count(*) FROM app.standard_source")
    async with client_as(ADMIN) as c:
        r = await c.post(U, json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == code
    assert await _val("SELECT count(*) FROM app.standard_source") == before


async def test_list_422(client_as):
    async with client_as(ADMIN) as c:
        r1 = await c.get(U, params={"channel": "bogus"})
        r2 = await c.get(U, params={"enabled": "sometimes"})
    assert r1.status_code == 422 and r2.status_code == 422


async def test_patch_rolls_back_on_failure(client_as, monkeypatch):
    from app.features.admin.interest.sources import service as svc

    tag = uuid.uuid4().hex[:8]
    async with client_as(ADMIN) as c:
        kid = (await c.post(U, json={"url": f"rb-{tag}", "channel": "news"})).json()["data"]["source_id"]

    def boom(**kw):
        raise RuntimeError("주입: 응답 변환 실패")
    monkeypatch.setattr(svc, "Source", boom)
    async with client_as(ADMIN) as c:
        with pytest.raises(RuntimeError):
            await c.patch(f"{U}/{kid}", json={"url": f"rb-{tag}-v2"})
    assert await _val("SELECT url FROM app.standard_source WHERE source_id = $1", uuid.UUID(kid)) == f"rb-{tag}"
