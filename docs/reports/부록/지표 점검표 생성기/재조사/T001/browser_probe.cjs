// PC-only environment observation. This is not a Before/After parity test.
// After = synthetic demo stack on 127.0.0.1:3200 (current repo code, back/db/synth/synth-db.sh demo).
// Uses only that stack's local mock account; never submits it to Vercel (Before opens the entry page only).
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../../../../../..');
const requireFront = createRequire(path.join(repo, 'front/package.json'));
const { chromium } = requireFront('playwright');
const demoAccounts = path.join(repo, 'back/db/synth/out/run/demo-accounts.json');
if (!fs.existsSync(demoAccounts)) throw new Error('Start the synthetic demo first: bash back/db/synth/synth-db.sh demo');
const out = path.join(__dirname, 'browser-observations');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const result = { observed_at: new Date().toISOString(), viewport: { width: 1920, height: 1080 }, parity_verified: false, environments: {} };
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [side, url] of [['before', 'https://hmg-geo.vercel.app/'], ['after', 'http://127.0.0.1:3200/']]) {
      const context = await browser.newContext({ viewport: result.viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
      const page = await context.newPage();
      const record = { requested_url: url, requests: [] };
      result.environments[side] = record;
      page.on('response', response => {
        const request = response.request();
        if (request.method() !== 'GET') return;
        const parsed = new URL(response.url());
        if (!['document', 'fetch', 'xhr'].includes(request.resourceType())) return;
        record.requests.push({ origin: parsed.origin, path: parsed.pathname, status: response.status(), type: request.resourceType() });
      });
      const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      record.entry_status = response.status();
      record.entry_url = page.url();
      record.entry_snapshot = await page.locator('body').ariaSnapshot();
      await page.screenshot({ path: path.join(out, `${side}-entry.png`) });
      if (side === 'after') {
        const credentials = JSON.parse(fs.readFileSync(demoAccounts, 'utf8'));
        const account = credentials.accounts.find(item => item.key === 'ADMIN');
        if (!['http://127.0.0.1:3200', 'http://localhost:3200'].includes(new URL(page.url()).origin)) throw new Error('Unexpected local login destination.');
        await page.getByRole('textbox', { name: '이메일', exact: true }).fill(account.email);
        await page.getByRole('textbox', { name: '비밀번호', exact: true }).fill(credentials.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.waitForURL(url => url.pathname.endsWith('/dashboard'), { timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        const dialog = page.getByRole('dialog', { name: 'GEO 대시보드 운영 안내', exact: true });
        if (await dialog.isVisible()) {
          await dialog.getByRole('button', { name: '닫기', exact: true }).click();
          record.dialog_closed = await dialog.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false);
        }
        record.account_basis = 'Synthetic demo mock ADMIN account (3200); not matched to a Vercel account.';
        record.dashboard_url = page.url();
        record.dashboard_snapshot = (await page.locator('body').ariaSnapshot()).replaceAll(account.email, '[local mock ADMIN]');
        record.geo_heading_visible = await page.getByText('국가별 GEO 현황', { exact: true }).isVisible();
        record.script_paths = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname));
        await page.screenshot({ path: path.join(out, 'after-dashboard.png'), fullPage: true });
        await page.getByRole('button', { name: '브랜드', exact: true }).click();
        record.brand_menu_snapshot = await page.locator('body').ariaSnapshot();
        await page.getByRole('menuitemcheckbox', { name: 'Kia', exact: true }).click();
        record.brand_chosen_snapshot = await page.locator('body').ariaSnapshot();
        await page.keyboard.press('Escape');
        record.filter_draft_snapshot = await page.locator('main').ariaSnapshot();
        const previousUrl = page.url();
        await page.getByRole('button', { name: '적용', exact: true }).click();
        await page.waitForURL(url => url.href !== previousUrl, { timeout: 20000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        record.filtered_url = page.url();
        const mainSnapshot = await page.locator('main').ariaSnapshot();
        record.filtered_snapshot = mainSnapshot;
        const geoStart = mainSnapshot.indexOf('- heading "국가별 GEO 현황"');
        record.geo_snapshot = geoStart >= 0 ? mainSnapshot.slice(geoStart) : null;
        if (geoStart >= 0) await page.getByRole('heading', { name: '국가별 GEO 현황', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'after-geo-kia.png') });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify({ observed_at: result.observed_at, before: result.environments.before.entry_url, after: result.environments.after.filtered_url, geo: result.environments.after.geo_snapshot ?? result.environments.after.filtered_snapshot }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
