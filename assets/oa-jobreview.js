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

   ONE OF THE TWO IS A GATE AND THE OTHER IS NOT, AND EVERYTHING AROUND THEM
   NOW SAYS SO (owner, 2026-09-17, of a posting made through the form minutes
   earlier: "their posting becomes live immediately. It is also flagged to me
   to approve it later on"). Both halves of that sentence were true, and the
   second read as a contradiction of the first — because the FRAME called the
   user-added tab a review queue even though the tab never did. The panel was
   headed "Job postings to review", the summary tile said the same, and the
   "Admin area N" badge counted these live postings beside the ones genuinely
   held back, so the site told the maintainer something was waiting on them
   when nothing was. The cards were already honest: a LIVE pill, no Approve
   button anywhere on this tab (pinned), and a Mark-reviewed stamp that writes
   one date and changes nothing else. So what moved is the wording and the
   count — the panel is headed "Job postings", each tab is named for what it
   is, and waitingJobs in assets/oa-adminarea.js counts the gate alone.
   NOTHING ABOUT WHEN A POSTING GOES LIVE CHANGED, and nothing here may start
   holding one back: the form promises "within a few minutes", the build keeps
   it, and the poster is e-mailed to say the posting is public.

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
  var EDIT_PATH = 'post-a-job?edit=';
  /* The stamp the submissions model names (REVIEWED_AT there): ticking a card
     off writes this one field onto the submission itself, so a posting marked
     reviewed here is marked reviewed for the mailer too — and nothing here
     ever writes the mailer's own high-water mark (announcedAt). */
  var REVIEWED_AT = 'reviewedAt';
  /* The statuses a submission is LIVE in — the pair every build reads. A
     withdrawn, hidden or removed one is not waiting for anything, and `sheet`
     is a tracking-sheet mirror, whose row is the crawled tab's own. */
  var LIVE = ['queued', 'published'];
  /* A POSTING IS TAKEN DOWN, NEVER DELETED (owner, 2026-09-17: "allow the
     admin to delete a job in the queue for review. Currently, we can remove
     only jobs that are live listed"). The removal the site already had is the
     Take-down control on the live listings (assets/oa-jobedit.js), and it is
     a STATUS CHANGE for the reason build-jobs.mjs states in as many words:
     deleting the document would leave the published row ORPHANED, carried on
     by every build with nothing on the site able to correct or remove it, the
     maintainer included. So this tab writes the same two words that file
     writes, and the word says WHO did it — `hidden` is the maintainer's own
     take-down, `withdrawn` the poster withdrawing their own. */
  var HIDDEN = 'hidden';
  /* …and putting one back is the status the form itself saves: post-a-job
     writes `queued` on every edit it stores, and the build publishes `queued`
     and `published`. */
  var RESTORED = 'queued';

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
       position types the site HAS. `LEVELS` in _scraper/jobs-model.mjs is the
       list below (seven since 2026-09-23, when "RA or Pre-doc" and "PhD"
       joined it at the end, and the question was relabelled from "Entry
       level" to "Position type"), and `cleanEdit` drops anything else — so
       ticking either of those saved a box that then silently did nothing.
       The site's own name for that rank is "Other Ranks", and the label is
       the posting form's.

     Keep in step with EDITABLE in _scraper/jobreview.mjs and with the key list
     in _firestore.rules; selftest.mjs pins the three together, and pins these
     option lists against LEVELS and TYPES. */
  var FIELDS = [
    { key: 'institution', label: 'University / Institution', max: 220, place: 'institution' },
    { key: 'type', label: 'School type', max: 40,
      options: ['', 'Business School', 'University'] },
    { key: 'school', label: 'School, faculty or college', max: 200, place: 'school' },
    { key: 'unit', label: 'Department, area or group', max: 200, place: 'unit' },
    { key: 'levels', label: 'Position type', list: true, options: [
      { v: 'Assistant Professor' },
      { v: 'Other Ranks', label: 'Other Ranks (Associate, Full, Chaired)' },
      { v: 'Post-Doc' },
      { v: 'Non-tenure track (teaching) position' },
      { v: 'Visiting Faculty (various levels)' },
      { v: 'RA or Pre-doc' },
      { v: 'PhD' }] },
    { key: 'country', label: 'Country', max: 80 },
    { key: 'applyByDate', label: 'Closing date', max: 10, type: 'date' },
    { key: 'reviewDate', label: 'Suggested apply by', max: 10, type: 'date' },
    { key: 'comments', label: 'Comments', max: 1500, area: true },
    { key: 'adUrl', label: 'Link to the advert', max: 600 },
    { key: 'postedAtUrl', label: 'Posted at', max: 600 },
    { key: 'furtherInfoUrl', label: 'Further info', max: 600 }
  ];

  /** The line the card publishes: the school and the department joined. ONE
      definition of that join lives in _scraper/vocab.mjs and this is its
      browser twin — it only ever previews what applyEdits will derive.
      A school that repeats the institution's name is dropped from it, as
      settlePlace's canonColumns() drops it on save (oa-schools.js
      schoolRepeatsInstitution): the maintainer's preview must not read
      "INSEAD, Decision Sciences" under INSEAD when the site will publish
      "Decision Sciences". Without the institution it joins as it always did. */
  function joinDepartment(school, unit, institution) {
    var S = window.OASchools;
    var s = String(school || '').trim();
    if (s && institution && S && S.schoolRepeatsInstitution &&
        S.schoolRepeatsInstitution(s, institution)) s = '';
    return [s, String(unit || '').trim()].filter(Boolean).join(', ');
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
    'jobmarket-sheet': 'from the tracking sheet',
    'poms-opportunities': 'from the POMS job postings page'
  };

  /* Which crawler a queued row came down, for the card's own header line.
     Keep in step with CRAWLER_SOURCES in _scraper/jobs-model.mjs; a source
     this map does not know draws nothing rather than a guess. */
  var CRAWLED_FROM = {
    'jobmarket-sheet': 'the tracking sheet',
    'poms-opportunities': 'the POMS job postings page'
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
      /* WHICH PAGE, and the posting itself. This was
         `/jobs?institution=<name>`, and both halves of it were wrong: a
         flagged duplicate is by definition of the crawled row's own market
         year, which is routinely a season the jobs page cannot show, so the
         link opened a list that by construction could not hold the posting;
         and even where it could, it opened a search rather than the card. The
         site has one answer to both — OAJobNav.hrefFor, the module that owns
         `inCurrentMarket` and the `?job=` permalink, which is why `dupEntry`
         now carries the season and the closing date it reads. Without the
         module the name is drawn with NO link: a link that is right most of
         the time is the worst shape for one. */
      /* A posting still UNDER REVIEW (the POMS crawler names the queue's own
         pending rows, since the two crawlers see one advertisement days
         apart) is nowhere on the site to link to, so it says so and links
         nothing. */
      var nav = window.OAJobNav;
      var href = (nav && nav.hrefFor && !d.pending) ? nav.hrefFor(d) : '';
      return '<li>' + esc(name || d.id) +
        (d.posted ? ' <span class="oa-hint" style="display:inline">(posted ' +
          esc(d.posted) + (DUP_SOURCE[d.source] ? ', ' + esc(DUP_SOURCE[d.source]) : '') +
          (d.pending ? ', still under review' : '') +
          ')</span>' : '') +
        (href
          ? ' &middot; <a href="' + esc(href) + '" target="_blank" rel="noopener">see it live</a>'
          : '') +
        '</li>';
    }).join('');
    var anyPending = dups.some(function (d) { return d.pending; });
    return '<div class="oa-note is-warn" data-dup>' +
      '<strong>&#9888; Possibly already on the site.</strong> This crawled posting ' +
      'looks like ' + (dups.length === 1 ? 'a job that is' : dups.length + ' jobs that are') +
      (anyPending ? ' already published or under review:' : ' already published:') +
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

    /* WHERE the page files the post — classified against the site's own
       vocabulary where that answered (`advertPlace` in _scraper/adverts.mjs:
       a hiring organisation that is really a school is filed under its
       university, the names canonicalised, an empty school settled from the
       directory by its department), otherwise the page's own words. One
       button adopts the classified names into the three boxes; the stated
       names get a button each. Nothing is saved until Save or Approve. */
    var place = ad.place || null;
    if (place && (place.institution || place.school || place.unit)) {
      var named = [place.institution, place.school, place.unit].filter(Boolean);
      bits.push('The site\'s vocabulary files it as <strong>' + esc(named.join(' — ')) +
        '</strong>. <button type="button" class="button" data-ad-place' +
        (place.institution ? ' data-ad-inst="' + esc(place.institution) + '"' : '') +
        (place.school ? ' data-ad-school="' + esc(place.school) + '"' : '') +
        (place.unit ? ' data-ad-unit="' + esc(place.unit) + '"' : '') +
        ' style="margin-left:6px">Use these names</button>');
    } else if (ad.school || ad.department) {
      bits.push('The page files it under <strong>' +
        esc([ad.school, ad.department].filter(Boolean).join(', ')) + '</strong>.' +
        (ad.school ? ' <button type="button" class="button" data-ad-use-school="' +
          esc(ad.school) + '" style="margin-left:6px">Use as the School</button>' : '') +
        (ad.department ? ' <button type="button" class="button" data-ad-use-unit="' +
          esc(ad.department) + '" style="margin-left:6px">Use as the Department</button>' : ''));
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
    var line = joinDepartment(fieldValue(doc, 'school'), fieldValue(doc, 'unit'),
      fieldValue(doc, 'institution')) || fieldValue(doc, 'department') || '';

    return '<header>' +
        '<strong>' + esc(fieldValue(doc, 'institution') || row.id || 'Untitled posting') + '</strong>' +
        (line ? ' <span class="oa-hint" style="display:inline">— ' +
          esc(line) + '</span>' : '') +
        '<span class="oa-fb-status is-open">under review</span>' +
        '<p class="oa-hint">Advertised ' + esc(row.posted || '?') +
          ' &middot; market ' + esc(String(row.year || '?')) +
          ' &middot; queued ' + esc(fmtDate(doc.queuedAt) || '?') +
          (CRAWLED_FROM[row.source] ? ' &middot; from ' + esc(CRAWLED_FROM[row.source]) : '') +
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
          /* a DIV where the box takes prose: wireComments wraps that box in
             the editor's own <div>, and a div inside a <p> ends the paragraph
             as the browser parses it. Styled by `.oa-rv-field`, a class, so
             the element makes no difference to how it draws. */
          var tag = f.area ? 'div' : 'p';
          return '<' + tag + ' class="oa-rv-field' + (f.area || f.list ? ' is-wide' : '') + '">' +
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
            '</' + tag + '>';
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
   * The ONE write a decision makes. `edits` is REPLACED, never merged into:
   * `set(…, {merge:true})` deep-merges a map, so a key the maintainer had
   * changed and then typed BACK to the sheet's value — which readEdits
   * therefore leaves out — survived in Firestore, and approvedRow re-applied
   * the stale edit at publish while the card said "Saved." and the echo
   * showed the reverted value: a private fiction, and the same trap
   * search-v2's contentJson records. `mergeFields` names the fields set
   * whole; everything else on the document (row, dup, biz, ad, queuedAt,
   * note) is left as it is, exactly as before.
   */
  function writeDecision(db, doc, patch) {
    return db.collection(COL).doc(doc.rowId).set(patch, { mergeFields: Object.keys(patch) });
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
    /* ONLY WHAT IS STILL QUEUED. `docs`/`cards` are the page as it was
       RENDERED; a card decided on since then (Approve, Reject, the duplicate
       sweep) is retired from state.crawled but the list is not redrawn, so
       the arrays still carry it. Walking them as they stand re-approved
       every decided card — including one the maintainer had just REJECTED,
       which the merge write then flipped to approved. */
    var pairs = [];
    docs.forEach(function (doc, i) {
      if (state.crawled.indexOf(doc) >= 0) pairs.push({ doc: doc, card: cards[i] });
    });
    var n = pairs.length;
    if (!n) {
      msg.className = 'oa-form-msg';
      msg.textContent = 'Nothing left to publish on this page.';
      return;
    }

    if (!window.confirm('Publish all ' + n + ' postings on this page?\n\n' +
        'They are on your own jobs page at once and reach everyone else at the ' +
        'next build. You can still take any of them down afterwards from the ' +
        'posting itself.')) return;

    btn.disabled = true;
    msg.className = 'oa-form-msg';
    msg.textContent = 'Publishing 0 of ' + n + '…';

    var done = 0, failed = 0;
    var chain = Promise.resolve();
    pairs.forEach(function (pair) {
      chain = chain.then(function () {
        var doc = pair.doc, card = pair.card;
        var edits = card ? readEdits(card, doc) : (doc.edits || {});
        var reviewedAt = new Date().toISOString();
        return writeDecision(db, doc, {
          edits: edits,
          status: 'approved',
          reviewedAt: reviewedAt,
        })
          .then(function () {
            done++;
            echoApproval(doc, edits, reviewedAt);
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
      /* Redraw what is left BEFORE the outcome is written (render() clears
         this line), so the cards just published leave the screen and the
         button's count says what is really still here. */
      if (!failed) paint(db, 'crawled', state.year);
      msg.className = 'oa-form-msg ' + (failed ? 'is-err' : 'is-ok');
      msg.textContent = failed
        ? done + ' approved, ' + failed + ' could not be saved — reload and try those again.'
        : 'All ' + done + ' approved, and on your own jobs page straight away. ' +
          'Everyone else sees them within a couple of minutes.';
      btn.disabled = !!failed;
    });
  }

  /* ------------------------------------- the posting you just made public */

  /**
   * Show an approved posting on the jobs page NOW (owner, 2026-08-26: "when I
   * press a job under review to become public, it should immediately show up
   * in the list of job postings available to the public").
   *
   * Approving writes Firestore; the BUILD turns that into a row in
   * data/jobs.json, and until it runs the posting is in neither place — out of
   * the queue and not yet on the site. The maintainer presses Approve, goes to
   * the jobs page and finds nothing, which reads exactly like an approval that
   * did not save.
   *
   * So it is echoed, the way a saved EDIT already is (assets/oa-fresh.js): the
   * published row is left in this browser's localStorage and every page that
   * renders jobs.json overlays it at read time. Honest by construction, the
   * same three ways — PER BROWSER (nothing here can show a visitor an
   * unpublished posting, because nothing here leaves the machine), STANDS DOWN
   * against the build rather than against hope, and echoes exactly what the
   * build will publish: `OAFresh.approvedRow` is a parity-pinned twin of
   * jobreview.mjs's own, given the site's `canonColumns` to settle the names
   * with.
   *
   * Entirely optional: without oa-fresh.js or oa-schools.js the approval works
   * exactly as before and simply waits for the build.
   */
  function echoApproval(doc, edits, reviewedAt) {
    if (!window.OAFresh || !window.OAFresh.approvedRow) return;
    if (!window.OASchools || !OASchools.canonColumns) return;
    var row = doc.row || {};
    if (!row.id) return;
    try {
      OAFresh.stash({
        docId: doc.rowId,
        ref: row.ref || '',
        added: OAFresh.approvedRow(row, {
          edits: edits || doc.edits || {},
          queuedAt: doc.queuedAt || '',
          reviewedAt: reviewedAt || '',
        }, {
          canonColumns: OASchools.canonColumns,
          /* the same canon the build applies to an edited country, so the
             echo shows "United States" where the maintainer typed "USA".
             Optional: absent, the echo does not re-spell, which is a
             spelling and never a value the build would refuse. */
          canonCountry: (window.OACountries && OACountries.canon) || null,
        }),
      });
    } catch (e) { /* an echo is a courtesy: never let it cost the approval */ }
  }

  /* ------------------------------------------ one advertisement, one posting */

  /**
   * The row as it will PUBLISH — the maintainer's unsaved edits included.
   *
   * The sync judges the sheet's own row because that is all it has; the panel
   * has the card in front of it, so a link the maintainer has just corrected
   * is the link this check reads. `fieldValue` is the same reader the cards
   * draw from, and the department line is joined exactly as `settlePlace`
   * derives it, so the two sides cannot disagree about what a row says.
   */
  function judgedRow(doc) {
    var row = doc.row || {};
    var school = fieldValue(doc, 'school');
    var unit = fieldValue(doc, 'unit');
    return {
      id: doc.rowId,
      ref: row.ref || '',
      source: row.source || '',
      year: row.year,
      posted: row.posted || '',
      institution: fieldValue(doc, 'institution'),
      school: school,
      unit: unit,
      department: joinDepartment(school, unit, fieldValue(doc, 'institution')) || row.department || '',
      levels: fieldValue(doc, 'levels'),
      adUrl: fieldValue(doc, 'adUrl')
    };
  }

  /**
   * "Check for duplicate adverts" (owner, 2026-08-26).
   *
   * The sheet sync drops a crawled row whose advertisement link already
   * belongs to a posting that is live or already queued. This is the SAME
   * rule, on demand — `window.OAAdvertDup`, the very file `_scraper/jobreview.mjs`
   * re-exports, so the button and the pipeline can never answer differently.
   *
   * Four things it does deliberately:
   *
   *   - it sweeps the WHOLE crawled queue, not the page on screen. A repeat is
   *     always in the same market year as what it repeats, so no page could
   *     show a pair the sweep should have left alone;
   *   - OLDEST FIRST, so the posting that has been waiting longest is the one
   *     that stays, exactly as the sync orders it;
   *   - it REPORTS BEFORE IT WRITES. Every drop is named in the confirmation
   *     with the posting it repeats, so nothing leaves the queue unseen;
   *   - it REJECTS, never deletes. `partition` re-queues a row whose document
   *     is gone, so a delete would re-drop it on every sync for ever.
   */
  function checkDuplicates(db) {
    var msg = $('oa-review-bulk-msg');
    var btn = $('oa-review-dupes');
    if (!window.OAAdvertDup) {
      msg.className = 'oa-form-msg is-err';
      msg.textContent = 'The duplicate-advert rule did not load — reload the page.';
      return;
    }

    var docs = state.crawled.slice().sort(function (a, b) {
      return String(a.queuedAt || '').localeCompare(String(b.queuedAt || ''));
    });

    btn.disabled = true;
    msg.className = 'oa-form-msg';
    msg.textContent = 'Reading the postings already on the site…';

    /* WHAT COUNTS AS "ALREADY LISTED" IS NOT data/jobs.json ALONE (owner,
       2026-08-26: a Stanford MS&E posting was approved, and pressing this
       button then failed to catch its twin still under review).

       A posting the maintainer has APPROVED is out of the queue and not yet
       in the served file — the build publishes it minutes later — so for that
       window its twin was measured against a set holding NEITHER copy and
       nothing could match. That is not a race to paper over: `data/jobs.json`
       is a built file that lags every approval by up to a build, so the
       decision, not the deployment, is what "already posted" has to mean.

       So the set is the served file PLUS every approved queue document. One
       equality query, no composite index, and it reads the collection the
       panel is already looking at; an approval that HAS published is in both
       and matches the same either way. */
    var live = fetch('data/jobs.json', { cache: 'no-cache' })
      /* no-cache REVALIDATES: Pages serves data/ with ten minutes of
         freshness, and a sweep run against a stale copy of the site would
         keep a repeat of something published nine minutes ago. */
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) { return Array.isArray(rows) ? rows : []; });

    var approved = db.collection(COL).where('status', '==', 'approved').get()
      .then(function (snap) {
        return snap.docs.map(function (d) { return d.data(); })
          .filter(function (d) { return d && d.rowId; })
          .map(judgedRow);
      })
      /* An approved-queue read that fails must not lose the sweep: the served
         file alone is the old behaviour, which is still worth having. */
      .catch(function () { return []; });

    Promise.all([live, approved])
      .then(function (got) {
        var site = got[0].concat(got[1]);
        var rows = docs.map(judgedRow);
        var swept = OAAdvertDup.findAdvertRepeats(rows, site);
        var drops = swept.drop.map(function (d) {
          return { doc: docs[rows.indexOf(d.row)], of: d.of, row: d.row };
        }).filter(function (d) { return !!d.doc; });

        if (!drops.length) {
          msg.className = 'oa-form-msg is-ok';
          msg.textContent = 'Checked all ' + docs.length + ' postings under review ' +
            'against the ' + site.length + ' already published or approved: none of ' +
            'them advertises a vacancy that is already listed.';
          btn.disabled = false;
          return;
        }

        var lines = drops.map(function (d) {
          return '\u2022 ' + (d.row.institution || d.doc.rowId) +
            (d.row.department ? ' — ' + d.row.department : '') +
            '\n    repeats ' + (d.of.ref || d.of.id) +
            (d.of.institution ? ' (' + d.of.institution + ')' : '');
        }).join('\n');

        if (!window.confirm('Take these ' + drops.length + ' postings out of the queue?\n\n' +
            lines + '\n\nEach advertises the same vacancy as a posting that is already ' +
            'live or already under review. They are rejected, not deleted, so they will ' +
            'not be queued again; nothing already on the site changes.')) {
          msg.className = 'oa-form-msg';
          msg.textContent = drops.length + ' repeated ' +
            (drops.length === 1 ? 'advertisement' : 'advertisements') + ' found — nothing removed.';
          btn.disabled = false;
          return;
        }

        msg.textContent = 'Removing 0 of ' + drops.length + '…';
        var done = 0, failed = 0;
        var chain = Promise.resolve();
        drops.forEach(function (d) {
          chain = chain.then(function () {
            /* The write the sync makes, field for field: `note` and `dup` are
               already in the rules' key list, so this needs no redeploy. */
            return db.collection(COL).doc(d.doc.rowId).set({
              status: 'rejected',
              reviewedAt: new Date().toISOString(),
              note: OAAdvertDup.repeatNote(d.of),
              dup: [d.of],
            }, { merge: true })
              .then(function () { done++; retire(db, 'crawled', d.doc); })
              .catch(function () { failed++; })
              .then(function () {
                msg.textContent = 'Removing ' + (done + failed) + ' of ' + drops.length + '…';
              });
          });
        });

        chain.then(function () {
          /* REPAINT FIRST, THEN SAY WHAT HAPPENED. render() clears this line —
             a message left over from another tab is worse than none — so an
             outcome written before the redraw is wiped by it, and the
             maintainer watches the queue shrink under a blank strip.

             The sweep also spans every market year, so the tab on screen may
             have just been emptied: repaint on a year that still exists rather
             than on one whose postings have all gone. */
          if (!failed) {
            var left = yearsOf(state.crawled, SOURCES.crawled);
            paint(db, 'crawled', left.indexOf(state.year) >= 0 ? state.year : null);
          } else btn.disabled = false;
          msg.className = 'oa-form-msg ' + (failed ? 'is-err' : 'is-ok');
          msg.textContent = failed
            ? done + ' removed, ' + failed + ' could not be saved — reload and try again.'
            : done + ' repeated ' + (done === 1 ? 'posting' : 'postings') +
              ' taken out of the queue. Nothing on the site changed.';
        });
      })
      .catch(function (err) {
        msg.className = 'oa-form-msg is-err';
        msg.textContent = 'Could not read the postings on the site (' +
          esc(err.message || err) + ') — nothing was removed.';
        btn.disabled = false;
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
  var state = {
    crawled: [], user: [], userError: false, source: 'crawled', year: '*',
    /* What the MAINTAINER has taken down on the user tab, and whether that
       read answered. Deliberately NOT a third source tab: it is not a queue,
       nothing is waiting on it, and a tab reading (3) beside the two that
       count work to do would say the maintainer owes something they have
       already dealt with. It is the door back, and it is drawn as one. */
    hidden: [], hiddenError: false,
  };

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
    /* DRAWN WHENEVER THERE IS A SEASON TO NAME, not only when there are two.
       Hiding a filter with one value reads as the filter being MISSING — which
       is what it was reported as (owner, 2026-08-25: "I don't see an option to
       filter the results by job market year"), on a tab whose 86 postings all
       happened to belong to one market. A row saying "2025-2026 (86) · All"
       answers the question the empty space could not. */
    show(box, years.length > 0);
    if (!years.length) return;

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
      var line = joinDepartment(school.value, unit.value, inst.value);
      derived.textContent = line ? 'Published as: ' + line : '';
    }
    inst.addEventListener('input', preview);
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

  /**
   * The Comments box, with the site's formatting toolbar over it.
   *
   * The SAME module the posting form mounts (assets/oa-editor.js), for the
   * same reason the three name boxes share a picker: the maintainer tidying a
   * crawled posting and the poster writing a new one are filling in one
   * field, and the card draws its own preview by the very module the jobs
   * page draws the cell by (assets/oa-forum-markup.js). This is the surface
   * that needs it most — a workbook row's Comments arrive as one unbroken
   * paragraph of an advertisement's own description, which is the screen the
   * owner sent on 2026-09-17.
   *
   * Entirely optional, like the picker: without the module the box is the
   * ordinary textarea the card already wrote, and the marks are text either
   * way. Nothing to give back at unmount — every listener it adds is on the
   * toolbar or the box itself, so a redrawn card takes them with it.
   */
  function wireComments(card) {
    var ta = card.querySelector('textarea[data-key="comments"]');
    if (ta && window.OAEditor) OAEditor.attach(ta);
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
    var line = joinDepartment(d.school, d.unit, d.institution) || d.department || '';
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
        [['Position type', (d.levels || []).join(', ')],
         /* every campus country the poster named (owner, 2026-09-18) — the
            card that lists a user-added posting reads the document, and a
            document made before the field carries its single `country` */
         [(d.countries && d.countries.length > 1) ? 'Countries' : 'Country',
          ((d.countries && d.countries.length) ? d.countries : [d.country])
            .filter(Boolean).join(', ')],
         ['Suggested apply by', d.reviewDate],
         ['Final apply by', d.applyByDate || d.applyByNote]]
          .filter(function (l) { return l[1]; })
          .map(function (l) {
            return '<tr><th>' + esc(l[0]) + '</th><td>' + esc(l[1]) + '</td></tr>';
          }).join('') +
      '</table>' +
      '<p class="oa-rv-actions">' +
        '<a class="button blue" href="' + EDIT_PATH + encodeURIComponent(it.id) +
          '">Open &amp; correct</a> ' +
        '<button type="button" class="button" data-act="reviewed">Mark reviewed</button> ' +
        /* THE REMOVAL THIS TAB DID NOT HAVE. It is the same verb and the same
           write as the Take-down control on the live listings, put where the
           maintainer is already reading the posting; `oa-btn-ghost` is the
           candidates panel's own class for the one destructive-sounding
           button on a card, so the two surfaces look the same. */
        '<button type="button" class="button oa-btn-ghost" data-act="takedown">' +
          'Take down</button>' +
        '<span class="oa-form-msg" data-msg role="status"></span>' +
      '</p>';
  }

  /**
   * A posting the maintainer has taken down, in the drawer below the list.
   *
   * ONE BUTTON, and Open & correct is deliberately not beside it: post-a-job
   * writes `queued` on every save, so opening the form on a hidden posting
   * and saving it would put the posting back as a side effect of correcting
   * it. Two buttons that both un-hide a posting, one of them silently, is
   * not what a drawer whose only job is the way back should offer. Put it
   * back first, then correct it on the card above.
   */
  function downCardHtml(it) {
    var d = it.data || {};
    var line = joinDepartment(d.school, d.unit, d.institution) || d.department || '';
    return '<header>' +
        '<strong>' + esc(d.institution || 'Untitled posting') + '</strong>' +
        (line ? ' <span class="oa-hint" style="display:inline">&mdash; ' +
          esc(line) + '</span>' : '') +
        '<span class="oa-fb-status is-closed">taken down</span>' +
        '<p class="oa-hint">Posted ' + esc(fmtDate(d.createdAt) || '?') +
          ' &middot; market ' + esc(marketLabel(String(d.year || '?'))) +
          (d.ref ? ' &middot; ' + esc(d.ref) : '') +
        '</p>' +
      '</header>' +
      '<p class="oa-rv-actions">' +
        '<button type="button" class="button oa-btn-ghost" data-act="restore">' +
          'Put it back</button>' +
        '<span class="oa-form-msg" data-msg role="status"></span>' +
      '</p>';
  }

  /**
   * TAKING A POSTING DOWN, AND PUTTING IT BACK: one write, and the status is
   * the whole of it.
   *
   * THE ECHO IS THE OTHER HALF, and admin-area.html loads oa-fresh.js for it.
   * The build runs every twenty minutes, so for up to a cycle the row this
   * panel has just taken down is still in the served data/jobs.json — and
   * /jobs is exactly the page the maintainer opens next to check. So the
   * take-down is echoed the way oa-jobedit.js echoes its own (`removed`,
   * which filters the row out of what THIS browser renders), and the restore
   * is echoed as an edit of NO FIELDS, which CANCELS it: an echo whose every
   * echoed value already matches the served row has landed by definition, so
   * the next overlay spends it and deletes it, leaving the served row exactly
   * as the build publishes it. Nothing else can clear a removal echo, and an
   * uncleared one would go on hiding, for the rest of its hour, the posting
   * the maintainer had just put back.
   */
  function setStatus(db, it, status) {
    return db.collection(SUBS_COL).doc(it.id).update({
      status: status,
      updatedAt: new Date().toISOString(),
    }).then(function () {
      if (!window.OAFresh) return;
      var ref = (it.data || {}).ref || '';
      if (status === HIDDEN) {
        OAFresh.stash({ docId: it.id, ref: ref, removed: true });
      } else {
        OAFresh.stash({ docId: it.id, ref: ref, fields: {} });
      }
    });
  }

  /**
   * The user tab's bulk verb: tick every posting on the page off the list.
   *
   * approveAll's reasoning, with the one difference that matters — NOTHING IS
   * PUBLISHED HERE. These postings are already live; the stamp only takes them
   * off this list, which is why the confirmation says so and why a failure is
   * harmless (the posting is unaffected either way). One write at a time with
   * the failures COUNTED rather than thrown, so 86 rows do not become 86
   * rejected promises and one useless message.
   */
  function markAllReviewed(db, items) {
    var msg = $('oa-review-bulk-msg');
    var btn = $('oa-review-all');
    /* Only the rows still on the list — the same stale-array trap approveAll
       has: a row ticked off singly since the render is gone from state.user
       but still in `items`. */
    items = items.filter(function (it) { return state.user.indexOf(it) >= 0; });
    var n = items.length;
    if (!n) {
      msg.className = 'oa-form-msg';
      msg.textContent = 'Nothing left to mark on this page.';
      return;
    }

    if (!window.confirm('Mark all ' + n + ' postings on this page reviewed?\n\n' +
        'They stay live — this only takes them off your list. Nothing is ' +
        'published, changed or taken down.')) return;

    btn.disabled = true;
    msg.className = 'oa-form-msg';
    msg.textContent = 'Saving 0 of ' + n + '…';

    var done = 0, failed = 0;
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        var patch = {};
        patch[REVIEWED_AT] = new Date().toISOString();
        return db.collection(SUBS_COL).doc(it.id).set(patch, { merge: true })
          .then(function () { done++; retire(db, 'user', it); })
          .catch(function () { failed++; })
          .then(function () {
            msg.textContent = 'Saving ' + (done + failed) + ' of ' + n + '…';
          });
      });
    });

    chain.then(function () {
      /* The rows are gone from the tab's own state, so redraw what is left
         rather than leaving the page showing what was just cleared — and
         redraw BEFORE the outcome is written, because render() clears this
         line and would otherwise wipe what it says. */
      if (!failed) paint(db, 'user', state.year);
      msg.className = 'oa-form-msg ' + (failed ? 'is-err' : 'is-ok');
      msg.textContent = failed
        ? done + ' marked reviewed, ' + failed + ' could not be saved — reload and try those again.'
        : 'All ' + done + ' marked reviewed. They are still live; they have just ' +
          'left this list.';
    });
  }

  function renderUserCards(db, items) {
    var list = $('oa-review-list');

    /* The bulk button is shared with the crawled tab, which wires it at the
       end of its own render — so this path has to claim it, or the user tab
       would carry the LAST crawled page's handler and approve postings the
       maintainer is not looking at. */
    var all = $('oa-review-all');
    if (all) all.onclick = function () { markAllReviewed(db, items); };

    items.forEach(function (it) {
      var card = document.createElement('article');
      card.className = 'oa-fb-card oa-rv-card';
      card.innerHTML = userCardHtml(it);

      card.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-act]');
        if (!b) return;
        var act = b.getAttribute('data-act');
        var msg = card.querySelector('[data-msg]');
        var fail = function (err) {
          msg.className = 'oa-form-msg is-err';
          msg.textContent = 'Could not save (' +
            esc((err && (err.code || err.message)) || 'error') + ').';
          b.disabled = false;
        };

        if (act === 'takedown') {
          var what = (it.data || {}).institution || it.id;
          var line = joinDepartment((it.data || {}).school, (it.data || {}).unit,
            (it.data || {}).institution) || (it.data || {}).department || '';
          if (!window.confirm('Take this posting down?\n\n' +
              what + (line ? '\n' + line : '') + '\n\n' +
              'It stops appearing on the site within a few minutes. ' +
              'Nothing is deleted: it moves to "Taken down by you" below, ' +
              'one press from being put back.')) return;
          b.disabled = true;
          msg.className = 'oa-form-msg';
          msg.textContent = 'Taking it down…';
          setStatus(db, it, HIDDEN)
            .then(function () {
              /* Open the drawer BEFORE the repaint that follows, so the
                 maintainer watches the posting arrive where it has gone
                 rather than simply vanish. That is also the whole of the
                 feedback here, and better than a line of text: the repaint
                 takes the card with it, so a message written into the card
                 would have nowhere to be. On the write that FAILED nothing
                 moved, so nothing is opened either. */
              downOpen = true;
              return reloadUser(db);
            })
            ['catch'](fail);
          return;
        }

        if (act !== 'reviewed') return;
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
          ['catch'](fail);
      });

      list.appendChild(card);
    });
  }

  /* Whether the drawer below the user tab is open, remembered across a
     repaint. render() rebuilds the element, so without this every re-read
     snapped it shut — and a take-down repaints, which would fold the drawer
     up at the one moment the maintainer is looking for it. The oa-news.js
     removed-updates panel keeps its own state for the same reason. */
  var downOpen = false;

  /**
   * THE WAY BACK. A posting the maintainer takes down leaves the list above
   * — that list reads the LIVE statuses, so a hidden one cannot be in it —
   * and would then be beyond every control on the site: /jobs does not carry
   * it either, so there would be nothing anywhere left to press. Hiding is
   * never a one-way door here (newsOverrides, rowOverrides, directoryEdits, a
   * reader's own messages, a settled market year all have this shape), so the
   * ones taken down sit in a collapsed panel below the list, one press from
   * Put it back.
   *
   * IT IS NOT FILTERED BY SEASON. The tabs above narrow a queue; this is a
   * drawer somebody opens looking for one posting they remember, and a season
   * filter is exactly what would hide it.
   *
   * A POSTER'S OWN WITHDRAWAL IS NOT IN IT, which is the candidates panel's
   * own rule — putting that back is theirs to do. It would also be an
   * unbounded list with nothing to press: build-jobs.mjs rewrites every
   * `withdrawn` document to `removed` on its next run, so the pile
   * accumulates every posting ever withdrawn, in every season, for ever.
   *
   * A READ THAT FAILED SAYS SO. Drawing nothing would tell a maintainer who
   * has just taken a posting down that it was deleted after all.
   */
  function renderTakenDown(db, list) {
    if (state.hiddenError) {
      var p = document.createElement('p');
      p.className = 'oa-form-msg is-err';
      p.textContent = 'Could not read the postings you have taken down — ' +
        'reload to try again. Nothing has been deleted.';
      list.appendChild(p);
      return;
    }
    if (!state.hidden.length) return;

    var d = document.createElement('details');
    d.className = 'oa-rv-down';
    d.open = downOpen;
    d.addEventListener('toggle', function () { downOpen = d.open; });
    var sum = document.createElement('summary');
    sum.textContent = 'Taken down by you (' + state.hidden.length + ')';
    d.appendChild(sum);

    var body = document.createElement('div');
    body.className = 'oa-rv-down-body';
    var note = document.createElement('p');
    note.className = 'oa-hint';
    /* No em dash: the panel this copies (oa-news.js's removed updates) has
       one, and the rule the site's own copy is held to elsewhere is that it
       has none. */
    note.textContent = 'Off the site. Nobody else sees these. Nothing is ' +
      'deleted, and every season is listed here, not just the one the tabs ' +
      'above are showing.';
    body.appendChild(note);

    state.hidden.forEach(function (it) {
      var card = document.createElement('article');
      card.className = 'oa-fb-card oa-rv-card';
      /* named by its document, the candidates panel's own shape: the drawer
         is where somebody comes looking for ONE posting, so the row has to
         be addressable rather than positional */
      card.setAttribute('data-id', it.id);
      card.innerHTML = downCardHtml(it);
      card.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-act="restore"]');
        if (!b) return;
        var msg = card.querySelector('[data-msg]');
        b.disabled = true;
        msg.className = 'oa-form-msg';
        msg.textContent = 'Putting it back…';
        setStatus(db, it, RESTORED)
          .then(function () { return reloadUser(db); })
          ['catch'](function (err) {
            msg.className = 'oa-form-msg is-err';
            msg.textContent = 'Could not put it back (' +
              esc((err && (err.code || err.message)) || 'error') + ').';
            b.disabled = false;
          });
      });
      body.appendChild(card);
    });

    d.appendChild(body);
    list.appendChild(d);
  }

  function render(db, docs, source) {
    var list = $('oa-review-list');
    var count = $('oa-review-count');
    if (count) {
      count.textContent = docs.length
        ? String(docs.length) + (docs.length === 1 ? ' posting' : ' postings')
        : 'nothing';
    }

    /* BOTH TABS GET A BULK ACTION, because both have the same arithmetic
       problem: "a gate that can only be cleared 89 times does not get
       cleared", and the user tab opened with 86 (owner, 2026-08-25 — the
       control was simply not there).

       The VERB differs, and that difference is the whole reason this was
       gated to one tab in the first place. Approving publishes; a user-added
       posting is already live, so its bulk action is the tick that takes a
       row off the list and nothing else. Same button, two promises, and each
       says which it is. */
    var bulk = $('oa-review-bulk');
    var btn = $('oa-review-all');
    var dupBtn = $('oa-review-dupes');

    /* ONE POSTING IS ENOUGH FOR THE DUPLICATE CHECK, which is why it does not
       share the bulk button's `> 1`: a single queued posting can perfectly
       well repeat one that is already LIVE, and that is the case the owner
       reported. It belongs to the crawled tab alone — a user-added posting is
       already on the site, and taking it off is the poster's decision or the
       Take-down control, never a sweep. Both live in the same row, so the row
       is shown when EITHER applies and each button hides itself. */
    var bulkOn = docs.length > 1;
    var dupOn = source === 'crawled' && state.crawled.length > 0;
    show(bulk, bulkOn || dupOn);
    show(btn, bulkOn);
    show(dupBtn, dupOn);
    if (bulkOn && btn) {
      btn.textContent = source === 'crawled'
        ? 'Approve all ' + docs.length + ' shown & publish'
        : 'Mark all ' + docs.length + ' shown reviewed';
      btn.disabled = false;
    }
    if (dupOn && dupBtn) {
      dupBtn.disabled = false;
      /* Claimed on every render, like the bulk button: the tabs redraw and a
         stale handler would be holding the previous tab's `db`. */
      dupBtn.onclick = function () { checkDuplicates(db); };
    }
    var bm = $('oa-review-bulk-msg');
    if (bm) { bm.className = 'oa-form-msg'; bm.textContent = ''; }

    unmountPickers();

    if (!docs.length) {
      list.innerHTML = source === 'user'
        ? (state.userError
          ? '<p class="oa-form-msg is-err">Could not load the postings made ' +
            'through the site &mdash; reload to try again.</p>'
          : '<p class="oa-hint">Nothing to correct. Job postings made through ' +
            'the site&rsquo;s own form are live from the moment they are made, ' +
            'and are listed here until you mark them reviewed.</p>')
        : '<p class="oa-hint">Nothing waiting. Postings crawled from ' +
          'the tracking sheet appear here before they go on the site.</p>';
      /* Even with nothing waiting: taking the LAST posting down empties this
         list, and the drawer is where it went. */
      if (source === 'user') renderTakenDown(db, list);
      return;
    }

    list.innerHTML = '';
    if (source === 'user') {
      renderUserCards(db, docs);
      renderTakenDown(db, list);
      return;
    }
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

        /* "Use these names": adopt the vocabulary's classification of the
           advertiser into the three name boxes — only the names it actually
           settled, exactly as typing them would (input events, so the
           cascade and the derived-line preview follow). */
        var adPlace = e.target.closest('button[data-ad-place]');
        if (adPlace) {
          [['institution', 'data-ad-inst'], ['school', 'data-ad-school'],
           ['unit', 'data-ad-unit']].forEach(function (pair) {
            var v = adPlace.getAttribute(pair[1]);
            if (!v) return;
            var box = card.querySelector('[data-key="' + pair[0] + '"]');
            if (box) {
              box.value = v;
              box.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          return;
        }

        /* …and the page's own stated school / department, one box each. */
        var adSchool = e.target.closest('button[data-ad-use-school]');
        if (adSchool) {
          var sBox = card.querySelector('[data-key="school"]');
          if (sBox) {
            sBox.value = adSchool.getAttribute('data-ad-use-school') || '';
            sBox.dispatchEvent(new Event('input', { bubbles: true }));
            sBox.focus();
          }
          return;
        }
        var adUnit = e.target.closest('button[data-ad-use-unit]');
        if (adUnit) {
          var uBox = card.querySelector('[data-key="unit"]');
          if (uBox) {
            uBox.value = adUnit.getAttribute('data-ad-use-unit') || '';
            uBox.dispatchEvent(new Event('input', { bubbles: true }));
            uBox.focus();
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

        writeDecision(db, doc, patch)
          .then(function () {
            if (act === 'approve') echoApproval(doc, edits, patch.reviewedAt);
            if (act === 'save') {
              doc.edits = edits;
              msg.className = 'oa-form-msg is-ok';
              msg.textContent = 'Saved. It stays under review until you approve it.';
              Array.prototype.forEach.call(card.querySelectorAll('button'), function (x) {
                x.disabled = false;
              });
              return;
            }
            /* WHAT THIS SAYS HAS TO BE TRUE OF THIS INSTALLATION, and it has
               already been wrong in BOTH directions. It first said "publishing
               starts now" while the Cloud Function that rings the build was
               undeployed (the `oa-jobreview-decided` dispatch had zero runs),
               so the posting waited for the schedule while the card claimed it
               was on its way. The correction then said "at the next build" —
               and the owner deployed the functions on 2026-08-27, the dispatch
               has fired on every decision since, and the build is chained on
               it, so an approval publishes in about two minutes and the card
               was UNDER-promising: "the next build" read as the doorbell still
               being dead.

               So it names the cadence the installation actually has — the
               echo puts the posting in front of the maintainer at once, the
               doorbell chain in front of everyone else in a couple of minutes
               — and per CLAUDE.md's own rule, copy that promises a time
               changes with the cadence: if the functions ever come down, this
               string comes back here with them. */
            card.innerHTML = '<p class="oa-form-msg is-ok">' +
              (act === 'approve'
                ? 'Approved &mdash; and on your own jobs page straight away. ' +
                  'Everyone else sees it within a couple of minutes.'
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
      wireComments(card);
    });

    var all = $('oa-review-all');
    if (all) {
      all.onclick = function () { approveAll(db, docs, cards); };
    }
  }

  /**
   * The user tab's own read: the postings still WAITING, and the ones the
   * maintainer has TAKEN DOWN.
   *
   * Three equality reads rather than one `in` query: the smallest query
   * shape, and nothing here needs a composite index. Each half degrades on
   * its own — a refused read of the live pair leaves an error on this tab and
   * can never take the gate down with it, and a refused read of the hidden
   * ones costs the drawer alone rather than the list it sits under.
   */
  function readUser(db) {
    /* Live and not yet ticked off — the same rule as
       _scraper/submissions-review.mjs's isWaiting. */
    var waiting = Promise.all(LIVE.map(function (status) {
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
    })['catch'](function () { return null; });

    /* …and the drawer's own. Deliberately NOT filtered by `reviewedAt`: this
       is everything the maintainer has taken down, and a posting they had
       also ticked off would otherwise be hidden from the one control that can
       put it back. */
    var taken = db.collection(SUBS_COL).where('status', '==', HIDDEN).get()
      .then(function (snap) {
        return snap.docs.map(function (d) {
          return { id: d.id, data: d.data() || {} };
        });
      })['catch'](function () { return null; });

    return Promise.all([waiting, taken]).then(function (r) {
      return { items: r[0], hidden: r[1] };
    });
  }

  /** What readUser found, in the tab's state. `null` is a read that did not
      answer — unknown, never an empty list, so a refusal can never read as
      "you have taken nothing down". */
  function setUser(r) {
    state.userError = r.items === null;
    state.user = (r.items || []).sort(rankBy(SOURCES.user));
    state.hiddenError = r.hidden === null;
    state.hidden = (r.hidden || []).sort(rankBy(SOURCES.user));
  }

  /**
   * After a take-down or a restore, RE-READ the tab rather than moving the
   * item between two local lists. That is the candidates panel's own answer
   * (renderCandidates after every status change) and for the same reason: the
   * list, the season tabs, the two tab counts and the drawer below all have
   * to agree, and one read of a small collection the maintainer touches a few
   * times a season is cheaper and safer than four places kept in step by
   * hand — a restored posting rejoins the list above only if it is still
   * waiting, which is a question only the documents can answer.
   *
   * It repaints on a season that still EXISTS: taking the last posting of a
   * market down would otherwise leave the tab on a year whose postings have
   * all gone (approveAll's own lesson, a few hundred lines up).
   */
  function reloadUser(db) {
    return readUser(db).then(function (r) {
      setUser(r);
      /* '*' is the All tab, which is not a season and is therefore not in
         yearsOf's answer: without this a take-down pressed while All was
         selected dropped the maintainer back into one season, which is the
         opposite of what they had chosen. */
      var left = yearsOf(state.user, SOURCES.user);
      var keep = state.year === '*' || left.indexOf(state.year) >= 0;
      paint(db, 'user', keep ? state.year : null);
    });
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

    Promise.all([crawled, readUser(db)])
      .then(function (r) {
        /* Sorted here rather than in the query so no composite index is
           needed for collections this small; the comparator is rankBy's
           next-market-first, newest-advertisement-within-it. */
        state.crawled = r[0].sort(rankBy(SOURCES.crawled));
        setUser(r[1]);
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
