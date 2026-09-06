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
  var CAL_NAME = 'Job deadlines (Operations Academia)';

  /* The two dates, in the order they close a search. `label` heads the
     calendar entry; `note` is the one sentence a reader needs about it. */
  var KINDS = [
    { key: 'final', field: 'applyByDate', label: 'Final apply-by',
      note: 'The closing date of the search.' },
    { key: 'review', field: 'reviewDate', label: 'Suggested apply-by',
      note: 'The first-review or full-consideration date. A date passing here does not close the search.' }
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

  /** The advertisement, where the posting links one. */
  function advertOf(row) {
    return OAIcs.safeUrl(row.postedAtUrl) || OAIcs.safeUrl(row.adUrl) || '';
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
        var lines = [d.kind.label + ': ' + longDate(d.day) + '. ' + d.kind.note];
        /* the OTHER date, so an entry never hides the one that closes the
           search: a suggested date beside "until filled", or the final date
           beside a suggested one */
        KINDS.forEach(function (k) {
          if (k === d.kind) return;
          var other = day(row[k.field]);
          lines.push(k.label + ': ' + (other ? longDate(other) : 'none given (open until filled).'));
        });
        var listed = txt(row.applyBy);
        if (d.kind.key === 'final' && listed && listed !== longDate(d.day)) {
          lines.push('As listed: ' + listed);
        }
        var levels = (row.levels || []).map(txt).filter(Boolean).join(', ');
        if (levels) lines.push('Entry level: ' + levels);
        var ad = advertOf(row);
        if (ad) lines.push('Advertisement: ' + ad);
        lines.push('Posting on Operations Academia: ' + permalink(row, now));
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
   * @param meta  { now, today, market }
   */
  function calendar(rows, meta) {
    meta = meta || {};
    var now = meta.now instanceof Date ? meta.now : new Date();
    var events = eventsFor(rows, { now: now, today: meta.today });
    if (!events.length) return '';
    return OAIcs.build(events, {
      name: CAL_NAME,
      description: 'Application deadlines of job postings listed on Operations Academia' +
        (meta.market ? ' for the ' + txt(meta.market) + ' job market' : '') +
        ', as they stood on ' + longDate(todayIso(now)) + '. ' +
        'Each entry is an all-day reminder; a posting with no closing date (open until filled) has no entry. ' +
        SITE + 'jobs.html',
      now: now
    });
  }

  /* ======================================================================
     The browser half: a tick box on each dated posting, and a strip above
     the list that says what is ticked and downloads the file.
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
    refresh();
  }

  function pickedRows(rows) {
    return (rows || []).filter(function (r) { return r && isPicked(r.id); });
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
    var dates = datesOf(row);
    if (!dates.length) return;

    var input = el('input', { type: 'checkbox', class: 'oa-cal-box',
      'aria-label': 'Add this posting’s deadline to your calendar file' });
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

  /**
   * Mount the strip above the list's result bar. `list` is the OAList
   * mount's api (rows(), view()); `opts.market` names the season for the
   * file name. The page's `onRender` hands `refresh` the engine's snapshot
   * after every repaint, so the strip's counts are never a step behind.
   */
  function attach(list, host, opts) {
    if (!host || !list) return null;
    opts = opts || {};
    var old = host.querySelector('.oa-cal-tray');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var msg = el('p', { class: 'oa-cal-msg' });
    var all = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-all', text: 'Tick all listed' });
    var go = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-go', text: '📅 Download calendar (.ics)' });
    var none = el('button', { type: 'button', class: 'oa-cal-btn oa-cal-none', text: 'Untick all' });
    var tray = el('div', { class: 'oa-cal-tray', role: 'region',
      'aria-label': 'Deadlines to your calendar' }, [msg, all, go, none]);
    tray.hidden = true;

    ui = { tray: tray, msg: msg, all: all, go: go, none: none, list: list, opts: opts, snap: null };

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
    go.addEventListener('click', function () {
      var A = G.OAAccounts;
      if (!A) return;
      /* THE GATE: the Excel download's, verbatim in intent. whenSignedIn runs
         now for a signed-in reader, queues while the session restores, and
         offers the sign-in box otherwise. */
      A.whenSignedIn(function () { run(list, opts); });
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
      var li = box.closest ? box.closest('.oa-card') : null;
      var id = li ? String(li.id || '').replace(/^job-/, '') : '';
      box.checked = isPicked(id);
      if (li) li.classList.toggle('oa-cal-picked', box.checked);
    });
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * Repaint the strip from the engine's snapshot ({ view, rows, total }),
   * or from the list itself when called without one.
   */
  function refresh(snap) {
    if (!ui) return;
    if (snap && snap.view) ui.snap = snap;
    var s = ui.snap;
    var rows = s ? s.rows : ui.list.rows();
    var view = s ? s.view : ui.list.view();
    var show = signedIn() && !unavailable() && rows.length > 0;
    ui.tray.hidden = !show;
    if (!show) return;

    var n = count();
    var dated = view.filter(function (r) { return hasDate(r); });
    var allTicked = dated.length > 0 && dated.every(function (r) { return isPicked(r.id); });

    ui.msg.textContent = n
      ? plural(n, 'posting', 'postings') + ' ticked. Download the file and their apply-by dates land in your calendar, each as an all-day reminder.'
      : 'Tick a posting to put its apply-by dates in your calendar. ' +
        plural(dated.length, 'of the postings listed carries', 'of the postings listed carry') +
        ' a date still to come; a posting that is open until filled has none to add.';

    ui.go.disabled = !n;
    ui.go.title = n
      ? 'Download a calendar file (.ics) with the apply-by dates of the ' + plural(n, 'posting', 'postings') + ' you ticked'
      : 'Tick at least one posting first';
    ui.go.setAttribute('aria-label', ui.go.title);

    ui.all.disabled = !dated.length || allTicked;
    ui.all.title = dated.length
      ? (allTicked ? 'Every listed posting with a date is already ticked'
        : 'Tick every posting listed that has an apply-by date still to come (' + dated.length + ')')
      : 'No posting listed has an apply-by date still to come';
    ui.all.setAttribute('aria-label', ui.all.title);

    ui.none.hidden = !n;
  }

  /* Building the file is synchronous and takes milliseconds; there is no
     window for a second press to land in. */
  function run(list, opts) {
    var rows = pickedRows(list.rows());
    var now = new Date();
    var meta = { now: now, at: now, market: (opts && opts.market && opts.market()) || '' };
    var text = calendar(rows, meta);
    if (!text) {
      if (G.alert) G.alert('None of the postings you ticked has an apply-by date still to come, so there is nothing to put on a calendar.');
      return '';
    }
    var name = fileName(meta);
    try {
      OAIcs.download(name, text);
    } catch (e) {
      if (G.console) G.console.error('OA: the calendar download failed', e);
      if (G.alert) {
        G.alert('Sorry, the calendar file could not be prepared in this browser. ' +
          'Please try again, or let us know through the Feedback page.');
      }
    }
    return name;
  }

  return {
    SITE: SITE,
    CAL_NAME: CAL_NAME,
    KINDS: KINDS,
    longDate: longDate,
    datesOf: datesOf,
    hasDate: hasDate,
    eventsFor: eventsFor,
    calendar: calendar,
    fileName: fileName,
    /* the browser half */
    onCard: onCard,
    attach: attach,
    refresh: refresh,
    pick: pick,
    isPicked: isPicked,
    clearPicks: clearPicks,
    count: count,
    signedIn: signedIn
  };
}));
