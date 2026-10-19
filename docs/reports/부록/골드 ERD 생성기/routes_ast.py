"""router.py 들을 ast 로 읽어 (method, path, module) 표를 만든다. 경로 상수·문자열 결합·f-string 상수 처리."""
import ast, json, os, sys
APP, OUT = sys.argv[1], sys.argv[2]


def ev(node, env):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return env.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = ev(node.left, env), ev(node.right, env)
        return a + b if a is not None and b is not None else None
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(v.value)
            elif isinstance(v, ast.FormattedValue):
                x = ev(v.value, env)
                if x is None:
                    return None
                parts.append(x)
        return ''.join(parts)
    return None


routes = []
for dp, dn, fn in os.walk(APP):
    d = dp.replace(os.sep, '/')
    if '/tests' in d or '__pycache__' in d:
        continue
    for f in fn:
        if not (f.startswith('router') and f.endswith('.py')):
            continue
        p = d + '/' + f
        rel = p[len(APP.replace(os.sep, '/')) + 1:]
        parts = rel.split('/')
        mod = '/'.join(parts[1:4]) if parts[0] == 'features' else rel
        tree = ast.parse(open(p, encoding='utf-8').read())
        env, prefix = {}, {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                v = ev(node.value, env)
                if v is not None:
                    env[node.targets[0].id] = v
                if isinstance(node.value, ast.Call) and getattr(node.value.func, 'id', '') == 'APIRouter':
                    for kw in node.value.keywords:
                        if kw.arg == 'prefix':
                            prefix[node.targets[0].id] = ev(kw.value, env) or ''
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in ('get', 'post', 'put', 'patch', 'delete', 'api_route'):
                        rname = getattr(dec.func.value, 'id', '')
                        path = ev(dec.args[0], env) if dec.args else None
                        if path is None:
                            print('UNRESOLVED', mod, node.name, ast.dump(dec.args[0])[:80] if dec.args else '')
                            continue
                        routes.append({'method': dec.func.attr.upper(), 'path': prefix.get(rname, '') + path, 'module': mod, 'fn': node.name})
json.dump(routes, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('routes', len(routes))
