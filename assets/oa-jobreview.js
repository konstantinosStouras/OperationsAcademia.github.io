/* ---------------------------------------------------------------------------
   Operations Academia — the maintainer's review queue for the tracking sheet.

   Postings crawled from the job market workbook are no longer published on
   sight: they are held in the Firestore `jobReviews` collection until the
   maintainer has looked at them. This draws that queue at the top of the
   Admin area (admin-area.html — it lived on the feedback page until the
   Admin area gathered every review queue, owner 2026-08-21), above the
   feedback inbox, and lets them correct any field before approving.

   AUTHORISATION IS THE RULES, never this file. `jobReviews` is admin-read AND
   admin-write in _firestore.rules — unlike `rowOverrides`, which is public-read,
   because a queued posting is by definition not yet public. Everything here
   only decides whether a panel is DRAWN: a browser that draws it for the wrong
   visitor still cannot read a single document.

   WHAT AN EDIT IS. A field the maintainer types is stored in the document's
   `edits` map, never written back over the row the sheet gave. The sheet stays
   the source of truth for what the posting IS; the edit is a correction laid on
   top, re-applied on every build. That is the same shape as the HigherEdJobs
   deadline cache and as oa-rowedit.js's overrides, and it is what lets the
   workbook be re-read every morning without discarding the maintainer's work.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var COL = 'jobReviews';

  /* The fields offered, in the order they are shown. A SUBSET of what a
     posting holds: id, market year, posted date and source are its identity
     and its bookkeeping — editing them would detach the posting from the sheet
     row it came from, so the next sync would queue it again as new. Those are
     corrected in the workbook. Keep in step with EDITABLE in
     _scraper/jobreview.mjs and with the key list in _firestore.rules;
     selftest.mjs pins all three together. */
  var FIELDS = [
    { key: 'institution', label: 'Institution', max: 220 },
    { key: 'department', label: 'School / department', max: 260 },
    { key: 'school', label: 'School', max: 200 },
    { key: 'unit', label: 'Department / unit', max: 200 },
    { key: 'type', label: 'Type', max: 40,
      options: ['', 'Business School', 'University'] },
    { key: 'levels', label: 'Entry level', list: true, options: [
      'Assistant Professor', 'Associate Professor', 'Full Professor',
      'Non-tenure track (teaching) position', 'Post-Doc',
      'Visiting Faculty (various levels)', 'Other Ranks'] },
    { key: 'country', label: 'Country', max: 80 },
    { key: 'applyBy', label: 'Apply by', max: 400 },
    { key: 'applyByDate', label: 'Closing date', max: 10, type: 'date' },
    { key: 'comments', label: 'Comments', max: 1500, area: true },
    { key: 'adUrl', label: 'Link to the advert', max: 600 },
    { key: 'postedAtUrl', label: 'Posted at', max: 600 },
    { key: 'furtherInfoUrl', label: 'Further info', max: 600 }
  ];

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* A link is shown as a link, so the maintainer can open the advertisement
     they are being asked to approve. Host-validated the same way the pipeline
     validates one: anything that is not http(s) is shown as text, never as an
     href — a queued row is machine-derived and this panel is the one place it
     is rendered before anyone has vetted it. */
  function safeHref(u) {
    var s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function fieldValue(doc, key) {
    var edits = doc.edits || {};
    if (Object.prototype.hasOwnProperty.call(edits, key)) return edits[key];
    return (doc.row || {})[key];
  }

  function inputFor(f, value, id) {
    var v = value == null ? '' : value;
    if (f.list) {
      var chosen = Array.isArray(v) ? v : (v ? [v] : []);
      return '<div class="oa-rv-levels">' + f.options.map(function (o, i) {
        return '<label class="oa-rv-check"><input type="checkbox" data-key="' + f.key +
          '" id="' + id + '-' + i + '" value="' + esc(o) + '"' +
          (chosen.indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(o) + '</label>';
      }).join('') + '</div>';
    }
    if (f.options) {
      return '<select id="' + id + '" data-key="' + f.key + '">' +
        f.options.map(function (o) {
          return '<option value="' + esc(o) + '"' +
            (String(v) === o ? ' selected' : '') + '>' + esc(o || '—') + '</option>';
        }).join('') + '</select>';
    }
    if (f.area) {
      return '<textarea id="' + id + '" data-key="' + f.key + '" maxlength="' + f.max +
        '" rows="3">' + esc(v) + '</textarea>';
    }
    return '<input id="' + id + '" data-key="' + f.key + '" type="' +
      (f.type || 'text') + '" maxlength="' + f.max + '" value="' + esc(v) + '">';
  }

  /** What the form currently says, as an edits map — only the fields that
      DIFFER from the row the sheet gave, so an untouched posting is approved
      with an empty `edits` and stays tied to the workbook. */
  function readEdits(card, doc) {
    var row = doc.row || {};
    var out = {};

    FIELDS.forEach(function (f) {
      var val;
      if (f.list) {
        val = Array.prototype.slice.call(
          card.querySelectorAll('input[type=checkbox][data-key="' + f.key + '"]'))
          .filter(function (b) { return b.checked; })
          .map(function (b) { return b.value; });
      } else {
        var el = card.querySelector('[data-key="' + f.key + '"]');
        if (!el) return;
        val = el.value;
      }
      var was = row[f.key];
      var same = Array.isArray(val)
        ? JSON.stringify(val) === JSON.stringify(was || [])
        : String(val == null ? '' : val) === String(was == null ? '' : was);
      if (!same) out[f.key] = val;
    });

    return out;
  }

  function fmtDate(v) {
    var d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
    if (!d || isNaN(+d)) return '';
    return d.toISOString().slice(0, 10);
  }

  function cardHtml(doc, i) {
    var row = doc.row || {};
    var ad = safeHref(fieldValue(doc, 'adUrl'));
    var idp = 'rv' + i;

    return '<header>' +
        '<strong>' + esc(row.institution || row.id || 'Untitled posting') + '</strong>' +
        (row.department ? ' <span class="oa-hint" style="display:inline">— ' +
          esc(row.department) + '</span>' : '') +
        '<span class="oa-fb-status is-open">under review</span>' +
        '<p class="oa-hint">Advertised ' + esc(row.posted || '?') +
          ' &middot; market ' + esc(String(row.year || '?')) +
          ' &middot; queued ' + esc(fmtDate(doc.queuedAt) || '?') +
          (ad ? ' &middot; <a href="' + esc(ad) + '" target="_blank" rel="noopener">' +
            'open the advert</a>' : '') +
        '</p>' +
      '</header>' +
      '<div class="oa-rv-grid">' +
        FIELDS.map(function (f, n) {
          var id = idp + '-' + n;
          return '<p class="oa-rv-field' + (f.area || f.list ? ' is-wide' : '') + '">' +
            '<label for="' + id + '">' + esc(f.label) + '</label>' +
            inputFor(f, fieldValue(doc, f.key), id) +
            '</p>';
        }).join('') +
      '</div>' +
      '<p class="oa-rv-actions">' +
        '<button type="button" class="button blue" data-act="approve">Approve &amp; publish</button> ' +
        '<button type="button" class="button" data-act="save">Save edits</button> ' +
        '<button type="button" class="button" data-act="reject">Reject</button>' +
        '<span class="oa-form-msg" data-msg role="status"></span>' +
      '</p>';
  }

  /**
   * Approve the whole queue.
   *
   * WHY THIS EXISTS. The gate is right — nothing from the sheet reaches the
   * site unseen — but the unit of work it created is a season, not a posting:
   * the tracking sheet's "2026 Jobs" tab alone opens with 89 of them. A gate
   * that can only be cleared 89 times is one that does not get cleared, and a
   * queue nobody clears is the same outcome as the bug it was built to
   * prevent: the postings are not on the site.
   *
   * Everything the per-card path does, it does — the maintainer's edits are
   * read off the cards first, so anything corrected and not yet saved is
   * carried in rather than lost — and every posting is on the screen above
   * this button to be read before it is pressed. Writes go one at a time and
   * the failures are counted rather than thrown, so one refused document
   * cannot silently cost the other eighty-eight.
   */
  function approveAll(db, docs, cards) {
    var msg = $('oa-review-bulk-msg');
    var btn = $('oa-review-all');
    var n = docs.length;

    if (!window.confirm('Publish all ' + n + ' postings on this page?\n\n' +
        'They appear on the jobs page in a couple of minutes. You can still take ' +
        'any of them down afterwards from the posting itself.')) return;

    btn.disabled = true;
    msg.className = 'oa-form-msg';
    msg.textContent = 'Publishing 0 of ' + n + '…';

    var done = 0, failed = 0;
    var chain = Promise.resolve();
    docs.forEach(function (doc, i) {
      chain = chain.then(function () {
        var card = cards[i];
        return db.collection(COL).doc(doc.rowId).set({
          edits: card ? readEdits(card, doc) : (doc.edits || {}),
          status: 'approved',
          reviewedAt: new Date().toISOString(),
        }, { merge: true })
          .then(function () {
            done++;
            if (card) {
              card.innerHTML = '<p class="oa-form-msg is-ok">Approved &mdash; ' +
                esc((doc.row || {}).institution || doc.rowId) + '</p>';
            }
          })
          .catch(function () {
            failed++;
            if (card) card.classList.add('is-err');
          })
          .then(function () {
            msg.textContent = 'Publishing ' + (done + failed) + ' of ' + n + '…';
          });
      });
    });

    chain.then(function () {
      msg.className = 'oa-form-msg ' + (failed ? 'is-err' : 'is-ok');
      msg.textContent = failed
        ? done + ' approved, ' + failed + ' could not be saved — reload and try those again.'
        : 'All ' + done + ' approved. They reach the jobs page in a couple of ' +
          'minutes — publishing starts the moment you approve.';
      btn.disabled = !!failed;
    });
  }

  /** The market years present in the queue, newest first. */
  function yearsOf(docs) {
    var seen = {};
    docs.forEach(function (d) { seen[(d.row || {}).year || '?'] = true; });
    return Object.keys(seen).sort().reverse();
  }

  /** 2027 -> "2026-2027", the way the site names a season everywhere else. */
  function marketLabel(y) {
    var n = Number(y);
    return n ? (n - 1) + '-' + n : String(y);
  }

  /**
   * Which market's postings are on screen.
   *
   * The season under way is shown FIRST and by default, because it is the one
   * the jobs page carries: a posting approved from a closed market is correct
   * and lands on Previous markets, which is not what someone clearing this
   * queue in September is trying to do. It also keeps "approve everything
   * here" honest — it approves what the tabs are showing, and never a season
   * nobody has looked at.
   */
  function renderYears(db, all, active) {
    var box = $('oa-review-years');
    if (!box) return;
    var years = yearsOf(all);
    show(box, years.length > 1);
    if (years.length < 2) return;

    box.innerHTML = years.map(function (y) {
      var n = all.filter(function (d) { return String((d.row || {}).year || '?') === y; }).length;
      return '<button type="button" class="oa-tab' + (y === active ? ' is-on' : '') +
        '" data-year="' + esc(y) + '">' + esc(marketLabel(y)) + ' (' + n + ')</button>';
    }).join('') +
      '<button type="button" class="oa-tab' + (active === '*' ? ' is-on' : '') +
        '" data-year="*">All (' + all.length + ')</button>';

    box.onclick = function (e) {
      var b = e.target.closest('button[data-year]');
      if (b) paint(db, all, b.dataset.year);
    };
  }

  function paint(db, all, year) {
    var shownDocs = year === '*' ? all : all.filter(function (d) {
      return String((d.row || {}).year || '?') === year;
    });
    renderYears(db, all, year);
    render(db, shownDocs);
  }

  function render(db, docs) {
    var list = $('oa-review-list');
    var count = $('oa-review-count');
    if (count) {
      count.textContent = docs.length
        ? String(docs.length) + (docs.length === 1 ? ' posting' : ' postings')
        : 'nothing';
    }

    var bulk = $('oa-review-bulk');
    show(bulk, docs.length > 1);
    if (docs.length > 1) {
      var label = bulk.querySelector('[data-n]');
      if (label) label.textContent = String(docs.length);
    }

    if (!docs.length) {
      list.innerHTML = '<p class="oa-hint">Nothing waiting. Postings crawled from ' +
        'the tracking sheet appear here before they go on the site.</p>';
      return;
    }

    list.innerHTML = '';
    var cards = [];
    docs.forEach(function (doc, i) {
      var card = document.createElement('article');
      cards[i] = card;
      card.className = 'oa-fb-card oa-rv-card';
      card.innerHTML = cardHtml(doc, i);

      card.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-act]');
        if (!b) return;
        var act = b.dataset.act;
        var msg = card.querySelector('[data-msg]');
        var edits = readEdits(card, doc);

        var patch = { edits: edits, reviewedAt: new Date().toISOString() };
        if (act === 'approve') patch.status = 'approved';
        if (act === 'reject') patch.status = 'rejected';

        Array.prototype.forEach.call(card.querySelectorAll('button'), function (x) {
          x.disabled = true;
        });
        msg.className = 'oa-form-msg';
        msg.textContent = act === 'save' ? 'Saving…' : 'Sending…';

        db.collection(COL).doc(doc.rowId).set(patch, { merge: true })
          .then(function () {
            if (act === 'save') {
              doc.edits = edits;
              msg.className = 'oa-form-msg is-ok';
              msg.textContent = 'Saved. It stays under review until you approve it.';
              Array.prototype.forEach.call(card.querySelectorAll('button'), function (x) {
                x.disabled = false;
              });
              return;
            }
            /* The card leaves the queue, but the POSTING is not on the site
               until two workflows have run: the sheet read writes the approved
               rows, the build merges them. A Cloud Function starts the first
               the moment this write lands and the second follows it, so that is
               a couple of minutes rather than the best part of an hour — but it
               is not instant, and saying so is the difference between "it
               worked" and the maintainer reloading jobs.html and thinking it
               did not. */
            card.innerHTML = '<p class="oa-form-msg is-ok">' +
              (act === 'approve'
                ? 'Approved. It reaches the jobs page in a couple of minutes — publishing starts now.'
                : 'Rejected. It stays off the site and will not be queued again.') +
              '</p>';
          })
          .catch(function (err) {
            msg.className = 'oa-form-msg is-err';
            msg.textContent = 'Could not save (' + esc(err.code || err.message) + ').';
            Array.prototype.forEach.call(card.querySelectorAll('button'), function (x) {
              x.disabled = false;
            });
          });
      });

      list.appendChild(card);
    });

    var all = $('oa-review-all');
    if (all) {
      all.onclick = function () { approveAll(db, docs, cards); };
    }
  }

  function load(db) {
    var list = $('oa-review-list');
    list.innerHTML = '<p class="oa-hint">Loading…</p>';
    db.collection(COL).where('status', '==', 'pending').get()
      .then(function (snap) {
        var docs = snap.docs.map(function (d) { return d.data(); })
          .filter(function (d) { return d && d.rowId; });
        /* Newest advertisement first — the queue is read as a to-do list, and
           a posting advertised this morning is the one most worth publishing
           today. Sorted here rather than in the query so no composite index is
           needed for a collection this small. */
        docs.sort(function (a, b) {
          return String((b.row || {}).posted || '')
            .localeCompare(String((a.row || {}).posted || ''));
        });
        paint(db, docs, yearsOf(docs)[0] || '*');
      })
      .catch(function (err) {
        list.innerHTML = '<p class="oa-form-msg is-err">Could not load the queue (' +
          esc(err.code || err.message) + '). If this says permission-denied, the ' +
          'rules have not been deployed yet — see _SETUP-FIREBASE.md §4.</p>';
      });
  }

  function boot() {
    if (!window.OAAccounts || !window.OAFB || !$('oa-review')) return;
    OAAccounts.onChange(function () {
      if (!OAAccounts.isAdmin()) { show($('oa-review'), false); return; }
      show($('oa-review'), true);
      OAFB.ready().then(function (fb) { load(fb.firestore()); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
