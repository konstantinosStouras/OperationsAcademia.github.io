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
  var alerts = [];        // this account's alerts
  var editingId = null;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  function fillChecks(hostId, values, name) {
    var host = $(hostId);
    host.innerHTML = '';
    values.forEach(function (v) {
      var id = name + '-' + M.fold(v).replace(/[^a-z0-9]+/g, '-');
      var lab = document.createElement('label');
      lab.className = 'oa-check';
      lab.innerHTML = '<input type="checkbox" id="' + esc(id) + '" value="' + esc(v) + '" ' +
        'data-group="' + name + '"> <span>' + esc(v) + '</span>';
      host.appendChild(lab);
    });
  }

  function readGroup(name) {
    return Array.prototype.slice
      .call(document.querySelectorAll('input[data-group="' + name + '"]:checked'))
      .map(function (n) { return n.value; });
  }

  function writeGroup(name, values) {
    var want = values || [];
    Array.prototype.forEach.call(
      document.querySelectorAll('input[data-group="' + name + '"]'),
      function (n) { n.checked = want.indexOf(n.value) !== -1; }
    );
  }

  /* ------------------------------------------------------------ the form */

  function readForm() {
    var topics = [];
    if ($('t-jobs').checked) topics.push('jobs');
    if ($('t-updates').checked) topics.push('updates');
    return {
      name: $('a-name').value.trim().slice(0, 120),
      email: $('a-email').value.trim().slice(0, 200),
      frequency: $('a-freq').value,
      enabled: true,
      criteria: {
        topics: topics,
        text: $('a-text').value.trim().slice(0, 120),
        type: readGroup('type'),
        level: readGroup('level'),
        country: readGroup('country'),
        characteristics: []
      }
    };
  }

  function writeForm(a) {
    a = a || { criteria: {} };
    var c = M.normalise(a.criteria);
    $('a-name').value = a.name || '';
    $('a-email').value = a.email || (OAAccounts.user() || {}).email || '';
    $('a-freq').value = a.frequency || 'daily';
    $('t-jobs').checked = c.topics.indexOf('jobs') !== -1;
    $('t-updates').checked = c.topics.indexOf('updates') !== -1;
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

    if (!M.hasIntent(c)) {
      box.innerHTML = '<p class="oa-hint">Tick at least one thing to be e-mailed about.</p>';
      return;
    }

    // the newest postings that would have matched — a real sample, not a mock-up
    var sample = jobs.filter(function (r) { return M.matchesJob(r, c); }).slice(0, 3);
    var matching = jobs.filter(function (r) { return M.matchesJob(r, c); }).length;

    var parts = [];
    parts.push('<div class="oa-preview-head"><strong>Subject:</strong> ' +
      esc(a.name || 'Operations Academia — new job postings') + '</div>');
    parts.push('<div class="oa-preview-body">');

    if (M.wantsJobs(c)) {
      if (sample.length) {
        parts.push('<p>Since we last wrote, these job postings were added:</p><ul>');
        sample.forEach(function (r) {
          parts.push('<li><strong>' + esc(r.institution) + '</strong> &mdash; ' +
            esc(r.department) + '<br><span class="oa-hint" style="display:inline">' +
            esc((r.levels || []).join(', ')) + ' &middot; ' + esc(r.country) +
            ' &middot; apply by ' + esc(r.applyBy || 'until filled') + '</span></li>');
        });
        parts.push('</ul>');
        parts.push('<p class="oa-hint">' + matching + ' of the ' + jobs.length +
          ' postings currently on the site match these filters' +
          (M.isBroad(c) ? ' (no filters set — you will hear about every posting).' : '.') +
          '</p>');
      } else {
        parts.push('<p class="oa-hint"><strong>No posting currently on the site matches ' +
          'these filters.</strong> That is allowed — you will simply hear from us when one ' +
          'appears. But if you did not mean to be this specific, loosen a filter.</p>');
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
      '<u>Change what you get</u> &middot; <u>Unsubscribe</u></p>');
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
    if (c.topics.indexOf('updates') !== -1) bits.push('changes to the website');
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
          writeForm(a);
          $('oa-alert-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else if (b.dataset.act === 'toggle') {
          save(a.id, { enabled: a.enabled === false });
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

  function load() {
    return coll().then(function (c) { return c.get(); }).then(function (snap) {
      alerts = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      renderList();
    }).catch(function (err) {
      $('oa-alert-list').innerHTML =
        '<p class="oa-form-msg is-err">Could not load your alerts (' +
        esc(err.code || err.message) + ').</p>';
    });
  }

  function save(id, patch) {
    return coll().then(function (c) {
      return id ? c.doc(id).set(patch, { merge: true }) : c.add(patch);
    }).then(function () {
      say(id ? 'Saved.' : 'Alert created — you will start receiving it.', 'ok');
      editingId = null;
      writeForm(null);
      return load();
    }).catch(function (err) {
      say('Could not save that alert (' + (err.code || err.message) + ').', 'err');
    });
  }

  function remove(id) {
    return coll().then(function (c) { return c.doc(id).delete(); })
      .then(function () { say('Alert deleted.', 'ok'); return load(); })
      .catch(function (err) { say('Could not delete that (' + (err.code || err.message) + ').', 'err'); });
  }

  /* -------------------------------------------------------------- wiring */

  function boot() {
    if (!window.OAFB || !OAFB.enabled) {
      show($('oa-offline'), true);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });

    // the postings feed both the filter vocabulary and the preview
    var ready = Promise.all([
      fetch('data/jobs.json', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      fetch('changelog.json', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { updates: [] }; })
        .catch(function () { return { updates: [] }; })
    ]).then(function (res) {
      jobs = res[0] || [];
      window.OA_CHANGELOG = (res[1] && res[1].updates) || [];
      fillChecks('a-type', vocab(function (r) { return r.type; }), 'type');
      fillChecks('a-level', vocab(function (r) { return r.levels; }), 'level');
      fillChecks('a-country', vocab(function (r) { return r.country; }), 'country');
    });

    var form = $('oa-alert-form');
    form.addEventListener('input', renderPreview);
    form.addEventListener('change', function (e) {
      if (e.target === $('t-jobs') || e.target === $('t-updates')) syncFormState();
      else renderPreview();
    });

    $('a-cancel').addEventListener('click', function () {
      editingId = null;
      writeForm(null);
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
      say('Saving…');
      save(editingId, a);
    });

    OAAccounts.onChange(function (user) {
      show($('oa-alerts-app'), !!user);
      show($('oa-needauth'), !user);
      if (!user) return;
      ready.then(function () {
        writeForm(null);
        load();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
