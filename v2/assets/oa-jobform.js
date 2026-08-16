/* ---------------------------------------------------------------------------
   Operations Academia — "Post a job" form.

   Replaces the Google Form that fed the "Job Postings" spreadsheet. It writes
   ONE bounded document into the Firestore `jobSubmissions` collection; the
   scheduled build (v2/_scraper/build-jobs.mjs) turns queued documents into rows
   in v2/data/jobs.json and commits them, and the static page then lazy-loads
   that JSON. No vendor in the path.

   Posting requires an account (the maintainer's choice): the identity is known,
   so the posting publishes automatically without a review step, and the poster
   is reachable afterwards about the posting.

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
    institution: 160, department: 220, school: 160, unit: 160, country: 60, applyByNote: 300,
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
     in September for a market that is already running is common.

     The turnover is JULY, read in UTC — the same rule as jobs-model.mjs
     (MARKET_ROLL_MONTH = 6), jobs.html and oa-nav.js. Rolling a month early,
     or in local time, pre-selected a season one ahead of the one the rest of
     the site names for the whole of June, and the default is what most posters
     accept — so the wrong year was baked into the row id and the year tally. */
  function jobMarketYears() {
    var now = new Date();
    var base = now.getUTCFullYear() + (now.getUTCMonth() >= 6 ? 1 : 0);
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

  /* The SAME expression the build re-validates with (jobs-model.mjs url()),
     anchored at BOTH ends. Unanchored, only a prefix had to match, so a link
     carrying a space — "…/Assistant Professor.pdf", a Drive path, a link
     copied out of a wrapped e-mail — passed here, was reported as sent, and
     was then dropped by the build: the published card lost the advert link
     the reader came for, and nobody was told. */
  function httpUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(v)) return null;   // null = present but invalid
    return v;
  }

  /* The deadline, checked by the build's rule (jobs-model.mjs day()): a real
     calendar day with the year in 1990-2100. <input type="date"> holds
     "0026-11-01" quite happily — that is what Chrome keeps after the US-habit
     "11/01/26" — and reports it as valid, so nothing else catches it. The
     build then drops the field, and a posting with a hard deadline publishes
     with no Apply-by line at all, filed under "Until filled". */
  function isoDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';   // 31 February
    return m[0];
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

    /* School and unit are each optional — plenty of departments sit directly
       under a university, and plenty of schools advertise without naming one —
       but a posting with NEITHER has nothing under the institution name, so
       the requirement is on the line they are joined into. The error is put on
       the department field, which is the one a poster is most likely to mean. */
    out.school = String($('f-school').value || '').trim().slice(0, MAX.school);
    out.unit = String($('f-unit').value || '').trim().slice(0, MAX.unit);
    out.department = [out.school, out.unit].filter(Boolean).join(', ').slice(0, MAX.department);
    var unitEl = $('f-unit');
    setError(unitEl, out.department ? '' : 'Please give a school, department, area or group.');
    if (!out.department && !firstBad) firstBad = $('f-school');
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
    } else if (!day) {
      setError($('f-applyByDate'), 'Please give a deadline, or tick that there is no fixed one.');
      if (!firstBad) firstBad = $('f-applyByDate');
      out.applyByDate = '';
    } else if (!isoDay(day)) {
      setError($('f-applyByDate'),
        'Please check that date — the year should be a four-digit one, like 2026.');
      if (!firstBad) firstBad = $('f-applyByDate');
      out.applyByDate = '';
    } else {
      setError($('f-applyByDate'), '');
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

  /* ------------------------------------------------------------ edit mode

     `?edit=<document id>` turns this page from "post a job" into "correct this
     posting". The id comes from the Edit button on a card, and is only useful
     to someone the rules let read that document — an ordinary visitor pasting
     one gets a permission error rather than a form full of someone else's
     posting.                                                                */

  var EDIT_ID = (function () {
    var m = /[?&]edit=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  })();
  var EDIT_REF = '';

  /** Put a loaded document back into the form. The inverse of collect(). */
  function fill(v) {
    function set(id, value) { var el = $(id); if (el) el.value = value == null ? '' : value; }
    function ticks(name, values) {
      var want = {};
      (values || []).forEach(function (x) { want[x] = true; });
      Array.prototype.forEach.call(
        $('oa-job-form').querySelectorAll('input[name="' + name + '"]'),
        function (cb) { cb.checked = !!want[cb.value]; });
    }

    set('f-institution', v.institution);
    set('f-type', v.type);

    /* A posting made before the form was split carries only `department`. Its
       school and unit are filled in by the build, so an older document may have
       them; if not, the whole line goes in the department field rather than
       being guessed at here — the poster can split it while they are editing. */
    set('f-school', v.school || '');
    set('f-unit', v.unit || (v.school ? '' : v.department) || '');

    set('f-country', v.country);
    set('f-applyByDate', v.applyByDate);
    set('f-applyByNote', v.applyByNote);
    set('f-comments', v.comments);
    set('f-adUrl', v.adUrl);
    set('f-postedAtUrl', v.postedAtUrl);
    set('f-firstName', v.firstName);
    set('f-lastName', v.lastName);
    set('f-email', v.email || v.authEmail);
    set('f-chairName', v.chairName);
    set('f-chairEmail', v.chairEmail);
    set('f-note', v.note);

    ticks('levels', v.levels);
    ticks('characteristics', v.characteristics);

    var uf = $('f-untilFilled');
    if (uf) {
      uf.checked = !!v.untilFilled;
      var d = $('f-applyByDate');
      if (d) d.disabled = uf.checked;
    }

    EDIT_REF = v.ref || '';

    // keep the derived department line and its preview in step
    var school = $('f-school');
    if (school) school.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function enterEditMode() {
    if (!EDIT_ID) return;

    document.title = 'Edit a posting - OperationsAcademia.org';
    var h = document.querySelector('.title-heading h2');
    if (h) h.textContent = 'Edit a posting';

    var submit = $('oa-submit');
    if (submit) submit.textContent = 'Save changes';

    var intro = $('oa-intro');
    if (intro) {
      intro.innerHTML = '<p><strong>You are correcting a posting that is already ' +
        'on the site.</strong> Your changes appear on the ' +
        '<a href="jobs.html">job postings page</a> at the next update, normally ' +
        'within an hour. The posting date does not change.</p>';
    }

    OAAccounts.whenSignedIn(function () {
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(OAFB.col.jobSubmissions).doc(EDIT_ID).get();
      }).then(function (snap) {
        if (!snap.exists) {
          say('That posting no longer exists.', 'err');
          show($('oa-job-form'), false);
          return;
        }
        fill(snap.data() || {});
      }).catch(function (err) {
        say(err && err.code === 'permission-denied'
          ? 'You are not allowed to edit this posting.'
          : 'We could not load that posting. Please try again.', 'err');
        show($('oa-job-form'), false);
        if (window.console) console.error('edit:', err);
      });
    });
  }

  function boot() {
    wireVocab();
    enterEditMode();
    fillStaticOptions();

    var sent = false;                 // latched once a posting has been written
    var form = $('oa-job-form');
    var offline = $('oa-offline');
    var needauth = $('oa-needauth');

    if (!window.OAFB || !OAFB.enabled) {
      show(offline, true);
      show($('oa-intro'), false);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });
    $('oa-needauth-new').addEventListener('click', function () { OAAccounts.openAuth('register'); });

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

    /* Say what has happened rather than offering a control that cannot work —
       the same stand-down feedback.html does. The SDK is loaded from gstatic,
       which an ad blocker, a corporate proxy or a national firewall can refuse;
       oa-accounts then resolves as "signed out", so without this the reader was
       shown a "Sign in to post a job" gate for a service that cannot answer,
       with no explanation on the page and no other way to reach us.

       The gate itself stays on screen, DISABLED — the state oa-accounts.js
       renders for its own header control when there is no working project: an
       explained, inert version of the normal page, never a missing one. */
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
      // The posting has already been sent. Re-showing the form (and the intro)
      // over the confirmation on any later auth event left the poster with a
      // filled-in form they could not submit — the button is only re-enabled
      // in the failure path — beside a thank-you for a posting already made.
      if (sent) return;

      if (OAAccounts.failed && OAAccounts.failed()) {
        standDown('<strong>We cannot reach the posting service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload. ' +
          'Otherwise please send the posting to ' +
          '<a href="mailto:operationsacademia@gmail.com">operationsacademia@gmail.com</a> ' +
          'and we will put it up for you.');
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
          var col = fb.firestore().collection(OAFB.col.jobSubmissions);

          /* EDITING an existing posting. `uid` and `createdAt` are deliberately
             NOT written: the rule pins the owner (a poster cannot hand their
             posting to someone else through this path), and the posting date is
             when it was first advertised, not when a typo was fixed. Status goes
             back to 'queued' so the build picks it up — including a posting that
             had been withdrawn, which is how a correction un-withdraws one. */
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
          /* The confirmation is written for a NEW posting — a reference to keep,
             a copy e-mailed, "post another". None of that is true of a
             correction, so say what actually happened instead. */
          if (EDIT_ID) {
            var done = $('oa-done');
            done.innerHTML =
              '<h3>Your changes have been saved.</h3>' +
              '<p>The posting is updated on the <a href="jobs.html">job postings page</a> ' +
              'at the next update, normally within an hour.</p>' +
              '<p class="oa-done-actions">' +
              '<a class="button blue" href="jobs.html">Back to the job postings</a></p>';
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
              ? 'You are not allowed to change this posting.'
              : 'The site is not accepting postings yet — its database rules have not been ' +
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

  /* ------------------------------------------------------ the shared vocabulary

     The three name fields offer what the site has already published, so the
     same school arrives spelled the same way each time. The list is
     data/vocab.json, rebuilt from the postings by every writer of jobs.json —
     so a name a poster adds today is offered to the next poster, with nobody
     maintaining a list.

     Entirely optional: if the fetch fails the fields stay ordinary text
     inputs and the form works exactly as it did.                            */

  function wireVocab() {
    var inst = $('f-institution'), school = $('f-school'), unit = $('f-unit');
    var dept = $('f-department'), preview = $('f-department-preview');
    if (!inst || !school || !unit) return;

    /* Keep the hidden joined field and the preview in step on every keystroke,
       so what will be published is visible before it is sent. */
    function sync() {
      var joined = [String(school.value || '').trim(), String(unit.value || '').trim()]
        .filter(Boolean).join(', ');
      if (dept) dept.value = joined;
      if (preview) {
        preview.textContent = joined
          ? 'Shown under the institution name as: ' + joined
          : '';
      }
    }
    school.addEventListener('input', sync);
    unit.addEventListener('input', sync);
    sync();

    if (!window.OACombo) return;

    var combos = {
      inst: OACombo.attach(inst, { options: [] }),
      school: OACombo.attach(school, {
        options: [], hint: 'Schools already posted at this university are listed first.' }),
      unit: OACombo.attach(unit, {
        options: [], hint: 'Departments already posted at this university are listed first.' }),
    };

    fetch('data/vocab.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (!v) return;
        combos.inst.setOptions(v.universities || []);
        combos.school.setOptions(v.schools || []);
        combos.unit.setOptions(v.units || []);

        /* Choosing a university floats that university's own schools and
           departments to the top of the other two lists. A HINT, never a
           restriction — a school can open a new department, and the form must
           not make that unpostable. */
        function prefer() {
          var e = (v.byUniversity || {})[String(inst.value || '').trim()] || { schools: [], units: [] };
          combos.school.setPreferred(e.schools || []);
          combos.unit.setPreferred(e.units || []);
        }
        inst.addEventListener('change', prefer);
        inst.addEventListener('input', prefer);
        prefer();
      })
      .catch(function () { /* the fields are plain text inputs; that is fine */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
