import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { aggregate } from './build-profile-analytics.mjs';
import { marketYear } from './jobs-model.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = await fs.readFile(path.join(root, '_scraper/_fake-firebase.js'), 'utf8');
const tracker = await fs.readFile(path.join(root, 'assets/oa-listing-tracking.js'), 'utf8');
const year = marketYear(), today = new Date().toISOString().slice(0, 10);
const candidate = { id: 'qa-candidate', name: 'Example Candidate', affiliation: 'Example University', position: 'PhD Candidate', year, posted: today,
  researchAreas: ['Operations Research'], informsDays: ['Monday'], informsUrl: 'https://example.org/talk', cvUrl: 'https://example.org/cv',
  rsUrl: 'https://example.org/research', webUrl: 'https://example.org', email: 'candidate@example.org' };
const job = { id: 'qa-job', institution: 'Example University', department: 'Operations', year, years: [year], posted: today,
  levels: ['Assistant Professor'], reviewDate: '2099-10-01', applyBy: '1 November 2099', applyByDate: '2099-11-01',
  comments: 'This position includes research and teaching in operations management. '.repeat(50), countries: ['United States', 'United Kingdom'],
  adUrl: 'https://example.org/job.pdf', postedAtUrl: 'https://example.org/posting', furtherInfoUrl: 'https://example.org/more', ref: 'OA-JOB-QA' };
const cases = {
  candidate: [['Research area(s)', 'research_areas'], ['Presenting at INFORMS', 'informs_days'], ['INFORMS talk', 'informs_talk'], ['CV', 'cv'], ['Research summary', 'research_summary'], ['Web page', 'website'], ['Contact', 'contact']],
  job: [['Position type', 'position_type'], ['Suggested apply by', 'suggested_deadline'], ['Final apply by', 'final_deadline'], ['Comments on Job Posting', 'job_description'], ['Campus countries', 'campus_countries'], ['File link', 'job_file'], ['Posted online at', 'posting_source'], ['Further info', 'further_info'], ['OA posting ID', 'posting_id']]
};
const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });
let checked = 0;
try {
  for (const type of ['candidate', 'job']) for (const width of [320, 390, 430, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { window.__FAKE_FB = { user: { uid: 'qa-reader', email: 'reader@example.org', emailVerified: true, displayName: 'QA Reader', providerData: [] } }; });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/firebasejs/')) return route.fulfill({ contentType: 'application/javascript', body: fake });
      if (url.hostname !== 'www.operationsacademia.org') return route.abort();
      if (/oa-(ga4|visit|usage|listing-tracking)\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: '' });
      const fixtures = { '/data/candidates.json': [candidate], '/data/candidate-previews.json': [{ id: 'candidate-preview-1', year, affiliation: candidate.affiliation, previewOnly: true }], '/data/candidates-reveal.json': { revealAt: '2020-01-01' }, '/data/jobs.json': [job] };
      if (Object.hasOwn(fixtures, url.pathname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
      let rel = url.pathname.replace(/^\//, ''); if (!path.extname(rel)) rel += '.html';
      try {
        const body = await fs.readFile(path.join(root, rel));
        return route.fulfill({ body, contentType: rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.json') ? 'application/json' : rel.endsWith('.html') ? 'text/html' : 'image/png' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('https://www.operationsacademia.org/' + (type === 'candidate' ? 'candidates' : 'jobs'));
    await page.waitForFunction(() => window.OAAccounts && OAAccounts.resolved());
    const card = page.locator('#job-qa-' + type);
    await card.locator('.oa-card-head[aria-expanded="false"]').waitFor();
    await card.locator('.oa-card-head').click();
    await card.locator('.oa-card-body:not([hidden])').waitFor();
    await page.evaluate(() => {
      window.savedTiming = []; window.timingGa = []; window.timers = {}; window.qaNow = 1000; window.seq = 0;
      Date.now = () => qaNow; document.hasFocus = () => true;
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      window.setInterval = (fn, ms) => { timers[ms] = fn; return ms; };
      window.OAUsageRecord = e => savedTiming.push({ ...e, s: 'layout', n: ++seq });
      window.gtag = (...args) => timingGa.push(args);
    });
    await page.addScriptTag({ content: tracker });
    const targets = [['.oa-card-title', 'title'], ['.oa-card-sub', 'subtitle'], ...cases[type].map(([label, part]) => [card.locator('.oa-kv tr').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }), part])];
    for (const [selector, part] of targets) {
      await page.evaluate(() => { dispatchEvent(new Event('pagehide')); savedTiming = []; timingGa = []; });
      const target = typeof selector === 'string' ? card.locator(selector) : selector;
      await target.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => { dispatchEvent(new Event('pageshow')); for (let i = 0; i < 4; i++) { qaNow += 1000; timers[1000](); } timers[15000](); });
      const events = await page.evaluate(() => savedTiming);
      const report = aggregate([{ uid: 'reader', clicks: events }], { id: 'qa-' + type, type, uid: 'owner' }, 0, 1000000);
      const actual = report.parts.find(p => p.part === part);
      assert.ok(actual, `${type} ${width}px: ${part} is detected in the real renderer`);
      assert.equal(actual.seconds, 4, `${type} ${width}px: ${part} gets exactly four seconds`);
      assert.equal(actual.views, 1); assert.equal(actual.averageSeconds, 4); assert.equal(actual.clicks, 0);
      assert.ok((await page.evaluate(() => timingGa)).some(e => e[1] === 'oa_listing_part_engagement' && e[2].listing_type === type && e[2].listing_part === part && e[2].active_seconds === 4));
      const offscreen = await card.locator('.oa-kv tr').evaluateAll(rows => rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom <= 0 || r.top >= innerHeight; }).map(row => row.querySelector('th').textContent));
      for (const label of offscreen) {
        const key = cases[type].find(([name]) => name === label)?.[1];
        if (key) assert.ok(!report.parts.some(p => p.part === key), `${type} ${width}px: offscreen ${key} has no timing`);
      }
      checked++;
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Real candidate/job layouts: ${checked} detail timing checks passed at 320, 390, 430 and 1440px, including GA and private report attribution.`);
} finally { await browser.close(); }
