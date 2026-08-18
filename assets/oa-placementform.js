/* ---------------------------------------------------------------------------
   Operations Academia — "Report a placement" form.

   The placements twin of oa-jobform.js. It writes ONE bounded document into
   the Firestore `placementSubmissions` collection; the scheduled build
   (v2/_scraper/build-placements.mjs) turns queued documents into rows in
   v2/data/placements.json and commits them, and the static page then
   lazy-loads that JSON. No vendor in the path, no uploads — a placement is a
   dozen short fields.

   Reporting requires an account (the maintainer's choice): the identity is
   known, so the placement publishes automatically without a review step, and
   the reporter is reachable afterwards about it.

   The client is never trusted with what gets published — v2/_firestore.rules
   pins `status` to 'queued' and `uid` to the caller, and the build
   re-validates and re-sanitises every field before it reaches the JSON
   (v2/_scraper/placements-model.mjs).
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* Client-side caps, mirroring placements-model.mjs (which mirrors the
     ceilings in _firestore.rules). The rules are the enforcement; these only
     keep what is typed inside what the build will keep anyway, so nothing a
     reporter sees survive the submit is silently cut later. */
  var MAX = {
    first: 100, last: 100,
    phdInstitution: 220, undergradInstitution: 220,
    joiningInstitution: 220, joiningPosition: 160,
    webUrl: 500, email: 160, note: 1200
  };

  function $(id) { return document.getElementById(id); }

  function show(el, on) { if (el) el.hidden = !on; }

  function say(msg, kind) {
    var m = $('oa-msg');
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /* The job market year is named for the calendar year it ENDS in: the
     2026-2027 market is "2027". It turns over in the summer. Offer the
     previous year too — a placement accepted in the spring is often reported
     after the roll, and it belongs to the market it was accepted in.

     The turnover is JULY, read in UTC — the same rule as jobs-model.mjs
     (MARKET_ROLL_MONTH = 6), oa-jobform.js, jobs.html and oa-nav.js. Rolling
     a month early, or in local time, would bake the wrong year into the row
     id and the year filter for the whole of June. */
  function marketYears() {
    var now = new Date();
    var base = now.getUTCFullYear() + (now.getUTCMonth() >= 6 ? 1 : 0);
    return { list: [base - 1, base, base + 1], current: base };
  }

  function fillStaticOptions() {
    var y = $('f-year');
    if (y) {
      var years = marketYears();
      years.list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v);
        o.textContent = (v - 1) + '–' + v + '  (“' + v + '”)';
        if (v === years.current) o.selected = true;
        y.appendChild(o);
      });
    }
  }

  function setError(el, msg) {
    if (!el) return;
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    var holder = el.closest('.oa-field') || el.parentNode;
    var old = holder.querySelector('.oa-err');
    if (old) old.parentNode.removeChild(old);
    if (msg) {
      var p = document.createElement('p');
      p.className = 'oa-err';
      p.textContent = msg;
      holder.appendChild(p);
    }
  }

  /* The SAME expression the build re-validates with (jobs-model.mjs url(),
     which placements-model imports), anchored at BOTH ends — the lesson the
     jobs form documents: unanchored, a link carrying a space passed here, was
     reported as sent, and was then dropped by the build with nobody told. */
  function httpUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(v)) return null;   // null = present but invalid
    return v;
  }

  /** Read + validate the form. Returns the submission document, or null. */
  function collect() {
    var out = {}, firstBad = null;

    function need(id, key, label) {
      var el = $(id);
      var v = String(el.value || '').trim().slice(0, MAX[key] || 400);
      setError(el, v ? '' : 'Please give ' + label + '.');
      if (!v && !firstBad) firstBad = el;
      out[key] = v;
    }

    need('f-first', 'first', 'the candidate’s first name');
    need('f-last', 'last', 'the candidate’s last name');
    need('f-phdInstitution', 'phdInstitution', 'the institution of the PhD');
    need('f-joiningInstitution', 'joiningInstitution', 'the institution being joined');
    need('f-joiningPosition', 'joiningPosition',
      'the position — for example “Assistant Professor”');

    var email = $('f-email');
    var ev = String(email.value || '').trim();
    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ev);
    setError(email, emailOk ? '' : 'Please give an e-mail address we can reach you at.');
    if (!emailOk && !firstBad) firstBad = email;
    out.email = ev.slice(0, MAX.email);

    var web = $('f-webUrl');
    var u = httpUrl(web.value);
    if (u === null) {
      setError(web, 'That does not look like a web address. It should start with https://');
      if (!firstBad) firstBad = web;
      out.webUrl = '';
    } else {
      setError(web, '');
      out.webUrl = u.slice(0, MAX.webUrl);
    }

    out.year = parseInt($('f-year').value, 10) || marketYears().current;
    out.undergradInstitution =
      String($('f-undergradInstitution').value || '').trim().slice(0, MAX.undergradInstitution);
    out.note = String($('f-note').value || '').trim().slice(0, MAX.note);

    if (firstBad) {
      say('Please check the highlighted fields.', 'err');
      if (firstBad.focus) firstBad.focus();
      if (firstBad.scrollIntoView) firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return null;
    }
    say('');
    return out;
  }

  /* A human-quotable reference, same shape as the jobs form's and /lit/'s
     feedback tickets: OA-PLAC-YYMMDD-XXXX. Generated on the page so it can be
     shown immediately. */
  function makeRef() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
    var rnd = '';
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 4; i++) rnd += alphabet[buf[i] % alphabet.length];
    return 'OA-PLAC-' + stamp + '-' + rnd;
  }

  /* One place knows the collection name. OAFB.col does not carry
     placementSubmissions yet (oa-firebase.js is shared and may gain it later);
     the fallback keeps this file working either way and matches the name in
     v2/_firestore.rules. */
  function colName() {
    return (window.OAFB && OAFB.col && OAFB.col.placementSubmissions) || 'placementSubmissions';
  }

  /* ------------------------------------------------------------ edit mode

     `?edit=<document id>` turns this page from "report a placement" into
     "correct this placement". The id comes from the Edit button on a card on
     placements.html, and is only useful to someone the rules let read that
     document — an ordinary visitor pasting one gets a permission error rather
     than a form full of someone else's report.                              */

  var EDIT_ID = (function () {
    var m = /[?&]edit=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  })();
  var EDIT_REF = '';

  /** Put a loaded document back into the form. The inverse of collect(). */
  function fill(v) {
    function set(id, value) { var el = $(id); if (el) el.value = value == null ? '' : value; }
    set('f-first', v.first);
    set('f-last', v.last);
    set('f-phdInstitution', v.phdInstitution);
    set('f-undergradInstitution', v.undergradInstitution);
    set('f-joiningInstitution', v.joiningInstitution);
    set('f-joiningPosition', v.joiningPosition);
    set('f-webUrl', v.webUrl);
    set('f-email', v.email || v.authEmail);
    set('f-note', v.note);
    var y = $('f-year');
    if (y && v.year) {
      // a stored year outside the three offered (an old report being fixed
      // seasons later) still has to be selectable, or saving would move it
      if (!y.querySelector('option[value="' + v.year + '"]')) {
        var o = document.createElement('option');
        o.value = String(v.year);
        o.textContent = (v.year - 1) + '–' + v.year + '  (“' + v.year + '”)';
        y.appendChild(o);
      }
      y.value = String(v.year);
    }
    EDIT_REF = v.ref || '';
  }

  function enterEditMode() {
    if (!EDIT_ID) return;

    document.title = 'Edit a placement - OperationsAcademia.org';
    // the page heading, in whichever design is serving this page: the live
    // site heads a page with .v3-pa-hero .v3-h1, the /v2/ archive with
    // .title-heading h2. Renaming neither would leave the form claiming to
    // post something new while it is editing one that exists.
    var h = document.querySelector('.v3-pa-hero .v3-h1') ||
      document.querySelector('.title-heading h2');
    if (h) h.textContent = 'Edit a placement';

    var submit = $('oa-submit');
    if (submit) submit.textContent = 'Save changes';

    var intro = $('oa-intro');
    if (intro) {
      intro.innerHTML = '<p><strong>You are correcting a placement that is already ' +
        'on the site.</strong> Your changes appear on the ' +
        '<a href="placements.html">confirmed placements page</a> at the next update, ' +
        'normally within an hour. Saving a withdrawn placement puts it back on ' +
        'the site.</p>';
    }

    // The withdraw button exists only in edit mode: on a fresh report there is
    // nothing to withdraw yet.
    show($('oa-withdraw'), true);

    OAAccounts.whenSignedIn(function () {
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(colName()).doc(EDIT_ID).get();
      }).then(function (snap) {
        if (!snap.exists) {
          say('That placement no longer exists.', 'err');
          show($('oa-placement-form'), false);
          return;
        }
        fill(snap.data() || {});
      }).catch(function (err) {
        say(err && err.code === 'permission-denied'
          ? 'You are not allowed to edit this placement.'
          : 'We could not load that placement. Please try again.', 'err');
        show($('oa-placement-form'), false);
        if (window.console) console.error('edit:', err);
      });
    });
  }

  /* -------------------------------------------------------------- withdraw

     A status change, never a delete — the build treats a deleted document's
     row as an orphan and PRESERVES it, so deleting would look like it worked
     and change nothing. 'withdrawn' takes the row out at the next build, and
     saving the form again (status back to 'queued') puts it back.          */

  function withdraw() {
    if (!EDIT_ID) return;
    if (!window.confirm(
      'Withdraw this placement from the site?\n\n' +
      'It stops appearing at the next update, normally within an hour. ' +
      'Nothing is deleted — saving this form again puts it back.')) return;

    var btn = $('oa-withdraw');
    btn.disabled = true;
    say('Withdrawing…');

    OAAccounts.whenSignedIn(function () {
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(colName()).doc(EDIT_ID).update({
          /* WHO took it down. 'hidden' is the maintainer, 'withdrawn' is
             the owner — the card buttons have always drawn that distinction
             (oa-placementedit.js), and the build reads it: a withdrawal is
             stamped 'removed' once applied, while 'hidden' STAYS hidden and
             is re-applied on every run. Recorded as 'withdrawn' here, a
             maintainer's take-down was un-done the moment the owner's next
             edit re-queued the document — and nothing said who had done
             either. */
          status: OAAccounts.isAdmin() ? 'hidden' : 'withdrawn',
          updatedAt: new Date().toISOString(),
        });
      }).then(function () {
        var done = $('oa-done');
        done.innerHTML =
          '<h3>Your placement has been withdrawn.</h3>' +
          '<p>It disappears from the <a href="placements.html">confirmed placements ' +
          'page</a> at the next update, normally within an hour. Changed your mind? ' +
          'Open the edit link again and save — that puts it back.</p>' +
          '<p class="oa-done-actions">' +
          '<a class="button blue" href="placements.html">Back to the confirmed placements</a></p>';
        show($('oa-placement-form'), false);
        show($('oa-intro'), false);
        show(done, true);
        done.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }).catch(function (err) {
        btn.disabled = false;
        say(err && err.code === 'permission-denied'
          ? 'You are not allowed to change this placement.'
          : 'We could not withdraw it. Please try again.', 'err');
        if (window.console) console.error('withdraw:', err);
      });
    });
  }

  /* ------------------------------------------------------------------ wiring */

  function boot() {
    wireVocab();
    enterEditMode();
    fillStaticOptions();

    var sent = false;                 // latched once a report has been written
    var form = $('oa-placement-form');
    var offline = $('oa-offline');
    var needauth = $('oa-needauth');

    if (!window.OAFB || !OAFB.enabled) {
      show(offline, true);
      show($('oa-intro'), false);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });
    $('oa-needauth-new').addEventListener('click', function () { OAAccounts.openAuth('register'); });

    var wd = $('oa-withdraw');
    if (wd) wd.addEventListener('click', withdraw);

    /* Clear a field's error as soon as the reader acts on it. Without this
       the red message sits under a field they have already corrected, and the
       only thing that clears it is another failed submit. */
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
    }, true);
    form.addEventListener('change', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
    }, true);

    /* Say what has happened rather than offering a control that cannot work —
       the same stand-down the jobs form and feedback.html do. The SDK loads
       from gstatic, which an ad blocker, a corporate proxy or a national
       firewall can refuse; oa-accounts then resolves as "signed out", so
       without this the reader would be shown a "Sign in" gate for a service
       that cannot answer. The gate stays on screen, DISABLED: an explained,
       inert version of the normal page, never a missing one. */
    function standDown(why) {
      offline.innerHTML = '<p>' + why + '</p>';
      show(offline, true);
      show($('oa-intro'), false);
      show(needauth, true);
      show(form, false);
      [$('oa-needauth-btn'), $('oa-needauth-new')].forEach(function (b) {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
      });
    }

    OAAccounts.onChange(function (user) {
      // The report has already been sent. Re-showing the form over the
      // confirmation on a later auth event would leave the reporter with a
      // filled-in form they cannot submit beside a thank-you for a report
      // already made — the trap the jobs form documents.
      if (sent) return;

      if (OAAccounts.failed && OAAccounts.failed()) {
        standDown('<strong>We cannot reach the reporting service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload. ' +
          'Otherwise please send the details to ' +
          '<a href="mailto:operationsacademia@gmail.com">operationsacademia@gmail.com</a> ' +
          'and we will post the placement for you.');
        return;
      }

      show(form, !!user);
      show(needauth, !user);
      // the intro explains a form that is not on screen while signed out
      show($('oa-intro'), !!user);
      if (user && !$('f-email').value) $('f-email').value = user.email || '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var doc = collect();
      if (!doc) return;

      var btn = $('oa-submit');
      btn.disabled = true;
      say(EDIT_ID ? 'Saving…' : 'Sending…');

      OAAccounts.whenSignedIn(function (user) {
        OAFB.ready().then(function (fb) {
          var col = fb.firestore().collection(colName());

          /* EDITING an existing report. `uid` and `createdAt` are deliberately
             NOT written: the rule pins the owner, and `createdAt` is when the
             placement was first reported, not when a typo was fixed. Status
             goes back to 'queued' so the build picks it up — including a
             report that had been withdrawn, which is how one is put back. */
          if (EDIT_ID) {
            doc.status = 'queued';
            doc.updatedAt = new Date().toISOString();
            delete doc.uid;
            return col.doc(EDIT_ID).update(doc).then(function () { return EDIT_REF; });
          }

          doc.ref = makeRef();
          doc.uid = user.uid;
          doc.authEmail = user.email || '';
          doc.status = 'queued';       // the rules pin this; the build publishes it
          doc.source = 'oa-form';
          doc.createdAt = fb.firestore.FieldValue.serverTimestamp();
          return col.add(doc).then(function () { return doc.ref; });
        }).then(function (ref) {
          sent = true;
          /* The confirmation is written for a NEW report — a reference to
             keep. Neither is true of a correction, so say what actually
             happened instead. */
          if (EDIT_ID) {
            var done = $('oa-done');
            done.innerHTML =
              '<h3>Your changes have been saved.</h3>' +
              '<p>The placement is updated on the ' +
              '<a href="placements.html">confirmed placements page</a> at the next ' +
              'update, normally within an hour.</p>' +
              '<p class="oa-done-actions">' +
              '<a class="button blue" href="placements.html">Back to the confirmed placements</a></p>';
          } else {
            $('oa-ref').textContent = ref || '—';
          }
          show(form, false);
          show($('oa-intro'), false);
          show($('oa-done'), true);
          $('oa-done').scrollIntoView({ block: 'start', behavior: 'smooth' });
        }).catch(function (err) {
          btn.disabled = false;
          var code = (err && err.code) || '';
          if (code === 'permission-denied') {
            say(EDIT_ID
              ? 'You are not allowed to change this placement.'
              : 'The site is not accepting placements yet — its database rules have ' +
                'not been published. Please try again later, or contact us.', 'err');
          } else {
            say('We could not send your placement. Please try again in a moment.' +
                (code ? ' (' + code + ')' : ''), 'err');
          }
          if (window.console) console.error('post-a-placement:', err);
        });
      });
    });
  }

  /* ------------------------------------------------------ the shared vocabulary

     The three institution fields offer the university names the site has
     already published (data/vocab.json, rebuilt by every writer of
     jobs.json), so the same school arrives spelled the same way each time —
     which is what makes the PhD/joining institution filters coherent.

     Entirely optional: if the fetch fails, or oa-combo.js is not on the
     page, the fields stay ordinary text inputs and the form works exactly as
     it did. A HINT, never a restriction — a placement can name an
     institution the site has never listed. */

  function wireVocab() {
    if (!window.OACombo) return;
    var fields = ['f-phdInstitution', 'f-undergradInstitution', 'f-joiningInstitution']
      .map(function (id) { return $(id); })
      .filter(Boolean);
    if (!fields.length) return;

    var combos = fields.map(function (el) { return OACombo.attach(el, { options: [] }); });

    fetch('data/vocab.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (!v) return;
        combos.forEach(function (c) { c.setOptions(v.universities || []); });
      })
      .catch(function () { /* the fields are plain text inputs; that is fine */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
