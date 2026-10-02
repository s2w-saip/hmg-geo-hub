"""projects.prompts.fields: 태그 목록·추가(예약어·중복)·보관·복구·삭제(CASCADE)·값 UPSERT·일괄·지우기, IDOR·롤백."""
from __future__ import annotations

import uuid

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db


def furl(pid, suffix=""):
    return f"/v1/projects/{pid}/prompt-fields{suffix}"


def vurl(pid, prompt, field):
    return f"/v1/projects/{pid}/prompts/{prompt}/fields/{field}"


async def test_list_and_create(env, client_as):
    pid = await env.mk_project()
    f1 = await env.mk_field("세그먼트", project_id=pid)
    await env.mk_field("old", project_id=pid, archived=True)
    p = await env.mk_prompt("x", project_id=pid)
    await env.set_tag(p, f1, "SUV", project_id=pid)
    async with client_as(VENDOR) as c:
        r = await c.get(furl(pid), params={"brand": "Kia"})
    assert r.status_code == 200, r.text
    items = r.json()["data"]["items"]
    assert [(i["label"], i["archived"], i["value_count"]) for i in items] == [("세그먼트", False, 1), ("old", True, 0)]
    assert r.json()["meta"]["ignored_filters"] == ["brand"]
    async with client_as(env.owner) as c:
        r = await c.post(furl(pid), json={"label": "  지역  "})
        assert r.status_code == 201 and r.json()["data"]["label"] == "지역" and r.json()["data"]["value_count"] == 0
        for label, code, err in (("Brand", 422, "reserved_label"), ("카테고리", 422, "reserved_label"), ("세그먼트", 409, "duplicate"),
                                 ("OLD", 409, "duplicate")):
            r = await c.post(furl(pid), json={"label": label})
            assert r.status_code == code and r.json()["error"]["code"] == err, label
        for body in ({"label": ""}, {"label": "   "}, {"label": "a" * 101}, {"label": "a\nb"}, {}):
            assert (await c.post(furl(pid), json=body)).status_code == 422, body
    for uid, code in ((VENDOR, 403), (HQ_HYUNDAI, 403), (KIA_US, 404), (ADMIN, 201)):
        async with client_as(uid) as c:
            assert (await c.post(furl(pid), json={"label": f"by-{uuid.uuid4().hex[:6]}"})).status_code == code, uid
    empty = await env.mk_project()
    async with client_as(env.owner) as c:
        r = await c.get(furl(empty))
        assert r.status_code == 200 and r.json()["data"]["items"] == []


async def test_archive_restore_delete_cascade(env, client_as):
    pid = await env.mk_project()
    f = await env.mk_field("tag", project_id=pid)
    p = await env.mk_prompt("x", project_id=pid)
    await env.set_tag(p, f, "v", project_id=pid)
    other = await env.mk_project()
    foreign = await env.mk_field("tag", project_id=other)
    async with client_as(env.owner) as c:
        r = await c.post(furl(pid, f"/{f}/archive"))
        assert r.status_code == 200 and r.json()["data"]["archived"] is True
        r = await c.post(furl(pid, f"/{f}/restore"))
        assert r.status_code == 200 and r.json()["data"]["archived"] is False
        for path in (f"/{foreign}/archive", f"/{foreign}/restore"):
            assert (await c.post(furl(pid, path))).status_code == 404                    # IDOR
        assert (await c.delete(furl(pid, f"/{foreign}"))).status_code == 404
        assert (await c.delete(furl(pid, f"/{f}"))).status_code == 204
        assert (await c.delete(furl(pid, f"/{f}"))).status_code == 404
    assert await env.val("SELECT count(*) FROM app.prompt_custom_field_value WHERE field_id = $1", f) == 0
    assert await env.val("SELECT archived FROM app.project_custom_field WHERE field_id = $1", foreign) is False
    async with client_as(VENDOR) as c:
        r = await c.post(furl(other, f"/{foreign}/archive"))                            # vendor 는 other 의 viewer = 소유 아님
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"


async def test_values_put_bulk_clear(env, client_as):
    pid = await env.mk_project()
    f = await env.mk_field("seg", project_id=pid)
    p1, p2, p3 = [await env.mk_prompt(f"p{i}", project_id=pid) for i in range(3)]
    gone = await env.mk_prompt("gone", project_id=pid)
    await env.as_actor("UPDATE app.prompt SET deleted_at = now() WHERE prompt_id = $1", gone)
    other = await env.mk_project()
    ff = await env.mk_field("seg", project_id=other)
    fp = await env.mk_prompt("fp", project_id=other)
    async with client_as(env.owner) as c:
        r = await c.put(vurl(pid, p1, f), json={"value": " SUV "})
        assert r.status_code == 200 and r.json()["data"] == {"prompt_id": str(p1), "field_id": str(f), "value": "SUV"}
        r = await c.put(vurl(pid, p1, f), json={"value": "Sedan"})
        assert r.status_code == 200
        for pr, fl in ((p1, ff), (fp, f), (gone, f), (uuid.uuid4(), f)):
            assert (await c.put(vurl(pid, pr, fl), json={"value": "x"})).status_code == 404, (pr, fl)
        for body in ({"value": ""}, {"value": " "}, {"value": "x" * 501}, {}):
            assert (await c.put(vurl(pid, p1, f), json=body)).status_code == 422
        r = await c.post(furl(pid, f"/{f}/bulk-set"), json={"prompt_ids": [str(p1), str(p2), str(p3), str(p2)], "value": "EV"})
        assert r.status_code == 200 and r.json()["data"] == {"field_id": str(f), "count": 3}
        # 한 건이라도 다른 프로젝트·삭제 행이면 전체 404 + 쓰기 없음(롤백)
        r = await c.post(furl(pid, f"/{f}/bulk-set"), json={"prompt_ids": [str(p1), str(fp)], "value": "ZZ"})
        assert r.status_code == 404
        assert (await c.post(furl(pid, f"/{f}/bulk-set"), json={"prompt_ids": [], "value": "x"})).status_code == 422
        assert (await c.delete(vurl(pid, p2, f))).status_code == 204
        assert (await c.delete(vurl(pid, p2, f))).status_code == 204                   # 값 없어도 멱등
        assert (await c.delete(vurl(pid, fp, f))).status_code == 404
    vals = {r["prompt_id"]: r["value"] for r in await env.q("SELECT prompt_id, value FROM app.prompt_custom_field_value WHERE field_id = $1", f)}
    assert vals == {p1: "EV", p3: "EV"}
    assert await env.val("SELECT count(*) FROM app.prompt_custom_field_value WHERE prompt_id = $1", fp) == 0
    async with client_as(VENDOR) as c:
        assert (await c.put(vurl(pid, p1, f), json={"value": "x"})).status_code == 403
    async with client_as(env.owner) as c:                                              # 목록 태그값 반영
        items = (await c.get(f"/v1/projects/{pid}/prompts")).json()["data"]["items"]
    assert {i["prompt_id"]: i["tags"] for i in items} == {str(p1): {str(f): "EV"}, str(p2): {}, str(p3): {str(f): "EV"}}
