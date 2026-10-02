#!/usr/bin/env python3
"""지연 요약: latency.jsonl(콜드 1 + 웜 7) → latency.tsv, EXPLAIN 요약 → explain-summary.tsv, 동시성 → concur.tsv, 요약 md.
사용: latsum.py <latency-res-dir>"""
import json
import statistics
import sys
from collections import defaultdict

D = sys.argv[1]


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


lat = defaultdict(lambda: {"cold": None, "warm": [], "stmt_cold": None, "err": None})
for l in open(f"{D}/latency.jsonl"):
    r = json.loads(l)
    k = (r["combo_id"], r["feature"])
    if "error" in r:
        lat[k]["err"] = r["error"]
        continue
    if r["cold"]:
        lat[k]["cold"] = r["ms"]
        lat[k]["stmt_cold"] = r.get("stmt_ms")
    else:
        lat[k]["warm"].append(r["ms"])

ex = {}
for l in open(f"{D}/latency-explain.jsonl"):
    r = json.loads(l)
    ex[(r["combo_id"], r["feature"])] = r["plans"]

rows = ["combo\tfeature\tcold_ms\twarm_p50_ms\twarm_p95_ms\twarm_max_ms\tstmts\texec_ms_sum\tscan_rows\tshared_hit\tshared_read\ttemp_blocks\tsort_disk_kb\thash_batches_max\tworkers(launched/planned)\tscan_nodes"]
worst = []
for k in sorted(lat):
    v = lat[k]
    w = v["warm"]
    p = ex.get(k, [])
    agg = {"exec": sum((s.get("exec_ms") or 0) for s in p), "scan": sum(s["scan_rows"] for s in p), "hit": sum(s["shared_hit"] for s in p),
           "read": sum(s["shared_read"] for s in p), "temp": sum(s["temp_read"] + s["temp_written"] for s in p),
           "sortdisk": sum(s["sort_disk_kb"] for s in p), "hb": max([s["hash_batches_max"] for s in p] or [1]),
           "wl": sum(s["workers_launched"] for s in p), "wp": sum(s["workers_planned"] for s in p),
           "nodes": ";".join(n for s in p for n in s["scan_nodes"])[:400]}
    rows.append("\t".join(str(x) for x in [k[0], k[1], v["cold"], round(pct(w, 50), 1) if w else None, round(pct(w, 95), 1) if w else None,
                                           round(max(w), 1) if w else None, len(p), round(agg["exec"], 1), agg["scan"], agg["hit"], agg["read"],
                                           agg["temp"], agg["sortdisk"], agg["hb"], f"{agg['wl']}/{agg['wp']}", agg["nodes"]]))
    worst.append((max([v["cold"] or 0] + w), k, v["cold"], pct(w, 95) if w else None))
open(f"{D}/latency.tsv", "w").write("\n".join(rows) + "\n")

# 동시성
con = defaultdict(list)
cold = defaultdict(list)
errs = 0
for l in open(f"{D}/concur.jsonl"):
    r = json.loads(l)
    if r.get("error"):
        errs += 1
    (cold if r["cold"] else con)[(r["users"], r["combo_id"], r["api"])].append(r["ms"])
crow = ["users\tcombo\tapi\twarm_n\twarm_p50\twarm_p95\twarm_max\tcold_max"]
by_users = defaultdict(list)
by_users_api = defaultdict(list)
for k in sorted(con):
    xs = con[k]
    crow.append("\t".join(str(x) for x in [k[0], k[1], k[2], len(xs), round(pct(xs, 50), 1), round(pct(xs, 95), 1), round(max(xs), 1),
                                           round(max(cold.get(k, [0])), 1)]))
    by_users[k[0]] += xs + cold.get(k, [])
    by_users_api[(k[0], k[2])] += xs + cold.get(k, [])
open(f"{D}/concur.tsv", "w").write("\n".join(crow) + "\n")

L = ["# 지연 요약", "", f"원천: {D}/latency.jsonl · latency-explain.jsonl · concur.jsonl", "",
     "## 기능 × 조합 (ms, 콜드 = 새 백엔드 첫 실행, 웜 7회 p50/p95)", "",
     "| 조합 | " + " | ".join(["F01", "F02", "F03", "F04", "F05", "F06", "F07"]) + " |", "| --- |" + " --- |" * 7]
for c in sorted({k[0] for k in lat}):
    cells = []
    for f in ["F01", "F02", "F03", "F04", "F05", "F06", "F07"]:
        v = lat.get((c, f))
        if not v or v["err"]:
            cells.append("오류" if v else "-")
            continue
        w = v["warm"]
        cells.append(f"{v['cold']:.0f} / {pct(w, 50):.0f} / {pct(w, 95):.0f}")
    L.append(f"| {c} | " + " | ".join(cells) + " |")
L += ["", "셀 = 콜드 / 웜 p50 / 웜 p95", "", "## 1초 초과(콜드 또는 웜 p95)", ""]
over = [(m, k, c, p) for m, k, c, p in sorted(worst, reverse=True) if m > 1000]
L += [f"- {k[0]} {k[1]}: 콜드 {c:.0f}ms, 웜 p95 {p:.0f}ms" for m, k, c, p in over] or ["- 없음"]
L += ["", f"최악 5: " + ", ".join(f"{k[0]} {k[1]} {m:.0f}ms" for m, k, c, p in sorted(worst, reverse=True)[:5]), "",
      "## 동시성 (G-25: 대시보드 첫 렌더 4 API = dates·summary(F01)·compare(F07)·trend(F02), 사용자 N명 동시, 12조합 × 콜드 1 + 웜 7 라운드)", "",
      "| 사용자 | 전체 p50 | 전체 p95 | 최대 | " + " | ".join(f"{a} p95" for a in ["dates", "summary", "compare", "trend"]) + " |",
      "| ---: | ---: | ---: | ---: |" + " ---: |" * 4]
for u in sorted(by_users):
    xs = by_users[u]
    L.append(f"| {u} | {pct(xs, 50):.0f} | {pct(xs, 95):.0f} | {max(xs):.0f} | " +
             " | ".join(f"{pct(by_users_api[(u, a)], 95):.0f}" for a in ["dates", "summary", "compare", "trend"]) + " |")
L += ["", f"동시성 오류 {errs}건"]
open(f"{D}/latency-summary.md", "w").write("\n".join(L) + "\n")
print("\n".join(L))
