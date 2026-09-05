/* ---------------------------------------------------------------------------
   Operations Academia: WHEN candidate profiles are revealed. ONE definition.

     the front page's reveal note      <script src="assets/oa-reveal.js">  -> window.OAReveal
     the account page's own-card preview  the same tag
     the alerts page's example e-mail     the same tag
     the Admin area's held/live split     the same tag (loaded on demand too)
     the build, the two mailers, the selftest   createRequire(...) -> module.exports

   THE REVEAL IS AN INSTANT, NOT A DAY (owner, 2026-09-04). Profiles are
   collected for weeks and shown all at once on the date named on the site.
   The gate used to be a UTC calendar day: the first scheduled build after
   midnight UTC revealed, which is five in the afternoon of the PREVIOUS day in
   California. The instant is now 14:00 UTC on the reveal day, which is still
   that calendar day everywhere the readers are: morning in the Americas,
   afternoon in Europe, evening in East Asia (07:00 Los Angeles, 10:00 New
   York, 15:00 London, 22:00 Shanghai for a reveal in summer time; an hour
   earlier in the first three once the clocks have gone back, which is why
   no page types those numbers and every one asks describeReveal instead).

   Seven files compared a day against `revealAt` and none of them through a
   module. That is the shape this site has learned to distrust (oa-jobnav.js
   for the market year, oa-countries.js, oa-schools.js): two copies of one
   answer disagree silently, and here a disagreement is a profile that one
   page calls held while another calls it live. So every comparison goes
   through `isRevealed` below, and the build's revealGate is a thin caller.

   A TYPO CAN NEVER REVEAL EARLY. `revealInstant` answers null for anything
   that is not a real yyyy-mm-dd, and `isRevealed` answers false for null, so
   an empty or malformed date holds everything, exactly as the day-based gate
   did.

   THE TIMES ARE COMPUTED, NEVER TYPED. `describeReveal` asks Intl for the
   local time in four named zones and in the reader's own, so a daylight-
   saving change on either side of the Atlantic cannot leave a stale hour on
   the page. Where Intl is missing the fields are null and the copy falls
   back to the UTC sentence, which is true without them.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAReveal = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The hour (UTC) on the reveal day at which every profile goes public.
      The Cloud Function `revealCandidates` (_functions/index.js) is scheduled
      on this same hour; selftest.mjs pins the two against each other. */
  var REVEAL_HOUR_UTC = 14;

  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* The four cities the site names beside the time, in the order the copy
     reads them: west to east. Named IANA zones, so the offsets follow
     daylight saving on their own. */
  var CITIES = [
    { name: 'Los Angeles', timeZone: 'America/Los_Angeles' },
    { name: 'New York', timeZone: 'America/New_York' },
    { name: 'London', timeZone: 'Europe/London' },
    { name: 'Shanghai', timeZone: 'Asia/Shanghai' },
  ];

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
    'Saturday'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** The reveal DAY as the site stores it: the trimmed yyyy-mm-dd, or ''
      for anything else. What the build echoes back as `revealAt`. */
  function revealDay(revealAt) {
    var s = String(revealAt == null ? '' : revealAt).trim();
    return DAY_RE.test(s) ? s : '';
  }

  /**
   * The instant the profiles go public: 14:00 UTC on the reveal day, as a
   * Date. Null for '', prose, a day in another format, or a day that does
   * not exist ('2026-13-45' parses to an Invalid Date, which is refused
   * rather than rolled over).
   */
  function revealInstant(revealAt) {
    var d = revealDay(revealAt);
    if (!d) return null;
    var inst = new Date(d + 'T' + pad2(REVEAL_HOUR_UTC) + ':00:00.000Z');
    if (isNaN(+inst)) return null;
    // a rolled-over day ('2026-02-31' -> 3 March) is not the day that was
    // written, so it is refused too
    if (inst.toISOString().slice(0, 10) !== d) return null;
    return inst;
  }

  /** The same instant as the stamp the build writes into candidates-meta.json
      (`revealAtInstant`), or '' where there is no instant. */
  function revealStamp(revealAt) {
    var inst = revealInstant(revealAt);
    return inst ? inst.toISOString() : '';
  }

  /**
   * Have the profiles been revealed at `now`? False when there is no valid
   * instant, so a typo holds everything; true from the instant itself on.
   */
  function isRevealed(revealAt, now) {
    var inst = revealInstant(revealAt);
    if (!inst) return false;
    var at = now == null ? new Date() : new Date(now);
    if (isNaN(+at)) return false;
    return +at >= +inst;
  }

  /**
   * A day in the site's own words: "2 October 2026", day, month, year, no
   * ordinal suffix and no comma. THE ONE home of day-month-year on the site:
   * the card's "Profile updated on …" line and the reveal note's long day
   * both read it. (jobs-model's `longDate` is the OTHER order, "October 2,
   * 2026", and stays what it is; this is not a second copy of it.)
   */
  function formatDay(iso) {
    var d = revealDay(iso);
    if (!d) return '';
    return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
  }

  /** The same day with its weekday: "Sunday 11 October 2026". Computed from
      the UTC day itself, so it needs no Intl and cannot print the comma
      en-GB's own weekday format inserts. */
  function formatDayLong(iso) {
    var inst = revealInstant(iso);
    if (!inst) return '';
    return WEEKDAYS[inst.getUTCDay()] + ' ' + formatDay(iso);
  }

  /** {time: 'HH:MM', day: 'yyyy-mm-dd'} for an instant in one named zone,
      through Intl; null where Intl is missing or the zone is unknown. */
  function zoneClock(inst, timeZone) {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone,
        hourCycle: 'h23',
        hour: '2-digit', minute: '2-digit',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(inst);
      var p = {};
      for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
      if (!p.hour || !p.minute || !p.year || !p.month || !p.day) return null;
      // some engines print midnight as "24" under hour12:false; h23 above is
      // the fix, and this is the belt to that brace
      var hour = p.hour === '24' ? '00' : p.hour;
      return {
        time: hour + ':' + p.minute,
        day: p.year + '-' + p.month + '-' + p.day,
      };
    } catch (e) {
      return null;
    }
  }

  /** The reader's own zone, as Intl names it; '' where it cannot say. */
  function readerZone() {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return '';
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === 'string' ? tz : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Everything a page needs to SAY when the reveal is, computed rather than
   * typed:
   *
   *   {
   *     day: '2026-10-11',                       the stored day
   *     instant: '2026-10-11T14:00:00.000Z',     the same as the meta's stamp
   *     revealed: false,                         at `now` (default: the clock)
   *     dayLong: 'Sunday 11 October 2026',
   *     utc: '14:00 UTC',
   *     cities: [{ name: 'Los Angeles', timeZone, time: <HH:MM>, sameDay: true }, ...],
   *     local: { timeZone: 'Europe/Dublin', time: <HH:MM>, sameDay: true }
   *   }
   *
   * `sameDay` says whether the local clock reads the reveal DAY at that
   * moment: true for all four cities by construction of the hour, false in
   * Auckland, where 14:00 UTC is three in the morning of the next day. Null
   * for the whole thing when the day is not a real one, and null fields
   * where Intl cannot answer.
   */
  function describeReveal(revealAt, opts) {
    var o = opts || {};
    var d = revealDay(revealAt);
    var inst = revealInstant(d);
    if (!inst) return null;

    var out = {
      day: d,
      instant: inst.toISOString(),
      revealed: isRevealed(d, o.now),
      dayLong: formatDayLong(d),
      utc: pad2(REVEAL_HOUR_UTC) + ':00 UTC',
      cities: [],
      local: { timeZone: null, time: null, sameDay: null },
    };

    for (var i = 0; i < CITIES.length; i++) {
      var c = zoneClock(inst, CITIES[i].timeZone);
      out.cities.push({
        name: CITIES[i].name,
        timeZone: CITIES[i].timeZone,
        time: c ? c.time : null,
        sameDay: c ? c.day === d : null,
      });
    }

    var tz = o.timeZone || readerZone();
    if (tz) {
      var l = zoneClock(inst, tz);
      out.local = {
        timeZone: tz,
        time: l ? l.time : null,
        sameDay: l ? l.day === d : null,
      };
    }
    return out;
  }

  return {
    REVEAL_HOUR_UTC: REVEAL_HOUR_UTC,
    CITIES: CITIES,
    revealDay: revealDay,
    revealInstant: revealInstant,
    revealStamp: revealStamp,
    isRevealed: isRevealed,
    formatDay: formatDay,
    formatDayLong: formatDayLong,
    describeReveal: describeReveal,
  };
}));
