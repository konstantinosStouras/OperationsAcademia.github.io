/* ---------------------------------------------------------------------------
   Operations Academia — "Post your candidacy" form.

   The candidates twin of oa-jobform.js, which is the file to read first — the
   flow, the gating and the failure handling are the same. It writes ONE
   bounded document into the Firestore `candidateSubmissions` collection; the
   scheduled build (v2/_scraper/build-candidates.mjs) turns queued documents
   into rows in v2/data/candidates.json and commits them, and the static page
   then lazy-loads that JSON. No vendor in the path.

   WHAT IS DIFFERENT FROM JOBS, and why:

     - ONE upload: the CV has its own landing-strip slot
       (uploads/{uid}/candidates/…, see _storage.rules) and its own field
       family on the document (cvUploadPath…). The build files it into the
       season's "Candidates Files" Drive folder. (A research-summary slot
       used to sit beside it — RETIRED 2026-08-24, per the owner: candidates
       are no longer asked for one. A profile filed while the form still
       offered it keeps its rsUrl / rsUpload* fields — edits here update()
       and never mention them, so they survive — and the build still files a
       legacy rs upload; this form just never asks again.)

     - The candidate OWNS the file as well as the text. Editing offers all
       three verbs on the document: UPLOAD one (a new file replaces whatever
       the profile linked to), REPLACE it (the same control — the newest
       upload is what the build files), and REMOVE it (clear the link box, or
       the Remove button on an upload still waiting to be filed).

     - The e-mail address is private BY DEFAULT and published only on the
       candidate's own opt-in (`emailPublic`) — the disclosure the old stack
       made unconditionally is now a choice. A second, PERSONAL address
       (`personalEmail`, owner 2026-08-24) is asked of everyone and NEVER
       published: a school address dies with the affiliation, and this is how
       the maintainer can still reach a candidate years later.

   The client is never trusted with what gets published — v2/_firestore.rules
   pins `status` to 'queued' and `uid` to the caller, and the build
   re-validates every field again (candidates-model.mjs) before it reaches
   the JSON.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var MAX = {
    first: 100, last: 100, affiliation: 220, position: 160,
    institution: 160, school: 160, unit: 160,
    cvUrl: 500, webUrl: 500, email: 160, personalEmail: 160, note: 1200
  };

  // list('researchAreas', 10) in the rules: an eleventh area would be refused
  // by the database AFTER a full submit, so it is refused here with a sentence.
  // The cap covers the ticked areas and the typed ones TOGETHER — they publish
  // as one list. AREA_LEN mirrors candidates-model.mjs, where the per-item
  // bound lives (the rules language has no per-item predicate).
  var AREAS_MAX = 10;
  var AREA_LEN = 80;

  /* ------------------------------------------------- the candidate's OWN areas

     The checkbox list is a HINT, not a vocabulary (owner, 2026-08-30: areas it
     does not cover can be added by the candidate). The pipeline was built for
     this all along — freeList in candidates-model.mjs is deliberately NOT
     pickList, and the candidates page builds its Research-area facet from
     whatever values exist, so a new area simply appears — the form was the one
     place that closed the set. The box splits on commas/semicolons, bounds
     each area to the model's own AREA_LEN, and folds a typed respelling of a
     LISTED area onto the list's spelling ("supply chain management" becomes
     the tick's "Supply Chain Management", once), so one area can never publish
     twice under two cases and the filter facet never splits. */

  function areaFold(v) {
    return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function ownAreas(ticked) {
    var el = $('f-areasOther');
    if (!el) return [];
    var canon = {};                    // folded -> the checkbox list's spelling
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="researchAreas"]'),
      function (cb) { canon[areaFold(cb.value)] = cb.value; });
    var seen = {};
    (ticked || []).forEach(function (v) { seen[areaFold(v)] = true; });
    var out = [];
    String(el.value || '').split(/[,;\n]+/).forEach(function (part) {
      var v = part.replace(/\s+/g, ' ').trim().slice(0, AREA_LEN).trim();
      if (!v) return;
      var k = areaFold(v);
      if (canon[k]) v = canon[k];      // a respelling of a listed area
      if (seen[k]) return;             // already ticked, or typed twice
      seen[k] = true;
      out.push(v);
    });
    return out;
  }

  function $(id) { return document.getElementById(id); }

  function show(el, on) { if (el) el.hidden = !on; }

  function say(msg, kind) {
    var m = $('oa-msg');
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /* The job market year rule, same as oa-jobform.js (and jobs-model.mjs
     MARKET_ROLL_MONTH): named for the calendar year it ENDS in, rolling on
     1 JULY in UTC. The previous year is offered too — a candidate filing in
     September for the market already running is the common case. */
  function jobMarketYears() {
    var now = new Date();
    var base = now.getUTCFullYear() + (now.getUTCMonth() >= 6 ? 1 : 0);
    return { list: [base - 1, base, base + 1], current: base };
  }

  /* ------------------------------------------------------- the market year

     ASKED OF NOBODY (owner, 2026-08-17). "Job market year" was a required
     dropdown whose answer is a function of the calendar — the academic year
     2025-2026 is "2026" — so it was a question the site could always answer
     itself, and posters read it as being about the candidate rather than about
     the date. It is derived here and merely STATED on the form.

     A NEW profile takes the season under way. An EDIT keeps the season it was
     filed in: a correction is not a re-filing, the same reasoning that leaves
     `createdAt` alone. That also closes a quiet bug in the old form — the
     dropdown reloaded at its DEFAULT when an older profile was opened for
     editing, so fixing a typo silently moved it into the current market.

     The value is not decoration: the jobs page shows the market under way
     (inCurrentMarket in _scraper/jobs-model.mjs) and _firestore.rules requires
     `year` to be an int in 2000-2100. */
  var EDIT_YEAR = 0;

  function postingYear() {
    return (EDIT_ID && EDIT_YEAR) || jobMarketYears().current;
  }

  function paintYearNote() {
    var el = $('oa-year-note');
    if (!el) return;
    var y = postingYear();
    el.textContent = (EDIT_ID ? 'Listed under the ' : 'Will be listed under the ') +
      (y - 1) + '\u2013' + y + ' job market \u2014 worked out from the date, ' +
      'so there is nothing to choose.';
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
     anchored at BOTH ends — see the note in oa-jobform.js on why unanchored
     matching silently lost links. null = present but invalid. */
  function httpUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(v)) return null;
    return v;
  }

  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  /* ---------------------------------------------- the affiliation, in three

     The one free-text "Current affiliation" box became the SAME three name
     questions the job form asks (owner, 2026-08-24) — university, school,
     department — put through the same canonColumns() so a candidate at
     "Kellogg School of Management" and one at "Kellogg" land on one spelling.
     What PUBLISHES is still one `affiliation` line, joined smallest-first
     ("Operations, Kellogg School of Management, Northwestern University" —
     the shape the site's own data has always used, "Wharton, University of
     Pennsylvania"), so the cards, the alert matcher, the admin panel and the
     universities page's deep links all read exactly as before. */

  function placeParts() {
    var raw = {
      institution: String(($('f-institution') || {}).value || '').trim().slice(0, MAX.institution),
      school: String(($('f-school') || {}).value || '').trim().slice(0, MAX.school),
      unit: String(($('f-unit') || {}).value || '').trim().slice(0, MAX.unit),
    };
    var S = window.OASchools;
    var place = (S && S.canonColumns ? S.canonColumns : function (v) { return v; })(raw);
    if (window.OAPlacePicker && OAPlacePicker.fixedPlace) {
      place = OAPlacePicker.fixedPlace(place);
    }
    return place;
  }

  function joinAffiliation(place) {
    return [place.unit, place.school, place.institution]
      .filter(Boolean).join(', ').slice(0, MAX.affiliation);
  }

  function paintAffiliationPreview() {
    var el = $('f-affiliation-preview');
    if (!el) return;
    var line = joinAffiliation(placeParts());
    el.textContent = line ? 'Your affiliation will read: ' + line : '';
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

    need('f-first', 'first', 'your first name');
    need('f-last', 'last', 'your last name');
    need('f-institution', 'institution', 'the university you are at');

    var place = placeParts();
    out.institution = place.institution;
    out.school = place.school;
    out.unit = place.unit;
    // derived, never typed: the one line every consumer of the profile reads
    out.affiliation = joinAffiliation(place);

    var position = $('f-position');
    setError(position, position.value ? '' : 'Please choose your current position.');
    if (!position.value && !firstBad) firstBad = position;
    out.position = position.value;

    var email = $('f-email');
    var ev = String(email.value || '').trim();
    var emailOk = EMAIL_RE.test(ev);
    setError(email, emailOk ? '' : 'Please give an e-mail address we can reach you at.');
    if (!emailOk && !firstBad) firstBad = email;
    out.email = ev.slice(0, MAX.email);
    out.emailPublic = !!$('f-emailPublic').checked;

    /* The PERSONAL address (owner, 2026-08-24): asked of everyone, so the
       maintainer can still reach a candidate after their school address dies
       with the affiliation. NEVER published — it is not in candidates-model's
       CANDIDATE_PUBLIC_FIELDS, so it can never reach data/candidates.json. */
    var pemail = $('f-personalEmail');
    var pev = String(pemail.value || '').trim();
    var pemailOk = EMAIL_RE.test(pev);
    setError(pemail, pemailOk ? ''
      : 'Please give a personal e-mail address — one that stays with you after you graduate.');
    if (!pemailOk && !firstBad) firstBad = pemail;
    out.personalEmail = pev.slice(0, MAX.personalEmail);

    var tickedAreas = checked('researchAreas');
    out.researchAreas = tickedAreas.concat(ownAreas(tickedAreas));
    if (out.researchAreas.length > AREAS_MAX) {
      setError($('f-areas'), 'Please keep to at most ' + AREAS_MAX +
        ' research areas — ticked and your own together.');
      if (!firstBad) firstBad = $('f-areas');
    } else {
      setError($('f-areas'), '');
    }

    out.informsDays = checked('informsDays');

    var urlFields = [['f-cvUrl', 'cvUrl'], ['f-webUrl', 'webUrl']];
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

    out.year = postingYear();
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

  /* A human-quotable reference, the jobs form's shape with its own prefix:
     OA-CAND-YYMMDD-XXXX. Generated on the page so it can be shown at once. */
  function makeRef() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
    var rnd = '';
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 4; i++) rnd += alphabet[buf[i] % alphabet.length];
    return 'OA-CAND-' + stamp + '-' + rnd;
  }

  /* ------------------------------------------------------- the two uploads

     Same landing-strip pattern as the job advert (see oa-jobform.js): the
     browser cannot write into the operations.academia@gmail.com Drive, so a
     file goes to Firebase Storage (uploads/{uid}/candidates/…, _storage.rules)
     and the scheduled build moves it into the season's "Candidates Files"
     folder, writes the Drive link onto the profile, and deletes the object.

     Each of the two documents is a SLOT with the same wiring, so the file
     rules live in one place instead of two drifting copies. PDF and Word
     only, 15 MB — mirrored from the Storage rules so a wrong file is refused
     HERE, with a sentence, rather than by the rules after a full upload.    */

  var FILE_TYPES = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
  };
  var FILE_MAX_BYTES = 15 * 1024 * 1024;

  function fileProblem(f, what) {
    if (!f) return '';
    var named = /\.(pdf|docx?)$/i.test(f.name || '');
    if (!FILE_TYPES[f.type] && !named) {
      return 'Please attach a PDF or Word file (.pdf, .doc or .docx).';
    }
    if (f.size > FILE_MAX_BYTES) {
      return 'That file is ' + (f.size / 1048576).toFixed(1) +
        ' MB; the limit is 15 MB. A ' + what + ' rarely needs more than one or two.';
    }
    if (!f.size) return 'That file is empty.';
    return '';
  }

  /**
   * One upload slot — the CV, today; the machinery stays generic because it
   * once served two (the retired research summary) and may again.
   * `prefix` names the element family (f-<prefix>File…, f-<prefix>Url) and
   * the document field family (<prefix>UploadPath…, <prefix>Url).
   */
  function makeSlot(prefix, what) {
    var slot = {
      prefix: prefix,
      what: what,
      file: null,           // the File chosen this visit, not yet uploaded
      pending: false,       // the stored doc carries an upload not yet filed
      pendingName: '',      // …and what it was called, for the row
      removePending: false  // the poster pressed Remove on that pending upload
    };

    var input = $('f-' + prefix + 'File'), name = $('f-' + prefix + 'File-name'),
        clear = $('f-' + prefix + 'File-clear'), err = $('f-' + prefix + 'File-error'),
        urlEl = $('f-' + prefix + 'Url');

    function sayFile(msg) {
      if (!err) return;
      err.hidden = !msg;
      err.textContent = msg || '';
    }

    function paint() {
      if (slot.file) {
        name.textContent = slot.file.name + ' (' + (slot.file.size / 1048576).toFixed(1) + ' MB)';
        clear.hidden = false;
      } else if (slot.pending) {
        name.textContent = (slot.pendingName || 'your uploaded file') +
          ' — uploaded, waiting to be filed';
        clear.hidden = false;
      } else {
        name.textContent = 'No file chosen';
        clear.hidden = true;
      }
      if (urlEl) {
        // one document per slot: a chosen file supersedes a pasted link, and
        // saying so beats silently ignoring one of them
        urlEl.disabled = !!slot.file;
        urlEl.placeholder = slot.file
          ? 'the uploaded file will be the ' + what + ' link'
          : 'https://';
        if (slot.file) urlEl.value = '';
      }
    }

    if (input) {
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        var bad = fileProblem(f, what);
        if (bad) {
          input.value = '';
          slot.file = null;
          sayFile(bad);
          paint();               // a pending upload survives a refused pick
          return;
        }
        slot.file = f || null;
        sayFile('');
        paint();
      });

      clear.addEventListener('click', function () {
        /* Two meanings, told apart by state: while a fresh file is chosen,
           Remove un-chooses it — and an upload from a previous visit that it
           would have replaced is back on the profile, untouched. With no
           fresh file, on a pending upload, Remove IS the remove verb: the
           saved profile loses that upload when the edit is saved. */
        if (slot.file) {
          slot.file = null;
          input.value = '';
        } else if (slot.pending) {
          slot.pending = false;
          slot.removePending = true;
        }
        sayFile('');
        paint();
      });
    }

    /** Show an upload stored on the document but not yet filed into Drive —
        the state an edit lands in when it beats the next build. */
    slot.showPending = function (storedName) {
      slot.pending = true;
      slot.pendingName = String(storedName || '');
      slot.removePending = false;
      paint();
    };

    /** Upload the chosen file to the landing strip. Resolves with the
        document fields, or null when there is nothing to upload. */
    slot.upload = function (user, onProgress) {
      if (!slot.file) return Promise.resolve(null);

      return OAFB.readyStorage().then(function (fb) {
        var clean = String(slot.file.name || what)
          .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || prefix;
        var path = 'uploads/' + user.uid + '/candidates/' + Date.now() + '-' + clean;

        return new Promise(function (resolve, reject) {
          var task = fb.storage().ref(path).put(slot.file, {
            contentType: FILE_TYPES[slot.file.type] ? slot.file.type : 'application/pdf'
          });
          task.on('state_changed', function (snap) {
            if (onProgress && snap.totalBytes) {
              onProgress(Math.round(100 * snap.bytesTransferred / snap.totalBytes));
            }
          }, reject, function () {
            resolve({
              path: path,
              name: String(slot.file.name || '').slice(0, 200),
              type: String(slot.file.type || '').slice(0, 100),
              size: slot.file.size
            });
          });
        });
      });
    };

    /** Fold this slot's outcome into the submission document.
        - a new upload REPLACES: the upload fields are written and the link is
          blanked, so the build files the newest file and writes its Drive
          link (an upload the same edit orphaned in Storage is left for the
          maintainer's read/delete rule — the same trade oa-jobform makes);
        - Remove on a pending upload clears the four fields ('' rather than a
          delete: the update rule checks `is string` on any present field, and
          Firestore stores a null as a value, not an absence);
        - otherwise nothing is written, so an untouched pending upload
          survives an unrelated edit (update() merges). */
    slot.applyTo = function (doc, uploaded) {
      if (uploaded) {
        doc[prefix + 'UploadPath'] = uploaded.path;
        doc[prefix + 'UploadName'] = uploaded.name;
        doc[prefix + 'UploadType'] = uploaded.type;
        doc[prefix + 'UploadSize'] = uploaded.size;
        // The build replaces this with the Drive link when it files the
        // upload; until then the profile simply has no such link.
        doc[prefix + 'Url'] = '';
      } else if (slot.removePending) {
        doc[prefix + 'UploadPath'] = '';
        doc[prefix + 'UploadName'] = '';
        doc[prefix + 'UploadType'] = '';
        doc[prefix + 'UploadSize'] = 0;
      }
    };

    return slot;
  }

  var cvSlot;

  /* ------------------------------------------------------------ edit mode

     `?edit=<document id>` turns this page from "post your candidacy" into
     "edit your profile". The id comes from the Edit button on a candidates
     card (oa-candidateedit.js), and is only useful to someone the rules let
     read that document — an ordinary visitor pasting one gets a permission
     error rather than a form full of somebody else's profile.              */

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
        $('oa-cand-form').querySelectorAll('input[name="' + name + '"]'),
        function (cb) { cb.checked = !!want[cb.value]; });
    }

    set('f-first', v.first);
    set('f-last', v.last);
    /* the three name fields; a profile from before the split carries only the
       joined `affiliation`, which canonPlace() takes apart where it can (the
       fused legacy shape it exists for) and otherwise leaves whole in the
       university box for the candidate to redistribute */
    if (v.institution || v.school || v.unit) {
      set('f-institution', v.institution);
      set('f-school', v.school);
      set('f-unit', v.unit);
    } else if (v.affiliation) {
      /* A legacy one-line affiliation is joined SMALLEST FIRST
         ("Operations, Kellogg School of Management, Northwestern University"
         — joinAffiliation), the opposite of the archive shape canonPlace
         takes apart, which read the department as the university. Right to
         left: the last part is the university, the first the unit. */
      var parts = String(v.affiliation).split(/\s*,\s*/).filter(Boolean);
      var inst = parts.length ? parts[parts.length - 1] : '';
      var unit = parts.length > 1 ? parts[0] : '';
      var school = parts.length > 2 ? parts.slice(1, -1).join(', ') : '';
      set('f-institution', inst);
      set('f-school', school);
      set('f-unit', unit);
    }
    paintAffiliationPreview();
    set('f-position', v.position);
    EDIT_YEAR = Number(v.year) || 0;
    paintYearNote();                 // the profile's own season, never today's
    set('f-cvUrl', v.cvUrl);
    set('f-webUrl', v.webUrl);
    set('f-email', v.email || v.authEmail);
    set('f-personalEmail', v.personalEmail);
    set('f-note', v.note);

    ticks('researchAreas', v.researchAreas);
    /* Areas the checkbox list does not offer go back into the own-areas box.
       Without this an edit would silently DROP them: collect() reads only
       what is on the form, so a custom area with nowhere to land would leave
       the document at the very next save. Matched EXACTLY, not folded — a
       stored value differing from a tick only in case lands here too and is
       healed onto the tick's spelling by ownAreas() when the edit is saved. */
    (function () {
      var el = $('f-areasOther');
      if (!el) return;
      var listed = {};
      Array.prototype.forEach.call(
        $('oa-cand-form').querySelectorAll('input[name="researchAreas"]'),
        function (cb) { listed[cb.value] = true; });
      el.value = (v.researchAreas || [])
        .filter(function (x) { return x && !listed[x]; }).join(', ');
    })();
    ticks('informsDays', v.informsDays);

    var ep = $('f-emailPublic');
    if (ep) ep.checked = v.emailPublic === true;

    // an upload from a previous visit the build has not filed yet. (A legacy
    // rsUploadPath has no slot to show in any more — the build still files
    // it, and update() never touches fields this form does not write.)
    if (v.cvUploadPath) cvSlot.showPending(v.cvUploadName);

    EDIT_REF = v.ref || '';
    paintStats(v);
  }

  /* ------------------------------------------ the profile's OWN figures

     How often this profile's card was opened on the site and its CV link
     clicked — this season and in the last 7 days — read from the `stats` map
     _scraper/build-candidate-stats.mjs writes onto the candidate's own
     document once a day. The owner is the only reader the rules allow, so
     this panel is drawn in edit mode and nowhere else. Numbers only: every
     figure goes through Number() and every string through textContent.

     Before the reveal date there is nothing to count — the served file is
     empty, so no card exists to open — and the panel says exactly that
     rather than showing a zero that reads as "nobody is interested".      */

  function statsNumber(v) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /** Opens and CV clicks over the last `n` UTC days of a `days` map
      ({ 'YYYY-MM-DD': [opens, cv] }), today included. */
  function statsLastDays(days, n, now) {
    var out = [0, 0];
    if (!days || typeof days !== 'object') return out;
    var cutoff = new Date((now || new Date()).getTime() - (n - 1) * 86400000)
      .toISOString().slice(0, 10);
    Object.keys(days).forEach(function (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) return;
      var cell = days[day];
      if (!Array.isArray(cell)) return;
      out[0] += statsNumber(cell[0]);
      out[1] += statsNumber(cell[1]);
    });
    return out;
  }

  function times(n) { return n + (n === 1 ? ' time' : ' times'); }

  function paintStats(v) {
    var box = $('oa-cand-stats');
    if (!box || !EDIT_ID) return;

    function line(text, strong) {
      var p = document.createElement('p');
      if (strong) {
        var b = document.createElement('strong');
        b.textContent = strong;
        p.appendChild(b);
        p.appendChild(document.createTextNode(' '));
      }
      p.appendChild(document.createTextNode(text));
      return p;
    }

    /* the reveal date, from the same file the candidates page announces it
       from; unreadable = treat the profile as not yet public, the safe reading */
    fetch('data/candidates-reveal.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (cfg) {
        var revealAt = /^\d{4}-\d{2}-\d{2}$/.test(String((cfg || {}).revealAt || ''))
          ? String(cfg.revealAt) : '';
        var today = new Date().toISOString().slice(0, 10);
        var held = !revealAt || today < revealAt;
        var st = v && v.stats && typeof v.stats === 'object' ? v.stats : null;

        box.innerHTML = '';
        box.appendChild(line('These figures are private: only you can see them.',
          'Your profile on the site.'));

        if (held && !st) {
          box.appendChild(line(revealAt
            ? 'Your profile is not public yet. Profiles appear on the candidates page all ' +
              'at once on ' + revealAt + ', so there is nothing to count until then.'
            : 'Your profile is not public yet. Profiles appear on the candidates page all ' +
              'at once on the reveal date, so there is nothing to count until then.'));
        } else if (!st) {
          box.appendChild(line('No figures yet. The count is updated once a day and starts ' +
            'on the first day your profile is shown.'));
        } else {
          var opens = statsNumber(st.opens);
          var cvs = statsNumber(st.cvClicks);
          var week = statsLastDays(st.days, 7);
          box.appendChild(line('Opened ' + times(opens) + ' this season, ' +
            times(week[0]) + ' in the last 7 days.'));
          box.appendChild(line('CV opened ' + times(cvs) + ' this season, ' +
            times(week[1]) + ' in the last 7 days.'));
          var upd = String(st.updatedAt || '').slice(0, 10);
          box.appendChild(line((/^\d{4}-\d{2}-\d{2}$/.test(upd)
            ? 'Updated ' + upd + '. ' : '') +
            'The count is updated once a day. Your own visits, and those of the ' +
            'site maintainer, are not counted.'));
        }
        box.hidden = false;
      });
  }

  function enterEditMode() {
    if (!EDIT_ID) return;

    document.title = 'Edit your profile — Operations Academia';
    // the page heading, in whichever design is serving this page: the live
    // site heads a page with .v3-pa-hero .v3-h1, the /v2/ archive with
    // .title-heading h2. Renaming neither would leave the form claiming to
    // post something new while it is editing one that exists.
    var h = document.querySelector('.v3-pa-hero .v3-h1') ||
      document.querySelector('.title-heading h2');
    if (h) h.textContent = 'Edit your profile';

    var submit = $('oa-submit');
    if (submit) submit.textContent = 'Save changes';

    var intro = $('oa-intro');
    if (intro) {
      intro.innerHTML = '<p><strong>You are editing your profile.</strong> Once this ' +
        'season\'s profiles have been revealed, your changes appear on the ' +
        '<a href="candidates.html">candidates page</a> at the next update, normally ' +
        'within an hour; until the reveal date your profile stays private and is ' +
        'published with everyone else\'s on the day. The posting date does not change.</p>';
    }

    /* The three file verbs, said where the reader is looking: the same widget
       uploads, replaces and removes, and in edit mode the hint has to say so
       — a returning candidate's question is "how do I change my CV", not
       "how do I attach one". */
    var cvHint = $('f-cvFile-hint');
    if (cvHint) {
      cvHint.innerHTML = 'Your current <em>CV</em> link is in the box below. Upload a ' +
        'new file or paste a different link to <strong>replace</strong> it — or ' +
        'clear the box (and press Remove on any file waiting to be filed) to ' +
        '<strong>remove</strong> the CV from your profile.';
    }

    show($('oa-takedown'), true);

    OAAccounts.whenSignedIn(function () {
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(col()).doc(EDIT_ID).get();
      }).then(function (snap) {
        if (!snap.exists) {
          say('That profile no longer exists.', 'err');
          show($('oa-cand-form'), false);
          return;
        }
        fill(snap.data() || {});
      }).catch(function (err) {
        say(err && err.code === 'permission-denied'
          ? 'You are not allowed to edit this profile.'
          : 'We could not load that profile. Please try again.', 'err');
        show($('oa-cand-form'), false);
        if (window.console) console.error('edit:', err);
      });
    });
  }

  function col() {
    // candidateSubmissions is not in OAFB.col yet; the fallback keeps this
    // file working either way, the same pattern as oa-candidateedit.js.
    return (window.OAFB && OAFB.col && OAFB.col.candidateSubmissions) || 'candidateSubmissions';
  }

  /* -------------------------------------------------------------- take down

     The DELETE verb, on the page where the profile is edited (the candidates
     list has one too — oa-candidateedit.js). A status change to 'withdrawn',
     never a document delete: build-candidates deliberately preserves a row
     whose document merely vanished, so deleting would look like it had worked
     and change nothing. Editing later re-queues, which un-withdraws.        */

  function wireTakeDown() {
    var btn = $('oa-takedown');
    if (!btn || !EDIT_ID) return;

    btn.addEventListener('click', function () {
      if (!window.confirm(
        'Take your profile down?\n\n' +
        'It stops appearing on the candidates page at the next update, normally ' +
        'within an hour (or is left out of the reveal, if that is still to come). ' +
        'Nothing is deleted — you can put it back at any time by editing it again.')) return;

      btn.disabled = true;
      say('Taking your profile down…');

      OAAccounts.whenSignedIn(function () {
        OAFB.ready().then(function (fb) {
          return fb.firestore().collection(col()).doc(EDIT_ID).update({
            /* WHO took it down. 'hidden' is the maintainer, 'withdrawn' is
               the owner — the card buttons have always drawn that distinction
               (oa-candidateedit.js), and the build reads it: a withdrawal is
               stamped 'removed' once applied, while 'hidden' STAYS hidden and
               is re-applied on every run. Recorded as 'withdrawn' here, a
               maintainer's take-down was un-done the moment the owner's next
               edit re-queued the document — and nothing said who had done
               either. */
            status: OAAccounts.isAdmin() ? 'hidden' : 'withdrawn',
            updatedAt: new Date().toISOString()
          });
        }).then(function () {
          var done = $('oa-done');
          done.innerHTML =
            '<h3>Your profile has been taken down.</h3>' +
            '<p>It disappears from the <a href="candidates.html">candidates page</a> ' +
            'at the next update, normally within an hour, or is left out of the reveal ' +
            'if that is still to come. Nothing is deleted: to put it back, sign in and ' +
            'edit it again — saving re-publishes it.</p>' +
            '<p class="oa-done-actions">' +
            '<a class="button blue" href="candidates.html">Back to the candidates</a></p>';
          show($('oa-cand-form'), false);
          show($('oa-intro'), false);
          show(done, true);
          done.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }).catch(function (err) {
          btn.disabled = false;
          say(err && err.code === 'permission-denied'
            ? 'You are not allowed to change this profile.'
            : 'We could not take it down. Please try again.', 'err');
          if (window.console) console.error('take down:', err);
        });
      });
    });
  }

  /* ------------------------------------------------------------------- boot */


  /* ------------------------------------------------------ the shared cascade

     The candidate's affiliation is the SAME three name questions the job form
     asks (owner, 2026-08-24 — it used to be one free-text box), so it mounts
     the SAME shared cascade, assets/oa-place-picker.js: choosing the
     university narrows the school list, choosing the school narrows the
     department list, and each name is put into the spelling the site
     publishes as the field is left. A hint, never a restriction, and entirely
     optional — without the module the three fields are plain text inputs and
     the form works exactly as before. */

  function wireVocab() {
    var inst = $('f-institution'), school = $('f-school'), unit = $('f-unit');
    if (!inst || !school || !unit) return;

    [inst, school, unit].forEach(function (el) {
      el.addEventListener('input', paintAffiliationPreview);
      el.addEventListener('change', paintAffiliationPreview);
    });
    paintAffiliationPreview();

    if (window.OAPlacePicker) {
      /* onChange so the preview follows a value the cascade fills in or
         re-spells, which a keystroke listener alone would never see */
      OAPlacePicker.wire(
        { institution: inst, school: school, unit: unit },
        { onChange: paintAffiliationPreview });
    }
  }

  function boot() {
    cvSlot = makeSlot('cv', 'CV');
    enterEditMode();
    wireTakeDown();
    paintYearNote();
    wireVocab();

    var sent = false;                 // latched once the profile has been written
    var form = $('oa-cand-form');
    var offline = $('oa-offline');
    var needauth = $('oa-needauth');

    if (!window.OAFB || !OAFB.enabled) {
      show(offline, true);
      show($('oa-intro'), false);
      return;
    }

    $('oa-needauth-btn').addEventListener('click', function () { OAAccounts.openAuth(); });
    $('oa-needauth-new').addEventListener('click', function () { OAAccounts.openAuth('register'); });

    /* Clear a field's error as soon as the reader acts on it — see the note
       in oa-jobform.js. */
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
      // the areas-count error hangs on the GROUP (#f-areas), so typing in the
      // own-areas box would never clear it through the aria-invalid path above
      if (e.target.id === 'f-areasOther') setError($('f-areas'), '');
    }, true);
    form.addEventListener('change', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
      if (e.target.name === 'researchAreas') setError($('f-areas'), '');
    }, true);

    /* Say what has happened rather than offering a control that cannot work —
       the same stand-down as oa-jobform.js: the SDK comes from gstatic, which
       an ad blocker or a national firewall can refuse, and the gate would
       otherwise invite a sign-in that can never answer. The gate stays on
       screen, DISABLED: an explained, inert version of the normal page. */
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

    /* ONE PROFILE PER CANDIDATE PER MARKET YEAR (owner, 2026-08-24). An
       account that already filed a profile for the season under way is sent
       to EDIT that profile, never offered a blank form that would create a
       second one. Enforced here by redirect, and healed at build time by
       collapseSameCandidate's account pass (candidates-model.mjs), so a race
       or an offline import cannot put two cards up for one account either.
       Checked once per page load; a failure to check is not fatal — the
       build's collapse is the backstop. */
    var oneProfileChecked = false;
    /* How many profiles this account holds, ALL seasons, from the check's
       own query — null until it has answered. It is what the account menu's
       "My candidate profile" row is drawn from (OAAccounts.setCount('cands'),
       the exact-where-the-data-is-loaded rule oa-myjobs.js follows for
       postings), and what a successful CREATE adds one to. */
    var ownProfiles = null;
    function redirectToOwnProfile(user) {
      if (EDIT_ID || sent || oneProfileChecked || !user) return;
      oneProfileChecked = true;

      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(col()).where('uid', '==', user.uid).get();
      }).then(function (snap) {
        if (sent) return;
        ownProfiles = snap.size;
        if (window.OAAccounts && OAAccounts.setCount) OAAccounts.setCount('cands', snap.size);
        var season = jobMarketYears().current;
        var found = '', foundAt = '';
        snap.forEach(function (d) {
          var v = d.data() || {};
          if (Number(v.year) !== season) return;
          // several (a pre-rule duplicate): open the newest, the one the
          // build's collapse keeps
          var at = v.createdAt && v.createdAt.toDate
            ? v.createdAt.toDate().toISOString() : String(v.createdAt || '');
          if (!found || at >= foundAt) { found = d.id; foundAt = at; }
        });
        if (!found) return;
        say('You already have a profile for the ' + (season - 1) + '–' + season +
            ' job market — opening it for editing. One profile per market year.');
        location.replace('post-a-candidate.html?edit=' + encodeURIComponent(found));
      }).catch(function (err) {
        if (window.console) console.warn('one-profile check:', err);
      });
    }

    OAAccounts.onChange(function (user) {
      // The profile has already been sent — a later auth event must not put
      // the form back over the confirmation. See oa-jobform.js.
      if (sent) return;

      redirectToOwnProfile(user);

      if (OAAccounts.failed && OAAccounts.failed()) {
        standDown('<strong>We cannot reach the posting service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload. ' +
          'Otherwise please send your profile to ' +
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
      var verb = EDIT_ID ? 'Saving… ' : 'Sending… ';
      say(EDIT_ID ? 'Saving…' : 'Sending…');

      OAAccounts.whenSignedIn(function (user) {
        /* The file first, then the document that references it — the reverse
           order could publish a profile pointing at an upload that failed. */
        cvSlot.upload(user, function (pct) {
          say(verb + 'uploading your CV (' + pct + '%)');
        }).then(function (cvUp) {
          cvSlot.applyTo(doc, cvUp);
          return OAFB.ready();
        }).then(function (fb) {
          var c = fb.firestore().collection(col());

          /* EDITING an existing profile. `uid` and `createdAt` are
             deliberately NOT written: the rule pins the owner, and the
             posting date is when the profile first went up, not when a typo
             was fixed. Status goes back to 'queued' so the build picks it up
             — including a profile that had been withdrawn, which is how a
             later edit un-withdraws one. */
          if (EDIT_ID) {
            doc.status = 'queued';
            doc.updatedAt = new Date().toISOString();
            delete doc.uid;
            return c.doc(EDIT_ID).update(doc).then(function () { return EDIT_REF; });
          }

          doc.ref = makeRef();
          doc.uid = user.uid;
          doc.authEmail = user.email || '';
          doc.status = 'queued';       // the rules pin this; the build publishes it
          doc.source = 'oa-form';
          doc.createdAt = fb.firestore.FieldValue.serverTimestamp();
          return c.add(doc).then(function () { return doc.ref; });
        }).then(function (ref) {
          sent = true;
          /* A NEW profile is one more than the account held: the menu's
             "My candidate profile" row appears from this moment, not from
             the next session's refresh. An edit changes nothing here (the
             profile already counted), and neither does a take-down — a
             withdrawn profile still exists and is its owner's to restore. */
          if (!EDIT_ID && window.OAAccounts && OAAccounts.setCount) {
            OAAccounts.setCount('cands', (ownProfiles === null ? 0 : ownProfiles) + 1);
          }
          /* The confirmation is written for a NEW profile — a reference to
             keep, "post another". Neither is true of an edit, so say what
             actually happened instead. */
          if (EDIT_ID) {
            var done = $('oa-done');
            done.innerHTML =
              '<h3>Your changes have been saved.</h3>' +
              '<p>Your profile is updated on the ' +
              '<a href="candidates.html">candidates page</a> at the next update, ' +
              'normally within an hour — or, before the reveal date, goes live with ' +
              'everyone else\'s on the day, changes included.</p>' +
              '<p class="oa-done-actions">' +
              '<a class="button blue" href="candidates.html">Back to the candidates</a></p>';
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
          if (code === 'storage/unauthorized') {
            say('The file was refused — it must be a PDF or Word file under 15 MB, ' +
                'and the site’s storage rules must be published.', 'err');
          } else if (code === 'permission-denied') {
            say(EDIT_ID
              ? 'You are not allowed to change this profile.'
              : 'The site is not accepting profiles yet — its database rules have ' +
                'not been published. Please try again later, or contact us.', 'err');
          } else {
            say('We could not send your profile. Please try again in a moment.' +
                (code ? ' (' + code + ')' : ''), 'err');
          }
          if (window.console) console.error('post-a-candidate:', err);
        });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
