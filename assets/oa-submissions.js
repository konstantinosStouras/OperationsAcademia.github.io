/* ---------------------------------------------------------------------------
   Operations Academia — what has been posted through the site and not yet
   looked at.

   THE PANEL THIS DRAWS sits on the Admin area (admin-area.html) beside the tracking sheet's
   review queue, and it is deliberately NOT the same thing. That queue is a
   GATE: nothing on it is on the site until the maintainer approves it. This is
   a TO-DO LIST: a profile made through the site's own form is filed within a
   minute, because the form promises as much, and this only says it arrived.

   CANDIDATE PROFILES ONLY, since 2026-08-23. Job postings made through the
   form used to be listed here too; they are drawn by the review panel's own
   "User-added jobs" tab now (assets/oa-jobreview.js — one queue, one surface,
   the same reasoning that pinned feedback.html clean when the queues moved).
   The submissions MODEL keeps both kinds — the mailer still announces a job
   posting the moment it arrives — and the two panels share the LIVE statuses
   and the reviewedAt stamp, so a card ticked on either surface is ticked for
   the mailer too.

   IT EXISTS BECAUSE THERE WAS NOWHERE TO LOOK. A job posting turns up on the
   jobs page and can be corrected from its own card. A CANDIDATE PROFILE
   cannot: profiles are held behind the reveal date
   (data/candidates-reveal.json), so they reach no served file, draw no card
   anywhere, and the only way to open one was to guess its document id. Two
   were sitting there.

   AUTHORISATION IS THE RULES, never this file. Both collections are
   `allow read: if isOwner(...) || isAdmin()` and `allow write: if isAdmin()`
   in _firestore.rules already — so this needed no rules change, and a browser
   that draws the panel for the wrong visitor still cannot read a document.

   MARKING SOMETHING REVIEWED writes one field, `reviewedAt`, onto the
   submission itself. Not a new collection: the submission IS the record, and
   `_scraper/submissions-mailer.mjs` stamps `announcedAt` beside it for the
   same reason. Ticking a card off changes nothing else — the posting was
   already live.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* Keep in step with KINDS in _scraper/submissions-review.mjs; selftest.mjs
     pins the collection names, the stamps and the edit paths across the two.
     The `job` kind is deliberately NOT here — the review panel's User-added
     tab (assets/oa-jobreview.js) draws those, and a second surface for the
     same queue is the drift this repository's modules exist to prevent. */
  var KINDS = [
    {
      key: 'candidate',
      collection: 'candidateSubmissions',
      one: 'candidate profile',
      many: 'candidate profiles',
      editPath: 'post-a-candidate.html?edit=',
      title: function (d) {
        return [[d.first, d.last].filter(Boolean).join(' '), d.affiliation]
          .filter(Boolean).join(' — ') || 'a profile';
      },
      lines: function (d) {
        return [
          ['Position', d.position],
          ['Research areas', (d.researchAreas || []).join(', ')],
          ['Note to you', d.note],
        ];
      },
      link: function (d) { return d.cvUrl || d.webUrl || ''; },
      linkLabel: 'the CV',
    },
  ];

  /* The stamp the mailer and the model both name. */
  var REVIEWED_AT = 'reviewedAt';

  /* The statuses a submission is LIVE in — the pair every build reads. A
     withdrawn, hidden or removed one is not waiting for anything, and `sheet`
     is a tracking-sheet mirror, which has its own queue above this panel. */
  var LIVE = ['queued', 'published'];

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Shown as a link only when it IS one. A submission is somebody else's text
     until it has been read, and this panel is where it is first rendered. */
  function safeHref(u) {
    var s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function day(v) {
    var d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
    if (!d || isNaN(+d)) return '';
    return d.toISOString().slice(0, 10);
  }

  /** The profile's own view figures, where build-candidate-stats.mjs has
      written them (the `stats` map on the document): the candidate sees the
      same numbers on their edit page. Numbers only, and only when present. */
  function statsLine(d) {
    var st = d && d.stats && typeof d.stats === 'object' ? d.stats : null;
    if (!st) return '';
    var n = function (v) { var x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0; };
    // written out, as the candidate's own panel and account.html write it
    var times = function (k) { return k + (k === 1 ? ' time' : ' times'); };
    var upd = String(st.updatedAt || '').slice(0, 10);
    return '<p class="oa-hint">Opened ' + times(n(st.opens)) + ' and its CV clicked ' +
      times(n(st.cvClicks)) + ' this season' +
      (/^\d{4}-\d{2}-\d{2}$/.test(upd) ? ' (updated ' + esc(upd) + ')' : '') + '.</p>';
  }

  function cardHtml(kind, id, d, revealAt) {
    var href = safeHref(kind.link(d));
    /* Held only while the reveal date is still AHEAD — the same test
       oa-adminarea's candGroupOf makes, so the two panels on one page cannot
       disagree about a profile from the reveal day on. */
    var held = kind.key === 'candidate' && !!revealAt &&
      new Date().toISOString().slice(0, 10) < revealAt;

    return '<header>' +
        '<strong>' + esc(kind.title(d)) + '</strong>' +
        '<span class="oa-fb-status is-open">' + esc(kind.one) + '</span>' +
        '<p class="oa-hint">Posted ' + esc(day(d.createdAt) || '?') +
          (d.ref ? ' &middot; ' + esc(d.ref) : '') +
          (href ? ' &middot; <a href="' + esc(href) + '" target="_blank" rel="noopener">open ' +
            esc(kind.linkLabel) + '</a>' : '') +
        '</p>' +
      '</header>' +
      '<table class="oa-sub-lines">' +
        kind.lines(d).filter(function (l) { return l[1]; }).map(function (l) {
          return '<tr><th>' + esc(l[0]) + '</th><td>' + esc(l[1]) + '</td></tr>';
        }).join('') +
      '</table>' +
      (held
        /* Saying so on the card matters: a profile that is nowhere on the site
           looks like one that failed to save, and the reveal gate is the only
           reason it is not there. */
        ? '<p class="oa-hint">Held until <strong>' + esc(revealAt) + '</strong> — profiles ' +
          'appear all at once on the day, so this one is not on the site yet.</p>'
        : '') +
      statsLine(d) +
      '<p class="oa-rv-actions">' +
        '<a class="button blue" href="' + esc(kind.editPath + encodeURIComponent(id)) +
          '">Open &amp; correct</a> ' +
        '<button type="button" class="button" data-act="reviewed">Mark reviewed</button>' +
        '<span class="oa-form-msg" data-msg role="status"></span>' +
      '</p>';
  }

  function render(db, items, revealAt) {
    var list = $('oa-subs-list');
    var count = $('oa-subs-count');
    if (count) {
      count.textContent = items.length
        ? String(items.length) + (items.length === 1 ? ' profile' : ' profiles')
        : 'nothing';
    }

    if (!items.length) {
      list.innerHTML = '<p class="oa-hint">Nothing waiting. Candidate profiles filed ' +
        'through the site appear here when they arrive, so you can read one even ' +
        'while it is held until the reveal date.</p>';
      return;
    }

    list.innerHTML = '';
    items.forEach(function (it) {
      var card = document.createElement('article');
      card.className = 'oa-fb-card oa-rv-card';
      card.innerHTML = cardHtml(it.kind, it.id, it.data, revealAt);

      card.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!b) return;
        var msg = card.querySelector('[data-msg]');
        b.disabled = true;
        msg.className = 'oa-form-msg';
        msg.textContent = 'Saving…';

        var patch = {};
        patch[REVIEWED_AT] = new Date().toISOString();
        db.collection(it.kind.collection).doc(it.id).set(patch, { merge: true })
          .then(function () {
            card.innerHTML = '<p class="oa-form-msg is-ok">Marked reviewed &mdash; ' +
              esc(it.kind.title(it.data)) + '</p>';
          })
          .catch(function (err) {
            msg.className = 'oa-form-msg is-err';
            msg.textContent = 'Could not save (' + esc(err.code || err.message) + ').';
            b.disabled = false;
          });
      });

      list.appendChild(card);
    });
  }

  function load(db) {
    var list = $('oa-subs-list');
    list.innerHTML = '<p class="oa-hint">Loading…</p>';

    /* The reveal date is what decides whether a profile is on the site at all,
       and the panel says so on the card. Its absence is not a failure — it
       just means nothing to add. */
    var reveal = fetch('data/candidates-reveal.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });

    Promise.all([reveal].concat(KINDS.map(function (kind) {
      return db.collection(kind.collection).where('status', 'in', LIVE).get()
        .then(function (snap) {
          return snap.docs.map(function (d) {
            return { kind: kind, id: d.id, data: d.data() };
          }).filter(function (it) { return !it.data[REVIEWED_AT]; });
        });
    }))).then(function (all) {
      var revealAt = (all[0] || {}).revealAt || '';
      var items = [].concat.apply([], all.slice(1));
      /* Newest first: the panel is read as "what has come in", and the thing
         that arrived this morning is the one worth reading today. (The MAILER
         works oldest-first, deliberately — a backlog is announced in the order
         it arrived.) */
      items.sort(function (a, b) {
        return String(day(b.data.createdAt) || '')
          .localeCompare(String(day(a.data.createdAt) || ''));
      });
      show($('oa-subs'), true);
      render(db, items, revealAt);
    }).catch(function (err) {
      list.innerHTML = '<p class="oa-form-msg is-err">Could not load what has been ' +
        'posted (' + esc(err.code || err.message) + ').</p>';
    });
  }

  function boot() {
    if (!window.OAAccounts || !window.OAFB || !$('oa-subs')) return;
    OAAccounts.onChange(function () {
      if (!OAAccounts.isAdmin()) { show($('oa-subs'), false); return; }
      show($('oa-subs'), true);
      OAFB.ready().then(function (fb) { load(fb.firestore()); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
