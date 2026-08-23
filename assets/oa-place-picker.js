/* ---------------------------------------------------------------------------
   Operations Academia — the university -> school -> department cascade.

   THREE BOXES THAT KNOW ABOUT EACH OTHER. Choosing a university narrows the
   school list to that university's schools; choosing one of those narrows the
   department list to that school's departments; a department the site has only
   ever seen in one school fills that school in above it; and each name is put
   into the spelling the site publishes as the field is left. The lists come
   from data/vocab.json, which every writer of jobs.json rebuilds from the
   postings themselves AND from the site's own Universities directory, so
   nobody curates a list.

   WHY IT IS ITS OWN FILE. All of this used to live inside oa-jobform.js's
   wireVocab(), bound to three ids on one page — and the review queue on
   feedback.html asks the maintainer exactly the same three questions about
   exactly the same three names. Copying it would have been the drift this
   repository keeps warning about in every other shared module (oa-countries.js,
   oa-schools.js, oa-news.js): two cascades, one of them quietly a version
   behind, and no test that could tell. So there is one, and both pages mount
   it.

   IT IS A HINT, NEVER A RESTRICTION. Typing searches the whole site under a
   second heading, a name nobody has posted before is still offered as a new
   one, and changing the university RE-SCOPES the lists rather than clearing
   the fields — what somebody typed is theirs. A school that opens a department
   tomorrow has to stay postable.

   ENTIRELY OPTIONAL. Without oa-combo.js the fields are plain text inputs;
   without oa-schools.js the three lists still work and simply do not narrow;
   without the fetch nothing happens at all. Nothing here may ever be the
   reason a form cannot be filled in.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  var DEFAULT_URL = 'data/vocab.json';

  /* One request per file per page, the site-wide rule — a card list mounting a
     cascade per card must not fetch the vocabulary once per card. Memoized by
     URL, and a FAILED read is not remembered, so one flaky request is not
     inherited by every later mount. `no-cache` REVALIDATES rather than
     re-downloads: Pages serves data/ with ten minutes of freshness and a
     posting approved a minute ago has to be visible. */
  var pending = Object.create(null);

  function vocabulary(url) {
    var key = url || DEFAULT_URL;
    if (!pending[key]) {
      pending[key] = fetch(key, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { delete pending[key]; return null; });
    }
    return pending[key];
  }

  /** A key -> name index over an array of names or an object's keys. */
  function index(names, key) {
    var list = Object.prototype.toString.call(names) === '[object Array]'
      ? names : Object.keys(names || {});
    var out = Object.create(null);   // never answer for Object.prototype
    for (var i = 0; i < list.length; i++) {
      var k = key(list[i]);
      if (k && !(k in out)) out[k] = list[i];
    }
    return out;
  }

  /**
   * Mount the cascade on three inputs.
   *
   *   els   { institution, school, unit } — the three <input type="text">
   *   opts  { vocabUrl, onChange, max }
   *           onChange runs after a field has been settled into its published
   *           spelling or filled in for the caller, so a form that derives
   *           anything from these three (the joined line the card shows) can
   *           keep it in step.
   *
   * Returns `{ destroy }`. A caller that re-renders its markup MUST call it:
   * see the note on OACombo's own destroy().
   */
  function wire(els, opts) {
    els = els || {};
    opts = opts || {};
    var inst = els.institution, school = els.school, unit = els.unit;
    if (!inst || !school || !unit || !window.OACombo) return null;

    var changed = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var listeners = [];
    var dead = false;

    function on(el, type, fn) {
      el.addEventListener(type, fn);
      listeners.push([el, type, fn]);
    }

    /* When two spellings are one name — the site's own rule, so a scope
       offering "Management Science" reads the count off an option list entry
       that was posted as "Management Science Department". Without the module
       the pickers still work; a variant simply looks like a second name.

       Each closes over a LIVE read of the institution field rather than its
       value at mount time: the key functions are frozen into the picker at
       attach, and the answer for a school depends on which university is named
       above it. */
    var S = window.OASchools;
    var val = function (el) { return String(el.value || '').trim(); };
    /* institutionKey, not the canon: one entry per university however the
       directory spells it, which is how the vocabulary groups them too. */
    var keyInst = S ? function (v) { return S.institutionKey(v); } : null;
    var keySchool = S ? function (v) { return S.fold(S.canonSchool(v, val(inst))); } : null;
    /* the university, here too: six schools name their own unit in a way the
       generic rule would strip ("Operations Management Area"), and without it
       the picker would group that under the bare name and show whichever
       spelling happened to arrive first. */
    var keyUnit = S ? function (v) { return S.fold(S.canonUnit(v, val(inst))); } : null;

    /* What a name the site has never seen will be published as — so the
       "not on the list yet" row offers "Widgets" where "Widgets Group" was
       typed, rather than promising a name the submission would then tidy. */
    function attach(el, more) {
      if (el.__oaCombo) return el.__oaCombo;      // attach() answers null twice
      more.options = [];
      if (opts.max) more.max = opts.max;
      return window.OACombo.attach(el, more);
    }

    var combos = {
      inst: attach(inst, { key: keyInst, publishAs: S ? S.canonInstitution : null }),
      school: attach(school, { key: keySchool,
        publishAs: S ? function (v) { return S.canonSchool(v, val(inst)); } : null }),
      unit: attach(unit, { key: keyUnit,
        publishAs: S ? function (v) { return S.canonUnit(v, val(inst)); } : null }),
    };

    vocabulary(opts.vocabUrl).then(function (v) {
      if (!v || dead) return;
      combos.inst.setOptions(v.universities || []);
      combos.school.setOptions(v.schools || []);
      combos.unit.setOptions(v.units || []);

      /* The cascade needs to know when two spellings are one place; without
         that file the three lists still work, they simply do not narrow. */
      if (!S) return;

      var byUniversity = v.byUniversity || {};
      var bySchool = v.bySchool || {};
      var uniIndex = index(byUniversity, keyInst);
      var schoolIndex = index(bySchool, keySchool);
      var uniNames = Object.keys(byUniversity);

      /** The university the institution field names, however it is spelled. */
      function chosenUniversity() {
        var name = uniIndex[keyInst(inst.value)];
        return name ? { name: name, own: byUniversity[name] || {} } : null;
      }

      /** The school the school field names, within a university. */
      function chosenSchool(uni) {
        if (!val(school)) return null;
        if (uni) {
          var own = uni.own.bySchool || {};
          var hit = index(own, keySchool)[keySchool(school.value)];
          if (hit) return { name: hit, units: own[hit] || [], here: true };
        }
        var site = schoolIndex[keySchool(school.value)];
        if (site) return { name: site, units: bySchool[site] || [], here: false };
        return null;
      }

      /* The lists under the two fields, redrawn whenever what is above them
         changes. Order matters: a school's departments are more specific
         than a university's, and a university's are better than nothing. */
      function rescope() {
        var uni = chosenUniversity();
        var schools = uni ? (uni.own.schools || []) : [];

        combos.school.setScope(schools.length ? {
          label: 'Schools at ' + uni.name,
          values: schools,
          other: 'Elsewhere on the site',
          more: 'Type to search every school the site knows.',
        } : null);

        /* A school the chosen university does not have — because the
           university is new, or spelled differently — is still worth
           offering from, but the label says so: "College of Business" is
           thirteen universities' name for thirteen different schools, and
           heading their departments as if they were this one's would be a
           claim the site cannot make. */
        var mine = chosenSchool(uni);
        var units = mine ? mine.units : (uni ? (uni.own.units || []) : []);
        var label = mine
          ? (mine.here
              ? 'Departments in ' + mine.name
              : 'Departments in ' + mine.name + ', elsewhere on the site')
          : (uni ? 'Departments at ' + uni.name : '');

        combos.unit.setScope(units.length ? {
          label: label,
          values: units,
          other: 'Elsewhere on the site',
          more: 'Type to search every department the site knows.',
        } : null);
      }

      /* The one university the typed text can only be the beginning of.
         Nothing, when it could be several — "University of" is not a name —
         and nothing under four letters, which is a keystroke rather than an
         intention. */
      function onlyUniversityStartingWith(typed) {
        var f = S.fold(typed);
        if (f.length < 4) return '';
        var hit = '', i;
        for (i = 0; i < uniNames.length; i++) {
          if (S.fold(uniNames[i]).indexOf(f) !== 0) continue;
          if (hit) return '';
          hit = uniNames[i];
        }
        return hit;
      }

      /* The names, as they will be published — the SAME canonColumns() the
         submission goes through, run as the field is left so that what is read
         back is what everybody else will read.

         canonCOLUMNS, because these are three boxes that say which name is
         which; canonPlace() is for the archive's single column and would read
         a lone university as a university and a department. */
      function snapPlace() {
        /* The published spelling first, the one university the typed text
           begins second, the canon last.

           canonInstitution() leaves a university it has no alias for exactly
           as typed, so "tulane university" would have been posted in lower
           case and offered ever after as a second Tulane. And "tulane" on
           its own — somebody who saw the one matching row and tabbed on —
           matched nothing at all: the cascade quietly went away, the school
           list opened at every school on the site, and the posting was filed
           under a university nobody else uses. */
        var typed = val(inst);
        var name = uniIndex[keyInst(typed)] ||
                   onlyUniversityStartingWith(typed) ||
                   S.canonInstitution(typed);
        if (name && name !== typed) inst.value = name;

        var place = S.canonColumns({
          institution: inst.value, school: school.value, unit: unit.value,
        });
        if (place.school !== val(school) || place.unit !== val(unit)) {
          school.value = place.school;
          unit.value = place.unit;
        }
        changed();
      }

      /* A department names its school, when the site has only ever seen it
         in one of them: choosing "Analytics and Operations" at NUS fills in
         the NUS Business School above it. Only ever fills an EMPTY field —
         somebody who named a school is never overruled. */
      function inferSchool() {
        if (!val(unit) || val(school)) return;
        var uni = chosenUniversity();
        if (!uni) return;
        var own = uni.own.bySchool || {};
        var k = keyUnit(unit.value);
        var hits = Object.keys(own).filter(function (s) {
          return s && own[s].some(function (u) { return keyUnit(u) === k; });
        });
        if (hits.length !== 1) return;
        school.value = hits[0];
        changed();
      }

      on(inst, 'input', rescope);
      on(inst, 'change', function () { snapPlace(); rescope(); });
      on(school, 'input', rescope);
      on(school, 'change', function () { snapPlace(); rescope(); });
      on(unit, 'change', function () { snapPlace(); inferSchool(); rescope(); });
      rescope();
    });

    return {
      destroy: function () {
        dead = true;
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners.length = 0;
        Object.keys(combos).forEach(function (k) {
          if (combos[k] && combos[k].destroy) combos[k].destroy();
        });
      },
    };
  }

  window.OAPlacePicker = { wire: wire, vocabulary: vocabulary, DEFAULT_URL: DEFAULT_URL };
})();
