/* ---------------------------------------------------------------------------
   Operations Academia — accounts (sign in / register / account menu).

   Modelled on the /lit/ accounts core, reduced to what OA needs. Loads on every
   page that includes it and paints a header control in #oa-account.

   Two invariants carried over from /lit/, both learned the hard way there:

   1. A SIGNED-IN USER IS NEVER SHOWN THE SIGN-IN MODAL AGAIN. Firebase resolves
      the session asynchronously, so between first paint and onAuthStateChanged
      the app does not yet know who you are. We paint from a localStorage hint
      (oaAuthHint) during that window, oaOpenAuth() no-ops while signed in, and
      any action taken mid-restore is QUEUED by whenSignedIn() instead of
      bouncing the user to a sign-in box they do not need.

   2. INERT UNTIL CONFIGURED. With no Firebase project the control renders a
      disabled, explanatory state — never a broken one.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var HINT_KEY = 'oaAuthHint';
  var state = { user: null, resolved: false, profile: null, failed: false };
  var queue = [];
  var listeners = [];

  /* ------------------------------------------------------------------ utils */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readHint() {
    try { return JSON.parse(localStorage.getItem(HINT_KEY) || 'null'); } catch (e) { return null; }
  }

  function writeHint(u) {
    try {
      if (u) {
        localStorage.setItem(HINT_KEY, JSON.stringify({
          uid: u.uid, email: u.email || '', name: u.displayName || ''
        }));
      } else {
        localStorage.removeItem(HINT_KEY);
      }
    } catch (e) { /* private mode — the hint is an optimisation, not a requirement */ }
  }

  function displayName(u) {
    if (!u) return '';
    return u.name || u.displayName || (u.email || '').split('@')[0] || 'Account';
  }

  /* ------------------------------------------------------------------- chrome */

  function paint() {
    var host = $('#oa-account');
    if (!host) return;

    if (!window.OAFB || !OAFB.enabled) {
      host.innerHTML =
        '<span class="oa-acct-off" title="Sign-in is not switched on yet — ' +
        'the site is still being set up.">Sign in</span>';
      return;
    }

    if (state.failed) {
      host.innerHTML =
        '<span class="oa-acct-off" title="We could not reach the sign-in ' +
        'service. Check your connection and reload.">Sign-in unavailable</span>';
      return;
    }

    var u = state.user || (!state.resolved ? readHint() : null);
    if (!u) {
      host.innerHTML = '<button type="button" class="oa-acct-btn" id="oa-signin">Sign in</button>';
      $('#oa-signin').addEventListener('click', openAuth);
      return;
    }

    host.innerHTML =
      '<div class="oa-acct-wrap">' +
        '<button type="button" class="oa-acct-chip" id="oa-chip" aria-haspopup="menu" ' +
          'aria-expanded="false">' + esc(displayName(u)) + '</button>' +
        '<div class="oa-acct-menu" id="oa-menu" role="menu" hidden>' +
          '<div class="oa-acct-as">Signed in as<br><strong>' + esc(u.email || '') + '</strong></div>' +
          '<a role="menuitem" href="/v2/post-a-job.html">Post a job</a>' +
          '<a role="menuitem" href="/v2/alerts.html">E-mail alerts</a>' +
          '<a role="menuitem" href="/v2/feedback.html">Send feedback</a>' +
          '<button role="menuitem" type="button" id="oa-signout">Sign out</button>' +
        '</div>' +
      '</div>';

    var chip = $('#oa-chip'), menu = $('#oa-menu');
    function close() { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); }
    chip.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      chip.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    document.addEventListener('mousedown', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== chip) close();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    var so = $('#oa-signout');
    if (so) so.addEventListener('click', signOut);
  }

  /* -------------------------------------------------------------- auth modal */

  /* Provider buttons, matching the ones on /lit/. The marks are inline SVG
     rather than image files: the pages load no third-party assets, so an icon
     fetched from a CDN would be the only such request on the site — and would
     leave a blank square whenever that CDN is slow or blocked. */
  var PROVIDER = {
    google: {
      label: 'Continue with Google',
      icon: '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
        '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>' +
        '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z"/>' +
        '<path fill="#FBBC05" d="M3.95 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z"/>' +
        '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58z"/>' +
        '</svg>'
    },
    orcid: {
      label: 'Continue with ORCID',
      icon: '<svg viewBox="0 0 256 256" width="18" height="18" aria-hidden="true">' +
        '<circle cx="128" cy="128" r="128" fill="#A6CE39"/>' +
        '<path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 66.9a9.9 9.9 0 1 1 0-19.8 9.9 9.9 0 0 1 0 19.8z"/>' +
        '<path fill="#fff" d="M108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4z"/>' +
        '</svg>'
    }
  };

  function openAuth() {
    if (state.user) return;                      // invariant 1
    if (!window.OAFB || !OAFB.enabled) return;
    if (state.failed) return;                    // the SDK never loaded
    if ($('#oa-auth')) { $('#oa-auth').hidden = false; return; }

    var third = (OAFB.providers || [])
      .filter(function (p) { return p !== 'password' && PROVIDER[p]; })
      .map(function (p) {
        return '<button type="button" class="oa-auth-provider" data-provider="' + p + '">' +
          PROVIDER[p].icon + '<span>' + esc(PROVIDER[p].label) + '</span></button>';
      }).join('');

    var wrap = document.createElement('div');
    wrap.className = 'oa-modal';
    wrap.id = 'oa-auth';
    wrap.innerHTML =
      '<div class="oa-modal-card" role="dialog" aria-modal="true" aria-labelledby="oa-auth-h">' +
        '<button type="button" class="oa-modal-x" aria-label="Close">&times;</button>' +
        '<h3 id="oa-auth-h">Sign in to Operations Academia</h3>' +
        '<p class="oa-modal-lede">An account lets you post a job, subscribe to e-mail ' +
          'alerts, and manage what you have posted. It is free.</p>' +
        (third ? '<div class="oa-auth-providers">' + third + '</div><div class="oa-or">or</div>' : '') +
        '<form id="oa-auth-form">' +
          '<label>E-mail<input type="email" name="email" autocomplete="email" required></label>' +
          '<label>Password<input type="password" name="password" autocomplete="current-password" ' +
            'minlength="6" required></label>' +
          '<div class="oa-auth-actions">' +
            '<button type="submit" class="button blue">Sign in</button>' +
            '<button type="button" class="oa-linkbtn" id="oa-register">Create an account</button>' +
            '<button type="button" class="oa-linkbtn" id="oa-reset">Forgot password</button>' +
          '</div>' +
        '</form>' +
        '<p class="oa-auth-msg" id="oa-auth-msg" role="alert"></p>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { wrap.hidden = true; }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);

    function say(msg, ok) {
      var m = $('#oa-auth-msg');
      m.textContent = msg;
      m.className = 'oa-auth-msg' + (ok ? ' is-ok' : msg ? ' is-err' : '');
    }

    function friendly(err) {
      var c = (err && err.code) || '';
      if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' ||
          c === 'auth/user-not-found') return 'That e-mail and password do not match an account.';
      if (c === 'auth/email-already-in-use') return 'There is already an account with that e-mail — try signing in.';
      if (c === 'auth/weak-password') return 'Please choose a password of at least 6 characters.';
      if (c === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow pop-ups and try again.';
      if (c === 'auth/popup-closed-by-user') return '';
      if (c === 'auth/operation-not-allowed') {
        return 'That sign-in method is not switched on for this site yet. ' +
          'Please use one of the others for now.';
      }
      if (c === 'auth/unauthorized-domain') {
        return 'Sign-in is not allowed from this address. If you are the site ' +
          'owner, add it under Authentication > Settings > Authorized domains.';
      }
      if (c === 'auth/account-exists-with-different-credential') {
        return 'You already have an account with this e-mail, created through a ' +
          'different sign-in method. Use that one, and you can link the two afterwards.';
      }
      if (c === 'auth/network-request-failed') return 'We could not reach the sign-in service. Check your connection.';
      if (/sdk-load-failed|not-configured/.test(err && err.message || '')) {
        return 'We could not load the sign-in service. If you use an ad blocker, ' +
          'allow gstatic.com and reload.';
      }
      return 'Sign-in failed. Please try again.' + (c ? ' (' + c + ')' : '');
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('.oa-auth-provider'), function (b) {
      b.addEventListener('click', function () {
        say('');
        OAFB.ready().then(function (fb) {
          var p;
          if (b.dataset.provider === 'google') p = new fb.auth.GoogleAuthProvider();
          else p = new fb.auth.OAuthProvider('oidc.orcid');
          return fb.auth().signInWithPopup(p);
        }).then(close).catch(function (e) { say(friendly(e)); });
      });
    });

    $('#oa-auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      say('');
      OAFB.ready()
        .then(function (fb) {
          return fb.auth().signInWithEmailAndPassword(f.email.value, f.password.value);
        })
        .then(close)
        .catch(function (err) { say(friendly(err)); });
    });

    $('#oa-register').addEventListener('click', function () {
      var f = $('#oa-auth-form');
      if (!f.email.value || !f.password.value) {
        say('Enter an e-mail and a password of at least 6 characters, then press Create an account.');
        return;
      }
      say('');
      OAFB.ready()
        .then(function (fb) {
          return fb.auth().createUserWithEmailAndPassword(f.email.value, f.password.value);
        })
        .then(close)
        .catch(function (err) { say(friendly(err)); });
    });

    $('#oa-reset').addEventListener('click', function () {
      var f = $('#oa-auth-form');
      if (!f.email.value) { say('Enter your e-mail address first.'); return; }
      OAFB.ready()
        .then(function (fb) { return fb.auth().sendPasswordResetEmail(f.email.value); })
        .then(function () { say('Check your inbox for a password reset link.', true); })
        .catch(function (err) { say(friendly(err)); });
    });
  }

  function signOut() {
    writeHint(null);
    if (!window.OAFB || !OAFB.enabled) return;
    OAFB.ready().then(function (fb) { return fb.auth().signOut(); });
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Run fn once a user is known. Queues while auth is still resolving; opens
      the sign-in modal only if we end up genuinely signed out. */
  function whenSignedIn(fn) {
    if (state.user) { fn(state.user); return; }
    if (!state.resolved) { queue.push(fn); return; }
    openAuth();
  }

  function onChange(fn) {
    listeners.push(fn);
    if (state.resolved) fn(state.user);
  }

  function notify(u) {
    listeners.forEach(function (fn) { try { fn(u); } catch (e) {} });
  }

  function boot() {
    paint();
    if (!window.OAFB || !OAFB.enabled) { state.resolved = true; return; }

    OAFB.ready().then(function (fb) {
      fb.auth().onAuthStateChanged(function (u) {
        state.user = u || null;
        state.resolved = true;
        writeHint(u);
        paint();

        if (u) {
          // Public, contentless tally so the site can show a registered-user
          // count without anyone being able to read the user list. Same shape
          // as /lit/'s registeredUsers/{uid}: a coarse timestamp, nothing else.
          fb.firestore().collection(OAFB.col.registered).doc(u.uid)
            .set({ t: Date.now() }, { merge: true })
            .catch(function () { /* rule not deployed yet — never block sign-in */ });

          var q = queue.splice(0, queue.length);
          q.forEach(function (fn) { try { fn(u); } catch (e) { if (window.console) console.error(e); } });
        } else {
          queue.length = 0;
        }
        notify(u);
      });
    }).catch(function (err) {
      // The SDK itself could not be loaded — offline, a blocked CDN, an ad
      // blocker. Resolving without notifying would leave every page that waits
      // on onChange (the posting form, alerts, feedback) showing NEITHER its
      // form nor its sign-in prompt: a blank card with no explanation. Treat it
      // as "signed out, and say why".
      state.failed = true;
      state.resolved = true;
      queue.length = 0;
      paint();
      notify(null);
      if (window.console) console.error('OA accounts: ' + (err && err.message));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.OAAccounts = {
    openAuth: openAuth,
    signOut: signOut,
    whenSignedIn: whenSignedIn,
    onChange: onChange,
    user: function () { return state.user; },
    resolved: function () { return state.resolved; },
    /** True when the SDK itself could not be loaded — offline, a blocked
        CDN, an ad blocker. Pages use this to say so instead of offering a
        control that cannot work. */
    failed: function () { return state.failed; },
    isAdmin: function () {
      return !!(state.user && window.OAFB &&
        (state.user.email || '').toLowerCase() === String(OAFB.adminEmail).toLowerCase());
    }
  };
})();
