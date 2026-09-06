/* ---------------------------------------------------------------------------
   Operations Academia — WHEN and WHERE the INFORMS Annual Meeting is, per
   job market season, and what each of a candidate's presentation days means
   as a DATE.

   ONE definition, loaded by every consumer, like assets/oa-countries.js:

     the candidate form     <script src="assets/oa-informs.js"> -> window.OAInforms
     the home page          the same tag (the talks calendar reads it)
     the account page       the same tag (the candidate's own card names the day)
     the checks             createRequire(...)                   -> module.exports

   WHY A TABLE, AND WHY HERE. The candidate profile has always asked WHICH
   DAYS a candidate presents — Sunday to Wednesday, the four days an Annual
   Meeting runs — and published the day names, because that is what a hiring
   committee reads on the card and filters by. A calendar entry needs a date,
   and a date is the meeting's Sunday plus the day's index; the meeting is a
   fact about the SEASON (the 2026 meeting is the 2026-2027 market's), so it
   is keyed by market year and lives in one curated record. It is read in
   the browser rather than stamped onto every profile, for the reason
   assets/oa-sponsors.js gives: a fact with a date in it is decided where it
   is drawn, and a correction here reaches every profile on the next load
   without a build and without touching data/.

   THE TIME ZONE IS SPELLED OUT, not merely named. A talk at 10:45 is 10:45
   where the meeting is, and the calendar file says so with a TZID and the
   VTIMEZONE that defines it — the RFC requires the definition, and an app
   that meets a bare TZID it does not know reads the time as the reader's
   own. The 2026 meeting opens on the Sunday US clocks go back, so the rule
   is written with its own transition dates and not assumed from the
   offset on one day.

   WHEN A SEASON'S MEETING IS ANNOUNCED, ADD ITS RECORD BELOW — the opening
   Sunday, the city, the venue, the programme's address and the zone. A
   season with no record still publishes its day names; it simply offers no
   dates and no talks calendar until the record exists, which is honest
   rather than a guess. The selftest pins that every `opens` is a Sunday and
   that `DAYS` is the profile's own vocabulary.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAInforms = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* The days an Annual Meeting runs, in order — byte-for-byte INFORMS_DAYS in
     _scraper/candidates-model.mjs (pinned by selftest.mjs), the vocabulary
     the form offers and the build publishes. The index IS the offset from
     the opening Sunday. */
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday'];

  /* The United States' daylight-saving rule since 2007, as a VTIMEZONE: the
     second Sunday of March forward, the first Sunday of November back. One
     definition, parameterised by the zone's two offsets, so a meeting in
     another US city is one line in the table below. */
  function usZone(id, std, dst, stdName, dstName) {
    return {
      id: id,
      parts: [
        { kind: 'STANDARD', start: '19701101T020000', rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
          from: dst, to: std, name: stdName },
        { kind: 'DAYLIGHT', start: '19700308T020000', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
          from: std, to: dst, name: dstName }
      ]
    };
  }

  /* One record per MARKET YEAR (the season named for the year it ends in:
     the meeting held in the autumn of 2026 belongs to 2026-2027, so its key
     is 2027). `opens` is the meeting's SUNDAY, from which the four days are
     counted. */
  var MEETINGS = {
    2027: {
      year: 2027,
      name: '2026 INFORMS Annual Meeting',
      city: 'San Francisco, California',
      venue: 'Moscone Center',
      opens: '2026-11-01',
      url: 'https://meetings.informs.org/wordpress/annual/',
      tz: usZone('America/Los_Angeles', '-0800', '-0700', 'PST', 'PDT'),
      /* an INFORMS session runs 90 minutes; a talk is one slot inside it,
         and the calendar entry covers the session so that whoever attends
         is there whichever slot the talk takes */
      sessionMinutes: 90
    }
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** The meeting of a market year, or null where none is recorded yet. */
  function meetingFor(year) {
    var y = Math.trunc(Number(year) || 0);
    return Object.prototype.hasOwnProperty.call(MEETINGS, y) ? MEETINGS[y] : null;
  }

  /** 'YYYY-MM-DD' of one of the meeting's days, or '' for a day off the list
      or a meeting with no opening date. */
  function dateOf(meeting, day) {
    var i = DAYS.indexOf(String(day || ''));
    var m = meeting && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(meeting.opens || ''));
    if (i < 0 || !m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + i));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /** '2 November 2026', or '' */
  function longDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + (+m[1]) : '';
  }

  /** 'Monday 2 November 2026' — the day with its date, or the bare day name
      where the meeting is not recorded. */
  function dayLabel(meeting, day) {
    var iso = dateOf(meeting, day);
    return iso ? day + ' ' + longDay(iso) : String(day || '');
  }

  /** '1 to 4 November 2026' (or across a month end, '30 October to 2
      November 2026'). */
  function span(meeting) {
    var a = dateOf(meeting, DAYS[0]), b = dateOf(meeting, DAYS[DAYS.length - 1]);
    if (!a || !b) return '';
    var ma = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    if (ma[2] === mb[2]) return (+ma[3]) + ' to ' + longDay(b);
    return (+ma[3]) + ' ' + MONTHS[+ma[2] - 1] + ' to ' + longDay(b);
  }

  /** '2026 INFORMS Annual Meeting, San Francisco, California, 1 to 4
      November 2026' — the one sentence the form, the calendar and the card
      all print. */
  function describe(meeting) {
    if (!meeting) return '';
    return [meeting.name, meeting.city, span(meeting)].filter(Boolean).join(', ');
  }

  return {
    DAYS: DAYS,
    MEETINGS: MEETINGS,
    usZone: usZone,
    meetingFor: meetingFor,
    dateOf: dateOf,
    dayLabel: dayLabel,
    longDay: longDay,
    span: span,
    describe: describe
  };
}));
