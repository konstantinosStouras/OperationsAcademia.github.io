/* ---------------------------------------------------------------------------
   Operations Academia — settling a posting the market-year report has flagged.

   ONE definition, loaded by both consumers:

     the Admin area   <script src="assets/oa-yearcheck.js">  -> window.OAYearCheck
     the selftest     createRequire(...)                      -> module.exports

   WHAT THE REPORT IS. `data/jobs-yearcheck.json` names the published postings
   whose stored season is BEHIND what their own apply-by dates say
   (`marketYearReview` in _scraper/jobs-model.mjs). Nothing is re-filed: a
   posting's year is half its id, and an id that moves is a posting the merge
   can no longer match — published twice, with its card anchor and its Edit
   button pointing at a row nobody sees. So the disagreement is REPORTED and
   the maintainer decides.

   AND UNTIL NOW THERE WAS NO WAY TO DECIDE IT (owner, 2026-08-27: "I reviewed
   these jobs but can't clear that queue"). The panel offered exactly two
   exits, and neither is the answer for a posting that is filed correctly:

     - correct it in the tracking workbook, which MOVES it, and the report's
       own copy says two of the four it names today are plainly where they
       belong — a search advertised in September that stays open until the
       following July has a deadline a few weeks past the roll, and reading it
       literally would file a 2025-2026 search under 2026-2027;
     - or wait for the deadline to pass, which does not clear it either:
       Nanyang's passed on 28 July and it is still on the list, because what
       put it there is the roll, not the deadline.

   So the tile sat at 4 for ever — and its own comment in oa-adminarea.js
   already called it "something the maintainer clears — by settling each
   posting", which nothing implemented. This is the settling.

   THE DECISION IS KEYED ON THE DISAGREEMENT, NOT ON THE POSTING. A document
   records the exact pair the maintainer looked at — the season it is filed
   under, and the season its dates then gave it — and it silences THAT and
   nothing else. Correct a deadline afterwards, or let the roll move the
   answer, and the report is asking a different question: the posting comes
   back, unsettled, with the new pair on its card. That is the resolutionHash
   discipline the sibling repository's feedback resolutions use, and it is the
   whole safety argument for a settle: it cannot hide a disagreement nobody
   has read.

   ABSENCE MEANS SHOW — the opposite way round from the job-review queue, and
   deliberately. There, absence means withhold, because a queue that fails to
   write must not leak an unreviewed posting onto the site. Here the postings
   are ALREADY published and the risk runs the other way: a decisions read
   that fails must never make a disagreement invisible. So a posting with no
   document is open, and a read that throws leaves every posting open with the
   controls withheld (the panel says so) rather than an empty list.

   SETTLING IS NEVER A ONE-WAY DOOR, the rule `newsOverrides`, `rowOverrides`
   and `directoryEdits` all follow: a settled posting leaves the list — the
   list is meant to get shorter — but it goes into a collapsed disclosure
   below it, one click from Bring it back. Filtering it out entirely would
   leave nothing on the page to press, and the only way back would be the
   Firestore console.

   AND THE OLD OBJECTION NO LONGER HOLDS. This report was a served file rather
   than a Firestore queue partly because it "needs no rules deploy" — written
   when deploying rules meant an interactive `firebase deploy` that nothing in
   CI could perform. Since 2026-08-24 the rules publish themselves
   (_scraper/deploy-rules.mjs, .github/workflows/oa-deploy-rules.yml), so a
   collection costs a merge. The REPORT stays derived, which is the half that
   mattered: nothing here decides what is flagged, only what has been read.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAYearCheck = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLLECTION = 'yearChecks';

  /** The only decision there is. A posting is either waiting to be read or it
      has been read and left where it is; there is no third state, because
      "move it" is not something this panel can do — it is a correction in the
      tracking workbook, and the posting then leaves the report on its own. */
  var SETTLED = 'settled';

  /* Every key a decision document may carry. Pinned BOTH WAYS against the
     hasOnly() list in _firestore.rules by selftest.mjs — a key written here
     without a rule is a permission-denied at save time and a maintainer told
     to redeploy rules that are already deployed. */
  var DOC_KEYS = ['status', 'stored', 'should', 't'];

  function int(v) {
    var n = Number(v);
    return isFinite(n) ? Math.trunc(n) : 0;
  }

  /**
   * The document body that settles this reported posting.
   *
   * `stored` and `should` are the two seasons the card showed when the
   * maintainer pressed the button — the question they answered. `t` is when.
   * Nothing else: the posting itself is in `data/jobs.json`, and a copy of it
   * here would be one more thing to fall out of step.
   */
  function settlementFor(p, now) {
    return {
      status: SETTLED,
      stored: int(p && p.stored),
      should: int(p && p.should),
      t: (now || new Date()).toISOString()
    };
  }

  /**
   * Does this stored decision answer the report as it stands NOW?
   *
   * Both seasons must match. A posting whose dates have been corrected since
   * — or one the roll has moved on — is a different disagreement, and the
   * maintainer has not seen it.
   */
  function covers(doc, p) {
    if (!doc || !p) return false;
    if (String(doc.status || '') !== SETTLED) return false;
    return int(doc.stored) === int(p.stored) && int(doc.should) === int(p.should);
  }

  /**
   * The report, split into what is still waiting and what has been settled —
   * in the order the report itself gives, which already ranks the season under
   * way first.
   *
   * `docs` is an id -> document map; a missing one is a posting nobody has
   * read yet. `resettled` marks a settled posting whose disagreement has since
   * CHANGED, so the panel can say why it is back rather than appearing to
   * ignore a decision that was made.
   */
  function partition(postings, docs) {
    var d = docs || {};
    var out = { open: [], settled: [] };
    (postings || []).forEach(function (p) {
      if (!p || !p.id) return;
      var doc = d[p.id];
      if (covers(doc, p)) {
        out.settled.push({ p: p, doc: doc });
      } else {
        out.open.push({ p: p, resettled: !!doc && String(doc.status || '') === SETTLED });
      }
    });
    return out;
  }

  return {
    COLLECTION: COLLECTION,
    SETTLED: SETTLED,
    DOC_KEYS: DOC_KEYS,
    settlementFor: settlementFor,
    covers: covers,
    partition: partition
  };
}));
