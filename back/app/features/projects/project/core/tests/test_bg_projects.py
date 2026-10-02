"""값 갭 보강(bg-projects) 테스트: BG-36 by-scope 해석, BG-37 생성 선택지, BG-38 상세 요약, BG-47 커스텀 필드 생성 순.

준비는 전부 staged(롤백 전용)라 대분류 안 재진입에 안전하다. 기대값은 손계산(준비 행에서 직접 센 값) 또는 raw_fetch 독립 SQL
(드라이버 직접, 구현 SQL 과 다른 형태)로 확인한다.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.features.projects.project.core.tests.helpers import GLOBAL_KIA, ensure_extra_accounts
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_DE_SITE,
    KIA_EU,
    KIA_US,
    SYSTEM,
    VENDOR,
    WEBSITE_KIA,
    Rows,
    Sql,
    Update,
    needs_db,
    raw_fetch,
    staged,
)

pytestmark = needs_db

CUST_SCOPE = "a0000000-0000-4000-8000-000000000003"     # 픽스처 고객 프로젝트(Hyundai US)의 scope_project_id
ROOT_SCOPE = "a0000000-0000-4000-8000-000000000001"     # standard_root
SITE_SCOPE = "a0000000-0000-4000-8000-000000000002"     # 웹사이트 Kia DE 사이트
GENESIS_SA_SITE = uuid.UUID("d0000000-0000-4000-8000-000000000005")   # 가상 지역 SA-Dammam, scope_project_id NULL


def _ts(y: int, m: int = 1, d: int = 1) -> datetime:
    return datetime(y, m, d, tzinfo=UTC)


def _prompt(status: str, updated_at: datetime, *, deleted: bool = False, project_id: uuid.UUID = CUST_PROJECT) -> dict:
    return {"prompt_id": uuid.uuid4(), "project_id": project_id, "text": f"bg38 {status}", "status": status, "created_by": SYSTEM,
            "updated_at": updated_at, "deleted_at": _ts(2026) if deleted else None}


# ════════════════════════════════════════════════════════════════════════════
# BG-38 상세 요약
# ════════════════════════════════════════════════════════════════════════════
async def test_detail_summary_values(client_as):
    """상태별 수(삭제 제외)·후보 수·활성 멤버 수·최근 실행 시각(running·done 만)·지정 비교 브랜드."""
    prompts = [_prompt("draft", _ts(2027)), _prompt("draft", _ts(2027)), _prompt("queued", _ts(2027)),
               _prompt("running", _ts(2029, 6)), _prompt("done", _ts(2030, 3, 4)), _prompt("paused", _ts(2027)),
               _prompt("failed", _ts(2031)),                        # failed 는 최근 실행 시각에서 뺀다(현행 lastAi)
               _prompt("running", _ts(2032), deleted=True),         # 삭제 행은 개수·시각 모두 제외
               _prompt("done", _ts(2033), deleted=True)]
    cands = [{"candidate_id": uuid.uuid4(), "project_id": CUST_PROJECT, "source": "manual", "text": f"c{i}"} for i in range(3)]
    members = [{"project_id": CUST_PROJECT, "user_id": KIA_US, "role": "viewer", "status": "active", "invited_by": ADMIN,
                "accepted_at": _ts(2026)},
               {"project_id": CUST_PROJECT, "user_id": HQ_HYUNDAI, "role": "viewer", "status": "pending", "invited_by": ADMIN,
                "accepted_at": None}]
    comps = [{"project_id": CUST_PROJECT, "brand_name": "Toyota", "is_target": True},
             {"project_id": CUST_PROJECT, "brand_name": "Honda", "is_target": False}]
    async with staged(Rows("app.prompt", prompts), Rows("app.prompt_candidate", cands), Rows("app.project_member", members),
                      Rows("app.project_tracked_competitor", comps), actor=SYSTEM) as conn, client_as(VENDOR) as c:
        r = await c.get(f"/v1/projects/{CUST_PROJECT}")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        # 독립 기대값: 상태마다 따로 센다(구현은 FILTER 한 번 스캔)
        exp_counts = {}
        for s in ("draft", "queued", "running", "done", "failed", "paused"):
            [row] = await raw_fetch(conn, "SELECT count(*) AS n FROM app.prompt WHERE project_id = $1 AND status = $2 "
                                          "AND deleted_at IS NULL", CUST_PROJECT, s)
            exp_counts[s] = row["n"]
        [m] = await raw_fetch(conn, "SELECT count(*) AS n FROM app.project_member WHERE project_id = $1 AND status = 'active'",
                              CUST_PROJECT)
        [cc] = await raw_fetch(conn, "SELECT count(*) AS n FROM app.prompt_candidate WHERE project_id = $1", CUST_PROJECT)
    assert d["prompt_counts"] == exp_counts
    # 손계산: 픽스처 고객 프롬프트 done 1건(cust q) + 준비 행(삭제 2건 제외)
    assert exp_counts == {"draft": 2, "queued": 1, "running": 1, "done": 2, "failed": 1, "paused": 1}
    assert d["candidate_count"] == cc["n"] == 3
    assert d["active_member_count"] == m["n"] == 2                  # VENDOR(픽스처) + KIA_US, pending 제외
    assert d["last_run_at"] == "2030-03-04T00:00:00Z"               # 삭제된 2033 done·failed 2031 은 무시
    assert d["target_brand"] == "Toyota"
    # 기존 필드·의미는 그대로
    assert d["project_id"] == str(CUST_PROJECT) and d["my_role"] == "viewer" and d["scope_linked"] is True


async def test_detail_summary_empty_project(client_as):
    """프롬프트·후보·멤버·비교 브랜드가 없는 프로젝트: 0·null(빈 결과)."""
    pid = uuid.uuid4()
    proj = {"project_id": pid, "kind": "customer", "name": "bg38-empty", "country_code": "US", "created_by": SYSTEM}
    async with staged(Rows("app.project", [proj]), actor=SYSTEM), client_as(ADMIN) as c:
        r = await c.get(f"/v1/projects/{pid}")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["prompt_counts"] == {"draft": 0, "queued": 0, "running": 0, "done": 0, "failed": 0, "paused": 0}
    assert d["candidate_count"] == 0 and d["active_member_count"] == 0
    assert d["last_run_at"] is None and d["target_brand"] is None and d["my_role"] is None
    assert d["recent_prompts"] == []


async def test_detail_summary_not_leaked_to_non_members(client_as):
    """스코프 안 비멤버(HQ_HYUNDAI)·스코프 밖(KIA_US)·루트: 404 로 요약도 나가지 않는다. 형식 오류 422."""
    async with staged(Rows("app.project_tracked_competitor", [{"project_id": CUST_PROJECT, "brand_name": "Secret", "is_target": True}]),
                      actor=SYSTEM):
        for uid in (HQ_HYUNDAI, KIA_US):
            async with client_as(uid) as c:
                r = await c.get(f"/v1/projects/{CUST_PROJECT}")
            assert r.status_code == 404 and "Secret" not in r.text
        async with client_as(ADMIN) as c:
            assert (await c.get("/v1/projects/c0000000-0000-4000-8000-000000000001")).status_code == 404
            assert (await c.get("/v1/projects/not-a-uuid")).status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# BG-36 by-scope 해석
# ════════════════════════════════════════════════════════════════════════════
async def _by_scope(client_as, uid, spid: str):
    async with client_as(uid) as c:
        return await c.get(f"/v1/projects/by-scope/{spid}")


async def test_by_scope_project(client_as):
    """고객 프로젝트: 활성 멤버·admin 은 project_id, 비멤버(스코프 안 포함)·루트는 404."""
    async with staged():
        for uid in (VENDOR, ADMIN):
            r = await _by_scope(client_as, uid, CUST_SCOPE)
            assert r.status_code == 200, r.text
            assert r.json()["data"] == {"kind": "project", "project_id": str(CUST_PROJECT), "brand_code": None, "country_code": None}
        for uid in (HQ_HYUNDAI, KIA_US, KIA_EU, WEBSITE_KIA):
            r = await _by_scope(client_as, uid, CUST_SCOPE)
            assert r.status_code == 404 and str(CUST_PROJECT) not in r.text
        assert (await _by_scope(client_as, ADMIN, ROOT_SCOPE)).status_code == 404


async def test_by_scope_website_site_scope(client_as):
    """웹사이트 사이트(Kia DE): 표면 게이트 + 브랜드·국가 스코프 안일 때만 brand·country. 밖이면 404."""
    async with staged():
        ok = {"kind": "website", "project_id": None, "brand_code": "Kia", "country_code": "DE"}
        for uid in (ADMIN, KIA_EU, WEBSITE_KIA):          # admin · Kia 서유럽 권역(DE 포함) · website 역할 Kia
            r = await _by_scope(client_as, uid, SITE_SCOPE)
            assert r.status_code == 200, (uid, r.text)
            assert r.json()["data"] == ok
        for uid in (KIA_US,          # Kia 지만 국가 US 만
                    HQ_HYUNDAI,      # 메뉴 standard·project(website 없음) + 브랜드 Hyundai
                    VENDOR):         # vendor 는 website 표면 역할 밖
            r = await _by_scope(client_as, uid, SITE_SCOPE)
            assert r.status_code == 404, (uid, r.text)
            assert "DE" not in r.json()["error"]["message"]


async def test_by_scope_virtual_site_keeps_code_and_brand_scope(client_as):
    """가상 지역 사이트(Genesis SA-Dammam): 코드 원래 표기 그대로. Genesis 스코프가 없는 계정은 404."""
    spid = uuid.uuid4()
    async with staged(Update("app.website_site", {"site_id": GENESIS_SA_SITE}, {"scope_project_id": spid}), actor=SYSTEM):
        r = await _by_scope(client_as, ADMIN, str(spid))
        assert r.status_code == 200 and r.json()["data"] == {"kind": "website", "project_id": None, "brand_code": "Genesis",
                                                             "country_code": "SA-Dammam"}
        assert (await _by_scope(client_as, WEBSITE_KIA, str(spid))).status_code == 404


async def test_by_scope_project_wins_without_fallthrough(client_as):
    """같은 Scope id 가 프로젝트와 사이트 양쪽에 있으면 프로젝트가 이긴다(현행 순서). 프로젝트를 못 보는 계정은
    사이트가 보여도 404(사이트로 새지 않는다)."""
    async with staged(Update("app.website_site", {"site_id": KIA_DE_SITE}, {"scope_project_id": uuid.UUID(CUST_SCOPE)}),
                      actor=SYSTEM):
        r = await _by_scope(client_as, ADMIN, CUST_SCOPE)
        assert r.status_code == 200 and r.json()["data"]["kind"] == "project"
        assert (await _by_scope(client_as, KIA_EU, CUST_SCOPE)).status_code == 404


async def test_by_scope_unknown_invalid_unauth_and_ignored_filters(client_as):
    async with staged():
        r = await _by_scope(client_as, ADMIN, str(uuid.uuid4()))
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
        r = await _by_scope(client_as, ADMIN, "not-a-uuid")
        assert r.status_code == 422
        assert (await _by_scope(client_as, None, CUST_SCOPE)).status_code == 401
        # 공통 필터 축은 받지 않는다: 결과 불변 + meta.ignored_filters 로 드러낸다
        async with client_as(ADMIN) as c:
            r = await c.get(f"/v1/projects/by-scope/{SITE_SCOPE}", params={"brand": "Hyundai", "country": "US"})
        assert r.status_code == 200 and r.json()["data"]["brand_code"] == "Kia"
        assert set(r.json()["meta"]["ignored_filters"]) == {"brand", "country"}


# ════════════════════════════════════════════════════════════════════════════
# BG-37 생성 선택지
# ════════════════════════════════════════════════════════════════════════════
async def _engines(conn) -> list[str]:
    return [r["code"] for r in await raw_fetch(conn, "SELECT code FROM rd.dim_engine WHERE code <> '' ORDER BY engine_key")]


async def test_creation_options_admin(client_as):
    async with staged() as conn, client_as(ADMIN) as c:
        r = await c.get("/v1/projects/creation-options")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        # 순서 = app.brand.sort_order(검증 D2). 독립 SQL 은 EXISTS 반조인 + sort_order 정렬(구현은 Refs 파이썬 필터)
        exp_brands = [x["b"] for x in await raw_fetch(conn, "SELECT b.brand_code AS b FROM app.brand b WHERE EXISTS "
                                                            "(SELECT 1 FROM app.rhq_region r WHERE r.brand_code = b.brand_code) "
                                                            "ORDER BY b.sort_order, b.brand_code")]
        exp_countries = [x["c"] for x in await raw_fetch(conn, "SELECT DISTINCT country_code AS c FROM app.rhq_region_country "
                                                               "ORDER BY 1")]
        exp_engines = await _engines(conn)
    assert d["brands"] == exp_brands and d["brands"]
    assert d["countries"] == exp_countries and d["countries"]
    assert d["engines"] == exp_engines and set(d["engines"]) >= {"chatgpt", "gemini", "deepseek"}
    assert d["default_engines"] == ["chatgpt", "gemini"]              # 픽스처 rule_param default_engines
    assert d["brand_locked"] is False


async def test_creation_options_brand_scoped_operator(client_as):
    """global 운영자 Kia: 브랜드 Kia 하나(잠금), 국가 = Kia 권역 국가 전부. 국가 스코프를 주면 교집합."""
    await ensure_extra_accounts()
    async with staged() as conn, client_as(GLOBAL_KIA) as c:
        d = (await c.get("/v1/projects/creation-options")).json()["data"]
        exp = [x["c"] for x in await raw_fetch(conn, "SELECT DISTINCT rc.country_code AS c FROM app.rhq_region r "
                                                     "JOIN app.rhq_region_country rc USING (region_id) WHERE r.brand_code = 'Kia' ORDER BY 1")]
    assert d["brands"] == ["Kia"] and d["brand_locked"] is True
    assert d["countries"] == exp and "DE" in exp
    async with staged(Update("app.user_account", {"user_id": GLOBAL_KIA}, {"scope_countries": ["DE", "AF"]}), actor=SYSTEM), \
            client_as(GLOBAL_KIA) as c:
        d2 = (await c.get("/v1/projects/creation-options")).json()["data"]
    assert d2["countries"] == ["DE"]                                  # AF 는 Kia 권역 밖이라 빠진다


async def test_creation_options_default_engines_within_vocab(client_as):
    """기본 엔진 규칙 값에 어휘 밖 코드가 있으면 빼고 준다(폼 기본값이 POST 에서 422 가 되지 않게)."""
    async with staged(Sql("UPDATE app.rule_param SET value = $1::jsonb WHERE key = 'default_engines'", ('["gemini", "bogus"]',)),
                      actor=SYSTEM), \
            client_as(ADMIN) as c:
        d = (await c.get("/v1/projects/creation-options")).json()["data"]
    assert d["default_engines"] == ["gemini"]


async def test_creation_options_gate_and_ignored_filters(client_as):
    async with staged():
        for uid in (HQ_HYUNDAI, KIA_US, VENDOR, WEBSITE_KIA):        # operator ≠ global, admin 아님
            async with client_as(uid) as c:
                r = await c.get("/v1/projects/creation-options")
            assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden", (uid, r.text)
        async with client_as(None) as c:
            assert (await c.get("/v1/projects/creation-options")).status_code == 401
        async with client_as(ADMIN) as c:
            r = await c.get("/v1/projects/creation-options", params={"engine": "chatgpt", "brand": "Kia"})
        assert r.status_code == 200 and set(r.json()["meta"]["ignored_filters"]) == {"brand", "engine"}
        assert len(r.json()["data"]["brands"]) > 1                    # 필터로 좁히지 않는다


# ════════════════════════════════════════════════════════════════════════════
# BG-47 커스텀 필드 순서(filters/options surface=project)
# ════════════════════════════════════════════════════════════════════════════
async def test_options_custom_fields_creation_order(client_as):
    """label 순(alpha, mid, zeta)이 아니라 생성 순(zeta, alpha, mid). 같은 생성 시각은 field_id 순. 보관 필드 제외는 그대로."""
    f_zeta, f_alpha, f_mid, f_arch = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    tie_a, tie_b = sorted([uuid.uuid4(), uuid.uuid4()], key=str)
    base = {"project_id": CUST_PROJECT, "created_by": SYSTEM, "archived": False}
    fields = [{**base, "field_id": f_mid, "label": "mid", "created_at": _ts(2026, 3)},
              {**base, "field_id": f_alpha, "label": "alpha", "created_at": _ts(2026, 2)},
              {**base, "field_id": f_zeta, "label": "zeta", "created_at": _ts(2026, 1)},
              {**base, "field_id": f_arch, "label": "archived", "created_at": _ts(2025, 1), "archived": True},
              {**base, "field_id": tie_b, "label": "tie-b", "created_at": _ts(2026, 4)},
              {**base, "field_id": tie_a, "label": "tie-z", "created_at": _ts(2026, 4)}]
    async with staged(Rows("app.project_custom_field", fields), actor=SYSTEM), client_as(VENDOR) as c:
        r = await c.get("/v1/filters/options", params={"surface": "project", "project_id": str(CUST_PROJECT)})
    assert r.status_code == 200, r.text
    got = [(f["field_id"], f["label"]) for f in r.json()["data"]["custom_fields"]]
    assert got == [(str(f_zeta), "zeta"), (str(f_alpha), "alpha"), (str(f_mid), "mid"), (str(tie_a), "tie-z"), (str(tie_b), "tie-b")]


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(D1~D4)
# ════════════════════════════════════════════════════════════════════════════
async def test_by_scope_404_bodies_identical(client_as):
    """D1 재현: 비멤버가 본 고객 프로젝트 id('프로젝트 없음')와 미지 id('대상 없음')의 404 본문이 달라 존재가 드러났다.
    미지 id·standard_root·비멤버 프로젝트·스코프 밖 사이트의 404 본문이 전부 같아야 한다."""
    async with staged():
        unknown = await _by_scope(client_as, KIA_US, str(uuid.uuid4()))
        hidden_project = await _by_scope(client_as, KIA_US, CUST_SCOPE)           # 스코프 밖 비멤버
        hidden_in_scope = await _by_scope(client_as, HQ_HYUNDAI, CUST_SCOPE)      # 스코프 안 비멤버
        root = await _by_scope(client_as, KIA_US, ROOT_SCOPE)                      # standard_root
        root_admin = await _by_scope(client_as, ADMIN, ROOT_SCOPE)
        hidden_site = await _by_scope(client_as, KIA_US, SITE_SCOPE)               # 스코프 밖 사이트
    base = unknown.json()
    assert unknown.status_code == 404 and base == {"error": {"code": "not_found", "message": "대상 없음", "details": None}}, base
    for r in (hidden_project, hidden_in_scope, root, root_admin, hidden_site):
        assert r.status_code == 404 and r.json() == base, r.text


async def test_creation_options_brand_order_sort_order_and_scope_order(client_as):
    """D2 재현: 전체 스코프 brands 가 이름순(Genesis·Hyundai·Kia)이었다. 전체면 app.brand.sort_order 순, 브랜드 스코프가 있으면
    계정 저장 순(현행 scope.brands 그대로)."""
    await ensure_extra_accounts()
    async with staged() as conn, client_as(ADMIN) as c:
        d = (await c.get("/v1/projects/creation-options")).json()["data"]
        ords = {x["b"]: x["o"] for x in await raw_fetch(conn, "SELECT brand_code AS b, sort_order AS o FROM app.brand")}
    assert d["brands"] == sorted(d["brands"], key=lambda b: ords[b])
    assert d["brands"] == ["Hyundai", "Kia", "Genesis"]                           # 손계산: 픽스처 sort_order 1·2·3
    assert d["brands"] != sorted(d["brands"])                                       # 이름순(옛 동작)이 아님을 고정
    async with staged(Update("app.user_account", {"user_id": GLOBAL_KIA}, {"scope_brands": ["Kia", "Genesis", "Hyundai"]}),
                      actor=SYSTEM), client_as(GLOBAL_KIA) as c:
        d2 = (await c.get("/v1/projects/creation-options")).json()["data"]
    assert d2["brands"] == ["Kia", "Genesis", "Hyundai"] and d2["brand_locked"] is False


async def test_creation_options_country_order_keeps_scope_order(client_as):
    """D3 재현: 계정 국가 스코프가 있어도 코드순으로 다시 정렬했다. 현행은 scope.countries 저장 순을 그대로 거른다
    (scope-policy.ts:314). 권역 밖 국가는 빠지고 순서는 유지, 중복은 첫 등장 하나."""
    await ensure_extra_accounts()
    async with staged(Update("app.user_account", {"user_id": GLOBAL_KIA}, {"scope_countries": ["US", "DE", "AF", "CA", "DE"]}),
                      actor=SYSTEM), client_as(GLOBAL_KIA) as c:
        d = (await c.get("/v1/projects/creation-options")).json()["data"]
    assert d["countries"] == ["US", "DE", "CA"]                                     # AF 는 Kia 권역 밖, 코드순이면 CA·DE·US


async def test_detail_recent_prompts_top5_by_updated_at(client_as):
    """D4 재현: 대시보드 '최근 프롬프트 5'(updatedAt 내림차순)를 목록 API(created_at 순)로는 전량 순회해야 했다.
    상세 recent_prompts = 삭제 제외 updated_at 내림차순 상위 5, 동률은 prompt_id 내림차순. 생성 순과 수정 순을 엇갈리게 준비한다."""
    rows = []
    for i, (upd, deleted) in enumerate([(_ts(2040, 1), False), (_ts(2045, 1), True), (_ts(2041, 1), False), (_ts(2039, 1), False),
                                        (_ts(2042, 1), False), (_ts(2043, 1), False), (_ts(2043, 1), False), (_ts(2038, 1), False)]):
        r = _prompt("draft" if i % 2 else "done", upd, deleted=deleted)
        r["text"] = f"bg38-recent-{i}"
        r["created_at"] = _ts(2030 - i)                   # 생성 순은 수정 순과 반대로(목록 API 첫 페이지로는 못 맞춘다)
        rows.append(r)
    noise = _prompt("running", _ts(2050), project_id=uuid.uuid4())
    async with staged(Rows("app.project", [{"project_id": noise["project_id"], "kind": "customer", "name": "bg38-noise",
                                            "country_code": "US", "created_by": SYSTEM}]),
                      Rows("app.prompt", rows), Rows("app.prompt", [noise]), actor=SYSTEM) as conn, client_as(VENDOR) as c:
        r = await c.get(f"/v1/projects/{CUST_PROJECT}")
        assert r.status_code == 200, r.text
        got = r.json()["data"]["recent_prompts"]
        # 독립 기대값: 전 행을 파이썬으로 정렬(구현은 SQL ORDER BY LIMIT)
        allp = await raw_fetch(conn, "SELECT prompt_id, text, status, updated_at FROM app.prompt WHERE project_id = $1 "
                                     "AND deleted_at IS NULL", CUST_PROJECT)
    exp = sorted(allp, key=lambda x: (x["updated_at"], str(x["prompt_id"])), reverse=True)[:5]
    assert [g["prompt_id"] for g in got] == [str(x["prompt_id"]) for x in exp]
    assert [g["text"] for g in got][:1] in (["bg38-recent-5"], ["bg38-recent-6"])   # 손계산: 삭제된 2045 제외, 2043 동률 둘이 먼저
    assert {g["text"] for g in got} == {f"bg38-recent-{i}" for i in (5, 6, 4, 2, 0)}
    assert all(set(g) == {"prompt_id", "text", "status", "updated_at"} for g in got)
    tie = sorted([x for x in rows if x["updated_at"] == _ts(2043, 1)], key=lambda x: str(x["prompt_id"]), reverse=True)
    assert [g["prompt_id"] for g in got[:2]] == [str(x["prompt_id"]) for x in tie]


async def test_by_scope_site_gate_equals_website_surface_gate(client_as):
    """D3 재현·결정 고정: 현행 by-scope/[scopeId]/page.tsx:27-35 는 스코프 검사 없이 /website?geography=&brand= 로 보냈다.
    새 API 는 스코프 밖 사이트를 404 로 막는다(DECISIONS-API 'bg-projects 라운드 결정' B-1, 부록 E by-scope 행 known_diff).
    결정의 근거는 '웹사이트 화면이 그 사이트를 보여 줄 수 있는가' 와 같은 판정이라는 것: 계정마다 by-scope 200 여부가
    웹사이트 표면의 그 사이트 조회(GET /v1/kpi/summary?surface=website&project_id=사이트) 200 여부와 같아야 한다."""
    async with staged():
        seen = {}
        for uid in (ADMIN, KIA_EU, WEBSITE_KIA, KIA_US, HQ_HYUNDAI, VENDOR):
            bs = await _by_scope(client_as, uid, SITE_SCOPE)
            async with client_as(uid) as c:
                ws = await c.get("/v1/kpi/summary", params={"surface": "website", "project_id": str(KIA_DE_SITE)})
            assert bs.status_code in (200, 404), (uid, bs.text)
            assert (bs.status_code == 200) == (ws.status_code == 200), (uid, bs.status_code, ws.status_code, ws.text)
            seen[uid] = bs.status_code
    assert seen[KIA_US] == 404                     # 결함 재현 계정: website 표면 허용 Kia·US 는 Kia DE 사이트로 안 간다
    assert seen[KIA_EU] == 200 and seen[ADMIN] == 200
