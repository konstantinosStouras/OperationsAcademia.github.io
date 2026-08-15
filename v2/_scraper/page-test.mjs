#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — browser checks for the rebuilt job postings page.

   Serves the repository statically and drives /v2/jobs.html in Chromium. This
   is the test that would have caught the two things the vendor swap could
   silently break: the list not rendering at all, and the filters not chaining.

       node v2/_scraper/page-test.mjs

   Needs Playwright. In CI that is installed by .github/workflows/oa-checks.yml.
   Locally, set PW_CHROMIUM to a chromium binary if the default is not found.
   --------------------------------------------------------------------------- */

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      let file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let pass = 0;
const fails = [];
const ok = (c, what) => { if (c) pass++; else fails.push(what); };
const eq = (a, b, what) =>
  ok(JSON.stringify(a) === JSON.stringify(b),
    `${what}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);

const { server, port } = await serve();
const BASE = `http://127.0.0.1:${port}/v2/`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed — skipping the browser checks');
  server.close();
  process.exit(0);
}

const launch = { args: ['--no-sandbox'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
// a proxy in the environment would swallow the loopback request
launch.proxy = { server: 'http://127.0.0.1:1', bypass: '<-loopback>,127.0.0.1,localhost' };

const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));

/* ------------------------------------------------------------- first paint */

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card', { timeout: 15000 });

const total = Number((await page.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim());
ok(total > 0, 'the list renders postings');
eq(await page.$$eval('.oa-card', (n) => n.length), 10, 'a page holds ten postings');

eq(await page.$$eval('.oa-filter > label', (ns) => ns.map((n) => n.textContent)),
  ['University/Institution', 'Deadline', 'Type', 'Entry level', 'Location',
    'Characteristics', 'Date posted'],
  'the filter bar carries the same seven filters the vendor table did');

// the featured posting leads, and carries its badge
eq(await page.$eval('.oa-card:first-child .oa-label', (n) => n.textContent), 'Featured',
  'the featured posting leads and is badged');

/* ------------------------------------------------------------------- a card */

await page.click('.oa-card:first-child .oa-card-head');
await page.waitForTimeout(150);
const labels = await page.$$eval('.oa-card:first-child .oa-kv th', (ns) => ns.map((n) => n.textContent));
ok(labels.includes('Entry level') && labels.includes('Apply by'),
  'an expanded card shows the same rows the vendor card did');
eq(await page.$eval('.oa-card:first-child .oa-card-head', (n) => n.getAttribute('aria-expanded')),
  'true', 'expanding a card is announced to assistive technology');

// every link in a card is a real http(s) link opening safely
const badLinks = await page.$$eval('.oa-kv a', (as) =>
  as.filter((a) => !/^https?:/i.test(a.href) || a.rel.indexOf('noopener') === -1).map((a) => a.href));
eq(badLinks, [], 'card links are http(s) and carry rel=noopener');

/* ----------------------------------------------------------------- filters */

async function countAfter(fn) {
  await fn();
  await page.waitForTimeout(350);
  const t = await page.$eval('.oa-count', (n) => n.textContent);
  return Number(t.split('/')[1].trim().split(' ')[0]);
}

const usa = await countAfter(async () => {
  await page.click('#oaf-country');
  await page.click('.oa-pick-menu .oa-opt:has-text("USA")');
});
ok(usa > 0 && usa < total, `a location filter narrows the list (${usa} of ${total})`);

const both = await countAfter(() => page.fill('#oaf-institution', 'Chicago'));
ok(both > 0 && both <= usa, `a text search chains with it, ANDed (${both})`);

// the option counts are cross-filtered, not raw totals
await page.click('#oaf-type');
await page.waitForTimeout(200);
const typeCounts = await page.$$eval('.oa-pick-menu .oa-opt-n', (ns) => ns.map((n) => +n.textContent));
ok(typeCounts.reduce((a, b) => a + b, 0) <= usa + both,
  'option counts reflect the other active filters');
await page.keyboard.press('Escape');

/* ------------------------------------------------------------- deep links */

const url = page.url();
ok(url.includes('country=USA') && url.includes('institution=Chicago'),
  'filter state is mirrored into the query string');

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
eq(Number((await page.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim().split(' ')[0]),
  both, 'reloading a filtered URL restores the same result set');
eq(await page.$eval('#oaf-institution', (n) => n.value), 'Chicago', 'the text filter is restored');

// the legacy Awesome Table deep link the footer and the "Further info" column
// still emit must keep working
await page.goto(BASE + 'jobs.html?filterA=University%20of%20Mannheim',
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const mannheim = await page.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent));
ok(mannheim.length > 0 && mannheim.every((t) => /Mannheim/.test(t)),
  'the legacy ?filterA= deep link still selects an institution');

/* --------------------------------------------- the site's own script chain

   These pages drop the Awesome Tables tag but must keep everything else the
   site loads. Two things break silently otherwise, on every v2 page:
     - below 840px main.css hides #header-wrapper outright and the navigation
       exists ONLY as the off-canvas panel main.js builds at runtime, so
       without jQuery/skel/util/main.js a phone gets no menu at all;
     - the shared footer partial carries inline onclick="ga(...)" handlers, so
       without ypo-parakolouthisi.js every footer link throws.                */

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');
await page.waitForTimeout(800);

eq(await page.evaluate(() => typeof window.ga), 'function',
  'the global `ga` the footer\'s inline handlers call exists');
eq(await page.evaluate(() => typeof window.jQuery), 'function', 'jQuery is loaded');
ok(await page.$$eval('#nav a', (n) => n.length > 0), 'the navigation menu is populated');
eq(await page.evaluate(() => {
  const a = document.querySelector('#footer a[onclick]');
  if (!a) return 'no-handler';
  try { new Function(a.getAttribute('onclick')).call(a); return 'ok'; }
  catch (e) { return 'threw: ' + e.message; }
}), 'ok', 'a footer link with an inline analytics handler does not throw');

/* -------------------------------------------------------- states + mobile */

await page.goto(BASE + 'jobs.html?institution=zzzznotathing', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-empty', { timeout: 8000 });
ok((await page.$eval('.oa-empty', (n) => n.textContent)).includes('No job postings'),
  'a filter that matches nothing explains itself');

const m = await browser.newPage({ viewport: { width: 390, height: 780 } });
await m.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await m.waitForSelector('.oa-card');
await m.click('.oa-card:first-child .oa-card-head');
await m.waitForTimeout(200);
eq(await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  0, 'no horizontal overflow at 390px with a card open');

await m.waitForTimeout(600);
const mobileNav = await m.evaluate(() => {
  const bar = document.querySelector('#titleBar');
  const panel = document.querySelector('#navPanel');
  return {
    headerHidden: !document.querySelector('#header-wrapper') ||
      getComputedStyle(document.querySelector('#header-wrapper')).display === 'none',
    barShown: !!bar && getComputedStyle(bar).display !== 'none',
    panelLinks: panel ? panel.querySelectorAll('a').length : 0,
  };
});
ok(mobileNav.headerHidden, 'below 840px the desktop header is hidden, as main.css intends');
ok(mobileNav.barShown, 'the mobile title bar is built');
ok(mobileNav.panelLinks > 0,
  `the off-canvas menu has links (${mobileNav.panelLinks}) — without the site's ` +
  'script chain a phone would have no navigation at all');

/* ------------------------------- when Firebase cannot be reached at all

   Offline, a blocked CDN, or an ad blocker that eats gstatic. The pages must
   fall into an explained state — never a blank card, and never a control that
   looks usable and then fails after someone has typed out a whole form.

   This regressed once: oa-accounts.js resolved its auth state on SDK failure
   but did not notify its listeners, so post-a-job.html showed neither its form
   nor its sign-in prompt.                                                    */

for (const [name, expect] of [
  ['post-a-job.html', { prompt: '#oa-needauth', form: '#oa-job-form' }],
  ['alerts.html', { prompt: '#oa-needauth', form: '#oa-alerts-app' }],
]) {
  const q = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const qErrors = [];
  q.on('pageerror', (e) => qErrors.push(e.message));
  await q.route('**/firebasejs/**', (r) => r.abort());
  await q.goto(BASE + name, { waitUntil: 'domcontentloaded' });
  await q.waitForTimeout(2500);

  const seen = await q.evaluate((sel) => {
    const vis = (s) => {
      const e = document.querySelector(s);
      return !!e && getComputedStyle(e).display !== 'none';
    };
    return {
      prompt: vis(sel.prompt),
      form: vis(sel.form),
      header: (document.querySelector('#oa-account') || {}).textContent || '',
    };
  }, expect);

  ok(seen.prompt, `${name}: an unreachable SDK still shows the sign-in prompt`);
  ok(!seen.form, `${name}: the form stays hidden when nobody can sign in`);
  ok(/unavailable/i.test(seen.header),
    `${name}: the header says sign-in is unavailable rather than inviting a click`);
  eq(qErrors, [], `${name}: no uncaught error when the SDK is unreachable`);
  await q.close();
}

// feedback needs no account, so its form is shown — but it must be stood down
// rather than failing on the button after the report is typed
{
  const q = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await q.route('**/firebasejs/**', (r) => r.abort());
  await q.goto(BASE + 'feedback.html', { waitUntil: 'domcontentloaded' });
  await q.waitForTimeout(2500);
  const seen = await q.evaluate(() => ({
    disabled: document.getElementById('fb-submit').disabled,
    explained: getComputedStyle(document.getElementById('oa-offline')).display !== 'none',
    inboxHidden: getComputedStyle(document.getElementById('oa-inbox')).display === 'none',
  }));
  ok(seen.disabled, 'feedback: the form is disabled when it could not be sent');
  ok(seen.explained, 'feedback: and says why, with somewhere else to write to');
  ok(seen.inboxHidden, 'feedback: the maintainer inbox stays hidden');
  await q.close();
}

/* ------------------------------------------------------------------ done */

eq(jsErrors, [], 'no uncaught script errors');

await browser.close();
server.close();

if (fails.length) {
  console.log(`\n${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
console.log(`page-test: ${pass} checks passed`);
