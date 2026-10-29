#!/usr/bin/env python3
"""벤치마크(글로벌 평균 · 브랜드 평균) 재산출.

gen-citation-reports.py 의 GLOBAL_AVG / BRAND_AVG 는 발행 리포트 집합의 단순평균이다.
리포트 집합이나 지표 정의가 바뀌면 이 스크립트로 다시 뽑아 상수를 갱신할 것 —
상수와 실제 집합이 어긋나면 리포트의 "글로벌 평균 대비" 서술이 통째로 틀어진다.

사용: python3 scripts/reports/calc-benchmarks.py <extract.json>
"""
import json, sys

DATA = json.load(open(sys.argv[1]))
BR = lambda b: "Hyundai" if b == "Hyundai N" else b

# 벤치마크는 "국가 사이트" 간 비교 기준선이다. 국가 단위가 아닌 서비스 전용
# 사이트는 성격이 달라 평균을 왜곡하므로 제외한다(리포트는 정상 발행하되,
# 자기 자신이 포함되지 않은 국가 사이트 평균과 비교된다).
BENCH_EXCLUDE_CC = {"CPO"}

by = {}
excluded = []
for d in DATA:
    s = d["summary"]
    ans, mp, tc = int(s["answers"]), int(s["mp"]), int(s["tc"])
    if not (ans and mp and tc):
        continue
    if d["cc"] in BENCH_EXCLUDE_CC:
        excluded.append(f'{d["brand"]}/{d["cc"]}/{d["lang"]}')
        continue
    th = sum(1 for p in d["prompts"] if p["target_hit"])
    by.setdefault(BR(d["brand"]), []).append(
        (100 * int(s["oa"]) / ans, 100 * int(s["oc"]) / tc, 100 * th / mp))

avg = lambda v: sum(v) / len(v)
fmt = lambda v: (f'{{"owned": {avg([x[0] for x in v]):.2f}, '
                 f'"share": {avg([x[1] for x in v]):.2f}, '
                 f'"target": {avg([x[2] for x in v]):.2f}}}')

allv = [x for v in by.values() for x in v]
print(f"# 리포트 {len(allv)}건 기준 — gen-citation-reports.py 에 그대로 붙여넣는다")
print(f"GLOBAL_AVG = {fmt(allv)}")
print("BRAND_AVG = {" + ",\n             ".join(
    f'"{b}": {fmt(by[b])}' for b in ("Hyundai", "Kia", "Genesis") if b in by) + "}")
for b in ("Hyundai", "Kia", "Genesis"):
    if b in by:
        print(f"#   {b}: n={len(by[b])}")
if excluded:
    print(f"# 평균 제외({len(excluded)}건, BENCH_EXCLUDE_CC): {', '.join(excluded)}")
