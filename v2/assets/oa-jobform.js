/* ---------------------------------------------------------------------------
   Operations Academia — "Post a job" form.

   Replaces the Google Form that fed the "Job Postings" spreadsheet. It writes
   ONE bounded document into the Firestore `jobSubmissions` collection; the
   scheduled build (v2/_scraper/build-jobs.mjs) turns queued documents into rows
   in v2/data/jobs.json and commits them, and the static page then lazy-loads
   that JSON. No vendor in the path.

   Posting requires an account (the maintainer's choice): the identity is known,
   so the posting publishes automatically without a review step, and the poster
   can come back to correct or withdraw it.

   The client is never trusted with what gets published — v2/_firestore.rules
   pins `status` to 'queued' and `uid` to the caller, and the build re-validates
   and re-sanitises every field before it reaches the JSON.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var COUNTRIES = [
    'USA', 'Canada', 'United Kingdom', 'Ireland', 'France', 'Germany', 'Netherlands',
    'Belgium', 'Spain', 'Portugal', 'Italy', 'Switzerland', 'Austria', 'Denmark',
    'Sweden', 'Norway', 'Finland', 'Greece', 'Turkey', 'Israel', 'India', 'China',
    'Hong Kong', 'Singapore', 'Japan', 'South Korea', 'Taiwan', 'Australia',
    'New Zealand', 'Brazil', 'Chile', 'Mexico', 'South Africa', 'United Arab Emirates'
  ];

  var MAX = {
    institution: 160, department: 220, country: 60, applyByNote: 300,
    comments: 1200, postedAtUrl: 500, adUrl: 500,
    firstName: 80, lastName: 80, email: 160, chairName: 120, chairEmail: 160, note: 1200
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
     2025-2026 market is "2026". It turns over in the summer, when postings for
     the next one start going up. Offer the previous year too — a posting made
     in September for a market that is already running is common. */
  function jobMarketYears() {
    var now = new Date();
    var base = now.getFullYear() + (now.getMonth() >= 5 ? 1 : 0);
    return { list: [base - 1, base, base + 1], current: base };
  }

  function fillStaticOptions() {
    var dl = $('oa-countries');
    if (dl) {
      COUNTRIES.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c;
        dl.appendChild(o);
      });
    }
    var y = $('f-year');
    if (y) {
      var years = jobMarketYears();
      years.list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v);
        o.textContent = (v - 1) + '\u2013' + v + '  (\u201c' + v + '\u201d)';
        if (v === years.current) o.selected = true;
        y.appendChild(o);
      });
    }
  }

  function checked(name) {
    return Array.prototype.slice
      .call(document.querySelectorAll('input[name="' + name + '"]:checked'))
      .map(function (n) { return n.value; });
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

  function httpUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^https?:\/\/\S+\.\S+/i.test(v)) return null;   // null = present but invalid
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

    need('f-institution', 'institution', 'the name of the institution');
    need('f-department', 'department', 'the school, department or group');
    need('f-country', 'country', 'the country of the campus');
    need('f-firstName', 'firstName', 'your first name');
    need('f-lastName', 'lastName', 'your last name');

    var type = $('f-type');
    setError(type, type.value ? '' : 'Please choose a type of institution.');
    if (!type.value && !firstBad) firstBad = type;
    out.type = type.value;

    var email = $('f-email');
    var ev = String(email.value || '').trim();
    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ev);
    setError(email, emailOk ? '' : 'Please give an e-mail address we can reach you at.');
    if (!emailOk && !firstBad) firstBad = email;
    out.email = ev.slice(0, MAX.email);

    out.levels = checked('levels');
    setError($('f-levels'), out.levels.length ? '' : 'Please tick at least one entry level.');
    if (!out.levels.length && !firstBad) firstBad = $('f-levels');

    var untilFilled = $('f-untilFilled').checked;
    var day = String($('f-applyByDate').value || '').trim();
    if (untilFilled) {
      out.applyByDate = '';
    } else {
      setError($('f-applyByDate'),
        day ? '' : 'Please give a deadline, or tick that there is no fixed one.');
      if (!day && !firstBad) firstBad = $('f-applyByDate');
      out.applyByDate = day;
    }
    out.untilFilled = !!untilFilled;

    var urlFields = [['f-postedAtUrl', 'postedAtUrl'], ['f-adUrl', 'adUrl']];
    for (var i = 0; i < urlFields.length; i++) {
      var el = $(urlFields[i][0]);
      var u = httpUrl(el.value);
      if (u === null) {
        setError(el, 'That does not look like a web address. It should start with https://');
        if (!firstBad) firstBad = el;
        out[urlFields[i][1]] = '';
      } else {
        setError(el, '');
        out[urlFields[i][1]] = u.slice(0, MAX[urlFields[i][1]]);
      }
    }

    var chairEmail = String($('f-chairEmail').value || '').trim();
    if (chairEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(chairEmail)) {
      setError($('f-chairEmail'), 'That does not look like an e-mail address.');
      if (!firstBad) firstBad = $('f-chairEmail');
    } else {
      setError($('f-chairEmail'), '');
    }

    out.year = parseInt($('f-year').value, 10) || jobMarketYears().current;
    out.applyByNote = String($('f-applyByNote').value || '').trim().slice(0, MAX.applyByNote);
    out.comments = String($('f-comments').value || '').trim().slice(0, MAX.comments);
    out.characteristics = checked('characteristics');
    out.chairName = String($('f-chairName').value || '').trim().slice(0, MAX.chairName);
    out.chairEmail = chairEmail.slice(0, MAX.chairEmail);
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

  /* A human-quotable reference, same shape as /lit/'s feedback tickets:
     OA-JOB-YYMMDD-XXXX. Generated on the page so it can be shown immediately. */
  function makeRef() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
    var rnd = '';
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 4; i++) rnd += alphabet[buf[i] % alphabet.length];
    return 'OA-JOB-' + stamp + '-' + rnd;
  }

  /* ------------------------------------------------------------------- wiring */

  function boot() {
    fillStaticOptions();

    var form = $('oa-job-form');
    var offline = $('oa-offline');
    var needauth = $('oa-needauth');

    if (!window.OAFB || !OAFB.enabled) {
      show(offline, true);
      show($('oa-intro'), false);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });

    /* Clear a field's error as soon as the reader acts on it. Without this the
       red message sits under a field they have already corrected, and the only
       thing that clears it is another failed submit. */
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
    }, true);
    form.addEventListener('change', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
      if (e.target.name === 'levels') setError($('f-levels'), '');
    }, true);

    // toggling "until filled" relaxes the date requirement
    $('f-untilFilled').addEventListener('change', function () {
      var d = $('f-applyByDate');
      d.disabled = this.checked;
      if (this.checked) { d.value = ''; setError(d, ''); }
    });

    OAAccounts.onChange(function (user) {
      show(form, !!user);
      show(needauth, !user);
      if (user && !$('f-email').value) $('f-email').value = user.email || '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var doc = collect();
      if (!doc) return;

      var btn = $('oa-submit');
      btn.disabled = true;
      say('Sending…');

      OAAccounts.whenSignedIn(function (user) {
        OAFB.ready().then(function (fb) {
          doc.ref = makeRef();
          doc.uid = user.uid;
          doc.authEmail = user.email || '';
          doc.status = 'queued';       // the rules pin this; the build publishes it
          doc.source = 'oa-form';
          doc.createdAt = fb.firestore.FieldValue.serverTimestamp();
          return fb.firestore().collection(OAFB.col.jobSubmissions).add(doc)
            .then(function () { return doc.ref; });
        }).then(function (ref) {
          $('oa-ref').textContent = ref;
          show(form, false);
          show($('oa-intro'), false);
          show($('oa-done'), true);
          $('oa-done').scrollIntoView({ block: 'start', behavior: 'smooth' });
        }).catch(function (err) {
          btn.disabled = false;
          var code = (err && err.code) || '';
          if (code === 'permission-denied') {
            say('The site is not accepting postings yet — its database rules have not been ' +
                'published. Please try again later, or contact us.', 'err');
          } else {
            say('We could not send your posting. Please try again in a moment.' +
                (code ? ' (' + code + ')' : ''), 'err');
          }
          if (window.console) console.error('post-a-job:', err);
        });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
