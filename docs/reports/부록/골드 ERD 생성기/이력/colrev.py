"""역방향: ERD 열 중 현행 대응 객체에 없는 열(신규 의도 or 오타·개명)."""
import json, re, os, collections
S = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(S, 'erd_data.json'), encoding='utf-8'))
T = d['T']; O2N = d['OLD2NEW']
db = collections.defaultdict(set)
for line in open(os.path.join(S, 'db_cols.tsv'), encoding='utf-8'):
    sch, rel, kind, col, typ = line.rstrip('\n').split('\t')
    db[f'{sch}.{rel}'].add(col)
N2O = collections.defaultdict(list)
for o, ns in O2N.items():
    for n in ns:
        N2O[n].append(o)

def expand(name):
    name = name.replace('[]', '')
    out = []
    for part in re.split(r'\s*·\s*', name):
        part = part.strip()
        m = re.match(r'^(.*)\{([^}]*)\}(.*)$', part)
        if m:
            for x in m.group(2).split(','):
                out += expand(m.group(1) + x + m.group(3))
            continue
        m = re.match(r'^(.*?)(\{[^}]*\})(.*)$', part)
        out.append(part)
    return out

SKIP = {'C', 'C 좌표', 'C 좌표 사본', 'D', '(가산 열)', 'build_id'}
for nid, olds in sorted(N2O.items()):
    if nid not in T or T[nid].get('ghostOf'):
        continue
    have = set().union(*[db[o] for o in olds if o in db])
    if not have:
        continue
    extra = []
    for c in T[nid]['cols']:
        if c[0] in SKIP or c[0].startswith('C '):
            continue
        for p in expand(c[0]):
            if '…' in p or '~' in p or p.endswith('_*') or ' ' in p:
                continue
            if p not in have:
                extra.append(p)
    if extra:
        print(f'{nid} <- {",".join(olds)}: {", ".join(extra)}')
