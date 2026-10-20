/* 머리 칩 */
(function meta() {
  const n = Object.values(T).filter(t => !t.ghostOf && t.s === 'gold').length;
  const chips = [['논리 설계 · DDL 아님', null, true], ['범위 제안 · 20261015/A02 · A04 협의 중', null, true], ['골드 테이블', String(n)], ['기준일', '2026-10-20']];
  const m = document.getElementById('meta');
  chips.forEach(([k, v, warn]) => { const c = document.createElement('span'); c.className = 'chip' + (warn ? ' warn' : ''); c.textContent = k + (v != null ? ' ' : ''); if (v != null) { const b = document.createElement('b'); b.textContent = v; c.appendChild(b); } m.appendChild(c); });
})();
