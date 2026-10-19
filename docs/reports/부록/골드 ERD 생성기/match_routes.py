"""인벤토리 항목의 api_call 문자열 → BE 라우트(모듈) 매칭."""
import json, os, re, sys, collections
S = os.path.dirname(os.path.abspath(__file__))
inv = json.load(open(os.path.join(S, 'inventory.json'), encoding='utf-8'))
be = json.load(open(os.path.join(S, 'be_scan.json'), encoding='utf-8'))
routes = json.load(open(os.path.join(S, 'routes_ast.json'), encoding='utf-8'))


def tpl_re(path):
    return re.compile('^' + re.sub(r'\\\{[^}]*\\\}', '[^/]+', re.escape(path)) + '$')


RT = [(r, tpl_re(r['path'])) for r in routes]
TOK = re.compile(r'(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(…|\.\.\.)?(/v1/[A-Za-z0-9_\-/{}\.\[\]]*|/[a-z][a-z0-9_\-/{}\[\]]*)')


def find(call):
    hits = set()
    for m in TOK.finditer(call or ''):
        method, ell, path = m.groups()
        path = path.rstrip('.,;:)/') or path
        p = re.sub(r'\{[^}]*\}|\[[^\]]*\]', 'X', path)
        if ell or not path.startswith('/v1/'):
            if not ell and not path.startswith('/v1'):
                continue
            # suffix match (…/settings/owned-bases)
            for r, rx in RT:
                tp = re.sub(r'\{[^}]*\}', 'X', r['path'])
                if tp.endswith(p) and (not method or r['method'] == method):
                    hits.add((r['method'], r['path'], r['module']))
            continue
        for r, rx in RT:
            if rx.match(p) and (not method or r['method'] == method):
                hits.add((r['method'], r['path'], r['module']))
        if not any(h[1] for h in hits if rx_ok(h, p)):
            # prefix tolerant: /v1/citations/domains/{skey} vs X
            for r, rx in RT:
                if re.sub(r'\{[^}]*\}', 'X', r['path']) == p:
                    hits.add((r['method'], r['path'], r['module']))
    return sorted(hits)


def rx_ok(h, p):
    return True


out, miss = [], []
for i, it in enumerate(inv['items'] + [dict(t, route='(화면 밖)', menu='화면 밖 경로', profile='화면 밖') for t in inv['technical']]):
    hits = find(it['api_call'])
    rec = {'i': i, 'menu': it['menu'], 'route': it['route'], 'label': it['label'], 'profile': it['profile'],
           'api_call': it['api_call'], 'source_label': it.get('source_label'), 'hits': hits}
    out.append(rec)
    if not hits:
        miss.append(rec)
json.dump(out, open(os.path.join(S, 'item_routes.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('items', len(out), 'unmatched', len(miss))
for m in miss:
    print(' -', m['route'].replace('/ko', ''), '|', m['label'], '|', (m['api_call'] or '')[:110])
