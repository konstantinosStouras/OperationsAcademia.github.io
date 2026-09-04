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
        with, when it was first and last seen, and where its thread stands.
        Sortable by every column, filterable, and exportable as CSV.
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

  /** Every key the browser writes to `userDirectory/{uid}` — pinned against
      that rule's hasOnly() by selftest.mjs, both ways. Written by
      oa-accounts.js (syncDirectoryRow), read here. */
  var ROW_KEYS = ['name', 'email', 'first', 'seen'];

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

  var MAXLEN = { name: 200, email: 200, body: 5000 };

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
    ROW_KEYS: ROW_KEYS,
    THREAD_KEYS: THREAD_KEYS,
    ITEM_KEYS: ITEM_KEYS,
    ITEM_OWNER_KEYS: ITEM_OWNER_KEYS,
    MAXLEN: MAXLEN,
    csvCell: csvCell,
    csvOf: csvOf,
    threadRank: threadRank,
    threadLabel: threadLabel,
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
     shows. */
  var COLS = [
    {
      key: 'name', label: 'Name',
      cell: function (r) { return esc(r.name || '—'); },
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
      key: 'first', label: 'First seen',
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
        return '<span class="oa-fb-status ' + cls + '">' + esc(threadLabel(t)) + '</span>';
      },
      sort: function (r) { return threadRank(r.thread); }
    }
  ];

  var state = {
    rows: [],            // the roster, joined with its threads
    ghosts: [],          // threads whose roster row has gone (a merged account)
    sortKey: 'seen',
    sortDir: 'desc',
    filter: '',
    picked: {},          // uid -> true
    open: null           // uid of the thread being read, if any
  };

  function db() { return root.OAFB.ready().then(function (fb) { return fb.firestore(); }); }

  function visible() {
    var q = fold(state.filter);
    var rows = !q ? state.rows : state.rows.filter(function (r) {
      return fold(r.name).indexOf(q) >= 0 || fold(r.email).indexOf(q) >= 0;
    });
    var col = COLS.filter(function (c) { return c.key === state.sortKey; })[0] || COLS[3];
    return sortRows(rows, col.sort, state.sortDir);
  }

  function pickedUids() {
    return state.rows.filter(function (r) { return state.picked[r.uid]; })
      .map(function (r) { return r.uid; });
  }

  /* ------------------------------------------------------------- rendering */

  function renderTable() {
    var host = $('oa-aa-users-list');
    if (!host) return;
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
      var tds = COLS.map(function (c) { return '<td>' + c.cell(r) + '</td>'; }).join('');
      return '<tr data-uid="' + esc(r.uid) + '">' +
        '<td class="oa-u-tick"><input type="checkbox" class="oa-u-pick" ' +
          'data-uid="' + esc(r.uid) + '"' + (state.picked[r.uid] ? ' checked' : '') +
          ' aria-label="Select ' + esc(r.name || r.email || r.uid) + '"></td>' +
        tds +
        /* …and every row opens its conversation. Without this the "Message
           replies waiting" tile counts something the maintainer cannot reach:
           the only Open control was on the orphaned threads below. */
        '<td><button type="button" class="button oa-btn-ghost oa-u-open" data-uid="' +
          esc(r.uid) + '">' + (r.thread ? 'Open' : 'Message') + '</button></td>' +
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

    host.innerHTML =
      '<div class="oa-u-bar">' +
        '<label class="oa-u-find"><span>Find</span>' +
          '<input type="search" id="oa-u-filter" placeholder="name or e-mail" ' +
            'value="' + esc(state.filter) + '"></label>' +
        '<span class="oa-u-count">' + rows.length + ' of ' + state.rows.length +
          ' shown' + (picked ? ' · ' + picked + ' selected' : '') + '</span>' +
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
    Array.prototype.forEach.call(document.querySelectorAll('.oa-u-sort'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = k; state.sortDir = k === 'name' || k === 'email' ? 'asc' : 'desc'; }
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
    var headings = ['Name', 'E-mail', 'First seen', 'Last seen', 'Messages', 'uid'];
    var rows = visible().map(function (r) {
      return [r.name || '', r.email || '', day(r.first), day(r.seen),
        threadLabel(r.thread), r.uid];
    });
    var blob = new Blob([csvOf(headings, rows)], { type: 'text/csv;charset=utf-8' });
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
        if (ta) ta.value = '';
        state.picked = {};
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

  function load() {
    var host = $('oa-aa-users-list');
    return db().then(function (d) {
      return Promise.all([
        d.collection(DIRECTORY).get(),
        d.collection(THREADS).get()
      ]).then(function (both) {
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
