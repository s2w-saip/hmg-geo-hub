"""결과 캐시 데우기(core.result_cache, DB-v2.11): 데이터 버전이 바뀌었을 때만 기본 화면 호출을 앱을 거쳐 미리 채운다.

사용(API 와 같은 env: HGH_DB_URL·HGH_RESULT_CACHE=1·HGH_BUILD_ID(쓰면 API 와 같은 값))
    python -m app.tools.warm_cache              데우기 표식(현재 데이터 버전 + 빌드 + 호출 목록)이 있으면 건너뛰고, 없으면 데운다
    python -m app.tools.warm_cache --dry-run    대상 서명·대표 계정·호출 수만 출력(요청 없음)
    python -m app.tools.warm_cache --force      표식과 무관하게 데운다
    옵션 --concurrency N(기본 2, 최대 4) · --calls <json>(기본 app/tools/warm_calls.json)
출력: stdout 한 줄 JSON(status skipped|done|dry_run|error, version, signatures, calls, hit, miss, errors, dropped, seconds).
dropped = 응답 meta.dropped_filters 가 차서 캐시에 저장되지 않은 호출 수(정상 0: D7 brand_key 는 명부 제외를 반영한 D2 에서 뽑는다). 종료 코드 0 = 완료·건너뜀,
1 = 실패한 호출이 있음(표식을 남기지 않는다: 다음 실행이 다시 데운다), 2 = 설정 오류(HGH_RESULT_CACHE 가 1 이 아님).

대상 = 활성 계정(app.user_account status active)을 표면별 해석 스코프 서명(core.result_cache.scope_signature)으로 묶은 것 중
  전체(all) 또는 브랜드 전용(국가 제약 없음) 서명. 서명마다 대표 계정 1명(그 표면·끝점 게이트를 통과하는 계정 중 user_id 최소).
  국가·권역 계정 서명은 첫 조회 때 채운다(데우지 않음: 조사 5절 B3). 호출 목록 = warm_calls.json(front 기본 호출 근거 file:line).
호출 = 앱(ASGI, 이 프로세스 안)을 거친다: 인증만 대표 계정 uid 를 요청 scope state 의 core.auth 검증 결과 자리에 넣어 대신하고
  (Bearer 토큰 없음. 이 대체는 이 프로세스의 ASGI 래퍼에만 있다), 계정 조회·표면 게이트·캐시 키·계산·저장은 실요청과 같은 경로라
  같은 키가 만들어진다. 서비스 함수를 직접 부르지 않는다. 동시 요청 수 = --concurrency(기본 2).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import math
import pathlib
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from app.core import result_cache as rc
from app.core.auth import Principal, principal_from_row, shows_geo_map, surface_denial
from app.core.codes import load_refs
from app.core.config import get_settings
from app.core.db import close_db, fetch_all, get_db, init_db
from app.core.measure import lc_key

log = logging.getLogger("hgh.warm_cache")

CALLS_PATH = pathlib.Path(__file__).with_name("warm_calls.json")
_SUBJECT_STATE = "hgh_verified_subject"          # core.auth.verified_subject 가 먼저 보는 요청 state 자리
_ACCOUNTS_SQL = """
SELECT user_id, email::text AS email, display_name, role::text AS role, operator::text AS operator, scope_all,
       scope_brands, scope_regions, scope_countries, menu_groups::text[] AS menu_groups, is_qa_reviewer
  FROM app.user_account WHERE status = 'active' ORDER BY user_id
"""


def load_calls(path: pathlib.Path = CALLS_PATH) -> list[dict[str, Any]]:
    calls = json.loads(path.read_text(encoding="utf-8"))["calls"]
    for c in calls:
        if ("GET", c["path"]) not in rc.ALLOWLIST:
            raise ValueError(f"데우기 호출이 캐시 허용 목록 밖: {c['path']}")
    return calls


def marker_prefix(calls_hash: str) -> bytes:
    """데우기 표식 키 접두(빌드·호출 목록 지문 포함). 키 = sha256(접두 || 데이터 버전)(DB lookup 과 같은 규칙)."""
    return hashlib.sha256(f"hgh-rcache-warm-marker|{rc.build_id()}|{calls_hash}".encode()).digest()


RANK_TABLE_TOP_BRANDS = 10      # 우선 노출도 후보 모집단 = 언급 수 상위 N(자사 포함). front lib/kpi/first-position-rank.ts:36(hmg-geo a862208)


def _js_round1(x: float) -> float:
    """JS Math.round(x * 10) / 10(front convert.ts round1). .5 는 +∞ 쪽(Python round 의 짝수 반올림과 다르다)."""
    y = x * 10
    f = math.floor(y)
    return (f + 1 if y - f >= 0.5 else f) / 10


def _rank_avg(r: Any) -> float | None:
    """front convert.ts rankAvg: count > 0 이면 round1(sum / count), 아니면 None(순위 없음)."""
    if not isinstance(r, dict) or not (r.get("count") or 0) > 0:
        return None
    return _js_round1(float(r.get("sum") or 0) / float(r["count"]))


def _fold(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """dedupeBrandRows: 표기 접기(trim·lower), 언급이 더 많은 행이 대표, 자리는 첫 등장(JS Map 삽입 순서)."""
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        k = r["brand"].strip().lower()
        cur = out.get(k)
        if cur is None or r["mentions"] > cur["mentions"]:
            out[k] = r
    return list(out.values())


def _by_mentions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda r: (-r["mentions"], lc_key(r["brand"])))


def candidate_brand_keys(items: list[dict[str, Any]], *, limit: int = 4) -> list[int]:
    """front candidateBrandKeys(lib/hgh/adapters/dashboard.ts:447-455 → lib/scope/competitor-row.ts competitorDeltaBrands) 재현.
    현행 규칙(hmg-geo a862208 #318, 2670a16): Δ 지표 셋(COMPETITOR_DELTA_KEYS: visibility·shareOfVoice·position)의 후보 합집합.
      visibility·shareOfVoice  당사·HMG 제외, 언급 > 0 인 경쟁사를 언급 수 내림차순·이름 localeCompare(core.measure.lc_key 근사) →
                               표기 접기 → 상위 limit(competitorCandidates)
      position                 모집단 = 전 행(자사 포함) 언급 수 순 → 표기 접기 → 상위 RANK_TABLE_TOP_BRANDS(10). 그 안의 경쟁사 중
                               평균 순위(round1(sum/count))가 있는 행을 순위 오름차순·이름 순 → 상위 limit(positionCandidates·sortMinisByValue)
    → 이름별 brand_key(같은 이름이 여럿이면 마지막 행: JS Map 생성) 오름차순 중복 제거(trend.ts:156).
    입력 = M-1 응답 brands(명부 제외 행은 BE-D 가 이미 빼고 다음 순위로 채운 목록 = 현행 filterCompetitorValues 뒤의 입력)라
    제외 키가 후보에 들어오지 않는다(제외 키를 담은 T-1 은 dropped_filters 로 캐시에 저장되지 않는다)."""
    rows = [{"brand": str(b.get("name") or ""), "mentions": int(b.get("mentions") or 0), "key": b.get("brand_key"),
             "tracked": bool(b.get("is_own")) or b.get("is_hmg_own") is True,
             "pos": _rank_avg(b.get("avg_rank"))} for b in items]
    names: dict[str, int] = {}
    # visibility·shareOfVoice: 값이 있는 조건(언급 > 0)과 정렬이 같아 두 지표의 후보가 같다(한 번만 센다)
    for r in _fold(_by_mentions([r for r in rows if not r["tracked"] and r["mentions"] > 0]))[:limit]:
        names[r["brand"]] = max(names.get(r["brand"], 0), r["mentions"])
    pool = _fold(_by_mentions(rows))[:RANK_TABLE_TOP_BRANDS]
    ranked = sorted((r for r in pool if not r["tracked"] and r["pos"] is not None), key=lambda r: (r["pos"], lc_key(r["brand"])))
    for r in ranked[:limit]:
        names[r["brand"]] = max(names.get(r["brand"], 0), r["mentions"])
    by_name: dict[str, Any] = {}
    for r in rows:
        by_name[r["brand"]] = r["key"]
    return sorted({by_name[n] for n in names if isinstance(by_name.get(n), int)})


def _passes(p: Principal, call: dict[str, Any]) -> bool:
    surface = call["params"]["surface"]
    if surface_denial(p, surface) is not None:
        return False
    return not (call["path"] == "/v1/geo" and not shows_geo_map(p))


async def plan(calls: list[dict[str, Any]]) -> tuple[str, bytes | None, dict[str, dict[str, Any]]]:
    """(현재 데이터 버전, 표식 적중 바이트, {서명 JSON: {uid, surface, geo, calls}}). 한 api_ro 트랜잭션(같은 스냅샷)."""
    async with get_db().read("api_ro") as conn:
        refs = await load_refs(conn)
        accounts = [principal_from_row(r) for r in await fetch_all(conn, _ACCOUNTS_SQL)]
        dv, marker = await rc.lookup(conn, marker_prefix(_calls_hash(calls)))
    groups: dict[str, dict[str, Any]] = {}
    for call in calls:
        surface = call["params"]["surface"]
        geo = call["path"] == "/v1/geo"
        for p in accounts:
            if not _passes(p, call):
                continue
            sig = rc.scope_signature(p, refs, surface, geo_gate=geo)
            if not (sig["all"] or (sig["brands"] and sig["countries"] is None)):
                continue                                     # 국가·권역 서명은 첫 조회 때 채운다
            k = json.dumps(sig, sort_keys=True, ensure_ascii=False)
            g = groups.setdefault(k, {"uid": p.user_id, "surface": surface, "geo": geo, "calls": []})
            if p.user_id < g["uid"]:
                g["uid"] = p.user_id
            if call not in g["calls"]:
                g["calls"].append(call)
    return dv, marker, groups


def _calls_hash(calls: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(calls, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def _as_user(app: Any, uid: uuid.UUID) -> Callable[..., Awaitable[None]]:
    """이 프로세스 전용 ASGI 래퍼: 요청 scope state 에 검증된 계정 uid 를 넣는다(core.auth.verified_subject 가 토큰보다 먼저 본다)."""
    async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http":
            scope = {**scope, "state": {**(scope.get("state") or {}), _SUBJECT_STATE: uid}}
        await app(scope, receive, send)
    return asgi


async def run(*, force: bool = False, dry_run: bool = False, concurrency: int = 2, calls_path: pathlib.Path = CALLS_PATH) -> dict[str, Any]:
    """데우기 1회. DB 는 get_db()(없으면 설정으로 연다)를 쓰고 닫지 않는다(main 이 닫는다)."""
    import httpx

    from app.main import app

    t0 = time.monotonic()
    if not get_settings().result_cache:
        return {"status": "error", "error": "HGH_RESULT_CACHE=1 이 아니다(API 와 같은 설정으로 실행)"}
    calls = load_calls(calls_path)
    dv, marker, groups = await plan(calls)
    out: dict[str, Any] = {"version": dv, "build": rc.build_id(), "signatures": len(groups),
                           "calls": sum(len(g["calls"]) for g in groups.values()), "hit": 0, "miss": 0, "errors": 0, "dropped": 0}
    out["warmed"] = marker is not None                   # 현재 데이터 버전·빌드·호출 목록으로 이미 데웠는가
    if dry_run:
        out["targets"] = [{"uid": str(g["uid"]), "surface": g["surface"], "geo": g["geo"], "calls": len(g["calls"])} for g in groups.values()]
        return {**out, "status": "dry_run", "seconds": round(time.monotonic() - t0, 2)}
    if marker is not None and not force:
        return {**out, "status": "skipped", "seconds": round(time.monotonic() - t0, 2)}
    sem = asyncio.Semaphore(max(1, min(4, concurrency)))

    async def one(client: Any, call: dict[str, Any], seen: dict[str, Any]) -> None:
        params = dict(call["params"])
        src = (call.get("derive") or {}).get("brand_key_from")
        if src:
            keys = candidate_brand_keys(((seen.get(src) or {}).get("data") or {}).get("brands") or [])
            if keys:
                params["brand_key"] = [str(k) for k in keys]
        async with sem:
            r = await client.get(call["path"], params=params)
        if r.status_code != 200:
            out["errors"] += 1
            log.warning("데우기 호출 실패 %s %s: %s", call["id"], call["path"], r.status_code)
            return
        state = r.headers.get(rc.HEADER)
        if state in ("hit", "miss"):
            out[state] += 1
        if rc.has_dropped_filters(r.content):            # 저장되지 않는 응답(meta.dropped_filters): 후보 규칙이 서버와 어긋났다는 신호
            out["dropped"] += 1
            log.warning("데우기 호출 %s 응답에 dropped_filters: 캐시에 저장되지 않는다", call["id"])
        if any((c.get("derive") or {}).get("brand_key_from") == call["id"] for c in calls):
            seen[call["id"]] = r.json()

    async def signature(g: dict[str, Any]) -> None:
        transport = httpx.ASGITransport(app=_as_user(app, g["uid"]))
        async with httpx.AsyncClient(transport=transport, base_url="http://warm", timeout=120) as client:
            seen: dict[str, Any] = {}
            order = sorted(g["calls"], key=lambda c: 1 if c.get("derive") else 0)    # 파생 호출은 원천 호출 뒤
            await asyncio.gather(*[one(client, c, seen) for c in order if not c.get("derive")])
            await asyncio.gather(*[one(client, c, seen) for c in order if c.get("derive")])

    await asyncio.gather(*[signature(g) for g in groups.values()])
    if out["errors"] == 0:
        await rc.put(rc.cache_key(marker_prefix(_calls_hash(calls)), dv), "__warm__", dv, b"{}")
    return {**out, "status": "done" if out["errors"] == 0 else "error", "seconds": round(time.monotonic() - t0, 2)}


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.tools.warm_cache", description="결과 캐시 데우기(데이터 버전이 바뀌었을 때만)")
    ap.add_argument("--force", action="store_true", help="데우기 표식과 무관하게 데운다")
    ap.add_argument("--dry-run", action="store_true", help="대상 서명·호출 수만 출력")
    ap.add_argument("--concurrency", type=int, default=2, help="동시 요청 수(기본 2, 최대 4)")
    ap.add_argument("--calls", type=pathlib.Path, default=CALLS_PATH, help="호출 목록 JSON")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if not get_settings().result_cache:
        print(json.dumps({"status": "error", "error": "HGH_RESULT_CACHE=1 이 아니다"}, ensure_ascii=False))
        return 2
    init_db(get_settings())
    try:
        res = await run(force=a.force, dry_run=a.dry_run, concurrency=a.concurrency, calls_path=a.calls)
    finally:
        await close_db()
    print(json.dumps(res, ensure_ascii=False, default=str))
    return 1 if res.get("status") == "error" else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
