import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    if (!path.extname(rel)) rel += '.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const fake = await readFile(new URL('./_fake-firebase.js', import.meta.url), 'utf8');
const member = { uid: 'synthetic-reader', email: 'reader@example.edu', emailVerified: true,
  displayName: 'Synthetic Reader', providerData: [{ providerId: 'google.com' }] };
const profile = { id: 'synthetic-candidate', year: new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear(),
  first: 'Synthetic', last: 'Candidate', name: 'Synthetic Candidate', affiliation: 'Example University',
  position: 'PhD Candidate', researchAreas: ['Optimization'], cvUrl: 'https://example.org/cv', informsDays: [] };
const metadata = { count: 34, heldCount: 0, revealAt: '2020-01-01', researchSummary: [
  { label: 'Machine learning', count: 16 }, { label: 'Optimization', count: 11 }, { label: 'Healthcare operations', count: 7 },
] };
const errors = [];
async function pageFor(user = null) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ user, profile }) => {
    window.__FAKE_FB = { user, docs: [], askProfile: false };
    window.__candidateFixture = profile;
    window.__candidateCalls = 0;
  }, { user, profile });
  await page.route('**/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', body: fake + `
    if (!window.__candidateCallableInstalled) {
      window.__candidateCallableInstalled = true;
      if (!firebase.apps.length) firebase.initializeApp({});
      const original = firebase.app().functions;
      firebase.app().functions = function () {
        const functions = original.apply(firebase.app(), arguments);
        const call = functions.httpsCallable;
        functions.httpsCallable = function (name) {
          if (name !== 'readCandidateProfiles') return call.call(functions, name);
          return function () {
            window.__candidateCalls++;
            if (!firebase.auth().currentUser) return Promise.reject(Error('unauthenticated'));
            if (window.__holdCandidateResponse) return new Promise(resolve => { window.__releaseCandidateResponse = () => resolve({data:{rows:[window.__candidateFixture]}}); });
            return Promise.resolve({data:{rows:[window.__candidateFixture],previewTargets:{'candidate-preview-1':window.__candidateFixture.id}}});
          };
        };
        return functions;
      };
    }` }));
  await page.route('**/data/candidates-meta.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(metadata) }));
  await page.route('**/data/candidates-reveal.json', route => route.fulfill({ contentType: 'application/json', body: '{"revealAt":"2020-01-01"}' }));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  return { context, page };
}
try {
  const { context, page } = await pageFor();
  const profileRequests = [];
  page.on('request', request => { if (request.url().includes('/data/candidates.json')) profileRequests.push(request.url()); });
  await page.goto(base + '/');
  await page.waitForFunction(() => document.getElementById('oa-cohort-count').textContent === '34');
  assert.equal(await page.locator('#oa-cohort-research-areas li').count(), 3);
  assert.equal(await page.locator('#candidates .oa-card').count(), 0);
  assert.equal(await page.locator('#candidates a.v3-btn').count(), 2);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#candidates').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at ' + width);
    const layout = await page.locator('#candidates .v3-lede').evaluate(element => getComputedStyle(element).textAlign);
    assert.equal(layout, width > 680 ? 'justify' : 'left');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await page.waitForFunction(() => {
        const head = document.querySelector('#candidates .v3-section-head');
        const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        const probe = document.createElement('span'); probe.style.color = color; document.body.appendChild(probe);
        const target = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(head).opacity === '1' && getComputedStyle(document.body).backgroundColor === target;
      });
      if (process.env.OA_PREVIEW_DIR && ((width === 1440 && theme === 'light') || (width === 390 && theme === 'light'))) {
        await mkdir(process.env.OA_PREVIEW_DIR, { recursive: true });
        await page.locator('#candidates').screenshot({ animations: 'disabled', path: path.join(process.env.OA_PREVIEW_DIR, 'candidate-home-' + width + '.png') });
      }
    }
  }
  metadata.count = 35;
  metadata.researchSummary[0].count = 17;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.getElementById('oa-cohort-count').textContent === '35');
  assert.match(await page.locator('#oa-cohort-research-areas').innerText(), /Machine learning · 17/);
  await page.route('**/data/candidates-meta.json', route => route.fulfill({ status: 503, body: 'temporarily unavailable' }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('#oa-cohort-status:not([hidden])');
  assert.equal(await page.locator('#oa-cohort-count').innerText(), '35', 'failed refresh keeps the last valid count');
  assert.deepEqual(profileRequests, [], 'homepage never downloads full profiles');
  assert.equal(await page.evaluate(() => window.__candidateCalls), 0);
  await page.goto(base + '/candidates');
  await page.waitForSelector('#oa-candidates .oa-card');
  assert.equal(await page.evaluate(() => window.__candidateCalls), 0, 'signed-out candidate page never invokes private callable');
  assert.ok(!(await page.locator('#oa-candidates').innerText()).includes(profile.name));
  await context.close();

  const warming = await pageFor(member);
  await warming.page.addInitScript(() => {
    window.__FAKE_FB.holdReads = ['profiles/synthetic-reader'];
  });
  await warming.page.goto(base + '/candidates');
  await warming.page.waitForFunction(() => window.__candidateCalls === 1);
  assert.equal(await warming.page.evaluate(() => OAAccounts.resolved()), false,
    'private request starts in parallel with the still-pending account-profile check');
  await warming.page.waitForSelector('#oa-candidates .oa-card');
  assert.equal(await warming.page.evaluate(() => OACandidateList.rows().every(row => row.previewOnly)), true,
    'only safe school previews render before the account is admitted');
  await warming.page.evaluate(() => { __fb.holdReads = []; __fb.release(); });
  await warming.page.waitForFunction(() => document.getElementById('oa-candidates').textContent.includes('Synthetic Candidate'));
  assert.equal(await warming.page.evaluate(() => window.__candidateCalls), 1,
    'the admitted account consumes the prefetched response without a duplicate call');
  assert.equal(await warming.page.locator('#oa-candidates .oa-loading').count(), 0);
  await warming.context.close();

  const signed = await pageFor(member);
  await signed.page.goto(base + '/candidates');
  await signed.page.waitForFunction(() => document.getElementById('oa-candidates').textContent.includes('Synthetic Candidate'));
  await signed.page.evaluate(() => {
    window.__holdCandidateResponse = true;
    OACandidateList.clear({ loading: true });
    window.__pendingListRefresh = OACandidateList.refresh();
    OACandidateList.rerender();
  });
  await signed.page.waitForFunction(() => typeof window.__releaseCandidateResponse === 'function');
  assert.equal(await signed.page.locator('#oa-candidates .oa-empty').count(), 0, 'pending account refresh never shows an empty list notice');
  assert.equal(await signed.page.locator('#oa-candidates .oa-loading').count(), 1);
  assert.equal(await signed.page.locator('#oa-reveal-note').isVisible(), false, 'collection notice stays hidden after reveal');
  await signed.page.evaluate(async () => {
    window.__releaseCandidateResponse();
    await window.__pendingListRefresh;
    window.__holdCandidateResponse = false;
  });
  await signed.page.locator('#oa-candidates .oa-card-head').first().click();
  await signed.page.waitForSelector('#oa-candidates .oa-card-body');
  assert.ok((await signed.page.locator('#oa-candidates').innerHTML()).includes(profile.cvUrl));
  await signed.page.evaluate(() => {
    window.__holdCandidateResponse = true;
    window.__pendingCandidateRead = OACandidateData.load();
  });
  await signed.page.waitForFunction(() => typeof window.__releaseCandidateResponse === 'function');
  await signed.page.evaluate(() => OAAccounts.signOut());
  await signed.page.waitForFunction(() => OAAccounts.resolved() && !OAAccounts.user());
  assert.ok(!(await signed.page.locator('#oa-candidates').innerHTML()).includes(profile.cvUrl), 'sign-out removes private material from DOM');
  assert.equal(await signed.page.evaluate(() => OACandidateList.rows().some(row => row.name)), false, 'sign-out clears the exportable row data');
  assert.deepEqual(await signed.page.evaluate(async () => {
    window.__releaseCandidateResponse(); return await window.__pendingCandidateRead;
  }), [], 'a late authenticated response cannot restore details after sign-out');
  await signed.page.waitForSelector('#oa-candidates .oa-card-locked');
  await signed.page.locator('#oa-candidates .oa-card-head').first().click();
  await signed.page.waitForSelector('.oa-modal');
  await signed.page.evaluate(() => {
    window.__holdCandidateResponse = false;
    return OAFB.ready().then(fb => fb.auth().signInWithPopup({}));
  });
  await signed.page.waitForSelector('#oa-candidates .oa-card-body:not([hidden])');
  assert.match(await signed.page.locator('#oa-candidates .oa-card-body').innerHTML(), /example.org\/cv/, 'the selected public preview opens once authenticated rows arrive');
  const race = await signed.page.evaluate(async () => {
    const host = document.createElement('div'); host.id = 'race-check'; document.body.appendChild(host);
    let release, calls = 0;
    const list = OAList.mount({ mount: '#race-check', filters: [],
      source: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve([{id:'new'}]),
      card: { title: row => row.id, subtitle: () => '', rows: [] } });
    await Promise.resolve();
    await list.refresh();
    release([{id:'old'}]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const ids = list.rows().map(row => row.id); host.remove(); return ids;
  });
  assert.deepEqual(race, ['new'], 'a slow initial preview cannot overwrite newer authenticated rows');
  await signed.context.close();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('candidate overview browser: desktop/tablet/phone, both themes, automatic refresh, public previews, registered profiles and immediate sign-out clearing passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
