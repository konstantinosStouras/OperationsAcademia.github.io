/* ---------------------------------------------------------------------------
   Operations Academia — manage e-mail alert subscriptions.

   Each alert is one document at users/{uid}/alerts/{id}, inside the account's
   own private subtree — nobody but the owner and the Admin SDK can read it.
   The mailer (v2/_scraper/alerts-mailer.mjs) reads them with a collectionGroup
   query and sends what is due.

   The live preview at the bottom is built with the SAME matcher the mailer
   uses (assets/oa-alert-match.js, loaded by both), so what a subscriber is
   shown while composing an alert is what they will actually receive.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var M = window.OAAlertMatch;
  var jobs = [];          // the current postings, for the preview and the vocab
  var jobsState = 'loading';   // 'loading' | 'ok' | 'failed' — see renderPreview
  var cands = [];         // data/candidates.json — EMPTY until the reveal date,
                          // which is exactly what the mailer reads, so the
                          // preview cannot show a profile an e-mail could not
  var candMeta = null;    // data/candidates-meta.json — the reveal date and the
                          // waiting COUNT, the two things the site announces
  var rawLog = [];        // changelog.json as served, before the review decisions
  var alerts = [];        // this account's alerts
  var listFailed = false; // the last load() could not read the collection
  var editingId = null;
  var editing = null;     // the alert being edited, for the fields the form has no control for

  // which fieldset each checkbox group lives in — writeGroup needs it to
  // render a stored value the current catalogue no longer offers
  var GROUP_HOST = { type: 'a-type', level: 'a-level', country: 'a-country' };

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* An ISO day the way the site writes dates — the mailer's longDate(). This
     page does not load oa-list.js, so the preview carries its own copy; keep
     the three in step. */
  function longDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return names[+m[2] - 1] + ' ' + (+m[3]) + ', ' + (+m[1]);
  }

  function say(msg, kind) {
    var m = $('a-msg');
    m.textContent = msg || '';
    m.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /* -------------------------------------------------------- filter vocab */

  function vocab(get) {
    var c = Object.create(null);
    jobs.forEach(function (r) {
      [].concat(get(r) || []).forEach(function (v) { if (v) c[v] = (c[v] || 0) + 1; });
    });
    return Object.keys(c).sort(function (a, b) { return c[b] - c[a] || a.localeCompare(b); });
  }

  function addCheck(host, name, v, orphan) {
    var id = name + '-' + M.fold(v).replace(/[^a-z0-9]+/g, '-');
    var lab = document.createElement('label');
    lab.className = 'oa-check';
    if (orphan) lab.setAttribute('data-orphan', '1');
    lab.innerHTML = '<input type="checkbox" id="' + esc(id) + '" value="' + esc(v) + '" ' +
      (orphan ? 'data-orphan="1" ' : '') +
      'data-group="' + name + '"> <span>' + esc(v) +
      (orphan ? ' <em class="oa-hint" style="display:inline">— no current postings</em>' : '') +
      '</span>';
    host.appendChild(lab);
  }

  function fillChecks(hostId, values, name) {
    var host = $(hostId);
    host.innerHTML = '';
    values.forEach(function (v) { addCheck(host, name, v, false); });
  }

  function readGroup(name) {
    return Array.prototype.slice
      .call(document.querySelectorAll('input[data-group="' + name + '"]:checked'))
      .map(function (n) { return n.value; });
  }

  function writeGroup(name, values) {
    var want = values || [];
    var host = $(GROUP_HOST[name]);

    // Drop the boxes a previous alert needed us to invent (below) — they are
    // not part of the current vocabulary and must not linger as options.
    if (host) {
      Array.prototype.forEach.call(host.querySelectorAll('label[data-orphan]'),
        function (n) { n.parentNode.removeChild(n); });
    }

    /* A saved alert can name a value no posting currently carries — the
       catalogue rotates, and 'Ireland', 'Turkey' and friends are one posting
       each today. With no control for it, writeGroup could not tick it and
       readGroup could not read it back, so the next save — even one that only
       fixed a typo in the name — silently WIDENED the alert: an empty filter
       means "any". Render it instead, marked as currently unmatched. */
    var known = {};
    Array.prototype.forEach.call(
      document.querySelectorAll('input[data-group="' + name + '"]'),
      function (n) { known[n.value] = 1; }
    );
    want.forEach(function (v) {
      if (host && !known[v]) { addCheck(host, name, v, true); known[v] = 1; }
    });

    Array.prototype.forEach.call(
      document.querySelectorAll('input[data-group="' + name + '"]'),
      function (n) { n.checked = want.indexOf(n.value) !== -1; }
    );
  }

  /* ------------------------------------------------------------ the form */

  /* Deliberately NO `enabled` here. This object is written with
     set(…, {merge:true}), so a key it omits keeps its stored value — and
     `enabled` is the same flag Pause and the e-mail's Unsubscribe link clear.
     Hard-coding it true meant that opening a paused (or unsubscribed) alert to
     fix a typo silently resubscribed the reader. The submit handler sets it,
     once, when the alert is created. */
  function readForm() {
    var topics = [];
    if ($('t-jobs').checked) topics.push('jobs');
    if ($('t-updates').checked) topics.push('updates');
    if ($('t-candidates').checked) topics.push('candidates');
    return {
      name: $('a-name').value.trim().slice(0, 120),
      email: $('a-email').value.trim().slice(0, 200),
      frequency: $('a-freq').value,
      criteria: {
        topics: topics,
        text: $('a-text').value.trim().slice(0, 120),
        type: readGroup('type'),
        level: readGroup('level'),
        country: readGroup('country'),
        // the form has no control for this one, so carry what is stored rather
        // than blanking a filter the subscriber never saw
        characteristics: editing ? M.normalise(editing.criteria).characteristics : []
      }
    };
  }

  function writeForm(a) {
    // a NEW alert starts on jobs — the matcher no longer invents that default,
    // and this is where a default belongs. The What's-new page deep-links
    // ?topic=updates, arriving from "Subscribe to site updates": that visitor
    // asked for the OTHER stream, so the new form starts there instead.
    if (!a) {
      var wanted = new URLSearchParams(location.search).get('topic');
      a = { criteria: { topics: wanted === 'updates' || wanted === 'candidates'
        ? [wanted] : ['jobs'] } };
    }
    var c = M.normalise(a.criteria);
    $('a-name').value = a.name || '';
    $('a-email').value = a.email || (OAAccounts.user() || {}).email || '';
    $('a-freq').value = a.frequency || 'daily';
    $('t-jobs').checked = c.topics.indexOf('jobs') !== -1;
    $('t-updates').checked = c.topics.indexOf('updates') !== -1;
    $('t-candidates').checked = c.topics.indexOf('candidates') !== -1;
    $('a-text').value = c.text || '';
    writeGroup('type', c.type);
    writeGroup('level', c.level);
    writeGroup('country', c.country);
    syncFormState();
  }

  function syncFormState() {
    show($('a-filters'), $('t-jobs').checked);
    $('oa-form-legend').textContent = editingId ? 'Edit this alert' : 'Create an alert';
    $('a-save').textContent = editingId ? 'Save changes' : 'Create alert';
    show($('a-cancel'), !!editingId);
    renderPreview();
  }

  /* ---------------------------------------------------------- the preview */

  function renderPreview() {
    var a = readForm();
    var c = a.criteria;
    var box = $('oa-preview');

    /* THE PREVIEW CARRIES REAL POSTINGS, so it belongs to a registered reader
       like every other detail on the site (assets/oa-gate.js). The whole app
       is `hidden` when nobody is signed in — but hidden is not absent, and
       this file's example e-mail was being built anyway (applyNewsDecisions
       re-renders it when the change-log decisions land, which happens on
       every page load), leaving a university, its department, the entry
       level, the country and both apply-by dates sitting in the document of
       a signed-out reader. That is precisely the shape the gate exists to
       refuse: a blur, or a `hidden`, over real text is a picture of a lock.

       Nothing is lost by waiting — signing in runs resetForm(), which calls
       syncFormState() and repaints this. Asked of the ONE definition, so the
       page and the cards cannot disagree about who is reading. */
    if (window.OAGate && OAGate.locked()) { box.innerHTML = ''; return; }

    if (!M.hasIntent(c)) {
      box.innerHTML = '<p class="oa-hint">Tick at least one thing to be e-mailed about.</p>';
      return;
    }

    /* The newest postings that would have matched — a real sample, not a
       mock-up. Sorted the way the MAILER sorts before it renders (addedAt
       descending, alerts-mailer.mjs), not in the file's display order: that
       order puts the featured posting first whatever its age, so the preview
       used to lead with a row a year older than the ones the e-mail would
       actually have led with. */
    var hits = jobs.filter(function (r) { return M.matchesJob(r, c); })
      .sort(function (x, y) {
        return String(y.addedAt || '').localeCompare(String(x.addedAt || ''));
      });
    var sample = hits.slice(0, 3);
    var matching = hits.length;

    var parts = [];
    /* The subject the MAILER gives an unnamed alert (alerts-mailer.mjs):
       "N new job posting(s)" when postings went, else what is new. */
    var fallbackSubject = M.wantsJobs(c) && matching
      ? matching + ' new job posting' + (matching > 1 ? 's' : '')
      : 'What is new on Operations Academia';
    parts.push('<div class="oa-preview-head"><strong>Subject:</strong> ' +
      esc(a.name || fallbackSubject) + '</div>');
    parts.push('<div class="oa-preview-body">');

    if (M.wantsJobs(c)) {
      if (sample.length) {
        parts.push('<p>' + esc(matching === 1 ? 'A new job posting matches your alert:'
          : matching + ' new job postings match your alert:') + '</p><ul>');
        sample.forEach(function (r) {
          parts.push('<li><strong>' + esc(r.institution) + '</strong> &mdash; ' +
            esc(r.department) + '<br><span class="oa-hint" style="display:inline">' +
            esc((r.levels || []).join(', ')) + ' &middot; ' + esc(r.country) +
            (r.reviewDate ? ' &middot; suggested apply by ' +
              esc(longDate(r.reviewDate)) : '') +
            ' &middot; final apply by ' + esc(r.applyBy || 'until filled') + '</span></li>');
        });
        parts.push('</ul>');
        parts.push('<p class="oa-hint">' + matching + ' of the ' + jobs.length +
          ' postings currently on the site match these filters' +
          (M.isBroad(c) ? ' (no filters set — you will hear about every posting).' : '.') +
          '</p>');
      } else if (jobsState === 'loading') {
        parts.push('<p class="oa-hint">Loading the current postings…</p>');
      } else if (jobsState === 'failed') {
        // "nothing matches" and "we could not read the postings" are different
        // things, and telling someone to loosen a filter they have not set is
        // both false and unactionable
        parts.push('<p class="oa-hint"><strong>We could not load the current postings, ' +
          'so there is nothing to sample here.</strong> The alert itself is unaffected — ' +
          'save it and it will be matched as normal.</p>');
      } else if (M.isBroad(c)) {
        parts.push('<p class="oa-hint"><strong>There is no posting on the site right ' +
          'now.</strong> You will hear from us as soon as one appears.</p>');
      } else {
        parts.push('<p class="oa-hint"><strong>No posting currently on the site matches ' +
          'these filters.</strong> That is allowed — you will simply hear from us when one ' +
          'appears. But if you did not mean to be this specific, loosen a filter.</p>');
      }
    }

    if (M.wantsCandidates(c)) {
      parts.push('<p><strong>Job market candidates</strong></p>');
      if (cands.length) {
        /* The profiles are public: the first e-mail is the short "they are
           live" note, then a note per new profile — sample the newest. The
           rows come from data/candidates.json, the same file the mailer
           reads, so the preview cannot show a profile an e-mail could not. */
        parts.push('<p>First one short note that this year’s profiles are live (' +
          cands.length + ' so far), then a note whenever a new candidate posts, like:</p><ul>');
        cands.slice(0, 2).forEach(function (r) {
          parts.push('<li><strong>' + esc(r.name) + '</strong><br>' +
            '<span class="oa-hint" style="display:inline">' +
            esc([r.position, r.affiliation].filter(Boolean).join(' · ')) +
            '</span></li>');
        });
        parts.push('</ul>');
      } else {
        /* Held: the served file is empty until the admin's reveal date, and
           the meta carries only the date and a COUNT — which is all the site
           itself announces, so it is all the preview may say either. */
        var revealAt = (candMeta || {}).revealAt || '';
        var held = (candMeta || {}).heldCount || 0;
        parts.push('<p class="oa-hint">Profiles are being collected now and go up all at ' +
          'once' + (revealAt ? ' on <strong>' + esc(revealAt) + '</strong>'
            : ', on a date the site will announce') +
          (held ? ' (' + held + ' already waiting)' : '') +
          '. Nothing is e-mailed about any profile before then. On the day you will get ' +
          'one short, friendly note that the candidates are live, and from then on a note ' +
          'for each new profile.</p>');
      }
    }

    if (M.wantsUpdates(c)) {
      parts.push('<p><strong>What is new on the site</strong></p><ul>');
      (window.OA_CHANGELOG || []).slice(0, 2).forEach(function (e) {
        parts.push('<li><strong>' + esc(e.title) + '</strong><br>' +
          '<span class="oa-hint" style="display:inline">' + esc(e.summary) + '</span></li>');
      });
      parts.push('</ul>');
    }

    parts.push('<p class="oa-preview-foot">You are receiving this because you asked ' +
      'Operations Academia to tell you about new postings. ' +
      '<u>Change what you receive</u> &middot; <u>Unsubscribe from these e-mails</u> ' +
      '&middot; <u>Send feedback</u></p>');
    parts.push('</div>');
    box.innerHTML = parts.join('');
  }

  /* ------------------------------------------------------------ the list */

  function describe(a) {
    var c = M.normalise(a.criteria);
    var bits = [];
    if (c.topics.indexOf('jobs') !== -1) {
      bits.push(M.isBroad(c) ? 'every new job posting' : 'job postings matching ' + [
        c.text ? '“' + c.text + '”' : '',
        c.type.length ? c.type.join(' or ') : '',
        c.level.length ? c.level.join(' or ') : '',
        c.country.length ? c.country.join(' or ') : ''
      ].filter(Boolean).join(', '));
    }
    if (c.topics.indexOf('candidates') !== -1) bits.push('new job market candidates');
    if (c.topics.indexOf('updates') !== -1) bits.push('changes to the website');
    // only reachable for an alert saved before the no-topic guard worked; say
    // what it does rather than describing it as a subscription to everything
    if (!bits.length) return 'nothing selected — this alert will not send. Edit it below.';
    var freq = { immediate: 'as it happens', daily: 'daily', weekly: 'weekly', monthly: 'monthly' };
    return bits.join(' and ') + ' — ' + (freq[a.frequency] || 'daily');
  }

  function renderList() {
    var host = $('oa-alert-list');
    if (!alerts.length) {
      host.innerHTML = '<p class="oa-hint">You have no alerts yet. Create one below.</p>';
      return;
    }
    host.innerHTML = '';
    alerts.forEach(function (a) {
      var card = document.createElement('div');
      card.className = 'oa-alert-card' + (a.enabled === false ? ' is-off' : '');
      card.innerHTML =
        '<div class="oa-alert-main">' +
          '<strong>' + esc(a.name || 'Untitled alert') + '</strong>' +
          '<p class="oa-hint">' + esc(describe(a)) + '</p>' +
          '<p class="oa-hint">to ' + esc(a.email || '') +
            (a.lastSentAt ? ' &middot; last sent ' + esc(String(a.lastSentAt).slice(0, 10)) : ' &middot; not sent yet') +
          '</p>' +
        '</div>' +
        '<div class="oa-alert-actions">' +
          '<button type="button" data-act="toggle">' +
            (a.enabled === false ? 'Resume' : 'Pause') + '</button>' +
          '<button type="button" data-act="edit">Edit</button>' +
          '<button type="button" data-act="delete" class="is-danger">Delete</button>' +
        '</div>';
      card.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-act]');
        if (!b) return;
        if (b.dataset.act === 'edit') {
          editingId = a.id;
          editing = a;
          writeForm(a);
          // saving no longer resumes a paused alert, so say which one it is
          say(a.enabled === false
            ? 'This alert is paused. Saving your changes will not resume it — ' +
              'use Resume on its card for that.'
            : '');
          $('oa-alert-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else if (b.dataset.act === 'toggle') {
          toggle(a);
        } else if (b.dataset.act === 'delete') {
          if (confirm('Delete the alert “' + (a.name || 'Untitled') + '”? ' +
                      'You will stop receiving these e-mails.')) remove(a.id);
        }
      });
      host.appendChild(card);
    });
  }

  /* --------------------------------------------------------- persistence */

  function coll() {
    return OAFB.ready().then(function (fb) {
      var u = OAAccounts.user();
      return fb.firestore().collection(OAFB.col.users).doc(u.uid).collection(OAFB.col.alerts);
    });
  }

  function resetForm() {
    editingId = null;
    editing = null;
    writeForm(null);
  }

  function load() {
    listFailed = false;
    return coll().then(function (c) { return c.get(); }).then(function (snap) {
      alerts = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      renderList();
      /* the account menu's badge, from the list we already have — no read,
         and exact the moment an alert is added or deleted */
      if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('alerts', alerts.length);
    }).catch(function (err) {
      // remembered, not just printed: the unsubscribe banner must not report
      // "we could not find that alert" when the read is what failed
      listFailed = true;
      $('oa-alert-list').innerHTML =
        '<p class="oa-form-msg is-err">Could not load your alerts (' +
        esc(err.code || err.message) + ').</p>';
    });
  }

  function write(id, patch) {
    return coll().then(function (c) {
      return id ? c.doc(id).set(patch, { merge: true }) : c.add(patch);
    });
  }

  /* The FORM's save. It is the only path that may reset the composer — a
     Pause or a Delete on some other card used to run through here and wipe an
     edit in progress while printing "Saved.", a success message for work that
     had just been thrown away. */
  function save(id, patch) {
    return write(id, patch).then(function () {
      say(id ? 'Saved.' : 'Alert created — you will start receiving it.', 'ok');
      resetForm();
      return load();
    }).catch(function (err) {
      say('Could not save that alert (' + (err.code || err.message) + ').', 'err');
    });
  }

  function toggle(a) {
    var on = a.enabled === false;          // pressing Resume
    return write(a.id, { enabled: on }).then(function () {
      say(on ? 'Alert resumed.'
             : 'Alert paused — you will receive no more e-mails from it.', 'ok');
      return load();                        // the composer is deliberately left alone
    }).catch(function (err) {
      say('Could not change that alert (' + (err.code || err.message) + ').', 'err');
    });
  }

  function remove(id) {
    return coll().then(function (c) { return c.doc(id).delete(); })
      .then(function () {
        say('Alert deleted.', 'ok');
        // A merge-set on a deleted document RECREATES it, so leaving the
        // composer in edit mode for it means the next Save resurrects the
        // alert the reader just confirmed deleting.
        if (editingId === id) resetForm();
        return load();
      })
      .catch(function (err) { say('Could not delete that (' + (err.code || err.message) + ').', 'err'); });
  }

  /* ------------------------------------------------ what's new, as published

     The preview promises "this is the e-mail you will get", so it has to read
     the update log the way the mailer does: only entries the maintainer has
     published. Applied twice — once when the log lands (the date rule alone,
     which withholds everything since the review gate) and again when the
     decisions arrive, which is what lets an already-published entry through.
     Both are re-previewed, since the composer may already be on screen. */
  function applyNewsDecisions(docs) {
    var News = window.OANews;
    window.OA_CHANGELOG = News ? News.publicUpdates(rawLog, docs || {}) : [];
    renderPreview();
  }

  function loadNewsDecisions() {
    if (!window.OANews || !window.OAFB || !OAFB.enabled) return;
    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(OANews.COLLECTION).get();
    }).then(function (snap) {
      var docs = {};
      snap.forEach(function (d) { docs[d.id] = d.data(); });
      applyNewsDecisions(docs);
    })['catch'](function () { /* unreadable — the date rule stands, and withholds */ });
  }

  /* -------------------------------------------------------------- wiring */

  function boot() {
    if (!window.OAFB || !OAFB.enabled) {
      show($('oa-offline'), true);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });

    /* The postings feed both the filter vocabulary and the preview. A failure
       is NOT the same as an empty catalogue: swallowing it into [] renders the
       Type / Entry level / Location groups as bare headings with nothing in
       them and no explanation, so the reader cannot express a filter and is
       not told why. Remember which happened. */
    var ready = Promise.all([
      fetch('data/jobs.json', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch('changelog.json', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : { updates: [] }; })
        .catch(function () { return { updates: [] }; }),
      /* the candidates preview: the SERVED rows (empty until the reveal) and
         the meta's reveal date + waiting count. A failed read of either is
         simply the held state's wording without a date — never an error. */
      fetch('data/candidates.json', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      fetch('data/candidates-meta.json', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      jobsState = res[0] ? 'ok' : 'failed';
      jobs = res[0] || [];
      cands = Array.isArray(res[2]) ? res[2] : [];
      candMeta = res[3];
      /* THE PREVIEW SHOWS REAL ENTRIES, so it must show only the ones that are
         really public. The raw log carries entries the maintainer has not
         published yet and entries they have taken down; putting either in
         front of a reader composing an alert would leak the first and
         resurrect the second, and this preview is meant to be exactly what
         they will be e-mailed. OANews.publicUpdates is the same decision the
         mailer makes; with no decisions read it falls back to the date rule,
         which withholds anything since the review gate rather than guessing.
         (Loaded from assets/oa-news.js; without it nothing is previewed, which
         is the safe direction.) */
      rawLog = (res[1] && res[1].updates) || [];
      applyNewsDecisions();
      loadNewsDecisions();
      fillChecks('a-type', vocab(function (r) { return r.type; }), 'type');
      fillChecks('a-level', vocab(function (r) { return r.levels; }), 'level');
      fillChecks('a-country', vocab(function (r) { return r.country; }), 'country');
      show($('a-filters-note'), jobsState === 'failed');
    });

    var form = $('oa-alert-form');
    form.addEventListener('input', renderPreview);
    form.addEventListener('change', function (e) {
      if (e.target === $('t-jobs') || e.target === $('t-updates')) syncFormState();
      else renderPreview();
    });

    $('a-cancel').addEventListener('click', function () {
      resetForm();
      say('');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = readForm();
      if (!a.name) { say('Please name the alert — it becomes the e-mail subject.', 'err'); $('a-name').focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) {
        say('Please give the e-mail address to send to.', 'err'); $('a-email').focus(); return;
      }
      if (!M.hasIntent(a.criteria)) {
        say('Tick at least one thing to be e-mailed about, or the alert would never send.', 'err');
        return;
      }
      if (!editingId) {
        /* Only on a NEW alert. `enabled` on an edit would resume a paused one;
           `createdAt` is the first window the mailer sends — without it
           `since` is empty and the first e-mail carries the whole
           back-catalogue (see alerts-mailer.mjs), and re-stamping it on an
           edit would do that all over again. `uid` is what the unsubscribe
           link in the e-mail footer names. */
        a.enabled = true;
        a.createdAt = new Date().toISOString();
        a.uid = (OAAccounts.user() || {}).uid || '';
      }
      say('Saving…');
      save(editingId, a);
    });

    OAAccounts.onChange(function (user) {
      show($('oa-alerts-app'), !!user);
      show($('oa-needauth'), !user);
      if (!user) {
        // another account may sign in on this same page load: leaving the
        // previous session's editingId behind would label their blank form
        // "Edit this alert" and write to a document id they never owned
        editingId = null;
        editing = null;
        alerts = [];
        renderList();
        showUnsubNotice('signin');
        return;
      }
      ready.then(function () {
        resetForm();
        return load();
      }).then(handleUnsubscribeLink);
    });
  }

  /* ------------------------------------------------------- unsubscribing

     Every alert e-mail carries ?unsubscribe=<alertId> in its footer and in the
     List-Unsubscribe header. Opening it must actually stop the e-mails.

     A subscription lives inside its owner's private Firestore subtree, so the
     reader has to be signed in for us to touch it — a static site has no
     endpoint that could act on an unauthenticated token. That is a real
     limitation and the page says so plainly rather than appearing to work.
     If you ever add a Cloud Function, a signed token would remove this step
     (and only then should List-Unsubscribe-Post be declared; see _mail.mjs). */

  function unsubTarget() {
    var p = new URLSearchParams(location.search);
    return p.get('unsubscribe') || '';
  }

  function showUnsubNotice(kind, name) {
    var host = $('oa-unsub-notice');
    if (!host) return;
    if (!unsubTarget()) { show(host, false); return; }
    var msg;
    if (kind === 'signin') {
      msg = '<strong>To stop these e-mails, please sign in.</strong> ' +
        'Your alerts are private to your account, so we cannot change one ' +
        'without knowing it is you. Sign in and this page will stop it ' +
        'straight away.';
    } else if (kind === 'done') {
      msg = '<strong>Stopped.</strong> You will receive no more e-mails from ' +
        '&ldquo;' + esc(name) + '&rdquo;. It is paused rather than deleted, so ' +
        'you can turn it back on below whenever you like.';
      host.className = 'oa-note';
    } else if (kind === 'already') {
      msg = '<strong>That alert is already paused.</strong> You are not ' +
        'receiving e-mails from it.';
      host.className = 'oa-note';
    } else if (kind === 'error') {
      msg = '<strong>We could not reach your alerts just now,</strong> so we have ' +
        'not been able to stop that one. Nothing has changed — please reload the ' +
        'page and try again.';
    } else {
      msg = '<strong>We could not find that alert.</strong> It may already have ' +
        'been deleted, or it may belong to a different account. Your current ' +
        'alerts are listed below.';
    }
    host.innerHTML = '<p>' + msg + '</p>';
    show(host, true);
  }

  function handleUnsubscribeLink() {
    var id = unsubTarget();
    if (!id) return;
    // The list is empty after a failed read too. Reporting that as "we could
    // not find that alert" tells someone their subscription is gone while it
    // keeps sending — say what actually happened instead.
    if (listFailed) { showUnsubNotice('error'); return; }
    var found = null;
    for (var i = 0; i < alerts.length; i++) if (alerts[i].id === id) found = alerts[i];
    if (!found) { showUnsubNotice('missing'); return; }
    if (found.enabled === false) { showUnsubNotice('already', found.name); return; }
    return coll()
      .then(function (c) { return c.doc(id).set({ enabled: false }, { merge: true }); })
      .then(function () {
        showUnsubNotice('done', found.name);
        return load();
      })
      .catch(function () { showUnsubNotice('error'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
