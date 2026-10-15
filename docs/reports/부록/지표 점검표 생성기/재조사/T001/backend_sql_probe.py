"""T001 GEO: generate SQL for explicit synthetic scopes; never connects to a DB.

Run from back: python <this-file>. Output is kept beside this script.
"""
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = next(p for p in HERE.parents if (p / 'back/app/core/measure.py').exists())
sys.path.insert(0, str(REPO / 'back'))
from app.core.measure import MeasureScope, OwnerScope, plan_counts, competitor_rows_sql
from app.core.cycles import CycleRow, build_window
from app.core.profile import OFF, IMPLEMENTED, parse_profile


def score(sql):
    text = re.sub(r"'(?:''|[^'])*'", "''", sql)
    text = re.sub(r'--[^\n]*|/\*.*?\*/', '', text, flags=re.S)
    patterns = {'join': r'\bJOIN\b', 'cte': r'(?:\bWITH|,)\s*\w+\s+AS(?:\s+MATERIALIZED)?\s*\(',
                'group_by': r'\bGROUP\s+BY\b', 'window': r'\bOVER\s*\('}
    counts = {k: len(re.findall(p, text, re.I)) for k, p in patterns.items()}
    return {**counts, 'total': sum(counts.values())}


d = date(2026, 9, 14)
win = build_window(surface='global', mode='snapshot', rows=[CycleRow(11, 1, d, 0)],
                   lo=d, hi=d, generation=1, project_keys=(1,))
records = []
for pname, profile in [('off', OFF), ('implemented', parse_profile(','.join(IMPLEMENTED)))]:
    for mode, owner in [
        ('brand', OwnerScope((1,), (2,), None, False, False)),
        ('countryN', OwnerScope((1, 2), (2,), ('DE', 'FR'), True, False)),
        ('language', OwnerScope((1,), (2,), None, False, True)),
    ]:
        ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(2,), bgrps=(2, 10), pop_bits=(2, 8),
                          owner=owner, card=True, frz_ok=pname == 'implemented', profile=profile, cat_diff=())
        queries = [*plan_counts(ms, win, group_by=('geo',), parts=('mentions', 'citations')).statements,
                   ('brands', competitor_rows_sql(ms, win, group_by=('geo',), hmg_siblings=False))]
        for key, q in queries:
            records.append({'profile': pname, 'mode': mode, 'statement': key, 'score': score(q.text),
                            'sql': q.text, 'params': q.params})

out = {'scope': 'synthetic global / single Kia perspective / card=true; not deployed settings',
       'limits': 'Direct generated SQL only; view internals, shared gates and actual plans not scored.',
       'source_sha256': {name: hashlib.sha256((REPO / name).read_bytes()).hexdigest() for name in
                        ['back/app/core/measure.py', 'back/app/core/cycles.py', 'back/app/core/facts.py', 'back/app/core/profile.py']},
       'queries': records}
(HERE / 'backend_sql.json').write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
print(json.dumps([{'profile': x['profile'], 'mode': x['mode'], 'statement': x['statement'], 'score': x['score']} for x in records]))
