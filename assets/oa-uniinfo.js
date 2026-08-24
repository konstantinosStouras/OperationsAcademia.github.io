/* ---------------------------------------------------------------------------
   Operations Academia — what the site's own records say about a place, and
   the posting form's pre-fill + write-back built on it.

   ONE definition, loaded by BOTH sides, exactly like oa-schools.js:

     the browser   <script src="assets/oa-uniinfo.js">  -> window.OAUniInfo
     the tests     createRequire(...)('.../oa-uniinfo.js') -> module.exports

   WHY THIS EXISTS (owner, 2026-08-24). A poster who types "INSEAD" into the
   job form is being asked questions the site can already answer — the type of
   institution, the country of the campus, which school, which department, the
   department's own page, whether the school runs research seminars or a PhD
   programme. All of it is in data/directory.json, the Universities directory
   the site displays. So the form PRE-FILLS what the records answer, asks the
   poster to VERIFY it, and a correction flows BACK into the records — the
   posting's own fields through the ordinary pipeline (they are published and
   the next directory build re-reads them), and the department link through a
   `directoryEdits` document, the same read-time overlay every signed-in
   user's corrections on universities.html already use.

   ONLY A DEFINITE ANSWER IS FILLED. INSEAD lists two departments, so the
   department box stays empty for the poster; its campuses are in three
   countries, so the country box stays empty too (the row abstains with a
   `countries` list — the campusCountries discipline). A unique school, a
   unanimous type, a single-campus country, and the matched row's link and
   checklist are filled — into an EMPTY field, or over this module's own
   earlier fill, never over anything the poster typed (the maybeFillType
   discipline throughout).

   THE WRITE-BACK IS BOUNDED AND HONEST. Exactly one thing is written outside
   the posting itself: a department link that DIFFERS from the record, saved as
   `directoryEdits/{rowId}` with `{ deptUrl, rowId, by, name, t }` via a MERGE
   set, so a document holding somebody's other corrections keeps them. An
   empty field never erases a recorded link, a row the maintainer has hidden
   is never written to, and a failure is logged and swallowed — nothing here
   may ever be the reason a posting fails to send. The row id is
   OASchools.directoryRowKey, the ONE definition the build stamps onto
   data/directory.json, so a correction can never be filed against a row that
   does not exist — including a place posting here for the first time, whose
   row (and card) the very build that publishes the posting creates.

   Entirely optional, like the place picker: no fetch, no module, no Firestore
   just means no pre-fill, and the form works exactly as it did.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAUniInfo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIR_URL = 'data/directory.json';
  var COLLECTION = 'directoryEdits';
  /* the fields a directoryEdits document may override on a row — the same
     seven assets/oa-directory.js edits, pinned against the rules' hasOnly
     list by the selftest */
  var EDIT_FIELDS = ['institution', 'school', 'department', 'type',
    'country', 'deptUrl', 'facultyUrl'];
  var DEPT_URL_MAX = 600;

  function trim(v) { return String(v === null || v === undefined ? '' : v).trim(); }

  /* --------------------------------------------------- the overlay (pure)

     directory.json + the community's directoryEdits → the rows the facts are
     read from, the same overlay universities.html applies at read time
     (oa-directory.js overlaid()). Without it, a department link a user
     corrected there — or through this very form — would go on being offered
     to every later poster as the record, and their "no change" would confirm
     a value the site no longer shows. */
  function overlay(rows, edits) {
    var out = [];
    var i, k;
    for (i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      var copy = {};
      for (k in r) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
      var e = edits && edits[copy.id];
      if (e && !e.add) {
        for (var j = 0; j < EDIT_FIELDS.length; j++) {
          var key = EDIT_FIELDS[j];
          if (Object.prototype.hasOwnProperty.call(e, key)) copy[key] = e[key];
        }
        /* an editor who NAMED one country answered what the multi-campus row
           abstained from — the same rule oa-directory.js applies */
        if (Object.prototype.hasOwnProperty.call(e, 'country')) delete copy.countries;
        if (e.hidden) copy._hidden = true;
      }
      out.push(copy);
    }
    for (k in edits || {}) {
      if (!Object.prototype.hasOwnProperty.call(edits, k)) continue;
      var a = edits[k];
      if (!a.add || !a.institution || a.hidden) continue;
      out.push({
        id: a.rowId || k,
        institution: a.institution,
        school: a.school || '',
        department: a.department || '',
        type: a.type || '',
        country: a.country || '',
        deptUrl: a.deptUrl || '',
        facultyUrl: a.facultyUrl || '',
      });
    }
    return out;
  }

  /* ------------------------------------------------------ the facts (pure)

     What the records ANSWER for the three names as typed so far. Every field
     is '' (or []) unless the answer is definite:

       school    the ONE school named at that university;
       unit      the ONE department in scope — within the named school, or
                 across the university while no school is named;
       type      the type EVERY typed row of the university agrees on;
       country   the single-campus country — a university any of whose rows
                 carries a `countries` list spans countries and answers
                 nothing, however its postings vote (INSEAD);
       row       the one directory row the names identify — the poster's
                 school and department (or the unique fills above), with the
                 school-less form finding its one schooled home, the same
                 fold the build itself applies;
       deptUrl / facultyUrl / characteristics   the matched row's own record;
       rowId     where a correction to that record is filed — the matched
                 row's id, or the id the build WILL mint for a new place.

     `S` is assets/oa-schools.js, passed in rather than imported so the tests
     can hand over the required copy — the vocab.mjs shape. */
  function facts(rows, place, S) {
    var out = { row: null, rowId: '', school: '', unit: '', type: '',
      country: '', deptUrl: '', facultyUrl: '', characteristics: [] };
    place = place || {};
    var inst = trim(place.institution);
    var school = trim(place.school);
    var unit = trim(place.unit);
    if (!S || !inst || !rows || !rows.length) return out;

    var ik = S.institutionKey(inst);
    if (!ik) return out;
    var own = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && !r._hidden && S.institutionKey(r.institution || '') === ik) own.push(r);
    }
    if (!own.length) return out;

    var foldSchool = function (v) { return v ? S.fold(S.canonSchool(v, inst)) : ''; };
    var foldUnit = function (v) { return v ? S.fold(S.canonUnit(v, inst)) : ''; };

    /** first-seen name per folded key — [names], one per distinct place */
    function distinct(values, key) {
      var seen = {}, list = [];
      for (var j = 0; j < values.length; j++) {
        var v = trim(values[j]);
        if (!v) continue;
        var k = key(v);
        if (!k || seen[k]) continue;
        seen[k] = true;
        list.push(v);
      }
      return list;
    }

    var schools = distinct(own.map(function (r) { return r.school; }), foldSchool);
    if (schools.length === 1) out.school = schools[0];

    /* the department scope narrows with the school, exactly as the picker's
       lists do; while no school is named the whole university is the scope */
    var sk = foldSchool(school);
    var scoped = sk ? own.filter(function (r) { return foldSchool(r.school) === sk; }) : own;
    var units = distinct(scoped.map(function (r) { return r.department; }), foldUnit);
    if (units.length === 1) out.unit = units[0];

    var types = distinct(own.map(function (r) { return r.type; }), function (v) { return v; });
    if (types.length === 1) out.type = types[0];

    var multiCampus = own.some(function (r) { return r.countries && r.countries.length > 1; });
    if (!multiCampus) {
      var cs = distinct(own.map(function (r) { return r.country; }), function (v) { return v; });
      if (cs.length === 1) out.country = cs[0];
    }

    /* the one row the names identify — the poster's own school and unit
       first, the unique fills standing in for what they left empty */
    var wantSchool = sk || foldSchool(out.school);
    var wantUnit = foldUnit(unit) || foldUnit(out.unit);
    if (wantUnit) {
      var hit = own.filter(function (r) {
        return foldUnit(r.department) === wantUnit && foldSchool(r.school) === wantSchool;
      });
      /* a school-less ask finds its ONE schooled home — the same fold the
         build applies to a school-less posting (directory-model.mjs), so the
         correction lands on the row the site actually shows */
      if (!hit.length && !wantSchool) {
        hit = own.filter(function (r) {
          return r.school && foldUnit(r.department) === wantUnit;
        });
      }
      if (hit.length === 1) {
        out.row = hit[0];
        out.rowId = hit[0].id || '';
        if (!out.school && hit[0].school) out.school = hit[0].school;
        out.deptUrl = trim(hit[0].deptUrl);
        out.facultyUrl = trim(hit[0].facultyUrl);
        out.characteristics = (hit[0].characteristics || []).slice();
      }
    }

    /* where a correction files when NO committed row matches: the id the
       build will mint for this very posting's row. The names must be the
       published (canonical) ones — the submit path passes the same values
       the submission document carries. */
    if (!out.rowId && S.directoryRowKey) {
      out.rowId = S.directoryRowKey(inst, school || out.school, unit || out.unit);
    }
    return out;
  }

  /* Whether a typed department link is a CORRECTION the record needs.
     An empty field never erases a recorded link, and the record's own value
     needs no write. Pure, so the selftest pins the three cases. */
  function deptUrlPatch(recorded, typed) {
    var v = trim(typed).slice(0, DEPT_URL_MAX);
    if (!v || v === trim(recorded)) return '';
    return v;
  }

  /* ================================================== the browser half == */

  var state = {
    rowsPending: null,   // the directory.json fetch, memoized
    editsPending: null,  // the directoryEdits read, memoized (best-effort)
    edits: {},
  };

  function loadRows(url) {
    if (!state.rowsPending) {
      state.rowsPending = fetch(url || DIR_URL, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { return Array.isArray(rows) ? rows : null; })
        .catch(function () { state.rowsPending = null; return null; });
    }
    return state.rowsPending;
  }

  function loadEdits() {
    if (!state.editsPending) {
      if (!(typeof window !== 'undefined' && window.OAFB && window.OAFB.enabled)) {
        state.editsPending = Promise.resolve(state.edits);
      } else {
        state.editsPending = window.OAFB.ready().then(function (fb) {
          return fb.firestore().collection(COLLECTION).get();
        }).then(function (snap) {
          snap.forEach(function (d) {
            var v = d.data() || {};
            state.edits[v.rowId || d.id] = v;
          });
          return state.edits;
        }).catch(function () { return state.edits; });
      }
    }
    return state.editsPending;
  }

  /** The overlaid record, or null while it has not arrived. */
  function record(url) {
    return Promise.all([loadRows(url), loadEdits()]).then(function (got) {
      return got[0] ? overlay(got[0], state.edits) : null;
    });
  }

  /**
   * Mount the pre-fill on the posting form's fields.
   *
   *   els   { institution, school, unit,            the three name inputs
   *           type,                                 the <select>
   *           country,                              the country input
   *           deptUrl, deptUrlNote,                 the link input + its note
   *           chars, charsNote }                    #f-chars + its note
   *
   * Everything optional — a field not handed over is simply not filled. Each
   * fill goes into an EMPTY field or over this module's own earlier fill
   * (marked data-oa-auto-*), never over what the poster typed, and dispatches
   * the events the rest of the form listens for (the picker's rescope, the
   * draft, the derived department line).
   */
  function wire(els, opts) {
    els = els || {};
    opts = opts || {};
    var inst = els.institution, school = els.school, unit = els.unit;
    if (!inst || !school || !unit || typeof window === 'undefined' || !window.OASchools) return null;
    var S = window.OASchools;

    var listeners = [];
    var dead = false;
    var timer = null;
    var lastAutoChars = '';

    function on(el, type, fn) {
      if (!el) return;
      el.addEventListener(type, fn);
      listeners.push([el, type, fn]);
    }

    function val(el) { return el ? trim(el.value) : ''; }

    /** Fill an EMPTY field, or correct/retire this module's own earlier
        fill — never a value the poster typed. `value` may be '', which
        clears a stale auto-fill after the university changed. Returns
        whether anything was written. */
    function autoFill(el, attr, value, events) {
      if (!el) return false;
      var own = el.getAttribute(attr) || '';
      var current = trim(el.value);
      if (current && current !== own) return false;    // the poster's — theirs
      /* a fill the poster then CLEARED is a decision, not an empty box —
         "the department sits directly under the university" is said by
         emptying the school field, and refilling it would fight them */
      if (own && !current && value === own) { el.removeAttribute(attr); return false; }
      if (current === value) return false;             // nothing to do
      el.value = value;
      if (value) el.setAttribute(attr, value);
      else el.removeAttribute(attr);
      (events || ['input']).forEach(function (t) {
        el.dispatchEvent(new Event(t, { bubbles: true }));
      });
      return true;
    }

    function charBoxes() {
      if (!els.chars) return [];
      return Array.prototype.slice.call(
        els.chars.querySelectorAll('input[type="checkbox"]'));
    }

    function charSig(values) { return values.slice().sort().join('|'); }

    function tickedChars() {
      return charBoxes().filter(function (b) { return b.checked; })
        .map(function (b) { return b.value; });
    }

    function fillChars(list) {
      var boxes = charBoxes();
      if (!boxes.length) return;
      var ticked = charSig(tickedChars());
      // an untouched checklist, or exactly this module's own earlier fill
      if (ticked && ticked !== lastAutoChars) return;
      var want = {};
      list.forEach(function (v) { want[v] = true; });
      var changed = false;
      boxes.forEach(function (b) {
        var to = !!want[b.value];
        if (b.checked === to) return;
        b.checked = to;
        changed = true;
        b.dispatchEvent(new Event('change', { bubbles: true }));
      });
      lastAutoChars = charSig(list);
      if (els.charsNote) {
        els.charsNote.textContent = list.length
          ? 'Pre-filled from the site’s records for this department — ' +
            'please untick anything that no longer applies, and tick what is missing.'
          : '';
      }
      return changed;
    }

    function noteDeptUrl(f) {
      if (!els.deptUrlNote) return;
      if (!f.row) { els.deptUrlNote.textContent = ''; return; }
      els.deptUrlNote.textContent = f.deptUrl
        ? 'From the site’s records — please check it still points at the ' +
          'department’s page, and correct it if it has moved.'
        : 'The site has no page on record for this department — adding a link ' +
          'updates the Universities directory for everyone.';
    }

    function resolve() {
      if (dead) return;
      record(opts.dirUrl).then(function (rows) {
        if (dead || !rows) return;
        var f = facts(rows, {
          institution: val(inst), school: val(school), unit: val(unit),
        }, S);

        /* names first — a filled school narrows the department's scope, so
           facts are read again over the settled values. NOT in edit mode
           (opts.fillNames === false): a posting whose owner deliberately
           left the school off must not gain one because the form was opened
           — the same reasoning fill() in oa-jobform.js records for the
           events it does not fire. */
        if (opts.fillNames !== false) {
          var named = autoFill(school, 'data-oa-auto-school', f.school, ['input', 'change']);
          named = autoFill(unit, 'data-oa-auto-unit', f.unit, ['input', 'change']) || named;
          if (named) {
            f = facts(rows, {
              institution: val(inst), school: val(school), unit: val(unit),
            }, S);
          }
        }

        /* the picker's own attribute, deliberately: both fillers only ever
           write an empty select or their own earlier guess, so either may
           correct the other's */
        if (els.type) {
          var t = els.type;
          var auto = t.getAttribute('data-oa-auto-type') || '';
          if (f.type && (!t.value || t.value === auto) && t.value !== f.type) {
            t.value = f.type;
            t.setAttribute('data-oa-auto-type', f.type);
            t.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        autoFill(els.country, 'data-oa-auto-country', f.country);
        autoFill(els.deptUrl, 'data-oa-auto-depturl', f.row ? f.deptUrl : '');
        noteDeptUrl(f);
        fillChars(f.row ? f.characteristics : []);
        if (typeof opts.onFacts === 'function') opts.onFacts(f);
      });
    }

    function schedule() {
      /* after the picker's own change handlers have settled the values —
         snapPlace rewrites a field into its published spelling on the same
         event this listens for */
      clearTimeout(timer);
      timer = setTimeout(resolve, 0);
    }

    on(inst, 'input', schedule);
    on(inst, 'change', schedule);
    on(school, 'input', schedule);
    on(school, 'change', schedule);
    on(unit, 'input', schedule);
    on(unit, 'change', schedule);
    loadRows(opts.dirUrl);   // start the record loading beside the vocabulary
    loadEdits();
    schedule();              // an edit form may open with the names already in

    return {
      resolve: resolve,
      destroy: function () {
        dead = true;
        clearTimeout(timer);
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners.length = 0;
      },
    };
  }

  /**
   * File the poster's department-link correction, after their posting was
   * accepted. `place` is the submission's own (canonical) names; `deptUrl`
   * the value the form validated. Resolves quietly with nothing written when
   * the link matches the record, the field was empty, or the row is hidden.
   * BEST-EFFORT BY CONTRACT: the caller fires and forgets — a failure here
   * must never surface on the poster's confirmation.
   */
  function commit(args) {
    args = args || {};
    var uid = args.uid;
    if (!uid || typeof window === 'undefined' || !window.OAFB || !window.OAFB.enabled) {
      return Promise.resolve(null);
    }
    var S = window.OASchools;
    if (!S) return Promise.resolve(null);
    return record(args.dirUrl).then(function (rows) {
      var f = facts(rows || [], args.place, S);
      if (f.row && f.row._hidden) return null;        // the maintainer took it down
      var patch = deptUrlPatch(f.deptUrl, args.deptUrl);
      if (!patch || !f.rowId) return null;
      var doc = {
        rowId: f.rowId,
        by: uid,
        name: trim(args.name).slice(0, 120),
        t: Date.now(),
        deptUrl: patch,
      };
      return window.OAFB.ready().then(function (fb) {
        /* a MERGE, so a document holding somebody's other corrections keeps
           them — this path only ever speaks for the link */
        return fb.firestore().collection(COLLECTION).doc(f.rowId).set(doc, { merge: true });
      }).then(function () {
        var held = state.edits[f.rowId] || {};
        for (var k in doc) if (Object.prototype.hasOwnProperty.call(doc, k)) held[k] = doc[k];
        state.edits[f.rowId] = held;
        return doc;
      });
    });
  }

  return {
    facts: facts,
    overlay: overlay,
    deptUrlPatch: deptUrlPatch,
    wire: wire,
    commit: commit,
    loadRows: loadRows,
    DIR_URL: DIR_URL,
    COLLECTION: COLLECTION,
    EDIT_FIELDS: EDIT_FIELDS,
  };
}));
