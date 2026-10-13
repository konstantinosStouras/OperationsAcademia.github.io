import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.operationsacademia.org') return route.abort();
    if (/oa-(firebase|accounts|ga4|visit|usage|listing-tracking)\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: '' });
    const rel = url.pathname === '/profile-analytics' ? '/profile-analytics.html' : url.pathname;
    try { const body = await fs.readFile(path.join(root, rel)); return route.fulfill({ body, contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.html') ? 'text/html' : 'image/png' }); } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.addInitScript(() => {
    window.testQueries = [];
    const metrics = { views: 128, viewers: 84, opens: 136, clicks: 42, seconds: 5376, countries: [{ name: 'United Kingdom', views: 48 }, { name: 'United States', views: 32 }, { name: 'Germany', views: 18 }], days: {}, universities: [{ name: 'University of Oxford', views: 24, clicks: 11, seconds: 1392, averageSeconds: 58 }, { name: 'Massachusetts Institute of Technology', views: 18, clicks: 8, seconds: 1152, averageSeconds: 64 }, { name: 'Unknown', views: 86, clicks: 23, seconds: 2832, averageSeconds: 33 }] };
    function report(col, all) {
      if (window.legacyReport) return metrics;
      const parts = window.emptyReport ? [] : col === 'candidateSubmissions'
        ? [{ part: 'cv', name: 'CV', clicks: all ? 20 : 7, linkClicks: all ? 15 : 5, seconds: all ? 240 : 90, views: 3, averageSeconds: all ? 80 : 30 }, { part: 'website', name: 'Website', clicks: 2, linkClicks: 2, seconds: 24, views: 2, averageSeconds: 12 }, { part: 'research_summary', name: 'Research summary', clicks: 0, linkClicks: 0, seconds: 45, views: 1, averageSeconds: 45 }]
        : [{ part: 'job_file', name: 'Job advertisement', clicks: all ? 12 : 3, linkClicks: all ? 12 : 3, seconds: all ? 180 : 60, views: 2, averageSeconds: all ? 90 : 30 }];
      if (window.oldParts) parts.forEach(p => { delete p.seconds; delete p.views; delete p.averageSeconds; });
      return { ...metrics, ...(window.emptyReport ? { views: 0, seconds: 0 } : {}), parts, interactions: parts.reduce((n, p) => n + p.clicks, 0) };
    }
    for (let i = 0; i < 30; i++) metrics.days[new Date(Date.UTC(2026, 9, 11) - i * 86400000).toISOString().slice(0, 10)] = i % 7 + 2;
    window.OAAccounts = { user: () => ({ uid: 'owner', metadata: { creationTime: '2026-10-10T12:00:00Z' } }), isAdmin: () => false, onChange: fn => { window.changeUser = fn; fn({ uid: 'owner' }); } };
    window.OAFB = { enabled: true, ready: async () => ({ firestore: () => ({ collection: col => ({ where: (field, op, uid) => ({ get: async () => {
      window.testQueries.push({ col, field, op, uid });
      if (window.singleListing && col === 'jobSubmissions') return { docs: [] };
      return { docs: [{ data: () => col === 'candidateSubmissions' ? { first: 'Alex', last: 'Morgan', ref: 'OA-CAND-TEST' } : { institution: 'Example University', ref: 'OA-JOB-TEST' }, ref: { path: col + '/test', collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ all: report(col, true), last30: report(col, false), partTimeTrackingSince: '2026-10-13', updatedAt: Date.UTC(2026, 9, 14), countriesUpdatedAt: Date.UTC(2026, 9, 14), countriesReady: true }) }) }) }) } }] };
    } }) }) }) }) };
  });
  await page.goto('https://www.operationsacademia.org/profile-analytics');
  await page.getByRole('heading', { name: 'Views over time' }).waitFor();
  assert.equal(await page.locator('.pa-metric').count(), 6);
  assert.match(await page.locator('.pa-click-table tbody').innerText(), /CV\s+7\s+5\s+1 min 30 sec\s+30 sec/);
  assert.match(await page.locator('.pa-metrics').innerText(), /Total reading time\s+1 hr 29 min/);
  assert.match(await page.locator('.pa-metrics').innerText(), /Average reading time\s+42 sec/);
  assert.match(await page.locator('.pa-click-table tbody').innerText(), /Research summary\s+0\s+0\s+45 sec\s+45 sec/);
  assert.equal(await page.locator('.pa-bar').count(), 30);
  assert.equal(await page.locator('.pa-countries li').count(), 3);
  assert.equal(await page.locator('.pa-universities tbody tr').count(), 3);
  assert.ok((await page.evaluate(() => testQueries)).every(q => q.uid === 'owner' && q.field === 'uid'));
  await page.getByLabel('Choose a listing').selectOption('1');
  await page.getByRole('heading', { name: 'Example University' }).waitFor();
  assert.match(await page.locator('.pa-metrics').innerText(), /Posting views/);
  assert.match(await page.locator('.pa-click-table tbody').innerText(), /Job advertisement\s+3\s+3\s+1 min 0 sec\s+30 sec/);
  await page.getByLabel('Reporting period').selectOption('all');
  await page.getByLabel('Choose a listing').selectOption('0');
  await page.getByRole('heading', { name: 'Alex Morgan' }).waitFor();
  assert.match(await page.locator('.pa-click-table tbody').innerText(), /CV\s+20\s+15\s+4 min 0 sec\s+1 min 20 sec/);
  await page.evaluate(() => { window.singleListing = true; changeUser({ uid: 'owner' }); });
  await page.getByRole('heading', { name: 'Views over time' }).waitFor();
  assert.equal(await page.getByLabel('Choose a listing').count(), 0, 'one listing opens directly without a chooser');
  if (process.env.QA_OUTPUT) { await fs.mkdir(process.env.QA_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.QA_OUTPUT, 'profile-analytics-desktop.png'), fullPage: true }); }
  await page.evaluate(() => { window.singleListing = false; changeUser({ uid: 'owner' }); });
  await page.getByLabel('Choose a listing').waitFor();
  for (const theme of ['light', 'dark']) for (const width of [320, 360, 390, 430]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width, height: 844 });
    for (const [value, type] of [['0', 'candidate'], ['1', 'job']]) for (const period of ['last30', 'all']) {
      await page.getByLabel('Choose a listing').selectOption(value);
      await page.getByLabel('Reporting period').selectOption(period);
      const rows = page.locator('.pa-click-table tbody');
      assert.match(await rows.innerText(), type === 'candidate'
        ? period === 'last30' ? /CV\s+7\s+5\s+1 min 30 sec\s+30 sec/ : /CV\s+20\s+15\s+4 min 0 sec\s+1 min 20 sec/
        : period === 'last30' ? /Job advertisement\s+3\s+3\s+1 min 0 sec\s+30 sec/ : /Job advertisement\s+12\s+12\s+3 min 0 sec\s+1 min 30 sec/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${type} ${width}px ${theme}: no page overflow`);
      assert.equal(await page.locator('.pa-clicks .pa-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${type} ${width}px: all detail values fit without horizontal scrolling`);
      assert.equal(await page.locator('.pa-click-table td').evaluateAll(cells => cells.every(cell => {
        const label = cell.getAttribute('data-label'), style = getComputedStyle(cell, '::before');
        const box = cell.getBoundingClientRect();
        return label && style.content === '"' + label + '"' && style.display !== 'none' && box.height > 0 && cell.scrollWidth <= cell.clientWidth + 1;
      })), true, `${type} ${width}px ${theme}: every value has a visible label and fits its cell`);
      if (process.env.QA_OUTPUT && width === 390 && period === 'last30') {
        await page.locator('.pa-clicks').evaluate(el => scrollTo({ top: scrollY + el.getBoundingClientRect().top - 80, behavior: 'instant' }));
        await page.screenshot({ path: path.join(process.env.QA_OUTPUT, `${type}-detail-time-mobile-${theme}.png`) });
      }
    }
  }
  await page.getByLabel('Choose a listing').selectOption('0');
  await page.getByLabel('Reporting period').selectOption('last30');
  await page.evaluate(() => { window.oldParts = true; changeUser({ uid: 'owner' }); });
  await page.getByRole('heading', { name: 'Clicks and reading time by detail' }).waitFor();
  assert.match(await page.locator('.pa-click-table tbody').innerText(), /CV\s+7\s+5\s+—\s+—/);
  await page.evaluate(() => { window.oldParts = false; window.legacyReport = true; changeUser({ uid: 'owner' }); });
  await page.getByText('The click breakdown will appear after the next report refresh. Earlier reports did not include these details.').waitFor();
  assert.match(await page.locator('.pa-metrics').innerText(), /Listing clicks\s+—/);
  await page.evaluate(() => { window.legacyReport = false; window.emptyReport = true; changeUser({ uid: 'owner' }); });
  await page.getByText('No detail activity was measured in this period yet.').waitFor();
  assert.match(await page.locator('.pa-metrics').innerText(), /Average reading time\s+—/);
  await page.evaluate(() => { Date.now = () => Date.parse('2026-11-16T00:00:00Z'); OAFeatureBadges.refresh(); });
  assert.equal(await page.locator('.oa-nav-new:visible').count(), 0, 'all New badges expire together');
  await page.evaluate(() => changeUser(null));
  assert.equal(await page.locator('.pa-metric').count(), 0, 'sign-out immediately clears private figures');
  assert.match(await page.locator('#profile-analytics').innerText(), /Sign in/);
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Profile Analytics browser: owner-scoped queries, candidate/job selection, reporting period, 32 mobile report/period/theme combinations at 320–430px with labeled, unclipped times, and logout passed.');
} finally { await browser.close(); }
