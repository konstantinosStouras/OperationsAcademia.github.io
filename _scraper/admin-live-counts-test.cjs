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
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const p = await context.newPage();
      const errors = [];
      let revealAt = '2099-01-01';
      let news = [], years = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.route('**/*', route => {
        const url = route.request().url();
        if (url.includes('/firebasejs/')) return route.fulfill({ contentType: 'text/javascript', body: shim });
        if (!url.startsWith(base)) return route.abort();
        if (url.includes('/changelog.json')) return route.fulfill({ json: { updates: news } });
        if (url.includes('/data/candidates-meta.json')) return route.fulfill({ json: { heldCount: 0, revealAt } });
        if (url.includes('/data/jobs-yearcheck.json')) return route.fulfill({ json: { postings: years } });
        if (/\/data\/jobs\.json(?:\?|$)/.test(url)) return route.fulfill({ json: [] });
        return route.continue();
      });
      await p.addInitScript(user => { window.__FAKE_FB = { user, realtime: true, docs: [] }; }, admin);
      await p.goto(base + '/admin-area');
      await p.waitForFunction(() => document.querySelector('#oa-aa-summary-status').hidden);
      const navigation = await p.evaluate(() => performance.timeOrigin);
      const section = id => p.locator('#' + id + ' .oa-aa-section');
      async function count(key, n) {
        await p.waitForFunction(({key,n}) => document.querySelector('[data-oa-count="'+key+'"] .oa-aa-tile-n').textContent === String(n), {key,n}, {timeout:3000});
        assert.equal(await p.evaluate(key => JSON.parse(localStorage.getItem('oaAdminSummary:v1')).counts[key], key), n);
      }
      async function arrive(doc) {
        await p.evaluate(({path,data}) => { __fb.docs[path] = data; __fb.notify(path); }, doc);
      }
      await count('jobs', 0);
      assert.equal(await section('oa-review').evaluate(el => el.open), false);
      const listeners = await p.evaluate(() => __fb.subscriptions.length);
      assert.equal(listeners, 8, 'one listener per database queue/statistic');
      await arrive(job('one'));
      await count('jobs', 1);
      await p.locator('#oa-review-publication').waitFor();
      assert.equal(await section('oa-review').evaluate(el => el.open), true);
      const first = p.locator('[data-review-id="one"]');
      await first.getByRole('button', { name: 'Edit', exact: true }).click();
      await first.locator('[data-key="school"]').fill('Unsaved school correction');
      await section('oa-review').locator('summary').click();
      await arrive(job('two'));
      await count('jobs', 2);
      await p.locator('[data-review-id="two"]').waitFor();
      assert.equal(await section('oa-review').evaluate(el => el.open), true);
      assert.equal(await first.locator('[data-key="school"]').inputValue(), 'Unsaved school correction', 'arrivals preserve unsaved fields');
      await first.getByRole('button', { name: 'Reject', exact: true }).click();
      await count('jobs', 1);
      await p.locator('[data-review-id="two"]').getByRole('button', { name: 'Reject', exact: true }).click();
      await count('jobs', 0);
      assert.equal(await section('oa-review').evaluate(el => el.open), false);
      await arrive(job('three'));
      await count('jobs', 1);
      await p.locator('[data-review-id="three"]').waitFor();
      assert.equal(await section('oa-review').evaluate(el => el.open), true, 'arrival reopens a cleared section');
      // Cached and unconfirmed local snapshots must never change the queue.
      await p.evaluate(() => {
        __fb.docs['jobReviews/three'].status = 'approved';
        const sub = __fb.subscriptions.find(s => s.ref.path === 'jobReviews');
        sub.emit({fromCache:true,hasPendingWrites:false});
        sub.emit({fromCache:false,hasPendingWrites:true});
      });
      await count('jobs', 1);
      await p.evaluate(() => { __fb.docs['jobReviews/three'].status = 'pending'; });
      await section('oa-review').locator('summary').click();
      await p.evaluate(data => { delete __fb.docs['jobReviews/three']; __fb.docs['jobReviews/four'] = data; __fb.notify(); }, job('four').data);
      await p.locator('[data-review-id="four"]').waitFor();
      assert.equal(await section('oa-review').evaluate(el => el.open), true, 'same-sized queue with a new item opens');

      await arrive(fix('alpha'));
      await count('names', 1);
      await p.locator('.oa-aa-fix[data-id="alpha"] [data-role="to"]').fill('Unsaved name correction');
      await section('oa-aa-names').locator('summary').click();
      await arrive(fix('beta'));
      await count('names', 2);
      await p.locator('.oa-aa-fix[data-id="beta"]').waitFor();
      assert.equal(await p.locator('.oa-aa-fix[data-id="alpha"] [data-role="to"]').inputValue(), 'Unsaved name correction');
      assert.equal(await section('oa-aa-names').evaluate(el => el.open), true);
      await arrive({path:'feedback/new',data:{status:'open',message:'New test feedback'}});
      await count('feedback', 1);
      assert.equal(await section('oa-inbox').evaluate(el => el.open), true);
      await arrive({path:'messages/new',data:{needsAdmin:true}});
      await count('messages', 1);
      assert.equal(await section('oa-aa-users').evaluate(el => el.open), true);
      await arrive({path:'candidateSubmissions/new',data:{status:'queued',name:'Test Candidate'}});
      await count('candidates', 1);
      assert.equal(await section('oa-aa-cands').evaluate(el => el.open), true);
      // The generated metadata is revalidated on returning online; an old
      // memo must not leave a held count after the reveal date changes.
      revealAt = '2020-01-01';
      news = [{id:'live-news',date:'2026-11-13',title:'Test pending update',summary:'Test only'}];
      years = [{id:'live-year',stored:2026,should:2027,institution:'Test University'}];
      await p.evaluate(() => window.dispatchEvent(new Event('online')));
      await count('candidates', 0);
      await count('news', 1);
      await count('yearcheck', 1);
      assert.equal(await section('oa-aa-news').evaluate(el => el.open), true);
      assert.equal(await section('oa-aa-yc').evaluate(el => el.open), true);
      await arrive({path:'newsOverrides/live-news',data:{status:'approved'}});
      await count('news', 0);
      await arrive({path:'yearChecks/live-year',data:{status:'settled',stored:2026,should:2027}});
      await count('yearcheck', 0);
      // A failed subscription keeps the last count, then resumes exactly once.
      await p.evaluate(() => __fb.subscriptions.find(s => s.ref.path === 'jobReviews').fail());
      await count('jobs', 1);
      await p.evaluate(() => window.dispatchEvent(new Event('online')));
      await p.waitForFunction(n => __fb.subscriptions.length === n, listeners);
      await arrive(job('five'));
      await count('jobs', 2);
      await arrive(job('one'));
      await count('jobs', 3);
      await p.locator('[data-review-id="one"]').getByRole('button', {name:'Reject',exact:true}).waitFor();
      assert.equal(await p.locator('[data-review-id="one"]').getByRole('button', {name:'Reject',exact:true}).isEnabled(), true, 'requeued item replaces its old confirmation card');
      assert.equal(await p.evaluate(() => performance.timeOrigin), navigation);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await p.evaluate(() => OAAccounts.signOut());
      assert.equal(await p.evaluate(() => __fb.subscriptions.length), 0, 'sign-out detaches every subscription');
      await arrive(job('signed-out'));
      assert.equal(await p.evaluate(() => localStorage.getItem('oaAdminSummary:v1')), null);
      assert.equal(await p.locator('#oa-aa-admin').isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('admin-live-counts: '+viewport.width+'px arrivals, auto-opening, preserved edits, last-item decisions, cache/pending-write guards, reconnect and sign-out passed');
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
