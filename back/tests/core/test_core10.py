"""core 10라운드(제품 책임자 전환 결정 2026-09-30) 회귀: DB-v2.12 P69·P70 과 계정 스코프 판정.

결정 4(중동 country 계정 bd942069 권역 단위 유지): country 역할이 권역만 가져도 된다(P69). 데이터 범위 = 권역 전개(국가 7개로 펼친 것과 같다),
  비멤버 프로젝트 가시성 = 현행 front projectInScope(scope-policy.ts:99-121, main 2670a16 과 7639b9e 동일): 계정 국가가 비면 국가 조건이 없어
  브랜드 공통(brand NULL) 프로젝트는 권역 밖도 보인다. 국가로 펼치면 그 프로젝트가 빠진다(이관 R2 가 만든 차이, stg 9개).
결정 3(계정 국가 표기 정본): 트리거가 대소문자 무시 일치를 rd.dim_country 코드 표기 우선으로 맞춘다(P70, 종전 P59 = rhq 먼저).
결정 7(KPI 택소노미 관점 한정, kpi R2): 글로벌 택소노미 축 매칭·dropped 판정을 관점 카탈로그 행으로(core.filters).
"""
from __future__ import annotations

import pathlib
import uuid

import asyncpg
import pytest

from app.core.auth import DataScope, Principal
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, SYSTEM, Rows, Sql, load_named_sql, needs_db, staged

BACK = pathlib.Path(__file__).resolve().parents[2]
FIX_SQL = BACK / "migration" / "fix-core10-account-scope.sql"
ME_7 = ["AE", "BH", "IL", "KW", "OM", "QA", "SA"]          # genesis-middle-east(픽스처·stg app.rhq_region_country 같음)


def _p(countries: list[str], regions: list[str], brands: tuple[str, ...] = ("Genesis",), role: str = "country") -> Principal:
    return Principal(user_id=uuid.uuid4(), email="t@example.test", role=role, operator="global", scope_all=False,  # type: ignore[arg-type]
                     scope_brands=brands, scope_regions=tuple(regions), scope_countries=tuple(countries), menu_groups=None,
                     is_qa_reviewer=False)


# ── front projectInScope(lib/auth/scope-policy.ts:88-121) 한 줄씩 이식 ──────────────────────────────────────────
def _front_region_countries_for_brand(refs, regions: list[str], brand: str) -> list[str] | None:
    if not regions:
        return None
    brand_rids = [rid for rid, (bc, _) in refs.rhq.items() if bc == brand]
    rids = [r for r in regions if r in brand_rids]
    if not rids:
        return None
    return sorted({c for r in rids for c in refs.rhq[r][1]})


def _front_project_in_scope(refs, brands: list[str], regions: list[str], countries: list[str], brand: str | None, country: str | None) -> bool:
    if brands and brand and brand not in brands:
        return False
    if brand and country:
        rc = _front_region_countries_for_brand(refs, regions, brand)
        if rc is not None and country not in rc:
            return False
    return not (countries and country and country not in countries)


GRID = [(b, c) for b in (None, "Genesis", "Hyundai", "Kia") for c in ("AE", "SA", "US", "KR", "DE")]


@needs_db
async def test_decision4_region_only_country_matches_front(refs):
    """권역만 가진 country 계정(bd942069 형태): 데이터 국가 = 권역 전개(펼친 계정과 같다), 비멤버 가시성 = front projectInScope 격자 전부 일치.
    펼친 계정(이관 R2 옛 규칙)은 브랜드 공통 프로젝트 중 권역 밖(US·KR·DE)을 잃는다(좁힘 = 이번에 되돌린 차이)."""
    keep = DataScope.of(_p([], ["genesis-middle-east"]), refs)
    expanded = DataScope.of(_p(ME_7, ["genesis-middle-east"]), refs)
    assert keep.countries == expanded.countries == tuple(ME_7)
    assert keep.for_surface("website").countries == expanded.for_surface("website").countries      # 웹사이트 사이트 범위도 같다(SA-* 포함)
    lost = []
    for brand, country in GRID:
        want = _front_project_in_scope(refs, ["Genesis"], ["genesis-middle-east"], [], brand, country)
        assert keep.project_in_scope(refs, brand, country) == want, (brand, country)
        if want and not expanded.project_in_scope(refs, brand, country):
            lost.append((brand, country))
    assert lost == [(None, "US"), (None, "KR"), (None, "DE")]


@needs_db
async def test_p69_region_only_country_allowed_neither_rejected(db_v212):
    """P69: country 역할은 국가 또는 권역이 있으면 된다. 둘 다 없으면(보류 2계정 형태) 여전히 CHECK 거부."""
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(SYSTEM))
            uid = uuid.uuid4()
            await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries) "
                            "VALUES ($1, $2, 'country', 'global', false, '{Genesis}', '{genesis-middle-east}', '{}')", uid, f"t-{uid.hex[:8]}@example.test")
            assert await c.fetchval("SELECT scope_countries FROM app.user_account WHERE user_id = $1", uid) == []
            with pytest.raises(asyncpg.CheckViolationError):
                async with c.transaction():
                    await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, "
                                    "scope_countries) VALUES ($1, $2, 'country', 'none', false, '{Genesis}', '{}', '{}')",
                                    uuid.uuid4(), "t-core10-neither@example.test")
            raise _Rollback
    except _Rollback:
        pass
    finally:
        await c.close()


class _Rollback(Exception):
    pass


BRANDLESS_US = uuid.UUID("c0000000-0000-4000-8000-0000000c0a10")


@needs_db
@pytest.mark.parametrize("countries,visible", [([], True), (ME_7, False)], ids=["권역 유지", "국가로 펼침"])
async def test_decision4_nonmember_brandless_project_via_api(client_as, db_v212, countries, visible):
    """API 경로(분석 읽기 project 표면 = resolve_project level member): 권역만 가진 country 계정은 권역 밖 브랜드 공통 프로젝트를 비멤버로 본다
    (현행 front 와 같다). 국가로 펼친 계정은 404(이관 R2 옛 규칙의 좁힘)."""
    uid = uuid.uuid4()
    acct = {"user_id": uid, "email": f"t-{uid.hex[:8]}@example.test", "role": "country", "operator": "global", "scope_all": False,
            "scope_brands": ["Genesis"], "scope_regions": ["genesis-middle-east"], "scope_countries": countries}
    proj = {"project_id": BRANDLESS_US, "kind": "customer", "name": "core10 brandless US", "brand_code": None, "country_code": "US",
            "created_by": SYSTEM}
    async with staged(Rows("app.user_account", [acct]), Rows("app.project", [proj]), actor=SYSTEM), client_as(uid) as c:
        r = await c.get("/v1/kpi/summary", params={"surface": "project", "project_id": str(BRANDLESS_US)})
        g = await c.get("/v1/kpi/summary", params={"surface": "global"})
    assert r.status_code == (200 if visible else 404), r.text[:300]
    assert g.status_code == 200, g.text[:300]                 # 데이터 스코프(권역 전개)는 두 형태 모두 같은 국가 7개


# ── 결정 3: 계정 국가 정본 표기(P70) ──────────────────────────────────────────────────────────────────
@needs_db
async def test_p70_canonical_is_dim_country_first(db_v212):
    """rhq 표기와 dim_country 표기가 대소문자만 다를 때(합성: dim_country 'US' → 'Us') 계정 저장 표기 = dim_country 표기.
    종전 P59(rhq 먼저)라면 'US' 로 남는다(되돌림 확인: 패치 전 트리거에서 이 시험은 실패한다)."""
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(SYSTEM))
            await c.execute("UPDATE rd.dim_country SET code = 'Us' WHERE code = 'US'")
            uid = uuid.uuid4()
            await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries) "
                            "VALUES ($1, $2, 'country', 'none', false, '{Kia}', '{}', '{us,sa-dammam,DE}')",
                            uid, f"t-{uid.hex[:8]}@example.test")
            got = await c.fetchval("SELECT scope_countries FROM app.user_account WHERE user_id = $1", uid)
            raise _Result(got)
    except _Result as res:
        got = res.value
    finally:
        await c.close()
    assert got == ["Us", "SA-Dammam", "DE"]


class _Result(Exception):
    def __init__(self, value):
        super().__init__("result")
        self.value = value


# ── stg 1회 보정 SQL(back/migration/fix-core10-account-scope.sql) ─────────────────────────────────────────
def _fix_body(expect_canon: int = -1, expect_r2: int = -1) -> str:
    """보정 파일의 트랜잭션 본문(BEGIN 뒤 ~ COMMIT/ROLLBACK 분기 앞)을 asyncpg 로 돌릴 수 있게: psql 메타 줄 제거, 변수 치환.
    psql 분기(드라이런 기본·expect 불일치 거부·commit·재실행 0)는 로컬 psql 실측으로 확인했다(보고서)."""
    s = FIX_SQL.read_text(encoding="utf-8")
    body = s[s.index("BEGIN;") + len("BEGIN;"):s.index("\\if :{?commit}")]
    body = body.replace(":'expect_canon'", f"'{expect_canon}'").replace(":'expect_r2'", f"'{expect_r2}'").replace(" \\gset fix_", ";")
    return "\n".join(ln for ln in body.splitlines() if not ln.lstrip().startswith("\\"))


_FIX_TEMP = "DROP TABLE IF EXISTS _pre, _r2, _r2_res, _canon, _canon_res"   # ON COMMIT DROP 임시 표: 한 트랜잭션에서 두 번 돌릴 때 비운다


R2_ACCT = uuid.UUID("c010f1f1-0000-4000-8000-000000000001")
EDITED_ACCT = uuid.UUID("c010f1f1-0000-4000-8000-000000000003")


@needs_db
async def test_fix_sql_reverts_r2_and_canonicalizes_idempotent(db_v212):
    """보정 SQL: R2 로 펼쳐진 country 계정(원천 국가 없음 ∧ 지금 값 = 권역 전개 그대로)만 국가를 비우고(이관 뒤 고친 계정은 그대로),
    dim_country 표기와 다른 계정 국가를 정본으로 고친다. 두 번째 실행은 0·0(멱등). 기대 개수와 다르면 예외(전체 롤백)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(SYSTEM))
            await c.execute("CREATE SCHEMA IF NOT EXISTS mig_src")
            await c.execute("CREATE TABLE IF NOT EXISTS mig_src.profiles (id uuid PRIMARY KEY, email text, role text NOT NULL, scope_all bool NOT NULL, "
                            "brands text[], regions text[], countries text[], operator text NOT NULL, menu_groups text[], "
                            "created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)")
            await c.execute("INSERT INTO mig_src.profiles VALUES ($1, 't-fix-r2@example.test', 'country', false, '{Genesis}', '{genesis-middle-east}', "
                            "NULL, 'global', NULL, now(), now()), ($2, 't-fix-ed@example.test', 'country', false, '{Genesis}', "
                            "'{genesis-middle-east}', '{}', 'none', NULL, now(), now())", R2_ACCT, EDITED_ACCT)
            await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries) "
                            "VALUES ($1, 't-fix-r2@example.test', 'country', 'global', false, '{Genesis}', '{genesis-middle-east}', $3), "
                            "($2, 't-fix-ed@example.test', 'country', 'none', false, '{Genesis}', '{genesis-middle-east}', '{SA}')",
                            R2_ACCT, EDITED_ACCT, ME_7)
            await c.execute("UPDATE rd.dim_country SET code = 'Us' WHERE code = 'US'")      # 정본 표기가 계정 표기('US')와 달라진 상태
            n_us = await c.fetchval("SELECT count(*) FROM app.user_account WHERE 'US' = ANY (scope_countries)")
            assert n_us >= 1                                                              # 픽스처 KIA_US 계정
            with pytest.raises(asyncpg.RaiseError, match="B 대상 1 <> 기대 0"):
                async with c.transaction():
                    await c.execute(_fix_body(expect_r2=0))
            await c.execute(_fix_body(expect_canon=n_us, expect_r2=1))
            await c.execute(_FIX_TEMP)
            rows = {r["user_id"]: r["scope_countries"] for r in await c.fetch(
                "SELECT user_id, scope_countries FROM app.user_account WHERE user_id = ANY($1::uuid[])", [R2_ACCT, EDITED_ACCT])}
            assert rows == {R2_ACCT: [], EDITED_ACCT: ["SA"]}
            assert await c.fetchval("SELECT count(*) FROM app.user_account WHERE 'US' = ANY (scope_countries)") == 0
            assert await c.fetchval("SELECT count(*) FROM app.user_account WHERE 'Us' = ANY (scope_countries)") == n_us
            await c.execute(_fix_body(expect_canon=0, expect_r2=0))                       # 멱등: 두 번째는 0·0
        finally:
            await tr.rollback()
    finally:
        await c.close()


# ── 결정 7: 택소노미 축 관점 브랜드 한정(kpi R2) ───────────────────────────────────────────────────────
CORE10_SQL = load_named_sql(pathlib.Path(__file__).with_name("core10.pgsql"))


@needs_db
async def test_decision7_taxonomy_axis_limited_to_viewpoint_rows(client_as):
    """타 브랜드 카탈로그 행에만 있는 택소노미 값(제네시스 행의 depth2 'D2gen', 현대 행과 prompt_key 공유)을 현대 계정이 필터로 주면
    dropped + 결과 0(옵션에도 없다). 예전(rd.dim_taxon 사전·전 행 매칭)은 공유 프롬프트의 현대 데이터가 나왔다(값 존재·연결 오라클).
    관점이 그 브랜드면(관리자 brand=Genesis) 그대로 매칭된다."""
    async with staged(Sql(CORE10_SQL["genesis_only_taxon"])):
        async with client_as(HQ_HYUNDAI) as c:
            base = (await c.get("/v1/kpi/summary", params={"surface": "global"})).json()
            k = (await c.get("/v1/kpi/summary", params={"surface": "global", "depth2": "D2gen"})).json()
            ok = (await c.get("/v1/kpi/summary", params={"surface": "global", "depth2": "D2a"})).json()
            opt = (await c.get("/v1/filters/options", params={"surface": "global"})).json()
        async with client_as(ADMIN) as c:
            g = (await c.get("/v1/kpi/summary", params={"surface": "global", "brand": "Genesis", "depth2": "D2gen"})).json()
            gopt = (await c.get("/v1/filters/options", params={"surface": "global"})).json()
    assert base["data"]["params"]["measured_prompts"] > 0
    assert k["meta"]["dropped_filters"] == {"depth2": ["D2gen"]} and k["data"]["params"]["measured_prompts"] == 0
    assert "depth2" not in ok["meta"]["dropped_filters"] and ok["data"]["params"]["measured_prompts"] > 0      # 관점 행 값은 그대로
    assert "D2gen" not in {x["code"] for x in opt["data"]["catalog"]["depth2"]}                           # 옵션도 관점 행 범위
    assert "D2gen" not in {x["depth2"] for x in opt["data"]["catalog"]["rows"]}
    assert g["meta"]["dropped_filters"] == {} and g["data"]["params"]["measured_prompts"] > 0
    assert "D2gen" in {x["code"] for x in gopt["data"]["catalog"]["depth2"]}
