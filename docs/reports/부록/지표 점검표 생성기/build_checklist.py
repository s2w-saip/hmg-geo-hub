"""Build ★ 리뉴얼·최적화 지표 점검표.html (visible UI items; old F5 is a mandatory gate).

Area check rule: ☑ only when every input passes; ☒ when any input fails; otherwise ☐.
Before inputs = the legacy functions the area calls + its surface common path. After inputs = API data keys (DATA).
Data: before_data.py (first 3 screens, legacy measurements, constants K), screens_def.py (first 3 screens),
      조사 데이터/*.json (survey of the other screens + F7–F9 patch), work_items.py (documented work items),
      visible_items.py (explicit UI splits, source provenance, and technical-only exclusions),
      item_applicability.py + visible_applicability.json (reviewed applicable factors per item).
usage: python -I build_checklist.py [out.html] [template.html]
  default out = workspace root "★ 리뉴얼·최적화 지표 점검표.html" (repo/../), default template = sibling file.
  Topic report HTML files are expected beside the output checklist.
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
from conversion_status import AS_OF, BASIS, BFF_COMMITS, KIND_LABEL, RENEWAL, ROUTE_PATH, done_verdict  # noqa: E402
from visible_items import visible_inventory  # noqa: E402
from item_applicability import applicability, validate_inventory, has_explicit_hardcoding_target  # noqa: E402

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
_fx = os.path.join(AFTER_DIR, "_fixes.json")  # corrections for fixes made after the agents measured
if os.path.exists(_fx):
    _fxd = json.load(open(_fx, encoding="utf-8"))
    for ak in _fxd.get("area_keys", []):
        AFTER_KEY_OVERRIDE[(ak["route"], ak["label"])] = ak["api_keys"]
    # endpoint verdict updates after a fix: {"surface", "endpoint", "set": {"f6": [...], ...}, "by": "<commit>"}
    for es in _fxd.get("endpoint_set", []):
        ns_tab = AFN_NS.setdefault(es["surface"], {})
        if es["endpoint"] not in ns_tab:
            after_conflicts.append(f"fix for unknown endpoint {es['surface']}:{es['endpoint']}")
            continue
        ns_tab[es["endpoint"]] = {**ns_tab[es["endpoint"]], **es["set"]}
        if AFN.get(es["endpoint"]) is not None and es["surface"] == next((k for k, v in AFN_NS.items() if es["endpoint"] in v), None):
            AFN[es["endpoint"]] = ns_tab[es["endpoint"]]
for s_ in SCREENS:  # noqa: F821
    s_["acommon"] = AFTER_COMMON.get(s_.get("survey", "existing3"))
    s_["ans"] = s_.get("survey", "existing3")
    s_["areas"] = [a[:5] + (AFTER_KEY_OVERRIDE.get((s_["route"], a[1]), a[5]),) + a[6:] for a in s_["areas"]]
SOURCE_SCREENS = SCREENS
SCREENS, TECHNICAL_AREAS, ITEM_SOURCES = visible_inventory(SOURCE_SCREENS)
validate_inventory(ITEM_SOURCES)
SOURCE_USAGE = {}
for (route, label), source in ITEM_SOURCES.items():
    key = (route, source[1])
    SOURCE_USAGE[key] = SOURCE_USAGE.get(key, 0) + 1
# F5 is an unconditional compatibility requirement, not an improvement score.
FACTORS = ["F2", "F3", "F4", "F6", "F7", "F8", "F9", "F10", "DONE"]
AFTER_ONLY = {"F10", "DONE"}


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
    if own_factor_applicability(FN, fns, factor) is False:
        return "x", "해당 표시 항목의 직접 경로에는 점검 대상 없음"
    return judge(FN, area_fns(fns, common, write), factor)


def own_factor_applicability(table, keys, factor):
    """Honor explicit skip evidence before adding shared path verdicts.

    Missing measurements are unknown, never evidence of absence. Numeric zero
    (e.g. SQL complexity 0) and a passing check still mean the target exists.
    """
    own = [key for key in keys if not str(key).endswith('COMMON')]
    if not own or factor in {'F4', 'F5', 'DONE'}:
        return None
    values = [table.get(key, {}).get(factor.lower()) for key in own]
    if any(value is None for value in values):
        return None
    return any(value[0] != 'skip' for value in values)


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
    own = [k for k in keys if not str(k).endswith("COMMON")]
    if not own:
        return "x", "API 없음"
    if factor == "DONE":
        return "n", "legacy 잔존"
    table = dict(AFN)
    table.update(AFN_NS.get(ns, {}))
    if any(k not in table for k in own):
        return "u", "미측정"
    if own_factor_applicability(table, own, factor) is False:
        return "x", "해당 표시 항목의 직접 경로에는 점검 대상 없음"
    ks = own + ([acommon] if acommon and acommon in table and not write else [])
    if factor == "F10":
        vals = [table[k].get("f10") for k in ks]
        if any(v is None for v in vals):
            return "u", ""
        app = [v for v in vals if v[0] != "skip"]
        if not app:
            return "x", ""
        return ("n" if any(v[0] == "n" for v in app) else "y"), ""
    return judge(table, ks, factor)


def hardcoding_evidence(table, keys):
    """Return explicit own-path evidence, never the surface's COMMON evidence.

    None means unknown; an empty set is a measured absence. Keep them distinct.
    """
    own = [key for key in keys if not str(key).endswith('COMMON')]
    if not own:
        return None, '조사된 직접 호출 경로 없음'
    if any(key not in table or table[key].get('f4') is None for key in own):
        return None, '하드코딩 조사 근거 미확인'
    ids = {cid for key in own for cid in table[key]['f4']}
    if any(cid not in K for cid in ids):
        return None, '하드코딩 상수 정의 미확인'
    if not ids:
        return set(), '직접 호출 경로에 조사된 하드코딩 없음'
    evidence = '; '.join(f'{cid}: {K[cid][0]}' for cid in sorted(ids))
    return ids, f'직접 호출 경로 근거: {evidence}'


def hardcoding_cells(b_fns, a_keys, ns, shared, explicit_target=False):
    """F4 tracks a removal target, so absence is blank, not a passing check.

    Confirmed absence in Before makes both cells inapplicable.
    A positive grouped finding cannot establish which split child is affected.
    Unassigned grouped evidence stays in the pending register, not in check cells.
    This does not declare the code free of hardcoding.
    A pass is meaningful only when a confirmed Before target has been removed.
    """
    before, tb = hardcoding_evidence(FN, b_fns)
    if before == set():
        return 'x', '', 'x', ''
    if shared and not explicit_target:
        return 'x', '', 'x', ''
    table = dict(AFN)
    table.update(AFN_NS.get(ns, {}))
    after, ta = hardcoding_evidence(table, a_keys)

    def verdict(ids, tip, keys):
        if not any(not str(key).endswith('COMMON') for key in keys):
            return 'x', tip
        if ids is None:
            return 'u', tip
        if not ids:
            return 'x', tip
        if shared:
            return 'u', '기존 묶음에는 하드코딩이 있으나 이 표시 항목에 미치는 영향은 개별 미확인 · ' + tip
        return 'n', tip

    vb, tb = verdict(before, tb, b_fns)
    va, ta = verdict(after, ta, a_keys)
    if vb == 'n' and after == set():
        va, ta = 'y', 'Before에서 확인한 하드코딩 제거됨 · ' + ta
    return vb, tb, va, ta


esc = html.escape
SYM = {"y": '<span class="y">☑</span>', "n": '<span class="n">☒</span>', "u": '<span class="u">☐</span>', "x": '<span class="x">—</span>'}
work_by_route = {}
for w in WORK:
    for t in w[3]:
        work_by_route.setdefault(t, []).append(w[0])

rows = []
screen_blocks = []
f4_pending = {}
counts = {"y": 0, "n": 0, "u": 0}
side_counts = {"B": {"y": 0, "n": 0, "u": 0}, "A": {"y": 0, "n": 0, "u": 0}}
used_fns, commons = [], []
n_areas = n_screens = 0
conversion_tally = {}  # path kind -> {"screens": [menu path], "y"/"n"/"u": DONE items}
assert not {s["route"] for s in SCREENS} - set(ROUTE_PATH), "screen route without a path kind in conversion_status.py"  # noqa: F821


def tally(side, v):
    if v != "x":
        counts[v] += 1
        side_counts[side][v] += 1


SYMTXT = {"y": "☑", "n": "☒", "u": "☐", "x": "—"}
AFTER_ONLY_F = AFTER_ONLY


def pair_cell(vb, tb, va, ta, f):
    """One factor cell: Before → After (After-only factors show the After symbol only); tint = After."""
    sides = [] if f in AFTER_ONLY_F or vb == 'x' else [('Before', vb, tb)]
    if va != 'x':
        sides.append(('After', va, ta))
    if not sides:
        return '<td class="pc tx"></td>'
    tip = '  →  '.join(f'{side}: {SYMTXT[value]} {note}'.strip() for side, value, note in sides)
    inner = '<span class="arr">→</span>'.join(SYM[value] for _, value, _ in sides)
    return f'<td class="pc t{va}" title="{esc(tip)}">{inner}</td>'


def count_cell(cb, ca, f, route=None):
    """Screen row: completed/eligible for DONE (+ the screen's path kind); otherwise number of ☒ areas."""
    if f == 'DONE':
        total = ca['y'] + ca['n'] + ca['u']
        if not total:
            return '<td class="pc cnt tx"></td>'
        completed = ca['y']
        kind, evidence = ROUTE_PATH[route]
        tint = 'y' if completed == total else ('n' if ca['n'] else 'u')
        tip = (f"After 전환 완료 {completed} / 전체 전환 대상 {total}"
               f" · 미완료 {ca['n']} · 미확인 {ca['u']} · 해당 없음은 전체에서 제외"
               f"\n경로: {KIND_LABEL[kind]} · {evidence}")
        return (f'<td class="pc cnt t{tint}" title="{esc(tip)}">'
                f'<span class="{tint}">{completed} / {total}</span><span class="val">{KIND_LABEL[kind]}</span></td>')
    def part(c):
        judged = c["y"] + c["n"]
        if c["n"]:
            return f'<span class="n">{c["n"]}</span>', judged
        if judged:
            return '<span class="y">☑</span>', judged
        return ('<span class="u">☐</span>' if c["u"] else ''), judged
    pb, jb = part(cb)
    pa, ja = part(ca)
    tint = "n" if ca["n"] else ("y" if ja else ("u" if ca["u"] else "x"))
    tip = (f"After ☒ {ca['n']} / 판정 {ja}" if f in AFTER_ONLY_F
           else f"Before ☒ {cb['n']} / 판정 {jb}  →  After ☒ {ca['n']} / 판정 {ja}")
    inner = pa if f in AFTER_ONLY_F else '<span class="arr">→</span>'.join(p for p in (pb, pa) if p)
    if not inner:
        return '<td class="pc cnt tx"></td>'
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
        source_area = ITEM_SOURCES[(s["route"], label)]
        applicable, item_kind = applicability(s['route'], label, source_area[1])
        shared = SOURCE_USAGE[(s["route"], source_area[1])] > 1
        explicit_f4_target = has_explicit_hardcoding_target(s['route'], label)
        f4_scope_pending = (
            'F4' in applicable and shared and not explicit_f4_target
            and hardcoding_evidence(FN, b_fns)[0] != set()
        )
        if f4_scope_pending:
            f4_pending.setdefault((s['menu'], s['route'], source_area[1]), []).append(label)
        for f in b_fns:
            if f.endswith("COMMON"):
                if f not in commons:
                    commons.append(f)
            elif f not in used_fns:
                used_fns.append(f)
        cells = []
        shown_factors = []
        f10_after = 'x'
        for f in FACTORS:
            # Applicability is a gate for every row.
            if f not in applicable:
                vb, tb, va, ta = 'x', '', 'x', ''
            elif f == 'F4' and f in applicable:
                vb, tb, va, ta = hardcoding_cells(b_fns, a_keys, s.get('ans'), shared, explicit_f4_target)
            elif f in applicable:
                vb, tb = before_cell(b_fns, f, s.get("common"), dlabel == "쓰기")
                va, ta = after_cell(a_keys, f, s.get("acommon"), dlabel == "쓰기", s.get("ans"))
            else:
                vb, tb, va, ta = 'x', '', 'x', ''
            if f == 'F10':
                f10_after = va
            if f == 'DONE' and va != 'x':
                # Judged from the screen's current data path (conversion_status.py); no item has a
                # completed mandatory parity check, so nothing is marked converted.
                va, ta = done_verdict(s['route'], f10_after)
            if shared:
                tb += " · 기존 묶음의 공통 근거"
                ta += " · 기존 묶음의 공통 근거"
            tally("B", vb)
            tally("A", va)
            agg[f]["B"][vb] += 1
            agg[f]["A"][va] += 1
            if vb != 'x' or va != 'x':
                shown_factors.append(f)
            cells.append(pair_cell(vb, tb, va, ta, f))
        api_txt = api if isinstance(api, str) else ", ".join(api)
        sub = " · ".join(x for x in (loc, note) if x)
        tip = f"기존 조사 단위: {source_area[1]}\n조건·근거: {source_area[2]}\nlegacy: {legacy}\nAPI: {api_txt}"
        tip += f"\n항목 성격: {item_kind}\n적용 기준: " + (', '.join(f.replace('DONE', '완료') for f in shown_factors) or '해당 없음')
        if f4_scope_pending:
            tip += '\nF4: 항목별 제거 대상 연결 대기. 묶음 상수 기록만 있어 체크하지 않으며, 하드코딩 없음이 검증된 것은 아닙니다.'
        if shared and shown_factors:
            tip += "\n이 항목에 적용되는 기준만 기존 묶음의 판정을 참조합니다. 개별 UI 검증은 별도로 필요합니다."
        badge = '<span class="shared">공통 근거</span>' if shared and shown_factors else ''
        tip = '\n'.join(line.rstrip() for line in tip.split('\n'))
        area_rows.append(
            f'<tr class="block" data-source="{esc(source_area[1])}"><td class="indent" title="{esc(tip)}">{esc(label)}{badge}<span class="val">{esc(sub)}</span></td>'
            f'<td class="pc tx"></td>{"".join(cells)}</tr>')

    cnt_cells = "".join(count_cell(agg[f]["B"], agg[f]["A"], f, s["route"]) for f in FACTORS)
    f1_before = re.sub('<[^>]+>', '', str(bval)) + ' ms' if b in ('y', 'n') else '미측정'
    f1_tip = f"화면 전체의 데이터 로딩 시간 · 재방문 / 첫 방문\nBefore: {f1_before}\nAfter: 미측정\n개별 표시 항목의 F1은 해당 없음"
    f1_cell = (
        f'<td class="pc f1 t{a1}" title="{esc(f1_tip)}">'
        f'<span class="f1-reading"><span class="f1-side">B</span>{SYM[b]}<span>{esc(f1_before)}</span></span>'
        f'<span class="f1-reading"><span class="f1-side">A</span>{SYM[a1]}<span>미측정</span></span></td>'
    ) if not nonscreen else '<td class="pc tx"></td>'
    route_txt = f'<code>{esc(s["route"])}</code>' if not nonscreen else ""
    scr_tip = f"화면 제목: {s['title']}\n플래그: {flag_txt}\n표시 항목 {len(s['areas'])}개" + (f"\n관련 작업: {', '.join(wrefs)}" if wrefs else "")
    menu_path = s["menu"].replace(" › ", " > ")
    # Visibility/access annotations belong to the tooltip, not the menu path.
    menu_path = re.sub(r"\s*\((?:메뉴 숨김[^)]*|beta|하위 페이지|SNB 숨김[^)]*|EcatNav[^)]*|api 전용|GNB 밖)\)", "", menu_path)
    scr_tip += f"\n메뉴 경로·조건: {s['menu']}"
    done_a = agg["DONE"]["A"]
    if done_a["y"] + done_a["n"] + done_a["u"]:
        conv = conversion_tally.setdefault(ROUTE_PATH[s["route"]][0], {"screens": [], "y": 0, "n": 0, "u": 0})
        conv["screens"].append(menu_path)
        for v in "ynu":
            conv[v] += done_a[v]
    screen_row = (
        f'<tr class="screen" onclick="toggleScreen({sidx})"><td title="{esc(scr_tip)}">{esc(menu_path)}'
        f'<span class="val route">{route_txt}</span></td>'
        f'{f1_cell}{cnt_cells}</tr>')
    screen_blocks.append(f'<tbody class="scr" id="scr-{sidx}">\n' + screen_row + "\n" + "\n".join(area_rows) + "\n</tbody>")


f4_pending_rows = []
for (menu, route, source_label), labels in f4_pending.items():
    f4_pending_rows.append(
        f'<tr><td>{esc(menu.replace(" › ", " > "))}<br><code>{esc(route)}</code></td>'
        f'<td>{esc(source_label)}</td><td>{esc(" · ".join(labels))}</td></tr>'
    )


# Keep all original function evidence, including technical-only paths, in the
# appendix. These rows do not contribute to visible-item counts or verdicts.
for s in SOURCE_SCREENS:
    for area in s['areas']:
        for f in area[6]:
            target = commons if f.endswith('COMMON') else used_fns
            if f not in target:
                target.append(f)
    if s.get('common') and s['common'] not in commons:
        commons.append(s['common'])
technical_rows = []
for screen_name, area in TECHNICAL_AREAS:
    loc, label, note, legacy, api, *_ = area
    api_txt = api if isinstance(api, str) else ', '.join(api)
    technical_rows.append(
        f'<tr><td>{esc(screen_name)}</td><td>{esc(label)}<span class="val">{esc(loc)}</span></td>'
        f'<td>{esc(note)}</td><td>{esc(legacy)}</td><td>{esc(api_txt)}</td></tr>')


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

# ── Renewal conversion status: the DONE column by path kind + renewal (/renewal) pages ──
KIND_NOTE = {
    "bff": f"원래 화면을 그대로 그리고 데이터는 <code>/v1/screens</code>로만 읽습니다. 화면 계산은 <code>back/bff/screens</code>로 옮겼고 legacy 분기를 지웠습니다({BFF_COMMITS}). 세션·프로젝트 게이트의 <code>HGH_SOURCE_SESSION</code> 분기는 남아 있습니다.",
    "replaced": "<code>/v1/screens</code>로 읽지만 원래 화면 대신 Gold 직결 간이 화면(GoldProject · SourceAnalytics 등)을 그립니다. 원래 표시 항목이 옮겨지지 않았습니다.",
    "legacy": "<code>HGH_SOURCE_*</code> 분기와 <code>lib/db</code> legacy 경로가 남아 있습니다. 로컬 읽기 전용 모드에서만 API로 고정됩니다.",
}
conv_rows = []
conv_total = {v: 0 for v in "ynu"}
for kind in ("bff", "replaced", "legacy"):
    c = conversion_tally.get(kind)
    if not c:
        continue
    for v in "ynu":
        conv_total[v] += c[v]
    items = c["y"] + c["n"] + c["u"]
    verdict = f'<span class="y">☑ {c["y"]}</span> · <span class="n">☒ {c["n"]}</span> · <span class="u">☐ {c["u"]}</span>'
    conv_rows.append(
        f'<tr><td class="st">{esc(KIND_LABEL[kind])}</td><td class="small">{len(c["screens"])}개 · 항목 {items}</td>'
        f'<td class="small">{verdict}</td><td class="small">{KIND_NOTE[kind]}<span class="val">{esc(" · ".join(c["screens"]))}</span></td></tr>')
conv_all = sum(conv_total.values())
RN_STATE = {"done": '<span class="y">☑ 구현</span>', "wip": '<span class="y">☑ 구현</span><span class="val">작업 트리 · 미커밋</span>',
            "todo": '<span class="u">☐ 미구현</span>'}
rn_rows = []
for area, item, path, state, screens, checked, commits in RENEWAL:
    rn_rows.append(
        f'<tr><td class="small">{esc(area)}</td><td><strong>{esc(item)}</strong><span class="val"><code>{esc(path)}</code></span></td>'
        f'<td class="st small">{RN_STATE[state]}</td><td class="small"><code>{esc(screens)}</code></td>'
        f'<td class="small">{esc(checked)}</td><td class="small muted">{esc(commits)}</td></tr>'.replace('<code></code>', ''))
rn_done = sum(1 for r in RENEWAL if r[3] != "todo")
rn_wip = sum(1 for r in RENEWAL if r[3] == "wip")
renewal_html = (
    f'<section id="renewal-status">\n<h2>리뉴얼 전환 현황 <span class="muted small">{AS_OF} · {esc(BASIS)} 코드 대조</span></h2>\n'
    f'<h3>API 경로 전환 — 화면별 점검표의 ‘완료’ 열 <span class="muted small">전환 완료 {conv_total["y"]} / {conv_all}</span></h3>\n'
    '<p class="small">완료(☑)는 legacy 경로 제거 + API 고정 + 필수 계산·표시 규칙 동일성 검증 + F10 통과가 모두 끝난 항목입니다. '
    '동일성 검증을 마친 항목이 아직 없으므로 완료는 0입니다. 데이터 경로를 옮긴 화면도 F10 ☒ 항목은 ☒, 나머지는 동일성 검증 전이라 ☐입니다. '
    'F10 판정은 BFF 이관 전(<code>56ad6f9</code>)에 측정한 값입니다.</p>\n'
    '<div class="scroll"><table class="renewal"><thead><tr><th>경로 상태</th><th>화면 · 완료 열 항목</th><th>판정</th><th>근거 · 화면</th></tr></thead><tbody>\n'
    + "\n".join(conv_rows) + '\n</tbody></table></div>\n'
    f'<h3>리뉴얼 화면(/renewal) 구현 <span class="muted small">메뉴 항목 {len(RENEWAL)}개 중 구현 {rn_done}(미커밋 {rn_wip}) · 미구현 {len(RENEWAL) - rn_done}</span></h3>\n'
    '<p class="small">리뉴얼 주소는 <code>/ko/renewal</code> + 원래 주소입니다. 리뉴얼 메뉴의 모든 항목은 리뉴얼 화면을 열고, 화면이 없으면 리뉴얼 틀 안에서 ‘미구현’ 안내를 띄웁니다(작업 트리). '
    '리뉴얼 화면은 원래 화면과 같은 BFF 화면을 읽지만, <strong>구현은 위 전환 완료와 별개입니다.</strong> 운영·stg 데이터로 원래 화면과 숫자를 대조한 화면은 아직 없습니다. '
    '메뉴에서 모든 역할에 숨긴 항목(Customer interest · Website ACR)은 뺐습니다.</p>\n'
    '<div class="scroll"><table class="renewal"><thead><tr><th>구역</th><th>메뉴 항목 · 원래 주소</th><th>상태</th><th>리뉴얼 화면 데이터</th><th>확인한 것</th><th>커밋</th></tr></thead><tbody>\n'
    + "\n".join(rn_rows) + '\n</tbody></table></div>\n</section>')

# ── Historical F10 differences: evidence only, no blanket acceptance control ──
F10_PATH = os.path.join(SURVEY_DIR, "f10_differences.json")
f10_html = ""
if os.path.exists(F10_PATH):
    f10 = json.load(open(F10_PATH, encoding="utf-8"))
    themes = {}
    for it in f10["declared"]:
        themes.setdefault(it["theme"], []).append(it)
    blocks = []
    for th, lst in sorted(themes.items(), key=lambda kv: -len(kv[1])):
        trs = []
        for i in lst:
            tip = f"legacy: {i['legacy']}\nAPI: {i['api']}\n근거: {', '.join(i['evidence']) if isinstance(i['evidence'], list) else i['evidence']}"
            imp = {"high": "높음", "medium": "중간", "low": "낮음"}.get(i.get("impact", ""), i.get("impact", ""))
            trs.append(
                f'<tr><td class="id">{esc(i["id"])}</td><td title="{esc(tip)}"><strong>{esc(i["title"])}</strong><span class="val">{esc(i["effect"])}</span></td>'
                f'<td class="small">{esc(imp)}</td><td class="small">{esc(str(i.get("effort", ""))[:40])}</td></tr>')
        blocks.append(
            f'<details class="sec"><summary>{esc(th)} <span class="muted small">기존 기록 {len(lst)}건</span></summary>'
            f'<div class="secbody"><div class="scroll"><table class="f10"><thead><tr><th>ID</th><th>차이 (마우스를 올리면 legacy·API 동작)</th><th>기존 영향 평가</th><th>기존 수정 노력 추정</th></tr></thead><tbody>'
            + "\n".join(trs) + '</tbody></table></div></div></details>')
    # undeclared differences (found by the survey, not in any adapter list)
    UST_PATH = os.path.join(SURVEY_DIR, "f10_undeclared_status.json")
    ust = json.load(open(UST_PATH, encoding="utf-8")) if os.path.exists(UST_PATH) else {}
    ST_LAB = {"fixed": ("해결 기록", "y"), "partial": ("일부 수정 기록", "u"), "doing": ("진행 중 기록", "u"), "not_diff": ("차이 아님 기록", "x"), "decide": ("미해결 기록", "n")}
    utrs = []
    n_open = 0
    for idx, u in enumerate(f10.get("undeclared", []), 1):
        st, note = ust.get(str(idx), ["decide", ""])
        lab, cls = ST_LAB.get(st, ("미해결 기록", "n"))
        uid = f"U{idx:02d}"
        if st in ("decide", "partial"):
            n_open += 1
        ev = ", ".join(u["evidence"]) if isinstance(u.get("evidence"), list) else u.get("evidence", "")
        tip = f"근거: {ev}\n제안: {u.get('suggested_fix', '')}"
        sev = {"high": "높음", "medium": "중간", "low": "낮음"}.get(u.get("severity", ""), u.get("severity", ""))
        utrs.append(
            f'<tr><td class="id">{uid}</td><td title="{esc(tip)}"><strong>{esc(u["title"])}</strong><span class="val">{esc(u.get("effect", ""))}</span></td>'
            f'<td class="small">{esc(sev)}</td><td class="small"><span class="{cls}">{lab}</span><span class="val">{esc(note)}</span></td></tr>')
    blocks.insert(0,
        f'<details class="sec"><summary>문서에 없는 차이(기존 조사에서 발견) <span class="muted small">{len(utrs)}건 · 해결 기록 {sum(1 for v in ust.values() if v[0] == "fixed")} · 미해결 기록 {n_open}</span></summary>'
        '<div class="secbody"><div class="scroll"><table class="f10"><thead><tr><th>ID</th><th>차이 (마우스를 올리면 근거·제안)</th><th>기존 심각도 평가</th><th>기존 상태 기록</th></tr></thead><tbody>'
        + "\n".join(utrs) + '</tbody></table></div></div></details>')
    n_total = len(f10["declared"])
    f10_html = (
        f'<section id="f10">\n<h2>F10 차이 기록 — 선언된 차이 {n_total}건</h2>\n'
        '<p class="small"><strong>지표 계산 방식·표시 규칙의 변경은 수용 대상이 아닙니다. 최적화 과정에서 발생한 차이는 수정해야 하며 동일성 검증 전에는 전환할 수 없습니다.</strong> '
        '기존 조사 기록은 근거 추적용으로 남깁니다. 기존 추천과 일괄 수용 조작은 제거했으며, 저장된 원본 기록은 변경하지 않았습니다. '
        '각 차이의 실제 상태는 다시 검증해야 합니다. 이 목록의 기존 상태만으로 완료를 판정하지 않습니다.</p>\n'
        + "\n".join(blocks) + "\n</section>")

total = sum(counts.values())
TEMPLATE = open(TEMPLATE_PATH, encoding="utf-8").read()
out = TEMPLATE
for k, v in {
    "{{ROWS}}": "\n".join(screen_blocks), "{{PROGRESS}}": progress_html, "{{RENEWAL}}": renewal_html, "{{F10}}": f10_html,
    "{{AS_OF}}": AS_OF, "{{BASIS}}": esc(BASIS), "{{BEFORE_ROWS}}": "\n".join(brows), "{{K_ROWS}}": "\n".join(krows),
    "{{TECHNICAL_ROWS}}": "\n".join(technical_rows), "{{N_TECHNICAL}}": str(len(technical_rows)),
    "{{WORK_ROWS}}": "\n".join(wrows), "{{N_WORK}}": str(len(WORK)), "{{N_WORK_IN}}": str(w_in), "{{N_WORK_OUT}}": str(w_out),
    "{{N_FNS}}": str(len(used_fns)), "{{N_AREAS}}": str(n_areas), "{{N_SCREENS}}": str(n_screens),
    "{{N_F1_BEFORE}}": str(sum(s['f1b'][0] in ('y', 'n') for s in SCREENS)),
    "{{N_F4_PENDING}}": str(sum(len(labels) for labels in f4_pending.values())),
    "{{F4_PENDING_ROWS}}": "\n".join(f4_pending_rows),
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
