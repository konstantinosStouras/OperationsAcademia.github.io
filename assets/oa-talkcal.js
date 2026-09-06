/* ---------------------------------------------------------------------------
   Operations Academia — the candidates' INFORMS TALKS, as a calendar file.

   ONE definition, loaded by BOTH sides, like assets/oa-jobcal.js:

     the browser   <script src="assets/oa-talkcal.js">  -> window.OATalkCal
     the checks    createRequire(...)(...)               -> module.exports

   so _scraper/selftest.mjs builds the calendar from a fixture list of
   profiles offline and reads it back. The pure half — eventsFor() and
   calendar() — is everything that decides what leaves the site; the browser
   half is one button in the candidates list's filter bar.

   THE OWNER'S INSTRUCTION (2026-09-06): "form a calendar with all candidates
   talks times, dates and locations at INFORMS conference. That should help
   anyone who wants to attend their talk."

   WHAT AN ENTRY IS. A candidate's profile names the DAY(S) they present
   (`informsDays`, Sunday to Wednesday) and, since the same day, may name for
   each of them WHEN and WHERE (`talks`: the session's start time, its code,
   the room, the talk's title — candidates-model.mjs). The DATE is the
   meeting's Sunday plus the day's index, from assets/oa-informs.js, the one
   record of when and where the season's meeting is. So:

     a day WITH a start time   a timed entry, the length of an INFORMS session
                               (90 minutes), in the meeting's own zone with
                               its VTIMEZONE written into the file, at the
                               room, code and title given;
     a day WITHOUT one         an all-day entry saying the candidate presents
                               that day and the details are not in yet, so
                               a committee still has the day blocked out and
                               the profile to come back to.

   A profile whose season has no meeting recorded gives no entries at all:
   without a date there is nothing a calendar can show, and a guessed date
   is worse than none.

   WHAT NEVER LEAVES. The candidate's e-mail address, even where they opted
   to publish it on the card: the file's job is where and when the talk is,
   and how to reach the person stays on the site, behind the sign-in the
   card is behind. The selftest sweeps the built file for anything shaped
   like an address. The entry links the profile on the site instead (the
   candidates list, narrowed to the name through the engine's own URL key),
   and the CV where there is one.

   REGISTERED READERS ONLY, exactly as the Excel download: the profiles'
   details are for signed-in readers (assets/oa-gate.js), and a file of
   them is the same details in another form.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-ics.js'), require('./oa-informs.js'));
  } else {
    root.OATalkCal = factory(root.OAIcs, root.OAInforms);
  }
}(typeof self !== 'undefined' ? self : this, function (OAIcs, OAInforms) {
  'use strict';

  var G = (typeof window !== 'undefined') ? window : null;

  var SITE = 'https://www.operationsacademia.org/';

  /** The name follows the season, as the deadlines file's does (owner,
      2026-09-06: "Ops JM '27", and "Ops JM '28" the year after): the talks
      are the market's, so "Ops JM '27 INFORMS talks", every season the
      file covers named where a list spans two. */
  function calName(years) {
    var ys = (Array.isArray(years) ? years : [years]).map(function (y) {
      return Math.trunc(Number(y) || 0);
    }).filter(function (y, i, a) { return y >= 1000 && a.indexOf(y) === i; }).sort();
    if (!ys.length) return '';
    return 'Ops JM ' + ys.map(function (y) { return "'" + String(y).slice(-2); }).join(', ') + ' INFORMS talks';
  }

  function txt(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  /** The candidates list on the home page, narrowed to this name: the
      engine's own text-filter key (`c_name`, the mount's urlPrefix plus the
      filter's key), so the link opens the list with one card in it. */
  function profileUrl(row) {
    var name = txt(row && row.name);
    return SITE + (name ? '?c_name=' + encodeURIComponent(name) : '') + '#candidates';
  }

  /**
   * The entries for these profiles, in the list's order: one per presenting
   * day, timed where the profile gives a start time and all-day otherwise.
   * `opts.now` is only the file's own stamp.
   */
  function eventsFor(rows, opts) {
    opts = opts || {};
    var out = [];
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      var name = txt(row.name);
      if (!name) return;
      var meeting = OAInforms.meetingFor(row.year);
      if (!meeting) return;
      var days = (row.informsDays || []).filter(function (d) { return OAInforms.DAYS.indexOf(d) !== -1; });
      var talks = (row.talks && typeof row.talks === 'object') ? row.talks : {};
      days.forEach(function (day) {
        var date = OAInforms.dateOf(meeting, day);
        if (!date) return;
        var t = talks[day] || {};
        var title = txt(t.title), session = txt(t.session), room = txt(t.room), at = txt(t.at);
        /* the venue is added after the room unless the room already names
           it ("Moscone Center, Room 2004"), or the location reads it twice */
        var place = [];
        if (at && room) place.push(room);
        if (!room || room.toLowerCase().indexOf(String(meeting.venue).toLowerCase()) === -1) place.push(meeting.venue);
        place.push(meeting.city);
        var lines = [];
        lines.push(name + ' presents at the ' + meeting.name + ' on ' + OAInforms.dayLabel(meeting, day) + '.');
        if (title) lines.push('Talk: ' + title);
        if (session) lines.push('Session: ' + session);
        if (room) lines.push('Room: ' + room);
        if (at) {
          lines.push('Session starts at ' + at + ' (' + meeting.tz.id.replace(/_/g, ' ') +
            ', the meeting’s local time); INFORMS sessions run ' + meeting.sessionMinutes + ' minutes.');
        } else {
          lines.push('The time and room are not on the profile yet; check the programme, or the profile nearer the day.');
        }
        var aff = [txt(row.affiliation), txt(row.position)].filter(Boolean).join(', ');
        if (aff) lines.push('Affiliation: ' + aff);
        var areas = (row.researchAreas || []).map(txt).filter(Boolean).join(', ');
        if (areas) lines.push('Research areas: ' + areas);
        var cv = OAIcs.safeUrl(row.cvUrl);
        if (cv) lines.push('CV: ' + cv);
        lines.push('Profile on Operations Academia: ' + profileUrl(row));

        var ev = {
          uid: 'oa-talk-' + row.id + '-' + day.toLowerCase(),
          summary: at
            ? 'INFORMS talk: ' + name + (title ? ' - ' + title : '')
            : 'INFORMS: ' + name + ' presents (time to be announced)',
          description: lines.join('\n'),
          location: place.map(txt).filter(Boolean).join(', '),
          url: profileUrl(row),
          categories: ['Operations Academia', 'INFORMS talk']
        };
        if (at) {
          ev.start = date + 'T' + at;
          ev.minutes = meeting.sessionMinutes;
          ev.tzid = meeting.tz.id;
        } else {
          ev.day = date;
        }
        out.push(ev);
      });
    });
    return out;
  }

  /** How many profiles give a day, and how many of those days carry a time:
      what the button's tooltip says. */
  function describe(rows) {
    var candidates = 0, days = 0, timed = 0;
    (rows || []).forEach(function (row) {
      if (!row || !OAInforms.meetingFor(row.year)) return;
      var ds = (row.informsDays || []).filter(function (d) { return OAInforms.DAYS.indexOf(d) !== -1; });
      if (!ds.length) return;
      candidates++;
      ds.forEach(function (d) {
        days++;
        if (row.talks && row.talks[d] && txt(row.talks[d].at)) timed++;
      });
    });
    return { candidates: candidates, days: days, timed: timed };
  }

  /** The timezone definitions the entries use — one per meeting the rows
      span, so a file of two seasons carries both. */
  function timezonesFor(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (row) {
      var m = row && OAInforms.meetingFor(row.year);
      if (m && m.tz && !seen[m.tz.id]) { seen[m.tz.id] = true; out.push(m.tz); }
    });
    return out;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function isoDay(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** operations-academia-informs-talks-2026-2026-10-20.ics: the meeting's
      year, then the day the file was taken. */
  function fileName(meta) {
    var when = (meta && meta.at) || new Date();
    var meetingYear = txt(meta && meta.meetingYear).replace(/[^0-9]/g, '');
    return ['operations-academia-informs-talks', meetingYear, isoDay(when)]
      .filter(Boolean).join('-') + '.ics';
  }

  /**
   * The whole file, or '' when not one of the rows names a presenting day
   * in a season whose meeting is recorded.
   */
  function calendar(rows, meta) {
    meta = meta || {};
    var now = meta.now instanceof Date ? meta.now : new Date();
    var events = eventsFor(rows, { now: now });
    if (!events.length) return '';
    var meetings = {};
    (rows || []).forEach(function (r) {
      var m = r && OAInforms.meetingFor(r.year);
      if (m) meetings[m.year] = m;
    });
    var named = Object.keys(meetings).map(function (y) { return OAInforms.describe(meetings[y]); });
    return OAIcs.build(events, {
      name: calName(Object.keys(meetings)),
      description: 'The talks of the job market candidates listed on Operations Academia at the ' +
        named.join(' and the ') + ', as their profiles stood on ' +
        OAInforms.longDay(now.toISOString().slice(0, 10)) + '. ' +
        'A day whose time and room are not on the profile yet is an all-day entry. ' +
        SITE + '#candidates',
      now: now,
      timezones: timezonesFor(rows)
    });
  }

  /* ======================================================================
     The browser half: one button in the candidates list's filter bar.
     ====================================================================== */

  function signedIn() {
    var Gate = G && G.OAGate;
    return !!(Gate && Gate.signedIn());
  }

  /** The OAList action descriptor, declared on the candidates mount and
      rendered by the engine (the Excel download's reasoning: the engine owns
      the bar and rebuilds it, so a button the page appended would vanish at
      the first press of Clear). */
  function action(opts) {
    opts = opts || {};
    return {
      key: 'talkcal',
      className: 'oa-talkcal',
      label: '📅 Download talks calendar',

      refresh: function (btn, api) {
        var A = G.OAAccounts;
        var d = describe(api.view);
        var what = 'Download a calendar file (.ics) of the INFORMS talks of ' +
          (d.candidates === api.view.length ? 'all ' : 'these ') +
          d.candidates + ' candidate' + (d.candidates === 1 ? '' : 's') +
          ' (' + d.timed + ' of ' + d.days + ' presenting day' + (d.days === 1 ? '' : 's') +
          ' with a time and room)';
        if (!A || !G.OAGate || (A.failed && A.failed())) {
          btn.disabled = true;
          btn.title = 'Sign-in is unavailable at the moment, so the download is too.';
        } else {
          btn.disabled = !d.candidates;
          btn.title = d.candidates
            ? (signedIn() ? what : what + ', free with an account')
            : 'Nothing to download: no candidate listed here presents at INFORMS this season.';
        }
        btn.setAttribute('aria-label', btn.title);
      },

      onClick: function (api, btn) {
        var A = G.OAAccounts;
        if (!A) return;
        /* THE GATE, the Excel download's: run now when signed in, queue while
           the session restores, offer the sign-in box otherwise. */
        A.whenSignedIn(function () { run(api, btn, opts); });
      }
    };
  }

  function run(api, btn, opts) {
    var now = new Date();
    var text = calendar(api.view, { now: now });
    if (!text) return '';
    var years = {};
    api.view.forEach(function (r) {
      var m = r && OAInforms.meetingFor(r.year);
      if (m) years[String(m.opens).slice(0, 4)] = true;
    });
    var name = fileName({ at: now, meetingYear: Object.keys(years).sort().join('-') });
    try {
      OAIcs.download(name, text);
    } catch (e) {
      if (G.console) G.console.error('OA: the talks calendar download failed', e);
      if (G.alert) {
        G.alert('Sorry, the calendar file could not be prepared in this browser. ' +
          'Please try again, or let us know through the Feedback page.');
      }
    }
    return name;
  }

  return {
    SITE: SITE,
    calName: calName,
    profileUrl: profileUrl,
    eventsFor: eventsFor,
    describe: describe,
    timezonesFor: timezonesFor,
    calendar: calendar,
    fileName: fileName,
    action: action,
    signedIn: signedIn
  };
}));
