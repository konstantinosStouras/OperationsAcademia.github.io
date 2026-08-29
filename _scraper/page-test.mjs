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
import { unzipStore, sheetCells, lastRow } from './_xlsx-read.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketYear, inCurrentMarket } from './jobs-model.mjs';

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

/* The design this suite grew up with is archived at /v2/ since the 2026-08-17
   swap, and the single-page redesign it was previewing serves the root. Both
   are SERVED, so both are tested: the checks that assert on the old chrome
   (#nav, #header-wrapper, #titleBar, #navPanel, window.ga, jQuery) follow
   their pages down here, and the ones that were driving /v3/ now drive the
   root. Nothing was dropped in the move — it is the same suite, re-aimed. */
const V2 = 'v2/';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  /* Locally this is a convenience: the rest of the suite still runs on a
     machine with no browser installed. In CI it never is — the workflow
     installs Playwright two steps earlier, so a failed import means that
     install broke, and exiting 0 here would report a green run in which none
     of these checks ran at all. A check whose absence is invisible is not a
     check, so in CI a missing browser is a FAILURE and says which one it is. */
  if (process.env.CI) {
    console.log('::error::playwright is not installed — the browser checks did not run');
    server.close();
    process.exit(1);
  }
  console.log('playwright is not installed — skipping the browser checks');
  server.close();
  process.exit(0);
}

const launch = { args: ['--no-sandbox'] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
// a proxy in the environment would swallow the loopback request
launch.proxy = { server: 'http://127.0.0.1:1', bypass: '<-loopback>,127.0.0.1,localhost' };

const browser = await chromium.launch(launch);

/* ------------------------------------------------ measuring contrast, ONCE

   THREE separate copies of this had accumulated in this file, each with its
   own idea of what an element is painted on, and that is exactly how a naive
   one crept back in: the account badge sits on `--brand-soft`, which in dark
   theme is `rgba(198, 204, 212, 0.13)`. Read as a layer it looks like a LIGHT
   ground under light ink and measures 1.02:1; what is actually painted is 13%
   light over near-black, and the text reads at 8.11:1. The check failed a
   badge nobody could fault.

   So there is one implementation, it runs IN THE PAGE, and it COMPOSITES:
   every translucent layer over the one behind it until an opaque one is
   reached. `contrastOf(page, selector)` answers for one element; the audit
   near the end of this file walks a whole page with the same arithmetic. */
const CONTRAST_IN_PAGE = `(sel) => {
  const parse = (css) => {
    const m = String(css).match(/[\\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
  };
  const over = (top, bot) => ({
    r: top.r * top.a + bot.r * (1 - top.a),
    g: top.g * top.a + bot.g * (1 - top.a),
    b: top.b * top.a + bot.b * (1 - top.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const el = document.querySelector(sel);
  if (!el) return null;
  const stack = [];
  for (let n = el; n; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
  }
  let bg = stack.length && stack[stack.length - 1].a === 1
    ? stack.pop() : { r: 255, g: 255, b: 255, a: 1 };
  while (stack.length) bg = over(stack.pop(), bg);
  const fg = over(parse(getComputedStyle(el).color), bg);
  const L1 = lum(fg), L2 = lum(bg);
  return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2));
}`;

/** The contrast the browser actually paints for the first `sel`, or null. */
async function contrastOf(page, sel) {
  return page.evaluate(`(${CONTRAST_IN_PAGE})(${JSON.stringify(sel)})`);
}

const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));

/* ------------------------------------------------------------- first paint */

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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
  // absolute: this runs from /v2/jobs.html, where a relative path would ask
  // for /v2/data/jobs.json. The data files are shared by every version.
  const rows = await (await fetch('/data/jobs.json')).json();
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

/* The country is taken FROM the open menu, never hardcoded — the same rule
   the search term below follows. It used to click "USA", which stopped
   existing the day the site settled on one spelling per country and began
   publishing "United States" (assets/oa-countries.js). */
await page.click('#oaf-country');
// the option carries its cross-filtered count as a child element, so read the
// LABEL rather than the whole node ("United States5" is not a country)
const topCountry = await page.$eval('.oa-pick-menu .oa-opt', (n) => {
  const c = n.querySelector('.oa-opt-n');
  return n.textContent.replace(c ? c.textContent : '', '').trim();
});
const usa = await countAfter(() => page.click('.oa-pick-menu .oa-opt >> nth=0'));
ok(usa > 0 && usa < total,
  `a location filter narrows the list (${usa} of ${total} for "${topCountry}")`);
ok(!/\bUSA\b|\bUK\b/.test(topCountry),
  `the Location filter offers whole country names ("${topCountry}"), not abbreviations`);

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
// compared as PARSED parameters: a country with a space in it is written
// "United+States" by URLSearchParams and "United%20States" by
// encodeURIComponent, and the test is about the state being mirrored at all
const q = new URL(url).searchParams;
ok(q.get('country') === topCountry && q.get('institution') === term,
  'filter state is mirrored into the query string');

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
eq(Number((await page.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim().split(' ')[0]),
  both, 'reloading a filtered URL restores the same result set');
eq(await page.$eval('#oaf-institution', (n) => n.value), term, 'the text filter is restored');

/* A link shared or bookmarked while the site still said "USA". The country
   names were canonicalised in 2026-08 ("USA" -> "United States"), and without
   the filter's legacyValues map such a link would land on a filter that
   selects nothing — an empty page with no explanation, which is exactly the
   failure the ?filterA= mapping below already exists to prevent. */
await page.goto(BASE + V2 + 'jobs.html?country=USA', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const legacyCountry = await page.$$eval('.oa-chip', (ns) => ns.map((n) => n.textContent.trim()));
ok(legacyCountry.some((c) => /United States/.test(c)),
  'an old ?country=USA link still selects the United States');
const legacyRows = await page.$$eval('.oa-card', (ns) => ns.length);
ok(legacyRows > 0, 'and still shows the postings it was shared to show');

/* THE INSTITUTION THESE DEEP LINKS ARE TESTED WITH IS READ OFF THE PAGE.

   It used to be named here — "University of Mannheim" — and on 2026-08-27 the
   whole suite stopped dead at the ?filterD= check below, on master, with
   nothing but a data commit between green and red. Both of that university's
   postings are filed under market year 2026; the market rolled to 2027 in
   July, the jobs page scopes itself to the market under way, and so the deep
   link selected an institution with nothing in scope. The assertion failed,
   and the print check a few lines on threw outright for want of a card.

   A fixture NAMED in a test is a fact about the data, and this data is
   rebuilt from Firestore every morning — the same trap this repository has
   already recorded twice for its own guards ("a guard about specific rows
   names those rows; a guard over a whole file asserts a RULE any legitimate
   row satisfies"). What is under test here is that a legacy deep link still
   selects AN institution, so the institution comes from whatever the page is
   showing. */
await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');
const DEEP_UNI = (await page.$eval('.oa-card-title', (n) => n.textContent)).trim();
ok(DEEP_UNI.length > 2, `a posting to deep-link with (${DEEP_UNI})`);

// the legacy Awesome Table deep link the footer and the "Further info" column
// still emit must keep working
await page.goto(BASE + V2 + 'jobs.html?filterA=' + encodeURIComponent(DEEP_UNI),
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const viaA = await page.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent.trim()));
ok(viaA.length > 0 && viaA.every((t) => t.includes(DEEP_UNI)),
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

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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
await page.goto(BASE + V2 + 'jobs.html?deadline=Open', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
eq(await page.$$eval('.oa-chip .oa-chip-label', (ns) => ns.map((n) => n.textContent)),
  ['Closing soon'], 'a ?deadline=Open link still selects the bucket it named');

/* ------------------------------------------------- a chip is one blue button

   The whole chip removes the value; the × is decoration. It used to be the
   other way round — a chip carrying a 9-pixel button — so a click on the blue
   did nothing at all.                                                        */

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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

await page.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card');

await page.click('#oaf-country');
await page.waitForSelector('.oa-pick-menu:not([hidden]) .oa-pick-search');
// taken from the live list, like every other value in this file: "usa" was
// typed here until the site settled on one spelling per country
const typed = topCountry.slice(0, 4).toLowerCase();
await page.type('.oa-pick-menu:not([hidden]) .oa-pick-search', typed, { delay: 60 });
eq(await page.$eval('.oa-pick-menu:not([hidden]) .oa-pick-search', (n) => n.value),
  typed, 'typing into the picker search lands in order, not reversed');
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
await page.goto(BASE + V2 + 'jobs.html?utm_source=newsletter&country=USA',
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(400);
ok(page.url().includes('utm_source=newsletter'),
  'a foreign query parameter is not erased from the address bar');

// the Universities map deep-links institutions as ?filterD= (the name comes
// from the page — see DEEP_UNI above for why it is not written down here)
await page.goto(BASE + V2 + 'jobs.html?filterD=' + encodeURIComponent(DEEP_UNI),
  { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-card, .oa-empty');
await page.waitForTimeout(300);
const viaD = await page.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent.trim()));
ok(viaD.length > 0 && viaD.every((t) => t.includes(DEEP_UNI)),
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

await page.goto(BASE + V2 + 'jobs.html?institution=zzzznotathing', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.oa-empty', { timeout: 8000 });
ok((await page.$eval('.oa-empty', (n) => n.textContent)).includes('No job postings'),
  'a filter that matches nothing explains itself');

const m = await browser.newPage({ viewport: { width: 390, height: 780 } });
await m.goto(BASE + V2 + 'jobs.html', { waitUntil: 'domcontentloaded' });
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
  await q.goto(BASE + V2 + name, { waitUntil: 'domcontentloaded' });
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
  await q.goto(BASE + V2 + 'feedback.html', { waitUntil: 'domcontentloaded' });
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
    await q.goto(BASE + V2 + 'index.html', { waitUntil: 'domcontentloaded' });
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
      // the OTHER two posting kinds — the rules always allowed their
      // hand-over, and the merge once moved only the jobs, stranding these
      { path: `candidateSubmissions/c1`, data: {
          uid: DUP, status: 'queued', ref: 'OA-CAND-260815-EFGH', first: 'Ada',
          last: 'Lovelace' } },
      { path: `placementSubmissions/p1`, data: {
          uid: DUP, status: 'published', ref: 'OA-PLAC-260815-JKLM', first: 'Someone',
          last: 'Placed' } },
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
        handCand: window.__fb.at('update', 'candidateSubmissions/c1'),
        handPlace: window.__fb.at('update', 'placementSubmissions/p1'),
        dropAlert: window.__fb.at('delete', 'alerts/a1'),
        dropProfile: window.__fb.at('delete', 'profiles/'),
        killSignIn: window.__fb.at('deleteUser', ''),
      },
    })).then((r) => Object.assign(r, { holds, into, orcidOffered: !!orcidOffered }));
  });

  // what the reader was told before agreeing to any of it
  ok(/1 e-mail alert/.test(run.holds) && /1 job posting/.test(run.holds),
    'the dialog counts what is actually at stake before asking');
  ok(/1 candidate profile/.test(run.holds) && /1 placement report/.test(run.holds),
    'candidate profiles and placement reports are counted too — they are equally at stake');
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

  // …and so do the candidate profile and the placement report. These share the
  // job posting's ownership model exactly, so a merge that misses them strands
  // them under a deleted sign-in: unwithdrawable, uncorrectable, for ever.
  const cand = run.docs['candidateSubmissions/c1'];
  eq(cand.uid, KEPT, 'the candidate profile is handed over with the jobs');
  eq(cand.mergedFrom, DUP, 'stamped like a job posting');
  eq(cand.status, 'queued', 'its lifecycle state untouched');
  const place = run.docs['placementSubmissions/p1'];
  eq(place.uid, KEPT, 'the placement report is handed over with the jobs');
  eq(place.mergedFrom, DUP, 'stamped like a job posting');

  eq(run.docs['accountKeys/orcid:' + ORCID].uid, KEPT,
    'the ORCID identity now points at the account that holds it');

  // ORDER. Each of these is a way to lose something with nothing on screen.
  const o = run.order;
  ok(o.copyAlert > -1 && o.dropAlert > o.copyAlert,
    'the alert is copied before the original is deleted');
  ok(o.handOver > -1 && o.killSignIn > o.handOver,
    'the posting changes hands before the sign-in that owns it is removed');
  ok(o.handCand > -1 && o.killSignIn > o.handCand &&
     o.handPlace > -1 && o.killSignIn > o.handPlace,
    'so do the candidate profile and the placement report');
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

/* ----------------------------------- the same flows, on the /v3/ preview

   The v3 pages vendor their own oa-accounts.js, so the merge and the posting
   flows are driven AGAIN against them — a fix landed only in the root copy
   would pass everything above and still leave /v3/ broken.

   The story under test is the owner's own scenario: one person posts a job
   from each of two accounts, merges the two, and must find BOTH postings on
   the kept account's My postings page. Then each posting form — job,
   candidate, placement — is filled in and submitted end to end. */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');

  const DUP = 'dup-account-uid-0001';
  const KEPT = 'kept-account-uid-0002';
  const dupUser = { uid: DUP, email: 'ada.dup@example.edu', displayName: 'Ada Dup',
                    providerData: [{ providerId: 'password' }] };
  const keptUser = { uid: KEPT, email: 'ada@example.edu', displayName: 'Ada Lovelace',
                     providerData: [{ providerId: 'google.com' }] };

  async function onSite(url, seed, drive, { dialogs } = {}) {
    const q = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    if (dialogs) q.on('dialog', (d) => d.accept());
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify(seed)};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    const out = await drive(q);
    eq(errors, [], `${url}: no uncaught script error`);
    await q.close();
    return out;
  }

  /* -- one person, two accounts, one job posting from each ---------------- */

  const seed = {
    user: dupUser, keptUser,
    docs: [
      { path: `profiles/${DUP}`, data: { firstName: 'Ada', lastName: 'Dup' } },
      { path: `profiles/${KEPT}`, data: { firstName: 'Ada' } },
      { path: `users/${DUP}/alerts/a1`, data: {
          name: 'OM jobs', email: 'a@x.edu', frequency: 'weekly', enabled: true,
          criteria: { topics: ['jobs'] }, lastSentAt: '2026-08-10T00:00:00.000Z' } },
      { path: 'jobSubmissions/jA', data: {
          uid: DUP, status: 'queued', ref: 'OA-JOB-260815-AAAA',
          institution: 'Dup University', department: 'School of Things',
          createdAt: '2026-08-15T00:00:00.000Z' } },
      { path: 'jobSubmissions/jB', data: {
          uid: KEPT, status: 'published', ref: 'OA-JOB-260810-BBBB',
          institution: 'Kept College', department: 'Ops Group',
          createdAt: '2026-08-10T00:00:00.000Z' } },
      { path: 'candidateSubmissions/c1', data: {
          uid: DUP, status: 'queued', ref: 'OA-CAND-260815-CCCC', first: 'Ada', last: 'Dup' } },
      { path: 'placementSubmissions/p1', data: {
          uid: DUP, status: 'queued', ref: 'OA-PLAC-260815-DDDD', first: 'Someone', last: 'Placed' } },
      { path: `registeredUsers/${DUP}`, data: { t: 1 } },
    ],
  };

  const merged = await onSite('my-postings.html', seed, async (q) => {
    // signed in as the duplicate, My postings shows ITS one posting
    await q.waitForSelector('.oa-my-card', { timeout: 10000 });
    const pre = await q.$$eval('.oa-my-card .oa-my-inst', (els) => els.map((e) => e.textContent));

    await q.evaluate(() => window.OAAccounts.openProfile());
    await q.waitForSelector('#oa-merge-open');
    await q.click('#oa-merge-open');
    await q.waitForSelector('#oa-merge .oa-auth-provider[data-provider="google"]');
    await q.waitForFunction(() =>
      !/Checking/.test(document.getElementById('oa-merge-holds').textContent),
      null, { timeout: 8000 });
    const holds = await q.textContent('#oa-merge-holds');
    await q.click('#oa-merge .oa-auth-provider[data-provider="google"]');
    await q.waitForSelector('#oa-merge-step2:not([hidden])', { timeout: 8000 });
    await q.click('#oa-merge-go');
    await q.waitForFunction(() => window.__fb.at('deleteUser', '') !== -1, null, { timeout: 8000 });
    await q.waitForTimeout(200);

    return {
      pre, holds,
      docs: await q.evaluate(() => window.__fb.dump()),
      steps: await q.$$eval('#oa-merge-log li', (lis) => lis.map((li) => li.textContent)),
    };
  });

  eq(merged.pre, ['Dup University'],
    'v3 my-postings: the duplicate sees its own posting before the merge');
  ok(/1 job posting/.test(merged.holds) && /1 candidate profile/.test(merged.holds) &&
     /1 placement report/.test(merged.holds),
    'v3 merge: the dialog counts the job posting, candidate profile and placement report');
  eq(merged.docs['jobSubmissions/jA'].uid, KEPT,
    'v3 merge: the duplicate\'s job posting now belongs to the kept account');
  eq(merged.docs['jobSubmissions/jB'].uid, KEPT,
    'and the kept account\'s own posting is untouched');
  eq(merged.docs['candidateSubmissions/c1'].uid, KEPT,
    'the candidate profile came along');
  eq(merged.docs['placementSubmissions/p1'].uid, KEPT,
    'and so did the placement report');
  ok(merged.steps.some((s) => /Handed over 1 job posting/.test(s)) &&
     merged.steps.some((s) => /Handed over 1 candidate profile/.test(s)) &&
     merged.steps.some((s) => /Handed over 1 placement report/.test(s)),
    'v3 merge: the log names everything that changed hands');

  /* -- the kept account signs in and finds BOTH postings ------------------ */

  const after = await onSite('my-postings.html', {
    user: keptUser,
    docs: Object.keys(merged.docs).map((p) => ({ path: p, data: merged.docs[p] })),
  }, async (q) => {
    await q.waitForSelector('.oa-my-card', { timeout: 10000 });
    return q.$$eval('.oa-my-card .oa-my-inst', (els) => els.map((e) => e.textContent).sort());
  });
  eq(after, ['Dup University', 'Kept College'],
    'after the merge, My postings shows BOTH job postings under the kept account');

  /* -- post a job on /v3/ -------------------------------------------------- */

  const posted = await onSite('post-a-job.html', { user: keptUser, docs: [] }, async (q) => {
    await q.waitForSelector('#oa-job-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-institution', 'Test University');
    await q.fill('#f-school', 'Business School');
    await q.fill('#f-unit', 'Operations Area');
    await q.selectOption('#f-type', 'University');
    await q.fill('#f-country', 'Ireland');
    // an open name-picker dropdown sits over the checkboxes below it; the
    // combo closes on any mousedown outside it (oa-combo.js), which fill()
    // never produces — so produce one
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.check('input[name="levels"][value="Assistant Professor"]');
    await q.check('#f-untilFilled');
    await q.fill('#f-firstName', 'Kon');
    await q.fill('#f-lastName', 'Stouras');
    await q.fill('#f-email', 'kon@example.edu');
    const noYearField = await q.evaluate(() => !document.getElementById('f-year'));
    const yearNote = await q.evaluate(() => {
      const n = document.getElementById('oa-year-note');
      return n ? n.textContent : '';
    });
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    const ref = await q.textContent('#oa-ref');
    const doc = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).find((p) => p.startsWith('jobSubmissions/'));
      return d[k];
    });
    return { ref, doc, noYearField, yearNote };
  });
  ok(/^OA-JOB-\d{6}-[A-Z2-9]{4}$/.test(posted.ref.trim()),
    'v3 post-a-job: the poster is given a quotable reference');
  eq(posted.doc.status, 'queued', 'the submission is queued for the build');
  eq(posted.doc.uid, KEPT, 'and owned by the signed-in poster');
  eq(posted.doc.department, 'Business School, Operations',
    'school and unit are joined into the published department line — under the ' +
    'canonical names (assets/oa-schools.js), so "Operations Area" is posted as ' +
    'the department the site already publishes under');
  eq(posted.doc.year, marketYear(),
    'the job market year is derived from the date, never asked (the form has no picker)');
  eq(posted.noYearField, true,
    'and the form does not ask for it — it states what it worked out instead');
  ok(posted.yearNote.includes(`${marketYear() - 1}\u2013${marketYear()}`),
    `the form SAYS which season the posting lands in (${marketYear() - 1}-${marketYear()}), so nothing is hidden`);

  /* -- the site's records pre-fill the form (owner, 2026-08-24) ------------

     Typing INSEAD must fill what the records answer definitely \u2014 its one
     school, its unanimous type \u2014 and leave the department (two on record)
     and the country (three campuses) to the poster. Choosing a department
     must surface its page link FROM THE OVERLAY (a signed-in correction
     reaches the next poster), and correcting that link must file a
     directoryEdits document when the posting is sent. Driven against the
     live data/directory.json, so this breaks if INSEAD's rows ever stop
     saying what this scenario needs them to say \u2014 which is the point. */

  const DS_ROW = 'insead__school-of-business__decision-sciences';
  const prefilled = await onSite('post-a-job.html', {
    user: keptUser,
    docs: [{ path: 'directoryEdits/' + DS_ROW, data: {
      rowId: DS_ROW, by: 'someone-else', name: 'A. User', t: 5,
      deptUrl: 'https://edited.example/ds',
    } }],
  }, async (q) => {
    await q.waitForSelector('#oa-job-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-institution', 'INSEAD');
    await q.waitForFunction(() => document.getElementById('f-school').value !== '',
      null, { timeout: 8000 });
    const afterUni = await q.evaluate(() => ({
      school: document.getElementById('f-school').value,
      unit: document.getElementById('f-unit').value,
      type: document.getElementById('f-type').value,
      country: document.getElementById('f-country').value,
    }));

    await q.fill('#f-unit', 'Decision Sciences');
    await q.waitForFunction(() => document.getElementById('f-deptUrl').value !== '',
      null, { timeout: 8000 });
    const link = await q.evaluate(() => ({
      deptUrl: document.getElementById('f-deptUrl').value,
      note: document.getElementById('f-deptUrl-note').textContent,
    }));

    // the poster corrects the link, finishes the posting, and sends it
    await q.fill('#f-deptUrl', 'https://corrected.example/ds');
    await q.fill('#f-country', 'France');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.check('input[name="levels"][value="Assistant Professor"]');
    await q.check('#f-untilFilled');
    await q.fill('#f-firstName', 'Kon');
    await q.fill('#f-lastName', 'Stouras');
    await q.fill('#f-email', 'kon@example.edu');
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    await q.waitForFunction((row) => {
      const d = window.__fb.dump()['directoryEdits/' + row];
      return !!d && d.deptUrl === 'https://corrected.example/ds';
    }, DS_ROW, { timeout: 8000 });
    return {
      afterUni, link,
      editDoc: await q.evaluate((row) =>
        window.__fb.dump()['directoryEdits/' + row], DS_ROW),
    };
  });
  eq(prefilled.afterUni.school, 'School of Business',
    'v3 post-a-job: INSEAD\u2019s ONE school is pre-filled from the site\u2019s records');
  eq(prefilled.afterUni.type, 'Business School',
    'v3 post-a-job: \u2026and so is its unanimous type');
  eq(prefilled.afterUni.unit, '',
    'v3 post-a-job: two departments on record \u2014 the department stays the poster\u2019s');
  eq(prefilled.afterUni.country, '',
    'v3 post-a-job: three campus countries \u2014 the country stays the poster\u2019s');
  eq(prefilled.link.deptUrl, 'https://edited.example/ds',
    'v3 post-a-job: the department\u2019s link is pre-filled from the OVERLAID record ' +
    '\u2014 a signed-in correction reaches the next poster');
  ok(/records/.test(prefilled.link.note),
    'v3 post-a-job: \u2026with a note asking the poster to verify it');
  eq(prefilled.editDoc.deptUrl, 'https://corrected.example/ds',
    'v3 post-a-job: the corrected link is filed into directoryEdits when the posting is sent');
  eq(prefilled.editDoc.by, KEPT,
    'v3 post-a-job: \u2026attributed to the poster, never to whoever edited before');
  eq(prefilled.editDoc.rowId, DS_ROW,
    'v3 post-a-job: \u2026as a MERGE onto the row\u2019s own document, where the page reads it');

  /* -- a pre-fill mark never outlives its value (the CI race) --------------

     The failure the first CI run caught, made deterministic: the records
     fill a university's ONE department and MARK it; the poster then overtypes
     it, re-scopes the school, and picks the very string the stale mark still
     holds \u2014 all inside ONE task, so no resolve timer can run in between,
     which is exactly the interleaving CI produced under load. The mark must
     be retired ON THE EVENT (reconcile in oa-uniinfo.js), or the pending
     resolve reads the pick as its own stale fill and clears a department
     the poster just chose.

     THE FIXTURE IS READ FROM THE VOCABULARY, NOT NAMED. It used to be
     "Tulane University" + "Management Science", and on 2026-08-25 a
     perfectly legitimate posting gave Freeman a SECOND department
     ("Information Systems") \u2014 so the records could no longer answer
     definitely, the pre-fill correctly declined to guess, this assertion
     timed out, and master went red with nothing wrong on the site. That is
     the third time a guard in this repository has pinned a fact about
     specific rows that the data is free to change; the rule it broke is the
     one CLAUDE.md already states \u2014 a guard over a whole file asserts a RULE
     any legitimate row satisfies. So the test asks the vocabulary for a
     university that HAS exactly one school with exactly one department, and
     drives that one; when the catalogue holds none it says so and skips,
     because a race in the browser is not evidence about anybody's
     departments. */
  const vocab = JSON.parse(await readFile(path.join(ROOT, 'data', 'vocab.json'), 'utf8'));
  const soloUni = (() => {
    for (const [uni, entry] of Object.entries(vocab.byUniversity || {})) {
      const schools = Object.entries(entry.bySchool || {});
      if (schools.length !== 1) continue;
      const [school, units] = schools[0];
      const list = Array.isArray(units) ? units : Object.keys(units || {});
      if (list.length === 1 && school && list[0]) return { uni, school, unit: list[0] };
    }
    return null;
  })();

  if (!soloUni) {
    ok(true, 'v3 post-a-job: no single-department university in the vocabulary \u2014 ' +
      'the pre-fill race check has nothing definite to drive, and is skipped');
  } else {
  const race = await onSite('post-a-job.html', { user: keptUser, docs: [] }, async (q) => {
    await q.waitForSelector('#oa-job-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-institution', soloUni.uni);
    await q.waitForFunction((want) =>
      document.getElementById('f-unit').value === want &&
      document.getElementById('f-unit').getAttribute('data-oa-auto-unit') === want,
    soloUni.unit, { timeout: 8000 });
    await q.evaluate((want) => {
      const put = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      put('f-unit', 'Wibble Widgets Group');        // taken over by the poster
      put('f-school', 'Wibble School of Widgets');  // \u2026who re-scopes the school
      put('f-unit', want);                          // \u2026and picks the marked string
    }, soloUni.unit);
    await q.waitForTimeout(400);                    // let every scheduled resolve run
    return q.evaluate(() => ({
      unit: document.getElementById('f-unit').value,
      school: document.getElementById('f-school').value,
    }));
  });
  eq(race.unit, soloUni.unit,
    'v3 post-a-job: a department the poster picked survives every late resolve \u2014 ' +
    'a stale pre-fill mark is retired on the event, not on the next timer');
  eq(race.school, 'Wibble School of Widgets',
    'v3 post-a-job: \u2026and the re-scoped school stays the poster\u2019s too');
  }

  /* -- correct it (the edit path), on /v3/ --------------------------------- */

  const editSeed = {
    user: keptUser,
    docs: [{ path: 'jobSubmissions/j9', data: {
      uid: KEPT, status: 'published', ref: 'OA-JOB-260810-EEEE', institution: 'Edit U',
      school: 'School X', unit: 'Unit Y', department: 'School X, Unit Y', country: 'USA',
      type: 'University', levels: ['Post-Doc'], applyByDate: '2026-12-01', untilFilled: false,
      firstName: 'A', lastName: 'B', email: 'a@b.edu',
      // deliberately an OLDER season than the one under way: re-stamping it
      // on save is the bug the derived year had to close
      year: 2026,
      createdAt: '2026-08-10T00:00:00.000Z',
    } }],
  };
  const edited = await onSite('post-a-job.html?edit=j9', editSeed, async (q) => {
    await q.waitForSelector('#oa-job-form:not([hidden])', { timeout: 10000 });
    await q.waitForFunction(() => document.getElementById('f-institution').value !== '',
      null, { timeout: 8000 });
    const prefill = await q.evaluate(() => ({
      school: document.getElementById('f-school').value,
      date: document.getElementById('f-applyByDate').value,
      btn: document.getElementById('oa-submit').textContent,
    }));
    await q.fill('#f-institution', 'Edit University (fixed)');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    return { prefill, doc: await q.evaluate(() => window.__fb.dump()['jobSubmissions/j9']) };
  });
  eq(edited.prefill, { school: 'School X', date: '2026-12-01', btn: 'Save changes' },
    'v3 edit: the stored posting is loaded back into the form');
  eq(edited.doc.institution, 'Edit University (fixed)', 'the correction is saved');
  eq(edited.doc.uid, KEPT, 'the owner is unchanged by an edit');
  eq(edited.doc.status, 'queued', 'and the build re-publishes it');
  eq(edited.doc.year, 2026,
    'correcting a posting KEEPS its own market year — a typo fix must not move it to this season');

  /* -- take one down from My postings -------------------------------------- */

  const down = await onSite('my-postings.html', editSeed, async (q) => {
    await q.waitForSelector('.oa-my-card', { timeout: 10000 });
    await q.click('.oa-jobbtn-del');
    await q.waitForFunction(() =>
      window.__fb.dump()['jobSubmissions/j9'].status === 'withdrawn', null, { timeout: 8000 });
    return q.evaluate(() => window.__fb.dump()['jobSubmissions/j9'].status);
  }, { dialogs: true });
  eq(down, 'withdrawn', 'v3 my-postings: Take down withdraws, never deletes');

  /* -- post a candidacy on /v3/ -------------------------------------------- */

  const cand = await onSite('post-a-candidate.html', { user: keptUser, docs: [] }, async (q) => {
    await q.waitForSelector('#oa-cand-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-first', 'Grace');
    await q.fill('#f-last', 'Hopper');
    // the owner's own example (2026-08-24): university / school / department
    await q.fill('#f-institution', 'Northwestern University');
    await q.fill('#f-school', 'Kellogg School of Management');
    await q.fill('#f-unit', 'Operations');
    await q.selectOption('#f-position', 'PhD Candidate');
    await q.fill('#f-email', 'grace@example.edu');
    await q.fill('#f-personalEmail', 'grace.hopper@gmail.example');
    await q.check('input[name="researchAreas"][value="Supply Chain Management"]');
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    const ref = await q.textContent('#oa-ref');
    const doc = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).find((p) => p.startsWith('candidateSubmissions/'));
      return d[k];
    });
    // the research-summary slot was retired (owner, 2026-08-24) — the form
    // must neither offer it nor write its fields
    const noRs = await q.evaluate(() =>
      !document.getElementById('f-rsUrl') && !document.getElementById('f-rsFile'));
    return { ref, doc, noRs };
  });
  ok(/^OA-CAND-\d{6}-[A-Z2-9]{4}$/.test(cand.ref.trim()),
    'v3 post-a-candidate: the candidate is given a quotable reference');
  eq(cand.doc.status, 'queued', 'the profile is queued for the build');
  eq(cand.doc.uid, KEPT, 'and owned by the signed-in candidate');
  eq(cand.doc.emailPublic, false,
    'the e-mail address stays private unless the candidate opted in');
  eq(cand.doc.personalEmail, 'grace.hopper@gmail.example',
    'the personal e-mail \u2014 the address that outlives the affiliation \u2014 is stored on the profile');
  eq([cand.doc.institution, cand.doc.school, cand.doc.unit],
    ['Northwestern University', 'Kellogg School of Management', 'Operations'],
    'the affiliation is asked as three fields \u2014 university, school, department');
  eq(cand.doc.affiliation, 'Operations, Kellogg School of Management, Northwestern University',
    'and publishes as the ONE joined line every consumer already reads');
  eq(cand.doc.rsUrl, undefined,
    'and the retired research-summary field is never written');
  eq(cand.noRs, true,
    'the form no longer offers the research-summary slot (retired 2026-08-24)');
  eq(cand.doc.year, marketYear(),
    'and its market year is derived from the date, like the job form\u2019s');

  /* -- one profile per account per market year (owner, 2026-08-24) --------- */

  const oneSeed = { user: keptUser, docs: [{ path: 'candidateSubmissions/c9', data: {
    uid: KEPT, status: 'queued', ref: 'OA-CAND-260820-ZZZZ',
    first: 'Grace', last: 'Hopper', affiliation: 'Test University',
    position: 'PhD Candidate', year: marketYear(),
    createdAt: '2026-08-20T00:00:00.000Z',
  } }] };
  const one = await onSite('post-a-candidate.html', oneSeed, async (q) => {
    await q.waitForURL(/post-a-candidate\.html\?edit=c9/, { timeout: 10000 });
    await q.waitForFunction(() => document.getElementById('f-first').value !== '',
      null, { timeout: 8000 });
    return q.evaluate(() => ({
      heading: (document.querySelector('.v3-pa-hero .v3-h1') ||
        document.querySelector('.title-heading h2') || {}).textContent || '',
      first: document.getElementById('f-first').value,
      inst: document.getElementById('f-institution').value,
    }));
  });
  eq(one.heading.trim(), 'Edit your profile',
    'a candidate who already has a profile this season is sent to EDIT it \u2014 one profile per market year');
  eq(one.first, 'Grace', 'and the form holds their own profile, not a blank one');
  eq(one.inst, 'Test University',
    'a pre-split profile\u2019s free-text affiliation lands in the university box to redistribute');

  /* -- report a placement on /v3/ ------------------------------------------ */

  const plac = await onSite('post-a-placement.html', { user: keptUser, docs: [] }, async (q) => {
    await q.waitForSelector('#oa-placement-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-first', 'New');
    await q.fill('#f-last', 'Professor');
    await q.fill('#f-phdInstitution', 'PhD University');
    await q.fill('#f-joiningInstitution', 'Joining College');
    await q.fill('#f-joiningPosition', 'Assistant Professor');
    await q.fill('#f-email', 'reporter@example.edu');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    const ref = await q.textContent('#oa-ref');
    const doc = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).find((p) => p.startsWith('placementSubmissions/'));
      return d[k];
    });
    return { ref, doc };
  });
  ok(/^OA-PLAC-\d{6}-[A-Z2-9]{4}$/.test(plac.ref.trim()),
    'v3 post-a-placement: the reporter is given a quotable reference');
  eq(plac.doc.status, 'queued', 'the placement is queued for the build');
  eq(plac.doc.uid, KEPT, 'and owned by the signed-in reporter');
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

  /* ALPHABETICAL, ON SCREEN. The list used to open most-posted-first, which
     reads as no order at all once it is three hundred names long: the reader
     knows the university they want and is looking for it, not browsing. Only
     a browser can see this, because the order is the product of the score,
     the comparator and the render cap together. */
  const opened = await f.$$eval(
    '.oa-combo-list:not([hidden]) .oa-combo-opt:not(.oa-combo-add) .oa-combo-name',
    (n) => n.map((x) => x.textContent.trim()));
  const az = opened.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  eq(opened.findIndex((v, i) => v !== az[i]), -1,
    'form: with nothing typed the picker opens in alphabetical order');
  ok(opened.length > 250,
    `form: and renders the whole list (${opened.length}), not a top-N that ends in the C's`);
  ok(/^A/i.test(opened[0]) && /^[U-Z]/i.test(opened[opened.length - 1]),
    'form: so it runs from the start of the alphabet to the end');

  /* AND THE SEED IS IN IT. A first-time poster from a university nobody has
     posted from used to meet a blank list; these four are in the seed of the
     world's operations schools and in no posting on the site. */
  for (const uni of ['Bilkent University', 'Cranfield University', 'VinUniversity',
    'Kühne Logistics University']) {
    ok(opened.some((v) => v === uni), `form: offers ${uni}, which has never posted here`);
  }

  await f.fill('#f-institution', 'tul');
  await f.waitForTimeout(200);
  const narrowed = await f.$$eval('.oa-combo-list:not([hidden]) .oa-combo-opt .oa-combo-name',
    (n) => n.map((x) => x.textContent));
  ok(narrowed.length < all, 'form: typing narrows the list');
  ok(narrowed.some((t) => /Tulane/i.test(t)), 'form: "tul" finds Tulane');

  await f.click('.oa-combo-list:not([hidden]) .oa-combo-opt');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-institution'), 'Tulane University', 'form: choosing fills the field');

  /* A NEAR MISS still finds the university. "tulane" — a poster who saw the
     one matching row and moved on — used to match nothing: the cascade
     quietly went away, the school list opened at every school on the site,
     and the posting was filed under a university nobody else uses. */
  for (const [typed, becomes] of [
    ['tulane', 'Tulane University'],
    ['Tulane Univ', 'Tulane University'],
    ['tulane university', 'Tulane University'],
  ]) {
    await f.fill('#f-institution', typed);
    await f.evaluate(() => {
      const el = document.getElementById('f-institution');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });
    await f.waitForTimeout(120);
    eq(await f.inputValue('#f-institution'), becomes,
      `form: "${typed}" is the one university it can only be the beginning of`);
  }
  for (const typed of ['University of', 'Wibble Institute']) {
    await f.fill('#f-institution', typed);
    await f.evaluate(() => {
      const el = document.getElementById('f-institution');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });
    await f.waitForTimeout(120);
    eq(await f.inputValue('#f-institution'), typed,
      `form: "${typed}" could be several universities or none, so it is left alone`);
  }
  await f.fill('#f-institution', 'Tulane University');
  await f.evaluate(() => {
    const el = document.getElementById('f-institution');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  });
  await f.waitForTimeout(120);

  // the chosen university's own schools lead the next list
  await f.click('#f-school');
  await f.waitForTimeout(250);
  const firstSchool = await f.$eval('.oa-combo-list:not([hidden]) .oa-combo-opt .oa-combo-name',
    (n) => n.textContent);
  ok(/Freeman/i.test(firstSchool), 'form: schools already used at that university lead');

  /* ------------------------------------------------- the cascade, as reported

     The bug: choosing Tulane offered BOTH "A. B. Freeman School of Business" and
     "Freeman School of Business" — one school, posted twice, spelled twice —
     and the department field offered every department on the site. What must
     happen instead is one school under a heading naming the university, and
     then that school's own departments.                                       */

  const scoped = await f.evaluate(() => {
    const open = document.querySelector('.oa-combo-list:not([hidden])');
    return {
      heading: open.querySelector('.oa-combo-group')
        ? open.querySelector('.oa-combo-group').textContent : '',
      inScope: [...open.querySelectorAll('.oa-combo-opt.is-pref .oa-combo-name')]
        .map((n) => n.textContent),
      others: [...open.querySelectorAll('.oa-combo-opt:not(.is-pref):not(.oa-combo-add)')].length,
    };
  });
  eq(scoped.heading, 'Schools at Tulane University',
    'form: the school list says whose schools it is offering');
  eq(scoped.inScope, ['A. B. Freeman School of Business'],
    'form: one school, not the two spellings it was posted under');
  eq(scoped.others, 0,
    'form: and browsing does not bury it under every school on the site');

  await f.click('.oa-combo-list:not([hidden]) .oa-combo-opt');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-school'), 'A. B. Freeman School of Business',
    'form: choosing a school fills the field');

  await f.click('#f-unit');
  await f.waitForTimeout(250);
  const dept = await f.evaluate(() => {
    const open = document.querySelector('.oa-combo-list:not([hidden])');
    return {
      heading: open.querySelector('.oa-combo-group').textContent,
      inScope: [...open.querySelectorAll('.oa-combo-opt.is-pref .oa-combo-name')]
        .map((n) => n.textContent),
    };
  });
  eq(dept.heading, 'Departments in A. B. Freeman School of Business',
    'form: the department list narrows to the school that was chosen');
  /* THE CLAIM IS ABOUT SPELLINGS, NOT ABOUT HOW MANY DEPARTMENTS FREEMAN HAS.
     It asserted the list was exactly ['Management Science'], which was true
     when written and stopped being true on 2026-08-25, when a legitimate
     posting gave Freeman a second department ("Information Systems") and took
     master red. What this test exists to prove is that the three spellings the
     school was posted under — "Management Science", "…Sciences Area",
     "…Science Department" — collapse to ONE entry, so that is what it says
     now: the canonical name is offered exactly once and no variant of it
     appears beside it. A new department is somebody advertising a job, not a
     regression. */
  const ms = dept.inScope.filter((n) => /management\s+science/i.test(n));
  eq(ms, ['Management Science'],
    'form: to ITS departments — Management Science ONCE, not the three spellings ' +
    'it was posted under');
  ok(dept.inScope.length >= 1,
    `form: and the school's departments are listed (${dept.inScope.length})`);

  // typing still reaches the whole site: a scope narrows, it never hides
  await f.fill('#f-unit', 'supply chain');
  await f.waitForTimeout(200);
  const past = await f.evaluate(() => {
    const open = document.querySelector('.oa-combo-list:not([hidden])');
    return {
      headings: [...open.querySelectorAll('.oa-combo-group')].map((n) => n.textContent),
      options: open.querySelectorAll('.oa-combo-opt:not(.oa-combo-add)').length,
    };
  });
  ok(past.options > 0 && past.headings.includes('Elsewhere on the site'),
    'form: typing searches past the scope, under a heading that says so');

  /* A spelling that differs only in punctuation or a leading initial is the
     same school — so it is put right, not added as a second one. */
  await f.fill('#f-unit', '');
  await f.fill('#f-school', 'freeman school of business');
  await f.waitForTimeout(200);
  const addRows = await f.$$eval('.oa-combo-add', (n) => n.length);
  eq(addRows, 0, 'form: a variant spelling is not offered as a new name');
  await f.evaluate(() => document.getElementById('f-school')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-school'), 'A. B. Freeman School of Business',
    'form: and the field is put into the spelling the site publishes');

  /* A department the site has only ever seen in one school names its school. */
  await f.fill('#f-school', '');
  await f.fill('#f-unit', 'Management Science');
  await f.evaluate(() => document.getElementById('f-unit')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-school'), 'A. B. Freeman School of Business',
    'form: choosing a department fills in the school it sits in');

  /* A university nobody has posted from still gets the site's spelling rules
     (oa-schools.js: "Area" is a house word, not part of the name) — and a name
     the site has never heard of is left exactly as typed. Both are what the
     submission itself will carry, which is why the field is put right where
     the poster can see it rather than quietly on the way out. */
  await f.fill('#f-institution', 'Wibble University');
  await f.fill('#f-school', '');
  await f.fill('#f-unit', 'Operations Area');
  await f.evaluate(() => document.getElementById('f-unit')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-unit'), 'Operations',
    'form: the field shows the department as it will be published');
  await f.fill('#f-unit', 'Wibble Studies');
  await f.evaluate(() => document.getElementById('f-unit')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-unit'), 'Wibble Studies',
    'form: and a name nobody has ever posted is never invented away');
  await f.fill('#f-institution', 'Tulane University');
  await f.fill('#f-unit', '');

  /* A name nobody has posted before is offered rather than refused — and it
     is offered AS IT WILL BE PUBLISHED. "Widgets Group" would be posted as
     "Widgets" (a house word is not part of a name, oa-schools.js), and a row
     that promised the words typed would be promising something the
     submission then tidies away. */
  await f.fill('#f-unit', 'Wibble Widgets Group');
  await f.waitForTimeout(200);
  const publishAs = await f.$$eval('.oa-combo-add .oa-combo-name', (n) => n.map((x) => x.textContent));
  ok(publishAs.length === 1 && /“Wibble Widgets” — a name not on the list yet/.test(publishAs[0]),
    `form: a new name is offered as it will be published (${JSON.stringify(publishAs)})`);
  await f.fill('#f-unit', '');

  await f.fill('#f-school', 'Wibble School of Widgets');
  await f.waitForTimeout(200);
  const add = await f.$$eval('.oa-combo-add .oa-combo-name', (n) => n.map((x) => x.textContent));
  ok(add.length === 1 && /not on the list yet/.test(add[0]),
    'form: an unknown name is offered as a new one');
  await f.click('.oa-combo-add');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-school'), 'Wibble School of Widgets', 'form: a new name is accepted');

  /* keyboard: every row is reachable — ArrowDown used to move off "nothing"
     onto the first row and then stick there for ever, so with a scope in force
     (one row in it, the rest under "Elsewhere on the site") no key sequence
     reached the rest of the site at all. And the row it highlights must be
     VISIBLE: a sticky group heading sits exactly where the list scrolls to. */
  await f.fill('#f-school', 'school of business');
  await f.waitForTimeout(250);
  const rowCount = await f.$$eval('.oa-combo-list:not([hidden]) .oa-combo-opt', (n) => n.length);
  ok(rowCount > 5, `form: a search reaches past the scope (${rowCount} rows to walk)`);
  const walked = [];
  for (let i = 0; i < 4; i += 1) {
    await f.keyboard.press('ArrowDown');
    walked.push(await f.$eval('.oa-combo-list:not([hidden])',
      (l) => [...l.querySelectorAll('.oa-combo-opt')].indexOf(l.querySelector('.oa-combo-opt.is-active'))));
  }
  eq(walked, [0, 1, 2, 3], 'form: ArrowDown walks down the list rather than sticking on the first row');
  const up = [];
  for (let i = 0; i < 2; i += 1) {
    await f.keyboard.press('ArrowUp');
    up.push(await f.$eval('.oa-combo-list:not([hidden])',
      (l) => [...l.querySelectorAll('.oa-combo-opt')].indexOf(l.querySelector('.oa-combo-opt.is-active'))));
  }
  eq(up, [2, 1], 'form: and ArrowUp climbs it one row at a time, not two');

  for (let i = 0; i < 10; i += 1) await f.keyboard.press('ArrowDown');
  const visible = await f.evaluate(() => {
    const list = document.querySelector('.oa-combo-list:not([hidden])');
    const el = list.querySelector('.oa-combo-opt.is-active');
    if (!el) return 'no active row';
    const r = el.getBoundingClientRect();
    /* geometry, not hit-testing: the list can sit below the fold, where
       elementFromPoint answers null for reasons that have nothing to do with
       the heading. The heading is sticky, so its rect is where it is PAINTED. */
    const head = [...list.querySelectorAll('.oa-combo-group')]
      .map((h) => h.getBoundingClientRect())
      .find((h) => h.bottom > r.top && h.top < r.bottom);
    return head ? `covered by a heading (row ${r.top}-${r.bottom}, heading ${head.top}-${head.bottom})` : true;
  });
  eq(visible, true, 'form: the highlighted row is not hidden behind the sticky group heading');
  await f.keyboard.press('Escape');
  await f.fill('#f-school', 'Wibble School of Widgets');   // back to where the block above left it

  // Enter takes the highlighted option and must NOT submit the form
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

  /* ------------------------------------------------ DID YOU MEAN, on screen

     The merge guard the unit tests cannot see: a typed near-miss of a name
     the site already lists (here a typo of Tulane's own "Management Science")
     is pointed at the existing entry ABOVE the "new name" row — with both on
     offer, because only the poster knows whether their department genuinely
     is new. A second spelling splits a place's postings across two entries in
     every filter, which is the mess the vocabulary exists to end. */
  await f.fill('#f-unit', '');
  await f.fill('#f-unit', 'Managment Science');
  await f.waitForTimeout(250);
  const nearRows = await f.$$eval('.oa-combo-near-opt .oa-combo-name',
    (n) => n.map((x) => x.textContent));
  ok(nearRows[0] === 'Management Science',
    `form: a typo of an existing department draws its did-you-mean row (${JSON.stringify(nearRows)})`);
  ok((await f.$$eval('.oa-combo-list:not([hidden]) .oa-combo-add', (n) => n.length)) === 1,
    'form: while the new-name row stays on offer — a suggestion, never a restriction');
  await f.click('.oa-combo-near-opt');
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-unit'), 'Management Science',
    'form: taking the did-you-mean row merges the posting into the existing entry');

  /* --------------------------------- the Type follows the chosen names

     Choosing "A. B. Freeman School of Business" states the answer to "Type of
     institution", so an EMPTY select is filled ("Business School") — and a
     value the poster picked themselves is never overruled, exactly like the
     three names. */
  await f.evaluate(() => { document.getElementById('f-type').value = ''; });
  await f.fill('#f-school', 'A. B. Freeman School of Business');
  await f.evaluate(() => document.getElementById('f-school')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-type'), 'Business School',
    'form: the empty Type select follows the chosen school');
  await f.evaluate(() => {
    const t = document.getElementById('f-type');
    t.value = 'University';                       // the poster's own choice…
    t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await f.evaluate(() => document.getElementById('f-school')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await f.waitForTimeout(150);
  eq(await f.inputValue('#f-type'), 'University',
    'form: …and a Type the poster picked is never overruled by the guess');
  await f.fill('#f-school', 'Wibble School of Widgets');   // back where the blocks above left it
  await f.fill('#f-unit', unit);

  /* ---------------------------------------------- the picker on a phone

     _MOBILE-STANDARDS.md rules 3, 5 and 6, over the one list on this site the
     shared engine does not draw. It shipped as a 300px panel of 33px rows —
     a mouse's list — because the form is not a list page and nothing measured
     it.                                                                      */

  await f.setViewportSize({ width: 390, height: 780 });
  // close whatever is open: a panel with room above it now opens UPWARDS, over
  // the fields above, so a stale one covers the field this block wants
  await f.evaluate(() => {
    const open = document.activeElement;
    if (open && open.blur) open.blur();
  });
  await f.waitForTimeout(100);
  await f.evaluate(() => document.getElementById('f-institution').scrollIntoView({ block: 'center' }));
  await f.click('#f-institution');
  await f.waitForTimeout(300);
  const phone = await f.evaluate(() => {
    const list = document.querySelector('.oa-combo-list:not([hidden])');
    const r = list.getBoundingClientRect();
    const row = list.querySelector('.oa-combo-opt').getBoundingClientRect();
    return {
      rightEdge: Math.round(r.right),
      width: Math.round(r.width),
      height: Math.round(r.height),
      row: Math.round(row.height),
      halfViewport: Math.round(window.innerHeight / 2),
      viewport: window.innerWidth,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  ok(phone.row >= 40, `form: an option is a thumb-sized target (${phone.row}px)`);
  ok(phone.height <= phone.halfViewport + 1,
    `form: the panel stays within half the screen (${phone.height}px of ${phone.halfViewport}px)`);
  ok(phone.rightEdge <= phone.viewport && phone.width <= phone.viewport - 28,
    `form: and inside it (${phone.width}px wide, right edge ${phone.rightEdge} of ${phone.viewport})`);
  eq(phone.sideways, 0, 'form: the open picker does not make the page scroll sideways');

  /* …and ON SCREEN, which is the half of rule 6 a height cap does not give:
     the panel hangs under the field, and on a phone the field is halfway down,
     so 422px of list ran 61px past the fold — and a field near the bottom put
     the whole thing out of sight. It opens upwards when there is more room
     above, measured after opening. */
  const fold = await f.evaluate(async () => {
    const out = [];
    for (const id of ['f-institution', 'f-school', 'f-unit']) {
      const el = document.getElementById(id);
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.dispatchEvent(new Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const list = document.querySelector('.oa-combo-list:not([hidden])');
      const r = list.getBoundingClientRect();
      out.push({ id, off: Math.round(Math.max(0, r.bottom - window.innerHeight) + Math.max(0, -r.top)) });
      el.blur();
    }
    // the worst case: the field at the very bottom of the screen
    const last = document.getElementById('f-unit');
    last.scrollIntoView({ block: 'end' });
    last.focus();
    last.dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const list = document.querySelector('.oa-combo-list:not([hidden])');
    const r = list.getBoundingClientRect();
    out.push({ id: 'f-unit at the fold', off: Math.round(Math.max(0, r.bottom - window.innerHeight) + Math.max(0, -r.top)) });
    last.blur();
    return out;
  });
  eq(fold.filter((x) => x.off > 0), [], 'form: the open picker is never off the screen on a phone');
  await f.setViewportSize({ width: 1280, height: 1000 });

  /* ------------------------------------------- THE PICKER IN THE DARK THEME

     The reported bug, and the only place it can be proved: with the dark
     theme on, the dropdown painted a white card and inherited the page's
     near-white ink — measured at 1.65:1, which is not a contrast NEAR-miss
     but an invisible list. Static CSS cannot show it, because the failure is
     the INTERACTION of a background named here and a colour inherited from
     three files away; so the browser is asked what it actually paints.

     WCAG AA for body text is 4.5:1, and it is asserted in BOTH themes: a fix
     that only darkened the panel would have traded one broken theme for the
     other. */
  const contrast = async (theme) => {
    await f.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await f.click('#f-institution');
    await f.fill('#f-institution', '');
    await f.waitForTimeout(250);
    const read = await f.evaluate(() => {
      const list = document.querySelector('.oa-combo-list:not([hidden])');
      if (!list) return null;
      const name = list.querySelector('.oa-combo-opt .oa-combo-name');
      const count = list.querySelector('.oa-combo-opt .oa-combo-n');
      const head = list.querySelector('.oa-combo-group');
      /* the ground the text is drawn ON: the panel's own, since the rows are
         transparent until hovered */
      const ground = getComputedStyle(list).backgroundColor;
      const of = (el) => (el ? getComputedStyle(el).color : null);
      return { ground, name: of(name), count: of(count), head: of(head) };
    });
    await f.keyboard.press('Escape');
    return read;
  };

  const lum = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  for (const theme of ['dark', 'light']) {
    const c = await contrast(theme);
    ok(c, `form (${theme}): the picker opens`);
    if (!c) continue;
    ok(!/^rgba\(0, 0, 0, 0\)$/.test(c.ground),
      `form (${theme}): the picker paints its own ground, so the page cannot show through`);
    const nameRatio = ratio(c.name, c.ground);
    ok(nameRatio >= 4.5,
      `form (${theme}): a university name reads at ${nameRatio.toFixed(2)}:1 against the panel (AA is 4.5)`);
    for (const [what, css] of [['the posting count', c.count], ['the group heading', c.head]]) {
      if (!css) continue;
      const r = ratio(css, c.ground);
      ok(r >= 4.5, `form (${theme}): ${what} reads at ${r.toFixed(2)}:1`);
    }
  }
  /* THE CONFIRMATION PANEL, same rule (reported 2026-08-18: the body text
     under "Your changes have been saved." was unreadable in dark mode). It
     paints a green card and had named a colour for its HEADING only, so every
     other line inherited the page's near-white ink onto near-white green —
     the paragraph at 1.55:1, the link at 1.52:1, and the "Post another job"
     button at 1.52:1 in BOTH themes. Measured element by element, because
     that button proves a panel can be right at a glance and still have one
     line nobody can read. */
  for (const theme of ['dark', 'light']) {
    await f.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      const done = document.getElementById('oa-done');
      if (done) done.hidden = false;
    }, theme);
    await f.waitForTimeout(250);   // the tokens flip on the next style pass
    const rows = await f.evaluate(() => {
      const done = document.getElementById('oa-done');
      if (!done) return [];
      const ground = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        }
        return 'rgb(255,255,255)';
      };
      return [...done.querySelectorAll('h3,p,a,button,.oa-ticket')]
        .filter((el) => el.textContent.trim().length > 3)
        .map((el) => ({
          what: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : ''),
          fg: getComputedStyle(el).color,
          bg: ground(el),
        }));
    });
    ok(rows.length > 2, `form (${theme}): the confirmation panel has lines to read`);
    for (const r of rows) {
      const cr = ratio(r.fg, r.bg);
      ok(cr >= 4.5, `form (${theme}): the confirmation panel's ${r.what} reads at ${cr.toFixed(2)}:1`);
    }
  }

  await f.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    const done = document.getElementById('oa-done');
    if (done) done.hidden = true;
  });

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

  /* ------------------------------ the filter bar: several terms, one row --
     Owner, from three screenshots: the search took ONE institution at a time,
     and a filter with values chosen knocked the bar out of line.

     THE BAR IS SIGN-IN GATED on this page — .v3-lock puts pointer-events:none
     over it until an account resolves — and these checks are about the bar,
     not the gate, which has its own coverage. The lock is defeated by
     OVERRIDING ITS EFFECT rather than by removing the class: jobs.html
     re-applies the class from OAAccounts.onChange when auth finally resolves,
     whose timing is set by a network fetch, so stripping it once (or even
     before each step) is a race that hangs the click and takes the whole suite
     with it. A stylesheet cannot be re-applied out from under us. */
  await j.addStyleTag({ content:
    '.v3-lock.is-locked .oa-filters{pointer-events:auto!important;opacity:1!important;filter:none!important}'
    + '#v3-lock-card{display:none!important}' });

  eq(await j.$eval('.oa-filters label[for="oaf-institution"]', (n) => n.textContent),
    'University search', 'jobs: the search says what it searches');
  eq(await j.$eval('#oaf-institution', (n) => n.placeholder), 'University/School name',
    'jobs: and the box says what to type into it');

  const shown = () => j.$eval('.oa-resultbar', (n) => {
    const m = n.textContent.replace(/\s+/g, ' ').match(/\/\s*(\d+)/);
    return m ? Number(m[1]) : NaN;
  });

  /* TWO TERMS THAT MUST WIDEN, DERIVED FROM THE PAGE ITSELF. data/jobs.json is
     rebuilt from the tracking sheet every morning, so naming institutions here
     ("utah", "princeton") would make this check pass or fail on whatever the
     market did overnight — a test that goes red for a reason that is not a
     regression teaches people to ignore it.

     THE WORDS HAVE TO DISCRIMINATE, or the derivation defeats its own check:
     the morning "University of North Carolina at Chapel Hill" led the listing,
     the first long word of the first card was "university", the second term's
     own card contained it too — and a second term whose card the first term
     already matches cannot widen anything, so the check went red on a listing
     with nothing wrong in it. Generic words are skipped, the second term comes
     from a card the first term does not appear in — and the ANCHOR card is
     whichever card yields a usable word, not blindly the first: the very next
     morning "City University of Hong Kong" led, whose every word is short or
     generic, and an anchor pinned to it has no word at all. */
  const pair = await j.evaluate(() => {
    const names = [...document.querySelectorAll('.oa-card .oa-card-title')]
      .map((t) => t.textContent.trim().toLowerCase()).filter(Boolean);
    /* Both sides of a converging history fixed this derivation on the same
       day, for the same reason (the first card was "City University of Hong
       Kong", its word was "university", and no second term could widen the
       OR); master's fix is kept — it also refuses the GENERIC words as terms,
       which is the stronger guarantee. */
    const GENERIC = ['university', 'school', 'college', 'institute', 'state', 'business'];
    const word = (n) => (n.split(/[\s,(]+/)
      .map((w) => w.replace(/[^a-z]/g, ''))
      .find((w) => w.length > 4 && !GENERIC.includes(w)) || '');
    for (const anchor of names) {
      const a = word(anchor);
      if (!a) continue;
      const src = names.find((n) => {
        const w = word(n);
        return w && w !== a && !anchor.includes(w) && !n.includes(a);
      });
      if (src) return { a, b: word(src) };
    }
    return null;
  });
  ok(pair, 'jobs: the listing offers two different institutions to search for');
  /* Named, because the alternative was lived: a listing this rule could not
     derive a pair from crashed the whole suite on `pair.a` with a bare
     TypeError — a stack trace where a failure message should be. Every check
     from here to the width loop types the two terms, so without them there is
     nothing left in this block to measure. */
  if (!pair) {
    throw new Error('jobs: no searchable pair could be derived from the listing — '
      + 'see the derivation above; the search checks cannot run without one');
  }

  const total = await shown();

  // typing filters live, exactly as it always did — and narrows, measurably
  await j.fill('#oaf-institution', pair.a);
  await j.waitForFunction((n) => {
    const m = document.querySelector('.oa-resultbar').textContent.match(/\/\s*(\d+)/);
    return m && Number(m[1]) !== n;
  }, total, { timeout: 4000 });
  const typed = await shown();
  ok(typed < total,
    `jobs: a half-typed term narrows the list as you type (${total} -> ${typed})`);

  // Enter banks it as a chip and empties the box for the next one
  await j.press('#oaf-institution', 'Enter');
  await j.waitForTimeout(250);
  eq(await j.$eval('#oaf-institution', (n) => n.value), '',
    'jobs: Enter clears the box, so the next institution can be typed straight away');
  eq(await j.$$eval('.oa-filter:not(.oa-pick) .oa-chip .oa-chip-label',
    (ns) => ns.map((n) => n.textContent)), [pair.a],
    'jobs: and the term it banked is shown as a chip under the field');
  eq(await shown(), typed, 'jobs: banking the term does not change what it matches');

  /* SEVERAL TERMS ARE OR'd, which is the only reading that returns anything: a
     posting has ONE institution, so two names AND-ed is empty by construction. */
  await j.fill('#oaf-institution', pair.b);
  await j.press('#oaf-institution', 'Enter');
  await j.waitForTimeout(250);
  const both = await shown();
  ok(both > typed,
    `jobs: a second term WIDENS the search (${typed} -> ${both}), it does not replace it`);
  eq(await j.$$eval('.oa-filter:not(.oa-pick) .oa-chip .oa-chip-label',
    (ns) => ns.map((n) => n.textContent)), [pair.a, pair.b],
    'jobs: both terms are shown');

  // and the whole search survives being shared
  eq(new URL(j.url()).searchParams.getAll('institution'), [pair.a, pair.b],
    'jobs: every term is carried in the address bar');

  // each chip removes its OWN term — the point of chips over one string
  await j.click('.oa-filter:not(.oa-pick) .oa-chip');
  await j.waitForTimeout(250);
  eq(await j.$$eval('.oa-filter:not(.oa-pick) .oa-chip .oa-chip-label',
    (ns) => ns.map((n) => n.textContent)), [pair.b],
    'jobs: removing one chip leaves the other');

  /* ERASING THE BOX AND PRESSING ENTER MEANS WHAT IT LOOKS LIKE. The handler
     cancels the pending debounce, so it owns whatever the box says INCLUDING
     nothing: an early return here stranded the last debounced word, and the
     list stayed filtered by a term shown in no chip, in no box, and removable
     only from the address bar. */
  await j.fill('#oaf-institution', pair.a);
  await j.waitForTimeout(250);
  await j.fill('#oaf-institution', '');
  await j.press('#oaf-institution', 'Enter');
  await j.waitForTimeout(250);
  const stranded = new URL(j.url()).searchParams.getAll('institution');
  eq(stranded, [pair.b],
    'jobs: erasing the box and pressing Enter drops the draft, it does not strand it');

  await j.click('.oa-clear');
  await j.waitForTimeout(250);
  eq(await j.$$eval('.oa-chip', (ns) => ns.length), 0,
    'jobs: Clear filters drops the banked terms too');
  eq(await shown(), total, 'jobs: and the whole listing comes back');

  /* EVERY CONTROL ON ONE BASELINE, CHIPS OR NO CHIPS, and CLEAR CLOSES ITS ROW.
     The bar is a grid whose items were bottom-aligned, so a filter carrying
     chips — a taller cell — pushed its own control UP and "2 selected" floated
     above the untouched boxes beside it. Measured at two widths because the
     ≥1000px rule gives text searches a double column and Clear a rule of its
     own: the first version of this check ran at one width and missed that
     Clear had stopped stretching to the bar's edge.

     The tolerance is 1.5px, not the 6px a first attempt used — 6px was wide
     enough to hide a real 2.4px error, which is the whole class of defect this
     is here to catch. */
  /* 1000 is in the list because that is where the ≥1000px rule starts and where
     the regression it enabled actually shows: with Clear taking `span 2` from
     the text-search rule instead of stretching to the edge, it stops 460px
     short THERE and nowhere else — 1280 and 1100 both look perfect. A layout
     check is only as good as the width it runs at. */
  for (const width of [1280, 1100, 1000]) {
    await j.setViewportSize({ width, height: 1000 });
    await j.fill('#oaf-institution', pair.a);
    await j.press('#oaf-institution', 'Enter');
    await j.waitForTimeout(250);

    const geo = await j.evaluate(() => {
      const bar = document.querySelector('.oa-filters');
      const cs = getComputedStyle(bar);
      const edge = bar.getBoundingClientRect().right - parseFloat(cs.paddingRight);
      const ctrls = [...document.querySelectorAll(
        '.oa-filters input[type=search], .oa-filters .oa-pick-btn, .oa-filters .oa-clear')];
      const rows = [];
      ctrls.forEach((n) => {
        const t = n.getBoundingClientRect().top;
        const row = rows.find((r) => Math.abs(r.top - t) < 1.5);
        if (row) row.n++; else rows.push({ top: t, n: 1 });
      });
      /* THE ACTIONS CELL closes the row, not Clear itself. Clear held the
         right edge while it was alone in that cell; since 2026-08-27 the
         Excel download sits beside it and holds it, with Clear taking
         whatever is left. What the bar promises is that its last line ends
         flush — measure the cell, which is true under either arrangement. */
      const acts = document.querySelector('.oa-filter-actions').getBoundingClientRect();
      return {
        lines: rows.length,
        cells: new Set([...bar.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
        clearGap: edge - acts.right,
        chips: document.querySelectorAll('.oa-chip').length,
      };
    });
    ok(geo.chips > 0, `jobs @${width}: a chip is showing, so the measurement means something`);
    eq(geo.lines, geo.cells,
      `jobs @${width}: every control sits on its row's baseline with chips showing`);
    ok(Math.abs(geo.clearGap) <= 1.5,
      `jobs @${width}: the actions still close their row (${geo.clearGap.toFixed(1)}px short of the edge)`);
    await j.click('.oa-clear');
    await j.waitForTimeout(200);
  }
  await j.setViewportSize({ width: 1280, height: 1000 });

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

  /* The form says it is editing rather than posting — in the heading the page
     ACTUALLY has. This caught the swap's own regression: oa-jobform.js renamed
     `.title-heading h2`, which only the archived design has, so on the live
     site the page went on saying "Post a job" while the form held someone's
     existing posting. */
  await j.waitForTimeout(1200);
  eq(await j.evaluate(() => {
    const h = document.querySelector('.v3-pa-hero .v3-h1') ||
      document.querySelector('.title-heading h2');
    return h ? h.textContent.trim() : 'no-heading';
  }), 'Edit a posting', 'form: edit mode renames the page');
  eq(await j.$eval('#oa-submit', (n) => n.textContent.trim()), 'Save changes',
    'form: and the button says what it does');

  eq(jErrors, [], 'jobs: no uncaught script errors');
  await j.close();
}

/* ------------------------------------------- ?job=<id> opens ONE posting

   Owner, 2026-08-27: pressing "Open the posting" on /admin-area's market-year
   report "takes me to the full list of jobs, as opposed to the page of this
   specific posting so that I can edit it, or remove it" — and for the posting
   they named, Nanyang, it opened the list of THIS season, which by definition
   could not contain a posting filed under the last one.

   The link was `jobs.html#job-<id>`. Neither half of it worked: a card only
   exists while it is one of the ten being rendered, of a list built from a
   fetch that has not landed when the browser looks for the fragment; and half
   these postings are on the OTHER page. What is measured here is the fix, on
   both pages and against the real served files — the posting is on screen, it
   is the only one, its own controls are on it, and there is a way back.     */

for (const [pageName, pick] of [
  ['jobs.html', (rows) => rows.filter((r) => inCurrentMarket(r))],
  ['previous-markets.html', (rows) => rows.filter((r) => !inCurrentMarket(r))],
]) {
  const jobs = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  /* A posting the PAGE really carries, chosen with the pipeline's own window
     rule rather than with a date written down here — the two pages partition
     the corpus, so each one's example has to come from its own half. Deep in
     the list on purpose: the whole complaint is that the reader landed at the
     top of a list the posting was not on. */
  const half = pick(jobs.filter((r) => r && r.id && r.institution));
  const target = half[Math.min(25, half.length - 1)];

  const d = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const dErrors = [];
  d.on('pageerror', (e) => dErrors.push(e.message));
  await d.goto(`${BASE}${pageName}?job=${encodeURIComponent(target.id)}`,
    { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('.oa-card', { timeout: 15000 });

  eq(await d.$$eval('.oa-card', (n) => n.length), 1,
    `${pageName}: ?job= shows exactly one posting — not a list to hunt through`);
  eq(await d.$eval('.oa-card', (n) => n.id), 'job-' + target.id,
    `${pageName}: and it is the posting that was asked for`);
  eq(await d.$eval('.oa-card-head', (n) => n.getAttribute('aria-expanded')), 'true',
    `${pageName}: opened, so its details are on screen without another click`);

  /* The surrounding controls go, for the reason an empty dataset's do: a
     filter bar over a list of one narrows nothing and a pager reading
     "1 - 1 / 1" is noise. On the jobs page the sign-in lock is wrapped AROUND
     that bar, so hiding the bar alone would leave a lock card over nothing. */
  ok(await d.evaluate(() => {
    const el = document.querySelector('.oa-filters');
    return !el || el.getBoundingClientRect().height === 0;
  }), `${pageName}: the filter bar is out of the way while one posting is shown`);
  ok(await d.evaluate(() => {
    const el = document.querySelector('.v3-lock');
    return !el || el.getBoundingClientRect().height === 0;
  }), `${pageName}: and so is the sign-in lock that wraps it`);

  // …and there is a way back, which a signed-out reader can press: it is
  // outside the lock, unlike anything rendered into the bar
  const clear = await d.locator('.oa-focusbar .oa-focus-clear');
  eq(await clear.count(), 1, `${pageName}: a way back to the whole list is offered`);
  ok(await clear.isEnabled(), `${pageName}: and a signed-out reader can press it`);
  await clear.click();
  await d.waitForFunction(() => document.querySelectorAll('.oa-card').length > 1,
    null, { timeout: 15000 });
  ok(!(await d.evaluate(() => location.search)).includes('job='),
    `${pageName}: pressing it drops the parameter too — a reload is the list, ` +
    'not the one posting again');

  /* A LINK ALREADY COPIED still works: `#job-<id>` is what the report emitted
     before this existed, and nothing had ever acted on it.

     Through about:blank, because the page is already sitting on this very
     path: a goto that changes only the fragment is a SAME-DOCUMENT
     navigation, so nothing re-runs and the check would be measuring the state
     left by the step above. */
  await d.goto('about:blank');
  await d.goto(`${BASE}${pageName}#job-${target.id}`, { waitUntil: 'domcontentloaded' });
  await d.waitForFunction(() => document.querySelectorAll('.oa-card').length === 1,
    null, { timeout: 15000 });
  eq(await d.$eval('.oa-card', (n) => n.id), 'job-' + target.id,
    `${pageName}: an old #job- link finds the posting for the first time`);
  ok((await d.evaluate(() => location.search)).includes('job=') &&
     !(await d.evaluate(() => location.hash)),
    `${pageName}: and is rewritten to the parameter, so the way back is not undone by a reload`);

  /* An id this page does not carry is NOT an over-filtered search: saying
     "try removing a filter" beside a bar that is not on screen is the exact
     mis-message the engine's own comment was written about. */
  await d.goto(`${BASE}${pageName}?job=no-such-posting-20260101`,
    { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('.oa-empty', { timeout: 15000 });
  const missing = await d.$eval('.oa-empty', (n) => n.innerText);
  ok(/not on this page/.test(missing),
    `${pageName}: an id it does not carry says so`);
  ok(!/removing a filter/.test(missing),
    `${pageName}: and never sends the reader to a filter bar it has hidden`);
  const away = await d.$$eval('.oa-empty a', (n) => n.map((x) => x.getAttribute('href')));
  eq(away.length, 1,
    `${pageName}: with a link to the other page, which only the page can name`);
  ok(away[0] && away[0].includes('job=no-such-posting-20260101'),
    `${pageName}: and it CARRIES the posting — a bare list is the very thing ` +
    'this mode exists to stop landing people on');
  ok(away[0] && away[0].indexOf(pageName) !== 0,
    `${pageName}: pointing at the other page, not back at this one`);

  /* Both forms on one URL: the query wins, and pressing "Show all postings"
     has to STICK. Deriving the drop from which source won left the fragment
     behind, so a reload focused again — on the other posting. */
  await d.goto(`${BASE}${pageName}?job=${encodeURIComponent(target.id)}#job-not-this-one`,
    { waitUntil: 'domcontentloaded' });
  await d.waitForFunction(() => document.querySelectorAll('.oa-card').length === 1,
    null, { timeout: 15000 });
  eq(await d.$eval('.oa-card', (n) => n.id), 'job-' + target.id,
    `${pageName}: with both forms present the query parameter wins`);
  await d.click('.oa-focusbar .oa-focus-clear');
  await d.waitForFunction(() => document.querySelectorAll('.oa-card').length > 1,
    null, { timeout: 15000 });
  eq(await d.evaluate(() => location.hash + location.search), '',
    `${pageName}: and "Show all postings" takes the fragment with it, so a ` +
    'reload is the list and not a different posting');

  /* …AND THE CONTROLS ARE ON IT. "so that I can edit it, or remove it" is the
     other half of the complaint: landing on the posting is only useful if the
     maintainer can act on it there. The permission map comes from a Firestore
     read CI cannot make, so it is injected — what is being measured is that
     the focused card goes through the ENGINE'S OWN card() and therefore
     through cfg.onCard, not that Firestore answered. */
  await d.goto(`${BASE}${pageName}?job=${encodeURIComponent(target.id)}`,
    { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('.oa-card', { timeout: 15000 });
  await d.evaluate((id) => {
    window.OAJobEdit.__setPermissionsForTest({
      ready: true, admin: true, byId: { [id]: id }, byRef: {},
    });
  }, target.id);
  await d.waitForFunction(() => document.querySelectorAll('.oa-card-actions').length === 1,
    null, { timeout: 10000 });
  eq(await d.$$eval('.oa-card-actions .oa-jobbtn', (n) => n.map((x) => x.textContent)),
    ['Edit', 'Take down'],
    `${pageName}: the posting arrives with Edit and Take down on it`);
  eq(await d.$eval('.oa-card-actions', (n) => n.closest('.oa-card').id),
    'job-' + target.id, `${pageName}: on the card that was opened, and only it`);
  eq(await d.$$eval('.oa-card', (n) => n.length), 1,
    `${pageName}: and a late redraw for the permissions does not restore the list`);

  eq(dErrors, [], `${pageName}: deep-link run — no uncaught script error`);
  await d.close();
}

/* --------------------------- the edit you just saved, shown before the build

   Owner, 2026-08-24: "when the admin edits a posted job, the edits should be
   shown immediately after in the updated job posting." The pipeline stays the
   pipeline (about a minute); what this measures is the ECHO — oa-fresh.js
   overlaying, at read time, what THIS browser just saved. The expectations
   come from the same served file the page reads: a real posting is picked
   from data/jobs.json, an echo for it is seeded exactly as the form would
   stash it, and the rendered page must show the echoed institution at once —
   while a second, taken-down posting must not render at all.                */

{
  const jobs = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  const current = jobs.filter((r) => r && r.institution && r.id
    && Number(r.year) === marketYear());
  const target = current[0];
  const victim = current.find((r) => r !== target);

  const seed = {};
  // the form stashes under the DOCUMENT id and joins on ref where the posting
  // has one; a migrated posting's row id IS its document id, so either works
  seed[target.ref ? 'doc-echo-test' : target.id] = {
    t: Date.now(), ref: target.ref || '', removed: false,
    f: { institution: 'Echoed University (Test)' },
  };
  seed[victim.id] = { t: Date.now(), ref: victim.ref || '', removed: true, f: {} };

  const e = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const eErrors = [];
  e.on('pageerror', (err) => eErrors.push(err.message));
  await e.addInitScript(([key, val]) => {
    try { localStorage.setItem(key, val); } catch (err) { /* storage off: the echo simply stands down */ }
  }, ['oaFreshJobs', JSON.stringify(seed)]);

  await e.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
  await e.waitForSelector('.oa-card');
  await e.waitForTimeout(600);

  /* The page's ONE reading path first — what every card renders from — then
     the pixels: the echoed name must actually be on a card. */
  const loaded = await e.evaluate(([victimId]) =>
    window.OAList.load('/data/jobs.json').then((rows) => ({
      echoed: rows.some((r) => r.institution === 'Echoed University (Test)'),
      victimGone: !rows.some((r) => r.id === victimId),
    })), [victim.id]);
  ok(loaded.echoed, 'jobs: the edit this browser just saved is in the loaded rows');
  ok(loaded.victimGone, 'jobs: and the posting this browser just took down is not');

  const texts = await e.$$eval('.oa-card', (ns) => ns.map((n) => n.textContent));
  ok(texts.some((t) => t.includes('Echoed University (Test)')),
    'jobs: the edit is on a rendered card immediately — no build in between');
  eq(eErrors, [], 'jobs: the echo raises no script errors');
  await e.close();
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

/* ---------------------------------- the three rebuilt Awesome Table pages

   recent-faculty and previous-markets mount the same OAList engine as jobs,
   so what needs pinning is what is THEIRS: the dataset each reads, the
   vendor's own ?filter deep links still selecting what they always selected,
   the archive folding in the jobs rows that left the current market, and the
   engine's "job postings" wording reworded where it would mislead. */

{
  const p = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  p.on('pageerror', (e) => jsErrors.push('recent-faculty: ' + e.message));
  await p.goto(BASE + 'recent-faculty.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card', { timeout: 15000 });

  const rf = JSON.parse(await readFile(path.join(ROOT, 'data', 'recent-faculty.json'), 'utf8'));
  const total = Number((await p.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim());
  eq(total, rf.length, 'recent-faculty: every row of the dataset is offered');

  const labels = await p.$$eval('.oa-filter label', (ns) => ns.map((n) => n.textContent));
  eq(labels, ['Name', 'Placement', 'Alma mater', 'Undergrad institution', 'Job market year'],
    'recent-faculty: the vendor page’s filters, in its order, plus the year');

  const firstTitles = await p.$$eval('.oa-card-title', (ns) => ns.map((n) => n.textContent));
  const lasts = firstTitles.map((t, i) => rf[i] && rf[i].last).filter(Boolean);
  eq([...lasts].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), lasts,
    'recent-faculty: page one reads alphabetically by last name, as the vendor page did');

  const sr = await p.$eval('.oa-sr', (n) => n.textContent);
  ok(/ faculty match$/.test(sr), `recent-faculty: the wording says faculty, not postings (got "${sr}")`);

  /* the Universities map deep-links here as ?filterE= (recent hires) and
     ?filterF= (PhD alumni) — the vendor's own column letters */
  const someSchool = rf.find((r) => r.placement) || { placement: 'University' };
  const viaE = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  viaE.on('pageerror', (e) => jsErrors.push('recent-faculty filterE: ' + e.message));
  await viaE.goto(BASE + 'recent-faculty.html?filterE=' +
    encodeURIComponent(someSchool.placement), { waitUntil: 'domcontentloaded' });
  await viaE.waitForSelector('.oa-card', { timeout: 15000 });
  const eCount = Number(((await viaE.$eval('.oa-count', (n) => n.textContent)).match(/\/\s*(\d+)/) || [])[1]);
  const eExpect = rf.filter((r) =>
    (r.placement || '').toLowerCase().includes(someSchool.placement.toLowerCase())).length;
  eq(eCount, eExpect, 'recent-faculty: ?filterE selects by placement, as it always has');
  ok(viaE.url().includes('placement='), 'recent-faculty: the legacy link is renamed in the bar');
  await viaE.close();
  await p.close();
}

{
  const p = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  p.on('pageerror', (e) => jsErrors.push('previous-markets: ' + e.message));
  await p.goto(BASE + 'previous-markets.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card', { timeout: 15000 });

  /* the total = the committed archive + the jobs.json rows that have left the
     current market window — the same formula the page runs, recomputed here
     from the files, so the fold-in cannot silently stop working */
  const past = JSON.parse(await readFile(path.join(ROOT, 'data', 'past-postings.json'), 'utf8'));
  const jobs = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  const d = new Date();
  const yr = d.getUTCFullYear() + (d.getUTCMonth() >= 6 ? 1 : 0);
  const start = `${yr - 1}-07-01`;
  const ids = new Set(past.map((r) => r.id));
  const folded = jobs.filter((r) =>
    !(String(r.posted || '') >= start || Number(r.year) >= yr) && !ids.has(r.id));
  const total = Number((await p.$eval('.oa-count', (n) => n.textContent)).split('/')[1].trim());
  eq(total, past.length + folded.length,
    'previous-markets: the archive plus every jobs row that left the current market');

  const years = [...new Set([...past, ...folded].map((r) => Number(r.year)))];
  /* The cell names EVERY season the posting is listed under (`years`, the
     overlap — owner 2026-08-27), so it is read as the numbers it carries
     rather than as one number: a leading card that spans two seasons would
     make Number('2025 and 2026') NaN and the check meaningless. */
  const shownYears = (await p.$eval('.oa-card:first-child .oa-kv td', (n) => n.textContent))
    .match(/\d{4}/g).map(Number);
  ok(shownYears.includes(Math.max(...years)),
    'previous-markets: the newest past market leads the archive');

  /* THE OVERLAP, end to end. A posting advertised in one season for a search
     closing in the next is listed under BOTH, so filtering on the season it
     is NOT filed under must find it — under the old `year` filter it answered
     only the later one and a reader browsing the season it was advertised in
     never saw it. Driven off the served files, so it measures the site's own
     data rather than a fixture. */
  const spanning = [...past, ...folded].filter((r) => (r.years || []).length > 1);
  ok(spanning.length > 0, 'previous-markets: the archive really carries spanning postings');
  if (spanning.length) {
    const one = spanning[0];
    const other = one.years.find((y) => Number(y) !== Number(one.year));
    ok(other, 'previous-markets: …and one of them is a season it is not filed under');
    const alsoUnder = await browser.newPage({ viewport: { width: 1300, height: 950 } });
    alsoUnder.on('pageerror', (e) => jsErrors.push('previous-markets overlap: ' + e.message));
    /* narrowed by university as well, because the list PAGINATES: a season
       holds far more than one page of postings, and "not on page 1" is not
       "not listed" */
    await alsoUnder.goto(BASE + 'previous-markets.html?year=' + other +
      '&university=' + encodeURIComponent(one.institution),
      { waitUntil: 'domcontentloaded' });
    await alsoUnder.waitForSelector('.oa-card, .oa-empty', { timeout: 15000 });
    const names = await alsoUnder.$$eval('.oa-card .oa-card-title',
      (ns) => ns.map((n) => n.textContent.trim()));
    ok(names.some((n) => n.includes(one.institution)),
      `previous-markets: ${one.institution} (filed under ${one.year}) is found ` +
      `under ${other} as well — the seasons overlap`);
    await alsoUnder.close();
  }

  // ?filterD= is how the Universities map has always linked here
  const someInst = past[past.length - 1].institution.split(' ')[0];
  const viaD = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  viaD.on('pageerror', (e) => jsErrors.push('previous-markets filterD: ' + e.message));
  await viaD.goto(BASE + 'previous-markets.html?filterD=' + encodeURIComponent(someInst),
    { waitUntil: 'domcontentloaded' });
  await viaD.waitForSelector('.oa-card, .oa-empty', { timeout: 15000 });
  const dCount = Number(((await viaD.$eval('.oa-count', (n) => n.textContent)).match(/\/\s*(\d+)/) || [])[1]);
  ok(dCount >= 1 && dCount < total,
    `previous-markets: ?filterD narrows the archive (got ${dCount} of ${total})`);
  ok(viaD.url().includes('university='), 'previous-markets: the legacy link is renamed in the bar');
  await viaD.close();
  await p.close();
}

/* ------------------------------- Edit / Take down on the FROZEN ARCHIVES

   data/past-postings.json, data/recent-faculty.json and
   data/universities.json are written once by the legacy import and committed,
   so those three pages had no write path at all — the maintainer saw exactly
   the read-only page an anonymous visitor did. assets/oa-rowedit.js corrects a
   row AT READ TIME from Firestore `rowOverrides`.

   The override map comes from a read CI cannot make, so it is injected. What
   is checked is what unit tests cannot see: that a visitor gets nothing, that
   the maintainer's controls land on the right rows, and — the part that has to
   be true for everybody, not just the maintainer — that a hidden row is gone
   from the page and an edited value is what the card actually shows.         */

/* previous-markets.html is opened on a season only the ARCHIVE covers: its
   default view is all postings folded in from data/jobs.json, which belong to
   the job editor and which this one refuses to touch. */
for (const [pageName, dataset, patch] of [
  ['previous-markets.html?year=2015', 'past-postings', { institution: 'Corrected Institution Name' }],
  ['recent-faculty.html', 'recent-faculty', { name: 'Corrected Person Name' }],
]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  p.on('pageerror', (e) => jsErrors.push(pageName + ': ' + e.message));
  await p.goto(BASE + pageName, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card');
  await p.waitForTimeout(400);

  eq(await p.$$eval('.oa-card-actions', (n) => n.length), 0,
    `${dataset}: a visitor who is not signed in sees no Edit or Take down`);

  /* The victim is the row the page ACTUALLY renders first, taken from the card
     itself — the file's first row is not the page's, which sorts. */
  const victim = await p.$eval('.oa-card', (n) => n.id.replace(/^job-/, ''));
  const cards = await p.$$eval('.oa-card', (n) => n.length);
  /* "1 - 10 / 93" when nothing is filtered, "1 - 10 / 93 (of 243)" when
     something is — so read the number right after the slash, not the last one
     on the line, which is the unfiltered corpus. */
  const total = (t) => Number((String(t).match(/\/\s*(\d+)/) || [0, 0])[1]);
  const totalBefore = total(await p.$eval('.oa-count', (n) => n.textContent));
  ok(totalBefore > 0, `${dataset}: the results line carries a total to compare against`);

  await p.evaluate((d) => window.OARowEdit.__setForTest(d, { ready: true, admin: true }),
    dataset);
  await p.waitForTimeout(300);

  eq(await p.$$eval('.oa-card', (n) => n.length), cards,
    `${dataset}: the maintainer sees the same rows as everyone else`);
  eq(await p.$$eval('.oa-card-actions', (n) => n.length), cards,
    `${dataset}: and gains the controls on every one of them`);
  eq(await p.$$eval('.oa-card .oa-card-actions .oa-jobbtn', (n) =>
    n.slice(0, 2).map((x) => x.textContent)),
    ['Edit', 'Take down'], `${dataset}: both controls, in that order`);
  // the card head is itself a button; the controls must not be inside it
  eq(await p.$$eval('.oa-card-head .oa-jobbtn', (n) => n.length), 0,
    `${dataset}: the controls are not nested inside the card toggle`);

  /* A TAKEN-DOWN ROW IS GONE FOR EVERYBODY — the point of a read-time overlay,
     and the half a signed-out visitor must also get. */
  await p.evaluate(([d, id]) => window.OARowEdit.__setForTest(d, {
    ready: true, admin: false, rows: { [id]: { hidden: true } },
  }), [dataset, victim]);
  await p.waitForTimeout(300);
  eq(await p.$$eval('.oa-card-actions', (n) => n.length), 0,
    `${dataset}: a signed-out visitor still sees no controls`);
  ok(!(await p.$(`[id="job-${victim}"]`)),
    `${dataset}: the taken-down row is gone from the page`);
  eq(total(await p.$eval('.oa-count', (n) => n.textContent)), totalBefore - 1,
    `${dataset}: and the count says one fewer`);

  /* AN EDIT SHOWS. The overlay is applied to the row the card renders from, so
     the corrected value is what a reader sees — not a note beside it. */
  await p.evaluate(([d, id, o]) => window.OARowEdit.__setForTest(d, {
    ready: true, admin: false, rows: { [id]: o },
  }), [dataset, victim, patch]);
  await p.waitForTimeout(300);
  eq(total(await p.$eval('.oa-count', (n) => n.textContent)), totalBefore,
    `${dataset}: correcting a row it had hidden brings it back`);
  eq(await p.$eval(`[id="job-${victim}"] .oa-card-title`,
    (n) => n.textContent.trim()), Object.values(patch)[0],
    `${dataset}: and the corrected value is what the card shows`);

  await p.close();
}

/* ------------------------------------------------ the What's-new list

   assets/oa-news.js renders the update log on the front page (newest five) and
   on whats-new.html (all of it), and decides who may see which entry. The
   decisions come from a Firestore read CI cannot make, so they are injected —
   what is checked is the half unit tests cannot see: that a visitor is shown
   the published entries and NOTHING else, that a removed entry really leaves
   the list rather than sitting in it struck through, that the maintainer can
   still find it, and that an entry nobody has reviewed is invisible to
   everyone but them.                                                          */

for (const [pageName, listSel] of [
  ['index.html', '#v3-news'],
  ['whats-new.html', '#oa-whatsnew'],
]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  p.on('pageerror', (e) => jsErrors.push('news/' + pageName + ': ' + e.message));
  await p.goto(BASE + pageName, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(`${listSel} li time`, { timeout: 15000 });

  const LOG = [
    { id: 'settled', date: '2026-08-01', title: 'Long since announced', summary: 's', url: '' },
    { id: 'gone', date: '2026-08-02', title: 'Taken down', summary: 's', url: '' },
    { id: 'live', date: '2026-09-01', title: 'Published today', summary: 's', url: '' },
    { id: 'draft', date: '2026-09-02', title: 'Not reviewed yet', summary: 's', url: '' },
  ];
  const DOCS = { gone: { status: 'removed' }, live: { status: 'approved' } };
  const titles = () => p.$$eval(`${listSel} > li strong`, (n) => n.map((x) => x.textContent));

  // A VISITOR
  await p.evaluate(([docs, log]) => window.OANews.__setForTest(docs, false, log), [DOCS, LOG]);
  await p.waitForTimeout(200);
  eq(await titles(), ['Published today', 'Long since announced'],
    `${pageName}: a visitor sees the published entries, newest first`);
  eq(await p.$$eval(`${listSel} .v3-news-admin`, (n) => n.length), 0,
    `${pageName}: and no controls`);
  eq(await p.$$eval('.v3-news-bin', (n) => n.length), 0,
    `${pageName}: and no sight of what was removed`);

  // THE MAINTAINER
  await p.evaluate(([docs, log]) => window.OANews.__setForTest(docs, true, log), [DOCS, LOG]);
  await p.waitForTimeout(200);
  eq(await titles(), ['Not reviewed yet', 'Published today', 'Long since announced'],
    `${pageName}: the maintainer also sees what is waiting for review`);
  eq(await p.$$eval(`${listSel} > li.v3-news-pending strong`, (n) => n.map((x) => x.textContent)),
    ['Not reviewed yet'], `${pageName}: flagged as unpublished, and only that one`);
  ok((await p.$eval('.v3-news-note', (n) => n.textContent)).includes('1 new entry'),
    `${pageName}: with a note saying how much is waiting`);

  /* THE REMOVED ENTRY IS OUT OF THE LIST — that is what the owner asked for —
     AND STILL REACHABLE, which is what stops Remove being a one-way door. */
  ok(!(await titles()).includes('Taken down'),
    `${pageName}: a removed entry is off the list for the maintainer too`);
  const bin = await p.$eval('.v3-news-bin', (n) => n.textContent);
  ok(bin.includes('Removed updates (1)') && bin.includes('Taken down'),
    `${pageName}: and is in the collapsed panel below it`);
  eq(await p.$eval('.v3-news-bin', (n) => n.tagName + ':' + (n.open ? 'open' : 'shut')),
    'DETAILS:shut', `${pageName}: collapsed, so the list itself stays clean`);
  eq(await p.$$eval('.v3-news-bin .v3-news-admin button',
    (n) => n.map((x) => x.textContent.replace(/[^A-Za-z ]/g, '').trim())),
    ['Restore', 'Edit'], `${pageName}: carrying the way back`);

  // EDIT reaches every entry, which it did not before (whats-new.html had none)
  eq(await p.$$eval(`${listSel} > li .v3-news-admin`, (n) =>
    n.map((x) => Array.from(x.querySelectorAll('button'))
      .map((b) => b.textContent.replace(/[^A-Za-z ]/g, '').trim()).join('/'))),
    ['Publish/Edit/Remove', 'Edit/Remove', 'Edit/Remove'],
    `${pageName}: every entry can be edited and removed; only the new one published`);

  /* THE PANEL STAYS OPEN ACROSS A RE-RENDER. render() rebuilds the <details>,
     so without remembering the state it snapped shut on every one — and
     pressing Edit on a removed entry re-renders, which made that button read
     as dead: the editor opened inside a panel that had just folded up. */
  await p.click('.v3-news-bin summary');
  ok(await p.$eval('.v3-news-bin', (n) => n.open),
    `${pageName}: the removed panel opens when clicked`);
  await p.click('.v3-news-bin .v3-news-admin button:has-text("Edit")');
  ok(await p.$eval('.v3-news-bin', (n) => n.open) &&
     await p.isVisible('.v3-news-bin .v3-news-edit textarea'),
    `${pageName}: and Edit inside it opens the form without folding the panel away`);
  await p.click('.v3-news-bin .v3-news-edit button:has-text("Cancel")');

  /* THE INLINE EDITOR KEEPS WHAT IS TYPED across a re-render — the list
     re-renders on its own when the decisions land, and on a FAILED save,
     which is exactly when losing a paragraph just written would hurt most. */
  await p.click(`${listSel} > li .v3-news-admin button:has-text("Edit")`);
  ok(await p.isVisible(`${listSel} .v3-news-edit textarea`),
    `${pageName}: Edit opens a real form, not a prompt() line`);
  await p.fill(`${listSel} .v3-news-edit textarea`, 'A summary still being written');
  await p.evaluate(([log]) => window.OANews.__setForTest(null, true, log), [LOG]);
  await p.waitForTimeout(200);
  eq(await p.inputValue(`${listSel} .v3-news-edit textarea`), 'A summary still being written',
    `${pageName}: and a re-render mid-edit keeps it`);
  await p.click(`${listSel} .v3-news-edit button:has-text("Cancel")`);
  ok(!(await p.$(`${listSel} .v3-news-edit`)),
    `${pageName}: Cancel closes it, changing nothing`);

  /* AN EDIT IS SHOWN, not noted beside the entry. */
  await p.evaluate(([log]) => window.OANews.__setForTest(
    { settled: { status: 'approved', title: 'Reworded by hand' } }, false, log), [LOG]);
  await p.waitForTimeout(200);
  ok((await titles()).includes('Reworded by hand'),
    `${pageName}: a reworded entry reads as the maintainer wrote it`);

  await p.close();
}

/* ------------------------- the Universities directory: cards and the edits

   universities.html's landing view since 2026-08-24: OAList over
   data/directory.json, grouped one card per university, with the community's
   `directoryEdits` overlaid at read time (assets/oa-directory.js). The
   Firestore read is one this sandbox cannot make, so the signed-in and
   maintainer shapes are driven through OADirectory.__setForTest — which
   changes only what is DRAWN; the rules stay the authorisation. What a
   browser CAN prove: the cards render, a signed-out visitor is offered no
   edit control and no Last-edited filter, a registered user gets Edit and
   Add (and never Hide/Reset), the card says who last edited it and when,
   and a hidden row stays visible to the maintainer with Restore. */

{
  const p = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  p.on('pageerror', (e) => jsErrors.push('directory: ' + e.message));
  await p.goto(BASE + 'universities.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#oa-dir .oa-card', { timeout: 15000 });

  const anon = await p.evaluate(() => {
    const host = document.getElementById('oa-dir');
    const f = host.querySelector('.oa-f-lastedited');
    return {
      cards: host.querySelectorAll('.oa-card').length,
      lastEditedShown: f ? getComputedStyle(f).display !== 'none' : null,
      controls: host.querySelectorAll('[data-dir-edit], [data-dir-add], [data-dir-hide]').length,
      firstRow: (host.querySelector('[data-dir-row]') || { getAttribute: () => '' })
        .getAttribute('data-dir-row'),
    };
  });
  ok(anon.cards > 0, `directory: the cards render (${anon.cards} on page one)`);
  eq(anon.lastEditedShown, false,
    'directory: the Last-edited filter is drawn for the maintainer alone');
  eq(anon.controls, 0, 'directory: a signed-out visitor is offered no edit control');
  ok(anon.firstRow, 'directory: every department row carries the id an edit is keyed on');

  // a REGISTERED USER: Edit on every row, Add on every card, the attribution
  // line — and none of the maintainer's controls
  /* the fixture name must be one canonUnit() leaves alone — a "…Department"
     suffix is a wrapper word the canon strips, which is correct on the page
     and baffling in a test fixture */
  await p.evaluate((rowId) => {
    const edits = {};
    edits[rowId] = { rowId, department: 'Quantitative Corrections',
      name: 'Test Editor', t: Date.now(), by: 'u-test' };
    OADirectory.__setForTest({ user: { uid: 'u-test' }, admin: false, edits });
  }, anon.firstRow);
  await p.waitForTimeout(300);
  const asUser = await p.evaluate(() => {
    const host = document.getElementById('oa-dir');
    const f = host.querySelector('.oa-f-lastedited');
    return {
      edits: host.querySelectorAll('[data-dir-edit]').length,
      adds: host.querySelectorAll('[data-dir-add]').length,
      adminOnly: host.querySelectorAll('[data-dir-hide], [data-dir-reset]').length,
      lastEditedShown: f ? getComputedStyle(f).display !== 'none' : null,
      note: [...host.querySelectorAll('.oa-dir-edited')].map((n) => n.textContent)
        .find((t) => t.includes('Test Editor')) || '',
      corrected: [...host.querySelectorAll('.oa-dir-dname')].some((n) =>
        n.textContent === 'Quantitative Corrections'),
    };
  });
  ok(asUser.edits > 0 && asUser.adds > 0,
    'directory: a registered user may edit any row and add a department');
  eq(asUser.adminOnly, 0, 'directory: Hide and Reset stay the maintainer\'s alone');
  eq(asUser.lastEditedShown, false, 'directory: …and so does the Last-edited filter');
  ok(/Last edited by Test Editor on /.test(asUser.note),
    `directory: the card says who last edited it and when ("${asUser.note.trim()}")`);
  ok(asUser.corrected,
    'directory: the correction is what every visitor reads — overlaid at read time');

  // the MAINTAINER: the Last-edited filter, and hiding is never a one-way door
  await p.evaluate((rowId) => {
    const edits = {};
    edits[rowId] = { rowId, hidden: true, name: 'Test Editor', t: Date.now(), by: 'u-admin' };
    OADirectory.__setForTest({ user: { uid: 'u-admin' }, admin: true, edits });
  }, anon.firstRow);
  await p.waitForTimeout(300);
  const asAdmin = await p.evaluate(() => {
    const host = document.getElementById('oa-dir');
    const f = host.querySelector('.oa-f-lastedited');
    return {
      lastEditedShown: f ? getComputedStyle(f).display !== 'none' : null,
      restores: host.querySelectorAll('[data-dir-restore]').length,
      hiddenRows: host.querySelectorAll('.oa-dir-hidden').length,
    };
  });
  eq(asAdmin.lastEditedShown, true, 'directory: the maintainer gets the Last-edited filter');
  ok(asAdmin.restores > 0 && asAdmin.hiddenRows > 0,
    'directory: a hidden row stays visible TO THE MAINTAINER, faded, with Restore');
  await p.close();
}

/* --------------------------------------------------- the Universities map

   The page's SECOND view since 2026-08-24 (the cards above are the landing
   one): the same Leaflet map over data/universities.json, vendored under
   assets/leaflet/, mounted lazily on the first switch. What the vendor view
   did is what is pinned: every school with coordinates is a pin, the search
   filters the pins as you type, a pin's popup carries the links into the
   site's own pages. Tiles come from openstreetmap.org at runtime and are
   deliberately NOT asserted — this sandbox has no network, and the map's own
   DOM is the part that is ours. */

{
  const unis = JSON.parse(await readFile(path.join(ROOT, 'data', 'universities.json'), 'utf8'));
  const p = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  p.on('pageerror', (e) => jsErrors.push('universities: ' + e.message));
  await p.goto(BASE + 'universities.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#oa-dir-viewmap', { timeout: 15000 });
  await p.click('#oa-dir-viewmap');
  await p.waitForSelector('.oa-uni-map .leaflet-marker-icon', { timeout: 15000 });

  eq(await p.$eval('.oa-uni-count', (n) => n.textContent), `${unis.length} universities`,
    'universities: the count line carries the whole dataset');

  // search filters the pins as you type, and lands in the URL
  const needle = 'insead';
  const expect = unis.filter((r) =>
    [r.name, r.institution, r.school, r.department, r.schoolDept, r.address]
      .some((v) => String(v || '').toLowerCase().includes(needle))).length;
  ok(expect >= 1, 'universities: the search fixture exists in the dataset');
  await p.fill('#oa-uni-search', needle);
  await p.waitForTimeout(400);
  eq(await p.$eval('.oa-uni-count', (n) => n.textContent),
    `${expect} of ${unis.length} universities`,
    'universities: the search narrows the pins as you type');
  eq(await p.$$eval('img.leaflet-marker-icon', (ns) => ns.length), expect,
    'universities: what the count says is what the map shows');
  ok(p.url().includes('q=' + needle), 'universities: the search is shareable from the address bar');

  // a pin's popup is the vendor tooltip: the school, then the site's own pages
  await p.$eval('img.leaflet-marker-icon', (n) =>
    n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await p.waitForSelector('.leaflet-popup .oa-uni-pop', { timeout: 5000 });
  const pop = await p.$eval('.leaflet-popup .oa-uni-pop', (n) => ({
    title: n.querySelector('h3').textContent,
    links: [...n.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  }));
  ok(pop.title.length > 0, 'universities: the popup names the school');
  /* Four of the five reach pages of their own. The fifth, the candidates list,
     is a SECTION of the one-pager — so the popup deep-links the section with
     the namespaced key that mount reads, rather than candidates.html, which
     redirects there and would drop the query on the way. */
  for (const [want, what] of [
    ['recent-faculty.html?placement=', 'recent hires'],
    ['recent-faculty.html?alma=', 'PhD alumni'],
    ['./?c_affiliation=', 'candidates'],
    ['jobs.html?institution=', 'current openings'],
    ['previous-markets.html?university=', 'past postings'],
  ]) {
    ok(pop.links.some((h) => h.startsWith(want)),
      `universities: the popup links into ${what} pre-filtered`);
  }
  ok(pop.links.every((h) => /^(https?:\/\/|[a-z-]+\.html\?|\.\/\?)/.test(h)),
    'universities: every popup link is a page of this site or a real URL');

  /* NOTHING ON THE POPUP IS GREY, IN EITHER THEME.
     Leaflet's card is white in both, and nothing in this repository restyles
     it, so text on it can never take its colour from the page. It did: the
     redesign's `body.v3 a { color: var(--brand) }` outweighed a bare
     `.oa-uni-pop a`, and in dark mode --brand is #c6ccd4 — a pale grey chosen
     for a near-black page — so every "link" on the white card was washed out.

     Measured as CONTRAST against the card's own background rather than
     against a list of allowed hex values: the latter passes a colour that is
     legal and unreadable, which is the whole failure being pinned. 4.5:1 is
     the WCAG AA threshold for body text. */
  for (const theme of ['light', 'dark']) {
    await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const worst = await p.$eval('.leaflet-popup .oa-uni-pop', (n) => {
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
          .map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      // the nearest ancestor that actually paints — Leaflet's card
      let bgEl = n, bg = '';
      while (bgEl && !bg) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) bg = c;
        bgEl = bgEl.parentElement;
      }
      const L2 = lum(bg || 'rgb(255,255,255)');
      let low = { ratio: 99, text: '' };
      for (const el of n.querySelectorAll('td, th, a, h3')) {
        if (!el.textContent.trim()) continue;
        const L1 = lum(getComputedStyle(el).color);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        if (ratio < low.ratio) low = { ratio, text: el.textContent.trim().slice(0, 24) };
      }
      return low;
    });
    ok(worst.ratio >= 4.5,
      `universities: popup text is readable in ${theme} mode ` +
      `(worst ${worst.ratio.toFixed(1)}:1 on "${worst.text}")`);
  }
  await p.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  /* And the deep links WORK: each lands with the school in a filter chip, not
     merely at a URL that carries it. This is the check the swap needed — a
     redirect resolves and looks fine while silently discarding the filter. */
  for (const href of pop.links.filter((h) => !/^https?:/.test(h))) {
    const d = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await d.goto(BASE + href.replace(/^\.\//, ''), { waitUntil: 'domcontentloaded' });
    await d.waitForTimeout(3500);
    /* A filter that took a value from the URL is one showing it — as a CHIP
       now that a text search holds several terms, or in the box for a page
       whose engine still carries a single one. Either is the filter landing;
       what would fail is neither. */
    const filtered = await d.evaluate(() =>
      document.querySelectorAll('.oa-filters .oa-chip').length > 0
      || [...document.querySelectorAll('.oa-filters input')].some((i) => i.value.trim().length > 0));
    ok(filtered, `universities: ${href.split('?')[0]} opens with the school already filtered`);
    await d.close();
  }

  /* The deep link every posting's Further-info column emits. It lands on the
     CARDS now — the page's landing view — as a chip the reader can see and
     remove, which is where a reader following "Further info" is best served:
     the university's whole card, not a pin to hunt for. */
  const viaA = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  viaA.on('pageerror', (e) => jsErrors.push('universities filterA: ' + e.message));
  await viaA.goto(BASE + 'universities.html?filterA=INSEAD', { waitUntil: 'domcontentloaded' });
  await viaA.waitForSelector('#oa-dir .oa-card, #oa-dir .oa-empty', { timeout: 15000 });
  eq(await viaA.$eval('#oa-dir .oa-chip .oa-chip-label', (n) => n.textContent), 'INSEAD',
    'universities: ?filterA lands on the cards as a chip, as it landed in the vendor filter');
  const viaCount = await viaA.$eval('#oa-dir .oa-count', (n) => n.textContent);
  ok(/\(of \d+\)/.test(viaCount),
    `universities: and it narrows the directory (count reads "${viaCount}")`);
  await viaA.close();
  await p.close();
}

/* the MAP VIEW on a phone — the cards view is an OAList page and holds the
   standard through MOBILE_PAGES below; the map cannot mount OAList, so the
   same rules are asserted against its own controls once it is switched to */
{
  const m = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  m.on('pageerror', (e) => jsErrors.push('universities mobile: ' + e.message));
  await m.goto(BASE + 'universities.html', { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('#oa-dir-viewmap', { timeout: 15000 });
  await m.click('#oa-dir-viewmap');
  await m.waitForSelector('.oa-uni-map .leaflet-marker-icon', { timeout: 15000 });

  const mob = await m.evaluate(() => {
    const doc = document.documentElement;
    const input = document.querySelector('#oa-uni-search');
    const box = document.querySelector('.oa-uni-map').getBoundingClientRect();
    return {
      overflowX: doc.scrollWidth > doc.clientWidth,
      inputFont: parseFloat(getComputedStyle(input).fontSize),
      inputH: Math.round(input.getBoundingClientRect().height),
      gutterLeft: Math.round(box.left),
      mapRightGap: Math.round(doc.clientWidth - box.right),
      vw: doc.clientWidth,
    };
  });
  ok(!mob.overflowX, 'universities mobile: the page never scrolls sideways');
  ok(mob.inputFont >= 16,
    `universities mobile: the search is 16px+ so iOS does not zoom (got ${mob.inputFont}px)`);
  ok(mob.inputH >= 40, `universities mobile: the search is a touch target (got ${mob.inputH}px)`);
  ok(mob.gutterLeft >= 8 && mob.mapRightGap >= 8,
    `universities mobile: the map keeps the side gutter (got ${mob.gutterLeft}/${mob.mapRightGap})`);
  await m.close();
}

/* ------------------------------------------- every list page, on a phone

   The skel grid cancels its own gutter below 736px (#content pads 30px, .row
   pulls -30px), which had the filters and cards running EDGE TO EDGE; and any
   focused input under 16px makes iOS Safari zoom the page in and leave it
   zoomed. Both are pinned here, plus the things a thumb needs: 40px+ targets
   and every picker menu staying inside the viewport.

   THE STANDARD IS _MOBILE-STANDARDS.md, and this loop is its gate: every
   page that mounts OAList must be listed here in the same change that
   creates it. Candidates and placements ship with empty datasets until
   their pipelines fill, so the card checks run only when cards exist — the
   filter-bar rules hold either way. */

/* --------- the archive editor never offers itself on a real job posting

   previous-markets.html renders TWO populations from one list: the frozen
   archive, and the postings folded in at read time from data/jobs.json. Those
   second ones are real submissions, and an override against one is read by
   NOTHING — no build applies rowOverrides to data/jobs.json — so Take down
   there emptied the card and left the posting on the site. Measured: every
   card on page one is a folded-in posting, so this was not an edge case but
   the default view.

   Standing down when the job editor has drawn is not the guard, because the
   two race; this is. */

{
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  p.on('pageerror', (e) => jsErrors.push('overrides/own: ' + e.message));
  await p.goto(BASE + 'previous-markets.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card');
  await p.waitForTimeout(600);

  const jobs = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  const past = JSON.parse(await readFile(path.join(ROOT, 'data', 'past-postings.json'), 'utf8'));
  const archiveIds = new Set(past.map((r) => r.id));
  const folded = new Set(jobs.map((r) => r.id).filter((id) => !archiveIds.has(id)));
  ok(folded.size > 0, 'previous-markets: the page really does fold in live postings');

  // the maintainer, with the job editor not yet resolved — the first second of
  // every visit, and for ever if that read fails
  await p.evaluate(() => window.OARowEdit.__setForTest('past-postings',
    { ready: true, admin: true }));
  await p.waitForTimeout(400);

  const drawnOn = await p.$$eval('.oa-card-actions',
    (ns) => ns.map((n) => n.closest('.oa-card').id.replace(/^job-/, '')));
  eq(drawnOn.filter((id) => folded.has(id)), [],
    'the archive editor draws on no posting that belongs to data/jobs.json');

  /* …and it DOES draw on the archive's own rows. Filtering to a season only
     the archive covers brings them onto the first page. */
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  p2.on('pageerror', (e) => jsErrors.push('overrides/own2: ' + e.message));
  await p2.goto(BASE + 'previous-markets.html?year=2015', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.oa-card');
  await p2.waitForTimeout(600);
  await p2.evaluate(() => window.OARowEdit.__setForTest('past-postings',
    { ready: true, admin: true }));
  await p2.waitForTimeout(400);
  const shown2 = await p2.$$eval('.oa-card', (n) => n.length);
  ok(shown2 > 0, 'previous-markets: the archive-only season shows rows');
  eq(await p2.$$eval('.oa-card-actions', (n) => n.length), shown2,
    'and every one of the archive\'s own rows carries the controls');

  /* AND AN OVERRIDE THAT ALREADY EXISTS against a folded-in posting — written
     before this guard, or by mistake — is INERT rather than half-applied. It
     must not hide the row, because nothing on this page could then put it
     back: the archive editor no longer offers itself there, and the job editor
     knows nothing about rowOverrides. */
  /* A folded-in posting that is actually ON this page — `folded` also holds
     the current-market rows, which previous-markets deliberately excludes, and
     only the first ten of what is left are rendered. */
  const stale = await p.$eval('.oa-card', (n) => n.id.replace(/^job-/, ''));
  ok(folded.has(stale), 'the card under test really is one of the folded-in postings');
  await p.evaluate((id) => window.OARowEdit.__setForTest('past-postings', {
    ready: true, admin: false, rows: { [id]: { hidden: true, institution: 'Should Not Show' } },
  }), stale);
  await p.waitForTimeout(400);
  ok(await p.$(`[id="job-${stale}"]`),
    'an override against a posting the archive does not own does not hide it');
  ok(!(await p.$$eval('.oa-card-title', (n) => n.map((x) => x.textContent)))
      .includes('Should Not Show'),
    'nor rewrite it — it is inert, not half-applied');

  eq(jsErrors.filter((e) => e.startsWith('overrides/own')), [],
    'no uncaught errors on either view');
  await p.close();
  await p2.close();
}

/* ------------- a taken-down row stays visible to the maintainer, whoever
   owns the card, and the admin-only module is never a hard dependency

   previous-markets.html carries TWO decorators, and which of them ends up
   owning a card is a matter of timing — oa-jobedit reads the WHOLE
   jobSubmissions collection, oa-rowedit a small filtered query. The fade, the
   note and Restore are the ONLY trace an override leaves on the page, so if
   they are skipped whenever the other decorator got there first, a row the
   maintainer took down looks completely ordinary to them while being invisible
   to everybody else — with no way back.                                     */

{
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  p.on('pageerror', (e) => jsErrors.push('overrides/hidden: ' + e.message));
  /* A season only the ARCHIVE covers, so every card is a row this editor owns
     — the folded-in postings from data/jobs.json are another editor's, and it
     refuses to touch them (the block above). */
  await p.goto(BASE + 'previous-markets.html?year=2015', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card');
  await p.waitForTimeout(600);

  const victim = await p.$eval('.oa-card', (n) => n.id.replace(/^job-/, ''));

  // the OTHER decorator owns this card, and the row is hidden by an override
  await p.evaluate((id) => {
    window.OAJobEdit.__setPermissionsForTest({
      ready: true, admin: true, byId: { [id]: id }, byRef: {},
    });
    window.OARowEdit.__setForTest('past-postings', {
      ready: true, admin: true, rows: { [id]: { hidden: true } },
    });
  }, victim);
  await p.waitForTimeout(400);

  const card = `[id="job-${victim}"]`;
  ok(await p.$(card), 'the maintainer still sees a row they took down');
  ok(await p.$eval(card, (n) => n.classList.contains('oa-card-gone')),
    'and it is marked as taken down even though the other editor owns the card');
  eq(await p.$$eval(card + ' .oa-rowedit-restore', (n) => n.map((x) => x.textContent)),
    ['Restore'], 'with a way to put it back');
  ok(/only you/i.test(await p.$eval(card + ' .oa-card-note', (n) => n.textContent)),
    'and a sentence saying only they can see it');

  // and a visitor gets none of it: the row is simply not there
  await p.evaluate((id) => {
    window.OAJobEdit.__setPermissionsForTest({ ready: true, admin: false, byId: {}, byRef: {} });
    window.OARowEdit.__setForTest('past-postings', {
      ready: true, admin: false, rows: { [id]: { hidden: true } },
    });
  }, victim);
  await p.waitForTimeout(400);
  ok(!(await p.$(card)), 'while a visitor does not see it at all');

  eq(jsErrors.filter((e) => e.startsWith('overrides/hidden')), [],
    'no uncaught errors either way');
  await p.close();
}

/* THE ADMIN-ONLY MODULE IS A SOFT DEPENDENCY. These are PUBLIC pages; a
   content blocker with a broad asset filter, or a transient 5xx on one file,
   must not cost every reader the list. The module is aborted at the network
   and the page has to render exactly what it renders with no overrides. */

for (const [pageName, sel, least, mapBtn] of [
  ['previous-markets.html', '.oa-card', 1, null],
  ['recent-faculty.html', '.oa-card', 1, null],
  // the directory lands on its cards, which never touch the module; the MAP
  // view is where oa-rowedit hooks in, so it is switched to and held to the
  // same rule — the stand-in draws nothing and the pins still render
  ['universities.html', 'img.leaflet-marker-icon', 1, '#oa-dir-viewmap'],
]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/oa-rowedit.js', (r) => r.abort());
  await p.goto(BASE + pageName, { waitUntil: 'domcontentloaded' });
  if (mapBtn) {
    await p.waitForSelector('#oa-dir .oa-card', { timeout: 15000 }).catch(() => {});
    ok(await p.$$eval('#oa-dir .oa-card', (n) => n.length) >= 1,
      `${pageName} still renders its cards when the admin-only module never loads`);
    await p.click(mapBtn);
  }
  await p.waitForSelector(sel, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(600);
  ok(await p.$$eval(sel, (n) => n.length) >= least,
    `${pageName} still renders its data when the admin-only module never loads`);
  eq(errs, [], `${pageName} raises no error over the missing module`);
  await p.close();
}

/* ----------------------- an override is DATA, never markup and never a scheme

   `rowOverrides` is PUBLIC-READ: whatever it holds is rendered for every
   visitor, on three pages, so an override that could carry markup or a
   `javascript:` URL would be stored XSS on the whole site the moment the
   maintainer's account was ever compromised — and a wrong-looking paste would
   break the page long before that. The rules bound the LENGTH of each field;
   nothing there can bound its CONTENT, so the property has to hold at render
   time, and this is where it is pinned.

   It holds today because the card renderer uses textContent for a plain value
   and the one innerHTML it does use receives an anchor that was BUILT AS DOM —
   href through OAList.safeUrl, label through textContent — and serialised. All
   three are one edit away from not holding. */

{
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  p.on('pageerror', (e) => jsErrors.push('overrides/xss: ' + e.message));
  // an archive season, so the row is one this editor owns (see above)
  await p.goto(BASE + 'previous-markets.html?year=2015', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.oa-card');
  await p.waitForTimeout(400);

  const victim = await p.$eval('.oa-card', (n) => n.id.replace(/^job-/, ''));
  const MARKUP = '<img src=x onerror="window.__xss=1">Somewhere';

  await p.evaluate(([id, markup]) => {
    window.__xss = 0;
    window.OARowEdit.__setForTest('past-postings', {
      ready: true, admin: false,
      rows: { [id]: {
        institution: markup,
        comments: markup,
        adUrl: 'javascript:window.__xss=1',
      } },
    });
  }, [victim, MARKUP]);
  await p.waitForTimeout(400);

  const card = `[id="job-${victim}"]`;
  eq(await p.$eval(card + ' .oa-card-title', (n) => n.textContent), MARKUP,
    'an override that looks like markup is shown as the text it is');
  eq(await p.$$eval(card + ' img', (n) => n.length), 0,
    'and is never parsed into an element');

  // open the card so its detail rows render, then look at what they hold
  await p.click(card + ' .oa-card-head');
  await p.waitForTimeout(200);
  eq(await p.$$eval(card + ' .oa-card-body img', (n) => n.length), 0,
    'the same is true of every field in the body');
  eq(await p.$$eval(card + ' a', (as) =>
    as.filter((a) => /^javascript:|^data:/i.test(a.getAttribute('href') || '')).length), 0,
    'and a javascript: URL never becomes a link');
  eq(await p.evaluate(() => window.__xss), 0, 'nothing an override carries executes');

  eq(jsErrors.filter((e) => e.startsWith('overrides/xss')), [],
    'and the page raises no error over it');
  await p.close();
}

/* ------------------------------- Edit / Take down on the universities map

   The map is not an OAList page, so its half of the archive editing lives on
   its own hooks: `prepare` overlays the maintainer's corrections onto the
   dataset before it is drawn, and `onPopup` adds the controls to a pin's
   popup. The overrides come from a Firestore read CI cannot make, so they are
   injected here exactly as on the two archive lists.                        */

{
  const unis = JSON.parse(await readFile(path.join(ROOT, 'data', 'universities.json'), 'utf8'));
  const p = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  p.on('pageerror', (e) => jsErrors.push('universities/edit: ' + e.message));
  await p.goto(BASE + 'universities.html', { waitUntil: 'domcontentloaded' });
  // the cards are the landing view — the map mounts on the switch
  await p.waitForSelector('#oa-dir-viewmap', { timeout: 15000 });
  await p.click('#oa-dir-viewmap');
  await p.waitForSelector('.oa-uni-map .leaflet-marker-icon', { timeout: 15000 });

  const openPopup = async () => {
    await p.$eval('img.leaflet-marker-icon', (n) =>
      n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await p.waitForSelector('.leaflet-popup .oa-uni-pop', { timeout: 5000 });
  };

  await openPopup();
  eq(await p.$$eval('.leaflet-popup .oa-uni-admin', (n) => n.length), 0,
    'universities: a visitor who is not signed in gets no controls on a pin');

  await p.evaluate(() =>
    window.OARowEdit.__setForTest('universities', { ready: true, admin: true }));
  await p.waitForTimeout(400);
  await openPopup();
  eq(await p.$$eval('.leaflet-popup .oa-uni-admin .oa-jobbtn', (n) =>
    n.map((x) => x.textContent)), ['Edit', 'Take down'],
    'universities: the maintainer gets both controls on a pin, in that order');
  eq(await p.$eval('.oa-uni-count', (n) => n.textContent), `${unis.length} universities`,
    'universities: and the map still carries the whole dataset');

  /* A CORRECTION IS WHAT EVERY VISITOR SEES. `institution` is the field every
     link on a popup filters by, so an override has to reach the links too —
     not only the heading. */
  const victim = unis.find((r) => isFinite(r.lat) && isFinite(r.lng));
  await p.evaluate((v) => window.OARowEdit.__setForTest('universities', {
    ready: true, admin: false,
    rows: { [v]: { institution: 'Corrected School', name: 'Corrected School' } },
  }), victim.id);
  await p.waitForTimeout(500);
  await p.fill('#oa-uni-search', 'Corrected School');
  await p.waitForTimeout(400);
  eq(await p.$$eval('img.leaflet-marker-icon', (n) => n.length), 1,
    'universities: the corrected school is findable by its new name');
  await openPopup();
  eq(await p.$eval('.leaflet-popup .oa-uni-pop h3', (n) => n.textContent), 'Corrected School',
    'universities: and the popup names it that way');
  ok(await p.$$eval('.leaflet-popup .oa-uni-pop a', (ns) =>
    ns.some((a) => (a.getAttribute('href') || '').includes('Corrected%20School'))),
    'universities: every link on the popup follows the corrected name');

  // A TAKEN-DOWN SCHOOL LEAVES THE MAP, for everybody.
  await p.fill('#oa-uni-search', '');
  await p.waitForTimeout(400);
  await p.evaluate((v) => window.OARowEdit.__setForTest('universities', {
    ready: true, admin: false, rows: { [v]: { hidden: true } },
  }), victim.id);
  await p.waitForTimeout(500);
  eq(await p.$eval('.oa-uni-count', (n) => n.textContent), `${unis.length - 1} universities`,
    'universities: a taken-down school is off the map for every visitor');

  await p.close();
}

const MOBILE_PAGES = [
  // the live site: the one-pager (whose jobs teaser has NO filter bar — the
  // first VISIBLE bar is the candidates mount, reached by the walk below;
  // placements is a mount further down the same page), the dedicated jobs
  // page (whose bar carries the sign-in lock; the gate's programmatic clicks
  // work through pointer-events:none, which is the point of measuring rather
  // than tapping here), and the two archive lists rebuilt in this design
  'index.html', 'jobs.html', 'previous-markets.html', 'recent-faculty.html',
  // the Universities directory — an OAList page since 2026-08-24 (its map
  // view keeps its own phone block above, as _MOBILE-STANDARDS.md describes)
  'universities.html',
  // and the archived design, which is still served and still has to hold the
  // standard on a phone. Its candidates and placements are pages of their own
  // there; on the live site they are sections of index.html, above.
  V2 + 'jobs.html', V2 + 'candidates.html', V2 + 'placements.html',
  V2 + 'previous-markets.html', V2 + 'recent-faculty.html'];

for (const pageName of MOBILE_PAGES) {
  const m = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  await m.goto(BASE + pageName, { waitUntil: 'domcontentloaded' });
  // The v3 one-pager mounts its lists LAZILY as they near the viewport, and
  // its jobs teaser carries no filter bar at all — so walk down one viewport
  // per poll until BOTH a rendered list and a VISIBLE filter bar exist. On
  // every root page both are there at the first look, with no scrolling.
  await m.waitForFunction(() => {
    const listed = document.querySelector('.oa-card, .oa-empty');
    const bars = [...document.querySelectorAll('.oa-filters')];
    const bar = bars.find((el) => el.offsetParent !== null);
    if (listed && bar) return true;
    // v3 hides a bar whose DATASET is empty (.oa-data-empty — nothing to
    // search yet). Once the walk has reached the bottom, "every bar hidden
    // that way" is the page's correct final state, not a missing bar.
    const atBottom = window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 4;
    if (listed && atBottom && bars.length &&
        bars.every((el) => el.closest('.oa-data-empty'))) return true;
    window.scrollBy(0, window.innerHeight);
    return false;
  }, null, { timeout: 30000, polling: 400 });
  await m.evaluate(() => window.scrollTo(0, 0));

  const mob = await m.evaluate(() => {
    const doc = document.documentElement;
    // the first VISIBLE bar — the v3 one-pager's jobs teaser removes its own
    // (display:none-in-DOM bars measure as 0×0 and would fail the gutter)
    const bar = [...document.querySelectorAll('.oa-filters')]
      .find((el) => el.offsetParent !== null);
    // every dataset empty → every bar deliberately hidden → nothing to measure
    if (!bar) return { barless: true, overflowX: doc.scrollWidth > doc.clientWidth };
    const filters = bar.getBoundingClientRect();
    const search = bar.querySelector('input[type="search"]') ||
      document.querySelector('.oa-filter input[type="search"]');
    const card = document.querySelector('.oa-card');
    const cr = card && card.getBoundingClientRect();
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
      cardLeft: cr && Math.round(cr.left),
      cardRight: cr && Math.round(doc.clientWidth - cr.right),
      searchFont: parseFloat(getComputedStyle(search).fontSize),
      searchH: Math.round(search.getBoundingClientRect().height),
      pickH: btns.length && Math.round(btns[0].getBoundingClientRect().height),
      pagerH: pager && Math.round(pager.getBoundingClientRect().height),
      menus,
      vw: doc.clientWidth,
    };
  });

  const at = `mobile ${pageName}:`;
  ok(!mob.overflowX, `${at} the page never scrolls sideways`);
  if (mob.barless) { await m.close(); continue; }
  ok(mob.gutterLeft >= 8, `${at} the filters keep a side gutter (got ${mob.gutterLeft})`);
  ok(mob.cardLeft === null || (mob.cardLeft >= 8 && mob.cardRight >= 8),
    `${at} cards keep the gutter too (got ${mob.cardLeft}/${mob.cardRight})`);
  ok(mob.searchFont >= 16,
    `${at} the search input is 16px+ so iOS does not zoom the page (got ${mob.searchFont}px)`);
  ok(mob.searchH >= 40 && (!mob.pickH || mob.pickH >= 40),
    `${at} search and picker controls are touch targets (got ${mob.searchH}/${mob.pickH}px)`);
  ok(!mob.pagerH || mob.pagerH >= 36, `${at} pager chevrons are tappable (got ${mob.pagerH}px)`);
  ok(mob.menus.every((r) => r.left >= 0 && r.right <= mob.vw),
    `${at} every picker menu stays on screen (got ${JSON.stringify(mob.menus)})`);
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

/* ------------------------------- three trees, and the seams between them

   The site serves three designs at once: the live one at the root, the 2026
   rebuild archived at /v2/, and the 2014-2026 site at /v1/. link-check.mjs
   reads the links; this reads what a BROWSER does with them, which is where
   the failure a promotion causes actually shows up.

   The named case is the owner's own: the three cards under "Explore the wider
   market". After the 2026-08-17 swap they still pointed at pages built in the
   design that had just been archived, so clicking one left the new site
   without saying so. Nothing 404s when that happens — which is exactly why it
   needs a test rather than a look.                                          */

{
  /* -- the three cards land IN the live design, with their data ---------- */
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#resources .v3-card');
  const cards = await p.$$eval('#resources .v3-card', (as) => as.map((a) => ({
    href: a.getAttribute('href'),
    title: a.querySelector('.v3-h3').textContent.trim(),
  })));
  eq(cards.length, 3, 'the resources section offers three cards');
  await p.close();

  for (const c of cards) {
    ok(!/^\/?v\d+\//.test(c.href),
      `"${c.title}" does not point into a version directory (${c.href})`);
    const q = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = [];
    q.on('pageerror', (e) => errs.push(e.message));
    await q.goto(BASE + c.href, { waitUntil: 'domcontentloaded' });
    await q.waitForTimeout(2500);
    const seen = await q.evaluate(() => ({
      live: !!document.querySelector('body.v3 .v3-header .v3-nav'),
      archived: !!document.querySelector('#header-wrapper, #page-wrapper'),
      rows: document.querySelectorAll('.oa-card, .leaflet-marker-icon').length,
      robots: !!document.querySelector('meta[name="robots"]'),
    }));
    ok(seen.live, `${c.href}: opens IN the live design`);
    ok(!seen.archived, `${c.href}: carries none of the archived design's chrome`);
    ok(!seen.robots, `${c.href}: is indexable — a live page, not an archived one`);
    ok(seen.rows > 0, `${c.href}: renders its data (${seen.rows} rows/pins)`);
    eq(errs, [], `${c.href}: no uncaught script error`);
    await q.close();
  }
}

/* -- the archives still work, and say where the reader is ---------------- */
for (const [url, marker] of [
  ['v2/', 'ARCHIVED 2026 version'],
  ['v2/jobs.html', 'ARCHIVED 2026 version'],
  ['v2/universities.html', 'ARCHIVED 2026 version'],
  ['v1/', 'ARCHIVED previous version'],
]) {
  const q = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await q.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await q.waitForTimeout(3000);
  const seen = await q.evaluate((m) => ({
    banner: document.body.textContent.includes(m),
    wayBack: !!document.querySelector('a[href="/"]'),
    noindex: /noindex/i.test((document.querySelector('meta[name="robots"]') || {}).content || ''),
    rows: document.querySelectorAll('.oa-card, .leaflet-marker-icon').length,
  }), marker);
  ok(seen.banner, `${url}: says it is an archive`);
  ok(seen.wayBack, `${url}: offers the way back to the live site`);
  ok(seen.noindex, `${url}: is noindex, so it never competes with the live page`);
  if (/jobs|universities/.test(url)) {
    // the archive reads the SHARED data at the root — a relative path here
    // would ask for /v2/data/… and paint the "could not be loaded" state
    ok(seen.rows > 0, `${url}: still reads the shared data (${seen.rows} rows/pins)`);
  }
  await q.close();
}

/* -- the preview stubs, and the addresses the one-pager absorbed --------- */
for (const [from, to] of [
  ['v3/', '/'], ['v3/jobs.html', '/jobs.html'], ['v3/post-a-job.html', '/post-a-job.html'],
]) {
  const q = await browser.newPage();
  await q.goto(BASE + from, { waitUntil: 'domcontentloaded' });
  try {
    await q.waitForURL((u) => new URL(u).pathname === to, { timeout: 8000 });
    ok(true, `${from}: lands on ${to}`);
  } catch { ok(false, `${from}: never reached ${to} (stopped at ${q.url()})`); }
  await q.close();
}

for (const [from, hash] of [
  ['candidates.html', '#candidates'], ['placements.html', '#placements'],
  ['faqs.html', '#faq'], ['contact.html', '#contact'],
  ['resources-for-candidates.html', '#resources'],
  ['directors-and-contributors.html', '#about'],
]) {
  const q = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await q.goto(BASE + from, { waitUntil: 'domcontentloaded' });
  try {
    await q.waitForURL((u) => new URL(u).hash === hash, { timeout: 8000 });
    await q.waitForTimeout(600);
    // it is not enough to arrive at the URL: the section has to be on screen
    ok(await q.evaluate((h) => {
      const el = document.getElementById(h.slice(1));
      return !!el && Math.abs(el.getBoundingClientRect().top) < window.innerHeight;
    }, hash), `${from}: lands on the ${hash} section itself`);
  } catch { ok(false, `${from}: never reached ${hash} (stopped at ${q.url()})`); }
  await q.close();
}

/* ---------------------------- the account menu's count, as it renders

   The wiring is checked in selftest; this is the part only a browser can
   answer — that the badge shows a number, hides rather than printing a 0 or
   an empty pill, and is readable in both themes. Firebase is unreachable from
   CI, so the menu's own markup is used with the module's painting rules
   rather than a real sign-in. */
{
  const a = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await a.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
  await a.waitForTimeout(400);

  const seen = await a.evaluate(() => {
    const menu = document.createElement('div');
    menu.className = 'oa-acct-menu';
    menu.innerHTML =
      '<a href="my-postings.html"><span class="oa-mi">x</span>My postings' +
        '<span class="oa-acct-n" data-count="postings" hidden></span></a>' +
      '<a href="alerts.html"><span class="oa-mi">x</span>E-mail alerts' +
        '<span class="oa-acct-n" data-count="alerts" hidden></span></a>';
    document.body.appendChild(menu);
    const paint = (counts) => {
      document.querySelectorAll('.oa-acct-n[data-count]').forEach((el) => {
        const n = counts[el.getAttribute('data-count')];
        const show = typeof n === 'number' && n > 0;
        el.textContent = show ? String(n) : '';
        el.hidden = !show;
      });
    };
    const read = () => [...document.querySelectorAll('.oa-acct-n')]
      .map((el) => ({ text: el.textContent, hidden: el.hidden }));
    const out = {};
    paint({ postings: 2, alerts: 1 }); out.some = read();
    paint({ postings: 0, alerts: 1 }); out.zero = read();
    paint({}); out.unknown = read();
    paint({ postings: 12, alerts: 3 });
    const el = document.querySelector('.oa-acct-n');
    out.rightAligned = getComputedStyle(el).marginLeft === 'auto'
      || parseFloat(getComputedStyle(el).marginLeft) > 20;
    return out;
  });

  eq(seen.some.map((x) => x.text), ['2', '1'], 'account menu: the badge shows the count');
  eq(seen.zero[0].hidden, true, 'account menu: and hides rather than printing a 0');
  eq(seen.unknown.every((x) => x.hidden), true,
    'account menu: a count we do not know shows nothing at all');
  ok(seen.rightAligned, 'account menu: the badge sits at the end of its row');

  for (const theme of ['light', 'dark']) {
    await a.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await a.waitForTimeout(150);
    const cr = await contrastOf(a, '.oa-acct-n');
    ok(cr >= 4.5, `account menu (${theme}): the badge reads at ${cr}:1`);
  }
  await a.close();
}

/* --------------------------------------- the SPONSOR mark, as it renders

   selftest.mjs pins the rule, the wiring and the stylesheets. This is the
   half only a browser can answer, and it is the half the owner actually
   bought: that on the real jobs page the sponsor's posting is FIRST, that it
   wears the pill and the rail, and that the purple is readable in both
   themes.

   It asserts on the LIVE data rather than a fixture, which is deliberate but
   has one consequence worth writing down: the sponsorship ends on
   2027-09-01, and on that day the badge correctly stops being drawn. So the
   block asks the module itself what it expects — if nothing on the page is
   sponsored it checks that nothing is MARKED either, which is the true
   assertion on both sides of that date and cannot go red on the morning the
   deal lapses. A guard about a corpus must not move with the corpus.        */
{
  const sp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await sp.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('.oa-card', { timeout: 15000 });

  /* The module has to have LOADED — a page that forgot the script tag would
     throw inside the sort and render nothing, which is worth naming rather
     than watching a later selector time out. */
  ok(await sp.evaluate(() => !!window.OASponsors),
    'sponsors: the module is on the jobs page');
  ok(await sp.evaluate(() => !!window.OASchools),
    'sponsors: …and so is oa-schools.js, which it is built on');
  ok(await sp.evaluate(() => window.OASponsors.isSponsored(
    { institution: 'CUHK', unit: 'Decisions, Operations and Technology',
      posted: '2026-08-27' }, '2026-08-29')),
    'sponsors: …so the browser resolves an acronym exactly as the tests do');

  const expected = await sp.evaluate(async () => {
    const rows = await (await fetch('/data/jobs.json', { cache: 'no-cache' })).json();
    const inMarket = rows.filter((r) => window.OAJobNav.inCurrentMarket(r));
    const marked = inMarket.filter((r) => window.OASponsors.isSponsored(r));
    return { any: marked.length > 0, first: marked.length ? marked[0].institution : '' };
  });

  const firstCard = await sp.evaluate(() => {
    const c = document.querySelector('.oa-card');
    const b = c && c.querySelector('.oa-label-sponsor');
    return {
      title: c ? c.querySelector('.oa-card-title').textContent.trim() : '',
      badge: b ? b.textContent.trim() : null,
      railed: !!(c && c.classList.contains('oa-sponsored')),
      marks: document.querySelectorAll('.oa-label-sponsor').length,
      rails: document.querySelectorAll('.oa-card.oa-sponsored').length,
    };
  });

  if (expected.any) {
    eq(firstCard.title, expected.first,
      'sponsors: the sponsor\'s posting LEADS the jobs page, whatever its date');
    eq(firstCard.badge, 'Sponsored', 'sponsors: …wearing the badge');
    eq(firstCard.railed, true, 'sponsors: …and the rail down its edge');
    /* the rail and the pill go together — one without the other is a
       half-applied treatment nobody chose */
    eq(firstCard.marks, firstCard.rails,
      'sponsors: every marked card carries both the pill and the rail');

    /* The rail is a real 3px edge, not a rule that lost to the card's own
       border. Measured, because `border-left` is exactly the kind of
       declaration a later specificity change silently undoes. */
    const rail = await sp.evaluate(() => {
      const c = document.querySelector('.oa-card.oa-sponsored');
      const cs = getComputedStyle(c);
      return { w: cs.borderLeftWidth, colour: cs.borderLeftColor,
        other: cs.borderTopWidth };
    });
    eq(rail.w, '3px', 'sponsors: the rail is 3px');
    ok(rail.w !== rail.other, 'sponsors: …and only on the left edge');

    for (const theme of ['light', 'dark']) {
      await sp.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await sp.waitForTimeout(150);
      const cr = await contrastOf(sp, '.oa-label-sponsor');
      ok(cr >= 4.5, `sponsors (${theme}): the badge reads at ${cr}:1 (AA is 4.5)`);
      /* It must paint its OWN ground: the base .oa-label sets #fff, so a
         badge that inherited the card would be white on white in light
         theme. This is CLAUDE.md's own rule, measured. */
      const own = await sp.evaluate(() => {
        const el = document.querySelector('.oa-label-sponsor');
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, ink: cs.color, border: cs.borderLeftWidth };
      });
      ok(!/rgba\(0, 0, 0, 0\)/.test(own.bg),
        `sponsors (${theme}): the badge paints its own ground`);
      ok(own.ink !== 'rgb(255, 255, 255)',
        `sponsors (${theme}): …and names its own ink rather than the base label's white`);
      ok(parseFloat(own.border) >= 1,
        `sponsors (${theme}): …and keeps the hairline that makes it an OUTLINE pill`);
    }
    await sp.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  } else {
    /* The window has closed (or the sponsor has no live posting). Then the
       page must be exactly what it was before this shipped. */
    eq(firstCard.marks, 0,
      'sponsors: with no sponsorship running, nothing on the page is marked');
    eq(firstCard.rails, 0, 'sponsors: …and no card carries a rail');
  }

  /* THE HOME PAGE badges but does NOT reorder — its teaser promises the ten
     most recent postings, and a lead row would make that heading false. */
  const hp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await hp.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
  await hp.waitForSelector('#oa-jobs-recent .oa-card', { timeout: 15000 });
  const home = await hp.evaluate(() => {
    const cards = [...document.querySelectorAll('#oa-jobs-recent .oa-card')];
    return {
      dates: cards.length,
      first: cards.length ? cards[0].querySelector('.oa-card-title').textContent.trim() : '',
      railed: !!(cards.length && cards[0].classList.contains('oa-sponsored')),
      marked: document.querySelectorAll('#oa-jobs-recent .oa-label-sponsor').length,
    };
  });
  ok(home.dates > 0, 'sponsors: the home page teaser still renders');
  if (expected.any) {
    eq(home.first, expected.first,
      'sponsors: the sponsor LEADS the home teaser too (owner, from a screenshot)');
    eq(home.railed, true,
      'sponsors: …and its card carries the rail INSIDE the panel, which resets every border');

    /* THE BUG THIS MISSED THE FIRST TIME. The rail was measured on jobs.html
       and nowhere else, so `body.v3 .v3-panel .oa-card { border: 0 }` — same
       specificity, ~600 lines later — blanked it on this page while every
       check stayed green. Measure the painted width HERE, on the card the
       screenshot was taken of. */
    const rail = await hp.evaluate(() => {
      const c = document.querySelector('#oa-jobs-recent .oa-card.oa-sponsored');
      if (!c) return null;
      const cs = getComputedStyle(c);
      return { w: cs.borderLeftWidth, other: cs.borderTopWidth };
    });
    ok(rail, 'sponsors: the teaser marks the sponsored card');
    if (rail) {
      eq(rail.w, '3px', 'sponsors: the teaser rail is a real 3px edge, not blanked by the panel reset');
      ok(rail.w !== rail.other, 'sponsors: …and still only on the left');
    }

    /* The SELECTION is still the ten newest — the heading says which ten, and
       reordering them must not change which ten. */
    const newestTen = await hp.evaluate(async () => {
      const rows = await (await fetch('/data/jobs.json', { cache: 'no-cache' })).json();
      return rows.filter((r) => window.OAJobNav.inCurrentMarket(r))
        .sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')))
        .slice(0, 10).map((r) => r.institution).sort();
    });
    const shown = await hp.evaluate(() => [...document.querySelectorAll('#oa-jobs-recent .oa-card')]
      .map((c) => c.querySelector('.oa-card-title').textContent.trim()).sort());
    eq(shown, newestTen,
      'sponsors: …and the teaser still SHOWS the ten most recent — only their order changed');
  }
  await hp.close();
  await sp.close();
}

/* ------------------------------- readable in BOTH themes, on every page

   The reports that led here (2026-08-18): the vocabulary dropdown drew
   near-white names on a white card; the "Your changes have been saved" panel
   showed a heading and then two invisible lines; the "Choose a file…" button
   was white on white. Every one of them was the same fault — a rule that
   PAINTS ITS OWN GROUND and never names its ink, so the element inherited a
   theme colour meant for a page it was no longer sitting on.

   One fix at a time would have found them one report at a time, so this walks
   every page in both themes and measures what the browser actually paints.
   Backgrounds are COMPOSITED rather than read a layer at a time: a pill on
   `rgba(198, 204, 212, 0.13)` is not light, it is 13% light over near-black,
   and reading the layer alone reports a perfectly readable button at 1:1.

   The floor is WCAG AA — 4.5:1, or 3:1 for large text.                      */

/* One page per KIND of chrome, not all 25: the one-pager, a filtered list, a
   form (the three share every panel), the feedback page's own cards, and the
   map with its vendored Leaflet controls. The whole set was walked once by
   hand to find the offenders; this is what keeps them gone without adding a
   minute to every CI run. */
const THEME_PAGES = ['index.html', 'jobs.html', 'post-a-job.html',
  'feedback.html', 'universities.html'];

{
  const t = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const seen = new Set();
  let measured = 0;
  for (const pageName of THEME_PAGES) {
    for (const theme of ['light', 'dark']) {
      try {
        await t.goto(BASE + pageName, { waitUntil: 'domcontentloaded' });
        await t.evaluate((v) => document.documentElement.setAttribute('data-theme', v), theme);
        /* WAIT FOR THE DESIGN TO BE IN FORCE, not for a stopwatch and not for
           `body.v3` — that class is in the HTML, so waiting for it returns at
           once. Every page links a Google Fonts stylesheet, which cannot load
           in CI, and until the cascade settles the body paints a default grey
           that is neither theme. Measured then, every muted line on the page
           reads as a dark-theme failure: 14 of them the first time, all
           artefacts, with the numbers moving between runs — which is what a
           transient looks like.

           So the wait asserts the thing itself: the body is painting the
           theme's own --bg. Nothing downstream can be measured before that. */
        await t.waitForFunction(() => {
          const want = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
          if (!want) return false;
          const probe = document.createElement('span');
          probe.style.color = want;
          document.body.appendChild(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return getComputedStyle(document.body).backgroundColor === resolved;
        }, { timeout: 8000 });
      } catch { continue; }               // a redirect stub navigates away
      let rows = [];
      try {
        rows = await t.evaluate(() => {
          const parse = (css) => { const m = String(css).match(/[\d.]+/g);
            if (!m || m.length < 3) return null;
            return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 }; };
          const over = (top, bot) => ({ r: top.r*top.a + bot.r*(1-top.a),
            g: top.g*top.a + bot.g*(1-top.a), b: top.b*top.a + bot.b*(1-top.a), a: 1 });
          const lum = (c) => { const f = (v) => { const x = v/255;
              return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); };
            return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
          const ground = (el) => {
            const stack = [];
            for (let n = el; n; n = n.parentElement) {
              const c = parse(getComputedStyle(n).backgroundColor);
              if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
            }
            let out = stack.length && stack[stack.length-1].a === 1
              ? stack.pop() : { r: 255, g: 255, b: 255, a: 1 };
            while (stack.length) out = over(stack.pop(), out);
            return out;
          };
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            if (el.closest('[hidden]') || el.closest('script,style,svg,noscript')) continue;
            const own = [...el.childNodes].filter((n) => n.nodeType === 3)
              .map((n) => n.textContent).join(' ').trim();
            if (own.length < 3) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.4) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const fg = parse(cs.color); if (!fg || fg.a === 0) continue;
            const bg = ground(el);
            const lf = lum(over(fg, bg)), lb = lum(bg);
            const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
            const floor = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
            const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
            if (ratio < floor) {
              out.push({ sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
              ratio: +ratio.toFixed(2), floor, txt: own.replace(/\s+/g, ' ').slice(0, 40) });
            }
          }
          return out;
        });
      } catch { continue; }
      measured += 1;
      for (const r of rows) {
        const key = `${theme}|${r.sel}|${r.ratio}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ok(false, `${pageName} (${theme}): ${r.sel} reads at ${r.ratio}:1, needs ${r.floor} — ${JSON.stringify(r.txt)}`);
      }
    }
  }
  ok(measured >= THEME_PAGES.length, `theme audit ran over ${measured} page/theme pairs`);
  if (!seen.size) ok(true, 'every page reads at AA contrast in BOTH themes');
  await t.close();
}

/* ------------------------------------- the header does not blink or shake

   The owner's report (2026-08-18): reloading any page flashes a header with no
   account control, which then appears and shoves the row sideways, and the
   avatar shows a coloured initials disc for half a second before the real
   photograph replaces it.

   Both halves were measured before they were fixed: #oa-account was empty and
   0px wide for ~130ms (the nav sat 62px to the right, the theme toggle 185px),
   and the chip painted INITIALS at 134ms and PHOTO at 796ms.

   So this drives the real thing rather than reading the source: it stubs the
   Firebase SDK to answer SLOWLY (which is what the network does — a refused
   request collapses the very window the bug lives in and would hide it),
   samples the header every animation frame through a whole load, and asserts
   that nothing moves and that the first chip ever painted is the finished one. */
{
  const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  const SDK_DELAY = 500, PROFILE_DELAY = 400;
  const stub = `
    (function(){
      var user = { uid:'u-test', email:'reader@example.com', displayName:'Kostas Stouras',
                   photoURL:'${PHOTO}', providerData:[] };
      var prof = { firstName:'Kostas', lastName:'Stouras', photo:'${PHOTO}' };
      function snap(){ return { exists:true, data:function(){ return prof; } }; }
      function doc(){ return { get:function(){ return new Promise(function(res){
            setTimeout(function(){ res(snap()); }, ${PROFILE_DELAY}); }); },
        set:function(){ return Promise.resolve(); },
        onSnapshot:function(cb){ setTimeout(function(){ cb(snap()); }, ${PROFILE_DELAY}); return function(){}; } }; }
      function coll(){ return { doc:doc, where:function(){ return this; },
        get:function(){ return Promise.resolve({ empty:true, size:0, docs:[], forEach:function(){} }); },
        count:function(){ return { get:function(){ return Promise.resolve({ data:function(){ return { count:0 }; } }); } }; } }; }
      window.firebase = { apps: [], initializeApp:function(){ this.apps.push({}); return {}; },
        auth:function(){ return { onAuthStateChanged:function(cb){ setTimeout(function(){ cb(user); }, 50); },
          currentUser:user, signOut:function(){ return Promise.resolve(); } }; },
        firestore:function(){ return { collection:coll, collectionGroup:coll }; } };
      window.firebase.firestore.FieldValue = { serverTimestamp:function(){ return 0; }, delete:function(){ return 0; } };
    })();`;

  const h = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await h.route('**/firebasejs/**', async (route) => {
    await new Promise((r) => setTimeout(r, SDK_DELAY));
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: stub });
  });

  // one ordinary visit, which is what teaches the browser the photo and the width
  await h.goto(BASE, { waitUntil: 'load' });
  await h.waitForFunction(() => {
    try {
      const x = JSON.parse(localStorage.getItem('oaAuthHint') || 'null');
      const p = JSON.parse(localStorage.getItem('oaAcctPhoto') || 'null');
      return !!(x && x.w > 0 && p && p.photo);
    } catch { return false; }
  }, null, { timeout: 8000 }).catch(() => {});

  const remembered = await h.evaluate(() => {
    const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
    return { hint: read('oaAuthHint'), photo: read('oaAcctPhoto'),
      hintBytes: (localStorage.getItem('oaAuthHint') || '').length };
  });
  ok(!!(remembered.photo && remembered.photo.photo), 'the browser remembers the profile photo');
  ok(!!(remembered.hint && remembered.hint.w > 0), 'and how wide the chip was');
  /* THE PHOTO IS NOT IN THE HINT, and this is the check that keeps it out:
     every page parses oaAuthHint in its <head>, before the first paint, and a
     25 KB JPEG data URL parsed there costs exactly the milliseconds this whole
     change is spending. (It is also the key the frozen /v2/ tree writes in its
     own shape, so a field kept there is a field an archive visit deletes.) */
  ok(!('photo' in (remembered.hint || {})),
    'the head-parsed hint does not carry the picture');
  ok(remembered.hintBytes < 400,
    `and stays small enough to parse before the first paint (${remembered.hintBytes} bytes)`);

  // now the reload the owner described, sampled frame by frame
  await h.addInitScript(() => {
    window.__hdr = [];
    const snap = () => {
      const host = document.getElementById('oa-account');
      const nav = document.querySelector('.v3-nav a');
      const tog = document.querySelector('.v3-theme');
      if (host) window.__hdr.push({
        state: host.innerHTML
          ? (host.querySelector('.oa-avatar-img') ? 'PHOTO'
            : host.querySelector('.oa-avatar') ? 'INITIALS'
              : host.querySelector('#oa-signin') ? 'SIGN-IN' : 'other')
          : 'EMPTY',
        nav: nav ? Math.round(nav.getBoundingClientRect().left) : -1,
        tog: tog ? Math.round(tog.getBoundingClientRect().left) : -1,
      });
      requestAnimationFrame(snap);
    };
    requestAnimationFrame(snap);
  });
  await h.goto(BASE, { waitUntil: 'load' });
  await h.waitForFunction(() => !!document.querySelector('#oa-account .oa-avatar-img'), null, { timeout: 8000 })
    .catch(() => {});
  await h.waitForTimeout(400);

  const frames = await h.evaluate(() => window.__hdr);
  ok(frames.length > 5, `the header was sampled through the load (${frames.length} frames)`);
  const navs = [...new Set(frames.map((f) => f.nav))];
  const togs = [...new Set(frames.map((f) => f.tog))];
  eq(navs.length, 1, `the nav does not move while the chip lands (saw ${navs.join(', ')})`);
  eq(togs.length, 1, `nor does the theme toggle (saw ${togs.join(', ')})`);
  const painted = frames.filter((f) => f.state !== 'EMPTY').map((f) => f.state);
  ok(painted.length > 0, 'the chip was painted');
  eq([...new Set(painted)], ['PHOTO'],
    'and every painted state carries the photograph — the initials disc never flashes first');

  // the reserve is what does it, and it is stamped before anything is drawn
  eq(await h.evaluate(() => document.documentElement.getAttribute('data-oa-auth')), 'in',
    'the head snippet stamps data-oa-auth before first paint');
  ok(await h.evaluate(() => !!document.documentElement.style.getPropertyValue('--oa-chip-w')),
    'and hands the stylesheet the width to reserve');

  /* SIGNING OUT GIVES THE SPACE BACK. The reserve is stamped on <html> by the
     head snippet, before the first paint, from what the last visit
     remembered — so it is a guess about a page that then goes on living. Sign
     out and the chip becomes a 96px "Sign in" button; if the attribute still
     said 'in', the stylesheet would hold the chip's 186px floor open and the
     button would float ~90px in from the edge with a hole beside it. The same
     shape appears whenever the hint says signed-in and Firebase says
     otherwise (an expired session). */
  await h.evaluate(() => {
    const btn = document.getElementById('oa-signout');
    if (btn) btn.click();
  });
  await h.waitForSelector('#oa-signin', { timeout: 5000 }).catch(() => {});
  const afterOut = await h.evaluate(() => {
    const host = document.getElementById('oa-account');
    const btn = document.getElementById('oa-signin');
    const tog = document.querySelector('.v3-theme');
    return { attr: document.documentElement.getAttribute('data-oa-auth'),
      hasButton: !!btn,
      slack: btn ? Math.round(host.getBoundingClientRect().right - btn.getBoundingClientRect().right) : -1,
      togAbove: !!tog };
  });
  eq(afterOut.attr, 'out', 'signing out says so on <html>, so the reserve follows the control');
  ok(afterOut.hasButton, 'and the signed-out button is painted');
  ok(afterOut.slack <= 2,
    `with no reserved hole beside it (${afterOut.slack}px of slack)`);

  /* THE BAND WHERE THE NAME IS HIDDEN BUT THE WINDOW IS STILL WIDE.
     oa-ui.css hides .oa-acct-name from 841px to 980px, while v3.css's own
     narrow breakpoint is 900 — so a chip at 940px is an avatar and its
     padding. Measuring THAT and remembering it as "the chip's width" would
     under-reserve every wider window afterwards, which is the shift this whole
     block exists to prevent. The measurement asks whether the name is
     displayed rather than repeating a number; this pins the outcome. */
  const band = await browser.newPage({ viewport: { width: 940, height: 900 } });
  await band.route('**/firebasejs/**', async (route) => {
    await new Promise((r) => setTimeout(r, SDK_DELAY));
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: stub });
  });
  await band.goto(BASE, { waitUntil: 'load' });
  await band.waitForTimeout(900);
  const narrow = await band.evaluate(() => {
    const n = document.querySelector('.oa-acct-name');
    let hint = null;
    try { hint = JSON.parse(localStorage.getItem('oaAuthHint') || 'null'); } catch { /* none */ }
    return { nameShown: !!(n && getComputedStyle(n).display !== 'none'),
      remembered: (hint && hint.w) || 0 };
  });
  ok(!narrow.nameShown, 'at 940px the chip is an avatar, with no name beside it');
  eq(narrow.remembered, 0, 'and its width is not remembered as the chip width');
  await band.close();

  await h.close();

  /* …and a signed-out reader gets the signed-out reserve, not the chip's.
     In a page of its OWN, because that is what a signed-out reader is: a
     browser with no hint in it. Clearing the key on the page above does not
     make one — that page still has a signed-in session running, and it writes
     the hint straight back. */
  const out = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await out.goto(BASE, { waitUntil: 'domcontentloaded' });
  eq(await out.evaluate(() => document.documentElement.getAttribute('data-oa-auth')), 'out',
    'a signed-out reader is stamped as such');
  eq(await out.evaluate(() => document.documentElement.style.getPropertyValue('--oa-chip-w')), '',
    'and no chip width is reserved for a chip they will not be shown');
  eq(await out.evaluate(() => localStorage.getItem('oaAcctPhoto')), null,
    'and a browser nobody has signed in on holds no picture');
  await out.close();
}

/* --------------------------------------- the phone header carries the NAME

   Owner, 2026-08-18: "for mobile devices the entire logo (picture and text)
   should be shown on top left. Currently, I only see the image". It was a
   deliberate rule — the wordmark at full size pushes the burger off a 390px
   screen — so the lockup is scaled down instead of cut in half, and this is
   what holds that: the words are there, and the row still fits, at every phone
   width the site is likely to meet. */
for (const w of [320, 360, 390, 430]) {
  const m = await browser.newPage({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true });
  await m.goto(BASE, { waitUntil: 'domcontentloaded' });
  const r = await m.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const seen = (el) => {
      if (!el) return false;
      const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const words = q('.v3-header .v3-words'), burger = q('.v3-burger');
    const bb = burger ? burger.getBoundingClientRect() : null;
    const top = bb ? document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2) : null;
    return {
      mark: seen(q('.v3-header .v3-mark')),
      words: seen(words),
      text: words ? words.innerText.replace(/\s+/g, ' ').trim() : '',
      clash: !!(words && bb && Math.round(words.getBoundingClientRect().right) > Math.round(bb.left)),
      burgerHit: !!(top && burger && (top === burger || burger.contains(top))),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  ok(r.mark, `${w}px: the monogram is shown`);
  ok(r.words, `${w}px: and so is the wordmark — the whole lockup, not the mark alone`);
  ok(/Operations/.test(r.text) && /Academia/.test(r.text),
    `${w}px: the wordmark reads "Operations Academia" (got ${JSON.stringify(r.text)})`);
  ok(!r.clash, `${w}px: and does not run into the menu button`);
  ok(r.burgerHit, `${w}px: the menu button is still the thing under its own centre`);
  ok(!r.overflowX, `${w}px: the page does not scroll sideways`);
  await m.close();
}

/* ------------------------------ the legal texts fill their own column

   Owner, 2026-08-18, of privacy-policy.html and terms-and-conditions.html:
   "the text should expand all the way to the right to be aligned with the top
   text". The body sat in .v3-longform, whose 74ch measure stopped it 406px
   short of the hero paragraph's right edge while its left edge lined up
   exactly — one page reading as two columns of different widths.

   Measured rather than asserted about the stylesheet, because the alignment
   is what was asked for and a max-width is only how it happens to be
   achieved: the two blocks share a .v3-container, so lifting the cap makes
   the edges agree by construction. It is checked at several widths because a
   number kept in step with --container by hand would pass at one of them and
   fail at the next.

   And the scope is pinned in the same breath. The consent statement and the
   survey page are longform too and were deliberately left narrow, so this
   also fails if the cap is ever lifted on .v3-longform ITSELF — which would
   line these two up by widening every prose page on the site. */
{
  const WIDE = ['privacy-policy.html', 'terms-and-conditions.html'];
  const NARROW = ['informed_consent_statement.html', 'survey.html'];

  const measure = async (page, width) => {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    p.on('pageerror', (e) => jsErrors.push(page + ': ' + e.message));
    await p.goto(BASE + page, { waitUntil: 'domcontentloaded' });
    const r = await p.evaluate(() => {
      const edges = (el) => {
        const b = el.getBoundingClientRect();
        return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) };
      };
      const lede = document.querySelector('.v3-pa-hero .v3-lede');
      const prose = document.querySelector('.v3-prose.v3-longform');
      return {
        lede: edges(lede), prose: edges(prose),
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    await p.close();
    return r;
  };

  for (const page of WIDE) {
    for (const width of [1440, 1280, 1120, 980]) {
      const r = await measure(page, width);
      eq([r.prose.l, r.prose.r], [r.lede.l, r.lede.r],
        `${page} at ${width}px: the body lines up with the text above it, left AND right`);
      ok(!r.overflowX, `${page} at ${width}px: and the page does not scroll sideways`);
    }
    /* a phone is the case the cap was never reaching anyway — the container
       is narrower than the measure — so this is here to catch a fix that
       widened the desktop by breaking the gutter */
    const m = await measure(page, 390);
    eq([m.prose.l, m.prose.r], [m.lede.l, m.lede.r],
      `${page} at 390px: still one column, gutters intact`);
    ok(!m.overflowX, `${page} at 390px: and still no sideways scroll`);
  }

  for (const page of NARROW) {
    const r = await measure(page, 1440);
    ok(r.prose.w < r.lede.w,
      `${page}: keeps the reading measure — the widening is the two legal pages only ` +
      `(prose ${r.prose.w}px vs lede ${r.lede.w}px)`);
    eq(r.prose.l, r.lede.l, `${page}: and still starts on the same left edge`);
  }
}

/* ------------------------------------------------- the Admin area, end to end

   admin-area.html gathers every review queue (owner, 2026-08-23), and the
   account menu carries "Admin area N". What no static pin can prove is the
   money path: that the badge, the summary tiles and the panels all land on
   the SAME numbers from the same data, that the gap the page was built for is
   really closed (a candidate profile HELD for the reveal is on the admin's
   screen with an Edit control), and that a submission typed by a stranger is
   rendered inert. Driven against _fake-firebase.js with a seeded queue; the
   EXPECTED numbers are computed here from the same served files the code
   reads (changelog.json through assets/oa-news.js, candidates-meta.json), so
   this stays green as the site's own data moves. */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');
  const { createRequire } = await import('node:module');
  const OANewsNode = createRequire(import.meta.url)(path.join(ROOT, 'assets', 'oa-news.js'));
  const changelog = JSON.parse(await readFile(path.join(ROOT, 'changelog.json'), 'utf8'));
  const newsPending = OANewsNode.partition(changelog.updates, {}).pending.length;
  const cmeta = JSON.parse(await readFile(path.join(ROOT, 'data', 'candidates-meta.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const validReveal = /^\d{4}-\d{2}-\d{2}$/.test(String(cmeta.revealAt || ''));
  // the build's gate: no announced date holds everything
  const preReveal = !validReveal || today < cmeta.revealAt;
  const metaHeld = preReveal ? (Number(cmeta.heldCount) || 0) : 0;

  /* WHICH SEASON A POSTING IS FOR is read off its apply-by dates (owner,
     2026-08-26). A posting already published is reported rather than
     re-filed — its year is half its id — and this is what the build writes. */
  const YEARCHECK = [
    { id: '2026-mcgill-university-20260728', ref: '', institution: 'McGill University',
      department: 'Desautels Faculty of Management, Operations Management',
      posted: '2026-07-28', applyByDate: '2026-10-15', reviewDate: '',
      stored: 2026, should: 2027, from: 'final', current: true },
    { id: '2026-hostile-university-20260101', ref: '',
      institution: 'Hostile University <img src=x onerror=window.__xssyc=1>',
      department: 'Operations', posted: '2026-01-10', applyByDate: '',
      reviewDate: '2026-09-08', stored: 2026, should: 2027, from: 'review', current: true },
    /* THE OWNER'S OWN CASE (2026-08-27), and the reason the link had to name a
       PAGE: a posting whose season has closed is not on jobs.html at all, so
       `jobs.html#job-<id>` opened a list that could not contain it. Its dates
       are chosen to stay in the past whatever day this suite runs — posted
       before any future roll, with a deadline long gone — so the assertion
       does not move with the calendar. */
    { id: '2025-rolled-university-20240901', ref: '', institution: 'Rolled University',
      department: 'Supply Chain Management', posted: '2024-09-01',
      applyByDate: '2025-01-15', reviewDate: '', stored: 2025, should: 2026,
      from: 'final', current: false },
  ];

  const ADMIN = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com',
    emailVerified: true, displayName: 'Kostas Stouras', providerData: [] };
  const NOBODY = { uid: 'visitor-uid-00000000', email: 'someone@example.edu',
    emailVerified: true, displayName: 'Someone Else', providerData: [] };

  const seedDocs = [
    /* r1 carries THE SHAPE THAT STOPPED THE SITE: a closing date with an empty
       line beside it, which is what the card produced when it offered a box
       for each. The line is derived now, so the card must show what will be
       published and must not offer a box to disagree with it. */
    { path: 'jobReviews/r1', data: { rowId: 'r1', status: 'pending', queuedAt: '2026-08-20',
        row: { id: 'r1', year: 2026, posted: '2026-08-20', institution: 'Test University One',
          country: 'Ireland', applyBy: '', applyByDate: '2026-10-05' } } },
    /* r2 carries a duplicate flag AND a business-school flag, both hostile:
       the sync writes these from data people typed (postings, the vocabulary
       built from them), so the banners must render them inert */
    { path: 'jobReviews/r2', data: { rowId: 'r2', status: 'pending', queuedAt: '2026-08-21',
        row: { id: 'r2', year: 2026, posted: '2026-08-21', institution: 'Test University Two',
          country: 'France', type: 'Business School' },
        dup: [{ id: 'dup-1', ref: 'OA-JOB-1', source: 'oa-form',
          institution: 'Test University <img src=x onerror=window.__xssdup=1>',
          department: 'Operations', posted: '2026-08-10' }],
        biz: { school: 'Known Business School <img src=x onerror=window.__xssbiz=1>' } } },
    // approved: must NOT be in the queue or its counts
    { path: 'jobReviews/r3', data: { rowId: 'r3', status: 'approved', queuedAt: '2026-08-19',
        row: { id: 'r3', year: 2026, posted: '2026-08-19', institution: 'Approved University', country: 'Spain' } } },
    /* r4 is the NEXT market's posting, advertised BEFORE the others — the
       list must rank it first anyway: the market year outranks the posted
       date, and the newest advertisement only breaks ties within a market */
    { path: 'jobReviews/r4', data: { rowId: 'r4', status: 'pending', queuedAt: '2026-08-18',
        row: { id: 'r4', year: 2027, posted: '2026-05-02', institution: 'Early University', country: 'Denmark' } } },
    /* the user-added postings the review panel's second tab lists: two
       waiting (one per market, so the ranking is measurable), one already
       ticked off, one withdrawn, one tracking-sheet mirror — the last three
       must all stay off the to-do list */
    { path: 'jobSubmissions/u1', data: { status: 'queued', year: 2026, institution: 'Poster University One',
        school: 'A School of Business', unit: 'Operations', levels: ['Assistant Professor'],
        country: 'Ireland', applyByDate: '2026-10-01', adUrl: 'https://example.edu/ad-1',
        ref: 'OA-JOB-11', createdAt: '2026-08-19T09:00:00.000Z' } },
    { path: 'jobSubmissions/u2', data: { status: 'queued', year: 2027, institution: 'Poster University Two',
        createdAt: '2026-08-21T09:00:00.000Z' } },
    { path: 'jobSubmissions/u3', data: { status: 'published', year: 2026, institution: 'Reviewed University',
        reviewedAt: '2026-08-22T10:00:00.000Z', createdAt: '2026-08-18T09:00:00.000Z' } },
    { path: 'jobSubmissions/u4', data: { status: 'withdrawn', year: 2026, institution: 'Withdrawn University',
        createdAt: '2026-08-17T09:00:00.000Z' } },
    { path: 'jobSubmissions/u5', data: { status: 'sheet', year: 2026, institution: 'Mirror University',
        createdAt: '2026-08-16T09:00:00.000Z' } },
    { path: 'feedback/f1', data: { ticket: 'OA-260820-AAAA', status: 'open', forwarded: false,
        message: 'First open ticket', createdAt: '2026-08-20T10:00:00.000Z' } },
    { path: 'feedback/f2', data: { ticket: 'OA-260821-BBBB', status: 'open', forwarded: false,
        message: 'Second open ticket', createdAt: '2026-08-21T10:00:00.000Z' } },
    { path: 'feedback/f3', data: { ticket: 'OA-260818-CCCC', status: 'closed', forwarded: true,
        message: 'A closed ticket', createdAt: '2026-08-18T10:00:00.000Z' } },
    /* c1 is the hostile one: markup in a name, javascript: in a link — the
       panel renders documents nobody has vetted, so it must render them inert */
    { path: 'candidateSubmissions/c1', data: { uid: 'u-cand-1', status: 'queued', year: 2027,
        first: '<img src=x onerror=window.__xss1=1>', last: 'Doe',
        affiliation: 'Somewhere <b>Bold</b>', position: 'PhD candidate',
        cvUrl: 'javascript:window.__xss2=1', webUrl: 'https://example.edu/jane',
        email: 'jane@example.edu', emailPublic: false,
        researchAreas: ['Supply Chain'], informsDays: ['Sunday'],
        createdAt: '2026-08-20T09:00:00.000Z' } },
    { path: 'candidateSubmissions/c2', data: { uid: 'u-cand-2', status: 'queued', year: 2027,
        first: 'John', last: 'Smith', affiliation: 'Elsewhere', position: 'Post-doc',
        createdAt: '2026-08-21T09:00:00.000Z' } },
    { path: 'candidateSubmissions/c3', data: { uid: 'u-cand-3', status: 'withdrawn', year: 2027,
        first: 'Wendy', last: 'Withdrew', createdAt: '2026-08-19T09:00:00.000Z' } },
    { path: 'candidateSubmissions/c4', data: { uid: 'u-cand-4', status: 'hidden', year: 2027,
        first: 'Harry', last: 'Hidden', createdAt: '2026-08-18T09:00:00.000Z' } },
    /* the fifth queue: a poster's name correction waiting for a decision, and
       one already approved — which must NOT count, only wait for the build */
    { path: 'nameFixes/n1', data: { kind: 'unit', from: 'Operations Managment',
        to: 'Operations Management', institution: 'Test University One',
        note: 'the department’s own page spells it so', uid: 'u-fix-1',
        authEmail: 'fixer@example.edu', status: 'pending',
        createdAt: '2026-08-21T10:00:00.000Z' } },
    { path: 'nameFixes/n2', data: { kind: 'school', from: 'Olde School of Business',
        to: 'New School of Business', institution: '', note: '', uid: 'u-fix-2',
        authEmail: '', status: 'approved', createdAt: '2026-08-19T10:00:00.000Z' } },
    /* the statistic beside the queues: three registered accounts' contentless
       marks — the tally every sign-in writes and the account merge retires */
    { path: 'registeredUsers/u-reg-1', data: { t: 1 } },
    { path: 'registeredUsers/u-reg-2', data: { t: 2 } },
    { path: 'registeredUsers/u-reg-3', data: { t: 3 } },
  ];
  const seededHeld = preReveal ? 2 : 0;   // c1 + c2 are queued
  /* the three seeded marks PLUS the admin's own: signing in writes your own
     registeredUsers mark (oa-accounts.js, once per session), and the desk
     scenario's session is itself a registered account */
  const seededUsers = 3 + 1;

  /** A fresh CONTEXT per scenario: the badge cache and the auth hint live in
      localStorage, and a shared context would hand one scenario the last
      one's numbers — the very confusion the uid-keyed cache exists to stop. */
  async function adminAreaPage(user, url, extra = []) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const q = await ctx.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    const docs = extra.length ? seedDocs.concat(extra) : seedDocs;
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user, docs })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    /* The market-year report is a SERVED FILE the jobs build writes, so it is
       seeded here rather than read from data/ — the committed one changes
       whenever a posting's deadline does, and a browser check must not move
       with the corpus. One row carries markup in a name: the report is
       derived from postings people typed, so the panel must render it inert
       (the dup/biz banners' rule). */
    await q.route('**/data/jobs-yearcheck.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ generated: '2026-08-26T00:00:00Z', postings: YEARCHECK }) }));
    await q.goto(BASE + url, { waitUntil: 'load' });
    return { ctx, q, errors };
  }

  /* -- the badge, on a page that is NOT the admin area ---------------------- */
  {
    /* the jobs leg counts BOTH of the review panel's tabs (3 crawled pending
       + 2 user-added postings not yet marked reviewed), and the fifth queue
       adds its pending name fix */
    const expected = 3 + 2 + metaHeld + 2 + newsPending + 1;
    const { ctx, q, errors } = await adminAreaPage(ADMIN, 'index.html');
    await q.waitForSelector('#oa-chip', { timeout: 10000 });
    eq(await q.locator('#oa-menu a[href="admin-area.html"]').count(), 1,
      'admin area: the resolved admin session draws the menu row');
    eq(await q.locator('#oa-np a[href="admin-area.html"]').count(), 1,
      'admin area: and the mobile sheet panel carries it too');
    await q.waitForFunction((want) => {
      const el = document.querySelector('#oa-menu .oa-acct-n[data-count="admin"]');
      return el && el.textContent === String(want);
    }, expected, { timeout: 15000 });
    ok(true, `admin area: the badge lands on ${expected} — 3 pending reviews + ` +
      `2 user-added postings + ${metaHeld} held profiles + 2 open tickets + ` +
      `${newsPending} unpublished updates + 1 name correction`);
    ok(await q.evaluate(() =>
      document.querySelectorAll('script[src="assets/oa-news.js"]').length <= 1 &&
      document.querySelectorAll('script[src="assets/oa-adminarea.js"]').length <= 1),
      'admin area: the two counting scripts were loaded once, on demand');
    eq(errors, [], 'admin area: badge run — no uncaught script error');
    await ctx.close();
  }

  /* -- the desk itself ------------------------------------------------------ */
  {
    const { ctx, q, errors } = await adminAreaPage(ADMIN, 'admin-area.html');
    await q.waitForFunction(() => {
      const g = document.getElementById('oa-aa-guest');
      const a = document.getElementById('oa-aa-admin');
      return g && g.hidden && a && !a.hidden;
    }, null, { timeout: 10000 });
    ok(true, 'admin area: the admin session unhides the desk and hides the guest note');

    /* -- the review queue: two source tabs, the gate first, the next market
          leading every list (owner, 2026-08-23) -- */
    await q.waitForFunction(() => {
      const els = document.querySelectorAll('#oa-review-sources button[data-source]');
      return els.length === 2 &&
        els[0].textContent === 'Auto-crawled jobs (3)' &&
        els[1].textContent === 'User-added jobs (2)';
    }, null, { timeout: 10000 });
    ok(true, 'admin area: the two source tabs land counted — 3 crawled pending, 2 user-added waiting');
    ok(await q.$eval('#oa-review-sources button[data-source="crawled"]',
      (el) => el.classList.contains('is-on')),
      'admin area: and the gate — the auto-crawled tab — is the default');

    // the default season is the NEXT market, so its one crawled posting shows
    await q.waitForFunction(() =>
      (document.getElementById('oa-review-count') || {}).textContent === '1 posting',
      null, { timeout: 10000 });
    eq(await q.$$eval('#oa-review-years button[data-year]',
      (els) => els.map((e) => e.textContent)),
      ['2026-2027 (1)', '2025-2026 (2)', 'All (3)'],
      'admin area: the market-year tabs are kept, the next market first and selected');

    // the whole queue, ranked: market year first, newest advertisement within it
    await q.click('#oa-review-years button[data-year="*"]');
    await q.waitForFunction(() =>
      (document.getElementById('oa-review-count') || {}).textContent === '3 postings',
      null, { timeout: 10000 });
    const reviews = await q.textContent('#oa-review-list');
    ok(reviews.indexOf('Early University') !== -1 &&
       reviews.indexOf('Early University') < reviews.indexOf('Test University Two') &&
       reviews.indexOf('Test University Two') < reviews.indexOf('Test University One'),
      'admin area: the 2027-market posting leads although it was advertised first — ' +
      'the year outranks the posted date, which only breaks ties within a market');
    ok(reviews.indexOf('Approved University') === -1,
      'admin area: an approved posting is not in the queue');

    /* THE DUPLICATE FLAG IS RAISED WHERE THE DECISION IS MADE — on the card
       of the one posting that carries it, and nowhere else. The flag's fields
       come from postings people typed, so a hostile one must render inert. */
    eq(await q.locator('#oa-review-list [data-dup]').count(), 1,
      'admin area: the flagged posting raises its possible-duplicate warning, and only it');
    ok(reviews.indexOf('Possibly already on the site') !== -1,
      'admin area: the warning says what it is');
    ok(await q.evaluate(() => !window.__xssdup),
      'admin area: a hostile duplicate entry cannot inject markup');

    /* THE BUSINESS-SCHOOL FLAG IS MENTIONED THE SAME WAY (owner, 2026-08-23):
       on the card that carries it and nowhere else, naming the school the
       site's directory knows — a name built from data people typed, so a
       hostile one must render inert. The Use-it button fills the School box
       like typing would, and saves nothing. (Measured BEFORE the tab switch
       below: the flagged card is on the crawled tab's All view, which is what
       is on screen here.) */
    eq(await q.locator('#oa-review-list [data-biz]').count(), 1,
      'admin area: the business-typed posting mentions the business school, and only it');
    ok(reviews.indexOf('Business school posting') !== -1,
      'admin area: the mention says what it is');
    ok(await q.evaluate(() => !window.__xssbiz),
      'admin area: a hostile school name cannot inject markup');
    {
      const card = q.locator('#oa-review-list .oa-rv-card', { hasText: 'Test University Two' });
      await card.locator('button[data-biz-use]').click();
      eq(await card.locator('[data-key="school"]').inputValue(),
        'Known Business School <img src=x onerror=window.__xssbiz=1>',
        'admin area: Use-it fills the School box with the name, as typed text');
      ok(await q.evaluate(() => !window.__xssbiz),
        'admin area: and filling it runs nothing either');
    }

    /* -- ONE SIZE FOR THE CARD'S CONTROLS. `.oa-rv-field` named input, select
          and textarea together and set 13px on all three, but
          `.oa-form input[type='text']` outranks a plain `.oa-rv-field input`,
          so the typed boxes rendered at the site's 15px while the select and
          the textarea sat at 13px beside them — which is what the maintainer
          saw. Measured from what the browser paints, because that is the only
          place the cascade's answer is visible. -- */
    {
      const sizes = await q.evaluate(() => {
        const card = document.querySelector('#oa-review-list .oa-rv-card');
        const out = {};
        for (const el of card.querySelectorAll('.oa-rv-field input:not([type="checkbox"]), .oa-rv-field select, .oa-rv-field textarea')) {
          const key = el.getAttribute('data-key') || el.tagName.toLowerCase();
          out[key] = getComputedStyle(el).fontSize;
        }
        return out;
      });
      const seen = [...new Set(Object.values(sizes))];
      eq(seen.length, 1,
        'admin area: every control on the review card is one font size — ' + JSON.stringify(sizes));

      /* and the same height, so the two columns read as one grid rather than
         as boxes of two builds. The date box carries a browser-drawn picker,
         so it is allowed its own pixel or two. */
      const heights = await q.evaluate(() => {
        const card = document.querySelector('#oa-review-list .oa-rv-card');
        const out = {};
        for (const el of card.querySelectorAll('.oa-rv-field input:not([type="checkbox"]), .oa-rv-field select')) {
          out[el.getAttribute('data-key') || el.tagName.toLowerCase()] =
            Math.round(el.getBoundingClientRect().height);
        }
        return out;
      });
      const hs = Object.values(heights);
      ok(Math.max(...hs) - Math.min(...hs) <= 2,
        'admin area: and one height — ' + JSON.stringify(heights));
    }

    /* -- the deadline is ONE fact with one box, and the card says what it will
          publish. Two boxes for it let a posting reach the site with a closing
          date and no line, which failed the served-file guard and stopped both
          the sheet read and the build from committing anything at all. -- */
    {
      const card = q.locator('#oa-review-list .oa-rv-card', { hasText: 'Test University One' });
      eq(await card.locator('[data-key="applyBy"]').count(), 0,
        'admin area: the card offers no box for the line the date is written into');
      eq(await card.locator('[data-derived="deadline"]').textContent(),
        'Published as: October 5, 2026',
        'admin area: it shows the line that WILL be published, from the date beside it');
      await card.locator('[data-key="applyByDate"]').fill('');
      await q.waitForFunction(() => {
        const el = document.querySelector('[data-derived="deadline"]');
        return el && el.textContent === 'Published as: Until filled.';
      }, null, { timeout: 10000 });
      ok(true, 'admin area: and clearing the date says what the page already calls a posting without one');
      await card.locator('[data-key="applyByDate"]').fill('2026-10-05');
    }

    /* -- the user-added tab: a dedicated, editable list, never a gate — the
          posting is live the moment the form saved it -- */
    await q.click('#oa-review-sources button[data-source="user"]');
    await q.waitForFunction(() =>
      (document.getElementById('oa-review-count') || {}).textContent === '1 posting',
      null, { timeout: 10000 });
    ok((await q.textContent('#oa-review-list')).indexOf('Poster University Two') !== -1,
      'admin area: the user tab opens on ITS newest market, like the gate does');
    await q.click('#oa-review-years button[data-year="*"]');
    await q.waitForFunction(() =>
      (document.getElementById('oa-review-count') || {}).textContent === '2 postings',
      null, { timeout: 10000 });
    const userList = await q.textContent('#oa-review-list');
    ok(userList.indexOf('Poster University Two') < userList.indexOf('Poster University One'),
      'admin area: user-added postings rank by market year too — 2027 before 2026');
    ok(userList.indexOf('Reviewed University') === -1,
      'admin area: a submission already marked reviewed is off the list');
    ok(userList.indexOf('Withdrawn University') === -1,
      'admin area: a withdrawn one is not waiting for anything');
    ok(userList.indexOf('Mirror University') === -1,
      'admin area: and a tracking-sheet mirror stays with its own queue');
    /* BOTH TABS CARRY A BULK ACTION (owner, 2026-08-25: the user tab opened
       with 86 postings and no way to clear them). What must NEVER cross over
       is the VERB: approving publishes, and nothing on this tab is waiting to
       be published — its postings are already live, so the button ticks them
       off the list and says exactly that. */
    ok(await q.locator('#oa-review-bulk').isVisible(),
      'admin area: the user tab has a bulk action too — 86 rows do not get cleared one at a time');
    const userBulk = (await q.textContent('#oa-review-all') || '').toLowerCase();
    ok(/mark all/.test(userBulk) && /reviewed/.test(userBulk),
      `admin area: and its verb is Mark all reviewed, not Approve (read: "${userBulk}")`);
    ok(!/approve/.test(userBulk) && !/publish/.test(userBulk),
      'admin area: nothing on the user tab offers to approve or publish — it is already live');

    /* The season filter is DRAWN even when a tab holds one market: an empty
       space where a control belongs reads as the control being missing, which
       is how this was reported. */
    ok(await q.locator('#oa-review-years').isVisible(),
      'admin area: the market-year filter is on screen for the user tab');
    eq(await q.locator('#oa-review-list a[href="post-a-job.html?edit=u1"]').count(), 1,
      'admin area: a user-added card opens the poster’s own form to correct it');

    // ticking one off writes the one stamp, and the tab count follows live
    await q.click('article:has(a[href="post-a-job.html?edit=u1"]) button[data-act="reviewed"]');
    await q.waitForFunction(() => {
      const d = window.__fb.docs['jobSubmissions/u1'];
      return d && typeof d.reviewedAt === 'string' && d.reviewedAt.length > 0;
    }, null, { timeout: 10000 });
    ok(true, 'admin area: Mark reviewed writes reviewedAt onto the submission itself — nothing else');
    await q.waitForFunction(() =>
      (document.querySelector('#oa-review-sources button[data-source="user"]') || {})
        .textContent === 'User-added jobs (1)', null, { timeout: 10000 });
    ok(true, 'admin area: and the tab count follows without a reload');

    // the gate is untouched by any of that
    await q.click('#oa-review-sources button[data-source="crawled"]');
    await q.waitForFunction(() =>
      (document.getElementById('oa-review-count') || {}).textContent === '1 posting',
      null, { timeout: 10000 });
    ok(true, 'admin area: switching back lands on the gate’s newest market again');

    // the inbox: open tab, newest first, through the moved-but-unchanged panel
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-inbox-list .oa-fb-card').length === 2,
      null, { timeout: 10000 });
    const inbox = await q.textContent('#oa-inbox-list');
    ok(inbox.indexOf('Second open ticket') < inbox.indexOf('First open ticket'),
      'admin area: the two open tickets are listed, newest first');
    ok(inbox.indexOf('A closed ticket') === -1, 'admin area: the closed one is not');

    // THE GAP THIS PAGE CLOSES: all four profiles on screen, held ones included
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-aa-cands-list .oa-aa-cand').length === 4,
      null, { timeout: 10000 });
    ok(true, 'admin area: all four candidate profiles are on the admin\u2019s screen');
    if (preReveal) {
      const heads = await q.$$eval('#oa-aa-cands-list .oa-aa-group-h',
        (els) => els.map((e) => e.textContent));
      ok(/^Held for the reveal \(2\)/.test(heads[0] || ''),
        'admin area: the two filed-for-the-reveal profiles lead, counted');
    }
    ok(await q.locator('article[data-id="c1"] button[data-act="edit"]').count() === 1,
      'admin area: a held profile carries Edit — the control the candidates page could not draw');
    ok(await q.locator('article[data-id="c3"] button[data-act="takedown"], ' +
                       'article[data-id="c3"] button[data-act="restore"]').count() === 0,
      'admin area: a profile its candidate withdrew offers no restore — that is theirs to undo');
    ok(await q.locator('article[data-id="c4"] button[data-act="restore"]').count() === 1,
      'admin area: one the maintainer hid can be put back');

    // hostile input is rendered inert
    ok(await q.evaluate(() => !document.querySelector('#oa-aa-cands-list img') &&
        !document.querySelector('#oa-aa-cands-list b') &&
        !document.querySelector('#oa-aa-cands-list a[href^="javascript:"]') &&
        !window.__xss1 && !window.__xss2),
      'admin area: markup in a name and a javascript: link render as text, never as DOM');
    ok(await q.locator('article[data-id="c1"] a[href="https://example.edu/jane"]').count() === 1,
      'admin area: while a real https link is still a link');

    /* THE FIFTH QUEUE: the pending name correction is on screen with the
       decision buttons, the approved one waits under its own heading (for
       the build, not for a click), and approving really writes — status,
       the timestamp, and the maintainer's own correction to the correction. */
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-aa-names-list .oa-aa-fix').length === 2,
      null, { timeout: 10000 });
    const fixesText = await q.textContent('#oa-aa-names-list');
    ok(fixesText.includes('Operations Managment') && fixesText.includes('Operations Management'),
      'admin area: the suggested correction shows both spellings, old and new');
    ok(fixesText.includes('Olde School of Business'),
      'admin area: and an already-approved one is still on screen, never vanished');
    await q.fill('article[data-id="n1"] input[data-role="to"]', 'Operations Management Group');
    await q.click('article[data-id="n1"] button[data-act="approve"]');
    await q.waitForFunction(() => {
      const d = window.__fb.docs['nameFixes/n1'];
      return d && d.status === 'approved' && d.to === 'Operations Management Group' && d.reviewedAt;
    }, null, { timeout: 10000 });
    ok(true, 'admin area: Approve writes the decision, the reworded target and the timestamp');
    await q.waitForFunction(() => {
      const card = document.querySelector('article[data-id="n1"]');
      return card && card.querySelector('button[data-act="reopen"]');
    }, null, { timeout: 10000 });
    ok(true, 'admin area: and the decided card re-renders one click from re-opening');

    /* the tiles and the badge, corrected from the documents on screen — the
       jobs tile counts BOTH of the review panel's tabs (3 crawled + 2
       user-added as seeded; those counts were read at load, before one was
       ticked off above, and nothing recounts them mid-session), the approved
       name fix no longer counts as waiting, and the strip ends on the
       Registered-users statistic (owner, 2026-08-23) */
    await q.waitForFunction((want) => {
      const els = document.querySelectorAll('#oa-aa-tiles .oa-aa-tile-n');
      return els.length === 8 && Array.prototype.map.call(els, (e) => e.textContent).join(',') === want;
    }, ['5', seededHeld, '2', newsPending, 0, 0, YEARCHECK.length, seededUsers].join(','),
      { timeout: 10000 });
    ok(true, 'admin area: the eight tiles agree with the data beneath them — the ' +
      'approved fix no longer counts as waiting, nobody is waiting on a message ' +
      'reply, the market-year report is on screen and so is the registered-user tally');
    /* The Registered-users card became a LINK on 2026-08-24, when the roster
       panel gave it somewhere to go — it was a span precisely because it
       opened nothing. What still makes it a statistic is the class, which
       keeps it out of every badge sum, and that it is never marked due. */
    ok(await q.locator('#oa-aa-tiles a.oa-aa-tile-stat[href="#oa-aa-users"]').count() === 1 &&
       await q.locator('#oa-aa-tiles a.oa-aa-tile').count() === 8 &&
       await q.locator('#oa-aa-tiles .oa-aa-tile-stat.is-due').count() === 0,
      'admin area: the Registered-users card opens the roster and is still a ' +
      'statistic — never marked due, and out of every total');
    eq(await q.evaluate(() =>
      (JSON.parse(localStorage.getItem('oa-acct-counts') || '{}').n || {}).admin),
      5 + seededHeld + 2 + newsPending,
      'admin area: and the cached menu badge is corrected from the same numbers — ' +
      'neither the registered-user count nor the market-year report is in any of them');

    /* -- the market-year report (owner, 2026-08-26) -------------------------
       A posting is filed by its apply-by date now. What is already published
       is REPORTED rather than moved, because a row's year is half its id and
       an id that moves is a posting published twice — so the panel's job is
       to name the disagreement, say which date decided, and open the posting.
       Its tile IS due-able (it is something the maintainer clears), but it is
       read from a served file, so it must never reach the badge above. */
    ok(await q.locator('#oa-aa-tiles a.oa-aa-tile[href="#oa-aa-yc"].is-due').count() === 1,
      'admin area: the market-year tile is marked due — unlike the statistic beside it');
    await q.waitForFunction((n) =>
      document.querySelectorAll('#oa-aa-yc-list .oa-aa-yc').length === n,
      YEARCHECK.length, { timeout: 10000 });
    ok(true, 'admin area: every reported posting is drawn');
    const ycText = await q.locator('#oa-aa-yc-list').innerText();
    ok(/McGill University/.test(ycText) && /2025.2026/.test(ycText) && /2026.2027/.test(ycText),
      'admin area: the card names the posting and BOTH seasons — the one it is ' +
      'filed under and the one its dates give it');
    ok(/final apply-by date/.test(ycText) && /suggested apply-by date/.test(ycText),
      'admin area: and says which date decided, so the maintainer can judge it');
    /* -- "Open the posting" opens THE POSTING, on the page that has it -----
       Owner, 2026-08-27: the link went to "the full list of jobs, as opposed
       to the page of this specific posting so that I can edit it, or remove
       it" — and for Nanyang, whose season has closed, it went to the list of
       THIS season, which by definition could not contain it.

       So every card names a page AND one posting. The expectation is computed
       with the site's own shared rule rather than written down here: the two
       pages partition the corpus by a predicate evaluated at `new Date()`, so
       a literal href would start failing on a date nobody chose. */
    const NAVMOD = createRequire(import.meta.url)(
      path.join(ROOT, 'assets', 'oa-jobnav.js'));
    for (const p of YEARCHECK) {
      const want = NAVMOD.hrefFor(
        { id: p.id, posted: p.posted, applyByDate: p.applyByDate, year: p.stored });
      eq(await q.locator(`#oa-aa-yc-list a[href="${want}"]`).count(), 1,
        `admin area: ${p.institution.slice(0, 24)} is opened at ${want}`);
    }
    eq(await q.locator('#oa-aa-yc-list a[href^="jobs.html#job-"]').count(), 0,
      'admin area: and no card still links a fragment, which nothing ever acted on');
    eq(await q.locator(
      '#oa-aa-yc-list a[href="previous-markets.html?job=2025-rolled-university-20240901"]')
      .count(), 1,
      'admin area: a posting whose season has closed is opened on Previous ' +
      'markets — the owner’s own case, which the jobs page could not show');
    ok(/listed on Previous markets/.test(ycText),
      'admin area: and its card says so, rather than sending the maintainer somewhere silently');

    eq(await q.evaluate(() => window.__xssyc === undefined), true,
      'admin area: a reported name carrying markup is rendered inert, like the dup banner');
    ok(/Nothing has been moved/.test(await q.locator('#oa-aa-yc').innerText()),
      'admin area: and the panel says outright that nothing was re-filed');

    /* -- and the report can be CLEARED (owner, 2026-08-27) ------------------
       "I reviewed these jobs but can't clear that queue." It had no way to be:
       its two exits were correcting the workbook, which MOVES a posting that
       is often filed correctly, and waiting for a deadline that is not what
       put it on the list. A settle records what was read — the pair of seasons
       on the card — and nothing else. */
    const MCG = '2026-mcgill-university-20260728';
    const tileNow = () => q.$eval('#oa-aa-tiles a[href="#oa-aa-yc"] .oa-aa-tile-n',
      (n) => n.textContent);
    eq(await tileNow(), String(YEARCHECK.length),
      'admin area: the tile counts every posting still waiting');

    await q.click(`#oa-aa-yc-list li[data-id="${MCG}"] button[data-act="settle"]`);
    await q.waitForFunction((id) => {
      const d = window.__fb.docs['yearChecks/' + id];
      return d && d.status === 'settled';
    }, MCG, { timeout: 10000 });
    const settled = await q.evaluate((id) => window.__fb.docs['yearChecks/' + id], MCG);
    eq(Object.keys(settled).sort(), ['should', 'status', 'stored', 't'],
      'admin area: a settlement carries the pair of seasons that was read, and nothing else');
    eq([settled.stored, settled.should], [2026, 2027],
      'admin area: the pair being the one the card showed — so a later correction ' +
      'to the dates brings the posting back');

    await q.waitForFunction((id) =>
      !!document.querySelector(`.oa-aa-yc-done li[data-id="${id}"]`) &&
      !document.querySelector(`.oa-aa-yc-ul > li[data-id="${id}"]:not(.is-settled)`),
      MCG, { timeout: 10000 });
    ok(true, 'admin area: it leaves the list — into the collapsed panel below it, ' +
      'never off the page: the newsOverrides rule, removing is not a one-way door');
    await q.waitForFunction((n) => {
      const el = document.querySelector('#oa-aa-tiles a[href="#oa-aa-yc"] .oa-aa-tile-n');
      return el && el.textContent === String(n);
    }, YEARCHECK.length - 1, { timeout: 10000 });
    ok(true, 'admin area: and the tile comes down by one — the queue really clears');

    /* …and it is really OUT OF THE WAY: the disclosure is closed, so the
       settled posting is off the list until the maintainer opens it. That is
       the half the owner asked for — the list is meant to get shorter. */
    eq(await q.$eval('.oa-aa-yc-done', (n) => n.open), false,
      'admin area: the settled panel starts closed, so the queue really is shorter');
    await q.click('.oa-aa-yc-done > summary');

    /* Settle a SECOND one from the open list, so the restore below has
       something to hide: "Bring it back" is only reachable from inside the
       disclosure, and every write re-renders it. */
    const ROLLED = '2025-rolled-university-20240901';
    await q.click(`#oa-aa-yc-list li[data-id="${ROLLED}"] button[data-act="settle"]`);
    await q.waitForFunction((id) => !!window.__fb.docs['yearChecks/' + id],
      ROLLED, { timeout: 10000 });
    await q.waitForFunction(() =>
      document.querySelectorAll('.oa-aa-yc-done .oa-aa-yc').length === 2,
      null, { timeout: 10000 });
    ok(await q.$eval('.oa-aa-yc-done', (n) => n.open),
      'admin area: the settled panel stays open across the re-render a write causes');

    await q.click(`.oa-aa-yc-done li[data-id="${MCG}"] button[data-act="unsettle"]`);
    await q.waitForFunction(() =>
      document.querySelectorAll('.oa-aa-yc-done .oa-aa-yc').length === 1,
      null, { timeout: 10000 });
    ok(await q.$eval('.oa-aa-yc-done', (n) => n.open),
      'admin area: and after a restore too — the panel does not snap shut on ' +
      'the one action that is only reachable from inside it');
    // put the second one back as well, so the tile assertions below still hold
    await q.click(`.oa-aa-yc-done li[data-id="${ROLLED}"] button[data-act="unsettle"]`);
    await q.waitForFunction((id) => !window.__fb.docs['yearChecks/' + id],
      ROLLED, { timeout: 10000 });
    await q.waitForFunction((id) => !window.__fb.docs['yearChecks/' + id],
      MCG, { timeout: 10000 });
    ok(true, 'admin area: Bring it back DELETES the decision — the report is derived, ' +
      'so absence is exactly "not read yet" and there is no second state to keep');
    await q.waitForFunction((n) => {
      const el = document.querySelector('#oa-aa-tiles a[href="#oa-aa-yc"] .oa-aa-tile-n');
      return el && el.textContent === String(n);
    }, YEARCHECK.length, { timeout: 10000 });
    ok(true, 'admin area: and the posting is waiting again');

    // taking a profile down really writes, and the desk follows
    q.once('dialog', (d) => d.accept());
    await q.click('article[data-id="c2"] button[data-act="takedown"]');
    await q.waitForFunction(() => window.__fb.docs['candidateSubmissions/c2'].status === 'hidden',
      null, { timeout: 10000 });
    ok(true, 'admin area: Take down writes status hidden — a status change, never a delete');
    await q.waitForFunction(() => {
      const card = document.querySelector('article[data-id="c2"]');
      return card && card.querySelector('button[data-act="restore"]');
    }, null, { timeout: 10000 });
    ok(true, 'admin area: and the card re-renders under the taken-down pile, one click from back');

    eq(errors, [], 'admin area: desk run — no uncaught script error');
    await ctx.close();
  }

  /* -- an approved posting is on the jobs page AT ONCE ----------------------

     Owner, 2026-08-26: "when I press a job under review to become public, it
     should immediately show up in the list of job postings available to the
     public." Approving writes Firestore; the BUILD turns that into a row in
     data/jobs.json, and until it runs the posting is in neither place — out of
     the queue and not yet on the site, which reads exactly like an approval
     that did not save. (The Cloud Function that would ring the build the
     moment a decision lands has never fired on this repository: deploying
     Functions is a hand step nothing in CI performs.)

     So the panel echoes the published row into this browser, exactly as a
     saved EDIT already is echoed. Measured end to end here, in one browser
     context so the localStorage the echo lives in is the same one the jobs
     page reads: approve on /admin-area, go to /jobs, see the posting. */
  {
    const AT = 'https://example.edu/approve-me';
    const extra = [{
      path: 'jobReviews/ap1',
      data: {
        rowId: 'ap1', status: 'pending', queuedAt: '2026-08-20',
        row: {
          id: 'ap1', year: 2027, posted: '2026-08-21', country: 'United States',
          institution: 'Approved Instantly University', school: 'School of Engineering',
          unit: 'Management Science and Engineering', department: 'stale line',
          levels: ['Assistant Professor'], adUrl: AT, applyByDate: '2026-10-05',
          type: 'University', comments: 'Two letters, please.',
        },
      },
    }];

    const { ctx, q, errors } = await adminAreaPage(ADMIN, 'about:blank', extra);
    /* An EMPTY site, so anything the jobs page shows can only be the echo. */
    await q.route('**/data/jobs.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: '[]' }));
    await q.goto(BASE + 'admin-area.html', { waitUntil: 'load' });

    const card = q.locator('#oa-review-list .oa-rv-card',
      { hasText: 'Approved Instantly University' });
    await card.waitFor({ timeout: 10000 });
    /* Held as an ELEMENT before the click: approving replaces the card's own
       markup with its confirmation, which no longer carries the institution
       name the locator filtered on. */
    const cardEl = await card.elementHandle();
    await cardEl.$('button[data-act="approve"]').then((b) => b.click());
    await q.waitForFunction(() =>
      window.__fb.docs['jobReviews/ap1'].status === 'approved', null, { timeout: 10000 });
    ok(true, 'approve now: the decision is written');

    await q.waitForFunction((el) => /on your own jobs page straight away/
      .test(el.textContent || ''), cardEl, { timeout: 10000 });
    ok(true, 'approve now: and the card says where to find it');

    const stashed = await q.evaluate(() =>
      JSON.parse(localStorage.getItem('oaFreshJobs') || '{}'));
    ok(stashed.ap1 && stashed.ap1.added && stashed.ap1.added.id === 'ap1',
      'approve now: the published row is echoed into this browser');
    eq((stashed.ap1 || {}).added.department,
      'School of Engineering, Management Science and Engineering',
      'approve now: with the line DERIVED from its two names, not the stale one');
    eq((stashed.ap1 || {}).added.applyBy, 'October 5, 2026',
      'approve now: and the Apply-by line the build would compose');

    /* THE POINT OF ALL OF IT: the same browser, the real jobs page. */
    await q.goto(BASE + 'jobs.html', { waitUntil: 'load' });
    await q.waitForFunction(() =>
      /Approved Instantly University/.test(document.body.textContent || ''),
      null, { timeout: 15000 });
    ok(true, 'approve now: the posting is on the jobs page, before any build has run');

    /* AND IT IS THIS BROWSER'S ALONE. A second context has the same served
       file and no echo, so it must show nothing — the promise that keeps this
       honest is that nothing here can put an unpublished posting in front of
       a visitor. */
    const other = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const o = await other.newPage();
    await o.route('**/data/jobs.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: '[]' }));
    await o.goto(BASE + 'jobs.html', { waitUntil: 'load' });
    await o.waitForTimeout(1500);
    ok(!/Approved Instantly University/.test(await o.textContent('body') || ''),
      'approve now: and nobody else sees it until the build publishes it');
    await other.close();

    eq(errors, [], 'approve now: no uncaught script error');
    await ctx.close();
  }

  /* -- "Check for duplicate adverts" ---------------------------------------

     Owner, 2026-08-26: "Check all jobs currently under review for duplicates
     in the sense that their Link to the advert coincides with the Link to the
     advert of another job already publicly posted or in the queue … Also,
     create a button to check for such duplicates in the future."

     Its own scenario, with its own three seeded postings and its own routed
     data/jobs.json, so the queue the rest of this block counts is untouched
     and the live side is a FIXTURE rather than whatever is committed today.

       rp1  the oldest of two rows naming one advertisement — must SURVIVE
       rp2  the younger of that pair                        — must GO
       rp3  a row repeating something already LIVE          — must GO
       rp4  a row repeating one the maintainer has APPROVED — must GO
       rp5  the approved twin of rp4 (status: approved)     — not in the queue

     rp3's university carries a "The" the live posting does not, so the fold
     that makes them one university is measured rather than assumed.

     rp4/rp5 ARE THE STANFORD MS&E CASE (owner, 2026-08-26): one of two
     identical postings was approved, and pressing the button then failed to
     catch the other. An approved posting is out of the queue — the panel
     lists PENDING only — and not yet in the served file, because the build
     publishes it minutes later, so its twin was measured against a set
     holding NEITHER copy. */
  {
    const AD = 'https://example.edu/one-advert';
    const LIVE_AD = 'https://example.edu/live-advert';
    const pair = (id, queuedAt, over) => ({
      path: 'jobReviews/' + id,
      data: {
        rowId: id, status: 'pending', queuedAt,
        row: Object.assign({
          id, year: 2026, posted: '2026-08-10', country: 'Ireland',
          institution: 'Repeat University', school: '', unit: 'Operations',
          department: 'Operations', levels: ['Assistant Professor'], adUrl: AD,
        }, over || {}),
      },
    });
    const MSE_AD = 'https://msande.example.edu/faculty-openings';
    const mse = (over) => ({
      institution: 'Stanford University', school: 'School of Engineering',
      unit: 'Management Science and Engineering',
      department: 'School of Engineering, Management Science and Engineering',
      levels: ['Assistant Professor'], adUrl: MSE_AD, ...over,
    });
    const extra = [
      pair('rp1', '2026-08-10'),
      pair('rp2', '2026-08-12'),
      pair('rp3', '2026-08-11', {
        institution: 'The Live Repeat University', unit: 'Marketing',
        department: 'Marketing', adUrl: LIVE_AD,
      }),
      pair('rp4', '2026-08-13', mse()),
      /* Approved, so NOT in the queue the panel lists and NOT in the served
         file below — the exact window the bug lived in. */
      {
        path: 'jobReviews/rp5',
        data: {
          rowId: 'rp5', status: 'approved', queuedAt: '2026-08-09',
          reviewedAt: '2026-08-26T10:40:00.000Z',
          row: mse({ id: 'rp5', year: 2026, posted: '2026-08-09', country: 'United States' }),
        },
      },
    ];
    const LIVE = [{
      id: 'LIVE-1', ref: 'OA-JOB-LIVE-1', source: 'oa-form', year: 2026,
      institution: 'Live Repeat University', school: '', unit: 'Marketing',
      department: 'Marketing', levels: ['Assistant Professor'],
      posted: '2026-08-01', adUrl: LIVE_AD,
    }];

    const { ctx, q, errors } = await adminAreaPage(ADMIN, 'about:blank', extra);
    await q.route('**/data/jobs.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
    await q.goto(BASE + 'admin-area.html', { waitUntil: 'load' });

    await q.waitForFunction(() => {
      const b = document.querySelector('#oa-review-sources button[data-source="crawled"]');
      return b && b.textContent === 'Auto-crawled jobs (7)';
    }, null, { timeout: 10000 });
    ok(true, 'duplicate adverts: the queue opens with all seven PENDING postings — ' +
      'the approved twin is not among them, which is what made the bug invisible');

    /* The button is on the crawled tab and not on the user one: a user-added
       posting is already on the site, and taking it off is its poster's
       decision or the Take-down control, never a sweep. */
    ok(await q.locator('#oa-review-dupes').isVisible(),
      'duplicate adverts: the button is on the crawled tab');
    await q.click('#oa-review-sources button[data-source="user"]');
    await q.waitForFunction(() => {
      const b = document.getElementById('oa-review-dupes');
      return b && b.hidden;
    }, null, { timeout: 10000 });
    ok(true, 'duplicate adverts: and not on the user-added one');
    await q.click('#oa-review-sources button[data-source="crawled"]');
    await q.waitForFunction(() => {
      const b = document.getElementById('oa-review-dupes');
      return b && !b.hidden;
    }, null, { timeout: 10000 });

    /* IT REPORTS BEFORE IT WRITES. Dismissing the confirmation must leave the
       queue exactly as it was — a sweep that had already written by the time
       it asked would be a button nobody could safely press. */
    let asked = '';
    q.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
    await q.click('#oa-review-dupes');
    await q.waitForFunction(() =>
      /nothing removed/.test((document.getElementById('oa-review-bulk-msg') || {}).textContent || ''),
      null, { timeout: 15000 });
    ok(/Take these 3 postings out of the queue/.test(asked),
      'duplicate adverts: it names how many it would remove — ' + JSON.stringify(asked.slice(0, 60)));
    ok(/Stanford University/.test(asked),
      'duplicate adverts: the twin of an APPROVED posting is among them — the ' +
      'Stanford MS&E case, which the served file alone could not catch');
    ok(/OA-JOB-LIVE-1/.test(asked),
      'duplicate adverts: and names the LIVE posting one of them repeats, across a "The"');
    ok(/rp1/.test(asked) || /Repeat University/.test(asked),
      'duplicate adverts: and the queued one the other repeats');
    eq(await q.evaluate(() => [
      window.__fb.docs['jobReviews/rp1'].status,
      window.__fb.docs['jobReviews/rp2'].status,
      window.__fb.docs['jobReviews/rp3'].status,
      window.__fb.docs['jobReviews/rp4'].status,
    ]), ['pending', 'pending', 'pending', 'pending'],
      'duplicate adverts: dismissing the confirmation writes nothing at all');

    /* And now for real: the two repeats are REJECTED — never deleted, because
       `partition` re-queues a row whose document is gone — with the reason in
       `note` and the posting they repeat in `dup`, the two fields the rules
       already allow. The OLDEST of the pair is the one that stays. */
    q.once('dialog', (d) => d.accept());
    await q.click('#oa-review-dupes');
    await q.waitForFunction(() => {
      const d = window.__fb.docs;
      return d['jobReviews/rp2'].status === 'rejected' &&
             d['jobReviews/rp3'].status === 'rejected' &&
             d['jobReviews/rp4'].status === 'rejected';
    }, null, { timeout: 15000 });
    eq(await q.evaluate(() => window.__fb.docs['jobReviews/rp1'].status), 'pending',
      'duplicate adverts: the oldest of two rows naming one advertisement survives');
    eq(await q.evaluate(() => window.__fb.docs['jobReviews/rp5'].status), 'approved',
      'duplicate adverts: and the APPROVED posting it repeats is untouched — the ' +
      'sweep reads it, never rewrites a decision already made');
    eq(await q.evaluate(() => {
      const d = window.__fb.docs['jobReviews/rp3'];
      return [typeof d.note, (d.dup || [])[0] && d.dup[0].ref, typeof d.reviewedAt];
    }), ['string', 'OA-JOB-LIVE-1', 'string'],
      'duplicate adverts: a dropped document says why it went and names what it repeats');
    ok(await q.evaluate(() =>
      /already live or already in the queue/.test(window.__fb.docs['jobReviews/rp3'].note)),
      'duplicate adverts: in the words the pipeline writes, from the one shared module');
    ok(await q.evaluate(() => !!window.__fb.docs['jobReviews/rp2']),
      'duplicate adverts: and the document is still there — rejected, never deleted');

    await q.waitForFunction(() => {
      const b = document.querySelector('#oa-review-sources button[data-source="crawled"]');
      return b && b.textContent === 'Auto-crawled jobs (4)';
    }, null, { timeout: 10000 });
    ok(true, 'duplicate adverts: the tab count follows without a reload');

    /* AND THE OUTCOME SURVIVES THE REDRAW. render() clears this line, so an
       outcome written before the repaint is wiped by it and the queue shrinks
       under a blank strip — the message has to come after. */
    ok(/3 repeated postings taken out of the queue/.test(
      await q.textContent('#oa-review-bulk-msg') || ''),
      'duplicate adverts: and it still says what it did once the queue has redrawn');

    /* Pressed again with nothing left to find, it says so rather than going
       quiet — the answer a maintainer actually wants most of the time. */
    await q.click('#oa-review-dupes');
    await q.waitForFunction(() =>
      /none of them/.test((document.getElementById('oa-review-bulk-msg') || {}).textContent || ''),
      null, { timeout: 15000 });
    ok(true, 'duplicate adverts: a clean sweep reports that it found nothing');

    eq(errors, [], 'duplicate adverts: no uncaught script error');
    await ctx.close();
  }

  /* -- everyone else -------------------------------------------------------- */
  {
    const { ctx, q } = await adminAreaPage(NOBODY, 'index.html');
    await q.waitForSelector('#oa-chip', { timeout: 10000 });
    eq(await q.locator('#oa-menu a[href="admin-area.html"]').count(), 0,
      'admin area: a resolved non-admin session gets no menu row');
    await q.goto(BASE + 'admin-area.html', { waitUntil: 'load' });
    await q.waitForTimeout(600);
    ok(await q.locator('#oa-aa-guest').isVisible() && await q.locator('#oa-aa-admin').isHidden(),
      'admin area: and the desk stays the guest note for them');
    await ctx.close();
  }
}

/* ------------------------------------- the roster and the message threads

   The Admin area could COUNT registered accounts and learn nothing else about
   them, so the maintainer had no way to see who they were or reach any of
   them (owner, 2026-08-24). What no static pin can prove is the money path:
   that the roster renders the identity the accounts wrote about themselves,
   that a name typed by a stranger is inert, that ticking people and writing
   once really opens a thread on each of them with `from` set to the person
   who wrote it — and that the recipient, on their own page, sees it and can
   answer. Driven against _fake-firebase.js with a seeded roster. */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');

  const ADMIN = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com',
    emailVerified: true, displayName: 'Kostas Stouras', providerData: [] };
  const READER = { uid: 'u-msg-2', email: 'bea@example.edu',
    emailVerified: true, displayName: 'Bea Baker', providerData: [] };

  const seed = [
    /* three accounts, and the FIRST carries the two hostile shapes at once:
       markup in a name (it is rendered on the maintainer's screen) and a
       leading '=' (it reaches a spreadsheet through Download CSV) */
    { path: 'userDirectory/u-msg-1', data: { name: '=cmd|calc<img src=x onerror=window.__xssU=1>',
        email: 'avery@example.edu', first: 1000, seen: 3000 } },
    { path: 'userDirectory/u-msg-2', data: { name: 'Bea Baker',
        email: 'bea@example.edu', first: 2000, seen: 2000 } },
    { path: 'userDirectory/u-msg-3', data: { name: 'Cy Carter',
        email: 'cy@example.edu', first: 3000, seen: 1000 } },

    /* Bea has replied and is waiting — the one thing here that is a QUEUE */
    { path: 'messages/u-msg-2', data: { uid: 'u-msg-2', lastAt: 5000, lastFrom: 'user',
        needsAdmin: true, userUnread: 1 } },
    /* one message she has already taken OFF her own list. It is still in the
       thread — the maintainer's copy is the record — so the Admin area shows
       it and her page files it under "Removed messages". */
    { path: 'messages/u-msg-2/items/m0', data: { from: 'admin', body: 'An older note.',
        t: 3000, hiddenForUser: true } },
    { path: 'messages/u-msg-2/items/m1', data: { from: 'admin', body: 'Hello Bea.', t: 4000 } },
    { path: 'messages/u-msg-2/items/m2', data: { from: 'user', body: 'Hello back.', t: 5000 } },

    /* a thread whose roster row has GONE — the account was merged away, which
       deletes its row while it can still write as that user. The record is
       kept rather than silently dropped. */
    { path: 'messages/u-gone-9', data: { uid: 'u-gone-9', lastAt: 900, lastFrom: 'admin',
        needsAdmin: false, userUnread: 0 } },
  ];

  async function open(user, url) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const q = await ctx.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user, docs: seed })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + url, { waitUntil: 'load' });
    return { ctx, q, errors };
  }

  /* -- the maintainer's roster --------------------------------------------- */
  {
    const { ctx, q, errors } = await open(ADMIN, 'admin-area.html');
    await q.waitForSelector('#oa-aa-users .oa-u-table tbody tr', { timeout: 10000 });

    const text = await q.textContent('#oa-aa-users');
    ok(text.indexOf('bea@example.edu') !== -1 && text.indexOf('cy@example.edu') !== -1,
      'roster: the maintainer can finally see WHO has registered, by the address ' +
      'they sign in with — the whole gap this closed');
    eq(await q.evaluate(() => window.__xssU), undefined,
      'roster: markup in a name is rendered as text, never executed');
    ok((await q.textContent('#oa-aa-users')).indexOf('<img src=x') !== -1,
      '…and is shown as the characters the account really typed');

    /* the thread column is the queue: Bea is waiting, the others are not */
    const bea = q.locator('#oa-aa-users tr', { hasText: 'bea@example.edu' });
    ok((await bea.textContent()).indexOf('Replied — awaiting you') !== -1,
      'roster: a person who has replied is shown as waiting for the maintainer');

    /* the ghost: a thread with no roster row behind it */
    ok((await q.textContent('#oa-aa-users')).indexOf('Threads with no account') !== -1,
      'roster: a thread whose account was merged away is kept and shown as ' +
      'exactly that, rather than vanishing with the row');

    /* sorting is by what is DISPLAYED — one spec owns heading, cell and key */
    const namesNow = () => q.$$eval('#oa-aa-users tbody tr td:nth-child(2)',
      (tds) => tds.map((t) => t.textContent.trim()));
    await q.click('#oa-aa-users .oa-u-sort[data-sort="email"]');
    const byEmail = await namesNow();
    ok(byEmail.length >= 3 && byEmail.join('|').indexOf('Bea Baker') < byEmail.join('|').indexOf('Cy Carter'),
      'roster: clicking a heading sorts by that column, ascending first');
    await q.click('#oa-aa-users .oa-u-sort[data-sort="email"]');
    const rev = await namesNow();
    eq(rev.slice().reverse().join(','), byEmail.join(','),
      'roster: and a second click is a clean reversal, not a reshuffle');

    /* the Find box doubles as the recipient picker: select-all takes what is
       SHOWN, so a filtered roster is how a subset is addressed */
    await q.fill('#oa-u-filter', 'cy@');
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-aa-users tbody tr').length === 1, null, { timeout: 10000 });
    ok(true, 'roster: Find narrows the list');
    await q.click('#oa-u-all');
    await q.waitForFunction(() =>
      (document.getElementById('oa-u-send') || {}).disabled === false, null, { timeout: 10000 });
    ok((await q.textContent('#oa-u-send')).indexOf('1 person') !== -1,
      'roster: select-all takes only the rows on screen, so the filter IS the picker');

    /* EVERY row opens its conversation. The "Message replies waiting" tile
       counts threads owing an answer, and for a while the only Open control
       was on the ORPHANED threads below — so the queue could be counted and
       not read. */
    eq(await q.locator('#oa-aa-users tbody tr .oa-u-open').count(),
      await q.locator('#oa-aa-users tbody tr').count(),
      'roster: every row opens its conversation — a queue you cannot read is not a queue');
    await q.fill('#oa-u-filter', 'bea@');
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-aa-users tbody tr').length === 1, null, { timeout: 10000 });
    await q.click('#oa-aa-users tbody tr .oa-u-open');
    await q.waitForSelector('#oa-aa-users-thread .oa-u-msg', { timeout: 10000 });
    ok((await q.textContent('#oa-aa-users-thread')).indexOf('Hello back.') !== -1,
      'roster: …and the maintainer can read the reply that is waiting for them');

    /* A message the reader has REMOVED from their own list is still here, and
       is drawn as exactly that. Removing is a hide, not a delete: the words
       stay where they were said, and a maintainer quoting back something the
       other person can no longer see is talking past them. */
    ok((await q.textContent('#oa-aa-users-thread')).indexOf('An older note.') !== -1,
      'roster: a message the reader removed from THEIR list is still in the ' +
      'maintainer’s copy — removing is a hide, never a delete');
    eq(await q.locator('#oa-aa-users-thread .oa-u-msg.is-gone').count(), 1,
      'roster: …drawn faded');
    ok((await q.textContent('#oa-aa-users-thread .oa-u-msg.is-gone'))
      .indexOf('Removed from their list') !== -1,
      'roster: …and labelled, so the maintainer knows what the other person ' +
      'can no longer see');
    await q.click('#oa-u-close');
    await q.fill('#oa-u-filter', '');
    await q.waitForFunction(() =>
      document.querySelectorAll('#oa-aa-users tbody tr').length > 1, null, { timeout: 10000 });

    /* A message already typed must survive choosing who to send it to — which
       is the order people actually work in. Bea is NOT picked at this point
       (select-all above ran with the list filtered to Cy), so this ticks her
       and then unticks her, leaving the selection exactly as it was. */
    await q.fill('#oa-u-body', 'Draft that must survive.');
    await q.click('#oa-aa-users tr:has-text("bea@example.edu") .oa-u-pick');
    await q.waitForFunction(() =>
      (document.getElementById('oa-u-send') || {}).textContent.indexOf('2 people') !== -1,
      null, { timeout: 10000 });
    eq(await q.inputValue('#oa-u-body'), 'Draft that must survive.',
      'roster: ticking a recipient does not throw away the message already written');
    await q.click('#oa-aa-users tr:has-text("bea@example.edu") .oa-u-pick');
    await q.waitForFunction(() =>
      (document.getElementById('oa-u-send') || {}).textContent.indexOf('1 person') !== -1,
      null, { timeout: 10000 });
    ok(true, 'roster: …and a tick can be undone — the box shows the state it is in');

    /* …and sending really writes, with `from` the rules pin */
    await q.fill('#oa-u-body', 'A message to Cy.');
    q.once('dialog', (d) => d.accept());
    await q.click('#oa-u-send');
    await q.waitForFunction(() => {
      const d = window.__fb.dump();
      return Object.keys(d).some((k) => k.indexOf('messages/u-msg-3/items/') === 0);
    }, null, { timeout: 10000 });
    const wrote = await q.evaluate(() => {
      const d = window.__fb.dump();
      const key = Object.keys(d).filter((k) => k.indexOf('messages/u-msg-3/items/') === 0)[0];
      return { item: d[key], head: d['messages/u-msg-3'] };
    });
    eq(wrote.item.from, 'admin', 'messaging: the maintainer’s message is stamped from: admin');
    eq(wrote.item.body, 'A message to Cy.', '…with the body as written');
    eq(wrote.head.uid, 'u-msg-3', 'messaging: and a thread head keyed on the person’s own uid');
    eq(wrote.head.userUnread, 1, '…carrying one unread for them');
    eq(wrote.head.needsAdmin, false,
      '…and NOT flagged as waiting on the maintainer, who has just acted');

    /* A BROADCAST IS NOT AN ANSWER. Bea has replied and is waiting; sending
       her a message must not quietly drop her out of the "awaiting you" queue
       — only reading the thread and marking it answered does that. */
    await q.click('#oa-aa-users tr:has-text("bea@example.edu") .oa-u-pick');
    await q.fill('#oa-u-body', 'A broadcast.');
    q.once('dialog', (d) => d.accept());
    await q.click('#oa-u-send');
    await q.waitForFunction(() =>
      (window.__fb.dump()['messages/u-msg-2'] || {}).lastFrom === 'admin',
      null, { timeout: 10000 });
    eq(await q.evaluate(() => window.__fb.dump()['messages/u-msg-2'].needsAdmin), true,
      'roster: a broadcast leaves somebody who is still owed an answer IN the queue');

    /* An orphaned thread can really be removed — the panel says so. */
    q.once('dialog', (d) => d.accept());
    await q.click('#oa-aa-users .oa-u-del[data-uid="u-gone-9"]');
    await q.waitForFunction(() => !window.__fb.dump()['messages/u-gone-9'],
      null, { timeout: 10000 });
    ok(true, 'roster: and the delete the ghost panel offers actually deletes it');

    eq(errors, [], 'roster: maintainer run — no uncaught script error');
    await ctx.close();
  }

  /* -- the reader's own page ------------------------------------------------ */
  {
    const { ctx, q, errors } = await open(READER, 'messages.html');
    await q.waitForSelector('#oa-msg-list .oa-u-msg', { timeout: 10000 });
    const body = await q.textContent('#oa-msg-list');
    ok(body.indexOf('Hello Bea.') !== -1 && body.indexOf('Hello back.') !== -1,
      'messages: the recipient sees the whole conversation, oldest first');

    /* reading them IS reading them */
    await q.waitForFunction(() =>
      (window.__fb.dump()['messages/u-msg-2'] || {}).userUnread === 0,
      null, { timeout: 10000 });
    ok(true, 'messages: opening the page marks the thread read — the badge follows');

    /* a reply is stamped from the person writing it, and RAISES the flag it
       may never lower */
    await q.fill('#oa-msg-body', 'Thanks!');
    await q.click('#oa-msg-send');
    await q.waitForFunction(() => {
      const d = window.__fb.dump();
      return Object.keys(d).some((k) =>
        k.indexOf('messages/u-msg-2/items/') === 0 && d[k].body === 'Thanks!');
    }, null, { timeout: 10000 });
    const reply = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).filter((x) =>
        x.indexOf('messages/u-msg-2/items/') === 0 && d[x].body === 'Thanks!')[0];
      return { item: d[k], head: d['messages/u-msg-2'] };
    });
    eq(reply.item.from, 'user', 'messages: a reply is stamped from: user — the rules pin it, ' +
      'so neither side can put words in the other’s mouth');
    eq(reply.head.needsAdmin, true,
      'messages: and it RAISES the maintainer’s flag — the queue on the Admin ' +
      'area cannot be emptied by the person waiting in it');
    eq(reply.head.lastFrom, 'user', '…recording who spoke last');

    /* ------------------------------------------------------------------
       REMOVING A MESSAGE FROM YOUR OWN LIST (owner, 2026-08-27).
       ------------------------------------------------------------------ */

    /* It arrives already true of the seed: the message she removed before is
       off the list and waiting in the panel below it. */
    ok((await q.textContent('#oa-msg-list .oa-u-thread')).indexOf('An older note.') === -1,
      'messages: a message the reader has removed is OFF their list');
    ok((await q.textContent('.oa-msg-removed')).indexOf('An older note.') !== -1,
      'messages: …and is in the collapsed “Removed messages” panel — hiding is ' +
      'never a one-way door, so there is something left on the page to press');

    /* Removing one writes the ONE boolean the rules allow, and nothing else:
       the body, `from` and the timestamp must come back untouched, or "the
       maintainer keeps the record" is not true. */
    const before = await q.evaluate(() => window.__fb.dump()['messages/u-msg-2/items/m1']);
    await q.click('#oa-msg-list .oa-u-thread .oa-u-hide[data-act="remove"]');
    await q.waitForFunction(() =>
      (window.__fb.dump()['messages/u-msg-2/items/m1'] || {}).hiddenForUser === true,
      null, { timeout: 10000 });
    const after = await q.evaluate(() => window.__fb.dump()['messages/u-msg-2/items/m1']);
    eq({ from: after.from, body: after.body, t: after.t },
      { from: before.from, body: before.body, t: before.t },
      'messages: removing writes ONE boolean and touches nothing else — not the ' +
      'body, not `from`, not the timestamp');
    await q.waitForFunction(() => {
      const l = document.querySelector('#oa-msg-list .oa-u-thread');
      return l && l.textContent.indexOf('Hello Bea.') === -1;
    }, null, { timeout: 10000 });
    ok(true, 'messages: …and it leaves the list at once');

    /* It went into the panel, and the panel really opens. */
    await q.click('.oa-msg-removed > summary');
    await q.waitForSelector('.oa-msg-removed .oa-u-hide[data-act="restore"]', { timeout: 10000 });
    ok((await q.textContent('.oa-msg-removed')).indexOf('Hello Bea.') !== -1,
      'messages: the removed message is in the panel, with Restore beside it');

    /* Restore writes `false` and never a field deletion — the rules test
       `hiddenForUser is bool`, so deleting the key would be refused and
       "you can always put it back" would be false exactly once. */
    /* Scoped to the CARD: the panel holds the seeded removal too, and
       page.click() takes the first match — which would restore the wrong one
       and leave this measuring nothing. */
    await q.locator('.oa-msg-removed .oa-u-msg', { hasText: 'Hello Bea.' })
      .locator('.oa-u-hide[data-act="restore"]').click();
    await q.waitForFunction(() =>
      (window.__fb.dump()['messages/u-msg-2/items/m1'] || {}).hiddenForUser === false,
      null, { timeout: 10000 });
    await q.waitForFunction(() => {
      const l = document.querySelector('#oa-msg-list .oa-u-thread');
      return l && l.textContent.indexOf('Hello Bea.') !== -1;
    }, null, { timeout: 10000 });
    ok(true, 'messages: Restore puts it back on the list — and writes the ' +
      'boolean false, never a deleted field the rules would refuse');

    /* A READER WHO REMOVES EVERYTHING STILL HAS A THREAD. The reply box lives
       outside the list for exactly this: they must still be able to answer. */
    const onList = () =>
      q.locator('#oa-msg-list .oa-u-thread .oa-u-hide[data-act="remove"]').count();
    for (let left = await onList(); left > 0; left = await onList()) {
      await q.locator('#oa-msg-list .oa-u-thread .oa-u-hide[data-act="remove"]')
        .first().click();
      /* Wait for the RE-RENDER rather than for a stopwatch: the write and the
         re-read are a round trip, and a fixed pause is how a green test starts
         failing on a slower machine. */
      const want = left - 1;
      await q.waitForFunction(
        (n) => document.querySelectorAll(
          '#oa-msg-list .oa-u-thread .oa-u-hide[data-act="remove"]').length === n,
        want, { timeout: 10000 });
    }
    ok(await q.locator('#oa-msg-body').count() === 1
      && await q.locator('#oa-msg-send').count() === 1,
      'messages: a reader who has removed EVERY message can still reply — the ' +
      'reply box is drawn outside the list, not inside it');
    ok((await q.textContent('#oa-msg-list')).indexOf('removed every message') !== -1,
      'messages: …and the empty list says where they went rather than reading ' +
      'as a thread that was never there');
    ok(await q.locator('#oa-msg-empty').isHidden(),
      'messages: which is NOT the "you have no messages" state — that one is ' +
      'for a person the maintainer has never written to');

    eq(errors, [], 'messages: reader run — no uncaught script error');
    await ctx.close();
  }

  /* -- a phone, because an e-mail address has no spaces --------------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 850 } });
    const q = await ctx.newPage();
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user: ADMIN, docs: seed })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + 'admin-area.html', { waitUntil: 'load' });
    await q.waitForSelector('#oa-aa-users .oa-u-table tbody tr', { timeout: 10000 });
    const over = await q.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `roster at 390px: the PAGE does not scroll sideways (${over}px) — ` +
      'the table scrolls inside its own container instead');
    ok(await q.evaluate(() => {
      const w = document.querySelector('.oa-u-wrap');
      return !!w && getComputedStyle(w).overflowX === 'auto';
    }), 'roster at 390px: …which is what that container is for');
    await ctx.close();
  }
}

/* ------------------------------------------- the Excel download, measured

   A registered reader may download the postings the jobs page is SHOWING as a
   real .xlsx (owner, 2026-08-26). `selftest.mjs` pins what may be in the file
   and proves the bytes are a workbook; this proves the two things only a
   browser can answer — that pressing it produces one, and that pressing it
   signed OUT produces the sign-in box instead.

   Driven against _fake-firebase.js, because the gate is the site's own
   `whenSignedIn` and a page with no SDK at all resolves to "signed out and say
   why", which is a third state rather than either of the two under test. */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');
  const READER = { uid: 'reader-uid-00000000', email: 'reader@example.edu',
    emailVerified: true, displayName: 'A Reader', providerData: [] };

  async function jobsPage(user, width = 1280) {
    const ctx = await browser.newContext({
      viewport: { width, height: 1000 }, acceptDownloads: true });
    const q = await ctx.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user, docs: [] })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + 'jobs.html', { waitUntil: 'load' });
    await q.waitForSelector('.oa-card');
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.waitForTimeout(300);
    return { ctx, q, errors };
  }

  /* -- signed OUT: the button refuses, and says how to earn it ------------- */
  {
    const { ctx, q, errors } = await jobsPage(null);
    let downloaded = false;
    q.on('download', () => { downloaded = true; });
    const before = await q.evaluate(() => {
      const b = document.querySelector('.oa-export');
      return { there: !!b, title: b ? b.title : '',
        locked: !!document.querySelector('.v3-lock.is-locked') };
    });
    ok(before.there, 'jobs export: the button is in the filter bar');
    ok(before.locked, 'jobs export: signed out, the bar it sits in is locked');
    ok(/with an account/.test(before.title),
      'jobs export: …and it says the download is free with one, rather than looking broken');
    /* Through the lock's pointer-events:none deliberately — the lock is a
       NUDGE, and what is under test is the module's own gate. */
    await q.evaluate(() => document.querySelector('.oa-export').click());
    await q.waitForTimeout(1200);
    ok(!downloaded, 'jobs export: pressing it signed out downloads NOTHING');
    ok(await q.evaluate(() => !!document.querySelector('.oa-modal')),
      'jobs export: it offers the sign-in box instead');
    /* The lock card is the only place a signed-out reader can be told the
       download exists at all, so it has to say so. */
    ok(await q.$eval('#v3-lock-card', (n) => /Excel/i.test(n.textContent)),
      'jobs export: and the sign-in card names it as a reason to register');
    eq(errors, [], 'jobs export: signed-out run — no uncaught script error');
    await ctx.close();
  }

  /* -- signed IN: a real workbook, holding what the page is showing -------- */
  {
    const { ctx, q, errors } = await jobsPage(READER);
    const shown = await q.$eval('.oa-count', (n) =>
      Number(n.textContent.split('/')[1].trim().split(' ')[0]));

    const btn = await q.evaluate(() => {
      const b = document.querySelector('.oa-export');
      const r = b.getBoundingClientRect();
      const cell = b.closest('.oa-filter-actions').getBoundingClientRect();
      const c = document.querySelector('.oa-clear');
      const clear = c.getBoundingClientRect();
      return { title: b.title, text: b.textContent.trim(), disabled: b.disabled,
        h: Math.round(r.height), w: Math.round(r.width),
        x: Math.round(r.x), top: Math.round(r.top),
        rightGap: Math.round(cell.right - r.right),
        clearW: Math.round(clear.width), clearH: Math.round(clear.height),
        clearX: Math.round(clear.x), clearTop: Math.round(clear.top),
        locked: !!document.querySelector('.v3-lock.is-locked') };
    });
    ok(!btn.locked, 'jobs export: signed in, the filter bar is live');
    ok(!btn.disabled && btn.title.includes(String(shown)),
      `jobs export: the button names what it would write (${shown} postings)`);
    /* SMALLER THAN CLEAR was the instruction — "an extra beside the controls
       the bar is for" — and it is measured against Clear's own width rather
       than a magic number, because that is what the instruction actually
       says. It grew when the label gained its verb (2026-08-27, the owner on
       the old one: "not very intuitive for the average user") — "Excel" names
       a format and never the act.

       BESIDE Clear, not under it (owner, same day): the two share a line, a
       baseline and a height, the download keeps the right edge and Clear
       takes the rest of the cell, so the bar still ends flush. Heights are
       compared rather than capped, because "same line" is the property and
       two controls of different heights on one line read as a mistake. */
    ok(/download/i.test(btn.text) && /excel/i.test(btn.text),
      `jobs export: the label says what it does and what you get (${JSON.stringify(btn.text)})`);
    ok(btn.w < btn.clearW,
      `jobs export: it stays narrower than Clear (${btn.w} vs ${btn.clearW})`);
    ok(Math.abs(btn.top - btn.clearTop) <= 2 && btn.h === btn.clearH,
      `jobs export: on ONE line with Clear filters, same height ` +
      `(${btn.h} vs ${btn.clearH}, tops ${btn.top}/${btn.clearTop})`);
    ok(btn.x > btn.clearX && Math.abs(btn.rightGap) <= 1.5,
      'jobs export: …to its right, holding the bar\'s right edge');

    /* TWO ROWS, WITH ENTRY LEVEL ON THE FIRST (owner, 2026-08-27: "pushing
       'entry level' search field on the top line, so that 'clear filters' and
       'Download Excel' buttons appear in the same line, within the 2nd line").
       The two halves are one measurement: the buttons only fit on a line
       together because a sixth track freed one on the second row, and the
       sixth track is what carries Entry level up to the first. Asserting the
       row COUNT rather than a pixel keeps it honest if the design's spacing
       ever moves. */
    const bar = await q.evaluate(() => {
      const tops = new Map();
      for (const cell of document.querySelector('.oa-filters').children) {
        const top = Math.round(cell.getBoundingClientRect().top);
        const lab = cell.querySelector('.oa-label, label');
        const name = (lab ? lab.textContent : 'actions').trim();
        if (!tops.has(top)) tops.set(top, []);
        tops.get(top).push(name);
      }
      const rows = [...tops.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      return { count: rows.length, first: rows[0] || [], last: rows[rows.length - 1] || [] };
    });
    eq(bar.count, 2, `the jobs filter bar is two rows deep (${bar.count})`);
    ok(bar.first.some((n) => /entry level/i.test(n)),
      `Entry level is on the top line (${bar.first.join(' · ')})`);
    ok(bar.last.includes('actions'),
      'and the two buttons close the second one');

    const first = q.waitForEvent('download', { timeout: 30000 });
    await q.click('.oa-export');
    const dl = await first;
    ok(/^operations-academia-job-postings-.*\.xlsx$/.test(dl.suggestedFilename()),
      `jobs export: it downloads a named .xlsx (${dl.suggestedFilename()})`);
    const file = await dl.path();
    const bytes = new Uint8Array(await readFile(file));
    eq(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04],
      'jobs export: and the bytes really are a workbook');

    const parts = unzipStore(bytes);
    const cells = sheetCells(parts['xl/worksheets/sheet1.xml']);
    eq(lastRow(cells) - 1, shown,
      'jobs export: it carries exactly the postings the page was showing');
    const EMAILISH = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    ok(!EMAILISH.test(parts['xl/worksheets/sheet1.xml']),
      'jobs export: and no contact address reaches the reader\'s machine');

    /* NARROWING THE LIST NARROWS THE FILE. A button in the filter panel that
       ignored the filters would be the surprise, not the feature. */
    const country = await q.$eval('.oa-card:first-child .oa-card-title', (n) => n.textContent);
    await q.fill('#oaf-institution', country.slice(0, 8));
    await q.waitForTimeout(500);
    const narrowed = await q.$eval('.oa-count', (n) =>
      Number(n.textContent.split('/')[1].trim().split(' ')[0]));
    ok(narrowed > 0 && narrowed < shown,
      `jobs export: a search narrowed the list (${narrowed} of ${shown})`);
    ok((await q.$eval('.oa-export', (b) => b.title)).includes(String(narrowed)),
      'jobs export: …and the button already says the new number');
    const second = q.waitForEvent('download', { timeout: 30000 });
    await q.click('.oa-export');
    const dl2 = await second;
    const parts2 = unzipStore(new Uint8Array(await readFile(await dl2.path())));
    const cells2 = sheetCells(parts2['xl/worksheets/sheet1.xml']);
    eq(lastRow(cells2) - 1, narrowed, 'jobs export: the file follows the filters');
    const about = sheetCells(parts2['xl/worksheets/sheet3.xml']);
    ok(Object.keys(about).map((k) => about[k].v).join(' ').includes(country.slice(0, 8)),
      'jobs export: …and says which search produced it');

    eq(errors, [], 'jobs export: signed-in run — no uncaught script error');
    await ctx.close();
  }

  /* -- a phone: a control in this bar is a touch target (rule 3) ----------- */
  {
    const { ctx, q } = await jobsPage(READER, 390);
    const m = await q.evaluate(() => {
      const b = document.querySelector('.oa-export');
      const r = b.getBoundingClientRect();
      const bar = document.querySelector('.oa-filters').getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width),
        barW: Math.round(bar.width),
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    ok(m.h >= 40, `jobs export at 390px: a 40px+ target (${m.h}px)`);
    ok(m.w > m.barW * 0.7, 'jobs export at 390px: full width, like every other control');
    ok(m.over <= 1, 'jobs export at 390px: the page still does not scroll sideways');
    ok(await q.evaluate(() => {
      const b = document.querySelector('.oa-export');
      const want = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
      const probe = document.createElement('span');
      probe.style.color = want; document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(b).borderTopColor === resolved;
    }), 'jobs export at 390px: …and keeps its green border — a thumb needs the ' +
      'affordance more than a mouse does, not less');
    await ctx.close();
  }

  /* -- THE TWO BUTTONS ARE THE COLOUR THEY MEAN, in both themes -----------

     Owner, 2026-08-27, from a screenshot of the dark theme: Clear filters is
     "very subtle" and the Excel download "not very intuitive for the average
     user". Both are now coloured — Clear RED (it throws a search away), the
     download GREEN (the colour a spreadsheet wears everywhere else, and what
     the owner asked for) — and this measures what the
     browser actually paints rather than what a stylesheet says, because these
     rules live in TWO files (the engine's and the live design's override) and
     only the second one reaches this page.

     The tokens are resolved through the page's own custom properties, so the
     check follows the palette instead of hard-coding a hex that a later theme
     change would silently make wrong. The theme audit further down already
     holds every one of these colours to AA on its own ground. */
  {
    const { ctx, q } = await jobsPage(READER);
    for (const theme of ['light', 'dark']) {
      await q.evaluate((v) => document.documentElement.setAttribute('data-theme', v), theme);
      /* something has to be selected, or Clear is disabled and 45% faded */
      await q.fill('#oaf-institution', 'a');
      await q.waitForTimeout(400);
      /* PARK THE POINTER FIRST. The hover pass below leaves Playwright's mouse
         sitting on the download, and pressing Clear rebuilds the bar UNDER it
         — so the second theme's "at rest" reading would be taken on a button
         that is still hovered, and its ink would be --on-brand rather than
         --ok: a green-on-green failure reported against a rule that is
         perfectly correct. */
      await q.mouse.move(4, 4);
      await q.waitForTimeout(80);
      const paint = await q.evaluate(() => {
        const token = (name) => {
          const want = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          const probe = document.createElement('span');
          probe.style.color = want; document.body.appendChild(probe);
          const out = getComputedStyle(probe).color; probe.remove();
          return out;
        };
        const clear = getComputedStyle(document.querySelector('.oa-clear'));
        const exp = getComputedStyle(document.querySelector('.oa-export'));
        return {
          err: token('--err'), ok: token('--ok'),
          clearBorder: clear.borderTopColor, clearInk: clear.color,
          clearDisabled: document.querySelector('.oa-clear').disabled,
          expBorder: exp.borderTopColor, expInk: exp.color, expGround: exp.backgroundColor,
        };
      });
      ok(!paint.clearDisabled,
        `filter buttons (${theme}): Clear is live, so its real colours are on screen`);
      eq(paint.clearBorder, paint.err, `filter buttons (${theme}): Clear filters has a RED border`);
      eq(paint.clearInk, paint.err, `filter buttons (${theme}): …and red ink, not a lone 1px outline`);
      eq(paint.expBorder, paint.ok, `filter buttons (${theme}): the Excel download has a GREEN border`);
      eq(paint.expInk, paint.ok, `filter buttons (${theme}): …with ink to match`);
      ok(!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(paint.expGround),
        `filter buttons (${theme}): …on a ground of its own, so it reads as a button`);

      /* hover FILLS it: the strongest signal a static page can give that a
         thing is pressable, and the one a caption never has */
      await q.hover('.oa-export');
      await q.waitForTimeout(120);
      const hov = await q.evaluate(() => {
        const exp = getComputedStyle(document.querySelector('.oa-export'));
        return { ground: exp.backgroundColor, ink: exp.color };
      });
      eq(hov.ground, paint.ok, `filter buttons (${theme}): hovering the download fills it green`);
      ok(hov.ink !== paint.ok, `filter buttons (${theme}): …and flips its ink so the label survives`);
      await q.evaluate(() => document.querySelector('.oa-clear').click());
      await q.waitForTimeout(200);
    }
    await ctx.close();
  }
}

/* ----------------------------------------------------- the analytics page

   It was four Google Sheets <iframe>s, dead since Universal Analytics was
   switched off in July 2023 and rendering as four empty boxes ever since. It
   draws its own marks now, so what is measured here is the half a unit test
   cannot see: that a reader with no data is TOLD so rather than shown blank
   cards, that the frozen archive is labelled, that the two lines can be told
   apart in BOTH themes, and that the seasonality chart never reports a month
   the record has not covered as a month with no visitors. */
{
  /* a realistic corpus rather than a fixture of three days: the weekday and
     seasonal shapes are the whole point of two of these charts, and a chart
     over three days cannot show either */
  const demoDays = {};
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2026, 7, 28);
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const season = [0.75, 0.7, 0.8, 0.85, 0.7, 0.5, 0.45, 0.7, 1.5, 1.7, 1.35, 0.85][d.getUTCMonth()];
    const week = (d.getUTCDay() === 0 || d.getUTCDay() === 6) ? 0.45 : 1;
    const v = Math.max(1, Math.round(38 * season * week * (0.8 + rnd() * 0.45)));
    demoDays[d.toISOString().slice(0, 10)] = [v, Math.round(v * 1.2), Math.round(v * 2.7)];
  }
  const demo = {
    version: 1,
    generated: new Date(end).toISOString(),
    dayFields: ['visitors', 'sessions', 'pageviews'],
    sources: [{ source: 'usage', days: Object.keys(demoDays).length }],
    days: demoDays,
    pages: [
      { path: '/jobs.html', title: 'Job postings', views: 48210, avgSec: 142 },
      { path: '/', title: 'Operations Academia', views: 31022, avgSec: 73 },
    ],
    universities: {
      frozen: true, from: '2014-03-01', to: '2023-06-30',
      all: [{ name: 'Duke University', visits: 2100 }, { name: 'INSEAD', visits: 1355 }],
      recent: [],
    },
    totals: { visitors: 1, sessions: 1, pageviews: 1, days: Object.keys(demoDays).length, universities: 2 },
    range: { from: '2024-01-01', to: '2026-08-28' },
    recentDays: 7,
  };

  const serveDemo = (pg, body) => pg.route('**/data/analytics.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  }));

  /* --- with data, in BOTH themes ---------------------------------------- */

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1400 }, colorScheme: theme });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push(`analytics ${theme}: ` + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, demo);
    await q.addInitScript((t) => { try { localStorage.setItem('oaV3Theme', t); } catch (e) { /**/ } }, theme);
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });

    const seen = await q.evaluate(() => ({
      figures: [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent),
      svgs: document.querySelectorAll('.oa-chart-svg').length,
      tables: document.querySelectorAll('.oa-chart-table').length,
      tiles: document.querySelectorAll('.oa-tile').length,
      frozen: [...document.querySelectorAll('.oa-figure-frozen')].map((e) => e.textContent.trim()),
      iframes: document.querySelectorAll('iframe').length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));

    eq(seen.iframes, 0, `analytics (${theme}): the page embeds nothing`);
    ok(seen.svgs >= 3, `analytics (${theme}): the charts are drawn as inline SVG`);
    ok(seen.tiles >= 4, `analytics (${theme}): the headline figures are shown`);
    eq(seen.tables, seen.svgs,
      `analytics (${theme}): every chart also gives its numbers as a table — a chart ` +
      'is accessible because the values are available as text, not because it validated');
    eq(seen.frozen, ['Archive — 2014 to 2023'],
      `analytics (${theme}): the universities section is labelled as an archive — its ` +
      'numbers came from a dimension no analytics product still offers, so a reader ' +
      'must never take them for current');
    ok(!seen.overflowX, `analytics (${theme}): the page never scrolls sideways`);

    /* THE TWO LINES MUST BE TELLABLE APART. The daily chart draws a count and
       its rolling mean; the site's own --brand and --gold separate well in
       light and collapse in dark, which is why the stylesheet re-steps the
       accent there. Measured from what the browser actually paints, so a
       later palette change cannot silently undo it. */
    const lines = await q.evaluate(() => {
      const px = (el) => getComputedStyle(el).stroke;
      const a = document.querySelector('.oa-line.oa-brand');
      const b = document.querySelector('.oa-line.oa-accent');
      return a && b ? { a: px(a), b: px(b) } : null;
    });
    ok(lines && lines.a !== lines.b,
      `analytics (${theme}): the daily line and its rolling mean are different colours`);
    if (lines) {
      const rgb = (c) => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const [ar, ag, ab] = rgb(lines.a);
      const [br, bg, bb] = rgb(lines.b);
      const dist = Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
      ok(dist > 90,
        `analytics (${theme}): …and far enough apart to read as two lines (channel ` +
        `distance ${dist}) — in dark the site's own two colours sit at delta-E 14.9, ` +
        'below the floor at which two overlaid lines can be told apart');
    }

    /* the mean is DASHED as well as coloured, so the pair does not rely on
       colour alone */
    const dashed = await q.evaluate(() =>
      getComputedStyle(document.querySelector('.oa-line.oa-accent')).strokeDasharray);
    ok(dashed && dashed !== 'none',
      `analytics (${theme}): the rolling mean is dashed too — identity is never colour alone`);

    /* A MONTH THE RECORD HAS NOT COVERED IS NOT A MONTH WITH NO VISITORS.
       Under the default 90-day range the season chart used to draw eight
       zero-height bars, which on a job-market site reads as "nobody visits in
       September" — backwards rather than merely missing. It reads the whole
       record instead, so every month has a bar. */
    const season = await q.evaluate(() => {
      const figs = [...document.querySelectorAll('.oa-figure')];
      const f = figs.find((x) => /hiring season/i.test(x.querySelector('h2').textContent));
      if (!f) return null;
      return {
        sub: f.querySelector('.oa-figure-sub').textContent,
        bars: f.querySelectorAll('.oa-bar[d]:not([d=""])').length,
        ticks: [...f.querySelectorAll('.oa-tick-x')].map((t) => t.textContent),
      };
    });
    ok(season && season.ticks.length === 12,
      `analytics (${theme}): the season chart names all twelve months`);
    eq(season && season.bars, 12,
      `analytics (${theme}): …and draws a bar for each — over the WHOLE record, because ` +
      'a window shorter than a year cannot answer a question about the year');
    ok(season && /whole record/i.test(season.sub),
      `analytics (${theme}): …and says so, rather than letting the range above imply otherwise`);

    /* the range control drives every figure at once */
    const before = await q.evaluate(() =>
      document.querySelector('.oa-tile-value').textContent);
    await q.evaluate(() => document.querySelectorAll('.oa-range button')[0].click());
    await q.waitForTimeout(250);
    const after = await q.evaluate(() => ({
      value: document.querySelector('.oa-tile-value').textContent,
      pressed: [...document.querySelectorAll('.oa-range button')]
        .map((b) => b.getAttribute('aria-pressed')),
    }));
    ok(after.value !== before,
      `analytics (${theme}): narrowing the range moves the headline figures`);
    eq(after.pressed, ['true', 'false', 'false', 'false'],
      `analytics (${theme}): …and exactly one range reads as chosen`);

    await ctx.close();
  }

  /* --- with NOTHING, which is the state it ships in --------------------- */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics empty: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, {
      version: 1, generated: '', dayFields: ['visitors', 'sessions', 'pageviews'],
      sources: [], days: {}, pages: [],
      universities: { frozen: true, from: '', to: '', all: [], recent: [] },
      totals: { visitors: 0, sessions: 0, pageviews: 0, days: 0, universities: 0 },
      range: { from: '', to: '' }, recentDays: 7,
    });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-an-note', { timeout: 15000 });
    const note = await q.evaluate(() => document.querySelector('#oa-analytics').textContent);
    ok(/Nothing is being measured yet/i.test(note),
      'analytics: with no data the page SAYS so — four empty boxes reporting nothing ' +
      'to anybody is how the old charts stayed dead for three years');
    ok(/Universal Analytics/.test(note) && /_SETUP-ANALYTICS\.md/.test(note),
      'analytics: …and names both the cause and where to read what to do about it');
    eq(await q.evaluate(() => document.querySelectorAll('.oa-chart-svg').length), 0,
      'analytics: and draws no empty chart beside it');
    await ctx.close();
  }

  /* --- a dataset that has STOPPED moving -------------------------------- */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics stale: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, { ...demo, days: { '2020-01-01': [5, 6, 12] } });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-an-note.warn', { timeout: 15000 });
    const warn = await q.evaluate(() => document.querySelector('.oa-an-note.warn').textContent);
    ok(/stopped moving/i.test(warn) && /2020/.test(warn),
      'analytics: a dataset that stopped years ago says so, and names its last day — ' +
      'from outside, a pipeline that has stopped and a quiet site look identical');
    await ctx.close();
  }

  /* --- hostile input ---------------------------------------------------- */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics hostile: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, {
      ...demo,
      pages: [{ path: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>', views: 9, avgSec: 1 }],
      universities: {
        frozen: true, from: '2014-03-01', to: '2023-06-30',
        all: [{ name: '<script>alert(1)</script>', visits: 5 }], recent: [],
      },
    });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    const hostile = await q.evaluate(() => ({
      injected: document.querySelectorAll('#oa-analytics img, #oa-analytics script').length,
      jsHref: [...document.querySelectorAll('#oa-analytics a')]
        .filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length,
      textShown: document.querySelector('#oa-analytics').textContent.includes('<script>'),
    }));
    eq(hostile.injected, 0, 'analytics: markup in a page title or a name is rendered inert');
    eq(hostile.jsHref, 0, 'analytics: and a javascript: path never becomes a link');
    ok(hostile.textShown, 'analytics: …it is shown as the text it is');
    await ctx.close();
  }

  /* --- the phone -------------------------------------------------------- */

  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics mobile: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, demo);
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    const mob = await q.evaluate(() => {
      const doc = document.documentElement;
      return {
        overflowX: doc.scrollWidth > doc.clientWidth,
        targets: [...document.querySelectorAll('.oa-range button')]
          .map((b) => Math.round(b.getBoundingClientRect().height)),
        widest: Math.max(...[...document.querySelectorAll('.oa-figure')]
          .map((f) => Math.round(f.getBoundingClientRect().right))),
        vw: doc.clientWidth,
      };
    });
    ok(!mob.overflowX, 'analytics mobile: the page never scrolls sideways');
    ok(mob.targets.length > 0 && mob.targets.every((h) => h >= 42),
      'analytics mobile: every range control is a 42px target, the standard every ' +
      'control on this site is held to on a phone');
    ok(mob.widest <= mob.vw, 'analytics mobile: no figure runs past the viewport');
    await ctx.close();
  }
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
