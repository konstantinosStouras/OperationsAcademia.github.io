/* ---------------------------------------------------------------------------
   Operations Academia — the edit you just saved, shown before the build lands.

   Saving an edit to a posted job writes Firestore and rings the build
   (publishOnChange in _functions/index.js), and the corrected posting is
   served about a minute later — but the person who pressed Save is looking
   at the jobs page NOW, and for that minute (or for the 20-minute schedule,
   when the doorbell function is not deployed) the site shows them the very
   text they just corrected. An edit that does not show looks like an edit
   that did not save.

   So the form leaves an ECHO in this browser's localStorage — the published
   shape of what was just saved — and every page that renders data/jobs.json
   overlays it onto the served rows at read time. The pipeline is not
   touched: this is the header-hint idea (paint from what this browser
   already knows) applied to a posting, and the oa-rowedit idea (an overlay
   on top of the committed file) applied locally.

   HONEST BY CONSTRUCTION, three ways:

     - it is PER BROWSER. Only the editor sees the echo; everyone else sees
       the served file, exactly as before. Nothing here can show a visitor
       an unpublished value, because nothing here leaves the machine.
     - it EXPIRES against the build, not against hope: an echo is dropped the
       moment the served row carries every echoed value (the publish landed),
       or when data/jobs-meta.json says a build GENERATED comfortably after
       the save has published (whatever that build wrote is the truth, even
       where it disagrees — the build's sanitisers, stripEmails among them,
       have the last word), or after an hour, whichever comes first.
     - it echoes only what the build would publish: the fields are a pinned
       subset of jobs-model's PUBLIC_FIELDS, the Apply-by line is composed by
       a browser twin of composeApplyBy (parity-pinned in selftest.mjs), and
       the values come out of the form AFTER canonColumns() and the name
       fixes — the same "the preview reads the way the posting will publish"
       guarantee the form already keeps.

   A takedown echoes as a REMOVAL: the row is off the list on this device the
   moment the confirm is answered, exactly as the button's note now says.

   Dual-mode like oa-news.js: the pages load it as window.OAFresh, and
   selftest.mjs requires it to drive the pure half (overlay, echoFields,
   composeApplyBy) offline — storage and the meta fetch are injected, so Node
   never needs a browser.
   --------------------------------------------------------------------------- */

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OAFresh = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var KEY = 'oaFreshJobs';
  /** The worst honest pipeline delay, twice over. After this the echo stands
      down whatever happened — a stuck build must not pin this browser to a
      value the rest of the world never saw. */
  var TTL_MS = 60 * 60 * 1000;
  /** A build whose `generated` stamp is this far past the save started AFTER
      the save, so what it published includes it (or deliberately does not —
      the build's word wins either way). */
  var BUILD_GRACE_MS = 90 * 1000;
  var CAP = 20;

  /** What an edit may echo — a SUBSET of jobs-model's PUBLIC_FIELDS, pinned
      against it in selftest.mjs. Identity and bookkeeping (id, year, posted,
      addedAt, source, ref, owner, featured) are deliberately absent: an edit
      does not move a posting's identity, and the echo must not either. */
  var FIELDS = [
    'institution', 'school', 'unit', 'department', 'type', 'levels', 'country',
    'applyBy', 'applyByDate', 'reviewDate', 'comments', 'characteristics',
    'adUrl', 'postedAtUrl',
  ];

  /* ------------------------------------------------- browser twins, pinned */

  /** jobs-model composeApplyBy(), the browser twin — parity-pinned in
      selftest.mjs over a case table, like every vendored copy here. */
  function composeApplyBy(v) {
    var note = String(v.applyByNote == null ? '' : v.applyByNote)
      .replace(/\s+/g, ' ').trim().slice(0, 400);
    if (v.untilFilled) return note ? 'Until filled. ' + note : 'Until filled.';
    return [v.applyByDate ? longDate(v.applyByDate) : '', note]
      .filter(Boolean).join('. ');
  }

  function longDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return names[+m[2] - 1] + ' ' + (+m[3]) + ', ' + (+m[1]);
  }

  /** jobs-model universitiesLink()/ownUniversitiesLink(), the browser twins —
      a renamed institution regenerates OUR "Further info" link exactly as
      settlePlace/healPlace do, and never touches a link the poster gave. */
  function universitiesLink(institution) {
    return 'https://www.operationsacademia.org/universities?filterA='
      + encodeURIComponent(institution);
  }
  function ownUniversitiesLink(v) {
    return /^https?:\/\/(www\.)?operationsacademia\.org\/universities\?filterA=/i
      .test(String(v == null ? '' : v));
  }

  /* --------------------------------------------------------------- storage */

  function storage() {
    try { return (typeof window !== 'undefined' && window.localStorage) || null; }
    catch (e) { return null; }               // storage disabled: no echo, no error
  }

  function readAll(store, now) {
    var s = store || storage();
    if (!s) return {};
    var map;
    try { map = JSON.parse(s.getItem(KEY) || '{}') || {}; }
    catch (e) { map = {}; }
    // prune what has aged out, so the map cannot grow for ever
    var out = {};
    Object.keys(map).forEach(function (k) {
      var e = map[k];
      if (e && typeof e === 'object' && now - (e.t || 0) < TTL_MS) out[k] = e;
    });
    return out;
  }

  function writeAll(store, map) {
    var s = store || storage();
    if (!s) return;
    try { s.setItem(KEY, JSON.stringify(map)); } catch (e) { /* full: no echo */ }
  }

  /* ----------------------------------------------------------------- stash */

  /**
   * Remember what was just saved. `docId` is the Firestore document the form
   * edited; `ref` the posting's OA-JOB reference where it has one (a
   * migrated or sheet-mirror posting's row id IS its document id, so either
   * key finds the served row). `removed: true` echoes a takedown. `fields`
   * come from echoFields() below.
   */
  function stash(entry, opts) {
    var o = opts || {};
    var now = o.now || Date.now();
    if (!entry || !entry.docId) return;
    var map = readAll(o.store, now);
    map[String(entry.docId)] = {
      t: now,
      ref: String(entry.ref || ''),
      removed: !!entry.removed,
      f: entry.removed ? {} : pickFields(entry.fields || {}),
    };
    // oldest out beyond the cap — nobody edits twenty postings in an hour,
    // and a bug that does must not fill this browser's storage
    var keys = Object.keys(map).sort(function (a, b) { return map[a].t - map[b].t; });
    while (keys.length > CAP) delete map[keys.shift()];
    writeAll(o.store, map);
  }

  function pickFields(fields) {
    var out = {};
    FIELDS.forEach(function (k) {
      if (k in fields) out[k] = fields[k];
    });
    return out;
  }

  /**
   * The echo of one saved submission document — the published shape of what
   * the form just wrote, mapped exactly as the build maps it. `doc` is what
   * collect() produced (already canonicalised and name-fixed); a document
   * carrying a fresh FILE upload echoes no advert link, because the build
   * replaces it with the Drive link and until then the posting has none.
   */
  function echoFields(doc) {
    var f = {
      institution: doc.institution || '',
      school: doc.school || '',
      unit: doc.unit || '',
      department: doc.department || '',
      type: doc.type || '',
      levels: (doc.levels || []).slice(),
      country: doc.country || '',
      applyByDate: doc.applyByDate || '',
      reviewDate: doc.reviewDate || '',
      applyBy: composeApplyBy(doc),
      comments: doc.comments || '',
      characteristics: (doc.characteristics || []).slice(),
      postedAtUrl: doc.postedAtUrl || '',
    };
    if (!doc.adUploadPath) f.adUrl = doc.adUrl || '';
    return f;
  }

  /* --------------------------------------------------------------- overlay */

  function sameValue(a, b) {
    return JSON.stringify(a === undefined ? '' : a)
      === JSON.stringify(b === undefined ? '' : b);
  }

  function rowFor(rows, entry) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      if (entry.ref && r.ref === entry.ref) return r;
      if (String(r.id || '') === String(entry.docId)) return r;
    }
    return null;
  }

  /**
   * The pure half: `overlay(rows, map, { now, builtAt })` returns
   * `{ rows, spent }` — the rows with every live echo applied, and the keys
   * of the echoes whose job is DONE (published, superseded by a later build,
   * or aged out), for the caller to delete. Never mutates a served row it
   * does not change; removals filter the row out.
   */
  function overlay(rows, map, opts) {
    var o = opts || {};
    var now = o.now || Date.now();
    var builtAt = o.builtAt ? Date.parse(o.builtAt) : NaN;
    var spent = [];
    var out = rows;

    Object.keys(map || {}).forEach(function (docId) {
      var e = map[docId];
      e.docId = docId;

      if (now - (e.t || 0) >= TTL_MS) { spent.push(docId); return; }
      /* A build that STARTED after the save has published. Its word wins even
         where it disagrees with the echo — the build's sanitisers have the
         last word — so the echo stands down. */
      if (Number.isFinite(builtAt) && builtAt > (e.t || 0) + BUILD_GRACE_MS) {
        spent.push(docId);
        return;
      }

      var row = rowFor(out, e);

      if (e.removed) {
        if (!row) { spent.push(docId); return; }   // the build took it down
        out = out.filter(function (r) { return r !== row; });
        return;
      }

      if (!row) return;                            // not served (yet): nothing to echo onto

      var landed = Object.keys(e.f || {}).every(function (k) {
        return sameValue(e.f[k], row[k]);
      });
      if (landed) { spent.push(docId); return; }

      Object.keys(e.f || {}).forEach(function (k) { row[k] = e.f[k]; });
      /* The site's own link follows the name, here as everywhere: ours is
         ours to regenerate, a link the poster gave is never touched. */
      if (e.f.institution && ownUniversitiesLink(row.furtherInfoUrl)) {
        row.furtherInfoUrl = universitiesLink(e.f.institution);
      }
    });

    return { rows: out, spent: spent };
  }

  /* ------------------------------------------------------- the page's hook */

  /** Is this URL the jobs dataset? The one file this module overlays. */
  function isJobsUrl(url) {
    return /(^|\/)data\/jobs\.json(\?|$)/.test(String(url || ''));
  }

  /**
   * The browser entry point, called by OAList.load (and previous-markets'
   * own fetch) with whatever was just parsed. Any other URL — and the common
   * case, an empty stash — passes straight through at zero cost; only a live
   * echo pays the one small fetch of data/jobs-meta.json that decides
   * whether a build has landed since the save.
   */
  function apply(url, rows) {
    if (!isJobsUrl(url) || !Array.isArray(rows)) return rows;
    var now = Date.now();
    var map = readAll(null, now);
    if (!Object.keys(map).length) return rows;

    return fetch('/data/jobs-meta.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (meta) {
        var got = overlay(rows, map, {
          now: now,
          builtAt: (meta && meta.generated) || '',
        });
        if (got.spent.length) {
          var fresh = readAll(null, Date.now());
          got.spent.forEach(function (k) { delete fresh[k]; });
          writeAll(null, fresh);
        }
        return got.rows;
      });
  }

  return {
    KEY: KEY,
    FIELDS: FIELDS,
    TTL_MS: TTL_MS,
    BUILD_GRACE_MS: BUILD_GRACE_MS,
    stash: stash,
    echoFields: echoFields,
    composeApplyBy: composeApplyBy,
    universitiesLink: universitiesLink,
    ownUniversitiesLink: ownUniversitiesLink,
    overlay: overlay,
    isJobsUrl: isJobsUrl,
    apply: apply,
  };
}));
