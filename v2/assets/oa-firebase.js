/* ---------------------------------------------------------------------------
   Operations Academia — Firebase configuration, one place.

   INERT UNTIL CONFIGURED. Every OA feature that needs Firebase (sign-in,
   posting a job, e-mail alerts, feedback) checks OAFB.enabled first and
   degrades to a plain, honest "not available yet" state rather than throwing.
   That is the same gate /lit/ uses (LIT_ACCOUNTS_ENABLED), and it is what lets
   this whole site be committed and served before the project exists.

   TO ACTIVATE: create the Firebase project, then paste its web config below
   and republish v2/_firestore.rules. Steps: v2/_SETUP-FIREBASE.md
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  // The web config of the `operations-academia` Firebase project.
  //
  // NOT A SECRET. It identifies the project to the browser and is visible in
  // the page source of every Firebase site on the internet. What protects the
  // data is v2/_firestore.rules — which is why those must be deployed before
  // the site is announced.
  var FB_CONFIG = {
    apiKey: 'AIzaSyD2iytcJ66wHW4UMR0efJkX3Bk1cHZwZI8',
    authDomain: 'operations-academia.firebaseapp.com',
    projectId: 'operations-academia',
    storageBucket: 'operations-academia.firebasestorage.app',
    messagingSenderId: '64536305283',
    appId: '1:64536305283:web:82626604b00bd6dd4945b6'
    // The console also issues `measurementId: 'G-2CX86W7PHB'` for Google
    // Analytics. It is deliberately omitted: nothing here loads the analytics
    // SDK, so carrying it would only imply a second analytics property is
    // running on the site when none is. Add it back alongside the SDK if you
    // ever decide to use GA4 (see _PLAN.md — the site's existing Universal
    // Analytics has been dead since July 2023 and wants a decision either way).
  };

  // Sign-in methods offered on the auth modal, in display order.
  //
  // 'orcid' is a GENERIC OIDC provider (`oidc.orcid`), which Firebase only
  // offers once the project is upgraded to Identity Platform. Until that is
  // done the button is present but Firebase answers
  // `auth/operation-not-allowed`, which the modal reports as "that sign-in
  // method is not switched on for this site yet" rather than a raw error.
  // Steps: v2/_SETUP-FIREBASE.md, "ORCID".
  var AUTH_PROVIDERS = ['google', 'orcid', 'password'];

  // The maintainer. Governs who sees the admin inboxes. This is a UI hint
  // only — the real check is isAdmin() in v2/_firestore.rules.
  var ADMIN_EMAIL = 'kstouras@gmail.com';

  var enabled = !!(
    FB_CONFIG.apiKey &&
    FB_CONFIG.apiKey.indexOf('PASTE_') === -1 &&
    FB_CONFIG.projectId &&
    FB_CONFIG.projectId.indexOf('PASTE_') === -1
  );

  var SDK = 'https://www.gstatic.com/firebasejs/10.12.5/';
  var PARTS = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];

  var readyPromise = null;

  /** Resolves with the firebase namespace, or rejects when not configured. */
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (!enabled) {
        reject(new Error('firebase-not-configured'));
        return;
      }
      var i = 0;
      (function next() {
        if (i >= PARTS.length) {
          try {
            if (!window.firebase.apps.length) window.firebase.initializeApp(FB_CONFIG);
            resolve(window.firebase);
          } catch (e) { reject(e); }
          return;
        }
        var s = document.createElement('script');
        s.src = SDK + PARTS[i++];
        s.onload = next;
        s.onerror = function () { reject(new Error('firebase-sdk-load-failed')); };
        document.head.appendChild(s);
      })();
    });
    return readyPromise;
  }

  window.OAFB = {
    enabled: enabled,
    config: FB_CONFIG,
    providers: AUTH_PROVIDERS,
    adminEmail: ADMIN_EMAIL,
    ready: ready,

    /* Collection names, so a rename is a one-line change here and in the rules.
       Mirrors the /lit/ layout:
         users/{uid}                  private per-account subtree (alerts live under it)
         users/{uid}/alerts/{id}      e-mail alert subscriptions
         users/{uid}/testEmails/{id}  one-off "send me a test" requests
         profiles/{uid}               the account's own profile document
         registeredUsers/{uid}        contentless public tally, for the count() aggregate
         accountKeys/{key}            "one person, two accounts" hints (orcid:… / email:…)
         jobSubmissions/{id}          a posted job, before the build commits it to JSON
         feedback/{id}                feedback + screenshots                          */
    col: {
      users: 'users',
      alerts: 'alerts',
      testEmails: 'testEmails',
      profiles: 'profiles',
      registered: 'registeredUsers',
      accountKeys: 'accountKeys',
      jobSubmissions: 'jobSubmissions',
      feedback: 'feedback'
    }
  };
})();
