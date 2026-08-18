/* ---------------------------------------------------------------------------
   Operations Academia — the institutions the posting forms offer.

   ONE definition, loaded by BOTH sides, exactly like oa-countries.js:

     the browser   <script src="assets/oa-institutions.js">      -> window.OAInstitutions
     the build     createRequire(...)('.../oa-institutions.js')  -> module.exports

   WHY THIS EXISTS. The three posting forms offer a vocabulary built from the
   site's OWN postings (data/vocab.json, see _scraper/vocab.mjs) — which is the
   right mechanism and keeps itself current, but it can only ever offer places
   that have already advertised here. That was 63 universities. A poster at any
   of the ~170 other operations and supply chain departments in the world
   therefore met an empty list and typed the name from scratch, which is exactly
   how "The Pennsylvania State University" and "Pennsylvania State University"
   become two entries in a filter, and how a department arrives as "Mgmt Science
   area" one year and "Management Sciences" the next.

   So the postings-derived vocabulary is now SEEDED with the operations and
   supply chain schools of the world: the university, the school or faculty it
   sits in, and the department(s) that do operations there. A name is offered
   from the first day, spelled one way, before anyone has posted from it.

   THE SEED IS A HINT, NOT A CLOSED LIST. Everything downstream still accepts a
   name that is not here — the pickers keep their "use what you typed" row and
   the fields stay free text — so a school that opens a new department, or a
   department this list has never heard of, is still postable. It joins the
   vocabulary from the next build, through the postings, with nobody editing
   this file.

   A UNIVERSITY HAS MORE THAN ONE SCHOOL, AND THEY ARE NOT DUPLICATES (owner,
   2026-08-17). Auburn University does operations in the Harbert College of
   Business AND in its Department of Industrial and Systems Engineering; those
   are two schools with two different sets of departments, and merging them
   would offer a business-school poster an engineering department as if it were
   theirs. That is why departments hang off a (university, school) PAIR here
   rather than off the university — `forUniversity()` returns both the union and
   the per-school breakdown, and the forms narrow the department list to the
   school the poster actually chose.

   IT NAMES NOTHING. What each university, school and department is CALLED is
   assets/oa-schools.js's job, and only its — this file says which places exist,
   that one says how they are spelled, and _scraper/vocab.mjs runs every record
   below through it before the vocabulary is built. Two canon() functions would
   be two answers to one question, and the disagreement would be silent; so a
   spelling that needs fixing is fixed THERE, and a place that is missing is
   added HERE.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAInstitutions = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ the seed

     One record per (university, school). Alphabetical by university, which is
     the order the pickers show and the order a diff should read in.

       u  the university — what the "University / Institution" field offers
       s  the school, faculty or college it sits in (absent where the
          institution IS the school: CEIBS, IESEG, Frankfurt School)
       d  the department(s), area(s) or group(s) doing operations there

     Source: the OM/SCM faculty directory, 178 schools (2026-08-17). To add a
     school, add a record; to correct a spelling, correct it here — the built
     vocabulary and every form follow on the next build.

     A few of the source's own values were defects and are corrected here, since
     every one of them would otherwise be offered to a poster as a name to pick:
     Bath's school reached us as "School of Managemen" (no final t) and
     Tsinghua's department as "Management Science and Engineering)" (a stray
     bracket); "HEC Montreal", "Said Business School" and "Leonard N Stern"
     were missing an accent, a diaeresis and a full stop, and Cologne's faculty
     spelled its umlaut "ae" — this file carries Católica, Koç and Kühne without
     trouble, so that was the source transliterating, not an encoding limit; and
     Carnegie Mellon listed "Heinz College" as a DEPARTMENT, though it is a
     school and this record's own school field already names it.

     Left exactly as the source has it: Saarland's "Fachrichtung
     Wirtschaftswissenschaft" is German because that is the department's name,
     not because anything was lost.                                            */

  var LIST = [
    { u: 'Arizona State University', s: 'W.P. Carey School of Business', d: ['Supply Chain Management'] },
    { u: 'Auburn University', s: 'Harbert College of Business', d: ['Supply Chain Management'] },
    { u: 'Bilkent University', s: 'Faculty of Business Administration', d: ['Operations Management'] },
    { u: 'Bocconi University', s: 'SDA School of Management', d: ['Operations & Supply Chain Management'] },
    { u: 'Boston College', s: 'Carroll School of Management', d: ['Business Analytics'] },
    { u: 'Boston University', s: 'Questrom School of Business', d: ['Operations & Technology Management', 'Information Systems'] },
    { u: 'Brigham Young University', s: 'Marriott School of Business', d: ['Marketing & Global Supply Chain'] },
    { u: 'Cardiff University', s: 'Cardiff Business School', d: ['Logistics and Operations Management'] },
    { u: 'Carnegie Mellon University', s: 'Tepper School of Business', d: ['Operations Management'] },
    { u: 'Case Western Reserve University', s: 'Weatherhead School of Management', d: ['Operations'] },
    { u: 'Católica Lisbon School of Business and Economics', s: 'School of Management', d: ['Operations and Data Science'] },
    { u: 'CEIBS', d: ['Operations Management', 'Decision Sciences and Management Information Systems'] },
    { u: 'Chinese University of Hong Kong', s: 'CUHK Business School (Hong Kong)', d: ['Operations Management'] },
    { u: 'City University of Hong Kong', s: 'College of Business', d: ['Operations Research and Operations Management'] },
    { u: 'City University of New York, Baruch College', s: 'Zicklin School of Business', d: ['Management'] },
    { u: 'Clemson University', s: 'Wilbur O. and Ann Powers College of Business', d: ['Management'] },
    { u: 'Columbia University', s: 'Columbia Business School', d: ['Decision, Risk, and Operations'] },
    { u: 'Copenhagen Business School', s: 'School of Business', d: ['Operations Management'] },
    { u: 'Cornell University', s: 'Cornell SC Johnson College of Business', d: ['Operations, Technology, and Information Management Area'] },
    { u: 'Cranfield University', s: 'Cranfield School of Management', d: ['Logistics, Procurement and Supply Chain Management'] },
    { u: 'Dartmouth College', s: 'Tuck School of Business', d: ['Operations & Management Science'] },
    { u: 'DePaul University', s: 'Driehaus College of Business', d: ['Management & Entrepreneurship'] },
    { u: 'Drexel University', s: 'LeBow College of Business', d: ['Decision Sciences and Management Information Systems'] },
    { u: 'Duke University', s: 'The Fuqua School of Business', d: ['Operations Management', 'Decision Sciences'] },
    { u: 'Emory University', s: 'Goizueta Business School', d: ['Operations Management'] },
    { u: 'Erasmus University Rotterdam', s: 'Rotterdam School of Management', d: ['Technology and Operations Management'] },
    { u: 'ESSEC', s: 'ESSEC Business School', d: ['Information Systems, Data Analytics and Operations'] },
    { u: 'ETH Zurich', s: 'ETH Zurich', d: ['Management, Technology and Economics'] },
    { u: 'European School of Management and Technology', d: ['Management Science'] },
    { u: 'Frankfurt School of Finance & Management', d: ['Management'] },
    { u: 'Fudan University', s: 'School of Management', d: ['Management Science'] },
    { u: 'George Mason University', s: 'Costello College of Business', d: ['Information Systems and Operations Management'] },
    { u: 'George Washington University', s: 'School of Business', d: ['Decision Sciences'] },
    { u: 'Georgetown University', s: 'The McDonough School of Business', d: ['Operations & Analytics'] },
    { u: 'Georgia Institute of Technology', s: 'Scheller College of Business', d: ['Operations Management'] },
    { u: 'Georgia State University', s: 'Robinson College of Business', d: ['Computer Information Systems'] },
    { u: 'Harvard University', s: 'Harvard Business School', d: ['Technology and Operations Management'] },
    { u: 'HEC Montréal', d: ['Logistics and Operations Management'] },
    { u: 'HEC Paris', s: 'School of Business', d: ['Information Systems and Operations Management'] },
    { u: 'Hong Kong Polytechnic University', s: 'Faculty of Business (incl. Logistics and Maritime Studies)', d: ['Logistics and Maritime Studies', 'Fashion and Textiles'] },
    { u: 'Hong Kong University of Science and Technology', s: 'Business School', d: ['Information Systems, Business Statistics and Operations Management'] },
    { u: 'IE University', s: 'IE Business School', d: ['Operations & Business Analytics'] },
    { u: 'IESEG', d: ['Operations Management'] },
    { u: 'Imperial College London', s: 'Imperial College Business School', d: ['Analytics & Operations'] },
    { u: 'Indian School of Business', s: 'School of Business', d: ['Operations Management'] },
    { u: 'Indiana University Bloomington', s: 'Kelley School of Business', d: ['Supply Chain and Operations'] },
    { u: 'INSEAD', s: 'School of Business', d: ['Technology and Operations Management', 'Decision Sciences'] },
    { u: 'Iowa State University', s: 'Ivy College of Business', d: ['Supply Chain Management'] },
    { u: 'Johns Hopkins University', s: 'Carey Business School', d: ['Operations Management and Business Analytics'] },
    { u: 'KAIST', s: 'College of Business', d: ['Operations Strategy & Management Science'] },
    { u: 'Kedge Business School', d: ['Operations Management and Information Systems'] },
    { u: 'Koç University', s: 'Graduate School of Business', d: ['Operations Management and Information Systems'] },
    { u: 'Korea University', s: 'Korea University Business School', d: ['Logistics, Service and Operations Management'] },
    { u: 'Kühne Logistics University' },
    { u: 'Lancaster University', s: 'Management School', d: ['Management Science'] },
    { u: 'Maastricht University', s: 'School of Business and Economics', d: ['Marketing and Supply Chain Management'] },
    { u: 'Massachusetts Institute of Technology', s: 'Sloan School of Management', d: ['Operations Management', 'Operations Research and Statistics'] },
    { u: 'McGill University', s: 'Desautels Faculty of Management', d: ['Operations Management'] },
    { u: 'Michigan State University', s: 'The Eli Broad College of Business', d: ['Supply Chain Management'] },
    { u: 'Monash University', s: 'Monash Business School', d: ['Management'] },
    { u: 'Nanyang Technological University', s: 'Nanyang Business School', d: ['Information Technology and Operations Management'] },
    { u: 'National University of Singapore', s: 'NUS Business School', d: ['Analytics and Operations'] },
    { u: 'New York University', s: 'Leonard N. Stern School of Business', d: ['Technology, Operations and Statistics'] },
    { u: 'North Carolina State University', s: 'Poole College of Management', d: ['Information Technology, Analytics and Operations'] },
    { u: 'North Dakota State University', s: 'College of Business', d: ['Finance, Supply Chain and Transportation'] },
    { u: 'Northeastern University', s: 'D\'Amore-McKim School of Business', d: ['Supply Chain & Information Management'] },
    { u: 'Northern Illinois University', s: 'College of Business', d: ['Operations Management and Information Systems'] },
    { u: 'Northwestern University', s: 'Kellogg School of Management', d: ['Operations'] },
    { u: 'NOVA School of Business and Economics', s: 'Nova School of Business and Economics', d: ['Operations, Technology and Innovation Management'] },
    { u: 'Oregon State University', s: 'College of Business', d: ['Supply Chain and Logistics Management'] },
    { u: 'Peking University', s: 'Guanghua School of Management', d: ['Management Science and Information System'] },
    { u: 'Pennsylvania State University', s: 'Smeal College of Business', d: ['Supply Chain and Information Systems'] },
    { u: 'Purdue University', s: 'Mitchell E. Daniels, Jr. School of Business / Krannert School of Management', d: ['Supply Chain and Operations Management'] },
    { u: 'Rice University', s: 'Jesse H. Jones Graduate School of Business', d: ['Operations Management'] },
    { u: 'Rutgers University at Newark and New Brunswick', s: 'Rutgers Business School', d: ['Supply Chain Management'] },
    { u: 'Saarland University', d: ['Fachrichtung Wirtschaftswissenschaft'] },
    { u: 'Santa Clara University', s: 'Leavey School of Business', d: ['Information Systems and Analytics'] },
    { u: 'Seoul National University', s: 'Business School', d: ['Operations Management'] },
    { u: 'Shanghai Jiao Tong University', s: 'Antai College of Economics and Management', d: ['Management Science'] },
    { u: 'Singapore Management University', s: 'Lee Kong Chian School of Business', d: ['Operations Management'] },
    { u: 'Southern Methodist University', s: 'Cox School of Business', d: ['Information Technology and Operations Management'] },
    { u: 'Stanford University', s: 'Stanford Graduate School of Business', d: ['Operations, Information, and Technology (OIT) area'] },
    { u: 'Stony Brook University', s: 'College of Business', d: ['Operations & Decision Analytics'] },
    { u: 'Syracuse University', s: 'Whitman School of Management', d: ['Supply Chain Management'] },
    { u: 'Technical University of Munich', s: 'TUM School of Management', d: ['Operations & Technology'] },
    { u: 'Technion – Israel Institute of Technology', s: 'Faculty of Data and Decision Sciences', d: ['Operations Management'] },
    { u: 'Tel Aviv University', s: 'Coller School of Management', d: ['Operational Strategy'] },
    { u: 'Temple University', s: 'The Fox School of Business and Management', d: ['Statistics, Operations, and Data Science'] },
    { u: 'Texas A&M University', s: 'Mays Business School', d: ['Information and Operations Management'] },
    { u: 'Texas Christian University', s: 'Neeley School of Business', d: ['Information Systems and Supply Chain Management'] },
    { u: 'Texas State University', s: 'McCoy College of Business', d: ['Management', 'Information Systems and Analytics'] },
    { u: 'Texas Tech University', s: 'Rawls College of Business', d: ['Marketing'] },
    { u: 'The Chinese University of Hong Kong, Shenzhen', s: 'School of Management and Economics', d: ['Information Systems & Operations Management'] },
    { u: 'The Hebrew University of Jerusalem', s: 'The Hebrew University Business School', d: ['Operations Research'] },
    { u: 'The Ohio State University', s: 'Fisher College of Business', d: ['Operations and Business Analytics', 'Marketing & Logistics'] },
    { u: 'The University of Texas at Austin', s: 'McCombs School of Business', d: ['Information, Risk and Operations Management'] },
    { u: 'The University of Texas at Dallas', s: 'Naveen Jindal School of Management', d: ['Operations Management'] },
    { u: 'Tilburg University', s: '(TiSEM) School of Economics and Management (incl. Econometrics and Operations Research depts.)', d: ['Information Systems and Operations Management'] },
    { u: 'Tsinghua University', s: 'School of Economics and Management', d: ['Management Science and Engineering'] },
    { u: 'Tulane University', s: 'Freeman School of Business', d: ['Management Science'] },
    { u: 'University at Buffalo, The State University of New York', s: 'School of Management', d: ['Operations Management'] },
    { u: 'University College Dublin', s: 'Michael Smurfit Graduate Business School', d: ['Management'] },
    { u: 'University College London', s: 'UCL School of Management', d: ['Operations & Technology'] },
    { u: 'University of Alberta', s: 'Alberta School of Business', d: ['Accounting and Business Analytics'] },
    { u: 'University of Amsterdam', s: 'Amsterdam Business School, Amsterdam School of Economics', d: ['Business Analytics'] },
    { u: 'University of Arkansas at Fayetteville', s: 'Sam M. Walton College of Business', d: ['Supply Chain Management'] },
    { u: 'University of Auckland', s: 'Business School', d: ['Information Systems and Operations Management'] },
    { u: 'University of Bath', s: 'School of Management', d: ['Information, Decisions and Operations'] },
    { u: 'University of British Columbia', s: 'Sauder School of Business', d: ['Operations & Logistics'] },
    { u: 'University of Calgary', s: 'Haskayne School of Business', d: ['Operations and Supply Chain Management'] },
    { u: 'University of California San Diego', s: 'Rady School of Management', d: ['Innovation, Technology and Operations'] },
    { u: 'University of California, Berkeley', s: 'Walter A. Haas School of Business', d: ['Operations and Information Technology Management'] },
    { u: 'University of California, Davis', s: 'Graduate School of Management', d: ['Operations Management'] },
    { u: 'University of California, Irvine', s: 'Paul Merage School of Business', d: ['Operations and Decision Technologies'] },
    { u: 'University of California, Los Angeles', s: 'Anderson School of Management', d: ['Decisions, Operations and Technology Management'] },
    { u: 'University of California, Riverside', s: 'School of Business', d: ['Operations & Supply Chain Management'] },
    { u: 'University of Cambridge', s: 'Judge Business School', d: ['Operations and Technology Management'] },
    { u: 'University of Chicago', s: 'Booth School of Business', d: ['Operations Management'] },
    { u: 'University of Cincinnati', s: 'Carl H. Lindner College of Business', d: ['Operations, Business Analytics, and Information Systems'] },
    { u: 'University of Cologne', s: 'Wirtschafts- und Sozialwissenschaftliche Fakultät', d: ['Operations Management'] },
    { u: 'University of Colorado Boulder', s: 'Leeds School of Business', d: ['Operations Management'] },
    { u: 'University of Connecticut', s: 'School of Business', d: ['Operations & Information Management'] },
    { u: 'University of Dayton', s: 'School of Business Administration', d: ['Management Information Systems, Operations Supply Chain and Business Analytics'] },
    { u: 'University of Florida', s: 'Warrington College of Business', d: ['Information Systems & Operations Management'] },
    { u: 'University of Hong Kong', s: 'Faculty of Business and Economics', d: ['Information and Innovation Management'] },
    { u: 'University of Houston', s: 'C. T. Bauer College of Business', d: ['Department of Decision and Information Sciences', 'The Bauer Human-Centered Artificial Intelligence Institute'] },
    { u: 'University of Illinois Chicago', s: 'College of Business Administration', d: ['Information and Decision Sciences'] },
    { u: 'University of Illinois Urbana-Champaign', s: 'Gies College of Business', d: ['Information Systems, Operations, Supply Chain and Analytics'] },
    { u: 'University of Iowa', s: 'Tippie College of Business', d: ['Business Analytics'] },
    { u: 'University of Kansas', s: 'School of Business', d: ['Analytics, Information, Operations'] },
    { u: 'University of Liverpool', s: 'Management School', d: ['Operations and Supply Chain Management'] },
    { u: 'University of London', s: 'Bayes Business School', d: ['Operations and Supply Chain Management'] },
    { u: 'University of London', s: 'London Business School', d: ['Management Science and Operations'] },
    { u: 'University of Mannheim', s: 'Mannheim Business School', d: ['Operations Management'] },
    { u: 'University of Maryland, College Park', s: 'Robert H. Smith School of Business', d: ['Decision, Operations and Information Technologies', 'Logistics, Business and Public Policy'] },
    { u: 'University of Massachusetts Amherst', s: 'Isenberg School of Management', d: ['Operations and Information Management'] },
    { u: 'University of Massachusetts Lowell', s: 'Manning School of Business', d: ['Operations and Information Systems'] },
    { u: 'University of Melbourne', s: 'Melbourne Business School', d: ['Operations', 'Faculty of Business and Economics'] },
    { u: 'University of Miami', s: 'School of Business Administration / Herbert Business School', d: ['Management Science'] },
    { u: 'University of Michigan at Ann Arbor', s: 'Ross School of Business', d: ['Technology and Operations'] },
    { u: 'University of Minnesota', s: 'Carlson School of Management', d: ['Supply Chain and Operations'] },
    { u: 'University of Missouri-St. Louis', s: 'Ed G. Smith College of Business', d: ['Supply Chain and Analytics'] },
    { u: 'University of Navarra', s: 'IESE Business School', d: ['Operations, Information and Technology'] },
    { u: 'University of Nebraska–Lincoln', s: 'College of Business', d: ['Supply Chain Management & Analytics'] },
    { u: 'University of New South Wales', s: 'Business School', d: ['Information Systems and Technology Management'] },
    { u: 'University of North Carolina at Chapel Hill', s: 'Kenan-Flagler Business School', d: ['Operations'] },
    { u: 'University of North Texas', s: 'G. Brint Ryan College of Business', d: ['Supply Chain Management'] },
    { u: 'University of Notre Dame', s: 'Mendoza College of Business', d: ['Information Technology, Analytics and Operations'] },
    { u: 'University of Oklahoma', s: 'Price College of Business', d: ['Marketing and Supply Chain Management'] },
    { u: 'University of Oregon', s: 'Lundquist College of Business', d: ['Operations and Business Analytics'] },
    { u: 'University of Oxford', s: 'Saïd Business School', d: ['Technology and Operations Management'] },
    { u: 'University of Pennsylvania', s: 'The Wharton School', d: ['Operations, Information and Decisions'] },
    { u: 'University of Pittsburgh', s: 'The Joseph M. Katz Graduate School of Business', d: ['Business Analytics & Operations'] },
    { u: 'University of Rochester', s: 'Simon Business School', d: ['Operations Management'] },
    { u: 'University of Science and Technology of China', s: 'School of Management', d: ['Management Science'] },
    { u: 'University of South Carolina', s: 'Darla Moore School of Business', d: ['Management Science'] },
    { u: 'University of Southern California', s: 'Marshall School of Business (incl. Leventhal)', d: ['Data Sciences and Operations (DSO)'] },
    { u: 'University of Tennessee at Knoxville', s: 'Haslam College of Business', d: ['Supply Chain', 'Business Analytics'] },
    { u: 'University of Toronto', s: 'Joseph L. Rotman School of Management', d: ['Operations Management and Statistics'] },
    { u: 'University of Utah', s: 'David Eccles School of Business', d: ['Department of Operations & Information Systems'] },
    { u: 'University of Virginia', s: 'Darden School of Business', d: ['Technology and Operations Management', 'Data Analytics and Decision Sciences'] },
    { u: 'University of Warwick', s: 'Warwick Business School', d: ['Operations Management'] },
    { u: 'University of Washington', s: 'Michael G. Foster School of Business', d: ['Information Systems and Operations Management'] },
    { u: 'University of Wisconsin–Madison', s: 'Wisconsin School of Business', d: ['Operations and Information Management'] },
    { u: 'University of Zurich', s: 'Department of Business Administration', d: ['Business Analytics & Operations'] },
    { u: 'UT San Antonio', s: 'Carlos Alvarez College of Business', d: ['Operations and Analytics Department'] },
    { u: 'Vanderbilt University', s: 'Owen Graduate School of Management', d: ['Operations Management & Quantitative Methods'] },
    { u: 'Villanova University', s: 'Villanova School of Business', d: ['Management & Operations'] },
    { u: 'VinUniversity', s: 'College of Business and Management', d: ['Supply Chain'] },
    { u: 'Virginia Commonwealth University', s: 'School of Business', d: ['Supply Chain Management and Analytics'] },
    { u: 'Virginia Tech', s: 'Pamplin College of Business', d: ['Business Information Technology'] },
    { u: 'Wake Forest University', s: 'School of Business', d: ['Operations', 'Analytics'] },
    { u: 'Washington University in St. Louis', s: 'Olin School of Business', d: ['Supply Chain, Operations and Technology'] },
    { u: 'West Virginia University', s: 'John Chambers College of Business and Economics', d: ['Supply Chain Management'] },
    { u: 'Western University', s: 'Ivey Business School', d: ['Operations Management'] },
    { u: 'WHU – Otto Beisheim School of Management', s: 'Otto-Beisheim School of Management', d: ['Supply Chain Management'] },
    { u: 'Yale University', s: 'School of Management', d: ['Operations'] },
    { u: 'York University', s: 'Schulich School of Business', d: ['Operations Management and Information Systems'] }
  ];

  /* ------------------------------------------------------------------ folding */

  /** Case-, accent- and punctuation-insensitive identity. Matches vocabKey in
      _scraper/vocab.mjs, so the two sides agree about what one name is. */
  function fold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Collapse whitespace and strip stray leading/trailing separators. */
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
      .trim();
  }

  /* ------------------------------------------------------- the derived lists */

  function sorted(values) {
    var seen = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = clean(values[i]);
      if (!v) continue;
      var k = fold(v);
      if (!k || seen[k]) continue;
      seen[k] = true;
      out.push(v);
    }
    return out.sort(function (a, b) {
      return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
    });
  }

  /**
   * The seed as DIRECTORY ROWS — `{ institution, school, department }`, one per
   * department — which is the shape `buildVocab`'s `directory` argument reads
   * (the same shape data/universities.json rows have).
   *
   * ONE definition, because two would drift: _scraper/build-jobs.mjs feeds the
   * vocabulary with it and the selftest rebuilds vocab.json with it, so the
   * served file and the test can never disagree about what the seed contributes.
   */
  function directoryRows() {
    var out = [];
    for (var i = 0; i < LIST.length; i++) {
      var r = LIST[i];
      var institution = clean(r.u);
      if (!institution) continue;
      var school = clean(r.s);
      var units = [];
      for (var j = 0; j < (r.d || []).length; j++) {
        var d = clean(r.d[j]);
        if (d) units.push(d);
      }
      if (!units.length) { out.push({ institution: institution, school: school, department: '' }); continue; }
      for (var k = 0; k < units.length; k++) {
        out.push({ institution: institution, school: school, department: units[k] });
      }
    }
    return out;
  }

  /** Every university in the seed, A–Z. */
  function universities() {
    return sorted(LIST.map(function (r) { return r.u; }));
  }

  /** Every school, faculty or college in the seed, A–Z. */
  function schools() {
    return sorted(LIST.map(function (r) { return r.s; }));
  }

  /** Every department, area or group in the seed, A–Z. */
  function departments() {
    var all = [];
    for (var i = 0; i < LIST.length; i++) {
      var d = LIST[i].d || [];
      for (var j = 0; j < d.length; j++) all.push(d[j]);
    }
    return sorted(all);
  }

  /**
   * What this university offers: its schools, every department across them,
   * and — the part that matters — the departments OF EACH SCHOOL separately,
   * so a business-school poster is not offered an engineering department.
   *
   * `{ schools: [...], units: [...], bySchool: { '<school>': [...] } }`
   *
   * Accepts any spelling canon() resolves; an unknown university returns the
   * empty shape rather than nothing, so a caller never has to null-check.
   */
  function forUniversity(name) {
    var want = fold(name);        // the caller canonicalises; this file only folds
    var out = { schools: [], units: [], bySchool: {} };
    if (!want) return out;

    var schoolNames = [];
    var unitNames = [];
    for (var i = 0; i < LIST.length; i++) {
      var r = LIST[i];
      if (fold(r.u) !== want) continue;
      var d = (r.d || []).slice();
      if (r.s) {
        schoolNames.push(r.s);
        out.bySchool[r.s] = sorted((out.bySchool[r.s] || []).concat(d));
      }
      unitNames = unitNames.concat(d);
    }
    out.schools = sorted(schoolNames);
    out.units = sorted(unitNames);
    return out;
  }

  return {
    LIST: LIST,
    directoryRows: directoryRows,
    fold: fold,
    universities: universities,
    schools: schools,
    departments: departments,
    forUniversity: forUniversity,
  };
}));
