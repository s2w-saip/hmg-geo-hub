"""GEO HUB 골드 ERD 조립: src/ 의 페이지 머리 · 본문 + 표 정의 · 탭 · 렌더 · 머리 칩 → HTML 한 장.

python build.py <출력 경로>
"""
import os
import sys

S = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(S, 'src')
LF = '\n'


def read(*p):
    return open(os.path.join(SRC, *p), encoding='utf-8').read().replace('\r\n', '\n')


tables = ''.join(read('tables', f) + LF for f in sorted(os.listdir(os.path.join(SRC, 'tables'))) if f.endswith('.js'))
script = LF.join([tables, read('views.js'), read('render.js'), read('meta.js')])
html = read('page_head.part') + read('page_body.part') + '<script>' + LF + script.rstrip(LF) + LF + '</script>' + LF + '</body>' + LF + '</html>' + LF
out = sys.argv[1]
open(out, 'w', encoding='utf-8', newline='\n').write(html)
print('wrote', out, len(html.encode('utf-8')), 'bytes')
