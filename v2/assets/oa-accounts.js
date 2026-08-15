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
  var state = { user: null, resolved: false, profile: null };
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

  var PROVIDER_LABEL = { google: 'Continue with Google', orcid: 'Continue with ORCID' };

  function openAuth() {
    if (state.user) return;                      // invariant 1
    if (!window.OAFB || !OAFB.enabled) return;
    if ($('#oa-auth')) { $('#oa-auth').hidden = false; return; }

    var third = (OAFB.providers || [])
      .filter(function (p) { return p !== 'password'; })
      .map(function (p) {
        return '<button type="button" class="oa-auth-provider" data-provider="' + p + '">' +
          esc(PROVIDER_LABEL[p] || p) + '</button>';
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
      if (c === 'auth/network-request-failed') return 'We could not reach the sign-in service. Check your connection.';
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
        listeners.forEach(function (fn) { try { fn(u); } catch (e) {} });
      });
    }).catch(function () { state.resolved = true; paint(); });
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
    isAdmin: function () {
      return !!(state.user && window.OAFB &&
        (state.user.email || '').toLowerCase() === String(OAFB.adminEmail).toLowerCase());
    }
  };
})();
