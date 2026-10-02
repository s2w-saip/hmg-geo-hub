"""BG-44 관리 카탈로그 목록·상세 행의 Scope 반영 대기·오류 표식(outbox_pending·outbox_error) 통합 테스트(롤백 전용 준비).

준비(app.scope_outbox, aggregate 'prompt', 전부 롤백):
  c1…01(best suv, Hyundai): 미완료 1행, 오류 없음                → pending 참, error null
  c1…02(common q):          미완료 2행(옛 'e-old', 새 'e-new') + 완료 1행('superseded') → pending 참, error 'e-new'(가장 최근 미완료)
  c1…04(현대 SUV 추천, Hyundai): 완료 행만(오류 'boom' 이 남은 채 done)   → pending 거짓, error null(완료 행은 보지 않는다)
  c1…05(deleted row):       미완료 1행 오류 'gone'                 → include_deleted 목록에서만 보인다
그 밖의 행: 준비 전 DB 상태에 따라 다르므로 독립 SQL(같은 트랜잭션, 구현과 다른 식: 집계 + array_agg)로 기대값을 센다.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, Sql, needs_db, raw_fetch, staged

pytestmark = needs_db

BASE = "/v1/admin/catalog/prompts"
P1 = uuid.UUID("c1000000-0000-4000-8000-000000000001")
P2 = uuid.UUID("c1000000-0000-4000-8000-000000000002")
P4 = uuid.UUID("c1000000-0000-4000-8000-000000000004")
P5 = uuid.UUID("c1000000-0000-4000-8000-000000000005")
T0 = datetime(2026, 9, 20, tzinfo=UTC)

_INS = ("INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload, created_at, last_error, done_at) "
        "VALUES ('prompt', $1, 'update', '{}'::jsonb, $2, $3, $4)")
STEPS = (
    Sql(_INS, (P1, T0, None, None)),
    Sql(_INS, (P2, T0, "e-old", None)),
    Sql(_INS, (P2, T0 + timedelta(hours=1), "e-new", None)),
    Sql(_INS, (P2, T0 + timedelta(hours=2), "superseded", T0 + timedelta(hours=3))),
    Sql(_INS, (P4, T0, "boom", T0 + timedelta(hours=1))),
    Sql(_INS, (P5, T0, "gone", None)),
)

# 독립 기대값: 프롬프트별 미완료 수와 (created_at DESC) 순 오류 배열의 첫 값
EXPECT_SQL = """
SELECT p.prompt_id,
       count(o.outbox_id) AS n_pending,
       (array_agg(o.last_error ORDER BY o.created_at DESC, o.outbox_id DESC) FILTER (WHERE o.last_error IS NOT NULL))[1] AS err
  FROM app.prompt p
  LEFT JOIN app.scope_outbox o ON o.aggregate = 'prompt' AND o.aggregate_id = p.prompt_id AND o.done_at IS NULL
 WHERE p.project_id = 'c0000000-0000-4000-8000-000000000001'
 GROUP BY p.prompt_id
"""


async def _all(c, **params) -> list[dict]:
    out, cur = [], None
    while True:
        q = {**params, "limit": 500, **({"cursor": cur} if cur else {})}
        r = await c.get(BASE, params=q)
        assert r.status_code == 200, r.text
        out += r.json()["data"]["items"]
        cur = r.json()["meta"]["page"]["next_cursor"]
        if not cur:
            return out


async def test_outbox_flags_values(client_as):
    async with staged(*STEPS) as conn, client_as(ADMIN) as c:
        items = await _all(c, include_deleted="true")
        by = {uuid.UUID(i["prompt_id"]): i for i in items}
        # 손 계산
        assert (by[P1]["outbox_pending"], by[P1]["outbox_error"]) == (True, None)
        assert (by[P2]["outbox_pending"], by[P2]["outbox_error"]) == (True, "e-new")
        assert (by[P4]["outbox_pending"], by[P4]["outbox_error"]) == (False, None)
        assert (by[P5]["outbox_pending"], by[P5]["outbox_error"]) == (True, "gone")
        # 전 행 독립 SQL 대조
        exp = {r["prompt_id"]: (r["n_pending"] > 0, r["err"]) for r in await raw_fetch(conn, EXPECT_SQL)}
        assert {k: (v["outbox_pending"], v["outbox_error"]) for k, v in by.items()} == exp
        # 상세도 같은 값(pending_outbox 목록과 일치)
        r = await c.get(f"{BASE}/{P2}")
        d = r.json()["data"]
        assert (d["prompt"]["outbox_pending"], d["prompt"]["outbox_error"]) == (True, "e-new")
        assert [o["last_error"] for o in d["pending_outbox"]] == ["e-old", "e-new"]
        r = await c.get(f"{BASE}/{P4}")
        assert (r.json()["data"]["prompt"]["outbox_pending"], r.json()["data"]["pending_outbox"]) == (False, [])


async def test_outbox_flags_filters_and_empty(client_as):
    async with staged(*STEPS), client_as(ADMIN) as c:
        # 기본(삭제 제외): P5 는 안 보인다
        ids = {uuid.UUID(i["prompt_id"]) for i in await _all(c)}
        assert P5 not in ids and {P1, P2, P4} <= ids
        # 필터(브랜드 Hyundai): P1·P4 만 남고 표식은 그대로
        items = await _all(c, brand="Hyundai")
        got = {uuid.UUID(i["prompt_id"]): (i["outbox_pending"], i["outbox_error"]) for i in items}
        assert got[P1] == (True, None) and got[P4] == (False, None) and P2 not in got
        assert all(i["brand_code"] == "Hyundai" for i in items)
        # 빈 결과
        r = await c.get(BASE, params={"q": f"no-such-{uuid.uuid4().hex}"})
        assert r.status_code == 200 and r.json()["data"]["items"] == []


async def test_outbox_flags_scope_and_invalid(client_as):
    async with staged(*STEPS):
        for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
            async with client_as(uid) as c:
                for r in (await c.get(BASE), await c.get(f"{BASE}/{P2}")):
                    assert r.status_code == 403 and "e-new" not in r.text and "outbox" not in r.text
        async with client_as(ADMIN) as c:
            for params in ({"limit": 0}, {"limit": 501}, {"cursor": "garbage"}, {"include_deleted": "maybe"}):
                assert (await c.get(BASE, params=params)).status_code == 422, params
            assert (await c.get(f"{BASE}/{uuid.uuid4()}")).status_code == 404


async def test_d4_write_response_fills_flags(client_as):
    """검증 D4 회귀: 쓰기 응답 prompt.outbox_pending·outbox_error 가 null 이 아니라 목록·상세와 같은 값이다.
    재현(수정 전): PATCH …/kind 가 outbox 를 적재했는데 응답 prompt.outbox_pending = null, 직후 상세는 true.
    재실행 안전: 매번 새 텍스트로 새 행을 만든다(이 대분류 쓰기 테스트 규약과 같다). 오류 문구는 그 새 행의 outbox 에만 소유자로 넣는다."""
    import asyncpg

    from tests.support import DB_URL

    async with client_as(ADMIN) as c:
        async def detail_flags(pid: str) -> tuple:
            d = (await c.get(f"{BASE}/{pid}")).json()["data"]
            return d["prompt"]["outbox_pending"], d["prompt"]["outbox_error"], bool(d["pending_outbox"])

        # 1) 생성: outbox(create) 적재 → 응답 true, 상세와 일치
        r = await c.post(BASE, json={"text": f"bg44-d4-{uuid.uuid4().hex[:8]}"})
        assert r.status_code == 201, r.text
        d = r.json()["data"]
        pid = d["prompt"]["prompt_id"]
        assert d["outbox_id"] and (d["prompt"]["outbox_pending"], d["prompt"]["outbox_error"]) == (True, None)
        assert await detail_flags(pid) == (True, None, True)
        # 2) 검증자 재현 경로: kind 전환(outbox 적재) → 응답 true
        r = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr"})
        d = r.json()["data"]
        assert r.status_code == 200 and d["applied"] and d["prompt"]["outbox_pending"] is True, r.text
        # 3) 변경 없는 요청(applied=false, outbox_id null)도 기존 대기를 그대로 보인다
        r = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr"})
        d = r.json()["data"]
        assert d["applied"] is False and d["outbox_id"] is None and d["prompt"]["outbox_pending"] is True, r.text
        # 4) 대기 행의 전송 오류도 같은 술어(가장 최근 미완료 행의 last_error)로 나온다
        own = await asyncpg.connect(DB_URL)
        try:
            n = await own.execute("UPDATE app.scope_outbox SET last_error = 'd4-err' "
                                  "WHERE aggregate = 'prompt' AND aggregate_id = $1 AND done_at IS NULL", uuid.UUID(pid))
            assert n != "UPDATE 0"
        finally:
            await own.close()
        r = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr", "dry_run": True})
        assert (r.json()["data"]["prompt"]["outbox_pending"], r.json()["data"]["prompt"]["outbox_error"]) == (True, "d4-err"), r.text
        r = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr"})
        assert (r.json()["data"]["prompt"]["outbox_pending"], r.json()["data"]["prompt"]["outbox_error"]) == (True, "d4-err")
        assert await detail_flags(pid) == (True, "d4-err", True)
        # 5) 대기 없는 행의 변경 없는 요청 = false(null 아님). 목록에서 대기 없는 살아 있는 행을 고른다
        items = await _all(c)
        idle = next((i for i in items if i["outbox_pending"] is False), None)
        assert idle is not None                     # 합성 픽스처 루트 카탈로그에는 outbox 없는 행이 있다
        r = await c.patch(f"{BASE}/{idle['prompt_id']}/kind", json={"kind": idle["kind"]})
        d = r.json()["data"]
        assert d["applied"] is False and (d["prompt"]["outbox_pending"], d["prompt"]["outbox_error"]) == (False, None), r.text
