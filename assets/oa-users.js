/* ---------------------------------------------------------------------------
   Operations Academia — the registered-users roster, and the maintainer's
   side of the message threads (admin-area.html).

   WHAT WAS MISSING. The Admin area could COUNT registered accounts and learn
   nothing else about them: `registeredUsers/{uid}` is contentless by contract
   (`hasOnly(['t'])`), `profiles/{uid}` is owner-only, and the e-mail address
   is not in Firestore at all — it lives in the Firebase Auth record, which no
   browser can read for anyone but itself. So the maintainer could see "42"
   and had no way to know who they were or to reach any of them.

   TWO SURFACES, ONE PANEL (owner, 2026-08-24):

     1. THE ROSTER — every account that has signed in since the roster
        shipped, with the name it shows itself under, the address it signs in
        with, the affiliation on its profile, when it was first and last seen,
        and where its thread stands. Sortable by every column, filterable, and
        exportable as CSV.

        A NAME AND AN ADDRESS ARE SHOWN WHOLE, ON ONE LINE (owner, 2026-09-08:
        "I can't read the names of the registered users very well. Show them
        fully. Same with their email."). The cells carried `overflow-wrap:
        anywhere`, which lets the browser break a word at any character to fit
        the table into its panel — so beside the wide action column a name
        read "Xiaoda / n Shao" and an address was cut three ways. Those cells
        (and the status chip) are `white-space: nowrap` now, in oa-ui.css: the
        table grows to what its words need and scrolls inside `.oa-u-wrap`,
        which is what that container was always for. The affiliation, which
        can be a sentence, wraps at its SPACES inside a bounded span instead.

        THE AFFILIATION IS THE PROFILE'S, mirrored onto the roster row as a
        fifth key (`affiliation`, bounded by the rules like the profile's own
        field): the browser writes it beside the name when a session opens and
        again when the profile card is saved (oa-accounts.js, syncDirectoryRow),
        and the daily sync copies it from `profiles/{uid}` with the Admin SDK
        (_scraper/sync-user-directory.mjs), which is also what clears it once a
        person blanks theirs. The maintainer reads it here and nowhere else;
        it is never published, exactly as the profile card promises.

        …AND THE WHOLE ROW FITS ON ONE SCREEN (owner, 2026-09-08, second
        screenshot: the dates, the status and both buttons had gone off the
        right edge behind an affiliation five lines tall: "show Registered on,
        Last seen, messages, message, delete but keep the columns tighter so
        that I can quickly use that information"). The table is 13px with
        6px/8px cells, the affiliation is clamped to TWO lines in a narrower
        span with the whole text as its tooltip, the status chip carries a
        short word ("Awaiting you") with the long wording as its tooltip, and
        the two buttons are small. "First seen" reads "Registered on": since
        the daily sync fills `first` from Auth's own creationTime it IS the
        day the account was made (for an account made since the last sync it
        is the day the site first saw it, corrected backwards by the next
        run).

        "JM CANDIDATE" MARKS AN ACCOUNT HOLDING A CANDIDATE PROFILE FOR THE
        SEASON UNDER WAY (owner, the same message). The roster reads
        `candidateSubmissions` beside the roster (the maintainer may read the
        whole collection), keeps the documents whose `year` is
        OAJobNav.marketYear(now) — the one definition of the season — and
        whose status is one the build publishes (queued or published; a
        withdrawn or hidden profile is not a candidate on the site), and marks
        the roster rows their `uid`s name. A read that fails marks nobody,
        never everybody. Typing "candidate" into Find narrows the roster to
        them, so select-all under it is how every candidate is messaged at
        once, and the CSV carries the mark as a column.

        …AND THE SEASON IS CHOSEN (owner, 2026-09-09: "add a filter here so
        that the admin can immediately see all job market candidates of the
        given job market year"). The mark and the Find needle could only ever
        speak about the season UNDER WAY, so last season's candidates — the
        people the maintainer most often wants to write to once a market has
        rolled — were unreachable from this panel: nothing on it could name
        them and nothing could list them. The bar carries a chooser now, and
        the whole panel follows it. Three decisions hold it together:

          * IT IS ONE SEASON, NOT TWO. `markYear()` is the season the roster
            is TALKING ABOUT — the chosen one, or the one under way when none
            is chosen — and the pill, its tooltip, the count line and the Find
            needle all read it. So the list and the mark can never mean
            different seasons, which is the one way a year filter goes wrong.
          * THE SEASONS OFFERED ARE THE ONES THE ROSTER HOLDS, newest first,
            with the season under way always among them even at nought: a
            filter with one value is still drawn (the review panel's own
            rule), and "0" is a true answer where a missing option is not.
            Each carries its count, so the number is known before the press.
          * UNKNOWN DRAWS NOTHING. A candidate read that failed leaves
            `state.candidates` null, and then there is no chooser at all —
            never one whose every option would list nobody. The same rule the
            Delete control follows one function below.

        A row therefore stores the SEASONS it holds a live profile for
        (`candYears`, ascending) rather than one boolean, `candidateYearsOf`
        is the pure rule that reads them out of the documents, and the CSV
        column names the seasons instead of saying "Yes" — under a chooser
        set to All accounts that column is the only place the year survives.
     2. MESSAGING — tick the people to reach, write once, send. It opens (or
        continues) one thread per person, which they read and reply to in
        their own personal area.

   IT IS IN-APP, NOT E-MAIL, AND THAT IS THE WHOLE DESIGN. Nothing here sends
   mail: a message is a document the recipient reads when they next visit, so
   there is no SMTP path, no List-Unsubscribe, no delivery to stamp and
   nothing that can reach somebody who never comes back. The addresses are
   shown with `mailto:` links so the maintainer can write from their own
   client when e-mail is actually what they want, and the Feedback page
   remains the way a VISITOR starts a conversation — this direction is the
   maintainer's.

   ONE THREAD PER ACCOUNT, KEYED ON THE UID. That is what lets a person read
   their own unread count with a single get() and the maintainer list the
   threads owing a reply with one equality filter — no composite index either
   way. It also means a stranger cannot post into someone else's thread: the
   thread's id IS its owner's uid, so the rules' `isOwner(uid)` on the items
   subcollection is the id-composition guard in its strongest form.

   AUTHORISATION IS THE RULES, never this file. `userDirectory` and `messages`
   are admin-read/admin-write in _firestore.rules, so a browser that unhides
   this panel for the wrong visitor still cannot load or write a document.
   Drawing a control grants nothing.

   The rules publish themselves after a green check on master
   (oa-deploy-rules.yml); until a change lands the panel says so rather than
   showing a bare permission-denied (see _SETUP-FIREBASE.md §4).

   THIS IS ITS OWN FILE ON PURPOSE. oa-accounts.js fetches oa-adminarea.js in
   the maintainer's browser on EVERY page to compute the "Admin area" badge;
   roster rendering, sorting, CSV and the compose box do not belong in a file
   downloaded on the jobs page.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.OAUsers = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var DIRECTORY = 'userDirectory';
  var THREADS = 'messages';
  var ITEMS = 'items';
  /** The candidate profiles, read for the JM Candidate mark; pinned against
      OAFB.col by selftest.mjs like the two above. */
  var CANDIDATES = 'candidateSubmissions';
  /** The statuses of a profile that IS on the site (or held for the reveal):
      exactly what _scraper/build-candidates.mjs publishes, pinned by the
      selftest. A withdrawn or hidden profile is not a candidate here. */
  var CANDIDATE_LIVE = ['queued', 'published'];

  /** Every key the browser writes to `userDirectory/{uid}` — pinned against
      that rule's hasOnly() by selftest.mjs, both ways. Written by
      oa-accounts.js (syncDirectoryRow), read here. `affiliation` is the
      profile's, carried here so the roster can say where each person is. */
  var ROW_KEYS = ['name', 'email', 'first', 'seen', 'affiliation'];

  /** Every key on a thread head — pinned against the messages rule. */
  var THREAD_KEYS = ['uid', 'lastAt', 'lastFrom', 'needsAdmin', 'userUnread'];

  /** Every key on one message — pinned against the items rule. */
  var ITEM_KEYS = ['from', 'body', 't'];

  /** …and the ONE key the READER may change on a message that already exists:
      whether it is on their own list. Removing a message is a HIDE and never
      a delete — the words stay where they were said and the maintainer's copy
      of the conversation is whole, because a thread whose history either party
      can rewrite is not a record of anything. Pinned against the items rule's
      owner branch by selftest.mjs, both ways. */
  var ITEM_OWNER_KEYS = ['hiddenForUser'];

  var MAXLEN = { name: 200, email: 200, affiliation: 300, body: 5000 };

  /* ------------------------------------------------------------ pure parts */

  /** A CSV cell that a spreadsheet cannot be tricked into EXECUTING. Excel and
      Sheets treat a leading =, +, - or @ as a formula, and these values are
      names people typed about themselves — so the cell is quoted, its own
      quotes doubled, and a leading formula character defused with a leading
      apostrophe. There is no CSV precedent in this repository to copy; this is
      it. */
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function csvOf(headings, rows) {
    var out = [headings.map(csvCell).join(',')];
    rows.forEach(function (r) { out.push(r.map(csvCell).join(',')); });
    // CRLF: the line ending every spreadsheet agrees about.
    return out.join('\r\n') + '\r\n';
  }

  /** Where a person's thread stands, as one word the roster can sort on and
      the panel can label. Ordered by how much it wants the maintainer:
      2 = they have replied and are waiting, 1 = a thread is open, 0 = none. */
  function threadRank(t) {
    if (!t) return 0;
    return t.needsAdmin ? 2 : 1;
  }

  function threadLabel(t) {
    if (!t) return 'No messages';
    if (t.needsAdmin) return 'Replied — awaiting you';
    if (t.userUnread > 0) return 'Sent — unread';
    return 'Read';
  }

  /** The same four states as ONE OR TWO WORDS, for the chip in the roster:
      the long label set the whole column's width ("REPLIED — AWAITING YOU"
      in uppercase) and pushed the buttons off the screen. The long label
      stays as the chip's tooltip, in the CSV and on the orphaned threads. */
  function threadShort(t) {
    if (!t) return 'None';
    if (t.needsAdmin) return 'Awaiting you';
    if (t.userUnread > 0) return 'Unread';
    return 'Read';
  }

  /** Which market years each account holds a LIVE candidate profile for:
      uid -> [year, ...] ascending, deduped, from the raw documents. The READ
      is the browser's; the RULE is not, so it lives here where the selftest
      can drive it. A profile with no uid, no year, or a status the build does
      not publish (withdrawn, hidden, removed) is not a candidacy at all. */
  function candidateYearsOf(docs) {
    /* A PROTOTYPE-FREE MAP, because the keys are uids read out of documents.
       `var by = {}` reads `by['constructor']` back as a FUNCTION, which is
       truthy, so the accumulator below took it for its own list and threw on
       `list.indexOf` — and a throw here rejects the read that promises to
       resolve, which takes the whole roster down to "Could not load". The
       rules pin a profile's `uid` to its writer's own auth uid, so no signed-in
       reader can post one of these names; the Admin SDK is not bound by them,
       and one line removes the class. */
    var by = Object.create(null);
    (docs || []).forEach(function (c) {
      if (!c || !c.uid || CANDIDATE_LIVE.indexOf(c.status) < 0) return;
      var y = Math.trunc(Number(c.year));
      if (!y) return;
      var list = by[c.uid] || (by[c.uid] = []);
      if (list.indexOf(y) < 0) list.push(y);
    });
    Object.keys(by).forEach(function (u) {
      by[u].sort(function (a, b) { return a - b; });
    });
    return by;
  }

  /** Fold a name for sorting so accents and case do not scatter the list.
      The same instinct as OASchools' name folding, kept local and tiny. */
  function fold(s) {
    var t = String(s || '');
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.toLowerCase().trim();
  }

  /** Sort a loaded roster by one column spec, stable, with unknown values
      sunk to the BOTTOM in BOTH directions — an account with no name has
      nothing to compare, which is not the same as sorting before everything.
      Ties break on the load index so a re-click is a clean reversal rather
      than a reshuffle. (The lesson the simulation roster records: a sorted
      table must order itself by exactly what it displays.) */
  function sortRows(rows, key, dir) {
    var decorated = rows.map(function (r, i) { return { r: r, i: i, v: key(r) }; });
    var sign = dir === 'desc' ? -1 : 1;
    decorated.sort(function (a, b) {
      var av = a.v, bv = b.v;
      var an = av === null || av === undefined || av === '';
      var bn = bv === null || bv === undefined || bv === '';
      if (an && bn) return a.i - b.i;
      if (an) return 1;              // nulls last, whichever way we are sorting
      if (bn) return -1;
      if (av < bv) return -1 * sign;
      if (av > bv) return 1 * sign;
      return a.i - b.i;
    });
    return decorated.map(function (d) { return d.r; });
  }

  var api = {
    DIRECTORY: DIRECTORY,
    THREADS: THREADS,
    ITEMS: ITEMS,
    CANDIDATES: CANDIDATES,
    CANDIDATE_LIVE: CANDIDATE_LIVE,
    ROW_KEYS: ROW_KEYS,
    THREAD_KEYS: THREAD_KEYS,
    ITEM_KEYS: ITEM_KEYS,
    ITEM_OWNER_KEYS: ITEM_OWNER_KEYS,
    MAXLEN: MAXLEN,
    csvCell: csvCell,
    csvOf: csvOf,
    threadRank: threadRank,
    threadLabel: threadLabel,
    threadShort: threadShort,
    candidateYearsOf: candidateYearsOf,
    fold: fold,
    sortRows: sortRows
  };

  /* ---------------------------------------------------- the browser wiring */

  if (typeof document === 'undefined') return api;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function day(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try { return new Date(ms).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  /* The columns. ONE spec owns a column's heading, its cell AND its sort key,
     so a sorted table can never order itself by something other than what it
     shows. Each cell carries a class named after its key (`oa-u-c-<key>`),
     which is how oa-ui.css keeps the name, the address and the status chip on
     one line each while the affiliation wraps at its spaces. */
  var COLS = [
    {
      key: 'name', label: 'Name',
      cell: function (r) {
        /* The name in its own span (the one-line rule and the browser check
           both hang on it), and under it the JM Candidate mark. */
        var html = '<span class="oa-u-name">' + esc(r.name || '—') + '</span>';
        /* …for the season the panel is TALKING ABOUT — the one the chooser
           names, or the one under way when it names none — so the pill and
           the list beneath it can never mean two different seasons. */
        if (isCandIn(r, markYear())) {
          html += '<span class="oa-u-cand" title="Has a candidate profile for the ' +
            esc(seasonName(markYear()) || 'current') + ' job market">JM Candidate</span>';
        }
        return html;
      },
      sort: function (r) { return fold(r.name); }
    },
    {
      key: 'email', label: 'E-mail',
      cell: function (r) {
        if (!r.email) return '—';
        // The address is pinned by the rules to the account's own auth token,
        // so it is a real address rather than something typed; it is still
        // escaped into the href and the text.
        return '<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>';
      },
      sort: function (r) { return fold(r.email); }
    },
    {
      key: 'affiliation', label: 'Affiliation',
      cell: function (r) {
        /* The profile's own words about where the person is — a university,
           a company, sometimes a department too — so it may run to a
           sentence. The span is what lets it wrap at its spaces inside a
           bounded width while the cells beside it never wrap at all. */
        if (!r.affiliation) return '—';
        // Clamped to two lines by the stylesheet; the whole text is the tooltip.
        return '<span class="oa-u-aff" title="' + esc(r.affiliation) + '">' +
          esc(r.affiliation) + '</span>';
      },
      sort: function (r) { return fold(r.affiliation); }
    },
    {
      /* "Registered on" (owner, 2026-09-08): since the daily sync fills
         `first` from Auth's creationTime this is the day the account was
         made; a brand-new account shows the day the site first saw it until
         the next run corrects it backwards. */
      key: 'first', label: 'Registered on',
      cell: function (r) { return esc(day(r.first) || '—'); },
      sort: function (r) { return typeof r.first === 'number' ? r.first : null; }
    },
    {
      key: 'seen', label: 'Last seen',
      cell: function (r) { return esc(day(r.seen) || '—'); },
      sort: function (r) { return typeof r.seen === 'number' ? r.seen : null; }
    },
    {
      key: 'thread', label: 'Messages',
      cell: function (r) {
        var t = r.thread;
        var cls = t && t.needsAdmin ? 'is-open' : 'is-closed';
        return '<span class="oa-fb-status ' + cls + '" title="' + esc(threadLabel(t)) + '">' +
          esc(threadShort(t)) + '</span>';
      },
      sort: function (r) { return threadRank(r.thread); }
    }
  ];

  var state = {
    rows: [],            // the roster, joined with its threads
    ghosts: [],          // threads whose roster row has gone (a merged account)
    /* The account deletions that are queued, uid -> the work order, or NULL
       when the collection could not be read. Null is UNKNOWN and never an
       empty map: an empty map would draw every row as though nothing were
       queued, and the control it draws deletes somebody. */
    deletions: null,
    /* Which seasons each account holds a live candidate profile for,
       uid -> [year, ...], or NULL when the read failed or the market rule is
       absent: unknown marks nobody, never everybody — and draws no chooser.
       Every season is kept, not just the one under way, because choosing a
       past one is the whole point of the control below. */
    candidates: null,
    /* The season under way (OAJobNav.marketYear), and the one the CHOOSER
       names — 0 for "All accounts", which is where it opens. */
    year: 0,
    candYear: 0,
    sortKey: 'seen',
    sortDir: 'desc',
    filter: '',
    picked: {},          // uid -> true
    open: null           // uid of the thread being read, if any
  };

  function db() { return root.OAFB.ready().then(function (fb) { return fb.firestore(); }); }

  /** The season the roster is talking about: the one the chooser names, or
      the one under way when it names none. ONE definition, read by the mark,
      its tooltip, the count line and the Find needle alike. */
  function markYear() { return state.candYear || state.year; }

  /** A season's name, through OAJobNav.marketLabel — the site's one way of
      spelling a market year — with the same arithmetic as a fallback, since
      this panel already stands down entirely when that module is absent. */
  function seasonName(year) {
    var NAV = root.OAJobNav;
    var y = Math.trunc(Number(year) || 0);
    if (!y) return '';
    return NAV && typeof NAV.marketLabel === 'function' ? NAV.marketLabel(y) : (y - 1) + '-' + y;
  }

  /** Does this account hold a live candidate profile for that season? A row
      whose years are NULL is one the read could not answer for, and unknown
      is never a mark. */
  function isCandIn(r, year) {
    return !!(year && r.candYears && r.candYears.indexOf(year) >= 0);
  }

  function visible() {
    var q = fold(state.filter);
    var rows = state.rows.filter(function (r) {
      /* THE CHOOSER NARROWS FIRST, and on the season it names rather than on
         `markYear()` — the two are the same whenever one is chosen, and this
         way "All accounts" narrows nothing at all. */
      if (state.candYear && !isCandIn(r, state.candYear)) return false;
      if (!q) return true;
      return fold(r.name).indexOf(q) >= 0 || fold(r.email).indexOf(q) >= 0 ||
        fold(r.affiliation).indexOf(q) >= 0 ||
        /* "candidate" (three letters or more of it) narrows to the JM
           candidates, so select-all under it is how they are all messaged.
           Kept beside the chooser rather than replaced by it: it is what the
           panel's own copy has told the maintainer to type since the mark
           shipped, and it now follows whichever season is chosen. */
        (isCandIn(r, markYear()) && q.length >= 3 && 'jm candidate'.indexOf(q) >= 0);
    });
    var col = COLS.filter(function (c) { return c.key === state.sortKey; })[0] || COLS[3];
    return sortRows(rows, col.sort, state.sortDir);
  }

  function candidateCount() {
    return candCountIn(markYear());
  }

  function candCountIn(year) {
    return state.rows.filter(function (r) { return isCandIn(r, year); }).length;
  }

  /** Every season the roster holds a candidate for, NEWEST FIRST — with the
      season under way always among them, even at nought. A filter with one
      value is still drawn (the review panel's own rule): an option reading
      "(0)" is a true answer, where a missing option reads as a control that
      is broken. Counted over the whole roster rather than the rows on screen,
      so the numbers do not move as the maintainer types into Find. */
  function candSeasons() {
    var seen = {};
    if (state.year) seen[state.year] = true;
    state.rows.forEach(function (r) {
      (r.candYears || []).forEach(function (y) { seen[y] = true; });
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  function pickedUids() {
    return state.rows.filter(function (r) { return state.picked[r.uid]; })
      .map(function (r) { return r.uid; });
  }

  /* ------------------------------------------------------------- rendering */

  /**
   * The controls at the end of a row: open the conversation, and delete the
   * account (owner, 2026-09-05: "the admin should be able to delete a user").
   *
   * …and every row opens its conversation. Without that the "Message replies
   * waiting" tile counts something the maintainer cannot reach: the only Open
   * control was on the orphaned threads below.
   *
   * THE DELETE CONTROL IS WITHHELD WHERE THE QUEUE COULD NOT BE READ. A null
   * `state.deletions` means the accountDeletions collection did not answer —
   * the rules carrying it have not been published yet, most likely — and a
   * Delete button drawn then would either be refused or, worse, file a second
   * order over one already being carried out. Unknown draws nothing, the same
   * rule the account menu's badges follow.
   */
  function actionsFor(r) {
    var open = '<button type="button" class="button oa-btn-ghost oa-u-open" data-uid="' +
      esc(r.uid) + '">' + (r.thread ? 'Open' : 'Message') + '</button>';
    var D = root.OAAccountDelete;
    if (!D || state.deletions === null) return open;
    /* …and never on the maintainer's OWN row. The rules would allow it — an
       admin may file an order for any account, their own included — and the
       result would be a site whose only maintainer account had deleted
       itself, with the Admin area, the review queues and this roster gone
       with it. There is a delete control for their own account in the same
       place as everybody else's: their personal area. */
    var me = root.OAAccounts && root.OAAccounts.user();
    if (me && me.uid === r.uid) return open;
    var st = D.stateOf(state.deletions[r.uid]);
    if (!st.queued) {
      return open + ' <button type="button" class="button oa-btn-ghost oa-u-kill" ' +
        'data-uid="' + esc(r.uid) + '">Delete</button>';
    }
    return open + ' <span class="oa-u-going">' + esc(st.label) + '</span>' +
      (st.cancellable
        ? ' <button type="button" class="button oa-btn-ghost oa-u-unkill" data-uid="' +
          esc(r.uid) + '">Cancel</button>'
        : '');
  }

  function rowFor(uid) {
    return state.rows.filter(function (r) { return r.uid === uid; })[0] || { uid: uid };
  }

  /** File a deletion, once the maintainer has typed the word. It is a WORK
      ORDER and not the deletion itself: the browser cannot delete another
      account's alerts, its details, its tally mark or its Auth record, so
      _scraper/purge-accounts.mjs does all of it with the Admin SDK, on the
      jobs build's own completion. A confirm() is what this panel uses to
      delete an orphaned conversation; this asks for a word, because an
      account is not something an accidental press should be able to take. */
  function askDelete(uid) {
    var D = root.OAAccountDelete;
    if (!D) return;
    var r = rowFor(uid);
    var typed = root.prompt(
      'Delete this account and everything they posted?\n\n' +
      (r.name || '(no name)') + '\n' + (r.email || '(no address)') + '\n\n' +
      'Their job postings, candidate profile and placement reports come off the ' +
      'site, their e-mail alerts stop, their messages and details are removed, ' +
      'and their sign-in is deleted. You can call it off while it is still ' +
      'queued, and not afterwards.\n\n' +
      'Type ' + D.CONFIRM_WORD + ' to confirm:');
    if (!D.matchesConfirmation(typed)) return;
    D.requestFor(r).then(load)['catch'](function (err) { sayRosterError(err); });
  }

  /** Call one off while the sweep has not started. The rules refuse it
      afterwards, because "cancelled" would then be a lie. */
  function cancelDelete(uid) {
    var D = root.OAAccountDelete;
    if (!D) return;
    if (!root.confirm('Call off the deletion of this account?')) return;
    D.cancelFor(uid).then(load)['catch'](function (err) { sayRosterError(err); });
  }

  function sayRosterError(err) {
    var host = $('oa-aa-users-list');
    if (!host) return;
    host.insertAdjacentHTML('beforeend',
      '<p class="oa-form-msg is-err">' + (err && err.code === 'permission-denied'
        ? 'Not switched on yet. If the rules were published in the last few ' +
          'minutes, reload the page first; otherwise run the ' +
          '<strong>&ldquo;OA &mdash; publish the Firestore rules&rdquo;</strong> ' +
          'workflow from the Actions tab.'
        : 'Could not do that (' + esc(err && (err.code || err.message)) + ').') +
      '</p>');
  }

  function renderTable() {
    var host = $('oa-aa-users-list');
    if (!host) return;
    /* A NARROWING THE PANEL CANNOT EVALUATE IS NO NARROWING. `load()` runs
       again on every auth change and after every write, and a chosen season
       survives it — so a candidate read that then FAILS leaves every row's
       `candYears` null, `isCandIn` answers false for all of them, and the
       chosen season empties the roster ENTIRELY. There is no way back
       either: the chooser is withheld exactly when that read failed, so the
       one control that could undo it is no longer on the page. ONE REFUSED
       COLLECTION MUST NOT EMPTY THE ROSTER — the rule the whole panel is
       held to, and the reason the read resolves null rather than throwing.
       (Asking only whether the season is still OFFERED does not catch it:
       `candSeasons()` seeds the season under way unconditionally, so a
       maintainer who had chosen THIS season kept a narrowing nothing could
       satisfy.)

       The same drop catches a season whose last live profile has since been
       withdrawn, where the <select> would otherwise have no option to match
       and fall back to showing "All accounts" over a list narrowed to a
       season nobody is in — the control and the list saying different
       things, which is the one thing this chooser is built not to do. It
       only ever drops back to All accounts, never to some other season the
       maintainer did not ask for. */
    if (state.candYear && (!state.candidates ||
        candSeasons().indexOf(state.candYear) < 0)) state.candYear = 0;
    var rows = visible();
    var picked = pickedUids().length;

    if (!state.rows.length) {
      host.innerHTML = '<p class="oa-hint">No registered accounts yet. A row is ' +
        'written when someone signs in, and the daily directory sync adds every ' +
        'account Firebase Auth knows.</p>';
      return;
    }

    /* The select-all box must SHOW its own state, or it can be ticked and never
       un-ticked: the strip re-renders on every pick and would paint it empty
       again. It is checked when every row on screen is picked. */
    var allOn = rows.length > 0 && rows.every(function (r) { return !!state.picked[r.uid]; });
    var head = '<tr><th class="oa-u-tick"><input type="checkbox" id="oa-u-all"' +
      (allOn ? ' checked' : '') + ' aria-label="Select every account shown"></th>';
    COLS.forEach(function (c) {
      var on = state.sortKey === c.key;
      var arrow = on ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      head += '<th><button type="button" class="oa-u-sort' + (on ? ' is-on' : '') +
        '" data-sort="' + esc(c.key) + '" aria-label="Sort by ' + esc(c.label) + '">' +
        esc(c.label) + arrow + '</button></th>';
    });
    head += '<th></th></tr>';

    var body = rows.map(function (r) {
      var tds = COLS.map(function (c) {
        return '<td class="oa-u-c-' + esc(c.key) + '">' + c.cell(r) + '</td>';
      }).join('');
      return '<tr data-uid="' + esc(r.uid) + '">' +
        '<td class="oa-u-tick"><input type="checkbox" class="oa-u-pick" ' +
          'data-uid="' + esc(r.uid) + '"' + (state.picked[r.uid] ? ' checked' : '') +
          ' aria-label="Select ' + esc(r.name || r.email || r.uid) + '"></td>' +
        tds +
        '<td class="oa-u-actions">' + actionsFor(r) + '</td>' +
        '</tr>';
    }).join('');

    var ghosts = '';
    if (state.ghosts.length) {
      /* A thread whose roster row has gone: the account was merged into
         another (the merge deletes its row while it can still write as that
         user) or deleted. The record is kept rather than quietly dropped —
         the maintainer can read it, and only they can delete one. */
      ghosts = '<h4 class="oa-aa-group-h">Threads with no account (' +
        state.ghosts.length + ')</h4><p class="oa-hint">These accounts are no ' +
        'longer registered — merged into another account, or removed. Their ' +
        'conversations are kept; open one to read or delete it.</p><ul class="oa-u-ghosts">' +
        state.ghosts.map(function (t) {
          return '<li><button type="button" class="oa-u-open" data-uid="' + esc(t.uid) +
            '">' + esc(t.uid) + '</button> <span class="oa-hint">' +
            esc(threadLabel(t)) + (t.lastAt ? ' · ' + esc(day(t.lastAt)) : '') +
            '</span> <button type="button" class="button oa-btn-ghost oa-u-del" ' +
            'data-uid="' + esc(t.uid) + '">Delete</button></li>';
        }).join('') + '</ul>';
    }

    /* THE JOB MARKET YEAR CHOOSER (owner, 2026-09-09). Drawn only where the
       candidate read ANSWERED and the market rule is loaded: unknown draws
       nothing, never a chooser whose every option would list nobody. The
       count rides on each option, so the maintainer knows the answer before
       pressing — which is what "immediately see" asks for. */
    var chooser = '';
    if (state.candidates && state.year) {
      chooser = '<label class="oa-u-year"><span>JM candidates</span>' +
        '<select id="oa-u-candyear" ' +
          'aria-label="Show only the job market candidates of one season">' +
        '<option value=""' + (state.candYear ? '' : ' selected') + '>All accounts</option>' +
        candSeasons().map(function (y) {
          return '<option value="' + y + '"' + (state.candYear === y ? ' selected' : '') +
            '>' + esc(seasonName(y)) + ' (' + candCountIn(y) + ')</option>';
        }).join('') + '</select></label>';
    }
    var marked = candidateCount();

    host.innerHTML =
      '<div class="oa-u-bar">' +
        '<label class="oa-u-find"><span>Find</span>' +
          '<input type="search" id="oa-u-filter" placeholder="name, e-mail or affiliation" ' +
            'value="' + esc(state.filter) + '"></label>' +
        chooser +
        '<span class="oa-u-count">' + rows.length + ' of ' + state.rows.length +
          ' shown' + (picked ? ' · ' + picked + ' selected' : '') +
          /* …and the count NAMES its season, or a number that moves with the
             chooser above it says nothing about which market it counts. */
          (marked ? ' · ' + marked + ' JM candidate' + (marked === 1 ? '' : 's') +
            (seasonName(markYear()) ? ' for ' + esc(seasonName(markYear())) : '') : '') +
          '</span>' +
        '<button type="button" class="button oa-btn-ghost" id="oa-u-csv">' +
          'Download CSV</button>' +
      '</div>' +
      '<div class="oa-u-wrap"><table class="oa-u-table"><thead>' + head +
        '</thead><tbody>' + body + '</tbody></table></div>' +
      ghosts;

    wireTable();
  }

  function wireTable() {
    var f = $('oa-u-filter');
    if (f) {
      f.addEventListener('input', function () {
        state.filter = f.value || '';
        renderTable();
        /* Restore focus AND the caret where it actually was — forcing it to the
           end makes editing a term mid-string impossible. */
        var at = f.selectionStart;
        var again = $('oa-u-filter');
        if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) {} }
      });
    }
    var y = $('oa-u-candyear');
    if (y) {
      y.addEventListener('change', function () {
        state.candYear = Math.trunc(Number(y.value)) || 0;
        renderTable();
        /* The control is replaced under the reader's own hand — the whole
           strip is re-rendered — so the keyboard goes back to it, exactly as
           it does for the Find box above. */
        var again = $('oa-u-candyear');
        if (again) again.focus();
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-sort'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else {
          state.sortKey = k;
          state.sortDir = k === 'name' || k === 'email' || k === 'affiliation' ? 'asc' : 'desc';
        }
        renderTable();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-pick'), function (c) {
      c.addEventListener('change', function () {
        var uid = c.getAttribute('data-uid');
        if (c.checked) state.picked[uid] = true; else delete state.picked[uid];
        renderTable();
        renderCompose();
      });
    });
    var all = $('oa-u-all');
    if (all) {
      all.addEventListener('change', function () {
        // Select-all acts on the rows CURRENTLY SHOWN, so the Find box doubles
        // as the recipient picker.
        visible().forEach(function (r) {
          if (all.checked) state.picked[r.uid] = true; else delete state.picked[r.uid];
        });
        renderTable();
        renderCompose();
      });
    }
    var csv = $('oa-u-csv');
    if (csv) csv.addEventListener('click', downloadCsv);
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-open'), function (b) {
      b.addEventListener('click', function () { openThread(b.getAttribute('data-uid')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-del'), function (b) {
      b.addEventListener('click', function () { deleteThread(b.getAttribute('data-uid')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-kill'), function (b) {
      b.addEventListener('click', function () { askDelete(b.getAttribute('data-uid')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-unkill'), function (b) {
      b.addEventListener('click', function () { cancelDelete(b.getAttribute('data-uid')); });
    });
  }

  /* Remove an orphaned conversation for good. Offered only on a thread whose
     roster row has gone — a live account's thread is a record of something and
     stays. The rules allow the maintainer alone to delete, and the items go
     first: deleting only the head would leave the messages unreachable rather
     than gone. */
  function deleteThread(uid) {
    if (!root.confirm('Delete this conversation for good? This cannot be undone.')) return;
    db().then(function (d) {
      var head = d.collection(THREADS).doc(uid);
      return head.collection(ITEMS).get().then(function (snap) {
        var kill = [];
        snap.forEach(function (doc) { kill.push(doc.ref.delete()); });
        return Promise.all(kill);
      }).then(function () { return head.delete(); });
    }).then(load)['catch'](function (err) {
      var host = $('oa-aa-users-list');
      if (host) {
        host.insertAdjacentHTML('beforeend',
          '<p class="oa-form-msg is-err">Could not delete (' +
          esc(err && (err.code || err.message)) + ').</p>');
      }
    });
  }

  function downloadCsv() {
    var headings = ['Name', 'E-mail', 'Affiliation', 'JM candidate', 'Registered on',
      'Last seen', 'Messages', 'uid'];
    var rows = visible().map(function (r) {
      /* The SEASONS rather than "Yes": one column, saying the mark and which
         market it is for. Under the chooser set to All accounts this is the
         only place the year survives the download, and a spreadsheet can sort
         and filter on it — which is what a CSV of a roster is for. */
      return [r.name || '', r.email || '', r.affiliation || '',
        (r.candYears || []).map(seasonName).join('; '),
        day(r.first), day(r.seen), threadLabel(r.thread), r.uid];
    });
    /* THE BYTE ORDER MARK IS FOR EXCEL. It opens a .csv as the machine's own
       legacy code page unless the file announces UTF-8, so "École
       polytechnique" and every accented or non-Latin NAME in this roster
       arrived as mojibake — on a file whose whole point is that the
       maintainer can read who has registered. Every other reader ignores a
       BOM, and the charset in the type is kept for the ones that read it. */
    var blob = new Blob(['\uFEFF' + csvOf(headings, rows)],
      { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'operations-academia-users-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Pair every createObjectURL with a revoke, as the profile-photo path does.
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function renderCompose() {
    var host = $('oa-aa-users-compose');
    if (!host) return;
    var n = pickedUids().length;
    /* Ticking a recipient re-renders this block, and rebuilding the textarea
       would throw away a message already written — which is exactly the order
       people work in: write, then choose who. Carry the draft across. */
    var draft = ($('oa-u-body') || {}).value || '';
    host.innerHTML =
      '<h4 class="oa-aa-group-h">Send a message</h4>' +
      '<p class="oa-hint">It appears in the person’s own area on this site under ' +
        '“Messages”, and they can reply to you there. No e-mail is sent — ' +
        'use the address links above if e-mail is what you want.</p>' +
      '<p><textarea id="oa-u-body" rows="5" maxlength="' + MAXLEN.body + '" ' +
        'placeholder="Write your message…"></textarea></p>' +
      '<p><button type="button" class="button blue" id="oa-u-send"' +
        (n ? '' : ' disabled') + '>' +
        (n ? 'Send to ' + n + (n === 1 ? ' person' : ' people') : 'Select who to message') +
        '</button> <span class="oa-form-msg" id="oa-u-msg" role="status"></span></p>';
    var ta = $('oa-u-body');
    if (ta && draft) ta.value = draft;
    var b = $('oa-u-send');
    if (b) b.addEventListener('click', send);
  }

  /* --------------------------------------------------------------- sending */

  function send() {
    var ta = $('oa-u-body');
    var msg = $('oa-u-msg');
    var body = ta ? String(ta.value || '').trim() : '';
    var uids = pickedUids();
    if (!body) { if (msg) { msg.className = 'oa-form-msg is-err'; msg.textContent = 'Write a message first.'; } return; }
    if (body.length > MAXLEN.body) { if (msg) { msg.className = 'oa-form-msg is-err'; msg.textContent = 'That is longer than ' + MAXLEN.body + ' characters.'; } return; }
    if (!uids.length) return;

    var who = uids.length === 1 ? 'this person' : uids.length + ' people';
    if (!root.confirm('Send this message to ' + who + '?')) return;

    var btn = $('oa-u-send');
    if (btn) btn.disabled = true;
    if (msg) { msg.className = 'oa-form-msg'; msg.textContent = 'Sending…'; }

    root.OAFB.ready().then(function (fb) {
      var d = fb.firestore();
      var now = Date.now();
      var sent = 0, failed = 0;
      /* One at a time, failures counted rather than thrown — the shape
         approveAll uses for a whole season of postings. A half-finished
         broadcast must report what it did, not vanish into a rejection. */
      return uids.reduce(function (chain, uid) {
        return chain.then(function () {
          var head = d.collection(THREADS).doc(uid);
          var row = state.rows.filter(function (r) { return r.uid === uid; })[0];
          var prev = (row && row.thread) || null;
          /* ONE atomic write for the message and its bookkeeping. Two
             sequential writes can half-fail: the recipient would hold a
             message the roster does not know about, and this would report it
             as undelivered when it had in fact arrived. */
          var batch = d.batch();
          batch.set(head.collection(ITEMS).doc(), { from: 'admin', body: body, t: now });
          if (prev) {
            /* AN EXISTING THREAD IS UPDATED, NOT RE-STATED. `prev` is the
               roster as it was READ when the page opened, and the maintainer
               may have spent a while composing: the recipient can have replied
               (needsAdmin → true) or read the thread (userUnread → 0) in
               between, and a set() copying the stale values back would drop
               that reply out of the "awaiting you" queue unread and miscount
               the badge. So `needsAdmin` is NOT written at all — a broadcast
               is not an answer; only "Mark answered" or a reply clears it —
               and the unread count is a server-side increment. */
            batch.update(head, {
              lastAt: now,
              lastFrom: 'admin',
              userUnread: fb.firestore.FieldValue.increment(1)
            });
          } else {
            batch.set(head, {
              uid: uid, lastAt: now, lastFrom: 'admin', needsAdmin: false, userUnread: 1
            }, { merge: true });
          }
          return batch.commit()
            .then(function () { sent++; })
            ['catch'](function () { failed++; });
        });
      }, Promise.resolve()).then(function () {
        /* KEEP THE MESSAGE WHEN NOTHING WENT. Emptying the box and the ticks
           is right after a send that reached somebody; after one that reached
           NOBODY it throws away what the maintainer typed and every recipient
           they had picked, so the only way to try again is to write the whole
           thing out afresh. renderCompose carries a live draft across its own
           re-render, so leaving the value alone is all this takes. */
        if (sent) {
          if (ta) ta.value = '';
          state.picked = {};
        }
        /* Reload FIRST — it repaints the compose block, which would otherwise
           wipe the line below — then say what happened. */
        return load().then(function () {
          var after = $('oa-u-msg');
          if (after) {
            after.className = failed ? 'oa-form-msg is-err' : 'oa-form-msg is-ok';
            after.textContent = failed
              ? 'Sent to ' + sent + '; ' + failed + ' could not be delivered.'
              : 'Sent to ' + sent + (sent === 1 ? ' person.' : ' people.');
          }
        });
      });
    })['catch'](function (err) {
      /* Re-enable whichever button is on screen: the reload above may already
         have replaced the one we disabled, and a Send stuck disabled is a
         panel the maintainer has to reload to use again. */
      var live = $('oa-u-send');
      if (live) live.disabled = false;
      if (btn) btn.disabled = false;
      var out = $('oa-u-msg') || msg;
      if (out) {
        out.className = 'oa-form-msg is-err';
        out.textContent = err && err.code === 'permission-denied'
          ? 'The messaging rules have not been published yet — run the ' +
            '“OA — publish the Firestore rules” workflow (see _SETUP-FIREBASE.md §4).'
          : 'Could not send (' + (err && (err.code || err.message)) + ').';
      }
    });
  }

  /* ------------------------------------------------------ reading a thread */

  function openThread(uid) {
    state.open = uid;
    var host = $('oa-aa-users-thread');
    if (!host) return;
    show(host, true);
    host.innerHTML = '<p class="oa-hint">Loading…</p>';
    db().then(function (d) {
      return d.collection(THREADS).doc(uid).collection(ITEMS).orderBy('t').get()
        .then(function (snap) {
          var items = [];
          snap.forEach(function (doc) { items.push(doc.data() || {}); });
          var row = state.rows.filter(function (r) { return r.uid === uid; })[0];
          var who = row ? (row.name || row.email || uid) : uid;
          host.innerHTML =
            '<h4 class="oa-aa-group-h">Conversation with ' + esc(who) + '</h4>' +
            '<ul class="oa-u-thread">' + items.map(function (m) {
              /* A message the reader has taken off THEIR list is still here,
                 and is shown as exactly that. The maintainer's copy is the
                 record — that is the whole reason removing is a hide — and a
                 maintainer who quotes back a message the other person can no
                 longer see is talking past them. */
              var gone = m.hiddenForUser === true;
              return '<li class="oa-u-msg is-' + (m.from === 'user' ? 'them' : 'me') +
                (gone ? ' is-gone' : '') + '">' +
                '<span class="oa-u-who">' + (m.from === 'user' ? esc(who) : 'You') +
                '</span><span class="oa-u-when">' + esc(day(m.t)) + '</span>' +
                '<p>' + esc(m.body).replace(/\n/g, '<br>') + '</p>' +
                (gone ? '<p class="oa-hint">Removed from their list — they can ' +
                  'restore it; you still have it.</p>' : '') + '</li>';
            }).join('') + '</ul>' +
            '<p><button type="button" class="button oa-btn-ghost" id="oa-u-close">Close</button> ' +
            '<button type="button" class="button oa-btn-ghost" id="oa-u-seen">Mark answered</button> ' +
            '<span class="oa-form-msg" id="oa-u-tmsg" role="status"></span></p>';
          var c = $('oa-u-close');
          if (c) c.addEventListener('click', function () { state.open = null; show(host, false); });
          var s = $('oa-u-seen');
          if (s) s.addEventListener('click', function () { markAnswered(uid); });
        });
    })['catch'](function (err) {
      host.innerHTML = '<p class="oa-form-msg is-err">Could not open the ' +
        'conversation (' + esc(err && (err.code || err.message)) + ').</p>';
    });
  }

  /** Clear the "they are waiting" flag without writing a message — the
      maintainer has read it and it needs nothing further. */
  function markAnswered(uid) {
    db().then(function (d) {
      return d.collection(THREADS).doc(uid).set({ needsAdmin: false }, { merge: true });
    }).then(function () {
      var m = $('oa-u-tmsg');
      if (m) { m.className = 'oa-form-msg is-ok'; m.textContent = 'Marked as answered.'; }
      return load();
    })['catch'](function (err) {
      var m = $('oa-u-tmsg');
      if (m) { m.className = 'oa-form-msg is-err'; m.textContent = 'Could not update (' + (err && (err.code || err.message)) + ').'; }
    });
  }

  /* --------------------------------------------------------------- loading */

  /** Which seasons each account holds a live candidate profile for, or NULL
      when it cannot be known. The season UNDER WAY is OAJobNav.marketYear,
      the ONE definition of which market is on — it is what the mark and the
      chooser open on — and without that module there is no answer at all
      rather than a private guess. EVERY season is kept, not only the one
      under way: choosing a past one is what the chooser is for, and the read
      is the same single read either way. The statuses are the build's own,
      applied by `candidateYearsOf`. Resolves rather than throws, like the
      deletions read beside it: one refused collection must not empty the
      roster. */
  function loadCandidates(d) {
    var NAV = root.OAJobNav;
    if (!NAV || typeof NAV.marketYear !== 'function') return Promise.resolve(null);
    state.year = NAV.marketYear(new Date());
    /* `.then(fn).catch(...)`, never `.then(fn, onError)`: the two-argument
       form catches the READ failing and not the mapping throwing, so the
       promise this function says resolves could still reject and empty the
       whole roster. One catch after the work covers both. */
    return d.collection(CANDIDATES).get().then(function (snap) {
      var docs = [];
      snap.forEach(function (doc) { docs.push(doc.data() || {}); });
      return candidateYearsOf(docs);
    })['catch'](function () { return null; });
  }

  function load() {
    var host = $('oa-aa-users-list');
    return db().then(function (d) {
      return Promise.all([
        d.collection(DIRECTORY).get(),
        d.collection(THREADS).get(),
        /* …and which accounts are on their way out. Its own read, resolving
           null rather than throwing: the roster is what this panel is for,
           and one refused collection must not empty it. */
        root.OAAccountDelete ? root.OAAccountDelete.loadRequests() : Promise.resolve(null),
        loadCandidates(d)
      ]).then(function (both) {
        state.deletions = both[2];
        state.candidates = both[3];
        var threads = {};
        both[1].forEach(function (doc) {
          var t = doc.data() || {};
          t.uid = t.uid || doc.id;
          threads[doc.id] = t;
        });
        var rows = [];
        both[0].forEach(function (doc) {
          var r = doc.data() || {};
          r.uid = doc.id;
          r.thread = threads[doc.id] || null;
          /* NULL, never an empty list, when the read could not answer: the
             two mean different things and only one of them is "no". */
          r.candYears = state.candidates ? (state.candidates[doc.id] || []) : null;
          delete threads[doc.id];
          rows.push(r);
        });
        state.rows = rows;
        // whatever thread is left has no roster row behind it
        state.ghosts = Object.keys(threads).map(function (k) { return threads[k]; });
        renderTable();
        renderCompose();
        if (root.OAAdminArea && typeof root.OAAdminArea.refresh === 'function') {
          root.OAAdminArea.refresh();
        }
      });
    })['catch'](function (err) {
      if (host) {
        host.innerHTML = '<p class="oa-form-msg is-err">' + (err && err.code === 'permission-denied'
          /* TWO CAUSES, and telling them apart is the whole point of this
             message. The remedy is a BUTTON now, not a terminal (the rules
             publish from GitHub Actions with the service account this site
             already holds — oa-deploy-rules.yml); the old wording sent the
             maintainer to install a CLI and log in, which is exactly why six
             rule-gated features sat inert.

             And the SECOND cause is the one that cost an afternoon on
             2026-08-25: the rules had just been published and this page was
             still the copy the browser had cached from before, so it went on
             reporting a deploy that had already happened. A message cannot
             fix a stale copy of itself — but once loaded it can say to
             reload, which is why that comes FIRST. */
          ? 'This list is empty rather than broken. <strong>If the rules were ' +
            'published in the last few minutes, reload the page</strong> ' +
            '(Ctrl+F5 / ⌘⇧R) — this panel may be a copy your browser cached ' +
            'before they went live. Otherwise they have not been published ' +
            'yet: run the <strong>“OA — publish the Firestore rules”</strong> ' +
            'workflow from the repository’s Actions tab (it also runs itself ' +
            'after every green check on master), or <code>firebase deploy ' +
            '--only firestore:rules --project operations-academia</code> ' +
            'locally. See _SETUP-FIREBASE.md §4.'
          : 'Could not load the roster (' + esc(err && (err.code || err.message)) + ').') +
          '</p>';
      }
    });
  }

  function boot() {
    if (!root.OAAccounts || !root.OAFB || !$('oa-aa-users')) return;
    root.OAAccounts.onChange(function () {
      if (!root.OAAccounts.isAdmin()) { show($('oa-aa-users'), false); return; }
      show($('oa-aa-users'), true);
      load();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return api;
}));
