/* Native Apple Safari via Apple's safaridriver, on macOS.
   Real page/scripts, isolated Firebase fixture; never changes live queues.
   npm install --no-save selenium-webdriver; node this-file.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Builder, By, until, Key } = require('selenium-webdriver');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const user = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com', emailVerified: true, displayName: 'Test Admin', providerData: [] };
const job = id => ({ path: 'jobReviews/' + id, data: { rowId: id, status: 'pending', row: {
  id, year: 2027, institution: 'Test ' + id + ' University', school: 'Business School', unit: 'Operations Management',
  posted: '2026-11-01', country: 'Ireland', adUrl: 'https://example.edu/jobs/' + id
} } });
const fix = id => ({ path: 'nameFixes/' + id, data: { kind: 'institution', from: 'Test ' + id, to: 'Test ' + id + ' University', status: 'pending' } });
const shim = fs.readFileSync(path.join(root, '_scraper/_fake-firebase.js'), 'utf8');
let news = [], years = [];
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/admin-area') url += '.html';
  // Safari WebDriver has no Playwright routing API. Local SDK substitution
  // plus CSP provides the same fixture boundary, including blocking real auth.
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:");
  if (url.startsWith('/__test/firebase/')) {
    res.setHeader('Content-Type', 'text/javascript'); return res.end(shim);
  }
  const fixtures = {
    '/data/candidates-meta.json': { heldCount: 0, revealAt: '2099-01-01' },
    '/data/jobs.json': [], '/changelog.json': { updates: news },
    '/data/jobs-yearcheck.json': { postings: years }
  };
  if (Object.hasOwn(fixtures, url)) {
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(fixtures[url]));
  }
  const file = path.resolve(root, '.' + url);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
  if (url === '/admin-area.html') {
    const seed = JSON.stringify({ user, realtime: true, docs: [] });
    const init = '<script>window.__FAKE_FB=' + seed + ';window.__testDocumentId=String(Date.now())+":"+String(Math.random());window.__testErrors=[];window.addEventListener("error",function(e){if(e.error)__testErrors.push(String(e.error));});window.addEventListener("unhandledrejection",function(e){__testErrors.push(String(e.reason));});</script>';
    return res.end(fs.readFileSync(file, 'utf8').replace('<head>', '<head>' + init));
  }
  if (url === '/assets/oa-firebase.js') {
    return res.end(fs.readFileSync(file, 'utf8').replace("var SDK = 'https://www.gstatic.com/firebasejs/10.12.5/';", "var SDK = '/__test/firebase/';"));
  }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  assert.equal(process.platform, 'darwin', 'native Safari requires macOS');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  fs.mkdirSync(output, { recursive: true });
  try {
    driver = await new Builder().forBrowser('safari').build();
    const caps = await driver.getCapabilities();
    assert.equal(caps.get('browserName').toLowerCase(), 'safari');
    console.log('Native Safari ' + caps.get('browserVersion') + ' on ' + caps.get('platformName'));
    await driver.manage().window().setRect({ width: 1280, height: 900 });
    await driver.get('http://127.0.0.1:' + server.address().port + '/admin-area');
    const execute = (script, ...args) => driver.executeScript(script, ...args);
    const wait = (fn, label) => driver.wait(fn, 15000, label);
    async function element(selector) {
      const el = await driver.wait(until.elementLocated(By.css(selector)), 15000);
      await driver.wait(until.elementIsVisible(el), 15000);
      return el;
    }
    async function click(selector) { await (await element(selector)).click(); }
    async function fill(selector, value) { const el = await element(selector); await el.clear(); await el.sendKeys(value); }
    const isOpen = id => execute('return document.querySelector("#"+arguments[0]+" .oa-aa-section").open', id);
    async function count(key, n) {
      await wait(() => execute('return document.querySelector("[data-oa-count="+arguments[0]+"] .oa-aa-tile-n").textContent===String(arguments[1])', key, n), key + ' reaches ' + n);
      assert.equal(await execute('return JSON.parse(localStorage.getItem("oaAdminSummary:v1")).counts[arguments[0]]', key), n);
    }
    async function arrive(doc) { await execute('window.__fb.docs[arguments[0].path]=arguments[0].data;window.__fb.notify(arguments[0].path);', doc); }
    await wait(() => execute('return !!document.querySelector("#oa-aa-summary-status").hidden'), 'initial counts ready');
    // A fresh marker per document detects a reload without relying on
    // Safari's privacy-rounded performance timestamps remaining bit-identical.
    const navigation = await execute('return window.__testDocumentId');
    await count('jobs', 0);
    assert.equal(await isOpen('oa-review'), false);
    await arrive(job('one'));
    await count('jobs', 1);
    await element('[data-review-id="one"]');
    assert.equal(await isOpen('oa-review'), true);
    await click('[data-review-id="one"] [data-act="edit"]');
    await fill('[data-review-id="one"] [data-key="school"]', 'Unsaved Safari school correction');
    await click('#oa-review .oa-aa-section > summary');
    const newest = job('two');
    newest.data.row.posted = '2026-11-02';
    await arrive(newest);
    await count('jobs', 2);
    await element('[data-review-id="two"]');
    assert.equal(await isOpen('oa-review'), true);
    assert.equal(await (await element('[data-review-id="one"] [data-key="school"]')).getAttribute('value'), 'Unsaved Safari school correction');
    const fieldIds = await execute('return Array.from(document.querySelectorAll("[data-review-id] [id]"),function(el){return el.id})');
    assert.equal(new Set(fieldIds).size, fieldIds.length, 'incoming cards keep unique field IDs');
    console.log('PASS: arrivals update counters, open the section and preserve unsaved job edits');

    await execute('window.__fb.holdReads=["jobSubmissions/"];');
    await click('[data-review-id="one"] [data-act="approve"]');
    await count('jobs', 1);
    assert.equal(await isOpen('oa-review'), true);
    await execute('window.__fb.holdReads=[];window.__fb.release();');
    const reject = await element('[data-review-id="two"] [data-act="reject"]');
    await execute('arguments[0].focus()', reject);
    await reject.sendKeys(Key.ENTER);
    await count('jobs', 0);
    assert.equal(await isOpen('oa-review'), false);
    assert.equal(await execute('return document.activeElement===document.querySelector("#oa-review .oa-aa-section > summary")'), true);
    await arrive(job('three'));
    await count('jobs', 1);
    await execute('window.__fb.holdReads=["jobSubmissions/"];');
    await click('[data-review-id="three"] [data-act="approve"]');
    await count('jobs', 0);
    assert.equal(await isOpen('oa-review'), false);
    await execute('window.__fb.holdReads=[];window.__fb.release();');
    console.log('PASS: last approval/rejection updates and collapses immediately, including delayed mirror reads');

    await arrive(fix('alpha'));
    await count('names', 1);
    await fill('.oa-aa-fix[data-id="alpha"] [data-role="to"]', 'Unsaved Safari name correction');
    await click('#oa-aa-names .oa-aa-section > summary');
    await arrive(fix('beta'));
    await count('names', 2);
    await element('.oa-aa-fix[data-id="beta"]');
    assert.equal(await isOpen('oa-aa-names'), true);
    assert.equal(await (await element('.oa-aa-fix[data-id="alpha"] [data-role="to"]')).getAttribute('value'), 'Unsaved Safari name correction');
    await click('.oa-aa-fix[data-id="alpha"] [data-act="approve"]');
    await count('names', 1);
    await click('.oa-aa-fix[data-id="beta"] [data-act="reject"]');
    await count('names', 0);
    assert.equal(await isOpen('oa-aa-names'), false);
    console.log('PASS: name-correction drafts, decisions and automatic collapse');

    for (const [doc, key, id] of [
      [{path:'feedback/new',data:{status:'open',message:'Safari test feedback'}},'feedback','oa-inbox'],
      [{path:'messages/new',data:{needsAdmin:true}},'messages','oa-aa-users'],
      [{path:'candidateSubmissions/new',data:{status:'queued',name:'Test Candidate'}},'candidates','oa-aa-cands']
    ]) {
      await arrive(doc); await count(key, 1); assert.equal(await isOpen(id), true);
    }
    news = [{id:'safari-news',date:'2026-11-13',title:'Safari test update',summary:'Test only'}];
    years = [{id:'safari-year',stored:2026,should:2027,institution:'Test University'}];
    await execute('window.dispatchEvent(new Event("online"));');
    await count('news', 1); await count('yearcheck', 1);
    assert.equal(await isOpen('oa-aa-news'), true);
    assert.equal(await isOpen('oa-aa-yc'), true);
    assert.equal(await execute('return window.__testDocumentId'), navigation, 'no page reload');
    assert.equal(await execute('return document.documentElement.scrollWidth>innerWidth'), false);
    assert.deepEqual(await execute('return window.__testErrors'), []);
    fs.writeFileSync(path.join(output, 'native-safari-admin.png'), await driver.takeScreenshot(), 'base64');
    await execute('OAAccounts.signOut();');
    await wait(() => execute('return !OAAccounts.isAdmin() && __fb.subscriptions.length===0'), 'sign-out completes');
    assert.equal(await execute('return __fb.subscriptions.length'), 0);
    assert.equal(await execute('return localStorage.getItem("oaAdminSummary:v1")'), null);
    console.log('PASS: all other queues, no reload, no script errors, and sign-out cleanup');
  } catch (error) {
    if (driver) {
      try { fs.writeFileSync(path.join(output, 'native-safari-failure.png'), await driver.takeScreenshot(), 'base64'); } catch (_) {}
    }
    throw error;
  } finally {
    if (driver) await driver.quit();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
