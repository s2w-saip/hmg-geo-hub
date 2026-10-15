#!/usr/bin/env python3
"""합성 DB 위 백엔드 응답 시간 측정(로컬 127.0.0.1 만, 표준 라이브러리만).

synth-db.sh api(백엔드)와 mock auth(synth-db.sh demo 또는 front/e2e/mock-auth)가 떠 있어야 한다.
화면이 여는 대표 읽기 API 를 스냅샷(기본)·기간(--weeks 주) 두 모양으로 부르고, 첫 호출(콜드)과 이어진 N회의 중앙값(웜)을 잰다.
결과 캐시(HGH_RESULT_CACHE)는 synth-db.sh api 가 켜지 않으므로 웜 = DB·OS 캐시만 데운 값이다.
사용: python perf.py [--api http://127.0.0.1:18090] [--auth http://127.0.0.1:54599] [--repeat 3] [--weeks 12] [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request

# (이름, 경로, 질의) — 화면 묶음 G1 대시보드 · G2 답변 분석 · G3 웹사이트 · G4 퍼널 · G5 프롬프트
CASES = [
    ("G1 KPI 요약", "/v1/kpi/summary", {"surface": "global"}),
    ("G1 KPI 비교(경쟁)", "/v1/kpi/compare", {"surface": "global"}),
    ("G1 엔진별", "/v1/kpi/engines", {"surface": "global"}),
    ("G1 추이", "/v1/trend", {"surface": "global"}),
    ("G2 언급 브랜드", "/v1/mentions/brands", {"surface": "global"}),
    ("G2 언급 프롬프트(브랜드)", "/v1/mentions/prompts", {"surface": "global", "mode": "brand", "mention_brand": "Toyota"}),
    ("G2 언급 유형", "/v1/mentions/types", {"surface": "global"}),
    ("G2 인용 도메인", "/v1/citations/domains", {"surface": "global"}),
    ("G2 인용 출처", "/v1/citations/sources", {"surface": "global"}),
    ("G3 자사 인용 프롬프트", "/v1/citations/prompts", {"surface": "website", "owned": "true"}),
    ("G2 답변 목록", "/v1/answers", {"surface": "global", "limit": "50"}),
    ("G3 웹사이트 KPI", "/v1/kpi/summary", {"surface": "website"}),
    ("G3 웹사이트 타겟", "/v1/citations/targets", {"surface": "website"}),
    ("G4 ACR", "/v1/funnel/acr", {"surface": "global"}),
    ("G5 프롬프트", "/v1/prompts", {"surface": "global"}),
    ("필터 옵션", "/v1/filters/options", {"surface": "global"}),
]


def token(auth: str, email: str, password: str) -> str:
    req = urllib.request.Request(f"{auth}/auth/v1/token?grant_type=password", method="POST",
                                 data=json.dumps({"email": email, "password": password}).encode(),
                                 headers={"content-type": "application/json", "apikey": "e2e-anon"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["access_token"]


def call(api: str, path: str, q: dict, tok: str) -> tuple[int, float, int]:
    url = f"{api}{path}?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        body, code = e.read(), e.code
    return code, (time.perf_counter() - t0) * 1000, len(body)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default="http://127.0.0.1:18090")
    ap.add_argument("--auth", default="http://127.0.0.1:54599")
    ap.add_argument("--email", default="t-admin@example.test")
    ap.add_argument("--password", default="e2e-pass")   # mock auth 전용 상수(front/e2e/accounts.json)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--weeks", type=int, default=12, help="기간 모양의 길이(as_of 기준 과거 주 수)")
    ap.add_argument("--asof", default="2026-10-05", help="기간 끝 날짜(최신 공개 회차)")
    ap.add_argument("--json")
    a = ap.parse_args()
    tok = token(a.auth, a.email, a.password)
    end = a.asof
    start = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(end, "%Y-%m-%d")) - a.weeks * 7 * 86400))
    rows = []
    print(f"{'케이스':22s} {'모양':8s} {'코드':>4s} {'콜드ms':>8s} {'웜ms':>8s} {'바이트':>9s}")
    for name, path, q in CASES:
        for shape, extra in (("snapshot", {}), (f"{a.weeks}주", {"from": start, "to": end})):
            qq = dict(q, **extra)
            code, cold, size = call(a.api, path, qq, tok)
            warm = statistics.median(call(a.api, path, qq, tok)[1] for _ in range(a.repeat)) if a.repeat else cold
            rows.append({"case": name, "path": path, "query": qq, "code": code, "cold_ms": round(cold), "warm_ms": round(warm),
                         "bytes": size})
            print(f"{name:22s} {shape:8s} {code:>4d} {cold:>8.0f} {warm:>8.0f} {size:>9,d}")
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"api": a.api, "repeat": a.repeat, "weeks": a.weeks, "rows": rows}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
