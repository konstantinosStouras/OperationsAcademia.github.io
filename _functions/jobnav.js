/* ---------------------------------------------------------------------------
   Operations Academia — WHICH PAGE a posting is on, and how to open THAT one.

   ONE definition, loaded by all four consumers:

     the jobs page          <script src="assets/oa-jobnav.js">  -> window.OAJobNav
     the previous markets   the same tag                        -> window.OAJobNav
     the Admin area's market-year report                        -> window.OAJobNav
     the selftest           createRequire(...)                  -> module.exports

   TWO THINGS THAT USED TO BE THREE COPIES OF ONE RULE. jobs.html and
   previous-markets.html each carried their own `marketYear()` and
   `inCurrentMarket()`, byte-identical to each other and to jobs-model.mjs's,
   and the Admin area was about to need a third. The site already knows what a
   copy of a rule costs — `oa-countries.js`, `oa-schools.js`, `oa-news.js` and
   `oa-alert-match.js` all exist because two copies of one answer disagree
   silently — so the rule lives here and the pages read it. Its parity with
   _scraper/jobs-model.mjs is pinned by selftest.mjs over every served posting,
   because the two sides of the site must not disagree about which season a
   posting is in.

   WHY A PAGE, NOT A HASH. The market-year report on /admin-area linked every
   flagged posting as `jobs.html#job-<id>` and neither half of that worked
   (owner, 2026-08-27):

     - the ANCHOR is never there to land on. The engine renders ten cards a
       page, so the element only exists when the posting happens to be on the
       page being shown; and the list is built from a fetch, so at the moment
       the browser looks for the fragment there is nothing in the document at
       all. The reader arrived at the top of the full list, every time.
     - and the PAGE is wrong for half of them. jobs.html shows the market year
       under way; a posting flagged here is one whose season disagrees with its
       own dates, which is exactly the population most likely to have rolled
       out of that window. The owner's report was Nanyang: filed under
       2025-2026, still open on paper, and therefore on Previous markets — so
       the link opened a list that could not contain it.

   So a posting is opened by a QUERY PARAMETER the list engine understands
   (?job=<id>, OAList's `focusParam`), on the page that actually carries it —
   which `inCurrentMarket` decides here, from the row itself, at the moment the
   link is drawn rather than at the moment the report was built. A build runs
   every twenty minutes and a deadline passes at midnight, so a posting can
   move between the two pages between builds; deciding in the browser is the
   only reading that cannot be stale.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAJobNav = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* A market year runs 1 July of the previous year to 30 June of its own and
     is numbered by the year it ENDS, so the roll is 1 July — getUTCMonth() is
     0-based, hence 6. Keep in step with MARKET_ROLL_MONTH in
     _scraper/jobs-model.mjs; selftest.mjs pins the two together. */
  var MARKET_ROLL_MONTH = 6;

  /** The URL parameter that opens ONE posting. Owned by the list engine
      (OAList's `focusParam`), named here so the pages and the report that
      links to them cannot spell it differently. */
  var FOCUS_PARAM = 'job';

  var JOBS_PAGE = 'jobs.html';
  var PAST_PAGE = 'previous-markets.html';

  function day(v) {
    return String(v == null ? '' : v).slice(0, 10);
  }

  /** The season under way at `now`. */
  function marketYear(now) {
    var d = now || new Date();
    return d.getUTCFullYear() + (d.getUTCMonth() >= MARKET_ROLL_MONTH ? 1 : 0);
  }

  /** The first day of that season. */
  function marketStart(now) {
    return (marketYear(now) - 1) + '-07-01';
  }

  /** '2026-2027' — how every page heads itself. A HYPHEN, byte-for-byte
      `marketLabel` in _scraper/jobs-model.mjs, which is what the data says;
      selftest.mjs pins the two. (The Admin area's cards print an en-dash,
      which is that panel's typography and not a label anything reads back.) */
  function marketLabel(year) {
    var y = Math.trunc(Number(year) || 0);
    return y ? (y - 1) + '-' + y : '';
  }

  /**
   * Is this posting still open for applications at `now`?
   *
   * The deadline DATE is the only signal. `applyByDate` is empty exactly when
   * the search is open-ended ("Until filled") or no deadline was given at all,
   * so an empty date is not an open deadline — it is the ABSENCE of one, and
   * cannot keep a posting on the page for ever. A deadline falling today still
   * counts: applications close at the end of the day named.
   */
  function deadlineOpen(row, now) {
    var d = day(row && row.applyByDate);
    return !!d && d >= (now || new Date()).toISOString().slice(0, 10);
  }

  /**
   * Does this row belong on the JOBS page, which shows only the season under
   * way? An OPEN deadline keeps a posting there whatever season it was filed
   * in (owner, 2026-08-17).
   *
   * Byte-for-byte the same rule as `inCurrentMarket` in
   * _scraper/jobs-model.mjs — pinned by selftest.mjs over every served
   * posting, not merely over a fixture list.
   */
  function inCurrentMarket(row, now) {
    var at = now || new Date();
    return deadlineOpen(row, at)
        || day(row && row.posted) >= marketStart(at)
        || Number(row && row.year) >= marketYear(at);
  }

  /** Which of the two list pages carries this posting today. */
  function pageFor(row, now) {
    return inCurrentMarket(row, now) ? JOBS_PAGE : PAST_PAGE;
  }

  /** …and the same answer in the words the report puts on a card. */
  function pageLabelFor(row, now) {
    return inCurrentMarket(row, now) ? 'Job postings' : 'Previous markets';
  }

  /**
   * A link that opens ONE posting on whichever page carries it.
   *
   * The id is the query VALUE, so it is encoded rather than interpolated —
   * a row's id is derived from an institution name somebody typed.
   */
  function hrefFor(row, now) {
    var id = String((row && row.id) || '');
    if (!id) return pageFor(row, now);
    return pageFor(row, now) + '?' + FOCUS_PARAM + '=' + encodeURIComponent(id);
  }

  /** The other page, for the "not here" message when a focused posting has
      moved (or been taken down) since the link was drawn. */
  function otherPage(pathname) {
    return String(pathname || '').indexOf(PAST_PAGE) !== -1 ? JOBS_PAGE : PAST_PAGE;
  }

  /* ------------------------------------- the posting's own ID, on the card

     Owner, 2026-09-02: "add the OA job posting ID to each job posting at the
     bottom of it to be publicly shown for easy reference". The id is the one
     name a posting has everywhere — the permalink (?job=<id>), the join key
     for edits and takedowns, the row the Admin area and the run logs name —
     so a reader quoting it to the maintainer, or the maintainer quoting it
     back, is talking about exactly one posting. It is the LAST row of the
     card's details on every list that draws a posting, through this one
     function so the three pages cannot word it three ways.

     It is drawn as a link to the posting's own permalink (hrefFor: the one
     card, on whichever page carries it today), so "copy link address" is the
     shareable form of the same reference. The html is built here with its
     own escaping because an id is derived from a name somebody typed.

     ONE identifier, and it is the id (owner, 2026-09-06: "why do you have two
     'OA posting ID'? Keep one of them and don't make things too complicated.
     Include one OA posting ID across all postings made this job market
     year"). The first build printed the form's own reference number (`ref`,
     OA-JOB-…) beside the id on a posting that had one, so a posting made
     through the form carried two ID-shaped strings under one label while a
     crawled one carried one. The id is the identifier EVERY posting has —
     the workbook's rows and the legacy import mint no `ref` — so it is the
     one that can be the same across all of them, and `ref` is not read here
     at all. It keeps its own jobs elsewhere: the poster's own receipt, the
     takedown and the join in the pipeline. */
  var REF_LABEL = 'OA posting ID';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function refRow(row, now) {
    var id = String((row && row.id) || '');
    if (!id) return null;
    return {
      label: REF_LABEL,
      html: '<a class="oa-ref" href="' + escapeHtml(hrefFor(row, now)) + '">' +
        escapeHtml(id) + '</a>'
    };
  }

  return {
    MARKET_ROLL_MONTH: MARKET_ROLL_MONTH,
    FOCUS_PARAM: FOCUS_PARAM,
    JOBS_PAGE: JOBS_PAGE,
    PAST_PAGE: PAST_PAGE,
    marketYear: marketYear,
    marketStart: marketStart,
    marketLabel: marketLabel,
    deadlineOpen: deadlineOpen,
    inCurrentMarket: inCurrentMarket,
    pageFor: pageFor,
    pageLabelFor: pageLabelFor,
    hrefFor: hrefFor,
    otherPage: otherPage,
    REF_LABEL: REF_LABEL,
    refRow: refRow
  };
}));
