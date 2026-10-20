"""v7 표 정의(erd_script.js 앞부분) → v8. 정확 치환만 쓰고, 치환 대상이 기대 횟수와 다르면 실패한다."""
import os, sys
S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, S)
CR, LF = chr(13), chr(10)
src = open(os.path.join(S, 'erd_script.js'), encoding='utf-8').read().replace(CR + LF, LF).lstrip(LF)
cut = src.index('/* ───────── 렌더 ───────── */')
tables, render = src[:cut], src[cut:]
# ITEMS(구 화면 매트릭스) 제거: 첫 줄
first_nl = tables.index(LF)
assert tables.startswith('const ITEMS = ')
tables = tables[first_nl + 1:]


def rep(text, old, new, count=1):
    n = text.count(old)
    if n != count:
        raise SystemExit(f'expected {count} got {n}: {old[:90]!r}')
    return text.replace(old, new)


import importlib  # noqa: E402
pt = importlib.import_module('patches_tables')
ps = importlib.import_module('patches_static')
for old, new, *cnt in pt.TABLE_PATCHES + ps.STATIC_PATCHES:
    tables = rep(tables, old, new, cnt[0] if cnt else 1)
for old, new, *cnt in pt.RENDER_PATCHES:
    render = rep(render, old, new, cnt[0] if cnt else 1)
for extra in getattr(ps, 'APPEND_TABLES', []):
    marker = '/* ───────── 탭(뷰) ───────── */'
    tables = rep(tables, marker, extra + LF + LF + marker)
open(os.path.join(S, 'v8_tables.js'), 'w', encoding='utf-8').write(tables)
open(os.path.join(S, 'v8_render_base.js'), 'w', encoding='utf-8').write(render)
print('ok', len(tables), len(render))
