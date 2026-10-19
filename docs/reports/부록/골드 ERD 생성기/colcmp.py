"""ERD 컬럼 vs 현행 DB 컬럼 비교. 현행 rd/frz/ext 객체 → ERD 대응 테이블(OLD2NEW)에서 빠진 열을 찾고,
빠진 열이 BE 비테스트 코드에 단어로 등장하는지(사용 가능성) 표시한다."""
import json, re, os, sys, collections
S = os.path.dirname(os.path.abspath(__file__))
BE = sys.argv[1]
d = json.load(open(os.path.join(S, 'erd_data.json'), encoding='utf-8'))
T = d['T']; O2N = d['OLD2NEW']

db = collections.defaultdict(list)
for line in open(os.path.join(S, 'db_cols.tsv'), encoding='utf-8'):
    sch, rel, kind, col, typ = line.rstrip('\n').split('\t')
    db[f'{sch}.{rel}'].append((col, typ))

def erd_cols(tid):
    out = set()
    t = T[tid]
    for c in t['cols']:
        name = c[0]
        for part in re.split(r'\s*·\s*|\s*,\s*|\s+', name):
            part = part.strip()
            if not part:
                continue
            m = re.match(r'([a-z_][a-z0-9_]*)(\d*)~(\d+)', part)  # depth1~3
            if m:
                base = re.sub(r'\d+$', '', m.group(1))
                lo = int(re.search(r'(\d+)$', m.group(1)).group(1)) if re.search(r'(\d+)$', m.group(1)) else 1
                for i in range(lo, int(m.group(3)) + 1):
                    out.add(f'{base}{i}' + (m.group(1)[len(re.sub(r"_?key$", "", m.group(1))):] if False else ''))
                out.add(part)
                continue
            part = part.replace('[]', '')
            out.add(part)
            if '/' in part:  # pin/drop_source_measured_at
                pass
    # also include words in note column
    return out

# BE source corpus (non-test)
corpus = []
for dp, dn, fn in os.walk(BE):
    if '/tests' in dp.replace(os.sep, '/') or '__pycache__' in dp:
        continue
    for f in fn:
        if f.endswith('.py'):
            corpus.append(open(os.path.join(dp, f), encoding='utf-8', errors='ignore').read())
corpus = '\n'.join(corpus)

def used(col):
    return len(re.findall(r'\b' + re.escape(col) + r'\b', corpus))

report = {}
for old, news in O2N.items():
    if old not in db:
        continue
    have = set()
    for n in news:
        if n in T:
            have |= erd_cols(n)
    missing = []
    for col, typ in db[old]:
        if col in have:
            continue
        # tolerate renames: *_load_id -> build_id
        missing.append((col, typ, used(col)))
    report[old] = {'erd': news, 'db_cols': len(db[old]), 'missing': missing,
                   'cur': [T[n]['d'].get('cur', '') for n in news if n in T and 'd' in T[n]]}
json.dump(report, open(os.path.join(S, 'colcmp.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for old, r in report.items():
    if not r['missing']:
        continue
    print(f"\n## {old} -> {','.join(r['erd'])}  (db {r['db_cols']} cols, missing {len(r['missing'])})  cur={r['cur'][:1]}")
    print('   ' + ', '.join(f"{c}{'*' + str(u) if u else ''}" for c, t, u in r['missing']))
