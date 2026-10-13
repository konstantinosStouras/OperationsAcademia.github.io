import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<div id="oa-candidates"><ul><li id="job-test" class="oa-card"><button class="oa-card-head" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\',this.getAttribute(\'aria-expanded\')===\'true\'?\'false\':\'true\')">Candidate</button><a href="https://example.org/cv?token=secret">CV</a></li></ul></div><input id="password" value="never-record-this" type="password"><button id="bulk">Bulk click</button>' }));
  await page.goto('https://www.operationsacademia.org/candidates');
  await page.evaluate(() => {
    window.saved = {}; window.ga = []; window.intervals = {}; window.clockNow = Date.UTC(2026, 9, 11); window.focused = true; window.visible = 'visible';
    Date.now = () => window.clockNow;
    window.setInterval = (fn, ms) => { window.intervals[ms] = fn; return ms; };
    Object.defineProperty(document, 'visibilityState', { get: () => window.visible });
    document.hasFocus = () => window.focused;
    window.gtag = (...args) => window.ga.push(args);
    window.OAFB = { enabled: true, ready: async () => ({ auth: () => ({ onAuthStateChanged: fn => fn({ uid: 'reader', email: 'reader@example.test' }) }), firestore: () => ({ collection: col => ({ doc: id => ({ set: async data => { window.saved[col + '/' + id] = structuredClone(data); } }) }) }) }) };
  });
  await page.addScriptTag({ content: await fs.readFile(new URL('../assets/oa-usage.js', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: await fs.readFile(new URL('../assets/oa-listing-tracking.js', import.meta.url), 'utf8') });
  await page.locator('.oa-card-head').click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => { intervals[1000](); clockNow += 1000; intervals[1000](); intervals[15000](); intervals[5000](); });
  async function records() {
    await page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); intervals[5000](); for (let i = 0; i < 20; i++) await Promise.resolve(); });
    return page.evaluate(() => Object.entries(saved).filter(([k]) => k.startsWith('usageEventBatches/')).flatMap(([, v]) => v.clicks));
  }
  let data = await records();
  assert.equal(data.filter(e => e.k === 'view').length, 1);
  assert.equal(data.filter(e => e.k === 'engagement').reduce((n, e) => n + e.d, 0), 1);
  await page.evaluate(() => { focused = false; clockNow += 1000; intervals[1000](); clockNow += 20000; intervals[1000](); intervals[15000](); });
  data = await records(); assert.equal(data.filter(e => e.k === 'engagement').reduce((n, e) => n + e.d, 0), 1, 'unfocused time is excluded');
  await page.evaluate(() => { focused = true; visible = 'hidden'; clockNow += 1000; intervals[1000](); });
  data = await records(); assert.equal(data.filter(e => e.k === 'view').length, 1, 'hidden tab cannot add views');
  await page.evaluate(() => { visible = 'visible'; clockNow += 61000; intervals[1000](); });
  data = await records(); assert.equal(data.filter(e => e.k === 'view').length, 1, 'idle tab cannot add views');
  await page.locator('#password').click();
  await page.evaluate(() => { document.querySelector('a').addEventListener('click', e => e.preventDefault()); document.querySelector('a').click(); for (let i = 0; i < 450; i++) document.querySelector('#bulk').click(); });
  data = await records();
  assert.equal(data.filter(e => e.x === 'Bulk click').length, 450, 'long sessions retain clicks beyond the old 400-event cap');
  assert.ok(!JSON.stringify(data).includes('never-record-this'));
  assert.ok(!JSON.stringify(data).includes('token=secret'));
  const ga = await page.evaluate(() => window.ga);
  assert.ok(ga.some(e => e[1] === 'oa_listing_view' && e[2].page_location.endsWith('/candidates?oa_listing=test')));
  assert.ok(!JSON.stringify(ga).includes('reader@example.test'));
  // Detail text, middle-clicks, dynamic cards and site-wide controls all have
  // semantic records in both destinations without exporting their contents.
  await page.evaluate(() => {
    document.querySelector('li.oa-card').insertAdjacentHTML('beforeend', '<div class="oa-card-body"><table class="oa-kv"><tr><th>CV</th><td><a id="cv" href="https://example.org/cv?token=secret">private@example.test</a></td></tr><tr><th>Research area(s)</th><td id="research">Sensitive draft research</td></tr></table></div>');
    document.body.insertAdjacentHTML('beforeend', '<div id="oa-jobs"><ul><li id="job-role" class="oa-card"><button class="oa-card-head" aria-expanded="true">Job</button><div class="oa-card-body"><table class="oa-kv"><tr><th>Further info</th><td><a id="job-link" href="https://example.org/apply?token=secret">Apply</a></td></tr></table></div></li><li id="job-locked" class="oa-card oa-card-gated"><button class="oa-card-head" aria-expanded="false">Locked</button></li></ul></div>');
    document.addEventListener('click', e => e.preventDefault());
    document.addEventListener('auxclick', e => e.preventDefault());
    document.querySelector('#cv').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    document.querySelector('#research').click();
    document.querySelector('#job-link').click();
    document.querySelector('#job-locked button').click();
  });
  data = await records();
  const detailedGa = await page.evaluate(() => window.ga.filter(e => e[1] === 'oa_site_click'));
  assert.ok(data.some(e => e.k === 'interaction' && e.c === 'job-test' && e.p === 'cv' && e.b === 1));
  assert.ok(data.some(e => e.k === 'interaction' && e.p === 'research_areas' && e.a === 'content'));
  assert.ok(detailedGa.some(e => e[2].listing_id === 'role' && e[2].listing_type === 'job' && e[2].listing_part === 'further_info'));
  assert.ok(detailedGa.some(e => e[2].interaction_action === 'locked' && e[2].listing_id === ''));
  assert.equal(detailedGa.filter(e => e[2].listing_type === 'none' && e[2].element_type === 'button' && e[2].interaction_action === 'control').length, 450);
  assert.ok(!JSON.stringify(detailedGa).match(/private@example|Sensitive draft|token=secret|never-record-this/));
  assert.ok(data.every(e => e.v === 2 && typeof e.s === 'string' && Number.isInteger(e.n)));
  assert.equal(new Set(data.map(e => e.s + ':' + e.n)).size, data.length, 'batched events retain unique ordered identities');
  await page.evaluate(() => {
    document.querySelector('#oa-jobs').id = 'oa-past';
    document.querySelector('#job-link').click();
  });
  assert.ok((await records()).some(e => e.k === 'interaction' && e.c === 'job-role' && e.m === 'oa-past'));

  // pagehide must save the segment produced AFTER oa-usage's own handler,
  // even with an earlier batch in flight and fewer than 100 events queued.
  await page.evaluate(() => {
    focused = true; visible = 'visible';
    document.dispatchEvent(new Event('pointerdown'));
    intervals[1000](); clockNow += 1000; intervals[1000]();
  });
  const beforeExit = (await records()).filter(e => e.k === 'engagement').reduce((n, e) => n + e.d, 0);
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('pagehide'));
    for (let i = 0; i < 100; i++) await Promise.resolve();
  });
  const exitData = await page.evaluate(() => Object.entries(saved).filter(([k]) => k.startsWith('usageEventBatches/')).flatMap(([, v]) => v.clicks));
  assert.ok(exitData.filter(e => e.k === 'engagement').reduce((n, e) => n + e.d, 0) > beforeExit, 'final listing time is flushed without another timer');
  assert.ok(exitData.some(e => e.k === 'page_engagement' && e.d > 0));
  assert.equal(exitData.filter(e => e.k === 'page_engagement').reduce((n, e) => n + e.d, 0), 2, 'page time excludes the hidden/idle gap and the instant of returning');
  const countAtExit = exitData.length;
  await page.evaluate(async () => { window.dispatchEvent(new Event('pagehide')); for (let i = 0; i < 100; i++) await Promise.resolve(); });
  assert.equal((await records()).length, countAtExit, 'repeated lifecycle flushes do not duplicate time');
  assert.deepEqual(errors, []);
  await page.close();
  // Browser privacy opt-out prevents both trackers, including GA events.
  const privatePage = await browser.newPage(); await privatePage.route('**/*', r => r.fulfill({ body: '<p>Private</p>' }));
  await privatePage.goto('https://www.operationsacademia.org/jobs');
  await privatePage.evaluate(() => { Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }); window.OAFB = { enabled: true, ready: () => { throw new Error('must not contact Firebase'); } }; });
  await privatePage.addScriptTag({ content: await fs.readFile(new URL('../assets/oa-usage.js', import.meta.url), 'utf8') });
  await privatePage.addScriptTag({ content: await fs.readFile(new URL('../assets/oa-listing-tracking.js', import.meta.url), 'utf8') });
  assert.equal(await privatePage.evaluate(() => typeof window.OAUsageRecord), 'undefined');
  assert.equal(await privatePage.evaluate(() => typeof window.OAInteractionDetails), 'undefined');
  await privatePage.close();
  // GA events remain available when Firebase is unavailable.
  const gaOnly = await browser.newPage();
  await gaOnly.route('**/*', r => r.fulfill({ body: '<button>Menu</button>' }));
  await gaOnly.goto('https://www.operationsacademia.org/jobs');
  await gaOnly.evaluate(() => { window.ga = []; window.gtag = (...args) => ga.push(args); });
  await gaOnly.addScriptTag({ content: await fs.readFile(new URL('../assets/oa-listing-tracking.js', import.meta.url), 'utf8') });
  await gaOnly.locator('button').click();
  assert.equal(await gaOnly.evaluate(() => ga.filter(e => e[1] === 'oa_site_click').length), 1);
  await gaOnly.close();
  console.log('Listing tracking: focused/hidden/idle time, append-only batches, 450 rapid clicks, URL/field redaction and privacy opt-out passed.');
} finally { await browser.close(); }
