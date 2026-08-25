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

   It also carries the DUPLICATE-ACCOUNT MERGE (see the long comment above
   openMerge). Sign-in offers Google, ORCID and e-mail/password, and those are
   three different identities as far as Firebase is concerned: the same person
   registering with Google in October and with ORCID in November ends up with
   two accounts, each holding half of their alerts and postings. So do two
   different Gmail addresses. The repair is user-initiated and provable, and
   the prevention is provider linking.
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
  function initialsFrom(label, fallback) {
    var parts = String(label || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
    var s = parts.length > 1
      ? parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
      : (parts[0] || fallback || '?').slice(0, 2);
    return s.toUpperCase();
  }

  function initials(u) { return initialsFrom(displayName(u), u && u.email); }

  /** Initials for SOMEONE ELSE'S account — the one being merged into. It must
      not go through displayName(), which reads the signed-in account's own
      profile and would label the other account with this one's name. */
  function otherInitials(user) {
    user = user || {};
    return initialsFrom(user.displayName || (user.email || '').split('@')[0], user.email);
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

  /* ------------------------------------------------------ identity helpers

     An OA account can be reached by three different sign-in methods, and the
     merge and the duplicate detection both need to reason about WHICH ones a
     given account carries. `providerData` is the only honest source for that —
     the profile document is user-editable and the auth e-mail is absent on an
     ORCID sign-in. */

  var PROVIDER_LABEL = {
    'google.com': 'Google',
    'oidc.orcid': 'ORCID',
    'password': 'e-mail and password'
  };

  function providerIds(u) {
    var pd = ((u || state.user || {}).providerData) || [];
    var out = [];
    for (var i = 0; i < pd.length; i++) if (pd[i] && pd[i].providerId) out.push(pd[i].providerId);
    return out;
  }

  function hasProvider(id, u) { return providerIds(u).indexOf(id) !== -1; }

  /** How the account is described to its owner: "Google", "ORCID", "Google
      and e-mail and password". Never a raw provider id. */
  function providerSummary(u) {
    var names = providerIds(u).map(function (p) { return PROVIDER_LABEL[p] || p; });
    if (!names.length) return 'this browser';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /** True when ORCID is the ONLY way into this account — the shape a duplicate
      registration takes, because ORCID's OIDC shares no e-mail address for
      Firebase to match an existing account on. */
  function isOrcidOnly(u) {
    var ids = providerIds(u);
    return ids.length === 1 && ids[0] === 'oidc.orcid';
  }

  /** The ORCID iD Firebase itself vouches for: the OIDC `sub`, which ORCID
      sets to the iD, surfaces as the provider record's uid. */
  function orcidFromProvider(u) {
    var pd = ((u || state.user || {}).providerData) || [];
    for (var i = 0; i < pd.length; i++) {
      if (pd[i] && pd[i].providerId === 'oidc.orcid') return normOrcid(pd[i].uid);
    }
    return '';
  }

  /**
   * Canonical ORCID iD, or '' when the input is not one.
   *
   * The last character is an ISO 7064 MOD 11-2 check digit, so a typo is
   * caught here rather than becoming an identity key that silently matches
   * nobody — which is the failure mode that matters: a mistyped iD would make
   * the duplicate detection quietly stop working for that account.
   */
  function normOrcid(v) {
    var s = String(v == null ? '' : v).toUpperCase().replace(/[^0-9X]/g, '');
    if (s.length !== 16) return '';
    var total = 0;
    for (var i = 0; i < 15; i++) {
      var d = s.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return '';
      total = (total + d) * 2;
    }
    var check = (12 - (total % 11)) % 11;
    if (s.charAt(15) !== (check === 10 ? 'X' : String(check))) return '';
    return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
  }

  /** Hex SHA-256, for the e-mail identity key. The key is HASHED so the
      accountKeys collection — which every signed-in user may read a single
      document of — never becomes a list of the site's e-mail addresses. */
  function sha256Hex(s) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) {
      return Promise.reject(new Error('no-subtle-crypto'));
    }
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  function emailKey(addr) {
    var e = String(addr || '').trim().toLowerCase();
    if (!e) return Promise.resolve('');
    return sha256Hex(e).then(function (h) { return 'email:' + h; });
  }

  /* ------------------------------------------------------------------- chrome */

  var ICON = {
    post: '&#128221;',
    mine: '&#128203;',
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
            '<a role="menuitem" href="my-postings.html">' +
              '<span class="oa-mi" aria-hidden="true">' + ICON.mine + '</span>My postings</a>' +
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
      '<a class="link depth-0" href="my-postings.html">My postings</a>' +
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
        return seedOrcidFromProvider();
      })
      .then(function () { claimAccountKeys(); })
      .catch(function () { /* rules not deployed yet — the chip still works */ });
  }

  /* Someone who registered WITH ORCID has already proved the iD to orcid.org,
     so record it without asking — it is what makes the duplicate detection
     below able to see that this sign-in and their older Google account are the
     same person. Written exactly once (`orcidSeeded`), so clearing the field
     later is respected rather than undone on the next page load. */
  function seedOrcidFromProvider() {
    var p = state.profile || {};
    var iD = orcidFromProvider();
    if (!iD || p.orcid || p.orcidSeeded) return Promise.resolve();
    var patch = { orcid: iD, orcidVerified: true, orcidSeeded: true };
    return OAFB.ready()
      .then(function (fb) { return profileDoc(fb, state.user.uid).set(patch, { merge: true }); })
      .then(function () {
        state.profile = Object.assign({}, state.profile || {}, patch);
        paint();
      })
      .catch(function () { /* best effort — never block sign-in on it */ });
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
            '<span class="oa-opt oa-fine">' + (u.email
              ? 'This is the address you sign in with.'
              : 'You sign in with ' + esc(providerSummary(u)) +
                ', which does not share an e-mail address with us.') +
            '</span></label>' +
          orcidFieldHTML(p) +
          '<div class="oa-auth-actions">' +
            '<button type="submit" class="button blue">Save profile</button>' +
            (firstRun ? '<button type="button" class="oa-linkbtn" id="oa-profile-later">Not now</button>' : '') +
          '</div>' +
        '</form>' +
        (firstRun ? '' : otherAccountsHTML(p, u)) +
        '<p class="oa-auth-msg" id="oa-profile-msg" role="alert"></p>' +
      '</div>';
    document.body.appendChild(wrap);

    function close() { wrap.hidden = true; }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);
    wireModalKeys(wrap, close);
    var later = $('#oa-profile-later', wrap);
    if (later) later.addEventListener('click', close);
    wireOtherAccounts(wrap, close);
    var first = $('#oa-profile-form input', wrap);
    if (first) first.focus();

    $('#oa-profile-form', wrap).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, out = {};
      var msg = $('#oa-profile-msg', wrap);
      PROFILE_FIELDS.forEach(function (k) { out[k] = String(f[k].value || '').trim().slice(0, 300); });

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

      // The iD is only editable while it is UNVERIFIED — one we were handed by
      // an ORCID sign-in is shown as a chip and left alone.
      var orcidInput = f.orcid;
      if (orcidInput) {
        var typed = String(orcidInput.value || '').trim();
        if (typed) {
          var iD = normOrcid(typed);
          if (!iD) {
            msg.className = 'oa-auth-msg is-err';
            msg.textContent = 'That does not look like an ORCID iD. It has 16 digits, ' +
              'like 0000-0002-1825-0097 — copy it from your ORCID record.';
            orcidInput.focus();
            return;
          }
          out.orcid = iD;
        } else {
          out.orcid = '';
        }
      }

      msg.className = 'oa-auth-msg';
      msg.textContent = 'Saving…';
      OAFB.ready()
        .then(function (fb) { return profileDoc(fb, state.user.uid).set(out, { merge: true }); })
        .then(function () {
          state.profile = Object.assign({}, state.profile || {}, out);
          paint();
          writeHint(state.user, displayName(state.user));   // the next page starts with the new name
          accountKeysChecked = false;      // a new iD is a new identity to claim
          claimAccountKeys();
          close();
        })
        .catch(function () {
          msg.className = 'oa-auth-msg is-err';
          msg.textContent = 'We could not save your profile just now. Please try again.';
        });
    });
  }

  /* ORCID iD: a chip when an ORCID sign-in vouched for it, an input otherwise.
     It is optional, and the note says what recording it buys — an account is
     otherwise invisible to the duplicate check until the day it is merged. */
  function orcidFieldHTML(p) {
    if (p.orcid && p.orcidVerified) {
      return '<div class="oa-field-static">' +
        '<span class="oa-flabel">ORCID iD</span>' +
        '<span class="oa-orcid-chip">' + esc(p.orcid) + '</span>' +
        '<span class="oa-verified">&#10003; verified</span>' +
        '<span class="oa-opt oa-fine">You signed in with ORCID, so we know this iD is yours.</span>' +
        '</div>';
    }
    return '<label>ORCID iD <span class="oa-opt">(optional)</span>' +
      '<input name="orcid" maxlength="40" placeholder="0000-0002-1825-0097" ' +
        'value="' + esc(p.orcid || '') + '">' +
      '<span class="oa-opt oa-fine">Recording it lets us recognise you if you ever sign in ' +
        'with ORCID instead, rather than starting you a second account.</span></label>';
  }

  /* The account's OTHER ways in, and the way out of having two of them. */
  function otherAccountsHTML(p, u) {
    var rows = '';

    if (!hasProvider('oidc.orcid', u) && p.orcid) {
      rows += '<p class="oa-acct-linkrow">' +
        '<button type="button" class="oa-linkbtn" id="oa-link-orcid">' +
          'Enable &ldquo;Continue with ORCID&rdquo; for this account</button>' +
        '<span class="oa-opt oa-fine">Then the ORCID button on the sign-in screen brings you ' +
          'straight here, instead of starting a second account.</span></p>';
    }
    if (!hasProvider('google.com', u)) {
      rows += '<p class="oa-acct-linkrow">' +
        '<button type="button" class="oa-linkbtn" id="oa-link-google">' +
          'Enable &ldquo;Continue with Google&rdquo; for this account</button>' +
        '<span class="oa-opt oa-fine">Sign in with Google and land here, rather than in a ' +
          'new account.</span></p>';
    }

    return '<div class="oa-acct-other">' +
      '<h4>Your other accounts</h4>' +
      '<p class="oa-opt oa-fine oa-acct-signedin">You sign in to this account with ' +
        esc(providerSummary(u)) + '.</p>' +
      rows +
      '<p class="oa-acct-mergelede">Signed up more than once — with Google and again with ' +
        'ORCID, or with two different e-mail addresses? They are separate accounts, each ' +
        'holding its own alerts and postings — jobs, candidate profile, placements. ' +
        'Merging moves everything on ' +
        '<strong>this</strong> account into the one you keep, and removes this one.</p>' +
      '<button type="button" class="oa-mergebtn" id="oa-merge-open">' +
        '&#128260; Merge this account into another of mine&hellip;</button>' +
      '</div>';
  }

  function wireOtherAccounts(wrap, closeProfile) {
    var open = $('#oa-merge-open', wrap);
    if (open) open.addEventListener('click', function () { closeProfile(); openMerge(); });

    var lo = $('#oa-link-orcid', wrap);
    if (lo) lo.addEventListener('click', function () { linkProvider('oidc.orcid', wrap); });
    var lg = $('#oa-link-google', wrap);
    if (lg) lg.addEventListener('click', function () { linkProvider('google.com', wrap); });
  }

  /* Attach a second sign-in method to THIS account. This is the PREVENTION half
     of the duplicate problem: an account reachable by both buttons can never
     have a second one created for it. */
  function linkProvider(id, wrap) {
    var msg = $('#oa-profile-msg', wrap);
    msg.className = 'oa-auth-msg';
    msg.textContent = 'Opening the sign-in window…';
    OAFB.ready().then(function (fb) {
      var p = id === 'google.com' ? new fb.auth.GoogleAuthProvider()
                                  : new fb.auth.OAuthProvider(id);
      return state.user.linkWithPopup(p);
    }).then(function () {
      msg.className = 'oa-auth-msg is-ok';
      msg.textContent = 'Done — that button now signs in to this account.';
      // providerData changed, so the rows above it are stale.
      setTimeout(function () { openProfile(); }, 900);
    }).catch(function (err) {
      var c = (err && err.code) || '';
      if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') {
        msg.textContent = '';
        return;
      }
      msg.className = 'oa-auth-msg is-err';
      if (c === 'auth/credential-already-in-use' || c === 'auth/account-exists-with-different-credential') {
        msg.textContent = 'That sign-in already belongs to another Operations Academia ' +
          'account. Sign in to it and merge it into this one instead.';
      } else if (c === 'auth/provider-already-linked') {
        msg.textContent = 'That sign-in is already attached to this account.';
      } else if (c === 'auth/operation-not-allowed') {
        msg.textContent = 'That sign-in method is not switched on for this site yet.';
      } else {
        msg.textContent = 'We could not attach that sign-in.' + (c ? ' (' + c + ')' : '');
      }
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

  /** A sign-in error in the reader's own words. Module-scope because the merge
      dialog runs the very same sign-in calls and must not report them
      differently from the sign-in modal. */
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

  /** `skip` drops providers that cannot lead anywhere new. It is used by the
      merge dialog: one ORCID iD always resolves to the same Firebase account,
      so offering ORCID to an ORCID account can only ever come back with "that
      is the account you are already in". Google is never dropped — a second
      Gmail address is a genuinely different account, and the commonest
      duplicate of all. */
  function providerButtonsHTML(skip) {
    skip = skip || [];
    return (OAFB.providers || [])
      .filter(function (p) { return p !== 'password' && PROVIDER[p] && skip.indexOf(p) === -1; })
      .map(function (p) {
        return '<button type="button" class="oa-auth-provider" data-provider="' + p + '">' +
          PROVIDER[p].icon + '<span>' + esc(PROVIDER[p].label) + '</span></button>';
      }).join('');
  }

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

    var third = providerButtonsHTML();

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

  /* =========================================================================
     DUPLICATE ACCOUNTS

     Firebase treats every sign-in method as its own identity. ORCID's OIDC
     shares no e-mail address, so a researcher who registered with Google in
     October and pressed "Continue with ORCID" in November now has TWO
     Operations Academia accounts; two different Gmail addresses do the same
     thing. Each holds its own alerts and its own job postings, and neither can
     see the other's.

     Three layers, in the order they should be reached for:

       PREVENTION  linkProvider() attaches a second sign-in method to the
                   account you already have, so the other button can never
                   create a duplicate for you again.
       DETECTION   claimAccountKeys() below. Every session claims its identity
                   keys — orcid:<iD> and email:<sha256> — in `accountKeys`.
                   A key already held by a DIFFERENT uid is the same person
                   twice, and we say so.
       REPAIR      openMerge(): everything on the account you are signed in to
                   moves into the account you keep, and this one is removed.

     WHY THE MERGE SIGNS IN TO BOTH AT ONCE. /lit/ does this with a hand-over
     through localStorage: it exports, deletes the duplicate sign-in, and
     imports on the next sign-in. That works there because everything a Lit
     account owns lives under users/{uid}/**, which the account itself can read
     and re-create. Here it cannot: a POSTING — a job, a candidate profile, a
     placement report — is a top-level document (jobSubmissions /
     candidateSubmissions / placementSubmissions) owned by a `uid` field, the
     rules pin that field, and once the duplicate sign-in is gone nobody can
     touch it ever again — the posting would be stranded, unwithdrawable,
     uncorrectable. So the merge
     proves BOTH accounts in one sitting: the account you keep signs in on a
     SECOND Firebase app (its own auth instance, so the session you are already
     in is untouched), and while both are live the postings are handed over
     from the one that owns them to the one that will.

     ORDER MATTERS AND IS DELIBERATE: everything is copied into the account you
     keep FIRST, the postings are handed over next, and only then is anything
     deleted. A failure at any point leaves the duplicate intact and the merge
     safe to run again — copying an alert whose id is already there is a no-op,
     and so is a profile patch that only fills blanks.
     ========================================================================= */

  var MERGE_APP = 'oa-merge';

  /* The fields of an alert that are the SUBSCRIPTION. The mailer's high-water
     marks (lastSentAt / lastCheckedAt / lastUpdateDate) travel with it on
     purpose: an alert that arrives without them looks brand new, and
     newJobsFor() with an empty `since` matches the entire catalogue — so
     dropping them would answer a merge with one enormous e-mail. */
  var ALERT_FIELDS = ['name', 'email', 'frequency', 'enabled', 'criteria',
                      'createdAt', 'lastSentAt', 'lastCheckedAt', 'lastUpdateDate',
                      'lastCandidateAt', 'lastSentCount'];

  /** "1 job posting" / "3 job postings". Written out rather than "(s)": these
      lines are the only account of what a merge did, and they should read as
      though a person wrote them. */
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /** "a" / "a and b" / "a, b and c" — the holds and about-to-move lines are
      built from a variable number of parts and still have to read as prose. */
  function listWords(bits) {
    if (bits.length <= 1) return bits.join('');
    return bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1];
  }

  /** Two alerts that would send the same e-mail. Used to skip a copy rather
      than leave the kept account subscribed twice to one thing. */
  function alertSig(a) {
    a = a || {};
    var c = a.criteria || {};
    function set(v) { return (Array.isArray(v) ? v.slice().sort() : []).join('|'); }
    return [
      String(a.name || '').trim().toLowerCase(),
      String(a.email || '').trim().toLowerCase(),
      String(a.frequency || ''),
      set(c.topics), String(c.text || '').trim().toLowerCase(),
      set(c.type), set(c.level), set(c.country), set(c.characteristics)
    ].join('~');
  }

  /**
   * What of the duplicate's profile may be written onto the account we keep.
   *
   * FILL-EMPTY ONLY — the kept account's own details always win; a merge must
   * never silently rename someone. The ORCID iD travels only when the kept
   * account has none or already has the same one: two different iDs are two
   * different researchers, and that is a case to leave alone rather than
   * resolve by guessing.
   */
  function profilePatch(kept, dup) {
    kept = kept || {}; dup = dup || {};
    var patch = {};
    PROFILE_FIELDS.forEach(function (k) {
      if (!String(kept[k] || '').trim() && String(dup[k] || '').trim()) patch[k] = dup[k];
    });
    var mine = kept.orcid || '', theirs = dup.orcid || '';
    if (theirs && (!mine || mine === theirs)) {
      if (!mine) patch.orcid = theirs;
      if (dup.orcidVerified && !kept.orcidVerified) patch.orcidVerified = true;
    }
    return patch;
  }

  function secondaryApp(fb) {
    try { return fb.app(MERGE_APP); }
    catch (e) { return fb.initializeApp(OAFB.config, MERGE_APP); }
  }

  function disposeSecondary(fb) {
    var app;
    try { app = fb.app(MERGE_APP); } catch (e) { return Promise.resolve(); }
    return app.auth().signOut()
      .catch(function () {})
      .then(function () { return app.delete(); })
      .catch(function () {});
  }

  /** Everything on THIS account that a merge would move. Read up front so the
      confirmation can say what is actually at stake rather than "your data".

      ALL THREE posting collections are surveyed — job postings, candidate
      profiles and placement reports share the same ownership model (a
      top-level document pinned to a `uid`), so any one of them missed here
      is stranded alike when the duplicate sign-in is deleted. A failed read
      is REPORTED, not swallowed: an account whose postings we cannot
      enumerate must never be deleted. */
  function surveyAccount(fb) {
    var db = fb.firestore(), uid = state.user.uid;

    function postingsOf(colName) {
      return db.collection(colName).where('uid', '==', uid).get()
        .then(function (s) {
          return {
            docs: s.docs.map(function (d) { return { id: d.id, data: d.data() }; }),
            ok: true
          };
        })
        .catch(function () { return { docs: [], ok: false }; });
    }

    return Promise.all([
      db.collection(OAFB.col.users).doc(uid).collection(OAFB.col.alerts).get(),
      postingsOf(OAFB.col.jobSubmissions),
      postingsOf(OAFB.col.candidateSubmissions),
      postingsOf(OAFB.col.placementSubmissions)
    ]).then(function (r) {
      return {
        alerts: r[0].docs.map(function (d) { return { id: d.id, data: d.data() }; }),
        jobs: r[1].docs, jobsOk: r[1].ok,
        cands: r[2].docs, candsOk: r[2].ok,
        places: r[3].docs, placesOk: r[3].ok,
        postingsOk: r[1].ok && r[2].ok && r[3].ok
      };
    });
  }

  function openMerge() {
    if (!state.user || !window.OAFB || !OAFB.enabled || state.failed) return;

    var old = document.getElementById('oa-merge');
    if (old) old.parentNode.removeChild(old);

    var u = state.user;
    var kept = null;          // the signed-in user of the account being KEPT
    var mine = null;          // what this account holds, from surveyAccount()
    var others = providerButtonsHTML(hasProvider('oidc.orcid') ? ['orcid'] : []);

    var wrap = document.createElement('div');
    wrap.className = 'oa-modal';
    wrap.id = 'oa-merge';
    wrap.innerHTML =
      '<div class="oa-modal-card oa-merge-card" role="dialog" aria-modal="true" ' +
        'aria-labelledby="oa-merge-h">' +
        '<button type="button" class="oa-modal-x" aria-label="Close">&times;</button>' +
        '<h3 id="oa-merge-h">Merge two accounts</h3>' +
        '<p class="oa-modal-lede">Everything on the account you are signed in to now moves ' +
          'into the account you choose next. This one is then removed. Nothing is deleted ' +
          'until the move has succeeded.</p>' +

        '<div class="oa-merge-from">' +
          '<span class="oa-avatar" aria-hidden="true" style="--oa-hue:' + avatarHue(u) + '">' +
            esc(initials(u)) + '</span>' +
          '<span class="oa-merge-who">' +
            '<strong>Moving out of: ' + esc(displayName(u)) + '</strong>' +
            '<span class="oa-acct-mail">' + esc(u.email || ('signs in with ' + providerSummary(u))) + '</span>' +
            '<span class="oa-merge-holds" id="oa-merge-holds">Checking what this account holds…</span>' +
          '</span>' +
        '</div>' +

        '<div id="oa-merge-step1">' +
          '<h4>Sign in to the account you want to keep</h4>' +
          '<p class="oa-opt oa-fine oa-merge-note">This is the only way we can be sure the ' +
            'other account is yours too. It stays signed in only for the merge.</p>' +
          (others ? '<div class="oa-auth-providers">' + others +
            '</div><div class="oa-or">or</div>' : '') +
          '<form id="oa-merge-form">' +
            '<label>E-mail<input type="email" name="email" autocomplete="off" required></label>' +
            '<label>Password<input type="password" name="password" autocomplete="off" ' +
              'minlength="6" required></label>' +
            '<div class="oa-auth-actions">' +
              '<button type="submit" class="button blue">Sign in to that account</button>' +
            '</div>' +
          '</form>' +
        '</div>' +

        '<div id="oa-merge-step2" hidden>' +
          '<div class="oa-merge-into" id="oa-merge-into"></div>' +
          '<div class="oa-auth-actions">' +
            '<button type="button" class="button blue" id="oa-merge-go">Merge the accounts</button>' +
            '<button type="button" class="oa-linkbtn" id="oa-merge-other">Choose a different account</button>' +
          '</div>' +
        '</div>' +

        '<ul class="oa-merge-log" id="oa-merge-log" hidden></ul>' +
        '<p class="oa-auth-msg" id="oa-merge-msg" role="alert"></p>' +
      '</div>';
    document.body.appendChild(wrap);

    var msgEl = $('#oa-merge-msg', wrap);
    var logEl = $('#oa-merge-log', wrap);

    function say(m, kind) {
      msgEl.textContent = m || '';
      msgEl.className = 'oa-auth-msg' + (kind ? ' is-' + kind : '');
    }
    function step(text) {
      logEl.hidden = false;
      var li = document.createElement('li');
      li.textContent = text;
      logEl.appendChild(li);
    }
    function close() {
      wrap.hidden = true;
      OAFB.ready().then(disposeSecondary);
    }

    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    $('.oa-modal-x', wrap).addEventListener('click', close);

    // What is at stake, in numbers, before anything is asked of the user.
    OAFB.ready().then(surveyAccount).then(function (s) {
      mine = s;
      var bits = [count(s.alerts.length, 'e-mail alert')];
      if (s.jobsOk) bits.push(count(s.jobs.length, 'job posting'));
      // candidate profiles and placement reports are named only when there
      // are any — most posters hold none, and "0 of everything" is noise
      if (s.candsOk && s.cands.length) bits.push(count(s.cands.length, 'candidate profile'));
      if (s.placesOk && s.places.length) bits.push(count(s.places.length, 'placement report'));
      $('#oa-merge-holds', wrap).textContent = 'Holds ' + listWords(bits) + ', plus your details.' +
        (s.postingsOk ? '' : ' (We could not read its postings — see below.)');
    }).catch(function () {
      $('#oa-merge-holds', wrap).textContent =
        'We could not read what this account holds — the merge will still move whatever is there.';
      mine = null;
    });

    /* -------- step 1: prove the account we are merging INTO ---------------- */

    function adopt(user) {
      if (!user) return;
      if (user.uid === state.user.uid) {
        say('That is the same account you are signed in to. Choose the OTHER one — the ' +
            'one you want to keep.', 'err');
        return OAFB.ready().then(disposeSecondary);
      }
      kept = user;
      say('');
      $('#oa-merge-step1', wrap).hidden = true;
      $('#oa-merge-step2', wrap).hidden = false;
      $('#oa-merge-into', wrap).innerHTML =
        '<span class="oa-avatar" aria-hidden="true" style="--oa-hue:' + avatarHue(user) + '">' +
          esc(otherInitials(user)) +
        '</span>' +
        '<span class="oa-merge-who">' +
          '<strong>Moving into: ' + esc(user.displayName || user.email || 'your other account') + '</strong>' +
          '<span class="oa-acct-mail">' + esc(user.email || ('signs in with ' + providerSummary(user))) + '</span>' +
          '<span class="oa-merge-holds">' + (mine
            ? 'About to move ' + listWords(
                [count(mine.alerts.length, 'alert'), count(mine.jobs.length, 'job posting')]
                  .concat(mine.cands && mine.cands.length
                    ? [count(mine.cands.length, 'candidate profile')] : [])
                  .concat(mine.places && mine.places.length
                    ? [count(mine.places.length, 'placement report')] : [])) +
              ' here, then remove the other account.'
            : 'About to move everything here, then remove the other account.') +
          '</span>' +
        '</span>';
    }

    function signInSecond(run) {
      say('Opening the sign-in…');
      return OAFB.ready().then(function (fb) {
        var app = secondaryApp(fb);
        // NONE: the account we keep must not be left persisted under a second
        // app name in this browser — it is signed in for the merge and nothing
        // else.
        return app.auth().setPersistence(fb.auth.Auth.Persistence.NONE)
          .catch(function () {})
          .then(function () { return run(fb, app.auth()); });
      }).then(function (cred) {
        return adopt(cred && cred.user);
      }).catch(function (err) {
        var m = friendly(err);
        if (m) say(m, 'err');
        else say('');
        return OAFB.ready().then(disposeSecondary);
      });
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('.oa-auth-provider'), function (b) {
      b.addEventListener('click', function () {
        signInSecond(function (fb, auth) {
          var p = b.dataset.provider === 'google'
            ? new fb.auth.GoogleAuthProvider()
            : new fb.auth.OAuthProvider('oidc.orcid');
          return auth.signInWithPopup(p);
        });
      });
    });

    $('#oa-merge-form', wrap).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      signInSecond(function (fb, auth) {
        return auth.signInWithEmailAndPassword(f.email.value, f.password.value);
      });
    });

    $('#oa-merge-other', wrap).addEventListener('click', function () {
      kept = null;
      $('#oa-merge-step2', wrap).hidden = true;
      $('#oa-merge-step1', wrap).hidden = false;
      say('');
      OAFB.ready().then(disposeSecondary);
    });

    /* -------- step 2: run it ---------------------------------------------- */

    $('#oa-merge-go', wrap).addEventListener('click', function () {
      var go = $('#oa-merge-go', wrap);
      go.disabled = true;
      $('#oa-merge-other', wrap).hidden = true;
      say('Merging…');
      OAFB.ready()
        .then(function (fb) { return runMerge(fb, kept, mine, step); })
        .then(function (result) {
          say('');
          step('Done.');
          $('#oa-merge-step2', wrap).hidden = true;
          var note = document.createElement('p');
          note.className = 'oa-auth-msg is-ok';
          note.textContent = result.signInGone
            ? 'Merged. Sign in again with the account you kept — everything is there.'
            : 'Merged. Everything moved, but we could not remove the old sign-in ' +
              '(' + result.deleteError + '). It now holds nothing.';
          wrap.querySelector('.oa-merge-card').appendChild(note);
          if (result.signInGone) setTimeout(function () { close(); openAuth(); }, 2500);
        })
        .catch(function (err) {
          go.disabled = false;
          $('#oa-merge-other', wrap).hidden = false;
          say('The merge stopped: ' + (friendly(err) || (err && err.message) || 'unknown error') +
              ' Nothing was deleted — you can try again.', 'err');
          if (window.console) console.error('OA merge:', err);
        });
    });
  }

  /**
   * The merge itself. `dup` is the account currently signed in on the primary
   * app; `kept` is the user object of the second app's session.
   *
   * Every step is idempotent, because a half-finished merge must be safe to
   * re-run: alerts are written under the id they already had, the profile
   * patch only fills blanks, and a posting already handed over is skipped.
   */
  function runMerge(fb, kept, survey, step) {
    var db = fb.firestore();                       // as the duplicate
    var app2 = secondaryApp(fb);
    var db2 = app2.firestore();                    // as the account we keep
    var dupUid = state.user.uid;
    var keptUid = kept.uid;
    var dupProfile = state.profile || {};
    var out = { alerts: 0, jobs: 0, cands: 0, places: 0, signInGone: false, deleteError: '' };

    /** Hand one collection's documents over to the kept account, as the
        CURRENT owner — the only account the rules allow to do it. Idempotent:
        a document already owned by the kept account is skipped, so a re-run
        after a half-finished merge moves only what is left. */
    function handOver(colName, docsList) {
      var moved = 0;
      var writes = (docsList || []).map(function (j) {
        if (j.data.uid === keptUid) return null;
        moved++;
        return db.collection(colName).doc(j.id).update({
          uid: keptUid,
          mergedFrom: dupUid,
          mergedAt: fb.firestore.FieldValue.serverTimestamp()
        });
      }).filter(Boolean);
      return Promise.all(writes).then(function () { return moved; });
    }

    var alertsCol = db.collection(OAFB.col.users).doc(dupUid).collection(OAFB.col.alerts);
    var keptAlerts = db2.collection(OAFB.col.users).doc(keptUid).collection(OAFB.col.alerts);

    return Promise.resolve(survey || surveyAccount(fb))
      .then(function (s) {
        survey = s;
        // Refuse rather than strand. If ANY posting collection could not be
        // listed we do not know what would be left behind, and the last step
        // of this merge deletes the only sign-in that could ever reach it
        // again.
        if (!survey.postingsOk) {
          throw new Error('we could not read this account\'s postings, so nothing was ' +
            'moved. Reload the page and try again.');
        }
        return keptAlerts.get();
      })

      // 1. alerts — same id, so a retry cannot double them; an alert that
      //    would send exactly what one already there sends is skipped.
      .then(function (snap) {
        var have = {}, sigs = {};
        snap.docs.forEach(function (d) { have[d.id] = true; sigs[alertSig(d.data())] = true; });
        var writes = survey.alerts.map(function (a) {
          if (have[a.id] || sigs[alertSig(a.data)]) return null;
          var doc = { mergedFrom: dupUid };
          ALERT_FIELDS.forEach(function (k) {
            if (a.data[k] !== undefined) doc[k] = a.data[k];
          });
          out.alerts++;
          return keptAlerts.doc(a.id).set(doc, { merge: true });
        }).filter(Boolean);
        return Promise.all(writes);
      })
      .then(function () {
        step(out.alerts ? 'Moved ' + count(out.alerts, 'e-mail alert') + '.'
                        : 'No e-mail alerts needed moving.');
        return db2.collection(OAFB.col.profiles).doc(keptUid).get();
      })

      // 2. profile — fill-empty, so the kept account is never renamed
      .then(function (snap) {
        var patch = profilePatch(snap && snap.exists ? snap.data() : {}, dupProfile);
        if (!Object.keys(patch).length) { step('Your details were already there.'); return; }
        return db2.collection(OAFB.col.profiles).doc(keptUid).set(patch, { merge: true })
          .then(function () { step('Filled in your details where the other account had none.'); });
      })

      // 3. postings — the reason both accounts are signed in at once. Job
      //    postings, candidate profiles and placement reports all hand over
      //    the same way; _firestore.rules carries an identical merge clause
      //    for each of the three collections.
      .then(function () { return handOver(OAFB.col.jobSubmissions, survey.jobs); })
      .then(function (n) {
        out.jobs = n;
        step(n ? 'Handed over ' + count(n, 'job posting') + ' — you can still ' +
                 'correct or withdraw ' + (n === 1 ? 'it' : 'them') + '.'
               : 'No job postings needed handing over.');
        return handOver(OAFB.col.candidateSubmissions, survey.cands);
      })
      .then(function (n) {
        out.cands = n;
        if (n) step('Handed over ' + count(n, 'candidate profile') + '.');
        return handOver(OAFB.col.placementSubmissions, survey.places);
      })
      .then(function (n) {
        out.places = n;
        if (n) step('Handed over ' + count(n, 'placement report') + '.');
      })

      // 4. identity keys now belong to the kept account, so the duplicate
      //    check stops pointing at an account that no longer exists
      .then(function () {
        var keys = [];
        if (dupProfile.orcid) keys.push(Promise.resolve('orcid:' + dupProfile.orcid));
        if (state.user.email) keys.push(emailKey(state.user.email).catch(function () { return ''; }));
        return Promise.all(keys).then(function (ks) {
          return Promise.all(ks.filter(Boolean).map(function (k) {
            return db2.collection(OAFB.col.accountKeys).doc(k)
              .set({ uid: keptUid, t: Date.now() }).catch(function () {});
          }));
        });
      })

      // 5. ONLY NOW delete. The duplicate's alerts have to go explicitly:
      //    deleting a Firebase sign-in does not delete its Firestore data, and
      //    the mailer reads every alert in the database by collection group —
      //    so leaving them behind would send the user two of everything for
      //    ever.
      .then(function () {
        return Promise.all(survey.alerts.map(function (a) {
          return alertsCol.doc(a.id).delete().catch(function () {});
        }));
      })
      .then(function () {
        return Promise.all([
          db.collection(OAFB.col.profiles).doc(dupUid).delete().catch(function () {}),
          db.collection(OAFB.col.registered).doc(dupUid).delete().catch(function () {}),
          /* …and the roster row, for the same reason as the tally beside it:
             deleting a sign-in does not delete its Firestore data, so a row
             left behind would list one person twice on the Admin area for
             ever. Both are owner-deletes, done here while we can still write
             as the duplicate.

             The duplicate's message THREAD is deliberately NOT deleted. Only
             the maintainer may delete one (a thread whose history either
             party can erase is not a record of anything), and nothing here
             sends anything, so an orphan costs no e-mail — unlike the alert
             subscriptions above, which is why those must go. The Admin area
             renders a thread whose roster row has gone as exactly that, and
             the maintainer can remove it there. */
          db.collection((OAFB.col && OAFB.col.userDirectory) || 'userDirectory')
            .doc(dupUid).delete().catch(function () {})
        ]);
      })
      .then(function () {
        step('Cleared the old account.');
        return disposeSecondary(fb);
      })

      // 6. the sign-in itself
      .then(function () { return deleteCurrentSignIn(fb); })
      .then(function () {
        out.signInGone = true;
        step('Removed the old sign-in.');
        return out;
      })
      .catch(function (err) {
        // The data all moved and only the sign-in removal failed. Reporting
        // that as a failed merge would be untrue — and would invite a retry
        // that re-runs the whole thing.
        if (err && err.__afterMove) {
          out.deleteError = err.message;
          step('Could not remove the old sign-in.');
          return out;
        }
        throw err;
      });
  }

  /** Delete the sign-in we are currently using, re-proving it first if
      Firebase asks — with whichever method this account actually has. */
  function deleteCurrentSignIn(fb) {
    var u = state.user;
    return u.delete().catch(function (e) {
      if (!e || e.code !== 'auth/requires-recent-login') throw tagAfterMove(e);
      return reauthCurrent(fb).then(function () { return u.delete(); })
        .catch(function (e2) { throw tagAfterMove(e2); });
    });
  }

  function tagAfterMove(e) {
    var err = e instanceof Error ? e : new Error(String((e && e.message) || e));
    err.__afterMove = true;
    if (!err.message) err.message = 'unknown error';
    return err;
  }

  function reauthCurrent(fb) {
    var u = state.user, ids = providerIds();
    if (ids.indexOf('google.com') !== -1) {
      return u.reauthenticateWithPopup(new fb.auth.GoogleAuthProvider());
    }
    if (ids.indexOf('oidc.orcid') !== -1) {
      return u.reauthenticateWithPopup(new fb.auth.OAuthProvider('oidc.orcid'));
    }
    if (ids.indexOf('password') !== -1) {
      var pw = window.prompt('For safety, please re-enter the password of the account being ' +
        'merged away (' + (u.email || '') + '):');
      if (!pw) return Promise.reject(new Error('re-authentication was cancelled'));
      return u.reauthenticateWithCredential(
        fb.auth.EmailAuthProvider.credential(u.email, pw));
    }
    return Promise.reject(new Error('this account has no sign-in method we can re-check'));
  }

  /* ---------------------------------------------------- duplicate detection

     Each session claims its identity keys. A key already claimed by ANOTHER
     uid means the same person holds two accounts. The first claim always
     stands — the conflicting session never overwrites it — except when this
     account VERIFIABLY holds the identity itself (an ORCID we were given by an
     ORCID sign-in, or the account's own Firebase e-mail), which is how the
     ghost claim left behind by an account that has already been merged away
     heals instead of nagging for ever.

     Every read and write here is best effort: until the accountKeys rule in
     v2/_firestore.rules is published they all fail, and nothing else may
     depend on them. */

  var accountKeysChecked = false, duplicateNoted = false;

  function claimAccountKeys() {
    if (accountKeysChecked || !state.user || !window.OAFB || !OAFB.enabled) return;
    accountKeysChecked = true;

    var uid = state.user.uid;
    var p = state.profile || {};
    var authEmail = String(state.user.email || '').trim().toLowerCase();
    var keys = [];
    if (p.orcid) keys.push(Promise.resolve('orcid:' + p.orcid));
    if (authEmail) keys.push(emailKey(authEmail).catch(function () { return ''; }));
    if (!keys.length) return;

    OAFB.ready().then(function (fb) {
      var db = fb.firestore();
      Promise.all(keys).then(function (ks) {
        ks.filter(Boolean).forEach(function (k) {
          var ref = db.collection(OAFB.col.accountKeys).doc(k);
          ref.get().then(function (d) {
            if (!state.user || state.user.uid !== uid) return;    // signed out meanwhile
            var held = d.exists && (d.data() || {}).uid;
            if (held && held !== uid) { keyConflict(k, ref, uid, !!authEmail); return; }
            ref.set({ uid: uid, t: Date.now() }).catch(function () {});
          }).catch(function () {});
        });
      });
    }).catch(function () {});
  }

  function keyConflict(key, ref, uid, emailIsAuth) {
    var p = state.profile || {};
    var holdsIt = key.indexOf('orcid:') === 0
      ? !!(p.orcid && key === 'orcid:' + p.orcid && (p.orcidVerified || hasProvider('oidc.orcid')))
      : emailIsAuth;                       // the key was built from our own auth e-mail

    // A stale claim from an account that has already been merged away.
    if (holdsIt && !isOrcidOnly()) {
      ref.set({ uid: uid, t: Date.now() }).catch(function () {});
      return;
    }
    noteDuplicate(key);
  }

  function noteDuplicate(key) {
    if (duplicateNoted) return;
    duplicateNoted = true;
    var what = key.indexOf('orcid:') === 0 ? 'ORCID iD' : 'e-mail address';

    if (isOrcidOnly()) {
      // THIS sign-in is the duplicate: its iD already belongs to an account the
      // user had first. Open the repair with the reason on screen rather than
      // leaving them to find it in a menu.
      openMerge();
      var m = document.getElementById('oa-merge-msg');
      if (m) {
        m.className = 'oa-auth-msg is-ok';
        m.textContent = 'You already have an Operations Academia account with the same ' +
          what + '. Sign in to it below and this ORCID registration will be merged into it.';
      }
      return;
    }
    window.alert('Another Operations Academia account uses the same ' + what + ' as this one. ' +
      'If it is also yours, sign in to it and use Edit profile → "Merge this account into ' +
      'another of mine" to bring everything here.');
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
        // Whoever signs in next gets their own identity check — otherwise a
        // second account signed in on the same page would inherit the first
        // one's "already checked" latch and never be looked at.
        accountKeysChecked = false;
        duplicateNoted = false;
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
    openMerge: openMerge,
    profile: function () { return state.profile; },
    displayName: function () { return displayName(state.user); },
    signOut: signOut,
    whenSignedIn: whenSignedIn,
    onChange: onChange,
    user: function () { return state.user; },
    resolved: function () { return state.resolved; },
    /** The localStorage memory of the LAST resolved auth state — 'in', 'out',
        or null on a first visit. What lets a page paint its signed-in or
        signed-out shape immediately instead of holding everything blank while
        the SDK downloads and the session restores (~1-3 s on a cold cache);
        the real state reconciles it when it arrives. */
    hint: function () {
      if (state.resolved) return state.user ? 'in' : 'out';
      // The stored hint exists only for a signed-in session (sign-out removes
      // it), so a first-time visitor and a signed-out one read the same —
      // 'out' — which is the right shape to paint first for both.
      return readHint() ? 'in' : 'out';
    },
    /** True when the SDK itself could not be loaded — offline, a blocked
        CDN, an ad blocker. Pages use this to say so instead of offering a
        control that cannot work. */
    failed: function () { return state.failed; },
    isAdmin: function () {
      return !!(state.user && window.OAFB &&
        (state.user.email || '').toLowerCase() === String(OAFB.adminEmail).toLowerCase());
    },

    /* The decisions the merge makes, as pure functions of their inputs. They
       are exported because they are the part worth TESTING — what travels
       between two accounts and what does not — and a browser IIFE holding a
       live Firebase session is not a thing a test can reach into. Driven by
       v2/_scraper/page-test.mjs. */
    pure: {
      normOrcid: normOrcid,
      profilePatch: profilePatch,
      alertSig: alertSig,
      initialsFrom: initialsFrom,
      providerSummary: providerSummary,
      isOrcidOnly: isOrcidOnly,
      // Both are pure functions of (profile, user), so the branches of the
      // card — a verified iD versus one to type, which sign-ins are still
      // worth attaching — can be rendered and read without a session.
      orcidFieldHTML: orcidFieldHTML,
      otherAccountsHTML: otherAccountsHTML,
      ALERT_FIELDS: ALERT_FIELDS,
      PROFILE_FIELDS: PROFILE_FIELDS
    }
  };
})();
