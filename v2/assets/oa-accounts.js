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

  /** `name` overrides what we store for the next page load. Firebase gives a
      password account no displayName, so the name we display comes from the
      Firestore profile — pass it in once that read has landed, or the hint
      would only ever carry an empty string. */
  function writeHint(u, name) {
    try {
      if (u) {
        if (name === undefined) {
          // Called before the profile read has landed. Keep whatever name the
          // previous visit resolved for this same account rather than blanking
          // it — otherwise the hint can never carry a name at all.
          var prev = readHint();
          name = (prev && prev.uid === u.uid && prev.name) || '';
        }
        localStorage.setItem(HINT_KEY, JSON.stringify({
          uid: u.uid, email: u.email || '', name: name || u.displayName || ''
        }));
      } else {
        localStorage.removeItem(HINT_KEY);
      }
    } catch (e) { /* private mode — the hint is an optimisation, not a requirement */ }
  }

  function displayName(u) {
    if (!u) return '';
    var p = state.profile;
    var full = p && [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    // Auth has resolved but the profile read has not. A password account
    // carries no displayName, so without the hint the chip would drop from
    // "Jane Doe" to "jane.doe" for the length of one Firestore round trip, on
    // every single page load.
    var h = !p && readHint();
    var hinted = (h && h.uid === u.uid && h.name) || '';
    return u.name || u.displayName || hinted || (u.email || '').split('@')[0] || 'Account';
  }

  /** Two letters for the avatar: the initials of the name we show, falling
      back to the first letter of the e-mail. Never empty — a blank disc reads
      as a broken image. */
  function initials(u) {
    var parts = displayName(u).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
    var s = parts.length > 1
      ? parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
      : (parts[0] || (u && u.email) || '?').slice(0, 2);
    return s.toUpperCase();
  }

  /** A stable colour per account, so the disc is recognisably "yours" and does
      not change between pages or sessions. Hue from a hash of the uid; the
      saturation and lightness are fixed, so every avatar has the same weight
      and the white initials always clear 4.5:1. */
  function avatarHue(u) {
    var s = String((u && (u.uid || u.email)) || ''), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  /* ------------------------------------------------------------------- chrome */

  var ICON = {
    post: '&#128221;',
    alerts: '&#9993;',
    profile: '&#128100;',
    feedback: '&#128172;'
  };

  function paint() {
    // The off-canvas copy first: it must follow every state change even on a
    // page without #oa-account, and even down the early-return branches below.
    paintPanel();

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

    var hue = avatarHue(u);
    host.innerHTML =
      '<div class="oa-acct-wrap">' +
        '<button type="button" class="oa-acct-chip" id="oa-chip" aria-haspopup="menu" ' +
          'aria-expanded="false" title="Your account">' +
          '<span class="oa-avatar" aria-hidden="true" style="--oa-hue:' + hue + '">' +
            esc(initials(u)) + '</span>' +
          '<span class="oa-acct-name">' + esc(displayName(u)) + '</span>' +
          '<span class="oa-caret" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="oa-acct-menu" id="oa-menu" role="menu" hidden>' +
          '<div class="oa-acct-as">' +
            '<span class="oa-avatar oa-avatar-lg" aria-hidden="true" style="--oa-hue:' + hue + '">' +
              esc(initials(u)) + '</span>' +
            '<span class="oa-acct-who">' +
              '<strong>' + esc(displayName(u)) + '</strong>' +
              '<span class="oa-acct-mail">' + esc(u.email || '') + '</span>' +
            '</span>' +
          '</div>' +
          // Relative, like oa-nav.js and every page in /v2/. These were the
          // only absolute internal links on the site, and at cutover the
          // pages move up one directory — /v2/… would then be three dead
          // links in every signed-in reader's menu.
          '<div class="oa-acct-group">' +
            '<a role="menuitem" href="post-a-job.html">' +
              '<span class="oa-mi" aria-hidden="true">' + ICON.post + '</span>Post a job</a>' +
            '<a role="menuitem" href="alerts.html">' +
              '<span class="oa-mi" aria-hidden="true">' + ICON.alerts + '</span>E-mail alerts</a>' +
            '<button role="menuitem" type="button" id="oa-editprofile">' +
              '<span class="oa-mi" aria-hidden="true">' + ICON.profile + '</span>Edit profile</button>' +
            '<a role="menuitem" href="feedback.html">' +
              '<span class="oa-mi" aria-hidden="true">' + ICON.feedback + '</span>Send feedback</a>' +
          '</div>' +
          '<button class="oa-acct-out" role="menuitem" type="button" id="oa-signout">Sign out</button>' +
        '</div>' +
      '</div>';

    var chip = $('#oa-chip'), menu = $('#oa-menu');
    function close() { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); }
    chip.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      chip.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    document.addEventListener('mousedown', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !chip.contains(e.target)) close();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    var so = $('#oa-signout');
    if (so) so.addEventListener('click', signOut);
    var ep = $('#oa-editprofile');
    // Through the queue, like every other mid-restore action (invariant 1).
    // This chip is painted from the localStorage hint BEFORE Firebase has
    // restored the session, so state.user is still null while the menu is on
    // screen — calling openProfile() directly showed a signed-in reader the
    // "Sign in to Operations Academia" box and threw their click away.
    if (ep) ep.addEventListener('click', function () { close(); whenSignedIn(function () { openProfile(); }); });
  }

  /* The same control, in the off-canvas panel. main.css hides #header-wrapper
     outright at ≤840px and main.js rebuilds the menu as #navPanel from #nav
     ALONE, so on a phone #oa-headnav — and with it the site's only sign-out —
     does not exist. CSS cannot rescue a subtree that is display:none from an
     ancestor, so the account control is painted a second time, into the
     panel. `link depth-0` are main.css's own panel classes; the identity line
     (.oa-np-as) is styled in oa-ui.css. main.js builds the panel at
     DOM-ready, which is AFTER this script's first paint — hence the one
     deferred retry. The panel's hideOnClick closes it after a tap for us. */
  function paintPanel() {
    var nav = document.querySelector('#navPanel nav');
    if (!nav) {
      // Bounded: a page where main.js never built the panel (script blocked)
      // must not poll for ever. Twenty ticks is five seconds — DOM-ready is
      // orders of magnitude sooner.
      paintPanel.tries = (paintPanel.tries || 0) + 1;
      if (!paintPanel.armed && paintPanel.tries <= 20) {
        paintPanel.armed = true;
        setTimeout(function () { paintPanel.armed = false; paintPanel(); }, 250);
      }
      return;
    }
    paintPanel.tries = 0;

    var box = document.getElementById('oa-np');
    if (!box) {
      box = document.createElement('div');
      box.id = 'oa-np';
      nav.appendChild(box);
    }

    // Not configured, or unreachable: no entry at all. A dead "Sign in" link
    // in the panel would be the same silent no-op the header just fixed.
    if (!window.OAFB || !OAFB.enabled || state.failed) { box.innerHTML = ''; return; }

    var u = state.user || (!state.resolved ? readHint() : null);
    if (!u) {
      box.innerHTML = '<a class="link depth-0" id="oa-np-signin" href="#">Sign in</a>';
      $('#oa-np-signin').addEventListener('click', function (e) {
        e.preventDefault();
        openAuth();
      });
      return;
    }

    box.innerHTML =
      '<span class="oa-np-as"><strong>' + esc(displayName(u)) + '</strong>' +
        esc(u.email || '') + '</span>' +
      '<a class="link depth-0" id="oa-np-profile" href="#">Edit profile</a>' +
      '<a class="link depth-0" id="oa-np-signout" href="#">Sign out</a>';
    $('#oa-np-profile').addEventListener('click', function (e) {
      e.preventDefault();
      whenSignedIn(function () { openProfile(); });
    });
    $('#oa-np-signout').addEventListener('click', function (e) {
      e.preventDefault();
      signOut();
    });
  }

  /* --------------------------------------------------------------- modals */

  /** Escape closes an open dialog. Both cards claim role="dialog"
      aria-modal="true", and a box a keyboard user cannot leave is not a modal
      — it is a trap. The only Escape handler in the file used to be the
      account menu's, registered only when the signed-in chip is painted, so a
      signed-out visitor's sign-in box had no key handler at all. */
  function wireModalKeys(wrap, close) {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!wrap.parentNode || wrap.hidden) return;      // already closed
      close();
    });
  }

  /** A plain, honest box for when there is nothing to sign in WITH: the SDK
      never loaded, or the project is not configured yet. The gates on
      post-a-job and alerts put a prominent "Sign in" button in front of the
      reader; pressing it and having literally nothing happen — no modal, no
      message — is the one failure mode this site is not allowed to have. */
  function openNotice(text) {
    var old = $('#oa-notice');
    if (old) old.parentNode.removeChild(old);

    var wrap = document.createElement('div');
    wrap.className = 'oa-modal';
    wrap.id = 'oa-notice';
    wrap.innerHTML =
      '<div class="oa-modal-card" role="dialog" aria-modal="true" aria-labelledby="oa-notice-h">' +
        '<button type="button" class="oa-modal-x" aria-label="Close">&times;</button>' +
        '<h3 id="oa-notice-h">Sign-in is unavailable</h3>' +
        '<p class="oa-modal-lede">' + text + '</p>' +
        '<div class="oa-auth-actions">' +
          '<button type="button" class="button blue" id="oa-notice-ok">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);
    $('#oa-notice-ok', wrap).addEventListener('click', close);
    wireModalKeys(wrap, close);
    $('#oa-notice-ok', wrap).focus();
  }

  /* ------------------------------------------------------------ profile card

     The name on the chip comes from here. Firebase gives us an e-mail and
     nothing else for a password account, so without this the header would
     greet everyone by the left-hand half of their address. Stored at
     profiles/{uid}, which the deployed rules already make owner-only — no
     rules change is needed to switch this on. */

  var PROFILE_FIELDS = ['firstName', 'lastName', 'affiliation', 'website'];

  function profileDoc(fb, uid) {
    return fb.firestore().collection(OAFB.col.profiles).doc(uid);
  }

  function loadProfile(u) {
    state.profile = null;                // never carry the previous account's
    if (!u) return;
    var uid = u.uid;

    /** The account can change while the read is in flight — sign out, then
        sign in as someone else. Without this the older read wins and pins the
        previous person's name above the current person's e-mail, for the rest
        of the page's life. */
    function stillOurs() { return !!(state.user && state.user.uid === uid); }

    OAFB.ready()
      .then(function (fb) { return profileDoc(fb, uid).get(); })
      .then(function (snap) {
        if (!stillOurs()) return;
        state.profile = (snap && snap.exists ? snap.data() : null) || null;
        paint();
        // Write the name we actually SHOW back into the hint. Firebase leaves
        // displayName null for a password account, so without this the chip
        // changed identity on every page load — "jane.doe", then "Jane Doe"
        // once the profile read landed. On a flat static site that is every
        // navigation.
        writeHint(state.user, displayName(state.user));
        // A first-run account has no name yet. Ask once, and never again —
        // being nagged on every visit is what makes a profile prompt hated.
        // Keyed on the uid: a browser-wide flag meant the SECOND account on a
        // shared or lab machine was never asked at all, and stayed known by
        // the left-hand half of its e-mail address for ever.
        try {
          if (!state.profile && !localStorage.getItem('oaProfileAsked:' + uid)) {
            localStorage.setItem('oaProfileAsked:' + uid, '1');
            openProfile(true);
          }
        } catch (e) { /* private mode */ }
      })
      .catch(function () { /* rules not deployed yet — the chip still works */ });
  }

  function openProfile(firstRun) {
    var u = state.user;
    if (!u) {
      // Belt and braces for invariant 1: mid-restore we do not yet know who
      // this is, so queue rather than bounce a signed-in reader to a sign-in
      // box. Only once auth has genuinely resolved to "signed out" is the
      // modal the right answer.
      if (!state.resolved) { whenSignedIn(function () { openProfile(firstRun); }); return; }
      openAuth();
      return;
    }
    var old = $('#oa-profile');
    if (old) old.parentNode.removeChild(old);

    var p = state.profile || {};
    var wrap = document.createElement('div');
    wrap.className = 'oa-modal';
    wrap.id = 'oa-profile';
    wrap.innerHTML =
      '<div class="oa-modal-card oa-profile-card" role="dialog" aria-modal="true" ' +
        'aria-labelledby="oa-profile-h">' +
        '<button type="button" class="oa-modal-x" aria-label="Close">&times;</button>' +
        '<div class="oa-profile-head">' +
          '<span class="oa-avatar oa-avatar-xl" aria-hidden="true" style="--oa-hue:' +
            avatarHue(u) + '">' + esc(initials(u)) + '</span>' +
          '<div>' +
            '<h3 id="oa-profile-h">' + (firstRun ? 'Welcome' : 'My profile') + '</h3>' +
            '<p class="oa-modal-lede">Your name is how you appear in the header and on ' +
              'anything you post. Your affiliation is never published.</p>' +
          '</div>' +
        '</div>' +
        '<form id="oa-profile-form">' +
          '<div class="oa-prow">' +
            '<label>First name<input name="firstName" maxlength="80" autocomplete="given-name" ' +
              'value="' + esc(p.firstName || '') + '"></label>' +
            '<label>Last name<input name="lastName" maxlength="80" autocomplete="family-name" ' +
              'value="' + esc(p.lastName || '') + '"></label>' +
          '</div>' +
          '<label>Affiliation <span class="oa-opt">(optional)</span>' +
            '<input name="affiliation" maxlength="160" placeholder="University or company" ' +
              'autocomplete="organization" value="' + esc(p.affiliation || '') + '"></label>' +
          '<label>Website <span class="oa-opt">(optional)</span>' +
            '<input name="website" maxlength="300" placeholder="https://…" type="url" ' +
              'value="' + esc(p.website || '') + '"></label>' +
          '<label>E-mail' +
            '<input value="' + esc(u.email || '') + '" disabled>' +
            '<span class="oa-opt oa-fine">This is the address you sign in with.</span></label>' +
          '<div class="oa-auth-actions">' +
            '<button type="submit" class="button blue">Save profile</button>' +
            (firstRun ? '<button type="button" class="oa-linkbtn" id="oa-profile-later">Not now</button>' : '') +
          '</div>' +
        '</form>' +
        '<p class="oa-auth-msg" id="oa-profile-msg" role="alert"></p>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { wrap.hidden = true; }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);
    wireModalKeys(wrap, close);
    var later = $('#oa-profile-later', wrap);
    if (later) later.addEventListener('click', close);
    var first = $('#oa-profile-form input', wrap);
    if (first) first.focus();

    $('#oa-profile-form', wrap).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, out = {};
      PROFILE_FIELDS.forEach(function (k) { out[k] = String(f[k].value || '').trim().slice(0, 300); });
      var msg = $('#oa-profile-msg', wrap);
      // The card's own lede says the profile is how you appear "on anything
      // you post", i.e. this field exists to be rendered as a link one day.
      // type="url" happily accepts `javascript:alert(1)` as a valid absolute
      // URL, so refuse anything we would not be willing to put in an href
      // rather than storing a stored-XSS seed for the first renderer.
      if (out.website && !/^https?:\/\//i.test(out.website)) {
        msg.className = 'oa-auth-msg is-err';
        msg.textContent = 'Please give a website address starting with http:// or https://.';
        return;
      }
      msg.className = 'oa-auth-msg';
      msg.textContent = 'Saving…';
      OAFB.ready()
        .then(function (fb) { return profileDoc(fb, state.user.uid).set(out, { merge: true }); })
        .then(function () {
          state.profile = out;
          paint();
          writeHint(state.user, displayName(state.user));   // the next page starts with the new name
          close();
        })
        .catch(function () {
          msg.className = 'oa-auth-msg is-err';
          msg.textContent = 'We could not save your profile just now. Please try again.';
        });
    });
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

  /** mode: 'register' opens the same box worded for someone who has no
      account yet. Both buttons stay on either wording — someone who came to
      register and turns out to have an account must not have to close the box
      and find another button. */
  function openAuth(mode) {
    if (state.user) return;                      // invariant 1
    if (!window.OAFB || !OAFB.enabled) {
      openNotice('Sign-in is not switched on for this site yet. ' +
        'Everything else on the page works as usual.');
      return;
    }
    if (state.failed) {
      // The SDK never loaded. Say so — a prominent button that does nothing
      // at all when pressed is worse than the sentence explaining why.
      openNotice('We could not load the sign-in service. If you use an ad ' +
        'blocker, allow <code>gstatic.com</code> and reload the page. ' +
        'Otherwise check your connection and try again.');
      return;
    }
    var registering = mode === 'register';

    // Rebuilt on every open, like the profile card. Reusing the node carried
    // the FIRST open's heading for the rest of the page's life ("Create an
    // account" then "Sign in" still read "Create your … account"), left the
    // previous attempt's red error on screen attached to nothing, and — on a
    // shared or lab machine — handed the previous person's e-mail and typed
    // password to whoever opened the box next.
    var old = $('#oa-auth');
    if (old) old.parentNode.removeChild(old);

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
        '<h3 id="oa-auth-h">' + (registering
          ? 'Create your Operations Academia account'
          : 'Sign in to Operations Academia') + '</h3>' +
        '<p class="oa-modal-lede">An account lets you post a job, subscribe to e-mail ' +
          'alerts, and manage what you have posted. It is free, and takes a moment.</p>' +
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

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);
    wireModalKeys(wrap, close);
    $('#oa-auth-form', wrap).email.focus();

    function say(msg, ok) {
      // Scoped to THIS card, and null-safe: close() removes the node now, and
      // a slow rejection can land after the reader has closed the box.
      var m = $('#oa-auth-msg', wrap);
      if (!m) return;
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
    // Repaint AT ONCE, before awaiting the SDK. The chip is painted from the
    // hint and is therefore clickable long before Firebase has landed, and
    // deferring everything to ready() left the name, e-mail and avatar sitting
    // there with no sign that anything had happened. Telling the listeners too,
    // so the posting form and the alerts page fall back to their gate rather
    // than staying open for an account that is on its way out.
    state.user = null;
    state.profile = null;
    queue.length = 0;
    paint();
    notify(null);
    if (!window.OAFB || !OAFB.enabled) return;
    OAFB.ready()
      .then(function (fb) { return fb.auth().signOut(); })
      .catch(function () {
        // ready() rejects when gstatic is unreachable, and that rejection can
        // arrive AFTER the hint-painted chip has been clicked. Unhandled it is
        // an uncaught error in the page. The hint is already gone, so the
        // honest end state is the one the header shows for a dead SDK.
        state.failed = true;
        paint();
      });
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
        if (!u) state.profile = null;
        writeHint(u);
        paint();

        if (u) {
          loadProfile(u);
          // Public, contentless tally so the site can show a registered-user
          // count without anyone being able to read the user list. Same shape
          // as /lit/'s registeredUsers/{uid}: a coarse timestamp, nothing else.
          //
          // ONCE PER SESSION, as /lit/ does it — not once per page view. This
          // is a flat multi-page site: a signed-in reader opening ten pages
          // would otherwise cost ten writes, all of them overwriting the same
          // coarse timestamp, against a 20k/day free-tier ceiling.
          var tally = 'oaTally:' + u.uid, done = false;
          try { done = !!sessionStorage.getItem(tally); } catch (e) { /* private mode */ }
          if (!done) {
            try { sessionStorage.setItem(tally, '1'); } catch (e) { /* private mode */ }
            fb.firestore().collection(OAFB.col.registered).doc(u.uid)
              .set({ t: Date.now() }, { merge: true })
              .catch(function () { /* rule not deployed yet — never block sign-in */ });
          }

          var q = queue.splice(0, queue.length);
          q.forEach(function (fn) { try { fn(u); } catch (e) { if (window.console) console.error(e); } });
        } else {
          // Anything queued during the restore window belongs to someone who
          // turns out NOT to be signed in. Dropping it silently loses the
          // click; whenSignedIn's own contract is to offer the sign-in box.
          var pending = queue.splice(0, queue.length);
          if (pending.length) openAuth();
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
    openProfile: openProfile,
    profile: function () { return state.profile; },
    displayName: function () { return displayName(state.user); },
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
