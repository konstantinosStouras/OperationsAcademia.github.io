/* ---------------------------------------------------------------------------
   Operations Academia — Edit and Take down, on the candidate profiles you may
   change. The candidates twin of oa-jobedit.js, which carries the full
   reasoning; the shape is identical and only the dataset differs.

   WHO MAY CHANGE WHAT
     - the maintainer may edit or take down ANY profile;
     - a candidate may edit or take down THEIR OWN.
   Both are enforced in v2/_firestore.rules, which is the actual authorisation.
   Everything here only decides whether a button is DRAWN — a page that draws
   no button still cannot write, and a page that draws one on the wrong card
   still gets refused by the rules.

   HOW THE PAGE KNOWS WHOSE PROFILE IS WHOSE: it ASKS, once, after sign-in
   resolves — the maintainer reads the collection, everyone else reads
   `where uid == me`. The owner's uid is deliberately NOT in
   data/candidates.json (only its short digest is, as `owner`), so the served
   file identifies nobody.

   TAKING A PROFILE DOWN IS A STATUS CHANGE, never a document delete — a
   deleted document leaves its row orphaned in the served file, which
   build-candidates.mjs deliberately PRESERVES, so a hard delete would look
   like it had worked and change nothing. `withdrawn` (the candidate) and
   `hidden` (the maintainer) both take the row out at the next build.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  function col() {
    return (window.OAFB && OAFB.col && OAFB.col.candidateSubmissions) || 'candidateSubmissions';
  }

  /* What a signed-in user may touch, keyed both ways: an imported profile
     would have the row's own id as its document id, while one made through
     the form has a random document id and carries a `ref`. `own` narrows
     further — the documents that are the signed-in user's OWN profile, not
     merely ones the admin may touch: the "Post confirmed placement" invite
     (owner, 2026-08-24) is the CANDIDATE's control, drawn only on their own
     card, so the admin browsing the list is not offered it on everyone
     else's. For a non-admin the two sets are identical by construction (the
     query is where uid == me). */
  var perm = { ready: false, admin: false, byId: {}, byRef: {}, own: {}, uid: null };
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
      'Edit this profile — its text, its files, or both', function () {
        location.href = 'post-a-candidate.html?edit=' + encodeURIComponent(id);
      }));

    bar.appendChild(button('Take down', 'oa-jobbtn-del',
      'Remove this profile from the site', function (btn) {
        takeDown(id, row, btn);
      }));

    /* The candidate's own invite to close the loop (owner, 2026-08-24): once
       a position is confirmed, report it on the Placements page. Drawn ONLY
       on the signed-in candidate's OWN card — nobody else, the admin
       included, sees it on this profile — and it grants nothing: it is a
       link to the placement form everyone can already reach. */
    if (perm.own[id]) {
      bar.appendChild(button('Post confirmed placement', 'oa-jobbtn-edit',
        'Confirmed a position? Report your placement — only you see this ' +
        'button, on your own profile', function () {
          location.href = 'post-a-placement.html';
        }));
    }

    li.classList.add('oa-card-owned');
    li.appendChild(bar);
  }

  function takeDown(id, row, btn) {
    var what = row.name + (row.affiliation ? ' — ' + row.affiliation : '');
    if (!window.confirm(
      'Take this profile down?\n\n' + what + '\n\n' +
      'It stops appearing on the candidates page within a few minutes, or is left ' +
      'out of the reveal if that is still to come. Nothing is deleted: editing it ' +
      'again puts it back.')) return;

    btn.disabled = true;
    btn.textContent = 'Taking down…';

    OAFB.ready().then(function (fb) {
      return fb.firestore().collection(col()).doc(id).update({
      // 'hidden' is the maintainer taking something down; 'withdrawn' is the
      // candidate withdrawing their own. Both take the row out at the next
      // build; keeping them distinct says WHO did it without a second field.
        status: perm.admin ? 'hidden' : 'withdrawn',
        updatedAt: new Date().toISOString(),
      });
    }).then(function () {
      btn.textContent = 'Taken down';
      var li = btn.closest('.oa-card');
      if (li) li.classList.add('oa-card-gone');
      note(li, 'This profile has been taken down. It will disappear from the ' +
               'list at the next update.');
    }).catch(function (err) {
      fail(btn, err && err.code === 'permission-denied'
        ? 'You are not allowed to change this profile.'
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
    perm = { ready: false, admin: false, byId: {}, byRef: {}, own: {}, uid: user && user.uid };

    if (!user || !window.OAFB || !OAFB.enabled) { perm.ready = true; redraw(); return; }

    perm.admin = isAdmin(user);

    OAFB.ready().then(function (fb) {
      /* The maintainer reads the collection; everyone else reads only their
         own. Both are exactly what the rules allow, so the narrower query is
         not a courtesy — a candidate's broad read would simply be refused. */
      var c = fb.firestore().collection(col());
      return (perm.admin ? c : c.where('uid', '==', user.uid)).get();
    }).then(function (snap) {
      snap.forEach(function (d) {
        var v = d.data() || {};
        perm.byId[d.id] = d.id;
        if (v.ref) perm.byRef[v.ref] = d.id;
        // OWN is by uid, never by privilege: the admin's broad read covers
        // everyone, but only their own profile is theirs
        if (v.uid && v.uid === perm.uid) perm.own[d.id] = true;
      });
      perm.ready = true;
      redraw();
    }).catch(function (err) {
      // Not fatal: the page keeps working, just without the controls.
      perm.ready = true;
      redraw();
      if (window.console) console.warn('candidate permissions:', err);
    });
  }

  function redraw() {
    if (list && list.rerender) list.rerender();
  }

  /* ---------------------------------------------------------------- wiring */

  window.OACandidateEdit = {
    /** Passed to OAList.mount as `onCard`. */
    onCard: decorate,

    /* The permission map comes from a Firestore read, which CI cannot make.
       Test-only, like oa-jobedit's: it only ever narrows what is drawn; the
       rules remain the authorisation. */
    __setPermissionsForTest: function (p) {
      perm = { ready: !!p.ready, admin: !!p.admin, byId: p.byId || {},
               byRef: p.byRef || {}, own: p.own || {}, uid: p.uid || null };
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
