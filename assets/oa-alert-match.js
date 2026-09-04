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
    module.exports = factory(require('./oa-countries.js'), require('./oa-schools.js'),
      require('./oa-jobnav.js'));
  } else {
    root.OAAlertMatch = factory(root.OACountries, root.OASchools, root.OAJobNav);
  }
}(typeof self !== 'undefined' ? self : this, function (OACountries, OASchools, OAJobNav) {
  'use strict';

  var TOPICS = ['jobs', 'updates', 'candidates', 'deadlines', 'news'];

  /* THE "CLOSING THIS WEEK" WINDOW: a posting whose final or suggested apply-by
     date falls within this many days of today. One constant, read by the
     mailer and by the alerts page's preview alike, so the page cannot promise
     a week the mailer does not send. */
  var DEADLINE_WINDOW_DAYS = 7;
  var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

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

  /* An ALL-CAPS needle is an acronym, and the site no longer prints acronyms:
     "Department of Industrial Engineering & Operations Research (IEOR)" is
     published as "Industrial Engineering and Operations Research", so a reader
     — or an alert — asking for IEOR found nothing at all. The initials of the
     words that remain are exactly what was dropped, so they are matched too.
     Skips the joining words an acronym skips ("and", "of", "the", "for",
     "in"), and only ever finds MORE. */
  var ACRONYM = /^[A-Z]{2,6}$/;
  var JOINERS = ' and of the for in a an at on to ';

  function initials(s) {
    var words = String(s == null ? '' : s)
      .replace(/&/g, ' and ')
      .split(/[^A-Za-z0-9]+/);
    var out = '', i;
    for (i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || JOINERS.indexOf(' ' + w.toLowerCase() + ' ') !== -1) continue;
      out += w.charAt(0).toLowerCase();
    }
    return out;
  }

  /**
   * What a free-text alert could reasonably mean: the words as typed, plus the
   * university, school and department names the site publishes for them.
   * Folded, deduplicated, empties dropped. Falls back to the words alone when
   * oa-schools.js is not on the page, so a page that has not added the script
   * tag behaves exactly as it did.
   */
  function canonNeedles(text) {
    var out = [], i;
    var tries = [text];
    if (OASchools) {
      tries.push(OASchools.canonInstitution(text));
      tries.push(OASchools.canonSchool(text));
      tries.push(OASchools.canonUnit(text));
    }
    for (i = 0; i < tries.length; i++) {
      var f = fold(tries[i]);
      if (f && out.indexOf(f) === -1) out.push(f);
    }
    return out;
  }

  /* Case-, diacritic- AND punctuation-insensitive, so "Munster" finds
     "Münster" and "Operations and Information Systems" finds the department
     the site spells "Operations & Information Systems".

     IT IS THE SAME FOLD assets/oa-list.js applies to the jobs page's own text
     filter, deliberately: an alert that matched what the site shows must go on
     matching it. And it is the free-text half of the problem canonCountry
     solves above — a subscriber whose alert holds the spelling the site used to
     publish must not silently stop being e-mailed, and assets/oa-schools.js
     now publishes ONE spelling per department. Both sides are folded the same
     way, so it only ever finds MORE. */
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

  /** True when the alert asks for new candidate profiles. */
  function wantsCandidates(c) {
    return normalise(c).topics.indexOf('candidates') !== -1;
  }

  /** True when the alert asks to be reminded of postings about to close. */
  function wantsDeadlines(c) {
    return normalise(c).topics.indexOf('deadlines') !== -1;
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
      /* The alert's own words, AND the names the site publishes for them.

         A subscriber asked to hear about "SCM", "IEOR" or "Penn State" — and
         the site publishes those as "Supply Chain Management", "Industrial
         Engineering and Operations Research" and "The Pennsylvania State
         University" (assets/oa-schools.js). Five postings matched that first
         alert before the names were tidied and none after: the subscriber
         simply stops being e-mailed, with nothing to see anywhere. This is
         what canonCountry does above, for the half of an alert that is free
         text rather than a chosen value — and it only ever finds MORE,
         because the words they typed are still tried first. */
      var needles = canonNeedles(n.text);
      var hit = false;
      for (var t = 0; t < needles.length && !hit; t++) {
        hit = fold(row.institution).indexOf(needles[t]) !== -1 ||
              fold(row.department).indexOf(needles[t]) !== -1;
      }
      if (!hit && ACRONYM.test(String(n.text).trim())) {
        var acr = String(n.text).trim().toLowerCase();
        hit = initials(row.institution).indexOf(acr) !== -1 ||
              initials(row.department).indexOf(acr) !== -1;
      }
      if (!hit) return false;
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

  /* ------------------------------------------------------------- candidates

     Candidate profiles are PEOPLE, and they are public only once the admin's
     reveal date has passed: until then _scraper/build-candidates.mjs writes
     ZERO rows into data/candidates.json (held back means not written, never
     written-and-hidden). Everything here reads THAT file and nothing else, so
     a profile the site is not showing cannot reach an e-mail by construction
     — there is no row to mention.

     The topic carries no filters, deliberately. The filter fieldset asks
     job-shaped questions (type, entry level, country) that a person does not
     have, and silently applying them would filter every profile out;
     subscribing to candidates means hearing about each new public profile. */

  /** Every profile added strictly after `since` — data/candidates.json rows,
      which by construction exist only once the reveal has happened. */
  function newCandidatesFor(rows, c, since) {
    if (!wantsCandidates(c)) return [];
    var cut = since ? String(since) : '';
    return arr(rows).filter(function (r) {
      return !cut || String(r.addedAt || '') > cut;
    });
  }

  /** The newest `addedAt` in a set of profiles — what to store as the next
      candidate high-water mark. */
  function latestAddedAt(rows) {
    return arr(rows).reduce(function (m, r) {
      var d = String(r.addedAt || '');
      return d > m ? d : m;
    }, '');
  }

  /**
   * What the candidates topic sends this alert, if anything:
   *
   *   { kind: 'reveal', count, mark }    one short, friendly "the profiles
   *                                      are now live" note — NEVER a listing
   *   { kind: 'profiles', rows, mark }   the profiles added since last time
   *   null                               nothing to say
   *
   * `since` is the alert's own candidate high-water mark (`lastCandidateAt`),
   * empty for an alert that has never been sent a candidate e-mail; `revealAt`
   * is the announced reveal day (yyyy-mm-dd, from data/candidates-meta.json).
   * The announcement goes to any alert whose mark PRECEDES the reveal day, and
   * that rule is what makes the reveal day ONE e-mail instead of eighty:
   * profiles are collected for weeks and appear all at once, each stamped
   * `addedAt` when it was POSTED, so on the day the catalogue goes live a
   * per-profile window would either replay the whole back-catalogue or —
   * worse — miss it entirely (every stamp already behind the subscriber's
   * window). It is a rule about the reveal rather than about first contact
   * because seasons REPEAT: when the admin sets the next cycle's reveal date
   * the served file is held back to empty, and on the new reveal day an alert
   * whose mark survives from last season must again be met with the short
   * note, never a sixty-row listing. (With no revealAt readable, an empty
   * mark still announces — the safe direction — and a set one lists.)
   *
   * `mark` is the newest addedAt this send covers — advance the stored mark
   * to it ONLY when the send succeeds, exactly like every other high-water
   * mark in the mailer.
   *
   * While the profiles are held the rows are [] and this returns null: no
   * announcement, no listing, no mention. That is the reveal gate holding in
   * the mailer, and it holds because the served file is the only source.
   */
  function candidateNews(rows, c, since, revealAt) {
    if (!wantsCandidates(c)) return null;
    rows = arr(rows);
    if (!rows.length) return null;
    var mark = since ? String(since) : '';
    // an ISO stamp compares against a bare day lexicographically: a mark
    // stamped ON the reveal day ('2026-10-11T…') already sorts after it
    var day = String(revealAt || '').slice(0, 10);
    if (!mark || (day && mark < day)) {
      return { kind: 'reveal', count: rows.length, mark: latestAddedAt(rows) };
    }
    var fresh = newCandidatesFor(rows, c, mark).sort(function (x, y) {
      return String(y.addedAt || '').localeCompare(String(x.addedAt || ''));
    });
    if (!fresh.length) return null;
    return { kind: 'profiles', rows: fresh, mark: latestAddedAt(fresh) };
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

  /** yyyy-mm-dd, `n` days after (or, negative, before) the day given — the
      window arithmetic the deadlines topic does on BOTH sides. Strings in,
      strings out, UTC throughout; '' for anything that is not a day. */
  function shiftDay(day, n) {
    var t = Date.parse(String(day == null ? '' : day).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(t)) return '';
    return new Date(t + n * 86400000).toISOString().slice(0, 10);
  }

  function dayOf(v) {
    return String(v == null ? '' : v).slice(0, 10);
  }

  /* ------------------------------------------------------------- deadlines

     "Closing this week": the postings matching the alert's own filters whose
     FINAL apply-by date (applyByDate) or SUGGESTED apply-by date (reviewDate)
     falls within the next DEADLINE_WINDOW_DAYS. The same paper filters the
     jobs topic applies (matchesJob — no filter means every posting), so the
     reminder is about the postings the subscriber asked to hear about, and
     nothing else.

     DATES ARE DAYS, COMPARED AS STRINGS. Every apply-by date on a served row
     is yyyy-mm-dd, and so are `from`, `until` and `coveredUntil`, so `<=` is
     the whole comparison and no time zone can shift a deadline by a day.
     Today is the UTC day, like the rest of the pipeline.

     `coveredUntil` is the END of the last window this alert was checked
     against (the mailer's `lastDeadlineUntil`): a date on or before it has
     already been announced, or already been looked at and found empty, so
     only dates AFTER it go out. That is what makes a posting never appear
     twice — a daily alert sees each closing date exactly once, on the day it
     enters the window. It has a cost, stated rather than hidden: a posting
     that ENTERS the window late (added, or given a date, after the window was
     covered) is not announced by this topic; the jobs topic is what announces
     a new posting.

     WHICH DATE, where both fall due in one window: the FINAL one. It is the
     date that closes the search; the suggested one precedes it and is implied.
     Where only the suggested date is in the window, that is what is named,
     and the final date is named when its own turn comes. */

  /**
   * Every posting matching `c` that is in the current market and whose final
   * or suggested apply-by date is a day in [from, until] and after
   * coveredUntil — each as { row, kind: 'final'|'suggested', date }, sorted
   * by date. Empty when the alert did not ask for deadlines, when the window
   * is not a pair of days, or when the market rule (assets/oa-jobnav.js) is
   * not loaded: it says no when it cannot tell, never guesses.
   */
  function closingSoonFor(rows, c, opts) {
    if (!wantsDeadlines(c)) return [];
    if (!OAJobNav || !OAJobNav.inCurrentMarket) return [];
    opts = opts || {};
    var from = dayOf(opts.from), until = dayOf(opts.until);
    var covered = dayOf(opts.coveredUntil);
    if (!ISO_DAY.test(from) || !ISO_DAY.test(until)) return [];
    var at = new Date(from + 'T00:00:00Z');
    var out = [];
    arr(rows).forEach(function (r) {
      if (!r || !matchesJob(r, c)) return;
      if (!OAJobNav.inCurrentMarket(r, at)) return;
      var tries = [['final', dayOf(r.applyByDate)], ['suggested', dayOf(r.reviewDate)]];
      for (var i = 0; i < tries.length; i++) {
        var d = tries[i][1];
        if (!ISO_DAY.test(d)) continue;
        if (d < from || d > until) continue;
        if (covered && d <= covered) continue;
        out.push({ row: r, kind: tries[i][0], date: d });
        return;
      }
    });
    out.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      return String(x.row.institution || '').localeCompare(String(y.row.institution || ''));
    });
    return out;
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
    DEADLINE_WINDOW_DAYS: DEADLINE_WINDOW_DAYS,
    fold: fold,
    normalise: normalise,
    wantsJobs: wantsJobs,
    wantsUpdates: wantsUpdates,
    wantsCandidates: wantsCandidates,
    wantsDeadlines: wantsDeadlines,
    isBroad: isBroad,
    matchesJob: matchesJob,
    newJobsFor: newJobsFor,
    newCandidatesFor: newCandidatesFor,
    latestAddedAt: latestAddedAt,
    candidateNews: candidateNews,
    newUpdatesFor: newUpdatesFor,
    latestUpdateDate: latestUpdateDate,
    daysBefore: daysBefore,
    shiftDay: shiftDay,
    closingSoonFor: closingSoonFor,
    isDue: isDue,
    hasIntent: hasIntent
  };
}));
