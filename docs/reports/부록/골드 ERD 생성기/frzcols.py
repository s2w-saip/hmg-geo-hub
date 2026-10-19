import collections, os
S = os.path.dirname(os.path.abspath(__file__))
db = collections.defaultdict(list)
for line in open(os.path.join(S, 'db_cols.tsv'), encoding='utf-8'):
    sch, rel, kind, col, typ = line.rstrip('\n').split('\t')
    db[f'{sch}.{rel}'].append(col)
for v in ['frz.card_axis', 'frz.card_brand_name', 'frz.card_web', 'frz.generation', 'frz.prompt', 'frz.prompt_axis', 'frz.cell', 'frz.cell_web', 'frz.brand_name',
          'rd.surface_generation', 'rd.rep_cit_delta', 'rd.cycle_pick_basis', 'rd.entity_mention_total', 'rd.v_answer_mention_raw', 'ext.ctx_entity']:
    print(v, ':', ' '.join(db[v]))
base = {'answer': 'rd.answer', 'answer_brand': 'rd.answer_brand', 'citation': 'rd.citation'}
for v in ['card_answer', 'card_answer_w', 'grid_answer', 'card_answer_brand', 'card_answer_brand_w', 'grid_answer_brand', 'card_citation', 'card_citation_w', 'grid_citation']:
    b = base['answer_brand' if 'answer_brand' in v else 'citation' if 'citation' in v else 'answer']
    extra = [c for c in db['frz.' + v] if c not in db[b]]
    missing = [c for c in db[b] if c not in db['frz.' + v]]
    print('frz.' + v, 'extra:', extra, 'missing:', missing)
