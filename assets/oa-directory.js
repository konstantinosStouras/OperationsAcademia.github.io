/* ---------------------------------------------------------------------------
   Operations Academia — the Universities DIRECTORY: cards, search, and the
   community's own corrections.

   WHAT THIS DRAWS. universities.html's card list: ONE CARD PER UNIVERSITY
   (owner, 2026-08-24 — "who does Operations at Michigan?" is one card), its
   schools inside the card, each school's departments inside it, over
   data/directory.json — the flat table _scraper/build-directory.mjs merges
   from the curated archive, the oa-institutions.js seed and every posting
   ever made here. The list itself is the shared OAList engine, so the search
   fields, chips, URL state and the whole mobile treatment are inherited, not
   re-implemented (_MOBILE-STANDARDS.md rule 0).

   WHO MAY EDIT. Any REGISTERED USER (owner, 2026-08-24) — this is the
   rowOverrides pattern with the write opened from the maintainer to every
   signed-in account: a correction is a Firestore `directoryEdits/{rowId}`
   document overlaid AT READ TIME, so the committed file stays the source of
   truth, an edit reaches every visitor within a reload, and rebuilding the
   file can never undo one. Every document carries WHO (uid + display name)
   and WHEN, and each card shows its "Last edited by … on …" line from that.
   Adding a department is a `directoryEdits` document too (`add: true`), and
   an edit that renames a row to names another row already carries MERGES the
   two on screen — which is the owner's merge tool.

   WHO MAY DO MORE. The maintainer alone hides a row (the duplicate half of a
   merge), restores one, or resets an edit back to the committed file — and
   alone sees the "Last edited" filter, which exists to drive a review sweep.
   AUTHORISATION IS THE RULES (`directoryEdits` in _firestore.rules), never
   this file: everything here only decides what is DRAWN.

       OADirectory.mount({ mount: '#oa-dir' });   // the whole list
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var COLLECTION = 'directoryEdits';

  /* The fields an edit may change, in the order the form shows them. The key
     set is a SUBSET of what _firestore.rules allows — selftest.mjs pins the
     two together BOTH WAYS, exactly as it does for oa-rowedit.js.

     `scope` is where a field lives in the ONE-FORM-PER-SCHOOL editor (owner,
     2026-10-05): a 'school' field is the school's own and is asked ONCE, at
     the top of the form, for every department in it; a 'dept' field belongs to
     one department and is asked once per department. Each department is still
     its own `directoryEdits` document underneath, so the rules, the overlay and
     the build are exactly what they were; only the asking changed. */
  var FIELDS = [
    { key: 'institution', scope: 'school', label: 'University', max: 220,
      hint: 'The full official name. Changing it moves every department below to that university’s card.' },
    { key: 'school', scope: 'school', label: 'School', max: 200,
      hint: 'For example "Haas School of Business". Leave it empty when the department reports to the university itself.' },
    { key: 'country', scope: 'school', label: 'Country', max: 80,
      hint: 'The full name, for example "United States".' },
    { key: 'type', scope: 'school', label: 'School type', max: 40, kind: 'type' },
    { key: 'department', scope: 'dept', label: 'Department', max: 260,
      hint: 'The full official department, area or group name.' },
    { key: 'deptUrl', scope: 'dept', label: 'Department page', max: 600, kind: 'url' },
    { key: 'facultyUrl', scope: 'dept', label: 'Faculty directory page', max: 600, kind: 'url' },
  ];

  /* The two stored type values and the empty one, as the form offers them:
     three radio buttons rather than a box that had to be typed exactly. */
  var TYPE_CHOICES = [
    { value: 'Business School', label: 'Business school' },
    { value: 'University', label: 'Non-business school (engineering, IEOR, information…)' },
    { value: '', label: 'Not recorded' },
  ];

  /* What a school-level radio group answers when its departments DIFFER and
     the reader has not chosen: leave each department as it is. Never stored. */
  var KEEP = '__keep__';

  /* What the two stored type values are CALLED on this page. The stored
     vocabulary is the posting form's ("Business School" / "University"); the
     in-card school chips and the School-type filter speak the owner's wording
     for the second one, which is the whole point of it — an IEOR department is
     not a business school. The card TOP deliberately carries no type badge
     (owner, 2026-08-24: not needed above the university's name) — the chips
     live on each school section inside the opened card. */
  var TYPE_LABEL = { 'Business School': 'Business school', University: 'Non-business school' };

  var EDIT_BUCKETS = ['Edited today', 'Last 7 days', 'Last 30 days', 'Older edits', 'Never edited'];

  var state = {
    flat: [],          // directory.json as served
    flatLoaded: false, // …and whether it has actually arrived yet
    cards: [],         // ONE array for the list's lifetime — regroup() refills it
    edits: {},         // docId → document
    ready: false,      // the edits read resolved (either way)
    user: null,
    admin: false,
    list: null,
    host: null,
    form: null,        // the ONE edit form open on the page, with what is typed in it
    flash: null,       // "Saved." under the card a form was just saved from
  };

  /* ------------------------------------------------------------------ utils */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fold(s) { return window.OAList ? OAList.fold(s) : String(s || '').toLowerCase(); }

  function instKey(s) {
    return window.OASchools ? OASchools.institutionKey(String(s || '')) : fold(s);
  }

  function fmtDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return (+m[3]) + ' ' + names[+m[2] - 1] + ' ' + m[1];
  }

  function fmtStamp(t) {
    var d = new Date(Number(t) || 0);
    if (!isFinite(d.getTime()) || !t) return '';
    return fmtDay(d.getFullYear() + '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2));
  }

  function editBucket(t) {
    if (!t) return 'Never edited';
    var days = (Date.now() - Number(t)) / 86400000;
    if (days < 1) return 'Edited today';
    if (days <= 7) return 'Last 7 days';
    if (days <= 30) return 'Last 30 days';
    return 'Older edits';
  }

  // the same guard as OAList.safeUrl, for links drawn into card HTML
  function safeUrl(u) { return window.OAList ? OAList.safeUrl(u) : ''; }

  /* --------------------------------------------------------- the overlay

     directory.json + directoryEdits → the rows the cards are grouped from.
     PURE over its inputs: fresh copies every time, so a regroup never
     accumulates earlier passes. */

  function overlaid() {
    var out = [];
    var i, k, r;
    for (i = 0; i < state.flat.length; i++) {
      r = state.flat[i];
      var copy = {};
      for (k in r) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
      var e = state.edits[copy.id];
      if (e && !e.add) {
        for (var j = 0; j < FIELDS.length; j++) {
          var key = FIELDS[j].key;
          if (Object.prototype.hasOwnProperty.call(e, key)) copy[key] = e[key];
        }
        /* A multi-campus row abstains from naming ONE country and carries
           `countries` instead (directory-model.mjs). An editor who then
           NAMES one has answered the question the build could not, so their
           answer stands alone rather than beside the abstention's list. */
        if (Object.prototype.hasOwnProperty.call(e, 'country')) delete copy.countries;
        copy._edit = { name: e.name || '', t: e.t || 0 };
        if (e.hidden) copy._hidden = true;
      }
      out.push(copy);
    }
    /* A row a signed-in user ADDED — a department no source carries yet. It
       is a full row of its own, so it groups into its university's card (or
       stands up a new card) exactly like a built one. */
    for (k in state.edits) {
      if (!Object.prototype.hasOwnProperty.call(state.edits, k)) continue;
      var a = state.edits[k];
      if (!a.add || !a.institution) continue;
      out.push({
        id: a.rowId || k,
        institution: a.institution,
        school: a.school || '',
        department: a.department || '',
        type: a.type || '',
        country: a.country || '',
        deptUrl: a.deptUrl || '',
        facultyUrl: a.facultyUrl || '',
        sources: ['user'],
        n: 0,
        lastPosted: '',
        _edit: { name: a.name || '', t: a.t || 0 },
        _hidden: !!a.hidden,
        _added: true,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------- grouping */

  /* The card's title: the spelling most rows use, a tie to the longer (fuller)
     name. ONE definition, OASchools.cardName, because the same title is the
     name the registration form's affiliation list offers and the name a
     member's affiliation is standardised to (data/university-names.json,
     written by the build through the same function). The page loads
     oa-schools.js first, which the selftest pins; without it the card falls
     back to its first row's spelling rather than to a second copy of the rule. */
  function displayNameOf(rows) {
    var names = rows.map(function (r) { return r.institution; });
    return window.OASchools && OASchools.cardName ? OASchools.cardName(names) : (names[0] || '');
  }

  /** The names a row is ONE ROW by: its university, school and department
      through the same canon the posting form applies, so a correction lands
      on the site's one spelling. regroup() folds two rows sharing it into the
      first, and the add form (and the school form, for a department a user
      added) refuses to make a second. One definition, so the
      fold and the refusal cannot disagree about what "the same place" is. */
  function rowKeyOf(r) {
    var canon = window.OASchools ? OASchools.canonColumns : null;
    var inst = r.institution || '', school = r.school || '', dept = r.department || '';
    if (canon) {
      var c = canon({ institution: inst, school: school, unit: dept });
      inst = c.institution; school = c.school; dept = c.unit;
    }
    if (!inst) return '';
    return instKey(inst) + '||' + fold(school) + '||' + fold(dept);
  }

  /** The row the table already lists under these names, if any: a user-added
      document that collides with one is unreachable rather than a duplicate.
      regroup() folds it into the built row, the built row keeps the id every
      control carries, the add row's values fill the built row's blanks, the
      maintainer's Hide on the built row is undone by the add row standing in
      for it, and nothing on the page reaches the add document at all.

      `rows` is the table to look in: the school form passes the table AS IT
      WILL BE once its save lands, so a department added by a user cannot be
      renamed onto another department the same save is renaming too. */
  function existingRow(doc, exceptId, rows) {
    var key = rowKeyOf({ institution: doc.institution, school: doc.school, department: doc.department });
    if (!key) return null;
    rows = rows || overlaid();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (exceptId && r.id === exceptId) continue;
      if (rowKeyOf(r) === key) return r;
    }
    return null;
  }

  function regroup() {
    var rows = overlaid();
    var canon = window.OASchools ? OASchools.canonColumns : null;
    var merged = {};   // instKey||school||dept → row (duplicates collapse)
    var order = [];
    var i, r;

    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r._hidden && !state.admin) continue;
      /* An EDITED name goes through the same canon the posting form applies,
         so a correction lands on the site's one spelling — and two rows whose
         corrected names now agree become ONE, which is what "merge" means
         here. The build's own rows are already canonical (no-ops). */
      if (canon) {
        var c = canon({ institution: r.institution, school: r.school || '', unit: r.department || '' });
        r.institution = (r._edit ? r.institution : c.institution).replace(/^The\s+/i, '');
        /* An explicit directory correction is the official display title.
           Canonicalisation still supplies the identity used by rowKeyOf. */
        r.school = r._edit ? r.school : c.school;
        r.department = r._edit ? r.department : c.unit;
      }
      if (!r.institution) continue;
      var key = rowKeyOf(r);
      var held = merged[key];
      if (!held) { merged[key] = r; order.push(key); continue; }
      // the fuller row wins the display fields; counts and provenance add up
      held.n = (held.n || 0) + (r.n || 0);
      if ((r.lastPosted || '') > (held.lastPosted || '')) held.lastPosted = r.lastPosted;
      var src = (held.sources || []).slice();
      (r.sources || []).forEach(function (s) { if (src.indexOf(s) === -1) src.push(s); });
      held.sources = src;
      ['type', 'country', 'deptUrl', 'facultyUrl', 'address', 'mapUrl'].forEach(function (f) {
        if (!held[f] && r[f]) held[f] = r[f];
      });
      if ((!held.countries || !held.countries.length) && r.countries && r.countries.length) {
        held.countries = r.countries;
      }
      if (r._edit && (!held._edit || r._edit.t > held._edit.t)) {
        var correction = state.edits[r.id] || {};
        ['institution', 'school', 'department', 'deptUrl', 'facultyUrl', 'type', 'country'].forEach(function (f) {
          if (Object.prototype.hasOwnProperty.call(correction, f)) held[f] = r[f];
        });
        held._edit = r._edit;
      }
      if (r._hidden && held._hidden) held._hidden = true; else held._hidden = false;
    }

    var byUni = {};
    var uniOrder = [];
    for (i = 0; i < order.length; i++) {
      r = merged[order[i]];
      var uk = instKey(r.institution);
      if (!byUni[uk]) { byUni[uk] = []; uniOrder.push(uk); }
      byUni[uk].push(r);
    }

    var cards = [];
    for (i = 0; i < uniOrder.length; i++) {
      var uk2 = uniOrder[i];
      var list = byUni[uk2];
      var schools = {};
      var schoolOrder = [];
      var countries = [];
      var types = [];
      var aka = [];
      var n = 0, lastPosted = '', edited = null, hasCurated = false;

      for (var j2 = 0; j2 < list.length; j2++) {
        r = list[j2];
        var sk = fold(r.school || '');
        if (!schools[sk]) {
          schools[sk] = { name: r.school || '', type: '', rows: [] };
          schoolOrder.push(sk);
        }
        if (!schools[sk].name && r.school) schools[sk].name = r.school;
        if (!schools[sk].type && r.type) schools[sk].type = r.type;
        schools[sk].rows.push(r);
        /* a multi-campus row lists EVERY campus country (INSEAD is found by
           a reader filtering for France, Singapore or the UAE alike) */
        var rc = (r.countries && r.countries.length) ? r.countries
          : (r.country ? [r.country] : []);
        for (var ci = 0; ci < rc.length; ci++) {
          if (countries.indexOf(rc[ci]) === -1) countries.push(rc[ci]);
        }
        var tl = TYPE_LABEL[r.type];
        if (tl && types.indexOf(tl) === -1) types.push(tl);
        if (aka.indexOf(r.institution) === -1) aka.push(r.institution);
        n += r.n || 0;
        if ((r.lastPosted || '') > lastPosted) lastPosted = r.lastPosted || '';
        if (r._edit && (!edited || r._edit.t > edited.t)) edited = r._edit;
        (r.sources || []).forEach(function (s) {
          if (s === 'directory' || s === 'seed' || s === 'omlist') hasCurated = true;
        });
      }

      // named schools A-Z; the rows whose school nobody has filed yet last
      schoolOrder.sort(function (a, b) {
        if (!a !== !b) return a ? -1 : 1;
        return a.localeCompare(b);
      });
      var schoolList = [];
      var deptText = [];
      for (var j3 = 0; j3 < schoolOrder.length; j3++) {
        var sc = schools[schoolOrder[j3]];
        sc.rows.sort(function (a, b) {
          return fold(a.department || '').localeCompare(fold(b.department || ''));
        });
        schoolList.push(sc);
        if (sc.name) deptText.push(sc.name);
        for (var j4 = 0; j4 < sc.rows.length; j4++) {
          if (sc.rows[j4].department) deptText.push(sc.rows[j4].department);
        }
      }

      var name = displayNameOf(list);
      cards.push({
        id: slug(uk2),
        institution: name,
        aka: aka.join(' · '),
        countries: countries.sort(),
        types: types,
        activity: n > 0 ? 'Has posted here' : 'Never posted here',
        deptText: deptText.join(' · '),
        schools: schoolList,
        n: n,
        lastPosted: lastPosted,
        edited: edited,
        editedBucket: editBucket(edited && edited.t),
        curated: hasCurated,
      });
    }

    cards.sort(function (a, b) {
      // most recent activity first — a live market floats its schools up —
      // with the never-posted (OM-list / seed) cards after them, A-Z
      if ((b.lastPosted || '') !== (a.lastPosted || '')) {
        return (b.lastPosted || '') < (a.lastPosted || '') ? -1 : 1;
      }
      if ((b.n || 0) !== (a.n || 0)) return (b.n || 0) - (a.n || 0);
      return fold(a.institution).localeCompare(fold(b.institution));
    });

    // refill the ONE array the list engine holds, in place
    state.cards.length = 0;
    for (i = 0; i < cards.length; i++) state.cards.push(cards[i]);
    return state.cards;
  }

  function slug(s) {
    return fold(s).replace(/\s+/g, '-').slice(0, 80) || 'u';
  }

  /* --------------------------------------------------------- card HTML */

  function extLink(url, label) {
    var u = safeUrl(url);
    if (!u) return '';
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(label) + ' ↗</a>';
  }

  function deptLineHTML(r) {
    var bits = [];
    bits.push('<div class="oa-dir-dept' + (r._hidden ? ' oa-dir-hidden' : '') +
      '" data-dir-row="' + esc(r.id) + '">');
    bits.push('<span class="oa-dir-dname">' +
      (r.department ? esc(r.department)
        : '<em>school-level listing — no department recorded</em>') + '</span>');
    var links = [];
    var dept = extLink(r.deptUrl, 'Department page');
    var fac = extLink(r.facultyUrl, 'Faculty');
    if (dept) links.push(dept);
    if (fac) links.push(fac);
    if (links.length) bits.push('<span class="oa-dir-links">' + links.join(' ') + '</span>');
    if (r.n) {
      bits.push('<span class="oa-dir-n">' + r.n + ' posting' + (r.n === 1 ? '' : 's') +
        (r.lastPosted ? ' · latest ' + esc(fmtDay(r.lastPosted)) : '') + '</span>');
    }
    if (r._added) bits.push('<span class="oa-dir-new">added by a user</span>');
    if (r._hidden) {
      bits.push('<span class="oa-dir-gone">Taken down — only you can see this row.</span>');
    }
    /* The department row carries the maintainer's own controls only. Editing
       is the SCHOOL's form now (owner, 2026-10-05), opened from the school's
       head above: one form shows every field of every department in it. */
    if (state.admin) {
      var acts = [];
      acts.push(r._hidden
        ? '<button type="button" class="oa-jobbtn oa-jobbtn-edit" data-dir-restore="' +
          esc(r.id) + '">Restore</button>'
        : '<button type="button" class="oa-jobbtn oa-jobbtn-del" data-dir-hide="' +
          esc(r.id) + '">Hide</button>');
      if (state.edits[r.id]) {
        acts.push('<button type="button" class="oa-jobbtn oa-jobbtn-del" data-dir-reset="' +
          esc(r.id) + '" title="Discard the stored edit and show the committed file’s row">Reset to file</button>');
      }
      bits.push('<span class="oa-dir-acts">' + acts.join('') + '</span>');
    }
    bits.push('</div>');
    return bits.join('');
  }

  /** One school section. It is drawn inside a wrapper the edit form is
      mounted into: while the form is open the read view beside it is hidden,
      and the form puts it back when it closes. */
  function schoolHTML(card, school) {
    var bits = [];
    bits.push('<div class="oa-dir-school" data-dir-school="' + esc(schoolKeyOf(school)) + '">');
    bits.push('<div class="oa-dir-school-view">');
    var head = [];
    var chip = TYPE_LABEL[school.type];
    if (chip) {
      head.push('<span class="oa-dir-chip' +
        (school.type === 'Business School' ? ' is-biz' : ' is-nonbiz') + '">' +
        esc(chip) + '</span>');
    }
    if (state.user) {
      head.push('<button type="button" class="oa-jobbtn oa-jobbtn-edit oa-dir-editbtn" data-dir-edit="' +
        esc(schoolKeyOf(school)) + '" aria-label="' +
        esc('Edit ' + (school.name || 'the departments with no school recorded') + ', ' + card.institution) +
        '">Edit school</button>');
    }
    if (head.length) bits.push('<div class="oa-dir-schoolhead">' + head.join('') + '</div>');
    for (var i = 0; i < school.rows.length; i++) bits.push(deptLineHTML(school.rows[i]));
    bits.push('</div></div>');
    return bits.join('');
  }

  /** What a school is called inside its card, for finding it again after a
      redraw: the regrouping folds a school's name the same way. */
  function schoolKeyOf(school) { return fold(school.name || ''); }

  function cardRows(card) {
    var rows = [];
    for (var i = 0; i < card.schools.length; i++) {
      var sc = card.schools[i];
      rows.push({
        label: sc.name || 'School not recorded yet',
        html: schoolHTML(card, sc),
      });
    }
    /* THE SAME LINK SET THE MAP'S POPUP OFFERS (owner, 2026-08-24: "lists
       should be inter-linked") — one university, every list about it, each
       pre-filtered by the card's institution name exactly as every posting's
       "Further info" link filters this page. The candidates list is a SECTION
       of the one-page site whose filter keys are namespaced (c_), the same
       note universities.html carries for the map. */
    var q = encodeURIComponent(card.institution);
    var foot = [];
    if (card.n) {
      foot.push('<a href="jobs?institution=' + q + '">Current postings</a>');
      foot.push('<a href="previous-markets?university=' + q + '">Past postings</a>');
    }
    foot.push('<a href="recent-faculty?placement=' + q + '">Recent hires</a>');
    foot.push('<a href="recent-faculty?alma=' + q + '">PhD alumni</a>');
    foot.push('<a href="./?c_affiliation=' + q + '#candidates">Candidates on the market</a>');
    if (state.user) {
      foot.push('<button type="button" class="oa-jobbtn oa-jobbtn-edit" data-dir-add="' +
        esc(card.institution) + '">+ Add a department</button>');
    }
    rows.push({ label: 'More', html: '<div class="oa-dir-addhost" data-dir-addhost="1">' +
      '<span class="oa-dir-foot">' + foot.join(' · ') + '</span></div>' });
    return rows;
  }

  function cardSubtitle(card) {
    var bits = [];
    if (card.countries.length) bits.push(card.countries.join(' · '));
    if (card.n) {
      bits.push(card.n + ' posting' + (card.n === 1 ? '' : 's') +
        (card.lastPosted ? ', latest ' + fmtDay(card.lastPosted) : ''));
    } else {
      bits.push(card.curated ? 'no postings here yet' : 'listed from a posting');
    }
    return bits.join(' — ');
  }

  /* ----------------------------------------------------------- editing */

  function baseOf(rowId) {
    for (var i = 0; i < state.flat.length; i++) {
      if (state.flat[i].id === rowId) return state.flat[i];
    }
    return null;
  }

  function findRow(rowId) {
    var rows = overlaid();
    for (var i = 0; i < rows.length; i++) if (rows[i].id === rowId) return rows[i];
    return null;
  }

  function editorName() {
    var n = (window.OAAccounts && OAAccounts.displayName()) || '';
    return String(n).slice(0, 120);
  }

  function asText(v) { return v === null || v === undefined ? '' : String(v); }
  function trim(v) { return asText(v).trim(); }

  function fieldOf(key) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
    return null;
  }

  function findCard(cardId) {
    for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === cardId) return state.cards[i];
    return null;
  }

  function findSchool(card, key) {
    for (var i = 0; i < card.schools.length; i++) {
      if (schoolKeyOf(card.schools[i]) === key) return card.schools[i];
    }
    return null;
  }

  /** The card a row lands on once its names are saved — the regrouping's own
      key, so the "Saved." line is drawn under the card the reader will find
      the school on, which is another card when the university was renamed. */
  function cardIdFor(r) {
    var inst = r.institution || '';
    if (window.OASchools) {
      inst = OASchools.canonColumns({ institution: inst, school: r.school || '', unit: r.department || '' }).institution;
    }
    return slug(instKey(inst));
  }

  /* ------------------------------------------------------- the edit form

     ONE FORM PER SCHOOL (owner, 2026-10-05: "I want to be able to edit any
     field directly when I want to, like one form per school with edit option
     per field. Currently, when I click edit I have to check all fields one by
     one"). Edit used to be a chain of seven browser prompts per department, so
     correcting one link meant pressing OK through six questions first, and
     giving two departments their school meant fourteen.

     Now Edit school opens ONE form inside the card: the school's own fields
     (university, school, type, country) once at the top, then each
     department's name and two links, every box filled in and editable at
     once. Save writes every department that changed in one batch.

     WHAT IS SAVED is the same thing the prompts saved, per department: only
     what differs from the committed file, so a field left alone stays the
     file's to correct later (the rowOverrides discipline). A box the reader
     did not touch keeps exactly what the row holds now, even where the card
     showed it tidied (a canonical spelling, a link folded in from a
     duplicate row): the form never writes what nobody typed.

     A SCHOOL FIELD THE DEPARTMENTS DISAGREE ABOUT is shown empty with the
     values it has in its placeholder, and left alone it changes nothing;
     typed into, it sets every department. The type is the same through a
     fourth radio button, "leave each as it is".

     ONE FORM AT A TIME, and it SURVIVES A REDRAW: the list redraws whenever
     the sign-in state or the edits change, so what is typed lives in
     state.form and onCard mounts it again on the new card. */

  var formSeq = 0;

  /* The add form asks for the DEPARTMENT first, since that is what is being
     added; the university is already filled in from the card. */
  var ADD_ORDER = ['department', 'institution', 'school', 'deptUrl', 'facultyUrl', 'country', 'type'];

  function dirty(spec) {
    for (var k in spec.values) {
      if (!Object.prototype.hasOwnProperty.call(spec.values, k)) continue;
      if (trim(spec.values[k]) !== trim(spec.shown[k])) return true;
    }
    return false;
  }

  /** Make room for a new form: the one already open is closed, after asking
      when something has been typed into it. */
  function claimForm() {
    if (!state.form) return true;
    if (dirty(state.form) && !window.confirm('Discard what you typed in the form that is open?')) {
      var open = document.querySelector('.oa-dir-form');
      if (open) focusFirst(open);
      return false;
    }
    unmountForm();
    state.form = null;
    return true;
  }

  function openSchoolForm(li, card, key) {
    var school = findSchool(card, key);
    if (!school || !school.rows.length || !state.user) return;
    if (!claimForm()) return;
    var spec = {
      kind: 'school', cardId: card.id, school: key, seq: ++formSeq,
      title: school.name || '', institution: card.institution,
      rows: [], shown: {}, mixed: {}, campuses: [],
    };
    school.rows.forEach(function (r, i) {
      spec.rows.push({
        id: r.id,
        added: !!(state.edits[r.id] && state.edits[r.id].add),
        hidden: !!r._hidden,
      });
      FIELDS.forEach(function (f) {
        if (f.scope === 'dept') spec.shown['r' + i + '.' + f.key] = asText(r[f.key]);
      });
      ['school', 'type'].forEach(function (key) {
        spec.shown['r' + i + '.' + key] = asText(r[key]);
      });
      (r.countries || []).forEach(function (c) {
        if (spec.campuses.indexOf(c) === -1) spec.campuses.push(c);
      });
    });
    FIELDS.forEach(function (f) {
      if (f.scope !== 'school') return;
      var seen = [];
      school.rows.forEach(function (r) {
        var v = asText(r[f.key]);
        if (seen.indexOf(v) === -1) seen.push(v);
      });
      var name = 's.' + f.key;
      if (seen.length === 1) {
        spec.shown[name] = seen[0];
      } else {
        spec.shown[name] = f.kind === 'type' ? KEEP : '';
        spec.mixed[name] = seen;
      }
    });
    spec.values = copyOf(spec.shown);
    state.form = spec;
    mountForm(li, true);
  }

  function openAddForm(li, card) {
    if (!state.user) return;
    if (!claimForm()) return;
    var spec = {
      kind: 'add', cardId: card.id, seq: ++formSeq,
      institution: card.institution,
      schools: card.schools.map(function (s) { return s.name; }).filter(Boolean),
      rows: [], shown: {}, mixed: {}, campuses: [],
    };
    FIELDS.forEach(function (f) { spec.shown['a.' + f.key] = ''; });
    spec.shown['a.institution'] = card.institution;
    if (card.countries.length === 1) spec.shown['a.country'] = card.countries[0];
    spec.values = copyOf(spec.shown);
    state.form = spec;
    mountForm(li, true);
  }

  function copyOf(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  function fid(spec, name) { return 'oa-dirf' + spec.seq + '-' + name.replace(/\./g, '-'); }

  function textFieldHTML(spec, name, f, opts) {
    opts = opts || {};
    var id = fid(spec, name);
    var mixed = spec.mixed[name];
    var hint = f.hint || '';
    var ph = '';
    if (spec.kind === 'add' && f.key === 'institution') hint = 'The full official name.';
    if (mixed) {
      ph = 'Differs: ' + mixed.map(function (v) { return v || '(empty)'; }).join(' / ');
      hint = 'The departments below differ here. Leave it empty to keep each as it is, or type to set it for all of them.';
    } else if (f.key === 'country' && !spec.shown[name] && spec.campuses.length) {
      ph = 'Several campuses: ' + spec.campuses.join(', ');
      hint = 'Leave it empty to keep every campus country, or type one country to replace them.';
    } else if (f.kind === 'url') {
      ph = 'https://';
    }
    return '<div class="oa-dir-field' + (opts.wide ? ' is-wide' : '') + '">' +
      '<label for="' + id + '">' + esc(f.label) + '</label>' +
      '<input type="text" id="' + id + '" data-f="' + esc(name) + '" value="' +
        esc(spec.values[name]) + '" maxlength="' + f.max + '" autocomplete="off"' +
        ' spellcheck="' + (f.kind === 'url' ? 'false' : 'true') + '"' +
        (f.kind === 'url' ? ' inputmode="url"' : '') +
        (opts.list ? ' list="' + opts.list + '"' : '') +
        (ph ? ' placeholder="' + esc(ph) + '"' : '') +
        (hint ? ' aria-describedby="' + id + '-hint"' : '') + '>' +
      (hint ? '<p class="oa-dir-hint" id="' + id + '-hint">' + esc(hint) + '</p>' : '') +
      '</div>';
  }

  function typeFieldHTML(spec, name, f) {
    var id = fid(spec, name);
    var mixed = spec.mixed[name];
    var choices = TYPE_CHOICES.slice();
    if (mixed) {
      choices.push({ value: KEEP, label: 'Leave each department as it is (' +
        mixed.map(function (v) { return TYPE_LABEL[v] || 'not recorded'; }).join(', ') + ')' });
    }
    var bits = ['<div class="oa-dir-field is-wide" role="radiogroup" aria-labelledby="' + id + '-l">',
      '<span class="oa-dir-label" id="' + id + '-l">' + esc(f.label) + '</span>',
      '<div class="oa-dir-radios">'];
    choices.forEach(function (c) {
      bits.push('<label class="oa-dir-radio"><input type="radio" name="' + id + '" data-f="' +
        esc(name) + '" value="' + esc(c.value) + '"' +
        (spec.values[name] === c.value ? ' checked' : '') + '> <span>' + esc(c.label) + '</span></label>');
    });
    bits.push('</div></div>');
    return bits.join('');
  }

  function fieldHTML(spec, name, f, opts) {
    return f.kind === 'type' ? typeFieldHTML(spec, name, f) : textFieldHTML(spec, name, f, opts);
  }

  function formHTML(spec) {
    var bits = [];
    var id = fid(spec, 'form');
    bits.push('<form class="oa-dir-form" data-dir-form="' + spec.kind + '" novalidate aria-labelledby="' + id + '-t">');
    if (spec.kind === 'add') {
      bits.push('<p class="oa-dir-form-title" id="' + id + '-t">Add a department to ' + esc(spec.institution) + '</p>');
      bits.push('<p class="oa-dir-form-lede">Fill in what you know and press Save. Every visitor sees the new department straight away, with your name beside it.</p>');
      var listId = fid(spec, 'schools');
      bits.push('<div class="oa-dir-grid">');
      ADD_ORDER.forEach(function (key) {
        var f = fieldOf(key);
        bits.push(fieldHTML(spec, 'a.' + key, f, { list: key === 'school' && spec.schools.length ? listId : '' }));
      });
      bits.push('</div>');
      if (spec.schools.length) {
        bits.push('<datalist id="' + listId + '">' + spec.schools.map(function (n) {
          return '<option value="' + esc(n) + '">';
        }).join('') + '</datalist>');
      }
    } else {
      bits.push('<p class="oa-dir-form-title" id="' + id + '-t">Editing ' +
        esc(spec.title || 'the departments with no school recorded') + '</p>');
      bits.push('<p class="oa-dir-form-lede">Change any box, then press Save. Only what you change is saved, with your name and today’s date.</p>');
      var hid = fid(spec, 'school');
      bits.push('<div class="oa-dir-fgroup" role="group" aria-labelledby="' + hid + '-h">');
      bits.push('<p class="oa-dir-fgroup-h" id="' + hid + '-h">The school' +
        '<span class="oa-dir-fgroup-note">' + (spec.rows.length === 1
          ? 'for the department below' : 'for all ' + spec.rows.length + ' departments below') + '</span></p>');
      bits.push('<div class="oa-dir-grid">');
      FIELDS.forEach(function (f) {
        if (f.scope === 'school') bits.push(fieldHTML(spec, 's.' + f.key, f));
      });
      bits.push('</div></div>');
      spec.rows.forEach(function (sr, i) {
        var gid = fid(spec, 'r' + i);
        var shownName = trim(spec.shown['r' + i + '.department']);
        bits.push('<div class="oa-dir-fgroup" role="group" aria-labelledby="' + gid + '-h">');
        bits.push('<p class="oa-dir-fgroup-h" id="' + gid + '-h">' +
          (spec.rows.length > 1 ? 'Department ' + (i + 1) + ' of ' + spec.rows.length : 'The department') +
          (shownName ? '<span class="oa-dir-fgroup-note">' + esc(shownName) + '</span>' : '') +
          (sr.added ? '<span class="oa-dir-fgroup-note is-new">added by a user</span>' : '') +
          (sr.hidden ? '<span class="oa-dir-fgroup-note is-gone">hidden from visitors</span>' : '') +
          '</p>');
        bits.push('<div class="oa-dir-grid">');
        FIELDS.forEach(function (f) {
          if (f.scope === 'dept') bits.push(fieldHTML(spec, 'r' + i + '.' + f.key, f));
        });
        ['school', 'type'].forEach(function (key) {
          var f = copyOf(fieldOf(key));
          f.label = key === 'school' ? 'School for this department' : 'School type for this department';
          f.hint = 'Change this only to assign this department separately. The school fields above apply to all departments.';
          bits.push(fieldHTML(spec, 'r' + i + '.' + key, f));
        });
        bits.push('</div></div>');
      });
    }
    /* always in the document, so a screen reader announces the first words
       put into it: a live region that appears WITH its message is often
       not announced at all */
    if (spec.kind === 'school') {
      bits.push('<label class="oa-dir-checked"><input type="checkbox" class="oa-dir-check-today"' +
        (spec.checked ? ' checked' : '') + '> I checked the names and department and faculty links today</label>');
    }
    bits.push('<p class="oa-dir-form-msg" role="alert"></p>');
    bits.push('<div class="oa-dir-form-acts">' +
      '<button type="submit" class="v3-btn primary oa-dir-save">' +
        (spec.kind === 'add' ? 'Add the department' : 'Save changes') + '</button>' +
      '<button type="button" class="v3-btn ghost oa-dir-cancel">Cancel</button>' +
      '</div>');
    bits.push('</form>');
    return bits.join('');
  }

  /** Where in a card the open form belongs: the school's own section, or the
      foot of the card for a department being added. */
  function formHostIn(li, spec) {
    if (spec.kind === 'add') return li.querySelector('[data-dir-addhost]');
    var hosts = li.querySelectorAll('[data-dir-school]');
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute('data-dir-school') === spec.school) return hosts[i];
    }
    return null;
  }

  function mountForm(li, focusIt) {
    var spec = state.form;
    if (!spec || !li) return;
    var host = formHostIn(li, spec);
    if (!host) return;
    var old = host.querySelector('.oa-dir-form');
    if (old) old.parentNode.removeChild(old);
    var view = host.querySelector('.oa-dir-school-view');
    if (view) view.hidden = true;
    var addBtn = host.querySelector('[data-dir-add]');
    if (addBtn) addBtn.hidden = true;
    var wrap = document.createElement('div');
    wrap.innerHTML = formHTML(spec);
    var form = wrap.firstChild;
    host.appendChild(form);
    wireForm(form, spec, li);
    if (focusIt) focusFirst(form);
  }

  function focusFirst(form) {
    var first = form.querySelector('input[type="text"], input[type="radio"]:checked');
    if (first) {
      try { first.focus({ preventScroll: false }); } catch (e) { first.focus(); }
    }
  }

  function unmountForm() {
    var forms = document.querySelectorAll('.oa-dir-form');
    for (var i = 0; i < forms.length; i++) {
      var host = forms[i].parentNode;
      host.removeChild(forms[i]);
      var view = host.querySelector('.oa-dir-school-view');
      if (view) view.hidden = false;
      var addBtn = host.querySelector('[data-dir-add]');
      if (addBtn) addBtn.hidden = false;
    }
  }

  function wireForm(form, spec, li) {
    function take(ev) {
      var t = ev.target;
      var name = t && t.getAttribute && t.getAttribute('data-f');
      if (!name) return;
      if (t.type === 'radio' && !t.checked) return;
      spec.values[name] = t.value;
      if (t.getAttribute('aria-invalid')) t.removeAttribute('aria-invalid');
    }
    form.addEventListener('input', take);
    form.addEventListener('change', take);
    var checked = form.querySelector('.oa-dir-check-today');
    if (checked) checked.addEventListener('change', function () { spec.checked = checked.checked; });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitForm(form, spec);
    });
    form.querySelector('.oa-dir-cancel').addEventListener('click', function () {
      cancelForm(li, spec);
    });
    form.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        cancelForm(li, spec);
      }
    });
  }

  function cancelForm(li, spec) {
    if (state.form !== spec) return;
    if (dirty(spec) && !window.confirm('Discard the changes you typed?')) return;
    unmountForm();
    state.form = null;
    // the keyboard goes back to the button that opened the form
    var back = spec.kind === 'add'
      ? li.querySelector('[data-dir-add]')
      : (function () {
        var bs = li.querySelectorAll('[data-dir-edit]');
        for (var i = 0; i < bs.length; i++) {
          if (bs[i].getAttribute('data-dir-edit') === spec.school) return bs[i];
        }
        return null;
      })();
    if (back) back.focus();
  }

  function say(form, text, isErr, field) {
    var msg = form.querySelector('.oa-dir-form-msg');
    msg.textContent = text;
    msg.classList.toggle('is-err', !!isErr);
    if (field) {
      var el = form.querySelector('[data-f="' + field + '"]');
      if (el) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
      }
    }
  }

  /** What a typed box must be before anything is saved. Only a box the reader
      CHANGED is held to it, so a link stored long ago in some other shape does
      not stop a correction to the school's name. */
  function invalid(spec, name) {
    var f = fieldOf(name.split('.')[1]);
    var v = trim(spec.values[name]);
    if (!f || trim(spec.shown[name]) === v) return '';
    if (f.key === 'institution' && !v) return 'The university needs a name.';
    if (f.kind === 'url' && v && !/^https?:\/\/\S+$/i.test(v)) {
      return f.label + ' must be a web address starting with https://';
    }
    return '';
  }

  /** The school form → one entry per department that changed. */
  function planSchool(spec) {
    var names = Object.keys(spec.values);
    for (var n = 0; n < names.length; n++) {
      var bad = invalid(spec, names[n]);
      if (bad) return { error: bad, field: names[n] };
    }
    var finals = [];
    spec.rows.forEach(function (sr, i) {
      var cur = findRow(sr.id);
      if (!cur) return;
      var fin = {};
      FIELDS.forEach(function (f) {
        var name = (f.scope === 'school' ? 's.' : 'r' + i + '.') + f.key;
        var typed = spec.values[name];
        fin[f.key] = (typed === KEEP || trim(typed) === trim(spec.shown[name]))
          ? asText(cur[f.key])
          : trim(typed).slice(0, f.max);
        var own = 'r' + i + '.' + f.key;
        if ((f.key === 'school' || f.key === 'type') && spec.values[own] !== undefined
            && trim(spec.values[own]) !== trim(spec.shown[own])) {
          fin[f.key] = trim(spec.values[own]).slice(0, f.max);
        }
      });
      finals.push({ id: sr.id, added: sr.added, cur: cur, fin: fin, i: i });
    });

    /* A department a user ADDED may not be renamed onto a place the table
       already lists: the two would fold into one card row and the added
       document would be out of reach. Checked against the table as it will be
       once this save lands. A built row renamed onto another IS the merge
       tool, as it always was. */
    var after = overlaid().map(function (r) {
      for (var j = 0; j < finals.length; j++) {
        if (finals[j].id === r.id) {
          var c = copyOf(r);
          FIELDS.forEach(function (f) { c[f.key] = finals[j].fin[f.key]; });
          return c;
        }
      }
      return r;
    });
    for (var k = 0; k < finals.length; k++) {
      if (!finals[k].added) continue;
      var clash = existingRow(finals[k].fin, finals[k].id, after);
      if (clash) return { error: clashText(clash), field: 'r' + finals[k].i + '.department' };
    }

    var entries = [];
    finals.forEach(function (x) {
      var changed = FIELDS.some(function (f) { return x.fin[f.key] !== asText(x.cur[f.key]); });
      if (!changed && !spec.checked) return;
      if (x.added) {
        var doc = { add: true };
        FIELDS.forEach(function (f) { if (x.fin[f.key]) doc[f.key] = x.fin[f.key]; });
        entries.push({ rowId: x.id, patch: doc });
        return;
      }
      var base = baseOf(x.id);
      if (!base) return;
      var patch = {};
      FIELDS.forEach(function (f) {
        if (x.fin[f.key] !== asText(base[f.key])) patch[f.key] = x.fin[f.key];
      });
      entries.push({ rowId: x.id, patch: patch });
    });
    return { entries: entries, cardId: finals.length ? cardIdFor(finals[0].fin) : spec.cardId };
  }

  /** The add form → the one new department. */
  function planAdd(spec) {
    var doc = { add: true };
    var names = Object.keys(spec.values);
    for (var n = 0; n < names.length; n++) {
      var bad = invalid(spec, names[n]);
      if (bad) return { error: bad, field: names[n] };
    }
    FIELDS.forEach(function (f) {
      var v = trim(spec.values['a.' + f.key]).slice(0, f.max);
      if (v) doc[f.key] = v;
    });
    if (!doc.institution) return { error: 'The university needs a name.', field: 'a.institution' };
    if (!doc.department && !doc.school) {
      return { error: 'Name the department you are adding (or at least its school).', field: 'a.department' };
    }
    var clash = existingRow(doc, '');
    if (clash) return { error: clashText(clash), field: 'a.department' };
    var docId = 'add-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    return { entries: [{ rowId: docId, patch: doc }], cardId: cardIdFor(doc) };
  }

  /** Say no to a row the table already lists (see existingRow), naming it. */
  function clashText(clash) {
    var name = [clash.institution, clash.school, clash.department].filter(Boolean).join(' · ');
    return 'The directory already lists ' + name + '.' +
      (clash._hidden ? ' That row is hidden; the maintainer can restore it.' : ' Edit that row instead.') +
      ' Nothing was saved.';
  }

  function submitForm(form, spec) {
    if (state.form !== spec || spec.saving) return;
    var plan = spec.kind === 'add' ? planAdd(spec) : planSchool(spec);
    if (plan.error) { say(form, plan.error, true, plan.field); return; }
    if (!plan.entries.length) {
      unmountForm();
      state.form = null;
      flash(spec.cardId, 'Nothing was changed, so nothing was saved.');
      refresh();
      return;
    }
    var btns = form.querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) btns[b].disabled = true;
    say(form, 'Saving…', false);
    spec.saving = true;   // a second press, or the form redrawn mid-save, sends nothing twice
    save(plan.entries).then(function () {
      if (state.form === spec) state.form = null;
      flash(plan.cardId, spec.kind === 'add'
        ? 'Added. Every visitor now sees the new department.'
        : 'Saved. Every visitor now sees the change.');
      refresh();
    }, function (err) {
      spec.saving = false;
      /* the form on screen, which a redraw during the save may have replaced */
      var live = (form.isConnected ? form : document.querySelector('.oa-dir-form')) || form;
      btns = live.querySelectorAll('button');
      for (var b2 = 0; b2 < btns.length; b2++) btns[b2].disabled = false;
      say(live, refusedText(err, false), true);
      if (window.console) console.error('oa-directory:', err);
    });
  }

  function flash(cardId, text) {
    state.flash = { cardId: cardId, text: text, until: Date.now() + 20000, focus: true };
  }

  function hideRow(rowId, hidden) {
    if (!state.admin) return;
    if (hidden && !window.confirm('Hide this row from every visitor?\n\nNothing is ' +
      'deleted — it stays in the data, faded for you, and Restore puts it back. ' +
      'Hiding the lesser copy is how two duplicate rows are merged.')) return;
    save([{ rowId: rowId, patch: { hidden: hidden }, merge: true }])
      .then(function () { refresh(); }, saveFailed);
  }

  function resetRow(rowId) {
    if (!state.admin) return;
    if (!window.confirm('Discard the stored edit and go back to what the committed ' +
      'file says for this row?')) return;
    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(COLLECTION).doc(rowId)['delete']();
    }).then(function () {
      delete state.edits[rowId];
      refresh();
    })['catch'](function (err) { saveFailed(err); });
  }

  /** Write every entry — { rowId, patch, merge } — as ONE batch: a school
      form changing four departments either lands whole or not at all, never
      leaving the card half renamed. Each document is the same full set() it
      always was, judged by the rules on its own. */
  function save(entries) {
    if (!state.user) return Promise.reject(new Error('signed out'));
    var docs = [];
    var now = Date.now();
    for (var i = 0; i < entries.length; i++) {
      var rowId = entries[i].rowId;
      var patch = entries[i].patch;
      var doc = {};
      var had = state.edits[rowId];
      if (entries[i].merge && had) {
        for (var a in had) if (Object.prototype.hasOwnProperty.call(had, a)) doc[a] = had[a];
      }
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) doc[k] = patch[k];
      /* hidden is the maintainer's mark and survives an ordinary edit: a user
         correcting a hidden row must not silently republish it.

         CARRIED WHENEVER THE ROW HAS THE KEY, not only when it is TRUE. This is
         a full set(), so a field left out of `doc` is a field deleted from the
         document, and the rules read the RESULTING document: on a row the
         maintainer had RESTORED, `hidden` is stored as false, `had.hidden` is
         falsy, the key was dropped, and the write is refused. Omitting it is
         changing it, which is the maintainer's alone. */
      if (had && ('hidden' in had) && !('hidden' in patch)) doc.hidden = !!had.hidden;
      doc.rowId = rowId;
      doc.by = state.user.uid;
      doc.name = editorName();
      doc.t = now;
      docs.push(doc);
    }
    return OAFB.ready().then(function (fb) {
      var db = fb.firestore();
      var batch = db.batch();
      docs.forEach(function (d) { batch.set(db.collection(COLLECTION).doc(d.rowId), d); });
      return batch.commit();
    }).then(function () {
      docs.forEach(function (d) { state.edits[d.rowId] = d; });
    });
  }

  /** The words for a write that did not land. It names no cause the page
      cannot know: a refusal is the site's answer, said as one. */
  function refusedText(err, adminAction) {
    if (err && err.code === 'permission-denied') {
      return adminAction
        ? 'That could not be saved. Hiding, restoring and resetting a row are the ' +
          'maintainer’s alone; if you are the maintainer, please reload the page and try once more.'
        : 'The site did not accept this change, so nothing was saved. Please reload the page and try once more.';
    }
    return 'We could not save that, so nothing was saved. Please check your connection and try again.';
  }

  function saveFailed(err) {
    window.alert(refusedText(err, true));
    if (window.console) console.error('oa-directory:', err);
  }

  /* --------------------------------------------------------- refresh */

  function refresh() {
    if (state.host) state.host.classList.toggle('is-dir-admin', !!state.admin);
    /* NOTHING TO REDRAW BEFORE THE DATASET HAS LANDED. The sign-in state and
       the edits both resolve on their own clocks, and acting on either first
       re-rendered an empty rows array — which paints the engine's "could not
       be loaded yet" state over its own "Loading…" for a moment on every
       visit. The edits are in state.edits either way; the data's own prepare
       pass reads them when it arrives. */
    if (!state.flatLoaded) return;
    regroup();
    if (state.list) state.list.reload();
  }

  /* ------------------------------------------------------------- mount */

  function onCard(li, card) {
    /* THE BYLINE the owner asked for, on EVERY card that has one: who last
       updated it and when. An edit made here sets it, and so does a job
       posting made through the site for one of the card's departments
       (assets/oa-uniinfo.js, owner 2026-10-05), since a posting updates the
       directory too. */
    if (card.edited && card.edited.t) {
      var p = document.createElement('p');
      p.className = 'oa-dir-edited';
      p.textContent = 'Last updated by ' + (card.edited.name || 'a registered user') +
        ' on ' + fmtStamp(card.edited.t);
      li.appendChild(p);
    } else if (state.user) {
      var q = document.createElement('p');
      q.className = 'oa-dir-edited is-never';
      q.textContent = 'Not updated yet. Spot something wrong? Open the card and press Edit school.';
      li.appendChild(q);
    }

    /* "Saved." under the card a form was just saved from, for a while, and
       the keyboard on it the first time it is drawn, so a keyboard reader is
       not left on a form that is no longer there */
    var fl = state.flash;
    if (fl && fl.cardId === card.id && Date.now() < fl.until) {
      var note = document.createElement('p');
      note.className = 'oa-dir-saved';
      note.setAttribute('role', 'status');
      note.setAttribute('tabindex', '-1');
      note.textContent = fl.text;
      li.appendChild(note);
      if (fl.focus) {
        fl.focus = false;
        setTimeout(function () { if (note.isConnected) note.focus(); }, 0);
      }
    }

    /* the form open on this card comes back on every redraw, with what was
       typed in it */
    if (state.form && state.form.cardId === card.id) {
      if (state.user) mountForm(li, false);
      else state.form = null;
    }

    if (li.getAttribute('data-dir-wired')) return;
    li.setAttribute('data-dir-wired', '1');
    li.addEventListener('click', function (ev) {
      // walk up from the click to the nearest control carrying a data-dir-* verb
      var node = ev.target;
      while (node && node !== li) {
        if (node.getAttribute) {
          if (node.hasAttribute('data-dir-edit')) {
            ev.preventDefault(); ev.stopPropagation();
            openSchoolForm(li, card, node.getAttribute('data-dir-edit')); return;
          }
          if (node.getAttribute('data-dir-hide')) {
            ev.preventDefault(); ev.stopPropagation();
            hideRow(node.getAttribute('data-dir-hide'), true); return;
          }
          if (node.getAttribute('data-dir-restore')) {
            ev.preventDefault(); ev.stopPropagation();
            hideRow(node.getAttribute('data-dir-restore'), false); return;
          }
          if (node.getAttribute('data-dir-reset')) {
            ev.preventDefault(); ev.stopPropagation();
            resetRow(node.getAttribute('data-dir-reset')); return;
          }
          if (node.hasAttribute('data-dir-add')) {
            ev.preventDefault(); ev.stopPropagation();
            openAddForm(li, card); return;
          }
          if (node.tagName === 'FORM') return;   // a press inside the open form is the form's
        }
        node = node.parentNode;
      }
    });
  }

  function mount(cfg) {
    state.host = document.querySelector(cfg.mount);
    if (!state.host || !window.OAList) return null;

    state.list = OAList.mount({
      mount: cfg.mount,
      data: cfg.data || '/data/directory.json',
      perPage: cfg.perPage || 12,
      strings: {
        loading: 'Loading the universities directory…',
        emptyFiltered: 'No universities match these filters.',
        emptyFilteredHint: 'Try removing a filter, or clear them all to see every university.',
        emptyData: 'The directory could not be loaded yet.',
        emptyDataHint: 'Please check back soon.',
        loadError: 'The universities directory could not be loaded.',
        loadErrorHint: 'Please reload the page, or let us know if it keeps happening.',
        unit: 'universities',
      },
      prepare: function (rows) {
        state.flat = rows;
        state.flatLoaded = true;
        return regroup();
      },
      // regroup() already ordered the cards (recent activity first) — the
      // engine must not re-sort them, so no `sort` is passed.
      filters: [
        /* every posting's "Further info" link names this page as
           ?filterA=<university>, so that legacy key lands here as a chip */
        { key: 'university', label: 'University search', type: 'text',
          fields: ['institution', 'aka'],
          placeholder: 'e.g. Michigan, INSEAD, Tulane…',
          legacyParam: 'filterA' },
        { key: 'dept', label: 'School / department search', type: 'text',
          fields: ['deptText'],
          placeholder: 'e.g. IEOR, Supply Chain, Haas…' },
        { key: 'country', label: 'Country', field: 'countries', sort: 'count',
          placeholder: 'All countries',
          legacyValues: (window.OACountries || {}).ALIASES },
        { key: 'type', label: 'School type', field: 'types',
          placeholder: 'All schools' },
        { key: 'show', label: 'Show', field: 'activity', type: 'one',
          placeholder: 'Everything' },
        /* THE MAINTAINER'S REVIEW SWEEP (owner, 2026-08-24): which cards were
           edited, and when — drawn for the admin alone (the page toggles
           `is-dir-admin` on the mount; oa-directory.css hides it otherwise).
           Hiding a FILTER grants nothing: the buckets are computed from the
           public edit documents every visitor already downloads. */
        { key: 'edited', label: 'Last edited', field: 'editedBucket', type: 'one',
          placeholder: 'Any time', order: EDIT_BUCKETS, searchable: false,
          className: 'oa-f-lastedited' },
      ],
      card: {
        title: function (c) { return c.institution; },
        subtitle: cardSubtitle,
        rows: cardRows,
      },
      onCard: onCard,
    });

    attach();
    return state.list;
  }

  /* Load the community's edits and watch the sign-in state. Best-effort in
     the oa-rowedit way: with Firestore unreachable or the rules unpublished,
     the page renders exactly the committed file. */
  function attach() {
    if (!window.OAFB || !OAFB.enabled) { state.ready = true; return; }
    OAFB.ready().then(function (fb) {
      fb.firestore().collection(COLLECTION).get().then(function (snap) {
        snap.forEach(function (d) {
          var v = d.data() || {};
          v.rowId = v.rowId || d.id;
          state.edits[d.id] = v;
        });
        state.ready = true;
        refresh();
      })['catch'](function () { state.ready = true; });
    })['catch'](function () { state.ready = true; });

    if (window.OAAccounts) {
      OAAccounts.onChange(function (u) {
        state.user = u || null;
        state.admin = !!(u && OAAccounts.isAdmin());
        refresh();
      });
    }
  }

  window.OADirectory = {
    mount: mount,
    fields: function () { return FIELDS.map(function (f) { return f.key; }); },
    cards: function () { return state.cards.slice(); },

    /* The browser test's hook — page-test.mjs drives who sees which controls
       without a database, exactly like OARowEdit.__setForTest. It changes
       only what is DRAWN; the rules stay the authorisation. */
    __setForTest: function (p) {
      if (p.edits) state.edits = p.edits;
      if ('user' in p) state.user = p.user;
      if ('admin' in p) state.admin = !!p.admin;
      state.ready = true;
      refresh();
    },
  };
})();
