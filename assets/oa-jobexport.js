/* ---------------------------------------------------------------------------
   Operations Academia — the job postings, as an Excel workbook.

   ONE definition, loaded by BOTH sides, like assets/oa-alert-match.js:

     the browser   <script src="assets/oa-jobexport.js">  -> window.OAJobExport
     the checks    createRequire(...)(...)                -> module.exports

   so _scraper/selftest.mjs builds the workbook from the REAL data/jobs.json
   offline and reads the bytes back. The pure half — COLUMNS and sheets() — is
   everything that decides what leaves the site; the browser half is a button.

   WHAT IS IN IT, AND WHY THAT IS THE WHOLE SAFETY ARGUMENT
   -------------------------------------------------------
   The owner's instruction (2026-08-26) was explicit: a registered reader may
   download the postings, and "do not show the data from a job posting that
   belong to the area Contact details … This is private information for the
   admin only."

   Those fields — the poster's first and last name, their e-mail, the area
   coordinator or department chair and their e-mail, and the private note to
   the maintainer — are not excluded HERE by remembering to leave them out.
   They are excluded three times over, and each one holds on its own:

     1. they never reach the browser at all. PUBLIC_FIELDS in
        _scraper/jobs-model.mjs is what the build copies out of a submission,
        and none of them is in it; `stripRowEmails` additionally removes an
        address someone typed into the PROSE. data/jobs.json — the file this
        page loads and this workbook is built from — simply does not carry
        them, which is why the site's data can be a public file at all;
     2. this file reads a whitelist, not a row. Every column below names the
        field it reads in `from`, and a field with no column is not exported
        however the served file grows;
     3. `selftest.mjs` pins the two against each other BOTH WAYS: every `from`
        must be in PUBLIC_FIELDS, and no `from` may be a contact field or one
        of the three withheld below. A column added without a rule fails the
        build rather than the reader's privacy.

   THREE PUBLIC FIELDS ARE DELIBERATELY WITHHELD. They are in the served file
   and are nobody's secret, but they are not the applicant's business and one
   of them is close enough to identity to be worth naming:

     owner   a digest of the POSTER's account. Nothing can be read out of it,
             but it is the one column that would let a downloader group the
             site's postings by the person who filed them.
     ref     the reference the poster quotes to the maintainer about their own
             submission. It belongs to them.
     source  which pipeline wrote the row. Internal bookkeeping.

   AND THREE DERIVED THINGS ARE WITHHELD FOR A DIFFERENT REASON. The page's
   own "Closing soon / Expired / Until filled", "Review ahead / Review passed"
   and "Last 7 days / Last 30 days …" buckets are computed against TODAY
   (DERIVE in assets/oa-list.js). A workbook is opened weeks after it is
   saved, so exporting a bucket would put a cell reading "Closing soon" beside
   a deadline that passed a month ago — a stale answer is worse than none. The
   real dates are exported instead, as real dates, which is what lets the
   reader compute the bucket themselves and have it be true when they do.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-xlsx.js'));
  } else {
    root.OAJobExport = factory(root.OAXlsx);
  }
}(typeof self !== 'undefined' ? self : this, function (OAXlsx) {
  'use strict';

  /* The window, named INSIDE the factory. The UMD wrapper's `root` is a
     parameter of the WRAPPER, not of this function, so reaching for it here is
     a ReferenceError — and the engine catches a failing refresh, so the only
     symptom was a button with no tooltip that did nothing when pressed. Null
     under Node, where only the pure half above is ever called. */
  var G = (typeof window !== 'undefined') ? window : null;

  /* The Contact details block of post-a-job.html, by the names the submission
     carries. Listed here so the check has something to pin against — this
     array is the ONLY place in the export that names them, and it names them
     in order to keep them out. */
  var CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'authEmail',
    'chairName', 'chairEmail', 'note', 'uid'];

  /** Public, and still not exported — see the header for the reason each. */
  var WITHHELD = ['owner', 'ref', 'source'];

  function txt(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  function list(v) {
    if (v == null) return '';
    var a = Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
    return a.map(txt).filter(Boolean).join('; ');
  }

  /** A stored day as a DATE cell — the whole point of the file being a
      workbook rather than a CSV. An empty or unparseable value is an EMPTY
      cell, never a 0 and never today: "the posting does not say" is an
      answer the sheet has to be able to give. */
  function date(v) {
    var s = txt(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : '';
  }

  function link(v) {
    var u = OAXlsx.safeUrl(v);
    return u ? { link: u } : '';
  }

  /* ------------------------------------------------------------- the columns

     Ordered the way an applicant reads a posting: WHERE it is, WHAT it is,
     WHEN it closes, then the links to act on it. The three dates sit together
     so they can be sorted on as a block. */
  var COLUMNS = [
    { header: 'University', from: ['institution'], type: 'Text', w: 34,
      note: 'The university, school or institute advertising the post.',
      cell: function (r) { return txt(r.institution); } },

    { header: 'School', from: ['school'], type: 'Text', w: 28,
      note: 'The school, faculty or college within it, where the posting names one.',
      cell: function (r) { return txt(r.school); } },

    { header: 'Department', from: ['department'], type: 'Text', w: 34,
      note: 'The department, area or group doing the hiring.',
      cell: function (r) { return txt(r.department); } },

    { header: 'Type', from: ['type'], type: 'Text', w: 15,
      note: 'Business School or University.',
      cell: function (r) { return txt(r.type); } },

    { header: 'Country', from: ['country'], type: 'Text', w: 18,
      note: 'One spelling per country, as the site publishes it.',
      cell: function (r) { return txt(r.country); } },

    { header: 'Entry level', from: ['levels'], type: 'Text', w: 34,
      note: 'Every rank the search is advertised at, separated by "; ". ' +
        'A search advertised across ranks carries more than one.',
      cell: function (r) { return list(r.levels); } },

    { header: 'Suggested apply by', from: ['reviewDate'], type: 'Date', w: 17,
      note: 'The first-review or full-consideration date, where the posting names one. ' +
        'A real date — and a date passing here does NOT close the search.',
      cell: function (r) { return date(r.reviewDate); } },

    { header: 'Final apply by', from: ['applyByDate'], type: 'Date', w: 15,
      note: 'The hard closing date. A real date. EMPTY means the search has no ' +
        'closing date on record — it is open until filled, not closed.',
      cell: function (r) { return date(r.applyByDate); } },

    { header: 'Final apply by (as listed)', from: ['applyBy'], type: 'Text', w: 40,
      note: 'The deadline in the posting’s own words, which may add a condition ' +
        'the date alone cannot carry ("Until filled", "submit by 30 September ' +
        'if you are attending INFORMS").',
      cell: function (r) { return txt(r.applyBy); } },

    { header: 'Posted', from: ['posted'], type: 'Date', w: 13,
      note: 'The day the post was advertised. A real date.',
      cell: function (r) { return date(r.posted); } },

    { header: 'Added to this site', from: ['addedAt'], type: 'Date', w: 15,
      note: 'The day this site first listed it — what to sort on to see what is ' +
        'new since your last download.',
      cell: function (r) { return date(r.addedAt); } },

    { header: 'Market year', from: ['year'], type: 'Number', w: 12,
      note: 'The job market year the posting is FOR, numbered by the year it ' +
        'ends: 2027 is 1 July 2026 to 30 June 2027. One number, so it sorts.',
      cell: function (r) { var n = Number(r.year); return isFinite(n) && n ? n : ''; } },

    /* THE OVERLAP, beside the number rather than inside it. A search
       advertised in May that closes in September was open in two seasons and
       the site lists it under both (`years`) — but a column that answered
       "2026; 2027" could not be sorted or subtracted, and this file exists to
       be worked through. So the number above stays one number and this says
       what else it is listed under; empty, like every other cell here, means
       "does not apply" — the posting belongs to one season only. */
    { header: 'Also listed under', from: ['years'], type: 'Text', w: 16,
      note: 'Any OTHER market year the posting is listed under. A search ' +
        'advertised in one season that closes in the next is open during both, ' +
        'so it appears under each; empty means it belongs to one season only.',
      cell: function (r) {
        var a = Object.prototype.toString.call(r.years) === '[object Array]' ? r.years : [];
        var n = Number(r.year);
        return a.filter(function (y) { return Number(y) !== n; }).join('; ');
      } },

    { header: 'Characteristics', from: ['characteristics'], type: 'Text', w: 34,
      note: 'What the department offers — research seminars, PhD, Masters, MBA, ' +
        'Undergrad, Exec Ed — separated by "; ".',
      cell: function (r) { return list(r.characteristics); } },

    { header: 'Comments', from: ['comments'], type: 'Text', w: 52,
      note: 'What the posting says about itself. Anything the poster wrote to the ' +
        'maintainer instead is private and is not published.',
      cell: function (r) { return txt(r.comments); } },

    { header: 'Job advert', from: ['adUrl', 'adPending'], type: 'Link', w: 42,
      note: 'The advertisement itself, clickable. "Soon to be available" means the ' +
        'posting is listed but its advert has not been filed yet.',
      cell: function (r) {
        var u = link(r.adUrl);
        if (u) return u;
        return r.adPending ? 'Soon to be available' : '';
      } },

    { header: 'Posted online at', from: ['postedAtUrl'], type: 'Link', w: 42,
      note: 'Where the post is advertised — the university’s own site, ' +
        'HigherEdJobs, Interfolio, and so on. Clickable.',
      cell: function (r) { return link(r.postedAtUrl); } },

    { header: 'Further info', from: ['furtherInfoUrl'], type: 'Link', w: 42,
      note: 'The university’s entry in this site’s own Universities directory. ' +
        'Clickable.',
      cell: function (r) { return link(r.furtherInfoUrl); } },

    { header: 'Featured', from: ['featured'], type: 'Yes/No', w: 10,
      note: 'TRUE where the posting is featured on the site. A real Excel boolean.',
      cell: function (r) { return !!r.featured; } },

    /* LAST, because it is a key rather than something to read: it is what
       lets a reader who downloads this every week join their own notes onto a
       posting, and dedupe two downloads, without matching on names. */
    { header: 'Posting ID', from: ['id'], type: 'Text', w: 34,
      note: 'This site’s own stable key for the posting. It does not change, so ' +
        'you can join your notes to it across downloads.',
      cell: function (r) { return txt(r.id); } }
  ];

  var SITE = 'https://www.operationsacademia.org/';
  var JOBS_PAGE = SITE + 'jobs.html';

  /* The one sentence this whole feature is answerable for, in the file
     itself — the reader is entitled to know what a download of "the job
     postings" does and does not contain. */
  var PRIVACY_NOTE =
    'The Contact details a poster gives us — their name and e-mail address, the ' +
    'area coordinator or department chair and their e-mail, and any private note ' +
    'to the maintainer — are never published and are not in this file. They are ' +
    'held so that we can reach the poster if a link breaks or a posting needs ' +
    'correcting.';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** The local day, as an ISO string. Local and not UTC deliberately: this
      stamps a file the reader is holding, so it should say the date on their
      own calendar. */
  function isoDay(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isoMinute(d) {
    return isoDay(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** operations-academia-job-postings-2026-2027-2026-08-26.xlsx */
  function fileName(meta) {
    var when = (meta && meta.at) || new Date();
    var market = txt(meta && meta.market).replace(/[^0-9A-Za-z-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return ['operations-academia-job-postings', market, isoDay(when)]
      .filter(Boolean).join('-') + '.xlsx';
  }

  /**
   * The workbook.
   *
   * @param rows  the postings to export, IN THE ORDER THE PAGE IS SHOWING THEM
   *              (featured first, then newest) — a download should match what
   *              the reader was looking at when they pressed the button.
   * @param meta  { at, market, total, filters: [{ label, values: [] }] }
   *              `total` is how many postings the page holds in all, so the
   *              file can say whether it is the whole list or a search.
   * @returns     the sheets, DATA FIRST — pandas' read_excel and R's read_xlsx
   *              both default to the first sheet, so a notes sheet in front of
   *              the data would be the first thing to trip up the "easy
   *              processing" this file is for.
   */
  function sheets(rows, meta) {
    meta = meta || {};
    var at = meta.at instanceof Date ? meta.at : new Date();
    var data = (rows || []).filter(Boolean);
    var filters = (meta.filters || []).filter(function (f) {
      return f && f.values && f.values.length;
    });

    var dataRows = [COLUMNS.map(function (c) { return c.header; })];
    data.forEach(function (r) {
      dataRows.push(COLUMNS.map(function (c) { return c.cell(r); }));
    });

    var dictRows = [['Column', 'What it is', 'Type']];
    COLUMNS.forEach(function (c) { dictRows.push([c.header, c.note, c.type]); });

    var aboutRows = [
      ['Item', 'Detail'],
      ['What this is', 'The academic job postings listed on Operations Academia, ' +
        'as they were showing when this file was downloaded.'],
      ['Job market year', txt(meta.market)],
      ['Postings in this file', data.length],
      ['Postings on the page', Number(meta.total) || data.length],
      ['Filters in force', filters.length
        ? '' : 'None — this is every posting the page was showing.']
    ];
    filters.forEach(function (f) {
      aboutRows.push(['  ' + txt(f.label), f.values.map(txt).join('  or  ')]);
    });
    aboutRows.push(['Downloaded', isoMinute(at)]);
    aboutRows.push(['Source', { link: JOBS_PAGE }]);
    aboutRows.push(['Dates',
      'Suggested apply by, Final apply by, Posted and Added to this site are real ' +
      'Excel dates — sort, filter and subtract them as dates. An EMPTY date ' +
      'cell means the posting names none; it never means today, and it never ' +
      'means the search is closed.']);
    aboutRows.push(['Deadlines',
      'A posting can name two: a suggested first-review date and a final closing ' +
      'date. Only the final one closes a search, and a posting with no final date ' +
      'is open until filled.']);
    aboutRows.push(['Not in this file', PRIVACY_NOTE]);
    aboutRows.push(['Corrections', 'Spotted something misplaced? ' + SITE + 'feedback.html']);
    aboutRows.push(['Terms', SITE + 'terms-and-conditions.html']);

    return [
      {
        name: 'Job postings',
        cols: COLUMNS.map(function (c) { return { w: c.w }; }),
        rows: dataRows
      },
      {
        name: 'Columns',
        cols: [{ w: 26 }, { w: 96 }, { w: 12 }],
        rows: dictRows
      },
      {
        name: 'About this file',
        cols: [{ w: 26 }, { w: 110 }],
        rows: aboutRows,
        filter: false
      }
    ];
  }

  /* ======================================================================
     The browser half: one small button in the filter panel.
     ====================================================================== */

  /** Signed in, as far as anything on this page can know. */
  function signedIn() {
    var A = G.OAAccounts;
    if (!A) return false;
    if (A.resolved && A.resolved()) return !!A.user();
    // before the session restores, the localStorage memory of the last one —
    // the same hint the account chip is painted from
    return A.hint && A.hint() === 'in';
  }

  function countLabel(n, total) {
    var of = (typeof total === 'number' && total !== n) ? ' of ' + total : '';
    return n + of + ' job posting' + (n === 1 ? '' : 's');
  }

  /**
   * The OAList action descriptor — the engine owns the filter bar and rebuilds
   * it, so the button is DECLARED here and rendered there (see the `actions`
   * option in assets/oa-list.js) rather than appended to a node that Clear
   * filters would throw away.
   */
  function action(opts) {
    opts = opts || {};
    return {
      key: 'export',
      className: 'oa-export',
      label: '↓ Excel',

      /* The label is deliberately short — the owner asked for something small
         and discrete — so the button says what it does everywhere a label
         cannot: its tooltip, its accessible name, and the count in both. */
      refresh: function (btn, api) {
        var A = G.OAAccounts;
        var n = api.view.length;
        var what = 'Download ' + (n === api.total ? 'all ' : 'these ') +
          countLabel(n, api.total) + ' as an Excel file (.xlsx)';
        /* No accounts module, or an SDK that could not be loaded — offline, a
           blocked CDN, an ad blocker — is the same thing here: nobody can sign
           in, so nobody can download. Say so rather than offering a button
           that would silently do nothing when pressed. */
        if (!A || (A.failed && A.failed())) {
          btn.disabled = true;
          btn.title = 'Sign-in is unavailable at the moment, so the download is too.';
        } else {
          btn.disabled = !n;
          btn.title = n
            ? (signedIn() ? what : what + ' — free, with an account')
            : 'Nothing to download: no posting matches these filters.';
        }
        btn.setAttribute('aria-label', btn.title);
      },

      onClick: function (api, btn) {
        var A = G.OAAccounts;
        if (!A) return;                       // no accounts module: no download
        /* THE GATE. whenSignedIn is the site's own primitive for exactly this:
           it runs now if the reader is signed in, QUEUES if the session is
           still restoring (so a click during that window is not silently
           lost), and offers the sign-in box if they are not. The filter bar
           this button sits in is already covered by the page's sign-in lock —
           this is the gate itself rather than the nudge, and it is what makes
           the button safe anywhere else it is ever mounted. */
        A.whenSignedIn(function () { run(api, btn, opts); });
      }
    };
  }

  /* Building the workbook is SYNCHRONOUS — a few hundred milliseconds of
     string-building for the whole catalogue — so there is no window for a
     second press to land in and nothing to guard against re-entering. */
  function run(api, btn, opts) {
    var meta = {
      at: new Date(),
      market: (opts && opts.market && opts.market()) || '',
      total: api.total,
      filters: api.filters
    };
    var name = fileName(meta);
    try {
      /* assets/oa-usage.js already records the press, like every other button
         on the site — there is nothing to note here. */
      OAXlsx.download(name, sheets(api.view, meta));
    } catch (e) {
      if (G.console) G.console.error('OA: the Excel download failed', e);
      if (G.alert) {
        G.alert('Sorry — the Excel file could not be prepared in this browser. ' +
          'Please try again, or let us know through the Feedback page.');
      }
    }
    return name;
  }

  return {
    COLUMNS: COLUMNS,
    CONTACT_FIELDS: CONTACT_FIELDS,
    WITHHELD: WITHHELD,
    PRIVACY_NOTE: PRIVACY_NOTE,
    sheets: sheets,
    fileName: fileName,
    action: action,
    signedIn: signedIn
  };
}));
