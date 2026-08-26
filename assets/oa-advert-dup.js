/* ---------------------------------------------------------------------------
   Operations Academia — one advertisement, one posting.

   ONE definition, loaded by BOTH sides, exactly like oa-countries.js:

     the browser   <script src="assets/oa-advert-dup.js">      -> window.OAAdvertDup
     the pipeline  createRequire(...)('.../oa-advert-dup.js')  -> module.exports

   WHY IT IS SHARED. Two things decide the same question and must never
   disagree about it: the sheet sync, which drops a crawled row rather than
   queueing it, and the Admin area's "Check for duplicate adverts" button,
   which sweeps the queue on demand. A browser copy of the rule would drift
   from the pipeline's the first time either was corrected — the drift every
   other shared module here exists to prevent — so `_scraper/jobreview.mjs`
   re-exports this file rather than carrying its own.

   WHAT IT DECIDES. A crawled posting is a REPEAT of one already listed when
   they name the same advertisement and nothing about the two contradicts that
   reading. `duplicatesOf` (jobreview.mjs) raises an amber flag for a person to
   judge; this DECIDES, so its guards are what keep a real posting out of the
   bin.

   DECIDING ON A SHARED LINK IS EXACTLY WHAT THIS REPOSITORY THREW AWAY ONCE,
   so it is scoped by measurement rather than by hope. CLAUDE.md records a
   file-level "no two postings name the same advertisement" rule written,
   measured and abandoned, because City University of Hong Kong links its whole
   vacancies page from two market YEARS' postings and UCD links one CoreHR
   endpoint from two. Measured over the 542 served postings on 2026-08-26,
   grouped by (market year, university, advertisement link): 481 groups hold
   exactly ONE posting and exactly one holds two — UCD's endpoint, carrying MIS
   and Supply Chain Management. Within a year at one university the link
   identifies the advertisement 481 times out of 482, and the single exception
   is told apart by its DEPARTMENT.

   Hence the three contradictions, each of which keeps a real posting:
     - the market year and the university must match      (the CityU case)
     - two rows both naming a department, differently     (the UCD case)
     - two rows whose entry levels share nothing          (the Houston lesson)

   Run over the whole served corpus, none of the 542 is judged a repeat of
   another — the check that says the guards are not merely plausible.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-schools.js'));
  } else {
    root.OAAdvertDup = factory(root.OASchools);
  }
}(typeof self !== 'undefined' ? self : this, function (SCHOOLS) {
  'use strict';

  var schools = SCHOOLS || {};
  function institutionKey(v) {
    return schools.institutionKey ? schools.institutionKey(v) : String(v || '').toLowerCase();
  }
  function foldedName(v) {
    return schools.fold ? schools.fold(String(v || '')) : String(v || '').toLowerCase();
  }

  /**
   * The row's ADVERTISEMENT link, normalised — the one field the owner named
   * ("Link to the advert"). `duplicatesOf` also reads `postedAtUrl` because a
   * FLAG can afford the wider net; this decides on its own, so it keeps to the
   * link that identifies the advertisement itself.
   *
   * Our own home page identifies nothing — a workbook row naming no
   * advertisement carries it — and neither does an empty cell.
   */
  function advertLink(row) {
    var v = String((row && row.adUrl) || '').trim().toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    return v && !/^operationsacademia\.org$/.test(v) ? v : '';
  }

  /** Enough for a person to recognise the posting a repeat points at, and no
      more: a document is not a place to copy whole rows into. */
  function entry(r) {
    return {
      id: String((r && r.id) || ''),
      ref: String((r && r.ref) || ''),
      source: String((r && r.source) || ''),
      institution: String((r && r.institution) || ''),
      department: String((r && r.department) || ''),
      posted: String((r && r.posted) || '')
    };
  }

  /**
   * The posting `row` is simply a repeat of, or null. See the header for why
   * each guard is there and what it measured.
   */
  function advertRepeat(row, others) {
    if (!row || !row.institution) return null;
    var link = advertLink(row);
    if (!link) return null;

    var key = institutionKey(row.institution);
    var levels = Object.prototype.toString.call(row.levels) === '[object Array]'
      ? row.levels : [];
    var unit = foldedName(row.unit);
    var line = foldedName(row.department);
    var list = others || [];

    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.institution) continue;
      if (String(s.id || '') === String(row.id || '')) continue;
      if (Number(s.year) !== Number(row.year)) continue;
      if (institutionKey(s.institution) !== key) continue;
      if (advertLink(s) !== link) continue;

      var sLevels = Object.prototype.toString.call(s.levels) === '[object Array]'
        ? s.levels : [];
      if (levels.length && sLevels.length) {
        var shares = false;
        for (var j = 0; j < levels.length; j++) {
          if (sLevels.indexOf(levels[j]) !== -1) { shares = true; break; }
        }
        if (!shares) continue;
      }

      /* The department, read from the bare unit where both name one and from
         the shown line otherwise — two names for one place fold equal, and a
         row that names none contradicts nothing. */
      var sUnit = foldedName(s.unit);
      if (unit && sUnit) { if (unit !== sUnit) continue; }
      else if (line && foldedName(s.department) !== line) continue;

      return entry(s);
    }
    return null;
  }

  /**
   * Sweep a whole set of candidate rows against what is already listed.
   *
   * EXACTLY ONE SURVIVOR PER ADVERTISEMENT, which a per-row check cannot give
   * on its own: two queued rows naming one advertisement are each a repeat of
   * the other, so checking them independently against the same list would drop
   * BOTH and lose the posting altogether. So a row that is kept joins the list
   * the rest are measured against, and the survivor is whichever comes first —
   * callers hand them over oldest-first, so the one that has been waiting
   * longest is the one that stays.
   *
   * Returns `{ drop: [{ row, of }], keep: [row] }`; `drop` is in the order the
   * rows were given, so a caller can report it as it goes.
   */
  function findAdvertRepeats(rows, listed) {
    var kept = (listed || []).slice();
    var drop = [];
    var keep = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      var of = advertRepeat(row, kept);
      if (of) drop.push({ row: row, of: of });
      else { kept.push(row); keep.push(row); }
    }
    return { drop: drop, keep: keep };
  }

  /** What the dropped document says it is, for whoever goes looking. It is
      written into `note`, which the rules already allow — no new key, so no
      rules change and no document the panel is then refused permission to
      update (the sync-user-directory lesson). */
  function repeatNote(of) {
    return 'Dropped automatically: it advertises the same vacancy as '
      + ((of && (of.ref || of.id)) || 'a posting already listed')
      + (of && of.institution ? ' (' + of.institution + ')' : '')
      + ', which is already live or already in the queue. Approve that one '
      + 'instead; nothing was published from this row.';
  }

  return {
    advertLink: advertLink,
    advertRepeat: advertRepeat,
    findAdvertRepeats: findAdvertRepeats,
    repeatNote: repeatNote
  };
}));
