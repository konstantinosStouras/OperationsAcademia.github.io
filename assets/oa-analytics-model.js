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

     history   the rows the old spreadsheets already hold, committed once as
               data/analytics-history.json. Frozen: UA is gone, so this can
               never grow again and never needs re-fetching.
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

   WHAT CANNOT BE REVIVED, AND IS THEREFORE MARKED FROZEN. The two university
   charts came from UA's `networkDomain` / `networkLocation` dimensions — the
   visitor's reverse-DNS. **GA4 does not have that dimension and no
   replacement exists**, and a browser cannot see its own reverse-DNS either,
   so the first-party record cannot stand in. Those two charts are a
   historical archive from here on; `frozen` on the section says so on the
   page rather than leaving a reader to assume the numbers are current.
   --------------------------------------------------------------------------- */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OAAnalytics = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* A day row is [visitors, sessions, pageviews]. An ARRAY rather than an
     object because the file carries one entry per day back to 2014 — about
     4,500 of them — and `{"v":3,"s":4,"p":11}` is a little over twice the
     bytes of `[3,4,11]` for the same three numbers. DAY_FIELDS is published
     inside the file itself, so the shape is self-describing rather than
     something a reader has to come here to learn. */
  const DAY_FIELDS = ['visitors', 'sessions', 'pageviews'];

  /* Highest authority first. GA4 sees every visitor; the first-party record
     sees only the browsers that reach Firestore (an ad blocker, a private
     window with storage refused, a network that cannot); the archive is a
     different measurement system altogether and covers years neither of the
     other two can. */
  const SOURCE_ORDER = ['ga4', 'usage', 'history'];

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
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= w) sum -= values[i - w];
      out.push(i >= w - 1 ? sum / w : null);
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
    for (const p of pages || []) {
      const path = String((p && p.path) || '').trim();
      if (!path || into.has(path)) continue;
      into.set(path, {
        path,
        title: String((p && p.title) || '').trim().slice(0, 120),
        views: num(p && p.views),
        avgSec: Math.max(0, Math.round(Number((p && p.avgSec) || 0))),
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

  return {
    DAY_FIELDS, SOURCE_ORDER, WEEKDAYS, MONTHS, STALE_DAYS,
    isDay, dayRow, emptyDataset, mergeDays, orderSources,
    series, rollingMean, byWeekday, byMonth, summarise, staleness,
    mergePages, topPages,
  };
}));
