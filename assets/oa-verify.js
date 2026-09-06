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

  /** Show one card, and put the keyboard on its heading. A person who
      arrives from a link in a message and cannot see the page would
      otherwise hear "Checking your link" and then nothing: the cards only
      toggle `hidden`. The headings carry tabindex="-1" for this. */
  function show(id) {
    CARDS.forEach(function (k) {
      var el = $(k);
      if (el) el.hidden = k !== id;
    });
    var h = id !== 've-wait' && $(id) && $(id).querySelector('h2');
    if (h && typeof h.focus === 'function') h.focus();
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

  /* The code is a one-time credential, and it came in on the address bar.
     Now that it is read, it comes OFF the address at once, before any of the
     work below: nothing else on the page may copy it (the usage record and
     the analytics tag both read the page's address, and both are told to
     drop a code they find anyway), a reload cannot re-apply it, and the
     browser's history does not keep it. */
  if (params && (mode || code)) {
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* nothing sane to do */ }
  }

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

  var DONE_NOTE = '';        // the card's own wording, read once at boot

  /* The confirmed state is a BOX in the middle of the screen that moves on by
     itself (owner, 2026-09-05: "just a message box in the center of the
     screen which would disappear after 5sec"). For a reader whose session is
     usable, the page's own hero and footer go (body.ve-focus, v3.css), a
     line under the button counts the seconds down, and at zero the page is
     REPLACED by the account page, so Back does not return to a spent link.
     Never for a reader who must sign in first, and never in the mismatch
     case: there is no account to go to, and a countdown into a locked page
     would be the very thing Continue is withheld for. Pressing Continue
     early does the same thing sooner. */
  var MOVE_ON_S = 5;
  var countdown = null;

  function stopCountdown() {
    if (countdown) { clearInterval(countdown); countdown = null; }
    var c = $('ve-count');
    if (c) { c.hidden = true; c.textContent = ''; }
    document.body.classList.remove('ve-focus');
  }

  function startCountdown(href) {
    if (countdown) return;
    document.body.classList.add('ve-focus');
    var c = $('ve-count');
    var left = MOVE_ON_S;
    var tick = function () {
      if (left <= 0) {
        clearInterval(countdown); countdown = null;
        location.replace(href);
        return;
      }
      if (c) {
        c.hidden = false;
        c.textContent = 'Taking you to your account in ' + left + (left === 1 ? ' second.' : ' seconds.');
      }
      left -= 1;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }
  var WAITING_NOTE = 'The address on the account signed in here has not been confirmed yet, ' +
    'so there is nothing to continue to. Press the link in the message sent to it, or ask ' +
    'for a new one.';
  var MISMATCH_NOTE = 'The link confirmed an address, but not the one this account uses: ' +
    'this account is still unconfirmed. Sign in with the account that received the message, ' +
    'or ask for a new link from this one.';

  /** The verified card. `mismatch` is the case where the code applied but
      the account signed in here is STILL unconfirmed after its reload: the
      link belonged to another address (a second registration after a typo,
      say), so Continue would only lead to a locked account page. */
  function showDone(mismatch) {
    show('ve-done');
    /* CONTINUE MEANS THE ACCOUNT ON THIS PAGE CAN BE USED, and a PENDING
       session cannot: `|| !!pendingUser()` let one through, and since this
       card re-decides itself on every auth change (see boot), a pending
       account signing in underneath it was offered Continue and then carried
       there by the countdown, into an account page that locks. There is
       nothing to lose by waiting: the lift fires an auth change of its own,
       and the card redraws with Continue the moment the session is usable. */
    var waiting = !mismatch && !signedIn() && !!pendingUser();
    var inside = !mismatch && signedIn();
    $('ve-done-note').textContent = mismatch ? MISMATCH_NOTE : (waiting ? WAITING_NOTE : DONE_NOTE);
    $('ve-continue').hidden = !inside;
    $('ve-signin').hidden = inside;
    $('ve-signin').textContent = mismatch ? 'Use a different account'
      : (waiting ? 'Check your inbox' : 'Sign in');
    $('ve-title').textContent = 'Address confirmed';
    if (inside) startCountdown($('ve-continue').getAttribute('href') || 'account.html');
    else stopCountdown();
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
            say(msgId, r.reason || 'The last message was sent a moment ago. Give it a minute and look again.');
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

  /** Sign in, from the verified card. When the account signed in here is a
      pending one whose address the link did NOT confirm (the mismatch case),
      openAuth would only reopen the "Check your inbox" card for it, so that
      account is signed out first and the sign-in box opened for the other. */
  function signInFromDone() {
    /* THE PENDING ACCOUNT IS NOT SIGNED OUT WHEN IT IS THE ONE WAITING. On
       the mismatch the link belonged to somebody else's address and leaving
       this account signed in would be the wrong offer, so it goes; on the
       waiting card it IS this account's address that is unconfirmed, and the
       thing to press is the link in its inbox, not a sign-in box. */
    if (pendingUser() && $('ve-signin').textContent === 'Check your inbox') {
      A.openVerifyPanel();
      return;
    }
    if (pendingUser()) A.signOut();
    A.openAuth();
  }

  function wire() {
    DONE_NOTE = $('ve-done-note').textContent;
    $('ve-signin').addEventListener('click', signInFromDone);
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
        .then(function (ok) {
          // false means the reload found THIS account still unconfirmed:
          // the code confirmed some other address
          showDone(ok === false);
        })
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
    /* The session can change under the page: a signed-out reader presses
       Sign in on the verified card and signs in, or a pending account signs
       out. The card that is showing re-decides its buttons from the new
       state; start() itself runs once. */
    A.onChange(function () {
      if (!$('ve-done').hidden) showDone();
      else if (!$('ve-nocode').hidden) showNoCode();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
