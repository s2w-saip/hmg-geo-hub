// 빌드한 ERD 페이지를 헤드리스 Chrome 으로 열어 콘솔 오류 · 탭별 상자 겹침 · 상세 패널 표시를 확인하고 스크린샷을 남긴다.
//   node shot.js <html> <스크린샷 폴더> [폭]   문제 0 · 콘솔 0 이어야 통과
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join(__dirname, '../../../../front/node_modules/playwright-core'));
(async () => {
  const [file, out, width] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: +(width || 1400), height: 1000 } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.goto('file:///' + path.resolve(file).replace(/\\/g, '/'));
  await page.waitForTimeout(800);
  const meta = await page.$eval('#meta', e => e.innerText.replace(/\n/g, ' | '));
  console.log('meta:', meta);
  await page.screenshot({ path: path.join(out, '00_top.png'), fullPage: false });
  const tabs = await page.$$eval('#tabs .tab', bs => bs.map(b => b.dataset.v));
  const problems = [];
  for (const v of tabs) {
    await page.click(`#tab-${v}`);
    await page.waitForTimeout(150);
    // 상자 겹침 · 캔버스 밖 · 열 글자 잘림
    const r = await page.evaluate(() => {
      const svg = document.getElementById('erd-svg'); const vb = svg.viewBox.baseVal;
      const boxes = [...svg.querySelectorAll('.tbl')].map(g => { const b = g.querySelector('rect.box'); return { id: g.dataset.id, x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }; });
      const out = [];
      boxes.forEach(b => { if (b.x + b.w > vb.width + 0.5 || b.y + b.h > vb.height + 0.5) out.push(`캔버스 밖 ${b.id} (${b.x + b.w}×${b.y + b.h} > ${vb.width}×${vb.height})`); });
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], c = boxes[j]; if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) out.push(`겹침 ${a.id} ↔ ${c.id}`); }
      const trunc = [...svg.querySelectorAll('.t-col')].filter(t => t.textContent.endsWith('…')).map(t => t.textContent);
      const detail = document.getElementById('detail').innerText.length;
      return { out, trunc, detail, note: document.getElementById('view-note').textContent };
    });
    r.out.forEach(x => problems.push(`${v}: ${x}`));
    if (r.trunc.length) problems.push(`${v}: 열 이름 잘림 ${r.trunc.join(', ')}`);
    await page.locator('#erd').screenshot({ path: path.join(out, `tab_${v}.png`) });
  }
  // 모든 테이블 상세 패널: 클릭해서 빈 패널이 없는지
  const ids = await page.evaluate(() => Object.keys(T).filter(id => !T[id].ghostOf));
  let empty = 0;
  for (const id of ids) { const ok = await page.evaluate(id => { gotoTable(id); return document.getElementById('detail').innerText.length > 20; }, id); if (!ok) { empty++; problems.push('상세 비어 있음 ' + id); } }
  // 휴대폰 폭(390px): 모든 탭 · 모든 상세 패널에서 페이지 가로 넘침이 없어야 한다
  await page.setViewportSize({ width: 390, height: 800 });
  for (const v of tabs) {
    await page.click(`#tab-${v}`); await page.waitForTimeout(60);
    const vids = await page.evaluate(v => Object.keys(VIEWS.find(x => x.id === v).pos).filter(id => !T[id].ghostOf), v);
    for (const id of vids) { const sw = await page.evaluate(id => { select(id); return document.documentElement.scrollWidth; }, id); if (sw > 390) problems.push(`390px 넘침 ${v}:${id} ${sw}`); }
  }
  await page.screenshot({ path: path.join(out, 'mobile.png') });
  await page.setViewportSize({ width: +(width || 1400), height: 1000 });
  await page.screenshot({ path: path.join(out, '99_full.png'), fullPage: true });
  console.log('tabs', tabs.length, 'tables', ids.length, 'empty detail', empty);
  console.log('problems', problems.length); problems.forEach(p => console.log('  ', p));
  console.log('console', errs.length); errs.slice(0, 20).forEach(e => console.log('  ', e));
  await browser.close();
  process.exitCode = problems.length || errs.length ? 1 : 0;
})();
