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

   For generic links the three contradictions keep a real posting. A known
   vacancy-specific requisition ID is stronger evidence than scraped rank or
   department labels and overrides those two guards, never market/university.
   Unrecognised URLs and similar descriptions alone do not prove duplication.

   Hence the three contradictions for generic links:
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
    v = String(v || '').replace(/^\s*\(duplicate\s+with\s+#\d+\)\s*/i, '');
    return schools.institutionKey ? schools.institutionKey(v) : String(v || '').toLowerCase();
  }
  function foldedName(v) {
    return schools.fold ? schools.fold(String(v || '')) : String(v || '').toLowerCase();
  }

  /**
   * The row's ADVERTISEMENT link, normalised — the one field the owner named
   * ("Link to the advert"). `duplicatesOf` also reads `postedAtUrl` because a
   * application link is also evidence only when it contains a recognised
   * vacancy-specific identifier. A shared application portal proves nothing.
   *
   * Our own home page identifies nothing — a workbook row naming no
   * advertisement carries it — and neither does an empty cell.
   */
  function advertLink(row) {
    var raw = String((row && row.adUrl) || '').trim();
    var v;
    try {
      var u = new URL(raw);
      u.hash = '';
      Array.from(u.searchParams.keys()).forEach(function (k) {
        if (/^(utm_.+|fbclid|gclid)$/i.test(k) ||
            (/^(www\.)?higheredjobs\.com$/i.test(u.hostname) && /^title$/i.test(k))) u.searchParams.delete(k);
      });
      u.searchParams.sort();
      v = u.toString().replace(/^https?:\/\/(www\.)?/i, '').replace(/\/?$/, '').toLowerCase();
    } catch (_) { v = raw.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, ''); }
    return v && !/^operationsacademia\.org$/.test(v) ? v : '';
  }

  // Only identifiers known to address ONE vacancy may override differing
  // department/rank labels. Generic search/landing pages keep all old guards.
  function vacancyKey(row) {
    var link = advertLink(row);
    var m;
    // Verified syndication: both full adverts name Bellarmine position
    // 202704, Fall 2027, with identical hiring text (checked 2026-10-25).
    // These exact advert IDs alone are aliases; similar titles prove nothing.
    if (/^jobs\.chronicle\.com\/job\/38016580(?:[/?]|$)/.test(link) ||
        /^higheredjobs\.com\/.*[?&]jobcode=179597757(?:&|$)/.test(link)) return 'bellarmine:202704';
    if ((m = link.match(/^higheredjobs\.com\/.*[?&]jobcode=(\d+)/))) return 'hej:' + m[1];
    if ((m = link.match(/^([^/]+\.interviewexchange\.com)\/.*[?&]jobid=(\d+)/))) return m[1] + ':' + m[2];
    if ((m = link.match(/^(?:apply\.interfolio\.com\/|dossier\.interfolio\.com\/apply\/)(\d+)(?:[/?]|$)/))) return 'interfolio:' + m[1];
    if ((m = link.match(/^((?:jobs|careers)\.[^/]+\.edu)\/postings\/(\d+)(?:[/?]|$)/))) return m[1] + ':' + m[2];
    if ((m = link.match(/^cityu\.edu\.hk\/hro\/.*[?&]ref=uac-([a-z\d]+)/))) return 'cityu:' + m[1];
    if ((m = link.match(/^([^/]+\.varbi\.com)\/.*jobid(?:%3a|:)(\d+)/))) return m[1] + ':' + m[2];
    if ((m = link.match(/^([^/]+\.myworkdayjobs\.com)\/.*[_/](jr[\w-]+)(?:[/?]|$)/))) return m[1] + ':' + m[2];
    return '';
  }

  function vacancyKeys(row) {
    return [vacancyKey(row), vacancyKey({ adUrl: row.postedAtUrl })].filter(Boolean);
  }

  function sameVacancy(a, b) {
    var adA = vacancyKey(a), adB = vacancyKey(b);
    // Distinct requisitions on the same host are explicit contrary evidence,
    // even if an application URL was copied incorrectly onto both records.
    if (adA && adB && adA !== adB &&
        adA.slice(0, adA.lastIndexOf(':')) === adB.slice(0, adB.lastIndexOf(':'))) return false;
    var aa = vacancyKeys(a), bb = vacancyKeys(b);
    return aa.some(function (k) { return bb.indexOf(k) !== -1; });
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

  // Admission rule for new crawled jobs: a published advert or Posted at link is enough,
  // regardless of the scraped institution, market year, department or rank.
  // Callers supply published rows only; pending comparisons retain their guards.
  function publishedAdvertRepeat(row, published) {
    if (!row) return null;
    var links = [advertLink(row), advertLink({ adUrl: row.postedAtUrl })].filter(Boolean);
    if (!links.length) return null;
    var match = (published || []).find(function (other) {
      if (!other || (row.id && other.id && String(row.id) === String(other.id))) return false;
      return [advertLink(other), advertLink({ adUrl: other.postedAtUrl })].some(function (link) {
        return link && links.indexOf(link) !== -1;
      });
    });
    return match ? entry(match) : null;
  }

  /**
   * The posting `row` is simply a repeat of, or null. See the header for why
   * each guard is there and what it measured.
   */
  function advertRepeat(row, others) {
    if (!row || !row.institution) return null;
    var link = advertLink(row);
    if (!link && !vacancyKeys(row).length) return null;

    var key = institutionKey(row.institution);
    var levels = Object.prototype.toString.call(row.levels) === '[object Array]'
      ? row.levels : [];
    var unit = foldedName(row.unit);
    var line = foldedName(row.department);
    var list = others || [];

    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.institution) continue;
      if (s.id && row.id && String(s.id) === String(row.id)) continue;
      if (Number(s.year) !== Number(row.year)) continue;
      if (institutionKey(s.institution) !== key) continue;
      var sharedVacancy = sameVacancy(row, s);
      // The incoming advert itself naming the existing application ID proves
      // identity despite a research-area department label (Ohio State). A
      // copied application link alone still needs compatible metadata below.
      var directVacancy = vacancyKey(row);
      if (sharedVacancy && directVacancy && (directVacancy === vacancyKey(s) ||
          // Verified 2026-10-25: Ohio State R160519 / Interfolio 195349
          // is the optimization search, also posted with its ISE department.
          (directVacancy === 'interfolio:195349' && vacancyKeys(s).indexOf(directVacancy) !== -1))) return entry(s);
      if (!sharedVacancy && (!link || advertLink(s) !== link)) continue;

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
    publishedAdvertRepeat: publishedAdvertRepeat,
    vacancyKey: vacancyKey,
    advertRepeat: advertRepeat,
    findAdvertRepeats: findAdvertRepeats,
    repeatNote: repeatNote
  };
}));
