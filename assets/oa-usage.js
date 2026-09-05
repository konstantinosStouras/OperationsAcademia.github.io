/* ---------------------------------------------------------------------------
   Operations Academia — usage insights (v3, admin-only readback).

   Records how visitors use the site (owner, 2026-08-17): one Firestore doc
   per browsing session at usageSessions/{who}__{sid} carrying the page, when
   the session started, a rolling duration, the links and buttons clicked
   (short label + href, capped), and which FORM FIELDS were touched, in what
   order (field name + focus/change stamps — deliberately NEVER the text
   typed: that would capture passwords and drafts people chose not to submit,
   while everything actually submitted already lands in its own collection).

   Signed-in visitors are recorded under their uid; anonymous visitors under
   a random per-browser id ('anon:…', localStorage), so returning visits
   correlate without naming anyone. The deployed _firestore.rules pin each
   doc to its own writer (the doc id embeds the random sid, so nothing else
   can be touched) and make the collection readable ONLY by the admin; it is
   disclosed in the Privacy Policy. Inert until those rules are deployed —
   every write is best-effort and silently dropped on refusal.

   Loads on every v3 page after oa-firebase.js; no other file depends on it.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (!window.OAFB || !OAFB.enabled) return;

  var sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var start = Date.now();
  var clicks = [];
  var fields = [];
  var user = null;      // Firebase user, or null while anonymous
  var timer = null;
  var pending = false;

  /** A password account whose address is not confirmed yet is signed out
      for everything on the site, this record included: the rules refuse a
      session filed under its uid (verified() in _firestore.rules), and a
      refused write is silently dropped below, so the session would simply
      vanish from the record. It is filed as an anonymous visitor instead.
      The test is the one assets/oa-accounts.js makes in needsVerification. */
  function usable(u) {
    if (!u) return null;
    var pw = (u.providerData || []).some(function (p) { return !!p && p.providerId === 'password'; });
    return u.emailVerified === false && pw ? null : u;
  }

  /** The page a session is filed under. verify-email.html is opened with a
      one-time verification code on its query string, and a code is a
      credential: it is never copied into a record, so a query carrying one
      is dropped whole and the path alone is kept. */
  function pageOf() {
    var q = String(location.search || '');
    if (/[?&]oobCode=/.test(q)) return location.pathname.slice(0, 300);
    return (location.pathname + q).slice(0, 300);
  }

  /** The identity a session is filed under: the uid, else a stable random
      per-browser id so an anonymous visitor's return visits correlate. */
  function who() {
    if (user) return user.uid;
    try {
      var a = localStorage.getItem('oaUsageAnon');
      if (!a) {
        a = 'anon:' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        localStorage.setItem('oaUsageAnon', a);
      }
      return a;
    } catch (e) {
      return 'anon:' + sid;               // private mode — session-scoped only
    }
  }

  function flush() {
    if (pending) return;
    pending = true;
    var id = who();
    var payload = {
      uid: id,
      email: (user && user.email) || '',
      sid: sid,
      page: pageOf(),
      start: start,
      last: Date.now(),
      dur: Math.round((Date.now() - start) / 1000),
      clicks: clicks.slice(0, 400),
      fields: fields.slice(0, 300)
    };
    OAFB.ready()
      .then(function (fb) {
        return fb.firestore().collection('usageSessions')
          .doc(id + '__' + sid).set(payload, { merge: true });
      })
      .then(function () { pending = false; })
      .catch(function () { pending = false; /* rules not deployed / offline */ });
  }

  // capture-phase, so a click that navigates away is still seen; only
  // interactive elements, short label only — never form VALUES
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a, button');
    if (!el) return;
    clicks.push({
      t: Date.now(),
      k: el.tagName.toLowerCase(),
      x: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      h: (el.getAttribute('href') || '').slice(0, 200)
    });
    if (clicks.length > 400) clicks = clicks.slice(-400);
  }, true);

  /** Form INTERACTION, not content: which field, when it was entered, and
      whether it ended up changed — the order/dwell/abandonment signal. The
      element's .value is never read, on any field type. */
  function fieldName(el) {
    return (el.name || el.id || el.type || el.tagName.toLowerCase()).slice(0, 60);
  }
  function markField(e, kind) {
    var el = e.target;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    fields.push({ t: Date.now(), f: fieldName(el), k: kind });
    if (fields.length > 300) fields = fields.slice(-300);
  }
  document.addEventListener('focusin', function (e) { markField(e, 'focus'); }, true);
  document.addEventListener('change', function (e) { markField(e, 'change'); }, true);

  OAFB.ready().then(function (fb) {
    fb.auth().onAuthStateChanged(function (u) {
      user = usable(u);
      if (!timer) {
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
