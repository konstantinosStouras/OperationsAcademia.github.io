/* ---------------------------------------------------------------------------
   Operations Academia — placements Edit / Take down hook.  (v3)

   EXTRACTED VERBATIM from the inline block in /placements.html so the v3
   one-page site can reuse it — keep the logic in sync with that page. The
   placements twin of assets/oa-jobedit.js: the rules in _firestore.rules are
   the authorisation — everything here only decides whether a button is DRAWN.

   Taking a placement down is a STATUS CHANGE, never a document delete:
   build-placements.mjs preserves rows whose document is missing (the
   orphan-carry), so a hard delete would look like it worked and change
   nothing.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var OAPlacementEdit = (function () {
    function colName() {
      return (window.OAFB && OAFB.col && OAFB.col.placementSubmissions) || 'placementSubmissions';
    }

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
        'Correct this placement', function () {
          location.href = 'post-a-placement.html?edit=' + encodeURIComponent(id);
        }));

      bar.appendChild(button('Take down', 'oa-jobbtn-del',
        'Remove this placement from the site', function (btn) {
          takeDown(id, row, btn);
        }));

      li.classList.add('oa-card-owned');
      li.appendChild(bar);
    }

    function takeDown(id, row, btn) {
      var what = (row.name || '') + (row.joiningInstitution ? ' — ' + row.joiningInstitution : '');
      if (!window.confirm(
        'Take this placement down?\n\n' + what + '\n\n' +
        'It stops appearing on the site at the next update, normally within an ' +
        'hour. Nothing is deleted — tell us and it can be put back.')) return;

      btn.disabled = true;
      btn.textContent = 'Taking down…';

      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(colName()).doc(id).update({
          // 'hidden' is the maintainer taking something down; 'withdrawn'
          // is the reporter withdrawing their own. Both take the row out
          // at the next build; keeping them distinct says WHO did it.
          status: perm.admin ? 'hidden' : 'withdrawn',
          updatedAt: new Date().toISOString(),
        });
      }).then(function () {
        btn.textContent = 'Taken down';
        var li = btn.closest('.oa-card');
        if (li) li.classList.add('oa-card-gone');
        note(li, 'This placement has been taken down. It will disappear from ' +
                 'the list at the next update.');
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Take down';
        note(btn.closest('.oa-card'), err && err.code === 'permission-denied'
          ? 'You are not allowed to change this placement.'
          : 'We could not take it down. Please try again.', true);
        if (window.console) console.error('take down:', err);
      });
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

    function load(user) {
      perm = { ready: false, admin: false, byId: {}, byRef: {}, uid: user && user.uid };

      if (!user || !window.OAFB || !OAFB.enabled) { perm.ready = true; redraw(); return; }

      perm.admin = isAdmin(user);

      OAFB.ready().then(function (fb) {
        /* The maintainer reads the collection; everyone else reads only
           their own. Both are exactly what the rules allow, so the
           narrower query is not a courtesy — a reporter's broad read
           would simply be refused. */
        var c = fb.firestore().collection(colName());
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
        if (window.console) console.warn('placement permissions:', err);
      });
    }

    function redraw() {
      if (list && list.rerender) list.rerender();
    }

    return {
      onCard: decorate,

      /* The permission map comes from a Firestore read, which CI cannot
         make. This lets a browser test drive WHICH cards get controls
         without a database — same hook as oa-jobedit.js. It only ever
         narrows what is drawn; the rules remain the authorisation. */
      __setPermissionsForTest: function (p) {
        perm = { ready: !!p.ready, admin: !!p.admin, byId: p.byId || {},
                 byRef: p.byRef || {}, uid: p.uid || null };
        redraw();
      },

      attach: function (instance) {
        list = instance;
        if (window.OAAccounts && OAAccounts.onChange) {
          OAAccounts.onChange(function (user) { load(user); });
        }
      },
    };
  })();

  window.OAPlacementEdit = OAPlacementEdit;
})();
