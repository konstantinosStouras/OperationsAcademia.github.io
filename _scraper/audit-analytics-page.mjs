import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = {};
for (const file of ['analytics', 'users-growth', 'users-insights']) fixtures[file] = JSON.parse(await readFile(path.join(root, 'data', file + '.json'), 'utf8'));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
let requests = 0, unavailable = false;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => {
  const match = new URL(route.request().url()).pathname.match(/^\/data\/(analytics|users-growth|users-insights)\.json$/);
  if (!match) return route.abort();
  requests++;
  if (unavailable) return route.abort();
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[match[1]]) });
});
await page.setContent('<!doctype html><html><head><base href="https://www.operationsacademia.org/"></head><body><main style="max-width:1100px;margin:auto;padding:20px"><div id="oa-analytics"></div></main></body></html>');
for (const file of ['assets/v3.css', 'assets/oa-list.css', 'assets/oa-analytics.css']) {
  await page.addStyleTag({ content: await readFile(path.join(root, file), 'utf8') });
}
for (const file of ['assets/oa-analytics-model.js', 'assets/oa-charts.js', 'assets/oa-analytics.js']) {
  await page.addScriptTag({ content: await readFile(path.join(root, file), 'utf8') });
}
await page.getByRole('heading', { name: 'Which universities visited', exact: true }).waitFor();
assert.equal(await page.getByRole('heading', { level: 2 }).count(), 13);
const referrals = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Which sites send readers', exact: true }) });
assert.equal(await referrals.locator('li').filter({ hasText: /view-awesome-table|firebaseapp|github\.com/ }).count(), 0);
const universities = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Which universities visited', exact: true }) });
const beforeRows = await universities.locator('li').count();
await universities.getByRole('button', { name: /^Show all / }).click();
assert.ok(await universities.locator('li').count() > beforeRows);
await universities.getByRole('button', { name: 'Show fewer', exact: true }).click();
assert.equal(await universities.locator('li').count(), beforeRows);
const all = page.getByRole('checkbox', { name: 'Everything', exact: true }).first();
await all.click();
assert.equal(await all.getAttribute('aria-checked'), 'true');
const latest = fixtures['users-growth'].days.at(-1);
latest[1] += 1;
fixtures.analytics.generated = new Date().toISOString();
await page.evaluate(() => { document.activeElement.blur(); document.dispatchEvent(new Event('visibilitychange')); });
await page.getByText(new RegExp(latest[1] + ' registered users on')).waitFor();
assert.equal(await page.getByRole('checkbox', { name: 'Everything', exact: true }).first().getAttribute('aria-checked'), 'true');
const textBeforeFailure = await page.locator('#oa-analytics').innerText();
unavailable = true;
const beforeRequests = requests;
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForFunction(() => !!document.querySelector('#oa-analytics h2'));
// Wait for all three failed network requests to finish, without an arbitrary sleep.
await page.waitForLoadState('networkidle');
assert.ok(requests >= beforeRequests + 3);
assert.equal(await page.locator('#oa-analytics').innerText(), textBeforeFailure);
await page.setViewportSize({ width: 375, height: 900 });
await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
assert.deepEqual(errors, []);
await browser.close();
console.log('Analytics page: 13 plots, referral exclusion, complete rankings, automatic refresh, range retention, failed-refresh recovery and phone layout passed');
