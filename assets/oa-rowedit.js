/* ---------------------------------------------------------------------------
   Operations Academia — Edit and Take down on the FROZEN ARCHIVES.

   THE PROBLEM THIS SOLVES. Three of the site's datasets have no write path at
   all. data/past-postings.json, data/recent-faculty.json and
   data/universities.json are written once by _scraper/import-legacy-tables.mjs
   from Google Sheets and committed; .github/workflows/oa-legacy-import.yml has
   no schedule. So previous-markets.html, recent-faculty.html and the map on
   universities.html were read-only for EVERYBODY — the maintainer saw exactly
   the page an anonymous visitor did, and correcting a school's name meant
   editing a spreadsheet and dispatching a workflow by hand.

   WHAT THIS IS. The `newsOverrides` pattern already shipped on /whats-new,
   generalised to those three datasets: the committed JSON stays the source of
   truth, and a Firestore `rowOverrides` document MASKS or REWORDS one of its
   rows AT READ TIME. So an override reaches every visitor, nothing rewrites a
   committed file, and re-running the import cannot undo a correction — the
   override is applied on top of whatever the import produces.

   WHAT IT DELIBERATELY IS NOT. An ADD path. An override only ever changes a
   row that already exists; a school the archive does not carry is added
   upstream, in the sheet the import reads. Two places that can both create the
   same row is the parallel bookkeeping build-jobs.mjs warns about, and it
   rots: the import would later publish the school itself and the site would
   list it twice.

   AUTHORISATION IS THE RULES, never this file. `rowOverrides` in
   _firestore.rules is public-read, admin-write, with every field named, typed
   and length-capped. Everything here only decides whether a button is DRAWN: a
   page that draws none still cannot write, and one that draws them for the
   wrong visitor still gets refused.

       OARowEdit.attach('universities', { onChange: fn });   // load overrides
       OARowEdit.apply('universities', rows);                // overlay + hide
       OARowEdit.onCard('past-postings')                     // OAList hook

   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* What each dataset lets the maintainer change, and how each field is
     entered. The key set is a SUBSET of the one _firestore.rules allows, so a
     field added here without a rule is refused rather than silently dropped —
     selftest.mjs pins the two together. Order is the order of the form. */
  var DATASETS = {
    'past-postings': {
      label: 'posting',
      name: function (r) {
        return r.institution + (r.department ? ' — ' + r.department : '');
      },
      fields: [
        { key: 'institution', label: 'Institution', max: 220 },
        { key: 'department', label: 'School / department', max: 260 },
        { key: 'country', label: 'Country', max: 80 },
        { key: 'applyBy', label: 'Apply by', max: 400 },
        { key: 'comments', label: 'Comments', max: 1500 },
        { key: 'adUrl', label: 'Link to the advert', max: 600 },
      ],
    },
    'recent-faculty': {
      label: 'hire',
      name: function (r) { return r.name || r.last || r.id; },
      fields: [
        { key: 'name', label: 'Name', max: 220 },
        { key: 'placement', label: 'Placement', max: 220 },
        { key: 'almaMater', label: 'PhD from', max: 220 },
        { key: 'undergrad', label: 'Undergraduate', max: 220 },
        { key: 'webUrl', label: 'Web page', max: 600 },
      ],
    },
    universities: {
      label: 'school',
      name: function (r) { return r.institution || r.name || r.id; },
      fields: [
        { key: 'name', label: 'Name on the map', max: 220 },
        { key: 'institution', label: 'Institution (this is what every link on the popup filters by)', max: 220 },
        { key: 'schoolDept', label: 'School, department', max: 320 },
        { key: 'address', label: 'Address', max: 320 },
        { key: 'facultyUrl', label: 'Faculty page', max: 600 },
        { key: 'mapUrl', label: 'Campus location link', max: 600 },
        { key: 'lat', label: 'Latitude', max: 20, num: true, min: -90, max_: 90 },
        { key: 'lng', label: 'Longitude', max: 20, num: true, min: -180, max_: 180 },
      ],
    },
  };

  var COLLECTION = 'rowOverrides';

  /* Per dataset: the overrides that have arrived, whether the visitor is the
     maintainer, and whether the load has resolved at all. `ready` matters —
     until it does, no button is drawn and no row is hidden, so a slow or
     unreachable Firestore leaves exactly the page that shipped. */
  var state = {};

  function st(dataset) {
    if (!state[dataset]) {
      state[dataset] = { ready: false, admin: false, rows: {}, onChange: null, own: null };
    }
    return state[dataset];
  }

  /**
   * Which rows on the page actually BELONG to this dataset.
   *
   * previous-markets.html renders two populations from one list: the archive's
   * own rows, and the postings folded in at read time from data/jobs.json.
   * Those second ones are real submissions — the job editor owns them, and an
   * override against one is read by NOTHING: no build applies rowOverrides to
   * data/jobs.json. So `Take down` on one used to make the card vanish and
   * leave the posting on the site, which is the worst shape a control can
   * have. Standing down when another decorator has drawn is not enough on its
   * own, because the two race: this module reads a small filtered query and
   * the job editor reads the WHOLE jobSubmissions collection, so for the first
   * second of every visit — and for ever if that read fails — every posting on
   * the page carried the archive's editor.
   *
   * A page that renders one population need not call this; one that mixes them
   * must, and selftest.mjs pins that previous-markets.html does.
   */
  function own(dataset, ids) {
    var s = st(dataset);
    s.own = {};
    for (var i = 0; i < (ids || []).length; i++) s.own[ids[i]] = true;
    return s.own;
  }

  function isOwn(dataset, row) {
    var s = st(dataset);
    return !s.own || !!s.own[row && row.id];
  }

  function isAdmin(user) {
    var want = String((window.OAFB && OAFB.adminEmail) || '').toLowerCase();
    return !!(user && want && user.email && user.email.toLowerCase() === want &&
              user.emailVerified);
  }

  /* ------------------------------------------------------------- the overlay */

  /**
   * The rows a page should render: every override applied, every hidden row
   * gone. PURE — it returns a new array of new objects and never touches the
   * dataset it was handed, so a page may call it again whenever the overrides
   * or the sign-in state change.
   *
   * EXCEPT FOR THE MAINTAINER, who is shown the rows they have taken down,
   * faded and carrying Restore. Filtering them out for everybody would make
   * Take down a ONE-WAY DOOR: the row is gone from the page, so there is
   * nothing left to click to put it back, and the only way to undo a
   * mis-click would be the Firestore console. (`newsOverrides` on /whats-new
   * had exactly that shape; this is the same fix.)
   */
  function apply(dataset, rows) {
    var spec = DATASETS[dataset];
    // A dataset this module does not know has no overrides and no editor, so
    // it is handed back untouched rather than thrown on — a page that mounts
    // the wrong name renders its data and simply gets no controls.
    if (!spec) return (rows || []).slice();
    var s = st(dataset);
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      var o = isOwn(dataset, r) ? s.rows[r && r.id] : null;
      if (!o) { out.push(r); continue; }
      if (o.hidden && !s.admin) continue;
      var copy = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
      /* WHAT THE FILE SAYS, kept beside what is shown. An override must record
         only the fields the maintainer actually CHANGED — see `edit` — and
         that cannot be decided against the displayed value, which is already
         the override's. */
      var base = {};
      for (var j = 0; j < spec.fields.length; j++) {
        var key = spec.fields[j].key;
        base[key] = r[key];
        if (Object.prototype.hasOwnProperty.call(o, key)) copy[key] = o[key];
      }
      copy._oaBase = base;
      /* Read by onCard/onPopup to draw Restore rather than Take down. A `_`
         name because it is not a field of the dataset and must never be
         mistaken for one — no card renderer reads it. */
      if (o.hidden) copy._oaHidden = true;
      out.push(copy);
    }
    return out;
  }

  /* ------------------------------------------------------------- the buttons */

  function button(label, cls, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'oa-jobbtn ' + cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', function (e) {
      // the whole card head is a toggle; these must not also expand it
      e.preventDefault();
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  /** The OAList `onCard` hook for a dataset. */
  function onCard(dataset) {
    return function (li, row) {
      if (!DATASETS[dataset] || !isOwn(dataset, row)) return;
      var s = st(dataset);
      if (!s.ready || !s.admin) return;

      /* Another decorator may own this row — on previous-markets.html the
         postings folded in from data/jobs.json are real submissions, and
         oa-jobedit.js gives those the FULL editor. One set of buttons per
         card, and the better one wins. */
      var owned = li.querySelector('.oa-card-actions');

      /* EXCEPT WHEN THE ROW IS HIDDEN, which has to be shown whoever owns the
         card. Standing down first left a taken-down row looking completely
         ordinary to the maintainer while it was invisible to everybody else,
         with no way back: the fade, the note and Restore are the only trace
         the override leaves on the page. The two decorators race on load —
         oa-jobedit reads the WHOLE jobSubmissions collection, this one reads a
         small filtered query — so which of them a card ends up under is a
         matter of timing, and the state must survive either. */
      if (row._oaHidden) {
        li.classList.add('oa-card-gone');
        note(li, 'You have taken this down. Only you can see it — press Restore to ' +
                 'put it back on the site.');
        var into = owned || document.createElement('div');
        if (!owned) { into.className = 'oa-card-actions'; }
        if (!into.querySelector('.oa-rowedit-restore')) {
          var back = button('Restore', 'oa-jobbtn-edit oa-rowedit-restore',
            'Put this entry back on the site',
            function (btn) { restore(dataset, row, btn); });
          into.appendChild(back);
        }
        if (!owned) { li.classList.add('oa-card-owned'); li.appendChild(into); }
        return;
      }

      if (owned) return;

      var bar = document.createElement('div');
      bar.className = 'oa-card-actions';
      bar.appendChild(button('Edit', 'oa-jobbtn-edit', 'Correct this entry', function () {
        edit(dataset, row);
      }));
      bar.appendChild(button('Take down', 'oa-jobbtn-del',
        'Remove this entry from the site', function (btn) { hide(dataset, row, btn); }));
      li.classList.add('oa-card-owned');
      li.appendChild(bar);
    };
  }

  /** The map's `onPopup` hook — the twin of `onCard`, for a Leaflet popup. */
  function onPopup(dataset) {
    return function (node, row) {
      if (!DATASETS[dataset] || !isOwn(dataset, row)) return;
      var s = st(dataset);
      if (!node || !s.ready || !s.admin) return;
      if (node.querySelector('.oa-uni-admin')) return;

      var bar = document.createElement('p');
      bar.className = 'oa-uni-admin';
      bar.appendChild(button('Edit', 'oa-jobbtn-edit', 'Correct this school', function () {
        edit(dataset, row);
      }));
      bar.appendChild(row._oaHidden
        ? button('Restore', 'oa-jobbtn-edit', 'Put this school back on the map',
            function (btn) { restore(dataset, row, btn); })
        : button('Take down', 'oa-jobbtn-del',
            'Remove this school from the map', function (btn) { hide(dataset, row, btn); }));
      if (row._oaHidden) {
        var said = document.createElement('span');
        said.className = 'oa-uni-gone';
        said.textContent = 'Taken down — only you can see this pin.';
        node.appendChild(said);
      }
      node.appendChild(bar);
    };
  }

  /* ---------------------------------------------------------------- editing

     `prompt` per field, deliberately: it is what the What's-new curation
     already uses (index.html), it needs no markup on three pages whose designs
     differ, and it works identically on a phone. Cancel on ANY field abandons
     the whole edit rather than saving half of one.                          */

  function edit(dataset, row) {
    var spec = DATASETS[dataset];
    if (!spec) return;
    /* `_oaBase` is stashed by apply() on a row that HAS an override. A row
       without one is its own base — the file's value is what is on screen —
       so falling back to `{}` here would make every field differ from '' and
       pin the lot on the very first correction. */
    var base = row._oaBase || row;
    var patch = {};
    var changed = false;

    var asText = function (v) { return v === null || v === undefined ? '' : String(v); };

    for (var i = 0; i < spec.fields.length; i++) {
      var f = spec.fields[i];
      var was = row[f.key];                           // what is on screen
      var got = window.prompt(f.label + ':', asText(was));
      if (got === null) return;                       // cancelled — save nothing
      got = String(got).trim().slice(0, f.max);

      if (f.num) {
        if (got === '') continue;                     // left blank: keep what it was
        var n = Number(got);
        if (!isFinite(n) || n < f.min || n > f.max_) {
          window.alert(f.label + ' must be a number between ' + f.min + ' and ' + f.max_ +
                       '. Nothing was saved.');
          return;
        }
        if (n !== Number(was)) changed = true;
        if (n !== Number(base[f.key])) patch[f.key] = n;
        continue;
      }
      if (got !== asText(was)) changed = true;
      /* ONLY WHAT DIFFERS FROM THE FILE. Writing every field would PIN every
         field: correct a hire's name in 2026, and when the Google Sheet is
         corrected in 2027 and the import re-run, the site would keep showing
         the 2026 placement for ever, with nothing on the page saying why. A
         value the maintainer left as it was is simply not in the override, so
         the file goes on owning it. */
      if (got !== asText(base[f.key])) patch[f.key] = got;
    }

    if (!changed) return;
    /* An override that has hidden the row is being edited: bringing it back is
       what the maintainer means by correcting it. And the write REPLACES the
       document rather than merging into it, so a field corrected back to what
       the file says stops being an override instead of lingering as one. */
    patch.hidden = false;
    save(dataset, row, patch, null, null, { replace: true });
  }

  function note(li, message) {
    var p = li.querySelector('.oa-card-note');
    if (!p) {
      p = document.createElement('p');
      p.className = 'oa-card-note';
      li.appendChild(p);
    }
    p.textContent = message;
  }

  function restore(dataset, row, btn) {
    btn.disabled = true;
    btn.textContent = 'Restoring…';
    save(dataset, row, { hidden: false }, btn, 'Restore');
  }

  function hide(dataset, row, btn) {
    var spec = DATASETS[dataset];
    if (!spec) return;
    if (!window.confirm(
      'Take this ' + spec.label + ' down?\n\n' + spec.name(row) + '\n\n' +
      'It stops appearing on the site straight away. Nothing is deleted — the ' +
      'entry stays in the site’s data files, so it can be put back.')) return;

    btn.disabled = true;
    btn.textContent = 'Taking down…';
    save(dataset, row, { hidden: true }, btn, 'Take down');
  }

  function save(dataset, row, patch, btn, label, opts) {
    var doc = {};
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) doc[k] = patch[k];
    /* The rules pin the document id to these two, so they are written on every
       save rather than only at creation — a merge that omitted them on an
       update would be refused. */
    doc.dataset = dataset;
    doc.rowId = String(row.id);
    doc.t = Date.now();

    OAFB.ready().then(function (fb) {
      var ref = fb.firestore().collection(COLLECTION).doc(dataset + '__' + row.id);
      return (opts && opts.replace) ? ref.set(doc) : ref.set(doc, { merge: true });
    }).then(function () {
      var s = st(dataset);
      var now = {};
      if (!(opts && opts.replace)) {
        var was = s.rows[row.id] || {};
        for (var a in was) if (Object.prototype.hasOwnProperty.call(was, a)) now[a] = was[a];
      }
      for (var b in doc) if (Object.prototype.hasOwnProperty.call(doc, b)) now[b] = doc[b];
      s.rows[row.id] = now;
      if (s.onChange) s.onChange();
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = label || 'Take down'; }
      window.alert(err && err.code === 'permission-denied'
        ? 'You are not allowed to change this — and if you are the maintainer, the ' +
          'updated Firestore rules have not been published yet.'
        : 'We could not save that. Please try again.');
      if (window.console) console.error('oa-rowedit:', err);
    });
  }

  /* ---------------------------------------------------------------- loading */

  /**
   * Load a dataset's overrides and watch the sign-in state.
   *
   * `onChange` is called whenever what the page should show has changed — the
   * overrides arrived, or the visitor turned out to be the maintainer. Wholly
   * best-effort: with Firestore unconfigured or its rules unpublished, the
   * page renders exactly the committed file, which is what it did before there
   * was any curation at all.
   */
  function attach(dataset, cfg) {
    var s = st(dataset);
    s.onChange = (cfg && cfg.onChange) || null;

    if (!window.OAFB || !OAFB.enabled) { s.ready = true; if (s.onChange) s.onChange(); return; }

    OAFB.ready().then(function (fb) {
      fb.firestore().collection(COLLECTION).where('dataset', '==', dataset).get()
        .then(function (snap) {
          snap.forEach(function (d) {
            var v = d.data() || {};
            if (v.rowId) s.rows[v.rowId] = v;
          });
          s.ready = true;
          if (s.onChange) s.onChange();
        })['catch'](function () {
          // rules not published, or offline — no curation, and the page is fine
          s.ready = true;
          if (s.onChange) s.onChange();
        });

      fb.auth().onAuthStateChanged(function (u) {
        var was = s.admin;
        s.admin = isAdmin(u);
        if (s.admin !== was && s.onChange) s.onChange();
      });
    })['catch'](function () {
      s.ready = true;
      if (s.onChange) s.onChange();
    });
  }

  /**
   * A cheap, exact fingerprint of everything that changes what a page shows.
   *
   * `attach` calls back when the overrides land and again when the sign-in
   * state resolves, which for the overwhelmingly common visit — no overrides,
   * not the maintainer — means "nothing changed" twice. Acting on it anyway
   * costs a full re-render a second after first paint, and on the map a
   * `fitBounds` that visibly jumps the view somebody may already be reading.
   * So a page holds the last fingerprint and does nothing when it matches.
   */
  function signature(dataset) {
    var s = st(dataset);
    return (s.admin ? 'a' : '-') + '|' + JSON.stringify(s.rows);
  }

  window.OARowEdit = {
    apply: apply,
    own: own,
    signature: signature,
    onCard: onCard,
    onPopup: onPopup,
    attach: attach,
    datasets: function () { return Object.keys(DATASETS); },
    fields: function (dataset) {
      return (DATASETS[dataset] ? DATASETS[dataset].fields : []).map(function (f) {
        return f.key;
      });
    },

    /* The override map comes from a Firestore read CI cannot make. This lets
       the browser test drive the part that matters — which rows are hidden,
       which values are overlaid, and who sees the buttons — without a
       database. It only ever changes what is DRAWN; the rules remain the
       authorisation, so a test-set override still cannot write anything. */
    __setForTest: function (dataset, p) {
      var s = st(dataset);
      s.ready = p.ready !== false;
      s.admin = !!p.admin;
      s.rows = p.rows || {};
      if (s.onChange) s.onChange();
    },
  };
})();
