"""BG-42 인용 출처 후보의 shadows_owned(오버라이드가 당사 공식 도메인을 덮는지) 통합 테스트(로컬 개발 DB, 롤백 전용 준비).

손 계산(tests/fixtures/fixture-00-rules.sql·fixture-10-data.sql 적재 결과 rd.dim_source):
  당사 공식 도메인(owned_brand_bit ≠ 0) = hyundai.com(1)·hyundaiusa.com(1)·kia.com(2). kia.de 는 규칙 분류(rule)라 비트 0,
  example.org 는 기존 오버라이드(newsMedia)지만 당사 도메인이 아니다. linkedin.com 은 소셜 계정 키라 비트 0.
준비: hyundai.com → newsMedia(5), kia.de → automotiveMedia(4) 오버라이드를 추가(롤백).
기대: shadows_owned 참 = {hyundai.com} 하나. 오버라이드가 없는 당사 도메인(hyundaiusa.com·kia.com)은 거짓(현행 overrideShadowsOwned 는
오버라이드가 있어야 참), example.org·kia.de 는 오버라이드가 있어도 당사 도메인이 아니라 거짓.
"""
from __future__ import annotations

import pathlib
import re

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, Rows, needs_db, raw_fetch, staged

pytestmark = needs_db

BASE = "/v1/admin/citation-overrides/candidates"
EXTRA = Rows("app.citation_domain_override", [
    {"domain": "hyundai.com", "category_key": 5, "note": "bg42 owned shadow"},
    {"domain": "kia.de", "category_key": 4, "note": "bg42 not owned"},
])

# 독립 기대값: 오버라이드 도메인 중 비소셜 출처 행의 도메인이 당사 비트를 가진 것(구현은 skey 유일 조회, 여기는 domain·is_social 로 센다)
EXPECT_SQL = """
SELECT o.domain FROM app.citation_domain_override o
 WHERE o.domain IN (SELECT d.domain FROM rd.dim_source d WHERE NOT d.is_social AND d.owned_brand_bit > 0)
 ORDER BY 1
"""


def _shadows(items: list[dict]) -> dict[str, bool]:
    return {i["domain"]: i["shadows_owned"] for i in items}


async def test_shadows_owned_values(client_as):
    async with staged(EXTRA) as conn, client_as(ADMIN) as c:
        r = await c.get(BASE, params={"surface": "global"})
        assert r.status_code == 200, r.text
        got = _shadows(r.json()["data"]["items"])
        expect = {x["domain"] for x in await raw_fetch(conn, EXPECT_SQL)}
        assert expect == {"hyundai.com"}                                          # 손 계산과 독립 SQL 이 같다
        assert {d for d, v in got.items() if v} == expect
        assert got["hyundaiusa.com"] is False and got["kia.com"] is False           # 오버라이드 없는 당사 도메인
        assert got["example.org"] is False and got["kia.de"] is False               # 오버라이드 있으나 당사 도메인 아님
        by = {i["domain"]: i for i in r.json()["data"]["items"]}
        # 아직 적재기 미반영: 분류·출처는 dim_source 값(owned), 오버라이드 정보는 따로
        assert by["hyundai.com"]["source"] == "owned" and by["hyundai.com"]["override"]["category"]["key"] == 5
        assert by["hyundai.com"]["override"]["propagated"] is False


async def test_shadows_owned_without_override_is_false(client_as):
    """준비 없이(오버라이드 = example.org 하나): 참인 행이 없다."""
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"surface": "global"})
    assert r.status_code == 200
    assert not any(i["shadows_owned"] for i in r.json()["data"]["items"])


async def test_shadows_owned_filter_and_empty_window(client_as):
    async with staged(EXTRA), client_as(ADMIN) as c:
        # 필터(source[] = 카테고리 slug): officialHmg 로 좁혀도 값은 같고, 오버라이드 도메인은 좁히기 밖이면 빠진다(분류 = dim_source 값)
        r = await c.get(BASE, params={"surface": "global", "source": "officialHmg"})
        got = _shadows(r.json()["data"]["items"])
        # kia.de 는 회차 11 인용이 없어 분류 = 오버라이드 값(automotiveMedia)이라 빠진다
        assert got["hyundai.com"] is True and "kia.de" not in got and "example.org" not in got
        r = await c.get(BASE, params={"surface": "global", "source": "newsMedia"})
        assert _shadows(r.json()["data"]["items"]) == {"example.org": False}
        # 빈 창(회차 없는 기간): 사실 표를 읽지 않고 오버라이드 도메인만. 당사 판정은 창과 무관한 출처 차원이라 그대로
        r = await c.get(BASE, params={"surface": "global", "from": "2025-01-01", "to": "2025-01-31"})
        b = r.json()
        assert r.status_code == 200 and b["meta"]["source"]["pool"] == "api_ro"
        assert [(i["domain"], i["citations"], i["shadows_owned"]) for i in b["data"]["items"]] == [
            ("example.org", 0, False), ("hyundai.com", 0, True), ("kia.de", 0, False)]
        # 웹사이트 표면(인용 숨김 회차): 역시 오버라이드 행만, 값 동일
        r = await c.get(BASE, params={"surface": "website"})
        assert _shadows(r.json()["data"]["items"]) == {"example.org": False, "hyundai.com": True, "kia.de": False}


async def test_shadows_owned_scope_and_invalid(client_as):
    async with staged(EXTRA):
        for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
            async with client_as(uid) as c:
                r = await c.get(BASE, params={"surface": "global"})
            assert r.status_code == 403 and "shadows_owned" not in r.text and "hyundai.com" not in r.text
        async with client_as(None) as c:
            assert (await c.get(BASE, params={"surface": "global"})).status_code == 401
        async with client_as(ADMIN) as c:
            for params in ({"surface": "global", "limit": 0}, {"surface": "global", "limit": "x"}, {"surface": "nope"}):
                assert (await c.get(BASE, params=params)).status_code == 422, params


# ── D1 회귀(검증 e172d92): 적재 이력 없는 당사 도메인·당사 서브도메인 오버라이드도 참이어야 한다 ──
# 독립 기대값 = 현행 ownedBrandOf(owned.ts:108) 를 파이썬으로 옮긴 것. 당사 등록 도메인 목록은 이관 규칙 원천
# migration/seed/seed-3x-rules.sql 의 _r_owned_domain(GEO_OWNED_DOMAINS, EXCLUDED 반영 후 42개)을 직접 읽는다(구현은 app.owned_base·dim_source).
_RULES = pathlib.Path(__file__).resolve().parents[6] / "migration" / "seed" / "seed-3x-rules.sql"


def _owned_domains() -> list[str]:
    body = _RULES.read_text(encoding="utf-8").split("INSERT INTO _r_owned_domain VALUES", 1)[1].split(";", 1)[0]
    return [m.group(1) for m in re.finditer(r"\(\d+, '([^']+)', '[^']+'\)", body)]


def _owned_brand_of(domain: str, owned: list[str]) -> bool:
    d = re.sub(r"^www\.", "", domain.lower())
    return any(d == o or d.endswith("." + o) for o in owned)


D1_DOMAINS = {
    "genesis.com": True,          # 당사 등록 도메인, 픽스처에 인용 적재 이력 없음(rd.dim_source 행 없음)
    "news.hyundai.com": True,     # 당사 hyundai.com 의 서브도메인(skey 는 등록 도메인만이라 정확 일치로는 못 찾음)
    "shop.genesis.com": True,     # 적재 이력 없는 당사 도메인의 서브도메인
    "worldwide.kia.com": True,    # owned_base 의 별도 host 이자 kia.com 서브도메인
    "hyundaiusa.com": True,       # 적재된 당사 도메인(정확 일치, 기존 경로)
    "notkia.com": False,          # 문자열 끝만 같음('.kia.com' 아님)
    "kia.com.evil.io": False,     # 당사 도메인을 접두로 가진 타 도메인
    "kia.by": False,              # 카탈로그에 있으나 EXCLUDED_OWNED_DOMAINS(owned.ts:42)
    "caranddriver.com": False,    # 적재된 비당사 도메인
}
D1_EXTRA = Rows("app.citation_domain_override",
                [{"domain": d, "category_key": 5, "note": "d1 regression"} for d in D1_DOMAINS])


async def test_d1_shadows_owned_unloaded_and_subdomain(client_as):
    owned = _owned_domains()
    assert len(owned) == 42 and "genesis.com" in owned and "kia.by" not in owned     # 규칙 원천 파싱 확인
    expect = {d: _owned_brand_of(d, owned) for d in D1_DOMAINS}
    assert expect == D1_DOMAINS                                                      # 손 기대값 = 현행 규칙 재현
    async with staged(D1_EXTRA) as conn, client_as(ADMIN) as c:
        # 전제: genesis.com 계열은 적재 이력이 없다(수정 전 구현은 이 행들을 거짓으로 냈다)
        loaded = {x["skey"] for x in await raw_fetch(conn, "SELECT skey FROM rd.dim_source WHERE skey LIKE '%genesis.com'")}
        assert loaded == set()
        for surface in ("global", "website"):
            r = await c.get(BASE, params={"surface": surface})
            assert r.status_code == 200, r.text
            got = _shadows(r.json()["data"]["items"])
            assert {d: got[d] for d in D1_DOMAINS} == expect, surface
        # 빈 창(사실 표 미사용)에서도 같은 판정
        r = await c.get(BASE, params={"surface": "global", "from": "2025-01-01", "to": "2025-01-31"})
        got = _shadows(r.json()["data"]["items"])
        assert {d: got[d] for d in D1_DOMAINS} == expect


async def test_d1_shadows_owned_dim_source_supplement(client_as):
    """보강 경로 ②: owned_base 에 없는 도메인이라도 적재기가 당사 비트를 준 출처 키면 그 서브도메인 오버라이드도 참.
    소셜 계정 키(is_social)는 당사 비트가 있어도 판정에 끼지 않는다."""
    extra_src = Rows("rd.dim_source", [
        {"skey": "d1-owned.example", "domain": "d1-owned.example", "is_social": False, "category_key": 1, "category_src": 3,
         "owned_brand_bit": 1, "rule_ver": 1},
        {"skey": "d1-social.example/hmg", "domain": "d1-social.example", "is_social": True, "category_key": 1, "category_src": 3,
         "owned_brand_bit": 1, "rule_ver": 1},
    ])
    ov = Rows("app.citation_domain_override", [
        {"domain": "x.d1-owned.example", "category_key": 5, "note": "d1 supplement"},
        {"domain": "d1-social.example", "category_key": 5, "note": "d1 social"},
    ])
    async with staged(extra_src, ov), client_as(ADMIN) as c:
        r = await c.get(BASE, params={"surface": "global"})
        assert r.status_code == 200, r.text
        got = _shadows(r.json()["data"]["items"])
        assert got["x.d1-owned.example"] is True and got["d1-social.example"] is False
