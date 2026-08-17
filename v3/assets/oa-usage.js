/* ---------------------------------------------------------------------------
   Operations Academia — usage insights (v3, admin-only readback).

   Records how SIGNED-IN visitors use the site (owner, 2026-08-17): one
   Firestore doc per browsing session at usageSessions/{uid}__{sid} carrying
   the page, when the session started, a rolling duration, and the links and
   buttons clicked (short label + href, capped). Anonymous visitors are never
   recorded — there is no identity to record against, and the point is to see
   how ACCOUNTS use the site. The deployed _firestore.rules make each doc
   writable only by its own visitor and readable ONLY by the admin; the
   collection is disclosed in the Privacy Policy. Inert until those rules are
   deployed — every write is best-effort and silently dropped on refusal.

   Loads on every v3 page after oa-firebase.js; no other file depends on it.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (!window.OAFB || !OAFB.enabled) return;

  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var start = Date.now();
  var clicks = [];
  var user = null;
  var timer = null;
  var pending = false;

  function flush() {
    if (!user || pending) return;
    pending = true;
    var payload = {
      uid: user.uid,
      email: user.email || '',
      sid: sid,
      page: (location.pathname + location.search).slice(0, 300),
      start: start,
      last: Date.now(),
      dur: Math.round((Date.now() - start) / 1000),
      clicks: clicks.slice(0, 400)
    };
    OAFB.ready()
      .then(function (fb) {
        return fb.firestore().collection('usageSessions')
          .doc(user.uid + '__' + sid).set(payload, { merge: true });
      })
      .then(function () { pending = false; })
      .catch(function () { pending = false; /* rules not deployed / offline */ });
  }

  // capture-phase, so a click that navigates away is still seen; only
  // interactive elements, short label only — never form VALUES
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a, button');
    if (!el || !user) return;
    clicks.push({
      t: Date.now(),
      k: el.tagName.toLowerCase(),
      x: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      h: (el.getAttribute('href') || '').slice(0, 200)
    });
    if (clicks.length > 400) clicks = clicks.slice(-400);
  }, true);

  OAFB.ready().then(function (fb) {
    fb.auth().onAuthStateChanged(function (u) {
      user = u || null;
      if (timer) { clearInterval(timer); timer = null; }
      if (user) {
        flush();                                  // session opens
        timer = setInterval(flush, 60000);        // rolling duration
      }
    });
  }).catch(function () { /* SDK unreachable — record nothing */ });

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
})();
