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

/* ------------------------------------------- the forum's own contrast audit

   forum.html cannot join the THEME_PAGES loop: signed out it draws a sign-in
   card and nothing else, so every surface INSIDE a room went unmeasured. Same
   compositing arithmetic as contrastOf, run over whichever of these the view
   on screen actually shows. */
const FORUM_INK = ['.oa-label-pinned', '.oa-label-locked', '.oa-label-new', '.oa-label-tag',
  '.oa-forum-who', '.oa-forum-handle', '.oa-forum-text', '.oa-forum-quote',
  '.oa-forum-removed', '.oa-forum-act', '.oa-forum-score', '.oa-forum-updown',
  '.oa-forum-cardnote', '.oa-forum-hint', '.oa-forum-bs', '.oa-forum-ex',
  '.oa-forum-asker', '.oa-forum-when', '.oa-forum-stat i', '.oa-forum-stat b',
  '.oa-forum-tab', '.oa-forum-crumbs', '.oa-forum-thmeta', '.oa-forum-lede',
  '.oa-forum-answers-h h2', '.oa-forum-sort', '.oa-forum-n',
  /* THE TAG SURFACES, added after a sweep found the count inside a chip at
     4.44:1 on its own ground. This is a LIST, and a list only ever measures
     what somebody remembered: anything that paints ink on a ground of its own
     belongs in it, and a chip paints two of them. */
  '.oa-forum-tagchip', '.oa-forum-tagchip i', '.oa-forum-tagsugg button',
  '.oa-forum-tagsugg i'];
/* .oa-forum-watch and .oa-forum-save are NOT in it, and that is a limit of
   this audit rather than an oversight: it measures INK against its ground and
   skips an element with no text, and those two are icon buttons. They are
   held to the 3:1 non-text floor instead, which is a different measurement
   from a different pair of colours, and nothing here makes it yet. Said
   rather than left as two selectors that quietly measure nothing. */

/* WHICH OF THEM WERE ACTUALLY ON SCREEN. A selector that matches nothing
   measures nothing and says so nowhere, which is the same defect as the
   named list that was never passed: the check goes green having audited a
   surface it never saw. Accumulated across both views, since some of these
   are only ever drawn in one of them, and asserted once the forum block has
   shown the reader both. */
const FORUM_INK_SEEN = new Set();

async function forumContrast(q, where) {
  for (const theme of ['light', 'dark']) {
    await q.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    /* WAIT FOR THE DESIGN TO BE IN FORCE, not for a stopwatch: until the
       cascade settles the body paints a default grey that is neither theme,
       and measured then every muted line reads as a dark-theme failure. The
       THEME_PAGES loop learnt this in 2026-08; the same wait, for the same
       reason. */
    await q.waitForFunction(() => {
      const want = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (!want) return false;
      const probe = document.createElement('span');
      probe.style.color = want;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(document.body).backgroundColor === resolved;
    }, { timeout: 8000 });
      const low = await q.evaluate((sels) => {
        const parse = (css) => {
          const m = String(css).match(/[\d.]+/g);
          if (!m || m.length < 3) return null;
          return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
        };
        const over = (fg, bg) => ({
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
        });
        const ground = (el) => {
          let layers = [], n = el;
          while (n && n.nodeType === 1) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
            n = n.parentElement;
          }
          if (!layers.length) return { r: 255, g: 255, b: 255, a: 1 };
          let out = layers[layers.length - 1];
          for (let i = layers.length - 2; i >= 0; i--) out = over(layers[i], out);
          return out;
        };
        const lum = (c) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const out = [];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            if (!el.offsetParent && el.tagName !== 'BODY') continue;
            const txt = (el.textContent || '').trim();
            if (!txt) continue;
            const fg = parse(getComputedStyle(el).color);
            if (!fg) continue;
            const bg = ground(el);
            const a = lum(fg.a < 1 ? over(fg, bg) : fg), b = lum(bg);
            const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            out.push({ sel, r: Math.round(r * 100) / 100, txt: txt.slice(0, 24),
              fg: getComputedStyle(el).color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
            break;
          }
        }
        return { low: out.filter((x) => x.r < 4.5), seen: out.map((x) => x.sel) };
      /* FORUM_INK, not a second copy of it. There WAS a second copy here, and
         it was the one that ran: the named list above was declared, commented
         and never referenced, so a selector added to it measured nothing and
         said so nowhere. That is the four-copies-of-one-answer shape the
         shared modules on this site all exist to prevent, in the file whose
         job is to catch it. */
      }, FORUM_INK);
      low.seen.forEach((s) => FORUM_INK_SEEN.add(s));
      eq(low.low, [], `forum (${where}, ${theme}): every surface reads at 4.5:1 or better`);
  }
  await q.evaluate(() => document.documentElement.removeAttribute('data-theme'));
}

/* ------------------------------------- opening a page as a SIGNED-IN reader

   Since 2026-08-29 the lists themselves are gated: a reader who has not
   registered sees which universities are hiring and nothing more, and the
   card does not open on them (assets/oa-gate.js). So every check below that
   is about a card's CONTENTS — its rows, its links, its printed body — has to
   say who is reading, and the honest way to say it is to sign them in rather
   than to reach past the gate.

   `_scraper/_fake-firebase.js` is the shim the Admin-area and Excel blocks
   already drive, stood up here as one helper so a block needs three lines
   instead of fifteen. It waits for the session to RESOLVE, because the gate
   is painted from the localStorage hint first and reconciled when the SDK
   answers — measuring in between is measuring a state neither reader is in.

   A SIGNED-OUT READER IS ALSO THE SHIM, with no user. A page opened with no
   Firebase at all is a THIRD state — nobody can sign in, so the gate says so
   and disables the head rather than offering a control that would do nothing
   — and it is the state every plain `browser.newPage()` is in here, because
   CI has no network. The Excel block records the same trap. Which of the
   three is being measured has to be chosen deliberately.                    */
const FAKE_FB = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');
const A_READER = { uid: 'reader-uid-00000000', email: 'reader@example.edu',
  emailVerified: true, displayName: 'A Reader', providerData: [] };

async function signedInPage(url, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 1000 },
    acceptDownloads: !!opts.acceptDownloads,
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const who = ('user' in opts) ? opts.user : A_READER;   // null = signed out
  /* `seed` carries the shim's own switches (reloadVerifies, callableFails,
     applyActionCodeFails …) for the checks that drive a failure branch */
  await p.addInitScript(
    `window.__FAKE_FB = ${JSON.stringify({ user: who, docs: opts.docs || [], ...(opts.seed || {}) })};`);
  /* `init` is extra script run before the page's own (a localStorage seed, an
     observer on the first paint), for the checks that measure the head */
  if (opts.init) await p.addInitScript(opts.init);
  await p.route('**/firebasejs/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_FB }));
  await p.goto(BASE + url, { waitUntil: opts.waitUntil || 'load' });
  if (opts.wait !== false) {
    await p.waitForSelector(opts.selector || '.oa-card', { timeout: 15000 });
    await p.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await p.waitForTimeout(250);
  }
  return { ctx, page: p, errors };
}

/** The same page, read by somebody who has not signed in but could. */
const signedOutPage = (url, opts = {}) => signedInPage(url, { ...opts, user: null });

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
    // the school, the department, the department page, a characteristic and
    // the chair pair are mandatory for a NEW posting (owner, 2026-09-02) —
    // submitting without them is refused, with an error drawn on each of the six
    await q.click('#oa-submit');
    const refused = await q.evaluate(() => ({
      done: document.getElementById('oa-done').hidden,
      errs: document.querySelectorAll('.oa-err').length,
      msg: document.getElementById('oa-msg').textContent,
    }));
    await q.fill('#f-school', 'Business School');
    await q.fill('#f-unit', 'Operations Area');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.fill('#f-deptUrl', 'https://ops.example.edu/department');
    await q.check('input[name="characteristics"][value="PhD"]');
    await q.fill('#f-chairName', 'Chair Person');
    await q.fill('#f-chairEmail', 'chair@example.edu');
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    const ref = await q.textContent('#oa-ref');
    const doc = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).find((p) => p.startsWith('jobSubmissions/'));
      return d[k];
    });
    return { ref, doc, noYearField, yearNote, refused };
  });
  eq(posted.refused.done, true,
    'v3 post-a-job: a NEW posting without the mandatory school, department, ' +
    'department page, characteristic and chair pair is refused');
  eq(posted.refused.errs, 6,
    'v3 post-a-job: …with an error drawn on each of the six fields');
  ok(/highlighted fields/.test(posted.refused.msg),
    'v3 post-a-job: …and the form says to check them');
  ok(/^OA-JOB-\d{6}-[A-Z2-9]{4}$/.test(posted.ref.trim()),
    'v3 post-a-job: the poster is given a quotable reference');
  eq(posted.doc.status, 'queued', 'the submission is queued for the build');
  eq(posted.doc.uid, KEPT, 'and owned by the signed-in poster');
  eq(posted.doc.chairName, 'Chair Person',
    'the chair travels with the posting (never published — not in PUBLIC_FIELDS)');
  eq(posted.doc.characteristics, ['PhD'], 'and so does the ticked characteristic');
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

  /* -- a school that repeats the university is shown ONCE (owner, 2026-09-02)

     The School box is mandatory now, and a place with no separate school
     (INSEAD, IE Business School) is told to repeat the institution's name in
     it. That name must not publish twice: the preview says so as the poster
     types, and the stored document carries no school and the department line
     said once. A made-up university, so no curated record can fill a school
     in behind the poster's back. */

  const repeated = await onSite('post-a-job.html', { user: keptUser, docs: [] }, async (q) => {
    await q.waitForSelector('#oa-job-form:not([hidden])', { timeout: 10000 });
    await q.fill('#f-institution', 'Repeat Institute of Technology');
    await q.fill('#f-school', 'Repeat Institute of Technology');
    await q.fill('#f-unit', 'Operations Management');
    const preview = await q.$eval('#f-department-preview', (n) => n.textContent);
    await q.selectOption('#f-type', 'University');
    await q.fill('#f-country', 'Ireland');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    // the box keeps what the poster typed — a blur must not blank the repeat
    // the hint asked for, or the mandatory check refuses it a moment later
    const keptTyped = await q.$eval('#f-school', (n) => n.value);
    await q.check('input[name="levels"][value="Assistant Professor"]');
    await q.check('input[name="characteristics"][value="PhD"]');
    await q.check('#f-untilFilled');
    await q.fill('#f-deptUrl', 'https://ops.example.edu/rit');
    await q.fill('#f-firstName', 'Kon');
    await q.fill('#f-lastName', 'Stouras');
    await q.fill('#f-email', 'kon@example.edu');
    await q.fill('#f-chairName', 'Chair Person');
    await q.fill('#f-chairEmail', 'chair@example.edu');
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    const doc = await q.evaluate(() => {
      const d = window.__fb.dump();
      const k = Object.keys(d).find((p) => p.startsWith('jobSubmissions/'));
      return d[k];
    });
    return { preview, keptTyped, doc };
  });
  ok(/Operations Management/.test(repeated.preview) && /not repeated/.test(repeated.preview),
    'v3 post-a-job: the preview shows the department alone and says the institution\u2019s name is not repeated');
  ok(!/Technology, Operations/.test(repeated.preview),
    'v3 post-a-job: …and never the two names joined');
  eq(repeated.keptTyped, 'Repeat Institute of Technology',
    'v3 post-a-job: leaving the School box keeps the repeat the hint asked for');
  eq(repeated.doc.school || '', '',
    'v3 post-a-job: the stored posting carries no school — the name is said once');
  eq(repeated.doc.department, 'Operations Management',
    'v3 post-a-job: …and its department line is the department alone');
  eq(repeated.doc.institution, 'Repeat Institute of Technology',
    'v3 post-a-job: …under the institution, which is untouched');

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
    // (a characteristic and the chair pair are mandatory on a new posting)
    await q.fill('#f-deptUrl', 'https://corrected.example/ds');
    await q.fill('#f-country', 'France');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.check('input[name="levels"][value="Assistant Professor"]');
    await q.check('input[name="characteristics"][value="PhD"]');
    await q.check('#f-untilFilled');
    await q.fill('#f-firstName', 'Kon');
    await q.fill('#f-lastName', 'Stouras');
    await q.fill('#f-email', 'kon@example.edu');
    await q.fill('#f-chairName', 'Chair Person');
    await q.fill('#f-chairEmail', 'chair@example.edu');
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
      // the new-posting-only mandatory fields (chair, department page,
      // characteristics) must not block an EDIT: j9 predates them and
      // carries none, and the * marks are lifted with the rule
      reqMarks: document.querySelectorAll('.oa-req-new').length,
    }));
    await q.fill('#f-institution', 'Edit University (fixed)');
    await q.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await q.click('#oa-submit');
    await q.waitForSelector('#oa-done:not([hidden])', { timeout: 10000 });
    return { prefill, doc: await q.evaluate(() => window.__fb.dump()['jobSubmissions/j9']) };
  });
  eq(edited.prefill, { school: 'School X', date: '2026-12-01', btn: 'Save changes', reqMarks: 0 },
    'v3 edit: the stored posting is loaded back into the form, with the ' +
    'new-posting-only required marks lifted — an old posting saves without ' +
    'inventing a chair');
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
    // the candidate's OWN areas (owner, 2026-08-30): commas AND semicolons
    // split, and a typed respelling of a ticked area must fold onto the
    // tick's spelling rather than publish the same area twice
    await q.fill('#f-areasOther', 'Queueing Theory; supply chain management, Energy Markets');
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
  eq(cand.doc.researchAreas,
    ['Supply Chain Management', 'Queueing Theory', 'Energy Markets'],
    'own research areas join the ticked ones \u2014 split on commas and semicolons, ' +
    'a respelling of a listed area folded onto its one spelling, never doubled');

  /* -- one profile per account per market year (owner, 2026-08-24) --------- */

  const oneSeed = { user: keptUser, docs: [{ path: 'candidateSubmissions/c9', data: {
    uid: KEPT, status: 'queued', ref: 'OA-CAND-260820-ZZZZ',
    first: 'Grace', last: 'Hopper', affiliation: 'Test University',
    position: 'PhD Candidate', year: marketYear(),
    researchAreas: ['Supply Chain Management', 'Queueing Theory'],
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
      areaTicked: document.querySelector(
        'input[name="researchAreas"][value="Supply Chain Management"]').checked,
      areaOther: document.getElementById('f-areasOther').value,
    }));
  });
  eq(one.heading.trim(), 'Edit your profile',
    'a candidate who already has a profile this season is sent to EDIT it \u2014 one profile per market year');
  eq(one.first, 'Grace', 'and the form holds their own profile, not a blank one');
  eq(one.inst, 'Test University',
    'a pre-split profile\u2019s free-text affiliation lands in the university box to redistribute');
  eq([one.areaTicked, one.areaOther], [true, 'Queueing Theory'],
    'editing round-trips a candidate\u2019s OWN research area into its box \u2014 ' +
    'a save must never silently drop an area the checkbox list does not offer');

  /* -- a profile from a PAST season is named, not redirected to ------------

     The menu's "My candidate profile" count has no year filter, so an account
     whose only profile is last spring's is promised one; the form is the right
     page for THIS season (one profile per market year), but a blank form that
     mentioned nothing would read as the row lying. */
  const lastSeed = { user: keptUser, docs: [{ path: 'candidateSubmissions/c8', data: {
    uid: KEPT, status: 'queued', ref: 'OA-CAND-260220-YYYY',
    first: 'Ada', last: 'Lovelace', affiliation: 'Test University',
    position: 'PhD Candidate', year: marketYear() - 1,
    createdAt: '2026-02-20T00:00:00.000Z',
  } }] };
  const last = await onSite('post-a-candidate.html', lastSeed, async (q) => {
    await q.waitForFunction(() => /You have a profile from/.test(
      (document.getElementById('oa-msg') || {}).textContent || ''), null, { timeout: 10000 });
    return q.evaluate(() => ({
      url: location.pathname + location.search,
      heading: (document.querySelector('.v3-pa-hero .v3-h1') ||
        document.querySelector('.title-heading h2') || {}).textContent || '',
      msg: document.getElementById('oa-msg').textContent.replace(/\s+/g, ' ').trim(),
      link: (document.querySelector('#oa-msg a') || {}).getAttribute('href'),
      first: document.getElementById('f-first').value,
      formShown: !document.getElementById('oa-cand-form').hidden,
    }));
  });
  ok(!/\?edit=/.test(last.url), 'last season: the account is NOT redirected to a past season\'s profile');
  ok(last.heading.trim() !== 'Edit your profile' && last.first === '' && last.formShown,
    'last season: …the create form for the season under way is what it gets');
  const ly = marketYear() - 1;
  ok(new RegExp('You have a profile from the ' + (ly - 1) + '\u2013' + ly + ' job market: open it, ' +
     'or file one for the ' + (marketYear() - 1) + '\u2013' + marketYear() + ' market below\\.').test(last.msg),
    'last season: …and the older profile is named above it, with its market year');
  eq(last.link, 'post-a-candidate.html?edit=c8',
    'last season: the message links straight to that profile');

  /* -- the candidate's PRIVATE view statistics (owner, 2026-09-04) ---------

     The edit page draws a panel from the `stats` map build-candidate-stats.mjs
     writes onto the candidate's own document. Two states, chosen by ROUTING
     the reveal file rather than by the calendar, so this stays green on the
     reveal day: before the reveal it says the profile is not public yet and
     names the date; after it, the season and 7-day figures, with a hostile
     value rendered as a number and never as markup. */
  async function onSiteRouted(url, seed, reveal, drive) {
    const q = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify(seed)};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.route('**/data/candidates-reveal.json*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reveal) }));
    await q.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    const out = await drive(q);
    eq(errors, [], `${url}: no uncaught script error`);
    await q.close();
    return out;
  }
  const readPanel = async (q) => {
    await q.waitForFunction(() => {
      const b = document.getElementById('oa-cand-stats');
      return b && !b.hidden && b.textContent.trim().length > 0;
    }, null, { timeout: 8000 });
    return q.evaluate(() => {
      const b = document.getElementById('oa-cand-stats');
      return { text: b.textContent.replace(/\s+/g, ' ').trim(), imgs: b.querySelectorAll('img').length };
    });
  };
  const today = new Date().toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const statsDoc = { ...oneSeed.docs[0].data, stats: {
    opens: 12, cvClicks: 3, updatedAt: today + 'T04:30:00.000Z',
    days: { [longAgo]: [10, 2], [today]: [2, 1] },
  } };

  const heldPanel = await onSiteRouted('post-a-candidate.html?edit=c9', oneSeed,
    { revealAt: '2099-01-01' }, readPanel);
  /* THE DAY AS THE SITE WRITES IT, asked of the module rather than typed: the
     panel used to compare a UTC calendar day against the date (the reading
     seven other files were taken off, wrong for the fourteen hours of reveal
     morning) and to print the raw ISO string. Both go through
     assets/oa-reveal.js now, so this check cannot disagree with the page
     about either. */
  const { createRequire: reqFor } = await import('node:module');
  const RevealNode = reqFor(import.meta.url)(path.join(ROOT, 'assets', 'oa-reveal.js'));
  const heldDay = RevealNode.formatDay('2099-01-01');
  ok(/Your profile on the site/.test(heldPanel.text) && /not public yet/.test(heldPanel.text) &&
     heldPanel.text.indexOf(heldDay) !== -1,
    `before the reveal the panel says the profile is not public yet, and names the day (${heldDay})`);
  ok(heldPanel.text.indexOf('2099-01-01') === -1,
    'as the site writes a day, never as a raw ISO string');
  ok(!/Opened \d/.test(heldPanel.text), 'and shows no count that would read as "nobody is interested"');

  const shownPanel = await onSiteRouted('post-a-candidate.html?edit=c9',
    { user: keptUser, docs: [{ path: 'candidateSubmissions/c9', data: statsDoc }] },
    { revealAt: '2000-01-01' }, readPanel);
  ok(/Opened 12 times this season, 2 times in the last 7 days/.test(shownPanel.text),
    'after the reveal it shows the season opens and the last 7 days (the 40-day-old day is out)');
  ok(/CV opened 3 times this season, 1 time in the last 7 days/.test(shownPanel.text),
    'and the CV clicks, singular where it is one');
  ok(shownPanel.text.includes('Updated ' + today), 'and when the count was last updated');
  ok(/only you and the site maintainer can see them/.test(shownPanel.text),
    'and says the figures are private — naming the maintainer, who sees them on the ' +
    'Admin area inbox card, as the Privacy Policy does');

  const hostilePanel = await onSiteRouted('post-a-candidate.html?edit=c9',
    { user: keptUser, docs: [{ path: 'candidateSubmissions/c9', data: { ...statsDoc, stats: {
      opens: '<img src=x onerror=alert(1)>', cvClicks: -4, updatedAt: '<b>x</b>', days: 'nope',
    } } }] },
    { revealAt: '2000-01-01' }, readPanel);
  eq(hostilePanel.imgs, 0, 'a hostile value in the stats map draws no element');
  ok(/Opened 0 times this season, 0 times in the last 7 days/.test(hostilePanel.text) &&
     /CV opened 0 times/.test(hostilePanel.text) && !/<b>/.test(hostilePanel.text),
    'and every figure is a number, never text or markup');

  /* \u2026and the personal area's candidate card carries the season totals */
  const areaCard = await onSiteRouted('account.html',
    { user: keptUser, docs: [{ path: 'candidateSubmissions/c9', data: statsDoc }] },
    { revealAt: '2000-01-01' }, async (q) => {
      await q.waitForFunction(() =>
        /its CV/.test((document.getElementById('pa-cand-card') || {}).textContent || ''),
        null, { timeout: 8000 });
      return q.evaluate(() => document.getElementById('pa-cand-card').textContent.replace(/\s+/g, ' '));
    });
  ok(/opened 12 times and its CV 3 times/.test(areaCard),
    'account.html: the candidate card says how often the profile and its CV were opened this season');

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
  /* THE VISITOR IS A DIFFERENT PERSON FROM THE POSTER, so they get a page of
     their own. This block used to model a signed-in poster by injecting a
     permission map into a signed-OUT page, which was an approximation the
     reader gate has now made a contradiction: signed out, a card does not
     open at all, so "pressing Edit does not also toggle the card open" could
     not be asked. The poster below is signed in for real. */
  {
    const v = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    v.on('pageerror', (e) => jsErrors.push('jobs visitor: ' + e.message));
    await v.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
    await v.waitForSelector('.oa-card');
    await v.waitForTimeout(600);
    eq(await v.$$eval('.oa-card-actions', (n) => n.length), 0,
      'jobs: a visitor who is not signed in sees no Edit or Take down');
    await v.close();
  }

  const { ctx: jCtx, page: j, errors: jErrors } = await signedInPage('jobs.html');
  await j.waitForTimeout(400);

  /* ------------------------------ the filter bar: several terms, one row --
     Owner, from three screenshots: the search took ONE institution at a time,
     and a filter with values chosen knocked the bar out of line.

     THE BAR IS SIGN-IN GATED on this page — .v3-lock puts pointer-events:none
     over it until an account resolves. This reader IS signed in, so the lock
     comes off by itself; the override stays because it comes off when the SDK
     answers and the first paint is taken from the localStorage hint, which a
     fresh context has none of. These checks are about the bar, not the gate,
     which has its own coverage. The lock is defeated by
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

  /* A NAME THE SITE KNOWS BY ANOTHER SPELLING. The e-mail matcher has always
     tried the needle's own canonical forms and this page's search had not, so
     "UC Berkeley", "Penn State" or "Imperial Business School" typed here found
     NOTHING while an alert holding the same words matched and was e-mailed —
     31 spellings apart, measured over the served postings. "What I see on the
     site" and "what I am e-mailed" cannot mean different things.

     The alias is picked FROM THE PAGE, never named here: the corpus is rebuilt
     every morning and a check that names a university goes red for a reason
     that is not a regression. It asks the names module for an alias whose
     canonical value is an institution this listing is actually showing. */
  const alias = await j.evaluate(() => {
    const S = window.OASchools;
    if (!S || !S.INSTITUTION_ALIASES) return null;
    const on = new Set([...document.querySelectorAll('.oa-card .oa-card-title')]
      .map((t) => S.fold(t.textContent)));
    for (const k of Object.keys(S.INSTITUTION_ALIASES)) {
      const canon = S.fold(S.INSTITUTION_ALIASES[k]);
      if (!canon || S.fold(k) === canon) continue;
      /* NOT AN ALL-CAPS ALIAS. The engine matches an all-caps needle against
         the INITIALS of a field's words, its own documented rule, so "CUHK"
         also finds City University of Hong Kong, and this check, which is
         about the canonical-form leg alone, then fails on a rule it is not
         measuring. An alias with a lowercase letter reaches only that leg. */
      if (!/[a-z]/.test(k)) continue;
      for (const name of on) {
        /* the alias must not already be a substring of the name, or the bare
           fold would have found it and this proves nothing */
        if (name.indexOf(canon) !== -1 && name.indexOf(S.fold(k)) === -1) {
          return { typed: k, expect: S.INSTITUTION_ALIASES[k] };
        }
      }
    }
    return null;
  });
  if (alias) {
    await j.fill('#oaf-institution', alias.typed);
    await j.waitForTimeout(320);
    const hits = await j.evaluate((a) => {
      const S = window.OASchools;
      return [...document.querySelectorAll('.oa-card .oa-card-title')].map((n) => ({
        text: n.textContent.trim(),
        /* folded on BOTH sides, and either spelling counts: the row is a hit
           because the needle named it, whichever of its two names it did so by */
        named: S.fold(n.textContent).indexOf(S.fold(a.expect)) !== -1
            || S.fold(n.textContent).indexOf(S.fold(a.typed)) !== -1,
      }));
    }, alias);
    ok(hits.length > 0,
      `jobs: "${alias.typed}" finds the postings the site publishes as "${alias.expect}"`);
    eq(hits.filter((h) => !h.named).map((h) => h.text), [],
      `jobs: …and only those, so the canonical form narrows rather than widening ` +
      `(typed "${alias.typed}", canonical "${alias.expect}")`);
    await j.fill('#oaf-institution', '');
    await j.waitForTimeout(320);
  } else {
    ok(false, 'jobs: no alias in the tables names an institution this listing shows — ' +
      'the check cannot run, which is not the same as passing');
  }

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

  /* A DRAFT THAT FOLDS TO NOTHING MUST NOT TURN THE FILTER OFF. The terms are
     OR'd and an empty needle matched every row, so a box holding only a space
     or a bracket — which every reader types in the middle of a name — showed
     the WHOLE list while the chips above it still said otherwise. */
  await j.fill('#oaf-institution', ' ');
  await j.waitForTimeout(350);
  eq(await j.$$eval('.oa-filter:not(.oa-pick) .oa-chip .oa-chip-label',
    (ns) => ns.map((n) => n.textContent)), [pair.b],
    'jobs: a punctuation-only draft leaves the banked chip standing');
  ok(await shown() < total,
    'jobs: ...and the list it narrowed stays narrowed rather than opening up');
  await j.fill('#oaf-institution', '');
  await j.waitForTimeout(350);

  await j.click('.oa-clear');
  await j.waitForTimeout(250);
  eq(await j.$$eval('.oa-chip', (ns) => ns.length), 0,
    'jobs: Clear filters drops the banked terms too');
  eq(await shown(), total, 'jobs: and the whole listing comes back');

  /* THE PAGER KEEPS THE KEYBOARD. render() rebuilds the result bar, so the
     button just pressed is gone and focus fell to <body>: a reader turning
     pages from the keyboard had to Tab all the way back in for every page. */
  const pagerState = async () => j.evaluate(() => {
    const a = document.activeElement;
    return { tag: a ? a.tagName.toLowerCase() : '', label: a ? (a.getAttribute('aria-label') || '') : '' };
  });
  await j.$eval('.oa-pager button[aria-label="Next page"]', (n) => n.focus());
  await j.click('.oa-pager button[aria-label="Next page"]');
  await j.waitForTimeout(250);
  eq(await pagerState(), { tag: 'button', label: 'Next page' },
    'jobs: turning to the next page leaves the focus on the pager, not on <body>');
  await j.click('.oa-pager button[aria-label="Previous page"]');
  await j.waitForTimeout(250);
  eq((await pagerState()).tag, 'button',
    'jobs: and back again — a keyboard reader can turn more than one page per Tab');

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
  await jCtx.close();
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
  /* WHO IS READING DECIDES WHETHER IT OPENS (assets/oa-gate.js). A link to
     one posting still narrows the page to that posting for anybody — that is
     what the mode is for, and the way back below has to work for them — but
     the details themselves are a registered reader's. So the two shapes are
     measured as the two shapes: signed out the card is locked, and the
     signed-in half is driven through the real sign-in path below. */
  eq(await d.$eval('.oa-card', (n) => n.classList.contains('oa-card-locked')), true,
    `${pageName}: signed out, the one posting is on screen and still locked`);
  eq(await d.$$eval('.oa-card-body', (n) => n.length), 0,
    `${pageName}: …with none of its details in the document`);
  ok(await d.$('.oa-card-lock-note'),
    `${pageName}: …and the card says what would open it`);
  {
    const { ctx, page: q } = await signedInPage(
      `${pageName}?job=${encodeURIComponent(target.id)}`);
    eq(await q.$$eval('.oa-card', (n) => n.length), 1,
      `${pageName}: signed in, ?job= still shows exactly one posting`);
    eq(await q.$eval('.oa-card-head', (n) => n.getAttribute('aria-expanded')), 'true',
      `${pageName}: opened, so its details are on screen without another click`);
    ok(await q.$eval('.oa-card-body', (n) => !n.hidden),
      `${pageName}: …and they really are rendered`);
    await ctx.close();
  }

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
  /* SIGNED IN, because this block reads a card's own detail rows — the "Job
     market year" cell — and a closed season is still a job posting, so a
     reader who has not registered does not get one (assets/oa-gate.js). The
     counts and the filters below are the same either way. */
  const { ctx: pmCtx, page: p, errors: pmErrors } = await signedInPage(
    'previous-markets.html', { viewport: { width: 1300, height: 950 } });

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
  await p.click('.oa-card:first-child .oa-card-head');
  await p.waitForTimeout(200);
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
  eq(pmErrors, [], 'previous-markets: no uncaught script errors');
  await pmCtx.close();
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
  /* SIGNED IN, because the property under test is about the card's DETAIL
     rows and those are a registered reader's since the gate shipped. It is
     also the truer reading: the override map is the maintainer's, and a
     signed-out visitor never sees a body to smuggle anything into. */
  const { ctx: xCtx, page: p, errors: xErrs } = await signedInPage(
    // an archive season, so the row is one this editor owns (see above)
    'previous-markets.html?year=2015');
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

  eq(xErrs, [], 'and the page raises no error over it');
  await xCtx.close();
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

/* THE ONE MEASURE OF A LIST PAGE ON A PHONE. The MOBILE_PAGES loop below
   and the forum's own 390px block both call it, so the standard is measured
   one way: a page that cannot join the loop (forum.html shows a sign-in card
   signed out and mounts no list, and the loop waits for a rendered list and a
   visible bar) is still held to the same numbers by the same code. */
const MOBILE_LIST_MEASURE = () => {
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
  };

/** The assertions over that measure, `at` naming the page in each message.
    Answers whether the page had a bar to measure at all (a dataset-empty page
    hides its bars deliberately, and there is nothing more to hold it to). */
function assertMobileList(mob, at) {
  ok(!mob.overflowX, `${at} the page never scrolls sideways`);
  if (mob.barless) return false;
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
  return true;
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

  const mob = await m.evaluate(MOBILE_LIST_MEASURE);
  assertMobileList(mob, `mobile ${pageName}:`);
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

/* ------------------------ the menu lists only what the account HOLDS

   Owner, 2026-09-04: "My postings" for an account that has posted, "My
   candidate profile" for one that has filed a profile, and NEITHER for an
   account holding nothing. Three seeded accounts through the site's own
   sign-in path (the shim), each on index.html, which carries the header menu
   AND the phone sheet's copy. A row is measured as the reader meets it — the
   menu opened by the chip, the row visible or not — never by its presence in
   the markup, because being in the markup and hidden until the count says
   otherwise is exactly the mechanism. The fourth reading is the one no
   scenario reaches on its own: a count NOT KNOWN (no cache, no refresh this
   session) draws neither row, the poster's included. */
{
  const HELD = A_READER.uid;
  const seeds = {
    nothing: [],
    poster: [{ path: 'jobSubmissions/held-j1', data: {
      uid: HELD, status: 'published', ref: 'OA-JOB-260901-HELD',
      institution: 'Held University', department: 'Operations',
      createdAt: '2026-09-01T00:00:00.000Z' } }],
    /* WITHDRAWN on purpose: a taken-down profile still exists and is its
       owner's to restore, so it must still earn the row */
    candidate: [{ path: 'candidateSubmissions/held-c1', data: {
      uid: HELD, status: 'withdrawn', ref: 'OA-CAND-260901-HELD',
      first: 'Grace', last: 'Hopper', affiliation: 'Held University',
      position: 'PhD Candidate', year: marketYear(), researchAreas: [],
      createdAt: '2026-09-01T00:00:00.000Z' } }],
  };
  const readRows = (q) => q.evaluate(() => {
    const row = (root, href) => {
      const el = document.querySelector(root + ' a[href="' + href + '"]');
      if (!el) return null;
      const badge = el.querySelector('.oa-acct-n');
      // the LABEL: the row's own text nodes, without the icon glyph or the badge
      const text = [...el.childNodes].filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join('').trim();
      return { hidden: el.hidden, text,
        badge: badge ? (badge.hidden ? '' : badge.textContent) : null };
    };
    return {
      menuPostings: row('#oa-menu', 'my-postings.html'),
      menuCand: row('#oa-menu', 'post-a-candidate.html'),
      sheetPostings: row('#oa-np', 'my-postings.html'),
      sheetCand: row('#oa-np', 'post-a-candidate.html'),
      alerts: row('#oa-menu', 'alerts.html'),
      messages: row('#oa-menu', 'messages.html'),
      area: row('#oa-menu', 'account.html'),
    };
  });
  async function heldRows(name, docs) {
    const { ctx, page: q, errors } = await signedInPage('index.html', { docs, selector: '#oa-chip' });
    // the refresh has landed once the once-per-session latch is written
    await q.waitForFunction((uid) => {
      try { return sessionStorage.getItem('oa-acct-counts-fresh') === uid; } catch (e) { return false; }
    }, HELD, { timeout: 15000 });
    await q.waitForTimeout(100);
    await q.click('#oa-chip');
    const rows = await readRows(q);
    const shown = {
      postings: await q.locator('#oa-menu a[href="my-postings.html"]').isVisible(),
      cand: await q.locator('#oa-menu a[href="post-a-candidate.html"]').isVisible(),
    };
    eq(errors, [], `held rows (${name}): no uncaught script error`);
    return { ctx, q, rows, shown };
  }

  /* -- an account holding nothing: neither row, the rest of the menu intact */
  {
    const { ctx, rows, shown } = await heldRows('nothing', seeds.nothing);
    eq(shown, { postings: false, cand: false },
      'held rows: an account with no posting and no profile is shown neither row');
    ok(rows.menuPostings && rows.menuPostings.hidden && rows.menuCand && rows.menuCand.hidden,
      'held rows: …the rows are in the markup, hidden — not drawn and then removed');
    ok(rows.sheetPostings && rows.sheetPostings.hidden && rows.sheetCand && rows.sheetCand.hidden,
      'held rows: and the phone sheet mirrors it');
    ok(rows.alerts && !rows.alerts.hidden && rows.messages && !rows.messages.hidden &&
       rows.area && !rows.area.hidden,
      'held rows: E-mail alerts, Messages and My personal area stay as they were');
    await ctx.close();
  }

  /* -- an account that has posted a job: My postings, with its count ------- */
  {
    const { ctx, q, rows, shown } = await heldRows('poster', seeds.poster);
    eq(shown, { postings: true, cand: false },
      'held rows: an account with a job posting is shown My postings and not the profile row');
    eq(rows.menuPostings.badge, '1', 'held rows: …and the badge still counts');
    eq(rows.menuPostings.text, 'My postings', 'held rows: labelled My postings');
    ok(!rows.sheetPostings.hidden && rows.sheetCand.hidden,
      'held rows: the phone sheet draws My postings and not the profile row');

    /* the count NOT KNOWN: no cache and no refresh this session — the same
       account, and the row it has earned is withheld rather than guessed */
    await q.evaluate((uid) => {
      localStorage.removeItem('oa-acct-counts');
      sessionStorage.setItem('oa-acct-counts-fresh', uid);
    }, HELD);
    await q.reload({ waitUntil: 'load' });
    await q.waitForSelector('#oa-chip', { timeout: 15000 });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.waitForTimeout(400);
    await q.click('#oa-chip');
    const unknown = await readRows(q);
    ok(unknown.menuPostings.hidden && unknown.menuCand.hidden &&
       unknown.sheetPostings.hidden && unknown.sheetCand.hidden &&
       unknown.menuPostings.badge === '',
      'held rows: with the count not known, NEITHER row is drawn — the poster\'s ' +
      'own My postings included — rather than a row that may be wrong');
    await ctx.close();
  }

  /* -- an account that has filed a candidate profile (withdrawn) ------------ */
  {
    const { ctx, q, rows, shown } = await heldRows('candidate', seeds.candidate);
    eq(shown, { postings: false, cand: true },
      'held rows: an account with a candidate profile is shown My candidate profile and not My postings');
    eq(rows.menuCand.text, 'My candidate profile', 'held rows: labelled My candidate profile');
    eq(rows.menuCand.badge, '1',
      'held rows: a WITHDRAWN profile still counts — it exists and is its owner\'s to restore');
    ok(!rows.sheetCand.hidden && rows.sheetPostings.hidden,
      'held rows: the phone sheet draws My candidate profile and not My postings');
    eq(await q.locator('#oa-menu a[href="post-a-candidate.html"]').getAttribute('href'),
      'post-a-candidate.html',
      'held rows: the row opens post-a-candidate.html, which sends an owner to their own profile');
    await ctx.close();
  }

  /* -- the personal area's card goes straight to the profile ---------------- */
  {
    const { ctx, page: q, errors } = await signedInPage('account.html',
      { docs: seeds.candidate, selector: '#oa-chip' });
    await q.waitForFunction(() =>
      /\?edit=/.test((document.getElementById('pa-cand-card') || {}).href || ''),
      null, { timeout: 15000 });
    const card = await q.evaluate(() => {
      const el = document.getElementById('pa-cand-card');
      return { href: el.getAttribute('href'), h3: el.querySelector('h3').textContent.trim() };
    });
    eq(card.href, 'post-a-candidate.html?edit=held-c1',
      'personal area: the candidate card links straight to the profile the account holds');
    ok(/Your candidate profile/.test(card.h3), 'personal area: …and reads "Your candidate profile"');
    /* and, holding the real lists, it corrected the menu's cache for free */
    const cached = await q.evaluate(() =>
      (JSON.parse(localStorage.getItem('oa-acct-counts') || '{}').n || {}));
    eq([cached.postings, cached.cands], [0, 1],
      'personal area: the page corrects the postings and profile counts it just read');
    eq(errors, [], 'personal area: no uncaught script error');
    await ctx.close();
  }
  {
    const { ctx, page: q } = await signedInPage('account.html',
      { docs: seeds.nothing, selector: '#oa-chip' });
    await q.waitForFunction(() =>
      (document.getElementById('pa-n-jobs') || {}).textContent === '0', null, { timeout: 15000 });
    const card = await q.evaluate(() => {
      const el = document.getElementById('pa-cand-card');
      return { href: el.getAttribute('href'), h3: el.querySelector('h3').textContent.trim() };
    });
    eq(card.href, 'post-a-candidate.html',
      'personal area: with no profile the card still offers the form');
    ok(/^Candidate profile$/.test(card.h3.replace(/^\S+\s*/, '')) || /Candidate profile/.test(card.h3),
      'personal area: …and reads "Candidate profile", not "Your"');
    ok(!/Your candidate profile/.test(card.h3), 'personal area: never "Your candidate profile" for nobody');
    await ctx.close();
  }
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

/* ------------------------- what an UNREGISTERED reader sees, measured

   Owner, 2026-08-29, from two screenshots of the site signed out: the details
   of a job posting were on the page for anybody. The rule is that a reader who
   has not registered sees who is hiring — the sponsor's posting and the
   universities behind the ones beside it — and a candidate's NAME, and nothing
   else; the card does not open on them; expanding one in place belongs to a
   registered reader who has opened the full list.

   `selftest.mjs` pins the decision, the wiring and the words. This is the half
   only a browser can answer: WHO IS SHOWN WHAT. Both readers are real — the
   signed-out one has no Firebase at all, the signed-in one comes through
   _fake-firebase.js and the site's own auth path — because the property is a
   difference between them and a check that saw only one of the two would pass
   on a page that had lost the distinction entirely.                          */
{
  const GATED = [
    ['jobs.html', '#oa-jobs', 'Sign in to read this posting'],
    ['previous-markets.html', '#oa-past', 'Sign in to read this posting'],
  ];

  for (const [pageName, host, note] of GATED) {
    /* -- signed OUT, but ABLE to sign in --------------------------------- */
    const { ctx: outCtx, page: out, errors: outErrs } = await signedOutPage(pageName);
    await out.waitForSelector(`${host} .oa-card`, { timeout: 15000 });
    await out.waitForTimeout(300);
    /* The rows as the SITE serves them, handed to the page so the leak check
       below compares a card against its own posting rather than against a
       fixture that could drift from the data. Both files, because the two
       pages partition the corpus between them. */
    await out.evaluate(async () => {
      const by = {};
      for (const url of ['/data/jobs.json', '/data/past-postings.json']) {
        try {
          const rows = await (await fetch(url, { cache: 'no-cache' })).json();
          for (const r of rows) if (r && r.id) by[r.id] = r;
        } catch { /* the page under test does not need both */ }
      }
      window.__GATE_ROWS = by;
    });

    const shut = await out.evaluate((h) => {
      const cards = [...document.querySelectorAll(`${h} .oa-card`)];
      const first = cards[0];
      return {
        cards: cards.length,
        /* WHO is hiring stays readable — that is the whole of what an
           unregistered reader is promised, and a list of blurred names would
           be no list at all. */
        title: first ? first.querySelector('.oa-card-title').textContent.trim() : '',
        sub: first ? first.querySelector('.oa-card-sub').textContent.trim() : '',
        locked: cards.filter((c) => c.classList.contains('oa-card-locked')).length,
        bodies: document.querySelectorAll(`${h} .oa-card-body`).length,
        kv: document.querySelectorAll(`${h} .oa-kv`).length,
        notes: [...document.querySelectorAll(`${h} .oa-card-lock-note`)]
          .map((n) => n.textContent.trim()),
        expanded: cards.filter((c) =>
          c.querySelector('.oa-card-head').hasAttribute('aria-expanded')).length,
      };
    }, host);

    ok(shut.cards > 1, `${pageName}: signed out, the postings are still listed`);
    ok(shut.title.length > 2, `${pageName}: …and the university is readable`);
    ok(shut.sub.length > 2, `${pageName}: …with the school and department beside it`);
    eq(shut.locked, shut.cards, `${pageName}: every card on the page is locked`);
    /* NOT HIDDEN — ABSENT. A blurred copy of the real values is a picture of a
       lock: selectable, copyable, and one keystroke of devtools from being
       read. The engine returns before the table is built at all. */
    eq([shut.bodies, shut.kv], [0, 0],
      `${pageName}: and not one detail of any of them is in the document`);
    eq(shut.expanded, 0,
      `${pageName}: a head that discloses nothing no longer claims to`);
    eq([...new Set(shut.notes)], [note],
      `${pageName}: each card says what would open it, in the page's own words`);

    /* THE STRONGEST FORM OF THE PROMISE, measured against the site's own
       data rather than a fixture: take what each locked card's posting
       actually SAYS and prove none of it is anywhere in that card's markup.
       The checks above assert the absence of the containers; this asserts the
       absence of the CONTENT, which is what "never able to view details"
       means and what a future refactor could quietly undo while every
       structural check stayed green (a hidden body, an aria-label, a data-
       attribute, a title carrying the comments would all pass those).

       Values are matched at 12+ characters: shorter ones ("Sunday", a bare
       year, "link") legitimately occur in the page's own furniture, and a
       check that fired on those would be noise rather than a finding.

       WHAT IS ALLOWED IS MEASURED FROM THE HEAD ITSELF, not from a list of
       field names. Who is hiring stays readable, so anything the head already
       displays is not a leak — and a name list would rot: `school` and `unit`
       are the two halves the subtitle is joined from, and `type` ("Business
       School") is a substring of that subtitle by coincidence at CUHK and
       would not be at the next university. Stating the rule as "nothing in
       this card that its own head does not already show" needs no
       maintenance and says exactly what the promise is. `id` is excluded
       separately because it is the element's id attribute rather than text. */
    const leaked = await out.evaluate((h) => {
      const out2 = [];
      for (const card of document.querySelectorAll(`${h} .oa-card`)) {
        const html = card.outerHTML;
        const shown = card.querySelector('.oa-card-head').textContent;
        const row = (window.__GATE_ROWS || {})[card.id.replace(/^job-/, '')];
        if (!row) continue;
        for (const [k, v] of Object.entries(row)) {
          if (k === 'id') continue;
          if (typeof v !== 'string' || v.length < 12) continue;
          if (shown.includes(v)) continue;          // the head is meant to show it
          if (html.includes(v)) out2.push(card.id + ' → ' + k + ': ' + v.slice(0, 40));
        }
      }
      return out2;
    }, host);
    eq(leaked.slice(0, 4), [],
      `${pageName}: and no value any of those postings holds is anywhere in its card`);

    /* THE CARD DOES NOT EXPAND — the owner's own sentence. Press it and what
       arrives is the sign-in box, not a body. */
    await out.click(`${host} .oa-card:first-child .oa-card-head`);
    await out.waitForTimeout(600);
    eq(await out.$$eval(`${host} .oa-card-body`, (n) => n.length), 0,
      `${pageName}: pressing a card opens NOTHING`);
    ok(await out.$('.oa-modal'), `${pageName}: …it offers the sign-in box instead`);
    eq(outErrs, [], `${pageName}: signed-out run — no uncaught script error`);
    await outCtx.close();

    /* -- signed IN ------------------------------------------------------- */
    const { ctx, page: q, errors } = await signedInPage(pageName);
    await q.waitForSelector(`${host} .oa-card`, { timeout: 15000 });
    await q.waitForTimeout(300);
    eq(await q.$$eval(`${host} .oa-card-locked`, (n) => n.length), 0,
      `${pageName}: signed in, nothing is locked`);
    await q.click(`${host} .oa-card:first-child .oa-card-head`);
    await q.waitForTimeout(250);
    ok(await q.$eval(`${host} .oa-card:first-child .oa-card-body`, (n) => !n.hidden),
      `${pageName}: …and a card opens where it stands, which is what the full list is`);
    ok((await q.$$eval(`${host} .oa-card:first-child .oa-kv th`,
      (ns) => ns.map((n) => n.textContent))).length >= 2,
      `${pageName}: …with its details on it`);
    /* THE POSTING'S OWN ID IS THE LAST LINE (owner, 2026-09-02): the id the
       site uses for it everywhere, as a link to its own permalink, so a
       reader can quote it or copy the address. Measured against the card's
       own element id rather than a fixture. */
    const idRow = await q.$eval(`${host} .oa-card:first-child`, (li) => {
      const ths = [...li.querySelectorAll('.oa-kv th')];
      const last = ths[ths.length - 1];
      const a = li.querySelector('.oa-kv a.oa-ref');
      return { label: last ? last.textContent.trim() : '',
        text: a ? a.textContent.trim() : '', href: a ? a.getAttribute('href') : '',
        id: li.id.replace(/^job-/, '') };
    });
    eq(idRow.label, 'OA posting ID', `${pageName}: the last row is the posting's ID`);
    eq(idRow.text, idRow.id, `${pageName}: …showing the id the card itself carries`);
    eq(idRow.href, `${pageName}?job=${encodeURIComponent(idRow.id)}`,
      `${pageName}: …as a link to this one posting on this page`);
    eq(errors, [], `${pageName}: signed-in run — no uncaught script error`);
    await ctx.close();
  }

  /* -- the one-pager: the teaser NEVER expands, whoever is reading -------- */
  {
    const { ctx: outCtx, page: out } = await signedOutPage('index.html',
      { selector: '#oa-jobs-recent .oa-card' });
    await out.waitForTimeout(300);
    const teaser = await out.evaluate(() => {
      const cards = [...document.querySelectorAll('#oa-jobs-recent .oa-card')];
      return { cards: cards.length,
        locked: cards.filter((c) => c.classList.contains('oa-card-locked')).length,
        bodies: document.querySelectorAll('#oa-jobs-recent .oa-card-body').length,
        names: cards.map((c) => c.querySelector('.oa-card-title').textContent.trim()) };
    });
    /* "the sponsor and the list of last 9 universities which posted" — the
       ten the panel has always shown, with the sponsor's leading them. */
    eq(teaser.cards, 10, 'gate: the teaser still shows ten postings');
    eq(teaser.locked, 10, 'gate: signed out, every one of them is locked');
    eq(teaser.bodies, 0, 'gate: …and none of their details is in the document');
    ok(teaser.names.every((n) => n.length > 2),
      'gate: …while every university behind them is readable');
    await outCtx.close();

    /* Signed in, it is a way IN rather than a lock: no blur, no padlock, and
       the click carries the reader to the full list with that posting open —
       "it should only expand when a user is registered and has opened the
       full list", which is the sentence this behaviour comes from. */
    const { ctx, page: q, errors } = await signedInPage('index.html',
      { selector: '#oa-jobs-recent .oa-card' });
    const inb = await q.evaluate(() => {
      const c = document.querySelector('#oa-jobs-recent .oa-card');
      return { gated: c.classList.contains('oa-card-gated'),
        locked: c.classList.contains('oa-card-locked'),
        blur: !!c.querySelector('.oa-card-lock-blur'),
        padlock: getComputedStyle(c.querySelector('.oa-card-lock-note'), '::before').content,
        note: c.querySelector('.oa-card-lock-note').textContent.trim(),
        bodies: document.querySelectorAll('#oa-jobs-recent .oa-card-body').length };
    });
    eq([inb.gated, inb.locked], [true, false],
      'gate: signed in, the teaser card is gated but not LOCKED — nothing is withheld');
    eq([inb.blur, inb.bodies], [false, 0],
      'gate: …so nothing is blurred, and it still does not expand here');
    ok(!/1F512|🔒/.test(inb.padlock),
      'gate: …and no padlock is drawn in front of an invitation');
    ok(/full list/i.test(inb.note), 'gate: …the card says where the click goes');

    const target = await q.$eval('#oa-jobs-recent .oa-card', (c) => c.id.replace(/^job-/, ''));
    await q.click('#oa-jobs-recent .oa-card:first-child .oa-card-head');
    await q.waitForURL(/[?&]job=/, { timeout: 10000 });
    ok(q.url().includes('job=' + encodeURIComponent(target)),
      'gate: pressing it opens THAT posting on the full list');
    await q.waitForSelector('.oa-card-body', { timeout: 15000 });
    eq(await q.$eval('.oa-card-head', (n) => n.getAttribute('aria-expanded')), 'true',
      'gate: …and it arrives open, which is where expanding was always meant to happen');
    eq(errors, [], 'gate: the one-pager raises no error over any of it');
    await ctx.close();
  }

  /* -- nobody can sign in at all ----------------------------------------- */
  {
    /* A blocked CDN, an ad blocker, an offline reader — and in CI, every page
       opened without the shim. They are still not registered, so they are
       still locked; but the strip must say WHY rather than offering a control
       that would do nothing, which is the wording oa-jobexport.js already
       gives its disabled button. */
    const none = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await none.goto(BASE + 'jobs.html', { waitUntil: 'domcontentloaded' });
    await none.waitForSelector('.oa-card', { timeout: 15000 });
    await none.waitForTimeout(500);
    const said = await none.evaluate(() => ({
      note: document.querySelector('.oa-card-lock-note').textContent.trim(),
      disabled: document.querySelector('.oa-card-head').disabled,
      bodies: document.querySelectorAll('.oa-card-body').length,
      cards: document.querySelectorAll('.oa-card').length,
    }));
    ok(said.cards > 1, 'gate: with no sign-in to be had, the postings are still listed');
    eq(said.bodies, 0, 'gate: …still without their details');
    ok(/unavailable/i.test(said.note),
      'gate: …and the card says sign-in cannot be reached, rather than inviting it');
    eq(said.disabled, true,
      'gate: …with the head disabled rather than dead under the pointer');
    await none.close();
  }

  /* -- the CANDIDATES, whose details are a person's own ------------------- */
  {
    /* The profiles are HELD until the reveal date, so on most days the served
       file is empty and there is nothing on screen to gate. The rule is
       measured against a seeded file rather than against the calendar. */
    const SEED = [{ id: 'c1', name: 'A Candidate', affiliation: 'Somewhere University',
      position: 'PhD Candidate', year: String(marketYear()),
      posted: new Date().toISOString().slice(0, 10),
      researchAreas: ['Operations'], informsDays: ['Sunday'],
      email: 'someone@example.edu', cvUrl: 'https://example.edu/cv.pdf' }];
    const seed = (pg) => pg.route('**/data/candidates.json', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED) }));

    const { ctx: outCtx, page: out } = await signedOutPage('index.html', { wait: false });
    await seed(out);
    await out.goto(BASE + 'index.html', { waitUntil: 'load' });
    await out.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await out.evaluate(() => document.querySelector('#oa-candidates')
      .scrollIntoView({ block: 'center' }));
    await out.waitForSelector('#oa-candidates .oa-card', { timeout: 15000 });
    await out.waitForTimeout(300);
    const c = await out.evaluate(() => {
      const card = document.querySelector('#oa-candidates .oa-card');
      return { name: card.querySelector('.oa-card-title').textContent.trim(),
        locked: card.classList.contains('oa-card-locked'),
        bodies: document.querySelectorAll('#oa-candidates .oa-card-body').length,
        // the address is the field that must never be on a public page
        html: document.querySelector('#oa-candidates').innerHTML };
    });
    eq(c.name, 'A Candidate', 'gate: a candidate\'s NAME is readable signed out');
    eq([c.locked, c.bodies], [true, 0],
      'gate: …and their profile is not — no CV, no INFORMS days, no address');
    ok(!/someone@example\.edu/.test(c.html),
      'gate: the e-mail address is not in the document at all');
    await outCtx.close();

    const { ctx, page: q } = await signedInPage('index.html', { wait: false });
    await seed(q);
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.evaluate(() => document.querySelector('#oa-candidates')
      .scrollIntoView({ block: 'center' }));
    await q.waitForSelector('#oa-candidates .oa-card', { timeout: 15000 });
    await q.click('#oa-candidates .oa-card .oa-card-head');
    await q.waitForTimeout(250);
    ok(await q.$eval('#oa-candidates .oa-card-body', (n) => !n.hidden),
      'gate: signed in, the profile opens');
    ok(await q.$$eval('#oa-candidates .oa-kv a[href^="mailto:"]', (n) => n.length) >= 1,
      'gate: …and carries the way to contact them, which is what it is for');
    await ctx.close();
  }

  /* -- the card you PRESSED is the card that opens ------------------------ */
  {
    /* The one-pager mounts TWO gated lists, and `pending` — the id of the
       card whose lock was pressed — is one variable in one module. Consumed
       unconditionally it went to whichever list was notified FIRST: press a
       candidate card signed out, sign in, and the profile you pressed stayed
       shut while the teaser above quietly marked a row it does not have.

       Reproduced end to end rather than reasoned about, because the whole
       failure is an ORDERING between two listeners: the reader is seeded as a
       real user so the shim can sign them back in, signed OUT before anything
       is touched, and both lists are mounted in the order a reader scrolling
       the page mounts them. selftest.mjs pins the rule; this is the reader. */
    const SEED = [{ id: 'gate-cand-1', name: 'A Candidate',
      affiliation: 'Somewhere University', position: 'PhD Candidate',
      year: String(marketYear()), posted: new Date().toISOString().slice(0, 10),
      researchAreas: ['Operations'], informsDays: ['Sunday'],
      email: 'someone@example.edu', cvUrl: 'https://example.edu/cv.pdf' }];

    const { ctx, page: q, errors } = await signedInPage('index.html', { wait: false });
    await q.route('**/data/candidates.json', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED) }));
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.evaluate(() => window.OAAccounts.signOut());
    await q.waitForFunction(() => window.OAAccounts.resolved() && !window.OAAccounts.user(),
      null, { timeout: 15000 });

    // both lists mounted, teaser first — the order a reader scrolling creates
    await q.evaluate(() => document.querySelector('#oa-jobs-recent').scrollIntoView({ block: 'center' }));
    await q.waitForSelector('#oa-jobs-recent .oa-card', { timeout: 15000 });
    await q.evaluate(() => document.querySelector('#oa-candidates').scrollIntoView({ block: 'center' }));
    await q.waitForSelector('#oa-candidates .oa-card-locked', { timeout: 15000 });
    await q.waitForTimeout(300);

    await q.click('#oa-candidates .oa-card .oa-card-head');
    await q.waitForTimeout(300);
    ok(await q.$('.oa-modal'),
      'gate: pressing a locked candidate card offers the sign-in box');
    await q.evaluate(() => window.OAFB.ready().then((fb) => fb.auth().signInWithPopup({})));
    await q.waitForTimeout(1200);

    const landed = await q.evaluate(() => ({
      signedIn: !!(window.OAAccounts && window.OAAccounts.user()),
      locked: document.querySelectorAll('#oa-candidates .oa-card-locked').length,
      open: (() => { const b = document.querySelector('#oa-candidates .oa-card-body');
        return b ? !b.hidden : null; })(),
    }));
    eq(landed.signedIn, true, 'gate: …and signing in from it really signs the reader in');
    eq(landed.locked, 0, 'gate: …which unlocks the profile');
    eq(landed.open, true,
      'gate: …and opens THE ONE THEY PRESSED, not whichever list was notified first');
    eq(errors, [], 'gate: no uncaught script error on the way through');
    await ctx.close();
  }
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
   width the site is likely to meet.

   Owner, 2026-08-31: "this button and list of links it opens should appear on
   the left of the screen (whereas currently is shown on the right)". So the
   burger now LEADS the row — the leftmost control, the lockup beside it — and
   the sheet it opens is anchored to the LEFT edge and slides in from there.
   The clash check is an order-independent horizontal OVERLAP: the old
   "the words end before the burger begins" was only ever true of the old
   order, and a check that encodes which side a thing sits on has to be
   rewritten every time the row moves — the geometry it protects (nothing runs
   into anything) does not. */
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
    const words = q('.v3-header .v3-words'), mark = q('.v3-header .v3-mark'), burger = q('.v3-burger');
    const bb = burger ? burger.getBoundingClientRect() : null;
    const wb = words ? words.getBoundingClientRect() : null;
    const mb = mark ? mark.getBoundingClientRect() : null;
    const top = bb ? document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2) : null;
    return {
      mark: seen(mark),
      words: seen(words),
      text: words ? words.innerText.replace(/\s+/g, ' ').trim() : '',
      clash: !!(wb && bb && Math.round(wb.right) > Math.round(bb.left) && Math.round(bb.right) > Math.round(wb.left)),
      burgerLeads: !!(bb && mb && Math.round(bb.right) <= Math.round(mb.left)),
      burgerLeft: bb ? Math.round(bb.left) : -1,
      burgerW: bb ? Math.round(bb.width) : 0,
      burgerHit: !!(top && burger && (top === burger || burger.contains(top))),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  ok(r.mark, `${w}px: the monogram is shown`);
  ok(r.words, `${w}px: and so is the wordmark — the whole lockup, not the mark alone`);
  ok(/Operations/.test(r.text) && /Academia/.test(r.text),
    `${w}px: the wordmark reads "Operations Academia" (got ${JSON.stringify(r.text)})`);
  ok(!r.clash, `${w}px: and does not run into the menu button`);
  ok(r.burgerLeads, `${w}px: the menu button sits LEFT of the lockup`);
  ok(r.burgerLeft >= 0 && r.burgerLeft <= 60,
    `${w}px: at the left edge of the screen (left=${r.burgerLeft})`);
  /* as a direct flex child the burger now needs flex: none, or the row's
     tightness shaves it (measured 32px at 320px without it) — the position
     pins above all pass over a shrunken button, so its SIZE is pinned too */
  ok(r.burgerW >= 42, `${w}px: keeping its whole 42px touch target (width=${r.burgerW})`);
  ok(r.burgerHit, `${w}px: the menu button is still the thing under its own centre`);
  ok(!r.overflowX, `${w}px: the page does not scroll sideways`);

  /* …and the menu it opens comes in from the left too. The closed sheet
     rests at translateX(-102%), so "left <= 0" is true mid-slide as well —
     the wait demands the settled position, |left| < 0.5. */
  await m.click('.v3-burger');
  await m.waitForFunction(() => {
    const s = document.querySelector('.v3-sheet');
    return s && document.body.classList.contains('v3-sheet-open') &&
      Math.abs(s.getBoundingClientRect().left) < 0.5;
  }, null, { timeout: 5000 });
  const sh = await m.evaluate(() => {
    const b = document.querySelector('.v3-sheet').getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), vw: window.innerWidth };
  });
  ok(sh.left === 0, `${w}px: the opened menu is anchored to the LEFT edge (left=${sh.left})`);
  ok(sh.right < sh.vw, `${w}px: and leaves the right of the screen to the page (right=${sh.right} of ${sh.vw})`);
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
  /* the build's gate, asked of the ONE definition (assets/oa-reveal.js): no
     announced date holds everything, and the reveal is an INSTANT, 14:00 UTC
     on the day, so between midnight and 14:00 on the reveal day the panel
     says held and so must this expectation. A calendar-day compare here would
     go red for exactly those fourteen hours. */
  const OARevealNode = createRequire(import.meta.url)(path.join(ROOT, 'assets', 'oa-reveal.js'));
  const preReveal = !OARevealNode.isRevealed(cmeta.revealAt, new Date());
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

/* --------------------------------------------- deleting an account, for real

   Owner, 2026-09-05: "There is no option for a user to completely delete their
   profile. You should have it within their personal area … Also, the admin
   should be able to delete a user."

   What no static pin can prove is the money path, and here the money path IS
   an ORDER: the work order has to be written BEFORE anything is taken away
   (or a browser closed half way through leaves nothing that can finish), the
   postings have to be WITHDRAWN rather than deleted (or the published row is
   an orphan the build carries for ever), the alerts have to go before the
   sign-in (or they mail a person who no longer exists), and the sign-in has to
   go LAST (or nothing after it can write at all). The shim records every
   operation in the order it was issued, which is exactly what that needs.  */
{
  const SHIM = await readFile(path.join(ROOT, '_scraper', '_fake-firebase.js'), 'utf8');
  const ADMIN = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com',
    emailVerified: true, displayName: 'Kostas Stouras', providerData: [] };
  const LEAVER = { uid: 'leaver-uid-000000', email: 'leaver@example.edu',
    emailVerified: true, displayName: 'Lee Leaver', providerData: [] };

  const seed = [
    { path: 'jobSubmissions/job-leaver', data: { uid: LEAVER.uid, status: 'published',
      institution: 'Tulane University', department: 'Management Science',
      year: marketYear(), posted: '2026-08-01', ref: 'OA-LEAVER-1' } },
    { path: 'candidateSubmissions/cand-leaver', data: { uid: LEAVER.uid, status: 'queued',
      first: 'Lee', last: 'Leaver', year: marketYear() } },
    { path: 'users/' + LEAVER.uid + '/alerts/a1', data: { name: 'Everything', topics: ['jobs'] } },
    { path: 'profiles/' + LEAVER.uid, data: { firstName: 'Lee', lastName: 'Leaver' } },
    { path: 'registeredUsers/' + LEAVER.uid, data: { t: 1000 } },
    { path: 'userDirectory/' + LEAVER.uid, data: { name: 'Lee Leaver',
      email: 'leaver@example.edu', first: 1000, seen: 2000 } },
    /* the maintainer's own row, which must NOT be offered a Delete control:
       the rules would allow it, and the result is a site whose only admin
       account has deleted itself */
    { path: 'userDirectory/admin-uid-0000000000', data: { name: 'Kostas Stouras',
      email: 'kstouras@gmail.com', first: 500, seen: 500 } },
  ];

  async function open(user, url, docs, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 1000 } });
    const q = await ctx.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user, docs: docs || seed })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + url, { waitUntil: 'load' });
    return { ctx, q, errors };
  }

  /* -- a person deleting their own account ---------------------------------- */
  {
    const { ctx, q, errors } = await open(LEAVER, 'account.html');
    await q.waitForSelector('#pa-delete:not([hidden])', { timeout: 10000 });
    ok(true, 'delete: the personal area offers it to a signed-in reader');

    await q.click('#pa-delete-open');
    await q.waitForSelector('#pa-delete-word', { timeout: 10000 });

    const listed = await q.textContent('#pa-delete-panel');
    ok(listed.indexOf('Tulane University') !== -1 && listed.indexOf('Lee Leaver') !== -1,
      'delete: it names WHICH posting and WHICH profile are about to come off ' +
      'the site, rather than asking for a decision about "everything"');
    ok(/off the site/.test(listed) && !/—/.test(listed),
      'delete: …and says so in the house style, with no em dash');

    eq(await q.$eval('#pa-delete-go', (n) => n.disabled), true,
      'delete: the button is refused until the word is typed');
    await q.fill('#pa-delete-word', 'delete');
    await q.waitForTimeout(80);
    eq(await q.$eval('#pa-delete-go', (n) => n.disabled), true,
      'delete: …and the word is the WORD, not a lowercase near miss');
    await q.fill('#pa-delete-word', 'DELETE');
    await q.waitForTimeout(80);
    eq(await q.$eval('#pa-delete-go', (n) => n.disabled), false,
      'delete: typed in full, it is offered');

    await q.click('#pa-delete-go');
    await q.waitForSelector('#pa-delete-panel h3', { timeout: 10000 });
    ok((await q.textContent('#pa-delete-panel')).indexOf('Your account is gone') !== -1,
      'delete: and it says so plainly when it is done');

    const seq = await q.evaluate(() => window.__fb.log.map((e) => e.op + ' ' + e.path));
    const at = (needle) => seq.findIndex((l) => l.indexOf(needle) !== -1);
    const iOrder = at('accountDeletions/');
    const iWithdraw = seq.findIndex((l) => l.indexOf('update jobSubmissions/job-leaver') === 0);
    const iAlert = at('delete users/');
    const iRoster = at('delete userDirectory/');
    const iSignIn = at('deleteUser');

    ok(iOrder >= 0 && iOrder < iWithdraw,
      'delete: THE WORK ORDER IS WRITTEN FIRST, so a browser closed half way ' +
      'through leaves something the sweep can finish from');
    ok(iWithdraw > 0 && !seq.some((l) => l === 'delete jobSubmissions/job-leaver'),
      'delete: a posting is WITHDRAWN, never deleted — deleting the document ' +
      'leaves the published row an orphan the build carries for ever');
    ok(iAlert > iWithdraw && iAlert < iSignIn,
      'delete: the alerts go before the sign-in, or they mail somebody who no ' +
      'longer exists and nobody can ever stop them');
    ok(iRoster > 0 && iRoster < iSignIn,
      'delete: the roster row and the tally go too, so the count is of people');
    ok(iSignIn > 0 && iSignIn === Math.max(iOrder, iWithdraw, iAlert, iRoster, iSignIn),
      'delete: and the sign-in goes LAST — a session that has gone cannot write');

    const order = await q.evaluate(() =>
      window.__fb.dump()['accountDeletions/leaver-uid-000000']);
    ok(order && order.by === 'self' && order.status === 'requested' &&
       order.uid === 'leaver-uid-000000',
      'delete: the order says who asked and is filed under the account itself');

    eq(await q.evaluate(() => localStorage.getItem('oaAuthHint')), null,
      'delete: and the browser forgets the account — the hint the header is ' +
      'painted from before any script runs');
    eq(errors, [], 'delete: no page errors');
    await ctx.close();
  }

  /* -- THE OWNER'S OWN BUG, 2026-09-05 -------------------------------------

     Reported after a real deletion: the password prompt stopped them part way
     on a password they did not remember, and every later attempt was refused,
     because a `set` over the work order the first attempt had already filed is
     an UPDATE and every browser update of one is refused. The panel read that
     permission-denied as rules that were never published.

     Both halves are driven here: a session Firebase will not let delete itself
     (`deleteFails`) must finish anyway and ask for nothing, and an account that
     already has an order filed must be able to try again. */
  {
    const filed = seed.concat([{ path: 'accountDeletions/' + LEAVER.uid,
      data: { uid: LEAVER.uid, by: 'self', status: 'requested', askedAt: 1 } }]);
    const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const q = await ctx0.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user: LEAVER, docs: filed,
      deleteFails: 'auth/requires-recent-login' })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + 'account.html', { waitUntil: 'load' });

    await q.waitForSelector('#pa-delete:not([hidden])', { timeout: 10000 });
    await q.click('#pa-delete-open');
    await q.waitForSelector('#pa-delete-word', { timeout: 10000 });
    await q.fill('#pa-delete-word', 'DELETE');
    await q.click('#pa-delete-go');
    await q.waitForSelector('#pa-delete-panel h3', { timeout: 10000 });

    ok((await q.textContent('#pa-delete-panel')).indexOf('Your account is gone') !== -1,
      'delete: a second attempt finishes — the order already filed is carried on ' +
      'from, not written over and refused');
    const seq = await q.evaluate(() => window.__fb.log.map((e) => e.op + ' ' + e.path));
    ok(seq.some((l) => l.indexOf('get accountDeletions/') === 0),
      'delete: …because it READS the order first');
    ok(!seq.some((l) => l.indexOf('set accountDeletions/') === 0),
      '…and writes nothing over one that is already there');
    ok(!seq.some((l) => l.indexOf('reauth') === 0),
      'delete: and NOTHING asks for the password back — Firebase refused the ' +
      'sign-in deletion here, and the sweep removes it instead');
    ok(seq.some((l) => l.indexOf('delete userDirectory/') === 0),
      'delete: everything the browser CAN reach still went');
    ok((await q.textContent('#pa-delete-panel')).indexOf('twenty minutes') !== -1,
      'delete: …and the card says when the sign-in itself goes, rather than ' +
      'claiming it has');
    eq(errors, [], 'delete: no page errors');
    await ctx0.close();
  }

  /* -- A BRAND-NEW ACCOUNT, WHOSE READS ARE STILL BEING REFUSED ------------

     Owner, 2026-09-05: "I registered a new user. Then immediately after tried
     to delete that user profile entirely. The website doesn't let me." The
     panel said it could not read what the account had posted and DISABLED the
     button, so there was no way past it at all.

     The cause is one this file already records at the other end of the same
     feature: the rules read `email_verified` off the ID TOKEN, the SDK caches
     that token for up to an hour, and an account that confirmed its address
     minutes ago goes on presenting the claims it had before it did. So every
     read of its own data is refused, which reads as a broken page.

     Both halves are driven: the token is re-minted BEFORE the survey (the
     cause), and a survey that comes back refused anyway is a list the panel
     cannot print rather than a deletion it must refuse (the consequence).
     `refuseReads` is the shim's stand-in for the stale token, which no shim
     can mint. */
  {
    const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const q = await ctx0.newPage();
    const errors = [];
    q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify({ user: LEAVER, docs: seed,
      refuseReads: ['users/', 'jobSubmissions', 'candidateSubmissions',
        'placementSubmissions'] })};`);
    await q.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM }));
    await q.goto(BASE + 'account.html', { waitUntil: 'load' });

    await q.waitForSelector('#pa-delete:not([hidden])', { timeout: 10000 });
    /* Everything the PAGE reads for itself is already in the log by now, the
       postings list included, so the survey's own reads are measured from
       here on. */
    const beforeOpen = await q.evaluate(() => window.__fb.log.length);
    await q.click('#pa-delete-open');
    await q.waitForSelector('#pa-delete-word', { timeout: 10000 });

    const said = await q.textContent('#pa-delete-panel');
    ok(said.indexOf('could not list') !== -1 && said.indexOf('still removes') !== -1,
      'delete: a survey it could not read says so, and says the deletion goes ' +
      'ahead regardless — the sweep enumerates the account server-side');
    ok(said.indexOf('nothing you have posted') === -1,
      'delete: …and never claims an empty account, which this page cannot know');

    await q.fill('#pa-delete-word', 'DELETE');
    await q.waitForTimeout(80);
    eq(await q.$eval('#pa-delete-go', (n) => n.disabled), false,
      'delete: THE TYPED WORD IS THE ONLY GATE. This is the owner\'s bug: the ' +
      'button was disabled by a read the browser was refused, and nothing on ' +
      'the page could get past it');

    await q.click('#pa-delete-go');
    await q.waitForSelector('#pa-delete-panel h3', { timeout: 10000 });
    ok((await q.textContent('#pa-delete-panel')).indexOf('Your account is gone') !== -1,
      'delete: and it finishes');

    const seq = await q.evaluate((n) =>
      window.__fb.log.slice(n).map((e) => e.op + ' ' + e.path), beforeOpen);
    const iToken = seq.findIndex((l) => l.indexOf('getIdToken') === 0 &&
      l.indexOf(':force') !== -1);
    const iSurvey = seq.findIndex((l) => l.indexOf('query jobSubmissions?uid==') === 0);
    ok(iToken >= 0 && iSurvey > iToken,
      'delete: the token the rules read is re-minted BEFORE the account is ' +
      'surveyed, which is the cause rather than the symptom');
    ok(seq.some((l) => l.indexOf('set accountDeletions/') === 0),
      'delete: the work order is filed even though nothing could be listed — ' +
      'without it there is no record the account was meant to go');
    eq(errors, [], 'delete: no page errors');
    await ctx0.close();
  }

  /* -- the maintainer is offered the reason instead of the button ----------- */
  {
    const { ctx, q } = await open(ADMIN, 'account.html');
    await q.waitForSelector('#pa-delete:not([hidden])', { timeout: 10000 });
    eq(await q.$eval('#pa-delete-open', (n) => n.hidden), true,
      'delete: the account that RUNS the site is not offered the button — deleting ' +
      'it here would take the Admin area, the review queues and the roster with it');
    eq(await q.$eval('#pa-delete-admin', (n) => n.hidden), false,
      'delete: …and is told why, rather than finding the section silently short of ' +
      'the control everybody else has');
    /* not merely hidden: pressing it through the DOM must do nothing either,
       or the guard is a picture of one (the gate's own "absent, not blurred") */
    await q.evaluate(() => document.getElementById('pa-delete-open').click());
    await q.waitForTimeout(300);
    eq(await q.$eval('#pa-delete-panel', (n) => n.hidden), true,
      'delete: and the panel stays shut when the hidden button is pressed anyway');
    await ctx.close();
  }

  /* -- a reader who is not signed in is not offered it ---------------------- */
  {
    const { ctx, q } = await open(null, 'account.html');
    await q.waitForTimeout(600);
    eq(await q.$eval('#pa-delete', (n) => n.hidden), true,
      'delete: a signed-out reader is not offered a control that deletes an account');
    await ctx.close();
  }

  /* -- on a phone ----------------------------------------------------------- */
  {
    const { ctx, q } = await open(LEAVER, 'account.html', seed, { width: 390, height: 844 });
    await q.waitForSelector('#pa-delete:not([hidden])', { timeout: 10000 });
    await q.click('#pa-delete-open');
    await q.waitForSelector('#pa-delete-go', { timeout: 10000 });
    const box = await q.$eval('#pa-delete-go', (n) => {
      const r = n.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    ok(box.h >= 42, 'delete: the button is a real target on a phone');
    ok(box.w > 250, '…and full width, so it is not half a screen beside another');
    eq(await q.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      '…and nothing pushes the page sideways');
    await ctx.close();
  }

  /* -- the maintainer deleting somebody ------------------------------------- */
  {
    const { ctx, q, errors } = await open(ADMIN, 'admin-area.html');
    await q.waitForSelector('#oa-aa-users .oa-u-table tbody tr', { timeout: 10000 });
    eq(await q.$$eval('.oa-u-kill', (n) => n.length), 1,
      'admin delete: a roster row offers it — the other half the owner asked for — ' +
      'and the maintainer\'s OWN row does not, or the site loses the only account ' +
      'that can run it');
    eq(await q.$eval('.oa-u-kill', (n) => n.closest('tr').getAttribute('data-uid')),
      'leaver-uid-000000', 'admin delete: …and it is on the other person\'s row');

    /* the word, typed into the prompt the roster asks with */
    q.on('dialog', (d) => d.accept('DELETE'));
    await q.click('.oa-u-kill');
    await q.waitForSelector('.oa-u-going', { timeout: 10000 });
    ok((await q.textContent('#oa-aa-users')).indexOf('Deletion queued') !== -1,
      'admin delete: the row says what is happening, which is the state the ' +
      'page can actually observe');
    ok(await q.$('.oa-u-unkill'),
      'admin delete: …and it can be called off while it is still queued');

    const orders = await q.evaluate(() => {
      const all = window.__fb.dump();
      return Object.keys(all).filter((k) => k.indexOf('accountDeletions/') === 0)
        .map((k) => all[k]);
    });
    ok(orders.length === 1 && orders[0].by === 'admin' && orders[0].status === 'requested',
      'admin delete: it files a work order and nothing else — the browser cannot ' +
      'delete another account\'s alerts, details or sign-in, so it must not pretend to');
    const ops = await q.evaluate(() => window.__fb.log.map((e) => e.op + ' ' + e.path));
    ok(!ops.some((l) => l.indexOf('deleteUser') === 0) &&
       !ops.some((l) => l.indexOf('delete userDirectory/') === 0) &&
       !ops.some((l) => l.indexOf('delete profiles/') === 0),
      'admin delete: and nothing of the account itself is touched from here — the ' +
      'browser cannot reach the alerts, the details or the sign-in, so it must ' +
      'not half-delete and report success');
    eq(errors, [], 'admin delete: no page errors');
    await ctx.close();
  }

  /* -- a deletion already being carried out cannot be called off ------------ */
  {
    const clearing = seed.concat([{ path: 'accountDeletions/' + LEAVER.uid,
      data: { uid: LEAVER.uid, by: 'admin', status: 'clearing', askedAt: 1, clearedAt: 2 } }]);
    const { ctx, q } = await open(ADMIN, 'admin-area.html', clearing);
    await q.waitForSelector('#oa-aa-users .oa-u-table tbody tr', { timeout: 10000 });
    const row = await q.textContent('#oa-aa-users');
    ok(row.indexOf('Deleting now') !== -1,
      'admin delete: one already under way says so');
    eq(await q.$$eval('.oa-u-unkill', (n) => n.length), 0,
      '…and offers no Cancel, because the rules refuse it and "cancelled" would ' +
      'be a lie: the alerts and the sign-in have already gone');
    await ctx.close();
  }
}

/* ------------------------------ the candidate's own card, before the reveal

   Owner, 2026-09-04: a candidate who has posted a profile can see how THEIR
   OWN profile will appear (only their own), the form shows the same card as
   they type, an edited card says when, and the reveal is 14:00 UTC on the day
   with the reader's own clock beside it. All of it drawn by ONE renderer
   (assets/oa-candcard.js) over the build's projection, which selftest.mjs
   pins; this is the reader. The reveal date is ROUTED to a day a month out,
   so the pre-reveal headings are what is measured whatever the calendar. */
{
  const { createRequire } = await import('node:module');
  const R = createRequire(import.meta.url)(path.join(ROOT, 'assets', 'oa-reveal.js'));
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const META = { generated: new Date().toISOString(), revealAt: future,
    revealAtInstant: R.revealStamp(future), heldCount: 2, total: 0 };
  const routeMeta = (pg) => pg.route('**/data/candidates-meta.json', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }));
  const todayLine = 'Profile updated on ' + R.formatDay(new Date().toISOString().slice(0, 10));

  const mine = { path: 'candidateSubmissions/cand-me', data: { uid: A_READER.uid, status: 'queued',
    year: marketYear(), first: 'Ada', last: 'Reader', institution: 'Somewhere University',
    school: 'School of Business', unit: 'Operations', position: 'PhD Candidate',
    researchAreas: ['Operations'], informsDays: ['Sunday'], email: 'ada@example.edu',
    emailPublic: true, cvUrl: 'https://example.edu/ada-cv.pdf',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-25T10:00:00.000Z',
    ref: 'OA-CAND-260820-MINE' } };
  /* somebody ELSE's profile, in the same collection: the page must never
     draw it, and the shim's where() filters by uid so this proves the scope */
  const other = { path: 'candidateSubmissions/cand-other', data: { uid: 'someone-else-uid',
    status: 'queued', year: marketYear(), first: 'Nobody', last: 'Elsewhere',
    institution: 'Other University', position: 'Post-Doc',
    createdAt: '2026-08-21T00:00:00.000Z' } };

  /* -- account.html: the preview, and only their own ---------------------- */
  {
    const { ctx, page: q, errors } = await signedInPage('account.html', { docs: [mine, other], wait: false });
    await routeMeta(q);
    await q.goto(BASE + 'account.html', { waitUntil: 'load' });
    await q.waitForSelector('#pa-cand-preview:not([hidden]) .oa-card', { timeout: 15000 });
    await q.waitForFunction(() => /\d{2}:\d{2}/.test(
      document.getElementById('pa-cand-preview-note').textContent), null, { timeout: 8000 });
    const a = await q.evaluate(() => ({
      heading: document.getElementById('pa-cand-preview-h').textContent.trim(),
      note: document.getElementById('pa-cand-preview-note').textContent,
      title: document.querySelector('#pa-cand-preview .oa-card-title').textContent.trim(),
      sub: document.querySelector('#pa-cand-preview .oa-card-sub').textContent.trim(),
      cards: document.querySelectorAll('#pa-cand-preview .oa-card').length,
      labels: Array.from(document.querySelectorAll('#pa-cand-preview .oa-kv th')).map((n) => n.textContent),
      updated: (document.querySelector('#pa-cand-preview .oa-card-updated') || {}).textContent || '',
      edit: document.getElementById('pa-cand-edit').getAttribute('href'),
      html: document.documentElement.outerHTML,
    }));
    eq(a.heading, 'How your profile will appear', 'own card: headed as a preview before the reveal');
    eq([a.cards, a.title], [1, 'Ada Reader'], 'own card: one card, and it is the reader’s own');
    eq(a.sub, 'Operations, School of Business, Somewhere University — PhD Candidate',
      'own card: the affiliation line the build would publish, joined smallest first');
    ok(!/Nobody Elsewhere|Other University/.test(a.html),
      'own card: somebody else’s profile is nowhere in the document');
    ok(/Only you and the site's maintainer can see this until the reveal/.test(a.note),
      'own card: the only-you line, naming the maintainer');
    ok(!/\(\w+\/\w+\)/.test(a.note), 'own card: ...with no zone id after the reader’s clock');
    ok(a.note.includes(R.describeReveal(future).dayLong) && /14:00 UTC/.test(a.note),
      'own card: ...naming the reveal day and 14:00 UTC');
    ok(/\d{2}:\d{2}[^.]*where you are/.test(a.note), 'own card: ...and the reader’s own clock');
    ok(a.labels.includes('CV') && a.labels.includes('Contact'),
      'own card: the profile’s rows are drawn open (a CV, a way to contact them)');
    eq(a.updated, 'Profile updated on 25 August 2026',
      'own card: the updated-on line, from the document’s later updatedAt');
    ok(/\?edit=cand-me$/.test(a.edit), 'own card: Edit opens the reader’s own document');
    eq(errors, [], 'own card: no uncaught script error');
    await ctx.close();
  }

  /* -- a taken-down profile, and one from a past season: neither is "will
        go public", and the card above says the same thing ----------------- */
  for (const [label, doc, heading, notePat, cardPat] of [
    ['taken down (the build has rewritten withdrawn to removed)',
      { path: 'candidateSubmissions/cand-gone', data: { ...mine.data, status: 'removed' } },
      'Your profile (taken down)', /not shown to anyone/, /filed for this season/],
    ['from a past season',
      { path: 'candidateSubmissions/cand-old', data: { ...mine.data, year: marketYear() - 1, ref: 'OA-CAND-250820-OLD' } },
      'Your profile from a previous season', /no longer on the candidates page/, /previous season is shown below/],
  ]) {
    const { ctx, page: q, errors } = await signedInPage('account.html', { docs: [doc], wait: false });
    await routeMeta(q);
    await q.goto(BASE + 'account.html', { waitUntil: 'load' });
    await q.waitForSelector('#pa-cand-preview:not([hidden]) .oa-card', { timeout: 15000 });
    await q.waitForTimeout(700);   // time for a meta fetch to land, which must NOT rewrite the note
    const a = await q.evaluate(() => ({
      heading: document.getElementById('pa-cand-preview-h').textContent.trim(),
      note: document.getElementById('pa-cand-preview-note').textContent,
      title: document.querySelector('#pa-cand-preview .oa-card-title').textContent.trim(),
      card: document.querySelector('#pa-cand-card p').textContent,
    }));
    eq(a.heading, heading, `own card ${label}: headed as what it is`);
    ok(notePat.test(a.note), `own card ${label}: the note says so`);
    ok(!/goes public|as everyone sees it/.test(a.note), `own card ${label}: ...and never that it will go public`);
    eq(a.title, 'Ada Reader', `own card ${label}: the card itself is still drawn`);
    ok(cardPat.test(a.card), `own card ${label}: the card above agrees with the section below`);
    eq(errors, [], `own card ${label}: no uncaught script error`);
    await ctx.close();
  }

  /* -- post-a-candidate.html: the live preview follows a keystroke -------- */
  {
    const { ctx, page: q, errors } = await signedInPage('post-a-candidate.html',
      { docs: [], selector: '#oa-cand-preview:not([hidden])' });
    const empty = await q.evaluate(() => ({
      hint: !document.getElementById('oa-cand-preview-empty').hidden,
      cards: document.querySelectorAll('#oa-cand-preview .oa-card').length,
      heading: document.getElementById('oa-cand-preview-h').textContent.trim(),
    }));
    eq([empty.heading, empty.hint, empty.cards], ['Preview', true, 0],
      'form preview: a blank form shows the hint and no card');
    await q.fill('#f-first', 'Grace');
    await q.fill('#f-last', 'Hopper');
    await q.fill('#f-institution', 'Northwestern University');
    await q.selectOption('#f-position', 'PhD Candidate');
    await q.waitForSelector('#oa-cand-preview .oa-card-title', { timeout: 8000 });
    eq(await q.$eval('#oa-cand-preview .oa-card-title', (n) => n.textContent.trim()), 'Grace Hopper',
      'form preview: the card appears once the form holds what a card needs');
    await q.fill('#f-first', 'Grace Brewster');
    await q.waitForFunction(() => document.querySelector('#oa-cand-preview .oa-card-title')
      .textContent.trim() === 'Grace Brewster Hopper', null, { timeout: 8000 });
    ok(true, 'form preview: ...and follows the next keystroke');
    const noErr = await q.evaluate(() => document.querySelectorAll('#oa-cand-form .oa-err').length);
    eq(noErr, 0, 'form preview: drawing it painted no validation error (the read is quiet)');
    const noUpd = await q.evaluate(() => !document.querySelector('#oa-cand-preview .oa-card-updated'));
    ok(noUpd, 'form preview: a NEW profile carries no updated-on line');
    eq(errors, [], 'form preview: no uncaught script error');
    await ctx.close();
  }
  {
    /* edit mode: the loaded profile is drawn, and typing previews the
       updated-on line SAVING would earn */
    const { ctx, page: q, errors } = await signedInPage('post-a-candidate.html?edit=cand-me',
      { docs: [{ path: mine.path, data: { ...mine.data, updatedAt: undefined } }],
        selector: '#oa-cand-preview .oa-card-title' });
    const before = await q.evaluate(() => ({
      title: document.querySelector('#oa-cand-preview .oa-card-title').textContent.trim(),
      updated: !!document.querySelector('#oa-cand-preview .oa-card-updated'),
    }));
    eq(before, { title: 'Ada Reader', updated: false },
      'form preview (edit): the loaded profile is drawn, with no updated line until something changes');
    await q.fill('#f-first', 'Adelaide');
    await q.waitForFunction(() => document.querySelector('#oa-cand-preview .oa-card-title')
      .textContent.trim() === 'Adelaide Reader', null, { timeout: 8000 });
    eq(await q.$eval('#oa-cand-preview .oa-card-updated', (n) => n.textContent), todayLine,
      'form preview (edit): a change previews the "Profile updated on" line saving now would publish');
    eq(errors, [], 'form preview (edit): no uncaught script error');
    await ctx.close();
  }

  /* -- the updated-on line on the SERVED rows ----------------------------- */
  {
    const today = new Date().toISOString().slice(0, 10);
    const SEED = [
      { id: 'upd-1', name: 'Edited Candidate', affiliation: 'Somewhere University',
        position: 'PhD Candidate', year: String(marketYear()), posted: today,
        researchAreas: ['Operations'], informsDays: ['Sunday'],
        addedAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-25', cvUrl: 'https://example.edu/cv.pdf' },
      { id: 'upd-2', name: 'Fresh Candidate', affiliation: 'Elsewhere University',
        position: 'Post-Doc', year: String(marketYear()), posted: today,
        researchAreas: ['Operations'], informsDays: ['Monday'],
        addedAt: '2026-08-21T00:00:00Z', cvUrl: 'https://example.edu/cv2.pdf' },
    ];
    const seed = (pg) => pg.route('**/data/candidates.json', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED) }));
    const { ctx, page: q } = await signedInPage('index.html', { wait: false });
    await seed(q);
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.evaluate(() => document.querySelector('#oa-candidates').scrollIntoView({ block: 'center' }));
    await q.waitForSelector('#oa-candidates .oa-card', { timeout: 15000 });
    for (const h of await q.$$('#oa-candidates .oa-card .oa-card-head')) await h.click();
    await q.waitForTimeout(250);
    const u = await q.evaluate(() => Array.from(document.querySelectorAll('#oa-candidates .oa-card'))
      .map((c) => {
        const line = c.querySelector('.oa-card-updated');
        const body = c.querySelector('.oa-card-body');
        return { name: c.querySelector('.oa-card-title').textContent.trim(),
          line: line ? line.textContent : null,
          last: !!line && body.lastElementChild === line };
      }));
    eq(u.map((c) => [c.name, c.line]),
      [['Edited Candidate', 'Profile updated on 25 August 2026'], ['Fresh Candidate', null]],
      'served rows: the updated-on line on exactly the profile with a later updatedAt');
    ok(u[0].last, 'served rows: ...as the LAST line of the card body');
    await ctx.close();

    const { ctx: outCtx, page: out } = await signedOutPage('index.html', { wait: false });
    await seed(out);
    await out.goto(BASE + 'index.html', { waitUntil: 'load' });
    await out.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await out.evaluate(() => document.querySelector('#oa-candidates').scrollIntoView({ block: 'center' }));
    await out.waitForSelector('#oa-candidates .oa-card', { timeout: 15000 });
    await out.waitForTimeout(300);
    const locked = await out.evaluate(() => ({
      lines: document.querySelectorAll('#oa-candidates .oa-card-updated').length,
      bodies: document.querySelectorAll('#oa-candidates .oa-card-body').length,
      html: document.querySelector('#oa-candidates').innerHTML,
    }));
    eq([locked.lines, locked.bodies], [0, 0],
      'served rows (signed out): a locked card has no body and therefore no updated-on line');
    ok(!/Profile updated on/.test(locked.html), 'served rows (signed out): ...and the line is not in the markup at all');
    await outCtx.close();
  }

  /* -- the reveal note prints the reader's own clock ---------------------- */
  {
    const { ctx, page: q } = await signedOutPage('index.html', { wait: false });
    await routeMeta(q);
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForSelector('#oa-reveal-note:not([hidden])', { timeout: 15000 });
    const n = await q.evaluate(() => ({
      day: document.getElementById('oa-reveal-day').textContent,
      cities: document.getElementById('oa-reveal-cities').textContent,
      local: document.getElementById('oa-reveal-local').textContent,
      count: document.getElementById('oa-reveal-count').textContent,
      text: document.getElementById('oa-reveal-note').textContent.replace(/\s+/g, ' '),
    }));
    eq(n.day, R.describeReveal(future).dayLong, 'reveal note: the day, with its weekday, from the module');
    ok(/^ \(\d{2}:\d{2} Los Angeles, \d{2}:\d{2} New York, \d{2}:\d{2} London, 22:00 Shanghai\)$/.test(n.cities),
      'reveal note: the four cities, filled by the script (the markup carries no clock)');
    ok(/^, which is \d{2}:\d{2}.* where you are$/.test(n.local), 'reveal note: the reader’s own clock');
    ok(/at 14:00 UTC on/.test(n.text), 'reveal note: ...beside the UTC time the static sentence names');
    ok(/2 profiles have already been filed/.test(n.count), 'reveal note: the held count');
    await ctx.close();
  }

  /* -- a phone --------------------------------------------------------- */
  for (const [url, selector, docs] of [
    ['account.html', '#pa-cand-preview:not([hidden]) .oa-card', [mine]],
    ['post-a-candidate.html?edit=cand-me', '#oa-cand-preview .oa-card-title', [mine]],
  ]) {
    const { ctx, page: q } = await signedInPage(url, { docs, selector,
      viewport: { width: 390, height: 844 } });
    const m = await q.evaluate(() => {
      const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const edit = document.getElementById('pa-cand-edit');
      const form = document.getElementById('oa-cand-form');
      const prev = document.getElementById('oa-cand-preview');
      return {
        over,
        editH: edit ? edit.getBoundingClientRect().height : null,
        stacked: form && prev
          ? prev.getBoundingClientRect().top >= form.getBoundingClientRect().bottom - 1 : null,
        cardW: document.querySelector('.oa-card').getBoundingClientRect().width,
      };
    });
    ok(m.over <= 1, `${url} at 390px: the page does not scroll sideways (${m.over}px)`);
    ok(m.cardW <= 390 && m.cardW > 300, `${url} at 390px: the card fits the screen (${Math.round(m.cardW)}px)`);
    if (m.editH !== null) ok(m.editH >= 42, `${url} at 390px: the Edit control is a ${Math.round(m.editH)}px target`);
    if (m.stacked !== null) ok(m.stacked, `${url} at 390px: the preview stacks UNDER the form`);
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
      /* the LAST action in the cell is what holds the bar's right edge —
         since 2026-09-04 that is "Save as e-mail alert", and the download
         sits between Clear and it */
      const last = b.closest('.oa-filter-actions').lastElementChild.getBoundingClientRect();
      const next = document.querySelector('.oa-alert-save');
      return { title: b.title, text: b.textContent.trim(), disabled: b.disabled,
        h: Math.round(r.height), w: Math.round(r.width),
        x: Math.round(r.x), right: Math.round(r.right), top: Math.round(r.top),
        rightGap: Math.round(cell.right - last.right),
        nextX: next ? Math.round(next.getBoundingClientRect().x) : null,
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
    ok(btn.x > btn.clearX && btn.nextX !== null && btn.right < btn.nextX,
      'jobs export: …to its right, and left of "Save as e-mail alert"');
    ok(Math.abs(btn.rightGap) <= 1.5,
      'jobs export: …with the last button in the cell holding the bar\'s right edge');

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
    /* THE PAIR, measured (owner's phone screenshot, 2026-08-30): stacked, the
       two buttons kept 0px between them — the desktop cell's zero row-gap
       exists only to hold Clear on a baseline a phone row does not have — and
       only ONE of them took the breakpoint's old 10px corner override, because
       Clear's pill rule sits later in v3.css at the same specificity. Rule 11
       in _MOBILE-STANDARDS.md: stacked controls keep a gap and keep one
       shape, measured rather than trusted to the cascade. */
    const pair = await q.evaluate(() => {
      const c = document.querySelector('.oa-clear');
      const b = document.querySelector('.oa-export');
      const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect();
      return { gap: Math.round(br.top - cr.bottom),
        clearShape: getComputedStyle(c).borderRadius,
        exportShape: getComputedStyle(b).borderRadius,
        clearW: Math.round(cr.width), exportW: Math.round(br.width) };
    });
    ok(pair.gap >= 6,
      `jobs export at 390px: the stacked pair breathes (${pair.gap}px between the buttons)`);
    eq(pair.clearShape, pair.exportShape,
      'jobs export at 390px: the two buttons share ONE shape — a breakpoint ' +
      'override that reaches only one of them is the load-order trap');
    eq(pair.clearW, pair.exportW,
      'jobs export at 390px: …and one width, each taking the whole cell');
    /* TWO PICKERS ON A ROW SHARE ONE LINE (owner's phone screenshot,
       2026-08-31): "Suggested deadline" wraps to two lines at this width and
       used to push its picker below "Final deadline"'s — the bar's cells are
       start-aligned for the chips' sake, so a taller label moved only its
       own control. Asserted as the general property rather than those two
       labels (a guard about a corpus must not move with the corpus): any two
       picker cells that overlap vertically are a row, and their buttons'
       tops stay together. */
    const picks = await q.evaluate(() => {
      const cells = [...document.querySelectorAll('.oa-filters .oa-pick')];
      const offs = [];
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i].getBoundingClientRect();
          const b = cells[j].getBoundingClientRect();
          if (a.top < b.bottom && b.top < a.bottom) {
            const ba = cells[i].querySelector('.oa-pick-btn').getBoundingClientRect();
            const bb = cells[j].querySelector('.oa-pick-btn').getBoundingClientRect();
            offs.push(Math.abs(Math.round(ba.top - bb.top)));
          }
        }
      }
      return offs;
    });
    ok(picks.length > 0 && picks.every((d) => d <= 1.5),
      `jobs at 390px: pickers sharing a row keep their controls on one line ` +
      `(offsets ${picks.join(', ')}px)`);
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

  /* -- TWO PICKERS TAKE SEVERAL VALUES, and combine them differently -------

     Owner, 2026-09-04: Entry level and Characteristics were single-select
     radios. Entry level is ANY-OF now ("Assistant Professor or Post-Doc" is
     two things one candidate could take), Characteristics ALL-OF ("PhD and
     Research seminars" is a department that has both). Every expectation
     below is computed from the served file under the page's own market rule,
     never from a number that would move with the corpus, and the values
     ticked are whichever the open menu offers, for the same reason. */
  {
    const { ctx, q, errors } = await jobsPage(READER);
    const shown = () => q.$eval('.oa-count', (n) =>
      Number(n.textContent.split('/')[1].trim().split(' ')[0]));
    const menu = () => q.$$eval('.oa-pick-menu:not([hidden]) .oa-opt:not(.is-empty)', (ns) =>
      ns.map((n) => ({ v: n.querySelector('.oa-opt-name').textContent,
        n: Number(n.querySelector('.oa-opt-n').textContent),
        type: n.querySelector('input').type, on: n.querySelector('input').checked })));
    const chips = () => q.$$eval('.oa-filter.oa-pick .oa-chip .oa-chip-label',
      (ns) => ns.map((n) => n.textContent));
    const tick = async (opts, v) => {
      const i = opts.findIndex((o) => o.v === v) + 1;
      await q.click(`.oa-pick-menu:not([hidden]) .oa-opt:nth-of-type(${i}) input`);
      await q.waitForTimeout(300);
    };
    /* the rows the page holds, with the two fields these filters read */
    const rows = await q.evaluate(async () => {
      const d = await (await fetch('/data/jobs.json')).json();
      return (Array.isArray(d) ? d : d.rows)
        .filter((r) => window.OAJobNav.inCurrentMarket(r))
        .map((r) => ({ levels: r.levels || [], chars: r.characteristics || [] }));
    });
    const total = await shown();
    eq(rows.length, total,
      'multi: the expectations are computed over exactly the rows the page holds');
    const anyOf = (rs, vals) => rs.filter((r) => vals.some((v) => r.levels.includes(v)));
    const allOf = (rs, vals) => rs.filter((r) => vals.every((v) => r.chars.includes(v)));

    /* ENTRY LEVEL: tick boxes, and a second tick WIDENS */
    await q.click('#oaf-level');
    await q.waitForTimeout(200);
    let opts = await menu();
    ok(opts.length >= 2 && opts.every((o) => o.type === 'checkbox'),
      'multi: Entry level offers tick boxes, not radios');
    eq(await q.$$eval('.oa-pick-menu:not([hidden]) .oa-pick-hint', (n) => n.length), 0,
      'multi: …and carries no note, because any-of is what every other picker means');
    const L = opts.slice().sort((a, b) => b.n - a.n).slice(0, 2).map((o) => o.v);
    await tick(opts, L[0]);
    const one = await shown();
    eq(one, anyOf(rows, [L[0]]).length, `multi: one level shows its own postings ("${L[0]}")`);
    eq(await q.$$eval('.oa-pick-menu:not([hidden])', (n) => n.length), 1,
      'multi: the menu stays open for the next tick');
    await tick(opts, L[1]);
    const two = await shown();
    eq(two, anyOf(rows, L).length,
      `multi: two levels show EITHER (${one} -> ${two}), the union the data holds`);
    ok(two >= Math.max(...L.map((v) => anyOf(rows, [v]).length)),
      'multi: …at least as many as the larger alone, which an AND could never be');
    await q.keyboard.press('Escape');
    eq(await chips(), L, 'multi: both levels are chips under the control');

    /* CHARACTERISTICS: tick boxes, a note, and a second tick NARROWS */
    await q.click('#oaf-chars');
    await q.waitForTimeout(200);
    opts = await menu();
    ok(opts.length >= 2 && opts.every((o) => o.type === 'checkbox'),
      'multi: Characteristics offers tick boxes too');
    const hint = await q.$eval('.oa-pick-menu:not([hidden]) .oa-pick-hint', (n) => n.textContent);
    ok(/every characteristic you tick/.test(hint),
      'multi: …and its menu says what ticking several means');
    eq(await q.$eval('#oaf-chars', (n) => n.title), hint,
      'multi: the button says it as its title, for a pointer that hovers first');
    const inLevels = anyOf(rows, L);   // its counts are cross-filtered on the ticked levels
    for (const o of opts) {
      eq(o.n, allOf(inLevels, [o.v]).length,
        `multi: "${o.v}" counts the postings that have it, within the ticked levels`);
    }
    const c0 = opts.slice().sort((a, b) => b.n - a.n)[0].v;
    await tick(opts, c0);
    const x = await shown();
    eq(x, allOf(inLevels, [c0]).length, `multi: one characteristic shows its postings ("${c0}")`);
    /* THE COUNTS MOVE, IN PLACE: each is now what ticking it AS WELL would leave */
    const after = await menu();
    for (const o of after) {
      eq(o.n, allOf(inLevels, [c0, o.v]).length,
        `multi: with "${c0}" ticked, "${o.v}" says what ticking it as well would leave`);
    }
    eq(after.map((o) => o.v), opts.map((o) => o.v),
      'multi: every characteristic is still listed, so none seems to have vanished');
    eq(await q.evaluate(() => document.activeElement && document.activeElement.type), 'checkbox',
      'multi: the keyboard focus stayed on the box just ticked — the counts were refreshed, not redrawn');
    const c1 = after.filter((o) => o.v !== c0).sort((a, b) => b.n - a.n)[0].v;
    await tick(opts, c1);
    const xy = await shown();
    eq(xy, allOf(inLevels, [c0, c1]).length,
      `multi: two characteristics show only postings with BOTH (${x} -> ${xy})`);
    ok(xy <= x, 'multi: …a second tick narrows, it never widens');
    const own = (await menu()).find((o) => o.v === c0);
    eq(own && own.n, xy, "multi: a ticked value's own count is the current result");
    await q.keyboard.press('Escape');
    const C = [c0, c1];
    eq(await chips(), [...L, ...C], 'multi: every value is a chip under its own control');

    /* the address carries all four, one parameter per value */
    const u = new URL(q.url());
    eq(u.searchParams.getAll('level'), L, 'multi: the address carries both levels');
    eq(u.searchParams.getAll('chars'), C, 'multi: …and both characteristics');

    /* the workbook says "and" where the list meant it, "or" where it meant that */
    if (xy > 0) {
      const dl = q.waitForEvent('download', { timeout: 30000 });
      await q.click('.oa-export');
      const file = await (await dl).path();
      const parts = unzipStore(new Uint8Array(await readFile(file)));
      const about = sheetCells(parts['xl/worksheets/sheet3.xml']);
      const text = Object.keys(about).map((k) => about[k].v).join(' | ');
      ok(text.includes(`${L[0]}  or  ${L[1]}`),
        'multi: the About sheet joins the levels with "or"');
      ok(text.includes(`${c0}  and  ${c1}`),
        'multi: …and the characteristics with "and" — the word the list used');
    }

    /* CHIPS MOVE NOTHING — the desktop baseline rule, with chips under two
       PICKERS this time (the existing check hangs them under the text
       search) — and a phone still fits everything on screen. */
    for (const width of [1280, 390, 320]) {
      await q.setViewportSize({ width, height: 1000 });
      await q.waitForTimeout(250);
      const geo = await q.evaluate(() => {
        const doc = document.documentElement;
        const bar = document.querySelector('.oa-filters');
        const ctrls = [...document.querySelectorAll(
          '.oa-filters input[type=search], .oa-filters .oa-pick-btn, .oa-filters .oa-clear')];
        const lines = [];
        ctrls.forEach((n) => {
          const t = n.getBoundingClientRect().top;
          const row = lines.find((r) => Math.abs(r.top - t) < 1.5);
          if (row) row.n++; else lines.push({ top: t, n: 1 });
        });
        const cells = new Set([...bar.children]
          .map((c) => Math.round(c.getBoundingClientRect().top))).size;
        const menus = [...document.querySelectorAll('.oa-pick .oa-pick-btn')].map((btn) => {
          btn.click();
          const r = btn.parentElement.querySelector('.oa-pick-menu').getBoundingClientRect();
          btn.click();
          return { left: Math.round(r.left), right: Math.round(r.right) };
        });
        return { over: doc.scrollWidth - doc.clientWidth, lines: lines.length, cells,
          chips: document.querySelectorAll('.oa-pick .oa-chip').length, menus, vw: doc.clientWidth };
      });
      eq(geo.chips, 4, `multi @${width}: the four chips are showing, so the measurement means something`);
      ok(geo.over <= 1, `multi @${width}: the page does not scroll sideways (${geo.over}px)`);
      ok(geo.menus.every((r) => r.left >= 0 && r.right <= geo.vw),
        `multi @${width}: every picker menu stays on screen (${JSON.stringify(geo.menus)})`);
      if (width >= 1000) {
        eq(geo.lines, geo.cells,
          `multi @${width}: every control sits on its row's baseline with chips under two pickers`);
      }
    }
    await q.setViewportSize({ width: 1280, height: 1000 });

    /* a link is a search: reloading it restores every value */
    await q.goto(u.href, { waitUntil: 'load' });
    await q.waitForSelector('.oa-card, .oa-empty');
    await q.waitForTimeout(400);
    eq(await shown(), xy, 'multi: reloading the link restores the same result');
    eq(await chips(), [...L, ...C], 'multi: …with every value back as a chip');

    /* a link from the single-choice days names ONE value, and still selects it;
       the older "a|b" join, which links in the wild still carry, selects both */
    await q.goto(BASE + 'jobs.html?level=' + encodeURIComponent(L[0]) +
      '&chars=' + encodeURIComponent(c0), { waitUntil: 'load' });
    await q.waitForSelector('.oa-card, .oa-empty');
    await q.waitForTimeout(400);
    eq(await shown(), allOf(anyOf(rows, [L[0]]), [c0]).length,
      'multi: a one-value link from the radio days still selects what it names');
    eq(await chips(), [L[0], c0], 'multi: …as one chip each');
    await q.goto(BASE + 'jobs.html?chars=' + encodeURIComponent(C.join('|')), { waitUntil: 'load' });
    await q.waitForSelector('.oa-card, .oa-empty');
    await q.waitForTimeout(400);
    eq(await shown(), allOf(rows, C).length,
      'multi: the legacy "a|b" join lands as both values, and under AND means both');
    eq(errors, [], 'multi: no uncaught script error');
    await ctx.close();
  }

  /* -- and the SINGLE-CHOICE type the other pages use kept working ---------

     previous-markets keeps `type: 'one'` on its Entry level (the directory
     on two of its filters): radios, one value at a time, and a link naming
     several takes the last. A page-level decision, so it is measured on the
     page that made it. */
  {
    const { ctx, page: p, errors } = await signedInPage('previous-markets.html');
    await p.click('#oaf-level');
    await p.waitForTimeout(200);
    const opts = await p.$$eval('.oa-pick-menu:not([hidden]) .oa-opt:not(.is-empty)', (ns) =>
      ns.map((n) => ({ v: n.querySelector('.oa-opt-name').textContent,
        type: n.querySelector('input').type })));
    ok(opts.length >= 2 && opts.every((o) => o.type === 'radio'),
      "one: the archive's Entry level is still drawn as radios");
    await p.click('.oa-pick-menu:not([hidden]) .oa-opt:nth-of-type(1) input');
    await p.waitForTimeout(300);
    eq(await p.$$eval('.oa-pick-menu:not([hidden])', (n) => n.length), 0,
      'one: choosing a value closes the menu, as it always did');
    await p.click('#oaf-level');
    await p.waitForTimeout(200);
    await p.click('.oa-pick-menu:not([hidden]) .oa-opt:nth-of-type(2) input');
    await p.waitForTimeout(300);
    eq(await p.$$eval('.oa-filter.oa-pick .oa-chip .oa-chip-label', (ns) => ns.map((n) => n.textContent)),
      [opts[1].v], 'one: a second choice REPLACES the first');
    eq(new URL(p.url()).searchParams.getAll('level'), [opts[1].v],
      'one: …and the address names one value');
    await p.goto(BASE + 'previous-markets.html?level=' + encodeURIComponent(opts[0].v) +
      '&level=' + encodeURIComponent(opts[1].v), { waitUntil: 'load' });
    await p.waitForSelector('.oa-card, .oa-empty');
    await p.waitForTimeout(400);
    eq(await p.$$eval('.oa-filter.oa-pick .oa-chip .oa-chip-label', (ns) => ns.map((n) => n.textContent)),
      [opts[1].v], 'one: a link naming two values selects the LAST, as before');
    eq(errors, [], 'one: no uncaught script error');
    await ctx.close();
  }
}

/* -------------------------------- the registered-users tile (owner, 2026-09-05)

   The front page's fifth key figure is born HIDDEN with no number in it, and
   the page reveals it only when data/users-meta.json holds ten or more, rounded
   down to the nearest ten with a plus. What a unit test cannot see is the
   half that matters: that the count-up really reaches "60+" (the tile has to
   be revealed BEFORE statTo, or its observer never fires), that a missing or
   too-small file leaves the strip exactly as it was, and that five tiles sit
   on ONE row at every desktop width rather than the fifth orphaning below. */
{
  const meta = (pg, body) => pg.route('**/data/users-meta.json', (r) => body == null
    ? r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  const readStrip = (pg) => pg.evaluate(() => {
    const tiles = [...document.querySelectorAll('#v3-stats .v3-stat')];
    const shown = tiles.filter((t) => !t.hidden && getComputedStyle(t).display !== 'none');
    const tops = [...new Set(shown.map((t) => Math.round(t.getBoundingClientRect().top)))];
    const users = document.querySelector('[data-stat="users"]');
    return {
      total: tiles.length,
      shown: shown.length,
      rows: tops.length,
      hidden: !!(users && users.hidden),
      text: users ? users.querySelector('b').textContent : null,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clipped: shown.some((t) => t.getBoundingClientRect().right > window.innerWidth + 1),
    };
  });

  /* no file: the strip is the four tiles it always was */
  for (const body of [null, { generated: '2026-09-05T00:00:00Z', count: 9 }]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('users tile: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await meta(q, body);
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForTimeout(400);
    const r = await readStrip(q);
    const label = body ? 'a count under ten' : 'no file';
    eq(r.total, 5, `users tile (${label}): the fifth tile is in the markup`);
    ok(r.hidden, `users tile (${label}): …and stays hidden`);
    eq(r.shown, 4, `users tile (${label}): the strip shows the four seeded figures and nothing else`);
    eq(r.rows, 1, `users tile (${label}): …on one row`);
    eq(r.text, '', `users tile (${label}): the hidden tile carries no number, not even a 0`);
    await ctx.close();
  }

  /* 64 registered users: revealed, counted up to "60+", and on the same row */
  for (const width of [1280, 1180, 1024]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('users tile: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await meta(q, { generated: '2026-09-05T00:00:00Z', count: 64 });
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForSelector('[data-stat="users"]:not([hidden])', { timeout: 10000 });
    await q.evaluate(() => document.querySelector('[data-stat="users"]').scrollIntoView({ block: 'center' }));
    /* the count-up is 800ms once the tile is in view; a tile revealed AFTER
       statTo would sit on 0 for ever, which is what this wait is for */
    await q.waitForFunction(() => document.querySelector('[data-stat="users"] b').textContent === '60+', null, { timeout: 8000 });
    await q.evaluate(() => window.scrollTo(0, 0));
    const r = await readStrip(q);
    eq(r.shown, 5, `users tile (${width}px): all five tiles are shown`);
    eq(r.text, '60+', `users tile (${width}px): 64 accounts read "60+", rounded DOWN to the nearest ten`);
    eq(r.rows, 1, `users tile (${width}px): five tiles on ONE row, no orphan below`);
    ok(!r.overflowX && !r.clipped, `users tile (${width}px): nothing runs off the screen`);
    await ctx.close();
  }

  /* and on a phone, revealed, in the single column the breakpoint gives it */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('users tile 390: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await meta(q, { generated: '2026-09-05T00:00:00Z', count: 64 });
    await q.goto(BASE + 'index.html', { waitUntil: 'load' });
    await q.waitForSelector('[data-stat="users"]:not([hidden])', { timeout: 10000 });
    await q.evaluate(() => document.querySelector('[data-stat="users"]').scrollIntoView({ block: 'center' }));
    await q.waitForFunction(() => document.querySelector('[data-stat="users"] b').textContent === '60+', null, { timeout: 8000 });
    const r = await readStrip(q);
    eq(r.shown, 5, 'users tile (390px): all five tiles are shown on a phone');
    ok(!r.overflowX && !r.clipped, 'users tile (390px): …and the page does not scroll sideways');
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
  /* the dimension records, whose whole point is that they come from a
     DIFFERENT source and cover a DIFFERENT span from the day rows above —
     which is why every figure drawn from one has to say so on the page */
  const demoHours = Array.from({ length: 24 }, (_, h) => ({
    name: String(h).padStart(2, '0'),
    /* two humps, Europe and the Americas, and a genuinely dead 03:00 UTC:
       an hour with no visits is a REAL zero here, unlike a month the record
       has never reached */
    value: [2, 1, 0, 0, 1, 4, 12, 31, 66, 90, 88, 74, 71, 80, 96, 99, 84, 60, 41, 33, 27, 19, 11, 5][h],
  }));
  const demo = {
    version: 1,
    generated: new Date(end).toISOString(),
    dayFields: ['visitors', 'sessions', 'pageviews'],
    sources: [{ source: 'usage', days: Object.keys(demoDays).length }],
    days: demoDays,
    pages: [
      /* 1,952 seconds is the real figure this page was printing raw under its
         feedback page — the owner asked for hours/minutes/seconds instead */
      { path: '/jobs.html', title: 'Job postings', views: 48210, avgSec: 1952 },
      { path: '/', title: 'Operations Academia', views: 31022, avgSec: 73 },
    ],
    pagesWindow: { source: 'usage', from: '2026-06-01', to: '2026-08-28' },
    breakdowns: {
      hours: { source: 'usage', from: '2026-06-01', to: '2026-08-28',
        metric: 'visits', zone: 'UTC',
        total: demoHours.reduce((n, h) => n + h.value, 0), items: demoHours },
      /* `total` is deliberately LARGER than the listed items add up to: it is
         the pre-cut total, so a share must be a share of the whole rather than
         of the rows that happened to fit */
      countries: { source: 'ga4', from: '2026-06-01', to: '2026-08-28',
        metric: 'visits', zone: '', total: 1000,
        items: [{ name: 'United States', value: 400 }, { name: 'Ireland', value: 120 },
          { name: 'Germany', value: 90 }, { name: 'Singapore', value: 60 }] },
      /* total DELIBERATELY exceeds the listed rows by 150: the uncovered tail
         must be drawn as a named muted part, never as a blank stretch */
      channels: { source: 'ga4', from: '2026-06-01', to: '2026-08-28',
        metric: 'visits', zone: '', total: 1150,
        items: [{ name: 'Organic Search', value: 520 }, { name: 'Typed or bookmarked', value: 300 },
          { name: 'Referral', value: 180 }] },
      referrers: { source: 'ga4', from: '2026-06-01', to: '2026-08-28',
        metric: 'visits', zone: '', total: 1000,
        items: [{ name: 'google', value: 500 }, { name: 'linkedin.com', value: 210 }] },
      devices: { source: 'ga4', from: '2026-06-01', to: '2026-08-28',
        metric: 'visits', zone: '', total: 1000,
        items: [{ name: 'desktop', value: 610 }, { name: 'mobile', value: 350 },
          { name: 'tablet', value: 40 }] },
    },
    engagement: { source: 'usage', from: '2026-06-01', to: '2026-08-28',
      sessions: 1000, avgSessionSec: 322, viewsPerSession: 2.4 },
    /* THE LIVE SHAPE: resolved from the visitors' own networks, and therefore
       a SAMPLE — `seen` is every visit, `resolved` the ones a name came back
       for at all, `placed` the ones that reached a named university. The
       caption has to carry that share or a short chart reads as "hardly any
       universities visit". */
    universities: {
      frozen: false, from: '2026-08-01', to: '2026-08-28',
      all: [{ name: 'Duke University', visits: 2100 }, { name: 'INSEAD', visits: 1355 }],
      recent: [{ name: 'Duke University', visits: 40 }],
      recentDays: 7, seen: 12000, resolved: 4900, academic: 900, placed: 3455,
    },
    totals: { visitors: 1, sessions: 1, pageviews: 1, days: Object.keys(demoDays).length, universities: 2 },
    range: { from: '2024-01-01', to: '2026-08-28' },
    recentDays: 7,
  };

  const serveDemo = (pg, body) => pg.route('**/data/analytics.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  }));

  /* THE COMMUNITY'S GROWTH (owner, 2026-09-05): 400 days of registrations,
     slow at first and quicker in the last three months, so the dashed trend
     visibly differs from a line through the whole record */
  const growthDays = [];
  {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const t = new Date(end);
      t.setUTCDate(t.getUTCDate() - 399 + i);
      n += i < 300 ? (i % 6 === 0 ? 1 : 0) : (i % 2 === 0 ? 1 : 0);
      growthDays.push([t.toISOString().slice(0, 10), n]);
    }
  }
  const growthDemo = {
    generated: new Date(end).toISOString(),
    first: growthDays[0][0],
    days: growthDays,
  };
  const serveGrowth = (pg, body) => pg.route('**/data/users-growth.json', (r) => body == null
    ? r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  /* the months the growth table must list: from the first registration to
     a WEEK after TODAY (the model anchors its horizon on the reader's day,
     so a stale copy of the file still gets seven days ahead; the owner's
     rule of 2026-09-05 is that the line never runs beyond a week from now) */
  /* the days the caption must say the trend is carried: from the fixture's
     last day to seven days after TODAY, since the model anchors the horizon
     on the reader's day and the caption reads the number off the result */
  const AHEAD = 7;
  const carriedExpected = (() => {
    const to = new Date(); to.setUTCHours(0, 0, 0, 0); to.setUTCDate(to.getUTCDate() + AHEAD);
    return Math.round((to.getTime() - Date.parse(growthDays[growthDays.length - 1][0])) / 86400000);
  })();
  const monthsExpected = (() => {
    const to = new Date(); to.setUTCDate(to.getUTCDate() + AHEAD);
    const a = growthDays[0][0].slice(0, 7).split('-').map(Number);
    const b = to.toISOString().slice(0, 7).split('-').map(Number);
    return (b[0] - a[0]) * 12 + (b[1] - a[1]) + 1;
  })();

  /* --- with data, in BOTH themes ---------------------------------------- */

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1400 }, colorScheme: theme });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push(`analytics ${theme}: ` + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, demo);
    await serveGrowth(q, growthDemo);
    await q.addInitScript((t) => { try { localStorage.setItem('oaV3Theme', t); } catch (e) { /**/ } }, theme);
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    await q.waitForFunction(() => [...document.querySelectorAll('.oa-figure > h2')]
      .some((h) => /How the community has grown/.test(h.textContent)), null, { timeout: 15000 });

    const seen = await q.evaluate(() => ({
      figures: [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent),
      svgs: document.querySelectorAll('.oa-chart-svg').length,
      tables: document.querySelectorAll('.oa-chart-table').length,
      charts: document.querySelectorAll('.oa-chart').length,
      tiles: document.querySelectorAll('.oa-tile').length,
      frozen: [...document.querySelectorAll('.oa-figure-frozen')].map((e) => e.textContent.trim()),
      unisub: [...document.querySelectorAll('.oa-figure')]
        .filter((s) => /Which universities/.test((s.querySelector('h2') || {}).textContent || ''))
        .map((s) => (s.querySelector('.oa-figure-sub') || {}).textContent || '')[0] || '',
      iframes: document.querySelectorAll('iframe').length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      /* THE CAPTION RUNS THE FULL READING LINE (owner, 2026-09-03, with a
         screenshot of it stopping two thirds of the way across). Measured as
         geometry: every caption is as wide as its card's content box, which
         is the width the chart under it is drawn at. */
      subs: [...document.querySelectorAll('.oa-figure > .oa-figure-sub')].map((p) => {
        const card = p.parentElement;
        const cs = getComputedStyle(card);
        const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { title: card.querySelector('h2').textContent,
          width: p.getBoundingClientRect().width, inner, dash: /—/.test(p.textContent) };
      }),
    }));

    eq(seen.iframes, 0, `analytics (${theme}): the page embeds nothing`);
    ok(seen.subs.length >= 5, `analytics (${theme}): the figures carry captions (or the next check is vacuous)`);
    eq(seen.subs.filter((s) => Math.abs(s.width - s.inner) > 1).map((s) => s.title), [],
      `analytics (${theme}): every caption runs the full width of its card, as wide as the chart under it`);
    eq(seen.subs.filter((s) => s.dash).map((s) => s.title), [],
      `analytics (${theme}): …and none of them carries an em dash`);
    ok(seen.svgs >= 3, `analytics (${theme}): the charts are drawn as inline SVG`);
    ok(seen.tiles >= 4, `analytics (${theme}): the headline figures are shown`);
    /* THE RULE IS PER CHART, NOT PER SVG, and it had been the weaker one: the
       bar lists drew no table at all and the check passed because it compared
       tables against the SVGs, which the bar lists do not have either. Counting
       `.oa-chart` hosts is what the promise actually says. */
    eq(seen.tables, seen.charts,
      `analytics (${theme}): every chart also gives its numbers as a table — a chart ` +
      'is accessible because the values are available as text, not because it validated');
    ok(seen.charts > seen.svgs,
      `analytics (${theme}): …including the ones drawn as HTML rather than SVG, which ` +
      'is where that promise used to be quietly unmet');
    /* THE CORRECTION (owner, 2026-08-29). This figure used to be an archive
       labelled "no analytics product still offers this". A browser cannot see
       its own reverse-DNS; a Cloud Function can, and this site has them, so
       the measurement is current again — and a current figure must not carry
       an archive chip. */
    eq(seen.frozen, [],
      `analytics (${theme}): a LIVE universities section carries no archive label`);
    /* THE SHARE IS OF WHAT THE SENTENCE CLAIMS, and the fixture is built to
       tell the two apart: 12,000 visits, 4,900 that reverse-resolved to a name
       of ANY kind (internet providers included) and 3,455 actually placed at a
       university. Dividing by `resolved` would print 41% under a sentence
       about universities; the right answer is 29%, so a caption that reached
       for the wrong field fails here rather than reading plausibly. */
    ok(/of 12,000 visits, 3,455 \(29%\) were placed at a university listed here/.test(seen.unisub),
      `analytics (${theme}): …and says what share of visits it placed — a ranking ` +
      'printed without its denominator reads as "these are the universities that ' +
      'visit", which is a claim this measurement cannot make');
    ok(/no address is kept/.test(seen.unisub),
      `analytics (${theme}): …and says outright that no address is kept`);
    ok(/900 more came from a university this site has no department page for/.test(seen.unisub),
      `analytics (${theme}): …and counts the academic networks it could not name ` +
      'apart from the ones it could, because those are different facts');
    ok(/not recorded at all/.test(seen.unisub),
      `analytics (${theme}): …and says that a commercial or home connection is not ` +
      'recorded, which is the part a reader has no other way to learn');
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

    /* HOW THE COMMUNITY HAS GROWN (owner, 2026-09-05): two series, the real
       count in the brand ink and the expected growth dashed in the accent,
       measured from what the browser paints in this theme; the caption says
       exactly what the dashed line is and names both counts; the legend puts
       the trend away and brings it back; the table is one row per month. */
    const growth = await q.evaluate(() => {
      const fig = [...document.querySelectorAll('.oa-figure')]
        .find((f) => /How the community has grown/.test((f.querySelector('h2') || {}).textContent || ''));
      if (!fig) return null;
      const px = (el) => getComputedStyle(el).stroke;
      const brand = fig.querySelector('.oa-line.oa-brand');
      const accent = fig.querySelector('.oa-line.oa-accent');
      const heads = [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent);
      return {
        position: heads.indexOf('How the community has grown'),
        lines: fig.querySelectorAll('.oa-line').length,
        brand: brand ? px(brand) : '', accent: accent ? px(accent) : '',
        dash: accent ? getComputedStyle(accent).strokeDasharray : '',
        brandDash: brand ? getComputedStyle(brand).strokeDasharray : '',
        brandD: brand ? brand.getAttribute('d') : '',
        areaD: (fig.querySelector('.oa-area.oa-brand') || { getAttribute: () => '' }).getAttribute('d') || '',
        accentD: accent ? accent.getAttribute('d') : '',
        sub: (fig.querySelector('.oa-figure-sub') || {}).textContent || '',
        legend: [...fig.querySelectorAll('.oa-chart-legend-on button')].map((b) => b.textContent.trim()),
        tableCols: [...fig.querySelectorAll('.oa-chart-table thead th')].map((t) => t.textContent),
        tableRows: fig.querySelectorAll('.oa-chart-table tbody tr').length,
        firstRow: [...(fig.querySelector('.oa-chart-table tbody tr') || { children: [] }).children].map((c) => c.textContent),
        lastRow: [...([...fig.querySelectorAll('.oa-chart-table tbody tr')].pop() || { children: [] }).children].map((c) => c.textContent),
      };
    });
    ok(growth, `analytics (${theme}): the growth figure is drawn from its routed file`);
    if (growth) {
      eq(growth.position, 1, `analytics (${theme}): …directly under the visitors chart`);
      eq(growth.lines, 2, `analytics (${theme}): …with two lines, the count and the trend`);
      const rgb = (c) => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const [ar, ag, ab] = rgb(growth.brand);
      const [br, bg, bb] = rgb(growth.accent);
      const dist = Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
      ok(growth.brand !== growth.accent && dist > 90,
        `analytics (${theme}): the trend is the chart ACCENT, far enough from the brand line to read as ` +
        `two lines (channel distance ${dist})`);
      ok(growth.dash && growth.dash !== 'none' && (!growth.brandDash || growth.brandDash === 'none'),
        `analytics (${theme}): …and dashed where the real count is solid, so the pair never relies on colour alone`);
      ok(new RegExp('straight-line trend fitted over the last 90 days and carried ' + carriedExpected +
                    ' days forward; an expectation from past growth, not a target').test(growth.sub),
        `analytics (${theme}): the caption says exactly what the dashed line is, and is not, with the days really carried (${carriedExpected}: the fixture is stale against today, so a bare 7 would understate the line)`);
      /* THE WASH ENDS WHERE THE COUNT ENDS. The brand series carries trailing
         nulls for every projected day; the area under it must close at the
         last real point, never run on under the dashed projection to the
         horizon in the colour that means measured data. */
      const xs = (d) => (String(d).match(/[ML]\s*([\d.]+)\s+[\d.]+/g) || []).map((m) => Number(m.replace(/^[ML]\s*/, '').split(/\s+/)[0]));
      const brandXs = xs(growth.brandD);
      const areaXs = xs(growth.areaD);
      const accentXs = xs(growth.accentD);
      ok(brandXs.length > 1 && areaXs.length > 1 && accentXs.length > 1, `analytics (${theme}): the three paths were read`);
      ok(Math.max(...areaXs) === brandXs[brandXs.length - 1],
        `analytics (${theme}): the wash under the count ends at the count's last point (${brandXs[brandXs.length - 1]}), not at ${Math.max(...areaXs)}`);
      /* the projection is a WEEK past today (owner, 2026-09-05), which on a
         400-day axis is a handful of pixels past the count's last point: what
         makes the check non-vacuous is that it extends past it at all */
      ok(Math.max(...accentXs) > brandXs[brandXs.length - 1] + 1,
        `analytics (${theme}): …while the dashed projection runs past it (to ${Math.max(...accentXs)}), so the check is not vacuous`);
      const nums = growth.sub.match(/\b\d[\d,]*\b registered users on/) && growth.sub.match(/the trend reaches \b\d[\d,]*\b by/);
      ok(nums, `analytics (${theme}): …and names the count today and the count the trend reaches`);
      ok(!/—/.test(growth.sub), `analytics (${theme}): …without an em dash`);
      eq(growth.legend, ['Registered users', 'Expected growth'],
        `analytics (${theme}): the legend is the page's click-to-hide control, naming both series`);
      eq(growth.tableCols, ['Month', 'Registered users', 'Expected growth'],
        `analytics (${theme}): the numbers table is one row per MONTH, not per day`);
      eq(growth.tableRows, monthsExpected,
        `analytics (${theme}): …one for every month from the first registration to the end of the projection`);
      ok(/^[A-Z][a-z]{2} \d{4}$/.test(growth.firstRow[0]) && growth.firstRow[2] === '—',
        `analytics (${theme}): the first month carries a real count and no projection`);
      ok(growth.lastRow[1] === '—' && /^\d[\d,]*$/.test(growth.lastRow[2]),
        `analytics (${theme}): …and the last month a projection and no real count`);
    }
    const trend = await q.evaluate(() => {
      const fig = [...document.querySelectorAll('.oa-figure')]
        .find((f) => /How the community has grown/.test((f.querySelector('h2') || {}).textContent || ''));
      const btn = [...fig.querySelectorAll('.oa-chart-legend-on button')].find((b) => /Expected growth/.test(b.textContent));
      const line = fig.querySelector('.oa-line.oa-accent');
      btn.click();
      const off = { pressed: btn.getAttribute('aria-pressed'), display: line.style.display };
      btn.click();
      return { off, backOn: line.style.display };
    });
    eq(trend.off, { pressed: 'false', display: 'none' },
      `analytics (${theme}): pressing Expected growth in the legend puts the trend away`);
    ok(trend.backOn !== 'none', `analytics (${theme}): …and a second press brings it back`);

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

    /* THE MARKS ARE NEVER STRETCHED. Every chart used to be a fixed 900-unit
       drawing scaled NON-UNIFORMLY into its box (preserveAspectRatio:'none'),
       so nothing was ever at true proportion — 1.13x too wide at this
       viewport, a third of its width at 320px. A chart is now DRAWN at the
       width it is shown at, so both scales must be exactly 1. */
    const scales = await q.evaluate(() =>
      [...document.querySelectorAll('.oa-chart-svg')].map((svg) => {
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const r = svg.getBoundingClientRect();
        return { sx: r.width / vb[2], sy: r.height / vb[3] };
      }));
    ok(scales.length > 0 && scales.every((c) =>
      Math.abs(c.sx - 1) < 0.02 && Math.abs(c.sy - 1) < 0.02),
      `analytics (${theme}): every chart is drawn at the size it is shown at — ` +
      'one user unit is one CSS pixel, nothing stretched in either axis ' +
      `(scales ${scales.map((c) => c.sx.toFixed(2) + 'x' + c.sy.toFixed(2)).join(' ')})`);

    /* the range control drives every figure at once */
    const before = await q.evaluate(() =>
      document.querySelector('.oa-tile-value').textContent);
    /* SCOPED PAST THE METRIC SWITCH. The daily chart's Visitors/Visits/Pageviews
       control is the same shape deliberately — one control idiom on the page —
       so a bare `.oa-range button` now reaches seven buttons, not four. */
    await q.evaluate(() =>
      document.querySelectorAll('.oa-range:not(.oa-switch) button')[0].click());
    await q.waitForTimeout(250);
    const after = await q.evaluate(() => ({
      value: document.querySelector('.oa-tile-value').textContent,
      pressed: [...document.querySelectorAll('.oa-range:not(.oa-switch) button')]
        .map((b) => b.getAttribute('aria-pressed')),
    }));
    ok(after.value !== before,
      `analytics (${theme}): narrowing the range moves the headline figures`);
    eq(after.pressed, ['true', 'false', 'false', 'false'],
      `analytics (${theme}): …and exactly one range reads as chosen`);

    await ctx.close();
  }

  /* --- an ARCHIVED section still labels itself -------------------------- */

  /* `frozen` did not stop meaning anything when the measurement came back —
     it means "a closed period, measured under another rule", which is what
     the 2014-2023 figures would be if they ever turned up. The label has to
     go on saying so, or a decade of UA counts would be read as this month's. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1000 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics archive: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, {
      ...demo,
      universities: {
        frozen: true, from: '2014-03-01', to: '2023-06-30',
        all: [{ name: 'Duke University', visits: 2100 }], recent: [],
      },
    });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    const arch = await q.evaluate(() => ({
      frozen: [...document.querySelectorAll('.oa-figure-frozen')].map((e) => e.textContent.trim()),
      sub: [...document.querySelectorAll('.oa-figure')]
        .filter((s) => /Which universities/.test((s.querySelector('h2') || {}).textContent || ''))
        .map((s) => (s.querySelector('.oa-figure-sub') || {}).textContent || '')[0] || '',
    }));
    eq(arch.frozen, ['Archive: 2014 to 2023'],
      'analytics: an archived universities section is still labelled as one, with its range');
    ok(/is not being added to/.test(arch.sub),
      'analytics: …and says it is closed, rather than claiming nothing could ever replace it');
    await ctx.close();
  }

  /* --- the dimension figures, the durations and the interactivity -------

     Owner, 2026-08-29: several more plots, from Google Analytics, made
     interactive, with seconds said in minutes and hours where seconds are too
     long. What is measured here is the half a unit test cannot see: that the
     figures are really drawn, that a reader can interrogate them with a
     pointer AND a keyboard, and that no figure claims a span or a source it
     does not have. */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1400 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics dims: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, demo);
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });

    const heads = await q.evaluate(() =>
      [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent));
    for (const want of ['When in the day people read it', 'Where readers are',
      'How readers arrive', 'Which sites send readers', 'What they read it on']) {
      ok(heads.includes(want), `analytics: the "${want}" figure is drawn`);
    }

    /* THE HOURS ARE A CLOCK, and an hour with no visits is a REAL zero — the
       opposite of the months, where a month the record has never reached must
       draw no bar. Both rules live in the same `columns`, so both are
       measured: 24 labels, and the two dead night hours drawing nothing. */
    const hours = await q.evaluate(() => {
      const f = [...document.querySelectorAll('.oa-figure')]
        .find((x) => /When in the day/.test(x.querySelector('h2').textContent));
      return {
        ticks: [...f.querySelectorAll('.oa-tick-x')].map((t) => t.textContent),
        bars: f.querySelectorAll('.oa-bar[d]:not([d=""])').length,
        src: (f.querySelector('.oa-figure-src') || {}).textContent || '',
      };
    });
    eq(hours.ticks.length, 24, 'analytics: the hour chart names all twenty-four hours');
    eq(hours.ticks[0], '00', 'analytics: …in clock order, not ranked by size');
    eq(hours.bars, 22,
      'analytics: …and draws nothing for the two hours nobody visited, which here ' +
      'IS a zero — unlike a month the record has never covered');
    ok(/site.s own record/.test(hours.src) && /2026/.test(hours.src),
      'analytics: the hour chart names its source and the span it covers — the ' +
      'tallies are recomputed over a trailing window while the tiles above ' +
      'describe the whole record, and a reader must not compare the two blind');

    /* A SHARE OF THE WHOLE, NOT OF THE ROWS THAT FITTED. The fixture's country
       total is 1,000 against four listed rows adding to 670, so the leader is
       40% — and would read 60% if the share were taken over the visible rows,
       which is the classic way a top-ten chart comes to overstate its leader. */
    await q.hover('.oa-figure:has(h2:text-is("Where readers are")) .oa-bar-row');
    await q.waitForTimeout(120);
    const tipped = await q.evaluate(() => {
      const f = [...document.querySelectorAll('.oa-figure')]
        .find((x) => /Where readers are/.test(x.querySelector('h2').textContent));
      const tip = f.querySelector('.oa-chart-tip');
      return { hidden: tip.hidden, text: tip.textContent };
    });
    ok(!tipped.hidden, 'analytics: a row of a bar list answers a pointer — this was the ' +
      'one figure on the page a reader could not interrogate at all');
    ok(/40%/.test(tipped.text),
      'analytics: …with its share of the WHOLE, not of the rows that fitted');

    /* and the same answer by keyboard, which is the half a hover cannot give */
    const byKey = await q.evaluate(() => {
      const f = [...document.querySelectorAll('.oa-figure')]
        .find((x) => /Which sites send readers/.test(x.querySelector('h2').textContent));
      const row = f.querySelector('.oa-bar-row');
      row.focus();
      return { focusable: document.activeElement === row, hidden: f.querySelector('.oa-chart-tip').hidden };
    });
    ok(byKey.focusable && !byKey.hidden,
      'analytics: …and to the keyboard, which a hover-only tooltip never does');

    /* the share bar: one bar cut into its parts, a legend naming every part
       with its percentage, and the parts adding up to the bar */
    const shares = await q.evaluate(() => {
      const f = [...document.querySelectorAll('.oa-figure')]
        .find((x) => /What they read it on/.test(x.querySelector('h2').textContent));
      const segs = [...f.querySelectorAll('.oa-share-seg')];
      const bar = f.querySelector('.oa-share-bar').getBoundingClientRect();
      return {
        n: segs.length,
        widths: segs.reduce((sum, s) => sum + s.getBoundingClientRect().width, 0),
        bar: bar.width,
        legend: [...f.querySelectorAll('.oa-share-legend span')].map((x) => x.textContent),
        colours: segs.map((s) => getComputedStyle(s).backgroundColor),
      };
    });
    eq(shares.n, 3, 'analytics: the share bar is cut into one part per category');

    /* THE TAIL IS A PART, NOT A BLANK: the channels fixture's total exceeds
       its listed rows by 150 on purpose, and that remainder must be drawn as
       a named muted part with a legend entry — never an unexplained empty
       stretch of track, and never silently renormalised away. */
    const tail = await q.evaluate(() => {
      const f = [...document.querySelectorAll('.oa-figure')]
        .find((x) => /How readers arrive/.test(x.querySelector('h2').textContent));
      const segs = [...f.querySelectorAll('.oa-share-seg')];
      const bar = f.querySelector('.oa-share-bar').getBoundingClientRect();
      return {
        n: segs.length,
        rest: segs.filter((x) => /oa-cat-rest/.test(x.className)).length,
        filled: Math.abs(segs.reduce((n, x) => n + x.getBoundingClientRect().width, 0) - bar.width) < 2,
        legend: [...f.querySelectorAll('.oa-share-legend span')].map((x) => x.textContent),
      };
    });
    eq(tail.n, 4, 'analytics: a share total beyond the listed rows grows a fourth part');
    eq(tail.rest, 1, '…exactly one, painted as the muted rest');
    ok(tail.filled, '…and the parts then really fill the bar');
    ok(tail.legend.some((t) => /Everything else/.test(t) && /13%/.test(t)),
      '…named in the legend with its share of the whole (150 of 1,150 is 13%)');
    ok(Math.abs(shares.widths - shares.bar) < 2,
      'analytics: …and the parts really do fill it');
    ok(shares.legend.length === 3 && shares.legend.every((t) => /%/.test(t)),
      'analytics: …every part named with its percentage in the legend, so colour ' +
      'is never the only channel');
    eq(new Set(shares.colours).size, 3,
      'analytics: …and no two parts painted the same');

    /* SECONDS, SAID THE WAY A PERSON SAYS THEM (owner, 2026-08-29). The
       fixture carries the real 1,952-second figure the page was printing raw. */
    const times = await q.evaluate(() => ({
      body: document.querySelector('#oa-analytics').textContent,
      subs: [...document.querySelectorAll('.oa-bar-sub')].map((x) => x.textContent),
      tiles: [...document.querySelectorAll('.oa-tile')].map((t) => t.textContent),
    }));
    ok(times.subs.some((t) => /32m 32s/.test(t)),
      'analytics: an average time on a page reads "32m 32s", not "1952 seconds"');
    ok(!/1,?952 seconds/.test(times.body),
      'analytics: …and the raw seconds are nowhere on the page');
    ok(times.tiles.some((t) => /Time on a page/.test(t) && /5m 22s/.test(t)),
      'analytics: the time tile is said the same way — and titled "Time on a ' +
      'page", because the first-party record measures a PAGE, not a visit: its ' +
      'pages-per-visit is identically 1 by construction, so "Typical visit · ' +
      '1 pages" was two wrong claims in nine characters');
    ok(!times.tiles.some((t) => /Typical visit/.test(t)),
      'analytics: …and no tile claims the visit framing for it');

    /* the metric switch: one control, three questions */
    const heading0 = await q.evaluate(() =>
      document.querySelector('.oa-figure > h2').textContent);
    await q.evaluate(() => {
      const b = [...document.querySelectorAll('.oa-switch button')]
        .find((x) => x.textContent === 'Pageviews');
      b.click();
    });
    await q.waitForTimeout(250);
    const switched = await q.evaluate(() => ({
      heading: [...document.querySelectorAll('.oa-figure > h2')]
        .find((h) => /day by day/.test(h.textContent)).textContent,
      pressed: [...document.querySelectorAll('.oa-switch button')]
        .map((b) => b.getAttribute('aria-pressed')),
    }));
    ok(/^Visitors, day by day/.test(heading0),
      'analytics: the daily chart opens on visitors');
    ok(/^Pageviews, day by day/.test(switched.heading),
      'analytics: …and the switch really re-plots it, heading and all');
    /* TWO metrics, deliberately: the site's own record files one document per
       page opened, so a "Visits" series would be the Pageviews series wearing
       a wrong label — see METRICS in oa-analytics.js */
    eq(switched.pressed, ['false', 'true'],
      'analytics: …with exactly one of the two reading as chosen');

    /* the legend is a control: either line can be put away and brought back */
    const toggled = await q.evaluate(() => {
      const btn = [...document.querySelectorAll('.oa-chart-legend-on button')]
        .find((b) => /7-day/.test(b.textContent));
      btn.click();
      const line = document.querySelector('.oa-line.oa-accent');
      const off = { pressed: btn.getAttribute('aria-pressed'), display: line.style.display };
      btn.click();
      return { off, backOn: line.style.display };
    });
    eq(toggled.off.pressed, 'false', 'analytics: a legend entry is a real switch');
    eq(toggled.off.display, 'none', 'analytics: …that really puts its line away');
    ok(toggled.backOn !== 'none',
      'analytics: …and brings it back — hiding is never a one-way door here either');

    /* the line chart answers the keyboard as well as the pointer */
    const keyed = await q.evaluate(async () => {
      const wrap = document.querySelector('.oa-figure .oa-chart-plot');
      wrap.focus();
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      return { tabbable: wrap.tabIndex === 0, hidden: wrap.querySelector('.oa-chart-tip').hidden };
    });
    ok(keyed.tabbable && !keyed.hidden,
      'analytics: the daily chart takes focus and the arrow keys read it — a ' +
      'crosshair only a pointer can drive leaves the table as the only way in');

    /* every figure still names its own span; the page-level "Where these
       figures come from" note is GONE by owner decision (2026-08-30) — how
       the site is measured is not the readers' business */
    const prov = await q.evaluate(() => ({
      perFigure: [...document.querySelectorAll('.oa-figure-src')].map((x) => x.textContent),
      body: document.querySelector('#oa-analytics').textContent,
    }));
    ok(prov.perFigure.some((t) => /Google Analytics/.test(t)),
      'analytics: a figure Google measured says so under it');
    ok(!/Where these figures come from/.test(prov.body),
      'analytics: the provenance note is off the page — owner, 2026-08-30');
    ok(!/cookieless/i.test(prov.body) && !/admin/i.test(prov.body),
      'analytics: …and neither the cookieless trade-off nor the admin-area ' +
      'exclusion is described to visitors anywhere else on it');

    await ctx.close();
  }

  /* --- WITH EVERY SOURCE ANSWERING AT ONCE ------------------------------

     The state nothing else here drives: GA4's dimensions AND the site's own
     resolver both populated. Two defects lived exactly there and in no other
     combination, which is why both survived a green suite — one measured, one
     self-contradictory, neither reachable from a fixture that had only half
     the data. */

  {
    for (const width of [1400, 1180, 1024]) {
      const ctx = await browser.newContext({ viewport: { width, height: 1400 } });
      const q = await ctx.newPage();
      q.on('pageerror', (e) => jsErrors.push('analytics full: ' + e.message));
      await q.route('**/firebasejs/**', (r) => r.abort());
      await serveDemo(q, demo);          // carries breakdowns, engagement AND universities
      await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
      await q.waitForSelector('.oa-tile', { timeout: 15000 });

      /* A SIXTH TILE ORPHANS, which is why the length and the depth of a visit
         share one. Measured as the geometry rather than asserted as a count:
         what matters is that the strip never ends with a tile alone on a row
         of its own, whatever the tiles happen to be. */
      const strip = await q.evaluate(() => {
        const t = [...document.querySelectorAll('.oa-tile')];
        const tops = [...new Set(t.map((e) => Math.round(e.getBoundingClientRect().top)))];
        const last = tops[tops.length - 1];
        return {
          n: t.length,
          rows: tops.length,
          lastRow: t.filter((e) => Math.round(e.getBoundingClientRect().top) === last).length,
          labels: t.map((e) => e.querySelector('.oa-tile-label').textContent),
        };
      });
      ok(strip.n >= 5, `analytics (${width}px): the full dataset draws the whole tile strip`);
      ok(strip.rows === 1 || strip.lastRow > 1,
        `analytics (${width}px): no tile is left alone on a row of its own ` +
        `(${strip.n} tiles over ${strip.rows} row(s), last row holds ${strip.lastRow})`);
      ok(!strip.labels.includes('Universities seen'),
        `analytics (${width}px): the universities count is not a sixth tile — its ` +
        'own figure carries it');
      await ctx.close();
    }
  }

  /* --- ONE FIGURE PRESENT, THE OTHER NOT --------------------------------

     GA4 is configured and the visit resolver is not deployed, which is this
     installation's REAL state today. The countries caption used to point at
     "Which universities visited" below while the page listed that same figure
     under "Not on this page yet" — a page contradicting itself in the one
     combination no fixture covered. */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1400 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics half: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, { ...demo,
      universities: { frozen: false, from: '', to: '', all: [], recent: [] },
      totals: { ...demo.totals, universities: 0 } });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    const half = await q.evaluate(() => {
      const subOf = (name) => [...document.querySelectorAll('.oa-figure')]
        .filter((s) => new RegExp(name).test((s.querySelector('h2') || {}).textContent || ''))
        .map((s) => (s.querySelector('.oa-figure-sub') || {}).textContent || '')[0] || '';
      return {
        countries: subOf('Where readers are'),
        heads: [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent),
      };
    });
    ok(half.countries.length > 20, 'analytics: the countries figure is drawn (or the next check is vacuous)');
    ok(!half.heads.includes('Which universities visited'),
      'analytics: …and the universities figure is NOT, which is the combination under test');
    ok(!/Which universities visited/.test(half.countries),
      'analytics: a drawn figure never points at one the same page lists as missing — ' +
      'two optional figures cannot promise each other');
    ok(!half.heads.some((h) => /Which universities/.test(h)),
      'analytics: …and the absent one is simply NOT DRAWN — the note that used to ' +
      'name it was removed by the owner (2026-08-30), so not drawing it is the ' +
      'whole of the promise now');
    await ctx.close();
  }

  /* --- a dataset with no dimensions at all ------------------------------

     The five audience figures must be ABSENT rather than empty — a heading
     over a bare axis is the exact shape of the defect this page is a rebuild
     of. Absence is SILENT now: the foot note that used to name the missing
     ones (and the universities figure's own resolver beside them) was removed
     by the owner, 2026-08-30 — how the site is measured is not the readers'
     business. */

  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 1000 } });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics no-dims: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, { ...demo, breakdowns: {}, engagement: null });
    await serveGrowth(q, null);           // no growth file either
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    await q.waitForTimeout(400);
    const bare = await q.evaluate(() => ({
      heads: [...document.querySelectorAll('.oa-figure > h2')].map((h) => h.textContent),
      body: document.querySelector('#oa-analytics').textContent,
      emptyAxes: [...document.querySelectorAll('.oa-chart-svg')]
        .filter((svg) => !svg.querySelector('.oa-bar[d]:not([d=""]), .oa-line')).length,
      tiles: [...document.querySelectorAll('.oa-tile')].map((t) => t.textContent).join(' '),
    }));
    ok(!bare.heads.includes('Where readers are'),
      'analytics: a figure no source has answered for is not drawn at all');
    ok(!bare.heads.includes('How the community has grown'),
      'analytics: …and with no growth file the growth figure is absent too, silently, ' +
      'like every figure whose source has not answered');
    ok(!/Where these figures come from|Not on this page yet|own resolver/.test(bare.body),
      'analytics: …and no foot note describes the plumbing in its place — ' +
      'owner, 2026-08-30');
    eq(bare.emptyAxes, 0,
      'analytics: …and no chart on the page is an empty axis, which is the ' +
      'shape of the defect the page was rebuilt to remove');
    ok(!/Typical visit|Time on a page/.test(bare.tiles),
      'analytics: and a tile with no measurement behind it is absent, never a zero');
    await ctx.close();
  }

  /* --- on a phone, with the growth chart drawn --------------------------
     analytics.html is not an OAList page and is not in MOBILE_PAGES, so the
     phone claims for it are made here: no sideways scroll, every chart drawn
     at the size it is shown at, the growth figure among them. */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const q = await ctx.newPage();
    q.on('pageerror', (e) => jsErrors.push('analytics 390: ' + e.message));
    await q.route('**/firebasejs/**', (r) => r.abort());
    await serveDemo(q, demo);
    await serveGrowth(q, growthDemo);
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForFunction(() => [...document.querySelectorAll('.oa-figure > h2')]
      .some((h) => /How the community has grown/.test(h.textContent)), null, { timeout: 15000 });
    const phone = await q.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scales: [...document.querySelectorAll('.oa-chart-svg')].map((svg) => {
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const r = svg.getBoundingClientRect();
        return { sx: r.width / vb[2], sy: r.height / vb[3] };
      }),
      growthLines: (() => {
        const fig = [...document.querySelectorAll('.oa-figure')]
          .find((f) => /How the community has grown/.test((f.querySelector('h2') || {}).textContent || ''));
        return fig ? fig.querySelectorAll('.oa-line').length : 0;
      })(),
    }));
    ok(!phone.overflowX, 'analytics (390px): the page never scrolls sideways with the growth chart drawn');
    ok(phone.scales.length > 3 && phone.scales.every((c) => Math.abs(c.sx - 1) < 0.02 && Math.abs(c.sy - 1) < 0.02),
      'analytics (390px): every chart, the growth chart included, is drawn at the size it is shown at');
    eq(phone.growthLines, 2, 'analytics (390px): the growth chart carries both lines on a phone');
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
    /* the growth file as it SHIPS, the empty seed: the committed one holds
       real days since the roster sync first ran (2026-09-05), and left
       unrouted it drew the growth chart under "nothing is being measured",
       so the "no empty chart" pin went red on a data commit. A browser check
       must not move with the corpus. */
    await serveGrowth(q, { generated: '', first: '', days: [] });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-an-note', { timeout: 15000 });
    const note = await q.evaluate(() => document.querySelector('#oa-analytics').textContent);
    ok(/Nothing is being measured yet/i.test(note),
      'analytics: with no data the page SAYS so — four empty boxes reporting nothing ' +
      'to anybody is how the old charts stayed dead for three years');
    ok(/Universal Analytics/.test(note) && /_SETUP-ANALYTICS\.md/.test(note),
      'analytics: …and names both the cause and where to read what to do about it');
    /* the growth chart arrives on its own fetch, after the note: count once
       it has had time to land, or a chart drawn late passes this by luck */
    await q.waitForTimeout(800);
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
      /* a country and a referring host are strings GOOGLE read out of somebody
         else's traffic, so they are exactly as untrusted as a page title —
         and they reach a tooltip, which is assembled as HTML */
      breakdowns: {
        countries: { source: 'ga4', from: '', to: '', metric: 'visits', total: 9,
          items: [{ name: '<img src=x onerror=alert(1)>', value: 9 }] },
        devices: { source: 'ga4', from: '', to: '', metric: 'visits', total: 5,
          items: [{ name: '<script>alert(1)</script>', value: 5 }] },
      },
    });
    await q.goto(BASE + 'analytics.html', { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('.oa-figure', { timeout: 15000 });
    /* drive the tooltips too: they are the one place this page assembles HTML
       from a served string rather than setting textContent */
    await q.hover('.oa-bar-row').catch(() => {});
    await q.hover('.oa-share-seg').catch(() => {});
    await q.waitForTimeout(120);
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

    /* THE PHONE IS WHERE THE STRETCH WAS WORST — measured 0.36x at this very
       width — so true proportion is asserted here as well as on the desktop,
       along with the two things a narrow plot must give up honestly: axis
       labels THIN to what fits (every Nth, never overprinting into a smear),
       and the legend's series switches grow to thumb size. */
    const mgeo = await q.evaluate(() => {
      const out = { scales: [], overlaps: 0, legend: [] };
      document.querySelectorAll('.oa-chart-svg').forEach((svg) => {
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const r = svg.getBoundingClientRect();
        out.scales.push({ sx: r.width / vb[2], sy: r.height / vb[3] });
        const ticks = [...svg.querySelectorAll('.oa-tick-x')]
          .map((t) => t.getBoundingClientRect())
          .sort((a, b) => a.left - b.left);
        for (let i = 1; i < ticks.length; i++) {
          if (ticks[i].left < ticks[i - 1].right - 0.5) out.overlaps++;
        }
      });
      out.legend = [...document.querySelectorAll('.oa-chart-legend-on button')]
        .map((b) => Math.round(b.getBoundingClientRect().height));
      return out;
    });
    ok(mgeo.scales.length > 0 && mgeo.scales.every((c) =>
      Math.abs(c.sx - 1) < 0.02 && Math.abs(c.sy - 1) < 0.02),
      'analytics mobile: the charts are at true proportion on a phone too — ' +
      'this width used to render every glyph at a third of its designed width');
    eq(mgeo.overlaps, 0,
      'analytics mobile: no two axis labels overprint — the 24 hour labels ' +
      'thin to every third rather than piling into a smear');
    ok(mgeo.legend.length > 0 && mgeo.legend.every((h) => h >= 42),
      'analytics mobile: the legend series switches are 42px thumb targets');

    /* AND A ROTATION IS A REDRAW: widen the viewport and the charts must be
       re-drawn at the new width within the debounce, not letterboxed into it
       for ever. */
    await q.setViewportSize({ width: 700, height: 844 });
    await q.waitForTimeout(450);
    const rotated = await q.evaluate(() =>
      [...document.querySelectorAll('.oa-chart-svg')].map((svg) => {
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const r = svg.getBoundingClientRect();
        return Math.abs(r.width / vb[2] - 1) < 0.02 && vb[2] > 400;
      }));
    ok(rotated.length > 0 && rotated.every(Boolean),
      'analytics mobile: turning the phone redraws every chart at the new ' +
      'width — still one user unit to one pixel, at the wider size');
    await ctx.close();
  }
}


/* ------------------------------------- "Closing this week" on the alerts page

   The deadlines topic (owner, 2026-09-04): a fourth tick box, a preview
   section built by the SAME function the mailer runs, and a deadlines-only
   alert that saves with exactly that topic. The served file is routed to a
   fixture, because whether any real posting closes in the next seven days is
   a fact about the calendar and a guard about a corpus must not move with
   it; the reader is signed in through the shim, since the preview carries
   real postings and is drawn for a registered reader only.               */
{
  const today = new Date().toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000)
    .toISOString().slice(0, 10);
  const yr = marketYear();
  const row = (id, extra) => ({ id, year: yr, years: [yr], posted: today,
    institution: id + ' University', department: 'Operations', school: '', unit: 'Operations',
    type: 'University', levels: ['Assistant Professor'], applyBy: 'Until filled.',
    applyByDate: '', country: 'Ireland', characteristics: [], featured: false,
    source: 'oa-form', addedAt: today + 'T00:00:00Z', ...extra });
  const SEED = [
    row('closing-final', { applyByDate: plus(3), applyBy: 'soon' }),
    row('closing-review', { reviewDate: plus(5) }),
    row('closing-later', { applyByDate: plus(30), applyBy: 'later' }),
  ];

  const { ctx, page: q, errors } = await signedInPage('alerts.html', { wait: false });
  await q.route('**/data/jobs.json', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEED) }));
  await q.goto(BASE + 'alerts.html', { waitUntil: 'load' });
  await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
    null, { timeout: 15000 });
  await q.waitForSelector('#oa-alerts-app', { timeout: 15000 });
  // the filter vocabulary is built from the routed file, so this is "loaded"
  await q.waitForSelector('#a-country input', { timeout: 15000 });
  await q.waitForTimeout(250);

  const box = await q.evaluate(() => {
    const t = document.querySelector('#t-deadlines');
    return t && { checked: t.checked,
      label: t.closest('label').textContent.replace(/\s+/g, ' ').trim() };
  });
  ok(box && !box.checked, 'closing: the fourth tick box is offered, unticked on a new alert');
  ok(box && /^Postings closing within 7 days\./.test(box.label),
    'closing: …and says what it does');

  // a deadlines-ONLY alert: the filters stay, the preview shows the section
  await q.uncheck('#t-jobs');
  await q.check('#t-deadlines');
  await q.waitForTimeout(150);
  const pv = await q.evaluate(() => ({
    filters: !document.querySelector('#a-filters').hidden,
    subject: document.querySelector('#oa-preview .oa-preview-head').textContent.replace(/\s+/g, ' '),
    text: document.querySelector('#oa-preview').textContent.replace(/\s+/g, ' '),
  }));
  ok(pv.filters, 'closing: the filters stay on screen for a deadlines-only alert — they choose its postings');
  ok(/Closing this week/.test(pv.text), 'closing: the preview carries the "Closing this week" section');
  ok(/2 postings matching your alert close in the next seven days/.test(pv.text),
    'closing: …counting the two that close within the week');
  ok(/closing-final University/.test(pv.text) && /Final apply by/.test(pv.text),
    'closing: …the final apply-by named as final');
  ok(/closing-review University/.test(pv.text) && /Suggested apply by/.test(pv.text),
    'closing: …the suggested one as suggested');
  ok(!/closing-later University/.test(pv.text),
    'closing: …and not the posting closing in a month');
  ok(/Subject: 2 postings close this week/.test(pv.subject),
    'closing: an unnamed deadlines-only alert previews the subject the mailer gives it');

  // the alert's own filters narrow the reminder, live
  await q.fill('#a-text', 'closing-final');
  await q.waitForTimeout(150);
  const narrowed = await q.$eval('#oa-preview', (n) => n.textContent.replace(/\s+/g, ' '));
  ok(/One posting matching your alert closes in the next seven days/.test(narrowed) &&
     !/closing-review University/.test(narrowed),
    'closing: a filter narrows the reminder the way it narrows new postings');

  // a MONTHLY digest sees one week in four: the hint under the frequency
  // appears for exactly that pair, and goes with either half of it
  await q.selectOption('#a-freq', 'monthly');
  await q.waitForTimeout(100);
  const noteOn = await q.$eval('#a-freq-note', (n) => ({ hidden: n.hidden,
    text: n.textContent.replace(/\s+/g, ' ').trim() }));
  ok(!noteOn.hidden && /seven days after it goes out/.test(noteOn.text) &&
     /daily or weekly/.test(noteOn.text),
    'closing: deadlines ticked + monthly draws the hint saying what a monthly digest misses');
  await q.selectOption('#a-freq', 'weekly');
  await q.waitForTimeout(100);
  ok(await q.$eval('#a-freq-note', (n) => n.hidden),
    'closing: …weekly puts it away (a week\'s cadence covers every closing date)');
  await q.selectOption('#a-freq', 'monthly');
  await q.uncheck('#t-deadlines');
  await q.waitForTimeout(100);
  ok(await q.$eval('#a-freq-note', (n) => n.hidden),
    'closing: …and so does unticking deadlines, whatever the frequency');
  await q.check('#t-deadlines');
  await q.selectOption('#a-freq', 'daily');
  await q.waitForTimeout(100);

  // …and it saves, with exactly that topic, through the shim
  await q.fill('#a-name', 'Closing soon');
  await q.click('#a-save');
  await q.waitForFunction(() => /Alert created/.test(
    document.querySelector('#a-msg').textContent), null, { timeout: 15000 });
  await q.waitForTimeout(250);
  const saved = await q.evaluate((uid) => {
    const key = Object.keys(window.__fb.docs).find((k) => k.startsWith('users/' + uid + '/alerts/'));
    const d = key && window.__fb.docs[key];
    return d && { topics: d.criteria.topics, text: d.criteria.text, enabled: d.enabled,
      email: d.email, hasMark: 'lastDeadlineUntil' in d,
      card: (document.querySelector('#oa-alert-list .oa-alert-card') || {}).textContent
        .replace(/\s+/g, ' ') };
  }, A_READER.uid);
  eq(saved && saved.topics, ['deadlines'],
    'closing: a deadlines-only alert is saved with that one topic — it has intent on its own');
  ok(saved && saved.text === 'closing-final' && saved.enabled === true &&
     saved.email === A_READER.email,
    'closing: …with its filter, enabled, to the account\'s own address');
  ok(saved && !saved.hasMark,
    'closing: the page writes no mark — lastDeadlineUntil is the mailer\'s, behind a delivery');
  ok(saved && /postings closing within 7 days matching “closing-final”/.test(saved.card),
    'closing: the card\'s summary line names the reminder and its filter');
  eq(errors, [], 'closing: no script errors on the alerts page');
  await ctx.close();
}

/* ------------------------------------- save the search as an e-mail alert

   A signed-in reader who has narrowed the jobs list can press "Save as
   e-mail alert", beside the Excel download, and land on alerts.html with a
   new alert filled in from the filters they had set (owner, 2026-09-04;
   assets/oa-alertsave.js). selftest.mjs pins the mapping and the wiring;
   this drives the reader: signed out it opens the sign-in box and goes
   nowhere, signed in it lands on the alerts page with the boxes ticked and a
   note naming what was left out, a reload does not fill the form twice, a
   signed-out arrival on the alerts page keeps the prefill across the
   sign-in, and the button shares the download's line at 1280px and its
   stack at 390px.

   The fixture is read off the served file under the page's own market rule
   rather than named: a guard about a corpus must not move with the corpus. */
{
  /* wrapped: filter() hands the index as the predicate's second argument,
     which inCurrentMarket reads as `now` */
  const served = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'))
    .filter((r) => inCurrentMarket(r));
  const pick = served.find((r) => (r.characteristics || []).length &&
    (r.levels || []).length && r.country && r.institution);
  ok(!!pick, 'save-search: a served posting in the current market carries a level, a country and a characteristic');
  const LEVEL = pick.levels[0], CHAR = pick.characteristics[0], COUNTRY = pick.country;
  const TERM = pick.institution.slice(0, 6);
  const enc = encodeURIComponent;
  const SEARCH = `jobs.html?institution=${enc(TERM)}&level=${enc(LEVEL)}` +
    `&country=${enc(COUNTRY)}&chars=${enc(CHAR)}`;

  /* -- signed OUT: the sign-in box, and no navigation --------------------- */
  {
    const { ctx, page: q, errors } = await signedOutPage(SEARCH);
    const before = await q.evaluate(() => {
      const b = document.querySelector('.oa-alert-save');
      return { there: !!b, disabled: b ? b.disabled : null, title: b ? b.title : '',
        locked: !!document.querySelector('.v3-lock.is-locked') };
    });
    ok(before.there && before.locked, 'save-search: the button is in the locked filter bar');
    ok(before.disabled === false && /with an account/.test(before.title),
      'save-search: filtered, it is live and says the alert is free with an account');
    /* through the lock's pointer-events:none deliberately — the lock is a
       nudge, and what is under test is the module's own gate */
    await q.evaluate(() => document.querySelector('.oa-alert-save').click());
    await q.waitForTimeout(1000);
    ok(/jobs\.html$/.test(new URL(q.url()).pathname),
      'save-search: pressing it signed out goes NOWHERE');
    ok(await q.evaluate(() => !!document.querySelector('.oa-modal')),
      'save-search: …it offers the sign-in box instead');
    ok(await q.$eval('#v3-lock-card', (n) => /e-mail alert/i.test(n.textContent)),
      'save-search: and the sign-in card names it as a reason to register');
    eq(errors, [], 'save-search: signed-out run — no uncaught script error');
    await ctx.close();
  }

  /* -- signed IN: disabled with nothing filtered, then the hop ------------- */
  {
    const { ctx, page: q, errors } = await signedInPage('jobs.html');
    const idle = await q.evaluate(() => {
      const b = document.querySelector('.oa-alert-save');
      return { disabled: b.disabled, title: b.title, aria: b.getAttribute('aria-label') };
    });
    ok(idle.disabled, 'save-search: with nothing filtered the button is disabled');
    ok(/New job postings/.test(idle.title) && /leave the filters blank/i.test(idle.title),
      'save-search: …and its tooltip says an alert for everything is the topic with no filters');
    eq(idle.aria, idle.title, 'save-search: …readable by a screen reader too');

    await q.goto(BASE + SEARCH, { waitUntil: 'load' });
    await q.waitForSelector('.oa-card', { timeout: 15000 });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.waitForTimeout(300);
    const row = await q.evaluate(() => {
      const g = (s) => document.querySelector(s).getBoundingClientRect();
      const b = document.querySelector('.oa-alert-save');
      const r = g('.oa-alert-save'), c = g('.oa-clear'), x = g('.oa-export');
      const cell = b.closest('.oa-filter-actions').getBoundingClientRect();
      const tops = new Set([...document.querySelector('.oa-filters').children]
        .map((n) => Math.round(n.getBoundingClientRect().top)));
      return { disabled: b.disabled, title: b.title, text: b.textContent.trim(),
        top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.x),
        clearTop: Math.round(c.top), clearH: Math.round(c.height), clearW: Math.round(c.width),
        expRight: Math.round(x.right), expTop: Math.round(x.top),
        rightGap: Math.round(cell.right - r.right), rows: tops.size };
    });
    ok(!row.disabled && !/with an account/.test(row.title),
      'save-search: filtered and signed in, the button is live and no longer sells the account');
    ok(/save as e-mail alert/i.test(row.text),
      `save-search: the label says what it does (${JSON.stringify(row.text)})`);
    ok(Math.abs(row.top - row.clearTop) <= 2 && row.h === row.clearH && Math.abs(row.top - row.expTop) <= 2,
      `save-search: on ONE line with Clear and the download, same height ` +
      `(${row.h}, tops ${row.top}/${row.clearTop}/${row.expTop})`);
    ok(row.w < row.clearW, `save-search: narrower than Clear (${row.w} vs ${row.clearW})`);
    ok(row.x > row.expRight && Math.abs(row.rightGap) <= 1.5,
      'save-search: to the right of the download, holding the bar\'s right edge');
    eq(row.rows, 2, `save-search: the bar is still two rows deep (${row.rows})`);

    await q.click('.oa-alert-save');
    await q.waitForURL(/alerts\.html/, { timeout: 15000 });
    await q.waitForSelector('#oa-prefill-note:not([hidden])', { timeout: 15000 });
    await q.waitForTimeout(250);
    const landed = await q.evaluate(([level, country]) => {
      const checked = (host, v) => {
        const i = [...document.querySelectorAll('#' + host + ' input')].find((n) => n.value === v);
        return i ? i.checked : null;
      };
      const note = document.querySelector('#oa-prefill-note');
      return { search: location.search, text: document.querySelector('#a-text').value,
        name: document.querySelector('#a-name').value,
        level: checked('a-level', level), country: checked('a-country', country),
        jobs: document.querySelector('#t-jobs').checked,
        deadlines: document.querySelector('#t-deadlines').checked,
        legend: document.querySelector('#oa-form-legend').textContent,
        note: note.textContent.replace(/\s+/g, ' '), dropped: note.getAttribute('data-dropped') || '',
        stash: sessionStorage.getItem('oaAlertPrefill'),
        msg: document.querySelector('#a-msg').textContent,
        filters: !document.querySelector('#a-filters').hidden };
    }, [LEVEL, COUNTRY]);
    eq(landed.text, TERM, 'save-search: the university search term is in the text box');
    eq(landed.level, true, `save-search: the entry level is ticked (${LEVEL})`);
    eq(landed.country, true, `save-search: the location is ticked (${COUNTRY})`);
    ok(landed.jobs && !landed.deadlines && landed.filters,
      'save-search: New job postings is the topic, and the filters are on screen');
    ok(landed.name.includes(LEVEL) && landed.name.includes(COUNTRY),
      `save-search: a name is suggested from the filters (${JSON.stringify(landed.name)})`);
    ok(/Create an alert/.test(landed.legend), 'save-search: it is a NEW alert, not an edit');
    ok(/^Filled in from your search/.test(landed.note) && /characteristics you ticked/.test(landed.note),
      'save-search: the note says the form was filled in, and names the characteristics as not carried');
    ok(landed.dropped.split(',').includes('chars'), 'save-search: …keyed on the filter that was dropped');
    ok(!/prefill|level=|chars=/.test(landed.search),
      `save-search: the parameters are gone from the address (${JSON.stringify(landed.search)})`);
    eq(landed.stash, null, 'save-search: and the stash is spent');
    ok(/jobs page/.test(landed.msg), 'save-search: the form\'s own message line says where the values came from');

    /* a reload does NOT fill the form again */
    await q.reload({ waitUntil: 'load' });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.waitForSelector('#a-country input', { timeout: 15000 });
    await q.waitForTimeout(400);
    const again = await q.evaluate(() => ({
      note: document.querySelector('#oa-prefill-note').hidden,
      text: document.querySelector('#a-text').value,
      name: document.querySelector('#a-name').value }));
    ok(again.note && again.text === '' && again.name === '',
      'save-search: a reload after the form was filled starts clean');
    eq(errors, [], 'save-search: signed-in run — no uncaught script error');
    await ctx.close();
  }

  /* -- arriving signed OUT on the alerts page keeps the prefill ------------ */
  {
    const { ctx, page: q, errors } = await signedOutPage(
      `alerts.html?prefill=1&level=${enc(LEVEL)}&dropped=chars`, { wait: false });
    await q.waitForFunction(() => !!(window.OAAccounts && window.OAAccounts.resolved()),
      null, { timeout: 15000 });
    await q.waitForSelector('#oa-needauth:not([hidden])', { timeout: 15000 });
    const held = await q.evaluate(() => ({ search: location.search,
      stash: sessionStorage.getItem('oaAlertPrefill'),
      note: document.querySelector('#oa-prefill-note').hidden }));
    ok(!/prefill/.test(held.search), 'save-search: signed out, the address is stripped on arrival');
    ok(!!held.stash && held.note,
      'save-search: …the prefill is held, and nothing is drawn for a reader who cannot see the form');
    /* the reader signs in: the shim signs whoever the seed names, so the seed
       is given the reader first (the gate block's own trick) */
    await q.evaluate((u) => {
      window.__FAKE_FB.user = u;
      return window.OAFB.ready().then((fb) => fb.auth().signInWithPopup({}));
    }, A_READER);
    await q.waitForSelector('#oa-prefill-note:not([hidden])', { timeout: 15000 });
    const after = await q.evaluate((level) => ({
      level: ([...document.querySelectorAll('#a-level input')].find((n) => n.value === level) || {}).checked,
      stash: sessionStorage.getItem('oaAlertPrefill'),
      note: document.querySelector('#oa-prefill-note').textContent }), LEVEL);
    eq(after.level, true, 'save-search: …and signing in fills the form from it');
    ok(/characteristics/.test(after.note) && after.stash === null,
      'save-search: …note and all, spent once');
    eq(errors, [], 'save-search: alerts-page run — no uncaught script error');
    await ctx.close();
  }

  /* -- a phone: full width, stacked under the download, one shape --------- */
  {
    const { ctx, page: q } = await signedInPage(SEARCH, { viewport: { width: 390, height: 850 } });
    const m = await q.evaluate(() => {
      const b = document.querySelector('.oa-alert-save'), x = document.querySelector('.oa-export');
      const r = b.getBoundingClientRect(), xr = x.getBoundingClientRect();
      const bar = document.querySelector('.oa-filters').getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width), barW: Math.round(bar.width),
        gap: Math.round(r.top - xr.bottom), shape: getComputedStyle(b).borderRadius,
        expShape: getComputedStyle(x).borderRadius, expW: Math.round(xr.width),
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    ok(m.h >= 40, `save-search at 390px: a 40px+ target (${m.h}px)`);
    ok(m.w > m.barW * 0.7 && m.w === m.expW,
      'save-search at 390px: full width, the same width as the download');
    ok(m.gap >= 6, `save-search at 390px: stacked under the download with room (${m.gap}px)`);
    eq(m.shape, m.expShape, 'save-search at 390px: …and the same shape as it');
    ok(m.over <= 1, 'save-search at 390px: the page still does not scroll sideways');
    await ctx.close();
  }
}

/* ------------------------------ e-mail verification on registration

   Owner, 2026-09-04: an account registered with an e-mail address and a
   password must press a link in a message before it can be used. The rules
   enforce it (verified() in _firestore.rules, pinned in selftest.mjs); what
   is measured HERE is what the BROWSER does with an unverified password
   account: it is signed out for everything but the "Check your inbox" card,
   the card's buttons reach the callable first and Firebase's own message
   when the callable is absent, "I have verified it" lifts the gate, and the
   page the link opens (verify-email.html) shows the right one of its four
   cards. The shim stands in for the SDK (_fake-firebase.js: reload,
   getIdToken, sendEmailVerification, applyActionCode and httpsCallable are
   all recorded), so every path is driven rather than read off the source. */
{
  const UNVERIFIED = { uid: 'unverified-uid-00001', email: 'newcomer@example.edu',
    displayName: '', emailVerified: false, providerData: [{ providerId: 'password' }] };

  /* -- jobs.html: the pending session is signed out for everything but the card -- */
  {
    const { ctx, page: q, errors } = await signedInPage('jobs.html', { user: UNVERIFIED });
    await q.waitForSelector('#oa-verify-chip', { timeout: 15000 });
    await q.waitForTimeout(400);
    const st = await q.evaluate(() => {
      const panel = document.querySelector('#oa-verify');
      const cards = [...document.querySelectorAll('#oa-jobs .oa-card')];
      return {
        chip: (document.querySelector('#oa-verify-chip') || {}).textContent,
        chipPending: !!document.querySelector('#oa-verify-chip.oa-acct-pending'),
        nameChip: !!document.querySelector('#oa-chip'),
        panel: !!panel,
        heading: panel ? panel.querySelector('h3').textContent : '',
        lede: panel ? panel.querySelector('.oa-modal-lede').textContent : '',
        text: panel ? panel.textContent : '',
        send: !!(panel && panel.querySelector('#oa-verify-send')),
        sendLabel: panel ? panel.querySelector('#oa-verify-send').textContent : '',
        check: !!(panel && panel.querySelector('#oa-verify-check')),
        out: !!(panel && panel.querySelector('#oa-verify-out')),
        cards: cards.length,
        locked: cards.filter((c) => c.classList.contains('oa-card-locked')).length,
        auth: document.documentElement.getAttribute('data-oa-auth'),
        hint: localStorage.getItem('oaAuthHint'),
        user: window.OAAccounts.user(),
        hintFn: window.OAAccounts.hint(),
        pending: (window.OAAccounts.pendingUser() || {}).uid,
        needs: window.OAAccounts.needsVerification(),
        writes: window.__fb.ops('set').filter((p) => /^(registeredUsers|userDirectory|accountKeys)\//.test(p)),
        profileRead: window.__fb.ops('get').filter((p) => /^profiles\//.test(p)),
      };
    });
    eq(st.chip, 'Verify your e-mail', 'verify: the header chip says what the account has to do');
    ok(st.chipPending && !st.nameChip,
      'verify: …in its own pending state, and no name chip is painted for an unusable account');
    ok(st.panel && st.heading === 'Check your inbox',
      'verify: the "Check your inbox" card opens on its own');
    ok(st.lede.includes(UNVERIFIED.email) && /Operations Academia/.test(st.lede),
      'verify: …naming the address, and that a message from Operations Academia is on its way');
    ok(st.send && st.check && st.out,
      'verify: …with Send the e-mail again, I have verified it, and a way out');
    ok(/If a message from Operations Academia reached/.test(st.lede) && !/on its way/.test(st.lede)
       && st.sendLabel === 'Send the e-mail',
      'verify: on a sign-in, where nothing was sent, the card promises nothing "on its way" and the button offers to send it');
    ok(/spam/i.test(st.text) && /operationsacademia@gmail\.com/.test(st.text),
      'verify: …and says to look in spam, naming the sender');
    ok(st.cards > 1 && st.locked === st.cards,
      `verify: every card on the jobs page is LOCKED for the pending account (${st.locked} of ${st.cards})`);
    eq([st.user, st.hintFn, st.auth], [null, 'out', 'out'],
      'verify: user() is null, hint() is out, and the head reserve reads out');
    eq(st.hint, null, 'verify: no localStorage hint is written, so the next page cannot paint it signed in');
    eq(st.pending, UNVERIFIED.uid, 'verify: pendingUser() is the one export that can see the account');
    ok(st.needs === true, 'verify: needsVerification() says so');
    eq(st.writes, [], 'verify: no roster row, no tally and no identity key is written while pending');
    eq(st.profileRead, [], 'verify: …and the profile is not read either');

    /* Send again: the callable FIRST, and only that */
    await q.click('#oa-verify-send');
    await q.waitForFunction(() => window.__fb.at('callable', 'sendVerificationEmail') >= 0,
      null, { timeout: 8000 });
    await q.waitForTimeout(200);
    const sent = await q.evaluate((uid) => ({
      callable: window.__fb.at('callable', 'sendVerificationEmail'),
      fallback: window.__fb.at('sendEmailVerification', uid),
      msg: (document.querySelector('#oa-verify-msg') || {}).textContent,
    }), UNVERIFIED.uid);
    ok(sent.callable >= 0 && sent.fallback < 0,
      'verify: Send again calls the site\'s own function and NOT Firebase\'s message');
    ok(/Sent to newcomer@example\.edu/.test(sent.msg), 'verify: …and the card says it went');

    /* I have verified it, while it has not been: the gate holds */
    await q.click('#oa-verify-check');
    await q.waitForTimeout(400);
    const held = await q.evaluate(() => ({
      reload: window.__fb.at('reload', 'unverified-uid-00001'),
      panel: !!document.querySelector('#oa-verify'),
      msg: (document.querySelector('#oa-verify-msg') || {}).textContent,
      user: window.OAAccounts.user(),
    }));
    ok(held.reload >= 0 && held.panel && held.user === null && /Not confirmed yet/.test(held.msg),
      'verify: "I have verified it" reloads the user, and holds the gate while the address is still unconfirmed');
    eq(errors, [], 'verify: no uncaught script error on the pending jobs page');
    await ctx.close();
  }

  /* -- the callable is absent: Firebase's own message is the fallback ------ */
  {
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { callableFails: 'functions/not-found' } });
    await q.waitForSelector('#oa-verify-send', { timeout: 15000 });
    await q.click('#oa-verify-send');
    await q.waitForFunction((uid) => window.__fb.at('sendEmailVerification', uid) >= 0,
      UNVERIFIED.uid, { timeout: 8000 });
    await q.waitForTimeout(200);
    const fb = await q.evaluate((uid) => {
      const rec = window.__fb.log.find((e) => e.op === 'sendEmailVerification' && e.path === uid);
      return {
        callable: window.__fb.at('callable', 'sendVerificationEmail'),
        fallback: window.__fb.at('sendEmailVerification', uid),
        url: rec && rec.data && rec.data.url,
        from: (document.querySelector('#oa-verify-from') || {}).textContent,
        msg: (document.querySelector('#oa-verify-msg') || {}).textContent,
      };
    }, UNVERIFIED.uid);
    ok(fb.callable >= 0 && fb.fallback > fb.callable,
      'verify: with the function not deployed, the card tries it and then FALLS BACK to sendEmailVerification');
    eq(fb.url, 'https://www.operationsacademia.org/verify-email.html',
      'verify: …landing Firebase\'s own link on the site\'s verify page');
    ok(/firebaseapp\.com/.test(fb.from) && /Sent to/.test(fb.msg),
      'verify: …and the sender line then names Firebase\'s address, so the reader knows what to look for');
    eq(errors, [], 'verify: no uncaught script error on the fallback path');
    await ctx.close();
  }

  /* -- the function refuses, and says why: its words reach the card --------- */
  {
    const DAY = 'That is enough messages for today. Try again tomorrow, and look in spam.';
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { callableFails: 'functions/resource-exhausted', callableMessage: DAY } });
    await q.waitForSelector('#oa-verify-send', { timeout: 15000 });
    await q.click('#oa-verify-send');
    await q.waitForFunction(() => /today|moment ago/.test((document.querySelector('#oa-verify-msg') || {}).textContent || ''),
      null, { timeout: 8000 });
    const th = await q.evaluate((uid) => ({
      msg: document.querySelector('#oa-verify-msg').textContent,
      fallback: window.__fb.at('sendEmailVerification', uid),
    }), UNVERIFIED.uid);
    eq(th.msg, DAY, 'verify: a daily-limit refusal reaches the card in the function\'s own words, not the 90-second sentence');
    eq(th.fallback, -1, 'verify: …and a throttle is never re-sent through Firebase');
    eq(errors, [], 'verify: no uncaught script error on the throttle path');
    await ctx.close();
  }
  {
    // a slow mailbox: the callable times out, and Firebase's message goes instead
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { callableFails: 'functions/deadline-exceeded' } });
    await q.waitForSelector('#oa-verify-send', { timeout: 15000 });
    await q.click('#oa-verify-send');
    await q.waitForFunction((uid) => window.__fb.at('sendEmailVerification', uid) >= 0,
      UNVERIFIED.uid, { timeout: 8000 });
    await q.waitForTimeout(200);
    const slow = await q.evaluate(() => ({ msg: document.querySelector('#oa-verify-msg').textContent }));
    ok(/Sent to newcomer@example\.edu/.test(slow.msg),
      'verify: a send that timed out falls back to Firebase\'s own message rather than reporting a failure');
    eq(errors, [], 'verify: no uncaught script error on the slow-send path');
    await ctx.close();
  }
  {
    // a refusal that is neither a throttle nor a reason to fall back: worded
    // as a send that failed, never as a sign-in failure with a raw code
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { callableFails: 'functions/permission-denied' } });
    await q.waitForSelector('#oa-verify-send', { timeout: 15000 });
    await q.click('#oa-verify-send');
    await q.waitForFunction(() => /could not|failed/i.test((document.querySelector('#oa-verify-msg') || {}).textContent || ''),
      null, { timeout: 8000 });
    const ref = await q.evaluate((uid) => ({
      msg: document.querySelector('#oa-verify-msg').textContent,
      fallback: window.__fb.at('sendEmailVerification', uid),
    }), UNVERIFIED.uid);
    ok(/We could not send the message just now/.test(ref.msg) && !/Sign-in failed/.test(ref.msg) && !/functions\//.test(ref.msg),
      'verify: a refused send is worded as one, with no "Sign-in failed" and no raw code');
    eq(ref.fallback, -1, 'verify: …and is not the fallback\'s business');
    eq(errors, [], 'verify: no uncaught script error on the refused path');
    await ctx.close();
  }
  {
    // the Functions bundle loads and defines nothing: the load-failure branch,
    // driven for real rather than read off the source
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { noFunctions: true } });
    await q.route('**/firebase-functions-compat.js', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* nothing */' }));
    await q.waitForSelector('#oa-verify-send', { timeout: 15000 });
    await q.click('#oa-verify-send');
    await q.waitForFunction((uid) => window.__fb.at('sendEmailVerification', uid) >= 0,
      UNVERIFIED.uid, { timeout: 8000 });
    await q.waitForTimeout(200);
    const nf = await q.evaluate((uid) => ({
      callable: window.__fb.at('callable', 'sendVerificationEmail'),
      fallback: window.__fb.at('sendEmailVerification', uid),
      from: (document.querySelector('#oa-verify-from') || {}).textContent,
      msg: (document.querySelector('#oa-verify-msg') || {}).textContent,
    }), UNVERIFIED.uid);
    ok(nf.callable === -1 && nf.fallback >= 0,
      'verify: with a Functions bundle that defined nothing, no callable is tried and Firebase\'s message goes');
    ok(/firebaseapp\.com/.test(nf.from) && /Sent to/.test(nf.msg),
      'verify: …and the sender line names Firebase\'s address');
    eq(errors, [], 'verify: no uncaught script error on the load-failure path');
    await ctx.close();
  }

  /* -- the archive's hint: a pending account is painted signed OUT --------- */
  {
    /* /v2/ is frozen and writes oaAuthHint for any signed-in user. The live
       pending branch writes a marker beside it, and the head snippet on every
       live page reads a hint naming that uid as no hint: measured on the
       FIRST value the snippet stamps, before any script of the page runs. */
    /* an init script runs before the document has an element to observe, so
       the stamp is caught where it is made: every setAttribute of that name */
    const observe = `
      window.__auth = [];
      (function () {
        var orig = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (n, v) {
          if (n === 'data-oa-auth') window.__auth.push(String(v));
          return orig.apply(this, arguments);
        };
      })();`;
    const hintFor = (u) => `localStorage.setItem('oaAuthHint', ${JSON.stringify(JSON.stringify({ uid: u.uid, email: u.email, name: 'X', w: 120 }))});`;
    {
      const { ctx, page: q, errors } = await signedInPage('jobs.html', {
        user: UNVERIFIED,
        init: hintFor(UNVERIFIED) + `localStorage.setItem('oaAuthPending', ${JSON.stringify(UNVERIFIED.uid)});` + observe,
      });
      await q.waitForSelector('#oa-verify-chip', { timeout: 15000 });
      await q.waitForTimeout(300);
      const h = await q.evaluate(() => ({
        first: window.__auth[0],
        now: document.documentElement.getAttribute('data-oa-auth'),
        hintFn: window.OAAccounts.hint(),
        hint: localStorage.getItem('oaAuthHint'),
        marker: localStorage.getItem('oaAuthPending'),
        locked: document.querySelectorAll('#oa-jobs .oa-card-locked').length,
        cards: document.querySelectorAll('#oa-jobs .oa-card').length,
      }));
      eq(h.first, 'out', 'archive hint: the head snippet paints a hint for a PENDING uid as signed out, on the first frame');
      ok(h.now === 'out' && h.hintFn === 'out' && h.hint === null && h.marker === UNVERIFIED.uid,
        'archive hint: …the pending branch then clears the hint and keeps the marker');
      ok(h.cards > 1 && h.locked === h.cards, 'archive hint: …and every card is locked');
      eq(errors, [], 'archive hint: no uncaught script error');
      await ctx.close();
    }
    {
      // the control: the same hint for a verified reader, no marker, paints in
      const { ctx, page: q, errors } = await signedInPage('jobs.html', { user: A_READER, init: hintFor(A_READER) + observe });
      const h = await q.evaluate(() => ({ first: window.__auth[0], marker: localStorage.getItem('oaAuthPending') }));
      eq(h.first, 'in', 'archive hint: a hint with no marker still paints signed in on the first frame');
      eq(h.marker, null, 'archive hint: …and a usable session writes no marker');
      eq(errors, [], 'archive hint: no uncaught script error on the control');
      await ctx.close();
    }
  }

  /* -- "I have verified it", once the link HAS been pressed: the lift ------- */
  {
    const { ctx, page: q, errors } = await signedInPage('jobs.html',
      { user: UNVERIFIED, seed: { reloadVerifies: true } });
    await q.waitForSelector('#oa-verify-check', { timeout: 15000 });
    await q.click('#oa-verify-check');
    await q.waitForSelector('#oa-chip', { timeout: 15000 });
    await q.waitForTimeout(500);
    const lifted = await q.evaluate((uid) => ({
      panel: !!document.querySelector('#oa-verify'),
      pendingChip: !!document.querySelector('#oa-verify-chip'),
      locked: document.querySelectorAll('#oa-jobs .oa-card-locked').length,
      auth: document.documentElement.getAttribute('data-oa-auth'),
      hint: (JSON.parse(localStorage.getItem('oaAuthHint') || 'null') || {}).uid,
      user: (window.OAAccounts.user() || {}).uid,
      token: window.__fb.at('getIdToken', uid + ':force'),
      reload: window.__fb.at('reload', uid),
      tally: window.__fb.ops('set').some((p) => p === 'registeredUsers/' + uid),
    }), UNVERIFIED.uid);
    ok(!lifted.panel && !lifted.pendingChip,
      'verify: once confirmed, the card closes and the pending chip goes');
    eq(lifted.locked, 0, 'verify: …every card unlocks');
    eq([lifted.auth, lifted.hint, lifted.user], ['in', UNVERIFIED.uid, UNVERIFIED.uid],
      'verify: …the session is an ordinary signed-in one: hint written, reserve in, user() answers');
    ok(lifted.token > lifted.reload,
      'verify: the lift refreshes the ID TOKEN after the reload, or the rules still read it unverified');
    ok(lifted.tally, 'verify: …and the session then does what a sign-in does (the tally is written)');
    eq(errors, [], 'verify: no uncaught script error on the lift');
    await ctx.close();
  }

  /* -- verify-email.html: where the link lands ------------------------------ */
  const LINK = 'verify-email.html?mode=verifyEmail&oobCode=AbC123xyz&continueUrl=' +
    encodeURIComponent('https://www.operationsacademia.org/account.html');

  {
    // the signed-in pending reader, whose link works. The registration form
    // stamps oaProfileAsked before any link can be pressed, so the fixture
    // does too; without it the first-run profile card opens the moment the
    // account is lifted and takes the focus this block measures.
    const { ctx, page: q, errors } = await signedInPage(LINK,
      { user: UNVERIFIED, seed: { reloadVerifies: true }, selector: '#main',
        init: `localStorage.setItem('oaProfileAsked:${UNVERIFIED.uid}', '1');` });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    await q.waitForTimeout(300);
    const done = await q.evaluate((uid) => ({
      h2: document.querySelector('#ve-done h2').textContent,
      cont: document.querySelector('#ve-continue'),
      contShown: !document.querySelector('#ve-continue').hidden,
      contHref: document.querySelector('#ve-continue').getAttribute('href'),
      signinShown: !document.querySelector('#ve-signin').hidden,
      applied: window.__fb.log.find((e) => e.op === 'applyActionCode'),
      reload: window.__fb.at('reload', uid),
      panel: !!document.querySelector('#oa-verify'),
      chip: !!document.querySelector('#oa-chip'),
      user: (window.OAAccounts.user() || {}).uid,
      others: ['ve-wait', 've-error', 've-nocode'].filter((id) => !document.getElementById(id).hidden),
      focusIn: document.getElementById('ve-done').contains(document.activeElement),
      focusTag: document.activeElement && document.activeElement.tagName,
      url: location.search,
      note: document.getElementById('ve-done-note').textContent,
    }), UNVERIFIED.uid);
    eq(done.h2, 'Your e-mail address is verified', 'verify page: a working link shows the verified state');
    ok(done.focusIn && done.focusTag === 'H2',
      'verify page: …and the keyboard lands on its heading, so a screen reader hears the outcome');
    eq(done.url, '', 'verify page: the one-time code is off the address bar');
    ok(/ready to use/.test(done.note), 'verify page: the card\'s own note stands for a confirmed account');
    ok(done.contShown && done.contHref === 'account.html' && !done.signinShown,
      'verify page: …with Continue to your account for the signed-in reader');
    ok(done.applied && done.applied.path === 'AbC123xyz',
      'verify page: the code on the address is the one applied');
    ok(done.reload >= 0 && done.user === UNVERIFIED.uid && done.chip,
      'verify page: the pending account is reloaded and lifted, so the chip shows the name');
    ok(!done.panel, 'verify page: the "Check your inbox" card is never drawn over this page');
    eq(done.others, [], 'verify page: the other three cards stay hidden');
    eq(errors, [], 'verify page: no uncaught script error');
    await ctx.close();
  }
  {
    // …and for that reader the confirmation is a BOX in the middle of the
    // screen (owner, 2026-09-05): the hero and the footer line go, a line
    // counts the seconds down, and after five the page moves on to the
    // account by itself, replacing the spent link
    const { ctx, page: q, errors } = await signedInPage(LINK,
      { user: UNVERIFIED, seed: { reloadVerifies: true }, selector: '#main',
        init: `localStorage.setItem('oaProfileAsked:${UNVERIFIED.uid}', '1');` });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    const box = await q.evaluate(() => {
      const card = document.getElementById('ve-done').getBoundingClientRect();
      const hero = document.querySelector('.v3-pa-hero');
      const shown = (el) => !!el && el.getBoundingClientRect().height > 0;
      return {
        focus: document.body.classList.contains('ve-focus'),
        heroShown: shown(hero),
        footShown: [...document.querySelectorAll('.ve-foot')].some(shown),
        count: document.getElementById('ve-count').textContent,
        countShown: !document.getElementById('ve-count').hidden,
        offCentre: Math.abs((card.top + card.bottom) / 2 - window.innerHeight / 2),
        header: shown(document.querySelector('.v3-header')),
      };
    });
    ok(box.focus && !box.heroShown && !box.footShown && box.header,
      'verify page: once confirmed, the page is the box under the header and nothing else');
    ok(box.offCentre < 90, 'verify page: …and the box sits in the middle of the screen (' + Math.round(box.offCentre) + 'px off)');
    ok(box.countShown && /Taking you to your account in [1-5] seconds?\./.test(box.count),
      'verify page: …saying it will move on in a few seconds');
    eq(errors, [], 'verify page: no uncaught script error while the box counts down');
    await q.waitForURL(/account\.html$/, { timeout: 9000 });
    ok(true, 'verify page: after five seconds the reader is on the account page without pressing anything');
    await ctx.close();
  }
  {
    /* THE COUNTDOWN STANDS DOWN UNDER THE FIRST-RUN PROFILE CARD. The lift
       that confirms the address also opens the accounts module's Welcome
       dialog for an account with no profile yet, asking for a name and a
       photo; the page used to replace itself under it four seconds later and
       throw the half-typed profile away. This is the fixture above WITHOUT
       the oaProfileAsked mark that kept the dialog shut. */
    const { ctx, page: q, errors } = await signedInPage(LINK,
      { user: UNVERIFIED, seed: { reloadVerifies: true }, selector: '#main' });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    await q.waitForSelector('#oa-profile [aria-modal="true"]', { timeout: 15000 });
    await q.waitForFunction(() => /Press Continue when you are ready/.test(document.getElementById('ve-count').textContent), null, { timeout: 8000 });
    await q.waitForTimeout(6000);
    const held = await q.evaluate(() => ({
      here: /verify-email\.html/.test(location.pathname),
      modal: !!document.querySelector('#oa-profile [aria-modal="true"]'),
      cont: !document.getElementById('ve-continue').hidden,
    }));
    ok(held.here && held.modal, 'verify page: with the profile card open the page is NOT replaced after five seconds');
    ok(held.cont, 'verify page: and Continue stays for when the reader is done with it');
    eq(errors, [], 'verify page: no uncaught script error while the countdown stands down');
    await ctx.close();
  }
  {
    // a reader with no session at all (the commonest case: the link opened in
    // another browser) still gets the confirmation, and a way to sign in
    const { ctx, page: q, errors } = await signedOutPage(LINK, { selector: '#main' });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    const out = await q.evaluate(() => ({
      contShown: !document.querySelector('#ve-continue').hidden,
      signinShown: !document.querySelector('#ve-signin').hidden,
    }));
    ok(!out.contShown && out.signinShown, 'verify page: signed out, the verified state offers Sign in instead');
    await q.click('#ve-signin');
    await q.waitForSelector('#oa-auth', { timeout: 8000 });
    ok(true, 'verify page: …which opens the sign-in box');
    eq(errors, [], 'verify page: no uncaught script error signed out');
    await ctx.close();
  }
  {
    // …and signing in THROUGH that box changes the card: Continue appears,
    // Sign in goes, with no reload (the page listens for the session)
    const { ctx, page: q, errors } = await signedOutPage(LINK,
      { seed: { signInUser: A_READER }, selector: '#main' });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    await q.click('#ve-signin');
    await q.waitForSelector('#oa-auth-form', { timeout: 8000 });
    await q.fill('#oa-auth-form [name="email"]', A_READER.email);
    await q.fill('#oa-auth-form [name="password"]', 'secret-1');
    await q.$eval('#oa-auth-form', (f) => f.requestSubmit());
    await q.waitForFunction(() => !document.querySelector('#ve-continue').hidden, null, { timeout: 8000 });
    const si = await q.evaluate(() => ({
      signinShown: !document.querySelector('#ve-signin').hidden,
      box: !!document.querySelector('#oa-auth'),
      user: (window.OAAccounts.user() || {}).uid,
    }));
    ok(!si.signinShown && si.user === A_READER.uid && !si.box,
      'verify page: after signing in on the verified card, Continue is offered and Sign in is gone');
    eq(errors, [], 'verify page: no uncaught script error signing in on the card');
    await ctx.close();
  }
  {
    // the code applied, but THIS account is still unconfirmed after its reload:
    // the link belonged to another address, and Continue would lead to a
    // locked account page
    const { ctx, page: q, errors } = await signedInPage(LINK, { user: UNVERIFIED, selector: '#main' });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    await q.waitForTimeout(200);
    const mm = await q.evaluate(() => ({
      note: document.getElementById('ve-done-note').textContent,
      contShown: !document.querySelector('#ve-continue').hidden,
      signinShown: !document.querySelector('#ve-signin').hidden,
      signinText: document.querySelector('#ve-signin').textContent,
      chip: (document.querySelector('#oa-verify-chip') || {}).textContent,
      pending: (window.OAAccounts.pendingUser() || {}).uid,
      applied: window.__fb.log.some((e) => e.op === 'applyActionCode'),
    }));
    ok(mm.applied && /not the one this account uses/.test(mm.note),
      'verify page: a code that applied while this account stays unconfirmed says the link was another address\'s');
    ok(!mm.contShown && mm.signinShown && mm.signinText === 'Use a different account',
      'verify page: …offers a different account, never Continue into a locked account page');
    ok(mm.chip === 'Verify your e-mail' && mm.pending === UNVERIFIED.uid,
      'verify page: …and the account here stays pending');
    await q.click('#ve-signin');
    await q.waitForSelector('#oa-auth', { timeout: 8000 });
    const out2 = await q.evaluate((uid) => ({
      pending: window.OAAccounts.pendingUser(),
      signedOut: window.__fb.at('signOut', '[DEFAULT]') >= 0,
      note: document.getElementById('ve-done-note').textContent,
      panel: !!document.querySelector('#oa-verify'),
    }), UNVERIFIED.uid);
    ok(out2.pending === null && out2.signedOut && !out2.panel && /ready to use/.test(out2.note),
      'verify page: pressing it signs the pending account out and opens the sign-in box, and the card re-decides its note');
    eq(errors, [], 'verify page: no uncaught script error on the mismatch path');
    await ctx.close();
  }
  {
    // an expired link, with the unconfirmed account signed in: say what
    // happened, and offer a new one that goes through the same send path
    const { ctx, page: q, errors } = await signedInPage(LINK,
      { user: UNVERIFIED, seed: { applyActionCodeFails: 'auth/expired-action-code' }, selector: '#main' });
    await q.waitForSelector('#ve-error', { state: 'visible', timeout: 15000 });
    const err = await q.evaluate(() => ({
      why: document.querySelector('#ve-error-why').textContent,
      resendShown: !document.querySelector('#ve-resend').hidden,
      hintShown: !document.querySelector('#ve-error-hint').hidden,
      done: !document.getElementById('ve-done').hidden,
      panel: !!document.querySelector('#oa-verify'),
      chip: (document.querySelector('#oa-verify-chip') || {}).textContent,
    }));
    ok(/expired/i.test(err.why) && !err.done, 'verify page: an expired link says so, in the accounts module\'s words');
    ok(err.resendShown && !err.hintShown, 'verify page: …and offers "Send me a new link" to the unconfirmed account');
    ok(!err.panel && err.chip === 'Verify your e-mail',
      'verify page: the account stays pending (chip), and still no card over the page');
    await q.click('#ve-resend');
    await q.waitForFunction(() => window.__fb.at('callable', 'sendVerificationEmail') >= 0,
      null, { timeout: 8000 });
    await q.waitForTimeout(200);
    ok(/Sent to newcomer@example\.edu/.test(await q.$eval('#ve-msg', (n) => n.textContent)),
      'verify page: pressing it sends through the same function the card uses, and says so');
    /* the chip is the one account control in the header, and on this page a
       press on it must still do something: it opens the card, which the page
       otherwise never draws on its own */
    await q.click('#oa-verify-chip');
    await q.waitForSelector('#oa-verify', { timeout: 8000 });
    const pressed = await q.evaluate(() => ({
      heading: document.querySelector('#oa-verify h3').textContent,
      focusIn: document.querySelector('#oa-verify').contains(document.activeElement),
    }));
    ok(pressed.heading === 'Check your inbox' && pressed.focusIn,
      'verify page: a PRESS on the header chip opens the card here too, with focus inside it');
    await q.keyboard.press('Escape');
    await q.waitForFunction(() => !document.querySelector('#oa-verify'), null, { timeout: 8000 });
    eq(await q.evaluate(() => document.activeElement && document.activeElement.id), 'oa-verify-chip',
      'verify page: …and Escape closes it with the keyboard back on the chip');
    /* Tab stays inside the card while it is open */
    await q.click('#oa-verify-chip');
    await q.waitForSelector('#oa-verify', { timeout: 8000 });
    await q.focus('#oa-verify-out');
    await q.keyboard.press('Tab');
    const tabbed = await q.evaluate(() => document.querySelector('#oa-verify').contains(document.activeElement));
    ok(tabbed, 'verify page: Tab from the card\'s last control wraps to its first rather than leaving the dialog');
    await q.keyboard.press('Escape');
    eq(errors, [], 'verify page: no uncaught script error on the expired path');
    await ctx.close();
  }
  {
    // an invalid link, signed out: no account to resend for, so say what to do
    const { ctx, page: q, errors } = await signedOutPage(LINK,
      { seed: { applyActionCodeFails: 'auth/invalid-action-code' }, selector: '#main' });
    await q.waitForSelector('#ve-error', { state: 'visible', timeout: 15000 });
    const err = await q.evaluate(() => ({
      why: document.querySelector('#ve-error-why').textContent,
      resendShown: !document.querySelector('#ve-resend').hidden,
      hint: document.querySelector('#ve-error-hint'),
      hintShown: !document.querySelector('#ve-error-hint').hidden,
      hintText: document.querySelector('#ve-error-hint').textContent,
    }));
    ok(/not valid any more/.test(err.why), 'verify page: an invalid link says so');
    ok(!err.resendShown && err.hintShown && /sign in with your e-mail/i.test(err.hintText),
      'verify page: …and, signed out, says to sign in with the e-mail and password to get a new one');
    eq(errors, [], 'verify page: no uncaught script error on the invalid path');
    await ctx.close();
  }
  {
    // no code at all: Firebase's own fallback handler applies the code and
    // then lands here, so a pending account is reloaded and shown verified
    const { ctx, page: q, errors } = await signedInPage('verify-email.html',
      { user: UNVERIFIED, seed: { reloadVerifies: true }, selector: '#main' });
    await q.waitForSelector('#ve-done', { state: 'visible', timeout: 15000 });
    const nc = await q.evaluate((uid) => ({
      applied: window.__fb.log.some((e) => e.op === 'applyActionCode'),
      reload: window.__fb.at('reload', uid),
      user: (window.OAAccounts.user() || {}).uid,
    }), UNVERIFIED.uid);
    ok(!nc.applied && nc.reload >= 0 && nc.user === UNVERIFIED.uid,
      'verify page: with no code, a signed-in account is reloaded rather than refused, and lifted');
    eq(errors, [], 'verify page: no uncaught script error with no code, signed in');
    await ctx.close();
  }
  {
    // no code, signed out: a short explanation and a Sign in button
    const { ctx, page: q, errors } = await signedOutPage('verify-email.html', { selector: '#main' });
    await q.waitForSelector('#ve-nocode', { state: 'visible', timeout: 15000 });
    const nc = await q.evaluate(() => ({
      why: document.querySelector('#ve-nocode-why').textContent,
      signin: !document.querySelector('#ve-nocode-signin').hidden,
      resend: !document.querySelector('#ve-nocode-resend').hidden,
    }));
    ok(/link in the message/.test(nc.why) && nc.signin && !nc.resend,
      'verify page: with no code and no session, it explains itself and offers Sign in');
    eq(errors, [], 'verify page: no uncaught script error with no code, signed out');
    await ctx.close();
  }

  /* -- the 390px gate for the new page, both readers ------------------------ */
  for (const [label, opts] of [
    ['signed out', { user: null }],
    ['pending', { user: UNVERIFIED, seed: { applyActionCodeFails: 'auth/expired-action-code' } }],
  ]) {
    const { ctx, page: m, errors } = await signedInPage(LINK,
      { ...opts, selector: '#main', viewport: { width: 390, height: 844 } });
    await m.waitForFunction(() => document.getElementById('ve-wait').hidden, null, { timeout: 15000 });
    await m.waitForTimeout(300);
    const r = await m.evaluate(() => {
      const btns = [...document.querySelectorAll('#main .v3-btn')]
        .filter((b) => !b.hidden && b.getBoundingClientRect().height > 0);
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        buttons: btns.length,
        short: btns.filter((b) => b.getBoundingClientRect().height < 42).map((b) => b.id),
        wide: btns.filter((b) => b.getBoundingClientRect().right > window.innerWidth).map((b) => b.id),
      };
    });
    eq(r.overflowX, 0, `verify page (${label}): no sideways scroll at 390px`);
    ok(r.buttons > 0, `verify page (${label}): a button is on screen to measure`);
    eq(r.short, [], `verify page (${label}): every button is a 42px target`);
    eq(r.wide, [], `verify page (${label}): …and none runs off the screen`);
    eq(errors, [], `verify page (${label}): no uncaught script error at 390px`);
    await ctx.close();
  }
}

/* ---------------------------------------------------------- the forum

   forum.html, driven end to end through the shim's forum simulator
   (_fake-firebase.js, forumSim): the six callables answer over the fake
   Firestore, so what is measured here is what the PAGE does with a real
   answer, never the functions themselves (those are the emulator test's).
   Five readers, in the order the gate meets them: signed out (the sign-in
   card and nothing forum-shaped), an unverified password account (the verify
   prompt, no callable), a verified account with no profile (the Open tab
   alone and the one line naming the other room), a seeded current candidate
   (both tabs, a question with two tags, a reply with a quote, an edit, the
   votes with their counts, and the LEAK CHECK: none of the seeded uid,
   address, name, affiliation or profile id anywhere in #main, where the
   forum's markup is; the header's account chip prints the account's own name
   and address on every page by design, so the uid and the profile id are
   also checked over the WHOLE document), the maintainer with no profile
   (both tabs, the guide seeded through forumModerate, a post landing under a
   random handle and never Moderator), then an archived season (read-only: no
   Ask, no vote buttons, no reply box, no forumThreadVotes call), and the
   390px block rule 13 in _MOBILE-STANDARDS.md is measured by. */
{
  const FY = marketYear();
  const CAND = { uid: 'cand-uid-0000000000001', email: 'zyxwvut@example.edu', emailVerified: true,
    displayName: 'Cassiopeia Zyxwvut', providerData: [] };
  const CAND_PROFILE = { path: 'candidateSubmissions/forum-c1', data: {
    uid: CAND.uid, status: 'queued', year: FY, first: 'Cassiopeia', last: 'Zyxwvut', email: CAND.email,
    affiliation: 'Uncommon University of Somewhere', position: 'PhD Candidate', createdAt: 1700000000000 } };
  const T = `forumSeasons/${FY}/rooms/candidates/threads`;
  const OLD = Date.now() - 3 * 24 * 3600 * 1000 - ((Date.now() - 3 * 24 * 3600 * 1000) % 60000);
  const HOSTILE_TITLE = 'Flyout <b>tips</b> for Europe';
  const HOSTILE_BODY = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> Congratulations on the flyout, ask about the teaching load early.';
  /* a thread by SOMEBODY ELSE, so the candidate has a post to vote on (the
     simulator refuses a vote on one's own post, as the function does), and a
     hostile title and body to render inert */
  const SEEDED = [
    { path: `forumSeasons/${FY}`, data: { season: FY, createdAt: OLD, secretVersion: 'env', guides: {} } },
    { path: `${T}/seed-t1`, data: { season: FY, room: 'candidates', title: HOSTILE_TITLE, tags: ['flyouts', 'europe'],
      by: 'patient owl 7', t: OLD, lastAt: OLD, lastBy: 'patient owl 7', n: 1, excerpt: 'Congratulations on the flyout',
      score: 0, pinned: false, locked: false, hidden: false } },
    { path: `${T}/seed-t1/posts/seed-p1`, data: { season: FY, room: 'candidates', tid: 'seed-t1', n: 1, by: 'patient owl 7',
      body: HOSTILE_BODY, t: OLD, up: 0, down: 0, quote: null, hidden: false, hiddenBy: '' } },
    { path: `forumTags/${FY}_candidates`, data: { counts: { flyouts: 1, europe: 1 } } },
  ];
  const LEAKS = [CAND.uid, CAND.email, 'Cassiopeia', 'Zyxwvut', 'Uncommon University', 'forum-c1'];
  const leakCheck = (q) => q.evaluate((needles) => {
    const main = document.querySelector('#main').outerHTML;
    const whole = document.documentElement.outerHTML;
    return {
      main: needles.filter((n) => main.includes(n)),
      whole: needles.filter((n, i) => (i === 0 || i === needles.length - 1) && whole.includes(n)),
    };
  }, LEAKS);
  const tabs = (q) => q.$$eval('#oa-forum-rooms .oa-forum-tab', (ns) => ns.map((n) => n.getAttribute('data-room')));
  const calls = (q, name) => q.evaluate((n) => window.__fb.log.filter((e) => e.op === 'callable' && e.path === n).map((e) => e.data), name);

  /* -- signed out: the sign-in card, and nothing forum-shaped -------------- */
  {
    const { ctx, page: q, errors } = await signedOutPage('forum.html', { selector: '#oa-needauth' });
    const st = await q.evaluate(() => ({
      card: !document.getElementById('oa-needauth').hidden,
      app: document.getElementById('oa-forum').hidden,
      verify: document.getElementById('oa-forum-verify').hidden,
      cards: document.querySelectorAll('.oa-card, .oa-forum-post, .oa-forum-handle').length,
      callables: window.__fb.ops('callable').length,
      btn: document.getElementById('oa-needauth-btn').textContent,
    }));
    ok(st.card && st.app && st.verify, 'forum (signed out): the sign-in card shows, the app and the verify prompt stay hidden');
    eq(st.cards, 0, 'forum (signed out): no thread, post or handle markup in the document');
    eq(st.callables, 0, 'forum (signed out): no callable is made for a reader who is not signed in');
    ok(/Sign in/.test(st.btn), 'forum (signed out): the card offers the sign-in box');
    await q.click('#oa-needauth-btn');
    await q.waitForSelector('#oa-auth', { timeout: 8000 });
    ok(true, 'forum (signed out): pressing it opens the sign-in box');
    eq(errors, [], 'forum (signed out): no uncaught script error');
    await ctx.close();
  }

  /* -- unverified: the verify prompt, no callable ------------------------- */
  {
    const UNV = { uid: 'unverified-uid-00002', email: 'pending@example.edu', displayName: '',
      emailVerified: false, providerData: [{ providerId: 'password' }] };
    const { ctx, page: q, errors } = await signedInPage('forum.html', { user: UNV, selector: '#oa-forum-verify' });
    await q.waitForSelector('#oa-verify-chip', { timeout: 15000 });
    const st = await q.evaluate(() => ({
      prompt: !document.getElementById('oa-forum-verify').hidden,
      app: document.getElementById('oa-forum').hidden,
      needauth: document.getElementById('oa-needauth').hidden,
      callables: window.__fb.ops('callable'),
    }));
    ok(st.prompt && st.app && st.needauth, 'forum (unverified): the verify prompt shows, the app and the sign-in card stay hidden');
    eq(st.callables, [], 'forum (unverified): forumJoin is never called for a pending account');
    /* the accounts module opens the "Check your inbox" card on its own for a
       pending account; the page's button is for after it has been closed */
    await q.waitForSelector('#oa-verify', { timeout: 8000 });
    await q.keyboard.press('Escape');
    await q.waitForFunction(() => !document.querySelector('#oa-verify'), null, { timeout: 8000 });
    await q.click('#oa-forum-verify-btn');
    await q.waitForSelector('#oa-verify', { timeout: 8000 });
    ok(true, 'forum (unverified): the card opens on its own, and the page\'s button opens it again once closed');
    eq(errors, [], 'forum (unverified): no uncaught script error');
    await ctx.close();
  }

  /* -- a verified account with no profile: the Open tab alone ------------- */
  {
    const { ctx, page: q, errors } = await signedInPage('forum.html', { selector: '#oa-forum' });
    eq(await tabs(q), ['open'], 'forum (no profile): only the Open forum tab is drawn');
    const st = await q.evaluate(() => ({
      note: document.getElementById('oa-forum-roomnote').hidden ? '' : document.getElementById('oa-forum-roomnote').textContent,
      banner: document.getElementById('oa-forum-me').className,
      handle: document.getElementById('oa-forum-myhandle').textContent,
      joined: window.__fb.ops('callable'),
    }));
    ok(/Candidates’ room opens to accounts holding a candidate profile/.test(st.note) && st.note.includes(`${FY - 1}-${FY}`),
      'forum (no profile): the one line says what opens the other room, naming the season');
    ok(/is-open/.test(st.banner), 'forum (no profile): the room banner is the Open forum\'s');
    eq(st.handle, 'quiet heron 42', 'forum (no profile): the handle the simulator drew is what the banner prints');
    eq(st.joined, ['forumJoin'], 'forum (no profile): one forumJoin, and nothing else, on entry');
    const leak = await leakCheck(q);
    eq(leak.main, [], 'forum (no profile): nothing of a stranger\'s seeded profile is on the page (there is none)');
    eq(errors, [], 'forum (no profile): no uncaught script error');
    await ctx.close();
  }

  /* -- a seeded current candidate: both tabs, then the whole conversation -- */
  {
    const { ctx, page: q, errors } = await signedInPage('forum.html',
      { user: CAND, docs: [CAND_PROFILE, ...SEEDED], selector: '#oa-forum' });
    eq(await tabs(q), ['candidates', 'open'], 'forum (candidate): both tabs are drawn');
    eq(await q.$eval('#oa-forum-rooms .oa-forum-tab[aria-selected="true"]', (n) => n.getAttribute('data-room')), 'candidates',
      'forum (candidate): the Candidates\' room is the one on screen by default');
    ok(await q.evaluate(() => document.getElementById('oa-forum-roomnote').hidden), 'forum (candidate): no "what opens the other room" line');
    ok(await q.evaluate((uid) => !!window.__fb.docs['candidateMarkers/' + uid], CAND.uid),
      'forum (candidate): the join wrote the membership marker the rules re-read');

    /* the list: the seeded question, its tag chips, hostile title inert */
    await q.waitForSelector('#oa-forum-list .oa-card', { timeout: 15000 });
    const list = await q.evaluate(() => {
      const card = document.querySelector('#oa-forum-list .oa-card');
      return {
        n: document.querySelectorAll('#oa-forum-list .oa-card').length,
        title: card.querySelector('.oa-card-title').textContent,
        bold: card.querySelectorAll('.oa-card-title b').length,
        tags: [...card.querySelectorAll('.oa-label-tag')].map((b) => b.getAttribute('data-tag')),
        sub: card.querySelector('.oa-card-sub').textContent,
        likes: card.querySelector('.oa-forum-stat b').textContent,
        filterLabels: [...document.querySelectorAll('#oa-forum-list .oa-filter > label')].map((n) => n.textContent),
        count: document.getElementById('oa-forum-listcount').textContent,
        cloud: [...document.querySelectorAll('#oa-forum-tags a')].map((a) => a.getAttribute('data-tag')),
        ask: !!document.getElementById('oa-forum-askbtn'),
      };
    });
    eq(list.n, 1, 'forum (candidate): the seeded question is listed');
    ok(list.title === HOSTILE_TITLE && list.bold === 0, 'forum (candidate): a title carrying markup is printed as text');
    eq(list.tags, ['flyouts', 'europe'], 'forum (candidate): the card carries its tag chips');
    ok(/patient owl 7/.test(list.sub), 'forum (candidate): the footer names the asking handle');
    eq(list.likes, '0', 'forum (candidate): and the tally column carries the first post\'s net score');
    /* THE STACK OVERFLOW ARRANGEMENT (owner, 2026-09-05), measured as
       geometry rather than as a class list, so it survives a change of
       markup: a tally column to the LEFT of the title, the tags BELOW the
       excerpt where they cannot crowd the heading (the collision the owner
       reported the same day), no two chips overlapping, and the ANSWER count
       said once. There are no comments anywhere in this forum and there is no
       plan for any (owner, 2026-09-05), so a card says questions and answers
       and nothing else. */
    const geom = await q.evaluate(() => {
      const card = document.querySelector('#oa-forum-list .oa-card');
      const box = (n) => { const r = n.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width }; };
      const chips = [...card.querySelectorAll('.oa-badges .oa-label')].map(box);
      const title = box(card.querySelector('.oa-card-title'));
      const stats = box(card.querySelector('.oa-forum-stats'));
      const ex = box(card.querySelector('.oa-forum-ex'));
      const sub = box(card.querySelector('.oa-card-sub'));
      let clash = 0;
      for (let i = 0; i < chips.length; i++) {
        for (let j = i + 1; j < chips.length; j++) {
          const a = chips[i], b = chips[j];
          if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) clash++;
        }
        if (chips[i].t < ex.b - 0.5) clash++;
        if (stats.l < chips[i].r && chips[i].l < stats.r && stats.t < chips[i].b && chips[i].t < stats.b) clash++;
      }
      const chipStyle = getComputedStyle(card.querySelector('.oa-badges .oa-label'));
      return {
        chips: chips.length, clash,
        tallyLeft: stats.r <= title.l + 0.5 && stats.t <= title.t + 40,
        footRow: Math.abs(sub.b - chips[chips.length - 1].b) < 40 && sub.l > chips[0].l,
        answers: (card.textContent.match(/answers?/g) || []).length,
        replies: (card.textContent.match(/repl(y|ies)/g) || []).length,
        comments: (card.textContent.match(/comment/gi) || []).length,
        chipFont: parseFloat(chipStyle.fontSize),
        chipHeight: Math.max(...chips.map((c) => c.b - c.t)),
      };
    });
    ok(geom.chips >= 2, `forum (candidate): the card carries a tag row of more than one chip, which is what could collide (${geom.chips})`);
    eq(geom.clash, 0, 'forum (candidate): no two chips overlap, none reaches up into the excerpt, and none runs into the tally column');
    ok(geom.tallyLeft, 'forum (candidate): the tally column sits to the LEFT of the title, the arrangement the owner asked for');
    ok(geom.footRow, 'forum (candidate): the tags and who asked share the footer, tags left and asker right');
    /* AND THE CHIPS IN IT ARE REAL LINKS, not spans inside the head <button>:
       a control inside a button is not markup a browser will make focusable,
       so they were reachable by pointer and by nothing else. */
    const chip = await q.evaluate(() => {
      const c = document.querySelector('#oa-forum-list .oa-forum-qfoot .oa-label-tag');
      if (!c) return null;
      return { tag: c.tagName, href: c.getAttribute('href') || '', inButton: !!c.closest('.oa-card-head') };
    });
    ok(chip && chip.tag === 'A' && /^forum\.html\?/.test(chip.href) && !chip.inButton,
      `forum (candidate): a card's tag chip is a link beside the head button, not a span inside it (${JSON.stringify(chip)})`);
    eq(geom.answers, 1, 'forum (candidate): and the answer count is printed once, in the tally');
    eq(geom.replies, 0, 'forum (candidate): the card says answers, never replies');
    eq(geom.comments, 0, 'forum (candidate): and offers no comment on anything, which is the whole model');
    /* smaller and lighter than the site's default label, which is 700-weight
       at 12.5px and reads as crowded when four sit in a row under a question
       (owner, 2026-09-05: "the tags still look cramped, make them smaller") */
    ok(geom.chipFont <= 12 && geom.chipHeight <= 22,
      `forum (candidate): the tag chips are small, not the site's chunky badge (${geom.chipFont}px, ${Math.round(geom.chipHeight)}px tall)`);
    eq(list.filterLabels, ['Tags', 'Search questions'], 'forum (candidate): the list engine draws the tag filter and the text search');
    eq(list.count, '1 question this season', 'forum (candidate): the count line');
    eq(list.cloud.sort(), ['europe', 'flyouts'], 'forum (candidate): the Popular tags card is drawn from the tally');
    ok(list.ask, 'forum (candidate): Ask a question is offered');
    /* THE LIST AS A MEMBER SEES IT, with cards on it and the tag cloud beside
       them. The maintainer's own list is audited further down and holds only
       the guide, so the card's own surfaces and the chips went unmeasured.

       The seen-mark is wound back first so the New badge is actually DRAWN:
       `since` is stamped when the account joins, so nothing posted before that
       is ever new, and the badge could not otherwise be measured at all. The
       store is per account and the next thread opened rewrites it. */
    await q.evaluate((uid) => localStorage.setItem('oa-forum-seen',
      JSON.stringify({ uid, since: 0, seen: {} })), CAND.uid);
    /* out of the room and back, because the list reads the mark when it is
       DRAWN and pressing the tab it is already on redraws nothing */
    await q.click('#oa-forum-rooms .oa-forum-tab[data-room="open"]');
    await q.waitForFunction(() => /room=open/.test(location.search), null, { timeout: 15000 });
    await q.click('#oa-forum-rooms .oa-forum-tab[data-room="candidates"]');
    await q.waitForSelector('#oa-forum-list .oa-card', { timeout: 15000 });
    await forumContrast(q, 'the candidate list');

    /* A PAINT THAT LANDS AFTER THE READER HAS MOVED MUST NOT WRITE THE VIEW
       THEY MOVED TO. The list, a thread and the ask form are three views of
       one page swapped with pushState, and each paints from a read still in
       flight when the reader goes on. renderThread ends by showing
       #oa-forum-compose, which is a SIBLING of the thread rather than a child
       of it, so a thread read landing after the reader pressed Back drew a
       whole "Your answer" editor under the list of questions, wired to an
       empty thread id: pressing Post asked the server to open a question with
       no title. The list mount's own guard could not see it, because it
       compared the ROOM and the SEASON and opening a thread changes neither.

       The shim HOLDS the thread's reads for this, which is the only way to be
       the reader who pressed Back while it was loading; the list's own query
       is on `.../threads` with no trailing slash, so it is not held and the
       page really does come back. */
    await q.evaluate(() => { window.__fb.holdReads = ['/threads/']; });
    await q.click('#oa-forum-list .oa-card .oa-card-head');
    await q.evaluate(() => { window.__fb.holdReads = []; history.back(); });
    await q.waitForFunction(() => {
      const l = document.getElementById('oa-forum-listview');
      return l && !l.hidden && l.querySelector('.oa-card');
    }, null, { timeout: 15000 });
    const late = await q.evaluate(() => window.__fb.release());
    ok(late > 0, `forum (candidate): the thread's reads were really held (${late} of them)`);
    await q.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    const stray = await q.evaluate(() => {
      const c = document.getElementById('oa-forum-compose');
      const w = document.getElementById('oa-forum-watchnew');
      const t = document.getElementById('oa-forum-thread');
      return {
        compose: !!c && !c.hidden,
        composeText: c ? c.textContent.trim().slice(0, 40) : '',
        watch: !!w && !w.hidden,
        thread: !!t && !t.hidden,
        list: !document.getElementById('oa-forum-listview').hidden,
      };
    });
    ok(stray.list, 'forum (candidate): pressing Back while a thread loads comes back to the list');
    ok(!stray.compose,
      `forum (candidate): and the late thread paint draws no answer box over it (${stray.composeText})`);
    ok(!stray.thread, 'forum (candidate): nor re-opens the thread the reader left');
    ok(!stray.watch, 'forum (candidate): and no banner from a superseded read is unhidden over it');

    /* open the seeded thread: hostile body inert, votes up, down, withdrawn */
    await q.click('#oa-forum-list .oa-card .oa-card-head');
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const th = await q.evaluate(() => ({
      url: location.search,
      title: document.getElementById('oa-forum-title').textContent,
      pwned: window.__pwned,
      injected: document.querySelectorAll('.oa-forum-text img, .oa-forum-text script').length,
      text: document.querySelector('.oa-forum-text').textContent,
      kinds: document.querySelectorAll('.oa-forum-kind, .oa-forum-kinds').length,
      votes: document.querySelectorAll('.oa-forum-post.is-first .oa-forum-v:not([disabled])').length,
      score: document.querySelector('.oa-forum-score').textContent,
      updown: document.querySelector('.oa-forum-updown').textContent,
      threadVotes: window.__fb.ops('callable').filter((n) => n === 'forumThreadVotes').length,
      reply: !!document.getElementById('oa-forum-body'),
    }));
    ok(/[?&]t=seed-t1/.test(th.url) && /room=candidates/.test(th.url), 'forum (candidate): a card opens its thread in place, on its own address');
    eq(th.title, HOSTILE_TITLE, 'forum (candidate): the thread heading prints the title as text');
    ok(th.pwned === undefined && th.injected === 0 && th.text.includes('<img src=x'),
      'forum (candidate): a hostile body renders as text, nothing executes');
    eq(th.kinds, 0, 'forum (candidate): no post declares a kind and no compose box asks for one (the control was removed, owner 2026-09-05)');
    eq(th.votes, 2, 'forum (candidate): another member\'s post offers like and dislike');
    ok(th.score === '0' && th.updown === '0 / 0', 'forum (candidate): the counts start at nought');
    eq(th.threadVotes, 1, 'forum (candidate): the caller\'s own votes are asked for once when the thread opens');
    ok(th.reply, 'forum (candidate): the reply box is drawn');

    await q.click('.oa-forum-post.is-first .oa-forum-v.up');
    await q.waitForFunction(() => document.querySelector('.oa-forum-updown').textContent === '1 / 0', null, { timeout: 8000 });
    const v1 = await q.evaluate(() => ({
      score: document.querySelector('.oa-forum-score').textContent,
      pressed: document.querySelector('.oa-forum-post.is-first .oa-forum-v.up').getAttribute('aria-pressed'),
      doc: window.__fb.docs['forumSeasons/' + new Date().getUTCFullYear() + '/rooms/candidates/threads/seed-t1'],
    }));
    eq(v1.score, '+1', 'forum (candidate): a like shows +1');
    eq(v1.pressed, 'true', 'forum (candidate): the caller\'s own vote is highlighted');
    await q.click('.oa-forum-post.is-first .oa-forum-v.down');
    await q.waitForFunction(() => document.querySelector('.oa-forum-updown').textContent === '0 / 1', null, { timeout: 8000 });
    eq(await q.$eval('.oa-forum-score', (n) => n.textContent), '-1', 'forum (candidate): moving the vote to dislike shows -1, the like withdrawn');
    await q.click('.oa-forum-post.is-first .oa-forum-v.down');
    await q.waitForFunction(() => document.querySelector('.oa-forum-updown').textContent === '0 / 0', null, { timeout: 8000 });
    const v0 = await q.evaluate((t) => ({
      score: document.querySelector('.oa-forum-score').textContent,
      pressed: [...document.querySelectorAll('.oa-forum-post.is-first .oa-forum-v')].map((b) => b.getAttribute('aria-pressed')),
      thread: window.__fb.docs[t + '/seed-t1'].score,
      voteDocs: Object.keys(window.__fb.docs).filter((p) => /\/votes\//.test(p)),
      sent: window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumVote').map((e) => e.data.v),
    }), T);
    eq(v0.score, '0', 'forum (candidate): pressing the same button again withdraws the vote');
    eq(v0.pressed, ['false', 'false'], 'forum (candidate): and nothing is highlighted');
    eq(v0.thread, 0, 'forum (candidate): the thread head\'s score followed the first post\'s net all the way');
    eq(v0.voteDocs, [], 'forum (candidate): a withdrawn vote leaves no vote document');
    eq(v0.sent, [1, -1, 0], 'forum (candidate): the page sent 1, -1 and 0, never a delta of its own');

    /* reply with a quote: the copy carries the quoted handle and number */
    await q.click('.oa-forum-post.is-first .oa-forum-act[data-act="quote"]');
    await q.waitForSelector('#oa-forum-quotebox:not([hidden])', { timeout: 8000 });
    const qb = await q.evaluate(() => ({
      cite: document.querySelector('#oa-forum-quotebox cite').textContent,
      text: document.querySelector('#oa-forum-quotebox p').textContent,
      focused: document.activeElement && document.activeElement.id,
      accept: !!document.getElementById('oa-forum-accept'),
    }));
    eq(qb.cite, 'patient owl 7 wrote in #1', 'forum (candidate): Quote names the quoted handle and post number');
    ok(qb.text.startsWith('<img src=x') && qb.text.length <= 600, 'forum (candidate): the whole body, cut to the bound, as text');
    eq(qb.focused, 'oa-forum-body', 'forum (candidate): and moves the keyboard to the reply box');
    ok(qb.accept, 'forum (candidate): a first post asks for the guide to be accepted');
    await q.fill('#oa-forum-body', 'Thank you. The teaching load question worked for me too.');
    await q.check('#oa-forum-accept');
    await q.click('#oa-forum-send');
    await q.waitForSelector('.oa-forum-post[data-n="2"]', { timeout: 15000 });
    const rep = await q.evaluate(() => {
      const p2 = document.querySelector('.oa-forum-post[data-n="2"]');
      const sent = window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumPost').pop().data;
      return {
        cite: p2.querySelector('.oa-forum-quote cite').textContent,
        link: p2.querySelector('.oa-forum-quote cite a').getAttribute('href'),
        body: p2.querySelector('.oa-forum-text').textContent,
        mine: !!p2.querySelector('.oa-forum-handle.is-me'),
        own: p2.querySelectorAll('.oa-forum-v[disabled]').length,
        edit: (p2.querySelector('.oa-forum-act[data-act="edit"]') || {}).textContent,
        heading: document.querySelector('.oa-forum-answers-h h2').textContent,
        sortOptions: [...document.querySelectorAll('#oa-forum-sort option')].map((o) => o.value),
        accept: document.querySelectorAll('[data-act="accept"]').length,
        save: document.querySelectorAll('[data-act="save"]').length,
        comments: (document.getElementById('oa-forum-thread').textContent.match(/comment/gi) || []).length,
        sent: { keys: Object.keys(sent).sort(), quote: sent.quote, accept: sent.acceptGuide },
        hash: location.hash,
        acceptGone: !document.getElementById('oa-forum-accept'),
      };
    });
    eq(rep.cite, 'patient owl 7 wrote in #1', 'forum (candidate): the reply carries the quote as a blockquote headed by handle and number');
    eq(rep.link, '#p1', 'forum (candidate): the heading links the quoted post');
    ok(/teaching load question worked/.test(rep.body), 'forum (candidate): the reply\'s own words follow');
    ok(rep.mine && rep.own === 2, 'forum (candidate): the reply is marked as the reader\'s own, with both vote buttons disabled');
    ok(/^Edit · \d+ min left$/.test(rep.edit || ''), 'forum (candidate): the author is offered Edit with the minutes left');
    eq(rep.heading, '1 Answer', 'forum (candidate): the answers band counts, and says answers');
    eq(rep.sortOptions, ['score', 'oldest'], 'forum (candidate): and offers the two orders, highest score first');
    eq(rep.accept, 0, 'forum (candidate): NO tick is offered on somebody else\'s question, whatever this reader thinks of the answer');
    eq(rep.save, 2, 'forum (candidate): the question and the answer can each be saved');
    eq(rep.comments, 0, 'forum (candidate): and there is nowhere to comment on either, which is the whole model');
    eq(rep.sent.keys, ['acceptGuide', 'body', 'quote', 'room', 'tid'], 'forum (candidate): the answer sent room, tid, body, the quote and the acceptance, and no kind');
    eq(Object.keys(rep.sent.quote).sort(), ['n', 'text'], 'forum (candidate): the quote sent is n and text only');
    ok(rep.hash === '#p2' && rep.acceptGone, 'forum (candidate): the page lands on the new post and the acceptance box is gone');

    /* edit the reply inside the window */
    await q.click('.oa-forum-post[data-n="2"] .oa-forum-act[data-act="edit"]');
    await q.waitForSelector('.oa-forum-editing textarea', { timeout: 8000 });
    await q.fill('.oa-forum-editing textarea', 'Thank you. The teaching load question worked for me as well.');
    await q.click('.oa-forum-editing [data-edit="save"]');
    await q.waitForFunction(() => /worked for me as well/.test((document.querySelector('.oa-forum-post[data-n="2"] .oa-forum-text') || {}).textContent || ''),
      null, { timeout: 8000 });
    ok(await q.evaluate(() => /edited/.test(document.querySelector('.oa-forum-post[data-n="2"] .oa-forum-who').textContent)),
      'forum (candidate): an edit saves through forumEdit and the post says edited');
    /* AND SAVING AN EDIT LEAVES THE ANSWER BOX ALONE. The save used to go
       through go(), which rebuilt the thread and the box below it, so
       whatever was half written there went the moment an edit elsewhere was
       saved; every other in-thread action kept it. */
    await q.fill('#oa-forum-body', 'A draft that must survive the edit above.');
    await q.click('.oa-forum-post[data-n="2"] .oa-forum-act[data-act="edit"]');
    await q.waitForSelector('.oa-forum-editing textarea', { timeout: 8000 });
    await q.fill('.oa-forum-editing textarea', 'Thank you. The teaching load question worked for me as well, twice over.');
    await q.click('.oa-forum-editing [data-edit="save"]');
    await q.waitForFunction(() => /twice over/.test((document.querySelector('.oa-forum-post[data-n="2"] .oa-forum-text') || {}).textContent || ''),
      null, { timeout: 8000 });
    const keptDraft = await q.evaluate(() => ({
      draft: document.getElementById('oa-forum-body').value,
      editors: document.querySelectorAll('.oa-forum-editing').length,
      focusIn: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.oa-forum-post[data-n="2"]')),
    }));
    eq(keptDraft.draft, 'A draft that must survive the edit above.', 'forum (candidate): saving an edit leaves what was half written in the answer box');
    eq(keptDraft.editors, 0, 'forum (candidate): and the editor is closed');
    ok(keptDraft.focusIn, 'forum (candidate): with focus back on the edited post');
    await q.fill('#oa-forum-body', '');

    /* A LINK POSTS, and the page draws it (owner, 2026-09-05). The guard used
       to refuse a web address; what it still refuses is a way to be contacted
       off the forum. */
    await q.fill('#oa-forum-body', 'The call is at https://ec26.sigecom.org/cfp. Worth a look.');
    await q.click('#oa-forum-send');
    await q.waitForSelector('.oa-forum-post[data-n="3"]', { timeout: 15000 });
    const lk = await q.evaluate(() => {
      const p3 = document.querySelector('.oa-forum-post[data-n="3"]');
      const a = p3.querySelector('.oa-forum-text a');
      return {
        href: a && a.getAttribute('href'),
        rel: a && a.getAttribute('rel'),
        target: a && a.getAttribute('target'),
        text: a && a.textContent,
        after: p3.querySelector('.oa-forum-text').textContent,
      };
    });
    eq(lk.href, 'https://ec26.sigecom.org/cfp', 'forum (candidate): a web address in a post is drawn as a link');
    eq(lk.rel, 'noopener noreferrer nofollow', 'forum (candidate): with no referrer, no window handle and no rank passed');
    eq(lk.target, '_blank', 'forum (candidate): opened away from the forum');
    eq(lk.text, 'https://ec26.sigecom.org/cfp', 'forum (candidate): the full stop after it is sentence punctuation, not part of the address');
    ok(/Worth a look\./.test(lk.after), 'forum (candidate): and the words after it are still there');

    /* DELETING it: the author's own post, no window, the words really gone */
    q.once('dialog', (d) => d.accept());
    await q.click('.oa-forum-post[data-n="3"] .oa-forum-act[data-act="delete"]');
    await q.waitForFunction(() => {
      const p3 = document.querySelector('.oa-forum-post[data-n="3"]');
      return p3 && p3.querySelector('.oa-forum-removed');
    }, null, { timeout: 15000 });
    const del = await q.evaluate((t) => {
      const p3 = document.querySelector('.oa-forum-post[data-n="3"]');
      const pid = p3.getAttribute('data-pid');
      const doc = window.__fb.docs[t + '/seed-t1/posts/' + pid];
      return {
        note: p3.querySelector('.oa-forum-removed').textContent,
        body: p3.querySelector('.oa-forum-text'),
        anchor: p3.querySelector('a[href*="sigecom"]'),
        stored: doc && { body: doc.body, hidden: doc.hidden, hiddenBy: doc.hiddenBy, n: doc.n },
        acts: [...p3.querySelectorAll('.oa-forum-act')].map((b) => b.getAttribute('data-act')).filter(Boolean),
        still: !!document.querySelector('.oa-forum-post[data-n="2"] .oa-forum-text'),
        title: document.getElementById('oa-forum-title').textContent,
      };
    }, T);
    ok(/deleted by its author/i.test(del.note), 'forum (candidate): a deleted reply says who deleted it, never that moderation removed it');
    ok(!del.body && !del.anchor, 'forum (candidate): its words and its link are off the page');
    eq(del.stored, { body: '', hidden: true, hiddenBy: 'author', n: 3 },
      'forum (candidate): and erased in the database, with the slot kept so the numbering still reads');
    eq(del.acts, [], 'forum (candidate): a deleted post offers no reply, quote, edit or delete');
    ok(del.still, 'forum (candidate): the other replies are untouched');
    eq(del.title, HOSTILE_TITLE, 'forum (candidate): and the thread keeps its title, since the opening post was not the one deleted');
    /* AND THE THREAD AT ITS RICHEST: a quoted answer, a removed one, the
       answers band with its sort control, and the bookmark on each post. The
       guide thread audited further down has one post and none of them. */
    await forumContrast(q, 'a busy thread');
    /* the seeded question is another handle's, so an ordinary member is
       offered nothing on it: delete is the author's or the maintainer's */
    ok(await q.evaluate(() => !document.querySelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]')),
      'forum (candidate): somebody else\'s question offers this member no Delete at all');

    /* the seen-mark and the leak check on a thread page */
    const seen = await q.evaluate(() => JSON.parse(localStorage.getItem('oa-forum-seen') || 'null'));
    ok(seen && seen.uid === CAND.uid && seen.seen['seed-t1'] >= 1, 'forum (candidate): the thread is marked seen, per account');
    const leak1 = await leakCheck(q);
    eq(leak1.main, [], 'forum (candidate): LEAK CHECK on a thread: no uid, address, name, affiliation or profile id in #main');
    eq(leak1.whole, [], 'forum (candidate): …and the uid and the profile id are nowhere in the whole document');

    /* ask a question with two tags, and read it back */
    await q.click('.oa-forum-crumbs a');
    await q.waitForSelector('#oa-forum-askbtn', { timeout: 15000 });
    await q.click('#oa-forum-askbtn');
    await q.waitForSelector('#oa-forum-askform', { timeout: 8000 });
    ok(/[?&]ask=1/.test(await q.evaluate(() => location.search)), 'forum (candidate): the ask form has its own address');
    await q.fill('#oa-forum-ask-title', 'Is a second-year teaching release normal to ask for?');
    await q.fill('#oa-forum-ask-body', 'Two offers on the table, both silent on teaching release. Is it normal to ask, and how?');
    await q.fill('#oa-forum-tag-in', 'offers');
    await q.press('#oa-forum-tag-in', 'Enter');
    await q.fill('#oa-forum-tag-in', 'Teaching Release');
    await q.press('#oa-forum-tag-in', 'Enter');
    /* NUDGE NOBODY, REFUSE NOBODY (owner, 2026-09-05). The curated list no
       longer offers `rumour`, so the picker suggests it to no one; a poster
       who types it anyway still gets the tag, which is the half the owner
       asked to keep. Measured on the suggestion list AND on the chip. */
    await q.fill('#oa-forum-tag-in', 'rumou');
    const suggested = await q.$$eval('#oa-forum-tagsugg [data-tag]', (ns) => ns.map((b) => b.getAttribute('data-tag')));
    /* SCOPE, said exactly: the seeded tally here holds flyouts and europe, so
       what this measures is the CURATED half of the pool. The other half is
       the room's own tally, and a tag a member has really used is offered
       like any other: the room describing itself rather than the site
       recommending it. */
    ok(!suggested.includes('rumour'), 'forum (candidate): the curated half of the picker offers no rumour tag');
    /* THE ASK FORM, with its suggestion list open. Its lede, its hints and the
       rows of the tag picker are drawn nowhere else, so none of them had ever
       been measured; the picker's rows are open right now because a prefix has
       just been typed into the box. */
    await forumContrast(q, 'the ask form');
    await q.fill('#oa-forum-tag-in', 'Rumour');
    await q.press('#oa-forum-tag-in', 'Enter');
    const chips = await q.$$eval('#oa-forum-tagchips .oa-chip', (ns) => ns.map((n) => n.getAttribute('data-tag')));
    eq(chips, ['offers', 'teaching-release', 'rumour'],
      'forum (candidate): two curated tags and a free one the reader typed, each normalised to a slug');
    await q.click('#oa-forum-tagchips .oa-chip[data-tag="rumour"]');
    eq(await q.$$eval('#oa-forum-tagchips .oa-chip', (ns) => ns.map((n) => n.getAttribute('data-tag'))),
      ['offers', 'teaching-release'], 'forum (candidate): and it comes off again like any other chip');
    await q.click('#oa-forum-ask-send');
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const asked = await q.evaluate((t) => {
      const sent = window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumPost').pop().data;
      const tid = new URLSearchParams(location.search).get('t');
      const doc = window.__fb.docs[t + '/' + tid];
      return {
        title: document.getElementById('oa-forum-title').textContent,
        tags: [...document.querySelectorAll('.oa-forum-thtags a[data-tag]')].map((a) => a.getAttribute('data-tag')),
        sentTags: sent.tags, sentTitle: sent.title, sentRoom: sent.room, sentTid: 'tid' in sent,
        docBy: doc && doc.by, docTags: doc && doc.tags, docKeys: doc && Object.keys(doc).sort(),
        tally: window.__fb.docs['forumTags/' + doc.season + '_candidates'].counts,
        own: document.querySelectorAll('.oa-forum-post.is-first .oa-forum-v[disabled]').length,
      };
    }, T);
    eq(asked.title, 'Is a second-year teaching release normal to ask for?', 'forum (candidate): the new question is read back as a thread');
    eq(asked.tags, ['offers', 'teaching-release'], 'forum (candidate): with its two tags');
    ok(asked.sentTags.join() === 'offers,teaching-release' && asked.sentRoom === 'candidates' && !asked.sentTid,
      'forum (candidate): forumPost was sent room, title, tags and body, and no tid for a new thread');
    eq(asked.docBy, 'quiet heron 42', 'forum (candidate): the thread carries the handle, never the account');
    eq(asked.docKeys, ['accepted', 'by', 'excerpt', 'hidden', 'lastAt', 'lastBy', 'locked', 'n', 'pinned', 'room', 'score', 'season', 't', 'tags', 'title'],
      'forum (candidate): the simulator writes the thread shape the model names, the tick among it');
    eq(asked.tally, { flyouts: 1, europe: 1, offers: 1, 'teaching-release': 1 }, 'forum (candidate): the tag tally was bumped');
    eq(asked.own, 2, 'forum (candidate): one cannot vote on one\'s own question');
    const leak2 = await leakCheck(q);
    eq(leak2.main, [], 'forum (candidate): LEAK CHECK after posting: nothing of the account in #main');
    eq(leak2.whole, [], 'forum (candidate): …and the uid and the profile id are nowhere in the document');
    const forumDocs = await q.evaluate((needles) => Object.keys(window.__fb.docs)
      .filter((p) => /^(forumSeasons|forumTags|candidateMarkers)\//.test(p))
      .filter((p) => needles.some((k) => (p + ' ' + JSON.stringify(window.__fb.docs[p])).includes(k))), [CAND.email, 'Zyxwvut', CAND.uid]);
    eq(forumDocs, ['candidateMarkers/' + CAND.uid],
      'forum (candidate): of every forum document, only the membership marker carries the uid (in its id, by design), and none the address or the name');
    /* ---- THE TICK, on a question this reader asked ------------------------

       The one who asked, and only they (forumAccept refuses everyone else
       with `asker` whatever the page draws). Ticked, the answer carries the
       mark, moves to the top of the band, and the thread's own row says so,
       which is what lets the card in the list mark an answered question
       without reading a post. Pressing it again takes it off. */
    await q.fill('#oa-forum-body', 'Answering my own question: yes, and the letter is the place to ask.');
    await q.click('#oa-forum-send');
    await q.waitForSelector('#oa-forum-answers .oa-forum-post[data-n="2"]', { timeout: 15000 });
    const mine = await q.evaluate(() => ({
      accept: document.querySelectorAll('#oa-forum-answers [data-act="accept"]').length,
      onQuestion: document.querySelectorAll('.oa-forum-post.is-first [data-act="accept"]').length,
      pressed: document.querySelector('#oa-forum-answers [data-act="accept"]').getAttribute('aria-pressed'),
    }));
    eq(mine.accept, 1, 'forum (accept): the asker is offered the tick on the answer');
    eq(mine.onQuestion, 0, 'forum (accept): and never on the question itself, which is not an answer');
    eq(mine.pressed, 'false', 'forum (accept): nothing is ticked to begin with');
    await q.click('#oa-forum-answers [data-act="accept"]');
    await q.waitForSelector('#oa-forum-answers .oa-forum-post.is-accepted', { timeout: 15000 });
    const ticked = await q.evaluate((t) => {
      const tid = new URLSearchParams(location.search).get('t');
      const li = document.querySelector('#oa-forum-answers .oa-forum-post.is-accepted');
      const sent = window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumAccept').pop().data;
      return {
        pid: li.getAttribute('data-pid'),
        first: document.querySelector('#oa-forum-answers .oa-forum-post').getAttribute('data-pid'),
        pressed: li.querySelector('[data-act="accept"]').getAttribute('aria-pressed'),
        doc: window.__fb.docs[t + '/' + tid].accepted,
        sentKeys: Object.keys(sent).sort(),
      };
    }, T);
    eq(ticked.doc, ticked.pid, 'forum (accept): the tick is stored on the THREAD, naming the post');
    eq(ticked.first, ticked.pid, 'forum (accept): and the ticked answer is drawn first in the band');
    eq(ticked.pressed, 'true', 'forum (accept): the control says it is on');
    eq(ticked.sentKeys, ['pid', 'room', 'tid'], 'forum (accept): forumAccept was sent the room, the thread and the post, and nothing else');
    await q.click('#oa-forum-answers [data-act="accept"]');
    await q.waitForFunction(() => !document.querySelector('#oa-forum-answers .oa-forum-post.is-accepted'), null, { timeout: 15000 });
    eq(await q.evaluate((t) => window.__fb.docs[t + '/' + new URLSearchParams(location.search).get('t')].accepted, T), '',
      'forum (accept): pressing it again unticks it, and the thread says so');

    /* TICKED, THEN THE ANSWER DELETED: the tick goes with it, in the same
       transaction the function writes (forum/delete.js), or the thread would
       go on telling every reader that a question with no answer left in it
       has been answered. It also puts this thread back where the step below
       needs it, with no live answer holding the question down. */
    await q.click('#oa-forum-answers [data-act="accept"]');
    await q.waitForSelector('#oa-forum-answers .oa-forum-post.is-accepted', { timeout: 15000 });
    q.once('dialog', (d) => d.accept());
    await q.click('#oa-forum-answers .oa-forum-act[data-act="delete"]');
    await q.waitForFunction(() => !!document.querySelector('#oa-forum-answers .oa-forum-removed'), null, { timeout: 15000 });
    const untick = await q.evaluate((t) => ({
      stored: window.__fb.docs[t + '/' + new URLSearchParams(location.search).get('t')].accepted,
      marked: document.querySelectorAll('#oa-forum-answers .oa-forum-post.is-accepted').length,
      note: (document.querySelector('#oa-forum-answers .oa-forum-removed') || {}).textContent,
    }), T);
    eq(untick.stored, '', 'forum (accept): deleting the ticked answer clears the tick on the thread');
    eq(untick.marked, 0, 'forum (accept): and nothing on the page still says it was answered');
    ok(/answer was deleted by its author/i.test(untick.note || ''),
      'forum (accept): the tombstone reads as an answer, never as a reply');

    /* ---- SAVED, and WATCHED: this browser's, and nowhere else -------------

       Neither writes a document. A uid beside a thread id is a record of what
       a member reads, in a room built so that nothing records that, so both
       live in localStorage beside the seen-marks and the page says so. */
    await q.click('.oa-forum-post.is-first [data-act="save"]');
    await q.waitForSelector('#oa-forum-savedcard:not([hidden])', { timeout: 8000 });
    const saved = await q.evaluate((who) => ({
      store: JSON.parse(localStorage.getItem('oa-forum-saved') || 'null'),
      rows: document.querySelectorAll('#oa-forum-saved .oa-forum-savedrow').length,
      pressed: document.querySelector('.oa-forum-post.is-first [data-act="save"]').getAttribute('aria-pressed'),
      mine: (JSON.parse(localStorage.getItem('oa-forum-saved') || '{}') || {}).uid === who.uid,
      leaks: JSON.stringify(JSON.parse(localStorage.getItem('oa-forum-saved') || 'null')).includes(who.email),
    }), { uid: CAND.uid, email: CAND.email });
    eq(saved.pressed, 'true', 'forum (saved): the bookmark says it is on');
    eq(saved.rows, 1, 'forum (saved): and the side card lists what was saved');
    ok(saved.mine && Object.keys(saved.store.items).length === 1,
      'forum (saved): the mark is in this browser, keyed to the account');
    ok(!saved.leaks, 'forum (saved): and carries no address');
    /* REMOVING IT FROM THE CARD KEEPS THE KEYBOARD. The button pressed goes
       with its row, so there is nothing to put focus back on; it goes to the
       thread's own bookmark rather than falling to <body>, where the removal
       is announced to nobody and the next Tab starts from the top. */
    await q.focus('#oa-forum-saved .oa-forum-unsave');
    await q.click('#oa-forum-saved .oa-forum-unsave');
    await q.waitForFunction(() => document.getElementById('oa-forum-savedcard').hidden, null, { timeout: 8000 });
    const unsaved = await q.evaluate(() => ({
      tag: document.activeElement && document.activeElement.tagName,
      onBookmark: !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('oa-forum-save')),
      pressed: document.querySelector('.oa-forum-post.is-first [data-act="save"]').getAttribute('aria-pressed'),
    }));
    ok(unsaved.onBookmark, 'forum (saved): removing the last saved item puts focus on the post\'s own bookmark, not on <body> (' + unsaved.tag + ')');
    eq(unsaved.pressed, 'false', 'forum (saved): and the bookmark on the post says it is off');
    await q.click('.oa-forum-post.is-first [data-act="save"]');
    await q.waitForSelector('#oa-forum-savedcard:not([hidden])', { timeout: 8000 });
    /* the tag cards are beside every view, so this needs no navigation, and
       the thread stays on screen for the step below */
    const before = await q.evaluate(() => window.__fb.log.filter((e) => e.op === 'set' || e.op === 'update').length);
    await q.click('#oa-forum-tags [data-watch]');
    await q.waitForFunction(() => (JSON.parse(localStorage.getItem('oa-forum-saved') || '{}').tags || []).length === 1,
      null, { timeout: 8000 });
    const watched = await q.evaluate(() => ({
      tags: JSON.parse(localStorage.getItem('oa-forum-saved') || '{}').tags,
      card: !document.getElementById('oa-forum-watchcard').hidden,
      chips: document.querySelectorAll('#oa-forum-watch .oa-forum-tagrow').length,
      pressed: document.querySelector('#oa-forum-tags [data-watch]').getAttribute('aria-pressed'),
      wrote: window.__fb.log.filter((e) => e.op === 'set' || e.op === 'update').length,
    }));
    eq(watched.tags.length, 1, 'forum (watched): the bell adds the tag to this browser\'s own list');
    ok(watched.card && watched.chips === 1, 'forum (watched): and the side card lists it');
    eq(watched.pressed, 'true', 'forum (watched): the bell says it is on');
    eq(watched.wrote, before, 'forum (watched): watching a tag writes NOTHING to the database, which is the whole point of it');
    /* AND THE BELL KEEPS THE FOCUS ITS OWN REDRAW WOULD DROP: the press
       rebuilds both cards, so without putting it back focus falls to <body>
       and the new pressed state is announced to nobody. */
    await q.evaluate(() => document.querySelector('#oa-forum-tags [data-watch]').focus());
    await q.click('#oa-forum-tags [data-watch]');
    await q.waitForTimeout(300);
    eq(await q.evaluate(() => (document.activeElement.closest && document.activeElement.closest('#oa-forum-tags'))
      ? 'in the tag card' : document.activeElement.tagName),
    'in the tag card', 'forum (watched): pressing the bell leaves focus on the bell, not on <body>');
    await q.click('#oa-forum-tags [data-watch]');
    await q.waitForTimeout(200);

    eq(await q.evaluate(() => JSON.parse(sessionStorage.getItem('oa-forum-me')).handle), 'quiet heron 42',
      'forum (candidate): the join is remembered for the session under the handle');
    /* THEIR OWN QUESTION, WHICH NOBODY HAS ANSWERED: it goes, and the whole
       thread goes with it, so none is ever left headless (owner, 2026-09-05).
       The thread just posted is the one case an ordinary member may delete. */
    q.once('dialog', (d) => d.accept());
    await q.click('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]');
    await q.waitForFunction(() => {
      const list = document.getElementById('oa-forum-list');
      return list && !list.hidden && list.querySelector('.oa-card');
    }, null, { timeout: 15000 });
    const gone = await q.evaluate((t) => {
      const tid = window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumDelete').pop().data.tid;
      return {
        thread: window.__fb.docs[t + '/' + tid].hidden,
        listed: [...document.querySelectorAll('#oa-forum-list .oa-card-title')].map((n) => n.textContent),
      };
    }, T);
    eq(gone.thread, true, 'forum (candidate): deleting a question nobody answered takes the whole thread');
    ok(!gone.listed.some((t2) => /second-year teaching release/.test(t2)),
      'forum (candidate): and it is off the list, rather than standing there headless');
    /* AND THE WORDS REALLY GO. Erasing the post's body is not the whole of it
       while the thread head keeps the title and an `excerpt` that is a copy of
       that body, and any admitted member may list the hidden rows. The tags
       come back to the room's tally in the same breath, or Popular tags counts
       a question nobody can open. */
    const after = await q.evaluate((t) => {
      const tid = window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumDelete').pop().data.tid;
      const th = window.__fb.docs[t + '/' + tid];
      const tally = Object.values(window.__fb.docs).find((d2) => d2 && d2.counts) || { counts: {} };
      return { title: th.title, excerpt: th.excerpt, tags: th.tags, counts: tally.counts };
    }, T);
    ok(after.title === '' && after.excerpt === '',
      'forum (candidate): and it keeps no title and no excerpt, so the words really are gone');
    ok(Array.isArray(after.tags) && after.tags.length > 0,
      'forum (candidate): while its tags stay on the row, which is what the removal tool reads');
    ok(after.tags.every((t2) => Number(after.counts[t2] || 0) === 0),
      `forum (candidate): and the room's tally has them back (${JSON.stringify(after.counts)})`);
    /* THE ROOM TABS TAKE THE KEYBOARD. A roving tabindex puts the unselected
       room out of the tab order, so without arrow keys it is reachable by
       pointer and by nothing else. */
    await q.evaluate(() => document.querySelector('.oa-forum-tab[aria-selected="true"]').focus());
    await q.press('.oa-forum-tab[aria-selected="true"]', 'ArrowRight');
    await q.waitForFunction(() => document.querySelector('.oa-forum-tab[aria-selected="true"]')
      && document.querySelector('.oa-forum-tab[aria-selected="true"]').getAttribute('data-room') === 'open',
    null, { timeout: 8000 });
    ok(true, 'forum (candidate): the arrow keys move between the rooms');
    eq(await q.evaluate(() => document.activeElement.getAttribute('data-room')), 'open',
      'forum (candidate): and focus follows the room that opened');

    /* SIGNING OUT FORGETS THE READER. popstate repaints whenever S.me is set,
       and S.me used to survive a sign-out along with the handle and the room,
       so Back brought the forum back for whoever is now at the machine. */
    await q.evaluate(() => window.OAAccounts.signOut());
    await q.waitForFunction(() => !document.getElementById('oa-needauth').hidden, null, { timeout: 10000 });
    await q.goBack();
    await q.waitForTimeout(600);
    const afterOut = await q.evaluate(() => ({
      forum: !document.getElementById('oa-forum').hidden,
      needauth: !document.getElementById('oa-needauth').hidden,
      handle: (document.getElementById('oa-forum-me') || {}).textContent || '',
      body: document.body.textContent,
    }));
    ok(!afterOut.forum && afterOut.needauth,
      'forum (signed out): pressing Back does not repaint the forum for whoever is now reading');
    ok(!/quiet heron 42/.test(afterOut.handle) && !/quiet heron 42/.test(afterOut.body),
      'forum (signed out): and the previous reader\'s handle is nowhere in the page');
    await forumContrast(q, 'the list');
    eq(errors, [], 'forum (candidate): no uncaught script error through the whole conversation');
    await ctx.close();
  }

  /* -- the maintainer, with no profile: both rooms, the guide seeded, a post -- */
  {
    const ADMIN_USER = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com',
      emailVerified: true, displayName: 'Kostas Stouras', providerData: [] };
    const { ctx, page: q, errors } = await signedInPage('forum.html', { user: ADMIN_USER, selector: '#oa-forum' });
    eq(await tabs(q), ['candidates', 'open'], 'forum (maintainer): both tabs, with no candidate profile');
    ok(await q.evaluate(() => !window.__fb.docs['candidateMarkers/admin-uid-0000000000']), 'forum (maintainer): no marker is written for them');
    await q.waitForSelector('#oa-forum-admin:not([hidden])', { timeout: 15000 });
    eq(await q.$$eval('#oa-forum-admin [data-seed-room]', (ns) => ns.map((n) => n.getAttribute('data-seed-room'))), ['candidates', 'open'],
      'forum (maintainer): the guide card offers a button for each admitted room');
    ok((await q.$$eval('#oa-forum-admin [data-seed-room]', (ns) => ns.map((n) => n.textContent))).every((t) => /^Post the guide/.test(t)),
      'forum (maintainer): reading Post the guide while neither room has one');
    await q.click('#oa-forum-admin [data-seed-room="candidates"]');
    await q.waitForSelector('#oa-forum-list .oa-card', { timeout: 15000 });
    const seeded = await q.evaluate(() => {
      const card = document.querySelector('#oa-forum-list .oa-card');
      return {
        title: card.querySelector('.oa-card-title').textContent,
        badges: [...card.querySelectorAll('.oa-label')].map((b) => b.textContent),
        sub: card.querySelector('.oa-card-sub').textContent,
        sent: window.__fb.log.filter((e) => e.op === 'callable' && e.path === 'forumModerate').map((e) => e.data),
        left: [...document.querySelectorAll('#oa-forum-admin [data-seed-room]')].map((n) => n.getAttribute('data-seed-room')),
        labels: [...document.querySelectorAll('#oa-forum-admin [data-seed-room]')].map((n) => n.textContent),
        handle: document.getElementById('oa-forum-myhandle').textContent,
      };
    });
    eq(seeded.title, 'About this forum', 'forum (maintainer): the guide thread appears');
    ok(seeded.badges.includes('Pinned') && seeded.badges.includes('Locked') && seeded.badges.includes('about'),
      'forum (maintainer): pinned, locked and tagged about');
    ok(/^Moderator/.test(seeded.sub), 'forum (maintainer): under the Moderator handle');
    eq(seeded.sent, [{ op: 'seedGuide', room: 'candidates' }], 'forum (maintainer): forumModerate was sent the op and the room, and no body');
    eq(seeded.left, ['candidates', 'open'], 'forum (maintainer): both buttons stay, since the guide is a stored copy that has to be refreshable');
    ok(/^Update the guide/.test(seeded.labels[0]) && /^Post the guide/.test(seeded.labels[1]),
      'forum (maintainer): the seeded room now reads Update the guide, the unseeded one still Post it');
    eq(seeded.handle, 'quiet heron 42', 'forum (maintainer): their own handle is an ordinary drawn one, never Moderator');
    await q.click('#oa-forum-list .oa-card .oa-card-head');
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const guide = await q.evaluate(() => ({
      votes: document.querySelectorAll('.oa-forum-v').length,
      reply: !!document.getElementById('oa-forum-body'),
      note: document.getElementById('oa-forum-compose').textContent,
      rules: /Thirteen rules|rules/i.test(document.querySelector('.oa-forum-text').textContent),
      del: !!document.querySelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]'),
      delOff: (() => {
        const b = document.querySelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]');
        return b ? { off: b.disabled, why: b.getAttribute('title') || '' } : null;
      })(),
    }));
    ok(guide.votes === 0 && !guide.reply && /locked/.test(guide.note), 'forum (maintainer): the locked guide thread draws no vote button and no reply box');
    /* BUT DELETE IS NOT A NEW POST. forumDelete refuses on an archive and a
       hidden thread and ALLOWS a locked one, because locking stops new posts
       and does not make somebody's words un-removable. Drawn under the same
       readOnly as the reply box, the control was withheld exactly where the
       function would have allowed it. */
    ok(guide.del, 'forum (maintainer): and yet Remove IS drawn on it, since locking is not what withholds it');
    /* …AND IT SAYS NO BEFORE IT IS PRESSED, because this is the ONE thread
       Remove must never take. The guide's id is stamped on the season head
       and never cleared, so seedGuide would take its refresh branch for ever
       after and write the words back into a thread that is still hidden: one
       press and the room has no guide for the season and no way to post one.
       forumDelete refuses it too; a page can be got round. */
    ok(guide.delOff && guide.delOff.off && /guide cannot be removed/i.test(guide.delOff.why),
      'forum (maintainer): …disabled, with the reason, because the guide is the one thread Remove must not take');
    ok(guide.rules, 'forum (maintainer): its body is the guide text');
    /* AND THE THREAD'S OWN SURFACES, which the list view never shows: the
       body, the who-block, the crumbs, the meta bar, the Pinned and Locked
       badges and the vote column. */
    await forumContrast(q, 'a thread');
    /* A SELECTOR THAT MATCHED NOTHING AUDITED NOTHING, and said so nowhere.
       FORUM_INK is a list, and a list only holds what somebody remembered;
       one that has drifted off the markup is a check reporting green over a
       surface it never saw. Accumulated over BOTH views, since several of
       these are drawn in only one of them. */
    const unseen = FORUM_INK.filter((s) => !FORUM_INK_SEEN.has(s));
    eq(unseen, [], 'forum: every surface the contrast audit names was really on screen in one of the two views');
    await q.click('.oa-forum-crumbs a');
    await q.waitForSelector('#oa-forum-askbtn', { timeout: 15000 });
    await q.click('#oa-forum-askbtn');
    await q.waitForSelector('#oa-forum-askform', { timeout: 8000 });
    await q.fill('#oa-forum-ask-title', 'A test question from the maintainer');
    await q.fill('#oa-forum-ask-body', 'Checking how the room reads to a member.');
    await q.fill('#oa-forum-tag-in', 'about');
    await q.press('#oa-forum-tag-in', 'Enter');
    await q.check('#oa-forum-ask-accept');
    await q.click('#oa-forum-ask-send');
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const landed = await q.evaluate(() => ({
      title: document.getElementById('oa-forum-title').textContent,
      by: document.querySelector('.oa-forum-post.is-first .oa-forum-who .oa-forum-handle').textContent,
      mine: !!document.querySelector('.oa-forum-post.is-first .oa-forum-handle.is-me'),
    }));
    eq(landed.title, 'A test question from the maintainer', 'forum (maintainer): a post lands');
    ok(landed.by === 'quiet heron 42' && landed.mine, 'forum (maintainer): under their drawn handle, indistinguishable from any member\'s');

    /* THE MAINTAINER MAY DELETE ANY POST (owner, 2026-09-05: "the admin
       should be able to delete any questions or answers") and is NOT held by
       the rule that keeps an answered question standing. A live reply by
       another handle is written in first, or "enabled" would pass for the
       wrong reason: with nothing holding the question down the rule is not in
       play at all. The AUTHOR's side of it (the control drawn disabled with
       its reason) is pinned in the selftest against the page's own source and
       driven against the real function in the emulator test, which is where a
       refusal can be proved. */
    const mineTid = await q.evaluate(() => new URLSearchParams(location.search).get('t'));
    await q.evaluate(([t, tid]) => {
      window.__fb.docs[t + '/' + tid + '/posts/other-p2'] = { season: 0, room: 'candidates', tid: tid,
        n: 2, by: 'patient owl 7', body: 'A reply nobody has deleted.', kind: '', t: Date.now(),
        up: 0, down: 0, quote: null, hidden: false, hiddenBy: '' };
      window.__fb.docs[t + '/' + tid].n = 2;
    }, [T, mineTid]);
    await q.click('.oa-forum-crumbs a');
    await q.waitForSelector('#job-' + mineTid + ' .oa-card-head', { timeout: 15000 });
    await q.click('#job-' + mineTid + ' .oa-card-head');
    await q.waitForSelector('.oa-forum-post[data-n="2"]', { timeout: 15000 });
    const asAdmin = await q.evaluate(() => {
      const one = document.querySelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]');
      const two = document.querySelector('.oa-forum-post[data-n="2"] .oa-forum-act[data-act="delete"]');
      return {
        live: document.querySelectorAll('.oa-forum-post:not(.is-first)').length,
        q: one ? { label: one.textContent, disabled: one.disabled } : null,
        a: two ? { label: two.textContent, disabled: two.disabled } : null,
      };
    });
    eq(asAdmin.live, 1, 'forum (maintainer): their question carries a live reply, so the answered rule is really in play');
    eq(asAdmin.q, { label: 'Delete', disabled: false },
      'forum (maintainer): their own answered question is still deletable, since the rule does not hold them');
    eq(asAdmin.a, { label: 'Remove', disabled: false },
      'forum (maintainer): and another handle\'s reply offers Remove, the word for acting on somebody else\'s post');

    eq(errors, [], 'forum (maintainer): no uncaught script error');
    await ctx.close();
  }

  /* -- a legacy headless thread with a live answer: the asker cannot close it,
        the maintainer's close sweeps ---------------------------------------- */
  {
    const HEADLESS = [
      { path: `${T}/seed-t3`, data: { season: FY, room: 'candidates', title: 'A question its asker deleted, answered', tags: ['waiting'],
        by: 'quiet heron 42', t: OLD, lastAt: OLD, lastBy: 'patient owl 7', n: 2, excerpt: '', score: 0, pinned: false, locked: false, hidden: false } },
      { path: `${T}/seed-t3/posts/seed-t3-p1`, data: { season: FY, room: 'candidates', tid: 'seed-t3', n: 1, by: 'quiet heron 42',
        body: '', t: OLD, up: 0, down: 0, quote: null, hidden: true, hiddenBy: 'author' } },
      { path: `${T}/seed-t3/posts/seed-t3-p2`, data: { season: FY, room: 'candidates', tid: 'seed-t3', n: 2, by: 'patient owl 7',
        body: 'An answer that must stay reachable by its own author.', t: OLD, up: 0, down: 0, quote: null, hidden: false, hiddenBy: '' } },
    ];
    const { ctx, page: q, errors } = await signedInPage('forum.html?room=candidates&t=seed-t3',
      { user: CAND, docs: [CAND_PROFILE, ...SEEDED, ...HEADLESS], selector: '#oa-forum' });
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const asker = await q.evaluate(() => {
      const b = document.querySelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]');
      return { label: b && b.textContent.trim(), off: !!(b && b.disabled), why: (b && b.getAttribute('title')) || '',
        closed: !!document.querySelector('#oa-forum-compose .oa-note'),
        answers: document.querySelectorAll('#oa-forum-answers .oa-forum-post').length };
    });
    eq(asker.label, 'Close this thread', 'forum (headless): the asker is offered the close');
    ok(asker.off && /still has answers/.test(asker.why),
      'forum (headless): ...disabled with the reason, because another member\'s answer still stands under it');
    ok(asker.closed && asker.answers === 1, 'forum (headless): the thread takes no new answers, and the answer is still there to read');
    eq(errors, [], 'forum (headless): no uncaught script error');
    await ctx.close();
    /* the maintainer, as the block below defines them (that constant is its own) */
    const MAINTAINER = { uid: 'admin-uid-0000000000', email: 'kstouras@gmail.com',
      emailVerified: true, displayName: 'Kostas Stouras', providerData: [] };
    const m = await signedInPage('forum.html?room=candidates&t=seed-t3',
      { user: MAINTAINER, docs: [CAND_PROFILE, ...SEEDED, ...HEADLESS], selector: '#oa-forum' });
    await m.page.waitForSelector('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]:not([disabled])', { timeout: 15000 });
    let closeDialog = '';
    m.page.once('dialog', (d) => { closeDialog = d.message(); d.accept(); });
    await m.page.click('.oa-forum-post.is-first .oa-forum-act[data-act="delete"]');
    await m.page.waitForFunction((t) => (window.__fb.docs[t + '/seed-t3'] || {}).hidden === true, T, { timeout: 15000 });
    ok(/still standing under it/.test(closeDialog) && /removed with it/.test(closeDialog),
      'forum (headless): the maintainer\'s confirmation names the answer their close sweeps (' + closeDialog.slice(0, 60) + ')');
    const swept = await m.page.evaluate((t) => window.__fb.docs[t + '/seed-t3/posts/seed-t3-p2'], T);
    ok(swept && swept.hidden === true && swept.body === '' && swept.hiddenBy === 'admin',
      'forum (headless): and the answer is erased with the thread, saying the maintainer removed it');
    eq(m.errors, [], 'forum (headless): no uncaught script error for the maintainer');
    await m.ctx.close();
  }

  /* -- an archived season: read-only ----------------------------------------- */
  {
    const PY = FY - 1;
    const PT = `forumSeasons/${PY}/rooms/candidates/threads`;
    const archive = [
      { path: `forumSeasons/${PY}`, data: { season: PY, createdAt: OLD, secretVersion: 'env', guides: {} } },
      { path: `${PT}/old-t1`, data: { season: PY, room: 'candidates', title: 'How long did offers take last year?', tags: ['offers', 'waiting'],
        by: 'brisk marten 3', t: OLD, lastAt: OLD, lastBy: 'brisk marten 3', n: 1, excerpt: 'Weeks.', score: 4, pinned: false, locked: false, hidden: false } },
      { path: `${PT}/old-t1/posts/old-p1`, data: { season: PY, room: 'candidates', tid: 'old-t1', n: 1, by: 'brisk marten 3',
        body: 'Weeks, in my case. Three to five after the flyout.', t: OLD, up: 5, down: 1, quote: null, hidden: false, hiddenBy: '' } },
    ];
    const { ctx, page: q, errors } = await signedInPage(`forum.html?room=candidates&season=${PY}`,
      { user: CAND, docs: [CAND_PROFILE, ...SEEDED, ...archive], selector: '#oa-forum' });
    await q.waitForSelector('#oa-forum-list .oa-card', { timeout: 15000 });
    const arc = await q.evaluate(() => ({
      banner: document.getElementById('oa-forum-archive').hidden ? '' : document.getElementById('oa-forum-archive').textContent,
      ask: !!document.getElementById('oa-forum-askbtn'),
      handle: !!document.getElementById('oa-forum-myhandle'),
      seasons: [...document.querySelectorAll('#oa-forum-seasons a')].map((a) => a.className),
      newBadge: document.querySelectorAll('.oa-label-new').length,
      title: document.querySelector('#oa-forum-list .oa-card-title').textContent,
    }));
    ok(arc.banner.includes(`${PY - 1}-${PY} archive.`) && /Read-only/.test(arc.banner), 'forum (archive): the banner names the season and says read-only');
    ok(!arc.ask && !arc.handle, 'forum (archive): no Ask button and no "posting as" handle');
    eq(arc.seasons, ['', 'is-now'], 'forum (archive): the Seasons card lists this season and the archive, the archive marked as the one on screen');
    eq(arc.newBadge, 0, 'forum (archive): nothing in an archive is New');
    eq(arc.title, 'How long did offers take last year?', 'forum (archive): the old season\'s question is listed');
    await q.click('#oa-forum-list .oa-card .oa-card-head');
    await q.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    const at = await q.evaluate(() => ({
      votes: document.querySelectorAll('.oa-forum-v').length,
      score: document.querySelector('.oa-forum-score').textContent,
      updown: document.querySelector('.oa-forum-updown').textContent,
      reply: !!document.getElementById('oa-forum-body'),
      acts: document.querySelectorAll('button.oa-forum-act').length,
      accept: document.querySelectorAll('[data-act="accept"]').length,
      save: document.querySelectorAll('[data-act="save"]').length,
      note: document.getElementById('oa-forum-compose').textContent,
      threadVotes: window.__fb.ops('callable').filter((n) => n === 'forumThreadVotes').length,
      url: location.search,
    }));
    eq(at.votes, 0, 'forum (archive): a thread draws no vote button');
    ok(at.score === '+4' && at.updown === '5 / 1', 'forum (archive): the counts are still shown');
    ok(!at.reply && at.acts === 0 && /archived/.test(at.note), 'forum (archive): no answer box, no Quote or Edit, and the note says why');
    eq(at.accept, 0, 'forum (archive): and no tick, which the function would refuse: a closed season cannot answer who asked');
    ok(at.save > 0, 'forum (archive): the bookmark IS offered, since saving is this browser\'s own and writes nothing');
    eq(at.threadVotes, 0, 'forum (archive): forumThreadVotes is never asked for an archived thread');
    ok(new RegExp(`season=${PY}`).test(at.url), 'forum (archive): the season stays on the address through the navigation');
    eq(errors, [], 'forum (archive): no uncaught script error');
    await ctx.close();
  }

  /* -- forum mobile: rule 13, measured at 390px ------------------------------ */
  {
    const { ctx, page: m, errors } = await signedInPage('forum.html',
      { user: CAND, docs: [CAND_PROFILE, ...SEEDED], selector: '#oa-forum', viewport: { width: 390, height: 844 } });
    await m.waitForSelector('#oa-forum-list .oa-card', { timeout: 15000 });
    await m.waitForTimeout(200);
    /* the list: the same measure every list page is held to, plus the tabs */
    const mob = await m.evaluate(MOBILE_LIST_MEASURE);
    ok(assertMobileList(mob, 'forum mobile (list):'), 'forum mobile (list): the list has a filter bar to measure');
    const tabsM = await m.evaluate(() => ({
      tabH: [...document.querySelectorAll('.oa-forum-tab')].map((b) => Math.round(b.getBoundingClientRect().height)),
      askH: Math.round(document.getElementById('oa-forum-askbtn').getBoundingClientRect().height),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    ok(tabsM.tabH.length === 2 && tabsM.tabH.every((h) => h >= 42), `forum mobile (list): the room tabs are 42px targets (got ${tabsM.tabH})`);
    ok(tabsM.askH >= 42, `forum mobile (list): Ask a question is a 42px target (got ${tabsM.askH})`);
    eq(tabsM.overflowX, 0, 'forum mobile (list): no sideways scroll');

    /* one thread, with the reply box open */
    await m.click('#oa-forum-list .oa-card .oa-card-head');
    await m.waitForSelector('#oa-forum-thread .oa-forum-post.is-first', { timeout: 15000 });
    await m.waitForTimeout(200);
    const thM = await m.evaluate(() => {
      const h = (el) => Math.round(el.getBoundingClientRect().height);
      const vote = document.querySelector('.oa-forum-post.is-first .oa-forum-vote').getBoundingClientRect();
      const body = document.querySelector('.oa-forum-post.is-first .oa-forum-pbody').getBoundingClientRect();
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        votes: [...document.querySelectorAll('.oa-forum-v')].map(h),
        acts: [...document.querySelectorAll('.oa-forum-pacts .oa-forum-act')].map(h),
        marks: [...document.querySelectorAll('.oa-forum-save, button.oa-forum-acc')].map(h),
        voteAbove: vote.bottom <= body.top + 1,
        taFont: parseFloat(getComputedStyle(document.getElementById('oa-forum-body')).fontSize),
        send: h(document.getElementById('oa-forum-send')),
        sendRight: document.getElementById('oa-forum-send').getBoundingClientRect().right <= window.innerWidth,
      };
    });
    eq(thM.overflowX, 0, 'forum mobile (thread): no sideways scroll');
    ok(thM.votes.length === 2 && thM.votes.every((h) => h >= 42), `forum mobile (thread): like and dislike are 42px targets (got ${thM.votes})`);
    ok(thM.acts.length >= 3 && thM.acts.every((h) => h >= 42), `forum mobile (thread): Answer, Quote and the post link are 42px targets (got ${thM.acts})`);
    ok(thM.marks.length >= 1 && thM.marks.every((h) => h >= 42), `forum mobile (thread): the bookmark and the tick are 42px targets too (got ${thM.marks})`);
    ok(thM.voteAbove, 'forum mobile (thread): the vote column lies ABOVE the post on a phone, never in a gutter beside it');
    ok(thM.taFont >= 16, `forum mobile (thread): the reply textarea is 16px so iOS does not zoom (got ${thM.taFont}px)`);
    ok(thM.send >= 42 && thM.sendRight, `forum mobile (thread): Post your answer is a 42px target on screen (got ${thM.send})`);

    /* the ask form */
    await m.click('.oa-forum-crumbs a');
    await m.waitForSelector('#oa-forum-askbtn', { timeout: 15000 });
    await m.click('#oa-forum-askbtn');
    await m.waitForSelector('#oa-forum-askform', { timeout: 8000 });
    await m.waitForTimeout(200);
    const askM = await m.evaluate(() => {
      const f = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
      const h = (id) => Math.round(document.getElementById(id).getBoundingClientRect().height);
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        title: f('oa-forum-ask-title'), body: f('oa-forum-ask-body'), tag: f('oa-forum-tag-in'),
        send: h('oa-forum-ask-send'),
        cancel: Math.round(document.querySelector('.oa-forum-cancel').getBoundingClientRect().height),
      };
    });
    eq(askM.overflowX, 0, 'forum mobile (ask): no sideways scroll');
    ok(askM.title >= 16 && askM.body >= 16 && askM.tag >= 16,
      `forum mobile (ask): the title, details and tag inputs are 16px (got ${askM.title}/${askM.body}/${askM.tag})`);
    ok(askM.send >= 42 && askM.cancel >= 42, `forum mobile (ask): Post question and Cancel are 42px targets (got ${askM.send}/${askM.cancel})`);
    eq(errors, [], 'forum mobile: no uncaught script error');
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
