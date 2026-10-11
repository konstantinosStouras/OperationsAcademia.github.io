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
    const metrics = { views: 128, viewers: 84, opens: 136, clicks: 42, seconds: 5376, countries: [{ name: 'United Kingdom', views: 48 }, { name: 'United States', views: 32 }, { name: 'Germany', views: 18 }], days: {} };
    for (let i = 0; i < 30; i++) metrics.days[new Date(Date.UTC(2026, 9, 11) - i * 86400000).toISOString().slice(0, 10)] = i % 7 + 2;
    window.OAAccounts = { user: () => ({ uid: 'owner', metadata: { creationTime: '2026-10-10T12:00:00Z' } }), isAdmin: () => false, onChange: fn => { window.changeUser = fn; fn({ uid: 'owner' }); } };
    window.OAFB = { enabled: true, ready: async () => ({ firestore: () => ({ collection: col => ({ where: (field, op, uid) => ({ get: async () => {
      window.testQueries.push({ col, field, op, uid });
      return { docs: [{ data: () => col === 'candidateSubmissions' ? { first: 'Alex', last: 'Morgan', ref: 'OA-CAND-TEST' } : { institution: 'Example University', ref: 'OA-JOB-TEST' }, ref: { path: col + '/test', collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ all: metrics, last30: metrics, updatedAt: Date.UTC(2026, 9, 11), countriesUpdatedAt: Date.UTC(2026, 9, 11), countriesReady: true }) }) }) }) } }] };
    } }) }) }) }) };
  });
  await page.goto('https://www.operationsacademia.org/profile-analytics');
  await page.getByRole('heading', { name: 'Views over time' }).waitFor();
  assert.equal(await page.locator('.pa-metric').count(), 4);
  assert.equal(await page.locator('.pa-bar').count(), 30);
  assert.equal(await page.locator('.pa-countries li').count(), 3);
  assert.ok((await page.evaluate(() => testQueries)).every(q => q.uid === 'owner' && q.field === 'uid'));
  await page.getByLabel('Choose a listing').selectOption('1');
  await page.getByRole('heading', { name: 'Example University' }).waitFor();
  assert.match(await page.locator('.pa-metrics').innerText(), /Posting views/);
  await page.getByLabel('Reporting period').selectOption('all');
  await page.getByLabel('Choose a listing').selectOption('0');
  await page.getByRole('heading', { name: 'Alex Morgan' }).waitFor();
  if (process.env.QA_OUTPUT) { await fs.mkdir(process.env.QA_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.QA_OUTPUT, 'profile-analytics-desktop.png'), fullPage: true }); }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
    if (process.env.QA_OUTPUT) await page.screenshot({ path: path.join(process.env.QA_OUTPUT, 'profile-analytics-mobile-' + theme + '.png'), fullPage: true });
  }
  await page.evaluate(() => changeUser(null));
  assert.equal(await page.locator('.pa-metric').count(), 0, 'sign-out immediately clears private figures');
  assert.match(await page.locator('#profile-analytics').innerText(), /Sign in/);
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Profile Analytics browser: owner-scoped queries, candidate/job selection, reporting period, responsive themes and logout passed.');
} finally { await browser.close(); }
