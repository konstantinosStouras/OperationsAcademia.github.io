/* ---------------------------------------------------------------------------
   Operations Academia — the maintainer's review queue for the tracking sheet.

   Postings crawled from the job market workbook are no longer published on
   sight: they are held in the Firestore `jobReviews` collection until the
   maintainer has looked at them. This draws that queue at the top of the
   Admin area (admin-area.html — it lived on the feedback page until the
   Admin area gathered every review queue, owner 2026-08-21), above the
   feedback inbox, and lets them correct any field before approving.

   TWO SOURCES, ONE PANEL (owner, 2026-08-23). The crawled queue is only half
   of what "job postings to review" means: postings are also ADDED BY PEOPLE
   through the site's own form, and those are live within a minute because the
   form promises as much. So the panel splits into two tabs — "Auto-crawled
   jobs", the tracking sheet's gate, and "User-added jobs", the form's own
   postings listed until they are marked reviewed. The user tab reads the SAME
   documents, LIVE statuses and reviewedAt stamp as
   _scraper/submissions-review.mjs (the model behind the mailer that announces
   them), so this panel and the e-mails cannot disagree about what is waiting.
   Inside each tab the market-year tabs still filter, and every list ranks the
   NEXT market's postings first.

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

  /* The user-added half: postings made through the site's own form. Keep the
     three names in step with _scraper/submissions-review.mjs — the model
     behind the mailer that announces the same documents; selftest.mjs pins
     the pairing. */
  var SUBS_COL = 'jobSubmissions';
  var EDIT_PATH = 'post-a-job.html?edit=';
  /* The stamp the submissions model names (REVIEWED_AT there): ticking a card
     off writes this one field onto the submission itself, so a posting marked
     reviewed here is marked reviewed for the mailer too — and nothing here
     ever writes the mailer's own high-water mark (announcedAt). */
  var REVIEWED_AT = 'reviewedAt';
  /* The statuses a submission is LIVE in — the pair every build reads. A
     withdrawn, hidden or removed one is not waiting for anything, and `sheet`
     is a tracking-sheet mirror, whose row is the crawled tab's own. */
  var LIVE = ['queued', 'published'];

  /* The fields offered, in the order they are shown — THE POSTING FORM'S OWN
     QUESTIONS, in the posting form's own words, because they are the same
     questions about the same posting and a maintainer reading a card should
     recognise what the poster answered.

     A SUBSET of what a posting holds: id, market year, posted date and source
     are its identity and its bookkeeping — editing them would detach the
     posting from the sheet row it came from, so the next sync would queue it
     again as new. Those are corrected in the workbook.

     TWO THINGS THIS LIST USED TO GET WRONG, and both of them were invisible:

     * it offered `department` — the LINE the card shows, which is the school
       and the department joined — beside the two names it is made of. Four
       boxes for a place that has three, and nothing kept them in step: a
       corrected school published a row whose line still said what the workbook
       had said, and `selftest.mjs` asserts over the served file that the line
       equals its two parts joined. A red selftest stops the build committing
       anything at all, so one corrected school would have stopped the whole
       site publishing. It is DERIVED now (`applyEdits` in
       _scraper/jobreview.mjs), shown under the two boxes as a preview, and no
       longer offered;
     * it offered "Associate Professor" and "Full Professor", which are not
       entry levels the site HAS. `LEVELS` in _scraper/jobs-model.mjs is the
       five below, and `cleanEdit` drops anything else — so ticking either of
       those saved a box that then silently did nothing. The site's own name
       for that rank is "Other Ranks", and the label is the posting form's.

     Keep in step with EDITABLE in _scraper/jobreview.mjs and with the key list
     in _firestore.rules; selftest.mjs pins the three together, and pins these
     option lists against LEVELS and TYPES. */
  var FIELDS = [
    { key: 'institution', label: 'University / Institution', max: 220, place: 'institution' },
    { key: 'type', label: 'Type of institution', max: 40,
      options: ['', 'Business School', 'University'] },
    { key: 'school', label: 'School, faculty or college', max: 200, place: 'school' },
    { key: 'unit', label: 'Department, area or group', max: 200, place: 'unit' },
    { key: 'levels', label: 'Entry level', list: true, options: [
      { v: 'Assistant Professor' },
      { v: 'Other Ranks', label: 'Other Ranks (Associate, Full, Chaired)' },
      { v: 'Post-Doc' },
      { v: 'Non-tenure track (teaching) position' },
      { v: 'Visiting Faculty (various levels)' }] },
    { key: 'country', label: 'Country', max: 80 },
    { key: 'applyByDate', label: 'Closing date', max: 10, type: 'date' },
    { key: 'comments', label: 'Comments', max: 1500, area: true },
    { key: 'adUrl', label: 'Link to the advert', max: 600 },
    { key: 'postedAtUrl', label: 'Posted at', max: 600 },
    { key: 'furtherInfoUrl', label: 'Further info', max: 600 }
  ];

  /** The line the card publishes: the school and the department joined. ONE
      definition of that join lives in _scraper/vocab.mjs and this is its
      browser twin — it only ever previews what applyEdits will derive. */
  function joinDepartment(school, unit) {
    return [String(school || '').trim(), String(unit || '').trim()]
      .filter(Boolean).join(', ');
  }

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
      /* The VALUE is what the site stores and the LABEL is what a reader is
         asked — they differ for one rank, exactly as on the posting form:
         "Other Ranks" covers Associate, Full and Chaired, and a tick box that
         said only "Other Ranks" would leave the maintainer guessing which of
         the three it meant. */
      return '<div class="oa-rv-levels">' + f.options.map(function (o, i) {
        var val = typeof o === 'string' ? o : o.v;
        var text = (typeof o === 'string' ? '' : o.label) || val;
        return '<label class="oa-rv-check"><input type="checkbox" data-key="' + f.key +
          '" id="' + id + '-' + i + '" value="' + esc(val) + '"' +
          (chosen.indexOf(val) >= 0 ? ' checked' : '') + '> ' + esc(text) + '</label>';
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

  /* Where a flagged duplicate came from, in the maintainer's own words. */
  var DUP_SOURCE = {
    'oa-form': 'posted through the site',
    'sheet-import': 'from the legacy import',
    'jobmarket-sheet': 'from the tracking sheet'
  };

  /**
   * The possible duplicates the sheet sync found for this row — postings
   * ALREADY ON THE SITE that look like the same job. Computed offline
   * (duplicatesOf in _scraper/jobreview.mjs) and stored on the document as
   * `dup`; this only draws it. A warning, never a decision: Approve still
   * publishes beside the existing posting, Reject keeps the crawled copy off.
   */
  function dupHtml(dups) {
    var items = dups.map(function (d) {
      var name = [d.institution, d.department].filter(Boolean).join(' — ');
      var jobsUrl = '/jobs?institution=' + encodeURIComponent(d.institution || '');
      return '<li>' + esc(name || d.id) +
        (d.posted ? ' <span class="oa-hint" style="display:inline">(posted ' +
          esc(d.posted) + (DUP_SOURCE[d.source] ? ', ' + esc(DUP_SOURCE[d.source]) : '') +
          ')</span>' : '') +
        ' &middot; <a href="' + esc(jobsUrl) + '" target="_blank" rel="noopener">see it live</a>' +
        '</li>';
    }).join('');
    return '<div class="oa-note is-warn" data-dup>' +
      '<strong>&#9888; Possibly already on the site.</strong> This crawled posting ' +
      'looks like ' + (dups.length === 1 ? 'a job that is' : dups.length + ' jobs that are') +
      ' already published:' +
      '<ul style="margin:6px 0 4px;padding-left:20px">' + items + '</ul>' +
      'If it is the same job, <strong>Reject</strong> keeps this copy off the site; ' +
      'if it is a different one, <strong>Approve</strong> publishes it as usual.' +
      '</div>';
  }

  /**
   * The business-school flag the sheet sync computed (owner, 2026-08-23):
   * the crawled posting's text mentions "business", so it arrived typed
   * Business School — and the site's own directory is asked which school
   * that IS at this university. Computed offline (businessCheck in
   * _scraper/jobreview.mjs, from the same vocab.json the cascade reads) and
   * stored on the document as `biz`; this only draws it. A MENTION, never a
   * decision: the "Use it" button fills the School box for the maintainer to
   * read back, and nothing is saved until they press Save or Approve.
   */
  function bizHtml(biz) {
    var school = String((biz && biz.school) || '');
    return '<div class="oa-note" data-biz>' +
      '<strong>&#127891; Business school posting.</strong> The posting\'s text ' +
      'mentions the business school, so its Type arrived as ' +
      '<strong>Business School</strong>. ' +
      (school
        ? 'The site\'s directory lists <strong>' + esc(school) + '</strong> as this ' +
          'university\'s business school. ' +
          '<button type="button" class="button" data-biz-use="' + esc(school) + '"' +
          ' style="margin-left:6px">Use it as the School</button>'
        : 'The site\'s directory does not list a business school for this ' +
          'university &mdash; if you know it, type it into the School box below.') +
      '</div>';
  }

  /**
   * What the posting's own advertisement says — read off the linked page by
   * adverts-verify.mjs (or higheredjobs-verify's parser for that host) and
   * stored on the document as `ad`; this only draws it. RAISED, never
   * decided, like `dup` and `biz`: the button fills the Closing-date box for
   * the maintainer to read back, and nothing is saved until Save or Approve.
   * `listedUntil` is shown labelled as what it is — when the LISTING comes
   * down, which on a job board can sit eighteen months past the real
   * deadline (the validThrough lesson) — and is deliberately given no
   * button.
   */
  function advertHtml(ad, row) {
    var gone = ad.status === 'gone';
    var bits = [];

    if (ad.title || ad.institution) {
      bits.push('It advertises <strong>' + esc(ad.title || 'an unnamed position') +
        '</strong>' + (ad.institution ? ' at ' + esc(ad.institution) : '') +
        (ad.location ? ' (' + esc(ad.location) + ')' : '') + '.');
    }
    if (ad.applyByDate) {
      var same = String((row && row.applyByDate) || '') === ad.applyByDate;
      bits.push('It closes on <strong>' + esc(ad.applyByDate) + '</strong>' +
        (same
          ? ', which the posting already carries.'
          : '. <button type="button" class="button" data-ad-use="' + esc(ad.applyByDate) +
            '" style="margin-left:6px">Use this closing date</button>'));
    } else if (ad.applyByProse) {
      bits.push('About its deadline it says: &ldquo;' + esc(ad.applyByProse) + '&rdquo;');
    }
    if (ad.listedUntil) {
      bits.push('<span class="oa-hint" style="display:inline">The board lists the ' +
        'advertisement until ' + esc(ad.listedUntil) + ' &mdash; that is when the ' +
        'AD comes down, not necessarily the application deadline.</span>');
    }
    if (!gone && !bits.length) return '';

    return '<div class="oa-note' + (gone ? ' is-warn' : '') + '" data-advert>' +
      '<strong>&#128196; What the advertisement says.</strong> ' +
      (gone ? 'The linked advertisement is <strong>no longer up</strong>' +
        (bits.length ? ' &mdash; what follows is what it said while it was. ' : '. ') : '') +
      bits.join(' ') +
      (ad.checkedAt ? ' <span class="oa-hint" style="display:inline">(read ' +
        esc(String(ad.checkedAt).slice(0, 10)) + ')</span>' : '') +
      '</div>';
  }

  function cardHtml(doc, i) {
    var row = doc.row || {};
    var ad = safeHref(fieldValue(doc, 'adUrl'));
    var idp = 'rv' + i;
    var dups = Array.isArray(doc.dup) ? doc.dup : [];

    /* The heading reads the posting as it WOULD BE PUBLISHED — the row with
       any edit already made on top — not the raw workbook row. It used to read
       `row.department` directly, so a card whose school had just been
       corrected still carried the old line above the boxes that had corrected
       it. */
    var line = joinDepartment(fieldValue(doc, 'school'), fieldValue(doc, 'unit'))
      || fieldValue(doc, 'department') || '';

    return '<header>' +
        '<strong>' + esc(fieldValue(doc, 'institution') || row.id || 'Untitled posting') + '</strong>' +
        (line ? ' <span class="oa-hint" style="display:inline">— ' +
          esc(line) + '</span>' : '') +
        '<span class="oa-fb-status is-open">under review</span>' +
        '<p class="oa-hint">Advertised ' + esc(row.posted || '?') +
          ' &middot; market ' + esc(String(row.year || '?')) +
          ' &middot; queued ' + esc(fmtDate(doc.queuedAt) || '?') +
          (ad ? ' &middot; <a href="' + esc(ad) + '" target="_blank" rel="noopener">' +
            'open the advert</a>' : '') +
        '</p>' +
      '</header>' +
      (dups.length ? dupHtml(dups) : '') +
      (doc.biz ? bizHtml(doc.biz) : '') +
      (doc.ad ? advertHtml(doc.ad, row) : '') +
      '<div class="oa-rv-grid">' +
        FIELDS.map(function (f, n) {
          var id = idp + '-' + n;
          return '<p class="oa-rv-field' + (f.area || f.list ? ' is-wide' : '') + '">' +
            '<label for="' + id + '">' + esc(f.label) + '</label>' +
            inputFor(f, fieldValue(doc, f.key), id) +
            /* What the boxes above will actually PUBLISH. Two lines on a
               posting are derived rather than typed — the school and the
               department joined, and the closing date written out — and the
               card shows the line, not its parts, so the maintainer has to be
               able to read back what they are approving. The posting form
               shows the poster the same thing (`#f-department-preview`). */
            (f.place === 'unit' || f.key === 'applyByDate'
              ? '<span class="oa-hint oa-rv-derived" aria-live="polite" data-derived="'
                + (f.key === 'applyByDate' ? 'deadline' : 'place') + '"></span>'
              : '') +
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
            retire(db, 'crawled', doc);
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

  /* ---------------------------------------------------- the two source tabs */

  /* Which tab holds which postings, and how to read each shape: the crawled
     tab holds `jobReviews` documents (the sheet's row under `doc.row`), the
     user tab `{ id, data }` pairs straight from `jobSubmissions`. */
  var SOURCES = {
    crawled: {
      name: 'Auto-crawled jobs',
      yearOf: function (d) { return String((d.row || {}).year || '?'); },
      postedOf: function (d) { return String((d.row || {}).posted || ''); }
    },
    user: {
      name: 'User-added jobs',
      yearOf: function (d) { return String((d.data || {}).year || '?'); },
      postedOf: function (d) { return fmtDate((d.data || {}).createdAt); }
    }
  };

  /* What load() fetched, split by source, and which tab and season are on
     screen — kept so a decision can refresh the tab counts without re-reading
     anything. */
  var state = { crawled: [], user: [], userError: false, source: 'crawled', year: '*' };

  /** THE NEXT MARKET LEADS (owner, 2026-08-23): 2028's postings before 2027's
      before 2026's, and within a market the newest advertisement first — the
      queue is read as a to-do list, and the market a posting is FOR is the one
      its review is urgent for. An unknown year sorts last. */
  function rankBy(s) {
    return function (a, b) {
      return ((Number(s.yearOf(b)) || 0) - (Number(s.yearOf(a)) || 0))
        || s.postedOf(b).localeCompare(s.postedOf(a));
    };
  }

  /** The market years present in a tab, the next market first ('?' last). */
  function yearsOf(docs, s) {
    var seen = {};
    docs.forEach(function (d) { seen[s.yearOf(d)] = true; });
    return Object.keys(seen).sort(function (a, b) {
      return (Number(b) || 0) - (Number(a) || 0);
    });
  }

  /** 2027 -> "2026-2027", the way the site names a season everywhere else. */
  function marketLabel(y) {
    var n = Number(y);
    return n ? (n - 1) + '-' + n : String(y);
  }

  /**
   * The two source tabs: the tracking sheet's gate and the form's own
   * postings. Always drawn once the queue has loaded — a tab reading (0)
   * says "nothing from this source", where a tab that vanished would leave
   * the maintainer wondering where the user-added postings went.
   */
  function renderSources(db, active) {
    var box = $('oa-review-sources');
    if (!box) return;
    show(box, true);
    box.innerHTML = Object.keys(SOURCES).map(function (k) {
      return '<button type="button" class="oa-tab' + (k === active ? ' is-on' : '') +
        '" data-source="' + k + '">' + esc(SOURCES[k].name) +
        ' (' + state[k].length + ')</button>';
    }).join('');
    box.onclick = function (e) {
      var b = e.target.closest('button[data-source]');
      if (b && b.dataset.source !== state.source) paint(db, b.dataset.source, null);
    };
  }

  /**
   * Which market's postings are on screen, within the active source tab.
   *
   * The season under way is shown FIRST and by default, because it is the one
   * the jobs page carries: a posting approved from a closed market is correct
   * and lands on Previous markets, which is not what someone clearing this
   * queue in September is trying to do. It also keeps "approve everything
   * here" honest — it approves what the tabs are showing, and never a season
   * nobody has looked at.
   */
  function renderYears(db, all, active, s) {
    var box = $('oa-review-years');
    if (!box) return;
    var years = yearsOf(all, s);
    show(box, years.length > 1);
    if (years.length < 2) return;

    box.innerHTML = years.map(function (y) {
      var n = all.filter(function (d) { return s.yearOf(d) === y; }).length;
      return '<button type="button" class="oa-tab' + (y === active ? ' is-on' : '') +
        '" data-year="' + esc(y) + '">' + esc(marketLabel(y)) + ' (' + n + ')</button>';
    }).join('') +
      '<button type="button" class="oa-tab' + (active === '*' ? ' is-on' : '') +
        '" data-year="*">All (' + all.length + ')</button>';

    box.onclick = function (e) {
      var b = e.target.closest('button[data-year]');
      if (b) paint(db, state.source, b.dataset.year);
    };
  }

  /** One pass over what is on screen: the source tab, its seasons, the list.
      A null year means the tab's own default — the newest market present. */
  function paint(db, source, year) {
    var s = SOURCES[source];
    var all = state[source];
    if (year == null) year = yearsOf(all, s)[0] || '*';
    state.source = source;
    state.year = year;
    var shownDocs = year === '*' ? all : all.filter(function (d) {
      return s.yearOf(d) === year;
    });
    renderSources(db, source);
    renderYears(db, all, year, s);
    render(db, shownDocs, source);
  }

  /** A card the maintainer has dealt with leaves its tab's counts, so the two
      tab rows stay honest without re-reading anything; the card itself keeps
      showing its confirmation where it stands. */
  function retire(db, source, item) {
    var i = state[source].indexOf(item);
    if (i >= 0) state[source].splice(i, 1);
    renderSources(db, state.source);
    renderYears(db, state[state.source], state.year, SOURCES[state.source]);
  }

  /* The cascades mounted on the cards currently drawn.

     THEY HAVE TO BE GIVEN BACK. Every picker adds a listener to `document` —
     the only way to notice a click landing outside its own list — and the year
     tabs redraw the whole queue, up to three per card. Left alone, each pass
     would leave a card's worth of listeners behind holding a detached card and
     the whole vocabulary. Nothing else on this site mounts a picker into
     markup it later throws away, which is why OACombo grew a destroy() for
     this. */
  var mounted = [];

  function unmountPickers() {
    mounted.forEach(function (m) { if (m && m.destroy) m.destroy(); });
    mounted = [];
  }

  /**
   * Give one card's three name boxes the site's own cascade: choosing the
   * university narrows the school list to that university's schools, choosing
   * a school narrows the department list to its departments, a department the
   * site has only ever seen in one school fills that school in, and each name
   * is put into the spelling the site publishes as the field is left.
   *
   * The SAME module the posting form mounts (assets/oa-place-picker.js), which
   * is the point: the maintainer correcting a posting and the poster making
   * one are answering the same three questions, and two implementations would
   * have drifted. It is entirely optional — without the picker scripts the
   * boxes stay ordinary text inputs and everything else on the card works.
   */
  function wirePlace(card) {
    var box = function (key) { return card.querySelector('[data-key="' + key + '"]'); };
    var inst = box('institution'), school = box('school'), unit = box('unit');
    var derived = card.querySelector('[data-derived="place"]');
    if (!inst || !school || !unit) return;

    function preview() {
      if (!derived) return;
      var line = joinDepartment(school.value, unit.value);
      derived.textContent = line ? 'Published as: ' + line : '';
    }
    school.addEventListener('input', preview);
    unit.addEventListener('input', preview);
    preview();

    if (!window.OAPlacePicker) return;
    var handle = OAPlacePicker.wire(
      { institution: inst, school: school, unit: unit }, { onChange: preview });
    if (handle) mounted.push(handle);
  }

  /**
   * The closing date, and the line the card will show for it.
   *
   * The browser twin of `settleDeadline` in _scraper/jobreview.mjs, and it only
   * ever PREVIEWS what that function will derive — the card used to offer a box
   * for the line as well, which let one posting reach the site with a closing
   * date and no line at all and stopped the whole site publishing.
   */
  function wireDeadline(card) {
    var date = card.querySelector('[data-key="applyByDate"]');
    var derived = card.querySelector('[data-derived="deadline"]');
    if (!date || !derived) return;

    function preview() {
      var v = String(date.value || '').trim();
      derived.textContent = 'Published as: ' + (v ? longDate(v) : 'Until filled.');
    }
    date.addEventListener('input', preview);
    date.addEventListener('change', preview);
    preview();
  }

  /** "2026-10-05" as the card writes it. The browser twin of `longDate` in
      _scraper/jobs-model.mjs — same month names, same shape, and built from
      the date's own parts so a timezone can never move it a day. */
  function longDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return '';
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    var name = MONTHS[+m[2] - 1];
    return name ? name + ' ' + (+m[3]) + ', ' + m[1] : '';
  }

  /* ------------------------------------------------- the user-added cards */

  /**
   * A posting made through the site's own form. It is ALREADY LIVE — the form
   * promises "within a few minutes" and keeps it — so this card is a to-do
   * item, not a gate: Open & correct opens the poster's own form (the rules
   * let the admin save any document), and Mark reviewed writes the one stamp
   * that takes it off the list and changes nothing else.
   */
  function userCardHtml(it) {
    var d = it.data || {};
    var line = joinDepartment(d.school, d.unit) || d.department || '';
    var ad = safeHref(d.adUrl);
    return '<header>' +
        '<strong>' + esc(d.institution || 'Untitled posting') + '</strong>' +
        (line ? ' <span class="oa-hint" style="display:inline">&mdash; ' +
          esc(line) + '</span>' : '') +
        '<span class="oa-fb-status is-closed">live</span>' +
        '<p class="oa-hint">Posted ' + esc(fmtDate(d.createdAt) || '?') +
          ' &middot; market ' + esc(marketLabel(String(d.year || '?'))) +
          (d.ref ? ' &middot; ' + esc(d.ref) : '') +
          (ad ? ' &middot; <a href="' + esc(ad) + '" target="_blank" rel="noopener">' +
            'open the advert</a>' : '') +
        '</p>' +
      '</header>' +
      '<table class="oa-sub-lines">' +
        [['Entry level', (d.levels || []).join(', ')],
         ['Country', d.country],
         ['Apply by', d.applyByDate || d.applyByNote]]
          .filter(function (l) { return l[1]; })
          .map(function (l) {
            return '<tr><th>' + esc(l[0]) + '</th><td>' + esc(l[1]) + '</td></tr>';
          }).join('') +
      '</table>' +
      '<p class="oa-rv-actions">' +
        '<a class="button blue" href="' + EDIT_PATH + encodeURIComponent(it.id) +
          '">Open &amp; correct</a> ' +
        '<button type="button" class="button" data-act="reviewed">Mark reviewed</button>' +
        '<span class="oa-form-msg" data-msg role="status"></span>' +
      '</p>';
  }

  function renderUserCards(db, items) {
    var list = $('oa-review-list');
    items.forEach(function (it) {
      var card = document.createElement('article');
      card.className = 'oa-fb-card oa-rv-card';
      card.innerHTML = userCardHtml(it);

      card.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-act="reviewed"]');
        if (!b) return;
        var msg = card.querySelector('[data-msg]');
        b.disabled = true;
        msg.className = 'oa-form-msg';
        msg.textContent = 'Saving…';

        var patch = {};
        patch[REVIEWED_AT] = new Date().toISOString();
        db.collection(SUBS_COL).doc(it.id).set(patch, { merge: true })
          .then(function () {
            card.innerHTML = '<p class="oa-form-msg is-ok">Marked reviewed &mdash; ' +
              esc((it.data || {}).institution || it.id) + '. It stays live; this ' +
              'only takes it off the list.</p>';
            retire(db, 'user', it);
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

  function render(db, docs, source) {
    var list = $('oa-review-list');
    var count = $('oa-review-count');
    if (count) {
      count.textContent = docs.length
        ? String(docs.length) + (docs.length === 1 ? ' posting' : ' postings')
        : 'nothing';
    }

    /* Approve-the-page belongs to the GATE alone: a user-added posting is
       already live, so there is nothing on its tab to approve. */
    var bulk = $('oa-review-bulk');
    var bulkOn = source === 'crawled' && docs.length > 1;
    show(bulk, bulkOn);
    if (bulkOn) {
      var label = bulk.querySelector('[data-n]');
      if (label) label.textContent = String(docs.length);
    }

    unmountPickers();

    if (!docs.length) {
      list.innerHTML = source === 'user'
        ? (state.userError
          ? '<p class="oa-form-msg is-err">Could not load the postings made ' +
            'through the site &mdash; reload to try again.</p>'
          : '<p class="oa-hint">Nothing waiting. Job postings made through the ' +
            'site&rsquo;s own form appear here until you mark them reviewed ' +
            '&mdash; they are already live.</p>')
        : '<p class="oa-hint">Nothing waiting. Postings crawled from ' +
          'the tracking sheet appear here before they go on the site.</p>';
      return;
    }

    list.innerHTML = '';
    if (source === 'user') { renderUserCards(db, docs); return; }
    var cards = [];
    docs.forEach(function (doc, i) {
      var card = document.createElement('article');
      cards[i] = card;
      card.className = 'oa-fb-card oa-rv-card';
      card.innerHTML = cardHtml(doc, i);

      card.addEventListener('click', function (e) {
        /* The business-school note's "Use it": fill the School box with the
           directory's name, exactly as typing it would — an input event so
           the derived-line preview (and the picker, where mounted) follow.
           Nothing is written until Save or Approve, like any other edit. */
        var use = e.target.closest('button[data-biz-use]');
        if (use) {
          var schoolBox = card.querySelector('[data-key="school"]');
          if (schoolBox) {
            schoolBox.value = use.getAttribute('data-biz-use') || '';
            schoolBox.dispatchEvent(new Event('input', { bubbles: true }));
            schoolBox.focus();
          }
          return;
        }

        /* The advertisement note's "Use this closing date": fill the
           Closing-date box with the date the ad states, exactly as typing it
           would — the input event makes the derived "Apply by" preview
           follow. Nothing is written until Save or Approve, like any other
           edit. */
        var adUse = e.target.closest('button[data-ad-use]');
        if (adUse) {
          var dateBox = card.querySelector('[data-key="applyByDate"]');
          if (dateBox) {
            dateBox.value = adUse.getAttribute('data-ad-use') || '';
            dateBox.dispatchEvent(new Event('input', { bubbles: true }));
            dateBox.focus();
          }
          return;
        }

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
            retire(db, 'crawled', doc);
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
      /* After the card is IN the document: the picker wraps the input in place
         and measures where its list will fit. */
      wirePlace(card);
      wireDeadline(card);
    });

    var all = $('oa-review-all');
    if (all) {
      all.onclick = function () { approveAll(db, docs, cards); };
    }
  }

  function load(db) {
    var list = $('oa-review-list');
    list.innerHTML = '<p class="oa-hint">Loading…</p>';

    /* The crawled queue: the pending documents, i.e. the gate. */
    var crawled = db.collection(COL).where('status', '==', 'pending').get()
      .then(function (snap) {
        return snap.docs.map(function (d) { return d.data(); })
          .filter(function (d) { return d && d.rowId; });
      });

    /* The user-added postings: live and not yet ticked off — the same rule as
       _scraper/submissions-review.mjs's isWaiting. Two equality reads rather
       than one `in` query, one per LIVE status: the smallest query shape, and
       nothing here needs a composite index. A refused read degrades to an
       error state on ITS tab alone, so it can never take the gate down with
       it. */
    var user = Promise.all(LIVE.map(function (status) {
      return db.collection(SUBS_COL).where('status', '==', status).get();
    })).then(function (snaps) {
      var items = [];
      snaps.forEach(function (snap) {
        snap.docs.forEach(function (d) {
          var v = d.data() || {};
          if (!v[REVIEWED_AT]) items.push({ id: d.id, data: v });
        });
      });
      return items;
    }).catch(function () { return null; });

    Promise.all([crawled, user])
      .then(function (r) {
        /* Sorted here rather than in the query so no composite index is
           needed for collections this small; the comparator is rankBy's
           next-market-first, newest-advertisement-within-it. */
        state.crawled = r[0].sort(rankBy(SOURCES.crawled));
        state.userError = r[1] === null;
        state.user = (r[1] || []).sort(rankBy(SOURCES.user));
        paint(db, 'crawled', null);
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
