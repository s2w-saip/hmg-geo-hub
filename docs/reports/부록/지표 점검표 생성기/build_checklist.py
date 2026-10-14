"""Build ★ 리뉴얼·최적화 지표 점검표.html (v2: Before measured per legacy function).

Area check rule: ☑ only when every input passes; ☒ when any input fails; otherwise ☐.
Before inputs = the legacy functions the area calls + COMMON. After inputs = API data keys (DATA).
Files: before_data.py (legacy measurements, constants), screens_def.py (screens/areas), checklist_template.html.
usage: python -I build_checklist.py [out.html] [template.html]
  default out = workspace root "★ 리뉴얼·최적화 지표 점검표.html" (repo/../), default template = sibling file.
"""
import html
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from before_data import FN, K  # noqa: E402

REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(REPO), "★ 리뉴얼·최적화 지표 점검표.html")
TEMPLATE_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "checklist_template.html")

# After (API) verdicts per (data, factor). Absent = unknown (☐).
DATA = {
    ("S01", "F2"): "y", ("S01", "F3"): "n",
    ("S02", "F2"): "y", ("S02", "F3"): "y",
    ("S03", "F2"): "n", ("S03", "F3"): "n",
}
FACTORS = ["F2", "F3", "F4", "F5", "F6"]


def score(f2):
    return f2[0] + f2[1] + f2[2] + f2[3]


def before_cell(fns, factor):
    """Return (sym, value text) for the Before side of one area."""
    fns = list(fns) + ["COMMON"]
    if factor == "F5":
        return "x", ""
    if factor == "F2":
        vals = [FN[f]["f2"] for f in fns]
        if any(v is None for v in vals):
            return "u", "미측정 포함"
        scores = [score(v) for v in vals if v[0] != "skip"]
        if not scores:
            return "x", ""
        m = max(scores)
        return ("n" if m > 5 else "y"), f"최대 {m}"
    if factor == "F3":
        vals = [FN[f]["f3"] for f in fns]
        if any(v is None for v in vals):
            return "u", ""
        if any(v[0] == "n" for v in vals):
            return "n", ""
        return "y", ""
    if factor == "F4":
        if any(FN[f]["f4"] is None for f in fns):
            return "u", ""
        ids = set()
        for f in fns:
            ids.update(FN[f]["f4"])
        w = sum(K[i][2] for i in ids)
        return ("n" if w else "y"), f"{w}종"
    if factor == "F6":
        vals = {f: FN[f]["f6"] for f in fns}
        if any(v is None for v in vals.values()):
            return "u", ""
        own = [f for f, v in vals.items() if f != "COMMON" and v[0] == "n"]
        if own:
            return "n", "자체+공통"
        if vals["COMMON"][0] == "n":
            return "n", "공통만"
        return "y", ""
    raise ValueError(factor)


def after_cell(keys, factor):
    vals = [DATA.get((d, factor)) for d in keys]
    if "n" in vals:
        return "n"
    if vals and all(v == "y" for v in vals):
        return "y"
    return "u"


exec(open(os.path.join(HERE, "screens_def.py"), encoding="utf-8").read())

esc = html.escape
SYM = {"y": '<span class="y">☑</span>', "n": '<span class="n">☒</span>', "u": '<span class="u">☐</span>', "x": '<span class="x">—</span>'}

rows = []
counts = {"y": 0, "n": 0, "u": 0}
side_counts = {"B": {"y": 0, "n": 0, "u": 0}, "A": {"y": 0, "n": 0, "u": 0}}
used_fns = []
n_areas = 0
for s in SCREENS:  # noqa: F821 (defined in screens_def.py)
    b, bval = s["f1b"]
    counts[b] += 1; side_counts["B"][b] += 1
    counts["u"] += 1; side_counts["A"]["u"] += 1
    rows.append(
        f'<tr class="screen"><td>{esc(s["name"])}<span class="val">화면 제목: {esc(s["title"])}</span></td>'
        f'<td class="route">메뉴: <strong>{esc(s["menu"])}</strong></td>'
        f'<td class="route" colspan="2"><code>{esc(s["route"])}</code><span class="val">플래그 <code>{s["flag"]}</code> · 근거 {s["p"]}</span></td>'
        f'<td class="small route">영역 {len(s["areas"])}개</td>'
        f'<td class="ck b">{SYM[b]}<span class="val">{bval}</span></td><td class="ck a">{SYM["u"]}</td>'
        f'<td colspan="10"></td></tr>')
    for loc, label, note, legacy, api, a_keys, b_fns, dlabel in s["areas"]:
        n_areas += 1
        for f in b_fns:
            if f not in used_fns:
                used_fns.append(f)
        cells = []
        for f in FACTORS:
            vb, tb = before_cell(b_fns, f)
            va = after_cell(a_keys, f)
            for side, v in (("B", vb), ("A", va)):
                if v != "x":
                    counts[v] += 1; side_counts[side][v] += 1
            tb_html = f'<span class="val">{tb}</span>' if tb else ""
            cells.append(f'<td class="ck b">{SYM[vb]}{tb_html}</td><td class="ck a">{SYM[va]}</td>')
        note_html = f'<span class="val">{esc(note)}</span>' if note else ""
        rows.append(
            f'<tr class="block"><td class="indent">{esc(label)}{note_html}</td><td class="small loc">{esc(loc)}</td><td class="small call">{esc(legacy)}</td><td class="small call">{esc(api)}</td><td class="small">{esc(dlabel)}</td>'
            f'<td colspan="2" class="ck"><span class="x">—</span></td>{"".join(cells)}</tr>')

# Before evidence table (per legacy function)
brows = []
EXTRA_FNS = ["DGA4"]  # measured but not used by any area (hidden fetch)
for f in used_fns + EXTRA_FNS + ["COMMON"]:
    d = FN[f]
    f2 = d["f2"]
    if f2 is None:
        f2_txt, f2_sym = "미측정", "u"
    elif f2[0] == "skip":
        f2_txt, f2_sym = esc(f2[1]), "x"
    else:
        sc = score(f2)
        f2_txt = f'<strong>{sc}</strong> = J{f2[0]} + C{f2[1]} + 집계{f2[2]} + 윈도우{f2[3]}<span class="val">{esc(f2[4])}</span>'
        f2_sym = "n" if sc > 5 else "y"
    f3 = d["f3"]
    f3_sym = "u" if f3 is None else ("x" if f3[0] == "skip" else f3[0])
    f3_txt = "" if f3 is None else esc(f3[1])
    f4 = d["f4"]
    if f4 is None:
        f4_sym, f4_txt = "u", "미측정"
    else:
        w = sum(K[i][2] for i in set(f4))
        f4_sym = "n" if w else "y"
        f4_txt = f'<strong>{w}종</strong><span class="val">{esc(" ".join(sorted(set(f4), key=lambda x: (x[0], x))))}</span>'
    f6 = d["f6"]
    f6_sym = "u" if f6 is None else f6[0]
    f6_txt = "" if f6 is None else esc(f6[1])
    brows.append(
        f'<tr><td class="small"><code>{esc(d["label"])}</code><span class="val">{esc(d["where"])}</span></td>'
        f'<td class="small">{esc(d["stmts"])}</td>'
        f'<td class="small">{f2_txt}</td><td class="ck b">{SYM[f2_sym]}</td>'
        f'<td class="small">{f3_txt}</td><td class="ck b">{SYM[f3_sym]}</td>'
        f'<td class="small">{f4_txt}</td><td class="ck b">{SYM[f4_sym]}</td>'
        f'<td class="small">{f6_txt}</td><td class="ck b">{SYM[f6_sym]}</td></tr>')

krows = []
for i, (lab, where, w, vals) in K.items():
    krows.append(f'<tr><td class="id">{i}</td><td><code>{esc(lab)}</code></td><td class="small"><code>{esc(where)}</code></td><td class="small">{w}</td><td class="small">{esc(vals)}</td></tr>')

total = sum(counts.values())
TEMPLATE = open(TEMPLATE_PATH, encoding="utf-8").read()
out = (TEMPLATE.replace("{{ROWS}}", "\n".join(rows))
       .replace("{{BEFORE_ROWS}}", "\n".join(brows))
       .replace("{{K_ROWS}}", "\n".join(krows))
       .replace("{{N_FNS}}", str(len(used_fns)))
       .replace("{{N_AREAS}}", str(n_areas))
       .replace("{{Y}}", str(counts["y"])).replace("{{N}}", str(counts["n"])).replace("{{U}}", str(counts["u"]))
       .replace("{{TOTAL}}", str(total))
       .replace("{{NB}}", str(side_counts["B"]["n"])).replace("{{NA}}", str(side_counts["A"]["n"]))
       .replace("{{UB}}", str(side_counts["B"]["u"])).replace("{{UA}}", str(side_counts["A"]["u"]))
       .replace("{{YB}}", str(side_counts["B"]["y"])))
assert "{{" not in out, out[out.index("{{"):out.index("{{") + 40]
open(OUT, "w", encoding="utf-8", newline="\n").write(out)
print("areas", n_areas, "fns", len(used_fns), "counts", counts, "total", total, "by side", side_counts)
missing = [f for f in used_fns if FN[f]["f2"] is None or FN[f]["f4"] is None or FN[f]["f6"] is None]
print("unmeasured fns:", missing)
