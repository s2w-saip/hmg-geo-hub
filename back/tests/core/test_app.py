"""앱 기동·OpenAPI(기능 스텁 172 작업 유지)·DB 불변식(G-25) 테스트."""
from __future__ import annotations

import asyncpg
from fastapi.testclient import TestClient

from app.main import app
from tests.support import DB_URL, needs_db

OPS = ("get", "post", "put", "patch", "delete")


def test_openapi_keeps_feature_stubs():
    spec = app.openapi()
    n = sum(len([m for m in v if m in OPS]) for v in spec["paths"].values())
    assert n == 219 and len(spec["paths"]) == 176   # 기능 172 + 적재 운영 조회 GET 3(ingest.pull.ops) + 값 갭 보강(BG) 신규 8 + GA4 대기 시장 4(경로 2, DB-v2.9 P61) + 수집 일괄 상태 GET 1(intent.fetches?ids, 기존 경로)
    #                                                 + 관리 카탈로그 프롬프트 타임라인 1(U8-7, catalog.prompts.history)
    #                                                 + 엔티티 버전 관리 26(경로 22, E6 admin.entities.versions, 포기 abandon 포함)
    #                                                 + 화면 목록 조회 POST …/screen 4(경로 4, 표준·관리자·프로젝트 프롬프트·후보, 내부 리팩토링 2026-10-09)
    assert all(p.startswith("/v1/") for p in spec["paths"])


def test_healthz_and_error_shape_without_db():
    with TestClient(app, raise_server_exceptions=False) as c:           # lifespan: 풀 생성만(접속은 요청 때), JWKS 미설정이면 건너뜀
        assert c.get("/healthz").json() == {"ok": True}
        r = c.get("/v1/does-not-exist")
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


@needs_db
async def test_g25_invariants_on_fixture(seeded):
    """단언 함수는 loader·migrator 전용(api_ro 실행 권한 없음). 테스트는 소유자 접속으로 호출한다."""
    c = await asyncpg.connect(DB_URL)
    try:
        assert await c.fetchval("SELECT rd.assert_answer_cit_counts(NULL)") == 19
        assert await c.fetchval("SELECT count(*) FROM pg_constraint WHERE conname IN ('answer_cit_bounds', 'answer_cit_flags') "
                                "AND conrelid = 'rd.answer'::regclass") == 2
        # 표면별 M05 분자 열 합 = 원소 판정 합(카드 = 원소 스캔)
        assert await c.fetchval("""SELECT (SELECT sum(cit_loc_tgt) FROM rd.answer WHERE surface = 2)
                                        = (SELECT count(*) FILTER (WHERE loc_owned OR tgt_hit) FROM rd.citation WHERE surface = 2 AND source_key <> 0)""")
        assert not await c.fetchval("SELECT has_function_privilege('api_ro', 'rd.assert_answer_cit_counts(int4[])', 'EXECUTE')")
        assert await c.fetchval("SELECT has_function_privilege('loader', 'rd.assert_answer_cit_counts(int4[])', 'EXECUTE')")
    finally:
        await c.close()
