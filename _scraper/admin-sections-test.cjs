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
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const shim = fs.readFileSync(path.join(root, '_scraper/_fake-firebase.js'), 'utf8');
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.includes('/firebasejs/')) return route.fulfill({ contentType: 'text/javascript', body: shim });
      if (!url.startsWith(base)) return route.abort();
      // This suite exercises empty sections. Nonzero queues auto-open and
      // are covered separately by admin-summary-test.cjs.
      if (url.includes('/changelog.json')) return route.fulfill({ json: { updates: [] } });
      if (url.includes('/data/candidates-meta.json')) return route.fulfill({ json: { heldCount: 0, revealAt: '2020-01-01' } });
      if (url.includes('/data/jobs-yearcheck.json')) return route.fulfill({ json: { postings: [] } });
      return route.continue();
    });
    await page.addInitScript(() => {
      window.__FAKE_FB = {
        user: { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com', emailVerified: true,
          displayName: 'Test Admin', providerData: [] },
        docs: [{ path: 'userDirectory/one', data: { name: 'Test Person', email: 'person@example.edu',
          affiliation: 'Test University', first: 1000, seen: 2000 } },
          { path: 'accountDeletions/erasing-one', data: { uid: 'erasing-one', status: 'clearing', accessBlockedAt: 123, email: 'erasing@example.edu' } },
          { path: 'accountDeletions/done-one', data: { uid: 'done-one', status: 'done', doneAt: Date.now() } }]
      };
    });
    const ready = async () => {
      await page.locator('#oa-aa-admin').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#oa-aa-tiles a').length === 8);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#oa-aa-tiles .oa-aa-tile-n'))
        .every(el => el.textContent !== '?'));
      assert.equal(await page.locator('#oa-review-publication').count(), 0,
        'closed job section does not fetch or render publication data');
      assert.equal(await page.evaluate(() => typeof window.OAUsers), 'undefined',
        'closed roster does not download its tools');
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
        .some(r => /\/data\/(jobs|candidates)\.json/.test(r.name))), false,
        'closed sections do not download full jobs or candidate feeds');
    };
    await page.goto(base + '/admin-area');
    await ready();
    const sections = page.locator('#oa-aa-admin > .oa-panel > .oa-aa-section');
    assert.equal(await sections.count(), 8);
    assert.equal(await page.locator('.oa-aa-section[open]').count(), 0, 'all eight empty sections start closed');
    for (let i = 0; i < 8; i++) {
      const section = sections.nth(i);
      await section.waitFor({ state: 'visible' });
      const summary = section.locator(':scope > summary');
      const isOpen = () => section.evaluate(el => el.open);
      assert.equal(await section.locator('.oa-aa-section-plus').isVisible(), true);
      assert.equal(await section.locator('.oa-aa-section-body').isVisible(), false);
      await section.locator('.oa-aa-section-icon').click();
      assert.equal(await isOpen(), true, 'plus opens');
      await page.waitForFunction(id => !document.getElementById(id).hasAttribute('aria-busy'),
        await section.evaluate(el => el.parentElement.id));
      if (i === 0) await page.locator('#oa-review-publication').waitFor({ state: 'visible' });
      if (i === 7) {
        await page.locator('#oa-aa-users .oa-u-table').waitFor({ state: 'visible' });
        const progress = await page.locator('#oa-u-deletion-progress').textContent();
        assert.match(progress, /erasing@example.edu: Access blocked; deleting data/);
        assert.match(progress, /Account done-one: Deleted/);
        assert.equal(await page.locator('#oa-aa-users .oa-u-table tbody tr[data-uid="erasing-one"]').count(), 0,
          'deletion progress remains visible after the deleted roster row is gone');
      }
      assert.equal(await section.locator('.oa-aa-section-minus').isVisible(), true);
      assert.equal(await section.locator('.oa-aa-section-body').isVisible(), true);
      await section.locator('.oa-aa-section-icon').click();
      assert.equal(await isOpen(), false, 'minus closes');
      if (i === 0) assert.equal(await page.locator('#oa-review-publication').isVisible(), false,
        'asynchronously added publication status stays inside the closed frame');
      await summary.click({ position: { x: 5, y: 3 } });
      assert.equal(await isOpen(), true, 'top frame edge opens');
      await summary.click({ position: { x: 5, y: 3 } });
      assert.equal(await isOpen(), false, 'top frame edge closes');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await isOpen(), true, 'Enter opens');
      await page.keyboard.press('Space');
      assert.equal(await isOpen(), false, 'Space closes');
    }
    await page.waitForLoadState('networkidle');
    const loadTotals = () => page.evaluate(() => ({
      scripts: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script').length,
      reads: window.__fb.log.filter(r => ['get', 'list', 'query'].includes(r.op)).length
    }));
    const loaded = await loadTotals();
    for (let i = 0; i < 8; i++) {
      await sections.nth(i).locator(':scope > summary').click();
      await sections.nth(i).locator(':scope > summary').click();
    }
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await loadTotals(), loaded, 'reopening uses loaded tools and data');
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.innerHTML = '<input id="draft" value="unsaved edit"><button id="action">Action</button><details id="nested" open><summary>Reviewed</summary>Kept</details>';
      document.querySelector('.oa-aa-section-body').appendChild(fixture);
      document.querySelector('#action').onclick = () => { window.actionCount = (window.actionCount || 0) + 1; };
    });
    await sections.nth(0).locator('summary').first().click();
    await page.locator('#draft').fill('keep this draft');
    await sections.nth(1).locator('summary').first().click();
    assert.equal(await page.locator('.oa-aa-section[open]').count(), 2, 'independent sections');
    for (let i = 0; i < 2; i++) {
      await sections.nth(0).locator('summary').first().click();
      await page.locator('#oa-aa-tiles a[href="#oa-review"]').click();
      assert.equal(await sections.nth(0).evaluate(el => el.open), true, 'tile opens and reopens');
    }
    assert.equal(await page.locator('#draft').inputValue(), 'keep this draft');
    assert.equal(await page.locator('#nested').evaluate(el => el.open), true);
    await page.locator('#action').click();
    assert.equal(await page.evaluate(() => window.actionCount), 1, 'listeners preserved');
    await page.reload();
    await ready();
    assert.equal(await page.locator('.oa-aa-section[open]').count(), 0, 'reload starts closed');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}/${theme}`);
        assert.equal(await page.locator('.oa-aa-section-head').evaluateAll(nodes => nodes.every(el => {
          const icon = el.querySelector('.oa-aa-section-icon').getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return icon.width >= 44 && icon.height >= 44 && icon.right <= box.right && icon.left >= box.left;
        })), true, '44px controls fit every frame');
        await sections.nth(7).locator('summary').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'expanded roster fits');
        await sections.nth(7).locator('summary').click();
      }
    }
    // A failed first download can be retried without duplicating controls.
    await page.reload();
    await ready();
    let attempts = 0;
    await page.route('**/assets/oa-users.js*', route => {
      attempts++;
      return attempts === 1 ? route.abort() : route.fallback();
    });
    await sections.nth(7).locator('summary').click();
    await sections.nth(7).getByRole('button', { name: 'Try again' }).click();
    await page.locator('#oa-aa-users .oa-u-table').waitFor({ state: 'visible' });
    assert.equal(attempts, 2);
    assert.equal(await page.locator('#oa-aa-users .oa-u-table').count(), 1);
    assert.equal(await page.locator('script[src*="assets/oa-users.js"]').count(), 1);
    await page.reload();
    await ready();
    attempts = 0;
    await sections.nth(7).locator('summary').click();
    await sections.nth(7).getByRole('button', { name: 'Try again' }).waitFor();
    await sections.nth(7).locator('summary').click();
    await sections.nth(7).locator('summary').click();
    await page.locator('#oa-aa-users .oa-u-table').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#oa-aa-users').hasAttribute('aria-busy'));
    assert.equal(attempts, 2, 'reopening can also retry the failed download');
    assert.equal(await sections.nth(7).locator('.oa-aa-loading').count(), 0, 'no stale failure notice');
    assert.deepEqual(errors, []);
    console.log('admin-sections: eight frames, keyboard, tiles, preserved edits, reload, light/dark and desktop/mobile passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
