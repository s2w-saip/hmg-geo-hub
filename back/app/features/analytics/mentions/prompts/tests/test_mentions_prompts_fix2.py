"""GET /v1/mentions/prompts 2차 검증(ff74b52) 결함 회귀: D3 모델 하이라이트 규칙, D5 배포 전 커서 호환, D6 signal 타깃 인자 422.

- D3: model 표기는 현행 highlightTermsForBrand(front/lib/scope/result-adapter.ts:326-340)와 같이 롤업으로만 잇는다
  (롤업 id 가 그 답변의 타깃 Brand 행이거나 롤업 엔티티의 정본 브랜드가 타깃). 엔티티 자기 정본 브랜드(e_bk)로는 잇지 않는다:
  k1 ord5 'Hyundai Creta'(Product, 정본 Hyundai, 롤업 = Tata)는 Hyundai 타깃에서 칠하지 않는다(현행 model []).
- D5: 커서 필터 해시는 BG 라운드 전(8890406)과 같은 값을 낸다. 새 인자(mention_brand·own·own_brand_code)는 기본값이면 해시에서 뺀다.
  예전에는 model_dump 에 기본값이 들어가 배포 전 커서가 422 cursor_invalid 였다.
- D6: mode=signal 에 brand_key 가 오면 조용히 무시하지 않고 422(own·mention_brand·own_brand_code 는 1차 수정에서 막았다).
"""
from __future__ import annotations

import base64
import json
import uuid
from typing import Literal

import pytest
from pydantic import Field

from app.core.filters import CommonFilters
from app.core.pagination import filter_hash
from app.features.analytics.mentions.brands.tests.mentions_testkit import brand_keys
from app.features.analytics.mentions.prompts.schemas import PromptsQuery
from app.features.analytics.mentions.prompts.service import build_terms, cursor_hash
from tests.support import ADMIN, HQ_HYUNDAI, Update, needs_db, staged

URL = "/v1/mentions/prompts"
J1 = "90000000-0000-4000-8000-000000000001"
J12 = "90000000-0000-4000-8000-000000000012"


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _terms(d):
    return {a["job_id"]: a["terms"] for i in d["items"] for a in i["answers"]}


# ── D3: 모델 하이라이트 = 롤업만(현행과 같다) ──────────────────────────────────
@needs_db
async def test_terms_model_rollup_only_matches_front(client_as):
    """검증 재현: k1 ord5 Hyundai Creta 표면 ['Creta', 'Toyota'](롤백 준비). Hyundai 타깃 model = [](예전 ['Hyundai Creta', 'Creta', 'Toyota'])."""
    step = Update("ing.mention", {"job_id": uuid.UUID(J1), "ord": 5}, {"surfaces": ["Creta", "Toyota"]})
    async with staged(step):
        for params in ({"mode": "brand", "mention_brand": "Hyundai"}, {"mode": "brand", "own": "true"}):
            d = (await _get(client_as, HQ_HYUNDAI, surface="global", terms="true", **params)).json()["data"]
            assert _terms(d) == {J1: {"brand": ["Hyundai"], "model": []}, J12: {"brand": ["Hyundai"], "model": []}}, params


def test_build_terms_model_ignores_entity_brand():
    """단위: 롤업이 다른 브랜드인 Product 는 자기 정본 브랜드(e_bk)가 타깃이어도 model 이 아니다. 롤업(id·정본 브랜드)으로만 잇는다."""
    rows = [
        {"entity_type": "Brand", "display_name": "Hyundai", "surfaces": [], "entity_id": "h", "e_bk": 1, "e_own": 1, "e_name": "Hyundai"},
        {"entity_type": "Product", "display_name": "Hyundai Creta", "surfaces": ["Creta"], "entity_id": "c", "rollup_id": "t",
         "e_bk": 1, "e_own": 1, "r_bk": 9, "r_own": 0},
        {"entity_type": "Product", "display_name": "Ioniq 5", "surfaces": [], "entity_id": "i", "rollup_id": "h", "e_bk": 1, "e_own": 1},
        {"entity_type": "Product", "display_name": "Tucson", "surfaces": [], "entity_id": "u", "rollup_id": "hx", "r_bk": 1, "r_own": 1},
    ]
    t = build_terms(rows, brand_key=1, name="Hyundai", bits=(), seeds=["Hyundai"])
    assert t.model_dump() == {"brand": ["Hyundai"], "model": ["Ioniq 5", "Tucson"]}
    t = build_terms(rows, brand_key=None, name=None, bits=(1,), seeds=["Hyundai"], seeds_if_present=True)
    assert t.model_dump() == {"brand": ["Hyundai"], "model": ["Ioniq 5", "Tucson"]}


# ── D5: 배포 전 커서 호환 ─────────────────────────────────────────────────────
class _BaseQuery(CommonFilters):
    """8890406 PromptsQuery 의 필드(검증 없이 해시 모양만): 공통 필터 + mode·brand_key·signal·limit·cursor·answers_limit."""
    mode: Literal["brand", "signal"]
    brand_key: int | None = None
    signal: str | None = None
    limit: int = 50
    cursor: str | None = None
    answers_limit: int = Field(6)


def _base_hash(params: dict) -> str:
    q = _BaseQuery.model_validate(params)
    f = q.model_dump(mode="json", by_alias=True, exclude={"limit", "cursor", "answers_limit"})      # 8890406 cursor_hash 그대로
    return filter_hash({"f": f, "cf": {}})


@pytest.mark.parametrize("params", [
    {"surface": "global", "mode": "brand", "brand_key": 1},
    {"surface": "global", "mode": "brand", "brand_key": 7, "engine": ["chatgpt"], "country": ["US"], "from": "2026-09-01", "to": "2026-09-20"},
    {"surface": "global", "mode": "signal", "signal": "positive"},
    {"surface": "global", "mode": "signal", "signal": "mention", "terms": True}])
def test_cursor_hash_matches_pre_bg(params):
    assert cursor_hash(PromptsQuery.model_validate(params), {}) == _base_hash({k: v for k, v in params.items() if k != "terms"})


def test_cursor_hash_new_targets_differ():
    base = {"surface": "global", "mode": "brand"}
    hs = {cursor_hash(PromptsQuery.model_validate({**base, **t}), {}) for t in (
        {"brand_key": 1}, {"mention_brand": "Hyundai"}, {"own": True}, {"own": True, "own_brand_code": "Kia"},
        {"own": True, "own_brand_code": "Hyundai"})}
    assert len(hs) == 5


def _swap_fh(token: str, fh: str) -> str:
    raw = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    raw["fh"] = fh
    return base64.urlsafe_b64encode(json.dumps(raw, separators=(",", ":")).encode()).rstrip(b"=").decode()


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI])
async def test_pre_bg_cursor_replays(client_as, ro, uid):
    """검증 재현: 배포 전(8890406) 해시로 만든 커서를 같은 인자로 다시 보내면 200 이고 다음 페이지가 같다(예전 422 cursor_invalid)."""
    k = await brand_keys(ro, ["Hyundai"])
    params = {"surface": "global", "mode": "brand", "brand_key": k["Hyundai"], "limit": 1, "from": "2026-09-01", "to": "2026-09-20"}
    first = (await _get(client_as, uid, **params)).json()
    nxt = first["meta"]["page"]["next_cursor"]
    assert nxt, first
    old = _swap_fh(nxt, _base_hash({k2: v for k2, v in params.items() if k2 != "limit"}))
    r_old = await _get(client_as, uid, **params, cursor=old)
    r_new = await _get(client_as, uid, **params, cursor=nxt)
    assert r_old.status_code == 200, r_old.text
    assert r_old.json()["data"] == r_new.json()["data"]


# ── D6: mode=signal 의 brand_key ─────────────────────────────────────────────
@needs_db
async def test_signal_mode_rejects_brand_key(client_as):
    r = await _get(client_as, ADMIN, surface="global", mode="signal", signal="positive", brand_key=1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", r.text
