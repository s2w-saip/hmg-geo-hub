"""★ 수치 정확도 점검표 생성기 — 화면 수치 364개의 정확도 감사(2026-10-20) 결과를 한 장으로 만든다.

판정 질문 하나: 화면 수치가 **정의대로 수학적으로 맞게** 계산되는가(API 경로 기준, 레거시 일치 여부는 판정하지 않는다).
입력: 조사 데이터/accuracy_audit.json (364개 항목·원인 코드·한국어 설명). 이 파일의 판정은 손대지 않는다.
처리 상태(고침·일부·결정 필요)와 감사 뒤 새로 생긴 결정 항목은 아래 STATUS·EXTRA_DECISIONS 에서 고친다.
실행: python -I build_accuracy_audit.py [출력 경로]  (기본 = 워크스페이스 루트의 '★ 수치 정확도 점검표.html')
"""
from __future__ import annotations

import html
import json
import os
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
WORKSPACE = REPO
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WORKSPACE, "★ 수치 정확도 점검표.html")
DATA = os.path.join(HERE, "조사 데이터", "accuracy_audit.json")

# ── 처리 상태(2026-10-20 수정분, 워킹트리) ─────────────────────────────────────────
# fixed = 고침 · partial = 고쳤으나 잔여 있음 · 그 밖의 결함·의심·알려진 항목 = 결정 필요
STATUS: dict[str, dict[str, str]] = {
    "D01": {"state": "fixed", "change": "웹사이트·프로젝트 타일이 Overview 카드와 같은 규칙(overviewCardState)을 쓴다. 값이 없거나 분모 없는 0 이면 측정 대기이고 Δ·엔진 배지를 그리지 않는다(건수 카드 제외).",
            "where": "dashboard/_components/summary-tiles.tsx · dashboard/_data/card-state.ts", "test": "summary-tiles.pending.render.test.tsx(수정 전 실패 2)"},
    "D02": {"state": "fixed", "change": "세션 0 코호트의 전환율·격차를 null(\"—\")로 낸다. 추이는 그날 점이 비고, 국가·페이지 표는 정렬에서 맨 뒤다. 레거시 GA4 경로는 그대로(숫자 0). 권역 요약 문구는 단위를 값 쪽으로 옮겨 정상값 표시는 같다.",
            "where": "lib/hgh/adapters/funnel.ts · lib/ga4/conversion.ts(타입) · ai-funnel/_components/conversion-view.tsx · conversion-countries-table.tsx · hooks/use-sortable-table.ts(null 정렬) · messages region.summary",
            "test": "funnel.test.ts(수정 전 실패 3) · funnel.parity.test.ts(선언된 차이: API null ⇔ 레거시 0) · conversion-country-labels.render.test.tsx"},
    "D03": {"state": "fixed", "change": "/v1/funnel/acr 응답에 관점 당사 합계 own(선택 합·당사 행이 있는 셀 DISTINCT)을 더하고, 카드가 own 을 읽는다. 응답 필드 추가(가산)라 OpenAPI·api-types 를 다시 만들었다.",
            "where": "back acr/queries.py own_sql · schemas.py AcrOwn · service.py · front ai-funnel/_data/acr-card.ts · acr-live-view.tsx", "test": "acr/tests/test_acr.py::test_own_totals_…(수정 전 실패) · funnel.test.ts"},
    "D05": {"state": "partial", "change": "주마다 그 주 마지막 회차 값만 쓴다(같은 주 회차 합산 제거). 잔여: 같은 주 뒤 회차가 앞 회차의 셀을 다 재측정하지 않으면 앞 회차에만 있는 셀이 빠진다. 셀 단위 주 대표(레거시 규칙)는 백엔드 /v1/trend 주 버킷 집계가 필요하다.",
            "where": "lib/hgh/adapters/mentions.ts toMentionTrend", "test": "mentions.test.ts(수정 전 실패 2)"},
    "D06": {"state": "fixed", "change": "카테고리 Δ(공식(HMG)·딜러·카테고리 막대)를 추이 마지막 회차 − 직전 회차로 낸다(공식 Δ 정본과 같은 기준, API 원천). 도넛 중앙 비중을 카드와 같은 반올림으로 바꿨다.",
            "where": "citations-standard-view.tsx CategoryDelta · lib/hgh/adapters/citations.ts prevCategoriesOf · citations-view.tsx CategoryDonut", "test": "citations-standard-view.delta-basis.test.tsx · citations-view.donut-share.render.test.tsx(수정 전 실패)"},
    "D07": {"state": "fixed", "change": "최신 스냅샷에 없지만 앞 회차에 값이 있는 카테고리 시리즈를 뒤에 붙인다(모든 회차가 0 인 시리즈만 뺀다).",
            "where": "lib/hgh/adapters/citations.ts toCitationTrend", "test": "citations.test.ts(수정 전 실패)"},
    "D10": {"state": "fixed", "change": "SOV 0/0 은 D01 타일 규칙으로 측정 대기다. GEO 스냅샷은 답변은 있는데 언급 0 인 시장(noMentions)을 순위·점유율 \"—\"로 그린다.",
            "where": "summary-tiles.tsx · lib/hgh/adapters/dashboard.ts marketOf · dashboard/_components/geo-snapshot.tsx", "test": "summary-tiles.pending.render.test.tsx · geo-snapshot.render.test.tsx · dashboard.test.ts(수정 전 실패)"},
    "D12": {"state": "fixed", "change": "우세 관점(배지)을 반올림 전 건수로 정한다(toPerspective.dominant). 레거시·샘플은 그대로.",
            "where": "lib/hgh/adapters/intent.ts · components/social-scraping/context-map-view.tsx · types.ts", "test": "intent.test.ts(수정 전 실패) · intent.parity.test.ts(선언 필드)"},
    "D13": {"state": "fixed", "change": "관리자 '전체'(count)를 보기(활성·삭제) 모수로 센다. 필터 옵션은 종전대로 루트 전체.",
            "where": "back catalog/prompts/catalog/screen.py", "test": "test_screen.py::test_admin_count_is_the_view_population(수정 전 실패: 10 대 6)"},
    "S05": {"state": "fixed", "change": "D01·D10 타일 규칙으로 함께 해결(프로젝트 대시보드도 같은 타일). 0/0 은 측정 대기.", "where": "summary-tiles.tsx", "test": "summary-tiles.pending.render.test.tsx"},
}
# 결정 필요로 남긴 결함·알려진 항목의 사유(데이터의 settle 위에 덧붙인다)
DECIDE_NOTE: dict[str, str] = {
    "D04": "어댑터 U8-N20 에 추이 힌트를 '회차별'로 바꾸는 것이 API 전환 필수 단계로 정해져 있다. 다만 같은 문구 키를 샘플·레거시 화면도 쓰고, 기간 모드 측정 주석 문구는 아직 없다.",
    "D08": "레거시 산식을 재현하는 프로필 스위치(brand_exposure_per_alias) 동작이다. 정의대로 고치면 레거시와 값이 달라진다.",
    "D09": "m05_den_hostless 를 켰을 때만 생긴다(끄면 두 분모 모두 호스트 있는 인용 — 코드 확인). 스위치 운영 여부와 함께 정한다.",
    "D11": "라벨 '최근 120일·공백 끊김'에 맞춰 데이터 창을 바꿀지, 라벨을 바꿀지 정해야 한다(글로벌·웹사이트 S04 와 같은 문제).",
    "D14": "한 도메인을 한 행으로 합칠지, HMG 공식 채널을 별도 라벨로 보일지 표시 방식 결정이 먼저다. 데이터에 따라 생긴다.",
    "K01": "stg 데이터로만 판정할 수 있다(docs/handoff/p4-acr-model-denominator.html 절차).",
    "K02": "정의가 둘이다: 화면 '언급이 1회 이상 집계된 브랜드 수' 대 API 스키마 '순위를 매긴 브랜드 수(당사 1 + 경쟁 브랜드)'. 명부 제외 행 포함은 의도된 레거시 동작(service.py 머리 주석).",
}
# 감사 뒤 수정 과정에서 새로 드러난 결정 항목(364개 판정 밖)
EXTRA_DECISIONS: list[dict[str, str]] = [
    {"code": "X01", "need": "제품 결정", "title": "GA4 전환율 반올림이 x.x5 경계에서 0.1 낮게 나옴",
     "desc": "레거시 식 Math.round(n / d × 1000) / 10 이 이진 부동소수 때문에 201/400 = 50.25 를 50.2 로 낸다(정수 나눗셈 한 번이면 50.3). 핸드오프 §6 '반올림 공식 2종'과 같은 계열이다. D02 에서는 레거시와 같은 식을 유지했다.",
     "settle": "화면 공통 반올림 규칙(정수 나눗셈 후 반올림)으로 통일할지 정한다. 바꾸면 경계값에서 레거시와 0.1 다르다."},
]
NEED_ORDER = ["제품 결정", "문구 결정", "스위치 결정", "stg 확인", "데이터 확인", "코드 수정"]
VERDICT_KO = {"OK": "정상", "DEFECT": "결함", "SUSPECT": "의심", "KNOWN": "알려진 결함", "N/A": "해당 없음"}


def fail(msg: str) -> None:
    print("ERROR:", msg, file=sys.stderr)
    sys.exit(1)


def esc(s: object) -> str:
    return html.escape(str(s), quote=True)


with open(DATA, encoding="utf-8") as f:
    D = json.load(f)
items = D["items"]
causes = OrderedDict((c["code"], c) for c in D["causes"])
by_id = {i["id"]: i for i in items}

# ── 검사 ──
if len(items) != 364 or len(by_id) != 364:
    fail(f"항목 수 {len(items)} / 고유 {len(by_id)} (364 여야 한다)")
for c in causes.values():
    for i in c["items"]:
        if i not in by_id:
            fail(f"{c['code']} 의 없는 항목 {i}")
        if by_id[i]["cause"] != c["code"]:
            fail(f"{i} 의 cause {by_id[i]['cause']} ≠ {c['code']}")
for code in list(STATUS) + list(DECIDE_NOTE):
    if code not in causes:
        fail(f"상태 표의 없는 원인 코드 {code}")
for i in items:
    if i["verdict"] in ("DEFECT", "SUSPECT", "KNOWN", "N/A") and i["cause"] not in causes:
        fail(f"{i['id']} 원인 코드 없음")


def state_of(code: str | None) -> str:
    if code is None:
        return "ok"
    if code in STATUS:
        return STATUS[code]["state"]
    kind = causes[code]["kind"]
    return "na" if kind == "na" else "decide"


verdicts = Counter(i["verdict"] for i in items)
item_state = {i["id"]: (state_of(i["cause"]) if i["verdict"] != "OK" else "ok") for i in items}
fixed_n = sum(1 for i in items if item_state[i["id"]] == "fixed")
partial_n = sum(1 for i in items if item_state[i["id"]] == "partial")
decide_items = [i for i in items if item_state[i["id"]] == "decide"]
decide_causes = [c for c in causes.values() if c["kind"] != "na" and c["code"] not in STATUS]


def need_of(c: dict) -> str:
    """결정 목록의 묶음: 결함·알려진 결함 중 수정 방향은 정해졌으나 결정이 먼저인 것은 '결함 · 결정 필요', 나머지는 데이터의 need."""
    return "결함 · 결정 필요" if c["kind"] in ("defect", "known") and c["need"] == "코드 수정" else c["need"]


need_count = Counter(need_of(c) for c in decide_causes)
for x in EXTRA_DECISIONS:
    need_count[x["need"]] += 1


def badge(verdict: str, st: str) -> str:
    if verdict == "OK":
        return '<span class="b ok">정상</span>'
    if st == "fixed":
        return '<span class="b fixed">고침</span>'
    if st == "partial":
        return '<span class="b partial">일부 고침</span>'
    if verdict == "N/A":
        return '<span class="b na">해당 없음</span>'
    cls = {"DEFECT": "defect", "SUSPECT": "suspect", "KNOWN": "known"}[verdict]
    return f'<span class="b {cls}">{VERDICT_KO[verdict]}</span>'


def item_list(ids: list[str]) -> str:
    rows = []
    for i in ids:
        it = by_id[i]
        rows.append(f'<li><code>{esc(i)}</code> {esc(it["title"])} · <b>{esc(it["label"])}</b> <span class="muted">{esc(it["route"])}</span></li>')
    return f'<ul class="ids">{"".join(rows)}</ul>'


# ── 결정 필요 ──
def decide_rows() -> str:
    out = []
    groups: dict[str, list[str]] = {n: [] for n in NEED_ORDER}
    for c in decide_causes:
        need = need_of(c)
        groups.setdefault(need, [])
        kind = {"defect": "결함", "suspect": "의심", "known": "알려진 결함"}[c["kind"]]
        note = DECIDE_NOTE.get(c["code"], "")
        n = len(c["items"]) or len(c.get("related", []))
        ids = c["items"] or c.get("related", [])
        groups[need].append(
            f'<tr><td><code>{esc(c["code"])}</code></td><td><span class="k">{kind}</span> <b>{esc(c["title"])}</b>'
            f'<details><summary>설명 · 관련 수치 {n}개</summary><p>{esc(c["desc"])}</p>'
            f'{f"<p class=note>{esc(note)}</p>" if note else ""}{item_list(ids)}</details></td>'
            f'<td class="num">{n}</td><td>{esc(c["settle"])}</td></tr>')
    for x in EXTRA_DECISIONS:
        groups.setdefault(x["need"], []).append(
            f'<tr><td><code>{esc(x["code"])}</code></td><td><span class="k">수정 중 발견</span> <b>{esc(x["title"])}</b>'
            f'<details><summary>설명</summary><p>{esc(x["desc"])}</p></details></td><td class="num">—</td><td>{esc(x["settle"])}</td></tr>')
    order = ["결함 · 결정 필요"] + NEED_ORDER
    for need in order + [k for k in groups if k not in order]:
        rows = groups.get(need) or []
        if not rows:
            continue
        out.append(f'<tr class="grp"><td colspan="4">{esc(need)} <span class="muted">{len(rows)}건</span></td></tr>' + "".join(rows))
    return "".join(out)


# ── 고친 결함 ──
def fixed_rows() -> str:
    out = []
    for code, s in STATUS.items():
        c = causes[code]
        tag = '<span class="b fixed">고침</span>' if s["state"] == "fixed" else '<span class="b partial">일부 고침</span>'
        out.append(f'<tr><td><code>{esc(code)}</code></td><td>{tag} <b>{esc(c["title"])}</b>'
                   f'<details><summary>문제 · 관련 수치 {len(c["items"])}개</summary><p>{esc(c["desc"])}</p>{item_list(c["items"])}</details></td>'
                   f'<td class="num">{len(c["items"])}</td><td>{esc(s["change"])}<div class="val">{esc(s["where"])}</div><div class="val">검증: {esc(s["test"])}</div></td></tr>')
    return "".join(out)


# ── 화면별 ──
def screen_blocks() -> str:
    by_route: OrderedDict[str, list[dict]] = OrderedDict()
    for it in items:
        by_route.setdefault(it["route"], []).append(it)
    out = []
    for route, its in by_route.items():
        cnt = Counter(item_state[i["id"]] if i["verdict"] != "N/A" else "na" for i in its)
        chips = " ".join(f'<span class="c {k}">{label} {cnt[k]}</span>' for k, label in
                         (("decide", "결정 필요"), ("partial", "일부 고침"), ("fixed", "고침"), ("ok", "정상"), ("na", "해당 없음")) if cnt[k])
        rows = "".join(
            f'<tr><td><code>{esc(i["id"])}</code></td><td>{esc(i["label"])}</td><td>{badge(i["verdict"], item_state[i["id"]])}</td>'
            f'<td>{esc(i["cause"] or "")}</td><td>{esc(i["summary"])}<div class="val">{esc(i["evidence"])}</div></td></tr>' for i in its)
        out.append(f'<details class="screen"><summary><b>{esc(its[0]["title"])}</b> <span class="muted">{esc(route)}</span> · {len(its)}개 {chips}</summary>'
                   f'<table><thead><tr><th>ID</th><th>수치</th><th>판정</th><th>원인</th><th>판정 요약 · 근거</th></tr></thead><tbody>{rows}</tbody></table></details>')
    return "".join(out)


def extras_rows() -> str:
    return "".join(f'<tr><td>{esc(e["group"])}</td><td><b>{esc(e["title"])}</b><details><summary>설명</summary><p>{esc(e["desc"])}</p></details></td><td>{esc(e.get("fix", ""))}</td></tr>'
                   for e in D.get("extras", []))


na_n = verdicts["N/A"]
decide_n = len(decide_items)
page = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>수치 정확도 점검표</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
:root{{--page:#f4f4f1;--surface:#fff;--surface-3:#f2f2ee;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--line:#e8e7e1;--line-2:#d6d5cd;
--accent-ink:#184f95;--ok:#1f7a3d;--ok-bg:#e8f5ec;--fix:#1f6a8a;--fix-bg:#e6f2f8;--warn:#8a5a00;--warn-bg:#fff4dc;--bad:#a8261b;--bad-bg:#fdecea;
--known:#5b3f9e;--known-bg:#f0ebfa;--na:#6b6a64;--na-bg:#efefeb;--radius:12px;
--font:"Pretendard Variable",Pretendard,-apple-system,"Segoe UI","Malgun Gothic",system-ui,sans-serif}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--page);color:var(--ink);font:14px/1.6 var(--font);word-break:keep-all;-webkit-font-smoothing:antialiased}}
main{{max-width:1240px;margin:0 auto;padding:28px 16px 64px}}
h1{{font-size:30px;line-height:1.25;margin:4px 0 8px;font-weight:780;letter-spacing:-.02em}}
h2{{font-size:19px;margin:34px 0 6px;font-weight:750}}
.eyebrow{{font-size:12px;font-weight:650;color:var(--accent-ink);letter-spacing:.04em}}
.lede{{color:var(--ink-2);margin:0 0 6px;max-width:1000px}}
.muted{{color:var(--muted)}} .num{{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}}
code{{font:12px/1.4 ui-monospace,Consolas,monospace;background:var(--surface-3);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere;color:var(--ink-2)}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}}
.tile{{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}}
.tile .l{{font-size:12px;font-weight:600;color:var(--ink-2)}} .tile .v{{font-size:32px;font-weight:760;line-height:1.1;font-variant-numeric:tabular-nums}}
.tile .s{{font-size:12px;color:var(--muted)}}
.tile.decide{{border-top:3px solid var(--warn)}} .tile.fixed{{border-top:3px solid var(--fix)}} .tile.ok{{border-top:3px solid var(--ok)}} .tile.na{{border-top:3px solid var(--line-2)}}
.card{{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow-x:auto}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}}
th{{background:var(--surface-3);font-weight:650;color:var(--ink-2);white-space:nowrap}}
td:first-child code{{white-space:nowrap}}
tr.grp td{{background:#fbfaf6;font-weight:700;color:var(--ink)}}
.val{{display:block;font-size:12px;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}}
.note{{background:var(--warn-bg);border-radius:6px;padding:6px 8px;color:var(--warn)}}
details summary{{cursor:pointer;color:var(--accent-ink);font-size:12px;margin-top:3px}}
details p{{margin:6px 0;color:var(--ink-2)}}
ul.ids{{margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--ink-2)}}
.b{{display:inline-block;font-size:11px;font-weight:650;border-radius:999px;padding:1px 8px;white-space:nowrap}}
.b.ok{{background:var(--ok-bg);color:var(--ok)}} .b.fixed{{background:var(--fix-bg);color:var(--fix)}} .b.partial{{background:var(--fix-bg);color:var(--warn)}}
.b.defect{{background:var(--bad-bg);color:var(--bad)}} .b.suspect{{background:var(--warn-bg);color:var(--warn)}} .b.known{{background:var(--known-bg);color:var(--known)}} .b.na{{background:var(--na-bg);color:var(--na)}}
.k{{font-size:11px;color:var(--muted);font-weight:600}}
details.screen{{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);margin:8px 0;padding:8px 12px}}
details.screen>summary{{font-size:14px;color:var(--ink)}}
.c{{display:inline-block;font-size:11px;border-radius:999px;padding:0 7px;margin-left:4px;background:var(--surface-3);color:var(--ink-2)}}
.c.decide{{background:var(--warn-bg);color:var(--warn)}} .c.fixed,.c.partial{{background:var(--fix-bg);color:var(--fix)}} .c.ok{{background:var(--ok-bg);color:var(--ok)}}
footer{{margin-top:36px;font-size:12px;color:var(--muted)}}
</style></head>
<body><main>
<div class="eyebrow">HMG GEO HUB · 화면 수치 정확도 감사 · {esc(D["date"])}</div>
<h1>★ 수치 정확도 점검표</h1>
<p class="lede">화면에 보이는 수치 364개(화면 37개 · 지표 175개)를 화면 표시 → 어댑터 → API → SQL 까지 따라가, <b>정의대로 수학적으로 맞게 계산되는가</b> 하나만 판정했다.
API 경로 기준이며 레거시와 같은지는 판정하지 않았다. 명확한 결함은 고쳤고(워킹트리, 커밋 전), 판단이 필요한 항목은 아래 목록에 남겼다.</p>

<h2>진행 현황</h2>
<div class="tiles">
<div class="tile decide"><div class="l">결정 필요</div><div class="v">{decide_n}</div><div class="s">결함 {sum(1 for i in decide_items if i["verdict"] == "DEFECT")} · 의심 {sum(1 for i in decide_items if i["verdict"] == "SUSPECT")} · 알려진 {sum(1 for i in decide_items if i["verdict"] == "KNOWN")}</div></div>
<div class="tile fixed"><div class="l">고침</div><div class="v">{fixed_n}</div><div class="s">일부 고침 {partial_n} 별도</div></div>
<div class="tile ok"><div class="l">정상</div><div class="v">{verdicts["OK"]}</div><div class="s">정의대로 맞음</div></div>
<div class="tile na"><div class="l">해당 없음</div><div class="v">{na_n}</div><div class="s">샘플 화면 · API 값 없음</div></div>
<div class="tile"><div class="l">판정 합계</div><div class="v">364</div><div class="s">감사 판정: 결함 {verdicts["DEFECT"]} · 의심 {verdicts["SUSPECT"]} · 알려진 {verdicts["KNOWN"]}</div></div>
</div>
<p class="muted">결정 필요 원인 {len(decide_causes) + len(EXTRA_DECISIONS)}개 — {" · ".join(f"{k} {v}" for k, v in need_count.items())}</p>

<h2>결정이 필요한 항목</h2>
<p class="lede">원인별로 묶었다. 오른쪽 칸이 판정·수정에 필요한 것이다(결정할 내용, stg 확인 쿼리, 문구 수정 방향).</p>
<div class="card"><table><thead><tr><th>코드</th><th>내용</th><th>수치</th><th>판정에 필요한 것</th></tr></thead><tbody>{decide_rows()}</tbody></table></div>

<h2>이번에 고친 결함</h2>
<p class="lede">모두 재현 시험(수정 전 실패)을 먼저 쓰고 고쳤다. off 프로필 SQL 은 바뀌지 않는다(백엔드 수정은 응답 필드 추가와 관리자 count 뿐).</p>
<div class="card"><table><thead><tr><th>코드</th><th>내용</th><th>수치</th><th>바꾼 것 · 위치 · 검증</th></tr></thead><tbody>{fixed_rows()}</tbody></table></div>

<h2>화면별 전체 판정</h2>
<p class="lede">364개 항목 전부. 화면을 펼치면 항목별 판정·원인·근거(file:line)가 나온다.</p>
{screen_blocks()}

<h2>범위 밖 발견</h2>
<p class="lede">364개 수치에는 들어가지 않지만 감사 중 같이 찾은 것. 고치지 않았다.</p>
<div class="card"><table><thead><tr><th>묶음</th><th>내용</th><th>수정 방향</th></tr></thead><tbody>{extras_rows()}</tbody></table></div>

<footer>생성: docs/reports/부록/지표 점검표 생성기/build_accuracy_audit.py · 데이터: 조사 데이터/accuracy_audit.json · 판정 기준: 정의대로 수학적으로 맞는가(API 경로). 근거의 약어(F: front/, B: back/app/ 등)는 데이터 파일 abbr 에 있다.</footer>
</main></body></html>
"""
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(page)
print(f"{OUT}: 364개 · 결정 필요 {decide_n} · 고침 {fixed_n} · 일부 {partial_n} · 정상 {verdicts['OK']} · 해당 없음 {na_n}")
