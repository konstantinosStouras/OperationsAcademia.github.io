/* ---------------------------------------------------------------------------
   Operations Academia — what the analytics page plots, and where a number is
   allowed to come from. Pure, dual-mode (browser `window.OAAnalytics`, Node
   `import`), so the builder, the page and the selftest cannot disagree about
   the shape of one day.

   WHY THIS FILE EXISTS AT ALL. analytics.html used to be four <iframe>s
   pointing at Google Sheets `pubchart` charts, and the spreadsheets behind
   them were filled by the Google Analytics Spreadsheet Add-on — which spoke
   ONLY the Universal Analytics Reporting API. Google stopped processing UA
   data on 1 July 2023 and deleted the properties themselves a year later, so
   the add-on's scheduled refresh has been erroring since 2023 and the charts
   have been frozen or blank ever since. Nothing on the page said so: a dead
   embed renders as an empty box, which is exactly the failure shape this
   repository keeps a whole section of CLAUDE.md about.

   So the page draws its own charts now, from ONE served file this builds.

   THE THREE SOURCES, AND WHY A DAY BELONGS TO EXACTLY ONE OF THEM.

     history   data/analytics-history.json — and it will never exist. The
               spreadsheets were exported and read on 2026-08-29: all 30 tabs,
               141,540 rows, not one surviving measurement. Their own cells say
               why (every report tab: "Last Run On 2024-07-15, Total Results
               Found 0") — Google deleted the UA property on 1 July 2024 and
               the add-on's next run wrote zero rows over ten years of data.
               The leg stays wired as the recovery path if a copy ever
               surfaces, and because assemble() selects sources THROUGH
               SOURCE_ORDER, so removing the name would break the archive leg
               rather than tidy it.
     usage     the site's OWN first-party record — usageSessions in Firestore,
               written by assets/oa-usage.js on every page since 2026-08-17.
               No cookies, no third party, and the credential it needs
               (FIREBASE_SERVICE_ACCOUNT) is already a secret here.
     ga4       Google Analytics 4, through the Data API. Inert until a
               property id and a service account are configured.

   `mergeDays` picks ONE source per day by SOURCE_ORDER and never adds two
   together. That is the whole correctness argument: two sources measuring the
   same Tuesday are two measurements of one number, not two numbers, and
   summing them would silently double every day of the overlap — a chart that
   looks fine, moves in the right direction, and is wrong by a factor of two.

   THE UNIVERSITIES ARE A FOURTH MEASUREMENT, not a fourth day-source, and
   they are LIVE AGAIN. They came from UA's `networkDomain` — the visitor's
   reverse-DNS — and GA4 has no such dimension, from which it was concluded
   here that the figures could never be shown again. That was wrong, and the
   owner said so. A BROWSER cannot see its own reverse-DNS; a server can, and
   this site has Cloud Functions, so it now resolves the address itself and
   keeps a counter per day per university (assets/oa-netorg.js,
   `recordVisit` in _functions/index.js). `frozen` therefore means what it
   always should have: this section is an ARCHIVE of a closed period rather
   than the current record — and the two are never merged, because they count
   different decades under different rules.
   --------------------------------------------------------------------------- */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OAAnalytics = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* A day row is [visitors, sessions, pageviews]. An ARRAY rather than an
     object because the file carries one entry per day and is downloaded by
     every reader of the page: `{"v":3,"s":4,"p":11}` is a little over twice
     the bytes of `[3,4,11]` for the same three numbers, and the record grows
     by a row a day for as long as the site runs. (It was originally justified
     by a decade of history back to 2014 — that history turned out to be gone,
     but a row a day is still a row a day, so the shape stands on the reason
     it has rather than the one it was given.) DAY_FIELDS is published inside
     the file itself, so the shape is self-describing rather than something a
     reader has to come here to learn. */
  const DAY_FIELDS = ['visitors', 'sessions', 'pageviews'];

  /* Highest authority first, and the order CHANGED when GA4 was switched on
     cookieless (owner, 2026-08-29: add GA4, but no consent banner).

     `client_storage: 'none'` in assets/oa-ga4.js keeps nothing on the
     visitor's device, which is what removes the need for a banner — and it
     also removes GA4's only means of recognising a returning visitor. Its
     `totalUsers` is then far closer to "sessions" than to "people", and a day
     it owned would report two or three times the visitors the same day really
     had. The site's own record keeps a stable per-browser id and CAN count
     distinct visitors, so it goes first.

     GA4 still earns its place second: it sees visitors whose browser never
     reaches Firestore at all — an ad blocker, a private window with storage
     refused, a network that cannot — which the first-party record silently
     misses. Coverage, not identity.

     The archive is last: a different measurement system altogether, covering
     years neither of the other two can (and, since 2024-07-15, holding
     nothing — its own add-on overwrote it with empty results).

     IF COOKIELESS IS EVER TURNED OFF, put 'ga4' back in front: with an
     identifier on the device it becomes the better count of people as well as
     the wider one. The two decisions belong together. */
  const SOURCE_ORDER = ['usage', 'ga4', 'history'];

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /* How long the dataset may go without gaining a day before the page says so.
     Three weeks, matching the tracking sheet's own staleness rule: a pipeline
     that has quietly stopped looks exactly like a quiet summer from outside,
     and the whole reason the old charts survived three years dead is that
     nothing anywhere said which of the two it was. */
  const STALE_DAYS = 21;

  /* --------------------------------------------------- the DIMENSION records

     Everything above answers "how many, and when". These answer "who, from
     where, on what, and at what hour" — the questions a job-market site
     actually wants of its own traffic, and the ones the page had no figure
     for at all.

     EACH DIMENSION IS ASKED OF THE SOURCE THAT CAN ANSWER IT, AND OF ONE
     SOURCE ONLY. That is the day rule again, and it bites harder here: two
     analytics systems counting the same Tuesday at least agree about what a
     Tuesday is, where two systems counting "sessions from Germany" disagree
     about the boundary of a session, the meaning of a country and the clock
     the hour is read on. Adding those, or preferring the larger, would
     produce a number that is not a measurement of anything.

     The split falls out of what each source HAS, so it needs no arbitration:

       hours       the site's OWN record. It stamps every session with the
                   instant it began, so the hour is exact and it is UTC.
                   Deliberately NOT also asked of GA4: GA4 reports `hour` in
                   the property's own reporting time zone, and one chart whose
                   meaning silently changed clocks with its source would be
                   worse than no chart.
       countries   GA4, and only GA4. The first-party record never asks where
                   a reader is — it stores a page, an instant and a duration —
                   so there is nothing here to prefer it for.
       devices     GA4. Same reason.
       channels    GA4 (`sessionDefaultChannelGroup`): search, direct,
                   referral, social, e-mail.
       referrers   GA4 (`sessionSource`): which site sent them.

     AND EVERY GA4 DIMENSION COUNTS VISITS, NEVER VISITORS. Running cookieless
     (assets/oa-ga4.js), GA4 keeps no identifier on the device and therefore
     cannot tell a returning reader from a new one — its `totalUsers` is much
     nearer "sessions" than "people". Calling a country's number "visitors"
     would be exactly the overstatement SOURCE_ORDER exists to avoid, so these
     records carry `metric: 'visits'` and the page says visits. */

  /* Every dimension record, and the top pages beside them, describes a
     TRAILING WINDOW rather than all of time, and each record states its own.

     That is not a preference — it is what makes the figure recomputable. A
     dimension tally cannot be accumulated across runs the way days can: the
     builder re-reads an overlapping slice every time (so a day still being
     written is not frozen half-counted), and adding this run's tally to the
     last one would double every session in the overlap. So each run computes
     these from scratch over one stated window, and the page prints the window
     under the chart. Ninety days is long enough to be a season and short
     enough that the read stays bounded as the site grows.

     IT ALSO FIXES A LATENT BUG IN THE PAGES FIGURE. `pages` was built from
     whatever slice the incremental read happened to fetch — seven days, on
     every run after the first — while the tiles beside it described the whole
     record, and nothing on screen said the two meant different spans. */
  const BREAKDOWN_DAYS = 90;

  /* The dimension records the file may carry, in the order the page draws
     them. A record for anything not on this list is dropped rather than
     served: this file is world-readable, and "whatever a source sent" is not
     a shape anybody has checked. */
  const BREAKDOWN_IDS = ['hours', 'countries', 'devices', 'channels', 'referrers'];

  /* 00..23. Strings, so the file and the axis agree about "09" without
     anybody re-padding it, and so an hour is never mistaken for a count. */
  const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

  const isDay = (s) => typeof s === 'string' && DAY_RE.test(s);

  const num = (n) => (typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : 0);

  /** A day row from whatever a source handed us, or null when there is no
      measurement in it at all. A row of three zeroes is dropped rather than
      stored: the file would otherwise carry a decade of days that only say
      "we have no idea", and the charts would plot them as real zeroes. */
  function dayRow(v, s, p) {
    const row = [num(v), num(s), num(p)];
    return row[0] || row[1] || row[2] ? row : null;
  }

  /** The valid empty dataset. Committed as-is before any source is switched
      on, so the page has something to fetch and renders its honest "nothing
      is being measured yet" state rather than a failed request. */
  function emptyDataset() {
    return {
      version: 1,
      generated: '',
      dayFields: DAY_FIELDS.slice(),
      sources: [],
      days: {},
      pages: [],
      /* which window `pages` describes — see BREAKDOWN_DAYS. Empty until a
         source has supplied one, and the figure says so rather than letting
         the tiles above it imply a span it does not have. */
      /* `views` is the window's WHOLE pageview count — what a page's share is
         a share OF. Zero until a source states it, and a share is simply not
         claimed without it. */
      pagesWindow: { source: '', from: '', to: '', views: 0 },
      breakdowns: {},
      engagement: null,
      universities: { frozen: true, from: '', to: '', all: [], recent: [] },
      totals: { visitors: 0, sessions: 0, pageviews: 0, days: 0, universities: 0 },
    };
  }

  /** Merge one source's days into an accumulator, HIGHEST AUTHORITY FIRST.
      A day already claimed by an earlier (higher) source is left exactly as
      it is — never added to, never averaged with. Returns the number of days
      this source actually contributed, which is what the run log reports and
      what makes an overlap visible instead of silent. */
  function mergeDays(into, days, source) {
    let added = 0;
    for (const key of Object.keys(days || {})) {
      if (!isDay(key)) continue;
      if (Object.prototype.hasOwnProperty.call(into, key)) continue;
      const raw = days[key];
      const row = Array.isArray(raw) ? dayRow(raw[0], raw[1], raw[2])
        : dayRow(raw && raw.visitors, raw && raw.sessions, raw && raw.pageviews);
      if (!row) continue;
      into[key] = row;
      added++;
    }
    return { source, days: added };
  }

  /** Sort the source records into the order they were consulted, so the file
      lists them the way the precedence reads. */
  function orderSources(list) {
    return (list || []).slice().sort(
      (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  }

  /* ------------------------------------------- what the public may be shown

     Owner, 2026-08-29: do not show any admin pages, any past-version pages,
     any test pages, or any admin-related data to public visitors.

     THIS IS ENFORCED IN THE BUILDER, NOT IN THE PAGE, and that distinction is
     the whole point. data/analytics.json is served by Pages to anyone who asks
     — the same rule this repository already applies to e-mail addresses — so a
     path filtered only at render time would still be sitting in a public file
     for anyone who opened it directly. A non-public path must never be
     WRITTEN. The page applies the same predicate anyway, as a second line for
     a file a reader has cached from before this shipped.

     NORMALISE FIRST, THEN FILTER, and that order is load-bearing. GitHub Pages
     serves both `/admin-area` and `/admin-area.html` for one file, and the
     first build recorded 87 views of one and 6 of the other — so a filter that
     matched only the spelling someone thought of would have leaked the page
     under its other name. The canonical form here is the one the pages' own
     canonical and og:url tags use: WITH the extension (see the sitemap section
     of CLAUDE.md), with `/index.html` folding to `/`. Collapsing the pair also
     stops one page appearing twice in the chart, which it did. */

  /* MATCHED CASE-INSENSITIVELY, and each pattern ends the SEGMENT it names.
     Both of those were bugs the tests caught rather than opinions:

       - `/ADMIN-AREA` slipped through a case-sensitive match. Pages would 404
         on it, so nothing should ever record it — but "should never happen" is
         not a reason to publish it if it does, and over-filtering costs a row
         while under-filtering costs the leak this list exists to stop.
       - `^/(test|…)[^/]*` matched `/testimonials.html`, which would have
         SILENTLY HIDDEN a legitimate page from the public chart. That is the
         quieter failure of the two: a leak is visible to anyone who looks at
         the file, a page missing from a list is visible to nobody. So each
         word must be the whole segment. */
  const NON_PUBLIC = [
    /* the maintainer's desk — noindex, admin-read, and its VIEW COUNT is
       itself admin-related data: it says how much the maintainer works */
    /^\/admin-area(\.html?)?(\/|$)/i,
    /* every past-version tree. `\d+` rather than a list, so /v4/ is covered
       the day it exists — an archive that has to be added to a filter to stay
       out of the public record is one that will be forgotten */
    /^\/v\d+(\/|$)/i,
    /* test, preview and staging paths — the WHOLE segment, never a prefix */
    /^\/(test|tests|preview|previews|staging|sandbox|demo)(\.html?)?(\/|$)/i,
    /* Jekyll serves no underscore directory, but a path is cheap to exclude
       and a leak is not: if one ever became reachable it must not also be
       advertised */
    /^\/_/,
  ];

  /** One page, one row — and one NAME, so a filter cannot be evaded by the
      spelling nobody thought of. Query strings and fragments go too: a query
      can carry a posting id, and this file is public. */
  function normPath(raw) {
    let p = String(raw || '').trim();
    if (!p) return '';
    p = p.split('?')[0].split('#')[0];
    /* A backslash is never in a path this site serves, and it is how a
       page value written by an unauthenticated client turns into a link
       off the site: `new URL('/\\evil.com', origin)` is `https://evil.com/`,
       and the most-visited list links its rows. Dropped whole. */
    if (p.indexOf('\\') !== -1) return '';
    if (p.charAt(0) !== '/') p = '/' + p;
    p = p.replace(/\/{2,}/g, '/');
    if (/\/index\.html?$/i.test(p)) p = p.replace(/index\.html?$/i, '');
    if (p === '') p = '/';
    /* extensionless -> the .html the page's own canonical names; a trailing
       slash is a directory and keeps it */
    if (p !== '/' && !/\/$/.test(p) && !/\.[a-z0-9]{2,5}$/i.test(p)) p += '.html';
    return p.slice(0, 120);
  }

  /** May this path appear in a file the whole world can read? */
  function isPublicPath(raw) {
    const p = normPath(raw);
    if (!p) return false;
    return !NON_PUBLIC.some((rx) => rx.test(p));
  }

  /* ------------------------------------------------------------- day series */

  /** The days as a sorted array of { day, visitors, sessions, pageviews },
      optionally clipped to [from, to] inclusive. Sorted here rather than
      relied upon from the file: JSON object key order is an implementation
      detail and a chart plotted in insertion order would be scribble. */
  function series(days, { from = '', to = '' } = {}) {
    const out = [];
    for (const key of Object.keys(days || {})) {
      if (!isDay(key)) continue;
      if (from && key < from) continue;
      if (to && key > to) continue;
      const row = days[key] || [];
      out.push({
        day: key,
        visitors: num(row[0]),
        sessions: num(row[1]),
        pageviews: num(row[2]),
      });
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return out;
  }

  /** A centred rolling mean is wrong for a series whose right-hand end is
      "today": it would need days that have not happened, so the last half
      window silently shortens and the line droops. This is a TRAILING mean,
      which is what a reader means by "the 7-day average", and it emits null
      until it has a full window rather than averaging three days and calling
      it a week. */
  function rollingMean(values, window) {
    const w = Math.max(1, Math.round(window || 1));
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (i < w - 1) { out.push(null); continue; }
      /* A WINDOW WITH A HOLE IN IT HAS NO MEAN. The page now hands this
         series calendar-continuous, with null on a day the record does not
         cover — and a "7-day average" computed over five known days and two
         unknowns is not an average of a week, it is a guess wearing one's
         label. Null, so the line breaks over the gap exactly as the daily
         line does. */
      let sum = 0, known = true;
      for (let j = i - w + 1; j <= i; j++) {
        const v = values[j];
        if (v == null) { known = false; break; }
        sum += v;
      }
      out.push(known ? sum / w : null);
    }
    return out;
  }

  /** Mean visitors per weekday — the "weekly rhythm". A MEAN and not a total,
      because a range rarely holds the same number of each weekday and a total
      would then rank the weekdays by how many of them the range happened to
      contain. `days` counts how many of that weekday the mean is over, which
      the tooltip shows so a thin bar can be read as thin rather than as
      quiet. */
  function byWeekday(rows) {
    const buckets = WEEKDAYS.map((name, i) => ({ i, name, total: 0, days: 0, mean: 0 }));
    for (const r of rows) {
      /* Date.UTC on the parsed parts, never `new Date('YYYY-MM-DD')` read
         locally: that string is parsed as UTC midnight and then rendered in
         the reader's zone, so anyone west of Greenwich gets the day before
         and the whole chart shifts by one bar. */
      const [y, m, d] = r.day.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday
      const idx = (dow + 6) % 7;                                  // 0 = Monday
      buckets[idx].total += r.visitors;
      buckets[idx].days++;
    }
    for (const b of buckets) b.mean = b.days ? b.total / b.days : 0;
    return buckets;
  }

  /** Mean visitors per calendar month — the job-market season. The reason
      this chart is on the page at all: an academic hiring site should be
      loudest in the autumn, and that is a claim the data can either support
      or not. */
  function byMonth(rows) {
    const buckets = MONTHS.map((name, i) => ({ i, name, total: 0, days: 0, mean: 0 }));
    for (const r of rows) {
      const month = Number(r.day.slice(5, 7)) - 1;
      if (month < 0 || month > 11) continue;
      buckets[month].total += r.visitors;
      buckets[month].days++;
    }
    for (const b of buckets) b.mean = b.days ? b.total / b.days : 0;
    return buckets;
  }

  /** The headline numbers, over whatever range is in scope. `busiest` is the
      single best day, which is the one figure on the page a reader can go and
      check against their own memory of a deadline week. */
  function summarise(rows) {
    let visitors = 0, sessions = 0, pageviews = 0, busiest = null;
    for (const r of rows) {
      visitors += r.visitors;
      sessions += r.sessions;
      pageviews += r.pageviews;
      if (!busiest || r.visitors > busiest.visitors) busiest = r;
    }
    return {
      visitors, sessions, pageviews,
      days: rows.length,
      from: rows.length ? rows[0].day : '',
      to: rows.length ? rows[rows.length - 1].day : '',
      mean: rows.length ? visitors / rows.length : 0,
      busiest: busiest ? { day: busiest.day, visitors: busiest.visitors } : null,
    };
  }

  /* --------------------------------------------------------------- staleness */

  /** Has the dataset stopped moving? Reported on the page rather than only in
      a run log, because the three-year-dead charts are the whole reason this
      page was rebuilt: from outside, a pipeline that has stopped and a site
      nobody is visiting look identical. Returns null when everything is fine.

      A dataset with NO days at all is not stale — it is unconfigured, which
      is a different sentence and gets a different one on the page. */
  function staleness(data, now) {
    const rows = series((data && data.days) || {});
    if (!rows.length) return null;
    const last = rows[rows.length - 1].day;
    const [y, m, d] = last.split('-').map(Number);
    const age = Math.floor((now - Date.UTC(y, m - 1, d)) / 86400000);
    if (age <= STALE_DAYS) return null;
    return { last, age };
  }

  /* -------------------------------------------------------- pages & schools */

  /** Top pages, highest authority first and merged by path — the same
      one-source-per-key rule the days follow, for the same reason. */
  function mergePages(into, pages) {
    /* NORMALISED AND FILTERED HERE TOO — every source's pages funnel through
       this one function, so a leg that forgets (or a leg added later) still
       cannot put an admin or archived path into a world-readable file. The
       legs filter as well, so nothing reaches here in the first place; this is
       the chokepoint that makes that a property of the SHAPE rather than of
       every author remembering.

       WITHIN one source two spellings of a page are ONE page and their views
       ADD; ACROSS sources the first claim stands and the later source is
       ignored entirely. Those are different questions and were briefly given
       the same answer, which cost the jobs page a third of its count: the
       first build recorded 467 views of `/jobs.html` and 211 of `/jobs` — the
       same file, because Pages serves it under both — and a plain
       first-claim-wins published 467. That is a wrong number in the direction
       nobody checks, since the row is still there and still looks sensible.
       `mine` is what separates the two rules. */
    const mine = new Set();
    for (const p of pages || []) {
      const path = normPath((p && p.path) || '');
      if (!path || !isPublicPath(path)) continue;
      if (into.has(path) && !mine.has(path)) continue;   // an earlier source owns it

      const views = num(p && p.views);
      const avgSec = Math.max(0, Math.round(Number((p && p.avgSec) || 0)));

      if (mine.has(path)) {
        const cur = into.get(path);
        const total = cur.views + views;
        /* the mean has to be re-weighted by views, or a spelling with three
           visits would drag the average as hard as one with three hundred */
        cur.avgSec = total
          ? Math.round((cur.avgSec * cur.views + avgSec * views) / total)
          : 0;
        cur.views = total;
        if (!cur.title && p && p.title) cur.title = String(p.title).trim().slice(0, 120);
        continue;
      }

      mine.add(path);
      into.set(path, {
        path,
        title: String((p && p.title) || '').trim().slice(0, 120),
        views,
        avgSec,
      });
    }
    return into;
  }

  /** Rank and cut. `limit` exists because the file is served to every reader
      of the page and the tail of a pages report is a long list of one-view
      query strings nobody wants plotted. */
  function topPages(map, limit) {
    return Array.from(map.values())
      .sort((a, b) => b.views - a.views)
      .slice(0, Math.max(0, limit || 0));
  }

  /* ------------------------------------------------- the dimension records */

  /** One label from a dimension, fit to be published.

      THE CAP AND THE ADDRESS RULE ARE NOT DECORATION. These strings come from
      Google, out of fields a third party can influence — `sessionSource` is
      whatever a referring site put in a header — and they land in a file this
      site serves to anyone who asks. So: control characters and runs of
      whitespace collapse, anything ADDRESS-SHAPED is dropped whole rather
      than trimmed (nothing under data/ may carry one, and a truncated address
      is still an address), and the result is capped. Returns '' for anything
      that survives none of that, which the caller drops. */
  function cleanLabel(raw) {
    const t = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return '';
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return '';
    return t.slice(0, 60);
  }

  /** GA4 answers "(not set)" / "(direct)" / "(none)" for a dimension it could
      not determine, which is a real and honest category — a reader arriving by
      typing the address IS direct traffic — but the parentheses are Google's
      house style rather than English. Named here so every consumer says the
      same thing, and so "(not set)" stays separable from a real value. */
  const UNKNOWN_LABELS = {
    '(direct)': 'Typed or bookmarked',
    '(none)': 'Typed or bookmarked',
    '(not set)': 'Not recorded',
    '(other)': 'Other',
  };
  const prettyLabel = (raw) =>
    UNKNOWN_LABELS[String(raw == null ? '' : raw).trim().toLowerCase()] || cleanLabel(raw);

  /** A dimension record, ready to serve — or null when there is nothing in it.

      `total` is the sum over EVERY item the source returned, taken BEFORE the
      cut, so a share is a share of the whole and not of the top ten. Getting
      that the other way round is the classic way a "top countries" chart comes
      to claim its leader is 40% of all traffic when it is 40% of the ten
      countries that happened to fit. */
  function breakdown(id, { source, from = '', to = '', metric = 'visits', zone = '',
    items = [], limit = 12 } = {}) {
    if (BREAKDOWN_IDS.indexOf(id) === -1) return null;
    const rows = [];
    let total = 0;
    for (const it of items || []) {
      const name = prettyLabel(it && it.name);
      if (!name) continue;
      const value = num(it && it.value);
      total += value;
      rows.push({ name, value });
    }
    if (!rows.length || !total) return null;
    /* hours are a CLOCK and must stay in clock order; everything else ranks */
    if (id !== 'hours') rows.sort((a, b) => b.value - a.value);
    return {
      source: String(source || ''),
      from, to, metric, zone,
      total,
      items: rows.slice(0, Math.max(1, limit)),
    };
  }

  /** ONE SOURCE OWNS A DIMENSION, WHOLE. The first (highest-authority) claim
      stands and a later source is ignored entirely — never merged, never
      summed, never preferred for being larger. See the header block: two
      systems counting "visits from Germany" do not agree about what a visit,
      a country or an hour IS, so an assembled answer measures nothing. */
  function mergeBreakdown(into, id, rec) {
    if (!rec || BREAKDOWN_IDS.indexOf(id) === -1) return false;
    if (Object.prototype.hasOwnProperty.call(into, id)) return false;
    into[id] = rec;
    return true;
  }

  /** 24 zeroed hour buckets. An hour with no sessions is a REAL zero — unlike
      a month the record has never reached — because the window is whole days,
      so every hour in it genuinely happened. Nobody reads a job board at 04:00
      UTC, and the chart is allowed to say so. */
  function hourBuckets() {
    return HOURS.map((name) => ({ name, value: 0 }));
  }

  /** Each item's share of the record's own total, as a fraction. It reads the
      pre-cut `total`, so the shares of a truncated list correctly fail to
      reach 1 rather than being renormalised into a lie. */
  function withShare(rec) {
    if (!rec || !rec.total) return [];
    return rec.items.map((it) => ({ name: it.name, value: it.value, share: it.value / rec.total }));
  }

  /** The engagement record — how long a visit lasts and how much of the site
      it covers. Scalars rather than a list, so it has a shape of its own.
      Null when there is nothing to report, which the page reads as "draw no
      tile" rather than as a zero. */
  function engagement({ source, from = '', to = '', sessions = 0, seconds = 0, views = 0 } = {}) {
    const s = num(sessions);
    if (!s) return null;
    return {
      source: String(source || ''),
      from, to,
      sessions: s,
      avgSessionSec: Math.round(Math.max(0, Number(seconds) || 0) / s),
      viewsPerSession: Math.round((Math.max(0, Number(views) || 0) / s) * 100) / 100,
    };
  }

  return {
    DAY_FIELDS, SOURCE_ORDER, WEEKDAYS, MONTHS, STALE_DAYS,
    BREAKDOWN_DAYS, BREAKDOWN_IDS, HOURS, UNKNOWN_LABELS,
    NON_PUBLIC, normPath, isPublicPath,
    isDay, dayRow, emptyDataset, mergeDays, orderSources,
    series, rollingMean, byWeekday, byMonth, summarise, staleness,
    mergePages, topPages,
    cleanLabel, prettyLabel, breakdown, mergeBreakdown, hourBuckets, withShare,
    engagement,
  };
}));
