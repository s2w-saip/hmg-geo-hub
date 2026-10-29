"""★ 수치 유의미성 점검표 생성기. 화면에 보이는 수치를 화면별 · 지표별로 모두 나열하고 인사이트를 판정한다.

항목 원천: ★ 리뉴얼·최적화 지표 점검표와 같은 화면 표시 항목(screens_def.py + 조사 데이터/*.json → visible_items.py)과
  항목 성격(조사 데이터/visible_applicability.json). 그중 metric_meaning_data.NUMERIC_PROFILES 성격이 '수치'다.
사람이 정한 규칙(지표 묶기 · 데이터 소스 · 인사이트 판정 기준 · 진행 현황)은 metric_meaning_data.py 에 있다.
판정은 하나다: 이 수치가 전략팀·마케팅 팀에 인사이트를 줄 수 있는가 (조사 데이터/insight_judgments.json).
구현 여부·값의 정확도는 보지 않는다. 등급·용도가 판정 근거와 맞지 않으면 실패한다.
규칙이 비거나 남으면(새 항목, 이름 변경, 쓰이지 않는 별칭) 실패한다. HTML 을 손으로 고치지 않는다.
사용: python -I build_metric_meaning.py [출력 경로]   (기본: 워크스페이스 루트 '★ 수치 유의미성 점검표.html')
"""
import html
import json
import os
import re
import sys
from collections import OrderedDict

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import item_applicability as IA  # noqa: E402
from visible_items import visible_inventory, display_location  # noqa: E402
import metric_meaning_data as D  # noqa: E402

REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
WORKSPACE = REPO
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WORKSPACE, "★ 수치 유의미성 점검표.html")
TEMPLATE = os.path.join(HERE, "metric_meaning_template.html")
SURVEY_ORDER = ["existing3", "global", "website", "project", "project_ops_interest", "admin", "qa_nonscreen"]
MENU_NOTE = r"\s*\((?:메뉴 숨김[^)]*|beta|하위 페이지|SNB 숨김[^)]*|EcatNav[^)]*|api 전용|GNB 밖)\)"  # build_checklist.py 와 같은 정리
ORIGIN_ORDER = list(D.ORIGIN_GROUP)


def fail(msg):
    raise SystemExit(f"수치 유의미성 점검표 생성 실패: {msg}")


def esc(s):
    return html.escape(str(s), quote=True)


# ── 화면 · 표시 항목 (build_checklist.py 와 같은 합치기) ──
_ns = {}
exec(open(os.path.join(HERE, "screens_def.py"), encoding="utf-8").read(), _ns)
SOURCE = _ns["SCREENS"]
by_name = {s["name"]: s for s in SOURCE}
for key in SURVEY_ORDER:
    path = os.path.join(HERE, "조사 데이터", key + ".json")
    if not os.path.exists(path):
        continue
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    for wa in d.get("write_areas", []):
        by_name[wa["screen"]]["areas"].append(
            (wa["loc"], wa["label"], wa.get("note", ""), wa["legacy_call"], wa["api_call"], wa.get("api_keys", []), wa["legacy_fns"], "쓰기"))
    for sc in d.get("screens", []):
        SOURCE.append({"name": sc["name"], "menu": sc["menu"], "title": sc["title"], "route": sc["route"], "flag": sc.get("flag", "—"),
                       "areas": [(a["loc"], a["label"], a.get("note", ""), a["legacy_call"], a["api_call"], a.get("api_keys", []),
                                  a["legacy_fns"], "쓰기" if a["label"].startswith("쓰기") else "") for a in sc["areas"]]})
SCREENS, _technical, PROVENANCE = visible_inventory(SOURCE)
IA.validate_inventory(set(PROVENANCE))


# ── 지표 묶기 · 데이터 소스 ──
used_aliases = set()


def split_metric(label):
    """화면 항목 이름 → (지표, 표시 방식)."""
    if label in D.ALIASES:
        used_aliases.add(label)
        v = D.ALIASES[label]
        return v if isinstance(v, tuple) else (v, "")
    pre = ""
    if label.startswith("권역·본사 · "):
        label, pre = label[len("권역·본사 · "):], "권역·본사 합산"
    if label.startswith("AI 유입 사이트 방문 수 · "):
        base, form = label.removesuffix(" 카드"), "카드" if label.endswith(" 카드") else ""
    elif " · " in label and label.split(" · ", 1)[0] in D.PREFIX_METRICS:
        base, form = label.split(" · ", 1)
    else:
        base, form = label, ""
        for suf in D.FORM_SUFFIXES:
            if label.endswith(suf):
                base, form = label[: -len(suf)], suf.strip(" ·")
                break
    if form in D.SPLIT_FORMS:
        base, form = D.SPLIT_FORMS[form], f"{base} 배지"
    return base, " ".join(x for x in (pre, form) if x)


def origin_of(route, base):
    if base in D.METRIC_ORIGIN:
        return D.METRIC_ORIGIN[base]
    if route in D.ROUTE_EXACT_ORIGIN:
        return D.ROUTE_EXACT_ORIGIN[route]
    for prefix, origin in D.ROUTE_ORIGIN:
        if route == prefix or route.startswith(prefix + "/"):
            return origin
    for part, origin in D.ROUTE_PART_ORIGIN:
        if part in route:
            return origin
    for origin, words in D.WORD_ORIGIN:
        if any(w in base for w in words):
            return origin
    return None


def menu_of(screen):
    return re.sub(MENU_NOTE, "", screen["menu"].replace(" › ", " > "))


rows_by_screen = []          # [(screen, [item])]
non_numeric = []             # [(screen, [(label, profile)])]
groups = OrderedDict()       # 지표 → {"items": [...], "origins": [...]}
unclassified = []
n_items_all = 0
for s in SCREENS:
    items, others = [], []
    for loc, label, *_ in s["areas"]:
        n_items_all += 1
        profile = IA.ITEMS[(s["route"], label)]["profile"]
        if profile not in D.NUMERIC_PROFILES:
            others.append((label, profile))
            continue
        base, form = split_metric(label)
        origin = origin_of(s["route"], base)
        if origin is None:
            unclassified.append(f"{s['route']} / {label} → {base}")
            continue
        item = {"label": label, "loc": display_location(loc), "profile": profile, "base": base, "form": form,
                "origin": origin, "group": D.ORIGIN_GROUP[origin], "screen": s}
        items.append(item)
        g = groups.setdefault(base, {"items": [], "origins": []})
        g["items"].append(item)
        if origin not in g["origins"]:
            g["origins"].append(origin)
    if items:
        rows_by_screen.append((s, items))
    non_numeric.append((s, others))

if unclassified:
    fail("데이터 소스를 정할 수 없는 수치(metric_meaning_data 의 분류 규칙을 고친다): " + "; ".join(unclassified))
stale = {
    "ALIASES": sorted(set(D.ALIASES) - used_aliases),
    "METRIC_ORIGIN": sorted(set(D.METRIC_ORIGIN) - set(groups)),
    "PREFIX_METRICS": sorted(m for m in D.PREFIX_METRICS if m not in groups),
}
stale = {k: v for k, v in stale.items() if v}
if stale:
    fail(f"화면 항목에 없는 규칙(이름이 바뀌었는지 확인): {stale}")
for g in groups.values():
    g["routes"] = list(OrderedDict.fromkeys(i["screen"]["route"] for i in g["items"]))
group_ids = {base: f"g{i}" for i, base in enumerate(groups)}


# ── 인사이트 판정 (조사 데이터/insight_judgments.json) ──
with open(os.path.join(HERE, D.INSIGHTS), encoding="utf-8") as f:
    IDATA = json.load(f)
ins = {}
problems = []
for x in IDATA["items"]:
    if x["base"] in ins:
        problems.append(f"판정 중복: {x['base']}")
    ins[x["base"]] = x
CRIT = list(D.INSIGHT_CRITERIA)


def tier_ok(x):
    """판정 근거와 등급·용도가 규칙에 맞는가.
    핵심 = 의사결정 연결·고유 정보 통과이고 액션 도출·비교 기준이 둘 다 미통과는 아님(이 조건이면 반드시 핵심).
    보조 = 의사결정 연결·액션 도출이 둘 다 미통과는 아님. 규모 정보·인사이트 없음 = 둘 다 통과 아님.
    핵심·보조는 쓰는 용도가 있어야 하고, 규모 정보·인사이트 없음은 용도가 없어야(—) 한다."""
    m = {k: x[k] for k in CRIT}
    core = m["decide"] == "☑" and m["unique"] == "☑" and not (m["action"] == "☒" and m["compare"] == "☒")
    if x["tier"] in (D.T_CORE, D.T_SUB) and x["use"] == "—":
        return False
    if x["tier"] in (D.T_SCALE, D.T_NONE) and x["use"] != "—":
        return False
    if x["tier"] == D.T_CORE:
        return core
    if core:
        return False
    if x["tier"] == D.T_SUB:
        return not (m["decide"] == "☒" and m["action"] == "☒")
    if x["tier"] in (D.T_SCALE, D.T_NONE):
        return m["decide"] != "☑" and m["action"] != "☑"
    return False


for base, g in groups.items():
    x = ins.get(base)
    ops = D.ORIGIN_GROUP[g["origins"][0]] == "운영"
    g["ins"], g["tier"], g["use"] = None, D.T_NA, "—"
    if ops:
        if x:
            problems.append(f"운영 지표에 판정이 있음(점검 제외로 둔다): {base}")
        continue
    if x is None:
        problems.append(f"판정 없음: {base}")
        continue
    if any(x.get(k) not in D.MARKS for k in CRIT) or x.get("tier") not in D.TIERS or x.get("use") not in D.USES:
        problems.append(f"{base}: 판정 근거·등급·용도 값이 잘못됨")
        continue
    if not tier_ok(x):
        problems.append(f"{base}: 등급 {x['tier']}·용도 {x['use']} 가 판정 근거 {''.join(x[k] for k in CRIT)} 와 맞지 않음")
    if not x.get("insight") or not x.get("upgrade"):
        problems.append(f"{base}: 인사이트·개선안 문구가 비었음")
    g["ins"], g["tier"], g["use"] = x, x["tier"], x["use"]
problems += [f"화면 지표에 없는 판정: {b}" for b in sorted(set(ins) - set(groups))]
if problems:
    fail("판정 데이터가 맞지 않음: " + "; ".join(problems))
for g in groups.values():
    for i in g["items"]:
        i["tier"] = g["tier"]
TIER_ORDER = list(D.TIERS)
USE_ORDER = list(D.USES)
judged = [g for g in groups.values() if g["ins"]]


# ── 표현 개편 방안 (조사 데이터/insight_redesign.json) ──
with open(os.path.join(HERE, D.REDESIGN), encoding="utf-8") as f:
    RDATA = json.load(f)
VIEWS = OrderedDict((v["id"], v) for v in RDATA["views"])
ELEM = list(D.ELEMENTS)
core_bases = {b for b, g in groups.items() if g["tier"] == D.T_CORE}
sub_bases = {b for b, g in groups.items() if g["tier"] == D.T_SUB}
redesign = {}
for m in RDATA["metrics"]:
    if m["base"] in redesign:
        problems.append(f"개편안 중복: {m['base']}")
    redesign[m["base"]] = m
    if m["view"] not in VIEWS:
        problems.append(f"{m['base']}: 없는 개편 뷰 {m['view']}")
    if any(m.get(k) not in D.MARKS for k in ELEM) or not all(m.get(k) for k in ("now", "gap", "redesign", "headline")):
        problems.append(f"{m['base']}: 5요소 표시·문구가 비었거나 잘못됨")
if set(redesign) != core_bases:
    problems.append(f"핵심 지표와 개편안이 맞지 않음: 개편안 없음 {sorted(core_bases - set(redesign))}, 핵심 아님 {sorted(set(redesign) - core_bases)}")
view_of = {b: m["view"] for b, m in redesign.items()}
for vid, v in VIEWS.items():
    for b in v["sub"]:
        if b not in sub_bases:
            problems.append(f"뷰 {vid}: 보조 지표가 아님 {b}")
        elif b in view_of:
            problems.append(f"보조 지표가 두 뷰에 있음: {b}")
        view_of[b] = vid
missing_sub = sorted(sub_bases - {b for v in VIEWS.values() for b in v["sub"]})
if missing_sub:
    problems.append(f"개편 뷰에 들어가지 않은 보조 지표: {missing_sub}")
if problems:
    fail("개편 방안 데이터가 맞지 않음: " + "; ".join(problems))


# ── 표시 ── (클래스·색은 metric_meaning_template.html 의 토큰. 툴팁은 data-tip 하나로 통일)
def tip(text):
    return f' data-tip="{esc(text)}"' if text else ""


def origin_tag(origin):
    return f'<span class="src{" src-ops" if D.ORIGIN_GROUP[origin] == "운영" else ""}">{esc(origin)}</span>'


def tier_tag(t, why="", n=None):
    num = f'<b class="num">{n}</b>' if n is not None else ""
    return f'<span class="pill p-{D.TIERS[t][0]}"{tip(why)}>{esc(t)}{num}</span>'


def use_tag(u, n=None):
    num = f'<b class="num">{n}</b>' if n is not None else ""
    team, desc = D.USES[u]
    return f'<span class="use-tag"{tip(f"{team} — {desc}")}>{esc(u)}{num}</span>'


HB = {"☑": "full", "△": "half", "☒": "empty"}
MARK_WORD = {"☑": "통과", "△": "일부", "☒": "미통과"}


def ball(m, text=""):
    return f'<span class="hb hb-{HB[m]}" role="img" aria-label="{MARK_WORD[m]}"{tip(text)}></span>'


def tier_counts(items):
    c = {t: sum(i["tier"] == t for i in items) for t in TIER_ORDER}
    return "".join(tier_tag(t, D.TIERS[t][1], n) for t, n in c.items() if n)


def ins_tip(g):
    x = g["ins"]
    return f"{x['insight']}\n→ {x['upgrade']}" if x else D.TIERS[D.T_NA][1]


# 화면별 수치 목록
screen_blocks = []
for sidx, (s, items) in enumerate(rows_by_screen):
    origins = [o for o in ORIGIN_ORDER if any(i["origin"] == o for i in items)]
    all_ops = all(i["group"] == "운영" for i in items)
    stip = f"화면 제목: {s['title']}\n메뉴 경로: {menu_of(s)}\n표시 항목 {len(s['areas'])}개 중 수치 {len(items)}개"
    head = (f'<tr class="screen" tabindex="0" onclick="toggleScreen({sidx})" onkeydown="if(event.key===\'Enter\')toggleScreen({sidx})">'
            f'<td{tip(stip)}><span class="caret" aria-hidden="true"></span><span class="sname">{esc(menu_of(s))}</span>'
            f'<span class="val"><code>{esc(s["route"])}</code> · 수치 {len(items)}개</span></td>'
            f'<td class="srcs">{"".join(origin_tag(o) for o in origins)}</td><td></td>'
            f'<td class="tags">{tier_counts(items)}</td></tr>')
    body = []
    for i in items:
        g = groups[i["base"]]
        n = len(g["routes"])
        others = list(OrderedDict.fromkeys(menu_of(x["screen"]) for x in g["items"] if x["screen"]["route"] != s["route"]))
        same = (f'<a href="#{group_ids[i["base"]]}"{tip("이 지표가 함께 표시되는 다른 화면" + chr(10) + chr(10).join(others))}>{n}개 화면에 표시</a>' if n > 1
                else f'<a href="#{group_ids[i["base"]]}">이 화면에만 표시</a>')
        itip = f"지표: {i['base']}" + (f"\n표시 방식: {i['form']}" if i["form"] else "") + (f"\n위치: {i['loc']}" if i["loc"] else "")
        body.append(
            f'<tr class="block" data-group="{esc(i["group"])}"><td class="indent"{tip(itip)}>{esc(i["label"])}'
            f'<span class="val">{esc(i["loc"])}</span></td><td class="srcs">{origin_tag(i["origin"])}</td>'
            f'<td class="same">{same}</td><td class="tags">{tier_tag(i["tier"], ins_tip(g))}</td></tr>')
    screen_blocks.append(f'<tbody class="scr" id="scr-{sidx}" data-group="{"운영" if all_ops else "성과"}">\n{head}\n' + "\n".join(body) + "\n</tbody>")


def ins_cells(g):
    x = g["ins"]
    if not x:
        return "".join('<td class="hbc"><span class="dash">—</span></td>' for _ in CRIT)
    out = []
    for k in CRIT:
        name, ok, ng = D.INSIGHT_CRITERIA[k]
        out.append(f'<td class="hbc">{ball(x[k], f"{name} · {MARK_WORD[x[k]]}" + chr(10) + (ok if x[k] == "☑" else ng if x[k] == "☒" else "일부만 충족한다"))}</td>')
    return "".join(out)


# 지표별 판정 표 (데이터 소스별 구획)
N_COLS = 8
group_rows = []
ordered = sorted(groups.items(), key=lambda kv: (ORIGIN_ORDER.index(kv[1]["origins"][0]), TIER_ORDER.index(kv[1]["tier"])))
prev = None
for base, g in ordered:
    origin = g["origins"][0]
    ogroup = D.ORIGIN_GROUP[origin]
    if origin != prev:
        in_origin = [x for _b, x in ordered if x["origins"][0] == origin]
        n_core = sum(x["tier"] == D.T_CORE for x in in_origin)
        group_rows.append(f'<tr class="sec-row" data-group="{esc(ogroup)}" data-origin="{esc(origin)}"><td colspan="{N_COLS}">'
                          f'{esc(origin)}<span class="sec-n">지표 {len(in_origin)}개' + (f', 그중 핵심 지표 {n_core}개' if n_core else "") + '</span>'
                          f'<span class="sec-kind">{esc(D.GROUP_LABEL[ogroup])}</span></td></tr>')
        prev = origin
    forms = list(OrderedDict.fromkeys(i["form"] for i in g["items"] if i["form"]))
    screens_html = "".join(f'<li>{esc(menu_of(next(i["screen"] for i in g["items"] if i["screen"]["route"] == r)))} '
                           f'<span class="muted">{sum(i["screen"]["route"] == r for i in g["items"])}개</span></li>' for r in g["routes"])
    extra = "".join(origin_tag(o) for o in g["origins"][1:])
    x = g["ins"]
    vlink = (f'<a class="vlink" href="#view-{view_of[base]}"{tip("이 지표가 들어가는 개편 뷰로 이동")}>개편 뷰: {esc(VIEWS[view_of[base]]["name"])}</a>'
             if base in view_of else "")
    ins_text = (f'<td class="insight"><p class="ins">{esc(x["insight"])}</p><p class="up"><span aria-hidden="true">→</span>{esc(x["upgrade"])}</p>{vlink}</td>'
                if x else f'<td class="insight muted">{esc(D.TIERS[D.T_NA][1])}</td>')
    use_cell = (f'<td class="use">{use_tag(g["use"])}<span class="val">{esc(D.USES[g["use"]][0])}</span></td>' if g["use"] != "—"
                else '<td class="use"><span class="dash">—</span></td>')
    group_rows.append(
        f'<tr class="mrow" id="{group_ids[base]}" data-group="{esc(ogroup)}" data-origin="{esc(origin)}" data-tier="{esc(g["tier"])}"'
        f' data-use="{esc(g["use"])}" data-name="{esc(base.lower())}">'
        f'<td class="name"><b>{esc(base)}</b>{extra}<span class="val">{esc(" · ".join(forms))}</span>'
        f'<details class="scrs"><summary>{len(g["routes"])}개 화면에 항목 {len(g["items"])}개로 표시</summary><ul>{screens_html}</ul></details></td>'
        f'<td class="tags">{tier_tag(g["tier"], D.TIERS[g["tier"]][1])}</td>'
        + ins_cells(g) + use_cell + ins_text + "</tr>")

# 상단 요약: 인사이트 분포 막대 (부분-전체, 4구간)
MAP_TIERS = [t for t in TIER_ORDER if t != D.T_NA]
dist = [(t, sum(g["tier"] == t for g in judged)) for t in MAP_TIERS]
total = sum(n for _t, n in dist) or 1
dist_bar = "".join(f'<span class="seg p-{D.TIERS[t][0]}" style="flex:{n} 1 0"{tip(f"{t} {n}개 ({n * 100 / total:.0f}%)" + chr(10) + D.TIERS[t][1])}>'
                   f'<em>{n}</em></span>' for t, n in dist if n)
dist_legend = "".join(f'<li><span class="sw p-{D.TIERS[t][0]}" aria-hidden="true"></span>{esc(t)}<b>{n}</b><span class="pct">{n * 100 / total:.0f}%</span></li>'
                      for t, n in dist)
TEAM_USES = {"전략기획실": ("전략", "전략·GEO 최적화"), "마케팅": ("GEO 최적화", "전략·GEO 최적화", "질문 발굴")}
core_by_team = {team: sum(g["tier"] == D.T_CORE and g["use"] in uses for g in judged) for team, uses in TEAM_USES.items()}

# 인사이트 맵: 핵심·보조 = 등급 × 용도, 규모 정보·인사이트 없음 = 한 줄
MAP_USES = [u for u in USE_ORDER if u != "—"]
map_rows = []
for t in MAP_TIERS:
    head = f'<th class="rowh" scope="row">{tier_tag(t)}<span class="val">{esc(D.TIERS[t][1])}</span></th>'
    if t in (D.T_CORE, D.T_SUB):
        cells = []
        for u in MAP_USES:
            names = [b for b, g in ordered if g["tier"] == t and g["use"] == u]
            links = "".join(f'<a class="chip"{tip(groups[b]["ins"]["insight"])} href="#{group_ids[b]}">{esc(b)}</a>' for b in names)
            cells.append(f'<td class="mx mx-{D.TIERS[t][0]}"><span class="mx-n">{len(names)}</span><div class="chips">{links}</div></td>')
        map_rows.append(f'<tr>{head}{"".join(cells)}</tr>')
    else:
        names = [b for b, g in ordered if g["tier"] == t]
        links = "".join(f'<a class="chip"{tip(groups[b]["ins"]["upgrade"])} href="#{group_ids[b]}">{esc(b)}</a>' for b in names)
        map_rows.append(f'<tr>{head}<td class="mx mx-{D.TIERS[t][0]}" colspan="{len(MAP_USES)}"><span class="mx-n">{len(names)}</span>'
                        f'<div class="chips">{links}</div></td></tr>')
map_head = "".join(f'<th scope="col">{use_tag(u)}<span class="val">{esc(D.USES[u][0])} · {esc(D.USES[u][1])}</span></th>' for u in MAP_USES)

# 표현 개편 방안: 원칙 · 개편 뷰 · 핵심 지표 진단
def sketch(kind):
    """개편 뷰의 구성 스케치(값 없는 도식). 색은 템플릿 토큰: 우리 = accent, 경쟁사 = orange, 그 밖 = 회색."""
    W, H = 320, 150
    s = []
    if kind == "position":
        s.append('<line class="ax" x1="34" y1="128" x2="306" y2="128"/><line class="ax" x1="34" y1="128" x2="34" y2="12"/>')
        s.append('<text class="lb" x="306" y="144" text-anchor="end">노출률 →</text><text class="lb" x="40" y="20">↑ 추천 점유</text>')
        for cx, cy in ((120, 92), (176, 70), (232, 58), (250, 98), (92, 60)):
            s.append(f'<circle class="dot" cx="{cx}" cy="{cy}" r="6"/>')
        s.append('<text class="lb" x="240" y="50">1위</text>')
        s.append('<line class="mv" x1="132" y1="112" x2="160" y2="96"/><circle class="us" cx="164" cy="94" r="7"/><text class="lbs" x="174" y="98">우리</text>')
        s.append('<circle class="us-old" cx="128" cy="114" r="5"/>')
    elif kind == "quadrant":
        s.append('<rect class="q" x="34" y="12" width="136" height="58"/><rect class="q hot" x="170" y="12" width="136" height="58"/>'
                 '<rect class="q" x="34" y="70" width="136" height="58"/><rect class="q" x="170" y="70" width="136" height="58"/>')
        s.append('<text class="lbs" x="298" y="28" text-anchor="end">우선 투자</text>')
        s.append('<text class="lb" x="306" y="144" text-anchor="end">1위 대비 격차 →</text><text class="lb" x="40" y="10">↑ 시장 중요도</text>')
        for cx, cy, cls in ((210, 40, "us"), (250, 52, "us"), (90, 40, "dot"), (120, 100, "dot"), (220, 104, "dot"), (70, 90, "dot")):
            s.append(f'<circle class="{cls}" cx="{cx}" cy="{cy}" r="{6 if cls == "us" else 5}"/>')
    elif kind == "funnel":
        for i, (lab, w, cw) in enumerate((("노출", 250, 270), ("후보", 200, 230), ("추천", 110, 190), ("유입", 90, 120), ("전환", 50, 70))):
            y = 10 + i * 27
            s.append(f'<text class="lb" x="30" y="{y + 13}" text-anchor="end">{lab}</text>')
            s.append(f'<rect class="{"bar hot" if lab == "추천" else "bar"}" x="36" y="{y}" width="{w}" height="18" rx="4"/>')
            s.append(f'<line class="tick" x1="{36 + cw}" y1="{y - 2}" x2="{36 + cw}" y2="{y + 20}"/>')
        s.append('<text class="lbs" x="232" y="77">← 최대 이탈</text>')
        s.append('<text class="lb" x="306" y="146" text-anchor="end">막대 = 우리 · 세로 눈금 = 1위 경쟁사</text>')
    elif kind == "backlog":
        for i, (st, w1, w2) in enumerate((("miss", 150, 70), ("miss", 130, 62), ("nocite", 160, 50), ("nopick", 120, 40), ("nocite", 140, 30))):
            y = 12 + i * 26
            s.append(f'<circle class="st-{st}" cx="20" cy="{y + 8}" r="6"/>')
            s.append(f'<rect class="txt" x="34" y="{y + 3}" width="{w1}" height="10" rx="3"/>')
            s.append(f'<rect class="prio" x="{306 - w2}" y="{y + 2}" width="{w2}" height="12" rx="3"/>')
        s.append('<text class="lb" x="306" y="146" text-anchor="end">우선순위 = 검색 수요 × 상태</text>')
    elif kind == "diverging":
        s.append('<line class="ax" x1="190" y1="8" x2="190" y2="132"/>')
        for i, (l, r) in enumerate(((90, 30), (70, 50), (40, 80), (60, 10), (30, 40))):
            y = 12 + i * 24
            s.append(f'<rect class="txt" x="8" y="{y + 4}" width="56" height="9" rx="3"/>')
            s.append(f'<rect class="them" x="{190 - l}" y="{y}" width="{l}" height="16" rx="3"/><rect class="us-bar" x="190" y="{y}" width="{r}" height="16" rx="3"/>')
        s.append('<text class="lb" x="186" y="146" text-anchor="end">← 경쟁사 답변에서</text><text class="lb" x="194" y="146">우리 답변에서 →</text>')
    elif kind == "pages":
        for i, flags in enumerate(((1, 1, 1), (1, 1, 0), (1, 0, 0), (0, 0, 0), (1, 1, 0))):
            y = 14 + i * 25
            s.append(f'<rect class="txt" x="8" y="{y}" width="110" height="10" rx="3"/>')
            for j, on in enumerate(flags):
                cx = 160 + j * 46
                if j:
                    s.append(f'<line class="ax" x1="{cx - 38}" y1="{y + 5}" x2="{cx - 8}" y2="{y + 5}"/>')
                s.append(f'<circle class="{"us" if on else "off"}" cx="{cx}" cy="{y + 5}" r="6"/>')
        s.append('<text class="lb" x="160" y="146" text-anchor="middle">인용</text><text class="lb" x="206" y="146" text-anchor="middle">유입</text>'
                 '<text class="lb" x="252" y="146" text-anchor="middle">전환</text>')
    return f'<svg class="sketch" viewBox="0 0 {W} {H}" role="img" aria-label="개편 뷰 구성 스케치">{"".join(s)}</svg>'


elem_rows = "".join(f'<li><b>{esc(n)}</b><span>{esc(d)}</span></li>' for n, d in D.ELEMENTS.values())
principle_rows = "".join(f'<li><span class="pn">{k}</span><div><b>{esc(n)}</b><p>{esc(d)}</p></div></li>' for k, (n, d) in enumerate(D.PRINCIPLES, 1))
view_cards = []
for vid, v in VIEWS.items():
    core = [b for b, m in redesign.items() if m["view"] == vid]
    core_chips = "".join(f'<a class="chip core" href="#{group_ids[b]}"{tip(redesign[b]["headline"])}>{esc(b)}</a>' for b in core)
    sub_chips = "".join(f'<a class="chip" href="#{group_ids[b]}">{esc(b)}</a>' for b in v["sub"])
    layout = "".join(f"<li>{esc(x)}</li>" for x in v["layout"])
    view_cards.append(
        f'<article class="view card" id="view-{esc(vid)}"><div class="v-top"><div><span class="v-team">{esc(v["team"])}</span>'
        f'<h3>{esc(v["name"])}</h3><p class="v-q">{esc(v["question"])}</p></div>{sketch(v["sketch"])}</div>'
        f'<div class="v-head"><span class="note-h">헤드라인 예시</span>“{esc(v["headline"])}”</div>'
        f'<ul class="v-layout">{layout}</ul>'
        f'<div class="v-mets"><span class="note-h">이 뷰에 들어가는 핵심 지표 {len(core)}개</span><div class="chips">{core_chips}</div>'
        f'<span class="note-h">보조 지표 {len(v["sub"])}개 — 뷰 안에서 원인을 쪼개 보여 주는 층</span><div class="chips">{sub_chips}</div></div></article>')
diag_rows = []
for vid, v in VIEWS.items():
    for b, m in redesign.items():
        if m["view"] != vid:
            continue
        balls = "".join(f'<td class="hbc">{ball(m[k], f"{D.ELEMENTS[k][0]} · {MARK_WORD[m[k]]}" + chr(10) + D.ELEMENTS[k][1])}</td>' for k in ELEM)
        diag_rows.append(f'<tr><td class="name"><a href="#{group_ids[b]}"><b>{esc(b)}</b></a><a class="vlink" href="#view-{vid}">{esc(v["name"])}</a></td>'
                         f'<td class="now">{esc(m["now"])}</td>{balls}<td class="gap">{esc(m["gap"])}</td>'
                         f'<td class="insight"><p class="ins">{esc(m["redesign"])}</p><p class="hl">“{esc(m["headline"])}”</p></td></tr>')
n_missing = {k: sum(m[k] == "☒" for m in redesign.values()) for k in ELEM}
elem_heads = "".join(f'<th class="hbh" scope="col"{tip(f"{n}" + chr(10) + d)}>{esc(n)}</th>' for n, d in D.ELEMENTS.values())
elem_gaps = " · ".join(f'{esc(D.ELEMENTS[k][0])} <b>{n}</b>개' for k, n in n_missing.items())

# 바꿀 후보: 인사이트 없음 지표와 유의미하게 만드는 안
none_rows = "\n".join(f'<tr><td><a href="#{group_ids[b]}"><b>{esc(b)}</b></a><span class="val">{esc(g["origins"][0])}</span></td>'
                      f'<td>{esc(g["ins"]["insight"])}</td><td class="up-c"><span aria-hidden="true">→</span>{esc(g["ins"]["upgrade"])}</td></tr>'
                      for b, g in ordered if g["tier"] == D.T_NONE)

# 판정 기준 (자세히 보기)
crit_rows = []
for k, (name, ok, ng) in D.INSIGHT_CRITERIA.items():
    c = {m: sum(g["ins"][k] == m for g in judged) for m in D.MARKS}
    crit_rows.append(f'<tr><td><b>{esc(name)}</b></td><td>{esc(ok)}</td><td>{esc(ng)}</td>'
                     + "".join(f'<td class="num-c">{ball(m)} {c[m]}</td>' for m in c) + "</tr>")
tier_rule_rows = "\n".join(f'<tr><td>{tier_tag(t)}</td><td>{esc(rule)}</td><td class="num-c">{sum(g["tier"] == t for g in groups.values())}</td></tr>'
                           for t, (_c, rule) in D.TIERS.items())
use_rows = "\n".join(f'<tr><td>{use_tag(u) if u != "—" else "—"}</td><td>{esc(team)}</td><td>{esc(desc)}</td>'
                     f'<td class="num-c">{sum(g["use"] == u for g in judged)}</td></tr>' for u, (team, desc) in D.USES.items())


def filter_buttons(kind, names, tag):
    allbtn = f'<button type="button" class="seg-btn on" aria-pressed="true" onclick="setFilter(\'{kind}\', \'\', this)">전체<b class="num">{len(groups)}</b></button>'
    return allbtn + "".join(
        f'<button type="button" class="seg-btn" aria-pressed="false" onclick="setFilter(\'{kind}\', \'{esc(v)}\', this)">'
        f'{tag(v)}<b class="num">{sum(g[kind] == v for g in groups.values())}</b></button>' for v in names)


ST = {"done": ("완료", "done"), "next": ("다음", "next"), "decide": ("결정 필요", "decide")}
progress_rows = "\n".join(f'<li class="pg pg-{ST[st][1]}"><span class="pg-st">{ST[st][0]}</span><b>{esc(what)}</b><span class="pg-memo">{esc(memo)}</span></li>'
                          for st, what, memo in D.PROGRESS)

nonnum_rows, empty_screens = [], []
for s, others in non_numeric:
    if not others:
        continue
    by_prof = OrderedDict()
    for label, profile in others:
        by_prof.setdefault(IA.PROFILES[profile][0], []).append(label)
    parts = "".join(f'<div><span class="muted">{esc(p)}</span> {esc(" · ".join(ls))}</div>' for p, ls in by_prof.items())
    nonnum_rows.append(f'<tr><td>{esc(menu_of(s))}<span class="val"><code>{esc(s["route"])}</code></span></td>'
                       f'<td class="num-c">{len(others)}</td><td>{parts}</td></tr>')
numeric_routes = {s["route"] for s, _ in rows_by_screen}
for s in SCREENS:
    if s["route"] not in numeric_routes:
        empty_screens.append(f'{esc(menu_of(s))} <code>{esc(s["route"])}</code>')

profile_rows = []
pcounts = {}
for s in SCREENS:
    for a in s["areas"]:
        p = IA.ITEMS[(s["route"], a[1])]["profile"]
        pcounts[p] = pcounts.get(p, 0) + 1
for p, (desc, _f) in IA.PROFILES.items():
    if p in pcounts:
        tag = '<span class="flag">수치</span>' if p in D.NUMERIC_PROFILES else '<span class="muted">수치 아님</span>'
        profile_rows.append(f'<tr><td><code>{esc(p)}</code></td><td>{esc(desc)}</td><td class="num-c">{pcounts[p]}</td><td>{tag}</td></tr>')

origin_rows = []
for origin, group in D.ORIGIN_GROUP.items():
    n_g = sum(1 for g in groups.values() if g["origins"][0] == origin)
    n_i = sum(1 for _s, its in rows_by_screen for i in its if i["origin"] == origin)
    if n_i:
        origin_rows.append(f'<tr><td>{origin_tag(origin)}</td><td>{esc(D.GROUP_LABEL[group])}</td><td class="num-c">{n_g}</td><td class="num-c">{n_i}</td></tr>')


def n_tier(t):
    return str(sum(g["tier"] == t for g in judged))


all_items = [i for _s, its in rows_by_screen for i in its]
checklist_link = os.path.relpath(os.path.join(WORKSPACE, "★ 리뉴얼·최적화 지표 점검표.html"), os.path.dirname(os.path.abspath(OUT))).replace(os.sep, "/")
values = {
    "{{UPDATED}}": D.UPDATED,
    "{{REVIEWED_AT}}": IA.DATA["reviewed_at"],
    "{{CHECKLIST_LINK}}": esc(checklist_link),
    "{{N_SCREENS}}": str(len(SCREENS)),
    "{{N_SCREENS_NUM}}": str(len(rows_by_screen)),
    "{{N_ITEMS_ALL}}": str(n_items_all),
    "{{N_NUM}}": str(len(all_items)),
    "{{N_NONNUM}}": str(n_items_all - len(all_items)),
    "{{N_GROUPS}}": str(len(groups)),
    "{{N_EMPTY}}": str(len(empty_screens)),
    "{{N_JUDGED}}": str(len(judged)),
    "{{N_NA}}": str(sum(g["tier"] == D.T_NA for g in groups.values())),
    "{{N_CORE}}": n_tier(D.T_CORE), "{{N_NONE}}": n_tier(D.T_NONE),
    "{{N_CORE_STRATEGY}}": str(core_by_team["전략기획실"]), "{{N_CORE_MARKETING}}": str(core_by_team["마케팅"]),
    "{{T_CORE}}": esc(D.T_CORE), "{{T_SUB}}": esc(D.T_SUB), "{{T_SCALE}}": esc(D.T_SCALE), "{{T_NONE}}": esc(D.T_NONE), "{{T_NA}}": esc(D.T_NA),
    "{{TAG_CORE}}": tier_tag(D.T_CORE), "{{TAG_NONE}}": tier_tag(D.T_NONE),
    "{{AUDIENCE}}": esc(D.AUDIENCE),
    "{{INSIGHT_AT}}": esc(IDATA["reviewed_at"]),
    "{{INSIGHT_BASIS}}": esc(IDATA["basis"]),
    "{{PROGRESS_ROWS}}": progress_rows,
    "{{DIST_BAR}}": dist_bar,
    "{{DIST_LEGEND}}": dist_legend,
    "{{MAP_HEAD}}": map_head,
    "{{MAP_ROWS}}": "\n".join(map_rows),
    "{{NONE_ROWS}}": none_rows,
    "{{REDESIGN_BASIS}}": esc(RDATA["basis"]),
    "{{ELEM_ROWS}}": elem_rows,
    "{{PRINCIPLE_ROWS}}": principle_rows,
    "{{VIEW_CARDS}}": "\n".join(view_cards),
    "{{N_VIEWS}}": str(len(VIEWS)),
    "{{DIAG_ROWS}}": "\n".join(diag_rows),
    "{{ELEM_HEADS}}": elem_heads,
    "{{ELEM_GAPS}}": elem_gaps,
    "{{N_ACTION_MISSING}}": str(n_missing["action"]),
    "{{GROUP_ROWS}}": "\n".join(group_rows),
    "{{SCREEN_ROWS}}": "\n".join(screen_blocks),
    "{{INS_HEADS}}": "".join(f'<th class="hbh" scope="col"{tip(f"{n}" + chr(10) + "● " + ok + chr(10) + "○ " + ng)}>{esc(n)}</th>'
                             for n, ok, ng in D.INSIGHT_CRITERIA.values()),
    "{{TIER_BUTTONS}}": filter_buttons("tier", TIER_ORDER, tier_tag),
    "{{USE_BUTTONS}}": filter_buttons("use", MAP_USES, use_tag),
    "{{CRIT_ROWS}}": "\n".join(crit_rows),
    "{{TIER_RULE_ROWS}}": tier_rule_rows,
    "{{USE_ROWS}}": use_rows,
    "{{NONNUM_ROWS}}": "\n".join(nonnum_rows),
    "{{EMPTY_SCREENS}}": " · ".join(empty_screens),
    "{{PROFILE_ROWS}}": "\n".join(profile_rows),
    "{{ORIGIN_ROWS}}": "\n".join(origin_rows),
    "{{BALL_FULL}}": ball("☑"), "{{BALL_HALF}}": ball("△"), "{{BALL_EMPTY}}": ball("☒"),
}
with open(TEMPLATE, encoding="utf-8") as f:
    out = f.read()
for k, v in values.items():
    out = out.replace(k, v)
left = re.findall(r"\{\{[A-Z_]+\}\}", out)
if left:
    fail(f"템플릿 자리 표시가 남음: {sorted(set(left))}")
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(out)
print(f"{OUT}: 화면 {len(SCREENS)}개 중 {len(rows_by_screen)}개 · 표시 항목 {n_items_all}개 중 수치 {len(all_items)}개 · 지표 {len(groups)}개 · "
      + " · ".join(f"{t} {sum(g['tier'] == t for g in groups.values())}" for t in TIER_ORDER))
