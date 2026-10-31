/* ---------------------------------------------------------------------------
   Operations Academia — Edit and Take down, on the postings you may change.

   WHO MAY CHANGE WHAT
     - the maintainer may edit or take down ANY posting;
     - a poster may edit or take down THEIR OWN.
   Both are enforced in v2/_firestore.rules, which is the actual authorisation.
   Everything here only decides whether a button is DRAWN — a page that draws no
   button still cannot write, and a page that draws one on the wrong card still
   gets refused by the rules.

   HOW THE PAGE KNOWS WHOSE POSTING IS WHOSE. It does not, from the data: the
   owner's `uid` is deliberately NOT in PUBLIC_FIELDS, so data/jobs.json says
   nothing about who posted what. Publishing it would put an account identifier
   for every posting into a public repository to save one query.

   So the page ASKS instead, once, after sign-in resolves: the maintainer reads
   the collection, everyone else reads `where uid == me`. The rules already
   allow exactly those two reads and nothing else, so an ordinary visitor
   learns nothing and a signed-in poster learns only about their own.

   TAKING A POSTING DOWN IS A STATUS CHANGE, never a document delete. A deleted
   document leaves its row in the served file with nothing to account for it —
   which build-jobs.mjs deliberately PRESERVES, so a hard delete would look like
   it had worked and change nothing. `withdrawn` (poster) and `hidden`
   (maintainer) both take the row out at the next build.

   ...AND THE WHOLE OF IT LIVES IN assets/oa-takedown.js, which this file is
   now one of four callers of. It was written out here and again in
   oa-myjobs.js, and the two had already parted company over the echo and over
   how long the site takes; the owner's two new buttons (the edit form and the
   Admin area's user-added card, 2026-09-18) would have made four copies of an
   eight-line write. What is left here is the half that is genuinely this
   file's: WHICH CARDS get controls at all.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  function col() {
    return (window.OAFB && OAFB.col && OAFB.col.jobSubmissions) || 'jobSubmissions';
  }

  /* What a signed-in user may touch, keyed both ways: a posting migrated off
     the sheet has the row's own id as its document id, while one made through
     the form has a random document id and carries a `ref`. */
  var perm = { ready: false, admin: false, byId: {}, byRef: {}, bySheetId: {}, uid: null };
  var list = null;   // the OAList instance, so cards can be redrawn late

  function isAdmin(user) {
    var want = String((window.OAFB && OAFB.adminEmail) || '').toLowerCase();
    return !!(user && want && user.email && user.email.toLowerCase() === want &&
              user.emailVerified);
  }

  /** The document id for a row, or '' when this user may not touch it. */
  function docIdFor(row) {
    if (!perm.ready) return '';
    if (row.ref && perm.byRef[row.ref]) return perm.byRef[row.ref];
    // Publication may suffix a sheet row's id when a member job shares it.
    // Keep the source record as the editing target, before trying the URL id.
    if (row.sourceId && perm.bySheetId[row.sourceId]) return perm.bySheetId[row.sourceId];
    if (!row.sourceId && perm.bySheetId[row.id]) return perm.bySheetId[row.id];
    if (!row.sourceId && perm.byId[row.id]) return perm.byId[row.id];
    // Carried-forward rows can outlive their mirror. Only the maintainer may
    // repair a missing handle; posters still need an owned document.
    var id = String(row.sourceId || row.id || '');
    return perm.admin && /^[A-Za-z0-9._~-]+$/.test(id) ? id : '';
  }

  // Create a missing handle on use. The transaction never overwrites a
  // submission created concurrently under the same id.
  function ensureHandle(id, row) {
    if (perm.byId[id]) return Promise.resolve(id);
    var mine = perm;
    if (!mine.admin || !window.OAFresh || !OAFresh.mirrorDoc) {
      return Promise.reject(new Error('editing record unavailable'));
    }
    return OAFB.ready().then(function (fb) {
      if (perm !== mine || !mine.admin) throw new Error('session changed');
      var db = fb.firestore();
      var ref = db.collection(col()).doc(id);
      return db.runTransaction(function (tx) {
        return tx.get(ref).then(function (snap) {
          if (perm !== mine) throw new Error('session changed');
          if (snap.exists) {
            var v = snap.data() || {};
            if (v.uid || (v.sheetId !== id && v.publishedId !== row.id)) {
              throw new Error('editing record identity conflict');
            }
          } else {
            var mirror = OAFresh.mirrorDoc(Object.assign({}, row, { id: id }), {
              canonCountry: window.OACountries && OACountries.canon,
            });
            mirror.publishedId = row.id;
            // An old form posting is not a workbook row. Giving it sheetId
            // would make the build drop its edits when absent from the sheet.
            if (!row.sourceId && row.source !== 'jobmarket-sheet') delete mirror.sheetId;
            tx.set(ref, mirror);
          }
          return id;
        });
      });
    });
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

  function decorate(li, row) {
    var existing = li.querySelector('.oa-card-actions');
    if (existing) existing.remove();

    var id = docIdFor(row);
    if (!id) return;

    var bar = document.createElement('div');
    bar.className = 'oa-card-actions';

    bar.appendChild(button('Edit', 'oa-jobbtn-edit',
      'Correct this posting', function (btn) {
        btn.disabled = true;
        ensureHandle(id, row).then(function (target) {
          location.href = 'post-a-job?edit=' + encodeURIComponent(target);
        }).catch(function () {
          btn.disabled = false;
          note(li, 'We could not open this posting for editing. Please try again.', true);
        });
      }));

    bar.appendChild(button(OATakedown.LABEL, 'oa-jobbtn-del',
      'Remove this posting from the site', function (btn) {
        takeDown(id, row, btn);
      }));

    li.classList.add('oa-card-owned');
    li.appendChild(bar);
  }

  function takeDown(id, row, btn) {
    if (!OATakedown.confirm(row)) return;

    btn.disabled = true;
    btn.textContent = 'Taking down…';

    ensureHandle(id, row).then(function (target) {
      return OATakedown.run({ id: target, row: row });
    }).then(function () {
      btn.textContent = 'Taken down';
      var li = btn.closest('.oa-card');
      if (li) li.classList.add('oa-card-gone');
      note(li, 'This posting has been taken down. It is already gone from the ' +
               'list on this device; for everyone else it disappears ' +
               OATakedown.WHEN + '.');
    }).catch(function (err) {
      fail(btn, OATakedown.failure(err));
      if (window.console) console.error('take down:', err);
    });
  }

  function fail(btn, message) {
    btn.disabled = false;
    btn.textContent = OATakedown.LABEL;
    note(btn.closest('.oa-card'), message, true);
  }

  function note(li, message, bad) {
    if (!li) { window.alert(message); return; }
    var p = li.querySelector('.oa-card-note');
    if (!p) {
      p = document.createElement('p');
      p.className = 'oa-card-note';
      li.appendChild(p);
    }
    p.classList.toggle('is-bad', !!bad);
    p.textContent = message;
  }

  /* ------------------------------------------------------------ permissions */

  function load(user) {
    /* EACH REQUEST OWNS ITS OWN MAP, and commits only while it is still the
       current one. The then/catch used to write into the module-level `perm`,
       so a query still in flight when the session changed emptied its document
       ids into the NEXT reader's map — and the session can change without a
       page load: signOut() calls notify(null) synchronously and the sign-in
       box is an in-page modal. The result was Edit and Take down drawn on
       somebody else's postings, and on a signed-out reader's locked cards; the
       rules refuse the write, but a control that is drawn and pressed against
       another person's posting is the defect. `perm.uid` was captured for this
       and never read; identity (`perm !== mine`) is the stronger test, since
       it also covers a same-uid double fire. */
    var mine = { ready: false, admin: false, byId: {}, byRef: {}, bySheetId: {}, uid: (user && user.uid) || null };
    perm = mine;

    if (!user || !window.OAFB || !OAFB.enabled) { mine.ready = true; redraw(); return; }

    mine.admin = isAdmin(user);

    OAFB.ready().then(function (fb) {
      /* The maintainer reads the collection; everyone else reads only their
         own. Both are exactly what the rules allow, so the narrower query is
         not a courtesy — a poster's broad read would simply be refused. */
      var c = fb.firestore().collection(col());
      return (mine.admin ? c : c.where('uid', '==', user.uid)).get();
    }).then(function (snap) {
      if (perm !== mine) return;          // a later auth event owns the page now
      snap.forEach(function (d) {
        var v = d.data() || {};
        mine.byId[d.id] = d.id;
        if (v.ref) mine.byRef[v.ref] = d.id;
        if (!v.uid && v.sheetId) mine.bySheetId[v.sheetId] = d.id;
      });
      mine.ready = true;
      redraw();
    }).catch(function (err) {
      if (perm !== mine) return;
      // Not fatal: the page keeps working, just without the controls.
      mine.ready = true;
      redraw();
      if (window.console) console.warn('job permissions:', err);
    });
  }

  function redraw() {
    if (list && list.rerender) list.rerender();
  }

  /* ---------------------------------------------------------------- wiring */

  window.OAJobEdit = {
    /** Passed to OAList.mount as `onCard`. */
    onCard: decorate,

    /* The permission map comes from a Firestore read, which CI cannot make.
       This lets the browser test drive the part that matters — WHICH cards get
       controls — without a database. It only ever narrows what is drawn; the
       rules remain the authorisation, so a test-set permission still cannot
       write anything. */
    __setPermissionsForTest: function (p) {
      perm = { ready: !!p.ready, admin: !!p.admin, byId: p.byId || {},
               byRef: p.byRef || {}, bySheetId: p.bySheetId || {}, uid: p.uid || null };
      redraw();
    },

    /** Called with the OAList instance once mounted. */
    attach: function (instance) {
      list = instance;
      if (window.OAAccounts && OAAccounts.onChange) {
        OAAccounts.onChange(function (user) { load(user); });
      }
    },
  };
})();
