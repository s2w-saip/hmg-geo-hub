"""Build ★ 리뉴얼·최적화 지표 점검표.html (v3: all screens, F1–F10 + 완료, work items).

Area check rule: ☑ only when every input passes; ☒ when any input fails; otherwise ☐.
Before inputs = the legacy functions the area calls + its surface common path. After inputs = API data keys (DATA).
Data: before_data.py (first 3 screens, legacy measurements, constants K), screens_def.py (first 3 screens),
      조사 데이터/*.json (survey of the other screens + F7–F9 patch), work_items.py (documented work items).
usage: python -I build_checklist.py [out.html] [template.html]
  default out = workspace root "★ 리뉴얼·최적화 지표 점검표.html" (repo/../), default template = sibling file.
"""
import glob
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from before_data import FN, K  # noqa: E402
from work_items import WORK  # noqa: E402

REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(REPO), "★ 리뉴얼·최적화 지표 점검표.html")
TEMPLATE_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "checklist_template.html")

exec(open(os.path.join(HERE, "screens_def.py"), encoding="utf-8").read())  # defines SCREENS (first 3)
for s in SCREENS:  # noqa: F821
    s.setdefault("common", "COMMON")

# ── merge survey data ──
SURVEY_DIR = os.path.join(HERE, "조사 데이터")
SURVEY_ORDER = ["existing3", "global", "website", "project", "project_ops_interest", "admin", "qa_nonscreen"]
survey_files = {os.path.splitext(os.path.basename(p))[0]: p for p in glob.glob(os.path.join(SURVEY_DIR, "*.json"))}
by_name = {s["name"]: s for s in SCREENS}  # noqa: F821
for key in SURVEY_ORDER:
    if key not in survey_files:
        continue
    d = json.load(open(survey_files[key], encoding="utf-8"))
    for cid, v in d.get("new_constants", {}).items():
        assert cid not in K, f"constant id clash {cid}"
        K[cid] = tuple(v)
    for fid, v in d.get("functions", {}).items():
        assert fid not in FN, f"function id clash {fid} ({key})"
        FN[fid] = v
    for fid, patch in d.get("functions_patch", {}).items():
        FN[fid].update(patch)
    for wa in d.get("write_areas", []):
        by_name[wa["screen"]]["areas"].append(
            (wa["loc"], wa["label"], wa.get("note", ""), wa["legacy_call"], wa["api_call"], wa.get("api_keys", []), wa["legacy_fns"], "쓰기"))
    prefix = d.get("prefix", "")
    for sc in d.get("screens", []):
        explicit = any(f.endswith("COMMON") for a in sc["areas"] for f in a["legacy_fns"])
        common = None if explicit else (prefix + "COMMON" if prefix and (prefix + "COMMON") in FN else None)
        nonscreen = sc.get("route") in ("—", "", None)
        SCREENS.append({  # noqa: F821
            "name": sc["name"], "menu": sc["menu"], "title": sc["title"], "route": sc["route"], "flag": sc.get("flag", "—"),
            "p": "—", "f1b": ("x", "해당 없음") if nonscreen else ("u", "미측정"), "common": common, "survey": key,
            "areas": [(a["loc"], a["label"], a.get("note", ""), a["legacy_call"], a["api_call"], a.get("api_keys", []),
                       a["legacy_fns"], "쓰기" if a["label"].startswith("쓰기") else "") for a in sc["areas"]],
        })

# After (API) verdicts per (data key, factor). Absent = unknown (☐).
DATA = {
    ("S01", "F2"): "y", ("S01", "F3"): "n",
    ("S02", "F2"): "y", ("S02", "F3"): "y",
    ("S03", "F2"): "n", ("S03", "F3"): "n",
}
FACTORS = ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "DONE"]
AFTER_ONLY = {"F5", "F10", "DONE"}


def score(f2):
    return f2[0] + f2[1] + f2[2] + f2[3]


def area_fns(fns, common, write=False):
    out = list(fns)
    if common and common not in out and not write:
        out.append(common)
    return [f for f in out if f in FN] + [f for f in out if f not in FN]


def before_cell(fns, factor, common, write=False):
    if factor in AFTER_ONLY:
        return "x", ""
    fns = area_fns(fns, common, write)
    missing = [f for f in fns if f not in FN]
    if missing:
        return "u", "정의 없음"
    key = factor.lower()
    vals = {f: FN[f].get(key) for f in fns}
    if factor == "F2":
        if any(v is None for v in vals.values()):
            return "u", "미측정 포함"
        scores = [score(v) for v in vals.values() if v[0] != "skip"]
        if not scores:
            return "x", ""
        m = max(scores)
        return ("n" if m > 5 else "y"), f"최대 {m}"
    if factor == "F4":
        if any(v is None for v in vals.values()):
            return "u", ""
        ids = set()
        for v in vals.values():
            ids.update(v)
        w = sum(K[i][2] for i in ids if i in K)
        unknown = [i for i in ids if i not in K]
        return ("n" if w or unknown else "y"), f"{w}종" + (f" +{len(unknown)}?" if unknown else "")
    if any(v is None for v in vals.values()):
        return "u", ""
    app = {f: v for f, v in vals.items() if v[0] != "skip"}
    if not app:
        return "x", ""
    if factor == "F6":
        is_c = lambda f: f.endswith("COMMON")  # noqa: E731
        own = [f for f, v in app.items() if not is_c(f) and v[0] == "n"]
        com = [f for f, v in app.items() if is_c(f) and v[0] == "n"]
        if own:
            return "n", "자체+공통" if com else "자체"
        if com:
            return "n", "공통만"
        return "y", ""
    if factor == "F8":
        bad = [f for f, v in app.items() if v[0] == "n"]
        return ("n", f"{len(bad)}건") if bad else ("y", "")
    bad = any(v[0] == "n" for v in app.values())
    return ("n" if bad else "y"), ""


def after_cell(keys, factor):
    vals = [DATA.get((d, factor)) for d in keys]
    if "n" in vals:
        return "n"
    if vals and all(v == "y" for v in vals):
        return "y"
    return "u"


esc = html.escape
SYM = {"y": '<span class="y">☑</span>', "n": '<span class="n">☒</span>', "u": '<span class="u">☐</span>', "x": '<span class="x">—</span>'}
work_by_route = {}
for w in WORK:
    for t in w[3]:
        work_by_route.setdefault(t, []).append(w[0])

rows = []
counts = {"y": 0, "n": 0, "u": 0}
side_counts = {"B": {"y": 0, "n": 0, "u": 0}, "A": {"y": 0, "n": 0, "u": 0}}
used_fns, commons = [], []
n_areas = n_screens = 0
NCOL = 5 + 2 + 2 * len(FACTORS)


def tally(side, v):
    if v != "x":
        counts[v] += 1
        side_counts[side][v] += 1


for s in SCREENS:  # noqa: F821
    nonscreen = s["route"] in ("—", "", None)
    if not nonscreen:
        n_screens += 1
    b, bval = s["f1b"]
    a1 = "x" if nonscreen else "u"
    tally("B", b)
    tally("A", a1)
    if s.get("common") and s["common"] not in commons:
        commons.append(s["common"])
    wrefs = work_by_route.get(s["route"], [])
    wtxt = f'<span class="val">관련 작업: {", ".join(wrefs)}</span>' if wrefs else ""
    route_html = f'<code>{esc(s["route"])}</code>' if not nonscreen else "—"
    flag = str(s["flag"])
    m = re.match(r"^(?:HGH_SOURCE_)?(G[0-9]+|SESSION)(.*)$", flag)
    flag_html = f'<code>HGH_SOURCE_{m.group(1)}</code>{esc(m.group(2))}' if m else esc(flag)
    rows.append(
        f'<tr class="screen"><td>{esc(s["name"])}<span class="val">화면 제목: {esc(s["title"])}</span>{wtxt}</td>'
        f'<td class="route">메뉴: <strong>{esc(s["menu"])}</strong></td>'
        f'<td class="route" colspan="2">{route_html}<span class="val">플래그 {flag_html} · 근거 {s["p"]}</span></td>'
        f'<td class="small route">영역 {len(s["areas"])}개</td>'
        f'<td class="ck b">{SYM[b]}<span class="val">{bval}</span></td><td class="ck a">{SYM[a1]}</td>'
        f'<td colspan="{2 * len(FACTORS)}"></td></tr>')
    for loc, label, note, legacy, api, a_keys, b_fns, dlabel in s["areas"]:
        n_areas += 1
        for f in b_fns:
            if f.endswith("COMMON"):
                if f not in commons:
                    commons.append(f)
            elif f not in used_fns:
                used_fns.append(f)
        cells = []
        for f in FACTORS:
            vb, tb = before_cell(b_fns, f, s.get("common"), dlabel == "쓰기")
            va = after_cell(a_keys, f)
            tally("B", vb)
            tally("A", va)
            tb_html = f'<span class="val">{tb}</span>' if tb else ""
            cells.append(f'<td class="ck b">{SYM[vb]}{tb_html}</td><td class="ck a">{SYM[va]}</td>')
        note_html = f'<span class="val">{esc(note)}</span>' if note else ""
        api_txt = api if isinstance(api, str) else ", ".join(api)
        rows.append(
            f'<tr class="block"><td class="indent">{esc(label)}{note_html}</td><td class="small loc">{esc(loc)}</td><td class="small call">{esc(legacy)}</td><td class="small call">{esc(api_txt)}</td><td class="small">{esc(dlabel or "—")}</td>'
            f'<td colspan="2" class="ck"><span class="x">—</span></td>{"".join(cells)}</tr>')


def fmt_flag(v, ok_sym=None):
    if v is None:
        return "", "u"
    return esc(str(v[1])) if len(v) > 1 else "", ("x" if v[0] == "skip" else v[0])


EXTRA_FNS = []  # measured functions not attached to any area
brows = []
for f in used_fns + [e for e in EXTRA_FNS if e not in used_fns] + commons:
    if f not in FN:
        brows.append(f'<tr><td class="small"><code>{esc(f)}</code></td><td colspan="15" class="small na">정의 없음 (조사 데이터 누락)</td></tr>')
        continue
    d = FN[f]
    f2 = d.get("f2")
    if f2 is None:
        f2_txt, f2_sym = "미측정", "u"
    elif f2[0] == "skip":
        f2_txt, f2_sym = esc(str(f2[1])), "x"
    else:
        sc = score(f2)
        f2_txt = f'<strong>{sc}</strong> = J{f2[0]} + C{f2[1]} + 집계{f2[2]} + 윈도우{f2[3]}<span class="val">{esc(str(f2[4]))}</span>'
        f2_sym = "n" if sc > 5 else "y"
    f3_txt, f3_sym = fmt_flag(d.get("f3"))
    f4 = d.get("f4")
    if f4 is None:
        f4_sym, f4_txt = "u", "미측정"
    else:
        w = sum(K[i][2] for i in set(f4) if i in K)
        f4_sym = "n" if f4 else "y"
        f4_txt = f'<strong>{w}종</strong><span class="val">{esc(" ".join(sorted(set(f4))))}</span>'
    f6_txt, f6_sym = fmt_flag(d.get("f6"))
    f7_txt, f7_sym = fmt_flag(d.get("f7"))
    f8 = d.get("f8")
    f8_txt, f8_sym = fmt_flag(f8)
    if f8 and len(f8) > 2 and str(f8[2]).strip():
        f8_txt = f'문장 {esc(str(f8[2]))}' + (f'<span class="val">{f8_txt}</span>' if f8_txt else "")
    f9_txt, f9_sym = fmt_flag(d.get("f9"))
    brows.append(
        f'<tr><td class="small"><code>{esc(str(d.get("label", f)))}</code><span class="val">{esc(f)} · {esc(str(d.get("where", "")))}</span></td>'
        f'<td class="small">{esc(str(d.get("stmts", "")))}</td>'
        f'<td class="small">{f2_txt}</td><td class="ck b">{SYM[f2_sym]}</td>'
        f'<td class="small">{f3_txt}</td><td class="ck b">{SYM[f3_sym]}</td>'
        f'<td class="small">{f4_txt}</td><td class="ck b">{SYM[f4_sym]}</td>'
        f'<td class="small">{f6_txt}</td><td class="ck b">{SYM[f6_sym]}</td>'
        f'<td class="small">{f7_txt}</td><td class="ck b">{SYM[f7_sym]}</td>'
        f'<td class="small">{f8_txt}</td><td class="ck b">{SYM[f8_sym]}</td>'
        f'<td class="small">{f9_txt}</td><td class="ck b">{SYM[f9_sym]}</td></tr>')

krows = []
for i, (lab, where, w, vals) in K.items():
    krows.append(f'<tr><td class="id">{esc(i)}</td><td><code>{esc(str(lab))}</code></td><td class="small"><code>{esc(str(where))}</code></td><td class="small">{w}</td><td class="small">{esc(str(vals))}</td></tr>')

route_name = {s["route"]: s["name"] for s in SCREENS}  # noqa: F821
wrows = []
w_in = w_out = 0
for wid, title, docs, targets, status, factors in WORK:
    tnames = []
    for t in targets:
        if t.startswith("@"):
            tnames.append(f'<code>{esc(t[1:])}</code>')
        elif t in route_name:
            tnames.append(esc(route_name[t]))
        else:
            tnames.append(f'<span class="na">{esc(t)} (표에 없음)</span>')
    outside = all(f.startswith("밖:") for f in factors)
    in_table = any(t in route_name for t in targets) and not outside
    if outside:
        w_out += 1
        judge = '<span class="tag del">점검표 밖</span>'
    else:
        w_in += 1
        judge = '<span class="tag ok">판정</span>' if in_table else '<span class="tag fix">층 단위</span>'
    ftxt = " · ".join(esc(f.replace("DONE", "완료")) for f in factors)
    wrows.append(f'<tr><td class="id">{wid}</td><td class="small">{esc(title)}</td><td class="small">{esc(docs)}</td><td class="small">{"<br>".join(tnames)}</td><td class="small">{esc(status)}</td><td class="small">{ftxt}</td><td>{judge}</td></tr>')

total = sum(counts.values())
TEMPLATE = open(TEMPLATE_PATH, encoding="utf-8").read()
out = TEMPLATE
for k, v in {
    "{{ROWS}}": "\n".join(rows), "{{BEFORE_ROWS}}": "\n".join(brows), "{{K_ROWS}}": "\n".join(krows),
    "{{WORK_ROWS}}": "\n".join(wrows), "{{N_WORK}}": str(len(WORK)), "{{N_WORK_IN}}": str(w_in), "{{N_WORK_OUT}}": str(w_out),
    "{{N_FNS}}": str(len(used_fns)), "{{N_AREAS}}": str(n_areas), "{{N_SCREENS}}": str(n_screens),
    "{{Y}}": str(counts["y"]), "{{N}}": str(counts["n"]), "{{U}}": str(counts["u"]), "{{TOTAL}}": str(total),
    "{{NB}}": str(side_counts["B"]["n"]), "{{NA}}": str(side_counts["A"]["n"]),
    "{{UB}}": str(side_counts["B"]["u"]), "{{UA}}": str(side_counts["A"]["u"]), "{{YB}}": str(side_counts["B"]["y"]),
}.items():
    out = out.replace(k, v)
assert "{{" not in out, out[out.index("{{"):out.index("{{") + 40]
open(OUT, "w", encoding="utf-8", newline="\n").write(out)
print("screens", n_screens, "areas", n_areas, "fns", len(used_fns), "commons", commons, "counts", counts, "total", total, "by side", side_counts)
print("work items: in", w_in, "outside", w_out)
missing = sorted({f for s in SCREENS for a in s["areas"] for f in a[6] if f not in FN})  # noqa: F821
print("undefined fns:", missing)
unmeasured = [f for f in used_fns if f in FN and any(FN[f].get(k) is None for k in ("f2", "f4", "f6", "f7", "f8", "f9"))]
print("fns with unmeasured factors:", len(unmeasured), unmeasured[:30])
