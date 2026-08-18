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
    'Institut Mines-Télécom Business School': 'Institut Mines-Télécom',
    /* the Universities directory's own second name for it; dropAcronym will
       not touch a mixed-case "(CityU)", because that is the shape of the
       "(Shenzhen)" that marks a genuinely different campus */
    'City University of Hong Kong (CityU)': 'City University of Hong Kong',

    /* ONE UNIVERSITY, WRITTEN TWO WAYS. institutionKey folds away a trailing
       acronym and a leading "The", which is enough for most of the directory's
       second names — but not for a name whose PARTS were reordered, or where
       one spelling drops the "at". The seed of the world's operations schools
       (assets/oa-institutions.js) writes Baruch the other way round, and the
       two Illinois campuses arrived under both of their own house styles, so
       the picker offered each place twice with the postings on one row and the
       departments on the other. */
    'City University of New York, Baruch College':
      'Baruch College, The City University of New York (CUNY)',
    'University of Illinois Urbana-Champaign': 'University of Illinois at Urbana-Champaign',
    'University of Illinois Chicago': 'University of Illinois at Chicago',

    /* Owner, 2026-08-18. Two universities the source directory named with an
       aside of its own, and the spellings the site had collected beside them. */
    'Western University (Canada) / University of Western at London, Ontario': 'Western University',
    'City St George\'s, University of London': 'University of London',
    'City St. George\'s, University of London': 'University of London',
    'The University of Melbourne': 'University of Melbourne',
    'University of Texas at San Antonio': 'UT San Antonio',
    'The University of Texas at San Antonio': 'UT San Antonio'
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
      { school: 'Faculty of Business', unit: 'Operations Management' },
    /* The workbook put Houston's institute where the school goes. It is a unit
       INSIDE the Bauer college, and the posting itself is the college's
       Decision and Information Sciences department (owner, 2026-08-18) —
       so the value names both, which is what this table is for. */
    'Bauer Human-Centered AI Institute':
      { school: 'C. T. Bauer College of Business',
        unit: 'Department of Decision and Information Sciences' }
  };

  /* A value that names the UNIVERSITY AND A SCHOOL in the university's own
     box. `schoolInParens` lifts one out on its own when the bracket says
     "School", "College", "Faculty" or "Academy" — an INSTITUTE is none of
     those, and adding the word to that list would start lifting research
     institutes out of names all over the site, so the one case is curated.

     It matters because of what happens otherwise: this posting's ONLY
     department was "Artificial Intelligence (AI) and healthcare", which the
     owner has ruled is a research topic and not a department. Take it away and
     the row has no school and no department left, and a posting with neither
     is not publishable — the site would have dropped a live posting to honour
     a naming decision. The institute is what the posting is actually in. */
  var FUSED_INSTITUTIONS = {
    /* The workbook wrote the institute into the university's box and gave no
       school and no department. The owner has since named all three (the
       advertisement is for a Professor of Practice in Decision and Information
       Sciences), so the split yields the college AND the department — `unit` is
       used only where the row itself named none. */
    'University of Houston (Bauer Human-Centered AI Institute)': {
      institution: 'University of Houston',
      school: 'C. T. Bauer College of Business',
      unit: 'Department of Decision and Information Sciences',
    }
  };

  /* WHERE A DEPARTMENT SITS, when the row does not say. Some postings arrive
     with a university and a department and no school between them — the
     tracking workbook has no column for it — so the site showed the posting
     with a department floating under the university, and the school the
     department is actually in was missing from the card and from the filters.

     The canon cannot infer this: a department name is not enough to name its
     school, and guessing would file postings under schools nobody named. So
     it is curated, one line per (university, department), and consulted ONLY
     when the school field is empty — a row that names its own school always
     keeps it.

     Keyed by the CANONICAL names, since that is what `assemble` has by the
     time it asks. */
  var UNIT_HOME = {
    'UT San Antonio': { 'Operations and Analytics Department': 'Carlos Alvarez College of Business' },
    'University of Houston': {
      'Department of Decision and Information Sciences': 'C. T. Bauer College of Business',
      'The Bauer Human-Centered Artificial Intelligence Institute': 'C. T. Bauer College of Business'
    }
  };

  /* Some short forms only mean one school AT ONE UNIVERSITY: "Business
     School" is Mannheim's own name for its school and NUS's shorthand for the
     NUS Business School, so the university has to be known before they can be
     told apart. Keyed by university, then by the name as posted. */
  var SCOPED_SCHOOL_ALIASES = {
    'National University of Singapore': { 'Business School': 'NUS Business School' },
    'Özyeğin University': { 'School of Business': 'Faculty of Business' },

    /* ONE SCHOOL, WRITTEN TWO WAYS. The site's own Universities directory and
       the seed of the world's operations schools (assets/oa-institutions.js)
       were compiled by different hands, so a school arrived under its short
       name from one and its full one from the other — MIT's "Sloan School of
       Management" beside "MIT Sloan School of Management", Berkeley's "Haas"
       beside "Walter A. Haas", Toronto's "Rotman" beside "Joseph L. Rotman" —
       and the picker listed both, which is precisely the duplication the
       vocabulary exists to end.

       The name kept is the FULL OFFICIAL one, as with universities, EXCEPT
       where the longer string is not a fuller name but a parenthetical
       acronym ("(HBS)"), a campus note, or two names fused with a slash;
       where a school has been renamed, the CURRENT name wins (Purdue's
       Krannert became the Mitchell E. Daniels, Jr. School of Business in
       2023; Miami's School of Business Administration became Miami Herbert
       in 2019).

       They are SCOPED because most of these short forms are generic — a
       global "College of Business" alias would rename every university's. */
    'Binghamton University': { 'SUNY (School of Management)': 'School of Management' },
    'Clemson University': { 'College of Business': 'Wilbur O. and Ann Powers College of Business' },
    'Erasmus University Rotterdam': { 'Rotterdam School of Management (RSM)': 'Rotterdam School of Management' },
    'Georgia State University': { 'Robinson College of Business': 'J. Mack Robinson College of Business' },
    'Harvard University': { 'Harvard Business School (HBS)': 'Harvard Business School' },
    'Lehigh University': { 'College of Business and Economics': 'College of Business' },
    'Massachusetts Institute of Technology': { 'Sloan School of Management': 'MIT Sloan School of Management' },
    'Nanyang Technological University': { 'Nanyang Business School (NBS)': 'Nanyang Business School' },
    'Purdue University': {
      'Krannert School of Management': 'Mitchell E. Daniels, Jr. School of Business',
      'Mitchell E. Daniels, Jr. School of Business / Krannert School of Management':
        'Mitchell E. Daniels, Jr. School of Business'
    },
    'Rice University': { 'Jones Graduate School Of Business': 'Jesse H. Jones Graduate School of Business' },
    'Southern Methodist University': { 'Cox School of Business': 'Edwin L. Cox School of Business' },
    'Temple University': { 'Fox School of Business and Management': 'Fox School of Business' },
    'The Chinese University of Hong Kong': { 'CUHK Business School (Hong Kong)': 'CUHK Business School' },
    'The Ohio State University': { 'Fisher College of Business': 'Max M. Fisher College of Business' },
    'Tilburg University': {
      'School of Economics and Management': 'Tilburg School of Economics and Management',
      '(TiSEM) School of Economics and Management (incl. Econometrics and Operations Research depts.)':
        'Tilburg School of Economics and Management'
    },
    'University of California, Berkeley': { 'Haas School of Business': 'Walter A. Haas School of Business' },
    'University of California, Riverside': {
      'School of Business Administration, A. Gary Anderson Graduate School of Management': 'School of Business'
    },
    'University of Mannheim': { 'Mannheim Business School': 'Business School' },
    'University of Miami': {
      'School of Business Administration': 'Miami Herbert Business School',
      'School of Business Administration / Herbert Business School': 'Miami Herbert Business School'
    },
    'University of Minnesota': { 'Carlson School of Management': 'Curtis L. Carlson School of Management' },
    'University of Nebraska - Lincoln': { 'College of Business Administration': 'College of Business' },
    'University of New South Wales': { 'Business School': 'UNSW Business School' },
    'University of Oregon': { 'Lundquist College of Business': 'Charles H. Lundquist College of Business' },
    'University of Southern California': { 'Marshall School of Business (incl. Leventhal)': 'Marshall School of Business' },
    'University of Toronto': { 'Rotman School of Management': 'Joseph L. Rotman School of Management' },
    'University of Illinois at Chicago': { 'College of Business Administration': 'College of Business' },

    /* …and two the same request turned up that a SUBSTRING check cannot see,
       because the two spellings put the same words in a different order:
       "Michael Smurfit Graduate Business School" beside "UCD Michael Smurfit
       Graduate School of Business", and Olin twice. Neither string contains
       the other, so only comparing the DISTINCTIVE words — dropping the
       generic ones and the university's own name and initials — finds them. */
    'University College Dublin': {
      'UCD Michael Smurfit Graduate School of Business': 'Michael Smurfit Graduate Business School'
    },
    'Washington University in St. Louis': { 'Olin School of Business': 'Olin Business School' },

    /* Owner, 2026-08-18, naming five more places whose entry carried the source
       directory's own editorial aside — "(formerly Cass Business)", "(Incl.
       Dyson and Nolan)" — or a short form nobody writes out. */
    'University of London': {
      'Bayes Business School (formerly Cass Business)': 'Bayes Business School',
      'Bayes Business School, Faculty of Management': 'Bayes Business School',
      'Cass Business School': 'Bayes Business School'
    },
    'Cornell University': {
      'SC Johnson College of Business, Johnson Graduate School of Management (Incl. Dyson and Nolan)':
        'Cornell SC Johnson College of Business',
      /* the Johnson school is INSIDE that college, and after the owner's
         ruling both carried the identical department — one group under two
         school names, which is the duplication the vocabulary exists to end */
      'Samuel Curtis Johnson Graduate School of Management': 'Cornell SC Johnson College of Business',
      'Johnson Graduate School of Management': 'Cornell SC Johnson College of Business'
    },
    'University of Melbourne': {
      'Melbourne Business School (Incl. Faculty of Business and Economics)': 'Melbourne Business School',
      'Melbourne Business School (Incl. Faculty of Business & Economics)': 'Melbourne Business School'
    },
    'Stanford University': {
      'Graduate School of Business': 'Stanford Graduate School of Business',
      'Graduate School of Business (GSB)': 'Stanford Graduate School of Business'
    },
    'The University of Hong Kong': { 'School of Business': 'Faculty of Business and Economics' },
    'The Chinese University of Hong Kong, Shenzhen': {
      'CUHK(SZ)': 'School of Management and Economics',
      'CUHK (SZ)': 'School of Management and Economics',
      'The School of Management and Economics (SME)': 'School of Management and Economics'
    }
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

  /* THE SCHOOL'S OWN NAME FOR ITS UNIT, where the generic rule below would
     take it away. The bare-field-name rule is right in general — "Department",
     "Area" and "group" are exactly what differs between two people naming one
     unit, which is what made Tulane read as five places — and it is wrong for
     these six, where the wrapper IS part of what the school calls the group:
     UT Dallas has an Operations Management AREA, Purdue a Supply Chain and
     Operations Management FACULTY, Yale an Operations DEPARTMENT.

     Supplied by the owner (2026-08-18), each settling a pair of names the site
     was carrying for ONE group. Keyed by university, like the school table
     above and safe for the same reason: no other school at any of these six
     carries one of these names (asserted in the selftest).

     A hit is TERMINAL — returned exactly as written, never put back through
     the wrapper rule that would undo it, and never through spell(), which
     turns " & " into " and " and would spoil Emory's own styling. Everywhere
     else the generic rule still applies, so a poster typing "Operations
     Management Department" at some other school still lands on the bare name. */
  var SCOPED_UNIT_ALIASES = {
    'Emory University': {              /* Goizueta Business School */
      'Information Systems and Operations Management': 'Information Systems & Operations Management',
      'Operations Management': 'Information Systems & Operations Management'
    },
    'Purdue University': {             /* Mitchell E. Daniels, Jr. School of Business */
      'Operations Management': 'Supply Chain and Operations Management Faculty',
      'Supply Chain and Operations Management': 'Supply Chain and Operations Management Faculty'
    },
    'The University of Texas at Dallas': {   /* Naveen Jindal School of Management */
      'Operations Management': 'Operations Management Area',
      'Supply Chain and Operations Management': 'Operations Management Area'
    },
    'University College Dublin': {     /* Michael Smurfit Graduate Business School */
      'Management': 'Management Area',
      'Operations Management': 'Management Area'
    },
    'University of Miami': {           /* Miami Herbert Business School */
      'Management': 'Management Area',
      'Management Science': 'Management Area'
    },
    'Cornell University': {            /* Cornell SC Johnson College of Business */
      'Operations, Technology and Information Management': 'Operations, Technology, and Information Management Area',
      'Operations Management': 'Operations, Technology, and Information Management Area'
    },
    'University of Melbourne': {       /* Melbourne Business School */
      'Business and Economics': 'Faculty of Business and Economics'
    },
    'Binghamton University': {         /* School of Management */
      'Operations and Business Analytics': 'Business Analytics and Operations'
    },
    'Stanford University': {           /* Stanford Graduate School of Business */
      'Operations and Information Technology': 'Operations, Information, and Technology (OIT) area',
      'Operations, Information and Technology': 'Operations, Information, and Technology (OIT) area'
    },
    'The University of Hong Kong': {   /* Faculty of Business and Economics */
      'Innovation and Information Management': 'Information and Innovation Management'
    },
    'University of Houston': {         /* C. T. Bauer College of Business */
      'Decision and Information Sciences': 'Department of Decision and Information Sciences',
      'Decision & Information Sciences': 'Department of Decision and Information Sciences',
      'Bauer Human-Centered AI Institute': 'The Bauer Human-Centered Artificial Intelligence Institute',
      'Bauer Human-Centered Artificial Intelligence Institute':
        'The Bauer Human-Centered Artificial Intelligence Institute'
    },
    'University of Virginia': {        /* Darden School of Business */
      /* Darden has TWO departments today (owner, 2026-08-18) — this one and
         Technology and Operations Management. "Quantitative Analysis" is what
         the group was called before, and the Universities map still carried
         it, so the picker offered a third department that no longer exists. */
      'Quantitative Analysis': 'Data Analytics and Decision Sciences',
      'Quantitative Analytics': 'Data Analytics and Decision Sciences'
    },
    'UT San Antonio': {                /* Carlos Alvarez College of Business */
      'Operations and Analytics': 'Operations and Analytics Department'
    },
    'Yale University': {               /* School of Management */
      'Operations': 'Operations Department',
      'Operations Management': 'Operations Department'
    }
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
    /* A NAMED department with its area appended — Baruch's box says "Loomba
       Department of Management, Operations Management", where the department
       is the Narendra Paul Loomba Department of Management and Operations
       Management is a group inside it. The wrapper rules cannot see this
       (the wrapper is in the MIDDLE), and the bare field name is Management. */
    'Loomba Department of Management, Operations Management': 'Management',
    'Management, Operations Management': 'Management',
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
     behind by a form that asked for "Department" and was answered literally.

     The last two are NAMES, and they still say nothing about which department
     a posting is in (owner, 2026-08-18): one is a corporate research lab the
     source directory listed in the department column, the other a research
     TOPIC somebody typed into it. Neither is a unit anyone can be a member of,
     and each was its own entry in the department filter. Written out in full
     because that is what makes them safe — nothing else can match them. */
  var EMPTY_UNITS = [
    'department', 'dept', 'area', 'group', 'division', 'unit', 'school', 'n a', 'na', 'none', 'tbd',
    'fujitsu smu urban computing and engineering unicen corp lab',
    'artificial intelligence ai and healthcare'
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

  /* "School of" is here BECAUSE this runs on the department field only
     (canonUnitCore, never canonSchool): Australian and New Zealand
     universities call their departments Schools, so UNSW's department box
     says "School of Information Systems and Technology Management" where an
     American one says "Department of …" and a British one says nothing. The
     wrapper is how a university happens to organise itself — the field name
     is what the site publishes, and the school it sits under is the
     neighbouring box already. */
  var LEADING_UNIT = /^(the\s+)?(department|dept|division|discipline|area|group|office|programme|program|school|faculty)\s+(of|for|in)\s+/i;
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
    var by = Object.create(null), i;
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
  var BY_SCOPED_SCHOOL = Object.create(null);
  /* Indexed BOTH ways: under the name as written, and under institutionKey —
     the "same university however it is written" identity. The directory lists
     one university under several names ("Massachusetts Institute of Technology"
     and "…(MIT)"), and a table entry that matched only one of them would
     silently apply to half a university's postings. */
  var SCOPED_KEYED = {};
  for (var uni in SCOPED_SCHOOL_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(SCOPED_SCHOOL_ALIASES, uni)) continue;
    var table = tableOf([], SCOPED_SCHOOL_ALIASES[uni]);
    BY_SCOPED_SCHOOL[fold(uni)] = table;
    SCOPED_KEYED[institutionKey(uni)] = table;
  }
  var BY_FUSED_INSTITUTION = Object.create(null);
  for (var fi in FUSED_INSTITUTIONS) {
    if (!Object.prototype.hasOwnProperty.call(FUSED_INSTITUTIONS, fi)) continue;
    BY_FUSED_INSTITUTION[fold(fi)] = FUSED_INSTITUTIONS[fi];
    BY_FUSED_INSTITUTION[fold(spell(fi))] = FUSED_INSTITUTIONS[fi];
  }

  var BY_UNIT_HOME = Object.create(null);
  for (var uh in UNIT_HOME) {
    if (!Object.prototype.hasOwnProperty.call(UNIT_HOME, uh)) continue;
    var homes = Object.create(null);
    for (var un in UNIT_HOME[uh]) {
      if (!Object.prototype.hasOwnProperty.call(UNIT_HOME[uh], un)) continue;
      homes[fold(un)] = UNIT_HOME[uh][un];
    }
    BY_UNIT_HOME[fold(uh)] = homes;
    BY_UNIT_HOME[institutionKey(uh)] = homes;
  }

  var BY_SCHOOL = tableOf(SCHOOL_LIST, SCHOOL_ALIASES);
  var BY_UNIT = tableOf([], UNIT_ALIASES);

  /* Each variant is indexed BOTH as written and as spell() would rewrite it,
     because " & " becomes " and " there and the two fold differently; the
     TARGET is indexed too, so canonicalising an already-canonical name
     returns it unchanged (idempotence, which the selftest pins).
     SCOPED_UNIT_NAMES is the flat set of published names, for isCanonicalUnit
     — a scoped name is canonical however the generic rule would read it. */
  var BY_SCOPED_UNIT = Object.create(null);
  var SCOPED_UNIT_KEYED = Object.create(null);
  var SCOPED_UNIT_NAMES = Object.create(null);
  for (var su in SCOPED_UNIT_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(SCOPED_UNIT_ALIASES, su)) continue;
    var utable = Object.create(null);
    var given = SCOPED_UNIT_ALIASES[su];
    for (var variant in given) {
      if (!Object.prototype.hasOwnProperty.call(given, variant)) continue;
      var target = given[variant];
      utable[fold(variant)] = target;
      utable[fold(spell(variant))] = target;
      utable[fold(target)] = target;
      utable[fold(spell(target))] = target;
      SCOPED_UNIT_NAMES[fold(target)] = target;
      SCOPED_UNIT_NAMES[fold(spell(target))] = target;
    }
    BY_SCOPED_UNIT[fold(su)] = utable;
    SCOPED_UNIT_KEYED[institutionKey(su)] = utable;
  }

  /* ------------------------------------------------------------- the canons */

  /** The one name this university is published under. */
  function canonInstitution(v) {
    var s = spell(v);
    if (!s) return '';
    return BY_INSTITUTION[fold(s)] || s;
  }

  /**
   * The same university, however it is written — an identity for GROUPING,
   * never a name to publish.
   *
   * The Universities directory lists one university under several names:
   * "City University of Hong Kong (CityU)" beside "City University of Hong
   * Kong", "The University of Hong Kong (HKU)" beside "University of Hong Kong
   * (HKU)". The posting form offered each as its own university, with its own
   * schools, so half of a university's schools were invisible from the other
   * half of it.
   *
   * A trailing acronym and a leading "The" are exactly what one writer adds
   * and the next leaves out — the same two rules canonUnit and canonSchool
   * already apply — but they must not decide what the site PUBLISHES: a
   * posting's id and its permalink are built from its institution, and
   * "Baruch College, The City University of New York (CUNY)" is deliberately
   * published whole. So this is a separate function, used where names are
   * grouped (data/vocab.json, and the posting form reading it back).
   */
  function institutionKey(v) {
    var s = dropAcronym(canonInstitution(v));
    return fold(s).replace(/^the /, '');
  }

  /** The one name this school is published under. The university is optional
      and is consulted first, for the short forms that mean different schools
      at different universities. */
  function canonSchool(v, institution) {
    var s = spell(v);
    if (!s) return '';

    var scoped = institution
      ? (BY_SCOPED_SCHOOL[fold(canonInstitution(institution))]
         || SCOPED_KEYED[institutionKey(institution)])
      : null;

    /* BOTH tables are asked twice: as written, then with a leading "The"
       dropped. The bare retry used to reach only the global table, so a
       scoped entry missed the one spelling that carried it — "The Fox School
       of Business and Management" went on standing beside "Fox School of
       Business" in Temple's list with the alias sitting right there. */
    var bare = clean(s.replace(/^the\s+/i, ''));
    var hit = (scoped && (scoped[fold(s)] || scoped[fold(bare)]))
           || BY_SCHOOL[fold(s)]
           || BY_SCHOOL[fold(bare)];
    if (hit) return hit;

    return bare || s;
  }

  /** The one name this department is published under. The university is
      optional and is consulted FIRST, for the six schools that name their own
      unit in a way the generic wrapper rule would take away. */
  function canonUnit(v, institution) {
    var s = spell(v);
    if (!s) return '';

    if (institution) {
      var scoped = BY_SCOPED_UNIT[fold(canonInstitution(institution))]
                || SCOPED_UNIT_KEYED[institutionKey(institution)];
      /* Asked three ways, because the same unit reaches us wearing its own
         wrapper: as written ("Operations Management Group"), as spell()
         rewrites it, and as the GENERIC rule would leave it ("Operations
         Management") — which is the form the table is written in, since
         listing every wrapper a source might use is exactly the losing game
         the bare-name rule exists to avoid.

         Terminal: the curated name is returned as written, never put back
         through the wrapper rule that would undo it. */
      if (scoped) {
        var pinned = scoped[fold(v)] || scoped[fold(s)] || scoped[fold(canonUnitCore(s))];
        if (pinned) return pinned;
      }
    }

    var hit = BY_UNIT[fold(s)];
    if (hit) return canonUnitCore(hit);

    return canonUnitCore(s);
  }

  /** The wrapper-free field name, alias table consulted again once the
      wrapper is off ("Department of Operations and Info Systems" reaches
      "Operations and Info Systems" only after stripping).

      Stripped REPEATEDLY, because each pass can uncover the other's work:
      "Engineering Management, Information, and Systems Department (EMIS)"
      ends in the acronym, so the wrapper is not last until the acronym has
      gone. One pass left it canonicalising to something that was not itself
      canonical — which is exactly what "safe to run twice" must not mean. */
  function canonUnitCore(v) {
    var s = clean(v), prev = null;
    while (s && s !== prev) { prev = s; s = dropAcronym(stripWrapper(s)); }
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

  var BY_FUSED = Object.create(null);
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
    return assemble(given, splitFused(spell(given.school)));
  }

  /**
   * The same, for three names that are ALREADY in three fields — a posting
   * form's boxes, the Universities directory's columns.
   *
   * TWO THINGS canonPlace() does that a set of columns must not have done to
   * it, because both are guesses about a value that names more than one thing
   * and a form with three boxes has already said which is which:
   *
   *   - the LEGACY INSTITUTION split. "University of California, Los Angeles
   *     (UCLA)" typed into the University box, with the others still empty,
   *     was read as a university and a department and posted under "University
   *     of California" with a department called "Los Angeles". Berkeley, one
   *     word shorter, was left alone.
   *   - the SEPARATOR split of the school box. Across every name in the data
   *     it fires three times and is wrong twice: Rutgers' "School of
   *     Business-Camden" (a campus, and a separately accredited school) and
   *     Clemson's "College of Engineering, Computing and Applied Sciences" (a
   *     comma inside one college's name) both lost their tail to an invented
   *     department. The CURATED pairs are kept — a name somebody has written
   *     down as naming both really does name both.
   */
  function canonColumns(place) {
    var p = place || {};
    var given = { institution: clean(p.institution), school: clean(p.school), unit: clean(p.unit) };
    var known = BY_FUSED[fold(spell(given.school))];
    return assemble(given, known || { school: given.school, unit: '' });
  }

  /** The three names canonicalised, with whatever the school field gave up. */
  function assemble(given, fused) {
    /* the university's box naming a school too — split before anything reads
       either, so the school lands in the school field and the name the
       posting publishes under is the university's own */
    var split = BY_FUSED_INSTITUTION[fold(spell(given.institution))];
    var institution = canonInstitution(split ? split.institution : given.institution);
    var school = canonSchool(fused.school || (split ? split.school : ''), institution);

    var unit = canonUnit(given.unit || (split && split.unit) || '', institution);
    var moved = canonUnit(fused.unit, institution);
    if (moved && !unit) unit = moved;
    else if (moved && unit && fold(moved) !== fold(unit)) {
      /* Both say something, and they are usually two halves of one name that
         a stray separator cut in two ("McCombs School of Business:
         Information" + "Risk, and Operations Management"). One inside the
         other is a repetition — keep the fuller; otherwise rejoin them. */
      if (fold(unit).indexOf(fold(moved)) !== -1) { /* unit already says it */ }
      else if (fold(moved).indexOf(fold(unit)) !== -1) unit = moved;
      else unit = canonUnit(moved + ', ' + unit, institution);
    }

    /* THE SCHOOL TYPED INTO THE DEPARTMENT BOX. The mirror of the fused
       school field above, and just as common from a three-box form: nothing
       in the School field and "Freeman School of Business" in the Department
       one. Left alone, the posting publishes with no school and a department
       that is a school, which is a second spelling of a place the site
       already lists — and the selftest's "every Tulane posting names one
       school, and one department" guard then goes red on live data and stops
       the whole publish, which is how one mistyped posting held up every
       other one.

       CURATED, NEVER GUESSED, exactly like the UNIT_HOME fill below: the
       value must be a name the school table itself knows (SCHOOL_LIST or an
       alias), so a real department is never promoted for merely carrying a
       school-ish word. A row that named BOTH is untouched — the department
       field is only emptied because what it held was not one. */
    if (!school && unit && BY_SCHOOL[fold(spell(unit))]) {
      school = canonSchool(unit, institution);
      unit = '';
    }

    /* the school the row never named — curated, never guessed, and never over
       a school the row DID name */
    if (!school && unit) {
      var homes = BY_UNIT_HOME[fold(institution)] || BY_UNIT_HOME[institutionKey(institution)];
      if (homes && homes[fold(unit)]) school = canonSchool(homes[fold(unit)], institution);
    }

    return { institution: institution, school: school, unit: unit };
  }

  /** True when the value is already the name we publish. */
  function isCanonicalSchool(v) { return !!v && canonSchool(v) === v; }
  function isCanonicalUnit(v) {
    if (!v) return false;
    if (SCOPED_UNIT_NAMES[fold(v)] === v) return true;
    return canonUnit(v) === v;
  }

  return {
    INSTITUTION_ALIASES: INSTITUTION_ALIASES,
    SCHOOL_LIST: SCHOOL_LIST,
    SCHOOL_ALIASES: SCHOOL_ALIASES,
    SCOPED_SCHOOL_ALIASES: SCOPED_SCHOOL_ALIASES,
    UNIT_ALIASES: UNIT_ALIASES,
    SCOPED_UNIT_ALIASES: SCOPED_UNIT_ALIASES,
    FUSED_INSTITUTIONS: FUSED_INSTITUTIONS,
    UNIT_HOME: UNIT_HOME,
    fold: fold,
    canonInstitution: canonInstitution,
    institutionKey: institutionKey,
    canonSchool: canonSchool,
    canonUnit: canonUnit,
    canonPlace: canonPlace,
    canonColumns: canonColumns,
    splitFused: splitFused,
    splitLegacyInstitution: splitLegacyInstitution,
    isCanonicalSchool: isCanonicalSchool,
    isCanonicalUnit: isCanonicalUnit
  };
}));
