/* ---------------------------------------------------------------------------
   Operations Academia — who has SPONSORED the site, and for how long.

   ONE definition, loaded by every consumer:

     the jobs page        <script src="assets/oa-sponsors.js">  -> window.OASponsors
     the one-pager teaser  the same tag                         -> window.OASponsors
     the Excel download    the same tag                         -> window.OASponsors
     the selftest          createRequire(...)                   -> module.exports

   A sponsoring department's postings LEAD the jobs page and carry a
   "Sponsored" badge (owner, 2026-08-29: CUHK Business School's Department of
   Decisions, Operations and Technology, from 1 September 2025 to 1 September
   2027 — "professional and discrete but visible to all users").

   WHY A CURATED TABLE HERE, AND NOT A FIELD IN `data/jobs.json`. Four
   reasons, and each of them is one of this repository's own recorded rules:

   1. A SPONSORSHIP EXPIRES. The window is tested when the card is drawn, so
      on 1 September 2027 the badge stops appearing by itself — no build to
      run, nothing to remember. A field stamped at build time is a claim about
      a moment that has passed: `oa-jobnav.js` is here for exactly that
      reason ("a build runs every twenty minutes and a deadline passes at
      midnight, so deciding in the browser is the only reading that cannot be
      stale"), and this is the same shape.

   2. A DERIVED FIELD ON EVERY ROW MAILS PHANTOM EDITS. `build-jobs.mjs`
      diffs the served file against the one about to replace it and e-mails
      the maintainer what changed; `withMarketYears` had to be skipped in
      `diffRows` precisely because the run that first writes a derived field
      changes every row exactly once. 575 postings, 575 phantom edits.

   3. NOTHING UNDER `data/` IS HAND-EDITED, and a served side file would need
      a builder, a place in `BUILDERS`, and a new way for a red guard to stop
      the whole site publishing. A curated table in `assets/` is what
      `oa-countries.js`, `oa-institutions.js` and `oa-omlist.js` already are,
      and it cannot fail a build.

   4. THE FROZEN ARCHIVES DO NOT MOVE. `/v1/` and `/v2/` keep their own
      assets and never load this file, so they go on rendering exactly as
      they did — which is the rule the three trees are held to.

   WHAT IT DELIBERATELY IS NOT: an advertising slot. It records a fact the
   site can state about a department — that they paid for this site over a
   named period — and the ONLY things it changes are the badge and the
   position. It never changes what a posting SAYS, never hides another
   posting, and never survives its own end date.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-schools.js'));
  } else {
    root.OASponsors = factory(root.OASchools);
  }
}(typeof self !== 'undefined' ? self : this, function (Schools) {
  'use strict';

  /** What the badge says. One string, so the pages, the export and the tests
      cannot disagree about the word. */
  var LABEL = 'Sponsored';

  /* ------------------------------------------------------------ the record

     ONE ENTRY PER SPONSORING DEPARTMENT. `units` is a LIST because a
     department is named several ways by the several sources this site reads
     (the posting form's own box, the crowdsourced tracking workbook's
     hiring-unit column, the legacy import) — the same reason
     `oa-schools.js` carries alias tables. Every entry is CURATED: a name
     goes in because somebody checked it names this department, never
     because it looked close enough.

     `from` is inclusive, `to` is EXCLUSIVE — "to 1 September 2027" is the
     day the sponsorship ends, not its last day. */
  var SPONSORS = [
    {
      /* CUHK Business School, Department of Decisions, Operations and
         Technology. Matched through institutionKey, so "CUHK", "Chinese
         University of Hong Kong" and "The Chinese University of Hong Kong"
         all reach it — and "The Chinese University of Hong Kong, Shenzhen"
         deliberately does NOT: institutionKey keeps the two apart, they are
         separate universities, and the site carries three Shenzhen postings
         that are nothing to do with this sponsorship. */
      institution: 'The Chinese University of Hong Kong',
      school: 'CUHK Business School',
      /* …and the spellings their postings are ACTUALLY filed under. The
         served file carries one under "CUHK Business School" — the SCHOOL's
         name typed into the university box, which is an ordinary thing for a
         poster to do and which institutionKey keeps as a key of its own
         ("cuhk business school"), so the entry above would never reach it.
         Curated one measured spelling at a time, exactly like every alias
         table here: "CUHK Shenzhen" also exists in the data and is a
         DIFFERENT university, which is why this is a list of names somebody
         checked and not a pattern. */
      alsoFiledAs: ['CUHK Business School'],
      units: ['Decisions, Operations and Technology'],
      from: '2025-09-01',
      to: '2027-09-01'
    }
  ];

  /* ------------------------------------------------------------- matching */

  /** Fold a department name to compare it: lower case, "&" as "and", and
      every run of anything that is not a letter or a digit as one space.
      The same reading `oa-schools.js` and `oa-alert-match.js` take, so
      "Decisions, Operations & Technology" reaches the record. */
  function fold(v) {
    return String(v == null ? '' : v)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** The university, folded so any spelling of one place reaches one entry.
      `institutionKey` is oa-schools.js's own answer to "is this the same
      university?" — it drops a leading "The" and a trailing acronym and
      resolves "CUHK", while keeping a campus that names itself separately
      ("…, Shenzhen") separate.

      IT RETURNS NOTHING WHEN THAT MODULE IS ABSENT, and that is the whole
      point of writing it out. The first draft fell back to `fold`, which is
      a HALF answer: "The Chinese University of Hong Kong" still matched
      itself, so the selftest — which requires oa-schools.js through Node —
      stayed green, while a browser on a page that had not loaded it silently
      stopped recognising "CUHK", "Chinese University of Hong Kong" and
      "The Chinese University of Hong Kong (CUHK)". Measured: three spellings
      marked in Node and unmarked on the site, with nothing anywhere saying
      so. That is exactly the two-halves-disagreeing failure oa-jobnav.js was
      written to remove, and a fallback that is right most of the time is the
      worst possible shape for it. So this says NO when it cannot tell, like
      every other curated table here, and testSponsors pins that both pages
      load the module BEFORE this one. */
  function uniKey(v) {
    if (!Schools || typeof Schools.institutionKey !== 'function') return '';
    return Schools.institutionKey(v);
  }

  /** A day string ("2026-08-27") from whatever a row carries. ISO dates
      compare correctly as strings, which is why nothing here parses one. */
  function day(v) {
    var s = String(v == null ? '' : v).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  }

  /** Today, as the same kind of string. `now` is injectable everywhere in
      this file so the tests can stand on either side of a window's edge. */
  function today(now) {
    var d = now instanceof Date ? now : (now ? new Date(now) : new Date());
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }

  /** Is this sponsorship running on `when`? Inclusive of `from`, exclusive
      of `to`. */
  function runningOn(sponsor, when) {
    return !!when && when >= sponsor.from && when < sponsor.to;
  }

  /** Does this sponsor answer to the university key the row carries? Its own
      name, or one of the spellings its postings are known to be filed under. */
  function namesInstitution(sponsor, uni) {
    if (uniKey(sponsor.institution) === uni) return true;
    var also = sponsor.alsoFiledAs || [];
    for (var i = 0; i < also.length; i++) {
      if (uniKey(also[i]) === uni) return true;
    }
    return false;
  }

  /** The department a row names. The posting form asks for the school and
      the department separately, so `unit` is the department on its own and
      `department` is the two joined — but the tracking workbook and the
      legacy import fill only the joined one, in which case it IS the bare
      department. Ask `unit` first and fall back, which reads both shapes
      without ever splitting a string on a guess. */
  function unitOf(row) {
    return String((row && (row.unit || row.department)) || '');
  }

  /* ------------------------------------------------------------------ API */

  /**
   * The sponsor record this posting belongs to, or null.
   *
   * BOTH GATES MUST PASS, and they answer two different questions:
   *
   *   the sponsorship is running TODAY   — so the badge is true in the
   *                                        present tense, and stops being
   *                                        drawn the day the deal ends;
   *   the posting went up INSIDE it      — so a posting advertised before
   *                                        they became a sponsor is not
   *                                        retrospectively one of theirs.
   *
   * A row with no posting date fails the second and is never sponsored:
   * this says no when it cannot tell, like every other curated table here.
   */
  function sponsorFor(row, now) {
    if (!row) return null;
    var when = today(now);
    var posted = day(row.posted);
    if (!when || !posted) return null;

    var uni = uniKey(row.institution);
    if (!uni) return null;
    var unit = fold(unitOf(row));
    if (!unit) return null;

    for (var i = 0; i < SPONSORS.length; i++) {
      var s = SPONSORS[i];
      if (!runningOn(s, when) || !runningOn(s, posted)) continue;
      if (!namesInstitution(s, uni)) continue;
      for (var j = 0; j < s.units.length; j++) {
        if (fold(s.units[j]) === unit) return s;
      }
    }
    return null;
  }

  /** The same question as a boolean — what the card, the sort and the
      export all actually ask. */
  function isSponsored(row, now) {
    return !!sponsorFor(row, now);
  }

  /**
   * The comparator the jobs page sorts by: a sponsored posting leads,
   * then a Featured one, then the newest.
   *
   * SPONSORED ABOVE FEATURED because a sponsorship is a commitment the site
   * has made to somebody and Featured is a note the maintainer left
   * themselves. Nothing is featured today, so the two have never had to be
   * ranked before; this writes down the order rather than leaving it to
   * whichever line was typed first.
   *
   * It is a TOTAL order over the whole list, not a "when no filter is set"
   * special case: a bar that re-sorts itself as the reader types would be a
   * worse surprise than a sponsor leading a search they are not in — and
   * they will not be in most of them, since narrowing by anywhere but Hong
   * Kong drops them entirely. Featured has always worked this way.
   */
  function compare(a, b, now) {
    var sa = isSponsored(a, now), sb = isSponsored(b, now);
    if (sa !== sb) return sa ? -1 : 1;
    var fa = !!(a && a.featured), fb = !!(b && b.featured);
    if (fa !== fb) return fa ? -1 : 1;
    return String((b && b.posted) || '').localeCompare(String((a && a.posted) || ''));
  }

  /** The badge, in the shape `card.badges` returns — or null. The pages ask
      for it rather than building it, so the word and the class live here. */
  function badge(row, now) {
    return isSponsored(row, now)
      ? { text: LABEL, cls: 'oa-label-sponsor' }
      : null;
  }

  /** The class the card carries, which is what draws the rail down its edge
      (owner picked the pill AND the rail). Applied from `onCard`. */
  var CARD_CLASS = 'oa-sponsored';

  /** Put the rail on — or take it off, so a re-render can never leave a
      stale one behind. */
  function markCard(li, row, now) {
    if (li && li.classList) li.classList.toggle(CARD_CLASS, isSponsored(row, now));
    return li;
  }

  return {
    LABEL: LABEL,
    SPONSORS: SPONSORS,
    CARD_CLASS: CARD_CLASS,
    fold: fold,
    day: day,
    today: today,
    runningOn: runningOn,
    namesInstitution: namesInstitution,
    unitOf: unitOf,
    sponsorFor: sponsorFor,
    isSponsored: isSponsored,
    compare: compare,
    badge: badge,
    markCard: markCard
  };
}));
