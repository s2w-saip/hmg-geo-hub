"""BE 코드 스캔: (1) 라우트 표 (2) 모듈별 실제 SQL 객체 참조(주석·docstring·description 문자열 제외) (3) core import 그래프
(4) judgment_change kind 쓰기. 결과 be_scan.json."""
import ast, io, json, os, re, sys, tokenize

APP = sys.argv[1]          # back/app
OBJ_TSV = sys.argv[2]      # db_cols.tsv (relations)
FUNCS = sys.argv[3]        # db_funcs.txt (schema.func per line)
OUT = sys.argv[4]

objs = set()
for line in open(OBJ_TSV, encoding='utf-8'):
    sch, rel, kind, col, typ = line.rstrip('\n').split('\t')
    objs.add(f'{sch}.{rel}')
funcs = {l.strip() for l in open(FUNCS, encoding='utf-8') if l.strip()}
known = objs | funcs
REF = re.compile(r'\b(rd|frz|ext|app|ing|rcache|mig)\.([a-z_][a-z0-9_]*)\b')
SQLISH = re.compile(r'\b(SELECT|FROM|JOIN|INSERT|UPDATE|DELETE|WITH|EXISTS|INTO|RETURNING|VALUES|WHERE)\b', re.I)
KINDS = ['catalog', 'prompt_kind', 'entity', 'brand_rule', 'competitor_token', 'hidden_market', 'citation_override', 'owned_base',
         'website_catalog', 'project_setting', 'project_owned_base', 'project_target_url', 'rule_param', 'scope_prompt', 'cycle_admin',
         'anchor_pin', 'answer_drop', 'report_publication', 'dfs_fetch', 'ga4_property', 'ga4_tracked_event', 'entity_version']


def docstring_lines(src):
    lines = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return lines
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            b = node.body
            if b and isinstance(b[0], ast.Expr) and isinstance(getattr(b[0], 'value', None), ast.Constant) and isinstance(b[0].value.value, str):
                for ln in range(b[0].lineno, b[0].end_lineno + 1):
                    lines.add(ln)
        # Field(description=...) / summary= / help= strings
        if isinstance(node, ast.keyword) and node.arg in ('description', 'summary', 'title', 'help', 'detail', 'message'):
            v = node.value
            for sub in ast.walk(v):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                    for ln in range(sub.lineno, sub.end_lineno + 1):
                        lines.add(ln)
    return lines


def sql_refs(src):
    """문자열 토큰 중 SQL 처럼 보이거나 객체 이름 하나인 것만, 주석·docstring·설명 인자 제외."""
    skip = docstring_lines(src)
    found = set()
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError):
        return found
    for t in toks:
        if t.type != tokenize.STRING and not (t.type == getattr(tokenize, 'FSTRING_MIDDLE', -1)):
            continue
        if t.start[0] in skip:
            continue
        s = t.string
        body = re.sub(r'^[rbfuRBFU]*("""|\'\'\'|"|\')', '', s)
        refs = {f'{a}.{b}' for a, b in REF.findall(body)}
        if not refs:
            continue
        stripped = body.strip('"\' ')
        if SQLISH.search(body) or (len(refs) == 1 and re.fullmatch(r'[a-z_]+\.[a-z0-9_]+', stripped)):
            found |= refs
    return found


routes, mods, imports, kinds_w = [], {}, {}, {}
for dp, dn, fn in os.walk(APP):
    d = dp.replace(os.sep, '/')
    if '/tests' in d or '__pycache__' in d:
        continue
    for f in fn:
        if not f.endswith('.py'):
            continue
        p = d + '/' + f
        rel = p[len(APP.replace(os.sep, '/')) + 1:]
        parts = rel.split('/')
        mod = '/'.join(parts[1:4]) if parts[0] == 'features' and len(parts) >= 4 else ('core/' + parts[1].replace('.py', '') if parts[0] == 'core' else '/'.join(parts[:2]))
        src = open(p, encoding='utf-8').read()
        refs = sql_refs(src)
        # prefix refs like frz.card_ (f-string assembly) -> expand to known objects with that prefix
        exp = set()
        for r in refs:
            if r in known:
                exp.add(r)
            elif r.endswith('_'):
                exp |= {k for k in known if k.startswith(r)}
            else:
                exp.add('?' + r)
        mods.setdefault(mod, set()).update(exp)
        for m in re.finditer(r'from app\.core(?:\.([a-z_]+))?(?:\.[a-z_.]+)? import ([^\n(]+|\([^)]*\))', src):
            if m.group(1):
                imports.setdefault(mod, set()).add('core/' + m.group(1))
            else:
                for nm in re.findall(r'[a-z_]+', m.group(2)):
                    imports.setdefault(mod, set()).add('core/' + nm)
        if f == 'router.py':
            for m in re.finditer(r'@router\.(get|post|put|patch|delete)\(\s*"([^"]+)"', src):
                routes.append({'method': m.group(1).upper(), 'path': m.group(2), 'module': mod})
        for k in KINDS:
            if re.search(r"""['"]%s['"]""" % k, src) and ('judgment_change' in src or 'enqueue' in src or 'kind' in src):
                kinds_w.setdefault(mod, set()).add(k)
json.dump({'routes': routes, 'mods': {k: sorted(v) for k, v in sorted(mods.items())},
           'imports': {k: sorted(v) for k, v in sorted(imports.items())},
           'kinds': {k: sorted(v) for k, v in sorted(kinds_w.items())}},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('routes', len(routes), 'modules', len(mods))
