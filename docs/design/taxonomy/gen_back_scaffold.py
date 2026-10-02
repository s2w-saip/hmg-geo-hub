#!/usr/bin/env python3
"""taxonomy.json → 새 레포 back/ 골격(기능 중심 폴더). 구현 전 자리 표시: 라우터 스텁은 501.
사용: gen_back_scaffold.py <repo 루트>                 골격 전체(기존 파일은 덮지 않음, views.json·VIEWS.md·taxonomy.json 은 덮음)
      gen_back_scaffold.py <repo 루트> --views-only    화면 색인 두 파일(back/app/views/views.json·VIEWS.md)만 다시 쓴다
                                                     (build_taxonomy.py 로 taxonomy.json 을 만든 뒤. 다른 파일은 건드리지 않는다)
      gen_back_scaffold.py <repo 루트> --sync          --views-only + back/taxonomy.json·FEATURES.md 동기 + 기존 기능 README 의 두 절만 갱신
                                                     ('## 엔드포인트' 표에 카탈로그에 새로 생긴 행 추가, '## 이 기능을 쓰는 화면' 목록 교체).
                                                     README 의 다른 절(구현 메모 등)과 손으로 더한 엔드포인트 행은 그대로 둔다
"""
import json
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = sys.argv[1]
VIEWS_ONLY = "--views-only" in sys.argv[2:]
SYNC = "--sync" in sys.argv[2:]
tx = json.load(open(os.path.join(HERE, "taxonomy.json"), encoding="utf-8"))
B = os.path.join(R, "back")


def write_views(back: str, t: dict) -> None:
    """화면 색인(views.json·VIEWS.md). 정본 화면표는 build_taxonomy.py VIEWS_CANON(프론트 어댑터 설계 3.1·3.3·3.4)."""
    vdir = os.path.join(back, "app", "views")
    os.makedirs(vdir, exist_ok=True)
    views = t["views"]
    used = {x for xs in views.values() for x in xs}
    unused = [f["id"] for f in t["features"] if f["category"] != "ingest" and f["id"] not in used]
    vrows = "\n".join(f"| `{r}` | " + ", ".join(f"`{x}`" for x in fids) + " |" for r, fids in views.items())
    urows = "\n".join(f"- `{x}`" for x in unused) or "- (없음)"
    md = f"""# 화면별 색인(프론트 경로 → 기능 모듈)

프론트는 그대로 두고, 각 화면이 부르던 서버 데이터 함수를 아래 기능의 API 호출로 바꾼다.
생성: `docs/design/taxonomy/build_taxonomy.py`(정본 화면표 VIEWS_CANON) → `gen_back_scaffold.py <repo> --sync`
(views.json·VIEWS.md·back/taxonomy.json·FEATURES.md·기능 README 화면 목록을 함께 맞춘다). 손으로 고치지 않는다.
정합 테스트: back/tests/core/test_views_index.py(생성기 재실행 바이트 재현·README 화면 목록·/v1/qa 카탈로그).

- 정본: 프론트 어댑터 설계 front-adapter-plan.md 3.1 점검 결과와 3.3·3.4 매핑표, 부록 A~F 화면별 대조(2026-09-28).
- 키는 데이터 접근이 있는 프론트 page 경로다. 리다이렉트 전용(/standard/answer-analysis·/projects/[id]/analysis 등)·로그인·정적 샘플은 뺐다.
  `/` 는 역할별 랜딩 리다이렉트(로그인 착지 판정 = GET /v1/auth/me).
- 공용 레이아웃 게이트도 그 화면의 기능으로 적는다: 프로젝트 하위 화면 `projects.project.core`, 검수 콘솔 전 화면 `qa.review.sessions`.
- 답변 원문 모달을 여는 화면은 `analytics.answers.detail` 을 갖는다. 드릴다운의 답변 참조는 각 목록 응답의 AnswerRef 로 온다.
- 예전 파일의 `/`·`/standard` 키는 생성기 파싱 산물이었다(screens 문자열을 ( · , {{ 에서 잘랐음). 파서는 고쳤고 교차 확인용으로만 쓴다.

| 화면 | 기능 |
| --- | --- |
{vrows}

## 현행 화면 소비자가 없는 기능

운영·워커 전용이거나(새 운영 화면은 범위 밖, 결정 D11) 다른 기능 응답으로 대체된 것.

{urows}
"""
    open(os.path.join(vdir, "VIEWS.md"), "w", encoding="utf-8").write(md)
    with open(os.path.join(vdir, "views.json"), "w", encoding="utf-8") as fh:
        json.dump(views, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


def check_front_pages(repo: str, views: dict) -> None:
    """views 키가 실제 프론트 page(front/app/[locale]/**/page.tsx, 라우트 그룹 '(x)' 제거)인지 단언하고, 빠진 page 를 출력한다."""
    import glob
    base = os.path.join(repo, "front", "app", "[locale]")
    if not os.path.isdir(base):
        return
    pages = set()
    for p in glob.glob(os.path.join(glob.escape(base), "**", "page.tsx"), recursive=True):
        segs = os.path.relpath(os.path.dirname(p), base).split(os.sep)
        pages.add("/" + "/".join(x for x in segs if x != "." and not (x.startswith("(") and x.endswith(")"))))
    pages = {p.rstrip("/") or "/" for p in pages}
    bad = sorted(k for k in views if k not in pages)
    assert not bad, f"views 키가 프론트 page 가 아니다: {bad}"
    print(f"front pages {len(pages)} · views {len(views)} · 색인 밖 page(리다이렉트·로그인·정적) {sorted(pages - set(views))}")


def feature_dir(back: str, f: dict) -> str:
    is_ingest = f["category"] == "ingest"
    return os.path.join(back, "ingest" if is_ingest else "app/features", *(([] if is_ingest else [f["category"]]) + [f["domain"], f["feature"]]))


def screens_block(fid: str, views_by_feature: dict) -> str:
    return "\n".join(f"- `{v}`" for v in sorted(views_by_feature.get(fid, []))) or "- (화면 없음: 운영·워커)"


def features_md(t: dict) -> str:
    """분류 트리 색인(back/FEATURES.md) 본문. 전부 생성물이다."""
    tree = defaultdict(lambda: defaultdict(list))
    for f in t["features"]:
        tree[(f["category"], f["category_ko"])][(f["domain"], f["domain_ko"])].append(f)
    lines = ["# 기능 분류 체계(대분류 → 도메인 → 최소 기능)", "",
             f"기능 {len(t['features'])}개 · 엔드포인트 {sum(len(f['endpoints']) for f in t['features'])}개. 정본 `taxonomy.json`.", ""]
    for (ck, cn), doms in tree.items():
        lines.append(f"## {cn} `{ck}`")
        for (dk, dn), fs in doms.items():
            lines.append(f"- **{dn}** `{dk}`: " + " · ".join(f"{x['feature_ko']} `{x['feature']}`({len(x['endpoints'])})" for x in fs))
        lines.append("")
    lines += ["## 제외", ""] + [f"- {e['id']} {e['method']} {e['path']}: {e['why']}" for e in t["excluded"]]
    return "\n".join(lines) + "\n"


def keep_notes(block: str) -> str:
    """화면 절의 손 메모(경로 한 줄 '- `…`'·자리 표시가 아닌 항목과 그 들여쓴 이어짐 줄)는 생성 목록 뒤에 그대로 남긴다."""
    out, keep = [], False
    for line in block.splitlines(keepends=True):
        if line.startswith("- "):
            keep = not (re.fullmatch(r"- `[^`]*`\n?", line) or line.rstrip("\n") == "- (화면 없음: 운영·워커)")
        if keep:
            out.append(line)
    return "".join(out)


def sync_readmes(back: str, t: dict) -> list[str]:
    """기존 기능 README 의 '이 기능을 쓰는 화면' 목록을 views 로 교체하고, 엔드포인트 표에 없는 카탈로그 행을 끝에 더한다. 바뀐 파일 목록."""
    vbf = defaultdict(list)
    for route, fids in t["views"].items():
        for x in fids:
            vbf[x].append(route)
    changed = []
    for f in t["features"]:
        p = os.path.join(feature_dir(back, f), "README.md")
        if not os.path.exists(p):
            continue
        s = open(p, encoding="utf-8").read()
        new = re.sub(r"(## 이 기능을 쓰는 화면[^\n]*\n)((?:(?:- |  )[^\n]*\n)*)",
                     lambda m: m.group(1) + screens_block(f["id"], vbf) + "\n" + keep_notes(m.group(2)), s, count=1)
        m = re.search(r"(## 엔드포인트\n\| 메서드 [^\n]*\n\| --- [^\n]*\n)((?:\|[^\n]*\n)*)", new)
        if m:
            have = {(r.split("|")[1].strip(), r.split("|")[2].strip().strip("`")) for r in m.group(2).splitlines() if r.count("|") >= 3}
            add = "".join(f"| {e['method']} | `{e['path']}` | {e['risk'] or ''} |\n" for e in f["endpoints"] if (e["method"], e["path"]) not in have)
            new = new[:m.end(2)] + add + new[m.end(2):]
        if new != s:
            open(p, "w", encoding="utf-8").write(new)
            changed.append(os.path.relpath(p, back))
    return changed


if VIEWS_ONLY or SYNC:
    check_front_pages(R, tx["views"])
    write_views(B, tx)
    print("views:", len(tx["views"]), "pairs:", sum(len(v) for v in tx["views"].values()))
    if SYNC:
        json.dump(tx, open(os.path.join(B, "taxonomy.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        open(os.path.join(B, "FEATURES.md"), "w", encoding="utf-8").write(features_md(tx))
        ch = sync_readmes(B, tx)
        print(f"taxonomy.json 동기 · README 갱신 {len(ch)}개")
        for x in ch:
            print("  ", x)
    sys.exit(0)


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        open(path, "w", encoding="utf-8").write(text)


def fn_name(method, path, i):
    s = re.sub(r"\{[^}]+\}", "by_id", path.split("?")[0])
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower().replace("v1_", "", 1)
    return f"{method.split('/')[0].lower()}_{s or 'root'}_{i}"


views_by_feature = defaultdict(list)
for route, fids in tx["views"].items():
    for f in fids:
        views_by_feature[f].append(route)

registry = []
for f in tx["features"]:
    is_ingest = f["category"] == "ingest"
    base = os.path.join(B, "ingest" if is_ingest else "app/features", *(([] if is_ingest else [f["category"]]) + [f["domain"], f["feature"]]))
    rel_mod = os.path.relpath(base, B).replace(os.sep, ".")
    ep_rows = "\n".join(f"| {e['method']} | `{e['path']}` | {e['risk'] or ''} |" for e in f["endpoints"])
    unit_links = ", ".join(f"[{u}](../../../../../docs/design/api/units/)" for u in f["units"])
    views = "\n".join(f"- `{v}`" for v in sorted(views_by_feature.get(f["id"], []))) or "- (화면 없음: 운영·워커)"
    w(os.path.join(base, "README.md"), f"""# {f['id']} · {f['category_ko']} / {f['domain_ko']} / {f['feature_ko']}

설계 단위: {', '.join(f['units'])} · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
{ep_rows}

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
{views}

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
""")
    w(os.path.join(base, "__init__.py"), "")
    if not is_ingest:
        http = [e for e in f["endpoints"] if e["method"] in ("GET", "POST", "PUT", "PATCH", "DELETE")]
        funcs = []
        for i, e in enumerate(http):
            path = e["path"].split("?")[0]
            funcs.append(f'''
@router.{e["method"].lower()}("{path}", status_code=501, summary={json.dumps(e["summary"][:120], ensure_ascii=False)})
async def {fn_name(e["method"], path, i)}() -> dict:
    """{f["id"]}: 구현 전 자리 표시(명세: README.md)."""
    return {{"error": {{"code": "not_implemented", "message": "{f["id"]}"}}}}
''')
        w(os.path.join(base, "router.py"), f'''"""{f["id"]} {f["feature_ko"]} 라우터. 경로는 /v1 접두 포함 전체 경로."""
from fastapi import APIRouter

router = APIRouter(tags=["{f["category"]}.{f["domain"]}"])
''' + "".join(funcs))
        for name, doc in (("schemas.py", "요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."),
                          ("service.py", "업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지)."),
                          ("queries.py", "읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.")):
            w(os.path.join(base, name), f'"""{f["id"]} {doc}"""\n')
        w(os.path.join(base, "tests", "__init__.py"), "")
        registry.append((f["id"], f"{rel_mod}.router"))

# 기능 레지스트리·앱 진입점
w(os.path.join(B, "app", "features", "__init__.py"), '"""기능 모듈 레지스트리: 대분류 → 도메인 → 최소 기능. taxonomy.json 에서 생성."""\n'
  "FEATURE_ROUTERS = [\n" + "".join(f'    ("{i}", "{m}"),\n' for i, m in registry) + "]\n")
w(os.path.join(B, "app", "__init__.py"), "")
w(os.path.join(B, "app", "main.py"), '''"""FastAPI 앱 진입점: 기능 라우터를 레지스트리 순서로 등록한다."""
import importlib

from fastapi import FastAPI

from app.features import FEATURE_ROUTERS

app = FastAPI(title="HMG-GEO-HUB API", version="0.1.0")


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict:
    return {"ok": True}


for _fid, _mod in FEATURE_ROUTERS:
    app.include_router(importlib.import_module(_mod).router)
''')
for name, doc in {"config.py": "환경 설정(ENV=stg|prod, DB 접속은 Secrets Manager).", "db.py": "커넥션 풀 4종(api_ro·api_rw·admin_long·qa_gate), 요청당 한 커넥션·READ ONLY 트랜잭션, statement_cache_size=0(PgBouncer).",
                  "auth.py": "Supabase JWT(JWKS) 검증, 세션·역할·데이터 스코프(default-deny), QA 별도 게이트.", "filters.py": "공통 필터 모델(CommonFilters), 표면별 지원 축 → ignored_filters·dropped_filters.",
                  "envelope.py": "응답 봉투 {data, meta}, Ratio{num, den}.", "cycles.py": "창 해석·함대 스냅샷 규칙(Q1)·숨김 계열 상수. 사실 표 질의에 surface·round_date·cyc_key 술어 강제.",
                  "measure.py": "지표 빌더(own_cols·answer_counts·citation_counts·url_rates·brand_rows·tone_expr·prompt_counts).", "pagination.py": "키셋 커서(필터 해시·generation), 422·409.",
                  "errors.py": "오류 모델 {error:{code, message, details}}.", "write.py": "enqueue_change(judgment_change)·enqueue_scope(outbox)·audited_user_write·access_audit(민감 조회만, 비동기)."}.items():
    w(os.path.join(B, "app", "core", name), f'"""{doc}"""\n')
w(os.path.join(B, "app", "core", "__init__.py"), "")
# 화면별 색인
write_views(B, tx)
# 분류 트리 색인
w(os.path.join(B, "FEATURES.md"), features_md(tx))
json.dump(tx, open(os.path.join(B, "taxonomy.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
w(os.path.join(B, "pyproject.toml"), '''[project]
name = "hmg-geo-hub-back"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi>=0.115", "uvicorn[standard]>=0.30", "pydantic>=2.8", "sqlalchemy>=2.0", "asyncpg>=0.29", "pyjwt[crypto]>=2.9", "httpx>=0.27", "boto3>=1.35"]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "ruff>=0.6"]

[tool.pytest.ini_options]
pythonpath = ["."]
''')
print("features:", len(tx["features"]), "routers:", len(registry))
