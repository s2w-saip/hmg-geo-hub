"""값 갭 보강(BG-34 글로벌 전량 모드 · BG-35 웹사이트 내보내기 화면 모양) 통합·단위 테스트.

기대값은 seed.py·공용 픽스처 행을 손으로 옮긴 값 또는 구현과 다른 형태의 독립 SQL 이다(구현 SQL 복붙 금지).
- BG-34 근거: front standard/prompts/page.tsx:43 listStandardCatalogScoped(전량, 클라이언트 필터). 새 API = all=true 한 번.
- BG-35 근거: front app/api/website/prompts/export/route.ts:63-98 + lib/website/prompt-export.ts:55-83(8열·라벨·표시명·'측정 없음').
공용 픽스처 웹사이트 Kia DE 3행: ev9?(chatgpt 1건, 09-18) · deals?(0) · sub?(gemini 1건, 09-18). seed 웹사이트: us kia a·=1+1 us kia 50%_b(Kia US, en),
n de(Hyundai N DE, de), kr hy(Hyundai KR, ko).
"""
from __future__ import annotations

import csv
import io
import json
import re
import uuid
import zipfile
from pathlib import Path
from urllib.parse import unquote

import pytest
import pytest_asyncio

from app.core.db import fetch_all, get_db
from app.core.write import get_audit_writer
from app.core.xlsx import XlsxReader
from app.features.catalog.prompts.catalog import queries as CQ
from app.features.catalog.prompts.catalog import screen_export as SX
from app.features.catalog.prompts.catalog import service as svc
from app.features.catalog.prompts.catalog.tests import seed as S
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SYSTEM, VENDOR, Sql, needs_db, staged

G = S.gid
F_BEST_H = uuid.UUID("c1000000-0000-4000-8000-000000000001")
F_COMMON = uuid.UUID("c1000000-0000-4000-8000-000000000002")
F_ACR = uuid.UUID("c1000000-0000-4000-8000-000000000003")
F_HY_KO = uuid.UUID("c1000000-0000-4000-8000-000000000004")
F_US_ONLY = uuid.UUID("c1000000-0000-4000-8000-000000000006")
F_BEST_G = uuid.UUID("c1000000-0000-4000-8000-000000000011")

ORDER_SQL = ("SELECT prompt_id FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL "
             "ORDER BY depth1 ASC NULLS LAST, depth2 ASC NULLS LAST, depth3 ASC NULLS LAST, text, prompt_id")


@pytest_asyncio.fixture(scope="module", loop_scope="session", autouse=True)
async def _seed(seeded):
    await S.seed()


def ids(body) -> list[uuid.UUID]:
    return [uuid.UUID(x["prompt_id"]) for x in body["data"]["items"]]


# ════════════════════════════════════════════════════════════════════════════
# BG-34 글로벌 전량 모드(all=true)
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_global_all_mode_one_response_matches_independent_order(client_as):
    expected = [r["prompt_id"] for r in await S.q(ORDER_SQL, uuid.UUID(S.ROOT))]
    assert len(expected) == 14                                                        # 픽스처 6 + seed 8(soft-delete 제외)
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "global", "all": "true"})
        lim = await c.get("/v1/prompts", params={"surface": "global", "all": "true", "limit": 2})   # 전량 모드는 limit 무시
    assert r.status_code == 200, r.text
    b = r.json()
    assert ids(b) == expected
    assert b["meta"]["page"] == {"next_cursor": None, "limit": svc.GLOBAL_ALL_MAX, "total": 14}
    assert svc.GLOBAL_ALL_MAX == 25_000                                               # 상한은 코드 상수(무상한 금지)
    assert ids(lim.json()) == expected and lim.json()["meta"]["page"]["limit"] == 25_000
    assert b["meta"]["ignored_filters"] == []                                          # global 은 all 을 지원(무시 목록에 없다)
    assert lim.json()["meta"]["ignored_filters"] == ["limit"]                          # 전량 모드가 쓰지 않은 limit 은 드러낸다(검증 m-1)


@pytest.mark.parametrize("limit", ["-5", "0", "501", "abc"])
@needs_db
async def test_global_all_mode_still_validates_limit_422(client_as, limit):
    """검증 m-1 재현: all=true 에서 limit=-5·501 이 200(meta.page.limit 25,000, ignored_filters [])이었다.
    all 없이와 같은 형식 검증(1~500, 422)을 거치고, 형식이 맞으면 meta.ignored_filters 에 limit 을 드러낸다."""
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "global", "all": "true", "limit": limit})
        plain = await c.get("/v1/prompts", params={"surface": "global", "limit": limit})
    assert r.status_code == 422, r.text
    assert plain.status_code == 422                                                    # all 유무와 같은 판정


@needs_db
async def test_global_all_mode_valid_limit_reported_ignored(client_as):
    async with client_as(ADMIN) as c:
        edge = await c.get("/v1/prompts", params={"surface": "global", "all": "true", "limit": 500})
        none = await c.get("/v1/prompts", params={"surface": "global", "all": "true"})
        paged = await c.get("/v1/prompts", params={"surface": "global", "limit": 500})
    assert edge.status_code == 200 and edge.json()["meta"]["ignored_filters"] == ["limit"]
    assert edge.json()["meta"]["page"]["limit"] == 25_000 and ids(edge.json()) == ids(none.json())
    assert none.json()["meta"]["ignored_filters"] == [] and paged.json()["meta"]["ignored_filters"] == []   # 일반 키셋은 limit 을 쓴다


@needs_db
async def test_global_all_mode_scope_no_leak(client_as):
    """권한: 전량 모드도 같은 스코프 술어(브랜드 ∪ 엄브렐러·NULL, B1 시장). 손계산 집합은 test_catalog 스코프 테스트와 같은 행."""
    async with client_as(HQ_HYUNDAI) as c:
        hy = (await c.get("/v1/prompts", params={"surface": "global", "all": "true"})).json()
        kia = (await c.get("/v1/prompts", params={"surface": "global", "all": "true", "brand": "Kia"})).json()
    assert set(ids(hy)) == {F_BEST_H, F_COMMON, F_ACR, F_HY_KO, G(1), G(7)} and hy["meta"]["page"]["total"] == 6
    assert kia["meta"]["dropped_filters"] == {"brand": ["Kia"]} and set(ids(kia)) == set(ids(hy))   # 스코프 밖 요청은 행을 늘리지 않는다
    async with client_as(KIA_US) as c:
        us = (await c.get("/v1/prompts", params={"surface": "global", "all": "true"})).json()
        leak = (await c.get("/v1/prompts", params={"surface": "global", "all": "true", "country": "DE"})).json()
    assert set(ids(us)) == {F_COMMON, F_ACR, F_US_ONLY, G(2), G(3), G(4), G(7), G(8)}
    assert leak["data"]["items"] == [] and leak["meta"]["dropped_filters"] == {"country": ["DE"]}
    async with client_as(VENDOR) as c:
        assert (await c.get("/v1/prompts", params={"surface": "global", "all": "true"})).status_code == 403


@needs_db
async def test_global_all_mode_filters_and_empty(client_as):
    async with client_as(ADMIN) as c:
        async def got(**params):
            r = await c.get("/v1/prompts", params={"surface": "global", "all": "true", **params})
            assert r.status_code == 200, r.text
            return r.json()
        assert set(ids(await got(brand="Kia"))) == {F_COMMON, F_ACR, F_US_ONLY, G(2), G(3), G(4), G(5), G(7), G(8)}
        assert set(ids(await got(country="DE"))) == {G(5)}
        assert set(ids(await got(depth4="D4x"))) == {G(1)}
        assert set(ids(await got(search="SUV"))) == {F_BEST_H, F_BEST_G, F_HY_KO, G(1)}
        assert set(ids(await got(measured="true", kind="acr"))) == {F_ACR}
        empty = await got(search="no-such-text-xyz")
    assert empty["data"]["items"] == [] and empty["meta"]["page"] == {"next_cursor": None, "limit": 25_000, "total": 0}


@needs_db
async def test_global_all_mode_cap_continues_with_cursor(client_as, monkeypatch):
    """상한을 넘으면 조용히 자르지 않고 next_cursor 로 이어 받는다. 전량 모드 커서는 일반 키셋 커서와 같은 필터 해시(all 은 해시 밖)."""
    monkeypatch.setattr(svc, "GLOBAL_ALL_MAX", 5)
    expected = [r["prompt_id"] for r in await S.q(ORDER_SQL, uuid.UUID(S.ROOT))]
    out, cursor, pages = [], None, 0
    async with client_as(ADMIN) as c:
        for _ in range(10):                                                              # 무한 반복 방지 상한
            pages += 1
            r = await c.get("/v1/prompts", params={"surface": "global", "all": "true", **({"cursor": cursor} if cursor else {})})
            b = r.json()
            assert r.status_code == 200 and b["meta"]["page"]["limit"] == 5 and b["meta"]["page"]["total"] == 14
            out += ids(b)
            cursor = b["meta"]["page"]["next_cursor"]
            if not cursor:
                break
        assert out == expected and pages == 3                                           # 5 + 5 + 4
        first = (await c.get("/v1/prompts", params={"surface": "global", "all": "true"})).json()
        plain = await c.get("/v1/prompts", params={"surface": "global", "limit": 4, "cursor": first["meta"]["page"]["next_cursor"]})
    assert plain.status_code == 200 and ids(plain.json()) == expected[5:9]


@needs_db
async def test_all_mode_ignored_on_website_and_invalid_422(client_as):
    async with client_as(ADMIN) as c:
        w = await c.get("/v1/prompts", params={"surface": "website", "all": "true"})
        bad = await c.get("/v1/prompts", params={"surface": "global", "all": "maybe"})
    b = w.json()
    assert w.status_code == 200 and "all" in b["meta"]["ignored_filters"] and b["meta"]["page"]["limit"] == 50
    assert bad.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# BG-35 웹사이트 내보내기 화면 모양(columns=screen, locale)
# ════════════════════════════════════════════════════════════════════════════
KO_HEAD = ["프롬프트", "브랜드", "국가", "언어", "타겟 URL", "측정 횟수", "최근 측정", "측정 엔진"]
EN_HEAD = ["Prompt", "Brand", "Country", "Language", "Target URL", "Measurements", "Last measured", "Engines"]
# 손계산(ko): 국가·언어 표시명 = Intl.DisplayNames('ko') 값, 측정 메타 = 픽스처 회차 21(09-18)
KO_ROWS = {
    "ev9?": ["ev9?", "Kia", "독일", "독일어", "https://www.kia.com/de/modelle/ev9/", "1", "2026-09-18", "chatgpt"],
    "sub?": ["sub?", "Kia", "독일", "독일어", "https://www.kia.com/de/sub/x", "1", "2026-09-18", "gemini"],
    "deals?": ["deals?", "Kia", "독일", "독일어", "https://shop.kia.de/angebote", "0", "측정 없음", ""],
    "us kia a": ["us kia a", "Kia", "미국", "영어", "https://www.kia.com/us/a", "0", "측정 없음", ""],
    "=1+1 us kia 50%_b": ["=1+1 us kia 50%_b", "Kia", "미국", "영어", "https://www.kia.com/us/b_x", "0", "측정 없음", ""],
    "n de": ["n de", "Hyundai N", "독일", "독일어", "https://www.hyundai-n.com/de/", "0", "측정 없음", ""],
    "kr hy": ["kr hy", "Hyundai", "대한민국", "한국어", "https://www.hyundai.com/kr/", "0", "측정 없음", ""],
}


def _xlsx(r) -> tuple[list[list[str]], zipfile.ZipFile]:
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = [(x.cells + [""] * 8)[:8] for x in XlsxReader().read(r.content).rows]
    return rows, z


def _csv(r) -> list[list[str]]:
    assert r.content.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))


def _disposition_name(r) -> str:
    m = re.search(r"filename\*=UTF-8''([^;]+)", r.headers["content-disposition"])
    return unquote(m.group(1)) if m else ""


async def _independent_default_order() -> list[str]:
    """기본 정렬 손계산 = 현행 파일 순서(front website-sites.ts:500-504 'lastMeasuredAt DESC NULLS LAST, wp.id ASC'):
    측정 행(ev9?·sub?, 둘 다 09-18 동점) 먼저, 동점과 미측정 블록은 website_prompt_id ASC(검증 m1: 이전에는 DESC 였다)."""
    return [r["prompt_text"] for r in await S.q(
        "SELECT prompt_text FROM app.website_prompt ORDER BY (prompt_text IN ('ev9?', 'sub?')) DESC, website_prompt_id ASC")]


@needs_db
async def test_screen_xlsx_ko_matches_current_file_shape(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "xlsx", "columns": "screen", "locale": "ko"})
        dflt = await c.get("/v1/prompts", params={"surface": "website", "format": "xlsx", "columns": "screen"})   # locale 생략 = ko
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats") and r.headers["cache-control"] == "no-store"
    day = SX.kst_today()
    assert _disposition_name(r) == f"웹사이트-프롬프트-{day}.xlsx"
    assert f'filename="website-prompts-{day}.xlsx"' in r.headers["content-disposition"]
    rows, z = _xlsx(r)
    assert rows[0] == KO_HEAD
    assert [x[0] for x in rows[1:]] == await _independent_default_order()
    assert {x[0]: x for x in rows[1:]} == KO_ROWS
    wb = z.read("xl/workbook.xml").decode()
    assert 'name="웹사이트 프롬프트"' in wb                                              # 시트 이름 = exportSheetName
    sheet = z.read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in sheet and re.search(r'<c r="F2"[^>]*><v>1</v></c>', sheet)       # 측정 횟수 = 숫자 셀
    assert _xlsx(dflt)[0] == rows


@needs_db
async def test_screen_csv_en_labels_names_and_formula_guard(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen", "locale": "en"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    day = SX.kst_today()
    assert r.headers["content-disposition"] == f'attachment; filename="website-prompts-{day}.csv"'          # ASCII 이름이라 filename* 없음
    rows = _csv(r)
    assert rows[0] == EN_HEAD
    got = {x[0]: x for x in rows[1:]}
    assert got["ev9?"] == ["ev9?", "Kia", "Germany", "German", "https://www.kia.com/de/modelle/ev9/", "1", "2026-09-18", "chatgpt"]
    assert got["kr hy"][2:4] == ["South Korea", "Korean"] and got["kr hy"][6] == "Not measured"
    assert "'=1+1 us kia 50%_b" in got                                                   # CSV 수식 주입 무력화(core.export)


@needs_db
async def test_screen_scope_filters_lens_and_empty(client_as):
    """권한(스코프 밖 누출 0)·필터(행 필터·렌즈)·빈 결과. 값은 api 모양과 같은 조회 결과다."""
    async with client_as(KIA_US) as c:
        us = _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen"}))
        leak = _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen", "country": "DE"}))
    assert {x[0] for x in us[1:]} == {"us kia a", "'=1+1 us kia 50%_b"} and leak == [KO_HEAD]
    async with client_as(KIA_EU) as c:
        eu = _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen"}))
    assert {x[0] for x in eu[1:]} == {"ev9?", "deals?", "sub?"}
    async with client_as(ADMIN) as c:
        async def rows(**params):
            r = await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen", **params})
            assert r.status_code == 200, r.text
            return {x[0]: x for x in _csv(r)[1:]}
        assert set(await rows(lang="ko")) == {"kr hy"}
        assert set(await rows(country="HYUNDAI-N")) == {"n de"}
        g = await rows(engine="gemini")                                                  # 렌즈: 행은 그대로, 측정 메타만 gemini
        assert len(g) == 7 and g["ev9?"][5:] == ["0", "측정 없음", ""] and g["sub?"][5:] == ["1", "2026-09-18", "gemini"]
        old = await rows(**{"from": "2026-09-01", "to": "2026-09-10"})
        assert all(x[5:] == ["0", "측정 없음", ""] for x in old.values())
        assert await rows(search="no-such-text-xyz") == {}


@needs_db
async def test_screen_pseudo_country_label(client_as):
    """의사 국가 코드(SA-Dammam 등)는 Intl 이 모르므로 front pseudo-country.ts 정본 라벨을 쓴다(staged, 롤백)."""
    prep = (Sql("SELECT set_config('app.actor_id', $1, true)", (str(SYSTEM),)),
            Sql("UPDATE app.website_site SET country_code = 'SA-Dammam' WHERE site_id = $1", (S.sid(3),)))
    async with staged(*prep), client_as(ADMIN) as c:
        ko = _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen"}))
        en = _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "screen", "locale": "en"}))
    assert next(x for x in ko if x[0] == "kr hy")[2] == "사우디 아라비아 - 담맘"
    assert next(x for x in en if x[0] == "kr hy")[2] == "Saudi Arabia - Dammam"


@needs_db
async def test_screen_truncation_and_audit(client_as, monkeypatch):
    await get_audit_writer().flush()
    async with get_db().read("admin_long") as conn:
        before = len(await fetch_all(conn, "SELECT audit_id FROM app.access_audit_log WHERE actor_id = :a AND action = 'catalog.prompts.export'",
                                     {"a": ADMIN}))
    monkeypatch.setattr(CQ, "EXPORT_MAX_ROWS", 2)
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "xlsx", "columns": "screen", "locale": "en"})
    assert r.headers.get("x-export-truncated") == "true" and len(_xlsx(r)[0]) == 3
    await get_audit_writer().flush()
    async with get_db().read("admin_long") as conn:
        rows = await fetch_all(conn, "SELECT detail FROM app.access_audit_log WHERE actor_id = :a AND action = 'catalog.prompts.export'"
                                     " ORDER BY audit_id DESC", {"a": ADMIN})
    assert len(rows) == before + 1
    d = rows[0]["detail"] if isinstance(rows[0]["detail"], dict) else json.loads(rows[0]["detail"])
    assert (d["columns"], d["locale"], d["rows"], d["truncated"], d["format"]) == ("screen", "en", 2, True, "xlsx")


@needs_db
async def test_export_tie_order_matches_current_file(client_as):
    """검증 m1 재현: 내보내기 동점(같은 최근 측정일·미측정 NULL 블록)이 website_prompt_id DESC 였다. 현행 파일은 wp.id ASC.
    기본 정렬(desc)·asc·다른 정렬 키(brand)에서 screen·api 파일 순서 = 독립 손계산, json 키셋 목록은 같은 방향 유지(README 다른 점 2)."""
    want = await _independent_default_order()
    asc = [r["prompt_text"] for r in await S.q(                                       # last_measured asc: 측정 행 먼저, NULL 은 여전히 뒤, 동점 id ASC
        "SELECT prompt_text FROM app.website_prompt ORDER BY (prompt_text IN ('ev9?', 'sub?')) DESC, website_prompt_id ASC")]
    brand = [r["prompt_text"] for r in await S.q(
        "SELECT wp.prompt_text FROM app.website_prompt wp JOIN app.website_site ws ON ws.site_id = wp.site_id"
        " ORDER BY ws.brand_code DESC, wp.website_prompt_id ASC")]
    async with client_as(ADMIN) as c:
        async def names(fmt, **params):
            r = await c.get("/v1/prompts", params={"surface": "website", "format": fmt, **params})
            assert r.status_code == 200, r.text
            rows = _csv(r) if fmt == "csv" else _xlsx(r)[0]
            col = 0 if params.get("columns") == "screen" else 1
            return [x[col].removeprefix("'") for x in rows[1:]]
        assert await names("xlsx", columns="screen") == want
        assert await names("csv", columns="screen") == want
        assert await names("csv") == want                                              # api 모양 파일도 같은 순서(내보내기는 키셋이 아니다)
        assert await names("csv", columns="screen", dir="asc") == asc
        assert await names("csv", columns="screen", sort="brand") == brand
        listed = (await c.get("/v1/prompts", params={"surface": "website", "limit": 200})).json()["data"]["items"]
    keyset = [r["prompt_text"] for r in await S.q(                                    # 목록(키셋) 경로는 그대로: 동점도 요청 방향(desc)
        "SELECT prompt_text FROM app.website_prompt ORDER BY (prompt_text IN ('ev9?', 'sub?')) DESC, website_prompt_id DESC")]
    assert [x["prompt_text"] for x in listed] == keyset and keyset != want


@needs_db
async def test_api_columns_export_unchanged(client_as):
    """기본(columns=api) 파일은 그대로: 열 키 머리글·코드 원값·13열·파일 이름 prompts-website."""
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "csv", "columns": "api"})
    assert 'filename="prompts-website.csv"' in r.headers["content-disposition"]
    rows = _csv(r)
    assert len(rows[0]) == 13 and rows[0][:3] == ["website_prompt_id", "prompt_text", "brand_code"]
    assert {x[3] for x in rows[1:]} == {"DE", "US", "KR"}


@pytest.mark.parametrize("params", [
    {"surface": "global", "format": "xlsx", "columns": "screen"},                 # 화면 모양은 website 전용
    {"surface": "website", "columns": "screen"},                                    # json 에는 화면 모양이 없다
    {"surface": "website", "format": "xlsx", "columns": "screen", "locale": "fr"},   # screen 의 locale 은 ko|en
    {"surface": "website", "format": "xlsx", "columns": "screen", "locale": ""},
    {"surface": "website", "format": "xlsx", "columns": "screen", "locale": "KO"},
    {"surface": "website", "format": "xlsx", "columns": "bogus"},
])
@needs_db
async def test_screen_invalid_params_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params=params)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("params", [
    {"surface": "website", "format": "xlsx", "locale": "en"},                        # front 링크 파라미터 그대로 중계(columns 없음)
    {"surface": "website", "format": "csv", "locale": "fr"},                         # front 는 모르는 locale 을 기본값으로 떨어뜨린다
    {"surface": "global", "format": "csv", "locale": "ko"},
])
@needs_db
async def test_locale_without_screen_is_ignored_not_422(client_as, params):
    """검증 m4 재현: 추가 전(8890406)에는 모르는 파라미터라 200 이던 locale 이 columns=screen 없이 422 였다.
    screen 이 아니면 locale 을 쓰지 않고 무시한다: 파일은 locale 없이와 내용이 같다(api 모양).
    xlsx 는 zip 항목마다 작성 시각(2초 단위)이 박혀 두 호출이 2초 경계를 넘으면 바이트가 달라진다(back-ci 2026-10-01 흔들림) →
    zip 은 항목 이름·순서·내용으로 비교한다(시각 무관). csv 는 바이트 그대로."""
    base = {k: v for k, v in params.items() if k != "locale"}
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params=params)
        plain = await c.get("/v1/prompts", params=base)
    assert r.status_code == 200, r.text
    assert _file_payload(r.content) == _file_payload(plain.content)
    assert r.headers["content-disposition"] == plain.headers["content-disposition"]


def _file_payload(content: bytes) -> object:
    """내려받은 파일의 시각 무관 내용: zip(xlsx) = [(항목 이름, 내용)] 순서 그대로, 그 밖 = 바이트."""
    if not content.startswith(b"PK"):
        return content
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        return [(i.filename, z.read(i)) for i in z.infolist()]


def test_file_payload_ignores_zip_entry_time():
    """비교 도우미 자체: 같은 항목을 다른 시각으로 쓴 두 zip 은 바이트는 다르고 비교 값은 같다."""
    def make(ts: tuple[int, ...]) -> bytes:
        bio = io.BytesIO()
        with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(zipfile.ZipInfo("a.xml", date_time=ts), b"<x/>")
        return bio.getvalue()
    a, b = make((2026, 10, 1, 0, 0, 0)), make((2026, 10, 1, 0, 0, 2))
    assert a != b and _file_payload(a) == _file_payload(b)


@needs_db
async def test_locale_on_json_list_reported_ignored(client_as):
    """json 목록의 locale(검증 m4)은 무시하고 meta.ignored_filters 에 드러낸다. 행·커서는 locale 없이와 같다."""
    async with client_as(ADMIN) as c:
        for surface in ("global", "website"):
            r = await c.get("/v1/prompts", params={"surface": surface, "locale": "ko", "limit": 2})
            plain = await c.get("/v1/prompts", params={"surface": surface, "limit": 2})
            assert r.status_code == 200 and "locale" in r.json()["meta"]["ignored_filters"]
            assert r.json()["data"] == plain.json()["data"] and r.json()["meta"]["page"] == plain.json()["meta"]["page"]
            assert "locale" not in plain.json()["meta"]["ignored_filters"]


# ── 표시명 단위(front country-name.ts·language-name.ts 동작) ──
@pytest.mark.parametrize("code,locale,expected", [
    ("DE", "ko", "독일"), ("de", "ko", "독일"), (" us ", "en", "United States"), ("KR", "en", "South Korea"),
    ("SA-Riyadh", "ko", "사우디 아라비아 - 리야드"), ("CN-BJ", "en", "China-Beijing"),
    ("worldwide", "ko", "worldwide"), (None, "ko", ""), ("", "en", ""),
])
def test_country_name(code, locale, expected):
    assert SX.country_name(code, locale) == expected


@pytest.mark.parametrize("code,locale,expected", [
    ("de", "ko", "독일어"), ("EN", "ko", "영어"), ("ko", "en", "Korean"), ("zh-TW", "ko", "중국어(대만)"),
    ("pt-br", "en", "Brazilian Portuguese"), ("de-at", "ko", "독일어(오스트리아)"),         # 표 밖 조합 = Intl 기본 조합 형식
    ("en_us", "ko", "en_us"), (None, "en", ""),
    ("xx-zz", "ko", "xx(알려지지 않은 지역)"),                                          # 모르는 언어 = 코드, 지역은 이름(Intl 과 같게: 검증 m-2)
])
def test_language_name(code, locale, expected):
    assert SX.language_name(code, locale) == expected


# ── 검증 m-2 재현: 표 밖 조합이 Intl 과 달랐던 사례(Node 26.8.1·ICU 78.3 Intl.DisplayNames 결과를 옮긴 기대값) ──
@pytest.mark.parametrize("code,locale,expected", [
    # 방언 이름(이전: '독일어(스위스)' 형)
    ("de-ch", "ko", "고지 독일어(스위스)"), ("nl-be", "ko", "플라망어"), ("fa-af", "ko", "다리어"), ("ro-md", "ko", "몰도바어"),
    ("de-at", "en", "Austrian German"), ("de-ch", "en", "Swiss High German"), ("sr-me", "en", "Montenegrin"),
    # 지역 이름 안 괄호는 대괄호(이전: '(…(…))')
    ("yue-hk", "ko", "광둥어(홍콩[중국 특별행정구])"), ("en-mm", "en", "English (Myanmar [Burma])"), ("pt-mo", "ko", "포르투갈어(마카오[중국 특별행정구])"),
    # 3글자 언어 코드(이전: 코드 그대로)
    ("fil", "ko", "필리핀어"), ("yue", "en", "Cantonese"), ("haw", "ko", "하와이어"), ("ckb-iq", "ko", "소라니 쿠르드어(이라크)"),
    ("ckb-IQ", "en", "Central Kurdish (Iraq)"), ("fil-ph", "en", "Filipino (Philippines)"),
    # 문자 체계 태그(이전: 코드 그대로)
    ("sr-latn", "ko", "세르비아어(로마자)"), ("sr-Cyrl-RS", "en", "Serbian (Cyrillic, Serbia)"), ("zh-hans-cn", "ko", "중국어(간체, 중국)"),
    ("zh-Hans", "en", "Simplified Chinese"), ("zh-hant-hk", "ko", "중국어(번체, 홍콩[중국 특별행정구])"), ("en-qaaa", "en", "English (Qaaa)"),
    # 숫자 지역(M.49, 이전: 코드 그대로)과 지역 별칭
    ("en-419", "ko", "영어(라틴 아메리카)"), ("es-419", "en", "Latin American Spanish"), ("de-150", "ko", "독일어(유럽)"),
    ("en-001", "en", "English (world)"), ("en-840", "en", "American English"), ("en-uk", "en", "British English"),
    # 폐지 지역 SU(언어마다 다른 정규 지역)·언어 별칭
    ("hy-su", "ko", "아르메니아어(아르메니아)"), ("ru-su", "en", "Russian (Russia)"), ("en-su", "ko", "영어(러시아)"),
    ("hy-latn-su", "en", "Armenian (Latin, Armenia)"), ("sh-rs", "ko", "세르비아어(로마자, 세르비아)"), ("iw-il", "en", "Hebrew (Israel)"),
    ("sgn-us", "en", "American Sign Language"), ("sgn-latn-us", "ko", "ase(로마자)"),
    # 모르는 코드(Intl 과 같게 정규화: 언어 소문자·지역 대문자)
    ("XX", "ko", "xx"), ("qq-us", "en", "qq (United States)"), ("en-qq", "ko", "영어(QQ)"), ("und-us", "ko", "root(미국)"),
    # 검증 m2(8223ad4 기준) 재현 사례 추가: en 방언·괄호 모양·세 글자 코드·스크립트 태그
    ("nl-be", "en", "Flemish"), ("fr-ch", "en", "Swiss French"), ("en-hk", "ko", "영어(홍콩[중국 특별행정구])"),
    ("en-cc", "en", "English (Cocos [Keeling] Islands)"), ("en-cc", "ko", "영어(코코스 제도)"), ("zh-mo", "en", "Chinese (Macao SAR China)"),
    ("ceb", "ko", "세부아노어"), ("ceb", "en", "Cebuano"), ("zh-Hans-CN", "en", "Chinese (Simplified, China)"), ("sr-latn", "en", "Serbian (Latin)"),
])
def test_language_name_matches_intl_regressions(code, locale, expected):
    assert SX.language_name(code, locale) == expected


@pytest.mark.parametrize("code,locale,expected", [
    ("419", "ko", "라틴 아메리카"), ("150", "en", "Europe"), ("001", "ko", "세계"),        # 숫자 지역(이전: 코드 그대로)
    ("840", "en", "840"), ("qq", "ko", "QQ"), ("SU", "ko", "러시아"), ("USA", "en", "USA"), ("x:EU", "ko", "x:EU"),
])
def test_country_name_matches_intl_regressions(code, locale, expected):
    assert SX.country_name(code, locale) == expected


_SAMPLE = Path(__file__).with_name("names_intl_sample.json")
# 옮기지 않은 모양(README 다른 점 6): 변이·확장 하위 태그. 이 밖의 불일치는 생성물·규칙 회귀다
_VARIANT_GAP = {"en-us-posix"}


def test_names_match_intl_sample():
    """생성기(names_gen.mjs)가 Node Intl 로 뽑은 표본(언어 약 2,600·국가 약 290 × ko·en)과 전부 같아야 한다."""
    data = json.loads(_SAMPLE.read_text(encoding="utf-8"))
    bad = [(loc, t, want, SX.language_name(t, loc)) for loc, m in data["language"].items() for t, want in m.items()
           if t not in _VARIANT_GAP and SX.language_name(t, loc) != want]
    bad += [(loc, t, want, SX.country_name(t, loc)) for loc, m in data["country"].items() for t, want in m.items()
            if SX.country_name(t, loc) != want]
    assert bad == []
    assert len(data["language"]["ko"]) > 2000 and len(data["country"]["en"]) > 250
    assert all(SX.language_name(t, loc) == t for loc in ("ko", "en") for t in _VARIANT_GAP)   # 알려진 차이: 코드 그대로


def test_names_data_is_reproducible_from_generator():
    """검증 m3 재현: names_data.py 가 '생성물'이라면서 생성기·실행 명령이 없었다. 생성기가 커밋돼 있고, 생성물 머리 주석이
    실행 명령·입력을 적으며, 생성물 머리 주석이 생성기 템플릿에서 나온 것(손으로 고친 머리가 아님)인지 확인한다.
    (생성기 실행 자체는 Node 가 필요해 테스트에서 돌리지 않는다: 로컬 재실행 결과 names_data.py·표본 JSON 이 머리 주석 외 동일)."""
    here = Path(SX.__file__).parent
    gen = (here / "names_gen.mjs").read_text(encoding="utf-8")
    data = (here / "names_data.py").read_text(encoding="utf-8")
    assert "writeFileSync(new URL(\"./names_data.py\"" in gen and "names_intl_sample.json" in gen
    doc = data.split('"""')[1]
    assert "node names_gen.mjs" in doc and "cd back/app/features/catalog/prompts/catalog" in doc and "입력 파일 없음" in doc
    for line in ("재생성(ICU 버전이 바뀌면): cd back/app/features/catalog/prompts/catalog && node names_gen.mjs",
                 "- REGION_NAMES: 지역 코드 AA..ZZ·000..999 중 Intl region 이 이름을 준 코드(대문자 키, 숫자 지역 419·150·001 등 포함)."):
        assert line in doc and line in gen
