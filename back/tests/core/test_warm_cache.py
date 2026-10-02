"""결과 캐시 데우기(app.tools.warm_cache): 대상 서명 선정, 앱을 거친 호출이 실요청과 같은 키를 만든다, 데이터 버전이 같으면 건너뛴다,
front candidateBrandKeys 재현(동기화 S1 BE-9: 현행 a862208 순위 기준 후보, 사례·하네스 = warm_candidates.json·.mjs)."""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import uuid

import pytest

from app.core import result_cache as rc
from app.core.config import get_settings, set_settings
from app.core.db import fetch_val
from app.tools import warm_cache as wc
from tests.core.rcache_calls import get
from tests.core.test_result_cache import invalidate
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, WEBSITE_KIA, Update, needs_db, staged

CASES_PATH = pathlib.Path(__file__).with_name("warm_candidates.json")
HARNESS = pathlib.Path(__file__).with_name("warm_candidates.mjs")
FRONT = pathlib.Path(__file__).resolve().parents[3] / "front"
TOYOTA = "71000000-0000-4000-8000-000000000001"


def _cases() -> list[dict]:
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["id"])
def test_candidate_brand_keys_matches_front_rule(case):
    """현행 규칙(hmg-geo a862208·2670a16: 우선 노출도 = 언급 상위 10(자사 포함) 안 경쟁사의 평균 순위 순) = 하네스로 뽑은 expected."""
    assert wc.candidate_brand_keys(case["brands"]) == case["expected"], case["note"]


def test_candidate_cases_discriminate_old_rule():
    """사례 묶음이 옛 규칙(position 도 언급 순)을 가려낸다: 되돌리면 적어도 이 사례들이 실패한다."""
    moved = {c["id"] for c in _cases() if c["old_rule"] != c["expected"]}
    assert {"pool_boundary", "rank_order", "round_ties", "after_exclusion_refill", "fold_ties"} <= moved


def _node_keys(root: pathlib.Path) -> dict[str, list[int]]:
    out = subprocess.run(["node", str(HARNESS), str(root), str(CASES_PATH)], capture_output=True, text=True, timeout=60, check=False)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout)


@pytest.mark.skipif(shutil.which("node") is None or not (FRONT / "lib/scope/competitor-row.ts").is_file(), reason="node 또는 front/ 없음")
def test_front_adapter_rule_parity():
    """front 의 실제 규칙 코드(lib/scope/competitor-row.ts·lib/hgh/convert.ts)를 node 로 돌려 사례마다 대조한다.
    front 가 현행 규칙(a862208: RANK_TABLE_TOP_BRANDS 모집단)이면 expected, 병합 전 옛 규칙이면 old_rule 과 같아야 한다
    (하네스가 실제 코드를 읽는다는 증거. W-FE 병합 뒤에는 expected 쪽만 통과한다)."""
    current = "RANK_TABLE_TOP_BRANDS" in (FRONT / "lib/scope/competitor-row.ts").read_text(encoding="utf-8")
    got = _node_keys(FRONT)
    want = {c["id"]: c["expected" if current else "old_rule"] for c in _cases()}
    assert got == want
    if current:
        assert got == {c["id"]: wc.candidate_brand_keys(c["brands"]) for c in _cases()}


@pytest.mark.skipif(not (FRONT / "lib/hgh/adapters/dashboard.ts").is_file(), reason="front/ 없음")
def test_harness_glue_matches_adapter_source():
    """하네스가 옮겨 적은 어댑터 접착 줄이 원본에 그대로 있다(어댑터가 바뀌면 하네스·데우기 규칙을 다시 본다)."""
    dash = (FRONT / "lib/hgh/adapters/dashboard.ts").read_text(encoding="utf-8")
    trend = (FRONT / "lib/hgh/adapters/trend.ts").read_text(encoding="utf-8")
    for line in ("avgPosition: rankAvg(b.avg_rank),", "isTracked: b.is_own || b.is_hmg_own === true,",
                 "const byName = new Map(brands.map((b) => [b.brand, b.brandKey]));",
                 "for (const name of competitorDeltaBrands([...brands])) {",
                 'if (typeof k === "number" && !keys.includes(k)) keys.push(k);',
                 "const keys = candidateBrandKeys(brands);"):
        assert line in dash, line
    assert "extra.brand_key = [...new Set(brandKeys)].sort((a, b) => a - b);" in trend


def test_js_round1_is_half_up():
    assert [wc._js_round1(x) for x in (2.25, 2.35, 0.05, 1.0, 2.26)] == [2.3, 2.4, 0.1, 1.0, 2.3]
    assert wc._rank_avg({"sum": 9, "count": 4}) == 2.3 and wc._rank_avg({"sum": 1, "count": 0}) is None and wc._rank_avg(None) is None


def test_calls_file_is_allowlisted_and_has_derive_source():
    calls = wc.load_calls()
    ids = {c["id"] for c in calls}
    assert len(calls) == 34 and all(("GET", c["path"]) in rc.ALLOWLIST for c in calls)
    for c in calls:
        src = (c.get("derive") or {}).get("brand_key_from")
        assert src is None or src in ids


@needs_db
async def test_warm_fills_same_keys_as_real_requests_and_skips_when_unchanged(client_as, cache_on):
    await invalidate()
    dry = await wc.run(dry_run=True)
    assert dry["status"] == "dry_run" and dry["signatures"] >= 3, dry
    uids = {t["uid"] for t in dry["targets"]}
    assert str(ADMIN) in uids and str(KIA_US) not in uids                    # 국가 계정 서명은 데우지 않는다
    res = await wc.run()
    assert (res["status"], res["errors"], res["hit"]) == ("done", 0, 0) and res["miss"] == res["calls"] > 30, res
    # 실요청(토큰 인증) = 데우기와 같은 키: 관리자·현대 브랜드 전용·웹사이트 기아 브랜드 전용 모두 적중.
    # 대시보드 카드 경로 호출은 front 가 card=true 를 보낸다(WU-3, dashboard.ts 머리 'WU-3 card path'), 언급 탭 요약(M2)은 보내지 않는다
    for uid, path, prm in ((ADMIN, "/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none",
                                                 "metrics": ["visibility", "share_of_voice", "sentiment", "position"]}),
                           (HQ_HYUNDAI, "/v1/mentions/brands", {"surface": "global", "top_n": "20", "sort": "mentions", "include": "hmg",
                                                                "card": "true"}),
                           (WEBSITE_KIA, "/v1/kpi/summary", {"surface": "website", "card": "true"}),
                           (ADMIN, "/v1/citations/domains", {"surface": "global", "limit": "0", "competitor_sources": "true", "card": "true"}),
                           (ADMIN, "/v1/kpi/summary", {"surface": "global"})):
        r = await get(client_as, uid, path, prm)
        assert (r.status_code, r.headers.get(rc.HEADER)) == (200, "hit"), (uid, path)
    r = await get(client_as, KIA_US, "/v1/kpi/summary", {"surface": "global"})
    assert r.headers.get(rc.HEADER) == "miss"                                   # 국가 계정은 첫 조회 때 채운다
    again = await wc.run()
    assert again["status"] == "skipped", again                                 # 데이터 버전·빌드·호출 목록이 같으면 건너뛴다
    forced = await wc.run(force=True, concurrency=4)
    assert (forced["status"], forced["miss"], forced["errors"]) == ("done", 0, 0) and forced["hit"] == forced["calls"], forced
    await invalidate()                                                        # 버전이 바뀌면 다시 데운다
    assert (await wc.run())["status"] == "done"


@needs_db
async def test_warm_requires_cache_enabled(rcache_db):
    s = get_settings()
    set_settings(s.model_copy(update={"result_cache": False}))
    try:
        assert (await wc.run())["status"] == "error"
    finally:
        set_settings(s)


@needs_db
async def test_warm_cli_prints_one_json_line(capsys, cache_on, monkeypatch):
    """main: 한 줄 JSON·종료 코드. DB 는 main 이 열고 닫으므로 시험 DB 설정으로 부른 뒤 시험 픽스처의 DB 를 되살린다."""
    from app.core import db as db_mod

    before = db_mod._db
    try:
        rc_ = await wc.main(["--dry-run"])
    finally:
        db_mod._db = before
    out = capsys.readouterr().out.strip().splitlines()
    assert rc_ == 0 and len(out) == 1 and json.loads(out[0])["status"] == "dry_run"


@needs_db
async def test_derived_trend_keys_skip_excluded_entities(client_as):
    """명부 제외(Toyota, BE-5) 상태: D2(M-1) 응답에 Toyota 가 없어 후보에도 없고, 후보로 만든 D7(T-1) 은 dropped_filters 가 비어
    캐시 저장 대상이다. 제외 키를 직접 넣은 T-1 은 dropped_filters 가 차 저장되지 않는다(그래서 데우기 목록에 두지 않는다)."""
    calls = {c["id"]: c for c in wc.load_calls()}
    d2, d7 = calls["D2"], calls["D7"]
    async with staged(Update("rd.dim_entity", {"entity_id": uuid.UUID(TOYOTA)}, {"registry_role": "excluded"})) as conn:
        toyota = int(await fetch_val(conn, "SELECT brand_key FROM rd.dim_entity WHERE entity_id = CAST(:e AS uuid)", {"e": TOYOTA}))
        async with client_as(HQ_HYUNDAI) as c:
            r2 = await c.get(d2["path"], params=d2["params"])
            assert r2.status_code == 200, r2.text[:300]
            brands = r2.json()["data"]["brands"]
            assert brands and toyota not in {b.get("brand_key") for b in brands}
            keys = wc.candidate_brand_keys(brands)
            assert keys and toyota not in keys
            r7 = await c.get(d7["path"], params={**d7["params"], "brand_key": [str(k) for k in keys]})
            assert r7.status_code == 200 and not rc.has_dropped_filters(r7.content), r7.text[-300:]
            bad = await c.get(d7["path"], params={**d7["params"], "brand_key": [str(k) for k in sorted({*keys, toyota})]})
            assert bad.status_code == 200 and rc.has_dropped_filters(bad.content)
            assert bad.json()["meta"]["dropped_filters"] == {"brand_key": [str(toyota)]}
