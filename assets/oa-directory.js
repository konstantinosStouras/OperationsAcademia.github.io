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

  /* The fields an edit may change, in the order the editor asks them. The key
     set is a SUBSET of what _firestore.rules allows — selftest.mjs pins the
     two together BOTH WAYS, exactly as it does for oa-rowedit.js. */
  var FIELDS = [
    { key: 'institution', label: 'University (the full official name — renaming a row to another university moves it to that card)', max: 220 },
    { key: 'school', label: 'School (e.g. "Walter A. Haas School of Business"; leave empty when the department reports to the university itself)', max: 200 },
    { key: 'department', label: 'Department (the bare field name, e.g. "Operations Management")', max: 260 },
    { key: 'type', label: 'Type — "Business School" or "University" (a non-business school: engineering, IEOR, information…)', max: 40 },
    { key: 'country', label: 'Country (the full name, e.g. "United States")', max: 80 },
    { key: 'deptUrl', label: 'Department page (https://…)', max: 600 },
    { key: 'facultyUrl', label: 'Faculty directory page (https://…)', max: 600 },
  ];

  /* What the two stored type values are CALLED on this page. The stored
     vocabulary is the posting form's ("Business School" / "University"); the
     card chips and the School-type filter speak the owner's wording for the
     second one, which is the whole point of it — an IEOR department is not a
     business school. */
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

  function displayNameOf(rows) {
    // the spelling most rows use; a tie goes to the longer (fuller) name
    var count = {};
    var best = '';
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].institution;
      count[n] = (count[n] || 0) + 1;
      if (!best || count[n] > count[best] ||
          (count[n] === count[best] && n.length > best.length)) best = n;
    }
    return best;
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
        r.institution = c.institution; r.school = c.school; r.department = c.unit;
      }
      if (!r.institution) continue;
      var key = instKey(r.institution) + '||' + fold(r.school || '') + '||' + fold(r.department || '');
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
      if (r._edit && (!held._edit || r._edit.t > held._edit.t)) held._edit = r._edit;
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
        if (r.country && countries.indexOf(r.country) === -1) countries.push(r.country);
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
    var canEdit = !!state.user;
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
    if (canEdit || state.admin) {
      var acts = [];
      if (canEdit) {
        acts.push('<button type="button" class="oa-jobbtn oa-jobbtn-edit" data-dir-edit="' +
          esc(r.id) + '">Edit</button>');
      }
      if (state.admin) {
        acts.push(r._hidden
          ? '<button type="button" class="oa-jobbtn oa-jobbtn-edit" data-dir-restore="' +
            esc(r.id) + '">Restore</button>'
          : '<button type="button" class="oa-jobbtn oa-jobbtn-del" data-dir-hide="' +
            esc(r.id) + '">Hide</button>');
        if (state.edits[r.id]) {
          acts.push('<button type="button" class="oa-jobbtn oa-jobbtn-del" data-dir-reset="' +
            esc(r.id) + '" title="Discard the stored edit and show the committed file’s row">Reset to file</button>');
        }
      }
      bits.push('<span class="oa-dir-acts">' + acts.join('') + '</span>');
    }
    bits.push('</div>');
    return bits.join('');
  }

  function schoolHTML(card, school) {
    var bits = [];
    var chip = TYPE_LABEL[school.type];
    if (chip) {
      bits.push('<span class="oa-dir-chip' +
        (school.type === 'Business School' ? ' is-biz' : ' is-nonbiz') + '">' +
        esc(chip) + '</span>');
    }
    for (var i = 0; i < school.rows.length; i++) bits.push(deptLineHTML(school.rows[i]));
    return bits.join('');
  }

  function cardRows(card) {
    var rows = [];
    for (var i = 0; i < card.schools.length; i++) {
      var sc = card.schools[i];
      rows.push({
        label: sc.name || 'School not recorded yet',
        html: schoolHTML(card, sc),
      });
    }
    var foot = [];
    if (card.n) {
      foot.push('<a href="jobs.html?institution=' + encodeURIComponent(card.institution) +
        '">Current postings</a>');
      foot.push('<a href="previous-markets.html?university=' +
        encodeURIComponent(card.institution) + '">Past postings</a>');
    }
    foot.push('<a href="recent-faculty.html?placement=' +
      encodeURIComponent(card.institution) + '">Recent hires</a>');
    if (state.user) {
      foot.push('<button type="button" class="oa-jobbtn oa-jobbtn-edit" data-dir-add="' +
        esc(card.institution) + '">+ Add a department</button>');
    }
    rows.push({ label: 'More', html: '<span class="oa-dir-foot">' + foot.join(' · ') + '</span>' });
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

  function cardBadges(card) {
    return card.types.map(function (t) {
      return { text: t, cls: t === 'Business school' ? 'oa-label-primary' : 'oa-label-nonbiz' };
    });
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

  /** The prompt-chain editor — the shape oa-rowedit.js already uses on the
      archives, because it needs no markup and works identically on a phone.
      Only what DIFFERS from the committed file is stored, so a field left
      alone stays the file's to correct later (the rowOverrides discipline). */
  function editRow(rowId) {
    var row = findRow(rowId);
    var base = baseOf(rowId);
    var e = state.edits[rowId];
    if (!row) return;
    if (e && e.add) { editAdd(rowId); return; }
    if (!base) return;

    var patch = {};
    var changed = false;
    var asText = function (v) { return v === null || v === undefined ? '' : String(v); };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var got = window.prompt(f.label + ':', asText(row[f.key]));
      if (got === null) return;                      // cancelled — save nothing
      got = String(got).trim().slice(0, f.max);
      if (f.key === 'type' && got && got !== 'Business School' && got !== 'University') {
        window.alert('Type must be exactly "Business School" or "University" (leave it ' +
          'empty when unsure). Nothing was saved.');
        return;
      }
      if (got !== asText(row[f.key])) changed = true;
      if (got !== asText(base[f.key])) patch[f.key] = got;
    }
    if (!changed) return;
    save(rowId, patch, { replace: true });
  }

  /* A user-added row has no committed base, so its whole content is the
     document: the editor rewrites it rather than diffing against a file. */
  function editAdd(docId) {
    var e = state.edits[docId];
    if (!e) return;
    var doc = { add: true };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var got = window.prompt(f.label + ':', e[f.key] || '');
      if (got === null) return;
      got = String(got).trim().slice(0, f.max);
      if (f.key === 'type' && got && got !== 'Business School' && got !== 'University') {
        window.alert('Type must be exactly "Business School" or "University". Nothing was saved.');
        return;
      }
      if (got) doc[f.key] = got;
    }
    if (!doc.institution) {
      window.alert('The university name is required. Nothing was saved.');
      return;
    }
    save(docId, doc, { replace: true });
  }

  function addRow(institution) {
    if (!state.user) return;
    var docId = 'add-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
    var doc = { add: true };
    if (institution) doc.institution = institution;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      if (f.key === 'institution' && institution) {
        var kept = window.prompt(f.label + ':', institution);
        if (kept === null) return;
        doc.institution = String(kept).trim().slice(0, f.max) || institution;
        continue;
      }
      var got = window.prompt(f.label + ':', '');
      if (got === null) return;
      got = String(got).trim().slice(0, f.max);
      if (f.key === 'type' && got && got !== 'Business School' && got !== 'University') {
        window.alert('Type must be exactly "Business School" or "University". Nothing was saved.');
        return;
      }
      if (got) doc[f.key] = got;
    }
    if (!doc.institution) {
      window.alert('The university name is required. Nothing was saved.');
      return;
    }
    save(docId, doc, { replace: true });
  }

  function hideRow(rowId, hidden) {
    if (!state.admin) return;
    if (hidden && !window.confirm('Hide this row from every visitor?\n\nNothing is ' +
      'deleted — it stays in the data, faded for you, and Restore puts it back. ' +
      'Hiding the lesser copy is how two duplicate rows are merged.')) return;
    save(rowId, { hidden: hidden }, { merge: true });
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

  function save(rowId, patch, opts) {
    if (!state.user) return;
    var doc = {};
    var had = state.edits[rowId];
    if (opts && opts.merge && had) {
      for (var a in had) if (Object.prototype.hasOwnProperty.call(had, a)) doc[a] = had[a];
    }
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) doc[k] = patch[k];
    /* hidden is the maintainer's mark and survives an ordinary edit — a user
       correcting a hidden row must not silently republish it. */
    if (had && had.hidden && !('hidden' in patch)) doc.hidden = true;
    doc.rowId = rowId;
    doc.by = state.user.uid;
    doc.name = editorName();
    doc.t = Date.now();

    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(COLLECTION).doc(rowId).set(doc);
    }).then(function () {
      state.edits[rowId] = doc;
      refresh();
    })['catch'](function (err) { saveFailed(err); });
  }

  function saveFailed(err) {
    window.alert(err && err.code === 'permission-denied'
      ? 'That could not be saved. Only the maintainer may hide, restore or reset a row ' +
        '— and if this was an ordinary edit, the updated Firestore rules have not ' +
        'been published yet.'
      : 'We could not save that. Please check your connection and try again.');
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
    /* the attribution line the owner asked for — on EVERY card that has one */
    if (card.edited && card.edited.t) {
      var p = document.createElement('p');
      p.className = 'oa-dir-edited';
      p.textContent = 'Last edited by ' + (card.edited.name || 'a registered user') +
        ' on ' + fmtStamp(card.edited.t);
      li.appendChild(p);
    } else if (state.user) {
      var q = document.createElement('p');
      q.className = 'oa-dir-edited is-never';
      q.textContent = 'Not edited yet — spot something wrong? Open the card and press Edit.';
      li.appendChild(q);
    }

    if (li.getAttribute('data-dir-wired')) return;
    li.setAttribute('data-dir-wired', '1');
    li.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== li && !t.getAttribute) t = t.parentNode;
      // walk up from the click to the nearest control carrying a data-dir-* verb
      var node = t;
      while (node && node !== li) {
        if (node.getAttribute) {
          if (node.getAttribute('data-dir-edit')) {
            ev.preventDefault(); ev.stopPropagation();
            editRow(node.getAttribute('data-dir-edit')); return;
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
          if (node.getAttribute('data-dir-add') !== null && node.hasAttribute('data-dir-add')) {
            ev.preventDefault(); ev.stopPropagation();
            addRow(node.getAttribute('data-dir-add')); return;
          }
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
        badges: cardBadges,
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
