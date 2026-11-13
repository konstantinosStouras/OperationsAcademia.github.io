/* Admin frame interaction checks. Uses the real page without live accounts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split('?')[0]);
  if (name === '/admin-area') name += '.html';
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const ADMIN = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com', emailVerified: true, displayName: 'Test Admin', providerData: [] };
const counts = { jobs: 8, candidates: 0, feedback: 0, news: 0, names: 0, messages: 0, yearcheck: 0, users: 468 };
const job = id => ({ path: 'jobReviews/' + id, data: { rowId: id, status: 'pending',
  row: { id, year: 2027, institution: 'Test University', posted: '2026-11-01', country: 'Ireland' } } });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const shim = fs.readFileSync(path.join(root, '_scraper/_fake-firebase.js'), 'utf8');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
  try {
    async function fixture({ cache, hint = ADMIN, user = ADMIN, hold = [], docs = [], blockScripts = false } = {}) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (blockScripts && route.request().resourceType() === 'script') await gate;
        if (url.includes('/firebasejs/')) return route.fulfill({ contentType: 'text/javascript', body: shim });
        if (!url.startsWith(base)) return route.abort();
        if (url.includes('/changelog.json')) return route.fulfill({ json: { updates: [] } });
        if (url.includes('/data/candidates-meta.json')) return route.fulfill({ json: { heldCount: 0, revealAt: '2020-01-01' } });
        if (url.includes('/data/jobs-yearcheck.json')) return route.fulfill({ json: { postings: [] } });
        return route.continue();
      });
      await page.addInitScript(({ cache, hint, user, hold, docs }) => {
        window.__FAKE_FB = { user, docs, holdReads: hold };
        if (hint) localStorage.setItem('oaAuthHint', JSON.stringify(hint));
        if (cache) localStorage.setItem('oaAdminSummary:v1', JSON.stringify(cache));
      }, { cache, hint, user, hold, docs });
      await page.goto(base + '/admin-area', { waitUntil: 'commit' });
      return { page, context, errors, release };
    }
    const cache = { uid: ADMIN.uid, at: Date.now(), counts };
    // The summary paints from HTML/local storage while ALL external scripts
    // are held. Neither Firebase nor the admin module can be responsible.
    const f = await fixture({ cache, docs: [job('one')], hold: ['newsOverrides'], blockScripts: true });
    const p = f.page;
    await p.locator('#oa-aa-tiles').waitFor({ state: 'visible' });
    assert.equal(await p.locator('[data-oa-count="jobs"] .oa-aa-tile-n').textContent(), '8');
    assert.equal(await p.locator('[data-oa-count="users"] .oa-aa-tile-n').textContent(), '468');
    assert.equal(await p.evaluate(() => typeof window.OAAccounts), 'undefined');
    assert.equal(await p.locator('#oa-aa-admin > .oa-panel:visible').count(), 0);
    assert.match(await p.locator('#oa-aa-summary-status').textContent(), /Last known/);
    f.release();
    await p.waitForFunction(() => window.OAAccounts && OAAccounts.isAdmin());
    await p.waitForFunction(() => document.querySelector('[data-oa-count="jobs"] .oa-aa-tile-n').textContent === '1');
    assert.equal(await p.locator('#oa-review > details').evaluate(el => el.open), true,
      'job queue opens before the held news counter completes');
    assert.equal(await p.locator('#oa-aa-users > details').evaluate(el => el.open), false,
      'registered-user total does not open the roster');
    assert.equal(await p.locator('#oa-inbox > details').evaluate(el => el.open), false);
    await p.locator('#oa-review-publication').waitFor({ state: 'visible' });
    await p.locator('#oa-review > details > summary').click();
    await p.evaluate(() => { window.__fb.holdReads = []; window.__fb.release(); });
    await p.locator('#oa-aa-summary-status').waitFor({ state: 'hidden' });
    await p.evaluate(() => OAAdminArea.refresh());
    assert.equal(await p.locator('#oa-review > details').evaluate(el => el.open), false,
      'unchanged counts never undo a manual collapse');
    await p.evaluate(async data => {
      const fb = await OAFB.ready();
      await fb.firestore().collection('jobReviews').doc('two').set(data);
      await OAAdminArea.refresh();
    }, job('two').data);
    assert.equal(await p.locator('#oa-review > details').evaluate(el => el.open), true,
      'a genuinely increased queue opens again');
    assert.equal(await p.locator('script[src*="assets/oa-jobreview.js"]').count(), 1);
    // Updating a number must not replace the tile or steal keyboard focus.
    await p.locator('[data-oa-count="jobs"]').focus();
    await p.evaluate(() => OAAdminArea.refresh());
    assert.equal(await p.evaluate(() => document.activeElement.getAttribute('data-oa-count')), 'jobs');
    await p.evaluate(() => OAAccounts.signOut());
    assert.equal(await p.evaluate(() => localStorage.getItem('oaAdminSummary:v1')), null);
    assert.equal(await p.locator('#oa-aa-admin').isVisible(), false);
    assert.deepEqual(f.errors, []);
    await f.context.close();

    // First visits have the grid immediately after authentication; each count
    // can finish independently without a stored summary.
    const first = await fixture({ hold: ['newsOverrides'], docs: [job('first')] });
    await first.page.waitForFunction(() => window.OAAccounts && OAAccounts.isAdmin());
    await first.page.locator('#oa-aa-tiles').waitFor({ state: 'visible' });
    await first.page.waitForFunction(() => document.querySelector('[data-oa-count="jobs"] .oa-aa-tile-n').textContent === '1');
    assert.equal(await first.page.locator('[data-oa-count="news"] .oa-aa-tile-n').textContent(), '?');
    assert.equal(await first.page.locator('#oa-review > details').evaluate(el => el.open), true);
    await first.context.close();

    for (const invalid of [
      { ...cache, uid: 'another-account' },
      { ...cache, at: Date.now() - 86400001 }
    ]) {
      const x = await fixture({ cache: invalid, blockScripts: true });
      await x.page.locator('#oa-aa-tiles').waitFor({ state: 'attached' });
      assert.equal(await x.page.locator('#oa-aa-tiles').isVisible(), false,
        'a mismatched or expired cache never previews admin counts');
      x.release();
      await x.context.close();
    }
    console.log('admin-summary: pre-script cached paint, independent live counts, positive queues, manual close, cache isolation and sign-out passed');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
