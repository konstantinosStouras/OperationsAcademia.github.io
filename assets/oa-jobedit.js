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
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  function col() {
    return (window.OAFB && OAFB.col && OAFB.col.jobSubmissions) || 'jobSubmissions';
  }

  /* What a signed-in user may touch, keyed both ways: a posting migrated off
     the sheet has the row's own id as its document id, while one made through
     the form has a random document id and carries a `ref`. */
  var perm = { ready: false, admin: false, byId: {}, byRef: {}, uid: null };
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
    if (perm.byId[row.id]) return perm.byId[row.id];
    return '';
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
      'Correct this posting', function () {
        location.href = 'post-a-job.html?edit=' + encodeURIComponent(id);
      }));

    bar.appendChild(button('Take down', 'oa-jobbtn-del',
      'Remove this posting from the site', function (btn) {
        takeDown(id, row, btn);
      }));

    li.classList.add('oa-card-owned');
    li.appendChild(bar);
  }

  function takeDown(id, row, btn) {
    var what = row.institution + (row.department ? ' — ' + row.department : '');
    if (!window.confirm(
      'Take this posting down?\n\n' + what + '\n\n' +
      'It stops appearing on the site within a few minutes. ' +
      'Nothing is deleted — tell us and it can be put back.')) return;

    btn.disabled = true;
    btn.textContent = 'Taking down…';

    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(col()).doc(id).update({
      // 'hidden' is the maintainer taking something down; 'withdrawn' is the
      // poster withdrawing their own. Both take the row out at the next build;
      // keeping them distinct says WHO did it without a second field.
        status: perm.admin ? 'hidden' : 'withdrawn',
        updatedAt: new Date().toISOString(),
      });
    }).then(function () {
      /* The echo (assets/oa-fresh.js): the next time THIS browser loads the
         list, the row is already gone, while the build takes it down for
         everyone else. */
      if (window.OAFresh) OAFresh.stash({ docId: id, ref: row.ref || '', removed: true });
      btn.textContent = 'Taken down';
      var li = btn.closest('.oa-card');
      if (li) li.classList.add('oa-card-gone');
      note(li, 'This posting has been taken down. It is already gone from the ' +
               'list on this device; for everyone else it disappears within a ' +
               'few minutes.');
    }).catch(function (err) {
      fail(btn, err && err.code === 'permission-denied'
        ? 'You are not allowed to change this posting.'
        : 'We could not take it down. Please try again.');
      if (window.console) console.error('take down:', err);
    });
  }

  function fail(btn, message) {
    btn.disabled = false;
    btn.textContent = 'Take down';
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
    perm = { ready: false, admin: false, byId: {}, byRef: {}, uid: user && user.uid };

    if (!user || !window.OAFB || !OAFB.enabled) { perm.ready = true; redraw(); return; }

    perm.admin = isAdmin(user);

    OAFB.ready().then(function (fb) {
      /* The maintainer reads the collection; everyone else reads only their
         own. Both are exactly what the rules allow, so the narrower query is
         not a courtesy — a poster's broad read would simply be refused. */
      var c = fb.firestore().collection(col());
      return (perm.admin ? c : c.where('uid', '==', user.uid)).get();
    }).then(function (snap) {
      snap.forEach(function (d) {
        var v = d.data() || {};
        perm.byId[d.id] = d.id;
        if (v.ref) perm.byRef[v.ref] = d.id;
      });
      perm.ready = true;
      redraw();
    }).catch(function (err) {
      // Not fatal: the page keeps working, just without the controls.
      perm.ready = true;
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
               byRef: p.byRef || {}, uid: p.uid || null };
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
