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

  var FB_CONFIG = {
    apiKey: 'PASTE_API_KEY',
    authDomain: 'PASTE_PROJECT.firebaseapp.com',
    projectId: 'PASTE_PROJECT',
    storageBucket: 'PASTE_PROJECT.appspot.com',
    messagingSenderId: 'PASTE_SENDER_ID',
    appId: 'PASTE_APP_ID'
  };

  // Sign-in methods offered on the auth modal, in display order.
  // 'orcid' additionally needs the OIDC provider configured in the console —
  // see v2/_SETUP-FIREBASE.md before adding it here.
  var AUTH_PROVIDERS = ['google', 'password'];

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
         jobSubmissions/{id}          a posted job, before the build commits it to JSON
         feedback/{id}                feedback + screenshots                          */
    col: {
      users: 'users',
      alerts: 'alerts',
      testEmails: 'testEmails',
      profiles: 'profiles',
      registered: 'registeredUsers',
      jobSubmissions: 'jobSubmissions',
      feedback: 'feedback'
    }
  };
})();
