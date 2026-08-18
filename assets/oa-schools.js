/* ---------------------------------------------------------------------------
   Operations Academia — one spelling per university, school and department.

   ONE definition, loaded by BOTH sides, exactly like oa-countries.js:

     the browser   <script src="assets/oa-schools.js">  -> window.OASchools
     the build     createRequire(...)('.../oa-schools.js') -> module.exports

   WHY THIS EXISTS. The university, the school and the department were free
   text on the old Google Form and in the spreadsheets the archive was
   imported from, so ONE department arrived under half a dozen names. Tulane
   alone was posted as "Freeman School of Business", "Freeman School of
   Business, Management Science", "Freeman School of Business, Management
   Sciences Area", "A.B. Freeman School of Business, Management Science
   Department" and "A. B. Freeman School of Business / Management Sciecne" —
   five spellings of one place, five entries in every filter, and a reader who
   searches the archive for "tulane" cannot tell they are the same department.

   WHAT IS CANONICAL. The full, official spelling of the university and the
   school ("A. B. Freeman School of Business", "United States"-style fullness),
   and for the department the BARE NAME of the field it covers: "Management
   Science", not "Management Science Department", "Management Sciences Area"
   or "Department of Management Science". The wrapper word is how a school
   happens to organise itself — department, area, group, division, discipline —
   and it is precisely what differs between two people describing the same
   unit, so it is not part of the name we publish. The school it sits under is
   already the neighbouring field.

   canon() NEVER INVENTS. A value this file has never seen comes back cleaned
   and generically normalised but otherwise untouched, so a school that opens a
   brand new department is still postable and still published under the name
   its poster gave it.

   ADD A VARIANT HERE, NEVER BY HAND-EDITING data/. jobs.json is rebuilt from
   Firestore every morning, so a patched row comes back the next day, whereas
   an alias fixes it permanently and for every past row at the same time —
   exactly the rule oa-countries.js states for countries.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OASchools = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------ universities

     Only the ones that arrived twice. The canonical spelling is the full one,
     accents and all. */
  var INSTITUTION_ALIASES = {
    'University of California Berkeley': 'University of California, Berkeley',
    'UC Berkeley': 'University of California, Berkeley',
    'KU LEUVEN': 'KU Leuven',
    'Ozyegin University': 'Özyeğin University',
    'Ozyegin Universitesi': 'Özyeğin University',
    'NUS': 'National University of Singapore',
    'CUHK': 'The Chinese University of Hong Kong',
    'HKUST': 'The Hong Kong University of Science and Technology',
    'Penn State': 'The Pennsylvania State University',
    'Penn State University': 'The Pennsylvania State University',
    'UCLA': 'University of California, Los Angeles',
    'Institut Mines-Telecom Business School': 'Institut Mines-Télécom',
    'Institut Mines-Télécom Business School': 'Institut Mines-Télécom'
  };

  /* ---------------------------------------------------------------- schools

     The spelling each school is published under. Everything here is either a
     name that turned up in two forms or a name whose official form is fuller
     than the one that was posted. Folding (below) already merges the pure
     punctuation variants — "C.T. Bauer" and "C. T. Bauer" are one key — so
     those need only ONE entry, naming the form to keep. */
  var SCHOOL_LIST = [
    'A. B. Freeman School of Business',
    'C. T. Bauer College of Business',
    'Eli Broad College of Business',
    'Imperial College Business School',
    'Knauss School of Business',
    'Stephen M. Ross School of Business',
    'UCL Global Business School for Health',
    'UCL School of Management'
  ];

  /* A school field that names a department too, where no separator says so.
     The pair is what the row becomes. */
  var FUSED_SCHOOLS = {
    'Ross School of Business Technology and Operations':
      { school: 'Stephen M. Ross School of Business', unit: 'Technology and Operations Management' },
    'Faculty of Business-Operations Management':
      { school: 'Faculty of Business', unit: 'Operations Management' }
  };

  /* Some short forms only mean one school AT ONE UNIVERSITY: "Business
     School" is Mannheim's own name for its school and NUS's shorthand for the
     NUS Business School, so the university has to be known before they can be
     told apart. Keyed by university, then by the name as posted. */
  var SCOPED_SCHOOL_ALIASES = {
    'National University of Singapore': { 'Business School': 'NUS Business School' },
    'Özyeğin University': { 'School of Business': 'Faculty of Business' }
  };

  var SCHOOL_ALIASES = {
    'Freeman School of Business': 'A. B. Freeman School of Business',
    'AB Freeman School of Business': 'A. B. Freeman School of Business',
    'Business School for Health': 'UCL Global Business School for Health',
    'Global Business School for Health': 'UCL Global Business School for Health',
    'Imperial Business School': 'Imperial College Business School',
    'Ross School of Business': 'Stephen M. Ross School of Business',
    'Booth School': 'Booth School of Business'
  };

  /* ------------------------------------------------------------ departments

     Written as the BARE field name. The generic rules below already strip the
     wrapper words, so this table carries only what a rule cannot know:
     abbreviations, a typo, and a name whose fuller form is the one to keep. */
  var UNIT_ALIASES = {
    'Management Sciecne': 'Management Science',
    'Management Sciences': 'Management Science',
    'Technology and OM': 'Technology and Operations Management',
    'Technology and Operations': 'Technology and Operations Management',
    'BA, Information and Operations': 'Analytics, Information and Operations Management',
    'Analytics, Information, and Operations Management': 'Analytics, Information and Operations Management',
    'Operations and Info Systems': 'Operations and Information Systems',
    'Operations and IT Management': 'Operations and Information Technology Management',
    'University of Houston and DISC': 'Decision and Information Sciences',
    'DISC': 'Decision and Information Sciences',
    'SCM': 'Supply Chain Management',
    'Logistics and SCM': 'Logistics and Supply Chain Management',
    'Operations and SCM': 'Operations and Supply Chain Management',
    'Strategic Management and Operations': 'Strategic Management and Operations',
    'OR and Financial Engineering': 'Operations Research and Financial Engineering',
    'Supply Chain and Analytics': 'Supply Chain Management and Analytics',
    'Supply Chain/Operations Management': 'Supply Chain and Operations Management',
    'Operations Management Division, The School of Management and Economics': 'Operations Management',
    'MS and IS': 'Management Science and Information Systems',
    'TBS Education, Information, Operations and Management Sciences': 'Information, Operations and Management Sciences'
  };

  /* A department value that says nothing — the wrapper word on its own, left
     behind by a form that asked for "Department" and was answered literally. */
  var EMPTY_UNITS = [
    'department', 'dept', 'area', 'group', 'division', 'unit', 'school', 'n a', 'na', 'none', 'tbd'
  ];

  /* Words that mark a name as naming a school rather than a department. Kept
     in step with _scraper/vocab.mjs, which splits the legacy single field. */
  var SCHOOL_WORDS = ['school', 'college', 'faculty', 'academy'];

  /* --------------------------------------------------------------- helpers */

  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }

  function clean(v) {
    return String(v == null ? '' : v)
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:./|\-–—]+|[\s,;:./|\-–—]+$/g, '');
  }

  function hasSchoolWord(v) {
    var f = ' ' + fold(v) + ' ';
    for (var i = 0; i < SCHOOL_WORDS.length; i++) {
      if (f.indexOf(' ' + SCHOOL_WORDS[i] + ' ') !== -1) return true;
    }
    return false;
  }

  /** Spelling a value is written in before anything is looked up: "&" is
      "and", "Dept." is "Department", and the odd stray abbreviation is spelt
      out. Nothing here changes WHICH place is named. */
  function spell(v) {
    return clean(String(v == null ? '' : v)
      .replace(/\s+&\s+/g, ' and ')   /* " & " joins names; "A&M" is one */
      .replace(/\bDept\.?\b/gi, 'Department')
      .replace(/\bInfo\b\.?/g, 'Information')
      .replace(/\bMgmt\.?\b/gi, 'Management')
      .replace(/\bOps\.?\b/gi, 'Operations')
      .replace(/\s+/g, ' '));
  }

  /** The trailing "(IEOR)"-style acronym a name carries for short. It is not
      part of the name and it is exactly what one poster writes and the next
      leaves out, so it goes. A parenthetical that is not an acronym — real
      words — is left alone. */
  function dropAcronym(v) {
    return clean(String(v).replace(/\s*\(([A-Z][A-Za-z0-9&./ -]{0,20})\)\s*$/, function (all, inner) {
      return /^[A-Z0-9&./ -]+$/.test(inner) ? '' : all;
    }));
  }

  var LEADING_UNIT = /^(the\s+)?(department|dept|division|discipline|area|group|office|programme|program)\s+(of|for|in)\s+/i;
  var TRAILING_UNIT = /\s+(departments?|dept|divisions?|disciplines?|areas?|groups?|units?|programmes?|programs?)$/i;

  /** "Department of Operations Management", "Operations Management Area" and
      "The Operations Management group" are one department under three house
      styles, so the wrapper comes off and the field name is what is kept. It
      is applied repeatedly, because both ends can carry one. */
  function stripWrapper(v) {
    var s = clean(v), prev = null;
    while (s && s !== prev) {
      prev = s;
      s = clean(s.replace(LEADING_UNIT, ''));
      s = clean(s.replace(TRAILING_UNIT, ''));
      /* "The Department of X" is a wrapper; "The research group of Prof. X"
         is the name itself, so only a leading The before a NAME comes off. */
      s = clean(s.replace(/^The\s+(?=[A-Z0-9])/, ''));
    }
    return s;
  }

  /* fold(name) -> the name we publish, for every canonical name and alias. */
  function tableOf(list, aliases) {
    var by = {}, i;
    for (i = 0; i < list.length; i++) by[fold(list[i])] = list[i];
    for (var a in aliases) {
      if (Object.prototype.hasOwnProperty.call(aliases, a)) by[fold(a)] = aliases[a];
    }
    for (var k in aliases) {
      if (Object.prototype.hasOwnProperty.call(aliases, k)) by[fold(aliases[k])] = aliases[k];
    }
    return by;
  }

  var BY_INSTITUTION = tableOf([], INSTITUTION_ALIASES);
  var BY_SCOPED_SCHOOL = {};
  for (var uni in SCOPED_SCHOOL_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(SCOPED_SCHOOL_ALIASES, uni)) continue;
    BY_SCOPED_SCHOOL[fold(uni)] = tableOf([], SCOPED_SCHOOL_ALIASES[uni]);
  }
  var BY_SCHOOL = tableOf(SCHOOL_LIST, SCHOOL_ALIASES);
  var BY_UNIT = tableOf([], UNIT_ALIASES);

  /* ------------------------------------------------------------- the canons */

  /** The one name this university is published under. */
  function canonInstitution(v) {
    var s = spell(v);
    if (!s) return '';
    return BY_INSTITUTION[fold(s)] || s;
  }

  /** The one name this school is published under. The university is optional
      and is consulted first, for the short forms that mean different schools
      at different universities. */
  function canonSchool(v, institution) {
    var s = spell(v);
    if (!s) return '';

    var scoped = institution ? BY_SCOPED_SCHOOL[fold(canonInstitution(institution))] : null;
    if (scoped && scoped[fold(s)]) return scoped[fold(s)];

    var hit = BY_SCHOOL[fold(s)];
    if (hit) return hit;

    var bare = clean(s.replace(/^the\s+/i, ''));
    hit = BY_SCHOOL[fold(bare)];
    if (hit) return hit;

    return bare || s;
  }

  /** The one name this department is published under. */
  function canonUnit(v) {
    var s = spell(v);
    if (!s) return '';

    var hit = BY_UNIT[fold(s)];
    if (hit) return canonUnitCore(hit);

    return canonUnitCore(s);
  }

  /** The wrapper-free field name, alias table consulted again once the
      wrapper is off ("Department of Operations and Info Systems" reaches
      "Operations and Info Systems" only after stripping). */
  function canonUnitCore(v) {
    var s = dropAcronym(stripWrapper(v));
    if (!s || EMPTY_UNITS.indexOf(fold(s)) !== -1) return '';
    var hit = BY_UNIT[fold(s)];
    if (hit && fold(hit) !== fold(s)) return canonUnitCore(hit);
    return hit || s;
  }

  /* ------------------------------------------------ a school naming both

     Some values name the school AND the department in one string, because the
     form that collected them had one box: "Kelley School of Business -
     Operations and Decision Technologies", "Naveen Jindal School of
     Management/Healthcare Management Area", "Department of Information and
     Operations Management (INFO) at Mays Business School". They are split so
     the department reaches the department field instead of inventing a school
     nobody else posts under.

     Only these separators, and only when exactly one side names a school:
     "Institut Mines-Télécom Business School" and "Bayes Business School,
     Faculty of Management" must both survive untouched.                      */
  var SEPARATORS = [' - ', ' – ', ' — ', ' / ', '/', ': ', ', ', '-'];

  var BY_FUSED = {};
  for (var fk in FUSED_SCHOOLS) {
    if (Object.prototype.hasOwnProperty.call(FUSED_SCHOOLS, fk)) BY_FUSED[fold(fk)] = FUSED_SCHOOLS[fk];
  }

  function splitFused(school) {
    var s = clean(school);
    if (!s) return { school: '', unit: '' };

    var fused = BY_FUSED[fold(s)];
    if (fused) return { school: fused.school, unit: fused.unit };

    /* "<department> at <school>" — the school is the tail; and its mirror,
       "<school> at <the university>", where the tail merely repeats the
       university field and is dropped rather than published twice. */
    var at = s.split(/\s+at\s+the\s+|\s+at\s+/i);
    if (at.length === 2) {
      if (hasSchoolWord(at[1]) && !hasSchoolWord(at[0])) return { school: clean(at[1]), unit: clean(at[0]) };
      if (hasSchoolWord(at[0]) && !hasSchoolWord(at[1])) return { school: clean(at[0]), unit: '' };
    }

    for (var i = 0; i < SEPARATORS.length; i++) {
      var at2 = s.indexOf(SEPARATORS[i]);
      if (at2 <= 0) continue;
      var head = clean(s.slice(0, at2));
      var tail = clean(s.slice(at2 + SEPARATORS[i].length));
      if (!head || !tail) continue;
      if (hasSchoolWord(head) && !hasSchoolWord(tail)) return { school: head, unit: tail };
    }
    return { school: s, unit: '' };
  }

  /* -------------------------------------------- a university naming all three

     The oldest rows in the archive came from a sheet with ONE column, so the
     university, the school and the department are packed into it:

       "University of Pennsylvania (The Wharton School), Operations and
        Information Management (OPIM) Department"

     Split into the three fields the form now asks for, they merge with every
     modern posting from the same place instead of standing alone in the
     filters. Applied ONLY to a row that has no school and no department of
     its own, so a row that already filled them in is never disturbed.

     The classification is deliberately timid, because a comma is also part of
     a university's own name: a segment naming a university stays with the
     university ("Baruch College, The City University of New York"), and a
     trailing segment becomes a department only when it either carries a
     wrapper word or is long enough to be a name rather than a campus —
     "University of California, Berkeley" and "The Chinese University of Hong
     Kong, Shenzhen" must survive untouched.                                  */
  var UNIVERSITY_WORDS = /universit|hochschule|\bpolytechnic\b|institute of technology/i;
  var UNIT_WORD = /\b(department|dept|division|area|group|centre|center|institute|chair|programme|program|discipline|laboratory|lab)\b/i;

  /** Commas OUTSIDE parentheses, so "(UCSD, Rady School of Management)" is one
      segment rather than two. */
  function segments(v) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i);
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(clean).filter(Boolean);
  }

  function words(v) { return fold(v).split(' ').filter(Boolean).length; }

  /** The school hiding in a university's parenthetical: "(UCLA, Anderson
      School of Management)" -> "Anderson School of Management". An acronym —
      "(CUNY)", "(CASE)" — names nothing and is left where it is. */
  function schoolInParens(seg) {
    var m = /^(.*?)\s*\(([^)]*)\)\s*(.*)$/.exec(seg);
    if (!m) return null;
    var inner = clean(m[2]);
    if (!hasSchoolWord(inner)) return null;
    var pick = segments(inner).filter(hasSchoolWord).pop();
    if (!pick) return null;
    /* Text after the bracket is the department, in the shape the sheet used
       without a comma: "Penn State University (Smeal College of Business)
       Supply Chain and Information Systems Department". */
    return { rest: clean(m[1]), school: pick, tail: clean(m[3]) };
  }

  function splitLegacyInstitution(value) {
    var whole = clean(value);
    if (!whole) return { institution: '', school: '', unit: '' };

    var segs = segments(whole);
    var inst = [], school = '', units = [];

    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];

      /* A school parenthesised inside the university's own segment:
         "Los Angeles (UCLA, Anderson School of Management)" is the campus
         AND the school, so the school is lifted out and the campus stays. */
      var paren = schoolInParens(seg);
      var lifted = false;
      if (paren && !school) {
        school = paren.school;
        seg = paren.rest;
        lifted = true;
        if (paren.tail) units.push(paren.tail);
      }

      if (!seg) continue;

      /* Everything after the school is the department — a department name
         carries commas of its own ("Supply Chain, Operations Management and
         Business Statistics"), so once the tail begins it does not end. The
         segment the school was just lifted OUT of is not the tail: what is
         left of it is still the university ("Los Angeles"). */
      if ((school && !lifted) || (units.length && !lifted)) { units.push(seg); continue; }

      if (i === 0 || lifted || UNIVERSITY_WORDS.test(seg)) { inst.push(seg); continue; }
      if (hasSchoolWord(seg)) { school = seg; continue; }
      if (UNIT_WORD.test(seg) || words(seg) >= 3) { units.push(seg); continue; }

      /* A short tail after a UNIVERSITY is its campus ("…Hong Kong,
         Shenzhen"); after anything else it is the field the post is in
         ("Indian School of Business (ISB), Operations"). */
      if (UNIVERSITY_WORDS.test(inst.join(' '))) inst.push(seg);
      else units.push(seg);
    }

    return {
      institution: clean(inst.join(', ')),
      school: clean(school),
      unit: clean(units.join(', '))
    };
  }

  /**
   * The whole posting's names at once — the only entry point an ingest needs.
   *
   * A department fused into the school field is moved across (and joined to
   * whatever the department field already said, longer form kept), then each
   * of the three is canonicalised. Pure, and safe to run twice.
   */
  function canonPlace(place) {
    var p = place || {};
    var given = { institution: clean(p.institution), school: clean(p.school), unit: clean(p.unit) };
    if (given.institution && !given.school && !given.unit) given = splitLegacyInstitution(given.institution);

    var institution = canonInstitution(given.institution);

    var fused = splitFused(spell(given.school));
    var school = canonSchool(fused.school, institution);

    var unit = canonUnit(given.unit);
    var moved = canonUnit(fused.unit);
    if (moved && !unit) unit = moved;
    else if (moved && unit && fold(moved) !== fold(unit)) {
      /* Both say something, and they are usually two halves of one name that
         a stray separator cut in two ("McCombs School of Business:
         Information" + "Risk, and Operations Management"). One inside the
         other is a repetition — keep the fuller; otherwise rejoin them. */
      if (fold(unit).indexOf(fold(moved)) !== -1) { /* unit already says it */ }
      else if (fold(moved).indexOf(fold(unit)) !== -1) unit = moved;
      else unit = canonUnit(moved + ', ' + unit);
    }

    return { institution: institution, school: school, unit: unit };
  }

  /** True when the value is already the name we publish. */
  function isCanonicalSchool(v) { return !!v && canonSchool(v) === v; }
  function isCanonicalUnit(v) { return !!v && canonUnit(v) === v; }

  return {
    INSTITUTION_ALIASES: INSTITUTION_ALIASES,
    SCHOOL_LIST: SCHOOL_LIST,
    SCHOOL_ALIASES: SCHOOL_ALIASES,
    SCOPED_SCHOOL_ALIASES: SCOPED_SCHOOL_ALIASES,
    UNIT_ALIASES: UNIT_ALIASES,
    fold: fold,
    canonInstitution: canonInstitution,
    canonSchool: canonSchool,
    canonUnit: canonUnit,
    canonPlace: canonPlace,
    splitFused: splitFused,
    splitLegacyInstitution: splitLegacyInstitution,
    isCanonicalSchool: isCanonicalSchool,
    isCanonicalUnit: isCanonicalUnit
  };
}));
