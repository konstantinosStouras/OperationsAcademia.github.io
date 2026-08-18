/* ---------------------------------------------------------------------------
   Operations Academia — does this job posting match this alert?

   ONE definition, loaded by BOTH sides:

     the browser   <script src="assets/oa-alert-match.js">  -> window.OAAlertMatch
     the mailer    createRequire(...)('.../oa-alert-match.js') -> module.exports

   /lit/ solves this by vendoring a copy of the page's matcher into its mailer
   and noting "keep in sync". That drift is a real failure mode: the preview a
   subscriber sees when they create an alert would stop agreeing with the
   e-mails they then receive, and nothing would fail loudly. A dual-mode file
   removes the possibility instead of documenting it.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-countries.js'));
  } else {
    root.OAAlertMatch = factory(root.OACountries);
  }
}(typeof self !== 'undefined' ? self : this, function (OACountries) {
  'use strict';

  var TOPICS = ['jobs', 'updates', 'candidates', 'news'];

  /* ONE SPELLING PER COUNTRY, on both sides of every comparison.

     The site published "USA" for years and now publishes "United States"
     (assets/oa-countries.js). An alert saved under the old spelling holds
     `criteria.country: ['USA']`, and a plain string comparison against the new
     rows would quietly match nothing — the subscriber would simply stop
     receiving the e-mails they asked for, with nothing to see anywhere.

     Canonicalising inside normalise() fixes that everywhere at once, because
     normalise() is also what the alerts PAGE reads a stored alert through: the
     country boxes it ticks when the subscriber opens their alert to edit it
     are the canonical ones, so saving does not silently drop a filter either.

     Falls back to the identity when the countries file is not on the page, so
     a page that has not added the script tag behaves exactly as it did. */
  function canonCountry(v) {
    return (OACountries && OACountries.canon)
      ? OACountries.canon(v)
      : String(v == null ? '' : v);
  }

  /* Case-, diacritic- AND punctuation-insensitive, so "Munster" finds
     "Münster" and "Operations and Information Systems" finds the department
     the site spells "Operations & Information Systems".

     IT IS THE SAME FOLD assets/oa-list.js applies to the jobs page's own text
     filter, deliberately: an alert that matched what the site shows must go on
     matching it. And it is the free-text half of the problem canonCountry
     solves above — a subscriber whose alert holds the spelling the site used to
     publish must not silently stop being e-mailed, and the vocabulary
     (assets/oa-names.js) now publishes ONE spelling per department. Both sides
     are folded the same way, so it only ever finds MORE. */
  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }

  function arr(v) {
    if (v == null || v === '') return [];
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
  }

  /**
   * The criteria a subscriber can express. Normalising here — rather than
   * trusting whatever is on the stored document — is what stops an old alert,
   * saved before a field existed, from throwing inside the mailer at 6am.
   *
   * It deliberately does NOT invent a topic for an alert that names none. It
   * used to default an empty list to ['jobs'], and that one line made every
   * guard downstream unreachable: hasIntent() below is defined on the
   * normalised topics, so it was constant true, and wantsJobs() was true for
   * an alert whose owner had explicitly unticked "New job postings" — the
   * failure firing exactly when the reader asked for silence. Empty means
   * empty; the alerts page seeds ['jobs'] on a NEW form, where a default
   * belongs.
   */
  function normalise(c) {
    c = c || {};
    return {
      topics: arr(c.topics).filter(function (t) { return TOPICS.indexOf(t) !== -1; }),
      text: String(c.text || '').trim().slice(0, 120),
      type: arr(c.type).map(String),
      level: arr(c.level).map(String),
      country: arr(c.country).map(canonCountry),
      characteristics: arr(c.characteristics).map(String)
    };
  }

  /** True when the alert asks for job postings at all. */
  function wantsJobs(c) {
    return normalise(c).topics.indexOf('jobs') !== -1;
  }

  /** True when the alert asks for website change-log entries. */
  function wantsUpdates(c) {
    return normalise(c).topics.indexOf('updates') !== -1;
  }

  /** True when the alert has no job filters, i.e. "tell me about everything". */
  function isBroad(c) {
    var n = normalise(c);
    return !n.text && !n.type.length && !n.level.length &&
           !n.country.length && !n.characteristics.length;
  }

  /**
   * Does one posting match one alert's job criteria?
   *
   * Every filled-in filter must match (AND); within one filter the ticked
   * values are alternatives (OR). That is deliberately the same rule the jobs
   * page applies to its filter bar, so "what I see on the site" and "what I am
   * e-mailed" cannot mean different things.
   */
  function matchesJob(row, c) {
    var n = normalise(c);
    if (!row) return false;

    if (n.text) {
      // Each field is searched on its own, NOT as one concatenated string.
      // The jobs page's own text filter is `fields:['institution','department']`
      // matched with .some() (oa-list.js), so a needle spanning the two —
      // "virginia darden" — finds four postings here and none on the site. One
      // rule, or the e-mail promises postings the site says do not exist.
      var needle = fold(n.text);
      if (fold(row.institution).indexOf(needle) === -1 &&
          fold(row.department).indexOf(needle) === -1) return false;
    }
    if (n.type.length && n.type.indexOf(row.type) === -1) return false;
    if (n.country.length && n.country.indexOf(canonCountry(row.country)) === -1) return false;
    if (n.level.length && !overlaps(arr(row.levels), n.level)) return false;
    if (n.characteristics.length && !overlaps(arr(row.characteristics), n.characteristics)) {
      return false;
    }
    return true;
  }

  function overlaps(have, want) {
    for (var i = 0; i < have.length; i++) if (want.indexOf(have[i]) !== -1) return true;
    return false;
  }

  /** Every posting added strictly after `since` that matches. */
  function newJobsFor(rows, c, since) {
    if (!wantsJobs(c)) return [];
    var cut = since ? String(since) : '';
    return arr(rows).filter(function (r) {
      if (cut && !(String(r.addedAt || '') > cut)) return false;
      return matchesJob(r, c);
    });
  }

  /**
   * Every change-log entry the alert has not been sent yet.
   *
   * `sinceDate` is the DATE OF THE LAST ENTRY ALREADY SENT (yyyy-mm-dd), not a
   * timestamp. That distinction is the whole point: change-log entries are
   * calendar days while a send mark is an instant, and comparing the two
   * directly silently drops every entry dated on the day of the last send —
   * which in practice means an announcement made the same morning as a digest
   * reaches nobody, ever. Tracking the last entry date instead makes the
   * comparison like-for-like.
   *
   * `untilDate` bounds it at today, so an entry dated in the future (a
   * scheduled announcement) waits rather than going out early.
   */
  function newUpdatesFor(entries, c, sinceDate, untilDate) {
    if (!wantsUpdates(c)) return [];
    var since = String(sinceDate || '').slice(0, 10);
    var until = String(untilDate || '').slice(0, 10);
    return arr(entries).filter(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      if (since && d <= since) return false;
      if (until && d > until) return false;
      return true;
    });
  }

  /** The newest entry date in a set — what to store as the next `sinceDate`. */
  function latestUpdateDate(entries) {
    return arr(entries).reduce(function (m, e) {
      var d = String(e.date || '').slice(0, 10);
      return d > m ? d : m;
    }, '');
  }

  /** yyyy-mm-dd, n days before `now`. Used to cap a first-ever send so a new
      subscriber is not posted the whole back-catalogue. */
  function daysBefore(now, n) {
    var d = new Date(now.getTime() - n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Is this alert due, given when it last ran?
   * `immediate` is bounded by the mailer's own cadence, not by a window.
   */
  function isDue(frequency, lastSentAt, now) {
    if (!lastSentAt) return true;
    var last = Date.parse(lastSentAt);
    if (isNaN(last)) return true;
    var hours = (now.getTime() - last) / 3600000;
    switch (frequency) {
      case 'immediate': return hours >= 0;
      case 'weekly': return hours >= 24 * 7 - 1;
      case 'monthly': return hours >= 24 * 28 - 1;
      case 'daily':
      default: return hours >= 23;
    }
  }

  /** An alert with nothing selected must never be saved — it would be silence.
      Read straight off the stored topics: an alert that names none has no
      intent, and nothing anywhere may quietly supply one for it. */
  function hasIntent(c) {
    return normalise(c).topics.length > 0;
  }

  return {
    TOPICS: TOPICS,
    fold: fold,
    normalise: normalise,
    wantsJobs: wantsJobs,
    wantsUpdates: wantsUpdates,
    isBroad: isBroad,
    matchesJob: matchesJob,
    newJobsFor: newJobsFor,
    newUpdatesFor: newUpdatesFor,
    latestUpdateDate: latestUpdateDate,
    daysBefore: daysBefore,
    isDue: isDue,
    hasIntent: hasIntent
  };
}));
