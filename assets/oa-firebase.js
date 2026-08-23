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

  // How long we wait for gstatic before giving up.
  //
  // `onerror` covers a request that is REFUSED. It does not cover one that is
  // accepted and then never answered — a hotel/conference captive portal, a
  // filtering proxy that black-holes the connection, a stalled CDN. Without a
  // timeout the promise simply stays pending, and everything downstream waits
  // on it for ever: oa-accounts never resolves its auth state, so the posting
  // form and the alerts page show NEITHER their form nor their sign-in prompt
  // — a heading, an intro paragraph and nothing else, with no explanation.
  // The reject path is already handled honestly everywhere ("Sign-in
  // unavailable"); this only makes sure it is reached.
  var LOAD_TIMEOUT_MS = 15000;

  var readyPromise = null;

  /** Resolves with the firebase namespace, or rejects when not configured. */
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (!enabled) {
        reject(new Error('firebase-not-configured'));
        return;
      }

      var timer = setTimeout(function () {
        reject(new Error('firebase-sdk-load-failed'));
      }, LOAD_TIMEOUT_MS);

      function fail() {
        clearTimeout(timer);
        reject(new Error('firebase-sdk-load-failed'));
      }

      // All three at once, with `async = false`. A dynamically created script
      // is async by default, which is why this used to be a chain — each part
      // appended only from the previous one's onload, i.e. three SERIAL round
      // trips on every page of the site. Explicitly clearing `async` keeps the
      // app -> auth -> firestore execution order the compat bundles need while
      // letting the browser download them in parallel.
      var left = PARTS.length;
      PARTS.forEach(function (part) {
        var s = document.createElement('script');
        s.src = SDK + part;
        s.async = false;
        s.onload = function () {
          if (--left) return;             // the last one to execute wins
          clearTimeout(timer);
          try {
            if (!window.firebase.apps.length) window.firebase.initializeApp(FB_CONFIG);
            resolve(window.firebase);
          } catch (e) { reject(e); }
        };
        s.onerror = fail;
        document.head.appendChild(s);
      });
    });
    return readyPromise;
  }

  window.OAFB = {
    enabled: enabled,
    config: FB_CONFIG,
    providers: AUTH_PROVIDERS,
    adminEmail: ADMIN_EMAIL,
    ready: ready,

    /* The Storage SDK, loaded ONLY when asked for. The posting form is the one
       page that uploads anything, and the compat bundle is ~40 KB — putting it
       in PARTS would tax every page of the site for one form's feature. */
    readyStorage: function () {
      return ready().then(function (fb) {
        if (fb.storage) return fb;
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = SDK + 'firebase-storage-compat.js';
          s.async = false;
          s.onload = function () { resolve(fb); };
          s.onerror = function () { reject(new Error('firebase-sdk-load-failed')); };
          document.head.appendChild(s);
        });
      });
    },

    /* Collection names, so a rename is a one-line change here and in the rules.
       Mirrors the /lit/ layout:
         users/{uid}                  private per-account subtree (alerts live under it)
         users/{uid}/alerts/{id}      e-mail alert subscriptions
         users/{uid}/testEmails/{id}  one-off "send me a test" requests
         profiles/{uid}               the account's own profile document
         registeredUsers/{uid}        contentless tally — admin-read; the Admin
                                      area's Registered-users count() reads it
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
      candidateSubmissions: 'candidateSubmissions',
      placementSubmissions: 'placementSubmissions',
      feedback: 'feedback'
    }
  };
})();
