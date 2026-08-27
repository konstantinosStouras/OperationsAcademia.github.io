/* ---------------------------------------------------------------------------
   Operations Academia — the Admin area (admin-area.html): everything waiting
   for the maintainer's review, in one place, and the ONE place the number
   beside "Admin area" in the account menu is computed.

   FOUR QUEUES, one page (owner, 2026-08-21: "include there any items to be
   reviewed: job postings, candidate profiles, feedback received"):

     1. job postings to review (Firestore, drawn by assets/oa-jobreview.js in
        two tabs): the ones crawled from the tracking sheet and held for
        approval (`jobReviews`), and the user-added ones made through the
        site's own form (`jobSubmissions`), live but not yet marked reviewed;
     2. CANDIDATE PROFILES — the gap this page was made to close: the front
        page said "2 profiles have already been filed" while the maintainer
        had no way to SEE them, because profiles are held out of
        data/candidates.json until the reveal date and the candidates page
        therefore had nothing to draw its Edit buttons on. This module lists
        them straight from `candidateSubmissions`, which _firestore.rules
        already lets the admin read, held and published alike;
     3. the feedback inbox (Firestore `feedback`, drawn by assets/oa-feedback.js);
     4. "What's new" entries awaiting publication — counted and listed THROUGH
        window.OANews (partition), the one module every consumer of the
        newsOverrides decisions reads, so this page cannot disagree with the
        what's-new page or the mailer about what is pending.

   AND ONE STATISTIC (owner, 2026-08-23): a Registered-users card — how many
   accounts hold a `registeredUsers/{uid}` mark, the contentless tally every
   sign-in writes (oa-accounts.js). It is /lit/'s registered-users tile with
   the visibility inverted: there the figure is public, here it is the
   maintainer's alone — the collection is admin-read in _firestore.rules, and
   this page is the one place it is shown. The count is of PEOPLE, not
   sign-ins: merging two accounts deletes the duplicate's mark (runMerge in
   oa-accounts.js, while the merge can still write as that user), so the
   figure comes down on its own the next time this page reads it. A mark
   orphaned some OTHER way (an account deleted in the Firebase console) stays
   until something like /lit/'s registered-users audit exists here.

   THE BADGE AND THE PAGE COUNT WITH THE SAME FUNCTION. pendingCounts() below
   is called by this page for its summary tiles AND by oa-accounts.js for the
   "Admin area N" badge (which loads this file on demand, in the maintainer's
   browser only), so the menu can never promise a different number than the
   page shows. The page then corrects the cached badge from the real candidate
   documents via OAAccounts.setCount('admin', …), the same
   exact-where-the-data-is-already-loaded rule my-postings and alerts follow.

   AUTHORISATION IS THE RULES, never this file. Everything here only decides
   what is DRAWN: jobReviews, feedback and candidateSubmissions are admin-read
   in _firestore.rules, so a browser that unhides the panels for the wrong
   visitor still cannot load a single document.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* oa-accounts.js loads this file on demand for the badge; a page that also
     carries it in a <script> tag would otherwise run the IIFE twice and wire
     every listener twice. Whichever copy runs first wins; the other returns. */
  if (window.OAAdminArea) return;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* http(s) only, exactly as oa-jobreview.js renders a queued row's links: a
     submission is typed by a stranger and this panel is the one place it is
     rendered before anyone has vetted it. */
  function safeHref(u) {
    var s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function todayIso() { return new Date().toISOString().slice(0, 10); }

  /* One request per file per page — the site's own rule (OAList.load does the
     same): the counts AND the panels read candidates-meta.json and
     changelog.json, and without this each was fetched twice per open. A
     failed read is NOT remembered, so one flaky request is not inherited.
     cache: 'no-cache' REVALIDATES rather than re-downloads — Pages serves
     data/ with ten minutes of freshness, and a review count read from a stale
     cache says the queue is a size it no longer is. */
  var jsonMemo = {};
  function fetchJson(url) {
    if (jsonMemo[url]) return jsonMemo[url];
    jsonMemo[url] = fetch(url, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      ['catch'](function (err) { delete jsonMemo[url]; throw err; });
    return jsonMemo[url];
  }

  /** count() aggregate with a fetch fallback — the same shape oa-accounts.js
      uses for the postings and alerts badges: one read whatever the
      collection holds. */
  function countOf(ref) {
    if (typeof ref.count === 'function') {
      return ref.count().get().then(function (snap) {
        var d = snap && typeof snap.data === 'function' ? snap.data() : null;
        return d && typeof d.count === 'number' ? d.count : null;
      });
    }
    return ref.get().then(function (snap) { return snap ? snap.size : null; });
  }

  /* --------------------------------------------------- the four queue sizes */

  /** Profiles filed and still waiting for the reveal. Read from the SAME file
      the front page announces "N profiles have already been filed" from
      (data/candidates-meta.json), so the badge and that banner agree; the
      build writes heldCount 0 once revealed, and the date guard covers the
      window between the reveal day and the next build. */
  function heldCandidates() {
    return fetchJson('/data/candidates-meta.json').then(function (meta) {
      var at = String(meta.revealAt || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(at) && todayIso() >= at) return 0;
      return Number(meta.heldCount) || 0;
    });
  }

  /** Changelog entries still pending, decided THROUGH OANews — never a second
      reading of the review gate. Null when the module is not on the page,
      which the callers treat as "unknown", never as zero. */
  var newsMemo = null;
  function pendingNews(db) {
    if (!window.OANews) return Promise.resolve(null);
    if (newsMemo) return newsMemo;   // the tiles and the panel share one read
    newsMemo = Promise.all([
      fetchJson('/changelog.json'),
      db.collection(OANews.COLLECTION).get()
    ]).then(function (r) {
      var docs = {};
      r[1].forEach(function (d) { docs[d.id] = d.data(); });
      return OANews.partition((r[0] && r[0].updates) || [], docs).pending;
    })['catch'](function (err) { newsMemo = null; throw err; });
    return newsMemo;
  }

  /** Job postings waiting in the review panel: the crawled queue's pending
      documents PLUS the user-added postings not yet marked reviewed — the
      panel's own two tabs, so the tile and the badge count what it shows. An
      aggregate cannot ask "reviewedAt absent", so the submissions are read
      and filtered, exactly as the panel reads them (two equality queries, one
      per live status): the collection is small and this runs once per
      session. Each half that cannot be read is unknown; the leg is null only
      when NEITHER half answered, the same partial-answer rule as below. */
  function waitingJobs(db) {
    var nul = function () { return null; };
    return Promise.all([
      countOf(db.collection('jobReviews').where('status', '==', 'pending'))['catch'](nul),
      Promise.all(['queued', 'published'].map(function (s) {
        return db.collection(OAFB.col.jobSubmissions).where('status', '==', s).get();
      })).then(function (snaps) {
        var n = 0;
        snaps.forEach(function (snap) {
          snap.forEach(function (d) {
            if (!(d.data() || {}).reviewedAt) n++;
          });
        });
        return n;
      })['catch'](nul)
    ]).then(function (r) {
      if (typeof r[0] !== 'number' && typeof r[1] !== 'number') return null;
      return (r[0] || 0) + (r[1] || 0);
    });
  }

  /**
   * Everything waiting for the maintainer, counted once for every consumer:
   * {jobs, candidates, feedback, news, total}. A leg that cannot be read
   * resolves null — unknown, not zero — and the total sums what IS known, so
   * one refused read never hides the rest of the queue.
   */
  function pendingCounts() {
    return OAFB.ready().then(function (fb) {
      var db = fb.firestore();
      var nul = function () { return null; };
      return Promise.all([
        waitingJobs(db)['catch'](nul),
        heldCandidates()['catch'](nul),
        countOf(db.collection(OAFB.col.feedback).where('status', '==', 'open'))['catch'](nul),
        pendingNews(db).then(function (p) {
          return p === null ? null : p.length;
        })['catch'](nul),
        countOf(db.collection('nameFixes').where('status', '==', 'pending'))['catch'](nul),
        /* People who have replied and are waiting for an answer. This IS a
           queue — something the maintainer can clear — unlike the roster
           beside it, which is a statistic. One equality filter on a top-level
           collection, so it needs no composite index. */
        countOf(db.collection(OAFB.col.messages).where('needsAdmin', '==', true))['catch'](nul)
      ]);
    }).then(function (r) {
      var total = 0, known = 0;
      for (var i = 0; i < r.length; i++) {
        if (typeof r[i] === 'number') { total += r[i]; known++; }
      }
      /* NOTHING answered — rules not deployed, offline — is UNKNOWN, never a
         zero: a 0 here would overwrite a cached badge that was honest with
         one that is not (the same rule the menu counts follow). A PARTIAL
         answer still sums what is known — each queue is independent, and
         withholding three known numbers over one refused read helps nobody. */
      return { jobs: r[0], candidates: r[1], feedback: r[2], news: r[3], names: r[4],
               messages: r[5], total: known ? total : null };
    });
  }

  /**
   * How many accounts are registered — the `registeredUsers` tally every
   * sign-in writes, counted with one aggregate read. DELIBERATELY NOT part of
   * pendingCounts(): that function is "everything WAITING for the maintainer"
   * and feeds the "Admin area N" badge on every page — a statistic in its sum
   * would inflate the badge with items nobody can clear, and a statistic in
   * its Promise.all would make every page's badge refresh pay a read for a
   * number only this page shows. Merge-aware for free: the count is of marks,
   * and a merge deletes the duplicate account's mark.
   */
  function registeredCount() {
    return OAFB.ready().then(function (fb) {
      return countOf(fb.firestore().collection(OAFB.col.registered));
    });
  }

  /* ------------------------------------------------------- the summary strip */

  var TILES = [
    { key: 'jobs', label: 'Job postings to review', to: '#oa-review' },
    { key: 'candidates', label: 'Candidate profiles held', to: '#oa-aa-cands' },
    { key: 'feedback', label: 'Open feedback tickets', to: '#oa-inbox' },
    { key: 'news', label: 'Updates awaiting publication', to: '#oa-aa-news' },
    { key: 'names', label: 'Name corrections suggested', to: '#oa-aa-names' },
    { key: 'messages', label: 'Message replies waiting', to: '#oa-aa-users' }
  ];

  /* The registered-user count, kept beside lastCounts rather than in it so no
     badge arithmetic can ever sum it. null = not answered (a refused read
     draws the same '?' the queue tiles draw), a number is the count. */
  var lastUsers = null;

  /* The same treatment for the market-year report: kept OUT of lastCounts so
     no badge arithmetic can sum it, painted from this page's own read. */
  var lastYearCheck = null;

  function paintTiles(c) {
    var host = $('oa-aa-tiles');
    if (!host) return;
    host.innerHTML = TILES.map(function (t) {
      var n = c[t.key];
      var known = typeof n === 'number';
      return '<a class="oa-aa-tile' + (known && n > 0 ? ' is-due' : '') + '" href="' + t.to + '">' +
        '<span class="oa-aa-tile-n">' + (known ? n : '?') + '</span>' +
        '<span class="oa-aa-tile-l">' + esc(t.label) + '</span></a>';
    }).join('') +
      /* The last card is a STATISTIC, not a queue: never "due", and out of
         every total, so no badge arithmetic can sum a figure nobody can
         clear. It WAS a span, deliberately, because it opened nothing — since
         2026-08-24 it opens the roster, so it is a link like the others and
         keeps only the class that holds it out of the sums. */
      /* The market-year report sits between the queues and the statistic: it
         IS something the maintainer clears — by settling each posting — but
         it is read from a served file rather than from Firestore, so it is
         not in `c` and never reaches the badge. */
      '<a class="oa-aa-tile' + (lastYearCheck > 0 ? ' is-due' : '') + '" href="#oa-aa-yc">' +
        '<span class="oa-aa-tile-n">' +
        (typeof lastYearCheck === 'number' ? lastYearCheck : '?') + '</span>' +
        '<span class="oa-aa-tile-l">Market year to check</span></a>' +
      '<a class="oa-aa-tile oa-aa-tile-stat" href="#oa-aa-users">' +
        '<span class="oa-aa-tile-n">' + (typeof lastUsers === 'number' ? lastUsers : '?') + '</span>' +
        '<span class="oa-aa-tile-l">Registered users</span></a>';
  }

  /* -------------------------------------------------------- candidate cards */

  var CAND_STATUS = {
    held: 'Held until the reveal — visible to nobody but you and the candidate',
    live: 'Published on the candidates page',
    withdrawn: 'Withdrawn by the candidate',
    hidden: 'Taken down by you'
  };

  /** Which pile a stored profile belongs to. Pure, so the selftest can hold
      it to the build's own reveal semantics: until the reveal date EVERY
      queued profile is held (build-candidates.mjs publishes a constant []),
      and from the day itself queued means live. */
  function candGroupOf(doc, revealAt, today) {
    var s = String((doc && doc.status) || 'queued');
    if (s === 'withdrawn') return 'withdrawn';
    if (s === 'hidden') return 'hidden';
    /* the build's own gate (revealGate in candidates-model.mjs): NO announced
       date means everything is HELD — the build publishes nothing until the
       admin sets one — and from the day itself queued means live */
    var at = /^\d{4}-\d{2}-\d{2}$/.test(String(revealAt || '')) ? revealAt : '';
    var held = !at || today < at;
    return held ? 'held' : 'live';
  }

  function fmtDate(ts) {
    try {
      var d = ts && typeof ts.toDate === 'function' ? ts.toDate() : (ts ? new Date(ts) : null);
      return d && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
    } catch (e) { return ''; }
  }

  function candLink(url, label) {
    var u = safeHref(url);
    return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + label + '</a>' : '';
  }

  function candCard(id, v, group) {
    var name = ((v.first || '') + ' ' + (v.last || '')).replace(/\s+/g, ' ').trim() || '(no name)';
    var links = [
      candLink(v.cvUrl, 'CV'),
      candLink(v.rsUrl, 'Research summary'),
      candLink(v.webUrl, 'Website')
    ].filter(Boolean).join(' &middot; ');
    var uploads = [
      v.cvUploadName ? 'CV upload: ' + esc(v.cvUploadName) : '',
      v.rsUploadName ? 'Research summary upload: ' + esc(v.rsUploadName) : ''
    ].filter(Boolean).join(' &middot; ');
    var meta = [
      v.affiliation ? esc(v.affiliation) : '',
      v.position ? esc(v.position) : '',
      v.year ? esc(v.year) + ' market' : ''
    ].filter(Boolean).join(' &middot; ');
    var areas = []
      .concat(Array.isArray(v.researchAreas) ? v.researchAreas : [])
      .map(function (a) { return esc(a); }).join(', ');
    var days = []
      .concat(Array.isArray(v.informsDays) ? v.informsDays : [])
      .map(function (a) { return esc(a); }).join(', ');

    return '<article class="oa-fb-card oa-aa-cand" data-id="' + esc(id) + '">' +
      '<header><strong>' + esc(name) + '</strong>' +
        '<span class="oa-fb-status is-' + (group === 'held' ? 'open' : 'closed') + '">' +
          esc(group) + '</span> ' +
        '<span class="oa-hint" style="display:inline">' +
          (fmtDate(v.createdAt) ? 'filed ' + esc(fmtDate(v.createdAt)) : '') + '</span>' +
      '</header>' +
      (meta ? '<p class="oa-aa-cand-meta">' + meta + '</p>' : '') +
      (areas ? '<p class="oa-hint">Research: ' + areas + '</p>' : '') +
      (days ? '<p class="oa-hint">INFORMS day(s): ' + days + '</p>' : '') +
      (links ? '<p>' + links + '</p>' : '') +
      (uploads ? '<p class="oa-hint">' + uploads + ' &mdash; filed into Drive by the next build</p>' : '') +
      /* the addresses are admin-only reading; the flag says whether the BUILD
         may publish the first (emailPublic, the disclosure the rebuild
         retired), and the personal one is NEVER published — it exists so the
         candidate is still reachable once their school address dies with the
         affiliation (owner, 2026-08-24) */
      (v.email ? '<p class="oa-hint">' + esc(v.email) +
        (v.emailPublic ? ' (published on the profile)' : ' (kept private)') + '</p>' : '') +
      (v.personalEmail ? '<p class="oa-hint">' + esc(v.personalEmail) +
        ' (personal — never published)</p>' : '') +
      (v.note ? '<p class="oa-fb-body">' + esc(v.note) + '</p>' : '') +
      '<p class="oa-hint">' + esc(CAND_STATUS[group] || '') + '</p>' +
      '<p class="oa-aa-cand-actions">' +
        '<button type="button" class="button blue" data-act="edit">Edit</button> ' +
        (group === 'withdrawn'
          /* the candidate withdrew it themselves; putting it back is theirs
             to do, so the only offer is to read it */
          ? ''
          : (group === 'hidden'
            ? '<button type="button" class="button oa-btn-ghost" data-act="restore">Put it back</button>'
            : '<button type="button" class="button oa-btn-ghost" data-act="takedown">Take down</button>')) +
        '<span class="oa-form-msg" role="status"></span>' +
      '</p>' +
    '</article>';
  }

  var CAND_GROUPS = [
    ['held', 'Held for the reveal'],
    ['live', 'Published'],
    ['withdrawn', 'Withdrawn by their candidate'],
    ['hidden', 'Taken down by you']
  ];

  function renderCandidates(db, revealAt) {
    var list = $('oa-aa-cands-list');
    if (!list) return Promise.resolve(null);
    list.innerHTML = '<p class="oa-hint">Loading&hellip;</p>';

    return db.collection(OAFB.col.candidateSubmissions).get().then(function (snap) {
      var groups = { held: [], live: [], withdrawn: [], hidden: [] };
      var today = todayIso();
      snap.forEach(function (d) {
        var v = d.data() || {};
        groups[candGroupOf(v, revealAt, today)].push({ id: d.id, v: v });
      });
      /* newest filed first within each pile — the queue is read as a to-do
         list, like the job review queue's newest-advertisement-first */
      var byNewest = function (a, b) {
        return String(fmtDate(b.v.createdAt)).localeCompare(String(fmtDate(a.v.createdAt)));
      };

      var out = '';
      CAND_GROUPS.forEach(function (g) {
        var rows = groups[g[0]];
        if (!rows.length) return;
        rows.sort(byNewest);
        out += '<h4 class="oa-aa-group-h">' + g[1] + ' (' + rows.length + ')</h4>' +
          rows.map(function (r) { return candCard(r.id, r.v, g[0]); }).join('');
      });
      list.innerHTML = out ||
        '<p class="oa-hint">No candidate profiles have been filed yet.</p>';
      return groups;
    })['catch'](function (err) {
      list.innerHTML = '<p class="oa-form-msg is-err">Could not load the profiles (' +
        esc((err && (err.code || err.message)) || 'error') + '). If this says ' +
        'permission-denied, the rules have not been deployed yet &mdash; see ' +
        '_SETUP-FIREBASE.md &sect;4.</p>';
      return null;
    });
  }

  function wireCandidateActions(db, revealAt) {
    var list = $('oa-aa-cands-list');
    if (!list || list.dataset.oaWired) return;
    list.dataset.oaWired = '1';
    list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var card = btn.closest('.oa-aa-cand');
      var id = card && card.getAttribute('data-id');
      if (!id) return;

      if (btn.getAttribute('data-act') === 'edit') {
        /* the SAME form the candidate used — oa-candidateform.js's ?edit=
           mode loads the document and saves it back, and the rules let the
           admin do both on any profile */
        location.href = 'post-a-candidate.html?edit=' + encodeURIComponent(id);
        return;
      }

      var down = btn.getAttribute('data-act') === 'takedown';
      var msg = card.querySelector('.oa-form-msg');
      if (down && !window.confirm('Take this profile down?\n\nIt stops being ' +
        'published (or eligible for the reveal) until it is put back. Nothing ' +
        'is deleted.')) return;

      btn.disabled = true;
      /* 'hidden' is the maintainer's takedown, 'queued' the publishable state
         — the same two words oa-candidateedit.js and the build read */
      db.collection(OAFB.col.candidateSubmissions).doc(id).update({
        status: down ? 'hidden' : 'queued',
        updatedAt: new Date().toISOString()
      }).then(function () {
        renderCandidates(db, revealAt).then(correctBadge);
      })['catch'](function (err) {
        btn.disabled = false;
        if (msg) {
          msg.className = 'oa-form-msg is-err';
          msg.textContent = 'Could not save that (' +
            ((err && err.code) || 'error') + ').';
        }
      });
    });
  }

  /* ----------------------------------------------------------- news pending */

  function renderNews(db) {
    var list = $('oa-aa-news-list');
    if (!list) return;
    pendingNews(db).then(function (p) {
      if (p === null) { show($('oa-aa-news'), false); return; }
      if (!p.length) {
        list.innerHTML = '<p class="oa-hint">Nothing waiting &mdash; every logged ' +
          'update has been reviewed.</p>';
        return;
      }
      list.innerHTML = '<ul class="oa-aa-news-ul">' + p.map(function (e) {
        return '<li><strong>' + esc(e.title || e.id) + '</strong>' +
          (e.date ? ' <span class="oa-hint" style="display:inline">' + esc(e.date) + '</span>' : '') +
          '</li>';
      }).join('') + '</ul>';
    })['catch'](function () {
      list.innerHTML = '<p class="oa-hint">Could not read the update log.</p>';
    });
  }

  /* ------------------------------------------------- name-fix suggestions

     Posters' corrections to published university / school / department names
     (assets/oa-namefix.js -> Firestore `nameFixes`). NOTHING RENAMES ITSELF:
     a suggestion waits here until it is approved, and the data build then
     writes the approved set into data/name-fixes.json and renames every
     posting and vocabulary entry carrying the old spelling — so Approve is a
     rename across the whole live dataset, within about an hour.

     Deciding is never a one-way door (the newsOverrides rule): a decided
     suggestion stays on the list under its own heading with the way back —
     re-open, or flip the decision — because a queue whose entries vanish can
     only be repaired from the Firestore console. */

  var FIX_KIND = { institution: 'University', school: 'School', unit: 'Department' };

  /** What a suggestion will actually publish as — the same canon + overlay
      discipline the build applies, so the card promises what will happen,
      not what was typed. */
  function fixPublishesAs(v) {
    var S = window.OASchools;
    if (!S || !S.normalizeFixes) return String(v.to || '');
    var n = S.normalizeFixes([v]);
    return n.length ? n[0].to : '';
  }

  function fixCard(id, v) {
    var status = String(v.status || 'pending');
    var as = fixPublishesAs(v);
    var acts = status === 'pending'
      ? '<button type="button" class="button blue" data-act="approve">Approve &amp; rename</button> ' +
        '<button type="button" class="button oa-btn-ghost" data-act="reject">Reject</button>'
      : '<button type="button" class="button oa-btn-ghost" data-act="reopen">Re-open</button>';
    return '<article class="oa-fb-card oa-aa-fix" data-id="' + esc(id) + '">' +
      '<header><strong>' + esc(FIX_KIND[v.kind] || v.kind || '?') + ' name</strong> ' +
        '<span class="oa-fb-status is-' + (status === 'pending' ? 'open' : 'closed') + '">' +
          esc(status) + '</span> ' +
        (v.institution && v.kind !== 'institution'
          ? '<span class="oa-hint" style="display:inline">at ' + esc(v.institution) + '</span>'
          : '') +
      '</header>' +
      '<p class="oa-aa-fix-names">&ldquo;' + esc(v.from || '') + '&rdquo; &rarr; ' +
        '&ldquo;' + esc(v.to || '') + '&rdquo;' +
        (as && as !== String(v.to || '')
          ? ' <span class="oa-hint" style="display:inline">(publishes as &ldquo;' +
            esc(as) + '&rdquo; &mdash; the site&rsquo;s house style)</span>'
          : '') +
        (as ? '' : ' <span class="oa-hint" style="display:inline">(as it stands this ' +
          'cannot be applied &mdash; correct it below before approving)</span>') +
      '</p>' +
      (v.note ? '<p class="oa-fb-body">' + esc(v.note) + '</p>' : '') +
      (v.authEmail ? '<p class="oa-hint">suggested by ' + esc(v.authEmail) + '</p>' : '') +
      (status === 'pending'
        ? '<p class="oa-field" style="margin:8px 0"><label>Correct it first, if the ' +
          'suggestion itself needs correcting</label>' +
          '<input type="text" data-role="to" maxlength="200" value="' + esc(v.to || '') + '"></p>'
        : '') +
      '<p class="oa-aa-cand-actions">' + acts +
        '<span class="oa-form-msg" role="status"></span></p>' +
    '</article>';
  }

  /** Draws the queue; resolves the number still pending, for the badge. */
  function renderNameFixes(db) {
    var list = $('oa-aa-names-list');
    if (!list) return Promise.resolve(null);
    list.innerHTML = '<p class="oa-hint">Loading&hellip;</p>';

    return db.collection('nameFixes').get().then(function (snap) {
      var groups = { pending: [], approved: [], rejected: [] };
      snap.forEach(function (d) {
        var v = d.data() || {};
        var g = groups[String(v.status || 'pending')] || groups.pending;
        g.push({ id: d.id, v: v });
      });
      var byNewest = function (a, b) {
        return String(fmtDate(b.v.createdAt)).localeCompare(String(fmtDate(a.v.createdAt)));
      };
      var out = '';
      [['pending', 'Waiting for your decision'],
       ['approved', 'Approved — applied by the data build'],
       ['rejected', 'Rejected']].forEach(function (g) {
        var rows = groups[g[0]];
        if (!rows.length) return;
        rows.sort(byNewest);
        out += '<h4 class="oa-aa-group-h">' + g[1] + ' (' + rows.length + ')</h4>' +
          rows.map(function (r) { return fixCard(r.id, r.v); }).join('');
      });
      list.innerHTML = out ||
        '<p class="oa-hint">Nobody has suggested a name correction yet.</p>';
      return groups.pending.length;
    })['catch'](function (err) {
      list.innerHTML = '<p class="oa-form-msg is-err">Could not load the suggestions (' +
        esc((err && (err.code || err.message)) || 'error') + '). If this says ' +
        'permission-denied, the rules have not been deployed yet &mdash; see ' +
        '_SETUP-FIREBASE.md &sect;4.</p>';
      return null;
    });
  }

  function wireNameFixActions(db) {
    var list = $('oa-aa-names-list');
    if (!list || list.dataset.oaWired) return;
    list.dataset.oaWired = '1';
    list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var card = btn.closest('.oa-aa-fix');
      var id = card && card.getAttribute('data-id');
      if (!id) return;

      var act = btn.getAttribute('data-act');
      var msg = card.querySelector('.oa-form-msg');
      var edited = card.querySelector('input[data-role="to"]');
      var patch = {
        status: act === 'approve' ? 'approved' : (act === 'reject' ? 'rejected' : 'pending'),
        reviewedAt: new Date().toISOString()
      };
      // the maintainer's own correction to the correction rides the decision
      if (edited && String(edited.value || '').trim()) {
        patch.to = String(edited.value).trim().slice(0, 200);
      }

      btn.disabled = true;
      db.collection('nameFixes').doc(id).update(patch).then(function () {
        return renderNameFixes(db);
      }).then(function (pending) {
        if (typeof pending === 'number' && lastCounts) {
          lastCounts.names = pending;
          correctBadge(null);
        }
      })['catch'](function (err) {
        btn.disabled = false;
        if (msg) {
          msg.className = 'oa-form-msg is-err';
          msg.textContent = 'Could not save that (' + ((err && err.code) || 'error') + ').';
        }
      });
    });
  }

  /* ------------------------------------------------------------- the badge */

  var lastCounts = null;

  /** The exact-where-loaded correction: once the page has real numbers, the
      cached menu badge is set from them, the same rule my-postings applies. */
  function correctBadge(groups) {
    if (!lastCounts) return;
    if (groups) lastCounts.candidates = groups.held.length;
    var total = 0, known = 0;
    ['jobs', 'candidates', 'feedback', 'news', 'names', 'messages'].forEach(function (k) {
      if (typeof lastCounts[k] === 'number') { total += lastCounts[k]; known++; }
    });
    // all of them unknown is UNKNOWN — never write a 0 over an honest cache
    lastCounts.total = known ? total : null;
    paintTiles(lastCounts);
    if (known && window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('admin', total);
  }

  /* ----------------------------------------------------------------- wiring */

  /* ------------------------------------- postings filed under the wrong season

     WHICH MARKET YEAR A POSTING IS FOR is read off its apply-by dates now,
     not off the day it went up (owner, 2026-08-26; marketYearOf in
     _scraper/jobs-model.mjs). That settles every posting from here on and
     deliberately does not re-file the ones already published — a row's `year`
     is half its `id`, and an id that moves is one the build can no longer
     match, so the posting would be published twice. The build therefore
     REPORTS the disagreements into `data/jobs-yearcheck.json` and this panel
     draws them.

     THE REPORT IS DERIVED; THE DECISIONS ARE STORED. Nothing here decides what
     is flagged — the next build recomputes the list, and a posting corrected
     in the tracking workbook simply leaves it. But a posting the maintainer
     has READ and left where it is had no way out at all (owner, 2026-08-27:
     "I reviewed these jobs but can't clear that queue"), so the tile sat at 4
     for ever. `yearChecks/{id}` records that reading, and only that; the
     reasoning, including why the "no rules deploy" argument against a
     collection no longer holds, is in assets/oa-yearcheck.js.

     IT IS STILL NOT IN `pendingCounts()`: that function feeds the "Admin area
     N" badge on EVERY page, so a served-file fetch and a Firestore read in its
     Promise.all would make every page pay for a number only this page shows
     (the Registered-users rule). Its tile is painted here, from this page's
     own two reads. */

  var YEARCHECK = '/data/jobs-yearcheck.json';

  /** What the report says decided the season, in the panel's own words. */
  var YEAR_FROM = {
    final: 'its final apply-by date',
    review: 'its suggested apply-by date',
    posted: 'the date it was posted'
  };

  function yearCheckRows() {
    return fetchJson(YEARCHECK).then(function (doc) {
      var rows = (doc && doc.postings) || [];
      return Array.isArray(rows) ? rows : [];
    });
  }

  /** Every settled posting, as an id -> document map.

      ABSENCE MEANS SHOW, so a refused or failed read resolves to `null`
      rather than rejecting: the panel then draws every posting open with the
      settling controls withheld and says why. The opposite way round from the
      job-review queue, and deliberately — these postings are already
      published, so the risk here is hiding a disagreement, not leaking one. */
  function yearCheckDocs(db) {
    if (!window.OAYearCheck) return Promise.resolve(null);
    return db.collection(OAYearCheck.COLLECTION).get().then(function (snap) {
      var out = {};
      snap.forEach(function (d) { out[d.id] = d.data() || {}; });
      return out;
    })['catch'](function () { return null; });
  }

  /** Where this posting can actually be opened, and what that page is called.

      NOT `jobs.html#job-<id>`, which is what this was and which never worked
      (owner, 2026-08-27). Two faults in one link: a fragment can only find a
      card that happens to be on the page being shown — one of ten, in a list
      built from a fetch that has not landed when the browser looks — and half
      of these postings are not on the jobs page at all. A posting flagged here
      is one whose season disagrees with its own dates, which is exactly the
      population most likely to have rolled out of the window jobs.html shows;
      the owner's own example was Nanyang, filed under 2025-2026 and therefore
      on Previous markets, where the link could not reach it.

      assets/oa-jobnav.js answers both, from the row itself and at the moment
      the card is drawn — a build runs every twenty minutes and a deadline
      passes at midnight, so a posting can move between the two pages between
      builds. `year` is the season the posting is FILED under (the report calls
      it `stored`), because that is what the two pages sort themselves by. */
  function yearWhere(p) {
    var row = {
      id: p.id, posted: p.posted, applyByDate: p.applyByDate, year: p.stored
    };
    var NAV = window.OAJobNav;
    if (!NAV) return { href: 'jobs.html', page: 'Job postings', current: true };
    return {
      href: NAV.hrefFor(row),
      page: NAV.pageLabelFor(row),
      current: NAV.inCurrentMarket(row)
    };
  }

  function season(y) {
    return esc((y - 1) + '\u2013' + y);
  }

  /* Whether the settling controls may be drawn at all: false while the
     decisions could not be read, so the panel never offers a button whose
     write it already knows would be refused. */
  var yearActions = false;

  function yearCard(row, settled) {
    var p = row.p;
    var when = esc(p.applyByDate || p.reviewDate || p.posted || '');
    var why = YEAR_FROM[String(p.from)] || 'its own dates';
    var at = yearWhere(p);
    return '<li class="oa-aa-yc' + (settled ? ' is-settled' : '') +
      '" data-id="' + esc(p.id) + '">' +
      '<p class="oa-aa-yc-h"><strong>' + esc(p.institution) + '</strong>' +
      (p.department ? ' &mdash; ' + esc(p.department) : '') + '</p>' +
      '<p class="oa-hint">Filed under <strong>' + season(p.stored) +
      '</strong>; ' + esc(why) + ' (' + when + ') puts it in <strong>' +
      season(p.should) + '</strong>. Posted ' + esc(p.posted) + '.' +
      (at.current ? '' : ' Its season has closed, so it is listed on ' +
        '<strong>Previous markets</strong>.') +
      (row.resettled
        ? ' <strong>Its dates have changed since you settled it</strong>, so it ' +
          'is back &mdash; the seasons above are not the pair you read.'
        : '') +
      '</p>' +
      (settled && row.doc && row.doc.t
        ? '<p class="oa-hint">Settled ' + esc(String(row.doc.t).slice(0, 10)) + '.</p>'
        : '') +
      '<p class="oa-aa-yc-actions">' +
      '<a class="button oa-btn-ghost" href="' + esc(at.href) + '">' +
      'Open it on ' + esc(at.page) + '</a>' +
      (yearActions
        ? (settled
            ? ' <button type="button" class="button oa-btn-ghost" data-act="unsettle">' +
              'Bring it back</button>'
            : ' <button type="button" class="button blue" data-act="settle">' +
              'Reviewed &mdash; leave it here</button>')
        : '') +
      '<span class="oa-form-msg" role="status"></span>' +
      '</p>' +
      '</li>';
  }

  /** Draws the panel and returns how many are still WAITING (null when the
      report could not be read — unknown, never zero, the badge rule). */
  function renderYearCheck(db) {
    var list = $('oa-aa-yc-list');
    return Promise.all([yearCheckRows(), yearCheckDocs(db)]).then(function (both) {
      var rows = both[0];
      var docs = both[1];
      yearActions = !!docs && !!window.OAYearCheck;
      var split = window.OAYearCheck
        ? OAYearCheck.partition(rows, docs || {})
        : { open: rows.map(function (p) { return { p: p }; }), settled: [] };
      lastYearCheck = split.open.length;
      if (!list) return split.open.length;

      var out = split.open.length
        ? '<ul class="oa-aa-yc-ul">' +
          split.open.map(function (r) { return yearCard(r, false); }).join('') + '</ul>'
        : '<p class="oa-hint">Nothing to check &mdash; every posting is filed ' +
          'under the season its apply-by dates name, or you have read it and ' +
          'left it where it is.</p>';

      if (!docs) {
        out += '<p class="oa-form-msg is-err">Your decisions could not be read, ' +
          'so every posting is shown and none can be settled from here. If this ' +
          'says permission-denied, reload the page first &mdash; the rules ' +
          'publish themselves on every green check.</p>';
      }

      /* SETTLING IS NEVER A ONE-WAY DOOR (the newsOverrides rule): a settled
         posting leaves the list — the list is meant to get shorter — but into
         a collapsed panel that only this page draws, one click from back.

         IT STAYS OPEN ACROSS A RE-RENDER, and that is not a nicety: "Bring it
         back" is only reachable from INSIDE the panel, and every write
         re-renders — so a fresh <details> with no `open` would snap shut on
         the very action it exists for, and a maintainer restoring three
         postings would have to re-open it between each one. */
      var wasOpen = !!(list.querySelector('.oa-aa-yc-done') || {}).open;
      if (split.settled.length) {
        out += '<details class="oa-aa-yc-done"' + (wasOpen ? ' open' : '') +
          '><summary>Settled (' +
          split.settled.length + ') &mdash; read and left where they are' +
          '</summary><ul class="oa-aa-yc-ul">' +
          split.settled.map(function (r) { return yearCard(r, true); }).join('') +
          '</ul></details>';
      }
      list.innerHTML = out;
      return split.open.length;
    })['catch'](function () {
      if (list) {
        list.innerHTML = '<p class="oa-hint">Could not read ' + esc(YEARCHECK) +
          ' &mdash; it is written by the jobs build, so a site that has not ' +
          'rebuilt since this shipped has none yet.</p>';
      }
      return null;
    });
  }

  /** Settle / bring back, on the card. One delegated listener, wired once —
      the panel re-renders after every write, so a listener per button would
      be a listener per render. */
  function wireYearCheckActions(db) {
    var list = $('oa-aa-yc-list');
    if (!list || list.dataset.oaWired) return;
    list.dataset.oaWired = '1';
    list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn || !window.OAYearCheck) return;
      var card = btn.closest('.oa-aa-yc');
      var id = card && card.getAttribute('data-id');
      if (!id) return;

      var settle = btn.getAttribute('data-act') === 'settle';
      var msg = card.querySelector('.oa-form-msg');
      btn.disabled = true;

      /* Bringing one back DELETES the document rather than writing another
         status: the report is derived, so absence is exactly "not read yet"
         and there is no second state to keep. */
      var ref = db.collection(OAYearCheck.COLLECTION).doc(id);
      var write = settle
        ? findReported(id).then(function (p) {
            if (!p) throw new Error('gone');
            return ref.set(OAYearCheck.settlementFor(p));
          })
        : ref['delete']();

      write.then(function () {
        return renderYearCheck(db);
      }).then(function () {
        if (lastCounts) paintTiles(lastCounts);
      })['catch'](function (err) {
        btn.disabled = false;
        if (msg) {
          msg.className = 'oa-form-msg is-err';
          msg.textContent = 'Could not save that (' + ((err && err.code) || 'error') + ').';
        }
      });
    });
  }

  /** The reported posting as the build most recently wrote it — never the
      card's own markup. A settle records the pair of seasons the maintainer
      answered, so it has to be read from the report rather than parsed back
      out of the sentence describing it. */
  function findReported(id) {
    return yearCheckRows().then(function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === String(id)) return rows[i];
      }
      return null;
    });
  }

  var startedFor = null;

  function start() {
    OAFB.ready().then(function (fb) {
      var db = fb.firestore();

      fetchJson('/data/candidates-meta.json')['catch'](function () { return {}; })
        .then(function (meta) {
          var revealAt = String((meta && meta.revealAt) || '');
          var hint = $('oa-aa-cands-hint');
          if (hint && /^\d{4}-\d{2}-\d{2}$/.test(revealAt) && todayIso() < revealAt) {
            hint.innerHTML = 'Every profile filed through the site, including the ' +
              'ones held back until the reveal on <strong>' + esc(revealAt) +
              '</strong>. Edit opens the same form the candidate used; a held ' +
              'profile is visible to nobody but you and its candidate until the ' +
              'reveal publishes it.';
          }
          show($('oa-aa-cands'), true);
          wireCandidateActions(db, revealAt);
          return renderCandidates(db, revealAt);
        })
        .then(function (groups) {
          /* tiles first from the shared counter, then corrected from the real
             documents the moment they are on screen */
          return pendingCounts().then(function (c) {
            lastCounts = c;
            paintTiles(c);
            correctBadge(groups);
          });
        })['catch'](function () { /* each panel reports its own failure */ });

      /* the statistic beside the queues. Whichever read answers last paints
         last: landing before pendingCounts, it rides that paint (paintTiles
         always draws the card from lastUsers); landing after, it repaints the
         strip that is already on screen. A refused read keeps the '?'. */
      registeredCount().then(function (n) {
        if (typeof n !== 'number') return;
        lastUsers = n;
        if (lastCounts) paintTiles(lastCounts);
      })['catch'](function () { /* rules not deployed / offline — unknown, never 0 */ });

      show($('oa-aa-yc'), true);
      wireYearCheckActions(db);
      renderYearCheck(db).then(function (n) {
        /* whichever read answers last paints last, exactly as the registered
           count does — paintTiles always draws this card from lastYearCheck */
        if (typeof n === 'number' && lastCounts) paintTiles(lastCounts);
      });

      show($('oa-aa-news'), true);
      renderNews(db);

      show($('oa-aa-names'), true);
      wireNameFixActions(db);
      renderNameFixes(db).then(function (pending) {
        if (typeof pending === 'number' && lastCounts) {
          lastCounts.names = pending;
          correctBadge(null);
        }
      });
    })['catch'](function () {
      var g = $('oa-aa-guest');
      show(g, true);
      show($('oa-aa-admin'), false);
      if (g) g.insertAdjacentHTML('beforeend',
        '<p class="oa-form-msg is-err">The review desk is not connected to its ' +
        'database from here.</p>');
    });
  }

  function boot() {
    if (!$('oa-aa') || !window.OAAccounts || !window.OAFB) return;

    var signin = $('oa-aa-signin');
    if (signin) signin.addEventListener('click', function () { OAAccounts.openAuth(); });

    OAAccounts.onChange(function (u) {
      var is = OAAccounts.isAdmin();
      show($('oa-aa-guest'), !is);
      show($('oa-aa-admin'), is);
      show($('oa-aa-signin-p'), !is && !u && OAFB.enabled);
      if (!is) { startedFor = null; return; }
      if (startedFor === u.uid) return;   // onChange fires on every auth event
      startedFor = u.uid;
      start();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.OAAdminArea = {
    /** The one number beside "Admin area" — shared with oa-accounts.js. */
    pendingCounts: pendingCounts,
    /** Repaint the summary strip. oa-users.js calls it after sending or
        answering, so the "Message replies waiting" tile follows what the
        panel below it now shows. Best-effort: a refused read keeps the
        previous honest figure rather than replacing it with a zero. */
    refresh: function () {
      return pendingCounts().then(function (c) {
        lastCounts = c;
        paintTiles(c);
      })['catch'](function () { /* keep what is on screen */ });
    },
    /* the pure pieces, for the selftest */
    pure: {
      candGroupOf: candGroupOf,
      safeHref: safeHref
    }
  };
})();
