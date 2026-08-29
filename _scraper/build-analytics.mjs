#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — write data/analytics.json, the one file analytics.html
   plots.

       node _scraper/build-analytics.mjs [--dry-run] [--scan] [--selftest]

   THE PAGE USED TO BE FOUR IFRAMES AND THEY HAVE BEEN DEAD SINCE 2023. They
   pointed at Google Sheets `pubchart` charts whose spreadsheets were filled by
   the Google Analytics Spreadsheet Add-on, which spoke only the Universal
   Analytics Reporting API. UA stopped processing data on 1 July 2023 and the
   properties were deleted on 1 July 2024, so the add-on has been erroring for
   three years and the charts froze. A dead embed renders as an empty box and
   says nothing, which is why nobody noticed.

   THREE SOURCES, EACH INDEPENDENTLY GATED, each a clean no-op when its
   credential is absent — the discipline every builder here follows, so this
   can be committed and scheduled before anything is configured:

     history   data/analytics-history.json — which will never exist. The
               spreadsheets were read on 2026-08-29 and hold nothing; see
               _SETUP-ANALYTICS.md for the forensics. Kept as the recovery
               path, not as an outstanding task.
     usage     Firestore `usageSessions`, the site's own first-party record
               (assets/oa-usage.js, every page since 2026-08-17). Needs
               FIREBASE_SERVICE_ACCOUNT, which is already a secret here — so
               THIS IS THE SOURCE THAT WORKS TODAY, with nothing to set up.
     ga4       Google Analytics 4 through the Data API. Needs GA4_PROPERTY_ID
               and GA4_SERVICE_ACCOUNT. Inert until both are set.

   A DAY BELONGS TO EXACTLY ONE SOURCE (mergeDays, by SOURCE_ORDER). Two
   sources measuring the same Tuesday are two measurements of one number, and
   adding them would double every day of the overlap — a chart that looks
   right, moves in the right direction and is wrong by a factor of two.

   AN UNREACHABLE SOURCE CHANGES NOTHING. The committed file stands. That is
   the rule the tracking-sheet sync already applies to a workbook it cannot
   read, and it matters more here than there: this file is the whole page, so
   a half-written one is a blank dashboard, and a source that is merely down
   for an afternoon must not be able to produce one.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'analytics.json');
const META = path.join(DATA, 'analytics-meta.json');
const HISTORY = path.join(DATA, 'analytics-history.json');

/* The SAME definition the page loads, so a number cannot mean one thing here
   and another in the browser. */
const A = createRequire(import.meta.url)(path.join(ROOT, 'assets', 'oa-analytics-model.js'));

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

/** How many rows of each ranked list reach the served file. The tail of a
    pages report is a long list of one-view query strings, and this file is
    downloaded by every reader of the page. */
const TOP_PAGES = 25;
const TOP_UNIS = 120;
const RECENT_DAYS = 7;

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    warn(`could not parse ${path.basename(file)} (${e.message}) — ignoring it`);
    return fallback;
  }
}

/** Stable, diff-friendly JSON: two runs over unchanged inputs must produce
    byte-identical files, or the daily workflow commits noise for ever. Day
    keys are emitted in sorted order for the same reason. */
function serialise(data) {
  const days = {};
  for (const k of Object.keys(data.days).sort()) days[k] = data.days[k];
  return JSON.stringify({ ...data, days }, null, 1) + '\n';
}

const iso = (d) => d.toISOString().slice(0, 10);

/** Two serialised datasets carrying the same figures — `generated` blanked on
    both sides, because it moves on every run by construction and is the one
    field whose change means nothing happened. Compared as TEXT rather than by
    parsing, so a difference anywhere else in the file — a key order, a nested
    value, a field added later and forgotten here — still counts as a change.
    Missing a real change would be far worse than committing a spare stamp. */
function sameFigures(a, b) {
  const blank = (t) => t.replace(/"generated": "[^"]*"/, '"generated": ""');
  return blank(a) === blank(b);
}

/* ------------------------------------------------------------------ sources */

/** The committed archive of the years UA measured. Needs no credential and
    cannot fail the run: the file is absent permanently, which the page already
    knows how to say. Deliberately not "not imported YET" — there is nothing
    left to import, and framing a settled impossibility as a pending task is
    how a maintainer loses an afternoon. */
async function fromHistory() {
  const raw = await readJson(HISTORY, null);
  if (!raw) return null;
  return {
    source: 'history',
    days: raw.days || {},
    pages: raw.pages || [],
    universities: raw.universities || [],
    from: raw.from || '',
    to: raw.to || '',
  };
}

/** Credentials shared by both Google legs, tolerant of the base64 form the
    secret is commonly pasted in — the same handling build-jobs.mjs uses. */
function creds(envName) {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      warn(`${envName} is set but is neither JSON nor base64 JSON`);
      return null;
    }
  }
}

async function firestore() {
  const c = creds('FIREBASE_SERVICE_ACCOUNT');
  if (!c) return null;
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    warn('firebase-admin is not installed — run `npm i firebase-admin` in the workflow');
    return null;
  }
  const app = admin.default || admin;
  if (!app.apps.length) app.initializeApp({ credential: app.credential.cert(c) });
  return app.firestore();
}

/** The site's OWN record. One usageSessions document per browsing session:
    who (a uid, or a stable random per-browser id), which page, when it
    started, how long it lasted.

    A "visitor" here is a DISTINCT `uid` on that day and a "session" is a
    document, so the two numbers mean what they mean everywhere else on this
    page. Pageviews are counted per session document because each document is
    one page — oa-usage.js files a session per page, not per visit.

    It reads the days the dataset does not already hold, and never fewer than
    the dimension window below — so a daily run costs a bounded query rather
    than the whole collection, and the tallies it recomputes cover a stated
    span rather than whatever slice the incremental read happened to fetch. */
async function fromUsage(db, { since, windowFrom }) {
  if (!db) return null;
  const seen = new Map();        // day -> { uids:Set, sessions, views, pages:Map }
  let scanned = 0;
  let withheld = 0;              // sessions on admin / archived / test paths

  /* THE DIMENSIONS ARE WINDOWED AND THE DAYS ARE NOT, and that difference is
     the whole reason the read reaches back further than the incremental one.

     A day row can be merged with what is already served, so it is enough to
     re-read the few days that might still be moving. A TALLY cannot: adding
     this run's hour-of-day counts to the last run's would double every
     session in the overlap, and taking only the fresh ones would silently
     turn "when people read the site" into "when people read it this week".
     So the tallies are recomputed from scratch over one stated window every
     run, and the page prints the window under the chart. */
  const hours = A.hourBuckets();
  const winPages = new Map();
  let winSessions = 0, winSeconds = 0, winViews = 0;
  let winFrom = '', winTo = '';

  let q = db.collection('usageSessions').orderBy('start');
  if (since) q = q.where('start', '>=', since);

  const snap = await q.limit(50000).get();
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const started = Number(d.start || 0);
    if (!started) return;
    scanned++;
    const day = iso(new Date(started));
    if (!A.isDay(day)) return;

    /* NON-PUBLIC SESSIONS ARE DROPPED WHOLE, not merely left out of the pages
       list (owner, 2026-08-29). A session on the admin desk or in an archived
       tree is not "how the site is used" by anybody the public figures are
       about — counting its pageviews would put the maintainer's own admin time
       into a number this page publishes, which is the "admin-related data"
       half of the instruction. Dropping it here also means the path is never
       carried anywhere downstream, so it cannot leak through a field somebody
       adds later. A person who visits the admin desk AND public pages still
       counts, through those other sessions. */
    const page = A.normPath(d.page);
    if (!A.isPublicPath(page)) { withheld++; return; }

    let bucket = seen.get(day);
    if (!bucket) {
      bucket = { uids: new Set(), sessions: 0, views: 0 };
      seen.set(day, bucket);
    }
    if (d.uid) bucket.uids.add(String(d.uid));
    bucket.sessions++;
    bucket.views++;

    if (!windowFrom || started >= windowFrom) {
      /* the hour is read in UTC, exactly as the weekday buckets are: a local
         read shifts every bar for readers west of Greenwich, and unlike a
         weekday nobody would notice which way */
      hours[new Date(started).getUTCHours()].value++;
      winSessions++;
      winViews++;
      winSeconds += Math.max(0, Math.min(3600, Number(d.dur || 0)));
      if (page) {
        const acc = winPages.get(page) || { path: page, title: '', views: 0, sec: 0 };
        acc.views++;
        acc.sec += Math.max(0, Math.min(3600, Number(d.dur || 0)));
        winPages.set(page, acc);
      }
      /* the window REPORTED is the one the data actually covers, never the
         nominal ninety days. A nominal one slides every midnight and would
         rewrite the served file daily on a site nobody had visited */
      if (!winFrom || day < winFrom) winFrom = day;
      if (!winTo || day > winTo) winTo = day;
    }
  });

  const days = {};
  for (const [day, b] of seen) days[day] = [b.uids.size || b.sessions, b.sessions, b.views];

  return {
    source: 'usage',
    days,
    pages: Array.from(winPages.values())
      .map((p) => ({ path: p.path, title: '', views: p.views, avgSec: p.views ? p.sec / p.views : 0 })),
    pagesWindow: { from: winFrom, to: winTo },
    universities: [],
    breakdowns: {
      /* THE HOURS ARE THE FIRST-PARTY RECORD'S ALONE. It stamps the instant a
         session began, so the hour is exact; GA4 would answer the same
         question on the property's own clock, and one chart whose meaning
         changed time zone with its source would be worse than no chart. */
      hours: A.breakdown('hours', {
        source: 'usage', from: winFrom, to: winTo,
        metric: 'visits', zone: 'UTC', items: hours, limit: 24,
      }),
    },
    engagement: A.engagement({
      source: 'usage', from: winFrom, to: winTo,
      sessions: winSessions, seconds: winSeconds, views: winViews,
    }),
    scanned,
    withheld,
  };
}

/** Google Analytics 4, through the Data API.

    NOT the Reporting API the dead spreadsheet add-on used — that one was
    Universal Analytics' and no longer exists. This speaks
    `properties/<id>:runReport` with the OAuth2 JWT flow, over plain fetch, so
    it needs no dependency beyond google-auth-library for the token.

    THE UNIVERSITY DIMENSION IS NOT HERE, AND CANNOT BE. The old charts read
    UA's `networkDomain` / `networkLocation` — the visitor's reverse-DNS.
    **GA4 has no such dimension and no replacement**, so this leg returns no
    universities at all and the archive stays the only source of them.

    WHAT IT DOES ANSWER, and the first-party record cannot: where readers are,
    what they read on, and how they got here. The site's own record stores a
    page, an instant and a duration and asks nothing else, so those four
    dimensions have exactly one possible source and no precedence question
    arises. Each is a separate, bounded report; a report that fails is skipped
    and the rest of the leg still lands, because a country list is not worth a
    day of the daily figures.

    AND EVERY ONE OF THEM COUNTS SESSIONS, NEVER USERS. Running cookieless the
    tag keeps no identifier on the device, so GA4 cannot tell a returning
    reader from a new one and its `totalUsers` is nearly its session count.
    Publishing a country's number as "visitors" would be exactly the
    overstatement SOURCE_ORDER exists to avoid. The page says visits.

    GA4's `newVsReturning` IS DELIBERATELY NOT ASKED FOR, for the same reason:
    cookieless, it reports very nearly every session as new, so the figure
    would be a measurement of the tag's own configuration rather than of the
    readers. The first-party record COULD answer it — its per-browser id is
    stable — but only by reading the whole collection to find each browser's
    first day, which is exactly the unbounded read the incremental query is
    shaped to avoid. A figure that would be wrong from one source and
    expensive from the other is better not drawn than drawn with a caveat
    nobody reads. */
async function fromGa4({ since, windowFrom, windowTo }) {
  const propertyId = String(process.env.GA4_PROPERTY_ID || '').replace(/\D/g, '');
  const c = creds('GA4_SERVICE_ACCOUNT');
  if (!propertyId || !c) return null;

  let GoogleAuth;
  try {
    ({ GoogleAuth } = await import('google-auth-library'));
  } catch {
    warn('google-auth-library is not installed — run `npm i google-auth-library` in the workflow');
    return null;
  }

  const auth = new GoogleAuth({
    credentials: c,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  async function runReport(body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      /* 403 here is nearly always the one setup step people miss: the service
         account exists but was never granted Viewer ON THE PROPERTY. Say so,
         rather than printing a bare status. */
      const hint = res.status === 403
        ? ' — grant the service account Viewer on the GA4 property (Admin -> Property access management)'
        : '';
      throw new Error(`GA4 ${res.status}${hint}`);
    }
    return res.json();
  }

  const startDate = since ? iso(new Date(since)) : '2015-08-14';   // GA4's own floor
  const endDate = 'today';
  const winStart = iso(new Date(windowFrom));

  /* Ask GOOGLE to leave the non-public paths out, rather than fetching them
     and dropping them here. Applied to EVERY report, so the day totals are
     "visitors who read a public page", the pages list cannot carry an admin
     path even for the instant before it is filtered, and the dimension
     tallies describe the same population the rest of the page does.
     `A.NON_PUBLIC` is the same list the first-party leg uses; GA4 wants a
     string pattern, so each is handed over as its source without the anchors
     it cannot take. */
  const excludeAdmin = {
    notExpression: {
      orGroup: {
        expressions: [
          { filter: { fieldName: 'pagePath',
            stringFilter: { matchType: 'BEGINS_WITH', value: '/admin-area' } } },
          { filter: { fieldName: 'pagePath',
            stringFilter: { matchType: 'FULL_REGEXP', value: '^/v[0-9]+(/|$)' } } },
          { filter: { fieldName: 'pagePath',
            stringFilter: { matchType: 'FULL_REGEXP', value: '^/(test|tests|preview|staging|sandbox|_)' } } },
        ],
      },
    },
  };

  const daily = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
    dimensionFilter: excludeAdmin,
    limit: 100000,
  });

  const days = {};
  for (const row of daily.rows || []) {
    const raw = (row.dimensionValues?.[0]?.value || '');          // YYYYMMDD
    if (!/^\d{8}$/.test(raw)) continue;
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const v = row.metricValues || [];
    const built = A.dayRow(Number(v[0]?.value), Number(v[1]?.value), Number(v[2]?.value));
    if (built) days[day] = built;
  }

  /* The window this leg's tallies really cover: the ninety-day ask, clipped to
     the days GA4 actually holds. Reported rather than the nominal span for the
     same reason the first-party leg reports its own — a nominal window slides
     at every midnight and would rewrite the served file daily on a site
     nobody had visited. */
  const known = Object.keys(days).sort();
  const inWindow = known.filter((d) => d >= winStart && (!windowTo || d <= windowTo));
  const winFrom = inWindow[0] || '';
  const winTo = inWindow[inWindow.length - 1] || '';

  const paged = await runReport({
    dateRanges: [{ startDate: winStart, endDate }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    dimensionFilter: excludeAdmin,
    limit: 200,
  });

  const pages = [];
  for (const row of paged.rows || []) {
    const p = row.dimensionValues?.[0]?.value || '';
    const views = Number(row.metricValues?.[0]?.value || 0);
    const secs = Number(row.metricValues?.[1]?.value || 0);
    if (!p || !views) continue;
    pages.push({
      path: A.normPath(p),
      title: row.dimensionValues?.[1]?.value || '',
      views,
      avgSec: views ? secs / views : 0,
    });
  }

  /** One dimension, ranked by sessions over the window. Non-fatal on its own:
      a country list that 500s must not cost the daily figures, which have
      already been fetched above. */
  async function dimension(name, limit) {
    try {
      const res = await runReport({
        dateRanges: [{ startDate: winStart, endDate }],
        dimensions: [{ name }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        dimensionFilter: excludeAdmin,
        limit,
      });
      return (res.rows || []).map((row) => ({
        name: row.dimensionValues?.[0]?.value || '',
        value: Number(row.metricValues?.[0]?.value || 0),
      }));
    } catch (e) {
      warn(`the GA4 ${name} report failed (${e.message}) — that figure is skipped`);
      return [];
    }
  }

  /* The four dimensions, and the size of each ask. The LIMIT here is not the
     number the page draws — it is how much of the tail is counted, so that a
     share is a share of everything rather than of the rows that fitted. */
  const [countries, devices, channels, referrers] = await Promise.all([
    dimension('country', 300),
    dimension('deviceCategory', 10),
    dimension('sessionDefaultChannelGroup', 30),
    dimension('sessionSource', 100),
  ]);

  const win = { from: winFrom, to: winTo };
  const breakdowns = {
    countries: A.breakdown('countries', { source: 'ga4', ...win, items: countries, limit: 12 }),
    devices: A.breakdown('devices', { source: 'ga4', ...win, items: devices, limit: 6 }),
    channels: A.breakdown('channels', { source: 'ga4', ...win, items: channels, limit: 6 }),
    referrers: A.breakdown('referrers', { source: 'ga4', ...win, items: referrers, limit: 10 }),
  };

  /* How long a visit lasts, and how much of the site it covers. GA4 reports
     the mean directly, so the seconds are multiplied back out — the model
     divides again, which keeps ONE definition of the average rather than two
     that could drift. */
  let engagement = null;
  try {
    const eng = await runReport({
      dateRanges: [{ startDate: winStart, endDate }],
      metrics: [{ name: 'sessions' }, { name: 'averageSessionDuration' },
        { name: 'screenPageViews' }],
      dimensionFilter: excludeAdmin,
      limit: 1,
    });
    const m = eng.rows?.[0]?.metricValues || [];
    const sessions = Number(m[0]?.value || 0);
    engagement = A.engagement({
      source: 'ga4', ...win,
      sessions,
      seconds: Number(m[1]?.value || 0) * sessions,
      views: Number(m[2]?.value || 0),
    });
  } catch (e) {
    warn(`the GA4 engagement report failed (${e.message}) — that figure is skipped`);
  }

  return {
    source: 'ga4', days, pages, pagesWindow: win,
    universities: [], breakdowns, engagement,
  };
}

/* ---------------------------------------------------------------------- main */

/** Assemble the served dataset from whatever answered. Pure given its inputs,
    so the selftest can drive the whole shape with no network at all. */
export function assemble(results, { now = Date.now(), carry = null } = {}) {
  const data = A.emptyDataset();
  data.generated = new Date(now).toISOString();

  const live = results.filter(Boolean);
  /* highest authority first — mergeDays keeps the first claim on each day */
  const ordered = A.SOURCE_ORDER
    .map((id) => live.find((r) => r.source === id))
    .filter(Boolean);

  const pages = new Map();
  const unis = new Map();
  const breakdowns = {};
  let engagement = null;
  let pagesWindow = null;
  for (const r of ordered) {
    const record = A.mergeDays(data.days, r.days, r.source);
    const before = pages.size;
    A.mergePages(pages, r.pages);
    /* ONE SOURCE OWNS EACH DIMENSION, WHOLE — the first claim stands, and a
       later source is ignored rather than merged into it. See the model: two
       systems counting "visits from Germany" disagree about what a visit and
       a country are, so an assembled answer measures nothing. */
    for (const id of A.BREAKDOWN_IDS) {
      A.mergeBreakdown(breakdowns, id, (r.breakdowns || {})[id]);
    }
    if (!engagement && r.engagement) engagement = r.engagement;
    /* the window belongs to whichever source's pages actually got in */
    if (!pagesWindow && r.pagesWindow && pages.size > before) {
      pagesWindow = { source: r.source, from: r.pagesWindow.from || '', to: r.pagesWindow.to || '' };
    }
    for (const u of r.universities || []) {
      const name = String((u && u.name) || '').trim();
      if (!name || unis.has(name)) continue;
      unis.set(name, { name, visits: Math.max(0, Math.round(Number(u.visits) || 0)) });
    }
    /* a leg that contributed nothing AND names no range is the empty-file
       fallback, not a source anyone consulted — listing it would have the
       page report an archive that is not there */
    if (record.days || r.from) data.sources.push({ ...record, from: r.from || '', to: r.to || '' });
  }
  data.sources = A.orderSources(data.sources);

  /* WHAT WAS ALREADY SERVED, folded in last and claiming only what nothing
     else did. This is what makes an unreachable source cost a day of freshness
     rather than the whole history: a run in which GA4 times out still writes
     every day GA4 had already given us.

     IT IS NOT A SOURCE, AND THAT DISTINCTION IS THE BUG THIS FIXES. It used to
     be re-offered to assemble() as a `history` LEG whenever nothing answered,
     which meant a credential-less run rewrote the file claiming the ARCHIVE
     had supplied days the first-party record supplied — false provenance, and
     a `sources` block that flip-flopped between 'usage' and 'history' on
     alternate runs, committing churn each time. The carried data keeps
     whatever `sources` the previous file recorded, because nothing about
     where those numbers came from has changed. */
  if (carry) {
    A.mergeDays(data.days, carry.days || {}, 'carried');
    const beforeCarry = pages.size;
    A.mergePages(pages, carry.pages || []);
    for (const id of A.BREAKDOWN_IDS) {
      A.mergeBreakdown(breakdowns, id, (carry.breakdowns || {})[id]);
    }
    if (!engagement && carry.engagement) engagement = carry.engagement;
    if (!pagesWindow && carry.pagesWindow && pages.size > beforeCarry) {
      pagesWindow = carry.pagesWindow;
    }
    for (const u of carry.universities || []) {
      const name = String((u && u.name) || '').trim();
      if (!name || unis.has(name)) continue;
      unis.set(name, { name, visits: Math.max(0, Math.round(Number(u.visits) || 0)) });
    }
    /* only when NOTHING live answered: with a live source present its own
       record is the true one, and the carried label would overstate it */
    if (!data.sources.length) data.sources = (carry.sources || []).slice();
  }

  data.pages = A.topPages(pages, TOP_PAGES);
  data.pagesWindow = pagesWindow || { source: '', from: '', to: '' };
  data.breakdowns = breakdowns;
  data.engagement = engagement;

  const uniRows = Array.from(unis.values()).sort((a, b) => b.visits - a.visits);
  const hist = live.find((r) => r.source === 'history');
  data.universities = {
    /* FROZEN, and the page says so: UA's networkDomain is the only thing that
       ever produced this and it no longer exists in any product — and since
       2026-08-29 the archived copy is known to be empty as well. */
    frozen: true,
    from: (hist && hist.from) || (carry && carry.from) || '',
    to: (hist && hist.to) || (carry && carry.to) || '',
    all: uniRows.slice(0, TOP_UNIS),
    recent: [],
  };

  const rows = A.series(data.days);
  const totals = A.summarise(rows);
  data.totals = {
    visitors: totals.visitors,
    sessions: totals.sessions,
    pageviews: totals.pageviews,
    days: totals.days,
    universities: uniRows.length,
  };
  data.range = { from: totals.from, to: totals.to };
  data.recentDays = RECENT_DAYS;
  return data;
}

async function main() {
  if (argv.has('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const previous = await readJson(OUT, A.emptyDataset());

  /* Only ask the live sources for what the dataset does not already hold —
     minus a week, so a day that was still being written when the last run
     read it is recomputed rather than frozen half-counted. */
  const lastDay = A.series(previous.days || {}).slice(-1)[0];
  const incremental = lastDay
    ? Date.parse(lastDay.day + 'T00:00:00Z') - 7 * 86400000
    : 0;

  /* THE DIMENSION WINDOW, and why the read reaches back to it even when the
     incremental one would not. A day row merges with what is already served;
     a TALLY does not — adding this run's hour-of-day counts to the last run's
     would double every session in the overlap, and taking only the fresh ones
     would turn "when people read the site" into "when people read it this
     week". So the tallies are recomputed from scratch over one window every
     run. Ninety days is long enough to be a season and short enough that the
     read stays bounded as the site grows. */
  const windowFrom = Date.now() - A.BREAKDOWN_DAYS * 86400000;
  const since = Math.min(incremental || windowFrom, windowFrom);

  const results = [];

  const history = await fromHistory();
  if (history) {
    log(`history: ${Object.keys(history.days).length} day(s), ` +
      `${history.universities.length} universit(y/ies) — frozen archive`);
    results.push(history);
  } else {
    /* not a to-do: the archive was checked on 2026-08-29 and is empty for
       good, so this line says so rather than pointing at a setup step */
    log('history: no archive file (the 2014-2023 data is gone — _SETUP-ANALYTICS.md)');
  }

  const db = await firestore();
  if (db) {
    try {
      const usage = await fromUsage(db, { since, windowFrom });
      log(`usage: ${usage.scanned} session document(s) -> ${Object.keys(usage.days).length} day(s)` +
        (usage.withheld ? `, ${usage.withheld} withheld (admin / archived / test paths)` : ''));
      results.push(usage);
    } catch (e) {
      warn(`the first-party usage read failed (${e.message}) — keeping what is committed`);
    }
  } else {
    log('usage: no FIREBASE_SERVICE_ACCOUNT in this environment — skipped');
  }

  try {
    const ga4 = await fromGa4({ since, windowFrom, windowTo: iso(new Date()) });
    if (ga4) {
      const dims = A.BREAKDOWN_IDS.filter((id) => (ga4.breakdowns || {})[id]);
      log(`ga4: ${Object.keys(ga4.days).length} day(s), ${ga4.pages.length} page(s)` +
        (dims.length ? `, ${dims.join(' / ')}` : ', no dimension answered'));
      results.push(ga4);
    } else {
      log('ga4: GA4_PROPERTY_ID / GA4_SERVICE_ACCOUNT are not set — skipped');
    }
  } catch (e) {
    warn(`the GA4 read failed (${e.message}) — keeping what is committed`);
  }

  /* Everything already served is the floor — carried as DATA, never as a
     source (see assemble). A run in which nothing answered therefore rewrites
     byte-for-byte what it read, which is what lets this workflow fire on a
     schedule in an environment that may or may not hold the credentials. */
  const data = assemble(results, {
    carry: {
      days: previous.days || {},
      pages: previous.pages || [],
      /* carried for the same reason the days are: a source that timed out this
         afternoon must cost a day of freshness, never the figure itself */
      pagesWindow: previous.pagesWindow || null,
      breakdowns: previous.breakdowns || {},
      engagement: previous.engagement || null,
      universities: (previous.universities && previous.universities.all) || [],
      from: (previous.universities && previous.universities.from) || '',
      to: (previous.universities && previous.universities.to) || '',
      sources: previous.sources || [],
    },
  });

  const rows = A.series(data.days);
  const summary = A.summarise(rows);

  if (SCAN || DRY) {
    log(`\n${rows.length} day(s) ${summary.from || '—'} .. ${summary.to || '—'}`);
    log(`${summary.visitors} visitor(s), ${summary.pageviews} pageview(s)`);
    log(`${data.pages.length} page(s), ${data.universities.all.length} universit(y/ies)`);
    for (const id of A.BREAKDOWN_IDS) {
      const b = data.breakdowns[id];
      if (b) log(`  ${id}: ${b.items.length} of ${b.total} ${b.metric} (${b.source}` +
        `${b.from ? ', ' + b.from + ' .. ' + b.to : ''})`);
    }
    if (data.engagement) {
      log(`  engagement: ${data.engagement.avgSessionSec}s a visit, ` +
        `${data.engagement.viewsPerSession} page(s) (${data.engagement.source})`);
    }
    if (SCAN) return 0;
  }

  const body = serialise(data);
  const before = existsSync(OUT) ? await readFile(OUT, 'utf8') : '';

  /* COMPARE WITHOUT THE TIMESTAMP. `generated` is stamped fresh on every run,
     so a literal `body === before` is never true and this workflow would
     commit a timestamp-only change every single day for ever — exactly the
     noise `serialise` says it exists to prevent, defeated one line later.
     What decides whether there is anything to write is whether any FIGURE
     moved; if none did, the committed file stands, stamp and all. */
  if (before && sameFigures(body, before)) {
    log('data/analytics.json is unchanged (only its timestamp would move).');
    return 0;
  }
  if (DRY) {
    log('--dry-run: nothing written.');
    return 0;
  }

  await writeFile(OUT, body);
  await writeFile(META, JSON.stringify({
    generated: data.generated,
    sources: data.sources,
    days: summary.days,
    from: summary.from,
    to: summary.to,
    visitors: summary.visitors,
    pageviews: summary.pageviews,
  }, null, 1) + '\n');
  log(`wrote data/analytics.json — ${summary.days} day(s), ${summary.visitors} visitor(s).`);
  return 0;
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => (c ? pass++ : fails.push(what));

  const hours = A.hourBuckets();
  hours[9].value = 12;
  const a = assemble([
    { source: 'usage', days: { '2026-08-02': [99, 99, 99], '2026-08-03': [7, 8, 20] },
      pages: [{ path: '/jobs.html', views: 5, avgSec: 10 }],
      pagesWindow: { from: '2026-08-02', to: '2026-08-03' },
      breakdowns: {
        hours: A.breakdown('hours', { source: 'usage', items: hours, limit: 24 }),
        /* the first-party record has no idea where a reader is; if it ever
           claimed to, this is the line that would say so */
        countries: A.breakdown('countries', { source: 'usage', items: [{ name: 'Nowhere', value: 1 }] }),
      },
      engagement: A.engagement({ source: 'usage', sessions: 10, seconds: 1000, views: 25 }),
      universities: [] },
    { source: 'ga4', days: { '2026-08-01': [10, 12, 30], '2026-08-02': [5, 6, 14] },
      pages: [{ path: '/jobs.html', views: 500, avgSec: 90 }],
      pagesWindow: { from: '2026-05-01', to: '2026-08-03' },
      breakdowns: {
        countries: A.breakdown('countries', {
          source: 'ga4', items: [{ name: 'United States', value: 40 }, { name: 'Ireland', value: 10 }] }),
        devices: A.breakdown('devices', {
          source: 'ga4', items: [{ name: 'desktop', value: 30 }, { name: 'mobile', value: 20 }] }),
      },
      engagement: A.engagement({ source: 'ga4', sessions: 100, seconds: 100, views: 100 }),
      universities: [] },
    { source: 'history', days: { '2015-01-01': [3, 3, 9] }, pages: [], universities: [{ name: 'Duke University', visits: 40 }], from: '2014-03-01', to: '2023-06-30' },
  ]);

  ok(a.days['2026-08-02'][0] === 99, 'the higher-authority source keeps a contested day');
  ok(a.totals.visitors === 10 + 99 + 7 + 3, 'a contested day is counted ONCE, never summed');
  ok(a.pages[0].views === 5, 'the higher-authority source owns a contested page');
  ok(a.universities.frozen === true, 'the universities section is marked frozen');
  ok(a.universities.from === '2014-03-01', 'the frozen section carries the archive range');
  ok(a.range.from === '2015-01-01' && a.range.to === '2026-08-03', 'the range spans every source');
  ok(a.sources.map((s) => s.source).join(',') === 'usage,ga4,history',
    'the sources are listed in precedence order');

  /* --- one source owns a DIMENSION, whole ------------------------------- */

  ok(a.breakdowns.countries.source === 'usage' && a.breakdowns.countries.total === 1,
    'a contested dimension goes WHOLE to the higher-authority source — never ' +
    'merged with the other, because two systems counting "visits from Germany" ' +
    'do not agree about what a visit or a country is');
  ok(a.breakdowns.devices.source === 'ga4',
    '…and a dimension only one source has is taken from that source');
  ok(a.breakdowns.hours.items.length === 24 && a.breakdowns.hours.items[9].value === 12,
    'the hours keep clock order rather than being ranked — 24 buckets, 09:00 where ' +
    'it belongs');
  ok(a.engagement.source === 'usage' && a.engagement.avgSessionSec === 100,
    'engagement likewise belongs to one source, and it is the higher one');
  ok(a.pagesWindow.source === 'usage' && a.pagesWindow.from === '2026-08-02',
    'and the window reported for the pages is the window of whichever source ' +
    'actually supplied them — the figure and its span cannot come from ' +
    'different places');

  /* an id the model does not know is not a shape anybody has checked, and this
     file is world-readable */
  ok(A.breakdown('whatever', { source: 'ga4', items: [{ name: 'x', value: 1 }] }) === null,
    'a dimension nobody declared is never built');
  const only = {};
  A.mergeBreakdown(only, 'devices', A.breakdown('devices', { source: 'ga4', items: [{ name: 'a', value: 1 }] }));
  A.mergeBreakdown(only, 'devices', A.breakdown('devices', { source: 'usage', items: [{ name: 'b', value: 99 }] }));
  ok(only.devices.source === 'ga4',
    'and a later claim on a dimension is refused rather than preferred for ' +
    'being larger');

  /* an empty build is a VALID file, not a crash: the page has to have
     something to fetch before anything is configured */
  const e = assemble([]);
  ok(e.totals.days === 0 && Object.keys(e.days).length === 0, 'an unconfigured build is still valid');
  ok(Array.isArray(e.dayFields) && e.dayFields.length === 3, 'the empty file is self-describing');

  /* a source that was unreachable this run must cost a day of freshness, not
     the history — the failure that would turn one timed-out request into a
     blank dashboard */
  const c = assemble(
    [{ source: 'ga4', days: { '2026-08-04': [9, 9, 9] }, pages: [], universities: [] }],
    { carry: { days: { '2026-08-01': [10, 12, 30], '2026-08-04': [1, 1, 1] } } });
  ok(c.totals.days === 2, 'the days already served are carried forward');
  ok(c.days['2026-08-04'][0] === 9, 'a fresh reading still beats the carried one');

  /* A RUN THAT READS NOTHING REWRITES EXACTLY WHAT IT READ. The carried data
     is not a SOURCE: it used to be re-offered as a `history` leg whenever no
     credential was present, so a credential-less run relabelled the file's
     provenance from 'usage' to 'history' — days the first-party record had
     supplied, attributed to an archive that is empty — and the two kinds of
     run then flip-flopped the committed file between them, every day. */
  const run1 = assemble(
    [{ source: 'usage', days: { '2026-08-20': [10, 12, 30] },
       pages: [{ path: '/jobs.html', views: 5, avgSec: 10 }],
       pagesWindow: { from: '2026-08-20', to: '2026-08-20' },
       breakdowns: {
         countries: A.breakdown('countries', { source: 'ga4', items: [{ name: 'Ireland', value: 3 }] }),
       },
       engagement: A.engagement({ source: 'usage', sessions: 2, seconds: 120, views: 5 }),
       universities: [] }],
    { now: 0 });
  const run2 = assemble([], { now: 0, carry: {
    days: run1.days, pages: run1.pages, pagesWindow: run1.pagesWindow,
    breakdowns: run1.breakdowns, engagement: run1.engagement,
    universities: run1.universities.all, from: run1.universities.from,
    to: run1.universities.to, sources: run1.sources,
  } });
  ok(JSON.stringify(run1) === JSON.stringify(run2),
    'a run with NO source rewrites byte-for-byte what it read');
  ok(run2.sources.length === 1 && run2.sources[0].source === 'usage',
    '…keeping the provenance it was given, rather than claiming the archive supplied it');
  ok(run2.pages.length === 1 && run2.totals.days === 1,
    '…and carrying the pages and days rather than blanking them');
  ok(run2.breakdowns.countries && run2.engagement && run2.pagesWindow.from === '2026-08-20',
    '…the dimensions, the engagement figure and the window with them: a source ' +
    'that was down this afternoon must cost a day of freshness, never a chart');

  /* two runs over the same inputs must be byte-identical or the daily
     workflow commits noise for ever */
  const s1 = serialise(assemble([{ source: 'ga4', days: { '2026-08-02': [5, 6, 14], '2026-08-01': [1, 1, 1] }, pages: [], universities: [] }], { now: 0 }));
  const s2 = serialise(assemble([{ source: 'ga4', days: { '2026-08-01': [1, 1, 1], '2026-08-02': [5, 6, 14] }, pages: [], universities: [] }], { now: 0 }));
  ok(s1 === s2, 'the serialiser is stable whatever order the days arrived in');

  /* the daily-churn guard: only a moved FIGURE is a change, never the stamp */
  const base = serialise(assemble([{ source: 'usage', days: { '2026-08-20': [1, 1, 1] }, pages: [], universities: [] }], { now: 0 }));
  const later = serialise(assemble([{ source: 'usage', days: { '2026-08-20': [1, 1, 1] }, pages: [], universities: [] }], { now: 86400000 }));
  ok(base !== later, 'the stamp really does move between runs (or the next check is vacuous)');
  ok(sameFigures(base, later),
    'a run whose figures did not move is NOT a change — otherwise the daily ' +
    'workflow commits a timestamp every day for ever');
  const moved = serialise(assemble([{ source: 'usage', days: { '2026-08-20': [2, 1, 1] }, pages: [], universities: [] }], { now: 0 }));
  ok(!sameFigures(base, moved), 'but a moved figure IS a change');

  console.log(`build-analytics selftest: ${pass} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  return !fails.length;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error('::error::' + e.stack);
    process.exit(1);
  });
}
