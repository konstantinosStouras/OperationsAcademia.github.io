/* ---------------------------------------------------------------------------
   Operations Academia — a member's affiliation, chosen from the site's own
   list of universities.

   Owner, 2026-10-01: "When users register and need to provide us and write
   down their affiliation, show them a list of universities as a drop down
   menu for them to choose from, and also allow 'Add Other' for them to add
   anything not listed", and then "the list of universities should come from
   our list so far: /universities … any new universities added should be
   added to our list of universities, and job posting drop down university
   name too. Then, we should try to update affiliations of registered users
   that match any of the already existing universities so that they match
   with the exact university name we refer to each university."

   ONE FILE, BOTH SIDES (the oa-schools.js shape):

     the browser   assets/oa-accounts.js loads it on demand, when the
                   registration card or the profile card draws its
                   Affiliation box, and mounts the picker on that box
     the build     _scraper/build-directory.mjs writes the list it reads
                   (listFromDirectory -> data/university-names.json)
     the members   _scraper/affiliations.mjs standardises the affiliations
                   members have already given (settle) and collects the
                   universities nobody else lists (newUniversity)

   So the box a person fills in and the pass that tidies what they typed agree
   about what "the same university" means, by construction.

   THE LIST IS THE UNIVERSITIES PAGE'S OWN CARDS. One name per card, the
   card's own title (OASchools.cardName, the rule universities.html titles a
   card by), so the name a member chooses is the name the page shows.

   CURATED, NEVER GUESSED. Free text becomes a listed university only where it
   names one outright: the same university however it is spelled
   (institutionKey, aliases included), one part of a longer line that names
   exactly ONE listed university ("Rotman School of Management, University of
   Toronto"), the acronym a card itself carries in brackets, or a school with a
   name of its own that the directory lists at exactly one university
   ("Kellogg School of Management"). Two universities in one line, or nothing
   but a prefix ("Stanford"), changes nothing: "Penn" would otherwise become
   Penn State, which is the wrong school. A company is never a university.

   ENTIRELY OPTIONAL. Without OACombo the box is the plain text box it always
   was; without the list it is the same box; nothing here may ever be the
   reason a person cannot register.
   --------------------------------------------------------------------------- */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () { return require('./oa-schools.js'); });
  } else {
    root.OAAffiliation = factory(function () { return root.OASchools || null; });
  }
}(typeof self !== 'undefined' ? self : this, function (schools) {
  'use strict';

  /* Where the build writes the list. Relative like every asset URL the live
     site's scripts build: all live pages sit at the root. */
  var URL = 'data/university-names.json';
  var MAX = 160;   // the box's own maxlength

  function S() { return schools(); }

  function fold(v) {
    var s = S();
    return s ? s.fold(v) : String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** What was typed, tidied: one space between words, trimmed, bounded. */
  function tidy(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX);
  }

  function uniKey(v) {
    var s = S();
    return s ? s.institutionKey(String(v || '')) : fold(v);
  }

  /* ------------------------------------------------- which schools may vouch

     A school stands for its university only when its name carries a word of
     its own: "Kellogg", "Rotman", "Tuck", "Cardiff". A school named for its
     SUBJECT is somewhere at a hundred universities, and the directory listing
     it at one of them says nothing about the next person who types it:
     "School of Mathematical and Statistical Sciences" is at Clemson AND at
     Arizona State, and only one of them is in the directory. So the words that
     name a subject (or a kind of unit) never count, and a school whose name is
     nothing else vouches for nobody. */
  var SUBJECT_WORDS = [
    'management', 'engineering', 'science', 'sciences', 'economics', 'economic',
    'information', 'systems', 'policy', 'public', 'applied', 'computing',
    'computer', 'mathematical', 'mathematics', 'statistical', 'statistics',
    'leadership', 'behavioral', 'behavioural', 'operations', 'operational',
    'research', 'technology', 'technologies', 'tech', 'decision', 'decisions',
    'analytics', 'supply', 'chain', 'social', 'foundation', 'international',
    'global', 'professional', 'continuing', 'education', 'commerce', 'finance',
    'financial', 'accounting', 'accountancy', 'marketing', 'law', 'medicine',
    'health', 'arts', 'art', 'letters', 'humanities', 'design', 'data',
    'industrial', 'enterprise', 'entrepreneurship', 'innovation', 'executive',
    'banking', 'hospitality', 'tourism', 'sustainability', 'environment',
    'environmental', 'agriculture', 'communication', 'media', 'political',
    'government', 'logistics', 'maritime', 'shipping', 'transportation',
    'quantitative', 'methods', 'sport', 'hotel', 'retail', 'real', 'estate',
    'insurance', 'human', 'resources', 'organizational', 'organisational',
    'strategy', 'strategic', 'economy', 'trade', 'service', 'services',
    'mba', 'administrative', 'center', 'centre', 'campus', 'new', 'advanced', 'studies',
    'interdisciplinary', 'natural', 'physical', 'life', 'liberal', 'general',
    'continuing', 'extension', 'online', 'distance', 'graduate', 'undergraduate',
    'university', 'universities'
  ];

  function strongSchool(name) {
    var s = S();
    if (!s) return false;
    /* a bracketed acronym is the school's initials, not a word of its own:
       "Faculty of Economics and Business (FEB)" is at a dozen universities */
    var bare = String(name || '').replace(/\s*\([^)]*\)\s*$/, '');
    var words = s.distinctiveWords(bare, '');
    for (var i = 0; i < words.length; i++) {
      if (words[i].length >= 3 && SUBJECT_WORDS.indexOf(words[i]) === -1) return true;
    }
    return false;
  }

  /* ----------------------------------------------------- the short forms

     What members type for a university that the site's own data does not
     spell, each to the full name the site lists. CURATED: an entry is a
     decision, made once, for a short form nobody could mean otherwise, never
     derived ("Penn" is not here: it is two universities). ONE table for the
     three things that read it: this matcher, the picker built on it, and the
     anonymous member counts (_scraper/members-insights.mjs re-exports it).
     Keyed by the folded short form. */
  var SHORT_FORMS = {
  'mit': 'Massachusetts Institute of Technology',
  'mit sloan': 'Massachusetts Institute of Technology',
  'nyu': 'New York University',
  'nyu stern': 'New York University',
  'cmu': 'Carnegie Mellon University',
  'carnegie mellon': 'Carnegie Mellon University',
  'nus': 'National University of Singapore',
  'ucl': 'University College London',
  'lbs': 'London Business School',
  'georgia tech': 'Georgia Institute of Technology',
  'gatech': 'Georgia Institute of Technology',
  'ut austin': 'University of Texas at Austin',
  'ut dallas': 'University of Texas at Dallas',
  'utd': 'University of Texas at Dallas',
  'upenn': 'University of Pennsylvania',
  'wharton': 'University of Pennsylvania',
  'the wharton school': 'University of Pennsylvania',
  'uiuc': 'University of Illinois at Urbana-Champaign',
  'hbs': 'Harvard University',
  'harvard business school': 'Harvard University',
  'stanford gsb': 'Stanford University',
  'umich': 'University of Michigan',
  'uchicago': 'University of Chicago',
  'chicago booth': 'University of Chicago',
  'kellogg': 'Northwestern University',
  'northwestern': 'Northwestern University',
  'duke': 'Duke University',
  'fuqua': 'Duke University',
  'columbia': 'Columbia University',
  'cornell': 'Cornell University',
  'stanford': 'Stanford University',
  'harvard': 'Harvard University',
  'princeton': 'Princeton University',
  'yale': 'Yale University',
  'yale som': 'Yale University',
  'yale school of management': 'Yale University',
  'bocconi': 'Bocconi University',
  'unc': 'University of North Carolina at Chapel Hill',
  'usc': 'University of Southern California',
  'polyu': 'Hong Kong Polytechnic University',
  };

  function shortForm(v) {
    var k = fold(v);
    return Object.prototype.hasOwnProperty.call(SHORT_FORMS, k) ? SHORT_FORMS[k] : '';
  }

  function schoolKey(name) {
    var s = S();
    return s ? s.fold(s.canonSchool(String(name || ''))) : fold(name);
  }

  /* --------------------------------------------- the list, from the build

     data/university-names.json, written by build-directory.mjs from the
     directory it has just built:

       universities   every card's title, A-Z
       fromMembers    the cards that exist ONLY because a member named the
                      place (the 'members' source); the affiliation pass
                      needs them apart, or a card made from a member's word
                      would read as "already listed" and could never leave
       schools        [school, card] pairs: a school with a name of its own
                      that the directory lists at exactly one university */
  function listFromDirectory(rows, opts) {
    opts = opts || {};
    var s = S();
    var groups = Object.create(null);
    var order = [];
    var bySchool = Object.create(null);
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i] || {};
      var k = uniKey(r.institution);
      if (!k) continue;
      if (!groups[k]) { groups[k] = { names: [], sources: Object.create(null) }; order.push(k); }
      groups[k].names.push(String(r.institution));
      var src = r.sources || [];
      for (var j = 0; j < src.length; j++) groups[k].sources[src[j]] = true;
      if (r.school) {
        var sk = schoolKey(r.school);
        if (!sk) continue;
        if (!bySchool[sk]) bySchool[sk] = { name: String(r.school), unis: Object.create(null) };
        bySchool[sk].unis[k] = true;
      }
    }
    var title = Object.create(null);
    for (var o = 0; o < order.length; o++) {
      var g0 = groups[order[o]];
      title[order[o]] = s && s.cardName ? s.cardName(g0.names) : g0.names[0];
    }
    /* ONE UNIVERSITY, ONE ENTRY. The directory carries some universities a
       second time, as a card titled with the name a posting was made under
       ("Stanford GSB", "Cornell University/ Cornell Tech"). The caller says
       which card such a name belongs under (`parentKey`, the anonymous member
       counts' own rule, _scraper/members-insights.mjs findParent), and that
       card is offered in its place: its title becomes an ALIAS that settles
       to the parent, so somebody who typed it is standardised to the
       university rather than to a posting's spelling of it. */
    var parentOf = Object.create(null);
    if (typeof opts.parentKey === 'function') {
      for (var o2 = 0; o2 < order.length; o2++) {
        var pk = '';
        try { pk = opts.parentKey(title[order[o2]]) || ''; } catch (e) { pk = ''; }
        if (pk && pk !== order[o2] && title[pk]) parentOf[order[o2]] = pk;
      }
    }
    var universities = [];
    var fromMembers = [];
    var aliases = [];
    for (var o3 = 0; o3 < order.length; o3++) {
      var k3 = order[o3];
      var g = groups[k3];
      if (parentOf[k3]) { aliases.push([title[k3], title[parentOf[k3]]]); continue; }
      universities.push(title[k3]);
      var only = Object.keys(g.sources);
      if (only.length === 1 && only[0] === 'members') fromMembers.push(title[k3]);
    }
    var pairs = [];
    for (var sk2 in bySchool) {
      var e = bySchool[sk2];
      var unis = Object.keys(e.unis);
      if (unis.length !== 1) continue;                  // two universities: ambiguity
      /* a school that is ALSO a card of its own ("London Business School" is
         filed under the University of London and has a card) is that card:
         the name answers before any school could */
      if (title[uniKey(e.name)] || !strongSchool(e.name)) continue;
      var home = parentOf[unis[0]] ? title[parentOf[unis[0]]] : title[unis[0]];
      pairs.push([e.name, home]);
    }
    var az = function (a, b) {
      return fold(a).localeCompare(fold(b)) || String(a).localeCompare(String(b));
    };
    universities.sort(az);
    fromMembers.sort(az);
    pairs.sort(function (a, b) { return az(a[0], b[0]) || az(a[1], b[1]); });
    aliases.sort(function (a, b) { return az(a[0], b[0]) || az(a[1], b[1]); });
    return { universities: universities, fromMembers: fromMembers, schools: pairs, aliases: aliases };
  }

  /** The list, made ready to match against. */
  function index(list) {
    list = list || {};
    var idx = {
      names: [],
      byKey: Object.create(null),
      byAcronym: Object.create(null),
      bySchool: Object.create(null),
      members: Object.create(null),
    };
    var names = list.universities || [];
    var acr = Object.create(null);
    var twice = Object.create(null);
    for (var i = 0; i < names.length; i++) {
      var n = tidy(names[i]);
      if (!n) continue;
      var k = uniKey(n);
      if (!k || idx.byKey[k]) continue;
      idx.byKey[k] = n;
      idx.names.push(n);
      /* the acronym a card carries in its own brackets, "London Business
         School (LBS)". Two cards claiming one acronym is ambiguity, dropped */
      var m = /\(([A-Z][A-Za-z&]{1,9})\)\s*$/.exec(n);
      if (m) {
        var a = m[1].toUpperCase();
        if (acr[a]) twice[a] = true;
        acr[a] = n;
      }
    }
    for (var a2 in acr) if (!twice[a2]) idx.byAcronym[a2] = acr[a2];
    var schoolsList = list.schools || [];
    for (var j = 0; j < schoolsList.length; j++) {
      var pair = schoolsList[j] || [];
      var uk = uniKey(pair[1]);
      if (!idx.byKey[uk]) continue;                     // a pair naming no card
      var sk = schoolKey(pair[0]);
      if (sk) idx.bySchool[sk] = idx.byKey[uk];
    }
    /* a folded card's own title settles to the university it belongs under */
    var al = list.aliases || [];
    for (var x = 0; x < al.length; x++) {
      var pair2 = al[x] || [];
      var ck = uniKey(pair2[0]);
      var to = idx.byKey[uniKey(pair2[1])];
      if (ck && to && !idx.byKey[ck]) idx.byKey[ck] = to;
    }
    var mem = list.fromMembers || [];
    for (var q = 0; q < mem.length; q++) idx.members[uniKey(mem[q])] = true;
    return idx;
  }

  /* One part of a line, tried on its own: the university itself, the acronym
     a card carries, or a school that vouches for one. */
  function matchOne(part, idx) {
    var p = tidy(part);
    if (!p) return null;
    var hit = idx.byKey[uniKey(p)];
    if (hit) return { name: hit, how: 'name' };
    var sf = shortForm(p);
    if (sf && idx.byKey[uniKey(sf)]) return { name: idx.byKey[uniKey(sf)], how: 'short' };
    if (/^[A-Z][A-Z&]{1,9}$/.test(p) && idx.byAcronym[p]) return { name: idx.byAcronym[p], how: 'acronym' };
    var school = idx.bySchool[schoolKey(p)];
    if (school) return { name: school, how: 'school' };
    return null;
  }

  /* A line names its university in pieces: "Operations, Rotman School of
     Management, University of Toronto". Commas (and semicolons, bars) are the
     strong breaks, and a university's own name can carry one ("University of
     California, Berkeley"), so CONTIGUOUS runs of pieces are tried, longest
     first. Inside a piece, a dash, a slash, brackets and " at " are the weak
     breaks ("PhD student at Columbia University"). */
  var STRONG = /\s*[,;|]\s*/;
  var WEAK = /\s+[-–—]\s+|\s*\/\s*|\s*[()]\s*|\s+at\s+/i;

  function runs(pieces, try_) {
    var hits = [];
    var used = [];
    for (var size = pieces.length; size >= 1; size--) {
      for (var at = 0; at + size <= pieces.length; at++) {
        var free = true;
        for (var u = at; u < at + size; u++) if (used[u]) { free = false; break; }
        if (!free) continue;
        var m = try_(pieces.slice(at, at + size).join(', '));
        if (!m) continue;
        hits.push(m);
        for (var u2 = at; u2 < at + size; u2++) used[u2] = true;
      }
    }
    return { hits: hits, used: used };
  }

  /**
   * The listed university a line of free text names, or null.
   *
   *   { name, how }   how: 'exact' | 'name' | 'acronym' | 'school' | 'part'
   *
   * One university or none: a line that names two different listed
   * universities ("PhD, Stanford University; visiting MIT") answers null,
   * because which of them is the affiliation is a person's call.
   */
  function match(text, idx) {
    if (!idx) return null;
    var t = tidy(text);
    if (!t) return null;
    var whole = matchOne(t, idx);
    if (whole) return { name: whole.name, how: whole.name === t ? 'exact' : whole.how };

    var pieces = t.split(STRONG).filter(Boolean);
    var found = [];
    /* A piece left over that still names A university, one the list does not
       carry ("visiting University of Foo"), is a second university in the
       line, so the line is a person's call, not this function's. */
    var stray = false;
    var strong = runs(pieces, function (s) { return matchOne(s, idx); });
    found = found.concat(strong.hits);
    for (var i = 0; i < pieces.length; i++) {
      if (strong.used[i]) continue;
      var bits = pieces[i].split(WEAK).filter(function (b) { return b && b.trim(); });
      if (bits.length < 2) { if (UNIVERSITY.test(pieces[i])) stray = true; continue; }
      var weak = runs(bits, function (s) { return matchOne(s, idx); });
      found = found.concat(weak.hits);
      for (var b = 0; b < bits.length; b++) {
        if (!weak.used[b] && UNIVERSITY.test(bits[b])) stray = true;
      }
    }
    /* A university NAMED in the line outranks one a school vouches for: the
       directory's own filing of a school can be wrong, the person's own words
       are what they meant. Two universities named, or none named and two
       vouched for, is a person's call, never this function's. */
    if (stray) return null;
    var named = found.filter(function (f) { return f.how !== 'school'; });
    var pool = named.length ? named : found;
    var distinct = [];
    for (var j = 0; j < pool.length; j++) {
      if (distinct.indexOf(pool[j].name) === -1) distinct.push(pool[j].name);
    }
    return distinct.length === 1 ? { name: distinct[0], how: 'part' } : null;
  }

  /** What the box should hold: the listed university the text names, or the
      text itself, tidied. Never anything else. */
  function settle(text, idx) {
    var m = match(text, idx);
    return m ? m.name : tidy(text);
  }

  /* ------------------------------------- a university the list does not have

     The words that make a name a UNIVERSITY's and nothing else: a school, a
     company, a lab and a department are not on this list, and nor is
     "College", which is half the schools of every university. A line is added
     only when its university is evident: exactly ONE of its comma-separated
     pieces looks like a university, that piece says nothing about a person or
     a unit ("PhD student at", "Department of", "School of"), and it is not a
     school the directory already lists somewhere (a school of a listed
     university is not a new university). Anything less certain is left out:
     a university missing from the list costs the maintainer one row, a
     sentence published as a university costs a card on a public page. */
  var UNIVERSITY = /universit|\bhochschule\b|\bpolytechnic\b|\bpolitecnico\b|\binstitute of technology\b|\buniversidad|\buniversidade|\buniversiteit|\u00e9cole polytechnique/i;
  var NOT_A_NAME = /\b(ph\.?\s?d|doctoral|students?|candidates?|post-?docs?|postdoctoral|professors?|lecturers?|fellows?|researchers?|visiting|alumn\w*|department|dept|faculty of|school of|college of|laborator\w*|lab|group|centre|center|institute for)\b/i;

  function looksLikeUniversity(v) {
    var t = tidy(v);
    if (t.length < 4 || t.length > 120) return false;
    if (/@|https?:|www\./i.test(t)) return false;
    return UNIVERSITY.test(t) && !NOT_A_NAME.test(t);
  }

  /* A NAME, NOT A PLACEHOLDER. The first plan run of the daily pass
     (2026-10-01) would have published "university of john doe" as a card on
     the Universities page: a test account's affiliation, which passed every
     rule above. Two more, both about the name as written and neither a guess
     about a place:
       - a placeholder is never a university (somebody testing the form, or
         declining to say);
       - a name is written as one: every word but a connective ("of", "de",
         "für"...) begins with a capital, as every university's own name does.
         A line typed all in lower case is not published as somebody's
         university; its member keeps what they typed, and the maintainer can
         still add the place by hand. */
  var PLACEHOLDER = /\b(?:john|jane)\s+doe\b|\btest(?:ing)?\b|\bexample\b|\bsample\b|\bdummy\b|\bfake\b|\bplaceholder\b|\basdf\w*|\bqwerty\b|\blorem\b|\bipsum\b|\bx{3,}\b|\bunknown\b|\bnone\b|\bn\/a\b|\bmy university\b|\bsome university\b|\bany university\b/i;
  var CONNECTIVES = {
    a: 1, 'à': 1, al: 1, am: 1, an: 1, and: 1, at: 1, au: 1, aux: 1, auf: 1,
    d: 1, da: 1, das: 1, de: 1, degli: 1, dei: 1, del: 1, dell: 1, della: 1,
    delle: 1, dello: 1, den: 1, der: 1, des: 1, di: 1, do: 1, dos: 1, du: 1,
    e: 1, el: 1, en: 1, et: 1, 'för': 1, for: 1, 'für': 1, fur: 1, het: 1,
    i: 1, im: 1, in: 1, l: 1, la: 1, las: 1, le: 1, les: 1, los: 1, och: 1,
    of: 1, og: 1, on: 1, 'över': 1, the: 1, to: 1, und: 1, upon: 1, van: 1,
    voor: 1, von: 1, y: 1, zu: 1, zum: 1, zur: 1
  };
  function writtenAsName(v) {
    var words = tidy(v).split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    for (var i = 0; i < words.length; i++) {
      /* the word as letters: an opening bracket or quote is not the word, and
         an elided article ("d'Aix", "l'Aquila") is judged by what follows */
      var w = words[i].replace(/^[("'\u2018\u201c\[]+/, '');
      var lead = /^([dl])['\u2019](.+)$/i.exec(w);
      if (lead) w = lead[2];
      var c = w.charAt(0);
      if (!c || c.toLowerCase() === c.toUpperCase()) continue;   // a digit, a dash
      if (c === c.toUpperCase()) continue;                       // a capital
      if (i > 0 && CONNECTIVES[w.toLowerCase().replace(/['\u2019.,;:)]+$/, '')]) continue;
      return false;
    }
    return true;
  }

  /**
   * The name a university the list does not carry should be listed under,
   * or '' when the line names none, names a listed one, or names several.
   */
  function newUniversity(text, idx) {
    var t = tidy(text);
    if (!t || match(t, idx)) return '';
    var s = S();
    var cands = t.split(STRONG).filter(Boolean).filter(looksLikeUniversity);
    if (cands.length !== 1) return '';
    var name = tidy(s ? s.canonInstitution(cands[0]) : cands[0]);
    if (!name || !looksLikeUniversity(name)) return '';
    if (PLACEHOLDER.test(t) || !writtenAsName(name)) return '';
    if (idx && (idx.byKey[uniKey(name)] || idx.bySchool[schoolKey(name)])) return '';
    /* nor a slight respelling of a card already there: "Hebrew University"
       beside "The Hebrew University of Jerusalem" is the same place, and a
       second card would split it, and nor is "Stanford Universit". The
       FUZZY tier of the site's own judgement (oa-schools.js similarNames, the
       picker's "did you mean"), deliberately the eager one: here a false
       alarm costs one university the maintainer adds by hand, and a miss
       costs a duplicate card on a public page. */
    if (idx && s && s.similarNames) {
      for (var i = 0; i < idx.names.length; i++) {
        if (s.similarNames(name, idx.names[i], { fuzzy: true })) return '';
      }
    }
    return name;
  }

  /* ------------------------------------------------------- the browser half */

  var pending = null;
  var loaded = null;   // the index, once the list has arrived

  /** The list, fetched once per page. A failed read is not remembered, so one
      flaky request is not inherited by the next card that asks. no-cache
      REVALIDATES rather than re-downloads, the site-wide rule for data/. */
  function load(url) {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) {
      pending = fetch(url || URL, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { loaded = index(j); return loaded; })
        .catch(function () { pending = null; return null; });
    }
    return pending;
  }

  /** settle() over the list this page has loaded, or the text tidied when it
      has not arrived: a submit that races the fetch goes as typed, and the
      affiliation pass settles it later on the same terms. */
  function settleLoaded(text) {
    return loaded ? settle(text, loaded) : tidy(text);
  }

  var WORDS = {
    hint: 'Choose your university from the list, or type to search it. ' +
          'Not on the list? Type the name and choose “Add other”.',
    lead: 'Your university',
    near: 'On our list already. Is one of these yours?',
    empty: 'Nothing on our list matches. Type the full name to add it.',
    label: 'Universities',
  };

  function addLabel(v) { return 'Add other: “' + v + '”'; }

  /**
   * Put the picker on one Affiliation box.
   *
   *   opts.load(src, globalName) -> Promise   the page's own script loader
   *                                            (oa-accounts.js passes its own)
   *
   * Answers a Promise of the OACombo handle, or null when the picker could
   * not be had. The caller keeps the handle to destroy() it with the card.
   */
  function mount(input, opts) {
    opts = opts || {};
    if (!input || typeof document === 'undefined') return Promise.resolve(null);
    var need = opts.load
      ? opts.load('assets/oa-combo.js', 'OACombo')
      : (window.OACombo ? Promise.resolve() : Promise.reject(new Error('no OACombo')));
    return Promise.all([need, load(opts.url)]).then(function (got) {
      var idx = got[1];
      if (!idx || !window.OACombo || !input.isConnected || input.__oaCombo) return null;
      var s = S();
      var combo = window.OACombo.attach(input, {
        options: idx.names,
        /* the same university however it is written, so a line that names a
           listed university is never offered as "other" */
        key: function (v) {
          var m = match(v, idx);
          return m ? uniKey(m.name) : 'other ' + fold(v);
        },
        lead: function (typed) {
          var m = match(typed, idx);
          return m ? [m.name] : [];
        },
        /* "is one of these yours?" names only what the list above does not
           already show: a name the plain search has listed is a row away,
           and offering it twice reads as two universities */
        similar: function (typed) {
          if (!s || !s.findSimilar) return [];
          return s.findSimilar(typed, idx.names, { max: 6 }).filter(function (n) {
            return !window.OACombo.score(n, typed);
          }).slice(0, 3);
        },
        publishAs: tidy,
        addLabel: addLabel,
        hint: WORDS.hint,
        leadLabel: WORDS.lead,
        nearNote: WORDS.near,
        emptyNote: WORDS.empty,
        listLabel: WORDS.label,
        /* the cards put the keyboard in this box themselves; a list drawn on
           that focus covered the card's own buttons */
        openOnFocus: false,
      });
      if (!combo) return null;
      /* Leaving the box settles it: what was typed becomes the listed name it
         names, in front of the person, so what they read is what is stored. */
      input.addEventListener('change', function () {
        var v = settle(input.value, idx);
        if (v && v !== input.value) input.value = v;
      });
      return combo;
    }).catch(function () { return null; });
  }

  return {
    URL: URL,
    SHORT_FORMS: SHORT_FORMS,
    SUBJECT_WORDS: SUBJECT_WORDS,
    WORDS: WORDS,
    addLabel: addLabel,
    tidy: tidy,
    strongSchool: strongSchool,
    listFromDirectory: listFromDirectory,
    index: index,
    match: match,
    settle: settle,
    looksLikeUniversity: looksLikeUniversity,
    newUniversity: newUniversity,
    writtenAsName: writtenAsName,
    load: load,
    settleLoaded: settleLoaded,
    mount: mount,
  };
}));
