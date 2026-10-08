import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
let rows = [], failed = false;
await page.route('**/*', route => {
  if (!new URL(route.request().url()).pathname.endsWith('/data/candidates.json') || failed) return route.abort();
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
});
const errors = []; page.on('pageerror', error => errors.push(error.message));
await page.setContent('<!doctype html><html><head><base href="https://www.operationsacademia.org/"></head><body><main style="padding:12px"><div id="cards"></div></main></body></html>');
for (const file of ['assets/v3.css', 'assets/oa-list.css']) await page.addStyleTag({ content: await readFile(path.join(root, file), 'utf8') });
for (const file of ['assets/oa-candcard.js', 'assets/oa-list.js']) await page.addScriptTag({ content: await readFile(path.join(root, file), 'utf8') });
await page.evaluate(() => {
  window.auditList = OAList.mount({ mount: '#cards', data: '/data/candidates.json',
    urlPrefix: 'c_', perPage: 10, filters: [{ key: 'name', label: 'Name', type: 'text', fields: ['name'] }],
    card: OACandCard.cardConfig() });
});
await page.locator('.oa-empty').waitFor();
rows = [{ id: 'audit', name: 'Audit Candidate', affiliation: 'University of California, Berkeley', position: 'PhD Candidate', researchAreas: ['Operations'], informsDays: [] }];
assert.equal(await page.evaluate(() => auditList.refresh()), true);
await page.locator('.oa-card').waitFor();
const name = page.getByRole('textbox', { name: 'Name', exact: true });
await name.fill('Audit');
await page.evaluate(() => document.activeElement.blur());
rows.push({ ...rows[0], id: 'another', name: 'Another Candidate' });
await page.evaluate(() => auditList.refresh());
assert.equal(await name.inputValue(), 'Audit');
assert.equal(await page.locator('.oa-card').count(), 1);
failed = true;
assert.equal(await page.evaluate(() => auditList.refresh()), false);
assert.equal(await page.locator('.oa-card').count(), 1);
assert.deepEqual(errors, []);
await browser.close();
console.log('Candidate refresh: pre-reveal empty list updates, active filters survive and failed requests retain profiles');
