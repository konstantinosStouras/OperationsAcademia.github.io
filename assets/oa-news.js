/* ---------------------------------------------------------------------------
   Operations Academia — the What's-new list: who may see an entry, and the
   maintainer's controls over it.

   ONE definition, loaded by ALL THREE consumers:

     the front page   <script src="assets/oa-news.js">          -> window.OANews
     the full log     whats-new.html, the same tag              -> window.OANews
     the mailer       createRequire(...)('.../oa-news.js')      -> module.exports

   The two pages used to carry a renderer each, and they had already drifted:
   the front page could edit an entry and the full log could not, one read the
   admin address from a literal and the other from OAFB.adminEmail. The mailer,
   meanwhile, read changelog.json raw — so an entry the maintainer had taken
   off the site was still e-mailed to every subscriber. Same reasoning as
   assets/oa-alert-match.js: a dual-mode file removes the drift instead of
   documenting it, and "what I see on the site" and "what I am e-mailed" cannot
   mean different things.

   THE MODEL. changelog.json stays the source of truth for WHAT was announced.
   Firestore `newsOverrides/{changelog id}` holds the maintainer's DECISION
   about it, and nothing else:

     status: 'approved'   published — every visitor sees it
     status: 'pending'    not yet reviewed — only the maintainer sees it
     status: 'removed'    taken down — it leaves the list entirely
     title / summary      an optional rewording, applied wherever it is shown

   TWO RULES THE OWNER ASKED FOR (2026-08-18), and they pull in opposite
   directions, so both are written down here:

   1. A REMOVED ENTRY LEAVES THE LIST — for the maintainer too. It used to stay
      on the page, struck through and faded, carrying "Hidden — only you can
      see this", which is exactly the clutter Remove was pressed to be rid of.
   2. AND REMOVING IS STILL NOT A ONE-WAY DOOR. Filtering it out for everybody
      was what made Remove irreversible before (there was nothing left on the
      page to press, and the only way back was the Firestore console). So the
      removed entries go into a COLLAPSED disclosure below the list, drawn only
      for the maintainer: out of the way, one click from Restore. The list is
      clean and the door stays open.

   3. AND A NEW ENTRY IS NOT PUBLIC ON SIGHT. changelog.json is written by the
      maintainer and by whoever is shipping a change, and the entry reached
      visitors — and the e-mail digests — the moment it was committed. An entry
      with no decision is PENDING: the maintainer sees it flagged, with
      Approve, and nobody else sees it at all. Absence means withhold, the same
      way round as the job-review queue: a queue that fails to write cannot
      leak an entry onto the site.

   THE GATE ARRIVING IS NOT A REASON TO RETRACT. The 35 entries already on the
   site have no decision document, and on the first load after this shipped
   every one of them would have gone pending — the whole update log would have
   vanished from a public page. Already public is already reviewed in the only
   sense that matters, so an entry dated before REVIEW_FROM is approved by
   default. It is a DATE rather than a list of ids so that nothing has to be
   backfilled and no list has to be maintained; the same reasoning the mailer
   already applies to a back-dated entry (it precedes every subscriber's
   window, so it reaches nobody) makes back-dating safe here too.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OANews = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLLECTION = 'newsOverrides';

  var APPROVED = 'approved';
  var PENDING = 'pending';
  var REMOVED = 'removed';

  /* Every key a decision document may carry. Pinned against the hasOnly() list
     in _firestore.rules by selftest.mjs — a key written here without a rule is
     a permission-denied at save time and a maintainer told to redeploy rules
     that are already deployed. */
  var DOC_KEYS = ['status', 'hidden', 'title', 'summary', 't'];

  var TITLE_MAX = 300;
  var SUMMARY_MAX = 2000;

  /* The day the review gate shipped. An entry dated BEFORE this was already
     public, so it is approved without a document; an entry dated on or after
     it waits for the maintainer. */
  var REVIEW_FROM = '2026-08-19';

  function day(v) {
    return String(v == null ? '' : v).slice(0, 10);
  }

  function arr(v) {
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  }

  /** What a stored document SAYS, or '' when it says nothing about publication.

      Documents written before the gate carry `hidden` and no `status`:
      {hidden: true} was a removal and {hidden: false} a restore. They are read
      here rather than migrated, so nothing has to run against the database and
      a maintainer who takes an entry down today and reads it back on an older
      cached page still sees it gone. */
  function decision(doc) {
    if (!doc) return '';
    var s = String(doc.status || '');
    if (s === APPROVED || s === PENDING || s === REMOVED) return s;
    if (doc.hidden === true) return REMOVED;
    if (doc.hidden === false) return APPROVED;
    return '';
  }

  /** approved | pending | removed, for one changelog entry. */
  function statusOf(entry, doc, opts) {
    var said = decision(doc);
    if (said) return said;
    var from = (opts && opts.reviewFrom) || REVIEW_FROM;
    return day(entry && entry.date) < from ? APPROVED : PENDING;
  }

  /** The entry as it should READ — the maintainer's wording where they gave
      one, the changelog's where they did not. Same shape as a changelog entry,
      so a caller that renders one can render this. */
  function applied(entry, doc) {
    var o = doc || {};
    var e = entry || {};
    return {
      id: e.id,
      date: day(e.date),
      title: (typeof o.title === 'string' && o.title) ? o.title : (e.title || ''),
      summary: (typeof o.summary === 'string' && o.summary) ? o.summary : (e.summary || ''),
      url: e.url || ''
    };
  }

  function byDateDesc(a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
  }

  /**
   * Split the changelog three ways under the maintainer's decisions.
   * `docs` is a plain object of decision documents keyed by changelog id.
   * Every list is newest first and carries entries in the shape above, each
   * with `status` and `edited` beside it.
   */
  function partition(updates, docs, opts) {
    var d = docs || {};
    var out = { approved: [], pending: [], removed: [] };
    arr(updates).forEach(function (e) {
      if (!e || !e.id) return;
      var doc = d[e.id];
      var row = applied(e, doc);
      row.status = statusOf(e, doc, opts);
      row.edited = !!(doc && (doc.title || doc.summary));
      if (row.status === REMOVED) out.removed.push(row);
      else if (row.status === PENDING) out.pending.push(row);
      else out.approved.push(row);
    });
    out.approved.sort(byDateDesc);
    out.pending.sort(byDateDesc);
    out.removed.sort(byDateDesc);
    return out;
  }

  /**
   * What may be shown to ANYONE — the page's public list and, just as
   * importantly, the only entries the mailer may put in a digest. A pending
   * entry that reached an inbox would defeat the whole gate, since the e-mail
   * cannot be recalled.
   */
  function publicUpdates(updates, docs, opts) {
    return partition(updates, docs, opts).approved.map(function (r) {
      return { id: r.id, date: r.date, title: r.title, summary: r.summary, url: r.url };
    });
  }

  /** The document a decision writes. `hidden` is kept in step with `status`
      because a page served from an old cache still reads that field, and a
      stale tab must not put a removed entry back on screen. */
  function patchFor(status, extra) {
    var p = { status: status, hidden: status === REMOVED, t: Date.now() };
    if (extra) {
      if (typeof extra.title === 'string') p.title = extra.title.slice(0, TITLE_MAX);
      if (typeof extra.summary === 'string') p.summary = extra.summary.slice(0, SUMMARY_MAX);
    }
    return p;
  }

  /* ------------------------------------------------------------ the browser

     Everything below touches the DOM and runs only when mount() is called, so
     requiring this file in Node stays free of it. */

  var LIST_CLASS = 'v3-news';

  /* A page mounts its list without keeping the handle, so the test hook is
     module-level and reaches every list on the page. */
  var MOUNTED = [];

  /** Tell `fn` whether the maintainer is signed in, now and whenever it
      changes. OAAccounts is the site's own answer and the one that checks the
      address is VERIFIED; the fallback exists only for a page that loads this
      module without the accounts script, where the worst case is that the
      controls never draw. */
  function watchAdmin(fn) {
    if (window.OAAccounts && OAAccounts.onChange) {
      OAAccounts.onChange(function () { fn(!!OAAccounts.isAdmin()); });
      return;
    }
    if (!window.OAFB || !OAFB.enabled) return;
    OAFB.ready().then(function (fb) {
      fb.auth().onAuthStateChanged(function (u) {
        fn(!!(u && u.email && u.emailVerified && OAFB.adminEmail &&
          u.email.toLowerCase() === String(OAFB.adminEmail).toLowerCase()));
      });
    })['catch'](function () { /* no SDK — nobody is the maintainer here */ });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, onClick) {
    var b = el('button', null, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function longDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day(iso));
    if (!m) return day(iso);
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  }

  /* Same-origin page links only; anything else renders as plain text.
     changelog.json is the maintainer's own file, but the rule costs nothing
     and an override could one day carry a link too. */
  function safeHref(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^https?:\/\/(www\.)?operationsacademia\.org(\/|$)/i.test(s)) return s;
    if (s.charAt(0) === '/' && s.charAt(1) !== '/') return s;
    return '';
  }

  /**
   * Render the What's-new list into an element and, for the maintainer, its
   * controls. The page supplies where and how much; everything else — the
   * changelog, the decisions, who is signed in, what each of them may see —
   * is this module's business, so the two pages cannot disagree again.
   *
   *   OANews.mount({
   *     list: '#v3-news',   // the <ul> to fill
   *     limit: 5,           // 0 = the whole log
   *     dates: 'short',     // 'short' = the ISO day (front page), else Aug 18, 2026
   *     link: true,         // link an entry's title to the page it announces
   *     more: 'whats-new.html'   // where "…and N more" points, when cut
   *   })
   */
  function mount(cfg) {
    cfg = cfg || {};
    var host = typeof cfg.list === 'string' ? document.querySelector(cfg.list) : cfg.list;
    if (!host) return null;

    var limit = cfg.limit || 0;
    var updates = null;         // the changelog, once it loads
    var docs = {};              // the decisions, once they load
    var docsRead = false;       // …and whether that read actually happened
    var admin = false;
    var editing = null;         // the id whose inline form is open
    var extra = null;           // the maintainer's note + removed-entries panel
    var flash = null;           // { text, err } — reported in place, not in an alert box

    function strings(n) {
      return n === 1 ? 'entry' : 'entries';
    }

    function say(msg) {
      host.innerHTML = '';
      var li = el('li');
      li.appendChild(el('p', 'v3-mut', msg));
      host.appendChild(li);
    }

    /* -------------------------------------------------------------- writing */

    /* A failure is reported ON THE PAGE, beside the list it failed on, the way
       the review queue and the feedback inbox report theirs — an alert() box
       says the same thing and then takes the words away with it. */
    function fail(err) {
      var code = (err && (err.code || err.message)) || 'error';
      flash = {
        err: true,
        text: 'Could not save that (' + code + ').' + (/permission/i.test(code)
          ? ' That is a permission-denied: the updated Firestore rules have not' +
            ' been deployed yet — see _SETUP-FIREBASE.md §4.'
          : '')
      };
      render();
    }

    function save(id, patch, done) {
      if (!window.OAFB || !OAFB.enabled) return;
      flash = null;
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(COLLECTION).doc(id).set(patch, { merge: true });
      }).then(function () {
        docs[id] = docs[id] || {};
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) docs[id][k] = patch[k];
        if (done) done();
        render();
      })['catch'](fail);
    }

    function decide(id, status) {
      save(id, patchFor(status));
    }

    /* Approving a whole day's shipping at once. Several entries land together
       often enough — this repo's own keep-in-sync rule makes one change ship
       two or three — that a gate which can only be cleared one at a time is a
       gate that does not get cleared. One write at a time, failures counted
       rather than thrown, exactly like the job queue's approveAll. */
    function approveAll(rows) {
      if (!rows.length) return;
      if (!window.confirm('Publish ' + rows.length + ' ' + strings(rows.length) +
        ' on the site?')) return;
      if (!window.OAFB || !OAFB.enabled) return;
      flash = { text: 'Publishing 0 of ' + rows.length + '…' };
      render();
      OAFB.ready().then(function (fb) {
        var db = fb.firestore();
        var done = 0, failed = 0;
        return rows.reduce(function (chain, r) {
          return chain.then(function () {
            return db.collection(COLLECTION).doc(r.id)
              .set(patchFor(APPROVED), { merge: true })
              .then(function () {
                done++;
                docs[r.id] = docs[r.id] || {};
                docs[r.id].status = APPROVED;
                docs[r.id].hidden = false;
              })['catch'](function () { failed++; });
          });
        }, Promise.resolve()).then(function () {
          flash = failed
            ? { err: true, text: done + ' published, ' + failed + ' could not be saved — ' +
                'reload and try those again.' }
            : { text: 'All ' + done + ' published.' };
          render();
        });
      })['catch'](fail);
    }

    /* -------------------------------------------------------------- drawing */

    /* An inline form, not two prompt() boxes. A summary here runs to a
       paragraph or two, and a browser prompt shows it as one unscrollable
       line — which is how a maintainer "editing" one ends up retyping it. */
    function editor(row, li) {
      var form = el('div', 'v3-news-edit');
      var t = document.createElement('input');
      t.type = 'text';
      t.value = row.title;
      t.maxLength = TITLE_MAX;
      t.setAttribute('aria-label', 'Title shown on the site');
      var s = document.createElement('textarea');
      s.value = row.summary;
      s.maxLength = SUMMARY_MAX;
      s.rows = 6;
      s.setAttribute('aria-label', 'Summary shown on the site');
      var bar = el('p', 'v3-news-admin');
      bar.appendChild(button('Save', function () {
        save(row.id, patchFor(row.status, { title: t.value.trim(), summary: s.value.trim() }),
          function () { editing = null; });
      }));
      bar.appendChild(button('Cancel', function () { editing = null; render(); }));
      form.appendChild(t);
      form.appendChild(s);
      form.appendChild(bar);
      li.appendChild(form);
    }

    function item(row) {
      var li = el('li');
      if (row.status === PENDING) li.className = 'v3-news-pending';
      if (row.status === REMOVED) li.className = 'v3-news-removed';

      li.appendChild(el('time', null, cfg.dates === 'short' ? row.date : longDay(row.date)));

      var head = el('strong');
      var href = cfg.link ? safeHref(row.url) : '';
      if (href) {
        var a = el('a', null, row.title);
        a.href = href;
        head.appendChild(a);
      } else {
        head.textContent = row.title;
      }
      li.appendChild(head);
      li.appendChild(el('p', null, row.summary));

      if (!admin) return li;

      if (editing === row.id) {
        editor(row, li);
        return li;
      }

      var bar = el('p', 'v3-news-admin');
      if (row.status === PENDING) {
        bar.appendChild(button('✓ Publish', function () { decide(row.id, APPROVED); }));
      }
      if (row.status === REMOVED) {
        bar.appendChild(button('↩ Restore', function () { decide(row.id, APPROVED); }));
      }
      bar.appendChild(button('✎ Edit', function () { editing = row.id; render(); }));
      if (row.status !== REMOVED) {
        bar.appendChild(button('✕ Remove', function () {
          if (!window.confirm('Remove “' + row.title + '” from What’s new?\n\n' +
            'It comes off the list at once. changelog.json keeps the entry, and ' +
            'you can put it back from "Removed updates" under the list.')) return;
          decide(row.id, REMOVED);
        }));
      }
      if (row.status === PENDING) {
        bar.appendChild(el('span', null, 'Waiting for you — nobody else can see this yet.'));
      }
      li.appendChild(bar);
      return li;
    }

    /* The maintainer's own furniture: what is waiting for review ABOVE the
       list, where the flagged entries are, and the collapsed way back to a
       removed entry BELOW it, out of the way. Both are created lazily and only
       for the maintainer, so a visitor's page is exactly the page it was. */
    function panel() {
      if (extra) return extra;
      extra = { top: el('div', 'v3-news-panel'), bin: el('div', 'v3-news-panel') };
      if (host.parentNode) {
        host.parentNode.insertBefore(extra.top, host);
        host.parentNode.insertBefore(extra.bin, host.nextSibling);
      }
      return extra;
    }

    function clearPanel() {
      if (!extra) return;
      extra.top.innerHTML = '';
      extra.bin.innerHTML = '';
    }

    function render() {
      if (!updates) return;
      var split = partition(updates, docs);
      var shown = admin ? split.pending.concat(split.approved).sort(byDateDesc) : split.approved;
      var cut = limit ? shown.slice(0, limit) : shown;

      host.innerHTML = '';
      if (!cut.length) {
        say(admin
          ? 'Nothing in the update log yet.'
          : 'Nothing to announce right now.');
      } else {
        cut.forEach(function (row) { host.appendChild(item(row)); });
      }

      if (!admin) { clearPanel(); return; }

      var box = panel();
      clearPanel();

      if (flash) {
        var msg = el('p', 'oa-form-msg ' + (flash.err ? 'is-err' : 'is-ok'), flash.text);
        msg.setAttribute('role', 'status');
        box.top.appendChild(msg);
      }

      var n = split.pending.length;
      if (n) {
        var note = el('p', 'v3-news-note');
        note.appendChild(el('strong', null, n + ' new ' + strings(n) +
          (n === 1 ? ' is' : ' are') + ' waiting for you.'));
        note.appendChild(document.createTextNode(' Nobody else can see ' +
          (n === 1 ? 'it' : 'them') + ' — or is e-mailed about ' +
          (n === 1 ? 'it' : 'them') + ' — until you publish ' +
          (n === 1 ? 'it' : 'them') + '.'));
        if (n > 1) {
          note.appendChild(button('✓ Publish all ' + n, function () { approveAll(split.pending); }));
        }
        box.top.appendChild(note);
      }

      /* A read that never happened is not "nothing was decided": every entry
         since the gate would read as pending and every removal would come
         back. Say so where the decisions are made, rather than leaving the
         maintainer to wonder why the list looks wrong. */
      if (!docsRead) {
        box.top.appendChild(el('p', 'oa-form-msg is-err',
          'The review decisions could not be read from the database, so this is ' +
          'the list as it stood before the review gate. If that says ' +
          'permission-denied in the console, the updated Firestore rules have ' +
          'not been deployed yet — see _SETUP-FIREBASE.md §4.'));
      }

      if (split.removed.length) {
        var d = document.createElement('details');
        d.className = 'v3-ack v3-news-bin';
        var sum = document.createElement('summary');
        sum.textContent = 'Removed updates (' + split.removed.length + ')';
        d.appendChild(sum);
        var body = el('div', 'v3-ack-body');
        body.appendChild(el('p', 'v3-mut',
          'Off the site — nobody else sees these. Restore puts one back where ' +
          'its date belongs.'));
        var ul = el('ul', LIST_CLASS);
        split.removed.forEach(function (row) { ul.appendChild(item(row)); });
        body.appendChild(ul);
        d.appendChild(body);
        box.bin.appendChild(d);
      }
    }

    /* --------------------------------------------------------------- loading

       The changelog paints FIRST, filtered by the date rule alone, so the log
       is on screen without waiting for Firestore — and a database that cannot
       be reached costs the newest entries rather than the whole page. It can
       never leak: an unreviewed entry is dated on or after the gate, so the
       date rule alone withholds it. */
    fetch('/changelog.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (log) {
        updates = arr(log && log.updates);
        if (!updates.length) throw new Error('empty');
        render();
      })['catch'](function () {
        say('The update log could not be loaded just now. Please reload the page.');
        clearPanel();
      });

    if (window.OAFB && OAFB.enabled) {
      OAFB.ready().then(function (fb) {
        fb.firestore().collection(COLLECTION).get().then(function (snap) {
          snap.forEach(function (doc) { docs[doc.id] = doc.data(); });
          docsRead = true;
          render();
        })['catch'](function () { /* rules not deployed — the date rule stands */ });
      })['catch'](function () { /* SDK unreachable — the log still renders */ });

      /* WHO THE MAINTAINER IS is OAAccounts.isAdmin()'s answer, not a second
         e-mail comparison of our own. It also requires a VERIFIED address,
         which _firestore.rules isAdmin() requires too — without that check the
         controls draw for an unverified session and every button bounces. */
      watchAdmin(function (is) {
        if (is === admin) return;
        admin = is;
        editing = null;
        flash = null;
        render();
      });
    }

    /* The browser checks drive both states without a Firebase project, the
       same way page-test.mjs drives oa-rowedit.js. */
    var ctl = {
      setForTest: function (nextDocs, isAdmin, nextUpdates) {
        if (nextDocs) docs = nextDocs;
        if (nextUpdates) updates = nextUpdates;
        if (typeof isAdmin === 'boolean') admin = isAdmin;
        docsRead = true;
        editing = null;
        render();
      }
    };
    MOUNTED.push(ctl);
    return ctl;
  }

  function setForTest(docs, isAdmin, updates) {
    MOUNTED.forEach(function (c) { c.setForTest(docs, isAdmin, updates); });
    return MOUNTED.length;
  }

  return {
    COLLECTION: COLLECTION,
    APPROVED: APPROVED,
    PENDING: PENDING,
    REMOVED: REMOVED,
    DOC_KEYS: DOC_KEYS,
    REVIEW_FROM: REVIEW_FROM,
    TITLE_MAX: TITLE_MAX,
    SUMMARY_MAX: SUMMARY_MAX,
    decision: decision,
    statusOf: statusOf,
    applied: applied,
    partition: partition,
    publicUpdates: publicUpdates,
    patchFor: patchFor,
    safeHref: safeHref,
    mount: mount,
    __setForTest: setForTest
  };
}));
