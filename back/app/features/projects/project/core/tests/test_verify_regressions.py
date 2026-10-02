"""pj-core 검증 결함(D1~D9, 검증 커밋 ceacbf1) 회귀 테스트. 결함마다 검증자 재현을 그대로 옮긴다.

기대값 확인은 구현 SQL 이 아니라 helpers 의 독립 SQL(소유자 접속)로 한다. 각 테스트는 자기 프로젝트를 만들고 지운다.
"""
from __future__ import annotations

import io
import json
import struct
import uuid
import zipfile
from typing import Any

import pytest

from app.core.envelope import crud_meta
from app.core.filters import CommonFilters, query_axes
from app.core.xlsx import XlsxError, write_workbook
from app.features.projects.project.core.shared import CRUD_CONSUMED
from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, purge, uniq
from app.features.projects.settings.tracked_urls.service import MAX_UPLOAD, export_sheet, parse_workbook
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, VENDOR, needs_db

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def build_workbook(rows: list[dict[str, Any]]) -> bytes:
    """추적 URL 내보내기와 같은 시트(6라운드: 기능 xlsx.py 를 지우고 core.xlsx 쓰기로 통일, pj-core R3 처분)."""
    return write_workbook([export_sheet(rows)])


def _writes(pid: str) -> list[tuple[str, str, dict[str, Any]]]:
    """쓰기 17종(요청 검증은 통과하는 최소 본문). 권한 판정만 보이게 한다."""
    b = f"/v1/projects/{pid}"
    s = f"{b}/settings"
    return [
        ("PATCH", b, {"json": {"name": "x"}}),
        ("DELETE", b, {"json": {"confirm_name": "x"}}),
        ("POST", f"{b}/members", {"json": {"email": "nobody@example.test"}}),
        ("PATCH", f"{b}/members/{ADMIN}", {"json": {"role": "viewer"}}),
        ("DELETE", f"{b}/members/{ADMIN}", {}),
        ("PUT", f"{s}/engines", {"json": {"engines": ["gemini"]}}),
        ("POST", f"{s}/owned-bases", {"json": {"base_url": "https://x.example.com"}}),
        ("DELETE", f"{s}/owned-bases", {"params": {"base_norm": "x.example.com"}}),
        ("POST", f"{s}/tracked-urls", {"json": {"url": "https://x.example.com/a"}}),
        ("DELETE", f"{s}/tracked-urls", {"params": {"url_norm": "x.example.com/a"}}),
        ("POST", f"{s}/tracked-urls/import", {"content": build_workbook([]), "headers": {"content-type": XLSX}}),
        ("PUT", f"{s}/brand-aliases", {"json": {"brand_code": "Kia", "aliases": []}}),
        ("POST", f"{s}/competitors", {"json": {"brand_name": "BMW"}}),
        ("DELETE", f"{s}/competitors", {"params": {"brand_name": "BMW"}}),
        ("PUT", f"{s}/competitors/target", {"json": {"brand_name": None}}),
        ("POST", f"{s}/vehicles", {"json": {"brand": "Kia", "model": "EV9"}}),
        ("DELETE", f"{s}/vehicles", {"params": {"brand": "Kia", "model": "EV9"}}),
    ]


# ── D1 비멤버 존재 은닉 ───────────────────────────────────────────────────────────
@needs_db
async def test_d1_nonmember_detail_and_writes_are_404(client_as):
    pr = await create_project(client_as, name=uniq("d1"), country_code="US", domain="secret-domain.example")
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            assert (await c.patch(f"/v1/projects/{pid}", json={"ga4_property_id": "123456789"})).status_code == 200
        # KIA_EU(권역 kia-western-europe, US 없음): 브랜드 없는 US 프로젝트 상세가 200 으로 새던 것(검증 재현) → 404
        for uid in (KIA_EU, HQ_HYUNDAI):
            async with client_as(uid) as c:
                r = await c.get(f"/v1/projects/{pid}")
                assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", (uid, r.text)
                assert "secret-domain" not in r.text and "123456789" not in r.text
                assert (await c.get(f"/v1/projects/{pid}/settings")).status_code == 404
        # 쓰기 17종: 비멤버는 403 owner_only(존재 노출)가 아니라 404, 활성 viewer 는 403 owner_only 유지
        await add_member(pid, VENDOR, "viewer")
        writes = _writes(pid)
        assert len(writes) == 17
        for method, url, kw in writes:
            async with client_as(HQ_HYUNDAI) as c:
                r = await c.request(method, url, **kw)
            assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", (method, url, r.status_code, r.text)
            async with client_as(VENDOR) as c:
                r = await c.request(method, url, **kw)
            assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", (method, url, r.status_code, r.text)
        # 상태 불변(독립 SQL)
        row = await fetch("SELECT name, ga4_property_id FROM app.project WHERE project_id = $1", uuid.UUID(pid))
        assert row == [{"name": pr["name"], "ga4_property_id": "123456789"}]
        assert await fetchval("SELECT count(*) FROM app.project_member WHERE project_id = $1", uuid.UUID(pid)) == 2
        # 활성 멤버(viewer)는 상세 200
        async with client_as(VENDOR) as c:
            r = await c.get(f"/v1/projects/{pid}")
        assert r.status_code == 200 and r.json()["data"]["my_role"] == "viewer"
    finally:
        await purge(pid)


# ── D2 NUL·서로게이트 입력 → 422(500 금지) ───────────────────────────────────────
@needs_db
async def test_d2_nul_inputs_are_422_not_500(client_as):
    pr = await create_project(client_as, name=uniq("d2"), brand_code="Kia")
    pid = pr["project_id"]
    b, s = f"/v1/projects/{pid}", f"/v1/projects/{pid}/settings"
    nul = "a\u0000b"
    base = {"name": uniq("d2n"), "country_code": "US", "ai_engines": ["chatgpt"]}
    cases: list[tuple[str, str, dict[str, Any]]] = [
        ("POST", "/v1/projects", {"json": {**base, "name": nul}}),
        ("POST", "/v1/projects", {"json": {**base, "description": nul}}),
        ("POST", "/v1/projects", {"json": {**base, "domain": "a\u0000.example.com"}}),
        ("POST", "/v1/projects", {"json": {**base, "brand_code": "Ki\u0000a"}}),
        ("POST", "/v1/projects", {"json": {**base, "ai_engines": ["chat\u0000gpt"]}}),
        ("GET", "/v1/projects", {"params": {"q": nul}}),
        ("PATCH", b, {"json": {"name": nul}}),
        ("PATCH", b, {"json": {"description": nul}}),
        ("PATCH", b, {"json": {"ga4_property_id": "12\u00003"}}),
        ("DELETE", b, {"json": {"confirm_name": nul}}),
        ("POST", f"{b}/members", {"json": {"email": "a\u0000@b.co"}}),
        ("PUT", f"{s}/engines", {"json": {"engines": [nul]}}),
        ("POST", f"{s}/owned-bases", {"json": {"base_url": "https://x.example.com", "label": nul}}),
        ("DELETE", f"{s}/owned-bases", {"params": {"base_norm": nul}}),
        ("POST", f"{s}/tracked-urls", {"json": {"url": "https://x.example.com/a", "label": nul}}),
        ("DELETE", f"{s}/tracked-urls", {"params": {"url_norm": nul}}),
        ("POST", f"{s}/competitors", {"json": {"brand_name": nul}}),
        ("POST", f"{s}/competitors", {"json": {"brand_name": "BMW", "aliases": [nul]}}),
        ("POST", f"{s}/competitors", {"json": {"brand_name": "BMW", "notes": nul}}),
        ("DELETE", f"{s}/competitors", {"params": {"brand_name": nul}}),
        ("PUT", f"{s}/competitors/target", {"json": {"brand_name": nul}}),
        ("POST", f"{s}/vehicles", {"json": {"brand": nul, "model": "EV9"}}),
        ("POST", f"{s}/vehicles", {"json": {"brand": "Kia", "model": nul}}),
        ("DELETE", f"{s}/vehicles", {"params": {"brand": nul, "model": "EV9"}}),
        ("DELETE", f"{s}/vehicles", {"params": {"brand": "Kia", "model": nul}}),
        ("PUT", f"{s}/brand-aliases", {"json": {"brand_code": "Kia", "aliases": [nul]}}),
    ]
    try:
        async with client_as(ADMIN) as c:
            for method, url, kw in cases:
                r = await c.request(method, url, **kw)
                assert r.status_code == 422, (method, url, kw, r.status_code, r.text)
            # 짝 없는 서로게이트(\ud800): ensure_ascii JSON 으로 그대로 보낸다
            raw = json.dumps({**base, "name": "a\ud800b"})
            r = await c.post("/v1/projects", content=raw, headers={"content-type": "application/json"})
            assert r.status_code == 422, r.text
        # 아무것도 쓰이지 않았다(독립 SQL)
        assert await fetchval("SELECT count(*) FROM app.project WHERE name LIKE 'd2n-%' AND name = $1", base["name"]) == 0
        assert await fetchval("SELECT count(*) FROM app.project_tracked_competitor WHERE project_id = $1", uuid.UUID(pid)) == 0
        assert await fetchval("SELECT count(*) FROM app.project_tracked_url WHERE project_id = $1", uuid.UUID(pid)) == 0
    finally:
        await purge(pid)


# ── D3 손상 xlsx → 422 invalid_xlsx(500 금지) ───────────────────────────────────
def _stored_workbook_with_bad_crc() -> bytes:
    good = build_workbook([{"url_norm": None, "url": "https://ex.com/a", "label": None}])
    src = zipfile.ZipFile(io.BytesIO(good))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for info in src.infolist():
            z.writestr(info.filename, src.read(info.filename))
    data = buf.getvalue()
    info = zipfile.ZipFile(io.BytesIO(data)).getinfo("xl/worksheets/sheet1.xml")
    crc = struct.pack("<I", info.CRC)
    assert data.count(crc) == 2                        # 로컬 헤더 + 중앙 디렉터리
    return data.replace(crc, struct.pack("<I", info.CRC ^ 0xFFFFFFFF))


def _deflated_workbook_with_corrupt_stream(at_head: bool = False) -> bytes:
    """deflate 데이터 40바이트 손상. 머리(블록 헤더)면 zlib.error, 중간이면 Bad CRC-32(zipfile.BadZipFile)."""
    rows = [{"url_norm": None, "url": f"https://ex.com/{i}/{uuid.uuid4().hex}", "label": f"l{i}"} for i in range(200)]
    data = bytearray(build_workbook(rows))
    info = zipfile.ZipFile(io.BytesIO(bytes(data))).getinfo("xl/worksheets/sheet1.xml")
    name_len, extra_len = struct.unpack("<HH", data[info.header_offset + 26:info.header_offset + 30])
    start = info.header_offset + 30 + name_len + extra_len
    mid = start if at_head else start + info.compress_size // 2
    for i in range(mid, mid + 40):
        data[i] ^= 0xA5
    return bytes(data)


@pytest.mark.parametrize("make", [_stored_workbook_with_bad_crc, _deflated_workbook_with_corrupt_stream,
                                  lambda: _deflated_workbook_with_corrupt_stream(at_head=True),
                                  lambda: build_workbook([])[:-30]])
def test_d3_parse_workbook_corrupt_zip_raises_xlsx_error(make):
    with pytest.raises(XlsxError):
        parse_workbook(make())


def test_d3_parse_workbook_cell_bomb_streams():
    """6라운드 회귀: 기능 DOM 파서(ET.fromstring 전체 트리)를 core.xlsx 스트리밍 리더로 바꿨다(pj-core R3 처분).
    압축 수 KB 의 '<c/>' 반복 시트가 원소 트리를 통째로 만들지 않는다(성공이든 예산 오류든 최고 할당이 작다)."""
    import tracemalloc
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    body = '<row r="1"><c r="A1" t="inlineStr"><is><t>url</t></is></c></row><row r="2">' + "<c/>" * 500_000 + "</row>"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{ns}"><sheetData>{body}</sheetData></worksheet>')
    data = buf.getvalue()
    assert len(data) < 64 * 1024
    tracemalloc.start()
    try:
        try:
            rows, _ = parse_workbook(data)
            outcome: Any = len(rows)
        except XlsxError as e:
            outcome = e.code
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert outcome in (0, "file_too_large", "too_many_cells"), outcome
    assert peak < 16 * 1024 * 1024, peak


@needs_db
async def test_d3_import_corrupt_zip_is_422(client_as):
    pr = await create_project(client_as, name=uniq("d3"))
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            for body in (_stored_workbook_with_bad_crc(), _deflated_workbook_with_corrupt_stream(),
                         _deflated_workbook_with_corrupt_stream(at_head=True)):
                r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=body, headers={"content-type": XLSX})
                assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_xlsx", r.text
        assert await fetchval("SELECT count(*) FROM app.project_tracked_url WHERE project_id = $1", uuid.UUID(pid)) == 0
    finally:
        await purge(pid)


# ── D4 생성 domain 검증·정규화 ───────────────────────────────────────────────────
@needs_db
async def test_d4_create_domain_validated_like_owned_bases(client_as):
    name = uniq("d4bad")
    async with client_as(ADMIN) as c:
        for bad in ("javascript:alert(1)", "ftp://kia.example.com", "https://user:pw@kia.example.com"):
            r = await c.post("/v1/projects", json={"name": name, "country_code": "US", "ai_engines": ["chatgpt"], "domain": bad})
            assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_url", (bad, r.text)
    assert await fetchval("SELECT count(*) FROM app.project WHERE name = $1", name) == 0
    made = []
    try:
        for raw, url, norm in (("HTTPS://www.Kia-D4.example.com/us/?utm_source=x#f", "https://www.kia-d4.example.com/us/?utm_source=x#f",
                                "kia-d4.example.com/us"),
                               ("Kia-D4b.example.com", "https://kia-d4b.example.com/", "kia-d4b.example.com")):
            pr = await create_project(client_as, name=uniq("d4"), domain=raw)
            made.append(pr["project_id"])
            assert pr["domain"] == norm
            ob = await fetch("SELECT base_url, base_norm FROM app.project_owned_base WHERE project_id = $1", uuid.UUID(pr["project_id"]))
            assert ob == [{"base_url": url, "base_norm": norm}]
            assert await fetchval("SELECT domain FROM app.project WHERE project_id = $1", uuid.UUID(pr["project_id"])) == norm
    finally:
        await purge(*made)


# ── D5 GA4 속성 ID 는 ASCII 숫자만 ──────────────────────────────────────────────
@needs_db
async def test_d5_ga4_ascii_digits_only(client_as):
    pr = await create_project(client_as, name=uniq("d5"))
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            for bad in ("١٢", "²³", "12a", "１２"):
                r = await c.patch(f"/v1/projects/{pid}", json={"ga4_property_id": bad})
                assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_ga4_property_id", (bad, r.text)
            assert await fetchval("SELECT ga4_property_id FROM app.project WHERE project_id = $1", uuid.UUID(pid)) is None
            r = await c.patch(f"/v1/projects/{pid}", json={"ga4_property_id": "0123"})
            assert r.status_code == 200 and r.json()["data"]["ga4_property_id"] == "0123"
    finally:
        await purge(pid)


# ── D6 엔진 편집 가능 여부 = can_edit ∧ 운영자 ─────────────────────────────────────
@needs_db
async def test_d6_engines_can_edit_matches_put_gate(client_as):
    pr = await create_project(client_as, name=uniq("d6"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "owner")            # operator none Owner
    await add_member(pid, HQ_HYUNDAI, "owner")        # operator assigned Owner
    try:
        for uid, can_engines, put_status in ((VENDOR, False, 403), (HQ_HYUNDAI, True, 200), (ADMIN, True, 200)):
            async with client_as(uid) as c:
                d = (await c.get(f"/v1/projects/{pid}/settings")).json()["data"]
                r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
            assert d["can_edit"] is True and d["engines"]["can_edit"] is can_engines, uid
            assert r.status_code == put_status, (uid, r.text)
    finally:
        await purge(pid)


# ── D7 가져오기 권한 판정은 본문을 읽기 전 ────────────────────────────────────────
@needs_db
async def test_d7_import_authz_before_body(client_as):
    pr = await create_project(client_as, name=uniq("d7"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer")
    big = b"\0" * (MAX_UPLOAD + 1)                    # 전에는 크기 검사(422 invalid_xlsx)가 권한보다 먼저였다
    try:
        for uid, status, code in ((VENDOR, 403, "owner_only"), (HQ_HYUNDAI, 404, "not_found")):
            async with client_as(uid) as c:
                r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=big, headers={"content-type": XLSX})
            assert r.status_code == status and r.json()["error"]["code"] == code, (uid, r.text)
        async with client_as(ADMIN) as c:
            r = await c.post(f"/v1/projects/{pid}/settings/tracked-urls/import", content=big, headers={"content-type": XLSX})
        # 상한 초과는 core.upload.read_upload_request 의 413 payload_too_large(6라운드 업로드 상한 한 곳, R3). 전에는 기능이 422 invalid_xlsx
        assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    finally:
        await purge(pid)


# ── D8 무시 필터 축은 core 축 이름표에서 파생 ────────────────────────────────────
# 6라운드: 기능 안 _AXIS_PARAMS·crud_meta 를 지우고 core.filters.query_axes·core.envelope.crud_meta 를 쓴다(R1 반영).
# core 는 surface·project_id·own_brand 도 축 이름으로 적는다. pj-core 는 project_id 를 경로가 대신하므로 consumed 로 뺀다(기존 계약 유지).
def test_d8_axis_params_derive_from_common_filters():
    axes = query_axes()
    assert {f.alias or n for n, f in CommonFilters.model_fields.items()} <= set(axes)
    assert axes["from"] == axes["to"] == "period"
    params = {k: "x" for k in axes} | {"cf.00000000-0000-0000-0000-000000000000": "v"}
    got = crud_meta(params, surface="project", consumed=CRUD_CONSUMED).ignored_filters
    assert set(got) == {axes[k] for k in axes if k not in CRUD_CONSUMED} | {"custom"}
    assert "surface" in got and "project_id" not in got


# ── D9 없는·엄브렐러 브랜드 생성은 PATCH 와 같은 422 unknown_brand ─────────────────
@needs_db
async def test_d9_create_unknown_brand_is_422(client_as):
    name = uniq("d9")
    async with client_as(ADMIN) as c:
        for brand in ("NoSuch", "HMG"):
            r = await c.post("/v1/projects", json={"name": name, "country_code": "US", "ai_engines": ["chatgpt"], "brand_code": brand})
            assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_brand", (brand, r.text)
    assert await fetchval("SELECT count(*) FROM app.project WHERE name = $1", name) == 0
    pr = await create_project(client_as, name=uniq("d9p"))
    try:
        async with client_as(ADMIN) as c:
            r = await c.patch(f"/v1/projects/{pr['project_id']}", json={"brand_code": "NoSuch"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_brand"
    finally:
        await purge(pr["project_id"])
