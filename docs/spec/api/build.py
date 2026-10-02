#!/usr/bin/env python3
"""API 명세 사이트 생성: modules/*.json → out/index.html + out/m-<key>.html (zip 으로 사내 공유 사이트 한 slug).
정본: 전체-통합.json(api_catalog 179), 모듈-*.json(모듈 요약·확정 엔드포인트), 단위 *.json(상세), DECISIONS-API.md.
"""
import glob
import html
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "..", "modules")
OUT = os.path.join(HERE, "out")
SPEC_TPL = "notes/hmg-refactor-spec/spec.template.html"
os.makedirs(OUT, exist_ok=True)

MODULES = [  # key, 이름, 단위 ID 접두, 모듈 파일(오케스트레이션 있을 때)
    ("filters", "필터", ["F-"], "모듈-필터"), ("kpi", "KPI", ["K-"], "모듈-KPI"), ("trend", "추이", ["T-"], None),
    ("mentions", "언급", ["M-"], "모듈-언급"), ("citations", "인용", ["C-"], "모듈-인용"), ("geo", "국가별", ["G-"], None),
    ("answers", "답변 드릴다운", ["AN-"], "모듈-답변-드릴다운"), ("funnel", "AI 퍼널", ["FU-"], "모듈-AI-퍼널"),
    ("prompts", "프롬프트", ["P-"], "모듈-프롬프트"), ("projects", "프로젝트", ["PJ-"], "모듈-프로젝트"),
    ("admin", "관리자", ["AD-"], "모듈-관리자"), ("auth", "인증", ["AU-"], None), ("qa", "검수 콘솔", ["QA-"], "모듈-검수-콘솔"),
    ("intent", "고객 관심", ["IN-"], "모듈-고객-관심"), ("contextmap", "컨텍스트 맵(intent 로 흡수)", ["CM-"], None),
    ("webgeo", "웹 크롤·SEO(제거)", ["WG-"], None), ("ingest", "적재 파이프라인", ["IG-"], "모듈-적재-파이프라인"),
]

tpl = open(SPEC_TPL, encoding="utf-8").read()
CSS = tpl[tpl.index("<style>") + 7: tpl.index("</style>")]
EXTRA_CSS = """
.apiwrap{max-width:1100px;margin:0 auto;padding:24px 16px 80px;min-width:0}.apiwrap .m,.apiwrap td,.apiwrap dd,.apiwrap p,.apiwrap li{overflow-wrap:anywhere}
.apiwrap td.nw{white-space:nowrap;overflow-wrap:normal}.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.router{background:var(--code-bg);border-radius:8px;padding:10px 12px;font-size:12.5px}
.crumb{font-size:13px;color:var(--ink3);margin:0 0 6px}.crumb a{color:var(--accent);text-decoration:none}
.unit{border-top:1px solid var(--line);padding-top:18px;margin-top:22px}
.unit h3{margin:0 0 6px;font-size:18px}
dl.kv{display:grid;grid-template-columns:140px minmax(0,1fr);gap:6px 14px;margin:10px 0}
dl.kv dt{color:var(--ink3);font-size:13px}dl.kv dd{margin:0;min-width:0;overflow-wrap:break-word}
pre.blk{background:var(--code-bg);border-radius:8px;padding:12px;overflow-x:auto;font-size:12.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word}
ul.tight{margin:4px 0;padding-left:18px}ul.tight li{margin:2px 0;overflow-wrap:break-word}
.risk{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;white-space:nowrap}
.risk.low{background:var(--ok-soft);color:var(--ok)}.risk.medium{background:var(--warn-soft);color:var(--warn)}.risk.high{background:var(--bad-soft);color:var(--bad)}.risk.na{background:var(--muted-soft);color:var(--ink3)}
.m{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.navmods{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}.navmods a{font-size:13px;padding:3px 9px;border:1px solid var(--line);border-radius:14px;text-decoration:none;color:var(--ink2);background:var(--panel)}
@media (max-width:640px){dl.kv{grid-template-columns:1fr}dl.kv dt{margin-top:6px}}
"""
e = lambda s: html.escape(str(s if s is not None else ""))


def risk_badge(r):
    s = str(r or "")
    cls = "high" if "high" in s else "medium" if "medium" in s else "low" if "low" in s else "na"
    return f'<span class="risk {cls}">{e(s)}</span>'


def page(title, body, desc=""):
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title><meta name="description" content="{e(desc)}"><style>{CSS}{EXTRA_CSS}</style></head>
<body><main class="apiwrap">{body}</main></body></html>"""


def load(name):
    p = os.path.join(MOD, name + ".json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None


integ = load("전체-통합")
catalog = integ["api_catalog"]
unit_files = {os.path.basename(f)[:-5]: f for f in glob.glob(os.path.join(MOD, "*.json"))
              if re.match(r"^[A-Z]+-\d", os.path.basename(f))}
units = {}
for name, f in unit_files.items():
    d = json.load(open(f, encoding="utf-8"))
    units[d["id"]] = d


def mod_units(prefixes):
    ids = [u for u in units if any(u.startswith(p) and re.match(rf"^{re.escape(p)}\d", u) for p in prefixes)]
    return sorted(ids, key=lambda x: (x.split("-")[0], int(re.sub(r"\D", "", x.split("-")[1]) or 0)))


def lst(items):
    items = items or []
    return "<ul class='tight'>" + "".join(f"<li>{e(i)}</li>" for i in items) + "</ul>" if items else "<span class='muted'>없음</span>"


def unit_html(u):
    f = u.get("filters") or {}
    perf = u.get("perf") or {}
    eps = "".join(f"<tr><td class='m nw'>{e(x.get('method'))}</td><td class='m nw'>{e(x.get('path'))}</td><td>{e(x.get('summary'))}</td></tr>"
                  for x in u.get("endpoints") or [])
    return f"""<section class="unit" id="{e(u['id'])}"><h3>{e(u['id'])} {e(u['title'])} {risk_badge(perf.get('risk'))}</h3>
<p>{e(u.get('purpose'))}</p>
<div class="tbl"><table><tr><th>메서드</th><th>경로</th><th>요약</th></tr>{eps}</table></div>
<dl class="kv">
<dt>화면(현행)</dt><dd>{lst(u.get('screens'))}</dd>
<dt>대체하는 현행 코드</dt><dd>{lst(u.get('current_refs'))}</dd>
<dt>필터 지원</dt><dd>{e(', '.join(f.get('supported') or []))}</dd>
<dt>필터 무시(ignored)</dt><dd>{e(', '.join(f.get('ignored') or []))}</dd>
<dt>추가 파라미터</dt><dd>{lst(f.get('extra_params'))}</dd>
<dt>지표·규칙</dt><dd>{lst(u.get('metrics_rules'))}</dd>
<dt>읽는 표·열</dt><dd>{lst(u.get('read_model'))}</dd>
<dt>권한</dt><dd>{e(u.get('auth'))}</dd>
<dt>쓰기</dt><dd>{e(u.get('writes'))}</dd>
<dt>성능(10배)</dt><dd>{e(perf.get('rows_scanned'))}<br><span class="muted">인덱스: {e(', '.join(perf.get('indexes') or []))}</span><br>{e(perf.get('notes'))}</dd>
<dt>신구 대조</dt><dd>{e(u.get('parity'))}</dd>
<dt>열린 질문</dt><dd>{lst(u.get('open_questions'))}</dd>
</dl>
<details><summary>응답 형태</summary><pre class="blk">{e(u.get('response'))}</pre></details>
<details><summary>쿼리 설계</summary><pre class="blk">{e(u.get('query_design'))}</pre></details>
</section>"""


navmods = "<div class='navmods'>" + "".join(f"<a href='m-{k}.html'>{e(n)}</a>" for k, n, _, _ in MODULES) + "</div>"
mod_rows = []
for key, name, prefixes, mfile in MODULES:
    m = load(mfile) if mfile else None
    ids = mod_units(prefixes)
    cat = [c for c in catalog if c.get("module") == key]
    body = [f"<p class='crumb'><a href='index.html'>API 명세</a> / {e(name)}</p><h1>{e(name)}</h1>"]
    if m: body.append(f"<p class='m router'>{e(m['router'])}</p>")
    if m:
        body.append(f"<p>{e(m.get('summary'))}</p>")
        rows = "".join(f"<tr><td class='nw'><a href='#{e(x['id'])}'>{e(x['id'])}</a></td><td class='m nw'>{e(x['method'])}</td><td class='m nw'>{e(x['path'])}</td><td>{e(x['summary'])}</td><td>{risk_badge(x.get('risk'))}</td></tr>"
                       for x in m.get("endpoints_table") or [])
        body.append(f"<h2>확정 엔드포인트</h2><div class='tbl'><table><tr><th>단위</th><th>메서드</th><th>경로</th><th>요약</th><th>위험</th></tr>{rows}</table></div>")
        body.append(f"<h2>모듈 공통</h2><dl class='kv'><dt>공통 구성요소</dt><dd>{lst(m.get('shared'))}</dd><dt>단위 간 정리</dt><dd>{lst(m.get('consistency_fixes'))}</dd><dt>의존</dt><dd>{lst(m.get('deps'))}</dd><dt>위험</dt><dd>{lst(m.get('risks'))}</dd></dl>")
    body.append("<h2>단위 상세</h2>" + "".join(unit_html(units[i]) for i in ids))
    body.append(navmods)
    open(os.path.join(OUT, f"m-{key}.html"), "w", encoding="utf-8").write(page(f"{name} API", "".join(body)))
    risks = [str(x.get("risk", "")) for x in cat]
    worst = "high" if any("high" in r for r in risks) else "medium" if any("medium" in r for r in risks) else "low" if risks else "n/a"
    mod_rows.append(f"<tr><td><a href='m-{key}.html'>{e(name)}</a></td><td class='m'>{e(m['router'] if m else ('/v1/' + key))}</td><td>{len(cat)}</td><td>{len(ids)}</td><td>{risk_badge(worst)}</td></tr>")

cat_rows = "".join(
    f"<tr><td class='nw'><a href='m-{e(c['module'])}.html#{e(c['id'])}'>{e(c['id'])}</a></td><td class='m nw'>{e(c['method'])}</td><td class='m nw'>{e(c['path'])}</td><td><div class='clamp'>{e(c['summary'])}</div></td><td>{risk_badge(c.get('risk'))}</td></tr>"
    for c in catalog)
dec = open(os.path.join(MOD, "DECISIONS-API.md"), encoding="utf-8").read()
dec_rows = "".join(f"<tr><td>{e(m.group(1))}</td><td>{e(m.group(2))}</td><td>{e(m.group(3))}</td></tr>"
                   for m in re.finditer(r"^\| \**(Q\d+)\** \| ([^|]+) \| ([^|]+) \|", dec, re.M))
index = f"""<h1>HMG-GEO-HUB API 명세</h1>
<p class="muted">FastAPI(EC2) · 경로 접두 <span class="m">/v1</span> · 읽기 스키마 rd·app·ext · 모듈 {len(MODULES)}개 · API {len(catalog)}개 · 기준: DB 설계 v2.1(DB-v2.1.sql), 결정 D1~D8·A1~A17·G-01~G-26·Q1~Q19</p>
<h2>원칙</h2><ul class="tight">
<li><b>프론트는 그대로 가져온다(제품 책임자 2026-09-28).</b> 현행 Next.js 화면·컴포넌트는 유지하고, 화면이 부르던 서버 데이터 함수(각 단위의 "대체하는 현행 코드")만 이 API 호출로 바꾼다. 응답은 현행 컴포넌트가 쓰는 타입에 맞춘다(어댑터는 프론트 데이터 계층 한 곳).</li>
<li>기능 = API 하나, 엔드포인트 병합 금지(Q6). 모든 읽기 API 는 공통 필터 모델을 받고, 지원하지 않는 축은 <span class="m">meta.ignored_filters</span>, 권한 밖 값은 <span class="m">meta.dropped_filters</span>.</li>
<li>응답 봉투 <span class="m">{{data, meta:{{surface, mode, as_of, cycles, generation, ignored_filters, dropped_filters, suppressed}}}}</span>, 비율은 분자·분모 정수 동시 반환.</li>
<li>결과 캐시·사전 집계 없음(D8). 성능 판정은 RDS 실측 게이트(현재 테스트 인프라 HMG-GEO-HUB, db.r7g.xlarge).</li>
<li>인증: Supabase JWT(JWKS) 검증, 스코프는 서버 계산 default-deny. QA 콘솔은 별도 게이트(Q17).</li></ul>
<h2>모듈</h2><div class="tbl"><table><tr><th>모듈</th><th>라우터</th><th>API</th><th>단위</th><th>최고 위험</th></tr>{''.join(mod_rows)}</table></div>
<h2>전체 카탈로그 ({len(catalog)})</h2><div class="tbl"><table><tr><th>단위</th><th>메서드</th><th>경로</th><th>요약</th><th>위험</th></tr>{cat_rows}</table></div>
<h2>API 결정(Q1~Q19)</h2><div class="tbl"><table><tr><th>Q</th><th>쟁점</th><th>결정</th></tr>{dec_rows}</table></div>
{navmods}"""
open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page("HMG-GEO-HUB API 명세", index, "모듈 17·API 179 설계 명세"))
print("pages:", len(os.listdir(OUT)), "catalog:", len(catalog), "units:", len(units), "decisions:", dec_rows.count("<tr>"))
