"""GEO HUB 골드 ERD v8 조립: head/CSS + 본문(새 섹션) + <script>(표 정의 + 대응 데이터 + 렌더 + 검증·새 섹션)."""
import os, re, sys
S = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
CR, LF = chr(13), chr(10)
orig = open(os.path.join(S, 'erd_v7.html'), encoding='utf-8').read().replace(CR + LF, LF)
head = orig[:orig.index('<script>')]
tables = open(os.path.join(S, 'v8_tables.js'), encoding='utf-8').read()
render = open(os.path.join(S, 'v8_render_base.js'), encoding='utf-8').read()
cov_data = open(os.path.join(S, 'coverage_data.js'), encoding='utf-8').read()
cov = open(os.path.join(S, 'v8_cov.js'), encoding='utf-8').read()
consts = open(os.path.join(S, 'v8_consts.js'), encoding='utf-8').read()

# 구 커버리지 · 헤더 · 매트릭스 코드 제거
a, b = render.index('/* ───────── 기능 커버리지 ───────── */'), render.index('/* 시작 */')
render = render[:a] + render[b:]

# 본문 교체: 구 '기능 커버리지' + '화면별 데이터 계열' → 새 섹션들
body_new = open(os.path.join(S, 'v8_sections.html'), encoding='utf-8').read()
a, b = head.index('<section id="coverage"'), head.index('</main>')
head = head[:a] + body_new + LF + head[b:]
# 흐름 그림 화면 상자 교체
fa, fb = head.index('<rect class="ov-box ov-scr" x="900" y="40"'), head.index('<path class="ov-line" d="M200,174 H248"')
head = head[:fa] + open(os.path.join(S, 'v8_flow_screens.svg'), encoding='utf-8').read() + LF + head[fb:]
head = head.replace('골드·serve·app 색을 스키마 표식으로만 쓴다.', '골드·app 색을 스키마 표식으로만 쓴다.')
# CSS 추가
head = head.replace('</style>\n</head>', open(os.path.join(S, 'v8_extra.css'), encoding='utf-8').read() + '</style>\n</head>')

script = (tables + LF + render.rstrip() + LF + LF + '/* @cov-data start */' + LF + consts + LF + cov_data + '/* @cov-data end */' + LF + cov)
html = head + '<script>' + LF + script + LF + '</script>' + LF + '</body>' + LF + '</html>' + LF
open(OUT, 'w', encoding='utf-8', newline='\n').write(html)
print('wrote', OUT, len(html.encode('utf-8')), 'bytes')
