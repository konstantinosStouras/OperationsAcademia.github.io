/* Real admin controls, isolated Firebase fixture: never decides live items. */
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
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const admin = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com', emailVerified: true, displayName: 'Test Admin', providerData: [] };
const job = id => ({ path: 'jobReviews/' + id, data: { rowId: id, status: 'pending',
  row: { id, year: 2027, institution: 'Test ' + id + ' University', school: 'Business School', unit: 'Operations Management', posted: '2026-11-01', country: 'Ireland', adUrl: 'https://example.edu/jobs/' + id } } });
const fix = id => ({ path: 'nameFixes/' + id, data: { kind: 'institution', from: 'Test ' + id, to: 'Test ' + id + ' University', status: 'pending' } });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const shim = fs.readFileSync(path.join(root, '_scraper/_fake-firebase.js'), 'utf8');
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      async function fixture(docs) {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => {
          const url = route.request().url();
          if (url.includes('/firebasejs/')) return route.fulfill({ contentType: 'text/javascript', body: shim });
          if (!url.startsWith(base)) return route.abort();
          if (url.includes('/changelog.json')) return route.fulfill({ json: { updates: [] } });
          if (url.includes('/data/candidates-meta.json')) return route.fulfill({ json: { heldCount: 0, revealAt: '2020-01-01' } });
          if (url.includes('/data/jobs-yearcheck.json')) return route.fulfill({ json: { postings: [] } });
          if (/\/data\/jobs\.json(?:\?|$)/.test(url)) return route.fulfill({ json: [] });
          return route.continue();
        });
        await page.addInitScript(({ user, docs }) => { window.__FAKE_FB = { user, docs }; }, { user: admin, docs });
        await page.goto(base + '/admin-area');
        await page.locator('#oa-review-publication').waitFor();
        await page.waitForFunction(() => document.querySelector('#oa-aa-summary-status').hidden);
        return { context, page, errors };
      }
      const f = await fixture([job('one'), job('two'), job('three'), fix('alpha'), fix('beta')]);
      const p = f.page;
      const initialNavigation = await p.evaluate(() => performance.timeOrigin);
      const tile = key => p.locator('[data-oa-count="' + key + '"] .oa-aa-tile-n');
      const card = id => p.locator('#oa-review-list .oa-rv-card').filter({ hasText: 'Test ' + id + ' University' });
      async function count(key, n) {
        await p.waitForFunction(({ key, n }) => document.querySelector('[data-oa-count="' + key + '"] .oa-aa-tile-n').textContent === String(n), { key, n }, { timeout: 3000 });
        assert.equal(await p.evaluate(key => JSON.parse(localStorage.getItem('oaAdminSummary:v1')).counts[key], key), n, 'cached counter follows the visible count');
      }
      await count('jobs', 3);
      await count('names', 2);
      // One old count has finished, but a different queue holds the combined
      // request open. Approval must update now and survive that late result.
      await p.evaluate(() => { __fb.holdReads = ['feedback', 'jobSubmissions/']; window.__countRefresh = OAAdminArea.refresh(); });
      await p.waitForFunction(() => __fb.holding.length > 0);
      await card('one').getByRole('button', { name: 'Approve & publish', exact: true }).click();
      await p.waitForFunction(() => __fb.docs['jobReviews/one'].status === 'approved');
      await count('jobs', 2);
      await p.evaluate(async () => { __fb.holdReads = []; __fb.release(); await window.__countRefresh; });
      await count('jobs', 2);
      // The old jobs response itself can also arrive after a rejection.
      await p.evaluate(async () => {
        const db = (await OAFB.ready()).firestore();
        const proto = Object.getPrototypeOf(db.collection('jobReviews').where('status', '==', 'pending'));
        const get = proto.get;
        proto.get = function () {
          const result = get.call(this);
          if (window.__holdJobCount && this.path === 'jobReviews' && this.__f.some(f => f[0] === 'status' && f[1] === 'pending')) {
            window.__holdJobCount = false;
            return result.then(snap => new Promise(resolve => { window.__releaseJobCount = () => resolve(snap); }));
          }
          return result;
        };
        window.__holdJobCount = true;
        window.__countRefresh = OAAdminArea.refresh();
      });
      await p.waitForFunction(() => !!window.__releaseJobCount);
      await card('two').getByRole('button', { name: 'Reject', exact: true }).click();
      await count('jobs', 1);
      await p.evaluate(async () => { __releaseJobCount(); await __countRefresh; });
      await count('jobs', 1);
      await card('three').getByRole('button', { name: 'Reject', exact: true }).click();
      await count('jobs', 0);
      assert.equal(await p.locator('[data-oa-count="jobs"]').evaluate(el => el.classList.contains('is-due')), false);
      // Name corrections must update before the list's reread finishes too.
      await p.locator('.oa-aa-fix[data-id="alpha"]').waitFor();
      await p.evaluate(() => { __fb.holdReads = ['nameFixes']; });
      await p.locator('.oa-aa-fix[data-id="alpha"] [data-act="approve"]').click();
      await count('names', 1);
      await p.evaluate(() => { __fb.holdReads = []; __fb.release(); });
      await p.locator('.oa-aa-fix[data-id="beta"] [data-act="reject"]').click();
      await count('names', 0);
      assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('oa-acct-counts')).n.admin), 0, 'account badge agrees with an empty queue');
      await p.locator('.oa-aa-fix[data-id="alpha"] [data-act="reopen"]').click();
      await count('names', 1);
      assert.equal(await p.evaluate(() => performance.timeOrigin), initialNavigation, 'no page reload was needed');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(f.errors, []);
      await f.context.close();

      const bulk = await fixture([job('bulk-good'), job('bulk-fail')]);
      const b = bulk.page;
      await b.evaluate(async () => {
        const db = (await OAFB.ready()).firestore();
        const proto = Object.getPrototypeOf(db.collection('jobReviews').doc('bulk-fail'));
        const set = proto.set;
        proto.set = function (data, opts) {
          if (this.path === 'jobReviews/bulk-fail' && data.status === 'approved') return Promise.reject(new Error('Test write refused'));
          return set.call(this, data, opts);
        };
      });
      await b.locator('#oa-review-all').click();
      await b.waitForFunction(() => /1 approved, 1 could not be saved/.test(document.querySelector('#oa-review-bulk-msg').textContent));
      assert.equal(await b.locator('[data-oa-count="jobs"] .oa-aa-tile-n').textContent(), '1', 'only successful bulk decisions leave the counter');
      assert.equal(await b.evaluate(() => __fb.docs['jobReviews/bulk-fail'].status), 'pending');
      await b.locator('#oa-review-list .oa-rv-card').filter({ hasText: 'Test bulk-fail University' }).getByRole('button', { name: 'Reject', exact: true }).click();
      await b.waitForFunction(() => document.querySelector('[data-oa-count="jobs"] .oa-aa-tile-n').textContent === '0');
      assert.deepEqual(bulk.errors, []);
      await bulk.context.close();
      console.log('admin-action-counts: ' + viewport.width + 'px approval, rejection, name corrections, bulk failure, stale reads, badge/cache and no-reload checks passed');
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
