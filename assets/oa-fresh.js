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

  /* ------------------------------- the posting you just APPROVED, published */

  /** jobs-model text(), the browser twin. */
  function text(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 400);
  }

  /** A line that says the search has no closing date rather than naming one —
      jobreview.mjs OPEN_ENDED. */
  var OPEN_ENDED = /until\s*filled|open\s*until|rolling/i;
  /** jobs-model EMAIL_RX. Nothing under data/ may carry an address, and the
      echo must not show one the build is about to remove. */
  var EMAIL_RX = /[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

  /** jobs-model url(), the browser twin — host-shaped http(s) or nothing.
      A link the maintainer typed that this refuses is a link the build
      publishes as EMPTY, so an echo that showed it would show a posting whose
      advertisement link the site is about to drop. */
  function url(v) {
    var t = String(v == null ? '' : v).trim();
    return /^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(t) ? t.slice(0, 500) : '';
  }

  /** The three fields jobreview.mjs EDITABLE marks `url: true`. */
  var URL_EDITS = ['adUrl', 'postedAtUrl', 'furtherInfoUrl'];

  /**
   * jobreview.mjs approvedRow(), the browser twin — the row an APPROVED queue
   * document publishes: the maintainer's edits applied, the deadline line and
   * the three names settled against each other, e-mails out, and the posting
   * DATED FROM ITS APPROVAL.
   *
   * PARITY-PINNED in selftest.mjs against the real `approvedRow` over a case
   * table, which is what makes this safe to show anybody: an echo that
   * differed from what the build publishes would be a private fiction, and
   * that is exactly what this module's third promise forbids.
   *
   * `canonColumns` is INJECTED rather than imported — the browser passes
   * OASchools.canonColumns, Node passes the module's own — so this file keeps
   * no dependency of its own and the parity test can drive it offline, exactly
   * as the storage and the meta fetch are injected elsewhere here.
   *
   * `edits` arrive AS THE MAINTAINER TYPED THEM, and this used to claim they
   * arrived clean. They do not: `readEdits` reads the boxes through the field
   * LIST, never through `cleanEdit`, so the two rules a text input cannot
   * enforce for itself were missing from the echo. `maxlength` bounds the
   * length, the type is a select and the levels are checkboxes and the dates
   * are date inputs, so what was left to differ was exactly two things, and
   * both are applied here as twins of the build's own: a link that is not
   * host-shaped http(s) PUBLISHES AS EMPTY, and a country is canonicalised
   * ("USA" is served as "United States"). `canonCountry` is injected beside
   * `canonColumns` for the same reason — this file keeps no dependency of its
   * own — and with it absent the echo simply does not re-spell, which is a
   * spelling and never a value the build would refuse.
   */
  function approvedRow(row, doc, opts) {
    var o = opts || {};
    var canon = o.canonColumns || function (place) { return place; };
    var canonCountry = o.canonCountry || function (v) { return v; };
    var clean = (doc && doc.edits) || {};
    var out = {}, k, i;
    for (k in (row || {})) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
    for (k in clean) if (Object.prototype.hasOwnProperty.call(clean, k)) out[k] = clean[k];

    /* cleanEdit: an EDITED url and an EDITED country only. A value the row
       already carried came through the pipeline and is settled. */
    for (i = 0; i < URL_EDITS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(clean, URL_EDITS[i])) {
        out[URL_EDITS[i]] = url(text(clean[URL_EDITS[i]], 600));
      }
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'country')) {
      out.country = canonCountry(text(clean.country, 80)) || '';
    }

    /* A line the maintainer wrote that says the search stays open takes the
       date with it — the one direction where their words are the fact. */
    if ('applyBy' in clean && !('applyByDate' in clean) && OPEN_ENDED.test(clean.applyBy)) {
      out.applyByDate = '';
    }
    /* A first-review date on or after the closing date is the closing date
       said twice, or a contradiction, and is not published. */
    if (out.reviewDate && out.applyByDate && out.reviewDate >= out.applyByDate) {
      out.reviewDate = '';
    }

    /* settleDeadline: the LINE IS DERIVED, never echoed as edited. */
    var date = text(out.applyByDate, 10);
    if (date) {
      out.applyByDate = date;
      out.applyBy = longDate(date);
    } else {
      var line = text(out.applyBy, 400);
      out.applyByDate = '';
      out.applyBy = OPEN_ENDED.test(line) ? line : 'Until filled.';
    }

    /* settlePlace: one spelling per place, and the line is the two names
       joined. A row that never had parts keeps the line it arrived with — the
       sheet's own fallback — and one that HAD parts and no longer has any is a
       deliberate clearing. */
    var place = canon({
      institution: out.institution || '',
      school: out.school || '',
      unit: out.unit || '',
    }) || {};
    out.institution = place.institution || '';
    out.school = place.school || '';
    out.unit = place.unit || '';
    var joined = [out.school, out.unit].filter(Boolean).join(', ');
    out.department = joined
      || ((row && (row.school || row.unit)) ? '' : (out.department || ''));
    if (out.institution && ownUniversitiesLink(out.furtherInfoUrl)) {
      out.furtherInfoUrl = universitiesLink(out.institution);
    }

    /* stripRowEmails: every own string field except the URLs. */
    for (k in out) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
      if (typeof out[k] !== 'string' || /Url$/.test(k)) continue;
      if (out[k].indexOf('@') >= 0) out[k] = out[k].replace(EMAIL_RX, '[e-mail removed]');
    }

    /* DATED FROM ITS APPROVAL, because that is the day it reached the site and
       the day the e-mail alerts window on. A grandfathered document — whose
       reviewedAt and queuedAt are the same instant — keeps the date it had. */
    var reviewed = String((doc && doc.reviewedAt) || '');
    var queued = String((doc && doc.queuedAt) || '');
    if (reviewed && reviewed !== queued) {
      var t = Date.parse(reviewed);
      if (!isNaN(t)) {
        var stamp = new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
        if (!out.addedAt || out.addedAt < stamp) out.addedAt = stamp;
      }
    }
    return out;
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
   * key finds the served row). `removed: true` echoes a takedown, `added` a
   * WHOLE ROW the build has not published yet. `fields` come from echoFields()
   * below.
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
      added: entry.added || null,
      f: (entry.removed || entry.added) ? {} : pickFields(entry.fields || {}),
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

      /* A POSTING JUST APPROVED IS NOT ON THE SITE YET, so there is nothing to
         overlay onto — the whole row has to be put there. It is the echo's
         one ADD, and it earns that by being the row the build itself will
         publish: `approvedRow` above is parity-pinned against jobreview.mjs's
         own, so this browser is not inventing a posting, it is showing the
         one already decided a build early. The moment the build publishes it
         the served row wins and the echo is spent, like every other. */
      if (e.added) {
        if (row) { spent.push(docId); return; }    // the build published it
        out = out.concat([e.added]);
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
    approvedRow: approvedRow,
    composeApplyBy: composeApplyBy,
    universitiesLink: universitiesLink,
    ownUniversitiesLink: ownUniversitiesLink,
    overlay: overlay,
    isJobsUrl: isJobsUrl,
    apply: apply,
  };
}));
