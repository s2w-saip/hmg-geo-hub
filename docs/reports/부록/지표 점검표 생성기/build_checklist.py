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
from progress import PROGRESS  # noqa: E402

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

# ── merge After survey (API path, measured per endpoint key) ──
AFN = {}  # endpoint key -> {f2..f10, parity} (first surface that measured it)
AFN_NS = {}  # survey key -> {endpoint key -> measurement} (surface-specific)
AFTER_DIR = os.path.join(SURVEY_DIR, "after")
AFTER_COMMON = {"existing3": "AXCOMMON", "global": "AGCOMMON", "website": "AWCOMMON", "project": "APCOMMON",
                "project_ops_interest": "AICOMMON", "admin": "AACOMMON", "qa_nonscreen": "AQCOMMON"}
AFTER_KEY_OVERRIDE = {}  # (route, label) -> [endpoint keys]
after_conflicts = []
for key in SURVEY_ORDER:
    pth = os.path.join(AFTER_DIR, key + ".json")
    if not os.path.exists(pth):
        AFTER_COMMON.pop(key, None)
        continue
    d = json.load(open(pth, encoding="utf-8"))
    for cid, v in d.get("new_constants", {}).items():
        if cid in K and tuple(K[cid]) != tuple(v):
            after_conflicts.append(f"constant {cid} ({key})")
            continue
        K[cid] = tuple(v)
    AFN_NS[key] = d.get("endpoints", {})
    for ek, v in AFN_NS[key].items():
        AFN.setdefault(ek, v)
    for ak in d.get("area_keys", []):
        AFTER_KEY_OVERRIDE[(ak["route"], ak["label"])] = ak["api_keys"]
    if AFTER_COMMON.get(key) not in AFN:
        AFTER_COMMON.pop(key, None)
_pr = os.path.join(AFTER_DIR, "_parity_results.json")  # ref -> pass | fail | missing | skipped (test runs)
PARITY = json.load(open(_pr, encoding="utf-8")) if os.path.exists(_pr) else {}
_fx = os.path.join(AFTER_DIR, "_fixes.json")  # corrections for fixes made after the agents measured
if os.path.exists(_fx):
    for ak in json.load(open(_fx, encoding="utf-8")).get("area_keys", []):
        AFTER_KEY_OVERRIDE[(ak["route"], ak["label"])] = ak["api_keys"]
for s_ in SCREENS:  # noqa: F821
    s_["acommon"] = AFTER_COMMON.get(s_.get("survey", "existing3"))
    s_["ans"] = s_.get("survey", "existing3")
    s_["areas"] = [a[:5] + (AFTER_KEY_OVERRIDE.get((s_["route"], a[1]), a[5]),) + a[6:] for a in s_["areas"]]
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
    return judge(FN, area_fns(fns, common, write), factor)


def judge(table, fns, factor):
    missing = [f for f in fns if f not in table]
    if missing:
        return "u", "정의 없음"
    key = factor.lower()
    vals = {f: table[f].get(key) for f in fns}
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


def after_cell(keys, factor, acommon, write=False, ns=None):
    """After (API path) verdict for one area from endpoint measurements.
    The screen's own surface measurement wins; another surface's is borrowed only when missing."""
    if factor == "DONE":
        return "n", "legacy 잔존"
    own = [k for k in keys if not str(k).endswith("COMMON")]
    if not own:
        return "x", "API 없음"
    table = dict(AFN)
    table.update(AFN_NS.get(ns, {}))
    if any(k not in table for k in own):
        return "u", "미측정"
    ks = own + ([acommon] if acommon and acommon in table and not write else [])
    if factor == "F5":
        no_test = [k for k in own if not table[k].get("parity")]
        if no_test:
            return "n", f"시험 없음 {len(no_test)}"
        refs = [r for k in own for r in table[k].get("parity")]
        res = [PARITY.get(r) for r in refs]
        if "fail" in res:
            return "n", f"시험 실패 {res.count('fail')}"
        if not PARITY or any(x in (None, "missing", "skipped") for x in res):
            return "u", "시험 있음·미실행" if not PARITY else "일부 시험 미확인"
        return "y", f"시험 통과 {len(res)}"
    if factor == "F10":
        vals = [table[k].get("f10") for k in ks]
        if any(v is None for v in vals):
            return "u", ""
        app = [v for v in vals if v[0] != "skip"]
        if not app:
            return "x", ""
        return ("n" if any(v[0] == "n" for v in app) else "y"), ""
    return judge(table, ks, factor)


esc = html.escape
SYM = {"y": '<span class="y">☑</span>', "n": '<span class="n">☒</span>', "u": '<span class="u">☐</span>', "x": '<span class="x">—</span>'}
work_by_route = {}
for w in WORK:
    for t in w[3]:
        work_by_route.setdefault(t, []).append(w[0])

rows = []
screen_blocks = []
counts = {"y": 0, "n": 0, "u": 0}
side_counts = {"B": {"y": 0, "n": 0, "u": 0}, "A": {"y": 0, "n": 0, "u": 0}}
used_fns, commons = [], []
n_areas = n_screens = 0
NCOL = 5 + 2 + 2 * len(FACTORS)


def tally(side, v):
    if v != "x":
        counts[v] += 1
        side_counts[side][v] += 1


SYMTXT = {"y": "☑", "n": "☒", "u": "☐", "x": "—"}
AFTER_ONLY_F = {"F5", "F10", "DONE"}


def pair_cell(vb, tb, va, ta, f):
    """One factor cell: Before → After (After-only factors show the After symbol only); tint = After."""
    tip = (f"After: {SYMTXT[va]} {ta}".strip() if f in AFTER_ONLY_F
           else f"Before: {SYMTXT[vb]} {tb}".strip() + "  →  " + f"After: {SYMTXT[va]} {ta}".strip())
    inner = SYM[va] if f in AFTER_ONLY_F else f'{SYM[vb]}<span class="arr">→</span>{SYM[va]}'
    return f'<td class="pc t{va}" title="{esc(tip)}">{inner}</td>'


def count_cell(cb, ca, f):
    """Screen row: number of ☒ areas, Before → After."""
    def part(c):
        judged = c["y"] + c["n"]
        if c["n"]:
            return f'<span class="n">{c["n"]}</span>', judged
        if judged:
            return '<span class="y">☑</span>', judged
        return ('<span class="u">☐</span>' if c["u"] else '<span class="x">—</span>'), judged
    pb, jb = part(cb)
    pa, ja = part(ca)
    tint = "n" if ca["n"] else ("y" if ja else ("u" if ca["u"] else "x"))
    tip = (f"After ☒ {ca['n']} / 판정 {ja}" if f in AFTER_ONLY_F
           else f"Before ☒ {cb['n']} / 판정 {jb}  →  After ☒ {ca['n']} / 판정 {ja}")
    inner = pa if f in AFTER_ONLY_F else f'{pb}<span class="arr">→</span>{pa}'
    return f'<td class="pc cnt t{tint}" title="{esc(tip)}">{inner}</td>'


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
    flag = str(s["flag"])
    m = re.match(r"^(?:HGH_SOURCE_)?(G[0-9]+|SESSION)(.*)$", flag)
    flag_txt = f"HGH_SOURCE_{m.group(1)}{m.group(2)}" if m else flag
    sidx = len(screen_blocks)
    area_rows = []
    agg = {f: {"B": {"y": 0, "n": 0, "u": 0, "x": 0}, "A": {"y": 0, "n": 0, "u": 0, "x": 0}} for f in FACTORS}
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
            va, ta = after_cell(a_keys, f, s.get("acommon"), dlabel == "쓰기", s.get("ans"))
            tally("B", vb)
            tally("A", va)
            agg[f]["B"][vb] += 1
            agg[f]["A"][va] += 1
            cells.append(pair_cell(vb, tb, va, ta, f))
        api_txt = api if isinstance(api, str) else ", ".join(api)
        sub = " · ".join(x for x in (loc, note) if x)
        tip = f"legacy: {legacy}\nAPI: {api_txt}"
        area_rows.append(
            f'<tr class="block"><td class="indent" title="{esc(tip)}">{esc(label)}<span class="val">{esc(sub)}</span></td>'
            f'<td class="pc tx"><span class="x">—</span></td>{"".join(cells)}</tr>')

    cnt_cells = "".join(count_cell(agg[f]["B"], agg[f]["A"], f) for f in FACTORS)
    f1_tip = f"Before: {SYMTXT[b]} {re.sub('<[^>]+>', '', str(bval))}  →  After: {SYMTXT[a1]} {'배포 전 미측정' if a1 == 'u' else ''}"
    f1_cell = f'<td class="pc t{a1}" title="{esc(f1_tip)}">{SYM[b]}<span class="arr">→</span>{SYM[a1]}</td>'
    route_txt = f'<code>{esc(s["route"])}</code>' if not nonscreen else ""
    scr_tip = f"화면 제목: {s['title']}\n플래그: {flag_txt}\n영역 {len(s['areas'])}개" + (f"\n관련 작업: {', '.join(wrefs)}" if wrefs else "")
    screen_row = (
        f'<tr class="screen" onclick="toggleScreen({sidx})"><td title="{esc(scr_tip)}">{esc(s["name"])} <span class="muted small">({len(s["areas"])})</span>'
        f'<span class="val">{esc(s["menu"])} {route_txt}</span></td>'
        f'{f1_cell}{cnt_cells}</tr>')
    screen_blocks.append(f'<tbody class="scr" id="scr-{sidx}">\n' + screen_row + "\n" + "\n".join(area_rows) + "\n</tbody>")


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
        wjudge = '<span class="tag del">점검표 밖</span>'
    else:
        w_in += 1
        wjudge = '<span class="tag ok">판정</span>' if in_table else '<span class="tag fix">층 단위</span>'
    ftxt = " · ".join(esc(f.replace("DONE", "완료")) for f in factors)
    wrows.append(f'<tr><td class="id">{wid}</td><td class="small">{esc(title)}</td><td class="small">{esc(docs)}</td><td class="small">{"<br>".join(tnames)}</td><td class="small">{esc(status)}</td><td class="small">{ftxt}</td><td>{wjudge}</td></tr>')

ST = {"done": ("☑ 완료", "done"), "doing": ("◐ 진행 중", "doing"), "next": ("☐ 다음", "next"), "decide": ("⚠ 결정 필요", "decide")}
prow = []
for st, title, target, note in PROGRESS:
    lab, cls = ST[st]
    prow.append(f'<tr class="{cls}"><td class="st">{lab}</td><td><strong>{esc(title)}</strong></td><td class="small">{esc(target)}</td><td class="small muted">{esc(note)}</td></tr>')
n_done = sum(1 for x in PROGRESS if x[0] == "done")
n_next = sum(1 for x in PROGRESS if x[0] == "next")
n_dec = sum(1 for x in PROGRESS if x[0] == "decide")
n_doing = sum(1 for x in PROGRESS if x[0] == "doing")
progress_html = (f'<section>\n<h2>진행 현황 <span class="muted small">완료 {n_done} · 진행 중 {n_doing} · 다음 {n_next} · 결정 필요 {n_dec}</span></h2>\n'
                 '<div class="scroll"><table class="progress"><thead><tr><th>상태</th><th>항목</th><th>대상 · 판정 요소</th><th>비고</th></tr></thead><tbody>\n'
                 + "\n".join(prow) + '\n</tbody></table></div>\n</section>')

total = sum(counts.values())
TEMPLATE = open(TEMPLATE_PATH, encoding="utf-8").read()
out = TEMPLATE
for k, v in {
    "{{ROWS}}": "\n".join(screen_blocks), "{{PROGRESS}}": progress_html, "{{BEFORE_ROWS}}": "\n".join(brows), "{{K_ROWS}}": "\n".join(krows),
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
print("after: endpoints", len(AFN), "by surface", {k: len(v) for k, v in AFN_NS.items()}, "commons", sorted(set(AFTER_COMMON.values())), "conflicts", after_conflicts[:10])
unmeasured_after = sorted({k for s in SCREENS for a in s["areas"] for k in a[5] if k not in AFN and not str(k).endswith("COMMON")})  # noqa: F821
print("after keys without measurement:", len(unmeasured_after), unmeasured_after[:15])
missing = sorted({f for s in SCREENS for a in s["areas"] for f in a[6] if f not in FN})  # noqa: F821
print("undefined fns:", missing)
unmeasured = [f for f in used_fns if f in FN and any(FN[f].get(k) is None for k in ("f2", "f4", "f6", "f7", "f8", "f9"))]
print("fns with unmeasured factors:", len(unmeasured), unmeasured[:30])
