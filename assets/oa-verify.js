/* ---------------------------------------------------------------------------
   Operations Academia, the verification landing page (verify-email.html).

   The link in the verification message opens this page with
   ?mode=verifyEmail&oobCode=<code>. The page applies the code, and then:

     - the address is confirmed: "Your e-mail address is verified", with a
       button to the account page (signed in) or a Sign in button (the link
       was opened in a browser with no session, which is common);
     - the code was refused (expired, already used, copied short): what
       happened, in the accounts module's own words, and "Send me a new link"
       where the signed-in account is the unconfirmed one, otherwise a line
       saying to sign in with the e-mail address and password to get one;
     - no code at all: Firebase's own fallback message applies the code on
       its side and then lands here, so a signed-in account is reloaded and
       shown the verified state; anybody else gets a short explanation.

   Everything that touches the session goes through window.OAAccounts, which
   is the one place that knows what a pending account is and how it is lifted
   (reload, then a fresh ID token, then the ordinary signed-in session). This
   file only decides which of the four cards to show.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CARDS = ['ve-wait', 've-done', 've-error', 've-nocode'];

  function $(id) { return document.getElementById(id); }

  function show(id) {
    CARDS.forEach(function (k) {
      var el = $(k);
      if (el) el.hidden = k !== id;
    });
  }

  function say(id, msg, ok) {
    var m = $(id);
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'oa-auth-msg' + (ok ? ' is-ok' : msg ? ' is-err' : '');
  }

  var params = null;
  try { params = new URLSearchParams(location.search); } catch (e) { params = null; }
  var mode = params ? String(params.get('mode') || '') : '';
  var code = params ? String(params.get('oobCode') || '') : '';

  var A = window.OAAccounts;

  /** Run fn once the session has resolved (signed in, pending, or out). */
  function whenResolved(fn) {
    var done = false;
    function once() { if (done) return; done = true; fn(); }
    if (A.resolved()) { once(); return; }
    A.onChange(once);
  }

  /** The reader's state, asked of the one module that knows it. */
  function pendingUser() { return A.pendingUser ? A.pendingUser() : null; }
  function signedIn() { return !!A.user(); }

  /* ---------------------------------------------------------- the cards */

  function showDone() {
    show('ve-done');
    var inside = signedIn() || !!pendingUser();
    $('ve-continue').hidden = !inside;
    $('ve-signin').hidden = inside;
    $('ve-title').textContent = 'Address confirmed';
  }

  function showError(err) {
    show('ve-error');
    $('ve-error-why').textContent = A.friendly(err);
    var p = pendingUser();
    var canResend = !!(p && A.needsVerification(p));
    $('ve-resend').hidden = !canResend;
    $('ve-error-hint').hidden = canResend;
    $('ve-title').textContent = 'That link did not work';
  }

  function showNoCode() {
    show('ve-nocode');
    var p = pendingUser();
    if (p) {
      $('ve-nocode-why').textContent = 'The address ' + (p.email || 'on this account') +
        ' has not been confirmed yet. Press the link in the message we sent, or ask for a new one.';
      $('ve-nocode-signin').hidden = true;
      $('ve-nocode-resend').hidden = false;
    } else if (signedIn()) {
      // a confirmed account with nothing to confirm: say so, with the way on
      showDone();
      return;
    } else {
      $('ve-nocode-signin').hidden = false;
      $('ve-nocode-resend').hidden = true;
    }
    $('ve-title').textContent = 'E-mail verification';
  }

  function showUnavailable(text) {
    show('ve-error');
    $('ve-error-why').textContent = text;
    $('ve-resend').hidden = true;
    $('ve-error-hint').hidden = true;
    $('ve-title').textContent = 'Sign-in is unavailable';
  }

  /* -------------------------------------------------------- the buttons */

  function resend(msgId) {
    return function () {
      say(msgId, 'Sending.');
      A.sendVerification()
        .then(function (r) {
          if (r && r.throttled) {
            say(msgId, 'The last message was sent a moment ago. Give it a minute and look again.');
            return;
          }
          if (r && r.alreadyVerified) {
            return A.confirmVerified().then(function (ok) {
              if (ok) showDone();
              else say(msgId, 'Not confirmed yet. Press the link in the message first.');
            });
          }
          var p = pendingUser();
          say(msgId, 'Sent to ' + ((p && p.email) || 'your address') + '. Look in your inbox, and in spam.', true);
        })
        .catch(function (err) { say(msgId, A.friendly(err)); });
    };
  }

  function wire() {
    $('ve-signin').addEventListener('click', function () { A.openAuth(); });
    $('ve-nocode-signin').addEventListener('click', function () { A.openAuth(); });
    $('ve-resend').addEventListener('click', resend('ve-msg'));
    $('ve-nocode-resend').addEventListener('click', resend('ve-nocode-msg'));
  }

  /* --------------------------------------------------------------- start */

  function start() {
    if (!window.OAFB || !OAFB.enabled) {
      showUnavailable('Sign-in is not switched on for this site yet, so there is nothing to confirm.');
      return;
    }
    if (A.failed()) {
      showUnavailable('We could not load the sign-in service. If you use an ad blocker, ' +
        'allow gstatic.com and reload the page. Otherwise check your connection and try again.');
      return;
    }

    if (mode === 'verifyEmail' && code) {
      OAFB.ready()
        .then(function (fb) { return fb.auth().applyActionCode(code); })
        .then(function () {
          // the code is applied on Firebase's side; a signed-in pending
          // account still has to be reloaded before the site treats it as
          // usable, which is the lift confirmVerified performs
          return pendingUser() ? A.confirmVerified() : null;
        })
        .then(showDone)
        .catch(showError);
      return;
    }

    if (pendingUser()) {
      A.confirmVerified()
        .then(function (ok) { if (ok) showDone(); else showNoCode(); })
        .catch(function () { showNoCode(); });
      return;
    }
    showNoCode();
  }

  function boot() {
    if (!A) {
      // nothing to decide with: the accounts module did not load
      showUnavailable('We could not load the sign-in service. Reload the page and try again.');
      return;
    }
    wire();
    whenResolved(start);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
