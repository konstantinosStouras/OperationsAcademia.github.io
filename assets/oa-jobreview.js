/* ---------------------------------------------------------------------------
   Operations Academia — the maintainer's review queue for the tracking sheet.

   Postings crawled from the job market workbook are no longer published on
   sight: they are held in the Firestore `jobReviews` collection until the
   maintainer has looked at them. This draws that queue at the top of the
   feedback page, above the feedback inbox, and lets them correct any field
   before approving.

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

  function render(db, docs) {
    var list = $('oa-review-list');
    var count = $('oa-review-count');
    if (count) {
      count.textContent = docs.length
        ? String(docs.length) + (docs.length === 1 ? ' posting' : ' postings')
        : 'nothing';
    }

    if (!docs.length) {
      list.innerHTML = '<p class="oa-hint">Nothing waiting. Postings crawled from ' +
        'the tracking sheet appear here before they go on the site.</p>';
      return;
    }

    list.innerHTML = '';
    docs.forEach(function (doc, i) {
      var card = document.createElement('article');
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
            /* The card leaves the queue, but the POSTING does not reach the
               site until the next build — up to 20 minutes. Saying so is the
               difference between "it worked" and the maintainer reloading
               jobs.html and thinking it did not. */
            card.innerHTML = '<p class="oa-form-msg is-ok">' +
              (act === 'approve'
                ? 'Approved. It appears on the jobs page at the next build (up to 20 minutes).'
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
        render(db, docs);
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
