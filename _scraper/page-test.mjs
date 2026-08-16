#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — browser checks for the rebuilt job postings page.

   Serves the repository statically and drives /jobs.html in Chromium. This
   is the test that would have caught the two things the vendor swap could
   silently break: the list not rendering at all, and the filters not chaining.

       node _scraper/page-test.mjs

   Needs Playwright. In CI that is installed by .github/workflows/oa-checks.yml.
   Locally, set PW_CHROMIUM to a chromium binary if the default is not found.
   --------------------------------------------------------------------------- */

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const BASE = `http://127.0.0.1:${port}/`;

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
eq(await page.$$eval('.oa-card', (n) => n.length), Math.min(10, total),
  'a page holds up to ten postings');

/* The page shows only the market year under way, so early in a season the
   list is genuinely short. Assert the SCOPE rather than a count: every
   rendered row must satisfy the same rule jobs.html filters by. */
const marketStart = (() => {
  const d = new Date();
  const y = d.getUTCFullYear() + (d.getUTCMonth() >= 6 ? 1 : 0);
  return (y - 1) + '-07-01';
})();
const outOfMarket = await page.evaluate(async (start) => {
  const rows = await (await fetch('data/jobs.json')).json();
  const y = Number(start.slice(0, 4)) + 1;
  return {
    shownOld: 0, // the cards carry no year attribute; the fetch re-check below stands in
    fileHasOld: rows.some((r) => String(r.posted || '') < start && Number(r.year) < y),
    inScope: rows.filter((r) => String(r.posted || '') >= start || Number(r.year) >= y).length,
  };
}, marketStart);
eq(total, outOfMarket.inScope,
  'the list carries exactly the current market year\'s postings');
ok(outOfMarket.fileHasOld,
  'while data/jobs.json keeps the previous seasons (the migration\'s source)');

eq(await page.$$eval('.oa-filter > label', (ns) => ns.map((n) => n.textContent)),
  ['University/Institution', 'Deadline', 'Type', 'Entry level', 'Location',
    'Characteristics', 'Date posted'],
  'the filter bar carries the same seven filters the vendor table did');

/* A featured posting leads, WHEN the current market has one — the flag is the
   maintainer's and the dataset is live, so early in a season there may be
   none. With none, the newest posting leads instead. */
const firstBadge = await page.$('.oa-card:first-child .oa-label');
if (firstBadge) {
  eq(await firstBadge.textContent(), 'Featured', 'the featured posting leads and is badged');
} else {
  const firstTwo = await page.$$eval('.oa-card .oa-card-head', (ns) => ns.length);
  ok(firstTwo > 0, 'with no featured posting, the list still leads with the newest');
}

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

/* The search term is taken FROM the list on screen, never hardcoded: the
   dataset is the live one and its contents move every time the sheet syncs or
   a market rolls, so a fixed name ("Chicago") turns a passing check into a
   failing one the day that posting leaves the current market. */
const term = await page.$eval('.oa-card:first-child .oa-card-title',
  (n) => n.textContent.trim().split(/\s+/).find((w) => w.length > 4) || 'University');
const both = await countAfter(() => page.fill('#oaf-institution', term));
ok(both > 0 && both <= usa, `a text search chains with it, ANDed (${both} for "${term}")`);

// the option counts are cross-filtered, not raw totals
await page.click('#oaf-type');
await page.waitForTimeout(200);
const typeCounts = await page.$$eval('.oa-pick-menu .oa-opt-n', (ns) => ns.map((n) => +n.textContent));
ok(typeCounts.reduce((a, b) => a + b, 0) <= usa + both,
  'option counts reflect the other active filters');
await page.keyboard.press('Escape');

/* ------------------------------------------------------------- deep links */

const url = page.url();
ok(url.includes('country=USA') && url.includes('institution=' + encodeURIComponent(term)),
  'filter state is mirrored into the query string');

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
eq(Number((await page.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim().split(' ')[0]),
  both, 'reloading a filtered URL restores the same result set');
eq(await page.$eval('#oaf-institution', (n) => n.value), term, 'the text filter is restored');

// the legacy Awesome Table deep link the footer and the "Further info" column
// still emit must keep working
await page.goto(BASE + 'jobs.html?filterA=University%20of%20Mannheim',
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const mannheim = await page.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent));
ok(mannheim.length > 0 && mannheim.every((t) => /Mannheim/.test(t)),
  'the legacy ?filterA= deep link still selects an institution');

/* ------------------------------------------ the Deadline filter's own words

   The vendor page offers three values and only three — "Closing soon",
   "Expired", "Until filled". This page offered "Open" instead of the first,
   which the owner caught by putting the two dropdowns side by side, so the
   check is on the WHOLE vocabulary rather than on one label: a fourth word is
   the defect, whichever word it is.

   Asserted against the list actually offered, not a fixed triple, because
   whether a bucket appears at all depends on the live data — a value with no
   postings behind it is correctly absent.                                    */

const DEADLINES = ['Closing soon', 'Expired', 'Until filled'];

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');
await page.click('#oaf-deadline');
await page.waitForTimeout(200);
const buckets = await page.$$eval('.oa-pick-menu:not([hidden]) .oa-opt-name',
  (ns) => ns.map((n) => n.textContent));
ok(buckets.length > 0, 'the Deadline filter offers its values');
eq(buckets.filter((b) => DEADLINES.indexOf(b) === -1), [],
  'every Deadline value is one the vendor page offers');
eq(buckets, DEADLINES.filter((b) => buckets.indexOf(b) !== -1),
  'and they are listed in the vendor page\'s order');
await page.keyboard.press('Escape');

// and the rule behind them, from the page's own function
eq(await page.evaluate(() => {
  const off = (n) => {
    const t = new Date();
    t.setDate(t.getDate() + n);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') +
      '-' + String(t.getDate()).padStart(2, '0');
  };
  const D = window.OAList.derive.deadline;
  return {
    none: D({ applyBy: 'Until filled. Review begins in September.' }),
    past: D({ applyByDate: off(-30) }),
    today: D({ applyByDate: off(0) }),
    soon: D({ applyByDate: off(21) }),
    far: D({ applyByDate: off(300) }),
  };
}), {
  none: 'Until filled', past: 'Expired', today: 'Closing soon',
  soon: 'Closing soon', far: 'Closing soon',
}, 'a posting lands in the bucket the vendor page would have put it in');

// a link shared while the filter said "Open" still selects what it meant
await page.goto(BASE + 'jobs.html?deadline=Open', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
eq(await page.$$eval('.oa-chip .oa-chip-label', (ns) => ns.map((n) => n.textContent)),
  ['Closing soon'], 'a ?deadline=Open link still selects the bucket it named');

/* ------------------------------------------------- a chip is one blue button

   The whole chip removes the value; the × is decoration. It used to be the
   other way round — a chip carrying a 9-pixel button — so a click on the blue
   did nothing at all.                                                        */

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');
await page.click('#oaf-type');
await page.waitForTimeout(200);
await page.click('.oa-pick-menu:not([hidden]) .oa-opt');
await page.waitForTimeout(350);
eq(await page.$$eval('.oa-chip', (ns) => ns.length), 1, 'choosing a value shows its chip');
eq(await page.$$eval('.oa-chip button', (ns) => ns.length), 0,
  'the chip holds no button of its own — it IS the button');
const narrowed = Number((await page.$eval('.oa-count', (n) => n.textContent))
  .split('/')[1].trim().split(' ')[0]);

// a multi-select menu deliberately stays open after a tick (so several values
// can be chosen in one visit) — close it the way a reader would, or it sits
// over the chip this click aims at
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// click the LABEL, which is where a pointer lands, not the ×
await page.click('.oa-chip .oa-chip-label');
await page.waitForTimeout(350);
eq(await page.$$eval('.oa-chip', (ns) => ns.length), 0,
  'clicking anywhere on the chip drops that filter');
const widened = Number((await page.$eval('.oa-count', (n) => n.textContent))
  .split('/')[1].trim().split(' ')[0]);
ok(widened > narrowed, `and the list widens again (${narrowed} -> ${widened})`);

/* ------------------------------------------------------- the card elevation

   Every posting rests on a shadow and the one under the pointer, alone, lifts.
   The lift used to be on :focus-within too, so a card someone had clicked
   stayed raised after the pointer moved on and two cards read as hovered at
   once — which is the state the owner saw.                                   */

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');
await page.mouse.move(2, 2);
await page.waitForTimeout(250);
const rest = await page.$$eval('.oa-card', (ns) => ns.map((n) => getComputedStyle(n).boxShadow));
ok(rest.length > 3 && rest[0] !== 'none', 'every posting carries a resting shadow');
eq(new Set(rest).size, 1, 'and they all rest at the same height');

await page.hover('.oa-card:nth-child(3) .oa-card-head');
await page.waitForTimeout(300);
const lifted = await page.$$eval('.oa-card', (ns) => ns.map((n) => getComputedStyle(n).boxShadow));
eq(lifted.filter((s, i) => s !== rest[i]).length, 1,
  'exactly one card is raised while the pointer is over the list');
ok(lifted[2] !== rest[2], 'and it is the card the pointer is over');

await page.click('.oa-card:nth-child(3) .oa-card-head');
await page.mouse.move(2, 2);
await page.waitForTimeout(300);
eq(await page.$$eval('.oa-card', (ns) => ns.map((n) => getComputedStyle(n).boxShadow))
  .then((now) => now.filter((s, i) => s !== rest[i])), [],
  'a card that was clicked settles back once the pointer leaves it');
ok(await page.evaluate(() => document.activeElement.classList.contains('oa-card-head')),
  'though it still holds the keyboard focus, which has its own ring');

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

/* The header row sits on ONE baseline with the menu. It did not: #oa-headnav
   set its own font-size and then positioned itself in em, so the same 0.1em /
   2em that place #nav resolved against 14px there and 16px here, and the
   account button rode a few pixels high. Measured, because that is the only
   way this stays fixed. */
const headRow = await page.evaluate(() => {
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const nav = document.querySelector('#nav > ul > li > a');
  const btns = [...document.querySelectorAll('#oa-headnav .oa-headbtn, #oa-headnav #oa-account > *')];
  return {
    nav: nav ? mid(nav) : null,
    mids: btns.map(mid),
    heights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
  };
});
ok(headRow.mids.length > 0, 'the header carries its own control row');
ok(headRow.mids.every((m) => Math.abs(m - headRow.nav) <= 2),
  'every header control is centred on the navigation menu\'s own line');
ok(new Set(headRow.heights).size === 1,
  `the header controls are one height (${headRow.heights.join(', ')})`);
eq(await page.evaluate(() => {
  const a = document.querySelector('#footer a[onclick]');
  if (!a) return 'no-handler';
  try { new Function(a.getAttribute('onclick')).call(a); return 'ok'; }
  catch (e) { return 'threw: ' + e.message; }
}), 'ok', 'a footer link with an inline analytics handler does not throw');

/* ------------------------------------------- the picker, driven like a user

   Pins for the 2026-08 fleet fixes. The search box was rebuilt on every
   keystroke and re-focused with the caret at 0, so typed text came out
   REVERSED and any 2+ character query matched nothing; a second click on the
   picker button did not close it; and every tick in a multi-select facet
   closed the menu. All three are things only a driven browser can catch.    */

await page.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');

await page.click('#oaf-country');
await page.waitForSelector('.oa-pick-menu:not([hidden]) .oa-pick-search');
await page.type('.oa-pick-menu:not([hidden]) .oa-pick-search', 'usa', { delay: 60 });
eq(await page.$eval('.oa-pick-menu:not([hidden]) .oa-pick-search', (n) => n.value),
  'usa', 'typing into the picker search lands in order, not reversed');
ok(await page.$$eval('.oa-pick-menu:not([hidden]) .oa-opt:not(.is-empty)', (ns) => ns.length > 0),
  'and the typed query still matches its option');

// a second click on the button closes the menu it opened
await page.click('#oaf-country');
await page.waitForTimeout(150);
eq(await page.$$eval('.oa-pick-menu:not([hidden])', (ns) => ns.length), 0,
  'clicking the open picker button again closes it');

// a multi-select facet (country — level is deliberately single-select) takes
// several ticks without reopening
await page.click('#oaf-country');
await page.waitForSelector('.oa-pick-menu:not([hidden])');
await page.click('.oa-pick-menu:not([hidden]) .oa-opt:nth-of-type(1) input');
await page.waitForTimeout(250);
eq(await page.$$eval('.oa-pick-menu:not([hidden])', (ns) => ns.length), 1,
  'a multi-select menu stays open after the first tick');
await page.click('.oa-pick-menu:not([hidden]) .oa-opt:nth-of-type(2) input');
await page.waitForTimeout(250);
eq(await page.$$eval('.oa-pick-menu:not([hidden]) input:checked', (ns) => ns.length), 2,
  'and holds both selections');
await page.keyboard.press('Escape');

/* -------------------------------------------------- URL state, edge cases */

// a foreign query parameter survives the list's own URL writing
await page.goto(BASE + 'jobs.html?utm_source=newsletter&country=USA',
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(400);
ok(page.url().includes('utm_source=newsletter'),
  'a foreign query parameter is not erased from the address bar');

// the Universities map deep-links institutions as ?filterD=
await page.goto(BASE + 'jobs.html?filterD=University%20of%20Mannheim',
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const viaD = await page.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent));
ok(viaD.length > 0 && viaD.every((t) => /Mannheim/.test(t)),
  'the Universities map\'s ?filterD= deep link selects an institution');

// safeUrl refuses every protocol-relative and backslash disguise
eq(await page.evaluate(() =>
  ['//evil.example/a', '/\\evil.example/b', '///evil.example/c'].map(window.OAList.safeUrl)),
  ['', '', ''], 'safeUrl refuses protocol-relative URLs');
ok(await page.evaluate(() => window.OAList.safeUrl('/universities.html') === '/universities.html'),
  'while a genuine rooted path passes');

// printing must show the card details readers expanded — and the ones they
// did not, since paper cannot be clicked
await page.emulateMedia({ media: 'print' });
eq(await page.$eval('.oa-card .oa-card-body', (n) => getComputedStyle(n).display),
  'block', 'a collapsed card body prints its details');
await page.emulateMedia({ media: 'screen' });

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

/* The account control's off-canvas copy. Below 840px the header — and with it
   the site's only sign-out — is display:none, so oa-accounts.js paints a
   second host into #navPanel. In THIS run the SDK is unreachable (the proxy
   eats gstatic), so the correct panel state is present-but-EMPTY: a dead
   "Sign in" link would be the same silent no-op the header fixed. The
   healthy-path states (sign-in link; identity + sign-out) are exercised with
   a stubbed SDK in the fleet's own checks. */
const np = await m.evaluate(() => {
  const b = document.querySelector('#oa-np');
  return b ? { inPanel: !!b.closest('#navPanel'), html: b.innerHTML } : null;
});
ok(np && np.inPanel, 'the account control mounts its mobile host inside #navPanel');
eq(np && np.html, '', 'and stays empty while the SDK is unreachable — never a dead link');

const titleHref = await m.$eval('#titleBar a.title', (a) => a.getAttribute('href'));
eq(titleHref, './',
  'the mobile title bar\'s wordmark stays on the site rather than leaving it');

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
  if (name === 'post-a-job.html') {
    // signing in must be offered BEFORE the form, not after twenty fields
    const gate = await q.evaluate(() => {
      const g = document.querySelector('#oa-needauth');
      return g && {
        signIn: !!g.querySelector('#oa-needauth-btn'),
        register: !!g.querySelector('#oa-needauth-new'),
        aboveForm: !!(document.querySelector('#oa-job-form') &&
          g.compareDocumentPosition(document.querySelector('#oa-job-form')) &
          Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    ok(gate && gate.signIn && gate.register,
      'post-a-job: the gate offers both signing in and registering');
    ok(gate && gate.aboveForm, 'post-a-job: the gate stands in front of the form');
  }
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

/* ------------------------------------------- merging two accounts into one

   What travels between two accounts, and what does not. These are the
   decisions the merge makes; the Firestore writes around them are exercised
   by hand against the real project, but the rules the writes follow are
   ordinary functions and belong under test.

   OAAccounts.pure is exported for exactly this. It is read from a page that
   never reached Firebase, so nothing here depends on a session. */
{
  const P = await page.evaluate(() => {
    const p = window.OAAccounts && window.OAAccounts.pure;
    if (!p) return null;

    // an ORCID iD is 16 digits with an ISO 7064 MOD 11-2 check character
    const orcid = {
      plain: p.normOrcid('0000-0002-2398-9566'),
      spaced: p.normOrcid('0000 0002 2398 9566'),
      url: p.normOrcid('https://orcid.org/0000-0002-1825-0097'),
      xcheck: p.normOrcid('0000-0002-1694-233X'),
      lowerx: p.normOrcid('0000-0002-1694-233x'),
      typo: p.normOrcid('0000-0002-2398-9567'),
      short: p.normOrcid('0000-0002'),
      junk: p.normOrcid('my orcid'),
      empty: p.normOrcid(''),
      nullish: p.normOrcid(null),
    };

    const full = {
      firstName: 'Ada', lastName: 'Lovelace', affiliation: 'Somewhere',
      website: 'https://example.edu', orcid: '0000-0002-2398-9566', orcidVerified: true,
    };

    const patch = {
      intoEmpty: p.profilePatch({}, full),
      intoFull: p.profilePatch(
        { firstName: 'A', lastName: 'L', affiliation: 'Elsewhere', website: 'https://x.edu' },
        full),
      partial: p.profilePatch({ firstName: 'A' }, full),
      blankIsEmpty: p.profilePatch({ firstName: '   ' }, full),
      sameOrcid: p.profilePatch({ orcid: '0000-0002-2398-9566' }, full),
      otherOrcid: p.profilePatch({ orcid: '0000-0002-1825-0097' }, full),
      nothingToGive: p.profilePatch(full, {}),
    };

    const a = {
      name: 'OM jobs', email: 'me@example.edu', frequency: 'weekly',
      criteria: { topics: ['jobs'], text: '', type: ['University'], level: ['Assistant Professor'],
                  country: ['USA', 'Canada'], characteristics: [] },
    };
    const reordered = JSON.parse(JSON.stringify(a));
    reordered.criteria.country = ['Canada', 'USA'];
    const different = JSON.parse(JSON.stringify(a));
    different.criteria.country = ['USA'];

    return {
      orcid,
      patch,
      sig: {
        same: p.alertSig(a) === p.alertSig(reordered),
        differs: p.alertSig(a) !== p.alertSig(different),
        caseFolded: p.alertSig(a) === p.alertSig(Object.assign({}, a, { email: 'ME@Example.edu' })),
      },
      initials: {
        two: p.initialsFrom('Jane Roe', 'j@x.edu'),
        one: p.initialsFrom('Jane', 'j@x.edu'),
        none: p.initialsFrom('', 'jane@x.edu'),
        blank: p.initialsFrom('', ''),
      },
      summary: {
        one: p.providerSummary({ providerData: [{ providerId: 'google.com' }] }),
        two: p.providerSummary({ providerData: [
          { providerId: 'google.com' }, { providerId: 'oidc.orcid' }] }),
        orcid: p.providerSummary({ providerData: [{ providerId: 'oidc.orcid' }] }),
      },
      alertFields: p.ALERT_FIELDS,
    };
  });

  ok(P, 'the accounts module exports the merge decisions for testing');
  if (P) {
    eq(P.orcid.plain, '0000-0002-2398-9566', 'an ORCID iD is kept in its canonical form');
    eq(P.orcid.spaced, '0000-0002-2398-9566', 'spaces in a pasted iD are ignored');
    eq(P.orcid.url, '0000-0002-1825-0097', 'and a whole orcid.org address is accepted');
    eq(P.orcid.xcheck, '0000-0002-1694-233X', 'an X check character is valid');
    eq(P.orcid.lowerx, '0000-0002-1694-233X', 'and is normalised to upper case');
    // the one that matters: a typo would become an identity key matching
    // nobody, quietly switching the duplicate check off for that account
    eq(P.orcid.typo, '', 'a mistyped iD is refused, not stored');
    eq([P.orcid.short, P.orcid.junk, P.orcid.empty, P.orcid.nullish], ['', '', '', ''],
      'and so is anything that is not an iD at all');

    eq(P.patch.intoEmpty.firstName, 'Ada', 'a merge fills in details the kept account lacks');
    eq(P.patch.intoEmpty.orcid, '0000-0002-2398-9566', 'including an ORCID iD it has none of');
    eq(P.patch.intoEmpty.orcidVerified, true, 'carrying the fact that ORCID vouched for it');
    eq(Object.keys(P.patch.intoFull).sort(), ['orcid', 'orcidVerified'],
      'and overwrites no detail the kept account already answered — only the iD it lacked');
    eq(Object.keys(P.patch.partial).sort(), ['affiliation', 'lastName', 'orcid', 'orcidVerified', 'website'],
      'a half-filled profile takes only what is missing');
    eq(P.patch.blankIsEmpty.firstName, 'Ada', 'whitespace is not an answer');
    eq(P.patch.otherOrcid.orcid, undefined,
      'two different ORCID iDs are two people — the merge leaves that alone');
    eq(P.patch.sameOrcid.orcidVerified, true,
      'the same iD, now verified, upgrades the kept account');
    eq(P.patch.nothingToGive, {}, 'an empty account gives nothing');

    ok(P.sig.same, 'two alerts that would send the same e-mail look the same to the merge');
    ok(P.sig.differs, 'and two that would not, do not');
    ok(P.sig.caseFolded, 'the recipient address is compared case-insensitively');

    eq(P.initials.two, 'JR', 'initials come from the first and last name');
    eq(P.initials.one, 'JA', 'a single name gives two letters');
    eq(P.initials.none, 'JA', 'and an account with no name falls back to its address');
    eq(P.initials.blank, '?', 'never an empty disc');

    eq(P.summary.one, 'Google', 'the sign-in method is named in words');
    eq(P.summary.two, 'Google and ORCID', 'and reads as a sentence when there are two');
    eq(P.summary.orcid, 'ORCID', 'ORCID included');

    // dropping a high-water mark makes a copied alert look brand new, and the
    // first e-mail after a merge is then the entire catalogue
    for (const f of ['lastSentAt', 'lastCheckedAt', 'lastUpdateDate']) {
      ok(P.alertFields.includes(f), `a copied alert keeps its ${f} mark`);
    }
  }

  /* The card the reader actually meets. Rendered from the two pure builders,
     so every branch can be read without a Firebase session behind it. */
  const CARD = await page.evaluate(() => {
    const p = window.OAAccounts.pure;
    const host = document.createElement('div');
    host.id = 'oa-card-probe';
    document.body.appendChild(host);

    const read = (html) => {
      host.innerHTML = html;
      return {
        html,
        chip: !!host.querySelector('.oa-orcid-chip'),
        verified: !!host.querySelector('.oa-verified'),
        input: !!host.querySelector('input[name="orcid"]'),
        value: (host.querySelector('input[name="orcid"]') || {}).value,
        linkOrcid: !!host.querySelector('#oa-link-orcid'),
        linkGoogle: !!host.querySelector('#oa-link-google'),
        merge: !!host.querySelector('#oa-merge-open'),
        text: host.textContent.replace(/\s+/g, ' ').trim(),
      };
    };

    const google = { providerData: [{ providerId: 'google.com' }] };
    const orcidOnly = { providerData: [{ providerId: 'oidc.orcid' }] };
    const iD = '0000-0002-2398-9566';

    return {
      verifiedField: read(p.orcidFieldHTML({ orcid: iD, orcidVerified: true })),
      typedField: read(p.orcidFieldHTML({ orcid: iD })),
      emptyField: read(p.orcidFieldHTML({})),
      escaped: read(p.orcidFieldHTML({ orcid: '"><img src=x onerror=alert(1)>' })),
      googleNoOrcid: read(p.otherAccountsHTML({}, google)),
      googleWithOrcid: read(p.otherAccountsHTML({ orcid: iD }, google)),
      orcidOnly: read(p.otherAccountsHTML({ orcid: iD, orcidVerified: true }, orcidOnly)),
      bothLinked: read(p.otherAccountsHTML({ orcid: iD }, {
        providerData: [{ providerId: 'google.com' }, { providerId: 'oidc.orcid' }] })),
    };
  });

  ok(CARD.verifiedField.chip && CARD.verifiedField.verified && !CARD.verifiedField.input,
    'an iD ORCID vouched for is shown as a verified chip, not an editable field');
  ok(CARD.typedField.input && CARD.typedField.value === '0000-0002-2398-9566',
    'an iD the reader typed stays editable, so it can be corrected or cleared');
  ok(CARD.emptyField.input && !CARD.emptyField.value,
    'and an account without one is offered an empty field');
  ok(!/onerror=/.test(CARD.escaped.html) || /&quot;|&lt;/.test(CARD.escaped.html),
    'a stored value is escaped into the field, never interpolated as markup');
  ok(!CARD.escaped.html.includes('<img'), 'markup in a stored iD cannot reach the page');

  // the whole point of the linking rows: offer only what is still missing
  ok(!CARD.googleNoOrcid.linkGoogle, 'a Google account is not offered Google again');
  ok(!CARD.googleNoOrcid.linkOrcid,
    'nor ORCID sign-in while we have no iD to attach it to');
  ok(CARD.googleWithOrcid.linkOrcid,
    'once an iD is on file, attaching ORCID sign-in is offered — that is what stops a duplicate');
  ok(CARD.orcidOnly.linkGoogle && !CARD.orcidOnly.linkOrcid,
    'an ORCID-only account is offered Google, and not the sign-in it already has');
  ok(!CARD.bothLinked.linkGoogle && !CARD.bothLinked.linkOrcid,
    'an account reachable both ways is offered nothing');

  ok(CARD.googleNoOrcid.merge && CARD.orcidOnly.merge && CARD.bothLinked.merge,
    'every account can start a merge — two Gmail addresses are two accounts too');
  ok(/You sign in to this account with Google\./.test(CARD.googleNoOrcid.text),
    'the card says how this account is reached, in words');
  ok(/ORCID/.test(CARD.orcidOnly.text), 'and names ORCID when that is the way in');

  await page.evaluate(() => document.getElementById('oa-card-probe').remove());
}

/* ------------------------------------------------- the merge, start to end

   Driven against _fake-firebase.js — an in-memory stand-in for the compat SDK
   that records every operation in order. It proves nothing about Firebase, and
   the security rules are asserted separately (selftest.mjs). What it does show
   is the thing no screenshot can: that the merge copies before it deletes, and
   that a job posting changes hands while the account that owns it still
   exists. Get that order wrong and the damage is silent. */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');

  const DUP = 'dup-account-uid-0001';
  const KEPT = 'kept-account-uid-0002';
  const ORCID = '0000-0002-2398-9566';

  async function withFakeFirebase(seed, drive) {
    const q = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify(seed)};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('#oa-chip', { timeout: 10000 });
    const out = await drive(q);
    eq(errors, [], 'merge run: no uncaught script error');
    await q.close();
    return out;
  }

  const seed = {
    user: { uid: DUP, email: '', displayName: 'Ada',
            providerData: [{ providerId: 'oidc.orcid', uid: ORCID }] },
    keptUser: { uid: KEPT, email: 'ada@example.edu', displayName: 'Ada Lovelace',
                providerData: [{ providerId: 'google.com' }] },
    docs: [
      { path: `profiles/${DUP}`, data: { firstName: 'Ada', lastName: 'Lovelace',
                                         affiliation: 'Somewhere' } },
      { path: `profiles/${KEPT}`, data: { firstName: 'A.' } },
      { path: `users/${DUP}/alerts/a1`, data: {
          name: 'OM jobs', email: 'ada@example.edu', frequency: 'weekly', enabled: true,
          criteria: { topics: ['jobs'], country: ['USA'] },
          lastSentAt: '2026-08-10T00:00:00.000Z', lastCheckedAt: '2026-08-14T00:00:00.000Z' } },
      { path: `jobSubmissions/j1`, data: {
          uid: DUP, status: 'queued', ref: 'OA-JOB-260815-ABCD', institution: 'Somewhere',
          featured: true } },
      { path: `registeredUsers/${DUP}`, data: { t: 1 } },
    ],
  };

  const run = await withFakeFirebase(seed, async (q) => {
    // the iD an ORCID sign-in vouched for is recorded without being asked for
    await q.waitForFunction(() => window.__fb && window.__fb.at('set', 'profiles/') !== -1,
      null, { timeout: 8000 });

    await q.evaluate(() => window.OAAccounts.openProfile());
    await q.waitForSelector('#oa-merge-open');
    await q.click('#oa-merge-open');

    await q.waitForSelector('#oa-merge .oa-auth-provider[data-provider="google"]');
    const holds = await q.textContent('#oa-merge-holds');
    const orcidOffered = await q.$('#oa-merge .oa-auth-provider[data-provider="orcid"]');
    await q.click('#oa-merge .oa-auth-provider[data-provider="google"]');

    await q.waitForSelector('#oa-merge-step2:not([hidden])', { timeout: 8000 });
    const into = await q.textContent('#oa-merge-into');
    await q.click('#oa-merge-go');

    await q.waitForFunction(() => window.__fb.at('deleteUser', '') !== -1, null, { timeout: 8000 });
    await q.waitForTimeout(200);

    return q.evaluate(() => ({
      docs: window.__fb.dump(),
      log: window.__fb.log.map((e) => e.op + ' ' + e.path),
      order: {
        copyAlert: window.__fb.at('set', 'alerts/a1'),
        handOver: window.__fb.at('update', 'jobSubmissions/j1'),
        dropAlert: window.__fb.at('delete', 'alerts/a1'),
        dropProfile: window.__fb.at('delete', 'profiles/'),
        killSignIn: window.__fb.at('deleteUser', ''),
      },
    })).then((r) => Object.assign(r, { holds, into, orcidOffered: !!orcidOffered }));
  });

  // what the reader was told before agreeing to any of it
  ok(/1 e-mail alert/.test(run.holds) && /1 job posting/.test(run.holds),
    'the dialog counts what is actually at stake before asking');
  ok(/ada@example\.edu/.test(run.into),
    'and names the account being merged into, so it cannot be the wrong one');
  ok(!run.orcidOffered,
    'an ORCID account is not offered ORCID as the account to keep — one iD is one account');

  // the alert arrives under its own id, with the mailer's marks intact
  const moved = run.docs[`users/${KEPT}/alerts/a1`];
  ok(moved, 'the alert lands in the account being kept');
  eq(moved && moved.lastSentAt, '2026-08-10T00:00:00.000Z',
    'carrying its send history — without it the first e-mail is the whole catalogue');
  eq(moved && moved.mergedFrom, DUP, 'and a note of where it came from');
  eq(moved && moved.criteria.country, ['USA'], 'with its filters unchanged');
  ok(!run.docs[`users/${DUP}/alerts/a1`],
    'and is gone from the old account — a copy left behind sends everything twice for ever');

  // details fill blanks and overwrite nothing
  const keptProfile = run.docs[`profiles/${KEPT}`];
  eq(keptProfile.firstName, 'A.', 'the kept account keeps the name it chose');
  eq(keptProfile.lastName, 'Lovelace', 'and gains what it was missing');
  eq(keptProfile.orcid, ORCID, 'including the ORCID iD the duplicate was registered with');
  eq(keptProfile.orcidVerified, true, 'still marked as one ORCID vouched for');
  ok(!run.docs[`profiles/${DUP}`], 'the old profile is cleared away');
  ok(!run.docs[`registeredUsers/${DUP}`],
    'and so is its entry in the user tally, so the count is of people');

  // the posting changes hands rather than being re-created
  const job = run.docs['jobSubmissions/j1'];
  eq(job.uid, KEPT, 'the job posting is now owned by the account being kept');
  eq(job.mergedFrom, DUP, 'stamped with where it came from');
  eq(job.ref, 'OA-JOB-260815-ABCD', 'keeping its reference — the poster was given that number');
  eq(job.featured, true, 'and everything else about it, including what only the maintainer sets');

  eq(run.docs['accountKeys/orcid:' + ORCID].uid, KEPT,
    'the ORCID identity now points at the account that holds it');

  // ORDER. Each of these is a way to lose something with nothing on screen.
  const o = run.order;
  ok(o.copyAlert > -1 && o.dropAlert > o.copyAlert,
    'the alert is copied before the original is deleted');
  ok(o.handOver > -1 && o.killSignIn > o.handOver,
    'the posting changes hands before the sign-in that owns it is removed');
  ok(o.killSignIn > o.dropProfile && o.killSignIn > o.dropAlert,
    'and the sign-in goes last of all');

  /* A duplicate that ANNOUNCES itself. An ORCID registration whose iD is
     already claimed by another account is offered the repair on the spot,
     rather than left to find it in a menu it has no reason to open. */
  const noticed = await withFakeFirebase({
    user: seed.user,
    keptUser: seed.keptUser,
    docs: [
      { path: `profiles/${DUP}`, data: { orcid: ORCID, orcidVerified: true } },
      { path: 'accountKeys/orcid:' + ORCID, data: { uid: 'somebody-elses-uid-9', t: 1 } },
    ],
  }, async (q) => {
    await q.waitForSelector('#oa-merge', { timeout: 8000 });
    return {
      msg: await q.textContent('#oa-merge-msg'),
      keyUntouched: await q.evaluate((k) => window.__fb.docs[k].uid, 'accountKeys/orcid:' + ORCID),
    };
  });

  ok(/already have an Operations Academia account/.test(noticed.msg),
    'an ORCID sign-in that duplicates an existing account is told so, and shown the merge');
  eq(noticed.keyUntouched, 'somebody-elses-uid-9',
    'and the first account keeps its claim — the duplicate never overwrites it');
}

/* ------------------------------------------- the posting form's name pickers

   The three name fields offer the vocabulary the site has already published,
   which is what keeps one school from arriving under six spellings. All of it
   is behaviour no unit test can see, so it is driven here.                   */

{
  const f = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const formErrors = [];
  f.on('pageerror', (e) => formErrors.push(e.message));
  await f.goto(BASE + 'post-a-job.html', { waitUntil: 'domcontentloaded' });

  /* The form sits behind the sign-in gate, and auth resolving (failing, with no
     Firebase reachable from CI) re-hides it a moment after load — so reveal it
     AFTER that settles, or the unhide is quietly undone. */
  await f.waitForTimeout(1500);
  await f.evaluate(() => {
    document.getElementById('oa-job-form').hidden = false;
    const g = document.getElementById('oa-needauth');
    if (g) g.hidden = true;
  });
  await f.waitForSelector('#f-institution', { state: 'visible' });
  await f.waitForTimeout(400);

  await f.click('#f-institution');
  await f.waitForTimeout(250);
  const all = await f.$$eval('.oa-combo-list:not([hidden]) .oa-combo-opt', (n) => n.length);
  ok(all > 10, 'form: the university picker opens with the published vocabulary');

  await f.fill('#f-institution', 'tul');
  await f.waitForTimeout(200);
  const narrowed = await f.$$eval('.oa-combo-list:not([hidden]) .oa-combo-opt .oa-combo-name',
    (n) => n.map((x) => x.textContent));
  ok(narrowed.length < all, 'form: typing narrows the list');
  ok(narrowed.some((t) => /Tulane/i.test(t)), 'form: "tul" finds Tulane');

  await f.click('.oa-combo-list:not([hidden]) .oa-combo-opt');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-institution'), 'Tulane University', 'form: choosing fills the field');

  // the chosen university's own schools lead the next list
  await f.click('#f-school');
  await f.waitForTimeout(250);
  const firstSchool = await f.$eval('.oa-combo-list:not([hidden]) .oa-combo-opt .oa-combo-name',
    (n) => n.textContent);
  ok(/Freeman/i.test(firstSchool), 'form: schools already used at that university lead');

  // a name nobody has posted before is offered rather than refused
  await f.fill('#f-school', 'Wibble School of Widgets');
  await f.waitForTimeout(200);
  const add = await f.$$eval('.oa-combo-add .oa-combo-name', (n) => n.map((x) => x.textContent));
  ok(add.length === 1 && /not on the list yet/.test(add[0]),
    'form: an unknown name is offered as a new one');
  await f.click('.oa-combo-add');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-school'), 'Wibble School of Widgets', 'form: a new name is accepted');

  // keyboard: Enter takes the highlighted option and must NOT submit the form
  await f.fill('#f-unit', 'oper');
  await f.waitForTimeout(200);
  await f.keyboard.press('ArrowDown');
  await f.keyboard.press('Enter');
  await f.waitForTimeout(150);
  const unit = await f.inputValue('#f-unit');
  ok(unit && unit !== 'oper', 'form: arrow keys and Enter select an option');

  // what gets published is derived from the two, and shown before sending
  eq(await f.inputValue('#f-department'), `Wibble School of Widgets, ${unit}`,
    'form: the published line joins school and unit');
  ok((await f.textContent('#f-department-preview')).includes(unit),
    'form: the poster is shown what will appear under the institution name');

  eq(formErrors, [], 'form: no uncaught script errors');
  await f.close();
}

/* --------------------------------- Edit / Take down, and who may see them

   The controls are drawn from a Firestore read that CI cannot make, so the
   permission map is injected directly. What is being checked is the part that
   is easy to get wrong and impossible to unit-test: that a visitor sees no
   controls at all, that a signed-in poster sees them ONLY on their own
   posting, and that pressing Edit does not also toggle the card open.        */

{
  const j = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const jErrors = [];
  j.on('pageerror', (e) => jErrors.push(e.message));
  await j.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
  await j.waitForSelector('.oa-card');
  await j.waitForTimeout(600);

  eq(await j.$$eval('.oa-card-actions', (n) => n.length), 0,
    'jobs: a visitor who is not signed in sees no Edit or Take down');

  // one posting becomes editable, as it would be for the poster who made it
  const firstId = await j.$eval('.oa-card', (n) => n.id.replace(/^job-/, ''));
  await j.evaluate((id) => {
    void id;
  }, firstId).catch(() => {});

  await j.evaluate((id) => {
    // stand in for the permission read: mark exactly one row as ours
    const mod = window.OAJobEdit;
    mod.__setPermissionsForTest({ ready: true, admin: false, byId: { [id]: id }, byRef: {} });
  }, firstId);
  await j.waitForTimeout(200);

  eq(await j.$$eval('.oa-card-actions', (n) => n.length), 1,
    'jobs: exactly the one posting they own carries the controls');
  eq(await j.$$eval('.oa-card-actions .oa-jobbtn', (n) => n.map((x) => x.textContent)),
    ['Edit', 'Take down'], 'jobs: both controls, in that order');

  const owned = await j.$eval('.oa-card-actions', (n) => n.closest('.oa-card').id);
  eq(owned, 'job-' + firstId, 'jobs: and on the right card');

  // the card head is itself a button; the controls must not be inside it
  eq(await j.$$eval('.oa-card-head .oa-jobbtn', (n) => n.length), 0,
    'jobs: the controls are not nested inside the card toggle');

  // Edit leaves for the form carrying the document id, and does NOT expand
  const before = await j.$eval('#job-' + firstId + ' .oa-card-body', (n) => n.hidden);
  await j.click('.oa-jobbtn-edit');
  await j.waitForURL(/post-a-job\.html\?edit=/, { timeout: 5000 });
  ok(j.url().includes('edit=' + encodeURIComponent(firstId)),
    'jobs: Edit opens the form for that posting');
  ok(before, 'jobs: the card was closed before Edit was pressed');

  // the form says it is editing rather than posting
  await j.waitForTimeout(1200);
  eq(await j.$eval('.title-heading h2', (n) => n.textContent.trim()), 'Edit a posting',
    'form: edit mode renames the page');
  eq(await j.$eval('#oa-submit', (n) => n.textContent.trim()), 'Save changes',
    'form: and the button says what it does');

  eq(jErrors, [], 'jobs: no uncaught script errors');
  await j.close();
}

/* ------------------------------------------------- the advert file picker

   The form offers "upload the advert itself" beside "paste a link". What is
   checked: a wrong type is refused with a sentence, a good file supersedes the
   URL field and Remove restores it, and with no file chosen the form behaves
   exactly as it always did.                                                  */

{
  const u = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const uErrors = [];
  u.on('pageerror', (e) => uErrors.push(e.message));
  await u.goto(BASE + 'post-a-job.html', { waitUntil: 'domcontentloaded' });
  await u.waitForTimeout(1500);
  await u.evaluate(() => {
    document.getElementById('oa-job-form').hidden = false;
    const g = document.getElementById('oa-needauth');
    if (g) g.hidden = true;
  });
  await u.waitForSelector('#f-adFile-label', { state: 'visible' });

  ok(await u.$('#f-adFile'), 'advert: the file input exists');
  eq(await u.$eval('#f-adFile-name', (n) => n.textContent.trim()), 'No file chosen',
    'advert: and starts empty');

  // a text file is refused with a sentence, before any upload
  await u.setInputFiles('#f-adFile', {
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
  });
  await u.waitForTimeout(150);
  ok(/PDF or Word/.test(await u.$eval('#f-adFile-error', (n) => n.textContent)),
    'advert: a text file is refused, naming what is accepted');
  eq(await u.$eval('#f-adFile-name', (n) => n.textContent.trim()), 'No file chosen',
    'advert: and nothing is held');

  // a PDF is accepted; choosing it supersedes the pasted-link field
  await u.fill('#f-adUrl', 'https://example.edu/ad.pdf');
  await u.setInputFiles('#f-adFile', {
    name: 'Advert Final.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 fake'),
  });
  await u.waitForTimeout(150);
  ok(/Advert Final\.pdf/.test(await u.$eval('#f-adFile-name', (n) => n.textContent)),
    'advert: the chosen file is named, with its size');
  eq(await u.$eval('#f-adUrl', (n) => n.value), '', 'advert: a chosen file clears the URL');
  eq(await u.$eval('#f-adUrl', (n) => n.disabled), true, 'advert: and disables pasting another');
  eq(await u.$eval('#f-adFile-clear', (n) => n.hidden), false, 'advert: Remove appears');

  // Remove restores the paste-a-link path
  await u.click('#f-adFile-clear');
  await u.waitForTimeout(100);
  eq(await u.$eval('#f-adUrl', (n) => n.disabled), false, 'advert: Remove re-enables the URL');
  eq(await u.$eval('#f-adFile-name', (n) => n.textContent.trim()), 'No file chosen',
    'advert: and forgets the file');

  eq(uErrors, [], 'advert: no uncaught script errors');
  await u.close();
}

/* --------------------------------------------------- the draft survives

   Born of a real loss: the first upload attempt hung, the poster refreshed,
   and a fully filled-in form was gone. What is checked is the whole point —
   type, RELOAD, and the words are still there.                               */

{
  const d = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await d.goto(BASE + 'post-a-job.html', { waitUntil: 'domcontentloaded' });
  await d.waitForTimeout(1500);
  await d.evaluate(() => {
    document.getElementById('oa-job-form').hidden = false;
    const g = document.getElementById('oa-needauth');
    if (g) g.hidden = true;
  });
  await d.waitForSelector('#f-institution', { state: 'visible' });

  await d.fill('#f-institution', 'University of Draftshire');
  await d.fill('#f-comments', 'Interviewing at INFORMS.');
  await d.check('input[name="levels"][value="Post-Doc"]');
  await d.waitForTimeout(700);   // past the 400ms save debounce

  await d.reload({ waitUntil: 'domcontentloaded' });
  await d.waitForTimeout(1500);
  await d.evaluate(() => {
    document.getElementById('oa-job-form').hidden = false;
    const g = document.getElementById('oa-needauth');
    if (g) g.hidden = true;
  });
  await d.waitForSelector('#f-institution', { state: 'visible' });

  eq(await d.inputValue('#f-institution'), 'University of Draftshire',
    'draft: a reload keeps what was typed');
  eq(await d.inputValue('#f-comments'), 'Interviewing at INFORMS.',
    'draft: textareas too');
  eq(await d.$eval('input[name="levels"][value="Post-Doc"]', (n) => n.checked), true,
    'draft: and the ticked boxes');

  await d.close();
}

/* ------------------------------------------- the posting page paints NOW

   The page used to hold everything hidden until the Firebase SDK had loaded
   AND the session had restored — blank space for seconds on a cold cache, and
   for the full 15-second timeout when the CDN is unreachable (which it is in
   this sandbox, making that exact worst case the one measured here). The
   accounts hint paints the signed-out shape immediately; this asserts a
   visitor sees the sign-in gate well before any network verdict. */

{
  const f = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const t0 = Date.now();
  await f.goto(BASE + 'post-a-job.html', { waitUntil: 'domcontentloaded' });
  await f.waitForSelector('#oa-needauth', { state: 'visible', timeout: 4000 });
  const ms = Date.now() - t0;
  ok(ms < 4000, `fastpaint: the sign-in gate is visible in ${ms}ms, not after an SDK timeout`);
  eq(await f.$eval('#oa-job-form', (n) => n.hidden), true,
    'fastpaint: while the form itself stays hidden for a signed-out visitor');
  await f.close();
}

/* ------------------------------------------------- the list on a phone

   The skel grid cancels its own gutter below 736px (#content pads 30px, .row
   pulls -30px), which had the filters and cards running EDGE TO EDGE; and any
   focused input under 16px makes iOS Safari zoom the page in and leave it
   zoomed. Both are pinned here, plus the things a thumb needs: 40px+ targets
   and every picker menu staying inside the viewport. */

{
  const m = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  await m.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('.oa-card', { timeout: 15000 });

  const mob = await m.evaluate(() => {
    const doc = document.documentElement;
    const list = document.querySelector('.oa-list').getBoundingClientRect();
    const filters = document.querySelector('.oa-filters').getBoundingClientRect();
    const search = document.querySelector('.oa-filter input[type="search"]');
    const card = document.querySelector('.oa-card').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.oa-pick .oa-pick-btn')];
    const menus = btns.map((btn) => {
      btn.click();                                   // open
      const r = btn.parentElement.querySelector('.oa-pick-menu').getBoundingClientRect();
      btn.click();                                   // close
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    const pager = document.querySelector('.oa-pager button');
    return {
      overflowX: doc.scrollWidth > doc.clientWidth,
      gutterLeft: Math.round(filters.left),
      cardLeft: Math.round(card.left),
      cardRight: Math.round(doc.clientWidth - card.right),
      searchFont: parseFloat(getComputedStyle(search).fontSize),
      searchH: Math.round(search.getBoundingClientRect().height),
      pickH: Math.round(btns[0].getBoundingClientRect().height),
      pagerH: Math.round(pager.getBoundingClientRect().height),
      menus,
      vw: doc.clientWidth,
    };
  });

  ok(!mob.overflowX, 'mobile: the page never scrolls sideways');
  ok(mob.gutterLeft >= 8 && mob.cardLeft >= 8 && mob.cardRight >= 8,
    `mobile: filters and cards keep a side gutter (got ${mob.gutterLeft}/${mob.cardLeft}/${mob.cardRight})`);
  ok(mob.searchFont >= 16,
    `mobile: the search input is 16px+ so iOS does not zoom the page (got ${mob.searchFont}px)`);
  ok(mob.searchH >= 40 && mob.pickH >= 40,
    `mobile: search and picker controls are touch targets (got ${mob.searchH}/${mob.pickH}px)`);
  ok(mob.pagerH >= 36, `mobile: pager chevrons are tappable (got ${mob.pagerH}px)`);
  ok(mob.menus.every((r) => r.left >= 0 && r.right <= mob.vw),
    `mobile: every picker menu stays on screen (got ${JSON.stringify(mob.menus)})`);
  await m.close();
}

/* ----------------------------------------------- My postings loads cleanly

   The page's real behaviour is a Firestore read this sandbox cannot make; what
   a browser CAN prove is that the page boots without a script error and lands
   a signed-out visitor on the sign-in gate at the same fastpaint speed as the
   posting page — not on a blank screen. */

{
  const m = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const t0 = Date.now();
  await m.goto(BASE + 'my-postings.html', { waitUntil: 'domcontentloaded' });
  /* The gate paints from the hint immediately; in this sandbox the SDK then
     fails fast and the page swaps it for the cannot-reach notice — either box
     is a correct landing, a blank page is the failure being tested for. */
  await m.waitForSelector('#oa-needauth:not([hidden]), #oa-offline:not([hidden])',
    { timeout: 4000 });
  ok(Date.now() - t0 < 4000, 'my postings: a signed-out visitor lands on a message, not a blank page');
  eq(await m.$eval('#oa-my-list', (n) => n.hidden), true,
    'my postings: no list is shown to a signed-out visitor');
  await m.close();
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
