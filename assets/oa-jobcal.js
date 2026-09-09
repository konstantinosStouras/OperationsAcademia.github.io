/* ---------------------------------------------------------------------------
   Operations Academia — the job postings' DEADLINES, as a calendar file.

   ONE definition, loaded by BOTH sides, like assets/oa-jobexport.js:

     the browser   <script src="assets/oa-jobcal.js">  -> window.OAJobCal
     the checks    createRequire(...)(...)              -> module.exports

   so _scraper/selftest.mjs builds the calendar from the REAL data/jobs.json
   offline and reads it back. The pure half — datesOf(), eventsFor(),
   calendar() — is everything that decides what leaves the site; the browser
   half is a tick box on each posting and a strip above the list.

   THE OWNER'S INSTRUCTION (2026-09-06): "users can select jobs and then
   download a calendar invitation with their respective deadlines (if any).
   Jobs with deadline 'until filled' won't be added on that calendar."

   WHAT IS A DEADLINE HERE. A posting carries up to TWO dates (see "Two
   deadlines per posting" in CLAUDE.md): the FINAL apply-by (`applyByDate`,
   the hard closing date) and the SUGGESTED apply-by (`reviewDate`, the
   first-review or full-consideration date). Each becomes its own all-day
   entry, named for what it is, because the second matters most to exactly
   the searches that have no first: "first review of applications begins on
   8 September, then until filled". A posting with NEITHER date is the
   "until filled" case the owner named, and it puts nothing on the calendar,
   so its card is offered no tick box at all: a control that would add
   nothing is worse than none. A date that has already passed is left out
   for the same reason; a calendar of expired deadlines is noise.

   AN ALL-DAY ENTRY, TRANSPARENT. Applications close at the end of the day
   named, wherever the reader is, so no clock and no zone; and a deadline is
   a reminder, not an appointment, so it does not mark the reader busy.

   WHAT NEVER LEAVES. The Contact details a poster gives are not in
   data/jobs.json at all (PUBLIC_FIELDS in _scraper/jobs-model.mjs), so they
   cannot be here; the selftest sweeps the built file for anything shaped
   like an address regardless, the way it sweeps the Excel workbook.

   THE SELECTION LIVES IN THIS PAGE'S MEMORY and nowhere else: a reload
   forgets it, a sign-out clears it, and nothing about which postings a
   reader chose is stored or sent anywhere. That is deliberate, and it is
   also why the strip says what is ticked in words rather than relying on
   the reader to remember.

   THE OWNER'S SECOND INSTRUCTION (2026-09-06): the calendar is called
   "Ops JM '27", and "Ops JM '28" the year after; every entry says the
   Suggested deadline and the Final deadline where the posting has them,
   and carries the link to the job ad, the "posted online at" link and the
   OA posting ID. The name follows OAJobNav.marketYear, the one definition
   of the season under way, so nothing is edited at the July roll; the two
   deadline lines are ALWAYS both written, in the card's order, "none
   given" standing where a posting has no such date, so an entry never
   hides the date that closes the search; and the ID's label is
   OAJobNav.REF_LABEL, the card's own, so the two cannot word it two ways.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-ics.js'), require('./oa-jobnav.js'));
  } else {
    root.OAJobCal = factory(root.OAIcs, root.OAJobNav);
  }
}(typeof self !== 'undefined' ? self : this, function (OAIcs, OAJobNav) {
  'use strict';

  var G = (typeof window !== 'undefined') ? window : null;

  var SITE = 'https://www.operationsacademia.org/';

  /** "Ops JM '27" for market year 2027: the two digits of the season the
      jobs page shows. Nothing for a year that is not one. */
  function calName(year) {
    var y = Math.trunc(Number(year) || 0);
    if (y < 1000) return '';
    return "Ops JM '" + String(y).slice(-2);
  }

  /* The two dates, in the order the card prints them. `label` heads the
     calendar entry and its line in the description; `note` is the one
     phrase a reader needs about it; `none` is the line where the posting
     has no such date. */
  var KINDS = [
    { key: 'review', field: 'reviewDate', label: 'Suggested deadline',
      note: 'the first-review or full-consideration date; the search stays open after it',
      none: 'none given' },
    { key: 'final', field: 'applyByDate', label: 'Final deadline',
      note: 'the closing date of the search',
      none: 'none given (open until filled)' }
  ];

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function txt(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function day(v) {
    var s = String(v == null ? '' : v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  /** The UTC day, the pipeline's own clock (todayISO in oa-list.js). */
  function todayIso(now) {
    return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  }

  /** "November 14, 2026": the order the cards print a stored date in
      (OAList.longDate, the browser twin of jobs-model's longDate), restated
      here because that engine is a page global and not a module. */
  function longDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + (+m[1]);
  }

  /**
   * The dates a posting can put on a calendar: each of its two apply-by
   * dates that is TODAY OR LATER, in KINDS order. Empty for an open-ended
   * search, and for one whose dates have all passed.
   */
  function datesOf(row, today) {
    var t = today || todayIso();
    var out = [];
    KINDS.forEach(function (k) {
      var d = day(row && row[k.field]);
      if (d && d >= t) out.push({ kind: k, day: d });
    });
    return out;
  }

  function hasDate(row, today) { return datesOf(row, today).length > 0; }

  function whereOf(row) {
    return [txt(row.institution), txt(row.department)].filter(Boolean).join(' - ');
  }

  /** The posting's own permalink, absolute: OAJobNav.hrefFor is the ONE rule
      for which page carries a posting today. */
  function permalink(row, now) {
    return SITE + OAJobNav.hrefFor(row, now);
  }

  /** The lines every entry ends with: the two links the card draws, each
      where the posting has one, the posting's own ID under the card's own
      label, and the way back to it on the site. */
  function linkLines(row, now) {
    var lines = [];
    var ad = OAIcs.safeUrl(row.adUrl);
    if (ad) lines.push('Link to job ad: ' + ad);
    var at = OAIcs.safeUrl(row.postedAtUrl);
    if (at) lines.push('Posted online at: ' + at);
    lines.push(OAJobNav.REF_LABEL + ': ' + txt(row.id));
    lines.push('Posting on Operations Academia: ' + permalink(row, now));
    return lines;
  }

  /**
   * The calendar entries for these postings: one per upcoming apply-by date,
   * all-day, each naming the posting, both of its dates, its entry levels
   * and the way back to it on the site.
   */
  function eventsFor(rows, opts) {
    opts = opts || {};
    var now = opts.now instanceof Date ? opts.now : new Date();
    var today = opts.today || todayIso(now);
    var out = [];
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      var where = whereOf(row);
      if (!where) return;
      var dates = datesOf(row, today);
      dates.forEach(function (d) {
        /* BOTH deadlines, always, in the card's order: the entry is one of
           them (its summary says which) and the other is the one a reader
           would otherwise go back for, a suggested date beside "until
           filled" or the final date beside a suggested one */
        var lines = KINDS.map(function (k) {
          var v = day(row[k.field]);
          return k.label + ': ' + (v ? longDate(v) + ' (' + k.note + ')' : k.none);
        });
        var fin = day(row.applyByDate);
        var listed = txt(row.applyBy);
        if (fin && listed && listed !== longDate(fin)) lines.push('Final deadline as listed: ' + listed);
        var levels = (row.levels || []).map(txt).filter(Boolean).join(', ');
        if (levels) lines.push('Entry level: ' + levels);
        lines = lines.concat(linkLines(row, now));
        out.push({
          uid: 'oa-job-' + row.id + '-' + d.kind.key,
          day: d.day,
          summary: d.kind.label + ': ' + where,
          description: lines.join('\n'),
          location: [txt(row.institution), txt(row.country)].filter(Boolean).join(', '),
          url: permalink(row, now),
          categories: ['Operations Academia', 'Job deadline']
        });
      });
    });
    return out;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** The local day, as the Excel download stamps its file name: the reader
      is holding the file, so it says the date on their own calendar. */
  function isoDay(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** operations-academia-job-deadlines-2026-2027-2026-09-06.ics */
  function fileName(meta) {
    var when = (meta && meta.at) || new Date();
    var market = txt(meta && meta.market).replace(/[^0-9A-Za-z-]+/g, '-').replace(/^-+|-+$/g, '');
    return ['operations-academia-job-deadlines', market, isoDay(when)]
      .filter(Boolean).join('-') + '.ics';
  }

  /**
   * The whole file, or '' when not one of the rows has a date to give.
   * @param rows  the postings chosen
   * @param meta  { now, today, year, market }: the season is the one under way
   *              at `now` (OAJobNav.marketYear, the one definition) unless
   *              the caller names it, and the name and the description say it
   */
  function calendar(rows, meta) {
    meta = meta || {};
    var now = meta.now instanceof Date ? meta.now : new Date();
    var events = eventsFor(rows, { now: now, today: meta.today });
    if (!events.length) return '';
    var year = Math.trunc(Number(meta.year) || 0) || OAJobNav.marketYear(now);
    var market = txt(meta.market) || OAJobNav.marketLabel(year);
    return OAIcs.build(events, {
      name: calName(year),
      description: 'Application deadlines of job postings listed on Operations Academia' +
        (market ? ' for the ' + market + ' job market' : '') +
        ', as they stood on ' + longDate(todayIso(now)) + '. ' +
        'Each entry is an all-day reminder; a posting with no closing date (open until filled) has no entry. ' +
        SITE + 'jobs',
      now: now
    });
  }

  /* ----------------------------------------------------------------------
     WHERE THE DEADLINES GO (owner, 2026-09-09): "allow 3 standard options
     for calendar from a drop down menu: (1) Google calendar, (2) apple
     calendar, (3) .ics download option."

     There is ONE set of entries and three ways to hand it over, because
     that is all the platforms offer a static site with no server:

       Google   its own event window, action=TEMPLATE, which carries exactly
                ONE event per address. So a single entry opens Google with
                the deadline filled in and one Save to press, and several
                open Google's Import screen beside the file that has just
                downloaded. Anything that put many entries in one Google
                address would be a claim Google does not honour.
       Apple    the FILE. iPhone, iPad and Mac hand a text/calendar download
                to Calendar, which offers to add every entry at once; the
                option exists to say so, since a reader looking for "Apple
                Calendar" will not guess that the file is the answer.
       .ics     the same file, for Outlook, Thunderbird and everything else.

     Apple and the plain download are therefore the SAME bytes and the same
     press, and this file says so rather than dressing one of them up: what
     differs is the sentence the reader is given about what happens next.
     ---------------------------------------------------------------------- */

  var GOOGLE_TEMPLATE = 'https://calendar.google.com/calendar/render';
  /* Google Calendar's "Import and export" settings pane, where a reader
     chooses the file this page has just handed them. */
  var GOOGLE_IMPORT = 'https://calendar.google.com/calendar/u/0/r/settings/export';
  /* An address is not a document: the entry's own description carries two
     deadlines, the levels and three links, and a Google address that ran to
     several kilobytes would be refused by something between here and there.
     The file has the whole of it, and the entry links back to the posting. */
  var DETAILS_MAX = 900;

  function clip(v, max) {
    var s = String(v == null ? '' : v);
    if (s.length <= max) return s;
    return s.slice(0, max).replace(/\s\S*$/, '') + '…';
  }

  /**
   * ONE calendar entry as a Google Calendar address, or '' for an entry
   * Google could not be given (no day, no summary).
   *
   * The dates are 'YYYYMMDD/YYYYMMDD' with the end EXCLUSIVE, which is the
   * rule an all-day DTEND already follows, so both readings are taken from
   * OAIcs.nextDay rather than added up twice.
   *
   * `crm=AVAILABLE` keeps the day FREE, which is the same thing
   * TRANSP:TRANSPARENT says in the file: a deadline is a reminder, not an
   * appointment. It is NOT `trp=false`, which is the parameter that used to
   * say this and which Google's current web client does not read at all;
   * sending it leaves every deadline marked Busy while the file beside it
   * says free, which is the two halves of one answer disagreeing that this
   * repository keeps a module like this one to prevent.
   */
  function googleUrl(ev) {
    if (!ev || !ev.day || !OAIcs.isoDayOk(ev.day)) return '';
    var summary = txt(ev.summary);
    if (!summary) return '';
    return GOOGLE_TEMPLATE + '?' + [
      'action=TEMPLATE',
      'text=' + encodeURIComponent(summary),
      'dates=' + ev.day.replace(/-/g, '') + '/' + OAIcs.nextDay(ev.day).replace(/-/g, ''),
      'details=' + encodeURIComponent(clip(ev.description, DETAILS_MAX)),
      'location=' + encodeURIComponent(txt(ev.location)),
      'crm=AVAILABLE'
    ].join('&');
  }

  /* ======================================================================
     The browser half: a tick box on each dated posting, and a strip above
     the list that says what will be added and hands it to a calendar.
     ====================================================================== */

  /* Signed in, asked of the ONE definition (assets/oa-gate.js), the same
     answer the cards are drawn from. No fallback when the module is absent:
     it says no, and the load order is pinned in selftest.mjs. */
  function signedIn() {
    var Gate = G && G.OAGate;
    return !!(Gate && Gate.signedIn());
  }

  function unavailable() {
    var A = G && G.OAAccounts;
    return !A || !G.OAGate || !!(A.failed && A.failed());
  }

  var picked = {};          // id -> true: the postings the reader has ticked
  var ui = null;            // the strip, once attached

  function count() {
    var n = 0;
    for (var k in picked) if (Object.prototype.hasOwnProperty.call(picked, k)) n++;
    return n;
  }

  function isPicked(id) {
    return !!picked[String(id == null ? '' : id)];
  }

  function pick(id, on) {
    var key = String(id == null ? '' : id);
    if (!key) return;
    if (on) picked[key] = true;
    else delete picked[key];
    refresh();
  }

  function clearPicks() {
    picked = {};
    repaintBoxes();
    refresh();
  }

  function pickedRows(rows) {
    return (rows || []).filter(function (r) { return r && isPicked(r.id); });
  }

  /**
   * WHAT A PRESS ACTS ON, and this is the whole of the 2026-09-09 bug.
   *
   * Owner: "a user has selected a few job postings, then downloaded the .ics
   * file. Then, de-selected the postings and even refreshed the page.
   * However, the calendar button stays deactivated."
   *
   * Every one of those states was the button's own rule working as written:
   * it was disabled whenever nothing was ticked, and a reload forgets the
   * ticks by design. Nothing was broken and nothing said so, which is
   * exactly how a control that is merely WAITING reads as one that is dead
   * (the Excel button's own lesson, one section over in CLAUDE.md).
   *
   * So a tick is a NARROWING now, never a precondition: with nothing ticked
   * the press acts on every posting the list is showing that has a deadline
   * still to come, and the button says so in as many words ("Add all 33 to
   * your calendar"). It is disabled in ONE state only, the honest one:
   * nothing listed has a date to add, which the strip's sentence explains
   * and a change of filter leaves.
   */
  function targetRows(list) {
    return chosen(listedDated(list)).rows;
  }

  /** Every posting the list is SHOWING that has a date still to come. */
  function listedDated(list) {
    var view = (ui && ui.snap) ? ui.snap.view : (list ? list.view() : []);
    return (view || []).filter(function (r) { return r && hasDate(r); });
  }

  /**
   * WHAT THE STRIP IS TALKING ABOUT, and it is only ever what is on screen.
   *
   * `picked` is not narrowed by a filter, and a tick made under one search
   * used to go on counting under the next: press Tick all listed, then narrow
   * to one university, and the strip said "32 postings ticked" over a page
   * where no box was ticked at all, with a file to match. The number a reader
   * cannot see and cannot untick is a number the site should not be acting
   * on, so the ticks are INTERSECTED with the listed set here. The map keeps
   * them, so widening the search brings them back; nothing else reads it.
   */
  function chosen(dated) {
    var on = dated.filter(function (r) { return isPicked(r.id); });
    return { dated: dated, ticked: on, rows: on.length ? on : dated };
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === false || v === undefined) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  /** What the tick box says beside its label: every upcoming date, named. */
  function whenText(dates) {
    return dates.map(function (d) {
      return d.kind.label.toLowerCase() + ' ' + longDate(d.day);
    }).join(', ');
  }

  /**
   * The `onCard` hook: a tick box under the head of every posting that has
   * an upcoming apply-by date, for a signed-in reader. A LOCKED or GATED
   * card (signed out, or the one-pager's teaser) gets nothing: its details
   * are withheld, and a control naming its deadline would say one of them.
   * Safe to call again (the list re-renders); the tick follows the memory.
   */
  function onCard(li, row) {
    if (!li || typeof li.querySelector !== 'function') return;
    var old = li.querySelector('.oa-cal-pick');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    li.classList.remove('oa-cal-picked');
    if (li.classList.contains('oa-card-gated') || !signedIn()) return;
    /* a control whose press cannot be RECORDED is worse than none, which is
       the argument this function already makes for an undated posting: pick()
       keys on the id and returns on an empty one */
    if (!row || !row.id) return;
    var dates = datesOf(row);
    if (!dates.length) return;

    var input = el('input', { type: 'checkbox', class: 'oa-cal-box',
      'data-cal-id': String(row.id),
      'aria-label': 'Add this posting’s deadline to your calendar' });
    input.checked = isPicked(row.id);
    li.classList.toggle('oa-cal-picked', input.checked);
    var label = el('label', { class: 'oa-cal-pick' }, [
      input,
      el('span', { class: 'oa-cal-pick-text', text: 'Add to calendar' }),
      el('span', { class: 'oa-cal-when', text: whenText(dates) })
    ]);
    input.addEventListener('change', function () {
      li.classList.toggle('oa-cal-picked', input.checked);
      pick(row.id, input.checked);
    });
    var body = li.querySelector('.oa-card-body');
    li.insertBefore(label, body || null);
  }

  /* ---- the three ways out --------------------------------------------- */

  /* iPhone, iPad and Mac hand a text/calendar download to Calendar, which
     then offers to add every entry at once; everywhere else the same file
     is opened by whatever the reader has. Read for the WORDING alone, never
     to decide what a press does: a browser lying about its platform must
     not be able to change which bytes leave. */
  function onApple() {
    var n = (G && G.navigator) || {};
    var s = String(n.platform || '') + ' ' + String(n.userAgent || '');
    return /iPhone|iPad|iPod|Mac/i.test(s);
  }

  /* An iPhone or iPad, where the share sheet can hand a file to Calendar
     itself. iPadOS reports as a Mac, so the touch screen is what tells the
     two apart: a Mac has none. */
  function onHandheldApple() {
    var n = (G && G.navigator) || {};
    var ua = String(n.userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Mac/i.test(String(n.platform || '') + ' ' + ua) && (n.maxTouchPoints || 0) > 1;
  }

  /**
   * THE SHARE SHEET, which is the one thing on this site that really does
   * hand a file to another app. On an iPhone or iPad `navigator.share` with
   * a `text/calendar` file offers Calendar in the sheet, so the reader never
   * meets the Downloads arrow at all. Feature-detected end to end and called
   * inside the reader's own press, since iOS allows it nowhere else; false
   * means "this device cannot", and the caller falls through to the file.
   *
   * A CANCELLED SHARE IS NOT A FAILURE — the reader closed the sheet — so the
   * rejection is swallowed rather than reported, and nothing is downloaded
   * behind their back.
   */
  function shareFile(file) {
    var n = G && G.navigator;
    if (!n || !n.share || !n.canShare || typeof File === 'undefined') return false;
    var f;
    try {
      f = new File([file.text], file.name, { type: 'text/calendar' });
      if (!n.canShare({ files: [f] })) return false;
      n.share({ files: [f], title: file.name }).catch(function () {});
    } catch (e) { return false; }
    return true;
  }

  /** The file the reader would be handed for these rows, built once. */
  function fileOf(list, opts) {
    var rows = targetRows(list);
    var now = new Date();
    var year = OAJobNav.marketYear(now);
    var meta = { now: now, at: now, year: year,
      market: (opts && opts.market && opts.market()) || OAJobNav.marketLabel(year) };
    return { rows: rows, meta: meta, events: eventsFor(rows, { now: now }),
      name: fileName(meta), text: calendar(rows, meta) };
  }

  function entries(n) { return plural(n, 'deadline', 'deadlines'); }

  /** Hand the file over, and say what has just happened. */
  function saveFile(file, said) {
    try {
      OAIcs.download(file.name, file.text);
    } catch (e) {
      if (G.console) G.console.error('OA: the calendar download failed', e);
      note('Sorry, the calendar file could not be prepared in this browser. ' +
        'Please try again, or let us know through the Feedback page.', true);
      return false;
    }
    note(said);
    return true;
  }

  function sendFile(list, opts) {
    var file = fileOf(list, opts);
    if (!file.text) return nothingToAdd();
    saveFile(file, entries(file.events.length) + ' downloaded as ' + file.name +
      '. Open the file and your calendar will offer to add them.');
  }

  function sendApple(list, opts) {
    var file = fileOf(list, opts);
    if (!file.text) return nothingToAdd();
    if (onHandheldApple() && shareFile(file)) {
      note('Choose Calendar in the sheet that has just opened and it will offer to add ' +
        entries(file.events.length) + '.');
      return;
    }
    saveFile(file, onApple()
      ? entries(file.events.length) + ' downloaded. Open it from the Downloads arrow on an iPhone or iPad, ' +
        'or double-click it on a Mac, and Calendar will offer to add them all.'
      : entries(file.events.length) + ' downloaded. It is an ordinary calendar file: on an iPhone, iPad ' +
        'or Mac, opening it adds them all at once, and on this device it opens in whichever calendar app you use.');
  }

  /**
   * Google Calendar. Its own event address (action=TEMPLATE) carries exactly
   * ONE event, so a single deadline opens Google with the entry filled in
   * and one Save to press, and several go over as the FILE with Google's
   * Import screen opened beside it. The tab is opened FIRST, inside the
   * reader's own press, or a browser would treat it as a pop-up and swallow
   * it; the download follows in the same gesture.
   */
  function sendGoogle(list, opts) {
    var file = fileOf(list, opts);
    if (!file.events.length || !file.text) return nothingToAdd();
    if (file.events.length === 1) {
      var url = googleUrl(file.events[0]);
      if (!url) return nothingToAdd();
      if (!openTab(url)) return;
      note('Google Calendar has opened with the deadline filled in. Press Save there and it is in your calendar.');
      return;
    }
    if (!openTab(GOOGLE_IMPORT)) return;
    saveFile(file, 'Google Calendar has opened on its Import screen, and ' + entries(file.events.length) +
      ' downloaded as ' + file.name + '. Choose that file there and press Import: Google adds them in one go, ' +
      'because a Google Calendar link carries one entry at a time.');
  }

  /**
   * Google Calendar, in a tab of its own.
   *
   * NOT `window.open(url, '_blank', 'noopener')`, which is where the first
   * draft of this went wrong: with `noopener` the call returns NULL WHETHER
   * OR NOT THE TAB OPENED, by the specification, so the "we could not open
   * it" branch fired every single time and the file was never handed over
   * beside it. Plain `_blank` gives back the handle, which is the only way
   * to tell a blocked pop-up from an opened tab; every current browser
   * already severs `opener` for a `_blank` target, and the line below says
   * so a second time for the ones that do not.
   */
  function openTab(url) {
    var w = null;
    try {
      w = G.open(url, '_blank');
      if (w) { try { w.opener = null; } catch (e2) { /* cross-origin: already severed */ } }
    } catch (e) { w = null; }
    if (!w) {
      note('Your browser blocked the Google Calendar tab. Allow pop-ups for this site, ' +
        'or choose "Download the file" below and import it yourself.', true);
      return false;
    }
    return true;
  }

  function nothingToAdd() {
    note('None of those postings has a deadline still to come, so there is nothing to add.', true);
  }

  function note(text, bad) {
    if (!ui) return;
    ui.note.textContent = text || '';
    ui.note.classList.toggle('oa-cal-note-bad', !!bad);
  }

  var SENDERS = { google: sendGoogle, apple: sendApple, ics: sendFile };

  /* The menu's three items, in the owner's own order. `note` is the one
     sentence a reader needs to choose between them, and the third says
     plainly that it is the same file as the second: a menu that pretended
     they differed would be the site claiming something it does not do. */
  var CHOICES = [
    { key: 'google', name: 'Google Calendar',
      note: 'opens Google Calendar with the deadlines' },
    { key: 'apple', name: 'Apple Calendar',
      note: 'hands the file to Calendar on an iPhone or iPad, and downloads it on a Mac' },
    { key: 'ics', name: 'Download the file (.ics)',
      note: 'the same file, for Outlook, Thunderbird or anything else' }
  ];

  /* ---- the strip ------------------------------------------------------- */

  /**
   * Mount the strip above the list's result bar. `list` is the OAList
   * mount's api (rows(), view()); `opts.market`, where given, names the
   * season for the file name, which is otherwise read from OAJobNav. The
   * page's `onRender` hands `refresh` the engine's snapshot after every
   * repaint, so the strip's counts are never a step behind.
   */
  function attach(list, host, opts) {
    if (!host || !list) return null;
    opts = opts || {};
    var old = host.querySelector('.oa-cal-tray');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var msg = el('p', { class: 'oa-cal-msg' });
    var all = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-all', text: 'Tick all listed' });
    var none = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-none', text: 'Untick all' });

    /* A DISCLOSURE, not a `role="menu"`: the site implements no roving
       tabindex anywhere, and the header's More panel records why claiming
       the role without it is three separate lies. A button with
       aria-expanded and aria-controls, a panel that SHIPS hidden, and every
       item an ordinary tab stop.

       IT SHIPS WITH ITS LABEL TOO. refresh() refines that label to name what
       a press would send, and refresh() is also the one thing here that can
       fail: a button created empty and named only there is a blank pill for
       anybody who meets that window. */
    var go = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-go',
      text: '📅 Add to your calendar', 'aria-label': 'Add deadlines to your calendar',
      'aria-expanded': 'false', 'aria-controls': 'oa-cal-panel' });
    var panel = el('div', { class: 'oa-cal-panel', id: 'oa-cal-panel' });
    panel.hidden = true;
    var items = CHOICES.map(function (c) {
      return el('button', { type: 'button', class: 'oa-cal-opt', 'data-cal': c.key }, [
        el('b', { text: c.name }),
        el('span', { class: 'oa-cal-opt-note', text: c.note })
      ]);
    });
    items.forEach(function (b) { panel.appendChild(b); });
    var menu = el('div', { class: 'oa-cal-menu' }, [go, panel]);

    /* ALWAYS RENDERED, empty to begin with. A live region that arrives with
       its first words in it is one many screen readers never announce, so it
       may not be created hidden and may not be hidden again when it is
       cleared; empty, it is a bare paragraph with no margin. */
    var line = el('p', { class: 'oa-cal-note', role: 'status', 'aria-live': 'polite' });

    var tray = el('div', { class: 'oa-cal-tray', role: 'region',
      'aria-label': 'Deadlines to your calendar' }, [msg, all, menu, none, line]);
    tray.hidden = true;

    ui = { tray: tray, msg: msg, all: all, go: go, none: none, note: line,
      panel: panel, menu: menu, list: list, opts: opts, snap: null };

    function openPanel(where) {
      panel.hidden = false;
      go.setAttribute('aria-expanded', 'true');
      if (where) items[where === 'last' ? items.length - 1 : 0].focus();
    }
    function closePanel(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      go.setAttribute('aria-expanded', 'false');
      if (returnFocus) go.focus();
    }
    ui.close = closePanel;

    go.addEventListener('click', function (e) {
      /* Enter and Space on a button fire a click whose detail is 0, a
         pointer press one whose detail is at least 1: opened from the
         keyboard the panel takes the keyboard, opened with the pointer it
         leaves it where it is. The More panel's own reading. */
      if (panel.hidden) openPanel(e.detail === 0 ? 'first' : null);
      else closePanel(false);
    });
    go.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); openPanel('first'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); openPanel('last'); }
    });
    panel.addEventListener('keydown', function (e) {
      var i = items.indexOf(document.activeElement);
      if (i === -1) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });
    panel.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.oa-cal-opt') : null;
      if (!b || !panel.contains(b)) return;
      var how = b.getAttribute('data-cal');
      /* SHUT FIRST: the panel hangs over the list, and a hand-over that
         opens a tab or saves a file must not leave it standing over the
         page the reader comes back to. Focus goes back to the trigger,
         which is where the reader pressed. */
      closePanel(true);
      var A = G.OAAccounts;
      if (!A) return;
      /* THE GATE: the Excel download's, verbatim in intent. whenSignedIn
         runs NOW for a signed-in reader, which is what keeps the Google tab
         inside the reader's own press; it queues while the session restores
         and offers the sign-in box otherwise. */
      A.whenSignedIn(function () {
        var fn = SENDERS[how];
        if (fn) fn(list, opts);
      });
    });
    /* CAPTURE and POINTERDOWN, the More panel's two reasons: a bubble-phase
       listener can be silenced by anything that stops propagation on the way
       up, and iOS does not reliably deliver a document-level MOUSE event for
       a tap on a plain element, which would leave the panel stuck open. */
    document.addEventListener('pointerdown', function (e) {
      if (!panel.hidden && !menu.contains(e.target)) closePanel(false);
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel(true);
    });
    menu.addEventListener('focusout', function () {
      /* focusout fires BEFORE the new element takes focus, so the deferred
         read is the one that covers Tab walking out of the last item. */
      setTimeout(function () {
        if (!panel.hidden && !menu.contains(document.activeElement)) closePanel(false);
      }, 0);
    });

    all.addEventListener('click', function () {
      var view = ui.snap ? ui.snap.view : list.view();
      view.forEach(function (r) { if (r && hasDate(r)) picked[String(r.id)] = true; });
      repaintBoxes();
      refresh();
    });
    none.addEventListener('click', function () {
      clearPicks();
      repaintBoxes();
    });

    var res = host.querySelector('.oa-resultbar');
    host.insertBefore(tray, res || null);

    /* a sign-out empties the memory: a selection made in one session must
       not be handed to whoever signs in next on the same machine */
    var A = G && G.OAAccounts;
    if (A && A.onChange) A.onChange(function (u) { if (!u) picked = {}; refresh(); });
    refresh();
    return tray;
  }

  /** Every tick box on screen, made to agree with the memory. */
  function repaintBoxes() {
    if (!G || !G.document) return;
    var boxes = G.document.querySelectorAll('.oa-card .oa-cal-box');
    Array.prototype.forEach.call(boxes, function (box) {
      /* THE BOX CARRIES THE KEY pick() WROTE. Re-deriving it from the card's
         own element id was a second reading of one thing, and it rested on
         Element.closest: where that is missing the lookup yielded '', every
         box was quietly UNCHECKED and the memory kept its entries. */
      var id = box.getAttribute('data-cal-id') || '';
      box.checked = isPicked(id);
      var li = box.closest ? box.closest('.oa-card') : (box.parentNode && box.parentNode.parentNode);
      if (li && li.classList) li.classList.toggle('oa-cal-picked', box.checked);
    });
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * Repaint the strip from the engine's snapshot ({ view, rows, total }),
   * or from the list itself when called without one.
   *
   * NOTHING RETURNS EARLY. The first version returned the moment the strip
   * was not to be shown, so every button kept whatever state it last had:
   * signed out, with the strip hidden, the download sat there reading
   * ENABLED. Nothing could see it and the next paint corrected it, which is
   * exactly the kind of stale state that becomes visible the day something
   * else changes. The strip is hidden FIRST and every control is settled
   * after it, so neither half can be skipped by the other.
   */
  function refresh(snap) {
    if (!ui) return;
    if (snap && snap.view) ui.snap = snap;
    var s = ui.snap;
    var rows = s ? s.rows : ui.list.rows();
    var view = s ? s.view : ui.list.view();
    var sel = chosen((view || []).filter(function (r) { return hasDate(r); }));
    var dated = sel.dated;

    /* THE STRIP STANDS DOWN FIRST, and it stands down on `dated` as well as
       on the reader: a search that matches only open-ended postings offers
       no tick box on any card, so a strip whose every control is dead is a
       control panel for nothing. Hidden BEFORE the controls are settled, so
       a throw below can leave a stale button but never a strip shown to
       somebody it is not for. */
    var show = signedIn() && !unavailable() && rows.length > 0 && dated.length > 0;
    ui.tray.hidden = !show;
    if (!show && ui.close) ui.close(false);

    var n = sel.ticked.length;
    var allTicked = dated.length > 0 && n === dated.length;
    /* what a press would act on: the ticks where there are any, else every
       dated posting the filters are showing */
    var target = sel.rows.length;

    ui.msg.textContent = n
      ? plural(n, 'posting', 'postings') + ' ticked. Send just those to your calendar, each deadline as an all-day reminder.'
      : 'Tick a posting to send only its deadlines, or send every one listed at once. ' +
        plural(dated.length, 'of the postings listed carries', 'of the postings listed carry') +
        ' a date still to come; a posting that is open until filled has none to add.';

    ui.go.textContent = '📅 ' + (target
      ? (n ? 'Add ' + plural(n, 'posting', 'postings') : 'Add all ' + dated.length) + ' to your calendar'
      : 'Add to your calendar');
    ui.go.disabled = !target;
    ui.go.title = target
      ? (n ? 'Choose where to send the ' + plural(n, 'posting', 'postings') + ' you ticked'
        : 'Choose where to send every listed posting with a deadline still to come (' + dated.length + ')')
      : 'No posting listed has a deadline still to come';
    ui.go.setAttribute('aria-label', ui.go.title);
    if (!target) ui.close && ui.close(false);

    ui.all.disabled = !dated.length || allTicked;
    ui.all.title = dated.length
      ? (allTicked ? 'Every listed posting with a date is already ticked'
        : 'Tick every posting listed that has a deadline still to come (' + dated.length + ')')
      : 'No posting listed has a deadline still to come';
    ui.all.setAttribute('aria-label', ui.all.title);

    ui.none.hidden = !n;
  }

  return {
    SITE: SITE,
    calName: calName,
    KINDS: KINDS,
    longDate: longDate,
    datesOf: datesOf,
    hasDate: hasDate,
    eventsFor: eventsFor,
    calendar: calendar,
    fileName: fileName,
    googleUrl: googleUrl,
    GOOGLE_TEMPLATE: GOOGLE_TEMPLATE,
    GOOGLE_IMPORT: GOOGLE_IMPORT,
    CHOICES: CHOICES,
    /* the browser half */
    onCard: onCard,
    attach: attach,
    refresh: refresh,
    pick: pick,
    isPicked: isPicked,
    clearPicks: clearPicks,
    count: count,
    targetRows: targetRows,
    signedIn: signedIn
  };
}));
