// 탭 배치 계산: 빌드한 페이지를 헤드리스 Chrome 으로 열어 실제 글꼴 폭으로 상자 너비를 재고,
// 열 이름 · 테이블 이름이 잘리지 않고 상자가 겹치지 않게 pos · w · h 를 다시 잡는다.
//   node layout.js <html> [--write]     --write 면 src/views.js 의 pos · w · h 를 고친다
// 규칙: 같은 x 의 상자는 한 세로 줄. 줄 순서 · 줄 안 순서는 지금 배치를 따른다. 줄 너비 = 그 줄에서 가장 넓은 요구 너비.
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '../../../../front/node_modules/playwright-core'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GAP_X = 70, GAP_Y = 22, MARGIN = 20, LOOP_ROOM = 40;

(async () => {
  const [file, flag] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  await page.goto('file:///' + path.resolve(file).replace(/\\/g, '/'));
  await page.waitForFunction(() => document.fonts && document.fonts.status === 'loaded');
  const plan = await page.evaluate(({ GAP_X, GAP_Y, MARGIN, LOOP_ROOM }) => {
    const need = id => {
      const t = T[id], orig = t.ghostOf ? T[t.ghostOf] : t;
      const label = t.name + (t.ghostOf ? '  ↗' : '');
      const pre = PREFIX[orig.s] || '';
      let w = tw(pre + label, F_NAME) + 20;
      const keyed = t.cols.some(c => c[1]);
      const nx = keyed ? 30 : 10;
      t.cols.forEach(c => { w = Math.max(w, nx + tw(c[0], F_MONO) + 12); });
      return Math.ceil(w / 10) * 10;
    };
    const out = {};
    VIEWS.forEach(v => {
      const ids = Object.keys(v.pos);
      const xs = [...new Set(ids.map(id => v.pos[id][0]))].sort((a, b) => a - b);
      const cols = xs.map(x => ids.filter(id => v.pos[id][0] === x).sort((a, b) => v.pos[a][1] - v.pos[b][1]));
      const pos = {}; let x = MARGIN, maxY = 0, maxX = 0;
      cols.forEach((col, ci) => {
        const width = Math.max(...col.map(id => Math.max(need(id), v.pos[id][2])));
        if (ci > 0) x = Math.max(x, xs[ci]);
        let bottom = -Infinity;
        col.forEach(id => {
          const h = boxH(T[id]);
          const y = Math.max(v.pos[id][1], bottom + GAP_Y);
          pos[id] = [x, y, width]; bottom = y + h; maxY = Math.max(maxY, bottom);
        });
        maxX = x + width; x = maxX + GAP_X;
      });
      const hasLoop = Object.keys(v.loop || {}).length > 0;
      out[v.id] = { pos, w: Math.ceil((maxX + MARGIN + (hasLoop ? LOOP_ROOM : 0)) / 10) * 10, h: Math.ceil((maxY + MARGIN) / 10) * 10, old: { w: v.w, h: v.h, pos: v.pos } };
    });
    return out;
  }, { GAP_X, GAP_Y, MARGIN, LOOP_ROOM });
  await browser.close();
  let changed = 0;
  for (const [vid, p] of Object.entries(plan)) {
    const diff = Object.keys(p.pos).filter(id => JSON.stringify(p.pos[id]) !== JSON.stringify(p.old.pos[id]));
    if (diff.length || p.w !== p.old.w || p.h !== p.old.h) { changed++; console.log(vid, `${p.old.w}×${p.old.h} → ${p.w}×${p.h}`, diff.map(id => `${id} ${JSON.stringify(p.old.pos[id])}→${JSON.stringify(p.pos[id])}`).join(' · ')); }
  }
  console.log('바뀐 탭', changed);
  if (flag === '--write') {
    const vf = path.join(__dirname, 'src', 'views.js');
    let s = fs.readFileSync(vf, 'utf8');
    for (const [vid, p] of Object.entries(plan)) {
      const start = s.indexOf(`id: '${vid}'`); if (start < 0) throw new Error('no view ' + vid);
      const head = s.slice(start).match(/w: \d+, h: \d+/);
      const hi = start + head.index; s = s.slice(0, hi) + `w: ${p.w}, h: ${p.h}` + s.slice(hi + head[0].length);
      const pi = s.indexOf('pos: {', start); let depth = 0, j = pi + 5;
      for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (!depth) break; } }
      const body = Object.entries(p.pos).map(([id, a]) => `${id}: [${a.join(', ')}]`).join(', ');
      s = s.slice(0, pi) + `pos: { ${body} }` + s.slice(j + 1);
    }
    fs.writeFileSync(vf, s);
    console.log('src/views.js 갱신');
  }
})();
