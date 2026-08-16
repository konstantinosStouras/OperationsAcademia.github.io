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
import { readFile } from 'node:fs/promises';
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
  const SHIM = await readFile(path.join(ROOT, 'v2', '_scraper', '_fake-firebase.js'), 'utf8');

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
