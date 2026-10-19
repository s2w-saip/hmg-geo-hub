"""★ 점검표 생성기의 화면 항목 인벤토리(775)를 읽기 전용으로 덤프한다. 생성기 파일은 쓰지 않는다."""
import json, os, sys
GEN = sys.argv[1]
OUT = sys.argv[2]
sys.path.insert(0, GEN)
os.chdir(GEN)
src = open(os.path.join(GEN, 'build_checklist.py'), encoding='utf-8').read()
cut = src.index('SOURCE_USAGE = {}')
ns = {'__file__': os.path.join(GEN, 'build_checklist.py'), '__name__': 'inv_dump'}
sys.argv = [sys.argv[0], os.path.join(os.path.dirname(OUT), '_unused.html')]
exec(compile(src[:cut], 'build_checklist_head', 'exec'), ns)
from item_applicability import applicability
items = []
for s in ns['SCREENS']:
    for a in s['areas']:
        label = a[1]
        srcarea = ns['ITEM_SOURCES'].get((s['route'], label))
        try:
            app_ok, kind = applicability(s['route'], label, srcarea[1] if srcarea else label)
        except Exception as e:  # noqa
            app_ok, kind = None, f'ERR {e}'
        items.append({'screen': s['name'], 'menu': s['menu'], 'route': s['route'], 'survey': s.get('survey', 'existing3'),
                      'label': label, 'loc': a[0], 'note': a[2], 'legacy_call': a[3], 'api_call': a[4],
                      'api_keys': list(a[5]) if a[5] else [], 'kind': a[7] if len(a) > 7 else '',
                      'source_label': srcarea[1] if srcarea else None, 'profile': kind, 'applicable': app_ok})
tech = [{'screen': n, 'loc': a[0], 'label': a[1], 'note': a[2], 'legacy_call': a[3], 'api_call': a[4], 'api_keys': list(a[5]) if a[5] else []}
        for n, a in ns['TECHNICAL_AREAS']]
json.dump({'items': items, 'technical': tech}, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=lambda o: sorted(o) if isinstance(o, set) else str(o))
print(len(items), 'items', len({(i['route']) for i in items}), 'routes', len(tech), 'technical')
