"""projects.settings.tracked_urls(PJ-4) API 테스트: 추가·삭제·키셋·재판정 큐, xlsx 내보내기·가져오기(sharedStrings 형식 직접 작성)."""
from __future__ import annotations

import io
import uuid
import zipfile
from xml.sax.saxutils import escape

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, purge, uniq
from tests.support import ADMIN, HQ_HYUNDAI, VENDOR, needs_db

pytestmark = needs_db
JC = "SELECT count(*) FROM app.judgment_change WHERE kind = 'project_target_url' AND $1 = ANY(subject_uuids)"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def excel_like(rows: list[list[str]]) -> bytes:
    """엑셀이 저장하는 형태(sharedStrings + t="s")로 xlsx 를 만든다(구현의 쓰기 함수와 독립)."""
    strings: list[str] = []
    cells = []
    for i, row in enumerate(rows, start=1):
        cs = []
        for j, v in enumerate(row):
            if v == "":
                continue
            strings.append(v)
            cs.append(f'<c r="{chr(65 + j)}{i}" t="s"><v>{len(strings) - 1}</v></c>')
        cells.append(f'<row r="{i}">{"".join(cs)}</row>')
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    sst = f'<sst xmlns="{ns}">' + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{ns}"><sheetData>{"".join(cells)}</sheetData></worksheet>')
        z.writestr("xl/sharedStrings.xml", sst)
    return buf.getvalue()


async def test_add_list_delete_and_queue(client_as):
    pr = await create_project(client_as, name=uniq("tu"))
    pid = uuid.UUID(pr["project_id"])
    try:
        async with client_as(ADMIN) as c:
            for u in ("https://Example.com/a?utm_source=chatgpt.com", "https://example.com/b", "https://example.com/c/"):
                r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": u, "label": "L"})
                assert r.status_code == 201, r.text
            assert r.json()["data"]["url_norm"] == "example.com/c" and r.json()["data"]["tracked_url"]["url"] == "https://example.com/c/"
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "http://www.example.com/a#frag"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_tracked_url"
            assert (await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "mailto:x@y"})).status_code == 422
            p1 = (await c.get(f"/v1/projects/{pid}/settings/tracked-urls", params={"limit": 2, "engine": "gemini"})).json()
            assert p1["data"]["total"] == 3 and len(p1["data"]["items"]) == 2 and p1["meta"]["ignored_filters"] == ["engine"]
            p2 = (await c.get(f"/v1/projects/{pid}/settings/tracked-urls", params={"limit": 2, "cursor": p1["data"]["next_cursor"]})).json()
            got = [i["url_norm"] for i in p1["data"]["items"] + p2["data"]["items"]]
            exp = [r["url_norm"] for r in await fetch("SELECT url_norm FROM app.project_tracked_url WHERE project_id = $1 "
                                                      "ORDER BY created_at DESC, url_norm DESC", pid)]
            assert got == exp and p2["data"]["next_cursor"] is None
            r = await c.delete(f"/v1/projects/{pid}/settings/tracked-urls", params={"url_norm": "example.com/b"})
            assert r.status_code == 200
            r = await c.delete(f"/v1/projects/{pid}/settings/tracked-urls", params={"url_norm": "example.com/b"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "tracked_url_not_found"
        assert await fetchval(JC, pid) == 4                          # 추가 3 + 삭제 1(거부 0)
        assert await fetchval("SELECT count(*) FROM app.project_tracked_url WHERE project_id = $1", pid) == 2
        async with client_as(HQ_HYUNDAI) as c:
            assert (await c.get(f"/v1/projects/{pid}/settings/tracked-urls")).status_code == 404
        await add_member(pid, VENDOR, "viewer")
        async with client_as(VENDOR) as c:
            assert (await c.get(f"/v1/projects/{pid}/settings/tracked-urls")).json()["data"]["total"] == 2
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "https://example.com/z"})
            assert r.status_code == 403
    finally:
        await purge(pid)


async def test_export_and_import(client_as):
    pr = await create_project(client_as, name=uniq("tx"))
    pid = uuid.UUID(pr["project_id"])
    try:
        async with client_as(ADMIN) as c:
            await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "https://ex.com/keep", "label": "old"})
            await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "https://ex.com/dup"})
            r = await c.get(f"/v1/projects/{pid}/settings/tracked-urls/export")
            assert r.status_code == 200 and r.headers["content-type"] == XLSX and "attachment" in r.headers["content-disposition"]
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                sheet = z.read("xl/worksheets/sheet1.xml").decode()
            for s in ("url_norm", "ex.com/keep", "https://ex.com/dup", "old"):
                assert s in sheet
            jc0 = await fetchval(JC, pid)
            body = excel_like([["URL", "Label", "url_norm"],
                               ["https://ex.com/new", "n", ""],                    # 추가
                               ["", "new-label", "ex.com/keep"],                  # 수정(label)
                               ["", "", "ex.com/nope"],                            # 없는 키 → 건너뜀
                               ["https://www.ex.com/dup/", "", ""],                # 이미 있음 → 건너뜀
                               ["not a url", "", ""],                              # 형식 오류 → 건너뜀
                               ["", "", ""]])
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=body, headers={"content-type": XLSX})
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert (d["created"], d["updated"], d["skipped"]) == (1, 1, 3) and len(d["warnings"]) == 3 and d["change_id"]
            assert await fetchval(JC, pid) == jc0 + 1                                # 가져오기 1회 = 1건
            rows = {x["url_norm"]: x["label"] for x in await fetch("SELECT url_norm, label FROM app.project_tracked_url WHERE project_id = $1", pid)}
            assert rows == {"ex.com/keep": "new-label", "ex.com/dup": None, "ex.com/new": "n"}
            # label 열이 없으면 label 을 건드리지 않는다, 변경 없으면 큐 없음
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=excel_like([["url_norm"], ["ex.com/keep"]]),
                             headers={"content-type": XLSX})
            assert r.json()["data"] == {"created": 0, "updated": 0, "skipped": 1, "warnings": [], "change_id": None, "propagation": "none"}
            assert await fetchval("SELECT label FROM app.project_tracked_url WHERE project_id = $1 AND url_norm = 'ex.com/keep'", pid) == "new-label"
            # multipart/form-data 의 file 필드(현행 FormData)도 받는다(6라운드 core.upload.read_upload_request, R3)
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import",
                             files={"file": ("t.xlsx", excel_like([["url_norm"], ["ex.com/keep"]]), XLSX)})
            assert r.status_code == 200 and r.json()["data"]["skipped"] == 1, r.text
            # 빈 본문은 core.upload.read_upload_request 의 422 invalid_upload(6라운드 업로드 공용화, R3). 전에는 기능이 invalid_xlsx
            for bad, code in ((b"", "invalid_upload"), (b"not a zip", "invalid_xlsx"), (excel_like([["foo"], ["bar"]]), None)):
                r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=bad, headers={"content-type": XLSX})
                if code is None:
                    assert r.status_code == 200 and r.json()["data"]["warnings"] and r.json()["data"]["created"] == 0
                else:
                    assert r.status_code == 422 and r.json()["error"]["code"] == code, bad
        await add_member(pid, VENDOR, "viewer")
        async with client_as(VENDOR) as c:
            assert (await c.get(f"/v1/projects/{pid}/settings/tracked-urls/export")).status_code == 200
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=excel_like([["url"], ["https://ex.com/v"]]),
                             headers={"content-type": XLSX})
            assert r.status_code == 403
        async with client_as(HQ_HYUNDAI) as c:
            assert (await c.get(f"/v1/projects/{pid}/settings/tracked-urls/export")).status_code == 404
    finally:
        await purge(pid)


async def _urls(pid) -> dict[str, tuple[str, str | None]]:
    return {r["url_norm"]: (r["url"], r["label"]) for r in
            await fetch("SELECT url_norm, url, label FROM app.project_tracked_url WHERE project_id = $1", pid)}


async def test_import_rows_in_order_with_bulk_writes(client_as):
    """B026: 행 규칙은 시트 행 순서대로 적용한 결과와 같다(앞 행의 추가·수정이 뒤 행 판정에 보인다). 판정은 메모리에서, 쓰기는
    추적 URL 표에 SELECT 1 + UPDATE 1 + INSERT 1 문장(행마다 EXISTS·UPDATE|INSERT 없음). 권한 판정은 1회."""
    from tests.core.rcache_calls import Stmts
    pr = await create_project(client_as, name=uniq("tb1"))
    pid = uuid.UUID(pr["project_id"])
    try:
        async with client_as(ADMIN) as c:
            await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "https://ex.com/k", "label": "old"})
            await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": "https://ex.com/m"})
            body = excel_like([["url_norm", "url", "label"],
                               ["", "https://ex.com/n1", "one"],                 # 2 추가
                               ["ex.com/n1", "", "uno"],                         # 3 방금 추가한 행 수정
                               ["ex.com/k", "https://ex.com/k2", "kk"],          # 4 키 변경 k → k2
                               ["", "https://ex.com/k", ""],                     # 5 비워진 k 로 추가
                               ["", "https://www.ex.com/m/", ""],                # 6 이미 있음 → 건너뜀
                               ["ex.com/m", "", ""],                             # 7 변경 없음 → 건너뜀(경고 없음)
                               ["ex.com/k", "", "again"]])                       # 8 5행이 추가한 k 수정
            with Stmts() as s:
                r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=body, headers={"content-type": XLSX})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["created"], d["updated"], d["skipped"]) == (2, 3, 2) and d["warnings"] == ["행 6: 이미 등록된 URL 이라 건너뜀"]
        assert await _urls(pid) == {"ex.com/n1": ("https://ex.com/n1", "uno"), "ex.com/k2": ("https://ex.com/k2", "kk"),
                                    "ex.com/k": ("https://ex.com/k", "again"), "ex.com/m": ("https://ex.com/m", None)}
        assert len([x for x in s.seen if "app.project_tracked_url" in x]) == 3
        assert len([x for x in s.seen if "m.status::text AS member_status" in x]) == 1       # core resolve_project(권한 판정) 1회
    finally:
        await purge(pid)


async def test_import_key_handover_keeps_row_order_semantics(client_as):
    """B026: 시작 시점에 있던 키를 다른 행이 넘겨받는 수정(b → b2 뒤 a → b)도 행 순서대로 적용한 결과와 같다(행별 문장 경로)."""
    pr = await create_project(client_as, name=uniq("tb2"))
    pid = uuid.UUID(pr["project_id"])
    try:
        async with client_as(ADMIN) as c:
            for u, lab in (("https://ex.com/a", None), ("https://ex.com/b", None), ("https://ex.com/c", "c")):
                await c.post(f"/v1/projects/{pid}/settings/tracked-urls", json={"url": u, "label": lab})
            body = excel_like([["url_norm", "url", "label"],
                               ["ex.com/b", "https://ex.com/b2", ""],            # 2 b → b2
                               ["ex.com/a", "https://ex.com/b", "x"],            # 3 a → b(2행이 비운 키)
                               ["", "https://ex.com/a", "new a"],                # 4 비워진 a 로 추가
                               ["ex.com/a", "", "again"],                        # 5 4행이 추가한 a 수정
                               ["", "https://ex.com/c", ""],                     # 6 이미 있음 → 건너뜀
                               ["ex.com/zz", "", ""],                            # 7 없는 키 → 건너뜀
                               ["ex.com/c", "https://ex.com/b2", ""]])           # 8 2행이 만든 b2 와 겹침 → 건너뜀
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=body, headers={"content-type": XLSX})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["created"], d["updated"], d["skipped"]) == (1, 3, 3)
        assert d["warnings"] == ["행 6: 이미 등록된 URL 이라 건너뜀",
                                 "행 7: url_norm 을 이 프로젝트에서 찾을 수 없어 건너뜀(신규는 url_norm 칸을 비운다)",
                                 "행 8: 이미 등록된 URL 이라 건너뜀"]
        assert await _urls(pid) == {"ex.com/b2": ("https://ex.com/b2", None), "ex.com/b": ("https://ex.com/b", "x"),
                                    "ex.com/a": ("https://ex.com/a", "again"), "ex.com/c": ("https://ex.com/c", "c")}
    finally:
        await purge(pid)
