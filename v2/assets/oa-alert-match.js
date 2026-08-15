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
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAAlertMatch = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOPICS = ['jobs', 'updates', 'candidates', 'news'];

  /** Case- and diacritic-insensitive, so "Munster" finds "Münster". */
  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s;
  }

  function arr(v) {
    if (v == null || v === '') return [];
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
  }

  /**
   * The criteria a subscriber can express. Normalising here — rather than
   * trusting whatever is on the stored document — is what stops an old alert,
   * saved before a field existed, from throwing inside the mailer at 6am.
   */
  function normalise(c) {
    c = c || {};
    var out = {
      topics: arr(c.topics).filter(function (t) { return TOPICS.indexOf(t) !== -1; }),
      text: String(c.text || '').trim().slice(0, 120),
      type: arr(c.type).map(String),
      level: arr(c.level).map(String),
      country: arr(c.country).map(String),
      characteristics: arr(c.characteristics).map(String)
    };
    if (!out.topics.length) out.topics = ['jobs'];
    return out;
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
      var needle = fold(n.text);
      var hay = fold(row.institution) + ' ' + fold(row.department);
      if (hay.indexOf(needle) === -1) return false;
    }
    if (n.type.length && n.type.indexOf(row.type) === -1) return false;
    if (n.country.length && n.country.indexOf(row.country) === -1) return false;
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

  /** Every change-log entry dated in (since, until] that the alert wants. */
  function newUpdatesFor(entries, c, since, until) {
    if (!wantsUpdates(c)) return [];
    return arr(entries).filter(function (e) {
      var d = String(e.date || '');
      if (!d) return false;
      if (since && !(d > String(since).slice(0, 10))) return false;
      if (until && d > String(until).slice(0, 10)) return false;
      return true;
    });
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

  /** An alert with nothing selected must never be saved — it would be silence. */
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
    isDue: isDue,
    hasIntent: hasIntent
  };
}));
